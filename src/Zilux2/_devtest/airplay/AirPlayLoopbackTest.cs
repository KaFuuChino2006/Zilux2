using System.Globalization;
using Zilux2.AirPlay.Protocol;

namespace Zilux2.DevTest.AirPlay;

/// <summary>
/// End-to-end loopback for the classic RAOP sender: a real <see cref="RaopConnection"/> streams to
/// <see cref="AirPlayMockDevice"/> on loopback and every wire-level invariant a receiver relies on is
/// asserted (RTSP handshake, SDP, transport ports, RTP sequence/timestamps, sync, timing round-trip,
/// resend handling, volume body, FLUSH and TEARDOWN). No Apple hardware is involved.
/// </summary>
internal static class AirPlayLoopbackTest
{
    /// <summary>Same pattern as ZILUX2_ACCOUNT_SELFTEST: the host checks it before creating the window.</summary>
    internal const string EnvironmentVariable = "ZILUX2_AIRPLAY_SELFTEST";

    private const int AudioFrameCount = 200;
    private const int AlacPayloadBytes = 500;
    private const uint SamplesPerFrame = 352;

    public static bool IsRequested =>
        string.Equals(Environment.GetEnvironmentVariable(EnvironmentVariable), "1", StringComparison.Ordinal);

    /// <summary>Runs the whole loopback and returns a process exit code: 0 when every check passed.</summary>
    internal static int Run()
    {
        var passed = 0;
        var failed = 0;

        void Check(string name, bool condition, string? detail = null)
        {
            if (condition)
            {
                passed++;
                Report(true, name, null);
            }
            else
            {
                failed++;
                Report(false, name, detail);
            }
        }

        HostLog.Info($"[airplay-test] starting: frames={AudioFrameCount} payload={AlacPayloadBytes}");

        try
        {
            using var mock = AirPlayMockDevice.Start();
            var target = new RaopTarget
            {
                Name = "Zilux2 mock RAOP receiver",
                Host = "127.0.0.1",
                Port = mock.RtspPort,
            };

            using var connection = RaopConnection.Connect(target, new RaopOptions
            {
                BufferLatencyMilliseconds = 2000,
                ConnectTimeoutMilliseconds = 5000,
            });

            // ---- RTSP handshake: OPTIONS / ANNOUNCE / SETUP ----
            var handshake = mock.Stats();
            var allHandshakeOk = handshake.RtspRequests.Count == 3;
            foreach (var request in handshake.RtspRequests)
            {
                if (request.ResponseStatus != 200)
                {
                    allHandshakeOk = false;
                }
            }

            Check("handshake requests 200", allHandshakeOk, $"requests={handshake.RtspRequests.Count}");

            var optionsRequest = handshake.Find("OPTIONS");
            Check("OPTIONS uri *", optionsRequest != null && optionsRequest.Uri == "*", Describe(optionsRequest));

            var announceRequest = handshake.Find("ANNOUNCE");
            Check("ANNOUNCE answered 200", announceRequest != null && announceRequest.ResponseStatus == 200, Describe(announceRequest));
            var sdp = announceRequest == null ? string.Empty : announceRequest.Body;
            Check("ANNOUNCE sdp rtpmap", sdp.Contains("a=rtpmap:96 AppleLossless", StringComparison.Ordinal), Truncate(sdp));
            Check(
                "ANNOUNCE sdp alac fmtp",
                sdp.Contains("a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100", StringComparison.Ordinal),
                Truncate(sdp));
            Check("ANNOUNCE sdp plain", !sdp.Contains("a=rsaaeskey:", StringComparison.Ordinal), Truncate(sdp));

            var setupRequest = handshake.Find("SETUP");
            Check("SETUP answered 200", setupRequest != null && setupRequest.ResponseStatus == 200, Describe(setupRequest));
            var transport = setupRequest == null ? string.Empty : setupRequest.Header("Transport") ?? string.Empty;
            Check("SETUP transport control_port", transport.Contains("control_port=", StringComparison.Ordinal), transport);
            Check("SETUP transport timing_port", transport.Contains("timing_port=", StringComparison.Ordinal), transport);
            Check("SETUP session id", string.Equals(connection.SessionId, "1", StringComparison.Ordinal), connection.SessionId);
            Check(
                "SETUP audio latency",
                connection.DeviceAudioLatency == 88200,
                connection.DeviceAudioLatency.ToString(CultureInfo.InvariantCulture));

            // ---- timing round-trip: mock asks, our receive loop must answer ----
            Check("timing probe sent", mock.RequestTiming(), "mock did not learn the sender timing port from SETUP");
            Thread.Sleep(250);

            // ---- RECORD + audio plane ----
            connection.BeginStreaming();
            var record = mock.Stats().Find("RECORD");
            Check("RECORD answered 200", record != null && record.ResponseStatus == 200, Describe(record));
            Check("RECORD range npt=0-", record != null && record.Header("Range") == "npt=0-", Describe(record));
            var rtpInfo = record == null ? string.Empty : record.Header("RTP-Info") ?? string.Empty;
            Check("RECORD RTP-Info", rtpInfo.StartsWith("seq=0;rtptime=", StringComparison.Ordinal), rtpInfo);

            var random = new Random(unchecked(20261020));
            var payload = new byte[AlacPayloadBytes];
            var accepted = 0;
            for (var i = 0; i < AudioFrameCount; i++)
            {
                random.NextBytes(payload);
                if (connection.SendAudioFrame(payload))
                {
                    accepted++;
                }
            }

            Thread.Sleep(1500); // covers at least one sync tick (the timer fires after 1000 ms)

            Check("audio frames accepted", accepted == AudioFrameCount, $"accepted={accepted}");
            Check("resend probe sent", mock.RequestResend(190, 3), "mock did not learn the sender control port from SETUP");
            Thread.Sleep(250);

            // ---- volume / FLUSH / TEARDOWN ----
            connection.SetVolume(60);
            connection.Flush();
            connection.Teardown();
            Thread.Sleep(300);

            var final = mock.Stats();
            Check("audio packet count", final.AudioPackets == AudioFrameCount, $"packets={final.AudioPackets}");
            Check(
                "audio sequence contiguous",
                final.FirstSequence == 0 && final.LastSequence == AudioFrameCount - 1 && final.SequenceGaps == 0,
                $"first={final.FirstSequence} last={final.LastSequence} gaps={final.SequenceGaps}");
            Check(
                "audio timestamp step 352",
                HasConstantTimestampStep(final.Timestamps, SamplesPerFrame),
                DescribeTimestamps(final.Timestamps));
            Check(
                "audio payload bytes",
                final.AudioPayloadBytes == (long)AudioFrameCount * AlacPayloadBytes,
                $"bytes={final.AudioPayloadBytes}");
            Check("sync packet received", final.SyncPackets >= 1, $"sync={final.SyncPackets}");
            Check(
                "timing round-trip",
                final.TimingRequestsSent >= 1 && final.TimingResponses >= 1 && final.TimingEchoMatches,
                $"sent={final.TimingRequestsSent} replies={final.TimingResponses} echo={final.TimingEchoMatches}");
            Check(
                "resend responses",
                final.ResendRequestsSent == 1 && final.ResendResponses >= 3,
                $"requests={final.ResendRequestsSent} responses={final.ResendResponses}");

            var volumeRequest = FindLastRequest(final.RtspRequests, "SET_PARAMETER", "volume:");
            Check(
                "volume body",
                volumeRequest != null && volumeRequest.Body.Contains("volume: -12.000000", StringComparison.Ordinal),
                volumeRequest == null ? "no SET_PARAMETER volume request" : volumeRequest.Body.Trim());

            var flushRequest = final.Find("FLUSH");
            Check("FLUSH answered 200", flushRequest != null && flushRequest.ResponseStatus == 200, Describe(flushRequest));
            Check(
                "FLUSH RTP-Info",
                flushRequest != null && (flushRequest.Header("RTP-Info") ?? string.Empty).StartsWith("seq=", StringComparison.Ordinal),
                Describe(flushRequest));

            Check("TEARDOWN received", final.TeardownReceived, "mock never saw TEARDOWN");
            Check("TEARDOWN closed session", final.TeardownClosed, "mock did not close the RTSP socket after TEARDOWN");
            Check("connection packet count", connection.PacketsSent == AudioFrameCount, $"sent={connection.PacketsSent}");
            Check("no unknown payload types", final.UnknownPackets == 0, $"unknown={final.UnknownPackets}");
            Check("mock errors empty", final.Errors.Count == 0, string.Join(" | ", final.Errors));
        }
        catch (Exception ex)
        {
            failed++;
            Report(false, "harness completed", $"{ex.GetType().Name}: {ex.Message}");
        }

        Console.WriteLine($"[airplay-test] summary passed={passed} failed={failed}");
        HostLog.Info($"[airplay-test] summary passed={passed} failed={failed}");
        return failed == 0 ? 0 : 1;
    }

