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
using Zilux2.Online.Account;
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
    private const int MaxAirPlayMessageChars = 8 * 1024;

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
    private readonly SettingsService? _settings;
    private readonly AudioFeatureService? _audio;
    private readonly MediaSessionService? _media;
    private readonly AirPlayService? _airplay;
    private readonly LocalMusicService _localMusic;
    private readonly UpdateService? _updates;
    private const int OnlineRetryIntervalMs = 500;
    private const int OnlineRetryLimit = 40;
    private bool _disposed;
    private bool _pageReady;
    private bool _firstContentReady;
    private bool _recoverAttempted;
    private int _audioPostPending;
    private DispatcherTimer? _onlineRetryTimer;
    private int _onlineRetryAttempts;

    /// <summary>
    /// 主页面创建好的 WebView2 环境。桌面背景歌词的第二个窗口要复用它：同一个 user data folder
    /// 意味着同一个站点存储（localStorage 里的歌词样式/背景模式/偏移，两窗口自动共享）。
    /// </summary>
    public CoreWebView2Environment? SharedEnvironment { get; private set; }

    /// <summary>共享环境就绪通知（背景窗口可能比 WebView2 初始化更早被请求）。</summary>
    public event Action? SharedEnvironmentReady;

    /// <summary>页面首帧可用（页面发出 ready 或首次导航成功）：窗口用它从透明淡入。</summary>
    public event Action? FirstContentReady;

    /// <summary>
    /// 接管窗口四边/四角 5px 的缩放热区。WebView2 是子 HWND，WPF 的 WindowChrome 命中不到它；
    /// 旧实现把页面缩进 6px 露出主题色边条来换取可缩放——那条边就是用户看到的「框」。
    /// 现在页面满窗铺，pointerdown 在最外层捕获阶段换算成边/角后走既有的 resize 消息。
    /// 页面自己的交互优先：命中按钮/链接/输入框/滚动条时不再抢成窗口缩放。
    /// </summary>
    private const string EdgeResizeScript = """
(() => {
    if (window.top !== window) return;
    // 5px 边 / 12px 角是窗口缩放的抓取范围；页面满窗铺，热区只能由页面转发。
    const EDGE = 5;
    const CORNER = 12;
    const INTERACTIVE = 'button, a, input, textarea, select, [contenteditable="true"], [data-no-window-resize]';

    // 指针落在可滚动祖先的滚动条轨道上时不要当窗口缩放：右侧滚动条约 15px，
    // 会和 5px 的边缘热区重叠，否则拖滚动条会变成拖窗口。overflow:hidden 的裁剪容器
    // 没有滚动条，不能按 scrollHeight 误判（否则大块边缘热区会失效）。
    const isOverScrollbar = (event) => {
        for (let el = event.target instanceof Element ? event.target : null; el; el = el.parentElement) {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            const canScrollY = style.overflowY === 'auto' || style.overflowY === 'scroll';
            const canScrollX = style.overflowX === 'auto' || style.overflowX === 'scroll';
            if (canScrollY && el.scrollHeight > el.clientHeight &&
                event.clientX > rect.right - (el.offsetWidth - el.clientWidth)) {
                return true;
            }
            if (canScrollX && el.scrollWidth > el.clientWidth &&
                event.clientY > rect.bottom - (el.offsetHeight - el.clientHeight)) {
                return true;
            }
        }
        return false;
    };

    window.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.defaultPrevented) return;
        const width = window.innerWidth;
        const height = window.innerHeight;
        const x = event.clientX;
        const y = event.clientY;
        const left = x <= EDGE;
        const right = x >= width - EDGE;
        const top = y <= EDGE;
        const bottom = y >= height - EDGE;
        if (!(left || right || top || bottom)) return;

        // 页面边缘的交互元素优先：按钮/链接/输入框贴着边时不能被抢成窗口缩放。
        if (event.target instanceof Element && event.target.closest(INTERACTIVE)) {
            return;
        }
        if (isOverScrollbar(event)) return;

        let edge = '';
        if (left && y <= CORNER) edge = 'topleft';
        else if (right && y <= CORNER) edge = 'topright';
        else if (left && y >= height - CORNER) edge = 'bottomleft';
        else if (right && y >= height - CORNER) edge = 'bottomright';
        else if (left) edge = 'left';
        else if (right) edge = 'right';
        else if (top) edge = 'top';
        else if (bottom) edge = 'bottom';
        if (!edge) return;
        event.preventDefault();
        event.stopPropagation();
        window.chrome.webview.postMessage({ v: 1, type: 'resize', edge });
    }, true);
})();
""";

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
        _settings = settings;
        _audio = audio;
        _media = media;
        _airplay = airplay;
        _localMusic = new LocalMusicService(
            window,
            () => _webView.CoreWebView2,
            PostJson,
            settings is null ? null : () => settings.DownloadDirectory,
            settings is null ? null : () => settings.WatchLocalFolder);
        if (settings is not null)
        {
            // general 段变更（目录监控开关）需要即时生效；开机自启由 App 订阅同一事件处理。
            settings.GeneralChanged += OnGeneralSettingsChanged;
        }
        // 离线节拍分析（/api/analysis）需要把本地曲库 rel 解析成磁盘路径；回调来自分析线程池，
        // CreateLocalMusicService 之后才能接线，App.Online 在窗口创建前就已经 Start。
        if (App.Online is { } online)
        {
            online.LocalPathResolver = ResolveLocalTrackPathForAnalysis;
            // 标签写入成功后刷新曲库（回调来自 /api/local/tag 的 HTTP 线程，方法内部再切 UI）。
            online.LocalFileChanged = NotifyLocalFileChanged;
            // 登录状态检测（第四十六轮）：后台验证发现掉登录 → 推 account 事件并提醒。
            online.AccountSessionExpired += OnAccountSessionExpired;
        }
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
            // 首帧前 WebView2 自涂的背景：跟窗口主题底色（#F3F1EA）一致，避免启动/恢复时
            // 闪一块浅灰或纯白。页面 ready 后会按自身主题接管。
            _webView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 243, 241, 234);

            var userDataFolder = Path.Combine(HostFolders.Root, "WebView2");
            // 设置页「清理浏览器缓存」在运行期只能写标记，这里在环境创建前真正删掉。
            Zilux2.Storage.CacheService.ClearPendingWebView2();
            Directory.CreateDirectory(userDataFolder);

            HostLog.Info($"webview2 environment creating: udf={userDataFolder} dev={_plan.IsDevMode}");
            var options = new CoreWebView2EnvironmentOptions(BrowserArguments);
            var environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder, options);
            if (_disposed)
            {
                return;
            }

            HostLog.Info($"webview2 runtime: {environment.BrowserVersionString}");
            SharedEnvironment = environment;
            SharedEnvironmentReady?.Invoke();
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
            // 播放器不是浏览器：触摸板 / 触屏的双指捏合缩放与 Ctrl+滚轮缩放都会把整个界面放大，
            // 且缩放会被 WebView2 按站点记住，误触后很难恢复，这里统一关掉并把缩放归位。
            core.Settings.IsPinchZoomEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            _webView.ZoomFactor = 1.0;
            HostLog.Info($"webview2 zoom disabled pinch={core.Settings.IsPinchZoomEnabled} control={core.Settings.IsZoomControlEnabled} factor={_webView.ZoomFactor:0.00}");

            core.WebMessageReceived += OnWebMessageReceived;
            core.ProcessFailed += OnProcessFailed;
            core.NavigationStarting += OnNavigationStarting;
            core.NavigationCompleted += OnNavigationCompleted;
            core.NewWindowRequested += OnNewWindowRequested;
            core.PermissionRequested += OnPermissionRequested;

            // 设置页的「打开 DevTools」入口（/api/host/devtools）。发布版平时关闭 DevTools，
            // 只有用户主动点击时才临时打开；回调线程在 HTTP 侧，宿主实现里切回 UI 线程。
            if (App.Online is { } onlineService)
            {
                onlineService.OpenDevTools = OpenDevToolsWindow;
            }

            // 注入窗口边缘缩放监听（见 EdgeResizeScript 注释）。失败只损失贴边缩放，不阻断启动。
            try
            {
                var scriptId = await core.AddScriptToExecuteOnDocumentCreatedAsync(EdgeResizeScript);
                HostLog.Info($"webview2.edgeResize injected id={scriptId}");
            }
            catch (Exception exception)
            {
                HostLog.Warn($"webview2.edgeResize inject failed: {exception.Message}");
            }

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

    private void RaiseFirstContentReady()
    {
        if (_firstContentReady)
        {
            return;
        }

        _firstContentReady = true;
        HostLog.Info("webview2.firstContent");
        FirstContentReady?.Invoke();
    }

    /// <summary>
    /// WebView2 的合成表面在窗口从最小化恢复 / 托盘隐藏后重新显示时，偶尔不会重画（用户看到
    /// 底框、内容不出来）。把控件尺寸做一次 1px 抖动并重排，强制子 HWND 收到 resize 并重绘；
    /// 220ms 后再抖一次，覆盖 DWM 还原动画结束的那一帧。
    /// </summary>
    public void RefreshSurface()
    {
        if (_disposed || _webView.Visibility != Visibility.Visible)
        {
            return;
        }

        NudgeSurface();
        var timer = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(220),
        };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            NudgeSurface();
        };
        timer.Start();
    }

    private void NudgeSurface()
    {
        if (_disposed)
        {
            return;
        }

        var width = _webView.ActualWidth;
        var height = _webView.ActualHeight;
        if (width <= 1 || height <= 1)
        {
            return;
        }

        _webView.Width = width + 1;
        _webView.Height = height + 1;
        _webView.Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(() =>
        {
            if (_disposed)
            {
                return;
            }

            _webView.Width = double.NaN;
            _webView.Height = double.NaN;
            _webView.InvalidateVisual();
        }));
        HostLog.Info($"webview2.surface nudge {width:0.#}x{height:0.#}");
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
        if (action is not ("togglePlay" or "prev" or "next" or "volumeUp" or "volumeDown" or "mute" or "like"
            or "mode" or "mini" or "desktopLyrics" or "crossfade" or "stop" or "openSettings"))
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

    /// <summary>
    /// 离线节拍分析（/api/analysis）的本地曲目路径解析。分析请求跑在 HTTP 线程池里，而
    /// LocalMusicService.ResolveTrackPath 会触发 EnsureDownloadFolder → RescanDownloads →
    /// PostMergedTracks，必须在 UI 线程执行，否则会跨线程碰页面推送与曲库状态。
    /// </summary>
    private string? ResolveLocalTrackPathForAnalysis(string? rel)
    {
        if (string.IsNullOrWhiteSpace(rel))
        {
            return null;
        }

        try
        {
            if (_disposed)
            {
                return null;
            }

            if (_window.Dispatcher.CheckAccess())
            {
                return _localMusic.ResolveTrackPath(rel);
            }

            return _window.Dispatcher.Invoke(() => _localMusic.ResolveTrackPath(rel));
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[analysis] local path resolve failed rel={rel}: {exception.Message}");
            return null;
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        StopOnlineRetry();
        if (_settings is not null)
        {
            _settings.GeneralChanged -= OnGeneralSettingsChanged;
        }

        // 先断开分析用的本地路径解析，避免本地曲库 Dispose 后分析线程还回调进来。
        if (App.Online is { } online)
        {
            online.LocalPathResolver = null;
            online.LocalFileChanged = null;
            online.AccountSessionExpired -= OnAccountSessionExpired;
        }

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
            // HwndHost 终结器在 controller 句柄失效后会抛 COM 异常并带走进程（B25）。
            GC.SuppressFinalize(_webView);
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

    /// <summary>
    /// 打开 DevTools（/api/host/devtools 的实现）。发布版平时关着 DevTools，只允许用户在设置里
    /// 主动点一次开；回调来自 HTTP 线程，这里切回 UI 线程并临时启用。
    /// </summary>
    private void OpenDevToolsWindow()
    {
        try
        {
            _webView.Dispatcher.Invoke(() =>
            {
                var core = _webView.CoreWebView2;
                if (core is null)
                {
                    return;
                }

                core.Settings.AreDevToolsEnabled = true;
                core.OpenDevToolsWindow();
                HostLog.Info("webview2.devtools opened");
            });
        }
        catch (Exception exception)
        {
            HostLog.Warn($"webview2.devtools open failed: {exception.Message}");
        }
    }

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
            // 契约 §12：AirPlay 单条消息 ≤8KB（整体 64KB 上限保留给 local 等批量通道）。
            if (string.Equals(type, "airplay", StringComparison.Ordinal) && json.Length > MaxAirPlayMessageChars)
            {
                HostLog.Warn($"webview2.message rejected: airplay too large ({json.Length} chars, limit {MaxAirPlayMessageChars})");
                return;
            }

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
                    // 迷你播放器：宿主启动时若已经处于迷你态（例如后续把该状态持久化），
                    // 页面 ready 后补推一次，让前端渲染迷你布局。
                    if (_window.IsMiniMode)
                    {
                        NotifyMiniMode(true);
                    }

                    RaiseFirstContentReady();
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
                    // 桌面背景歌词窗口没有自己的播放引擎：把主页面这一份媒体快照原样转发过去。
                    _window.ForwardToBackgroundLyrics(json);
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

                case "lyrics":
                    // 桌面歌词只推「当前句 + 翻译」，窗口的开关/字号/锁定/置顶由设置驱动。
                    _window.UpdateDesktopLyrics(
                        ReadString(root, "now") ?? string.Empty,
                        ReadString(root, "translation") ?? string.Empty);
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

            case "miniMode":
                // 迷你播放器模式（契约 §15）：页面只发目标状态，尺寸可选；窗口细节全在
                // MainWindow.SetMiniMode 里，成功后由宿主回推 window/miniMode 事件。
                var miniEnabled = ReadBool(root, "enabled", false);
                var miniWidth = ReadFiniteDouble(root, "width");
                var miniHeight = ReadFiniteDouble(root, "height");
                HostLog.Info($"window.action miniMode enabled={miniEnabled} width={miniWidth} height={miniHeight}");
                _window.SetMiniMode(miniEnabled, miniWidth, miniHeight);
                break;

            default:
                HostLog.Warn($"window.action ignored: {action ?? "<missing>"}");
                break;
        }
    }

    /// <summary>把迷你态同步给页面：{v:1,type:'window',event:'miniMode',enabled:bool}。</summary>
    public void NotifyMiniMode(bool enabled)
    {
        if (!_pageReady)
        {
            // 页面还没 ready：ready 处理里会按当前窗口状态补推一次。
            return;
        }

        PostJson("{\"v\":1,\"type\":\"window\",\"event\":\"miniMode\",\"enabled\":" +
                 (enabled ? "true" : "false") + "}");
    }

    /// <summary>general 段变化：目录监控开关即时生效（开机自启在 App 里处理）。</summary>
    private void OnGeneralSettingsChanged()
    {
        var settings = _settings;
        if (settings is null || _disposed)
        {
            return;
        }

        try
        {
            _localMusic.SetWatchEnabled(settings.WatchLocalFolder);
        }
        catch (Exception exception)
        {
            HostLog.Error("[settings] watchLocalFolder apply failed", exception);
        }

        // 系统媒体控制开关：即时挂上/摘下 SMTC，不用重启应用。
        try
        {
            if (settings.MediaSessionEnabled)
            {
                _media?.Enable(_window.Handle);
            }
            else
            {
                _media?.Disable();
            }
        }
        catch (Exception exception)
        {
            HostLog.Error("[settings] mediaSession apply failed", exception);
        }

        // 桌面歌词窗口：开关/字号/锁定/置顶改动即时应用。
        try
        {
            _window.ApplyDesktopLyricsSettings();
        }
        catch (Exception exception)
        {
            HostLog.Error("[settings] desktopLyrics apply failed", exception);
        }

        // 桌面背景歌词：开关即时创建/销毁壁纸层窗口。
        try
        {
            _window.ApplyBackgroundLyricsSettings();
        }
        catch (Exception exception)
        {
            HostLog.Error("[settings] backgroundLyrics apply failed", exception);
        }

        // 非页面发起的设置改动（旧桌面歌词窗右键关闭、宿主侧写入等）也要补推快照：
        // 页面靠它回读，否则设置页/快捷面板显示与真实值分叉，下一次点击会用旧值覆盖。
        if (_pageReady)
        {
            PostSettingsSnapshot();
        }
    }

    /// <summary>本地标签写入成功：让曲库刷新该文件（回调来自 HTTP 线程，必须切回 UI）。</summary>
    private void NotifyLocalFileChanged(string path)
    {
        if (_disposed || string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        try
        {
            var dispatcher = _window.Dispatcher;
            if (dispatcher.HasShutdownStarted || dispatcher.HasShutdownFinished)
            {
                return;
            }

            if (dispatcher.CheckAccess())
            {
                _localMusic.NotifyTagWritten(path);
                return;
            }

            dispatcher.BeginInvoke(
                DispatcherPriority.Background,
                new Action(() =>
                {
                    if (!_disposed)
                    {
                        _localMusic.NotifyTagWritten(path);
                    }
                }));
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] tag refresh dispatch failed: {exception.Message}");
        }
    }

    // 登录状态检测（第四十六轮）：某个平台的 cookie 被平台判定失效、账号被清掉后，
    // 把最新账号列表（该平台带 expired=true / reason）推给页面弹提醒；窗口在托盘时再补系统气泡。
    private void OnAccountSessionExpired(string source)
    {
        if (_disposed)
        {
            return;
        }

        try
        {
            var message = new HostAccountMessage { Payload = BuildExpiredAccountList(source) };
            PostJsonFromAnyThread(JsonSerializer.Serialize(message, AccountJsonContext.Default.HostAccountMessage));
            if (_window.IsHiddenToTray)
            {
                App.Tray?.NotifyAccountExpired(source);
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[account] expired push failed source={source}: {exception.Message}");
        }
    }

    private static AccountListResponse BuildExpiredAccountList(string expiredSource)
    {
        if (App.Online is not { } online)
        {
            return new AccountListResponse();
        }

        var list = online.Accounts.BuildAccountList();
        for (var index = 0; index < list.Sources.Count; index++)
        {
            var item = list.Sources[index];
            if (!string.Equals(item.Source, expiredSource, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            list.Sources[index] = new AccountInfo
            {
                Source = item.Source,
                LoggedIn = item.LoggedIn,
                Expired = true,
                Reason = "登录已失效，请重新登录",
            };
        }

        return list;
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
        StopOnlineRetry();
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
            return;
        }

        // 页面没发 ready（例如前端脚本报错）也不能让窗口永远透明：导航成功本身就是可显示内容。
        RaiseFirstContentReady();
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
                if (_onlineRetryAttempts == 0)
                {
                    HostLog.Warn(
                        "[online] endpoint unavailable, page gets no online sources" +
                        (string.IsNullOrEmpty(online?.FailureMessage) ? string.Empty : $": {online.FailureMessage}"));
                }

                StartOnlineRetry();
                return;
            }

            StopOnlineRetry();
            var message = new HostOnlineMessage { Payload = online.BuildEventPayload() };
            var json = JsonSerializer.Serialize(message, OnlineJsonContext.Default.HostOnlineMessage);
            PostJson(json);
            // 背景歌词是第二个 WebView，主页面通道收不到 online；同一份 JSON 转给背景窗，
            // 场景页 initOnline 才会拿到端口/token（B04）。窗口未开时由 MainWindow 缓存待发。
            _window.ForwardOnlineToBackgroundLyrics(json);
            HostLog.Info(
                $"[online] endpoint sent to page port={online.Endpoint.Port} " +
                $"tokenLen={online.Endpoint.Token.Length} sources={string.Join(",", online.Endpoint.Sources)}");
        }
        catch (Exception exception)
        {
            HostLog.Error("[online] endpoint push failed", exception);
        }
    }

    /// <summary>
    /// 启动早期在线源端点可能还没就绪；页面只会收到一次 online 推送，错过就会一直 not-ready，
    /// 所以在页面 ready 后按固定间隔重试，端点就绪即补推，超时后放弃并记一条日志。
    /// </summary>
    private void StartOnlineRetry()
    {
        if (_disposed || _onlineRetryTimer is not null || _onlineRetryAttempts >= OnlineRetryLimit)
        {
            return;
        }

        var timer = new DispatcherTimer(DispatcherPriority.Background, _webView.Dispatcher)
        {
            Interval = TimeSpan.FromMilliseconds(OnlineRetryIntervalMs),
        };
        timer.Tick += OnOnlineRetryTick;
        _onlineRetryTimer = timer;
        timer.Start();
    }

    private void OnOnlineRetryTick(object? sender, EventArgs e)
    {
        _onlineRetryAttempts++;
        if (App.Online?.Endpoint is not null)
        {
            StopOnlineRetry();
            PostOnlineInfo();
            return;
        }

        if (_onlineRetryAttempts >= OnlineRetryLimit)
        {
            StopOnlineRetry();
            HostLog.Warn("[online] endpoint still unavailable after retry window");
        }
    }

    private void StopOnlineRetry()
    {
        if (_onlineRetryTimer is null)
        {
            _onlineRetryAttempts = 0;
            return;
        }

        _onlineRetryTimer.Stop();
        _onlineRetryTimer.Tick -= OnOnlineRetryTick;
        _onlineRetryTimer = null;
        _onlineRetryAttempts = 0;
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

        // appearance.miniSize / miniAlwaysOnTop 没有独立事件：每次设置消息后让迷你态原地重排（P3-12）。
        _window.ApplyMiniSettingsIfActive();
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
        // 页面播放状态变化 → 托盘菜单文案同步（B23）；消息入口已在 UI 线程。
        _window.NotifyPlaybackState(state.Playing);
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
        if (_settings?.MediaSessionEnabled == false)
        {
            _media?.Disable();
            return;
        }

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

            case "captureError":
                // The page could not start its audio tap: the receiver is connected but would
                // only ever get silence. End the session and surface the documented code.
                airplay.ReportCaptureFailure(ReadString(root, "error"));
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
                if (!root.TryGetProperty("percent", out var percentElement) || percentElement.ValueKind == JsonValueKind.Null)
                {
                    HostLog.Warn("[airplay] volume ignored: missing percent (keep current)");
                    return;
                }

                if (!percentElement.TryGetInt32(out var percent))
                {
                    percent = _airplay.Status.VolumePercent;
                    HostLog.Warn($"[airplay] volume invalid: fallback to {percent}");
                }
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

            case "cancelConnect":
            {
                var cancelDeviceId = ReadString(root, "deviceId");
                if (string.IsNullOrWhiteSpace(cancelDeviceId))
                {
                    HostLog.Warn("[airplay] cancelConnect ignored: missing deviceId");
                    return;
                }

                HostLog.Info($"[airplay] action cancelConnect device={cancelDeviceId}");
                _ = CancelConnectAirPlayAsync(cancelDeviceId);
                break;
            }

            case "flush":
                // pause/seek/trackchange：丢弃接收端已排队的音频（P1-25）；不阻塞 UI。
                _ = FlushAirPlayAsync();
                break;

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

    /// <summary>AirPlay FLUSH：Fire-and-forget，异常只记 Warn，不能阻塞 UI 线程。</summary>
    private async Task FlushAirPlayAsync()
    {
        var airplay = _airplay;
        if (airplay is null)
        {
            return;
        }

        try
        {
            await airplay.FlushAsync().ConfigureAwait(false);
            HostLog.Info("[airplay] action flush");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[airplay] flush failed: {exception.Message}");
        }
    }

    /// <summary>AirPlay 取消配对：Fire-and-forget，异常只记 Warn，不能阻塞 UI 线程。</summary>
    private async Task CancelConnectAirPlayAsync(string deviceId)
    {
        var airplay = _airplay;
        if (airplay is null)
        {
            return;
        }

        try
        {
            await airplay.CancelConnectAsync(deviceId).ConfigureAwait(false);
            HostLog.Info($"[airplay] cancelConnect done device={deviceId}");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[airplay] cancelConnect failed: {exception.Message}");
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
            foreach (var device in status.Devices.OrderBy(device => device.Name, StringComparer.OrdinalIgnoreCase).Take(32))
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
                var activeVolume = status.VolumePercent;
                foreach (var item in status.Actives)
                {
                    if (string.Equals(item.Id, activeId, StringComparison.Ordinal))
                    {
                        activeVolume = item.VolumePercent;
                        break;
                    }
                }

                active = new JsonObject
                {
                    ["id"] = activeId,
                    ["name"] = status.ActiveDeviceName ?? string.Empty,
                    ["volume"] = activeVolume,
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
            // 合成文档可能不报 source；主通道只接受带来源的消息，避免空来源绕过 allow-list（B18）。
            return false;
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

    private static bool ReadBool(JsonElement root, string name, bool fallback) =>
        root.TryGetProperty(name, out var element) && element.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? element.GetBoolean()
            : fallback;

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
