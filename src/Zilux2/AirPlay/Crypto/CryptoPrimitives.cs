using System;
using System.Buffers.Binary;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

namespace Zilux2.AirPlay.Crypto;

/// <summary>
/// 密码学公用小工具（全部基于 .NET 10 BCL，无第三方依赖）。
/// </summary>
public static class CryptoPrimitives
{
    /// <summary>SHA-512 摘要长度（字节）。</summary>
    public const int Sha512Length = 64;

    /// <summary>SHA-256 摘要长度（字节）。</summary>
    public const int Sha256Length = 32;

    /// <summary>安全随机数填充。</summary>
    public static byte[] RandomBytes(int length)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(length);
        var bytes = new byte[length];
        RandomNumberGenerator.Fill(bytes);
        return bytes;
    }

    /// <summary>计算 SHA-512。</summary>
    public static byte[] Sha512(ReadOnlySpan<byte> data) => SHA512.HashData(data);

    /// <summary>计算 SHA-512（两段拼接，等价 H(a|b)）。</summary>
    public static byte[] Sha512(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b) => SHA512.HashData(Concat(a, b));

    /// <summary>计算 SHA-512（三段拼接，等价 H(a|b|c)）。</summary>
    public static byte[] Sha512(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b, ReadOnlySpan<byte> c) => SHA512.HashData(Concat(a, b, c));

    /// <summary>计算 SHA-512 的函数式重载（用于 SRP 的 H(a|b|c) 写法）。</summary>
    public static byte[] Sha512(params byte[][] parts) => SHA512.HashData(Concat(parts));

    /// <summary>计算 SHA-1（Apple 经典 SRP / Apple-Challenge 用）。</summary>
    public static byte[] Sha1(params byte[][] parts) => SHA1.HashData(Concat(parts));

    /// <summary>计算 SHA-1。</summary>
    public static byte[] Sha1(ReadOnlySpan<byte> data) => SHA1.HashData(data);

    /// <summary>按给定哈希算法计算多段拼接摘要。</summary>
    public static byte[] Hash(HashAlgorithmName algorithm, params byte[][] parts)
    {
        var data = Concat(parts);
        return algorithm.Name switch
        {
            "SHA1" => SHA1.HashData(data),
            "SHA256" => SHA256.HashData(data),
            "SHA384" => SHA384.HashData(data),
            "SHA512" => SHA512.HashData(data),
            _ => throw new CryptographicException($"不支持的哈希算法: {algorithm.Name}"),
        };
    }

    /// <summary>HKDF-SHA512（HAP 配对全部密钥派生都用它）。</summary>
    public static byte[] HkdfSha512(ReadOnlySpan<byte> ikm, ReadOnlySpan<byte> salt, ReadOnlySpan<byte> info, int length)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(length);
        var output = new byte[length];
        HKDF.DeriveKey(HashAlgorithmName.SHA512, ikm, output, salt, info);
        return output;
    }

    /// <summary>HKDF-SHA512 的字符串 salt/info 便捷重载（HAP 规范全程用 ASCII 字符串作 salt/info）。</summary>
    public static byte[] HkdfSha512(ReadOnlySpan<byte> ikm, string salt, string info, int length = 32)
        => HkdfSha512(ikm, Encoding.ASCII.GetBytes(salt), Encoding.ASCII.GetBytes(info), length);

    /// <summary>拼接两段字节。</summary>
    public static byte[] Concat(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b)
    {
        var result = new byte[a.Length + b.Length];
        a.CopyTo(result);
        b.CopyTo(result.AsSpan(a.Length));
        return result;
    }

    /// <summary>拼接三段字节。</summary>
    public static byte[] Concat(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b, ReadOnlySpan<byte> c)
    {
        var result = new byte[a.Length + b.Length + c.Length];
        a.CopyTo(result);
        var offset = a.Length;
        b.CopyTo(result.AsSpan(offset));
        offset += b.Length;
        c.CopyTo(result.AsSpan(offset));
        return result;
    }

    /// <summary>拼接四段字节。</summary>
    public static byte[] Concat(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b, ReadOnlySpan<byte> c, ReadOnlySpan<byte> d)
    {
        var result = new byte[a.Length + b.Length + c.Length + d.Length];
        a.CopyTo(result);
        var offset = a.Length;
        b.CopyTo(result.AsSpan(offset));
        offset += b.Length;
        c.CopyTo(result.AsSpan(offset));
        offset += c.Length;
        d.CopyTo(result.AsSpan(offset));
        return result;
    }

    /// <summary>拼接若干字节数组（byte[][] 重载）。</summary>
    public static byte[] Concat(params byte[][] parts)
    {
        int total = 0;
        foreach (var p in parts) total += p?.Length ?? 0;
        var result = new byte[total];
        int offset = 0;
        foreach (var p in parts)
        {
            if (p is null) continue;
            p.CopyTo(result, offset);
            offset += p.Length;
        }
        return result;
    }

    /// <summary>常量时间比较两个字节序列（长度不同返回 false，不做长度泄漏补偿）。</summary>
    public static bool FixedTimeEquals(ReadOnlySpan<byte> left, ReadOnlySpan<byte> right)
        => left.Length == right.Length && CryptographicOperations.FixedTimeEquals(left, right);

    /// <summary>把大端最小字节表示（无前导零）转成正整数，空数组表示 0。</summary>
    public static BigInteger FromBigEndian(ReadOnlySpan<byte> bytes) => new(bytes, isUnsigned: true, isBigEndian: true);

    /// <summary>把正整数转成最小大端字节表示（无前导零；0 返回空数组，与 srptools/BouncyCastle 的 ToByteArrayUnsigned 语义一致）。</summary>
    public static byte[] ToBigEndianUnsigned(BigInteger value)
    {
        if (value.Sign < 0) throw new ArgumentOutOfRangeException(nameof(value), "只支持非负整数");
        if (value.IsZero) return Array.Empty<byte>();
        return value.ToByteArray(isUnsigned: true, isBigEndian: true);
    }

    /// <summary>正整数转成恰好 <paramref name="length"/> 字节的大端表示（左侧补零）。</summary>
    public static byte[] ToBigEndianPadded(BigInteger value, int length)
    {
        var raw = ToBigEndianUnsigned(value);
        if (raw.Length > length) throw new ArgumentException($"整数需要 {raw.Length} 字节，超过目标长度 {length}", nameof(value));
        if (raw.Length == length) return raw;
        var result = new byte[length];
        raw.CopyTo(result, length - raw.Length);
        return result;
    }

    /// <summary>大端读取无符号 16/32 位。</summary>
    public static ushort ReadBigEndianUInt16(ReadOnlySpan<byte> data) => BinaryPrimitives.ReadUInt16BigEndian(data);

    /// <summary>大端写入无符号 32 位。</summary>
    public static void WriteBigEndianUInt32(Span<byte> destination, uint value) => BinaryPrimitives.WriteUInt32BigEndian(destination, value);

    /// <summary>十六进制转字节（忽略空白、'-'、':' 分隔符；兼容大小写）。</summary>
    public static byte[] ParseHex(string hex)
    {
        ArgumentNullException.ThrowIfNull(hex);
        var sb = new StringBuilder(hex.Length);
        foreach (var c in hex)
        {
            if (c is ' ' or '\t' or '\r' or '\n' or '-' or ':') continue;
            sb.Append(c);
        }
        return Convert.FromHexString(sb.ToString());
    }

    /// <summary>字节转小写十六进制字符串。</summary>
    public static string ToHex(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(bytes);

    /// <summary>字节转大写十六进制字符串（Apple legacy 配对的 user 字段用大写）。</summary>
    public static string ToHexUpper(ReadOnlySpan<byte> bytes) => Convert.ToHexString(bytes);

    /// <summary>
    /// 解码 Base64；容忍缺失的 '=' 填充（AirPlay 的 rsaaeskey / pk / Apple-Challenge 经常省掉填充）。
    /// </summary>
    public static byte[] Base64DecodeLenient(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        text = text.Trim().Replace(" ", "").Replace("\r", "").Replace("\n", "");
        // 兼容 base64url 变体
        text = text.Replace('-', '+').Replace('_', '/');
        while (text.Length % 4 != 0) text += "=";
        return Convert.FromBase64String(text);
    }

    /// <summary>编码 Base64 并去掉尾部 '='（Apple 头字段惯例）。</summary>
    public static string Base64NoPadding(ReadOnlySpan<byte> data) => Convert.ToBase64String(data).TrimEnd('=');

    /// <summary>字符串的 ASCII 字节。</summary>
    public static byte[] Ascii(string text) => Encoding.ASCII.GetBytes(text);

    /// <summary>字符串的 UTF-8 字节。</summary>
    public static byte[] Utf8(string text) => Encoding.UTF8.GetBytes(text);
}
