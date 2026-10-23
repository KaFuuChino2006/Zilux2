using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using Zilux2.AirPlay.Ap2;

namespace Zilux2.DevTest.AirPlay;

/// <summary>One RTSP/HTTP request captured by <see cref="AirPlay2MockDevice"/>.</summary>
internal sealed class Ap2MockRequest
{
    public required string Method { get; init; }

    public required string Path { get; init; }

    public required string Uri { get; init; }

    public IReadOnlyDictionary<string, string> Headers { get; init; } = new Dictionary<string, string>();

    public byte[] Body { get; init; } = [];

    /// <summary>Status written back by the mock.</summary>
    public int ResponseStatus { get; set; }

    /// <summary>True when this request arrived over the HAP encrypted channel.</summary>
    public bool Encrypted { get; init; }

    public string? Header(string name) => Headers.TryGetValue(name, out var value) ? value : null;
}

/// <summary>Observations collected by <see cref="AirPlay2MockDevice"/>.</summary>
internal sealed class AirPlay2MockStats
{
    public object Gate { get; } = new();

    public List<Ap2MockRequest> RtspRequests { get; } = [];

    public List<string> Errors { get; } = [];

    public int PairSetupM1 { get; set; }

    public int PairSetupM3 { get; set; }

    public int PairSetupRequests => PairSetupM1 + PairSetupM3;

    public int EncryptedRequests { get; set; }

    public bool EncryptionStarted { get; set; }

    public int FeedbackRequests { get; set; }

    public bool SetupReceived { get; set; }

    public string? SetupContentType { get; set; }

    public int SetupStreamCount { get; set; }

    public int SetupStreamType { get; set; }

    public int SetupCompressionType { get; set; }

    public int SetupFramesPerPacket { get; set; }

    public int SetupSampleRate { get; set; }

    public int SetupLatencyMin { get; set; }

    public int SetupLatencyMax { get; set; }

    public string? SetupTimingProtocol { get; set; }

    public int SetupAudioKeyLength { get; set; }

    public int SetupControlPort { get; set; }

    public int SetupTimingPort { get; set; }

    public string SetupPlistHex { get; set; } = string.Empty;

    /// <summary>Set when the stream-less (connection level) SETUP was observed.</summary>
    public bool SessionSetupReceived { get; set; }

    public string? SessionSetupTimingProtocol { get; set; }

    public int SessionSetupTimingPort { get; set; }

    public string? SessionSetupSessionUuid { get; set; }

    public string? SessionSetupDeviceId { get; set; }

    public string? SessionSetupName { get; set; }

    /// <summary>Set when the connection level SETUP carries a <c>timingPeerInfo</c> dictionary (PTP).</summary>
    public bool SessionSetupHasTimingPeerInfo { get; set; }

    public int SessionSetupStreamCount { get; set; }

    /// <summary>Set when the stream-bearing (play session) SETUP was observed.</summary>
    public bool StreamSetupReceived { get; set; }

    public int StreamSetupControlPort { get; set; }

    public int RecordBodyLength { get; set; }

    public bool RecordHasRtpInfo { get; set; }

    public bool RecordReceived { get; set; }

    public bool FlushReceived { get; set; }

    public string? VolumeBody { get; set; }

    public int AudioPackets { get; set; }

    public int FirstSequence { get; set; } = -1;

    public int LastSequence { get; set; } = -1;

    public int SequenceGaps { get; set; }

    public List<uint> Timestamps { get; } = [];

    public long AudioPayloadBytes { get; set; }

    public int DecryptFailures { get; set; }

    public bool TeardownReceived { get; set; }

    public bool TeardownClosed { get; set; }

    public bool RtspDisconnected { get; set; }

    public int UnknownRequests { get; set; }

    public int SetPeersRequests { get; set; }

    public bool FlushWithRtpInfoReceived { get; set; }

    /// <summary>Retransmission requests (type 0x55) the mock sent to the sender.</summary>
    public int ResendRequestsSent { get; set; }