    private static void Report(bool passed, string name, string? detail)
    {
        var suffix = string.IsNullOrEmpty(detail) ? string.Empty : $" — {detail}";
        var line = $"[airplay-test] {(passed ? "PASS" : "FAIL")} {name}{suffix}";
        Console.WriteLine(line);
        if (passed)
        {
            HostLog.Info(line);
        }
        else
        {
            HostLog.Error(line);
        }
    }

    private static string Describe(MockRtspRequest? request) =>
        request == null ? "request not received" : $"status={request.ResponseStatus} uri={request.Uri}";

    private static MockRtspRequest? FindLastRequest(
        IReadOnlyList<MockRtspRequest> requests,
        string method,
        string bodyPrefix)
    {
        MockRtspRequest? found = null;
        foreach (var request in requests)
        {
            if (string.Equals(request.Method, method, StringComparison.Ordinal) &&
                request.Body.StartsWith(bodyPrefix, StringComparison.Ordinal))
            {
                found = request;
            }
        }

        return found;
    }

    private static bool HasConstantTimestampStep(IReadOnlyList<uint> timestamps, uint step)
    {
        if (timestamps.Count < 2)
        {
            return false;
        }

        for (var i = 1; i < timestamps.Count; i++)
        {
            if (unchecked(timestamps[i] - timestamps[i - 1]) != step)
            {
                return false;
            }
        }

        return true;
    }

    private static string DescribeTimestamps(IReadOnlyList<uint> timestamps)
    {
        if (timestamps.Count == 0)
        {
            return "no audio timestamps";
        }

        var first = timestamps[0].ToString(CultureInfo.InvariantCulture);
        var last = timestamps[timestamps.Count - 1].ToString(CultureInfo.InvariantCulture);
        return $"count={timestamps.Count} first={first} last={last}";
    }

    private static string Truncate(string value) => value.Length <= 160 ? value : value[..160] + "...";
}
