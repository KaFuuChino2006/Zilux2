using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace Zilux2.Local;

/// <summary>
/// CUE 单文件专辑解析：一个 .cue 描述一整张镜像文件（flac / wav / dsf / ape …）里的多首曲目，
/// 每首曲目只有起始时间，播放时页面把它当作「同一个音频文件 + startAt 秒偏移」。
/// </summary>
internal static class LocalCue
{
    internal sealed class CueTrack
    {
        public string FileRel { get; set; } = string.Empty;

        public int Number { get; set; }

        public string Title { get; set; } = string.Empty;

        public string Performer { get; set; } = string.Empty;

        public double StartSeconds { get; set; }
    }

    /// <summary>解析一个 cue 文件；镜像文件不存在时返回空列表（该 cue 被忽略）。</summary>
    public static List<CueTrack> Parse(string cuePath, string rootFolder, Action<string> log)
    {
        var tracks = new List<CueTrack>();
        string text;
        try
        {
            text = ReadText(cuePath);
        }
        catch (Exception exception)
        {
            log($"[cue] read failed {cuePath}: {exception.Message}");
            return tracks;
        }

        var cueDir = Path.GetDirectoryName(cuePath) ?? rootFolder;
        var currentFile = string.Empty;
        CueTrack? pending = null;
        foreach (var rawLine in text.Split('\n'))
        {
            var line = rawLine.Trim().TrimEnd('\r');
            if (line.Length == 0 || line.StartsWith("REM ", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (line.StartsWith("FILE ", StringComparison.OrdinalIgnoreCase))
            {
                currentFile = ExtractQuoted(line.Substring(5));
                continue;
            }

            if (line.StartsWith("TRACK ", StringComparison.OrdinalIgnoreCase))
            {
                if (pending is not null)
                {
                    tracks.Add(pending);
                }

                pending = new CueTrack
                {
                    FileRel = currentFile,
                    Number = ParseNumber(line.Substring(6)),
                };
                continue;
            }

            if (pending is null)
            {
                continue;
            }

            if (line.StartsWith("TITLE ", StringComparison.OrdinalIgnoreCase))
            {
                pending.Title = ExtractQuoted(line.Substring(6));
            }
            else if (line.StartsWith("PERFORMER ", StringComparison.OrdinalIgnoreCase))
            {
                pending.Performer = ExtractQuoted(line.Substring(10));
            }
            else if (line.StartsWith("INDEX 01 ", StringComparison.OrdinalIgnoreCase))
            {
                pending.StartSeconds = ParseIndex(line.Substring(9));
            }
        }

        if (pending is not null)
        {
            tracks.Add(pending);
        }

        var resolved = new List<CueTrack>();
        foreach (var track in tracks)
        {
            if (string.IsNullOrWhiteSpace(track.FileRel))
            {
                continue;
            }

            var candidate = Path.GetFullPath(Path.Combine(cueDir, track.FileRel.Replace('/', Path.DirectorySeparatorChar)));
            if (!File.Exists(candidate))
            {
                // 有些 cue 写的是相对根目录的路径
                candidate = Path.GetFullPath(Path.Combine(rootFolder, track.FileRel.Replace('/', Path.DirectorySeparatorChar)));
            }

            if (!File.Exists(candidate))
            {
                log($"[cue] image missing {track.FileRel} in {cuePath}");
                continue;
            }

            track.FileRel = Path.GetRelativePath(rootFolder, candidate).Replace('\\', '/');
            resolved.Add(track);
        }

        resolved.Sort((left, right) => left.StartSeconds.CompareTo(right.StartSeconds));
        return resolved;
    }

    /// <summary>粗略估算镜像文件时长（只处理 flac / wav，其它返回 0 表示「播到文件结束」）。</summary>
    public static double Duration(string path)
    {
        try
        {
            return Path.GetExtension(path).ToLowerInvariant() switch
            {
                ".flac" => FlacDuration(path),
                ".wav" => WavDuration(path),
                _ => 0,
            };
        }
        catch
        {
            return 0;
        }
    }

    private static double FlacDuration(string path)
    {
        using var stream = File.OpenRead(path);
        var magic = new byte[4];
        if (stream.Read(magic, 0, 4) != 4 || magic[0] != (byte)'f' || magic[1] != (byte)'L' || magic[2] != (byte)'a' || magic[3] != (byte)'C')
        {
            return 0;
        }

        var header = new byte[4];
        var first = true;
        while (stream.Read(header, 0, 4) == 4)
        {
            var type = header[0] & 0x7F;
            var length = (header[1] << 16) | (header[2] << 8) | header[3];
            if (first && type == 0 && length >= 34)
            {
                var block = new byte[18];
                if (stream.Read(block, 0, 18) != 18)
                {
                    return 0;
                }

                // STREAMINFO：10 字节（min/max blocksize、min/max framesize）之后是 8 字节打包字段
                ulong packed = 0;
                for (var i = 10; i < 18; i += 1)
                {
                    packed = (packed << 8) | block[i];
                }

                var sampleRate = (int)((packed >> 44) & 0xFFFFF);
                var totalSamples = (long)(packed & 0xFFFFFFFFF);
                if (sampleRate > 0 && totalSamples > 0)
                {
                    return (double)totalSamples / sampleRate;
                }

                return 0;
            }

            stream.Seek(length, SeekOrigin.Current);
            first = false;
        }

        return 0;
    }

    private static double WavDuration(string path)
    {
        using var stream = File.OpenRead(path);
        var riff = new byte[12];
        if (stream.Read(riff, 0, 12) != 12 || riff[0] != (byte)'R' || riff[1] != (byte)'I' || riff[2] != (byte)'F' || riff[3] != (byte)'F')
        {
            return 0;
        }

        long byteRate = 0;
        while (true)
        {
            var chunk = new byte[8];
            if (stream.Read(chunk, 0, 8) != 8)
            {
                return 0;
            }

            var id = Encoding.ASCII.GetString(chunk, 0, 4);
            var size = BitConverter.ToUInt32(chunk, 4);
            if (id == "fmt ")
            {
                var fmt = new byte[Math.Min(size, 16u)];
                if (stream.Read(fmt, 0, fmt.Length) != fmt.Length)
                {
                    return 0;
                }

                if (fmt.Length >= 12)
                {
                    byteRate = BitConverter.ToUInt32(fmt, 8);
                }

                if (size > fmt.Length)
                {
                    stream.Seek(size - fmt.Length, SeekOrigin.Current);
                }
            }
            else if (id == "data")
            {
                return byteRate > 0 ? (double)size / byteRate : 0;
            }
            else
            {
                stream.Seek(size, SeekOrigin.Current);
            }
        }
    }

    private static string ReadText(string path)
    {
        var bytes = File.ReadAllBytes(path);
        var start = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF ? 3 : 0;
        try
        {
            return new UTF8Encoding(false, true).GetString(bytes, start, bytes.Length - start);
        }
        catch
        {
            // 老 cue 常见 GBK / Shift-JIS，取一个尽量不抛错的单字节回退（标题可能显示为乱码，播放不受影响）
            foreach (var codePage in new[] { 936, 932, 950, 1252 })
            {
                try
                {
                    return Encoding.GetEncoding(codePage).GetString(bytes, start, bytes.Length - start);
                }
                catch
                {
                    /* 该编码不可用，继续 */
                }
            }

            return Encoding.Latin1.GetString(bytes, start, bytes.Length - start);
        }
    }

    private static string ExtractQuoted(string value)
    {
        var match = Regex.Match(value, "\"([^\"]*)\"");
        return match.Success ? match.Groups[1].Value : value.Trim();
    }

    private static int ParseNumber(string value)
    {
        var digits = new string(Array.FindAll(value.ToCharArray(), char.IsDigit));
        return int.TryParse(digits, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) ? number : 0;
    }

    private static double ParseIndex(string value)
    {
        // mm:ss:ff（ff 为 1/75 秒）
        var match = Regex.Match(value, @"(\d+):(\d+):(\d+)");
        if (!match.Success)
        {
            return 0;
        }

        var minutes = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
        var seconds = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
        var frames = int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
        return minutes * 60 + seconds + frames / 75.0;
    }
}
