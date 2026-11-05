using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Zilux2.Online;

/// <summary>
/// 「无名音乐」播放过的歌自动落在本地：第一次播放时边播边存，
/// 之后（包括断网、站点挂掉）直接从缓存文件播放，不再走外站。
/// </summary>
internal static class Mvmp3Cache
{
    private const long MinValidBytes = 64 * 1024;
    private const long MaxCacheBytes = 200L * 1024 * 1024;
    private const long MaxTotalCacheBytes = 1024L * 1024 * 1024;
    private static readonly SemaphoreSlim PrefetchSlots = new(2, 2);

    private static readonly object Gate = new();
    private static readonly HashSet<string> Storing = new(StringComparer.OrdinalIgnoreCase);

    private static readonly HttpClient DownloadClient = CreateDownloadClient();

    private static HttpClient CreateDownloadClient()
    {
        var handler = new HttpClientHandler { AutomaticDecompression = DecompressionMethods.All };
        var client = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(5) };
        client.DefaultRequestHeaders.TryAddWithoutValidation(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36");
        return client;
    }

    /// <summary>缓存根目录：固定在本机数据目录，避免清缓存时误删下载目录里的用户曲目（D-15）。</summary>
    public static Func<string>? DirectoryProvider { get; set; }

    public static string Dir => Path.Combine(HostFolders.Root, "mvmp3-cache");

    public static string PathFor(string id) => Path.Combine(Dir, id + ".mp3");

    private static string MetaPathFor(string id) => Path.Combine(Dir, id + ".json");

    /// <summary>把歌名/歌手记在缓存文件旁边，本地曲库按它显示友好名称。</summary>
    public static void WriteMeta(string id, string? title, string? artist)
    {
        if (string.IsNullOrWhiteSpace(title) && string.IsNullOrWhiteSpace(artist))
        {
            return;
        }

        try
        {
            Directory.CreateDirectory(Dir);
            var json = JsonSerializer.Serialize(new { title = title ?? string.Empty, artist = artist ?? string.Empty });
            File.WriteAllText(MetaPathFor(id), json);
        }
        catch
        {
            // 元信息只影响显示名称，写失败不影响播放。
        }
    }

    /// <summary>按缓存/下载文件路径读取元信息（没有则返回空）。</summary>
    public static (string? Title, string? Artist) ReadMetaForFile(string filePath)
    {
        try
        {
            var metaPath = Path.ChangeExtension(filePath, ".json");
            if (!File.Exists(metaPath))
            {
                return (null, null);
            }

            using var document = JsonDocument.Parse(File.ReadAllText(metaPath));
            var root = document.RootElement;
            var title = root.TryGetProperty("title", out var titleElement) ? titleElement.GetString() : null;
            var artist = root.TryGetProperty("artist", out var artistElement) ? artistElement.GetString() : null;
            return (string.IsNullOrWhiteSpace(title) ? null : title, string.IsNullOrWhiteSpace(artist) ? null : artist);
        }
        catch
        {
            return (null, null);
        }
    }

    /// <summary>把旧版本留在本机数据目录里的缓存搬到当前下载目录。</summary>
    public static void MigrateLegacy()
    {
        try
        {
            var legacy = Path.Combine(HostFolders.Root, "mvmp3-cache");
            var target = Dir;
            if (string.Equals(legacy, target, StringComparison.OrdinalIgnoreCase) || !Directory.Exists(legacy))
            {
                return;
            }

            Directory.CreateDirectory(target);
            foreach (var file in Directory.EnumerateFiles(legacy))
            {
                var destination = Path.Combine(target, Path.GetFileName(file));
                if (!File.Exists(destination))
                {
                    File.Move(file, destination);
                }
            }

            try
            {
                Directory.Delete(legacy, true);
            }
            catch
            {
                // 残留目录删不掉就算了。
            }

            HostLog.Info($"[mvmp3] migrated legacy cache to {target}");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[mvmp3] migrate legacy cache failed: {exception.Message}");
        }
    }

