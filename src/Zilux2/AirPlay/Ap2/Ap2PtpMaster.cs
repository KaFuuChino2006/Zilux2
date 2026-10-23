using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;

namespace Zilux2.AirPlay.Ap2;

/// <summary>
/// AirPlay 2 PTPv2 <b>grandmaster</b> (the "probe master" role).
/// <para>
/// Sessions whose phase-1 SETUP declares <c>timingProtocol = "PTP"</c> put the <i>sender</i> in charge
/// of the time base: it owns the clock identity advertised as <c>timingPeerInfo.ClockID</c>, multicasts
/// (here: unicasts) Sync/Follow_Up on UDP/319 and UDP/320 every 125 ms, announces itself once per
/// second on UDP/320, and answers the receiver's Delay_Req/Pdelay_Req probes. The receiver locks its
/// audio clock to this time base and only then starts rendering the AP2 audio stream, so a sender that
/// leaves PTP unserved is accepted but stays silent.
/// </para>
/// <para>
/// This is an independent C# implementation of the wire profile used by the known-good AirPlay 2
/// reference sender (AirFlash, GPLv3 — protocol reference only, no code copied). Packet layout, the
/// wall-clock (Unix epoch, nanosecond) time base and the 125 ms / 1 s cadence are documented in
/// <c>research/airplay/ptp/README.md</c> and are covered by <c>research/airplay/ptp/</c> self-tests.
/// </para>
/// </summary>
internal sealed class Ap2PtpMaster : IDisposable
{
    /// <summary>PTP event port: Sync, Follow_Up (sent), Delay_Req / Pdelay_Req (received), Pdelay_Resp (sent).</summary>
    public const int EventPort = 319;

    /// <summary>PTP general port: Follow_Up, Announce, Delay_Resp / Pdelay_Resp_Follow_Up (sent).</summary>
    public const int GeneralPort = 320;

    /// <summary>Sync/Follow_Up cadence used by the AirPlay PTP profile (8 packets per second).</summary>
    public const int SyncIntervalMilliseconds = 125;

    /// <summary>Announce cadence (a priority/grandmaster advertisement; the receiver only logs it).</summary>
    public const int AnnounceIntervalMilliseconds = 1_000;

    /// <summary>Common PTPv2 header length; every packet carries the 10-byte timestamp right after it.</summary>
    public const int HeaderLength = 34;

    /// <summary>Offset of the 6-byte-seconds + 4-byte-nanoseconds timestamp inside the header.</summary>
    public const int TimestampOffset = 34;

    /// <summary>Wire size of the PTP timestamp field.</summary>
    public const int TimestampLength = 10;

    public const int SyncLength = 44;

    public const int FollowUpLength = 96;

    public const int AnnounceLength = 76;

    /// <summary>Delay_Resp / Pdelay_Resp / Pdelay_Resp_Follow_Up all share this size.</summary>
    public const int DelayResponseLength = 54;

    /// <summary>Delay_Req / Pdelay_Req payload is just the header plus a timestamp field.</summary>
    private const int DelayRequestLength = 44;

    // PTP message types (low nibble of byte 0). The high nibble is the transportSpecific byte (0x1).
    private const byte MessageSync = 0x00;
    private const byte MessageDelayRequest = 0x01;
    private const byte MessagePdelayRequest = 0x02;
    private const byte MessagePdelayResponse = 0x03;
    private const byte MessageFollowUp = 0x08;
    private const byte MessageDelayResponse = 0x09;
    private const byte MessagePdelayResponseFollowUp = 0x0A;
    private const byte MessageAnnounce = 0x0B;

    // Flags seen on the AirPlay profile: 0x0608 = two-step profile sync, 0x0408 = two-step "general".
    private const ushort TwoStepSyncFlags = 0x0608;
    private const ushort TwoStepGeneralFlags = 0x0408;

    /// <summary>logMessageInterval value -3 (2^-3 = 125 ms) for sync-domain messages; 0 for Announce.</summary>
    private const sbyte SyncLogInterval = -3;

    /// <summary>How often the worker emits a one-line diagnostic summary.</summary>
    private const int StatusIntervalSeconds = 10;

