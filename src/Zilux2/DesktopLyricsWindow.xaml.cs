using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using Zilux2.Interop;
using Zilux2.Settings;

namespace Zilux2;

public readonly record struct DesktopLyricWord(string Text, bool SpaceBefore);

/// <summary>
/// 桌面歌词：与关闭播放效果时的歌词页保持相同的左对齐三行层级。
/// 三行使用各自唯一的文字控件连续移动，逐词强调使用独立的缩放与位移。
/// 锁定后整窗加 WS_EX_TRANSPARENT 让鼠标真正穿透到其它应用；解锁入口只有
/// 托盘菜单「解锁桌面歌词」和设置页（锁定态右键菜单同样点不到）。
/// </summary>
public partial class DesktopLyricsWindow : Window
{
    private const int GwlExStyle = -20;
    private const int WsExTransparent = 0x20;
    private const int WsExNoActivate = 0x08000000;

    private readonly SettingsService? _settings;
    private int _fontSize = 40;
    private bool _locked;
    private bool _topmost = true;
    private string _currentNow = "桌面歌词";
    private string _currentTranslation = string.Empty;
    private string _currentPrevious = string.Empty;
    private string _currentNext = string.Empty;
    private int _activeWord = -1;
    private string _wordSourceKey = string.Empty;
    private readonly List<TextBlock?> _wordBlocks = new();

    internal DesktopLyricsWindow(SettingsService? settings = null)
    {
        _settings = settings;
        InitializeComponent();
        SourceInitialized += (_, _) => ApplyClickThrough();
        Closed += (_, _) => ClosedByUser?.Invoke();
    }

    /// <summary>用户从右键菜单关掉窗口时通知宿主把设置里的开关也关掉。</summary>
    public event Action? ClosedByUser;

