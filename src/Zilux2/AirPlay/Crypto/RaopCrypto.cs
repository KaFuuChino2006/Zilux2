using System;
using System.Buffers.Binary;
using System.Security.Cryptography;

namespace Zilux2.AirPlay.Crypto;

/// <summary>
/// 经典 RAOP（AirPlay 1）的加密辅助：ANNOUNCE 里的 Apple-Challenge / rsaaeskey / aesiv，
/// 以及音频 RTP 包负载的 AES-128-CBC 加密。
///
/// 协议事实来源（本仓库内可查）：
///   - research/airplay/_ref/shairport-src/player.c:1588-1615 —— 解密侧：只处理 len &amp; ~0xF 字节，
///     每包重新用同一个 aesiv 初始化 CBC，尾部不足 16 字节的部分保持明文；
///   - research/airplay/_ref/shairport-src/rtsp.c:3648-3703（apple_challenge）与 common.c（rsa_apply）——
///     ANNOUNCE 的 Apple-Challenge 是 16 字节随机数（base64 去 '=' 填充）；
///   - research/airplay/_ref/shairport-src/common.c:809-885 —— rsaaeskey 用 RSA PKCS#1 **OAEP-SHA1** 解开；
///   - research/airplay/tuneblade-decomp/Tuneblade/AudioSource.cs:760-780 与 processPCMAndEnqueue ——
///     TuneBlade 的固定 AES key/IV 与逐包 AES-CBC 加密方式。
///
/// 已做的实际验证（证据见 research/airplay/crypto/README.md）：
///   用 shairport-sync 内嵌的 AirPort Express RSA 私钥（仅一次性用于验证，不进入产品代码）
///   对 TuneBlade 硬编码的 RSAAES_Str 做 OAEP-SHA1 解密，得到
///   0BA0D6B09206D214F8D59AF09FABBB15，与 TuneBlade 固定 AES key 逐字节相等；
///   OAEP-SHA256 与 PKCS#1 v1.5 均解密失败 —— 证明经典 RAOP 的 rsaaeskey 就是 RSA-OAEP(SHA-1)。
///
/// 注意：整个类不持有连接、不写网络；Lead 的 RaopClient 直接调用即可。
/// 需要新增 NuGet 依赖时请先与 Lead 确认——本文件只用 .NET 10 BCL（System.Security.Cryptography）。
/// </summary>
public static class RaopCrypto
{
    /// <summary>AES-128 密钥长度（RAOP 音频固定 16 字节）。</summary>
    public const int AesKeySize = 16;

    /// <summary>AES-CBC 初始向量长度。</summary>
    public const int AesIvSize = 16;

    /// <summary>Apple-Challenge 随机数长度（16 字节）。</summary>
    public const int AppleChallengeSize = 16;

    /// <summary>shairport-sync 模拟 AirPort Express 时参与 Apple-Response 签名的 6 字节前缀长度。</summary>
    public const int Ap1PrefixSize = 6;

    /// <summary>AES-CBC 块大小。</summary>
    public const int AesBlockSize = 16;

    /// <summary>
    /// AirPort Express（AirPlay 1，et=1）的 2048 位 RSA 公钥模数（十六进制）。
    /// 该模数由 shairport-sync 源码内嵌的 AirPort Express 私钥导出（私钥不进入本仓库），
    /// 公钥本身是公开的协议参数；TuneBlade 用同一把公钥预计算了固定的 rsaaeskey。
    /// </summary>
    private const string AirPortExpressModulusHex =
        "E7D744F2A2E2788B6C1F55A08EB70544A8FA7945AA8BE6C62CE5F51CBDD4DC6842FE3D1083DD2EDEC1BFD4252DC0" +
        "2E6F398BDF0E6148EA84855E2E442DA6D62664F674A1F304929ADE4F6893EF2DF6E711A8C77A0D91C9D980822E5" +
        "0D12922AFEA40EA9F0E14C0F76938C5F3882FC0323DD9FE55155F51BB5921C201629FD73352D5E2EFAABF9BA048D" +
        "7B813A2B6767F6C3CCF1EB4CE673D037B0D2EA30C5FFFEB06F8D08ADDE409571A9C689FEF10728855DD8CFB9A8BE" +
        "F5C8943EF3B5FAA15DDE698BEDDF3599603EB3E6F61372BB628F6559F599A78BF500687AA7F4976C0562D412956F" +
        "8989E18A6355BD81597825E0FC875343EC782117625CDBF98447B";

