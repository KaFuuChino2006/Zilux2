using System.Buffers.Binary;

namespace Zilux2.AirPlay.Protocol;

/// <summary>
/// RAOP (classic AirPlay 1 / AirTunes) packet types carried inside RTP payload-type byte.
/// </summary>
internal enum RaopPacketType : byte
{
    TimingRequest = 82,
    TimingResponse = 83,
    Sync = 84,
    ResendRequest = 85,
    ResendResponse = 86,
    Audio = 96,
}

/// <summary>4-byte RTP header used by RAOP. Version is always 2.</summary>
internal struct RtpHeader
{
    public const int Size = 4;
    public const byte Version2 = 2;

    public byte PayloadType;
    public ushort Sequence;
    public bool Marker;
    public bool Padding;
    public bool Extension;
    public byte SourceCount;

    public static RtpHeader Read(ReadOnlySpan<byte> source)
    {
        if (source.Length < Size)
        {
            throw new ArgumentException("RTP header needs at least 4 bytes.", nameof(source));
        }

        var b0 = source[0];
        var b1 = source[1];
        return new RtpHeader
        {
            Padding = (b0 & 0x20) != 0,
            Extension = (b0 & 0x10) != 0,
            SourceCount = (byte)(b0 & 0x0F),
            Marker = (b1 & 0x80) != 0,
            PayloadType = (byte)(b1 & 0x7F),
            Sequence = BinaryPrimitives.ReadUInt16BigEndian(source.Slice(2, 2)),
        };
    }

    public readonly void Write(Span<byte> destination)
    {
        if (destination.Length < Size)
        {
            throw new ArgumentException("RTP header needs at least 4 bytes.", nameof(destination));
        }

        destination[0] = (byte)((Version2 << 6) | (Padding ? 0x20 : 0) | (Extension ? 0x10 : 0) | SourceCount);
        destination[1] = (byte)((Marker ? 0x80 : 0) | (PayloadType & 0x7F));
        BinaryPrimitives.WriteUInt16BigEndian(destination.Slice(2, 2), Sequence);
    }

    public static RtpHeader Create(byte payloadType, ushort sequence, bool marker = false) => new()
    {
        PayloadType = payloadType,
        Sequence = sequence,
        Marker = marker,
    };
}

/// <summary>NTP timestamp: 32-bit seconds since 1900-01-01 + 32-bit fractional second.</summary>
internal readonly struct NtpTimestamp
{
    public const int Size = 8;
    public const uint NtpEpochOffset = 2_208_988_800u; // 1900-01-01 -> 1970-01-01 in seconds

    public readonly uint Seconds;
    public readonly uint Fraction;

    public NtpTimestamp(uint seconds, uint fraction)
    {
        Seconds = seconds;
        Fraction = fraction;
    }

    public static NtpTimestamp Now()
    {
        var utc = DateTime.UtcNow;
        var secondsSinceEpoch = (ulong)(utc - DateTime.UnixEpoch).TotalSeconds;
        // 100-ns ticks within the current second: 10_000_000 ticks == 1 s.
        var fraction = (uint)((ulong)(utc.Ticks % TimeSpan.TicksPerSecond) * 4_294_967_296UL / (ulong)TimeSpan.TicksPerSecond);
        return new NtpTimestamp((uint)secondsSinceEpoch + NtpEpochOffset, fraction);
    }

    public static NtpTimestamp FromDouble(double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value) || value < 0)
        {
            return new NtpTimestamp(0, 0);
        }

        var seconds = (uint)Math.Floor(value);
        var fraction = (uint)Math.Clamp((value - seconds) * 4_294_967_296.0, 0, uint.MaxValue);
        return new NtpTimestamp(seconds, fraction);
    }

    public readonly double ToDouble() => Seconds + Fraction / 4_294_967_296.0;

    public readonly void Write(Span<byte> destination)
    {
        BinaryPrimitives.WriteUInt32BigEndian(destination.Slice(0, 4), Seconds);
        BinaryPrimitives.WriteUInt32BigEndian(destination.Slice(4, 4), Fraction);
    }

    public static NtpTimestamp Read(ReadOnlySpan<byte> source) => new(
        BinaryPrimitives.ReadUInt32BigEndian(source.Slice(0, 4)),
        BinaryPrimitives.ReadUInt32BigEndian(source.Slice(4, 4)));
}

/// <summary>RAOP control/audio packet construction and parsing.</summary>
internal static class RaopPackets
{
    /// <summary>Bytes in the metadata prefix of an audio data packet: RTP header + timestamp + SSRC.</summary>
    public const int AudioPrefixSize = 12;

