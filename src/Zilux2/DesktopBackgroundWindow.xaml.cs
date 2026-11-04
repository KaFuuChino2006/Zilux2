using System;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Zilux2.Interop;
using Zilux2.Settings;

namespace Zilux2;

/// <summary>
/// 桌面背景歌词：一块铺在桌面壁纸层里的 WebView2，渲染歌词页的播放效果。
/// 它不做播放，只是把主页面推来的媒体快照与共享站点存储里的歌词文档演出来。
///
/// 挂载方式（实测于 Win11 26H2：本机没有可用 WorkerW）：
/// 先改成 WS_CHILD，再 SetParent 到 Progman，最后 SetWindowPos 插到图标层
/// SHELLDLL_DefView 的正下方 —— 于是它渲染在「桌面图标之下、真实壁纸之上」。
/// 用 WorkerW 的经典做法仍保留为备用路径，找不到时回退到普通全屏窗口。
/// </summary>
public sealed partial class DesktopBackgroundWindow : Window
{
    private const int GwlStyle = -16;
    private const int GwlExStyle = -20;

    private const long WsChild = 0x40000000L;
    private const long WsVisible = 0x10000000L;
    private const long WsPopup = unchecked((long)0x80000000);
    private const long WsCaption = 0x00C00000L;
    private const long WsThickFrame = 0x00040000L;

    private const long WsExNoActivate = 0x08000000L;
    private const long WsExTransparent = 0x00000020L;
    private const long WsExToolWindow = 0x00000080L;

    private const uint GaParent = 1;

    private const int SmCxScreen = 0;
    private const int SmCyScreen = 1;
    private const int SmXVirtualScreen = 76;
    private const int SmYVirtualScreen = 77;
    private const int SmCxVirtualScreen = 78;
    private const int SmCyVirtualScreen = 79;

    private const uint SwpNoActivate = 0x0010;
    private const uint SwpFrameChanged = 0x0020;
    private const uint SwpShowWindow = 0x0040;

    private const int WmSpawnWorkerW = 0x052C;
    private const uint SmtoNormal = 0x0000;

    private readonly CoreWebView2Environment _environment;
    private readonly SettingsService _settings;
    private readonly WebContentPlan _plan;
    private bool _disposed;

    internal DesktopBackgroundWindow(CoreWebView2Environment environment, SettingsService settings, WebContentPlan plan)
    {
        _environment = environment;
        _settings = settings;
        _plan = plan;
        InitializeComponent();
        Loaded += OnLoaded;
        Closed += OnClosed;
    }

    private async void OnLoaded(object? sender, RoutedEventArgs e)
    {
        Loaded -= OnLoaded;
        try
        {
            await Browser.EnsureCoreWebView2Async(_environment);
            var core = Browser.CoreWebView2;

            // 页面本身是透明的：真实壁纸从桌面层透出来，只有歌词和效果叠在上面。
            Browser.DefaultBackgroundColor = System.Drawing.Color.Transparent;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            if (_plan.Kind == WebContentKind.LocalFolder && !string.IsNullOrEmpty(_plan.FolderPath))
            {
                core.SetVirtualHostNameToFolderMapping(
                    WebContentPlan.VirtualHost,
                    _plan.FolderPath,
                    CoreWebView2HostResourceAccessKind.Allow);
            }

            core.WebMessageReceived += OnWebMessageReceived;
            var separator = _plan.NavigationUrl.Contains('?') ? "&" : "?";
            core.Navigate(_plan.NavigationUrl + separator + "scene=backgroundLyrics");
            HostLog.Info($"[bgLyrics] navigate {_plan.NavigationUrl}{separator}scene=backgroundLyrics");

            // WebView2 初始化完成后再 reparent：先建子 HWND 再换父窗口，尺寸与合成都更稳。
            AttachToDesktop();
        }
        catch (Exception exception)
        {
            HostLog.Error("[bgLyrics] webview init failed", exception);
        }
    }