    /// <summary>AirPort Express RSA 公钥指数（65537）。</summary>
    private static readonly byte[] AirPortExpressExponent = { 0x01, 0x00, 0x01 };

    // ---------------- 随机材料 ----------------

    /// <summary>生成 16 字节随机 AES-128 音频密钥（对应 SDP 的 a=rsaaeskey 明文）。</summary>
    public static byte[] GenerateAesKey() => CryptoPrimitives.RandomBytes(AesKeySize);

    /// <summary>生成 16 字节随机 AES-CBC 初始向量（对应 SDP 的 a=aesiv）。</summary>
    public static byte[] GenerateAesIv() => CryptoPrimitives.RandomBytes(AesIvSize);

    /// <summary>生成 16 字节 Apple-Challenge 随机数。</summary>
    public static byte[] GenerateAppleChallenge() => CryptoPrimitives.RandomBytes(AppleChallengeSize);

    /// <summary>把 Apple-Challenge 编码成请求头取值：base64 去掉 '=' 填充（AirPlay 约定）。</summary>
    public static string AppleChallengeHeader(ReadOnlySpan<byte> challenge) =>
        CryptoPrimitives.Base64NoPadding(challenge);

    /// <summary>生成可直接放进 OPTIONS/ANNOUNCE 的 Apple-Challenge 请求头值（16B 随机 + base64 去填充）。</summary>
    public static string GenerateAppleChallengeHeader() => AppleChallengeHeader(GenerateAppleChallenge());

    // ---------------- RSA：设备公钥 / rsaaeskey ----------------

    /// <summary>
    /// 构造 AirPort Express（经典 RAOP et=1）的 RSA 公钥。用于没有拿到设备 pk 文本、
    /// 但目标明确是老 AirPort Express 的兼容场景。
    /// </summary>
    public static RSA CreateAirPortExpressPublicKey()
    {
        var rsa = RSA.Create();
        try
        {
            rsa.ImportParameters(new RSAParameters
            {
                Modulus = CryptoPrimitives.ParseHex(AirPortExpressModulusHex),
                Exponent = AirPortExpressExponent,
            });
            return rsa;
        }
        catch
        {
            rsa.Dispose();
            throw;
        }
    }

    /// <summary>
    /// 解析 mDNS TXT 记录里的 <c>pk</c> 字段为 RSA 公钥。
    /// 兼容三类取值：
    ///   1) 64 个十六进制字符 —— AirPlay 2 / HomeKit 的 Ed25519 长期公钥，不是 RSA，返回 null；
    ///   2) base64 DER —— 先按 SubjectPublicKeyInfo（SPKI）导入，失败再按 PKCS#1 RSAPublicKey 导入；
    ///   3) PEM 文本（以 -----BEGIN 开头）—— 直接 ImportFromPem。
    /// 解析不出 RSA 公钥时返回 null（调用方回退到 AirPort Express 公钥或放弃加密）。
    /// </summary>
    public static RSA? TryParseDevicePublicKey(string? pkTxt)
    {
        if (string.IsNullOrWhiteSpace(pkTxt)) return null;
        var pk = pkTxt.Trim();

        // AirPlay 2 的 pk 是 Ed25519 公钥的 64 位 hex，非 RSA，交给 HAP 通道处理
        if (pk.Length == Ed25519.PublicKeySize * 2 && IsHex(pk)) return null;

        var rsa = RSA.Create();
        try
        {
            if (pk.Contains("-----BEGIN", StringComparison.Ordinal))
            {
                rsa.ImportFromPem(pk);
                return rsa;
            }

            var der = CryptoPrimitives.Base64DecodeLenient(pk);
            try
            {
                rsa.ImportSubjectPublicKeyInfo(der, out _);
                return rsa;
            }
            catch (CryptographicException)
            {
                // 继续尝试 PKCS#1
            }

            rsa.ImportRSAPublicKey(der, out _);
            return rsa;
        }
        catch (Exception ex) when (ex is CryptographicException or FormatException or ArgumentException)
        {
            rsa.Dispose();
            return null;
        }
    }

