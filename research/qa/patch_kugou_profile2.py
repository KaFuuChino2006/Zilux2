import io

PATH = r"E:\Zilux2开发\src\Zilux2\Online\Account\KugouLoginProvider.cs"
text = io.open(PATH, "r", encoding="utf-8", newline="").read()
eol = "\r\n" if "\r\n" in text else "\n"


def apply(label, old, new):
    global text
    old = old.replace("\n", eol)
    new = new.replace("\n", eol)
    if new in text:
        print(label, "already")
        return
    count = text.count(old)
    assert count == 1, f"{label}: count={count}"
    text = text.replace(old, new)
    print(label, "ok")


# 1) using System.Numerics
apply(
    "imports",
    """using System.Globalization;
using System.Net.Http;""",
    """using System.Globalization;
using System.Net.Http;
using System.Numerics;""",
)

# 2) constants
apply(
    "consts",
    """    private const int QrExpiresSeconds = 300;""",
    """    private const string ProfileHost = "http://relation.user.kugou.com";
    private const int ProfileAppId = 1005;
    private const string ProfileClientVer = "20489";
    private const string SignSalt = "OIlwieks28dk2k092lksi2UIkp";
    private const int QrExpiresSeconds = 300;""",
)

# 3) rsa pem constant (insert before Session record)
PEM = (
    "-----BEGIN PUBLIC KEY-----\\n"
    "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB\\n"
    "-----END PUBLIC KEY-----"
)
apply(
    "pem",
    """    private sealed record Session(string QrKey, string Mid, string Dfid, DateTimeOffset CreatedAt);""",
    """    private const string ProfileRsaPem = "-----BEGIN PUBLIC KEY-----\\n" +
        "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB\\n" +
        "-----END PUBLIC KEY-----";

    private sealed record Session(string QrKey, string Mid, string Dfid, DateTimeOffset CreatedAt);""",
)

# 4) replace TryFetchProfileAsync body (whole method) using markers
start_marker = "    // 昵称/头像只是锦上添花：酷狗用户信息接口必须带登录 Cookie，否则会被 WAF 挡回 HTML。"
end_marker = "    private static async Task<string?> FetchAvatarAsync("
start = text.find(start_marker)
end = text.find(end_marker)
assert start != -1 and end != -1 and end > start, f"markers {start} {end}"

NEW = '''    // 昵称/头像只是锦上添花：酷狗资料接口是 relation.user.kugou.com 的
    // POST /v1/get_my_userinfo，参数里 p 需要把 {clienttime, token} 用内置 RSA 公钥
    // 做「无填充模幂」加密，key 为 md5(appid + salt + clientver + clienttime)。
    private static async Task<(string? Nickname, string? Avatar)> TryFetchProfileAsync(
        string token,
        string userId,
        string mid,
        string dfid,
        IReadOnlyList<StoredCookie> cookies,
        CancellationToken cancellationToken)
    {
        if (token.Length == 0 || userId.Length == 0)
        {
            return (null, null);
        }

        var cookieHeader = CookieHeader(cookies);
        var clientTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        try
        {
            var payload = RsaEncryptHex(
                JsonSerializer.Serialize(new { clienttime = clientTime, token }),
                ProfileRsaPem).ToUpperInvariant();
            var fields = new Dictionary<string, object?>
            {
                ["p"] = payload,
                ["appid"] = ProfileAppId,
                ["mid"] = mid,
                ["clientver"] = ProfileClientVer,
                ["source"] = 0,
                ["clienttime"] = clientTime,
                ["uuid"] = "-",
                ["userid"] = long.TryParse(userId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var uid) ? uid : 0L,
                ["key"] = Md5Hex(ProfileAppId.ToString(CultureInfo.InvariantCulture) + SignSalt + ProfileClientVer + clientTime.ToString(CultureInfo.InvariantCulture)),
            };

            var upstream = await OnlineHttp
                .FetchTextAsync(
                    ProfileHost + "/v1/get_my_userinfo",
                    Referer,
                    TimeSpan.FromSeconds(12),
                    cancellationToken,
                    HttpMethod.Post,
                    JsonSerializer.Serialize(fields),
                    cookieHeader.Length > 0 ? cookieHeader : null)
                .ConfigureAwait(false);

            using var document = JsonDocument.Parse(upstream.Body);
            var root = document.RootElement;
            var data = TryGetProperty(root, "data", out var dataElement) ? dataElement : root;
            var nickname = FirstString(data, "nickname", "nick_name", "user_nickname", "kugou_nickname", "nick");
            var avatarUrl = FirstString(data, "pic", "user_pic", "avatar", "img", "big_pic", "pic_url");
            var avatar = await FetchAvatarAsync(avatarUrl, cancellationToken).ConfigureAwait(false);
            OnlineHttp.Info($"[account] kugou profile status={upstream.Status} bytes={upstream.Body.Length} nickname={nickname ?? "-"} avatar={(avatar is null ? "no" : "yes")}");
            if (nickname is null && avatar is null)
            {
                OnlineHttp.Warn($"[account] kugou profile body={Truncate(upstream.Body)}");
            }

            return (nickname, avatar);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            OnlineHttp.Warn($"[account] kugou profile failed: {OnlineHttp.Describe(exception)}");
        }

        return (null, null);
    }

    // 酷狗用的是「无填充 RSA」：明文右补 0 到 128 字节后直接做模幂，输出 hex。
    private static string RsaEncryptHex(string text, string pem)
    {
        using var rsa = RSA.Create();
        rsa.ImportFromPem(pem);
        var parameters = rsa.ExportParameters(false);
        var modulus = new BigInteger(parameters.Modulus!, isUnsigned: true, isBigEndian: true);
        var exponent = new BigInteger(parameters.Exponent!, isUnsigned: true, isBigEndian: true);
        var keyLength = (rsa.KeySize + 7) / 8;
        var raw = Encoding.UTF8.GetBytes(text);
        if (raw.Length > keyLength)
        {
            throw new InvalidOperationException("kugou profile payload too long");
        }

        var padded = new byte[keyLength];
        raw.CopyTo(padded, 0);
        var message = new BigInteger(padded, isUnsigned: true, isBigEndian: true);
        var encrypted = BigInteger.ModPow(message, exponent, modulus);
        return encrypted.ToString("x").PadLeft(keyLength * 2, '0');
    }

    private static string Md5Hex(string text) =>
        Convert.ToHexString(MD5.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

'''
text = text[:start] + NEW.replace("\n", eol) + text[end:]
print("profile method ok")

io.open(PATH, "w", encoding="utf-8", newline="").write(text)
print("written", len(text))
