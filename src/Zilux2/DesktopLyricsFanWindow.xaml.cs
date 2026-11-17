using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Threading;
using Zilux2.Interop;
using Zilux2.Settings;

namespace Zilux2;

/// <summary>
/// 桌面歌词（悬浮扇形样式）：迁移自 Zilux v1 的扇形浮层（FanWindow）。
/// <para>
/// 一张卡＝一句歌词，整组沿弧线逐格右移 <see cref="SlotDx"/>、上移 <see cref="SlotDy"/>、
/// 旋转 <see cref="SlotRotStep"/>，当前句固定在 slot <see cref="LeadSlot"/>，越远越淡
/// （降到 <see cref="AlphaFloor"/> 为止）。换句＝整组连续上移一格（<see cref="RollMs"/> 补间），
/// 卡片自身不动、只插值，所以不会重排、不会闪句。
/// </para>
/// <para>
/// 卡片内部沿用 v1 的卡拉 OK 结构：同一句话叠两层 TextBlock，亮层用矩形裁剪露出已唱部分，
/// 每帧只改一个裁剪宽度。位置由页面每 200~250ms 推一次，两次之间本地按
/// <see cref="MaxExtrapolationSeconds"/> 外推，超过就停在最后已知位置。
/// </para>
/// </summary>
public partial class DesktopLyricsFanWindow : Window, IDesktopLyricsSurface
{
    private const int GwlExStyle = -20;
    private const int WsExTransparent = 0x20;
    private const int WsExNoActivate = 0x08000000;
    private const int WsExToolWindow = 0x80;

    /// <summary>1/255 黑：肉眼看不出，但让整窗成为稳定的鼠标命中矩形。</summary>
    private static readonly Brush HitTestFill = CreateHitTestFill();

    private static Brush CreateHitTestFill()
    {
        var brush = new SolidColorBrush(Color.FromArgb(1, 0, 0, 0));
        brush.Freeze();
        return brush;
    }

    // 与 Zilux v1 FanGeometry 的锁定参数一致（spacing=1、arcRadius=620、tilt=4）。
    private const double SlotDx = 16;
    private const double SlotDy = 49;
    private const double SlotRotStep = 4;
    private const double AlphaTaper = 0.13;
    private const double AlphaFloor = 0.22;
    private const double BoxPad = 20;
    private const double RevealMs = 300;
    private const double RollMs = 520;
    private const double StaggerMs = 16;
    private const double CollapsedScale = 0.74;
    private const double MaxExtrapolationSeconds = 3;
    private const double PanelPad = 16;
    private const double CardPadX = 13;

    private static readonly FontFamily LyricFont = new("Segoe UI, Microsoft YaHei UI");

    private readonly SettingsService? _settings;
    private readonly Dictionary<int, DesktopLyricLine> _lines = new();
    private readonly Dictionary<int, FanCard> _cards = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();

    private double _lastFrameSeconds;
    private bool _rendering;

    // WPF 只在「有脏区」时才跑合成线程，全透明空窗会一直不触发 CompositionTarget.Rendering；
    // 这里用 DispatcherTimer 自己驱动补间，播放时 60fps、静止时降到 8fps。
    private readonly DispatcherTimer _frameTimer = new(DispatcherPriority.Render)
    {
        Interval = TimeSpan.FromMilliseconds(16),
    };

    private int _fanLines = 9;
    private int _fanWidth = 240;
    private int _fontSize = 40;
    private double _fontPx = 13.2;
    private double _cardHeight = 32;
    private int _visibleLines = 9;
    private int _leadSlot = 3;
    private double _windowW = 386;
    private double _windowH = 519;
    private double _anchorX;
    private double _anchorY = 400;

    private int _currentIndex = -1;
    private double _anchorFrom;
    private double _anchorTo = -1;
    private double _anchorT = 1;
    private bool _hasAnchor;
    private double _revealT = 1;
    private double _pushedMs;
    private double _sincePush;
    private bool _playing;
    private bool _hasFrame;

