using System.Globalization;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using Zilux2.Online.Account;

namespace Zilux2.Online.Library;

// QQ side of docs/zilux2-library.md §6.
//
// Verified against the live upstream (2026-10-18): musicu modules
// music.musicasset.PlaylistBaseRead/GetPlaylistByUin and music.musicasset.SongFavRead/GetSongFav
// exist (anonymous calls answer 80030 / 1000 = not logged in), and
// music.srfDissInfo.DissInfo/CgiGetDiss works for public playlists but only when "disstid" is a
// JSON number (a string disstid answers -100008 param error). PlaylistBaseRead/SongFavRead field
// names could not be observed anonymously, so their parsing is tolerant and logs key warnings.
internal sealed class QqLibraryProvider
{
    private const string Name = "qq";
    private const string MusicuEndpoint = "https://u.y.qq.com/cgi-bin/musicu.fcg";
    private const string SingleSongEndpoint = "https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg";
    private const int MaxPlaylists = 60;
    private const int MaxEnrichments = 60;

    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    private readonly AccountService? _accounts;

    public QqLibraryProvider(AccountService? accounts) => _accounts = accounts;

    private string MusicuCookie
    {
        get
        {
            var cookie = _accounts?.CookieHeader(Name, "u.y.qq.com") ?? string.Empty;
            var uin = _accounts?.GetUserId(Name);
            if (string.IsNullOrEmpty(uin) || CookieValue(cookie, "uin") is not null)
            {
                return cookie;
            }

            // QQ 音乐接口要求 cookie 里同时有 uin / qqmusic_uin 两套标识
            return cookie.Length > 0 ? $"uin={uin}; {cookie}" : $"uin={uin}";
        }
    }

    private JsonObject BuildComm(string uin)
    {
        // QQ 音乐客户端协议的 comm：只带 uin 的 web 形态在登录态下会返回 code=40000。
        var musicKey = CookieValue(MusicuCookie, "qqmusic_key") ?? CookieValue(MusicuCookie, "qm_keyst") ?? string.Empty;
        var uinNumber = long.TryParse(uin, out var parsedUin) ? parsedUin : 0;
        return new JsonObject
        {
            ["ct"] = 11,
            ["cv"] = 14090008,
            ["v"] = 14090008,
            ["chid"] = "10003505",
            ["tmeAppID"] = "qqmusic",
            // 注意：写接口（AddSonglist/DelSonglist）对 comm 里的 format/platform/needNewCode/uin
            // 极其敏感——带 platform=yqq 时网关直接回 500026（已用真实账号逐项二分验证）。
            // 与 research/qqma 的 buildAndroidComm 对齐，只保留客户端身份字段。
            ["QIMEI"] = "a1b2c3d4e5f60718293a4b5c6d7e8f901234",
            ["QIMEI36"] = "a1b2c3d4e5f60718293a4b5c6d7e8f901234",
            ["OpenUDID"] = "0123456789abcdef0123456789abcdef01234567",
            ["udid"] = "0123456789abcdef0123456789abcdef01234567",
            ["OpenUDID2"] = "0123456789abcdef0123456789abcdef01234567",
            ["aid"] = "0011223344556677",
            ["os_ver"] = "14",
            ["phonetype"] = "Pixel 7",
            ["devicelevel"] = "33",
            ["newdevicelevel"] = "33",
            ["rom"] = "google",
            ["qq"] = uinNumber,
            ["authst"] = musicKey,
            ["tmeLoginType"] = 1,
        };
    }

    private static string? CookieValue(string cookie, string name)
    {
        foreach (var part in cookie.Split(';'))
        {
            var separator = part.IndexOf('=');
            if (separator <= 0)
            {
                continue;
            }

            if (part.AsSpan(0, separator).Trim().Equals(name, StringComparison.OrdinalIgnoreCase))
            {
                return part[(separator + 1)..].Trim();
            }
        }

        return null;
    }

    private string WebCookie => _accounts?.CookieHeader(Name, "c.y.qq.com") ?? string.Empty;

    private bool IsLoggedIn => _accounts?.IsLoggedIn(Name) == true;

