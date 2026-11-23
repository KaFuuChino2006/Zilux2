using System.Drawing;
using Forms = System.Windows.Forms;

namespace Zilux2.Tray;

/// <summary>
/// 托盘图标（<see cref="Forms.NotifyIcon"/>）：左键单击显示/隐藏主窗口，右键弹出
/// <see cref="TrayMenuWindow"/>（自绘卡片菜单，替换掉 2026-11-24 之前的系统灰 ContextMenuStrip）。
///
/// 线程模型：NotifyIcon 在 WPF UI 线程上创建，它的隐藏窗口由 WPF 的消息泵分发，因此所有回调
/// 都在 UI 线程执行，可以直接调用 <see cref="MainWindow"/> 与创建 WPF 窗口，不需要额外调度。
/// 播放控制统一走页面 command 消息（MainWindow.SendCommand → WebViewHost.PostCommand），
/// 与全局热键共用同一条链路。
/// </summary>
internal sealed class TrayIconService : IDisposable
{
    private readonly MainWindow _window;
    private readonly Forms.NotifyIcon _icon;
    private readonly Icon? _ownedIcon;
    private bool _shownHint;
    private bool _disposed;
    private readonly Forms.Timer _clickTimer;

    // 菜单状态：右键才建窗口，先把状态攒在这些字段里，弹出时一次性灌进去。
    private TrayMenuWindow? _menu;
    private bool _playing;
    private string _wallpaperTitle = "未启用";
    private bool _wallpaperPaused;
    private bool _wallpaperRunning;

    public TrayIconService(MainWindow window)
    {
        _window = window;

        _ownedIcon = TryLoadProcessIcon();
        _icon = new Forms.NotifyIcon
        {
            Text = "Zilux2",
            Icon = _ownedIcon ?? SystemIcons.Application,
            Visible = false,
        };

        _icon.MouseClick += OnIconMouseClick;
        _icon.MouseUp += OnIconMouseUp;
        _clickTimer = new Forms.Timer { Interval = 250 };
        _clickTimer.Tick += OnClickTimerTick;
        _window.HiddenToTray += OnHiddenToTray;

        try
        {
            _icon.Visible = true;
            IsAvailable = true;
        }
        catch (Exception exception)
        {
            HostLog.Error("tray.start failed", exception);
            Dispose();
            return;
        }

        HostLog.Info($"tray.start icon={(_ownedIcon is not null ? "process" : "fallback")}");

        // 调试用：设 ZILUX2_TRAY_MENU_PREVIEW=1 启动，应用起来后直接把右键菜单弹在鼠标处，
        // 用来截屏核对菜单观感（和 ZILUX2_WEBVIEW_ARGS 同一类调试口子，不设就不生效）。
        if (Environment.GetEnvironmentVariable("ZILUX2_TRAY_MENU_PREVIEW") == "1")
        {
            System.Windows.Application.Current?.Dispatcher.BeginInvoke(
                new Action(() =>
                {
                    try
                    {
                        var menu = EnsureMenu();
                        menu.SyncShellVisibility(!_window.IsVisible);
                        menu.SyncPlayback(_playing);
                        menu.SyncWallpaper(_wallpaperTitle, _wallpaperPaused, _wallpaperRunning);
                        menu.ToggleAtCursor();
                    }
                    catch (Exception exception)
                    {
                        HostLog.Warn($"tray.menu preview failed: {exception.Message}");
                    }
                }),
                System.Windows.Threading.DispatcherPriority.ApplicationIdle);
        }
    }

    /// <summary>托盘图标是否真的挂上了资源管理器；失败时 App 不会保留这个实例。</summary>
    internal bool IsAvailable { get; private set; }

    private static Icon? TryLoadProcessIcon()
    {
        try
        {
            var path = Environment.ProcessPath;
            if (string.IsNullOrEmpty(path))
            {
                return null;
            }

            using var extracted = Icon.ExtractAssociatedIcon(path);
            return extracted is null ? null : (Icon)extracted.Clone();
        }
        catch (Exception exception)
        {
            HostLog.Warn($"tray.start icon failed: {exception.Message}");
            return null;
        }
    }

    private void OnIconMouseClick(object? sender, Forms.MouseEventArgs e)
    {
        if (_disposed || e.Button != Forms.MouseButtons.Left)
        {
            return;
        }

        // 单击延迟 250ms 执行「显示/隐藏」；期间第二次点击按双击处理，直接显示窗口（B23）。
        if (_clickTimer.Enabled)
        {
            _clickTimer.Stop();
            HostLog.Info("tray.click double show");
            _window.ShowFromTray();
            return;
        }

        _clickTimer.Start();
    }

