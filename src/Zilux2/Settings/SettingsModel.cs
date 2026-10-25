using System.Text.Json.Serialization;

namespace Zilux2.Settings;

// Contract docs/zilux2-settings-contract.md section 2: keep declaration order, it is the file layout.
internal sealed class SettingsModel
{
    public int Version { get; set; } = 1;

    public GeneralSettings General { get; set; } = new();

    public AppearanceSettings Appearance { get; set; } = new();

    public PlaybackSettings Playback { get; set; } = new();

    public DownloadSettings Downloads { get; set; } = new();

    // 自动更新通道（docs/zilux2-update-channel.md §5）。追加在最后，旧文件顺序不变。
    public UpdateSettings Updates { get; set; } = new();

    // 全局快捷键（docs/zilux2-settings-contract.md §2，宿主解析并注册）。同样追加在最后。
    public ShortcutSettings Shortcuts { get; set; } = new();

    public static SettingsModel CreateDefaults() => new();
}

internal sealed class GeneralSettings
{
    public bool Splash { get; set; } = true;

    public bool StartMaximized { get; set; }
}

internal sealed class AppearanceSettings
{
    public const string ThemeDark = "dark";
    public const string ThemeMidnight = "midnight";

    public const string LyricsSizeMedium = "medium";

    internal static readonly string[] Themes = { ThemeDark, ThemeMidnight };

    internal static readonly string[] LyricsSizes = { "small", LyricsSizeMedium, "large" };

    public const string WindowAnimationCustom = "custom";
    public const string WindowAnimationNative = "native";

    internal static readonly string[] WindowAnimations = { WindowAnimationCustom, WindowAnimationNative };

    public string Theme { get; set; } = ThemeDark;

    public bool ReduceMotion { get; set; }

    public bool Glow { get; set; } = true;

    public bool HeroAutoRotate { get; set; } = true;

    public string LyricsSize { get; set; } = LyricsSizeMedium;

    // 窗口过渡方式：custom=应用内自绘（快照缩放/淡出），native=交给 Windows 原生过渡。
    // 追加在最后，保证旧 settings.json 的字段顺序不变。
    public string WindowAnimation { get; set; } = WindowAnimationCustom;

    // 底部播放条常驻展开：开着时不再依赖鼠标悬停，播放条始终保持展开形态。
    // 追加在最后，保证旧 settings.json 的字段顺序不变。
    public bool PlayerBarExpanded { get; set; }
}

internal sealed class PlaybackSettings
{
    public const string SourceNetease = "netease";
    public const string SourceQq = "qq";

    internal static readonly string[] Sources = { SourceNetease, SourceQq };

    internal static readonly int[] SearchLimits = { 10, 20, 30 };

    public string DefaultSource { get; set; } = SourceNetease;

    public int SearchLimit { get; set; } = 20;

    public bool LyricsAutoOpen { get; set; } = true;

    public double Volume { get; set; } = 0.72;

    // Visualizer source: host-side WASAPI features. Not in the frozen settings contract yet -
    // appended after volume so the persisted layout stays stable for older files.
    public bool AudioReactive { get; set; } = true;

    // 10 段均衡器（页面侧 Web Audio peaking 滤波器）：默认关闭、全 0dB，
    // 保证旧 settings.json 行为不变。EqGains 顺序对应前端 EQ_BAND_FREQS。
    public const string EqPresetFlat = "flat";
    public const string EqPresetPop = "pop";
    public const string EqPresetRock = "rock";
    public const string EqPresetJazz = "jazz";
    public const string EqPresetClassical = "classical";
    public const string EqPresetVocal = "vocal";
    public const string EqPresetBass = "bass";

    internal static readonly string[] EqPresets =
    {
        EqPresetFlat, EqPresetPop, EqPresetRock, EqPresetJazz, EqPresetClassical, EqPresetVocal, EqPresetBass,
    };

    internal const int EqBandCount = 10;

    public bool EqEnabled { get; set; }

    public string EqPreset { get; set; } = EqPresetFlat;

    public int[] EqGains { get; set; } = new int[EqBandCount];

    // 播放/暂停音量渐变：默认关闭，保持原有的瞬时暂停。
    public bool FadeEnabled { get; set; }

    // 旧版单一渐变时长；新版本分别使用 FadeOutMs / FadeInMs，读取旧配置时作为两者缺省值。
    public int FadeMs { get; set; } = 450;

    /// <summary>暂停淡出时长（毫秒，100..5000）。</summary>
    public int FadeOutMs { get; set; } = 450;

    /// <summary>开始播放淡入时长（毫秒，100..5000）。</summary>
    public int FadeInMs { get; set; } = 450;

    public const string FadeCurveSmooth = "smooth";
    public const string FadeCurveLinear = "linear";
    public const string FadeCurveExponential = "exponential";

