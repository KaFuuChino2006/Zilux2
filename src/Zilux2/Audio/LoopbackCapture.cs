using System.Runtime.InteropServices;

namespace Zilux2.Audio;

/// <summary>
/// Minimal WASAPI loopback capture of the current default playback device.
/// Hand-rolled COM interop on purpose: the host takes no third-party audio dependency, and
/// the surface we need (default render endpoint + shared-mode loopback stream) is tiny.
/// Usage: new -> TryStart -> Read/WaitForData in a loop -> Dispose. Not thread safe; one
/// capture thread owns an instance.
/// </summary>
internal sealed class LoopbackCapture : IDisposable, IAirPlayAudioSource
{
    private const int AudClntStreamFlagsLoopback = 0x00020000;
    private const int AudClntStreamFlagsEventCallback = 0x00040000;
    private const int AudClntBufferFlagsSilent = 0x00000002;
    private const int ShareModeShared = 0;
    private const int DataFlowRender = 0;
    private const int RoleMultimedia = 1;
    private const int ClsCtxAll = 23;
    private const long BufferDurationHns = 1_000_000; // 100 ms, plenty for a 30 Hz consumer

    private const int WaveFormatPcm = 1;
    private const int WaveFormatIeeeFloat = 3;
    private const int WaveFormatExtensible = 0xFFFE;

