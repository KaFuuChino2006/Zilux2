using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Zilux2.AirPlay.Ap2;
using Zilux2.AirPlay.Protocol;

namespace Zilux2.DevTest.AirPlay;

/// <summary>
/// Self-test for the AirPlay 2 pipeline against <see cref="AirPlay2MockDevice"/>. It exercises the
/// real <see cref="Ap2Connection"/> end to end: transient pair-setup on the plaintext socket, the
/// in-place upgrade to HAP frames, encrypted OPTIONS/SETUP/RECORD/SET_PARAMETER/FLUSH/TEARDOWN,
/// binary-plist SETUP parsing, ChaCha20-Poly1305 audio packets and the 2-second <c>/feedback</c>
/// keep-alive. Run it through the in-process host (same recipe as the RAOP self-test):
/// <c>ZILUX2_AIRPLAY2_SELFTEST=1</c> or via the reflection harness.
/// </summary>
internal static class AirPlay2LoopbackTest
{
    internal const string EnvironmentVariable = "ZILUX2_AIRPLAY2_SELFTEST";

    private const int AudioFrameCount = 200;

    private const int AlacPayloadBytes = 500;

    private const int FeedbackWaitMilliseconds = 2_500;

    private static int _passed;

    private static int _failed;

    public static bool IsRequested => string.Equals(
        Environment.GetEnvironmentVariable(EnvironmentVariable),
        "1",
        StringComparison.Ordinal);

