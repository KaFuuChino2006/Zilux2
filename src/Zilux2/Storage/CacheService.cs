using System.IO;

namespace Zilux2.Storage;

/// <summary>一项缓存目录的统计。</summary>
internal sealed record CacheEntry(string Id, string Label, long Bytes, int Files, bool Clearable, string? Note);

/// <summary>清理结果。</summary>
internal sealed record CacheClearResult(IReadOnlyList<string> Cleared, long FreedBytes, int Failed, bool NeedsRestart);

/// <summary>
/// 应用磁盘缓存的统一统计 / 清理 / 预算收缩。
///
/// 统计的目录都位于 <see cref="HostFolders.Root"/> 下，全部是可重建数据：
/// stems（人声分离窗口）、analysis（曲目分析）、transcode（DSF/ALAC 临时 WAV）、
/// mvmp3（MV 缓存）、logs（日志）、updates（已下载安装包）、WebView2（浏览器缓存）。
/// 模型文件（models）与账号、设置、最近播放不在缓存范围内。
/// </summary>
internal static class CacheService
{
    private const long MinPruneBytes = 1024;

    private static readonly (string Id, string Label, string[] Dirs, bool Clearable, string? Note)[] Categories =
    {
        ("stems", "人声分离", new[] { "stems" }, true, null),
        ("analysis", "曲目分析", new[] { "analysis" }, true, null),
        ("transcode", "转码临时文件", new[] { "alac-cache", "dsf-cache" }, true, null),
        ("mvmp3", "MV 缓存", new[] { "mvmp3-cache" }, true, null),
        ("logs", "运行日志", new[] { "logs" }, true, "只保留最近一次启动后的日志"),
        ("updates", "更新安装包", new[] { "updates" }, true, null),
        ("webview2", "浏览器缓存", new[] { "WebView2" }, false, "正在运行，重启后自动清理"),
    };

    public static string Root => HostFolders.Root;

    public static IReadOnlyList<CacheEntry> Measure()
    {
        var entries = new List<CacheEntry>(Categories.Length);
        foreach (var category in Categories)
        {
            var (bytes, files) = MeasureDirectories(category.Dirs);
            entries.Add(new CacheEntry(category.Id, category.Label, bytes, files, category.Clearable, category.Note));
        }

        return entries;
    }

    public static long TotalBytes()
    {
        long total = 0;
        foreach (var category in Categories)
        {
            total += MeasureDirectories(category.Dirs).Bytes;
        }

        return total;
    }

