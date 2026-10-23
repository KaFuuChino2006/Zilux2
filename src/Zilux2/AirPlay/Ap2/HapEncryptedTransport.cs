using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.Text;
using Zilux2.AirPlay.Protocol;

namespace Zilux2.AirPlay.Ap2;

/// <summary>
/// RTSP transport for an AirPlay 2 control connection. The connection starts in plaintext (the
/// transient <c>POST /pair-setup</c> handshake runs there) and is upgraded in place with
/// <see cref="EnableEncryption"/>: from that moment every byte in both directions is wrapped in HAP
/// frames by the injected <see cref="IFrameCryptor"/>s, exactly like the real receiver does. The
/// request line, headers and <see cref="RtspResponse"/> type stay identical to classic RAOP so the
/// rest of the sender code does not care which channel it is talking on.
/// </summary>
internal sealed class HapEncryptedTransport : IDisposable
{
    private const int MaxHeaderBytes = 64 * 1024;

    private readonly TcpClient _client;
    private readonly NetworkStream _stream;
    private readonly MemoryStream _plaintextIn = new(4096);
    private readonly byte[] _readBuffer = new byte[4096];
    private readonly object _requestLock = new();
    private int _scanFrom;
    private uint _cSeq;
    private bool _disposed;

    private HapEncryptedTransport(TcpClient client)
    {
        _client = client;
        _stream = client.GetStream();
    }

    public string Host { get; private init; } = "127.0.0.1";

    public int Port { get; private init; } = 7000;

    public DateTime LastActivityUtc { get; private set; } = DateTime.UtcNow;

    /// <summary>True once <see cref="EnableEncryption"/> switched the channel to HAP frames.</summary>
    public bool IsEncrypted { get; private set; }

    /// <summary>Last CSeq sent, exposed for diagnostics.</summary>
    public uint LastCSeq => _cSeq;

