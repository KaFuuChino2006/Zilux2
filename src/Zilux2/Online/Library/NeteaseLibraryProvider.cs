using System.Globalization;
using System.Net.Http;
using System.Text.Json;
using Zilux2.Online.Account;

namespace Zilux2.Online.Library;

// Netease side of docs/zilux2-library.md §5.
//
// Verified against the live upstream (2026-10-18): the legacy /api/playlist/detail endpoint no
// longer returns trackIds (only up to ~200 inlined tracks without their ids), so the v6 endpoint
// is the primary source for the full track id list; the legacy one stays as a fallback because it
// carries full song metadata (fee/status/album.picUrl) in a single call.
internal sealed class NeteaseLibraryProvider
{
    private const string Name = "netease";
    private const string UserPlaylistEndpoint = "https://music.163.com/api/user/playlist";
    private const string PlaylistDetailEndpoint = "https://music.163.com/api/v6/playlist/detail";
    private const string LegacyPlaylistDetailEndpoint = "https://music.163.com/api/playlist/detail";
    private const string SongDetailEndpoint = "https://music.163.com/api/song/detail";
    private const int MaxPlaylists = 60;
    private const int SongDetailBatchSize = 500;

    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    private readonly AccountService? _accounts;

    public NeteaseLibraryProvider(AccountService? accounts) => _accounts = accounts;

    private string Cookie => _accounts?.CookieHeader(Name, "music.163.com") ?? string.Empty;

    private bool IsLoggedIn => _accounts?.IsLoggedIn(Name) == true;

    internal async Task<LibrarySnapshot> GetSnapshotAsync(CancellationToken cancellationToken)
    {
        var userId = _accounts?.GetUserId(Name);
        if (string.IsNullOrEmpty(userId))
        {
            throw new OnlineUpstreamException("没有网易云账号的用户 id，请重新登录", 401);
        }

        var url = $"{UserPlaylistEndpoint}?uid={Uri.EscapeDataString(userId)}&limit=1000&offset=0";
        var upstream = await OnlineHttp
            .FetchTextAsync(url, NeteaseProvider.RefererUrl, Timeout, cancellationToken, cookie: Cookie)
            .ConfigureAwait(false);

        using var document = JsonDocument.Parse(upstream.Body);
        var root = document.RootElement;
        if (!root.TryGetProperty("playlist", out var playlists) || playlists.ValueKind != JsonValueKind.Array)
        {
            throw new OnlineUpstreamException("网易云账号歌单列表返回异常", 502);
        }

        LibraryPlaylist? liked = null;
        var others = new List<LibraryPlaylist>();
        foreach (var item in playlists.EnumerateArray())
        {
            var id = ReadId(item, "id");
            if (id.Length == 0)
            {
                continue;
            }

            var title = ReadString(item, "name");
            var count = ReadInt(item, "trackCount");
            var coverKey = TryNormalizeCover(ReadString(item, "coverImgUrl"));
            var specialType = ReadInt(item, "specialType");
            if (specialType == 5)
            {
                liked = new LibraryPlaylist
                {
                    Source = Name,
                    Id = id,
                    Title = title.Length == 0 ? "我喜欢的音乐" : title,
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
                Creator = ReadNestedString(item, "creator", "nickname"),
                CoverKey = coverKey,
            });
        }

        OnlineHttp.Info(
            $"GET netease/library playlists uid={userId} ok {others.Count} playlists " +
            $"liked={(liked?.Id ?? "none")} {upstream.TookMs}ms");
        return new LibrarySnapshot(liked, others);
    }

    internal async Task<LibraryDetail> GetPlaylistAsync(string id, int offset, int limit, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(id) || !id.All(char.IsAsciiDigit))
        {
            throw new OnlineUpstreamException("网易云歌单 id 非法", 400);
        }