    /// <summary>显示器/分辨率变化后重新铺满虚拟桌面；重复调用是幂等的。</summary>
    internal void RepositionToDesktop()
    {
        if (_disposed)
        {
            return;
        }

        AttachToDesktop();
    }

    private void AttachToDesktop()
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero || _disposed)
        {
            return;
        }

        var appliedStyles = ApplyOverlayStyles(handle);

        var (parent, insertAfter) = FindDesktopHost();
        if (parent == IntPtr.Zero)
        {
            // 找不到 Progman（极少见）：退化成普通全屏窗口，至少歌词能看见。
            PlaceOnVirtualScreen(handle);
            HostLog.Warn("[bgLyrics] desktop host not found, fallback to plain window");
            return;
        }

        // 先改 WS_CHILD 再 SetParent，顺序反了样式/坐标不会生效（探针实测）。
        NativeMethods.SetParent(handle, parent);
        var actualParent = NativeMethods.GetAncestor(handle, GaParent);

        // 只铺主屏：歌词画布按窗口尺寸布局，跨 3 屏会导致歌词落在虚拟桌面正中（可能是屏幕缝隙里）。
        var width = Math.Max(1, NativeMethods.GetSystemMetrics(SmCxScreen));
        var height = Math.Max(1, NativeMethods.GetSystemMetrics(SmCyScreen));

        // SetParent 之后坐标是父客户区坐标：主屏左上角 (0,0) 要减去 Progman 客户区原点 (-1080,-1440)。
        var origin = new NativeMethods.Point { X = 0, Y = 0 };
        if (!NativeMethods.ClientToScreen(parent, ref origin))
        {
            origin.X = 0;
            origin.Y = 0;
        }

        var placed = NativeMethods.SetWindowPos(
            handle,
            insertAfter,
            -origin.X,
            -origin.Y,
            width,
            height,
            SwpNoActivate | SwpFrameChanged | SwpShowWindow);

        HostLog.Info(
            $"[bgLyrics] attached to desktop parent={parent} insertAfter={insertAfter} actualParent={actualParent} styleChanged={appliedStyles} {width}x{height} at {-origin.X},{-origin.Y} placed={placed}");
    }

    private static bool ApplyOverlayStyles(IntPtr handle)
    {
        var style = NativeMethods.GetWindowLongPtr(handle, GwlStyle).ToInt64();
        var newStyle = (style & ~(WsPopup | WsCaption | WsThickFrame)) | WsChild | WsVisible;
        var exStyle = NativeMethods.GetWindowLongPtr(handle, GwlExStyle).ToInt64();
        var newExStyle = exStyle | WsExNoActivate | WsExTransparent | WsExToolWindow;
        if (newStyle == style && newExStyle == exStyle)
        {
            return false;
        }

        NativeMethods.SetWindowLongPtr(handle, GwlStyle, new IntPtr(newStyle));
        NativeMethods.SetWindowLongPtr(handle, GwlExStyle, new IntPtr(newExStyle));
        return true;
    }

    private static void PlaceOnVirtualScreen(IntPtr handle)
    {
        var x = NativeMethods.GetSystemMetrics(SmXVirtualScreen);
        var y = NativeMethods.GetSystemMetrics(SmYVirtualScreen);
        var width = Math.Max(1, NativeMethods.GetSystemMetrics(SmCxVirtualScreen));
        var height = Math.Max(1, NativeMethods.GetSystemMetrics(SmCyVirtualScreen));
        NativeMethods.SetWindowPos(handle, IntPtr.Zero, x, y, width, height, SwpNoActivate | SwpShowWindow | SwpFrameChanged);
        HostLog.Info($"[bgLyrics] plain window placed at {x},{y} {width}x{height}");
    }

    /// <summary>
    /// 找桌面层宿主：优先「Progman 下的 SHELLDLL_DefView」，把窗口插到它正下方；
    /// 旧版 Windows 上 DefView 挂在 WorkerW 下时，退而使用 WorkerW 经典路径。
    /// </summary>
    private static (IntPtr Parent, IntPtr InsertAfter) FindDesktopHost()
    {
        var progman = NativeMethods.FindWindow("Progman", null);
        if (progman != IntPtr.Zero)
        {
            // 0x052C 让 Explorer 在 Wallpaper 下生出一个 WorkerW；本机没有效果，调用无害。
            NativeMethods.SendMessageTimeout(progman, WmSpawnWorkerW, IntPtr.Zero, IntPtr.Zero, SmtoNormal, 1000, out _);

            var defViewUnderProgman = NativeMethods.FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (defViewUnderProgman != IntPtr.Zero)
            {
                return (progman, defViewUnderProgman);
            }
        }

        var defViewHost = IntPtr.Zero;
        var defView = IntPtr.Zero;
        NativeMethods.EnumWindows((hwnd, _) =>
        {
            var view = NativeMethods.FindWindowEx(hwnd, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (view != IntPtr.Zero)
            {
                defViewHost = hwnd;
                defView = view;
                return false;
            }

            return true;
        }, IntPtr.Zero);

        if (defViewHost != IntPtr.Zero)
        {
            // 经典做法：图标层宿主之后的同辈 WorkerW 才是壁纸层。
            var worker = NativeMethods.FindWindowEx(IntPtr.Zero, defViewHost, "WorkerW", null);
            if (worker != IntPtr.Zero)
            {
                return (worker, IntPtr.Zero);
            }

            return (defViewHost, defView);
        }

        return (IntPtr.Zero, IntPtr.Zero);
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return;
            }

            var type = root.TryGetProperty("type", out var typeElement) && typeElement.ValueKind == JsonValueKind.String
                ? typeElement.GetString()
                : null;
            if (type == "ready")
            {
                PostSnapshot();
                return;
            }

            if (type == "settings")
            {
                var action = root.TryGetProperty("action", out var actionElement) && actionElement.ValueKind == JsonValueKind.String
                    ? actionElement.GetString()
                    : null;
                if (action == "request" || action == "patch")
                {
                    if (action == "patch" && root.TryGetProperty("patch", out var patch) && patch.ValueKind == JsonValueKind.Object)
                    {
                        _settings.Patch(patch);
                    }

                    PostSnapshot();
                }

                return;
            }

            if (type == "log")
            {
                var level = root.TryGetProperty("level", out var levelElement) && levelElement.ValueKind == JsonValueKind.String
                    ? levelElement.GetString()
                    : "info";
                var message = root.TryGetProperty("message", out var messageElement) && messageElement.ValueKind == JsonValueKind.String
                    ? messageElement.GetString()
                    : string.Empty;
                HostLog.Info($"[bgLyrics:web] {level}: {message}");
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[bgLyrics] message ignored: {exception.Message}");
        }
    }

    private void PostSnapshot()
    {
        PostJson(_settings.CreateSnapshotJson());
    }

    internal void PostJson(string json)
    {
        if (_disposed)
        {
            return;
        }

        try
        {
            // CoreWebView2 的 getter 本身也可能在 controller 失效时抛 COM 异常（Explorer 重启后）。
            var core = Browser.CoreWebView2;
            if (core is null)
            {
                return;
            }

            core.PostWebMessageAsJson(json);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[bgLyrics] post failed: {exception.Message}");
        }
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        _disposed = true;
        DisposeBrowser();
    }

    /// <summary>
    /// 主动释放 WebView2，并在 HWND 已被外部销毁（Explorer 重启会连带销毁子窗口）时抑制
    /// HwndHost 的终结器：它会在终结器线程里调用 CoreWebView2Controller.get_CoreWebView2()，
    /// COM controller 已失效时抛 InvalidCastException，直接终结整个进程（见 host.log
    /// unhandled.appdomain 的 HwndHost.Finalize 栈）。
    /// </summary>
    internal void DisposeBrowser()
    {
        try
        {
            Browser.Dispose();
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[bgLyrics] browser dispose failed: {exception.Message}");
        }

        try
        {
            GC.SuppressFinalize(Browser);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[bgLyrics] browser finalizer suppress failed: {exception.Message}");
        }
    }
}
