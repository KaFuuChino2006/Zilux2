using System;
using System.Buffers.Binary;
using System.IO;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using Zilux2.AirPlay.Crypto;

namespace AirPlayCryptoHarness;

/// <summary>
/// 协议层测试向量：TLV8、SRP-6a（RFC 5054 + HAP 自洽 + 真机 KAT）、HKDF-SHA512、
/// ChaCha20-Poly1305（RFC 8439）、HAP 加密帧、AES-128-CBC（NIST SP 800-38A）、
/// 经典 RAOP 的 RSA-OAEP-SHA1 / Apple-Challenge / 音频分包加密。
/// </summary>
public static class Tests_Crypto
{
    // ---------------- RFC / 规范常量 ----------------

    /// <summary>RFC 5054 Appendix A：1024 位组素数（g=2）。</summary>
    private const string N1024Hex =
        "EEAF0AB9ADB38DD69C33F80AFA8FC5E86072618775FF3C0B9EA2314C9C256576D674DF7496EA81D3383B4813D692C6E0" +
        "E0D5D8E250B98BE48E495C1D6089DAD15DC7D7B46154D6B6CE8EF4AD69B15D4982559B297BCF1885C529F566660E57E" +
        "C68EDBC3C05726CC02FD4CBF4976EAA9AFD5138FE8376435B9FC61D2FC0EB06E3";

    /// <summary>RFC 8439 §2.8.2 的 AEAD_CHACHA20_POLY1305 测试向量。</summary>
    private const string Rfc8439Key =
        "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f";
    private const string Rfc8439Nonce = "070000004041424344454647";
    private const string Rfc8439Aad = "50515253c0c1c2c3c4c5c6c7";
    private const string Rfc8439Cipher =
        "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6" +
        "3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36" +
        "92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc" +
        "3ff4def08e4b7a9de576d26586cec64b6116";
    private const string Rfc8439Tag = "1ae10b594f09e26a7e902ecbd0600691";

    /// <summary>NIST SP 800-38A F.2.1（CBC-AES128.Encrypt）测试向量。</summary>
    private const string NistAesKey = "2b7e151628aed2a6abf7158809cf4f3c";
    private const string NistAesIv = "000102030405060708090a0b0c0d0e0f";
    private const string NistAesPlain =
        "6bc1bee22e409f96e93d7e117393172a" +
        "ae2d8a571e03ac9c9eb76fac45af8e51" +
        "30c81c46a35ce411e5fbc1191a0a52ef" +
        "f69f2445df4f9b17ad2b417be66c3710";
    private const string NistAesCipher =
        "7649abac8119b246cee98e9b12e9197d" +
        "5086cb9b507219ee95db113a917678b2" +
        "73bed6b8e3c1743b7116e69e22229516" +
        "3ff1caa1681fac09120eca307586e1a7";

    /// <summary>TuneBlade 1.30 硬编码的 RSAAES_Str（AirPort Express 公钥 OAEP-SHA1 包装的固定 AES key，342 chars 无填充）。</summary>
    private const string TuneBladeRsaaesBase64 =
        "1phMbunVTkyWKOASlg6vYVDN/q/YyjIHJa+yFkLcIuT/CoSbBye3cYqy1Iy/byeFr6YFVfqMM4tkvCdauWCB+KeDjcxk84J" +
        "TieuwcjIMN2dpuBPye45egTw5h01PB8yI4HJgOWJvwylqM+YDwq7NfpApYvzFG4GnFAoxk9j5AKKbifaP538IzYt5PlCrVLpNe" +
        "WfEMkAEad82SZs7qoxgSHeL0+mB6YLDLtocfQuP9fb64im+0/Xc4dwgUfYte6vETlCbHH+Uh5Dij71QDrjFipl+gjm29DqBx9r" +
        "WEw53gL5f3vHL1SNM6KpNGKTGifeC0Dlwu+EUKl44zA2aidxfGg";

    /// <summary>TuneBlade AudioSource.cs:762-766 的固定 AES key（16 字节）。</summary>
    private const string TuneBladeAesKeyHex = "0BA0D6B09206D214F8D59AF09FABBB15";

    /// <summary>TuneBlade 固定 IV（AudioSource.cs）。</summary>
    private const string TuneBladeAesIvHex = "307C0D006043C807F4F5CB51412DA8C2";

    /// <summary>真机 HomePod mini（192.168.31.183）瞬态配对实测得到的 SRP 会话密钥 K（64 字节）。</summary>
    private const string RealDeviceSrpKHex =
        "A1074C496563AC1CEA5996A102E1AD477F5C6536B67565F13D823212EBF90006" +
        "99A079BADA3714356867E4F785BE919FBC84B6BFDAB0832643F2F121A284777D";

    /// <summary>由上面的真机 K 派生出的控制通道写密钥（真机实测值，见 README）。</summary>
    private const string RealDeviceWriteKeyHex = "E1AECA67A7A4BE46B4745076C879B9C3AF8DDD4809706EDC4CF94A5686EE5D44";

