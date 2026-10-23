using System.Buffers.Binary;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using Zilux2.AirPlay.Crypto;
using Zilux2.AirPlay.Protocol;

namespace Zilux2.AirPlay.Ap2;

/// <summary>AirPlay 2 receiver to connect to.</summary>
internal sealed class Ap2Target
{
    public required string Name { get; init; }

    public required string Host { get; init; }

    public int Port { get; init; } = 7000;

    public string? DeviceId { get; init; }
}

/// <summary>Knobs for <see cref="Ap2Connection"/>.</summary>
internal sealed class Ap2Options
{
    public string UserAgent { get; init; } = "iTunes/12.12.10 (Windows; Microsoft Windows 10 x64)";

    public int ConnectTimeoutMilliseconds { get; init; } = 5_000;

    public int IoTimeoutMilliseconds { get; init; } = 10_000;

    /// <summary>Audio stream key (SETUP <c>shk</c>); a random 32-byte key is generated when null.</summary>
    public byte[]? AudioKey { get; init; }

    public bool UseAlac { get; init; } = true;

    public int LatencyMin { get; init; } = 11_025;

    public int LatencyMax { get; init; } = 88_200;

    /// <summary>
    /// Requested output latency in milliseconds, used when <see cref="LatencyMin"/> and
    /// <see cref="LatencyMax"/> are not set to the same explicit frame count. 120 ms matches the
    /// reference sender's default and keeps the receiver buffer small enough for responsive control.
    /// </summary>
    public int LatencyMilliseconds { get; init; } = 120;

    public uint Ssrc { get; init; } = 874_812_771;

    public string DeviceId { get; init; } = "AA:BB:CC:DD:EE:FF";

    /// <summary>
    /// Sends <c>POST /auth-setup</c> (33 bytes: 0x01 + Curve25519 public key) before SETUP.
    /// Only AirPort-class receivers with MFi-SAP encryption need it; HomePod answers 404.
    /// </summary>
    public bool SendAuthSetup { get; init; }

    /// <summary>Sends <c>OPTIONS *</c> before the handshake. The reference AP2 sender does not.</summary>
    public bool SendOptions { get; init; }

    /// <summary>Uses our own address in the <c>rtsp://</c> request URI (pyatv behaviour).</summary>
    public bool UseLocalRtspUri { get; init; } = true;

    /// <summary>Opens the HAP-encrypted event channel advertised by the phase-1 SETUP response.</summary>
    public bool EnableEventChannel { get; init; } = true;

    /// <summary>Skips RTSP <c>RECORD</c> when the receiver's phase-1 SETUP reply says <c>skipRecord</c>.</summary>
    public bool RespectSkipRecord { get; init; } = true;

    /// <summary>
    /// Requests PTP clocking instead of NTP. PTP is required by HomePod mini receivers: with
    /// <c>NTP</c> the session-level SETUP is answered but the following stream SETUP is silently
    /// dropped, while <c>PTP</c> completes the handshake (verified on HomePod mini, 2026-10-20).
    /// </summary>
    public bool TimingProtocolPtp { get; init; } = true;

    /// <summary>Sender name advertised in the phase-1 SETUP plist.</summary>
    public string Name { get; init; } = "Zilux2";
}

/// <summary>Result of the pairing phase: byte-stream cryptors for both directions.</summary>
internal sealed class Ap2PairingResult
{
    public required IFrameCryptor WriteCryptor { get; init; }

    public required IFrameCryptor ReadCryptor { get; init; }

    public byte[] SharedSecret { get; init; } = [];
}

/// <summary>
/// Performs the transient pairing exchange on the already-connected plaintext channel and returns
/// the cryptors that upgrade it. The real implementation delegates to
/// <c>Zilux2.AirPlay.Crypto.HapPairing.TransientAsync</c>; the loopback test injects a fake one.
/// </summary>
internal delegate Task<Ap2PairingResult> Ap2PairingHandler(HapEncryptedTransport channel, CancellationToken cancellationToken);

/// <summary>
/// AirPlay 2 audio connection, shaped like <see cref="RaopConnection"/> so the service can pick
/// either stack: <see cref="Connect"/> runs pairing (optional delegate) + encrypted OPTIONS/SETUP,
/// <see cref="BeginStreaming"/> sends RECORD and starts the <c>/feedback</c> keep-alive,
/// <see cref="SendAudioFrame"/> pushes encrypted AP2 audio packets over UDP, and
/// <see cref="SetVolume"/>/<see cref="Flush"/>/<see cref="Teardown"/> map to the matching RTSP calls.
/// </summary>
internal sealed class Ap2Connection : IDisposable
{
    public const int SampleRate = 44_100;

    public const int SamplesPerFrame = 352;

    private readonly HapEncryptedTransport _transport;
    private readonly Ap2Options _options;
    private readonly byte[] _audioKey;
    private readonly List<RtspResponse> _rtspHistory = [];
    private UdpClient? _audioSocket;
    private UdpClient? _controlSocket;
    private UdpClient? _timingSocket;
    private IAp2PtpMaster? _ptp;
    private Timer? _syncTimer;

