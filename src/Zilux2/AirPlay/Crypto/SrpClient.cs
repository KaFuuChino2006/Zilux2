using System;
using System.Numerics;
using System.Security.Cryptography;

namespace Zilux2.AirPlay.Crypto;

/// <summary>SRP-6a 使用的两组参数/语义。</summary>
public enum SrpMode
{
    /// <summary>
    /// HAP（AirPlay 2 / HomeKit）配对：RFC 5054 3072 位组（g=5）、SHA-512、
    /// 用户名固定 "Pair-Setup"、密码是设备显示的 PIN（瞬态配对固定 "3939"）；
    /// 会话密钥 K = H(S)（64 字节），证明里直接使用 K 的原始字节（srptools 语义）。
    /// </summary>
    Hap,

    /// <summary>
    /// 旧式 Apple（AirPlay 1 的 binary plist pair-setup-pin，TuneBlade 走的路径）：
    /// RFC 5054 2048 位组（g=2）、SHA-1、用户名是 client id 的十六进制大写字符串；
    /// 会话密钥 K = H(S||0x00000000) || H(S||0x00000001)（40 字节，BouncyCastle 语义）。
    /// </summary>
    AppleLegacy,
}

/// <summary>
/// SRP-6a 客户端（AirPlay 配对用）。纯托管，零依赖，使用 <see cref="BigInteger"/> 做模幂。
///
/// 公式（与 srptools 0.2.0 / BouncyCastle 对齐，见 research/airplay/crypto/README.md）：
///   k = H(N | PAD(g))          （PAD 到 N 的字节长度）
///   x = H(s | H(I | ":" | P))  （I=用户名，P=密码/PIN）
///   A = g^a mod N,  u = H(PAD(A) | PAD(B))
///   S = (B - k*g^x)^(a + u*x) mod N
///   HAP:    K = H(S)（SHA-512，64 字节）
///   Legacy: K = H(S||00000000) || H(S||00000001)（SHA-1，40 字节）
///   M1 = H(H(N) xor H(g) | H(I) | s | A | B | K)   （A、B 用最小大端字节）
///   M2 = H(A | M1 | K)
///
/// 用法（HAP pair-setup）：
///   var srp = SrpClient.CreateHapPairSetup("3939");
///   // 设备 M2 → salt = TLV Salt，B = TLV PublicKey
///   var proof = srp.ComputeProof(salt, b);   // 放入 M3 的 TLV Proof
///   // 设备 M4 → srp.VerifyServerProof(tlvProof)
///   // srp.SessionKey（64B）即 HAP 后续 HKDF 的 SRP 会话密钥
/// </summary>
public sealed class SrpClient
{
    /// <summary>HAP pair-setup 的固定用户名。</summary>
    public const string HapUsername = "Pair-Setup";

    /// <summary>HAP 瞬态配对（transient pairing）的固定 PIN。</summary>
    public const string HapTransientPin = "3939";

    /// <summary>测试用：HAP pair-setup 使用的 RFC 5054 3072 位素数 N。</summary>
    internal static BigInteger HapPrime => N3072;

    /// <summary>测试用：HAP pair-setup 使用的生成元 g（5）。</summary>
    internal static BigInteger HapGenerator => G3072;

    private readonly BigInteger _n;
    private readonly BigInteger _g;
    private readonly HashAlgorithmName _hash;
    private readonly bool _useAppleLegacySessionKey;
    private readonly bool _useLegacyProofKeyEncoding;
    private readonly BigInteger _k;
    private readonly BigInteger _a;
    private readonly BigInteger _publicKeyValue; // A
    private readonly int _padLength;            // N 的字节长度

    private byte[] _salt = Array.Empty<byte>();
    private BigInteger _serverPublicKey;
    private byte[] _m1 = Array.Empty<byte>();
    private byte[] _sessionKey = Array.Empty<byte>();

    /// <summary>SRP 模式。</summary>
    public SrpMode Mode { get; }

    /// <summary>用户名（HAP 固定 "Pair-Setup"；Legacy 是 client id 的十六进制大写）。</summary>
    public string Username { get; }

    /// <summary>协议要求的 PAD 长度（N 的字节长度：HAP 384，Legacy 256）。</summary>
    public int PadLength => _padLength;

    /// <summary>客户端公钥 A 的大端（最小长度、无前导零）字节。</summary>
    public byte[] PublicKey => CryptoPrimitives.ToBigEndianUnsigned(_publicKeyValue);

