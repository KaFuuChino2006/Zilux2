using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
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
    // 页面满窗铺满整个客户区：窗口四周不再留 WPF 主题色描边（用户看到的「框」就是那 6px
    // 主题底色）。边缘/四角的缩放改由注入页面的 5px pointerdown 热区触发 {type:'resize'}
    // （见 WebViewHost.EdgeResizeScript / MainWindow.BeginResize）；WindowChrome 的 6px
    // ResizeBorderThickness 只留给 WPF 自己绘制的错误面板。
    // 无边框窗口的圆角：Win11 交给 DWM（DWMWCP_ROUND），Win10 回退到 SetWindowRgn。
    private const double WindowCornerRadiusDip = 8;

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
    private SystemAudioOsdWindow? _systemAudioOsd;
    private DispatcherTimer? _systemAudioWatch;
    private SystemAudioOutputDevice? _lastSystemAudioDevice;
    private IntPtr _hwnd;
    private long _dragGeneration;
    private bool _dragPending;

    // 常规窗口状态由 Windows 合成器负责。逐帧改窗口大小会让 WebView2 每帧重新布局，
    // 屏幕截图过渡又会拍到遮挡窗口，均不适合作为常规窗口动画。
    // 应用内模式只为「关闭到托盘」补一个短暂整窗淡出。
    // 设置项在「设置 → 外观 → 窗口动画」，这里每次动作时读取，切换后立即生效。
    private bool NativeWindowAnim =>
        string.Equals(_settings?.WindowAnimation, AppearanceSettings.WindowAnimationNative, StringComparison.Ordinal);

    private const int CloseAnimationMs = 150;
    private DispatcherTimer? _windowAnim;
    private EventHandler? _windowAnimRendering;
    private long _windowAnimGeneration;
    private bool _suppressClamp;
    private NativeMethods.Rect _restoreRect;
    private bool _hasRestoreRect;

    // 迷你播放器模式（契约 docs/zilux2-host-contract.md §15）：进入前保存原窗口状态，退出时精确还原。
    private const double MiniDefaultWidthDip = 420;
    private const double MiniDefaultHeightDip = 120;
    // 尺寸预设：compact=360×100、standard=420×120、wide=520×150（设置页可选，宿主按 appearance.miniSize 兜底）。
    private const double MiniCompactWidthDip = 360;
    private const double MiniCompactHeightDip = 100;
    private const double MiniWideWidthDip = 520;
    private const double MiniWideHeightDip = 150;
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
    // 才真正退出。
    private bool _isHiddenToTray;
    private bool _isExiting;
    private bool _closePending;

    // 启动/托盘恢复的「先隐藏、有内容再淡入」：WebView2 初始化 + 首帧大约要 1~3 秒，
    // 直接 Show 会先露出空白的主题底色窗壳。窗口先以 Opacity=0 显示（WebView2 需要已加载
    // 才能初始化），首个页面 ready / 导航完成后再淡入；5 秒兜底避免页面异常时窗口一直不出现。
    private bool _startupRevealed;
    private DispatcherTimer? _revealTimer;
    private WindowState _lastWindowState = WindowState.Normal;
    private readonly List<int> _registeredHotkeys = new();

    // 全局热键：配置来自 settings.shortcuts（字符串解析见 HotkeyBinding，默认值/候选链见
    // HotkeyCatalog）。_lastAppliedShortcuts 记录每个动作上一次注册成功的组合，用于非法配置时
    // 保留可用注册；_shortcutItems/_shortcutStateJson 是回推页面的生效状态。
    private readonly Dictionary<string, HotkeyBinding> _lastAppliedShortcuts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HotkeyBinding> _activeShortcutBindings = new(StringComparer.Ordinal);
    private readonly List<ShortcutItemState> _shortcutItems = new();
    private string? _shortcutStateJson;
    private bool _shortcutsEnabled = true;
    private bool _alwaysHandleMediaKeys = true;

    // 系统媒体键接管：别的程序用 RegisterHotKey 抢注媒体键后，本机 SMTC 收不到 ButtonPressed，
    // 由底层键盘钩子兜底（详见 MediaKeyHookService）；是否接管由 shortcuts.alwaysHandleMediaKeys
    // 决定，关闭后退回「媒体键跟着当前播放器走」的原生行为。
    private MediaKeyHookService? _mediaKeyHook;

    // 全局热键的底层钩子兜底（详见 GlobalHotkeyHookService）：RegisterHotKey 在组合被抢占或
    // 前台是管理员窗口时会失效，钩子仍能看到物理按键。两条通路各记一份触发时间，只做跨通路去重。
    private GlobalHotkeyHookService? _hotkeyHook;
    private int _hotkeyHookAttempts;
    private readonly Dictionary<string, int> _lastHookFireTicks = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _lastRegisteredFireTicks = new(StringComparer.Ordinal);
    // 鼠标侧键前进/后退（WH_MOUSE_LL）：Chromium 会把侧键当浏览器历史，这里先截下来交给页面。
    private MouseNavigationHookService? _mouseNavHook;

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

    private static bool IsWindows11 => OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000);

    // The SMTC session is window scoped, so the host needs the native handle once it is created.
    internal IntPtr Handle => _hwnd;

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        _hwnd = new WindowInteropHelper(this).Handle;
        HwndSource.FromHwnd(_hwnd)?.AddHook(WndProc);
        ApplyWindowCornerPreference();
        ApplyWindowCornerRegion();
        // Explorer 重启后 Progman/WorkerW 会重建，桌面背景歌词窗口会被连带销毁；
        // 任务栏重建时会广播 TaskbarCreated，收到后重新挂一层。
        _taskbarCreatedMessage = NativeMethods.RegisterWindowMessage("TaskbarCreated");
        StartHotkeyHook();
        StartMouseNavigationHook();
        ApplyShortcutSettings("startup");
        InstallMediaKeyHook();
    }

    /// <summary>
    /// Win11：让 DWM 画窗口圆角（DWMWCP_ROUND），并用 DWMWA_BORDER_COLOR=COLOR_NONE 去掉
    /// 系统给无边框窗口补的那条 1px 边框。失败不致命（只是保持直角），Win10 直接跳过。
    /// </summary>
    private void ApplyWindowCornerPreference()
    {
        if (_hwnd == IntPtr.Zero || !IsWindows11)
        {
            return;
        }

        try
        {
            var preference = NativeMethods.DwmWindowCornerRound;
            var result = NativeMethods.DwmSetWindowAttribute(
                _hwnd, NativeMethods.DwmWindowCornerPreference, ref preference, sizeof(int));
            if (result != 0)
            {
                HostLog.Warn($"window.corner dwm failed hr=0x{result:X8}");
            }

            var border = NativeMethods.DwmColorNone;
            NativeMethods.DwmSetWindowAttribute(
                _hwnd, NativeMethods.DwmWindowBorderColor, ref border, sizeof(int));
            HostLog.Info("window.corner dwm round");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"window.corner dwm unavailable: {exception.Message}");
        }
    }

    /// <summary>
    /// Win10 回退：SetWindowRgn + CreateRoundRectRgn 把窗口裁成圆角矩形。半径按窗口所在
    /// 显示器的物理 DPI 换算；最大化/最小化/迷你态交给系统或迷你态自己的区域，这里清空。
    /// Win11 由 DWM 处理，不走这里。
    /// 注意：SetWindowRgn 是硬裁剪，边缘会有锯齿、也会失去 DWM 给无边框窗口的阴影——这是
    /// Win10 没有 DWMWCP_ROUND 的固有取舍；半径取 8 DIP 对齐 Win11 DWM 默认，保证两平台观感接近。
    /// </summary>
    private void ApplyWindowCornerRegion()
    {
        if (_hwnd == IntPtr.Zero || IsWindows11)
        {
            return;
        }

        try
        {
            if (WindowState != WindowState.Normal || _miniMode || _miniAnimating)
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

            var dpi = NativeMethods.GetDpiForWindow(_hwnd);
            var scale = dpi >= 48 ? dpi / 96.0 : 1.0;
            var radius = Math.Max(2, (int)Math.Round(WindowCornerRadiusDip * scale));
            var region = NativeMethods.CreateRoundRectRgn(0, 0, width + 1, height + 1, radius * 2, radius * 2);
            if (region == IntPtr.Zero)
            {
                return;
            }

            NativeMethods.SetWindowRgn(_hwnd, region, true);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"window.corner region failed: {exception.Message}");
        }
    }

    /// <summary>
    /// 页面首帧/导航完成前窗口保持可见，但盖着纯色 StartupVeil；内容就绪后淡出遮罩。
    /// 5 秒兜底，避免页面异常时遮罩一直不消失（错误面板会自己提前揭示）。
    /// </summary>
    private void StartStartupRevealWatchdog()
    {
        if (_startupRevealed)
        {
            return;
        }

        _revealTimer = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromSeconds(5),
        };
        _revealTimer.Tick += (_, _) =>
        {
            HostLog.Warn("window.reveal fallback: content was not ready in time");
            RevealWindow("startup-fallback");
        };
        _revealTimer.Start();
    }

    private void OnHostFirstContentReady()
    {
        // 页面已经渲染出首帧：让 WPF 走完这一轮布局/呈现再揭示，别闪一帧空白。
        Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(() => RevealWindow("first-content")));
    }

    private void RevealWindow(string reason)
    {
        _revealTimer?.Stop();
        _revealTimer = null;
        if (_startupRevealed)
        {
            return;
        }

        _startupRevealed = true;
        StartupVeil.IsHitTestVisible = false;
        if (ErrorPanel.Visibility != Visibility.Visible)
        {
            Browser.Visibility = Visibility.Visible;
        }

        HostLog.Info($"window.reveal reason={reason} veil=out");
        var animation = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(260))
        {
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        animation.Completed += (_, _) =>
        {
            StartupVeil.BeginAnimation(OpacityProperty, null);
            StartupVeil.Visibility = Visibility.Collapsed;
            StartupVeil.Opacity = 0;
        };
        StartupVeil.BeginAnimation(OpacityProperty, animation);
    }

    /// <summary>窗口从不可见/空白状态恢复时淡入；窗口本身已经可见时不做任何事。</summary>
    private void FadeWindowIn(string reason)
    {
        if (_isHiddenToTray)
        {
            return;
        }

        var from = Opacity;
        if (from >= 1)
        {
            return;
        }

        // 起新淡入前先停掉可能还在跑的旧动画，并把当前值固化成基准，避免叠加。
        BeginAnimation(Window.OpacityProperty, null);
        Opacity = from;

        HostLog.Info($"window.fadeIn reason={reason} from={from:0.00}");
        var animation = new DoubleAnimation(from, 1, TimeSpan.FromMilliseconds(140))
        {
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
        };
        animation.Completed += (_, _) =>
        {
            BeginAnimation(Window.OpacityProperty, null);
            Opacity = 1;
        };
        BeginAnimation(Window.OpacityProperty, animation);
    }

    /// <summary>钩子线程只用来看按键，触发动作要回到 UI 线程；启动失败不影响 RegisterHotKey。</summary>
    private void StartHotkeyHook()
    {
        if (_hotkeyHook is not null || _hotkeyHookAttempts >= 3)
        {
            return;
        }

        _hotkeyHookAttempts++;
        var hook = new GlobalHotkeyHookService(action =>
            Dispatcher.BeginInvoke(DispatcherPriority.Normal, new Action(() => OnHookHotkey(action))));
        if (!hook.Start())
        {
            // RegisterHotKey 仍是主通路；钩子失败只影响被抢占/管理员前台时的兜底（B21）。
            HostLog.Warn($"hotkey.hook unavailable attempt={_hotkeyHookAttempts}");
            hook.Dispose();
            return;
        }

        _hotkeyHook = hook;
        UpdateHotkeyHookBindings();
    }

    private void OnHookHotkey(string action)
    {
        HostLog.Info($"hotkey.hook.fire action={action}");
        // 统一走 FireHotkey：由它做跨通路去重并写入时间戳。
        FireHotkey(action, "hook");
    }

    /// <summary>
    /// 鼠标侧键（后退 / 前进）全局钩子：只在本机窗口被指到时拦截，转成页面 command。
    /// 页面自己维护前进/后退历史（不依赖浏览器历史，避免整页重载）。
    /// </summary>
    private void StartMouseNavigationHook()
    {
        if (_mouseNavHook is not null)
        {
            return;
        }

        var hook = new MouseNavigationHookService(forward =>
            Dispatcher.BeginInvoke(DispatcherPriority.Input, new Action(() =>
            {
                HostLog.Info($"mouseNav.fire action={(forward ? "navForward" : "navBack")}");
                SendCommand(forward ? "navForward" : "navBack");
            })));
        if (hook.Start())
        {
            _mouseNavHook = hook;
        }
        else
        {
            hook.Dispose();
        }
    }

    private void DispatchHotkeyAction(string action)
    {
        if (action == "toggleWindow")
        {
            ToggleFromTray();
            return;
        }

        // 系统输出切换完全在宿主侧完成（不经过页面），切完把最新状态推给设置页。
        if (action == "systemOutput")
        {
            CycleSystemOutput();
            return;
        }

        SendCommand(action);
    }

    /// <summary>快捷键：轮换 Windows 默认播放设备（保持本软件自己的输出通道不变）。</summary>
    internal void CycleSystemOutput()
    {
        var rotation = _settings?.SystemOutputRotation ?? Array.Empty<string>();
        var before = SystemAudioOutputService.CurrentDefault();
        var next = SystemAudioOutputService.Cycle(rotation);
        HostLog.Info(next is null
            ? "[audioOutput] shortcut cycle failed"
            : $"[audioOutput] shortcut cycle -> {next.Name}");
        if (next is not null)
        {
            ShowSystemAudioOsd(before, next);
        }

        _host?.PostAudioOutputState();
    }

    /// <summary>显示系统音频切换 OSD；同一个设备不重复弹。</summary>
    private void ShowSystemAudioOsd(SystemAudioOutputDevice? from, SystemAudioOutputDevice to)
    {
        if (to is null || Dispatcher.HasShutdownStarted)
        {
            return;
        }

        if (from is not null && string.Equals(from.Id, to.Id, StringComparison.Ordinal))
        {
            return;
        }

        _lastSystemAudioDevice = to;
        HostLog.Info($"[audioOsd] show from={from?.Name ?? "?"} to={to.Name}");
        try
        {
            _systemAudioOsd ??= new SystemAudioOsdWindow();
            _systemAudioOsd.ShowTransition(from, to);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[audioOsd] show failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private void StartSystemAudioWatch()
    {
        if (_systemAudioWatch is not null)
        {
            return;
        }

        _lastSystemAudioDevice = SystemAudioOutputService.CurrentDefault();
        _systemAudioWatch = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(2500),
        };
        _systemAudioWatch.Tick += (_, _) =>
        {
            var current = SystemAudioOutputService.CurrentDefault();
            if (current is null)
            {
                return;
            }

            var previous = _lastSystemAudioDevice;
            if (previous is not null && !string.Equals(previous.Id, current.Id, StringComparison.Ordinal))
            {
                ShowSystemAudioOsd(previous, current);
            }
            else
            {
                _lastSystemAudioDevice = current;
            }
        };
        _systemAudioWatch.Start();
    }

    /// <summary>把「当前实际生效的组合」同步给钩子：注册失败/回落时钩子用同一份配置兜底。</summary>
    private void UpdateHotkeyHookBindings()
    {
        if (_hotkeyHook is null)
        {
            return;
        }

        var bindings = new List<HotkeyHookBinding>();
        if (_shortcutsEnabled)
        {
            foreach (var spec in HotkeyCatalog.Actions)
            {
                if (_activeShortcutBindings.TryGetValue(spec.Action, out var active))
                {
                    bindings.Add(new HotkeyHookBinding(active.Modifiers, active.VirtualKey, spec.Action));
                }
            }
        }

        _hotkeyHook.UpdateBindings(bindings);
        HostLog.Info($"hotkey.hook bindings={bindings.Count} [{string.Join(", ", bindings.Select(b => b.Action + "=" + b.VirtualKey))}]");
    }

    private void OnLoaded(object? sender, RoutedEventArgs e)
    {
        Loaded -= OnLoaded;
        _host = new WebViewHost(this, Browser, _plan, _settings, _audio, _media, _airplay);
        _host.SharedEnvironmentReady += OnHostEnvironmentReady;
        _host.FirstContentReady += OnHostFirstContentReady;
        _host.SystemAudioOutputChanged += ShowSystemAudioOsd;
        StartSystemAudioWatch();
        _ = _host.InitializeAsync();
        StartStartupRevealWatchdog();
        ApplyDesktopLyricsSettings();
        ApplyBackgroundLyricsSettings();
    }

    // 桌面歌词窗口开关/样式都从设置里读；页面推当前句及相邻句。
    private DesktopLyricsWindow? _desktopLyricsWindow;
    private double _desktopLyricsLeft = double.NaN;
    private double _desktopLyricsTop = double.NaN;
    private bool _desktopLyricsClosingFromSettings;

    internal void ApplyDesktopLyricsSettings()
    {
        var options = _settings?.DesktopLyricsOptions;
        var enabled = options?.Enabled == true;
        if (!enabled)
        {
            if (_desktopLyricsWindow is not null)
            {
                var closing = _desktopLyricsWindow;
                // 从设置里关掉桌面歌词时也记住位置：否则下次开启会回到默认位置（用户右键关闭时
                // 由 OnDesktopLyricsClosedByUser 保存，两条路径要保持一致）。
                if (!double.IsNaN(closing.Left) && !double.IsNaN(closing.Top))
                {
                    _desktopLyricsLeft = closing.Left;
                    _desktopLyricsTop = closing.Top;
                }

                _desktopLyricsWindow = null;
                PersistDesktopLyricsPosition(_desktopLyricsLeft, _desktopLyricsTop);
                // 从设置关窗也是程序化关闭：ClosedByUser 不再回写 desktopLyrics=false，
                // 避免第二次 GeneralChanged 与本轮位置 patch 互相触发。
                _desktopLyricsClosingFromSettings = true;
                try
                {
                    closing.Close();
                }
                finally
                {
                    _desktopLyricsClosingFromSettings = false;
                }
            }

            return;
        }

        if (_desktopLyricsWindow is null)
        {
            var window = new DesktopLyricsWindow(_settings);
            window.ClosedByUser += OnDesktopLyricsClosedByUser;
            if (_settings?.DesktopLyricsPosition is { } saved)
            {
                // 设置里的坐标优先：拖动后关闭、重启仍回到上次位置（P3-13）。
                window.Left = saved.Left;
                window.Top = saved.Top;
            }
            else if (!double.IsNaN(_desktopLyricsLeft) && !double.IsNaN(_desktopLyricsTop))
            {
                window.Left = _desktopLyricsLeft;
                window.Top = _desktopLyricsTop;
            }
            else
            {
                window.PlaceDefault();
            }

            _desktopLyricsWindow = window;
            window.Show();
            HostLog.Info("[lyrics] desktop window shown");
        }

        _desktopLyricsWindow.ApplyStyle(
            options?.FontSize ?? 40,
            options?.Locked == true,
            options?.Topmost != false,
            options?.Weight ?? GeneralSettings.DesktopLyricsWeightNormal,
            options?.BackdropOpacity ?? 40);
    }

    internal void UpdateDesktopLyrics(string now, string translation, string previous, string next,
        IReadOnlyList<DesktopLyricWord> words, int activeWord)
    {
        _desktopLyricsWindow?.UpdateLines(now, translation, previous, next, words, activeWord);
    }

    /// <summary>把桌面歌词最后一次位置写回设置（P3-13）；非有限值直接忽略。</summary>
    private void PersistDesktopLyricsPosition(double left, double top)
    {
        if (!double.IsFinite(left) || !double.IsFinite(top))
        {
            return;
        }

        try
        {
            var payload = JsonSerializer.Serialize(new
            {
                general = new { desktopLyricsLeft = left, desktopLyricsTop = top },
            });
            using var document = JsonDocument.Parse(payload);
            _settings?.Patch(document.RootElement);
            HostLog.Info($"[lyrics] position saved left={left} top={top}");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[lyrics] persist position failed: {exception.Message}");
        }
    }

    private void OnDesktopLyricsClosedByUser()
    {
        // 退出应用（托盘退出 / 更新重启 / 系统关机）时宿主会统一关闭所有窗口；这不是用户
        // 想关歌词，不能把 desktopLyrics 回写成 false，否则下次启动歌词窗不再出现。
        if (_isExiting)
        {
            _desktopLyricsWindow = null;
            return;
        }

        if (_desktopLyricsClosingFromSettings)
        {
            _desktopLyricsWindow = null;
            return;
        }

        if (_desktopLyricsWindow is not null)
        {
            _desktopLyricsLeft = _desktopLyricsWindow.Left;
            _desktopLyricsTop = _desktopLyricsWindow.Top;
        }

        _desktopLyricsWindow = null;
        HostLog.Info("[lyrics] desktop window hidden by user");
        try
        {
            // 关闭与位置合并成一次 patch，避免两次 GeneralChanged 重复 Apply（P3-13）。
            var hasPosition = double.IsFinite(_desktopLyricsLeft) && double.IsFinite(_desktopLyricsTop);
            var payload = hasPosition
                ? JsonSerializer.Serialize(new
                {
                    general = new
                    {
                        desktopLyrics = false,
                        desktopLyricsLeft = _desktopLyricsLeft,
                        desktopLyricsTop = _desktopLyricsTop,
                    },
                })
                : "{\"general\":{\"desktopLyrics\":false}}";
            using var document = JsonDocument.Parse(payload);
            _settings?.Patch(document.RootElement);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[lyrics] sync desktopLyrics=false failed: {exception.Message}");
        }
    }

    // 桌面背景歌词：把一个 WebView2 窗口挂到桌面壁纸层（Progman 的图标层下方）当播放器用。
    // 歌词页的视觉效果、背景模式、样式设置都来自同一份站点存储，窗口只负责渲染。
    private DesktopBackgroundWindow? _backgroundLyricsWindow;
    // 最近一次 online 事件（端口/token）。背景窗还没创建时先缓存，等窗口 Show 后补发（B04）。
    private string? _lastOnlineJson;
    private uint _taskbarCreatedMessage;

    private void OnHostEnvironmentReady()
    {
        ApplyBackgroundLyricsSettings();
    }

    internal void ApplyBackgroundLyricsSettings()
    {
        var enabled = _settings?.BackgroundLyricsEnabled == true;
        if (!enabled)
        {
            CloseBackgroundLyrics();
            return;
        }

        if (_backgroundLyricsWindow is not null)
        {
            return;
        }

        // 背景窗口必须复用主窗口的 WebView2 环境（同 user data folder 才能共享站点存储）；
        // 环境可能还在初始化，等 SharedEnvironmentReady 回调时再补一次。
        var environment = _host?.SharedEnvironment;
        if (environment is null || _settings is null)
        {
            return;
        }

        var window = new DesktopBackgroundWindow(environment, _settings, _plan);
        window.Closed += OnBackgroundLyricsClosed;
        window.InitFailed += OnBackgroundLyricsInitFailed;
        _backgroundLyricsWindow = window;
        window.Show();
        // 场景页可能在 online 事件之后才打开：把最近一次端点补发过去（B04）。
        window.PostOnlineInfo(_lastOnlineJson);
        HostLog.Info("[bgLyrics] desktop background window shown");
    }

    internal void ForwardToBackgroundLyrics(string json)
    {
        _backgroundLyricsWindow?.PostJson(json);
    }

    /// <summary>主 WebView 收到 online 端点时同步给背景歌词场景（B04）；窗口未开先缓存。</summary>
    internal void ForwardOnlineToBackgroundLyrics(string? json)
    {
        if (string.IsNullOrEmpty(json))
        {
            return;
        }

        _lastOnlineJson = json;
        _backgroundLyricsWindow?.PostOnlineInfo(json);
    }

    /// <summary>页面播放状态变化 → 托盘菜单文案同步（B23）。</summary>
    internal void NotifyPlaybackState(bool playing) => App.Tray?.UpdatePlaybackState(playing);

    /// <summary>托盘「解锁桌面歌词」：锁定后窗口鼠标穿透，右键菜单点不到，只能从这里解锁（P2-03）。</summary>
    internal void UnlockDesktopLyrics()
    {
        var window = _desktopLyricsWindow;
        if (window is not null)
        {
            window.SetLocked(false);
            return;
        }

        try
        {
            using var document = JsonDocument.Parse("{\"general\":{\"desktopLyricsLocked\":false}}");
            _settings?.Patch(document.RootElement);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[lyrics] unlock failed: {exception.Message}");
        }
    }

    /// <summary>托盘「设置…」：先把主窗口带回前台，再让页面打开设置页（P3-08）。</summary>
    internal void OpenSettingsFromTray()
    {
        ShowFromTray();
        SendCommand("openSettings");
    }

    /// <summary>背景窗口 WebView2 初始化失败：回滚开关，避免留下一个空白壁纸窗（B09）。</summary>
    private void OnBackgroundLyricsInitFailed()
    {
        HostLog.Warn("[bgLyrics] init failed, disabling background lyrics");
        Dispatcher.BeginInvoke(new Action(() =>
        {
            try
            {
                using var document = JsonDocument.Parse("{\"general\":{\"backgroundLyrics\":false}}");
                _settings?.Patch(document.RootElement);
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[bgLyrics] rollback backgroundLyrics failed: {exception.Message}");
            }
        }));
    }

    private void OnBackgroundLyricsClosed(object? sender, EventArgs e)
    {
        if (ReferenceEquals(_backgroundLyricsWindow, sender))
        {
            _backgroundLyricsWindow = null;
            HostLog.Info("[bgLyrics] desktop background window closed");
        }
    }

    private async void OnShellRestarted()
    {
        HostLog.Info("[bgLyrics] shell restarted (TaskbarCreated)");
        if (_isExiting)
        {
            // 退出流程中不再重建壁纸窗（B20）。
            return;
        }

        if (_settings?.BackgroundLyricsEnabled != true)
        {
            return;
        }

        // 旧窗口已经随 Progman 一起销毁，重建并重新挂到新的桌面层。
        CloseBackgroundLyrics();

        // WebView2 的 controller 销毁和共用 environment 上的新建有竞态：立刻重建偶发
        // InvalidCastException（QueryInterface 拿到已失效的 controller），先让旧的完全收尾。
        try
        {
            await Task.Delay(700);
            if (_settings?.BackgroundLyricsEnabled == true)
            {
                ApplyBackgroundLyricsSettings();
            }
        }
        catch (Exception exception)
        {
            HostLog.Error("[bgLyrics] shell restart rebuild failed", exception);
        }
    }

    private void CloseBackgroundLyrics()
    {
        var window = _backgroundLyricsWindow;
        if (window is null)
        {
            return;
        }

        _backgroundLyricsWindow = null;
        window.Closed -= OnBackgroundLyricsClosed;
        try
        {
            window.Close();
        }
        catch (Exception exception)
        {
            // Explorer 重启时父窗口先被销毁，这里再 Close 可能抛「窗口已关闭」。
            HostLog.Warn($"[bgLyrics] close background window failed: {exception.Message}");
        }

        // Close 失败时窗口对象可能还没走过 OnClosed（HWND 已被 Explorer 连带销毁），
        // 这里补一次释放并抑制 HwndHost 终结器，避免终结器线程上的 COM 异常终止进程。
        window.DisposeBrowser();

        HostLog.Info("[bgLyrics] desktop background window hidden");
    }

    private void OnStateChanged(object? sender, EventArgs e)
    {
        var maximized = IsMaximized;
        var wasMinimized = _lastWindowState == WindowState.Minimized;
        _lastWindowState = WindowState;
        HostLog.Info($"window.state maximized={maximized}");
        _host?.PostWindowState(maximized);

        // Feature frames are only worth producing while the stage is actually on screen.
        UpdateAudioPauseState();
        if (WindowState == WindowState.Minimized)
        {
            // P1-10：主窗最小化后停止 AirPlay 推流，避免继续占用接收端/网络。
            StopAirPlayStreaming("minimize");
        }
        else if (wasMinimized)
        {
            // 从最小化恢复（任务栏点击/托盘）：WebView2 的子 HWND 偶尔不跟着重画，表现
            // 为只剩一块窗口底色的空壳。顶一下 WebView2 表面，逼它重新排列并重绘。
            _host?.RefreshSurface();
        }

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

        Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(ApplyWindowCornerRegion));
    }

    private void UpdateAudioPauseState()
    {
        // 隐藏到托盘时窗口仍是 Normal，必须显式算进去（B12）。
        _audio?.SetPaused(_isHiddenToTray || WindowState == WindowState.Minimized);
    }

    private void StopAirPlayStreaming(string reason)
    {
        var airplay = _airplay;
        if (airplay is null)
        {
            return;
        }

        try
        {
            HostLog.Info($"[airplay] disconnect reason={reason}");
            airplay.Disconnect();
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[airplay] disconnect failed reason={reason}: {exception.Message}");
        }
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        CloseBackgroundLyrics();

        _systemAudioWatch?.Stop();
        _systemAudioWatch = null;
        if (_systemAudioOsd is not null)
        {
            _systemAudioOsd.Close();
            _systemAudioOsd = null;
        }

        if (_settings is not null)
        {
            _settings.ShortcutsChanged -= OnShortcutsChanged;
        }

        App.ArmShutdownWatchdog();
        _mediaKeyHook?.Dispose();
        _mediaKeyHook = null;
        _hotkeyHook?.Dispose();
        _hotkeyHook = null;
        _mouseNavHook?.Dispose();
        _mouseNavHook = null;
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
        if (!IsMaximized)
        {
            if (_hwnd != IntPtr.Zero && NativeMethods.GetWindowRect(_hwnd, out var current))
            {
                _restoreRect = current;
                _hasRestoreRect = true;
            }
            WindowState = WindowState.Maximized;
            HostLog.Info("window.compositor maximize");
        }
        else
        {
            var target = _hasRestoreRect ? _restoreRect : RestoreRectInPixels(CurrentWindowRect());
            WindowState = WindowState.Normal;
            if (target.Right > target.Left && target.Bottom > target.Top)
            {
                TrySetWindowRect(target.Left, target.Top, target.Right - target.Left, target.Bottom - target.Top);
            }
            HostLog.Info("window.compositor restore");
        }
    }

    public void MinimizeFromPage()
    {
        CancelPendingDrag("minimize");

        WindowState = WindowState.Minimized;
        HostLog.Info("window.compositor minimize");
    }

    /// <summary>
    /// 页面标题栏的关闭按钮：隐藏到托盘（后台继续播放），不销毁窗口/WebView2。真正退出只有
    /// 托盘菜单「退出」和更新安装两条路径（都走 <see cref="ExitApplication"/>）。
    /// </summary>
    public void CloseFromPage()
    {
        CancelPendingDrag("close");

        if (_closePending || _isHiddenToTray) return;

        if (_isExiting)
        {
            Close();
            return;
        }

        _closePending = true;
        if (!NativeWindowAnim && _hwnd != IntPtr.Zero)
        {
            // AnimateWindow 淡出整个 HWND（包括 WebView2 子窗口），不截取屏幕，也不创建置顶浮层。
            // 若系统关闭了动画或调用失败，直接隐藏即可。
            NativeMethods.AnimateWindow(_hwnd, CloseAnimationMs,
                NativeMethods.AwBlend | NativeMethods.AwHide);
        }
        Dispatcher.BeginInvoke(new Action(HideToTray));
        HostLog.Info(NativeWindowAnim ? "window.native close -> tray" : "window.fade close -> tray");
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
        var (presetWidthDip, presetHeightDip) = (_settings?.MiniSize) switch
        {
            AppearanceSettings.MiniSizeCompact => (MiniCompactWidthDip, MiniCompactHeightDip),
            AppearanceSettings.MiniSizeWide => (MiniWideWidthDip, MiniWideHeightDip),
            _ => (MiniDefaultWidthDip, MiniDefaultHeightDip),
        };
        var widthDip = width > 0 ? Math.Clamp(width, MiniMinWidthDip, 1600) : presetWidthDip;
        var heightDip = height > 0 ? Math.Clamp(height, MiniMinHeightDip, 900) : presetHeightDip;
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
        Topmost = _settings?.MiniAlwaysOnTop ?? true;

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
        // 退出迷你态后恢复普通窗口的圆角（Win10 的窗口区域在迷你态被裁成 16 DIP，先清掉）。
        Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(ApplyWindowCornerRegion));
        HostLog.Info(
            $"window.miniMode disabled restored={(hasTarget ? DescribeRect(target) : "none")} state={_miniSavedWindowState}");
        _host?.NotifyMiniMode(false);
    }

    /// <summary>
    /// appearance.miniSize / miniAlwaysOnTop 没有独立事件；页面每次 settings patch 后由宿主调用。
    /// 当前处于迷你态时原地重排尺寸/置顶，不重走 Enter/Exit（P3-12）。
    /// </summary>
    internal void ApplyMiniSettingsIfActive()
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(ApplyMiniSettingsIfActive));
            return;
        }

        if (!_miniMode || _miniAnimating || _hwnd == IntPtr.Zero)
        {
            return;
        }

        var topmost = _settings?.MiniAlwaysOnTop ?? true;
        if (Topmost != topmost)
        {
            Topmost = topmost;
            HostLog.Info($"window.miniMode topmost={topmost}");
        }

        var (scaleX, scaleY) = CurrentDpiScale();
        var (widthDip, heightDip) = (_settings?.MiniSize) switch
        {
            AppearanceSettings.MiniSizeCompact => (MiniCompactWidthDip, MiniCompactHeightDip),
            AppearanceSettings.MiniSizeWide => (MiniWideWidthDip, MiniWideHeightDip),
            _ => (MiniDefaultWidthDip, MiniDefaultHeightDip),
        };
        if (!NativeMethods.GetWindowRect(_hwnd, out var current))
        {
            return;
        }

        var width = Math.Max(1, (int)Math.Round(widthDip * scaleX));
        var height = Math.Max(1, (int)Math.Round(heightDip * scaleY));
        if (current.Right - current.Left == width && current.Bottom - current.Top == height)
        {
            return;
        }

        var work = WorkAreaOf(current);
        var marginX = Math.Max(0, (int)Math.Round(MiniScreenMarginDip * scaleX));
        var marginY = Math.Max(0, (int)Math.Round(MiniScreenMarginDip * scaleY));
        var left = Math.Max(work.Left + marginX, work.Right - marginX - width);
        var top = Math.Max(work.Top + marginY, work.Bottom - marginY - height);
        if (!TrySetWindowRect(left, top, width, height))
        {
            ApplyRectInDip(left, top, width, height, scaleX, scaleY);
        }

        ApplyMiniWindowRegion(true);
        HostLog.Info($"window.miniMode resized size={width}x{height}");
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
        // 契约自测脚本用 WM_CLOSE 判定进程退出；测试模式跳过「关闭即隐藏到托盘」（P2-02）。
        if (Environment.GetEnvironmentVariable("ZILUX2_SELFTEST") == "1")
        {
            _isExiting = true;
            UnregisterHotkeys();
            Dispatcher.BeginInvoke(new Action(() => System.Windows.Application.Current?.Shutdown()), DispatcherPriority.Normal);
            return;
        }

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
        _closePending = false;
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

        _audio?.SetPaused(true);
        StopAirPlayStreaming("hide");
        // 隐藏期间把未结束的淡入停掉并复位不透明度，下次显示重新走「先透明、内容就绪再淡入」。
        BeginAnimation(Window.OpacityProperty, null);
        Opacity = 1;
        HiddenToTray?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>从托盘恢复主窗口：Show + 最小化则还原 + 激活。</summary>
    internal void ShowFromTray()
    {
        if (_isExiting)
        {
            return;
        }

        try
        {
            if (WindowState == WindowState.Minimized)
            {
                WindowState = WindowState.Normal;
            }

            // 恢复时先透明显示（WebView2 需要窗口已加载才能继续/重画），把表面顶一下再淡入，
            // 避免任务栏/托盘回来先看到一块空窗壳。
            BeginAnimation(Window.OpacityProperty, null);
            Opacity = 0;
            ShowInTaskbar = true;
            Show();
            // ShowInTaskbar 变化后 WPF 可能重建 HWND，这里重新取一次句柄再激活。
            var handle = new WindowInteropHelper(this).Handle;
            if (handle != IntPtr.Zero && handle != _hwnd)
            {
                _hwnd = handle;
                // 新 HWND 不继承 DWM 属性：圆角/无边框要重新声明一次。
                ApplyWindowCornerPreference();
                ApplyWindowCornerRegion();
            }
            else if (handle != IntPtr.Zero)
            {
                _hwnd = handle;
            }

            Activate();
            NativeMethods.ForceForeground(handle);

            _isHiddenToTray = false;
            _audio?.SetPaused(WindowState == WindowState.Minimized);
            Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(() =>
            {
                _host?.RefreshSurface();
                FadeWindowIn("tray");
            }));
            HostLog.Info("tray.show");
        }
        catch (Exception exception)
        {
            Opacity = 1;
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
            var handle = _hwnd != IntPtr.Zero ? _hwnd : new WindowInteropHelper(this).Handle;
            NativeMethods.ForceForeground(handle);

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
        if (action is not ("togglePlay" or "prev" or "next" or "volumeUp" or "volumeDown" or "mute" or "like"
            or "mode" or "mini" or "desktopLyrics" or "crossfade" or "stop" or "openSettings"
            or "navBack" or "navForward" or "appOutput"))
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
        StopAirPlayStreaming("exit");
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
        _activeShortcutBindings.Clear();
        _shortcutsEnabled = settings.Enabled;
        _alwaysHandleMediaKeys = settings.AlwaysHandleMediaKeys;

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
                    _activeShortcutBindings[spec.Action] = previous;
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
                    // 钩子按「用户配置的组合」兜底：被别的程序抢占（1409）或 WM_HOTKEY 被 UIPI
                    // 拦下时，注册可能失败、也可能只是换成了备用组合，用户按原组合也要能触发。
                    _activeShortcutBindings[spec.Action] = binding;
                }
                else
                {
                    item.Error = lastError > 0 ? $"error={lastError}" : "unavailable";
                    // 注册完全失败时更需要钩子：用户配置的组合由钩子直接接管。
                    _activeShortcutBindings[spec.Action] = binding;
                    HostLog.Warn($"hotkey.hook fallback action={spec.Action} key={binding.Key}");
                }
            }

            _shortcutItems.Add(item);
        }

        HostLog.Info(
            $"hotkey.apply enabled={(settings.Enabled ? "true" : "false")} count={registeredCount} reason={reason}");
        BuildShortcutStateJson();
        UpdateHotkeyHookBindings();
        PublishShortcutState();
        // 启动时钩子安装失败则在下一次设置变更/启动重试，最多 3 次（B21）。
        StartHotkeyHook();
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
        // MOD_NOREPEAT：按住不放时系统不再重复投递；快速连按仍然每次都来。
        if (NativeMethods.RegisterHotKey(_hwnd, id, binding.Modifiers | NativeMethods.ModNoRepeat, binding.VirtualKey))
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
        var spec = Array.Find(HotkeyCatalog.Actions, item => item.Id == id);
        if (spec is null)
        {
            HostLog.Warn($"hotkey.fire unknown id={id}");
            return;
        }

        FireHotkey(spec.Action, "registered");
    }

    /// <summary>
    /// 钩子与 WM_HOTKEY 双通路的去重：钩子命中后会吞键，但 Windows 可能仍投一条 WM_HOTKEY，
    /// 同一次物理按键会在两条通路上各来一次。
    ///
    /// 这里只做「跨通路」去重，窗口收紧到 250ms：同一通路上的快速连按必须立刻生效，
    /// 否则连按加减音量 / 连续切歌会被误吞（旧的 600ms 同动作去重就是这么丢按键的）。
    /// 按住不放的自动重复由钩子自己吞（未抬起不触发），RegisterHotKey 用 MOD_NOREPEAT 关掉。
    /// </summary>
    private void FireHotkey(string action, string source = "registered")
    {
        var now = Environment.TickCount;
        var mine = source == "hook" ? _lastHookFireTicks : _lastRegisteredFireTicks;
        var other = source == "hook" ? _lastRegisteredFireTicks : _lastHookFireTicks;
        if (other.TryGetValue(action, out var otherTick) && now - otherTick < 250)
        {
            HostLog.Info($"hotkey.fire skipped action={action} reason=cross-path-dedupe");
            return;
        }

        mine[action] = now;
        HostLog.Info($"hotkey.fire action={action} source={source}");
        DispatchHotkeyAction(action);
    }

    /// <summary>
    /// 系统媒体键接管：Windows 的媒体键常被别的程序用 RegisterHotKey 抢注（例如 QQ 音乐），
    /// 被抢注后本机 SMTC 永远收不到 ButtonPressed。底层键盘钩子仍能看到按键，所以这里把媒体键
    /// 吞下并走自家命令链。是否吞键由 shortcuts.alwaysHandleMediaKeys 决定：
    /// 默认 true——媒体键永远控制 Zilux2（键盘驱动把自定义键映射成媒体键时，切到别的窗口也生效）；
    /// false——只在「本机是当前媒体会话」时接管，其余情况放行，保留系统原生「媒体键跟着当前
    /// 播放器走」的行为。快捷键总开关关闭时也不接管。
    /// </summary>
    private void InstallMediaKeyHook()
    {
        if (_media is null || _mediaKeyHook is not null)
        {
            return;
        }

        _mediaKeyHook = new MediaKeyHookService(
            () => _shortcutsEnabled && (_alwaysHandleMediaKeys || _media.IsCurrentSession),
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

        // 补间节奏跟着合成帧走（CompositionTarget.Rendering 与显示器刷新同步）。
        // 之前用 15ms 的 DispatcherTimer，在 120Hz/165Hz 屏上每帧窗口位置要停 2~3 个屏幕帧、
        // 分布还不均匀，看起来就是「掉帧」；改成每合成帧推一次之后，窗口边缘每一步都落在刷新帧上。
        var frames = 0;
        var lastFrameTicks = 0L;

        void Finish()
        {
            var elapsed = Math.Max(1, Environment.TickCount64 - started);
            var avg = frames > 0 ? elapsed / (double)frames : 0;
            HostLog.Info($"window.motion ticks={frames} avgMs={avg:F1} durationMs={durationMs}");
            StopWindowMotion();
            completed?.Invoke();
        }

        void Frame()
        {
            if (generation != _windowAnimGeneration)
            {
                return;
            }

            var now = Environment.TickCount64;
            lastFrameTicks = now;
            var t = Math.Clamp((now - started) / (double)Math.Max(1, durationMs), 0, 1);
            var k = ease(t);
            var rect = BlendRect(from, to, k);
            frames++;
            NativeMethods.SetWindowPos(
                hwnd,
                IntPtr.Zero,
                rect.Left,
                rect.Top,
                Math.Max(1, rect.Right - rect.Left),
                Math.Max(1, rect.Bottom - rect.Top),
                NativeMethods.SwpNoZOrder | NativeMethods.SwpNoActivate);

            if (t >= 1)
            {
                Finish();
            }
        }

        EventHandler rendering = (_, _) => Frame();
        _windowAnimRendering = rendering;
        CompositionTarget.Rendering += rendering;

        // 合成帧偶发停顿（窗口被遮挡、DWM 降频）时兜底继续推进，避免动画卡在半路。
        var watchdog = new DispatcherTimer(DispatcherPriority.Render)
        {
            Interval = TimeSpan.FromMilliseconds(30),
        };
        _windowAnim = watchdog;
        watchdog.Tick += (_, _) =>
        {
            if (generation != _windowAnimGeneration)
            {
                watchdog.Stop();
                return;
            }

            if (Environment.TickCount64 - lastFrameTicks < 24)
            {
                return;
            }

            Frame();
        };
        watchdog.Start();
    }

    private void StopWindowMotion()
    {
        _windowAnimGeneration++;
        if (_windowAnimRendering is not null)
        {
            CompositionTarget.Rendering -= _windowAnimRendering;
            _windowAnimRendering = null;
        }

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
        if (_hwnd == IntPtr.Zero || _miniMode)
        {
            // 迷你态保持原来的行为：小窗是满窗卡片，不提供窗口边缘缩放。
            return;
        }

        var hitTest = edge switch
        {
            "left" => NativeMethods.HtLeft,
            "right" => NativeMethods.HtRight,
            "top" => NativeMethods.HtTop,
            "bottom" => NativeMethods.HtBottom,
            "topleft" => NativeMethods.HtTopLeft,
            "topright" => NativeMethods.HtTopRight,
            "bottomleft" => NativeMethods.HtBottomLeft,
            "bottomright" => NativeMethods.HtBottomRight,
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

        // 落点用物理屏幕坐标一起交给系统缩放循环，避免高 DPI/跨屏时按逻辑像素换算偏移。
        // 页面没有传坐标，这里取当前光标（消息延迟最多一帧，肉眼不可见）。
        NativeMethods.GetCursorPos(out var origin);
        NativeMethods.BeginWindowResize(_hwnd, hitTest, origin.X, origin.Y);
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

            if (IsMaximized)
            {
                // 最大化状态下拖窗：先还原成上一次的尺寸，再按指针在窗口里的相对位置摆好，
                // 然后交给系统 move loop，行为与原生标题栏一致。
                RestoreForDrag(origin.X, origin.Y);
            }

            NativeMethods.BeginWindowDrag(_hwnd, origin.X, origin.Y);
        }
        catch (Exception exception)
        {
            _dragPending = false;
            HostLog.Error("window.drag failed", exception);
        }
    }

    /// <summary>
    /// 拖动已最大化窗口时先还原：把窗口按指针在最大化矩形中的相对位置缩放回
    /// RestoreBounds，这样系统 move loop 的抓取偏移仍落在指针下方，不会从左上角跳一下。
    /// </summary>
    private void RestoreForDrag(int screenX, int screenY)
    {
        try
        {
            var maximized = CurrentWindowRect();
            // 自定义最大化走的是动画 + WindowState，RestoreBounds 会等于最大化矩形；
            // 因此优先用 ToggleMaximize 记下的 _restoreRect（最大化前的像素矩形）。
            var restore = _hasRestoreRect ? _restoreRect : RestoreRectInPixels(maximized);
            var width = Math.Max(1, maximized.Right - maximized.Left);
            var height = Math.Max(1, maximized.Bottom - maximized.Top);
            var ratioX = Math.Clamp((screenX - maximized.Left) / (double)width, 0, 1);
            var ratioY = Math.Clamp((screenY - maximized.Top) / (double)height, 0, 1);
            var restoreWidth = Math.Max(1, restore.Right - restore.Left);
            var restoreHeight = Math.Max(1, restore.Bottom - restore.Top);
            var left = (int)Math.Round(screenX - restoreWidth * ratioX);
            var top = (int)Math.Round(screenY - restoreHeight * ratioY);

            // WindowState 必须先回 Normal：最大化窗口的 SetWindowPos 会被系统按最大化处理。
            WindowState = WindowState.Normal;
            TrySetWindowRect(left, top, restoreWidth, restoreHeight);
            HostLog.Info(
                $"window.drag restore from maximized at {left},{top} {restoreWidth}x{restoreHeight}");
        }
        catch (InvalidOperationException)
        {
            // RestoreBounds 在窗口尚未显示时不可用，退回普通还原。
            WindowState = WindowState.Normal;
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
            // 错误面板本身就是可显示的内容了：不再等页面首帧，立刻揭示窗口。
            RevealWindow("error");
        }));
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == NativeMethods.WmGetMinMaxInfo)
        {
            ApplyWindowLimits(hwnd, lParam);
            handled = true;
        }
        else if (msg == NativeMethods.WmSize && !IsWindows11)
        {
            // Win10 用 SetWindowRgn 做圆角：区域不会跟着窗口尺寸走，实时缩放/最大化切换必须
            // 按新尺寸重算，否则内容会被裁在旧尺寸里。Win11 交给 DWM，无需处理。
            ApplyWindowCornerRegion();
        }
        else if (msg == NativeMethods.WmExitSizeMove)
        {
            // 不能在 WM_MOVING 里改写 proposed rect（旧实现）：拖过不同 DPI 的显示器时 WPF
            // 的 DpiScale 仍是旧屏幕的值，钳制会把窗口推回原屏幕，表现为「拖不过去/卡住」。
            // 系统 move loop 自己保证标题栏可见，落点后再统一钳制一次。
            ClampWindowToWorkArea();
            ApplyWindowCornerRegion();
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
        else if (_taskbarCreatedMessage != 0 && msg == (int)_taskbarCreatedMessage)
        {
            Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(OnShellRestarted));
        }
        else if (msg == NativeMethods.WmDisplayChange || msg == NativeMethods.WmDpiChanged)
        {
            // WM_DISPLAYCHANGE / WM_DPICHANGED：分辨率、布局或缩放变了，重新铺满新的虚拟桌面
            // （B15），并按新 DPI 重算窗口圆角（Win10 的 SetWindowRgn 尺寸是物理像素）。
            if (msg == NativeMethods.WmDpiChanged)
            {
                HostLog.Info($"window.dpiChanged dpi={NativeMethods.GetDpiForWindow(hwnd)}");
            }

            Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() =>
            {
                _backgroundLyricsWindow?.RepositionToDesktop();
                ApplyWindowCornerRegion();
            }));
        }

        return IntPtr.Zero;
    }

    /// <summary>
    /// 部分键盘驱动 / OEM 热键服务按下「系统切换音乐」键时不发 VK_MEDIA_* 按键，而是往
    /// 前台窗口投一条 WM_APPCOMMAND 消息；底层键盘钩子看不到这条路径，只能在这里兜接。
    /// 快捷键总开关打开、且（alwaysHandleMediaKeys=true 或本机是当前媒体会话）时接住，
    /// 其余情况返回 false 交给系统默认处理，保留「媒体键跟着当前播放器走」的原生行为。
    /// </summary>
    private bool HandleAppCommand(IntPtr lParam)
    {
        var command = (int)((lParam.ToInt64() >> 16) & 0x0FFF);
        var action = command switch
        {
            NativeMethods.AppCommandMediaNextTrack => "next",
            NativeMethods.AppCommandMediaPrevTrack => "prev",
            NativeMethods.AppCommandMediaStop => "stop",
            NativeMethods.AppCommandMediaPlayPause => "togglePlay",
            _ => null,
        };
        if (action is null)
        {
            return false;
        }

        var owns = _media?.IsCurrentSession == true;
        var handle = _alwaysHandleMediaKeys || owns;
        HostLog.Info(
            $"[appcommand] command={command} action={action} ours={(owns ? "true" : "false")} always={(_alwaysHandleMediaKeys ? "true" : "false")}");
        if (!_shortcutsEnabled || !handle)
        {
            return false;
        }

        HostLog.Info($"[appcommand] fire action={action}");
        // 与钩子/WM_HOTKEY 共用去重：同一次物理按键可能同时走多条通路（B22）。
        FireHotkey(action);
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
        // 优先取宿主窗口的物理 DPI：跨屏拖动/DPI 切换的瞬间 WPF 的视觉树 DPI 会滞后一帧，
        // 用旧值换算窗口最小尺寸、边缘阈值会在新屏幕上产生偏移。GetDpiForWindow 是即时的。
        if (_hwnd != IntPtr.Zero)
        {
            var dpi = NativeMethods.GetDpiForWindow(_hwnd);
            if (dpi >= 48)
            {
                var scale = dpi / 96.0;
                return (scale, scale);
            }
        }

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
