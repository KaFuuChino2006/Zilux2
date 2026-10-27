using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Zilux2.Online.Account;

// 登录状态检测（第四十六轮）：用已保存的 cookie 直接问平台「这个登录还有效吗」。
//
// 和 AccountImporter（粘贴 cookie 校验）用同一组端点与判定标准，区别只在返回语义：
//   valid   —— 平台明确返回账号信息；
//   expired —— 平台明确拒绝（cookie 过期 / 登录态失效），宿主会顺手清掉本地账号；
//   unknown —— 网络、超时、上游异常等无法判断，保留账号，下一轮再试，绝不误判。
internal sealed record AccountSessionCheck(string Status, string? Reason)
{
    public static AccountSessionCheck Valid() => new(AccountVerifyStatus.Valid, null);

    public static AccountSessionCheck Expired(string? reason) => new(AccountVerifyStatus.Expired, reason);

    public static AccountSessionCheck Unknown(string? reason) => new(AccountVerifyStatus.Unknown, reason);
}

internal static class AccountVerifier
{
    private const string NeteaseProfileEndpoint = "https://music.163.com/api/nuser/account/get";
    private const string NeteaseReferer = "https://music.163.com/";
    private const string QqMusicuEndpoint = "https://u.y.qq.com/cgi-bin/musicu.fcg";
    private const string QqReferer = "https://y.qq.com/";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    public static Task<AccountSessionCheck> CheckAsync(
        string source,
        IReadOnlyList<StoredCookie> cookies,
        CancellationToken cancellationToken) =>
        string.Equals(source, AccountSources.Qq, StringComparison.OrdinalIgnoreCase)
            ? CheckQqAsync(cookies, cancellationToken)
            : CheckNeteaseAsync(cookies, cancellationToken);

    private static async Task<AccountSessionCheck> CheckNeteaseAsync(
        IReadOnlyList<StoredCookie> cookies,
        CancellationToken cancellationToken)
    {
        var header = CookieJar.BuildHeader(cookies, "music.163.com");
        if (string.IsNullOrEmpty(header))
        {
            return AccountSessionCheck.Expired("本地缺少网易云 cookie");
        }

        try
        {
            var upstream = await OnlineHttp
                .FetchTextAsync(NeteaseProfileEndpoint, NeteaseReferer, Timeout, cancellationToken, cookie: header)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(upstream.Body);
            var root = document.RootElement;

            var code = ReadInt(root, "code");
            if (code is not null && code != 200)
            {
                return AccountSessionCheck.Expired($"网易云返回 code={code}");
            }

            var hasProfile = root.TryGetProperty("profile", out var profile) && profile.ValueKind == JsonValueKind.Object;
            var hasAccount = root.TryGetProperty("account", out var account) && account.ValueKind == JsonValueKind.Object;
            if (!hasProfile && !hasAccount)
            {
                return AccountSessionCheck.Expired("网易云未返回账号信息（cookie 已过期）");
            }

            var userId = hasProfile ? ReadScalar(profile, "userId") : null;
            if (string.IsNullOrWhiteSpace(userId) && hasAccount)
            {
                userId = ReadScalar(account, "id");
            }

            return string.IsNullOrWhiteSpace(userId)
                ? AccountSessionCheck.Expired("网易云账号信息缺少 userId（cookie 已过期）")
                : AccountSessionCheck.Valid();
        }
        catch (OnlineUpstreamException exception)
        {
            return AccountSessionCheck.Unknown($"网易云检测请求失败：{exception.Message}");
        }
        catch (JsonException)
        {
            return AccountSessionCheck.Unknown("网易云检测返回内容无法解析");
        }
    }

