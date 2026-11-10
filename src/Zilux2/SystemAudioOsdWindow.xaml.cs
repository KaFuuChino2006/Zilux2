using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Threading;
using Zilux2.Audio;
using Zilux2.Interop;

namespace Zilux2;

/// <summary>
/// 系统默认播放设备切换时，屏幕右上角的轻量 OSD。
///
/// 独立 Topmost + 不抢焦点 + 鼠标穿透；主窗口最小化到托盘时也能出现。
/// 动画顺序：当前设备 → 箭头指向下一台 → 下一台落定。
/// 真正切换在宿主侧已经完成，这里只负责把这次切换讲清楚。
/// </summary>
public partial class SystemAudioOsdWindow : Window
{
    private const int GwlExStyle = -20;
    private const int WsExTransparent = 0x20;
    private const int WsExNoActivate = 0x08000000;
    private const int WsExToolWindow = 0x00000080;

    private const int ShowMs = 2800;
    private const int DismissMs = 220;

    private DispatcherTimer? _phaseTimer;
    private DispatcherTimer? _dismissTimer;
    private long _generation;
    private bool _hiding;

    public SystemAudioOsdWindow()
    {
        InitializeComponent();
        SourceInitialized += (_, _) => ApplyClickThrough();
        Closed += (_, _) => StopTimers();
    }

