using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace Zilux2.Online.Kugou;

// 酷狗接口最小客户端：默认参数 + Android 签名 + 设备 MID。
// 已实测 /v2/search/song 匿名可用（HTTP 200，返回真实结果）。
internal sealed class KugouClient : IDisposable
{
    private const string Gateway = "https://gateway.kugou.com";
    private const int AppId = 1005;
    private const int ClientVer = 20489;
    private const string UserAgent = "Android712-AndroidPhone-20489-18-0-wifi";

    private readonly HttpClient _http;
    private readonly string _mid;
    private readonly string _dfid;

    public KugouClient(string? mid = null, string? dfid = null)
    {
        _mid = string.IsNullOrWhiteSpace(mid) ? KugouSignature.CalculateMid(Guid.NewGuid().ToString()) : mid;
        _dfid = string.IsNullOrWhiteSpace(dfid) ? "-" : dfid;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        _http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", UserAgent);
    }

    public string Mid => _mid;

    public async Task<string> GetAsync(
        string path,
        IReadOnlyDictionary<string, string>? parameters,
        string encryptType,
        IReadOnlyDictionary<string, string>? headers,
        CancellationToken cancellationToken,
        string? baseUrl = null)
    {
        var clientTime = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
        var all = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["dfid"] = _dfid,
            ["mid"] = _mid,
            ["uuid"] = "-",
            ["appid"] = AppId.ToString(CultureInfo.InvariantCulture),
            ["clientver"] = ClientVer.ToString(CultureInfo.InvariantCulture),
            ["clienttime"] = clientTime,
        };
        if (parameters is not null)
        {
            foreach (var pair in parameters)
            {
                all[pair.Key] = pair.Value;
            }
        }

        var signature = encryptType == "web"
            ? KugouSignature.Web(all)
            : KugouSignature.Android(all);

        var query = string.Join("&", all.Select(pair => $"{pair.Key}={Uri.EscapeDataString(pair.Value)}"))
                    + "&signature=" + signature;
        var url = $"{baseUrl ?? Gateway}{path}?{query}";

        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("mid", _mid);
        request.Headers.TryAddWithoutValidation("dfid", _dfid);
        request.Headers.TryAddWithoutValidation("clienttime", clientTime);
        request.Headers.TryAddWithoutValidation("kg-rc", "1");
        request.Headers.TryAddWithoutValidation("kg-thash", "5d816a0");
        request.Headers.TryAddWithoutValidation("kg-rec", "1");
        request.Headers.TryAddWithoutValidation("kg-rf", "B9EDA08A64250DEFFBCADDEE00F8F25F");
        if (headers is not null)
        {
            foreach (var pair in headers)
            {
                request.Headers.TryAddWithoutValidation(pair.Key, pair.Value);
            }
        }

        using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"酷狗接口 HTTP {(int)response.StatusCode}: {body[..Math.Min(160, body.Length)]}");
        }

        return body;
    }

    public Task<string> SearchSongsAsync(string keyword, int page, int pageSize, CancellationToken cancellationToken)
    {
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["keyword"] = keyword,
            ["page"] = page.ToString(CultureInfo.InvariantCulture),
            ["pagesize"] = pageSize.ToString(CultureInfo.InvariantCulture),
            ["platform"] = "AndroidFilter",
            ["iscorrection"] = "1",
            ["privilegefilter"] = "0",
            ["area_code"] = "1",
            ["dopicfull"] = "1",
        };
        var headers = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["x-router"] = "complexsearch.kugou.com",
        };
        return GetAsync("/v2/search/song", parameters, "android", headers, cancellationToken);
    }

    public void Dispose() => _http.Dispose();
}
