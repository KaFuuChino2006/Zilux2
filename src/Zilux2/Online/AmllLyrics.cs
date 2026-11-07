using System.Net;
using System.Net.Http;

namespace Zilux2.Online;

// AMLL TTML DataBase 的逐字歌词兜底：仓库已经为每个平台 ID 预生成了 .yrc，
// 与网易云 YRC 同格式，前端现有解析器可以直接吃。
// 直链规则：https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/{ncm|qq}-lyrics/{id}.yrc
internal static class AmllLyrics
{
    private const string BaseUrl = "https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main";

    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromSeconds(8),
    };

    private static string? FolderOf(string source) => source switch
    {
        "netease" => "ncm-lyrics",
        "qq" => "qq-lyrics",
        _ => null,
    };

    public static async Task<string?> FetchYrcAsync(string source, string id, CancellationToken cancellationToken)
    {
        var folder = FolderOf(source);
        if (folder is null || string.IsNullOrWhiteSpace(id))
        {
            return null;
        }

        var url = $"{BaseUrl}/{folder}/{Uri.EscapeDataString(id)}.yrc";
        try
        {
            using var response = await Http.GetAsync(url, cancellationToken).ConfigureAwait(false);
            if (response.StatusCode != HttpStatusCode.OK)
            {
                return null;
            }

            var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(text))
            {
                return null;
            }

            OnlineHttp.Info($"[lyrics] amll hit source={source} id={id} bytes={text.Length}");
            return text;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            OnlineHttp.Warn($"[lyrics] amll fetch failed source={source} id={id}: {OnlineHttp.Describe(exception)}");
            return null;
        }
    }
}

