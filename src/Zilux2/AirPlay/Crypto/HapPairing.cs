// -----------------------------------------------------------------------------
// Zilux2 - AirPlay 2 / HAP 配对（pair-setup + pair-verify + 瞬态配对）
//
// 协议依据：
//   * HAP 规范（HAP-Specification-Non-Commercial-Version 第 5 章 Pair Setup / Pair Verify）
//   * pair_ap/pair_homekit.c（shairport-sync 的 AirPlay 2 配对实现，MIT）
//   * pyatv/auth/hap.py、hap_transient.py、hap_srp.py
//   * AirPlay 2 实测：HomePod mini（AirTunes/980.77.2）接受瞬态配对
//
// 本类只实现「协议对话」：HTTP 的发送/接收由调用方通过 HapPairingTransport 委托注入
// （一般由 RaopClient / Ap2Connection 持有同一条 TCP 长连接实现），
// 本类不创建 socket、不关心 IP。配对成功后返回的共享密钥再交给
// HapSessionCrypt / HapKeyDerivation 生成 HAP 通道加密密钥。
// -----------------------------------------------------------------------------

using System.Buffers.Binary;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Zilux2.AirPlay.Crypto;

/// <summary>
/// 配对 HTTP 传输委托：由调用方注入（同一条长连接上复用）。
/// </summary>
/// <param name="method">HTTP 方法，如 "POST"。</param>
/// <param name="path">请求路径，如 "/pair-setup"。</param>
/// <param name="headers">附加请求头（已含 User-Agent / X-Apple-HKP / Content-Type）。</param>
/// <param name="body">请求体，可能为空数组。</param>
/// <param name="cancellationToken">取消标记。</param>
/// <returns>设备响应。传输层不负责判定业务状态码。</returns>
public delegate Task<HapHttpResponse> HapPairingTransport(
    string method,
    string path,
    IReadOnlyDictionary<string, string> headers,
    byte[] body,
    CancellationToken cancellationToken);

/// <summary>HAP 配对 HTTP 响应。</summary>
public sealed class HapHttpResponse
{
    /// <summary>HTTP 状态码。</summary>
    public int StatusCode { get; init; }

    /// <summary>Content-Type（归一化为小写，可空）。</summary>
    public string? ContentType { get; init; }

    /// <summary>响应体原始字节。</summary>
    public byte[] Body { get; init; } = Array.Empty<byte>();

    /// <summary>响应头（大小写不敏感）。</summary>
    public IReadOnlyDictionary<string, string> Headers { get; init; } =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    /// <summary>是否成功（2xx）。</summary>
    public bool IsSuccess => StatusCode is >= 200 and < 300;
}

/// <summary>
/// 配对凭据（正常 HAP 配对产物；瞬态配对不产生凭据）。
/// </summary>
/// <remarks>
/// 设备侧视角：client = controller（本程序），accessory = AirPlay 设备。
/// 首次配对成功后应持久化（例如按设备 ID 存到本地配置），之后每次连接只需 pair-verify。
/// </remarks>
public sealed class HapCredentials
{
    /// <summary>序列化魔数。</summary>
    private static readonly byte[] Magic = "Z2HP"u8.ToArray();

    /// <summary>当前序列化版本。</summary>
    private const byte CurrentVersion = 1;

    /// <summary>设备标识（HAP Identifier，实际为设备的 pairing id 字符串的 UTF-8 字节）。</summary>
    public byte[] AccessoryId { get; init; } = Array.Empty<byte>();

    /// <summary>设备长期 Ed25519 公钥（32 字节）。</summary>
    public byte[] AccessoryLtpk { get; init; } = Array.Empty<byte>();

    /// <summary>本机标识（UUID 字符串的 UTF-8 字节）。</summary>
    public byte[] ClientId { get; init; } = Array.Empty<byte>();

    /// <summary>本机长期 Ed25519 私钥种子（32 字节）。</summary>
    public byte[] ClientLtsk { get; init; } = Array.Empty<byte>();

    /// <summary>是否为瞬态凭据（瞬态不落盘，这里仅作标记）。</summary>
    public bool IsTransient { get; init; }

    /// <summary>是否是一套可用的长期凭据。</summary>
    public bool IsValid
        => AccessoryLtpk.Length == Ed25519.PublicKeySize
           && ClientLtsk.Length == Ed25519.SeedSize
           && ClientId.Length > 0
           && AccessoryId.Length > 0;

