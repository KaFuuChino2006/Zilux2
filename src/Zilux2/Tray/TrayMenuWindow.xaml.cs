using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using Zilux2.Interop;

namespace Zilux2.Tray;

/// <summary>
/// 托盘右键菜单（2026-11-24 重做）：不再用 WinForms 的 <c>ContextMenuStrip</c>（系统灰菜单，
/// 和软件完全不是一套观感），改成一张自绘的奶油色卡片 —— 圆角 16、金色点缀、细线图标，
/// 和系统音频 OSD 同一材质族。
///
/// 行为约定：
/// <list type="bullet">
/// <item>贴托盘弹出：右下角对齐鼠标指针，向上展开；上方放不下就翻到下方，再夹进显示器工作区。</item>
/// <item>失焦 / Esc 关闭；上/下键移动高亮，回车触发；点空白处不关闭（和系统菜单一致）。</item>
/// <item>动画三件套：入场（淡入 + 上移 + 微缩放）、出场（反向，更短）、打断（再打开时先停在当前值再往目标走）。</item>
/// </list>
///
/// 窗口只在第一次右键时创建，之后 Hide/Show 复用，避免每次弹菜单都新建一个 HWND。
/// </summary>
internal partial class TrayMenuWindow : Window
{
    private const int GwlExStyle = -20;
    private const int WsExToolWindow = 0x00000080;
    private const uint MonitorDefaultToNearest = 2;

    /// <summary>菜单右边缘贴着指针，留一点余量，别让阴影压到托盘图标上。</summary>
    private const double CursorGap = 10;

    /// <summary>离显示器工作区边缘的最小距离。</summary>
    private const double ScreenMargin = 8;

    private static readonly Duration InFade = new(TimeSpan.FromMilliseconds(160));
    private static readonly Duration InMove = new(TimeSpan.FromMilliseconds(220));
    private static readonly Duration OutFade = new(TimeSpan.FromMilliseconds(130));
    private static readonly Duration OutMove = new(TimeSpan.FromMilliseconds(150));

    private readonly List<Button> _rows = new();
    private int _focusIndex = -1;
    private bool _closing;

    /// <summary>Show 之后到真正激活之间会掉一下焦点，这段时间的 Deactivated 不算「用户点走了」。</summary>
    private bool _waitingForActivation;
    private int _animationToken;

    internal TrayMenuWindow()
    {
        InitializeComponent();
        _rows.AddRange(new[]
        {
            ShowRow, PlayRow, PrevRow, NextRow,
            PauseWallpaperRow, NextWallpaperRow,
            UnlockLyricsRow, SettingsRow, ExitRow,
        });
        PreviewKeyDown += OnPreviewKeyDown;
        Deactivated += OnDeactivated;
        Activated += (_, _) => _waitingForActivation = false;
    }

    /// <summary>「显示主窗口 / 恢复」点了以后做什么，由 <see cref="TrayIconService"/> 注入。</summary>
    internal Action? ShowMainRequested { get; set; }

    internal Action? TogglePlayRequested { get; set; }

    internal Action? PreviousRequested { get; set; }

    internal Action? NextRequested { get; set; }

    internal Action? ToggleWallpaperPauseRequested { get; set; }

    internal Action? NextWallpaperRequested { get; set; }

    internal Action? UnlockLyricsRequested { get; set; }

    internal Action? OpenSettingsRequested { get; set; }

    internal Action? ExitRequested { get; set; }

    /// <summary>主窗口是否在托盘里（只影响品牌头右侧那行小字，不参与布局）。</summary>
    internal void SyncShellVisibility(bool hiddenToTray)
    {
        HeaderHint.Text = hiddenToTray ? "后台运行" : "窗口已打开";
    }

    internal void SyncPlayback(bool playing)
    {
        PlayLabel.Text = playing ? "暂停" : "播放";
        PlayGlyph.Visibility = playing ? Visibility.Collapsed : Visibility.Visible;
        PauseGlyph.Visibility = playing ? Visibility.Visible : Visibility.Collapsed;
    }

    internal void SyncWallpaper(string title, bool paused, bool running)
    {
        WallpaperText.Text = running ? $"壁纸：{title}" : $"壁纸：{title}（未运行）";
        PauseWallpaperLabel.Text = paused ? "继续壁纸" : "暂停壁纸";
        WallpaperPauseGlyph.Data = paused
            ? Geometry.Parse("M4.4,3.1 L11.4,7 L4.4,10.9 Z")
            : Geometry.Parse("M4.2,3.4 H6.2 V10.6 H4.2 Z M7.8,3.4 H9.8 V10.6 H7.8 Z");
        PauseWallpaperRow.IsEnabled = running;
        PauseWallpaperRow.Opacity = running ? 1 : 0.42;
    }

    /// <summary>在鼠标指针处弹出（托盘图标上方）。已经打开时再次右键 = 收起。</summary>
    internal void ToggleAtCursor()
    {
        if (IsVisible && !_closing)
        {
            BeginClose();
            return;
        }

        Open();
    }

