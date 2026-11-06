using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Zilux2.Online;
using Zilux2.Online.Account;

namespace Zilux2.Online.Qq;

/// <summary>匿名 128k 兜底取到的一首可播放曲目。</summary>
internal sealed record QqNativeStream(string Url, string QualityLabel, int Bitrate, string Format);

/// <summary>原生 LRC + 翻译轨；trans 可能为空。</summary>
internal sealed record QqNativeLyric(string Lrc, string? Translation);

/// <summary>musicu 搜索结果中的一首歌；字段与 web new_json 同形。</summary>
internal sealed record QqNativeSong(
    string Mid,
    string Title,
    string Artist,
    string Album,
    string AlbumMid,
    int PayPlay,
    long IntervalSeconds);

/// <summary>musicu 歌单广场/推荐流的卡片。</summary>
internal sealed record QqNativePlaylist(string Id, string Title, string Cover, long PlayCount, string Creator);

// QQ 音乐原生接口（research/qqmusic-api.md §2-§4）。
//
// 取流走 QQ 音乐客户端实际使用的 u6.y.qq.com/cgi-bin/musics.fcg + zzc 签名，再用 web 版
// CgiGetVkey 一次拿回 sip + purl；歌词走 musicu.fcg 的 PlayLyricInfo（lyric/trans 均为 base64）。
//
// 约束：
//  - 完全匿名：uin 固定 "0"，不读账号、不带 cookie、不伪造客户端登录态；
//  - 只请求匿名有权益的 128k 码率（M500 mp3 / C400 m4a），不碰 320k、无损、DRM；
//  - 失败分三类：Ok / Unavailable（上游正常但无权益、无歌词）/ Failed（超时、网络、解析），
//    Failed 才计入 provider 熔断；任何失败都不向上抛。
internal sealed class QqNativeClient
{
    private const string ProviderName = "qq";
    private const string Endpoint = "https://u6.y.qq.com/cgi-bin/musics.fcg";
    private const string LyricEndpoint = "https://u.y.qq.com/cgi-bin/musicu.fcg";
    private const string RefererUrl = "https://y.qq.com/";
    private const string Tag = "qq/native";
    private const string LyricTag = "qq/native lyric";
    private const string SearchTag = "qq/native search";
    private const string PlaylistTag = "qq/native playlists";
    private const string BrowseTag = "qq/native browse";

    private static readonly TimeSpan Timeout = NativeFirstPolicy.Timeout;

    // 匿名候选：M500=128k mp3、C400=128k m4a。登录后按 quality 追加 320k（M800）与无损（F000）；
    // 上游对无权益的档位返回空 purl 或加密后缀，调用方自动降档。
    private static readonly (string Prefix, string Extension)[] AnonymousCandidates =
    [
        ("M500", "mp3"),
        ("C400", "m4a"),
    ];

    private readonly AccountService? _accounts;

    internal QqNativeClient(AccountService? accounts = null) => _accounts = accounts;

    private bool HasLogin => _accounts is not null && _accounts.IsLoggedIn(ProviderName);

    private string Uin => _accounts?.GetUserId(ProviderName) ?? "0";

    private string VkeyCookie => _accounts?.CookieHeader(ProviderName, "u.y.qq.com") ?? string.Empty;

    // android comm 的 authst 要 qm_keyst / qqmusic_key；两者在不同登录版本里出现。
    private string AuthKey =>
        ReadCookieValue(VkeyCookie, "qqmusic_key") ?? ReadCookieValue(VkeyCookie, "qm_keyst") ?? string.Empty;

    // 与 QqProvider 相同：任意稳定数字串即可；服务端用 guid 做设备/频控标记。
    // 实测 "1234567890" 这类常见示例值会被判 invalidq（retcode=104009、sip 为空），随机 10 位数字正常。
    private readonly string _guid = Random.Shared.Next(1000000000, 2000000000).ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// 取可播放地址。匿名只到 128k；登录态按 quality 依次尝试 F000(flac)→M800(320k)→M500/C400，
    /// 加密后缀（.mflac/.mgg/.mmp4）视为无权益并降档。
    /// </summary>
    internal async Task<NativeResult<QqNativeStream>> GetSongUrlAsync(
        string songmid,
        string quality,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(songmid))
        {
            return NativeResult<QqNativeStream>.Unavailable();
        }

        var failed = false;
        foreach (var (prefix, extension, label, bitrate) in Candidates(quality))
        {
            var (outcome, resolved) = await RequestAsync(songmid, prefix, extension, quality, cancellationToken)
                .ConfigureAwait(false);
            if (resolved is not null)
            {
                return NativeResult<QqNativeStream>.Ok(
                    new QqNativeStream(resolved.Url, label, bitrate, resolved.Format));
            }

            failed |= outcome == NativeCallOutcome.Failed;
        }

