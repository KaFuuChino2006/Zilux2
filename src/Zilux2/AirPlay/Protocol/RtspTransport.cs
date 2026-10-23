using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace Zilux2.AirPlay.Protocol;

/// <summary>Parsed RTSP response (the RAOP handshake is synchronous request/response over one TCP stream).</summary>
internal sealed class RtspResponse
{
    private static readonly IReadOnlyDictionary<string, string> EmptyHeaders =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    public required int StatusCode { get; init; }

    public required string Reason { get; init; }

    public required IReadOnlyDictionary<string, string> Headers { get; init; }

    public byte[] Body { get; init; } = [];

    public bool IsSuccess => StatusCode is >= 200 and < 300;

    public string? Header(string name) => Headers.TryGetValue(name, out var value) ? value : null;

    public string Describe() => $"RTSP {StatusCode} {Reason}".TrimEnd();

    public override string ToString()
    {
        var builder = new StringBuilder(Describe());
        foreach (var (key, value) in Headers)
        {
            builder.Append(" | ").Append(key).Append('=').Append(value);
        }

        return builder.ToString();
    }
}

/// <summary>
/// Minimal RTSP-over-TCP transport: one connection, one outstanding request at a time.
/// RAOP uses plain request/response exchanges; every response must be read before the next request.
/// </summary>
internal sealed class RtspTransport : IDisposable
{
    private const int MaxHeaderBytes = 64 * 1024;

    private readonly TcpClient _client;
    private readonly NetworkStream _stream;
    private readonly MemoryStream _inbound = new(4096);
    private readonly byte[] _readBuffer = new byte[4096];
    private int _scanFrom;
    private bool _disposed;

    private RtspTransport(TcpClient client)
    {
        _client = client;
        _stream = client.GetStream();
    }

    public string Host { get; private init; } = "127.0.0.1";

    public int Port { get; private init; } = 7000;

    public DateTime LastActivityUtc { get; private set; } = DateTime.UtcNow;

    public static RtspTransport Connect(string host, int port, TimeSpan timeout)
    {
        var client = new TcpClient
        {
            NoDelay = true,
            SendTimeout = (int)timeout.TotalMilliseconds,
            ReceiveTimeout = (int)timeout.TotalMilliseconds,
        };

        var task = client.ConnectAsync(host, port);
        if (!task.Wait(timeout))
        {
            client.Dispose();
            throw new TimeoutException($"RTSP connect to {host}:{port} timed out.");
        }

        return new RtspTransport(client) { Host = host, Port = port };
    }

    /// <summary>
    /// Sends one RTSP request and blocks until its response arrives.
    /// Content-Length is added automatically when a body is supplied and the caller did not set it.
    /// </summary>
    public RtspResponse Send(string method, string uri, IEnumerable<KeyValuePair<string, string>>? headers = null, byte[]? body = null)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        var headerList = headers?.ToList() ?? [];
        var hasContentLength = headerList.Any(pair =>
            string.Equals(pair.Key, "Content-Length", StringComparison.OrdinalIgnoreCase));

        var request = new StringBuilder(256);
        request.Append(method).Append(' ').Append(uri).Append(" RTSP/1.0\r\n");
        foreach (var (key, value) in headerList)
        {
            request.Append(key).Append(": ").Append(value).Append("\r\n");
        }

        if (body is not null && !hasContentLength)
        {
            request.Append("Content-Length: ").Append(body.Length.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
        }

        request.Append("\r\n");

        var head = Encoding.UTF8.GetBytes(request.ToString());
        try
        {
            _stream.Write(head, 0, head.Length);
            if (body is { Length: > 0 })
            {
                _stream.Write(body, 0, body.Length);
            }

            _stream.Flush();
        }
        catch (Exception ex)
        {
            throw new IOException($"RTSP {method} {uri} write failed: {ex.Message}", ex);
        }

        LastActivityUtc = DateTime.UtcNow;
        return ReadResponse(method, uri);
    }

