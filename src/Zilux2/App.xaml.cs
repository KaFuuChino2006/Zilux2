using System.Windows;
using System.Windows.Threading;
using Zilux2.AirPlay;
using Zilux2.AirPlay.Audio;
using Zilux2.AirPlay.Discovery;
using Zilux2.Audio;
using Zilux2.DevTest.AirPlay;
using Zilux2.Media;
using Zilux2.Online;
using Zilux2.Online.Account;
using Zilux2.Settings;
using Zilux2.Tray;

namespace Zilux2;

public partial class App : Application
{
    internal static OnlineMusicService? Online { get; private set; }

    internal static SettingsService? Settings { get; private set; }

    internal static AudioFeatureService? Audio { get; private set; }

    internal static MediaSessionService? Media { get; private set; }

    internal static AirPlayService? AirPlay { get; private set; }

    /// <summary>后台常驻的托盘图标；窗口关闭后进程仍活着就靠它找回窗口/退出。</summary>
    internal static TrayIconService? Tray { get; private set; }

    private static int _shutdownWatchdogArmed;
    private static int _shutdownFinished;

    // 单实例：第二个进程只负责把已有窗口带到前台，然后立即退出，避免同时出现多个窗口 /
    // 多个托盘图标 / 多套全局热键互相抢占。
    private const string SingleInstanceMutexName = @"Local\Zilux2.SingleInstance";
    private const string ActivateSignalName = @"Local\Zilux2.Activate";
    private Mutex? _singleInstanceMutex;
    private EventWaitHandle? _activateSignal;
    private Thread? _activateWatcher;

    // UI 线程的 Dispatcher：等待线程只能通过它回主线程，直接摸 Window / Application.MainWindow
    // 会触发「另一个线程拥有该对象」的跨线程异常。
    private Dispatcher? _uiDispatcher;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        HostLog.Info($"host.start version={HostInfo.Version} pid={Environment.ProcessId} exe={Environment.ProcessPath ?? "<unknown>"}");
        InstallCrashGuards();

        // tools/account-selftest.ps1 executes the deterministic login checks inside this process:
        // no window, no WebView2, no upstream calls, so it also runs on CI without a display.
        if (AccountSelfCheck.IsRequested)
        {
            var failures = AccountSelfCheck.Run();
            Environment.ExitCode = failures == 0 ? 0 : 1;
            HostLog.Shutdown();
            Shutdown(Environment.ExitCode);
            return;
        }

        // tools/airplay-selftest.ps1 (and CI) exercises the RAOP stack against the in-process
        // mock receiver: no Apple hardware, no window, deterministic exit code.
        if (AirPlayLoopbackTest.IsRequested)
        {
            var airPlayExitCode = AirPlayLoopbackTest.Run();
            Environment.ExitCode = airPlayExitCode;
            HostLog.Shutdown();
            Shutdown(airPlayExitCode);
            return;
        }

        // 单实例保护放在 self-test 分支之后：tools/account-selftest.ps1 / airplay-selftest.ps1
        // 需要在应用已经运行时也能跑（它们是无窗口的确定性测试进程）。
        if (!TryBecomePrimaryInstance())
        {
            Shutdown(0);
            return;
        }

        // docs/zilux2-settings-contract.md §5: settings exist before WebView2 and a broken file
        // only costs persistence, never the window.
        Settings = CreateSettingsService();

        // general.autoLaunch is applied once at startup (idempotent: it compares the current
        // registry value first) and re-applied on every general-section patch/reset below.
        if (Settings is not null)
        {
            AutoLaunchService.Apply(Settings.AutoLaunch);
            Settings.GeneralChanged += OnGeneralSettingsChanged;
        }

