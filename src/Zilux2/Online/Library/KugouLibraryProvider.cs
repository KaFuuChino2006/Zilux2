using System.Globalization;
using System.Text.Json;
using Zilux2.Online.Account;
using Zilux2.Online.Kugou;

namespace Zilux2.Online.Library;

// 酷狗个人库：get_all_list 里 name == "我喜欢" 的那张云歌单就是「我喜欢的音乐」；
// 它没有独立收藏接口，加/删歌都复用云歌单的 add_song / delete_songs。
internal sealed class KugouLibraryProvider
{
    private const int MaxPageSize = 500;
    private const int SnapshotPageSize = 30;
    private const int LikedCheckLimit = 1000;

    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(2);

    private readonly AccountService? _accounts;
    private readonly object _gate = new();
    private LibrarySnapshot? _snapshot;
    private DateTimeOffset _snapshotAt;
    private string _snapshotKey = string.Empty;
    private HashSet<string>? _likedHashes;
    private DateTimeOffset _likedHashesAt;
    private string _likedHashesKey = string.Empty;

    public KugouLibraryProvider(AccountService? accounts) => _accounts = accounts;

    public void Invalidate()
    {
        lock (_gate)
        {
            _snapshot = null;
            _snapshotAt = default;
            _snapshotKey = string.Empty;
            _likedHashes = null;
            _likedHashesAt = default;
            _likedHashesKey = string.Empty;
        }
    }

    public async Task<LibrarySnapshot> GetSnapshotAsync(CancellationToken cancellationToken)
    {
        var credentials = Credentials();
        var cacheKey = credentials.UserId;
        lock (_gate)
        {
            if (_snapshot is not null && _snapshotAt > DateTimeOffset.UtcNow && _snapshotKey == cacheKey)
            {
                return _snapshot;
            }
        }

        using var client = NewClient(credentials);
        var body = await client
            .GetUserPlaylistsAsync(credentials.UserId, credentials.Token, 1, SnapshotPageSize, cancellationToken)
            .ConfigureAwait(false);
        using var document = JsonDocument.Parse(body);
        ThrowIfError(document.RootElement, "读取酷狗歌单");
        var snapshot = ParseSnapshot(document.RootElement, credentials.UserId);
        if (snapshot.Playlists.Count == 0 && snapshot.Liked is null)
        {
            // 酷狗对 pagesize 很敏感；部分账号/风控档位会返回空 data。用更保守的 30 条再试一次，
            // 并把响应形状写进日志，避免页面只剩一个空歌单区。
            OnlineHttp.Warn($"[library] kugou snapshot empty body={body[..Math.Min(320, body.Length)]}");
            body = await client
                .GetUserPlaylistsAsync(credentials.UserId, credentials.Token, 1, 30, cancellationToken)
                .ConfigureAwait(false);
            using var retryDocument = JsonDocument.Parse(body);
            ThrowIfError(retryDocument.RootElement, "读取酷狗歌单");
            snapshot = ParseSnapshot(retryDocument.RootElement, credentials.UserId);
        }
        lock (_gate)
        {
            _snapshot = snapshot;
            _snapshotAt = DateTimeOffset.UtcNow.Add(CacheTtl);
            _snapshotKey = cacheKey;
        }

        OnlineHttp.Info($"[library] kugou snapshot playlists={snapshot.Playlists.Count} liked={(snapshot.Liked is null ? "no" : snapshot.Liked.Count.ToString(CultureInfo.InvariantCulture))}");
        return snapshot;
    }

