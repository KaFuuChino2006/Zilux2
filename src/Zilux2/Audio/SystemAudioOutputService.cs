using System.Runtime.InteropServices;

namespace Zilux2.Audio;

/// <summary>一个活动播放设备（WASAPI 端点）。<see cref="Id"/> 是端点 ID，可直接交给 IPolicyConfig。</summary>
internal sealed record SystemAudioOutputDevice(string Id, string Name, bool IsDefault);

/// <summary>
/// Windows 默认播放设备的枚举与切换。
///
/// 只服务「切换系统输出」这一个功能：枚举活动播放端点（IMMDeviceEnumerator），用
/// IPolicyConfig::SetDefaultEndpoint 切换系统默认设备。它不碰本软件自己的音频通道——
/// 软件内的输出选择在页面侧用 Web Audio / 媒体元素的 setSinkId 完成，两条链路互不相干。
/// </summary>
internal static class SystemAudioOutputService
{
    private const int DataFlowRender = 0;
    private const int DeviceStateActive = 0x00000001;
    private const int RoleConsole = 0;
    private const int RoleMultimedia = 1;
    private const int RoleCommunications = 2;
    private const int StgmRead = 0;
    private const int VtLpwstr = 31;

    private static readonly PropertyKey PkeyDeviceFriendlyName = new()
    {
        FormatId = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),
        PropertyId = 14,
    };

    /// <summary>当前默认播放设备（eConsole）；没有设备时返回 null。</summary>
    public static SystemAudioOutputDevice? CurrentDefault()
    {
        return List().FirstOrDefault(device => device.IsDefault);
    }

    /// <summary>枚举全部活动播放设备（按系统枚举顺序，标记当前默认项）。</summary>
    public static IReadOnlyList<SystemAudioOutputDevice> List()
    {
        var result = new List<SystemAudioOutputDevice>();
        LoopbackCapture.IMMDeviceEnumerator? enumerator = null;
        try
        {
            enumerator = (LoopbackCapture.IMMDeviceEnumerator)new LoopbackCapture.MMDeviceEnumeratorComObject();
            string? defaultId = null;
            if (enumerator.GetDefaultAudioEndpoint(DataFlowRender, RoleConsole, out var defaultDevice) >= 0 &&
                defaultDevice is not null)
            {
                defaultId = GetDeviceId(defaultDevice);
                Release(defaultDevice);
            }

            if (enumerator.EnumAudioEndpoints(DataFlowRender, DeviceStateActive, out var collection) < 0 ||
                collection is null)
            {
                return result;
            }

            try
            {
                if (collection.GetCount(out var count) < 0)
                {
                    return result;
                }

                for (uint index = 0; index < count; index++)
                {
                    if (collection.Item(index, out var device) < 0 || device is null)
                    {
                        continue;
                    }

                    try
                    {
                        var id = GetDeviceId(device);
                        if (string.IsNullOrEmpty(id))
                        {
                            continue;
                        }

                        result.Add(new SystemAudioOutputDevice(id, GetFriendlyName(device) ?? id, id == defaultId));
                    }
                    finally
                    {
                        Release(device);
                    }
                }
            }
            finally
            {
                Release(collection);
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[audioOutput] enumerate failed: {exception.GetType().Name}: {exception.Message}");
        }
        finally
        {
            Release(enumerator);
        }

        return result;
    }

    /// <summary>把系统默认播放设备（控制台/多媒体/通信三个角色）切换到 <paramref name="deviceId"/>。</summary>
    public static bool SetDefault(string deviceId)
    {
        if (string.IsNullOrWhiteSpace(deviceId))
        {
            return false;
        }

        IPolicyConfig? config = null;
        try
        {
            config = (IPolicyConfig)new PolicyConfigClient();
            foreach (var role in new[] { RoleConsole, RoleMultimedia, RoleCommunications })
            {
                var hr = config.SetDefaultEndpoint(deviceId, role);
                if (hr < 0)
                {
                    HostLog.Warn($"[audioOutput] SetDefaultEndpoint failed role={role} hr=0x{hr:X8} device={deviceId}");
                    return false;
                }
            }

            HostLog.Info($"[audioOutput] default switched device={deviceId}");
            return true;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[audioOutput] set default failed: {exception.GetType().Name}: {exception.Message}");
            return false;
        }
        finally
        {
            Release(config);
        }
    }

    /// <summary>
    /// 切到轮换列表里的下一台设备。<paramref name="rotation"/> 为空表示全部活动设备。
    /// 返回切换后的设备；没有可切设备时返回 null。
    /// </summary>
    public static SystemAudioOutputDevice? Cycle(IReadOnlyList<string> rotation)
    {
        var devices = List();
        if (devices.Count == 0)
        {
            HostLog.Warn("[audioOutput] cycle skipped: no active render endpoint");
            return null;
        }

        var ordered = new List<SystemAudioOutputDevice>();
        if (rotation.Count > 0)
        {
            foreach (var id in rotation)
            {
                var match = devices.FirstOrDefault(device => string.Equals(device.Id, id, StringComparison.Ordinal));
                if (match is not null)
                {
                    ordered.Add(match);
                }
            }
        }

        if (ordered.Count == 0)
        {
            ordered.AddRange(devices);
        }

        var current = devices.FirstOrDefault(device => device.IsDefault);
        var index = current is null
            ? -1
            : ordered.FindIndex(device => string.Equals(device.Id, current.Id, StringComparison.Ordinal));
        var next = ordered[(index + 1 + ordered.Count) % ordered.Count];
        if (!SetDefault(next.Id))
        {
            return null;
        }

        return next with { IsDefault = true };
    }

    private static string? GetDeviceId(LoopbackCapture.IMMDevice device)
    {
        return device.GetId(out var id) >= 0 ? id : null;
    }

    private static string? GetFriendlyName(LoopbackCapture.IMMDevice device)
    {
        if (device.OpenPropertyStore(StgmRead, out var storePointer) < 0 || storePointer == IntPtr.Zero)
        {
            return null;
        }

        object? storeObject = null;
        try
        {
            storeObject = Marshal.GetObjectForIUnknown(storePointer);
            var store = (IPropertyStore)storeObject;
            var key = PkeyDeviceFriendlyName;
            if (store.GetValue(ref key, out var value) < 0)
            {
                return null;
            }

            try
            {
                return value.Vt == VtLpwstr && value.Pointer != IntPtr.Zero
                    ? Marshal.PtrToStringUni(value.Pointer)
                    : null;
            }
            finally
            {
                PropVariantClear(ref value);
            }
        }
        finally
        {
            Release(storeObject);
            Marshal.Release(storePointer);
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
            // Best effort: a failed release must not break the caller.
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid FormatId;
        public int PropertyId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariant
    {
        public ushort Vt;
        public ushort Reserved1;
        public ushort Reserved2;
        public ushort Reserved3;
        public IntPtr Pointer;
        public IntPtr Pointer2;
    }

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant value);

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig]
        int GetCount(out uint count);

        [PreserveSig]
        int GetAt(uint index, out PropertyKey key);

        [PreserveSig]
        int GetValue(ref PropertyKey key, out PropVariant value);

        [PreserveSig]
        int SetValue(ref PropertyKey key, ref PropVariant value);

        [PreserveSig]
        int Commit();
    }

    [ComImport]
    [Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    private class PolicyConfigClient
    {
    }

    [ComImport]
    [Guid("F8679F50-850A-41CF-9C72-430F290290C8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPolicyConfig
    {
        [PreserveSig]
        int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceName, out IntPtr format);

        [PreserveSig]
        int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceName, [MarshalAs(UnmanagedType.Bool)] bool isDefault, out IntPtr format);

        [PreserveSig]
        int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceName);

        [PreserveSig]
        int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceName, IntPtr endpointFormat, IntPtr mixFormat);

        [PreserveSig]
        int GetProcessingPeriod(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceName,
            [MarshalAs(UnmanagedType.Bool)] bool isDefault,
            out long defaultPeriod,
            out long minimumPeriod);

        [PreserveSig]
        int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceName, ref long period);

        [PreserveSig]
        int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceName, out IntPtr mode);

        [PreserveSig]
        int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceName, IntPtr mode);

        [PreserveSig]
        int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceName, IntPtr key, out IntPtr value);

        [PreserveSig]
        int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceName, IntPtr key, IntPtr value);

        [PreserveSig]
        int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceName, int role);

        [PreserveSig]
        int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string deviceName, [MarshalAs(UnmanagedType.Bool)] bool visible);
    }
}

/// <summary>WASAPI 播放端点集合（IMMDeviceCollection）；与 LoopbackCapture 的枚举接口配套。</summary>
[ComImport]
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceCollection
{
    [PreserveSig]
    int GetCount(out uint count);

    [PreserveSig]
    int Item(uint index, out LoopbackCapture.IMMDevice? device);
}


