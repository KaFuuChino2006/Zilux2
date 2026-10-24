using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Zilux2.AirPlay;
using Zilux2.Audio;
using Zilux2.Local;
using Zilux2.Media;
using Zilux2.Online;
using Zilux2.Settings;
using Zilux2.Updates;

namespace Zilux2;

internal static class HostInfo
{
    public static readonly string Version = ReadVersion();

    /// <summary>构建时烘焙进程序集的 GitHub 仓库（owner/name），更新通道用；空字符串表示未配置。</summary>
    public static readonly string UpdateRepo = ReadUpdateRepo();

    private static string ReadVersion()
    {
        var version = typeof(HostInfo).Assembly.GetName().Version;
        return version is null ? "1.0.0" : $"{version.Major}.{version.Minor}.{version.Build}";
    }

    private static string ReadUpdateRepo()
    {
        foreach (var attribute in typeof(HostInfo).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>())
        {
            if (string.Equals(attribute.Key, "ZiluxUpdateRepo", StringComparison.Ordinal) &&
                !string.IsNullOrWhiteSpace(attribute.Value))
            {
                return attribute.Value.Trim();
            }
        }

        return string.Empty;
    }
}

internal enum WebContentKind
{
    /// <summary>ZILUX2_DEV_URL: navigate straight to a dev server.</summary>
    DevUrl,

    /// <summary>A folder mapped onto https://zilux2.local.</summary>
    LocalFolder,
}

internal sealed class WebContentPlan
{
    public const string VirtualHost = "zilux2.local";

    public required WebContentKind Kind { get; init; }

    public string? DevUrl { get; init; }

    public string? FolderPath { get; init; }

    public string Origin => Kind == WebContentKind.DevUrl && DevUrl is not null
        ? new Uri(DevUrl).GetLeftPart(UriPartial.Authority)
        : $"https://{VirtualHost}";

    public string NavigationUrl => Kind == WebContentKind.DevUrl
        ? DevUrl!
        : $"https://{VirtualHost}/index.html?v={BuildStamp}";

    /// <summary>
    /// 缓存指纹：宿主程序集指纹 + web 目录内容修改时间。
    /// 只换 web 资源（热替换 dist\Zilux2\web）时也必须变化，否则 WebView2 会继续用缓存的旧 index.html/旧包。
    /// </summary>
    private string BuildStamp
    {
        get
        {
            var hostStamp = typeof(WebContentPlan).Assembly.ManifestModule.ModuleVersionId.ToString("N")[..8];
            try
            {
                if (!string.IsNullOrEmpty(FolderPath))
                {
                    var index = Path.Combine(FolderPath, "index.html");
                    var indexTicks = File.Exists(index) ? File.GetLastWriteTimeUtc(index).Ticks : 0L;
                    var latest = indexTicks;
                    var assets = Path.Combine(FolderPath, "assets");
                    if (Directory.Exists(assets))
                    {
                        foreach (var file in Directory.EnumerateFiles(assets))
                        {
                            var ticks = File.GetLastWriteTimeUtc(file).Ticks;
                            if (ticks > latest) latest = ticks;
                        }
                    }
                    return $"{hostStamp}-{latest:x}";
                }
            }
            catch
            {
                // 指纹失败不影响导航，回退宿主指纹
            }
            return hostStamp;
        }
    }

    public bool IsDevMode =>
        string.Equals(Environment.GetEnvironmentVariable("ZILUX2_DEV"), "1", StringComparison.Ordinal);

