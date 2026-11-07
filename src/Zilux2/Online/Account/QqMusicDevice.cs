using System.Net.Http;
using System.Net;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Zilux2.Online.Account;

// QQ 音乐 App 扫码登录需要的 Android 设备引导（QIMEI）与 musicu 调用。
//
// 这套协议来自官方 Android 客户端的请求：先向腾讯的 QIMEI 代理登记一台合成设备，拿到 QIMEI/QIMEI36，
// 再以 Android comm 调用 u.y.qq.com 的 musicu 接口（CreateQRCode / Login）。没有 QIMEI，musicu 直接回
// 500001。所有字段都是合成设备标识，不包含用户凭证。

internal sealed class QqMusicDevice
{
    public string Display { get; init; } = "";
    public string Product { get; init; } = "iarim";
    public string Board { get; init; } = "eomam";
    public string DeviceName { get; init; } = "sagit";
    public string Model { get; init; } = "MI 6";
    public string Fingerprint { get; init; } = "";
    public string ProcVersion { get; init; } = "";
    public string Imei { get; init; } = "";
    public string Brand { get; init; } = "Xiaomi";
    public string AndroidId { get; init; } = "";
    public string OpenUdid { get; init; } = "";
    public string OsRelease { get; init; } = "10";
    public int Sdk { get; init; } = 29;
    public string Qimei { get; set; } = "";
    public string Qimei36 { get; set; } = "";

    public static QqMusicDevice Create()
    {
        return new QqMusicDevice
        {
            Display = $"QMAPI.{RandomDigits(6)}.001",
            Fingerprint = $"xiaomi/iarim/sagit:10/eomam.200122.001/{RandomDigits(7)}:user/release-keys",
            ProcVersion = $"Linux 5.4.0-54-generic-{RandomHex(8)} (android-build@google.com)",
            Imei = RandomImei(),
            AndroidId = RandomHex(16),
            OpenUdid = RandomHex(32),
        };
    }

    public static string RandomHex(int chars) =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes((chars + 1) / 2)).ToLowerInvariant()[..chars];

    public static string RandomDigits(int count)
    {
        var buffer = RandomNumberGenerator.GetBytes(count);
        var sb = new StringBuilder(count);
        foreach (var b in buffer)
        {
            sb.Append((char)('0' + b % 10));
        }

        return sb.ToString();
    }

    private static string RandomImei()
    {
        var digits = RandomDigits(14).Select(c => c - '0').ToArray();
        var sum = 0;
        for (var i = 0; i < digits.Length; i++)
        {
            var digit = digits[i];
            if (i % 2 == 1)
            {
                digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
            }

            sum += digit;
        }

        return string.Concat(digits) + ((10 - sum % 10) % 10);
    }

    public string BeaconId(DateTimeOffset now)
    {
        var month = now.ToString("yyyy-MM") + "-01";
        var first = RandomDigits(6);
        var second = RandomDigits(9);
        var dated = new HashSet<int> { 1, 2, 13, 14, 17, 18, 21, 22, 25, 26, 29, 30, 33, 34, 37, 38 };
        var fields = new List<string>(40);
        for (var key = 1; key <= 40; key++)
        {
            if (dated.Contains(key)) fields.Add($"k{key}:{month}{first}.{second}");
            else if (key == 3) fields.Add("k3:0000000000000000");
            else if (key == 4) fields.Add($"k4:{RandomHex(16).Replace('0', '1')}");
            else fields.Add($"k{key}:{Random.Shared.Next(0, 10000)}");
        }

        return string.Join(';', fields) + ";";
    }
}

internal sealed class QqMusicQimeiException(string message) : Exception(message);

internal static class QimeiBootstrap
{
    private const string Url = "https://api.tencentmusic.com/tme/trpc/proxy";
    private const string Service = "trpc.tme_datasvr.qimeiproxy.QimeiProxy";
    private const string AppId = "qimei_qq_android";
    private const string AppKey = "0AND0HD6FE4HY80F";
    private const string Secret = "ZdJqM15EeO2zWc08";
    private const string SignSecret = "pzAuCmaFAaFaHrdakPjLIEqKrGnSOOvH";