    // Byte offsets inside the PTPv1-style header that are shared by every message.
    private const int LengthOffset = 2;
    private const int FlagsOffset = 6;
    private const int ClockIdOffset = 20;
    private const int SourcePortIdOffset = 28;
    private const int SequenceOffset = 30;
    private const int LogIntervalOffset = 33;

    /// <summary>Value the reference profile writes into the sourcePortIdentity port number field.</summary>
    private const ushort SourcePortId = 0x8005;

    /// <summary>Seconds since the Unix epoch at class load; only used to anchor the media clock.</summary>
    private static readonly long UnixEpochTicks = DateTimeOffset.UnixEpoch.UtcTicks;

    private readonly Socket _eventSocket;
    private readonly Socket _generalSocket;
    private readonly Thread _worker;
    private readonly CancellationTokenSource _cancellation = new();

    /// <summary>Unix-epoch nanoseconds sampled once at construction.</summary>
    private readonly long _clockBaseNanoseconds;

    /// <summary>Stopwatch origin that <see cref="NowNs"/> keeps adding to <see cref="_clockBaseNanoseconds"/>.</summary>
    private readonly long _clockStartTimestamp;

    private IPAddress[] _peers;
    private long _received;
    private long _rejected;
    private long _sent;
    private long _sendFailures;
    private long _syncRounds;
    private long _announceSends;
    private long _delayRequests;
    private long _pdelayRequests;
    private int _disposed;

    private Ap2PtpMaster(Socket eventSocket, Socket generalSocket, IPAddress bindAddress, IPAddress[] peers)
    {
        _eventSocket = eventSocket;
        _generalSocket = generalSocket;
        _peers = peers;
        BindAddress = bindAddress;
        ClockId = CreateClockId();

        // Anchor the wall clock once; from then on elapsed Stopwatch time is added, so the timeline is
        // both monotonic and as close to real Unix time as the construction instant allows.
        _clockStartTimestamp = Stopwatch.GetTimestamp();
        _clockBaseNanoseconds = (DateTime.UtcNow.Ticks - UnixEpochTicks) * 100L;

        _worker = new Thread(WorkerLoop)
        {
            IsBackground = true,
            Name = "airplay-ptp-master",
        };
        _worker.Start();
    }

    /// <summary>Local address the two PTP sockets are bound to (informational).</summary>
    public IPAddress BindAddress { get; }

    /// <summary>
    /// Random 63-bit PTP clock identity. Must be placed in phase-1 SETUP
    /// (<c>timingPeerInfo.ClockID</c> / <c>timingPeerList[0].ClockID</c>); the receiver uses it to pick
    /// this master out of the Announce/Sync stream.
    /// </summary>
    public ulong ClockId { get; }

    /// <summary>Current wall-clock time in Unix-epoch nanoseconds; the value AP2 sync timestamps map onto.</summary>
    public ulong NowNs
    {
        get
        {
            var elapsed = Stopwatch.GetElapsedTime(_clockStartTimestamp);
            return unchecked((ulong)(_clockBaseNanoseconds + elapsed.Ticks * 100L));
        }
    }

    /// <summary>Method-flavoured alias of <see cref="NowNs"/> for call sites that prefer it.</summary>
    public ulong NowNanoseconds() => NowNs;

    /// <summary>Peers currently being served (copy of the last <see cref="SetPeers"/> call).</summary>
    public IReadOnlyList<IPAddress> Peers => Volatile.Read(ref _peers);

    /// <summary>Number of accepted PTP packets from peers (valid header + known peer).</summary>
    public long ReceivedPackets => Interlocked.Read(ref _received);

    /// <summary>Number of datagrams dropped because they came from a non-peer or had a bad header.</summary>
    public long RejectedPackets => Interlocked.Read(ref _rejected);

    /// <summary>Number of PTP packets sent (successful socket sends, all message types).</summary>
    public long SentPackets => Interlocked.Read(ref _sent);

    /// <summary>Number of Sync/Follow_Up tick rounds sent (one per 125 ms tick per peer list).</summary>
    public long SyncRounds => Interlocked.Read(ref _syncRounds);

    /// <summary>Number of Announce datagrams sent.</summary>
    public long AnnounceSends => Interlocked.Read(ref _announceSends);

