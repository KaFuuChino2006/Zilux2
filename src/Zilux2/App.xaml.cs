using System.Windows;
using Zilux2.AirPlay;
using Zilux2.AirPlay.Audio;
using Zilux2.AirPlay.Discovery;
using Zilux2.Audio;
using Zilux2.DevTest.AirPlay;
using Zilux2.Media;
using Zilux2.Online;
using Zilux2.Online.Account;
using Zilux2.Settings;

namespace Zilux2;

public partial class App : Application
{
    internal static OnlineMusicService? Online { get; private set; }

    internal static SettingsService? Settings { get; private set; }

    internal static AudioFeatureService? Audio { get; private set; }

    internal static MediaSessionService? Media { get; private set; }

    internal static AirPlayService? AirPlay { get; private set; }

    private static int _shutdownWatchdogArmed;
    private static int _shutdownFinished;

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

        // docs/zilux2-settings-contract.md §5: settings exist before WebView2 and a broken file
        // only costs persistence, never the window.
        Settings = CreateSettingsService();

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

        if (Settings?.StartMaximized == true)
        {
            // Contract §5: apply after the window exists. Setting WindowState before Show raises
            // no StateChanged, so maximizing here keeps the state push (and margin fix) intact.
            window.WindowState = WindowState.Maximized;
            HostLog.Info("[settings] startMaximized applied");
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
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

        HostLog.Info("host.exit");
        MarkShutdownFinished();
        HostLog.Shutdown();
        base.OnExit(e);
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