    /// <summary>Retransmission responses (0x80 0xD6 ...) received from the sender.</summary>
    public int ResendResponses { get; set; }

    /// <summary>Sequence numbers carried by the retransmission responses, in arrival order.</summary>
    public List<ushort> ResentSequences { get; } = [];

    public Ap2MockRequest? Find(string method, string? path = null)
    {
        lock (Gate)
        {
            return RtspRequests.LastOrDefault(request =>
                string.Equals(request.Method, method, StringComparison.OrdinalIgnoreCase)
                && (path is null || string.Equals(request.Path, path, StringComparison.OrdinalIgnoreCase)));
        }
    }
}

/// <summary>
/// In-process AirPlay 2 receiver used by <c>AirPlay2LoopbackTest</c>. It speaks the transient
/// pairing subset (TLV8 <c>/pair-setup</c> M1–M4), then expects the very same TCP connection to
/// switch to HAP framing, parses binary-plist SETUP, decrypts AP2 audio packets and answers
/// <c>/feedback</c> — enough to validate the sender stack without real HomePod hardware.
/// </summary>
internal sealed class AirPlay2MockDevice : IDisposable
{
    private readonly TcpListener _listener;
    private readonly UdpClient _audioReceive;
    private readonly UdpClient _controlReceive;
    private readonly Thread _acceptThread;
    private readonly Thread _audioThread;
    private readonly Thread _controlThread;
    private readonly AirPlay2MockStats _stats = new();
    private readonly MemoryStream _plainBuffer = new(8192);
    private readonly byte[] _clientWriteKey;
    private readonly byte[] _clientReadKey;
    private readonly object _writeGate = new();
    private TcpClient? _client;
    private NetworkStream? _stream;
    private TestFrameCryptor? _inboundCryptor;
    private TestFrameCryptor? _outboundCryptor;
    private byte[]? _audioKey;
    private bool _pairingComplete;
    private bool _encrypted;
    private bool _disposed;
    private bool _closing;
    private int _scanFrom;

