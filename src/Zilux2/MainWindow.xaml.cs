using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Zilux2.AirPlay;
using Zilux2.Audio;
using Zilux2.Hotkeys;
using Zilux2.Interop;
using Zilux2.Media;
using Zilux2.Settings;

namespace Zilux2;

public partial class MainWindow : Window
{
    // Mirrors WindowChrome.ResizeBorderThickness (see MainWindow.xaml for the reason).
    private const double ResizeGrip = 6;

    // How much of the window must stay reachable on the monitor work area while the user drags
    // it around. Without this the page-driven drag can push the title bar off screen and there is
    // no visible handle left to pull the window back.
    private const double MinVisibleWidthDip = 200;
    private const double TitleBarVisibleHeightDip = 56;

    private readonly WebContentPlan _plan;
    private readonly SettingsService? _settings;
    private readonly AudioFeatureService? _audio;
    private readonly MediaSessionService? _media;
    private readonly AirPlayService? _airplay;
    private WebViewHost? _host;
    private IntPtr _hwnd;
    private long _dragGeneration;
    private bool _dragPending;

    // Window control animations (maximize / restore / minimize / close). The page only asks for
    // the operation; the motion is driven here with SetWindowPos frames so the WebView2 child
    // HWND travels with the window instead of being left behind by a WPF-only transform.
    private const int MaximizeAnimationMs = 200;
    // 窗口过渡：custom=应用内自绘（快照缩放/淡出），native=Windows 原生过渡。
    // 设置项在「设置 → 外观 → 窗口动画」，这里每次动作时读取，切换后立即生效。
    private bool NativeWindowAnim =>
        string.Equals(_settings?.WindowAnimation, AppearanceSettings.WindowAnimationNative, StringComparison.Ordinal);

    private const int MinimizeAnimationMs = 180;
    private const int CloseAnimationMs = 140;
    private DispatcherTimer? _windowAnim;
    private long _windowAnimGeneration;
    private bool _suppressClamp;
    private NativeMethods.Rect _restoreRect;
    private bool _hasRestoreRect;

    // 迷你播放器模式（契约 docs/zilux2-host-contract.md §15）：进入前保存原窗口状态，退出时精确还原。
    private const double MiniDefaultWidthDip = 420;
    private const double MiniDefaultHeightDip = 120;
    private const double MiniMinWidthDip = 360;
    private const double MiniMinHeightDip = 100;
    private const double MiniScreenMarginDip = 12;
    // 迷你小窗的窗口圆角：无边框窗口本身是直角的，进迷你态后用 SetWindowRgn 把窗口裁剪成圆角
    // （页面此时是满窗卡片，所以圆角直接就是卡片轮廓）；退出时恢复直角。
    private const double MiniCornerRadiusDip = 16;
    // 进出迷你播放器的窗口补间：与页面过渡态（.is-mini-entering/.is-mini-exiting）同时段，
    // 让窗口本身平滑收缩/长回去，而不是一帧跳变（反馈动画生硬）。
    private const int MiniEnterAnimationMs = 320;
    private const int MiniExitAnimationMs = 380;
    private bool _miniMode;
    private bool _miniAnimating;
    private WindowState _miniSavedWindowState = WindowState.Normal;
    private NativeMethods.Rect _miniRestoreRect;
    private bool _miniHasRestoreRect;
    private NativeMethods.Rect _miniSavedRestoreRect;
    private bool _miniSavedHasRestoreRect;
    private bool _miniSavedTopmost;
    private double _miniSavedMinWidth = 1100;
    private double _miniSavedMinHeight = 700;

    // 后台常驻：关闭窗口只隐藏到托盘，进程继续跑（听歌/下载/热键）；只有托盘「退出」或更新安装
    // 才真正退出。_pendingHideToTray 用于让自绘关闭动画结束后走「隐藏」而不是「关闭」。
    private bool _isHiddenToTray;
    private bool _isExiting;
    private bool _pendingHideToTray;
    private readonly List<int> _registeredHotkeys = new();

    // 全局热键：配置来自 settings.shortcuts（字符串解析见 HotkeyBinding，默认值/候选链见
    // HotkeyCatalog）。_lastAppliedShortcuts 记录每个动作上一次注册成功的组合，用于非法配置时
    // 保留可用注册；_shortcutItems/_shortcutStateJson 是回推页面的生效状态。
    private readonly Dictionary<string, HotkeyBinding> _lastAppliedShortcuts = new(StringComparer.Ordinal);
    private readonly List<ShortcutItemState> _shortcutItems = new();
    private string? _shortcutStateJson;
    private bool _shortcutsEnabled = true;

    // 系统媒体键接管：别的程序用 RegisterHotKey 抢注媒体键后，本机 SMTC 收不到 ButtonPressed，
    // 由底层键盘钩子在本机是「当前媒体会话」时兜底（详见 MediaKeyHookService）。
    private MediaKeyHookService? _mediaKeyHook;

    internal MainWindow(
        WebContentPlan plan,
        SettingsService? settings,
        AudioFeatureService? audio,
        MediaSessionService? media = null,
        AirPlayService? airplay = null)
    {
        _plan = plan;
        _settings = settings;
        _audio = audio;
        _media = media;
        _airplay = airplay;
        if (_settings is not null)
        {
            // 设置面板 patch/reset 改到 shortcuts 段时重新注册全局热键（回调在 UI 线程附近，
            // OnShortcutsChanged 内部再做一次 Dispatcher 兜底）。
            _settings.ShortcutsChanged += OnShortcutsChanged;
        }

        InitializeComponent();
        SourceInitialized += OnSourceInitialized;
        Loaded += OnLoaded;
        StateChanged += OnStateChanged;
        SizeChanged += OnWindowSizeChanged;
        Closing += OnClosing;
        Closed += OnClosed;
    }

    public bool IsMaximized => WindowState == WindowState.Maximized;

