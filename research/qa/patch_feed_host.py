# -*- coding: utf-8 -*-
"""宿主侧「发现」接口：/api/library/feed（最近播放 / 每日推荐）。"""
import io

ROOT = r"E:\Zilux2开发"

def patch(path, pairs):
    full = ROOT + "\\" + path
    with io.open(full, "r", encoding="utf-8", newline="") as f:
        s = f.read()
    for old, new in pairs:
        if s.count(old) != 1:
            raise SystemExit(f"[fail] {path}: anchor not unique/found: {old[:60]!r} count={s.count(old)}")
        s = s.replace(old, new, 1)
    with io.open(full, "w", encoding="utf-8", newline="") as f:
        f.write(s)
    print(f"[ok] {path}")


# 1) 模型：原始 feed 记录
patch(r"src\Zilux2\Online\Library\LibraryModels.cs", [(
    "internal sealed record LibraryDetail(LibraryPlaylist Meta, List<OnlineTrack> Tracks, bool HasMore);\n",
    "internal sealed record LibraryDetail(LibraryPlaylist Meta, List<OnlineTrack> Tracks, bool HasMore);\n"
    "\n"
    "// 最近播放 / 每日推荐（发现面板）的原始数据；封面仍是平台 key，由服务端改写成回环 URL。\n"
    "internal sealed record LibraryFeed(string Source, string Kind, List<OnlineTrack> Tracks);\n",
)])

# 2) 网易云：最近播放 + 每日推荐
NETEASE_FEED = '''    // 发现面板：最近播放（/api/v1/play/record）与每日推荐（/api/v3/discovery/recommend/songs）。
    internal async Task<List<OnlineTrack>> GetFeedAsync(string kind, int limit, CancellationToken cancellationToken)
    {
        if (!IsLoggedIn)
        {
            throw new OnlineUpstreamException("该音源尚未登录，请先登录", 401);
        }

        limit = Math.Clamp(limit, 1, 200);
        var daily = string.Equals(kind, "daily", StringComparison.Ordinal);
        string url;
        if (daily)
        {
            url = "https://music.163.com/api/v3/discovery/recommend/songs";
        }
        else
        {
            var userId = _accounts?.GetUserId(Name);
            if (string.IsNullOrEmpty(userId))
            {
                throw new OnlineUpstreamException("没有网易云账号的用户 id，请重新登录", 401);
            }

            url = $"https://music.163.com/api/v1/play/record?type=1&uid={Uri.EscapeDataString(userId)}&limit={limit}";
        }

        var upstream = await OnlineHttp
            .FetchTextAsync(url, NeteaseProvider.RefererUrl, Timeout, cancellationToken, cookie: Cookie)
            .ConfigureAwait(false);

        using var document = JsonDocument.Parse(upstream.Body);
        var root = document.RootElement;
        if (root.TryGetProperty("code", out var codeElement)
            && codeElement.TryGetInt32(out var code)
            && code != 200)
        {
            throw new OnlineUpstreamException($"网易云接口返回 code={code}", 502);
        }

        var tracks = new List<OnlineTrack>();
        if (daily)
        {
            if (root.TryGetProperty("data", out var data)
                && data.ValueKind == JsonValueKind.Object
                && data.TryGetProperty("dailySongs", out var songs)
                && songs.ValueKind == JsonValueKind.Array)
            {
                foreach (var song in songs.EnumerateArray())
                {
                    AddFeedTrack(tracks, song, limit);
                }
            }
        }
        else
        {
            JsonElement list = default;
            if (root.TryGetProperty("weekData", out var week) && week.ValueKind == JsonValueKind.Array)
            {
                list = week;
            }
            else if (root.TryGetProperty("allData", out var all) && all.ValueKind == JsonValueKind.Array)
            {
                list = all;
            }

            if (list.ValueKind == JsonValueKind.Array)
            {
                foreach (var entry in list.EnumerateArray())
                {
                    if (entry.ValueKind == JsonValueKind.Object && entry.TryGetProperty("song", out var song))
                    {
                        AddFeedTrack(tracks, song, limit);
                    }
                }
            }
        }

        HostLog.Info($"[library] netease feed kind={(daily ? "daily" : "recent")} count={tracks.Count}");
        return tracks;
    }

    private void AddFeedTrack(List<OnlineTrack> tracks, JsonElement song, int limit)
    {
        if (tracks.Count >= limit)
        {
            return;
        }

        var track = ParseFeedSong(song);
        if (track is not null && track.Title.Length > 0 && !tracks.Exists(existing => existing.Id == track.Id))
        {
            tracks.Add(track);
        }
    }

    // 推荐接口用 ar/al/dt 字段（歌单详情是 artists/album/duration），单独映射。
    private OnlineTrack? ParseFeedSong(JsonElement song)
    {
        var id = ReadId(song, "id");
        if (id.Length == 0)
        {
            return null;
        }

        var artists = new List<string>();
        JsonElement artistArray = default;
        foreach (var key in new[] { "ar", "artists" })
        {
            if (song.TryGetProperty(key, out var candidate) && candidate.ValueKind == JsonValueKind.Array)
            {
                artistArray = candidate;
                break;
            }
        }

        if (artistArray.ValueKind == JsonValueKind.Array)
        {
            foreach (var artist in artistArray.EnumerateArray())
            {
                var name = ReadString(artist, "name");
                if (name.Length > 0)
                {
                    artists.Add(name);
                }
            }
        }

        var albumName = string.Empty;
        var coverKey = string.Empty;
        JsonElement album = default;
        foreach (var key in new[] { "al", "album" })
        {
            if (song.TryGetProperty(key, out var candidate) && candidate.ValueKind == JsonValueKind.Object)
            {
                album = candidate;
                break;
            }
        }

        if (album.ValueKind == JsonValueKind.Object)
        {
            albumName = ReadString(album, "name");
            coverKey = TryNormalizeCover(ReadString(album, "picUrl"));
        }

        var fee = ReadInt(song, "fee");
        var status = ReadInt(song, "status");
        var duration = ReadLong(song, "dt");
        if (duration <= 0)
        {
            duration = ReadLong(song, "duration");
        }

        return new OnlineTrack
        {
            Source = Name,
            Id = id,
            Title = ReadString(song, "name"),
            Artist = string.Join(" / ", artists),
            Album = albumName,
            DurationMs = duration,
            Playable = IsPlayable(fee, status, IsLoggedIn),
            CoverKey = coverKey.Length > 0 ? coverKey : null,
        };
    }

'''
patch(r"src\Zilux2\Online\Library\NeteaseLibraryProvider.cs", [(
    "    private OnlineTrack? ParseSong(JsonElement song)\n",
    NETEASE_FEED + "    private OnlineTrack? ParseSong(JsonElement song)\n",
)])

