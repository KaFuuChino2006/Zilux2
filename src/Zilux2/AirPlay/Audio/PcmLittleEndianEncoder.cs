using Zilux2.AirPlay.Protocol;

namespace Zilux2.AirPlay.Audio;

/// <summary>
/// Passes the 352-frame stereo frame through as raw little-endian 16-bit PCM.
/// <para>
/// AirPlay 2 receivers that advertise PCM in their mDNS codec list (<c>cn=0,...</c>, which is what
/// the HomePod mini reports) are sent <c>ct = 1</c> and an <c>audioFormat</c> of <c>1 &lt;&lt; 11</c>;
/// the payload is then plain interleaved L16 instead of an ALAC bitstream. The AirFlash reference
/// engine does exactly this when the codec list contains PCM.
/// </para>
/// </summary>
internal sealed class PcmLittleEndianEncoder : IAirPlayAudioEncoder
{
    /// <summary>352 frames × 2 channels × 2 bytes.</summary>
    public const int PacketSize = RaopConnection.SamplesPerFrame * 2 * 2;

    /// <inheritdoc />
    public int FrameSamples => RaopConnection.SamplesPerFrame;

    /// <inheritdoc />
    public int MaxPacketBytes => PacketSize;

    /// <inheritdoc />
    public int Encode(ReadOnlySpan<short> pcm, Span<byte> destination)
    {
        if (pcm.Length != FrameSamples * 2 || destination.Length < PacketSize)
        {
            return -1;
        }

        for (var i = 0; i < pcm.Length; i++)
        {
            var sample = pcm[i];
            destination[i * 2] = (byte)sample;
            destination[i * 2 + 1] = (byte)(sample >> 8);
        }

        return PacketSize;
    }
}
