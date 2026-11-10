using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using Zilux2.Online;

namespace Zilux2.Audio.VirtualMic;

/// <summary>
/// 自研虚拟麦克风驱动的用户态写端（Phase 2 预留）。
///
/// 驱动控制设备由 Zilux2VirtualAudio.sys 提供；当前 Phase 0 只实现了控制
/// IOCTL，尚未映射/播放 PCM，因此这个类在驱动完善前只用于握手和诊断。
/// </summary>
internal sealed class VirtualMicDevice : IDisposable
{
    private const uint AbiVersion = 1;
    private const uint HeaderBytes = 128;
    private const uint DefaultRingBytes = 192_000; // 1s @ 48k stereo 16-bit
    private const uint SampleRate = 48_000;
    private const ushort Channels = 2;
    private const ushort BitsPerSample = 16;
    private const uint FramesPerPacket = 480;

    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint OpenExisting = 3;
    private const uint FileShareRead = 1;
    private const uint FileShareWrite = 2;
    private const uint PageReadWrite = 0x04;
    private const uint FileMapWrite = 0x0002;

    private const uint DeviceType = 0x8A31;
    private const uint IoctlGetVersion = (DeviceType << 16) | (0 << 14) | (0x800 << 2) | 0;
    private const uint IoctlRegisterRing = (DeviceType << 16) | (0 << 14) | (0x801 << 2) | 0;
    private const uint IoctlStart = (DeviceType << 16) | (0 << 14) | (0x802 << 2) | 0;
    private const uint IoctlStop = (DeviceType << 16) | (0 << 14) | (0x803 << 2) | 0;

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct VersionInfo
    {
        public uint AbiVersion;
        public uint DriverVersion;
        public uint RingBytesMax;
        public uint SampleRate;
        public ushort Channels;
        public ushort BitsPerSample;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    private struct RegisterRing
    {
        public uint Version;
        public uint RingBytes;
        public uint SampleRate;
        public ushort Channels;
        public ushort BitsPerSample;
        public uint FramesPerPacket;
        public uint Reserved;
        public ulong SectionHandle;
    }

    private readonly object _gate = new();
    private SafeFileHandle? _device;
    private IntPtr _section;
    private IntPtr _view;
    private uint _ringBytes;
    private uint _writeFrame;
    private bool _running;

    public bool IsRunning => _running;

    public string? LastError { get; private set; }

    public bool TryOpen()
    {
        if (_device is { IsInvalid: false })
        {
            return true;
        }

        var handle = CreateFile(
            @"\\.\Zilux2VirtualAudio",
            GenericRead | GenericWrite,
            FileShareRead | FileShareWrite,
            IntPtr.Zero,
            OpenExisting,
            0,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            LastError = $"Zilux2VirtualAudio 不可用 (win32={Marshal.GetLastWin32Error()})";
            handle.Dispose();
            return false;
        }

        _device = handle;
        return true;
    }

    internal bool TryReadVersion(out VersionInfo version)
    {
        version = default;
        if (_device is null || !TryOpen())
        {
            return false;
        }

        var input = Marshal.AllocHGlobal(Marshal.SizeOf<VersionInfo>());
        var output = Marshal.AllocHGlobal(Marshal.SizeOf<VersionInfo>());
        try
        {
            var request = new VersionInfo();
            Marshal.StructureToPtr(request, input, false);
            if (!DeviceIoControl(_device, IoctlGetVersion, input, Marshal.SizeOf<VersionInfo>(),
                    output, Marshal.SizeOf<VersionInfo>(), out _, IntPtr.Zero))
            {
                LastError = $"GET_VERSION 失败 (win32={Marshal.GetLastWin32Error()})";
                return false;
            }

            version = Marshal.PtrToStructure<VersionInfo>(output);
            if (version.AbiVersion != AbiVersion)
            {
                LastError = $"驱动 ABI={version.AbiVersion}，应用需要 {AbiVersion}";
                return false;
            }

            return true;
        }
        finally
        {
            Marshal.FreeHGlobal(input);
            Marshal.FreeHGlobal(output);
        }
    }

    public bool Start(uint ringBytes = DefaultRingBytes)
    {
        lock (_gate)
        {
            if (_running) return true;
            if (!TryOpen()) return false;
            if (ringBytes < 4096 || ringBytes > 4 * 1024 * 1024) ringBytes = DefaultRingBytes;

            var totalBytes = checked((int)(HeaderBytes + ringBytes));
            _section = CreateFileMapping(new IntPtr(-1), IntPtr.Zero, PageReadWrite, 0, (uint)totalBytes, null);
            if (_section == IntPtr.Zero)
            {
                LastError = $"CreateFileMapping 失败 (win32={Marshal.GetLastWin32Error()})";
                return false;
            }

            _view = MapViewOfFile(_section, FileMapWrite, 0, 0, (UIntPtr)totalBytes);
            if (_view == IntPtr.Zero)
            {
                LastError = $"MapViewOfFile 失败 (win32={Marshal.GetLastWin32Error()})";
                CloseHandle(_section);
                _section = IntPtr.Zero;
                return false;
            }

            WriteHeader(ringBytes);

            var register = new RegisterRing
            {
                Version = AbiVersion,
                RingBytes = ringBytes,
                SampleRate = SampleRate,
                Channels = Channels,
                BitsPerSample = BitsPerSample,
                FramesPerPacket = FramesPerPacket,
                SectionHandle = (ulong)_section.ToInt64(),
            };
            var input = Marshal.AllocHGlobal(Marshal.SizeOf<RegisterRing>());
            try
            {
                Marshal.StructureToPtr(register, input, false);
                if (!DeviceIoControl(_device!, IoctlRegisterRing, input, Marshal.SizeOf<RegisterRing>(),
                        IntPtr.Zero, 0, out _, IntPtr.Zero))
                {
                    LastError = $"REGISTER_RING 失败 (win32={Marshal.GetLastWin32Error()})";
                    CleanupMapping();
                    return false;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(input);
            }

            if (!DeviceIoControl(_device!, IoctlStart, IntPtr.Zero, 0, IntPtr.Zero, 0, out _, IntPtr.Zero))
            {
                LastError = $"START 失败 (win32={Marshal.GetLastWin32Error()})";
                CleanupMapping();
                return false;
            }

            _ringBytes = ringBytes;
            _writeFrame = 0;
            _running = true;
            return true;
        }
    }

    /// <summary>写入交织 PCM 字节；ring 满时覆盖最旧数据（Phase 0 仅用于诊断）。</summary>
    public void WritePcm(ReadOnlySpan<byte> pcm)
    {
        lock (_gate)
        {
            if (!_running || _view == IntPtr.Zero) return;
            var frameBytes = Math.Max(1, Channels * (BitsPerSample / 8));
            var ringFrames = (int)(_ringBytes / frameBytes);
            var frames = pcm.Length / frameBytes;
            for (var i = 0; i < frames; i++)
            {
                var offset = (int)((_writeFrame + (uint)i) % (uint)ringFrames) * frameBytes;
                var sourceOffset = i * frameBytes;
                Marshal.Copy(pcm.Slice(sourceOffset, frameBytes).ToArray(), 0, _view + (int)HeaderBytes + offset, frameBytes);
            }

            _writeFrame += (uint)frames;
            Marshal.WriteInt32(_view, 28, unchecked((int)_writeFrame));
        }
    }

    public void Stop()
    {
        lock (_gate)
        {
            if (_device is { IsInvalid: false })
            {
                DeviceIoControl(_device, IoctlStop, IntPtr.Zero, 0, IntPtr.Zero, 0, out _, IntPtr.Zero);
            }

            _running = false;
            CleanupMapping();
        }
    }

    private void CleanupMapping()
    {
        if (_view != IntPtr.Zero)
        {
            UnmapViewOfFile(_view);
            _view = IntPtr.Zero;
        }

        if (_section != IntPtr.Zero)
        {
            CloseHandle(_section);
            _section = IntPtr.Zero;
        }

        _ringBytes = 0;
        _writeFrame = 0;
    }

    private void WriteHeader(uint ringBytes)
    {
        if (_view == IntPtr.Zero) return;
        Marshal.WriteInt32(_view, 0, unchecked((int)0x5A4C5841));
        Marshal.WriteInt32(_view, 4, (int)AbiVersion);
        Marshal.WriteInt32(_view, 8, (int)HeaderBytes);
        Marshal.WriteInt32(_view, 12, (int)ringBytes);
        Marshal.WriteInt32(_view, 16, (int)SampleRate);
        Marshal.WriteInt16(_view, 20, (short)Channels);
        Marshal.WriteInt16(_view, 22, (short)BitsPerSample);
        Marshal.WriteInt32(_view, 24, (int)FramesPerPacket);
        Marshal.WriteInt32(_view, 28, 0);
        Marshal.WriteInt32(_view, 32, 0);
        Marshal.WriteInt32(_view, 36, 0);
        Marshal.WriteInt32(_view, 40, 0);
        Marshal.WriteInt32(_view, 44, 0);
        Marshal.WriteInt32(_view, 48, 0);
    }

    public void Dispose()
    {
        Stop();
        _device?.Dispose();
        _device = null;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFile(
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
        SafeFileHandle device, uint controlCode, IntPtr inBuffer, int inBufferSize,
        IntPtr outBuffer, int outBufferSize, out int bytesReturned, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileMapping(
        IntPtr file, IntPtr securityAttributes, uint protect, uint maximumSizeHigh,
        uint maximumSizeLow, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr MapViewOfFile(
        IntPtr mapping, uint desiredAccess, uint fileOffsetHigh, uint fileOffsetLow, UIntPtr numberOfBytesToMap);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UnmapViewOfFile(IntPtr baseAddress);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