    /// <summary>设备下发的 salt（调用 <see cref="ComputeProof"/> 后有效）。</summary>
    public byte[] Salt => (byte[])_salt.Clone();

    /// <summary>SRP 会话密钥 K 的字节（HAP 64B；Legacy 40B）。</summary>
    public byte[] SessionKey => (byte[])_sessionKey.Clone();

    /// <summary>客户端证明 M1（调用 <see cref="ComputeProof"/> 后有效）。</summary>
    public byte[] ClientProof => (byte[])_m1.Clone();

    /// <summary>按当前会话推导出的服务端证明 M2（用于自检/日志）。</summary>
    public byte[] ExpectedServerProof
    {
        get
        {
            EnsureProofComputed();
            return H(CryptoPrimitives.ToBigEndianUnsigned(_publicKeyValue), _m1, ProofKeyBytes());
        }
    }

    // ---------------- 构造 ----------------

    private SrpClient(SrpMode mode, string username, string password, BigInteger n, BigInteger g,
        HashAlgorithmName hash, bool useAppleLegacySessionKey, bool useLegacyProofKeyEncoding, BigInteger? fixedPrivateKey)
    {
        Mode = mode;
        Username = username;
        Password = password;
        _n = n;
        _g = g;
        _hash = hash;
        _useAppleLegacySessionKey = useAppleLegacySessionKey;
        _useLegacyProofKeyEncoding = useLegacyProofKeyEncoding;

        _padLength = CryptoPrimitives.ToBigEndianUnsigned(n).Length;
        _k = ComputeMultiplier(n, g, hash, _padLength);

        // 私钥 a：HAP/旧式实现一般用 256 位随机数；测试可注入固定值复现 RFC 5054 向量
        if (fixedPrivateKey is { } fixedA)
        {
            _a = fixedA;
        }
        else
        {
            _a = CryptoPrimitives.FromBigEndian(CryptoPrimitives.RandomBytes(32)); // 256 bit
            if (_a.IsZero) _a = BigInteger.One;
        }
        _publicKeyValue = BigInteger.ModPow(_g, _a, _n);
    }

    /// <summary>创建 HAP pair-setup 客户端（用户名 "Pair-Setup"，密码 = PIN）。</summary>
    public static SrpClient CreateHapPairSetup(string pin) => CreateHapPairSetupInternal(pin, fixedPrivateKey: null);

    /// <summary>测试用：注入固定私钥 a 以复现测试向量。</summary>
    internal static SrpClient CreateHapPairSetup(string pin, ReadOnlySpan<byte> fixedPrivateKey)
        => CreateHapPairSetupInternal(pin, CryptoPrimitives.FromBigEndian(fixedPrivateKey));

    private static SrpClient CreateHapPairSetupInternal(string pin, BigInteger? fixedPrivateKey)
    {
        ArgumentException.ThrowIfNullOrEmpty(pin);
        return new SrpClient(SrpMode.Hap, HapUsername, pin, N3072, G3072, HashAlgorithmName.SHA512,
            useAppleLegacySessionKey: false, useLegacyProofKeyEncoding: false, fixedPrivateKey);
    }

    /// <summary>创建旧式 Apple 配对客户端（用户名 = client id 十六进制大写，SHA-1/2048 位）。</summary>
    public static SrpClient CreateAppleLegacy(string clientIdHexUppercase, string pin)
        => CreateAppleLegacyInternal(clientIdHexUppercase, pin, fixedPrivateKey: null);

    /// <summary>测试用：注入固定私钥 a。</summary>
    internal static SrpClient CreateAppleLegacy(string clientIdHexUppercase, string pin, ReadOnlySpan<byte> fixedPrivateKey)
        => CreateAppleLegacyInternal(clientIdHexUppercase, pin, CryptoPrimitives.FromBigEndian(fixedPrivateKey));

    private static SrpClient CreateAppleLegacyInternal(string clientId, string pin, BigInteger? fixedPrivateKey)
    {
        ArgumentException.ThrowIfNullOrEmpty(clientId);
        ArgumentException.ThrowIfNullOrEmpty(pin);
        return new SrpClient(SrpMode.AppleLegacy, clientId, pin, N2048, G2048, HashAlgorithmName.SHA1,
            useAppleLegacySessionKey: true, useLegacyProofKeyEncoding: true, fixedPrivateKey);
    }