# 3) QQ：每日推荐（musicu Dissinfo dirid=202）；最近播放明确不支持
QQ_FEED = '''    // 发现面板：每日推荐 = musicu Dissinfo(dirid=202)；QQ 没有开放的最近播放接口。
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
        if (data is not null
            && data.ValueKind == JsonValueKind.Object
            && data.TryGetProperty("songlist", out var songlist)
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

'''
patch(r"src\Zilux2\Online\Library\QqLibraryProvider.cs", [(
    "    private OnlineTrack? ParseSong(JsonElement song)\n",
    QQ_FEED + "    private OnlineTrack? ParseSong(JsonElement song)\n",
)])

# 4) LibraryService：GetFeedAsync
SERVICE_FEED = '''
    // 发现面板：最近播放 / 每日推荐。数据实时性强，不进歌单缓存。
    public async Task<LibraryFeed> GetFeedAsync(string source, string kind, int limit, CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        source = NormalizeSource(source);
        kind = (kind ?? string.Empty).Trim().ToLowerInvariant();
        if (kind is not ("recent" or "daily"))
        {
            throw new OnlineUpstreamException("kind 参数必须是 recent 或 daily", 400);
        }

        limit = limit <= 0 ? 60 : Math.Min(limit, 200);
        if (_accounts?.IsLoggedIn(source) != true)
        {
            throw new OnlineUpstreamException("该音源尚未登录，请先登录", 401);
        }

        var tracks = source switch
        {
            AccountSources.Netease => await _netease.GetFeedAsync(kind, limit, cancellationToken).ConfigureAwait(false),
            AccountSources.Qq => await _qq.GetFeedAsync(kind, limit, cancellationToken).ConfigureAwait(false),
            _ => throw new OnlineUpstreamException("source 参数必须是 netease 或 qq", 400),
        };
        return new LibraryFeed(source, kind, tracks);
    }

'''
patch(r"src\Zilux2\Online\Library\LibraryService.cs", [(
    "        Refresh(source);\n    }\n\n}\n",
    "        Refresh(source);\n    }\n" + SERVICE_FEED + "}\n",
)])

# 5) 路由 + 处理函数
patch(r"src\Zilux2\Online\LocalMusicServer.cs", [
    (
        '                "/api/library/playlist" => isGet ? await HandleLibraryPlaylistAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),\n',
        '                "/api/library/playlist" => isGet ? await HandleLibraryPlaylistAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),\n'
        '                "/api/library/feed" => isGet ? await HandleLibraryFeedAsync(context, CancellationToken.None).ConfigureAwait(false) : MethodNotAllowed(context),\n',
    ),
    (
        "    private async Task<int> HandleLibraryLikeAsync(HttpListenerContext context)\n",
        '''    private async Task<int> HandleLibraryFeedAsync(HttpListenerContext context, CancellationToken token)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim().ToLowerInvariant();
        if (!LibraryService.IsKnownSource(source))
        {
            return WriteError(context, 400, "bad-request", "source 参数必须是 netease 或 qq");
        }

        var kind = (query["kind"] ?? "daily").Trim().ToLowerInvariant();
        var limit = 60;
        var limitRaw = query["limit"];
        if (!string.IsNullOrEmpty(limitRaw)
            && (!int.TryParse(limitRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out limit) || limit <= 0))
        {
            return WriteError(context, 400, "bad-request", "limit 参数非法");
        }

        var library = _library;
        if (library is null)
        {
            return WriteError(context, 503, "not-ready", "在线服务尚未就绪");
        }

        try
        {
            var feed = await library.GetFeedAsync(source, kind, limit, token).ConfigureAwait(false);
            var tracks = feed.Tracks
                .Select(track => track with { Cover = BuildCoverUrl(track.Source, track.CoverKey) })
                .ToList();
            WriteJson(context, 200, JsonSerializer.Serialize(new { source = feed.Source, kind = feed.Kind, tracks }));
            return 200;
        }
        catch (OnlineUpstreamException error)
        {
            return WriteError(context, error.StatusCode, "upstream-failed", error.Message);
        }
    }

    private async Task<int> HandleLibraryLikeAsync(HttpListenerContext context)
''',
    ),
])

print("feed host patch done")
