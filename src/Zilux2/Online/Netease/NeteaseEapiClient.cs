using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Zilux2.Online.Account;

namespace Zilux2.Online.Netease;

/// <summary>eapi 播放地址；trial=true 表示 30 秒试听，bitrate/format 仍保留上游返回值。</summary>
internal sealed record NeteaseEapiStream(string Url, int Bitrate, string Format, string Level, bool IsTrial);

/// <summary>eapi LRC + 翻译轨 + 逐字轨；后两者可能为空。</summary>
internal sealed record NeteaseEapiLyric(string Lrc, string? Translation, string? Yrc);

// 网易云 eapi 客户端（research/netease-api.md §2.4/§2.5）：加密 params、POST 表单、解析明文/密文 JSON。
// 只提供播放地址与歌词两个只读查询；失败分类返回，不向上抛（调用方取消除外）。
internal sealed class NeteaseEapiClient
{
    private const string EndpointBase = "https://interface.music.163.com";
    private const string AccountSource = "netease";
    private const string CookieHost = "interface.music.163.com";
    private const string RefererUrl = "https://music.163.com/";
    private const string SongUrlUri = "/api/song/enhance/player/url/v1";
    private const string LyricUri = "/api/song/lyric/v1";

    // 实测可用的桌面客户端 UA（research/ncm-probe/probe2.cjs）。
    private const string UserAgent =
        "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.41.205564";

    private const int MaxResponseBytes = 8 * 1024 * 1024;
    private static readonly TimeSpan Timeout = NativeFirstPolicy.Timeout;
    private static readonly string[] MusicCookieNames = ["MUSIC_U", "MUSIC_A", "NMTID"];

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly AccountService? _accounts;
    private readonly string _deviceId = Guid.NewGuid().ToString("N").ToUpperInvariant();

    internal NeteaseEapiClient(AccountService? accounts = null) => _accounts = accounts;

    /// <summary>
    /// /eapi/song/enhance/player/url/v1。无权益的 VIP 曲目会返回 30 秒试听地址（url 非空、trial=true）。
    /// </summary>
    internal async Task<NativeResult<NeteaseEapiStream>> GetSongUrlAsync(
        long songId,
        string level,
        CancellationToken cancellationToken = default)
    {
        var tag = $"POST netease/eapi player-url id={songId} level={level}";
        var (payload, cookieHeader) = BuildPayload(new JsonObject
        {
            ["ids"] = "[" + songId.ToString(CultureInfo.InvariantCulture) + "]",
            ["level"] = level,
            ["encodeType"] = "flac",
        });

        var stopwatch = Stopwatch.StartNew();
        var document = await PostAsync(SongUrlUri, payload, cookieHeader, tag, cancellationToken).ConfigureAwait(false);
        if (document is null)
        {
            return NativeResult<NeteaseEapiStream>.Failed();
        }

        using (document)
        {
            var root = document.RootElement;
            if (!TryGetDataItem(root, out var item))
            {
                OnlineHttp.Warn($"{tag} no data item code={ReadInt32(root, "code")} {stopwatch.ElapsedMilliseconds}ms");
                return NativeResult<NeteaseEapiStream>.Failed();
            }

            var url = ReadString(item, "url");
            var br = ReadInt32(item, "br");
            var type = ReadString(item, "type");
            var actualLevel = ReadString(item, "level");
            var trial = item.TryGetProperty("freeTrialInfo", out var trialInfo) && trialInfo.ValueKind == JsonValueKind.Object;
            if (url.Length == 0)
            {
                OnlineHttp.Warn($"{tag} returned no url code={ReadInt32(item, "code")} br={br} {stopwatch.ElapsedMilliseconds}ms");
                return NativeResult<NeteaseEapiStream>.Unavailable();
            }

            OnlineHttp.Info($"{tag} actual={actualLevel} br={br} type={type} trial={trial} ok {stopwatch.ElapsedMilliseconds}ms");
            return NativeResult<NeteaseEapiStream>.Ok(new NeteaseEapiStream(url, br, type, actualLevel, trial));
        }
    }

