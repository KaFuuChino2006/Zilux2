# -*- coding: utf-8 -*-
"""本地歌曲库：宿主改为自己响应 localmusic.local 资源请求（含 Range + 日志），
并把页面 console 转发进 host.log；页面侧加 [local] 诊断日志与播放失败详情。"""
import io
import sys


def load(path):
    raw = io.open(path, "r", encoding="utf-8", newline="").read()
    crlf = "\r\n" in raw
    return raw.replace("\r\n", "\n"), crlf


def save(path, text, crlf):
    data = text.replace("\n", "\r\n") if crlf else text
    io.open(path, "w", encoding="utf-8", newline="").write(data)


def patch(path, steps):
    text, crlf = load(path)
    for name, old, new, count in steps:
        got = text.count(old)
        assert got == count, f"{name}: count={got} expected {count}"
        text = text.replace(old, new)
        print(f"OK: {name}")
    save(path, text, crlf)


ROOT = r"E:\Zilux2开发"
CS = ROOT + r"\src\Zilux2\Local\LocalMusicService.cs"
SS = ROOT + r"\web\src\ui\spaceShell.ts"
IP = ROOT + r"\web\src\ui\islandPlayer.ts"

cs_steps = [
    (
        "cs-fields",
        "    private readonly Action<string> _post;\n",
        "    private readonly Action<string> _post;\n"
        "    private string _currentFolder = string.Empty;\n"
        "    private CoreWebView2? _attachedCore;\n",
        1,
    ),
    (
        "cs-handle-ensure",
        "    public void Handle(JsonElement root)\n    {\n",
        "    public void Handle(JsonElement root)\n    {\n        EnsureCore();\n\n",
        1,
    ),
    (
        "cs-load-folder",
        "        var core = _core();\n        if (core is null)\n",
        "        EnsureCore();\n        _currentFolder = fullPath;\n\n        var core = _core();\n        if (core is null)\n",
        1,
    ),
    (
        "cs-methods",
        "    /// <summary>处理页面发来的 local 指令：pick（弹文件夹选择）/ restore（按上次路径重载）。</summary>\n",
        """    /// <summary>挂上 localmusic.local 的资源响应与页面 console 转发（只挂一次）。</summary>
    private void EnsureCore()
    {
        var core = _core();
        if (core is null || ReferenceEquals(core, _attachedCore))
        {
            return;
        }

        try
        {
            core.AddWebResourceRequestedFilter($"https://{VirtualHost}/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnWebResourceRequested;
            core.ConsoleMessageReceived += OnConsoleMessage;
            _attachedCore = core;
            HostLog.Info("[local] resource bridge attached");
        }
        catch (Exception exception)
        {
            HostLog.Error("[local] resource bridge attach failed", exception);
        }
    }

    /// <summary>把页面 console 转发进 host.log，方便排查。</summary>
    private void OnConsoleMessage(object? sender, CoreWebView2ConsoleMessageReceivedEventArgs e)
    {
        var text = e.Message;
        if (text.Length > 400)
        {
            text = text[..400];
        }

        HostLog.Info($"[web:{e.Level}] {text}");
    }

    /// <summary>自己响应 https://localmusic.local/ 下的文件（支持 Range，供音频拖动进度）。</summary>
    private void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var core = _attachedCore;
        if (core is null)
        {
            return;
        }

        Uri uri;
        try
        {
            uri = new Uri(e.Request.Uri);
        }
        catch
        {
            return;
        }

        if (!string.Equals(uri.Host, VirtualHost, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var relative = Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');
        var folder = _currentFolder;
        if (relative.Length == 0 || folder.Length == 0)
        {
            Respond(e, core, 404, "Not Found", "text/plain", Array.Empty<byte>());
            return;
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(Path.Combine(folder, relative.Replace('/', Path.DirectorySeparatorChar)));
        }
        catch
        {
            Respond(e, core, 404, "Not Found", "text/plain", Array.Empty<byte>());
            return;
        }

        if (!fullPath.StartsWith(folder, StringComparison.OrdinalIgnoreCase) || !File.Exists(fullPath))
        {
            HostLog.Warn($"[local] 404 {uri.AbsolutePath}");
            Respond(e, core, 404, "Not Found", "text/plain", Array.Empty<byte>());
            return;
        }

        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(fullPath);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] read failed {fullPath}: {exception.Message}");
            Respond(e, core, 500, "Internal Server Error", "text/plain", Array.Empty<byte>());
            return;
        }

        var contentType = ContentTypeOf(fullPath);
        var total = bytes.Length;
        var range = TryGetHeader(e.Request.Headers, "Range");
        HostLog.Info($"[local] serve {Path.GetFileName(fullPath)} {total}B range={range ?? "-"} type={contentType}");

        if (!string.IsNullOrWhiteSpace(range) && range.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase))
        {
            var spec = range.Substring(6).Split(',')[0].Trim();
            var dash = spec.IndexOf('-');
            if (dash > 0)
            {
                var startText = spec.Substring(0, dash);
                var endText = spec.Substring(dash + 1);
                if (int.TryParse(startText, out var start) && start >= 0 && start < total)
                {
                    var end = total - 1;
                    if (endText.Length > 0 && int.TryParse(endText, out var parsedEnd) && parsedEnd >= start && parsedEnd < total)
                    {
                        end = parsedEnd;
                    }

                    var slice = new byte[end - start + 1];
                    Array.Copy(bytes, start, slice, 0, slice.Length);
                    Respond(e, core, 206, "Partial Content", contentType, slice, $"bytes {start}-{end}/{total}");
                    return;
                }
            }
        }

        Respond(e, core, 200, "OK", contentType, bytes);
    }

    private static void Respond(
        CoreWebView2WebResourceRequestedEventArgs e,
        CoreWebView2 core,
        int status,
        string reason,
        string contentType,
        byte[] bytes,
        string? contentRange = null)
    {
        var headers = $"Content-Type: {contentType}\\r\\nAccept-Ranges: bytes\\r\\nCache-Control: no-store";
        if (contentRange is not null)
        {
            headers += $"\\r\\nContent-Range: {contentRange}";
        }

        e.Response = core.Environment.CreateWebResourceResponse(new MemoryStream(bytes), status, reason, headers);
    }

    private static string? TryGetHeader(CoreWebView2HttpRequestHeaders headers, string name)
    {
        try
        {
            var value = headers.GetHeader(name);
            return string.IsNullOrWhiteSpace(value) ? null : value;
        }
        catch
        {
            return null;
        }
    }

    private static string ContentTypeOf(string path)
    {
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".mp3" => "audio/mpeg",
            ".flac" => "audio/flac",
            ".wav" => "audio/wav",
            ".m4a" => "audio/mp4",
            ".aac" => "audio/aac",
            ".ogg" => "audio/ogg",
            ".oga" => "audio/ogg",
            ".opus" => "audio/ogg",
            ".wma" => "audio/x-ms-wma",
            ".aiff" => "audio/aiff",
            ".aif" => "audio/aiff",
            ".ape" => "audio/x-ape",
            ".dsf" => "audio/x-dsf",
            _ => "application/octet-stream",
        };
    }

    /// <summary>处理页面发来的 local 指令：pick（弹文件夹选择）/ restore（按上次路径重载）。</summary>
""",
        1,
    ),
]