    /// <summary>Number of Delay_Req packets answered.</summary>
    public long DelayRequests => Interlocked.Read(ref _delayRequests);

    /// <summary>Number of Pdelay_Req packets answered.</summary>
    public long PdelayRequests => Interlocked.Read(ref _pdelayRequests);

    /// <summary>
    /// Binds UDP/319 and UDP/320 on <paramref name="localAddress"/> and starts the PTP grandmaster loop.
    /// Returns <c>null</c> after logging <c>[airplay] AP2 PTP unavailable: ...</c> when the ports cannot be
    /// bound (another PTP endpoint owns them, usually a previous session that was not disposed). Callers
    /// then fall back to NTP / local-clock sync and the receiver stays silent.
    /// </summary>
    /// <param name="localAddress">Interface address to bind; pass <see cref="IPAddress.Any"/> for wildcard.</param>
    /// <param name="peers">Receiver addresses to send Sync/Follow_Up/Announce to; may be updated later.</param>
    public static Ap2PtpMaster? TryStart(IPAddress localAddress, IEnumerable<IPAddress> peers)
    {
        ArgumentNullException.ThrowIfNull(localAddress);
        var peerList = Normalize(peers);

        Socket? eventSocket = null;
        Socket? generalSocket = null;
        try
        {
            eventSocket = Bind(localAddress, EventPort);
            generalSocket = Bind(localAddress, GeneralPort);
            var master = new Ap2PtpMaster(eventSocket, generalSocket, localAddress, peerList);
            HostLog.Info(
                $"[airplay] AP2 PTP master listening on {Describe(localAddress)}:{EventPort}/{GeneralPort} " +
                $"clockId=0x{master.ClockId:X16} peers=[{Join(peerList)}]");
            return master;
        }
        catch (Exception ex)
        {
            eventSocket?.Dispose();
            generalSocket?.Dispose();
            HostLog.Warn($"[airplay] AP2 PTP unavailable: {ex.GetType().Name}: {ex.Message}");
            return null;
        }
    }

    /// <summary>
    /// Replaces the peer list (stereo pair / multi-room members). Safe to call from any thread; the
    /// worker picks the new array up on its next tick.
    /// </summary>
    public void SetPeers(IReadOnlyList<IPAddress> peers)
    {
        ArgumentNullException.ThrowIfNull(peers);
        var next = Normalize(peers);
        var previous = Interlocked.Exchange(ref _peers, next);
        if (!previous.SequenceEqual(next))
        {
            HostLog.Info($"[airplay] AP2 PTP peers=[{Join(next)}] count={next.Length}");
        }
    }

