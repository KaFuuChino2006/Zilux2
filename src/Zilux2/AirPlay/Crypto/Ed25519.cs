using System;
using System.Numerics;
using System.Security.Cryptography;

namespace Zilux2.AirPlay.Crypto;

/// <summary>
/// Ed25519 纯托管实现（RFC 8032，Ed25519 纯模式 / PureEdDSA）。
///
/// 为什么自己写：.NET 10 BCL（System.Security.Cryptography）里没有公开的 Ed25519 类型
/// （只有 ECDsa/ECDiffieHellman，且不支持 Ed25519 曲线），而 HAP 配对必须用 Ed25519：
/// - pair-setup M5/M6：客户端/设备各自的长期身份密钥（LTSK/LTPK）签名；
/// - pair-verify M2/M3：X25519 临时公钥交换后，用长期密钥对双方临时公钥做签名绑定。
///
/// 实现要点：
/// - 射影坐标 + 扩展坐标（X:Y:Z:T）点运算，仿射形式需要模逆，代价高；
/// - 标量乘用二进制双倍-相加（非恒定时间：配对是一次性交互、消息公开，无侧信道要求，
///   注释在此说明，避免以后被误用于需要恒定时间的场景）；
/// - 点压缩为 32 字节 little-endian y || (x 的最低位放在最高 bit)，与 RFC 8032 一致；
/// - 验签按 RFC 8032 §5.1.7，校验 S &lt; L 与点编码合法性。
/// </summary>
public static class Ed25519
{
    /// <summary>公钥长度（字节）。</summary>
    public const int PublicKeySize = 32;

    /// <summary>私钥种子长度（字节）。</summary>
    public const int SeedSize = 32;

    /// <summary>签名长度（字节）。</summary>
    public const int SignatureSize = 64;

    // p = 2^255 - 19
    private static readonly BigInteger P = (BigInteger.One << 255) - 19;

    // L = 2^252 + 27742317777372353535851937790883648493（基点阶，标量必须 < L）
    private static readonly BigInteger L = (BigInteger.One << 252) + BigInteger.Parse("27742317777372353535851937790883648493");

    // d = -121665/121666 mod p（曲线方程 -x^2 + y^2 = 1 + d*x^2*y^2）
    private static readonly BigInteger D = Mod(-121665 * Inverse(121666));

    // 2*d mod p（扩展坐标加法用）
    private static readonly BigInteger D2 = Mod(2 * D);

    // sqrt(-1) = 2^((p-1)/4) mod p（点解码时如果 x^2 = -u/v 要乘它）
    private static readonly BigInteger SqrtM1 = BigInteger.ModPow(2, (P - 1) / 4, P);

    /// <summary>基点 B（y = 4/5，x 取偶的那个）。</summary>
    private static readonly Point BasePoint = CreateBasePoint();

    private static Point CreateBasePoint()
    {
        // RFC 8032 给出的基点坐标
        var by = FromLittleEndian(Convert.FromHexString(
            "5866666666666666666666666666666666666666666666666666666666666666"));
        var bx = FromLittleEndian(Convert.FromHexString(
            "1ad5258f602d56c9b2a7259560c72c695cdcd6fd31e2a4c0fe536ecdd3366921")); // 15112221349535400772501151409588531511454012693041857206046113283949847762202
        if (!TryDecodePoint(Compress(new Point(bx, by, BigInteger.One, Mod(bx * by))), out var decoded))
        {
            throw new CryptographicException("Ed25519 基点解码失败（实现错误）");
        }
        return decoded;
    }

    /// <summary>由 32 字节种子生成密钥对。</summary>
    public static Ed25519KeyPair CreateKeyPairFromSeed(ReadOnlySpan<byte> seed)
    {
        if (seed.Length != SeedSize) throw new ArgumentException($"Ed25519 种子必须是 {SeedSize} 字节", nameof(seed));
        return new Ed25519KeyPair(seed.ToArray());
    }

    /// <summary>随机生成 Ed25519 密钥对。</summary>
    public static Ed25519KeyPair CreateKeyPair() => new(CryptoPrimitives.RandomBytes(SeedSize));

    /// <summary>由种子推导 32 字节公钥。</summary>
    public static byte[] GetPublicKey(ReadOnlySpan<byte> seed)
    {
        if (seed.Length != SeedSize) throw new ArgumentException($"Ed25519 种子必须是 {SeedSize} 字节", nameof(seed));
        return Compress(ScalarMult(BasePoint, HashToScalar(SHA512.HashData(seed).AsSpan(0, SeedSize))));
    }

