using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
namespace Zilux2.Online;

// 酷狗只作为「歌词来源」使用（不参与播放 / 登录 / 收藏）：
//   搜索 + 歌词都走公开接口，匿名可用；
//   歌词优先取 KRC（逐字，自行解密），失败再退 LRC。
internal sealed class KugouProvider : IOnlineMusicProvider
{
    internal const string RefererUrl = "https://www.kugou.com/";
    private const string SearchEndpoint = "https://songsearch.kugou.com/song_search_v2";
    private const string LyricSearchEndpoint = "https://krcs.kugou.com/search";
    private const string LyricDownloadEndpoint = "https://lyrics.kugou.com/download";

    private static readonly TimeSpan SearchTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan LyricTimeout = TimeSpan.FromSeconds(10);

    public string Name => "kugou";

    // 曲目 id 编码成「hash|时长秒|专辑数字id|MixSongID」，因为酷狗的歌词/播放接口需要这几项一起传。
    private static string EncodeId(string hash, string durationSeconds, string albumId, string mixId) =>
        $"{hash}|{durationSeconds}|{albumId}|{mixId}";

    private static (string Hash, string DurationSeconds, string AlbumId, string MixId) DecodeId(string id)
    {
        var parts = id.Split('|');
        return parts.Length >= 4
            ? (parts[0], parts[1], parts[2], parts[3])
            : (id, string.Empty, string.Empty, string.Empty);
    }

    public async Task<List<OnlineTrack>> SearchAsync(string query, int limit, CancellationToken cancellationToken)
    {
        var size = Math.Clamp(limit, 1, 20);
        var url = $"{SearchEndpoint}?format=json&keyword={Uri.EscapeDataString(query)}&page=1&pagesize={size}" +
                  "&platform=WebFilter&userid=0&clientver=2000&iscorrection=1&privilege_filter=0&filter=10&srcappid=2919";
        var upstream = await OnlineHttp
            .FetchTextAsync(url, RefererUrl, SearchTimeout, cancellationToken)
            .ConfigureAwait(false);

        using var document = JsonDocument.Parse(upstream.Body);
        var tracks = ParseSearch(document.RootElement);
        OnlineHttp.Info($"GET kugou/search q={query} ok {tracks.Count} tracks {upstream.TookMs}ms");
        return tracks;
    }

    private static List<OnlineTrack> ParseSearch(JsonElement root)
    {
        var tracks = new List<OnlineTrack>();
        if (!root.TryGetProperty("data", out var data) || !data.TryGetProperty("lists", out var lists) ||
            lists.ValueKind != JsonValueKind.Array)
        {
            return tracks;
        }

        foreach (var item in lists.EnumerateArray())
        {
            var hash = ReadString(item, "FileHash");
            if (hash.Length == 0)
            {
                continue;
            }

            var duration = ReadString(item, "Duration");
            var albumId = ReadString(item, "AlbumID");
            var mixId = ReadString(item, "MixSongID");
            long.TryParse(duration, out var seconds);
            var payType = ReadString(item, "PayType");
            var privilege = ReadString(item, "Privilege");
            var vip = !payType.Equals("0", StringComparison.Ordinal) &&
                      !privilege.Equals("10", StringComparison.Ordinal);

            tracks.Add(new OnlineTrack
            {
                Source = "kugou",
                Id = EncodeId(hash, duration, albumId, mixId),
                Title = ReadString(item, "SongName"),
                Artist = ReadString(item, "SingerName"),
                Album = ReadString(item, "AlbumName"),
                DurationMs = Math.Max(0, seconds) * 1000,
                Playable = false,
                Vip = vip ? true : null,
                Mid = mixId.Length > 0 ? mixId : null,
                CoverKey = albumId.Length > 0 ? albumId : null,
            });
        }

        return tracks;
    }

    public async Task<LyricData> GetLyricAsync(string id, CancellationToken cancellationToken)
    {
        var (hash, duration, _, _) = DecodeId(id);
        if (hash.Length == 0)
        {
            return new LyricData();
        }

        var searchUrl = $"{LyricSearchEndpoint}?ver=1&man=yes&client=mobi&keyword=&duration={duration}&hash={hash}";
        var search = await OnlineHttp
            .FetchTextAsync(searchUrl, RefererUrl, LyricTimeout, cancellationToken)
            .ConfigureAwait(false);

        using var searchDocument = JsonDocument.Parse(search.Body);
        if (!searchDocument.RootElement.TryGetProperty("candidates", out var candidates) ||
            candidates.ValueKind != JsonValueKind.Array)
        {
            OnlineHttp.Info($"GET kugou/lyric id={hash} no candidates {search.TookMs}ms");
            return new LyricData();
        }

        var lrc = string.Empty;
        var wordLyric = string.Empty;
        foreach (var candidate in candidates.EnumerateArray())
        {
            var lyricId = ReadString(candidate, "id");
            var accessKey = ReadString(candidate, "accesskey");
            if (lyricId.Length == 0 || accessKey.Length == 0)
            {
                continue;
            }

            if (wordLyric.Length == 0)
            {
                wordLyric = await TryFetchKrcAsync(lyricId, accessKey, cancellationToken).ConfigureAwait(false);
            }

            if (lrc.Length == 0)
            {
                lrc = await TryFetchLrcAsync(lyricId, accessKey, cancellationToken).ConfigureAwait(false);
            }

            if (wordLyric.Length > 0 && (lrc.Length > 0 || wordLyric.Length > 0))
            {
                break;
            }
        }

        if (wordLyric.Length == 0 && lrc.Length == 0)
        {
            return new LyricData();
        }

        if (lrc.Length == 0)
        {
            lrc = wordLyric;
        }

        OnlineHttp.Info($"GET kugou/lyric id={hash} ok lrcChars={lrc.Length} krcChars={wordLyric.Length}");
        return new LyricData
        {
            Lrc = lrc,
            Yrc = wordLyric.Length > 0 ? wordLyric : null,
        };
    }