    /// <summary>序列化为字节（便于写入本地配置）。</summary>
    public byte[] Serialize()
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream);
        writer.Write(Magic);
        writer.Write(CurrentVersion);
        writer.Write((byte)(IsTransient ? 1 : 0));
        WriteBlob(writer, AccessoryId);
        WriteBlob(writer, AccessoryLtpk);
        WriteBlob(writer, ClientId);
        WriteBlob(writer, ClientLtsk);
        writer.Flush();
        return stream.ToArray();
    }

    /// <summary>从 <see cref="Serialize"/> 产出的字节反序列化。</summary>
    /// <exception cref="FormatException">数据格式非法。</exception>
    public static HapCredentials Deserialize(ReadOnlySpan<byte> data)
    {
        try
        {
            using var stream = new MemoryStream(data.ToArray());
            using var reader = new BinaryReader(stream);
            var magic = reader.ReadBytes(Magic.Length);
            if (magic.Length != Magic.Length || !magic.AsSpan().SequenceEqual(Magic))
                throw new FormatException("HapCredentials 数据缺少 Z2HP 魔数。");

            var version = reader.ReadByte();
            if (version != CurrentVersion)
                throw new FormatException($"HapCredentials 版本不支持：{version}。");

            var flags = reader.ReadByte();
            return new HapCredentials
            {
                IsTransient = (flags & 1) != 0,
                AccessoryId = ReadBlob(reader),
                AccessoryLtpk = ReadBlob(reader),
                ClientId = ReadBlob(reader),
                ClientLtsk = ReadBlob(reader),
            };
        }
        catch (EndOfStreamException ex)
        {
            throw new FormatException("HapCredentials 数据被截断。", ex);
        }
    }

    /// <summary>序列化为 Base64（写配置/注册表用）。</summary>
    public string ToBase64() => Convert.ToBase64String(Serialize());

    /// <summary>从 Base64 反序列化。</summary>
    public static HapCredentials FromBase64(string base64)
        => Deserialize(Convert.FromBase64String(base64));

    private static void WriteBlob(BinaryWriter writer, byte[] data)
    {
        if (data.Length > ushort.MaxValue) throw new ArgumentException("字段过长。");
        writer.Write((ushort)data.Length);
        writer.Write(data);
    }

    private static byte[] ReadBlob(BinaryReader reader)
    {
        var length = reader.ReadUInt16();
        var data = reader.ReadBytes(length);
        if (data.Length != length) throw new EndOfStreamException();
        return data;
    }
}

/// <summary>
/// 配对结果：共享密钥 + 派生好的控制通道密钥。
/// </summary>
public sealed class HapVerifyResult
{
    /// <summary>共享密钥：瞬态配对为 SRP 会话密钥 K（64B SHA-512）；正常配对为 X25519 ECDH 结果（32B）。</summary>
    public byte[] SharedSecret { get; init; } = Array.Empty<byte>();

    /// <summary>控制通道：我方发送方向密钥（32B，ChaCha20-Poly1305 key）。</summary>
    public byte[] ControllerWriteKey { get; init; } = Array.Empty<byte>();

    /// <summary>控制通道：我方接收方向密钥（32B）。</summary>
    public byte[] ControllerReadKey { get; init; } = Array.Empty<byte>();

    /// <summary>是否瞬态配对。</summary>
    public bool IsTransient { get; init; }

    /// <summary>创建控制通道的 HAP 加密会话（在同一条 TCP 连接上长期使用）。</summary>
    public HapSessionCrypt CreateControlSession() => new(ControllerWriteKey, ControllerReadKey);

    /// <summary>用共享密钥派生任意通道密钥（事件/数据通道用）。</summary>
    public (byte[] WriteKey, byte[] ReadKey) DeriveChannelKeys(string salt, string writeInfo, string readInfo)
        => HapKeyDerivation.DeriveChannelKeys(SharedSecret, salt, writeInfo, readInfo);
}