    /// <summary>用种子对消息签名（RFC 8032 §5.1.6），返回 64 字节签名。</summary>
    public static byte[] Sign(ReadOnlySpan<byte> seed, ReadOnlySpan<byte> message)
    {
        if (seed.Length != SeedSize) throw new ArgumentException($"Ed25519 种子必须是 {SeedSize} 字节", nameof(seed));

        // h = SHA-512(seed)；前 32 字节 clamp 后是私钥标量 s，后 32 字节是确定性随机数前缀
        var h = SHA512.HashData(seed);
        var s = HashToScalar(h.AsSpan(0, SeedSize));
        var publicKey = Compress(ScalarMult(BasePoint, s));

        // r = H(prefix || M) mod L
        var r = FromLittleEndian(SHA512.HashData(CryptoPrimitives.Concat(h.AsSpan(SeedSize, SeedSize), message))) % L;

        // R = r*B；k = H(R || A || M) mod L；S = r + k*s mod L
        var rEncoded = Compress(ScalarMult(BasePoint, r));
        var k = FromLittleEndian(SHA512.HashData(CryptoPrimitives.Concat(rEncoded, publicKey, message))) % L;
        var sValue = (r + k * s) % L;

        var signature = new byte[SignatureSize];
        rEncoded.CopyTo(signature, 0);
        ToLittleEndian32(sValue, signature.AsSpan(32, 32));
        return signature;
    }

    /// <summary>验证签名（RFC 8032 §5.1.7）。</summary>
    public static bool Verify(ReadOnlySpan<byte> publicKey, ReadOnlySpan<byte> message, ReadOnlySpan<byte> signature)
    {
        if (publicKey.Length != PublicKeySize) return false;
        if (signature.Length != SignatureSize) return false;

        var rEncoded = signature[..32].ToArray();
        var sBytes = signature[32..].ToArray();

        // S 必须是 0 <= S < L（小端编码），否则签名 malleable，拒绝
        var sValue = FromLittleEndian(sBytes);
        if (sValue >= L) return false;

        if (!TryDecodePoint(publicKey, out var a)) return false;
        if (!TryDecodePoint(rEncoded, out var r)) return false;

        var k = FromLittleEndian(SHA512.HashData(CryptoPrimitives.Concat(rEncoded, publicKey, message))) % L;

        // 校验 [S]B == R + [k]A（用压缩编码比较即可）
        var left = ScalarMult(BasePoint, sValue);
        var right = Add(r, ScalarMult(a, k));
        return CryptoPrimitives.FixedTimeEquals(Compress(left), Compress(right));
    }

    /// <summary>把种子 clamp 后得到私钥标量（小端）。</summary>
    private static BigInteger HashToScalar(ReadOnlySpan<byte> halfHash)
    {
        var buffer = halfHash[..SeedSize].ToArray();
        buffer[0] &= 248;
        buffer[31] &= 127;
        buffer[31] |= 64;
        return FromLittleEndian(buffer);
    }

    // ---- 域运算 ----

    private static BigInteger Mod(BigInteger value)
    {
        var r = value % P;
        return r.Sign < 0 ? r + P : r;
    }

    private static BigInteger Inverse(BigInteger value) => BigInteger.ModPow(Mod(value), P - 2, P);

    // ---- 点类型（扩展坐标 X:Y:Z:T，x = X/Z, y = Y/Z, x*y = T/Z） ----

    private readonly record struct Point(BigInteger X, BigInteger Y, BigInteger Z, BigInteger T);

    private static readonly Point Identity = new(BigInteger.Zero, BigInteger.One, BigInteger.One, BigInteger.Zero);

    /// <summary>点加法（RFC 8032 §5.1.4 的 add-2008-hwcd-3）。</summary>
    private static Point Add(Point p, Point q)
    {
        var a = Mod((p.Y - p.X) * (q.Y - q.X));
        var b = Mod((p.Y + p.X) * (q.Y + q.X));
        var c = Mod(p.T * D2 * q.T);
        var d = Mod(2 * p.Z * q.Z);
        var e = Mod(b - a);
        var f = Mod(d - c);
        var g = Mod(d + c);
        var h = Mod(b + a);
        return new Point(Mod(e * f), Mod(g * h), Mod(f * g), Mod(e * h));
    }

