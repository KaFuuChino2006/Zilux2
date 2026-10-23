"""首页第二大块：网易云热门歌单（宿主 /api/playlists/hot 支持 netease + 首页渲染）。"""
import io

NETEASE = r'E:\Zilux2开发\src\Zilux2\Online\NeteaseProvider.cs'
SERVER = r'E:\Zilux2开发\src\Zilux2\Online\LocalMusicServer.cs'
HOME = r'E:\Zilux2开发\web\src\ui\home.ts'
APP = r'E:\Zilux2开发\web\src\ui\app.ts'


def patch(path, steps):
    text = io.open(path, 'r', encoding='utf-8', newline='').read()
    eol = '\r\n' if '\r\n' in text else '\n'
    for label, old, new in steps:
        old = old.replace('\n', eol)
        new = new.replace('\n', eol)
        count = text.count(old)
        assert count == 1, f'{path} / {label}: found {count}'
        text = text.replace(old, new)
        print(f'ok {label}')
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


# ---------------- 宿主：NeteaseProvider 加热门歌单 ----------------
patch(NETEASE, [
    (
        'using globalization',
        'using System.Text.Json;\n',
        'using System.Globalization;\nusing System.Text.Json;\n',
    ),
    (
        'hot endpoint const',
        '    private const string LyricEndpoint = "https://music.163.com/api/song/lyric";\n',
        '    private const string LyricEndpoint = "https://music.163.com/api/song/lyric";\n'
        '    private const string PlaylistHotEndpoint = "https://music.163.com/api/playlist/list";\n',
    ),
    (
        'hot method',
        '    public async Task<List<OnlineTrack>> SearchAsync(string query, int limit, CancellationToken cancellationToken)\n',
        '    /// <summary>网易云热门歌单（首页第二块）。</summary>\n'
        '    public async Task<List<HotPlaylistItem>> GetHotPlaylistsAsync(int limit, CancellationToken cancellationToken)\n'
        '    {\n'
        '        var url = $"{PlaylistHotEndpoint}?cat={Uri.EscapeDataString("全部")}&order=hot&offset=0&total=true&limit={limit}";\n'
        '        var upstream = await OnlineHttp\n'
        '            .FetchTextAsync(url, RefererUrl, SearchTimeout, cancellationToken, cookie: AccountCookie)\n'
        '            .ConfigureAwait(false);\n'
        '\n'
        '        var items = new List<HotPlaylistItem>();\n'
        '        using (var document = JsonDocument.Parse(upstream.Body))\n'
        '        {\n'
        '            if (document.RootElement.TryGetProperty("result", out var result) &&\n'
        '                result.TryGetProperty("playlists", out var list) &&\n'
        '                list.ValueKind == JsonValueKind.Array)\n'
        '            {\n'
        '                foreach (var element in list.EnumerateArray())\n'
        '                {\n'
        '                    var id = element.TryGetProperty("id", out var idElement) && idElement.ValueKind == JsonValueKind.Number\n'
        '                        ? idElement.GetInt64().ToString(CultureInfo.InvariantCulture)\n'
        '                        : string.Empty;\n'
        '                    var title = ReadText(element, "name");\n'
        '                    if (id.Length == 0 || title.Length == 0)\n'
        '                    {\n'
        '                        continue;\n'
        '                    }\n'
        '\n'
        '                    var cover = ReadText(element, "coverImgUrl");\n'
        '                    if (cover.Length == 0)\n'
        '                    {\n'
        '                        cover = ReadText(element, "picUrl");\n'
        '                    }\n'
        '\n'
        '                    var count = element.TryGetProperty("playCount", out var countElement) && countElement.ValueKind == JsonValueKind.Number\n'
        '                        ? countElement.GetInt64()\n'
        '                        : 0;\n'
        '                    var creator = string.Empty;\n'
        '                    if (element.TryGetProperty("creator", out var creatorElement) && creatorElement.ValueKind == JsonValueKind.Object)\n'
        '                    {\n'
        '                        creator = ReadText(creatorElement, "nickname");\n'
        '                    }\n'
        '\n'
        '                    items.Add(new HotPlaylistItem(id, title, cover, count, creator));\n'
        '                }\n'
        '            }\n'
        '        }\n'
        '\n'
        '        OnlineHttp.Info($"GET netease/hotlists count={items.Count} {upstream.TookMs}ms");\n'
        '        return items.Take(limit).ToList();\n'
        '    }\n'
        '\n'
        '    public async Task<List<OnlineTrack>> SearchAsync(string query, int limit, CancellationToken cancellationToken)\n',
    ),
])

