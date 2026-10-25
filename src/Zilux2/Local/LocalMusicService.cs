using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
using Zilux2.Media;
using Zilux2.Online;

namespace Zilux2.Local;

/// <summary>
/// 本地歌曲库：让用户选一个文件夹，递归扫描其中的音频文件，
/// 页面通过虚拟主机 https://localmusic.local/ 直接用 &lt;audio&gt; 播放。
/// 注意：虚拟主机只用 WebResourceRequested 响应（OnWebResourceRequested），绝不调用
/// SetVirtualHostNameToFolderMapping —— 文件夹映射由 WebView2 进程直接解析，页面导航后会优先于
/// WebResourceRequested，把 /__dl/、/__cover、Range 分段与 DSF/ALAC 转码全部旁路掉（1.1.8 真机 bug）。
/// </summary>
internal sealed partial class LocalMusicService
{
    /// <summary>文件夹在页面侧的访问域名（只读映射）。</summary>
    public const string VirtualHost = "localmusic.local";

    /// <summary>本地曲目 rel 前缀：以它开头表示来自「下载目录」，页面按 /__dl/ 取文件。</summary>
    public const string DownloadRelPrefix = "@downloads/";

    private static readonly HashSet<string> AudioExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wma", ".aiff", ".aif", ".ape", ".dsf",
    };

    private const int MaxTracks = 1200;

    private readonly MainWindow _window;
    private readonly Func<CoreWebView2?> _core;
    private readonly Action<string> _post;
    private readonly Func<string>? _downloadFolderProvider;

    // 目录监控开关（settings.general.watchLocalFolder）：构造时取初值（_watchEnabled 字段在
    // Watch.cs 里声明），patch 后由 SetWatchEnabled 即时启停 watcher。
    private string _currentFolder = string.Empty;
    private string _downloadFolder = string.Empty;
    private List<LocalTrackDto> _folderTracks = new();
    private List<string> _folderLyrics = new();
    private readonly List<LocalTrackDto> _downloadTracks = new();
    private CoreWebView2? _attachedCore;
    private readonly Dictionary<string, (byte[] Bytes, string ContentType)> _coverCache =
        new(StringComparer.OrdinalIgnoreCase);

    public LocalMusicService(
        MainWindow window,
        Func<CoreWebView2?> core,
        Action<string> post,
        Func<string>? downloadFolderProvider = null,
        Func<bool>? watchEnabledProvider = null)
    {
        _window = window;
        _core = core;
        _post = post;
        _downloadFolderProvider = downloadFolderProvider;
        _watchEnabled = watchEnabledProvider?.Invoke() ?? true;
        SmtcArtwork.LocalResolver = TryReadCoverBytes;
    }

    /// <summary>Windows 媒体浮层的封面：把 https://localmusic.local/__cover?rel=… 映射回本地文件。</summary>
    private byte[]? TryReadCoverBytes(string source)
    {
        if (!Uri.TryCreate(source, UriKind.Absolute, out var uri)
            || !string.Equals(uri.Host, VirtualHost, StringComparison.OrdinalIgnoreCase)
            || _currentFolder.Length == 0)
        {
            return null;
        }

        var rel = string.Equals(uri.AbsolutePath, "/__cover", StringComparison.OrdinalIgnoreCase)
            ? QueryValue(uri.Query, "rel")
            : Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');
        if (string.IsNullOrWhiteSpace(rel))
        {
            return null;
        }

        try
        {
            var fullPath = Path.GetFullPath(Path.Combine(_currentFolder, rel.Replace('/', Path.DirectorySeparatorChar)));
            if (!fullPath.StartsWith(_currentFolder, StringComparison.OrdinalIgnoreCase) || !File.Exists(fullPath))
            {
                return null;
            }

            return LocalCover.Read(fullPath)?.Bytes;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>挂上 localmusic.local 的资源响应与页面 console 转发（只挂一次）。</summary>
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
            _attachedCore = core;

            // 防御性清理：旧版本/外部可能在同一个 CoreWebView2 上设置过文件夹映射。映射会让
            // https://localmusic.local/* 在 WebView2 进程内直接解析、不再触发 WebResourceRequested，
            // 导致 /__dl/<rel> 被当成 <曲库根>/__dl/<rel> 去找文件（ERR_FILE_NOT_FOUND）。
            try
            {
                core.ClearVirtualHostNameToFolderMapping(VirtualHost);
                HostLog.Info($"[local] cleared stale virtual host mapping host={VirtualHost}");
            }
            catch (Exception exception)
            {
                // 没有可清理的映射时不同 WebView2 版本可能抛异常，忽略即可。
                HostLog.Info($"[local] no virtual host mapping to clear: {exception.Message}");
            }

            HostLog.Info($"[local] resource bridge attached host={VirtualHost} filter=all core={core.GetHashCode()}");
        }
        catch (Exception exception)
        {
            HostLog.Error("[local] resource bridge attach failed", exception);
        }
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

        HostLog.Info($"[local] req {uri.AbsolutePath}");

        if (string.Equals(uri.AbsolutePath, "/__cover", StringComparison.OrdinalIgnoreCase))
        {
            ServeCover(e, core, uri);
            return;
        }

        if (uri.AbsolutePath.StartsWith("/__dl/", StringComparison.OrdinalIgnoreCase))
        {
            ServeDownloadFile(e, core, uri);
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

        ServeLocalFile(e, core, fullPath);
    }

    /// <summary>按 Range 从磁盘分段读取（大文件不整块进内存）；DSF 先转成 WAV 缓存再当 WAV 提供。</summary>
    private static void ServeLocalFile(CoreWebView2WebResourceRequestedEventArgs e, CoreWebView2 core, string fullPath)
    {
        var path = fullPath;
        var contentType = ContentTypeOf(fullPath);
        if (string.Equals(Path.GetExtension(fullPath), ".dsf", StringComparison.OrdinalIgnoreCase))
        {
            if (!DsfTranscoder.TryEnsureWav(fullPath, out var wavPath, out var error))
            {
                HostLog.Warn($"[local] dsf transcode failed {Path.GetFileName(fullPath)}: {error}");
                Respond(e, core, 415, "Unsupported Media Type", "text/plain", System.Text.Encoding.UTF8.GetBytes(error));
                return;
            }

            path = wavPath;
            contentType = "audio/wav";
        }
        else if (string.Equals(Path.GetExtension(fullPath), ".m4a", StringComparison.OrdinalIgnoreCase)
            && AlacTranscoder.IsAlac(fullPath))
        {
            // ALAC 无损 m4a：WebView2 解不了，先转成 PCM WAV 再流式服务
            if (!AlacTranscoder.TryEnsureWav(fullPath, out var alacWavPath, out var alacError))
            {
                HostLog.Warn($"[local] alac transcode failed {Path.GetFileName(fullPath)}: {alacError}");
                Respond(e, core, 415, "Unsupported Media Type", "text/plain", System.Text.Encoding.UTF8.GetBytes(alacError));
                return;
            }

            path = alacWavPath;
            contentType = "audio/wav";
        }

        long total;
        try
        {
            total = new FileInfo(path).Length;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] size failed {path}: {exception.Message}");
            Respond(e, core, 500, "Internal Server Error", "text/plain", Array.Empty<byte>());
            return;
        }

        var rangeHeader = TryGetHeader(e.Request.Headers, "Range");
        long start = 0;
        long end = total - 1;
        var partial = false;
        if (!string.IsNullOrWhiteSpace(rangeHeader) && rangeHeader.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase))
        {
            var spec = rangeHeader.Substring(6).Split(',')[0].Trim();
            var dash = spec.IndexOf('-');
            if (dash >= 0)
            {
                var startText = spec.Substring(0, dash);
                var endText = spec.Substring(dash + 1);
                if (startText.Length == 0 && long.TryParse(endText, out var suffix) && suffix > 0)
                {
                    start = Math.Max(0, total - suffix);
                }
                else if (long.TryParse(startText, out var parsedStart))
                {
                    start = Math.Max(0, Math.Min(parsedStart, total - 1));
                    if (endText.Length > 0 && long.TryParse(endText, out var parsedEnd))
                    {
                        end = Math.Max(start, Math.Min(parsedEnd, total - 1));
                    }
                }

                partial = true;
            }
        }

        if (end < start || total <= 0)
        {
            Respond(e, core, 416, "Range Not Satisfiable", "text/plain", Array.Empty<byte>());
            return;
        }

        byte[] bytes;
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            stream.Position = start;
            bytes = new byte[end - start + 1];
            var read = 0;
            while (read < bytes.Length)
            {
                var got = stream.Read(bytes, read, bytes.Length - read);
                if (got <= 0)
                {
                    break;
                }

                read += got;
            }

            if (read < bytes.Length)
            {
                Array.Resize(ref bytes, read);
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] read failed {path}: {exception.Message}");
            Respond(e, core, 500, "Internal Server Error", "text/plain", Array.Empty<byte>());
            return;
        }

        HostLog.Info($"[local] serve {Path.GetFileName(path)} {bytes.Length}B range={rangeHeader ?? "-"} type={contentType}");
        if (partial)
        {
            Respond(e, core, 206, "Partial Content", contentType, bytes, $"bytes {start}-{start + bytes.Length - 1}/{total}");
            return;
        }

        Respond(e, core, 200, "OK", contentType, bytes);
    }

    /// <summary>响应内嵌封面请求：https://localmusic.local/__cover?rel=相对路径</summary>
    private void ServeCover(CoreWebView2WebResourceRequestedEventArgs e, CoreWebView2 core, Uri uri)
    {
        var rel = QueryValue(uri.Query, "rel");
        var folder = _currentFolder;
        if (rel is not null && rel.StartsWith("@downloads/", StringComparison.Ordinal))
        {
            // 下载目录里的文件同样支持内嵌封面，路径前缀与曲库 rel 一致。
            folder = _downloadFolder;
            rel = rel["@downloads/".Length..];
        }

        if (rel is null || folder.Length == 0)
        {
            Respond(e, core, 404, "Not Found", "text/plain", Array.Empty<byte>());
            return;
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(Path.Combine(folder, rel.Replace('/', Path.DirectorySeparatorChar)));
        }
        catch
        {
            Respond(e, core, 404, "Not Found", "text/plain", Array.Empty<byte>());
            return;
        }

        if (!fullPath.StartsWith(folder, StringComparison.OrdinalIgnoreCase) || !File.Exists(fullPath))
        {
            Respond(e, core, 404, "Not Found", "text/plain", Array.Empty<byte>());
            return;
        }

        byte[] bytes;
        string contentType;
        lock (_coverCache)
        {
            if (_coverCache.TryGetValue(fullPath, out var cached))
            {
                bytes = cached.Bytes;
                contentType = cached.ContentType;
            }
            else
            {
                var found = LocalCover.Read(fullPath);
                if (found is null)
                {
                    HostLog.Warn($"[local] cover missing {Path.GetFileName(fullPath)}");
                    Respond(e, core, 404, "Not Found", "text/plain", Array.Empty<byte>());
                    return;
                }

                bytes = found.Value.Bytes;
                contentType = found.Value.ContentType;
                if (_coverCache.Count >= 200)
                {
                    _coverCache.Clear();
                }

                _coverCache[fullPath] = (bytes, contentType);
            }
        }

        HostLog.Info($"[local] cover {Path.GetFileName(fullPath)} {bytes.Length}B {contentType}");
        Respond(e, core, 200, "OK", contentType, bytes);
    }

    private static string? QueryValue(string query, string key)
    {
        foreach (var part in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = part.IndexOf('=');
            if (eq <= 0)
            {
                continue;
            }

            if (string.Equals(Uri.UnescapeDataString(part.Substring(0, eq)), key, StringComparison.OrdinalIgnoreCase))
            {
                return Uri.UnescapeDataString(part.Substring(eq + 1));
            }
        }

        return null;
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
        var headers =
            $"Content-Type: {contentType}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store"
            + "\r\nAccess-Control-Allow-Origin: *"
            + "\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS"
            + "\r\nAccess-Control-Allow-Headers: Range, Content-Type"
            + "\r\nAccess-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges";
        if (contentRange is not null)
        {
            headers += $"\r\nContent-Range: {contentRange}";
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
            ".lrc" => "text/plain; charset=utf-8",
            ".json" => "application/json; charset=utf-8",
            ".jpg" => "image/jpeg",
            ".jpeg" => "image/jpeg",
            ".png" => "image/png",
            ".webp" => "image/webp",
            ".gif" => "image/gif",
            ".bmp" => "image/bmp",
            _ => "application/octet-stream",
        };
    }

    /// <summary>处理页面发来的 local 指令：pick（弹文件夹选择）/ restore（按上次路径重载）。</summary>
    public void Handle(JsonElement root)
    {
        EnsureCore();

        var action = root.TryGetProperty("action", out var actionElement) && actionElement.ValueKind == JsonValueKind.String
            ? actionElement.GetString()
            : null;

        switch (action)
        {
            case "pick":
                PickFolder();
                break;

            case "rescan":
                EnsureDownloadFolder();
                RescanDownloads();
                PostMergedTracks();
                break;

            case "restore":
            {
                var folder = root.TryGetProperty("folder", out var folderElement) && folderElement.ValueKind == JsonValueKind.String
                    ? folderElement.GetString()
                    : null;
                if (string.IsNullOrWhiteSpace(folder))
                {
                    PostError(null, "没有记录过本地歌曲文件夹");
                    return;
                }

                Load(folder);
                break;
            }

            case "openDownloadDir":
            {
                var folder = root.TryGetProperty("folder", out var folderElement) && folderElement.ValueKind == JsonValueKind.String
                    ? folderElement.GetString()
                    : null;
                OpenDownloadFolder(folder);
                break;
            }

            case "delete":
            {
                var rels = new List<string>();
                if (root.TryGetProperty("rels", out var relsElement) && relsElement.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in relsElement.EnumerateArray())
                    {
                        if (item.ValueKind == JsonValueKind.String && item.GetString() is { Length: > 0 } rel)
                        {
                            rels.Add(rel);
                        }
                    }
                }

                DeleteTracks(rels);
                break;
            }

            case "reveal":
            {
                var rel = root.TryGetProperty("rel", out var relElement) && relElement.ValueKind == JsonValueKind.String
                    ? relElement.GetString()
                    : null;
                RevealTrack(rel);
                break;
            }

            case "openFolder":
                OpenLocalFolder();
                break;

            default:
                PostError(null, $"未知的本地歌曲指令：{action ?? "<missing>"}");
                break;
        }
    }

    /// <summary>
    /// 把页面传来的 rel 解析成磁盘路径（越界 / 不存在返回 null）。internal 供离线节拍分析
    /// (/api/analysis) 复用；注意它会触发 EnsureDownloadFolder → RescanDownloads，调用方必须在 UI 线程。
    /// </summary>
    internal string? ResolveTrackPath(string? rel)
    {
        if (string.IsNullOrWhiteSpace(rel))
        {
            return null;
        }

        EnsureDownloadFolder();
        string root;
        string relative;
        if (rel.StartsWith(DownloadRelPrefix, StringComparison.Ordinal))
        {
            root = _downloadFolder;
            relative = rel[DownloadRelPrefix.Length..];
        }
        else
        {
            root = _currentFolder;
            relative = rel;
        }

        if (root.Length == 0 || relative.Length == 0)
        {
            return null;
        }

        try
        {
            var normalizedRoot = Path.GetFullPath(root);
            var fullPath = Path.GetFullPath(Path.Combine(normalizedRoot, relative.Replace('/', Path.DirectorySeparatorChar)));
            var prefix = normalizedRoot.EndsWith(Path.DirectorySeparatorChar) ? normalizedRoot : normalizedRoot + Path.DirectorySeparatorChar;
            if (!fullPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            return File.Exists(fullPath) ? fullPath : null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>把选中的本地/下载文件（连同 .lrc/.json sidecar）移进回收站，并刷新曲库。</summary>
    private void DeleteTracks(List<string> rels)
    {
        if (rels.Count == 0)
        {
            PostResult("delete", false, "没有指定要删除的文件");
            return;
        }

        var paths = new List<string>();
        var missing = 0;
        foreach (var rel in rels)
        {
            var fullPath = ResolveTrackPath(rel);
            if (fullPath is null)
            {
                missing += 1;
                continue;
            }

            paths.Add(fullPath);
            var directory = Path.GetDirectoryName(fullPath);
            var stem = Path.GetFileNameWithoutExtension(fullPath);
            if (directory is null)
            {
                continue;
            }

            foreach (var sidecar in new[] { ".lrc", ".json" })
            {
                var sibling = Path.Combine(directory, stem + sidecar);
                if (File.Exists(sibling))
                {
                    paths.Add(sibling);
                }
            }
        }

        if (paths.Count == 0)
        {
            PostResult("delete", false, missing > 0 ? "找不到要删除的文件（可能已被移动）" : "没有可删除的文件");
            return;
        }

        // 自己删的文件别让 watcher 再触发一轮增量扫描。
        foreach (var path in paths)
        {
            MarkHostWrite(path);
        }

        var failed = Zilux2.Interop.NativeMethods.MoveFilesToRecycleBin(paths);
        HostLog.Info($"[local] delete: {paths.Count - failed} file(s) -> recycle bin, {failed} failed, {missing} missing");
        if (failed == 0)
        {
            PostResult("delete", true, "已移到回收站");
        }
        else
        {
            PostResult("delete", false, "删除失败：文件可能正被播放占用，先切歌或暂停再试");
        }

        ReloadAfterChange();
    }

    private void RevealTrack(string? rel)
    {
        var fullPath = ResolveTrackPath(rel);
        if (fullPath is null)
        {
            PostResult("reveal", false, "找不到文件");
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = $"/select,\"{fullPath}\"",
                UseShellExecute = true,
            });
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] reveal failed: {exception.Message}");
            PostResult("reveal", false, "打开资源管理器失败");
        }
    }

    private void OpenLocalFolder()
    {
        if (_currentFolder.Length == 0)
        {
            PostError(null, "还没有选择本地歌曲文件夹");
            return;
        }

        try
        {
            Directory.CreateDirectory(_currentFolder);
            Process.Start(new ProcessStartInfo { FileName = _currentFolder, UseShellExecute = true });
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] open folder failed: {exception.Message}");
            PostError(null, $"打不开本地文件夹：{exception.Message}");
        }
    }

    /// <summary>删除/改名后重新扫描并推送曲库。</summary>
    private void ReloadAfterChange()
    {
        EnsureDownloadFolder();
        RescanDownloads();
        if (_currentFolder.Length > 0 && Directory.Exists(_currentFolder))
        {
            Load(_currentFolder);
        }
        else
        {
            PostMergedTracks();
        }
    }

    private void PostResult(string action, bool ok, string message)
    {
        var result = new LocalResultMessage
        {
            Payload = new LocalActionResult { Action = action, Ok = ok, Message = message },
        };
        _post(JsonSerializer.Serialize(result, LocalLibraryJsonContext.Default.LocalResultMessage));
    }

    private void PickFolder()
    {
        try
        {
            var dialog = new OpenFolderDialog
            {
                Title = "选择本地歌曲文件夹",
                Multiselect = false,
            };
            var owner = _window.IsLoaded ? _window : null;
            var picked = owner is null ? dialog.ShowDialog() : dialog.ShowDialog(owner);
            if (picked != true || string.IsNullOrWhiteSpace(dialog.FolderName))
            {
                HostLog.Info("[local] folder pick cancelled");
                PostCancel();
                return;
            }

            Load(dialog.FolderName);
        }
        catch (Exception exception)
        {
            HostLog.Error("[local] folder pick failed", exception);
            PostError(null, $"打开文件夹选择器失败：{exception.Message}");
        }
    }

    private void Load(string folder)
    {
        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(folder);
        }
        catch (Exception exception)
        {
            PostError(null, $"路径无效：{exception.Message}");
            return;
        }

        if (!Directory.Exists(fullPath))
        {
            PostError(fullPath, "文件夹不存在或已被移动");
            return;
        }

        EnsureCore();
        _currentFolder = fullPath;

        var core = _core();
        if (core is null)
        {
            StopFolderWatch();
            PostError(fullPath, "WebView2 尚未就绪，请稍后再试");
            return;
        }

        // 关键：不要调用 SetVirtualHostNameToFolderMapping。
        // 文件夹映射由 WebView2 进程直接解析（比 WebResourceRequested 快），但对同一主机设置映射后，
        // 页面下一次导航/刷新会用映射接管 https://localmusic.local/*，不再触发 OnWebResourceRequested：
        //  - /__dl/<rel> 会被解析成 <曲库根>/__dl/<rel>（不存在）→ net::ERR_FILE_NOT_FOUND → 媒体格式错误；
        //  - /__cover、Range 分段、DSF→WAV / ALAC→WAV 转码也都会失效。
        // 这里所有本地文件统一走 WebResourceRequested（见 OnWebResourceRequested），不依赖任何映射。
        HostLog.Info($"[local] serve mode=handler root={fullPath} (no virtual host mapping)");

        // 先起 watcher 再扫盘：初扫期间的新增/改名会攒成批次，扫完后增量补上。
        // 目录监控被设置关掉时（general.watchLocalFolder=false）只扫一次，不再挂 watcher。
        if (_watchEnabled)
        {
            StartFolderWatch(fullPath);
        }
        else
        {
            HostLog.Info("[local] watch disabled by settings (general.watchLocalFolder=false)");
        }

        List<LocalTrackDto> tracks;
        var lyrics = new List<string>();
        try
        {
            tracks = Scan(fullPath, lyrics);
        }
        catch (Exception exception)
        {
            HostLog.Error("[local] scan failed", exception);
            StopFolderWatch();
            PostError(fullPath, $"扫描文件夹失败：{exception.Message}");
            return;
        }

        HostLog.Info($"[local] mapped {fullPath} ({tracks.Count} tracks, {lyrics.Count} lyrics)");
        _folderTracks = tracks;
        _folderLyrics = lyrics;
        PostMergedTracks();
    }

    private static List<LocalTrackDto> Scan(string folder, List<string> lyrics)
    {
        var results = new List<LocalTrackDto>();
        var queue = new Queue<string>();
        queue.Enqueue(folder);
        var visited = 0;

        while (queue.Count > 0 && results.Count < MaxTracks && visited < 20000)
        {
            var current = queue.Dequeue();
            visited += 1;

            string[] files;
            try
            {
                files = Directory.GetFiles(current, "*", SearchOption.TopDirectoryOnly);
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[local] skip folder {current}: {exception.Message}");
                continue;
            }

            var audioFiles = new List<string>();
            var cueFiles = new List<string>();
            foreach (var file in files)
            {
                var extension = Path.GetExtension(file);
                if (string.Equals(extension, ".lrc", StringComparison.OrdinalIgnoreCase))
                {
                    if (lyrics.Count < 2000)
                    {
                        lyrics.Add(Path.GetRelativePath(folder, file).Replace('\\', '/'));
                    }

                    continue;
                }

                if (string.Equals(extension, ".cue", StringComparison.OrdinalIgnoreCase))
                {
                    cueFiles.Add(file);
                    continue;
                }

                if (AudioExtensions.Contains(extension))
                {
                    audioFiles.Add(file);
                }
            }

            // CUE：一个整轨镜像文件按 index 拆成多首（播放时用同一个 URL + startAt 偏移）
            var covered = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var cue in cueFiles)
            {
                if (results.Count >= MaxTracks)
                {
                    break;
                }

                var cueTracks = LocalCue.Parse(cue, folder, HostLog.Info);
                if (cueTracks.Count == 0)
                {
                    continue;
                }

                var durations = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
                foreach (var cueTrack in cueTracks)
                {
                    covered.Add(cueTrack.FileRel);
                }

                for (var i = 0; i < cueTracks.Count && results.Count < MaxTracks; i += 1)
                {
                    var cueTrack = cueTracks[i];
                    var imagePath = Path.Combine(folder, cueTrack.FileRel.Replace('/', Path.DirectorySeparatorChar));
                    if (!File.Exists(imagePath))
                    {
                        continue;
                    }

                    if (!durations.TryGetValue(cueTrack.FileRel, out var imageDuration))
                    {
                        imageDuration = LocalCue.Duration(imagePath);
                        durations[cueTrack.FileRel] = imageDuration;
                    }

                    var nextStart = i + 1 < cueTracks.Count ? cueTracks[i + 1].StartSeconds : imageDuration;
                    var trackDuration = nextStart > cueTrack.StartSeconds ? nextStart - cueTrack.StartSeconds : 0;
                    var title = string.IsNullOrWhiteSpace(cueTrack.Title)
                        ? Path.GetFileNameWithoutExtension(cueTrack.FileRel)
                        : cueTrack.Title;
                    results.Add(new LocalTrackDto
                    {
                        Rel = cueTrack.FileRel,
                        Name = cueTrack.Number > 0 ? $"{cueTrack.Number:00} - {title}" : title,
                        Title = title,
                        Artist = cueTrack.Performer,
                        Size = new FileInfo(imagePath).Length,
                        HasCover = LocalCover.Has(imagePath),
                        StartMs = (long)Math.Round(cueTrack.StartSeconds * 1000),
                        DurationMs = (long)Math.Round(trackDuration * 1000),
                        Cue = cueTrack.Number,
                    });
                }
            }

            foreach (var file in audioFiles)
            {
                if (results.Count >= MaxTracks)
                {
                    break;
                }

                var relative = Path.GetRelativePath(folder, file).Replace('\\', '/');
                if (covered.Contains(relative))
                {
                    continue;
                }

                var fileName = Path.GetFileNameWithoutExtension(file);
                string? tagTitle = null;
                string? tagArtist = null;
                try
                {
                    var tags = LocalTagReader.TryRead(file);
                    if (tags is not null)
                    {
                        tagTitle = tags.Title;
                        tagArtist = tags.Artist;
                    }
                }
                catch (Exception exception)
                {
                    HostLog.Warn($"[local] read tags failed {fileName}: {exception.Message}");
                }

                if (tagArtist is null && TrySplitArtistTitle(fileName, out var splitArtist, out var splitTitle))
                {
                    tagArtist = splitArtist;
                    tagTitle ??= splitTitle;
                }

                results.Add(new LocalTrackDto
                {
                    Rel = relative,
                    Name = tagTitle ?? fileName,
                    Title = tagTitle,
                    Artist = tagArtist,
                    Size = new FileInfo(file).Length,
                    HasCover = LocalCover.Has(file),
                });
            }

            string[] directories;
            try
            {
                directories = Directory.GetDirectories(current);
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[local] list folders failed for {current}: {exception.Message}");
                continue;
            }

            foreach (var directory in directories)
            {
                var name = Path.GetFileName(directory);
                if (name.StartsWith(".", StringComparison.Ordinal))
                {
                    continue;
                }

                queue.Enqueue(directory);
            }
        }

        results.Sort((left, right) =>
        {
            var compare = string.CompareOrdinal(left.Rel, right.Rel);
            return compare != 0 ? compare : left.StartMs.CompareTo(right.StartMs);
        });
        return results;
    }

    /// <summary>「歌手 - 歌名」式文件名拆分（标签缺失时的兜底）。</summary>
    private static bool TrySplitArtistTitle(string fileName, out string artist, out string title)
    {
        artist = string.Empty;
        title = string.Empty;
        var separator = fileName.IndexOf(" - ", StringComparison.Ordinal);
        if (separator <= 0 || separator + 3 >= fileName.Length)
        {
            return false;
        }

        artist = fileName[..separator].Trim();
        title = fileName[(separator + 3)..].Trim();
        return artist.Length > 0 && title.Length > 0;
    }

    /// <summary>下载目录（设置里为空时用 Windows「音乐」目录）。</summary>
    private string ResolveDownloadFolder()
    {
        var configured = _downloadFolderProvider?.Invoke();
        var folder = string.IsNullOrWhiteSpace(configured)
            ? Environment.GetFolderPath(Environment.SpecialFolder.MyMusic)
            : configured.Trim();
        if (string.IsNullOrWhiteSpace(folder))
        {
            return string.Empty;
        }

        try
        {
            return Path.GetFullPath(folder);
        }
        catch
        {
            return string.Empty;
        }
    }

    private void EnsureDownloadFolder()
    {
        var next = ResolveDownloadFolder();
        if (string.Equals(next, _downloadFolder, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        _downloadFolder = next;
        RescanDownloads();
    }

    private void RescanDownloads()
    {
        _downloadTracks.Clear();
        if (_downloadFolder.Length == 0 || !Directory.Exists(_downloadFolder))
        {
            return;
        }

        try
        {
            var count = 0;
            foreach (var file in Directory.EnumerateFiles(_downloadFolder, "*", SearchOption.AllDirectories))
            {
                if (count++ > 4000 || _downloadTracks.Count >= MaxTracks)
                {
                    break;
                }

                var extension = Path.GetExtension(file);
                if (!AudioExtensions.Contains(extension))
                {
                    continue;
                }

                long size;
                try
                {
                    size = new FileInfo(file).Length;
                }
                catch
                {
                    continue;
                }

                var relative = Path.GetRelativePath(_downloadFolder, file).Replace('\\', '/');
                var stem = Path.GetFileNameWithoutExtension(file);
                string? displayTitle = null;
                string? displayArtist = null;
                var meta = Mvmp3Cache.ReadMetaForFile(file);
                if (meta.Title is { Length: > 0 } metaTitle)
                {
                    displayTitle = metaTitle;
                    displayArtist = meta.Artist is { Length: > 0 } metaArtist ? metaArtist : null;
                }
                else
                {
                    try
                    {
                        var tags = LocalTagReader.TryRead(file);
                        if (tags is not null)
                        {
                            displayTitle = tags.Title;
                            displayArtist = tags.Artist;
                        }
                    }
                    catch
                    {
                        // 标签读取失败时退回文件名。
                    }

                    if (displayArtist is null && TrySplitArtistTitle(stem, out var splitArtist, out var splitTitle))
                    {
                        displayArtist = splitArtist;
                        displayTitle ??= splitTitle;
                    }
                }

                var name = displayTitle is { Length: > 0 }
                    ? displayArtist is { Length: > 0 } ? $"{displayArtist} - {displayTitle}" : displayTitle
                    : stem;

                _downloadTracks.Add(new LocalTrackDto
                {
                    Rel = DownloadRelPrefix + relative,
                    Name = name,
                    Title = displayTitle,
                    Artist = displayArtist,
                    HasCover = LocalCover.Has(file),
                    Size = size,
                });
            }

            HostLog.Info($"[local] download folder {_downloadFolder} ({_downloadTracks.Count} tracks)");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] scan download folder failed: {exception.Message}");
        }
    }

    /// <summary>宿主下载完成回调：只关心落在下载目录里的文件。</summary>
    public void NotifyFileAdded(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        EnsureDownloadFolder();
        if (_downloadFolder.Length == 0
            || !path.StartsWith(_downloadFolder, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        // 下载落盘会触发 watcher 事件，先登记成「宿主自己写的」，避免重复扫描同一个文件。
        MarkHostWrite(path);
        RescanDownloads();
        PostOnUi(PostMergedTracks);
    }

    /// <summary>
    /// 标签写入成功后的曲库刷新（UI 线程调用）：下载目录重扫下载列表，曲库目录就地重建该曲目。
    /// 目录监控开着时 watcher 也会触发一次，但宿主自己写过的事件会被抑制窗口吃掉，所以这里
    /// 必须显式刷新——设置里关掉监控时页面同样要立刻看到新标签。
    /// </summary>
    internal void NotifyTagWritten(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(path);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[tag] refresh skipped: {exception.Message}");
            return;
        }

        MarkHostWrite(fullPath);

        EnsureDownloadFolder();
        if (_downloadFolder.Length > 0
            && fullPath.StartsWith(_downloadFolder + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            RescanDownloads();
            PostOnUi(PostMergedTracks);
            return;
        }

        if (_currentFolder.Length == 0
            || !fullPath.StartsWith(_currentFolder + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            // 文件不在曲库/下载目录里（例如页面用绝对路径之外的副本），没有可刷新的列表项。
            return;
        }

        var relative = Path.GetRelativePath(_currentFolder, fullPath).Replace('\\', '/');
        var track = TryBuildTrack(fullPath, relative);
        var upserts = new List<LocalTrackDto>();
        var removals = new List<string>();
        if (track is null)
        {
            removals.Add(relative);
        }
        else
        {
            upserts.Add(track);
        }

        ApplyWatchChanges(
            _currentFolder,
            removals,
            upserts,
            new List<string>(),
            new List<string>(),
            new List<string>(),
            0);
        HostLog.Info($"[tag] refreshed track {relative}");
    }

    /// <summary>打开下载目录（设置页「打开」按钮）。</summary>
    private void OpenDownloadFolder(string? folder)
    {
        var target = string.IsNullOrWhiteSpace(folder) ? ResolveDownloadFolder() : folder.Trim();
        if (target.Length == 0)
        {
            PostError(null, "没有可用的下载目录");
            return;
        }

        try
        {
            Directory.CreateDirectory(target);
            Process.Start(new ProcessStartInfo { FileName = target, UseShellExecute = true });
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] open download folder failed: {exception.Message}");
            PostError(null, $"打不开下载目录：{exception.Message}");
        }
    }

    /// <summary>下载目录里的文件也按 /__dl/ 路径给页面播放。</summary>
    private void ServeDownloadFile(CoreWebView2WebResourceRequestedEventArgs e, CoreWebView2 core, Uri uri)
    {
        EnsureDownloadFolder();
        var relative = Uri.UnescapeDataString(uri.AbsolutePath["/__dl/".Length..]).TrimStart('/');
        if (relative.Length == 0 || _downloadFolder.Length == 0)
        {
            Respond(e, core, 404, "Not Found", "text/plain", Array.Empty<byte>());
            return;
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(Path.Combine(_downloadFolder, relative.Replace('/', Path.DirectorySeparatorChar)));
        }
        catch
        {
            Respond(e, core, 404, "Not Found", "text/plain", Array.Empty<byte>());
            return;
        }

        if (!fullPath.StartsWith(_downloadFolder, StringComparison.OrdinalIgnoreCase) || !File.Exists(fullPath))
        {
            HostLog.Warn($"[local] 404 {uri.AbsolutePath}");
            Respond(e, core, 404, "Not Found", "text/plain", Array.Empty<byte>());
            return;
        }

        ServeLocalFile(e, core, fullPath);
    }

    /// <summary>把「用户选的文件夹」与「下载目录」合并后发给页面的本地曲库。</summary>
    private void PostMergedTracks()
    {
        EnsureDownloadFolder();
        var tracks = new List<LocalTrackDto>(_folderTracks.Count + _downloadTracks.Count);
        // 下载目录和本地文件夹可能是同一个（默认都在「音乐」）——按绝对路径去重，避免同一首歌出现两次。
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var track in _downloadTracks)
        {
            var full = CombinePath(_downloadFolder, track.Rel[DownloadRelPrefix.Length..]);
            if (seen.Add(full)) tracks.Add(track);
        }

        foreach (var track in _folderTracks)
        {
            var full = CombinePath(_currentFolder, track.Rel);
            if (seen.Add(full)) tracks.Add(track);
        }

        PostTracks(_currentFolder, tracks, _folderLyrics, null);
    }

    private static string CombinePath(string root, string relative)
    {
        try
        {
            return Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        }
        catch
        {
            return relative;
        }
    }

    private void PostTracks(string folder, List<LocalTrackDto> tracks, List<string>? lyrics, string? error)
    {
        var name = Path.GetFileName(folder.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        var payload = new LocalLibraryPayload
        {
            Folder = folder,
            Name = string.IsNullOrEmpty(name) ? folder : name,
            Tracks = tracks,
            Lyrics = lyrics,
            Error = error,
        };
        var message = new LocalLibraryMessage { Payload = payload };
        _post(JsonSerializer.Serialize(message, LocalLibraryJsonContext.Default.LocalLibraryMessage));
    }

    private void PostError(string? folder, string message)
    {
        HostLog.Warn($"[local] {message}");
        PostTracks(folder ?? string.Empty, new List<LocalTrackDto>(), null, message);
    }

    /// <summary>通知页面：用户取消了文件夹选择，可以解锁按钮了。</summary>
    private void PostCancel()
    {
        var message = new LocalLibraryMessage
        {
            Event = "localCancel",
            Payload = new LocalLibraryPayload(),
        };
        _post(JsonSerializer.Serialize(message, LocalLibraryJsonContext.Default.LocalLibraryMessage));
    }
}

/// <summary>读取音频文件内嵌封面：FLAC 的 PICTURE 元数据块、MP3 的 ID3v2 APIC 帧。</summary>
internal static class LocalCover
{
    /// <summary>只定位是否存在封面（不读图数据，扫描时用）。</summary>
    public static bool Has(string path)
    {
        return Locate(path) is not null;
    }

    public static (byte[] Bytes, string ContentType)? Read(string path)
    {
        var located = Locate(path);
        if (located is null)
        {
            return null;
        }

        try
        {
            using var stream = File.OpenRead(path);
            stream.Position = located.Value.Offset;
            var bytes = new byte[located.Value.Length];
            var read = 0;
            while (read < bytes.Length)
            {
                var got = stream.Read(bytes, read, bytes.Length - read);
                if (got <= 0)
                {
                    break;
                }

                read += got;
            }

            if (read < 32)
            {
                return null;
            }

            if (read < bytes.Length)
            {
                Array.Resize(ref bytes, read);
            }

            return (bytes, Sniff(bytes) ?? located.Value.ContentType);
        }
        catch
        {
            return null;
        }
    }

    private static (long Offset, int Length, string ContentType)? Locate(string path)
    {
        try
        {
            return Path.GetExtension(path).ToLowerInvariant() switch
            {
                ".flac" => LocateFlac(path),
                ".mp3" => LocateId3(path, 0),
                ".dsf" => LocateDsf(path),
                ".m4a" => LocateMp4(path),
                ".m4b" => LocateMp4(path),
                ".mp4" => LocateMp4(path),
                _ => null,
            };
        }
        catch
        {
            return null;
        }
    }

    private static (long Offset, int Length, string ContentType)? LocateFlac(string path)
    {
        using var stream = File.OpenRead(path);
        var magic = new byte[4];
        if (stream.Read(magic, 0, 4) != 4 || magic[0] != (byte)'f' || magic[1] != (byte)'L' || magic[2] != (byte)'a' || magic[3] != (byte)'C')
        {
            return null;
        }

        var header = new byte[4];
        while (stream.Read(header, 0, 4) == 4)
        {
            var last = (header[0] & 0x80) != 0;
            var type = header[0] & 0x7F;
            var length = (header[1] << 16) | (header[2] << 8) | header[3];
            if (type == 6 && length > 0)
            {
                var start = stream.Position;
                var probe = new byte[Math.Min(length, 256)];
                var got = stream.Read(probe, 0, probe.Length);
                if (got < 12)
                {
                    return null;
                }

                var mimeLength = ReadBe(probe, 4);
                var mimeStart = 8;
                var descriptorAt = mimeStart + mimeLength;
                if (mimeLength <= 1 || descriptorAt + 4 > got)
                {
                    return null;
                }

                var mime = System.Text.Encoding.ASCII.GetString(probe, mimeStart, mimeLength).Trim();
                var descriptorLength = ReadBe(probe, descriptorAt);
                var dataLengthAt = descriptorAt + 4 + descriptorLength + 16;
                if (dataLengthAt + 4 > got)
                {
                    return null;
                }

                var dataLength = ReadBe(probe, dataLengthAt);
                var dataStart = dataLengthAt + 4;
                if (dataLength <= 0 || dataStart + dataLength > length)
                {
                    return null;
                }

                return (start + dataStart, dataLength, string.IsNullOrWhiteSpace(mime) ? "image/jpeg" : mime);
            }

            stream.Seek(length, SeekOrigin.Current);
            if (last)
            {
                break;
            }
        }

        return null;
    }

    private static (long Offset, int Length, string ContentType)? LocateDsf(string path)
    {
        using var stream = File.OpenRead(path);
        var head = new byte[28];
        if (stream.Read(head, 0, head.Length) != head.Length)
        {
            return null;
        }

        if (head[0] != (byte)'D' || head[1] != (byte)'S' || head[2] != (byte)'D' || head[3] != (byte)' ')
        {
            return null;
        }

        var metadata = BitConverter.ToUInt64(head, 20);
        if (metadata <= 28 || metadata > (ulong)new FileInfo(path).Length)
        {
            return null;
        }

        return LocateId3(path, (long)metadata);
    }

    /// <summary>MP4 家族（m4a/m4b/mp4）：moov/udta/meta/ilst/covr/data。</summary>
    private static (long Offset, int Length, string ContentType)? LocateMp4(string path)
    {
        using var stream = File.OpenRead(path);
        var length = stream.Length;
        var moov = FindAtom(stream, 0, length, "moov");
        if (moov is null)
        {
            return null;
        }

        var udta = FindAtom(stream, moov.Value.Start + 8, moov.Value.Start + moov.Value.Size, "udta");
        if (udta is null)
        {
            return null;
        }

        var meta = FindAtom(stream, udta.Value.Start + 8, udta.Value.Start + udta.Value.Size, "meta");
        if (meta is null)
        {
            return null;
        }

        var ilst = FindAtom(stream, meta.Value.Start + 12, meta.Value.Start + meta.Value.Size, "ilst");
        if (ilst is null)
        {
            return null;
        }

        var covr = FindAtom(stream, ilst.Value.Start + 8, ilst.Value.Start + ilst.Value.Size, "covr");
        if (covr is null)
        {
            return null;
        }

        var child = covr.Value.Start + 8;
        var end = covr.Value.Start + covr.Value.Size;
        var head = new byte[8];
        while (child + 16 <= end)
        {
            stream.Position = child;
            if (stream.Read(head, 0, 8) != 8)
            {
                return null;
            }

            var size = ReadBe(head, 0);
            var atom = System.Text.Encoding.ASCII.GetString(head, 4, 4);
            if (size < 16 || child + size > end)
            {
                return null;
            }

            if (atom == "data")
            {
                var payloadStart = child + 16;
                var payloadLength = size - 16;
                if (payloadLength <= 32)
                {
                    return null;
                }

                var typeIndicator = ReadBeAt(stream, child + 8);
                var contentType = typeIndicator switch
                {
                    13 => "image/jpeg",
                    14 => "image/png",
                    0x1B => "image/bmp",
                    _ => "image/jpeg",
                };
                return (payloadStart, payloadLength, contentType);
            }

            child += size;
        }

        return null;
    }

    private static (long Start, int Size)? FindAtom(System.IO.Stream stream, long start, long end, string name)
    {
        var head = new byte[8];
        var position = start;
        while (position + 8 <= end)
        {
            stream.Position = position;
            if (stream.Read(head, 0, 8) != 8)
            {
                return null;
            }

            var size = (long)ReadBe(head, 0);
            var atom = System.Text.Encoding.ASCII.GetString(head, 4, 4);
            if (size == 1)
            {
                if (position + 16 > end)
                {
                    return null;
                }

                var big = new byte[8];
                stream.Position = position + 8;
                if (stream.Read(big, 0, 8) != 8)
                {
                    return null;
                }

                size = 0;
                foreach (var b in big)
                {
                    size = (size << 8) | b;
                }

                if (size < 16)
                {
                    return null;
                }
            }
            else if (size == 0)
            {
                size = end - position;
            }

            if (size < 8 || position + size > end)
            {
                return null;
            }

            if (string.Equals(atom, name, StringComparison.Ordinal))
            {
                return (position, (int)Math.Min(size, int.MaxValue));
            }

            position += size;
        }

        return null;
    }

    private static int ReadBeAt(System.IO.Stream stream, long position)
    {
        var buffer = new byte[4];
        stream.Position = position;
        if (stream.Read(buffer, 0, 4) != 4)
        {
            return 0;
        }

        return ReadBe(buffer, 0);
    }

    private static (long Offset, int Length, string ContentType)? LocateId3(string path, long offset)
    {
        using var stream = File.OpenRead(path);
        stream.Position = offset;
        var head = new byte[10];
        if (stream.Read(head, 0, 10) != 10 || head[0] != (byte)'I' || head[1] != (byte)'D' || head[2] != (byte)'3')
        {
            return null;
        }

        var major = head[3];
        var flags = head[5];
        var tagSize = SyncSafe(head, 6);
        if (tagSize <= 0)
        {
            return null;
        }

        long position = offset + 10;
        if ((flags & 0x40) != 0)
        {
            var ext = new byte[4];
            stream.Position = offset + 10;
            if (stream.Read(ext, 0, 4) != 4)
            {
                return null;
            }

            var extSize = major == 4 ? SyncSafe(ext, 0) : ReadBe(ext, 0);
            position += major == 4 ? extSize : extSize + 4;
        }

        var limit = offset + 10L + tagSize;
        var frameHead = new byte[10];
        while (position + 10 <= limit)
        {
            stream.Position = position;
            if (stream.Read(frameHead, 0, 10) != 10 || frameHead[0] == 0)
            {
                return null;
            }

            var id = System.Text.Encoding.ASCII.GetString(frameHead, 0, 4);
            var frameSize = major == 4 ? SyncSafe(frameHead, 4) : ReadBe(frameHead, 4);
            if (frameSize <= 0)
            {
                return null;
            }

            if (id == "APIC")
            {
                var probeLength = (int)Math.Min(1024, frameSize);
                var probe = new byte[probeLength];
                stream.Position = position + 10;
                var got = stream.Read(probe, 0, probeLength);
                var apic = ParseApic(probe, got, frameSize);
                if (apic is not null)
                {
                    return (position + 10 + apic.Value.Offset, apic.Value.Length, apic.Value.ContentType);
                }
            }

            position += 10 + frameSize;
        }

        return null;
    }

    private static (int Offset, int Length, string ContentType)? ParseApic(byte[] probe, int got, long frameSize)
    {
        if (got < 8)
        {
            return null;
        }

        var encoding = probe[0];
        var p = 1;
        var mimeEnd = Array.IndexOf(probe, (byte)0, p, got - p);
        if (mimeEnd <= 0)
        {
            return null;
        }

        var mime = System.Text.Encoding.ASCII.GetString(probe, p, mimeEnd - p);
        p = mimeEnd + 1;
        if (p >= got)
        {
            return null;
        }

        p += 1; // 图片类型
        if (encoding == 1 || encoding == 2)
        {
            while (p + 1 < got && !(probe[p] == 0 && probe[p + 1] == 0))
            {
                p += 2;
            }

            p += 2;
        }
        else
        {
            var descEnd = Array.IndexOf(probe, (byte)0, p, got - p);
            if (descEnd < 0)
            {
                return null;
            }

            p = descEnd + 1;
        }

        if (p >= got)
        {
            return null;
        }

        var length = (int)(frameSize - p);
        if (length <= 0)
        {
            return null;
        }

        return (p, length, string.IsNullOrWhiteSpace(mime) ? "image/jpeg" : mime);
    }

    private static int ReadBe(byte[] buffer, int offset)
    {
        return (buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
    }

    private static int SyncSafe(byte[] buffer, int offset)
    {
        return ((buffer[offset] & 0x7F) << 21)
            | ((buffer[offset + 1] & 0x7F) << 14)
            | ((buffer[offset + 2] & 0x7F) << 7)
            | (buffer[offset + 3] & 0x7F);
    }

    private static string? Sniff(byte[] data)
    {
        if (data.Length > 3 && data[0] == 0xFF && data[1] == 0xD8)
        {
            return "image/jpeg";
        }

        if (data.Length > 8 && data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47)
        {
            return "image/png";
        }

        if (data.Length > 3 && data[0] == (byte)'G' && data[1] == (byte)'I' && data[2] == (byte)'F')
        {
            return "image/gif";
        }

        if (data.Length > 12
            && data[0] == (byte)'R' && data[1] == (byte)'I' && data[2] == (byte)'F' && data[3] == (byte)'F'
            && data[8] == (byte)'W' && data[9] == (byte)'E' && data[10] == (byte)'B' && data[11] == (byte)'P')
        {
            return "image/webp";
        }

        return null;
    }
}

internal sealed class LocalTrackDto
{
    public string Rel { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public long Size { get; set; }

    /// <summary>音频文件里是否内嵌了封面图（FLAC PICTURE 块 / MP3 ID3 APIC 帧）。</summary>
    public bool HasCover { get; set; }

    /// <summary>CUE 曲名（没有就是文件名）。</summary>
    public string? Title { get; set; }

    /// <summary>CUE 歌手。</summary>
    public string? Artist { get; set; }

    /// <summary>CUE 分轨在镜像文件里的起始毫秒。</summary>
    public long StartMs { get; set; }

    /// <summary>CUE 分轨时长毫秒（0 表示播到文件结束）。</summary>
    public long DurationMs { get; set; }

    /// <summary>CUE 曲目号（0 表示整个文件）。</summary>
    public int Cue { get; set; }
}

internal sealed class LocalLibraryPayload
{
    public string Folder { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public List<LocalTrackDto> Tracks { get; set; } = new();

    public List<string>? Lyrics { get; set; }

    public string? Error { get; set; }
}

internal sealed class LocalLibraryMessage
{
    public int V { get; set; } = 1;

    public string Type { get; set; } = "host";

    public string Event { get; set; } = "localLibrary";

    public LocalLibraryPayload Payload { get; set; } = new();
}

internal sealed class LocalActionResult
{
    public string Action { get; set; } = string.Empty;

    public bool Ok { get; set; }

    public string Message { get; set; } = string.Empty;
}

internal sealed class LocalResultMessage
{
    public int V { get; set; } = 1;

    public string Type { get; set; } = "host";

    public string Event { get; set; } = "localResult";

    public LocalActionResult Payload { get; set; } = new();
}

[System.Text.Json.Serialization.JsonSourceGenerationOptions(
    PropertyNamingPolicy = System.Text.Json.Serialization.JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
[System.Text.Json.Serialization.JsonSerializable(typeof(LocalLibraryMessage))]
[System.Text.Json.Serialization.JsonSerializable(typeof(LocalResultMessage))]
internal sealed partial class LocalLibraryJsonContext : System.Text.Json.Serialization.JsonSerializerContext
{
}