    /// <summary>
    /// 用设备 RSA 公钥把 16 字节 AES 密钥包成 ANNOUNCE SDP 里的 <c>a=rsaaeskey</c> 取值：
    /// RSA-OAEP(SHA-1) 加密后 base64 去 '=' 填充（与 shairport-sync / iTunes 一致）。
    /// </summary>
    /// <param name="aesKey">16 字节音频 AES 密钥。</param>
    /// <param name="devicePkTxt">设备 mDNS TXT 的 pk 文本；为空/无法解析时回退到 AirPort Express 公钥。</param>
    public static string WrapRsaaesKeyBase64(ReadOnlySpan<byte> aesKey, string? devicePkTxt = null)
    {
        if (aesKey.Length != AesKeySize)
            throw new ArgumentException($"AES 密钥必须是 {AesKeySize} 字节，实际 {aesKey.Length} 字节", nameof(aesKey));

        using var rsa = TryParseDevicePublicKey(devicePkTxt) ?? CreateAirPortExpressPublicKey();
        var wrapped = rsa.Encrypt(aesKey.ToArray(), RSAEncryptionPadding.OaepSHA1);
        return CryptoPrimitives.Base64NoPadding(wrapped);
    }

    // ---------------- 音频负载 AES-128-CBC ----------------

    /// <summary>
    /// 原地加密一个 RAOP 音频包里的负载（经典 RAOP：et=0/1）。
    /// 规则与 shairport-sync 解密侧（player.c:1588-1615）严格对称：
    ///   - 只加密从 <paramref name="payloadOffset"/> 起、长度为 16 的整数倍的前段；
    ///   - 尾部不足 16 字节的部分保持明文（TuneBlade 同样如此）；
    ///   - 每个包都用同一份 IV 重新开始 CBC（不是链式延续！）。
    /// </summary>
    /// <param name="packet">完整 RTP/RAOP 包缓冲（原地修改）。</param>
    /// <param name="payloadOffset">负载起始偏移（TuneBlade：4 字节重传头 + 12 字节 RTP 头 = 16）。</param>
    /// <param name="payloadLength">负载长度（ALAC 压缩帧字节数）。</param>
    /// <param name="key">16 字节 AES 密钥。</param>
    /// <param name="iv">16 字节 IV。</param>
    /// <returns>实际被加密的字节数（16 的整数倍）。</returns>
    public static int EncryptAudioPayloadInPlace(Span<byte> packet, int payloadOffset, int payloadLength,
        ReadOnlySpan<byte> key, ReadOnlySpan<byte> iv)
    {
        if (key.Length != AesKeySize) throw new ArgumentException($"AES 密钥必须是 {AesKeySize} 字节", nameof(key));
        if (iv.Length != AesIvSize) throw new ArgumentException($"AES IV 必须是 {AesIvSize} 字节", nameof(iv));
        if (payloadOffset < 0 || payloadLength < 0 || payloadOffset + payloadLength > packet.Length)
            throw new ArgumentOutOfRangeException(nameof(payloadLength), "负载范围超出包缓冲");

        var blocks = payloadLength & ~(AesBlockSize - 1);
        if (blocks == 0) return 0;

        using var aes = Aes.Create();
        aes.Key = key.ToArray();
        // PaddingMode.None 要求输入长度是块大小整数倍，由上面的 & ~0xF 保证
        var cipher = aes.EncryptCbc(packet.Slice(payloadOffset, blocks).ToArray(), iv.ToArray(), PaddingMode.None);
        cipher.CopyTo(packet.Slice(payloadOffset, blocks));
        return blocks;
    }

