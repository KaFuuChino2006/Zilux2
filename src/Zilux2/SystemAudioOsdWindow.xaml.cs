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
    // 收起：连续收窄至零，同时淡出。
    private const int ShrinkMs = 380;

    // 弹出：收起态一颗小胶囊，展开成整张卡片。曲线和播放条一致（.22,1.28,.36,1 的过冲手感）。
    private const double CollapsedWidth = 188;
    // 展开宽 = 内容实测宽 + 内边距，随设备名长短自适应；上下限防止撑破屏幕。
    private const double MinExpandedWidth = 300;
    private const double MaxExpandedWidth = 900;
    private const double CollapsedHeight = 46;
    private const double ExpandedHeight = 46;
    private const int PopMs = 620;

    // 再短的胶囊也有「弹出来」：一律从一颗小胶囊长到目标宽度。
    private const double PopFromWidth = CollapsedHeight;

    // 收起时的落点：宽度收到和高度一样，就是一颗圆球（圆角恒为 23）。
    private const double RetractWidth = CollapsedHeight;
    private static readonly KeySpline PopWidthSpline = new(0.22, 1.28, 0.36, 1);
    private static readonly KeySpline PopHeightSpline = new(0.22, 1.06, 0.36, 1);

    private const string SpeakerGlyph =
        "M2,4.2 L4.6,4.2 L8.4,1.6 L8.4,10.4 L4.6,7.8 L2,7.8 Z M10.2,4.1 A3.4,3.4 0 0 1 10.2,7.9";
    private const string HeadphoneGlyph =
        "M2.2,8.1 L2.2,6.3 A3.8,3.8 0 0 1 9.8,6.3 L9.8,8.1 M1.1,7.4 H3.3 V10.6 H1.1 Z M8.7,7.4 H10.9 V10.6 H8.7 Z";
    private const string TvGlyph =
        "M1.6,2.6 H10.4 V8.2 H1.6 Z M4.2,10.6 H7.8";
    private const string UsbGlyph =
        "M6,1.4 V10.6 M4.2,3.2 H7.8 M3,10.6 H9 M3,10.6 V8.6 M9,10.6 V8.6";

    /// <summary>
    /// 按设备名猜一个类型图标：耳机/蓝牙、电视/HDMI、USB/DAC，其余一律扬声器。
    /// 只做观感提示，判错也不影响切换本身。
    /// </summary>
    private static string GlyphFor(string? name)
    {
        var value = (name ?? string.Empty).ToLowerInvariant();
        if (value.Contains("headphone") || value.Contains("headset") || value.Contains("earphone") ||
            value.Contains("耳机") || value.Contains("蓝牙") || value.Contains("bluetooth") ||
            value.Contains("airpod") || value.Contains("buds"))
        {
            return HeadphoneGlyph;
        }

        if (value.Contains("hdmi") || value.Contains(" tv") || value.Contains("电视") ||
            value.Contains("display") || value.Contains("显示器") || value.Contains("monitor"))
        {
            return TvGlyph;
        }

        if (value.Contains("usb") || value.Contains("dac") || value.Contains("声卡"))
        {
            return UsbGlyph;
        }

        return SpeakerGlyph;
    }

    private DispatcherTimer? _phaseTimer;
    private DispatcherTimer? _dismissTimer;
    private double _expandedWidth = 452;
    private bool _volumeMode;
    private bool _trackMode;
    private long _generation;
    private bool _hiding;

    public SystemAudioOsdWindow()
    {
        InitializeComponent();
        SourceInitialized += (_, _) => ApplyClickThrough();
        Closed += (_, _) => { StopTimers(); _coverCts?.Cancel(); _coverCts?.Dispose(); };
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

        var wasVisible = PrepareMode();
        var generation = _generation;

        if (wasVisible)
        {
            TransitionInPlace(from, to, generation);
            return;
        }

        _volumeMode = false;
        PillLabel.Text = "系统音频";
        PillStatus.Width = 48;
        DeviceGlyph.Data = Geometry.Parse(GlyphFor(to.Name));
        Shell.Height = CollapsedHeight;
        PillRow.Opacity = 1;
        PillStatus.Text = "正在切换";

        FromName.Text = DisplayName(from?.Name);
        ToName.Text = DisplayName(to.Name);
        StatusText.Text = "正在切换";
        FromCaption.Text = "当前播放";
        ToCaption.Text = "切换到";
        ToStack.Opacity = 0.35;
        ToShift.X = 0;
        FromStack.Opacity = 1;
        FromShift.X = 0;
        ArrowHead.Opacity = 0;
        ProgressFill.Width = 0;
        ProgressTrack.BeginAnimation(OpacityProperty, null);
        ProgressTrack.Opacity = 1;

        var easeOut = new CubicEase { EasingMode = EasingMode.EaseOut };
        var easeInOut = new CubicEase { EasingMode = EasingMode.EaseInOut };

        FitExpandedWidth();

        BeginAppear(wasVisible);

        if (wasVisible)
        {
            StretchWidth(Math.Max(RetractWidth, ContentLayer.Width), _expandedWidth, 300);
        }
        else
        {
            PopIn(_expandedWidth);
        }
        Shell.BeginAnimation(HeightProperty, new DoubleAnimationUsingKeyFrames
        {
            Duration = TimeSpan.FromMilliseconds(PopMs),
            KeyFrames =
            {
                new SplineDoubleKeyFrame(ExpandedHeight, KeyTime.FromPercent(1), PopHeightSpline),
            },
        });
        PillRow.BeginAnimation(OpacityProperty,
            new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(130))
            {
                BeginTime = TimeSpan.FromMilliseconds(50),
                EasingFunction = easeOut,
            });
        Detail.BeginAnimation(OpacityProperty,
            new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(240))
            {
                BeginTime = TimeSpan.FromMilliseconds(120),
                EasingFunction = easeOut,
            });

        // 箭头先画出来：横线生长，实心箭头随后出现；没有额外光点。
        ArrowLine.X2 = 20;
        ArrowLine.BeginAnimation(Line.X2Property,
            new DoubleAnimation(1, 20, TimeSpan.FromMilliseconds(300))
            {
                BeginTime = TimeSpan.FromMilliseconds(240),
                EasingFunction = easeInOut,
            });
        ArrowHead.BeginAnimation(OpacityProperty,
            new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(150))
            {
                BeginTime = TimeSpan.FromMilliseconds(470),
            });
        var progressWidth = Math.Max(1, _expandedWidth - 68);
        ProgressFill.BeginAnimation(WidthProperty,
            new DoubleAnimation(0, progressWidth, TimeSpan.FromMilliseconds(2500)));

        StartTimers(generation, easeOut);
    }

    /// <summary>
    /// OSD 已经显示在屏幕上时，第二次切换不再重放入场/弹窗动画，
    /// 只让现有左右两组文字交叉淡出再淡入，箭头和卡片保持原位。
    /// </summary>

    /// <summary>
    /// 音量胶囊：不展开、只淡入一颗小胶囊，显示百分比或「静音」，底部细线就是音量。
    /// 连续调音量时反复调用，只换数字和线长，不重播弹出动画。
    /// </summary>
    internal void ShowVolume(int percent, bool muted)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => ShowVolume(percent, muted)));
            return;
        }

        var value = Math.Clamp(percent, 0, 100);

        // 已经在显示音量胶囊：只换数字和长条，不重播淡入／弹出，连按音量键不会闪。
        if (_volumeMode && !_hiding && IsVisible)
        {
            PillStatus.Text = muted ? "静音" : value + "%";
            ProgressTrack.Opacity = muted || value == 0 ? 0.25 : 1;
            ProgressFill.BeginAnimation(WidthProperty, null);
            ProgressFill.Width = Math.Max(1, (CollapsedWidth - 68) * value / 100.0);
            RestartDismissTimer(1300, _generation);
            return;
        }

        var wasVisible = PrepareMode();
        var generation = _generation;
        _volumeMode = true;
        PillRow.Opacity = 1;
        PillLabel.Text = "应用音量";
        PillStatus.Width = 34;
        PillStatus.Text = muted ? "静音" : value + "%";
        DeviceGlyph.Data = Geometry.Parse(SpeakerGlyph);
        // 之前可能是「切换设备」那条长胶囊，这里一律收回到音量胶囊的宽度。
        ProgressTrack.BeginAnimation(OpacityProperty, null);
        ProgressTrack.Opacity = muted || value == 0 ? 0.25 : 1;
        ProgressFill.BeginAnimation(WidthProperty, null);
        ProgressFill.Width = Math.Max(1, (CollapsedWidth - 68) * value / 100.0);

        Present(wasVisible, CollapsedWidth, 1300);
    }


    /// <summary>
    /// 后台切歌胶囊：显示封面块（取标题首字）、歌名、歌手和播放状态，宽度按内容自适应。
    /// </summary>
    internal void ShowTrack(string title, string artist, bool playing, string? coverUrl = null, bool transitioning = false)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => ShowTrack(title, artist, playing, coverUrl, transitioning)));
            return;
        }

        var wasVisible = PrepareMode();
        var generation = _generation;
        _volumeMode = false;
        _trackMode = true;
        TrackRow.Opacity = 1;
        TrackTitle.Text = string.IsNullOrWhiteSpace(title) ? "未命名" : title;
        TrackArtist.Text = string.IsNullOrWhiteSpace(artist) ? "未知艺术家" : artist;
        TrackCoverText.Text = FirstGlyph(TrackTitle.Text);
        TrackCover.Opacity = playing ? 1 : 0.6;
        LoadCover(coverUrl);

        TrackTitle.MaxWidth = TrackArtist.MaxWidth = Math.Max(60, Math.Min(MaxExpandedWidth, _workArea.Width - 40) - 160);

        // 量宽度时按最长的状态词算：「过渡中」后面会就地变成「正在播放」（多一个字），
        // 按当下的词量就会在收尾那一帧把最后一个字顶出胶囊。
        TrackStatus.Text = "正在播放";
        _expandedWidth = MeasureRow(TrackRow, pinWidth: false);
        TrackStatus.Text = !playing ? "已暂停" : transitioning ? "过渡中" : "正在播放";
        ProgressTrack.BeginAnimation(OpacityProperty, null);
        ProgressTrack.Opacity = transitioning ? 1 : 0;
        if (transitioning)
        {
            // 进度由播放引擎上报，不使用固定时长模拟。
            ProgressFill.BeginAnimation(WidthProperty, null);
            ProgressFill.Width = 0;
        }

        Present(wasVisible, _expandedWidth, transitioning ? 2200 : 1800, 320);
    }

    /// <summary>
    /// 过渡收尾：同一首歌从「过渡中」转成正式播放。不重新弹胶囊，只把还在屏上的
    /// 那条就地改成「正在播放」，并把底部过渡线走完淡掉。
    /// </summary>
    internal void UpdatePlayback(bool playing, bool transitioning, double progress = 0, double remainingMs = 0)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => UpdatePlayback(playing, transitioning, progress, remainingMs)));
            return;
        }
        if (!IsVisible || _hiding || !_trackMode) return;
        if (playing && transitioning)
        {
            var fullWidth = Math.Max(0, _expandedWidth - 68);
            var reported = fullWidth * Math.Clamp(progress, 0, 0.999);
            var current = ProgressFill.Width;
            // 正常上报保持当前位置和连续速度；明显偏差才校正到引擎进度。
            var from = Math.Abs(current - reported) > fullWidth * 0.08 ? reported : current;
            var target = fullWidth * 0.999;
            var duration = double.IsFinite(remainingMs) ? Math.Clamp(remainingMs, 16, 120000) : 200;
            ProgressFill.BeginAnimation(WidthProperty,
                new DoubleAnimation(from, Math.Max(from, target), TimeSpan.FromMilliseconds(duration)));

        }
        var ended = TrackStatus.Text == "过渡中" && (!transitioning || !playing);
        if (ended) ConfirmTransition();
        TrackStatus.Text = !playing ? "已暂停" : transitioning ? "过渡中" : "正在播放";
        TrackCover.Opacity = playing ? 1 : 0.6;
    }

    internal void ConfirmTransition()
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(ConfirmTransition));
            return;
        }

        if (!IsVisible || _hiding || !_trackMode)
        {
            return;
        }

        TrackStatus.Text = "正在播放";
        TrackCover.Opacity = 1;
        ProgressFill.BeginAnimation(WidthProperty, null);
        ProgressFill.Width = Math.Max(1, _expandedWidth - 68);
        ProgressTrack.BeginAnimation(OpacityProperty,
            new DoubleAnimation(ProgressTrack.Opacity, 0, TimeSpan.FromMilliseconds(240))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
            });
        // 让这条多停留一会儿，用户能看清「正在播放」，然后照常收成球。
        RestartDismissTimer(1100, _generation);
    }

    /// <summary>
    /// 用「圆角矩形」而不是 ClipToBounds 来裁内容：ClipToBounds 是直角裁切，
    /// 胶囊变宽的那几帧两端会被切成直的，看着像方块。这里跟着当前尺寸重建圆角裁剪。
    /// </summary>
    private void OnShellSizeChanged(object sender, SizeChangedEventArgs e)
    {
        var radius = Math.Min(CollapsedHeight / 2, Math.Max(0, Math.Min(e.NewSize.Width, e.NewSize.Height) / 2));
        Shell.Clip = new RectangleGeometry(new Rect(0, 0, e.NewSize.Width, e.NewSize.Height), radius, radius);
        // 内容独立居中，避免父容器逐帧重排与像素取整造成左右抖动。
        ContentLayer.Clip = new RectangleGeometry(
            new Rect((ContentLayer.Width - e.NewSize.Width) / 2, 0, e.NewSize.Width, e.NewSize.Height), radius, radius);
    }

    /// <summary>
    /// 三种形态共用的收尾：高度归位 → 入场 → 宽度（在屏上伸展 / 从无到有弹出）→ 收起计时。
    /// 之前 ShowTransition / ShowVolume / ShowTrack 各自抄了一遍，改一处漏两处。
    /// </summary>
    private void Present(bool wasVisible, double targetWidth, int holdMs, int stretchMs = 300)
    {
        Shell.Height = CollapsedHeight;
        BeginAppear(wasVisible);
        if (wasVisible)
        {
            StretchWidth(Math.Max(RetractWidth, Shell.Width), targetWidth, stretchMs);
        }
        else
        {
            PopIn(targetWidth);
        }

        if (_trackMode && TrackStatus.Text == "过渡中")
        {
            StartDismiss(30000, _generation); // 异常事件丢失时仍有超时兜底。
        }
        else StartDismiss(holdMs, _generation);
    }

    private void StartDismiss(int milliseconds, long generation)
    {
        _dismissTimer?.Stop();
        // 捕获局部 timer：旧定时器晚一拍触发时不能去 Stop 新的那个字段。
        var timer = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(milliseconds),
        };
        _dismissTimer = timer;
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            if (generation == _generation)
            {
                Dismiss();
            }
        };
        timer.Start();
    }

    private static string FirstGlyph(string text)
    {
        foreach (var ch in text)
        {
            if (!char.IsWhiteSpace(ch))
            {
                return ch.ToString();
            }
        }

        return "♪";
    }

    /// <summary>量一行的自然宽度，再加上左右内边距；太长时封顶，免得顶到屏幕边。</summary>
    private CancellationTokenSource? _coverCts;
    private string? _coverUrl;

    /// <summary>封面：有图就用图，没有就退回首字块；换歌时旧请求作废，避免串图。</summary>
    private void LoadCover(string? coverUrl)
    {
        // 同一封面（例如播放/暂停提示）保留已显示图片或正在进行的请求。
        if (string.Equals(_coverUrl, coverUrl, StringComparison.Ordinal) &&
            (TrackCoverImage.Source is not null || _coverCts is not null)) return;
        _coverUrl = coverUrl;
        _coverCts?.Cancel();
        _coverCts?.Dispose();
        _coverCts = null;
        TrackCoverImage.Source = null;
        TrackCoverImage.Visibility = Visibility.Collapsed;
        TrackCoverText.Visibility = Visibility.Visible;

        if (string.IsNullOrWhiteSpace(coverUrl))
        {
            Zilux2.HostLog.Info("[osd] cover none");
            return;
        }

        Zilux2.HostLog.Info($"[osd] cover load {coverUrl[..Math.Min(120, coverUrl.Length)]}");

        var cts = new CancellationTokenSource();
        _coverCts = cts;
        var token = cts.Token;
        _ = LoadCoverAsync(coverUrl, token);
    }

    private async Task LoadCoverAsync(string coverUrl, CancellationToken token)
    {
        var image = await Zilux2.Media.SmtcArtwork.LoadImageAsync(coverUrl, 60, token).ConfigureAwait(false);
        Zilux2.HostLog.Info($"[osd] cover loaded={image is not null} source={(coverUrl.Length > 48 ? coverUrl[..48] : coverUrl)}");
        if (image is null || token.IsCancellationRequested)
        {
            Zilux2.HostLog.Warn($"[osd] cover fail cancelled={token.IsCancellationRequested} null={image is null}");
            return;
        }

        await Dispatcher.InvokeAsync(() =>
        {
            if (token.IsCancellationRequested || _coverCts?.Token != token)
            {
                return;
            }

            TrackCoverImage.Source = image;
            TrackCoverImage.Visibility = Visibility.Visible;
            TrackCoverText.Visibility = Visibility.Collapsed;
        });
    }

    private double MeasureRow(FrameworkElement row, bool pinWidth = true)
    {
        row.Width = double.NaN;
        row.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        var desired = row.DesiredSize.Width;
        if (double.IsNaN(desired) || desired <= 0)
        {
            desired = 260;
        }

        var max = Math.Min(MaxExpandedWidth, Math.Max(MinExpandedWidth, _workArea.Width - 40));
        var width = Math.Clamp(desired + 40, 240, max);
        // 只有用星号列的 Detail 需要把宽度钉死（换设备名时不重排）；
        // TrackRow 是 Auto 列，钉住宽度会把内容留在左边、右边空一大块。
        if (pinWidth)
        {
            row.Width = Math.Max(1, width - 40);
        }

        return width;
    }

    private void TransitionInPlace(SystemAudioOutputDevice? from, SystemAudioOutputDevice to, long generation)
    {
        var easeOut = new CubicEase { EasingMode = EasingMode.EaseOut };

        FromStack.BeginAnimation(OpacityProperty, null);
        ToStack.BeginAnimation(OpacityProperty, null);
        // 这是「同一条胶囊就地换字」，文字必须一直在：PrepareMode 刚把所有层清零了，
        // 这里立刻把正文打开，中间不会有空白帧。
        Detail.Opacity = 1;
        PillRow.Opacity = 0;
        TrackRow.Opacity = 0;
        ProgressTrack.BeginAnimation(OpacityProperty, null);
        ProgressTrack.Opacity = 1;
        _volumeMode = false;
        PillLabel.Text = "系统音频";
        PillStatus.Width = 48;
        DeviceGlyph.Data = Geometry.Parse(GlyphFor(to.Name));

        var previousDetailWidth = Detail.ActualWidth;
        FromName.Text = DisplayName(from?.Name);
        ToName.Text = DisplayName(to.Name);
        StatusText.Text = "正在切换";
        PillStatus.Text = "正在切换";
        FromCaption.Text = "当前播放";
        ToCaption.Text = "切换到";
        // 文字就地换掉：不位移、不淡出，切换时不会有任何左右移动。
        FromShift.X = 0;
        ToShift.X = 0;
        FromStack.Opacity = 1;
        ToStack.Opacity = 0.35;

        // 不重画整条箭头，只让箭头本身轻微亮一下，并重启进度和停留计时。
        ArrowHead.BeginAnimation(OpacityProperty, null);
        // 箭头保持在「已画完」的稳态：清掉动画后 X2 会退回 XAML 的 0，必须显式补回来。
        ArrowLine.BeginAnimation(Line.X2Property, null);
        ArrowLine.X2 = 20;
        ArrowHead.Opacity = 0.45;
        ArrowHead.BeginAnimation(OpacityProperty,
            new DoubleAnimation(0.45, 1, TimeSpan.FromMilliseconds(240))
            {
                EasingFunction = easeOut,
            });

        var previousWidth = Shell.Width;
        FitExpandedWidth();
        // 宽度直接到位，不做半差补偿：内容按新宽度重新居中，
        // 补偿反而会把文字拖出一次横移。
        _ = previousDetailWidth;
        DetailShift.BeginAnimation(TranslateTransform.XProperty, null);
        DetailShift.X = 0;

        StretchWidth(previousWidth, _expandedWidth, 320);

        var progressWidth = Math.Max(1, _expandedWidth - 68);
        ProgressFill.BeginAnimation(WidthProperty, null);
        ProgressFill.Width = 0;
        ProgressFill.BeginAnimation(WidthProperty,
            new DoubleAnimation(0, progressWidth, TimeSpan.FromMilliseconds(2500))
            {
                EasingFunction = easeOut,
            });

        StartTimers(generation, easeOut);
    }

    /// <summary>重启自动收起计时：只更新时间，不动动画与代次。</summary>
    private void RestartDismissTimer(int milliseconds, long generation)
    {
        _dismissTimer?.Stop();
        // 捕获局部 timer：旧定时器晚一拍触发时不能去 Stop 新的那个字段。
        var timer = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(milliseconds),
        };
        _dismissTimer = timer;
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            if (generation == _generation)
            {
                Dismiss();
            }
        };
        timer.Start();
    }

    private void StartTimers(long generation, IEasingFunction easeOut)
    {
        _phaseTimer?.Stop();
        var phase = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(650),
        };
        _phaseTimer = phase;
        phase.Tick += (_, _) =>
        {
            phase.Stop();
            if (generation != _generation)
            {
                return;
            }

            StatusText.Text = "已切换";
            PillStatus.Text = "已切换";
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
        };
        phase.Start();

        StartDismiss(ShowMs, generation);
    }

    private void Dismiss()
    {
        if (_hiding)
        {
            return;
        }

        _hiding = true;
        var generation = _generation;
        var easeIn = new CubicEase { EasingMode = EasingMode.EaseIn };
        var easeOut = new CubicEase { EasingMode = EasingMode.EaseOut };

        // 1) 所有文字一起渐隐：胶囊一边收窄一边把字淡掉，不会出现「字被边切掉」的画面。
        var textFade = TimeSpan.FromMilliseconds(150);
        Detail.BeginAnimation(OpacityProperty,
            new DoubleAnimation(Detail.Opacity, 0, textFade) { EasingFunction = easeIn });
        PillRow.BeginAnimation(OpacityProperty,
            new DoubleAnimation(PillRow.Opacity, 0, textFade) { EasingFunction = easeIn });
        TrackRow.BeginAnimation(OpacityProperty,
            new DoubleAnimation(TrackRow.Opacity, 0, textFade) { EasingFunction = easeIn });
        ArrowHead.BeginAnimation(OpacityProperty,
            new DoubleAnimation(ArrowHead.Opacity, 0, TimeSpan.FromMilliseconds(110)));
        ProgressTrack.BeginAnimation(OpacityProperty,
            new DoubleAnimation(ProgressTrack.Opacity, 0, TimeSpan.FromMilliseconds(140)) { EasingFunction = easeIn });
        ArrowLine.BeginAnimation(Line.X2Property,
            new DoubleAnimation(ArrowLine.X2, 1, TimeSpan.FromMilliseconds(170)) { EasingFunction = easeIn });

        // 连续收至零并同步淡出，不在圆点形态停留或回弹。
        var duration = TimeSpan.FromMilliseconds(ShrinkMs);
        var shrink = new DoubleAnimation(Shell.Width, 0, duration)
        {
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseInOut },
        };
        shrink.Completed += (_, _) =>
        {
            if (generation == _generation) Hide();
        };
        Stage.BeginAnimation(OpacityProperty,
            new DoubleAnimation(Stage.Opacity, 0, duration) { EasingFunction = easeIn });
        Shell.BeginAnimation(WidthProperty, shrink);
    }

    /// <summary>
    /// 换形态（切设备 ↔ 音量 ↔ 切歌）的统一入口：先把上一形态还在飞的动画全部停掉，
    /// 把宽度冻在它当前的真实值上，再让调用方设自己的文字。
    /// 这样连续快速切换时，不会出现「条在动、字还是上一形态的透明状态」。
    /// </summary>
    /// <summary>
    /// 所有形态共用同一套入场：已在屏上就不做任何位移/淡入（只换内容），
    /// 从隐藏出现则和音量胶囊完全一致 —— 130ms 淡入 + 6px 下落。
    /// </summary>
    private void BeginAppear(bool wasVisible)
    {
        var easeOut = new CubicEase { EasingMode = EasingMode.EaseOut };
        Stage.BeginAnimation(OpacityProperty, null);
        if (wasVisible)
        {
            Stage.Opacity = 1;
            ShellShift.BeginAnimation(TranslateTransform.YProperty, null);
            ShellShift.Y = 0;
            return;
        }

        Stage.Opacity = 0;
        Stage.BeginAnimation(OpacityProperty,
            new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(130)) { EasingFunction = easeOut });
        ShellShift.Y = -6;
        ShellShift.BeginAnimation(TranslateTransform.YProperty,
            new DoubleAnimation(-6, 0, TimeSpan.FromMilliseconds(180)) { EasingFunction = easeOut });
    }

    /// <summary>
    /// 宽度以轻微过冲、回弹收尾，内容独立布局。
    /// 只对 Shell（奶油底）做宽度补间；内容层固定成最终宽度并居中，
    /// 由 Shell 的 ClipToBounds 按当前宽度裁切 —— 文字不移动，只是被逐段揭开。
    /// </summary>
    private void StretchWidth(double from, double to, int milliseconds = 320)
    {
        ContentLayer.Width = to;
        Stage.Width = Width - 20;
        Shell.BeginAnimation(WidthProperty, null);
        Shell.Width = to;
        var duration = Math.Max(420, milliseconds);
        var overshoot = Math.Clamp((to - from) * 0.035, -10, 10);
        Shell.BeginAnimation(WidthProperty, new DoubleAnimationUsingKeyFrames
        {
            Duration = TimeSpan.FromMilliseconds(duration),
            KeyFrames =
            {
                new DiscreteDoubleKeyFrame(from, KeyTime.FromPercent(0)),
                new SplineDoubleKeyFrame(to + overshoot, KeyTime.FromPercent(0.7), new KeySpline(0.2, 0.8, 0.2, 1)),
                new SplineDoubleKeyFrame(to, KeyTime.FromPercent(1), new KeySpline(0.2, 0, 0.3, 1)),
            },
        });
        // 屏上切换只更新内容与壳层宽度，不把整层重新从透明播起。
        ContentLayer.BeginAnimation(OpacityProperty, null);
        ContentLayer.Opacity = 1;
    }

    /// <summary>从隐藏出现：胶囊从一颗小球弹开到目标宽度，内容随之被揭开。</summary>
    private void PopIn(double to)
    {
        ContentLayer.Width = to;
        Stage.Width = Width - 20;
        // 弹出过程中内容一律隐身：胶囊还是窄的，这时露字就是「左右被切」。
        // 等宽度长到约 9 成再把内容淡进来，看得见的时候形状已经完整了。
        ContentLayer.BeginAnimation(OpacityProperty, null);
        ContentLayer.Opacity = 0;
        ContentLayer.BeginAnimation(OpacityProperty,
            new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(150))
            {
                BeginTime = TimeSpan.FromMilliseconds(PopMs * 0.42),
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
            });

        Shell.BeginAnimation(WidthProperty, null);
        Shell.Width = PopFromWidth;
        Shell.BeginAnimation(WidthProperty, new DoubleAnimationUsingKeyFrames
        {
            Duration = TimeSpan.FromMilliseconds(PopMs),
            KeyFrames =
            {
                new SplineDoubleKeyFrame(to, KeyTime.FromPercent(1), PopWidthSpline),
            },
        });
    }

    private bool PrepareMode()
    {
        // 只要屏上还有像素就算「已显示」：正在淡出/收拢途中切过来，也应该是水平伸展，
        // 而不是重新从小胶囊弹一次。
        var wasVisible = IsVisible && Stage.Opacity > 0.01;
        var liveWidth = Math.Max(RetractWidth, Shell.Width);

        _generation++;
        _trackMode = false;
        StopTimers();
        _hiding = false;
        PositionAtTopCenter();

        if (!IsVisible)
        {
            Show();
        }

        ResetAnimations();

        if (wasVisible)
        {
            // 中途接手：抹掉淡出残留，保持整条不透明，接着做水平伸展。
            Stage.Opacity = 1;
        }

        // 所有形态的文字先全部隐藏，由各自的 Show 打开；不做淡入，避免和上一形态的淡出打架。
        Detail.Opacity = 0;
        PillRow.Opacity = 0;
        TrackRow.Opacity = 0;
        ProgressTrack.BeginAnimation(OpacityProperty, null);
        ProgressTrack.Opacity = 0;

        if (wasVisible)
        {
            Shell.Width = liveWidth;
        }

        return wasVisible;
    }

    private void ResetAnimations()
    {
        Stage.BeginAnimation(OpacityProperty, null);
        ShellShift.BeginAnimation(TranslateTransform.YProperty, null);
        ContentShift.BeginAnimation(TranslateTransform.XProperty, null);
        ContentShift.X = 0;
        FromStack.BeginAnimation(OpacityProperty, null);
        FromShift.BeginAnimation(TranslateTransform.XProperty, null);
        ToStack.BeginAnimation(OpacityProperty, null);
        ToShift.BeginAnimation(TranslateTransform.XProperty, null);
        ArrowLine.BeginAnimation(Line.X2Property, null);
        ArrowHead.BeginAnimation(OpacityProperty, null);
        ProgressFill.BeginAnimation(WidthProperty, null);
        Shell.BeginAnimation(WidthProperty, null);
        Shell.BeginAnimation(HeightProperty, null);
        PillRow.BeginAnimation(OpacityProperty, null);
        Detail.BeginAnimation(OpacityProperty, null);
        // 收起时会把这层淡到 0 并 HoldEnd；不在这里清掉，下次显示时
        // 赋 Opacity=1 会被残留动画压住，胶囊里就只剩一块空壳。
        TrackRow.BeginAnimation(OpacityProperty, null);
        ProgressTrack.BeginAnimation(OpacityProperty, null);
        TrackRow.Opacity = 0;
        Stage.Opacity = 1;
        ShellShift.Y = 0;
        ContentLayer.BeginAnimation(OpacityProperty, null);
        ContentLayer.Opacity = 1;
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

    /// <summary>
    /// 量一遍 Detail 的实际宽度，把展开宽设成「内容宽 + 内边距」，设备名再长也完整显示；
    /// 同时把 Detail 的宽度钉死，宽度动画期间文字不会重新排版。
    /// </summary>
    private void FitExpandedWidth()
    {
        FromName.MaxWidth = ToName.MaxWidth = Math.Max(40, (Math.Min(MaxExpandedWidth, _workArea.Width - 40) - 260) / 2);
        Detail.Width = double.NaN;
        Detail.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        var desired = Detail.DesiredSize.Width;
        if (double.IsNaN(desired) || desired <= 0)
        {
            desired = 420;
        }

        var max = Math.Min(MaxExpandedWidth, Math.Max(MinExpandedWidth, _workArea.Width - 40));
        _expandedWidth = Math.Clamp(desired + 40, MinExpandedWidth, max);
        Detail.Width = Math.Max(1, _expandedWidth - 40);
    }

    /// <summary>
    /// 胶囊位置固定用主屏可用区域（DIP）。
    /// 维护者 2026-11-25：「这个桌面悬浮的胶囊位置显示设置为始终在主屏幕，因为有时候会跑到其他屏幕去」
    /// —— 以前跟着主窗口所在屏幕走，主窗拖到副屏时胶囊也跟着跑，所以这里不再接受外部工作区。
    /// </summary>
    private Rect _workArea = SystemParameters.WorkArea;

    /// <summary>保留调用点，但一律以主屏为准（见上面维护者要求）。</summary>
    internal void SetWorkArea(Rect area)
    {
        _workArea = SystemParameters.WorkArea;
    }

    private void PositionAtTopCenter()
    {
        // 屏幕上方居中：胶囊从中间往两边长开，像灵动岛。
        // 用主窗所在那块屏，而不是永远主屏 —— 双屏时不会跑到另一块屏上去。
        var area = _workArea;
        // 取整：窗口位置带小数时，壳层在窗内居中会多出半像素偏差，看起来就不在正中间。
        Left = Math.Round(area.Left + (area.Width - Width) / 2);
        Top = Math.Round(area.Top + 26);
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
