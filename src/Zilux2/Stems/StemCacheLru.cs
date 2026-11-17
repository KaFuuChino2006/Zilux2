using System.Globalization;
using System.IO;
using System.Text.Json;

namespace Zilux2.Stems;

/// <summary>
/// stems 缓存的整曲目录级 LRU（WBS v2 T2-5）。
/// 预算来源优先级：测试注入 → cache-policy.json 的 maxStemCacheMb（默认 2048，0 = 不淘汰）
/// → 环境变量 ZILUX2_STEMS_CACHE_MB → 设置页的 CachePolicy.LimitMb。
/// 淘汰粒度是「整首曲目的目录」：一个窗口的 wNNN.*.wav 一起走，避免留下半套 4 轨文件。
/// </summary>
internal static class StemCacheLru
{
    /// <summary>默认上限 2 GB（4 轨一个 30 s 窗口约 26 MB，够缓存 ~76 个窗口）。</summary>
    internal const int DefaultMaxMb = 2048;

    /// <summary>0 表示不淘汰；只允许显式配置成 0，缺省仍是 2048。</summary>
    internal const int UnlimitedMb = 0;

    private static readonly object Gate = new();

    /// <summary>正在计算的整曲目录 → 引用计数；被钉住的目录不会被淘汰。</summary>
    private static readonly Dictionary<string, int> Pins = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>测试注入：非 null 时不再读磁盘与环境变量。</summary>
    internal static int? MaxMbOverride { get; set; }

    /// <summary>解析当前预算（MB）。0 = 不淘汰。</summary>
    internal static int ResolveMaxMb()
    {
        if (MaxMbOverride is { } injected)
        {
            return injected;
        }

        if (ReadPolicyMaxMb() is { } configured)
        {
            return configured;
        }

        // 旧的环境变量覆盖保留，但现在允许 0（0 = 不淘汰）。
        var text = Environment.GetEnvironmentVariable("ZILUX2_STEMS_CACHE_MB");
        if (int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var megabytes) &&
            megabytes >= 0)
        {
            return megabytes;
        }

        // 最后回落到设置页的缓存预算；CachePolicy 的下限是 128 MB，不会误给出 0。
        return Math.Max(1, Zilux2.Storage.CachePolicy.LimitMb);
    }

    /// <summary>预算换算成字节；0（不淘汰）返回 <see cref="long.MaxValue"/>。</summary>
    internal static long ResolveLimitBytes()
    {
        var megabytes = ResolveMaxMb();
        return megabytes <= UnlimitedMb ? long.MaxValue : megabytes * 1024L * 1024L;
    }

    internal static bool IsPinned(string trackDirectory)
    {
        var key = Normalize(trackDirectory);
        lock (Gate)
        {
            return Pins.ContainsKey(key);
        }
    }

    /// <summary>
    /// 钉住一个整曲目录，返回的租约 Dispose 时解除。计算期间调用，
    /// 让 <see cref="Prune"/> 跳过正在写的窗口。
    /// </summary>
    internal static IDisposable Pin(string trackDirectory)
    {
        var key = Normalize(trackDirectory);
        lock (Gate)
        {
            Pins.TryGetValue(key, out var count);
            Pins[key] = count + 1;
        }

        return new PinLease(key);
    }

    /// <summary>命中缓存时刷新目录时间戳，作为 LRU 的「最近访问」。</summary>
    internal static void Touch(string trackDirectory)
    {
        try
        {
            if (Directory.Exists(trackDirectory))
            {
                Directory.SetLastWriteTimeUtc(trackDirectory, DateTime.UtcNow);
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // 只影响淘汰顺序，不影响正确性。
        }
    }

    /// <summary>整曲目录占用：只统计目录顶层文件（wav + meta.json）。</summary>
    internal static long DirectoryBytes(string trackDirectory)
    {
        var total = 0L;
        try
        {
            foreach (var path in Directory.EnumerateFiles(trackDirectory, "*", SearchOption.TopDirectoryOnly))
            {
                var info = new FileInfo(path);
                if (info.Exists)
                {
                    total += info.Length;
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // 目录刚好被删/被占用：按 0 计，下一轮再算。
        }

        return total;
    }

    /// <summary>
    /// 按「最久未访问的整曲目录」淘汰，直到总量 ≤ <paramref name="limitBytes"/>。
    /// <paramref name="isPinned"/> 为真或命中 <see cref="Pin"/> 的目录跳过。
    /// 返回（删除的目录数，剩余字节）。
    /// </summary>
    internal static (int Removed, long Remaining) Prune(
        string cacheRoot,
        long limitBytes,
        Func<string, bool>? isPinned = null)
    {
        if (string.IsNullOrEmpty(cacheRoot) || !Directory.Exists(cacheRoot))
        {
            return (0, 0);
        }

        var entries = new List<(string Directory, long Bytes, DateTime LastAccessUtc)>();
        var total = 0L;
        foreach (var directory in Directory.EnumerateDirectories(cacheRoot))
        {
            var bytes = DirectoryBytes(directory);
            entries.Add((directory, bytes, LastWriteUtc(directory)));
            total += bytes;
        }

        if (total <= limitBytes)
        {
            return (0, total);
        }

        // 不传谓词时默认按 Pin 保护：漏传不会把正在计算的窗口删掉。
        isPinned ??= IsPinned;
        entries.Sort(static (left, right) => left.LastAccessUtc.CompareTo(right.LastAccessUtc));
        var removed = 0;
        foreach (var entry in entries)
        {
            if (total <= limitBytes)
            {
                break;
            }

            if (isPinned(entry.Directory))
            {
                continue;
            }

            try
            {
                Directory.Delete(entry.Directory, recursive: true);
                total -= entry.Bytes;
                removed++;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                // 目录里有正在读取的文件：跳过，下次再淘汰。
            }
        }

        return (removed, total);
    }

    private static DateTime LastWriteUtc(string directory)
    {
        try
        {
            return Directory.GetLastWriteTimeUtc(directory);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return DateTime.MinValue;
        }
    }

    /// <summary>
    /// cache-policy.json 里的 maxStemCacheMb；缺键返回 null（继续走环境变量 / 整体预算回落）。
    /// 归一化（0 合法、越界回落 2048）统一由 CachePolicy 负责，避免两处判定不一致。
    /// </summary>
    private static int? ReadPolicyMaxMb()
    {
        try
        {
            return Zilux2.Storage.CachePolicy.TryGetMaxStemCacheMb(out var megabytes) ? megabytes : null;
        }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException)
        {
            HostLog.Warn($"stems.cache-policy-read-failed: {exception.Message}");
            return null;
        }
    }

    private static string Normalize(string trackDirectory)
    {
        try
        {
            return Path.GetFullPath(trackDirectory).TrimEnd(Path.DirectorySeparatorChar);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return trackDirectory;
        }
    }

    private sealed class PinLease(string key) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
            {
                return;
            }

            lock (Gate)
            {
                if (!Pins.TryGetValue(key, out var count))
                {
                    return;
                }

                if (count <= 1)
                {
                    Pins.Remove(key);
                }
                else
                {
                    Pins[key] = count - 1;
                }
            }
        }
    }
}