/// <summary>
/// HAP 配对客户端：pair-setup（首次配对，需要 PIN）、pair-verify（已配对后每次连接）、
/// transient（瞬态，无需 PIN 与持久化；HomePod/Apple TV 推荐）。
/// </summary>
/// <remarks>
/// <para>典型调用（瞬态，HomePod / Apple TV）：</para>
/// <code>
/// // transport 内部：POST 到设备 7000 端口，路径由本类给出；必须同一条 TCP 连接。
/// var result = await HapPairing.TransientAsync(transport, ct);
/// var session = result.CreateControlSession();
/// // 之后该连接上读到的字节先 session.Decrypt，写出的字节先 session.Encrypt。
/// </code>
/// <para>普通配对（需要设备显示 4 位 PIN，调用方异步等待用户输入）：</para>
/// <code>
/// var credentials = await HapPairing.SetupAsync(transport, async ct => await ui.AskPinAsync(ct), ct);
/// localConfig.Save(credentials.ToBase64());
/// // 下次连接：
/// var result = await HapPairing.VerifyAsync(transport, credentials, ct);
/// </code>
/// </remarks>
public static class HapPairing
{
    /// <summary>
    /// 默认 User-Agent。设备会做 UA 白名单校验：HomePod 实测只接受
    /// "AirPlay/…" 或 "iTunes/…"，自定义 UA（如 Zilux2/1.0）会返回 403。
    /// </summary>
    public const string DefaultUserAgent = "AirPlay/320.20";

    /// <summary>pair-setup 端点。</summary>
    public const string PairSetupPath = "/pair-setup";

    /// <summary>pair-verify 端点。</summary>
    public const string PairVerifyPath = "/pair-verify";

    /// <summary>pair-pin-start 端点（让设备显示 PIN；瞬态流程也先调一次）。</summary>
    public const string PairPinStartPath = "/pair-pin-start";

    /// <summary>瞬态配对固定 PIN（HAP 规范：3939）。</summary>
    public const string TransientPin = SrpClient.HapTransientPin;

    /// <summary>pair-setup / pair-verify 使用的 Content-Type。</summary>
    public const string BinaryContentType = "application/octet-stream";

    /// <summary>X-Apple-HKP 值：正常 HAP 配对。</summary>
    public const string HkpNormal = "3";

    /// <summary>X-Apple-HKP 值：瞬态配对（AirPlay 2 用 4 + Flags=0x10）。</summary>
    public const string HkpTransient = "4";

    /// <summary>
    /// 正常 HAP 配对（pair-setup M1–M6）。设备会显示 4 位 PIN，通过 <paramref name="pinProvider"/> 异步获取。
    /// </summary>
    /// <param name="transport">HTTP 传输（同一条 TCP 长连接）。</param>
    /// <param name="pinProvider">异步获取用户输入的 PIN。</param>
    /// <param name="cancellationToken">取消标记。</param>
    /// <param name="trace">可选调试日志回调（真机联调时打印中间值）。</param>
    /// <returns>长期配对凭据，调用方应持久化。</returns>
    /// <exception cref="HapPairingException">设备返回错误或 SRP/签名校验失败。</exception>
    public static async Task<HapCredentials> SetupAsync(
        HapPairingTransport transport,
        Func<CancellationToken, Task<string>> pinProvider,
        CancellationToken cancellationToken = default,
        Action<string>? trace = null)
    {
        ArgumentNullException.ThrowIfNull(transport);
        ArgumentNullException.ThrowIfNull(pinProvider);

        // 1) 让设备进入配对模式并显示 PIN（无 body）。失败不致命，部分设备无此端点。
        await TryStartPinAsync(transport, cancellationToken, trace).ConfigureAwait(false);

        // 2) M1：Method=0(PairSetup), State=1
        var m1 = new HapTlvBuilder()
            .AddByte(HapTlvType.Method, 0)
            .AddByte(HapTlvType.State, 1)
            .Build();
        trace?.Invoke($"pair-setup M1 请求：{CryptoPrimitives.ToHexUpper(m1)}");
        var m2Response = await SendTlvAsync(transport, PairSetupPath, HkpNormal, m1, cancellationToken, trace)
            .ConfigureAwait(false);
        var (_, m2) = ParseDeviceTlv(m2Response, 2);
        var salt = HapTlv.Require(m2, HapTlvType.Salt, "Salt");
        var serverPublicKey = HapTlv.Require(m2, HapTlvType.PublicKey, "PublicKey");
        trace?.Invoke($"pair-setup M2：Salt={CryptoPrimitives.ToHexUpper(salt)} ({salt.Length}B)，" +
                      $"B={CryptoPrimitives.ToHexUpper(serverPublicKey)} ({serverPublicKey.Length}B)");

        // 3) 等用户输入 PIN，跑 SRP 客户端
        var pin = await pinProvider(cancellationToken).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(pin))
            throw new HapPairingException(HapPairingError.Rejected, "用户未输入配对 PIN。");

