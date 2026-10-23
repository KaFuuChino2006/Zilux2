using System.Globalization;
using System.Text.Json;
using Zilux2.Online.Account;

namespace Zilux2.Online;

internal sealed class NeteaseProvider : IOnlineMusicProvider
{
    internal const string RefererUrl = "https://music.163.com/";
    private const string SearchEndpoint = "https://music.163.com/api/search/get/web";
    private const string DetailEndpoint = "https://music.163.com/api/song/detail";
    private const string PlayerUrlEndpoint = "https://music.163.com/api/song/enhance/player/url";
    private const string LyricEndpoint = "https://music.163.com/api/song/lyric";
    private const string PlaylistHotEndpoint = "https://music.163.com/api/playlist/list";

    private static readonly TimeSpan SearchTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan StreamTimeout = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan LyricTimeout = TimeSpan.FromSeconds(10);

    private readonly AccountService? _accounts;

    public NeteaseProvider(AccountService? accounts = null) => _accounts = accounts;

    public string Name => "netease";

    // Contract §4.4: once logged in, search/lyric/player-url must carry the MUSIC_U cookie.
    private string AccountCookie => _accounts?.CookieHeader(Name, "music.163.com") ?? string.Empty;

    /// <summary>网易云热门歌单（首页第二块）。</summary>
    public async Task<List<HotPlaylistItem>> GetHotPlaylistsAsync(int limit, CancellationToken cancellationToken)
    {
        var url = $"{PlaylistHotEndpoint}?cat={Uri.EscapeDataString("全部")}&order=hot&offset=0&total=true&limit={limit}";
        var upstream = await OnlineHttp
            .FetchTextAsync(url, RefererUrl, SearchTimeout, cancellationToken, cookie: AccountCookie)
            .ConfigureAwait(false);

        var items = new List<HotPlaylistItem>();
        using (var document = JsonDocument.Parse(upstream.Body))
        {
            var root = document.RootElement;
            var container = root.TryGetProperty("result", out var result) && result.ValueKind == JsonValueKind.Object
                ? result
                : root;
            if (container.TryGetProperty("playlists", out var list) && list.ValueKind == JsonValueKind.Array)
            {
                foreach (var element in list.EnumerateArray())
                {
                    var id = element.TryGetProperty("id", out var idElement) && idElement.ValueKind == JsonValueKind.Number
                        ? idElement.GetInt64().ToString(CultureInfo.InvariantCulture)
                        : string.Empty;
                    var title = ReadString(element, "name");
                    if (id.Length == 0 || title.Length == 0)
                    {
                        continue;
                    }

                    var cover = ReadString(element, "coverImgUrl");
                    if (cover.Length == 0)
                    {
                        cover = ReadString(element, "picUrl");
                    }

                    var count = element.TryGetProperty("playCount", out var countElement) && countElement.ValueKind == JsonValueKind.Number
                        ? countElement.GetInt64()
                        : 0;
                    var creator = string.Empty;
                    if (element.TryGetProperty("creator", out var creatorElement) && creatorElement.ValueKind == JsonValueKind.Object)
                    {
                        creator = ReadString(creatorElement, "nickname");
                    }

                    items.Add(new HotPlaylistItem(id, title, cover, count, creator));
                }
            }
        }

        OnlineHttp.Info($"GET netease/hotlists count={items.Count} {upstream.TookMs}ms");
        return items.Take(limit).ToList();
    }

