using System.Diagnostics;
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
}

internal sealed class LyricData
{
    public string Lrc { get; init; } = string.Empty;

    public string? Translation { get; init; }

    // 逐字歌词原文（网易云 yrc，格式 `[start,dur](start,dur)字…`），前端自行解析
    public string? Yrc { get; init; }

    // QQ QRC 加密十六进制原文（前端用 qrc-decoder 本地解密），仅 QQ 有
    public string? Qrc { get; init; }
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

    public static StreamResolution Playable(
        string url,
        IReadOnlyDictionary<string, string>? headers = null,
        string qualityLabel = "",
        int bitrate = 0,
        string format = "") =>
        new()
        {
            IsPlayable = true,
            Url = url,
            Headers = headers ?? NoHeaders,
            QualityLabel = qualityLabel,
            Bitrate = bitrate,
            Format = format,
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
        var body = await response.Content.ReadAsStringAsync(timeoutSource.Token).ConfigureAwait(false);
        stopwatch.Stop();
        var status = (int)response.StatusCode;
        if (!response.IsSuccessStatusCode)
        {
            throw new OnlineUpstreamException($"upstream HTTP {status}", status);
        }

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
        var bytes = await response.Content.ReadAsByteArrayAsync(timeoutSource.Token).ConfigureAwait(false);
        stopwatch.Stop();
        var status = (int)response.StatusCode;
        if (!response.IsSuccessStatusCode)
        {
            throw new OnlineUpstreamException($"upstream HTTP {status}", status);
        }

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
