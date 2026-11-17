using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Zilux2.Wallpaper;

/// <summary>
/// 显示器稳定键（第 88 轮「多屏画面管理」）。
///
/// canvases 表里每块屏一行：kind='desktop' + monitor_id = <see cref="KeyOf"/>；
/// monitor_id 为空的那一行是「全局桌面画布」，没有单独指定的屏都跟着它走。
/// 键直接用 Screen.DeviceName（\\.\DISPLAY1）——Win32 里就是这么叫的，
/// 换分辨率、换主屏都不会变。这里只做大小写与 \\.\ 前缀的宽松匹配，
/// 免得 HTTP 传回来的 key 因为转义/裁剪对不上。
/// </summary>
internal static class MonitorCatalog
{
    public const int FpsLow = 30;
    public const int FpsHigh = 60;
    public const int DefaultFps = FpsHigh;

    private const string FpsKey = "fps";
    private const string DevicePrefix = @"\\.\";

    /// <summary>canvases.monitor_id 用的稳定键。</summary>
    public static string KeyOf(System.Windows.Forms.Screen screen) => screen.DeviceName;

    /// <summary>去掉 \\.\ 前缀，仅用于宽松比对与日志。</summary>
    public static string Short(string? key)
    {
        var text = (key ?? string.Empty).Trim();
        return text.StartsWith(DevicePrefix, StringComparison.Ordinal) ? text[DevicePrefix.Length..] : text;
    }

    /// <summary>按 key 找屏；key 为空或多屏之间重名时返回 null。</summary>
    public static System.Windows.Forms.Screen? Find(IEnumerable<System.Windows.Forms.Screen> screens, string? key)
    {
        var text = Short(key);
        if (text.Length == 0)
        {
            return null;
        }

        foreach (var screen in screens)
        {
            if (string.Equals(Short(screen.DeviceName), text, StringComparison.OrdinalIgnoreCase))
            {
                return screen;
            }
        }

        return null;
    }

    /// <summary>屏的帧率存在 canvases.filter_json 里（其余字段留给画面滤镜）。</summary>
    public static int ReadFps(string? filterJson)
    {
        if (string.IsNullOrWhiteSpace(filterJson))
        {
            return DefaultFps;
        }

        try
        {
            var node = JsonNode.Parse(filterJson);
            if (node?[FpsKey] is JsonValue value && value.TryGetValue<int>(out var fps))
            {
                return Normalize(fps);
            }
        }
        catch (JsonException)
        {
            // filter_json 是历史数据，坏了就当没设过。
        }

        return DefaultFps;
    }

    /// <summary>把 fps 并进 filter_json，保留其它键。</summary>
    public static string WriteFps(string? filterJson, int fps)
    {
        JsonObject root;
        try
        {
            root = string.IsNullOrWhiteSpace(filterJson)
                ? new JsonObject()
                : JsonNode.Parse(filterJson) as JsonObject ?? new JsonObject();
        }
        catch (JsonException)
        {
            root = new JsonObject();
        }

        root[FpsKey] = Normalize(fps);
        return root.ToJsonString();
    }

    public static int Normalize(int fps) => fps <= FpsLow ? FpsLow : Math.Min(fps, FpsCeiling);

    /// <summary>按这块屏的刷新率上限夹一次；没读到上限时按 60 处理。</summary>
    public static int Clamp(int fps, int maxFps)
    {
        var top = maxFps >= FpsLow ? Math.Min(maxFps, FpsCeiling) : FpsHigh;
        return fps <= FpsLow ? FpsLow : Math.Min(fps, top);
    }

    public static int ReadFps(string? filterJson, int maxFps) => Clamp(ReadFps(filterJson), maxFps);

    /// <summary>
    /// 这块屏的刷新率上限（Hz）——取「当前分辨率下 Windows 列出的所有显示模式」里的最大值。
    /// 60Hz 屏返回 60，144Hz 屏返回 144；读不到就回落当前模式，再不行按 60。
    /// 结果缓存 5 秒：/monitors 每次要枚举几块屏的模式，没必要每帧都问系统。
    /// </summary>
    public static int MaxRefresh(System.Windows.Forms.Screen screen)
    {
        var key = KeyOf(screen);
        lock (RefreshLock)
        {
            if (RefreshCache.TryGetValue(key, out var cached)
                && (DateTime.UtcNow - cached.At).TotalSeconds < 5)
            {
                return cached.Max;
            }
        }

        var value = ReadMaxRefresh(screen);
        lock (RefreshLock)
        {
            RefreshCache[key] = (value, DateTime.UtcNow);
        }

        return value;
    }

    private static int ReadMaxRefresh(System.Windows.Forms.Screen screen)
    {
        var current = ReadMode(screen.DeviceName, EnumCurrentSettings);
        var fallback = current.Frequency is >= FpsLow and <= FpsCeiling ? current.Frequency : DefaultFps;
        if (current.Width <= 0 || current.Height <= 0)
        {
            return fallback;
        }

        var best = fallback;
        for (var mode = 0; mode < 1024; mode++)
        {
            var probe = ReadMode(screen.DeviceName, mode);
            if (!probe.Ok) break;
            if (probe.Width != current.Width || probe.Height != current.Height) continue;
            if (probe.Frequency is >= FpsLow and <= FpsCeiling && probe.Frequency > best) best = probe.Frequency;
        }

        return best;
    }

    private static (bool Ok, int Width, int Height, int Frequency) ReadMode(string deviceName, int mode)
    {
        var devMode = new DevMode
        {
            DeviceName = string.Empty,
            FormName = string.Empty,
            Size = (short)Marshal.SizeOf<DevMode>(),
        };
        if (!EnumDisplaySettingsEx(deviceName, mode, ref devMode, 0)) return (false, 0, 0, 0);
        return (true, devMode.PelsWidth, devMode.PelsHeight, devMode.DisplayFrequency);
    }

    private const int EnumCurrentSettings = -1;
    private const int FpsCeiling = 360;

    private static readonly Dictionary<string, (int Max, DateTime At)> RefreshCache = new(StringComparer.OrdinalIgnoreCase);
    private static readonly object RefreshLock = new();

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DevMode
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string DeviceName;
        public short SpecVersion;
        public short DriverVersion;
        public short Size;
        public short DriverExtra;
        public int Fields;
        public int PositionX;
        public int PositionY;
        public int DisplayOrientation;
        public int DisplayFixedOutput;
        public short Color;
        public short Duplex;
        public short YResolution;
        public short TTOption;
        public short Collate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string FormName;
        public short LogPixels;
        public int BitsPerPel;
        public int PelsWidth;
        public int PelsHeight;
        public int DisplayFlags;
        public int DisplayFrequency;
        public int IcmMethod;
        public int IcmIntent;
        public int MediaType;
        public int DitherType;
        public int Reserved1;
        public int Reserved2;
        public int PanningWidth;
        public int PanningHeight;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplaySettingsEx(string? deviceName, int modeNum, ref DevMode devMode, uint flags);
}
