using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;

namespace Zilux2.Online;

internal interface IOnlineMusicProvider
{
    string Name { get; }

    Task<List<OnlineTrack>> SearchAsync(string query, int limit, CancellationToken cancellationToken);

    Task<LyricData> GetLyricAsync(string id, CancellationToken cancellationToken);

    // Resolves a playable upstream URL (or a "needs membership" answer) for one track.
    // quality: "standard" | "high" | "lossless"（平台不支持时自动降级）。
    Task<StreamResolution> ResolveStreamAsync(string id, string? quality, CancellationToken cancellationToken);

    /// <summary>
    /// 诊断用：强制解析 QMC2 加密档（.mgg/.mflac）。默认无加密档，返回 null 由调用方回退。
    /// </summary>
    Task<StreamResolution?> ResolveEncryptedStreamAsync(string id, string? quality, CancellationToken cancellationToken) =>
        Task.FromResult<StreamResolution?>(null);
}

internal sealed class LyricData
{
    public string Lrc { get; init; } = string.Empty;

    public string? Translation { get; init; }

    // 逐字歌词原文（网易云 yrc，格式 `[start,dur](start,dur)字…`），前端自行解析
    public string? Yrc { get; init; }

    // QQ QRC 加密十六进制原文（前端用 qrc-decoder 本地解密），仅 QQ 有
    public string? Qrc { get; init; }

    // QRC 已在宿主侧解密后的明文（逐字时间轴），前端优先使用；为旧客户端保留 Qrc 原文
    public string? QrcText { get; init; }
}

internal sealed class StreamResolution
{
    private static readonly IReadOnlyDictionary<string, string> NoHeaders =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    public bool IsPlayable { get; private init; }

    public string Url { get; private init; } = string.Empty;

    public string NotPlayableMessage { get; private init; } = string.Empty;

    // Extra headers the upstream audio CDN requires (QQ needs a y.qq.com Referer).
    public IReadOnlyDictionary<string, string> Headers { get; private init; } = NoHeaders;

    // 实际下发的音质（用于界面显示，例如「无损 · FLAC 999k」）。
    public string QualityLabel { get; private init; } = string.Empty;

    public int Bitrate { get; private init; }

    public string Format { get; private init; } = string.Empty;

    // QMC2 加密档（.mgg/.mflac/.mmp4）：ekey 与解密模式；非空时由宿主边下边解。
    public string EncryptionKey { get; private init; } = string.Empty;

    public string EncryptionMode { get; private init; } = string.Empty;

    public static StreamResolution Playable(
        string url,
        IReadOnlyDictionary<string, string>? headers = null,
        string qualityLabel = "",
        int bitrate = 0,
        string format = "",
        string encryptionKey = "",
        string encryptionMode = "") =>
        new()
        {
            IsPlayable = true,
            Url = url,
            Headers = headers ?? NoHeaders,
            QualityLabel = qualityLabel,
            Bitrate = bitrate,
            Format = format,
            EncryptionKey = encryptionKey,
            EncryptionMode = encryptionMode,
        };

    public static StreamResolution NotPlayable(string message) =>
        new() { IsPlayable = false, NotPlayableMessage = message };
}

internal sealed class OnlineUpstreamException : Exception
{
    public OnlineUpstreamException(string message, int statusCode) : base(message) =>
        StatusCode = statusCode;

    public int StatusCode { get; }
}

internal readonly record struct UpstreamText(string Body, int Status, long TookMs);

internal readonly record struct UpstreamBytes(byte[] Bytes, string? ContentType, int Status, long TookMs);

// Shared upstream plumbing: one pooled HttpClient, per-call timeouts, contract-style log lines.
internal static class OnlineHttp
{
    private const int MaxTextResponseBytes = 8 * 1024 * 1024;
    private const long MaxBinaryResponseBytes = 32L * 1024 * 1024;

    internal const string UserAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

    internal static readonly HttpClient Client = CreateClient();

    internal static void Info(string message) => HostLog.Info("[online] " + message);

    internal static void Warn(string message) => HostLog.Warn("[online] " + message);

    internal static void Error(string message, Exception? exception = null)
    {
        if (exception is null)
        {
            HostLog.Error("[online] " + message);
        }
        else
        {
            HostLog.Error("[online] " + message, exception);
        }
    }

    internal static HttpRequestMessage NewRequest(HttpMethod method, string url, string? referer, string? cookie = null)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
        if (!string.IsNullOrEmpty(referer))
        {
            request.Headers.TryAddWithoutValidation("Referer", referer);
        }

        // Contract §4.2: QQ returns 500 for clients that omit Accept: */*.
        request.Headers.TryAddWithoutValidation("Accept", "*/*");
        request.Headers.TryAddWithoutValidation("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
        if (!string.IsNullOrEmpty(cookie))
        {
            request.Headers.TryAddWithoutValidation("Cookie", cookie);
        }

        return request;
    }

