using System.Net;
using System.Net.Http;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Zilux2.Online.Account;

// QQ 音乐 App 扫码登录（tmeLoginType 6）。
//
// 流程：CreateQRCode 拿到 qrcodeID + 二维码 PNG；同时连 mu.y.qq.com 的 MQTT over WebSocket，
// 订阅 management.qrcode_login/<qrcodeID>；手机 QQ / 微信 / QQ 音乐 App 扫码后，服务端推送
// cookies 事件（含 qqmusic_uin / qqmusic_key），再调 musicu Login 换 musickey 并落库。
//
// 协议参考官方 Android 客户端与腾讯 TME 的私有接口，参数或端点变化时集中改这里。

internal sealed class QqMusicAppLoginProvider : IDisposable
{
    private const int QrExpiresSeconds = 900;
    private const int SessionKeepAliveSeconds = QrExpiresSeconds + 60;

    private sealed class Session
    {
        public required string Key { get; init; }
        public required QqMusicDevice Device { get; init; }
        public required DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset ExpiresAt { get; init; }
        public volatile string State = "waiting";
        public volatile string Message = "等待扫码…";
        public AccountInfo? Account { get; set; }
        public CancellationTokenSource Cts { get; } = new();
        public Task? Listener { get; set; }
    }

    private readonly AccountStore _store;
    private readonly QqLoginProvider _qq;
    private readonly HttpClient _http;
    private readonly ConcurrentDictionary<string, Session> _sessions = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _disposeCts = new();
    private bool _disposed;

    public QqMusicAppLoginProvider(AccountStore store, QqLoginProvider qq)
    {
        _store = store;
        _qq = qq;
        _http = QqMusicApi.CreateHttpClient();
    }

    public async Task<LoginQrResponse> CreateQrAsync(CancellationToken cancellationToken)
    {
        var device = QqMusicDevice.Create();
        var (q16, q36) = await QimeiBootstrap.FetchAsync(_http, device, cancellationToken).ConfigureAwait(false);
        device.Qimei = q16;
        device.Qimei36 = q36;

        var data = await QqMusicApi.CreateQrAsync(_http, device, cancellationToken).ConfigureAwait(false);
        var qrcodeId = data?["qrcodeID"]?.GetValue<string>() ?? string.Empty;
        var qrcode = data?["qrcode"]?.GetValue<string>() ?? string.Empty;
        var expiresIn = data?["expiresIn"]?.GetValue<int>() ?? QrExpiresSeconds;
        if (qrcodeId.Length == 0 || !qrcode.Contains("base64,", StringComparison.Ordinal))
        {
            throw new AccountException("upstream-failed", "QQ 音乐没有返回二维码，请稍后重试");
        }

        var session = new Session
        {
            Key = qrcodeId,
            Device = device,
            CreatedAt = DateTimeOffset.UtcNow,
            ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(Math.Clamp(expiresIn, 60, QrExpiresSeconds)),
        };
        session.Listener = Task.Run(() => ListenAsync(session), CancellationToken.None);
        _sessions[qrcodeId] = session;
        _ = Task.Run(() => CleanupAsync(session), CancellationToken.None);

        OnlineHttp.Info($"[account] qr source=qq channel=qqmusic keyLen={qrcodeId.Length} expiresIn={expiresIn}");
        return new LoginQrResponse
        {
            Source = AccountSources.Qq,
            Channel = "qqmusic",
            Mode = "image",
            Key = qrcodeId,
            ImageDataUrl = EnsureDataUrl(qrcode),
            ExpiresIn = Math.Clamp(expiresIn, 60, QrExpiresSeconds),
        };
    }

    public LoginStatusResponse Poll(string key)
    {
        if (!_sessions.TryGetValue(key, out var session))
        {
            return new LoginStatusResponse { State = "expired", Message = "二维码已过期，请重新生成" };
        }

        if (session.Account is { } account)
        {
            _sessions.TryRemove(key, out _);
            return new LoginStatusResponse
            {
                State = "authorized",
                Message = "登录成功",
                Account = account,
            };
        }

        if (DateTimeOffset.UtcNow >= session.ExpiresAt && session.State == "waiting")
        {
            return new LoginStatusResponse { State = "expired", Message = "二维码已过期，请重新生成" };
        }

        return new LoginStatusResponse
        {
            State = session.State,
            Message = session.Message,
        };
    }