    private RtspResponse ReadResponse(string method, string uri)
    {
        var headerEnd = FindHeaderEnd();
        while (headerEnd < 0)
        {
            if (_inbound.Length > MaxHeaderBytes)
            {
                throw new InvalidDataException($"RTSP {method} response header exceeds {MaxHeaderBytes} bytes.");
            }

            ReadMore(method, uri);
            headerEnd = FindHeaderEnd();
        }

        var all = _inbound.GetBuffer();
        var headerText = Encoding.UTF8.GetString(all, 0, headerEnd);
        var lines = headerText.Split("\r\n", StringSplitOptions.None);
        if (lines.Length == 0 || !lines[0].StartsWith("RTSP/", StringComparison.Ordinal))
        {
            throw new InvalidDataException($"Malformed RTSP response status line: '{lines.FirstOrDefault()}'.");
        }

        var statusParts = lines[0].Split(' ', 3, StringSplitOptions.RemoveEmptyEntries);
        var statusCode = int.TryParse(statusParts.ElementAtOrDefault(1), NumberStyles.Integer, CultureInfo.InvariantCulture, out var code)
            ? code
            : 0;
        var reason = statusParts.Length > 2 ? statusParts[2] : string.Empty;

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 1; i < lines.Length; i++)
        {
            var line = lines[i];
            if (line.Length == 0)
            {
                continue;
            }

            var colon = line.IndexOf(':');
            if (colon <= 0)
            {
                continue;
            }

            var key = line[..colon].Trim();
            var value = line[(colon + 1)..].Trim();
            headers[key] = headers.TryGetValue(key, out var existing) ? $"{existing}, {value}" : value;
        }

        var contentLength = 0;
        if (headers.TryGetValue("Content-Length", out var lengthText))
        {
            _ = int.TryParse(lengthText, NumberStyles.Integer, CultureInfo.InvariantCulture, out contentLength);
        }

        var bodyStart = headerEnd + 4;
        while (_inbound.Length < bodyStart + contentLength)
        {
            ReadMore(method, uri);
        }

        var body = new byte[contentLength];
        if (contentLength > 0)
        {
            Array.Copy(all, bodyStart, body, 0, contentLength);
        }

        TrimConsumed(bodyStart + contentLength);
        LastActivityUtc = DateTime.UtcNow;

        return new RtspResponse
        {
            StatusCode = statusCode,
            Reason = reason,
            Headers = headers,
            Body = body,
        };
    }

    private int FindHeaderEnd()
    {
        var buffer = _inbound.GetBuffer();
        var length = (int)_inbound.Length;
        for (var i = Math.Max(0, _scanFrom); i + 3 < length; i++)
        {
            if (buffer[i] == '\r' && buffer[i + 1] == '\n' && buffer[i + 2] == '\r' && buffer[i + 3] == '\n')
            {
                return i;
            }
        }

        _scanFrom = Math.Max(0, length - 3);
        return -1;
    }

    private void ReadMore(string method, string uri)
    {
        int read;
        try
        {
            read = _stream.Read(_readBuffer, 0, _readBuffer.Length);
        }
        catch (IOException ex)
        {
            throw new IOException($"RTSP {method} {uri} read failed: {ex.Message}", ex);
        }

        if (read <= 0)
        {
            throw new IOException($"RTSP {method} {uri} failed: the device closed the connection.");
        }

        _inbound.Write(_readBuffer, 0, read);
    }

    private void TrimConsumed(int consumed)
    {
        var buffer = _inbound.GetBuffer();
        var remaining = (int)_inbound.Length - consumed;
        if (remaining > 0)
        {
            Buffer.BlockCopy(buffer, consumed, buffer, 0, remaining);
        }

        _inbound.SetLength(remaining);
        _inbound.Position = remaining;
        _scanFrom = Math.Max(0, remaining - 3);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        try
        {
            _stream.Dispose();
        }
        catch
        {
            // ignore
        }

        try
        {
            _client.Dispose();
        }
        catch
        {
            // ignore
        }

        _inbound.Dispose();
    }
}

/// <summary>HTTP Digest (RFC 2617) challenge as used by password-protected RAOP devices.</summary>
internal sealed class RtspDigestChallenge
{
    public string Realm { get; private init; } = string.Empty;

    public string Nonce { get; private init; } = string.Empty;

