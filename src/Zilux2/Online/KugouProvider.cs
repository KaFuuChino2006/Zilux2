using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Zilux2.Online.Account;
using Zilux2.Online.Kugou;
namespace Zilux2.Online;

// 酷狗：搜索/歌词匿名可用；个人歌单、收藏、播放需要登录 token + 注册 dfid。
// 播放走 /v5/url，付费歌曲自动退 60 秒试听（free_part=1）。
internal sealed class KugouProvider : IOnlineMusicProvider
{
    internal const string RefererUrl = "https://www.kugou.com/";
    private const string SearchEndpoint = "https://songsearch.kugou.com/song_search_v2";
    private const string LyricSearchEndpoint = "https://krcs.kugou.com/search";
    private const string LyricDownloadEndpoint = "https://lyrics.kugou.com/download";
    private const string StreamUserAgent = "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi";

    private static readonly TimeSpan SearchTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan LyricTimeout = TimeSpan.FromSeconds(10);

    private readonly AccountService? _accounts;

    public KugouProvider(AccountService? accounts) => _accounts = accounts;

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
            var cover = KugouCover.Normalize(ReadString(item, "Image"));
            if (cover is null && item.TryGetProperty("trans_param", out var transParam))
            {
                cover = KugouCover.Normalize(ReadString(transParam, "union_cover"));
            }