# ---------------- 宿主：/api/playlists/hot 支持 netease ----------------
patch(SERVER, [
    (
        'hot source switch',
        '''        var source = (query["source"] ?? "qq").Trim().ToLowerInvariant();
        if (source != AccountSources.Qq ||
            !_providers.TryGetValue(AccountSources.Qq, out var provider) ||
            provider is not QqProvider qqProvider)
        {
            return WriteError(context, 400, "bad-request", "热门歌单目前只支持 QQ 音乐");
        }
''',
        '''        var source = (query["source"] ?? "qq").Trim().ToLowerInvariant();
        if (source != AccountSources.Qq && source != AccountSources.Netease)
        {
            return WriteError(context, 400, "bad-request", "热门歌单目前支持 QQ 音乐与网易云音乐");
        }
''',
    ),
    (
        'hot provider call',
        '''            var items = await qqProvider.GetHotPlaylistsAsync(limit, _shutdown.Token).ConfigureAwait(false);
            var playlists = items
                .Select(item => new
                {
                    source = AccountSources.Qq,
                    id = item.Id,
                    title = item.Title,
                    cover = BuildCoverUrl(AccountSources.Qq, item.ImageUrl),
                    count = item.ListenCount,
                    creator = item.Creator,
                })
                .ToList();
            WriteJson(context, 200, JsonSerializer.Serialize(new { source = AccountSources.Qq, playlists }));
            return 200;
''',
        '''            List<HotPlaylistItem> items;
            if (source == AccountSources.Netease)
            {
                var neteaseProvider = (NeteaseProvider)GetProvider(AccountSources.Netease)!;
                items = await neteaseProvider.GetHotPlaylistsAsync(limit, _shutdown.Token).ConfigureAwait(false);
            }
            else
            {
                var qqProvider = (QqProvider)GetProvider(AccountSources.Qq)!;
                items = await qqProvider.GetHotPlaylistsAsync(limit, _shutdown.Token).ConfigureAwait(false);
            }

            var playlists = items
                .Select(item => new
                {
                    source,
                    id = item.Id,
                    title = item.Title,
                    cover = BuildCoverUrl(source, item.ImageUrl),
                    count = item.ListenCount,
                    creator = item.Creator,
                })
                .ToList();
            WriteJson(context, 200, JsonSerializer.Serialize(new { source, playlists }));
            return 200;
''',
    ),
])

# ---------------- 前端：HomeData + 第二段歌单 ----------------
patch(HOME, [
    (
        'home data field',
        '  playlists: LibraryPlaylist[];\n',
        '  playlists: LibraryPlaylist[];\n'
        '  /** 网易云热门歌单（第二块） */\n'
        '  neteasePlaylists: LibraryPlaylist[];\n',
    ),
    (
        'update sections',
        """    const playlists = this.buildPlaylistSection(data);
    if (playlists) this.root.append(playlists);
""",
        """    const playlists = this.buildPlaylistSection(data.playlists, '热门歌单', true);
    if (playlists) this.root.append(playlists);

    const neteasePlaylists = this.buildPlaylistSection(data.neteasePlaylists, '网易云热门歌单', false);
    if (neteasePlaylists) this.root.append(neteasePlaylists);
""",
    ),
    (
        'section signature',
        """  private buildPlaylistSection(data: HomeData): HTMLElement | null {
    if (data.playlists.length === 0) return null;
    const section = h('section', { class: ui.section() });
    const more = h('button', { class: ui.sectionMore() }, h('span', { text: '全部歌单' }));
    more.addEventListener('click', () => this.callbacks.onRecommend());
    const head = h(
      'div',
      { class: ui.sectionHead() },
      h('h2', { class: ui.sectionTitle(), text: '热门歌单' }),
      more,
    );
""",
        """  private buildPlaylistSection(items: LibraryPlaylist[], title: string, withMore: boolean): HTMLElement | null {
    if (items.length === 0) return null;
    const section = h('section', { class: ui.section() });
    const head = h(
      'div',
      { class: ui.sectionHead() },
      h('h2', { class: ui.sectionTitle(), text: title }),
    );
    if (withMore) {
      const more = h('button', { class: ui.sectionMore() }, h('span', { text: '全部歌单' }));
      more.addEventListener('click', () => this.callbacks.onRecommend());
      head.append(more);
    }
""",
    ),
    (
        'section loop',
        '    data.playlists.forEach((item) => {\n',
        '    items.forEach((item) => {\n',
    ),
])

# ---------------- 前端：app 拉网易云热门歌单 ----------------
patch(APP, [
    (
        'netease playlist container',
        '    const playlists: LibraryPlaylist[] = [];\n',
        '    const playlists: LibraryPlaylist[] = [];\n    const neteasePlaylists: LibraryPlaylist[] = [];\n',
    ),
    (
        'netease hot fetch',
        """    } catch (err) {
      console.warn('[app] hot playlists failed', err);
    }
""",
        """    } catch (err) {
      console.warn('[app] hot playlists failed', err);
    }
    try {
      const hotNetease = await fetchHotPlaylists('netease', 14);
      neteasePlaylists.push(
        ...hotNetease.map((item) => ({
          source: item.source,
          id: item.id,
          title: item.title,
          cover: item.cover,
          count: item.count,
          creator: item.creator,
        })),
      );
    } catch (err) {
      console.warn('[app] netease hot playlists failed', err);
    }
""",
    ),
    (
        'netease data field',
        '      playlists: playlists.slice(0, 14),\n',
        '      playlists: playlists.slice(0, 14),\n      neteasePlaylists: neteasePlaylists.slice(0, 14),\n',
    ),
])
print('all done')
