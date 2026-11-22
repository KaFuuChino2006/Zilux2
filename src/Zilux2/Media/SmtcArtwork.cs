using System.IO;
using System.Net.Http;
using Windows.Security.Cryptography;
using Windows.Storage.Streams;
using Zilux2.Online;

namespace Zilux2.Media;

/// <summary>
/// Turns whatever the page sends as a cover into a SMTC thumbnail: data URLs are decoded
/// locally, absolute/loopback http(s) URLs are fetched with a short timeout and a hard size cap.
/// Any failure is ignored (no artwork) so the transport controls keep working.
/// </summary>
internal static class SmtcArtwork
{
    internal const int MaxBytes = 5 * 1024 * 1024;

    /// <summary>本地歌曲库的封面用的是 virtual host，HttpClient 解析不了，交给宿主自己读文件。</summary>
    internal static Func<string, byte[]?>? LocalResolver;

    private const int ReadBufferSize = 64 * 1024;

    public static async Task<RandomAccessStreamReference?> LoadAsync(string source, CancellationToken cancellationToken)
    {
        try
        {
            var bytes = await ReadBytesAsync(source, cancellationToken).ConfigureAwait(false);
            if (bytes is null || bytes.Length == 0 || bytes.Length > MaxBytes)
            {
                return null;
            }

            return await CreateReferenceAsync(bytes).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return null;
        }
        catch (Exception exception)
        {
            // 启动/退出阶段本地封面代理还没监听（或已关闭）时的 connection refused 是预期情况，
            // 每首歌刷一条 WARN 只会淹掉真正的故障。
            var expected = exception is HttpRequestException
                && exception.Message.Contains("127.0.0.1", StringComparison.Ordinal);
            var line = $"[smtc] cover read failed: {exception.GetType().Name}: {exception.Message}";
            if (expected) HostLog.Info(line);
            else HostLog.Warn(line);
            return null;
        }
    }

    /// <summary>把封面解码成 WPF 图像（OSD 的小封面块用），失败返回 null。</summary>
    public static async Task<System.Windows.Media.Imaging.BitmapSource?> LoadImageAsync(
        string source,
        int decodeWidth,
        CancellationToken cancellationToken)
    {
        var bytes = await ReadBytesAsync(source, cancellationToken).ConfigureAwait(false);
        if (bytes is null || bytes.Length == 0)
        {
            return null;
        }

        try
        {
            var image = new System.Windows.Media.Imaging.BitmapImage();
            image.BeginInit();
            image.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
            image.DecodePixelWidth = Math.Max(16, decodeWidth);
            image.StreamSource = new MemoryStream(bytes, writable: false);
            image.EndInit();
            image.Freeze();
            return image;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[smtc] cover decode failed: {exception.GetType().Name}: {exception.Message}");
            return null;
        }
    }

    private static async Task<byte[]?> ReadBytesAsync(string source, CancellationToken cancellationToken)
    {
        var trimmed = source.Trim();
        if (trimmed.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            return ReadDataUrl(trimmed);
        }

        if (LocalResolver is not null)
        {
            var local = LocalResolver(trimmed);
            if (local is not null)
            {
                return local;
            }
        }

        if (!TryResolveHttpSource(trimmed, out var url))
        {
            return null;
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(3));

        using var response = await OnlineHttp.Client
            .GetAsync(url, HttpCompletionOption.ResponseHeadersRead, timeout.Token)
            .ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            return null;
        }

        var mediaType = response.Content.Headers.ContentType?.MediaType;
        if (mediaType is null || !mediaType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        if (response.Content.Headers.ContentLength is > MaxBytes)
        {
            return null;
        }

        await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
        using var buffer = new MemoryStream();
        var chunk = new byte[ReadBufferSize];
        while (true)
        {
            var read = await stream.ReadAsync(chunk, timeout.Token).ConfigureAwait(false);
            if (read <= 0)
            {
                break;
            }

            if (buffer.Length + read > MaxBytes)
            {
                return null;
            }

            buffer.Write(chunk, 0, read);
        }

        return buffer.ToArray();
    }

    private static byte[]? ReadDataUrl(string source)
    {
        var comma = source.IndexOf(',');
        if (comma < 0)
        {
            return null;
        }

        // data:<mime>;base64,<payload>
        if (source.AsSpan(0, comma).IndexOf("base64", StringComparison.OrdinalIgnoreCase) < 0)
        {
            return null;
        }

        var payload = source[(comma + 1)..].Trim();
        if (payload.Length == 0 || payload.Length > MaxBytes * 4L / 3 + 8)
        {
            return null;
        }

        try
        {
            var bytes = Convert.FromBase64String(payload);
            return bytes.Length > MaxBytes ? null : bytes;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    private static bool TryResolveHttpSource(string source, out string url)
    {
        url = string.Empty;

        // Relative /api/cover... paths are served by our own loopback server; add the token the
        // host already owns so the page is not required to send a fully qualified URL.
        if (source.StartsWith('/'))
        {
            var endpoint = App.Online?.Endpoint;
            if (endpoint is null)
            {
                return false;
            }

            url = $"http://127.0.0.1:{endpoint.Port}{WithCurrentToken(source, endpoint.Token)}";
            return true;
        }

        if (Uri.TryCreate(source, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
        {
            // 上一次运行生成的回环封面地址：端口是当时随机挑的，页面把队列存进 localStorage
            // 后这些地址会跨重启活下来，指向一个已经没人监听的端口（日志里
            // 「由于目标计算机积极拒绝 (127.0.0.1:58123)」）。页面侧已会重绑，这里再兜一层，
            // 这样即使加载的是旧缓存页面，系统媒体浮层也不会一直拿不到封面。
            if (IsLoopbackCover(uri) && App.Online?.Endpoint is { } current)
            {
                var query = WithCurrentToken(uri.PathAndQuery, current.Token);
                url = $"http://127.0.0.1:{current.Port}{query}";
                return true;
            }

            url = source;
            return true;
        }

        return false;
    }

    private static bool IsLoopbackCover(Uri uri)
    {
        if (!uri.IsLoopback) return false;
        return uri.AbsolutePath.EndsWith("/api/cover", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>把查询串里的 token 换成当前这一场的（没有就补上），其余参数保持原样。</summary>
    private static string WithCurrentToken(string pathAndQuery, string token)
    {
        var question = pathAndQuery.IndexOf('?');
        var path = question < 0 ? pathAndQuery : pathAndQuery[..question];
        var query = question < 0 ? string.Empty : pathAndQuery[(question + 1)..];
        var kept = query
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Where(pair =>
            {
                var equals = pair.IndexOf('=');
                var key = equals < 0 ? pair : pair[..equals];
                return !key.Equals("token", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
        kept.Add("token=" + Uri.EscapeDataString(token));
        return path + "?" + string.Join('&', kept);
    }

    private static async Task<RandomAccessStreamReference> CreateReferenceAsync(byte[] bytes)
    {
        var stream = new InMemoryRandomAccessStream();
        var buffer = CryptographicBuffer.CreateFromByteArray(bytes);
        await stream.WriteAsync(buffer);
        stream.Seek(0);
        return RandomAccessStreamReference.CreateFromStream(stream);
    }
}