    private static string PartPathFor(string id) => Path.Combine(Dir, id + ".part");

    /// <summary>缓存文件存在且大小合理时返回 true（页面播放优先读它）。</summary>
    public static bool TryGet(string id, out string path)
    {
        path = PathFor(id);
        try
        {
            return File.Exists(path) && new FileInfo(path).Length >= MinValidBytes;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 播过的歌自动整首下载到本地（与播放解耦、可断点续传）。
    /// 播放本身仍走代理流，不受影响；下完以后再一次播放就直接读本地文件。
    /// </summary>
    public static void Prefetch(string id, string url, IReadOnlyDictionary<string, string> headers)
    {
        if (!BeginStore(id))
        {
            return;
        }

        _ = Task.Run(() => DownloadAsync(id, url, headers));
    }

    private static async Task DownloadAsync(string id, string url, IReadOnlyDictionary<string, string> headers)
    {
        await PrefetchSlots.WaitAsync().ConfigureAwait(false);
        var part = PartPathFor(id);
        var completed = false;
        // D-45：预取与播放解耦，但必须有上限；否则切歌后仍会整首下载，且无超时。
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(3));
        var token = timeout.Token;
        try
        {
            Directory.CreateDirectory(Dir);
            var existing = File.Exists(part) ? new FileInfo(part).Length : 0;
            if (existing > MaxCacheBytes)
            {
                File.Delete(part);
                existing = 0;
            }

            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            foreach (var header in headers)
            {
                request.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }

            if (existing > 0)
            {
                request.Headers.TryAddWithoutValidation("Range", $"bytes={existing}-");
            }

            using var response = await DownloadClient
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token)
                .ConfigureAwait(false);
            if (response.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.PartialContent))
            {
                HostLog.Warn($"[mvmp3] prefetch status={(int)response.StatusCode} {id}");
                return;
            }

            long total = response.Content.Headers.ContentLength ?? 0;
            if (response.Content.Headers.ContentRange?.Length is { } rangeTotal)
            {
                total = rangeTotal;
            }

            if (total <= 0 || total > MaxCacheBytes)
            {
                HostLog.Warn($"[mvmp3] prefetch skip size={total} {id}");
                return;
            }

            var append = response.StatusCode == HttpStatusCode.PartialContent && existing > 0;
            if (!append)
            {
                existing = 0;
            }

            await using (var file = new FileStream(part, append ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.Read, 81920, true))
            {
                await using var body = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
                var buffer = new byte[81920];
                while (true)
                {
                    var read = await body.ReadAsync(buffer, token).ConfigureAwait(false);
                    if (read <= 0)
                    {
                        break;
                    }

                    await file.WriteAsync(buffer.AsMemory(0, read), token).ConfigureAwait(false);
                    existing += read;
                    if (existing > MaxCacheBytes)
                    {
                        throw new IOException("cache size over limit");
                    }
                }
            }

            completed = existing >= total;
            if (completed)
            {
                HostLog.Info($"[mvmp3] prefetched {id} {existing}B");
            }
            else
            {
                HostLog.Warn($"[mvmp3] prefetch incomplete {id} {existing}/{total}B");
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[mvmp3] prefetch failed {id}: {exception.GetType().Name}");
        }
        finally
        {
            PrefetchSlots.Release();
            FinishStore(id, completed);
        }
    }

    /// <summary>同一首歌只允许一个下载任务，避免连点/切歌时互相覆盖。</summary>
    public static bool BeginStore(string id)
    {
        lock (Gate)
        {
            return Storing.Add(id);
        }
    }

    /// <summary>打开临时文件开始接收字节；失败返回 null。</summary>
    public static FileStream? OpenPart(string id)    {
        try
        {
            Directory.CreateDirectory(Dir);
            return new FileStream(PartPathFor(id), FileMode.Create, FileAccess.Write, FileShare.Read, 81920, true);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[mvmp3] cache open failed {id}: {exception.GetType().Name}");
            return null;
        }
    }

