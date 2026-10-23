using System.Collections.Generic;

namespace Zilux2.AirPlay.Ap2;

/// <summary>
/// Process-wide PTP grandmaster used by every AirPlay 2 connection.
/// <para>
/// A PTP grandmaster owns UDP 319/320 and has exactly one clock identity. Two connections that
/// each start their own master therefore fight over the sockets (the second bind fails) and, worse,
/// would present different <c>timingPeerInfo.ClockID</c> values to the receivers so the devices can
/// never share a media timeline. This class keeps a single master for the whole process:
/// the first connection starts it, later connections only register their receiver as an extra
/// PTP peer, and the last <see cref="Release"/> tears it down. Peer sets are unioned and every
/// mutation is logged as <c>[airplay] AP2 PTP shared: clock=0x.. peers=N refs=M</c>.
/// </para>
/// <para>
/// The RTSP <c>SETPEERS</c> body must list <em>all</em> active endpoints (receivers + our local
/// address); see <see cref="CurrentEndpoints"/>. The PTP master itself must only send Sync /
/// Follow_Up / Announce to the receiver addresses, never to our own address.
/// </para>
/// </summary>
internal static class Ap2SharedPtp
{
    private static readonly object Gate = new();
    private static readonly List<Ap2PtpLease> Leases = [];

    private static IAp2PtpMaster? _master;
    private static string? _localIp;

    /// <summary>Clock identity of the shared grandmaster (0 when PTP is not available/active).</summary>
    public static ulong ClockId
    {
        get
        {
            lock (Gate)
            {
                return _master?.ClockId ?? 0UL;
            }
        }
    }

    /// <summary>Current grandmaster time as raw Unix-epoch nanoseconds (0 when not active).</summary>
    public static ulong NowNs
    {
        get
        {
            lock (Gate)
            {
                return _master?.NowNs ?? 0UL;
            }
        }
    }

    /// <summary>Number of live connections sharing the master.</summary>
    public static int ReferenceCount
    {
        get
        {
            lock (Gate)
            {
                return Leases.Count;
            }
        }
    }

    /// <summary>
    /// Registers a connection and returns a reference-counted handle onto the process-wide master.
    /// The first caller starts the master bound to <paramref name="localIp"/>; every caller's
    /// receivers are unioned into the master's peer list. Returns <c>null</c> when the PTP master
    /// type is unavailable (the caller then falls back to wall-clock sync packets).
    /// </summary>
    public static IAp2PtpMaster? Acquire(string localIp, IReadOnlyList<string> peers)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(localIp);
        ArgumentNullException.ThrowIfNull(peers);