    private static Socket Bind(IPAddress address, int port)
    {
        var socket = new Socket(address.AddressFamily, SocketType.Dgram, ProtocolType.Udp);
        try
        {
            socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            socket.Blocking = false;
            socket.Bind(new IPEndPoint(address, port));
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private void WorkerLoop()
    {
        var buffer = new byte[2048];
        var eventRemote = CreateRemoteEndPoint(_eventSocket);
        var generalRemote = CreateRemoteEndPoint(_generalSocket);

        // Absolute schedule instead of "now + 125 ms": the loop body costs a little, and a free-running
        // timestamp drift would make the receiver's offset estimate wander.
        var nextSync = TimeSpan.Zero;
        var lastAnnounce = TimeSpan.FromSeconds(-10);
        var nextStatus = TimeSpan.FromSeconds(StatusIntervalSeconds);
        var started = false;
        ushort sequence = 0;
        var errorLogTicks = 0L;

        while (!_cancellation.IsCancellationRequested)
        {
            try
            {
                var elapsed = Stopwatch.GetElapsedTime(_clockStartTimestamp);
                var peers = Volatile.Read(ref _peers);

                if (elapsed >= nextSync)
                {
                    var syncTimestamp = NowNs;
                    var sync = BuildSync(ClockId, sequence, syncTimestamp);
                    var followUp = BuildFollowUp(ClockId, sequence, syncTimestamp);
                    foreach (var peer in peers)
                    {
                        Send(_eventSocket, sync, peer, EventPort);
                        Send(_generalSocket, followUp, peer, GeneralPort);
                    }

                    if (peers.Length > 0)
                    {
                        Interlocked.Increment(ref _syncRounds);
                        if (!started)
                        {
                            started = true;
                            HostLog.Info(
                                $"[airplay] AP2 PTP tx started: sync/follow-up every " +
                                $"{SyncIntervalMilliseconds} ms, announce every {AnnounceIntervalMilliseconds} ms " +
                                $"to [{Join(peers)}]");
                        }
                    }

                    // Announce rides on the same tick/sequence; it is a slow "I am the grandmaster"
                    // advertisement, not a sync packet (the receiver only records it).
                    if (elapsed - lastAnnounce >= TimeSpan.FromMilliseconds(AnnounceIntervalMilliseconds))
                    {
                        if (peers.Length > 0)
                        {
                            var announce = BuildAnnounce(ClockId, sequence, NowNs);
                            foreach (var peer in peers)
                            {
                                Send(_generalSocket, announce, peer, GeneralPort);
                            }

                            Interlocked.Increment(ref _announceSends);
                            lastAnnounce = elapsed;
                        }
                    }

                    sequence++;
                    nextSync = Advance(nextSync + TimeSpan.FromMilliseconds(SyncIntervalMilliseconds), elapsed);
                }

                ReceiveAvailable(_eventSocket, buffer, ref eventRemote);
                ReceiveAvailable(_generalSocket, buffer, ref generalRemote);

                if (elapsed >= nextStatus)
                {
                    nextStatus = elapsed + TimeSpan.FromSeconds(StatusIntervalSeconds);
                    HostLog.Info(
                        $"[airplay] AP2 PTP stats: syncRounds={SyncRounds} announce={AnnounceSends} " +
                        $"tx={SentPackets} rx={ReceivedPackets} delayReq={DelayRequests} pdelayReq={PdelayRequests} " +
                        $"rejected={RejectedPackets} sendFailures={Interlocked.Read(ref _sendFailures)} peers={peers.Length}");
                }

                Thread.Sleep(2);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                // Never let an unexpected socket/ICMP error kill the master thread silently: without PTP
                // traffic the receiver will not start rendering. Log at most once per 10 s.
                var now = Stopwatch.GetTimestamp();
                if (now - errorLogTicks > Stopwatch.Frequency * 10)
                {
                    errorLogTicks = now;
                    HostLog.Warn($"[airplay] AP2 PTP worker error: {ex.GetType().Name}: {ex.Message}");
                }

                Thread.Sleep(20);
            }
        }
    }

    /// <summary>Keeps the absolute tick schedule, but skips instead of bursting after a scheduler hitch.</summary>
    private static TimeSpan Advance(TimeSpan scheduled, TimeSpan now) =>
        scheduled > now ? scheduled : now + TimeSpan.FromMilliseconds(SyncIntervalMilliseconds);

    private void ReceiveAvailable(Socket socket, byte[] buffer, ref EndPoint remote)
    {
        while (!_cancellation.IsCancellationRequested)
        {
            int length;
            try
            {
                length = socket.ReceiveFrom(buffer, ref remote);
            }
            catch (SocketException)
            {
                // WouldBlock on the non-blocking sockets, plus transient errors such as ICMP
                // port-unreachable (WSAECONNRESET) reported for a previous send. Either way: stop
                // draining this socket for now, the next loop iteration retries.
                return;
            }
            catch (ObjectDisposedException)
            {
                return;
            }

            if (remote is not IPEndPoint from)
            {
                Interlocked.Increment(ref _rejected);
                continue;
            }

            HandleDatagram(buffer.AsSpan(0, length), from, socket);
        }
    }

    private void HandleDatagram(ReadOnlySpan<byte> datagram, IPEndPoint from, Socket socket)
    {
        if (!IsPeer(from.Address))
        {
            Interlocked.Increment(ref _rejected);
            return;
        }

        if (!TryReadHeader(datagram, out var kind, out var requestSequence, out _))
        {
            Interlocked.Increment(ref _rejected);
            return;
        }

        Interlocked.Increment(ref _received);
        var now = NowNs;
        switch (kind)
        {
            case MessageDelayRequest:
                // Delay_Req: echo the requester's port identity and our receipt timestamp on UDP/320.
                if (datagram.Length < DelayRequestLength)
                {
                    return;
                }

                Interlocked.Increment(ref _delayRequests);
                Send(_generalSocket, BuildDelayResponse(datagram, ClockId, now), from.Address, GeneralPort);
                break;

            case MessagePdelayRequest:
                // Peer-delay probe: response goes back on the event port, follow-up on the general port.
                if (datagram.Length < DelayRequestLength)
                {
                    return;
                }

                Interlocked.Increment(ref _pdelayRequests);
                Send(_eventSocket, BuildPdelayResponse(datagram, ClockId, now), from.Address, EventPort);
                var followUp = BuildPdelayResponseFollowUp(datagram, ClockId, NowNs);
                Send(_generalSocket, followUp, from.Address, GeneralPort);
                break;

            default:
                // Sync/Follow_Up/Announce from other PTP nodes: interesting for logs, nothing to answer.
                break;
        }
    }

    private bool IsPeer(IPAddress address)
    {
        foreach (var peer in Volatile.Read(ref _peers))
        {
            if (peer.Equals(address))
            {
                return true;
            }
        }

        return false;
    }

    private bool Send(Socket socket, byte[] payload, IPAddress peer, int port)
    {
        try
        {
            socket.SendTo(payload, new IPEndPoint(peer, port));
            Interlocked.Increment(ref _sent);
            return true;
        }
        catch (Exception ex) when (ex is SocketException or ObjectDisposedException)
        {
            Interlocked.Increment(ref _sendFailures);
            return false;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Packet builders. Kept static and internal so the self-test can verify the wire format without
    // going through the network. Layout follows the AirPlay PTP profile byte for byte.
    // ---------------------------------------------------------------------------------------------

    /// <summary>PTPv2 Sync (type 0, 44 bytes) carrying the origin timestamp at offset 34.</summary>
    internal static byte[] BuildSync(ulong clockId, ushort sequence, ulong nowNanoseconds)
    {
        var packet = BuildHeader(MessageSync, SyncLength, clockId, sequence, TwoStepSyncFlags, SyncLogInterval);
        WriteTimestamp(packet.AsSpan(TimestampOffset, TimestampLength), nowNanoseconds);
        return packet;
    }

    /// <summary>
    /// PTPv2 Follow_Up (type 8, 96 bytes): precise origin timestamp plus two organization-extension
    /// TLVs — a 802.1AS rate-ratio TLV (all zero ⇒ rate ratio 1.0) and an Apple clock-identity TLV.
    /// </summary>
    internal static byte[] BuildFollowUp(ulong clockId, ushort sequence, ulong nowNanoseconds)
    {
        var packet = BuildHeader(MessageFollowUp, FollowUpLength, clockId, sequence, TwoStepGeneralFlags, SyncLogInterval);
        WriteTimestamp(packet.AsSpan(TimestampOffset, TimestampLength), nowNanoseconds);

        // TLV #1: organization extension (type 0x0003, length 28) for OUI 00-80-C2, subtype 1
        // (follow-up information): cumulativeScaledRateOffset = 0, gmTimeBaseIndicator = 0,
        // lastGmPhaseChange = 0, scaledLastGmFreqChange = 0.
        var rate = packet.AsSpan(44, 32);
        WriteUInt16BigEndian(rate, 0x0003);
        WriteUInt16BigEndian(rate[2..], 28);
        rate[4] = 0x00;
        rate[5] = 0x80;
        rate[6] = 0xC2; // IEEE 802.1 organization id
        rate[7] = 0x00;
        rate[8] = 0x00;
        rate[9] = 0x01; // organization sub-type 1: rate ratio

        // TLV #2: organization extension (type 0x0003, length 16) for OUI 00-0D-93 (Apple), subtype 4:
        // the grandmaster clock identity, 8 bytes big endian.
        var identity = packet.AsSpan(76, 20);
        WriteUInt16BigEndian(identity, 0x0003);
        WriteUInt16BigEndian(identity[2..], 16);
        identity[4] = 0x00;
        identity[5] = 0x0D;
        identity[6] = 0x93; // Apple organization id
        identity[7] = 0x00;
        identity[8] = 0x00;
        identity[9] = 0x04; // organization sub-type 4: clock identity
        WriteUInt64BigEndian(identity[10..], clockId);
        return packet;
    }

    /// <summary>
    /// PTPv2 Announce (type 11, 76 bytes): priority1=96, clockClass=248, accuracy=0xFE, variance=0xFFFF,
    /// priority2=128, timeSource=0xA0 (internal oscillator), grandmaster identity = <paramref name="clockId"/>,
    /// followed by a path-trace TLV carrying the same identity.
    /// </summary>
    internal static byte[] BuildAnnounce(ulong clockId, ushort sequence, ulong nowNanoseconds)
    {
        var packet = BuildHeader(MessageAnnounce, AnnounceLength, clockId, sequence, TwoStepGeneralFlags, 0);
        WriteTimestamp(packet.AsSpan(TimestampOffset, TimestampLength), nowNanoseconds);

        // Announce body: currentUtcOffset (0), reserved, priority1, clockClass, clockAccuracy,
        // offsetScaledLogVariance, priority2, grandmasterIdentity, stepsRemoved, timeSource.
        packet[47] = 96;
        packet[48] = 248;
        packet[49] = 0xFE;
        WriteUInt16BigEndian(packet.AsSpan(50, 2), 0xFFFF);
        packet[52] = 128;
        WriteUInt64BigEndian(packet.AsSpan(53, 8), clockId);
        packet[63] = 0xA0;

        // Path-trace TLV (type 0x0008, length 8): grandmaster clock identity.
        WriteUInt16BigEndian(packet.AsSpan(64, 2), 0x0008);
        WriteUInt16BigEndian(packet.AsSpan(66, 2), 8);
        WriteUInt64BigEndian(packet.AsSpan(68, 8), clockId);
        return packet;
    }

    /// <summary>PTPv2 Delay_Resp (type 9, 54 bytes); echoes the requester's port identity.</summary>
    internal static byte[] BuildDelayResponse(ReadOnlySpan<byte> request, ulong clockId, ulong nowNanoseconds) =>
        BuildProbeResponse(
            request,
            clockId,
            nowNanoseconds,
            MessageDelayResponse,
            TwoStepGeneralFlags);

    /// <summary>PTPv2 Pdelay_Resp (type 3, 54 bytes) sent back on the event port.</summary>
    internal static byte[] BuildPdelayResponse(ReadOnlySpan<byte> request, ulong clockId, ulong nowNanoseconds) =>
        BuildProbeResponse(
            request,
            clockId,
            nowNanoseconds,
            MessagePdelayResponse,
            TwoStepSyncFlags);

    /// <summary>PTPv2 Pdelay_Resp_Follow_Up (type 10, 54 bytes) sent on the general port.</summary>
    internal static byte[] BuildPdelayResponseFollowUp(ReadOnlySpan<byte> request, ulong clockId, ulong nowNanoseconds) =>
        BuildProbeResponse(
            request,
            clockId,
            nowNanoseconds,
            MessagePdelayResponseFollowUp,
            TwoStepGeneralFlags);

    private static byte[] BuildProbeResponse(
        ReadOnlySpan<byte> request,
        ulong clockId,
        ulong nowNanoseconds,
        byte messageType,
        ushort flags)
    {
        var requestSequence = request.Length >= SequenceOffset + 2
            ? BinaryPrimitives.ReadUInt16BigEndian(request[SequenceOffset..])
            : (ushort)0;
        var response = BuildHeader(messageType, DelayResponseLength, clockId, requestSequence, flags, SyncLogInterval);
        WriteTimestamp(response.AsSpan(TimestampOffset, TimestampLength), nowNanoseconds);

        // requestingPortIdentity: the reference profile echoes the request's *header* sourcePortIdentity
        // (bytes 20..30) rather than the body field a strict IEEE 1588 implementation would use.
        if (request.Length >= 30)
        {
            request.Slice(ClockIdOffset, 10).CopyTo(response.AsSpan(44, 10));
        }

        return response;
    }

    private static byte[] BuildHeader(
        byte messageType,
        int length,
        ulong clockId,
        ushort sequence,
        ushort flags,
        sbyte logMessageInterval)
    {
        var packet = new byte[length];
        packet[0] = (byte)(0x10 | messageType);
        packet[1] = 2; // PTP version 2
        WriteUInt16BigEndian(packet.AsSpan(LengthOffset, 2), (ushort)length);
        WriteUInt16BigEndian(packet.AsSpan(FlagsOffset, 2), flags);
        WriteUInt64BigEndian(packet.AsSpan(ClockIdOffset, 8), clockId);
        WriteUInt16BigEndian(packet.AsSpan(SourcePortIdOffset, 2), SourcePortId);
        WriteUInt16BigEndian(packet.AsSpan(SequenceOffset, 2), sequence);
        packet[LogIntervalOffset] = unchecked((byte)logMessageInterval);
        return packet;
    }

    /// <summary>10-byte PTP timestamp: 48-bit seconds big endian followed by 32-bit nanoseconds.</summary>
    internal static void WriteTimestamp(Span<byte> destination, ulong nanoseconds)
    {
        var seconds = nanoseconds / 1_000_000_000UL;
        for (var i = 0; i < 6; i++)
        {
            destination[i] = (byte)(seconds >> (8 * (5 - i)));
        }

        WriteUInt32BigEndian(destination[6..], (uint)(nanoseconds % 1_000_000_000UL));
    }

    /// <summary>Parses the common PTPv2 header; false for non-PTP datagrams or truncated/lying packets.</summary>
    internal static bool TryReadHeader(
        ReadOnlySpan<byte> datagram,
        out byte messageType,
        out ushort sequence,
        out int messageLength)
    {
        messageType = 0;
        sequence = 0;
        messageLength = 0;
        if (datagram.Length < HeaderLength || (datagram[1] & 0x0F) != 2)
        {
            return false;
        }

        var declared = BinaryPrimitives.ReadUInt16BigEndian(datagram[LengthOffset..]);
        if (declared < HeaderLength || declared > datagram.Length)
        {
            return false;
        }

        messageType = (byte)(datagram[0] & 0x0F);
        sequence = BinaryPrimitives.ReadUInt16BigEndian(datagram[SequenceOffset..]);
        messageLength = declared;
        return true;
    }

    private static void WriteUInt16BigEndian(Span<byte> destination, ushort value) =>
        BinaryPrimitives.WriteUInt16BigEndian(destination, value);

    private static void WriteUInt32BigEndian(Span<byte> destination, uint value) =>
        BinaryPrimitives.WriteUInt32BigEndian(destination, value);

    private static void WriteUInt64BigEndian(Span<byte> destination, ulong value) =>
        BinaryPrimitives.WriteUInt64BigEndian(destination, value);

    private static ulong CreateClockId()
    {
        Span<byte> random = stackalloc byte[8];
        RandomNumberGenerator.Fill(random);
        var id = BinaryPrimitives.ReadUInt64BigEndian(random) & 0x7FFF_FFFF_FFFF_FFFFUL;
        return id == 0 ? 1UL : id;
    }

    private static IPAddress[] Normalize(IEnumerable<IPAddress>? peers)
    {
        if (peers is null)
        {
            return [];
        }

        var seen = new List<IPAddress>();
        foreach (var peer in peers)
        {
            if (peer is not null && !seen.Contains(peer))
            {
                seen.Add(peer);
            }
        }

        return [.. seen];
    }

    private static EndPoint CreateRemoteEndPoint(Socket socket) =>
        socket.AddressFamily == AddressFamily.InterNetworkV6
            ? new IPEndPoint(IPAddress.IPv6Any, 0)
            : new IPEndPoint(IPAddress.Any, 0);

    private static string Describe(IPAddress address) => address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any)
        ? "*"
        : address.ToString();

    private static string Join(IReadOnlyList<IPAddress> peers) => string.Join(", ", peers);

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _cancellation.Cancel();
        try
        {
            _worker.Join(TimeSpan.FromSeconds(2));
        }
        catch (Exception)
        {
            // Shutdown must never throw.
        }

        _eventSocket.Dispose();
        _generalSocket.Dispose();
        _cancellation.Dispose();
        HostLog.Info(
            $"[airplay] AP2 PTP master stopped: syncRounds={SyncRounds} announce={AnnounceSends} " +
            $"tx={SentPackets} rx={ReceivedPackets} delayReq={DelayRequests} pdelayReq={PdelayRequests}");
    }
}