        var srp = SrpClient.CreateHapPairSetup(pin.Trim());
        var clientProof = srp.ComputeProof(salt, serverPublicKey);
        trace?.Invoke($"pair-setup SRP：A={CryptoPrimitives.ToHexUpper(srp.PublicKey)}，proof={CryptoPrimitives.ToHexUpper(clientProof)}");

        // 4) M3：State=3, PublicKey=A, Proof=M1
        var m3 = new HapTlvBuilder()
            .AddByte(HapTlvType.State, 3)
            .Add(HapTlvType.PublicKey, srp.PublicKey)
            .Add(HapTlvType.Proof, clientProof)
            .Build();
        var m4Response = await SendTlvAsync(transport, PairSetupPath, HkpNormal, m3, cancellationToken, trace)
            .ConfigureAwait(false);
        var (_, m4) = ParseDeviceTlv(m4Response, 4);
        var serverProof = HapTlv.GetValue(m4, HapTlvType.Proof);
        if (serverProof is not null && !srp.VerifyServerProof(serverProof))
            throw new HapPairingException(HapPairingError.AuthenticationError,
                $"pair-setup M4 服务器证明校验失败（期望 {CryptoPrimitives.ToHexUpper(srp.ExpectedServerProof)}，" +
                $"实际 {CryptoPrimitives.ToHexUpper(serverProof)}）。");
        trace?.Invoke("pair-setup M4：服务器 SRP 证明校验通过。");

        // 5) M5：用 SRP 会话密钥加密我方长期 Ed25519 公钥与签名
        var sessionKey = srp.SessionKey;
        var clientLtsk = CryptoPrimitives.RandomBytes(Ed25519.SeedSize);
        var clientLtpk = Ed25519.GetPublicKey(clientLtsk);
        var clientId = Encoding.UTF8.GetBytes(Guid.NewGuid().ToString("D"));

        var controllerX = CryptoPrimitives.HkdfSha512(
            sessionKey, "Pair-Setup-Controller-Sign-Salt", "Pair-Setup-Controller-Sign-Info", 32);
        var signInfo = CryptoPrimitives.Concat(controllerX, clientId, clientLtpk);
        var clientSignature = Ed25519.Sign(clientLtsk, signInfo);

        var subTlv = new HapTlvBuilder()
            .Add(HapTlvType.Identifier, clientId)
            .Add(HapTlvType.PublicKey, clientLtpk)
            .Add(HapTlvType.Signature, clientSignature)
            .Build();
        var encryptKey = CryptoPrimitives.HkdfSha512(
            sessionKey, "Pair-Setup-Encrypt-Salt", "Pair-Setup-Encrypt-Info", 32);
        var encrypted = EncryptTlvChaCha(encryptKey, "PS-Msg05", subTlv);
        var m5 = new HapTlvBuilder()
            .AddByte(HapTlvType.State, 5)
            .Add(HapTlvType.EncryptedData, encrypted)
            .Build();
        var m6Response = await SendTlvAsync(transport, PairSetupPath, HkpNormal, m5, cancellationToken, trace)
            .ConfigureAwait(false);
        var (_, m6) = ParseDeviceTlv(m6Response, 6);
        var encryptedAccessory = HapTlv.Require(m6, HapTlvType.EncryptedData, "EncryptedData");
        var accessorySubTlv = DecryptTlvChaCha(encryptKey, "PS-Msg06", encryptedAccessory);

        // 6) 校验设备长期公钥签名（pair_homekit.c: pair_setup_response3 用
        //    info = accessory_x || accessory_id || accessory_ltpk 验证）
        var accessoryItems = HapTlv.Parse(accessorySubTlv);
        var accessoryId = HapTlv.Require(accessoryItems, HapTlvType.Identifier, "Identifier");
        var accessoryLtpk = HapTlv.Require(accessoryItems, HapTlvType.PublicKey, "PublicKey");
        var accessorySignature = HapTlv.Require(accessoryItems, HapTlvType.Signature, "Signature");
        var accessoryX = CryptoPrimitives.HkdfSha512(
            sessionKey, "Pair-Setup-Accessory-Sign-Salt", "Pair-Setup-Accessory-Sign-Info", 32);
        var accessorySignInfo = CryptoPrimitives.Concat(accessoryX, accessoryId, accessoryLtpk);
        if (!Ed25519.Verify(accessoryLtpk, accessorySignInfo, accessorySignature))
            throw new HapPairingException(HapPairingError.AuthenticationError,
                "pair-setup M6 设备长期公钥签名校验失败（可能是伪造设备或协议实现不兼容）。");

