using System.Buffers.Binary;
using System.Security.Cryptography;

namespace Zilux2.AirPlay.Ap2;

/// <summary>
/// AirPlay 2 realtime audio packet. On the wire it is a normal 12-byte RTP header followed by the
/// encrypted payload:
/// <code>
/// [0]      0x80                          RTP version 2
/// [1]      0xE0 first packet / 0x60      marker + payload type 96 (L16/ALAC passthrough)
/// [2..4)   sequence number, big endian
/// [4..8)   RTP timestamp, big endian
/// [8..12)  SSRC, big endian
/// [12..)   ChaCha20-Poly1305 ciphertext
/// [..+16)  16-byte Poly1305 tag
/// [..+8)   8-byte nonce field (last 8 bytes of the 12-byte AEAD nonce)
/// </code>
/// The AEAD key is the stream key from the SETUP plist (<c>shk</c>), the AAD is the 8 header bytes
/// <c>timestamp + ssrc</c> and the nonce is four zero bytes followed by the trailing 8-byte nonce
/// field (generated randomly per packet and shipped inside the packet itself). The reference
/// implementation (airplay2-sender-cpp, <c>sendAudioPacket_</c>) and shairport-sync's receiver both
/// use exactly this framing; a header without the two RTP prefix bytes makes the receiver drop audio.
/// </summary>
internal static class Ap2AudioPacket
{
    public const int SequenceSize = 2;

    public const int TimestampSize = 4;

    public const int SsrcSize = 4;

    /// <summary>First header byte: RTP version 2, no padding/extension/CSRC.</summary>
    public const byte VersionByte = 0x80;

    /// <summary>Second header byte for regular packets: payload type 96, marker clear.</summary>
    public const byte PayloadTypeByte = 0x60;

    /// <summary>Second header byte for the first audio packet: payload type 96, marker set.</summary>
    public const byte FirstPacketPayloadTypeByte = 0xE0;

    /// <summary>Offset of the sequence number inside the RTP header.</summary>
    public const int SequenceOffset = 2;

    /// <summary>Offset of the RTP timestamp inside the RTP header (also the start of the AAD).</summary>
    public const int TimestampOffset = 4;

    /// <summary>Offset of the SSRC inside the RTP header.</summary>
    public const int SsrcOffset = 8;

    public const int HeaderSize = 12;

    public const int TagSize = 16;

    public const int NonceFieldSize = 8;

    /// <summary>Fixed per-packet overhead: header + AEAD tag + nonce field.</summary>
    public const int Overhead = HeaderSize + TagSize + NonceFieldSize;

    /// <summary>Conservative upper bound that keeps a packet inside a typical 1500-byte MTU.</summary>
    public const int MaxPayloadBytes = 1_440;

    /// <summary>Builds one encrypted AP2 audio packet with a random trailing nonce.</summary>
    public static byte[] Build(
        ushort sequence,
        uint rtpTimestamp,
        uint ssrc,
        ReadOnlySpan<byte> audioKey,
        ReadOnlySpan<byte> payload,
        bool firstPacket = false) =>
        Build(sequence, rtpTimestamp, ssrc, audioKey, payload, firstPacket, ReadOnlySpan<byte>.Empty);

    /// <summary>Builds one encrypted AP2 audio packet; an 8-byte <paramref name="nonceField"/> pins the nonce (tests).</summary>
    public static byte[] Build(
        ushort sequence,
        uint rtpTimestamp,
        uint ssrc,
        ReadOnlySpan<byte> audioKey,
        ReadOnlySpan<byte> payload,
        ReadOnlySpan<byte> nonceField) =>
        Build(sequence, rtpTimestamp, ssrc, audioKey, payload, false, nonceField);

