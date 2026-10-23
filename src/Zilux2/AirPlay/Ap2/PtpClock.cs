using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;

namespace Zilux2.AirPlay.Ap2;

/// <summary>
/// Minimal IEEE 1588 (PTP / gPTP) follower for AirPlay 2.
/// HomePod-class receivers announce <c>timingProtocol = "PTP"</c> in the phase-1 SETUP and then act as
/// the PTP leader: they send Sync/Follow_Up on UDP/319 and Announce on UDP/320 to the sender. This class
/// binds both ports, estimates the leader clock offset from Sync+Follow_Up pairs and exposes the
/// leader's time base in NTP format, so the 20-byte AP2 sync packets carry timestamps that line up with
/// the clock the receiver plays audio on.
/// It sends no PTP traffic of its own (an AirPlay sender is a PTP follower, never the grandmaster).
/// </summary>
internal sealed class PtpClock : IDisposable
{
    /// <summary>PTP event port (Sync, Follow_Up, Delay_Req, Delay_Resp).</summary>
    public const int EventPort = 319;

    /// <summary>PTP general port (Announce, Signaling).</summary>
    public const int GeneralPort = 320;

    private const byte MessageSync = 0x00;
    private const byte MessageDelayResp = 0x09;
    private const byte MessageFollowUp = 0x08;
    private const byte MessageAnnounce = 0x0B;

    private const long NtpEpochOffsetSeconds = 2_208_988_800L;
    private const long UnixEpochThresholdSeconds = 1_500_000_000L;
    private const long NtpEpochThresholdSeconds = 3_000_000_000L;

    private readonly UdpClient _event;
    private readonly UdpClient _general;
    private readonly Thread _eventThread;
    private readonly Thread _generalThread;
    private readonly CancellationTokenSource _cts = new();
    private readonly object _syncRoot = new();
    private readonly Queue<long> _offsetSamples = new();

    private long _offsetNanoseconds;
    private bool _hasReference;
    private ulong _leaderClockId;
    private long _messages;
    private long _syncCount;
    private long _followUpCount;
    private long _announceCount;
    private long _delayRespCount;
    private long _otherCount;

    private PtpClock(UdpClient eventSocket, UdpClient generalSocket)
    {
        _event = eventSocket;
        _general = generalSocket;
        _eventThread = new Thread(() => ReceiveLoop(_event, handleLeaderMessages: true))
        {
            IsBackground = true,
            Name = "airplay-ptp-event",
        };
        _generalThread = new Thread(() => ReceiveLoop(_general, handleLeaderMessages: false))
        {
            IsBackground = true,
            Name = "airplay-ptp-general",
        };
        _eventThread.Start();
        _generalThread.Start();
    }

    /// <summary>True once a Sync/Follow_Up pair produced a plausible offset.</summary>
    public bool HasReference
    {
        get { lock (_syncRoot) { return _hasReference; } }
    }

    /// <summary>Estimated (leader - local) offset in milliseconds; zero until <see cref="HasReference"/>.</summary>
    public double OffsetMilliseconds
    {
        get { lock (_syncRoot) { return _offsetNanoseconds / 1_000_000.0; } }
    }

    private long _lastLeaderSecondsLong;

    /// <summary>Seconds field of the last leader timestamp (diagnostics: shows the clock epoch).</summary>
    public ulong LeaderSeconds => (ulong)Interlocked.Read(ref _lastLeaderSecondsLong);

    public long Messages => Interlocked.Read(ref _messages);

    public long SyncCount => Interlocked.Read(ref _syncCount);

    public long FollowUpCount => Interlocked.Read(ref _followUpCount);

    public long AnnounceCount => Interlocked.Read(ref _announceCount);

    public long DelayRespCount => Interlocked.Read(ref _delayRespCount);

    public long OtherCount => Interlocked.Read(ref _otherCount);

    /// <summary>
    /// Binds UDP/319 and UDP/320 on <paramref name="localAddress"/> and starts following the leader.
    /// Returns <c>null</c> when the ports cannot be bound (another PTP endpoint owns them); callers then
    /// fall back to the local wall clock for sync timestamps.
    /// </summary>
    public static PtpClock? TryStart(IPAddress localAddress)
    {
        UdpClient? eventSocket = null;
        UdpClient? generalSocket = null;
        try
        {
            eventSocket = Bind(localAddress, EventPort);
            generalSocket = Bind(localAddress, GeneralPort);
            HostLog.Info($"[airplay] AP2 PTP listening on {localAddress}:{EventPort}/{GeneralPort}");
            return new PtpClock(eventSocket, generalSocket);
        }
        catch (Exception ex)
        {
            eventSocket?.Dispose();
            generalSocket?.Dispose();
            HostLog.Warn($"[airplay] AP2 PTP unavailable: {ex.GetType().Name}: {ex.Message}");
            return null;
        }
    }