    internal async Task<LibrarySnapshot> GetSnapshotAsync(CancellationToken cancellationToken)
    {
        var uin = _accounts?.GetUserId(Name);
        if (string.IsNullOrEmpty(uin))
        {
            throw new OnlineUpstreamException("没有 QQ 音乐账号的 uin，请重新登录", 401);
        }

        var body = new JsonObject
        {
            ["comm"] = BuildComm(uin),
            ["req_1"] = new JsonObject
            {
                ["module"] = "music.musicasset.PlaylistBaseRead",
                ["method"] = "GetPlaylistByUin",
                ["param"] = new JsonObject { ["uin"] = uin },
            },
        };

        var root = await PostMusicuAsync(body, "qq/library playlists", cancellationToken).ConfigureAwait(false);
        var data = ReadRequestData(root);
        if (data is null)
        {
            throw new OnlineUpstreamException("QQ 音乐歌单列表返回异常", 502);
        }

        var entries = FindArray(data.Value, "v_playlist", "playlist", "list");
        LibraryPlaylist? liked = null;
        var others = new List<LibraryPlaylist>();
        foreach (var item in entries)
        {
            var id = ReadId(item, "tid", "dissid", "dirId", "id");
            if (id.Length == 0)
            {
                continue;
            }

            var title = ReadString(item, "dirName", "name", "title", "dissname");
            var count = ReadInt(item, "songnum", "song_num", "song_cnt", "songCount", "count", "total_song_num");
            var coverKey = TryNormalizeCover(ReadString(item, "picurl", "picUrl", "cover", "imgurl"));
            if (title.Contains("我喜欢", StringComparison.Ordinal))
            {
                liked = new LibraryPlaylist
                {
                    Source = Name,
                    Id = "liked",
                    Title = "我喜欢的音乐",
                    Count = count,
                    Special = "liked",
                    CoverKey = coverKey,
                };
                continue;
            }

            if (others.Count >= MaxPlaylists)
            {
                continue;
            }

            others.Add(new LibraryPlaylist
            {
                Source = Name,
                Id = id,
                Title = title.Length == 0 ? "未命名歌单" : title,
                Count = count,
                CoverKey = coverKey,
            });
        }

        // QQ keeps 我喜欢 outside the playlist folder, so synthesize the card from the fav folder.
        FavoritePage fav;
        try
        {
            fav = await GetFavoritesAsync(0, 1, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"qq/library favorites failed: {OnlineHttp.Describe(exception)}");
            fav = new FavoritePage([], 0, 0);
        }
        // playlists 里若出现「我喜欢」，其 songnum 可能解析为 0，用收藏夹的 total 校正
        if (liked is not null && liked.Count <= 0 && fav.Total > 0)
        {
            liked = liked with { Count = fav.Total };
        }

        liked ??= new LibraryPlaylist
        {
            Source = Name,
            Id = "liked",
            Title = "我喜欢的音乐",
            Count = fav.Total,
            Special = "liked",
            CoverKey = fav.Tracks.FirstOrDefault()?.CoverKey,
        };

        OnlineHttp.Info(
            $"GET qq/library playlists uin={uin} ok {others.Count} playlists " +
            $"likedCount={liked.Count} {fav.TookMs}ms");
        return new LibrarySnapshot(liked, others);
    }