    /// <summary>
    /// Output latency in RTP frames. The play-session SETUP advertises it as
    /// <c>latencyMin</c>/<c>latencyMax</c>; receivers may override it in the reply. Audio RTP
    /// timestamps start at this value and the PTP/NTP sync packets subtract it to tell the
    /// receiver which frame it should be playing at the given master-clock instant.
    /// </summary>
    private readonly uint _latencyFrames;

    /// <summary>NTP instant captured when streaming started (NTP timing mode only).</summary>
    private ulong _startNtp;

    private Ap2Feedback? _feedback;
    private string _sessionUri = string.Empty;
    private ushort _sequence;
    private uint _timestamp;
    private bool _streaming;
    private bool _disposed;

    private readonly byte[] _sharedSecret;
    private readonly string _dacpId = Convert.ToHexString(RandomNumberGenerator.GetBytes(8));
    private readonly uint _activeRemote = BitConverter.ToUInt32(RandomNumberGenerator.GetBytes(4));
    private string _sessionUuid = Guid.NewGuid().ToString("D").ToUpperInvariant();
    private string _serverName = "AirTunes/980.77.2";
    private int _sessionIdValue;
    private string _timingProtocol = "NTP";
    private TcpClient? _eventClient;
    private HapSessionCrypt? _eventCryptor;

    private Ap2Connection(HapEncryptedTransport transport, Ap2Target target, Ap2Options options, byte[] sharedSecret)
    {
        _transport = transport;
        _sharedSecret = sharedSecret;
        Target = target;
        _options = options;

        // Reference sender recipe (verified against HomePod OS 27): the SETUP "shk" and the audio
        // channel key are HKDF-SHA512(sharedSecret, "Events-Salt", "Events-Write-Encryption-Key", 32).
        // (The control/event channels derive their own keys from the same secret.)
        _audioKey = sharedSecret.Length >= 32
            ? HapKeyDerivation.DeriveChannelKeys(
                sharedSecret,
                "Events-Salt",
                "Events-Write-Encryption-Key",
                "Events-Read-Encryption-Key").WriteKey
            : options.AudioKey is { Length: 32 } fallback ? fallback.ToArray() : RandomNumberGenerator.GetBytes(32);

        // Output latency: explicit frame count wins, otherwise convert the millisecond request.
        _latencyFrames = options.LatencyMin > 0 && options.LatencyMin == options.LatencyMax
            ? (uint)options.LatencyMin
            : (uint)Math.Max(1, (long)Math.Max(0, options.LatencyMilliseconds) * SampleRate / 1000);
    }

    public Ap2Target Target { get; }

    public string? SessionId { get; private set; }

    public Ap2SetupResult? Setup { get; private set; }

    /// <summary>SETUP stream key ("shk") used for the audio channel.</summary>
    public byte[] AudioKey => _audioKey;

    // The AirPlay 2 RTP stream is keyed by the SDP/RTSP session id: receivers match
    // incoming audio packets by SSRC == session id (pyatv / airplay2-sender-cpp).
    public uint Ssrc => _sessionIdValue > 0 ? (uint)_sessionIdValue : _options.Ssrc;

    public ushort NextSequence => _sequence;

    public uint CurrentRtpTimestamp => _timestamp;

    public int PacketsSent { get; private set; }

    public bool IsStreaming => _streaming;

    public bool IsEncrypted => _transport.IsEncrypted;

    /// <summary>UDP port that receives AP2 audio packets (from the SETUP response).</summary>
    public int DeviceDataPort { get; private set; }

    /// <summary>UDP port that receives the sender's control packets (from the SETUP response).</summary>
    public int DeviceControlPort { get; private set; }

    /// <summary>TCP port of the HAP-encrypted event channel (phase-1 SETUP response).</summary>
    public int DeviceEventPort { get; private set; }

    /// <summary>True once the event channel was connected and HAP encryption enabled on it.</summary>
    public bool EventChannelConnected { get; private set; }

    /// <summary>Clock protocol negotiated with the receiver ("NTP" or "PTP").</summary>
    public string TimingProtocol => _timingProtocol;

    /// <summary>Per-connection UUID advertised in the phase-1 SETUP plist.</summary>
    public string SessionUuid => _sessionUuid;

    /// <summary>uint32 session id used in the RTSP URI and as the stream connection id.</summary>
    public int SessionNumber => _sessionIdValue;

    public int LocalControlPort { get; private set; }

    public int LocalTimingPort { get; private set; }

    public int ControlPacketsReceived => _controlPackets;

    /// <summary>Number of audio retransmission requests (type 0x55) received on the control socket.</summary>
    public int ResendRequestsReceived => Volatile.Read(ref _resendRequests);

    /// <summary>Number of retransmission responses (type 0xD6) written back to the device.</summary>
    public int ResendResponsesSent => Volatile.Read(ref _resentPackets);

    /// <summary>Number of cached audio packets currently available for retransmission.</summary>
    public int AudioHistoryCount
    {
        get
        {
            lock (_audioHistoryGate)
            {
                return _audioHistory.Count(static entry => entry is not null);
            }
        }
    }

    public int TimingPacketsReceived => _timingPackets;

    public int FeedbackRequests => _feedback?.Count ?? 0;

    public int LastFeedbackStatus => _feedback?.LastStatus ?? 0;

