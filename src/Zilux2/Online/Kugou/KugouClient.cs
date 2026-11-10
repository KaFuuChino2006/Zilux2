using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace Zilux2.Online.Kugou;

// 酷狗接口最小客户端：默认参数 + Android 签名 + 设备 MID。
// 搜索/歌词匿名可用；个人歌单、收藏、播放需要 token（且 token 需与设备绑定）。
internal sealed class KugouClient : IDisposable
{
    private const string Gateway = "https://gateway.kugou.com";
    private const int AppId = 1005;
    private const int ClientVer = 20489;
    private const string UserAgent = "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi";

    private readonly HttpClient _http;
    private readonly string _mid;
    private readonly string _dfid;

    public KugouClient(string? mid = null, string? dfid = null)
    {
        _mid = string.IsNullOrWhiteSpace(mid) ? KugouSignature.CalculateMid(Guid.NewGuid().ToString()) : mid;
        _dfid = string.IsNullOrWhiteSpace(dfid) ? "-" : dfid;
        _http = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(20) };
        _http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", UserAgent);
    }

    public string Mid => _mid;

    public string Dfid => _dfid;

    public async Task<string> GetAsync(
        string path,
        IReadOnlyDictionary<string, string>? parameters,
        string encryptType,
        IReadOnlyDictionary<string, string>? headers,
        CancellationToken cancellationToken,
        string? baseUrl = null)
    {
        var (all, clientTime) = BuildParameters(parameters);
        var signature = encryptType == "web"
            ? KugouSignature.Web(all)
            : KugouSignature.Android(all);
        var url = BuildUrl(path, all, signature, baseUrl);
        using var request = BuildRequest(HttpMethod.Get, url, clientTime, headers);
        return await SendTextAsync(request, cancellationToken).ConfigureAwait(false);
    }

    // POST JSON：signature 覆盖「默认参数 + 业务参数 + 原始 JSON body」。酷狗 cloudlist 系接口都这样。
    public async Task<string> PostJsonAsync(
        string path,
        string jsonBody,
        IReadOnlyDictionary<string, string>? parameters,
        IReadOnlyDictionary<string, string>? headers,
        CancellationToken cancellationToken,
        string? baseUrl = null)
    {
        var (all, clientTime) = BuildParameters(parameters);
        var signature = KugouSignature.Android(all, jsonBody);
        var url = BuildUrl(path, all, signature, baseUrl);
        using var request = BuildRequest(HttpMethod.Post, url, clientTime, headers);
        request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
        return await SendTextAsync(request, cancellationToken).ConfigureAwait(false);
    }

    // POST 原始 body（设备注册的 AES 密文）：body 原文参与 signature。
    public async Task<byte[]> PostRawAsync(
        string path,
        string body,
        string contentType,
        IReadOnlyDictionary<string, string>? parameters,
        IReadOnlyDictionary<string, string>? headers,
        CancellationToken cancellationToken,
        string? baseUrl = null)
    {
        var (all, clientTime) = BuildParameters(parameters);
        var signature = KugouSignature.Android(all, body);
        var url = BuildUrl(path, all, signature, baseUrl);
        using var request = BuildRequest(HttpMethod.Post, url, clientTime, headers);
        request.Content = new StringContent(body, Encoding.UTF8, contentType);
        using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"酷狗接口 HTTP {(int)response.StatusCode}: {Convert.ToHexString(bytes.AsSpan(0, Math.Min(160, bytes.Length)))}");
        }

        return bytes;
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

    /// <summary>取流：/v5/url。freePart=true 时付费歌曲会返回 60 秒试听地址。</summary>
    public Task<string> GetStreamUrlAsync(
        string hash,
        long albumId,
        long mixId,
        string quality,
        bool freePart,
        string userId,
        string token,
        CancellationToken cancellationToken)
    {
        var normalizedHash = hash.ToLowerInvariant();
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["album_id"] = albumId.ToString(CultureInfo.InvariantCulture),
            ["area_code"] = "1",
            ["hash"] = normalizedHash,
            ["ssa_flag"] = "is_fromtrack",
            ["version"] = "11430",
            ["page_id"] = "151369488",
            ["quality"] = quality,
            ["album_audio_id"] = mixId.ToString(CultureInfo.InvariantCulture),
            ["behavior"] = "play",
            ["pid"] = "2",
            ["cmd"] = "26",
            ["pidversion"] = "3001",
            ["IsFreePart"] = freePart ? "1" : "0",
            ["ppage_id"] = "463467626,350369493,788954147",
            ["cdnBackup"] = "1",
            ["module"] = string.Empty,
            ["clientver"] = "11430",
            ["userid"] = userId,
            ["token"] = token,
            ["key"] = KugouSignature.SignKey(normalizedHash, _mid, userId),
        };
        var headers = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["x-router"] = "trackercdn.kugou.com",
        };
        return GetAsync("/v5/url", parameters, "android", headers, cancellationToken);
    }

    /// <summary>登录用户歌单（/v7/get_all_list）。token/userid 来自账号库，未登录时调用方应先拒绝。</summary>
    public Task<string> GetUserPlaylistsAsync(
        string userId,
        string token,
        int page,
        int pageSize,
        CancellationToken cancellationToken)
    {
        var body = JsonSerializer.Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["userid"] = userId,
            ["token"] = token,
            ["total_ver"] = 979,
            ["type"] = 2,
            ["page"] = page,
            ["pagesize"] = pageSize,
        });
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["plat"] = "1",
            ["userid"] = userId,
            ["token"] = token,
        };
        var headers = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["x-router"] = "cloudlist.service.kugou.com",
        };
        return PostJsonAsync("/v7/get_all_list", body, parameters, headers, cancellationToken);
    }

    /// <summary>歌曲评论（/mcomment/v1/cmtlist）。</summary>
    public Task<string> GetCommentsAsync(
        long mixSongId,
        int page,
        int pageSize,
        string userId,
        string token,
        CancellationToken cancellationToken)
    {
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["ver"] = "6",
            ["mixsongid"] = mixSongId.ToString(CultureInfo.InvariantCulture),
            ["need_show_image"] = "1",
            ["p"] = page.ToString(CultureInfo.InvariantCulture),
            ["pagesize"] = pageSize.ToString(CultureInfo.InvariantCulture),
            ["show_classify"] = "1",
            ["show_hotword_list"] = "1",
            ["extdata"] = "0",
            ["code"] = "fc4be23b4e972707f36b8a828a93ba8a",
            ["userid"] = userId,
            ["token"] = token,
        };
        return PostJsonAsync("/mcomment/v1/cmtlist", string.Empty, parameters, null, cancellationToken);
    }

    /// <summary>公开歌单（热门推荐）：/v2/special_recommend。</summary>
    public Task<string> GetSpecialRecommendAsync(
        string userId,
        string token,
        int page,
        int pageSize,
        CancellationToken cancellationToken)
    {
        var clientTime = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
        var body = JsonSerializer.Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["appid"] = AppId,
            ["mid"] = _mid,
            ["clientver"] = ClientVer,
            ["platform"] = "android",
            ["clienttime"] = clientTime,
            ["userid"] = userId,
            ["module_id"] = 1,
            ["page"] = page,
            ["pagesize"] = pageSize,
            ["key"] = KugouSignature.SignParamsKey(clientTime),
            ["special_recommend"] = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                ["withtag"] = 1,
                ["withsong"] = 1,
                ["sort"] = 1,
                ["ugc"] = 1,
                ["is_selected"] = 0,
                ["withrecommend"] = 1,
                ["area_code"] = 1,
                ["categoryid"] = 0,
            },
            ["req_multi"] = 1,
            ["retrun_min"] = 5,
            ["return_special_falg"] = 1,
        });
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["userid"] = userId,
            ["token"] = token,
        };
        var headers = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["x-router"] = "specialrec.service.kugou.com",
        };
        return PostJsonAsync("/v2/special_recommend", body, parameters, headers, cancellationToken);
    }

    /// <summary>公开歌单歌曲（热门歌单详情）：/pubsongs/v2/get_other_list_file_nofilt。</summary>
    public Task<string> GetPublicPlaylistAsync(
        string globalCollectionId,
        int page,
        int pageSize,
        string userId,
        string token,
        CancellationToken cancellationToken)
    {
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["area_code"] = "1",
            ["begin_idx"] = ((page - 1) * pageSize).ToString(CultureInfo.InvariantCulture),
            ["plat"] = "1",
            ["type"] = "1",
            ["mode"] = "1",
            ["personal_switch"] = "1",
            ["extend_fields"] = "abtags,hot_cmt,popularization",
            ["pagesize"] = pageSize.ToString(CultureInfo.InvariantCulture),
            ["global_collection_id"] = globalCollectionId,
            ["userid"] = userId,
            ["token"] = token,
        };
        return GetAsync("/pubsongs/v2/get_other_list_file_nofilt", parameters, "android", null, cancellationToken);
    }

    /// <summary>每日推荐（/everyday_song_recommend）。</summary>
    public Task<string> GetDailyAsync(string userId, string token, CancellationToken cancellationToken)
    {
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["platform"] = "ios",
            ["userid"] = userId,
            ["token"] = token,
        };
        var headers = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["x-router"] = "everydayrec.service.kugou.com",
        };
        return PostJsonAsync("/everyday_song_recommend", string.Empty, parameters, headers, cancellationToken);
    }

    /// <summary>最近播放（/playhistory/v1/get_songs）。</summary>
    public Task<string> GetRecentAsync(string userId, string token, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["token"] = token,
            ["userid"] = userId,
            ["source_classify"] = "app",
            ["to_subdivide_sr"] = 1,
        });
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["userid"] = userId,
            ["token"] = token,
        };
        return PostJsonAsync("/playhistory/v1/get_songs", body, parameters, null, cancellationToken);
    }

    /// <summary>云歌单歌曲分页。官方 App 当前使用 /v4/get_list_all_file（v3 会触发 20028 风控）。</summary>
    public Task<string> GetCloudPlaylistAsync(
        string userId,
        string token,
        long listId,
        int page,
        int pageSize,
        CancellationToken cancellationToken)
    {
        var body = JsonSerializer.Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["listid"] = listId,
            ["userid"] = userId,
            ["area_code"] = 1,
            ["show_relate_goods"] = 1,
            ["pagesize"] = pageSize,
            ["allplatform"] = 1,
            ["show_cover"] = 1,
            ["type"] = 0,
            ["token"] = token,
            ["page"] = page,
        });
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["userid"] = userId,
            ["token"] = token,
        };
        var headers = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["x-router"] = "cloudlist.service.kugou.com",
        };
        return PostJsonAsync("/v4/get_list_all_file", body, parameters, headers, cancellationToken);
    }

    /// <summary>把一首歌加入云歌单（「我喜欢」也是普通歌单，用同一接口写入）。</summary>
    public Task<string> AddCloudSongAsync(
        string userId,
        string token,
        long listId,
        string name,
        string hash,
        long durationMs,
        long albumId,
        long mixSongId,
        CancellationToken cancellationToken)
    {
        var body = JsonSerializer.Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["userid"] = userId,
            ["token"] = token,
            ["listid"] = listId,
            ["list_ver"] = 0,
            ["type"] = 0,
            ["slow_upload"] = 1,
            ["scene"] = "false;null",
            ["data"] = new object[]
            {
                new Dictionary<string, object>(StringComparer.Ordinal)
                {
                    ["number"] = 1,
                    ["name"] = name,
                    ["hash"] = hash,
                    ["size"] = 0,
                    ["sort"] = 0,
                    ["timelen"] = durationMs,
                    ["bitrate"] = 0,
                    ["album_id"] = albumId,
                    ["mixsongid"] = mixSongId,
                },
            },
        });
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["last_time"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture),
            ["last_area"] = "gztx",
            ["userid"] = userId,
            ["token"] = token,
        };
        var headers = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["x-router"] = "cloudlist.service.kugou.com",
        };
        return PostJsonAsync("/cloudlist.service/v6/add_song", body, parameters, headers, cancellationToken);
    }

    /// <summary>从云歌单删除歌曲（fileid 是歌单内序号，不是音频 id）。</summary>
    public Task<string> DeleteCloudSongsAsync(
        string userId,
        string token,
        long listId,
        IReadOnlyList<long> fileIds,
        CancellationToken cancellationToken)
    {
        var body = JsonSerializer.Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["listid"] = listId,
            ["userid"] = userId,
            ["data"] = fileIds.Select(id => new Dictionary<string, object>(StringComparer.Ordinal)
            {
                ["fileid"] = id,
            }).ToArray(),
            ["type"] = 0,
            ["token"] = token,
            ["list_ver"] = 0,
        });
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["userid"] = userId,
            ["token"] = token,
        };
        var headers = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["x-router"] = "cloudlist.service.kugou.com",
        };
        return PostJsonAsync("/v4/delete_songs", body, parameters, headers, cancellationToken);
    }

    private (Dictionary<string, string> All, string ClientTime) BuildParameters(IReadOnlyDictionary<string, string>? parameters)
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

        return (all, clientTime);
    }

    private static string BuildUrl(string path, Dictionary<string, string> all, string signature, string? baseUrl)
    {
        var query = string.Join("&", all.Select(pair => $"{pair.Key}={Uri.EscapeDataString(pair.Value)}"))
                    + "&signature=" + signature;
        return $"{baseUrl ?? Gateway}{path}?{query}";
    }

    private HttpRequestMessage BuildRequest(
        HttpMethod method,
        string url,
        string clientTime,
        IReadOnlyDictionary<string, string>? headers)
    {
        var request = new HttpRequestMessage(method, url);
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

        return request;
    }

    private async Task<string> SendTextAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"酷狗接口 HTTP {(int)response.StatusCode}: {body[..Math.Min(160, body.Length)]}");
        }

        return body;
    }

    public void Dispose() => _http.Dispose();
}