    internal static async Task<UpstreamText> FetchTextAsync(
        string url,
        string? referer,
        TimeSpan timeout,
        CancellationToken cancellationToken,
        HttpMethod? method = null,
        string? jsonBody = null,
        string? cookie = null)
    {
        var stopwatch = Stopwatch.StartNew();
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);
        using var request = NewRequest(method ?? HttpMethod.Get, url, referer, cookie);
        if (jsonBody is not null)
        {
            request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
        }

        using var response = await Client
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutSource.Token)
            .ConfigureAwait(false);
        var status = (int)response.StatusCode;
        if (!response.IsSuccessStatusCode)
        {
            throw new OnlineUpstreamException($"upstream HTTP {status}", status);
        }

        // D-22：上游响应必须有上限，避免异常/恶意大响应把宿主内存打满。
        if (response.Content.Headers.ContentLength is > MaxTextResponseBytes)
        {
            throw new OnlineUpstreamException("上游响应过大", 502);
        }

        string body;
        await using (var stream = await response.Content.ReadAsStreamAsync(timeoutSource.Token).ConfigureAwait(false))
        using (var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true))
        {
            var builder = new StringBuilder();
            var buffer = new char[8192];
            int read;
            while ((read = await reader.ReadAsync(buffer.AsMemory(0, buffer.Length), timeoutSource.Token).ConfigureAwait(false)) > 0)
            {
                builder.Append(buffer, 0, read);
                if (builder.Length > MaxTextResponseBytes)
                {
                    throw new OnlineUpstreamException("上游响应过大", 502);
                }
            }

            body = builder.ToString();
        }

        stopwatch.Stop();
        return new UpstreamText(body, status, stopwatch.ElapsedMilliseconds);
    }

    internal static async Task<UpstreamBytes> FetchBytesAsync(
        string url,
        string? referer,
        TimeSpan timeout,
        CancellationToken cancellationToken,
        string? cookie = null)
    {
        var stopwatch = Stopwatch.StartNew();
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);
        using var request = NewRequest(HttpMethod.Get, url, referer, cookie);
        using var response = await Client
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutSource.Token)
            .ConfigureAwait(false);
        var status = (int)response.StatusCode;
        if (!response.IsSuccessStatusCode)
        {
            throw new OnlineUpstreamException($"upstream HTTP {status}", status);
        }

        // D-22：封面字节流同样设上限。
        if (response.Content.Headers.ContentLength is > MaxBinaryResponseBytes)
        {
            throw new OnlineUpstreamException("上游响应过大", 502);
        }

        byte[] bytes;
        await using (var stream = await response.Content.ReadAsStreamAsync(timeoutSource.Token).ConfigureAwait(false))
        using (var memory = new MemoryStream())
        {
            var buffer = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), timeoutSource.Token).ConfigureAwait(false)) > 0)
            {
                if (memory.Length + read > MaxBinaryResponseBytes)
                {
                    throw new OnlineUpstreamException("上游响应过大", 502);
                }

                memory.Write(buffer, 0, read);
            }

            bytes = memory.ToArray();
        }

        stopwatch.Stop();
        return new UpstreamBytes(bytes, response.Content.Headers.ContentType?.ToString(), status, stopwatch.ElapsedMilliseconds);
    }

    internal static string Describe(Exception exception) =>
        exception is OnlineUpstreamException upstream
            ? upstream.Message
            : exception.GetType().Name + ": " + exception.Message;

    private static HttpClient CreateClient()
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = true,
            AutomaticDecompression = DecompressionMethods.None,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            ConnectTimeout = TimeSpan.FromSeconds(15),
        };

        // Why: by default SocketsHttpHandler routes through the Windows system proxy. On the dev
        // machine that proxy answers QQ search with an empty HTTP 500, while a direct connection
        // works, so upstream traffic must not silently inherit OS proxy settings. Users who do
        // need a proxy can opt in with ZILUX2_ONLINE_PROXY (http://host:port); "direct" forces
        // the default.
        var proxySetting = Environment.GetEnvironmentVariable("ZILUX2_ONLINE_PROXY")?.Trim();
        if (!string.IsNullOrEmpty(proxySetting) && !proxySetting.Equals("direct", StringComparison.OrdinalIgnoreCase))
        {
            handler.Proxy = new WebProxy(proxySetting);
            handler.UseProxy = true;
            HostLog.Info("[online] upstream http proxy=" + proxySetting);
        }
        else
        {
            handler.UseProxy = false;
            HostLog.Info("[online] upstream http proxy=direct");
        }

        // Streaming a full song outlives any sane total timeout, so each call owns its own CTS.
        return new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }
}
