using System.Globalization;
using System.Text;
using System.Text.Json;
using Zilux2.Online.Account;

namespace Zilux2.Online.Discover;

// 发现页数据源（research/discover-api.md v1）。两类上游：
//   netease —— music.163.com 的 web 接口，登录后带 MUSIC_U cookie，几乎全部能力可用；
//   qq      —— c.y.qq.com 的旧版 json 接口（音乐馆/排行榜/歌单广场/专辑），musicu.fcg 只用于搜索。
// 约定：任何上游失败都抛 DiscoverException 或 OnlineUpstreamException，由 LocalMusicServer 统一转错误响应；
// 所有曲目封面只保留 key，交给宿主重写成回环 /api/cover 地址。
internal sealed class DiscoverService
{
    private const string NeteaseBase = "https://music.163.com";
    private const string NeteaseReferer = "https://music.163.com/";
    private const string QqReferer = "https://y.qq.com/";
    private const string QqCgiReferer = "https://c.y.qq.com/";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(12);
    private static readonly TimeSpan LongTimeout = TimeSpan.FromSeconds(15);

    // QQ 榜单目录优先走 musicu 的 musicToplist.ToplistInfoServer/GetAll（含分组与封面）；
    // 这里保留一份常用榜单作为上游失败时的兜底。
    private static readonly (string Id, string Title, string Frequency)[] QqFallbackCharts =
    [
        ("26", "热歌榜", "每天更新"),
        ("62", "飙升榜", "每天更新"),
        ("4", "新歌榜", "每天更新"),
        ("27", "经典老歌榜", "每周更新"),
        ("5", "内地榜", "每周更新"),
        ("6", "港台榜", "每周更新"),
        ("3", "欧美榜", "每周更新"),
        ("16", "韩国榜", "每周更新"),
        ("17", "日本榜", "每周更新"),
    ];

    private static readonly HashSet<string> NeteaseFeaturedCharts =
    [
        "19723756", "3779629", "2884035", "3778678",
    ];

    private readonly AccountService? _accounts;
    private readonly Func<string, string, string> _coverUrl;

    public DiscoverService(AccountService? accounts, Func<string, string, string> coverUrl)
    {
        _accounts = accounts;
        _coverUrl = coverUrl;
    }

    private static readonly Encoding Gb18030 = CreateGb18030Encoding();

    private static readonly System.Text.RegularExpressions.Regex QqCommentEmojiPattern =
        new(@"\[em\]e\d+\[/em\]", System.Text.RegularExpressions.RegexOptions.Compiled);

    private static Encoding CreateGb18030Encoding()
    {
        // 静态字段初始化先于静态构造函数执行，必须在这里注册 CodePages provider，
        // 否则 GetEncoding("gb18030") 会抛 ArgumentException（No data is available for encoding 54936）。
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        return Encoding.GetEncoding("gb18030");
    }

    private string NeteaseCookie => _accounts?.CookieHeader("netease", "music.163.com") ?? string.Empty;

    private string QqCookie => _accounts?.CookieHeader("qq", "c.y.qq.com") ?? string.Empty;

    // ── 排行榜目录 ───────────────────────────────────────────────────────────────

    public async Task<DiscoverChartsResponse> GetChartsAsync(string? source, CancellationToken cancellationToken)
    {
        var groups = new List<DiscoverGroup>();
        if (source is null or "netease")
        {
            groups.Add(await BuildNeteaseChartsAsync(cancellationToken).ConfigureAwait(false));
        }

        if (source is null or "qq")
        {
            groups.Add(await BuildQqChartsAsync(cancellationToken).ConfigureAwait(false));
        }

        return new DiscoverChartsResponse { Groups = groups };
    }

    private async Task<DiscoverGroup> BuildNeteaseChartsAsync(CancellationToken cancellationToken)
    {
        using var document = await FetchJsonAsync(
                $"{NeteaseBase}/api/toplist",
                NeteaseReferer,
                NeteaseCookie,
                Timeout,
                cancellationToken)
            .ConfigureAwait(false);

        var featured = new List<DiscoverChart>();
        var media = new List<DiscoverChart>();
        if (document.RootElement.TryGetProperty("list", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in list.EnumerateArray())
            {
                var id = ReadId(element, "id");
                if (id.Length == 0)
                {
                    continue;
                }

                var chart = new DiscoverChart
                {
                    Id = id,
                    Title = ReadString(element, "name"),
                    Cover = _coverUrl("netease", ReadString(element, "coverImgUrl")),
                    Count = ReadLong(element, "trackCount"),
                    UpdateFrequency = ReadString(element, "updateFrequency"),
                };
                (NeteaseFeaturedCharts.Contains(id) ? featured : media).Add(chart);
            }
        }

        var categories = new List<DiscoverChartCategory>();
        if (featured.Count > 0)
        {
            categories.Add(new DiscoverChartCategory { Title = "云音乐特色榜", Charts = featured });
        }

        if (media.Count > 0)
        {
            categories.Add(new DiscoverChartCategory { Title = "全球媒体榜", Charts = media });
        }

        return new DiscoverGroup { Source = "netease", Label = "网易云音乐", Categories = categories };
    }

    private async Task<DiscoverGroup> BuildQqChartsAsync(CancellationToken cancellationToken)
    {
        var categories = new List<DiscoverChartCategory>();
        try
        {
            const string payload = "{\"comm\":{\"ct\":24,\"cv\":0},\"toplist\":{\"module\":\"musicToplist.ToplistInfoServer\",\"method\":\"GetAll\",\"param\":{}}}";
            var url = "https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=" + Uri.EscapeDataString(payload);
            using var document = await FetchJsonBytesAsUtf8Async(url, "https://y.qq.com/", QqCookie, Timeout, cancellationToken)
                .ConfigureAwait(false);
            if (document.RootElement.TryGetProperty("toplist", out var toplist) &&
                toplist.ValueKind == JsonValueKind.Object &&
                toplist.TryGetProperty("data", out var data) &&
                data.ValueKind == JsonValueKind.Object &&
                data.TryGetProperty("group", out var groupArray) &&
                groupArray.ValueKind == JsonValueKind.Array)
            {
                foreach (var group in groupArray.EnumerateArray())
                {
                    var charts = new List<DiscoverChart>();
                    if (group.TryGetProperty("toplist", out var items) && items.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in items.EnumerateArray())
                        {
                            var id = ReadId(item, "topId");
                            var title = ReadString(item, "title");
                            if (id.Length == 0 || title.Length == 0)
                            {
                                continue;
                            }

                            var isWeekly = ReadLong(item, "updateType") != 1;
                            charts.Add(new DiscoverChart
                            {
                                Id = id,
                                Title = title,
                                Cover = QqToplistCover(item),
                                Count = ReadLong(item, "totalNum"),
                                UpdateFrequency = isWeekly ? "每周更新" : "每天更新",
                            });
                        }
                    }

                    if (charts.Count > 0)
                    {
                        var groupTitle = ReadString(group, "groupName");
                        categories.Add(new DiscoverChartCategory
                        {
                            Title = groupTitle.Length > 0 ? groupTitle : "排行榜",
                            Charts = charts,
                        });
                    }
                }
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"discover qq charts failed: {OnlineHttp.Describe(exception)}");
        }

        if (categories.Count == 0)
        {
            categories.Add(new DiscoverChartCategory
            {
                Title = "QQ 音乐排行榜",
                Charts = QqFallbackCharts
                    .Select(item => new DiscoverChart
                    {
                        Id = item.Id,
                        Title = item.Title,
                        UpdateFrequency = item.Frequency,
                    })
                    .ToList(),
            });
        }