    private async Task ListenAsync(Session session)
    {
        try
        {
            await QqMusicQrListener.RunAsync(
                session.Key,
                (type, payload) => OnEventAsync(session, type, payload),
                session.Cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // 会话取消/过期，正常收尾。
        }
        catch (Exception exception)
        {
            if (session.State is "waiting" or "scanned")
            {
                session.State = "error";
                session.Message = "扫码通道连接失败，请重新生成二维码";
            }

            OnlineHttp.Warn($"[account] qqmusic mqtt failed: {OnlineHttp.Describe(exception)}");
        }
        finally
        {
            session.Cts.Dispose();
        }
    }

    private async Task OnEventAsync(Session session, string type, JsonObject? payload)
    {
        switch (type)
        {
            case "scanned":
                session.State = "scanned";
                session.Message = "已扫码，请在手机上确认";
                break;
            case "cookies":
            case "authorized":
                await ExchangeAsync(session, payload).ConfigureAwait(false);
                break;
            case "canceled":
                session.State = "refused";
                session.Message = "已在手机上取消登录";
                break;
            case "timeout":
                session.State = "expired";
                session.Message = "二维码已过期，请重新生成";
                break;
            case "loginFailed":
                session.State = "error";
                session.Message = "登录失败，请重新扫码";
                break;
        }
    }

    private async Task ExchangeAsync(Session session, JsonObject? payload)
    {
        try
        {
            var cookies = payload?["cookies"] as JsonObject;
            var uin = cookies?["qqmusic_uin"]?["value"]?.GetValue<string>() ?? string.Empty;
            var token = cookies?["qqmusic_key"]?["value"]?.GetValue<string>() ?? string.Empty;
            if (uin.Length == 0 || token.Length == 0)
            {
                throw new AccountException("upstream-failed", "扫码结果缺少登录凭证，请重试");
            }

            var credential = await QqMusicApi.ExchangeCredentialAsync(
                _http, session.Device, session.Key, uin, token, session.Cts.Token).ConfigureAwait(false);
            var musicId = credential?["musicid"]?.ToString()
                          ?? credential?["str_musicid"]?.ToString()
                          ?? uin;
            var musicKey = credential?["musickey"]?.GetValue<string>() ?? string.Empty;
            if (musicKey.Length == 0)
            {
                throw new AccountException("upstream-failed", "QQ 音乐没有返回 musickey，请重试");
            }

            var account = await _qq.SaveCredentialAsync(musicId, musicKey, session.Cts.Token).ConfigureAwait(false);
            session.Account = account;
            session.State = "authorized";
            session.Message = "登录成功";
            OnlineHttp.Info($"[account] login source=qq channel=qqmusic userId={musicId} keyLen={musicKey.Length}");
        }
        catch (Exception exception)
        {
            session.State = "error";
            session.Message = exception is AccountException accountException
                ? accountException.Message
                : "登录凭证交换失败，请重试或改用 Cookie 导入";
            OnlineHttp.Warn($"[account] qqmusic exchange failed: {OnlineHttp.Describe(exception)}");
        }
    }

    private async Task CleanupAsync(Session session)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(SessionKeepAliveSeconds), _disposeCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        _sessions.TryRemove(session.Key, out _);
        try
        {
            session.Cts.Cancel();
        }
        catch
        {
            // ignore
        }
    }

    private static string EnsureDataUrl(string value)
    {
        if (value.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            return value;
        }

        var index = value.IndexOf("base64,", StringComparison.Ordinal);
        return index >= 0
            ? "data:image/png;" + value[(index - 5)..]
            : "data:image/png;base64," + value;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _disposeCts.Cancel();
        foreach (var session in _sessions.Values)
        {
            try
            {
                session.Cts.Cancel();
            }
            catch
            {
                // ignore
            }
        }

        _sessions.Clear();
        _http.Dispose();
        _disposeCts.Dispose();
    }
}

/// <summary>
/// 一条 QQ 音乐扫码会话的 MQTT 5 订阅（wss://mu.y.qq.com/ws/handshake）。
/// CONNECT 里带 qrcodeID 作为 userID/hashTag，订阅 management.qrcode_login/&lt;qrcodeID&gt;。
/// </summary>
internal static class QqMusicQrListener
{
    private const string Host = "mu.y.qq.com";
    private const string InitialPath = "/ws/handshake";

