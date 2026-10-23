// -----------------------------------------------------------------------------
// Zilux2 - AirPlay 2 / HAP 会话加密（控制通道、事件通道、数据通道通用）
//
// 协议依据（重要，勿凭记忆改）：
//   * shairport-sync  pair_ap/pair_homekit.c  encrypt/decrypt（约 2993-3120 行）
//   * pyatv           pyatv/auth/hap_session.py
// 两个实现完全一致，帧格式为：
//
//   [2 字节小端明文长度 len] [len 字节 ChaCha20-Poly1305 密文] [16 字节 tag]
//
//   - 单帧明文最长 1024 字节（ENCRYPTED_LEN_MAX = 0x400），超长时按 1024 切片分多帧；
//   - AAD（附加认证数据）= 帧首那 2 字节小端长度字段本身；
//   - nonce = 4 个 0x00 + 8 字节小端计数器（共 12 字节），每个方向独立计数，从 0 开始；
//   - 加密算法 ChaCha20-Poly1305-IETF（.NET 里的 ChaCha20Poly1305 就是 IETF 变体）。
//
// 这是「字节流级」加密：在需要加密的通道上，所有数据（包括 HTTP 请求头/响应头、
// RTSP 报文、事件报文……）都被连续地切帧加密，不区分消息边界。因此本类不能对
// 每次 Write 独立使用，必须由同一个 HapSessionCrypt 实例贯穿整条连接，
// 且发送侧与接收侧各用一个实例方向（写 key / 读 key）绑定。
// -----------------------------------------------------------------------------

using System.Buffers.Binary;
using System.IO;
using System.Security.Cryptography;

namespace Zilux2.AirPlay.Crypto;

/// <summary>
/// HAP 通道密钥派生。HAP 中所有通道密钥都是 HKDF-SHA512(shared_secret, salt, info, 32)。
/// </summary>
/// <remarks>
/// 协议依据：pair_ap/pair_homekit.c pair_keys_map（第 85-124 行）、pyatv/auth/__init__.py。
/// 方向约定（我方 = controller / 客户端）：
///   Write = 我方发往设备的数据（本机加密，设备解密）；
///   Read  = 设备发往我方的数据（设备加密，本机解密）。
/// </remarks>
public static class HapKeyDerivation
{
    /// <summary>控制通道（RTSP/HTTP 主连接）HKDF salt。</summary>
    public const string ControlSalt = "Control-Salt";

    /// <summary>控制通道：我方发送方向的 info。</summary>
    public const string ControlWriteInfo = "Control-Write-Encryption-Key";

    /// <summary>控制通道：我方接收方向的 info。</summary>
    public const string ControlReadInfo = "Control-Read-Encryption-Key";

    /// <summary>事件通道 HKDF salt。</summary>
    public const string EventsSalt = "Events-Salt";

    /// <summary>事件通道：我方发送方向的 info。</summary>
    public const string EventsWriteInfo = "Events-Write-Encryption-Key";

    /// <summary>事件通道：我方接收方向的 info。</summary>
    public const string EventsReadInfo = "Events-Read-Encryption-Key";

    /// <summary>数据通道（音频数据流）HKDF salt 前缀，实际 salt = 前缀 + seed 的十进制字符串。</summary>
    public const string DataStreamSaltPrefix = "DataStream-Salt";

    /// <summary>数据通道：我方输出（发送）方向的 info。</summary>
    public const string DataStreamWriteInfo = "DataStream-Output-Encryption-Key";

    /// <summary>数据通道：我方输入（接收）方向的 info。</summary>
    public const string DataStreamReadInfo = "DataStream-Input-Encryption-Key";

    /// <summary>通道密钥长度（固定 32 字节，即 ChaCha20-Poly1305 的 key）。</summary>
    public const int ChannelKeyLength = 32;

    /// <summary>
    /// 派生控制通道密钥（pair-setup / pair-verify 完成后使用）。
    /// </summary>
    /// <param name="sharedSecret">瞬态配对 = SRP 会话密钥 K（SHA-512 输出 64 字节）；正常配对 = X25519 ECDH 共享密钥（32 字节）。</param>
    public static (byte[] WriteKey, byte[] ReadKey) DeriveControlKeys(ReadOnlySpan<byte> sharedSecret) =>
        DeriveChannelKeys(sharedSecret, ControlSalt, ControlWriteInfo, ControlReadInfo);

    /// <summary>派生事件通道密钥。</summary>
    public static (byte[] WriteKey, byte[] ReadKey) DeriveEventKeys(ReadOnlySpan<byte> sharedSecret) =>
        DeriveChannelKeys(sharedSecret, EventsSalt, EventsWriteInfo, EventsReadInfo);

