import io

qq_path = r'E:\Zilux2开发\src\Zilux2\Online\QqProvider.cs'
server_path = r'E:\Zilux2开发\src\Zilux2\Online\LocalMusicServer.cs'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


qq = load(qq_path)
nl = '\r\n' if '\r\n' in qq else '\n'

anchor = "    private static List<OnlineTrack> ParseSearch(JsonElement root)"
method = '''    /// <summary>QQ 音乐「音乐馆」热门歌单（匿名可拉，不需要登录）。</summary>
    internal async Task<List<HotPlaylistItem>> GetHotPlaylistsAsync(int limit, CancellationToken cancellationToken)
    {
        var url = "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?picmid=1&rnd=0.2&g_tk=5381" +
                  "&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0" +
                  "&platform=yqq.json&needNewCode=0&categoryId=10000000&sortId=5&sin=0&ein=" +
                  Math.Max(0, limit - 1).ToString(CultureInfo.InvariantCulture);
        var upstream = await OnlineHttp.FetchTextAsync(url, RefererUrl, SearchTimeout, cancellationToken).ConfigureAwait(false);
        var items = new List<HotPlaylistItem>();
        using var document = JsonDocument.Parse(upstream.Body);
        var root = document.RootElement;
        if (!root.TryGetProperty("data", out var data) ||
            !data.TryGetProperty("list", out var list) ||
            list.ValueKind != JsonValueKind.Array)
        {
            return items;
        }

        foreach (var element in list.EnumerateArray())
        {
            var id = ReadString(element, "dissid");
            var title = ReadString(element, "dissname");
            if (id.Length == 0 || title.Length == 0)
            {
                continue;
            }

            var image = ReadString(element, "imgurl");
            if (image.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            {
                image = "https://" + image[7..];
            }

            var listens = element.TryGetProperty("listennum", out var listenElement) &&
                          listenElement.TryGetInt64(out var count)
                ? count
                : 0;
            var creator = element.TryGetProperty("creator", out var creatorElement) &&
                          creatorElement.ValueKind == JsonValueKind.Object
                ? ReadString(creatorElement, "name")
                : string.Empty;
            items.Add(new HotPlaylistItem(id, title, image, listens, creator));
        }

        OnlineHttp.Info($"qq/hotlists count={items.Count}");
        return items;
    }

'''.replace('\n', nl)
assert qq.count(anchor) == 1, 'ParseSearch anchor not found'
qq = qq.replace(anchor, method + anchor)

record = '''

/// <summary>QQ 音乐热门歌单条目（服端内部模型，封面在返回前改写成回环代理 URL）。</summary>
internal sealed record HotPlaylistItem(string Id, string Title, string ImageUrl, long ListenCount, string Creator);
'''.replace('\n', nl)
qq = qq.rstrip() + nl + record
save(qq_path, qq)
print('QqProvider: hot playlists added')

server = load(server_path)
nl = '\r\n' if '\r\n' in server else '\n'

route_anchor = '                "/api/cover" => isGet ? await HandleCoverAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),'
route_new = route_anchor + nl + '                "/api/playlists/hot" => isGet ? await HandleHotPlaylistsAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),'
assert server.count(route_anchor) == 1, 'route anchor not found'
server = server.replace(route_anchor, route_new)

handler_anchor = '    private async Task<int> HandleSearchAsync(HttpListenerContext context)'
handler = '''    private async Task<int> HandleHotPlaylistsAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? "qq").Trim().ToLowerInvariant();
        if (source != AccountSources.Qq ||
            !_providers.TryGetValue(AccountSources.Qq, out var provider) ||
            provider is not QqProvider qqProvider)
        {
            return WriteError(context, 400, "bad-request", "热门歌单目前只支持 QQ 音乐");
        }

        var limit = 24;
        if (query["limit"] is { Length: > 0 } limitText &&
            (!int.TryParse(limitText, NumberStyles.Integer, CultureInfo.InvariantCulture, out limit) || limit is < 1 or > 60))
        {
            return WriteError(context, 400, "bad-request", "limit 参数必须在 1..60");
        }

        try
        {
            var items = await qqProvider.GetHotPlaylistsAsync(limit, _shutdown.Token).ConfigureAwait(false);
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
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error("api playlists/hot failed", exception);
            return WriteError(context, 502, "upstream-error", "热门歌单拉取失败：" + OnlineHttp.Describe(exception));
        }
    }

'''.replace('\n', nl)
assert server.count(handler_anchor) == 1, 'search handler anchor not found'
server = server.replace(handler_anchor, handler + handler_anchor)
save(server_path, server)
print('LocalMusicServer: /api/playlists/hot added')