    public async Task<LibraryDetail> GetPlaylistAsync(string id, int offset, int limit, CancellationToken cancellationToken)
    {
        var credentials = Credentials();
        if (id.StartsWith("gcid:", StringComparison.OrdinalIgnoreCase))
        {
            return await GetPublicPlaylistAsync(id["gcid:".Length..], offset, limit, credentials, cancellationToken).ConfigureAwait(false);
        }

        var snapshot = await GetSnapshotAsync(cancellationToken).ConfigureAwait(false);
        var liked = string.Equals(id, "liked", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(snapshot.Liked?.Id, id, StringComparison.Ordinal);
        var playlist = liked
            ? snapshot.Liked
            : snapshot.Playlists.FirstOrDefault(item => item.Id == id);
        var listId = liked ? snapshot.Liked?.Id : id;
        if (string.IsNullOrWhiteSpace(listId) || !long.TryParse(listId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var cloudListId))
        {
            throw new OnlineUpstreamException(liked ? "没有找到酷狗的「我喜欢的音乐」" : "酷狗歌单 id 非法", liked ? 404 : 400);
        }

        limit = limit <= 0 ? 200 : Math.Min(limit, MaxPageSize);
        var page = offset <= 0 ? 1 : (offset / limit) + 1;
        using var client = NewClient(credentials);
        var body = await client
            .GetCloudPlaylistAsync(credentials.UserId, credentials.Token, cloudListId, page, limit, cancellationToken)
            .ConfigureAwait(false);
        using var document = JsonDocument.Parse(body);
        ThrowIfError(document.RootElement, "读取酷狗歌单歌曲");
        var data = document.RootElement.TryGetProperty("data", out var dataNode) ? dataNode : default;
        var tracks = ParseTracks(data);
        var count = ReadInt(data, "count");
        var hasMore = count > 0 ? page * limit < count : tracks.Count == limit;
        var meta = new LibraryPlaylist
        {
            Source = AccountSources.Kugou,
            Id = string.IsNullOrWhiteSpace(id) ? listId : id,
            Title = liked ? "我喜欢的音乐" : playlist?.Title ?? "酷狗歌单",
            Count = count > 0 ? count : (playlist?.Count ?? tracks.Count),
            Special = liked ? "liked" : null,
            Creator = playlist?.Creator,
            CoverKey = playlist?.CoverKey,
        };
        OnlineHttp.Info($"[library] kugou playlist id={cloudListId} page={page} size={limit} tracks={tracks.Count} count={count}");
        return new LibraryDetail(meta, tracks, hasMore);
    }

    private async Task<LibraryDetail> GetPublicPlaylistAsync(
        string globalCollectionId,
        int offset,
        int limit,
        KugouCredentials credentials,
        CancellationToken cancellationToken)
    {
        limit = limit <= 0 ? 200 : Math.Min(limit, MaxPageSize);
        var page = offset <= 0 ? 1 : (offset / limit) + 1;
        using var client = NewClient(credentials);
        var body = await client
            .GetPublicPlaylistAsync(globalCollectionId, page, limit, credentials.UserId, credentials.Token, cancellationToken)
            .ConfigureAwait(false);
        using var document = JsonDocument.Parse(body);
        ThrowIfError(document.RootElement, "读取酷狗歌单歌曲");
        var data = document.RootElement.TryGetProperty("data", out var dataNode) ? dataNode : default;
        var tracks = new List<OnlineTrack>();
        if (data.TryGetProperty("songs", out var songs) && songs.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in songs.EnumerateArray())
            {
                var track = MapSong(item);
                if (track is not null)
                {
                    tracks.Add(track);
                }
            }
        }

        var count = ReadInt(data, "count");
        var title = "酷狗歌单";
        string? cover = null;
        if (data.TryGetProperty("list_info", out var listInfo) && listInfo.ValueKind == JsonValueKind.Object)
        {
            title = ReadString(listInfo, "specialname");
            if (title.Length == 0)
            {
                title = ReadString(listInfo, "name");
            }

            cover = KugouCover.Normalize(ReadString(listInfo, "pic"));
        }

        var meta = new LibraryPlaylist
        {
            Source = AccountSources.Kugou,
            Id = "gcid:" + globalCollectionId,
            Title = title,
            Count = count > 0 ? count : tracks.Count,
            CoverKey = cover,
        };
        var hasMore = count > 0 ? page * limit < count : tracks.Count == limit;
        OnlineHttp.Info($"[library] kugou public playlist gcid={globalCollectionId} page={page} tracks={tracks.Count} count={count}");
        return new LibraryDetail(meta, tracks, hasMore);
    }