    /// <summary>清理一个分类；id 为空或 all 时清理全部可清理分类。</summary>
    public static CacheClearResult Clear(string? id)
    {
        var all = string.IsNullOrWhiteSpace(id) || string.Equals(id, "all", StringComparison.OrdinalIgnoreCase);
        var cleared = new List<string>();
        long freed = 0;
        var failed = 0;
        var needsRestart = false;

        foreach (var category in Categories)
        {
            if (!all && !string.Equals(category.Id, id, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (!category.Clearable)
            {
                // WebView2 的 Cache 目录在运行期锁定；写标记，下次启动前删。
                if (TryWriteWebView2Marker())
                {
                    needsRestart = true;
                    cleared.Add(category.Id);
                }

                continue;
            }

            var (bytes, failures) = ClearDirectories(category.Dirs);
            freed += bytes;
            failed += failures;
            cleared.Add(category.Id);
        }

        HostLog.Info($"cache.clear id={id ?? "all"} freed={freed} failed={failed} restart={needsRestart}");
        return new CacheClearResult(cleared, freed, failed, needsRestart);
    }

    /// <summary>
    /// 超过预算时按最后写入时间从旧到新删，直到总量回到预算内。
    /// 只动 stems / analysis / transcode / mvmp3，日志、安装包与 WebView2 不参与自动淘汰。
    /// </summary>
    public static (int Removed, long FreedBytes, long TotalBytes) PruneToLimit()
    {
        var limit = CachePolicy.LimitBytes;
        var candidates = new List<FileInfo>();
        long total = 0;
        foreach (var category in Categories)
        {
            if (category.Id is "logs" or "updates" or "webview2")
            {
                continue;
            }

            foreach (var directory in category.Dirs)
            {
                var path = Path.Combine(Root, directory);
                if (!Directory.Exists(path))
                {
                    continue;
                }

                try
                {
                    foreach (var file in new DirectoryInfo(path).EnumerateFiles("*", SearchOption.AllDirectories))
                    {
                        candidates.Add(file);
                        total += file.Length;
                    }
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    HostLog.Warn($"cache.prune-scan-failed dir={path}: {exception.Message}");
                }
            }
        }

        var removed = 0;
        long freed = 0;
        if (total > limit)
        {
            foreach (var file in candidates.OrderBy(file => file.LastWriteTimeUtc))
            {
                if (total <= limit)
                {
                    break;
                }

                try
                {
                    var length = file.Length;
                    file.Delete();
                    total -= length;
                    freed += length;
                    removed++;
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    // 正在播放/分析的窗口文件跳过，下次再收。
                }
            }
        }

        RemoveEmptyDirectories();
        if (removed > 0)
        {
            HostLog.Info($"cache.prune removed={removed} freed={freed} total={total} limit={limit}");
        }

        return (removed, freed, total);
    }

    /// <summary>启动时清理上次标记的 WebView2 缓存；必须在 WebView2 环境创建前调用。</summary>
    public static void ClearPendingWebView2()
    {
        var marker = WebView2MarkerPath;
        if (!File.Exists(marker))
        {
            return;
        }

        var root = Path.Combine(Root, "WebView2");
        long freed = 0;
        foreach (var name in new[] { "Cache", "Code Cache", "GPUCache", "DawnCache", "ShaderCache", "Service Worker" })
        {
            var path = Path.Combine(root, name);
            if (!Directory.Exists(path))
            {
                continue;
            }

            try
            {
                foreach (var file in new DirectoryInfo(path).EnumerateFiles("*", SearchOption.AllDirectories))
                {
                    freed += file.Length;
                }

                Directory.Delete(path, true);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                HostLog.Warn($"cache.webview2.clear-failed dir={name}: {exception.Message}");
            }
        }

        try
        {
            File.Delete(marker);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
        }

        HostLog.Info($"cache.webview2.cleared freed={freed}");
    }

    private static string WebView2MarkerPath => Path.Combine(Root, "webview2-cache-clear.flag");

    private static bool TryWriteWebView2Marker()
    {
        try
        {
            Directory.CreateDirectory(Root);
            File.WriteAllText(WebView2MarkerPath, DateTime.UtcNow.ToString("O"));
            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            HostLog.Warn($"cache.webview2.marker-failed: {exception.Message}");
            return false;
        }
    }

    private static (long Bytes, int Files) MeasureDirectories(string[] names)
    {
        long bytes = 0;
        var files = 0;
        foreach (var name in names)
        {
            var path = Path.Combine(Root, name);
            if (!Directory.Exists(path))
            {
                continue;
            }

            try
            {
                foreach (var file in new DirectoryInfo(path).EnumerateFiles("*", SearchOption.AllDirectories))
                {
                    bytes += file.Length;
                    files++;
                }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                HostLog.Warn($"cache.measure-failed dir={name}: {exception.Message}");
            }
        }

        return (bytes, files);
    }

    private static (long Bytes, int Failed) ClearDirectories(string[] names)
    {
        long bytes = 0;
        var failed = 0;
        foreach (var name in names)
        {
            var path = Path.Combine(Root, name);
            if (!Directory.Exists(path))
            {
                continue;
            }

            try
            {
                foreach (var file in new DirectoryInfo(path).EnumerateFiles("*", SearchOption.AllDirectories))
                {
                    try
                    {
                        var length = file.Length;
                        file.Delete();
                        bytes += length;
                    }
                    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                    {
                        failed++;
                    }
                }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                HostLog.Warn($"cache.clear-failed dir={name}: {exception.Message}");
                failed++;
            }
        }

        if (bytes > MinPruneBytes)
        {
            RemoveEmptyDirectories();
        }

        return (bytes, failed);
    }

    private static void RemoveEmptyDirectories()
    {
        foreach (var category in Categories)
        {
            if (!category.Clearable)
            {
                continue;
            }

            foreach (var name in category.Dirs)
            {
                var path = Path.Combine(Root, name);
                if (!Directory.Exists(path))
                {
                    continue;
                }

                try
                {
                    foreach (var directory in new DirectoryInfo(path)
                                 .EnumerateDirectories("*", SearchOption.AllDirectories)
                                 .OrderByDescending(item => item.FullName.Length))
                    {
                        if (!directory.EnumerateFileSystemInfos().Any())
                        {
                            directory.Delete();
                        }
                    }
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                }
            }
        }
    }
}
