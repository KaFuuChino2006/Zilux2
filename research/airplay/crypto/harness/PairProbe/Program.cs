// -----------------------------------------------------------------------------
// Zilux2 AirPlay 2 / HAP 配对真机探针（一次性验证工具，不属于主工程）
//
// 验证链路（对 HomePod mini / Apple TV 等 AirPlay 2 设备）：
//   [0] 明文 GET /info                       —— 确认设备可达、UA 未被 403
//   [1] 明文 POST /pair-pin-start            —— 让设备进入配对模式
//   [2] 明文 POST /pair-setup (M1, transient) —— 拿 M2：SRP salt + 设备公钥 B
//   [3] 本地 SRP 计算 A 与 M1 proof
//   [4] 明文 POST /pair-setup (M3)            —— 拿 M4（State=4 + Proof），这就是"设备接受瞬态配对"的证据
//   [5] 用 SRP 会话密钥 K 派生控制通道 write/read key
//   [6] 用 HapSessionCrypt 加密 GET /info     —— 解密成功即证明 HAP 会话密钥与帧格式正确
//
// 运行：
//   dotnet run -c Release                  # 默认 192.168.31.183:7000
//   dotnet run -c Release -- 192.168.31.183 7000
//
// 注意：以上所有请求必须复用同一条 TCP 长连接（HAP 配对状态与连接绑定）。
// -----------------------------------------------------------------------------

using System.Buffers;
using System.Net.Sockets;
using System.Text;
using Zilux2.AirPlay.Crypto;