    private Brush _cardFill = Brushes.Transparent;
    private Brush _cardEdge = Brushes.Transparent;
    private Brush _activeFill = Brushes.Transparent;
    private Brush _activeEdge = Brushes.Transparent;
    private Brush _idleDim = Brushes.White;
    private Brush _idleLit = Brushes.White;
    private Brush _activeDim = Brushes.Black;
    private Brush _activeLit = Brushes.Black;

    private bool _locked;
    private bool _topmost = true;
    private int _backdrop = 40;
    private string _weight = "normal";
    private bool _dragging;
    private Point _dragOrigin;
    private double _dragLeft;
    private double _dragTop;

    internal DesktopLyricsFanWindow(SettingsService? settings = null)
    {
        _settings = settings;
        InitializeComponent();
        RefreshCardBrushes();
        RebuildGeometry();

        _frameTimer.Tick += (_, _) => OnFrameTick();
        SourceInitialized += (_, _) => ApplyWindowChrome();
        IsVisibleChanged += OnIsVisibleChanged;
        Closed += (_, _) =>
        {
            StopRendering();
            ClosedByUser?.Invoke();
        };
        MouseLeftButtonDown += OnDragStart;
        MouseMove += OnDragMove;
        MouseLeftButtonUp += OnDragEnd;
        MouseRightButtonUp += OnRightClick;
    }

    public event Action? ClosedByUser;