        var plan = WebContentPlan.Resolve(out var failure);
        if (plan is null)
        {
            HostLog.Error($"host.start without content: {failure}");
            MessageBox.Show(
                "Zilux2 找不到可加载的前端产物，已停止启动。\n\n" + failure +
                "\n\n请先构建前端（在 web 目录执行 pnpm build），或用环境变量 ZILUX2_WEB_DIR 指定包含 index.html 的目录。",
                "Zilux2 · 缺少前端产物",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            // The WPF-generated Main ignores Application.ExitCode, so set the process exit
            // code explicitly: scripts and the self-test rely on a non-zero code here.
            Environment.ExitCode = 2;
            Shutdown(2);
            return;
        }

        // docs/zilux2-online-music.md §6: the loopback service comes up with the host. A failure
        // here only removes online sources from the page; it must never block the window.
        Online = new OnlineMusicService();
        // 下载目录跟随设置（空字符串 = Windows 音乐目录），宿主的下载服务按需解析。
        Online.DownloadDirectoryProvider = () => Settings?.DownloadDirectory ?? string.Empty;
        // 下载音质同样跟随设置（standard/high/lossless），下载服务按平台能力自动降级。
        Online.DownloadQualityProvider = () => Settings?.DownloadQuality ?? Zilux2.Settings.DownloadSettings.QualityHigh;
        Zilux2.Online.Mvmp3Cache.DirectoryProvider = () =>
        {
            var configured = Settings?.DownloadDirectory;
            return string.IsNullOrWhiteSpace(configured)
                ? Environment.GetFolderPath(Environment.SpecialFolder.MyMusic)
                : configured;
        };
        Zilux2.Online.Mvmp3Cache.MigrateLegacy();
        Online.Start();

        // Audio features are visualizer input: capture must never block the window either, so a
        // missing device only logs and the service retries in the background.
        Audio = CreateAudioService();
        Audio?.Start();

        // SMTC is window scoped, so the service only exists from here; it stays disabled until the
        // page sends the first media state (contract §11).
        Media = CreateMediaService();

        // AirPlay is opt-in from the page: discovery and streams only start after an explicit
        // scan/connect message, and any failure here only removes the feature (contract §12).
        AirPlay = CreateAirPlayService();

        var window = new MainWindow(plan, Settings, Audio, Media, AirPlay);
        MainWindow = window;
        // 下载完成后让本地曲库立刻能看见：宿主把它当成一次本地文件新增处理。
        Online.FileDownloaded = path => window.NotifyDownloadedFile(path);
        window.Show();

        // 托盘图标：失败只失去托盘入口（窗口仍在，但关闭会被隐藏到托盘后找不回来，所以
        // TrayIconService 构造失败时它自己会记日志并退出；这里只兜底不抛到启动流程）。
        TryCreateTray(window);

        if (Settings?.StartMaximized == true)
        {
            // Contract §5: apply after the window exists. Setting WindowState before Show raises
            // no StateChanged, so maximizing here keeps the state push (and margin fix) intact.
            window.WindowState = WindowState.Maximized;
            HostLog.Info("[settings] startMaximized applied");
        }
    }

