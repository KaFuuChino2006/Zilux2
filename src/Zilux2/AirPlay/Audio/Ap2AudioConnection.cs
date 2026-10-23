using Zilux2.AirPlay.Ap2;
using Zilux2.AirPlay.Protocol;

namespace Zilux2.AirPlay.Audio;

/// <summary>
/// Adapts the AirPlay 2 stack (<see cref="Ap2Connection"/>) to <see cref="IAirPlayConnection"/> so
/// the capture → resample → ALAC pipeline works unchanged on both transports.
/// <para>
/// The heavy lifting (transient HAP pairing, encrypted RTSP channel, AP2 audio packets) stays in
/// <c>Zilux2.AirPlay.Ap2</c>; this type only meets the interface and owns the connection lifetime.
/// </para>
/// </summary>
internal sealed class Ap2AudioConnection : IAirPlayConnection
{
    /// <summary>User agent for the encrypted RTSP channel (devices whitelist Apple agents).</summary>
    public const string DefaultUserAgent = "iTunes/12.12.10 (Windows; Microsoft Windows 10 x64)";

    private readonly Ap2Connection _connection;
    private int _volumePercent = 70;

    private Ap2AudioConnection(Ap2Connection connection)
    {
        ArgumentNullException.ThrowIfNull(connection);
        _connection = connection;
    }

    /// <inheritdoc />
    public string TargetName => _connection.Target.Name;

    /// <inheritdoc />
    public string TargetHost => _connection.Target.Host;

    /// <inheritdoc />
    public int VolumePercent => Volatile.Read(ref _volumePercent);

    /// <summary>Exposes the underlying AP2 session for diagnostics and tests.</summary>
    public Ap2Connection Connection => _connection;

    /// <summary>
    /// Connects with an AirPlay 2 receiver: transient HAP pairing on the plaintext socket, then the
    /// encrypted OPTIONS/SETUP handshake. Throws on any failure so <see cref="AirPlayService"/> can
    /// fall back to classic RAOP.
    /// </summary>
    /// <param name="pinProvider">
    /// Receivers that reject transient pairing (macOS "AirPlay Receiver" answers HTTP 470) show a
    /// 4-digit PIN and need HAP PIN pairing instead; when this is set the caller-provided callback
    /// resolves the PIN from the UI (it fires right after the receiver displays it).
    /// </param>
    public static Ap2AudioConnection Create(
        RaopTarget target,
        RaopOptions? options = null,
        bool useAlac = false,
        int latencyMilliseconds = 120,
        Func<CancellationToken, Task<string>>? pinProvider = null)
    {
        ArgumentNullException.ThrowIfNull(target);

        // AirFlash uses latencyMin == latencyMax == latency_ms * rate / 1000 (120 ms realtime).
        // A larger latency buys tolerance against jitter/retransmits when the network is noisy.
        var latencyFrames = Math.Clamp(latencyMilliseconds, 20, 1000) * RaopConnection.SampleRate / 1000;

        var ap2Target = new Ap2Target
        {
            Name = target.Name,
            Host = target.Host,
            Port = target.Port,
            DeviceId = target.HardwareAddress,
        };

        var ap2Options = new Ap2Options
        {
            UserAgent = options?.UserAgent ?? DefaultUserAgent,
            ConnectTimeoutMilliseconds = options?.ConnectTimeoutMilliseconds ?? 5_000,
            IoTimeoutMilliseconds = options?.IoTimeoutMilliseconds ?? 10_000,
            DeviceId = target.HardwareAddress ?? "AA:BB:CC:DD:EE:FF",

            // HomePod mini advertises PCM next to ALAC in its mDNS codec list (cn=0,1,2,3), so the
            // AirFlash engine negotiates PCM: ct=1, audioFormat=1<<11 and plain L16 payloads. The
            // codec stays selectable because some receivers decode ALAC regardless of ct.
            UseAlac = useAlac,

            // AirFlash uses latencyMin == latencyMax == latency_ms * rate / 1000 (120 ms realtime).
            LatencyMin = latencyFrames,
            LatencyMax = latencyFrames,
        };

        var trace = new Action<string>(message => HostLog.Info($"[airplay] ap2 pair {message}"));
        var pairing = pinProvider is null
            ? Ap2Pairing.CreateTransientHandler(trace: trace)
            // macOS remembers this controller after the first PIN, so later connects pair-verify
            // silently and only a fresh/reset pairing shows the 4-digit code again.
            : Ap2Pairing.CreateStoredPinHandler(target.Host, pinProvider, trace: trace);

        return new Ap2AudioConnection(Ap2Connection.Connect(ap2Target, ap2Options, pairing));
    }

    /// <inheritdoc />
    public void BeginStreaming() => _connection.BeginStreaming();

    /// <inheritdoc />
    public bool SendAudioFrame(ReadOnlySpan<byte> encodedPayload) =>
        _connection.SendAudioFrame(encodedPayload);

    /// <inheritdoc />
    public void SetVolume(int percent)
    {
        Volatile.Write(ref _volumePercent, Math.Clamp(percent, 0, 100));
        _connection.SetVolume(percent);
    }

    /// <inheritdoc />
    public void Flush() => _connection.Flush();

    /// <inheritdoc />
    public void Teardown() => _connection.Teardown();

    /// <inheritdoc />
    public void Dispose() => _connection.Dispose();
}
