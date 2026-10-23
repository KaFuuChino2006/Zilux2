namespace Zilux2.AirPlay.Audio;

/// <summary>
/// Transport abstraction for one live AirPlay session. Implemented by the classic RAOP
/// connection (<see cref="Protocol.RaopConnection"/>) and, later, by the AirPlay 2
/// (HAP-encrypted) connection. <see cref="AirPlayStreamer"/> only knows this surface, so the
/// capture/resample/encode pipeline is shared between both protocol generations.
/// </summary>
internal interface IAirPlayConnection : IDisposable
{
    /// <summary>Display name of the receiver this connection is bound to.</summary>
    string TargetName { get; }

    /// <summary>IPv4 address the receiver was reached on.</summary>
    string TargetHost { get; }

    /// <summary>Last volume that was pushed to the receiver (0-100).</summary>
    int VolumePercent { get; }

    /// <summary>Completes the handshake and starts the RTP clock (RECORD + sync timer).</summary>
    void BeginStreaming();

    /// <summary>Encodes and sends one audio payload; returns false when the frame was dropped.</summary>
    bool SendAudioFrame(ReadOnlySpan<byte> encodedPayload);

    /// <summary>Sets the receiver volume (0-100) immediately, if the session is live.</summary>
    void SetVolume(int percent);

    /// <summary>Drops the receiver-side buffer (used before recovery attempts).</summary>
    void Flush();

    /// <summary>Ends the RTSP session politely; safe before <see cref="IDisposable.Dispose"/>.</summary>
    void Teardown();
}
