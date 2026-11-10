using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Zilux2.Settings;

// Contract docs/zilux2-settings-contract.md: host owns persistence, the page only sends patches.
internal sealed class SettingsService : IDisposable
{
    internal const int CurrentVersion = 1;
    internal const string PathOverrideEnvironmentVariable = "ZILUX2_SETTINGS_PATH";

    private const int SaveDebounceMilliseconds = 300;

    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);
    private static readonly JsonSerializerOptions FileJsonOptions = new() { WriteIndented = true };

    private static readonly string[] KnownTopLevelKeys = { "version", "general", "appearance", "playback", "downloads", "updates", "shortcuts" };

    /// <summary>快捷键字符串的最大长度；超长按非法值回落，避免把垃圾写进 settings.json。</summary>
    private const int MaxShortcutChars = 64;

    /// <summary>音频设备 ID 的最大长度（WASAPI 端点 ID 约 100 字符，浏览器 deviceId 更长）。</summary>
    private const int MaxDeviceIdChars = 512;

    private readonly object _gate = new();
    private readonly string _path;
    private readonly System.Threading.Timer _saveTimer;
    private SettingsModel _state;
    private JsonObject? _loadedDocument;
    private bool _dirty;
    private bool _loadFailed;
    private int _saveFailures;
    private bool _disposed;

    internal SettingsService(string? pathOverride = null)
    {
        _path = Path.GetFullPath(string.IsNullOrWhiteSpace(pathOverride) ? ResolveDefaultPath() : pathOverride.Trim());
        _state = Load(out _loadedDocument);
        _saveTimer = new System.Threading.Timer(_ => OnSaveTimer(), null, Timeout.Infinite, Timeout.Infinite);
        HostLog.Info($"[settings] ready path={_path}");
    }

    internal string SettingsPath => _path;

    internal bool StartMaximized
    {
        get
        {
            lock (_gate)
            {
                return _state.General.StartMaximized;
            }
        }
    }

    /// <summary>开机自启：是否把本程序注册进 HKCU\...\Run（由 App 启动时幂等 apply）。</summary>
    internal bool AutoLaunch
    {
        get
        {
            lock (_gate)
            {
                return _state.General.AutoLaunch;
            }
        }
    }

    /// <summary>开机自启时是否隐藏主界面（决定 Run 项命令行是否带 --hidden）。</summary>
    internal bool AutoStartHidden
    {
        get
        {
            lock (_gate)
            {
                return _state.General.AutoStartHidden;
            }
        }
    }

    /// <summary>本地曲库目录自动监控开关（LocalMusicService.Watch 的启停依据）。</summary>
    internal bool WatchLocalFolder
    {
        get
        {
            lock (_gate)
            {
                return _state.General.WatchLocalFolder;
            }
        }
    }

    /// <summary>Windows 系统媒体控制开关（关掉后不再向任务栏/音量弹窗暴露 Now Playing）。</summary>
    internal bool MediaSessionEnabled
    {
        get
        {
            lock (_gate)
            {
                return _state.General.MediaSession;
            }
        }
    }

    /// <summary>桌面歌词窗口的显示状态与样式（窗口由 MainWindow 懒创建）。</summary>
    internal (bool Enabled, bool Locked, int FontSize, bool Topmost, string Weight, int BackdropOpacity) DesktopLyricsOptions
    {
        get
        {
            lock (_gate)
            {
                var general = _state.General;
                return (general.DesktopLyrics, general.DesktopLyricsLocked, general.DesktopLyricsFontSize, general.DesktopLyricsTopmost, general.DesktopLyricsWeight, general.DesktopLyricsBackdropOpacity);
            }
        }
    }

    /// <summary>桌面歌词上次关闭位置；坐标不完整或没有记录时返回 null。</summary>
    internal (double Left, double Top)? DesktopLyricsPosition
    {
        get
        {
            lock (_gate)
            {
                var general = _state.General;
                if (general.DesktopLyricsLeft is double left && general.DesktopLyricsTop is double top)
                {
                    return (left, top);
                }

                return null;
            }
        }
    }

    /// <summary>桌面背景歌词开关（背景窗口由 MainWindow 懒创建）。</summary>
    internal bool BackgroundLyricsEnabled
    {
        get
        {
            lock (_gate)
            {
                return _state.General.BackgroundLyrics;
            }
        }
    }

    /// <summary>「切换系统输出」快捷键参与轮换的设备 ID（空数组 = 全部活动播放设备）。</summary>
    internal string[] SystemOutputRotation
    {
        get
        {
            lock (_gate)
            {
                return (string[])_state.General.SystemOutputRotation.Clone();
            }
        }
    }

    // Read by the audio feature service on its capture thread, so it must stay cheap and locked.
    internal bool AudioReactive
    {
        get
        {
            lock (_gate)
            {
                return _state.Playback.AudioReactive;
            }
        }
    }

    internal string WindowAnimation
    {
        get
        {
            lock (_gate)
            {
                return _state.Appearance.WindowAnimation;
            }
        }
    }

    /// <summary>迷你播放器尺寸预设（compact/standard/wide）。</summary>
    internal string MiniSize
    {
        get
        {
            lock (_gate)
            {
                return _state.Appearance.MiniSize;
            }
        }
    }

    /// <summary>迷你播放器是否置顶。</summary>
    internal bool MiniAlwaysOnTop
    {
        get
        {
            lock (_gate)
            {
                return _state.Appearance.MiniAlwaysOnTop;
            }
        }
    }

    /// <summary>下载目录（空字符串表示用 Windows 音乐目录）。</summary>
    internal string DownloadDirectory
    {
        get
        {
            lock (_gate)
            {
                return _state.Downloads.Directory;
            }
        }
    }

    /// <summary>下载音质（standard/high/lossless）。</summary>
    internal string DownloadQuality
    {
        get
        {
            lock (_gate)
            {
                return _state.Downloads.Quality;
            }
        }
    }

    /// <summary>同时下载的任务数（1–4）。</summary>
    internal int DownloadMaxConcurrent
    {
        get
        {
            lock (_gate)
            {
                return _state.Downloads.MaxConcurrent;
            }
        }
    }

    /// <summary>下载文件名模板。</summary>
    internal string DownloadFileNameTemplate
    {
        get
        {
            lock (_gate)
            {
                return _state.Downloads.FileNameTemplate;
            }
        }
    }

    /// <summary>下载完成后自动打开所在文件夹。</summary>
    internal bool DownloadOpenFolderWhenDone
    {
        get
        {
            lock (_gate)
            {
                return _state.Downloads.OpenFolderWhenDone;
            }
        }
    }

    /// <summary>启动后是否自动检查更新。</summary>
    internal bool UpdateAutoCheck
    {
        get
        {
            lock (_gate)
            {
                return _state.Updates.AutoCheck;
            }
        }
    }

    /// <summary>更新方式：auto=应用内更新，notify=仅提示。</summary>
    internal string UpdateMode
    {
        get
        {
            lock (_gate)
            {
                return _state.Updates.Mode;
            }
        }
    }

    /// <summary>更新检查/下载是否直连 GitHub（绕过系统代理）。</summary>
    internal bool UpdateDirectConnection
    {
        get
        {
            lock (_gate)
            {
                return _state.Updates.DirectConnection;
            }
        }
    }

    /// <summary>设置里覆盖的 GitHub 仓库；空字符串表示使用程序集内烘焙的仓库。</summary>
    internal string UpdateRepoOverride
    {
        get
        {
            lock (_gate)
            {
                return _state.Updates.Repo;
            }
        }
    }

    /// <summary>快捷键配置的完整副本（UI 线程应用热键时读取，见 MainWindow.ApplyShortcutSettings）。</summary>
    internal ShortcutSettings ShortcutsSnapshot
    {
        get
        {
            lock (_gate)
            {
                return _state.Shortcuts.Clone();
            }
        }
    }

    /// <summary>
    /// <c>shortcuts</c> 段被 patch/reset 后触发（其它设置的变化不触发，避免拖动音量等操作反复
    /// 注销/注册全局热键）。回调可能来自 UI 线程；MainWindow 负责再切一次 Dispatcher。
    /// </summary>
    internal event Action? ShortcutsChanged;

    /// <summary>
    /// <c>general</c> 段被 patch/reset 后触发（开机自启 / 本地目录监控这类需要宿主立即生效的
    /// 设置）。其它段的变化不触发；回调和 <see cref="ShortcutsChanged"/> 一样在锁外、可能在 UI 线程。
    /// </summary>
    internal event Action? GeneralChanged;

    internal static string ResolveDefaultPath()
    {
        var overridePath = Environment.GetEnvironmentVariable(PathOverrideEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(overridePath))
        {
            return overridePath.Trim();
        }

        return Path.Combine(HostFolders.Root, "settings.json");
    }

    // Full snapshot pushed to the page (contract section 3.2). Serialized under the lock so a
    // concurrent patch can never hand out a half-updated state.
    internal string CreateSnapshotJson()
    {
        lock (_gate)
        {
            var message = new HostSettingsMessage { State = _state };
            return JsonSerializer.Serialize(message, SettingsJsonContext.Default.HostSettingsMessage);
        }
    }

    internal void Patch(JsonElement patch)
    {
        if (patch.ValueKind != JsonValueKind.Object)
        {
            HostLog.Warn("[settings] patch ignored (not an object)");
            return;
        }

        var shortcutsChanged = false;
        var generalChanged = false;
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            var keys = ApplyKnownValues(patch, _state);
            if (keys.Count == 0)
            {
                HostLog.Warn("[settings] patch ignored (no known keys)");
                return;
            }

            // 两套桌面歌词互斥：同时开启会创建两个歌词窗口并重复渲染。
            // 以本次 patch 显式打开的那个为准；同一包同时打开时背景歌词优先。
            var wantsBackgroundLyrics =
                keys.Contains("general.backgroundLyrics") && _state.General.BackgroundLyrics;
            var wantsDesktopLyrics =
                keys.Contains("general.desktopLyrics") && _state.General.DesktopLyrics;
            if (wantsBackgroundLyrics && _state.General.DesktopLyrics)
            {
                _state.General.DesktopLyrics = false;
                keys.Add("general.desktopLyrics");
                HostLog.Warn("[settings] desktopLyrics disabled because backgroundLyrics was enabled");
            }
            else if (wantsDesktopLyrics && _state.General.BackgroundLyrics)
            {
                _state.General.BackgroundLyrics = false;
                keys.Add("general.backgroundLyrics");
                HostLog.Warn("[settings] backgroundLyrics disabled because desktopLyrics was enabled");
            }

            HostLog.Info($"[settings] patch keys={string.Join(",", keys)}");
            MarkDirtyLocked();
            shortcutsChanged = keys.Exists(key => key.StartsWith("shortcuts.", StringComparison.Ordinal));
            generalChanged = keys.Exists(key => key.StartsWith("general.", StringComparison.Ordinal));
        }

        // 回调放到锁外：监听方（MainWindow）会回头读 ShortcutsSnapshot 并注销/注册热键，
        // 在锁内通知会让保存定时器的线程与 UI 线程互相等待。
        if (shortcutsChanged)
        {
            RaiseShortcutsChanged();
        }

        if (generalChanged)
        {
            RaiseGeneralChanged();
        }
    }

    internal void Reset()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _state = SettingsModel.CreateDefaults();
            // 保留 _loadedDocument，让 MergeUnknownKeys 继续写回未知顶层/内层键（契约 §2）。
            HostLog.Info("[settings] reset");
            MarkDirtyLocked();
        }

        // reset 一定会把 shortcuts 段恢复成默认值，所以无条件通知重新注册。
        RaiseShortcutsChanged();
        // general 段同理：开机自启 / 目录监控恢复到默认值。
        RaiseGeneralChanged();
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
        }

        _saveTimer.Dispose();
        lock (_gate)
        {
            if (!_dirty)
            {
                return;
            }

            // Contract section 1: pending changes are flushed before the process exits.
            SaveLocked();
        }

        HostLog.Info("[settings] disposed");
    }

    private void RaiseShortcutsChanged()
    {
        var handler = ShortcutsChanged;
        if (handler is null)
        {
            return;
        }

        try
        {
            handler();
        }
        catch (Exception exception)
        {
            // 热键重注册失败不能影响设置保存/页面 ACK，只记日志。
            HostLog.Error("[settings] shortcuts changed handler failed", exception);
        }
    }

    private void RaiseGeneralChanged()
    {
        var handler = GeneralChanged;
        if (handler is null)
        {
            return;
        }

        try
        {
            handler();
        }
        catch (Exception exception)
        {
            // 开机自启 / 目录监控的即时应用失败也只记日志，不影响设置保存与页面 ACK。
            HostLog.Error("[settings] general changed handler failed", exception);
        }
    }

    private void MarkDirtyLocked()
    {
        _dirty = true;
        _saveTimer.Change(SaveDebounceMilliseconds, Timeout.Infinite);
    }

    private void OnSaveTimer()
    {
        try
        {
            lock (_gate)
            {
                if (_disposed || !_dirty)
                {
                    return;
                }

                SaveLocked();
            }
        }
        catch (Exception exception)
        {
            HostLog.Error("[settings] save failed", exception);
        }
    }

    private void SaveLocked()
    {
        // 读取原文件失败且无法留副本时，宁可本次不保存，也不能用默认值覆盖用户文件（P1-01）。
        if (_loadFailed && !TryPreserveUnreadableSettings())
        {
            HostLog.Warn("[settings] save skipped: settings file was unreadable and no backup could be made");
            return;
        }

        _loadFailed = false;
        try
        {
            var document = JsonSerializer.SerializeToNode(_state, SettingsJsonContext.Default.SettingsModel)?.AsObject();
            if (document is null)
            {
                HostLog.Error("[settings] save failed: could not serialize state");
                return;
            }

            MergeUnknownKeys(document);

            var directory = Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            // Contract section 1: temp file + replace so a crash never leaves half-written JSON.
            var tempPath = _path + ".tmp";
            File.WriteAllText(tempPath, document.ToJsonString(FileJsonOptions), Utf8NoBom);
            if (File.Exists(_path))
            {
                File.Replace(tempPath, _path, destinationBackupFileName: null);
            }
            else
            {
                File.Move(tempPath, _path);
            }

            _dirty = false;
            _saveFailures = 0;
            HostLog.Info("[settings] save ok");
        }
        catch (Exception exception)
        {
            HostLog.Error("[settings] save failed", exception);
            TryDeleteTempFile();
            _saveFailures++;
            if (!_disposed && _saveFailures <= 3)
            {
                _dirty = true;
                _saveTimer.Change(2000 * _saveFailures, Timeout.Infinite);
                HostLog.Warn($"[settings] save retry scheduled attempt={_saveFailures}");
            }
        }
    }

    // Contract section 2: keys the host does not understand survive a save round-trip untouched.
    private void MergeUnknownKeys(JsonObject target)
    {
        if (_loadedDocument is null)
        {
            return;
        }

        foreach (var pair in _loadedDocument)
        {
            if (!KnownTopLevelKeys.Contains(pair.Key, StringComparer.Ordinal))
            {
                target[pair.Key] = pair.Value?.DeepClone();
                continue;
            }

            if (pair.Value is not JsonObject loadedSection || target[pair.Key] is not JsonObject savedSection)
            {
                continue;
            }

            foreach (var inner in loadedSection)
            {
                if (!IsKnownField(pair.Key, inner.Key))
                {
                    savedSection[inner.Key] = inner.Value?.DeepClone();
                }
            }
        }
    }

    private static bool IsKnownField(string section, string name) => section switch
    {
        "general" => name is "splash" or "splashTitle" or "splashSubtitle" or "startMaximized" or "autoLaunch" or "autoStartHidden" or "watchLocalFolder"
            or "mediaSession" or "desktopLyrics" or "desktopLyricsLocked" or "desktopLyricsFontSize" or "desktopLyricsTopmost"
            or "desktopLyricsWeight" or "desktopLyricsBackdropOpacity" or "backgroundLyrics"
            or "desktopLyricsLeft" or "desktopLyricsTop" or "systemOutputRotation",
        "appearance" => name is "theme" or "reduceMotion" or "glow" or "lyricsSize"
            or "windowAnimation" or "playerBarExpanded" or "miniSize" or "miniAlwaysOnTop",
        "playback" => name is "defaultSource" or "searchLimit" or "volume" or "audioReactive" or "quality"
            or "eqEnabled" or "eqPreset" or "eqGains" or "fadeEnabled" or "fadeMs"
            or "fadeOutMs" or "fadeInMs" or "fadeCurve" or "fadeVocal" or "fadeVocalTailMs"
            or "sleepFadeSeconds" or "sleepAction" or "appOutputMode" or "appOutputDeviceId",
        "downloads" => name is "directory" or "quality" or "maxConcurrent" or "fileNameTemplate" or "openFolderWhenDone",
        "updates" => name is "autoCheck" or "mode" or "repo" or "directConnection",
        "shortcuts" => name is "enabled" or "alwaysHandleMediaKeys" or "playPause" or "prev" or "next" or "toggleWindow"
            or "volumeUp" or "volumeDown" or "mute" or "like" or "mode" or "mini" or "desktopLyrics" or "crossfade"
            or "appOutput" or "systemOutput",
        _ => false,
    };

    private SettingsModel Load(out JsonObject? loadedDocument)
    {
        loadedDocument = null;
        var defaults = SettingsModel.CreateDefaults();

        if (!File.Exists(_path))
        {
            HostLog.Info($"[settings] load path={_path} defaults (file missing)");
            return defaults;
        }

        string text;
        try
        {
            text = File.ReadAllText(_path, Encoding.UTF8);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[settings] load failed path={_path} err={exception.GetType().Name}: {exception.Message}");
            // 读失败不等于文件损坏：先尽量留一份副本；副本也失败时整个会话拒绝覆盖原文件（P1-01）。
            _loadFailed = !TryPreserveUnreadableSettings();
            return defaults;
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(text);
        }
        catch (JsonException exception)
        {
            HostLog.Warn($"[settings] load failed path={_path} err=invalid json: {exception.Message}");
            BackupCorruptFile("invalid json");
            return defaults;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                HostLog.Warn($"[settings] load failed path={_path} err=root is not an object");
                BackupCorruptFile("root is not an object");
                return defaults;
            }

            if (!root.TryGetProperty("version", out var versionElement) ||
                versionElement.ValueKind != JsonValueKind.Number ||
                !versionElement.TryGetInt32(out var version) ||
                version != CurrentVersion)
            {
                HostLog.Warn($"[settings] load failed path={_path} err=unrecognized version");
                BackupCorruptFile("unrecognized version");
                return defaults;
            }

            ApplyKnownValues(root, defaults);
            EnforceLyricsExclusivity(defaults);
            loadedDocument = JsonNode.Parse(text) as JsonObject;
            HostLog.Info($"[settings] load path={_path} version={version}");
            return defaults;
        }
    }

    // Applies every known key that is present. Missing keys keep the current value; invalid
    // values also keep the current value (contract sections 1 and 2) - never throws.
    // Used both for loading a full document and for partial patches, so each fallback must be
    // the current state value instead of a hard-coded default.
    private static List<string> ApplyKnownValues(JsonElement document, SettingsModel state)
    {
        var keys = new List<string>();

        if (TryGetObject(document, "general", out var general))
        {
            state.General.Splash = ReadBool(general, "splash", state.General.Splash, "general.splash", keys);
            state.General.SplashTitle = ReadSplashText(
                general, "splashTitle", state.General.SplashTitle, "general.splashTitle", keys);
            state.General.SplashSubtitle = ReadSplashText(
                general, "splashSubtitle", state.General.SplashSubtitle, "general.splashSubtitle", keys);
            state.General.StartMaximized = ReadBool(general, "startMaximized", state.General.StartMaximized, "general.startMaximized", keys);
            state.General.AutoLaunch = ReadBool(general, "autoLaunch", state.General.AutoLaunch, "general.autoLaunch", keys);
            state.General.AutoStartHidden = ReadBool(
                general, "autoStartHidden", state.General.AutoStartHidden, "general.autoStartHidden", keys);
            state.General.WatchLocalFolder = ReadBool(
                general, "watchLocalFolder", state.General.WatchLocalFolder, "general.watchLocalFolder", keys);
            state.General.MediaSession = ReadBool(
                general, "mediaSession", state.General.MediaSession, "general.mediaSession", keys);
            state.General.DesktopLyrics = ReadBool(
                general, "desktopLyrics", state.General.DesktopLyrics, "general.desktopLyrics", keys);
            state.General.DesktopLyricsLocked = ReadBool(
                general, "desktopLyricsLocked", state.General.DesktopLyricsLocked, "general.desktopLyricsLocked", keys);
            state.General.DesktopLyricsFontSize = ReadIntInRange(
                general, "desktopLyricsFontSize", 28, 64,
                state.General.DesktopLyricsFontSize, "general.desktopLyricsFontSize", keys);
            state.General.DesktopLyricsTopmost = ReadBool(
                general, "desktopLyricsTopmost", state.General.DesktopLyricsTopmost, "general.desktopLyricsTopmost", keys);
            state.General.DesktopLyricsWeight = ReadEnum(
                general, "desktopLyricsWeight", GeneralSettings.DesktopLyricsWeights,
                state.General.DesktopLyricsWeight, "general.desktopLyricsWeight", keys);
            state.General.DesktopLyricsBackdropOpacity = ReadIntInRange(
                general, "desktopLyricsBackdropOpacity", 30, 90,
                state.General.DesktopLyricsBackdropOpacity, "general.desktopLyricsBackdropOpacity", keys);
            state.General.BackgroundLyrics = ReadBool(
                general, "backgroundLyrics", state.General.BackgroundLyrics, "general.backgroundLyrics", keys);
            state.General.DesktopLyricsLeft = ReadCoordinate(
                general, "desktopLyricsLeft", state.General.DesktopLyricsLeft, "general.desktopLyricsLeft", keys);
            state.General.DesktopLyricsTop = ReadCoordinate(
                general, "desktopLyricsTop", state.General.DesktopLyricsTop, "general.desktopLyricsTop", keys);
            state.General.SystemOutputRotation = ReadStringArray(
                general, "systemOutputRotation", 32, 256,
                state.General.SystemOutputRotation, "general.systemOutputRotation", keys);
        }

        if (TryGetObject(document, "appearance", out var appearance))
        {
            state.Appearance.Theme = ReadEnum(
                appearance, "theme", AppearanceSettings.Themes, state.Appearance.Theme, "appearance.theme", keys);
            state.Appearance.ReduceMotion = ReadBool(appearance, "reduceMotion", state.Appearance.ReduceMotion, "appearance.reduceMotion", keys);
            state.Appearance.Glow = ReadBool(appearance, "glow", state.Appearance.Glow, "appearance.glow", keys);
            state.Appearance.LyricsSize = ReadEnum(
                appearance, "lyricsSize", AppearanceSettings.LyricsSizes, state.Appearance.LyricsSize, "appearance.lyricsSize", keys);
            state.Appearance.WindowAnimation = ReadEnum(
                appearance, "windowAnimation",
                AppearanceSettings.WindowAnimations,
                state.Appearance.WindowAnimation,
                "appearance.windowAnimation",
                keys);
            state.Appearance.PlayerBarExpanded = ReadBool(
                appearance, "playerBarExpanded", state.Appearance.PlayerBarExpanded, "appearance.playerBarExpanded", keys);
            state.Appearance.MiniSize = ReadEnum(
                appearance, "miniSize", AppearanceSettings.MiniSizes, state.Appearance.MiniSize, "appearance.miniSize", keys);
            state.Appearance.MiniAlwaysOnTop = ReadBool(
                appearance, "miniAlwaysOnTop", state.Appearance.MiniAlwaysOnTop, "appearance.miniAlwaysOnTop", keys);
        }

        if (TryGetObject(document, "playback", out var playback))
        {
            state.Playback.DefaultSource = ReadEnum(
                playback, "defaultSource", PlaybackSettings.Sources, state.Playback.DefaultSource, "playback.defaultSource", keys);
            state.Playback.SearchLimit = ReadAllowedInt(
                playback, "searchLimit", PlaybackSettings.SearchLimits, state.Playback.SearchLimit, "playback.searchLimit", keys);
            state.Playback.Volume = ReadVolume(playback, "volume", state.Playback.Volume, "playback.volume", keys);
            state.Playback.AudioReactive = ReadBool(playback, "audioReactive", state.Playback.AudioReactive, "playback.audioReactive", keys);
            state.Playback.Quality = ReadEnum(
                playback, "quality", DownloadSettings.Qualities, state.Playback.Quality, "playback.quality", keys);
            if (playback.TryGetProperty("eqEnabled", out _))
            {
                state.Playback.EqEnabled = ReadBool(playback, "eqEnabled", state.Playback.EqEnabled, "playback.eqEnabled", keys);
            }

            if (playback.TryGetProperty("eqPreset", out _))
            {
                state.Playback.EqPreset = ReadEnum(
                    playback, "eqPreset", PlaybackSettings.EqPresets, state.Playback.EqPreset, "playback.eqPreset", keys);
            }

            if (playback.TryGetProperty("eqGains", out _))
            {
                state.Playback.EqGains = ReadIntArray(
                    playback, "eqGains", PlaybackSettings.EqBandCount, -12, 12,
                    state.Playback.EqGains, "playback.eqGains", keys);
            }

            state.Playback.FadeEnabled = ReadBool(playback, "fadeEnabled", state.Playback.FadeEnabled, "playback.fadeEnabled", keys);

            // 旧版只有一个 fadeMs：加载旧配置时把它作为淡出/淡入的缺省值，实现平滑迁移。
            var legacyFadeMs = state.Playback.FadeMs;
            var hasLegacyFadeMs = playback.TryGetProperty("fadeMs", out _);
            if (hasLegacyFadeMs)
            {
                legacyFadeMs = ReadIntInRange(playback, "fadeMs", 50, 3000, state.Playback.FadeMs, "playback.fadeMs", keys);
                state.Playback.FadeMs = legacyFadeMs;
            }

            state.Playback.FadeOutMs = playback.TryGetProperty("fadeOutMs", out _)
                ? ReadIntInRange(playback, "fadeOutMs", 100, 3000, state.Playback.FadeOutMs, "playback.fadeOutMs", keys)
                : (hasLegacyFadeMs ? legacyFadeMs : state.Playback.FadeOutMs);
            state.Playback.FadeInMs = playback.TryGetProperty("fadeInMs", out _)
                ? ReadIntInRange(playback, "fadeInMs", 100, 3000, state.Playback.FadeInMs, "playback.fadeInMs", keys)
                : (hasLegacyFadeMs ? legacyFadeMs : state.Playback.FadeInMs);
            state.Playback.FadeCurve = ReadEnum(
                playback, "fadeCurve", PlaybackSettings.FadeCurves, state.Playback.FadeCurve, "playback.fadeCurve", keys);
            state.Playback.FadeVocal = ReadBool(playback, "fadeVocal", state.Playback.FadeVocal, "playback.fadeVocal", keys);
            state.Playback.FadeVocalTailMs = ReadIntInRange(
                playback, "fadeVocalTailMs", 0, 3000, state.Playback.FadeVocalTailMs, "playback.fadeVocalTailMs", keys);
            state.Playback.SleepFadeSeconds = ReadIntInRange(
                playback, "sleepFadeSeconds", 0, 60, state.Playback.SleepFadeSeconds, "playback.sleepFadeSeconds", keys);
            state.Playback.SleepAction = ReadEnum(
                playback, "sleepAction", PlaybackSettings.SleepActions, state.Playback.SleepAction, "playback.sleepAction", keys);
            state.Playback.AppOutputMode = ReadEnum(
                playback, "appOutputMode", PlaybackSettings.AppOutputModes,
                state.Playback.AppOutputMode, "playback.appOutputMode", keys);
            state.Playback.AppOutputDeviceId = ReadDeviceId(
                playback, "appOutputDeviceId", state.Playback.AppOutputDeviceId, "playback.appOutputDeviceId", keys);
        }

        if (TryGetObject(document, "downloads", out var downloads))
        {
            if (downloads.TryGetProperty("directory", out _))
            {
                state.Downloads.Directory = ReadDirectory(
                    downloads, "directory", state.Downloads.Directory, "downloads.directory", keys);
            }

            state.Downloads.Quality = ReadEnum(
                downloads, "quality", DownloadSettings.Qualities, state.Downloads.Quality, "downloads.quality", keys);
            state.Downloads.MaxConcurrent = ReadIntInRange(
                downloads, "maxConcurrent", 1, 4, state.Downloads.MaxConcurrent, "downloads.maxConcurrent", keys);
            state.Downloads.FileNameTemplate = ReadTemplate(
                downloads, "fileNameTemplate", 120, state.Downloads.FileNameTemplate, "downloads.fileNameTemplate", keys);
            state.Downloads.OpenFolderWhenDone = ReadBool(
                downloads, "openFolderWhenDone", state.Downloads.OpenFolderWhenDone, "downloads.openFolderWhenDone", keys);
        }

        if (TryGetObject(document, "updates", out var updates))
        {
            state.Updates.AutoCheck = ReadBool(updates, "autoCheck", state.Updates.AutoCheck, "updates.autoCheck", keys);
            state.Updates.Mode = ReadEnum(
                updates, "mode", UpdateSettings.Modes, state.Updates.Mode, "updates.mode", keys);
            state.Updates.DirectConnection = ReadBool(
                updates, "directConnection", state.Updates.DirectConnection, "updates.directConnection", keys);
            if (updates.TryGetProperty("repo", out _))
            {
                state.Updates.Repo = ReadRepo(updates, "repo", state.Updates.Repo, "updates.repo", keys);
            }
        }

        // 快捷键字符串只做「类型 + 长度」校验后原样保存：语法解析在 MainWindow 注册热键时进行，
        // 非法组合由宿主保留上一次可用注册（见 MainWindow.ApplyShortcutSettings）。
        if (TryGetObject(document, "shortcuts", out var shortcuts))
        {
            state.Shortcuts.Enabled = ReadBool(shortcuts, "enabled", state.Shortcuts.Enabled, "shortcuts.enabled", keys);
            state.Shortcuts.AlwaysHandleMediaKeys = ReadBool(
                shortcuts,
                "alwaysHandleMediaKeys",
                state.Shortcuts.AlwaysHandleMediaKeys,
                "shortcuts.alwaysHandleMediaKeys",
                keys);
            state.Shortcuts.PlayPause = ReadShortcut(shortcuts, "playPause", state.Shortcuts.PlayPause, "shortcuts.playPause", keys);
            state.Shortcuts.Prev = ReadShortcut(shortcuts, "prev", state.Shortcuts.Prev, "shortcuts.prev", keys);
            state.Shortcuts.Next = ReadShortcut(shortcuts, "next", state.Shortcuts.Next, "shortcuts.next", keys);
            state.Shortcuts.ToggleWindow = ReadShortcut(
                shortcuts, "toggleWindow", state.Shortcuts.ToggleWindow, "shortcuts.toggleWindow", keys);
            state.Shortcuts.VolumeUp = ReadShortcut(shortcuts, "volumeUp", state.Shortcuts.VolumeUp, "shortcuts.volumeUp", keys);
            state.Shortcuts.VolumeDown = ReadShortcut(shortcuts, "volumeDown", state.Shortcuts.VolumeDown, "shortcuts.volumeDown", keys);
            state.Shortcuts.Mute = ReadShortcut(shortcuts, "mute", state.Shortcuts.Mute, "shortcuts.mute", keys);
            state.Shortcuts.Like = ReadShortcut(shortcuts, "like", state.Shortcuts.Like, "shortcuts.like", keys);
            state.Shortcuts.Mode = ReadShortcut(shortcuts, "mode", state.Shortcuts.Mode, "shortcuts.mode", keys);
            state.Shortcuts.Mini = ReadShortcut(shortcuts, "mini", state.Shortcuts.Mini, "shortcuts.mini", keys);
            state.Shortcuts.DesktopLyrics = ReadShortcut(
                shortcuts, "desktopLyrics", state.Shortcuts.DesktopLyrics, "shortcuts.desktopLyrics", keys);
            state.Shortcuts.Crossfade = ReadShortcut(shortcuts, "crossfade", state.Shortcuts.Crossfade, "shortcuts.crossfade", keys);
            state.Shortcuts.AppOutput = ReadShortcut(
                shortcuts, "appOutput", state.Shortcuts.AppOutput, "shortcuts.appOutput", keys);
            state.Shortcuts.SystemOutput = ReadShortcut(
                shortcuts, "systemOutput", state.Shortcuts.SystemOutput, "shortcuts.systemOutput", keys);
        }

        return keys;
    }

    private static bool TryGetObject(JsonElement parent, string name, out JsonElement value)
    {
        if (parent.TryGetProperty(name, out value) && value.ValueKind == JsonValueKind.Object)
        {
            return true;
        }

        value = default;
        return false;
    }

    private static bool ReadBool(JsonElement parent, string name, bool fallback, string key, List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind == JsonValueKind.True)
        {
            return true;
        }

        if (value.ValueKind == JsonValueKind.False)
        {
            return false;
        }

        HostLog.Warn($"[settings] invalid key={key} expected=bool fallback={fallback.ToString().ToLowerInvariant()}");
        return fallback;
    }

    /// <summary>
    /// 快捷键字符串：非字符串/超长按非法值回落当前值（保留上一次注册），空字符串是合法值
    /// （表示关闭该条热键，见 docs/zilux2-settings-contract.md §2）。
    /// </summary>
    private static string ReadShortcut(JsonElement parent, string name, string fallback, string key, List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = (value.GetString() ?? string.Empty).Trim();
            if (text.Length <= MaxShortcutChars)
            {
                return text;
            }
        }

        HostLog.Warn($"[settings] invalid key={key} expected=shortcut fallback={fallback}");
        return fallback;
    }

    /// <summary>启动画面文案：允许空串（隐藏该行），最长 48 字符，避免把启动画面撑破。</summary>
    private static string ReadSplashText(
        JsonElement parent,
        string name,
        string fallback,
        string key,
        List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = (value.GetString() ?? string.Empty).Trim();
            if (text.Length <= 48)
            {
                return text;
            }
        }

        HostLog.Warn($"[settings] invalid key={key} expected=splash-text fallback={fallback}");
        return fallback;
    }

    /// <summary>音频设备 ID（浏览器 deviceId / WASAPI 端点 ID）：允许空串，只做长度校验。</summary>
    private static string ReadDeviceId(JsonElement parent, string name, string fallback, string key, List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = (value.GetString() ?? string.Empty).Trim();
            if (text.Length <= MaxDeviceIdChars)
            {
                return text;
            }
        }

        HostLog.Warn($"[settings] invalid key={key} expected=deviceId fallback=<current>");
        return fallback;
    }

    /// <summary>字符串数组（最多 32 项、单项 256 字符，去重）；结构不合法时保留当前值。</summary>
    private static string[] ReadStringArray(
        JsonElement parent,
        string name,
        int maxItems,
        int maxChars,
        string[] current,
        string key,
        List<string> keys)
    {
        var result = (string[])current.Clone();
        if (!parent.TryGetProperty(name, out var value))
        {
            return result;
        }

        keys.Add(key);
        if (value.ValueKind != JsonValueKind.Array)
        {
            HostLog.Warn($"[settings] invalid key={key} expected=string[] fallback=<current>");
            return result;
        }

        var list = new List<string>();
        foreach (var item in value.EnumerateArray())
        {
            if (list.Count >= maxItems)
            {
                break;
            }

            if (item.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            var text = (item.GetString() ?? string.Empty).Trim();
            if (text.Length is > 0 && text.Length <= maxChars && !list.Contains(text, StringComparer.Ordinal))
            {
                list.Add(text);
            }
        }

        return list.ToArray();
    }

    private static string ReadEnum(
        JsonElement parent,
        string name,
        string[] allowed,
        string fallback,
        string key,
        List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString();
            if (text is not null && Array.IndexOf(allowed, text) >= 0)
            {
                return text;
            }
        }

        HostLog.Warn($"[settings] invalid key={key} expected={string.Join("|", allowed)} fallback={fallback}");
        return fallback;
    }

    private static int ReadAllowedInt(
        JsonElement parent,
        string name,
        int[] allowed,
        int fallback,
        string key,
        List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind == JsonValueKind.Number &&
            value.TryGetInt32(out var number) &&
            Array.IndexOf(allowed, number) >= 0)
        {
            return number;
        }

        HostLog.Warn($"[settings] invalid key={key} expected={string.Join("|", allowed)} fallback={fallback}");
        return fallback;
    }

    private static int ReadIntInRange(
        JsonElement parent,
        string name,
        int min,
        int max,
        int fallback,
        string key,
        List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) && number >= min && number <= max)
        {
            return number;
        }

        HostLog.Warn($"[settings] invalid key={key} expected=int {min}..{max} fallback={fallback}");
        return fallback;
    }

    private static int[] ReadIntArray(
        JsonElement parent,
        string name,
        int length,
        int min,
        int max,
        int[] current,
        string key,
        List<string> keys)
    {
        // 缺省或整体结构不合法时保留当前值；单个元素非法时只回退该元素，
        // 不把用户已经调好的其余频段一起清零（P3-04）。
        var result = (int[])current.Clone();
        if (!parent.TryGetProperty(name, out var value))
        {
            return result;
        }

        keys.Add(key);
        if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() != length)
        {
            HostLog.Warn($"[settings] invalid key={key} expected=int[{length}] fallback=<current>");
            return result;
        }

        var index = 0;
        foreach (var item in value.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.Number &&
                item.TryGetInt32(out var number) &&
                number >= min &&
                number <= max)
            {
                result[index] = number;
            }
            else
            {
                HostLog.Warn($"[settings] invalid key={key} index={index} expected=int {min}..{max} fallback={result[index]}");
            }

            index++;
        }

        return result;
    }

    private static string ReadDirectory(
        JsonElement parent,
        string name,
        string fallback,
        string key,
        List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind != JsonValueKind.String)
        {
            HostLog.Warn($"[settings] invalid key={key} expected=absolute-path fallback={fallback}");
            return fallback;
        }

        var text = (value.GetString() ?? string.Empty).Trim();
        if (text.Length == 0)
        {
            return string.Empty;
        }

        // 下载目录必须是绝对路径：相对路径会随进程 CWD 漂移，导致同一设置在调试版/正式版指向不同目录。
        if (!Path.IsPathFullyQualified(text))
        {
            HostLog.Warn($"[settings] invalid key={key} expected=absolute-path fallback={fallback} value={text}");
            return fallback;
        }

        try
        {
            return Path.GetFullPath(text);
        }
        catch (Exception)
        {
            HostLog.Warn($"[settings] invalid key={key} fallback={fallback} value={text}");
            return fallback;
        }
    }

    private static string ReadRepo(
        JsonElement parent,
        string name,
        string fallback,
        string key,
        List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind != JsonValueKind.String)
        {
            HostLog.Warn($"[settings] invalid key={key} expected=\"owner/repo\" fallback={fallback}");
            return fallback;
        }

        var text = (value.GetString() ?? string.Empty).Trim();
        if (text.Length == 0)
        {
            return string.Empty;
        }

        if (IsRepoSlug(text))
        {
            return text;
        }

        HostLog.Warn($"[settings] invalid key={key} expected=\"owner/repo\" fallback={fallback} value={text}");
        return fallback;
    }

    /// <summary>
    /// 下载文件名模板：非空字符串、≤maxLength、至少含一个 {artist}/{title}/{id}/{quality} 占位符，
    /// 否则回退默认模板（避免用户只写死一个名字导致所有下载互相覆盖）。
    /// </summary>
    private static string ReadTemplate(
        JsonElement parent,
        string name,
        int maxLength,
        string fallback,
        string key,
        List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind != JsonValueKind.String)
        {
            HostLog.Warn($"[settings] invalid key={key} expected=string fallback={fallback}");
            return fallback;
        }

        var text = (value.GetString() ?? string.Empty).Trim();
        var hasToken = text.Contains("{artist}", StringComparison.Ordinal)
            || text.Contains("{title}", StringComparison.Ordinal)
            || text.Contains("{id}", StringComparison.Ordinal)
            || text.Contains("{quality}", StringComparison.Ordinal);
        if (text.Length == 0 || text.Length > maxLength || !hasToken)
        {
            HostLog.Warn($"[settings] invalid key={key} expected=template-with-token fallback={fallback} value={text}");
            return fallback;
        }

        return text;
    }

    // GitHub owner/repo: exactly one slash, each side non-empty and made of safe slug characters.
    private static bool IsRepoSlug(string text)
    {
        // GitHub 限制：owner ≤39、repo ≤100；这里用 140 覆盖 "owner/repo" 的总长度。
        if (text.Length < 3 || text.Length > 140)
        {
            return false;
        }

        var slash = text.IndexOf('/');
        if (slash <= 0 || slash == text.Length - 1 || text.IndexOf('/', slash + 1) >= 0)
        {
            return false;
        }

        var owner = text[..slash];
        var repo = text[(slash + 1)..];
        if (owner is "." or ".." || repo is "." or "..")
        {
            return false;
        }

        for (var index = 0; index < text.Length; index++)
        {
            if (index == slash)
            {
                continue;
            }

            var ch = text[index];
            if (!char.IsLetterOrDigit(ch) && ch != '-' && ch != '_' && ch != '.')
            {
                return false;
            }
        }

        return true;
    }

    // 桌面歌词位置：屏幕坐标可为负（多显示器），拒绝 NaN/Infinity 和明显越界的值。
    private static double? ReadCoordinate(
        JsonElement parent,
        string name,
        double? fallback,
        string key,
        List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind == JsonValueKind.Number &&
            value.TryGetDouble(out var number) &&
            double.IsFinite(number) &&
            number is >= -200000 and <= 200000)
        {
            return number;
        }

        HostLog.Warn($"[settings] invalid key={key} expected=coordinate fallback={fallback?.ToString(CultureInfo.InvariantCulture) ?? "<null>"}");
        return fallback;
    }

    private static double ReadVolume(JsonElement parent, string name, double fallback, string key, List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && number is >= 0.0 and <= 1.0)
        {
            // Contract section 2: volume keeps two decimals.
            return Math.Round(number, 2, MidpointRounding.AwayFromZero);
        }

        HostLog.Warn($"[settings] invalid key={key} expected=number 0.0..1.0 fallback={fallback.ToString(CultureInfo.InvariantCulture)}");
        return fallback;
    }

    /// <summary>读取原文件失败时尽量复制一份 .unreadable-*；返回 false 表示无法保护原文件。</summary>
    private bool TryPreserveUnreadableSettings()
    {
        try
        {
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
            var backupPath = $"{_path}.unreadable-{stamp}";
            var index = 1;
            while (File.Exists(backupPath))
            {
                backupPath = $"{_path}.unreadable-{stamp}-{index.ToString(CultureInfo.InvariantCulture)}";
                index++;
            }

            File.Copy(_path, backupPath);
            HostLog.Warn($"[settings] unreadable backup path={backupPath}");
            return true;
        }
        catch (Exception exception)
        {
            HostLog.Error("[settings] unreadable backup failed", exception);
            return false;
        }
    }

    private void TryDeleteTempFile()
    {
        try
        {
            var tempPath = _path + ".tmp";
            if (File.Exists(tempPath))
            {
                File.Delete(tempPath);
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[settings] temp cleanup failed: {exception.Message}");
        }
    }

    /// <summary>加载时两套桌面歌词同时为 true（手改文件/旧版本遗留）：背景歌词优先，避免同时开两个窗。</summary>
    private static void EnforceLyricsExclusivity(SettingsModel state)
    {
        if (!state.General.BackgroundLyrics || !state.General.DesktopLyrics)
        {
            return;
        }

        state.General.DesktopLyrics = false;
        HostLog.Warn("[settings] load: desktopLyrics disabled because backgroundLyrics was enabled");
    }

    private void BackupCorruptFile(string reason)
    {
        try
        {
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
            var backupPath = $"{_path}.corrupt-{stamp}";
            var index = 1;
            while (File.Exists(backupPath))
            {
                backupPath = $"{_path}.corrupt-{stamp}-{index.ToString(CultureInfo.InvariantCulture)}";
                index++;
            }

            File.Move(_path, backupPath);
            HostLog.Warn($"[settings] corrupt backup path={backupPath} reason={reason}");
        }
        catch (Exception exception)
        {
            HostLog.Error("[settings] corrupt backup failed", exception);
        }
    }
}