    private void Open()
    {
        // 先建 HWND 才能拿到这块屏幕的 DPI；PerMonitorV2 下不同显示器缩放不同。
        var handle = new WindowInteropHelper(this).EnsureHandle();
        var scale = NativeMethods.GetDpiForWindow(handle) / 96.0;
        if (scale <= 0)
        {
            scale = 1;
        }

        // 尺寸：宽度固定，高度按卡片内容量一次。窗口自己在 Show 之前 Measure 拿不到完整高度
        // （会量成半截，把下半张菜单裁掉），所以直接量 Card，再补回 18px 的阴影透明边。
        Card.Measure(new Size(Width - 36, double.PositiveInfinity));
        var height = Card.DesiredSize.Height + 36;
        if (double.IsNaN(height) || height < 120)
        {
            height = 420;
        }

        Height = height;

        var (left, top) = PlaceAtCursor(height, scale);
        Left = left;
        Top = top;

        // 出场没走完又右键（打断）：保留当前动画值，从“现在这个样子”往入场目标走；
        // 真正隐藏态才回到起点（淡入 + 上移 + 微缩放）。
        var interrupting = _closing;
        _closing = false;
        _waitingForActivation = true;
        _focusIndex = -1;
        Show();

        // Show 之后布局才真正跑完，以卡片实际高度校正一次：底部那行提示不会被裁掉。
        UpdateLayout();
        var wanted = Card.ActualHeight + 36;
        if (wanted > Height + 0.5)
        {
            Height = wanted;
            UpdateLayout();
            var (againLeft, againTop) = PlaceAtCursor(wanted, scale);
            Left = againLeft;
            Top = againTop;
        }

        // 右键托盘时前台通常是资源管理器，直接 Activate 会被前台锁吃掉；
        // 走 NativeMethods.ForceForeground（附到前台线程输入队列），菜单才拿得到焦点，
        // 也才能靠失焦自动收起。
        NativeMethods.ForceForeground(new WindowInteropHelper(this).Handle);
        Focus();
        BeginEntrance(fromHidden: !interrupting);
    }

    private (double Left, double Top) PlaceAtCursor(double height, double scale)
    {
        NativeMethods.GetCursorPos(out var cursor);
        var anchor = new NativeMethods.Rect
        {
            Left = cursor.X,
            Top = cursor.Y,
            Right = cursor.X + 1,
            Bottom = cursor.Y + 1,
        };

        var work = SystemParameters.WorkArea;
        var monitor = NativeMethods.MonitorFromRect(ref anchor, MonitorDefaultToNearest);
        if (monitor != IntPtr.Zero)
        {
            var info = new NativeMethods.MonitorInfo { Size = System.Runtime.InteropServices.Marshal.SizeOf<NativeMethods.MonitorInfo>() };
            if (NativeMethods.GetMonitorInfo(monitor, ref info))
            {
                work = new Rect(
                    info.Work.Left / scale,
                    info.Work.Top / scale,
                    (info.Work.Right - info.Work.Left) / scale,
                    (info.Work.Bottom - info.Work.Top) / scale);
            }
        }

        var pointerX = cursor.X / scale;
        var pointerY = cursor.Y / scale;

        // 右边缘对齐指针（托盘在右下角），整体在指针上方展开。
        var left = pointerX - Width;
        var top = pointerY - height - CursorGap;

        if (top < work.Top + ScreenMargin)
        {
            top = pointerY + CursorGap; // 上方放不下（例如指针在屏幕上半区）就翻到下方
        }

        left = Math.Clamp(left, work.Left + ScreenMargin, work.Right - ScreenMargin - Width);
        top = Math.Clamp(top, work.Top + ScreenMargin, work.Bottom - ScreenMargin - height);
        return (left, top);
    }

    /// <summary>
    /// 入场：淡入 + 从下方 10px 上移 + 0.97→1。打断时（出场没走完又右键）不清零，
    /// 从当前值继续往目标走，动画不会「跳回起点」。
    /// </summary>
    private void BeginEntrance(bool fromHidden)
    {
        _animationToken++;
        _closing = false;

        if (fromHidden)
        {
            TransformRoot.BeginAnimation(OpacityProperty, null);
            CardShift.BeginAnimation(TranslateTransform.YProperty, null);
            CardScale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
            CardScale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
            TransformRoot.Opacity = 0;
            CardShift.Y = 10;
            CardScale.ScaleX = 0.97;
            CardScale.ScaleY = 0.97;
        }

        var easeOut = new CubicEase { EasingMode = EasingMode.EaseOut };

        TransformRoot.BeginAnimation(
            OpacityProperty,
            new DoubleAnimation(1, InFade) { EasingFunction = easeOut },
            HandoffBehavior.SnapshotAndReplace);
        CardShift.BeginAnimation(
            TranslateTransform.YProperty,
            new DoubleAnimation(0, InMove) { EasingFunction = easeOut },
            HandoffBehavior.SnapshotAndReplace);
        var zoom = new DoubleAnimation(1, InMove) { EasingFunction = easeOut };
        CardScale.BeginAnimation(ScaleTransform.ScaleXProperty, zoom, HandoffBehavior.SnapshotAndReplace);
        CardScale.BeginAnimation(ScaleTransform.ScaleYProperty, zoom, HandoffBehavior.SnapshotAndReplace);
    }

