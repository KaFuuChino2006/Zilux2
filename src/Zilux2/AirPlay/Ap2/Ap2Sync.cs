using System.Buffers.Binary;

namespace Zilux2.AirPlay.Ap2;

/// <summary>
/// Builds the AP2 sync packet that maps the RTP audio timeline onto the receiver's clock.
/// Two variants exist, matching the negotiation-time timing protocol:
/// <list type="bullet">
///   <item><b>NTP</b> — 20 bytes, second byte <c>0xD4</c> (reference <c>sync_packet</c> NTP branch).</item>
///   <item><b>PTP</b> — 28 bytes, second byte <c>0xD7</c>, carrying the raw Unix-epoch nanosecond
///   clock sample and the PTP master's clock identity (reference <c>sync_packet</c> PTP branch,
///   verified to produce audio on HomePod OS 27).</item>
/// </list>
/// Shared shape: the first byte carries the marker bit on the very first sync of a session,
/// followed by a two-byte sequence number, the RTP timestamp of the newest audio packet, the
/// clock sample, and the RTP timestamp the receiver should be playing right now
/// (<c>rtp - latency</c>). Shifting the playback mapping by the latency again (as an earlier
/// revision did) would double the audible latency.
/// </summary>
internal static class Ap2Sync
{
    /// <summary>Sequence field of an NTP-timing sync packet (bytes 2..4).</summary>
    public const ushort NtpSequenceNumber = 7;

    /// <summary>Sequence field of a PTP-timing sync packet (bytes 2..4, reference writes 6).</summary>
    public const ushort PtpSequenceNumber = 6;

    /// <summary>Size of an NTP-timing sync packet.</summary>
    public const int NtpPacketSize = 20;

    /// <summary>Size of a PTP-timing sync packet.</summary>
    public const int PtpPacketSize = 28;

    /// <summary>Second byte of an NTP-timing sync packet.</summary>
    public const byte NtpPayloadType = 0xD4;

    /// <summary>Second byte of a PTP-timing sync packet.</summary>
    public const byte PtpPayloadType = 0xD7;

    /// <summary>RTP timestamp of the audio the receiver should be playing at the sync instant.</summary>
    public static uint PlaybackTimestamp(uint currentRtpTimestamp, uint latencyFrames) =>
        currentRtpTimestamp - latencyFrames;

    /// <summary>Serialises an NTP-timing sync packet (20 bytes).</summary>
    public static byte[] BuildNtp(bool first, uint latencyFrames, uint currentRtpTimestamp, ulong ntp)
    {
        var packet = new byte[NtpPacketSize];
        // Reference (airflash rtp.rs sync_packet, NTP branch): [2..4] = 7, [16..20] = rtp (not
        // rtp-latency; latencyMin is applied by the receiver on the NTP path too).
        WriteCommon(packet, first, NtpPayloadType, NtpSequenceNumber, currentRtpTimestamp,
            currentRtpTimestamp);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(8), (uint)(ntp >> 32));
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(12), (uint)ntp);
        return packet;
    }

    /// <summary>Serialises a PTP-timing sync packet (28 bytes).</summary>
    public static byte[] BuildPtp(bool first, uint latencyFrames, uint currentRtpTimestamp, ulong nowUnixNanoseconds, ulong clockId)
    {
        var packet = new byte[PtpPacketSize];
        // Reference (airflash rtp.rs sync_packet, PTP branch): [2..4] = 6, [16..20] = rtp-latency,
        // [20..28] = clock identity. The receiver keys the PTP interpretation off bytes 2..4 and
        // the trailing clock id, so these fields must not look like the NTP variant.
        WriteCommon(packet, first, PtpPayloadType, PtpSequenceNumber, currentRtpTimestamp,
            PlaybackTimestamp(currentRtpTimestamp, latencyFrames));
        BinaryPrimitives.WriteUInt64BigEndian(packet.AsSpan(8), nowUnixNanoseconds);
        BinaryPrimitives.WriteUInt64BigEndian(packet.AsSpan(20), clockId);
        return packet;
    }

    private static void WriteCommon(byte[] packet, bool first, byte payloadType, ushort sequence, uint currentRtp, uint playbackRtp)
    {
        packet[0] = first ? (byte)0x90 : (byte)0x80;
        packet[1] = payloadType;
        BinaryPrimitives.WriteUInt16BigEndian(packet.AsSpan(2), sequence);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(4), currentRtp);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(16), playbackRtp);
    }

    /// <summary>Converts raw Unix-epoch nanoseconds to the 64-bit NTP fixed-point timestamp.</summary>
    public static ulong UnixNanosecondsToNtp(ulong unixNanoseconds)
    {
        var seconds = unixNanoseconds / 1_000_000_000UL + NtpEpochOffsetSeconds;
        var fraction = (unixNanoseconds % 1_000_000_000UL) * 4_294_967_296UL / 1_000_000_000UL;
        return (seconds << 32) | fraction;
    }

    /// <summary>Seconds between 1900-01-01 (NTP epoch) and 1970-01-01 (Unix epoch).</summary>
    public const ulong NtpEpochOffsetSeconds = 2_208_988_800UL;

    /// <summary>Current wall-clock time as raw Unix-epoch nanoseconds.</summary>
    public static ulong WallClockUnixNanoseconds()
    {
        var now = DateTime.UtcNow;
        var ticksSinceUnixEpoch = now.Ticks - DateTime.UnixEpoch.Ticks;
        return (ulong)ticksSinceUnixEpoch * 100UL;
    }
}