    /// <summary>返回一份加密后的新负载（不修改输入），便于测试/非原地场景。</summary>
    public static byte[] EncryptAudioPayload(ReadOnlySpan<byte> payload, ReadOnlySpan<byte> key, ReadOnlySpan<byte> iv)
    {
        var result = payload.ToArray();
        EncryptAudioPayloadInPlace(result, 0, result.Length, key, iv);
        return result;
    }

    /// <summary>解密一个负载的前 16 整数倍字节（客户端一般用不到，供审计/回放工具使用）。</summary>
    public static int DecryptAudioPayloadInPlace(Span<byte> packet, int payloadOffset, int payloadLength,
        ReadOnlySpan<byte> key, ReadOnlySpan<byte> iv)
    {
        if (key.Length != AesKeySize) throw new ArgumentException($"AES 密钥必须是 {AesKeySize} 字节", nameof(key));
        if (iv.Length != AesIvSize) throw new ArgumentException($"AES IV 必须是 {AesIvSize} 字节", nameof(iv));
        if (payloadOffset < 0 || payloadLength < 0 || payloadOffset + payloadLength > packet.Length)
            throw new ArgumentOutOfRangeException(nameof(payloadLength), "负载范围超出包缓冲");

        var blocks = payloadLength & ~(AesBlockSize - 1);
        if (blocks == 0) return 0;

        using var aes = Aes.Create();
        aes.Key = key.ToArray();
        var plain = aes.DecryptCbc(packet.Slice(payloadOffset, blocks).ToArray(), iv.ToArray(), PaddingMode.None);
        plain.CopyTo(packet.Slice(payloadOffset, blocks));
        return blocks;
    }

    // ---------------- Apple-Challenge 响应校验（可选） ----------------

    /// <summary>
    /// 校验设备返回的 Apple-Response（RSA PKCS#1 v1.5 + SHA-1 签名）。
    ///
    /// 签名原文 = Apple-Challenge || 客户端 IP（IPv4 4 字节 / IPv6 16 字节）|| ap1 前缀（6 字节）。
    /// 其中 ap1 前缀在 shairport-sync 里由设备标识派生，普通客户端通常拿不到；
    /// TuneBlade 干脆完全跳过校验。因此本方法主要供“已知前缀”的调试/验证场景使用，
    /// 生产路径可以只记录响应存在、不强制校验。
    /// </summary>
    /// <returns>验签通过返回 true；响应格式非法或公钥为空时返回 false。</returns>
    public static bool VerifyAppleResponse(ReadOnlySpan<byte> challenge, string? appleResponseBase64,
        RSA? devicePublicKey, ReadOnlySpan<byte> clientIpAddress, ReadOnlySpan<byte> ap1Prefix)
    {
        if (devicePublicKey is null || string.IsNullOrWhiteSpace(appleResponseBase64)) return false;
        if (clientIpAddress.Length is not (4 or 16)) return false;
        if (ap1Prefix.Length != Ap1PrefixSize) return false;

        byte[] signature;
        try
        {
            signature = CryptoPrimitives.Base64DecodeLenient(appleResponseBase64);
        }
        catch (FormatException)
        {
            return false;
        }

        var signed = CryptoPrimitives.Concat(challenge, clientIpAddress, ap1Prefix);
        return devicePublicKey.VerifyData(signed, signature, HashAlgorithmName.SHA1, RSASignaturePadding.Pkcs1);
    }

    /// <summary>测试/调试用：用 RSA 私钥生成 Apple-Response（模拟设备侧签名），base64 去填充。</summary>
    public static string ComputeAppleResponse(ReadOnlySpan<byte> challenge, RSA privateKey,
        ReadOnlySpan<byte> clientIpAddress, ReadOnlySpan<byte> ap1Prefix)
    {
        var signed = CryptoPrimitives.Concat(challenge, clientIpAddress, ap1Prefix);
        var signature = privateKey.SignData(signed, HashAlgorithmName.SHA1, RSASignaturePadding.Pkcs1);
        return CryptoPrimitives.Base64NoPadding(signature);
    }

