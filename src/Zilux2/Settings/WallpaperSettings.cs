namespace Zilux2.Settings;

/// <summary>
/// 动态壁纸设置（docs/wallpaper-v2-spec.md §6）。追加在 settings.json 末尾，旧文件顺序不变。
/// 键名与规格书默认值总表一一对应；画布级的「当前壁纸/轮换计时/每屏分配」不放这里，
/// 走 SQLite 的 canvases 表（两画布各存各的，第 27 轮）。
/// </summary>
internal sealed class WallpaperSettings
{
    // ── 基础 ────────────────────────────────────────────────────────────

    public const string AutoLaunchOff = "off";
    public const string AutoLaunchWallpaperOnly = "wallpaper-only";
    public const string AutoLaunchFull = "full";

    internal static readonly string[] AutoLaunchModes = { AutoLaunchOff, AutoLaunchWallpaperOnly, AutoLaunchFull };

    /// <summary>总开关。有素材时默认开（第 51 轮）。</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>软件内背景层（第 3 轮）。</summary>
    public bool InAppEnabled { get; set; } = true;

    /// <summary>壁纸音轨默认关（第 51 轮）。</summary>
    public bool AudioEnabled { get; set; }

    /// <summary>壁纸独立音量 0–100（第 54 轮）。</summary>
    public int AudioVolume { get; set; } = 40;

    public bool AudioFollowSystem { get; set; }

    /// <summary>音乐起播时壁纸淡出时长（第 18 轮 A）。</summary>
    public int MusicDuckMs { get; set; } = 300;

    /// <summary>音乐停止后壁纸淡入时长（第 18 轮 A）。</summary>
    public int MusicRestoreMs { get; set; } = 800;

    /// <summary>窗口覆盖屏幕超过该比例就静音（第 55 轮，0.5–1.0）。</summary>
    public double OccludeThreshold { get; set; } = 0.80;

    /// <summary>关窗缩托盘（第 67 轮 A）；关掉表示关窗即退出。</summary>
    public bool CloseToTray { get; set; } = true;

    /// <summary>自启档位（第 68 轮）：off / wallpaper-only / full。</summary>
    public string AutoLaunch { get; set; } = AutoLaunchOff;

    // 页面生效策略（第 16 轮 C、第 90 轮 A：三级开关的最内层）。
    public bool PageNormal { get; set; } = true;

    public bool PageImmersive { get; set; }

    public bool PageRoom { get; set; }

    public bool PageLogin { get; set; }

    // ── 转场 ────────────────────────────────────────────────────────────

    public const string TransitionRandom = "random";
    public const string TransitionFixed = "fixed";

    internal static readonly string[] TransitionModes = { TransitionRandom, TransitionFixed };

    internal static readonly int[] TransitionDurations = { 0, 200, 300, 500, 800, 1200, 1500, 2000 };

    /// <summary>random 每切一次从预设里挑一个；fixed 固定用 <see cref="TransitionId"/>。</summary>
    public string TransitionMode { get; set; } = TransitionRandom;

    /// <summary>固定转场 id（见规格书 5.3）。</summary>
    public string TransitionId { get; set; } = "fade";

    /// <summary>默认 800ms（第 56 轮）。</summary>
    public int TransitionMs { get; set; } = 800;

    /// <summary>随机池里排除掉的转场 id（规格书第 10 章的待批注建议值）。</summary>
    public List<string> TransitionExclude { get; set; } = new();

    // ── 轮换与规则 ──────────────────────────────────────────────────────

    public const string RotationRandom = "random";
    public const string RotationSequential = "sequential";

    internal static readonly string[] RotationOrders = { RotationRandom, RotationSequential };

    internal static readonly int[] RotationMinutesOptions = { 15, 30, 60, 120 };

    public bool RotationEnabled { get; set; }

    /// <summary>默认 30 分钟（第 57 轮 A）。</summary>
    public int RotationMinutes { get; set; } = 30;

    public string RotationOrder { get; set; } = RotationRandom;

    /// <summary>优先切收藏（第 6 轮）。</summary>
    public bool RotationFavoriteFirst { get; set; }

    /// <summary>切之前预热下一张首帧（第 91 轮 A）。</summary>
    public bool Prewarm { get; set; } = true;

    // ── 桌面层 ──────────────────────────────────────────────────────────

    /// <summary>桌面层默认关，用户手动接管后才跑（第 24 轮 C、第 66 轮）。</summary>
    public bool DesktopEnabled { get; set; }

    /// <summary>上次是否已接管桌面层，用于下次启动自动恢复（第 66 轮「记住状态」）。</summary>
    public bool DesktopAttached { get; set; }