    /// <summary>测试用：任意组参数（例如跑 RFC 5054 1024 位测试向量）。</summary>
    internal static SrpClient CreateCustom(string username, string password, BigInteger n, BigInteger g,
        HashAlgorithmName hash, bool appleLegacySessionKey, ReadOnlySpan<byte> fixedPrivateKey)
    {
        return new SrpClient(SrpMode.AppleLegacy, username, password, n, g, hash,
            useAppleLegacySessionKey: appleLegacySessionKey,
            useLegacyProofKeyEncoding: appleLegacySessionKey,
            fixedPrivateKey: CryptoPrimitives.FromBigEndian(fixedPrivateKey));
    }

    // ---------------- 协议流程 ----------------

    /// <summary>
    /// 收到设备 M2（salt + 设备公钥 B）后计算客户端证明 M1。
    /// 调用后 <see cref="SessionKey"/>、<see cref="ClientProof"/> 有效。
    /// </summary>
    /// <returns>客户端证明 M1（放入 M3 的 TLV Proof）。</returns>
    public byte[] ComputeProof(ReadOnlySpan<byte> salt, ReadOnlySpan<byte> serverPublicKey)
    {
        if (salt.Length == 0) throw new ArgumentException("salt 不能为空", nameof(salt));
        if (serverPublicKey.Length == 0) throw new ArgumentException("服务器公钥不能为空", nameof(serverPublicKey));
        if (serverPublicKey.Length > PadLength + 1)
            throw new ArgumentException($"服务器公钥过长：{serverPublicKey.Length} 字节", nameof(serverPublicKey));

        _salt = salt.ToArray();
        _serverPublicKey = CryptoPrimitives.FromBigEndian(serverPublicKey);
        if (_serverPublicKey.IsZero || _serverPublicKey % _n == BigInteger.Zero)
        {
            // SRP 规范要求 B % N != 0，否则是恶意/错误输入
            throw new CryptographicException("SRP：设备公钥 B 非法（B mod N == 0）");
        }

        // x = H(s | H(I ":" P))；u = H(PAD(A) | PAD(B))
        var x = ComputeX(_salt, Username, Password, _hash);
        var u = ComputeU(_publicKeyValue, _serverPublicKey, _padLength, _hash);

        // S = (B - k*g^x)^(a + u*x) mod N
        var gx = BigInteger.ModPow(_g, x, _n);
        var baseValue = Mod(_serverPublicKey - _k * gx, _n);
        var premaster = BigInteger.ModPow(baseValue, _a + u * x, _n);
        PremasterSecret = premaster;

        var sBytes = CryptoPrimitives.ToBigEndianUnsigned(premaster);
        if (_useAppleLegacySessionKey)
        {
            // TuneBlade / BouncyCastle：K = H(S||0x00000000) || H(S||0x00000001)
            var k0 = H(sBytes, new byte[] { 0x00, 0x00, 0x00, 0x00 });
            var k1 = H(sBytes, new byte[] { 0x00, 0x00, 0x00, 0x01 });
            _sessionKey = CryptoPrimitives.Concat(k0, k1);
        }
        else
        {
            // HAP / srptools：K = H(S)
            _sessionKey = H(sBytes);
        }

        // M1 = H( H(N) xor H(g) | H(I) | s | A | B | K )
        var hn = H(CryptoPrimitives.ToBigEndianUnsigned(_n));
        var hg = H(CryptoPrimitives.ToBigEndianUnsigned(_g));
        var xorBytes = IntToBytes(CryptoPrimitives.FromBigEndian(hn) ^ CryptoPrimitives.FromBigEndian(hg));

        _m1 = H(
            xorBytes,
            H(CryptoPrimitives.Utf8(Username)),
            _salt,
            CryptoPrimitives.ToBigEndianUnsigned(_publicKeyValue),   // A 最小字节
            CryptoPrimitives.ToBigEndianUnsigned(_serverPublicKey), // B 最小字节
            ProofKeyBytes());

        return (byte[])_m1.Clone();
    }

    /// <summary>校验设备 M4 返回的服务端证明 M2 = H(A | M1 | K)。</summary>
    public bool VerifyServerProof(ReadOnlySpan<byte> serverProof)
    {
        EnsureProofComputed();
        return CryptoPrimitives.FixedTimeEquals(ExpectedServerProof, serverProof);
    }