    public string? Opaque { get; private init; }

    public string Algorithm { get; private init; } = "MD5";

    public string? Qop { get; private init; }

    public static bool TryParse(string? wwwAuthenticate, out RtspDigestChallenge challenge)
    {
        challenge = null!;
        if (string.IsNullOrWhiteSpace(wwwAuthenticate))
        {
            return false;
        }

        var text = wwwAuthenticate.Trim();
        if (!text.StartsWith("Digest ", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var fields = ParseFields(text["Digest ".Length..]);
        if (!fields.TryGetValue("realm", out var realm) || !fields.TryGetValue("nonce", out var nonce))
        {
            return false;
        }

        fields.TryGetValue("opaque", out var opaque);
        fields.TryGetValue("algorithm", out var algorithm);
        fields.TryGetValue("qop", out var qop);
        challenge = new RtspDigestChallenge
        {
            Realm = realm,
            Nonce = nonce,
            Opaque = opaque,
            Algorithm = string.IsNullOrEmpty(algorithm) ? "MD5" : algorithm,
            Qop = qop?.Split(',')[0].Trim(),
        };
        return true;
    }

    public string BuildAuthorization(string userName, string password, string method, string uri, uint nonceCount = 1)
    {
        var algorithm = Algorithm.ToUpperInvariant();
        var ha1 = Hash($"{userName}:{Realm}:{password}", algorithm);
        var ha2 = Hash($"{method}:{uri}", algorithm);

        string response;
        var parts = new StringBuilder();
        parts.Append("Digest username=\"").Append(userName)
            .Append("\", realm=\"").Append(Realm)
            .Append("\", nonce=\"").Append(Nonce)
            .Append("\", uri=\"").Append(uri)
            .Append('"');

        if (!string.IsNullOrEmpty(Qop))
        {
            var cnonce = RandomNumberGenerator.GetHexString(16, lowercase: true);
            var nc = nonceCount.ToString("x8", CultureInfo.InvariantCulture);
            response = Hash($"{ha1}:{Nonce}:{nc}:{cnonce}:{Qop}:{ha2}", algorithm);
            parts.Append(", response=\"").Append(response)
                .Append("\", qop=").Append(Qop)
                .Append(", nc=").Append(nc)
                .Append(", cnonce=\"").Append(cnonce).Append('"');
        }
        else
        {
            response = Hash($"{ha1}:{Nonce}:{ha2}", algorithm);
            parts.Append(", response=\"").Append(response).Append('"');
        }

        if (!string.IsNullOrEmpty(Opaque))
        {
            parts.Append(", opaque=\"").Append(Opaque).Append('"');
        }

        if (!string.IsNullOrEmpty(Algorithm))
        {
            parts.Append(", algorithm=").Append(Algorithm);
        }

        return parts.ToString();
    }

    private static string Hash(string value, string algorithm)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        var digest = algorithm switch
        {
            "MD5" => MD5.HashData(bytes),
            "SHA-256" or "SHA256" => SHA256.HashData(bytes),
            _ => MD5.HashData(bytes),
        };
        return Convert.ToHexString(digest).ToLowerInvariant();
    }

    private static Dictionary<string, string> ParseFields(string text)
    {
        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var i = 0;
        while (i < text.Length)
        {
            while (i < text.Length && (text[i] == ',' || char.IsWhiteSpace(text[i])))
            {
                i++;
            }

            var keyStart = i;
            while (i < text.Length && text[i] != '=')
            {
                i++;
            }

            if (i >= text.Length)
            {
                break;
            }

            var key = text[keyStart..i].Trim();
            i++; // '='

            string value;
            if (i < text.Length && text[i] == '"')
            {
                i++;
                var valueStart = i;
                while (i < text.Length && text[i] != '"')
                {
                    i++;
                }

                value = text[valueStart..i];
                i++; // closing quote
            }
            else
            {
                var valueStart = i;
                while (i < text.Length && text[i] != ',')
                {
                    i++;
                }

                value = text[valueStart..i].Trim();
            }

            if (key.Length > 0)
            {
                fields[key] = value;
            }
        }

        return fields;
    }
}