        return failed
            ? NativeResult<QqNativeStream>.Failed()
            : NativeResult<QqNativeStream>.Unavailable();
    }

    private IEnumerable<(string Prefix, string Extension, string Label, int Bitrate)> Candidates(string quality)
    {
        if (!HasLogin || AuthKey.Length == 0)
        {
            foreach (var (prefix, extension) in AnonymousCandidates)
            {
                yield return (prefix, extension, "128K", 128000);
            }

            yield break;
        }

        switch ((quality ?? string.Empty).Trim().ToLowerInvariant())
        {
            case "lossless":
                yield return ("F000", "flac", "无损", 999000);
                yield return ("M800", "mp3", "320K", 320000);
                yield return ("M500", "mp3", "128K", 128000);
                yield return ("C400", "m4a", "128K", 128000);
                break;
            case "standard":
                yield return ("M500", "mp3", "128K", 128000);
                yield return ("C400", "m4a", "128K", 128000);
                break;
            default:
                yield return ("M800", "mp3", "320K", 320000);
                yield return ("M500", "mp3", "128K", 128000);
                yield return ("C400", "m4a", "128K", 128000);
                break;
        }
    }

    private static string? ReadCookieValue(string header, string name)
    {
        if (string.IsNullOrEmpty(header))
        {
            return null;
        }

        foreach (var part in header.Split(';'))
        {
            var trimmed = part.Trim();
            var index = trimmed.IndexOf('=');
            if (index <= 0)
            {
                continue;
            }

            if (trimmed.AsSpan(0, index).Trim().Equals(name, StringComparison.OrdinalIgnoreCase))
            {
                return trimmed[(index + 1)..];
            }
        }

        return null;
    }

    /// <summary>
    /// 取原生 LRC + 翻译轨（musicu GetPlayLyricInfo，format=lrc）。无歌词返回 Unavailable；
    /// QRC 加密歌词仍由 provider 的既有逻辑单独获取。
    /// </summary>
    internal async Task<NativeResult<QqNativeLyric>> GetLyricAsync(
        string songmid,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(songmid))
        {
            return NativeResult<QqNativeLyric>.Unavailable();
        }

        var tag = $"{LyricTag} mid={songmid}";
        try
        {
            var body = BuildLyricBody(songmid).ToJsonString();
            var upstream = await OnlineHttp.FetchTextAsync(
                    LyricEndpoint,
                    RefererUrl,
                    Timeout,
                    cancellationToken,
                    HttpMethod.Post,
                    body)
                .ConfigureAwait(false);

            using var document = JsonDocument.Parse(upstream.Body);
            if (!document.RootElement.TryGetProperty("req", out var request) ||
                !request.TryGetProperty("data", out var data) ||
                data.ValueKind != JsonValueKind.Object)
            {
                OnlineHttp.Warn($"{tag} no data {upstream.TookMs}ms");
                return NativeResult<QqNativeLyric>.Failed();
            }

            var lrc = DecodeBase64Text(ReadString(data, "lyric"));
            if (lrc.Length == 0)
            {
                OnlineHttp.Info($"{tag} no lyric {upstream.TookMs}ms");
                return NativeResult<QqNativeLyric>.Unavailable();
            }

            var translation = DecodeBase64Text(ReadString(data, "trans"));
            OnlineHttp.Info(
                $"{tag} lrcChars={lrc.Length} transChars={translation.Length} ok {upstream.TookMs}ms");
            return NativeResult<QqNativeLyric>.Ok(
                new QqNativeLyric(lrc, translation.Length == 0 ? null : translation));
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"{tag} failed: {OnlineHttp.Describe(exception)}");
            return NativeResult<QqNativeLyric>.Failed();
        }
    }

    /// <summary>
    /// 搜索（musicu SearchCgiService.DoSearchForQQMusicDesktop）。comm 必须用桌面形态
    /// ct=11/cv="1003006"，用 web 的 ct=24/cv=0 会返回空列表。
    /// </summary>
    internal async Task<NativeResult<List<QqNativeSong>>> SearchAsync(
        string query,
        int limit,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            return NativeResult<List<QqNativeSong>>.Unavailable();
        }

        var tag = $"{SearchTag} q={query} limit={limit}";
        try
        {
            var body = BuildSearchBody(query, limit).ToJsonString();
            var url = $"{Endpoint}?sign={QqApiSigner.Sign(body)}&_={DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)}";
            var upstream = await OnlineHttp.FetchTextAsync(
                    url,
                    RefererUrl,
                    Timeout,
                    cancellationToken,
                    HttpMethod.Post,
                    body)
                .ConfigureAwait(false);

            using var document = JsonDocument.Parse(upstream.Body);
            if (!document.RootElement.TryGetProperty("req", out var request) ||
                request.ValueKind != JsonValueKind.Object ||
                !request.TryGetProperty("data", out var data) ||
                data.ValueKind != JsonValueKind.Object ||
                !data.TryGetProperty("body", out var bodyElement) ||
                bodyElement.ValueKind != JsonValueKind.Object ||
                !bodyElement.TryGetProperty("song", out var song) ||
                song.ValueKind != JsonValueKind.Object ||
                !song.TryGetProperty("list", out var list) ||
                list.ValueKind != JsonValueKind.Array)
            {
                OnlineHttp.Warn($"{tag} no data {upstream.TookMs}ms");
                return NativeResult<List<QqNativeSong>>.Failed();
            }

            var songs = new List<QqNativeSong>();
            foreach (var item in list.EnumerateArray())
            {
                var mid = FirstNonEmpty(ReadString(item, "mid"), ReadString(item, "songmid"));
                if (mid.Length == 0)
                {
                    continue;
                }

                var artists = new List<string>();
                if (item.TryGetProperty("singer", out var singers) && singers.ValueKind == JsonValueKind.Array)
                {
                    foreach (var singer in singers.EnumerateArray())
                    {
                        var name = ReadString(singer, "name");
                        if (name.Length > 0)
                        {
                            artists.Add(name);
                        }
                    }
                }

                var album = string.Empty;
                var albumMid = string.Empty;
                if (item.TryGetProperty("album", out var albumElement) && albumElement.ValueKind == JsonValueKind.Object)
                {
                    album = ReadString(albumElement, "name");
                    albumMid = ReadString(albumElement, "mid");
                }

                album = FirstNonEmpty(album, ReadString(item, "albumname"));
                albumMid = FirstNonEmpty(albumMid, ReadString(item, "albummid"));

                var payPlay = 1;
                if (item.TryGetProperty("pay", out var pay) && pay.ValueKind == JsonValueKind.Object)
                {
                    if (TryReadInt(pay, "pay_play", out var payPlayValue) || TryReadInt(pay, "payplay", out payPlayValue))
                    {
                        payPlay = payPlayValue;
                    }
                }
                else if (TryReadInt(item, "payplay", out var legacyPayPlay))
                {
                    payPlay = legacyPayPlay;
                }

                var interval = item.TryGetProperty("interval", out var intervalElement) && intervalElement.TryGetInt64(out var seconds)
                    ? seconds
                    : 0;
                songs.Add(new QqNativeSong(
                    mid,
                    FirstNonEmpty(ReadString(item, "name"), ReadString(item, "songname")),
                    string.Join(" / ", artists),
                    album,
                    albumMid,
                    payPlay,
                    interval));
            }

            if (songs.Count == 0)
            {
                OnlineHttp.Info($"{tag} empty {upstream.TookMs}ms");
                return NativeResult<List<QqNativeSong>>.Unavailable();
            }

            OnlineHttp.Info($"{tag} count={songs.Count} ok {upstream.TookMs}ms");
            return NativeResult<List<QqNativeSong>>.Ok(songs);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"{tag} failed: {OnlineHttp.Describe(exception)}");
            return NativeResult<List<QqNativeSong>>.Failed();
        }
    }

    /// <summary>
    /// 歌单广场/推荐流（PlaylistSquare.GetRecommendFeed）。web 版 fcg_get_diss_by_tag 是
    /// 另一套「热门歌单」，两者都能喂 HotPlaylistItem；原生优先、无结果再由 provider 走 web。
    /// </summary>
    internal async Task<NativeResult<List<QqNativePlaylist>>> GetRecommendPlaylistsAsync(
        int offset,
        int limit,
        CancellationToken cancellationToken = default)
    {
        var tag = $"{PlaylistTag} offset={offset} limit={limit}";
        try
        {
            var body = BuildRecommendPlaylistsBody(offset, limit).ToJsonString();
            var url = $"{Endpoint}?sign={QqApiSigner.Sign(body)}&_={DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)}";
            var upstream = await OnlineHttp.FetchTextAsync(
                    url,
                    RefererUrl,
                    Timeout,
                    cancellationToken,
                    HttpMethod.Post,
                    body)
                .ConfigureAwait(false);

            using var document = JsonDocument.Parse(upstream.Body);
            if (!document.RootElement.TryGetProperty("req", out var request) ||
                request.ValueKind != JsonValueKind.Object ||
                !request.TryGetProperty("data", out var data) ||
                data.ValueKind != JsonValueKind.Object ||
                !data.TryGetProperty("List", out var list) ||
                list.ValueKind != JsonValueKind.Array)
            {
                OnlineHttp.Warn($"{tag} no data {upstream.TookMs}ms");
                return NativeResult<List<QqNativePlaylist>>.Failed();
            }

            var playlists = new List<QqNativePlaylist>();
            foreach (var entry in list.EnumerateArray())
            {
                if (!entry.TryGetProperty("Playlist", out var playlist) ||
                    playlist.ValueKind != JsonValueKind.Object ||
                    !playlist.TryGetProperty("basic", out var basic) ||
                    basic.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var id = ReadId(basic, "tid");
                var title = ReadString(basic, "title");
                if (id.Length == 0 || title.Length == 0)
                {
                    continue;
                }

                var cover = string.Empty;
                if (basic.TryGetProperty("cover", out var coverElement) && coverElement.ValueKind == JsonValueKind.Object)
                {
                    cover = FirstNonEmpty(ReadString(coverElement, "medium_url"), ReadString(coverElement, "small_url"));
                }

                var creator = string.Empty;
                if (basic.TryGetProperty("creator", out var creatorElement) && creatorElement.ValueKind == JsonValueKind.Object)
                {
                    creator = ReadString(creatorElement, "nick");
                }

                var playCount = basic.TryGetProperty("play_cnt", out var playCountElement) && playCountElement.TryGetInt64(out var count)
                    ? count
                    : 0;
                playlists.Add(new QqNativePlaylist(id, title, cover, playCount, creator));
            }

            if (playlists.Count == 0)
            {
                OnlineHttp.Info($"{tag} empty {upstream.TookMs}ms");
                return NativeResult<List<QqNativePlaylist>>.Unavailable();
            }

            OnlineHttp.Info($"{tag} count={playlists.Count} ok {upstream.TookMs}ms");
            return NativeResult<List<QqNativePlaylist>>.Ok(playlists);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"{tag} failed: {OnlineHttp.Describe(exception)}");
            return NativeResult<List<QqNativePlaylist>>.Failed();
        }
    }

    // ── 浏览类模块（歌手 / 专辑 / 评论 / 歌曲详情）────────────────────────────────

    /// <summary>
    /// 歌手页头部 + 歌曲 + 专辑，一次 musicu 多请求拿回（req / req_0 / req_1）。
    /// 匿名可用；上游不返回歌手简介，调用方按空简介处理。
    /// </summary>
    internal Task<NativeResult<string>> GetArtistJsonAsync(
        string singerMid,
        int songLimit,
        int albumLimit,
        CancellationToken cancellationToken = default)
    {
        var body = new JsonObject
        {
            ["comm"] = WebComm(),
            ["req"] = Module(
                "music.UnifiedHomepage.UnifiedHomepageSrv",
                "GetHomepageHeader",
                new JsonObject { ["SingerMid"] = singerMid }),
            ["req_0"] = Module(
                "musichall.song_list_server",
                "GetSingerSongList",
                new JsonObject
                {
                    ["singerMid"] = singerMid,
                    ["begin"] = 0,
                    ["num"] = Math.Clamp(songLimit, 1, 100),
                    ["order"] = 0,
                }),
            ["req_1"] = Module(
                "music.musichallAlbum.AlbumListServer",
                "GetAlbumList",
                new JsonObject
                {
                    ["singerMid"] = singerMid,
                    ["begin"] = 0,
                    ["num"] = Math.Clamp(albumLimit, 1, 100),
                }),
        };
        return CallMusicuAsync(body, $"{BrowseTag} artist mid={singerMid}", cancellationToken);
    }

    /// <summary>专辑曲目（GetAlbumSongList）。上游不返回专辑标题/艺人，调用方从首曲派生。</summary>
    internal Task<NativeResult<string>> GetAlbumSongsJsonAsync(
        string albumMid,
        int begin,
        int num,
        CancellationToken cancellationToken = default)
    {
        var body = new JsonObject
        {
            ["comm"] = WebComm(),
            ["req"] = Module(
                "music.musichallAlbum.AlbumSongList",
                "GetAlbumSongList",
                new JsonObject
                {
                    ["albumMid"] = albumMid,
                    ["begin"] = Math.Max(0, begin),
                    ["num"] = Math.Clamp(num, 1, 200),
                }),
        };
        return CallMusicuAsync(body, $"{BrowseTag} album mid={albumMid} begin={begin} num={num}", cancellationToken);
    }

    /// <summary>歌曲详情（get_song_detail_yqq）；参数名必须是小写 song_mid。</summary>
    internal Task<NativeResult<string>> GetSongDetailJsonAsync(
        string songmid,
        CancellationToken cancellationToken = default)
    {
        var body = new JsonObject
        {
            ["comm"] = WebComm(),
            ["req"] = Module(
                "music.pf_song_detail_svr",
                "get_song_detail_yqq",
                new JsonObject { ["song_mid"] = songmid }),
        };
        return CallMusicuAsync(body, $"{BrowseTag} song mid={songmid}", cancellationToken);
    }

    /// <summary>
    /// 歌曲评论（GetNewCommentList）。匿名可用；热评接口匿名只回总数，因此只用新评论分页。
    /// </summary>
    internal Task<NativeResult<string>> GetCommentsJsonAsync(
        long songId,
        int pageNum,
        int pageSize,
        CancellationToken cancellationToken = default)
    {
        var body = new JsonObject
        {
            ["comm"] = WebComm(),
            ["req"] = Module(
                "music.globalComment.CommentRead",
                "GetNewCommentList",
                new JsonObject
                {
                    ["BizType"] = 1,
                    ["BizId"] = songId.ToString(CultureInfo.InvariantCulture),
                    ["PageNum"] = Math.Max(0, pageNum),
                    ["PageSize"] = Math.Clamp(pageSize, 1, 50),
                    ["ScoreType"] = 0,
                    ["LastCommentId"] = string.Empty,
                }),
        };
        return CallMusicuAsync(body, $"{BrowseTag} comments song={songId} page={pageNum}", cancellationToken);
    }

    /// <summary>专辑元数据（GetAlbumDetail）：albumMid 与数字 albumID 都接受。</summary>
    internal Task<NativeResult<string>> GetAlbumDetailJsonAsync(
        string albumIdOrMid,
        CancellationToken cancellationToken = default)
    {
        var param = new JsonObject();
        if (long.TryParse(albumIdOrMid, NumberStyles.Integer, CultureInfo.InvariantCulture, out var numericAlbumId))
        {
            param["albumID"] = numericAlbumId;
        }
        else
        {
            param["albumMid"] = albumIdOrMid;
        }

        var body = new JsonObject
        {
            ["comm"] = WebComm(),
            ["req"] = Module(
                "music.musichallAlbum.AlbumInfoServer",
                "GetAlbumDetail",
                param),
        };
        return CallMusicuAsync(body, $"{BrowseTag} album-detail id={albumIdOrMid}", cancellationToken);
    }

    /// <summary>登录态收藏的专辑（GetAlbumFavList）：v_albumId 是数字专辑 id。</summary>
    internal Task<NativeResult<string>> GetAlbumFavoritesJsonAsync(
        int offset,
        int limit,
        CancellationToken cancellationToken = default)
    {
        var body = new JsonObject
        {
            ["comm"] = Comm(),
            ["req"] = Module(
                "music.musicasset.AlbumFavRead",
                "GetAlbumFavList",
                new JsonObject
                {
                    ["uin"] = Uin,
                    ["offset"] = Math.Max(0, offset),
                    ["limit"] = Math.Clamp(limit, 1, 100),
                }),
        };
        return CallMusicuAsync(body, $"{BrowseTag} album-fav offset={offset} limit={limit}", cancellationToken);
    }

    /// <summary>登录态收藏的歌手：上游多个模块已下线，失败由调用方按空列表处理。</summary>
    internal Task<NativeResult<string>> GetArtistFavoritesJsonAsync(
        int offset,
        int limit,
        CancellationToken cancellationToken = default)
    {
        var body = new JsonObject
        {
            ["comm"] = Comm(),
            ["req"] = Module(
                "music.musicasset.ArtistFavRead",
                "GetArtistFavList",
                new JsonObject
                {
                    ["uin"] = Uin,
                    ["offset"] = Math.Max(0, offset),
                    ["limit"] = Math.Clamp(limit, 1, 100),
                }),
        };
        return CallMusicuAsync(body, $"{BrowseTag} artist-fav offset={offset} limit={limit}", cancellationToken);
    }

    /// <summary>
    /// 取 QMC2 加密档的 ekey（GetEVkey）。filename 必须带 .mgg/.mflac 扩展名，
    /// songtype 固定 1；匿名或未登录时直接返回 Unavailable。
    /// </summary>
    internal async Task<NativeResult<string>> GetEkeyAsync(
        string filename,
        string songMid,
        CancellationToken cancellationToken = default)
    {
        if (!HasLogin || AuthKey.Length == 0)
        {
            return NativeResult<string>.Unavailable();
        }

        var body = new JsonObject
        {
            ["comm"] = Comm(),
            ["req_1"] = Module(
                "music.vkey.GetEVkey",
                "CgiGetEVkey",
                new JsonObject
                {
                    ["filename"] = new JsonArray(filename),
                    ["guid"] = "10000",
                    ["songmid"] = new JsonArray(songMid),
                    ["songtype"] = new JsonArray(1),
                    ["uin"] = Uin,
                    ["loginflag"] = 1,
                    ["platform"] = "20",
                    ["ctx"] = 1,
                }),
        };

        try
        {
            var upstream = await OnlineHttp.FetchTextAsync(
                    LyricEndpoint,
                    RefererUrl,
                    Timeout,
                    cancellationToken,
                    HttpMethod.Post,
                    body.ToJsonString(),
                    cookie: VkeyCookie)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(upstream.Body);
            var root = document.RootElement;
            if (!root.TryGetProperty("req_1", out var request) ||
                !request.TryGetProperty("data", out var data) ||
                !data.TryGetProperty("midurlinfo", out var infos) ||
                infos.ValueKind != JsonValueKind.Array)
            {
                OnlineHttp.Info($"qq.native ekey none mid={songMid} {upstream.TookMs}ms");
                return NativeResult<string>.Unavailable();
            }

            foreach (var info in infos.EnumerateArray())
            {
                var ekey = ReadString(info, "ekey");
                var result = info.TryGetProperty("result", out var resultElement) &&
                             resultElement.TryGetInt32(out var resultValue)
                    ? resultValue
                    : 0;
                if (result == 0 && !string.IsNullOrWhiteSpace(ekey))
                {
                    OnlineHttp.Info(
                        $"qq.native ekey ok mid={songMid} file={filename} chars={ekey.Length} {upstream.TookMs}ms");
                    return NativeResult<string>.Ok(ekey);
                }

                OnlineHttp.Info($"qq.native ekey none mid={songMid} result={result} {upstream.TookMs}ms");
                return NativeResult<string>.Unavailable();
            }

            return NativeResult<string>.Unavailable();
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"qq.native ekey fail mid={songMid}: {OnlineHttp.Describe(exception)}");
            return NativeResult<string>.Failed();
        }
    }

    /// <summary>
    /// 加密档取流：filename 带 .mgg/.mflac、songtype=1，返回拼接好的绝对 URL。
    /// 仅登录态可用；purl 为空按 Unavailable。
    /// </summary>
    internal async Task<NativeResult<QqEncryptedVkey>> GetEncryptedVkeyAsync(
        string songMid,
        string mediaMid,
        string prefix,
        string extension,
        CancellationToken cancellationToken = default)
    {
        if (!HasLogin || AuthKey.Length == 0)
        {
            return NativeResult<QqEncryptedVkey>.Unavailable();
        }

        var filename = $"{prefix}{mediaMid}.{extension}";
        var body = new JsonObject
        {
            ["comm"] = Comm(),
            ["req_0"] = Module(
                "vkey.GetVkeyServer",
                "CgiGetVkey",
                new JsonObject
                {
                    ["guid"] = "10000",
                    ["songmid"] = new JsonArray(songMid),
                    ["filename"] = new JsonArray(filename),
                    ["songtype"] = new JsonArray(1),
                    ["uin"] = Uin,
                    ["loginflag"] = 1,
                    ["platform"] = "20",
                }),
        };

        try
        {
            var upstream = await OnlineHttp.FetchTextAsync(
                    LyricEndpoint,
                    RefererUrl,
                    Timeout,
                    cancellationToken,
                    HttpMethod.Post,
                    body.ToJsonString(),
                    cookie: VkeyCookie)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(upstream.Body);
            var (sip, purl, result) = ReadVkey(document.RootElement);
            if (string.IsNullOrWhiteSpace(purl))
            {
                OnlineHttp.Info(
                    $"qq.native encrypted none mid={songMid} file={filename} result={result} {upstream.TookMs}ms");
                return NativeResult<QqEncryptedVkey>.Unavailable();
            }

            var url = purl.StartsWith("http", StringComparison.OrdinalIgnoreCase)
                ? purl
                : string.IsNullOrWhiteSpace(sip)
                    ? string.Empty
                    : sip.TrimEnd('/') + "/" + purl.TrimStart('/');
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            {
                OnlineHttp.Warn($"qq.native encrypted bad url mid={songMid} sip={sip} purl={purl}");
                return NativeResult<QqEncryptedVkey>.Unavailable();
            }

            OnlineHttp.Info(
                $"qq.native encrypted ok mid={songMid} file={filename} {upstream.TookMs}ms");
            return NativeResult<QqEncryptedVkey>.Ok(new QqEncryptedVkey(url, filename));
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"qq.native encrypted fail mid={songMid}: {OnlineHttp.Describe(exception)}");
            return NativeResult<QqEncryptedVkey>.Failed();
        }
    }

    private static (string Sip, string Purl, int Result) ReadVkey(JsonElement root)
    {
        var sip = string.Empty;
        var purl = string.Empty;
        var result = 0;
        if (root.ValueKind != JsonValueKind.Object)
        {
            return (sip, purl, result);
        }

        foreach (var property in root.EnumerateObject())
        {
            if (!property.Name.StartsWith("req", StringComparison.Ordinal) ||
                property.Value.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            if (!property.Value.TryGetProperty("data", out var data) ||
                data.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            if (data.TryGetProperty("sip", out var sipElement) && sipElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var entry in sipElement.EnumerateArray())
                {
                    sip = entry.GetString() ?? string.Empty;
                    break;
                }
            }

            if (data.TryGetProperty("midurlinfo", out var infos) && infos.ValueKind == JsonValueKind.Array)
            {
                foreach (var info in infos.EnumerateArray())
                {
                    purl = ReadString(info, "purl");
                    result = info.TryGetProperty("result", out var resultElement) &&
                             resultElement.TryGetInt32(out var resultValue)
                        ? resultValue
                        : 0;
                    break;
                }
            }

            if (!string.IsNullOrWhiteSpace(purl))
            {
                break;
            }
        }

        return (sip, purl, result);
    }

    internal sealed record QqEncryptedVkey(string Url, string FileName);

    /// <summary>
    /// musicu 免签 GET。响应按 req / req_0 / req_1 逐个看 code：0 与 10000（头部接口）
    /// 都算成功；全部非成功码按 Unavailable 处理，不触发熔断。
    /// </summary>
    private async Task<NativeResult<string>> CallMusicuAsync(
        JsonObject body,
        string tag,
        CancellationToken cancellationToken)
    {
        try
        {
            var url = $"{LyricEndpoint}?format=json&data={Uri.EscapeDataString(body.ToJsonString())}";
            var upstream = await OnlineHttp
                .FetchTextAsync(url, RefererUrl, Timeout, cancellationToken)
                .ConfigureAwait(false);

            using var document = JsonDocument.Parse(upstream.Body);
            var root = document.RootElement;
            var sawRequest = false;
            var ok = false;
            var codes = new List<int>(3);
            foreach (var name in new[] { "req", "req_0", "req_1" })
            {
                if (!root.TryGetProperty(name, out var request) || request.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                sawRequest = true;
                var code = ReadInt32(request, "code");
                codes.Add(code);
                if (code is 0 or 10000)
                {
                    ok = true;
                }
            }

            if (!sawRequest)
            {
                OnlineHttp.Warn($"{tag} no req code={ReadInt32(root, "code")} {upstream.TookMs}ms");
                return NativeResult<string>.Failed();
            }

            if (!ok)
            {
                OnlineHttp.Warn($"{tag} rejected codes={string.Join(',', codes)} {upstream.TookMs}ms");
                return NativeResult<string>.Unavailable();
            }

            OnlineHttp.Info($"{tag} codes={string.Join(',', codes)} ok {upstream.TookMs}ms");
            return NativeResult<string>.Ok(upstream.Body);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"{tag} failed: {OnlineHttp.Describe(exception)}");
            return NativeResult<string>.Failed();
        }
    }

    private static JsonObject WebComm() => new()
    {
        ["ct"] = 24,
        ["cv"] = 0,
        ["uin"] = "0",
    };

    private static JsonObject Module(string module, string method, JsonObject param) => new()
    {
        ["module"] = module,
        ["method"] = method,
        ["param"] = param,
    };

    private async Task<(NativeCallOutcome Outcome, Resolved? Resolved)> RequestAsync(
        string songmid,
        string prefix,
        string extension,
        string quality,
        CancellationToken cancellationToken)
    {
        var tag = $"{Tag} vkey mid={songmid} prefix={prefix} quality={quality}";
        try
        {
            // 签名必须覆盖实际发送的 JSON 文本，因此先序列化再原样发送同一个字符串。
            var body = BuildBody(songmid, prefix, extension).ToJsonString();
            var url = $"{Endpoint}?sign={QqApiSigner.Sign(body)}&_={DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)}";

            var upstream = await OnlineHttp.FetchTextAsync(
                    url,
                    RefererUrl,
                    Timeout,
                    cancellationToken,
                    HttpMethod.Post,
                    body,
                    VkeyCookie)
                .ConfigureAwait(false);

            using var document = JsonDocument.Parse(upstream.Body);
            var root = document.RootElement;
            var outerCode = ReadInt32(root, "code");
            var requestCode = -1;
            var retcode = -1;
            var result = -1;
            var purl = string.Empty;
            var sip = string.Empty;

            if (root.TryGetProperty("req_0", out var request) && request.ValueKind == JsonValueKind.Object)
            {
                requestCode = ReadInt32(request, "code");
                if (request.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
                {
                    retcode = ReadInt32(data, "retcode");
                    sip = ReadSip(data);
                    if (data.TryGetProperty("midurlinfo", out var infos) && infos.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var info in infos.EnumerateArray())
                        {
                            purl = ReadString(info, "purl");
                            result = ReadInt32(info, "result");
                            break;
                        }
                    }
                }
            }

            if (string.IsNullOrEmpty(purl))
            {
                // 无 purl 是匿名无权益的正常响应（104003/104009），交给 provider 走 web。
                OnlineHttp.Warn(
                    $"{tag} no purl code={outerCode} reqCode={requestCode} retcode={retcode} result={result} " +
                    $"{upstream.TookMs}ms");
                return (NativeCallOutcome.Unavailable, null);
            }

            if (IsEncryptedPurl(purl))
            {
                // .mflac/.mgg/.mmp4 是加密档，取回来也放不了；交给下一档明文候选。
                OnlineHttp.Warn($"{tag} encrypted purl -> next candidate");
                return (NativeCallOutcome.Unavailable, null);
            }

            string audioUrl;
            if (purl.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            {
                audioUrl = purl;
            }
            else if (!string.IsNullOrWhiteSpace(sip))
            {
                // sip 尾部通常带 "/"，purl 以文件名开头；拼接时只保留一个斜杠。
                audioUrl = sip.TrimEnd('/') + "/" + purl.TrimStart('/');
            }
            else
            {
                OnlineHttp.Warn($"{tag} missing sip purl={purl} {upstream.TookMs}ms");
                return (NativeCallOutcome.Failed, null);
            }

            if (!Uri.TryCreate(audioUrl, UriKind.Absolute, out var audioUri) ||
                (audioUri.Scheme != Uri.UriSchemeHttp && audioUri.Scheme != Uri.UriSchemeHttps))
            {
                OnlineHttp.Warn($"{tag} invalid url sip={sip} purl={purl}");
                return (NativeCallOutcome.Failed, null);
            }

            // 服务端会按 media_mid 归一文件名，返回的 purl 才是权威结果；格式从 purl 后缀推断。
            var format = purl.Contains(".flac", StringComparison.OrdinalIgnoreCase) ? "flac"
                : purl.Contains(".m4a", StringComparison.OrdinalIgnoreCase) ? "m4a"
                : purl.Contains(".mp3", StringComparison.OrdinalIgnoreCase) ? "mp3"
                : extension;

            OnlineHttp.Info($"{tag} ext={format} ok {upstream.TookMs}ms");
            return (NativeCallOutcome.Ok, new Resolved(audioUrl, format));
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"{tag} failed: {OnlineHttp.Describe(exception)}");
            return (NativeCallOutcome.Failed, null);
        }
    }

    private static bool IsEncryptedPurl(string purl) =>
        purl.Contains(".mflac", StringComparison.OrdinalIgnoreCase) ||
        purl.Contains(".mgg", StringComparison.OrdinalIgnoreCase) ||
        purl.Contains(".mmp4", StringComparison.OrdinalIgnoreCase);

    /// <summary>登录时用 android comm（带 authst）；匿名回落到 web comm。</summary>
    private JsonObject Comm() =>
        HasLogin && AuthKey.Length > 0
            ? new JsonObject
            {
                ["uin"] = Uin,
                ["format"] = "json",
                ["ct"] = 11,
                ["cv"] = 14090008,
                ["chid"] = "10003505",
                ["tmeAppID"] = "qqmusic",
                ["tmeLoginType"] = 1,
                ["authst"] = AuthKey,
            }
            : WebComm();

    private JsonObject BuildBody(string songmid, string prefix, string extension)
    {
        var uin = HasLogin ? Uin : "0";
        var comm = Comm();

        return new JsonObject
        {
            ["comm"] = comm,
            ["req"] = new JsonObject
            {
                ["module"] = "CDN.SrfCdnDispatchServer",
                ["method"] = "GetCdnDispatch",
                ["param"] = new JsonObject
                {
                    ["guid"] = _guid,
                    ["calltype"] = 0,
                    ["userip"] = string.Empty,
                },
            },
            ["req_0"] = new JsonObject
            {
                ["module"] = "vkey.GetVkeyServer",
                ["method"] = "CgiGetVkey",
                ["param"] = new JsonObject
                {
                    ["guid"] = _guid,
                    ["songmid"] = new JsonArray(songmid),
                    ["filename"] = new JsonArray($"{prefix}{songmid}{songmid}.{extension}"),
                    ["songtype"] = new JsonArray(0),
                    ["uin"] = uin,
                    ["loginflag"] = 1,
                    ["platform"] = "20",
                },
            },
        };
    }

    private static JsonObject BuildLyricBody(string songmid) => new()
    {
        ["comm"] = new JsonObject
        {
            ["ct"] = 11,
            ["cv"] = "1003006",
            ["v"] = "1003006",
            ["uin"] = "0",
        },
        ["req"] = new JsonObject
        {
            ["module"] = "music.musichallSong.PlayLyricInfo",
            ["method"] = "GetPlayLyricInfo",
            ["param"] = new JsonObject
            {
                ["songMID"] = songmid,
                ["format"] = "lrc",
                ["qrc"] = 0,
                // musicu 默认不带翻译轨；显式 trans=1 才会返回 data.trans（实测 002csB4u3irqNJ 2208 字符）。
                ["trans"] = 1,
            },
        },
    };

    private static JsonObject BuildSearchBody(string query, int limit) => new()
    {
        ["comm"] = new JsonObject
        {
            ["ct"] = 11,
            ["cv"] = "1003006",
            ["v"] = "1003006",
            ["uin"] = "0",
        },
        ["req"] = new JsonObject
        {
            ["module"] = "music.search.SearchCgiService",
            ["method"] = "DoSearchForQQMusicDesktop",
            ["param"] = new JsonObject
            {
                ["query"] = query,
                ["search_type"] = 0,
                ["num_per_page"] = Math.Clamp(limit, 1, 60),
                ["page_num"] = 1,
                ["grp"] = 1,
            },
        },
    };

    private static JsonObject BuildRecommendPlaylistsBody(int offset, int limit) => new()
    {
        ["comm"] = new JsonObject
        {
            ["ct"] = 24,
            ["cv"] = 0,
            ["uin"] = "0",
        },
        ["req"] = new JsonObject
        {
            ["module"] = "music.playlist.PlaylistSquare",
            ["method"] = "GetRecommendFeed",
            ["param"] = new JsonObject
            {
                ["From"] = Math.Max(0, offset),
                ["Size"] = Math.Clamp(limit, 1, 50),
            },
        },
    };

    private static string ReadSip(JsonElement data)
    {
        if (!data.TryGetProperty("sip", out var element) || element.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        foreach (var entry in element.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            var value = entry.GetString() ?? string.Empty;
            if (value.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            {
                return value;
            }
        }

        return string.Empty;
    }

    // musicu 的 lyric/trans 永远是 base64（research/qqmusic-api.md:298-302）；解码失败时最后
    // 检查一下原始文本是否已经是 LRC，避免个别网关直接返回明文时误判成无歌词。
    private static string DecodeBase64Text(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        try
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(value));
        }
        catch (FormatException)
        {
            return value.Contains('[', StringComparison.Ordinal) ? value : string.Empty;
        }
    }

    private static string ReadString(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(property, out var value) &&
        value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static string ReadId(JsonElement element, string property)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(property, out var value))
        {
            return string.Empty;
        }

        return value.ValueKind switch
        {
            JsonValueKind.Number => value.GetInt64().ToString(CultureInfo.InvariantCulture),
            JsonValueKind.String => value.GetString() ?? string.Empty,
            _ => string.Empty,
        };
    }

    private static bool TryReadInt(JsonElement element, string property, out int number)
    {
        number = 0;
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(property, out var value))
        {
            return false;
        }

        if (value.ValueKind == JsonValueKind.Number)
        {
            return value.TryGetInt32(out number);
        }

        return value.ValueKind == JsonValueKind.String &&
               int.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out number);
    }

    private static string FirstNonEmpty(string first, string second) => first.Length > 0 ? first : second;

    private static int ReadInt32(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(property, out var value) &&
        value.TryGetInt32(out var number)
            ? number
            : -1;

    private sealed record Resolved(string Url, string Format);
}