    // ---------------- 测试/调试可见的中间值 ----------------

    /// <summary>测试用：注入的私钥 a 对应的公钥 A（BigInteger）。</summary>
    internal BigInteger PublicKeyValue => _publicKeyValue;

    /// <summary>测试用：计算得到的预主密钥 S（mod N）。</summary>
    internal BigInteger PremasterSecret { get; private set; }

    // ---------------- 内部工具（internal 供 harness 独立复算） ----------------

    /// <summary>k = H(N | PAD(g))。</summary>
    internal static BigInteger ComputeMultiplier(BigInteger n, BigInteger g, HashAlgorithmName hash, int padLength)
    {
        var nBytes = CryptoPrimitives.ToBigEndianUnsigned(n);
        var gPadded = CryptoPrimitives.ToBigEndianPadded(g, padLength);
        return CryptoPrimitives.FromBigEndian(CryptoPrimitives.Hash(hash, nBytes, gPadded));
    }

    /// <summary>x = H(s | H(I | ":" | P))。</summary>
    internal static BigInteger ComputeX(ReadOnlySpan<byte> salt, string username, string password, HashAlgorithmName hash)
    {
        var inner = CryptoPrimitives.Hash(hash, CryptoPrimitives.Utf8(username), new byte[] { (byte)':' }, CryptoPrimitives.Utf8(password));
        return CryptoPrimitives.FromBigEndian(CryptoPrimitives.Hash(hash, salt.ToArray(), inner));
    }

    /// <summary>u = H(PAD(A) | PAD(B))。</summary>
    internal static BigInteger ComputeU(BigInteger a, BigInteger b, int padLength, HashAlgorithmName hash)
    {
        return CryptoPrimitives.FromBigEndian(CryptoPrimitives.Hash(hash,
            CryptoPrimitives.ToBigEndianPadded(a, padLength),
            CryptoPrimitives.ToBigEndianPadded(b, padLength)));
    }

    // ---------------- 私有辅助 ----------------

    private string Password { get; }

    private void EnsureProofComputed()
    {
        if (_m1.Length == 0) throw new InvalidOperationException("尚未调用 ComputeProof（需要先收到设备 M2）");
    }

    /// <summary>证明里使用的 K 字节：HAP 用原始 K；旧式用 K 转 BigInteger 后的最小字节（BouncyCastle 语义）。</summary>
    private byte[] ProofKeyBytes()
    {
        if (!_useLegacyProofKeyEncoding) return _sessionKey;
        return CryptoPrimitives.ToBigEndianUnsigned(CryptoPrimitives.FromBigEndian(_sessionKey));
    }

    /// <summary>按当前 SRP 模式使用的哈希算法计算 H(parts...)。</summary>
    private byte[] H(params byte[][] parts) => CryptoPrimitives.Hash(_hash, parts);

    /// <summary>整数转大端字节（0 → 单字节 0，对齐 srptools 的 int_to_bytes）。</summary>
    private static byte[] IntToBytes(BigInteger value)
    {
        if (value.Sign < 0) throw new ArgumentOutOfRangeException(nameof(value));
        return value.IsZero ? new byte[] { 0 } : CryptoPrimitives.ToBigEndianUnsigned(value);
    }

    private static BigInteger Mod(BigInteger value, BigInteger modulus)
    {
        var r = value % modulus;
        return r.Sign < 0 ? r + modulus : r;
    }

    // ---------------- RFC 5054 组参数 ----------------

    // RFC 5054 Appendix A：3072-bit 组，g = 5（HAP 使用）
    private static readonly BigInteger N3072 = CryptoPrimitives.FromBigEndian(Convert.FromHexString(
        "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6" +
        "DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE" +
        "45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804" +
        "F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D226" +
        "1898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB09" +
        "33D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E" +
        "24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF"));

    private static readonly BigInteger G3072 = new(5);

    // RFC 5054 Appendix A：2048-bit 组，g = 2（旧式 Apple SRP 使用）
    private static readonly BigInteger N2048 = CryptoPrimitives.FromBigEndian(Convert.FromHexString(
        "AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F4" +
        "8A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF747359D041D5" +
        "C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECF" +
        "A032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE" +
        "236D525F54759B65E372FCD68EF20FA7111F9E4AFF73"));

    private static readonly BigInteger G2048 = new(2);
}
