using System;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using Zilux2.Interop;
using Zilux2.Settings;

namespace Zilux2;

/// <summary>
/// 桌面歌词：无边框、置顶、半透明的一个小窗口，拖动窗口本体即可移动。
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

    internal DesktopLyricsWindow(SettingsService? settings = null)
    {
        _settings = settings;
        InitializeComponent();
        SourceInitialized += (_, _) => ApplyClickThrough();
        Closed += (_, _) => ClosedByUser?.Invoke();
    }

    /// <summary>用户从右键菜单关掉窗口时通知宿主把设置里的开关也关掉。</summary>
    public event Action? ClosedByUser;

    public void UpdateLines(string now, string translation)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(() => UpdateLines(now, translation)));
            return;
        }

        NowText.Text = string.IsNullOrWhiteSpace(now) ? "♪" : now;
        var hasTranslation = !string.IsNullOrWhiteSpace(translation);
        TranslationText.Text = translation ?? string.Empty;
        TranslationText.Visibility = hasTranslation ? Visibility.Visible : Visibility.Collapsed;
        // 单行歌词时窗口收紧一些，别留一大块空白。
        Height = hasTranslation ? 150 : 112;
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
        NowText.FontSize = _fontSize;
        NowText.FontWeight = weight switch
        {
            "bold" => FontWeights.Bold,
            "semibold" => FontWeights.SemiBold,
            _ => FontWeights.Normal,
        };
        TranslationText.FontSize = Math.Max(12, Math.Round(_fontSize * 0.45));
        var alpha = (byte)Math.Round(Math.Clamp(backdropOpacity, 30, 90) / 100d * 255);
        Shell.Background = new SolidColorBrush(Color.FromArgb(alpha, 0, 0, 0));
        Topmost = topmost;
        ApplyClickThrough();
    }

    public void PlaceDefault()
    {
        var area = SystemParameters.WorkArea;
        Left = Math.Max(0, (area.Width - Width) / 2);
        Top = Math.Max(0, area.Bottom - Height - 96);
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
        NowText.FontSize = _fontSize;
        TranslationText.FontSize = Math.Max(12, Math.Round(_fontSize * 0.45));
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