    public string? LastError { get; private set; }

    public int LastTeardownStatus { get; private set; }

    public IReadOnlyList<RtspResponse> RtspHistory => _rtspHistory;

    /// <summary>
    /// Opens the control TCP connection, runs the optional pairing delegate (plaintext
    /// <c>/pair-setup</c>), upgrades the same socket to HAP frames, then performs OPTIONS + SETUP.
    /// </summary>
    public static Ap2Connection Connect(Ap2Target target, Ap2Options? options = null, Ap2PairingHandler? pairing = null)
    {
        ArgumentNullException.ThrowIfNull(target);
        options ??= new Ap2Options();

        var transport = HapEncryptedTransport.Connect(
            target.Host,
            target.Port,
            TimeSpan.FromMilliseconds(options.ConnectTimeoutMilliseconds));

        try
        {
            byte[] sharedSecret = [];
            if (pairing is not null)
            {
                var pairingResult = pairing(transport, CancellationToken.None).GetAwaiter().GetResult();
                transport.EnableEncryption(pairingResult.WriteCryptor, pairingResult.ReadCryptor);
                sharedSecret = pairingResult.SharedSecret;
            }

            var connection = new Ap2Connection(transport, target, options, sharedSecret);
            connection.Handshake();
            return connection;
        }
        catch
        {
            transport.Dispose();
            throw;
        }
    }

