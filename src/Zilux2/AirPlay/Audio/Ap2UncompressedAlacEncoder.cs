namespace Zilux2.AirPlay.Audio;

/// <summary>
/// AirPlay 2 realtime streams (<c>type 0x60</c>) are decoded as ALAC no matter what
/// <c>ct</c>/<c>audioFormat</c> the receiver is told, so the AP2 path does not send
/// compressed ALAC: it sends <em>uncompressed</em> ALAC ("escape") frames, which is
/// exactly what the receiver's hard-coded realtime ALAC decoder expects.
/// Frame layout (MSB-first bit stream, 352 frames of 16-bit stereo):
/// <code>
/// 3  bits  channel tag        = 1 (stereo CPE)
/// 4  bits  unused             = 0
/// 12 bits  unknown            = 0
/// 1  bit   hasSize            = 0 (use the cookie's 352-frame default)
/// 2  bits  wastedBytes        = 0
/// 1  bit   isNotCompressed    = 1 (escape / uncompressed)
/// 352 x { L16, R16 }          = 11264 bits
/// 3  bits  END element        = 7
/// (zero pad to the next byte boundary)
/// </code>
/// </summary>
internal sealed class Ap2UncompressedAlacEncoder : IAirPlayAudioEncoder
{
    /// <summary>Room for the escape frame plus the transport overhead.</summary>
    public const int PacketBudget = 1428;

    private const int SamplesPerFrame = 352;
    private const int Channels = 2;

    /// <summary>352 frames per packet, same as classic RAOP.</summary>
    public int FrameSamples => SamplesPerFrame;

    public int MaxPacketBytes => PacketBudget;

    /// <summary>Encodes 352 interleaved stereo frames into one uncompressed ALAC frame.</summary>
    /// <returns>Bytes written, or -1 when the input/output length is wrong.</returns>
    public int Encode(ReadOnlySpan<short> pcm, Span<byte> destination)
    {
        if (pcm.Length != SamplesPerFrame * Channels || destination.Length < PacketBudget)
        {
            return -1;
        }

        var writer = new BitWriter(destination);
        writer.Write(1, 3);    // stereo channel-pair element
        writer.Write(0, 4);    // unused
        writer.Write(0, 12);   // unknown
        writer.Write(0, 1);    // hasSize = 0 -> default frame length (352)
        writer.Write(0, 2);    // wasted bytes
        writer.Write(1, 1);    // isNotCompressed = 1

        for (var i = 0; i < pcm.Length; i++)
        {
            writer.Write(unchecked((ushort)pcm[i]), 16);
        }

        writer.Write(7, 3);    // END element
        return writer.Flush();
    }

    private ref struct BitWriter
    {
        private readonly Span<byte> _destination;
        private int _byteIndex;
        private byte _current;
        private int _filled;

        public BitWriter(Span<byte> destination)
        {
            _destination = destination;
            _byteIndex = 0;
            _current = 0;
            _filled = 0;
        }

        public void Write(uint value, int bits)
        {
            for (var i = bits - 1; i >= 0; i--)
            {
                _current = (byte)((_current << 1) | (int)((value >> i) & 1u));
                if (++_filled == 8)
                {
                    _destination[_byteIndex++] = _current;
                    _current = 0;
                    _filled = 0;
                }
            }
        }

        public int Flush()
        {
            if (_filled > 0)
            {
                _current = (byte)(_current << (8 - _filled));
                _destination[_byteIndex++] = _current;
                _filled = 0;
            }

            return _byteIndex;
        }
    }
}
