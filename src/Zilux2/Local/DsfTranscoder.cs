using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Zilux2.Local;

/// <summary>
/// DSF（DSD Stream File）→ WAV 转码：用「按位求均值」的简易低通把 1-bit DSD 降采样成 88.2kHz PCM。
/// 结果缓存在 %LOCALAPPDATA%\Zilux2\dsf-cache，同一会话内同文件只转一次；页面拿到的是标准 WAV，可随意拖动进度。
/// 缓存会在应用启动/退出时清空，避免长期占用 C 盘。
/// </summary>
internal static class DsfTranscoder
{
    /// <summary>目标输出采样率；DSD64/128/256 都能整除到 88.2k。</summary>
    private const int OutputRate = 88200;

    /// <summary>转码过程中每个通道一次处理的输出采样数。</summary>
    private const int ChunkSamples = 8192;

    /// <summary>确保 dsf 文件已转成 wav；成功时返回缓存路径。</summary>
    public static bool TryEnsureWav(string dsfPath, out string wavPath, out string error)
    {
        wavPath = string.Empty;
        error = string.Empty;
        string? temp = null;
        try
        {
            var info = new FileInfo(dsfPath);
            if (!info.Exists)
            {
                error = "文件不存在";
                return false;
            }

            var cacheDir = TranscodeCache.DsfDirectory;
            Directory.CreateDirectory(cacheDir);
            var stamp = $"{info.FullName}|{info.Length}|{info.LastWriteTimeUtc.Ticks}";
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(stamp))).ToLowerInvariant();
            wavPath = Path.Combine(cacheDir, hash.Substring(0, 24) + ".wav");
            if (File.Exists(wavPath) && new FileInfo(wavPath).Length > 44)
            {
                return true;
            }

            // 同 AlacTranscoder：固定 ".tmp" 在并发转码时会互踩，缓存里会留下残缺 WAV。
            temp = wavPath + "." + Guid.NewGuid().ToString("N")[..8] + ".tmp";
            var stopwatch = Stopwatch.StartNew();
            ConvertToWav(dsfPath, temp, out var sourceRate, out var channels, out var samples);
            if (File.Exists(wavPath) && new FileInfo(wavPath).Length > 44)
            {
                TryDeleteTemp(temp);
                temp = null;
                stopwatch.Stop();
                return true;
            }

