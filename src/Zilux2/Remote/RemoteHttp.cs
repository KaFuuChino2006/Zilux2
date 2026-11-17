using System.Buffers;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;

namespace Zilux2.Remote;

/// <summary>
/// 手机遥控用的最小 HTTP/1.1 服务端。
///
/// 为什么不是 <see cref="System.Net.HttpListener"/>：非管理员进程拿不到 `http://+:port/` 的
/// URL ACL（实测 Start() 直接抛「拒绝访问。」），而 netsh http add urlacl 需要管理员。
/// 局域网遥控又必须绑 0.0.0.0，所以这里用 TcpListener 自己解析请求——不需要任何提权、
/// 不依赖外部包，行为对手机端与 HttpListener 完全一致（HTTP/1.1、Connection: close）。
/// </summary>
internal sealed class RemoteHttpServer : IDisposable
{
    private const int MaxConcurrentConnections = 16;

    private readonly object _gate = new();
    private readonly SemaphoreSlim _connections = new(MaxConcurrentConnections, MaxConcurrentConnections);
    private TcpListener? _listener;
    private CancellationTokenSource? _stop;
    private Task? _acceptLoop;
    private Func<RemoteRequest, Task<RemoteResponse>>? _handler;
    private bool _disposed;
    private int _activeConnections;

    internal int Port { get; private set; }

    internal bool Running => _listener is not null;

    /// <summary>启动监听；<paramref name="preferredPort"/> 为 0（或已被占用时顺延）时自动挑端口。</summary>
    internal bool TryStart(
        int preferredPort,
        Func<RemoteRequest, Task<RemoteResponse>> handler,
        out int port,
        out string? error)
    {
        lock (_gate)
        {
            port = 0;
            error = null;
            if (_disposed)
            {
                error = "已释放";
                return false;
            }

            if (_listener is not null)
            {
                port = Port;
                return true;
            }

            _handler = handler;
            var candidates = BuildPortCandidates(preferredPort);
            foreach (var candidate in candidates)
            {
                if (!TryBind(candidate, out var bound, out var bindError))
                {
                    if (candidate is > 0)
                    {
                        HostLog.Warn($"[remote] port busy port={candidate} err={bindError}");
                    }

                    continue;
                }

                Port = bound;
                port = bound;
                _stop = new CancellationTokenSource();
                _acceptLoop = Task.Run(() => AcceptLoopAsync(_listener!, _stop.Token));
                HostLog.Info($"[remote] listen bind=0.0.0.0 port={bound}{(candidate != preferredPort ? " (preferred=" + preferredPort + ")" : string.Empty)}");
                return true;
            }

            error = "没有可用端口";
            HostLog.Error($"[remote] listen failed preferred={preferredPort}: no usable port");
            return false;
        }
    }

