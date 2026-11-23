// 16-bit PCM 立体声 WAV 写出（与 StemsWav.Write16 同样的 44 字节头与原子落盘方式）。
using System.Buffers.Binary;
using System.IO;

namespace Zilux2.Analysis;

internal static class Wav16
{
    private const int BlockFrames = 4096;

    /// <summary>写 <paramref name="frames"/> 帧；先写同目录 GUID 临时文件，成功后 Move 覆盖。</summary>
    internal static void Write(string path, ReadOnlySpan<float> left, ReadOnlySpan<float> right, int frames)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 16))
            {
                WriteHeader(stream, frames);
                var buffer = new byte[BlockFrames * 4];
                var offset = 0;
                while (offset < frames)
                {
                    var count = Math.Min(BlockFrames, frames - offset);
                    var span = buffer.AsSpan(0, count * 4);
                    var cursor = 0;
                    for (var i = 0; i < count; i++)
                    {
                        BinaryPrimitives.WriteInt16LittleEndian(span[cursor..], ToInt16(left[offset + i]));
                        BinaryPrimitives.WriteInt16LittleEndian(span[(cursor + 2)..], ToInt16(right[offset + i]));
                        cursor += 4;
                    }

                    stream.Write(span);
                    offset += count;
                }
            }

            File.Move(temp, path, overwrite: true);
        }
        catch
        {
            try
            {
                if (File.Exists(temp))
                {
                    File.Delete(temp);
                }
            }
            catch
            {
                // 临时文件留给系统清理。
            }

            throw;
        }
    }

    /// <summary>读回本类写出的 16-bit 立体声 WAV（缓存命中时复测响度用）。</summary>
    internal static bool TryRead(string path, out float[] left, out float[] right, out int frames)
    {
        left = [];
        right = [];
        frames = 0;

        if (!File.Exists(path))
        {
            return false;
        }

        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(path);
        }
        catch (IOException)
        {
            return false;
        }

        if (bytes.Length < 44 ||
            !bytes.AsSpan(0, 4).SequenceEqual("RIFF"u8) ||
            !bytes.AsSpan(8, 4).SequenceEqual("WAVE"u8))
        {
            return false;
        }

        var channels = 0;
        var bits = 0;
        var dataOffset = -1;
        var dataBytes = 0;
        var position = 12;
        while (position + 8 <= bytes.Length)
        {
            var id = bytes.AsSpan(position, 4);
            var size = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(position + 4, 4));
            var body = position + 8;
            if (size < 0)
            {
                return false;
            }

            if (id.SequenceEqual("fmt "u8))
            {
                if (body + 16 > bytes.Length)
                {
                    return false;
                }

                channels = BinaryPrimitives.ReadInt16LittleEndian(bytes.AsSpan(body + 2, 2));
                bits = BinaryPrimitives.ReadInt16LittleEndian(bytes.AsSpan(body + 14, 2));
            }
            else if (id.SequenceEqual("data"u8))
            {
                dataOffset = body;
                dataBytes = Math.Min(size, bytes.Length - body);
                break;
            }

            position = body + size + (size & 1);
        }

        if (channels != 2 || bits != 16 || dataOffset < 0 || dataBytes < 4)
        {
            return false;
        }

        frames = dataBytes / 4;
        left = new float[frames];
        right = new float[frames];
        for (var i = 0; i < frames; i++)
        {
            var offset = dataOffset + i * 4;
            left[i] = BinaryPrimitives.ReadInt16LittleEndian(bytes.AsSpan(offset, 2)) / 32768f;
            right[i] = BinaryPrimitives.ReadInt16LittleEndian(bytes.AsSpan(offset + 2, 2)) / 32768f;
        }

        return true;
    }

    private static void WriteHeader(Stream stream, int frames)
    {        Span<byte> header = stackalloc byte[44];
        var dataBytes = frames * 4;
        "RIFF"u8.CopyTo(header);
        BinaryPrimitives.WriteInt32LittleEndian(header[4..], 36 + dataBytes);
        "WAVE"u8.CopyTo(header[8..]);
        "fmt "u8.CopyTo(header[12..]);
        BinaryPrimitives.WriteInt32LittleEndian(header[16..], 16);
        BinaryPrimitives.WriteInt16LittleEndian(header[20..], 1);
        BinaryPrimitives.WriteInt16LittleEndian(header[22..], 2);
        BinaryPrimitives.WriteInt32LittleEndian(header[24..], ExtensionContract.SampleRate);
        BinaryPrimitives.WriteInt32LittleEndian(header[28..], ExtensionContract.SampleRate * 4);
        BinaryPrimitives.WriteInt16LittleEndian(header[32..], 4);
        BinaryPrimitives.WriteInt16LittleEndian(header[34..], 16);
        "data"u8.CopyTo(header[36..]);
        BinaryPrimitives.WriteInt32LittleEndian(header[40..], dataBytes);
        stream.Write(header);
    }

    private static short ToInt16(float sample)
    {
        var scaled = Math.Clamp(sample, -1f, 1f) * 32768f;
        return (short)Math.Clamp(scaled, -32768f, 32767f);
    }
}
