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
            HostLog.Warn($"[smtc] cover read failed: {exception.GetType().Name}: {exception.Message}");
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

            var path = source;
            if (!path.Contains("token=", StringComparison.Ordinal))
            {
                path += (path.Contains('?') ? "&" : "?") + "token=" + endpoint.Token;
            }

            url = $"http://127.0.0.1:{endpoint.Port}{path}";
            return true;
        }

        if (Uri.TryCreate(source, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
        {
            url = source;
            return true;
        }

        return false;
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