    /// <summary>/eapi/song/lyric/v1，返回 LRC + tlyric 翻译轨 + yrc 逐字轨（无歌词时 Unavailable）。</summary>
    internal async Task<NativeResult<NeteaseEapiLyric>> GetLyricAsync(
        long songId,
        CancellationToken cancellationToken = default)
    {
        var tag = $"POST netease/eapi lyric id={songId}";
        // 与 web 路径一致用 -1 取全量轨道；0 在实测中不会返回 tlyric。
        var (payload, cookieHeader) = BuildPayload(new JsonObject
        {
            ["id"] = songId,
            ["cp"] = false,
            ["tv"] = -1,
            ["lv"] = -1,
            ["rv"] = -1,
            ["kv"] = -1,
            ["yv"] = -1,
            ["ytv"] = -1,
            ["yrv"] = -1,
        });

        var stopwatch = Stopwatch.StartNew();
        var document = await PostAsync(LyricUri, payload, cookieHeader, tag, cancellationToken).ConfigureAwait(false);
        if (document is null)
        {
            return NativeResult<NeteaseEapiLyric>.Failed();
        }

        using (document)
        {
            var root = document.RootElement;
            var lyric = root.TryGetProperty("lrc", out var lrc) && lrc.ValueKind == JsonValueKind.Object
                ? ReadString(lrc, "lyric")
                : string.Empty;
            if (lyric.Length == 0)
            {
                OnlineHttp.Warn($"{tag} returned no lrc code={ReadInt32(root, "code")} {stopwatch.ElapsedMilliseconds}ms");
                return NativeResult<NeteaseEapiLyric>.Unavailable();
            }

            var translation = root.TryGetProperty("tlyric", out var tlyric) && tlyric.ValueKind == JsonValueKind.Object
                ? ReadString(tlyric, "lyric")
                : string.Empty;
            var yrc = root.TryGetProperty("yrc", out var yrcElement) && yrcElement.ValueKind == JsonValueKind.Object
                ? ReadString(yrcElement, "lyric")
                : string.Empty;

            lyric = NormalizeLrc(lyric);
            OnlineHttp.Info(
                $"{tag} chars={lyric.Length} transChars={translation.Length} yrcChars={yrc.Length} " +
                $"ok {stopwatch.ElapsedMilliseconds}ms");
            return NativeResult<NeteaseEapiLyric>.Ok(new NeteaseEapiLyric(
                lyric,
                string.IsNullOrWhiteSpace(translation) ? null : translation,
                string.IsNullOrWhiteSpace(yrc) ? null : yrc));
        }
    }

    // eapi lyric/v1 对部分歌曲会把「作词/作曲」等署名行以 rich-lyric JSON 混在 LRC 前面
    // （如 {"t":-1000,"c":[{"tx":"作词: "},{"tx":"Chieh-lun Chou"}]}），这里转成标准 LRC 行；
    // 其余行保持原样，纯 LRC 的歌曲不受影响。
    private static string NormalizeLrc(string lyric)
    {
        var lines = lyric.Replace("\r", string.Empty).Split('\n');
        List<string>? normalized = null;
        for (var index = 0; index < lines.Length; index++)
        {
            var trimmed = lines[index].Trim();
            if (trimmed.Length == 0 || trimmed[0] != '{' || !TryConvertRichLyricLine(trimmed, out var converted))
            {
                continue;
            }

            normalized ??= new List<string>(lines);
            normalized[index] = converted;
        }

        return normalized is null ? lyric : string.Join('\n', normalized);
    }

    private static bool TryConvertRichLyricLine(string line, out string converted)
    {
        converted = string.Empty;
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("c", out var contents) ||
                contents.ValueKind != JsonValueKind.Array)
            {
                return false;
            }

            var text = new StringBuilder();
            foreach (var content in contents.EnumerateArray())
            {
                if (content.ValueKind == JsonValueKind.Object)
                {
                    text.Append(ReadString(content, "tx"));
                }
            }

            if (text.Length == 0)
            {
                return false;
            }

