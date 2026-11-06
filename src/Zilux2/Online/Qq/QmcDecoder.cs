using System.Buffers.Binary;
using System.IO;
using System.Text;

namespace Zilux2.Online.Qq;

/// <summary>
/// QMC2 流解密（QQ 音乐 .mgg/.mflac/.mmp4）。算法取自公开实现：
/// - ekey 解析：base64 → （可选 EncV2 TEA 包）→ header(8) + TEA(body)
/// - QMC2 三种掩码：MapScramble（API ekey 主路径）、MapCompressed（旧本地 key）、RC4（长 key）
/// 只做字节流异或，不解容器；解密后仍是 mp3/flac/ogg/m4a 原始字节。
/// </summary>
internal sealed class QmcDecoder
{
    internal const int KeyCompressSize = 128;
    internal const int KeyCompressOffset = 71214;
    internal const int MapBoundary = 0x7FFF;
    private const int Rc4FirstSegment = 0x80;
    private const int Rc4Segment = 0x1400;
    private const uint TeaDelta = 0x9e3779b9;

    private readonly QmcMode _mode;
    private readonly byte[] _key;
    private readonly byte[] _compressed;
    private readonly byte[]? _sbox;
    private readonly uint _hash;

    private QmcDecoder(QmcMode mode, byte[] key)
    {
        _mode = mode;
        _key = key;
        _compressed = mode == QmcMode.MapCompressed ? CompressKey(key) : Array.Empty<byte>();
        if (mode == QmcMode.Rc4)
        {
            _sbox = BuildSbox(key);
            _hash = BuildHash(key);
        }
    }

    public QmcMode Mode => _mode;

    /// <summary>由 ekey 与探测字节选择可用的解密器；探测全部失败返回 null。</summary>
    public static QmcDecoder? Detect(string? ekey, ReadOnlySpan<byte> probe)
    {
        if (!TryParseKey(ekey, out var key) || key.Length == 0)
        {
            return null;
        }

        foreach (var mode in CandidateModes(key))
        {
            var decoder = new QmcDecoder(mode, key);
            var length = Math.Min(probe.Length, 16);
            var sample = new byte[length];
            probe[..length].CopyTo(sample);
            decoder.Apply(0, sample);
            if (LooksLikeAudio(sample))
            {
                return decoder;
            }
        }

        return null;
    }

    /// <summary>按指定模式创建（服务器已缓存模式时用）。</summary>
    public static QmcDecoder? TryCreate(string? ekey, QmcMode mode)
    {
        if (!TryParseKey(ekey, out var key) || key.Length == 0)
        {
            return null;
        }

        return new QmcDecoder(mode, key);
    }

