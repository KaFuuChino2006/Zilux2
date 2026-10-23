using System;
using System.Numerics;

namespace Zilux2.AirPlay.Crypto;

/// <summary>
/// 纯托管 X25519（Curve25519 上的 ECDH，RFC 7748）。
/// <para>
/// .NET 10 的 <c>System.Security.Cryptography</c> 仍未公开 X25519/Ed25519 类型，
/// 而 HAP pair-verify / legacy pair-verify 都需要 X25519，所以这里自己实现。
/// 算法实现用 <see cref="BigInteger"/> 直接做模 2^255-19 运算（配对只用几次，性能不是瓶颈；
/// 本文件已在 harness 里通过 RFC 7748 §5.2 官方测试向量与 §5.2 两步 DH 向量验证）。
/// </para>
/// </summary>
public static class X25519
{
    /// <summary>私钥/公钥/共享密钥长度（字节）。</summary>
    public const int KeySize = 32;

    // p = 2^255 - 19
    private static readonly BigInteger P = (BigInteger.One << 255) - 19;

    // RFC 7748 里 Montgomery 梯子的常数 a24 = (486662 - 2) / 4 = 121665
    private static readonly BigInteger A24 = 121665;

    // 基点 u = 9
    private static readonly byte[] BasePointU = new byte[32] { 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };

    /// <summary>生成一对 X25519 密钥（私钥为 32 字节随机数，公钥为对 9 做标量乘的结果）。</summary>
    public static (byte[] PrivateKey, byte[] PublicKey) GenerateKeyPair()
    {
        var privateKey = CryptoPrimitives.RandomBytes(KeySize);
        var publicKey = GetPublicKey(privateKey);
        return (privateKey, publicKey);
    }

    /// <summary>由私钥导出公钥：X25519(clamp(private), 9)。</summary>
    public static byte[] GetPublicKey(ReadOnlySpan<byte> privateKey)
    {
        if (privateKey.Length != KeySize) throw new ArgumentException("X25519 私钥必须是 32 字节", nameof(privateKey));
        return ScalarMult(privateKey, BasePointU);
    }

    /// <summary>
    /// X25519 标量乘法：返回 u 坐标 = X25519(scalar, u)。
    /// 输入 32 字节小端，输出 32 字节小端；标量按 RFC 7748 做 clamp。
    /// </summary>
    public static byte[] ScalarMult(ReadOnlySpan<byte> scalar, ReadOnlySpan<byte> uCoordinate)
    {
        if (scalar.Length != KeySize) throw new ArgumentException("X25519 标量必须是 32 字节", nameof(scalar));
        if (uCoordinate.Length != KeySize) throw new ArgumentException("X25519 u 坐标必须是 32 字节", nameof(uCoordinate));

        var k = DecodeScalar(scalar);
        var x1 = DecodeU(uCoordinate);

        BigInteger x2 = 1, z2 = 0, x3 = x1, z3 = 1;
        int swap = 0;

        for (int t = 254; t >= 0; t--)
        {
            int kt = (int)((k >> t) & 1);
            swap ^= kt;
            if (swap != 0)
            {
                (x2, x3) = (x3, x2);
                (z2, z3) = (z3, z2);
            }
            swap = kt;

            var a = Mod(x2 + z2);
            var aa = Mod(a * a);
            var b = Mod(x2 - z2);
            var bb = Mod(b * b);
            var e = Mod(aa - bb);
            var c = Mod(x3 + z3);
            var d = Mod(x3 - z3);
            var da = Mod(d * a);
            var cb = Mod(c * b);
            x3 = Mod((da + cb) * (da + cb));
            z3 = Mod(x1 * Mod((da - cb) * (da - cb)));
            x2 = Mod(aa * bb);
            z2 = Mod(e * Mod(aa + Mod(A24 * e)));
        }

        if (swap != 0)
        {
            (x2, x3) = (x3, x2);
            (z2, z3) = (z3, z2);
        }

        var result = Mod(x2 * BigInteger.ModPow(z2, P - 2, P));
        return EncodeU(result);
    }

    /// <summary>计算共享密钥：X25519(ownPrivate, peerPublic)。</summary>
    public static byte[] ComputeSharedSecret(ReadOnlySpan<byte> ownPrivateKey, ReadOnlySpan<byte> peerPublicKey)
        => ScalarMult(ownPrivateKey, peerPublicKey);

    /// <summary>RFC 7748 decodeScalar25519：清低 3 位、清最高位、置次高位。</summary>
    private static BigInteger DecodeScalar(ReadOnlySpan<byte> input)
    {
        Span<byte> e = stackalloc byte[32];
        input.CopyTo(e);
        e[0] &= 248;
        e[31] &= 127;
        e[31] |= 64;
        return new BigInteger(e, isUnsigned: true, isBigEndian: false);
    }

    /// <summary>RFC 7748 decodeUCoordinate：最高位忽略（这里额外兼容部分实现把 255 位当符号位的情况）。</summary>
    private static BigInteger DecodeU(ReadOnlySpan<byte> input)
    {
        Span<byte> u = stackalloc byte[32];
        input.CopyTo(u);
        u[31] &= 0x7F;
        return new BigInteger(u, isUnsigned: true, isBigEndian: false);
    }

    private static byte[] EncodeU(BigInteger value)
    {
        var bytes = new byte[32];
        var raw = value.ToByteArray(isUnsigned: true, isBigEndian: false);
        raw.AsSpan(0, Math.Min(raw.Length, 32)).CopyTo(bytes);
        return bytes;
    }

    /// <summary>模 p 归一（BigInteger 的 % 可能返回负数）。</summary>
    private static BigInteger Mod(BigInteger value)
    {
        var r = value % P;
        return r.Sign < 0 ? r + P : r;
    }
}
