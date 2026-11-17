using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Zilux2.Online;
using Zilux2.Settings;

namespace Zilux2.Remote;

/// <summary>
/// 手机局域网遥控：宿主侧的编排层。
///
/// 职责边界（刻意做窄）：
///   * 只负责「把手机发来的意图翻译成播放器已有的入口」——命令走 <c>PostWebMessageAsJson</c> 的
///     command/mediaControl 通道，页面状态走 <see cref="RemoteAgent"/> 注入的 <c>window.__zxr</c>；
///   * 播放状态不自己算：听的还是页面 5 次/秒的 media 上报 + lyrics 上下文消息（与桌面歌词同一份数据）；
///   * 不碰 LocalMusicServer/WebViewHost：只读它们对外暴露的 Endpoint 与页面消息。
/// 这样手机端看到的东西和主界面永远是同一份真相，服务关掉/手机断线也不会影响播放。
/// </summary>
internal sealed class RemoteService : IDisposable
{
    private const string BasePrefix = "/r/";
    private const int AgentCacheMs = 900;
    private const int LyricsCacheMs = 10 * 60 * 1000;

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(6) };

    private readonly SettingsService _settings;
    private readonly object _gate = new();
    private readonly System.Threading.Timer _tick;

    private RemoteHttpServer? _server;
    private string _token = NewToken();
    private int _port;
    private string? _portNote;
    private int _lastPreferred;
    private bool _loggedDisabled;
    private bool _tickFailedLogged;
    private long _tickFailures;
    private bool _disposed;

    // 页面 → 宿主的上报（media/lyrics），由 RemoteService 自己订阅 WebMessageReceived 旁路获取。
    private RemoteMedia _media = RemoteMedia.Empty;
    private long _mediaAt;
    private RemoteLyricFrame? _lyric;
    private long _lyricAt;

    // 页面 → 宿主的上报（agent），由 ExecuteScriptAsync 同步取回。
    private RemoteAgentState _agentState = RemoteAgentState.Empty;
    private long _agentAt;

    private WebView2? _webView;
    private CoreWebView2? _core;
    private bool _injected;
    private long _lastInjectAt;

    private readonly Dictionary<string, RemoteTrackIdentity?> _identities = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, RemoteLyrics> _lyrics = new(StringComparer.OrdinalIgnoreCase);

    internal RemoteService(SettingsService settings)
    {
        _settings = settings;
        _tick = new System.Threading.Timer(_ => Tick(), null, 700, 1200);
    }

    internal static RemoteService? Instance { get; private set; }

    /// <summary>App.xaml.cs 里的唯一一行启动入口（不抛异常）。</summary>
    internal static void Start(SettingsService? settings)
    {
        try
        {
            if (settings is null)
            {
                HostLog.Warn("[remote] start skipped reason=no-settings");
                return;
            }

            Instance?.Dispose();
            Instance = new RemoteService(settings);
            Instance.Sync();
            HostLog.Info($"[remote] service ready token={Instance.MaskToken()} web={RemotePages.ResolveIndex() ?? "-"}");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[remote] start failed err={exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>App.xaml.cs 里的唯一一行停止入口。</summary>
    internal static void Stop()
    {
        try
        {
            Instance?.Dispose();
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[remote] stop failed err={exception.GetType().Name}");
        }
        finally
        {
            Instance = null;
        }
    }

    internal string Token => _token;

    internal int Port
    {
        get
        {
            lock (_gate)
            {
                return _port;
            }
        }
    }

    internal bool IsListening => Port > 0;

    internal string? PortNote
    {
        get
        {
            lock (_gate)
            {
                return _portNote;
            }
        }
    }

    private string MaskToken() => _token.Length <= 6 ? "***" : _token[..4] + "…" + _token[^4..];

    private static string NewToken() =>
        Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();

    private string LanUrl(string? address = null) =>
        Port <= 0 ? string.Empty : $"http://{address ?? RemoteNetwork.PreferredLanAddress() ?? "127.0.0.1"}:{Port}{BasePrefix}";

    /// <summary>按当前设置启停监听。设置页开关、端口变更、启动都会走这里。</summary>
    internal void Sync()
    {
        var options = _settings.RemoteOptions;
        if (!options.Enabled)
        {
            StopListener("disabled");
            if (!_loggedDisabled)
            {
                _loggedDisabled = true;
                HostLog.Info("[remote] disabled：设置里未开启，端口不监听");
            }

            return;
        }

        _loggedDisabled = false;

        var preferred = options.Port;
        lock (_gate)
        {
            if (_server is not null && _port > 0 && preferred == _lastPreferred)
            {
                return;
            }
        }

        StopListener("restart");

        var server = new RemoteHttpServer();
        if (!server.TryStart(preferred, HandleAsync, out var actual, out var error))
        {
            HostLog.Warn($"[remote] start failed preferred={preferred} err={error}");
            server.Dispose();
            lock (_gate)
            {
                _portNote = $"端口 {preferred} 被占用，服务未启动：{error}";
            }

            return;
        }

        lock (_gate)
        {
            _server = server;
            _port = actual;
            _lastPreferred = preferred;
            _portNote = preferred > 0 && actual != preferred ? $"端口 {preferred} 被占用，已改用 {actual}" : null;
        }

        var addresses = RemoteNetwork.LanAddresses();
        HostLog.Info($"[remote] enabled port={actual} preferred={preferred} lan={string.Join(",", addresses)}");
        HostLog.Info($"[remote] url={LanUrl()}");
        if (addresses.Count == 0)
        {
            HostLog.Warn("[remote] 未找到局域网 IPv4 地址；手机可能无法访问，请检查网络适配器。");
        }
        else
        {
            HostLog.Info("[remote] 手机连不上时先确认 Windows 防火墙放行了本程序的入站 TCP；" +
                         "或临时用「允许应用通过防火墙」为 Zilux2 勾选专用网络。服务本身不改防火墙规则。");
        }

        PushCard();
    }

    private void StopListener(string reason)
    {
        RemoteHttpServer? server;
        lock (_gate)
        {
            server = _server;
            _server = null;
            _port = 0;
            _lastPreferred = 0;
        }

        if (server is null)
        {
            return;
        }

        server.Dispose();
        HostLog.Info($"[remote] listener stopped reason={reason}");
        PushCard();
    }

    internal void SetEnabled(bool enabled)
    {
        var options = _settings.RemoteOptions;
        _settings.SetRemoteOptions(enabled, options.Port);
        Sync();
        HostLog.Info($"[remote] toggle enabled={enabled}");
    }

    internal void SetPort(int port)
    {
        var options = _settings.RemoteOptions;
        _settings.SetRemoteOptions(options.Enabled, port);
        Sync();
        HostLog.Info($"[remote] port requested={port} actual={Port} note={PortNote ?? "-"}");
    }

    internal void ResetToken()
    {
        lock (_gate)
        {
            _token = NewToken();
        }

        // 令牌换了等于换链接：重建监听没有意义（同一端口），但要让页面卡片与日志同步。
        HostLog.Info($"[remote] token reset token={MaskToken()}");
        PushCard();
    }

    /* ------------------------------------------------------------------ */
    /* 设置卡片                                                            */
    /* ------------------------------------------------------------------ */

    private string CardJson()
    {
        var options = _settings.RemoteOptions;
        var url = options.Enabled ? LanUrl() : string.Empty;
        var note = options.Enabled
            ? (IsListening
                ? "手机连同一个 Wi-Fi，打开下面的链接即可控制播放。链接里带着一次性令牌，别往外发。"
                : "服务未在监听，看看日志里的端口提示。")
            : "默认关闭。开启后只在本机局域网监听，不做公网穿透。";
        var status = PortNote ?? (options.Enabled && IsListening ? $"正在监听 {Port}（{RemoteNetwork.LanAddresses().Count} 个局域网地址）" : string.Empty);
        return JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["enabled"] = options.Enabled,
            ["port"] = options.Port > 0 ? options.Port : (IsListening ? Port : 0),
            ["url"] = url,
            ["note"] = note,
            ["status"] = status,
        });
    }

    private void PushCard()
    {
        var json = CardJson();
        _ = UiAsync(async core =>
        {
            await core.ExecuteScriptAsync($"window.__zxr && window.__zxr.cardUpdate({json})").ConfigureAwait(false);
            return 0;
        });
    }

    /* ------------------------------------------------------------------ */
    /* WebView2 接线（定时器里发现窗口就接上，不依赖 MainWindow 的字段）        */
    /* ------------------------------------------------------------------ */

    private void Tick()
    {
        // 定时器回调在 ThreadPool 线程上：视觉树遍历与 CoreWebView2 取用都必须回到 UI 线程。
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher is null)
        {
            return;
        }

        if (!dispatcher.CheckAccess())
        {
            try
            {
                dispatcher.BeginInvoke(new Action(Tick));
            }
            catch
            {
                // 退出过程中 dispatcher 可能已经关停，忽略。
            }

            return;
        }

        try
        {
            if (_disposed)
            {
                return;
            }

            Attach();
            if (_core is null)
            {
                return;
            }

            if (!_injected && Environment.TickCount64 - _lastInjectAt > 3000)
            {
                _lastInjectAt = Environment.TickCount64;
                Inject(force: true);
            }
        }
        catch (Exception exception)
        {
            // 只打第一条（带栈首行），后面只累加计数：定时器每秒跑一次，刷屏比异常本身更糟。
            _tickFailures += 1;
            if (!_tickFailedLogged)
            {
                _tickFailedLogged = true;
                var frame = (exception.StackTrace ?? string.Empty).Split('\n').FirstOrDefault()?.Trim() ?? string.Empty;
                HostLog.Warn($"[remote] tick failed err={exception.GetType().Name}: {exception.Message} at {frame}（后续同类异常只计数）");
            }
        }
    }

    private void Attach()
    {
        var window = Application.Current?.MainWindow;
        if (window is null)
        {
            return;
        }

        var view = _webView;
        if (view is null || !view.IsLoaded)
        {
            view = FindChild<WebView2>(window);
            if (view is null)
            {
                return;
            }

            _webView = view;
        }

        var core = view.CoreWebView2;
        if (core is null)
        {
            return;
        }

        if (ReferenceEquals(core, _core))
        {
            return;
        }

        if (_core is not null)
        {
            try
            {
                _core.WebMessageReceived -= OnWebMessage;
                _core.NavigationCompleted -= OnNavigationCompleted;
            }
            catch
            {
                // 旧 core 已经死了，忽略。
            }
        }

        _core = core;
        _injected = false;
        core.WebMessageReceived += OnWebMessage;
        core.NavigationCompleted += OnNavigationCompleted;
        HostLog.Info("[remote] webview attached");
        Inject(force: true);
        PushCard();
    }

    private static T? FindChild<T>(DependencyObject root) where T : DependencyObject
    {
        var count = VisualTreeHelper.GetChildrenCount(root);
        for (var i = 0; i < count; i += 1)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is T match)
            {
                return match;
            }

            var nested = FindChild<T>(child);
            if (nested is not null)
            {
                return nested;
            }
        }

        return null;
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        _injected = false;
        _lastInjectAt = 0;
        Inject(force: true);
    }

    private void Inject(bool force)
    {
        if (_core is null)
        {
            return;
        }

        _ = UiAsync(async core =>
        {
            var result = await core.ExecuteScriptAsync(RemoteAgent.Script).ConfigureAwait(false);
            if (!_injected)
            {
                _injected = true;
                HostLog.Info($"[remote] agent injected result={result}");
            }

            return 0;
        });
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var json = e.WebMessageAsJson;
            if (string.IsNullOrEmpty(json))
            {
                return;
            }

            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return;
            }

            var type = root.TryGetProperty("type", out var typeElement) ? typeElement.GetString() : null;
            switch (type)
            {
                case "media":
                    CaptureMedia(root);
                    break;
                case "lyrics":
                    CaptureLyric(root);
                    break;
                case "remote":
                    HandleCardOp(root);
                    break;
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[remote] message failed err={exception.GetType().Name}: {exception.Message}");
        }
    }

    private void CaptureMedia(JsonElement root)
    {
        if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        var media = new RemoteMedia
        {
            Title = Str(payload, "title"),
            Artist = Str(payload, "artist"),
            Album = Str(payload, "album"),
            CoverUrl = Str(payload, "coverUrl"),
            DurationMs = Num(payload, "durationMs"),
            PositionMs = Num(payload, "positionMs"),
            Playing = Bool(payload, "playing"),
            Transitioning = Bool(payload, "transitioning"),
        };

        var changed = !string.Equals(media.Title, _media.Title, StringComparison.Ordinal) ||
                      !string.Equals(media.Artist, _media.Artist, StringComparison.Ordinal);
        _media = media;
        _mediaAt = Environment.TickCount64;
        if (changed)
        {
            HostLog.Info($"[remote] now title={media.Title} artist={media.Artist} dur={media.DurationMs}");
            _ = ResolveIdentityAsync(media.Title, media.Artist);
        }
    }

    private void CaptureLyric(JsonElement root)
    {
        if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object)
        {
            return;
        }

        _lyric = new RemoteLyricFrame
        {
            Now = Str(payload, "now"),
            Previous = Str(payload, "previous"),
            Next = Str(payload, "next"),
            Translation = Str(payload, "translation"),
            PositionMs = Num(payload, "positionMs"),
            Playing = Bool(payload, "playing"),
        };
        _lyricAt = Environment.TickCount64;
    }

    private void HandleCardOp(JsonElement root)
    {
        var op = Str(root, "op");
        var value = root.TryGetProperty("value", out var valueElement) ? valueElement : default;
        switch (op)
        {
            case "setEnabled":
                SetEnabled(value.ValueKind == JsonValueKind.True || (value.ValueKind == JsonValueKind.String && value.GetString() == "1"));
                break;
            case "setPort":
                SetPort(value.ValueKind == JsonValueKind.Number ? value.GetInt32() : 0);
                break;
            case "resetToken":
                ResetToken();
                break;
            case "copied":
                HostLog.Info($"[remote] link copied ok={Bool(root, "ok")}");
                break;
            case "openUrl":
                OpenInBrowser(Str(root, "value"));
                break;
            case "cardMounted":
                HostLog.Info("[remote] settings card mounted");
                PushCard();
                break;
        }
    }

    private void OpenInBrowser(string url)
    {
        // 设置页是 https://zilux2.local，window.open 一个 http:// 链接会被当成混合内容拦掉；
        // 所以"本机预览"交给默认浏览器打开（只允许打开本服务自己生成的链接）。
        if (!IsListening || string.IsNullOrWhiteSpace(url))
        {
            return;
        }

        var expected = BasePrefix;
        if (!url.StartsWith($"http://127.0.0.1:{Port}{expected}", StringComparison.Ordinal) &&
            !url.StartsWith($"http://localhost:{Port}{expected}", StringComparison.Ordinal))
        {
            return;
        }

        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true });
            HostLog.Info("[remote] preview opened in default browser");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[remote] open preview failed err={exception.GetType().Name}");
        }
    }

    /* ------------------------------------------------------------------ */
    /* HTTP 路由                                                            */
    /* ------------------------------------------------------------------ */

    private async Task<RemoteResponse> HandleAsync(RemoteRequest request)
    {
        if (!RemoteNetwork.IsPrivateOrLoopback(request.RemoteAddress))
        {
            HostLog.Warn($"[remote] reject non-lan remote={request.RemoteAddress} path={request.Path}");
            return RemoteResponse.Text(403, "forbidden");
        }

        // 手机遥控不再校验令牌：打开开关后同一局域网内任何设备直接访问 /r/ 即可，
        // 不需要每次复制带一次性令牌的链接。旧链接 /r/<token>/… 仍然兼容（令牌段直接忽略）。
        var openBase = BasePrefix.TrimEnd('/');
        var path = request.Path;

        if (path.Length <= 1)
        {
            return RemoteResponse.Html(200, RemotePages.HelpPage());
        }

        string basePath;
        if (string.Equals(path, openBase, StringComparison.Ordinal) ||
            string.Equals(path, BasePrefix, StringComparison.Ordinal))
        {
            // 不重定向：页面自己按 location.pathname 推 base，带不带末尾斜杠都能用。
            return RemotePages.Index();
        }

        if (path.StartsWith(BasePrefix, StringComparison.Ordinal))
        {
            var rest = path[BasePrefix.Length..];
            var slash = rest.IndexOf('/');
            var first = slash < 0 ? rest : rest[..slash];
            // 旧式 /r/<token>/api/... 仍然兼容：第一段既不是 api 也不是 proxy 时当成令牌跳过。
            basePath = first.Length > 0 && first != "api" && first != "proxy"
                ? BasePrefix + first
                : openBase;
        }
        else
        {
            return RemoteResponse.Text(404, "not-found");
        }

        var route = path[basePath.Length..];
        if (route.Length == 0)
        {
            route = "/";
        }
        try
        {
            return route switch
            {
                "/" or "/index.html" => RemotePages.Index(),
                "/api/ping" => RemoteResponse.Json(200, "{\"ok\":true,\"v\":1}"),
                "/api/state" => await StateAsync().ConfigureAwait(false),
                "/api/lyrics" => await LyricsAsync().ConfigureAwait(false),
                "/api/queue" => await QueueAsync().ConfigureAwait(false),
                "/api/search" => await SearchAsync(request).ConfigureAwait(false),
                "/api/play" => await PlayAsync(request).ConfigureAwait(false),
                "/api/jump" => await JumpAsync(request).ConfigureAwait(false),
                "/api/command" => await CommandAsync(request).ConfigureAwait(false),
                "/api/seek" => await SeekAsync(request).ConfigureAwait(false),
                "/api/playing" => await PlayingAsync(request).ConfigureAwait(false),
                "/api/volume" => await VolumeAsync(request).ConfigureAwait(false),
                "/api/mode" => await ModeAsync(request).ConfigureAwait(false),
                "/proxy" => await ProxyAsync(request).ConfigureAwait(false),
                _ => RemoteResponse.Text(404, "not-found"),
            };
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[remote] route failed path={route} err={exception.GetType().Name}: {exception.Message}");
            return RemoteResponse.Json(500, "{\"ok\":false,\"error\":\"internal\"}");
        }
    }

    private string ProxyUrl(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return string.Empty;
        }

        var endpoint = App.Online?.Endpoint;
        if (endpoint is not null &&
            Uri.TryCreate(raw, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps) &&
            uri.Port == endpoint.Port &&
            (uri.Host == "127.0.0.1" || uri.Host == "localhost"))
        {
            return $"{BasePrefix}proxy?u={WebUtility.UrlEncode(raw)}";
        }

        return raw;
    }

    /* ---------------------------------- state -------------------------- */

    private async Task<RemoteResponse> StateAsync()
    {
        var agent = await AgentStateAsync().ConfigureAwait(false);
        var media = _media;
        var payload = new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["v"] = 1,
            ["now"] = new Dictionary<string, object?>
            {
                ["title"] = media.Title,
                ["artist"] = media.Artist,
                ["album"] = media.Album,
                ["cover"] = ProxyUrl(media.CoverUrl),
                ["durationMs"] = media.DurationMs,
                ["positionMs"] = media.PositionMs,
                ["playing"] = media.Playing,
                ["transitioning"] = media.Transitioning,
                ["staleMs"] = _mediaAt == 0 ? -1 : Environment.TickCount64 - _mediaAt,
            },
            ["agent"] = new Dictionary<string, object?>
            {
                ["volume"] = agent.Volume,
                ["muted"] = agent.Muted,
                ["mode"] = agent.Mode,
                ["modeTitle"] = agent.ModeTitle,
            },
            ["desktopLyrics"] = _settings.BackgroundLyricsEnabled,
            ["lyric"] = LyricContext(),
            ["remote"] = new Dictionary<string, object?>
            {
                ["port"] = Port,
                ["note"] = PortNote,
            },
        };

        return RemoteResponse.Json(200, JsonSerializer.Serialize(payload));
    }

    private Dictionary<string, object?> LyricContext()
    {
        var frame = _lyric;
        if (frame is null)
        {
            return new Dictionary<string, object?> { ["has"] = false };
        }

        return new Dictionary<string, object?>
        {
            ["has"] = !string.IsNullOrWhiteSpace(frame.Now),
            ["now"] = frame.Now,
            ["previous"] = frame.Previous,
            ["next"] = frame.Next,
            ["translation"] = frame.Translation,
            ["positionMs"] = frame.PositionMs,
            ["staleMs"] = _lyricAt == 0 ? -1 : Environment.TickCount64 - _lyricAt,
        };
    }

    private async Task<RemoteAgentState> AgentStateAsync()
    {
        var cached = _agentState;
        if (Environment.TickCount64 - _agentAt < AgentCacheMs && cached.Attached)
        {
            return cached;
        }

        var json = await AgentAsync("__zxr.state()").ConfigureAwait(false);
        var state = ParseAgentState(json);
        if (state.Attached)
        {
            _agentState = state;
            _agentAt = Environment.TickCount64;
        }

        return state;
    }

    private static RemoteAgentState ParseAgentState(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return RemoteAgentState.Empty;
        }

        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            return new RemoteAgentState
            {
                Attached = true,
                HasPlayer = Bool(root, "hasPlayer"),
                Mode = Str(root, "mode"),
                ModeTitle = Str(root, "modeTitle"),
                Volume = root.TryGetProperty("volume", out var volume) && volume.ValueKind == JsonValueKind.Number ? volume.GetDouble() : null,
                Muted = Bool(root, "muted"),
            };
        }
        catch (JsonException)
        {
            return RemoteAgentState.Empty;
        }
    }

    /* ---------------------------------- agent ------------------------- */

    /// <summary>执行 `window.__zxr.*`，返回值是脚本的 JSON 字符串（外层还有一层 JSON 引号）。</summary>
    private async Task<string?> AgentAsync(string expression)
    {
        var result = await UiAsync(async core =>
        {
            try
            {
                return await core.ExecuteScriptAsync($"window.__zxr ? ({expression}) : null").ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[remote] agent call failed expr={expression} err={exception.GetType().Name}");
                return null;
            }
        }).ConfigureAwait(false);

        if (string.IsNullOrEmpty(result) || result == "null")
        {
            _injected = false;
            return null;
        }

        // ExecuteScriptAsync 把返回值再 JSON 序列化一次：字符串会带引号，对象则原样。
        if (result.Length > 1 && result[0] == '"')
        {
            try
            {
                return JsonSerializer.Deserialize<string>(result);
            }
            catch (JsonException)
            {
                return null;
            }
        }

        return result;
    }

    private async Task<T?> UiAsync<T>(Func<CoreWebView2, Task<T>> action)
    {
        var core = _core;
        var app = Application.Current;
        if (core is null || app is null)
        {
            return default;
        }

        try
        {
            // Dispatcher.InvokeAsync 返回 DispatcherOperation<Task<T>>：先等它把工作排上 UI 线程，
            // 再等里面的异步部分结束，才是真正拿到的值。
            var operation = app.Dispatcher.InvokeAsync(async () =>
            {
                try
                {
                    return await action(core).ConfigureAwait(true);
                }
                catch (Exception exception)
                {
                    HostLog.Warn($"[remote] ui action failed err={exception.GetType().Name}: {exception.Message}");
                    return default(T);
                }
            });
            var pending = await operation.Task.ConfigureAwait(false);
            return await pending.ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[remote] dispatch failed err={exception.GetType().Name}");
            return default;
        }
    }

    private Task PostCommandAsync(string action) => PostJsonAsync($"{{\"v\":1,\"type\":\"command\",\"action\":\"{RemoteHttp.JsonEscape(action)}\"}}");

    private async Task PostJsonAsync(string json)
    {
        await UiAsync(async core =>
        {
            core.PostWebMessageAsJson(json);
            return 0;
        }).ConfigureAwait(false);
    }

    private Task PostMediaControlAsync(string action, double? positionMs)
    {
        var payload = positionMs is null
            ? $"{{\"v\":1,\"type\":\"host\",\"event\":\"mediaControl\",\"payload\":{{\"action\":\"{RemoteHttp.JsonEscape(action)}\"}}}}"
            : $"{{\"v\":1,\"type\":\"host\",\"event\":\"mediaControl\",\"payload\":{{\"action\":\"{RemoteHttp.JsonEscape(action)}\",\"positionMs\":{positionMs.Value.ToString("0", CultureInfo.InvariantCulture)}}}}}";
        return PostJsonAsync(payload);
    }

    private async Task<RemoteResponse> CommandAsync(RemoteRequest request)
    {
        var action = (request.QueryValue("action") ?? string.Empty).Trim();
        var allowed = action is "togglePlay" or "prev" or "next" or "stop" or "desktopLyrics"
            or "mute" or "like" or "mode";
        if (!allowed)
        {
            return RemoteResponse.Json(400, "{\"ok\":false,\"error\":\"bad-action\"}");
        }

        await PostCommandAsync(action).ConfigureAwait(false);
        HostLog.Info($"[remote] command action={action} remote={request.RemoteAddress}");
        return RemoteResponse.Json(200, "{\"ok\":true}");
    }

    private async Task<RemoteResponse> SeekAsync(RemoteRequest request)
    {
        if (!double.TryParse(request.QueryValue("ms"), NumberStyles.Float, CultureInfo.InvariantCulture, out var ms) || ms < 0)
        {
            return RemoteResponse.Json(400, "{\"ok\":false,\"error\":\"bad-ms\"}");
        }

        await PostMediaControlAsync("seek", ms).ConfigureAwait(false);
        HostLog.Info($"[remote] seek ms={(long)ms}");
        return RemoteResponse.Json(200, $"{{\"ok\":true,\"ms\":{(long)ms}}}");
    }

    /// <summary>显式播放/暂停（true/false），空则等价于 toggle。手机端按钮用它，状态好回读。</summary>
    private async Task<RemoteResponse> PlayingAsync(RemoteRequest request)
    {
        var raw = (request.QueryValue("on") ?? string.Empty).Trim();
        if (raw is "1" or "true" or "play")
        {
            await PostMediaControlAsync("play", null).ConfigureAwait(false);
            HostLog.Info("[remote] playing=1");
            return RemoteResponse.Json(200, "{\"ok\":true,\"playing\":true}");
        }

        if (raw is "0" or "false" or "pause")
        {
            await PostMediaControlAsync("pause", null).ConfigureAwait(false);
            HostLog.Info("[remote] playing=0");
            return RemoteResponse.Json(200, "{\"ok\":true,\"playing\":false}");
        }

        await PostCommandAsync("togglePlay").ConfigureAwait(false);
        HostLog.Info("[remote] playing=toggle");
        return RemoteResponse.Json(200, "{\"ok\":true,\"playing\":null}");
    }

    private async Task<RemoteResponse> VolumeAsync(RemoteRequest request)
    {
        if (!double.TryParse(request.QueryValue("value"), NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
        {
            return RemoteResponse.Json(400, "{\"ok\":false,\"error\":\"bad-value\"}");
        }

        var json = await AgentAsync($"__zxr.volume({value.ToString("0.#", CultureInfo.InvariantCulture)})").ConfigureAwait(false);
        HostLog.Info($"[remote] volume value={value} result={json}");
        _agentAt = 0;
        return RemoteResponse.Json(200, json is null ? "{\"ok\":false}" : json);
    }

    private async Task<RemoteResponse> ModeAsync(RemoteRequest request)
    {
        var mode = (request.QueryValue("mode") ?? string.Empty).Trim();
        if (mode is not ("list" or "single" or "shuffle" or "smartmix"))
        {
            return RemoteResponse.Json(400, "{\"ok\":false,\"error\":\"bad-mode\"}");
        }

        var json = await AgentAsync($"__zxr.mode(\"{RemoteHttp.JsonEscape(mode)}\")").ConfigureAwait(false);
        HostLog.Info($"[remote] mode target={mode} result={json}");
        _agentAt = 0;
        return RemoteResponse.Json(200, json is null ? "{\"ok\":false}" : json);
    }

    /* --------------------------------- queue -------------------------- */

    private async Task<RemoteResponse> QueueAsync()
    {
        var json = await AgentAsync("__zxr.queue()").ConfigureAwait(false);
        if (json is null)
        {
            return RemoteResponse.Json(503, "{\"ok\":false,\"error\":\"player-not-ready\"}");
        }

        return RemoteResponse.Json(200, RewriteCovers(json));
    }

    private async Task<RemoteResponse> JumpAsync(RemoteRequest request)
    {
        if (!int.TryParse(request.QueryValue("index"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var index) || index < 0)
        {
            return RemoteResponse.Json(400, "{\"ok\":false,\"error\":\"bad-index\"}");
        }

        var json = await AgentAsync($"__zxr.jump({index})").ConfigureAwait(false);
        HostLog.Info($"[remote] jump index={index} result={json}");
        return RemoteResponse.Json(200, json is null ? "{\"ok\":false}" : json);
    }

    /* --------------------------------- search ------------------------- */

    private async Task<RemoteResponse> SearchAsync(RemoteRequest request)
    {
        var query = (request.QueryValue("q") ?? string.Empty).Trim();
        if (query.Length is 0 or > 100)
        {
            return RemoteResponse.Json(400, "{\"ok\":false,\"error\":\"bad-query\"}");
        }

        var endpoint = App.Online?.Endpoint;
        if (endpoint is null)
        {
            return RemoteResponse.Json(503, "{\"ok\":false,\"error\":\"online-off\"}");
        }

        var tracks = new List<Dictionary<string, object?>>();
        var failures = new List<string>();
        var tasks = endpoint.Sources.Select(source => SearchSourceAsync(endpoint, source, query)).ToArray();
        foreach (var task in tasks)
        {
            var (items, failure) = await task.ConfigureAwait(false);
            if (failure is not null)
            {
                failures.Add(failure);
            }

            foreach (var item in items)
            {
                tracks.Add(item);
            }
        }

        HostLog.Info($"[remote] search q={query} results={tracks.Count} failed={failures.Count}");
        var payload = new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["q"] = query,
            ["tracks"] = tracks,
            ["failures"] = failures,
        };
        return RemoteResponse.Json(200, JsonSerializer.Serialize(payload));
    }

    private async Task<(List<Dictionary<string, object?>> Items, string? Failure)> SearchSourceAsync(OnlineEndpoint endpoint, string source, string query)
    {
        var items = new List<Dictionary<string, object?>>();
        try
        {
            var uri = $"http://127.0.0.1:{endpoint.Port}/api/search?source={WebUtility.UrlEncode(source)}&q={WebUtility.UrlEncode(query)}&limit=12&token={WebUtility.UrlEncode(endpoint.Token)}";
            using var response = await Http.GetAsync(uri).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return (items, source);
            }

            var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            using var document = JsonDocument.Parse(body);
            if (!document.RootElement.TryGetProperty("tracks", out var array) || array.ValueKind != JsonValueKind.Array)
            {
                return (items, source);
            }

            foreach (var track in array.EnumerateArray())
            {
                items.Add(new Dictionary<string, object?>
                {
                    ["source"] = Str(track, "source"),
                    ["id"] = Str(track, "id"),
                    ["title"] = Str(track, "title"),
                    ["artist"] = Str(track, "artist"),
                    ["album"] = Str(track, "album"),
                    ["durationMs"] = Num(track, "durationMs"),
                    ["cover"] = ProxyUrl(Str(track, "cover")),
                    ["playable"] = Bool(track, "playable"),
                    ["vip"] = track.TryGetProperty("vip", out var vip) && vip.ValueKind == JsonValueKind.True,
                });
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[remote] search source={source} failed err={exception.GetType().Name}");
            return (items, source);
        }

        return (items, null);
    }

    private async Task<RemoteResponse> PlayAsync(RemoteRequest request)
    {
        var title = (request.QueryValue("title") ?? string.Empty).Trim();
        var artist = (request.QueryValue("artist") ?? string.Empty).Trim();
        if (title.Length == 0)
        {
            return RemoteResponse.Json(400, "{\"ok\":false,\"error\":\"bad-title\"}");
        }

        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        var started = await AgentAsync($"__zxr.searchStart({JsonSerializer.Serialize(title + (artist.Length > 0 ? " " + artist : string.Empty))})").ConfigureAwait(false);
        if (started is null)
        {
            return RemoteResponse.Json(503, "{\"ok\":false,\"error\":\"player-not-ready\"}");
        }

        var state = "pending";
        for (var i = 0; i < 32 && state == "pending"; i += 1)
        {
            await Task.Delay(280).ConfigureAwait(false);
            var poll = await AgentAsync("__zxr.searchPoll()").ConfigureAwait(false);
            state = ReadState(poll) ?? "pending";
        }

        if (state is not ("done" or "timeout"))
        {
            HostLog.Warn($"[remote] play search state={state} title={title}");
            return RemoteResponse.Json(200, $"{{\"ok\":false,\"error\":\"search-{RemoteHttp.JsonEscape(state)}\"}}");
        }

        var clicked = await AgentAsync($"__zxr.play({JsonSerializer.Serialize(title)}, {JsonSerializer.Serialize(artist)})").ConfigureAwait(false);
        HostLog.Info($"[remote] play title={title} artist={artist} search={state} click={clicked} ms={stopwatch.ElapsedMilliseconds}");
        return RemoteResponse.Json(200, clicked ?? "{\"ok\":false}");
    }

    private static string? ReadState(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(json);
            return document.RootElement.TryGetProperty("state", out var state) ? state.GetString() : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /* --------------------------------- lyrics ------------------------- */

    private async Task<RemoteResponse> LyricsAsync()
    {
        var media = _media;
        var lyrics = await EnsureLyricsAsync(media.Title, media.Artist).ConfigureAwait(false);
        var position = media.PositionMs;
        if (lyrics is not null && lyrics.Lines.Count > 0)
        {
            var index = -1;
            for (var i = 0; i < lyrics.Lines.Count; i += 1)
            {
                if (lyrics.Lines[i].TimeMs <= position + 120)
                {
                    index = i;
                }
                else
                {
                    break;
                }
            }

            return RemoteResponse.Json(200, JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["mode"] = "full",
                ["source"] = lyrics.Source,
                ["positionMs"] = position,
                ["activeIndex"] = index,
                ["lines"] = lyrics.Lines.Select(line => new Dictionary<string, object?>
                {
                    ["t"] = line.TimeMs,
                    ["text"] = line.Text,
                    ["tr"] = line.Translation,
                }).ToList(),
                ["context"] = LyricContext(),
            }));
        }

        return RemoteResponse.Json(200, JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["mode"] = "context",
            ["positionMs"] = position,
            ["lines"] = Array.Empty<object>(),
            ["context"] = LyricContext(),
        }));
    }

    private async Task<RemoteLyrics?> EnsureLyricsAsync(string title, string artist)
    {
        if (string.IsNullOrWhiteSpace(title))
        {
            return null;
        }

        var key = title + "\u0001" + artist;
        lock (_identities)
        {
            if (_lyrics.TryGetValue(key, out var cached) &&
                Environment.TickCount64 - cached.At < LyricsCacheMs)
            {
                return cached.Lines.Count > 0 ? cached : null;
            }
        }

        var identity = await EnsureIdentityAsync(title, artist).ConfigureAwait(false);
        if (identity is null)
        {
            return null;
        }

        var endpoint = App.Online?.Endpoint;
        if (endpoint is null)
        {
            return null;
        }

        try
        {
            var uri = $"http://127.0.0.1:{endpoint.Port}/api/lyric?source={WebUtility.UrlEncode(identity.Source)}&id={WebUtility.UrlEncode(identity.Id)}&token={WebUtility.UrlEncode(endpoint.Token)}";
            using var response = await Http.GetAsync(uri).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            var lrc = Str(root, "lrc");
            var translation = Str(root, "translation");
            var merged = ParseLrc(lrc, string.IsNullOrWhiteSpace(translation) ? null : ParseLrc(translation, null));
            var lyrics = new RemoteLyrics
            {
                Source = identity.Source,
                At = Environment.TickCount64,
                Lines = merged,
            };
            lock (_identities)
            {
                _lyrics[key] = lyrics;
            }

            HostLog.Info($"[remote] lyrics source={identity.Source} lines={merged.Count} title={title}");
            return lyrics;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[remote] lyric failed err={exception.GetType().Name}");
            return null;
        }
    }

    private Task<RemoteTrackIdentity?> EnsureIdentityAsync(string title, string artist) =>
        ResolveIdentityAsync(title, artist);

    private async Task<RemoteTrackIdentity?> ResolveIdentityAsync(string title, string artist)
    {
        if (string.IsNullOrWhiteSpace(title))
        {
            return null;
        }

        var key = title + "\u0001" + artist;
        lock (_identities)
        {
            if (_identities.TryGetValue(key, out var known))
            {
                return known;
            }
        }

        var endpoint = App.Online?.Endpoint;
        if (endpoint is null)
        {
            return null;
        }

        foreach (var source in endpoint.Sources)
        {
            try
            {
                var uri = $"http://127.0.0.1:{endpoint.Port}/api/search?source={WebUtility.UrlEncode(source)}&q={WebUtility.UrlEncode(title)}&limit=8&token={WebUtility.UrlEncode(endpoint.Token)}";
                using var response = await Http.GetAsync(uri).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    continue;
                }

                var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                using var document = JsonDocument.Parse(body);
                if (!document.RootElement.TryGetProperty("tracks", out var tracks) || tracks.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                var fallback = (RemoteTrackIdentity?)null;
                foreach (var track in tracks.EnumerateArray())
                {
                    var trackTitle = Str(track, "title");
                    if (!string.Equals(trackTitle, title, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    var trackArtist = Str(track, "artist");
                    var candidate = new RemoteTrackIdentity(Str(track, "source"), Str(track, "id"));
                    if (string.Equals(trackArtist, artist, StringComparison.OrdinalIgnoreCase) ||
                        trackArtist.Contains(artist, StringComparison.OrdinalIgnoreCase))
                    {
                        lock (_identities)
                        {
                            _identities[key] = candidate;
                        }

                        return candidate;
                    }

                    fallback ??= candidate;
                }

                if (fallback is not null)
                {
                    lock (_identities)
                    {
                        _identities[key] = fallback;
                    }

                    return fallback;
                }
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[remote] identity source={source} failed err={exception.GetType().Name}");
            }
        }

        lock (_identities)
        {
            _identities[key] = null;
        }

        return null;
    }

    private static List<RemoteLyricLine> ParseLrc(string? lrc, List<RemoteLyricLine>? translation)
    {
        var lines = new List<RemoteLyricLine>();
        if (string.IsNullOrWhiteSpace(lrc))
        {
            return lines;
        }

        var translations = new Dictionary<int, string>();
        if (translation is not null)
        {
            foreach (var item in translation)
            {
                translations[(int)item.TimeMs] = item.Text;
            }
        }

        foreach (var raw in lrc.Replace("\r", string.Empty).Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0)
            {
                continue;
            }

            var matches = Stamp.Matches(line);
            if (matches.Count == 0)
            {
                continue;
            }

            var text = Stamp.Replace(line, string.Empty).Trim();
            foreach (Match match in matches)
            {
                var minutes = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
                var seconds = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
                var fraction = match.Groups[3].Value;
                var millis = fraction.Length switch
                {
                    0 => 0,
                    1 => int.Parse(fraction, CultureInfo.InvariantCulture) * 100,
                    2 => int.Parse(fraction, CultureInfo.InvariantCulture) * 10,
                    _ => int.Parse(fraction[..3], CultureInfo.InvariantCulture),
                };
                var timeMs = ((minutes * 60) + seconds) * 1000 + millis;
                if (text.Length == 0)
                {
                    continue;
                }

                lines.Add(new RemoteLyricLine(timeMs, text, translations.TryGetValue(timeMs, out var tr) ? tr : null));
            }
        }

        lines.Sort((left, right) => left.TimeMs.CompareTo(right.TimeMs));
        return lines;
    }

    private static readonly Regex Stamp = new(@"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]", RegexOptions.Compiled);

    /* --------------------------------- proxy -------------------------- */
    private async Task<RemoteResponse> ProxyAsync(RemoteRequest request)
    {
        var raw = request.QueryValue("u");
        var endpoint = App.Online?.Endpoint;
        if (string.IsNullOrWhiteSpace(raw) || endpoint is null ||
            !Uri.TryCreate(raw, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) ||
            uri.Port != endpoint.Port ||
            (uri.Host != "127.0.0.1" && uri.Host != "localhost"))
        {
            return RemoteResponse.Text(400, "bad-url");
        }

        try
        {
            using var response = await Http.GetAsync(uri).ConfigureAwait(false);
            var bytes = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
            var contentType = response.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";
            if (!response.IsSuccessStatusCode)
            {
                return RemoteResponse.Text((int)response.StatusCode, "upstream");
            }

            return RemoteResponse.Bytes(contentType, bytes);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[remote] proxy failed err={exception.GetType().Name}");
            return RemoteResponse.Text(502, "upstream-failed");
        }
    }

    /* --------------------------------- helpers ------------------------ */

    private string RewriteCovers(string json)
    {
        var endpoint = App.Online?.Endpoint;
        if (endpoint is null)
        {
            return json;
        }

        // 队列行只有标题/歌手，没有封面 URL；这里只做一次保险性替换。
        return json.Replace($"http://127.0.0.1:{endpoint.Port}/", $"{BasePrefix}proxy?u=", StringComparison.Ordinal);
    }

    private static string Str(JsonElement root, string name) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static long Num(JsonElement root, string name)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty(name, out var value))
        {
            return 0;
        }

        return value.ValueKind switch
        {
            JsonValueKind.Number => value.TryGetInt64(out var l) ? l : (long)value.GetDouble(),
            JsonValueKind.String => long.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0,
            _ => 0,
        };
    }

    private static bool Bool(JsonElement root, string name) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var value) &&
        (value.ValueKind == JsonValueKind.True || (value.ValueKind == JsonValueKind.String && value.GetString() == "1"));

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        StopListener("dispose");
        _tick.Dispose();
        if (_core is not null)
        {
            try
            {
                _core.WebMessageReceived -= OnWebMessage;
                _core.NavigationCompleted -= OnNavigationCompleted;
            }
            catch
            {
                // WebView2 已销毁。
            }
        }

        _core = null;
        _webView = null;
    }

    private sealed class RemoteMedia
    {
        internal static readonly RemoteMedia Empty = new();

        internal string Title { get; init; } = string.Empty;
        internal string Artist { get; init; } = string.Empty;
        internal string Album { get; init; } = string.Empty;
        internal string CoverUrl { get; init; } = string.Empty;
        internal long DurationMs { get; init; }
        internal long PositionMs { get; init; }
        internal bool Playing { get; init; }
        internal bool Transitioning { get; init; }
    }

    private sealed class RemoteLyricFrame
    {
        internal string Now { get; init; } = string.Empty;
        internal string Previous { get; init; } = string.Empty;
        internal string Next { get; init; } = string.Empty;
        internal string Translation { get; init; } = string.Empty;
        internal long PositionMs { get; init; }
        internal bool Playing { get; init; }
    }

    private sealed class RemoteAgentState
    {
        internal static readonly RemoteAgentState Empty = new();

        internal bool Attached { get; init; }
        internal bool HasPlayer { get; init; }
        internal string Mode { get; init; } = string.Empty;
        internal string ModeTitle { get; init; } = string.Empty;
        internal double? Volume { get; init; }
        internal bool Muted { get; init; }
    }

    private sealed record RemoteTrackIdentity(string Source, string Id);

    private sealed class RemoteLyrics
    {
        internal string Source { get; init; } = string.Empty;
        internal long At { get; init; }
        internal List<RemoteLyricLine> Lines { get; init; } = [];
    }

    private sealed record RemoteLyricLine(long TimeMs, string Text, string? Translation);
}
