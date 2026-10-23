namespace Zilux2.Audio;

/// <summary>
/// Pull-style interleaved float PCM source for the AirPlay streamer.
/// <para>
/// The default implementation is <see cref="LoopbackCapture"/> (system output). When the page taps
/// its own audio graph instead, <see cref="PcmTapSource"/> implements the same surface so AirPlay
/// carries only this app's sound and other apps keep playing on the local speakers.
/// </para>
/// </summary>
internal interface IAirPlayAudioSource : IDisposable
{
    /// <summary>Input sample rate in Hz (the tap configures the page's AudioContext to match).</summary>
    int SampleRate { get; }

    /// <summary>Channel count of the interleaved samples (normally 2).</summary>
    int Channels { get; }

    /// <summary>Blocks up to <paramref name="timeoutMilliseconds"/> until audio is available.</summary>
    bool WaitForData(int timeoutMilliseconds);

    /// <summary>Reads interleaved float samples; returns the number of floats written.</summary>
    int ReadInterleaved(float[] destination);
}