    /// <summary>下载完整（或被中断）后的收尾：够大就转正，否则丢掉。</summary>
    public static void FinishStore(string id, bool completed)
    {
        var part = PartPathFor(id);
        try
        {
            if (completed && File.Exists(part))
            {
                var length = new FileInfo(part).Length;
                if (length >= MinValidBytes)
                {
                    File.Move(part, PathFor(id), overwrite: true);
                    HostLog.Info($"[mvmp3] cached {id} {length}B");
                    TrimCache();
                }
                else
                {
                    File.Delete(part);
                }
            }
            else if (File.Exists(part))
            {
                // 未下完不删：保留 .part 供下次续传（清空缓存会一并删除）。
                HostLog.Info($"[mvmp3] keep partial {id} {new FileInfo(part).Length}B");
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[mvmp3] cache finish failed {id}: {exception.GetType().Name}");
            try
            {
                File.Delete(part);
            }
            catch
            {
                // ignore
            }
        }
        finally
        {
            lock (Gate)
            {
                Storing.Remove(id);
            }
        }
    }

    /// <summary>D-15：缓存总量超过 1GB 时按最后访问时间淘汰最旧的文件。</summary>
    private static void TrimCache()
    {
        try
        {
            if (!Directory.Exists(Dir))
            {
                return;
            }

            var files = new List<FileInfo>();
            long total = 0;
            foreach (var path in Directory.EnumerateFiles(Dir, "*.mp3"))
            {
                var info = new FileInfo(path);
                files.Add(info);
                total += info.Length;
            }

            if (total <= MaxTotalCacheBytes)
            {
                return;
            }

            files.Sort((a, b) => a.LastWriteTimeUtc.CompareTo(b.LastWriteTimeUtc));
            foreach (var file in files)
            {
                if (total <= MaxTotalCacheBytes)
                {
                    break;
                }

                try
                {
                    total -= file.Length;
                    file.Delete();
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    // 正在播放时删不掉，留给下次。
                }
            }

            HostLog.Info($"[mvmp3] cache trimmed to {total / (1024 * 1024)} MB");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            HostLog.Warn($"[mvmp3] cache trim failed: {exception.Message}");
        }
    }

    public static (int Count, long Bytes) Stat()
    {
        var count = 0;
        long bytes = 0;
        try
        {
            if (!Directory.Exists(Dir))
            {
                return (0, 0);
            }

            foreach (var file in Directory.EnumerateFiles(Dir, "*.mp3"))
            {
                count += 1;
                bytes += new FileInfo(file).Length;
            }
        }
        catch
        {
            // 统计失败就按 0 处理，不影响播放。
        }

        return (count, bytes);
    }

    public static void Clear()
    {
        var trash = string.Empty;
        try
        {
            if (!Directory.Exists(Dir))
            {
                return;
            }

            // D-15：清缓存不再直接删除，先移到可恢复的回收目录；失败的文件退化为删除。
            trash = Path.Combine(
                HostFolders.Root,
                "mvmp3-cache-trash",
                DateTime.Now.ToString("yyyyMMdd-HHmmss"));
            Directory.CreateDirectory(trash);
            foreach (var file in Directory.EnumerateFiles(Dir))
            {
                var name = Path.GetFileName(file);
                try
                {
                    File.Move(file, Path.Combine(trash, name), overwrite: true);
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    try
                    {
                        File.Delete(file);
                    }
                    catch (Exception deleteError) when (deleteError is IOException or UnauthorizedAccessException)
                    {
                        HostLog.Warn($"[mvmp3] cache delete failed {name}: {deleteError.Message}");
                    }
                }
            }

            HostLog.Info($"[mvmp3] cache cleared (trash={trash})");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[mvmp3] cache clear failed: {exception.GetType().Name}");
        }
    }
}