    public async Task<List<OnlineTrack>> GetRecentAsync(int limit, CancellationToken cancellationToken)
    {
        var credentials = Credentials();
        using var client = NewClient(credentials);
        var body = await client.GetRecentAsync(credentials.UserId, credentials.Token, cancellationToken).ConfigureAwait(false);
        using var document = JsonDocument.Parse(body);
        ThrowIfError(document.RootElement, "读取酷狗最近播放");
        var data = document.RootElement.TryGetProperty("data", out var dataNode) ? dataNode : default;
        var tracks = new List<OnlineTrack>();
        if (data.TryGetProperty("songs", out var songs) && songs.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in songs.EnumerateArray())
            {
                var item = entry.ValueKind == JsonValueKind.Object && entry.TryGetProperty("info", out var info)
                    ? info
                    : entry;
                var track = MapSong(item);
                if (track is not null)
                {
                    tracks.Add(track);
                }

                if (tracks.Count >= limit)
                {
                    break;
                }
            }
        }
        else if (data.TryGetProperty("info", out var info) && info.ValueKind == JsonValueKind.Array)
        {
            tracks = ParseTracks(data);
        }

        OnlineHttp.Info($"[library] kugou recent count={tracks.Count}");
        return tracks.Take(Math.Max(1, limit)).ToList();
    }

    public async Task<List<OnlineTrack>> GetDailyAsync(int limit, CancellationToken cancellationToken)
    {
        var credentials = Credentials();
        using var client = NewClient(credentials);
        var body = await client.GetDailyAsync(credentials.UserId, credentials.Token, cancellationToken).ConfigureAwait(false);
        using var document = JsonDocument.Parse(body);
        ThrowIfError(document.RootElement, "读取酷狗每日推荐");
        var data = document.RootElement.TryGetProperty("data", out var dataNode) ? dataNode : default;
        var tracks = new List<OnlineTrack>();
        if (data.TryGetProperty("song_list", out var songs) && songs.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in songs.EnumerateArray())
            {
                var track = MapSong(item);
                if (track is not null)
                {
                    tracks.Add(track);
                }

                if (tracks.Count >= limit)
                {
                    break;
                }
            }
        }

        OnlineHttp.Info($"[library] kugou daily count={tracks.Count}");
        return tracks;
    }

    public async Task<bool> CheckLikedAsync(string trackId, CancellationToken cancellationToken)
    {
        var hashes = await GetLikedHashesAsync(cancellationToken).ConfigureAwait(false);
        return hashes.Contains(HashOf(trackId));
    }

    public async Task<Dictionary<string, bool>> CheckLikedManyAsync(
        IReadOnlyList<string> trackIds,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<string, bool>(StringComparer.Ordinal);
        if (trackIds.Count == 0)
        {
            return result;
        }

        HashSet<string> hashes;
        try
        {
            hashes = await GetLikedHashesAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            OnlineHttp.Warn($"[library] kugou liked-many skipped: {OnlineHttp.Describe(exception)}");
            return result;
        }

        foreach (var id in trackIds)
        {
            result[id] = hashes.Contains(HashOf(id));
        }

        return result;
    }

    public async Task AddLikedAsync(string trackId, string? title, string? artist, CancellationToken cancellationToken)
    {
        var credentials = Credentials();
        var snapshot = await GetSnapshotAsync(cancellationToken).ConfigureAwait(false);
        var liked = snapshot.Liked;
        if (liked is null || !long.TryParse(liked.Id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var listId))
        {
            throw new OnlineUpstreamException("没有找到酷狗的「我喜欢的音乐」", 404);
        }

        var parts = trackId.Split('|');
        var hash = parts.Length > 0 ? parts[0] : trackId;
        var durationSeconds = parts.Length > 1 && long.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var seconds) ? seconds : 0;
        var albumId = parts.Length > 2 && long.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out var album) ? album : 0;
        var mixId = parts.Length > 3 && long.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out var mix) ? mix : 0;
        var displayName = string.IsNullOrWhiteSpace(title)
            ? string.Empty
            : string.IsNullOrWhiteSpace(artist) ? title + ".mp3" : $"{artist} - {title}.mp3";
        using var client = NewClient(credentials);
        var body = await client
            .AddCloudSongAsync(credentials.UserId, credentials.Token, listId, displayName, hash, durationSeconds * 1000, albumId, mixId, cancellationToken)
            .ConfigureAwait(false);
        using var document = JsonDocument.Parse(body);
        ThrowIfError(document.RootElement, "收藏到酷狗");
        InvalidateLiked();
        OnlineHttp.Info($"[library] kugou like ok list={listId} hash={hash}");
    }

    public async Task RemoveLikedAsync(string trackId, CancellationToken cancellationToken)
    {
        var credentials = Credentials();
        var snapshot = await GetSnapshotAsync(cancellationToken).ConfigureAwait(false);
        var liked = snapshot.Liked;
        if (liked is null || !long.TryParse(liked.Id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var listId))
        {
            throw new OnlineUpstreamException("没有找到酷狗的「我喜欢的音乐」", 404);
        }

        var hash = HashOf(trackId);
        var fileId = await FindFileIdAsync(credentials, listId, hash, cancellationToken).ConfigureAwait(false);
        if (fileId is null)
        {
            InvalidateLiked();
            return;
        }

        using var client = NewClient(credentials);
        var body = await client
            .DeleteCloudSongsAsync(credentials.UserId, credentials.Token, listId, [fileId.Value], cancellationToken)
            .ConfigureAwait(false);
        using var document = JsonDocument.Parse(body);
        ThrowIfError(document.RootElement, "取消酷狗收藏");
        InvalidateLiked();
        OnlineHttp.Info($"[library] kugou unlike ok list={listId} hash={hash} fileid={fileId.Value}");
    }

    private async Task<long?> FindFileIdAsync(
        KugouCredentials credentials,
        long listId,
        string hash,
        CancellationToken cancellationToken)
    {
        using var client = NewClient(credentials);
        var page = 1;
        while (page <= 10)
        {
            var body = await client
                .GetCloudPlaylistAsync(credentials.UserId, credentials.Token, listId, page, 200, cancellationToken)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(body);
            ThrowIfError(document.RootElement, "读取酷狗歌单歌曲");
            var data = document.RootElement.TryGetProperty("data", out var dataNode) ? dataNode : default;
            if (!data.TryGetProperty("info", out var info) || info.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            foreach (var item in info.EnumerateArray())
            {
                if (!string.Equals(ReadString(item, "hash"), hash, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var fileId = ReadLong(item, "fileid");
                if (fileId > 0)
                {
                    return fileId;
                }
            }

            var count = ReadInt(data, "count");
            if (count <= page * 200 || info.GetArrayLength() < 200)
            {
                return null;
            }

            page++;
        }

        return null;
    }

    private async Task<HashSet<string>> GetLikedHashesAsync(CancellationToken cancellationToken)
    {
        var credentials = Credentials();
        var key = credentials.UserId + "|" + credentials.Token.GetHashCode(StringComparison.Ordinal);
        lock (_gate)
        {
            if (_likedHashes is not null && _likedHashesAt > DateTimeOffset.UtcNow && _likedHashesKey == key)
            {
                return _likedHashes;
            }
        }

        var snapshot = await GetSnapshotAsync(cancellationToken).ConfigureAwait(false);
        var liked = snapshot.Liked;
        var hashes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (liked is not null && long.TryParse(liked.Id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var listId))
        {
            using var client = NewClient(credentials);
            var page = 1;
            while (page <= 6)
            {
                var body = await client
                    .GetCloudPlaylistAsync(credentials.UserId, credentials.Token, listId, page, 200, cancellationToken)
                    .ConfigureAwait(false);
                using var document = JsonDocument.Parse(body);
                ThrowIfError(document.RootElement, "读取酷狗收藏");
                var data = document.RootElement.TryGetProperty("data", out var dataNode) ? dataNode : default;
                if (!data.TryGetProperty("info", out var info) || info.ValueKind != JsonValueKind.Array)
                {
                    break;
                }

                foreach (var item in info.EnumerateArray())
                {
                    var hash = ReadString(item, "hash");
                    if (hash.Length > 0)
                    {
                        hashes.Add(hash);
                    }
                }

                var count = ReadInt(data, "count");
                if (info.GetArrayLength() < 200 || count <= page * 200 || hashes.Count >= LikedCheckLimit)
                {
                    break;
                }

                page++;
            }
        }

        lock (_gate)
        {
            _likedHashes = hashes;
            _likedHashesAt = DateTimeOffset.UtcNow.Add(CacheTtl);
            _likedHashesKey = key;
        }

        return hashes;
    }

    private void InvalidateLiked()
    {
        lock (_gate)
        {
            _likedHashes = null;
            _likedHashesAt = default;
            _likedHashesKey = string.Empty;
            _snapshot = null;
            _snapshotAt = default;
            _snapshotKey = string.Empty;
        }
    }

    private static LibrarySnapshot ParseSnapshot(JsonElement root, string userId)
    {
        var playlists = new List<LibraryPlaylist>();
        JsonElement info = default;
        if (root.TryGetProperty("data", out var data))
        {
            if (data.TryGetProperty("info", out var infoNode))
            {
                info = infoNode;
            }
            else if (data.TryGetProperty("list", out var listNode))
            {
                info = listNode;
            }
        }

        if (info.ValueKind == JsonValueKind.Object && info.TryGetProperty("info", out var nestedInfo))
        {
            info = nestedInfo;
        }

        if (info.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in info.EnumerateArray())
            {
                var listId = ReadString(item, "listid");
                var name = ReadString(item, "name");
                if (listId.Length == 0 || name.Length == 0)
                {
                    continue;
                }

                var count = ReadInt(item, "count");
                if (count <= 0)
                {
                    count = ReadInt(item, "m_count");
                }

                var cover = ReadString(item, "pic");
                if (cover.Length == 0)
                {
                    cover = ReadString(item, "imgurl");
                }

                var isLiked = string.Equals(name.Trim(), "我喜欢", StringComparison.Ordinal);
                var playlist = new LibraryPlaylist
                {
                    Source = AccountSources.Kugou,
                    Id = listId,
                    Title = isLiked ? "我喜欢的音乐" : name,
                    Count = count,
                    Special = isLiked ? "liked" : null,
                    Creator = ReadString(item, "list_create_username"),
                    CoverKey = KugouCover.Normalize(cover),
                };
                playlists.Add(playlist);
            }
        }

        var likedPlaylist = playlists.FirstOrDefault(item => item.Special == "liked");
        var others = playlists
            .Where(item => item.Special != "liked")
            .OrderBy(item => item.Title, StringComparer.CurrentCulture)
            .ToList();
        return new LibrarySnapshot(likedPlaylist, others);
    }

    private static List<OnlineTrack> ParseTracks(JsonElement data)
    {
        var tracks = new List<OnlineTrack>();
        if (!data.TryGetProperty("info", out var info) || info.ValueKind != JsonValueKind.Array)
        {
            return tracks;
        }

        foreach (var item in info.EnumerateArray())
        {
            var track = MapSong(item);
            if (track is not null)
            {
                tracks.Add(track);
            }
        }

        return tracks;
    }

    private static OnlineTrack? MapSong(JsonElement item)
    {
        var hash = ReadString(item, "hash");
        if (hash.Length == 0)
        {
            return null;
        }

        var durationMs = ReadLong(item, "timelen");
        if (durationMs <= 0)
        {
            var seconds = ReadLong(item, "time_length");
            if (seconds > 0)
            {
                durationMs = seconds * 1000;
            }
        }

        var albumId = ReadLong(item, "album_id");
        var album = ReadString(item, "album_name");
        if (item.TryGetProperty("albuminfo", out var albumInfo) && albumInfo.ValueKind == JsonValueKind.Object)
        {
            if (albumId == 0)
            {
                albumId = ReadLong(albumInfo, "id");
            }

            if (album.Length == 0)
            {
                album = ReadString(albumInfo, "name");
            }
        }

        var mixId = ReadLong(item, "MixSongID");
        if (mixId == 0)
        {
            mixId = ReadLong(item, "mixsongid");
        }

        if (mixId == 0)
        {
            mixId = ReadLong(item, "album_audio_id");
        }

        var artist = ReadArtists(item);
        if (artist.Length == 0)
        {
            artist = ReadString(item, "author_name");
        }

        var name = ReadString(item, "name");
        if (name.Length == 0)
        {
            name = ReadString(item, "filename");
        }

        if (name.Length == 0)
        {
            name = ReadString(item, "songname");
        }

        name = StripFileExtension(name);
        var separator = name.IndexOf(" - ", StringComparison.Ordinal);
        if (separator > 0 && artist.Length > 0)
        {
            var prefix = name[..separator];
            if (artist.Split('/').Any(part => prefix.Contains(part, StringComparison.OrdinalIgnoreCase)))
            {
                name = name[(separator + 3)..];
            }
        }

        var cover = KugouCover.Normalize(ReadString(item, "cover"));
        if (cover is null)
        {
            cover = KugouCover.Normalize(ReadString(item, "sizable_cover"));
        }

        if (cover is null && item.TryGetProperty("trans_param", out var transParam))
        {
            cover = KugouCover.Normalize(ReadString(transParam, "union_cover"));
        }

        return new OnlineTrack
        {
            Source = AccountSources.Kugou,
            Id = $"{hash}|{Math.Max(0, durationMs / 1000)}|{albumId}|{mixId}",
            Title = name,
            Artist = artist,
            Album = album,
            DurationMs = durationMs,
            Playable = true,
            CoverKey = cover ?? (albumId > 0 ? albumId.ToString(CultureInfo.InvariantCulture) : null),
        };
    }

    private static string ReadArtists(JsonElement item)
    {
        if (item.TryGetProperty("singerinfo", out var singers) && singers.ValueKind == JsonValueKind.Array)
        {
            var names = new List<string>();
            foreach (var singer in singers.EnumerateArray())
            {
                var name = ReadString(singer, "name");
                if (name.Length > 0 && !names.Contains(name, StringComparer.Ordinal))
                {
                    names.Add(name);
                }
            }

            if (names.Count > 0)
            {
                return string.Join("/", names);
            }
        }

        return ReadString(item, "singername");
    }

    private static string StripFileExtension(string name)
    {
        foreach (var extension in new[] { ".mp3", ".flac", ".m4a", ".wav", ".ogg", ".ape" })
        {
            if (name.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
            {
                return name[..^extension.Length];
            }
        }

        return name;
    }

    private KugouCredentials Credentials()
    {
        if (_accounts?.IsLoggedIn(AccountSources.Kugou) != true)
        {
            throw new OnlineUpstreamException("请先登录酷狗音乐", 401);
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
        if (string.IsNullOrWhiteSpace(userId) || string.IsNullOrWhiteSpace(token))
        {
            throw new OnlineUpstreamException("酷狗音乐登录已失效，请重新登录", 401);
        }

        var mid = Find("mid", "kg_mid");
        if (string.IsNullOrWhiteSpace(mid))
        {
            mid = KugouDevice.Current.Mid;
        }

        var dfid = KugouDevice.ResolveDfid(Find("dfid", "kg_dfid"));
        return new KugouCredentials(userId, token, mid, dfid);
    }

    private static KugouClient NewClient(KugouCredentials credentials) => new(credentials.Mid, credentials.Dfid);

    private static string HashOf(string trackId)
    {
        var index = trackId.IndexOf('|', StringComparison.Ordinal);
        return index > 0 ? trackId[..index] : trackId;
    }

    private static void ThrowIfError(JsonElement root, string action)
    {
        if (root.ValueKind == JsonValueKind.Object &&
            root.TryGetProperty("status", out var status) &&
            status.ToString() == "1")
        {
            return;
        }

        var code = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("error_code", out var codeNode)
            ? codeNode.ToString()
            : "?";
        var message = code switch
        {
            "20017" => "酷狗登录凭证需要重新授权：请在账号面板重新扫码登录酷狗",
            "20018" => "酷狗登录已失效，请重新登录",
            "20028" => "酷狗要求安全验证，请稍后重试",
            "20010" => "酷狗接口参数错误",
            _ => $"{action}失败（{code}）",
        };
        var statusCode = code is "20017" or "20018" ? 401 : 502;
        throw new OnlineUpstreamException(message, statusCode);
    }

    private static string ReadString(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var node))
        {
            return string.Empty;
        }

        return node.ValueKind switch
        {
            JsonValueKind.String => node.GetString() ?? string.Empty,
            JsonValueKind.Number => node.ToString(),
            _ => string.Empty,
        };
    }

    private static long ReadLong(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var node))
        {
            return 0;
        }

        return node.ValueKind switch
        {
            JsonValueKind.Number => node.TryGetInt64(out var value) ? value : 0,
            JsonValueKind.String => long.TryParse(node.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) ? value : 0,
            _ => 0,
        };
    }

    private static int ReadInt(JsonElement element, string name)
    {
        var value = ReadLong(element, name);
        return value is > int.MaxValue or < int.MinValue ? 0 : (int)value;
    }

    private sealed record KugouCredentials(string UserId, string Token, string Mid, string Dfid);
}