    /// <summary>Contract 3.3 priority: dev URL, explicit web dir, bundled web dir, nothing.</summary>
    public static WebContentPlan? Resolve(out string failure)
    {
        failure = string.Empty;

        var devUrl = Environment.GetEnvironmentVariable("ZILUX2_DEV_URL");
        if (!string.IsNullOrWhiteSpace(devUrl))
        {
            devUrl = devUrl.Trim();
            if (Uri.TryCreate(devUrl, UriKind.Absolute, out var uri) &&
                (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
            {
                HostLog.Info($"content.resolve source=dev-url url={devUrl}");
                return new WebContentPlan { Kind = WebContentKind.DevUrl, DevUrl = devUrl };
            }

            failure = $"环境变量 ZILUX2_DEV_URL 不是合法的 http/https 地址：{devUrl}";
            return null;
        }

        var webDir = Environment.GetEnvironmentVariable("ZILUX2_WEB_DIR");
        if (!string.IsNullOrWhiteSpace(webDir))
        {
            var folder = ResolveExistingFolder(webDir.Trim());
            if (HasIndex(folder))
            {
                HostLog.Info($"content.resolve source=web-dir folder={folder}");
                return new WebContentPlan { Kind = WebContentKind.LocalFolder, FolderPath = folder };
            }

            failure = $"环境变量 ZILUX2_WEB_DIR 指向的目录里没有 index.html：{folder}";
            return null;
        }

        var bundled = Path.Combine(AppContext.BaseDirectory, "web");
        if (HasIndex(bundled))
        {
            HostLog.Info($"content.resolve source=bundled folder={bundled}");
            return new WebContentPlan { Kind = WebContentKind.LocalFolder, FolderPath = bundled };
        }

        failure = $"没有设置 ZILUX2_DEV_URL / ZILUX2_WEB_DIR，程序目录下也没有打包好的前端：{bundled}";
        return null;
    }

    private static bool HasIndex(string folder) => File.Exists(Path.Combine(folder, "index.html"));

    private static string ResolveExistingFolder(string raw)
    {
        if (Path.IsPathRooted(raw))
        {
            return Path.GetFullPath(raw);
        }

        // Relative paths are natural from a shell; also accept paths relative to the exe
        // directory so double-clicking the exe next to a web folder behaves sanely.
        var fromWorkingDirectory = Path.GetFullPath(raw, Environment.CurrentDirectory);
        if (Directory.Exists(fromWorkingDirectory))
        {
            return fromWorkingDirectory;
        }

        var fromBaseDirectory = Path.GetFullPath(raw, AppContext.BaseDirectory);
        return Directory.Exists(fromBaseDirectory) ? fromBaseDirectory : fromWorkingDirectory;
    }
}

internal sealed class WebViewHost : IDisposable
{
    private const int MaxMessageChars = 64 * 1024;

    // Contract 3.2: keep Chromium from throttling a mostly-static, occasionally occluded window.
    private const string BrowserArguments =
        // HardwareMediaKeyHandling：不让 WebView2 自己再建一个媒体会话，Windows「正在播放」只留宿主这一条
        "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,HardwareMediaKeyHandling " +
        "--disable-backgrounding-occluded-windows " +
        "--disable-background-timer-throttling " +
        "--disable-renderer-backgrounding " +
        "--autoplay-policy=no-user-gesture-required";

    private readonly MainWindow _window;
    private readonly WebView2 _webView;
    private readonly WebContentPlan _plan;
    private readonly SettingsBridge? _settingsBridge;
    private readonly AudioFeatureService? _audio;
    private readonly MediaSessionService? _media;
    private readonly AirPlayService? _airplay;
    private readonly LocalMusicService _localMusic;
    private readonly UpdateService? _updates;
    private bool _disposed;
    private bool _pageReady;
    private bool _recoverAttempted;
    private int _audioPostPending;

    public WebViewHost(
        MainWindow window,
        WebView2 webView,
        WebContentPlan plan,
        SettingsService? settings,
        AudioFeatureService? audio = null,
        MediaSessionService? media = null,
        AirPlayService? airplay = null)
    {
        _window = window;
        _webView = webView;
        _plan = plan;
        _settingsBridge = settings is null ? null : new SettingsBridge(settings);
        _audio = audio;
        _media = media;
        _airplay = airplay;
        _localMusic = new LocalMusicService(
            window,
            () => _webView.CoreWebView2,
            PostJson,
            settings is null ? null : () => settings.DownloadDirectory);
        // 自动更新：状态推送从任意线程回来，统一调度到 UI 线程再 PostWebMessage。
        _updates = settings is null
            ? null
            : new UpdateService(settings, PostJsonFromAnyThread, RequestShutdownForUpdate);
        if (_media is not null)
        {
            _media.ControlRequested += OnMediaControlRequested;
        }

        if (_airplay is not null)
        {
            _airplay.StatusChanged += OnAirPlayStatusChanged;
        }
    }

    public async Task InitializeAsync()
    {
        try
        {
            // Painting #07080B from the first frame avoids the white flash before the page loads.
            _webView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 246, 247, 251);

            var userDataFolder = Path.Combine(HostFolders.Root, "WebView2");
            Directory.CreateDirectory(userDataFolder);

            HostLog.Info($"webview2 environment creating: udf={userDataFolder} dev={_plan.IsDevMode}");
            var options = new CoreWebView2EnvironmentOptions(BrowserArguments);
            var environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder, options);
            if (_disposed)
            {
                return;
            }

            HostLog.Info($"webview2 runtime: {environment.BrowserVersionString}");
            await _webView.EnsureCoreWebView2Async(environment);
            if (_disposed)
            {
                return;
            }

            var core = _webView.CoreWebView2 ??
                       throw new InvalidOperationException("CoreWebView2 was null after successful initialization.");

            var devMode = _plan.IsDevMode;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = devMode;
            core.Settings.AreBrowserAcceleratorKeysEnabled = devMode;

            core.WebMessageReceived += OnWebMessageReceived;
            core.ProcessFailed += OnProcessFailed;
            core.NavigationStarting += OnNavigationStarting;
            core.NavigationCompleted += OnNavigationCompleted;
            core.NewWindowRequested += OnNewWindowRequested;
            core.PermissionRequested += OnPermissionRequested;

            if (_plan.Kind == WebContentKind.LocalFolder)
            {
                core.SetVirtualHostNameToFolderMapping(
                    WebContentPlan.VirtualHost,
                    _plan.FolderPath!,
                    CoreWebView2HostResourceAccessKind.Allow);
                HostLog.Info($"webview2 mapping: https://{WebContentPlan.VirtualHost} -> {_plan.FolderPath}");
            }

            HostLog.Info("webview2 initialized");
            core.Navigate(_plan.NavigationUrl);
        }
        catch (Exception exception)
        {
            HostLog.Error("webview2.initialization failed", exception);
            _window.ShowError(
                "WebView2 初始化失败",
                "无法启动 WebView2 运行时。\n" +
                $"{exception.GetType().Name}: {exception.Message}\n\n" +
                "请安装 Microsoft Edge WebView2 Runtime 后重新启动 Zilux2。");
        }
    }