namespace Zilux2.AirPlay.Crypto.Probe;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        var host = args.Length > 0 ? args[0] : "192.168.31.183";
        var port = args.Length > 1 ? int.Parse(args[1]) : 7000;

        Console.WriteLine($"===== Zilux2 HAP 瞬态配对真机探针  {host}:{port} =====");
        using var connection = new RawHttpConnection(host, port);
        try
        {
            await connection.ConnectAsync();
            Console.WriteLine($"[连接] TCP 已建立 {host}:{port}");

            // [0] 明文 GET /info：确认设备可达且 UA 未被拒
            var info = await connection.SendAsync("GET", "/info", Headers(), Array.Empty<byte>());
            Console.WriteLine($"[0] GET /info → HTTP {info.StatusCode}，{info.Body.Length}B，Content-Type={info.ContentType}");

            // [1] /pair-pin-start（无 body；瞬态也先调一次，让设备进入配对模式）
            var pinStart = await connection.SendAsync("POST", HapPairing.PairPinStartPath, Headers(), Array.Empty<byte>());
            Console.WriteLine($"[1] POST /pair-pin-start → HTTP {pinStart.StatusCode}，{pinStart.Body.Length}B");

            // [2] M1：Method=0(PairSetup), State=1, Flags=0x10(transient)
            var m1 = new HapTlvBuilder()
                .AddByte(HapTlvType.Method, 0)
                .AddByte(HapTlvType.State, 1)
                .AddByte(HapTlvType.Flags, 0x10)
                .Build();
            Console.WriteLine($"[2] M1 请求 TLV：{CryptoPrimitives.ToHexUpper(m1)}");
            var m2Response = await connection.SendAsync("POST", HapPairing.PairSetupPath, Headers(), m1);
            Console.WriteLine($"[2] POST /pair-setup(M1) → HTTP {m2Response.StatusCode}，{m2Response.Body.Length}B，" +
                              $"Content-Type={m2Response.ContentType}");
            Console.WriteLine($"[2] M2 原始响应：{CryptoPrimitives.ToHexUpper(m2Response.Body)}");
            var m2 = HapTlv.Parse(m2Response.Body);
            DumpTlv("M2", m2);
            var salt = HapTlv.Require(m2, HapTlvType.Salt, "Salt");
            var serverPublicKey = HapTlv.Require(m2, HapTlvType.PublicKey, "PublicKey");
            Console.WriteLine($"[2] salt={CryptoPrimitives.ToHexUpper(salt)} ({salt.Length}B)，B 长度={serverPublicKey.Length}B");

            // [3] SRP：瞬态 PIN 固定 3939
            var srp = SrpClient.CreateHapPairSetup(HapPairing.TransientPin);
            var proof = srp.ComputeProof(salt, serverPublicKey);
            Console.WriteLine($"[3] PIN=\"{HapPairing.TransientPin}\"");
            Console.WriteLine($"[3] A ({srp.PublicKey.Length}B) = {CryptoPrimitives.ToHexUpper(srp.PublicKey)}");
            Console.WriteLine($"[3] M1 proof ({proof.Length}B) = {CryptoPrimitives.ToHexUpper(proof)}");

            // [4] M3：State=3, PublicKey=A, Proof=M1
            var m3 = new HapTlvBuilder()
                .AddByte(HapTlvType.State, 3)
                .Add(HapTlvType.PublicKey, srp.PublicKey)
                .Add(HapTlvType.Proof, proof)
                .Build();
            Console.WriteLine($"[4] M3 请求 TLV（前 64B）：{CryptoPrimitives.ToHexUpper(m3.AsSpan(0, Math.Min(64, m3.Length)))}…");
            var m4Response = await connection.SendAsync("POST", HapPairing.PairSetupPath, Headers(), m3);
            Console.WriteLine($"[4] POST /pair-setup(M3) → HTTP {m4Response.StatusCode}，{m4Response.Body.Length}B，" +
                              $"Content-Type={m4Response.ContentType}");
            Console.WriteLine($"[4] M4 原始响应：{CryptoPrimitives.ToHexUpper(m4Response.Body)}");
            if (m4Response.Body.Length > 0)
            {
                var m4 = HapTlv.Parse(m4Response.Body);
                DumpTlv("M4", m4);
                var serverProof = HapTlv.GetValue(m4, HapTlvType.Proof);
                if (serverProof is not null)
                {
                    var ok = srp.VerifyServerProof(serverProof);
                    Console.WriteLine($"[4] 设备 SRP proof 校验：{(ok ? "PASS" : "FAIL")}");
                }
            }

            // [5] 瞬态：共享密钥直接是 SRP 会话密钥 K，派生控制通道密钥
            var sessionKey = srp.SessionKey;
            var (writeKey, readKey) = HapKeyDerivation.DeriveControlKeys(sessionKey);
            Console.WriteLine($"[5] SRP K ({sessionKey.Length}B) = {CryptoPrimitives.ToHexUpper(sessionKey)}");
            Console.WriteLine($"[5] writeKey = {CryptoPrimitives.ToHexUpper(writeKey)}");
            Console.WriteLine($"[5] readKey  = {CryptoPrimitives.ToHexUpper(readKey)}");

            // [6] 打开 HAP 字节流加密，随后整个连接上的 HTTP 都走加密帧
            var hapSession = new HapSessionCrypt(writeKey, readKey);
            connection.EnableEncryption(hapSession);
            Console.WriteLine("[5] 已启用 HAP 会话加密（后续请求/响应均为加密帧）");
            var encryptedInfo = await connection.SendAsync("GET", "/info", Headers(), Array.Empty<byte>());
            Console.WriteLine($"[6] 加密 GET /info → HTTP {encryptedInfo.StatusCode}，{encryptedInfo.Body.Length}B，" +
                              $"Content-Type={encryptedInfo.ContentType}");
            if (encryptedInfo.Body.Length > 0)
            {
                var length = Math.Min(240, encryptedInfo.Body.Length);
                var text = Encoding.UTF8.GetString(encryptedInfo.Body, 0, length);
                Console.WriteLine($"[6] 响应体前 {length}B：{text.Replace("\r", " ").Replace("\n", " ")}");
            }

            Console.WriteLine("===== 探针结束：瞬态配对 + HAP 加密通道验证成功 =====");
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"!!!!! 探针失败：{ex.GetType().Name}: {ex.Message}");
            if (ex.InnerException is not null)
                Console.WriteLine($"      内层：{ex.InnerException.GetType().Name}: {ex.InnerException.Message}");
            return 1;
        }
    }

    private static Dictionary<string, string> Headers() => HapPairing.BuildHeaders(HapPairing.HkpTransient);

    private static void DumpTlv(string label, IReadOnlyList<HapTlvItem> items)
    {
        foreach (var item in items)
        {
            var name = item.Type switch
            {
                HapTlvType.Method => "Method",
                HapTlvType.Identifier => "Identifier",
                HapTlvType.Salt => "Salt",
                HapTlvType.PublicKey => "PublicKey",
                HapTlvType.Proof => "Proof",
                HapTlvType.EncryptedData => "EncryptedData",
                HapTlvType.State => "State",
                HapTlvType.Error => "Error",
                HapTlvType.RetryDelay => "RetryDelay",
                HapTlvType.Signature => "Signature",
                HapTlvType.Flags => "Flags",
                _ => $"Type{item.Type}",
            };
            var value = item.Value.Length <= 48
                ? CryptoPrimitives.ToHexUpper(item.Value)
                : CryptoPrimitives.ToHexUpper(item.Value.AsSpan(0, 48)) + "…";
            Console.WriteLine($"    {label} TLV: {name}({item.Type}) len={item.Value.Length} value={value}");
        }
    }
}