            var timestamp = root.TryGetProperty("t", out var time) && time.TryGetInt64(out var milliseconds) && milliseconds > 0
                ? milliseconds
                : 0;
            var minutes = timestamp / 60000;
            var seconds = timestamp % 60000 / 1000;
            var millis = timestamp % 1000;
            converted = $"[{minutes:00}:{seconds:00}.{millis:000}]{text}";
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>
    /// 通用 eapi JSON 查询（搜索/歌单/榜单等）。调用方负责解析返回的 JSON 文本；
    /// 4xx 视为 Unavailable（上游正常拒绝），网络/超时/解析失败才算 Failed。
    /// </summary>
    internal async Task<NativeResult<string>> PostJsonAsync(
        string uri,
        JsonObject payload,
        string? cookieOverride,
        string tag,
        CancellationToken cancellationToken = default)
    {
        var (body, cookieHeader) = BuildPayload(payload, cookieOverride);
        return await PostTextAsync(uri, body, cookieHeader, tag, cancellationToken).ConfigureAwait(false);
    }

    private (JsonObject Payload, string CookieHeader) BuildPayload(JsonObject data, string? cookieOverride = null)
    {
        var rawCookie = cookieOverride ?? _accounts?.CookieHeader(AccountSource, CookieHost) ?? string.Empty;
        var cookies = SetCookieParser.FromCookieHeader(rawCookie);

        // 设备身份与 Cookie 头必须同源（report §2.5），登录后沿用登录时写入的 os/appver/deviceId。
        var header = new JsonObject
        {
            ["osver"] = ReadCookie(cookies, "osver", "10.0.0"),
            ["deviceId"] = ReadCookie(cookies, "deviceId", _deviceId),
            ["os"] = ReadCookie(cookies, "os", "pc"),
            ["appver"] = ReadCookie(cookies, "appver", "3.1.41.205564"),
            ["versioncode"] = ReadCookie(cookies, "versioncode", "140"),
            ["mobilename"] = ReadCookie(cookies, "mobilename", string.Empty),
            ["buildver"] = ReadCookie(cookies, "buildver", DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture)),
            ["resolution"] = ReadCookie(cookies, "resolution", "1920x1080"),
            ["__csrf"] = ReadCookie(cookies, "__csrf", string.Empty),
            ["channel"] = ReadCookie(cookies, "channel", "netease"),
            ["requestId"] = $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Random.Shared.Next(10000)}",
        };

        foreach (var name in MusicCookieNames)
        {
            if (cookies.TryGetValue(name, out var value) && value.Length > 0)
            {
                header[name] = value;
            }
        }

        data["e_r"] = false;
        data["header"] = header;

        // 未登录时也拼一份最小 cookie，保持与 payload.header 同一套设备身份（eapi 不强制 cookie）。
        var cookieHeader = rawCookie.Length > 0 ? rawCookie : BuildAnonymousCookie(header);
        return (data, cookieHeader);
    }

    private async Task<JsonDocument?> PostAsync(
        string uri,
        JsonObject payload,
        string cookieHeader,
        string tag,
        CancellationToken cancellationToken)
    {
        var result = await PostTextAsync(uri, payload, cookieHeader, tag, cancellationToken).ConfigureAwait(false);
        return result.Outcome == NativeCallOutcome.Ok && result.Value is not null
            ? JsonDocument.Parse(result.Value)
            : null;
    }

    private async Task<NativeResult<string>> PostTextAsync(
        string uri,
        JsonObject payload,
        string cookieHeader,
        string tag,
        CancellationToken cancellationToken)
    {
        try
        {
            var json = payload.ToJsonString(JsonOptions);
            var parameters = NeteaseApiCrypto.EapiEncrypt(uri, json);

            using var request = new HttpRequestMessage(HttpMethod.Post, EndpointBase + "/eapi" + uri[4..]);
            request.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
            request.Headers.TryAddWithoutValidation("Referer", RefererUrl);
            request.Headers.TryAddWithoutValidation("Accept", "*/*");
            request.Headers.TryAddWithoutValidation("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
            request.Headers.TryAddWithoutValidation("Cookie", cookieHeader);
            request.Content = new StringContent("params=" + parameters, Encoding.UTF8, "application/x-www-form-urlencoded");

            using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutSource.CancelAfter(Timeout);
            using var response = await OnlineHttp.Client
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutSource.Token)
                .ConfigureAwait(false);
            var status = (int)response.StatusCode;
            if (!response.IsSuccessStatusCode)
            {
                throw new OnlineUpstreamException($"upstream HTTP {status}", status);
            }

            var bytes = await ReadBodyAsync(response, timeoutSource.Token).ConfigureAwait(false);
            var jsonText = DecodeJson(bytes);
            if (jsonText is null)
            {
                throw new InvalidDataException("响应不是可解析的 JSON");
            }

            return NativeResult<string>.Ok(jsonText);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"{tag} failed: {OnlineHttp.Describe(exception)}");
            var unavailable = exception is OnlineUpstreamException { StatusCode: >= 400 and < 500 };
            return unavailable
                ? NativeResult<string>.Unavailable()
                : NativeResult<string>.Failed();
        }
    }

    private static async Task<byte[]> ReadBodyAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.Content.Headers.ContentLength is > MaxResponseBytes)
        {
            throw new OnlineUpstreamException("上游响应过大", 502);
        }

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var memory = new MemoryStream();
        var buffer = new byte[16 * 1024];
        int read;
        while ((read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken).ConfigureAwait(false)) > 0)
        {
            if (memory.Length + read > MaxResponseBytes)
            {
                throw new OnlineUpstreamException("上游响应过大", 502);
            }

            memory.Write(buffer, 0, read);
        }

        return memory.ToArray();
    }

    // e_r=false 的默认响应是明文 JSON；防御性兼容 e_r=true 的 hex(AES-ECB) 与 x-aeapi 的 base64(gzip)。
    private static string? DecodeJson(byte[] bytes)
    {
        var text = Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF').Trim();
        if (IsJson(text))
        {
            return text;
        }

        byte[] payload;
        if (IsHex(text))
        {
            payload = Convert.FromHexString(text);
        }
        else if (TryDecodeBase64(text, out var base64Bytes))
        {
            payload = base64Bytes;
        }
        else
        {
            return null;
        }

        payload = IsGzip(payload)
            ? Gunzip(payload)
            : NeteaseApiCrypto.AesEcbDecrypt(payload, NeteaseApiCrypto.EapiKey);
        if (IsGzip(payload))
        {
            payload = Gunzip(payload);
        }

        var decoded = Encoding.UTF8.GetString(payload).TrimStart('\uFEFF').Trim();
        return IsJson(decoded) ? decoded : null;
    }

    private static string BuildAnonymousCookie(JsonObject header)
    {
        var builder = new StringBuilder();
        foreach (var pair in header)
        {
            if (pair.Key == "requestId")
            {
                continue;
            }

            if (builder.Length > 0)
            {
                builder.Append("; ");
            }

            builder.Append(Uri.EscapeDataString(pair.Key))
                .Append('=')
                .Append(Uri.EscapeDataString(pair.Value?.GetValue<string>() ?? string.Empty));
        }

        return builder.ToString();
    }

    private static bool TryGetDataItem(JsonElement root, out JsonElement item)
    {
        item = default;
        if (!root.TryGetProperty("data", out var data) ||
            data.ValueKind != JsonValueKind.Array ||
            data.GetArrayLength() == 0)
        {
            return false;
        }

        item = data[0];
        return item.ValueKind == JsonValueKind.Object;
    }

    private static bool IsJson(string text) => text.Length > 0 && (text[0] == '{' || text[0] == '[');

    private static bool IsHex(string text)
    {
        if (text.Length == 0 || (text.Length & 1) != 0)
        {
            return false;
        }

        foreach (var character in text)
        {
            if (!char.IsAsciiHexDigit(character))
            {
                return false;
            }
        }

        return true;
    }

    private static bool TryDecodeBase64(string text, out byte[] bytes)
    {
        bytes = [];
        var buffer = new byte[text.Length];
        if (!Convert.TryFromBase64String(text, buffer, out var written) || written == 0)
        {
            return false;
        }

        bytes = buffer[..written];
        return true;
    }

    private static bool IsGzip(byte[] bytes) => bytes.Length >= 2 && bytes[0] == 0x1F && bytes[1] == 0x8B;

    private static byte[] Gunzip(byte[] bytes)
    {
        using var input = new MemoryStream(bytes);
        using var gzip = new GZipStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        gzip.CopyTo(output);
        return output.ToArray();
    }

    private static string ReadCookie(Dictionary<string, string> cookies, string name, string fallback) =>
        cookies.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value) ? value : fallback;

    private static string ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static int ReadInt32(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)
            ? number
            : 0;
}