    internal static readonly string[] FadeCurves =
    {
        FadeCurveSmooth, FadeCurveLinear, FadeCurveExponential,
    };

    /// <summary>渐变曲线：smooth=平滑（默认）/ linear=线性 / exponential=指数（尾段更快）。</summary>
    public string FadeCurve { get; set; } = FadeCurveSmooth;

    /// <summary>人声保留淡出：暂停时先压低低频与高频，让人声所在的频段多停留一会儿。</summary>
    public bool FadeVocal { get; set; }

    /// <summary>人声保留尾音（毫秒，0..3000）：淡出总时长 = FadeOutMs + 该值。</summary>
    public int FadeVocalTailMs { get; set; } = 600;
}

internal sealed class DownloadSettings
{
    public const string QualityStandard = "standard";
    public const string QualityHigh = "high";
    public const string QualityLossless = "lossless";

    internal static readonly string[] Qualities = { QualityStandard, QualityHigh, QualityLossless };

    /// <summary>下载目录；空字符串表示使用 Windows「音乐」目录。</summary>
    public string Directory { get; set; } = string.Empty;

    /// <summary>下载音质：standard=128k、high=320k、lossless=无损（平台不支持时自动降级）。</summary>
    public string Quality { get; set; } = QualityHigh;
}

/// <summary>
/// 自动更新偏好（docs/zilux2-update-channel.md §5）。
/// mode=auto：后台自动下载，下载完成后询问是否立即安装并重启；
/// mode=notify：只提示新版本，由用户手动打开下载页。
/// repo 为空表示使用构建时烘焙进程序集的仓库（CI 会设为真实仓库）。
/// </summary>
internal sealed class UpdateSettings
{
    public const string ModeAuto = "auto";
    public const string ModeNotify = "notify";

    internal static readonly string[] Modes = { ModeAuto, ModeNotify };

    /// <summary>启动后自动检查更新。</summary>
    public bool AutoCheck { get; set; } = true;

    /// <summary>更新方式：auto=应用内更新，notify=仅提示。</summary>
    public string Mode { get; set; } = ModeAuto;

    /// <summary>覆盖仓库（owner/name）；空字符串表示用构建时内置的仓库。</summary>
    public string Repo { get; set; } = string.Empty;
}

/// <summary>
/// 全局快捷键（docs/zilux2-settings-contract.md §2）。字符串是 RegisterHotKey 风格的组合键，
/// 由宿主解析；空字符串表示关闭该条，<see cref="Enabled"/>=false 表示全部关闭。
/// prev/next 的默认值在部分机器上会被输入法/显卡驱动占用，宿主对「仍是默认值」的组合保留
/// 候选回落链（见 MainWindow.HotkeyCatalog），用户改过的组合则只注册配置值。
/// </summary>
internal sealed class ShortcutSettings
{
    public const string DefaultPlayPause = "Ctrl+Alt+Space";
    public const string DefaultPrev = "Ctrl+Alt+Left";
    public const string DefaultNext = "Ctrl+Alt+Right";
    public const string DefaultToggleWindow = "Ctrl+Alt+Z";

    /// <summary>快捷键总开关；false 时宿主注销全部全局热键。</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>播放/暂停，默认 Ctrl+Alt+Space。</summary>
    public string PlayPause { get; set; } = DefaultPlayPause;

    /// <summary>上一首，默认 Ctrl+Alt+Left（被占用时宿主回落到候选键）。</summary>
    public string Prev { get; set; } = DefaultPrev;

    /// <summary>下一首，默认 Ctrl+Alt+Right（被占用时宿主回落到候选键）。</summary>
    public string Next { get; set; } = DefaultNext;

    /// <summary>显示/隐藏主窗口，默认 Ctrl+Alt+Z。</summary>
    public string ToggleWindow { get; set; } = DefaultToggleWindow;

    /// <summary>复制一份，避免调用方在锁外直接读写正在被序列化的实例。</summary>
    public ShortcutSettings Clone() => new()
    {
        Enabled = Enabled,
        PlayPause = PlayPause,
        Prev = Prev,
        Next = Next,
        ToggleWindow = ToggleWindow,
    };
}

// Host -> page envelope from contract section 3.2; `state` is the full file document.
internal sealed class HostSettingsMessage
{
    public int V { get; set; } = 1;

    public string Type { get; set; } = "host";

    public string Event { get; set; } = "settings";

    public int Version { get; set; } = 1;

    public SettingsModel State { get; set; } = SettingsModel.CreateDefaults();
}

[JsonSourceGenerationOptions(WriteIndented = false, PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(SettingsModel))]
[JsonSerializable(typeof(HostSettingsMessage))]
internal sealed partial class SettingsJsonContext : JsonSerializerContext
{
}
