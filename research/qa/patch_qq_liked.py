# -*- coding: utf-8 -*-
"""QQ「我喜欢」改用 CgiGetDiss(dirid=201)（QQ 音乐客户端协议），替换返回 40000 的 SongFavRead。"""
import io

p = r'E:\Zilux2开发\src\Zilux2\Online\Library\QqLibraryProvider.cs'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

start = s.index('    private async Task<FavoritePage> GetFavoritesAsync(int offset, int limit, CancellationToken cancellationToken)')
# 括号配对找到方法结束
i = s.index('{', start)
depth = 0
end = None
while i < len(s):
    ch = s[i]
    if ch == '{':
        depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0:
            end = i + 1
            break
    i += 1
if end is None:
    raise SystemExit('method end not found')
while end < len(s) and s[end] in '\r\n':
    end += 1

new_method = '''    private async Task<FavoritePage> GetFavoritesAsync(int offset, int limit, CancellationToken cancellationToken)
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

'''
s = s[:start] + new_method + s[end:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('favorites switched to CgiGetDiss dirid=201')