    /// <summary>点倍乘（RFC 8032 §5.1.4 的 dbl-2008-hwcd）。</summary>
    private static Point Double(Point p)
    {
        var a = Mod(p.X * p.X);
        var b = Mod(p.Y * p.Y);
        var c = Mod(2 * p.Z * p.Z);
        var h = Mod(a + b);
        var sum = Mod(p.X + p.Y);
        var e = Mod(h - sum * sum);
        var g = Mod(a - b);
        var f = Mod(c + g);
        return new Point(Mod(e * f), Mod(g * h), Mod(f * g), Mod(e * h));
    }

    /// <summary>标量乘（标量为非负 BigInteger，二进制双倍-相加；非恒定时间，配对场景可接受）。</summary>
    private static Point ScalarMult(Point p, BigInteger scalar)
    {
        var result = Identity;
        if (scalar.IsZero) return result;
        // 从最高位开始：等价于 256 位窗口；标量最大 2^256
        for (var i = (int)scalar.GetBitLength() - 1; i >= 0; i--)
        {
            result = Double(result);
            if (((scalar >> i) & BigInteger.One) == BigInteger.One)
            {
                result = Add(result, p);
            }
        }
        return result;
    }

    /// <summary>点压缩：32 字节 = little-endian(y) | (x&amp;1)&lt;&lt;255。</summary>
    private static byte[] Compress(Point p)
    {
        var zInv = Inverse(p.Z);
        var x = Mod(p.X * zInv);
        var y = Mod(p.Y * zInv);
        var output = new byte[PublicKeySize];
        ToLittleEndian32(y, output);
        output[31] |= (byte)((x & 1) << 7);
        return output;
    }

    /// <summary>点解压（RFC 8032 §5.1.3）。</summary>
    private static bool TryDecodePoint(ReadOnlySpan<byte> encoded, out Point point)
    {
        point = Identity;
        if (encoded.Length != PublicKeySize) return false;

        var copy = encoded.ToArray();
        var xSign = (copy[31] >> 7) & 1;
        copy[31] &= 0x7F;
        var y = FromLittleEndian(copy);
        if (y >= P) return false; // 非规范编码

        var y2 = Mod(y * y);
        var u = Mod(y2 - 1);              // y^2 - 1
        var v = Mod(D * y2 + 1);          // d*y^2 + 1
        if (v.IsZero) return false;

        var v3 = Mod(v * v * v);
        var v7 = Mod(v3 * v3 * v);
        var x = Mod(u * v3 * BigInteger.ModPow(Mod(u * v7), (P - 5) / 8, P));

        var check = Mod(v * x * x);
        if (check == Mod(P - u))
        {
            x = Mod(x * SqrtM1);
            check = Mod(v * x * x);
        }
        if (check != u) return false; // 无平方根

        if ((int)(x & 1) != xSign) x = Mod(P - x);
        if (x.IsZero && xSign == 1) return false; // 非规范：x=0 时符号位必须为 0

        point = new Point(x, y, BigInteger.One, Mod(x * y));
        return true;
    }

    // ---- little-endian 大整数转换 ----

    private static BigInteger FromLittleEndian(ReadOnlySpan<byte> bytes)
    {
        var be = new byte[bytes.Length];
        for (var i = 0; i < bytes.Length; i++) be[i] = bytes[bytes.Length - 1 - i];
        return CryptoPrimitives.FromBigEndian(be);
    }

    private static void ToLittleEndian32(BigInteger value, Span<byte> destination)
    {
        var be = CryptoPrimitives.ToBigEndianPadded(value, 32);
        for (var i = 0; i < 32; i++) destination[i] = be[31 - i];
    }
}

/// <summary>
/// Ed25519 密钥对：持有 32 字节种子（即私钥）与缓存的 32 字节公钥。
/// </summary>
public sealed class Ed25519KeyPair
{
    private readonly byte[] _seed;

    /// <summary>32 字节私钥种子。</summary>
    public byte[] Seed => (byte[])_seed.Clone();

    /// <summary>32 字节公钥。</summary>
    public byte[] PublicKey { get; }

    /// <summary>由种子构造。</summary>
    public Ed25519KeyPair(byte[] seed)
    {
        ArgumentNullException.ThrowIfNull(seed);
        if (seed.Length != Ed25519.SeedSize) throw new ArgumentException($"Ed25519 种子必须是 {Ed25519.SeedSize} 字节", nameof(seed));
        _seed = (byte[])seed.Clone();
        PublicKey = Ed25519.GetPublicKey(_seed);
    }

    /// <summary>签名（64 字节）。</summary>
    public byte[] Sign(ReadOnlySpan<byte> message) => Ed25519.Sign(_seed, message);

    /// <summary>导出 32 字节公钥的副本。</summary>
    public byte[] ExportPublicKey() => (byte[])PublicKey.Clone();
}