    /// <summary>Builds one encrypted AP2 audio packet with explicit marker and trailing nonce.</summary>
    public static byte[] Build(
        ushort sequence,
        uint rtpTimestamp,
        uint ssrc,
        ReadOnlySpan<byte> audioKey,
        ReadOnlySpan<byte> payload,
        bool firstPacket,
        ReadOnlySpan<byte> nonceField)
    {
        if (audioKey.Length != 32)
        {
            throw new ArgumentException("The AP2 audio key (shk) must be 32 bytes.", nameof(audioKey));
        }

        if (payload.Length is 0 or > MaxPayloadBytes)
        {
            throw new ArgumentOutOfRangeException(nameof(payload), payload.Length, "AP2 audio payload must be 1..1440 bytes.");
        }

        if (nonceField.Length is not (0 or NonceFieldSize))
        {
            throw new ArgumentException("The nonce field must be 8 bytes (or empty for a random nonce).", nameof(nonceField));
        }

        var packet = new byte[Overhead + payload.Length];
        packet[0] = VersionByte;
        packet[1] = firstPacket ? FirstPacketPayloadTypeByte : PayloadTypeByte;
        BinaryPrimitives.WriteUInt16BigEndian(packet.AsSpan(SequenceOffset, SequenceSize), sequence);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(TimestampOffset, TimestampSize), rtpTimestamp);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(SsrcOffset, SsrcSize), ssrc);

        var trailingNonce = packet.AsSpan(HeaderSize + payload.Length + TagSize, NonceFieldSize);
        if (nonceField.Length == NonceFieldSize)
        {
            nonceField.CopyTo(trailingNonce);
        }
        else
        {
            RandomNumberGenerator.Fill(trailingNonce);
        }

        var nonce = new byte[12];
        trailingNonce.CopyTo(nonce.AsSpan(4));

        var aad = packet.AsSpan(TimestampOffset, TimestampSize + SsrcSize);
        using var aead = new ChaCha20Poly1305(audioKey);
        aead.Encrypt(
            nonce,
            payload,
            packet.AsSpan(HeaderSize, payload.Length),
            packet.AsSpan(HeaderSize + payload.Length, TagSize),
            aad);
        return packet;
    }

    /// <summary>
    /// Verifies and decrypts one AP2 audio packet. Returns false when the packet is truncated or the
    /// tag does not authenticate (wrong key/AAD/nonce).
    /// </summary>
    public static bool TryDecrypt(
        ReadOnlySpan<byte> packet,
        ReadOnlySpan<byte> audioKey,
        Span<byte> payloadDestination,
        out ushort sequence,
        out uint rtpTimestamp,
        out uint ssrc,
        out int payloadLength)
    {
        sequence = 0;
        rtpTimestamp = 0;
        ssrc = 0;
        payloadLength = 0;

        if (audioKey.Length != 32 || packet.Length < Overhead)
        {
            return false;
        }

        if ((packet[0] & 0xC0) != VersionByte)
        {
            return false;
        }

        var length = packet.Length - Overhead;
        if (length > payloadDestination.Length)
        {
            return false;
        }

        sequence = BinaryPrimitives.ReadUInt16BigEndian(packet.Slice(SequenceOffset, SequenceSize));
        rtpTimestamp = BinaryPrimitives.ReadUInt32BigEndian(packet.Slice(TimestampOffset, TimestampSize));
        ssrc = BinaryPrimitives.ReadUInt32BigEndian(packet.Slice(SsrcOffset, SsrcSize));

        var nonce = new byte[12];
        packet.Slice(HeaderSize + length + TagSize, NonceFieldSize).CopyTo(nonce.AsSpan(4));
        var aad = packet.Slice(TimestampOffset, TimestampSize + SsrcSize);
        var ciphertext = packet.Slice(HeaderSize, length);
        var tag = packet.Slice(HeaderSize + length, TagSize);

        try
        {
            using var aead = new ChaCha20Poly1305(audioKey);
            aead.Decrypt(nonce, ciphertext, tag, payloadDestination[..length], aad);
        }
        catch (CryptographicException)
        {
            return false;
        }

        payloadLength = length;
        return true;
    }

    /// <summary>Expands the 8-byte trailing nonce field into the 12-byte ChaCha20-Poly1305 nonce.</summary>
    public static byte[] BuildNonce(ReadOnlySpan<byte> nonceField)
    {
        if (nonceField.Length != NonceFieldSize)
        {
            throw new ArgumentException("The nonce field must be 8 bytes.", nameof(nonceField));
        }

        var nonce = new byte[12];
        nonceField.CopyTo(nonce.AsSpan(4));
        return nonce;
    }
}