        try
        {
            return await GetPlaylistFromV6Async(id, offset, limit, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"GET netease/library playlist id={id} v6 failed, trying legacy: {OnlineHttp.Describe(exception)}");
            return await GetPlaylistFromLegacyAsync(id, offset, limit, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<LibraryDetail> GetPlaylistFromV6Async(
        string id,
        int offset,
        int limit,
        CancellationToken cancellationToken)
    {
        var url = $"{PlaylistDetailEndpoint}?id={Uri.EscapeDataString(id)}";
        var upstream = await OnlineHttp
            .FetchTextAsync(url, NeteaseProvider.RefererUrl, Timeout, cancellationToken, cookie: Cookie)
            .ConfigureAwait(false);

        using var document = JsonDocument.Parse(upstream.Body);
        var root = document.RootElement;
        if (!root.TryGetProperty("playlist", out var playlist) || playlist.ValueKind != JsonValueKind.Object)
        {
            throw new OnlineUpstreamException("网易云歌单不存在或无权访问", 404);
        }

        var trackIds = ReadTrackIds(playlist);
        var declaredCount = ReadInt(playlist, "trackCount");
        var total = trackIds.Count > 0 ? trackIds.Count : declaredCount;
        var pageIds = trackIds.Skip(offset).Take(limit).ToList();
        var tracks = await FetchSongsAsync(pageIds, cancellationToken).ConfigureAwait(false);

        var meta = new LibraryPlaylist
        {
            Source = Name,
            Id = ReadId(playlist, "id") is { Length: > 0 } playlistId ? playlistId : id,
            Title = FallbackTitle(ReadString(playlist, "name")),
            Count = total,
            Creator = ReadNestedString(playlist, "creator", "nickname"),
            CoverKey = TryNormalizeCover(ReadString(playlist, "coverImgUrl")),
        };

        OnlineHttp.Info(
            $"GET netease/library playlist id={id} ok {tracks.Count}/{total} tracks offset={offset} {upstream.TookMs}ms");
        return new LibraryDetail(meta, tracks, offset + tracks.Count < total);
    }

    // Legacy shape: result { name, coverImgUrl, trackCount, creator.nickname, tracks: [old song] }.
    // The tracks array is capped (~200) and its ids cannot be paged reliably, so this only runs when
    // the v6 endpoint fails.
    private async Task<LibraryDetail> GetPlaylistFromLegacyAsync(
        string id,
        int offset,
        int limit,
        CancellationToken cancellationToken)
    {
        var url = $"{LegacyPlaylistDetailEndpoint}?id={Uri.EscapeDataString(id)}";
        var upstream = await OnlineHttp
            .FetchTextAsync(url, NeteaseProvider.RefererUrl, Timeout, cancellationToken, cookie: Cookie)
            .ConfigureAwait(false);

        using var document = JsonDocument.Parse(upstream.Body);
        var root = document.RootElement;
        if (!root.TryGetProperty("result", out var result) || result.ValueKind != JsonValueKind.Object)
        {
            throw new OnlineUpstreamException("网易云歌单不存在或无权访问", 404);
        }

        var allTracks = new List<OnlineTrack>();
        if (result.TryGetProperty("tracks", out var tracksElement) && tracksElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var song in tracksElement.EnumerateArray())
            {
                var track = ParseSong(song);
                if (track is not null)
                {
                    allTracks.Add(track);
                }
            }
        }

        var page = allTracks.Skip(offset).Take(limit).ToList();
        var declaredCount = ReadInt(result, "trackCount");
        var meta = new LibraryPlaylist
        {
            Source = Name,
            Id = ReadId(result, "id") is { Length: > 0 } playlistId ? playlistId : id,
            Title = FallbackTitle(ReadString(result, "name")),
            Count = declaredCount > 0 ? declaredCount : allTracks.Count,
            Creator = ReadNestedString(result, "creator", "nickname"),
            CoverKey = TryNormalizeCover(ReadString(result, "coverImgUrl")),
        };

        OnlineHttp.Info(
            $"GET netease/library playlist id={id} legacy ok {page.Count}/{allTracks.Count} tracks " +
            $"offset={offset} {upstream.TookMs}ms");
        return new LibraryDetail(meta, page, offset + page.Count < allTracks.Count);
    }

    private async Task<List<OnlineTrack>> FetchSongsAsync(List<string> ids, CancellationToken cancellationToken)
    {
        var tracks = new List<OnlineTrack>(ids.Count);
        for (var start = 0; start < ids.Count; start += SongDetailBatchSize)
        {
            var chunk = ids.Skip(start).Take(SongDetailBatchSize).ToList();
            var url = $"{SongDetailEndpoint}?ids={Uri.EscapeDataString("[" + string.Join(",", chunk) + "]")}";
            var upstream = await OnlineHttp
                .FetchTextAsync(url, NeteaseProvider.RefererUrl, Timeout, cancellationToken, cookie: Cookie)
                .ConfigureAwait(false);

            using var document = JsonDocument.Parse(upstream.Body);
            var byId = new Dictionary<string, OnlineTrack>(StringComparer.Ordinal);
            if (document.RootElement.TryGetProperty("songs", out var songs) && songs.ValueKind == JsonValueKind.Array)
            {
                foreach (var song in songs.EnumerateArray())
                {
                    var track = ParseSong(song);
                    if (track is not null)
                    {
                        byId[track.Id] = track;
                    }
                }
            }

            // Keep the playlist order even if the upstream reorders or drops tracks.
            foreach (var id in chunk)
            {
                if (byId.TryGetValue(id, out var track))
                {
                    tracks.Add(track);
                }
            }

            OnlineHttp.Info($"GET netease/library songs ids={chunk.Count} ok {tracks.Count} total {upstream.TookMs}ms");
        }

        return tracks;
    }

    // 发现面板：最近播放（/api/v1/play/record）与每日推荐（/api/v3/discovery/recommend/songs）。
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

    private OnlineTrack? ParseSong(JsonElement song)
    {
        var id = ReadId(song, "id");
        if (id.Length == 0)
        {
            return null;
        }

        var artists = new List<string>();
        if (song.TryGetProperty("artists", out var artistsElement) && artistsElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var artist in artistsElement.EnumerateArray())
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
        if (song.TryGetProperty("album", out var album) && album.ValueKind == JsonValueKind.Object)
        {
            albumName = ReadString(album, "name");
            coverKey = TryNormalizeCover(ReadString(album, "picUrl"));
        }

        var fee = ReadInt(song, "fee");
        var status = ReadInt(song, "status");
        return new OnlineTrack
        {
            Source = Name,
            Id = id,
            Title = ReadString(song, "name"),
            Artist = string.Join(" / ", artists),
            Album = albumName,
            DurationMs = ReadLong(song, "duration"),
            Playable = IsPlayable(fee, status, IsLoggedIn),
            CoverKey = coverKey.Length > 0 ? coverKey : null,
        };
    }

    // Contract §4: fee 0/8 free, fee 1 membership-gated (true once logged in, playback re-checks),
    // anything else (purchase/DJ) stays unplayable; status < 0 means pulled.
    private bool IsPlayable(int fee, int status, bool loggedIn) =>
        status >= 0 && (fee is 0 or 8 || (fee == 1 && loggedIn));

    private static List<string> ReadTrackIds(JsonElement playlist)
    {
        var ids = new List<string>();
        if (!playlist.TryGetProperty("trackIds", out var trackIds) || trackIds.ValueKind != JsonValueKind.Array)
        {
            return ids;
        }

        foreach (var item in trackIds.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.Object)
            {
                var id = ReadId(item, "id");
                if (id.Length > 0)
                {
                    ids.Add(id);
                }
            }
            else if (item.ValueKind is JsonValueKind.Number or JsonValueKind.String)
            {
                var value = item.ToString();
                if (value.Length > 0)
                {
                    ids.Add(value);
                }
            }
        }

        return ids;
    }

