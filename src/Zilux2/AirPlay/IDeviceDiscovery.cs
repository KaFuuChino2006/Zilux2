namespace Zilux2.AirPlay;

/// <summary>
/// Host-side DTO for one discovered receiver. Deliberately independent from the mDNS
/// implementation so the session orchestration (and the web contract payload) stays stable
/// while discovery internals evolve.
/// </summary>
internal sealed class AirPlayDeviceInfo
{
    /// <summary>Stable identifier used by the page (`airplay.connect`).</summary>
    public required string Id { get; init; }

    public required string Name { get; init; }

    public required string Host { get; init; }

    /// <summary>RAOP/AirPlay RTSP port; 7000 for AirPlay, 5000 for classic RAOP devices.</summary>
    public int Port { get; init; } = 7000;

    public string? Model { get; init; }

    /// <summary>True when the TXT record says the device asks for a password.</summary>
    public bool RequiresPassword { get; init; }

    /// <summary>True when the device advertises AirPlay 2 (vv / new srcvers).</summary>
    public bool SupportsAirPlay2 { get; init; }
}

/// <summary>
/// Zero-dependency mDNS discovery contract. Implementations raise <see cref="DevicesChanged"/>
/// from a background thread; consumers must marshal to their own thread.
/// </summary>
internal interface IAirPlayDeviceDiscovery : IDisposable
{
    event Action<IReadOnlyList<AirPlayDeviceInfo>>? DevicesChanged;

    bool IsRunning { get; }

    void Start();

    void Stop();

    /// <summary>Ask for an immediate re-query (safe to call while scanning).</summary>
    void Refresh();
}
