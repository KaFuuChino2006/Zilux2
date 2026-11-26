using System;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Zilux2.Interop;

namespace Zilux2.Wallpaper.Render;

/// <summary>
/// 桌面壁纸层：一块挂在桌面图标之下的 WebView2，用同一个页面里的
/// &lt;video&gt; 播壁纸 —— 和软件内壁纸走完全相同的渲染路径。
///
/// 为什么不再用 WPF 位图：WorkerW/Progman 里也放得下 WebView2（桌面背景歌词已经
/// 这么干了一年），而 WPF 位图管线要 app 自己把 8MB/帧写屏，半分辨率 30fps 就要
/// 100%+ CPU；交给 Chromium 硬解只有个位数。
///
/// 挂载顺序（实测）：先改 WS_CHILD → SetParent(Progman) → SetWindowPos 插到
/// SHELLDLL_DefView 正下方。顺序反了样式与坐标都不生效。
/// </summary>
internal sealed partial class DesktopWebSurface : IDisposable
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

    private const int SmCxScreen = 0;
    private const int SmCyScreen = 1;

    private const uint SwpNoActivate = 0x0010;
    private const uint SwpFrameChanged = 0x0020;
    private const uint SwpShowWindow = 0x0040;

    private const int WmSpawnWorkerW = 0x052C;
    private const uint SmtoNormal = 0x0000;
    /// <summary>SetWindowPos 的 HWND_BOTTOM：把窗口压到同级窗口最底层。</summary>
    private static readonly IntPtr HwndBottom = new(1);

    private readonly CoreWebView2Environment _environment;
    private readonly string _navigationUrl;
    private readonly string? _folderPath;
    private readonly string? _virtualHost;
    private readonly Window _window;
    private readonly WebView2 _browser;
    private readonly System.Windows.Threading.DispatcherTimer _health;

    private IntPtr _hostHandle = IntPtr.Zero;
    private bool _attached;
    private bool _disposed;

    /// <summary>这块表面负责的屏（物理像素，虚拟屏坐标系）；空 = 铺满整个虚拟屏。</summary>
    private System.Drawing.Rectangle _bounds;

    /// <summary>
    /// 窗口已经 Show 出来了，但还没搬进桌面层（页面还在加载）。
    /// 这期间它停在屏幕外，别人看不到；等页面报第一帧再搬进来。
    /// </summary>
    private bool _pendingAttach;

    /// <summary>兜底：页面迟迟不报 ready 也要搬进来，否则壁纸永远不出现。</summary>
    private System.Windows.Threading.DispatcherTimer? _attachFallback;

    /// <summary>连续「找不到桌面宿主」的次数，只用于把重试日志降频。</summary>
    private int _attachFailCount;

    public DesktopWebSurface(
        CoreWebView2Environment environment,
        string navigationUrl,
        string? folderPath = null,
        string? virtualHost = null,
        System.Drawing.Rectangle bounds = default)
    {
        _environment = environment;
        _navigationUrl = navigationUrl;
        _folderPath = folderPath;
        _virtualHost = virtualHost;
        _bounds = bounds;

        _browser = new WebView2
        {
            Margin = new Thickness(0),
            // 透明底：页面首帧出来之前这层什么都不画，桌面图标下面露的是系统壁纸，
            // 而不是一块黑。原来写 Black，就是「打开壁纸先黑一下」的来源。
            DefaultBackgroundColor = System.Drawing.Color.Transparent,
        };

        _window = new Window
        {
            Title = "Zilux2 桌面壁纸",
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            ShowInTaskbar = false,
            ShowActivated = false,
            Topmost = false,
            AllowsTransparency = false,
            // 不能给不透明底色：Show() 时 WebView2 还没画出第一帧，窗口自己那层底
            // 会先在桌面上闪一个黑方块。页面与浏览器 backing 都是透明的，这里也必须透明。
            Background = Brushes.Transparent,
            WindowStartupLocation = WindowStartupLocation.Manual,
            // 先在屏幕外 Show：WebView2 需要一个真实 HWND 才能初始化，
            // 但屏幕外那一块谁都看不见 —— 等页面报第一帧再搬回桌面层。
            // 这样「窗口可见」和「已经有画面」在时间上是同一刻，黑方块无从产生。
            Left = -32000,
            Top = -32000,
            Width = 800,
            Height = 600,
            Content = _browser,
        };

        // 桌面可能被 Explorer 重启踢掉父子关系，5 秒看一次，断了就重挂。
        _health = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        _health.Tick += (_, _) => EnsureAttached();
    }

    /// <summary>页面是否已经能收消息（CoreWebView2 就绪）。</summary>
    public bool IsReady => !_disposed && _browser.CoreWebView2 is not null;

    /// <summary>
    /// 页面脚本跑起来后主动来要一次状态。
    /// 宿主在建这块 WebView2 时就会推一次，那一次几乎必然早于页面就绪而丢掉
    /// （PostWebMessageAsJson 在 CoreWebView2 就绪前直接被 return），所以要有这个回补。
    /// </summary>
    public event Action? PageReady;

    /// <summary>初始化 WebView2、导航到壁纸场景、挂到桌面层下方。</summary>
    public async Task<bool> StartAsync()
    {
        if (_disposed)
        {
            return false;
        }

        try
        {
            // 必须在 Ensure 之前 Show：WebView2 要窗口真正有 HWND 才会初始化，
            // 窗口藏着不显示时 EnsureCoreWebView2Async 会一直等下去（曾经卡死在这里）。
            // 此刻窗口在屏幕外（Left/Top = -32000），没人看得见。
            _window.Show();
            await _browser.EnsureCoreWebView2Async(_environment);
            if (_disposed || _browser.CoreWebView2 is null)
            {
                return false;
            }

            _browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            _browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _browser.CoreWebView2.Settings.AreDevToolsEnabled = false;

            // 这块 WebView2 是独立实例，虚拟主机映射得自己再注册一次 —— 主窗口那份
            // 不会自动继承，漏了就是「https://zilux2.local 打不开」的空白页。
            if (!string.IsNullOrWhiteSpace(_folderPath) && !string.IsNullOrWhiteSpace(_virtualHost))
            {
                _browser.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    _virtualHost,
                    _folderPath!,
                    CoreWebView2HostResourceAccessKind.Allow);
            }

            _browser.CoreWebView2.WebMessageReceived += (_, args) =>
            {
                try
                {
                    var text = args.WebMessageAsJson;
                    if (text.Contains("wallpaperReady", StringComparison.Ordinal))
                    {
                        // 页面说它第一帧已经画好了 —— 现在把窗口从屏幕外搬进桌面层，
                        // 观众看到的是已经有画面的窗口，不是一块空底。
                        AttachIfPending();
                        PageReady?.Invoke();
                    }
                }
                catch (Exception exception)
                {
                    HostLog.Warn($"[wallpaper] desktop message failed: {exception.Message}");
                }
            };

            // 渲染进程被杀（显存吃紧、驱动重置）时画面会停在最后一帧，看起来就是
            // 「壁纸自己停了」。这里记一笔并把页面重新载回来，状态由 PageReady 重推。
            _browser.CoreWebView2.ProcessFailed += (_, args) =>
            {
                HostLog.Warn($"[wallpaper] desktop surface process failed kind={args.ProcessFailedKind}");
                try
                {
                    _browser.CoreWebView2.Reload();
                }
                catch (Exception exception)
                {
                    HostLog.Error("[wallpaper] desktop surface reload failed", exception);
                }
            };

            var separator = _navigationUrl.Contains('?') ? '&' : '?';
            _browser.CoreWebView2.Navigate($"{_navigationUrl}{separator}scene=wallpaper");

            // 窗口在 Ensure 之前就已经 Show 出来了（屏幕外）；这里只登记「等页面 ready
            // 再搬进桌面层」，搬之前它一直待在屏幕外。
            _pendingAttach = true;
            _attachFallback = new System.Windows.Threading.DispatcherTimer
            {
                Interval = TimeSpan.FromSeconds(2.5),
            };
            _attachFallback.Tick += (_, _) =>
            {
                // 这个定时器每次失败都会重建，所以不能无条件打日志：
                // Explorer 重启期间每 2.5s 一条，几分钟就能把 10MB 日志刷掉。
                if (_attachFailCount == 0)
                {
                    HostLog.Info("[wallpaper] desktop surface ready timeout, attaching anyway");
                }

                AttachIfPending();
            };
            _attachFallback.Start();
            return true;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[wallpaper] desktop web surface init failed: {exception.Message}");
            return false;
        }
    }

    /// <summary>把壁纸状态推给这块页面（与主窗口同一份 JSON）。</summary>
    public void PostState(string json)
    {
        if (_disposed || _browser.CoreWebView2 is null)
        {
            return;
        }

        try
        {
            _browser.CoreWebView2.PostWebMessageAsJson(json);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[wallpaper] desktop state push failed: {exception.Message}");
        }
    }

    /// <summary>
    /// 让这一块屏的实际画面自上而下扫过一道光（用户在画布设置里点选这块屏时用）。
    /// 只是一条一次性消息，页面自己播完就丢，不参与状态机。
    /// </summary>
    public void PostSweep()
    {
        PostState("{\"v\":1,\"type\":\"host\",\"event\":\"monitorSweep\"}");
    }

    /// <summary>分辨率/显示器变化后重新铺一次；幂等。</summary>
    public void Reposition()
    {
        AttachToDesktop();
    }

    /// <summary>
    /// 页面报到第一帧（或兜底超时）后，把窗口从屏幕外搬进桌面层。
    /// 只搬一次：之后 Reposition/SetBounds 走正常路径。
    /// </summary>
    private void AttachIfPending()
    {
        if (!_pendingAttach || _disposed)
        {
            return;
        }

        AttachToDesktop();
    }

    private void EnsureAttached()
    {
        if (_disposed)
        {
            return;
        }

        // 还没挂上（开机自启时 Explorer 尚未就绪、`FindDesktopHost()` 返回 0）也要继续试：
        // 以前这里 `!_attached` 直接 return，而健康巡检又只在挂成功后才 Start，
        // 两条重试路径同时断掉 → 那块屏整场没有壁纸，只能重启 App。
        if (!_attached)
        {
            AttachToDesktop();
            return;
        }

        var handle = new WindowInteropHelper(_window).Handle;
        if (handle == IntPtr.Zero)
        {
            return;
        }

        if (NativeMethods.GetParent(handle) == _hostHandle && _hostHandle != IntPtr.Zero)
        {
            return;
        }

        HostLog.Warn("[wallpaper] desktop surface lost its parent, re-attaching");
        AttachToDesktop();
    }

    /// <summary>重建「待挂」兜底定时器（每次尝试都会先清掉它，所以失败时要重新排）。</summary>
    private void EnsureAttachFallback()
    {
        if (_disposed || _attachFallback is not null) return;
        _attachFallback = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(2.5),
        };
        _attachFallback.Tick += (_, _) => AttachIfPending();
        _attachFallback.Start();
    }

    private void AttachToDesktop()
    {
        if (_disposed)
        {
            return;
        }

        // 搬进来之后就不再是「待挂」状态：兜底定时器停掉，
        // 之后 Reposition / SetBounds 走正常的重挂路径。
        _pendingAttach = false;
        if (_attachFallback is not null)
        {
            _attachFallback.Stop();
            _attachFallback = null;
        }

        var handle = new WindowInteropHelper(_window).Handle;
        if (handle == IntPtr.Zero)
        {
            return;
        }

        ApplyOverlayStyles(handle);

        var (parent, insertAfter) = FindDesktopHost();
        if (parent == IntPtr.Zero)
        {
            // 保留「待挂」状态并重排兜底定时器：Explorer 重启、开机抢先启动都会走到这里。
            _attachFailCount++;
            // 首次立刻报，之后每 24 次（约 1 分钟）报一次，日志里保留次数方便判断持续多久。
            if (_attachFailCount == 1 || _attachFailCount % 24 == 0)
            {
                HostLog.Warn($"[wallpaper] desktop host not found, retrying (attempt {_attachFailCount})");
            }

            _attached = false;
            _pendingAttach = true;
            EnsureAttachFallback();
            return;
        }

        NativeMethods.SetParent(handle, parent);
        _hostHandle = parent;

        // 每块屏一块表面：只铺自己那一块 bounds（第 88 轮多屏画面管理）。
        // 没给 bounds 时退回整个虚拟屏（第 25 轮 C）：副屏在主屏左边/上边时虚拟屏原点为负，
        // 用 VirtualScreen 的 Left/Top 而不是 0，否则副屏那一侧会空一条。
        var virtualScreen = System.Windows.Forms.SystemInformation.VirtualScreen;
        var bounds = _bounds.Width > 0 && _bounds.Height > 0 ? _bounds : virtualScreen;
        var width = Math.Max(1, bounds.Width);
        var height = Math.Max(1, bounds.Height);

        // SetParent 之后坐标是父客户区坐标：虚拟屏左上角要减去 Progman 客户区原点。
        var origin = new NativeMethods.Point { X = 0, Y = 0 };
        if (!NativeMethods.ClientToScreen(parent, ref origin))
        {
            origin.X = 0;
            origin.Y = 0;
        }

        var left = bounds.Left - origin.X;
        var top = bounds.Top - origin.Y;
        // 壁纸表面永远压在这组同级窗口的**最底层**：桌面背景歌词（DesktopBackgroundWindow）
        // 也是 Progman 的子窗口，之前两边都插在 SHELLDLL_DefView 下面，谁后挂谁在上面，
        // 于是「开哪个哪个盖住另一个」。壁纸是底图，固定沉底才不会和歌词抢层级。
        var placed = NativeMethods.SetWindowPos(
            handle,
            insertAfter,
            left,
            top,
            width,
            height,
            SwpNoActivate | SwpFrameChanged | SwpShowWindow);

        _attached = placed;
        _attachFailCount = 0;
        // 挂上之后再开健康巡检：它会在父窗口丢了时重挂，挂之前开只会被当成
        // 「还没挂上」而反复触发。
        _health.Start();
        HostLog.Info($"[wallpaper] desktop web surface attached parent={parent} insertAfter={insertAfter} {width}x{height} at {left},{top} placed={placed}");
    }

    /// <summary>换屏位置/分辨率（屏幕增删后由 WallpaperRuntime 调）。</summary>
    public void SetBounds(System.Drawing.Rectangle bounds)
    {
        if (_disposed)
        {
            return;
        }

        _bounds = bounds;
        AttachToDesktop();
    }

    private static void ApplyOverlayStyles(IntPtr handle)
    {
        var style = NativeMethods.GetWindowLongPtr(handle, GwlStyle).ToInt64();
        var newStyle = (style & ~(WsPopup | WsCaption | WsThickFrame)) | WsChild | WsVisible;
        var exStyle = NativeMethods.GetWindowLongPtr(handle, GwlExStyle).ToInt64();
        var newExStyle = exStyle | WsExNoActivate | WsExTransparent | WsExToolWindow;
        if (newStyle == style && newExStyle == exStyle)
        {
            return;
        }

        NativeMethods.SetWindowLongPtr(handle, GwlStyle, new IntPtr(newStyle));
        NativeMethods.SetWindowLongPtr(handle, GwlExStyle, new IntPtr(newExStyle));
    }

    /// <summary>找桌面宿主：Progman 下的 SHELLDLL_DefView（插到它下面 = 图标之下）。</summary>
    private static (IntPtr Parent, IntPtr InsertAfter) FindDesktopHost()
    {
        var progman = NativeMethods.FindWindow("Progman", null);
        if (progman != IntPtr.Zero)
        {
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
            var worker = NativeMethods.FindWindowEx(IntPtr.Zero, defViewHost, "WorkerW", null);
            return worker != IntPtr.Zero ? (worker, IntPtr.Zero) : (defViewHost, defView);
        }

        return (IntPtr.Zero, IntPtr.Zero);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _health.Stop();
        if (_attachFallback is not null)
        {
            _attachFallback.Stop();
            _attachFallback = null;
        }

        try
        {
            var handle = new WindowInteropHelper(_window).Handle;
            if (handle != IntPtr.Zero)
            {
                NativeMethods.SetParent(handle, IntPtr.Zero);
            }

            _window.Close();
            _browser.Dispose();
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[wallpaper] desktop web surface dispose: {exception.Message}");
        }
    }
}
