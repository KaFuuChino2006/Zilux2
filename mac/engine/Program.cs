// Zilux2 mac 引擎入口。
//
// 把 Windows 宿主里的「在线音乐回环 HTTP 服务」（src/Zilux2/Online/**）原样跑成一个独立进程：
//   - 只监听 127.0.0.1 动态端口（沿用 LocalMusicServer.Start()）；
//   - 命令行要求 --web-root <dir>，同一个端口顺便提供 web 前端静态文件；
//   - 启动成功后 stdout 只打印一行机器可读的 READY 握手，供 Electron 主进程解析：
//       ZILUX2_READY {"port":12345,"token":"...","sources":["netease","qq","kugou"]}
//   - stdin 读到 EOF 或 quit/exit、收到 SIGTERM/SIGINT/SIGHUP/Ctrl+C 时优雅退出；
//   - 启动失败时 stderr 打印一行 ZILUX2_ERROR {json} 并以非 0 退出。
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using Zilux2;
using Zilux2.Online;

namespace Zilux2MacEngine;

internal static class Program
{
    private const string ReadyPrefix = "ZILUX2_READY ";
    private const string ErrorPrefix = "ZILUX2_ERROR ";

    private static int Main(string[] args)
    {
        var webRootArg = ParseWebRoot(args, out var argumentError);
        if (webRootArg is null)
        {
            WriteError("bad-arguments", argumentError ?? "缺少 --web-root <dir> 参数");
            return 2;
        }

        string webRoot;
        try
        {
            webRoot = Path.GetFullPath(webRootArg);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            WriteError("bad-web-root", $"无效的 --web-root 路径：{exception.Message}");
            return 2;
        }

        if (!Directory.Exists(webRoot))
        {
            WriteError("bad-web-root", $"web 前端目录不存在：{webRoot}");
            return 2;
        }

        if (!File.Exists(Path.Combine(webRoot, "index.html")))
        {
            // 不是致命错误：允许只暴露 /api/*（联调脚本就不需要 index.html）。
            HostLog.Warn($"[engine] web-root 缺少 index.html，静态首页会返回 404: {webRoot}");
        }

        // 在 OnlineMusicService 构造 LocalMusicServer 之前告诉它前端产物在哪。
        LocalMusicServer.WebRoot = webRoot;

        // 不用 using 释放：stdin 后台线程可能在进程退出瞬间还在用它，进程生命周期内保持存活即可。
        var done = new ManualResetEventSlim(initialState: false);
        var registrations = new List<PosixSignalRegistration>();
        OnlineMusicService? service = null;

        try
        {
            RegisterShutdownSignals(done, registrations);

            service = new OnlineMusicService();
            service.Start();

            var endpoint = service.Endpoint;
            if (endpoint is null)
            {
                WriteError("start-failed", service.FailureMessage ?? "在线音乐服务启动失败");
                return 1;
            }

            // 字段顺序固定 port/token/sources，Electron 侧按固定协议解析，不要依赖对象属性顺序变化。
            var ready = new
            {
                port = endpoint.Port,
                token = endpoint.Token,
                sources = endpoint.Sources,
            };
            Console.Out.WriteLine(ReadyPrefix + JsonSerializer.Serialize(ready));
            Console.Out.Flush();
            HostLog.Info($"[engine] ready port={endpoint.Port} webRoot={webRoot} sources={string.Join(",", endpoint.Sources)}");

            StartStdinWatcher(done);
            done.Wait();

            HostLog.Info("[engine] shutdown requested");
            return 0;
        }
        catch (Exception exception)
        {
            WriteError("engine-failed", $"{exception.GetType().Name}: {exception.Message}");
            return 1;
        }
        finally
        {
            foreach (var registration in registrations)
            {
                try
                {
                    registration.Dispose();
                }
                catch
                {
                    // 退出路径上不允许再抛。
                }
            }

            registrations.Clear();

            try
            {
                service?.Dispose();
            }
            catch
            {
                // Dispose 内部已自行记录日志，这里只保证进程能退出。
            }

            HostLog.Shutdown();
        }
    }

    /// <summary>支持 `--web-root &lt;dir&gt;` 与 `--web-root=&lt;dir&gt;` 两种写法。</summary>
    private static string? ParseWebRoot(string[] args, out string? error)
    {
        error = null;
        string? value = null;
        for (var index = 0; index < args.Length; index++)
        {
            var arg = args[index];
            if (string.Equals(arg, "--web-root", StringComparison.Ordinal))
            {
                if (index + 1 >= args.Length)
                {
                    error = "--web-root 后面缺少目录参数";
                    return null;
                }

                value = args[++index];
                continue;
            }

            if (arg.StartsWith("--web-root=", StringComparison.Ordinal))
            {
                value = arg["--web-root=".Length..];
                continue;
            }

            error = $"不认识的参数：{arg}";
            return null;
        }

        if (value is null)
        {
            error = "缺少 --web-root <dir> 参数（web 前端产物目录）";
            return null;
        }

        value = value.Trim();
        if (value.Length == 0)
        {
            error = "--web-root 目录不能为空";
            return null;
        }

        return value;
    }

    private static void RegisterShutdownSignals(ManualResetEventSlim done, List<PosixSignalRegistration> registrations)
    {
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            done.Set();
        };

        AppDomain.CurrentDomain.ProcessExit += (_, _) => done.Set();

        foreach (var signal in new[] { PosixSignal.SIGTERM, PosixSignal.SIGINT, PosixSignal.SIGHUP })
        {
            try
            {
                var registration = PosixSignalRegistration.Create(signal, context =>
                {
                    // 让 .NET 的手势默认行为（直接杀进程）让位给优雅退出。
                    context.Cancel = true;
                    done.Set();
                });
                registrations.Add(registration);
            }
            catch (Exception exception) when (exception is PlatformNotSupportedException or ArgumentException or InvalidOperationException)
            {
                HostLog.Warn($"[engine] 当前平台不支持 {signal} 注册：{exception.GetType().Name}");
            }
        }
    }

    /// <summary>stdin EOF 或 quit/exit 行都视为关闭请求（Electron 关闭管道即可让引擎退出）。</summary>
    private static void StartStdinWatcher(ManualResetEventSlim done)
    {
        var thread = new Thread(() =>
        {
            try
            {
                string? line;
                while (!done.IsSet && (line = Console.In.ReadLine()) is not null)
                {
                    var command = line.Trim();
                    if (command.Equals("quit", StringComparison.OrdinalIgnoreCase) ||
                        command.Equals("exit", StringComparison.OrdinalIgnoreCase))
                    {
                        break;
                    }
                }
            }
            catch (Exception exception) when (exception is IOException or ObjectDisposedException or InvalidOperationException)
            {
                HostLog.Warn($"[engine] stdin 读取中断：{exception.GetType().Name}");
            }
            finally
            {
                try
                {
                    done.Set();
                }
                catch (ObjectDisposedException)
                {
                    // 进程已经在退出。
                }
            }
        })
        {
            IsBackground = true,
            Name = "Zilux2-Stdin",
        };
        thread.Start();
    }

    private static void WriteError(string code, string message)
    {
        var payload = new { error = code, message };
        Console.Error.WriteLine(ErrorPrefix + JsonSerializer.Serialize(payload));
        Console.Error.Flush();
    }
}