    /// <summary>桌面层是否出声，默认关（第 28 轮 D）。</summary>
    public bool DesktopSound { get; set; }

    /// <summary>桌面边缘热区控制条（第 26 轮 E、第 94 轮 E）。</summary>
    public bool EdgeBarEnabled { get; set; } = true;

    public int EdgeBarDelayMs { get; set; } = 400;

    // ── 性能与解码 ──────────────────────────────────────────────────────

    internal static readonly int[] FrameRateLimits = { 0, 15, 24, 30, 60, 144 };

    internal static readonly int[] RenderScales = { 100, 75, 50 };

    internal static readonly int[] DownsampleThresholds = { 0, 1080, 1440, 2160 };

    internal static readonly int[] IdleFpsOptions = { 10, 15, 24 };

    public const string ReduceMotionSystem = "system";
    public const string ReduceMotionAlways = "always";
    public const string ReduceMotionNever = "never";

    internal static readonly string[] ReduceMotionModes = { ReduceMotionSystem, ReduceMotionAlways, ReduceMotionNever };

    /// <summary>0 = 不限帧率（第 59 轮 A，默认 60）。</summary>
    public int FrameRateLimit { get; set; } = 60;

    public int RenderScale { get; set; } = 100;

    public bool HardwareDecode { get; set; } = true;

    /// <summary>超过该高度就降采样，0 = 不降（第 59 轮，默认 1440）。</summary>
    public int DownsampleAbove { get; set; } = 1440;

    /// <summary>并发解码路数：0 = 按 GPU 自动探测，-1 = 不限（第 70 轮）。</summary>
    public int ConcurrentDecode { get; set; }

    public bool PauseOnMinimize { get; set; } = true;

    /// <summary>无操作多少秒后降到 <see cref="IdleFps"/>。</summary>
    public int IdleFpsAfterSec { get; set; } = 60;

    public int IdleFps { get; set; } = 15;

    public bool PauseOnBattery { get; set; } = true;

    /// <summary>全屏应用时停播，退出全屏续播（第 28 轮 C）。</summary>
    public bool PauseOnFullscreen { get; set; } = true;

    /// <summary>按实测耗时动态升降（第 5 轮）。</summary>
    public bool AdaptiveQuality { get; set; } = true;

    /// <summary>system / always / never，默认跟随系统「减少动画」（第 88 轮 A）。</summary>
    public string ReduceMotion { get; set; } = ReduceMotionSystem;

    // ── 视觉效果 ────────────────────────────────────────────────────────

    public const string DimAuto = "auto";
    public const string DimFixed = "fixed";
    public const string DimOff = "off";

    internal static readonly string[] DimModes = { DimAuto, DimFixed, DimOff };

    public const string FitSmart = "smart";
    public const string FitCover = "cover";
    public const string FitContain = "contain";
    public const string FitFill = "fill";
    public const string FitStretch = "stretch";

    internal static readonly string[] FitModes = { FitSmart, FitCover, FitContain, FitFill, FitStretch };

    /// <summary>主题明暗切换时自动套用对应预设（第 84 轮 A）。</summary>
    public bool AppearanceLink { get; set; }

    /// <summary>切壁纸卡在节拍上（第 78 轮 C）：有音乐播放时把切换推迟到下一个 onset。</summary>
    public bool BeatLock { get; set; }

    public double Parallax { get; set; } = 0.30;

    /// <summary>时钟/文字叠层（第 23 轮 D，主要给桌面层）。</summary>
    public bool OverlayEnabled { get; set; }

    public string OverlayTemplate { get; set; } = "{time}";

    /// <summary>auto = 按帧亮度自适应，fixed = 用 <see cref="DimBase"/>，off = 不压暗（第 53 轮 B）。</summary>
    public string DimMode { get; set; } = DimAuto;

    public double DimBase { get; set; } = 0.20;

    public double DimMax { get; set; } = 0.40;

    public int DimEmaMs { get; set; } = 800;

    /// <summary>-100..100，0 = 原样。</summary>
    public int Brightness { get; set; }

    public int Contrast { get; set; }

    public int Saturation { get; set; }

    /// <summary>0–50 像素级模糊。</summary>
    public int Blur { get; set; }

    /// <summary>从当前帧取主色驱动强调色（第 8 轮、第 82 轮 D）。</summary>
    public bool AccentFromFrame { get; set; } = true;

    /// <summary>smart 按宽高比自动 cover/contain（第 52 轮 D）。</summary>
    public string FitMode { get; set; } = FitSmart;

    // ── 音频联动 ────────────────────────────────────────────────────────

    public const string VisualizerSpectrum = "spectrum";
    public const string VisualizerWave = "wave";
    public const string VisualizerRing = "ring";
    public const string VisualizerParticles = "particles";

