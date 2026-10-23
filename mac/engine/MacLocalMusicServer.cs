// mac 版：由 src/Zilux2/Online/LocalMusicServer.cs 复制改写（mac/engine/tools/port_sources.py 生成）。
// 与 Windows 版的差异只有两处：
//   1. /api/cover/colors 不再依赖 WPF 位图解码，固定返回 200 空结果（前端 fallbackColors 兜底）；
//   2. 非 /api/ 的 GET/HEAD 请求从 --web-root 目录提供前端静态文件。
// 其余 /api/* 路由与行为保持原样。
using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Zilux2.Online.Account;
using Zilux2.Online.Library;

namespace Zilux2.Online;

// Loopback-only HTTP surface from docs/zilux2-online-music.md §5. Bound to 127.0.0.1 on a
// dynamic port; the page receives port+token through the "online" host message.
internal sealed class LocalMusicServer : IDisposable
{
    private static readonly TimeSpan SearchTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan LyricTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan ResolveTimeout = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan StreamConnectTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan CoverTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan AccountQrTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan CoverCacheLifetime = TimeSpan.FromHours(1);
    private const int CoverCacheLimit = 200;
    private const int StreamBufferSize = 32 * 1024;
    private const int MaxAccountImportBodyBytes = 16 * 1024;

    private readonly IReadOnlyDictionary<string, IOnlineMusicProvider> _providers;
    private readonly IReadOnlyList<string> _sources;
    private readonly AccountService? _accounts;
    private readonly LibraryService? _library;
    private readonly byte[] _tokenBytes;
    private readonly string _token;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly ConcurrentDictionary<string, CoverCacheEntry> _coverCache = new(StringComparer.Ordinal);
    private readonly RecentPlayStore _recent = new();
    private HttpListener? _listener;
    private Task? _acceptLoop;
    private int _disposed;

    public LocalMusicServer(
        IReadOnlyDictionary<string, IOnlineMusicProvider> providers,
        IReadOnlyList<string> sources,
        string token,
        AccountService? accounts = null,
        LibraryService? library = null)
    {
        _providers = providers;
        _sources = sources;
        _token = token;
        _tokenBytes = Encoding.ASCII.GetBytes(token);
        _accounts = accounts;
        _library = library;
    }

    public int Port { get; private set; }

    // mac 版新增：web 前端静态文件根目录（见下方静态文件服务）。
    // 由 Program 在启动服务前设置，避免改动构造签名（OnlineMusicService 仍按原签名 new）。
    public int Start()
    {
        for (var attempt = 0; attempt < 5; attempt++)
        {
            var port = FindFreeLoopbackPort();
            var listener = new HttpListener();
            listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            try
            {
                listener.Start();
            }
            catch (HttpListenerException exception)
            {
                listener.Close();
                OnlineHttp.Warn($"bind 127.0.0.1:{port} failed (attempt {attempt + 1}): {exception.Message}");
                continue;
            }

            Port = port;
            _listener = listener;
            _acceptLoop = Task.Run(() => AcceptLoopAsync(listener));
            OnlineHttp.Info($"listening on 127.0.0.1:{port} sources={string.Join(",", _sources)}");
            return port;
        }

        throw new InvalidOperationException("could not bind a loopback port for the online music service");
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1)
        {
            return;
        }

        try
        {
            _shutdown.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // Already torn down.
        }

        try
        {
            _listener?.Stop();
            _listener?.Close();
        }
        catch (Exception exception)
        {
            OnlineHttp.Warn($"listener close failed: {exception.Message}");
        }

        try
        {
            _acceptLoop?.Wait(TimeSpan.FromSeconds(2));
        }
        catch (AggregateException)
        {
            // The loop is allowed to die with the listener; nothing left to wait for.
        }