    public void UpdateLines(string now, string translation, string previous = "", string next = "",
        IReadOnlyList<DesktopLyricWord>? words = null, int activeWord = -1)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => UpdateLines(now, translation, previous, next, words, activeWord)));
            return;
        }

        now = string.IsNullOrWhiteSpace(now) ? "♪" : now.Trim();
        translation = translation?.Trim() ?? string.Empty;
        previous = previous?.Trim() ?? string.Empty;
        next = next?.Trim() ?? string.Empty;
        var wordKeyBuilder = new StringBuilder();
        if (words is not null)
            foreach (var word in words) wordKeyBuilder.Append(word.SpaceBefore ? ' ' : '\u001f').Append(word.Text).Append('\u001e');
        var wordKey = wordKeyBuilder.ToString();
        if (now == _currentNow && translation == _currentTranslation &&
            previous == _currentPrevious && next == _currentNext &&
            activeWord == _activeWord && wordKey == _wordSourceKey) return;

        var lineChanged = now != _currentNow;
        var translationChanged = translation != _currentTranslation;
        var layoutChanged = lineChanged || translationChanged || wordKey != _wordSourceKey ||
            previous != _currentPrevious || next != _currentNext;
        var forward = lineChanged && IsLoaded && _currentNext == now && _currentNow == previous;
        var fromCurrent = IsLoaded ? NowText.TranslatePoint(new Point(), LyricStage) : new Point();
        var fromNext = IsLoaded ? NextText.TranslatePoint(new Point(), LyricStage) : new Point();
        if (lineChanged)
        {
            ResetLineTransforms();
            _currentNow = now;
            _wordSourceKey = wordKey;
            SetWordLine(now, words);
        }
        else if (wordKey != _wordSourceKey)
        {
            _wordSourceKey = wordKey;
            SetWordLine(now, words);
        }

        _currentTranslation = translation;
        _currentPrevious = previous;
        _currentNext = next;
        TranslationText.Text = translation;
        TranslationText.Opacity = translation.Length > 0 ? 1 : 0;
        SetContext(PreviousText, previous);
        SetContext(NextText, next);
        UpdateActiveWord(activeWord);
        if (layoutChanged) FitContent();
        if (lineChanged)
        {
            UpdateLayout();
            var toCurrent = NowText.TranslatePoint(new Point(), LyricStage);
            var toPrevious = PreviousText.TranslatePoint(new Point(), LyricStage);
            if (forward)
            {
                Move(CurrentScale, CurrentShift, NextText.FontSize / _fontSize,
                    fromNext.X - toCurrent.X, fromNext.Y - toCurrent.Y);
                var previousMeasure = new TextBlock { Text = previous, FontSize = _fontSize, FontWeight = NowText.FontWeight };
                previousMeasure.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
                var previousRatio = previousMeasure.DesiredSize.Width <= LineStage.ActualWidth - 64
                    ? _fontSize / PreviousText.FontSize : 1;
                Move(PreviousScale, PreviousShift, previousRatio,
                    fromCurrent.X - toPrevious.X, fromCurrent.Y - toPrevious.Y);
                var brush = new SolidColorBrush(Colors.White);
                PreviousText.Foreground = brush;
                brush.BeginAnimation(SolidColorBrush.ColorProperty,
                    new ColorAnimation(Colors.White, Color.FromArgb(153, 255, 255, 255), TimeSpan.FromMilliseconds(320)));
            }
            else
            {
                Motion(CurrentShift, TranslateTransform.YProperty, 8, 0, 220);
            }
            Motion(CurrentLine, OpacityProperty, forward ? 0.6 : 0.75, 1, 260);
            if (next.Length > 0)
            {
                Motion(NextShift, TranslateTransform.YProperty, 16, 0, 320);
                Motion(NextText, OpacityProperty, 0, 1, 280);
            }
            if (NowText.Effect is DropShadowEffect glow)
                Motion(glow, DropShadowEffect.OpacityProperty, 0, 0.28, 280);
        }
        if ((lineChanged || translationChanged) && translation.Length > 0)
        {
            Motion(TranslationText, OpacityProperty, 0, 1, 240);
            Motion(TranslationShift, TranslateTransform.YProperty, 6, 0, 260);
        }
    }

    private void ResetLineTransforms()
    {
        foreach (var transform in new[] { CurrentShift, PreviousShift, NextShift, TranslationShift })
        {
            transform.BeginAnimation(TranslateTransform.XProperty, null);
            transform.BeginAnimation(TranslateTransform.YProperty, null);
            transform.X = transform.Y = 0;
        }
        foreach (var scale in new[] { CurrentScale, PreviousScale })
        {
            scale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
            scale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
            scale.ScaleX = scale.ScaleY = 1;
        }
        CurrentLine.BeginAnimation(OpacityProperty, null);
        NextText.BeginAnimation(OpacityProperty, null);
        TranslationText.BeginAnimation(OpacityProperty, null);
        CurrentLine.Opacity = 1;
    }

    private static void Move(ScaleTransform scale, TranslateTransform shift, double ratio, double x, double y)
    {
        Motion(scale, ScaleTransform.ScaleXProperty, ratio, 1, 320);
        Motion(scale, ScaleTransform.ScaleYProperty, ratio, 1, 320);
        Motion(shift, TranslateTransform.XProperty, x, 0, 320);
        Motion(shift, TranslateTransform.YProperty, y, 0, 320);
    }

    private static void Motion(DependencyObject target, DependencyProperty property, double from, double to,
        int duration, bool bounce = false)
    {
        var animation = new DoubleAnimation(from, to, TimeSpan.FromMilliseconds(duration))
        {
            EasingFunction = bounce
                ? new BackEase { Amplitude = 0.25, EasingMode = EasingMode.EaseOut }
                : new CubicEase { EasingMode = EasingMode.EaseOut },
            FillBehavior = FillBehavior.Stop,
        };
        target.SetValue(property, to);
        if (target is UIElement element) element.BeginAnimation(property, animation);
        else if (target is Animatable animatable) animatable.BeginAnimation(property, animation);
    }

    private void SetWordLine(string line, IReadOnlyList<DesktopLyricWord>? words)
    {
        _wordBlocks.Clear();
        _activeWord = -1;
        if (words is null || words.Count == 0 || words.Count > 512)
        {
            NowText.Inlines.Clear();
            NowText.Text = line;
            return;
        }
        var canonical = CanonicalText(line, out var positions);
        var searchAt = 0;
        var displayedAt = 0;
        NowText.Inlines.Clear();
        foreach (var word in words)
        {
            var token = CanonicalText(word.Text, out _);
            var found = token.Length > 0 ? canonical.IndexOf(token, searchAt, StringComparison.Ordinal) : -1;
            if (found < 0)
            {
                _wordBlocks.Add(null);
                continue;
            }
            var start = positions[found].Start;
            var end = positions[found + token.Length - 1].End;
            if (start > displayedAt) NowText.Inlines.Add(new Run(line[displayedAt..start]));
            var transform = new TransformGroup();
            transform.Children.Add(new ScaleTransform(1, 1));
            transform.Children.Add(new TranslateTransform());
            var block = new TextBlock
            {
                Text = line[start..end],
                TextWrapping = TextWrapping.Wrap,
                MaxWidth = Math.Max(100, (Width - Shell.Padding.Left - Shell.Padding.Right - 23 - 64) / 1.18),
                FontSize = _fontSize,
                FontWeight = NowText.FontWeight,
                Foreground = Brushes.White,
                RenderTransform = transform,
                RenderTransformOrigin = new Point(0.5, 0.5),
            };
            block.Measure(new Size(block.MaxWidth, double.PositiveInfinity));
            NowText.Inlines.Add(new InlineUIContainer(block));
            _wordBlocks.Add(block);
            displayedAt = end;
            searchAt = found + token.Length;
        }
        if (displayedAt < line.Length) NowText.Inlines.Add(new Run(line[displayedAt..]));
    }

    private static string CanonicalText(string text, out List<(int Start, int End)> positions)
    {
        positions = new();
        var result = new StringBuilder();
        var elements = StringInfo.GetTextElementEnumerator(text);
        while (elements.MoveNext())
        {
            var original = elements.GetTextElement();
            var start = elements.ElementIndex;
            foreach (var c in original.Normalize(NormalizationForm.FormKC).ToLowerInvariant())
            {
                if (char.IsWhiteSpace(c) || char.IsPunctuation(c) || char.IsControl(c) ||
                    char.GetUnicodeCategory(c) == UnicodeCategory.Format) continue;
                result.Append(c);
                positions.Add((start, start + original.Length));
            }
        }
        return result.ToString();
    }

    private void UpdateActiveWord(int index, bool animate = true)
    {
        var previous = _activeWord;
        if (index == previous && animate) return;
        _activeWord = index;
        for (var i = 0; i < _wordBlocks.Count; i++)
        {
            var block = _wordBlocks[i];
            if (block is null) continue;
            if (animate && i != previous && i != index) continue;
            var hot = i == index;
            var hotScale = hot && block.DesiredSize.Height <= _fontSize * 1.8 ? 1.16 : 1;
            block.Foreground = Brushes.White;
            var transform = (TransformGroup)block.RenderTransform;
            var scale = (ScaleTransform)transform.Children[0];
            var shift = (TranslateTransform)transform.Children[1];
            if (animate)
            {
                Motion(scale, ScaleTransform.ScaleXProperty, scale.ScaleX, hotScale, hot ? 220 : 720, hot);
                Motion(scale, ScaleTransform.ScaleYProperty, scale.ScaleY, hotScale, hot ? 220 : 720, hot);
                Motion(shift, TranslateTransform.YProperty, shift.Y, hot ? -5 : 0, hot ? 220 : 720, hot);
            }
            else
            {
                scale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
                scale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
                shift.BeginAnimation(TranslateTransform.YProperty, null);
                scale.ScaleX = scale.ScaleY = hotScale;
                shift.Y = hot ? -5 : 0;
            }
        }
    }

    private static void SetContext(TextBlock block, string text)
    {
        block.Text = text;
        block.Opacity = text.Length > 0 ? 1 : 0;
    }

    public void ApplyStyle(int fontSize, bool locked, bool topmost, string weight = "normal", int backdropOpacity = 40)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => ApplyStyle(fontSize, locked, topmost, weight, backdropOpacity)));
            return;
        }

        _fontSize = Math.Clamp(fontSize, 28, 64);
        _locked = locked;
        _topmost = topmost;
        ApplyTypography(weight);
        UpdateActiveWord(_activeWord, false);
        var strength = Math.Clamp(backdropOpacity, 30, 90) / 100d;
        Shell.Background = new LinearGradientBrush(
            new GradientStopCollection
            {
                new(Color.FromArgb((byte)Math.Round(255 * strength * 0.68), 7, 10, 18), 0),
                new(Color.FromArgb((byte)Math.Round(255 * strength * 0.40), 7, 10, 18), 0.52),
                new(Color.FromArgb(0, 7, 10, 18), 1),
            },
            new Point(0, 0), new Point(1, 0));
        Topmost = topmost;
        ApplyClickThrough();
    }

    private void ApplyTypography(string weight)
    {
        NowText.FontSize = _fontSize;
        NowText.FontWeight = weight switch
        {
            "bold" => FontWeights.Bold,
            "semibold" => FontWeights.SemiBold,
            _ => FontWeights.Normal,
        };
        foreach (var block in _wordBlocks)
        {
            if (block is null) continue;
            block.FontSize = _fontSize;
            block.FontWeight = NowText.FontWeight;
        }
        TranslationText.FontSize = Math.Max(16, Math.Round(_fontSize * 0.54));
        PreviousText.FontSize = Math.Max(16, Math.Round(_fontSize * 0.58));
        NextText.FontSize = PreviousText.FontSize;
        PreviousText.FontWeight = NowText.FontWeight;
        NextText.FontWeight = NowText.FontWeight;
        NowText.MaxHeight = double.PositiveInfinity;
        TranslationText.MaxHeight = double.PositiveInfinity;
        ActiveMark.Height = Math.Clamp(_fontSize * 1.4 + 20, 60, 110);
        FitContent();
    }

    private void FitContent()
    {
        var width = Math.Max(100, Width - Shell.Padding.Left - Shell.Padding.Right);
        CurrentLine.Measure(new Size(width - 23, double.PositiveInfinity));
        PreviousText.Measure(new Size(width, double.PositiveInfinity));
        NextText.Measure(new Size(width, double.PositiveInfinity));
        LineStage.Height = Math.Max(Math.Clamp(_fontSize * 3.2 + 20, 130, 240), CurrentLine.DesiredSize.Height + 16);
        Height = LineStage.Height + Math.Max(38, PreviousText.DesiredSize.Height) +
            Math.Max(38, NextText.DesiredSize.Height) + Shell.Padding.Top + Shell.Padding.Bottom;
        var area = SystemParameters.WorkArea;
        if (IsLoaded && Left >= area.Left && Left < area.Right && Top >= area.Top && Top < area.Bottom)
            Top = Math.Clamp(Top, area.Top, Math.Max(area.Top, area.Bottom - Height));
    }

    public void PlaceDefault()
    {
        var area = SystemParameters.WorkArea;
        Left = area.Left + Math.Max(0, (area.Width - Width) / 2);
        Top = Math.Max(area.Top, area.Bottom - Height - 96);
    }

    private void ApplyClickThrough()
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero)
        {
            return;
        }

        var style = NativeMethods.GetWindowLong(handle, GwlExStyle);
        if (_locked)
        {
            // 锁定态整窗 WS_EX_TRANSPARENT：鼠标完全穿透，不吞其它应用的点击；
            // 解锁只能走托盘菜单或设置页（P2-03 方案 A）。
            style |= WsExTransparent | WsExNoActivate;
        }
        else
        {
            style &= ~(WsExTransparent | WsExNoActivate);
        }

        NativeMethods.SetWindowLong(handle, GwlExStyle, style);
    }

    private void OnShellMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (_locked)
        {
            return;
        }

        if (e.ButtonState == MouseButtonState.Pressed)
        {
            DragMove();
        }
    }

    private void OnShellRightClick(object sender, MouseButtonEventArgs e)
    {
        if (_locked)
        {
            return;
        }

        var menu = new ContextMenu();
        var fontMenu = new MenuItem { Header = $"字号（{_fontSize}）" };
        fontMenu.Items.Add(MakeItem("缩小", () => SetFontSize(-4)));
        fontMenu.Items.Add(MakeItem("放大", () => SetFontSize(4)));
        menu.Items.Add(fontMenu);
        menu.Items.Add(MakeItem(_locked ? "解锁（允许拖动）" : "锁定（鼠标穿透）", ToggleLocked));
        menu.Items.Add(MakeItem(_topmost ? "取消置顶" : "保持置顶", ToggleTopmost));
        menu.Items.Add(new Separator());
        menu.Items.Add(MakeItem("关闭桌面歌词", () => Close()));
        menu.PlacementTarget = Shell;
        menu.IsOpen = true;
    }

    private MenuItem MakeItem(string header, Action action)
    {
        var item = new MenuItem { Header = header };
        item.Click += (_, _) => action();
        return item;
    }

    private void SetFontSize(int delta)
    {
        _fontSize = Math.Clamp(_fontSize + delta, 28, 64);
        var weight = NowText.FontWeight == FontWeights.Bold ? "bold" :
            NowText.FontWeight == FontWeights.SemiBold ? "semibold" : "normal";
        ApplyTypography(weight);
        PersistStyle();
    }

    /// <summary>外部解除锁定：锁定时窗口鼠标穿透，右键菜单点不到，只能从托盘或设置页进入（P2-03）。</summary>
    internal void SetLocked(bool locked)
    {
        if (_locked == locked)
        {
            return;
        }

        _locked = locked;
        ApplyClickThrough();
        PersistStyle();
    }

    private void ToggleLocked()
    {
        SetLocked(!_locked);
    }

    private void ToggleTopmost()
    {
        _topmost = !_topmost;
        Topmost = _topmost;
        PersistStyle();
    }

    /// <summary>右键菜单改样式后写回设置，宿主的下一轮 ApplyStyle 才不会把它覆盖掉（B07）。</summary>
    private void PersistStyle()
    {
        if (_settings is null)
        {
            return;
        }

        try
        {
            var json =
                $"{{\"general\":{{\"desktopLyricsFontSize\":{_fontSize}," +
                $"\"desktopLyricsLocked\":{(_locked ? "true" : "false")}," +
                $"\"desktopLyricsTopmost\":{(_topmost ? "true" : "false")}}}}}";
            using var document = JsonDocument.Parse(json);
            _settings.Patch(document.RootElement);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[lyrics] persist style failed: {exception.Message}");
        }
    }
}
