using System.Net;
using System.Reflection;

namespace Zilux2.AirPlay.Ap2;

/// <summary>
/// The PTP grandmaster used by the AirPlay 2 sender. The concrete implementation lives in
/// <c>Ap2PtpMaster.cs</c> (delivered by the PTP task); this file only defines the contract the
/// connection codes against and a late-bound adapter so the two files can land independently.
/// </summary>
internal interface IAp2PtpMaster : IDisposable
{
    /// <summary>63-bit PTP clock identity advertised in <c>timingPeerInfo.ClockID</c>.</summary>
    ulong ClockId { get; }

    /// <summary>Current master time as raw Unix-epoch nanoseconds.</summary>
    ulong NowNs { get; }

    /// <summary>Updates the PTP peers (receivers) the master serves.</summary>
    void SetPeers(IReadOnlyList<string> peers);
}

/// <summary>Late-bound bridge to <c>Zilux2.AirPlay.Ap2.Ap2PtpMaster</c>.</summary>
internal static class Ap2PtpLink
{
    private const string MasterTypeName = "Zilux2.AirPlay.Ap2.Ap2PtpMaster";

    private static bool _reportedMissing;

    /// <summary>
    /// Starts the PTP master (bind UDP 319/320) when the implementation type is present in this
    /// assembly. Returns <c>null</c> when it is unavailable so the caller falls back to wall-clock
    /// PTP sync packets (which alone cannot make a receiver play, but keep the handshake alive).
    /// </summary>
    public static IAp2PtpMaster? TryStart(string localIp, IReadOnlyList<string> peers)
    {
        var assembly = typeof(Ap2Connection).Assembly;
        var type = assembly.GetType(MasterTypeName, throwOnError: false);
        if (type is null)
        {
            if (!_reportedMissing)
            {
                _reportedMissing = true;
                HostLog.Warn($"[airplay] AP2 PTP master not available ({MasterTypeName} missing); sync uses wall clock");
            }

            return null;
        }

        try
        {
            var tryStart = type.GetMethod(
                "TryStart",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            if (tryStart is null)
            {
                HostLog.Warn("[airplay] AP2 PTP master has no TryStart method; sync uses wall clock");
                return null;
            }

            var parameters = tryStart.GetParameters();
            var arguments = new object?[parameters.Length];
            var parseFailed = false;
            for (var index = 0; index < parameters.Length; index++)
            {
                arguments[index] = ConvertArgument(parameters[index].ParameterType, localIp, peers);
                parseFailed |= arguments[index] is null;
            }

            if (parseFailed)
            {
                HostLog.Warn("[airplay] AP2 PTP master TryStart signature is unsupported");
                return null;
            }

            var instance = tryStart.Invoke(null, arguments);
            if (instance is null)
            {
                HostLog.Warn("[airplay] AP2 PTP master refused to start; sync uses wall clock");
                return null;
            }

            var adapter = new LateBoundPtpMaster(instance);
            HostLog.Info($"[airplay] AP2 PTP master started: clock_id=0x{adapter.ClockId:X16} peers={peers.Count}");
            return adapter;
        }
        catch (Exception ex)
        {
            HostLog.Warn($"[airplay] AP2 PTP master failed to start: {ex.GetType().Name}: {ex.Message}");
            return null;
        }
    }

    private static object? ConvertArgument(Type parameterType, string localIp, IReadOnlyList<string> peers)
    {
        if (parameterType == typeof(string))
        {
            return localIp;
        }

        if (parameterType == typeof(IPAddress))
        {
            return IPAddress.TryParse(localIp, out var address) ? address : null;
        }

        if (parameterType == typeof(IPAddress[]))
        {
            return ToAddresses(peers);
        }

        if (typeof(IEnumerable<IPAddress>).IsAssignableFrom(parameterType))
        {
            return ToAddresses(peers);
        }

        if (typeof(IEnumerable<string>).IsAssignableFrom(parameterType))
        {
            return peers;
        }

        return null;
    }

    private static IPAddress[] ToAddresses(IReadOnlyList<string> peers)
    {
        var addresses = new List<IPAddress>(peers.Count);
        foreach (var peer in peers)
        {
            if (!IPAddress.TryParse(peer, out var address))
            {
                return [];
            }

            addresses.Add(address);
        }

        return [.. addresses];
    }

    private sealed class LateBoundPtpMaster : IAp2PtpMaster
    {
        private readonly object _inner;
        private readonly PropertyInfo? _clockId;
        private readonly PropertyInfo? _nowNs;
        private readonly MethodInfo? _setPeers;

        public LateBoundPtpMaster(object inner)
        {
            _inner = inner;
            var type = inner.GetType();
            _clockId = type.GetProperty("ClockId", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            _nowNs = type.GetProperty("NowNs", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                ?? type.GetProperty("NowNanoseconds", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            _setPeers = type.GetMethod("SetPeers", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        }

        public ulong ClockId => _clockId?.GetValue(_inner) is ulong value
            ? value
            : _clockId?.GetValue(_inner) is long signed ? (ulong)signed : 0UL;

        public ulong NowNs => _nowNs?.GetValue(_inner) is ulong value
            ? value
            : _nowNs?.GetValue(_inner) is long signed ? (ulong)signed : 0UL;

        public void SetPeers(IReadOnlyList<string> peers)
        {
            try
            {
                var parameter = _setPeers?.GetParameters().FirstOrDefault();
                object? argument = parameter is not null
                    && typeof(IEnumerable<IPAddress>).IsAssignableFrom(parameter.ParameterType)
                    ? ToAddresses(peers)
                    : peers;
                _setPeers?.Invoke(_inner, [argument]);
            }
            catch (Exception ex)
            {
                HostLog.Warn($"[airplay] AP2 PTP SetPeers failed: {ex.GetType().Name}: {ex.Message}");
            }
        }

        public void Dispose() => (_inner as IDisposable)?.Dispose();
    }
}