    /// <summary>URL 路径是否指向加密档（忽略查询串）。</summary>
    public static bool LooksEncryptedUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return false;
        }

        var path = url;
        var mark = path.IndexOfAny(['?', '#']);
        if (mark >= 0)
        {
            path = path[..mark];
        }

        var slash = path.LastIndexOf('/');
        var name = slash >= 0 ? path[(slash + 1)..] : path;
        return name.EndsWith(".mgg", StringComparison.OrdinalIgnoreCase)
               || name.EndsWith(".mflac", StringComparison.OrdinalIgnoreCase)
               || name.EndsWith(".mmp4", StringComparison.OrdinalIgnoreCase)
               || name.EndsWith(".mgg1", StringComparison.OrdinalIgnoreCase)
               || name.EndsWith(".mflac0", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>从加密 URL 提取带扩展名的文件名（GetEVkey 要求 filename 带扩展名）。</summary>
    public static string? EncryptedFileName(string? url)
    {
        if (!LooksEncryptedUrl(url))
        {
            return null;
        }

        var path = url!;
        var mark = path.IndexOfAny(['?', '#']);
        if (mark >= 0)
        {
            path = path[..mark];
        }

        var slash = path.LastIndexOf('/');
        return slash >= 0 ? path[(slash + 1)..] : path;
    }

    /// <summary>
    /// 下载完成后剥离 QQ 客户端附加的尾部元数据（musicex / QTag）。
    /// 无法识别时保持文件不变；返回被剥掉的字节数。
    /// </summary>
    public static int TrimTail(string path)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            return TrimTail(stream, stream.Length);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return 0;
        }
    }

    /// <summary>在已打开的写入流上剥离尾部（下载完成、Flush 之后调用）。</summary>
    public static int TrimTail(FileStream stream, long length)
    {
        if (!stream.CanSeek || !stream.CanWrite || length < 16)
        {
            return 0;
        }

        try
        {
            Span<byte> tail = stackalloc byte[16];
            stream.Seek(length - 16, SeekOrigin.Begin);
            stream.ReadExactly(tail);

            long cut = 0;
            if (tail[8] == (byte)'m' && tail[9] == (byte)'u' && tail[10] == (byte)'s' &&
                tail[11] == (byte)'i' && tail[12] == (byte)'c' && tail[13] == (byte)'e' &&
                tail[14] == (byte)'x' && tail[15] == 0)
            {
                cut = BinaryPrimitives.ReadUInt32LittleEndian(tail[..4]);
            }
            else
            {
                var metaSize = BinaryPrimitives.ReadUInt32LittleEndian(tail[12..16]);
                if (metaSize is > 4 and < 1024 * 1024 && metaSize + 8 <= length)
                {
                    Span<byte> magic = stackalloc byte[4];
                    stream.Seek(length - metaSize - 4, SeekOrigin.Begin);
                    stream.ReadExactly(magic);
                    if (magic.SequenceEqual("QTag"u8))
                    {
                        cut = metaSize + 8;
                    }
                }
            }

            if (cut <= 0 || cut >= length || length - cut < 4096)
            {
                return 0;
            }

            stream.SetLength(length - cut);
            stream.Seek(0, SeekOrigin.End);
            return (int)cut;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return 0;
        }
    }

    /// <summary>offset 为媒体文件内的绝对字节偏移；对 span 原地异或。</summary>
    public void Apply(long offset, Span<byte> data)
    {
        switch (_mode)
        {
            case QmcMode.MapScramble:
                ApplyMapScramble(offset, data);
                break;
            case QmcMode.MapCompressed:
                ApplyMapCompressed(offset, data);
                break;
            case QmcMode.Rc4:
                ApplyRc4(offset, data);
                break;
        }
    }

    private void ApplyMapScramble(long offset, Span<byte> data)
    {
        var n = _key.Length;
        for (var i = 0; i < data.Length; i++)
        {
            var o = offset + i;
            if (o > MapBoundary)
            {
                o %= MapBoundary;
            }

            var idx = (int)((o * o + KeyCompressOffset) % n);
            var mask = ShiftMix(_key[idx], (idx + 4) & 7);
            data[i] ^= mask;
        }
    }

    private void ApplyMapCompressed(long offset, Span<byte> data)
    {
        for (var i = 0; i < data.Length; i++)
        {
            var o = offset + i;
            if (o > MapBoundary)
            {
                o %= MapBoundary;
            }

            data[i] ^= _compressed[(int)(o & (KeyCompressSize - 1))];
        }
    }

    private void ApplyRc4(long offset, Span<byte> data)
    {
        var sbox = _sbox!;
        var n = sbox.Length;
        var pos = 0;

        // 首段：< 0x80 的偏移使用逐字节 key 与派生索引。
        while (pos < data.Length && offset < Rc4FirstSegment)
        {
            var key1 = _key[(int)(offset % n)];
            var k2 = SegmentKey(offset, key1);
            var mask = _key[(int)(k2 % (ulong)n)];
            data[pos++] ^= mask;
            offset++;
        }

        // 其余段：每 0x1400 字节重建一次 RC4 状态并丢弃前若干字节。
        while (pos < data.Length)
        {
            var segmentId = offset / Rc4Segment;
            var seed = _key[(int)(segmentId & 0x1FF) % n];
            var discard = (SegmentKey(segmentId, seed) & 0x1FF) + (ulong)(offset % Rc4Segment);
            var state = (byte[])sbox.Clone();
            var j = 0;
            var k = 0;
            var drop = discard;
            var limit = discard + (ulong)(data.Length - pos);
            for (ulong step = 0; step < limit; step++)
            {
                j = (int)((uint)(j + 1) % (uint)n);
                k = (int)(((uint)state[j] + (uint)k) % (uint)n);
                (state[j], state[k]) = (state[k], state[j]);
                var value = state[(state[j] + state[k]) % n];
                if (drop > 0)
                {
                    drop--;
                    continue;
                }

                data[pos++] ^= value;
                if (pos >= data.Length)
                {
                    break;
                }
            }

            // 若本段未消耗完（理论上不会），把 offset 推进到下一段边界。
            offset = (segmentId + 1) * Rc4Segment;
        }
    }

    private ulong SegmentKey(long id, byte seed)
    {
        if (seed == 0)
        {
            return 0;
        }

        var value = (double)_hash / ((id + 1) * (double)seed) * 100.0;
        if (double.IsNaN(value) || double.IsInfinity(value) || value < 0)
        {
            return 0;
        }

        return value >= ulong.MaxValue ? ulong.MaxValue : (ulong)value;
    }

    private static IEnumerable<QmcMode> CandidateModes(byte[] key)
    {
        if (key.Length > 300)
        {
            yield return QmcMode.Rc4;
        }

        yield return QmcMode.MapScramble;
        yield return QmcMode.MapCompressed;
        if (key.Length > 300)
        {
            yield break;
        }
    }

    private static byte[] CompressKey(byte[] key)
    {
        var n = key.Length;
        var compressed = new byte[KeyCompressSize];
        for (var i = 0; i < KeyCompressSize; i++)
        {
            var idx = (int)(((long)i * i + KeyCompressOffset) % n);
            compressed[i] = ShiftMix(key[idx], (idx + 4) & 7);
        }

        return compressed;
    }

    private static byte ShiftMix(byte value, int shift)
    {
        shift &= 7;
        if (shift == 0)
        {
            return value;
        }

        // 与 JS `(v << s) | (v >>> s)` / Rust `wrapping_shl | wrapping_shr` 一致，
        // 注意不是 8 位循环移位。
        return (byte)(((value << shift) | (value >> shift)) & 0xFF);
    }

    private static byte[] BuildSbox(byte[] key)
    {
        var n = key.Length;
        var sbox = new byte[n];
        for (var i = 0; i < n; i++)
        {
            sbox[i] = (byte)(i & 0xFF);
        }

        var j = 0;
        for (var i = 0; i < n; i++)
        {
            j = (int)(((uint)sbox[i] + (uint)j + key[i]) % (uint)n);
            (sbox[i], sbox[j]) = (sbox[j], sbox[i]);
        }

        return sbox;
    }

    private static uint BuildHash(byte[] key)
    {
        uint hash = 1;
        foreach (var value in key)
        {
            if (value == 0)
            {
                continue;
            }

            var next = hash * value;
            if (next == 0 || next <= hash)
            {
                break;
            }

            hash = next;
        }

        return hash;
    }

    /// <summary>解析 ekey 为原始 key 字节；失败返回 false。</summary>
    public static bool TryParseKey(string? ekey, out byte[] key)
    {
        key = Array.Empty<byte>();
        if (string.IsNullOrWhiteSpace(ekey))
        {
            return false;
        }

        byte[] raw;
        try
        {
            raw = Convert.FromBase64String(ekey.Trim().TrimEnd('\0'));
        }
        catch (FormatException)
        {
            return false;
        }

        if (raw.Length >= 18 && Encoding.ASCII.GetString(raw, 0, 18) == "QQMusic EncV2,Key:")
        {
            var body = raw[18..];
            if (!TryTeaDecrypt(body, Encoding.ASCII.GetBytes("386ZJY!@#*$%^&)("), out var stage1))
            {
                return false;
            }

            if (!TryTeaDecrypt(stage1, Encoding.ASCII.GetBytes("**#!(#$%&^a1cZ,T"), out var stage2))
            {
                return false;
            }

            try
            {
                raw = Convert.FromBase64String(Encoding.ASCII.GetString(stage2));
            }
            catch (FormatException)
            {
                return false;
            }
        }

        if (raw.Length < 8)
        {
            return false;
        }

        var headerKey = raw[..8];
        var bodyKey = raw[8..];
        if (bodyKey.Length == 0)
        {
            key = headerKey;
            return true;
        }

        var simple = SimpleMakeKey(106, 8);
        var teaKey = new byte[16];
        for (var i = 0; i < 8; i++)
        {
            teaKey[i << 1] = simple[i];
            teaKey[(i << 1) + 1] = headerKey[i];
        }

        if (TryTeaDecrypt(bodyKey, teaKey, out var decrypted))
        {
            key = new byte[8 + decrypted.Length];
            headerKey.CopyTo(key, 0);
            decrypted.CopyTo(key, 8);
            return true;
        }

        // API 直接下发的裸 key（未带 EncV1 头）走这里。
        key = raw;
        return true;
    }

    internal static byte[] SimpleMakeKey(double salt, int length)
    {
        var result = new byte[length];
        for (var i = 0; i < length; i++)
        {
            var value = Math.Tan(salt + i * 0.1);
            result[i] = (byte)((int)(Math.Abs(value) * 100.0) & 0xFF);
        }

        return result;
    }

    /// <summary>腾讯 TEA（CBC 变体 + 1+pad+salt2 头 + 7 字节零尾）。</summary>
    internal static bool TryTeaDecrypt(ReadOnlySpan<byte> input, ReadOnlySpan<byte> key, out byte[] output)
    {
        output = Array.Empty<byte>();
        if (input.Length < 16 || input.Length % 8 != 0 || key.Length < 16)
        {
            return false;
        }

        var k0 = BinaryPrimitives.ReadUInt32BigEndian(key);
        var k1 = BinaryPrimitives.ReadUInt32BigEndian(key[4..]);
        var k2 = BinaryPrimitives.ReadUInt32BigEndian(key[8..]);
        var k3 = BinaryPrimitives.ReadUInt32BigEndian(key[12..]);

        var tmp = new byte[8];
        DecryptBlock(input[..8], k0, k1, k2, k3, tmp);
        var tmpIndex = 1 + (tmp[0] & 0x7);
        var ivPrev = new byte[8];
        var ivCur = new byte[8];
        input[..8].CopyTo(ivCur);
        var position = 8;

        // tmpIndex 已含 1 字节 pad 长度；再扣 2 字节 salt 与 7 字节零尾。
        var outputLength = input.Length - tmpIndex - 9;
        if (outputLength < 0)
        {
            return false;
        }

        // 跳过 2 字节 salt。
        for (var i = 0; i < 2;)
        {
            if (tmpIndex < 8)
            {
                tmpIndex++;
                i++;
            }
            else
            {
                if (!CryptBlock(input, ref position, tmp, ivPrev, ivCur, k0, k1, k2, k3))
                {
                    return false;
                }

                tmpIndex = 0;
            }
        }

        var result = new byte[outputLength];
        var outPos = 0;
        while (outPos < outputLength)
        {
            if (tmpIndex < 8)
            {
                result[outPos++] = (byte)(tmp[tmpIndex] ^ ivPrev[tmpIndex]);
                tmpIndex++;
            }
            else
            {
                if (!CryptBlock(input, ref position, tmp, ivPrev, ivCur, k0, k1, k2, k3))
                {
                    return false;
                }

                tmpIndex = 0;
            }
        }

        // 7 字节零尾校验。
        for (var i = 0; i < 7; i++)
        {
            if (tmpIndex >= 8)
            {
                if (!CryptBlock(input, ref position, tmp, ivPrev, ivCur, k0, k1, k2, k3))
                {
                    return false;
                }

                tmpIndex = 0;
            }

            if (tmp[tmpIndex] != ivPrev[tmpIndex])
            {
                return false;
            }

            tmpIndex++;
        }

        output = result;
        return true;
    }

    private static bool CryptBlock(
        ReadOnlySpan<byte> input,
        ref int position,
        byte[] tmp,
        byte[] ivPrev,
        byte[] ivCur,
        uint k0,
        uint k1,
        uint k2,
        uint k3)
    {
        if (position + 8 > input.Length)
        {
            return false;
        }

        Buffer.BlockCopy(ivCur, 0, ivPrev, 0, 8);
        input.Slice(position, 8).CopyTo(ivCur);
        position += 8;
        for (var j = 0; j < 8; j++)
        {
            tmp[j] ^= ivCur[j];
        }

        var decrypted = new byte[8];
        DecryptBlock(tmp, k0, k1, k2, k3, decrypted);
        decrypted.CopyTo(tmp, 0);
        return true;
    }

    private static void DecryptBlock(ReadOnlySpan<byte> input, uint k0, uint k1, uint k2, uint k3, Span<byte> output)
    {
        var y = BinaryPrimitives.ReadUInt32BigEndian(input);
        var z = BinaryPrimitives.ReadUInt32BigEndian(input[4..]);
        var sum = unchecked(TeaDelta * 16);
        for (var i = 0; i < 16; i++)
        {
            z = unchecked(z - ((((y << 4) + k2) ^ (sum + y)) ^ ((y >> 5) + k3)));
            y = unchecked(y - ((((z << 4) + k0) ^ (sum + z)) ^ ((z >> 5) + k1)));
            sum = unchecked(sum - TeaDelta);
        }

        BinaryPrimitives.WriteUInt32BigEndian(output, y);
        BinaryPrimitives.WriteUInt32BigEndian(output[4..], z);
    }

    private static bool LooksLikeAudio(ReadOnlySpan<byte> data)
    {
        if (data.Length >= 4)
        {
            var four = Encoding.ASCII.GetString(data[..4]);
            if (four is "fLaC" or "OggS" or "RIFF")
            {
                return true;
            }
        }

        if (data.Length >= 3 && Encoding.ASCII.GetString(data[..3]) == "ID3")
        {
            return true;
        }

        if (data.Length >= 2 && data[0] == 0xFF && (data[1] & 0xE0) == 0xE0)
        {
            return true;
        }

        return data.Length >= 8 && Encoding.ASCII.GetString(data.Slice(4, 4)) == "ftyp";
    }
}

internal enum QmcMode
{
    MapScramble = 0,
    MapCompressed = 1,
    Rc4 = 2,
}
