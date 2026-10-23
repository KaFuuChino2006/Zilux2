# -*- coding: utf-8 -*-
"""Host-side "add to liked" API: netease + qq + library service + local server route."""
import io

BASE = r"E:\Zilux2开发\src\Zilux2\Online"


def read(path):
    return io.open(path, "r", encoding="utf-8", newline="").read()


def write(path, text):
    io.open(path, "w", encoding="utf-8", newline="").write(text)


def insert_before_last_brace(path, block):
    text = read(path)
    idx = text.rstrip().rfind("}")
    assert idx > 0, path
    write(path, text[:idx] + block + "\n" + text[idx:])


NETEASE = '''
    // 「加入我喜欢」：网易云 playlist/manipulate/tracks(op=add)。先取我喜欢的歌单 id，再写入。
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

        var url = "https://music.163.com/api/playlist/manipulate/tracks"
            + $"?op=add&pid={Uri.EscapeDataString(liked.Id)}"
            + $"&trackIds=%5B%22{Uri.EscapeDataString(trackId)}%22%5D&csrf_token=";
        var upstream = await OnlineHttp
            .FetchTextAsync(url, NeteaseProvider.RefererUrl, Timeout, cancellationToken, HttpMethod.Post, cookie: Cookie)
            .ConfigureAwait(false);

        using var document = JsonDocument.Parse(upstream.Body);
        var root = document.RootElement;
        var code = root.TryGetProperty("code", out var codeElement) && codeElement.TryGetInt32(out var codeValue) ? codeValue : 0;
        if (code != 200 && code != 0)
        {
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
'''

QQ = '''
    // 「加入我喜欢」：QQ 音乐客户端协议 music.musicasset.PlaylistDetailWrite/AddSonglist(dirId=201)。
    // AddSonglist 只收数字 songId，因此先用 get_song_detail_yqq 按 songmid 换出数字 id。
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
        var detailRoot = await PostMusicuAsync(detailBody, "qq/library like detail", cancellationToken).ConfigureAwait(false);
        var detailData = ReadRequestData(detailRoot) ?? throw new OnlineUpstreamException("QQ 歌曲详情返回异常", 502);
        if (!detailData.TryGetProperty("track_info", out var trackInfo) || trackInfo.ValueKind != JsonValueKind.Object)
        {
            throw new OnlineUpstreamException("QQ 歌曲详情返回异常", 502);
        }

        if (!long.TryParse(ReadId(trackInfo, "id"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var songId) || songId <= 0)
        {
            throw new OnlineUpstreamException("QQ 歌曲 id 解析失败", 502);
        }

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
        var writeRoot = await PostMusicuAsync(writeBody, "qq/library like write", cancellationToken).ConfigureAwait(false);
        var writeData = ReadRequestData(writeRoot);
        if (writeData is { } data)
        {
            var retCode = ReadInt(data, "retCode");
            if (retCode != 0)
            {
                throw new OnlineUpstreamException($"QQ 音乐新增喜欢失败 code={retCode}", 502);
            }
        }

        OnlineHttp.Info($"POST qq/library like mid={mid} songId={songId} ok");
    }
'''

SERVICE = '''
    // 「加入我喜欢」写入接口：成功后失效该音源缓存，下一次读取就能看到新数据。
    public async Task AddLikedAsync(string source, string trackId, CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        source = NormalizeSource(source);
        if (string.IsNullOrWhiteSpace(trackId))
        {
            throw new OnlineUpstreamException("缺少歌曲 id 参数", 400);
        }

        if (_accounts?.IsLoggedIn(source) != true)
        {
            throw new OnlineUpstreamException("该音源尚未登录，请先登录", 401);
        }

        switch (source)
        {
            case AccountSources.Netease:
                await _netease.AddLikedAsync(trackId, cancellationToken).ConfigureAwait(false);
                break;
            case AccountSources.Qq:
                await _qq.AddLikedAsync(trackId, cancellationToken).ConfigureAwait(false);
                break;
            default:
                throw new OnlineUpstreamException("未知音源", 400);
        }

        Refresh(source);
    }
'''

insert_before_last_brace(BASE + r"\Library\NeteaseLibraryProvider.cs", NETEASE)
insert_before_last_brace(BASE + r"\Library\QqLibraryProvider.cs", QQ)
insert_before_last_brace(BASE + r"\Library\LibraryService.cs", SERVICE)

SERVER_PATH = BASE + r"\LocalMusicServer.cs"
server = read(SERVER_PATH)
route_old = '                "/api/library/refresh" => isGet ? HandleLibraryRefresh(context) : MethodNotAllowed(context),'
route_new = route_old + '\n                "/api/library/like" => isPost ? await HandleLibraryLikeAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),'
assert server.count(route_old) == 1
server = server.replace(route_old, route_new, 1)

HANDLER = '''    private async Task<int> HandleLibraryLikeAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var library = _library;
        if (library is null)
        {
            return WriteError(context, 503, "library-unavailable", "个人音乐库服务不可用");
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim().ToLowerInvariant();
        if (!LibraryService.IsKnownSource(source))
        {
            return WriteError(context, 400, "bad-request", "source 参数必须是 netease 或 qq");
        }

        var id = (query["id"] ?? string.Empty).Trim();
        if (id.Length == 0)
        {
            return WriteError(context, 400, "bad-request", "缺少 id 参数");
        }

        try
        {
            await library.AddLikedAsync(source, id, _shutdown.Token).ConfigureAwait(false);
            WriteJson(context, 200, JsonSerializer.Serialize(new LibraryRefreshResponse(), LibraryJsonContext.Default.LibraryRefreshResponse));
            return 200;
        }
        catch (OnlineUpstreamException exception)
        {
            return WriteLibraryError(context, exception);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error($"POST library/like source={source} failed", exception);
            return WriteError(context, 502, "upstream-failed", "加入喜欢失败，请稍后重试");
        }
    }

'''

anchor = "    private int HandleLibraryRefresh(HttpListenerContext context)"
assert server.count(anchor) == 1
server = server.replace(anchor, HANDLER + anchor, 1)
write(SERVER_PATH, server)
print("host like API patched")