            File.Move(temp, wavPath, overwrite: true);
            temp = null;
            stopwatch.Stop();
            TranscodeCache.Prune(cacheDir);
            HostLog.Info($"[dsf] converted {Path.GetFileName(dsfPath)} → {Path.GetFileName(wavPath)} "
                + $"({sourceRate}Hz/{channels}ch, {samples} samples, {stopwatch.ElapsedMilliseconds}ms)");
            return true;
        }
        catch (Exception exception)
        {
            // 失败路径必须自清临时 WAV（DSD 一首能到上百 MB），否则缓存目录只增不减。
            if (temp is not null)
            {
                TryDeleteTemp(temp);
            }

            HostLog.Warn($"[dsf] convert failed {dsfPath}: {exception.GetType().Name}: {exception.Message}");
            error = exception.Message;
            wavPath = string.Empty;
            return false;
        }
    }

    private static void ConvertToWav(string dsfPath, string wavPath, out int sourceRate, out int channels, out long outSamples)
    {
        sourceRate = 0;
        channels = 1;
        outSamples = 0;

        using var stream = new FileStream(dsfPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new BinaryReader(stream, Encoding.ASCII, leaveOpen: true);
        var fileLength = stream.Length;
        var head = reader.ReadBytes(28);
        if (head.Length != 28 || head[0] != (byte)'D' || head[1] != (byte)'S' || head[2] != (byte)'D' || head[3] != (byte)' ')
        {
            throw new InvalidDataException("不是 DSF 文件");
        }

        // DSD 头本身就是一个 chunk（chunk 长度 28 含 12 字节头），之后才是 fmt / data 等 chunk
        var headerChunk = BitConverter.ToUInt64(head, 4);
        if (headerChunk < 28 || headerChunk > (ulong)fileLength)
        {
            throw new InvalidDataException("DSF 头部长度异常");
        }

        var bitsPerSample = 0;
        var blockSize = 0;
        long dataOffset = -1;
        long dataBytes = 0;

        // 每个 chunk 的 size 字段包含 12 字节头（ID + size）
        var cursor = (long)headerChunk;
        while (cursor + 12 <= fileLength)
        {
            stream.Position = cursor;
            var idBytes = reader.ReadBytes(4);
            if (idBytes.Length != 4)
            {
                break;
            }

            var id = Encoding.ASCII.GetString(idBytes);
            var size = reader.ReadUInt64();
            if (size < 12 || cursor + (long)size > fileLength)
            {
                break;
            }

            var payload = (long)size - 12;
            if (id == "fmt ")
            {
                var probe = reader.ReadBytes((int)Math.Min(payload, 64));
                if (probe.Length < 40)
                {
                    throw new InvalidDataException("DSF fmt 块不完整");
                }

                channels = Math.Max(1, (int)BitConverter.ToUInt32(probe, 12));
                sourceRate = (int)BitConverter.ToUInt32(probe, 16);
                bitsPerSample = (int)BitConverter.ToUInt32(probe, 20);
                blockSize = (int)BitConverter.ToUInt32(probe, 32);
            }
            else if (id == "data")
            {
                dataOffset = cursor + 12;
                dataBytes = payload;
                break;
            }

            cursor += (long)size;
        }

        if (dataOffset < 0 || dataBytes <= 0)
        {
            throw new InvalidDataException("DSF data 块缺失");
        }

        if (sourceRate <= 0 || blockSize <= 0)
        {
            throw new InvalidDataException("DSF fmt 参数异常");
        }

        if (bitsPerSample != 1 && bitsPerSample != 8)
        {
            throw new InvalidDataException($"不支持的 DSD 位深 {bitsPerSample}");
        }

        var factor = Math.Max(1, (int)Math.Round((double)sourceRate / OutputRate));
        var outRate = Math.Max(1, sourceRate / factor);
        var samplesPerBlock = blockSize * 8 / factor;
        if (samplesPerBlock <= 0)
        {
            throw new InvalidDataException("DSF 块大小异常");
        }

        stream.Position = dataOffset;
        using var output = new BufferedStream(new FileStream(wavPath, FileMode.Create, FileAccess.Write, FileShare.None), 1 << 20);
        WriteWavHeader(output, outRate, channels, 0);
        var block = new byte[blockSize * channels];
        var remaining = dataBytes;
        long written = 0;

        // DSD 静音位型 0x69（01101001）：均值恰好 0，补在文件尾部不会产生咔哒。
        const byte DsdSilence = 0x69;
        while (remaining > 0)
        {
            var want = (int)Math.Min(block.Length, remaining);
            var got = reader.Read(block, 0, want);
            if (got <= 0)
            {
                break;
            }

            // 文件被截断（下载中断、磁盘满）时最后一块往往不足一整块。
            // 原来 `while (remaining >= block.Length)` 直接丢掉这段尾巴，
            // 时长按整块算 → 末尾少几十毫秒且与容器时长不符；
            // 现在按剩余字节读，缺的部分补静音位型，时长完整、结尾干净。
            if (got < block.Length)
            {
                Array.Fill(block, DsdSilence, got, block.Length - got);
            }

            remaining -= got;
            var buffer = new byte[samplesPerBlock * channels * 2];
            for (var channel = 0; channel < channels; channel += 1)
            {
                var offset = channel * blockSize;
                for (var sample = 0; sample < samplesPerBlock; sample += 1)
                {
                    var sum = 0;
                    var baseBit = sample * factor;
                    for (var bit = 0; bit < factor; bit += 1)
                    {
                        var bitIndex = baseBit + bit;
                        var value = bitsPerSample == 8
                            ? (block[offset + (bitIndex >> 3)] >> (7 - (bitIndex & 7))) & 1
                            : (block[offset + (bitIndex >> 3)] >> (bitIndex & 7)) & 1;
                        sum += value == 1 ? 1 : -1;
                    }

                    var normalized = sum / (double)factor;
                    var pcm = (short)Math.Clamp((int)Math.Round(normalized * 9000.0), short.MinValue, short.MaxValue);
                    var target = (sample * channels + channel) * 2;
                    buffer[target] = (byte)(pcm & 0xFF);
                    buffer[target + 1] = (byte)((pcm >> 8) & 0xFF);
                }
            }

            output.Write(buffer, 0, buffer.Length);
            written += samplesPerBlock;

            if (got < block.Length)
            {
                HostLog.Warn($"[dsf] short tail {Path.GetFileName(dsfPath)}: last block {got}/{block.Length} bytes, padded with silence");
                break;
            }
        }

        output.Flush();
        output.Seek(4, SeekOrigin.Begin);
        WriteUInt32(output, (uint)(36 + written * channels * 2));
        output.Seek(40, SeekOrigin.Begin);
        WriteUInt32(output, (uint)(written * channels * 2));
        outSamples = written;
    }

    private static void WriteWavHeader(Stream stream, int sampleRate, int channels, int dataBytes)
    {
        var header = new byte[44];
        Encoding.ASCII.GetBytes("RIFF").CopyTo(header, 0);
        BitConverter.GetBytes(36 + dataBytes).CopyTo(header, 4);
        Encoding.ASCII.GetBytes("WAVE").CopyTo(header, 8);
        Encoding.ASCII.GetBytes("fmt ").CopyTo(header, 12);
        BitConverter.GetBytes(16).CopyTo(header, 16);
        BitConverter.GetBytes((short)1).CopyTo(header, 20);
        BitConverter.GetBytes((short)channels).CopyTo(header, 22);
        BitConverter.GetBytes(sampleRate).CopyTo(header, 24);
        BitConverter.GetBytes(sampleRate * channels * 2).CopyTo(header, 28);
        BitConverter.GetBytes((short)(channels * 2)).CopyTo(header, 32);
        BitConverter.GetBytes((short)16).CopyTo(header, 34);
        Encoding.ASCII.GetBytes("data").CopyTo(header, 36);
        BitConverter.GetBytes(dataBytes).CopyTo(header, 40);
        stream.Write(header, 0, header.Length);
    }

    private static void WriteUInt32(Stream stream, uint value)
    {
        var bytes = BitConverter.GetBytes(value);
        stream.Write(bytes, 0, bytes.Length);
    }

    private static void TryDeleteTemp(string path)
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
            HostLog.Warn($"[dsf] temp cleanup failed {Path.GetFileName(path)}: {exception.Message}");
        }
    }
}