    public static async Task RunAsync(
        string qrcodeId,
        Func<string, JsonObject?, Task> onEvent,
        CancellationToken cancellationToken)
    {
        var path = InitialPath;
        for (var redirect = 0; redirect <= 3; redirect++)
        {
            using var socket = new ClientWebSocket();
            socket.Options.AddSubProtocol("mqtt");
            socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
            // 默认直连：系统代理对 WebSocket 的 CONNECT 经常回 502；需要代理时用同一个环境变量显式指定。
            var proxyValue = Environment.GetEnvironmentVariable("ZILUX2_ONLINE_PROXY");
            socket.Options.Proxy = !string.IsNullOrWhiteSpace(proxyValue) && Uri.TryCreate(proxyValue, UriKind.Absolute, out var proxyUri)
                ? new WebProxy(proxyUri)
                : null;
            var uri = new Uri($"wss://{Host}{path}");
            OnlineHttp.Info($"[account] qqmusic mqtt connect {uri}");
            using (var connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
            {
                connectTimeout.CancelAfter(TimeSpan.FromSeconds(15));
                await socket.ConnectAsync(uri, connectTimeout.Token).ConfigureAwait(false);
            }

            var reader = new MqttReader(socket);
            await reader.SendAsync(BuildConnect(qrcodeId), cancellationToken).ConfigureAwait(false);
            var (connackReason, server) = await reader.ReadConnAckAsync(cancellationToken).ConfigureAwait(false);
            OnlineHttp.Info($"[account] qqmusic mqtt connack reason=0x{connackReason:x2} redirect={server ?? "-"}");
            if (connackReason == 0)
            {
                await reader.SendAsync(BuildSubscribe(qrcodeId), cancellationToken).ConfigureAwait(false);
                await reader.ReadSubAckAsync(cancellationToken).ConfigureAwait(false);
                await reader.PumpAsync(qrcodeId, onEvent, cancellationToken).ConfigureAwait(false);
                return;
            }

            if (connackReason is not (0x9C or 0x9D) || string.IsNullOrEmpty(server))
            {
                throw new QqMusicApiException($"MQTT CONNACK 被拒绝（0x{connackReason:x2}）");
            }

            // 与官方客户端的重定向规则一致：路径最后一段本身带 :（已指向具体节点）就替换，否则追加。
            var segments = path.TrimEnd('/').Split('/');
            if (segments[^1].Contains(':')) segments[^1] = server;
            else segments = [.. segments, server];
            path = string.Join('/', segments);
        }

        throw new QqMusicApiException("MQTT 重定向次数过多");
    }

    private static byte[] BuildConnect(string qrcodeId)
    {
        var clientId = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString() + Random.Shared.Next(1000, 9999);
        var properties = Properties(
            ("15", Utf8("pass")),
            ("26", Pair("tmeAppID", "qqmusic")),
            ("26", Pair("business", "management")),
            ("26", Pair("hashTag", qrcodeId)),
            ("26", Pair("clientTag", "management.user")),
            ("26", Pair("userID", qrcodeId)));

        var body = new List<byte>();
        body.AddRange(Utf8("MQTT"));
        body.Add(0x05);
        body.Add(0x02);
        body.Add(0x00);
        body.Add(0x2D);
        body.AddRange(properties);
        body.AddRange(Utf8(clientId));
        return Packet(0x10, body.ToArray());
    }

    private static byte[] BuildSubscribe(string qrcodeId)
    {
        var properties = Properties(
            ("26", Pair("authorization", "tmelogin")),
            ("26", Pair("pubsub", "unicast")));
        var body = new List<byte> { 0x00, 0x01 };
        body.AddRange(properties);
        body.AddRange(Utf8($"management.qrcode_login/{qrcodeId}"));
        body.Add(0x00);
        return Packet(0x82, body.ToArray());
    }

    private static byte[] Properties(params (string Id, byte[] Value)[] items)
    {
        var data = new List<byte>();
        foreach (var (id, value) in items)
        {
            data.Add(Convert.ToByte(id, 16));
            data.AddRange(value);
        }

        var result = new List<byte>();
        result.AddRange(EncodeRemaining(data.Count));
        result.AddRange(data);
        return result.ToArray();
    }

    private static byte[] Pair(string key, string value)
    {
        var data = new List<byte>();
        data.AddRange(Utf8(key));
        data.AddRange(Utf8(value));
        return data.ToArray();
    }

    private static byte[] Utf8(string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        var result = new byte[2 + bytes.Length];
        result[0] = (byte)(bytes.Length >> 8);
        result[1] = (byte)(bytes.Length & 0xFF);
        bytes.CopyTo(result, 2);
        return result;
    }

    private static byte[] Packet(byte header, byte[] body)
    {
        var result = new List<byte> { header };
        result.AddRange(EncodeRemaining(body.Length));
        result.AddRange(body);
        return result.ToArray();
    }

    internal static byte[] EncodeRemaining(int value)
    {
        var bytes = new List<byte>();
        do
        {
            var digit = value % 128;
            value /= 128;
            if (value > 0) digit |= 0x80;
            bytes.Add((byte)digit);
        } while (value > 0);
        return bytes.ToArray();
    }

    internal static (int Value, int Bytes)? DecodeRemaining(byte[] buffer, int offset)
    {
        var multiplier = 1;
        var value = 0;
        for (var i = 0; i < 4; i++)
        {
            if (offset + i >= buffer.Length) return null;
            var digit = buffer[offset + i];
            value += (digit & 0x7F) * multiplier;
            if ((digit & 0x80) == 0) return (value, i + 1);
            multiplier *= 128;
        }

        throw new QqMusicApiException("MQTT remaining length 非法");
    }

    private sealed class MqttReader(ClientWebSocket socket)
    {
        private readonly List<byte> _buffer = new(4096);

        public async Task SendAsync(byte[] data, CancellationToken cancellationToken) =>
            await socket.SendAsync(data, WebSocketMessageType.Binary, true, cancellationToken).ConfigureAwait(false);

        public async Task<(int Reason, string? Server)> ReadConnAckAsync(CancellationToken cancellationToken)
        {
            while (true)
            {
                var packet = await ReadPacketAsync(cancellationToken).ConfigureAwait(false);
                if ((packet[0] >> 4) != 2) continue;
                var start = 1 + (DecodeRemaining(packet, 1)?.Bytes ?? 1);
                var reason = packet.Length > start + 1 ? packet[start + 1] : 0x80;
                // 重定向目标是标准属性 0x1C（Server Reference），不是 user property 里的 server。
                var server = ReadServerReference(packet, start + 2);
                return (reason, server);
            }
        }

        public async Task ReadSubAckAsync(CancellationToken cancellationToken)
        {
            while (true)
            {
                var packet = await ReadPacketAsync(cancellationToken).ConfigureAwait(false);
                if ((packet[0] >> 4) == 9) return;
            }
        }

        public async Task PumpAsync(string qrcodeId, Func<string, JsonObject?, Task> onEvent, CancellationToken cancellationToken)
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    while (!cancellationToken.IsCancellationRequested)
                    {
                        await Task.Delay(TimeSpan.FromSeconds(25), cancellationToken).ConfigureAwait(false);
                        await SendAsync(new byte[] { 0xC0, 0x00 }, cancellationToken).ConfigureAwait(false);
                    }
                }
                catch
                {
                    // socket closed
                }
            }, CancellationToken.None);

            while (!cancellationToken.IsCancellationRequested)
            {
                var packet = await ReadPacketAsync(cancellationToken).ConfigureAwait(false);
                if ((packet[0] >> 4) != 3) continue;
                var (type, payload) = ParsePublish(packet);
                if (type is null) continue;
                await onEvent(type, payload).ConfigureAwait(false);
                if (type is "cookies" or "authorized" or "canceled" or "timeout" or "loginFailed")
                {
                    return;
                }
            }
        }

        private async Task<byte[]> ReadPacketAsync(CancellationToken cancellationToken)
        {
            var chunk = new byte[16 * 1024];
            while (true)
            {
                ExtractPackets(out var packet);
                if (packet is not null) return packet;

                var result = await socket.ReceiveAsync(chunk, cancellationToken).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    throw new QqMusicApiException("MQTT 连接已被服务端关闭");
                }

                for (var i = 0; i < result.Count; i++)
                {
                    _buffer.Add(chunk[i]);
                }
            }
        }

        private void ExtractPackets(out byte[]? packet)
        {
            packet = null;
            if (_buffer.Count < 2) return;
            var data = _buffer.ToArray();
            var remaining = DecodeRemaining(data, 1);
            if (remaining is null) return;
            var total = 1 + remaining.Value.Bytes + remaining.Value.Value;
            if (_buffer.Count < total) return;
            packet = data[..total];
            _buffer.RemoveRange(0, total);
        }

        private static (string? Type, JsonObject? Payload) ParsePublish(byte[] packet)
        {
            var remaining = DecodeRemaining(packet, 1) ?? throw new QqMusicApiException("MQTT publish 截断");
            var cursor = 1 + remaining.Bytes;
            cursor = ReadUtf8(packet, cursor, out _);
            var qos = (packet[0] >> 1) & 0x03;
            if (qos > 0) cursor += 2;
            var propertiesLength = DecodeRemaining(packet, cursor) ?? throw new QqMusicApiException("MQTT properties 截断");
            var propsStart = cursor + propertiesLength.Bytes;
            var propsEnd = propsStart + propertiesLength.Value;
            string? type = null;
            var pos = propsStart;
            while (pos < propsEnd)
            {
                var id = packet[pos++];
                if (id == 0x26)
                {
                    pos = ReadUtf8(packet, pos, out var key);
                    pos = ReadUtf8(packet, pos, out var value);
                    if (key == "type") type = value;
                }
                else
                {
                    SkipProperty(packet, ref pos, id);
                }
            }

            var payloadText = Encoding.UTF8.GetString(packet, propsEnd, packet.Length - propsEnd);
            JsonObject? payload = null;
            if (!string.IsNullOrWhiteSpace(payloadText))
            {
                try
                {
                    payload = JsonNode.Parse(payloadText) as JsonObject;
                }
                catch (JsonException)
                {
                    payload = null;
                }
            }

            return (type, payload);
        }

        private static string? ReadServerReference(byte[] packet, int offset)
        {
            var length = DecodeRemaining(packet, offset);
            if (length is null) return null;
            var start = offset + length.Value.Bytes;
            var end = start + length.Value.Value;
            var pos = start;
            while (pos < end)
            {
                var id = packet[pos++];
                if (id == 0x1C)
                {
                    pos = ReadUtf8(packet, pos, out var reference);
                    if (reference.Length > 0) return reference;
                }
                else if (id == 0x26)
                {
                    pos = ReadUtf8(packet, pos, out _);
                    pos = ReadUtf8(packet, pos, out _);
                }
                else
                {
                    SkipProperty(packet, ref pos, id);
                }
            }

            return null;
        }

        private static int ReadUtf8(byte[] buffer, int pos, out string value)
        {
            var length = (buffer[pos] << 8) | buffer[pos + 1];
            pos += 2;
            value = Encoding.UTF8.GetString(buffer, pos, length);
            return pos + length;
        }

        private static void SkipProperty(byte[] buffer, ref int pos, byte id)
        {
            switch (id)
            {
                case 0x01:
                case 0x17:
                case 0x19:
                case 0x24:
                case 0x25:
                case 0x28:
                case 0x29:
                case 0x2A:
                    pos += 1;
                    break;
                case 0x13:
                case 0x21:
                case 0x22:
                case 0x23:
                    pos += 2;
                    break;
                case 0x02:
                case 0x11:
                case 0x18:
                case 0x27:
                    pos += 4;
                    break;
                case 0x03:
                case 0x08:
                case 0x12:
                case 0x1A:
                case 0x1C:
                case 0x1F:
                    pos = ReadUtf8(buffer, pos, out _);
                    break;
                case 0x09:
                case 0x16:
                    var textLength = (buffer[pos] << 8) | buffer[pos + 1];
                    pos += 2 + textLength;
                    break;
                case 0x0B:
                    pos += DecodeRemaining(buffer, pos)?.Bytes ?? 1;
                    break;
                default:
                    throw new QqMusicApiException($"MQTT 未知属性 0x{id:x2}");
            }
        }
    }
}






