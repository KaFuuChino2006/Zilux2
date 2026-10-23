# -*- coding: utf-8 -*-
"""LocalMusicServer：批量收藏状态（?ids=）与取消收藏路由。"""
import io

PATH = r"E:\Zilux2开发\src\Zilux2\Online\LocalMusicServer.cs"

with io.open(PATH, "r", encoding="utf-8", newline="") as fh:
    text = fh.read()
E = "\r\n" if "\r\n" in text else "\n"


def sub(old, new, label=""):
    global text
    o, n = old.replace("\n", E), new.replace("\n", E)
    assert text.count(o) == 1, f"{label or old.splitlines()[0][:60]} -> {text.count(o)}"
    text = text.replace(o, n)


# 1) 路由：新增 unlike
sub(
    '                "/api/library/like" => isPost ? await HandleLibraryLikeAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),',
    '                "/api/library/like" => isPost ? await HandleLibraryLikeAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),\n'
    '                "/api/library/unlike" => isPost ? await HandleLibraryUnlikeAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),',
    "路由 unlike",
)

# 2) 批量收藏状态：GET /api/library/liked?source=&ids=a,b,c
sub(
    """        var query = context.Request.QueryString;
        var source = query["source"] ?? string.Empty;
        var id = query["id"] ?? string.Empty;
        if (source.Length == 0 || id.Length == 0)
        {
            return WriteError(context, 400, "bad-request", "缺少 source 或 id 参数");
        }

        var library = _library;
        if (library is null)
        {
            return WriteError(context, 503, "not-ready", "在线服务尚未就绪");
        }

        try
        {
            var liked = await library.CheckLikedAsync(source, id, token).ConfigureAwait(false);
            WriteJson(context, 200, JsonSerializer.Serialize(new { liked }));
            return 200;
        }
        catch (OnlineUpstreamException error)
        {
            return WriteError(context, error.StatusCode, "upstream-failed", error.Message);
        }""",
    """        var query = context.Request.QueryString;
        var source = query["source"] ?? string.Empty;
        var id = query["id"] ?? string.Empty;
        var ids = query["ids"] ?? string.Empty;
        if (source.Length == 0 || (id.Length == 0 && ids.Length == 0))
        {
            return WriteError(context, 400, "bad-request", "缺少 source 或 id/ids 参数");
        }

        var library = _library;
        if (library is null)
        {
            return WriteError(context, 503, "not-ready", "在线服务尚未就绪");
        }

        try
        {
            // 批量模式：搜索结果一次点亮所有收藏按钮（各音源内部合并请求）。
            if (ids.Length > 0)
            {
                var list = ids.Split([',', '|'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                var many = await library.CheckLikedManyAsync(source, list, token).ConfigureAwait(false);
                WriteJson(context, 200, JsonSerializer.Serialize(new { liked = many }));
                return 200;
            }

            var liked = await library.CheckLikedAsync(source, id, token).ConfigureAwait(false);
            WriteJson(context, 200, JsonSerializer.Serialize(new { liked }));
            return 200;
        }
        catch (OnlineUpstreamException error)
        {
            return WriteError(context, error.StatusCode, "upstream-failed", error.Message);
        }""",
    "批量 liked",
)

# 3) 取消收藏 handler：插在 HandleLibraryLikeAsync 之后
sub(
    """    private int HandleLibraryRefresh(HttpListenerContext context)""",
    """    private async Task<int> HandleLibraryUnlikeAsync(HttpListenerContext context)
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
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        var id = (query["id"] ?? string.Empty).Trim();
        if (id.Length == 0)
        {
            return WriteError(context, 400, "bad-request", "缺少 id 参数");
        }

        try
        {
            await library.RemoveLikedAsync(source, id, _shutdown.Token).ConfigureAwait(false);
            WriteJson(context, 200, JsonSerializer.Serialize(new LibraryRefreshResponse(), LibraryJsonContext.Default.LibraryRefreshResponse));
            return 200;
        }
        catch (OnlineUpstreamException exception)
        {
            return WriteLibraryError(context, exception);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error($"POST library/unlike source={source} failed", exception);
            return WriteError(context, 502, "upstream-failed", "取消喜欢失败，请稍后重试");
        }
    }

    private int HandleLibraryRefresh(HttpListenerContext context)""",
    "unlike handler",
)

with io.open(PATH, "w", encoding="utf-8", newline="") as fh:
    fh.write(text)
print("LocalMusicServer.cs OK")