    // KRC 下载：base64 → 跳过 4 字节头 → 与 16 字节密钥循环 XOR → zlib 解压 → UTF8 明文
    private async Task<string> TryFetchKrcAsync(string lyricId, string accessKey, CancellationToken cancellationToken)
    {
        try
        {
            var url = $"{LyricDownloadEndpoint}?ver=1&client=android&id={lyricId}&accesskey={Uri.EscapeDataString(accessKey)}&fmt=krc&charset=utf8";
            var download = await OnlineHttp
                .FetchTextAsync(url, RefererUrl, LyricTimeout, cancellationToken)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(download.Body);
            var encoded = ReadString(document.RootElement, "content");
            if (encoded.Length == 0)
            {
                return string.Empty;
            }

            var bytes = Convert.FromBase64String(encoded);
            if (!TryDecodeKrc(bytes, out var text) || text.Length == 0)
            {
                return string.Empty;
            }

            return ConvertKrcToCharLyric(text);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            OnlineHttp.Warn($"kugou/lyric krc failed: {OnlineHttp.Describe(exception)}");
            return string.Empty;
        }
    }

    private async Task<string> TryFetchLrcAsync(string lyricId, string accessKey, CancellationToken cancellationToken)
    {
        try
        {
            var url = $"{LyricDownloadEndpoint}?ver=1&client=pc&id={lyricId}&accesskey={Uri.EscapeDataString(accessKey)}&fmt=lrc&charset=utf8";
            var download = await OnlineHttp
                .FetchTextAsync(url, RefererUrl, LyricTimeout, cancellationToken)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(download.Body);
            var encoded = ReadString(document.RootElement, "content");
            if (encoded.Length == 0)
            {
                return string.Empty;
            }

            var lrc = Encoding.UTF8.GetString(Convert.FromBase64String(encoded)).TrimStart('\uFEFF');
            return lrc.Contains('[', StringComparison.Ordinal) ? lrc : string.Empty;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            return string.Empty;
        }
    }

    private static bool TryDecodeKrc(byte[] bytes, out string text)
    {
        text = string.Empty;
        if (bytes.Length < 8)
        {
            return false;
        }

        // 前 4 字节是 "krc1"/"krc18" 之类的文件头
        var key = new byte[] { 64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105 };
        var payload = new byte[bytes.Length - 4];
        Buffer.BlockCopy(bytes, 4, payload, 0, payload.Length);
        for (var index = 0; index < payload.Length; index += 1)
        {
            payload[index] ^= key[index % key.Length];
        }

        try
        {
            using var input = new MemoryStream(payload);
            using var deflate = new System.IO.Compression.ZLibStream(input, System.IO.Compression.CompressionMode.Decompress);
            using var output = new MemoryStream();
            deflate.CopyTo(output);
            text = Encoding.UTF8.GetString(output.ToArray()).TrimStart('\uFEFF');
            return text.Length > 0;
        }
        catch (Exception)
        {
            return false;
        }
    }

    // KRC 正文：`[行开始,行时长]<词偏移,词时长>词…`；转成和网易云 yrc 同样的
    // `[行开始,行时长](词绝对开始,词时长)词…`，前端沿用 parseCharLyric 就能逐字点亮。
    private static string ConvertKrcToCharLyric(string krc)
    {
        var lineHead = new System.Text.RegularExpressions.Regex(@"^\[(\d+),(\d+)\](.*)$");
        var wordTag = new System.Text.RegularExpressions.Regex(@"<(\d+),(\d+)(?:,\d+)?>([^<]*)");
        var builder = new StringBuilder();
        foreach (var rawLine in krc.Split('\n'))
        {
            var line = rawLine.Trim();
            var head = lineHead.Match(line);
            if (!head.Success)
            {
                continue;
            }

            var lineStart = long.Parse(head.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
            var lineDuration = long.Parse(head.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture);
            var body = head.Groups[3].Value;
            var words = new StringBuilder();
            foreach (System.Text.RegularExpressions.Match match in wordTag.Matches(body))
            {
                var offset = long.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
                var duration = long.Parse(match.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture);
                var word = match.Groups[3].Value;
                if (word.Length == 0)
                {
                    continue;
                }

                words.Append('(').Append(lineStart + offset).Append(',').Append(duration).Append(')').Append(word);
            }

            if (words.Length == 0)
            {
                continue;
            }

            builder.Append('[').Append(lineStart).Append(',').Append(lineDuration).Append(']')
                .Append(words).Append('\n');
        }

        return builder.ToString();
    }

    public Task<StreamResolution> ResolveStreamAsync(string id, string? quality, CancellationToken cancellationToken) =>
        Task.FromResult(StreamResolution.NotPlayable("酷狗仅用于歌词搜索，不提供播放"));

    private static string ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var node) && node.ValueKind == JsonValueKind.String
            ? node.GetString() ?? string.Empty
            : string.Empty;
}