    // The SMTC session is window scoped, so the host needs the native handle once it is created.
    internal IntPtr Handle => _hwnd;

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        _hwnd = new WindowInteropHelper(this).Handle;
        HwndSource.FromHwnd(_hwnd)?.AddHook(WndProc);
        ApplyShortcutSettings("startup");
        InstallMediaKeyHook();
    }

    private void OnLoaded(object? sender, RoutedEventArgs e)
    {
        Loaded -= OnLoaded;
        _host = new WebViewHost(this, Browser, _plan, _settings, _audio, _media, _airplay);
        _ = _host.InitializeAsync();
    }

    private void OnStateChanged(object? sender, EventArgs e)
    {
        var maximized = IsMaximized;
        Browser.Margin = maximized ? new Thickness(0) : new Thickness(ResizeGrip);
        HostLog.Info($"window.state maximized={maximized}");
        _host?.PostWindowState(maximized);

        // Feature frames are only worth producing while the stage is actually on screen.
        _audio?.SetPaused(WindowState == WindowState.Minimized);

        if (!maximized)
        {
            // Keep the rect the user would expect to come back to, including when the window was
            // maximized/restored by Windows itself (Win+Up / taskbar) instead of the page buttons.
            if (_windowAnim is null && _hwnd != IntPtr.Zero &&
                NativeMethods.GetWindowRect(_hwnd, out var normalRect))
            {
                _restoreRect = normalRect;
                _hasRestoreRect = true;
            }

            // The saved normal rect can be off screen (monitor unplugged, resolution change);
            // WPF restores it verbatim, so re-clamp it once the state is settled.
            Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(ClampWindowToWorkArea));
        }
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        if (_settings is not null)
        {
            _settings.ShortcutsChanged -= OnShortcutsChanged;
        }

        App.ArmShutdownWatchdog();
        _mediaKeyHook?.Dispose();
        _mediaKeyHook = null;
        HostLog.Info("window.closed dispose begin");
        try
        {
            _host?.Dispose();
        }
        finally
        {
            _host = null;
            HostLog.Info("window.closed dispose end");
            HostLog.Info("window.closed");
        }

        if (!_isExiting)
        {
            // 走到这里说明窗口是「真关闭」而不是隐藏（例如托盘不可用时关闭），
            // OnExplicitShutdown 下必须显式 Shutdown，否则进程会没有窗口地挂着。
            _isExiting = true;
            Dispatcher.BeginInvoke(new Action(() => System.Windows.Application.Current?.Shutdown()),
                DispatcherPriority.Normal);
        }
    }

    // 页面把当前主背景色报上来，宿主用它给 6px 的窗口边条上色，
    // 这样边条和页面背景融合，不会再出现与页面不一致的黑框/白框。
    public void SetChromeColor(string? hex)
    {
        if (string.IsNullOrWhiteSpace(hex)) return;
        try
        {
            var color = (Color)ColorConverter.ConvertFromString(hex)!;
            var brush = new SolidColorBrush(color);
            brush.Freeze();
            Background = brush;
            RootGrid.Background = brush;
            HostLog.Info($"window.chromeColor {hex}");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"window.chromeColor ignored: {hex} ({exception.GetType().Name})");
        }
    }

    /// <summary>在线下载完成：通知 WebViewHost 刷新本地曲库视图。</summary>
    public void NotifyDownloadedFile(string path)
    {
        HostLog.Info($"[download] file ready {path}");
        _host?.NotifyDownloadedFile(path);
    }

    public void ToggleMaximize()
    {
        CancelPendingDrag("toggleMaximize");

        if (NativeWindowAnim)
        {
            WindowState = IsMaximized ? WindowState.Normal : WindowState.Maximized;
            HostLog.Info("window.native maximize");
            return;
        }

        if (_hwnd == IntPtr.Zero || !NativeMethods.GetWindowRect(_hwnd, out var current))
        {
            WindowState = IsMaximized ? WindowState.Normal : WindowState.Maximized;
            return;
        }

        if (!IsMaximized)
        {
            _restoreRect = current;
            _hasRestoreRect = true;

            // Animate while still in Normal state, then flip the state once the window already
            // covers the work area: WPF's maximize would apply the same rect, so there is no
            // one-frame jump. Flipping first would snap to full screen before the first frame.
            _restoreRect = current;
            _hasRestoreRect = true;
            var work = WorkAreaOf(current);
            BeginWindowMotion(
                current,
                work,
                MaximizeAnimationMs,
                EaseOutCubic,
                () => WindowState = WindowState.Maximized);
            HostLog.Info(
                $"window.animate maximize from={DescribeRect(current)} to={DescribeRect(work)}");
            return;
        }

        var target = _hasRestoreRect ? _restoreRect : RestoreRectInPixels(current);
        // RestoreBounds equals the current (maximized) rect here, so this does not move the
        // window; the animation below is what brings it back to the saved normal rect.
        WindowState = WindowState.Normal;
        BeginWindowMotion(current, target, MaximizeAnimationMs, EaseOutCubic, null);
        HostLog.Info(
            $"window.animate restore from={DescribeRect(current)} to={DescribeRect(target)}");
    }

    public void MinimizeFromPage()
    {
        CancelPendingDrag("minimize");

        if (_hwnd == IntPtr.Zero || !NativeMethods.GetWindowRect(_hwnd, out var current))
        {
            WindowState = WindowState.Minimized;
            return;
        }

        if (NativeWindowAnim)
        {
            WindowState = WindowState.Minimized;
            HostLog.Info("window.native minimize");
            return;
        }

        // A pure rect animation reflows the page on every frame, which reads as a jumpy resize
        // rather than the window going away. Play a screenshot of the window instead: the pixels
        // scale/fade like the real compositor would, the WebView2 content never reflows.
        if (!PlaySnapshotTransition(current, minimize: true))
        {
            WindowState = WindowState.Minimized;
        }

        HostLog.Info("window.animate minimize (snapshot)");
    }

    /// <summary>
    /// 页面标题栏的关闭按钮：隐藏到托盘（后台继续播放），不销毁窗口/WebView2。真正退出只有
    /// 托盘菜单「退出」和更新安装两条路径（都走 <see cref="ExitApplication"/>）。
    /// </summary>
    public void CloseFromPage()
    {
        CancelPendingDrag("close");

        if (_isExiting)
        {
            Close();
            return;
        }

        if (_hwnd == IntPtr.Zero || !NativeMethods.GetWindowRect(_hwnd, out var current))
        {
            // Hide from a dispatcher turn: never tear the WebView2 control down inside its own callback.
            Dispatcher.BeginInvoke(new Action(HideToTray));
            return;
        }

        if (NativeWindowAnim)
        {
            HostLog.Info("window.native close -> tray");
            HideToTray();
            return;
        }

        _pendingHideToTray = true;
        if (!PlaySnapshotTransition(current, minimize: false))
        {
            _pendingHideToTray = false;
            Dispatcher.BeginInvoke(new Action(HideToTray));
        }

        HostLog.Info("window.animate close (snapshot)");
    }

    // ---------------------------------------------------------------------------------------
    // 迷你播放器模式
    // ---------------------------------------------------------------------------------------

    /// <summary>窗口当前是否处于迷你播放器模式。</summary>
    internal bool IsMiniMode => _miniMode;

    /// <summary>
    /// 页面命令 window.miniMode 的宿主实现：开启时保存原 bounds/WindowState/Topmost/MinWidth，
    /// 切到紧凑尺寸（默认 420×120，最小宽 360）置顶并吸附到当前显示器工作区右下角（留安全边距）；
    /// 关闭时精确还原。成功后通过 WebViewHost 回推 window/miniMode 事件。
    /// </summary>
    public void SetMiniMode(bool enabled, double width, double height)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => SetMiniMode(enabled, width, height)), DispatcherPriority.Normal);
            return;
        }

        if (_miniAnimating)
        {
            // 过渡中来新指令：立即收尾当前动画，从当前实际 rect 重新开始，避免状态错位。
            StopWindowMotion();
            _miniAnimating = false;
        }

        if (enabled == _miniMode)
        {
            // 重复指令只补推一次状态：页面导航回来时也会在 ready 里对齐。
            _host?.NotifyMiniMode(_miniMode);
            return;
        }

        if (enabled)
        {
            EnterMiniMode(width, height);
        }
        else
        {
            ExitMiniMode();
        }
    }

    private void EnterMiniMode(double width, double height)
    {
        CancelPendingDrag("miniMode");
        StopWindowMotion();

        _miniSavedWindowState = WindowState == WindowState.Minimized ? WindowState.Normal : WindowState;
        _miniSavedTopmost = Topmost;
        _miniSavedMinWidth = MinWidth;
        _miniSavedMinHeight = MinHeight;
        _miniSavedRestoreRect = _restoreRect;
        _miniSavedHasRestoreRect = _hasRestoreRect;

        var (scaleX, scaleY) = CurrentDpiScale();
        var widthDip = width > 0 ? Math.Clamp(width, MiniMinWidthDip, 1600) : MiniDefaultWidthDip;
        var heightDip = height > 0 ? Math.Clamp(height, MiniMinHeightDip, 900) : MiniDefaultHeightDip;
        var pixelWidth = Math.Max(1, (int)Math.Round(widthDip * scaleX));
        var pixelHeight = Math.Max(1, (int)Math.Round(heightDip * scaleY));

        var reference = CurrentWindowRect();
        // 最大化进入 mini 时，用 RestoreBounds 当作退出目标，退出后才能回到最大化前的尺寸再最大化。
        _miniRestoreRect = _miniSavedWindowState == WindowState.Maximized
            ? RestoreRectInPixels(reference)
            : reference;
        _miniHasRestoreRect = true;

        var work = WorkAreaOf(reference);
        var marginX = Math.Max(0, (int)Math.Round(MiniScreenMarginDip * scaleX));
        var marginY = Math.Max(0, (int)Math.Round(MiniScreenMarginDip * scaleY));
        var left = Math.Max(work.Left + marginX, work.Right - marginX - pixelWidth);
        var top = Math.Max(work.Top + marginY, work.Bottom - marginY - pixelHeight);

        MinWidth = MiniMinWidthDip;
        MinHeight = MiniMinHeightDip;
        Topmost = true;
        // 迷你态窗口会被裁成圆角、页面满窗铺卡片：把 WebView 边距清零，否则窗口四周会露出
        // 6px 的 WPF 主题底色（用户看到的「正方形框」的来源之一）。
        Browser.Margin = new Thickness(0);

        // 最大化/最小化或尚未拿到 HWND 时退化为即时落位；正常窗口用补间动画收缩，
        // 页面同时切到「悬浮小卡」过渡态（.is-mini-entering），视觉上像窗口被吸到角落。
        if (_hwnd == IntPtr.Zero || _miniSavedWindowState != WindowState.Normal)
        {
            if (WindowState != WindowState.Normal)
            {
                WindowState = WindowState.Normal;
            }
            if (!TrySetWindowRect(left, top, pixelWidth, pixelHeight))
            {
                ApplyRectInDip(left, top, pixelWidth, pixelHeight, scaleX, scaleY);
            }
            FinishEnterMiniMode(left, top, pixelWidth, pixelHeight, marginX, marginY);
            return;
        }

        var target = new NativeMethods.Rect
        {
            Left = left,
            Top = top,
            Right = left + pixelWidth,
            Bottom = top + pixelHeight,
        };
        _miniAnimating = true;
        BeginWindowMotion(
            reference,
            target,
            MiniEnterAnimationMs,
            EaseInOutCubic,
            () =>
            {
                _miniAnimating = false;
                FinishEnterMiniMode(left, top, pixelWidth, pixelHeight, marginX, marginY);
            });
        HostLog.Info(
            $"window.animate mini entering from={DescribeRect(reference)} to={left},{top} size={pixelWidth}x{pixelHeight}");
    }

    private void FinishEnterMiniMode(int left, int top, int pixelWidth, int pixelHeight, int marginX, int marginY)
    {
        _miniMode = true;
        // 落位时再清一次（最大化进入时会先切 WindowState，OnStateChanged 会把边距改回 6px）。
        Browser.Margin = new Thickness(0);
        HostLog.Info(
            $"window.miniMode enabled rect={left},{top} size={pixelWidth}x{pixelHeight} margin={marginX},{marginY}");
        ApplyMiniWindowRegion(true);
        _host?.NotifyMiniMode(true);
    }

    /// <summary>
    /// 迷你态把窗口裁剪成圆角，退出时恢复直角。页面在迷你态是「满窗卡片」，所以窗口圆角就是
    /// 卡片轮廓 —— 用户看到一张贴边的圆角小卡，而不是带主题底色的直角矩形窗口。
    /// 圆角半径按当前 DPI 缩放；SetWindowRgn 成功后区域归系统所有，不要再 DeleteObject。
    /// </summary>
    private void ApplyMiniWindowRegion(bool rounded)
    {
        if (_hwnd == IntPtr.Zero)
        {
            return;
        }

        if (!rounded)
        {
            NativeMethods.SetWindowRgn(_hwnd, IntPtr.Zero, true);
            return;
        }

        if (!NativeMethods.GetWindowRect(_hwnd, out var rect))
        {
            return;
        }

        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0)
        {
            return;
        }

        var (scaleX, scaleY) = CurrentDpiScale();
        var scale = Math.Max(scaleX, scaleY);
        var radius = Math.Max(4, (int)Math.Round(MiniCornerRadiusDip * scale));
        var region = NativeMethods.CreateRoundRectRgn(0, 0, width + 1, height + 1, radius * 2, radius * 2);
        if (region == IntPtr.Zero)
        {
            return;
        }

        NativeMethods.SetWindowRgn(_hwnd, region, true);
    }

    private void OnWindowSizeChanged(object? sender, SizeChangedEventArgs e)
    {
        // 迷你态允许用户继续拉伸小窗：尺寸一变就按新尺寸重做圆角，否则角会被裁掉/留直角。
        if (!_miniMode || _miniAnimating)
        {
            return;
        }

        ApplyMiniWindowRegion(true);
    }

    private void ExitMiniMode()
    {
        StopWindowMotion();
        _miniAnimating = false;
        // 先把窗口恢复成直角再长回去：圆角区域是按迷你尺寸裁的，直接放大只会把内容裁掉。
        ApplyMiniWindowRegion(false);

        var target = _miniRestoreRect;
        var hasTarget = _miniHasRestoreRect && target.Right > target.Left && target.Bottom > target.Top;
        var from = CurrentWindowRect();

        // 最大化来源或没有可用 rect：即时还原；普通窗口用补间动画长回去，
        // 页面同步播放 .is-mini-exiting 过渡态（小卡先浮动、再回到常驻播放条）。
        if (!hasTarget || _hwnd == IntPtr.Zero || _miniSavedWindowState == WindowState.Maximized)
        {
            FinishExitMiniMode(hasTarget, target);
            return;
        }

        _miniAnimating = true;
        BeginWindowMotion(
            from,
            target,
            MiniExitAnimationMs,
            EaseInOutCubic,
            () =>
            {
                _miniAnimating = false;
                FinishExitMiniMode(hasTarget, target);
            });
        HostLog.Info($"window.animate mini exiting from={DescribeRect(from)} to={DescribeRect(target)}");
    }

    private void FinishExitMiniMode(bool hasTarget, NativeMethods.Rect target)
    {
        var restored = hasTarget &&
                       TrySetWindowRect(target.Left, target.Top, target.Right - target.Left, target.Bottom - target.Top);
        if (!restored)
        {
            // 没有可用 rect（窗口还没显示过）：至少退回到普通状态，避免停在小尺寸。
            WindowState = WindowState.Normal;
            if (hasTarget)
            {
                var (scaleX, scaleY) = CurrentDpiScale();
                ApplyRectInDip(
                    target.Left,
                    target.Top,
                    target.Right - target.Left,
                    target.Bottom - target.Top,
                    scaleX,
                    scaleY);
            }
        }

        MinWidth = _miniSavedMinWidth;
        MinHeight = _miniSavedMinHeight;
        Topmost = _miniSavedTopmost;
        // 恢复普通窗口的 WebView 边距（无边框窗口的拖拽/缩放描边区）。
        Browser.Margin = _miniSavedWindowState == WindowState.Maximized ? new Thickness(0) : new Thickness(ResizeGrip);

        if (_miniSavedWindowState == WindowState.Maximized)
        {
            _restoreRect = target;
            _hasRestoreRect = hasTarget;
            WindowState = WindowState.Maximized;
        }
        else
        {
            _restoreRect = _miniSavedRestoreRect;
            _hasRestoreRect = _miniSavedHasRestoreRect;
        }

        _miniHasRestoreRect = false;
        _miniMode = false;
        HostLog.Info(
            $"window.miniMode disabled restored={(hasTarget ? DescribeRect(target) : "none")} state={_miniSavedWindowState}");
        _host?.NotifyMiniMode(false);
    }

    private NativeMethods.Rect CurrentWindowRect()
    {
        if (_hwnd != IntPtr.Zero &&
            NativeMethods.GetWindowRect(_hwnd, out var current) &&
            current.Right > current.Left &&
            current.Bottom > current.Top)
        {
            return current;
        }

        var (scaleX, scaleY) = CurrentDpiScale();
        var left = (int)Math.Round(Left * scaleX);
        var top = (int)Math.Round(Top * scaleY);
        var width = Math.Max(1, (int)Math.Round(ActualWidth * scaleX));
        var height = Math.Max(1, (int)Math.Round(ActualHeight * scaleY));
        return new NativeMethods.Rect { Left = left, Top = top, Right = left + width, Bottom = top + height };
    }

    private bool TrySetWindowRect(int left, int top, int width, int height)
    {
        if (_hwnd == IntPtr.Zero)
        {
            return false;
        }

        return NativeMethods.SetWindowPos(
            _hwnd,
            IntPtr.Zero,
            left,
            top,
            Math.Max(1, width),
            Math.Max(1, height),
            NativeMethods.SwpNoZOrder | NativeMethods.SwpNoActivate);
    }

    private void ApplyRectInDip(int left, int top, int width, int height, double scaleX, double scaleY)
    {
        var safeX = Math.Max(0.1, scaleX);
        var safeY = Math.Max(0.1, scaleY);
        Left = left / safeX;
        Top = top / safeY;
        Width = Math.Max(1, width) / safeX;
        Height = Math.Max(1, height) / safeY;
    }

    // ---------------------------------------------------------------------------------------
    // 后台常驻 / 托盘 / 全局热键
    // ---------------------------------------------------------------------------------------

    /// <summary>窗口当前是否隐藏在托盘（页面不可见，但进程、播放、热键都还在）。</summary>
    internal bool IsHiddenToTray => _isHiddenToTray;

    /// <summary>第一次隐藏到托盘时触发，托盘服务用它弹一次气泡提示（只弹一次）。</summary>
    internal event EventHandler? HiddenToTray;

    /// <summary>
    /// 任意关闭来源（页面按钮、Alt+F4、系统关机除外）都先经过这里：未在真正退出就取消关闭并隐藏。
    /// </summary>
    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_isExiting)
        {
            // 真退出路径：此时 HWND 还没销毁，先注销全局热键。
            UnregisterHotkeys();
            return;
        }

        if (App.Tray is null)
        {
            // 托盘不可用（初始化失败）：隐藏后就没有找回窗口的入口，直接放行关闭，
            // OnClosed 再显式 Shutdown，避免留下无窗口进程。
            HostLog.Warn("tray.unavailable close");
            return;
        }

        e.Cancel = true;
        if (_isHiddenToTray)
        {
            return;
        }

        // 关闭已经在进行中（Closing 期间 Hide 会再触发一轮），丢到 dispatcher 下一拍隐藏。
        Dispatcher.BeginInvoke(new Action(HideToTray));
    }

    /// <summary>隐藏主窗口到托盘；UI 线程调用，幂等。</summary>
    internal void HideToTray()
    {
        if (_isExiting || _isHiddenToTray)
        {
            return;
        }

        _isHiddenToTray = true;
        try
        {
            Hide();
            HostLog.Info("tray.hide");
        }
        catch (Exception exception)
        {
            _isHiddenToTray = false;
            HostLog.Error("tray.hide failed", exception);
            return;
        }

        HiddenToTray?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>从托盘恢复主窗口：Show + 最小化则还原 + 激活。</summary>
    internal void ShowFromTray()
    {
        if (_isExiting)
        {
            return;
        }

        // 关闭动画还没结束就被托盘/热键叫回来时，别让动画收尾再隐藏一次。
        _pendingHideToTray = false;

        try
        {
            if (WindowState == WindowState.Minimized)
            {
                WindowState = WindowState.Normal;
            }

            Show();
            Activate();
            if (_hwnd != IntPtr.Zero)
            {
                NativeMethods.SetForegroundWindow(_hwnd);
            }

            _isHiddenToTray = false;
            HostLog.Info("tray.show");
        }
        catch (Exception exception)
        {
            HostLog.Error("tray.show failed", exception);
        }
    }

    /// <summary>托盘左键 / Ctrl+Alt+Z：可见就隐藏，隐藏或最小化就显示。</summary>
    internal void ToggleFromTray()
    {
        if (_isExiting)
        {
            return;
        }

        if (_isHiddenToTray || WindowState == WindowState.Minimized)
        {
            ShowFromTray();
        }
        else
        {
            HideToTray();
        }
    }

    /// <summary>
    /// 第二个 Zilux2 进程启动时把已有窗口带到前台（单实例保护）：隐藏到托盘 / 最小化则先恢复，
    /// 否则直接激活并置前。
    /// </summary>
    internal void ActivateFromSecondInstance()
    {
        if (_isExiting)
        {
            return;
        }

        if (_isHiddenToTray || WindowState == WindowState.Minimized)
        {
            ShowFromTray();
            HostLog.Info("instance.show");
            return;
        }

        try
        {
            Activate();
            if (_hwnd != IntPtr.Zero)
            {
                NativeMethods.SetForegroundWindow(_hwnd);
            }

            HostLog.Info("instance.focus");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"instance.focus failed: {exception.Message}");
        }
    }

    /// <summary>
    /// 托盘菜单 / 全局热键播放控制：转成页面 command 消息（togglePlay/prev/next）。
    /// 页面未就绪时 WebViewHost 只记日志，这里不缓存。
    /// </summary>
    internal void SendCommand(string action)
    {
        if (action is not ("togglePlay" or "prev" or "next"))
        {
            HostLog.Warn($"tray.command ignored action={action}");
            return;
        }

        HostLog.Info($"tray.command action={action}");
        _host?.PostCommand(action);
    }

    /// <summary>托盘菜单「退出」：真正退出进程（唯一可见的退出入口）。</summary>
    internal void CloseForReal() => ExitApplication("tray");

    /// <summary>
    /// 真正退出：标记 _isExiting 让 Closing 放行，然后关闭窗口并关闭 Application。
    /// 更新安装（WebViewHost.RequestShutdownForUpdate）也走这里，否则 OnExplicitShutdown 下
    /// 直接 Application.Shutdown() 会被关闭拦截逻辑挡住。
    /// </summary>
    internal void ExitApplication(string reason)
    {
        if (_isExiting)
        {
            return;
        }

        _isExiting = true;
        HostLog.Info($"app.exit reason={reason}");
        try
        {
            Close();
        }
        catch (Exception exception)
        {
            HostLog.Error("app.exit close failed", exception);
        }

        try
        {
            System.Windows.Application.Current?.Shutdown();
        }
        catch (Exception exception)
        {
            HostLog.Error("app.exit shutdown failed", exception);
        }
    }

    /// <summary>系统关机/注销时由 App 调用：放行真正的关闭（后台常驻不能拦住会话结束）。</summary>
    internal void AllowExitForSystemShutdown()
    {
        if (_isExiting)
        {
            return;
        }

        _isExiting = true;
        _pendingHideToTray = false;
        HostLog.Info("app.exit reason=sessionEnding");
    }

    private void OnShortcutsChanged()
    {
        // 设置 patch 从 WebView2 消息（UI 线程）来，理论上已经在这条线程；仍做一次兜底调度，
        // 将来若有后台写入设置的路径也不会在非 UI 线程动 HWND。
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => ApplyShortcutSettings("settings")));
            return;
        }

        ApplyShortcutSettings("settings");
    }

    /// <summary>
    /// 设置驱动的热键注册（幂等：每次先全部注销再注册，可在启动、设置变更、reset 后反复调用）。
    /// - enabled=false：全部关闭；
    /// - 空字符串：该条关闭；
    /// - 解析失败：保留该动作上一次注册成功的组合（标记 fallback），不让一次手误把热键弄丢；
    /// - 仍是默认值的组合：保留候选回落链（Ctrl+Alt+Left 被占用时回落到 Ctrl+Alt+Shift+Left 等）；
    /// - 用户改过的组合：只注册配置值。
    /// </summary>
    private void ApplyShortcutSettings(string reason)
    {
        if (_hwnd == IntPtr.Zero)
        {
            HostLog.Warn($"hotkey.apply skipped reason={reason}: hwnd not ready");
            return;
        }

        var settings = _settings?.ShortcutsSnapshot ?? new ShortcutSettings();
        UnregisterHotkeys();
        _shortcutItems.Clear();
        _shortcutsEnabled = settings.Enabled;

        var registeredCount = 0;
        foreach (var spec in HotkeyCatalog.Actions)
        {
            var configured = HotkeyCatalog.ConfiguredValue(settings, spec.SettingKey);
            HostLog.Info($"hotkey.configured action={spec.Action} value={configured}");
            var item = new ShortcutItemState
            {
                Id = spec.Id,
                // 回推页面的 action 用设置键名（playPause/prev/next/toggleWindow），与页面
                // ShortcutAction 类型一致；命令动作名（togglePlay 等）只用于内部转发页面命令。
                Action = spec.SettingKey,
                Configured = configured,
            };

            if (!settings.Enabled)
            {
                item.Error = "disabled";
                HostLog.Info($"hotkey.register id={spec.Id} skipped action={spec.Action} reason=disabled");
            }
            else if (configured.Length == 0)
            {
                item.Error = "empty";
                HostLog.Info($"hotkey.register id={spec.Id} skipped action={spec.Action} reason=empty");
            }
            else if (!HotkeyBinding.TryParse(configured, out var binding))
            {
                HostLog.Warn(
                    $"hotkey.configured action={spec.Action} value={configured} invalid: keep previous registration");
                item.Error = "invalid";
                if (_lastAppliedShortcuts.TryGetValue(spec.Action, out var previous) &&
                    TryRegisterHotkey(spec.Id, spec.Action, previous))
                {
                    registeredCount++;
                    item.Ok = true;
                    item.Applied = previous.Key;
                    item.Fallback = true;
                }
            }
            else
            {
                var candidates = BuildShortcutCandidates(spec, binding);
                if (TryRegisterHotkeyChain(spec, candidates, out var lastError) is { } applied)
                {
                    registeredCount++;
                    item.Ok = true;
                    item.Applied = applied.Key;
                    item.Fallback = !applied.Equals(binding);
                    _lastAppliedShortcuts[spec.Action] = applied;
                }
                else
                {
                    item.Error = lastError > 0 ? $"error={lastError}" : "unavailable";
                }
            }

            _shortcutItems.Add(item);
        }

        HostLog.Info(
            $"hotkey.apply enabled={(settings.Enabled ? "true" : "false")} count={registeredCount} reason={reason}");
        BuildShortcutStateJson();
        PublishShortcutState();
    }

    /// <summary>默认值组合保留候选回落链；用户改过的组合只注册配置值。</summary>
    private static List<HotkeyBinding> BuildShortcutCandidates(HotkeyActionSpec spec, HotkeyBinding binding)
    {
        var candidates = new List<HotkeyBinding> { binding };
        if (!HotkeyBinding.TryParse(spec.DefaultValue, out var defaultBinding) || !binding.Equals(defaultBinding))
        {
            return candidates;
        }

        foreach (var fallbackText in spec.FallbackCandidates)
        {
            if (HotkeyBinding.TryParse(fallbackText, out var fallback) && !candidates.Contains(fallback))
            {
                candidates.Add(fallback);
            }
        }

        return candidates;
    }

    /// <summary>按候选顺序注册同一动作，第一个成功的生效；全部失败时只记 WARN，不影响其它热键。</summary>
    private HotkeyBinding? TryRegisterHotkeyChain(
        HotkeyActionSpec spec,
        List<HotkeyBinding> candidates,
        out int lastError)
    {
        lastError = 0;
        foreach (var candidate in candidates)
        {
            if (TryRegisterHotkey(spec.Id, spec.Action, candidate))
            {
                return candidate;
            }

            lastError = Marshal.GetLastWin32Error();
        }

        HostLog.Warn(
            $"hotkey.register id={spec.Id} failed action={spec.Action}: all {candidates.Count} candidates unavailable");
        return null;
    }

    private bool TryRegisterHotkey(int id, string action, HotkeyBinding binding)
    {
        if (NativeMethods.RegisterHotKey(_hwnd, id, binding.Modifiers, binding.VirtualKey))
        {
            _registeredHotkeys.Add(id);
            HostLog.Info($"hotkey.register id={id} ok action={action} key={binding.Key}");
            return true;
        }

        HostLog.Warn($"hotkey.register id={id} candidate={binding.Key} failed error={Marshal.GetLastWin32Error()}");
        return false;
    }

    private void BuildShortcutStateJson()
    {
        var message = new HostShortcutsMessage
        {
            State = new ShortcutState
            {
                Enabled = _shortcutsEnabled,
                Items = _shortcutItems.Select(item => item.Clone()).ToList(),
            },
        };

        _shortcutStateJson = JsonSerializer.Serialize(message, HotkeyJsonContext.Default.HostShortcutsMessage);
    }

    /// <summary>页面 ready 后或设置变更后回推最新热键状态（WebViewHost 在页面未就绪时直接丢弃）。</summary>
    internal void PublishShortcutState()
    {
        if (_shortcutStateJson is null)
        {
            return;
        }

        _host?.PublishShortcuts(_shortcutStateJson);
    }

    private void UnregisterHotkeys()
    {
        if (_hwnd == IntPtr.Zero || _registeredHotkeys.Count == 0)
        {
            return;
        }

        foreach (var id in _registeredHotkeys)
        {
            try
            {
                if (!NativeMethods.UnregisterHotKey(_hwnd, id))
                {
                    HostLog.Warn($"hotkey.unregister id={id} failed error={Marshal.GetLastWin32Error()}");
                }
            }
            catch (Exception exception)
            {
                HostLog.Warn($"hotkey.unregister id={id} failed: {exception.Message}");
            }
        }

        _registeredHotkeys.Clear();
    }

    private void OnHotkey(int id)
    {
        switch (id)
        {
            case 1:
                FireHotkey("togglePlay");
                break;
            case 2:
                FireHotkey("prev");
                break;
            case 3:
                FireHotkey("next");
                break;
            case 4:
                HostLog.Info("hotkey.fire action=toggleWindow");
                ToggleFromTray();
                break;
            default:
                HostLog.Warn($"hotkey.fire unknown id={id}");
                break;
        }
    }

    private void FireHotkey(string action)
    {
        HostLog.Info($"hotkey.fire action={action}");
        SendCommand(action);
    }

    /// <summary>
    /// 系统媒体键接管：Windows 的媒体键常被别的程序用 RegisterHotKey 抢注（例如 QQ 音乐），
    /// 被抢注后本机 SMTC 永远收不到 ButtonPressed。底层键盘钩子仍能看到按键，所以这里只在
    /// 「本机是当前媒体会话」时吞下媒体键并走自家命令链，其余情况放行——既覆盖了被抢注的场景，
    /// 又保留系统「媒体键跟着当前播放器走」的原生行为。快捷键总开关关闭时也不接管。
    /// </summary>
    private void InstallMediaKeyHook()
    {
        if (_media is null || _mediaKeyHook is not null)
        {
            return;
        }

        _mediaKeyHook = new MediaKeyHookService(
            () => _shortcutsEnabled && _media.IsCurrentSession,
            action =>
            {
                HostLog.Info($"mediakey.fire action={action}");
                SendCommand(action);
            });

        if (_mediaKeyHook.Install())
        {
            return;
        }

        HostLog.Warn($"[mediakey] hook unavailable error={Marshal.GetLastWin32Error()}");
        _mediaKeyHook.Dispose();
        _mediaKeyHook = null;
    }

    /// <summary>
    /// Drives the window rect from <paramref name="from"/> to <paramref name="to"/> with
    /// SetWindowPos frames. The WebView2 control is a child HWND, so whatever the window rect
    /// does it follows — a WPF render transform would leave the page behind.
    /// </summary>
    private void BeginWindowMotion(
        NativeMethods.Rect from,
        NativeMethods.Rect to,
        int durationMs,
        Func<double, double> ease,
        Action? completed)
    {
        var hwnd = _hwnd;
        if (hwnd == IntPtr.Zero)
        {
            completed?.Invoke();
            return;
        }

        StopWindowMotion();
        var generation = _windowAnimGeneration;
        var started = Environment.TickCount64;
        _suppressClamp = true;

        var timer = new DispatcherTimer(DispatcherPriority.Render)
        {
            Interval = TimeSpan.FromMilliseconds(15),
        };
        _windowAnim = timer;
        timer.Tick += (_, _) =>
        {
            if (generation != _windowAnimGeneration)
            {
                timer.Stop();
                return;
            }

            var t = Math.Clamp(
                (Environment.TickCount64 - started) / (double)Math.Max(1, durationMs),
                0,
                1);
            var k = ease(t);
            var rect = BlendRect(from, to, k);
            NativeMethods.SetWindowPos(
                hwnd,
                IntPtr.Zero,
                rect.Left,
                rect.Top,
                Math.Max(1, rect.Right - rect.Left),
                Math.Max(1, rect.Bottom - rect.Top),
                NativeMethods.SwpNoZOrder | NativeMethods.SwpNoActivate);

            if (t < 1)
            {
                return;
            }

            timer.Stop();
            _windowAnim = null;
            _suppressClamp = false;
            completed?.Invoke();
        };
        timer.Start();
    }

    private void StopWindowMotion()
    {
        _windowAnimGeneration++;
        if (_windowAnim is not null)
        {
            _windowAnim.Stop();
            _windowAnim = null;
        }

        _suppressClamp = false;
    }

    private NativeMethods.Rect WorkAreaOf(NativeMethods.Rect reference)
    {
        var monitor = NativeMethods.MonitorFromRect(
            ref reference,
            NativeMethods.MonitorDefaultToNearest);
        if (monitor != IntPtr.Zero)
        {
            var info = new NativeMethods.MonitorInfo
            {
                Size = Marshal.SizeOf<NativeMethods.MonitorInfo>(),
            };
            if (NativeMethods.GetMonitorInfo(monitor, ref info))
            {
                return info.Work;
            }
        }

        return reference;
    }

    private NativeMethods.Rect RestoreRectInPixels(NativeMethods.Rect current)
    {
        try
        {
            var bounds = RestoreBounds;
            if (!bounds.IsEmpty && bounds.Width > 1 && bounds.Height > 1)
            {
                var (scaleX, scaleY) = CurrentDpiScale();
                var left = (int)Math.Round(bounds.Left * scaleX);
                var top = (int)Math.Round(bounds.Top * scaleY);
                return new NativeMethods.Rect
                {
                    Left = left,
                    Top = top,
                    Right = left + (int)Math.Round(bounds.Width * scaleX),
                    Bottom = top + (int)Math.Round(bounds.Height * scaleY),
                };
            }
        }
        catch (InvalidOperationException)
        {
            // RestoreBounds is not available before the window is shown; fall through.
        }

        return current;
    }

    private System.Windows.Window? _snapWindow;
    private System.Windows.Controls.Image? _snapImage;
    private System.Windows.Media.ScaleTransform? _snapScale;
    private System.Windows.Media.TranslateTransform? _snapTranslate;

    /// <summary>
    /// Grabs the current window pixels, shows them in a transparent topmost WPF window and
    /// animates that snapshot (scale towards the taskbar + fade), while the real window is
    /// hidden/minimized underneath. Only WPF draws the snapshot, so the WebView2 airspace and
    /// per-frame reflow problems of a real window-rect animation do not apply.
    /// Returns false when the screenshot could not be taken (caller falls back to an instant
    /// state change).
    /// </summary>
    private bool PlaySnapshotTransition(NativeMethods.Rect bounds, bool minimize)
    {
        var hwnd = _hwnd;
        if (hwnd == IntPtr.Zero)
        {
            return false;
        }

        var width = Math.Max(1, bounds.Right - bounds.Left);
        var height = Math.Max(1, bounds.Bottom - bounds.Top);

        System.Windows.Media.Imaging.BitmapSource snapshot;
        try
        {
            using var bitmap = new System.Drawing.Bitmap(
                width,
                height,
                System.Drawing.Imaging.PixelFormat.Format32bppPArgb);
            using (var graphics = System.Drawing.Graphics.FromImage(bitmap))
            {
                graphics.CopyFromScreen(
                    bounds.Left,
                    bounds.Top,
                    0,
                    0,
                    new System.Drawing.Size(width, height),
                    System.Drawing.CopyPixelOperation.SourceCopy);
            }

            using var stream = new System.IO.MemoryStream();
            bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
            stream.Position = 0;
            var image = new System.Windows.Media.Imaging.BitmapImage();
            image.BeginInit();
            image.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
            image.StreamSource = stream;
            image.EndInit();
            image.Freeze();
            snapshot = image;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"window.snapshot failed: {exception.GetType().Name}");
            return false;
        }

        EnsureSnapshotWindow();
        var (scaleX, scaleY) = CurrentDpiScale();
        _snapImage!.Source = snapshot;
        _snapScale!.ScaleX = 1;
        _snapScale.ScaleY = 1;
        _snapTranslate!.X = 0;
        _snapTranslate.Y = 0;
        _snapWindow!.Opacity = 1;
        _snapWindow.Left = bounds.Left / scaleX;
        _snapWindow.Top = bounds.Top / scaleY;
        _snapWindow.Width = width / scaleX;
        _snapWindow.Height = height / scaleY;
        _snapWindow.Show();
        HostLog.Info($"window.snapshot shown {width}x{height} at {bounds.Left},{bounds.Top}");

        // Cover the real window before it disappears: order matters, otherwise the desktop would
        // flash through between "hide window" and "show snapshot".
        var duration = TimeSpan.FromMilliseconds(minimize ? 220 : 180);
        var easing = new System.Windows.Media.Animation.CubicEase
        {
            EasingMode = System.Windows.Media.Animation.EasingMode.EaseIn,
        };

        var targetScale = minimize ? 0.38 : 0.92;
        var targetFade = minimize ? 0.25 : 0.0;
        var targetShift = minimize ? height / scaleY * 0.55 : 0.0;

        var scaleAnimation = new System.Windows.Media.Animation.DoubleAnimation(targetScale, duration)
        {
            EasingFunction = easing,
        };
        _snapScale.BeginAnimation(System.Windows.Media.ScaleTransform.ScaleXProperty, scaleAnimation);
        _snapScale.BeginAnimation(System.Windows.Media.ScaleTransform.ScaleYProperty, scaleAnimation);
        _snapTranslate.BeginAnimation(
            System.Windows.Media.TranslateTransform.YProperty,
            new System.Windows.Media.Animation.DoubleAnimation(targetShift, duration)
            {
                EasingFunction = easing,
            });
        var fade = new System.Windows.Media.Animation.DoubleAnimation(targetFade, duration)
        {
            EasingFunction = easing,
        };
        fade.Completed += (_, _) => FinishSnapshotTransition(minimize);
        _snapWindow.BeginAnimation(System.Windows.Window.OpacityProperty, fade);

        // Hide the real window on the same frame the snapshot appears.
        if (minimize)
        {
            WindowState = WindowState.Minimized;
        }
        else
        {
            NativeMethods.ShowWindow(hwnd, 0); // SW_HIDE
        }

        return true;
    }

    private void FinishSnapshotTransition(bool minimize)
    {
        var overlay = _snapWindow;
        if (overlay is not null)
        {
            overlay.BeginAnimation(System.Windows.Window.OpacityProperty, null);
            overlay.Hide();
        }

        if (minimize)
        {
            WindowState = WindowState.Minimized;
            return;
        }

        if (_pendingHideToTray)
        {
            _pendingHideToTray = false;
            HideToTray();
            return;
        }

        Dispatcher.BeginInvoke(new Action(Close));
    }

    private void EnsureSnapshotWindow()
    {
        if (_snapWindow is not null)
        {
            return;
        }

        _snapImage = new System.Windows.Controls.Image
        {
            Stretch = System.Windows.Media.Stretch.Fill,
        };
        _snapScale = new System.Windows.Media.ScaleTransform(1, 1);
        _snapTranslate = new System.Windows.Media.TranslateTransform(0, 0);
        var transform = new System.Windows.Media.TransformGroup();
        transform.Children.Add(_snapScale);
        transform.Children.Add(_snapTranslate);
        _snapImage.RenderTransformOrigin = new System.Windows.Point(0.5, 0.55);
        _snapImage.RenderTransform = transform;

        _snapWindow = new System.Windows.Window
        {
            WindowStyle = System.Windows.WindowStyle.None,
            ResizeMode = System.Windows.ResizeMode.NoResize,
            AllowsTransparency = true,
            Background = System.Windows.Media.Brushes.Transparent,
            ShowInTaskbar = false,
            Topmost = true,
            WindowStartupLocation = System.Windows.WindowStartupLocation.Manual,
            UseLayoutRounding = false,
            Content = _snapImage,
        };
    }

    private static NativeMethods.Rect BlendRect(
        NativeMethods.Rect from,
        NativeMethods.Rect to,
        double k)
    {
        int Blend(int a, int b) => (int)Math.Round(a + (b - a) * k);

        return new NativeMethods.Rect
        {
            Left = Blend(from.Left, to.Left),
            Top = Blend(from.Top, to.Top),
            Right = Blend(from.Right, to.Right),
            Bottom = Blend(from.Bottom, to.Bottom),
        };
    }

    private static string DescribeRect(NativeMethods.Rect rect) =>
        $"{rect.Left},{rect.Top} {rect.Right - rect.Left}x{rect.Bottom - rect.Top}";

    private static double EaseOutCubic(double t) => 1 - Math.Pow(1 - t, 3);

    // 慢-快-慢：进出迷你播放器时窗口速度更柔和（反馈一帧跳变/生硬）。
    private static double EaseInOutCubic(double t) =>
        t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2;

    private static double EaseInCubic(double t) => t * t * t;

    public void BeginResize(string edge)
    {
        if (_hwnd == IntPtr.Zero)
        {
            return;
        }

        var hitTest = edge switch
        {
            "left" => NativeMethods.HtLeft,
            "right" => NativeMethods.HtRight,
            "top" => NativeMethods.HtTop,
            "bottom" => NativeMethods.HtBottom,
            _ => 0,
        };
        if (hitTest == 0)
        {
            return;
        }

        CancelPendingDrag("resize");
        if (!IsActive)
        {
            Activate();
        }

        NativeMethods.BeginWindowResize(_hwnd, hitTest);
    }

    public void BeginDrag()
    {
        if (_hwnd == IntPtr.Zero)
        {
            return;
        }

        var generation = Interlocked.Increment(ref _dragGeneration);
        _dragPending = true;
        NativeMethods.GetCursorPos(out var origin);
        _ = StartDragWhenGestureIsClearAsync(generation, origin);
    }

    /// <summary>
    /// The page posts drag on pointerdown, before it can know whether the gesture is a click, a
    /// double click or a real drag. Starting the OS modal move loop on the raw pointerdown captures
    /// the mouse and swallows Chromium's click sequence, so dblclick never fires (the reported
    /// "double click does not maximize" bug). Wait a beat instead: a quick click releases the button
    /// and is dropped, a real drag either moves the cursor or keeps the button held.
    /// </summary>
    private async Task StartDragWhenGestureIsClearAsync(long generation, NativeMethods.Point origin)
    {
        try
        {
            for (var elapsed = 0; elapsed < 180; elapsed += 30)
            {
                await Task.Delay(30);

                if (generation != Interlocked.Read(ref _dragGeneration) || !_dragPending)
                {
                    return;
                }

                if (!NativeMethods.IsLeftButtonDown())
                {
                    _dragPending = false;
                    HostLog.Info("window.drag ignored: the click ended before it became a drag");
                    return;
                }

                if (NativeMethods.GetCursorPos(out var current) &&
                    (Math.Abs(current.X - origin.X) > 3 || Math.Abs(current.Y - origin.Y) > 3))
                {
                    break;
                }
            }

            if (!_dragPending || generation != Interlocked.Read(ref _dragGeneration))
            {
                return;
            }

            _dragPending = false;
            if (!NativeMethods.IsLeftButtonDown())
            {
                // A drag message can outlive the physical click (or be synthetic). Starting the
                // OS move loop without a held button blocks the dispatcher; ignore it instead.
                HostLog.Warn("window.drag ignored: left button is not down");
                return;
            }

            if (!IsActive)
            {
                Activate();
            }

            NativeMethods.BeginWindowDrag(_hwnd);
        }
        catch (Exception exception)
        {
            _dragPending = false;
            HostLog.Error("window.drag failed", exception);
        }
    }

    /// <summary>
    /// A page window command arrived while a drag was queued: the click sequence is actually a
    /// double click, so the queued move loop must not run on top of the state change.
    /// </summary>
    private void CancelPendingDrag(string command)
    {
        if (!_dragPending)
        {
            return;
        }

        _dragPending = false;
        Interlocked.Increment(ref _dragGeneration);
        HostLog.Info($"window.drag cancelled by {command}");
    }

    public void ShowError(string title, string message)
    {
        Dispatcher.BeginInvoke(new Action(() =>
        {
            ErrorTitle.Text = title;
            ErrorMessage.Text = message;
            ErrorLogHint.Text = $"日志：{HostLog.LogPath}";
            Browser.Visibility = Visibility.Collapsed;
            ErrorPanel.Visibility = Visibility.Visible;
        }));
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == NativeMethods.WmGetMinMaxInfo)
        {
            ApplyWindowLimits(hwnd, lParam);
            handled = true;
        }
        else if (msg == NativeMethods.WmMoving)
        {
            // Live correction while the OS move loop runs: modifying the proposed rect is what
            // stops the window from being dragged so far that its title bar becomes unreachable.
            var proposed = Marshal.PtrToStructure<NativeMethods.Rect>(lParam);
            var clamped = ClampToWorkArea(proposed);
            if (!SameRect(proposed, clamped))
            {
                Marshal.StructureToPtr(clamped, lParam, true);
            }
        }
        else if (msg == NativeMethods.WmExitSizeMove)
        {
            ClampWindowToWorkArea();
        }
        else if (msg == NativeMethods.WmHotkey)
        {
            OnHotkey(wParam.ToInt32());
            handled = true;
        }
        else if (msg == NativeMethods.WmAppCommand)
        {
            handled = HandleAppCommand(lParam);
        }

        return IntPtr.Zero;
    }

    /// <summary>
    /// 部分键盘驱动 / OEM 热键服务按下「系统切换音乐」键时不发 VK_MEDIA_* 按键，而是往
    /// 前台窗口投一条 WM_APPCOMMAND 消息；底层键盘钩子看不到这条路径，只能在这里兜接。
    /// 只在本机是当前媒体会话且快捷键总开关打开时接住，其余情况返回 false 交给系统默认处理，
    /// 保留「媒体键跟着当前播放器走」的原生行为。
    /// </summary>
    private bool HandleAppCommand(IntPtr lParam)
    {
        var command = (int)((lParam.ToInt64() >> 16) & 0x0FFF);
        var action = command switch
        {
            NativeMethods.AppCommandMediaNextTrack => "next",
            NativeMethods.AppCommandMediaPrevTrack => "prev",
            NativeMethods.AppCommandMediaPlayPause => "togglePlay",
            _ => null,
        };
        if (action is null)
        {
            return false;
        }

        var owns = _media?.IsCurrentSession == true;
        HostLog.Info($"[appcommand] command={command} action={action} ours={(owns ? "true" : "false")}");
        if (!_shortcutsEnabled || !owns)
        {
            return false;
        }

        HostLog.Info($"[appcommand] fire action={action}");
        SendCommand(action);
        return true;
    }

    private void ApplyWindowLimits(IntPtr hwnd, IntPtr lParam)
    {
        var info = Marshal.PtrToStructure<NativeMethods.MinMaxInfo>(lParam);

        var (scaleX, scaleY) = CurrentDpiScale();

        info.MinTrackSize.X = (int)Math.Ceiling(MinWidth * scaleX);
        info.MinTrackSize.Y = (int)Math.Ceiling(MinHeight * scaleY);

        // A borderless window maximizes over the taskbar by default; clamp it to the work area.
        var monitor = NativeMethods.MonitorFromWindow(hwnd, NativeMethods.MonitorDefaultToNearest);
        if (monitor != IntPtr.Zero)
        {
            var monitorInfo = new NativeMethods.MonitorInfo
            {
                Size = Marshal.SizeOf<NativeMethods.MonitorInfo>(),
            };
            if (NativeMethods.GetMonitorInfo(monitor, ref monitorInfo))
            {
                info.MaxPosition.X = monitorInfo.Work.Left - monitorInfo.Monitor.Left;
                info.MaxPosition.Y = monitorInfo.Work.Top - monitorInfo.Monitor.Top;
                info.MaxSize.X = monitorInfo.Work.Right - monitorInfo.Work.Left;
                info.MaxSize.Y = monitorInfo.Work.Bottom - monitorInfo.Work.Top;
                // NOTE: MaxTrackSize intentionally left untouched; pinning it to the work area
                // makes an edge drag jump straight to the monitor work area size on some setups.
            }
        }

        Marshal.StructureToPtr(info, lParam, true);
    }

    /// <summary>
    /// Keeps at least a grab-able slice of the title bar inside the nearest monitor's work area.
    /// Horizontal overflow alone is harmless as long as part of the bar is visible; vertical
    /// overflow past the bottom is what makes a frameless window impossible to recover.
    /// </summary>
    private NativeMethods.Rect ClampToWorkArea(NativeMethods.Rect rect)
    {
        try
        {
            var monitor = NativeMethods.MonitorFromRect(ref rect, NativeMethods.MonitorDefaultToNearest);
            if (monitor == IntPtr.Zero)
            {
                return rect;
            }

            var info = new NativeMethods.MonitorInfo
            {
                Size = Marshal.SizeOf<NativeMethods.MonitorInfo>(),
            };
            if (!NativeMethods.GetMonitorInfo(monitor, ref info))
            {
                return rect;
            }

            var work = info.Work;
            var (scaleX, scaleY) = CurrentDpiScale();
            var width = rect.Right - rect.Left;
            var height = rect.Bottom - rect.Top;
            var minVisibleX = (int)Math.Ceiling(Math.Min(MinVisibleWidthDip * scaleX, width * 0.5));
            var titleBar = (int)Math.Ceiling(Math.Min(TitleBarVisibleHeightDip * scaleY, height * 0.5));

            void ShiftHorizontal(int dx)
            {
                rect.Left += dx;
                rect.Right += dx;
            }

            void ShiftVertical(int dy)
            {
                rect.Top += dy;
                rect.Bottom += dy;
            }

            if (rect.Left > work.Right - minVisibleX)
            {
                ShiftHorizontal(-(rect.Left - (work.Right - minVisibleX)));
            }

            if (rect.Right < work.Left + minVisibleX)
            {
                ShiftHorizontal((work.Left + minVisibleX) - rect.Right);
            }

            if (rect.Top < work.Top)
            {
                ShiftVertical(work.Top - rect.Top);
            }

            if (rect.Top > work.Bottom - titleBar)
            {
                ShiftVertical(-(rect.Top - (work.Bottom - titleBar)));
            }

            return rect;
        }
        catch (Exception exception)
        {
            HostLog.Error("window.clamp failed", exception);
            return rect;
        }
    }

    private void ClampWindowToWorkArea()
    {
        if (_suppressClamp || _windowAnim is not null)
        {
            // A maximize/restore motion is driving the rect; clamping mid-flight would fight it.
            return;
        }

        if (_hwnd == IntPtr.Zero || WindowState != WindowState.Normal)
        {
            return;
        }

        if (!NativeMethods.GetWindowRect(_hwnd, out var current))
        {
            return;
        }

        var clamped = ClampToWorkArea(current);
        if (SameRect(current, clamped))
        {
            return;
        }

        var width = clamped.Right - clamped.Left;
        var height = clamped.Bottom - clamped.Top;
        if (NativeMethods.SetWindowPos(
                _hwnd,
                IntPtr.Zero,
                clamped.Left,
                clamped.Top,
                width,
                height,
                NativeMethods.SwpNoZOrder | NativeMethods.SwpNoActivate))
        {
            HostLog.Info(
                $"window.clamp left={current.Left}->{clamped.Left} top={current.Top}->{clamped.Top} " +
                $"size={width}x{height}");
        }
    }

    private (double ScaleX, double ScaleY) CurrentDpiScale()
    {
        try
        {
            var dpi = VisualTreeHelper.GetDpi(this);
            return (dpi.DpiScaleX, dpi.DpiScaleY);
        }
        catch (InvalidOperationException)
        {
            // Not measured yet; keep the 1:1 fallback rather than failing the message.
            return (1, 1);
        }
    }

    private static bool SameRect(NativeMethods.Rect left, NativeMethods.Rect right) =>
        left.Left == right.Left &&
        left.Top == right.Top &&
        left.Right == right.Right &&
        left.Bottom == right.Bottom;
}