    public void PostWindowState(bool maximized)
    {
        if (_disposed || !_pageReady)
        {
            return;
        }

        PostJson("{\"v\":1,\"type\":\"host\",\"event\":\"windowState\",\"maximized\":" + (maximized ? "true" : "false") + "}");
    }

    /// <summary>
    /// 托盘菜单 / 全局热键的播放控制：推 <c>{"v":1,"type":"command","action":"..."}</c> 给页面。
    /// 页面未就绪（启动中、导航中）时只记日志——这些是瞬时动作，缓存下来反而会在页面回来时
    /// 突然同时生效，不如丢掉等下一次输入。
    /// </summary>
    public void PostCommand(string action)
    {
        if (action is not ("togglePlay" or "prev" or "next"))
        {
            HostLog.Warn($"command.post ignored action={action}");
            return;
        }

        if (_disposed)
        {
            return;
        }

        if (!_pageReady)
        {
            HostLog.Info($"command.post skipped action={action}: page not ready");
            return;
        }

        HostLog.Info($"command.post action={action}");
        PostJson("{\"v\":1,\"type\":\"command\",\"action\":\"" + action + "\"}");
    }

    /// <summary>
    /// 全局快捷键的生效状态（设置驱动的热键注册结果，JSON 由 MainWindow 构建）。页面未就绪时
    /// 直接丢弃：MainWindow 在收到 ready 后会主动再推一次最新状态，不需要在这里缓存。
    /// </summary>
    internal void PublishShortcuts(string json)
    {
        if (_disposed || !_pageReady)
        {
            return;
        }

        PostJson(json);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _updates?.Dispose();
        // 先停本地目录监听，避免 WebView2 销毁后还有后台扫描往页面推消息。
        _localMusic.Dispose();
        DetachAudio();
        if (_media is not null)
        {
            _media.ControlRequested -= OnMediaControlRequested;
        }

        if (_airplay is not null)
        {
            _airplay.StatusChanged -= OnAirPlayStatusChanged;
        }
        HostLog.Info("webview2.dispose begin");
        try
        {
            var core = _webView.CoreWebView2;
            if (core is not null)
            {
                core.WebMessageReceived -= OnWebMessageReceived;
                core.ProcessFailed -= OnProcessFailed;
                core.NavigationStarting -= OnNavigationStarting;
                core.NavigationCompleted -= OnNavigationCompleted;
                core.NewWindowRequested -= OnNewWindowRequested;
                core.PermissionRequested -= OnPermissionRequested;
            }
        }
        catch (Exception exception)
        {
            HostLog.Error("webview2.dispose unsubscribe failed", exception);
        }

        try
        {
            _webView.Dispose();
        }
        catch (Exception exception)
        {
            HostLog.Error("webview2.dispose failed", exception);
        }

        HostLog.Info("webview2.disposed");
    }