    private void Handshake()
    {
        // The receiver needs our local UDP ports before it answers SETUP.
        _controlSocket = new UdpClient(new IPEndPoint(IPAddress.Any, 0));
        LocalControlPort = ((IPEndPoint)_controlSocket.Client.LocalEndPoint!).Port;
        _timingSocket = new UdpClient(new IPEndPoint(IPAddress.Any, 0));
        LocalTimingPort = ((IPEndPoint)_timingSocket.Client.LocalEndPoint!).Port;
        _audioSocket = new UdpClient(new IPEndPoint(IPAddress.Any, 0));
        // The RTP timestamp base is a random 32-bit value (reference sender); sync packets subtract
        // the negotiated latency to tell the receiver which frame is currently audible.
        _timestamp = BitConverter.ToUInt32(RandomNumberGenerator.GetBytes(4));
        _sequence = 0;
        _sessionIdValue = Random.Shared.Next(1, int.MaxValue);

        if (_options.SendOptions)
        {
            var optionsResponse = _transport.Send("OPTIONS", "*", CommonHeaders());
            _rtspHistory.Add(optionsResponse);
            if (optionsResponse.StatusCode != 200)
            {
                throw new InvalidOperationException(
                    $"AirPlay 2 OPTIONS was rejected: {optionsResponse.Describe()}");
            }

            _serverName = optionsResponse.Header("Server") ?? _serverName;
        }
        else
        {
            HostLog.Info("[airplay] AP2 skipping OPTIONS (reference sender goes straight to GET /info)");
        }

        TryGetInfo();

        var localAddress = ResolveLocalAddress(Target.Host);
        var sessionUriHost = _options.UseLocalRtspUri ? localAddress : Target.Host;
        _sessionUri = $"rtsp://{sessionUriHost}/{_sessionIdValue}";

        // PTP: the sender is the PTP grandmaster; the receiver locks its audio clock to our
        // Sync/Follow_Up/Announce packets on UDP 319/320. The master must be running before
        // SETUP#1 so its clock identity can be advertised in timingPeerInfo.ClockID.
        // The master is process-wide (UDP 319/320 can only be bound once): the first connection
        // starts it and later connections only register their receiver as an extra peer, so all
        // receivers share one clock identity and one media timeline.
        if (_options.TimingProtocolPtp)
        {
            _ptp = Ap2SharedPtp.Acquire(localAddress, [Target.Host]);
        }

        SendAuthSetup();

        // Phase 1: connection-level SETUP (no "streams"); the receiver replies with an eventPort.
        _timingProtocol = _options.TimingProtocolPtp ? "PTP" : "NTP";
        var sessionBody = Ap2Setup.BuildSessionBody(new Ap2SessionSetupOptions
        {
            DeviceId = _options.DeviceId,
            MacAddress = _options.DeviceId,
            SessionUuid = _sessionUuid,
            TimingPort = LocalTimingPort,
            TimingProtocol = _timingProtocol,
            Name = _options.Name,
            TimingPeerId = _options.TimingProtocolPtp ? Guid.NewGuid().ToString("D") : null,
            TimingPeerClockId = _ptp?.ClockId ?? 0,
            TimingPeerAddresses = _options.TimingProtocolPtp
                ? Ap2SharedPtp.CurrentEndpoints(localAddress)
                : null,
            // Reference (airflash session.rs setup dict): "groupContainsGroupLeader" is always
            // false for a one-to-one sender and groupUUID is only present for a configured group;
            // the earlier revision wrongly reused the session UUID here.
            GroupUuid = null,
            GroupContainsGroupLeader = false,
        });

        var sessionHeaders = CommonHeaders("SETUP");
        sessionHeaders.Add(new KeyValuePair<string, string>("Content-Type", Ap2Setup.ContentType));
        var sessionResponse = _transport.Send(
            "SETUP",
            _sessionUri,
            sessionHeaders,
            sessionBody);
        _rtspHistory.Add(sessionResponse);
        if (sessionResponse.StatusCode != 200)
        {
            throw new InvalidOperationException(
                $"AirPlay 2 session SETUP was rejected: {sessionResponse.Describe()} body={Convert.ToHexString(sessionResponse.Body)}");
        }

        var sessionSetup = Ap2Setup.ParseResponse(sessionResponse.Body);
        DeviceEventPort = sessionSetup.EventPort;

        if (_options.EnableEventChannel && DeviceEventPort > 0)
        {
            ConnectEventChannel(DeviceEventPort);
        }

        // PTP mode: the receiver participates in the gPTP domain we host. The shared PTP master
        // only needs the receiver addresses (it must NOT send Sync to our own address); the RTSP
        // SETPEERS body, on the other hand, lists every active receiver followed by our local
        // address so each device knows the full gPTP endpoint set (multi-device delivery).
        if (_options.TimingProtocolPtp)
        {
            _ptp?.SetPeers([Target.Host]);
            var activeEndpoints = Ap2SharedPtp.CurrentEndpoints(localAddress);
            SendSetPeers(activeEndpoints);
            HostLog.Info(
                $"[airplay] AP2 PTP shared: clock=0x{(Ap2SharedPtp.ClockId):X16} " +
                $"peers={Ap2SharedPtp.CurrentPeers().Count} refs={Ap2SharedPtp.ReferenceCount} " +
                $"setpeers=[{string.Join(", ", activeEndpoints)}]");
        }

        // The reference sender sends RECORD *before* the play-session SETUP and only sends
        // SETUP#2 once RECORD has been acknowledged. It does not wait for event-channel traffic.
        // HomePod-class receivers answer the session SETUP with skipRecord=true, which means the
        // Apple sender skips RECORD entirely for this connection; honour it so the receiver's
        // RECORD state stays clean before the play-session SETUP.
        if (!(sessionSetup.SkipRecord && _options.RespectSkipRecord))
        {
            var recordResponse = _transport.Send("RECORD", _sessionUri, CommonHeaders("RECORD"));
            _rtspHistory.Add(recordResponse);
            if (recordResponse.StatusCode != 200)
            {
                throw new InvalidOperationException(
                    $"AirPlay 2 RECORD was rejected: {recordResponse.Describe()} body={Convert.ToHexString(recordResponse.Body)}");
            }
        }

        // The play-session FLUSH immediately follows RECORD with the same RTP mapping headers; the
        // receiver uses it to discard buffered frames and start the timeline at our first packet.
        SendFlushWithRtpInfo();

        // Phase 2: play-session SETUP; root plist contains only "streams".
        var streamBody = Ap2Setup.BuildStreamBody(new Ap2SetupOptions
        {
            AudioKey = _audioKey,
            ControlPort = LocalControlPort,
            TimingPort = LocalTimingPort,
            LatencyMin = (int)_latencyFrames,
            LatencyMax = (int)_latencyFrames,
            UseAlac = _options.UseAlac,
            SampleRate = SampleRate,
            CompressionType = _options.UseAlac ? Ap2Setup.AlacCompressionType : Ap2Setup.PcmCompressionType,
            DeviceId = _options.DeviceId,
            SessionId = _sessionIdValue,
        });

        var setupHeaders = CommonHeaders("SETUP");
        setupHeaders.Add(new KeyValuePair<string, string>("Content-Type", Ap2Setup.ContentType));
        var setupResponse = _transport.Send("SETUP", _sessionUri, setupHeaders, streamBody);
        _rtspHistory.Add(setupResponse);
        if (setupResponse.StatusCode != 200)
        {
            throw new InvalidOperationException(
                $"AirPlay 2 SETUP was rejected: {setupResponse.Describe()} body={Convert.ToHexString(setupResponse.Body)}");
        }

        Setup = Ap2Setup.ParseResponse(setupResponse.Body);
        var sessionHeader = setupResponse.Header("Session");
        SessionId = sessionHeader is null ? null : sessionHeader.Split(';')[0].Trim();

        var stream = Setup.Streams.Count > 0 ? Setup.Streams[0] : null;
        DeviceDataPort = stream is { DataPort: > 0 } ? stream.DataPort : Setup.ServicePort;
        DeviceControlPort = stream is { ControlPort: > 0 } ? stream.ControlPort : Setup.ControlPort;
        if (DeviceDataPort <= 0)
        {
            throw new InvalidOperationException(
                $"AirPlay 2 SETUP response did not expose an audio port. Body={Convert.ToHexString(setupResponse.Body)}");
        }

        _audioSocket.Connect(Target.Host, DeviceDataPort);
        _ = Task.Run(() => DrainUdp(_controlSocket, isTiming: false));
        _ = Task.Run(() => DrainUdp(_timingSocket, isTiming: true));
    }

