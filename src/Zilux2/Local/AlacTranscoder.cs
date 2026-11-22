using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using NAudio.Wave;

namespace Zilux2.Local;

/// <summary>
/// .m4a（ALAC 无损）→ WAV 缓存转码：WebView2 的音频解码器不认 ALAC（会报 MEDIA_ERR_SRC_NOT_SUPPORTED），
/// 但系统 Media Foundation 能解，所以宿主先转成 16-bit PCM WAV 再给页面。
/// 普通 AAC 的 .m4a 不需要转码，直接原样服务即可。
/// </summary>
internal static class AlacTranscoder
{
    /// <summary>
    /// 判断 m4a 是否 ALAC：moov 里出现 `alac` 解码器且没有 AAC 的 `mp4a`。
    ///
    /// 必须同时看头尾：`moov` 按规范可以在文件末尾（非 faststart 的 m4a 很常见，
    /// 尤其是 iTunes 之外的工具导出）。只读前 4 MB 会把它判成「不是 ALAC」，
    /// 于是原样以 `audio/mp4` 服务，而 Chromium 没有 ALAC 解码器 → 整首静音且无提示。
    /// </summary>
    public static bool IsAlac(string path)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            const int ProbeBytes = 4 * 1024 * 1024;
            var headLength = (int)Math.Min(stream.Length, ProbeBytes);
            var head = new byte[headLength];
            var read = 0;
            while (read < head.Length)
            {
                var chunk = stream.Read(head, read, head.Length - read);
                if (chunk <= 0)
                {
                    break;
                }

                read += chunk;
            }

            if (read <= 0)
            {
                return false;
            }

            var hasAlac = IndexOf(head, read, "alac"u8) >= 0;
            var hasAac = IndexOf(head, read, "mp4a"u8) >= 0;
            if (hasAlac || hasAac || stream.Length <= headLength)
            {
                return hasAlac && !hasAac;
            }

            // 头部没有结论：看尾部（`moov` 常被放在末尾）。
            var tailLength = (int)Math.Min(stream.Length, ProbeBytes);
            var tail = new byte[tailLength];
            stream.Position = stream.Length - tailLength;
            var tailRead = 0;
            while (tailRead < tail.Length)
            {
                var chunk = stream.Read(tail, tailRead, tail.Length - tailRead);
                if (chunk <= 0)
                {
                    break;
                }

                tailRead += chunk;
            }

            if (tailRead <= 0)
            {
                return hasAlac && !hasAac;
            }

            var tailAlac = IndexOf(tail, tailRead, "alac"u8) >= 0;
            var tailAac = IndexOf(tail, tailRead, "mp4a"u8) >= 0;
            return tailAlac && !tailAac;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[alac] probe failed {path}: {exception.Message}");
            return false;
        }
    }

    /// <summary>确保 m4a 已转成 wav；成功时返回缓存路径。</summary>
    public static bool TryEnsureWav(string sourcePath, out string wavPath, out string error)
    {
        wavPath = string.Empty;
        error = string.Empty;
        string? temp = null;
        try
        {
            var info = new FileInfo(sourcePath);
            if (!info.Exists)
            {
                error = "文件不存在";
                return false;
            }

            var cacheDir = TranscodeCache.AlacDirectory;
            Directory.CreateDirectory(cacheDir);
            var stamp = $"{info.FullName}|{info.Length}|{info.LastWriteTimeUtc.Ticks}";
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(stamp))).ToLowerInvariant();
            wavPath = Path.Combine(cacheDir, hash.Substring(0, 24) + ".wav");
            if (File.Exists(wavPath) && new FileInfo(wavPath).Length > 44)
            {
                return true;
            }

            // 临时文件名带 GUID：同一首歌被两个请求同时转码时，固定 ".tmp" 会互相覆盖，
            // 而 File.Move 之后缓存里留下的是「长度 > 44 但内容残缺」的 WAV —— 播放器读到的是噪音。
            temp = wavPath + "." + Guid.NewGuid().ToString("N")[..8] + ".tmp";
            var stopwatch = Stopwatch.StartNew();
            using (var reader = new MediaFoundationReader(sourcePath))
            {
                WaveFileWriter.CreateWaveFile(temp, reader);
                stopwatch.Stop();
                HostLog.Info($"[alac] converted {Path.GetFileName(sourcePath)} -> {Path.GetFileName(wavPath)} "
                    + $"({reader.WaveFormat.SampleRate}Hz/{reader.WaveFormat.Channels}ch, "
                    + $"{new FileInfo(temp).Length} bytes, {stopwatch.ElapsedMilliseconds}ms)");
            }

            // 另一路并发转码可能已经写好了成品：谁先落地算谁的，后来者直接丢弃自己的临时文件。
            if (File.Exists(wavPath) && new FileInfo(wavPath).Length > 44)
            {
                TryDelete(temp);
                temp = null;
                return true;
            }

            File.Move(temp, wavPath, overwrite: true);
            temp = null;
            TranscodeCache.Prune(cacheDir);
            return true;
        }
        catch (Exception exception)
        {
            // 转码中途失败会在缓存目录留下几十 MB 的临时 WAV：must 自己清，否则只会越攒越多。
            if (temp is not null)
            {
                TryDelete(temp);
            }

            HostLog.Warn($"[alac] convert failed {sourcePath}: {exception.GetType().Name}: {exception.Message}");
            error = exception.Message;
            wavPath = string.Empty;
            return false;
        }
    }

    private static int IndexOf(byte[] haystack, int length, ReadOnlySpan<byte> needle)
    {
        for (var i = 0; i + needle.Length <= length; i += 1)
        {
            if (haystack.AsSpan(i, needle.Length).SequenceEqual(needle))
            {
                return i;
            }
        }

        return -1;
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            HostLog.Warn($"[alac] temp cleanup failed {Path.GetFileName(path)}: {exception.Message}");
        }
    }
}