    internal static int Run()
    {
        _passed = 0;
        _failed = 0;
        Console.WriteLine("[airplay2-test] starting AirPlay 2 loopback (HAP mock receiver)");
        HostLog.Info("[airplay2-test] starting AirPlay 2 loopback (HAP mock receiver)");

        var writeKey = Sha256("Zilux2.AirPlay2.Loopback.WriteKey");
        var readKey = Sha256("Zilux2.AirPlay2.Loopback.ReadKey");
        var audioKey = Sha256("Zilux2.AirPlay2.Loopback.AudioKey");
        var debug = new PairingDebug();

        AirPlay2MockDevice? mock = null;
        Ap2Connection? connection = null;
        try
        {
            mock = AirPlay2MockDevice.Start(writeKey, readKey);

            connection = Ap2Connection.Connect(
                new Ap2Target { Name = "Zilux2 Mock HomePod", Host = "127.0.0.1", Port = mock.RtspPort },
                new Ap2Options { AudioKey = audioKey, LatencyMin = 11_025, LatencyMax = 88_200 },
                (channel, _) => FakePairing(channel, writeKey, readKey, debug));

            // ---- pairing (plaintext phase, same TCP connection) ----
            Check("pair-setup M1 answered 200", debug.M1Status == 200, $"status={debug.M1Status}");
            Check("pair-setup M2 announces state=2", TlvValue(debug.M2, 6) is [2], DescribeTlv(debug.M2));
            Check("pair-setup M2 carries 16-byte salt", TlvValue(debug.M2, 2)?.Length == 16, DescribeTlv(debug.M2));
            Check("pair-setup M2 carries 384-byte SRP public key", TlvValue(debug.M2, 3)?.Length == 384, DescribeTlv(debug.M2));
            Check("pair-setup M3 answered 200", debug.M3Status == 200, $"status={debug.M3Status}");
            Check("pair-setup M4 announces state=4", TlvValue(debug.M4, 6) is [4], DescribeTlv(debug.M4));

            var pairRequest = mock.Stats().Find("POST", "/pair-setup");
            Check(
                "pair-setup sends X-Apple-HKP: 3",
                pairRequest?.Header("X-Apple-HKP") == "3",
                pairRequest?.Header("X-Apple-HKP") ?? "<missing>");

            // ---- encrypted channel ----
            Check("transport upgraded to HAP frames", connection.IsEncrypted, "IsEncrypted=false");
            var afterHandshake = mock.Stats();
            Check("mock detected the encrypted channel", afterHandshake.EncryptionStarted, "EncryptionStarted=false");
            Check(
                "OPTIONS and SETUP arrived encrypted",
                afterHandshake.EncryptedRequests >= 2,
                $"encrypted={afterHandshake.EncryptedRequests}");

            Check(
                "OPTIONS is skipped on the AP2 path",
                afterHandshake.Find("OPTIONS") is null,
                Describe(afterHandshake.Find("OPTIONS")));
            var infoRequest = afterHandshake.Find("GET", "/info");
            Check("GET /info answered 200", infoRequest?.ResponseStatus == 200, Describe(infoRequest));
            Check(
                "connection-level SETUP (no streams) received",
                afterHandshake.SessionSetupReceived && afterHandshake.SessionSetupStreamCount == 0,
                $"received={afterHandshake.SessionSetupReceived} streams={afterHandshake.SessionSetupStreamCount}");
            Check(
                "SETUP#1 timingProtocol is PTP",
                afterHandshake.SessionSetupTimingProtocol == "PTP",
                afterHandshake.SessionSetupTimingProtocol ?? "<missing>");
            Check(
                "SETUP#1 carries timingPeerInfo (PTP leader)",
                afterHandshake.SessionSetupHasTimingPeerInfo,
                $"hasTimingPeerInfo={afterHandshake.SessionSetupHasTimingPeerInfo}");
            Check(
                "SETUP#1 omits timing port in PTP mode",
                afterHandshake.SessionSetupTimingPort == 0,
                $"timingPort={afterHandshake.SessionSetupTimingPort}");
            Check(
                "SETPEERS delivered on the event plane",
                afterHandshake.SetPeersRequests >= 1,
                $"requests={afterHandshake.SetPeersRequests}");
            Check(
                "FLUSH mirrored the RECORD RTP-Info",
                afterHandshake.FlushWithRtpInfoReceived,
                "FLUSH without RTP-Info");
            Check(
                "SETUP#1 carries sessionUUID/deviceID/name",
                !string.IsNullOrEmpty(afterHandshake.SessionSetupSessionUuid)
                    && !string.IsNullOrEmpty(afterHandshake.SessionSetupDeviceId)
                    && !string.IsNullOrEmpty(afterHandshake.SessionSetupName),
                $"uuid={afterHandshake.SessionSetupSessionUuid} device={afterHandshake.SessionSetupDeviceId} name={afterHandshake.SessionSetupName}");
            var setupRequest = afterHandshake.Find("SETUP");
            Check("SETUP answered 200", setupRequest?.ResponseStatus == 200, Describe(setupRequest));
            Check(
                "SETUP uses binary plist content type",
                afterHandshake.SetupContentType == Ap2Setup.ContentType,
                afterHandshake.SetupContentType ?? "<missing>");
            Check(
                "stream SETUP (with streams) received",
                afterHandshake.StreamSetupReceived,
                $"received={afterHandshake.StreamSetupReceived}");
            Check(
                "SETUP contains exactly one stream",
                afterHandshake.SetupStreamCount == 1,
                $"streams={afterHandshake.SetupStreamCount}");
            Check("SETUP stream type is 96", afterHandshake.SetupStreamType == 96, $"type={afterHandshake.SetupStreamType}");
            Check("SETUP ct is ALAC (2)", afterHandshake.SetupCompressionType == 2, $"ct={afterHandshake.SetupCompressionType}");
            Check("SETUP spf is 352", afterHandshake.SetupFramesPerPacket == 352, $"spf={afterHandshake.SetupFramesPerPacket}");
            Check("SETUP sr is 44100", afterHandshake.SetupSampleRate == 44_100, $"sr={afterHandshake.SetupSampleRate}");
            Check("SETUP shk is 32 bytes", afterHandshake.SetupAudioKeyLength == 32, $"len={afterHandshake.SetupAudioKeyLength}");
            Check("SETUP latencyMin is 5292 (120 ms)", afterHandshake.SetupLatencyMin == 5_292, $"latencyMin={afterHandshake.SetupLatencyMin}");
            Check("SETUP latencyMax is 5292 (120 ms)", afterHandshake.SetupLatencyMax == 5_292, $"latencyMax={afterHandshake.SetupLatencyMax}");
            Check(
                "SETUP advertises our local control port",
                afterHandshake.StreamSetupControlPort == connection.LocalControlPort && connection.LocalControlPort > 0,
                $"advertised={afterHandshake.StreamSetupControlPort} local={connection.LocalControlPort}");
            Check("SETUP response carries Session: 1", connection.SessionId == "1", connection.SessionId ?? "<null>");
            Check(
                "SETUP response exposes audio data port",
                connection.DeviceDataPort == mock.AudioPort,
                $"device={connection.DeviceDataPort} mock={mock.AudioPort}");
            Check(
                "SETUP response exposes control port",
                connection.DeviceControlPort == mock.ControlPort,
                $"device={connection.DeviceControlPort} mock={mock.ControlPort}");
            Check(
                "two-phase order is SETUP#1 -> SETUP#2",
                afterHandshake.RtspRequests.FindIndex(r => r.Method == "SETUP") >= 0
                    && afterHandshake.RtspRequests.FindLastIndex(r => r.Method == "SETUP") > afterHandshake.RtspRequests.FindIndex(r => r.Method == "SETUP"),
                $"requests={afterHandshake.RtspRequests.Count}");

            // ---- RECORD + audio plane ----
            connection.BeginStreaming();
            var afterRecord = mock.Stats();
            Check("RECORD received", afterRecord.RecordReceived, "mock never saw RECORD");
            var recordRequest = afterRecord.Find("RECORD");
            Check("RECORD answered 200", recordRequest?.ResponseStatus == 200, Describe(recordRequest));
            Check("RECORD body is empty", afterRecord.RecordBodyLength == 0, $"len={afterRecord.RecordBodyLength}");
            Check("RECORD has no RTP-Info", !afterRecord.RecordHasRtpInfo, "RTP-Info present");

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

            Check("audio frames accepted", accepted == AudioFrameCount, $"accepted={accepted}");
            Check("packets sent counter", connection.PacketsSent == AudioFrameCount, $"sent={connection.PacketsSent}");
            Thread.Sleep(1_500);

            var audioStats = mock.Stats();
            Check("audio packets decrypted", audioStats.AudioPackets == AudioFrameCount, $"packets={audioStats.AudioPackets}");
            Check(
                "audio sequence contiguous",
                audioStats.FirstSequence == 0 && audioStats.LastSequence == AudioFrameCount - 1 && audioStats.SequenceGaps == 0,
                $"first={audioStats.FirstSequence} last={audioStats.LastSequence} gaps={audioStats.SequenceGaps}");
            Check(
                "audio RTP timestamp step 352",
                HasConstantTimestampStep(audioStats.Timestamps, Ap2Connection.SamplesPerFrame),
                DescribeTimestamps(audioStats.Timestamps));
            Check(
                "audio payload bytes accepted by AEAD",
                audioStats.AudioPayloadBytes == (long)AudioFrameCount * AlacPayloadBytes,
                $"bytes={audioStats.AudioPayloadBytes}");
            Check("audio AEAD/AAD/nonce verified", audioStats.DecryptFailures == 0, $"failures={audioStats.DecryptFailures}");

            // ---- retransmission (sender answers type 0x55 requests from its history) ----
            Check("audio history retained for retransmission", connection.AudioHistoryCount >= 64, $"history={connection.AudioHistoryCount}");
            var resendResponsesBefore = audioStats.ResendResponses;
            var resendSentBefore = connection.ResendResponsesSent;
            var resent = mock.RequestResend(190, 3);
            Check("retransmit request sent", resent, $"control port={audioStats.StreamSetupControlPort}");
            Thread.Sleep(400);
            var resendStats = mock.Stats();
            Check(
                "retransmit responses delivered",
                resendStats.ResendResponses >= resendResponsesBefore + 3,
                $"responses={resendStats.ResendResponses} before={resendResponsesBefore}");
            Check(
                "retransmit sequences match request",
                resendStats.ResentSequences.Contains((ushort)190)
                    && resendStats.ResentSequences.Contains((ushort)191)
                    && resendStats.ResentSequences.Contains((ushort)192),
                string.Join(',', resendStats.ResentSequences));
            Check(
                "sender counted retransmit responses",
                connection.ResendResponsesSent >= resendSentBefore + 3,
                $"sent={connection.ResendResponsesSent} before={resendSentBefore}");

            // ---- /feedback keep-alive ----
            Thread.Sleep(FeedbackWaitMilliseconds);
            var feedbackStats = mock.Stats();
            Check("feedback keep-alive delivered", feedbackStats.FeedbackRequests >= 1, $"requests={feedbackStats.FeedbackRequests}");
            Check("feedback answered 200", connection.LastFeedbackStatus == 200, $"status={connection.LastFeedbackStatus}");
            var feedbackRequest = feedbackStats.Find("POST", "/feedback");
            Check(
                "feedback body is a binary plist",
                feedbackRequest?.Body.Length >= 8 && feedbackRequest?.Body[0] == 'b',
                feedbackRequest is null ? "<missing>" : Convert.ToHexString(feedbackRequest.Body));

            // ---- SET_PARAMETER volume / FLUSH / TEARDOWN ----
            connection.SetVolume(60);
            var volumeStats = mock.Stats();
            Check(
                "volume maps 60% to -12.000000 dB",
                volumeStats.VolumeBody?.Contains("volume: -12.000000", StringComparison.Ordinal) == true,
                volumeStats.VolumeBody?.Trim() ?? "<missing>");
            var setParameterRequest = volumeStats.Find("SET_PARAMETER");
            Check("SET_PARAMETER answered 200", setParameterRequest?.ResponseStatus == 200, Describe(setParameterRequest));

            connection.Flush();
            var flushStats = mock.Stats();
            Check("FLUSH received", flushStats.FlushReceived, "mock never saw FLUSH");
            Check("FLUSH answered 200", flushStats.Find("FLUSH")?.ResponseStatus == 200, Describe(flushStats.Find("FLUSH")));

            connection.Teardown();
            Thread.Sleep(300);
            var final = mock.Stats();
            Check("TEARDOWN received", final.TeardownReceived, "mock never saw TEARDOWN");
            Check("TEARDOWN answered 200", final.Find("TEARDOWN")?.ResponseStatus == 200, Describe(final.Find("TEARDOWN")));
            Check("mock closed the RTSP connection", final.TeardownClosed || final.RtspDisconnected, $"closed={final.TeardownClosed} disconnected={final.RtspDisconnected}");
            Check("no unknown requests", final.UnknownRequests == 0, $"unknown={final.UnknownRequests}");
            Check("mock recorded no errors", final.Errors.Count == 0, string.Join(" | ", final.Errors));
        }
        catch (Exception ex)
        {
            _failed++;
            Report(false, "harness completed", $"{ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            connection?.Dispose();
            mock?.Dispose();
        }

        Console.WriteLine($"[airplay2-test] summary passed={_passed} failed={_failed}");
        HostLog.Info($"[airplay2-test] summary passed={_passed} failed={_failed}");
        return _failed == 0 ? 0 : 1;
    }

    private sealed class PairingDebug
    {
        public int M1Status { get; set; }

        public byte[] M2 { get; set; } = [];

        public int M3Status { get; set; }

        public byte[] M4 { get; set; } = [];
    }

    private static Task<Ap2PairingResult> FakePairing(
        HapEncryptedTransport channel,
        byte[] writeKey,
        byte[] readKey,
        PairingDebug debug)
    {
        // Minimal transient pair-setup: M1 announces transient method, M3 completes with the fake
        // SRP proof; a real implementation replaces the bodies but keeps the same request shape.
        var m1 = BuildTlv(
            (6, [1]),
            (0, [0]),
            (0x13, [0x10]));
        var m1Response = channel.Send("POST", "/pair-setup", PairingHeaders(), m1, "HTTP/1.1");
        debug.M1Status = m1Response.StatusCode;
        debug.M2 = m1Response.Body;

        var m3 = BuildTlv(
            (6, [3]),
            (0, [0]));
        var m3Response = channel.Send("POST", "/pair-setup", PairingHeaders(), m3, "HTTP/1.1");
        debug.M3Status = m3Response.StatusCode;
        debug.M4 = m3Response.Body;

        return Task.FromResult(new Ap2PairingResult
        {
            WriteCryptor = new TestFrameCryptor(writeKey),
            ReadCryptor = new TestFrameCryptor(readKey),
            SharedSecret = Sha256("Zilux2.AirPlay2.Loopback.SharedSecret"),
        });
    }

    private static List<KeyValuePair<string, string>> PairingHeaders() =>
    [
        new("Content-Type", "application/octet-stream"),
        new("X-Apple-HKP", "3"),
        new("User-Agent", "iTunes/12.12.10 (Windows; Microsoft Windows 10 x64)"),
    ];

    private static byte[] BuildTlv(params (byte Type, byte[] Value)[] items)
    {
        using var output = new System.IO.MemoryStream();
        foreach (var (type, value) in items)
        {
            output.WriteByte(type);
            if (value.Length < 0xFF)
            {
                output.WriteByte((byte)value.Length);
            }
            else
            {
                output.WriteByte(0xFF);
                output.WriteByte((byte)(value.Length >> 8));
                output.WriteByte((byte)value.Length);
            }

            output.Write(value, 0, value.Length);
        }

        return output.ToArray();
    }

    private static byte[]? TlvValue(byte[] data, byte type)
    {
        var position = 0;
        while (position + 2 <= data.Length)
        {
            var currentType = data[position];
            int length = data[position + 1];
            var headerSize = 2;
            if (length == 0xFF)
            {
                if (position + 4 > data.Length)
                {
                    return null;
                }

                length = (data[position + 2] << 8) | data[position + 3];
                headerSize = 4;
            }

            if (position + headerSize + length > data.Length)
            {
                return null;
            }

            if (currentType == type)
            {
                return data.AsSpan(position + headerSize, length).ToArray();
            }

            position += headerSize + length;
        }

        return null;
    }

    private static string DescribeTlv(byte[] data) => data.Length == 0 ? "<empty>" : Convert.ToHexString(data);

    private static string Describe(Ap2MockRequest? request) => request is null
        ? "<missing>"
        : $"{request.Method} {request.Uri} -> {request.ResponseStatus}";

    private static bool HasConstantTimestampStep(List<uint> timestamps, int expectedStep)
    {
        if (timestamps.Count < 2)
        {
            return timestamps.Count == 1;
        }

        for (var i = 1; i < timestamps.Count; i++)
        {
            if ((uint)(timestamps[i] - timestamps[i - 1]) != (uint)expectedStep)
            {
                return false;
            }
        }

        return true;
    }

    private static string DescribeTimestamps(List<uint> timestamps) =>
        timestamps.Count == 0 ? "<none>" : $"{timestamps.First()}..{timestamps.Last()} count={timestamps.Count}";

    private static byte[] Sha256(string text) => SHA256.HashData(Encoding.UTF8.GetBytes(text));

    private static void Check(string name, bool passed, string? detail) => Report(passed, name, detail);

    private static void Report(bool passed, string name, string? detail)
    {
        var suffix = string.IsNullOrEmpty(detail) ? string.Empty : $" — {detail}";
        var line = $"[airplay2-test] {(passed ? "PASS" : "FAIL")} {name}{suffix}";
        Console.WriteLine(line);
        if (passed)
        {
            _passed++;
            HostLog.Info(line);
        }
        else
        {
            _failed++;
            HostLog.Error(line);
        }
    }
}
