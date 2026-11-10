using System.Net.Http;
using System.Text.Json;
using Zilux2.Online.Kugou;

namespace Zilux2.Online.Account;

// 酷狗二维码登录：login-user.kugou.com 的 /v2/qrcode + /v2/get_userinfo_qrcode，
// 参数与请求头已按 KuGouMusicApi 的 web 签名流程对齐（见 docs/kugou-integration.md §6）。
internal sealed class KugouLoginProvider
{
    internal async Task SaveWebCookiesAsync(IReadOnlyList<WebLoginCookie> cookies, CancellationToken cancellationToken)
    {
        var values = CookieValues(cookies);
        var token = FirstNonEmpty(values.GetValueOrDefault("token"), values.GetValueOrDefault("t"));
        var userId = FirstNonEmpty(values.GetValueOrDefault("userid"), values.GetValueOrDefault("KugooID"));
        if (token.Length is 0 or > 1024 || token.Any(c => char.IsControl(c) || c == ';') ||
            userId.Length is 0 or > 24 || !userId.All(char.IsAsciiDigit))
            throw new AccountException("invalid-cookie", "酷狗未返回有效登录凭证，请使用酷狗 App 扫码登录");

        var webMid = FirstNonEmpty(values.GetValueOrDefault("mid"), values.GetValueOrDefault("kg_mid"), _mid);
        var webDfid = KugouDevice.ResolveDfid(FirstNonEmpty(values.GetValueOrDefault("dfid"), values.GetValueOrDefault("kg_dfid")));
        var third = values.GetValueOrDefault("ThirdData") ?? string.Empty;
        var thirdValues = ParsePairs(third);
        var openId = thirdValues.GetValueOrDefault("openid") ?? string.Empty;
        var accessToken = thirdValues.GetValueOrDefault("access_token") ?? string.Empty;
        var scope = "web";
        if (openId.Length > 0 && accessToken.Length > 0)
        {
            for (var attempt = 0; attempt < 2; attempt++)
            {
                try
                {
                    var exchanged = await KugouOpenLogin
                        .ExchangeAsync(webMid, webDfid, openId, accessToken, cancellationToken)
                        .ConfigureAwait(false);
                    if (exchanged is not null && exchanged.Token.Length > 0)
                    {
                        token = exchanged.Token;
                        if (exchanged.UserId.Length > 0)
                        {
                            userId = exchanged.UserId;
                        }

                        scope = "app";
                        break;
                    }
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    OnlineHttp.Warn($"[account] kugou openplat exchange failed: {OnlineHttp.Describe(exception)}");
                }

                if (attempt == 0)
                {
                    await Task.Delay(600, cancellationToken).ConfigureAwait(false);
                }
            }
        }

        var device = await KugouDevice.EnsureRegisteredAsync(token, userId, cancellationToken, force: true).ConfigureAwait(false);
        webDfid = device.Dfid;
        var verifyError = await VerifyPlaylistsAsync(device, token, userId, cancellationToken).ConfigureAwait(false);
        if (verifyError is not null)
        {
            throw new AccountException("upstream-failed", verifyError);
        }
        var stored = new List<StoredCookie>
        {
            new("kugou.com", "token", token),
            new("kugou.com", "userid", userId),
            new("kugou.com", "mid", webMid),
            new("kugou.com", "dfid", webDfid),
            new("kugou.com", "scope", scope),
        };
        var profile = await TryFetchProfileAsync(token, userId, webMid, webDfid, stored, cancellationToken).ConfigureAwait(false);
        _store.SaveLogin(AccountSources.Kugou, new AccountInfo
        {
            Source = AccountSources.Kugou,
            LoggedIn = true,
            UserId = userId,
            Nickname = profile.Nickname ?? "酷狗音乐用户",
            AvatarDataUrl = profile.Avatar,
        }, stored);
        OnlineHttp.Info($"[account] kugou web login saved scope={scope} nickname={profile.Nickname ?? "-"} avatar={(profile.Avatar is null ? "no" : "yes")}");
    }