    /// <summary>
    /// 派生数据通道（AP2 音频流）密钥。
    /// </summary>
    /// <param name="sharedSecret">pair-verify 得到的共享密钥。</param>
    /// <param name="seed">SETUP 阶段 plist 下发的 seed（单次会话随机数）。</param>
    public static (byte[] WriteKey, byte[] ReadKey) DeriveDataStreamKeys(ReadOnlySpan<byte> sharedSecret, ulong seed)
    {
        // salt 是「DataStream-Salt」拼上 seed 的十进制文本，例如 "DataStream-Salt15014746994705656022"。
        var salt = DataStreamSaltPrefix + seed.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return DeriveChannelKeys(sharedSecret, salt, DataStreamWriteInfo, DataStreamReadInfo);
    }

    /// <summary>派生一对通道密钥（写方向 + 读方向）。</summary>
    public static (byte[] WriteKey, byte[] ReadKey) DeriveChannelKeys(
        ReadOnlySpan<byte> sharedSecret, string salt, string writeInfo, string readInfo)
    {
        ArgumentNullException.ThrowIfNull(salt);
        ArgumentNullException.ThrowIfNull(writeInfo);
        ArgumentNullException.ThrowIfNull(readInfo);
        if (sharedSecret.Length == 0)
            throw new ArgumentException("共享密钥不能为空。", nameof(sharedSecret));

        var writeKey = CryptoPrimitives.HkdfSha512(sharedSecret, salt, writeInfo, ChannelKeyLength);
        var readKey = CryptoPrimitives.HkdfSha512(sharedSecret, salt, readInfo, ChannelKeyLength);
        return (writeKey, readKey);
    }
}

/// <summary>
/// HAP 加密会话：对一条通道的双向字节流做 ChaCha20-Poly1305 分帧加解密。
/// </summary>
/// <remarks>
/// 用法（一条 TCP 连接创建一次，长期持有）：
/// <code>
/// var session = new HapSessionCrypt(writeKey, readKey);
/// stream.Write(session.Encrypt(plainBytes));          // 任意长度，内部自动分帧
/// var plain = session.Decrypt(cipherBytesFromSocket); // 必须在同一实例上按到达顺序调用
/// </code>
/// 注意：<see cref="Decrypt"/> 是流式的，可能返回空数组（此时表示还没有收全一帧），
/// 未消费的密文由内部缓冲保存，调用方不需要自己拼包。
/// </remarks>
public sealed class HapSessionCrypt : IDisposable
{
    /// <summary>单帧明文最大长度（协议常量 ENCRYPTED_LEN_MAX = 0x400）。</summary>
    public const int MaxPlaintextFrame = 1024;

    /// <summary>Poly1305 认证标签长度。</summary>
    public const int TagSize = 16;

    /// <summary>帧长度字段长度（小端 ushort）。</summary>
    public const int LengthFieldSize = 2;

    /// <summary>nonce 长度。</summary>
    public const int NonceSize = 12;

    private readonly ChaCha20Poly1305 _writeCipher;
    private readonly ChaCha20Poly1305 _readCipher;
    private readonly object _readLock = new();

    private ulong _writeCounter;
    private ulong _readCounter;

    // 接收方向：未凑满一帧的密文留在缓冲区里，下次 Decrypt 继续消费。
    private byte[] _readBuffer = new byte[MaxPlaintextFrame + LengthFieldSize + TagSize];
    private int _readBufferLength;
    private bool _disposed;

    /// <summary>用写/读方向的 32 字节通道密钥创建会话。</summary>
    /// <param name="writeKey">我方发送方向密钥（32 字节）。</param>
    /// <param name="readKey">我方接收方向密钥（32 字节）。</param>
    public HapSessionCrypt(ReadOnlySpan<byte> writeKey, ReadOnlySpan<byte> readKey)
    {
        if (writeKey.Length != HapKeyDerivation.ChannelKeyLength)
            throw new ArgumentException($"写密钥必须是 {HapKeyDerivation.ChannelKeyLength} 字节，实际 {writeKey.Length} 字节。", nameof(writeKey));
        if (readKey.Length != HapKeyDerivation.ChannelKeyLength)
            throw new ArgumentException($"读密钥必须是 {HapKeyDerivation.ChannelKeyLength} 字节，实际 {readKey.Length} 字节。", nameof(readKey));

        _writeCipher = new ChaCha20Poly1305(writeKey);
        _readCipher = new ChaCha20Poly1305(readKey);
    }

    /// <summary>已发送的帧数（写方向计数器）。</summary>
    public ulong WriteCounter => _writeCounter;

    /// <summary>已成功解密的帧数（读方向计数器）。</summary>
    public ulong ReadCounter => _readCounter;

    /// <summary>接收缓冲区里尚未凑成一帧的密文字节数。</summary>
    public int BufferedCiphertextLength
    {
        get
        {
            lock (_readLock) return _readBufferLength;
        }
    }

    /// <summary>
    /// 加密一段明文，返回可直接写入网络的帧字节流。
    /// 明文按 1024 字节切片，每片独立成帧。
    /// </summary>
    public byte[] Encrypt(ReadOnlySpan<byte> plaintext)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (plaintext.Length == 0) return Array.Empty<byte>();