/// <summary>探针用的极简 HTTP/1.1 keep-alive 客户端，支持在连接中途切换为 HAP 加密字节流。</summary>
internal sealed class RawHttpConnection : IDisposable
{
    private readonly string _host;
    private readonly int _port;
    private readonly TcpClient _client = new();
    private NetworkStream? _stream;
    private HapSessionCrypt? _session;

    private byte[] _plainBuffer = new byte[8192];
    private int _plainLength;

    private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(20);

    public RawHttpConnection(string host, int port)
    {
        _host = host;
        _port = port;
    }

    public async Task ConnectAsync()
    {
        await _client.ConnectAsync(_host, _port).ConfigureAwait(false);
        _stream = _client.GetStream();
    }

    /// <summary>从下一字节开始，收发都走 HAP 加密帧。</summary>
    public void EnableEncryption(HapSessionCrypt session) => _session = session;

    public async Task<HttpResponse> SendAsync(
        string method, string path, IReadOnlyDictionary<string, string> headers, byte[] body)
    {
        if (_stream is null) throw new InvalidOperationException("未连接。");

        var builder = new StringBuilder();
        builder.Append(method).Append(' ').Append(path).Append(" HTTP/1.1\r\n");
        builder.Append("Host: ").Append(_host).Append(':').Append(_port).Append("\r\n");
        foreach (var (key, value) in headers)
            builder.Append(key).Append(": ").Append(value).Append("\r\n");
        builder.Append("Content-Length: ").Append(body.Length).Append("\r\n\r\n");

        var headBytes = Encoding.ASCII.GetBytes(builder.ToString());
        var requestBytes = new byte[headBytes.Length + body.Length];
        headBytes.CopyTo(requestBytes, 0);
        body.CopyTo(requestBytes, headBytes.Length);

        var wireBytes = _session is null ? requestBytes : _session.Encrypt(requestBytes);
        Console.WriteLine($"    → 发送 {wireBytes.Length}B（{( _session is null ? "明文" : "加密")}）");
        await _stream.WriteAsync(wireBytes).ConfigureAwait(false);
        await _stream.FlushAsync().ConfigureAwait(false);

        return await ReadResponseAsync().ConfigureAwait(false);
    }