    public void UpdateLines(DesktopLyricsFrame frame)
    {
        if (frame is null)
        {
            return;
        }

        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => UpdateLines(frame)));
            return;
        }

        _hasFrame = true;
        _pushedMs = Math.Max(0, frame.PositionMs);
        _sincePush = 0;
        _playing = frame.Playing;

        if (frame.Lines is { Count: > 0 } incoming && frame.LinesStart >= 0)
        {
            for (var i = 0; i < incoming.Count; i++)
            {
                if (incoming[i] is not null)
                {
                    _lines[frame.LinesStart + i] = incoming[i];
                }
            }

            TrimLines();
        }
        else if (frame.Lines is { Count: 0 })
        {
            // 页面明确表示「当前没有词」：清空上下文，别把上一首的句子留在屏幕上。
            _lines.Clear();
            ClearCards();
        }

        var index = ResolveIndex(frame);
        SetAnchor(index);
        RebuildCards();
        StartRendering();
    }

    public void ApplyStyle(int fontSize, bool locked, bool topmost, string weight, int backdropOpacity, int fanLines, int fanWidth)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => ApplyStyle(fontSize, locked, topmost, weight, backdropOpacity, fanLines, fanWidth)));
            return;
        }

        _weight = NormalizeWeight(weight);
        _topmost = topmost;
        _backdrop = Math.Clamp(backdropOpacity, 30, 90);
        Topmost = topmost;

        var width = Math.Clamp(fanWidth, 180, 360);
        var lines = Math.Clamp(fanLines, 3, 15);
        var clampedFont = Math.Clamp(fontSize, 28, 64);
        var geometryChanged = width != _fanWidth || lines != _fanLines || clampedFont != _fontSize;
        _fanWidth = width;
        _fanLines = lines;
        _fontSize = clampedFont;
        if (geometryChanged)
        {
            RebuildGeometry();
            ClearCards();
            RebuildCards();
        }

        _locked = locked;
        ApplyWindowChrome();
        RefreshCardBrushes();
    }

    public void PlaceDefault()
    {
        var area = SystemParameters.WorkArea;
        Width = _windowW;
        Height = _windowH;
        Left = area.Left + Math.Max(0, (area.Width - _windowW) / 2);
        Top = Math.Max(area.Top, area.Bottom - _windowH - 8);
    }

    public void SetLocked(bool locked)
    {
        if (_locked == locked)
        {
            return;
        }

        _locked = locked;
        ApplyWindowChrome();
        PersistField("desktopLyricsLocked", locked ? "true" : "false");
    }

    // ── 几何 ────────────────────────────────────────────────────────────────

    private void RebuildGeometry()
    {
        _visibleLines = Math.Clamp(_fanLines, 3, 15);
        _leadSlot = Math.Min(3, _visibleLines - 1);
        // 共用「字号」滑块：28..64 映射到卡片的 11..19px，宽度不够时 FitLine 再往下缩。
        _fontPx = Math.Clamp(Math.Round(11 + (_fontSize - 28) * 8.0 / 36.0, 1), 9, 19);
        _cardHeight = Math.Clamp(Math.Round(_fontPx * 2.45), 26, 58);

        double left = double.MaxValue, right = double.MinValue, top = double.MaxValue, bottom = double.MinValue;
        for (var slot = 0; slot < _visibleLines; slot++)
        {
            var (x, y, rotation) = SlotPlacement(slot);
            var radians = rotation * Math.PI / 180;
            var halfW = Math.Abs(_fanWidth / 2 * Math.Cos(radians)) + Math.Abs(_cardHeight / 2 * Math.Sin(radians));
            var halfH = Math.Abs(_fanWidth / 2 * Math.Sin(radians)) + Math.Abs(_cardHeight / 2 * Math.Cos(radians));
            left = Math.Min(left, x - halfW);
            right = Math.Max(right, x + halfW);
            top = Math.Min(top, y - halfH);
            bottom = Math.Max(bottom, y + halfH);
        }

        left -= BoxPad;
        right += BoxPad;
        // 上下各留一格的余量：换句滚动时头尾卡片会短暂落在 [0, N-1] 之外，
        // 不留余量就会被窗口边缘硬切（AABB 只按静止态算）。
        top -= BoxPad + SlotDy;
        bottom += BoxPad + SlotDy;

        var oldAnchorX = _anchorX;
        var oldAnchorY = _anchorY;
        _anchorX = -left;
        _anchorY = -top;
        var width = Math.Max(160, Math.Ceiling(right - left));
        var height = Math.Max(200, Math.Ceiling(bottom - top));

        var positioned = !double.IsNaN(Left) && !double.IsNaN(Top);
        var anchorScreenX = positioned ? Left + oldAnchorX : 0;
        var anchorScreenY = positioned ? Top + oldAnchorY : 0;

        _windowW = width;
        _windowH = height;
        Width = width;
        Height = height;

        if (positioned)
        {
            // 尺寸变了也把「锚点」（当前句所在的底边中点）钉在原地，视觉上不跳。
            Left = anchorScreenX - _anchorX;
            Top = anchorScreenY - _anchorY;
            ClampIntoWorkArea();
        }
    }

    private void ClampIntoWorkArea()
    {
        var area = SystemParameters.WorkArea;
        if (double.IsNaN(Left) || double.IsNaN(Top))
        {
            return;
        }

        Left = Math.Clamp(Left, area.Left - _windowW * 0.6, area.Right - _windowW * 0.4);
        Top = Math.Min(Top, area.Bottom - _windowH);
        Top = Math.Max(Top, area.Top - 40);
    }

    private (double X, double Y, double Rot) SlotPlacement(double slot) =>
        (slot * SlotDx, -(slot + 1) * SlotDy, slot * SlotRotStep);

    private double SlotAlpha(double slot)
    {
        if (slot < 0 || slot > _visibleLines - 1)
        {
            return 0;
        }

        return Math.Max(AlphaFloor, 1 - AlphaTaper * Math.Abs(slot - _leadSlot));
    }

    private double RevealFactor(double slot)
    {
        if (_revealT >= 1)
        {
            return 1;
        }

        var elapsed = _revealT * (RevealMs + _visibleLines * StaggerMs);
        var local = Math.Clamp((elapsed - Math.Max(0, slot) * StaggerMs) / RevealMs, 0, 1);
        return 1 - Math.Pow(1 - local, 3);
    }

    private double AnchorNow()
    {
        if (!_hasAnchor)
        {
            return _anchorTo;
        }

        var eased = 1 - Math.Pow(1 - Math.Clamp(_anchorT, 0, 1), 3);
        return _anchorFrom + (_anchorTo - _anchorFrom) * eased;
    }

    private double CurrentPositionMs()
    {
        if (!_playing)
        {
            return _pushedMs;
        }

        return _pushedMs + Math.Min(_sincePush, MaxExtrapolationSeconds) * 1000;
    }

    // ── 数据与卡片 ──────────────────────────────────────────────────────────

    private int ResolveIndex(DesktopLyricsFrame frame)
    {
        if (frame.CurrentIndex >= 0)
        {
            return frame.CurrentIndex;
        }

        if (_lines.Count > 0 && !string.IsNullOrEmpty(frame.Now))
        {
            var matches = _lines.Where(pair => pair.Value.Text == frame.Now).Select(pair => pair.Key).ToList();
            if (matches.Count > 0)
            {
                return matches.OrderBy(key => Math.Abs(key - _currentIndex)).First();
            }
        }

        return _currentIndex;
    }

    private void SetAnchor(int index)
    {
        if (index < 0)
        {
            return;
        }

        if (_hasAnchor && index == _anchorTo)
        {
            _currentIndex = index;
            return;
        }

        var from = _hasAnchor ? AnchorNow() : index;
        _anchorFrom = from;
        _anchorTo = index;
        _anchorT = !_hasAnchor || Math.Abs(index - from) > 4 ? 1 : 0;
        _hasAnchor = true;
        _currentIndex = index;
    }

    private void TrimLines()
    {
        var keepFrom = Math.Max(0, _currentIndex - 20);
        foreach (var key in _lines.Keys.Where(key => key < keepFrom).ToList())
        {
            _lines.Remove(key);
        }
    }

    private void ClearCards()
    {
        foreach (var card in _cards.Values)
        {
            Stage.Children.Remove(card.Root);
        }

        _cards.Clear();
    }

    private void RebuildCards()
    {
        if (_currentIndex < 0)
        {
            return;
        }

        var lo = Math.Max(0, _currentIndex - 3);
        var hi = _currentIndex + _visibleLines + 3;
        foreach (var key in _cards.Keys.Where(key => key < lo || key > hi).ToList())
        {
            Stage.Children.Remove(_cards[key].Root);
            _cards.Remove(key);
        }

        for (var index = lo; index <= hi; index++)
        {
            if (_cards.ContainsKey(index) || !_lines.TryGetValue(index, out var line))
            {
                continue;
            }

            var card = CreateCard(line);
            _cards[index] = card;
            Stage.Children.Add(card.Root);
        }
    }

    private FanCard CreateCard(DesktopLyricLine line)
    {
        var (text, textWidth, fontPx) = FitLine(line.Text);
        var dim = BuildText(text, fontPx, textWidth, (SolidColorBrush)_idleDim);
        var sung = BuildText(text, fontPx, textWidth, (SolidColorBrush)_idleLit);
        var clip = new RectangleGeometry(new Rect(0, 0, 0, _cardHeight));
        sung.Clip = clip;

        var grid = new Grid();
        grid.Children.Add(dim);
        grid.Children.Add(sung);

        var scale = new ScaleTransform(1, 1);
        var rotate = new RotateTransform();
        var group = new TransformGroup();
        group.Children.Add(scale);
        group.Children.Add(rotate);

        var root = new Border
        {
            Width = _fanWidth,
            Height = _cardHeight,
            CornerRadius = new CornerRadius(Math.Min(13, _cardHeight / 2)),
            Padding = new Thickness(CardPadX, 0, CardPadX, 0),
            BorderThickness = new Thickness(1),
            BorderBrush = _cardEdge,
            Background = _cardFill,
            RenderTransformOrigin = new Point(0.5, 0.5),
            RenderTransform = group,
            Child = grid,
            Visibility = Visibility.Collapsed,
        };

        return new FanCard(root, dim, sung, clip, scale, rotate, textWidth);
    }

    private TextBlock BuildText(string text, double fontPx, double width, SolidColorBrush brush) => new()
    {
        Text = text,
        FontFamily = LyricFont,
        FontSize = fontPx,
        FontWeight = ResolveWeight(_weight),
        Foreground = brush,
        Width = width,
        HorizontalAlignment = HorizontalAlignment.Left,
        VerticalAlignment = VerticalAlignment.Center,
        TextWrapping = TextWrapping.NoWrap,
        IsHitTestVisible = false,
    };

    private (string Text, double Width, double FontPx) FitLine(string text)
    {
        text ??= string.Empty;
        var available = Math.Max(24, _fanWidth - CardPadX * 2 - 2);
        for (var font = _fontPx; font >= 9.0; font -= 0.5)
        {
            var width = MeasureWidth(text, font);
            if (width <= available)
            {
                return (text, width, font);
            }
        }

        var floorWidth = MeasureWidth(text, 9.0);
        if (floorWidth <= available)
        {
            return (text, floorWidth, 9.0);
        }

        var trimmed = text;
        while (trimmed.Length > 1 && MeasureWidth(trimmed + "…", 9.0) > available)
        {
            trimmed = trimmed[..^1];
        }

        var clipped = trimmed.Length < text.Length ? trimmed + "…" : trimmed;
        return (clipped, MeasureWidth(clipped, 9.0), 9.0);
    }

    private double MeasureWidth(string text, double fontPx)
    {
        if (string.IsNullOrEmpty(text))
        {
            return 0;
        }

        var formatted = new FormattedText(
            text,
            CultureInfo.CurrentUICulture,
            FlowDirection.LeftToRight,
            new Typeface(LyricFont, FontStyles.Normal, ResolveWeight(_weight), FontStretches.Normal),
            fontPx,
            Brushes.White,
            PixelsPerDip);
        return formatted.WidthIncludingTrailingWhitespace;
    }

    private double _pixelsPerDip;

    private double PixelsPerDip
    {
        get
        {
            if (_pixelsPerDip <= 0)
            {
                var dpi = VisualTreeHelper.GetDpi(this).PixelsPerDip;
                _pixelsPerDip = dpi > 0 ? dpi : 1;
            }

            return _pixelsPerDip;
        }
    }

    // ── 渲染 ────────────────────────────────────────────────────────────────

    private void OnIsVisibleChanged(object sender, DependencyPropertyChangedEventArgs e)
    {
        if (e.NewValue is true)
        {
            _revealT = 0;
            StartRendering();
        }
        else
        {
            StopRendering();
        }
    }

    private void StartRendering()
    {
        if (_rendering || !IsVisible)
        {
            return;
        }

        _rendering = true;
        _lastFrameSeconds = _clock.Elapsed.TotalSeconds;
        _frameTimer.Start();
    }

    private void StopRendering()
    {
        if (!_rendering)
        {
            return;
        }

        _rendering = false;
        _frameTimer.Stop();
    }

    private void OnFrameTick()
    {
        var now = _clock.Elapsed.TotalSeconds;
        var delta = now - _lastFrameSeconds;
        if (delta <= 0)
        {
            return;
        }

        _lastFrameSeconds = now;
        delta = Math.Min(delta, 0.25);
        if (!_hasFrame)
        {
            return;
        }

        if (_playing)
        {
            _sincePush = Math.Min(MaxExtrapolationSeconds, _sincePush + delta);
        }

        if (_anchorT < 1)
        {
            _anchorT = Math.Min(1, _anchorT + delta * 1000 / RollMs);
        }

        var revealTotal = (RevealMs + _visibleLines * StaggerMs) / 1000;
        if (_revealT < 1)
        {
            _revealT = Math.Min(1, _revealT + delta / revealTotal);
        }

        Paint();

        var busy = (_playing && _hasFrame) || _revealT < 1 || _anchorT < 1;
        var interval = busy ? 16 : 125;
        if (Math.Abs(_frameTimer.Interval.TotalMilliseconds - interval) > 1)
        {
            _frameTimer.Interval = TimeSpan.FromMilliseconds(interval);
        }
    }

    private void Paint()
    {
        var anchor = AnchorNow();
        var positionMs = CurrentPositionMs();

        foreach (var (index, card) in _cards)
        {
            var slot = anchor + _leadSlot - index;
            if (slot < -1.05 || slot > _visibleLines - 1 + 1.05)
            {
                card.Root.Visibility = Visibility.Collapsed;
                continue;
            }

            var lower = Math.Floor(slot);
            var fraction = slot - lower;
            var (x0, y0, rot0) = SlotPlacement(lower);
            var (x1, y1, rot1) = SlotPlacement(lower + 1);
            var x = x0 + (x1 - x0) * fraction;
            var y = y0 + (y1 - y0) * fraction;
            var rotation = rot0 + (rot1 - rot0) * fraction;
            var alpha0 = SlotAlpha(lower);
            var alpha = alpha0 + (SlotAlpha(lower + 1) - alpha0) * fraction;
            var reveal = RevealFactor(slot);
            alpha *= reveal;
            if (alpha <= 0.012)
            {
                card.Root.Visibility = Visibility.Collapsed;
                continue;
            }

            ApplyCardLook(card, index == _currentIndex);

            var scale = CollapsedScale + (1 - CollapsedScale) * reveal;
            card.Scale.ScaleX = scale;
            card.Scale.ScaleY = scale;
            card.Rotate.Angle = rotation;
            card.Root.Opacity = Math.Clamp(alpha, 0, 1);
            card.Root.Visibility = Visibility.Visible;

            var left = _anchorX + x - _fanWidth / 2;
            var top = _anchorY + y - _cardHeight / 2;
            Canvas.SetLeft(card.Root, left);
            Canvas.SetTop(card.Root, top);
        }

        if (_cards.TryGetValue(_currentIndex, out var active) && _lines.TryGetValue(_currentIndex, out var activeLine))
        {
            var percent = CutPercent(activeLine, positionMs);
            if (Math.Abs(percent - active.CutPercent) > 0.25)
            {
                active.CutPercent = percent;
                active.Clip.Rect = new Rect(0, 0, active.TextWidth * percent / 100, _cardHeight);
                HostLog.Info($"[lyrics] cut pct={percent:0.0} pos={positionMs:0} start={activeLine.StartMs:0} end={activeLine.EndMs:0} words={activeLine.Words.Count} w0={activeLine.Words[0].StartMs:0}-{activeLine.Words[0].EndMs:0} wl={activeLine.Words[^1].StartMs:0}-{activeLine.Words[^1].EndMs:0} textW={active.TextWidth:0.0} idx={_currentIndex}");
            }
        }

    }

    private static double CutPercent(DesktopLyricLine line, double positionMs)
    {
        if (line.Words.Count > 0)
        {
            var total = 0d;
            var sung = 0d;
            foreach (var word in line.Words)
            {
                var length = Math.Max(1, word.Text?.Length ?? 1);
                total += length;
                if (positionMs >= word.EndMs)
                {
                    sung += length;
                    continue;
                }

                if (positionMs <= word.StartMs)
                {
                    break;
                }

                sung += length * Math.Clamp((positionMs - word.StartMs) / Math.Max(1, word.EndMs - word.StartMs), 0, 1);
                break;
            }

            return total <= 0 ? 0 : Math.Clamp(sung / total, 0, 1) * 100;
        }

        if (line.DurationMs <= 0)
        {
            return 0;
        }

        return Math.Clamp((positionMs - line.StartMs) / line.DurationMs, 0, 1) * 100;
    }

    // ── 窗口与交互 ──────────────────────────────────────────────────────────

    private void ApplyWindowChrome()
    {
        // 命中区先落定：即使窗口句柄还没建好，样式与画布底也要一致。
        // 未锁定铺 1/255 黑（整窗恒为命中矩形，避免逐像素 alpha 命中随动画翻转）；
        // 锁定时清空，配合 WS_EX_TRANSPARENT 让整窗完全穿透。
        Stage.Background = _locked ? null : HitTestFill;

        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero)
        {
            return;
        }

        var style = NativeMethods.GetWindowLong(handle, GwlExStyle);
        style |= WsExToolWindow | WsExNoActivate;
        if (_locked)
        {
            style |= WsExTransparent;
        }
        else
        {
            style &= ~WsExTransparent;
        }

        NativeMethods.SetWindowLong(handle, GwlExStyle, style);
    }

    /// <summary>按「底色浓度」重算三种卡片外观：普通卡、当前句强调卡、以及两层文字颜色。</summary>
    private void RefreshCardBrushes()
    {
        var strength = Math.Clamp(_backdrop / 100d, 0.3, 0.9);
        var fillAlpha = (byte)Math.Round(255 * (0.40 + strength * 0.42));
        _cardFill = new SolidColorBrush(Color.FromArgb(fillAlpha, 0x0B, 0x0E, 0x16));
        _cardEdge = new SolidColorBrush(Color.FromArgb(0x24, 0xFF, 0xFF, 0xFF));

        var accent = Color.FromRgb(0xD9, 0xC0, 0x8D);
        var accentStrong = Color.FromRgb(0xEC, 0xD9, 0xAC);
        var gradient = new LinearGradientBrush(accentStrong, accent, new Point(0, 0), new Point(1, 1));
        gradient.Freeze();
        _activeFill = gradient;
        _activeEdge = new SolidColorBrush(Color.FromArgb(0x3D, 0xFF, 0xFF, 0xFF));

        // 非当前句不做卡拉OK，两层同色，层次交给整卡透明度；当前句用「墨色由浅到实」的擦除。
        _idleDim = new SolidColorBrush(Color.FromArgb(0xF0, 0xFF, 0xFF, 0xFF));
        _idleLit = new SolidColorBrush(Color.FromArgb(0xF0, 0xFF, 0xFF, 0xFF));
        _activeDim = new SolidColorBrush(Color.FromArgb(0x8C, 0x11, 0x12, 0x18));
        _activeLit = new SolidColorBrush(Color.FromArgb(0xFF, 0x11, 0x12, 0x18));
    }

    private void ApplyCardLook(FanCard card, bool active)
    {
        if (card.Active == active)
        {
            return;
        }

        card.Active = active;
        card.Root.Background = active ? _activeFill : _cardFill;
        card.Root.BorderBrush = active ? _activeEdge : _cardEdge;
        card.Base.Foreground = active ? _activeDim : _idleDim;
        card.Sung.Foreground = active ? _activeLit : _idleLit;
    }

    private void OnDragStart(object sender, MouseButtonEventArgs e)
    {
        if (_locked)
        {
            return;
        }

        _dragging = true;
        _dragOrigin = e.GetPosition(this);
        _dragLeft = Left;
        _dragTop = Top;
        CaptureMouse();
    }

    private void OnDragMove(object sender, MouseEventArgs e)
    {
        if (!_dragging)
        {
            return;
        }

        var point = e.GetPosition(this);
        Left = _dragLeft + point.X - _dragOrigin.X;
        Top = _dragTop + point.Y - _dragOrigin.Y;
    }

    private void OnDragEnd(object sender, MouseButtonEventArgs e)
    {
        if (!_dragging)
        {
            return;
        }

        _dragging = false;
        ReleaseMouseCapture();
        ClampIntoWorkArea();
    }

    private void OnRightClick(object sender, MouseButtonEventArgs e)
    {
        if (_locked)
        {
            return;
        }

        var menu = new ContextMenu { PlacementTarget = this };
        var style = new MenuItem { Header = "样式" };
        style.Items.Add(MakeStyleItem("经典三行", "classic", false));
        style.Items.Add(MakeStyleItem("悬浮扇形", "fan", true));
        menu.Items.Add(style);

        var lines = new MenuItem { Header = $"行数　{_fanLines}" };
        lines.Items.Add(MakeItem("减少一行", () => SetFanLines(-1)));
        lines.Items.Add(MakeItem("增加一行", () => SetFanLines(1)));
        menu.Items.Add(lines);

        var width = new MenuItem { Header = $"卡片宽度　{_fanWidth} px" };
        width.Items.Add(MakeItem("更窄", () => SetFanWidth(-20)));
        width.Items.Add(MakeItem("更宽", () => SetFanWidth(20)));
        menu.Items.Add(width);

        menu.Items.Add(new Separator());
        menu.Items.Add(MakeItem(_locked ? "解锁（允许拖动）" : "锁定（鼠标穿透）", () => SetLocked(!_locked)));
        menu.Items.Add(MakeItem(_topmost ? "取消置顶" : "保持置顶", ToggleTopmost));
        menu.Items.Add(MakeItem("回到默认位置", PlaceDefault));
        menu.Items.Add(new Separator());
        menu.Items.Add(MakeItem("关闭桌面歌词", Close));
        menu.IsOpen = true;
        e.Handled = true;
    }

    private MenuItem MakeStyleItem(string header, string style, bool current)
    {
        var item = new MenuItem { Header = header, IsCheckable = true, IsChecked = current, StaysOpenOnClick = false };
        item.Click += (_, _) => PersistField("desktopLyricsStyle", $"\"{style}\"");
        return item;
    }

    private static MenuItem MakeItem(string header, Action action)
    {
        var item = new MenuItem { Header = header };
        item.Click += (_, _) => action();
        return item;
    }

    private void SetFanLines(int delta)
    {
        _fanLines = Math.Clamp(_fanLines + delta, 5, 15);
        PersistField("desktopLyricsFanLines", _fanLines.ToString(CultureInfo.InvariantCulture));
        RebuildGeometry();
        ClearCards();
        RebuildCards();
    }

    private void SetFanWidth(int delta)
    {
        _fanWidth = Math.Clamp(_fanWidth + delta, 180, 360);
        PersistField("desktopLyricsFanWidth", _fanWidth.ToString(CultureInfo.InvariantCulture));
        RebuildGeometry();
        ClearCards();
        RebuildCards();
    }

    private void ToggleTopmost()
    {
        _topmost = !_topmost;
        Topmost = _topmost;
        PersistField("desktopLyricsTopmost", _topmost ? "true" : "false");
    }

    private void PersistField(string name, string rawValue)
    {
        if (_settings is null)
        {
            return;
        }

        try
        {
            var json = $"{{\"general\":{{\"{name}\":{rawValue}}}}}";
            using var document = JsonDocument.Parse(json);
            _settings.Patch(document.RootElement);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[lyrics] persist fan style failed: {exception.Message}");
        }
    }

    private static string NormalizeWeight(string? weight) => weight switch
    {
        "bold" => "bold",
        "semibold" => "semibold",
        _ => "normal",
    };

    private static FontWeight ResolveWeight(string weight) => weight switch
    {
        "bold" => FontWeights.Bold,
        "semibold" => FontWeights.SemiBold,
        _ => FontWeights.Normal,
    };

    /// <summary>一张卡＝一句歌词：亮暗两层同度量文字 + 一个裁剪矩形（卡拉 OK）。</summary>
    private sealed class FanCard
    {
        public FanCard(Border root, TextBlock @base, TextBlock sung, RectangleGeometry clip, ScaleTransform scale, RotateTransform rotate, double textWidth)
        {
            Root = root;
            Base = @base;
            Sung = sung;
            Clip = clip;
            Scale = scale;
            Rotate = rotate;
            TextWidth = textWidth;
        }

        public Border Root { get; }

        public TextBlock Base { get; }

        public bool Active { get; set; }

        public TextBlock Sung { get; }

        public RectangleGeometry Clip { get; }

        public ScaleTransform Scale { get; }

        public RotateTransform Rotate { get; }

        public double TextWidth { get; }

        public double CutPercent { get; set; } = -1;
    }
}