    private static Dictionary<string, string> CookieValues(IReadOnlyList<WebLoginCookie> cookies)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var cookie in cookies)
        {
            values[cookie.Name] = cookie.Value;
            if (!cookie.Name.Equals("KuGoo", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            foreach (var pair in cookie.Value.Split('&'))
            {
                var eq = pair.IndexOf('=');
                if (eq > 0)
                {
                    values[pair[..eq]] = Uri.UnescapeDataString(pair[(eq + 1)..]);
                }
            }
        }

        return values;
    }

    private static Dictionary<string, string> ParsePairs(string value)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in value.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = pair.IndexOf('=');
            if (eq <= 0)
            {
                continue;
            }

            values[pair[..eq]] = Uri.UnescapeDataString(pair[(eq + 1)..]);
        }

        return values;
    }

    private static string FirstNonEmpty(params string?[] values)
        => values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? string.Empty;

    /// <summary>已登录账号刷新昵称/头像；失败返回 null，账号保持原样。</summary>
    public async Task<AccountInfo?> RefreshAsync(IReadOnlyList<StoredCookie> cookies, CancellationToken cancellationToken)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var cookie in cookies)
        {
            if (!string.IsNullOrWhiteSpace(cookie.Value))
            {
                values[cookie.Name] = cookie.Value;
            }
        }

        var token = FirstNonEmpty(values.GetValueOrDefault("token"), values.GetValueOrDefault("t"));
        var userId = FirstNonEmpty(values.GetValueOrDefault("userid"), values.GetValueOrDefault("KugooID"));
        if (token.Length == 0 || userId.Length == 0)
        {
            return null;
        }

        var mid = FirstNonEmpty(values.GetValueOrDefault("mid"), values.GetValueOrDefault("kg_mid"), _mid);
        var dfid = KugouDevice.ResolveDfid(FirstNonEmpty(values.GetValueOrDefault("dfid"), values.GetValueOrDefault("kg_dfid")));
        var profile = await TryFetchProfileAsync(token, userId, mid, dfid, cookies, cancellationToken).ConfigureAwait(false);
        if (profile.Nickname is null && profile.Avatar is null)
        {
            return null;
        }

        return new AccountInfo
        {
            Source = AccountSources.Kugou,
            LoggedIn = true,
            UserId = userId,
            Nickname = profile.Nickname,
            AvatarDataUrl = profile.Avatar,
        };
    }

    // 酷狗资料接口是 relation.user.kugou.com 的 POST /v1/get_my_userinfo：
    // p = 无填充 RSA({clienttime, token})，key = md5(appid + salt + clientver + clienttime)。
    private static async Task<(string? Nickname, string? Avatar)> TryFetchProfileAsync(
        string token,
        string userId,
        string mid,
        string dfid,
        IReadOnlyList<StoredCookie> cookies,
        CancellationToken cancellationToken)
    {
        try
        {
            var clientTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var payload = KugouCrypto.RsaRawHex(
                JsonSerializer.Serialize(new { clienttime = clientTime, token })).ToUpperInvariant();
            var fields = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["p"] = payload,
                ["appid"] = 1005,
                ["mid"] = mid,
                ["clientver"] = "20489",
                ["source"] = 0,
                ["clienttime"] = clientTime,
                ["uuid"] = "-",
                ["userid"] = long.TryParse(userId, out var uid) ? uid : 0L,
                ["key"] = KugouSignature.Md5("1005" + KugouSignature.AndroidSalt + "20489" + clientTime),
            };
            var cookieHeader = string.Join("; ", cookies
                .Where(item => !string.IsNullOrWhiteSpace(item.Value))
                .Select(item => item.Name + "=" + item.Value));
            var endpoint = "http://relation.user.kugou.com/v1/get_my_userinfo";
            var upstream = await OnlineHttp
                .FetchTextAsync(
                    endpoint,
                    "https://www.kugou.com/",
                    TimeSpan.FromSeconds(12),
                    cancellationToken,
                    HttpMethod.Post,
                    JsonSerializer.Serialize(fields),
                    cookieHeader.Length > 0 ? cookieHeader : null)
                .ConfigureAwait(false);

            var parsed = ParseProfile(upstream.Body);
            if (parsed.Nickname is null && parsed.AvatarUrl is null)
            {
                // 酷狗部分账号/版本只接受 query/form 形态；JSON body 返回 data:null + 20006 时
                // 再用 GET query 重试一次，避免登录后昵称和头像一直是空。
                var query = string.Join("&", fields.Select(pair =>
                    Uri.EscapeDataString(pair.Key) + "=" +
                    Uri.EscapeDataString(Convert.ToString(pair.Value, System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty)));
                var fallback = await OnlineHttp
                    .FetchTextAsync(
                        endpoint + "?" + query,
                        "https://www.kugou.com/",
                        TimeSpan.FromSeconds(12),
                        cancellationToken,
                        cookie: cookieHeader.Length > 0 ? cookieHeader : null)
                    .ConfigureAwait(false);
                parsed = ParseProfile(fallback.Body);
                OnlineHttp.Info($"[account] kugou profile fallback status={fallback.Status} bytes={fallback.Body.Length} nickname={parsed.Nickname ?? "-"} avatar={(parsed.AvatarUrl is null ? "no" : "yes")}");
            }

            if (parsed.Nickname is null && parsed.AvatarUrl is null)
            {
                // 资料接口对部分 App token 返回 20006；云歌单条目里带 create_user_pic，
                // 用同一份有效凭证反推头像，至少不让账号面板一直显示单字占位。
                try
                {
                    using var client = new KugouClient(mid, dfid);
                    var listBody = await client
                        .GetUserPlaylistsAsync(userId, token, 1, 30, cancellationToken)
                        .ConfigureAwait(false);
                    using var listDocument = JsonDocument.Parse(listBody);
                    if (listDocument.RootElement.TryGetProperty("data", out var listData) &&
                        listData.TryGetProperty("info", out var listInfo) &&
                        listInfo.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in listInfo.EnumerateArray())
                        {
                            var pic = FirstString(item, "create_user_pic", "list_create_user_pic");
                            if (!string.IsNullOrWhiteSpace(pic))
                            {
                                parsed = (parsed.Nickname, pic);
                                break;
                            }
                        }
                    }
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    OnlineHttp.Warn($"[account] kugou avatar fallback failed: {OnlineHttp.Describe(exception)}");
                }
            }

            var avatar = await FetchAvatarDataUrlAsync(parsed.AvatarUrl, cancellationToken).ConfigureAwait(false);
            OnlineHttp.Info($"[account] kugou profile status={upstream.Status} bytes={upstream.Body.Length} nickname={parsed.Nickname ?? "-"} avatar={(avatar is null ? "no" : "yes")}");
            if (parsed.Nickname is null && avatar is null)
            {
                OnlineHttp.Warn($"[account] kugou profile body={upstream.Body[..Math.Min(300, upstream.Body.Length)]}");
            }

            return (parsed.Nickname, avatar);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            OnlineHttp.Warn($"[account] kugou profile failed: {OnlineHttp.Describe(exception)}");
            return (null, null);
        }
    }

    private static (string? Nickname, string? AvatarUrl) ParseProfile(string body)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            var data = root.TryGetProperty("data", out var dataElement) && dataElement.ValueKind == JsonValueKind.Object
                ? dataElement
                : root;
            return (
                FirstString(data, "nickname", "nick_name", "user_nickname", "kugou_nickname", "nick", "username"),
                FirstString(data, "pic", "user_pic", "avatar", "img", "big_pic", "pic_url"));
        }
        catch (JsonException)
        {
            return (null, null);
        }
    }

    private static async Task<string?> FetchAvatarDataUrlAsync(string? avatarUrl, CancellationToken cancellationToken)
    {
        var normalized = KugouCover.Normalize(avatarUrl);
        if (normalized is null)
        {
            return null;
        }

        try
        {
            var response = await OnlineHttp
                .FetchBytesAsync(normalized, "https://www.kugou.com/", TimeSpan.FromSeconds(10), cancellationToken)
                .ConfigureAwait(false);
            if (response.Bytes.Length is 0 or > 512 * 1024)
            {
                return null;
            }

            var contentType = string.IsNullOrWhiteSpace(response.ContentType) ? "image/jpeg" : response.ContentType;
            return $"data:{contentType};base64,{Convert.ToBase64String(response.Bytes)}";
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            OnlineHttp.Warn($"[account] kugou avatar failed: {OnlineHttp.Describe(exception)}");
            return null;
        }
    }

    private static string? FirstString(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (element.TryGetProperty(name, out var node) &&
                node.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(node.GetString()))
            {
                return node.GetString();
            }
        }

        return null;
    }

    private const string UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
    private const int QrExpiresSeconds = 300;

    private readonly AccountStore _store;
    private readonly HttpClient _http;
    private string _mid;
    private string _dfid;

    public KugouLoginProvider(AccountStore store)
    {
        _store = store;
        var device = KugouDevice.Current;
        _mid = device.Mid;
        _dfid = device.HasRegisteredDevice ? device.Dfid : "-";
        _http = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(15) };
        _http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", UserAgent);
        _http.DefaultRequestHeaders.TryAddWithoutValidation("Referer", "https://www.kugou.com/");
    }

    public async Task<LoginQrResponse> CreateQrAsync(CancellationToken cancellationToken)
    {
        // 酷狗 token 与设备绑定：先确保本机有持久化 mid；dfid 要等扫码拿到 token 后再注册。
        var device = await KugouDevice.EnsureRegisteredAsync(null, null, cancellationToken).ConfigureAwait(false);
        _mid = device.Mid;
        _dfid = device.Dfid;
        var parameters = Merge(new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["appid"] = "1001",
            ["type"] = "1",
            ["plat"] = "4",
            ["qrcode_txt"] = "https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1001&",
            ["srcappid"] = "2919",
        });
        var body = await SendAsync("https://login-user.kugou.com/v2/qrcode", parameters, cancellationToken).ConfigureAwait(false);
        using var document = JsonDocument.Parse(body);
        if (!document.RootElement.TryGetProperty("data", out var data) ||
            data.ValueKind != JsonValueKind.Object ||
            !data.TryGetProperty("qrcode", out var qrElement))
        {
            throw new AccountException("upstream-failed", "酷狗二维码生成失败，请重试");
        }

        var qrKey = qrElement.GetString() ?? string.Empty;
        if (qrKey.Length == 0)
        {
            throw new AccountException("upstream-failed", "酷狗没有返回二维码内容");
        }

        var image = data.TryGetProperty("qrcode_img", out var img) ? img.GetString() : null;
        OnlineHttp.Info($"[account] qr source=kugou keyLen={qrKey.Length} expiresIn={QrExpiresSeconds}");
        return new LoginQrResponse
        {
            Source = AccountSources.Kugou,
            Mode = "image",
            Key = "kg:" + qrKey,
            ImageDataUrl = image,
            ExpiresIn = QrExpiresSeconds,
        };
    }

    public async Task<LoginStatusResponse> PollAsync(string key, CancellationToken cancellationToken)
    {
        try
        {
            return await PollCoreAsync(key, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            OnlineHttp.Error($"[account] kugou poll failed key={key[..Math.Min(6, key.Length)]}", exception);
            return new LoginStatusResponse { State = "error", Message = "酷狗登录失败，请刷新二维码重试" };
        }
    }

    private async Task<LoginStatusResponse> PollCoreAsync(string key, CancellationToken cancellationToken)
    {
        var qrKey = key.StartsWith("kg:", StringComparison.Ordinal) ? key[3..] : key;
        var parameters = Merge(new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["plat"] = "4",
            ["appid"] = "1005",
            ["srcappid"] = "2919",
            ["qrcode"] = qrKey,
        });
        var body = await SendAsync("https://login-user.kugou.com/v2/get_userinfo_qrcode", parameters, cancellationToken).ConfigureAwait(false);
        try
        {
            return await ParseStatusAsync(body, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            OnlineHttp.Error($"[account] kugou poll parse failed raw={body[..Math.Min(300, body.Length)]} exception={exception}", exception);
            return new LoginStatusResponse { State = "error", Message = "酷狗登录状态解析失败" };
        }
    }

    private async Task<LoginStatusResponse> ParseStatusAsync(string body, CancellationToken cancellationToken)
    {
        using var document = JsonDocument.Parse(body);
        if (!document.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
        {
            return Waiting("等待扫码…");
        }

        var status = ReadStatus(data);
        return status switch
        {
            0 => new LoginStatusResponse { State = "expired", Message = "二维码已过期，请刷新" },
            1 => Waiting("等待扫码…"),
            2 => new LoginStatusResponse { State = "scanned", Message = "已扫码，请在手机上确认" },
            4 => await AuthorizeAsync(data, cancellationToken).ConfigureAwait(false),
            _ => Waiting("等待扫码…"),
        };
    }

    private static int ReadStatus(JsonElement data)
    {
        if (!data.TryGetProperty("status", out var node))
        {
            return 1;
        }

        return node.ValueKind switch
        {
            JsonValueKind.Number => node.GetInt32(),
            JsonValueKind.String => int.TryParse(node.GetString(), out var parsed) ? parsed : 1,
            _ => 1,
        };
    }
    private async Task<LoginStatusResponse> AuthorizeAsync(JsonElement data, CancellationToken cancellationToken)
    {
        var token = ReadString(data, "token");
        var userId = data.TryGetProperty("userid", out var uid) ? uid.ToString() : ReadString(data, "user_id");
        if (token.Length == 0 || userId.Length == 0)
        {
            return new LoginStatusResponse { State = "error", Message = "酷狗登录没有返回凭证，请重试" };
        }

        // 扫码 token 拿到后再注册设备：注册接口匿名不会返回 dfid，必须带 token，否则云歌单会 20017。
        var device = await KugouDevice.EnsureRegisteredAsync(token, userId, cancellationToken, force: true).ConfigureAwait(false);
        _mid = device.Mid;
        _dfid = device.Dfid;
        var verifyError = await VerifyPlaylistsAsync(device, token, userId, cancellationToken).ConfigureAwait(false);
        if (verifyError is not null)
        {
            return new LoginStatusResponse { State = "error", Message = verifyError };
        }
        var nickname = ReadString(data, "nickname");
        if (nickname.Length == 0) nickname = ReadString(data, "user_name");
        // 必须传 List（CookieJar.Serialize 用源生成的 List<StoredCookie>，数组会在序列化时抛 InvalidCast）。
        var cookies = new List<StoredCookie>
        {
            new("kugou.com", "token", token),
            new("kugou.com", "userid", userId),
            new("kugou.com", "mid", _mid),
            new("kugou.com", "dfid", _dfid),
            new("kugou.com", "scope", "app"),
        };
        var profile = await TryFetchProfileAsync(token, userId, _mid, _dfid, cookies, cancellationToken).ConfigureAwait(false);
        var account = new AccountInfo
        {
            Source = AccountSources.Kugou,
            LoggedIn = true,
            Nickname = profile.Nickname ?? (nickname.Length > 0 ? nickname : "酷狗音乐用户"),
            AvatarDataUrl = profile.Avatar,
            UserId = userId,
        };
        _store.SaveLogin(AccountSources.Kugou, account, cookies);
        OnlineHttp.Info($"[account] login source=kugou userId={userId} nickname={account.Nickname ?? "-"} avatar={(account.AvatarDataUrl is null ? "no" : "yes")}");
        return new LoginStatusResponse { State = "authorized", Message = "登录成功", Account = account };
    }

    // 登录成功不等于云歌单可用：token 与 dfid 必须成对注册。这里直接拉一次 get_all_list，
    // 返回 20017/401 时把登录判为失败，避免 UI 显示「已登录」却一直空白。
    private static async Task<string?> VerifyPlaylistsAsync(
        KugouDevice device,
        string token,
        string userId,
        CancellationToken cancellationToken)
    {
        try
        {
            using var client = new KugouClient(device.Mid, device.Dfid);
            var body = await client
                .GetUserPlaylistsAsync(userId, token, 1, 30, cancellationToken)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (root.TryGetProperty("status", out var status) && status.ToString() == "1")
            {
                return null;
            }

            var code = root.TryGetProperty("error_code", out var codeNode) ? codeNode.ToString() : "?";
            OnlineHttp.Warn($"[account] kugou login verify failed code={code} body={body[..Math.Min(200, body.Length)]}");
            return $"酷狗登录凭证无法读取歌单（{code}），请重新扫码；若持续失败请更新酷狗客户端";
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            OnlineHttp.Warn($"[account] kugou login verify failed: {OnlineHttp.Describe(exception)}");
            return "酷狗登录后校验歌单失败，请重试或重新扫码";
        }
    }

    private SortedDictionary<string, string> Merge(Dictionary<string, string> parameters)
    {
        var all = new SortedDictionary<string, string>(StringComparer.Ordinal)
        {
            ["dfid"] = _dfid,
            ["mid"] = _mid,
            ["uuid"] = "-",
            ["clientver"] = "20489",
            ["clienttime"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(),
        };
        foreach (var pair in parameters)
        {
            all[pair.Key] = pair.Value;
        }

        return all;
    }

    private async Task<string> SendAsync(
        string baseUrl,
        SortedDictionary<string, string> parameters,
        CancellationToken cancellationToken)
    {
        var signature = KugouSignature.Web(parameters);
        var url = baseUrl + "?" +
                  string.Join("&", parameters.Select(pair => $"{pair.Key}={Uri.EscapeDataString(pair.Value)}")) +
                  "&signature=" + signature;
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("mid", _mid);
        request.Headers.TryAddWithoutValidation("dfid", _dfid);
        request.Headers.TryAddWithoutValidation("clienttime", parameters["clienttime"]);
        request.Headers.TryAddWithoutValidation("kg-rc", "1");
        request.Headers.TryAddWithoutValidation("kg-thash", "5d816a0");
        using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new AccountException("upstream-failed", $"酷狗接口 HTTP {(int)response.StatusCode}");
        }

        return body;
    }

    private static LoginStatusResponse Waiting(string message)
        => new() { State = "waiting", Message = message };

    private static string ReadString(JsonElement element, string name)
        => element.TryGetProperty(name, out var node) && node.ValueKind == JsonValueKind.String
            ? node.GetString() ?? string.Empty
            : string.Empty;
}