    public static async Task<(string Q16, string Q36)> FetchAsync(
        HttpClient http,
        QqMusicDevice device,
        CancellationToken cancellationToken)
    {
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var keyChars = QqMusicDevice.RandomHex(16);
        var nonce = QqMusicDevice.RandomHex(16);
        var keyBytes = Encoding.ASCII.GetBytes(keyChars);
        var encryptedKey = RsaPkcs1.Encrypt(keyBytes);
        var payload = BuildPayload(device, DateTimeOffset.UtcNow);
        var encryptedPayload = AesCbc.Encrypt(keyBytes, keyBytes, Encoding.UTF8.GetBytes(payload));
        var key = Convert.ToBase64String(encryptedKey);
        var parameters = Convert.ToBase64String(encryptedPayload);
        var extra = "{\"appKey\":\"" + AppKey + "\"}";
        var sign = Md5Hex("qimei_qq_android" + SignSecret + timestamp);
        var sign2 = Md5Hex(key + parameters + timestamp * 1000 + nonce + Secret + extra);

        var body = new JsonObject
        {
            ["app"] = 0,
            ["os"] = 1,
            ["qimeiParams"] = new JsonObject
            {
                ["key"] = key,
                ["params"] = parameters,
                ["time"] = timestamp.ToString(),
                ["nonce"] = nonce,
                ["sign"] = sign2,
                ["extra"] = extra,
            },
        };

        using var request = new HttpRequestMessage(HttpMethod.Post, Url)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        request.Headers.Host = "api.tencentmusic.com";
        request.Headers.TryAddWithoutValidation("method", "GetQimei");
        request.Headers.TryAddWithoutValidation("service", Service);
        request.Headers.TryAddWithoutValidation("appid", AppId);
        request.Headers.TryAddWithoutValidation("sign", sign);
        request.Headers.TryAddWithoutValidation("user-agent", "QQMusic");
        request.Headers.TryAddWithoutValidation("timestamp", timestamp.ToString());

        using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new QqMusicQimeiException($"QIMEI HTTP {(int)response.StatusCode}");
        }

        try
        {
            var outer = JsonNode.Parse(text) as JsonObject;
            var innerText = outer?["data"]?.GetValue<string>() ?? "";
            var inner = string.IsNullOrWhiteSpace(innerText) ? null : JsonNode.Parse(innerText) as JsonObject;
            var data = inner?["data"] as JsonObject;
            var q16 = data?["q16"]?.GetValue<string>() ?? "";
            var q36 = data?["q36"]?.GetValue<string>() ?? "";
            if (q16.Length > 0 && q36.Length > 0)
            {
                return (q16, q36);
            }

            throw new QqMusicQimeiException(
                $"QIMEI 被拒绝（outer={outer?["code"]?.ToJsonString() ?? "?"}, inner={inner?["code"]?.ToJsonString() ?? "?"}）");
        }
        catch (JsonException exception)
        {
            throw new QqMusicQimeiException("QIMEI 响应不是合法 JSON：" + exception.Message);
        }
    }

    private static string BuildPayload(QqMusicDevice device, DateTimeOffset now)
    {
        var reserved = new JsonObject
        {
            ["harmony"] = "0",
            ["clone"] = "0",
            ["containe"] = "",
            ["oz"] = "UhYmelwouA+V2nPWbOvLTgN2/m8jwGB+yUB5v9tysQg=",
            ["oo"] = "Xecjt+9S1+f8Pz2VLSxgpw==",
            ["kelong"] = "0",
            ["uptimes"] = now.AddSeconds(-Random.Shared.Next(0, 14401)).ToString("yyyy-MM-dd HH:mm:ss"),
            ["multiUser"] = "0",
            ["bod"] = device.Brand,
            ["dv"] = device.DeviceName,
            ["firstLevel"] = "",
            ["manufact"] = device.Brand,
            ["name"] = device.Model,
            ["host"] = "se.infra",
            ["kernel"] = device.ProcVersion,
        };

        var payload = new JsonObject
        {
            ["androidId"] = device.AndroidId,
            ["platformId"] = 1,
            ["appKey"] = AppKey,
            ["appVersion"] = "14.9.0.8",
            ["beaconIdSrc"] = device.BeaconId(now),
            ["brand"] = device.Brand,
            ["channelId"] = "10003505",
            ["cid"] = "",
            ["imei"] = device.Imei,
            ["imsi"] = "",
            ["mac"] = "",
            ["model"] = device.Model,
            ["networkType"] = "unknown",
            ["oaid"] = "",
            ["osVersion"] = $"Android {device.OsRelease},level {device.Sdk}",
            ["qimei"] = "",
            ["qimei36"] = "",
            ["sdkVersion"] = "1.2.13.6",
            ["targetSdkVersion"] = "33",
            ["audit"] = "",
            ["userId"] = "{}",
            ["packageId"] = "com.tencent.qqmusic",
            ["deviceType"] = "Phone",
            ["sdkName"] = "",
            ["reserved"] = reserved.ToJsonString(),
        };
        return payload.ToJsonString(new JsonSerializerOptions
        {
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });
    }

    private static string Md5Hex(string value) =>
        Convert.ToHexString(MD5.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}