    private void OnIconMouseUp(object? sender, Forms.MouseEventArgs e)
    {
        if (_disposed || e.Button != Forms.MouseButtons.Right)
        {
            return;
        }

        // 右键：自绘菜单。已经开着就收起（和系统托盘菜单的手感一致）。
        try
        {
            var menu = EnsureMenu();
            menu.SyncShellVisibility(!_window.IsVisible);
            menu.SyncPlayback(_playing);
            menu.SyncWallpaper(_wallpaperTitle, _wallpaperPaused, _wallpaperRunning);
            menu.ToggleAtCursor();
        }
        catch (Exception exception)
        {
            HostLog.Warn($"tray.menu failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private TrayMenuWindow EnsureMenu()
    {
        if (_menu is not null)
        {
            return _menu;
        }

        var menu = new TrayMenuWindow
        {
            ShowMainRequested = () => _window.ShowFromTray(),
            TogglePlayRequested = () => _window.SendCommand("togglePlay"),
            PreviousRequested = () => _window.SendCommand("prev"),
            NextRequested = () => _window.SendCommand("next"),
            ToggleWallpaperPauseRequested = () => _window.ToggleWallpaperPauseFromHotkey(),
            NextWallpaperRequested = () => _window.NextWallpaperFromHotkey(),
            UnlockLyricsRequested = () => _window.UnlockDesktopLyrics(),
            OpenSettingsRequested = () => _window.OpenSettingsFromTray(),
            ExitRequested = () => _window.CloseForReal(),
        };

        _menu = menu;
        return menu;
    }

    private void OnClickTimerTick(object? sender, EventArgs e)
    {
        _clickTimer.Stop();
        if (!_disposed)
        {
            _window.ToggleFromTray();
        }
    }

    /// <summary>壁纸状态推送：菜单里的名字与「暂停/继续」文案跟着画布走。</summary>
    internal void UpdateWallpaperState(string title, bool paused, bool running)
    {
        if (_disposed)
        {
            return;
        }

        _wallpaperTitle = title;
        _wallpaperPaused = paused;
        _wallpaperRunning = running;
        _menu?.SyncWallpaper(title, paused, running);
    }

    /// <summary>页面播放状态推送：菜单文案与播放态同步（B23）。</summary>
    internal void UpdatePlaybackState(bool playing)
    {
        if (_disposed)
        {
            return;
        }

        _playing = playing;
        _menu?.SyncPlayback(playing);
    }

    private void OnHiddenToTray(object? sender, EventArgs e)
    {
        if (_disposed)
        {
            return;
        }

        _menu?.SyncShellVisibility(true);

        if (_shownHint)
        {
            return;
        }

        _shownHint = true;
        try
        {
            _icon.BalloonTipTitle = "Zilux2 仍在后台运行";
            _icon.BalloonTipText = "音乐继续播放。单击托盘图标恢复窗口，右键可播放控制或退出。";
            _icon.BalloonTipIcon = Forms.ToolTipIcon.Info;
            _icon.ShowBalloonTip(3000);
            HostLog.Info("tray.balloon shown");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"tray.balloon failed: {exception.Message}");
        }
    }

    /// <summary>
    /// 登录状态检测（第四十六轮）：窗口在托盘/后台时，某个平台掉登录用系统气泡提醒一下。
    /// 窗口可见时前端会弹 toast，这里不重复打扰。
    /// </summary>
    public void NotifyAccountExpired(string source)
    {
        if (_disposed)
        {
            return;
        }

        var label = source switch
        {
            "netease" => "网易云音乐",
            "qq" => "QQ 音乐",
            _ => source,
        };

        try
        {
            _icon.BalloonTipTitle = $"{label} 登录已失效";
            _icon.BalloonTipText = "后台检测到登录状态已过期，请打开 Zilux2 重新登录。";
            _icon.BalloonTipIcon = Forms.ToolTipIcon.Warning;
            _icon.ShowBalloonTip(5000);
            HostLog.Info($"tray.balloon account-expired source={source}");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"tray.balloon account-expired failed: {exception.Message}");
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        try
        {
            _clickTimer.Stop();
            _clickTimer.Dispose();
            _icon.MouseClick -= OnIconMouseClick;
            _icon.MouseUp -= OnIconMouseUp;
            _window.HiddenToTray -= OnHiddenToTray;
        }
        catch
        {
            // 窗口可能已经销毁；事件解绑失败不影响进程退出。
        }

        try
        {
            _icon.Visible = false;
        }
        catch
        {
            // 资源管理器重启等场景下 NotifyIcon 可能已经失效。
        }

        try
        {
            _menu?.Close();
            _menu = null;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"tray.dispose menu failed: {exception.Message}");
        }

        try
        {
            _icon.Dispose();
        }
        catch (Exception exception)
        {
            HostLog.Warn($"tray.dispose icon failed: {exception.Message}");
        }

        _ownedIcon?.Dispose();
        HostLog.Info("tray.dispose");
    }
}