    private bool TryBind(int port, out int bound, out string? error)
    {
        bound = 0;
        error = null;
        TcpListener? listener = null;
        try
        {
            // 显式 0.0.0.0：手机必须能从局域网其它设备连进来。
            listener = new TcpListener(IPAddress.Any, port);
            listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, false);
            listener.Start(backlog: 32);
            bound = ((IPEndPoint)listener.LocalEndpoint).Port;
            _listener = listener;
            return true;
        }
        catch (SocketException exception)
        {
            error = exception.SocketErrorCode.ToString();
            listener?.Stop();
            return false;
        }
        catch (Exception exception)
        {
            error = exception.GetType().Name;
            listener?.Stop();
            return false;
        }
    }

    /// <summary>首选端口 → 顺延 20 个 → 系统分配（0）。</summary>
    private static IEnumerable<int> BuildPortCandidates(int preferredPort)
    {
        if (preferredPort is > 0 and <= 65535)
        {
            yield return preferredPort;
            for (var step = 1; step <= 20; step += 1)
            {
                var next = preferredPort + step;
                if (next <= 65535)
                {
                    yield return next;
                }
            }
        }

        // 0 = 让系统挑一个空闲端口，永远不会失败。
        yield return 0;
    }

    private async Task AcceptLoopAsync(TcpListener listener, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await listener.AcceptTcpClientAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[remote] accept failed err={exception.GetType().Name}");
                await Task.Delay(120, CancellationToken.None).ConfigureAwait(false);
                continue;
            }

            _ = Task.Run(() => ServeAsync(client, cancellationToken), CancellationToken.None);
        }
    }

    private async Task ServeAsync(TcpClient client, CancellationToken cancellationToken)
    {
        if (!await _connections.WaitAsync(TimeSpan.FromSeconds(5), cancellationToken).ConfigureAwait(false))
        {
            client.Dispose();
            return;
        }

        Interlocked.Increment(ref _activeConnections);
        try
        {
            using var _ = client;
            client.NoDelay = true;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(20));
            var stream = client.GetStream();
            var remoteAddress = (client.Client.RemoteEndPoint as IPEndPoint)?.Address.ToString() ?? "?";
            var request = await RemoteRequest.ReadAsync(stream, remoteAddress, timeout.Token).ConfigureAwait(false);
            if (request is null)
            {
                return;
            }

            RemoteResponse response;
            try
            {
                var handler = _handler;
                response = handler is null
                    ? RemoteResponse.Text(503, "service-unavailable", "服务未就绪")
                    : await handler(request).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                response = RemoteResponse.Text(504, "timeout", "处理超时");
            }
            catch (Exception exception)
            {
                HostLog.Error($"[remote] handler failed path={request.Path}", exception);
                response = RemoteResponse.Text(500, "internal", "出错了");
            }

            await response.WriteAsync(stream, request.Method, timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // 手机主动断开 / 超时：不算错误。
        }
        catch (Exception exception) when (exception is IOException or SocketException or ObjectDisposedException)
        {
            HostLog.Info($"[remote] client gone err={exception.GetType().Name}");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[remote] serve failed err={exception.GetType().Name}");
        }
        finally
        {
            Interlocked.Decrement(ref _activeConnections);
            _connections.Release();
        }
    }

    internal void Stop()
    {
        lock (_gate)
        {
            try
            {
                _stop?.Cancel();
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[remote] stop signal failed err={exception.GetType().Name}");
            }

            try
            {
                _listener?.Stop();
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[remote] listener stop failed err={exception.GetType().Name}");
            }

            _listener = null;
            _acceptLoop = null;
            Port = 0;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
        }

        Stop();
        _stop?.Dispose();
        _stop = null;
        _connections.Dispose();
    }
}

/// <summary>一次入站请求（已解析完头部与 body）。</summary>
internal sealed class RemoteRequest
{
    private RemoteRequest(string method, string path, string query, Dictionary<string, string> headers, byte[] body, string remoteAddress)
    {
        Method = method;
        Path = path;
        Query = query;
        Headers = headers;
        Body = body;
        RemoteAddress = remoteAddress;
    }

    internal string Method { get; }

    /// <summary>不含 query 的路径，已做百分号解码。</summary>
    internal string Path { get; }

    /// <summary>原始 query（不含 `?`）。</summary>
    internal string Query { get; }

    internal Dictionary<string, string> Headers { get; }

    internal byte[] Body { get; }

    internal string RemoteAddress { get; }

    internal bool IsLoopback =>
        RemoteAddress is "127.0.0.1" or "::1" ||
        RemoteAddress.StartsWith("::ffff:127.", StringComparison.Ordinal);

    internal string? QueryValue(string key) => RemoteHttp.ParseQuery(Query).TryGetValue(key, out var value) ? value : null;

    /// <summary>请求头上限：手机浏览器够用，也挡住无脑灌包。</summary>
    private const int MaxHeaderBytes = 16 * 1024;

    /// <summary>请求体上限：遥控接口只有 JSON 小包。</summary>
    private const int MaxBodyBytes = 64 * 1024;