        lock (Gate)
        {
            var leasePeers = DistinctPeers(peers);

            if (_master is null)
            {
                _localIp = localIp;
                _master = Ap2PtpLink.TryStart(localIp, leasePeers);
                if (_master is null)
                {
                    _localIp = null;
                    return null;
                }
            }
            else if (_localIp is not null &&
                     !string.Equals(_localIp, localIp, StringComparison.OrdinalIgnoreCase))
            {
                HostLog.Warn(
                    $"[airplay] AP2 PTP shared: reusing clock bound to {_localIp} for connection via {localIp}");
            }

            var lease = new Ap2PtpLease(localIp, leasePeers);
            Leases.Add(lease);
            ApplyPeersLocked();
            LogLocked("acquire");
            return lease;
        }
    }

    /// <summary>Drops one connection reference; the master is disposed when the last one goes away.</summary>
    public static void Release(IAp2PtpMaster master)
    {
        if (master is not Ap2PtpLease lease)
        {
            // Not one of ours: dispose it defensively so a bug does not leak sockets.
            master.Dispose();
            return;
        }

        lock (Gate)
        {
            if (!Leases.Remove(lease))
            {
                return;
            }

            if (Leases.Count == 0)
            {
                var previous = _master;
                _master = null;
                _localIp = null;
                try
                {
                    previous?.Dispose();
                }
                catch (Exception ex)
                {
                    HostLog.Warn(
                        $"[airplay] AP2 PTP shared: dispose failed: {ex.GetType().Name}: {ex.Message}");
                }

                HostLog.Info("[airplay] AP2 PTP shared: clock released (no active connections)");
                return;
            }

            ApplyPeersLocked();
            LogLocked("release");
        }
    }

    /// <summary>Active receiver addresses (never the local address), sorted for stable logging/SETPEERS.</summary>
    public static IReadOnlyList<string> CurrentPeers()
    {
        lock (Gate)
        {
            return SnapshotPeersLocked();
        }
    }

    /// <summary>Receiver addresses followed by our local address, for RTSP SETPEERS bodies.</summary>
    public static IReadOnlyList<string> CurrentEndpoints(string localIp)
    {
        lock (Gate)
        {
            var endpoints = new List<string>(Leases.Count + 1) { localIp };
            foreach (var peer in SnapshotPeersLocked())
            {
                if (!string.Equals(peer, localIp, StringComparison.OrdinalIgnoreCase))
                {
                    endpoints.Add(peer);
                }
            }

            return endpoints;
        }
    }

    internal static void UpdateLeasePeers(Ap2PtpLease lease, IReadOnlyList<string> peers)
    {
        lock (Gate)
        {
            if (!Leases.Contains(lease))
            {
                return;
            }

            lease.ReplacePeers(DistinctPeers(peers));
            ApplyPeersLocked();
            LogLocked("peers");
        }
    }

    private static void ApplyPeersLocked()
    {
        var union = SnapshotPeersLocked();
        try
        {
            _master?.SetPeers(union);
        }
        catch (Exception ex)
        {
            HostLog.Warn(
                $"[airplay] AP2 PTP shared: SetPeers failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    private static List<string> SnapshotPeersLocked()
    {
        var set = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var lease in Leases)
        {
            foreach (var peer in lease.Peers)
            {
                set.Add(peer);
            }
        }

        return [.. set];
    }

    private static List<string> DistinctPeers(IReadOnlyList<string> peers)
    {
        var set = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var peer in peers)
        {
            if (!string.IsNullOrWhiteSpace(peer))
            {
                set.Add(peer.Trim());
            }
        }

        return [.. set];
    }

    private static void LogLocked(string reason)
    {
        var clock = _master?.ClockId ?? 0UL;
        HostLog.Info(
            $"[airplay] AP2 PTP shared: clock=0x{clock:X16} peers={SnapshotPeersLocked().Count} refs={Leases.Count} ({reason})");
    }
}

/// <summary>
/// Per-connection handle onto <see cref="Ap2SharedPtp"/>. Exposes the shared clock identity/time and
/// lets the owning connection register its receiver; disposing releases the process-wide reference.
/// </summary>
internal sealed class Ap2PtpLease : IAp2PtpMaster
{
    private readonly List<string> _peers;
    private bool _released;

    internal Ap2PtpLease(string localIp, List<string> peers)
    {
        LocalIp = localIp;
        _peers = peers;
    }

    /// <summary>Local interface address the shared master is bound to.</summary>
    internal string LocalIp { get; }

    /// <summary>Receivers registered by this particular connection.</summary>
    internal IReadOnlyList<string> Peers => _peers;

    public ulong ClockId => Ap2SharedPtp.ClockId;

    public ulong NowNs => Ap2SharedPtp.NowNs;

    public void SetPeers(IReadOnlyList<string> peers) => Ap2SharedPtp.UpdateLeasePeers(this, peers);

    internal void ReplacePeers(List<string> peers)
    {
        _peers.Clear();
        _peers.AddRange(peers);
    }

    public void Dispose()
    {
        if (_released)
        {
            return;
        }

        _released = true;
        Ap2SharedPtp.Release(this);
    }
}