        _coverCache.Clear();
        OnlineHttp.Info("server stopped");
    }

    private static int FindFreeLoopbackPort()
    {
        using var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    private async Task AcceptLoopAsync(HttpListener listener)
    {
        while (!_shutdown.IsCancellationRequested)
        {
            HttpListenerContext context;
            try
            {
                context = await listener.GetContextAsync().ConfigureAwait(false);
            }
            catch (HttpListenerException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch (InvalidOperationException)
            {
                break;
            }

            // Never await request handling here: a long audio stream must not block the accept loop.
            _ = Task.Run(() => HandleAsync(context), CancellationToken.None);
        }
    }

    private async Task HandleAsync(HttpListenerContext context)
    {
        var request = context.Request;
        var method = request.HttpMethod;
        var path = request.Url?.AbsolutePath ?? "/";
        var stopwatch = Stopwatch.StartNew();
        var status = 0;
        try
        {
            ApplyCors(context.Response);

            if (string.Equals(method, "OPTIONS", StringComparison.OrdinalIgnoreCase))
            {
                status = 204;
                context.Response.StatusCode = 204;
                return;
            }

            var isGet = string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase);
            var isPost = string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase);
            var isHead = string.Equals(method, "HEAD", StringComparison.OrdinalIgnoreCase);
            // HEAD 只给静态资源用；HttpListener 不允许 HEAD 响应写 body，/api/* 的 HEAD 直接回 405。
            if (isHead && path.StartsWith("/api/", StringComparison.Ordinal))
            {
                status = 405;
                context.Response.StatusCode = 405;
                return;
            }

            if (!isGet && !isPost && !isHead)
            {
                status = WriteError(context, 405, "bad-request", "只支持 GET/POST 请求");
                return;
            }

            status = path switch
            {
                "/api/health" => isGet ? WriteHealth(context) : MethodNotAllowed(context),
                "/api/sources" => isGet ? WriteSources(context) : MethodNotAllowed(context),
                "/api/search" => isGet ? await HandleSearchAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/lyric" => isGet ? await HandleLyricAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/stream" => isGet ? await HandleStreamAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/cover" => isGet ? await HandleCoverAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/cover/colors" => isGet ? HandleCoverColorsAsync(context) : MethodNotAllowed(context),
                "/api/playlists/hot" => isGet ? await HandleHotPlaylistsAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/stream/info" => isGet ? await HandleStreamInfoAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/account" => isGet ? WriteAccount(context) : MethodNotAllowed(context),
                "/api/account/login/qr" => isPost ? await HandleAccountLoginQrAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/account/login/status" => isGet ? await HandleAccountLoginStatusAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/account/logout" => isPost ? HandleAccountLogout(context) : MethodNotAllowed(context),
                "/api/account/import" => isPost ? await HandleAccountImportAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/library/overview" => isGet ? await HandleLibraryOverviewAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/library/playlist" => isGet ? await HandleLibraryPlaylistAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/library/feed" => isGet ? await HandleLibraryFeedAsync(context, CancellationToken.None).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/library/recent/merged" => isGet ? await HandleRecentMergedAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/library/recent" => isGet
                    ? HandleRecentList(context)
                    : isPost
                        ? await HandleRecentRecordAsync(context).ConfigureAwait(false)
                        : MethodNotAllowed(context),
                "/api/library/refresh" => isGet ? HandleLibraryRefresh(context) : MethodNotAllowed(context),
                "/api/library/liked" => isGet ? await HandleLibraryLikedAsync(context, CancellationToken.None).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/library/like" => isPost ? await HandleLibraryLikeAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),
                "/api/library/unlike" => isPost ? await HandleLibraryUnlikeAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),
                _ when !path.StartsWith("/api/", StringComparison.Ordinal) => await HandleStaticAsync(context).ConfigureAwait(false),
                _ => WriteError(context, 404, "not-found", "未知接口"),
            };
        }
        catch (Exception exception)
        {
            status = status == 0 ? 500 : status;
            OnlineHttp.Error($"request failed {method} {path}", exception);
            try
            {
                WriteError(context, 500, "internal-error", "宿主内部错误");
            }
            catch (Exception writeException)
            {
                OnlineHttp.Warn($"error response failed: {writeException.GetType().Name}");
            }
        }
        finally
        {
            try
            {
                context.Response.Close();
            }
            catch (Exception closeException)
            {
                OnlineHttp.Warn($"response close failed: {closeException.GetType().Name}");
            }

            OnlineHttp.Info($"req {method} {path} status={status} {stopwatch.ElapsedMilliseconds}ms");
        }
    }

    private static int MethodNotAllowed(HttpListenerContext context) =>
        WriteError(context, 405, "bad-request", "该接口不支持此请求方法");

    // Contract docs/zilux2-account-login.md §1: account routes. DTOs are shaped by AccountService,
    // so the server only validates the token/parameters and writes them out.
    private int WriteAccount(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var accounts = _accounts;
        if (accounts is null)
        {
            return WriteError(context, 503, "account-unavailable", "账号服务不可用");
        }

        var list = accounts.BuildAccountList();
        WriteJson(context, 200, JsonSerializer.Serialize(list, AccountJsonContext.Default.AccountListResponse));
        return 200;
    }

    private async Task<int> HandleAccountLoginQrAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var accounts = _accounts;
        if (accounts is null)
        {
            return WriteError(context, 503, "account-unavailable", "账号服务不可用");
        }

        var source = (context.Request.QueryString["source"] ?? string.Empty).Trim();
        if (!AccountSources.IsKnown(source))
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
            timeout.CancelAfter(AccountQrTimeout);
            var qr = await accounts.CreateLoginQrAsync(source, timeout.Token).ConfigureAwait(false);
            WriteJson(context, 200, JsonSerializer.Serialize(qr, AccountJsonContext.Default.LoginQrResponse));
            return 200;
        }
        catch (AccountException exception)
        {
            OnlineHttp.Error($"api account qr failed source={source} code={exception.Code}", exception);
            return WriteError(context, exception.StatusCode, exception.Code, exception.Message);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error($"api account qr failed source={source}", exception);
            return WriteError(context, 502, "upstream-failed", "登录二维码获取失败，请稍后重试");
        }
    }

    private async Task<int> HandleAccountLoginStatusAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var accounts = _accounts;
        if (accounts is null)
        {
            return WriteError(context, 503, "account-unavailable", "账号服务不可用");
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim();
        if (!AccountSources.IsKnown(source))
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        var key = (query["key"] ?? string.Empty).Trim();
        if (key.Length is 0 or > 64)
        {
            return WriteError(context, 400, "bad-request", "key 参数非法");
        }

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
            timeout.CancelAfter(AccountQrTimeout);
            var status = await accounts.PollLoginAsync(source, key, timeout.Token).ConfigureAwait(false);
            WriteJson(context, 200, JsonSerializer.Serialize(status, AccountJsonContext.Default.LoginStatusResponse));
            return 200;
        }
        catch (AccountException exception)
        {
            OnlineHttp.Error($"api account status failed source={source} code={exception.Code}", exception);
            return WriteError(context, exception.StatusCode, exception.Code, exception.Message);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error($"api account status failed source={source}", exception);
            return WriteError(context, 502, "upstream-failed", "登录状态查询失败，请稍后重试");
        }
    }

    private int HandleAccountLogout(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var accounts = _accounts;
        if (accounts is null)
        {
            return WriteError(context, 503, "account-unavailable", "账号服务不可用");
        }

        var source = (context.Request.QueryString["source"] ?? string.Empty).Trim();
        if (!AccountSources.IsKnown(source))
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        accounts.Logout(source);
        var response = new LogoutResponse();
        WriteJson(context, 200, JsonSerializer.Serialize(response, AccountJsonContext.Default.LogoutResponse));
        return 200;
    }

    // POST /api/account/import: cookie paste fallback. Validation happens upstream before anything is
    // persisted, so a bad paste never replaces a working session.
    private async Task<int> HandleAccountImportAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var accounts = _accounts;
        if (accounts is null)
        {
            return WriteError(context, 503, "account-unavailable", "账号服务不可用");
        }

        var body = await ReadBodyAsync(context.Request, MaxAccountImportBodyBytes).ConfigureAwait(false);
        if (body is null)
        {
            return WriteError(context, 400, "bad-request", "请求体必须是不超过 16KB 的 JSON");
        }

        string source;
        string cookie;
        try
        {
            using var document = JsonDocument.Parse(body);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                return WriteError(context, 400, "bad-request", "请求体必须是 JSON 对象");
            }

            var root = document.RootElement;
            source = (root.TryGetProperty("source", out var sourceElement) && sourceElement.ValueKind == JsonValueKind.String
                    ? sourceElement.GetString() ?? string.Empty
                    : string.Empty)
                .Trim();
            cookie = root.TryGetProperty("cookie", out var cookieElement) && cookieElement.ValueKind == JsonValueKind.String
                ? cookieElement.GetString() ?? string.Empty
                : string.Empty;
        }
        catch (JsonException)
        {
            return WriteError(context, 400, "bad-request", "请求体不是合法 JSON");
        }

        if (!AccountSources.IsKnown(source))
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        if (cookie.Trim().Length == 0)
        {
            return WriteError(context, 400, "invalid-cookie", "缺少 cookie 参数");
        }

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
            timeout.CancelAfter(AccountQrTimeout);
            var list = await accounts.ImportAsync(source, cookie, timeout.Token).ConfigureAwait(false);
            try
            {
                _library?.Refresh(source);
            }
            catch (Exception refreshException)
            {
                OnlineHttp.Warn($"api account import library refresh failed: {refreshException.GetType().Name}");
            }

            WriteJson(context, 200, JsonSerializer.Serialize(list, AccountJsonContext.Default.AccountListResponse));
            return 200;
        }
        catch (AccountException exception)
        {
            OnlineHttp.Error($"api account import failed source={source} code={exception.Code}", exception);
            return WriteError(context, exception.StatusCode, exception.Code, exception.Message);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error($"api account import failed source={source}", exception);
            return WriteError(context, 502, "upstream-failed", "cookie 校验失败，请稍后重试");
        }
    }

    // The only request body the loopback API accepts is the cookie import JSON; keep it bounded so a
    // misbehaving client cannot exhaust memory.
    private static async Task<string?> ReadBodyAsync(HttpListenerRequest request, int maxBytes)
    {
        if (request.ContentLength64 > maxBytes)
        {
            return null;
        }

        try
        {
            using var buffer = new MemoryStream();
            var chunk = new byte[8192];
            int read;
            while ((read = await request.InputStream.ReadAsync(chunk, 0, chunk.Length).ConfigureAwait(false)) > 0)
            {
                if (buffer.Length + read > maxBytes)
                {
                    return null;
                }

                buffer.Write(chunk, 0, read);
            }

            return buffer.Length == 0 ? null : Encoding.UTF8.GetString(buffer.ToArray());
        }
        catch (IOException)
        {
            return null;
        }
    }

    /// <summary>返回实际下发的音质（供界面显示「现在播的是不是无损」）。</summary>
    private async Task<int> HandleStreamInfoAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim();
        var provider = GetProvider(source);
        if (provider is null)
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        var id = (query["id"] ?? string.Empty).Trim();
        if (id.Length is 0 or > 200)
        {
            return WriteError(context, 400, "bad-request", "id 参数非法");
        }

        var quality = NormalizeQuality(query["quality"]);
        try
        {
            var resolution = await provider.ResolveStreamAsync(id, quality, _shutdown.Token).ConfigureAwait(false);
            if (!resolution.IsPlayable)
            {
                return WriteError(context, 502, "upstream-error", resolution.NotPlayableMessage);
            }

            WriteJson(context, 200, JsonSerializer.Serialize(new
            {
                source,
                id,
                requested = quality,
                quality = resolution.QualityLabel,
                bitrate = resolution.Bitrate,
                format = resolution.Format,
            }));
            return 200;
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error("api stream/info failed", exception);
            return WriteError(context, 502, "upstream-error", "获取音质信息失败：" + OnlineHttp.Describe(exception));
        }
    }

    private async Task<int> HandleHotPlaylistsAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? "qq").Trim().ToLowerInvariant();
        if (source != AccountSources.Qq && source != AccountSources.Netease)
        {
            return WriteError(context, 400, "bad-request", "热门歌单目前支持 QQ 音乐与网易云音乐");
        }

        var limit = 24;
        if (query["limit"] is { Length: > 0 } limitText &&
            (!int.TryParse(limitText, NumberStyles.Integer, CultureInfo.InvariantCulture, out limit) || limit is < 1 or > 60))
        {
            return WriteError(context, 400, "bad-request", "limit 参数必须在 1..60");
        }

        try
        {
            List<HotPlaylistItem> items;
            if (source == AccountSources.Netease)
            {
                var neteaseProvider = (NeteaseProvider)GetProvider(AccountSources.Netease)!;
                items = await neteaseProvider.GetHotPlaylistsAsync(limit, _shutdown.Token).ConfigureAwait(false);
            }
            else
            {
                var qqProvider = (QqProvider)GetProvider(AccountSources.Qq)!;
                items = await qqProvider.GetHotPlaylistsAsync(limit, _shutdown.Token).ConfigureAwait(false);
            }

            var playlists = items
                .Select(item => new
                {
                    source,
                    id = item.Id,
                    title = item.Title,
                    cover = BuildCoverUrl(source, item.ImageUrl),
                    count = item.ListenCount,
                    creator = item.Creator,
                })
                .ToList();
            WriteJson(context, 200, JsonSerializer.Serialize(new { source, playlists }));
            return 200;
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error("api playlists/hot failed", exception);
            return WriteError(context, 502, "upstream-error", "热门歌单拉取失败：" + OnlineHttp.Describe(exception));
        }
    }

    private async Task<int> HandleSearchAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim();
        var provider = GetProvider(source);
        if (provider is null)
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        var searchText = (query["q"] ?? string.Empty).Trim();
        if (searchText.Length is 0 or > 100)
        {
            return WriteError(context, 400, "bad-request", "q 参数长度必须在 1..100");
        }

        var limit = 20;
        if (query["limit"] is { Length: > 0 } limitText &&
            (!int.TryParse(limitText, NumberStyles.Integer, CultureInfo.InvariantCulture, out limit) || limit is < 1 or > 50))
        {
            return WriteError(context, 400, "bad-request", "limit 参数必须在 1..50");
        }

        var stopwatch = Stopwatch.StartNew();
        try
        {
            var tracks = await provider.SearchAsync(searchText, limit, _shutdown.Token).ConfigureAwait(false);
            var response = new SearchResponse
            {
                Source = provider.Name,
                Query = searchText,
                Tracks = tracks
                    .Select(track => track with { Cover = BuildCoverUrl(track.Source, track.CoverKey) })
                    .ToList(),
                TookMs = stopwatch.ElapsedMilliseconds,
            };
            WriteJson(context, 200, JsonSerializer.Serialize(response, OnlineJsonContext.Default.SearchResponse));
            return 200;
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error($"api search failed source={provider.Name} q={searchText}", exception);
            return WriteError(
                context,
                502,
                "upstream-failed",
                provider.Name == "netease" ? "网易云搜索失败，请稍后重试" : "QQ 音乐搜索失败，请稍后重试");
        }
    }

    private async Task<int> HandleLyricAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim();
        var provider = GetProvider(source);
        if (provider is null)
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        var id = (query["id"] ?? string.Empty).Trim();
        if (!IsValidTrackId(provider.Name, id))
        {
            return WriteError(context, 400, "bad-request", "id 参数非法");
        }

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
            timeout.CancelAfter(LyricTimeout);
            var lyric = await provider.GetLyricAsync(id, timeout.Token).ConfigureAwait(false);
            var response = new LyricResponse
            {
                Source = provider.Name,
                Id = id,
                Lrc = lyric.Lrc,
                Translation = lyric.Translation,
                HasTranslation = !string.IsNullOrWhiteSpace(lyric.Translation),
                Yrc = lyric.Yrc,
                HasYrc = !string.IsNullOrWhiteSpace(lyric.Yrc),
                Qrc = lyric.Qrc,
                HasQrc = !string.IsNullOrWhiteSpace(lyric.Qrc),
            };
            WriteJson(context, 200, JsonSerializer.Serialize(response, OnlineJsonContext.Default.LyricResponse));
            return 200;
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error($"api lyric failed source={provider.Name} id={id}", exception);
            return WriteError(context, 502, "upstream-failed", "歌词获取失败，请稍后重试");
        }
    }

    private static string NormalizeQuality(string? value)
    {
        var trimmed = (value ?? string.Empty).Trim().ToLowerInvariant();
        return trimmed is "standard" or "high" or "lossless" ? trimmed : "high";
    }

    private async Task<int> HandleStreamAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim();
        var provider = GetProvider(source);
        if (provider is null)
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        var id = (query["id"] ?? string.Empty).Trim();
        if (!IsValidTrackId(provider.Name, id))
        {
            return WriteError(context, 400, "bad-request", "id 参数非法");
        }

        StreamResolution resolution;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
            timeout.CancelAfter(ResolveTimeout);
            resolution = await provider
                .ResolveStreamAsync(id, NormalizeQuality(query["quality"]), timeout.Token)
                .ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error($"stream resolve failed source={source} id={id}", exception);
            return WriteError(context, 502, "upstream-failed", "获取播放地址失败，请稍后重试");
        }

        if (!resolution.IsPlayable)
        {
            return WriteError(context, 403, "not-playable", resolution.NotPlayableMessage);
        }

        var upstreamRequest = OnlineHttp.NewRequest(HttpMethod.Get, resolution.Url, null);
        foreach (var header in resolution.Headers)
        {
            upstreamRequest.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }

        // Contract §1: Range passthrough makes seeking work; the host never buffers whole songs.
        var range = context.Request.Headers["Range"];
        if (!string.IsNullOrEmpty(range))
        {
            upstreamRequest.Headers.TryAddWithoutValidation("Range", range);
        }

        var stopwatch = Stopwatch.StartNew();
        using var connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
        connectTimeout.CancelAfter(StreamConnectTimeout);

        HttpResponseMessage upstream;
        try
        {
            using (upstreamRequest)
            {
                upstream = await OnlineHttp.Client
                    .SendAsync(upstreamRequest, HttpCompletionOption.ResponseHeadersRead, connectTimeout.Token)
                    .ConfigureAwait(false);
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error($"stream connect failed source={source} id={id}", exception);
            return WriteError(context, 502, "upstream-failed", "音频源连接失败，请稍后重试");
        }

        // Headers are in; the body may stream for minutes, so the connect timeout must not fire.
        connectTimeout.CancelAfter(Timeout.InfiniteTimeSpan);

        using (upstream)
        {
            var upstreamStatus = (int)upstream.StatusCode;
            if (upstreamStatus is not (200 or 206))
            {
                OnlineHttp.Error($"stream upstream status={upstreamStatus} source={source} id={id}");
                return WriteError(context, 502, "upstream-failed", "音频源返回错误，请稍后重试");
            }

            var response = context.Response;
            response.StatusCode = upstreamStatus;
            var contentType = upstream.Content.Headers.ContentType?.ToString();
            response.ContentType = string.IsNullOrEmpty(contentType) ? "application/octet-stream" : contentType;
            var contentLength = upstream.Content.Headers.ContentLength;
            if (contentLength.HasValue)
            {
                response.ContentLength64 = contentLength.Value;
            }

            var contentRange = upstream.Content.Headers.ContentRange?.ToString();
            if (!string.IsNullOrEmpty(contentRange))
            {
                response.Headers["Content-Range"] = contentRange;
            }

            response.Headers["Accept-Ranges"] = "bytes";

            var buffer = ArrayPool<byte>.Shared.Rent(StreamBufferSize);
            var bytesCopied = 0L;
            try
            {
                await using var bodyStream = await upstream.Content.ReadAsStreamAsync(_shutdown.Token).ConfigureAwait(false);
                var output = response.OutputStream;
                while (true)
                {
                    var read = await bodyStream
                        .ReadAsync(buffer.AsMemory(0, StreamBufferSize), _shutdown.Token)
                        .ConfigureAwait(false);
                    if (read <= 0)
                    {
                        break;
                    }

                    await output.WriteAsync(buffer.AsMemory(0, read), _shutdown.Token).ConfigureAwait(false);
                    bytesCopied += read;
                }

                await output.FlushAsync(_shutdown.Token).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is IOException or HttpListenerException or ObjectDisposedException or OperationCanceledException)
            {
                // The page aborted the audio element: normal during seek/close, not an error.
                OnlineHttp.Warn($"stream aborted source={source} id={id} after {bytesCopied}B: {exception.GetType().Name}");
                return upstreamStatus;
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(buffer);
            }

            OnlineHttp.Info(
                $"GET stream source={source} id={id} upstream={upstreamStatus} bytes={bytesCopied} {stopwatch.ElapsedMilliseconds}ms");
            return upstreamStatus;
        }
    }

    // Contract docs/zilux2-library.md §1: personal library routes. LibraryService keeps the platform
    // fields raw (CoverKey), the server rewrites covers into loopback /api/cover URLs.
    private async Task<int> HandleLibraryOverviewAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var library = _library;
        if (library is null)
        {
            return WriteError(context, 503, "library-unavailable", "个人音乐库服务不可用");
        }

        try
        {
            var overview = await library.GetOverviewAsync(_shutdown.Token).ConfigureAwait(false);
            var mapped = MapOverview(overview);
            WriteJson(context, 200, JsonSerializer.Serialize(mapped, LibraryJsonContext.Default.LibraryOverview));
            return 200;
        }
        catch (OnlineUpstreamException exception)
        {
            return WriteLibraryError(context, exception);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error("GET library/overview failed", exception);
            return WriteError(context, 502, "upstream-failed", "个人音乐库读取失败，请稍后重试");
        }
    }

    private async Task<int> HandleLibraryPlaylistAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var library = _library;
        if (library is null)
        {
            return WriteError(context, 503, "library-unavailable", "个人音乐库服务不可用");
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim().ToLowerInvariant();
        if (!LibraryService.IsKnownSource(source))
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        var id = (query["id"] ?? string.Empty).Trim();
        if (id.Length == 0)
        {
            return WriteError(context, 400, "bad-request", "缺少 id 参数");
        }

        var offset = 0;
        var offsetRaw = query["offset"];
        if (!string.IsNullOrEmpty(offsetRaw) && (!int.TryParse(offsetRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out offset) || offset < 0))
        {
            return WriteError(context, 400, "bad-request", "offset 参数非法");
        }

        var limit = 200;
        var limitRaw = query["limit"];
        if (!string.IsNullOrEmpty(limitRaw) && (!int.TryParse(limitRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out limit) || limit <= 0))
        {
            return WriteError(context, 400, "bad-request", "limit 参数非法");
        }

        try
        {
            var detail = await library.GetPlaylistAsync(source, id, offset, limit, _shutdown.Token).ConfigureAwait(false);
            var mapped = MapPlaylistDetail(detail);
            WriteJson(context, 200, JsonSerializer.Serialize(mapped, LibraryJsonContext.Default.PlaylistDetail));
            return 200;
        }
        catch (OnlineUpstreamException exception)
        {
            return WriteLibraryError(context, exception);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error($"GET library/playlist source={source} failed", exception);
            return WriteError(context, 502, "upstream-failed", "歌单读取失败，请稍后重试");
        }
    }

    private async Task<int> HandleLibraryLikedAsync(HttpListenerContext context, CancellationToken token)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = query["source"] ?? string.Empty;
        var id = query["id"] ?? string.Empty;
        var ids = query["ids"] ?? string.Empty;
        if (source.Length == 0 || (id.Length == 0 && ids.Length == 0))
        {
            return WriteError(context, 400, "bad-request", "缺少 source 或 id/ids 参数");
        }

        var library = _library;
        if (library is null)
        {
            return WriteError(context, 503, "not-ready", "在线服务尚未就绪");
        }

        try
        {
            // 批量模式：搜索结果一次点亮所有收藏按钮（各音源内部合并请求）。
            if (ids.Length > 0)
            {
                var list = ids.Split([',', '|'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                var many = await library.CheckLikedManyAsync(source, list, token).ConfigureAwait(false);
                WriteJson(context, 200, JsonSerializer.Serialize(new { liked = many }));
                return 200;
            }

            var liked = await library.CheckLikedAsync(source, id, token).ConfigureAwait(false);
            WriteJson(context, 200, JsonSerializer.Serialize(new { liked }));
            return 200;
        }
        catch (OnlineUpstreamException error)
        {
            return WriteError(context, error.StatusCode, "upstream-failed", error.Message);
        }
    }

    private int HandleRecentList(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim().ToLowerInvariant();
        if (source.Length > 0 && !LibraryService.IsKnownSource(source))
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        var limit = 30;
        var limitRaw = query["limit"];
        if (!string.IsNullOrEmpty(limitRaw)
            && (!int.TryParse(limitRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out limit) || limit <= 0))
        {
            return WriteError(context, 400, "bad-request", "limit 参数非法");
        }

        var tracks = _recent.List(source, limit);
        WriteJson(context, 200, JsonSerializer.Serialize(new { source, tracks }));
        return 200;
    }

    private async Task<int> HandleRecentRecordAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        using var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8);
        var body = await reader.ReadToEndAsync().ConfigureAwait(false);
        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            var source = root.TryGetProperty("source", out var sourceNode) ? sourceNode.GetString() ?? string.Empty : string.Empty;
            var id = root.TryGetProperty("id", out var idNode) ? idNode.GetString() ?? string.Empty : string.Empty;
            if ((!LibraryService.IsKnownSource(source) && !string.Equals(source, "local", StringComparison.Ordinal)) || id.Length == 0)
            {
                return WriteError(context, 400, "bad-request", "source/id 参数非法");
            }

            var track = new OnlineTrack
            {
                Source = source,
                Id = id,
                Title = root.TryGetProperty("title", out var titleNode) ? titleNode.GetString() ?? string.Empty : string.Empty,
                Artist = root.TryGetProperty("artist", out var artistNode) ? artistNode.GetString() ?? string.Empty : string.Empty,
                Album = root.TryGetProperty("album", out var albumNode) ? albumNode.GetString() ?? string.Empty : string.Empty,
                DurationMs = root.TryGetProperty("durationMs", out var durationNode) && durationNode.TryGetInt64(out var duration) ? duration : 0,
                Cover = root.TryGetProperty("cover", out var coverNode) ? coverNode.GetString() ?? string.Empty : string.Empty,
                Playable = true,
            };
            _recent.Record(track);
            WriteJson(context, 200, JsonSerializer.Serialize(new { ok = true }));
            return 200;
        }
        catch (JsonException)
        {
            return WriteError(context, 400, "bad-request", "请求体不是合法 JSON");
        }
    }

    private async Task<int> HandleLibraryFeedAsync(HttpListenerContext context, CancellationToken token)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim().ToLowerInvariant();
        if (!LibraryService.IsKnownSource(source))
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        var kind = (query["kind"] ?? "daily").Trim().ToLowerInvariant();
        var limit = 60;
        var limitRaw = query["limit"];
        if (!string.IsNullOrEmpty(limitRaw)
            && (!int.TryParse(limitRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out limit) || limit <= 0))
        {
            return WriteError(context, 400, "bad-request", "limit 参数非法");
        }

        var library = _library;
        if (library is null)
        {
            return WriteError(context, 503, "not-ready", "在线服务尚未就绪");
        }

        if (string.Equals(kind, "recent", StringComparison.OrdinalIgnoreCase))
        {
            var local = _recent.List(source, limit);
            if (local.Count > 0)
            {
                WriteJson(context, 200, JsonSerializer.Serialize(new { source, kind = "recent", tracks = local }));
                return 200;
            }

            if (string.Equals(source, "qq", StringComparison.Ordinal))
            {
                return WriteError(
                    context,
                    409,
                    "recent-unavailable",
                    "QQ 音乐没有对外开放「最近播放」接口；你播放过的歌曲会自动记录到本机最近播放里");
            }
        }

        try
        {
            var feed = await library.GetFeedAsync(source, kind, limit, token).ConfigureAwait(false);
            var tracks = feed.Tracks
                .Select(track => track with { Cover = BuildCoverUrl(track.Source, track.CoverKey) })
                .ToList();
            WriteJson(context, 200, JsonSerializer.Serialize(new { source = feed.Source, kind = feed.Kind, tracks }));
            return 200;
        }
        catch (OnlineUpstreamException error)
        {
            return WriteError(context, error.StatusCode, "upstream-failed", error.Message);
        }
    }

    /// <summary>
    /// 多平台「最近播放」融合：先放本软件自己的播放顺序，再按轮次并入各平台的最近播放，
    /// 所以别的设备在网易云 / QQ 音乐里刚播的歌也会按平台顺序插进来。
    /// </summary>
    private async Task<int> HandleRecentMergedAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var limit = 120;
        if (context.Request.QueryString["limit"] is { Length: > 0 } limitRaw &&
            (!int.TryParse(limitRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out limit) || limit is < 1 or > 500))
        {
            return WriteError(context, 400, "bad-request", "limit 参数非法");
        }

        var streams = new List<List<OnlineTrack>>
        {
            // 历史记录里的封面是上一次启动时的代理地址（端口/token 会变），这里重建
            _recent.List(null, limit).Select(RebindStoredTrack).ToList(),
        };

        var library = _library;
        if (library is not null)
        {
            foreach (var source in _sources)
            {
                if (!LibraryService.IsKnownSource(source))
                {
                    continue;
                }

                // 平台没有「最近播放」能力（例如酷狗）就直接跳过，不要拿旧校验报错
                if (MusicSourceCatalog.Find(source) is not { } descriptor ||
                    !descriptor.FeedKinds.Contains("recent", StringComparer.OrdinalIgnoreCase))
                {
                    continue;
                }

                try
                {
                    var feed = await library.GetFeedAsync(source, "recent", limit, _shutdown.Token).ConfigureAwait(false);
                    streams.Add(feed.Tracks
                        .Select(track => track with { Cover = BuildCoverUrl(track.Source, track.CoverKey) })
                        .ToList());
                }
                catch (Exception exception)
                {
                    // QQ 没有开放最近播放接口，缺一个平台不影响整体
                    OnlineHttp.Warn($"recent merged skipped source={source}: {OnlineHttp.Describe(exception)}");
                }
            }
        }

        // 先按本机真实播放顺序（新→旧）放进去，保证「最近播放」反映软件里实际播过的歌
        var merged = new List<OnlineTrack>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        if (streams.Count > 0)
        {
            foreach (var track in streams[0])
            {
                if (merged.Count >= limit)
                {
                    break;
                }

                if (seen.Add(track.Source + "|" + track.Id))
                {
                    merged.Add(track);
                }
            }
        }

        // 再按轮次并入其它平台的最近播放（其它设备上播过的歌）
        var otherStreams = streams.Skip(1).ToList();
        var longest = otherStreams.Count == 0 ? 0 : otherStreams.Max(stream => stream.Count);
        for (var index = 0; index < longest && merged.Count < limit; index += 1)
        {
            foreach (var stream in otherStreams)
            {
                if (index >= stream.Count)
                {
                    continue;
                }

                var track = stream[index];
                if (!seen.Add(track.Source + "|" + track.Id))
                {
                    continue;
                }

                merged.Add(track);
                if (merged.Count >= limit)
                {
                    break;
                }
            }
        }

        WriteJson(context, 200, JsonSerializer.Serialize(new { tracks = merged }));
        return 200;
    }

    private async Task<int> HandleLibraryLikeAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var library = _library;
        if (library is null)
        {
            return WriteError(context, 503, "library-unavailable", "个人音乐库服务不可用");
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim().ToLowerInvariant();
        if (!LibraryService.IsKnownSource(source))
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        var id = (query["id"] ?? string.Empty).Trim();
        if (id.Length == 0)
        {
            return WriteError(context, 400, "bad-request", "缺少 id 参数");
        }

        try
        {
            await library.AddLikedAsync(source, id, _shutdown.Token).ConfigureAwait(false);
            WriteJson(context, 200, JsonSerializer.Serialize(new LibraryRefreshResponse(), LibraryJsonContext.Default.LibraryRefreshResponse));
            return 200;
        }
        catch (OnlineUpstreamException exception)
        {
            return WriteLibraryError(context, exception);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error($"POST library/like source={source} failed", exception);
            return WriteError(context, 502, "upstream-failed", "加入喜欢失败，请稍后重试");
        }
    }

    private async Task<int> HandleLibraryUnlikeAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var library = _library;
        if (library is null)
        {
            return WriteError(context, 503, "library-unavailable", "个人音乐库服务不可用");
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim().ToLowerInvariant();
        if (!LibraryService.IsKnownSource(source))
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        var id = (query["id"] ?? string.Empty).Trim();
        if (id.Length == 0)
        {
            return WriteError(context, 400, "bad-request", "缺少 id 参数");
        }

        try
        {
            await library.RemoveLikedAsync(source, id, _shutdown.Token).ConfigureAwait(false);
            WriteJson(context, 200, JsonSerializer.Serialize(new LibraryRefreshResponse(), LibraryJsonContext.Default.LibraryRefreshResponse));
            return 200;
        }
        catch (OnlineUpstreamException exception)
        {
            return WriteLibraryError(context, exception);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error($"POST library/unlike source={source} failed", exception);
            return WriteError(context, 502, "upstream-failed", "取消喜欢失败，请稍后重试");
        }
    }

    private int HandleLibraryRefresh(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var library = _library;
        if (library is null)
        {
            return WriteError(context, 503, "library-unavailable", "个人音乐库服务不可用");
        }

        var source = (context.Request.QueryString["source"] ?? string.Empty).Trim().ToLowerInvariant();
        if (source.Length > 0 && !LibraryService.IsKnownSource(source))
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        try
        {
            library.Refresh(source.Length == 0 ? null : source);
            WriteJson(context, 200, JsonSerializer.Serialize(new LibraryRefreshResponse(), LibraryJsonContext.Default.LibraryRefreshResponse));
            return 200;
        }
        catch (Exception exception)
        {
            OnlineHttp.Error("GET library/refresh failed", exception);
            return WriteError(context, 500, "internal-error", "宿主内部错误");
        }
    }

    private LibraryOverview MapOverview(LibraryOverview overview) => new()
    {
        Sources = overview.Sources.Select(state => new LibrarySourceState
        {
            Source = state.Source,
            LoggedIn = state.LoggedIn,
            Nickname = state.Nickname,
            AvatarDataUrl = state.AvatarDataUrl,
            Liked = state.Liked is null ? null : MapPlaylist(state.Liked),
            Playlists = state.Playlists.Select(MapPlaylist).ToList(),
            Error = state.Error,
        }).ToList(),
    };

    private LibraryPlaylist MapPlaylist(LibraryPlaylist playlist) => playlist with
    {
        Cover = string.IsNullOrEmpty(playlist.CoverKey) ? null : BuildCoverUrl(playlist.Source, playlist.CoverKey),
    };

    private PlaylistDetail MapPlaylistDetail(LibraryDetail detail) => new()
    {
        Source = detail.Meta.Source,
        Id = detail.Meta.Id,
        Title = detail.Meta.Title,
        Cover = string.IsNullOrEmpty(detail.Meta.CoverKey) ? null : BuildCoverUrl(detail.Meta.Source, detail.Meta.CoverKey),
        Count = detail.Meta.Count > 0 ? detail.Meta.Count : detail.Tracks.Count,
        Tracks = detail.Tracks.Select(track => track with { Cover = BuildCoverUrl(track.Source, track.CoverKey) }).ToList(),
        HasMore = detail.HasMore,
    };

    private static int WriteLibraryError(HttpListenerContext context, OnlineUpstreamException exception)
    {
        var status = exception.StatusCode is 400 or 401 or 404 or 502 or 503 ? exception.StatusCode : 502;
        var code = status switch
        {
            400 => "bad-request",
            401 => "not-logged-in",
            404 => "not-found",
            _ => "upstream-failed",
        };
        return WriteError(context, status, code, exception.Message);
    }

    private async Task<int> HandleCoverAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim().ToLowerInvariant();
        var key = NormalizeCoverKey((query["key"] ?? string.Empty).Trim());
        if (key.Length == 0)
        {
            return WriteError(context, 400, "bad-request", "缺少 key 参数");
        }

        string upstreamUrl;
        string referer;
        string cacheKey;
        if (source == "netease")
        {
            if (!IsAllowedNeteaseCoverUrl(key))
            {
                OnlineHttp.Warn($"[cover] reject netease key={Describe(key)}");
                return WriteError(context, 400, "bad-request", "key 必须是 music.126.net 的图片地址");
            }

            upstreamUrl = key;
            referer = NeteaseProvider.RefererUrl;
            cacheKey = "netease|" + key;
        }
        else if (source == "qq")
        {
            if (IsAllowedQqCoverUrl(key))
            {
                // Library playlist covers are full qpic URLs; only whitelisted QQ image hosts pass.
                upstreamUrl = key;
                referer = QqProvider.RefererUrl;
                cacheKey = "qq|" + key;
            }
            else
            {
                // Contract §5: key is the album mid; real mids are 11-14 chars, keep a safe range.
                if (key.Length is 0 or > 64 || !key.All(char.IsAsciiLetterOrDigit))
                {
                    OnlineHttp.Warn($"[cover] reject qq key={Describe(key)}");
                    return WriteError(context, 400, "bad-request", "key 必须是 QQ 专辑 mid");
                }

                upstreamUrl = $"https://y.gtimg.cn/music/photo_new/T002R300x300M000{key}.jpg";
                referer = QqProvider.RefererUrl;
                cacheKey = "qq|" + key;
            }
        }
        else if (source == "kugou")
        {
            if (key.Length == 0 || key.Length > 32 || !key.All(char.IsAsciiDigit))
            {
                OnlineHttp.Warn($"[cover] reject kugou key={Describe(key)}");
                return WriteError(context, 400, "bad-request", "key 必须是酷狗专辑数字 id");
            }

            upstreamUrl = $"https://imge.kugou.com/stdmusic/240/{key}.jpg";
            referer = KugouProvider.RefererUrl;
            cacheKey = "kugou|" + key;
        }
        else
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        if (_coverCache.TryGetValue(cacheKey, out var cached) && cached.ExpiresAt > DateTimeOffset.UtcNow)
        {
            WriteBinary(context, 200, cached.Bytes, cached.ContentType);
            OnlineHttp.Info($"GET cover source={source} cache-hit {cached.Bytes.Length}B");
            return 200;
        }

        try
        {
            var upstream = await OnlineHttp.FetchBytesAsync(upstreamUrl, referer, CoverTimeout, _shutdown.Token)
                .ConfigureAwait(false);
            var contentType = string.IsNullOrEmpty(upstream.ContentType) ? "image/jpeg" : upstream.ContentType;
            StoreCover(cacheKey, upstream.Bytes, contentType);
            WriteBinary(context, 200, upstream.Bytes, contentType);
            OnlineHttp.Info($"GET cover source={source} ok {upstream.Bytes.Length}B {upstream.TookMs}ms");
            return 200;
        }
        catch (OnlineUpstreamException exception) when (exception.StatusCode == 404)
        {
            return WriteError(context, 404, "not-found", "封面不存在");
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error($"GET cover source={source} failed", exception);
            return WriteError(context, 502, "upstream-failed", "封面获取失败，请稍后重试");
        }
    }

    // ---- mac 版新增：web 前端静态文件服务（非 /api/ 路由） ----
    // 由 Program 在 new OnlineMusicService() 之前设置；为空时所有非 API 请求返回 404 纯文本。
    public static string? WebRoot { get; set; }

    private static readonly IReadOnlyDictionary<string, string> StaticContentTypes =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [".html"] = "text/html; charset=utf-8",
            [".htm"] = "text/html; charset=utf-8",
            [".js"] = "text/javascript; charset=utf-8",
            [".mjs"] = "text/javascript; charset=utf-8",
            [".css"] = "text/css; charset=utf-8",
            [".json"] = "application/json; charset=utf-8",
            [".map"] = "application/json; charset=utf-8",
            [".ttf"] = "font/ttf",
            [".otf"] = "font/otf",
            [".woff"] = "font/woff",
            [".woff2"] = "font/woff2",
            [".png"] = "image/png",
            [".jpg"] = "image/jpeg",
            [".jpeg"] = "image/jpeg",
            [".webp"] = "image/webp",
            [".svg"] = "image/svg+xml",
            [".ico"] = "image/x-icon",
            [".txt"] = "text/plain; charset=utf-8",
        };

    private async Task<int> HandleStaticAsync(HttpListenerContext context)
    {
        var request = context.Request;
        var response = context.Response;
        var method = request.HttpMethod;
        var isHead = string.Equals(method, "HEAD", StringComparison.OrdinalIgnoreCase);
        if (!isHead && !string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase))
        {
            return WritePlainText(context, 405, "method not allowed");
        }

        var root = WebRoot;
        if (string.IsNullOrWhiteSpace(root))
        {
            return WritePlainText(context, 404, "web root not configured");
        }

        string decoded;
        try
        {
            decoded = Uri.UnescapeDataString(request.Url?.AbsolutePath ?? "/");
        }
        catch (UriFormatException)
        {
            return WritePlainText(context, 400, "bad path");
        }

        if (decoded.Contains('\0'))
        {
            return WritePlainText(context, 400, "bad path");
        }

        if (decoded.Length == 0 || decoded == "/")
        {
            decoded = "/index.html";
        }

        string rootPath;
        string fullPath;
        try
        {
            rootPath = Path.GetFullPath(root);
            fullPath = Path.GetFullPath(Path.Combine(rootPath, decoded.TrimStart('/').Replace('/', Path.DirectorySeparatorChar)));
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return WritePlainText(context, 400, "bad path");
        }

        // 路径穿越防护：解码 + 归一化之后，目标仍必须位于 web-root 之内。
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var rootPrefix = rootPath.EndsWith(Path.DirectorySeparatorChar)
            ? rootPath
            : rootPath + Path.DirectorySeparatorChar;
        if (!fullPath.StartsWith(rootPrefix, comparison) &&
            !string.Equals(fullPath, rootPath, comparison))
        {
            OnlineHttp.Warn($"[static] reject traversal path={Describe(decoded)}");
            return WritePlainText(context, 404, "not found");
        }

        if (Directory.Exists(fullPath))
        {
            // 目录请求回落到目录里的 index.html。
            fullPath = Path.Combine(fullPath, "index.html");
        }

        if (!File.Exists(fullPath))
        {
            return WritePlainText(context, 404, "not found");
        }

        byte[] bytes;
        try
        {
            bytes = await File.ReadAllBytesAsync(fullPath, _shutdown.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
            return 499;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            OnlineHttp.Warn($"[static] read failed path={Describe(decoded)} err={exception.GetType().Name}");
            return WritePlainText(context, 500, "read failed");
        }

        var extension = Path.GetExtension(fullPath).ToLowerInvariant();
        response.StatusCode = 200;
        response.ContentType = StaticContentTypes.TryGetValue(extension, out var contentType)
            ? contentType
            : "application/octet-stream";
        // 前端文件经常在开发/联调时被替换，HTML/JS 一律 no-store，其它资源给短缓存。
        response.Headers["Cache-Control"] = extension is ".html" or ".js" or ".mjs"
            ? "no-store"
            : "public, max-age=3600";
        response.ContentLength64 = bytes.Length;
        if (isHead)
        {
            return 200;
        }

        response.OutputStream.Write(bytes, 0, bytes.Length);
        return 200;
    }

    private static int WritePlainText(HttpListenerContext context, int status, string text)
    {
        var response = context.Response;
        var bytes = Encoding.UTF8.GetBytes(text + "\n");
        response.StatusCode = status;
        response.ContentType = "text/plain; charset=utf-8";
        response.Headers["Cache-Control"] = "no-store";
        response.ContentLength64 = bytes.Length;
        if (!string.Equals(context.Request.HttpMethod, "HEAD", StringComparison.OrdinalIgnoreCase))
        {
            response.OutputStream.Write(bytes, 0, bytes.Length);
        }

        return status;
    }

    private int WriteHealth(HttpListenerContext context)
    {
        var health = new HealthResponse { Ok = true, Version = 1, Sources = _sources.ToList() };
        WriteJson(context, 200, JsonSerializer.Serialize(health, OnlineJsonContext.Default.HealthResponse));
        return 200;
    }

    // 平台能力清单：页面用 GET /api/sources 动态渲染登录卡/搜索分段/默认音源，新增平台不需要改页面。
    private int WriteSources(HttpListenerContext context)
    {
        var list = new MusicSourceListResponse { Sources = MusicSourceCatalog.All.ToList() };
        WriteJson(context, 200, JsonSerializer.Serialize(list, MusicSourceJsonContext.Default.MusicSourceListResponse));
        return 200;
    }

    private void StoreCover(string cacheKey, byte[] bytes, string contentType)
    {
        if (_coverCache.Count >= CoverCacheLimit)
        {
            PruneCoverCache();
        }

        _coverCache[cacheKey] = new CoverCacheEntry(bytes, contentType, DateTimeOffset.UtcNow + CoverCacheLifetime);
    }

    private void PruneCoverCache()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var pair in _coverCache)
        {
            if (pair.Value.ExpiresAt <= now)
            {
                _coverCache.TryRemove(pair.Key, out _);
            }
        }

        foreach (var pair in _coverCache)
        {
            if (_coverCache.Count < CoverCacheLimit)
            {
                break;
            }

            _coverCache.TryRemove(pair.Key, out _);
        }
    }

    private bool ValidateToken(HttpListenerRequest request)
    {
        var provided = request.QueryString["token"];
        if (string.IsNullOrEmpty(provided))
        {
            return false;
        }

        var providedBytes = Encoding.ASCII.GetBytes(provided);
        return providedBytes.Length == _tokenBytes.Length &&
               CryptographicOperations.FixedTimeEquals(providedBytes, _tokenBytes);
    }

    private IOnlineMusicProvider? GetProvider(string source) =>
        _providers.TryGetValue(source, out var provider) ? provider : null;

    private static bool IsValidKugouId(string id)
    {
        var parts = id.Split('|');
        if (parts.Length < 2)
        {
            return false;
        }

        var hash = parts[0];
        return hash.Length is >= 8 and <= 64 && hash.All(char.IsAsciiLetterOrDigit);
    }

    private static bool IsValidTrackId(string source, string id) =>
        source switch
        {
            "netease" => id.Length is > 0 and <= 20 && id.All(char.IsAsciiDigit),
            "qq" => id.Length is > 0 and <= 64 && id.All(char.IsAsciiLetterOrDigit),
            // 酷狗：hash|时长秒|专辑id|MixSongID，歌词接口需要前三项
            "kugou" => IsValidKugouId(id),
            _ => false,
        };

    /// <summary>
    /// 上游封面地址时而给 http（甚至协议相对 //），页面在 https 环境下加载会被拦，
    /// 这里统一升级成 https 再走白名单校验。
    /// </summary>
    private static string NormalizeCoverKey(string key)
    {
        if (key.StartsWith("//", StringComparison.Ordinal))
        {
            return "https:" + key;
        }

        if (!key.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
        {
            return key;
        }

        var host = key.ToLowerInvariant();
        var knownCoverHost = host.Contains(".music.126.net") ||
                             host.Contains(".qq.com") ||
                             host.Contains(".qpic.cn") ||
                             host.Contains(".gtimg.cn") ||
                             host.Contains(".gtimg.com");
        return knownCoverHost ? "https://" + key["http://".Length..] : key;
    }

    /// <summary>把要拒绝的 key 截断成一行，方便日志排查。</summary>
    private static string Describe(string value)
    {
        var text = value.Length > 180 ? value[..180] : value;
        return text.Replace(((char)10).ToString(), " ").Replace(((char)13).ToString(), " ");
    }

    private static bool IsAllowedNeteaseCoverUrl(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri))
        {
            return false;
        }

        return string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) &&
               uri.Host.EndsWith(".music.126.net", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>历史记录里存的封面是本机代理 URL，端口/token 每次启动都会变，重建一次。</summary>
    private OnlineTrack RebindStoredTrack(OnlineTrack track)
    {
        var cover = track.Cover;
        if (!string.IsNullOrEmpty(cover) &&
            Uri.TryCreate(cover, UriKind.Absolute, out var uri) &&
            uri.AbsolutePath.EndsWith("/api/cover", StringComparison.OrdinalIgnoreCase))
        {
            var key = QueryValue(uri.Query, "key");
            if (!string.IsNullOrEmpty(key))
            {
                var source = QueryValue(uri.Query, "source");
                return track with
                {
                    Cover = BuildCoverUrl(string.IsNullOrEmpty(source) ? track.Source : source, key),
                };
            }
        }

        return track;
    }

    private static string? QueryValue(string query, string name)
    {
        foreach (var part in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var index = part.IndexOf('=');
            if (index <= 0 || !part.AsSpan(0, index).Equals(name, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            return Uri.UnescapeDataString(part[(index + 1)..]);
        }

        return null;
    }

    private string BuildCoverUrl(string source, string? coverKey)
    {
        if (string.IsNullOrEmpty(coverKey))
        {
            return string.Empty;
        }

        return $"http://127.0.0.1:{Port}/api/cover?source={Uri.EscapeDataString(source)}" +
               $"&key={Uri.EscapeDataString(coverKey)}&token={Uri.EscapeDataString(_token)}";
    }

    private static bool IsAllowedQqCoverUrl(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var host = uri.Host;
        return host.EndsWith(".qq.com", StringComparison.OrdinalIgnoreCase) ||
               host.EndsWith(".qpic.cn", StringComparison.OrdinalIgnoreCase) ||
               host.Equals("qpic.cn", StringComparison.OrdinalIgnoreCase) ||
               host.EndsWith(".gtimg.cn", StringComparison.OrdinalIgnoreCase) ||
               host.EndsWith(".gtimg.com", StringComparison.OrdinalIgnoreCase);
    }

    private static void ApplyCors(HttpListenerResponse response)
    {
        response.Headers["Access-Control-Allow-Origin"] = "*";
        response.Headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
        response.Headers["Access-Control-Allow-Headers"] = "*";
        response.Headers["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Accept-Ranges";
        // Chromium's Private Network Access preflight demands this for localhost targets.
        response.Headers["Access-Control-Allow-Private-Network"] = "true";
    }

    private static string ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static void WriteJson(HttpListenerContext context, int status, string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        var response = context.Response;
        response.StatusCode = status;
        response.ContentType = "application/json; charset=utf-8";
        response.ContentLength64 = bytes.Length;
        response.OutputStream.Write(bytes, 0, bytes.Length);
    }

    private static void WriteBinary(HttpListenerContext context, int status, byte[] bytes, string contentType)
    {
        var response = context.Response;
        // 封面等二进制响应也要带 CORS：页面需要用 canvas 取封面像素做主题色
        ApplyCors(response);
        response.StatusCode = status;
        response.ContentType = contentType;
        response.Headers["Cache-Control"] = "private, max-age=3600";
        response.ContentLength64 = bytes.Length;
        response.OutputStream.Write(bytes, 0, bytes.Length);
    }

    private static int WriteUnauthorized(HttpListenerContext context) =>
        WriteError(context, 401, "unauthorized", "缺少或无效的 token");

    private static int WriteError(HttpListenerContext context, int status, string code, string message)
    {
        var error = new ErrorResponse { Error = code, Message = message };
        WriteJson(context, status, JsonSerializer.Serialize(error, OnlineJsonContext.Default.ErrorResponse));
        return status;
    }

    // mac 版：不引入 WPF 位图解码（System.Windows.Media.Imaging 只存在于 Windows 桌面框架）。
    // 前端 coverColorsOf 在拿不到主色时会用 fallbackColors 兜底，所以这里固定返回空结果，
    // 保持 HTTP 契约不变（200 + dominant/palette 字段）。
    private int HandleCoverColorsAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim().ToLowerInvariant();
        var key = NormalizeCoverKey((query["key"] ?? string.Empty).Trim());
        OnlineHttp.Info($"[cover-color] mac engine returns empty colors source={source} key={Describe(key)}");
        WriteJson(context, 200, "{\"dominant\":null,\"palette\":[]}");
        return 200;
    }

    private sealed record CoverCacheEntry(byte[] Bytes, string ContentType, DateTimeOffset ExpiresAt);
}