    /// <summary>由上面的真机 K 派生出的控制通道读密钥（真机实测值，见 README）。</summary>
    private const string RealDeviceReadKeyHex = "9D8C5F7EF8299A03338642F6F84EBF595C39689A724C336930533A9D31AA3F02";

    // ---------------- 注册 ----------------

    public static void Register(TestRunner r)
    {
        r.Add("RFC 8439 §2.8.2：ChaCha20-Poly1305 AEAD 测试向量", TestChaCha20Poly1305Rfc8439);
        r.Add("HAP 加密帧：2B 小端长度 + AAD=长度字段 + 计数器 nonce（已知答案）", TestHapFrameKnownAnswer);
        r.Add("HAP 加密帧：>1024 字节分多帧、计数器递增、流式解密", TestHapFrameMultiFrame);
        r.Add("HAP 加密帧：密文被篡改必须抛 CryptographicException", TestHapFrameTamper);
        r.Add("TLV8：编码/解码、384 字节自动分片与合并、状态与错误码", TestTlv8);
        r.Add("SRP-6a RFC 5054 附录 B：k/x/A/u/S 与 1024 位组测试向量", TestSrpRfc5054);
        r.Add("SRP-6a HAP：服务端独立复算 B/M1/M2 与客户端互验（3072 位/SHA-512）", TestSrpHapSelfConsistency);
        r.Add("真机 KAT：HomePod 瞬态配对 K → Control-Read/Write 密钥", TestRealDeviceControlKeys);
        r.Add("HKDF-SHA512：与手写 RFC 5869 流程（HMAC 链）一致（含多块 >64B）", TestHkdfSha512);
        r.Add("AES-128-CBC：NIST SP 800-38A F.2.1 测试向量", TestAesCbcNist);
        r.Add("RAOP 音频负载：只加密 16 整倍数、尾部明文、头部不动、可解密还原", TestRaopPayloadPartialBlocks);
        r.Add("RAOP 音频负载：每个包都用同一 IV 重置（不是链式延续）", TestRaopIvResetPerPacket);
        r.Add("rsaaeskey：RSA-OAEP-SHA1 包装/解包 + pk 三种格式解析", TestRsaaesKeyOaep);
        r.Add("AirPort Express 公钥 + TuneBlade 硬编码 RSAAES_Str 解出固定 AES key", TestAirPortExpressKeyAndTuneBladeEvidence);
        r.Add("Apple-Challenge：16B 随机 / base64 去填充 / PKCS#1 v1.5 SHA-1 验签", TestAppleChallenge);
        r.Add("HapCredentials：序列化/反序列化/Base64 往返与截断防护", TestHapCredentials);
        r.Add("HapPairing：请求头（User-Agent / X-Apple-HKP / Content-Type）", TestHapHeaders);
    }

    // ---------------- ChaCha20-Poly1305 ----------------