    private AirPlay2MockDevice(byte[] clientWriteKey, byte[] clientReadKey)
    {
        if (clientWriteKey.Length != 32 || clientReadKey.Length != 32)
        {
            throw new ArgumentException("Mock HAP keys must be 32 bytes each.");
        }

        _clientWriteKey = clientWriteKey.ToArray();
        _clientReadKey = clientReadKey.ToArray();
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        RtspPort = ((IPEndPoint)_listener.LocalEndpoint).Port;

        _audioReceive = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        AudioPort = ((IPEndPoint)_audioReceive.Client.LocalEndPoint!).Port;
        _controlReceive = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        ControlPort = ((IPEndPoint)_controlReceive.Client.LocalEndPoint!).Port;

        _acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "ap2-mock-rtsp" };
        _audioThread = new Thread(AudioLoop) { IsBackground = true, Name = "ap2-mock-audio" };
        _controlThread = new Thread(ControlLoop) { IsBackground = true, Name = "ap2-mock-control" };
        _acceptThread.Start();
        _audioThread.Start();
        _controlThread.Start();
    }

    public static AirPlay2MockDevice Start(byte[] clientWriteKey, byte[] clientReadKey) =>
        new(clientWriteKey, clientReadKey);

    /// <summary>TCP port that speaks RTSP/HTTP (stands in for the receiver's port 7000).</summary>
    public int RtspPort { get; }

    /// <summary>UDP port that receives AP2 audio packets.</summary>
    public int AudioPort { get; }

    /// <summary>UDP port that receives the sender's control packets.</summary>
    public int ControlPort { get; }

    public AirPlay2MockStats Stats()
    {
        lock (_stats.Gate)
        {
            return _stats;
        }
    }

    public bool ClientConnected => _client is { Connected: true };

    /// <summary>Sends an AP2 retransmission request (type 0x55) to the sender's control port.</summary>
    public bool RequestResend(ushort firstSequence, ushort count)
    {
        var target = Stats().StreamSetupControlPort;
        if (target <= 0 || count == 0)
        {
            return false;
        }

        var request = new byte[8];
        request[0] = 0x80;
        request[1] = 0x55;
        BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(4), firstSequence);
        BinaryPrimitives.WriteUInt16BigEndian(request.AsSpan(6), count);
        try
        {
            _controlReceive.Send(request, request.Length, new IPEndPoint(IPAddress.Loopback, target));
        }
        catch (Exception ex) when (ex is SocketException or ObjectDisposedException)
        {
            AddError($"resend request: {ex.GetType().Name}: {ex.Message}");
            return false;
        }

        lock (_stats.Gate)
        {
            _stats.ResendRequestsSent++;
        }

        return true;
    }

    private void ControlLoop()
    {
        IPEndPoint remote = new(IPAddress.Any, 0);
        while (!_disposed)
        {
            byte[] packet;
            try
            {
                packet = _controlReceive.Receive(ref remote);
            }
            catch (Exception ex) when (ex is ObjectDisposedException or SocketException)
            {
                return;
            }

            if (packet.Length < 4 || packet[0] != 0x80 || packet[1] != 0xD6)
            {
                continue;
            }

            var sequence = BinaryPrimitives.ReadUInt16BigEndian(packet.AsSpan(2));
            lock (_stats.Gate)
            {
                _stats.ResendResponses++;
                _stats.ResentSequences.Add(sequence);
            }
        }
    }

    private void AcceptLoop()
    {
        try
        {
            var client = _listener.AcceptTcpClient();
            client.NoDelay = true;
            lock (_stats.Gate)
            {
                _client = client;
                _stream = client.GetStream();
            }

            ClientLoop(client.GetStream());
        }
        catch (Exception ex) when (ex is SocketException or ObjectDisposedException or IOException)
        {
            AddError($"accept: {ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            lock (_stats.Gate)
            {
                _stats.RtspDisconnected = true;
            }
        }
    }

    private void ClientLoop(NetworkStream stream)
    {
        var buffer = new byte[8192];
        while (!_disposed && !_closing)
        {
            int read;
            try
            {
                read = stream.Read(buffer, 0, buffer.Length);
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException or SocketException)
            {
                break;
            }

            if (read <= 0)
            {
                break;
            }

            ReadOnlySpan<byte> incoming = buffer.AsSpan(0, read);
            if (_pairingComplete && !_encrypted)
            {
                _encrypted = true;
                _inboundCryptor = new TestFrameCryptor(_clientWriteKey);
                _outboundCryptor = new TestFrameCryptor(_clientReadKey);
                lock (_stats.Gate)
                {
                    _stats.EncryptionStarted = true;
                }
            }

            if (_encrypted)
            {
                byte[] plaintext;
                try
                {
                    plaintext = _inboundCryptor!.Decrypt(incoming);
                }
                catch (Exception ex)
                {
                    AddError($"decrypt: {ex.GetType().Name}: {ex.Message}");
                    break;
                }

                if (plaintext.Length > 0)
                {
                    _plainBuffer.Seek(0, SeekOrigin.End);
                    _plainBuffer.Write(plaintext, 0, plaintext.Length);
                }
            }
            else
            {
                _plainBuffer.Seek(0, SeekOrigin.End);
                _plainBuffer.Write(incoming);
            }

            PumpRequests();
        }
    }

    private void PumpRequests()
    {
        while (TryTakeRequest(out var request))
        {
            Dispatch(request);
            if (_closing)
            {
                break;
            }
        }
    }

    private bool TryTakeRequest(out Ap2MockRequest request)
    {
        request = null!;
        var buffer = _plainBuffer.GetBuffer();
        var length = (int)_plainBuffer.Length;
        var headerEnd = -1;
        for (var i = Math.Max(0, _scanFrom); i + 3 < length; i++)
        {
            if (buffer[i] == '\r' && buffer[i + 1] == '\n' && buffer[i + 2] == '\r' && buffer[i + 3] == '\n')
            {
                headerEnd = i;
                break;
            }
        }

        if (headerEnd < 0)
        {
            _scanFrom = Math.Max(0, length - 3);
            return false;
        }

        var headerText = Encoding.ASCII.GetString(buffer, 0, headerEnd);
        var lines = headerText.Split("\r\n", StringSplitOptions.None);
        var firstLine = lines.FirstOrDefault() ?? string.Empty;
        var parts = firstLine.Split(' ', 3, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2)
        {
            AddError($"malformed request line '{firstLine}'");
            _plainBuffer.SetLength(0);
            _plainBuffer.Position = 0;
            return false;
        }

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 1; i < lines.Length; i++)
        {
            var colon = lines[i].IndexOf(':');
            if (colon <= 0)
            {
                continue;
            }

            headers[lines[i][..colon].Trim()] = lines[i][(colon + 1)..].Trim();
        }

        var contentLength = 0;
        if (headers.TryGetValue("Content-Length", out var lengthText))
        {
            _ = int.TryParse(lengthText, out contentLength);
        }

        var bodyStart = headerEnd + 4;
        if (length < bodyStart + contentLength)
        {
            _scanFrom = Math.Max(0, headerEnd);
            return false;
        }

        var body = new byte[contentLength];
        if (contentLength > 0)
        {
            Buffer.BlockCopy(buffer, bodyStart, body, 0, contentLength);
        }

        var consumed = bodyStart + contentLength;
        var remaining = length - consumed;
        if (remaining > 0)
        {
            Buffer.BlockCopy(buffer, consumed, buffer, 0, remaining);
        }

        _plainBuffer.SetLength(remaining);
        _plainBuffer.Position = remaining;
        _scanFrom = 0;

        request = new Ap2MockRequest
        {
            Method = parts[0],
            Path = parts[1],
            Uri = parts[1],
            Headers = headers,
            Body = body,
            Encrypted = _encrypted,
        };
        if (_encrypted)
        {
            lock (_stats.Gate)
            {
                _stats.EncryptedRequests++;
            }
        }

        return true;
    }

    private void Dispatch(Ap2MockRequest request)
    {
        lock (_stats.Gate)
        {
            _stats.RtspRequests.Add(request);
        }

        switch (request.Method)
        {
            case "OPTIONS":
                Respond(request, 200, headers:
                [
                    new("Public", "ANNOUNCE, SETUP, RECORD, PAUSE, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER, POST, GET"),
                ]);
                break;

            case "POST" when request.Path.StartsWith("/pair-setup", StringComparison.Ordinal):
                HandlePairSetup(request);
                break;

            case "POST" when request.Path.StartsWith("/pair-verify", StringComparison.Ordinal):
                // Transient pairing has no verify phase; answer with an empty acknowledgement.
                Respond(request, 200);
                break;

            case "POST" when request.Path.StartsWith("/feedback", StringComparison.Ordinal):
                lock (_stats.Gate)
                {
                    _stats.FeedbackRequests++;
                }

                Respond(request, 200, Ap2Setup.ContentType, Bplist.Encode(new Dictionary<string, object?>
                {
                    ["streams"] = Array.Empty<object?>(),
                }));
                break;

            case "GET" when request.Path.StartsWith("/info", StringComparison.Ordinal):
                Respond(request, 200, Ap2Setup.ContentType, Bplist.Encode(new Dictionary<string, object?>
                {
                    ["deviceID"] = "AA:BB:CC:DD:EE:FF",
                    ["model"] = "AudioAccessory5,1",
                    ["name"] = "Mock HomePod",
                    ["srcvers"] = "980.77.2",
                }));
                break;

            case "SETUP":
                HandleSetup(request);
                break;

            case "SETPEERS":
                // PTP peer list (bplist array of addresses); the mock only records it.
                lock (_stats.Gate)
                {
                    _stats.SetPeersRequests++;
                }

                Respond(request, 200);
                break;

            case "RECORD":
                lock (_stats.Gate)
                {
                    _stats.RecordReceived = true;
                    _stats.RecordBodyLength = request.Body.Length;
                    _stats.RecordHasRtpInfo = request.Header("RTP-Info") is not null;
                }

                Respond(request, 200, headers: [new("Session", "1")]);
                break;

            case "SET_PARAMETER":
            {
                var bodyText = Encoding.UTF8.GetString(request.Body);
                lock (_stats.Gate)
                {
                    if (bodyText.Contains("volume:", StringComparison.Ordinal))
                    {
                        _stats.VolumeBody = bodyText;
                    }
                }

                Respond(request, 200);
                break;
            }

            case "FLUSH":
                lock (_stats.Gate)
                {
                    _stats.FlushReceived = true;
                    _stats.FlushWithRtpInfoReceived = request.Header("RTP-Info") is not null;
                }

                Respond(request, 200);
                break;

            case "TEARDOWN":
                lock (_stats.Gate)
                {
                    _stats.TeardownReceived = true;
                }

                Respond(request, 200);
                CloseClient();
                break;

            default:
                lock (_stats.Gate)
                {
                    _stats.UnknownRequests++;
                }

                Respond(request, 400);
                break;
        }
    }

    private void HandlePairSetup(Ap2MockRequest request)
    {
        var tlv = ParseTlv(request.Body);
        var state = tlv.TryGetValue(6, out var stateValue) && stateValue.Length > 0 ? stateValue[0] : (byte)0;
        if (state == 1)
        {
            lock (_stats.Gate)
            {
                _stats.PairSetupM1++;
            }

            var response = BuildTlv(
                (6, [2]),
                (2, PairingSalt),
                (3, PairingPublicKey));
            Respond(request, 200, "application/octet-stream", response);
            return;
        }

        if (state == 3)
        {
            lock (_stats.Gate)
            {
                _stats.PairSetupM3++;
            }

            Respond(request, 200, "application/octet-stream", BuildTlv((6, [4])));
            _pairingComplete = true;
            return;
        }

        AddError($"unexpected pair-setup state {state}");
        Respond(request, 400);
    }

    private void HandleSetup(Ap2MockRequest request)
    {
        const string contentType = Ap2Setup.ContentType;
        Dictionary<string, object?> root;
        try
        {
            root = Bplist.Decode(request.Body) as Dictionary<string, object?>
                ?? throw new InvalidDataException("SETUP body is not a plist dictionary.");
        }
        catch (Exception ex)
        {
            AddError($"SETUP parse: {ex.GetType().Name}: {ex.Message}");
            Respond(request, 400);
            return;
        }

        var streams = root.TryGetValue("streams", out var value) && value is object?[] array ? array : [];

        if (streams.Length == 0)
        {
            // Phase 1: connection level SETUP. No audio streams yet; the receiver only
            // negotiates the timing/event channel and reports its event port.
            lock (_stats.Gate)
            {
                _stats.SessionSetupReceived = true;
                _stats.SetupContentType = request.Header("Content-Type");
                _stats.SetupPlistHex = Convert.ToHexString(request.Body);
                _stats.SessionSetupTimingProtocol = root.TryGetValue("timingProtocol", out var timing) ? timing as string : null;
                _stats.SessionSetupTimingPort = Ap2Setup.ReadInt(root, "timingPort");
                _stats.SessionSetupSessionUuid = root.TryGetValue("sessionUUID", out var uuid) ? uuid as string : null;
                _stats.SessionSetupDeviceId = root.TryGetValue("deviceID", out var deviceId) ? deviceId as string : null;
                _stats.SessionSetupName = root.TryGetValue("name", out var name) ? name as string : null;
                _stats.SessionSetupHasTimingPeerInfo = root.ContainsKey("timingPeerInfo");
                _stats.SessionSetupStreamCount = 0;
            }

            var sessionResponse = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["skipRecord"] = false,
                ["eventPort"] = 0,
            };

            Respond(request, 200, contentType, Bplist.Encode(sessionResponse), headers: [new("Session", "1")]);
            return;
        }

        // Phase 2: play session SETUP that actually creates the audio stream.
        lock (_stats.Gate)
        {
            _stats.SetupReceived = true;
            _stats.StreamSetupReceived = true;
            _stats.SetupContentType = request.Header("Content-Type");
            _stats.SetupPlistHex = Convert.ToHexString(request.Body);
            _stats.SetupStreamCount = streams.Length;
            _stats.SetupTimingProtocol = root.TryGetValue("timingProtocol", out var timingProtocol) ? timingProtocol as string : null;
            _stats.SetupLatencyMin = Ap2Setup.ReadInt(root, "latencyMin");
            _stats.SetupLatencyMax = Ap2Setup.ReadInt(root, "latencyMax");
            _stats.SetupControlPort = Ap2Setup.ReadInt(root, "controlPort");
            _stats.SetupTimingPort = Ap2Setup.ReadInt(root, "timingPort");
        }

        if (streams[0] is Dictionary<string, object?> stream)
        {
            lock (_stats.Gate)
            {
                _stats.SetupStreamType = Ap2Setup.ReadInt(stream, "type");
                _stats.SetupCompressionType = Ap2Setup.ReadInt(stream, "ct");
                _stats.SetupFramesPerPacket = Ap2Setup.ReadInt(stream, "spf");
                _stats.SetupSampleRate = Ap2Setup.ReadInt(stream, "sr");
                _stats.SetupAudioKeyLength = stream.TryGetValue("shk", out var shk) && shk is byte[] bytes ? bytes.Length : 0;
                _stats.StreamSetupControlPort = Ap2Setup.ReadInt(stream, "controlPort");
                _stats.SetupLatencyMin = Ap2Setup.ReadInt(stream, "latencyMin");
                _stats.SetupLatencyMax = Ap2Setup.ReadInt(stream, "latencyMax");
            }

            if (stream.TryGetValue("shk", out var keyValue) && keyValue is byte[] { Length: 32 } key)
            {
                _audioKey = key;
            }
        }

        var response = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["streams"] = new object?[]
            {
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["type"] = 96,
                    ["streamID"] = 1,
                    ["dataPort"] = AudioPort,
                    ["controlPort"] = ControlPort,
                },
            },
            ["servicePort"] = RtspPort,
        };

        Respond(
            request,
            200,
            contentType,
            Bplist.Encode(response),
            headers: [new("Session", "1")]);
    }

    private void Respond(
        Ap2MockRequest request,
        int status,
        string contentType = "",
        byte[]? body = null,
        List<KeyValuePair<string, string>>? headers = null)
    {
        var payload = body ?? [];
        var header = new StringBuilder(256);
        header.Append("RTSP/1.0 ").Append(status).Append(' ').Append(ReasonPhrase(status)).Append("\r\n");
        var cseq = request.Header("CSeq");
        if (!string.IsNullOrEmpty(cseq))
        {
            header.Append("CSeq: ").Append(cseq).Append("\r\n");
        }

        header.Append("Server: AirTunes/980.77.2\r\n");
        foreach (var (key, value) in headers ?? [])
        {
            header.Append(key).Append(": ").Append(value).Append("\r\n");
        }

        if (payload.Length > 0 && !string.IsNullOrEmpty(contentType))
        {
            header.Append("Content-Type: ").Append(contentType).Append("\r\n");
            header.Append("Content-Length: ").Append(payload.Length).Append("\r\n");
        }

        header.Append("\r\n");
        var headBytes = Encoding.ASCII.GetBytes(header.ToString());
        var message = new byte[headBytes.Length + payload.Length];
        Buffer.BlockCopy(headBytes, 0, message, 0, headBytes.Length);
        if (payload.Length > 0)
        {
            Buffer.BlockCopy(payload, 0, message, headBytes.Length, payload.Length);
        }

        request.ResponseStatus = status;
        var stream = _stream;
        if (stream is null)
        {
            return;
        }

        try
        {
            lock (_writeGate)
            {
                var frame = _encrypted ? _outboundCryptor!.Encrypt(message) : message;
                stream.Write(frame, 0, frame.Length);
                stream.Flush();
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or SocketException)
        {
            AddError($"write: {ex.GetType().Name}: {ex.Message}");
        }
    }

    private void CloseClient()
    {
        _closing = true;
        var stream = _stream;
        var client = _client;
        lock (_writeGate)
        {
            try
            {
                stream?.Flush();
            }
            catch
            {
                // ignore
            }

            try
            {
                client?.Client.Shutdown(SocketShutdown.Send);
            }
            catch
            {
                // ignore
            }

            lock (_stats.Gate)
            {
                _stats.TeardownClosed = true;
            }
        }
    }

    private void AudioLoop()
    {
        var remote = new IPEndPoint(IPAddress.Any, 0);
        var payload = new byte[2048];
        while (!_disposed)
        {
            byte[] packet;
            try
            {
                packet = _audioReceive.Receive(ref remote);
            }
            catch (Exception ex) when (ex is ObjectDisposedException or SocketException)
            {
                return;
            }

            var audioKey = _audioKey;
            if (audioKey is null)
            {
                lock (_stats.Gate)
                {
                    _stats.DecryptFailures++;
                }

                continue;
            }

            if (!Ap2AudioPacket.TryDecrypt(packet, audioKey, payload, out var sequence, out var timestamp, out _, out var payloadLength))
            {
                lock (_stats.Gate)
                {
                    _stats.DecryptFailures++;
                }

                continue;
            }

            lock (_stats.Gate)
            {
                if (_stats.AudioPackets == 0)
                {
                    _stats.FirstSequence = sequence;
                }
                else if ((ushort)(sequence - (ushort)_stats.LastSequence) != 1)
                {
                    _stats.SequenceGaps++;
                }

                _stats.AudioPackets++;
                _stats.LastSequence = sequence;
                _stats.AudioPayloadBytes += payloadLength;
                _stats.Timestamps.Add(timestamp);
            }
        }
    }

    private static byte[] PairingSalt { get; } =
    [
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
        0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xF0, 0x0F,
    ];

    private static byte[] PairingPublicKey { get; } = CreateDeterministicPublicKey();

    private static byte[] CreateDeterministicPublicKey()
    {
        var key = new byte[384];
        for (var i = 0; i < key.Length; i++)
        {
            key[i] = (byte)((i * 37 + 11) % 251);
        }

        return key;
    }

    private static byte[] BuildTlv(params (byte Type, byte[] Value)[] items)
    {
        using var output = new MemoryStream();
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

    private static Dictionary<byte, byte[]> ParseTlv(ReadOnlySpan<byte> data)
    {
        var result = new Dictionary<byte, byte[]>();
        var position = 0;
        while (position + 2 <= data.Length)
        {
            var type = data[position];
            var length = data[position + 1];
            var headerSize = 2;
            if (length == 0xFF)
            {
                if (position + 4 > data.Length)
                {
                    break;
                }

                length = (byte)((data[position + 2] << 8) | data[position + 3]);
                headerSize = 4;
            }

            if (position + headerSize + length > data.Length)
            {
                break;
            }

            result[type] = data.Slice(position + headerSize, length).ToArray();
            position += headerSize + length;
        }

        return result;
    }

    private static string ReasonPhrase(int status) => status switch
    {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Status",
    };

    private void AddError(string message)
    {
        lock (_stats.Gate)
        {
            _stats.Errors.Add(message);
        }
    }

    public void Stop()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        if (_stream is not null)
        {
            try
            {
                _stream.Close();
            }
            catch
            {
                // ignore
            }
        }

        try
        {
            _client?.Close();
        }
        catch
        {
            // ignore
        }

        try
        {
            _listener.Stop();
        }
        catch
        {
            // ignore
        }

        _audioReceive.Dispose();
        _controlReceive.Dispose();
    }

    public void Dispose() => Stop();
}