    private static string ReadyJson(bool maximized) =>
        "{\"v\":1,\"type\":\"host\",\"event\":\"ready\",\"version\":\"" + HostInfo.Version +
        "\",\"maximized\":" + (maximized ? "true" : "false") + "}";

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            if (!IsTrustedSource(e.Source))
            {
                HostLog.Warn($"webview2.message rejected: untrusted source={e.Source}");
                return;
            }

            var json = e.WebMessageAsJson;
            if (string.IsNullOrEmpty(json))
            {
                return;
            }

            if (json.Length > MaxMessageChars)
            {
                HostLog.Warn($"webview2.message rejected: too large ({json.Length} chars)");
                return;
            }

            using var document = JsonDocument.Parse(json);
            var root = Unwrap(document.RootElement);
            if (root.ValueKind != JsonValueKind.Object)
            {
                HostLog.Warn("webview2.message ignored: not a JSON object");
                return;
            }

            if (!root.TryGetProperty("v", out var versionElement) || !versionElement.TryGetInt32(out var protocolVersion) || protocolVersion != 1)
            {
                HostLog.Warn("webview2.message ignored: unsupported protocol version");
                return;
            }

            var type = ReadString(root, "type");
            switch (type)
            {
                case "ready":
                    _pageReady = true;
                    HostLog.Info("page.ready");
                    PostJson(ReadyJson(_window.IsMaximized));
                    PostOnlineInfo();
                    PostSettingsSnapshot();
                    // 快捷键生效状态（task-13）：启动时 MainWindow 已注册好热键，这里补推一次。
                    _window.PublishShortcutState();
                    AttachAudio();
                    AttachMedia();
                    PostAirPlayStatus();
                    _updates?.Start();
                    break;

                case "settings":
                    HandleSettingsMessage(root);
                    break;

                case "window":
                    HandleWindowCommand(root);
                    break;

                case "drag":
                    HostLog.Info("page.drag: handing pointer to the OS move loop");
                    _window.BeginDrag();
                    break;

                case "resize":
                    _window.BeginResize(ReadString(root, "edge") ?? string.Empty);
                    break;

                case "log":
                    HandlePageLog(root);
                    break;

                case "media":
                    HandleMediaMessage(root);
                    break;
                case "audio":
                    HandleAudioMessage(root);
                    break;

                case "airplay":
                    HandleAirPlayMessage(root);
                    break;

                case "fonts":
                    HandleFontsMessage();
                    break;

                case "local":
                    _localMusic.Handle(root);
                    break;

                case "update":
                    _updates?.Handle(root);
                    break;

                default:
                    // Contract 3.4: unknown types are ignored, but still visible in the log.
                    HostLog.Info($"webview2.message ignored: unknown type={type ?? "<missing>"}");
                    break;
            }
        }
        catch (Exception exception)
        {
            HostLog.Error("webview2.message handling failed", exception);
        }
    }

    /// <summary>把系统已安装字体族发给页面（歌词字体选择用）。</summary>
    private void HandleFontsMessage()
    {
        var families = new List<string>();
        try
        {
            foreach (var family in System.Windows.Media.Fonts.SystemFontFamilies)
            {
                var name = family.Source;
                if (!string.IsNullOrWhiteSpace(name) && !families.Contains(name))
                {
                    families.Add(name);
                }
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"fonts enumerate failed: {exception.Message}");
        }

        families.Sort(StringComparer.CurrentCultureIgnoreCase);
        var message = new HostFontsMessage { Payload = new FontsEventPayload { Families = families } };
        PostJson(JsonSerializer.Serialize(message, OnlineJsonContext.Default.HostFontsMessage));
        HostLog.Info($"[fonts] sent {families.Count} families");
    }

    private void HandleWindowCommand(JsonElement root)
    {
        var action = ReadString(root, "action");
        switch (action)
        {
            case "chromeColor":
                _window.SetChromeColor(ReadString(root, "color"));
                break;

            case "minimize":
                HostLog.Info("window.action minimize");
                _window.MinimizeFromPage();
                break;

            case "toggleMaximize":
                HostLog.Info("window.action toggleMaximize");
                _window.ToggleMaximize();
                break;

            case "close":
                HostLog.Info("window.action close");
                _window.CloseFromPage();
                break;

            default:
                HostLog.Warn($"window.action ignored: {action ?? "<missing>"}");
                break;
        }
    }

    private static void HandlePageLog(JsonElement root)
    {
        var level = ReadString(root, "level") ?? "info";
        var message = ReadString(root, "message") ?? string.Empty;
        if (message.Length > 2048)
        {
            message = message[..2048] + "…";
        }

        var line = $"web:{level} {message}";
        switch (level)
        {
            case "error":
                HostLog.Error(line);
                break;

            case "warn":
                HostLog.Warn(line);
                break;

            default:
                HostLog.Info(line);
                break;
        }
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        // A new document must announce itself with a fresh "ready" before the host pushes
        // state to it. Reset here, not in NavigationCompleted: the page's ready message can
        // legitimately arrive before NavigationCompleted fires, and resetting afterwards
        // would silently mute every later windowState push.
        _pageReady = false;
        DetachAudio();
        HostLog.Info($"navigation starting: {e.Uri}");
        if (!IsAllowedNavigation(e.Uri))
        {
            // Only the packaged page (or the configured dev server) is allowed to drive the host.
            HostLog.Warn($"navigation blocked: {e.Uri}");
            e.Cancel = true;
        }
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        var source = (sender as CoreWebView2)?.Source ?? "(unknown)";
        HostLog.Info($"navigation completed: success={e.IsSuccess} status={e.WebErrorStatus} uri={source}");
        if (!e.IsSuccess)
        {
            HostLog.Error($"navigation failed: {source} status={e.WebErrorStatus}");
        }
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        HostLog.Error($"webview2.process_failed: kind={e.ProcessFailedKind} reason={e.Reason} exit={e.ExitCode}");

        if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
        {
            _window.ShowError("WebView2 已退出", "WebView2 浏览器进程已退出，请重新启动 Zilux2。");
            return;
        }

        if (_recoverAttempted)
        {
            _window.ShowError("页面渲染进程异常", "WebView2 渲染进程反复失败，页面无法恢复。\n请重新启动 Zilux2。");
            return;
        }

        _recoverAttempted = true;
        try
        {
            HostLog.Info("webview2.recovery: reloading page");
            _webView.CoreWebView2?.Reload();
        }
        catch (Exception exception)
        {
            HostLog.Error("webview2.recovery failed", exception);
            _window.ShowError("页面渲染进程异常", "WebView2 初始化失败，页面无法恢复。\n请安装/修复 WebView2 Runtime 后重新启动。");
        }
    }

    private static void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        // 摄像头手势需要相机权限；其余权限保持默认（拒绝）
        if (e.PermissionKind == CoreWebView2PermissionKind.Camera)
        {
            e.State = CoreWebView2PermissionState.Allow;
            HostLog.Info("[web] camera permission allowed");
        }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        // Milestone 1 has a single immersive window; a popup would escape the design.
        e.Handled = true;
        HostLog.Warn($"webview2.new_window blocked: {e.Uri}");
    }

    private void PostOnlineInfo()
    {
        try
        {
            var online = App.Online;
            if (online?.Endpoint is null)
            {
                HostLog.Warn(
                    "[online] endpoint unavailable, page gets no online sources" +
                    (string.IsNullOrEmpty(online?.FailureMessage) ? string.Empty : $": {online.FailureMessage}"));
                return;
            }

            var message = new HostOnlineMessage { Payload = online.BuildEventPayload() };
            PostJson(JsonSerializer.Serialize(message, OnlineJsonContext.Default.HostOnlineMessage));
            HostLog.Info(
                $"[online] endpoint sent to page port={online.Endpoint.Port} " +
                $"tokenLen={online.Endpoint.Token.Length} sources={string.Join(",", online.Endpoint.Sources)}");
        }
        catch (Exception exception)
        {
            HostLog.Error("[online] endpoint push failed", exception);
        }
    }

    private void HandleSettingsMessage(JsonElement root)
    {
        if (_settingsBridge is null)
        {
            HostLog.Warn("[settings] message ignored: settings service unavailable");
            return;
        }

        // The bridge returns the full snapshot ACK for request/patch/reset and null when ignored.
        var snapshot = _settingsBridge.Handle(root);
        if (snapshot is not null)
        {
            PostJson(snapshot);
        }
    }

    private void HandleMediaMessage(JsonElement root)
    {
        if (_media is null)
        {
            return;
        }

        if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
        {
            HostLog.Warn("[smtc] media message ignored: missing payload object");
            return;
        }

        // Unknown fields are ignored; invalid numbers fall back to 0 (contract §11).
        var state = new MediaState(
            ReadString(payload, "title") ?? string.Empty,
            ReadString(payload, "artist") ?? string.Empty,
            ReadString(payload, "album") ?? string.Empty,
            ReadString(payload, "coverUrl"),
            ReadFiniteDouble(payload, "durationMs"),
            ReadFiniteDouble(payload, "positionMs"),
            payload.TryGetProperty("playing", out var playing) && playing.ValueKind == JsonValueKind.True);

        _media.Update(state);
    }

    private void PostSettingsSnapshot()
    {
        if (_settingsBridge is null)
        {
            HostLog.Warn("[settings] snapshot push skipped: settings service unavailable");
            return;
        }

        try
        {
            // Contract section 3.2: idempotent second push after ready so a page that missed the
            // early request still starts with the persisted state.
            PostJson(_settingsBridge.CreateSnapshotJson());
        }
        catch (Exception exception)
        {
            HostLog.Error("[settings] snapshot push failed", exception);
        }
    }

    private void AttachAudio()
    {
        if (_audio is null)
        {
            return;
        }

        _audio.SetSink(OnAudioFrame);
        _audio.Start();
    }

    private void DetachAudio()
    {
        _audio?.SetSink(null);
    }

    private void AttachMedia()
    {
        // SMTC is created lazily: the window handle exists once the page is running, and a WinRT
        // failure only costs the Now Playing integration, never the app.
        _media?.Enable(_window.Handle);
    }

    // May arrive from a shell thread: marshal to the dispatcher before touching WebView2.
    private void OnMediaControlRequested(MediaControlCommand command)
    {
        if (_disposed)
        {
            return;
        }

        var json = MediaControlMessage.Build(command);
        _window.Dispatcher.BeginInvoke(DispatcherPriority.Input, new Action(() =>
        {
            if (_disposed)
            {
                return;
            }

            if (!_pageReady)
            {
                HostLog.Warn($"[smtc] mediaControl dropped: page is not ready action={command.Action}");
                return;
            }

            PostJson(json);
        }));
    }

    // Runs on the capture thread: serialize immediately (the analyzer reuses its arrays), then
    // hand the string to the UI thread. Frames are dropped, not queued, while the UI is busy.
    private void OnAudioFrame(AudioFrameSnapshot frame)
    {
        if (_disposed || !_pageReady || _audio is null)
        {
            return;
        }

        if (Interlocked.Exchange(ref _audioPostPending, 1) != 0)
        {
            return;
        }

        var json = AudioMessage.Build(frame);
        _window.Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() =>
        {
            Interlocked.Exchange(ref _audioPostPending, 0);
            if (!_disposed)
            {
                PostJson(json);
            }
        }));
    }

    // ---- Audio tap (contract §12 extension) -------------------------------------------

    /// <summary>
    /// PCM blocks pushed by the player's audio tap. The page taps its own audio graph so AirPlay
    /// streams only this app's sound; the page mutes its local gain while the tap is active.
    /// </summary>
    private void HandleAudioMessage(JsonElement root)
    {
        var airplay = _airplay;
        if (airplay is null)
        {
            return;
        }

        switch (ReadString(root, "action"))
        {
            case "config":
                airplay.ConfigureAudioTap(ReadInt(root, "rate", 48000), ReadInt(root, "channels", 2));
                break;

            case "reset":
                airplay.ResetAudioTap();
                break;

            case "push":
                HandleAudioPush(airplay, root);
                break;
        }
    }

    private static void HandleAudioPush(AirPlayService airplay, JsonElement root)
    {
        var encoded = ReadString(root, "data");
        if (string.IsNullOrEmpty(encoded))
        {
            return;
        }

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(encoded);
        }
        catch (FormatException)
        {
            return;
        }

        var sampleCount = bytes.Length / 2;
        if (sampleCount == 0)
        {
            return;
        }

        var samples = new short[sampleCount];
        for (var i = 0; i < sampleCount; i++)
        {
            samples[i] = (short)(bytes[i * 2] | (bytes[i * 2 + 1] << 8));
        }

        airplay.PushAudio(ReadInt(root, "rate", 48000), ReadInt(root, "channels", 2), samples);
    }

    // ---- AirPlay / RAOP (contract §12) -------------------------------------------------

    private void HandleAirPlayMessage(JsonElement root)
    {
        if (_airplay is null)
        {
            HostLog.Warn("[airplay] message ignored: service unavailable");
            return;
        }

        var action = ReadString(root, "action");
        switch (action)
        {
            case "scan":
                _airplay.StartScan();
                break;

            case "stopScan":
                _airplay.StopScan();
                break;

            case "connect":
            {
                var deviceId = ReadString(root, "deviceId");
                if (string.IsNullOrWhiteSpace(deviceId))
                {
                    HostLog.Warn("[airplay] connect ignored: missing deviceId");
                    return;
                }

                HostLog.Info($"[airplay] action connect device={deviceId}");
                _airplay.Connect(deviceId, ReadString(root, "password"));
                break;
            }

            case "disconnect":
            {
                var deviceId = ReadString(root, "deviceId");
                if (string.IsNullOrWhiteSpace(deviceId))
                {
                    _airplay.Disconnect();
                }
                else
                {
                    HostLog.Info($"[airplay] action disconnect device={deviceId}");
                    _airplay.DisconnectDevice(deviceId);
                }

                break;
            }

            case "pin":
            {
                var pinDeviceId = ReadString(root, "deviceId");
                var pin = ReadString(root, "value");
                HostLog.Info($"[airplay] action pin device={pinDeviceId ?? "(any)"}");
                _airplay.ProvidePin(pinDeviceId, pin ?? string.Empty);
                break;
            }

            case "volume":
            {
                var volumeDeviceId = ReadString(root, "deviceId");
                var percent = ReadInt(root, "percent", 0);
                if (string.IsNullOrWhiteSpace(volumeDeviceId))
                {
                    _airplay.SetVolume(percent);
                }
                else
                {
                    _airplay.SetVolume(volumeDeviceId, percent);
                }

                break;
            }

            case "latency":
            {
                // Receiver buffer latency for the next AirPlay 2 connection (page stores the value
                // in localStorage and replays it after a host restart).
                var milliseconds = ReadInt(root, "value", AirPlayService.DefaultLatencyMilliseconds);
                HostLog.Info($"[airplay] action latency value={milliseconds}");
                _airplay.SetLatency(milliseconds);
                PostAirPlayStatus();
                break;
            }

            default:
                HostLog.Warn($"[airplay] action ignored: {action ?? "<missing>"}");
                break;
        }
    }

    // May arrive from a worker thread (connect task / discovery thread): marshal before touching WebView2.
    private void OnAirPlayStatusChanged(AirPlayStatus status)
    {
        if (_disposed)
        {
            return;
        }

        _window.Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() =>
        {
            if (_disposed || !_pageReady)
            {
                return;
            }

            PostAirPlayStatus();
        }));
    }

    private void PostAirPlayStatus()
    {
        var airplay = _airplay;
        if (airplay is null || _disposed || !_pageReady)
        {
            return;
        }

        try
        {
            var status = airplay.Status;

            var devices = new JsonArray();
            foreach (var device in status.Devices.Take(32))
            {
                devices.Add(new JsonObject
                {
                    ["id"] = device.Id,
                    ["name"] = device.Name,
                    ["host"] = device.Host,
                    ["model"] = device.Model,
                    ["requiresPassword"] = device.RequiresPassword,
                    ["airPlay2"] = device.SupportsAirPlay2,
                });
            }

            JsonObject? active = null;
            if (status.ActiveDeviceId is { Length: > 0 } activeId)
            {
                active = new JsonObject
                {
                    ["id"] = activeId,
                    ["name"] = status.ActiveDeviceName ?? string.Empty,
                    ["volume"] = status.VolumePercent,
                };
            }

            var actives = new JsonArray();
            foreach (var item in status.Actives.Take(32))
            {
                actives.Add(new JsonObject
                {
                    ["id"] = item.Id,
                    ["name"] = item.Name,
                    ["volume"] = item.VolumePercent,
                });
            }

            var payload = new JsonObject
            {
                ["state"] = AirPlayStateName(status.State),
                ["devices"] = devices,
                ["active"] = active,
                ["actives"] = actives,
                ["code"] = status.Code,
                ["error"] = status.Error,
                ["latencyMs"] = airplay.LatencyMilliseconds,
            };

            var message = new JsonObject
            {
                ["v"] = 1,
                ["type"] = "host",
                ["event"] = "airplay",
                ["payload"] = payload,
            };

            PostJson(message.ToJsonString());
        }
        catch (Exception exception)
        {
            HostLog.Error("[airplay] status push failed", exception);
        }
    }

    private static string AirPlayStateName(AirPlayState state) => state switch
    {
        AirPlayState.Idle => "idle",
        AirPlayState.Scanning => "scanning",
        AirPlayState.Connecting => "connecting",
        AirPlayState.Streaming => "streaming",
        _ => "error",
    };

    /// <summary>在线下载完成：本地曲库把下载目录里的文件一起重新发一份给页面。</summary>
    public void NotifyDownloadedFile(string path) => _localMusic.NotifyFileAdded(path);

    private void PostJson(string json)
    {
        try
        {
            var core = _webView.CoreWebView2;
            if (core is null)
            {
                HostLog.Warn("webview2.post skipped: core not initialized");
                return;
            }

            core.PostWebMessageAsJson(json);
        }
        catch (Exception exception)
        {
            HostLog.Error("webview2.post failed", exception);
        }
    }

    /// <summary>后台线程（更新服务）推消息用的入口：调度回 UI 线程再发送。</summary>
    private void PostJsonFromAnyThread(string json)
    {
        try
        {
            _window.Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() =>
            {
                if (!_disposed)
                {
                    PostJson(json);
                }
            }));
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[update] post dispatch failed: {exception.Message}");
        }
    }

    /// <summary>安装器启动后宿主退出：安装程序会先结束残留的 Zilux2 进程，这里优雅关窗。</summary>
    private void RequestShutdownForUpdate()
    {
        try
        {
            _window.Dispatcher.BeginInvoke(DispatcherPriority.Normal, new Action(() =>
            {
                HostLog.Info("[update] shutting down host for install");
                // 后台常驻后窗口关闭只是隐藏到托盘，直接 Application.Shutdown() 又会被
                // MainWindow 的 Closing 拦截；所以走宿主唯一的「真正退出」入口。
                _window.ExitApplication("update");
            }));
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[update] shutdown dispatch failed: {exception.Message}");
        }
    }

    private bool IsTrustedSource(string? source)
    {
        if (string.IsNullOrEmpty(source))
        {
            // Some synthetic documents do not report a source; the navigation allow-list still
            // guarantees only our content can ever reach this handler.
            return true;
        }

        return MatchesOrigin(source);
    }

    private bool IsAllowedNavigation(string? uri)
    {
        if (string.IsNullOrEmpty(uri))
        {
            return false;
        }

        if (uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase) ||
            uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase) ||
            uri.StartsWith("devtools:", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return MatchesOrigin(uri);
    }

    private bool MatchesOrigin(string value)
    {
        if (!value.StartsWith(_plan.Origin, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        // Boundary check: https://zilux2.local must not authorize https://zilux2.local.evil.com.
        return value.Length == _plan.Origin.Length || "/?#".IndexOf(value[_plan.Origin.Length]) >= 0;
    }

    private static JsonElement Unwrap(JsonElement root)
    {
        // Defensive: accept a JSON string that contains the envelope, so a bridge that
        // forgets to post an object degrades to a log line instead of a dead channel.
        if (root.ValueKind != JsonValueKind.String)
        {
            return root;
        }

        var inner = root.GetString();
        if (string.IsNullOrWhiteSpace(inner))
        {
            return root;
        }

        try
        {
            using var innerDocument = JsonDocument.Parse(inner);
            return innerDocument.RootElement.Clone();
        }
        catch (JsonException)
        {
            return root;
        }
    }

    private static string? ReadString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.String
            ? element.GetString()
            : null;

    private static double ReadFiniteDouble(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var element) || element.ValueKind != JsonValueKind.Number)
        {
            return 0;
        }

        return element.TryGetDouble(out var value) && double.IsFinite(value) ? value : 0;
    }

    private static int ReadInt(JsonElement root, string name, int fallback)
    {
        if (!root.TryGetProperty(name, out var element))
        {
            return fallback;
        }

        if (element.ValueKind == JsonValueKind.Number && element.TryGetInt32(out var value))
        {
            return value;
        }

        return element.ValueKind == JsonValueKind.String && int.TryParse(element.GetString(), out var parsed)
            ? parsed
            : fallback;
    }
}