        return new DiscoverGroup { Source = "qq", Label = "QQ 音乐", Categories = categories };
    }

    /// <summary>
    /// QQ 榜单封面：musicu 目录用 frontPicUrl，榜单详情 topinfo 用 pic_v12/picDetail 等；
    /// 统一转 https，并把已失效的 imgcache.qq.com 换成 y.gtimg.cn 后走宿主代理。
    /// </summary>
    private string QqToplistCover(JsonElement item)
    {
        foreach (var field in new[]
                 {
                     "frontPicUrl", "pic_v12", "headPic_v12", "picDetail", "pic_h5", "pic_v11",
                     "MacDetailPicUrl", "headPicUrl", "mbFrontPicUrl", "mbHeadPicUrl", "musichallPicUrl", "pic",
                 })
        {
            var raw = NormalizeQqImageUrl(ReadString(item, field));
            if (raw.Length > 0)
            {
                return _coverUrl("qq", raw);
            }
        }

        return string.Empty;
    }

    private static string NormalizeQqImageUrl(string raw)
    {
        if (raw.Length == 0)
        {
            return string.Empty;
        }

        if (raw.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
        {
            raw = "https://" + raw[7..];
        }

        if (!raw.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            return string.Empty;
        }

        // QQ 的 imgcache.qq.com/music/photo_new 已返回 400，同资源在 y.gtimg.cn 可用。
        const string brokenHost = "https://imgcache.qq.com/music/photo_new/";
        if (raw.StartsWith(brokenHost, StringComparison.OrdinalIgnoreCase))
        {
            raw = "https://y.gtimg.cn/music/photo_new/" + raw[brokenHost.Length..];
        }

        return raw;
    }

    // ── 榜单详情 ─────────────────────────────────────────────────────────────────

    public async Task<DiscoverChartResponse> GetChartAsync(
        string source,
        string id,
        int offset,
        int limit,
        CancellationToken cancellationToken)
    {
        if (id.Length == 0)
        {
            throw new DiscoverException(400, "bad-request", "缺少榜单 id");
        }

        return source == "qq"
            ? await GetQqChartAsync(id, offset, limit, cancellationToken).ConfigureAwait(false)
            : await GetNeteaseChartAsync(id, offset, limit, cancellationToken).ConfigureAwait(false);
    }

    private async Task<DiscoverChartResponse> GetNeteaseChartAsync(
        string id,
        int offset,
        int limit,
        CancellationToken cancellationToken)
    {
        var title = "排行榜";
        var cover = string.Empty;
        var count = 0L;
        using (var detail = await FetchJsonAsync(
                       $"{NeteaseBase}/api/v6/playlist/detail?id={Uri.EscapeDataString(id)}",
                       NeteaseReferer,
                       NeteaseCookie,
                       Timeout,
                       cancellationToken)
                   .ConfigureAwait(false))
        {
            if (detail.RootElement.TryGetProperty("playlist", out var playlist) &&
                playlist.ValueKind == JsonValueKind.Object)
            {
                title = ReadString(playlist, "name");
                cover = _coverUrl("netease", ReadString(playlist, "coverImgUrl"));
                count = ReadLong(playlist, "trackCount");
            }
        }

        var tracks = new List<OnlineTrack>();
        try
        {
            // /api/playlist/track/all 已下线（404 接口未找到）。v2 playlist detail 支持 n/s 分页，
            // 返回的 playlist.tracks 就是分页后的歌曲列表。
            using var paged = await FetchJsonAsync(
                    $"{NeteaseBase}/api/v2/playlist/detail?id={Uri.EscapeDataString(id)}&n={limit}&s={offset}",
                    NeteaseReferer,
                    NeteaseCookie,
                    LongTimeout,
                    cancellationToken)
                .ConfigureAwait(false);
            if (paged.RootElement.TryGetProperty("playlist", out var pagedPlaylist) &&
                pagedPlaylist.ValueKind == JsonValueKind.Object &&
                pagedPlaylist.TryGetProperty("tracks", out var songs) &&
                songs.ValueKind == JsonValueKind.Array)
            {
                tracks = ParseNeteaseSongs(songs);
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"discover netease chart tracks failed id={id}: {OnlineHttp.Describe(exception)}");
        }

        var hasMore = tracks.Count > 0 && (count <= 0 || offset + tracks.Count < count);
        return new DiscoverChartResponse
        {
            Source = "netease",
            Id = id,
            Title = title,
            Cover = cover,
            Count = count,
            Tracks = tracks,
            HasMore = hasMore,
        };
    }

    private async Task<DiscoverChartResponse> GetQqChartAsync(
        string id,
        int offset,
        int limit,
        CancellationToken cancellationToken)
    {
        var url = $"https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid={Uri.EscapeDataString(id)}" +
                  $"&page=detail&type=top&song_begin={offset}&song_num={limit}&format=json";
        using var document = await FetchJsonBytesAsUtf8Async(url, QqCgiReferer, QqCookie, Timeout, cancellationToken)
            .ConfigureAwait(false);

        var root = document.RootElement;
        var title = QqFallbackCharts.FirstOrDefault(item => item.Id == id).Title ?? "排行榜";
        var cover = string.Empty;
        if (root.TryGetProperty("topinfo", out var info) && info.ValueKind == JsonValueKind.Object)
        {
            title = ReadString(info, "ListName");
            if (title.Length == 0)
            {
                title = ReadString(info, "Title");
            }

            cover = QqToplistCover(info);
            if (cover.Length == 0)
            {
                var album = NormalizeQqImageUrl(ReadString(info, "pic_album"));
                if (album.Length > 0)
                {
                    cover = _coverUrl("qq", album);
                }
            }
        }

        var tracks = new List<OnlineTrack>();
        if (root.TryGetProperty("songlist", out var songlist) && songlist.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in songlist.EnumerateArray())
            {
                if (entry.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
                {
                    tracks.Add(ParseQqSong(data));
                }
            }
        }

        var total = ReadLong(root, "total_song_num");
        if (total <= 0)
        {
            total = tracks.Count;
        }

        return new DiscoverChartResponse
        {
            Source = "qq",
            Id = id,
            Title = title,
            Cover = cover,
            Count = total,
            Tracks = tracks,
            HasMore = tracks.Count > 0 && offset + tracks.Count < total,
        };
    }

    // ── 歌单分类 / 广场 ─────────────────────────────────────────────────────────

    public async Task<DiscoverCatsResponse> GetCatsAsync(string source, CancellationToken cancellationToken)
    {
        if (source == "qq")
        {
            return new DiscoverCatsResponse
            {
                Source = "qq",
                Categories = [new DiscoverCat { Id = "全部", Name = "全部" }],
            };
        }

        using var document = await FetchJsonAsync(
                $"{NeteaseBase}/api/playlist/catalogue",
                NeteaseReferer,
                NeteaseCookie,
                Timeout,
                cancellationToken)
            .ConfigureAwait(false);

        var categories = new List<DiscoverCat> { new() { Id = "全部", Name = "全部" } };
        if (document.RootElement.TryGetProperty("sub", out var sub) && sub.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in sub.EnumerateArray())
            {
                var name = ReadString(element, "name");
                if (name.Length == 0)
                {
                    continue;
                }

                categories.Add(new DiscoverCat { Id = name, Name = name });
            }
        }

        return new DiscoverCatsResponse { Source = "netease", Categories = categories };
    }

    public async Task<DiscoverPlaylistsResponse> GetPlaylistsAsync(
        string source,
        string category,
        string order,
        int offset,
        int limit,
        CancellationToken cancellationToken)
    {
        return source == "qq"
            ? await GetQqPlaylistsAsync(order, offset, limit, cancellationToken).ConfigureAwait(false)
            : await GetNeteasePlaylistsAsync(category, order, offset, limit, cancellationToken).ConfigureAwait(false);
    }

    private async Task<DiscoverPlaylistsResponse> GetNeteasePlaylistsAsync(
        string category,
        string order,
        int offset,
        int limit,
        CancellationToken cancellationToken)
    {
        var cat = category.Length == 0 ? "全部" : category;
        var sort = order == "new" ? "new" : "hot";
        var url = $"{NeteaseBase}/api/playlist/list?cat={Uri.EscapeDataString(cat)}&order={sort}" +
                  $"&offset={offset}&total=true&limit={limit}";
        using var document = await FetchJsonAsync(url, NeteaseReferer, NeteaseCookie, Timeout, cancellationToken)
            .ConfigureAwait(false);

        var playlists = new List<PlaylistCard>();
        if (document.RootElement.TryGetProperty("playlists", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in list.EnumerateArray())
            {
                var id = ReadId(element, "id");
                if (id.Length == 0)
                {
                    continue;
                }

                var creator = string.Empty;
                if (element.TryGetProperty("creator", out var creatorElement) &&
                    creatorElement.ValueKind == JsonValueKind.Object)
                {
                    creator = ReadString(creatorElement, "nickname");
                }

                playlists.Add(new PlaylistCard
                {
                    Source = "netease",
                    Id = id,
                    Title = ReadString(element, "name"),
                    Cover = _coverUrl("netease", ReadString(element, "coverImgUrl")),
                    Count = ReadLong(element, "playCount"),
                    Creator = creator,
                });
            }
        }

        var more = document.RootElement.TryGetProperty("more", out var moreElement) &&
                   moreElement.ValueKind == JsonValueKind.True;
        return new DiscoverPlaylistsResponse
        {
            Source = "netease",
            Cat = cat,
            Playlists = playlists,
            HasMore = more,
        };
    }

    private async Task<DiscoverPlaylistsResponse> GetQqPlaylistsAsync(
        string order,
        int offset,
        int limit,
        CancellationToken cancellationToken)
    {
        var sortId = order == "new" ? 6 : 5;
        var url = "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg" +
                  $"?categoryId=10000000&sortId={sortId}&sin={offset}&ein={offset + Math.Max(1, limit) - 1}&format=json";
        using var document = await FetchJsonGbAsync(url, QqCgiReferer, QqCookie, Timeout, cancellationToken)
            .ConfigureAwait(false);

        var playlists = new List<PlaylistCard>();
        var sum = 0L;
        if (document.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
        {
            sum = ReadLong(data, "sum");
            if (data.TryGetProperty("list", out var list) && list.ValueKind == JsonValueKind.Array)
            {
                foreach (var element in list.EnumerateArray())
                {
                    var id = ReadId(element, "dissid");
                    if (id.Length == 0)
                    {
                        continue;
                    }

                    playlists.Add(new PlaylistCard
                    {
                        Source = "qq",
                        Id = id,
                        Title = ReadString(element, "dissname"),
                        Cover = _coverUrl("qq", QqCoverUrl(ReadString(element, "imgurl"))),
                        Count = ReadLong(element, "listennum"),
                    });
                }
            }
        }

        return new DiscoverPlaylistsResponse
        {
            Source = "qq",
            Cat = "全部",
            Playlists = playlists,
            HasMore = offset + playlists.Count < sum,
        };
    }

    /// <summary>
    /// QQ 歌单广场返回的封面是 http://qpic.y.qq.com/...，页面是 https，必须改 https 再交给宿主封面代理，
    /// 否则会被混合内容拦截（宿主 cover 代理允许 qq.com/qpic.cn 等白名单域名的完整 URL）。
    /// </summary>
    private static string QqCoverUrl(string url)
    {
        if (url.Length == 0)
        {
            return string.Empty;
        }

        return url.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            ? string.Concat("https://", url.AsSpan("http://".Length))
            : url;
    }

    // ── 私人漫游 ─────────────────────────────────────────────────────────────────

    public async Task<DiscoverRadioResponse> GetRadioAsync(int count, CancellationToken cancellationToken)
    {
        using var document = await FetchJsonAsync(
                $"{NeteaseBase}/api/v1/radio/get",
                NeteaseReferer,
                NeteaseCookie,
                Timeout,
                cancellationToken)
            .ConfigureAwait(false);

        var tracks = new List<OnlineTrack>();
        if (document.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in data.EnumerateArray())
            {
                var track = ParseNeteaseSong(element);
                if (track.Id.Length > 0)
                {
                    tracks.Add(track);
                }
            }
        }

        if (count > 0 && tracks.Count > count)
        {
            tracks = tracks.Take(count).ToList();
        }

        return new DiscoverRadioResponse { Source = "netease", Tracks = tracks };
    }

    // ── 歌手 / 专辑 ──────────────────────────────────────────────────────────────

    public async Task<DiscoverArtistResponse> GetArtistAsync(
        string source,
        string id,
        int limit,
        CancellationToken cancellationToken)
    {
        if (id.Length == 0)
        {
            throw new DiscoverException(400, "bad-request", "缺少歌手 id");
        }

        if (source == "qq")
        {
            return await GetQqArtistAsync(id, limit, cancellationToken).ConfigureAwait(false);
        }

        using var document = await FetchJsonAsync(
                $"{NeteaseBase}/api/v1/artist/{Uri.EscapeDataString(id)}",
                NeteaseReferer,
                NeteaseCookie,
                Timeout,
                cancellationToken)
            .ConfigureAwait(false);

        var root = document.RootElement;
        var name = string.Empty;
        var avatar = string.Empty;
        var description = string.Empty;
        var followed = false;
        var hotSongs = new List<OnlineTrack>();
        if (root.TryGetProperty("artist", out var artist) && artist.ValueKind == JsonValueKind.Object)
        {
            name = ReadString(artist, "name");
            avatar = _coverUrl("netease", ReadString(artist, "avatar"));
            if (avatar.Length == 0)
            {
                avatar = _coverUrl("netease", ReadString(artist, "picUrl"));
            }

            description = ReadString(artist, "briefDesc");
            followed = artist.TryGetProperty("followed", out var followedElement) &&
                       followedElement.ValueKind == JsonValueKind.True;
        }

        if (root.TryGetProperty("hotSongs", out var songs) && songs.ValueKind == JsonValueKind.Array)
        {
            hotSongs = ParseNeteaseSongs(songs);
        }

        if (limit > 0 && hotSongs.Count > limit)
        {
            hotSongs = hotSongs.Take(limit).ToList();
        }

        var albums = new List<ArtistAlbum>();
        try
        {
            using var albumDocument = await FetchJsonAsync(
                    $"{NeteaseBase}/api/artist/albums/{Uri.EscapeDataString(id)}?limit=30&offset=0",
                    NeteaseReferer,
                    NeteaseCookie,
                    Timeout,
                    cancellationToken)
                .ConfigureAwait(false);
            if (albumDocument.RootElement.TryGetProperty("hotAlbums", out var hotAlbums) &&
                hotAlbums.ValueKind == JsonValueKind.Array)
            {
                foreach (var element in hotAlbums.EnumerateArray())
                {
                    var albumId = ReadId(element, "id");
                    if (albumId.Length == 0)
                    {
                        continue;
                    }

                    albums.Add(new ArtistAlbum
                    {
                        Id = albumId,
                        Title = ReadString(element, "name"),
                        Cover = _coverUrl("netease", ReadString(element, "picUrl")),
                        Year = ReadYear(element, "publishTime"),
                        Count = (int)ReadLong(element, "size"),
                    });
                }
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"discover netease artist albums failed id={id}: {OnlineHttp.Describe(exception)}");
        }

        return new DiscoverArtistResponse
        {
            Source = "netease",
            Id = id,
            Name = name,
            Cover = avatar,
            Avatar = avatar,
            Description = description,
            Followed = followed,
            HotSongs = hotSongs,
            Albums = albums,
        };
    }

    /// <summary>
    /// QQ 歌手页：官方接口全部下线（fcg_v8_singer_* 404 / musicu SingerInfoInter 104400），
    /// 改抓 y.qq.com 歌手页 SSR 里的 window.__INITIAL_DATA__（含 basic_info、songList、albumList）。
    /// </summary>
    private async Task<DiscoverArtistResponse> GetQqArtistAsync(string id, int limit, CancellationToken cancellationToken)
    {
        string html;
        try
        {
            var upstream = await OnlineHttp.FetchTextAsync(
                    $"https://y.qq.com/n/ryqq/singer/{Uri.EscapeDataString(id)}",
                    QqReferer,
                    LongTimeout,
                    cancellationToken,
                    cookie: QqCookie)
                .ConfigureAwait(false);
            html = upstream.Body;
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            throw new DiscoverException(502, "upstream-failed", $"QQ 歌手页请求失败：{OnlineHttp.Describe(exception)}");
        }

        var payload = ExtractInitialData(html);
        if (payload.Length == 0)
        {
            throw new DiscoverException(502, "upstream-failed", "QQ 歌手页：未找到页面数据");
        }

        using var document = JsonDocument.Parse(SanitizeLooseJson(payload));
        var root = document.RootElement;
        var name = string.Empty;
        var avatar = string.Empty;
        var description = string.Empty;
        if (root.TryGetProperty("singerDetail", out var detail) && detail.ValueKind == JsonValueKind.Object)
        {
            if (detail.TryGetProperty("basic_info", out var basic) && basic.ValueKind == JsonValueKind.Object)
            {
                name = ReadString(basic, "name");
            }

            description = ReadString(detail, "shortdesc");
            if (description.Length == 0 &&
                detail.TryGetProperty("ex_info", out var ex) &&
                ex.ValueKind == JsonValueKind.Object)
            {
                description = StripHtml(ReadString(ex, "desc"));
            }

            if (description.Length == 0)
            {
                description = StripHtml(ReadString(detail, "descstr"));
            }

            if (detail.TryGetProperty("pic", out var pic) && pic.ValueKind == JsonValueKind.Object)
            {
                avatar = _coverUrl("qq", NormalizeQqImageUrl(ReadString(pic, "pic")));
            }
        }

        if (avatar.Length == 0)
        {
            avatar = _coverUrl("qq", NormalizeQqImageUrl($"https://y.gtimg.cn/music/photo_new/T001R300x300M000{id}.jpg"));
        }

        var hotSongs = new List<OnlineTrack>();
        if (root.TryGetProperty("songList", out var songs) && songs.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in songs.EnumerateArray())
            {
                var track = ParseQqSingerSong(element);
                if (track is not null)
                {
                    hotSongs.Add(track);
                }
            }
        }

        if (limit > 0 && hotSongs.Count > limit)
        {
            hotSongs = hotSongs.Take(limit).ToList();
        }

        var albums = new List<ArtistAlbum>();
        if (root.TryGetProperty("albumList", out var albumNodes) && albumNodes.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in albumNodes.EnumerateArray())
            {
                var albumMid = ReadString(element, "mid");
                if (albumMid.Length == 0)
                {
                    continue;
                }

                var release = ReadString(element, "release_time");
                var year = release.Length >= 4 &&
                           int.TryParse(release.AsSpan(0, 4), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsedYear)
                    ? parsedYear
                    : 0;
                albums.Add(new ArtistAlbum
                {
                    Id = albumMid,
                    Title = ReadString(element, "name"),
                    Cover = _coverUrl("qq", albumMid),
                    Year = year,
                    Count = 0,
                });
            }
        }

        OnlineHttp.Info($"discover qq artist id={id} name={name} songs={hotSongs.Count} albums={albums.Count}");
        return new DiscoverArtistResponse
        {
            Source = "qq",
            Id = id,
            Name = name,
            Cover = avatar,
            Avatar = avatar,
            Description = description,
            Followed = false,
            HotSongs = hotSongs,
            Albums = albums,
        };
    }

    public async Task<DiscoverAlbumResponse> GetAlbumAsync(
        string source,
        string id,
        CancellationToken cancellationToken)
    {
        if (id.Length == 0)
        {
            throw new DiscoverException(400, "bad-request", "缺少专辑 id");
        }

        return source == "qq"
            ? await GetQqAlbumAsync(id, cancellationToken).ConfigureAwait(false)
            : await GetNeteaseAlbumAsync(id, cancellationToken).ConfigureAwait(false);
    }

    private async Task<DiscoverAlbumResponse> GetNeteaseAlbumAsync(string id, CancellationToken cancellationToken)
    {
        using var document = await FetchJsonAsync(
                $"{NeteaseBase}/api/album/{Uri.EscapeDataString(id)}",
                NeteaseReferer,
                NeteaseCookie,
                Timeout,
                cancellationToken)
            .ConfigureAwait(false);

        var root = document.RootElement;
        var title = string.Empty;
        var cover = string.Empty;
        var artist = string.Empty;
        var artistId = string.Empty;
        var year = 0;
        var description = string.Empty;
        if (root.TryGetProperty("album", out var album) && album.ValueKind == JsonValueKind.Object)
        {
            title = ReadString(album, "name");
            cover = _coverUrl("netease", ReadString(album, "picUrl"));
            year = ReadYear(album, "publishTime");
            description = ReadString(album, "description");
            if (album.TryGetProperty("artist", out var artistElement) && artistElement.ValueKind == JsonValueKind.Object)
            {
                artist = ReadString(artistElement, "name");
                artistId = ReadId(artistElement, "id");
            }
        }

        var tracks = new List<OnlineTrack>();
        if (root.TryGetProperty("songs", out var songs) && songs.ValueKind == JsonValueKind.Array)
        {
            tracks = ParseNeteaseSongs(songs);
        }
        else if (root.TryGetProperty("album", out var songsAlbum) &&
                 songsAlbum.ValueKind == JsonValueKind.Object &&
                 songsAlbum.TryGetProperty("songs", out var albumSongs) &&
                 albumSongs.ValueKind == JsonValueKind.Array)
        {
            // 网易云 /api/album/{id} 的 songs 嵌在 album.songs 里，根节点没有 songs。
            tracks = ParseNeteaseSongs(albumSongs);
        }

        return new DiscoverAlbumResponse
        {
            Source = "netease",
            Id = id,
            Title = title,
            Cover = cover,
            Artist = artist,
            ArtistId = artistId,
            Year = year,
            Description = description,
            Tracks = tracks,
        };
    }

    private async Task<DiscoverAlbumResponse> GetQqAlbumAsync(string id, CancellationToken cancellationToken)
    {
        using var document = await FetchJsonAsync(
                $"https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?albummid={Uri.EscapeDataString(id)}&format=json",
                QqCgiReferer,
                QqCookie,
                Timeout,
                cancellationToken)
            .ConfigureAwait(false);

        var root = document.RootElement;
        var data = root.TryGetProperty("data", out var dataElement) && dataElement.ValueKind == JsonValueKind.Object
            ? dataElement
            : root;

        var title = ReadString(data, "name");
        var albumMid = ReadString(data, "albummid");
        if (albumMid.Length == 0)
        {
            albumMid = ReadString(data, "mid");
        }

        if (albumMid.Length == 0)
        {
            albumMid = id;
        }

        var cover = _coverUrl("qq", albumMid);
        var artist = ReadString(data, "singername");
        if (artist.Length == 0)
        {
            artist = ReadString(data, "artist_name");
        }

        var artistId = string.Empty;
        var year = ReadYear(data, "pubtime");
        var aDate = ReadString(data, "aDate");
        if (year <= 0 && aDate.Length >= 4 && int.TryParse(aDate.AsSpan(0, 4), out var parsedYear))
        {
            year = parsedYear;
        }

        var description = ReadString(data, "desc");
        if (data.TryGetProperty("singer", out var singers) && singers.ValueKind == JsonValueKind.Array)
        {
            foreach (var singer in singers.EnumerateArray())
            {
                if (artist.Length == 0)
                {
                    artist = ReadString(singer, "name");
                }

                if (artistId.Length == 0)
                {
                    artistId = ReadString(singer, "mid");
                }
            }
        }

        var tracks = new List<OnlineTrack>();
        if (data.TryGetProperty("list", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in list.EnumerateArray())
            {
                var songMid = ReadString(element, "songmid");
                if (songMid.Length == 0)
                {
                    continue;
                }

                var artists = new List<string>();
                var trackArtistId = string.Empty;
                if (element.TryGetProperty("singer", out var itemSingers) && itemSingers.ValueKind == JsonValueKind.Array)
                {
                    foreach (var singer in itemSingers.EnumerateArray())
                    {
                        var name = ReadString(singer, "name");
                        if (name.Length > 0)
                        {
                            artists.Add(name);
                        }

                        if (trackArtistId.Length == 0)
                        {
                            trackArtistId = ReadString(singer, "mid");
                        }
                    }
                }

                tracks.Add(new OnlineTrack
                {
                    Source = "qq",
                    Id = songMid,
                    Mid = songMid,
                    Title = ReadString(element, "songname"),
                    Artist = string.Join(" / ", artists),
                    Album = title,
                    DurationMs = ReadLong(element, "interval") * 1000,
                    CoverKey = id,
                    ArtistId = trackArtistId.Length > 0 ? trackArtistId : null,
                    AlbumId = id,
                }.WithCover(_coverUrl("qq", id)));
            }
        }

        return new DiscoverAlbumResponse
        {
            Source = "qq",
            Id = id,
            Title = title,
            Cover = cover,
            Artist = artist,
            ArtistId = artistId,
            Year = year,
            Description = description,
            Tracks = tracks,
        };
    }

    // ── 评论 ─────────────────────────────────────────────────────────────────────

    public async Task<DiscoverCommentsResponse> GetCommentsAsync(
        string source,
        string id,
        int offset,
        int limit,
        CancellationToken cancellationToken)
    {
        if (source == "qq")
        {
            return await GetQqCommentsAsync(id, offset, limit, cancellationToken).ConfigureAwait(false);
        }

        if (id.Length == 0)
        {
            throw new DiscoverException(400, "bad-request", "缺少歌曲 id");
        }

        var url = $"{NeteaseBase}/api/v1/resource/comments/R_SO_4_{Uri.EscapeDataString(id)}?limit={limit}&offset={offset}";
        using var document = await FetchJsonAsync(url, NeteaseReferer, NeteaseCookie, Timeout, cancellationToken)
            .ConfigureAwait(false);

        var root = document.RootElement;
        var total = ReadLong(root, "total");
        var comments = new List<DiscoverComment>();
        if (root.TryGetProperty("comments", out var array) && array.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in array.EnumerateArray())
            {
                comments.Add(ParseComment(element, false));
            }
        }

        if (offset == 0 && root.TryGetProperty("hotComments", out var hot) && hot.ValueKind == JsonValueKind.Array)
        {
            var hotComments = new List<DiscoverComment>();
            foreach (var element in hot.EnumerateArray())
            {
                hotComments.Add(ParseComment(element, true));
            }

            // 热评在前，普通评论去重后接上。
            var seen = new HashSet<string>(hotComments.Select(item => item.User + "\u0001" + item.Content), StringComparer.Ordinal);
            hotComments.AddRange(comments.Where(item => seen.Add(item.User + "\u0001" + item.Content)));
            comments = hotComments;
        }

        return new DiscoverCommentsResponse
        {
            Source = "netease",
            Id = id,
            Total = total,
            Comments = comments,
            HasMore = offset + comments.Count < total,
        };
    }

    /// <summary>
    /// QQ 评论：评论接口 fcg_global_comment_h5 的 topid 要「数字歌曲 id」，所以先用
    /// musicu 的 get_song_detail_yqq 把 songmid 换成 id，再分页拉取；首屏在热评后接普通评论。
    /// </summary>
    private async Task<DiscoverCommentsResponse> GetQqCommentsAsync(
        string mid,
        int offset,
        int limit,
        CancellationToken cancellationToken)
    {
        if (mid.Length == 0)
        {
            throw new DiscoverException(400, "bad-request", "缺少歌曲 id");
        }

        var songId = await ResolveQqSongIdAsync(mid, cancellationToken).ConfigureAwait(false);
        if (songId <= 0)
        {
            throw new DiscoverException(502, "upstream-failed", "QQ 评论：无法解析歌曲 id");
        }

        var pageSize = Math.Clamp(limit, 1, 50);
        var pageNum = Math.Max(0, offset / pageSize);
        var uin = _accounts?.GetUserId("qq") ?? "0";
        var url = "https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg" +
                  "?format=json&outCharset=GB2312&domain=qq.com&ct=24&cv=10101010&needmusiccrit=0" +
                  "&cid=205360772&reqtype=2&biztype=1&cmd=8&lasthotcommentid=" +
                  $"&topid={songId}&pagenum={pageNum}&pagesize={pageSize}" +
                  $"&uin={Uri.EscapeDataString(uin)}&g_tk=5381";
        using var document = await FetchJsonBytesAsUtf8Async(url, QqCgiReferer, QqCookie, Timeout, cancellationToken)
            .ConfigureAwait(false);

        var root = document.RootElement;
        var total = 0L;
        var pageComments = new List<DiscoverComment>();
        if (root.TryGetProperty("comment", out var page) && page.ValueKind == JsonValueKind.Object)
        {
            total = ReadLong(page, "commenttotal");
            if (page.TryGetProperty("commentlist", out var list) && list.ValueKind == JsonValueKind.Array)
            {
                foreach (var element in list.EnumerateArray())
                {
                    pageComments.Add(ParseQqComment(element, false));
                }
            }
        }

        var comments = new List<DiscoverComment>();
        if (offset == 0 &&
            root.TryGetProperty("hot_comment", out var hot) &&
            hot.ValueKind == JsonValueKind.Object &&
            hot.TryGetProperty("commentlist", out var hotList) &&
            hotList.ValueKind == JsonValueKind.Array)
        {
            // 首屏热评优先，但整体仍返回一页（pageSize 条），保证前端 offset 步进与 pagenum 对齐。
            foreach (var element in hotList.EnumerateArray())
            {
                if (comments.Count >= pageSize)
                {
                    break;
                }

                comments.Add(ParseQqComment(element, true));
            }
        }

        var seen = new HashSet<string>(comments.Select(item => item.User + "" + item.Content), StringComparer.Ordinal);
        foreach (var comment in pageComments)
        {
            if (comments.Count >= pageSize)
            {
                break;
            }

            if (seen.Add(comment.User + "" + comment.Content))
            {
                comments.Add(comment);
            }
        }

        if (total <= 0 && comments.Count > 0)
        {
            total = comments.Count;
        }

        return new DiscoverCommentsResponse
        {
            Source = "qq",
            Id = mid,
            Total = total,
            Comments = comments,
            HasMore = offset + comments.Count < total,
        };
    }

    private async Task<long> ResolveQqSongIdAsync(string mid, CancellationToken cancellationToken)
    {
        var payload = "{\"comm\":{\"ct\":24,\"cv\":0},\"req\":{\"module\":\"music.pf_song_detail_svr\",\"method\":\"get_song_detail_yqq\",\"param\":{\"song_mid\":\"" + mid.Replace("\"", string.Empty) + "\"}}}";
        try
        {
            using var document = await FetchJsonAsync(
                    "https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=" + Uri.EscapeDataString(payload),
                    QqCgiReferer,
                    QqCookie,
                    Timeout,
                    cancellationToken)
                .ConfigureAwait(false);
            if (document.RootElement.TryGetProperty("req", out var req) &&
                req.ValueKind == JsonValueKind.Object &&
                req.TryGetProperty("data", out var data) &&
                data.ValueKind == JsonValueKind.Object &&
                data.TryGetProperty("track_info", out var track) &&
                track.ValueKind == JsonValueKind.Object)
            {
                return ReadLong(track, "id");
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"discover qq comments resolve id failed mid={mid}: {OnlineHttp.Describe(exception)}");
        }

        return 0;
    }

    private DiscoverComment ParseQqComment(JsonElement element, bool hot)
    {
        var avatar = NormalizeQqImageUrl(ReadString(element, "avatarurl"));
        if (avatar.Length > 0)
        {
            avatar = _coverUrl("qq", avatar);
        }

        var content = ReadString(element, "rootcommentcontent");
        if (content.Length == 0)
        {
            content = ReadString(element, "content");
        }

        // QQ 评论里的表情是 [em]e400851[/em] 这类占位符，直接截断会留下乱码，替换成空并清理图片标记。
        content = QqCommentEmojiPattern.Replace(content, string.Empty).Replace("[图片]", "（图片）").Trim();

        var seconds = ReadLong(element, "time");
        var time = seconds > 0
            ? DateTimeOffset.FromUnixTimeSeconds(seconds).ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            : string.Empty;

        return new DiscoverComment
        {
            User = ReadString(element, "nick"),
            Avatar = avatar,
            Content = content,
            Liked = ReadLong(element, "praisenum"),
            Time = time,
            Hot = hot || ReadLong(element, "is_hot_cmt") > 0,
        };
    }

    private DiscoverComment ParseComment(JsonElement element, bool hot)
    {
        var user = string.Empty;
        var avatar = string.Empty;
        if (element.TryGetProperty("user", out var userElement) && userElement.ValueKind == JsonValueKind.Object)
        {
            user = ReadString(userElement, "nickname");
            avatar = ReadString(userElement, "avatarUrl");
            if (avatar.Length > 0)
            {
                // 页面是 https://zilux2.local，直接引用 http 头像会被混合内容拦截，统一走宿主封面代理。
                avatar = _coverUrl("netease", avatar);
            }
        }

        var timeMs = ReadLong(element, "time");
        var time = timeMs > 0
            ? DateTimeOffset.FromUnixTimeMilliseconds(timeMs).ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            : string.Empty;

        return new DiscoverComment
        {
            User = user,
            Avatar = avatar,
            Content = ReadString(element, "content"),
            Liked = ReadLong(element, "likedCount"),
            Time = time,
            Hot = hot,
        };
    }

    // ── 播客推荐 ─────────────────────────────────────────────────────────────────

    public async Task<DiscoverPodcastsResponse> GetPodcastsAsync(int limit, CancellationToken cancellationToken)
    {
        using var document = await FetchJsonAsync(
                $"{NeteaseBase}/api/personalized/djprogram?limit={limit}",
                NeteaseReferer,
                NeteaseCookie,
                Timeout,
                cancellationToken)
            .ConfigureAwait(false);

        var programs = new List<DiscoverProgram>();
        if (document.RootElement.TryGetProperty("result", out var result) && result.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in result.EnumerateArray())
            {
                // /api/personalized/djprogram 的节目字段嵌在 program 里，radio/dj 也在 program 下。
                var program = element.TryGetProperty("program", out var programElement) &&
                              programElement.ValueKind == JsonValueKind.Object
                    ? programElement
                    : element;

                var id = ReadId(program, "id");
                if (id.Length == 0)
                {
                    id = ReadId(element, "id");
                }

                if (id.Length == 0)
                {
                    continue;
                }

                var name = ReadString(program, "name");
                if (name.Length == 0)
                {
                    name = ReadString(element, "name");
                }

                var cover = ReadString(program, "coverUrl");
                if (cover.Length == 0)
                {
                    cover = ReadString(element, "picUrl");
                }

                var radioName = string.Empty;
                if (program.TryGetProperty("radio", out var radio) && radio.ValueKind == JsonValueKind.Object)
                {
                    radioName = ReadString(radio, "name");
                }

                var djName = string.Empty;
                if (program.TryGetProperty("dj", out var dj) && dj.ValueKind == JsonValueKind.Object)
                {
                    djName = ReadString(dj, "nickname");
                }

                var duration = ReadLong(program, "duration");
                var description = ReadString(program, "description");
                if (description.Length == 0)
                {
                    description = ReadString(program, "programDesc");
                }

                if (description.Length == 0)
                {
                    description = ReadString(element, "copywriter");
                }

                programs.Add(new DiscoverProgram
                {
                    Id = id,
                    Name = name,
                    Cover = _coverUrl("netease", cover),
                    RadioName = radioName,
                    DjName = djName,
                    DurationMs = duration,
                    Description = description,
                });
            }
        }

        return new DiscoverPodcastsResponse { Source = "netease", Programs = programs };
    }

    // ── 我的收藏 ─────────────────────────────────────────────────────────────────

    public async Task<DiscoverCollectionsResponse> GetCollectionsAsync(
        string source,
        string kind,
        int offset,
        int limit,
        CancellationToken cancellationToken)
    {
        if (source == "qq")
        {
            throw new DiscoverException(501, "unsupported", "QQ 音乐收藏页暂未接入");
        }

        if (kind == "playlist")
        {
            return await GetNeteaseCollectedPlaylistsAsync(offset, limit, cancellationToken).ConfigureAwait(false);
        }

        var path = kind switch
        {
            "artist" => "/api/artist/sublist",
            "album" => "/api/album/sublist",
            "mv" => "/api/mv/sublist",
            _ => throw new DiscoverException(400, "bad-request", "不支持的收藏类型"),
        };

        using var document = await FetchJsonAsync(
                $"{NeteaseBase}{path}?limit={limit}&offset={offset}",
                NeteaseReferer,
                NeteaseCookie,
                Timeout,
                cancellationToken)
            .ConfigureAwait(false);

        var items = new List<CollectionItem>();
        if (document.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in data.EnumerateArray())
            {
                var id = ReadId(element, "id");
                if (id.Length == 0)
                {
                    continue;
                }

                var title = ReadString(element, "name");
                if (title.Length == 0)
                {
                    title = ReadString(element, "title");
                }

                var cover = ReadString(element, "picUrl");
                if (cover.Length == 0)
                {
                    cover = ReadString(element, "imgurl");
                }

                var subtitle = string.Empty;
                if (element.TryGetProperty("artists", out var artists) && artists.ValueKind == JsonValueKind.Array)
                {
                    var names = new List<string>();
                    foreach (var artist in artists.EnumerateArray())
                    {
                        var name = ReadString(artist, "name");
                        if (name.Length > 0)
                        {
                            names.Add(name);
                        }
                    }

                    subtitle = string.Join(" / ", names);
                }

                if (subtitle.Length == 0)
                {
                    subtitle = ReadString(element, "artistName");
                }

                if (subtitle.Length == 0)
                {
                    subtitle = kind switch { "artist" => "歌手", "album" => "专辑", "mv" => "MV", _ => string.Empty };
                }

                items.Add(new CollectionItem
                {
                    Id = id,
                    Title = title,
                    Cover = _coverUrl("netease", cover),
                    Subtitle = subtitle,
                });
            }
        }

        return new DiscoverCollectionsResponse
        {
            Source = "netease",
            Kind = kind,
            HasMore = items.Count >= limit,
            Items = items,
        };
    }

    private async Task<DiscoverCollectionsResponse> GetNeteaseCollectedPlaylistsAsync(
        int offset,
        int limit,
        CancellationToken cancellationToken)
    {
        var uid = _accounts?.GetUserId("netease") ?? string.Empty;
        if (uid.Length == 0)
        {
            throw new DiscoverException(401, "login-required", "请先登录网易云音乐");
        }

        using var document = await FetchJsonAsync(
                $"{NeteaseBase}/api/user/playlist?uid={Uri.EscapeDataString(uid)}&limit={limit}&offset={offset}",
                NeteaseReferer,
                NeteaseCookie,
                Timeout,
                cancellationToken)
            .ConfigureAwait(false);

        var items = new List<CollectionItem>();
        if (document.RootElement.TryGetProperty("playlist", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in list.EnumerateArray())
            {
                var id = ReadId(element, "id");
                if (id.Length == 0)
                {
                    continue;
                }

                var creator = string.Empty;
                if (element.TryGetProperty("creator", out var creatorElement) && creatorElement.ValueKind == JsonValueKind.Object)
                {
                    creator = ReadString(creatorElement, "nickname");
                }

                var count = ReadLong(element, "trackCount");
                var subtitle = count > 0 ? $"{creator} · {count} 首" : creator;
                if (subtitle.Length == 0)
                {
                    subtitle = "歌单";
                }

                items.Add(new CollectionItem
                {
                    Id = id,
                    Title = ReadString(element, "name"),
                    Cover = _coverUrl("netease", ReadString(element, "coverImgUrl")),
                    Subtitle = subtitle,
                });
            }
        }

        var more = document.RootElement.TryGetProperty("more", out var moreElement) &&
                   moreElement.ValueKind == JsonValueKind.True;
        return new DiscoverCollectionsResponse
        {
            Source = "netease",
            Kind = "playlist",
            HasMore = more || items.Count >= limit,
            Items = items,
        };
    }

    // ── 本地歌手头像补齐（按歌手名在网易云搜索歌手，取头像）─────────────────────

    private static readonly object ArtistImageCacheLock = new();
    private static readonly Dictionary<string, (byte[] Bytes, string ContentType)?> ArtistImageCache = new(StringComparer.Ordinal);
    private const int ArtistImageCacheLimit = 64;

    /// <summary>
    /// 按歌手名在网易云搜索接口里找到歌手并取头像，供本地曲库「歌手」头像使用。
    /// 找不到或上游失败返回 null（页面退回首字母占位）。
    /// </summary>
    public async Task<(byte[] Bytes, string ContentType)?> GetNeteaseArtistImageAsync(string name, CancellationToken cancellationToken)
    {
        var key = name.Trim();
        if (key.Length == 0)
        {
            return null;
        }

        lock (ArtistImageCacheLock)
        {
            if (ArtistImageCache.TryGetValue(key, out var cached))
            {
                return cached;
            }
        }

        (byte[] Bytes, string ContentType)? result = null;
        try
        {
            // 歌手搜索用 cloudsearch（旧 search/get/web 会返回「操作频繁」405）。
            var url =
                $"{NeteaseBase}/api/cloudsearch/pc?s={Uri.EscapeDataString(key)}&type=100&offset=0&limit=1";
            using var document = await FetchJsonAsync(url, NeteaseReferer, NeteaseCookie, Timeout, cancellationToken)
                .ConfigureAwait(false);
            var root = document.RootElement;
            if (root.TryGetProperty("result", out var resultElement)
                && resultElement.ValueKind == JsonValueKind.Object
                && resultElement.TryGetProperty("artists", out var artists)
                && artists.ValueKind == JsonValueKind.Array
                && artists.GetArrayLength() > 0)
            {
                var artist = artists[0];
                var imageUrl = ReadString(artist, "picUrl");
                if (imageUrl.Length == 0)
                {
                    imageUrl = ReadString(artist, "img1v1Url");
                }

                if (imageUrl.Length > 0)
                {
                    var upstream = await OnlineHttp
                        .FetchBytesAsync(imageUrl, NeteaseReferer, Timeout, cancellationToken)
                        .ConfigureAwait(false);
                    if (upstream.Bytes.Length > 0)
                    {
                        result = (upstream.Bytes, "image/jpeg");
                    }
                }
            }
        }
        catch (Exception exception) when (exception is OnlineUpstreamException or DiscoverException or JsonException)
        {
            result = null;
        }

        lock (ArtistImageCacheLock)
        {
            if (ArtistImageCache.Count >= ArtistImageCacheLimit)
            {
                ArtistImageCache.Clear();
            }

            ArtistImageCache[key] = result;
        }

        return result;
    }

    // ── 上游请求与解析 ───────────────────────────────────────────────────────────

    /// <summary>
    /// 取字节后按 UTF-8 解析。某些腾讯 cgi 会回 `application/x-javascript;charset=gb2312`，
    /// 但 body 本身是 UTF-8 JSON；直接 ReadAsStringAsync 会因非法 charset 抛
    /// InvalidOperationException: The character set provided in ContentType is invalid。
    /// </summary>
    private static async Task<JsonDocument> FetchJsonBytesAsUtf8Async(
        string url,
        string referer,
        string cookie,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var upstream = await OnlineHttp
            .FetchBytesAsync(url, referer, timeout, cancellationToken, cookie: cookie)
            .ConfigureAwait(false);
        try
        {
            return JsonDocument.Parse(Encoding.UTF8.GetString(upstream.Bytes));
        }
        catch (JsonException)
        {
            throw new DiscoverException(502, "upstream-failed", "上游返回的不是 JSON");
        }
    }

    /// <summary>
    /// 腾讯歌单广场等老 cgi 的 body 是 GBK/GB18030 编码（Content-Type 声明 gb2312），
    /// 必须按 GB18030 解码，否则中文歌单标题会变成乱码。
    /// </summary>
    private static async Task<JsonDocument> FetchJsonGbAsync(
        string url,
        string referer,
        string cookie,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var upstream = await OnlineHttp
            .FetchBytesAsync(url, referer, timeout, cancellationToken, cookie: cookie)
            .ConfigureAwait(false);
        try
        {
            return JsonDocument.Parse(Gb18030.GetString(upstream.Bytes));
        }
        catch (JsonException)
        {
            throw new DiscoverException(502, "upstream-failed", "上游返回的不是 JSON");
        }
    }

    private static async Task<JsonDocument> FetchJsonAsync(
        string url,
        string referer,
        string cookie,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var upstream = await OnlineHttp
            .FetchTextAsync(url, referer, timeout, cancellationToken, cookie: cookie)
            .ConfigureAwait(false);
        try
        {
            return JsonDocument.Parse(upstream.Body);
        }
        catch (JsonException)
        {
            throw new DiscoverException(502, "upstream-failed", "上游返回的不是 JSON");
        }
    }

    private List<OnlineTrack> ParseNeteaseSongs(JsonElement array)
    {
        var tracks = new List<OnlineTrack>();
        foreach (var element in array.EnumerateArray())
        {
            var track = ParseNeteaseSong(element);
            if (track.Id.Length > 0)
            {
                tracks.Add(track);
            }
        }

        return tracks;
    }

    // 兼容两套字段：老接口用 artists/album/duration，新接口用 ar/al/dt。
    private OnlineTrack ParseNeteaseSong(JsonElement song)
    {
        var id = ReadId(song, "id");
        var artists = new List<string>();
        var artistId = string.Empty;
        var album = string.Empty;
        var albumId = string.Empty;
        var coverKey = string.Empty;

        if (song.TryGetProperty("ar", out var ar) && ar.ValueKind == JsonValueKind.Array)
        {
            foreach (var artist in ar.EnumerateArray())
            {
                var name = ReadString(artist, "name");
                if (name.Length > 0)
                {
                    artists.Add(name);
                }

                if (artistId.Length == 0)
                {
                    artistId = ReadId(artist, "id");
                }
            }
        }
        else if (song.TryGetProperty("artists", out var artistsElement) && artistsElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var artist in artistsElement.EnumerateArray())
            {
                var name = ReadString(artist, "name");
                if (name.Length > 0)
                {
                    artists.Add(name);
                }

                if (artistId.Length == 0)
                {
                    artistId = ReadId(artist, "id");
                }
            }
        }

        if (song.TryGetProperty("al", out var al) && al.ValueKind == JsonValueKind.Object)
        {
            album = ReadString(al, "name");
            albumId = ReadId(al, "id");
            coverKey = ReadString(al, "picUrl");
        }
        else if (song.TryGetProperty("album", out var albumElement) && albumElement.ValueKind == JsonValueKind.Object)
        {
            album = ReadString(albumElement, "name");
            albumId = ReadId(albumElement, "id");
            coverKey = ReadString(albumElement, "picUrl");
        }

        var duration = ReadLong(song, "dt");
        if (duration == 0)
        {
            duration = ReadLong(song, "duration");
        }

        var fee = (int)ReadLong(song, "fee");
        return new OnlineTrack
        {
            Source = "netease",
            Id = id,
            Title = ReadString(song, "name"),
            Artist = string.Join(" / ", artists),
            Album = album,
            DurationMs = duration,
            CoverKey = coverKey,
            ArtistId = artistId.Length > 0 ? artistId : null,
            AlbumId = albumId.Length > 0 ? albumId : null,
            Playable = fee is 0 or 8,
            Vip = fee is not (0 or 8),
        }.WithCover(_coverUrl("netease", coverKey));
    }

    private OnlineTrack ParseQqSong(JsonElement data)
    {
        var songMid = ReadString(data, "songmid");
        var albumMid = ReadString(data, "albummid");
        var artists = new List<string>();
        var artistId = string.Empty;
        if (data.TryGetProperty("singer", out var singers) && singers.ValueKind == JsonValueKind.Array)
        {
            foreach (var singer in singers.EnumerateArray())
            {
                var name = ReadString(singer, "name");
                if (name.Length > 0)
                {
                    artists.Add(name);
                }

                if (artistId.Length == 0)
                {
                    artistId = ReadString(singer, "mid");
                }
            }
        }

        var payPlay = ReadLong(data, "pay_play");
        return new OnlineTrack
        {
            Source = "qq",
            Id = songMid,
            Mid = songMid.Length > 0 ? songMid : null,
            Title = ReadString(data, "songname"),
            Artist = string.Join(" / ", artists),
            Album = ReadString(data, "albumname"),
            DurationMs = ReadLong(data, "interval") * 1000,
            CoverKey = albumMid,
            ArtistId = artistId.Length > 0 ? artistId : null,
            AlbumId = albumMid.Length > 0 ? albumMid : null,
            Playable = payPlay == 0,
            Vip = payPlay != 0,
        }.WithCover(_coverUrl("qq", albumMid));
    }

    // ── 歌曲信息 ─────────────────────────────────────────────────────────────────

    public async Task<DiscoverSongResponse> GetSongInfoAsync(string source, string id, CancellationToken cancellationToken)
    {
        if (id.Length == 0)
        {
            throw new DiscoverException(400, "bad-request", "缺少歌曲 id");
        }

        return source == "qq"
            ? await GetQqSongInfoAsync(id, cancellationToken).ConfigureAwait(false)
            : await GetNeteaseSongInfoAsync(id, cancellationToken).ConfigureAwait(false);
    }

    private async Task<DiscoverSongResponse> GetNeteaseSongInfoAsync(string id, CancellationToken cancellationToken)
    {
        using var document = await FetchJsonAsync(
                $"{NeteaseBase}/api/v3/song/detail?ids=%5B{Uri.EscapeDataString(id)}%5D&c=%5B%7B%22id%22%3A{Uri.EscapeDataString(id)}%7D%5D",
                NeteaseReferer,
                NeteaseCookie,
                Timeout,
                cancellationToken)
            .ConfigureAwait(false);

        var root = document.RootElement;
        if (!root.TryGetProperty("songs", out var songs) ||
            songs.ValueKind != JsonValueKind.Array ||
            songs.GetArrayLength() == 0)
        {
            throw new DiscoverException(404, "not-found", "未找到这首歌");
        }

        var song = songs[0];
        var artists = new List<DiscoverSongArtist>();
        var artistNames = new List<string>();
        var artistId = string.Empty;
        if (song.TryGetProperty("ar", out var ar) && ar.ValueKind == JsonValueKind.Array)
        {
            foreach (var artist in ar.EnumerateArray())
            {
                var artistName = ReadString(artist, "name");
                var currentId = ReadId(artist, "id");
                if (artistName.Length == 0)
                {
                    continue;
                }

                artists.Add(new DiscoverSongArtist { Id = currentId, Name = artistName });
                artistNames.Add(artistName);
                if (artistId.Length == 0)
                {
                    artistId = currentId;
                }
            }
        }

        var albumName = string.Empty;
        var albumId = string.Empty;
        var cover = string.Empty;
        var releaseDate = string.Empty;
        if (song.TryGetProperty("al", out var al) && al.ValueKind == JsonValueKind.Object)
        {
            albumName = ReadString(al, "name");
            albumId = ReadId(al, "id");
            cover = _coverUrl("netease", ReadString(al, "picUrl"));
            var published = ReadLong(al, "publishTime");
            if (published > 0)
            {
                releaseDate = DateTimeOffset.FromUnixTimeMilliseconds(published)
                    .ToLocalTime()
                    .ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            }
        }

        if (releaseDate.Length == 0 && albumId.Length > 0)
        {
            // v3 歌曲详情不带发行时间，回查专辑补上（失败不影响主信息）。
            try
            {
                using var albumDocument = await FetchJsonAsync(
                        $"{NeteaseBase}/api/album/{Uri.EscapeDataString(albumId)}",
                        NeteaseReferer,
                        NeteaseCookie,
                        Timeout,
                        cancellationToken)
                    .ConfigureAwait(false);
                if (albumDocument.RootElement.TryGetProperty("album", out var albumDetail) &&
                    albumDetail.ValueKind == JsonValueKind.Object &&
                    ReadLong(albumDetail, "publishTime") > 0)
                {
                    releaseDate = DateTimeOffset.FromUnixTimeMilliseconds(ReadLong(albumDetail, "publishTime"))
                        .ToLocalTime()
                        .ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                }
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                OnlineHttp.Info($"discover song album publish fallback failed id={albumId}: {OnlineHttp.Describe(exception)}");
            }
        }

        var fee = (int)ReadLong(song, "fee");
        return new DiscoverSongResponse
        {
            Source = "netease",
            Id = id,
            Title = ReadString(song, "name"),
            Artist = string.Join(" / ", artistNames),
            ArtistId = artistId.Length > 0 ? artistId : null,
            Artists = artists,
            Album = albumName,
            AlbumId = albumId.Length > 0 ? albumId : null,
            Cover = cover,
            DurationMs = ReadLong(song, "dt"),
            ReleaseDate = releaseDate,
            Vip = fee is not (0 or 8),
            Playable = true,
            TrackNo = (int)ReadLong(song, "no"),
            DiscNo = (int)ReadLong(song, "cd"),
            SourceUrl = $"https://music.163.com/song?id={id}",
        };
    }

    private async Task<DiscoverSongResponse> GetQqSongInfoAsync(string mid, CancellationToken cancellationToken)
    {
        var payload = "{\"comm\":{\"ct\":24,\"cv\":0},\"req\":{\"module\":\"music.pf_song_detail_svr\",\"method\":\"get_song_detail_yqq\",\"param\":{\"song_mid\":\"" +
                      mid.Replace("\"", string.Empty) + "\"}}}";
        using var document = await FetchJsonAsync(
                "https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=" + Uri.EscapeDataString(payload),
                QqCgiReferer,
                QqCookie,
                Timeout,
                cancellationToken)
            .ConfigureAwait(false);

        if (!document.RootElement.TryGetProperty("req", out var req) ||
            req.ValueKind != JsonValueKind.Object ||
            !req.TryGetProperty("data", out var data) ||
            data.ValueKind != JsonValueKind.Object ||
            !data.TryGetProperty("track_info", out var track) ||
            track.ValueKind != JsonValueKind.Object)
        {
            throw new DiscoverException(404, "not-found", "QQ 音乐未找到这首歌");
        }

        var artists = new List<DiscoverSongArtist>();
        var artistNames = new List<string>();
        var artistId = string.Empty;
        if (track.TryGetProperty("singer", out var singers) && singers.ValueKind == JsonValueKind.Array)
        {
            foreach (var singer in singers.EnumerateArray())
            {
                var singerName = ReadString(singer, "name");
                var singerMid = ReadString(singer, "mid");
                if (singerName.Length == 0)
                {
                    continue;
                }

                artists.Add(new DiscoverSongArtist { Id = singerMid, Name = singerName });
                artistNames.Add(singerName);
                if (artistId.Length == 0)
                {
                    artistId = singerMid;
                }
            }
        }

        var albumMid = string.Empty;
        var albumName = string.Empty;
        var releaseDate = string.Empty;
        if (track.TryGetProperty("album", out var album) && album.ValueKind == JsonValueKind.Object)
        {
            albumMid = ReadString(album, "mid");
            albumName = ReadString(album, "name");
            releaseDate = ReadString(album, "time_public");
            if (releaseDate.Length >= 10)
            {
                releaseDate = releaseDate[..10];
            }
        }

        var qualities = new List<DiscoverSongQuality>();
        if (track.TryGetProperty("file", out var file) && file.ValueKind == JsonValueKind.Object)
        {
            AddQuality(qualities, "无损 FLAC", ReadLong(file, "size_flac"));
            AddQuality(qualities, "320kbps MP3", ReadLong(file, "size_320mp3"));
            AddQuality(qualities, "128kbps MP3", ReadLong(file, "size_128mp3"));
            AddQuality(qualities, "AAC", ReadLong(file, "size_96aac"));
        }

        var vip = false;
        if (track.TryGetProperty("pay", out var pay) && pay.ValueKind == JsonValueKind.Object)
        {
            vip = ReadLong(pay, "payplay") != 0 || ReadLong(pay, "paydownload") != 0;
        }

        var title = ReadString(track, "name");
        if (title.Length == 0)
        {
            title = ReadString(track, "title");
        }

        return new DiscoverSongResponse
        {
            Source = "qq",
            Id = mid,
            Title = title,
            Artist = string.Join(" / ", artistNames),
            ArtistId = artistId.Length > 0 ? artistId : null,
            Artists = artists,
            Album = albumName,
            AlbumId = albumMid.Length > 0 ? albumMid : null,
            Cover = _coverUrl("qq", albumMid),
            DurationMs = ReadLong(track, "interval") * 1000,
            ReleaseDate = releaseDate,
            Vip = vip,
            Playable = true,
            SourceUrl = $"https://y.qq.com/n/ryqq/songDetail/{mid}",
            Qualities = qualities,
        };
    }

    private static void AddQuality(List<DiscoverSongQuality> qualities, string name, long sizeBytes)
    {
        if (sizeBytes <= 0)
        {
            return;
        }

        qualities.Add(new DiscoverSongQuality { Name = name, SizeBytes = sizeBytes });
    }

    private OnlineTrack? ParseQqSingerSong(JsonElement data)
    {
        if (data.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var mid = ReadString(data, "mid");
        if (mid.Length == 0)
        {
            mid = ReadString(data, "songmid");
        }

        if (mid.Length == 0)
        {
            return null;
        }

        var albumMid = string.Empty;
        var albumName = string.Empty;
        if (data.TryGetProperty("album", out var album) && album.ValueKind == JsonValueKind.Object)
        {
            albumMid = ReadString(album, "mid");
            albumName = ReadString(album, "name");
        }
        else
        {
            albumMid = ReadString(data, "albummid");
            albumName = ReadString(data, "albumname");
        }

        var artists = new List<string>();
        var artistId = string.Empty;
        if (data.TryGetProperty("singer", out var singers) && singers.ValueKind == JsonValueKind.Array)
        {
            foreach (var singer in singers.EnumerateArray())
            {
                var singerName = ReadString(singer, "name");
                if (singerName.Length > 0)
                {
                    artists.Add(singerName);
                }

                if (artistId.Length == 0)
                {
                    artistId = ReadString(singer, "mid");
                }
            }
        }

        var title = ReadString(data, "name");
        if (title.Length == 0)
        {
            title = ReadString(data, "title");
        }

        if (title.Length == 0)
        {
            title = ReadString(data, "songname");
        }

        var vip = false;
        if (data.TryGetProperty("pay", out var pay) && pay.ValueKind == JsonValueKind.Object)
        {
            vip = ReadLong(pay, "payplay") != 0 || ReadLong(pay, "paydownload") != 0;
        }

        return new OnlineTrack
        {
            Source = "qq",
            Id = mid,
            Mid = mid,
            Title = title,
            Artist = string.Join(" / ", artists),
            Album = albumName,
            DurationMs = ReadLong(data, "interval") * 1000,
            CoverKey = albumMid,
            ArtistId = artistId.Length > 0 ? artistId : null,
            AlbumId = albumMid.Length > 0 ? albumMid : null,
            Playable = true,
            Vip = vip,
        }.WithCover(_coverUrl("qq", albumMid));
    }

    // QQ 老接口全部下线，y.qq.com 页面 SSR 内联的 window.__INITIAL_DATA__ 是唯一稳定来源。
    private static string ExtractInitialData(string html)
    {
        const string marker = "window.__INITIAL_DATA__";
        var at = html.IndexOf(marker, StringComparison.Ordinal);
        if (at < 0)
        {
            return string.Empty;
        }

        var start = html.IndexOf('{', at);
        if (start < 0)
        {
            return string.Empty;
        }

        var depth = 0;
        var inString = false;
        var escaped = false;
        for (var index = start; index < html.Length; index++)
        {
            var ch = html[index];
            if (inString)
            {
                if (escaped)
                {
                    escaped = false;
                }
                else if (ch == (char)92)
                {
                    escaped = true;
                }
                else if (ch == '"')
                {
                    inString = false;
                }

                continue;
            }

            if (ch == '"')
            {
                inString = true;
                continue;
            }

            if (ch == '{')
            {
                depth++;
            }
            else if (ch == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return html.Substring(start, index - start + 1);
                }
            }
        }

        return string.Empty;
    }

    // 页面内联的是 JS 字面量而不是严格 JSON（会出现 title_hilight: undefined 这样的字段）。
    private static string SanitizeLooseJson(string json) =>
        json.Replace(": undefined", ": null", StringComparison.Ordinal)
            .Replace(":undefined", ":null", StringComparison.Ordinal);

    private static string StripHtml(string html)
    {
        if (html.Length == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder(html.Length);
        var inTag = false;
        foreach (var ch in html)
        {
            if (ch == '<')
            {
                inTag = true;
                continue;
            }

            if (ch == '>')
            {
                inTag = false;
                continue;
            }

            if (!inTag)
            {
                builder.Append(ch);
            }
        }

        return System.Net.WebUtility.HtmlDecode(builder.ToString()).Trim();
    }

    private static string ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static string ReadId(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value))
        {
            return string.Empty;
        }

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? string.Empty,
            JsonValueKind.Number => value.ToString(),
            _ => string.Empty,
        };
    }

    private static long ReadLong(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value))
        {
            return 0;
        }

        return value.ValueKind switch
        {
            JsonValueKind.Number => value.TryGetInt64(out var number) ? number : 0,
            JsonValueKind.String => long.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0,
            _ => 0,
        };
    }

    private static int ReadYear(JsonElement element, string name)
    {
        var timeMs = ReadLong(element, name);
        if (timeMs <= 0)
        {
            return 0;
        }

        var stamp = timeMs > 100000000000L
            ? DateTimeOffset.FromUnixTimeMilliseconds(timeMs)
            : DateTimeOffset.FromUnixTimeSeconds(timeMs);
        return stamp.Year;
    }
}

internal static class DiscoverTrackExtensions
{
    public static OnlineTrack WithCover(this OnlineTrack track, string cover) =>
        string.IsNullOrEmpty(cover) ? track : track with { Cover = cover };
}