internal static class AesCbc
{
    public static byte[] Encrypt(byte[] key, byte[] iv, byte[] plaintext)
    {
        using var aes = Aes.Create();
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;
        aes.Key = key;
        aes.IV = iv;
        using var encryptor = aes.CreateEncryptor();
        return encryptor.TransformFinalBlock(plaintext, 0, plaintext.Length);
    }
}

internal static class RsaPkcs1
{
    // 腾讯 QIMEI 引导用的固定公钥（RSA-1024），与请求无关、每次启动都一样。
    private const string ModulusHex =
        "c4231830a2eb5fc2827170641e79d80fec51bda9a22e4b4ab37d1f205a4ae44d928cda25879f66a3429051663312a12" +
        "7faf8a246bdaaf63918417e90d7c95b5908aa6a2d0f852e4a6770294a548ac1c2fe8f1f252fb826f4ac86ab9a00e7ce4" +
        "7d002a56e7c4b51eb889acc60ca6adbc9f72e81f4d31b1dd7464805264530ab1d";

    private static readonly BigInteger Exponent = 65537;

    public static byte[] Encrypt(byte[] message)
    {
        var modulus = new BigInteger(Convert.FromHexString(ModulusHex), isUnsigned: true, isBigEndian: true);
        var k = ModulusHex.Length / 2;
        if (message.Length > k - 11)
        {
            throw new InvalidOperationException("RSA payload too long");
        }

        var paddingLength = k - message.Length - 3;
        var padding = new byte[paddingLength];
        var filled = 0;
        while (filled < paddingLength)
        {
            var batch = RandomNumberGenerator.GetBytes(paddingLength - filled);
            foreach (var b in batch)
            {
                if (b == 0) continue;
                padding[filled++] = b;
                if (filled >= paddingLength) break;
            }
        }

        var block = new byte[k];
        block[1] = 0x02;
        padding.CopyTo(block, 2);
        block[2 + paddingLength] = 0x00;
        message.CopyTo(block, 3 + paddingLength);

        var value = new BigInteger(block, isUnsigned: true, isBigEndian: true);
        var encoded = BigInteger.ModPow(value, Exponent, modulus);
        var bytes = encoded.ToByteArray(isUnsigned: true, isBigEndian: true);
        if (bytes.Length == k) return bytes;
        var result = new byte[k];
        bytes.CopyTo(result, k - bytes.Length);
        return result;
    }
}

internal sealed class QqMusicApiException(string message) : Exception(message);

internal static class QqMusicApi
{
    public const string Endpoint = "https://u.y.qq.com/cgi-bin/musicu.fcg";
    private const string ChannelId = "10003505";

