using System;
using System.Collections.Generic;
using System.IO;

namespace Zilux2.Local;

/// <summary>
/// DSF/ALAC 转码缓存的容量治理（D-20）：按最后写入时间淘汰，避免缓存无限增长。
/// 正在播放的 WAV 可能被占用，删除失败只跳过，下次再清理。
/// </summary>
internal static class TranscodeCache
{
    private const long DefaultMaxBytes = 512L * 1024 * 1024;

    /// <summary>ALAC 转码缓存目录（与 DSF 一样属于临时派生文件，启动/退出时整体清空）。</summary>
    public static string AlacDirectory => Path.Combine(CacheRoot, "alac-cache");

    /// <summary>DSF 转码缓存目录。</summary>
    public static string DsfDirectory => Path.Combine(CacheRoot, "dsf-cache");

    private static string CacheRoot { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Zilux2");

    /// <summary>
    /// 清空转码缓存。缓存只为当前会话里能连续拖动进度，源文件本身完好；
    /// 启动和退出各清一次，避免 C 盘长期残留整首歌大小的 WAV 副本。
    /// </summary>
    public static void ClearAll(string stage)
    {
        foreach (var directory in new[] { AlacDirectory, DsfDirectory })
        {
            Clear(directory, stage);
        }
    }

    private static void Clear(string directory, string stage)
    {
        try
        {
            if (!Directory.Exists(directory))
            {
                return;
            }

            var removed = 0;
            long bytes = 0;
            foreach (var path in Directory.EnumerateFiles(directory, "*.wav"))
            {
                try
                {
                    bytes += new FileInfo(path).Length;
                    File.Delete(path);
                    removed++;
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    // 正在播放的文件可能被占用，留给下次启动再清。
                }
            }

            // 转码中断留下的 .tmp 也一并清掉。
            foreach (var path in Directory.EnumerateFiles(directory, "*.tmp"))
            {
                try
                {
                    File.Delete(path);
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                }
            }

            HostLog.Info($"transcode.cache.cleared stage={stage} dir={directory} removed={removed} bytes={bytes}");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            HostLog.Warn($"transcode.cache.clear-failed stage={stage} dir={directory}: {exception.Message}");
        }
    }

    public static void Prune(string directory, long maxBytes = DefaultMaxBytes)
    {
        try
        {
            if (!Directory.Exists(directory))
            {
                return;
            }

            var files = new List<FileInfo>();
            long total = 0;
            foreach (var path in Directory.EnumerateFiles(directory, "*.wav"))
            {
                var info = new FileInfo(path);
                files.Add(info);
                total += info.Length;
            }

            if (total <= maxBytes)
            {
                return;
            }

            files.Sort((a, b) => a.LastWriteTimeUtc.CompareTo(b.LastWriteTimeUtc));
            foreach (var file in files)
            {
                if (total <= maxBytes)
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
                    // 正在播放的缓存文件删不掉，留给下次。
                }
            }

            HostLog.Info($"[transcode] cache pruned to {total / (1024 * 1024)} MB dir={directory}");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            HostLog.Warn($"[transcode] cache prune failed dir={directory}: {exception.Message}");
        }
    }
}
