# -*- coding: utf-8 -*-
"""Host: liked-status query API (/api/library/liked)."""
import io
import re

BASE = r"E:\Zilux2开发\src\Zilux2"


def read(path):
    return io.open(path, "r", encoding="utf-8", newline="").read()


def write(path, text):
    io.open(path, "w", encoding="utf-8", newline="").write(text)


def patch(path, pairs):
    text = read(path)
    for old, new in pairs:
        assert text.count(old) == 1, (path, old[:70])
        text = text.replace(old, new, 1)
    write(path, text)


# ---------- NetEase: CheckLikedAsync ----------
ne = BASE + r"\Online\Library\NeteaseLibraryProvider.cs"
ne_text = read(ne)
anchor = "    internal async Task AddLikedAsync(string trackId, CancellationToken cancellationToken)"
assert ne_text.count(anchor) == 1
method = '''    private HashSet<string>? _likedTrackIds;
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

'''
ne_text = ne_text.replace(anchor, method + anchor, 1)
write(ne, ne_text)

# ---------- QQ: CheckLikedAsync ----------
qq = BASE + r"\Online\Library\QqLibraryProvider.cs"
qq_text = read(qq)
anchor2 = "    internal async Task AddLikedAsync(string mid, CancellationToken cancellationToken)"
assert qq_text.count(anchor2) == 1
method2 = '''    internal async Task<bool> CheckLikedAsync(string mid, CancellationToken cancellationToken)
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

'''
qq_text = qq_text.replace(anchor2, method2 + anchor2, 1)
write(qq, qq_text)

# ---------- LibraryService dispatch ----------
svc = BASE + r"\Online\Library\LibraryService.cs"
svc_text = read(svc)
anchor3 = "    public async Task<LibraryRefreshResponse> AddLikedAsync("
assert svc_text.count(anchor3) == 1
method3 = '''    public async Task<bool> CheckLikedAsync(string source, string id, CancellationToken cancellationToken)
    {
        var provider = ResolveProvider(source);
        return provider switch
        {
            NeteaseLibraryProvider netease => await netease.CheckLikedAsync(id, cancellationToken).ConfigureAwait(false),
            QqLibraryProvider qq => await qq.CheckLikedAsync(id, cancellationToken).ConfigureAwait(false),
            _ => false,
        };
    }

'''
svc_text = svc_text.replace(anchor3, method3 + anchor3, 1)
write(svc, svc_text)

# ---------- LocalMusicServer route ----------
srv = BASE + r"\Online\LocalMusicServer.cs"
srv_text = read(srv)
old_route = '''            if (path == "/api/library/like")
            {'''
assert srv_text.count(old_route) == 1
new_route = '''            if (path == "/api/library/liked")
            {
                await HandleLibraryLikedAsync(context, cancellationToken).ConfigureAwait(false);
                return;
            }

            if (path == "/api/library/like")
            {'''
srv_text = srv_text.replace(old_route, new_route, 1)

# handler: insert before HandleLibraryLikeAsync
anchor4 = "    private async Task HandleLibraryLikeAsync("
assert srv_text.count(anchor4) == 1
handler = '''    private async Task HandleLibraryLikedAsync(HttpListenerContext context, CancellationToken cancellationToken)
    {
        var query = context.Request.QueryString;
        var source = query["source"] ?? string.Empty;
        var id = query["id"] ?? string.Empty;
        if (source.Length == 0 || id.Length == 0)
        {
            await WriteJsonAsync(context, 400, new { error = "bad-request", message = "缺少 source 或 id 参数" }, cancellationToken).ConfigureAwait(false);
            return;
        }

        try
        {
            var liked = await _library.CheckLikedAsync(source, id, cancellationToken).ConfigureAwait(false);
            await WriteJsonAsync(context, 200, new { liked }, cancellationToken).ConfigureAwait(false);
        }
        catch (OnlineUpstreamException error)
        {
            await WriteJsonAsync(context, error.StatusCode, new { error = "upstream-failed", message = error.Message }, cancellationToken).ConfigureAwait(false);
        }
    }

'''
srv_text = srv_text.replace(anchor4, handler + anchor4, 1)
write(srv, srv_text)
print("host liked status API patched")