        trace?.Invoke($"pair-setup 完成：accessoryId={Encoding.UTF8.GetString(accessoryId)}，" +
                      $"accessoryLtpk={CryptoPrimitives.ToHexUpper(accessoryLtpk)}");

        return new HapCredentials
        {
            AccessoryId = accessoryId,
            AccessoryLtpk = accessoryLtpk,
            ClientId = clientId,
            ClientLtsk = clientLtsk,
            IsTransient = false,
        };
    }

    /// <summary>
    /// 正常 HAP pair-verify（M1–M4）：已配对设备每次新连接时使用，成功后得到会话密钥。
    /// </summary>
    /// <exception cref="HapPairingException">设备返回错误或签名校验失败。</exception>
    public static async Task<HapVerifyResult> VerifyAsync(
        HapPairingTransport transport,
        HapCredentials credentials,
        CancellationToken cancellationToken = default,
        Action<string>? trace = null)
    {
        ArgumentNullException.ThrowIfNull(transport);
        ArgumentNullException.ThrowIfNull(credentials);
        if (!credentials.IsValid)
            throw new ArgumentException("配对凭据不完整（需要 AccessoryLtpk/ClientLtsk/ClientId/AccessoryId）。", nameof(credentials));

        // 1) 生成 X25519 临时密钥对，M1：State=1, PublicKey=客户端临时公钥
        var (clientPrivate, clientPublic) = X25519.GenerateKeyPair();
        var m1 = new HapTlvBuilder()
            .AddByte(HapTlvType.State, 1)
            .Add(HapTlvType.PublicKey, clientPublic)
            .Build();
        var m2Response = await SendTlvAsync(transport, PairVerifyPath, HkpNormal, m1, cancellationToken, trace)
            .ConfigureAwait(false);
        var (_, m2) = ParseDeviceTlv(m2Response, 2);
        var serverPublic = HapTlv.Require(m2, HapTlvType.PublicKey, "PublicKey");
        var encryptedM2 = HapTlv.Require(m2, HapTlvType.EncryptedData, "EncryptedData");
        trace?.Invoke($"pair-verify M2：serverEphPub={CryptoPrimitives.ToHexUpper(serverPublic)}");

        // 2) ECDH → 解密并验证设备长期公钥签名
        var sharedSecret = X25519.ComputeSharedSecret(clientPrivate, serverPublic);
        var sessionKey = CryptoPrimitives.HkdfSha512(
            sharedSecret, "Pair-Verify-Encrypt-Salt", "Pair-Verify-Encrypt-Info", 32);
        var accessoryTlv = DecryptTlvChaCha(sessionKey, "PV-Msg02", encryptedM2);
        var accessoryItems = HapTlv.Parse(accessoryTlv);
        var accessoryId = HapTlv.Require(accessoryItems, HapTlvType.Identifier, "Identifier");
        var accessorySignature = HapTlv.Require(accessoryItems, HapTlvType.Signature, "Signature");
        if (!CryptoPrimitives.FixedTimeEquals(accessoryId, credentials.AccessoryId))
            throw new HapPairingException(HapPairingError.AuthenticationError,
                "pair-verify：设备标识与已存凭据不一致（设备可能已重置）。");

        // pair_homekit.c: info = 服务器临时公钥 || accessory_id || 客户端临时公钥
        var verifyInfo = CryptoPrimitives.Concat(serverPublic, accessoryId, clientPublic);
        if (!Ed25519.Verify(credentials.AccessoryLtpk, verifyInfo, accessorySignature))
            throw new HapPairingException(HapPairingError.AuthenticationError,
                "pair-verify M2：设备签名校验失败（设备长期公钥不匹配或已被重置）。");
        trace?.Invoke("pair-verify M2：设备签名校验通过。");

        // 3) M3：我方签名（info = 客户端临时公钥 || client_id || 服务器临时公钥）
        var clientSignInfo = CryptoPrimitives.Concat(clientPublic, credentials.ClientId, serverPublic);
        var clientSignature = Ed25519.Sign(credentials.ClientLtsk, clientSignInfo);
        var clientSubTlv = new HapTlvBuilder()
            .Add(HapTlvType.Identifier, credentials.ClientId)
            .Add(HapTlvType.Signature, clientSignature)
            .Build();
        var encryptedM3 = EncryptTlvChaCha(sessionKey, "PV-Msg03", clientSubTlv);
        var m3 = new HapTlvBuilder()
            .AddByte(HapTlvType.State, 3)
            .Add(HapTlvType.EncryptedData, encryptedM3)
            .Build();
        var m4Response = await SendTlvAsync(transport, PairVerifyPath, HkpNormal, m3, cancellationToken, trace)
            .ConfigureAwait(false);
        if (m4Response.Body.Length > 0)
        {
            var (_, m4) = ParseDeviceTlv(m4Response, 4);
            var error = HapTlv.GetValue(m4, HapTlvType.Error);
            if (error is not null) throw DeviceError(error, m4, "pair-verify M4");
        }
        trace?.Invoke("pair-verify M4：验证成功。");

        var (writeKey, readKey) = HapKeyDerivation.DeriveControlKeys(sharedSecret);
        return new HapVerifyResult
        {
            SharedSecret = sharedSecret,
            ControllerWriteKey = writeKey,
            ControllerReadKey = readKey,
            IsTransient = false,
        };
    }

    /// <summary>
    /// 瞬态配对（transient，X-Apple-HKP: 4）：无需用户输入 PIN、无需持久化凭据。
    /// HomePod / Apple TV 的 AirPlay 2 音频投送用这条路径；配对完成即可用返回的
    /// 控制通道密钥加密整条连接（不需要 pair-verify）。
    /// </summary>
    /// <exception cref="HapPairingException">设备返回错误或 M4 证明校验失败。</exception>
    public static async Task<HapVerifyResult> TransientAsync(
        HapPairingTransport transport,
        CancellationToken cancellationToken = default,
        Action<string>? trace = null)
    {
        ArgumentNullException.ThrowIfNull(transport);

        await TryStartPinAsync(transport, cancellationToken, trace).ConfigureAwait(false);

        // M1：Method=0, State=1, Flags=0x10(transient)
        var m1 = new HapTlvBuilder()
            .AddByte(HapTlvType.Method, 0)
            .AddByte(HapTlvType.State, 1)
            .AddByte(HapTlvType.Flags, 0x10)
            .Build();
        trace?.Invoke($"transient pair-setup M1：{CryptoPrimitives.ToHexUpper(m1)}");
        var m2Response = await SendTlvAsync(transport, PairSetupPath, HkpTransient, m1, cancellationToken, trace)
            .ConfigureAwait(false);
        var (_, m2) = ParseDeviceTlv(m2Response, 2);
        var salt = HapTlv.Require(m2, HapTlvType.Salt, "Salt");
        var serverPublicKey = HapTlv.Require(m2, HapTlvType.PublicKey, "PublicKey");
        trace?.Invoke($"transient M2：Salt={CryptoPrimitives.ToHexUpper(salt)}，B 长度={serverPublicKey.Length}B");

        var srp = SrpClient.CreateHapPairSetup(TransientPin);
        var clientProof = srp.ComputeProof(salt, serverPublicKey);
        trace?.Invoke($"transient SRP：A={CryptoPrimitives.ToHexUpper(srp.PublicKey)}，proof={CryptoPrimitives.ToHexUpper(clientProof)}");

        var m3 = new HapTlvBuilder()
            .AddByte(HapTlvType.State, 3)
            .Add(HapTlvType.PublicKey, srp.PublicKey)
            .Add(HapTlvType.Proof, clientProof)
            .Build();
        var m4Response = await SendTlvAsync(transport, PairSetupPath, HkpTransient, m3, cancellationToken, trace)
            .ConfigureAwait(false);

        // M4：若设备回 Proof 则校验（SRP 自洽性证据）；不回也不阻塞（部分实现只回 State=4）。
        if (m4Response.Body.Length > 0)
        {
            var (_, m4) = ParseDeviceTlv(m4Response, 4);
            var error = HapTlv.GetValue(m4, HapTlvType.Error);
            if (error is not null) throw DeviceError(error, m4, "transient pair-setup");
            var serverProof = HapTlv.GetValue(m4, HapTlvType.Proof);
            if (serverProof is not null && !srp.VerifyServerProof(serverProof))
                throw new HapPairingException(HapPairingError.AuthenticationError,
                    "transient pair-setup M4：设备 SRP 证明校验失败（PIN 或协议路径不匹配）。");
            trace?.Invoke("transient M4：设备 SRP 证明校验通过。");
        }

        // 瞬态：共享密钥 = SRP 会话密钥 K；之后控制通道密钥直接由 K 派生，无需 pair-verify。
        var sessionKey = srp.SessionKey;
        var (writeKey, readKey) = HapKeyDerivation.DeriveControlKeys(sessionKey);
        trace?.Invoke($"transient 完成：K={CryptoPrimitives.ToHexUpper(sessionKey)}");
        trace?.Invoke($"控制通道 writeKey={CryptoPrimitives.ToHexUpper(writeKey)} readKey={CryptoPrimitives.ToHexUpper(readKey)}");

        return new HapVerifyResult
        {
            SharedSecret = sessionKey,
            ControllerWriteKey = writeKey,
            ControllerReadKey = readKey,
            IsTransient = true,
        };
    }

    /// <summary>单独触发 /pair-pin-start（让设备显示 PIN）。</summary>
    public static async Task StartPinAsync(
        HapPairingTransport transport, bool transient = false, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(transport);
        var headers = BuildHeaders(transient ? HkpTransient : HkpNormal);
        var response = await transport("POST", PairPinStartPath, headers, Array.Empty<byte>(), cancellationToken)
            .ConfigureAwait(false);
        if (!response.IsSuccess)
            throw new HapPairingException(HapPairingError.ProtocolError,
                $"/pair-pin-start 返回 HTTP {response.StatusCode}。");
    }

    /// <summary>构造标准配对请求头。</summary>
    public static Dictionary<string, string> BuildHeaders(string hkp, string? userAgent = null) => new()
    {
        ["User-Agent"] = userAgent ?? DefaultUserAgent,
        ["Connection"] = "keep-alive",
        ["X-Apple-HKP"] = hkp,
        ["Content-Type"] = BinaryContentType,
        ["Accept"] = "*/*",
    };

    // ---------------------------------------------------------------------
    // 内部工具
    // ---------------------------------------------------------------------

    private static async Task TryStartPinAsync(
        HapPairingTransport transport, CancellationToken cancellationToken, Action<string>? trace)
    {
        try
        {
            var headers = BuildHeaders(HkpNormal);
            var response = await transport("POST", PairPinStartPath, headers, Array.Empty<byte>(), cancellationToken)
                .ConfigureAwait(false);
            trace?.Invoke($"POST {PairPinStartPath} → HTTP {response.StatusCode}");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // 设备没有该端点时忽略（不影响后续 pair-setup）。
            trace?.Invoke($"POST {PairPinStartPath} 失败（忽略）：{ex.Message}");
        }
    }

    /// <summary>发送一个 TLV8 请求并检查 HTTP 状态，返回响应。</summary>
    private static async Task<HapHttpResponse> SendTlvAsync(
        HapPairingTransport transport,
        string path,
        string hkp,
        byte[] body,
        CancellationToken cancellationToken,
        Action<string>? trace)
    {
        var response = await transport("POST", path, BuildHeaders(hkp), body, cancellationToken)
            .ConfigureAwait(false);
        trace?.Invoke($"POST {path} → HTTP {response.StatusCode}，{response.Body.Length} 字节" +
                      (response.Body.Length <= 64 ? $"，body={CryptoPrimitives.ToHexUpper(response.Body)}" : string.Empty));
        if (!response.IsSuccess)
            throw new HapPairingException(HapPairingError.ProtocolError,
                $"POST {path} 失败：HTTP {response.StatusCode}，body={CryptoPrimitives.ToHexUpper(response.Body)}。");
        return response;
    }

    /// <summary>解析设备 TLV 响应：先查 Error TLV（有则抛设备错误），再校验 State。</summary>
    private static (byte State, IReadOnlyList<HapTlvItem> Items) ParseDeviceTlv(HapHttpResponse response, byte expectedState)
    {
        if (response.Body.Length == 0)
            throw new HapPairingException(HapPairingError.TlvError,
                $"设备响应为空（期望 State={expectedState}）。");

        IReadOnlyList<HapTlvItem> items;
        try
        {
            items = HapTlv.Parse(response.Body);
        }
        catch (FormatException ex)
        {
            throw new HapPairingException(HapPairingError.TlvError,
                $"设备响应不是合法 TLV8：{ex.Message}，body={CryptoPrimitives.ToHexUpper(response.Body)}");
        }

        var error = HapTlv.GetValue(items, HapTlvType.Error);
        if (error is not null)
        {
            var code = error.Length > 0 ? error[0] : (byte)HapPairingError.UnknownError;
            throw new HapPairingException((HapPairingError)code, DescribeDeviceError(code, items));
        }

        return HapTlv.ParseWithState(response.Body, expectedState);
    }

    private static HapPairingException DeviceError(byte[] error, IReadOnlyList<HapTlvItem> items, string step)
    {
        var code = error.Length > 0 ? error[0] : (byte)HapPairingError.UnknownError;
        return new HapPairingException((HapPairingError)code, $"{step}：{DescribeDeviceError(code, items)}");
    }

    private static string DescribeDeviceError(byte code, IReadOnlyList<HapTlvItem> items)
    {
        var name = (HapPairingError)code switch
        {
            HapPairingError.UnknownError => "UnknownError(1)",
            HapPairingError.AuthenticationError => "AuthenticationError(2)",
            HapPairingError.BackoffError => "BackoffError(3)：设备要求退避，稍后重试",
            HapPairingError.MaxPeersError => "MaxPeersError(4)：配对数量已达上限",
            HapPairingError.MaxTriesError => "MaxTriesError(5)：PIN 尝试次数过多",
            HapPairingError.UnavailableError => "UnavailableError(6)：设备暂不可用",
            HapPairingError.BusyError => "BusyError(7)：设备忙",
            _ => $"Error({code})",
        };
        var retryDelay = HapTlv.GetValue(items, HapTlvType.RetryDelay);
        if (retryDelay is { Length: > 0 })
            name += $"（RetryDelay={retryDelay[0]}s）";
        return $"设备返回配对错误 {name}。";
    }

    /// <summary>HAP 子 TLV 用 ChaCha20-Poly1305 加密：nonce = 4 个 0x00 + 8 字节 ASCII 消息名，AAD 为空。</summary>
    private static byte[] EncryptTlvChaCha(byte[] key, string messageName, byte[] plaintext)
    {
        var nonce = BuildMessageNonce(messageName);
        var cipher = new byte[plaintext.Length];
        var tag = new byte[16];
        using var chacha = new ChaCha20Poly1305(key);
        chacha.Encrypt(nonce, plaintext, cipher, tag);
        return CryptoPrimitives.Concat(cipher, tag);
    }

    /// <summary>解密 HAP 子 TLV（密文 + 16B tag）。</summary>
    private static byte[] DecryptTlvChaCha(byte[] key, string messageName, byte[] ciphertextWithTag)
    {
        if (ciphertextWithTag.Length < 16)
            throw new HapPairingException(HapPairingError.TlvError,
                $"{messageName} 密文过短（{ciphertextWithTag.Length} 字节）。");
        var nonce = BuildMessageNonce(messageName);
        var cipher = ciphertextWithTag.AsSpan(0, ciphertextWithTag.Length - 16);
        var tag = ciphertextWithTag.AsSpan(ciphertextWithTag.Length - 16);
        var plaintext = new byte[cipher.Length];
        using var chacha = new ChaCha20Poly1305(key);
        try
        {
            chacha.Decrypt(nonce, cipher, tag, plaintext);
        }
        catch (CryptographicException ex)
        {
            throw new HapPairingException(HapPairingError.AuthenticationError,
                $"{messageName} 解密失败：密钥不匹配或数据被篡改。", ex);
        }
        return plaintext;
    }

    private static byte[] BuildMessageNonce(string messageName)
    {
        var name = Encoding.ASCII.GetBytes(messageName);
        if (name.Length != 8)
            throw new ArgumentException($"HAP 消息名必须是 8 字节 ASCII，实际 {name.Length} 字节。", nameof(messageName));
        var nonce = new byte[12];
        name.CopyTo(nonce, 4); // 前 4 字节为 0
        return nonce;
    }
}