    private static UdpClient Bind(IPAddress address, int port)
    {
        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        try
        {
            socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            socket.Bind(new IPEndPoint(address, port));
            return new UdpClient { Client = socket };
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private void ReceiveLoop(UdpClient socket, bool handleLeaderMessages)
    {
        EndPoint remote = new IPEndPoint(IPAddress.Any, 0);
        var buffer = new byte[512];
        while (!_cts.IsCancellationRequested)
        {
            int read;
            try
            {
                read = socket.Client.ReceiveFrom(buffer, ref remote);
            }
            catch (Exception ex) when (ex is ObjectDisposedException or SocketException)
            {
                return;
            }

            if (read < 34)
            {
                continue;
            }

            var arrival = Stopwatch.GetTimestamp();
            Interlocked.Increment(ref _messages);
            var messageType = (byte)(buffer[0] & 0x0F);
            if (handleLeaderMessages)
            {
                switch (messageType)
                {
                    case MessageSync:
                        Interlocked.Increment(ref _syncCount);
                        break;
                    case MessageFollowUp:
                        Interlocked.Increment(ref _followUpCount);
                        OnFollowUp(buffer.AsSpan(0, read), arrival);
                        break;
                    case MessageDelayResp:
                        Interlocked.Increment(ref _delayRespCount);
                        break;
                    default:
                        Interlocked.Increment(ref _otherCount);
                        break;
                }
            }
            else
            {
                if (messageType == MessageAnnounce)
                {
                    Interlocked.Increment(ref _announceCount);
                    OnAnnounce(buffer.AsSpan(0, read));
                }
                else if (messageType == MessageSync || messageType == MessageFollowUp)
                {
                    OnFollowUp(buffer.AsSpan(0, read), arrival);
                }
                else
                {
                    Interlocked.Increment(ref _otherCount);
                }
            }
        }
    }

    private void OnFollowUp(ReadOnlySpan<byte> datagram, long arrivalTicks)
    {
        if (datagram.Length < 44)
        {
            return;
        }

        var (seconds, nanoseconds) = ReadTimestamp(datagram, 34);
        if (seconds == 0 && nanoseconds == 0)
        {
            return;
        }

        var localNanoseconds = TicksToNanoseconds(arrivalTicks);
        var leaderNanoseconds = checked((long)(seconds * 1_000_000_000UL + nanoseconds));

        // Apple's PTP domain runs on the NTP epoch (seconds since 1900). Accept a Unix-epoch leader too,
        // so third-party receivers still produce a usable NTP timeline.
        if (seconds is > (ulong)UnixEpochThresholdSeconds and < (ulong)2_600_000_000UL)
        {
            leaderNanoseconds = checked(leaderNanoseconds + NtpEpochOffsetSeconds * 1_000_000_000L);
        }

        lock (_syncRoot)
        {
            Interlocked.Exchange(ref _lastLeaderSecondsLong, (long)seconds);
            _offsetSamples.Enqueue(leaderNanoseconds - localNanoseconds);
            while (_offsetSamples.Count > 9)
            {
                _ = _offsetSamples.Dequeue();
            }

            _offsetNanoseconds = Median(_offsetSamples);
            _hasReference = true;
            if (_offsetSamples.Count is 1 or 5 or 9)
            {
                HostLog.Info(
                    $"[airplay] AP2 PTP sample: leaderSeconds={seconds} ns={nanoseconds} " +
                    $"localNs={localNanoseconds} offsetMs={_offsetNanoseconds / 1_000_000.0:F3} " +
                    $"samples={_offsetSamples.Count}");
            }
        }
    }

    private void OnAnnounce(ReadOnlySpan<byte> datagram)
    {
        if (datagram.Length < 64)
        {
            return;
        }

        ulong clockId = 0;
        for (var i = 0; i < 8; i++)
        {
            clockId = (clockId << 8) | datagram[53 + i];
        }

        lock (_syncRoot)
        {
            _leaderClockId = clockId;
        }
    }

    /// <summary>Leader clock identity, formatted like <c>1C:2A:3B:...:01</c>.</summary>
    public string LeaderClockId
    {
        get
        {
            lock (_syncRoot)
            {
                return _leaderClockId == 0
                    ? "unknown"
                    : Convert.ToHexString(BitConverter.GetBytes(_leaderClockId).Reverse().ToArray());
            }
        }
    }

    /// <summary>Current time in 64-bit NTP format, mapped onto the leader's clock.</summary>
    public ulong NowNtp()
    {
        long offset;
        lock (_syncRoot)
        {
            offset = _offsetNanoseconds;
        }

        return NanoSecondsToNtp(TicksToNanoseconds(Stopwatch.GetTimestamp()) + offset);
    }

    private static long TicksToNanoseconds(long ticks) =>
        (long)((double)ticks * 1_000_000_000.0 / Stopwatch.Frequency);

    internal static ulong NanoSecondsToNtp(long nanoseconds)
    {
        if (nanoseconds < 0)
        {
            nanoseconds = 0;
        }

        // The AP2 timeline is expressed in the leader's own clock domain: a HomePod acting as the
        // PTP master answers with seconds-since-domain-start (observed ~51 s), not TAI/NTP absolute
        // time. Adding the 1900 epoch here pushed every sync timestamp ~57 years into the future,
        // which is why the receiver accepted the stream but never scheduled audio.
        var seconds = (ulong)(nanoseconds / 1_000_000_000L);
        var remainder = (ulong)(nanoseconds % 1_000_000_000L);
        var fraction = remainder * 4_294_967_296UL / 1_000_000_000UL;
        return (seconds << 32) | fraction;
    }

    private static long Median(Queue<long> samples)
    {
        var ordered = samples.OrderBy(static value => value).ToArray();
        return ordered.Length == 0 ? 0 : ordered[ordered.Length / 2];
    }

    private static (ulong Seconds, uint Nanoseconds) ReadTimestamp(ReadOnlySpan<byte> data, int offset)
    {
        if (data.Length < offset + 10)
        {
            return (0, 0);
        }

        ulong seconds = data[offset];
        for (var i = 1; i < 6; i++)
        {
            seconds = (seconds << 8) | data[offset + i];
        }

        var nanoseconds = BinaryPrimitives.ReadUInt32BigEndian(data[(offset + 6)..]);
        return (seconds, nanoseconds);
    }

    public void Dispose()
    {
        if (_cts.IsCancellationRequested)
        {
            return;
        }

        _cts.Cancel();
        _event.Dispose();
        _general.Dispose();
        _eventThread.Join(500);
        _generalThread.Join(500);
    }
}