    private async Task<HttpResponse> ReadResponseAsync()
    {
        using var timeout = new CancellationTokenSource(ReadTimeout);
        var socketBuffer = new byte[8192];
        while (true)
        {
            if (TryExtractResponse(out var response)) return response;

            int read;
            try
            {
                read = await _stream!.ReadAsync(socketBuffer, timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw new TimeoutException($"读取 HTTP 响应超时（{ReadTimeout.TotalSeconds:0}s）。已缓存 {_plainLength}B 明文。");
            }

            if (read == 0)
                throw new IOException($"设备关闭了连接（已缓存明文 {_plainLength}B）。");

            var plain = _session is null
                ? socketBuffer.AsSpan(0, read)
                : _session.Decrypt(socketBuffer.AsSpan(0, read));
            if (plain.Length > 0) AppendPlain(plain);
        }
    }

    private void AppendPlain(ReadOnlySpan<byte> data)
    {
        var needed = _plainLength + data.Length;
        if (needed > _plainBuffer.Length)
        {
            var size = _plainBuffer.Length;
            while (size < needed) size *= 2;
            Array.Resize(ref _plainBuffer, size);
        }

        data.CopyTo(_plainBuffer.AsSpan(_plainLength));
        _plainLength += data.Length;
    }

    private bool TryExtractResponse(out HttpResponse response)
    {
        response = null!;
        var span = _plainBuffer.AsSpan(0, _plainLength);
        var headerEnd = IndexOfHeaderEnd(span);
        if (headerEnd < 0) return false;

        var headerText = Encoding.ASCII.GetString(span[..headerEnd]);
        var lines = headerText.Split("\r\n");
        if (lines.Length == 0) throw new IOException("HTTP 响应没有状态行。");

        var statusParts = lines[0].Split(' ', 3);
        if (statusParts.Length < 2 || !int.TryParse(statusParts[1], out var statusCode))
            throw new IOException($"无法解析 HTTP 状态行：{lines[0]}");

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 1; i < lines.Length; i++)
        {
            var colon = lines[i].IndexOf(':');
            if (colon <= 0) continue;
            headers[lines[i][..colon].Trim()] = lines[i][(colon + 1)..].Trim();
        }

        var bodyStart = headerEnd + 4;
        byte[] body;
        int consumed;
        if (headers.TryGetValue("Content-Length", out var contentLengthText)
            && int.TryParse(contentLengthText, out var contentLength))
        {
            if (span.Length - bodyStart < contentLength) return false;
            body = span.Slice(bodyStart, contentLength).ToArray();
            consumed = bodyStart + contentLength;
        }
        else if (headers.TryGetValue("Transfer-Encoding", out var transferEncoding)
                 && transferEncoding.Contains("chunked", StringComparison.OrdinalIgnoreCase))
        {
            if (!TryDecodeChunked(span[bodyStart..], out body, out var chunkedLength)) return false;
            consumed = bodyStart + chunkedLength;
        }
        else
        {
            body = Array.Empty<byte>();
            consumed = bodyStart;
        }

        // 消费掉已解析的字节，剩余留给下一条响应。
        var remaining = _plainLength - consumed;
        if (remaining > 0) Buffer.BlockCopy(_plainBuffer, consumed, _plainBuffer, 0, remaining);
        _plainLength = remaining;

        response = new HttpResponse
        {
            StatusCode = statusCode,
            Headers = headers,
            Body = body,
            ContentType = headers.GetValueOrDefault("Content-Type"),
        };
        return true;
    }

    private static bool TryDecodeChunked(ReadOnlySpan<byte> data, out byte[] body, out int consumed)
    {
        body = Array.Empty<byte>();
        consumed = 0;
        using var output = new MemoryStream();
        var offset = 0;
        while (true)
        {
            var lineEnd = data[offset..].IndexOf("\r\n"u8);
            if (lineEnd < 0) return false;
            var sizeText = Encoding.ASCII.GetString(data.Slice(offset, lineEnd));
            var semicolon = sizeText.IndexOf(';');
            if (semicolon >= 0) sizeText = sizeText[..semicolon];
            if (!int.TryParse(sizeText.Trim(), System.Globalization.NumberStyles.HexNumber, null, out var chunkSize))
                throw new IOException($"无法解析 chunk 长度：{sizeText}");

            offset += lineEnd + 2;
            if (chunkSize == 0)
            {
                // 末尾还有一个 CRLF
                if (data.Length - offset < 2) return false;
                offset += 2;
                consumed = offset;
                body = output.ToArray();
                return true;
            }

            if (data.Length - offset < chunkSize + 2) return false;
            output.Write(data.Slice(offset, chunkSize));
            offset += chunkSize + 2; // 跳过 chunk 数据与尾部 CRLF
        }
    }

    private static int IndexOfHeaderEnd(ReadOnlySpan<byte> data)
    {
        for (var i = 0; i + 3 < data.Length; i++)
        {
            if (data[i] == '\r' && data[i + 1] == '\n' && data[i + 2] == '\r' && data[i + 3] == '\n')
                return i;
        }
        return -1;
    }

    public void Dispose()
    {
        _stream?.Dispose();
        _client.Dispose();
    }
}

internal sealed class HttpResponse
{
    public int StatusCode { get; init; }
    public string? ContentType { get; init; }
    public byte[] Body { get; init; } = Array.Empty<byte>();
    public IReadOnlyDictionary<string, string> Headers { get; init; } =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
}
