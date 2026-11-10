using System.Security.Cryptography;
using System.Text.Json;

namespace Zilux2.Online.Kugou;

// 酷狗开放平台换票：把 QQ 快捷登录拿到的 openid/access_token 换成标准版 App token。
// 网页快捷登录拿到的 token 是 Web 作用域，v7/get_all_list 会返回 20017；换票后云歌单/收藏才可用。
internal sealed record KugouOpenLoginResult(string Token, string UserId);

internal static class KugouOpenLogin
{
    public static async Task<KugouOpenLoginResult?> ExchangeAsync(
        string mid,
        string dfid,
        string openId,
        string accessToken,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(openId) || string.IsNullOrWhiteSpace(accessToken))
        {
            return null;
        }

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var (encryptedParams, seed) = KugouCrypto.AesEncryptHex(
            JsonSerializer.Serialize(new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["access_token"] = accessToken,
            }));
        var pk = KugouCrypto.RsaRawHex(
            JsonSerializer.Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
            {
                ["clienttime_ms"] = now,
                ["key"] = seed,
            })).ToUpperInvariant();

        var data = JsonSerializer.Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["dev"] = KugouCrypto.RandomUpper(16),
            ["force_login"] = 1,
            ["partnerid"] = 1,
            ["clienttime_ms"] = now,
            ["t1"] = 0,
            ["t2"] = 0,
            ["t3"] = "MCwwLDAsMCwwLDAsMCwwLDA=",
            ["openid"] = openId,
            ["access_token"] = accessToken,
            ["params"] = encryptedParams,
            ["pk"] = pk,
        });

        var headers = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["x-router"] = "login.user.kugou.com",
        };
        using var client = new KugouClient(mid, dfid);
        var body = await client
            .PostJsonAsync("/v6/login_by_openplat", data, null, headers, cancellationToken)
            .ConfigureAwait(false);
        using var document = JsonDocument.Parse(body);
        var root = document.RootElement;
        if (!root.TryGetProperty("status", out var status) || status.GetInt32() != 1 ||
            !root.TryGetProperty("data", out var payload) || payload.ValueKind != JsonValueKind.Object)
        {
            var code = root.TryGetProperty("error_code", out var codeNode) ? codeNode.ToString() : "?";
            OnlineHttp.Warn($"[kugou] openplat exchange failed code={code}");
            return null;
        }

        var userId = payload.TryGetProperty("userid", out var userNode) ? userNode.ToString() : string.Empty;
        if (payload.TryGetProperty("secu_params", out var secu) && secu.ValueKind == JsonValueKind.String)
        {
            try
            {
                var plain = KugouCrypto.AesDecryptHex(secu.GetString() ?? string.Empty, seed);
                using var tokenDocument = JsonDocument.Parse(plain);
                var tokenNode = tokenDocument.RootElement;
                var token = tokenNode.TryGetProperty("token", out var value) ? value.GetString() ?? string.Empty : string.Empty;
                if (string.IsNullOrWhiteSpace(userId) && tokenNode.TryGetProperty("userid", out var idNode))
                {
                    userId = idNode.ToString();
                }

                if (!string.IsNullOrWhiteSpace(token))
                {
                    OnlineHttp.Info($"[kugou] openplat exchange ok userId={userId}");
                    return new KugouOpenLoginResult(token, userId);
                }
            }
            catch (Exception exception) when (exception is JsonException or FormatException or CryptographicException)
            {
                OnlineHttp.Warn($"[kugou] openplat decrypt failed: {exception.GetType().Name}");
            }
        }

        if (payload.TryGetProperty("token", out var direct) && direct.ValueKind == JsonValueKind.String)
        {
            return new KugouOpenLoginResult(direct.GetString() ?? string.Empty, userId);
        }

        return null;
    }
}
