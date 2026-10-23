using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Zilux2.AirPlay.Ap2;

namespace PtpSelfTest;

/// <summary>
/// Self-test for <see cref="Ap2PtpMaster"/>.
/// <para>
/// Two parts: (1) pure wire-format assertions against the buildable packet factories, and
/// (2) a real UDP round trip with the master bound to 127.0.0.1 and receiver sockets bound to
/// 127.0.0.5:319 / 127.0.0.5:320 (Windows accepts any 127/8 address, so this needs no second host).
/// </para>
/// <para>
/// <c>dotnet run -- --dump</c> prints the packet hex used by README.md.
/// </para>
/// </summary>
internal static class Program
{
    private const ulong FixedClockId = 0x1234567812345678UL;
    private const ushort FixedSequence = 0xFFFF;
    private const ulong FixedTimestampNs = 1_234_567_890UL; // 1970-01-01T00:00:01.234567890Z

    private static int _passed;
    private static int _failed;
    private static readonly List<string> FailedNames = [];

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length > 0 && args[0] == "--dump")
            {
                DumpPackets();
                return 0;
            }

            WireFormatTests();
            LiveNetworkTests();
        }
        catch (Exception ex)
        {
            Fail("uncaught exception", ex.ToString());
        }

        Console.WriteLine();
        Console.WriteLine($"===== result: {_passed} passed, {_failed} failed =====");
        foreach (var name in FailedNames)
        {
            Console.WriteLine($"  failed: {name}");
        }

        return _failed == 0 ? 0 : 1;
    }

    // =============================================================================================
    // Part 1: wire format
    // =============================================================================================

    private static void WireFormatTests()
    {
        Section("wire: Sync");
        var sync = Ap2PtpMaster.BuildSync(FixedClockId, FixedSequence, FixedTimestampNs);
        Check("Sync length = 44", sync.Length == 44, $"len={sync.Length}");
        Check("Sync byte0 = 0x10 (PTPv2, event port, messageType 0)", sync[0] == 0x10, $"0x{sync[0]:X2}");
        Check("Sync versionPTP = 2", sync[1] == 2, $"0x{sync[1]:X2}");
        Check("Sync messageLength field = 44", U16(sync, 2) == 44, $"0x{U16(sync, 2):X4}");
        Check("Sync reserved bytes 4..6 are zero", U16(sync, 4) == 0);
        Check("Sync flags = 0x0608", U16(sync, 6) == 0x0608, $"0x{U16(sync, 6):X4}");
        Check("Sync reserved bytes 8..20 are zero", AllZero(sync.AsSpan(8, 12)));
        Check("Sync clockIdentity = ClockId", U64(sync, 20) == FixedClockId, $"0x{U64(sync, 20):X16}");
        Check("Sync sourcePortIdentity.port = 0x8005", U16(sync, 28) == 0x8005, $"0x{U16(sync, 28):X4}");
        Check("Sync sequenceId = 0xFFFF", U16(sync, 30) == FixedSequence, $"0x{U16(sync, 30):X4}");
        Check("Sync logMessageInterval = -3 (0xFD)", sync[33] == 0xFD, $"0x{sync[33]:X2}");
        Check("Sync originTimestamp = 1.234567890 s", ReadTimestamp(sync) == (1UL, 234_567_890U), TimestampText(sync));
        Check("Sync has no body after the timestamp", sync.Length == Ap2PtpMaster.TimestampOffset + Ap2PtpMaster.TimestampLength);

        Section("wire: Follow_Up");
        var follow = Ap2PtpMaster.BuildFollowUp(FixedClockId, FixedSequence, FixedTimestampNs);
        Check("Follow_Up length = 96", follow.Length == 96, $"len={follow.Length}");
        Check("Follow_Up byte0 = 0x18 (PTPv2, general port, messageType 8)", follow[0] == 0x18, $"0x{follow[0]:X2}");
        Check("Follow_Up versionPTP = 2", follow[1] == 2);
        Check("Follow_Up messageLength field = 96", U16(follow, 2) == 96, $"0x{U16(follow, 2):X4}");
        Check("Follow_Up flags = 0x0408", U16(follow, 6) == 0x0408, $"0x{U16(follow, 6):X4}");
        Check("Follow_Up clockIdentity = ClockId", U64(follow, 20) == FixedClockId);
        Check("Follow_Up sourcePortIdentity.port = 0x8005", U16(follow, 28) == 0x8005);
        Check("Follow_Up sequenceId = 0xFFFF", U16(follow, 30) == FixedSequence);
        Check("Follow_Up logMessageInterval = -3", follow[33] == 0xFD);
        Check("Follow_Up preciseOriginTimestamp = 1.234567890 s", ReadTimestamp(follow) == (1UL, 234_567_890U), TimestampText(follow));
        Check("Follow_Up TLV#1 type = 0x0003 (organization extension)", U16(follow, 44) == 0x0003, $"0x{U16(follow, 44):X4}");
        Check("Follow_Up TLV#1 length = 28", U16(follow, 46) == 28, $"0x{U16(follow, 46):X4}");
        Check("Follow_Up TLV#1 organizationId = 00-80-C2 (IEEE 802.1)", follow[48] == 0x00 && follow[49] == 0x80 && follow[50] == 0xC2, HexBlock(follow.AsSpan(48, 3)));
        Check("Follow_Up TLV#1 subType = 1 (follow-up info / rate ratio)", follow[51] == 0x00 && follow[52] == 0x00 && follow[53] == 0x01, HexBlock(follow.AsSpan(51, 3)));
        Check("Follow_Up TLV#1 rate payload is all zero (rate ratio 1.0)", AllZero(follow.AsSpan(54, 22)));
        Check("Follow_Up TLV#2 type = 0x0003", U16(follow, 76) == 0x0003, $"0x{U16(follow, 76):X4}");
        Check("Follow_Up TLV#2 length = 16", U16(follow, 78) == 16, $"0x{U16(follow, 78):X4}");
        Check("Follow_Up TLV#2 organizationId = 00-0D-93 (Apple)", follow[80] == 0x00 && follow[81] == 0x0D && follow[82] == 0x93, HexBlock(follow.AsSpan(80, 3)));
        Check("Follow_Up TLV#2 subType = 4 (clock identity)", follow[83] == 0x00 && follow[84] == 0x00 && follow[85] == 0x04, HexBlock(follow.AsSpan(83, 3)));
        Check("Follow_Up TLV#2 clockIdentity at offset 86 = ClockId", U64(follow, 86) == FixedClockId, $"0x{U64(follow, 86):X16}");
        Check("Follow_Up TLV#2 trailing bytes 94..96 are zero", follow[94] == 0 && follow[95] == 0);

        Section("wire: Announce");
        var announce = Ap2PtpMaster.BuildAnnounce(FixedClockId, FixedSequence, FixedTimestampNs);
        Check("Announce length = 76", announce.Length == 76, $"len={announce.Length}");
        Check("Announce byte0 = 0x1B (PTPv2, general port, messageType 11)", announce[0] == 0x1B, $"0x{announce[0]:X2}");
        Check("Announce versionPTP = 2", announce[1] == 2);
        Check("Announce messageLength field = 76", U16(announce, 2) == 76);
        Check("Announce flags = 0x0408", U16(announce, 6) == 0x0408, $"0x{U16(announce, 6):X4}");
        Check("Announce clockIdentity = ClockId", U64(announce, 20) == FixedClockId);
        Check("Announce sequenceId = 0xFFFF", U16(announce, 30) == FixedSequence);
        Check("Announce logMessageInterval = 0", announce[33] == 0);
        Check("Announce originTimestamp = 1.234567890 s", ReadTimestamp(announce) == (1UL, 234_567_890U));
        Check("Announce currentUtcOffset = 0", U16(announce, 44) == 0);
        Check("Announce reserved byte 46 = 0", announce[46] == 0);
        Check("Announce priority1 = 96", announce[47] == 96, $"0x{announce[47]:X2}");
        Check("Announce clockClass = 248", announce[48] == 248, $"0x{announce[48]:X2}");
        Check("Announce clockAccuracy = 0xFE", announce[49] == 0xFE);
        Check("Announce offsetScaledLogVariance = 0xFFFF", U16(announce, 50) == 0xFFFF);
        Check("Announce priority2 = 128", announce[52] == 128);
        Check("Announce grandmasterIdentity = ClockId", U64(announce, 53) == FixedClockId, $"0x{U64(announce, 53):X16}");
        Check("Announce stepsRemoved = 0", U16(announce, 61) == 0);
        Check("Announce timeSource = 0xA0 (internal oscillator)", announce[63] == 0xA0);
        Check("Announce path-trace TLV type = 0x0008", U16(announce, 64) == 0x0008);
        Check("Announce path-trace TLV length = 8", U16(announce, 66) == 8);
        Check("Announce path-trace clockIdentity = ClockId", U64(announce, 68) == FixedClockId);

        Section("wire: Delay_Resp / Pdelay_Resp / Pdelay_Resp_Follow_Up");
        var request = BuildDelayRequest(0x4321, 0x0123456789ABCDEFUL);
        var delayResponse = Ap2PtpMaster.BuildDelayResponse(request, FixedClockId, FixedTimestampNs);
        Check("Delay_Resp length = 54", delayResponse.Length == 54, $"len={delayResponse.Length}");
        Check("Delay_Resp byte0 = 0x19 (general port, messageType 9)", delayResponse[0] == 0x19, $"0x{delayResponse[0]:X2}");
        Check("Delay_Resp versionPTP = 2", delayResponse[1] == 2);
        Check("Delay_Resp messageLength field = 54", U16(delayResponse, 2) == 54);
        Check("Delay_Resp flags = 0x0408", U16(delayResponse, 6) == 0x0408, $"0x{U16(delayResponse, 6):X4}");
        Check("Delay_Resp clockIdentity = ClockId", U64(delayResponse, 20) == FixedClockId);
        Check("Delay_Resp sourcePortIdentity.port = 0x8005", U16(delayResponse, 28) == 0x8005);
        Check("Delay_Resp sequenceId echoes request (0x4321)", U16(delayResponse, 30) == 0x4321);
        Check("Delay_Resp logMessageInterval = -3", delayResponse[33] == 0xFD);
        Check("Delay_Resp receiveTimestamp = 1.234567890 s", ReadTimestamp(delayResponse) == (1UL, 234_567_890U));
        Check("Delay_Resp requestingPortIdentity echoes request header bytes 20..30", delayResponse.AsSpan(44, 10).SequenceEqual(request.AsSpan(20, 10)), HexBlock(delayResponse.AsSpan(44, 10)));

        var pdelayRequest = BuildDelayRequest(0x7788, 0x1122334455667788UL, messageType: 0x12);
        var pdelayResponse = Ap2PtpMaster.BuildPdelayResponse(pdelayRequest, FixedClockId, FixedTimestampNs);
        Check("Pdelay_Resp length = 54", pdelayResponse.Length == 54, $"len={pdelayResponse.Length}");
        Check("Pdelay_Resp byte0 = 0x13 (event port, messageType 3)", pdelayResponse[0] == 0x13, $"0x{pdelayResponse[0]:X2}");
        Check("Pdelay_Resp flags = 0x0608", U16(pdelayResponse, 6) == 0x0608, $"0x{U16(pdelayResponse, 6):X4}");
        Check("Pdelay_Resp sequenceId echoes request (0x7788)", U16(pdelayResponse, 30) == 0x7788);
        Check("Pdelay_Resp clockIdentity = ClockId", U64(pdelayResponse, 20) == FixedClockId);
        Check("Pdelay_Resp requestingPortIdentity echoes request header bytes 20..30", pdelayResponse.AsSpan(44, 10).SequenceEqual(pdelayRequest.AsSpan(20, 10)));

        var pdelayFollowUp = Ap2PtpMaster.BuildPdelayResponseFollowUp(pdelayRequest, FixedClockId, FixedTimestampNs);
        Check("Pdelay_Resp_Follow_Up length = 54", pdelayFollowUp.Length == 54, $"len={pdelayFollowUp.Length}");
        Check("Pdelay_Resp_Follow_Up byte0 = 0x1A (general port, messageType 10)", pdelayFollowUp[0] == 0x1A, $"0x{pdelayFollowUp[0]:X2}");
        Check("Pdelay_Resp_Follow_Up flags = 0x0408", U16(pdelayFollowUp, 6) == 0x0408);
        Check("Pdelay_Resp_Follow_Up sequenceId echoes request (0x7788)", U16(pdelayFollowUp, 30) == 0x7788);
        Check("Pdelay_Resp_Follow_Up responseOriginTimestamp = 1.234567890 s", ReadTimestamp(pdelayFollowUp) == (1UL, 234_567_890U));

        Section("wire: TryReadHeader");
        Check(
            "TryReadHeader accepts a Sync and reports type/seq/length",
            Ap2PtpMaster.TryReadHeader(sync, out var kind, out var sequence, out var messageLength) &&
            kind == 0 &&
            sequence == FixedSequence &&
            messageLength == 44);
        Check("TryReadHeader rejects datagrams shorter than 34 bytes", !Ap2PtpMaster.TryReadHeader(new byte[33], out _, out _, out _));
        var badVersion = (byte[])sync.Clone();
        badVersion[1] = 3;
        Check("TryReadHeader rejects a non-v2 PTP version", !Ap2PtpMaster.TryReadHeader(badVersion, out _, out _, out _));
        var lyingLength = (byte[])sync.Clone();
        BinaryPrimitives.WriteUInt16BigEndian(lyingLength.AsSpan(2), 200);
        Check("TryReadHeader rejects a declared length larger than the datagram", !Ap2PtpMaster.TryReadHeader(lyingLength, out _, out _, out _));
        var shortDeclared = (byte[])sync.Clone();
        BinaryPrimitives.WriteUInt16BigEndian(shortDeclared.AsSpan(2), 20);
        Check("TryReadHeader rejects a declared length shorter than the header", !Ap2PtpMaster.TryReadHeader(shortDeclared, out _, out _, out _));
    }

    // =============================================================================================
    // Part 2: real UDP traffic over loopback
    // =============================================================================================

    private static void LiveNetworkTests()
    {
        Section("live: TryStart failure path");
        var unavailable = Ap2PtpMaster.TryStart(IPAddress.Parse("203.0.113.1"), Array.Empty<IPAddress>());
        Check("TryStart on an unassigned local address returns null", unavailable is null);
        unavailable?.Dispose();

        var nullAddressThrows = false;
        try
        {
            Ap2PtpMaster.TryStart(null!, Array.Empty<IPAddress>());
        }
        catch (ArgumentNullException)
        {
            nullAddressThrows = true;
        }

        Check("TryStart(null) throws ArgumentNullException", nullAddressThrows);

        Section("live: UDP 319/320 (master 127.0.0.1 -> receiver 127.0.0.5)");
        var receiverAddress = IPAddress.Parse("127.0.0.5");
        var receivers = TryBindReceivers(receiverAddress);
        Check($"receiver sockets bound on {receiverAddress}:319/320", receivers is not null);
        if (receivers is not { } sockets)
        {
            return;
        }

        using var eventReceiver = sockets.Event;
        using var generalReceiver = sockets.General;
        using var master = Ap2PtpMaster.TryStart(IPAddress.Loopback, new[] { receiverAddress });
        Check("TryStart returns a running master bound to 127.0.0.1:319/320", master is not null);
        if (master is null)
        {
            return;
        }

        Check("ClockId is non-zero", master.ClockId != 0, $"0x{master.ClockId:X16}");
        Check("ClockId fits in 63 bits (top bit clear)", (master.ClockId >> 63) == 0);
        Check("BindAddress reports the local address", master.BindAddress.Equals(IPAddress.Loopback));

        var nowA = master.NowNs;
        var nowB = master.NowNanoseconds();
        var hostNowNs = (ulong)((DateTime.UtcNow.Ticks - DateTimeOffset.UnixEpoch.UtcTicks) * 100L);
        Check(
            "NowNs is Unix-epoch nanoseconds (within 5 s of the host clock)",
            nowA + 5_000_000_000UL > hostNowNs && nowA < hostNowNs + 5_000_000_000UL,
            $"nowNs={nowA} hostNs={hostNowNs}");
        Check("NowNs advances monotonically", nowB > nowA, $"{nowA} -> {nowB}");
        Check("Peers exposes the configured receiver", master.Peers.Count == 1 && master.Peers[0].Equals(receiverAddress));

        var eventPackets = Collect(eventReceiver, TimeSpan.FromMilliseconds(1_300));
        var generalPackets = Collect(generalReceiver, TimeSpan.FromMilliseconds(1_300));

        var syncs = eventPackets.Where(packet => Kind(packet) == 0).ToList();
        var follows = generalPackets.Where(packet => Kind(packet) == 8).ToList();
        var announces = generalPackets.Where(packet => Kind(packet) == 11).ToList();

        Check("Sync datagrams received on UDP/319", syncs.Count > 0, $"count={syncs.Count}");
        Check("about 8 Sync per second, i.e. 125 ms cadence", syncs.Count >= 8 && syncs.Count <= 13, $"count={syncs.Count}");
        Check(
            "every Sync is 44 bytes, type 0, flags 0x0608, clockIdentity = ClockId",
            syncs.Count > 0 && syncs.All(packet =>
                packet.Payload.Length == 44 &&
                (packet.Payload[0] & 0x0F) == 0 &&
                packet.Payload[1] == 2 &&
                U16(packet.Payload, 2) == 44 &&
                U16(packet.Payload, 6) == 0x0608 &&
                U64(packet.Payload, 20) == master.ClockId));
        Check(
            "every Sync originTimestamp is within +-5 s of the host UTC clock",
            syncs.Count > 0 && syncs.All(packet =>
            {
                var (seconds, nanoseconds) = ReadTimestamp(packet.Payload);
                var hostSeconds = (ulong)DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                return nanoseconds < 1_000_000_000U &&
                       seconds + 5 >= hostSeconds &&
                       seconds <= hostSeconds + 5;
            }));
        Check(
            "live Sync sequenceId increments by one per tick",
            syncs.Count >= 2 && IncrementsByOne(syncs.Select(packet => U16(packet.Payload, 30)).ToList()),
            string.Join(",", syncs.Select(packet => U16(packet.Payload, 30))));
        if (syncs.Count >= 3)
        {
            var averageMs = (syncs[^1].Arrival - syncs[0].Arrival).TotalMilliseconds / (syncs.Count - 1);
            Check("average Sync spacing is 125 ms (+-20 ms)", averageMs is >= 105 and <= 145, $"avg={averageMs:F1} ms");
        }
        else
        {
            Check("average Sync spacing is 125 ms (+-20 ms)", false, "too few Sync packets");
        }

        Check("Follow_Up datagrams received on UDP/320", follows.Count > 0, $"count={follows.Count}");
        Check(
            "every Follow_Up is 96 bytes, type 8, flags 0x0408, clockIdentity = ClockId",
            follows.Count > 0 && follows.All(packet =>
                packet.Payload.Length == 96 &&
                (packet.Payload[0] & 0x0F) == 8 &&
                U16(packet.Payload, 2) == 96 &&
                U16(packet.Payload, 6) == 0x0408 &&
                U64(packet.Payload, 20) == master.ClockId));
        Check(
            "every Follow_Up carries the 802.1AS rate TLV and the Apple clock-id TLV",
            follows.Count > 0 && follows.All(packet =>
                U16(packet.Payload, 44) == 0x0003 &&
                U16(packet.Payload, 46) == 28 &&
                U64(packet.Payload, 86) == master.ClockId));

        Check("Announce datagrams received on UDP/320", announces.Count >= 1, $"count={announces.Count}");
        Check(
            "every Announce is 76 bytes and advertises ClockId as grandmaster",
            announces.Count > 0 && announces.All(packet =>
                packet.Payload.Length == 76 &&
                (packet.Payload[0] & 0x0F) == 11 &&
                packet.Payload[47] == 96 &&
                packet.Payload[48] == 248 &&
                U64(packet.Payload, 53) == master.ClockId &&
                U64(packet.Payload, 68) == master.ClockId));

        Section("live: Delay_Req / Pdelay_Req round trips");
        var delayRequest = BuildDelayRequest(0x4321, 0x0123456789ABCDEFUL);
        eventReceiver.SendTo(delayRequest, new IPEndPoint(IPAddress.Loopback, Ap2PtpMaster.EventPort));
        var delayResponse = WaitForKind(generalReceiver, 9, TimeSpan.FromMilliseconds(500));
        Check("Delay_Req sent to UDP/319 is answered with Delay_Resp on UDP/320", delayResponse is not null);
        if (delayResponse is not null)
        {
            Check(
                "Delay_Resp is 54 bytes, type 9, flags 0x0408",
                delayResponse.Length == 54 && (delayResponse[0] & 0x0F) == 9 && U16(delayResponse, 6) == 0x0408,
                $"len={delayResponse.Length} first=0x{delayResponse[0]:X2}");
            Check("Delay_Resp echoes the request sequenceId", U16(delayResponse, 30) == 0x4321);
            Check("Delay_Resp clockIdentity is the master ClockId", U64(delayResponse, 20) == master.ClockId);
            Check(
                "Delay_Resp requestingPortIdentity echoes the requester",
                delayResponse.AsSpan(44, 10).SequenceEqual(delayRequest.AsSpan(20, 10)));
        }

        var pdelayRequest = BuildDelayRequest(0x7788, 0x1122334455667788UL, messageType: 0x12);
        eventReceiver.SendTo(pdelayRequest, new IPEndPoint(IPAddress.Loopback, Ap2PtpMaster.EventPort));
        var pdelayResponse = WaitForKind(eventReceiver, 3, TimeSpan.FromMilliseconds(500));
        var pdelayFollowUp = WaitForKind(generalReceiver, 10, TimeSpan.FromMilliseconds(500));
        Check("Pdelay_Req is answered with Pdelay_Resp on UDP/319", pdelayResponse is not null);
        Check("Pdelay_Req is also answered with Pdelay_Resp_Follow_Up on UDP/320", pdelayFollowUp is not null);
        if (pdelayResponse is not null)
        {
            Check(
                "Pdelay_Resp is 54 bytes, type 3, flags 0x0608",
                pdelayResponse.Length == 54 && (pdelayResponse[0] & 0x0F) == 3 && U16(pdelayResponse, 6) == 0x0608);
            Check("Pdelay_Resp echoes the request sequenceId", U16(pdelayResponse, 30) == 0x7788);
            Check(
                "Pdelay_Resp requestingPortIdentity echoes the requester",
                pdelayResponse.AsSpan(44, 10).SequenceEqual(pdelayRequest.AsSpan(20, 10)));
        }

        if (pdelayFollowUp is not null)
        {
            Check(
                "Pdelay_Resp_Follow_Up is 54 bytes, type 10, flags 0x0408",
                pdelayFollowUp.Length == 54 && (pdelayFollowUp[0] & 0x0F) == 10 && U16(pdelayFollowUp, 6) == 0x0408);
            Check("Pdelay_Resp_Follow_Up echoes the request sequenceId", U16(pdelayFollowUp, 30) == 0x7788);
        }

        Check("master counted both probe requests", master.DelayRequests >= 1 && master.PdelayRequests >= 1, $"delay={master.DelayRequests} pdelay={master.PdelayRequests}");
        Check("master counted received peer packets", master.ReceivedPackets >= 2, $"rx={master.ReceivedPackets}");
        Check("master counted sent traffic and sync rounds", master.SentPackets > 0 && master.SyncRounds >= 3, $"tx={master.SentPackets} rounds={master.SyncRounds} announce={master.AnnounceSends}");

        Section("live: SetPeers");
        master.SetPeers(Array.Empty<IPAddress>());
        Check("SetPeers(empty) empties the peer list", master.Peers.Count == 0);
        Collect(eventReceiver, TimeSpan.FromMilliseconds(400)); // drain packets that were already in flight
        Collect(generalReceiver, TimeSpan.FromMilliseconds(400));
        var mutedEvent = Collect(eventReceiver, TimeSpan.FromMilliseconds(400));
        var mutedGeneral = Collect(generalReceiver, TimeSpan.FromMilliseconds(400));
        Check("no Sync/Follow_Up/Announce while the peer list is empty", mutedEvent.Count + mutedGeneral.Count == 0, $"event={mutedEvent.Count} general={mutedGeneral.Count}");

        master.SetPeers(new[] { receiverAddress });
        var resumed = Collect(eventReceiver, TimeSpan.FromMilliseconds(400));
        Check("Sync traffic resumes after SetPeers(receiver)", resumed.Count >= 2, $"count={resumed.Count}");

        Section("live: Dispose");
        master.Dispose();
        var doubleDisposeThrew = false;
        try
        {
            master.Dispose();
        }
        catch (Exception)
        {
            doubleDisposeThrew = true;
        }

        Check("second Dispose does not throw", !doubleDisposeThrew);
        Collect(eventReceiver, TimeSpan.FromMilliseconds(300)); // drain
        var afterDispose = Collect(eventReceiver, TimeSpan.FromMilliseconds(300));
        Check("no packets are sent after Dispose", afterDispose.Count == 0, $"count={afterDispose.Count}");

        var restarted = Ap2PtpMaster.TryStart(IPAddress.Loopback, Array.Empty<IPAddress>());
        Check("TryStart succeeds again after Dispose (UDP ports released)", restarted is not null);
        restarted?.Dispose();
    }

    // =============================================================================================
    // Helpers
    // =============================================================================================

    private sealed record Datagram(byte[] Payload, TimeSpan Arrival);

    private static int Kind(Datagram datagram) => datagram.Payload.Length > 0 ? datagram.Payload[0] & 0x0F : -1;

    private static (Socket Event, Socket General)? TryBindReceivers(IPAddress address)
    {
        Socket? eventSocket = null;
        Socket? generalSocket = null;
        try
        {
            eventSocket = BindReceiver(address, Ap2PtpMaster.EventPort);
            generalSocket = BindReceiver(address, Ap2PtpMaster.GeneralPort);
            return (eventSocket, generalSocket);
        }
        catch (Exception ex)
        {
            Fail($"bind receiver UDP sockets on {address}", $"{ex.GetType().Name}: {ex.Message}");
            eventSocket?.Dispose();
            generalSocket?.Dispose();
            return null;
        }
    }

    private static Socket BindReceiver(IPAddress address, int port)
    {
        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        try
        {
            socket.ReceiveTimeout = 50;
            socket.Bind(new IPEndPoint(address, port));
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private static List<Datagram> Collect(Socket socket, TimeSpan window)
    {
        var packets = new List<Datagram>();
        var clock = Stopwatch.StartNew();
        var buffer = new byte[2048];
        while (clock.Elapsed < window)
        {
            try
            {
                var length = socket.Receive(buffer);
                packets.Add(new Datagram(buffer[..length].ToArray(), clock.Elapsed));
            }
            catch (SocketException ex) when (ex.SocketErrorCode == SocketError.TimedOut)
            {
                // Nothing arrived yet; the outer loop decides when the window is over.
            }
            catch (SocketException)
            {
                // Transient (e.g. ICMP feedback); keep collecting.
            }
        }

        return packets;
    }

    private static byte[]? WaitForKind(Socket socket, int kind, TimeSpan timeout)
    {
        var clock = Stopwatch.StartNew();
        var buffer = new byte[2048];
        while (clock.Elapsed < timeout)
        {
            try
            {
                var length = socket.Receive(buffer);
                var payload = buffer[..length].ToArray();
                if (payload.Length > 0 && (payload[0] & 0x0F) == kind)
                {
                    return payload;
                }
            }
            catch (SocketException ex) when (ex.SocketErrorCode == SocketError.TimedOut)
            {
            }
            catch (SocketException)
            {
            }
        }

        return null;
    }

    private static bool IncrementsByOne(List<ushort> sequences)
    {
        for (var i = 1; i < sequences.Count; i++)
        {
            if (sequences[i] != (ushort)(sequences[i - 1] + 1))
            {
                return false;
            }
        }

        return true;
    }

    private static byte[] BuildDelayRequest(ushort sequence, ulong requesterClockId, byte messageType = 0x11)
    {
        var request = new byte[44];
        request[0] = messageType;
        request[1] = 2;
        BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(2), 44);
        BinaryPrimitives.WriteUInt64BigEndian(request.AsSpan(20), requesterClockId);
        BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(28), 0x0001);
        BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(30), sequence);
        return request;
    }

    // ---------------------------------------------------------------------------------------------
    // Assertions and formatting
    // ---------------------------------------------------------------------------------------------

    private static void Section(string title) => Console.WriteLine($"\n[{title}]");

    private static void Check(string name, bool condition, string? detail = null)
    {
        if (condition)
        {
            _passed++;
            Console.WriteLine($"  PASS  {name}");
            return;
        }

        Fail(name, detail);
    }

    private static void Fail(string name, string? detail)
    {
        _failed++;
        FailedNames.Add(name);
        Console.WriteLine($"  FAIL  {name}{(detail is null ? string.Empty : $"  [{detail}]")}");
    }

    private static ushort U16(ReadOnlySpan<byte> data, int offset) => BinaryPrimitives.ReadUInt16BigEndian(data[offset..]);

    private static ulong U64(ReadOnlySpan<byte> data, int offset) => BinaryPrimitives.ReadUInt64BigEndian(data[offset..]);

    private static (ulong Seconds, uint Nanoseconds) ReadTimestamp(ReadOnlySpan<byte> packet)
    {
        ulong seconds = 0;
        for (var i = 0; i < 6; i++)
        {
            seconds = (seconds << 8) | packet[34 + i];
        }

        return (seconds, BinaryPrimitives.ReadUInt32BigEndian(packet[40..]));
    }

    private static string TimestampText(ReadOnlySpan<byte> packet)
    {
        var (seconds, nanoseconds) = ReadTimestamp(packet);
        return $"s={seconds} ns={nanoseconds}";
    }

    private static bool AllZero(ReadOnlySpan<byte> data)
    {
        foreach (var value in data)
        {
            if (value != 0)
            {
                return false;
            }
        }

        return true;
    }

    private static string HexBlock(ReadOnlySpan<byte> data)
    {
        var builder = new StringBuilder(data.Length * 3);
        for (var i = 0; i < data.Length; i++)
        {
            if (i > 0)
            {
                builder.Append(' ');
            }

            builder.Append(data[i].ToString("x2"));
        }

        return builder.ToString();
    }

    // ---------------------------------------------------------------------------------------------
    // --dump: the hex tables pasted into README.md
    // ---------------------------------------------------------------------------------------------

    private static void DumpPackets()
    {
        var request = BuildDelayRequest(0x4321, 0x0123456789ABCDEFUL);
        var pdelayRequest = BuildDelayRequest(0x7788, 0x1122334455667788UL, messageType: 0x12);

        Console.WriteLine("clockId   = 0x1234567812345678");
        Console.WriteLine("sequence  = 0xFFFF");
        Console.WriteLine("timestamp = Unix 1.234567890 s -> seconds=1, nanoseconds=234567890");
        Console.WriteLine("request   = Delay_Req seq=0x4321, sourcePortIdentity=0x0123456789ABCDEF/0x0001");

        Dump("Sync (44 bytes)", Ap2PtpMaster.BuildSync(FixedClockId, FixedSequence, FixedTimestampNs));
        Dump("Follow_Up (96 bytes)", Ap2PtpMaster.BuildFollowUp(FixedClockId, FixedSequence, FixedTimestampNs));
        Dump("Announce (76 bytes)", Ap2PtpMaster.BuildAnnounce(FixedClockId, FixedSequence, FixedTimestampNs));
        Dump("Delay_Resp (54 bytes)", Ap2PtpMaster.BuildDelayResponse(request, FixedClockId, FixedTimestampNs));
        Dump("Pdelay_Resp (54 bytes)", Ap2PtpMaster.BuildPdelayResponse(pdelayRequest, FixedClockId, FixedTimestampNs));
        Dump("Pdelay_Resp_Follow_Up (54 bytes)", Ap2PtpMaster.BuildPdelayResponseFollowUp(pdelayRequest, FixedClockId, FixedTimestampNs));
    }

    private static void Dump(string title, byte[] packet)
    {
        Console.WriteLine();
        Console.WriteLine($"=== {title} ===");
        const int perLine = 16;
        for (var offset = 0; offset < packet.Length; offset += perLine)
        {
            var end = Math.Min(offset + perLine, packet.Length);
            Console.Write($"  {offset:D2}: ");
            Console.WriteLine(HexBlock(packet.AsSpan(offset, end - offset)));
        }
    }
}