    /// <summary>Latency compensation used by TuneBlade when reporting the sync clock (882 samples = 20 ms).</summary>
    public const uint SyncLatencyCompensation = 882;

    /// <summary>Sequence number Apple devices expect on sync packets (constant, not a packet counter).</summary>
    public const ushort SyncSequenceNumber = 7;

    /// <summary>
    /// Building block for a sync packet: 20 bytes.
    /// Layout: RTP header (4) | RTP time of the next packet to play (4) | NTP now (8) | RTP time the device should play now (4).
    /// </summary>
    public static byte[] BuildSyncPacket(uint rtpTimeOfCurrentAudio, NtpTimestamp ntpNow, uint rtpNextPacketTime)
    {
        var packet = new byte[20];
        RtpHeader.Create((byte)RaopPacketType.Sync, SyncSequenceNumber, marker: true).Write(packet.AsSpan(0, 4));
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(4, 4), rtpTimeOfCurrentAudio);
        ntpNow.Write(packet.AsSpan(8, 8));
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(16, 4), rtpNextPacketTime);
        return packet;
    }

    /// <summary>Builds a 32-byte timing response echoing the origin (request transmit) time.</summary>
    public static byte[] BuildTimingResponse(ushort sequence, NtpTimestamp origin, NtpTimestamp received, NtpTimestamp sent)
    {
        var packet = new byte[32];
        RtpHeader.Create((byte)RaopPacketType.TimingResponse, sequence).Write(packet.AsSpan(0, 4));
        // bytes 4..7 are reserved and remain zero
        origin.Write(packet.AsSpan(8, 8));
        received.Write(packet.AsSpan(16, 8));
        sent.Write(packet.AsSpan(24, 8));
        return packet;
    }

    /// <summary>Parses a 32-byte timing request. Returns false for malformed input.</summary>
    public static bool TryParseTimingRequest(ReadOnlySpan<byte> packet, out ushort sequence, out NtpTimestamp origin)
    {
        sequence = 0;
        origin = default;
        if (packet.Length < 32)
        {
            return false;
        }

        var header = RtpHeader.Read(packet);
        if (header.PayloadType != (byte)RaopPacketType.TimingRequest)
        {
            return false;
        }

        sequence = header.Sequence;
        origin = NtpTimestamp.Read(packet.Slice(24, 8)); // request's transmit timestamp is the last field
        return true;
    }

    /// <summary>Parses an 8-byte resend request: RTP header + first missing sequence + packet count.</summary>
    public static bool TryParseResendRequest(ReadOnlySpan<byte> packet, out ushort firstSequence, out ushort count)
    {
        firstSequence = 0;
        count = 0;
        if (packet.Length < 8)
        {
            return false;
        }

        var header = RtpHeader.Read(packet);
        if (header.PayloadType != (byte)RaopPacketType.ResendRequest)
        {
            return false;
        }

        firstSequence = BinaryPrimitives.ReadUInt16BigEndian(packet.Slice(4, 2));
        count = BinaryPrimitives.ReadUInt16BigEndian(packet.Slice(6, 2));
        return true;
    }

    /// <summary>
    /// Wraps an already framed audio packet in a resend response header (4 bytes).
    /// The response sequence number is the packet size in 32-bit words.
    /// </summary>
    public static int BuildResendResponse(ReadOnlySpan<byte> audioPacket, Span<byte> destination)
    {
        var total = audioPacket.Length + 4;
        if (destination.Length < total)
        {
            throw new ArgumentException("Destination too small for resend response.", nameof(destination));
        }

        var words = (ushort)((audioPacket.Length + 3) / 4);
        RtpHeader.Create((byte)RaopPacketType.ResendResponse, words).Write(destination.Slice(0, 4));
        audioPacket.CopyTo(destination.Slice(4));
        return total;
    }

    /// <summary>
    /// Builds a complete audio packet: RTP header (4) | RTP timestamp (4) | SSRC (4) | payload.
    /// The returned buffer starts at the RTP header, i.e. it is ready to be sent as-is.
    /// </summary>
    public static byte[] BuildAudioPacket(ushort sequence, uint rtpTimestamp, uint ssrc, ReadOnlySpan<byte> payload)
    {
        var packet = new byte[AudioPrefixSize + payload.Length];
        RtpHeader.Create((byte)RaopPacketType.Audio, sequence).Write(packet.AsSpan(0, 4));
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(4, 4), rtpTimestamp);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(8, 4), ssrc);
        payload.CopyTo(packet.AsSpan(AudioPrefixSize));
        return packet;
    }
}