    private void BeginClose()
    {
        if (!IsVisible || _closing)
        {
            return;
        }

        _closing = true;
        var token = ++_animationToken;
        var easeIn = new CubicEase { EasingMode = EasingMode.EaseIn };

        var fade = new DoubleAnimation(0, OutFade) { EasingFunction = easeIn };
        fade.Completed += (_, _) =>
        {
            if (token != _animationToken)
            {
                return; // 已经被下一次打开打断，别把窗口藏掉
            }

            _closing = false;
            Hide();
        };

        TransformRoot.BeginAnimation(OpacityProperty, fade, HandoffBehavior.SnapshotAndReplace);
        CardShift.BeginAnimation(
            TranslateTransform.YProperty,
            new DoubleAnimation(6, OutMove) { EasingFunction = easeIn },
            HandoffBehavior.SnapshotAndReplace);
        var zoom = new DoubleAnimation(0.97, OutMove) { EasingFunction = easeIn };
        CardScale.BeginAnimation(ScaleTransform.ScaleXProperty, zoom, HandoffBehavior.SnapshotAndReplace);
        CardScale.BeginAnimation(ScaleTransform.ScaleYProperty, zoom, HandoffBehavior.SnapshotAndReplace);
    }

    private void OnDeactivated(object? sender, EventArgs e)
    {
        if (_waitingForActivation)
        {
            return;
        }

        if (IsVisible)
        {
            BeginClose();
        }
    }

    private void OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        switch (e.Key)
        {
            case Key.Escape:
                BeginClose();
                e.Handled = true;
                break;
            case Key.Down:
                MoveFocus(1);
                e.Handled = true;
                break;
            case Key.Up:
                MoveFocus(-1);
                e.Handled = true;
                break;
            case Key.Enter:
                if (_focusIndex >= 0 && _focusIndex < _rows.Count && _rows[_focusIndex].IsEnabled)
                {
                    _rows[_focusIndex].RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent));
                    e.Handled = true;
                }

                break;
        }
    }

    private void MoveFocus(int delta)
    {
        if (_rows.Count == 0)
        {
            return;
        }

        var index = _focusIndex;
        for (var step = 0; step < _rows.Count; step++)
        {
            index = (index + delta + _rows.Count) % _rows.Count;
            if (_rows[index].IsEnabled && _rows[index].Visibility == Visibility.Visible)
            {
                _focusIndex = index;
                _rows[index].Focus();
                return;
            }
        }
    }

    private void Invoke(Action? action)
    {
        BeginClose();
        if (action is null)
        {
            return;
        }

        // 让关闭动画先起一帧，再切窗口/执行命令，画面不会在菜单还挂着的时候被抽走。
        Dispatcher.BeginInvoke(new Action(() =>
        {
            try
            {
                action();
            }
            catch (Exception exception)
            {
                HostLog.Warn($"tray.menu action failed: {exception.GetType().Name}: {exception.Message}");
            }
        }), DispatcherPriority.Background);
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);

        // 工具窗口：不占 Alt+Tab、不参与窗口切换（ShowInTaskbar=False 只管任务栏）。
        var handle = new WindowInteropHelper(this).Handle;
        var style = NativeMethods.GetWindowLong(handle, GwlExStyle);
        NativeMethods.SetWindowLong(handle, GwlExStyle, style | WsExToolWindow);
    }

    // —— 菜单项 ——

    private void OnShowMain(object sender, RoutedEventArgs e) => Invoke(ShowMainRequested);

    private void OnTogglePlay(object sender, RoutedEventArgs e) => Invoke(TogglePlayRequested);

    private void OnPrevious(object sender, RoutedEventArgs e) => Invoke(PreviousRequested);

    private void OnNext(object sender, RoutedEventArgs e) => Invoke(NextRequested);

    private void OnToggleWallpaperPause(object sender, RoutedEventArgs e) => Invoke(ToggleWallpaperPauseRequested);

    private void OnNextWallpaper(object sender, RoutedEventArgs e) => Invoke(NextWallpaperRequested);

    private void OnUnlockLyrics(object sender, RoutedEventArgs e) => Invoke(UnlockLyricsRequested);

    private void OnOpenSettings(object sender, RoutedEventArgs e) => Invoke(OpenSettingsRequested);

    private void OnExit(object sender, RoutedEventArgs e) => Invoke(ExitRequested);
}