    internal static async Task<RemoteRequest?> ReadAsync(NetworkStream stream, string remoteAddress, CancellationToken cancellationToken)
    {
        var scratch = ArrayPool<byte>.Shared.Rent(4096);
        try
        {
            var head = new List<byte>(1024);
            var headerEnd = -1;
            while (headerEnd < 0 && head.Count < MaxHeaderBytes)
            {
                var read = await stream.ReadAsync(scratch.AsMemory(0, scratch.Length), cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    return null;
                }

                head.AddRange(scratch.AsSpan(0, read).ToArray());
                var from = Math.Max(0, head.Count - read - 3);
                for (var i = from; i + 3 < head.Count; i += 1)
                {
                    if (head[i] == '\r' && head[i + 1] == '\n' && head[i + 2] == '\r' && head[i + 3] == '\n')
                    {
                        headerEnd = i + 4;
                        break;
                    }
                }
            }

            if (headerEnd < 0)
            {
                return null;
            }

            var headerText = Encoding.UTF8.GetString(head.ToArray(), 0, headerEnd);
            var lines = headerText.Split("\r\n", StringSplitOptions.None);
            if (lines.Length == 0)
            {
                return null;
            }

            var requestLine = lines[0].Split(' ');
            if (requestLine.Length < 2)
            {
                return null;
            }

            var method = requestLine[0].ToUpperInvariant();
            var target = requestLine[1];
            var queryIndex = target.IndexOf('?');
            var rawPath = queryIndex >= 0 ? target[..queryIndex] : target;
            var query = queryIndex >= 0 ? target[(queryIndex + 1)..] : string.Empty;
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (var i = 1; i < lines.Length; i += 1)
            {
                var line = lines[i];
                var colon = line.IndexOf(':');
                if (colon <= 0)
                {
                    continue;
                }

                headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
            }

            var body = Array.Empty<byte>();
            if (headers.TryGetValue("Content-Length", out var lengthText) &&
                int.TryParse(lengthText, out var length) && length > 0)
            {
                if (length > MaxBodyBytes)
                {
                    return null;
                }

                body = new byte[length];
                // 头部那次读可能已经多读进 body：先把已经拿到的字节搬到 body 里。
                var leftover = head.Count - headerEnd;
                var prefilled = Math.Min(leftover, length);
                if (prefilled > 0)
                {
                    head.CopyTo(headerEnd, body, 0, prefilled);
                }

                var offset = prefilled;
                while (offset < length)
                {
                    var read = await stream.ReadAsync(body.AsMemory(offset, length - offset), cancellationToken).ConfigureAwait(false);
                    if (read == 0)
                    {
                        break;
                    }

                    offset += read;
                }

                if (offset < length)
                {
                    return null;
                }
            }

            return new RemoteRequest(method, RemoteHttp.DecodePath(rawPath), query, headers, body, remoteAddress);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(scratch);
        }
    }
}

/// <summary>一个响应：状态码 + Content-Type + 原始字节（图片/HTML/JSON 共用）。</summary>
internal sealed class RemoteResponse
{
    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    internal int Status { get; init; }

    internal string ContentType { get; init; } = "application/json; charset=utf-8";

    internal byte[] Body { get; init; } = Array.Empty<byte>();

    internal bool NoStore { get; init; } = true;

    internal static RemoteResponse Json(int status, string json) => new()
    {
        Status = status,
        ContentType = "application/json; charset=utf-8",
        Body = Utf8.GetBytes(json),
    };

    internal static RemoteResponse Text(int status, string code, string message) => Json(
        status,
        "{\"ok\":false,\"error\":\"" + RemoteHttp.JsonEscape(code) + "\",\"message\":\"" + RemoteHttp.JsonEscape(message) + "\"}");

    internal static RemoteResponse Text(int status, string code) => Text(status, code, code);

    internal static RemoteResponse Html(string html) => Html(200, html);

    internal static RemoteResponse Html(int status, string html) => new()
    {
        Status = status,
        ContentType = "text/html; charset=utf-8",
        Body = Utf8.GetBytes(html),
        // 手机页是单文件、每次版本升级要立刻生效：不让 WebView 缓存住旧壳。
        NoStore = true,
    };

    internal static RemoteResponse Bytes(string contentType, byte[] bytes) => new()
    {
        Status = 200,
        ContentType = contentType,
        Body = bytes,
        NoStore = false,
    };

    internal async Task WriteAsync(NetworkStream stream, string method, CancellationToken cancellationToken)
    {
        var head = new StringBuilder(256);
        head.Append("HTTP/1.1 ").Append(Status).Append(' ').Append(ReasonPhrase(Status)).Append("\r\n");
        head.Append("Content-Type: ").Append(ContentType).Append("\r\n");
        head.Append("Content-Length: ").Append(Body.Length).Append("\r\n");
        head.Append("Connection: close\r\n");
        head.Append("Cache-Control: ").Append(NoStore ? "no-store" : "public, max-age=300").Append("\r\n");
        // 手机页是我自己的同源页面；不放开跨域，避免别的站点借浏览器读本机状态。
        head.Append("X-Content-Type-Options: nosniff\r\n");
        head.Append("Referrer-Policy: no-referrer\r\n");
        head.Append("\r\n");
        var headBytes = Encoding.ASCII.GetBytes(head.ToString());
        try
        {
            if (!string.Equals(method, "HEAD", StringComparison.OrdinalIgnoreCase))
            {
                await stream.WriteAsync(headBytes, cancellationToken).ConfigureAwait(false);
                if (Body.Length > 0)
                {
                    await stream.WriteAsync(Body, cancellationToken).ConfigureAwait(false);
                }
            }
            else
            {
                await stream.WriteAsync(headBytes, cancellationToken).ConfigureAwait(false);
            }

            await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException)
        {
            // 手机提前关页面：正常。
        }
    }