    // ---------------- 一次生成整套加密参数 ----------------

    /// <summary>
    /// 为一个经典 RAOP 会话生成整套加密参数（随机 AES key/IV + 已包装的 rsaaeskey）。
    /// 返回对象可直接用于 SDP 拼接与逐包加密。
    /// </summary>
    public static RaopEncryptionInfo CreateEncryptionInfo(string? devicePkTxt = null) =>
        new(GenerateAesKey(), GenerateAesIv(), devicePkTxt);

    private static bool IsHex(ReadOnlySpan<char> text)
    {
        foreach (var c in text)
        {
            var isHex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
            if (!isHex) return false;
        }
        return true;
    }
}

/// <summary>
/// 经典 RAOP 一个会话的加密参数集合：AES key/IV 明文 + 已包装的 SDP 取值。
/// 不可变；<see cref="AesKey"/>/<see cref="AesIv"/> 返回副本，避免调用方误改。
/// </summary>
public sealed class RaopEncryptionInfo
{
    private readonly byte[] _aesKey;
    private readonly byte[] _aesIv;

    /// <summary>生成一套新的随机参数。</summary>
    /// <param name="devicePkTxt">设备 mDNS TXT 的 pk 文本；为空时使用 AirPort Express 公钥。</param>
    public RaopEncryptionInfo(string? devicePkTxt = null)
        : this(RaopCrypto.GenerateAesKey(), RaopCrypto.GenerateAesIv(), devicePkTxt)
    {
    }

    /// <summary>用指定的 key/IV 构造（测试或复用 TuneBlade 式固定密钥时使用）。</summary>
    public RaopEncryptionInfo(byte[] aesKey, byte[] aesIv, string? devicePkTxt = null)
    {
        ArgumentNullException.ThrowIfNull(aesKey);
        ArgumentNullException.ThrowIfNull(aesIv);
        if (aesKey.Length != RaopCrypto.AesKeySize) throw new ArgumentException("AES 密钥必须是 16 字节", nameof(aesKey));
        if (aesIv.Length != RaopCrypto.AesIvSize) throw new ArgumentException("AES IV 必须是 16 字节", nameof(aesIv));

        _aesKey = (byte[])aesKey.Clone();
        _aesIv = (byte[])aesIv.Clone();
        RsaaesKeyBase64 = RaopCrypto.WrapRsaaesKeyBase64(_aesKey, devicePkTxt);
    }

    /// <summary>16 字节 AES-128 密钥（副本）。</summary>
    public byte[] AesKey => (byte[])_aesKey.Clone();

    /// <summary>16 字节 AES-CBC IV（副本）。</summary>
    public byte[] AesIv => (byte[])_aesIv.Clone();

    /// <summary>ANNOUNCE SDP 的 <c>a=rsaaeskey</c> 取值（RSA-OAEP-SHA1，base64 去填充）。</summary>
    public string RsaaesKeyBase64 { get; }

    /// <summary>ANNOUNCE SDP 的 <c>a=aesiv</c> 取值（base64 去填充）。</summary>
    public string AesIvBase64 => CryptoPrimitives.Base64NoPadding(_aesIv);

    /// <summary>可直接追加到 SDP 文本末尾的两行（含 CRLF）。</summary>
    public string SdpEncryptionAttributes =>
        $"a=rsaaeskey:{RsaaesKeyBase64}\r\na=aesiv:{AesIvBase64}\r\n";

    /// <summary>原地加密单个音频包的负载（见 <see cref="RaopCrypto.EncryptAudioPayloadInPlace"/>）。</summary>
    public int EncryptAudioPacketInPlace(Span<byte> packet, int payloadOffset, int payloadLength) =>
        RaopCrypto.EncryptAudioPayloadInPlace(packet, payloadOffset, payloadLength, _aesKey, _aesIv);
}
