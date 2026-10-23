namespace Zilux2.AirPlay.Audio;

/// <summary>
/// Minimal encoder contract the RAOP stream pump needs: 352 stereo frames of 16-bit PCM
/// (1408 bytes) in, one ALAC packet out. Implemented by the managed ALAC encoder.
/// </summary>
internal interface IAirPlayAudioEncoder
{
    /// <summary>Samples per channel in one packet (RAOP requires 352).</summary>
    int FrameSamples { get; }

    /// <summary>Largest packet the encoder can emit for one frame.</summary>
    int MaxPacketBytes { get; }

    /// <summary>
    /// Encodes exactly <c>FrameSamples * 2</c> interleaved int16 samples.
    /// Returns the number of bytes written to <paramref name="destination"/>.
    /// </summary>
    int Encode(ReadOnlySpan<short> pcm, Span<byte> destination);
}