    private static string ReadId(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value))
        {
            return string.Empty;
        }

        return value.ValueKind switch
        {
            JsonValueKind.Number => value.ToString(),
            JsonValueKind.String => value.GetString() ?? string.Empty,
            _ => string.Empty,
        };
    }

    private static string ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static string ReadNestedString(JsonElement element, string objectName, string name) =>
        element.TryGetProperty(objectName, out var nested) && nested.ValueKind == JsonValueKind.Object
            ? ReadString(nested, name)
            : string.Empty;

    private static int ReadInt(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.TryGetInt32(out var number) ? number : 0;

    private static long ReadLong(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.TryGetInt64(out var number) ? number : 0;

    private static string FallbackTitle(string title) => title.Length == 0 ? "未命名歌单" : title;

    // The /api/cover route only accepts https music.126.net image URLs, so http upstream URLs are
    // upgraded here; foreign hosts are dropped instead of producing a broken proxy link.
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
            !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !uri.Host.EndsWith(".music.126.net", StringComparison.OrdinalIgnoreCase))
        {
            return string.Empty;
        }

        return normalized;
    }

    // 「加入我喜欢」：网易云 playlist/manipulate/tracks(op=add)。先取我喜欢的歌单 id，再写入。
    private HashSet<string>? _likedTrackIds;
    private DateTime _likedTrackIdsAt = DateTime.MinValue;

    internal async Task<bool> CheckLikedAsync(string trackId, CancellationToken cancellationToken)
    {
        if (!IsLoggedIn)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(trackId) || trackId.Length > 64)
        {
            return false;
        }

        var snapshot = await GetSnapshotAsync(cancellationToken).ConfigureAwait(false);
        var liked = snapshot?.Liked;
        if (liked is null || liked.Id.Length == 0)
        {
            return false;
        }

        if (_likedTrackIds is null || DateTime.UtcNow - _likedTrackIdsAt > TimeSpan.FromMinutes(5))
        {
            var url = "https://music.163.com/api/v6/playlist/detail"
                + $"?id={Uri.EscapeDataString(liked.Id)}&n=0&s=0";
            var upstream = await OnlineHttp
                .FetchTextAsync(url, NeteaseProvider.RefererUrl, Timeout, cancellationToken, HttpMethod.Get, cookie: Cookie)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(upstream.Body);
            var ids = new HashSet<string>(StringComparer.Ordinal);
            if (document.RootElement.TryGetProperty("playlist", out var playlist)
                && playlist.TryGetProperty("trackIds", out var trackIds)
                && trackIds.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in trackIds.EnumerateArray())
                {
                    if (item.TryGetProperty("id", out var idElement) && idElement.TryGetInt64(out var idValue))
                    {
                        ids.Add(idValue.ToString(CultureInfo.InvariantCulture));
                    }
                }
            }

            _likedTrackIds = ids;
            _likedTrackIdsAt = DateTime.UtcNow;
            OnlineHttp.Info($"GET netease/library liked-trackids pid={liked.Id} count={ids.Count}");
        }

        return _likedTrackIds.Contains(trackId);
    }

    internal async Task AddLikedAsync(string trackId, CancellationToken cancellationToken)
    {
        if (!IsLoggedIn)
        {
            throw new OnlineUpstreamException("网易云尚未登录，请先登录", 401);
        }

        if (string.IsNullOrWhiteSpace(trackId) || trackId.Length > 64)
        {
            throw new OnlineUpstreamException("歌曲 id 参数非法", 400);
        }

        var snapshot = await GetSnapshotAsync(cancellationToken).ConfigureAwait(false);
        var liked = snapshot?.Liked;
        if (liked is null || liked.Id.Length == 0)
        {
            throw new OnlineUpstreamException("没有找到我喜欢的音乐", 404);
        }

        // 注意：trackIds 必须是「数字数组」的 JSON 字符串，且 pid 为数字歌单 id；
        // 传字符串数组会被上游以 code=502（请求参数错误）拒绝。
        var numericTrackId = trackId;
        var url = "https://music.163.com/api/playlist/manipulate/tracks"
            + $"?op=add&pid={Uri.EscapeDataString(liked.Id)}"
            + $"&trackIds=%5B{numericTrackId}%5D&immutable=true&csrf_token=";
        var upstream = await OnlineHttp
            .FetchTextAsync(url, NeteaseProvider.RefererUrl, Timeout, cancellationToken, HttpMethod.Post, cookie: Cookie)
            .ConfigureAwait(false);

        using var document = JsonDocument.Parse(upstream.Body);
        var root = document.RootElement;
        var code = root.TryGetProperty("code", out var codeElement) && codeElement.TryGetInt32(out var codeValue) ? codeValue : 0;
        if (code != 200 && code != 0)
        {
            // 已经在「我喜欢的音乐」里时上游返回「歌单内歌曲重复」，视为成功（幂等）。
            if (upstream.Body.Contains("重复", StringComparison.Ordinal))
            {
                OnlineHttp.Info($"POST netease/library like pid={liked.Id} track={trackId} already-liked");
                return;
            }
            OnlineHttp.Warn($"POST netease/library like failed code={code} body={upstream.Body}");
            var message = code switch
            {
                301 => "网易云歌单权限不足，请重新登录",
                400 => "网易云添加喜欢失败，请稍后重试",
                _ => $"网易云接口返回 code={code}",
            };
            throw new OnlineUpstreamException(message, code is 301 ? 401 : 502);
        }

        OnlineHttp.Info($"POST netease/library like pid={liked.Id} track={trackId} ok");
    }

    // 批量查询收藏状态：CheckLikedAsync 内部会缓存「我喜欢的音乐」trackIds，循环查询只打一次上游。
    internal async Task<Dictionary<string, bool>> CheckLikedManyAsync(
        IReadOnlyList<string> trackIds,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<string, bool>(StringComparer.Ordinal);
        foreach (var trackId in trackIds)
        {
            if (string.IsNullOrWhiteSpace(trackId) || trackId.Length > 64 || result.ContainsKey(trackId))
            {
                continue;
            }

            result[trackId] = await CheckLikedAsync(trackId, cancellationToken).ConfigureAwait(false);
        }

        return result;
    }

    // 「取消喜欢」：同一 manipulate/tracks 接口，op=del。
    internal async Task RemoveLikedAsync(string trackId, CancellationToken cancellationToken)
    {
        if (!IsLoggedIn)
        {
            throw new OnlineUpstreamException("网易云尚未登录，请先登录", 401);
        }

        if (string.IsNullOrWhiteSpace(trackId) || trackId.Length > 64)
        {
            throw new OnlineUpstreamException("歌曲 id 参数非法", 400);
        }

        var snapshot = await GetSnapshotAsync(cancellationToken).ConfigureAwait(false);
        var liked = snapshot?.Liked;
        if (liked is null || liked.Id.Length == 0)
        {
            throw new OnlineUpstreamException("没有找到我喜欢的音乐", 404);
        }

        var url = "https://music.163.com/api/playlist/manipulate/tracks"
            + $"?op=del&pid={Uri.EscapeDataString(liked.Id)}"
            + $"&trackIds=%5B{trackId}%5D&immutable=true&csrf_token=";
        var upstream = await OnlineHttp
            .FetchTextAsync(url, NeteaseProvider.RefererUrl, Timeout, cancellationToken, HttpMethod.Post, cookie: Cookie)
            .ConfigureAwait(false);

        using var document = JsonDocument.Parse(upstream.Body);
        var root = document.RootElement;
        var code = root.TryGetProperty("code", out var codeElement) && codeElement.TryGetInt32(out var codeValue) ? codeValue : 0;
        if (code != 200 && code != 0)
        {
            OnlineHttp.Warn($"POST netease/library unlike failed code={code} body={upstream.Body}");
            throw new OnlineUpstreamException($"网易云取消喜欢失败 code={code}", 502);
        }

        _likedTrackIds = null;
        _likedTrackIdsAt = DateTime.MinValue;
        OnlineHttp.Info($"POST netease/library unlike pid={liked.Id} track={trackId} ok");
    }

}