    private static bool TestChaCha20Poly1305Rfc8439()
    {
        var key = Hex.Parse(Rfc8439Key);
        var nonce = Hex.Parse(Rfc8439Nonce);
        var aad = Hex.Parse(Rfc8439Aad);
        var plaintext = Encoding.ASCII.GetBytes(
            "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
        var expectedCipher = Hex.Parse(Rfc8439Cipher);
        var expectedTag = Hex.Parse(Rfc8439Tag);

        using var chacha = new ChaCha20Poly1305(key);
        var cipher = new byte[plaintext.Length];
        var tag = new byte[16];
        chacha.Encrypt(nonce, plaintext, cipher, tag, aad);

        var ok = TestRunner.CheckTrue("明文长度 114", plaintext.Length == 114);
        ok &= TestRunner.CheckBytes("密文", expectedCipher, cipher);
        ok &= TestRunner.CheckBytes("认证标签", expectedTag, tag);

        var decrypted = new byte[plaintext.Length];
        chacha.Decrypt(nonce, cipher, tag, decrypted, aad);
        ok &= TestRunner.CheckBytes("解密还原", plaintext, decrypted);
        return ok;
    }

    // ---------------- HAP 加密帧 ----------------

    private static byte[] HapNonce(ulong counter)
    {
        var nonce = new byte[HapSessionCrypt.NonceSize]; // 12 字节：4 个 0 + 8 字节小端计数器
        BinaryPrimitives.WriteUInt64LittleEndian(nonce.AsSpan(4), counter);
        return nonce;
    }

    private static bool TestHapFrameKnownAnswer()
    {
        var writeKey = Hex.Parse("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
        var readKey = Hex.Parse("1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100");

        using var writer = new HapSessionCrypt(writeKey, readKey);
        var plaintext = CryptoPrimitives.Utf8("Hello, HAP!");
        var frame = writer.Encrypt(plaintext);

        // 用 BCL ChaCha20Poly1305 直接算参考帧：2B 小端长度作 AAD，nonce = 4×00 + 8B LE counter
        var lengthField = new byte[2];
        BinaryPrimitives.WriteUInt16LittleEndian(lengthField, (ushort)plaintext.Length);
        using var reference = new ChaCha20Poly1305(writeKey);
        var referenceCipher = new byte[plaintext.Length];
        var referenceTag = new byte[16];
        reference.Encrypt(HapNonce(0), plaintext, referenceCipher, referenceTag, lengthField);
        var expected = CryptoPrimitives.Concat(lengthField, referenceCipher, referenceTag);

        var ok = TestRunner.CheckBytes("第一帧字节", expected, frame);
        ok &= TestRunner.CheckTrue("帧长 = 2 + 明文 + 16", frame.Length == 2 + plaintext.Length + 16);
        ok &= TestRunner.CheckTrue("写计数器 = 1", writer.WriteCounter == 1);

        // 第二帧：计数器 = 1（小端 8 字节，位于 nonce[4..12]）
        var frame2 = writer.Encrypt(plaintext);
        using var reference2 = new ChaCha20Poly1305(writeKey);
        var cipher2 = new byte[plaintext.Length];
        var tag2 = new byte[16];
        reference2.Encrypt(HapNonce(1), plaintext, cipher2, tag2, lengthField);
        ok &= TestRunner.CheckBytes("第二帧字节（counter=1）", CryptoPrimitives.Concat(lengthField, cipher2, tag2), frame2);

        using var reader = new HapSessionCrypt(readKey, writeKey);
        ok &= TestRunner.CheckBytes("反向解密第一帧", plaintext, reader.Decrypt(frame));
        ok &= TestRunner.CheckTrue("读计数器 = 1", reader.ReadCounter == 1);
        return ok;
    }

    private static bool TestHapFrameMultiFrame()
    {
        var writeKey = CryptoPrimitives.RandomBytes(32);
        var readKey = CryptoPrimitives.RandomBytes(32);
        using var writer = new HapSessionCrypt(writeKey, readKey);
        using var reader = new HapSessionCrypt(readKey, writeKey);

        var plaintext = new byte[2500];
        for (var i = 0; i < plaintext.Length; i++) plaintext[i] = (byte)(i * 7 + 3);

        var ciphertext = writer.Encrypt(plaintext);
        var ok = TestRunner.CheckTrue("3 帧：2500 + 3×(2+16)", ciphertext.Length == 2500 + 3 * 18);
        ok &= TestRunner.CheckTrue("写计数器 = 3", writer.WriteCounter == 3);

        // 流式解密：每次只喂 7 字节，模拟 TCP 任意分段
        using var output = new MemoryStream();
        for (var offset = 0; offset < ciphertext.Length; offset += 7)
        {
            var take = Math.Min(7, ciphertext.Length - offset);
            output.Write(reader.Decrypt(ciphertext.AsSpan(offset, take)));
        }

        ok &= TestRunner.CheckBytes("流式解密还原", plaintext, output.ToArray());
        ok &= TestRunner.CheckTrue("读计数器 = 3", reader.ReadCounter == 3);
        return ok;
    }

    private static bool TestHapFrameTamper()
    {
        var writeKey = CryptoPrimitives.RandomBytes(32);
        var readKey = CryptoPrimitives.RandomBytes(32);
        using var writer = new HapSessionCrypt(writeKey, readKey);
        using var reader = new HapSessionCrypt(readKey, writeKey);

        var frame = writer.Encrypt(CryptoPrimitives.Utf8("tamper me"));
        frame[5] ^= 0x01;
        try
        {
            reader.Decrypt(frame);
            return TestRunner.CheckTrue("没有被检测到（不应发生）", false);
        }
        catch (CryptographicException)
        {
            return TestRunner.CheckTrue("已检测到篡改", true);
        }
    }

    // ---------------- TLV8 ----------------

    private static bool TestTlv8()
    {
        var big = new byte[384];
        for (var i = 0; i < big.Length; i++) big[i] = (byte)(i & 0xFF);

        var data = new HapTlvBuilder()
            .AddByte(HapTlvType.Method, 0)
            .AddString(HapTlvType.Identifier, "Pair-Setup")
            .AddByte(HapTlvType.State, 1)
            .Add(HapTlvType.PublicKey, big)
            .Build();

        var items = HapTlv.Parse(data);
        var ok = TestRunner.CheckTrue("项数 = 4（255+129 已合并回 384）", items.Count == 4);
        ok &= TestRunner.CheckTrue("Method = 0", HapTlv.GetValue(items, HapTlvType.Method)![0] == 0);
        ok &= TestRunner.CheckTrue("Identifier = Pair-Setup",
            Encoding.UTF8.GetString(HapTlv.GetValue(items, HapTlvType.Identifier)!) == "Pair-Setup");
        ok &= TestRunner.CheckBytes("PublicKey 384 字节", big, HapTlv.GetValue(items, HapTlvType.PublicKey)!);

        // 线上分片：0x03 0xFF <255B> 0x03 0x81 <129B>
        var index = -1;
        for (var i = 0; i < data.Length - 1; i++)
        {
            if (data[i] == HapTlvType.PublicKey && data[i + 1] == 0xFF) { index = i; break; }
        }
        ok &= TestRunner.CheckTrue("384B 被切成 255 + 129",
            index >= 0 && data[index + 2 + 255] == HapTlvType.PublicKey && data[index + 2 + 255 + 1] == 0x81);

        var stateData = new HapTlvBuilder()
            .AddByte(HapTlvType.State, 2)
            .Add(HapTlvType.Salt, new byte[16])
            .Add(HapTlvType.PublicKey, big)
            .Build();
        var (state, stateItems) = HapTlv.ParseWithState(stateData, 2);
        ok &= TestRunner.CheckTrue("State = 2", state == 2);
        ok &= TestRunner.CheckTrue("Salt = 16 字节", HapTlv.GetValue(stateItems, HapTlvType.Salt)!.Length == 16);

        var errorData = new HapTlvBuilder()
            .AddByte(HapTlvType.Error, (byte)HapPairingError.BackoffError)
            .AddByte(HapTlvType.RetryDelay, 1)
            .AddByte(HapTlvType.State, 2)
            .Build();
        var errorItems = HapTlv.Parse(errorData);
        ok &= TestRunner.CheckTrue("Error = 3 (Backoff)",
            HapTlv.GetValue(errorItems, HapTlvType.Error)![0] == 3);
        ok &= TestRunner.CheckTrue("RetryDelay = 1",
            HapTlv.GetValue(errorItems, HapTlvType.RetryDelay)![0] == 1);
        return ok;
    }

    // ---------------- SRP-6a ----------------

    private static bool TestSrpRfc5054()
    {
        var n = CryptoPrimitives.FromBigEndian(Hex.Parse(N1024Hex));
        var g = new BigInteger(2);
        var salt = Hex.Parse("BEB25379D1A8581EB5A727673A2441EE");
        var a = Hex.Parse("60975527035CF2AD1989806F0407210BC81EDC04E2762A56AFD529DDDA2D4393");
        var expectedA = Hex.Parse(
            "61D5E490F6F1B79547B0704C436F523DD0E560F0C64115BB72557EC44352E890" +
            "3211C04692272D8B2D1A5358A2CF1B6E0BFCF99F921530EC8E39356179EAE45E" +
            "42BA92AEACED825171E1E8B9AF6D9C03E1327F44BE087EF06530E69F66615261" +
            "EEF54073CA11CF5858F0EDFDFE15EFEAB349EF5D76988A3672FAC47B0769447B");
        var expectedB = Hex.Parse(
            "BD0C61512C692C0CB6D041FA01BB152D4916A1E77AF46AE105393011BAF38964" +
            "DC46A0670DD125B95A981652236F99D9B681CBF87837EC996C6DA04453728610" +
            "D0C6DDB58B318885D7D82C7F8DEB75CE7BD4FBAA37089E6F9C6059F388838E7A" +
            "00030B331EB76840910440B1B27AAEAEEB4012B7D7665238A8E3FB004B117B58");
        var expectedS = Hex.Parse(
            "B0DC82BABCF30674AE450C0287745E7990A3381F63B387AAF271A10D233861E3" +
            "59B48220F7C4693C9AE12B0A6F67809F0876E2D013800D6C41BB59B6D5979B5C" +
            "00A172B4A2A5903A0BDCAF8A709585EB2AFAFA8F3499B200210DCC1F10EB3394" +
            "3CD67FC88A2F39A4BE5BEC4EC0A3212DC346D7E474B29EDE8A469FFECA686E5A");

        var srp = SrpClient.CreateCustom("alice", "password123", n, g, HashAlgorithmName.SHA1,
            appleLegacySessionKey: false, fixedPrivateKey: a);

        var ok = TestRunner.CheckTrue("A = g^a mod N", Hex.Of(srp.PublicKey) == Hex.Of(expectedA));

        var k = SrpClient.ComputeMultiplier(n, g, HashAlgorithmName.SHA1, 128);
        ok &= TestRunner.CheckTrue("k = H(N|PAD(g))",
            Hex.Of(CryptoPrimitives.ToBigEndianUnsigned(k)) == "7556aa045aef2cdd07abaf0f665c3e818913186f");

        var x = SrpClient.ComputeX(salt, "alice", "password123", HashAlgorithmName.SHA1);
        ok &= TestRunner.CheckTrue("x = H(s|H(I:P))",
            Hex.Of(CryptoPrimitives.ToBigEndianUnsigned(x)) == "94b7555aabe9127cc58ccf4993db6cf84d16c124");

        srp.ComputeProof(salt, expectedB);

        var u = SrpClient.ComputeU(CryptoPrimitives.FromBigEndian(expectedA),
            CryptoPrimitives.FromBigEndian(expectedB), 128, HashAlgorithmName.SHA1);
        ok &= TestRunner.CheckTrue("u = H(PAD(A)|PAD(B))",
            Hex.Of(CryptoPrimitives.ToBigEndianUnsigned(u)) == "ce38b9593487da98554ed47d70a7ae5f462ef019");

        ok &= TestRunner.CheckTrue("S = (B-k*g^x)^(a+u*x) mod N",
            Hex.Of(CryptoPrimitives.ToBigEndianUnsigned(srp.PremasterSecret)) == Hex.Of(expectedS));
        return ok;
    }

    private static bool TestSrpHapSelfConsistency()
    {
        const string pin = "3939";
        var client = SrpClient.CreateHapPairSetup(pin);
        var clientA = client.PublicKey;

        var n = SrpClient.HapPrime;
        var g = SrpClient.HapGenerator;
        var salt = Hex.Parse("E43E4CD8DD8836ED7C227153837B07FF");
        var b = CryptoPrimitives.FromBigEndian(Hex.Parse(
            "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff"));

        // ---- 服务端独立实现（不复用 SrpClient 的实例状态） ----
        var k = SrpClient.ComputeMultiplier(n, g, HashAlgorithmName.SHA512, 384);
        var x = SrpClient.ComputeX(salt, SrpClient.HapUsername, pin, HashAlgorithmName.SHA512);
        var v = BigInteger.ModPow(g, x, n);
        var serverB = (k * v + BigInteger.ModPow(g, b, n)) % n;
        var serverBBytes = CryptoPrimitives.ToBigEndianPadded(serverB, 384);

        var clientProof = client.ComputeProof(salt, serverBBytes);

        var aValue = CryptoPrimitives.FromBigEndian(clientA);
        var u = SrpClient.ComputeU(aValue, serverB, 384, HashAlgorithmName.SHA512);
        var serverS = BigInteger.ModPow((aValue * BigInteger.ModPow(v, u, n)) % n, b, n);
        var serverK = CryptoPrimitives.Sha512(CryptoPrimitives.ToBigEndianUnsigned(serverS));

        var ok = TestRunner.CheckBytes("K = SHA-512(S) 客户端/服务端一致", serverK, client.SessionKey);

        var hn = CryptoPrimitives.Sha512(CryptoPrimitives.ToBigEndianUnsigned(n));
        var hg = CryptoPrimitives.Sha512(CryptoPrimitives.ToBigEndianUnsigned(g));
        var xor = CryptoPrimitives.ToBigEndianUnsigned(
            CryptoPrimitives.FromBigEndian(hn) ^ CryptoPrimitives.FromBigEndian(hg));
        var expectedM1 = CryptoPrimitives.Sha512(CryptoPrimitives.Concat(
            xor, CryptoPrimitives.Sha512(CryptoPrimitives.Utf8(SrpClient.HapUsername)), salt, clientA,
            CryptoPrimitives.ToBigEndianUnsigned(serverB), serverK));
        ok &= TestRunner.CheckBytes("服务端复算 M1 = 客户端证明", expectedM1, clientProof);

        var serverM2 = CryptoPrimitives.Sha512(CryptoPrimitives.Concat(clientA, clientProof, serverK));
        ok &= TestRunner.CheckTrue("客户端验证服务端 M2", client.VerifyServerProof(serverM2));
        return ok;
    }

    private static bool TestRealDeviceControlKeys()
    {
        var shared = Hex.Parse(RealDeviceSrpKHex);
        var (writeKey, readKey) = HapKeyDerivation.DeriveControlKeys(shared);
        var ok = TestRunner.CheckBytes("Control-Write 密钥（真机实测）", Hex.Parse(RealDeviceWriteKeyHex), writeKey);
        ok &= TestRunner.CheckBytes("Control-Read 密钥（真机实测）", Hex.Parse(RealDeviceReadKeyHex), readKey);

        var (writeKey2, readKey2) = HapKeyDerivation.DeriveControlKeys(shared);
        ok &= TestRunner.CheckBytes("派生可复现（写）", writeKey, writeKey2);
        ok &= TestRunner.CheckBytes("派生可复现（读）", readKey, readKey2);
        return ok;
    }

    // ---------------- HKDF ----------------

    private static bool TestHkdfSha512()
    {
        var ikm = Hex.Parse("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
        var salt = Hex.Parse("000102030405060708090a0b0c");
        var info = Hex.Parse("f0f1f2f3f4f5f6f7f8f9");

        var actual = CryptoPrimitives.HkdfSha512(ikm, salt, info, 82);
        var expected = ManualHkdfSha512(ikm, salt, info, 82);

        var ok = TestRunner.CheckBytes("HKDF-SHA512 82 字节（跨 2 个 HMAC 块）", expected, actual);
        ok &= TestRunner.CheckTrue("长度 = 82", actual.Length == 82);

        var oneBlock = CryptoPrimitives.HkdfSha512(ikm, salt, info, 32);
        ok &= TestRunner.CheckBytes("HKDF-SHA512 32 字节（单块）", ManualHkdfSha512(ikm, salt, info, 32), oneBlock);

        // HAP 的 salt/info 都是 ASCII 文本：确认字符串重载与字节重载一致
        var text = CryptoPrimitives.HkdfSha512(ikm, "Control-Salt", "Control-Write-Encryption-Key", 32);
        var bytes = CryptoPrimitives.HkdfSha512(ikm, CryptoPrimitives.Ascii("Control-Salt"),
            CryptoPrimitives.Ascii("Control-Write-Encryption-Key"), 32);
        ok &= TestRunner.CheckBytes("字符串 salt/info 重载", bytes, text);
        return ok;
    }

    /// <summary>手写 RFC 5869 的 HKDF 流程（HMAC-SHA512），用于独立验证 BCL HKDF 的调用方式。</summary>
    private static byte[] ManualHkdfSha512(byte[] ikm, byte[] salt, byte[] info, int length)
    {
        var effectiveSalt = salt.Length == 0 ? new byte[64] : salt;
        byte[] prk;
        using (var extract = new HMACSHA512(effectiveSalt))
        {
            prk = extract.ComputeHash(ikm);
        }

        var okm = new byte[length];
        var previous = Array.Empty<byte>();
        var position = 0;
        byte counter = 1;
        using var expand = new HMACSHA512(prk);
        while (position < length)
        {
            var input = new byte[previous.Length + info.Length + 1];
            previous.CopyTo(input, 0);
            info.CopyTo(input, previous.Length);
            input[^1] = counter++;
            previous = expand.ComputeHash(input);
            var take = Math.Min(previous.Length, length - position);
            Array.Copy(previous, 0, okm, position, take);
            position += take;
        }
        return okm;
    }

    // ---------------- AES / RAOP ----------------

    private static bool TestAesCbcNist()
    {
        var key = Hex.Parse(NistAesKey);
        var iv = Hex.Parse(NistAesIv);
        var plaintext = Hex.Parse(NistAesPlain);
        var expected = Hex.Parse(NistAesCipher);

        using var aes = Aes.Create();
        aes.Key = key;
        var cipher = aes.EncryptCbc(plaintext, iv, PaddingMode.None);
        var ok = TestRunner.CheckBytes("CBC-AES128 加密", expected, cipher);
        ok &= TestRunner.CheckBytes("CBC-AES128 解密", plaintext, aes.DecryptCbc(cipher, iv, PaddingMode.None));
        return ok;
    }

    private static bool TestRaopPayloadPartialBlocks()
    {
        var key = Hex.Parse(TuneBladeAesKeyHex);
        var iv = Hex.Parse(TuneBladeAesIvHex);

        var payload = new byte[37];
        for (var i = 0; i < payload.Length; i++) payload[i] = (byte)(i + 1);

        var packet = new byte[16 + payload.Length]; // 前 16 字节模拟 [4B 重传头 + 12B RTP 头]
        packet.AsSpan(0, 16).Fill(0xAA);
        payload.CopyTo(packet.AsSpan(16));

        var encryptedBytes = RaopCrypto.EncryptAudioPayloadInPlace(packet, 16, payload.Length, key, iv);
        var ok = TestRunner.CheckTrue("只加密 32 字节（37 & ~15）", encryptedBytes == 32);

        using var aes = Aes.Create();
        aes.Key = key;
        var reference = aes.EncryptCbc(payload.AsSpan(0, 32).ToArray(), iv, PaddingMode.None);
        ok &= TestRunner.CheckBytes("前 32 字节与参考 AES-CBC 一致", reference, packet.AsSpan(16, 32));
        ok &= TestRunner.CheckBytes("尾部 5 字节保持明文", payload.AsSpan(32).ToArray(), packet.AsSpan(48));

        var headerIntact = true;
        for (var i = 0; i < 16; i++)
        {
            if (packet[i] != 0xAA) { headerIntact = false; break; }
        }
        ok &= TestRunner.CheckTrue("RTP 头未被改动", headerIntact);

        RaopCrypto.DecryptAudioPayloadInPlace(packet, 16, payload.Length, key, iv);
        ok &= TestRunner.CheckBytes("解密后还原原负载", payload, packet.AsSpan(16));
        return ok;
    }

    private static bool TestRaopIvResetPerPacket()
    {
        var key = Hex.Parse(TuneBladeAesKeyHex);
        var iv = Hex.Parse(TuneBladeAesIvHex);
        var otherIv = (byte[])iv.Clone();
        otherIv[15] ^= 0x01;

        var payload = new byte[64];
        for (var i = 0; i < payload.Length; i++) payload[i] = (byte)(i * 3 + 1);

        var first = RaopCrypto.EncryptAudioPayload(payload, key, iv);
        var second = RaopCrypto.EncryptAudioPayload(payload, key, iv);
        var withOtherIv = RaopCrypto.EncryptAudioPayload(payload, key, otherIv);

        var ok = TestRunner.CheckBytes("同一 IV 两个包密文相同（每包重置，不是链式）", first, second);
        ok &= TestRunner.CheckTrue("换 IV 后密文不同", !first.AsSpan().SequenceEqual(withOtherIv));
        return ok;
    }

    private static bool TestRsaaesKeyOaep()
    {
        using var rsa = RSA.Create(2048);
        var spkiPem = rsa.ExportSubjectPublicKeyInfoPem();
        var aesKey = Hex.Parse(TuneBladeAesKeyHex);

        var wrapped = RaopCrypto.WrapRsaaesKeyBase64(aesKey, spkiPem);
        var ok = TestRunner.CheckTrue("rsaaeskey 是 base64 无填充", !wrapped.Contains('='));

        var unwrapped = rsa.Decrypt(CryptoPrimitives.Base64DecodeLenient(wrapped), RSAEncryptionPadding.OaepSHA1);
        ok &= TestRunner.CheckBytes("OAEP-SHA1 解包得到原 AES key", aesKey, unwrapped);

        var sha256Failed = false;
        try
        {
            rsa.Decrypt(CryptoPrimitives.Base64DecodeLenient(wrapped), RSAEncryptionPadding.OaepSHA256);
        }
        catch (CryptographicException)
        {
            sha256Failed = true;
        }
        ok &= TestRunner.CheckTrue("OAEP-SHA256 解不出（证明用的是 SHA-1 OAEP）", sha256Failed);

        // mDNS TXT 的 pk 三种常见格式
        using var fromSpki = RaopCrypto.TryParseDevicePublicKey(Convert.ToBase64String(rsa.ExportSubjectPublicKeyInfo()));
        using var fromPkcs1 = RaopCrypto.TryParseDevicePublicKey(Convert.ToBase64String(rsa.ExportRSAPublicKey()));
        using var fromPem = RaopCrypto.TryParseDevicePublicKey(spkiPem);
        ok &= TestRunner.CheckTrue("pk 解析：SPKI base64", fromSpki is { KeySize: 2048 });
        ok &= TestRunner.CheckTrue("pk 解析：PKCS#1 base64", fromPkcs1 is { KeySize: 2048 });
        ok &= TestRunner.CheckTrue("pk 解析：PEM", fromPem is { KeySize: 2048 });

        // 无 '=' 填充的 base64（AirPlay TXT 记录常见）
        var unpadded = Convert.ToBase64String(rsa.ExportSubjectPublicKeyInfo()).TrimEnd('=');
        using var unpaddedKey = RaopCrypto.TryParseDevicePublicKey(unpadded);
        ok &= TestRunner.CheckTrue("pk 解析：base64 无填充", unpaddedKey is { KeySize: 2048 });

        ok &= TestRunner.CheckTrue("pk 解析：64 位 hex（AirPlay 2 Ed25519）返回 null",
            RaopCrypto.TryParseDevicePublicKey(new string('a', 64)) is null);
        ok &= TestRunner.CheckTrue("pk 解析：垃圾文本返回 null",
            RaopCrypto.TryParseDevicePublicKey("not-a-key") is null);
        return ok;
    }

    private static bool TestAirPortExpressKeyAndTuneBladeEvidence()
    {
        using var aePublic = RaopCrypto.CreateAirPortExpressPublicKey();
        var parameters = aePublic.ExportParameters(false);
        var ok = TestRunner.CheckTrue("AE 公钥 2048 位", aePublic.KeySize == 2048);
        ok &= TestRunner.CheckTrue("AE 公钥指数 = 65537",
            parameters.Exponent is { Length: 3 } && parameters.Exponent[0] == 1 && parameters.Exponent[2] == 1);
        ok &= TestRunner.CheckTrue("AE 模数前缀 E7D744F2",
            Hex.Of(parameters.Modulus.AsSpan(0, 4)) == "e7d744f2");

        var aesKey = Hex.Parse(TuneBladeAesKeyHex);

        // 内置公钥加密 → 解包（自洽）
        var wrapped = aePublic.Encrypt(aesKey, RSAEncryptionPadding.OaepSHA1);

        // 若能找到一次性验证用的 AE 私钥（research 目录，仅开发机存在，不进产品/仓库提交物），
        // 就做最硬的交叉验证：TuneBlade 的 RSAAES_Str 必须解出它写死的 AES key。
        var privateKeyPath = FindUpwards("_ref", "ae-private.pem");
        if (privateKeyPath is null)
        {
            Console.WriteLine("       └─ 未找到 _ref/ae-private.pem，跳过与 TuneBlade RSAAES_Str 的解密交叉验证");
            return ok;
        }

        using var aePrivate = RSA.Create();
        aePrivate.ImportFromPem(File.ReadAllText(privateKeyPath));

        var tuneBladeCipher = CryptoPrimitives.Base64DecodeLenient(TuneBladeRsaaesBase64);
        var tuneBladePlain = aePrivate.Decrypt(tuneBladeCipher, RSAEncryptionPadding.OaepSHA1);
        ok &= TestRunner.CheckBytes(
            "TuneBlade RSAAES_Str 经 OAEP-SHA1 解出固定 AES key（AirPort Express 公钥正确）",
            aesKey, tuneBladePlain);
        ok &= TestRunner.CheckBytes("内置 AE 公钥加密 → 私钥解密还原",
            aesKey, aePrivate.Decrypt(wrapped, RSAEncryptionPadding.OaepSHA1));
        return ok;
    }

    private static bool TestAppleChallenge()
    {
        using var rsa = RSA.Create(2048);
        var challenge = RaopCrypto.GenerateAppleChallenge();
        var header = RaopCrypto.AppleChallengeHeader(challenge);
        var ok = TestRunner.CheckTrue("Apple-Challenge = 16 字节", challenge.Length == 16);
        ok &= TestRunner.CheckTrue("请求头 base64 无填充（22 字符）", header.Length == 22 && !header.Contains('='));

        var clientIp = new byte[] { 192, 168, 31, 41 };
        var ap1Prefix = Hex.Parse("010203040506");
        var response = RaopCrypto.ComputeAppleResponse(challenge, rsa, clientIp, ap1Prefix);

        ok &= TestRunner.CheckTrue("Apple-Response 验签通过",
            RaopCrypto.VerifyAppleResponse(challenge, response, rsa, clientIp, ap1Prefix));

        var tampered = (byte[])challenge.Clone();
        tampered[0] ^= 0x01;
        ok &= TestRunner.CheckTrue("挑战被篡改 → 验签失败",
            !RaopCrypto.VerifyAppleResponse(tampered, response, rsa, clientIp, ap1Prefix));

        ok &= TestRunner.CheckTrue("前缀长度错误 → 验签失败",
            !RaopCrypto.VerifyAppleResponse(challenge, response, rsa, clientIp, new byte[3]));
        ok &= TestRunner.CheckTrue("空响应 → 验签失败",
            !RaopCrypto.VerifyAppleResponse(challenge, "", rsa, clientIp, ap1Prefix));
        return ok;
    }

    // ---------------- HAP 凭据 / 请求头 ----------------

    private static bool TestHapCredentials()
    {
        var credentials = new HapCredentials
        {
            AccessoryId = CryptoPrimitives.Utf8("AA:BB:CC:DD:EE:FF"),
            AccessoryLtpk = CryptoPrimitives.RandomBytes(32),
            ClientId = CryptoPrimitives.Utf8(Guid.NewGuid().ToString("D")),
            ClientLtsk = CryptoPrimitives.RandomBytes(32),
            IsTransient = false,
        };

        var roundTrip = HapCredentials.Deserialize(credentials.Serialize());
        var ok = TestRunner.CheckBytes("AccessoryId 往返", credentials.AccessoryId, roundTrip.AccessoryId);
        ok &= TestRunner.CheckBytes("AccessoryLtpk 往返", credentials.AccessoryLtpk, roundTrip.AccessoryLtpk);
        ok &= TestRunner.CheckBytes("ClientId 往返", credentials.ClientId, roundTrip.ClientId);
        ok &= TestRunner.CheckBytes("ClientLtsk 往返", credentials.ClientLtsk, roundTrip.ClientLtsk);
        ok &= TestRunner.CheckTrue("IsTransient 往返", roundTrip.IsTransient == credentials.IsTransient);
        ok &= TestRunner.CheckTrue("IsValid", roundTrip.IsValid);

        var fromBase64 = HapCredentials.FromBase64(credentials.ToBase64());
        ok &= TestRunner.CheckBytes("Base64 往返", credentials.AccessoryLtpk, fromBase64.AccessoryLtpk);

        var truncatedFailed = false;
        try
        {
            HapCredentials.Deserialize(credentials.Serialize().AsSpan(0, 20));
        }
        catch (Exception)
        {
            truncatedFailed = true;
        }
        ok &= TestRunner.CheckTrue("截断数据被拒绝", truncatedFailed);
        return ok;
    }

    private static bool TestHapHeaders()
    {
        var transient = HapPairing.BuildHeaders(HapPairing.HkpTransient);
        var normal = HapPairing.BuildHeaders(HapPairing.HkpNormal);
        var ok = TestRunner.CheckTrue("瞬态 X-Apple-HKP = 4", transient["X-Apple-HKP"] == "4");
        ok &= TestRunner.CheckTrue("正常 X-Apple-HKP = 3", normal["X-Apple-HKP"] == "3");
        ok &= TestRunner.CheckTrue("Content-Type = application/octet-stream",
            transient["Content-Type"] == HapPairing.BinaryContentType);
        ok &= TestRunner.CheckTrue("User-Agent 默认 AirPlay/320.20",
            transient["User-Agent"] == HapPairing.DefaultUserAgent);
        ok &= TestRunner.CheckTrue("Connection: keep-alive", transient["Connection"] == "keep-alive");
        return ok;
    }

    // ---------------- 工具 ----------------

    /// <summary>从当前目录/程序目录逐级向上查找 relative 路径（用于定位 research 目录下的一次性验证材料）。</summary>
    private static string? FindUpwards(string first, string second)
    {
        foreach (var start in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            var directory = new DirectoryInfo(start);
            for (var depth = 0; depth < 12 && directory is not null; depth++, directory = directory.Parent)
            {
                var candidate = Path.Combine(directory.FullName, first, second);
                if (File.Exists(candidate)) return candidate;
            }
        }
        return null;
    }
}