    public static HapEncryptedTransport Connect(string host, int port, TimeSpan timeout)
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
            throw new TimeoutException($"AirPlay 2 connect to {host}:{port} timed out.");
        }

        return new HapEncryptedTransport(client) { Host = host, Port = port };
    }

    /// <summary>
    /// Switches to the encrypted channel. Must be called exactly once, right after
    /// <c>/pair-setup</c> completes and before the next request; all earlier bytes must already be
    /// consumed (the pairing exchange is strictly request/response).
    /// </summary>
    public void EnableEncryption(IFrameCryptor writeCryptor, IFrameCryptor readCryptor)
    {
        ArgumentNullException.ThrowIfNull(writeCryptor);
        ArgumentNullException.ThrowIfNull(readCryptor);
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (IsEncrypted)
        {
            throw new InvalidOperationException("The AirPlay 2 channel is already encrypted.");
        }

        if (_plaintextIn.Length != 0)
        {
            throw new InvalidOperationException(
                $"Cannot enable encryption: {_plaintextIn.Length} plaintext byte(s) are still buffered.");
        }

        _writeCryptor = writeCryptor;
        _readCryptor = readCryptor;
        IsEncrypted = true;
    }

    private IFrameCryptor _writeCryptor = NullFrameCryptor.Instance;
    private IFrameCryptor _readCryptor = NullFrameCryptor.Instance;

    /// <summary>
    /// Sends one RTSP request and blocks until its response arrives. In plaintext mode the request
    /// line is <c>METHOD URI RTSP/1.0</c>; pass <paramref name="protocolVersion"/> = "HTTP/1.1" for
    /// the pairing endpoint when a receiver insists on the HTTP spelling (HomePod accepts both).
    /// </summary>
    public RtspResponse Send(
        string method,
        string uri,
        IEnumerable<KeyValuePair<string, string>>? headers = null,
        byte[]? body = null,
        string protocolVersion = "RTSP/1.0")
    {
        lock (_requestLock)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);

            var headerList = headers?.ToList() ?? [];
            var hasContentLength = headerList.Any(pair =>
                string.Equals(pair.Key, "Content-Length", StringComparison.OrdinalIgnoreCase));

            _cSeq++;
            var request = new StringBuilder(256);
            request.Append(method).Append(' ').Append(uri).Append(' ').Append(protocolVersion).Append("\r\n");
            request.Append("CSeq: ").Append(_cSeq.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
            foreach (var (key, value) in headerList)
            {
                request.Append(key).Append(": ").Append(value).Append("\r\n");
            }

            if (body is not null && !hasContentLength)
            {
                request.Append("Content-Length: ")
                    .Append(body.Length.ToString(CultureInfo.InvariantCulture))
                    .Append("\r\n");
            }

            request.Append("\r\n");

            var head = Encoding.UTF8.GetBytes(request.ToString());
            var plaintext = new byte[head.Length + (body?.Length ?? 0)];
            Buffer.BlockCopy(head, 0, plaintext, 0, head.Length);
            if (body is { Length: > 0 })
            {
                Buffer.BlockCopy(body, 0, plaintext, head.Length, body.Length);
            }

            var frame = _writeCryptor.Encrypt(plaintext);
            var firstLineEnd = request.ToString().IndexOf("\r\n", StringComparison.Ordinal);
            var firstLine = firstLineEnd > 0 ? request.ToString(0, firstLineEnd) : method;
            HostLog.Info(
                $"[airplay] AP2 tx {firstLine} encrypted={IsEncrypted} cipher={frame.Length}B plain={plaintext.Length}B");
            try
            {
                _stream.Write(frame, 0, frame.Length);
                _stream.Flush();
            }
            catch (Exception ex)
            {
                throw new IOException($"AirPlay 2 {method} {uri} write failed: {ex.Message}", ex);
            }

            LastActivityUtc = DateTime.UtcNow;
            return ReadResponse(method, uri);
        }
    }

    private RtspResponse ReadResponse(string method, string uri)
    {
        var headerEnd = FindHeaderEnd();
        while (headerEnd < 0)
        {
            if (_plaintextIn.Length > MaxHeaderBytes)
            {
                throw new InvalidDataException($"AirPlay 2 {method} response header exceeds {MaxHeaderBytes} bytes.");
            }

            ReadMore(method, uri);
            headerEnd = FindHeaderEnd();
        }

        var buffer = _plaintextIn.GetBuffer();
        var headerText = Encoding.UTF8.GetString(buffer, 0, headerEnd);
        var lines = headerText.Split("\r\n", StringSplitOptions.None);
        if (lines.Length == 0 || !(lines[0].StartsWith("RTSP/", StringComparison.Ordinal)
            || lines[0].StartsWith("HTTP/", StringComparison.Ordinal)))
        {
            throw new InvalidDataException($"Malformed AirPlay 2 response status line: '{lines.FirstOrDefault()}'.");
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
        while (_plaintextIn.Length < bodyStart + contentLength)
        {
            ReadMore(method, uri);
        }

        var all = _plaintextIn.GetBuffer();
        var body = new byte[contentLength];
        if (contentLength > 0)
        {
            Buffer.BlockCopy(all, bodyStart, body, 0, contentLength);
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
        var buffer = _plaintextIn.GetBuffer();
        var length = (int)_plaintextIn.Length;
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
            throw new IOException($"AirPlay 2 {method} {uri} read failed: {ex.Message}", ex);
        }

        if (read <= 0)
        {
            throw new IOException($"AirPlay 2 {method} {uri} failed: the device closed the connection.");
        }

        var plaintext = _readCryptor.Decrypt(_readBuffer.AsSpan(0, read));
        if (plaintext.Length > 0)
        {
            _plaintextIn.Write(plaintext, 0, plaintext.Length);
        }
    }

    private void TrimConsumed(int consumed)
    {
        var buffer = _plaintextIn.GetBuffer();
        var remaining = (int)_plaintextIn.Length - consumed;
        if (remaining > 0)
        {
            Buffer.BlockCopy(buffer, consumed, buffer, 0, remaining);
        }

        _plaintextIn.SetLength(remaining);
        _plaintextIn.Position = remaining;
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

        _plaintextIn.Dispose();
    }
}