    /// <summary>显示一次切换。from 为 null 时只展示目标设备。</summary>
    internal void ShowTransition(SystemAudioOutputDevice? from, SystemAudioOutputDevice to)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => ShowTransition(from, to)));
            return;
        }

        if (to is null || string.IsNullOrWhiteSpace(to.Name))
        {
            return;
        }

        if (from is not null && string.Equals(from.Id, to.Id, StringComparison.Ordinal))
        {
            return;
        }

        var wasVisible = IsVisible && !_hiding && Shell.Opacity > 0.01;
        _generation++;
        var generation = _generation;
        StopTimers();
        _hiding = false;
        PositionAtTopRight();

        if (wasVisible)
        {
            TransitionInPlace(from, to, generation);
            return;
        }

        if (!IsVisible)
        {
            Show();
        }

        ResetAnimations();

        FromName.Text = DisplayName(from?.Name);
        ToName.Text = DisplayName(to.Name);
        StatusText.Text = "正在切换";
        FromCaption.Text = "当前播放";
        ToCaption.Text = "切换到";
        ToStack.Opacity = 0.35;
        ToShift.X = 8;
        FromStack.Opacity = 1;
        FromShift.X = -4;
        ArrowHead.Opacity = 0;
        ProgressFill.Width = 0;

        var easeOut = new CubicEase { EasingMode = EasingMode.EaseOut };
        var easeInOut = new CubicEase { EasingMode = EasingMode.EaseInOut };

        Shell.BeginAnimation(OpacityProperty,
            new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(170)) { EasingFunction = easeOut });
        ShellShift.BeginAnimation(TranslateTransform.YProperty,
            new DoubleAnimation(-12, 0, TimeSpan.FromMilliseconds(230)) { EasingFunction = easeOut });
        FromShift.BeginAnimation(TranslateTransform.XProperty,
            new DoubleAnimation(-4, 0, TimeSpan.FromMilliseconds(260)) { EasingFunction = easeOut });

        // 箭头先画出来：横线生长，实心箭头随后出现；没有额外光点。
        ArrowLine.BeginAnimation(Line.X2Property,
            new DoubleAnimation(1, 21, TimeSpan.FromMilliseconds(320))
            {
                BeginTime = TimeSpan.FromMilliseconds(130),
                EasingFunction = easeInOut,
            });
        ArrowHead.BeginAnimation(OpacityProperty,
            new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(150))
            {
                BeginTime = TimeSpan.FromMilliseconds(330),
            });
        var progressWidth = Math.Max(1, (Shell.ActualWidth > 0 ? Shell.ActualWidth : Width) - 28);
        ProgressFill.BeginAnimation(WidthProperty,
            new DoubleAnimation(0, progressWidth, TimeSpan.FromMilliseconds(2500)) { EasingFunction = easeOut });

        StartTimers(generation, easeOut);
    }

    /// <summary>
    /// OSD 已经显示在屏幕上时，第二次切换不再重放入场/弹窗动画，
    /// 只让现有左右两组文字交叉淡出再淡入，箭头和卡片保持原位。
    /// </summary>
    private void TransitionInPlace(SystemAudioOutputDevice? from, SystemAudioOutputDevice to, long generation)
    {
        var easeOut = new CubicEase { EasingMode = EasingMode.EaseOut };

        FromStack.BeginAnimation(OpacityProperty, null);
        ToStack.BeginAnimation(OpacityProperty, null);

        FromName.Text = DisplayName(from?.Name);
        ToName.Text = DisplayName(to.Name);
        StatusText.Text = "正在切换";
        FromCaption.Text = "当前播放";
        ToCaption.Text = "切换到";
        FromShift.X = 0;
        ToShift.X = 8;
        FromStack.Opacity = 0;
        ToStack.Opacity = 0.35;

        // 只做一次快速淡入；没有额外的弹窗/上移/宽度重排。
        FromStack.BeginAnimation(OpacityProperty,
            new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(160))
            {
                EasingFunction = easeOut,
            });

        // 不重画整条箭头，只让箭头本身轻微亮一下，并重启进度和停留计时。
        ArrowHead.BeginAnimation(OpacityProperty, null);
        ArrowHead.Opacity = 0.45;
        ArrowHead.BeginAnimation(OpacityProperty,
            new DoubleAnimation(0.45, 1, TimeSpan.FromMilliseconds(240))
            {
                EasingFunction = easeOut,
            });

        var progressWidth = Math.Max(1, (Shell.ActualWidth > 0 ? Shell.ActualWidth : Width) - 28);
        ProgressFill.BeginAnimation(WidthProperty, null);
        ProgressFill.Width = 0;
        ProgressFill.BeginAnimation(WidthProperty,
            new DoubleAnimation(0, progressWidth, TimeSpan.FromMilliseconds(2500))
            {
                EasingFunction = easeOut,
            });

        StartTimers(generation, easeOut);
    }

    private void StartTimers(long generation, IEasingFunction easeOut)
    {
        _phaseTimer = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(650),
        };
        _phaseTimer.Tick += (_, _) =>
        {
            _phaseTimer?.Stop();
            if (generation != _generation)
            {
                return;
            }

            StatusText.Text = "已切换";
            FromCaption.Text = "上一台";
            ToCaption.Text = "正在使用";
            FromStack.BeginAnimation(OpacityProperty,
                new DoubleAnimation(FromStack.Opacity, 0.58, TimeSpan.FromMilliseconds(220))
                {
                    EasingFunction = easeOut,
                });
            ToStack.BeginAnimation(OpacityProperty,
                new DoubleAnimation(0.35, 1, TimeSpan.FromMilliseconds(250))
                {
                    EasingFunction = easeOut,
                });
            ToShift.BeginAnimation(TranslateTransform.XProperty,
                new DoubleAnimation(10, 0, TimeSpan.FromMilliseconds(300))
                {
                    EasingFunction = easeOut,
                });
        };
        _phaseTimer.Start();

        _dismissTimer = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(ShowMs),
        };
        _dismissTimer.Tick += (_, _) =>
        {
            _dismissTimer?.Stop();
            if (generation == _generation)
            {
                Dismiss();
            }
        };
        _dismissTimer.Start();
    }

    private void Dismiss()
    {
        if (_hiding)
        {
            return;
        }

        _hiding = true;
        var generation = _generation;
        var fade = new DoubleAnimation(Shell.Opacity, 0, TimeSpan.FromMilliseconds(DismissMs))
        {
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseIn },
        };
        fade.Completed += (_, _) =>
        {
            if (generation == _generation)
            {
                Hide();
            }
        };
        Shell.BeginAnimation(OpacityProperty, fade);
        ShellShift.BeginAnimation(TranslateTransform.YProperty,
            new DoubleAnimation(0, -8, TimeSpan.FromMilliseconds(DismissMs)));
    }

    private void ResetAnimations()
    {
        Shell.BeginAnimation(OpacityProperty, null);
        ShellShift.BeginAnimation(TranslateTransform.YProperty, null);
        FromStack.BeginAnimation(OpacityProperty, null);
        FromShift.BeginAnimation(TranslateTransform.XProperty, null);
        ToStack.BeginAnimation(OpacityProperty, null);
        ToShift.BeginAnimation(TranslateTransform.XProperty, null);
        ArrowLine.BeginAnimation(Line.X2Property, null);
        ArrowHead.BeginAnimation(OpacityProperty, null);
        ProgressFill.BeginAnimation(WidthProperty, null);
        Shell.Opacity = 1;
        ShellShift.Y = 0;
        FromStack.Opacity = 1;
        ToStack.Opacity = 0;
    }

    private void StopTimers()
    {
        if (_phaseTimer is not null)
        {
            _phaseTimer.Stop();
            _phaseTimer = null;
        }

        if (_dismissTimer is not null)
        {
            _dismissTimer.Stop();
            _dismissTimer = null;
        }
    }

    private static string DisplayName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return "未检测到播放设备";
        }

        // “扬声器 (Realtek(R) Audio)”这类设备名尾部的驱动商后缀两列都放不下，
        // OSD 只保留前面的设备名；完整名称仍由系统音频设置页显示。
        var cut = name.IndexOf(" (", StringComparison.Ordinal);
        return cut > 0 ? name[..cut] : name;
    }

    private void PositionAtTopRight()
    {
        var area = SystemParameters.WorkArea;
        Left = area.Right - Width - 14;
        Top = area.Top + 14;
    }

    private void ApplyClickThrough()
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero)
        {
            return;
        }

        var style = NativeMethods.GetWindowLong(hwnd, GwlExStyle);
        NativeMethods.SetWindowLong(hwnd, GwlExStyle,
            style | WsExTransparent | WsExNoActivate | WsExToolWindow);
    }
}