        var frameCount = (plaintext.Length + MaxPlaintextFrame - 1) / MaxPlaintextFrame;
        var output = new byte[plaintext.Length + frameCount * (LengthFieldSize + TagSize)];

        Span<byte> nonce = stackalloc byte[NonceSize];
        var sourceOffset = 0;
        var destinationOffset = 0;
        while (sourceOffset < plaintext.Length)
        {
            var chunkLength = Math.Min(MaxPlaintextFrame, plaintext.Length - sourceOffset);

            // AAD 就是帧首的长度字段本身，所以先把长度写进输出缓冲区，再拿它当 AAD。
            var lengthField = output.AsSpan(destinationOffset, LengthFieldSize);
            BinaryPrimitives.WriteUInt16LittleEndian(lengthField, (ushort)chunkLength);

            BuildNonce(nonce, _writeCounter);
            var ciphertext = output.AsSpan(destinationOffset + LengthFieldSize, chunkLength);
            var tag = output.AsSpan(destinationOffset + LengthFieldSize + chunkLength, TagSize);
            _writeCipher.Encrypt(nonce, plaintext.Slice(sourceOffset, chunkLength), ciphertext, tag, lengthField);

            _writeCounter++;
            sourceOffset += chunkLength;
            destinationOffset += LengthFieldSize + chunkLength + TagSize;
        }

        return output;
    }

    /// <summary>
    /// 喂入从网络收到的密文字节，返回本轮能完整解密出的明文字节。
    /// 不完整的帧留在内部缓冲区，等后续字节到达后继续解。
    /// </summary>
    /// <exception cref="CryptographicException">认证失败（密钥错误或数据被篡改）。</exception>
    public byte[] Decrypt(ReadOnlySpan<byte> ciphertext)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (ciphertext.Length == 0) return Array.Empty<byte>();

        lock (_readLock)
        {
            EnsureBufferCapacity(_readBufferLength + ciphertext.Length);
            ciphertext.CopyTo(_readBuffer.AsSpan(_readBufferLength));
            _readBufferLength += ciphertext.Length;

            using var plaintext = new MemoryStream(_readBufferLength);
            Span<byte> nonce = stackalloc byte[NonceSize];
            var offset = 0;
            while (_readBufferLength - offset >= LengthFieldSize)
            {
                var chunkLength = BinaryPrimitives.ReadUInt16LittleEndian(_readBuffer.AsSpan(offset, LengthFieldSize));
                if (chunkLength > MaxPlaintextFrame)
                    throw new CryptographicException($"HAP 帧长度非法：{chunkLength} 字节（上限 {MaxPlaintextFrame}）。");

                var frameLength = LengthFieldSize + chunkLength + TagSize;
                if (_readBufferLength - offset < frameLength) break; // 还有半帧，等下一次数据

                var lengthField = _readBuffer.AsSpan(offset, LengthFieldSize);
                var encrypted = _readBuffer.AsSpan(offset + LengthFieldSize, chunkLength);
                var tag = _readBuffer.AsSpan(offset + LengthFieldSize + chunkLength, TagSize);
                var plain = new byte[chunkLength];
                BuildNonce(nonce, _readCounter);
                try
                {
                    _readCipher.Decrypt(nonce, encrypted, tag, plain, lengthField);
                }
                catch (CryptographicException ex)
                {
                    throw new CryptographicException(
                        "HAP 帧解密失败：通道密钥不匹配或数据被篡改（可能设备已重置配对）。", ex);
                }

                _readCounter++;
                plaintext.Write(plain, 0, plain.Length);
                offset += frameLength;
            }

            // 把没消费完的尾巴挪到缓冲区开头，保持流式语义。
            var remaining = _readBufferLength - offset;
            if (remaining > 0 && offset > 0)
                Buffer.BlockCopy(_readBuffer, offset, _readBuffer, 0, remaining);
            _readBufferLength = remaining;

            return plaintext.ToArray();
        }
    }

    /// <summary>丢弃接收缓冲区里的残留密文（例如检测到流被重置时）。</summary>
    public void ResetReadBuffer()
    {
        lock (_readLock) _readBufferLength = 0;
    }

    /// <summary>nonce = 4 个 0x00 + 8 字节小端计数器。</summary>
    private static void BuildNonce(Span<byte> nonce, ulong counter)
    {
        nonce[..4].Clear();
        BinaryPrimitives.WriteUInt64LittleEndian(nonce[4..], counter);
    }

    private void EnsureBufferCapacity(int needed)
    {
        if (needed <= _readBuffer.Length) return;

        // 按 1.5 倍增长，避免每收到一个 TCP 分片都重新分配。
        var size = _readBuffer.Length;
        while (size < needed) size = size + (size >> 1) + 1;
        Array.Resize(ref _readBuffer, size);
    }

    /// <summary>释放底层加密对象。</summary>
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _writeCipher.Dispose();
        _readCipher.Dispose();
    }
}
