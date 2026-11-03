using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using Zilux2.Interop;

namespace Zilux2;

/// <summary>
/// 桌面歌词：无边框、置顶、半透明的一个小窗口，拖动窗口本体即可移动。
/// 锁定后加 WS_EX_TRANSPARENT 让鼠标穿透（游戏/其它窗口点得穿），右键菜单可解锁。
/// </summary>
public partial class DesktopLyricsWindow : Window
{
    private const int GwlExStyle = -20;
    private const int WsExTransparent = 0x20;
    private const int WsExNoActivate = 0x08000000;

    private int _fontSize = 40;
    private bool _locked;
    private bool _topmost = true;

    public DesktopLyricsWindow()
    {
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
    }

    private void ToggleLocked()
    {
        _locked = !_locked;
        ApplyClickThrough();
    }

    private void ToggleTopmost()
    {
        _topmost = !_topmost;
        Topmost = _topmost;
    }
}
