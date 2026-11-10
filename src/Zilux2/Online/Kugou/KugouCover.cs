namespace Zilux2.Online.Kugou;

// 酷狗封面：上游搜索/歌单详情直接给完整图床地址（imge.kugou.com / singerimg.kugou.com /
// c1.kgimg.com），其中宽度是 `{size}` 占位符。以前只拿 AlbumID 拼 240 图，很多专辑没有对应
// 的 stdmusic/{albumid}.jpg，会返回酷狗默认图（喜欢墙上一片黑胶）。
internal static class KugouCover
{
    public const int DefaultSize = 400;

    public static string? Normalize(string? url, int size = DefaultSize)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return null;
        }

        var value = url.Trim().Replace("{size}", size.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);
        if (value.StartsWith("//", StringComparison.Ordinal))
        {
            value = "https:" + value;
        }
        else if (value.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
        {
            value = "https://" + value[7..];
        }

        return IsAllowedHost(value) ? value : null;
    }

    public static bool IsAllowedHost(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var host = uri.Host;
        return host.Equals("imge.kugou.com", StringComparison.OrdinalIgnoreCase) ||
               host.Equals("singerimg.kugou.com", StringComparison.OrdinalIgnoreCase) ||
               host.Equals("img.kugou.com", StringComparison.OrdinalIgnoreCase) ||
               host.Equals("cover.kugou.com", StringComparison.OrdinalIgnoreCase) ||
               host.Equals("kgimg.com", StringComparison.OrdinalIgnoreCase) ||
               host.EndsWith(".kgimg.com", StringComparison.OrdinalIgnoreCase);
    }

    // 歌词页大图请求：把 240/400 的路径换成 800，避免 4K 屏上糊成一片。
    public static string UpgradeSize(string url)
    {
        foreach (var size in new[] { "240", "400" })
        {
            var marker = "/" + size + "/";
            if (url.Contains(marker, StringComparison.Ordinal))
            {
                return url.Replace(marker, "/800/", StringComparison.Ordinal);
            }
        }

        return url;
    }
}
