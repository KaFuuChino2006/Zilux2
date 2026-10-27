using System.Drawing;
using Forms = System.Windows.Forms;

namespace Zilux2.Tray;

/// <summary>
/// 托盘图标（<see cref="Forms.NotifyIcon"/>）：左键单击显示/隐藏主窗口，右键菜单提供显示窗口、
/// 播放控制（播放/暂停、上一首、下一首）和真正退出。
///
/// 线程模型：NotifyIcon 在 WPF UI 线程上创建，它的隐藏窗口由 WPF 的消息泵分发，因此所有回调
/// 都在 UI 线程执行，可以直接调用 <see cref="MainWindow"/> 的方法，不需要额外调度。
/// 播放控制统一走页面 command 消息（MainWindow.SendCommand → WebViewHost.PostCommand），
/// 与全局热键共用同一条链路。
/// </summary>
internal sealed class TrayIconService : IDisposable
{
    private readonly MainWindow _window;
    private readonly Forms.NotifyIcon _icon;
    private readonly Forms.ContextMenuStrip _menu;
    private readonly Icon? _ownedIcon;
    private bool _shownHint;
    private bool _disposed;
    private long _lastLeftClickTicks;

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

        _menu = new Forms.ContextMenuStrip();
        var showItem = new Forms.ToolStripMenuItem("显示主窗口");
        showItem.Click += (_, _) => _window.ShowFromTray();
        var togglePlayItem = new Forms.ToolStripMenuItem("播放或暂停");
        togglePlayItem.Click += (_, _) => _window.SendCommand("togglePlay");
        var previousItem = new Forms.ToolStripMenuItem("上一首");
        previousItem.Click += (_, _) => _window.SendCommand("prev");
        var nextItem = new Forms.ToolStripMenuItem("下一首");
        nextItem.Click += (_, _) => _window.SendCommand("next");
        var exitItem = new Forms.ToolStripMenuItem("退出");
        exitItem.Click += (_, _) => _window.CloseForReal();
        _menu.Items.Add(showItem);
        _menu.Items.Add(new Forms.ToolStripSeparator());
        _menu.Items.Add(togglePlayItem);
        _menu.Items.Add(previousItem);
        _menu.Items.Add(nextItem);
        _menu.Items.Add(new Forms.ToolStripSeparator());
        _menu.Items.Add(exitItem);
        _icon.ContextMenuStrip = _menu;

        _icon.MouseClick += OnIconMouseClick;
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

        // 双击会先发两次 MouseClick；第二次忽略，避免「显示→又隐藏」闪一下。
        var now = Environment.TickCount64;
        if (now - _lastLeftClickTicks < 400)
        {
            _lastLeftClickTicks = now;
            return;
        }

        _lastLeftClickTicks = now;
        _window.ToggleFromTray();
    }

    private void OnHiddenToTray(object? sender, EventArgs e)
    {
        if (_disposed || _shownHint)
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
            _menu.Dispose();
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