            tracks.Add(new OnlineTrack
            {
                Source = "kugou",
                Id = EncodeId(hash, duration, albumId, mixId),
                Title = ReadString(item, "SongName"),
                Artist = ReadString(item, "SingerName"),
                Album = ReadString(item, "AlbumName"),
                DurationMs = Math.Max(0, seconds) * 1000,
                Playable = true,
                Vip = vip ? true : null,
                Mid = mixId.Length > 0 ? mixId : null,
                CoverKey = cover ?? (albumId.Length > 0 ? albumId : null),
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

    public async Task<List<HotPlaylistItem>> GetHotPlaylistsAsync(int limit, CancellationToken cancellationToken)
    {
        var credentials = Credentials();
        if (credentials is null)
        {
            return [];
        }

        try
        {
            using var client = new KugouClient(credentials.Mid, credentials.Dfid);
            var body = await client
                .GetSpecialRecommendAsync(credentials.UserId, credentials.Token, 1, Math.Clamp(limit, 1, 60), cancellationToken)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (!root.TryGetProperty("status", out var status) || status.ToString() != "1")
            {
                return [];
            }

            var data = root.TryGetProperty("data", out var dataNode) ? dataNode : default;
            if (!data.TryGetProperty("special_list", out var list) || list.ValueKind != JsonValueKind.Array)
            {
                return [];
            }

            var items = new List<HotPlaylistItem>();
            foreach (var item in list.EnumerateArray())
            {
                var gcid = ReadString(item, "global_collection_id");
                var title = ReadString(item, "specialname");
                if (gcid.Length == 0 || title.Length == 0)
                {
                    continue;
                }

                var cover = KugouCover.Normalize(ReadString(item, "imgurl")) ??
                            KugouCover.Normalize(ReadString(item, "flexible_cover")) ??
                            string.Empty;
                var count = ReadLong(item, "collectcount");
                if (count == 0)
                {
                    count = ReadLong(item, "playcount");
                }

                var creator = ReadString(item, "nickname");
                if (creator.Length == 0)
                {
                    creator = ReadString(item, "singername");
                }

                items.Add(new HotPlaylistItem("gcid:" + gcid, title, cover, count, creator));
            }

            OnlineHttp.Info($"GET kugou/hot playlists count={items.Count}");
            return items.Take(limit).ToList();
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            OnlineHttp.Warn($"kugou/hot failed: {OnlineHttp.Describe(exception)}");
            return [];
        }
    }

    public async Task<StreamResolution> ResolveStreamAsync(string id, string? quality, CancellationToken cancellationToken)
    {
        var (hash, _, albumText, mixText) = DecodeId(id);
        if (hash.Length == 0)
        {
            return StreamResolution.NotPlayable("酷狗歌曲 id 非法");
        }

        var credentials = Credentials();
        if (credentials is null)
        {
            return StreamResolution.NotPlayable("请先登录酷狗音乐后再播放");
        }

        long.TryParse(albumText, out var albumId);
        long.TryParse(mixText, out var mixId);
        using var client = new KugouClient(credentials.Mid, credentials.Dfid);
        var qualities = QualityCandidates(quality);
        foreach (var candidateQuality in qualities)
        {
            var full = await TryResolveAsync(client, hash, albumId, mixId, candidateQuality, false, credentials, cancellationToken)
                .ConfigureAwait(false);
            if (full is not null)
            {
                return Playable(full, candidateQuality, trial: false);
            }
        }

        // 付费歌曲只取 60 秒试听；用 128 档就够了，不必把每档都再请求一遍。
        var trial = await TryResolveAsync(client, hash, albumId, mixId, "128", true, credentials, cancellationToken)
            .ConfigureAwait(false);
        if (trial is not null)
        {
            return Playable(trial, "128", trial: true);
        }

        return StreamResolution.NotPlayable("酷狗没有返回播放地址：该歌曲可能需要购买/会员，或当前地区不可用");
    }

    private static async Task<string?> TryResolveAsync(
        KugouClient client,
        string hash,
        long albumId,
        long mixId,
        string quality,
        bool freePart,
        KugouCredentials credentials,
        CancellationToken cancellationToken)
    {
        try
        {
            var body = await client
                .GetStreamUrlAsync(hash, albumId, mixId, quality, freePart, credentials.UserId, credentials.Token, cancellationToken)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (!root.TryGetProperty("status", out var status) || status.ToString() != "1")
            {
                return null;
            }

            var url = ReadUrl(root);
            if (string.IsNullOrWhiteSpace(url))
            {
                return null;
            }

            var trial = freePart || url.Contains("/yp/p_", StringComparison.OrdinalIgnoreCase);
            OnlineHttp.Info($"GET kugou/stream hash={hash[..Math.Min(8, hash.Length)]} quality={quality} trial={trial} ok");
            return url;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            OnlineHttp.Warn($"kugou/stream hash={hash[..Math.Min(8, hash.Length)]} quality={quality} failed: {OnlineHttp.Describe(exception)}");
            return null;
        }
    }

    private static StreamResolution Playable(string url, string quality, bool trial)
    {
        var effectiveQuality = url.Contains("_qu320_", StringComparison.OrdinalIgnoreCase)
            ? "320"
            : url.Contains("_quflac_", StringComparison.OrdinalIgnoreCase) ||
              url.Contains(".flac", StringComparison.OrdinalIgnoreCase)
                ? "flac"
                : "128";
        var format = effectiveQuality == "flac" ? "FLAC" : "MP3";
        var label = trial
            ? "试听 60 秒"
            : effectiveQuality switch
            {
                "flac" => "无损",
                "320" => "高 320k",
                _ => "标准 128k",
            };
        var bitrate = effectiveQuality switch
        {
            "flac" => 900,
            "320" => 320,
            _ => 128,
        };
        return StreamResolution.Playable(
            url,
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["User-Agent"] = StreamUserAgent,
                ["Referer"] = RefererUrl,
            },
            label,
            bitrate,
            format,
            isTrial: trial);
    }

    private static string ReadUrl(JsonElement root)
    {
        if (root.TryGetProperty("url", out var urlNode))
        {
            if (urlNode.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in urlNode.EnumerateArray())
                {
                    if (item.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(item.GetString()))
                    {
                        return item.GetString()!;
                    }
                }
            }
            else if (urlNode.ValueKind == JsonValueKind.String)
            {
                return urlNode.GetString() ?? string.Empty;
            }
        }

        if (root.TryGetProperty("backup_url", out var backup) && backup.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in backup.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(item.GetString()))
                {
                    return item.GetString()!;
                }
            }
        }

        return string.Empty;
    }

    private static IReadOnlyList<string> QualityCandidates(string? quality) => quality?.ToLowerInvariant() switch
    {
        "lossless" => ["flac", "320", "128"],
        "high" => ["320", "128"],
        "320" => ["320", "128"],
        "flac" => ["flac", "320", "128"],
        _ => ["128"],
    };

    private KugouCredentials? Credentials()
    {
        if (_accounts?.IsLoggedIn(AccountSources.Kugou) != true)
        {
            return null;
        }

        var cookies = _accounts.GetCookies(AccountSources.Kugou) ?? [];
        string Find(params string[] names)
        {
            foreach (var name in names)
            {
                var cookie = cookies.LastOrDefault(item => string.Equals(item.Name, name, StringComparison.OrdinalIgnoreCase));
                if (cookie is not null && !string.IsNullOrWhiteSpace(cookie.Value))
                {
                    return cookie.Value;
                }
            }

            return string.Empty;
        }

        var userId = Find("userid", "KugooID");
        var token = Find("token", "t");
        if (userId.Length == 0 || token.Length == 0)
        {
            return null;
        }

        var mid = Find("mid", "kg_mid");
        if (mid.Length == 0)
        {
            mid = KugouDevice.Current.Mid;
        }

        var dfid = KugouDevice.ResolveDfid(Find("dfid", "kg_dfid"));
        return new KugouCredentials(userId, token, mid, dfid);
    }

    private sealed record KugouCredentials(string UserId, string Token, string Mid, string Dfid);

    private static string ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var node) && node.ValueKind == JsonValueKind.String
            ? node.GetString() ?? string.Empty
            : string.Empty;

    private static long ReadLong(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var node))
        {
            return 0;
        }

        return node.ValueKind switch
        {
            JsonValueKind.Number => node.TryGetInt64(out var value) ? value : 0,
            JsonValueKind.String => long.TryParse(node.GetString(), System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : 0,
            _ => 0,
        };
    }
}