ss_steps = [
    (
        "ss-apply-log",
        "  function applyLocalLibrary(payload: LocalLibraryPayload, show: boolean): void {\n    const album = payload.name || '本地歌曲';\n",
        "  function applyLocalLibrary(payload: LocalLibraryPayload, show: boolean): void {\n    console.info('[local] apply', payload.tracks.length, payload.folder, 'show=' + show);\n    const album = payload.name || '本地歌曲';\n",
        1,
    ),
    (
        "ss-pick-log",
        "  function pickLocalLibrary(): void {\n    if (localPickBusy) return;\n    localPickBusy = true;\n",
        "  function pickLocalLibrary(): void {\n    if (localPickBusy) return;\n    console.info('[local] pick requested');\n    localPickBusy = true;\n",
        1,
    ),
    (
        "ss-rail-log",
        "  function handleLocalRail(): void {\n    if (localPickBusy) return;\n",
        "  function handleLocalRail(): void {\n    console.info('[local] rail click', { busy: localPickBusy, tracks: localTracks.length, view: localViewOpen, tried: localRestoreTried });\n    if (localPickBusy) {\n      showToast('本地文件夹选择器还开着，请先完成选择', 'info');\n      return;\n    }\n",
        1,
    ),
    (
        "ss-event-log",
        "  onLocalLibrary((payload) => {\n",
        "  onLocalLibrary((payload) => {\n    console.info('[local] event', payload.error ?? payload.tracks.length, payload.folder ?? '');\n",
        1,
    ),
]

ip_steps = [
    (
        "ip-play-catch-log",
        "        options.onError?.('播放失败：可能需要会员或已被下架');\n",
        "        console.warn('[player] play() rejected', audio.error?.code, audio.error?.message, audio.currentSrc || audio.src);\n        options.onError?.('播放失败：可能需要会员或已被下架');\n",
        1,
    ),
    (
        "ip-promise-log",
        "    if (promise) promise.catch(() => options.onError?.('播放失败：可能需要会员或已被下架'));\n",
        "    if (promise) {\n      promise.catch(() => {\n        console.warn('[player] play() promise failed', audio.error?.code, audio.error?.message, audio.currentSrc || audio.src);\n        options.onError?.('播放失败：可能需要会员或已被下架');\n      });\n    }\n",
        1,
    ),
    (
        "ip-error-log",
        "    if (index >= 0) options.onError?.('音频加载失败：可能需要会员或已被下架');\n",
        "    console.warn('[player] audio error event', audio.error?.code, audio.error?.message, audio.currentSrc || audio.src);\n    if (index >= 0) options.onError?.('音频加载失败：可能需要会员或已被下架');\n",
        1,
    ),
]

patch(CS, cs_steps)
patch(SS, ss_steps)
patch(IP, ip_steps)
print("DONE")