    /// <summary>
    /// 尝试成为唯一实例。成功时创建「第二个实例唤醒我」的自动重置事件并启动等待线程；
    /// 已有实例时向它发信号并返回 false（调用方直接退出当前进程）。
    /// </summary>
    private bool TryBecomePrimaryInstance()
    {
        try
        {
            _singleInstanceMutex = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out var createdNew);
            if (!createdNew)
            {
                HostLog.Info($"host.instance.reuse pid={Environment.ProcessId}");
                _singleInstanceMutex.Dispose();
                _singleInstanceMutex = null;
                SignalPrimaryInstance();
                return false;
            }

            _uiDispatcher = Dispatcher;
            _activateSignal = new EventWaitHandle(false, EventResetMode.AutoReset, ActivateSignalName);
            _activateWatcher = new Thread(WatchActivateSignals)
            {
                IsBackground = true,
                Name = "Zilux2-Activate",
            };
            _activateWatcher.Start();
            HostLog.Info("host.instance.primary");
            return true;
        }
        catch (Exception exception)
        {
            // 单实例只是体验保护：拿不到互斥体 / 事件时退回旧行为（允许启动），不能挡住播放。
            HostLog.Warn($"host.instance check failed: {exception.GetType().Name}: {exception.Message}");
            return true;
        }
    }

    private static void SignalPrimaryInstance()
    {
        try
        {
            using var signal = EventWaitHandle.OpenExisting(ActivateSignalName);
            signal.Set();
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            // 主实例恰好还在启动中、事件尚未创建：忽略，用户再点一次图标即可。
            HostLog.Warn("host.instance signal missing");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"host.instance signal failed: {exception.Message}");
        }
    }

    private void WatchActivateSignals()
    {
        var signal = _activateSignal;
        if (signal is null)
        {
            return;
        }

        while (true)
        {
            try
            {
                if (!signal.WaitOne())
                {
                    return;
                }
            }
            catch (Exception)
            {
                return;
            }

            try
            {
                // 等待线程不能直接访问 WPF 对象（Window / Application.MainWindow 都有线程亲和性），
                // 只能把「回到主线程唤醒窗口」这个动作排进 UI Dispatcher。
                var dispatcher = _uiDispatcher;
                if (dispatcher is null)
                {
                    continue;
                }

                dispatcher.BeginInvoke(new Action(ActivatePrimaryWindowOnUi));
            }
            catch (Exception exception)
            {
                HostLog.Warn($"host.instance activate failed: {exception.Message}");
            }
        }
    }

    /// <summary>UI 线程侧：把已有窗口带到前台（隐藏到托盘时先恢复显示）。</summary>
    private void ActivatePrimaryWindowOnUi()
    {
        try
        {
            if (MainWindow is MainWindow window)
            {
                window.ActivateFromSecondInstance();
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"host.instance activate failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        try
        {
            // 托盘图标要最先撤掉：它持有主窗口引用，也能在退出过程中再发命令。
            Tray?.Dispose();
            Tray = null;
        }
        catch (Exception exception)
        {
            HostLog.Error("tray.dispose failed", exception);
        }

        try
        {
            // The capture thread reads settings, so it must stop before the service is disposed.
            Audio?.Dispose();
            Audio = null;
        }
        catch (Exception exception)
        {
            HostLog.Error("audio.dispose failed", exception);
        }

        try
        {
            // Stop the RAOP pump and send TEARDOWN before the window goes away; the receiver
            // otherwise keeps showing a now-dead session until it times out.
            AirPlay?.Dispose();
            AirPlay = null;
        }
        catch (Exception exception)
        {
            HostLog.Error("[airplay] dispose failed", exception);
        }

        try
        {
            // Clearing Now Playing is part of a clean exit: a stale session leaves a ghost entry
            // in the Windows media flyout pointing at a dead process.
            Media?.Dispose();
            Media = null;
        }
        catch (Exception exception)
        {
            HostLog.Error("smtc.dispose failed", exception);
        }

        try
        {
            // Flush pending settings before anything else: the 300 ms debounce may still be armed.
            Settings?.Dispose();
            Settings = null;
        }
        catch (Exception exception)
        {
            HostLog.Error("settings.dispose failed", exception);
        }

        try
        {
            Online?.Dispose();
            Online = null;
        }
        catch (Exception exception)
        {
            HostLog.Error("online.dispose failed", exception);
        }

        try
        {
            // 单实例句柄在所有服务停掉后再释放，避免退出过程中第二个实例又把事件当作可用。
            _uiDispatcher = null;
            _activateSignal?.Dispose();
            _activateSignal = null;
            _singleInstanceMutex?.Dispose();
            _singleInstanceMutex = null;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"host.instance dispose failed: {exception.Message}");
        }

        HostLog.Info("host.exit");
        MarkShutdownFinished();
        HostLog.Shutdown();
        base.OnExit(e);
    }

    protected override void OnSessionEnding(SessionEndingCancelEventArgs e)
    {
        // 后台常驻不能拦住 Windows 关机/注销：系统注销会话时放行真正的关闭。
        (MainWindow as MainWindow)?.AllowExitForSystemShutdown();
        base.OnSessionEnding(e);
    }

    /// <summary>
    /// The WebView2 teardown occasionally stalls for a few seconds (browser process busy). Keep
    /// that from turning into a window that never closes: force the process down if shutdown
    /// does not finish, so the taskbar entry and the port always go away.
    /// </summary>
    internal static void ArmShutdownWatchdog()
    {
        if (Interlocked.Exchange(ref _shutdownWatchdogArmed, 1) != 0)
        {
            return;
        }

        var thread = new Thread(() =>
        {
            Thread.Sleep(TimeSpan.FromSeconds(8));
            if (Volatile.Read(ref _shutdownFinished) != 0)
            {
                return;
            }

            HostLog.Error("host.exit watchdog: shutdown exceeded 8s, forcing process exit");
            try
            {
                HostLog.Shutdown();
            }
            catch
            {
                // Nothing left to do: exit below regardless.
            }

            Environment.Exit(0);
        })
        {
            IsBackground = true,
            Name = "Zilux2-ShutdownWatchdog",
        };
        thread.Start();
    }

    private static void MarkShutdownFinished() => Volatile.Write(ref _shutdownFinished, 1);

    /// <summary>
    /// general 段变更后的即时应用：开机自启写/删 HKCU Run；本地目录监控由 WebViewHost 订阅同一
    /// 事件后调 LocalMusicService.SetWatchEnabled。
    /// </summary>
    private static void OnGeneralSettingsChanged()
    {
        AutoLaunchService.Apply(Settings?.AutoLaunch == true);
    }

    private static SettingsService? CreateSettingsService()
    {
        try
        {
            return new SettingsService();
        }
        catch (Exception exception)
        {
            HostLog.Error("settings.init failed", exception);
            return null;
        }
    }

    private static TrayIconService? TryCreateTray(MainWindow window)
    {
        try
        {
            var tray = new TrayIconService(window);
            if (tray.IsAvailable)
            {
                return Tray = tray;
            }

            tray.Dispose();
            HostLog.Warn("tray.unavailable: window close will exit");
            return null;
        }
        catch (Exception exception)
        {
            // 托盘起不来只影响「后台常驻」的可见入口，不能拖垮启动；任务栏按钮仍然可用。
            HostLog.Error("tray.start failed", exception);
            return null;
        }
    }

    private static AudioFeatureService? CreateAudioService()
    {
        try
        {
            return new AudioFeatureService(Settings);
        }
        catch (Exception exception)
        {
            HostLog.Error("audio.init failed", exception);
            return null;
        }
    }

    private static MediaSessionService? CreateMediaService()
    {
        try
        {
            return new MediaSessionService();
        }
        catch (Exception exception)
        {
            HostLog.Error("smtc.init failed", exception);
            return null;
        }
    }

    private static AirPlayService? CreateAirPlayService()
    {
        try
        {
            // Classic RAOP is always available; the AirPlay 2 factory is tried first for devices that
            // advertise it (HomePod / Apple TV) and falls back to RAOP when pairing fails (§12.3).
            return new AirPlayService(
                new AirPlayDiscovery(),
                static () => new AlacAudioEncoder(),
                // AirPlay 2 receivers decode ALAC regardless of the advertised ct, so the AP2 path
                // negotiates ALAC (ct=2) and sends uncompressed-ALAC escape frames. The receiver
                // buffer latency is tunable from the 投送 面板 (AirPlayService.DefaultLatencyMilliseconds).
                static (target, options) => Ap2AudioConnection.Create(
                    target,
                    options,
                    useAlac: true,
                    latencyMilliseconds: AirPlayService.DefaultLatencyMilliseconds),
                static () => new Ap2UncompressedAlacEncoder(),
                // macOS "AirPlay Receiver" rejects transient pairing (HTTP 470) and shows a
                // 4-digit PIN instead; this factory resolves that PIN through the page.
                static (target, options, pinProvider) => Ap2AudioConnection.Create(
                    target,
                    options,
                    useAlac: true,
                    latencyMilliseconds: AirPlayService.DefaultLatencyMilliseconds,
                    pinProvider: pinProvider));
        }
        catch (Exception exception)
        {
            // Contract §12.3: no AirPlay feature is better than a host that cannot start.
            HostLog.Error("[airplay] init failed", exception);
            return null;
        }
    }

    private void InstallCrashGuards()
    {
        // Requirement: host never dies on a stray exception. Log it, keep the process alive.
        DispatcherUnhandledException += (_, args) =>
        {
            HostLog.Error("unhandled.dispatcher", args.Exception);
            args.Handled = true;
        };

        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
        {
            if (args.ExceptionObject is Exception exception)
            {
                HostLog.Error("unhandled.appdomain", exception);
            }
            else
            {
                HostLog.Error($"unhandled.appdomain: {args.ExceptionObject}");
            }
        };

        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            HostLog.Error("unhandled.task", args.Exception);
            args.SetObserved();
        };
    }
}
