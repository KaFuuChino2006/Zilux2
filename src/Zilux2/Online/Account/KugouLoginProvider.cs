using System.Net.Http;
using System.Text.Json;
using Zilux2.Online.Kugou;

namespace Zilux2.Online.Account;

// 酷狗二维码登录：login-user.kugou.com 的 /v2/qrcode + /v2/get_userinfo_qrcode，
// 参数与请求头已按 KuGouMusicApi 的 web 签名流程对齐（见 docs/kugou-integration.md §6）。
internal sealed class KugouLoginProvider
{
    private const string UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
    private const int QrExpiresSeconds = 300;

    private readonly AccountStore _store;
    private readonly HttpClient _http;
    private readonly string _mid;
    private readonly string _dfid = "-";

    public KugouLoginProvider(AccountStore store)
    {
        _store = store;
        _mid = KugouSignature.CalculateMid(Guid.NewGuid().ToString());
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        _http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", UserAgent);
        _http.DefaultRequestHeaders.TryAddWithoutValidation("Referer", "https://www.kugou.com/");
    }

    public async Task<LoginQrResponse> CreateQrAsync(CancellationToken cancellationToken)
    {
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
            return ParseStatus(body);
        }
        catch (Exception exception)
        {
            OnlineHttp.Error($"[account] kugou poll parse failed raw={body[..Math.Min(300, body.Length)]} exception={exception}", exception);
            return new LoginStatusResponse { State = "error", Message = "酷狗登录状态解析失败" };
        }
    }

    private LoginStatusResponse ParseStatus(string body)
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
            4 => Authorize(data),
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
    private LoginStatusResponse Authorize(JsonElement data)
    {
        var token = ReadString(data, "token");
        var userId = data.TryGetProperty("userid", out var uid) ? uid.ToString() : ReadString(data, "user_id");
        if (token.Length == 0 || userId.Length == 0)
        {
            return new LoginStatusResponse { State = "error", Message = "酷狗登录没有返回凭证，请重试" };
        }

        var nickname = ReadString(data, "nickname");
        if (nickname.Length == 0) nickname = ReadString(data, "user_name");
        var account = new AccountInfo
        {
            Source = AccountSources.Kugou,
            LoggedIn = true,
            Nickname = nickname.Length > 0 ? nickname : null,
            UserId = userId,
        };
        _store.SaveLogin(AccountSources.Kugou, account, [
            new StoredCookie("kugou", "token", token),
            new StoredCookie("kugou", "userid", userId),
            new StoredCookie("kugou", "mid", _mid),
            new StoredCookie("kugou", "dfid", _dfid),
        ]);
        OnlineHttp.Info($"[account] login source=kugou userId={userId}");
        return new LoginStatusResponse { State = "authorized", Message = "登录成功", Account = account };
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




