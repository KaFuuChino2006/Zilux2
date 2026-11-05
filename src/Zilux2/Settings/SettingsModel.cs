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

    // 开机自启（HKCU\Software\Microsoft\Windows\CurrentVersion\Run 值 Zilux2）。追加在最后，
    // 保证旧 settings.json 的字段顺序不变。
    public bool AutoLaunch { get; set; }

    // 开机自启时不显示主界面：Run 项命令行追加 --hidden，宿主启动后直接驻留托盘。
    // 默认开启——开机自启的语义就是「后台待命」，需要窗口时从托盘或任务栏再打开。
    public bool AutoStartHidden { get; set; } = true;

    // 本地曲库目录自动监控开关（LocalMusicService.Watch）。追加在最后，同上。
    public bool WatchLocalFolder { get; set; } = true;

    // Windows 系统媒体控制（SMTC）：任务栏媒体弹窗、音量键旁的小卡片。默认开启。
    public bool MediaSession { get; set; } = true;

    // 桌面歌词独立窗口（无边框、置顶、可拖动；锁定后鼠标穿透）。
    public bool DesktopLyrics { get; set; }

    public bool DesktopLyricsLocked { get; set; }

    // 28..64，默认 40（副行按 0.45 倍字号跟随；契约与窗口 ApplyStyle 使用同一范围）。
    public int DesktopLyricsFontSize { get; set; } = 40;

    public bool DesktopLyricsTopmost { get; set; } = true;

    // 粗细：normal / semibold / bold；底色不透明度 30..90（百分比，默认 40）。
    public const string DesktopLyricsWeightNormal = "normal";
    public const string DesktopLyricsWeightSemibold = "semibold";
    public const string DesktopLyricsWeightBold = "bold";

    internal static readonly string[] DesktopLyricsWeights =
    {
        DesktopLyricsWeightNormal,
        DesktopLyricsWeightSemibold,
        DesktopLyricsWeightBold,
    };

    public string DesktopLyricsWeight { get; set; } = DesktopLyricsWeightNormal;

    public int DesktopLyricsBackdropOpacity { get; set; } = 40;

    // 桌面背景歌词：把歌词页的播放效果镜像到桌面壁纸层（第二个 WebView2 窗口挂在 WorkerW 下），
    // 打开期间软件内的歌词页不再显示歌词，关掉后恢复。追加在最后，保证旧 settings.json 字段顺序不变。
    public bool BackgroundLyrics { get; set; }

    // 桌面歌词上次关闭时的位置（屏幕坐标，可为负；null=尚未记录，使用默认位置）。
    // 由 MainWindow 在窗口关闭时 patch 回设置，启动时优先恢复。追加在最后，旧文件顺序不变。
    public double? DesktopLyricsLeft { get; set; }

    public double? DesktopLyricsTop { get; set; }
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

    // 仅兼容旧数据：v1.1 起界面固定白色磨砂（frost），宿主只持久化/回传该值，不再驱动主题切换。
    public string Theme { get; set; } = ThemeDark;

    public bool ReduceMotion { get; set; }

    public bool Glow { get; set; } = true;

    public string LyricsSize { get; set; } = LyricsSizeMedium;

    // 窗口过渡方式：custom=应用内自绘（快照缩放/淡出），native=交给 Windows 原生过渡。
    // 追加在最后，保证旧 settings.json 的字段顺序不变。
    public string WindowAnimation { get; set; } = WindowAnimationCustom;

    // 底部播放条常驻展开：开着时不再依赖鼠标悬停，播放条始终保持展开形态。
    // 追加在最后，保证旧 settings.json 的字段顺序不变。
    public bool PlayerBarExpanded { get; set; }

    // 迷你播放器尺寸预设：compact=360×100、standard=420×120、wide=520×150。
    public const string MiniSizeCompact = "compact";
    public const string MiniSizeStandard = "standard";
    public const string MiniSizeWide = "wide";

    internal static readonly string[] MiniSizes = { MiniSizeCompact, MiniSizeStandard, MiniSizeWide };

    public string MiniSize { get; set; } = MiniSizeStandard;

    // 迷你播放器是否置顶；关掉后小窗会像普通窗口一样被其它窗口盖住。
    public bool MiniAlwaysOnTop { get; set; } = true;
}

internal sealed class PlaybackSettings
{
    public const string SourceNetease = "netease";
    public const string SourceQq = "qq";
    // 实验源（无名音乐）：只有用户在实验功能里开启后才出现在页面；仍允许设为默认平台，
    // 否则设置页选中它会被宿主白名单拒绝并静默回退（默认平台选项来自 sourceIds()）。
    public const string SourceMvmp3 = "mvmp3";

    internal static readonly string[] Sources = { SourceNetease, SourceQq, SourceMvmp3 };

    internal static readonly int[] SearchLimits = { 10, 20, 30 };

    public string DefaultSource { get; set; } = SourceNetease;

    public int SearchLimit { get; set; } = 20;