    internal async Task<LibraryDetail> GetPlaylistAsync(string id, int offset, int limit, CancellationToken cancellationToken)
    {
        if (string.Equals(id, "liked", StringComparison.OrdinalIgnoreCase))
        {
            var fav = await GetFavoritesAsync(offset, limit, cancellationToken).ConfigureAwait(false);
            var likedMeta = new LibraryPlaylist
            {
                Source = Name,
                Id = "liked",
                Title = "我喜欢的音乐",
                Count = fav.Total,
                Special = "liked",
                CoverKey = fav.Tracks.FirstOrDefault()?.CoverKey,
            };
            return new LibraryDetail(likedMeta, fav.Tracks, offset + fav.Tracks.Count < fav.Total);
        }

        if (!long.TryParse(id, out var disstid) || disstid <= 0)
        {
            throw new OnlineUpstreamException("QQ 歌单 id 非法", 400);
        }

        var uin = _accounts?.GetUserId(Name) ?? "0";
        var body = new JsonObject
        {
            ["comm"] = new JsonObject { ["ct"] = 24, ["cv"] = 0, ["uin"] = uin },
            ["req_1"] = new JsonObject
            {
                ["module"] = "music.srfDissInfo.DissInfo",
                ["method"] = "CgiGetDiss",
                // Numeric disstid matters: the upstream answers param error for string ids.
                ["param"] = new JsonObject
                {
                    ["disstid"] = disstid,
                    ["dirid"] = 0,
                    ["song_begin"] = offset,
                    ["song_num"] = limit,
                    ["onlysong"] = 0,
                },
            },
        };

        var root = await PostMusicuAsync(body, "qq/library playlist", cancellationToken).ConfigureAwait(false);
        var data = ReadRequestData(root) ?? throw new OnlineUpstreamException("QQ 歌单详情返回异常", 502);
        var dirinfo = data.TryGetProperty("dirinfo", out var dirinfoElement) && dirinfoElement.ValueKind == JsonValueKind.Object
            ? dirinfoElement
            : default;
        var total = ReadInt(data, "total_song_num");
        if (total <= 0 && dirinfo.ValueKind == JsonValueKind.Object)
        {
            total = ReadInt(dirinfo, "songnum");
        }

        var songs = FindArray(data, "songlist", "songs");
        var tracks = new List<OnlineTrack>();
        foreach (var song in songs)
        {
            var track = ParseSong(song);
            if (track is not null)
            {
                tracks.Add(track);
            }
        }

        tracks = await EnrichTracksAsync(tracks, cancellationToken).ConfigureAwait(false);

        var meta = new LibraryPlaylist
        {
            Source = Name,
            Id = id,
            Title = dirinfo.ValueKind == JsonValueKind.Object ? FallbackTitle(ReadString(dirinfo, "title")) : "QQ 歌单",
            Count = total > 0 ? total : tracks.Count,
            Creator = dirinfo.ValueKind == JsonValueKind.Object ? ReadNestedString(dirinfo, "creator", "nick") : string.Empty,
            CoverKey = dirinfo.ValueKind == JsonValueKind.Object
                ? TryNormalizeCover(ReadString(dirinfo, "picurl", "picUrl"))
                : string.Empty,
        };

        var hasMore = ReadInt(data, "hasmore") == 1 || offset + tracks.Count < meta.Count;
        OnlineHttp.Info($"GET qq/library playlist id={id} ok {tracks.Count}/{meta.Count} tracks offset={offset}");
        return new LibraryDetail(meta, tracks, hasMore);
    }

    private sealed record FavoritePage(List<OnlineTrack> Tracks, int Total, long TookMs);

    private async Task<FavoritePage> GetFavoritesAsync(int offset, int limit, CancellationToken cancellationToken)
    {
        var uin = _accounts?.GetUserId(Name) ?? "0";
        // 「我喜欢」= QQ 音乐客户端协议 CgiGetDiss(dirid=201)；SongFavRead/GetSongFav 对登录态返回 40000。
        var body = new JsonObject
        {
            ["comm"] = BuildComm(uin),
            ["req_1"] = new JsonObject
            {
                ["module"] = "music.srfDissInfo.DissInfo",
                ["method"] = "CgiGetDiss",
                ["param"] = new JsonObject
                {
                    ["disstid"] = 0,
                    ["dirid"] = 201,
                    ["tag"] = true,
                    ["song_begin"] = offset,
                    ["song_num"] = limit,
                    ["userinfo"] = true,
                    ["orderlist"] = true,
                },
            },
        };

        var root = await PostMusicuAsync(body, "qq/library favorites", cancellationToken).ConfigureAwait(false);
        var data = ReadRequestData(root) ?? throw new OnlineUpstreamException("QQ 我喜欢列表返回异常", 502);
        var items = FindArray(data, "songlist", "songs", "list");
        var total = ReadInt(data, "total_song_num", "total", "songnum", "song_num", "count");

        var tracks = new List<OnlineTrack>();
        foreach (var item in items)
        {
            var track = ParseSong(item);
            if (track is not null)
            {
                tracks.Add(track);
            }
        }

        tracks = await EnrichTracksAsync(tracks, cancellationToken).ConfigureAwait(false);
        if (total <= 0)
        {
            total = offset + tracks.Count;
        }

        if (tracks.Count == 0 && items.Count > 0)
        {
            OnlineHttp.Warn($"qq/library favorites could not parse {items.Count} favorite entries");
        }

        OnlineHttp.Info($"qq/library favorites dirid=201 ok {tracks.Count}/{total} offset={offset}");
        return new FavoritePage(tracks, total, 0);
    }

