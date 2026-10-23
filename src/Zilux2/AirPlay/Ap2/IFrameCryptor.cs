using System.Buffers.Binary;
using System.IO;
using System.Security.Cryptography;

namespace Zilux2.AirPlay.Ap2;

/// <summary>
/// Byte-stream codec for the HAP encrypted RTSP channel (AirPlay 2 after a successful
/// <c>/pair-setup</c>). One connection switches from plaintext to encrypted once the pairing
/// exchange finishes, so both directions are treated as streams rather than individual messages:
/// <see cref="Encrypt"/> may split a large plaintext into several frames and <see cref="Decrypt"/>
/// may return an empty array when only part of a frame has arrived (the remainder is buffered
/// inside the implementation).
///
/// This mirrors the frozen <c>Zilux2.AirPlay.Crypto.HapSessionCrypt</c> surface
/// (<c>Encrypt</c>/<c>Decrypt</c>/<c>BufferedCiphertextLength</c>); a thin adapter can wrap the
/// real HAP session without touching <see cref="HapEncryptedTransport"/>.
/// </summary>
internal interface IFrameCryptor
{
    /// <summary>Encrypts plaintext into one or more complete HAP frames.</summary>
    byte[] Encrypt(ReadOnlySpan<byte> plaintext);

    /// <summary>Decrypts as many complete frames as were received; returns the plaintext bytes.</summary>
    byte[] Decrypt(ReadOnlySpan<byte> ciphertext);

    /// <summary>Ciphertext bytes buffered by <see cref="Decrypt"/> because their frame is incomplete.</summary>
    int BufferedCiphertextLength { get; }
}

/// <summary>
/// Plaintext pass-through used for the initial <c>/pair-setup</c> exchange (before the channel is
/// encrypted) and by device mocks. It never buffers.
/// </summary>
internal sealed class NullFrameCryptor : IFrameCryptor
{
    public static NullFrameCryptor Instance { get; } = new();

    public int BufferedCiphertextLength => 0;

    public byte[] Encrypt(ReadOnlySpan<byte> plaintext) => plaintext.ToArray();

    public byte[] Decrypt(ReadOnlySpan<byte> ciphertext) => ciphertext.ToArray();
}

/// <summary>
/// Standalone HAP-style frame codec: <c>[2B LE plaintext length][ChaCha20-Poly1305 ciphertext][16B tag]</c>,
/// AAD = the 2 length bytes, nonce = 4 zero bytes followed by an 8-byte little-endian counter.
/// Keys are supplied by the caller, which lets the loopback test drive the whole AP2 stack before
/// crypto-dev's real SRP/pairing lands. <see cref="HapSessionCrypt"/> will replace it verbatim.
/// </summary>
internal sealed class TestFrameCryptor : IFrameCryptor
{
    public const int MaxFramePayload = 1024;
    public const int TagSize = 16;
    public const int LengthSize = 2;

    private readonly byte[] _key;
    private readonly MemoryStream _pending = new(4096);
    private ulong _counter;

    public TestFrameCryptor(ReadOnlySpan<byte> key)
    {
        if (key.Length != 32)
        {
            throw new ArgumentException("The frame key must be 32 bytes (ChaCha20-Poly1305).", nameof(key));
        }

        _key = key.ToArray();
    }

    public int BufferedCiphertextLength => (int)_pending.Length;

    public byte[] Encrypt(ReadOnlySpan<byte> plaintext)
    {
        if (plaintext.Length == 0)
        {
            return [];
        }

        var frameCount = (plaintext.Length + MaxFramePayload - 1) / MaxFramePayload;
        var output = new byte[plaintext.Length + (frameCount * (LengthSize + TagSize))];
        var written = 0;
        var offset = 0;
        while (offset < plaintext.Length)
        {
            var chunk = Math.Min(MaxFramePayload, plaintext.Length - offset);
            var lengthField = output.AsSpan(written, LengthSize);
            BinaryPrimitives.WriteUInt16LittleEndian(lengthField, (ushort)chunk);

            var ciphertext = output.AsSpan(written + LengthSize, chunk);
            var tag = output.AsSpan(written + LengthSize + chunk, TagSize);
            using (var aead = new ChaCha20Poly1305(_key))
            {
                aead.Encrypt(CreateNonce(_counter++), plaintext.Slice(offset, chunk), ciphertext, tag, lengthField);
            }

            written += LengthSize + chunk + TagSize;
            offset += chunk;
        }

        return output;
    }

    public byte[] Decrypt(ReadOnlySpan<byte> ciphertext)
    {
        if (ciphertext.Length > 0)
        {
            _pending.Write(ciphertext);
        }

        var buffer = _pending.GetBuffer();
        var available = (int)_pending.Length;
        var consumed = 0;
        var output = new MemoryStream(available);
        while (available - consumed >= LengthSize + TagSize)
        {
            var frameLength = BinaryPrimitives.ReadUInt16LittleEndian(buffer.AsSpan(consumed, LengthSize));
            if (frameLength is 0 or > MaxFramePayload)
            {
                throw new InvalidDataException($"Malformed HAP frame length ({frameLength}).");
            }

            if (available - consumed - LengthSize < frameLength + TagSize)
            {
                break;
            }

            var lengthField = buffer.AsSpan(consumed, LengthSize).ToArray();
            var ciphertextSlice = buffer.AsSpan(consumed + LengthSize, frameLength);
            var tag = buffer.AsSpan(consumed + LengthSize + frameLength, TagSize);
            var plaintext = new byte[frameLength];
            using (var aead = new ChaCha20Poly1305(_key))
            {
                aead.Decrypt(CreateNonce(_counter++), ciphertextSlice, tag, plaintext, lengthField);
            }

            output.Write(plaintext);
            consumed += LengthSize + frameLength + TagSize;
        }

        if (consumed > 0)
        {
            var remaining = available - consumed;
            if (remaining > 0)
            {
                Buffer.BlockCopy(buffer, consumed, buffer, 0, remaining);
            }

            _pending.SetLength(remaining);
            _pending.Position = remaining;
        }

        return output.ToArray();
    }

    private static byte[] CreateNonce(ulong counter)
    {
        var nonce = new byte[12];
        BinaryPrimitives.WriteUInt64LittleEndian(nonce.AsSpan(4), counter);
        return nonce;
    }
}