    public double Volume { get; set; } = 0.72;

    // Visualizer source: host-side WASAPI features. Not in the frozen settings contract yet -
    // appended after volume so the persisted layout stays stable for older files.
    public bool AudioReactive { get; set; } = true;

    /// <summary>在线播放音质偏好（standard/high/lossless）。宿主只负责持久化与回传快照，
    /// 真正的音质协商由页面请求 /api/stream 时完成；与下载音质共用同一组取值。</summary>
    public string Quality { get; set; } = DownloadSettings.QualityHigh;

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

    /// <summary>暂停淡出时长（毫秒，100..3000）。</summary>
    public int FadeOutMs { get; set; } = 450;

    /// <summary>开始播放淡入时长（毫秒，100..3000）。</summary>
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

    /// <summary>睡眠定时到点前的音量渐弱时长（秒，0..60；0 表示不渐弱，直接暂停）。</summary>
    public int SleepFadeSeconds { get; set; } = 15;

    public const string SleepActionPause = "pause";
    public const string SleepActionMinimize = "minimize";
    public const string SleepActionExit = "exit";

    internal static readonly string[] SleepActions =
    {
        SleepActionPause, SleepActionMinimize, SleepActionExit,
    };

    /// <summary>睡眠定时到点后的动作：pause 暂停 / minimize 暂停并最小化 / exit 退出应用。</summary>
    public string SleepAction { get; set; } = SleepActionPause;
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

    /// <summary>同时下载的任务数（1–4）；超出后新任务会等前面的任务腾出位置再开始。</summary>
    public int MaxConcurrent { get; set; } = 2;

    /// <summary>文件名模板；支持 {artist} {title} {id} {quality} 占位符，非法字符会被替换成空格。</summary>
    public string FileNameTemplate { get; set; } = "{artist} - {title}";

    /// <summary>下载完成后自动打开文件所在文件夹（只打开一次，失败只记日志）。</summary>
    public bool OpenFolderWhenDone { get; set; }
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

    /// <summary>
    /// 检查更新/下载安装包时直连 GitHub，不走系统代理。
    /// 系统代理的出口 IP 被 GitHub 限流（403 rate limit）时打开它。
    /// </summary>
    public bool DirectConnection { get; set; }
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

    /// <summary>
    /// 系统媒体键（播放/暂停、上一首、下一首）始终由 Zilux2 接管：true 时不看「本机是不是
    /// Windows 当前媒体会话」，媒体键永远控制本机播放；false 保留系统原生「媒体键跟着当前
    /// 播放器走」的行为。见 MainWindow.InstallMediaKeyHook / docs/zilux2-settings-contract.md §2。
    /// </summary>
    public bool AlwaysHandleMediaKeys { get; set; } = true;

    /// <summary>播放/暂停，默认 Ctrl+Alt+Space。</summary>
    public string PlayPause { get; set; } = DefaultPlayPause;

    /// <summary>上一首，默认 Ctrl+Alt+Left（被占用时宿主回落到候选键）。</summary>
    public string Prev { get; set; } = DefaultPrev;

    /// <summary>下一首，默认 Ctrl+Alt+Right（被占用时宿主回落到候选键）。</summary>
    public string Next { get; set; } = DefaultNext;

    /// <summary>显示/隐藏主窗口，默认 Ctrl+Alt+Z。</summary>
    public string ToggleWindow { get; set; } = DefaultToggleWindow;

    /// <summary>音量加（默认不绑定，用户在设置里自行录制）。</summary>
    public string VolumeUp { get; set; } = string.Empty;

    /// <summary>音量减。</summary>
    public string VolumeDown { get; set; } = string.Empty;

    /// <summary>静音 / 取消静音。</summary>
    public string Mute { get; set; } = string.Empty;

    /// <summary>收藏当前歌曲。</summary>
    public string Like { get; set; } = string.Empty;

    /// <summary>切换播放模式（列表循环 / 单曲循环 / 随机）。</summary>
    public string Mode { get; set; } = string.Empty;

    /// <summary>进入 / 退出迷你播放器。</summary>
    public string Mini { get; set; } = string.Empty;

    /// <summary>开关桌面歌词。</summary>
    public string DesktopLyrics { get; set; } = string.Empty;

    /// <summary>开关无缝衔接。</summary>
    public string Crossfade { get; set; } = string.Empty;

    /// <summary>复制一份，避免调用方在锁外直接读写正在被序列化的实例。</summary>
    public ShortcutSettings Clone() => new()
    {
        Enabled = Enabled,
        AlwaysHandleMediaKeys = AlwaysHandleMediaKeys,
        PlayPause = PlayPause,
        Prev = Prev,
        Next = Next,
        ToggleWindow = ToggleWindow,
        VolumeUp = VolumeUp,
        VolumeDown = VolumeDown,
        Mute = Mute,
        Like = Like,
        Mode = Mode,
        Mini = Mini,
        DesktopLyrics = DesktopLyrics,
        Crossfade = Crossfade,
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
