using Zilux2.AirPlay.Alac;
using Zilux2.AirPlay.Protocol;

namespace Zilux2.AirPlay.Audio;

/// <summary>
/// Adapts the managed <see cref="AlacEncoder"/> to the streaming pump contract.
/// One RAOP audio packet carries exactly 352 frames of 16-bit stereo PCM (1408 bytes).
/// </summary>
internal sealed class AlacAudioEncoder : IAirPlayAudioEncoder
{
    /// <summary>Largest ALAC payload a 352-frame stereo packet can produce (matches TuneBlade's MaxALACPacketSize).</summary>
    public const int PacketBudget = 1428;

    private readonly AlacEncoder _encoder = new();

    public AlacAudioEncoder()
    {
        _encoder.Init(RaopConnection.SampleRate, channels: 2, bitDepth: 16, frameLength: RaopConnection.SamplesPerFrame);
    }

    public int FrameSamples => _encoder.FrameLength;

    public int MaxPacketBytes => PacketBudget;

    public int Encode(ReadOnlySpan<short> pcm, Span<byte> destination)
    {
        try
        {
            return _encoder.EncodeFrame(pcm, destination);
        }
        catch (ArgumentException)
        {
            // The pump should never hand us a bad frame; surface it as "drop this frame" instead of
            // tearing the whole stream down.
            return -1;
        }
        catch (InvalidOperationException)
        {
            return -1;
        }
    }
}