    /// <summary>Best-effort <c>GET /info</c>; some receivers expect it before a stream SETUP.</summary>
    private void TryGetInfo()
    {
        try
        {
            var response = _transport.Send("GET", "/info", CommonHeaders());
            _rtspHistory.Add(response);
            HostLog.Info($"[airplay] AP2 GET /info -> {response.StatusCode} ({response.Body.Length} bytes)");
        }
        catch (Exception ex)
        {
            HostLog.Warn($"[airplay] AP2 GET /info failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    /// <summary>
    /// Opens the HAP-encrypted event channel the receiver announced in the phase-1 SETUP response.
    /// pyatv pins the event direction: client output = Events-Read key, client input = Events-Write key.
    /// </summary>
    private void ConnectEventChannel(int eventPort)
    {
        if (_sharedSecret.Length < 32)
        {
            HostLog.Warn("[airplay] AP2 event channel skipped: no pairing shared secret available.");
            return;
        }

        Exception? last = null;
        for (var attempt = 1; attempt <= 5; attempt++)
        {
            try
            {
                var client = new TcpClient { NoDelay = true };
                if (!client.ConnectAsync(Target.Host, eventPort)
                        .Wait(TimeSpan.FromMilliseconds(_options.ConnectTimeoutMilliseconds)))
                {
                    client.Dispose();
                    throw new TimeoutException("event channel connect timed out");
                }

                var (eventWriteKey, eventReadKey) = HapKeyDerivation.DeriveChannelKeys(
                    _sharedSecret,
                    "Events-Salt",
                    "Events-Read-Encryption-Key",
                    "Events-Write-Encryption-Key");
                var cryptor = new HapSessionCrypt(eventWriteKey, eventReadKey);
                var stream = client.GetStream();

                _eventClient = client;
                _eventCryptor = cryptor;
                EventChannelConnected = true;
                _ = Task.Run(() => EventChannelLoop(stream, cryptor));
                HostLog.Info($"[airplay] AP2 event channel connected on {Target.Host}:{eventPort} (attempt {attempt})");
                return;
            }
            catch (Exception ex)
            {
                last = ex;
                Thread.Sleep(500);
            }
        }

        HostLog.Warn($"[airplay] AP2 event channel connect failed: {last?.GetType().Name}: {last?.Message}");
    }

    private void EventChannelLoop(NetworkStream stream, HapSessionCrypt cryptor)
    {
        var pending = new List<byte>(4096);
        var readBuffer = new byte[4096];
        try
        {
            while (!_disposed)
            {
                var read = stream.Read(readBuffer, 0, readBuffer.Length);
                if (read <= 0)
                {
                    return;
                }

                var plain = cryptor.Decrypt(readBuffer.AsSpan(0, read));
                if (plain.Length == 0)
                {
                    continue;
                }

                pending.AddRange(plain);
                ProcessEventRequests(stream, cryptor, pending);
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or SocketException)
        {
            HostLog.Warn($"[airplay] AP2 event channel ended: {ex.GetType().Name}");
        }
    }

    private void ProcessEventRequests(NetworkStream stream, HapSessionCrypt cryptor, List<byte> pending)
    {
        while (true)
        {
            var headEnd = FindHeaderEnd(pending);
            if (headEnd < 0)
            {
                return;
            }

            var head = Encoding.ASCII.GetString(pending.GetRange(0, headEnd).ToArray());
            var contentLength = 0;
            var cseq = "0";
            foreach (var line in head.Split("\r\n"))
            {
                var colon = line.IndexOf(':');
                if (colon <= 0)
                {
                    continue;
                }

                var key = line[..colon].Trim();
                var value = line[(colon + 1)..].Trim();
                if (key.Equals("Content-Length", StringComparison.OrdinalIgnoreCase) &&
                    int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
                {
                    contentLength = parsed;
                }
                else if (key.Equals("CSeq", StringComparison.OrdinalIgnoreCase))
                {
                    cseq = value;
                }
            }

            var total = headEnd + 4 + contentLength;
            if (pending.Count < total)
            {
                return;
            }

            var firstLine = head.Split("\r\n")[0];
            HostLog.Info($"[airplay] AP2 event request: {firstLine} (CSeq={cseq})");

            var response =
                $"RTSP/1.0 200 OK\r\nServer: {_serverName}\r\nCSeq: {cseq}\r\n\r\n";
            var encrypted = cryptor.Encrypt(Encoding.ASCII.GetBytes(response));
            lock (stream)
            {
                stream.Write(encrypted, 0, encrypted.Length);
                stream.Flush();
            }

            pending.RemoveRange(0, total);
        }
    }

    private static int FindHeaderEnd(List<byte> buffer)
    {
        for (var i = 0; i + 3 < buffer.Count; i++)
        {
            if (buffer[i] == (byte)'\r' && buffer[i + 1] == (byte)'\n' &&
                buffer[i + 2] == (byte)'\r' && buffer[i + 3] == (byte)'\n')
            {
                return i;
            }
        }

        return -1;
    }

    /// <summary>
    /// Sends <c>POST /auth-setup</c>: one byte (0x01 = unencrypted MFi-SAP) followed by a
    /// Curve25519 public key. AirPlay 2 receivers require this step before accepting SETUP;
    /// the 200 response carries an MFi certificate chain that audio-only senders can ignore.
    /// </summary>
    private void SendAuthSetup()
    {
        if (!_options.SendAuthSetup)
        {
            return;
        }

        var (_, publicKey) = X25519.GenerateKeyPair();
        var body = new byte[33];
        body[0] = 0x01;
        publicKey.CopyTo(body, 1);

        var headers = CommonHeaders();
        headers.Add(new KeyValuePair<string, string>("Content-Type", "application/octet-stream"));
        var response = _transport.Send("POST", "/auth-setup", headers, body);
        _rtspHistory.Add(response);
        if (response.StatusCode != 200)
        {
            HostLog.Warn(
                $"[airplay] AP2 /auth-setup returned {response.StatusCode} {response.Reason}; continuing.");
        }
    }

    /// <summary>
    /// Marks the session as streaming and starts the 2-second <c>/feedback</c> keep-alive.
    /// RECORD is already sent by <see cref="Handshake"/> (before the play-session SETUP), matching
    /// the reference sender recipe; receivers tear the session down after ~30 s without feedback.
    /// </summary>
    public void BeginStreaming()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_streaming)
        {
            return;
        }

        if (_audioSocket is null || string.IsNullOrEmpty(_sessionUri))
        {
            throw new InvalidOperationException("AirPlay 2 connection is not handshaked.");
        }

        _streaming = true;
        _feedback = new Ap2Feedback(_transport, userAgent: _options.UserAgent);
        _feedback.Start();

        // The playout timeline starts at our first sync. In PTP mode the sync packet carries the
        // grandmaster clock sample directly (the receiver is the slave); in NTP mode the packet
        // carries an NTP instant anchored once at stream start plus framesSent.
        _startNtp = NtpNow();
        SendSyncPacket(first: true);
        var syncPeriod = _options.TimingProtocolPtp ? 100 : 1_000;
        _syncTimer = new Timer(
            static state => ((Ap2Connection)state!).SendSyncPacket(first: false),
            this,
            syncPeriod,
            syncPeriod);
        HostLog.Info(
            $"[airplay] AP2 streaming: latency={_latencyFrames} frames, timing={_timingProtocol}, " +
            $"ptpMaster={(_ptp is null ? "off" : $"clock=0x{_ptp.ClockId:X16}")}, sync={syncPeriod}ms");
    }

    /// <summary>
    /// Builds and sends one AP2 sync packet over the local control socket. PTP mode uses the
    /// 28-byte variant (0xD7, raw Unix-epoch nanoseconds + PTP clock id); NTP mode uses the
    /// 20-byte variant (0xD4).
    /// </summary>
    private void SendSyncPacket(bool first)
    {
        if (_disposed || _controlSocket is null || DeviceControlPort <= 0)
        {
            return;
        }

        try
        {
            byte[] packet;
            if (_options.TimingProtocolPtp)
            {
                var nowNs = _ptp?.NowNs ?? Ap2Sync.WallClockUnixNanoseconds();
                var clockId = _ptp?.ClockId ?? 0;
                packet = Ap2Sync.BuildPtp(first, _latencyFrames, _timestamp, nowNs, clockId);
            }
            else
            {
                var framesSent = (uint)(PacketsSent * SamplesPerFrame);
                var ntp = _startNtp + ((ulong)framesSent << 32) / SampleRate;
                packet = Ap2Sync.BuildNtp(first, _latencyFrames, _timestamp, ntp);
            }

            _ = _controlSocket.Send(packet, packet.Length, Target.Host, DeviceControlPort);
        }
        catch (Exception ex) when (ex is SocketException or ObjectDisposedException)
        {
            // A dropped sync packet is not fatal: the next tick repeats the mapping.
        }
    }

    /// <summary>Current UTC time in 64-bit NTP format (seconds since 1900 + 2^32 fraction).</summary>
    private static ulong NtpNow()
    {
        const long ntpEpochTicks = 599_264_352_000_000_000L; // 1900-01-01T00:00:00Z
        var elapsedTicks = DateTime.UtcNow.Ticks - ntpEpochTicks;
        var microseconds = (ulong)(elapsedTicks / 10);
        var seconds = microseconds / 1_000_000UL;
        var fraction = microseconds % 1_000_000UL * 4_294_967_296UL / 1_000_000UL;
        return (seconds << 32) | fraction;
    }

    /// <summary>
    /// Sends the PTP <c>SETPEERS</c> RTSP request (plist array of peer addresses) so the receiver
    /// knows which endpoints belong to the gPTP domain. Best effort: some receivers ignore it.
    /// </summary>
    private void SendSetPeers(IReadOnlyList<string> peers)
    {
        try
        {
            var body = Bplist.Encode(peers.Cast<object?>().ToArray());
            var headers = CommonHeaders();
            headers.Add(new KeyValuePair<string, string>("Content-Type", Ap2Setup.ContentType));
            var response = _transport.Send("SETPEERS", _sessionUri, headers, body);
            _rtspHistory.Add(response);
            HostLog.Info($"[airplay] AP2 SETPEERS -> {response.StatusCode} {response.Reason}");
        }
        catch (Exception ex)
        {
            HostLog.Warn($"[airplay] AP2 SETPEERS failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    /// <summary>Sends <c>FLUSH</c> with the RTP mapping headers used by the reference sender.</summary>
    private void SendFlushWithRtpInfo()
    {
        try
        {
            var headers = CommonHeaders();
            headers.Add(new KeyValuePair<string, string>("Range", "npt=0-"));
            headers.Add(new KeyValuePair<string, string>(
                "RTP-Info",
                $"seq={_sequence};rtptime={_timestamp}"));
            var response = _transport.Send("FLUSH", _sessionUri, headers);
            _rtspHistory.Add(response);
            if (response.StatusCode != 200)
            {
                HostLog.Warn($"[airplay] AP2 FLUSH after RECORD returned {response.StatusCode} {response.Reason}");
            }
        }
        catch (Exception ex)
        {
            HostLog.Warn($"[airplay] AP2 FLUSH after RECORD failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    /// <summary>Encrypts and sends one audio payload; returns false when it was not accepted.</summary>
    public bool SendAudioFrame(ReadOnlySpan<byte> alacPayload)
    {
        if (_disposed || !_streaming || _audioSocket is null)
        {
            return false;
        }

        if (alacPayload.Length is 0 or > Ap2AudioPacket.MaxPayloadBytes)
        {
            LastError = $"invalid audio payload length {alacPayload.Length}";
            return false;
        }

        try
        {
            var packet = Ap2AudioPacket.Build(
                _sequence,
                _timestamp,
                Ssrc,
                _audioKey,
                alacPayload,
                firstPacket: PacketsSent == 0);
            _audioSocket.Send(packet, packet.Length);
            lock (_audioHistoryGate)
            {
                _audioHistory[_sequence & (ResendHistorySize - 1)] = packet;
            }

            _sequence++;
            _timestamp += SamplesPerFrame;
            PacketsSent++;
            if (PacketsSent % 500 == 0)
            {
                HostLog.Info(
                    $"[airplay] AP2 audio packets={PacketsSent} resendRequests={Volatile.Read(ref _resendRequests)} "
                    + $"resentPackets={Volatile.Read(ref _resentPackets)} missingResends={Volatile.Read(ref _missingResendPackets)}");
            }

            return true;
        }
        catch (Exception ex) when (ex is SocketException or IOException or ObjectDisposedException)
        {
            LastError = $"{ex.GetType().Name}: {ex.Message}";
            return false;
        }
    }

    /// <summary>Volume in percent (0..100); 0 is a hard mute (-144 dB), matching RAOP conventions.</summary>
    public void SetVolume(int percent)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        percent = Math.Clamp(percent, 0, 100);
        var decibels = percent == 0 ? -144.0 : Math.Max(-144.0, -30.0 * (100 - percent) / 100.0);
        var body = Encoding.UTF8.GetBytes(
            $"volume: {decibels.ToString("N6", CultureInfo.InvariantCulture)}\r\n");

        var headers = new List<KeyValuePair<string, string>>(3)
        {
            new("Content-Type", "text/parameters"),
            new("User-Agent", _options.UserAgent),
        };

        if (!string.IsNullOrEmpty(SessionId))
        {
            headers.Add(new KeyValuePair<string, string>("Session", SessionId!));
        }

        var response = _transport.Send("SET_PARAMETER", _sessionUri, headers, body);
        _rtspHistory.Add(response);
        if (response.StatusCode != 200)
        {
            throw new InvalidOperationException($"AirPlay 2 SET_PARAMETER (volume) was rejected: {response.Describe()}");
        }
    }

    /// <summary>FLUSH drops everything the receiver has buffered for this session.</summary>
    public void Flush()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var headers = CommonHeaders();
        if (!string.IsNullOrEmpty(SessionId))
        {
            headers.Add(new KeyValuePair<string, string>("Session", SessionId!));
        }

        headers.Add(new KeyValuePair<string, string>(
            "RTP-Info",
            $"seq={_sequence};rtptime={_timestamp}"));

        var response = _transport.Send("FLUSH", _sessionUri, headers);
        _rtspHistory.Add(response);
    }

    /// <summary>Best-effort TEARDOWN; never throws so it is safe from Dispose paths.</summary>
    public void Teardown()
    {
        if (_disposed)
        {
            return;
        }

        _streaming = false;
        if (_feedback is not null)
        {
            _feedback.Stop();
            _feedback.Dispose();
            _feedback = null;
        }

        if (string.IsNullOrEmpty(_sessionUri))
        {
            return;
        }

        try
        {
            var headers = CommonHeaders();
            if (!string.IsNullOrEmpty(SessionId))
            {
                headers.Add(new KeyValuePair<string, string>("Session", SessionId!));
            }

            var response = _transport.Send("TEARDOWN", _sessionUri, headers);
            LastTeardownStatus = response.StatusCode;
            _rtspHistory.Add(response);
        }
        catch (Exception ex)
        {
            LastError = $"{ex.GetType().Name}: {ex.Message}";
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        Teardown();
        _disposed = true;
        _syncTimer?.Dispose();
        _syncTimer = null;
        _feedback?.Dispose();
        _feedback = null;
        _ptp?.Dispose();
        _ptp = null;
        _audioSocket?.Dispose();
        _controlSocket?.Dispose();
        _timingSocket?.Dispose();
        _transport.Dispose();
    }

    /// <summary>
    /// Standard AP2 request headers (reference sender recipe): UA, DACP-ID, Active-Remote and
    /// Client-Instance are mandatory; SETUP additionally carries <c>X-Apple-StreamID: 1</c>.
    /// </summary>
    private List<KeyValuePair<string, string>> CommonHeaders(string? method = null)
    {
        var headers = new List<KeyValuePair<string, string>>(6)
        {
            new("User-Agent", _options.UserAgent),
            new("DACP-ID", _dacpId),
            new("Active-Remote", _activeRemote.ToString(CultureInfo.InvariantCulture)),
            new("Client-Instance", _dacpId),
            new("X-Apple-Client-Name", _options.Name),
        };

        if (string.Equals(method, "SETUP", StringComparison.OrdinalIgnoreCase))
        {
            headers.Add(new KeyValuePair<string, string>("X-Apple-StreamID", "1"));
        }

        return headers;
    }

    private static string ResolveLocalAddress(string host)
    {
        try
        {
            using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
            socket.Connect(host, 9);
            return ((IPEndPoint)socket.LocalEndPoint!).Address.ToString();
        }
        catch
        {
            return "127.0.0.1";
        }
    }

    private const int ResendHistorySize = 1024;

    private const int MaxResendRequestCount = 64;

    private readonly byte[]?[] _audioHistory = new byte[]?[ResendHistorySize];

    private readonly object _audioHistoryGate = new();

    private int _controlPackets;

    private int _timingPackets;

    private int _resendRequests;

    private int _resentPackets;

    private int _missingResendPackets;

    private void DrainUdp(UdpClient socket, bool isTiming)
    {
        IPEndPoint? remote = new IPEndPoint(IPAddress.Any, 0);
        while (!_disposed)
        {
            try
            {
                var data = socket.Receive(ref remote);
                if (isTiming)
                {
                    _ = Interlocked.Increment(ref _timingPackets);
                    RespondTimingRequest(socket, data, remote);
                }
                else
                {
                    _ = Interlocked.Increment(ref _controlPackets);
                    HandleControlPacket(socket, data, remote);
                }
            }
            catch (Exception ex) when (ex is ObjectDisposedException or SocketException)
            {
                return;
            }
        }
    }

    /// <summary>
    /// Handles a RAOP/AP2 audio retransmission request (type 0x55) by replaying the cached packets
    /// as <c>0x80 0xD6 seq</c> + original packet, which removes the short gaps audible on Wi-Fi loss.
    /// </summary>
    private void HandleControlPacket(UdpClient socket, byte[] data, IPEndPoint remote)
    {
        if (data.Length < 8 || (data[0] & 0xC0) != 0x80 || (data[1] & 0x7F) != 0x55)
        {
            return;
        }

        var firstSequence = BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(4));
        var count = BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(6));
        if (count == 0)
        {
            return;
        }

        count = (ushort)Math.Min((int)count, MaxResendRequestCount);
        _ = Interlocked.Increment(ref _resendRequests);
        for (var i = 0; i < count; i++)
        {
            var sequence = (ushort)(firstSequence + i);
            byte[]? cached;
            lock (_audioHistoryGate)
            {
                cached = _audioHistory[sequence & (ResendHistorySize - 1)];
            }

            if (cached is null)
            {
                _ = Interlocked.Increment(ref _missingResendPackets);
                continue;
            }

            var response = new byte[4 + cached.Length];
            response[0] = 0x80;
            response[1] = 0xD6;
            BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(2), sequence);
            cached.CopyTo(response, 4);
            try
            {
                _ = socket.Send(response, response.Length, remote);
                _ = Interlocked.Increment(ref _resentPackets);
            }
            catch (Exception ex) when (ex is SocketException or ObjectDisposedException)
            {
                return;
            }
        }
    }

    /// <summary>
    /// Answers a RAOP timing request (type 0x52) with the reference sender's 0xD3 response so the
    /// receiver can correlate its clock with our timestamps even before PTP has settled.
    /// </summary>
    private void RespondTimingRequest(UdpClient socket, byte[] request, IPEndPoint remote)
    {
        if (request.Length < 32 || (request[1] & 0x7F) != 0x52)
        {
            return;
        }

        var now = _options.TimingProtocolPtp
            ? Ap2Sync.UnixNanosecondsToNtp(_ptp?.NowNs ?? Ap2Sync.WallClockUnixNanoseconds())
            : NtpNow();
        var response = new byte[32];
        response[0] = request[0];
        response[1] = 0xD3;
        BinaryPrimitives.WriteUInt16BigEndian(response.AsSpan(2), 0x0007);
        request.AsSpan(24, 8).CopyTo(response.AsSpan(8)); // reftime = request send time
        BinaryPrimitives.WriteUInt32BigEndian(response.AsSpan(16), (uint)(now >> 32)); // recv time
        BinaryPrimitives.WriteUInt32BigEndian(response.AsSpan(20), (uint)now);
        BinaryPrimitives.WriteUInt32BigEndian(response.AsSpan(24), (uint)(now >> 32)); // send time
        BinaryPrimitives.WriteUInt32BigEndian(response.AsSpan(28), (uint)now);
        try
        {
            _ = socket.Send(response, response.Length, remote);
        }
        catch (Exception ex) when (ex is SocketException or ObjectDisposedException)
        {
            // Receiver went away; the drain loop will exit on the next socket error.
        }
    }
}
