using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Zilux2.Online.Account;

// docs/zilux2-account-login.md fallback for platforms whose QR login is blocked by risk control:
// the user pastes the browser Cookie header, we revalidate it against the profile/info API and then
// persist it through AccountStore exactly like a QR login (same DPAPI protection, same cookie use).
internal sealed class AccountImporter
{
    private const int MaxCookieLength = 16 * 1024;
    private const int MaxAvatarBytes = 512 * 1024;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);

    private const string NeteaseProfileEndpoint = "https://music.163.com/api/nuser/account/get";
    private const string NeteaseReferer = "https://music.163.com/";
    private const string QqMusicuEndpoint = "https://u.y.qq.com/cgi-bin/musicu.fcg";
    private const string QqReferer = "https://y.qq.com/";

    // Pasted headers may include Set-Cookie style attributes; those are not cookie pairs.
    private static readonly string[] CookieAttributeNames =
    [
        "path", "domain", "expires", "max-age", "secure", "httponly", "samesite", "version", "priority",
    ];

    private readonly AccountStore _store;

    public AccountImporter(AccountStore store) => _store = store;

    public async Task<AccountInfo> ImportAsync(string source, string cookieHeader, CancellationToken cancellationToken)
    {
        var raw = (cookieHeader ?? string.Empty).Trim();
        if (raw.Length == 0)
        {
            throw new AccountException("invalid-cookie", "cookie 不能为空", 400);
        }

        if (raw.Length > MaxCookieLength)
        {
            throw new AccountException("invalid-cookie", $"cookie 过长（上限 {MaxCookieLength} 字符）", 400);
        }

        var isQq = string.Equals(source, AccountSources.Qq, StringComparison.OrdinalIgnoreCase);
        var normalized = isQq ? AccountSources.Qq : AccountSources.Netease;
        // Both platforms issue the useful cookies as domain cookies; matching every host they call
        // (c.y.qq.com/u.y.qq.com) keeps provider requests and validation on the same cookie set.
        var cookies = ParseCookies(raw, isQq ? "qq.com" : "music.163.com");
        if (cookies.Count == 0)
        {
            throw new AccountException("invalid-cookie", "cookie 格式不正确，请粘贴浏览器请求头里的 Cookie 值", 400);
        }

        var info = isQq
            ? await ImportQqAsync(cookies, raw, cancellationToken).ConfigureAwait(false)
            : await ImportNeteaseAsync(cookies, raw, cancellationToken).ConfigureAwait(false);
        _store.SaveLogin(normalized, info, cookies);
        OnlineHttp.Info($"[account] import source={normalized} ok nickname={info.Nickname ?? "-"} userId={info.UserId ?? "-"}");
        return info;
    }

    private static async Task<AccountInfo> ImportNeteaseAsync(
        IReadOnlyList<StoredCookie> cookies,
        string cookieHeader,
        CancellationToken cancellationToken)
    {
        UpstreamText upstream;
        try
        {
            upstream = await OnlineHttp
                .FetchTextAsync(NeteaseProfileEndpoint, NeteaseReferer, Timeout, cancellationToken, cookie: cookieHeader)
                .ConfigureAwait(false);
        }
        catch (OnlineUpstreamException exception)
        {
            throw new AccountException("invalid-cookie", $"网易云 cookie 校验失败：{exception.Message}", 400);
        }

        using var document = JsonDocument.Parse(upstream.Body);
        var root = document.RootElement;
        var code = ReadInt(root, "code");
        if (code is not null && code != 200)
        {
            throw new AccountException("invalid-cookie", $"网易云 cookie 无效或已过期（code={code}），请重新登录后复制最新 cookie", 400);
        }

        var profile = ReadObject(root, "profile");
        var account = ReadObject(root, "account");
        if (profile is null && account is null)
        {
            throw new AccountException("invalid-cookie", "网易云 cookie 无效或已过期，请重新登录后复制最新 cookie", 400);
        }

        var userId = profile is { } profileElement ? ReadScalar(profileElement, "userId") : null;
        userId ??= account is { } accountElement ? ReadScalar(accountElement, "id") : null;
        if (string.IsNullOrWhiteSpace(userId))
        {
            throw new AccountException("invalid-cookie", "网易云 cookie 中缺少用户信息（可能已过期）", 400);
        }

        var nickname = profile is { } namedProfile ? ReadScalar(namedProfile, "nickname") : null;
        nickname ??= account is { } namedAccount ? ReadScalar(namedAccount, "userName") : null;

        bool? vip = profile is { } vipProfile ? ReadBool(vipProfile, "isVip") : null;
        if (vip is null && profile is { } typeProfile)
        {
            var vipType = ReadInt(typeProfile, "vipType");
            if (vipType is not null)
            {
                vip = vipType > 0;
            }
        }

        var avatarUrl = profile is { } avatarProfile ? ReadScalar(avatarProfile, "avatarUrl") : null;
        var avatarDataUrl = await FetchAvatarAsync(avatarUrl, cancellationToken).ConfigureAwait(false);
        OnlineHttp.Info($"[account] import netease validated userId={userId} vip={vip?.ToString() ?? "unknown"}");

        return new AccountInfo
        {
            Source = AccountSources.Netease,
            LoggedIn = true,
            Nickname = nickname,
            AvatarDataUrl = avatarDataUrl,
            Vip = vip,
            UserId = userId,
        };
    }

    private static async Task<AccountInfo> ImportQqAsync(
        IReadOnlyList<StoredCookie> cookies,
        string cookieHeader,
        CancellationToken cancellationToken)
    {
        var cookieMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var cookie in cookies)
        {
            cookieMap[cookie.Name] = cookie.Value;
        }

        var uin = ExtractUin(cookieMap);
        var hasSessionKey = cookieMap.ContainsKey("qm_keyst") || cookieMap.ContainsKey("qqmusic_key");
        if (!hasSessionKey && !(cookieMap.ContainsKey("skey") && uin.Length > 0))
        {
            throw new AccountException(
                "invalid-cookie",
                "cookie 中缺少 qm_keyst / qqmusic_key（或 skey + uin），请在 y.qq.com 登录后复制完整 Cookie",
                400);
        }

        string? nickname = null;
        string? avatarUrl = null;
        string? foundUin = null;
        bool? vip = null;
        var userInfo = await PostMusicuAsync(
            "music.UserInfo.userInfoServer",
            "GetLoginUserInfo",
            new JsonObject(),
            uin,
            cookieHeader,
            cancellationToken).ConfigureAwait(false);
        var lastCode = userInfo is { } info ? ReadInt(info, "code") : null;
        var validated = false;

        if (userInfo is { } infoEnvelope && lastCode == 0 &&
            ReadObject(infoEnvelope, "data") is { } data)
        {
            nickname = FindScalar(data, ["nick", "nickname", "name"], 4);
            avatarUrl = FindScalar(data, ["avatarUrl", "avatar", "headUrl", "head_pic", "headpic"], 4);
            vip = FindBool(data, ["isVip", "isVipUser"], 4);
            if (vip is null)
            {
                var vipType = FindInt(data, ["vipType", "greenVip", "green_vip", "vipTypeId"], 4);
                if (vipType is not null)
                {
                    vip = vipType > 0;
                }
            }

            foundUin = NormalizeUin(FindScalar(data, ["uin", "musicid", "uinStr"], 4));
            validated = true;
        }

        if (!validated)
        {
            // PlaylistBaseRead is not auth-gated: it happily returns public playlists for any uin, so
            // it cannot prove a pasted cookie is a real session. SongFavRead is auth-gated (code 1000
            // without a valid login), which is exactly what we need to reject fake cookies.
            var favoritesUin = uin.Length > 0 ? uin : "0";
            var favorites = await PostMusicuAsync(
                "music.musicasset.SongFavRead",
                "GetSongFav",
                new JsonObject { ["uin"] = favoritesUin, ["offset"] = 0, ["limit"] = 10 },
                favoritesUin,
                cookieHeader,
                cancellationToken).ConfigureAwait(false);
            var favoritesCode = favorites is { } favoritesEnvelope ? ReadInt(favoritesEnvelope, "code") : null;
            if (favorites is { } favoritesValid && favoritesCode == 0 && ReadObject(favoritesValid, "data") is not null)
            {
                validated = true;
                foundUin = uin.Length > 0 ? uin : null;
            }
            else
            {
                lastCode = favoritesCode ?? lastCode;
            }
        }

        if (!validated)
        {
            if (lastCode is 1000)
            {
                throw new AccountException(
                    "invalid-cookie",
                    "QQ 音乐 cookie 已失效或未登录，请重新登录 y.qq.com 后复制最新 Cookie",
                    400);
            }

            if (uin.Length == 0)
            {
                throw new AccountException(
                    "invalid-cookie",
                    "cookie 中缺少 uin / qqmusic_uin，请复制完整 Cookie（含 uin 字段）",
                    400);
            }

            throw new AccountException("invalid-cookie", $"QQ 音乐 cookie 校验失败（code={lastCode?.ToString() ?? "unknown"}）", 400);
        }

        var userId = foundUin ?? uin;
        if (userId.Length == 0)
        {
            throw new AccountException("invalid-cookie", "无法解析 QQ 音乐 uin，请复制包含 uin/qqmusic_uin 的完整 Cookie", 400);
        }

        nickname ??= $"QQ音乐用户{userId}";
        avatarUrl ??= $"https://thirdqq.qlogo.cn/g?b=sdk&s=100&nk={userId}";
        var avatarDataUrl = await FetchAvatarAsync(avatarUrl, cancellationToken).ConfigureAwait(false);
        OnlineHttp.Info($"[account] import qq validated userId={userId} vip={vip?.ToString() ?? "unknown"}");

        return new AccountInfo
        {
            Source = AccountSources.Qq,
            LoggedIn = true,
            Nickname = nickname,
            AvatarDataUrl = avatarDataUrl,
            Vip = vip,
            UserId = userId,
        };
    }

    private static async Task<JsonElement?> PostMusicuAsync(
        string module,
        string method,
        JsonObject param,
        string uin,
        string cookieHeader,
        CancellationToken cancellationToken)
    {
        var body = new JsonObject
        {
            ["comm"] = new JsonObject
            {
                ["ct"] = 24,
                ["cv"] = 0,
                ["uin"] = uin.Length > 0 ? uin : "0",
            },
            ["req_1"] = new JsonObject
            {
                ["module"] = module,
                ["method"] = method,
                ["param"] = param,
            },
        }.ToJsonString();

        try
        {
            var upstream = await OnlineHttp
                .FetchTextAsync(QqMusicuEndpoint, QqReferer, Timeout, cancellationToken, HttpMethod.Post, body, cookieHeader)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(upstream.Body);
            if (!document.RootElement.TryGetProperty("req_1", out var request) || request.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            return request.Clone();
        }
        catch (OnlineUpstreamException exception)
        {
            throw new AccountException("invalid-cookie", $"QQ 音乐 cookie 校验失败：{exception.Message}", 400);
        }
    }

    private static async Task<string?> FetchAvatarAsync(string? avatarUrl, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(avatarUrl))
        {
            return null;
        }

        try
        {
            var upstream = await OnlineHttp
                .FetchBytesAsync(avatarUrl, null, Timeout, cancellationToken)
                .ConfigureAwait(false);
            if (upstream.Bytes.Length == 0 || upstream.Bytes.Length > MaxAvatarBytes)
            {
                OnlineHttp.Warn($"[account] import avatar skipped size={upstream.Bytes.Length}");
                return null;
            }

            var mediaType = upstream.ContentType?.Split(';')[0].Trim();
            if (string.IsNullOrEmpty(mediaType) || !mediaType.Contains('/'))
            {
                mediaType = "image/jpeg";
            }

            return $"data:{mediaType};base64,{Convert.ToBase64String(upstream.Bytes)}";
        }
        catch (Exception exception)
        {
            OnlineHttp.Warn($"[account] import avatar failed: {OnlineHttp.Describe(exception)}");
            return null;
        }
    }

    private static List<StoredCookie> ParseCookies(string raw, string domain)
    {
        var cookies = new List<StoredCookie>();
        foreach (var segment in raw.Split(';'))
        {
            var token = segment.Trim();
            if (token.Length == 0)
            {
                continue;
            }

            var separator = token.IndexOf('=');
            if (separator <= 0)
            {
                continue;
            }

            var name = token[..separator].Trim();
            var value = token[(separator + 1)..].Trim();
            if (name.Length == 0 || value.Length == 0 || name.StartsWith('$') || IsCookieAttribute(name))
            {
                continue;
            }

            cookies.RemoveAll(cookie => string.Equals(cookie.Name, name, StringComparison.OrdinalIgnoreCase));
            cookies.Add(new StoredCookie(domain, name, value));
        }

        return cookies;
    }

    private static bool IsCookieAttribute(string name) =>
        CookieAttributeNames.Any(attribute => string.Equals(attribute, name, StringComparison.OrdinalIgnoreCase));

    private static string ExtractUin(IReadOnlyDictionary<string, string> cookieMap)
    {
        foreach (var name in new[] { "qqmusic_uin", "uin", "p_uin", "luin", "wxuin" })
        {
            if (cookieMap.TryGetValue(name, out var value))
            {
                var digits = NormalizeUin(value);
                if (digits is not null)
                {
                    return digits;
                }
            }
        }

        return string.Empty;
    }

    // Cookie uins can be prefixed with "o" (openid style); only the numeric part is the real uin.
    private static string? NormalizeUin(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var digits = new string(value.Where(char.IsAsciiDigit).ToArray());
        return digits.Length > 0 ? digits : null;
    }

    private static JsonElement? ReadObject(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.Object
            ? value
            : null;

    private static int? ReadInt(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.Number &&
        value.TryGetInt32(out var number)
            ? number
            : null;

    private static bool? ReadBool(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value))
        {
            return null;
        }

        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null,
        };
    }

    private static string? ReadScalar(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value))
        {
            return null;
        }

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            _ => null,
        };
    }

    private static string? FindScalar(JsonElement element, string[] names, int depth)
    {
        if (depth <= 0)
        {
            return null;
        }

        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var name in names)
                {
                    var direct = ReadScalar(element, name);
                    if (!string.IsNullOrWhiteSpace(direct))
                    {
                        return direct;
                    }
                }

                foreach (var property in element.EnumerateObject())
                {
                    var nested = FindScalar(property.Value, names, depth - 1);
                    if (!string.IsNullOrWhiteSpace(nested))
                    {
                        return nested;
                    }
                }

                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                {
                    var nested = FindScalar(item, names, depth - 1);
                    if (!string.IsNullOrWhiteSpace(nested))
                    {
                        return nested;
                    }
                }

                break;
        }

        return null;
    }

    private static int? FindInt(JsonElement element, string[] names, int depth)
    {
        if (depth <= 0)
        {
            return null;
        }

        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var name in names)
                {
                    if (element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number))
                    {
                        return number;
                    }
                }

                foreach (var property in element.EnumerateObject())
                {
                    var nested = FindInt(property.Value, names, depth - 1);
                    if (nested is not null)
                    {
                        return nested;
                    }
                }

                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                {
                    var nested = FindInt(item, names, depth - 1);
                    if (nested is not null)
                    {
                        return nested;
                    }
                }

                break;
        }

        return null;
    }

    private static bool? FindBool(JsonElement element, string[] names, int depth)
    {
        if (depth <= 0)
        {
            return null;
        }

        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var name in names)
                {
                    if (element.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    {
                        return value.ValueKind == JsonValueKind.True;
                    }
                }

                foreach (var property in element.EnumerateObject())
                {
                    var nested = FindBool(property.Value, names, depth - 1);
                    if (nested is not null)
                    {
                        return nested;
                    }
                }

                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                {
                    var nested = FindBool(item, names, depth - 1);
                    if (nested is not null)
                    {
                        return nested;
                    }
                }

                break;
        }

        return null;
    }
}