    public async Task<List<OnlineTrack>> SearchAsync(string query, int limit, CancellationToken cancellationToken)
    {
        var url = $"{SearchEndpoint}?s={Uri.EscapeDataString(query)}&type=1&limit={limit}&offset=0";

        // Contract §4.3: upstreams flake; one retry 300ms apart is enough.
        JsonDocument document;
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                var upstream = await OnlineHttp
                    .FetchTextAsync(url, RefererUrl, SearchTimeout, cancellationToken, cookie: AccountCookie)
                    .ConfigureAwait(false);
                document = JsonDocument.Parse(upstream.Body);
                var initialTracks = ParseSongs(document.RootElement);
                OnlineHttp.Info($"GET netease/search q={query} ok {initialTracks.Count} tracks {upstream.TookMs}ms");
                break;
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                OnlineHttp.Warn($"GET netease/search q={query} failed: {OnlineHttp.Describe(exception)}");
                if (attempt >= 1)
                {
                    throw;
                }

                await Task.Delay(TimeSpan.FromMilliseconds(300), cancellationToken).ConfigureAwait(false);
            }
        }

        using (document)
        {
            var tracks = ParseSongs(document.RootElement);
            if (tracks.Count > 0)
            {
                await FillCoversAsync(tracks, cancellationToken).ConfigureAwait(false);
                await ApplyEntitlementsAsync(tracks, cancellationToken).ConfigureAwait(false);
            }

            return tracks;
        }
    }

    public async Task<LyricData> GetLyricAsync(string id, CancellationToken cancellationToken)
    {
        var url = $"{LyricEndpoint}?id={Uri.EscapeDataString(id)}&lv=-1&kv=-1&tv=-1&yv=-1&rv=-1";
        try
        {
            var upstream = await OnlineHttp
                .FetchTextAsync(url, RefererUrl, LyricTimeout, cancellationToken, cookie: AccountCookie)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(upstream.Body);
            var root = document.RootElement;
            var lrc = root.TryGetProperty("lrc", out var lrcElement) && lrcElement.ValueKind == JsonValueKind.Object
                ? ReadString(lrcElement, "lyric")
                : string.Empty;
            var translation = root.TryGetProperty("tlyric", out var translationElement) && translationElement.ValueKind == JsonValueKind.Object
                ? ReadString(translationElement, "lyric")
                : string.Empty;
            var yrc = root.TryGetProperty("yrc", out var yrcElement) && yrcElement.ValueKind == JsonValueKind.Object
                ? ReadString(yrcElement, "lyric")
                : string.Empty;
            OnlineHttp.Info($"GET netease/lyric id={id} ok lrcChars={lrc.Length} yrcChars={yrc.Length} {upstream.TookMs}ms");
            return new LyricData
            {
                Lrc = lrc,
                Translation = string.IsNullOrWhiteSpace(translation) ? null : translation,
                Yrc = string.IsNullOrWhiteSpace(yrc) ? null : yrc,
            };
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"GET netease/lyric id={id} failed: {OnlineHttp.Describe(exception)}");
            throw;
        }
    }

    public async Task<StreamResolution> ResolveStreamAsync(string id, string? quality, CancellationToken cancellationToken)
    {
        // 按请求的音质依次尝试，失败自动降级（无损需要会员，多数情况下会退到 320k）。
        foreach (var br in NeteaseBitRates(quality))
        {
            var resolution = await ResolveStreamOnceAsync(id, br, cancellationToken).ConfigureAwait(false);
            if (resolution.IsPlayable)
            {
                return resolution;
            }
        }
        return StreamResolution.NotPlayable("该歌曲需要网易云会员或已下架");
    }

    private static int[] NeteaseBitRates(string? quality) => (quality ?? string.Empty).Trim().ToLowerInvariant() switch
    {
        "lossless" => [999000, 320000, 128000],
        "standard" => [128000],
        _ => [320000, 128000],
    };

    private async Task<StreamResolution> ResolveStreamOnceAsync(string id, int br, CancellationToken cancellationToken)
    {
        // Contract §8: the mp3 URL carries expi=1200, so it is resolved fresh for every request.
        var url = $"{PlayerUrlEndpoint}?ids={Uri.EscapeDataString("[" + id + "]")}&br={br}";
        try
        {
            var upstream = await OnlineHttp
                .FetchTextAsync(url, RefererUrl, StreamTimeout, cancellationToken, cookie: AccountCookie)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(upstream.Body);
            var audioUrl = string.Empty;
            var actualBr = 0;
            var actualFormat = string.Empty;
            if (document.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in data.EnumerateArray())
                {
                    audioUrl = ReadString(item, "url");
                    actualBr = item.TryGetProperty("br", out var brElement) && brElement.TryGetInt32(out var brValue) ? brValue : 0;
                    actualFormat = ReadString(item, "type");
                    break;
                }
            }

            if (string.IsNullOrEmpty(audioUrl))
            {
                OnlineHttp.Info($"GET netease/player-url id={id} br={br} not-playable {upstream.TookMs}ms");
                return StreamResolution.NotPlayable("该歌曲需要网易云会员或已下架");
            }

            OnlineHttp.Info($"GET netease/player-url id={id} br={br} actual={actualBr} type={actualFormat} ok {upstream.TookMs}ms");
            return StreamResolution.Playable(
                audioUrl,
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Referer"] = RefererUrl,
                },
                actualBr >= 900000 ? "无损" : actualBr >= 300000 ? "高音质" : "标准",
                actualBr,
                actualFormat);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"GET netease/player-url id={id} br={br} failed: {OnlineHttp.Describe(exception)}");
            throw;
        }
    }

    private static List<OnlineTrack> ParseSongs(JsonElement root)
    {
        var tracks = new List<OnlineTrack>();
        if (!root.TryGetProperty("result", out var result) ||
            !result.TryGetProperty("songs", out var songs) ||
            songs.ValueKind != JsonValueKind.Array)
        {
            return tracks;
        }

        foreach (var song in songs.EnumerateArray())
        {
            var id = song.TryGetProperty("id", out var idElement) ? idElement.ToString() : string.Empty;
            if (string.IsNullOrEmpty(id))
            {
                continue;
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

            var fee = song.TryGetProperty("fee", out var feeElement) && feeElement.TryGetInt32(out var feeValue)
                ? feeValue
                : 0;
            var album = song.TryGetProperty("album", out var albumElement) && albumElement.ValueKind == JsonValueKind.Object
                ? ReadString(albumElement, "name")
                : string.Empty;

            tracks.Add(new OnlineTrack
            {
                Source = "netease",
                Id = id,
                Title = ReadString(song, "name"),
                Artist = string.Join(" / ", artists),
                Album = album,
                DurationMs = song.TryGetProperty("duration", out var durationElement) && durationElement.TryGetInt64(out var duration)
                    ? duration
                    : 0,
                // Contract §3: fee 0 free, fee 8 free-but-lower-bitrate; 1/4 are VIP/purchase.
                Playable = fee is 0 or 8,
                Vip = fee is not (0 or 8),
            });
        }

        return tracks;
    }

    private async Task FillCoversAsync(List<OnlineTrack> tracks, CancellationToken cancellationToken)
    {
        // The search endpoint does not return album.picUrl, so covers need one batched detail call.
        var ids = string.Join(",", tracks.Select(track => track.Id));
        var url = $"{DetailEndpoint}?ids={Uri.EscapeDataString("[" + ids + "]")}";
        try
        {
            var upstream = await OnlineHttp
                .FetchTextAsync(url, RefererUrl, SearchTimeout, cancellationToken, cookie: AccountCookie)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(upstream.Body);
            var covers = new Dictionary<string, string>(StringComparer.Ordinal);
            if (document.RootElement.TryGetProperty("songs", out var songs) && songs.ValueKind == JsonValueKind.Array)
            {
                foreach (var song in songs.EnumerateArray())
                {
                    var id = song.TryGetProperty("id", out var idElement) ? idElement.ToString() : string.Empty;
                    if (id.Length == 0)
                    {
                        continue;
                    }

                    if (song.TryGetProperty("album", out var album) &&
                        album.ValueKind == JsonValueKind.Object &&
                        album.TryGetProperty("picUrl", out var picUrl) &&
                        picUrl.ValueKind == JsonValueKind.String)
                    {
                        covers[id] = picUrl.GetString() ?? string.Empty;
                    }
                }
            }

            for (var index = 0; index < tracks.Count; index++)
            {
                if (covers.TryGetValue(tracks[index].Id, out var coverKey) && coverKey.Length > 0)
                {
                    tracks[index] = tracks[index] with { CoverKey = coverKey };
                }
            }

            OnlineHttp.Info($"GET netease/detail ids={tracks.Count} ok {covers.Count} covers {upstream.TookMs}ms");
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // Covers are decorative: a failed detail call must not fail the search.
            OnlineHttp.Warn($"GET netease/detail ids={tracks.Count} failed (covers skipped): {OnlineHttp.Describe(exception)}");
        }
    }

    // Contract §4.4: after login, fee=1 tracks may become playable; the only reliable entitlement
    // signal is whether player-url actually returns a URL, so candidates are checked in one batch.
    private async Task ApplyEntitlementsAsync(List<OnlineTrack> tracks, CancellationToken cancellationToken)
    {
        if (_accounts is null || !_accounts.IsLoggedIn(Name))
        {
            return;
        }

        var candidates = tracks.Where(track => !track.Playable).ToList();
        if (candidates.Count == 0)
        {
            return;
        }

        try
        {
            var ids = string.Join(",", candidates.Select(track => track.Id));
            var url = $"{PlayerUrlEndpoint}?ids={Uri.EscapeDataString("[" + ids + "]")}&br=320000";
            var upstream = await OnlineHttp
                .FetchTextAsync(url, RefererUrl, StreamTimeout, cancellationToken, cookie: AccountCookie)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(upstream.Body);
            var playable = ParsePlayableIds(document.RootElement);
            var updated = 0;
            for (var index = 0; index < tracks.Count; index++)
            {
                if (!tracks[index].Playable && playable.Contains(tracks[index].Id))
                {
                    tracks[index] = tracks[index] with { Playable = true };
                    updated++;
                }
            }

            OnlineHttp.Info($"GET netease/player-url batch ids={candidates.Count} playable={updated} {upstream.TookMs}ms");
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"GET netease/player-url batch ids={candidates.Count} failed: {OnlineHttp.Describe(exception)}");
        }
    }

    private static HashSet<string> ParsePlayableIds(JsonElement root)
    {
        var playable = new HashSet<string>(StringComparer.Ordinal);
        if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
        {
            return playable;
        }

        foreach (var item in data.EnumerateArray())
        {
            var id = item.TryGetProperty("id", out var idElement) ? idElement.ToString() : string.Empty;
            if (id.Length > 0 && ReadString(item, "url").Length > 0)
            {
                playable.Add(id);
            }
        }

        return playable;
    }

    private static string ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;
}