    private static async Task<AccountSessionCheck> CheckQqAsync(
        IReadOnlyList<StoredCookie> cookies,
        CancellationToken cancellationToken)
    {
        var hasSessionKey = FindCookie(cookies, "qm_keyst") is not null ||
                            FindCookie(cookies, "qqmusic_key") is not null;
        if (!hasSessionKey)
        {
            return AccountSessionCheck.Expired("本地缺少 QQ 音乐登录 cookie（qm_keyst / qqmusic_key）");
        }

        var uin = ExtractUin(cookies);
        var header = CookieJar.BuildHeader(cookies, "y.qq.com");
        if (string.IsNullOrEmpty(header))
        {
            return AccountSessionCheck.Expired("本地缺少 QQ 音乐 cookie");
        }

        try
        {
            var userInfo = await PostMusicuAsync(
                "music.UserInfo.userInfoServer",
                "GetLoginUserInfo",
                new JsonObject(),
                uin,
                header,
                cancellationToken).ConfigureAwait(false);
            var userInfoCode = userInfo is { } info ? ReadInt(info, "code") : null;
            if (userInfo is { } envelope && userInfoCode == 0 && IsObject(envelope, "data"))
            {
                return AccountSessionCheck.Valid();
            }

            // SongFavRead 才是真正需要登录态的接口（未登录固定返回 code 1000），
            // 用它在 userInfo 解析不到时兜底，避免把「字段改名」误判成掉登录。
            var favorites = await PostMusicuAsync(
                "music.musicasset.SongFavRead",
                "GetSongFav",
                new JsonObject { ["uin"] = uin.Length > 0 ? uin : "0", ["offset"] = 0, ["limit"] = 10 },
                uin,
                header,
                cancellationToken).ConfigureAwait(false);
            var favoritesCode = favorites is { } favoritesEnvelope ? ReadInt(favoritesEnvelope, "code") : null;
            if (favorites is { } favoritesEnvelope2 && favoritesCode == 0 && IsObject(favoritesEnvelope2, "data"))
            {
                return AccountSessionCheck.Valid();
            }

            if (userInfoCode is 1000 or 80030 || favoritesCode is 1000 or 80030)
            {
                return AccountSessionCheck.Expired(
                    $"QQ 音乐返回 code={(favoritesCode ?? userInfoCode)?.ToString() ?? "unknown"}（登录态失效）");
            }

            return AccountSessionCheck.Unknown(
                $"QQ 音乐检测未通过（code={(favoritesCode ?? userInfoCode)?.ToString() ?? "unknown"}）");
        }
        catch (OnlineUpstreamException exception)
        {
            return AccountSessionCheck.Unknown($"QQ 音乐检测请求失败：{exception.Message}");
        }
        catch (JsonException)
        {
            return AccountSessionCheck.Unknown("QQ 音乐检测返回内容无法解析");
        }
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

        var upstream = await OnlineHttp
            .FetchTextAsync(QqMusicuEndpoint, QqReferer, Timeout, cancellationToken, HttpMethod.Post, body, cookieHeader)
            .ConfigureAwait(false);
        using var document = JsonDocument.Parse(upstream.Body);
        return document.RootElement.TryGetProperty("req_1", out var request) &&
               request.ValueKind == JsonValueKind.Object
            ? request.Clone()
            : null;
    }

    private static string? FindCookie(IReadOnlyList<StoredCookie> cookies, string name)
    {
        foreach (var cookie in cookies)
        {
            if (string.Equals(cookie.Name, name, StringComparison.OrdinalIgnoreCase) && cookie.Value.Length > 0)
            {
                return cookie.Value;
            }
        }

        return null;
    }

    private static string ExtractUin(IReadOnlyList<StoredCookie> cookies)
    {
        foreach (var name in new[] { "qqmusic_uin", "uin", "p_uin", "luin", "wxuin" })
        {
            var value = FindCookie(cookies, name);
            if (string.IsNullOrEmpty(value))
            {
                continue;
            }

            var digits = new string(value.TrimStart('o').Where(char.IsDigit).ToArray());
            if (digits.Length > 0)
            {
                return digits;
            }
        }

        return string.Empty;
    }

    private static bool IsObject(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Object;

    private static int? ReadInt(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.Number &&
        value.TryGetInt32(out var number)
            ? number
            : null;

    private static string? ReadScalar(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value))
        {
            return null;
        }

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.ToString(),
            _ => null,
        };
    }
}
