using System.Buffers.Binary;
using System.Text;

namespace StemsProto;

/// <summary>44.1 kHz stereo PCM, planar (L[] / R[]), float in [-1, 1].</summary>
internal sealed class StereoPcm
{
    public required float[] L { get; init; }
    public required float[] R { get; init; }
    public int Frames => L.Length;
    public int SampleRate { get; init; } = 44100;
}

internal static class Wav
{
    /// <summary>
    /// Minimal RIFF reader. Only what the separator actually needs: 44100 Hz, 16-bit,
    /// 2 channels. Anything else is a hard error rather than a silent downsample —
    /// resampling here would break the sample-exact "instrumental = mix - vocals" identity.
    /// </summary>
    public static StereoPcm Read(string path)
    {
        byte[] bytes = File.ReadAllBytes(path);
        if (bytes.Length < 44 ||
            Encoding.ASCII.GetString(bytes, 0, 4) != "RIFF" ||
            Encoding.ASCII.GetString(bytes, 8, 4) != "WAVE")
            throw new InvalidDataException("not a RIFF/WAVE file: " + path);

        int pos = 12;
        short audioFormat = 0, channels = 0, bitsPerSample = 0;
        int sampleRate = 0, dataOffset = -1, dataLen = 0;

        while (pos + 8 <= bytes.Length)
        {
            string id = Encoding.ASCII.GetString(bytes, pos, 4);
            int size = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(pos + 4, 4));
            int body = pos + 8;
            if (id == "fmt ")
            {
                audioFormat = BinaryPrimitives.ReadInt16LittleEndian(bytes.AsSpan(body, 2));
                channels = BinaryPrimitives.ReadInt16LittleEndian(bytes.AsSpan(body + 2, 2));
                sampleRate = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(body + 4, 4));
                bitsPerSample = BinaryPrimitives.ReadInt16LittleEndian(bytes.AsSpan(body + 14, 2));
            }
            else if (id == "data")
            {
                dataOffset = body;
                dataLen = Math.Min(size, bytes.Length - body);
            }
            pos = body + size + (size & 1);
        }

        if (dataOffset < 0) throw new InvalidDataException("no data chunk");
        if (audioFormat != 1) throw new InvalidDataException($"expected PCM (1), got {audioFormat}");
        if (channels != 2) throw new InvalidDataException($"expected stereo, got {channels} ch");
        if (bitsPerSample != 16) throw new InvalidDataException($"expected 16-bit, got {bitsPerSample}");
        if (sampleRate != 44100) throw new InvalidDataException($"expected 44100 Hz, got {sampleRate}");

        int frames = dataLen / 4; // 2 ch * 2 bytes
        var l = new float[frames];
        var r = new float[frames];
        var span = bytes.AsSpan(dataOffset, frames * 4);
        for (int i = 0, o = 0; i < frames; i++, o += 4)
        {
            l[i] = BinaryPrimitives.ReadInt16LittleEndian(span.Slice(o, 2)) / 32768f;
            r[i] = BinaryPrimitives.ReadInt16LittleEndian(span.Slice(o + 2, 2)) / 32768f;
        }
        return new StereoPcm { L = l, R = r, SampleRate = sampleRate };
    }

    /// <summary>
    /// Writes 16-bit PCM. <paramref name="scale"/> is the peak divisor that was applied
    /// (>1 when the signal overshot), so the player can undo it with a gain node —
    /// same idea as Folia's per-track peak divisor, and it avoids clipping the
    /// "instrumental = mix - vocals" overshoot.
    /// </summary>
    public static void Write16(string path, float[] l, float[] r, int rate)
    {
        int frames = l.Length;
        int dataLen = frames * 4;
        using var fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20);
        using var bw = new BinaryWriter(fs);
        bw.Write(Encoding.ASCII.GetBytes("RIFF"));
        bw.Write(36 + dataLen);
        bw.Write(Encoding.ASCII.GetBytes("WAVE"));
        bw.Write(Encoding.ASCII.GetBytes("fmt "));
        bw.Write(16);
        bw.Write((short)1);
        bw.Write((short)2);
        bw.Write(rate);
        bw.Write(rate * 4);
        bw.Write((short)4);
        bw.Write((short)16);
        bw.Write(Encoding.ASCII.GetBytes("data"));
        bw.Write(dataLen);

        var buf = new byte[frames * 4];
        static short ToI16(float v)
        {
            float s = v * 32768f;
            if (s > 32767f) s = 32767f;
            else if (s < -32768f) s = -32768f;
            return (short)MathF.Round(s);
        }
        for (int i = 0, o = 0; i < frames; i++, o += 4)
        {
            BinaryPrimitives.WriteInt16LittleEndian(buf.AsSpan(o, 2), ToI16(l[i]));
            BinaryPrimitives.WriteInt16LittleEndian(buf.AsSpan(o + 2, 2), ToI16(r[i]));
        }
        bw.Write(buf);
    }
}
