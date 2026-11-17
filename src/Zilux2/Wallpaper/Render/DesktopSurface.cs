using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Threading;
using Zilux2;

namespace Zilux2.Wallpaper.Render;

/// <summary>
/// 桌面层画布（规格书 §5.5 / 第 24–26、35 轮）：一个无边框窗口，内容是和软件内层同一套
/// <see cref="WallpaperCanvasSurface"/>，创建后把 HWND 挂到 WorkerW 上，于是它铺在桌面图标下面。
///
/// 自愈：资源管理器重启会让 WorkerW 句柄失效，定时器发现父窗口不对就重建一次，
/// 失败不抛到主程序（第 35 轮 C：崩了自动重建，不拖垮主程序）。
/// </summary>
internal sealed partial class DesktopSurface : IDisposable
{
    private readonly Window _window;
    private readonly WallpaperCanvasSurface _surface;
    private readonly DispatcherTimer _health;
    private readonly Grid _stage;
    private readonly TextBlock _overlay;
    private readonly DispatcherTimer _overlayTimer;
    private string _overlayTemplate = "{time}";
    private IntPtr _workerW;
    private bool _disposed;

    public DesktopSurface()
    {
        _surface = new WallpaperCanvasSurface();

        // 叠层（第 23 轮 D / 第 76 轮 E）：桌面层没有页面可用，文字由这里画。
        _overlay = new TextBlock
        {
            HorizontalAlignment = System.Windows.HorizontalAlignment.Right,
            VerticalAlignment = System.Windows.VerticalAlignment.Bottom,
            Margin = new Thickness(0, 0, 48, 132),
            Padding = new Thickness(18, 8, 18, 8),
            FontSize = 44,
            Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromArgb(245, 255, 255, 255)),
            Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromArgb(120, 10, 11, 14)),
            Visibility = Visibility.Collapsed,
            IsHitTestVisible = false,
            Text = string.Empty,
        };

        _stage = new Grid();
        _stage.Children.Add(_surface.Root);
        _stage.Children.Add(_overlay);

        _overlayTimer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromSeconds(1) };
        _overlayTimer.Tick += (_, _) => RenderOverlay();

        _window = new Window
        {
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            ShowInTaskbar = false,
            ShowActivated = false,
            AllowsTransparency = false,
            Background = System.Windows.Media.Brushes.Black,
            WindowStartupLocation = WindowStartupLocation.Manual,
            Left = 0,
            Top = 0,
            Width = SystemParameters.PrimaryScreenWidth,
            Height = SystemParameters.PrimaryScreenHeight,
            Content = _stage,
            Focusable = false,
        };

        // 桌面层不需要被点到，挂上去以后由桌面消息循环处理。
        _window.IsHitTestVisible = false;

        _health = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromSeconds(5),
        };
        _health.Tick += (_, _) => Verify();
    }

    public WallpaperCanvasSurface Surface => _surface;

    /// <summary>叠层开关与模板（模板占位符见 RenderOverlay）。</summary>
    public void ApplyOverlay(bool enabled, string? template)
    {
        _overlayTemplate = string.IsNullOrWhiteSpace(template) ? "{time}" : template!;
        _overlay.Visibility = enabled ? Visibility.Visible : Visibility.Collapsed;
        if (enabled)
        {
            RenderOverlay();
            _overlayTimer.Start();
        }
        else
        {
            _overlayTimer.Stop();
        }
    }

    /// <summary>把 {time} {date} {weekday} 这些占位符换成当前时间。</summary>
    private void RenderOverlay()
    {
        var now = DateTime.Now;
        var text = _overlayTemplate
            .Replace("{time}", now.ToString("HH:mm"), StringComparison.Ordinal)
            .Replace("{date}", now.ToString("yyyy-MM-dd"), StringComparison.Ordinal)
            .Replace("{weekday}", "周日周一周二周三周四周五周六".Substring(now.DayOfWeek == DayOfWeek.Sunday ? 0 : (int)now.DayOfWeek * 2, 2), StringComparison.Ordinal)
            .Replace("{year}", now.Year.ToString(), StringComparison.Ordinal)
            .Replace("{month}", now.Month.ToString("00"), StringComparison.Ordinal)
            .Replace("{day}", now.Day.ToString("00"), StringComparison.Ordinal);

        if (_overlay.Text != text) _overlay.Text = text;
    }

    public bool IsAttached => _workerW != IntPtr.Zero;

    /// <summary>挂到桌面。窗口必须先 Show 一次才有 HWND，所以内部自己管显示。</summary>
    public bool Attach()
    {
        if (_disposed) return false;

        try
        {
            if (_window.IsVisible == false)
            {
                _window.Show();
            }

            var handle = new WindowInteropHelper(_window).Handle;
            if (handle == IntPtr.Zero) return false;

            var worker = WorkerWLocator.Find();
            if (worker == IntPtr.Zero) return false;

            if (!WorkerWLocator.Attach(handle, worker)) return false;

            _workerW = worker;
            _surface.SetVisible(true);
            _health.Start();
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>摘下来（不销毁窗口，方便再次接管）。</summary>
    public void Detach()
    {
        _health.Stop();
        _overlayTimer.Stop();
        _surface.SetVisible(false);

        try
        {
            var handle = new WindowInteropHelper(_window).Handle;
            WorkerWLocator.Detach(handle);
        }
        catch
        {
            // 句柄可能已经随窗口销毁。
        }

        _workerW = IntPtr.Zero;
    }

    /// <summary>覆盖到指定屏幕尺寸（第 25 轮多显示器 / 第 89 轮显示变化）。</summary>
    public void ResizeTo(int width, int height)
    {
        if (_disposed || width <= 0 || height <= 0) return;
        try
        {
            _window.Width = width;
            _window.Height = height;
            var handle = new WindowInteropHelper(_window).Handle;
            if (handle != IntPtr.Zero)
            {
                WorkerWLocator.Attach(handle, _workerW == IntPtr.Zero ? WorkerWLocator.Find() : _workerW);
            }
        }
        catch
        {
            // 显示切换期间句柄可能短暂不可用，下一轮自愈会补上。
        }
    }

    /// <summary>父窗口还在不在；不在就重建（资源管理器重启 / 显示变化后）。</summary>
    private void Verify()
    {
        if (_disposed) return;

        try
        {
            var handle = new WindowInteropHelper(_window).Handle;
            if (handle == IntPtr.Zero) return;

            var parent = GetParent(handle);
            if (parent != IntPtr.Zero && parent == _workerW) return;

            // 父窗口变了或丢了，重新找一次 WorkerW 挂上。
            var worker = WorkerWLocator.Find();
            if (worker == IntPtr.Zero) return;

            if (WorkerWLocator.Attach(handle, worker))
            {
                _workerW = worker;
            }
        }
        catch
        {
            // 自愈失败不抛，等下一轮。
        }
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr hWnd);

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        try
        {
            _health.Stop();
        }
        catch
        {
            // 忽略：Dispatcher 可能已经结束。
        }

        Detach();
        _surface.Dispose();

        try
        {
            _window.Content = null;
            _window.Close();
        }
        catch
        {
            // 窗口可能已经关闭。
        }
    }
}