    public static async Task<JsonNode?> CallAsync(
        HttpClient http,
        QqMusicDevice device,
        string module,
        string method,
        JsonNode param,
        JsonNode? overrides,
        CancellationToken cancellationToken)
    {
        var comm = new JsonObject
        {
            ["ct"] = 11,
            ["cv"] = 14090008,
            ["v"] = 14090008,
            ["chid"] = ChannelId,
            ["tmeAppID"] = "qqmusic",
            ["QIMEI"] = device.Qimei,
            ["QIMEI36"] = device.Qimei36,
            ["OpenUDID"] = device.OpenUdid,
            ["udid"] = device.OpenUdid,
            ["OpenUDID2"] = device.OpenUdid,
            ["aid"] = device.AndroidId,
            ["os_ver"] = device.OsRelease,
            ["phonetype"] = device.Model,
            ["devicelevel"] = device.Sdk.ToString(),
            ["newdevicelevel"] = device.Sdk.ToString(),
            ["rom"] = device.Fingerprint,
        };
        if (overrides is JsonObject extra)
        {
            foreach (var pair in extra)
            {
                comm[pair.Key] = pair.Value?.DeepClone();
            }
        }

        var body = new JsonObject
        {
            ["comm"] = comm,
            ["req_0"] = new JsonObject
            {
                ["module"] = module,
                ["method"] = method,
                ["param"] = param.DeepClone(),
            },
        };

        using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint)
        {
            Content = new StringContent(body.ToJsonString(new JsonSerializerOptions
            {
                Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            }), Encoding.UTF8, "application/json"),
        };
        request.Headers.TryAddWithoutValidation("User-Agent", $"QQMusic 14090008(android {device.OsRelease})");

        using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new QqMusicApiException($"musicu HTTP {(int)response.StatusCode}");
        }

        var outer = JsonNode.Parse(text) as JsonObject;
        var item = outer?["req_0"] as JsonObject;
        var globalCode = outer?["code"]?.GetValue<int>() ?? 0;
        var upstreamCode = item?["code"] is JsonNode codeNode ? codeNode.GetValue<int>() : 0;
        if (item is null || globalCode != 0 || upstreamCode != 0)
        {
            throw new QqMusicApiException(
                $"musicu {module}.{method} 失败（global={globalCode}, code={upstreamCode}）");
        }

        return item["data"];
    }

    public static async Task<JsonNode?> CreateQrAsync(
        HttpClient http,
        QqMusicDevice device,
        CancellationToken cancellationToken) =>
        await CallAsync(http, device, "music.login.LoginServer", "CreateQRCode",
            new JsonObject { ["tmeAppID"] = "qqmusic", ["ct"] = 11, ["cv"] = 14090008 },
            new JsonObject { ["ct"] = 23, ["cv"] = 0 },
            cancellationToken).ConfigureAwait(false);

    public static async Task<JsonNode?> ExchangeCredentialAsync(
        HttpClient http,
        QqMusicDevice device,
        string qrcodeId,
        string musicId,
        string token,
        CancellationToken cancellationToken)
    {
        // 微信账号的 id 是 19 位，超过 JS 安全整数；官方客户端原样送数字字面量。
        JsonNode musicIdNode = BigInteger.TryParse(musicId, out var big) && big <= long.MaxValue
            ? JsonValue.Create(long.Parse(musicId))
            : JsonValue.Create(musicId);

        return await CallAsync(http, device, "music.login.LoginServer", "Login",
            new JsonObject
            {
                ["musicid"] = musicIdNode,
                ["qrCodeID"] = qrcodeId,
                ["token"] = token,
            },
            new JsonObject { ["tmeLoginType"] = 6 },
            cancellationToken).ConfigureAwait(false);
    }

    public static async Task<JsonNode?> ExchangeWechatCredentialAsync(
        HttpClient http,
        QqMusicDevice device,
        string code,
        CancellationToken cancellationToken) =>
        await CallAsync(http, device, "music.login.LoginServer", "Login",
            new JsonObject { ["code"] = code, ["strAppid"] = "wx48db31d50e334801" },
            new JsonObject { ["tmeLoginType"] = 1 },
            cancellationToken).ConfigureAwait(false);

    public static HttpClient CreateHttpClient()
    {
        var proxyValue = Environment.GetEnvironmentVariable("ZILUX2_ONLINE_PROXY");
        var handler = new SocketsHttpHandler
        {
            AutomaticDecompression = DecompressionMethods.All,
            ConnectTimeout = TimeSpan.FromSeconds(12),
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        };
        if (!string.IsNullOrWhiteSpace(proxyValue) && Uri.TryCreate(proxyValue, UriKind.Absolute, out var proxyUri))
        {
            handler.Proxy = new WebProxy(proxyUri);
            handler.UseProxy = true;
        }

        return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(20) };
    }
}