    // SongFavRead may return only mids (shape unverified); resolve the missing metadata through the
    // public single-song endpoint rather than handing the UI blank rows. Capped per request.
    private async Task<List<OnlineTrack>> EnrichTracksAsync(List<OnlineTrack> tracks, CancellationToken cancellationToken)
    {
        var pending = tracks.Where(track => string.IsNullOrEmpty(track.Title)).Take(MaxEnrichments).ToList();
        if (pending.Count == 0)
        {
            return tracks;
        }

        var byId = new Dictionary<string, OnlineTrack>(StringComparer.Ordinal);
        foreach (var track in pending)
        {
            try
            {
                var url = $"{SingleSongEndpoint}?songmid={Uri.EscapeDataString(track.Id)}&format=json";
                var upstream = await OnlineHttp
                    .FetchTextAsync(url, QqProvider.RefererUrl, Timeout, cancellationToken, cookie: WebCookie)
                    .ConfigureAwait(false);
                using var document = JsonDocument.Parse(upstream.Body);
                if (document.RootElement.TryGetProperty("data", out var data) &&
                    data.ValueKind == JsonValueKind.Array)
                {
                    foreach (var song in data.EnumerateArray())
                    {
                        var enriched = ParseSong(song);
                        if (enriched is not null)
                        {
                            byId[track.Id] = enriched;
                            break;
                        }
                    }
                }
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                OnlineHttp.Warn($"GET qq/library song detail mid={track.Id} failed: {OnlineHttp.Describe(exception)}");
            }
        }

        if (byId.Count == 0)
        {
            return tracks;
        }

        OnlineHttp.Info($"GET qq/library song detail enriched {byId.Count}/{pending.Count} tracks");
        return tracks.Select(track => byId.TryGetValue(track.Id, out var enriched) ? enriched : track).ToList();
    }

    // 发现面板：每日推荐 = musicu Dissinfo(dirid=202)；QQ 没有开放的最近播放接口。
    internal async Task<List<OnlineTrack>> GetFeedAsync(string kind, int limit, CancellationToken cancellationToken)
    {
        if (_accounts?.IsLoggedIn(Name) != true)
        {
            throw new OnlineUpstreamException("该音源尚未登录，请先登录", 401);
        }

        if (!string.Equals(kind, "daily", StringComparison.Ordinal))
        {
            throw new OnlineUpstreamException("QQ 音乐不支持最近播放（平台未开放接口），可以先看每日推荐", 501);
        }

        limit = Math.Clamp(limit, 1, 200);
        var uin = _accounts?.GetUserId(Name) ?? "0";
        var body = new JsonObject
        {
            ["comm"] = BuildComm(uin),
            ["req_1"] = new JsonObject
            {
                ["module"] = "music.srfDissInfo.aiDissInfo",
                ["method"] = "uniform_get_Dissinfo",
                ["param"] = new JsonObject
                {
                    ["dirid"] = 202,
                    ["optype"] = 3,
                    ["tag"] = 1,
                    ["userinfo"] = 0,
                    ["pic_dpi"] = 300,
                },
            },
        };

        var root = await PostMusicuAsync(body, "qq/library feed daily", cancellationToken).ConfigureAwait(false);
        var data = ReadRequestData(root);
        var tracks = new List<OnlineTrack>();
        if (data is { } feedData
            && feedData.ValueKind == JsonValueKind.Object
            && feedData.TryGetProperty("songlist", out var songlist)
            && songlist.ValueKind == JsonValueKind.Array)
        {
            foreach (var song in songlist.EnumerateArray())
            {
                if (tracks.Count >= limit)
                {
                    break;
                }

                var track = ParseSong(song);
                if (track is not null && track.Title.Length > 0 && !tracks.Exists(existing => existing.Id == track.Id))
                {
                    tracks.Add(track);
                }
            }
        }

        HostLog.Info($"[library] qq feed kind=daily count={tracks.Count}");
        return tracks;
    }