    private static readonly Guid IidAudioClient = new("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    private static readonly Guid IidAudioCaptureClient = new("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
    private static readonly Guid KsDataFormatSubtypePcm = new("00000001-0000-0010-8000-00AA00389B71");
    private static readonly Guid KsDataFormatSubtypeIeeeFloat = new("00000003-0000-0010-8000-00AA00389B71");

    private IAudioClient? _client;
    private IAudioCaptureClient? _capture;
    private IntPtr _eventHandle;
    private bool _running;
    private float[] _floatScratch = Array.Empty<float>();
    private short[] _shortScratch = Array.Empty<short>();

    internal int SampleRate { get; private set; }

    internal int Channels { get; private set; }

    internal int BitsPerSample { get; private set; }

    internal bool IsFloat { get; private set; }

    /// <summary>Why the last TryStart failed; null after a successful start.</summary>
    internal string? LastError { get; private set; }

    internal bool TryStart()
    {
        LastError = null;

        IMMDeviceEnumerator? enumerator = null;
        IMMDevice? device = null;
        IAudioClient? client = null;
        IAudioCaptureClient? capture = null;
        var eventHandle = IntPtr.Zero;
        var mixFormat = IntPtr.Zero;
        var started = false;

        try
        {
            enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
            if (enumerator is null)
            {
                Fail("failed to create MMDeviceEnumerator");
                return false;
            }

            var hr = enumerator.GetDefaultAudioEndpoint(DataFlowRender, RoleMultimedia, out device);
            if (hr != 0 || device is null)
            {
                Fail($"no default playback device (hr=0x{hr:X8})");
                return false;
            }

            var iidClient = IidAudioClient;
            hr = device.Activate(ref iidClient, ClsCtxAll, IntPtr.Zero, out var activated);
            if (hr != 0 || activated is not IAudioClient audioClient)
            {
                Fail($"audio client activation failed (hr=0x{hr:X8})");
                return false;
            }

            client = audioClient;

            hr = client.GetMixFormat(out mixFormat);
            if (hr != 0 || mixFormat == IntPtr.Zero)
            {
                Fail($"GetMixFormat failed (hr=0x{hr:X8})");
                return false;
            }

            if (!TryDescribeFormat(mixFormat))
            {
                return false;
            }

            hr = client.Initialize(
                ShareModeShared,
                AudClntStreamFlagsLoopback | AudClntStreamFlagsEventCallback,
                BufferDurationHns,
                0,
                mixFormat,
                IntPtr.Zero);
            if (hr != 0)
            {
                Fail($"loopback initialize failed (hr=0x{hr:X8})");
                return false;
            }

            hr = client.GetBufferSize(out var bufferFrames);
            if (hr != 0)
            {
                Fail($"GetBufferSize failed (hr=0x{hr:X8})");
                return false;
            }

            var iidCapture = IidAudioCaptureClient;
            hr = client.GetService(ref iidCapture, out var captureObject);
            if (hr != 0 || captureObject is not IAudioCaptureClient audioCapture)
            {
                Fail($"capture client unavailable (hr=0x{hr:X8})");
                return false;
            }

            capture = audioCapture;

            eventHandle = CreateEventW(IntPtr.Zero, false, false, IntPtr.Zero);
            if (eventHandle == IntPtr.Zero)
            {
                Fail("CreateEvent failed");
                return false;
            }

            hr = client.SetEventHandle(eventHandle);
            if (hr != 0)
            {
                Fail($"SetEventHandle failed (hr=0x{hr:X8})");
                return false;
            }

            hr = client.Start();
            if (hr != 0)
            {
                Fail($"loopback start failed (hr=0x{hr:X8})");
                return false;
            }

            _client = client;
            _capture = capture;
            _eventHandle = eventHandle;
            _running = true;
            EnsureScratch(Math.Max(4096, (int)bufferFrames * Math.Max(1, Channels)));
            started = true;
            return true;
        }
        catch (Exception exception)
        {
            Fail($"{exception.GetType().Name}: {exception.Message}");
            return false;
        }
        finally
        {
            if (mixFormat != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(mixFormat);
            }

            if (!started)
            {
                if (client is not null)
                {
                    try
                    {
                        client.Stop();
                    }
                    catch
                    {
                        // Shutting down a half-initialized client; nothing to report.
                    }
                }

                if (eventHandle != IntPtr.Zero)
                {
                    CloseHandle(eventHandle);
                }

                Release(capture);
                Release(client);
            }

            Release(device);
            Release(enumerator);
        }
    }

    /// <summary>
    /// Blocks until the capture engine has new packets or the timeout elapses.
    /// Returns true when new data is likely available.
    /// </summary>
    internal bool WaitForData(int timeoutMilliseconds)
    {
        return _eventHandle != IntPtr.Zero && WaitForSingleObject(_eventHandle, timeoutMilliseconds) == 0;
    }

    /// <summary>
    /// Copies captured audio as mono float samples (channels averaged). Packets that do not fit
    /// are dropped rather than buffered: the caller keeps a large enough destination.
    /// </summary>
    internal int Read(float[] destination)
    {
        if (!_running || _capture is null || destination.Length == 0)
        {
            return 0;
        }

        var written = 0;
        while (written < destination.Length)
        {
            var hr = _capture.GetNextPacketSize(out var packetFrames);
            if (hr != 0 || packetFrames == 0)
            {
                break;
            }

            hr = _capture.GetBuffer(out var data, out var frames, out var flags, out _, out _);
            if (hr != 0)
            {
                LastError = $"GetBuffer failed (hr=0x{hr:X8})";
                break;
            }

            try
            {
                if (frames > 0)
                {
                    written += CopyFrames(data, (int)frames, (flags & AudClntBufferFlagsSilent) != 0, destination, written);
                }
            }
            finally
            {
                _capture.ReleaseBuffer(frames);
            }
        }

        return written;
    }

    /// <summary>
    /// Copies captured audio as interleaved stereo float samples (L,R,L,R,...) at the mixer rate.
    /// Mono sources are duplicated to both channels; multichannel sources keep the first two channels.
    /// Used by the AirPlay sender, which needs stereo PCM rather than the averaged mono visualizer feed.
    /// </summary>
    internal int ReadInterleaved(float[] destination)
    {
        if (!_running || _capture is null || destination.Length < 2)
        {
            return 0;
        }

        var written = 0;
        while (written + 2 <= destination.Length)
        {
            var hr = _capture.GetNextPacketSize(out var packetFrames);
            if (hr != 0 || packetFrames == 0)
            {
                break;
            }

            hr = _capture.GetBuffer(out var data, out var frames, out var flags, out _, out _);
            if (hr != 0)
            {
                LastError = $"GetBuffer failed (hr=0x{hr:X8})";
                break;
            }

            try
            {
                if (frames > 0)
                {
                    written += CopyFramesInterleaved(data, (int)frames, (flags & AudClntBufferFlagsSilent) != 0, destination, written);
                }
            }
            finally
            {
                _capture.ReleaseBuffer(frames);
            }
        }

        return written;
    }

    public void Dispose()
    {
        _running = false;
        var client = _client;
        var capture = _capture;
        _client = null;
        _capture = null;

        if (client is not null)
        {
            try
            {
                client.Stop();
            }
            catch
            {
                // The engine may already be gone (device removed); releasing below is enough.
            }
        }

        if (_eventHandle != IntPtr.Zero)
        {
            CloseHandle(_eventHandle);
            _eventHandle = IntPtr.Zero;
        }

        Release(capture);
        Release(client);
    }

    // IAirPlayAudioSource: the streamer only needs the pull surface, so the public-facing
    // capture API above keeps its internal names.
    int IAirPlayAudioSource.SampleRate => SampleRate;

    int IAirPlayAudioSource.Channels => Channels;

    bool IAirPlayAudioSource.WaitForData(int timeoutMilliseconds) => WaitForData(timeoutMilliseconds);

    int IAirPlayAudioSource.ReadInterleaved(float[] destination) => ReadInterleaved(destination);

    private void Fail(string error)
    {
        LastError = error;
    }

    private bool TryDescribeFormat(IntPtr mixFormat)
    {
        var format = Marshal.PtrToStructure<WaveFormatEx>(mixFormat);
        var formatTag = format.FormatTag;
        var channels = (int)format.Channels;
        var sampleRate = (int)format.SamplesPerSec;
        var bitsPerSample = (int)format.BitsPerSample;

        if (formatTag == WaveFormatExtensible)
        {
            var extended = Marshal.PtrToStructure<WaveFormatExtensibleLayout>(mixFormat);
            if (extended.ValidBitsPerSample != 0)
            {
                bitsPerSample = extended.ValidBitsPerSample;
            }

            if (extended.SubFormat == KsDataFormatSubtypeIeeeFloat)
            {
                formatTag = WaveFormatIeeeFloat;
            }
            else if (extended.SubFormat == KsDataFormatSubtypePcm)
            {
                formatTag = WaveFormatPcm;
            }
        }

        if (channels <= 0 || sampleRate <= 0)
        {
            Fail($"invalid mix format channels={channels} rate={sampleRate}");
            return false;
        }

        if (formatTag == WaveFormatIeeeFloat && bitsPerSample == 32)
        {
            IsFloat = true;
        }
        else if (formatTag == WaveFormatPcm && bitsPerSample == 16)
        {
            IsFloat = false;
        }
        else
        {
            Fail($"unsupported mix format tag=0x{formatTag:X4} bits={bitsPerSample}");
            return false;
        }

        Channels = channels;
        SampleRate = sampleRate;
        BitsPerSample = bitsPerSample;
        return true;
    }

    private int CopyFrames(IntPtr data, int frames, bool silent, float[] destination, int offset)
    {
        var channels = Math.Max(1, Channels);
        var frameCount = Math.Min(frames, (destination.Length - offset) / channels);
        if (frameCount <= 0)
        {
            return 0;
        }

        if (silent || data == IntPtr.Zero)
        {
            Array.Clear(destination, offset, frameCount);
            return frameCount;
        }

        var samples = frameCount * channels;
        if (IsFloat)
        {
            EnsureFloatScratch(samples);
            Marshal.Copy(data, _floatScratch, 0, samples);
            for (var frame = 0; frame < frameCount; frame++)
            {
                var baseIndex = frame * channels;
                var sum = 0f;
                for (var channel = 0; channel < channels; channel++)
                {
                    sum += _floatScratch[baseIndex + channel];
                }

                destination[offset + frame] = sum / channels;
            }
        }
        else
        {
            EnsureShortScratch(samples);
            Marshal.Copy(data, _shortScratch, 0, samples);
            for (var frame = 0; frame < frameCount; frame++)
            {
                var baseIndex = frame * channels;
                var sum = 0f;
                for (var channel = 0; channel < channels; channel++)
                {
                    sum += _shortScratch[baseIndex + channel] / 32768f;
                }

                destination[offset + frame] = sum / channels;
            }
        }

        return frameCount;
    }

    private int CopyFramesInterleaved(IntPtr data, int frames, bool silent, float[] destination, int offset)
    {
        var channels = Math.Max(1, Channels);
        var frameCount = Math.Min(frames, (destination.Length - offset) / 2);
        if (frameCount <= 0)
        {
            return 0;
        }

        var written = frameCount * 2;
        if (silent || data == IntPtr.Zero)
        {
            Array.Clear(destination, offset, written);
            return written;
        }

        var samples = frameCount * channels;
        if (IsFloat)
        {
            EnsureFloatScratch(samples);
            Marshal.Copy(data, _floatScratch, 0, samples);
            for (var frame = 0; frame < frameCount; frame++)
            {
                var baseIndex = frame * channels;
                var left = _floatScratch[baseIndex];
                var right = channels > 1 ? _floatScratch[baseIndex + 1] : left;
                destination[offset + frame * 2] = left;
                destination[offset + frame * 2 + 1] = right;
            }
        }
        else
        {
            EnsureShortScratch(samples);
            Marshal.Copy(data, _shortScratch, 0, samples);
            for (var frame = 0; frame < frameCount; frame++)
            {
                var baseIndex = frame * channels;
                var left = _shortScratch[baseIndex] / 32768f;
                var right = channels > 1 ? _shortScratch[baseIndex + 1] / 32768f : left;
                destination[offset + frame * 2] = left;
                destination[offset + frame * 2 + 1] = right;
            }
        }

        return written;
    }

    private void EnsureScratch(int samples)
    {
        if (IsFloat && _floatScratch.Length < samples)
        {
            _floatScratch = new float[samples];
        }
        else if (!IsFloat && _shortScratch.Length < samples)
        {
            _shortScratch = new short[samples];
        }
    }

    private void EnsureFloatScratch(int samples)
    {
        if (_floatScratch.Length < samples)
        {
            _floatScratch = new float[samples];
        }
    }

    private void EnsureShortScratch(int samples)
    {
        if (_shortScratch.Length < samples)
        {
            _shortScratch = new short[samples];
        }
    }

    private static void Release(object? comObject)
    {
        if (comObject is null)
        {
            return;
        }

        try
        {
            if (Marshal.IsComObject(comObject))
            {
                Marshal.ReleaseComObject(comObject);
            }
        }
        catch
        {
            // Best effort: a failed release must not take the capture thread down.
        }
    }

    // 这几个 COM 类型由 SystemMute 共用：同一个 CLSID 在同一个程序集里只能有一个 [ComImport]
    // 类，否则 RCW 的类型标识会撞车（表现为 "Unable to cast MMDeviceEnumeratorComObject to
    // MMDeviceEnumeratorComObject"），所以两边引用同一份定义。
    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject
    {
    }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig]
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);

        [PreserveSig]
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice? device);

        [PreserveSig]
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice? device);

        [PreserveSig]
        int RegisterEndpointNotificationCallback(IntPtr client);

        [PreserveSig]
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig]
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object? interfacePointer);

        [PreserveSig]
        int OpenPropertyStore(int access, out IntPtr properties);

        [PreserveSig]
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string? id);

        [PreserveSig]
        int GetState(out int state);
    }

    [ComImport]
    [Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig]
        int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);

        [PreserveSig]
        int GetBufferSize(out uint bufferFrames);

        [PreserveSig]
        int GetStreamLatency(out long latency);

        [PreserveSig]
        int GetCurrentPadding(out uint padding);

        [PreserveSig]
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);

        [PreserveSig]
        int GetMixFormat(out IntPtr format);

        [PreserveSig]
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);

        [PreserveSig]
        int Start();

        [PreserveSig]
        int Stop();

        [PreserveSig]
        int Reset();

        [PreserveSig]
        int SetEventHandle(IntPtr eventHandle);

        [PreserveSig]
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object? service);
    }

    [ComImport]
    [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig]
        int GetBuffer(out IntPtr data, out uint frames, out int flags, out long devicePosition, out long qpcPosition);

        [PreserveSig]
        int ReleaseBuffer(uint frames);

        [PreserveSig]
        int GetNextPacketSize(out uint frames);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct WaveFormatEx
    {
        public ushort FormatTag;
        public ushort Channels;
        public uint SamplesPerSec;
        public uint AvgBytesPerSec;
        public ushort BlockAlign;
        public ushort BitsPerSample;
        public ushort CbSize;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct WaveFormatExtensibleLayout
    {
        public WaveFormatEx Format;
        public ushort ValidBitsPerSample;
        public uint ChannelMask;
        public Guid SubFormat;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateEventW(IntPtr attributes, bool manualReset, bool initialState, IntPtr name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, int milliseconds);
}
