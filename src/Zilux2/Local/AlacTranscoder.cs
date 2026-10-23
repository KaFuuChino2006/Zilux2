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
    private const string CacheFolderName = "alac-cache";

    /// <summary>判断 m4a 是否 ALAC：moov 里出现 alac 解码器且没有 AAC 的 mp4a。</summary>
    public static bool IsAlac(string path)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var probe = new byte[Math.Min(stream.Length, 4 * 1024 * 1024)];
            var read = 0;
            while (read < probe.Length)
            {
                var chunk = stream.Read(probe, read, probe.Length - read);
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

            var hasAlac = IndexOf(probe, read, "alac"u8) >= 0;
            var hasAac = IndexOf(probe, read, "mp4a"u8) >= 0;
            return hasAlac && !hasAac;
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
        try
        {
            var info = new FileInfo(sourcePath);
            if (!info.Exists)
            {
                error = "文件不存在";
                return false;
            }

            var cacheDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Zilux2",
                CacheFolderName);
            Directory.CreateDirectory(cacheDir);
            var stamp = $"{info.FullName}|{info.Length}|{info.LastWriteTimeUtc.Ticks}";
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(stamp))).ToLowerInvariant();
            wavPath = Path.Combine(cacheDir, hash.Substring(0, 24) + ".wav");
            if (File.Exists(wavPath) && new FileInfo(wavPath).Length > 44)
            {
                return true;
            }

            var temp = wavPath + ".tmp";
            var stopwatch = Stopwatch.StartNew();
            using (var reader = new MediaFoundationReader(sourcePath))
            {
                WaveFileWriter.CreateWaveFile(temp, reader);
                stopwatch.Stop();
                HostLog.Info($"[alac] converted {Path.GetFileName(sourcePath)} -> {Path.GetFileName(wavPath)} "
                    + $"({reader.WaveFormat.SampleRate}Hz/{reader.WaveFormat.Channels}ch, "
                    + $"{new FileInfo(temp).Length} bytes, {stopwatch.ElapsedMilliseconds}ms)");
            }

            if (File.Exists(wavPath))
            {
                File.Delete(wavPath);
            }

            File.Move(temp, wavPath);
            return true;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[alac] convert failed {sourcePath}: {exception.GetType().Name}: {exception.Message}");
            error = exception.Message;
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
}