    private OnlineTrack? ParseSong(JsonElement song)
    {
        var mid = ReadString(song, "mid", "songmid");
        if (mid.Length == 0)
        {
            return null;
        }

        var singers = new List<string>();
        if (song.TryGetProperty("singer", out var singerElement) && singerElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var singer in singerElement.EnumerateArray())
            {
                var name = ReadString(singer, "name", "title");
                if (name.Length > 0)
                {
                    singers.Add(name);
                }
            }
        }

        var albumName = string.Empty;
        var albumMid = string.Empty;
        if (song.TryGetProperty("album", out var album) && album.ValueKind == JsonValueKind.Object)
        {
            albumName = ReadString(album, "name", "title");
            albumMid = ReadString(album, "mid", "pmid");
        }
        else
        {
            albumName = ReadString(song, "albumname");
            albumMid = ReadString(song, "albummid");
        }

        var payPlay = ReadPayPlay(song);
        return new OnlineTrack
        {
            Source = Name,
            Id = mid,
            Mid = mid,
            Title = ReadString(song, "name", "title", "songname"),
            Artist = string.Join(" / ", singers),
            Album = albumName,
            DurationMs = ReadDurationMs(song),
            Playable = payPlay == 0 || (payPlay > 0 && IsLoggedIn),
            CoverKey = albumMid.Length > 0 ? albumMid : null,
        };
    }

    private static long ReadDurationMs(JsonElement song)
    {
        // musicu endpoints report "interval" in seconds; a few web endpoints report milliseconds.
        if (song.TryGetProperty("interval", out var interval) && interval.TryGetInt32(out var seconds))
        {
            return seconds * 1000L;
        }

        var duration = ReadInt(song, "duration");
        return duration > 1000 ? duration : duration * 1000L;
    }

    private static int ReadPayPlay(JsonElement song)
    {
        if (song.TryGetProperty("pay", out var pay) && pay.ValueKind == JsonValueKind.Object)
        {
            if (pay.TryGetProperty("pay_play", out var payPlay) && payPlay.TryGetInt32(out var value))
            {
                return value;
            }

            if (pay.TryGetProperty("payplay", out var legacy) && legacy.TryGetInt32(out var legacyValue))
            {
                return legacyValue;
            }
        }

        if (song.TryGetProperty("payplay", out var flat) && flat.TryGetInt32(out var flatValue))
        {
            return flatValue;
        }

        // Unknown pay data: assume a free track instead of hiding it; the player surfaces real failures.
        return 0;
    }

    private async Task<JsonElement> PostMusicuAsync(JsonObject body, string label, CancellationToken cancellationToken)
    {
        var upstream = await OnlineHttp
            .FetchTextAsync(
                MusicuEndpoint,
                QqProvider.RefererUrl,
                Timeout,
                cancellationToken,
                HttpMethod.Post,
                body.ToJsonString(),
                MusicuCookie)
            .ConfigureAwait(false);

        using var document = JsonDocument.Parse(upstream.Body);
        var root = document.RootElement.Clone();
        if (root.TryGetProperty("req_1", out var request) &&
            request.TryGetProperty("code", out var code) &&
            code.TryGetInt32(out var codeValue) &&
            codeValue != 0)
        {
            var message = codeValue switch
            {
                1000 or 80030 => "QQ 音乐登录态已失效，请重新登录",
                10004 => "QQ 音乐歌单数据异常，请稍后重试",
                _ => $"QQ 音乐接口返回 code={codeValue}",
            };
            throw new OnlineUpstreamException(message, codeValue is 1000 or 80030 ? 401 : 502);
        }

        OnlineHttp.Info($"POST {label} ok {upstream.TookMs}ms");
        return root;
    }

    private static JsonElement? ReadRequestData(JsonElement root) =>
        root.TryGetProperty("req_1", out var request) &&
        request.TryGetProperty("data", out var data) &&
        data.ValueKind == JsonValueKind.Object
            ? data
            : null;

    /// <summary>
    /// 用 songmid 换数字 songId：QQ 的 AddSonglist/DelSonglist 只收数字 id。
    /// 上游对 get_song_detail_yqq 的返回结构偶尔会换一层（track_info / trackInfo，
    /// 甚至不在 req_1.data 下），这里做一次宽松解析并把原始返回写进日志。
    /// </summary>
    private async Task<long> ResolveSongIdAsync(string mid, string label, CancellationToken cancellationToken)
    {
        var uin = _accounts?.GetUserId(Name) ?? "0";
        var detailBody = new JsonObject
        {
            ["comm"] = BuildComm(uin),
            ["req_1"] = new JsonObject
            {
                ["module"] = "music.pf_song_detail_svr",
                ["method"] = "get_song_detail_yqq",
                ["param"] = new JsonObject { ["song_type"] = 0, ["song_mid"] = mid },
            },
        };
        var detailRoot = await PostMusicuAsync(detailBody, label + " detail", cancellationToken).ConfigureAwait(false);
        var trackInfo = FindTrackInfo(detailRoot);
        if (trackInfo is null)
        {
            var raw = detailRoot.GetRawText();
            OnlineHttp.Warn($"{label} detail parse failed mid={mid} body={(raw.Length > 400 ? raw[..400] : raw)}");
            throw new OnlineUpstreamException("QQ 歌曲详情返回异常", 502);
        }

        var idText = ReadId(trackInfo.Value, "id");
        if (string.IsNullOrEmpty(idText)) idText = ReadId(trackInfo.Value, "songId");
        if (string.IsNullOrEmpty(idText)) idText = ReadId(trackInfo.Value, "song_id");
        if (!long.TryParse(idText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var songId) || songId <= 0)
        {
            var raw = trackInfo.Value.GetRawText();
            OnlineHttp.Warn($"{label} id parse failed mid={mid} track={(raw.Length > 300 ? raw[..300] : raw)}");
            throw new OnlineUpstreamException("QQ 歌曲 id 解析失败", 502);
        }

        return songId;
    }

    /// <summary>在响应里递归找 track_info / trackInfo 对象。</summary>
    private static JsonElement? FindTrackInfo(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in element.EnumerateObject())
            {
                if ((property.NameEquals("track_info") || property.NameEquals("trackInfo")) &&
                    property.Value.ValueKind == JsonValueKind.Object)
                {
                    return property.Value;
                }

                var nested = FindTrackInfo(property.Value);
                if (nested is not null) return nested;
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
            {
                var nested = FindTrackInfo(item);
                if (nested is not null) return nested;
            }
        }

        return null;
    }

    private static List<JsonElement> FindArray(JsonElement data, params string[] names)
    {
        foreach (var name in names)
        {
            if (data.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Array)
            {
                return value.EnumerateArray().ToList();
            }
        }

        return [];
    }

    private static string ReadId(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (!element.TryGetProperty(name, out var value))
            {
                continue;
            }

            var text = value.ValueKind switch
            {
                JsonValueKind.Number => value.ToString(),
                JsonValueKind.String => value.GetString() ?? string.Empty,
                _ => string.Empty,
            };
            if (text.Length > 0)
            {
                return text;
            }
        }

        return string.Empty;
    }

    private static string ReadString(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
            {
                var text = value.GetString() ?? string.Empty;
                if (text.Length > 0)
                {
                    return text;
                }
            }
        }

        return string.Empty;
    }

    private static string ReadNestedString(JsonElement element, string objectName, string name) =>
        element.TryGetProperty(objectName, out var nested) && nested.ValueKind == JsonValueKind.Object
            ? ReadString(nested, name)
            : string.Empty;

    private static int ReadInt(JsonElement element, params string[] names)
    {
        foreach (var name in names)
        {
            if (element.TryGetProperty(name, out var value))
            {
                if (value.TryGetInt32(out var number))
                {
                    return number;
                }

                if (value.ValueKind == JsonValueKind.String && int.TryParse(value.GetString(), out var parsed))
                {
                    return parsed;
                }
            }
        }

        return 0;
    }

    private static string FallbackTitle(string title) => title.Length == 0 ? "QQ 歌单" : title;

    // QQ image hosts are whitelisted so the /api/cover proxy never fetches arbitrary URLs.
    private static string TryNormalizeCover(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var normalized = value.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            ? "https://" + value[7..]
            : value;
        if (!Uri.TryCreate(normalized, UriKind.Absolute, out var uri) ||
            !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            return string.Empty;
        }

        var host = uri.Host;
        var allowed = host.EndsWith(".qq.com", StringComparison.OrdinalIgnoreCase) ||
                      host.EndsWith(".gtimg.cn", StringComparison.OrdinalIgnoreCase) ||
                      host.EndsWith(".gtimg.com", StringComparison.OrdinalIgnoreCase);
        return allowed ? normalized : string.Empty;
    }

    // 「加入我喜欢」：QQ 音乐客户端协议 music.musicasset.PlaylistDetailWrite/AddSonglist(dirId=201)。
    // AddSonglist 只收数字 songId，因此先用 get_song_detail_yqq 按 songmid 换出数字 id。
    internal async Task<bool> CheckLikedAsync(string mid, CancellationToken cancellationToken)
    {
        if (_accounts?.IsLoggedIn(Name) != true)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(mid) || mid.Length > 64)
        {
            return false;
        }

        var uin = _accounts?.GetUserId(Name) ?? "0";
        var body = new JsonObject
        {
            ["comm"] = BuildComm(uin),
            ["req_1"] = new JsonObject
            {
                ["module"] = "music.musicasset.SongFavRead",
                ["method"] = "IsSongFanByMid",
                ["param"] = new JsonObject
                {
                    ["v_songMid"] = new JsonArray { mid },
                },
            },
        };
        var root = await PostMusicuAsync(body, "qq/library liked", cancellationToken).ConfigureAwait(false);
        var data = ReadRequestData(root);
        if (data is not { } readData
            || !readData.TryGetProperty("m_fan", out var fan)
            || fan.ValueKind != JsonValueKind.Object
            || !fan.TryGetProperty(mid, out var value))
        {
            return false;
        }

        return value.ValueKind == JsonValueKind.True;
    }

    internal async Task AddLikedAsync(string mid, CancellationToken cancellationToken)
    {
        if (_accounts?.IsLoggedIn(Name) != true)
        {
            throw new OnlineUpstreamException("QQ 音乐尚未登录，请先登录", 401);
        }

        if (string.IsNullOrWhiteSpace(mid) || mid.Length > 64)
        {
            throw new OnlineUpstreamException("歌曲 mid 参数非法", 400);
        }

        var uin = _accounts?.GetUserId(Name) ?? "0";
        var songId = await ResolveSongIdAsync(mid, "qq/library like", cancellationToken).ConfigureAwait(false);

        var writeBody = new JsonObject
        {
            ["comm"] = BuildComm(uin),
            ["req_1"] = new JsonObject
            {
                ["module"] = "music.musicasset.PlaylistDetailWrite",
                ["method"] = "AddSonglist",
                ["param"] = new JsonObject
                {
                    ["dirId"] = 201,
                    ["v_songInfo"] = new JsonArray
                    {
                        new JsonObject { ["songId"] = songId, ["songType"] = 0 },
                    },
                },
            },
        };
        JsonElement writeRoot;
        try
        {
            writeRoot = await PostMusicuAsync(writeBody, "qq/library like write", cancellationToken).ConfigureAwait(false);
        }
        catch (OnlineUpstreamException error) when (error.Message.Contains("500026", StringComparison.Ordinal))
        {
            // 500026 一般来自 comm 与登录态不匹配（历史上是 comm.platform=yqq 导致），
            // 已经把 comm 对齐成 Android 客户端形态，若再出现就说明协议又变了。
            OnlineHttp.Warn($"POST qq/library like rejected 500026 mid={mid} songId={songId}");
            throw new OnlineUpstreamException("QQ 音乐暂时拒绝收藏请求（协议校验未通过），请稍后重试或到 QQ 音乐客户端操作", 502);
        }
        var writeData = ReadRequestData(writeRoot);
        if (writeData is { } data)
        {
            var retCode = ReadInt(data, "retCode");
            if (retCode != 0)
            {
                var bodyText = data.GetRawText();
                // 已经喜欢过：QQ 返回重复错误，幂等成功。
                if (bodyText.Contains("重复", StringComparison.Ordinal) || bodyText.Contains("已存在", StringComparison.Ordinal))
                {
                    OnlineHttp.Info($"POST qq/library like mid={mid} songId={songId} already-liked");
                    return;
                }
                OnlineHttp.Warn($"POST qq/library like failed code={retCode} body={bodyText}");
                throw new OnlineUpstreamException($"QQ 音乐新增喜欢失败 code={retCode}", 502);
            }
        }

        OnlineHttp.Info($"POST qq/library like mid={mid} songId={songId} ok");
    }

    // 批量收藏状态：IsSongFanByMid 支持一次传多个 songmid，只打一次上游。
    internal async Task<Dictionary<string, bool>> CheckLikedManyAsync(
        IReadOnlyList<string> mids,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<string, bool>(StringComparer.Ordinal);
        if (_accounts?.IsLoggedIn(Name) != true)
        {
            return result;
        }

        var wanted = new List<string>();
        foreach (var mid in mids)
        {
            if (string.IsNullOrWhiteSpace(mid) || mid.Length > 64 || result.ContainsKey(mid) || wanted.Contains(mid))
            {
                continue;
            }

            wanted.Add(mid);
        }

        if (wanted.Count == 0)
        {
            return result;
        }

        var uin = _accounts?.GetUserId(Name) ?? "0";
        var songMids = new JsonArray();
        foreach (var mid in wanted)
        {
            songMids.Add(mid);
        }

        var body = new JsonObject
        {
            ["comm"] = BuildComm(uin),
            ["req_1"] = new JsonObject
            {
                ["module"] = "music.musicasset.SongFavRead",
                ["method"] = "IsSongFanByMid",
                ["param"] = new JsonObject
                {
                    ["v_songMid"] = songMids,
                },
            },
        };

        try
        {
            var root = await PostMusicuAsync(body, "qq/library liked-many", cancellationToken).ConfigureAwait(false);
            var data = ReadRequestData(root);
            if (data is { } readData && readData.TryGetProperty("m_fan", out var fan) && fan.ValueKind == JsonValueKind.Object)
            {
                foreach (var mid in wanted)
                {
                    result[mid] = fan.TryGetProperty(mid, out var value) && value.ValueKind == JsonValueKind.True;
                }
            }
        }
        catch (OnlineUpstreamException error)
        {
            OnlineHttp.Warn($"qq/library liked-many failed: {error.Message}");
        }

        return result;
    }

    // 「取消喜欢」：PlaylistDetailWrite/DelSonglist(dirId=201)，与收藏同一协议族。
    internal async Task RemoveLikedAsync(string mid, CancellationToken cancellationToken)
    {
        if (_accounts?.IsLoggedIn(Name) != true)
        {
            throw new OnlineUpstreamException("QQ 音乐尚未登录，请先登录", 401);
        }

        if (string.IsNullOrWhiteSpace(mid) || mid.Length > 64)
        {
            throw new OnlineUpstreamException("歌曲 mid 参数非法", 400);
        }

        var uin = _accounts?.GetUserId(Name) ?? "0";
        var songId = await ResolveSongIdAsync(mid, "qq/library unlike", cancellationToken).ConfigureAwait(false);

        var writeBody = new JsonObject
        {
            ["comm"] = BuildComm(uin),
            ["req_1"] = new JsonObject
            {
                ["module"] = "music.musicasset.PlaylistDetailWrite",
                ["method"] = "DelSonglist",
                ["param"] = new JsonObject
                {
                    ["dirId"] = 201,
                    ["v_songInfo"] = new JsonArray
                    {
                        new JsonObject { ["songId"] = songId, ["songType"] = 0 },
                    },
                },
            },
        };
        JsonElement writeRoot;
        try
        {
            writeRoot = await PostMusicuAsync(writeBody, "qq/library unlike write", cancellationToken).ConfigureAwait(false);
        }
        catch (OnlineUpstreamException error) when (error.Message.Contains("500026", StringComparison.Ordinal))
        {
            OnlineHttp.Warn($"POST qq/library unlike rejected 500026 mid={mid} songId={songId}");
            throw new OnlineUpstreamException("QQ 音乐暂时拒绝取消收藏请求（协议校验未通过），请稍后重试或到 QQ 音乐客户端操作", 502);
        }

        var writeData = ReadRequestData(writeRoot);
        if (writeData is { } data)
        {
            var retCode = ReadInt(data, "retCode");
            if (retCode != 0)
            {
                OnlineHttp.Warn($"POST qq/library unlike failed code={retCode} body={data.GetRawText()}");
                throw new OnlineUpstreamException($"QQ 音乐取消喜欢失败 code={retCode}", 502);
            }
        }

        OnlineHttp.Info($"POST qq/library unlike mid={mid} songId={songId} ok");
    }

}