    internal static readonly string[] VisualizerStyles =
        { VisualizerSpectrum, VisualizerWave, VisualizerRing, VisualizerParticles };

    public bool VisualizerEnabled { get; set; } = true;

    public string VisualizerStyle { get; set; } = VisualizerSpectrum;

    /// <summary>节拍驱动强度 0–100（第 78 轮 C）。</summary>
    public int BeatStrength { get; set; } = 50;

    // ── 库与素材 ────────────────────────────────────────────────────────

    public const string GridCompact = "compact";
    public const string GridStandard = "standard";
    public const string GridLarge = "large";

    internal static readonly string[] GridDensities = { GridCompact, GridStandard, GridLarge };

    internal static readonly int[] ThumbConcurrencyOptions = { 1, 2, 3, 4 };

    public string GridDensity { get; set; } = GridStandard;

    /// <summary>缩略图抽帧并发，默认 2（第 61 轮）。</summary>
    public int ThumbConcurrency { get; set; } = 2;

    /// <summary>监视的本地目录（第 2 轮 B 的目录监控）。</summary>
    public List<string> WatchFolders { get; set; } = new();

    // ── 诊断与日志 ──────────────────────────────────────────────────────

    internal static readonly int[] CacheKeepDaysOptions = { 7, 30, 90, 0 };

    /// <summary>缩略图/缓存保留天数，0 = 永久（第 87 轮 D）。</summary>
    public int CacheKeepDays { get; set; } = 30;

    /// <summary>诊断面板默认收起（规格书第 10 章建议值）。</summary>
    public bool DiagnosticsOpen { get; set; }

    /// <summary>给 UI/宿主读的副本，避免调用方持有可变状态。</summary>
    public WallpaperSettings Clone() => new()
    {
        Enabled = Enabled,
        InAppEnabled = InAppEnabled,
        AudioEnabled = AudioEnabled,
        AudioVolume = AudioVolume,
        AudioFollowSystem = AudioFollowSystem,
        MusicDuckMs = MusicDuckMs,
        MusicRestoreMs = MusicRestoreMs,
        OccludeThreshold = OccludeThreshold,
        CloseToTray = CloseToTray,
        AutoLaunch = AutoLaunch,
        PageNormal = PageNormal,
        PageImmersive = PageImmersive,
        PageRoom = PageRoom,
        PageLogin = PageLogin,
        TransitionMode = TransitionMode,
        TransitionId = TransitionId,
        TransitionMs = TransitionMs,
        TransitionExclude = new List<string>(TransitionExclude),
        RotationEnabled = RotationEnabled,
        RotationMinutes = RotationMinutes,
        RotationOrder = RotationOrder,
        RotationFavoriteFirst = RotationFavoriteFirst,
        Prewarm = Prewarm,
        DesktopEnabled = DesktopEnabled,
        DesktopAttached = DesktopAttached,
        DesktopSound = DesktopSound,
        EdgeBarEnabled = EdgeBarEnabled,
        EdgeBarDelayMs = EdgeBarDelayMs,
        FrameRateLimit = FrameRateLimit,
        RenderScale = RenderScale,
        HardwareDecode = HardwareDecode,
        DownsampleAbove = DownsampleAbove,
        ConcurrentDecode = ConcurrentDecode,
        PauseOnMinimize = PauseOnMinimize,
        IdleFpsAfterSec = IdleFpsAfterSec,
        IdleFps = IdleFps,
        PauseOnBattery = PauseOnBattery,
        PauseOnFullscreen = PauseOnFullscreen,
        AdaptiveQuality = AdaptiveQuality,
        ReduceMotion = ReduceMotion,
        AppearanceLink = AppearanceLink,
        BeatLock = BeatLock,
        Parallax = Parallax,
        OverlayEnabled = OverlayEnabled,
        OverlayTemplate = OverlayTemplate,
        DimMode = DimMode,
        DimBase = DimBase,
        DimMax = DimMax,
        DimEmaMs = DimEmaMs,
        Brightness = Brightness,
        Contrast = Contrast,
        Saturation = Saturation,
        Blur = Blur,
        AccentFromFrame = AccentFromFrame,
        FitMode = FitMode,
        VisualizerEnabled = VisualizerEnabled,
        VisualizerStyle = VisualizerStyle,
        BeatStrength = BeatStrength,
        GridDensity = GridDensity,
        ThumbConcurrency = ThumbConcurrency,
        WatchFolders = new List<string>(WatchFolders),
        CacheKeepDays = CacheKeepDays,
        DiagnosticsOpen = DiagnosticsOpen,
    };
}