    private static string ReasonPhrase(int status) => status switch
    {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "OK",
    };
}

internal static class RemoteHttp
{
    internal static string DecodePath(string raw)
    {
        try
        {
            return Uri.UnescapeDataString(raw);
        }
        catch (UriFormatException)
        {
            return raw;
        }
    }

    internal static Dictionary<string, string> ParseQuery(string query)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrEmpty(query))
        {
            return result;
        }

        foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var equals = pair.IndexOf('=');
            var key = equals >= 0 ? pair[..equals] : pair;
            var value = equals >= 0 ? pair[(equals + 1)..] : string.Empty;
            try
            {
                result[Uri.UnescapeDataString(key)] = Uri.UnescapeDataString(value.Replace('+', ' '));
            }
            catch (UriFormatException)
            {
                result[key] = value;
            }
        }

        return result;
    }

    internal static string JsonEscape(string value)
    {
        var builder = new StringBuilder(value.Length + 16);
        foreach (var ch in value)
        {
            switch (ch)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (ch < 0x20)
                    {
                        builder.Append("\\u").Append(((int)ch).ToString("x4"));
                    }
                    else
                    {
                        builder.Append(ch);
                    }

                    break;
            }
        }

        return builder.ToString();
    }
}

/// <summary>局域网地址枚举：只挑能承载手机访问的 IPv4 地址。</summary>
internal static class RemoteNetwork
{
    /// <summary>按「最像家用局域网」的顺序返回地址（192.168 &gt; 10 &gt; 172.16-31 &gt; 其它）。</summary>
    internal static IReadOnlyList<string> LanAddresses()
    {
        var candidates = new List<(int Rank, string Address)>();
        try
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up ||
                    nic.NetworkInterfaceType == NetworkInterfaceType.Loopback ||
                    nic.NetworkInterfaceType == NetworkInterfaceType.Tunnel)
                {
                    continue;
                }

                foreach (var unicast in nic.GetIPProperties().UnicastAddresses)
                {
                    if (unicast.Address.AddressFamily != AddressFamily.InterNetwork)
                    {
                        continue;
                    }

                    var address = unicast.Address.ToString();
                    if (address.StartsWith("127.", StringComparison.Ordinal) ||
                        address.StartsWith("169.254.", StringComparison.Ordinal))
                    {
                        continue;
                    }

                    candidates.Add((Rank(address), address));
                }
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[remote] nic enumerate failed err={exception.GetType().Name}");
        }

        return candidates
            .OrderBy(item => item.Rank)
            .ThenBy(item => item.Address, StringComparer.Ordinal)
            .Select(item => item.Address)
            .Distinct(StringComparer.Ordinal)
            .ToList();
    }

    internal static string? PreferredLanAddress() => LanAddresses().FirstOrDefault();

    /// <summary>只放行本机与私有网段的来源；端口映射/公网直连一律拒绝。</summary>
    internal static bool IsPrivateOrLoopback(string address)
    {
        if (!IPAddress.TryParse(address, out var ip))
        {
            return false;
        }

        if (ip.IsIPv4MappedToIPv6)
        {
            ip = ip.MapToIPv4();
        }

        if (IPAddress.IsLoopback(ip))
        {
            return true;
        }

        if (ip.AddressFamily == AddressFamily.InterNetworkV6)
        {
            return ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal;
        }

        var bytes = ip.GetAddressBytes();
        if (bytes.Length != 4)
        {
            return false;
        }

        return bytes[0] switch
        {
            10 => true,
            127 => true,
            169 => bytes[1] == 254,
            172 => bytes[1] is >= 16 and <= 31,
            192 => bytes[1] == 168,
            _ => false,
        };
    }

    private static int Rank(string address)
    {
        if (address.StartsWith("192.168.", StringComparison.Ordinal))
        {
            return 0;
        }

        if (address.StartsWith("10.", StringComparison.Ordinal))
        {
            return 1;
        }

        if (address.StartsWith("172.", StringComparison.Ordinal))
        {
            // 172.16.0.0/12
            var parts = address.Split('.');
            if (parts.Length == 4 && int.TryParse(parts[1], out var second) && second is >= 16 and <= 31)
            {
                return 2;
            }

            return 4;
        }

        return 3;
    }
}
