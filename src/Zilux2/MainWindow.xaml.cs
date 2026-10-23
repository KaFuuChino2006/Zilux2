using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Zilux2.AirPlay;
using Zilux2.Audio;
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
        InitializeComponent();
        SourceInitialized += OnSourceInitialized;
        Loaded += OnLoaded;
        StateChanged += OnStateChanged;
        Closed += OnClosed;
    }

    public bool IsMaximized => WindowState == WindowState.Maximized;

    // The SMTC session is window scoped, so the host needs the native handle once it is created.
    internal IntPtr Handle => _hwnd;

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        _hwnd = new WindowInteropHelper(this).Handle;
        HwndSource.FromHwnd(_hwnd)?.AddHook(WndProc);
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
        App.ArmShutdownWatchdog();
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

    public void CloseFromPage()
    {
        CancelPendingDrag("close");

        if (_hwnd == IntPtr.Zero || !NativeMethods.GetWindowRect(_hwnd, out var current))
        {
            // Close from a dispatcher turn: never tear the WebView2 control down inside its own callback.
            Dispatcher.BeginInvoke(new Action(Close));
            return;
        }

        if (NativeWindowAnim)
        {
            HostLog.Info("window.native close");
            Close();
            return;
        }

        if (!PlaySnapshotTransition(current, minimize: false))
        {
            Dispatcher.BeginInvoke(new Action(Close));
        }

        HostLog.Info("window.animate close (snapshot)");
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

        return IntPtr.Zero;
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
