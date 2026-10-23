using System.Buffers.Binary;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Zilux2.DevTest.AirPlay;

/// <summary>One RTSP request captured by <see cref="AirPlayMockDevice"/> plus the status we answered with.</summary>
internal sealed class MockRtspRequest
{
    public required string Method { get; init; }

    public required string Uri { get; init; }

    public required IReadOnlyDictionary<string, string> Headers { get; init; }

    public required string Body { get; init; }

    public required int ResponseStatus { get; init; }

    public string? Header(string name) => Headers.TryGetValue(name, out var value) ? value : null;

    public override string ToString() => $"{Method} {Uri} -> {ResponseStatus}";
}

/// <summary>Immutable snapshot of everything the mock receiver observed during one loopback run.</summary>
internal sealed class AirPlayMockStats
{
    public required IReadOnlyList<MockRtspRequest> RtspRequests { get; init; }

    public required IReadOnlyList<string> Errors { get; init; }

    public required int AudioPackets { get; init; }

    /// <summary>First audio sequence number seen, or -1 when no audio arrived.</summary>
    public required int FirstSequence { get; init; }

    public required int LastSequence { get; init; }

    /// <summary>Number of audio packets whose sequence did not follow the previous one.</summary>
    public required int SequenceGaps { get; init; }

    public required IReadOnlyList<uint> Timestamps { get; init; }

    public required long AudioPayloadBytes { get; init; }

    public required int SyncPackets { get; init; }

    public required uint LastSyncRtpTime { get; init; }

    public required uint LastSyncRtpNext { get; init; }

    public required int TimingRequestsSent { get; init; }

    public required int TimingResponses { get; init; }

    public required bool TimingEchoMatches { get; init; }

    public required int ResendRequestsSent { get; init; }

    public required int ResendRequestsReceived { get; init; }

    public required int ResendResponses { get; init; }

    public required int UnknownPackets { get; init; }

    public required bool TeardownReceived { get; init; }

    /// <summary>True when the mock closed the RTSP connection after answering TEARDOWN.</summary>
    public required bool TeardownClosed { get; init; }

    /// <summary>True when the sender closed the RTSP connection before TEARDOWN.</summary>
    public required bool RtspDisconnected { get; init; }

    public MockRtspRequest? Find(string method)
    {
        foreach (var request in RtspRequests)
        {
            if (string.Equals(request.Method, method, StringComparison.Ordinal))
            {
                return request;
            }
        }

        return null;
    }
}

/// <summary>
/// A hand written classic-RAOP (AirPlay 1) receiver used by <see cref="AirPlayLoopbackTest"/>.
/// It is pure BCL: a TCP listener speaking the RTSP handshake, one UDP socket per advertised
/// port, and just enough packet parsing to prove that the sender honours the wire format.
/// Nothing here talks to an Apple device; the sender always believes it is talking to 127.0.0.1.
/// </summary>
internal sealed class AirPlayMockDevice : IDisposable
{
    private const int MaxHeaderBytes = 64 * 1024;
    private const int MaxErrors = 32;
    private const byte PayloadTimingRequest = 82;
    private const byte PayloadTimingResponse = 83;
    private const byte PayloadSync = 84;
    private const byte PayloadResendRequest = 85;
    private const byte PayloadResendResponse = 86;
    private const byte PayloadAudio = 96;
    private const uint TimingProbeSeconds = 0x1234_5678;
    private const uint TimingProbeFraction = 0x9ABC_DEF0;

    private readonly TcpListener _listener;
    private readonly UdpClient _audioSocket;
    private readonly UdpClient _controlSocket;
    private readonly UdpClient _timingSocket;
    private readonly CancellationTokenSource _cts = new();
    private readonly object _gate = new();
    private readonly List<MockRtspRequest> _requests = [];
    private readonly List<string> _errors = [];
    private readonly List<uint> _timestamps = [];

    private Task _acceptTask = Task.CompletedTask;
    private Task _audioTask = Task.CompletedTask;
    private Task _controlTask = Task.CompletedTask;
    private Task _timingTask = Task.CompletedTask;

    private TcpClient? _client;
    private IPEndPoint? _sender;
    private int _senderControlPort;
    private int _senderTimingPort;
    private int _scanFrom;

    private int _audioPackets;
    private int _firstSequence = -1;
    private int _lastSequence = -1;
    private int _sequenceGaps;
    private long _audioPayloadBytes;
    private int _syncPackets;
    private uint _lastSyncRtpTime;
    private uint _lastSyncRtpNext;
    private int _timingRequestsSent;
    private int _timingResponses;
    private bool _timingEchoMatches = true;
    private ushort _timingSequence;
    private int _resendRequestsSent;
    private int _resendRequestsReceived;
    private int _resendResponses;
    private int _unknownPackets;
    private bool _teardownReceived;
    private bool _teardownClosed;
    private bool _rtspDisconnected;
    private bool _stopped;

    private AirPlayMockDevice(TcpListener listener, UdpClient audioSocket, UdpClient controlSocket, UdpClient timingSocket)
    {
        _listener = listener;
        _audioSocket = audioSocket;
        _controlSocket = controlSocket;
        _timingSocket = timingSocket;

        RtspPort = ((IPEndPoint)listener.LocalEndpoint).Port;
        AudioPort = LocalPort(audioSocket);
        ControlPort = LocalPort(controlSocket);
        TimingPort = LocalPort(timingSocket);
    }

    /// <summary>RTSP/TCP control port (what the sender connects to).</summary>
    public int RtspPort { get; }

    /// <summary>UDP port the sender must send RTP audio to (SETUP <c>server_port</c>).</summary>
    public int AudioPort { get; }

    /// <summary>UDP port for sync / timing / resend traffic (SETUP <c>control_port</c>).</summary>
    public int ControlPort { get; }

    /// <summary>UDP port a real device would use for timing requests (SETUP <c>timing_port</c>).</summary>
    public int TimingPort { get; }

    public static AirPlayMockDevice Start()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        UdpClient? audio = null;
        UdpClient? control = null;
        UdpClient? timing = null;
        try
        {
            listener.Start();
            audio = CreateUdpSocket();
            control = CreateUdpSocket();
            timing = CreateUdpSocket();
            var device = new AirPlayMockDevice(listener, audio, control, timing);
            device.Launch();
            return device;
        }
        catch
        {
            listener.Stop();
            audio?.Dispose();
            control?.Dispose();
            timing?.Dispose();
            throw;
        }
    }

    private void Launch()
    {
        _acceptTask = Task.Run(AcceptLoopAsync);
        _audioTask = Task.Run(() => ReceiveLoopAsync(_audioSocket, isAudioPort: true));
        _controlTask = Task.Run(() => ReceiveLoopAsync(_controlSocket, isAudioPort: false));
        _timingTask = Task.Run(() => ReceiveLoopAsync(_timingSocket, isAudioPort: false));
        HostLog.Info($"[airplay-mock] started rtsp={RtspPort} audio={AudioPort} control={ControlPort} timing={TimingPort}");
    }

    /// <summary>Sends an RTSP-style timing request (PT=82) to the sender's timing port.</summary>
    public bool RequestTiming()
    {
        IPEndPoint? target;
        ushort sequence;
        lock (_gate)
        {
            if (_stopped || _sender == null || _senderTimingPort == 0)
            {
                return false;
            }

            target = new IPEndPoint(_sender.Address, _senderTimingPort);
            _timingSequence = unchecked((ushort)(_timingSequence + 1));
            sequence = _timingSequence;
        }

        var packet = new byte[32];
        packet[0] = 0x80; // RTP version 2
        packet[1] = PayloadTimingRequest;
        BinaryPrimitives.WriteUInt16BigEndian(packet.AsSpan(2, 2), sequence);
        // bytes 4..7 stay zero (reserved), origin transmit time goes last like TuneBlade writes it
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(24, 4), TimingProbeSeconds);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(28, 4), TimingProbeFraction);

        try
        {
            _timingSocket.Send(packet, packet.Length, target);
            lock (_gate)
            {
                _timingRequestsSent++;
            }

            return true;
        }
        catch (SocketException ex)
        {
            RecordError($"timing probe: {ex.Message}");
            return false;
        }
        catch (ObjectDisposedException)
        {
            return false;
        }
    }

    /// <summary>Sends a resend request (PT=85) to the sender's control port.</summary>
    public bool RequestResend(ushort firstSequence, ushort count)
    {
        IPEndPoint? target;
        lock (_gate)
        {
            if (_stopped || _sender == null || _senderControlPort == 0)
            {
                return false;
            }

            target = new IPEndPoint(_sender.Address, _senderControlPort);
        }

        var packet = new byte[8];
        packet[0] = 0x80;
        packet[1] = PayloadResendRequest;
        BinaryPrimitives.WriteUInt16BigEndian(packet.AsSpan(4, 2), firstSequence);
        BinaryPrimitives.WriteUInt16BigEndian(packet.AsSpan(6, 2), count);

        try
        {
            _controlSocket.Send(packet, packet.Length, target);
            lock (_gate)
            {
                _resendRequestsSent++;
            }

            return true;
        }
        catch (SocketException ex)
        {
            RecordError($"resend probe: {ex.Message}");
            return false;
        }
        catch (ObjectDisposedException)
        {
            return false;
        }
    }

    public AirPlayMockStats Stats()
    {
        lock (_gate)
        {
            return new AirPlayMockStats
            {
                RtspRequests = _requests.ToArray(),
                Errors = _errors.ToArray(),
                AudioPackets = _audioPackets,
                FirstSequence = _firstSequence,
                LastSequence = _lastSequence,
                SequenceGaps = _sequenceGaps,
                Timestamps = _timestamps.ToArray(),
                AudioPayloadBytes = _audioPayloadBytes,
                SyncPackets = _syncPackets,
                LastSyncRtpTime = _lastSyncRtpTime,
                LastSyncRtpNext = _lastSyncRtpNext,
                TimingRequestsSent = _timingRequestsSent,
                TimingResponses = _timingResponses,
                TimingEchoMatches = _timingEchoMatches,
                ResendRequestsSent = _resendRequestsSent,
                ResendRequestsReceived = _resendRequestsReceived,
                ResendResponses = _resendResponses,
                UnknownPackets = _unknownPackets,
                TeardownReceived = _teardownReceived,
                TeardownClosed = _teardownClosed,
                RtspDisconnected = _rtspDisconnected,
            };
        }
    }

    public void Stop()
    {
        lock (_gate)
        {
            if (_stopped)
            {
                return;
            }

            _stopped = true;
        }

        try
        {
            _cts.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // already cancelled
        }

        try
        {
            _listener.Stop();
        }
        catch (SocketException)
        {
            // already stopped
        }

        try
        {
            _client?.Dispose();
        }
        catch (SocketException)
        {
            // ignore
        }

        try
        {
            _audioSocket.Dispose();
        }
        catch (SocketException)
        {
            // ignore
        }

        try
        {
            _controlSocket.Dispose();
        }
        catch (SocketException)
        {
            // ignore
        }

        try
        {
            _timingSocket.Dispose();
        }
        catch (SocketException)
        {
            // ignore
        }

        try
        {
            Task.WaitAll(new[] { _acceptTask, _audioTask, _controlTask, _timingTask }, TimeSpan.FromSeconds(3));
        }
        catch
        {
            // shutdown must never throw
        }

        _cts.Dispose();
        HostLog.Info("[airplay-mock] stopped");
    }

    public void Dispose() => Stop();

    // ---- RTSP/TCP side --------------------------------------------------

    private async Task AcceptLoopAsync()
    {
        var token = _cts.Token;
        while (!token.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync(token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            catch (SocketException ex)
            {
                if (!token.IsCancellationRequested)
                {
                    RecordError($"rtsp accept: {ex.Message}");
                }

                return;
            }

            client.NoDelay = true;
            lock (_gate)
            {
                _client = client;
                _sender = client.Client.RemoteEndPoint as IPEndPoint;
            }

            await HandleClientAsync(client).ConfigureAwait(false);
        }
    }

    private async Task HandleClientAsync(TcpClient client)
    {
        var token = _cts.Token;
        var stream = client.GetStream();
        var pending = new MemoryStream(8192);
        var buffer = new byte[4096];
        try
        {
            while (!token.IsCancellationRequested)
            {
                var headerEnd = FindHeaderEnd(pending);
                while (headerEnd < 0)
                {
                    var read = await stream.ReadAsync(buffer.AsMemory(), token).ConfigureAwait(false);
                    if (read <= 0)
                    {
                        MarkDisconnected();
                        return;
                    }

                    pending.Write(buffer, 0, read);
                    if (pending.Length > MaxHeaderBytes)
                    {
                        RecordError("rtsp: request header exceeded the size limit");
                        return;
                    }

                    headerEnd = FindHeaderEnd(pending);
                }

                var headerText = Encoding.UTF8.GetString(pending.GetBuffer(), 0, headerEnd);
                var parsed = ParseRequestHead(headerText);
                if (parsed.Method.Length == 0)
                {
                    RecordError("rtsp: malformed request line");
                    return;
                }

                var contentLength = ReadContentLength(parsed.Headers);
                if (contentLength > MaxHeaderBytes)
                {
                    RecordError($"rtsp: body of {contentLength} bytes is too large");
                    return;
                }

                var bodyStart = headerEnd + 4;
                while (pending.Length < bodyStart + contentLength)
                {
                    var read = await stream.ReadAsync(buffer.AsMemory(), token).ConfigureAwait(false);
                    if (read <= 0)
                    {
                        MarkDisconnected();
                        return;
                    }

                    pending.Write(buffer, 0, read);
                }

                var body = contentLength > 0
                    ? Encoding.UTF8.GetString(pending.GetBuffer(), bodyStart, contentLength)
                    : string.Empty;
                TrimPending(pending, bodyStart + contentLength);

                var (status, reason, extraHeaders) = Evaluate(parsed.Method, parsed.Headers);
                var cseq = parsed.Headers.TryGetValue("CSeq", out var cseqValue) ? cseqValue : "0";
                var response = new StringBuilder(256);
                response.Append("RTSP/1.0 ").Append(status).Append(' ').Append(reason).Append("\r\n");
                response.Append("CSeq: ").Append(cseq).Append("\r\n");
                foreach (var (name, value) in extraHeaders)
                {
                    response.Append(name).Append(": ").Append(value).Append("\r\n");
                }

                response.Append("Server: AirTunes/130.14\r\n");
                response.Append("\r\n");
                // Record before answering: the sender resumes as soon as the response lands, and the
                // test snapshots the mock state right after a blocking call returns.
                RecordRequest(parsed.Method, parsed.Uri, parsed.Headers, body, status);
                await stream.WriteAsync(Encoding.ASCII.GetBytes(response.ToString()), token).ConfigureAwait(false);
                await stream.FlushAsync(token).ConfigureAwait(false);

                if (parsed.Method == "TEARDOWN")
                {
                    CloseAfterTeardown();
                    return;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // normal shutdown
        }
        catch (ObjectDisposedException)
        {
            // socket closed by Stop()
        }
        catch (IOException ex)
        {
            if (!token.IsCancellationRequested)
            {
                RecordError($"rtsp io: {ex.Message}");
            }
        }
        catch (Exception ex)
        {
            RecordError($"rtsp: {ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            pending.Dispose();
        }
    }

    private (string Method, string Uri, Dictionary<string, string> Headers) ParseRequestHead(string head)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var lines = head.Split("\r\n", StringSplitOptions.None);
        if (lines.Length == 0)
        {
            return (string.Empty, string.Empty, headers);
        }

        var parts = lines[0].Split(' ', 3, StringSplitOptions.RemoveEmptyEntries);
        var method = parts.Length > 0 ? parts[0] : string.Empty;
        var uri = parts.Length > 1 ? parts[1] : string.Empty;
        for (var i = 1; i < lines.Length; i++)
        {
            var line = lines[i];
            if (line.Length == 0)
            {
                continue;
            }

            var colon = line.IndexOf(':');
            if (colon <= 0)
            {
                continue;
            }

            headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
        }

        return (method, uri, headers);
    }

    private static int ReadContentLength(Dictionary<string, string> headers)
    {
        if (headers.TryGetValue("Content-Length", out var text) &&
            int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var length) &&
            length > 0)
        {
            return length;
        }

        return 0;
    }

    private (int Status, string Reason, List<KeyValuePair<string, string>> Headers) Evaluate(
        string method,
        Dictionary<string, string> headers)
    {
        var extra = new List<KeyValuePair<string, string>>();
        switch (method)
        {
            case "OPTIONS":
                extra.Add(new("Public", "ANNOUNCE, SETUP, RECORD, PAUSE, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER"));
                return (200, "OK", extra);
            case "ANNOUNCE":
                return (200, "OK", extra);
            case "SETUP":
                CaptureSenderTransport(headers);
                extra.Add(new("Session", "1"));
                extra.Add(new(
                    "Transport",
                    $"RTP/AVP/UDP;unicast;mode=record;server_port={AudioPort};control_port={ControlPort};timing_port={TimingPort}"));
                extra.Add(new("Audio-Latency", "88200"));
                return (200, "OK", extra);
            case "RECORD":
                extra.Add(new("Session", "1"));
                extra.Add(new("Audio-Latency", "88200"));
                return (200, "OK", extra);
            case "SET_PARAMETER":
            case "GET_PARAMETER":
            case "FLUSH":
            case "PAUSE":
            case "TEARDOWN":
                extra.Add(new("Session", "1"));
                return (200, "OK", extra);
            default:
                return (400, "Bad Request", extra);
        }
    }

    private void CaptureSenderTransport(Dictionary<string, string> headers)
    {
        if (!headers.TryGetValue("Transport", out var transport))
        {
            return;
        }

        foreach (var rawPart in transport.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var part = rawPart.Trim();
            var equals = part.IndexOf('=');
            if (equals <= 0)
            {
                continue;
            }

            var key = part[..equals].Trim();
            if (!int.TryParse(part[(equals + 1)..].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var port))
            {
                continue;
            }

            switch (key.ToLowerInvariant())
            {
                case "control_port":
                    lock (_gate)
                    {
                        _senderControlPort = port;
                    }

                    break;
                case "timing_port":
                    lock (_gate)
                    {
                        _senderTimingPort = port;
                    }

                    break;
            }
        }
    }

    private void RecordRequest(string method, string uri, Dictionary<string, string> headers, string body, int status)
    {
        var request = new MockRtspRequest
        {
            Method = method,
            Uri = uri,
            Headers = new Dictionary<string, string>(headers, StringComparer.OrdinalIgnoreCase),
            Body = body,
            ResponseStatus = status,
        };

        lock (_gate)
        {
            _requests.Add(request);
            if (method == "TEARDOWN")
            {
                _teardownReceived = true;
            }
        }
    }

    private void CloseAfterTeardown()
    {
        lock (_gate)
        {
            _teardownClosed = true;
        }

        try
        {
            _client?.Client.Shutdown(SocketShutdown.Both);
        }
        catch (SocketException)
        {
            // peer already closed
        }
        catch (ObjectDisposedException)
        {
            // ignore
        }
    }

    private void MarkDisconnected()
    {
        lock (_gate)
        {
            _rtspDisconnected = true;
        }
    }

    private int FindHeaderEnd(MemoryStream pending)
    {
        var buffer = pending.GetBuffer();
        var length = (int)pending.Length;
        for (var i = Math.Max(0, _scanFrom); i + 3 < length; i++)
        {
            if (buffer[i] == '\r' && buffer[i + 1] == '\n' && buffer[i + 2] == '\r' && buffer[i + 3] == '\n')
            {
                return i;
            }
        }

        _scanFrom = Math.Max(0, length - 3);
        return -1;
    }

    private void TrimPending(MemoryStream pending, int consumed)
    {
        var buffer = pending.GetBuffer();
        var remaining = (int)pending.Length - consumed;
        if (remaining > 0)
        {
            Buffer.BlockCopy(buffer, consumed, buffer, 0, remaining);
        }

        pending.SetLength(remaining);
        pending.Position = remaining;
        _scanFrom = Math.Max(0, remaining - 3);
    }

    // ---- UDP side -------------------------------------------------------

    private async Task ReceiveLoopAsync(UdpClient socket, bool isAudioPort)
    {
        var token = _cts.Token;
        while (!token.IsCancellationRequested)
        {
            UdpReceiveResult result;
            try
            {
                result = await socket.ReceiveAsync(token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            catch (SocketException ex)
            {
                if (!token.IsCancellationRequested)
                {
                    RecordError($"udp {(isAudioPort ? "audio" : "control")} receive: {ex.Message}");
                }

                return;
            }

            try
            {
                if (isAudioPort)
                {
                    HandleAudioDatagram(result.Buffer);
                }
                else
                {
                    HandleControlDatagram(result.Buffer, result.RemoteEndPoint, socket);
                }
            }
            catch (Exception ex)
            {
                RecordError($"udp handle: {ex.GetType().Name}: {ex.Message}");
            }
        }
    }

    private void HandleAudioDatagram(byte[] packet)
    {
        if (packet.Length < 4)
        {
            RecordError("audio: truncated RTP header");
            return;
        }

        var payloadType = (byte)(packet[1] & 0x7F);
        if (payloadType == PayloadResendResponse)
        {
            lock (_gate)
            {
                _resendResponses++;
            }

            return;
        }

        if (payloadType != PayloadAudio)
        {
            lock (_gate)
            {
                _unknownPackets++;
            }

            return;
        }

        if (packet.Length < 12)
        {
            RecordError("audio: packet shorter than the 12-byte metadata prefix");
            return;
        }

        var sequence = BinaryPrimitives.ReadUInt16BigEndian(packet.AsSpan(2, 2));
        var timestamp = BinaryPrimitives.ReadUInt32BigEndian(packet.AsSpan(4, 4));
        var payloadBytes = packet.Length - 12;
        lock (_gate)
        {
            if (_firstSequence < 0)
            {
                _firstSequence = sequence;
                _lastSequence = sequence;
            }
            else
            {
                var expected = unchecked((ushort)(_lastSequence + 1));
                if (sequence != expected)
                {
                    _sequenceGaps++;
                }

                _lastSequence = sequence;
            }

            _audioPackets++;
            _audioPayloadBytes += payloadBytes;
            if (_timestamps.Count < 8192)
            {
                _timestamps.Add(timestamp);
            }
        }
    }

    private void HandleControlDatagram(byte[] packet, IPEndPoint remote, UdpClient socket)
    {
        if (packet.Length < 4)
        {
            RecordError("control: truncated RTP header");
            return;
        }

        var payloadType = (byte)(packet[1] & 0x7F);
        switch (payloadType)
        {
            case PayloadTimingRequest:
                HandleTimingRequest(packet, remote, socket);
                break;
            case PayloadTimingResponse:
                HandleTimingResponse(packet);
                break;
            case PayloadSync:
                HandleSyncPacket(packet);
                break;
            case PayloadResendRequest:
                lock (_gate)
                {
                    _resendRequestsReceived++;
                }

                break;
            case PayloadResendResponse:
                lock (_gate)
                {
                    _resendResponses++;
                }

                break;
            default:
                lock (_gate)
                {
                    _unknownPackets++;
                }

                break;
        }
    }

    private void HandleTimingRequest(byte[] packet, IPEndPoint remote, UdpClient socket)
    {
        if (packet.Length < 32)
        {
            RecordError("timing request: shorter than 32 bytes");
            return;
        }

        var now = MockNtpNow();
        var response = new byte[32];
        response[0] = 0x80;
        response[1] = PayloadTimingResponse;
        Array.Copy(packet, 2, response, 2, 2); // echo the request sequence
        Array.Copy(packet, 24, response, 8, 8); // origin = request transmit timestamp
        WriteNtp(response, 16, now);
        WriteNtp(response, 24, now);
        socket.Send(response, response.Length, remote);
    }

    private void HandleTimingResponse(byte[] packet)
    {
        if (packet.Length < 32)
        {
            RecordError("timing response: shorter than 32 bytes");
            return;
        }

        var sequence = BinaryPrimitives.ReadUInt16BigEndian(packet.AsSpan(2, 2));
        var originSeconds = BinaryPrimitives.ReadUInt32BigEndian(packet.AsSpan(8, 4));
        var originFraction = BinaryPrimitives.ReadUInt32BigEndian(packet.AsSpan(12, 4));
        lock (_gate)
        {
            _timingResponses++;
            if (sequence != _timingSequence ||
                originSeconds != TimingProbeSeconds ||
                originFraction != TimingProbeFraction)
            {
                _timingEchoMatches = false;
            }
        }
    }

    private void HandleSyncPacket(byte[] packet)
    {
        if (packet.Length < 20)
        {
            RecordError("sync: shorter than 20 bytes");
            return;
        }

        var rtpTime = BinaryPrimitives.ReadUInt32BigEndian(packet.AsSpan(4, 4));
        var rtpNext = BinaryPrimitives.ReadUInt32BigEndian(packet.AsSpan(16, 4));
        lock (_gate)
        {
            _syncPackets++;
            _lastSyncRtpTime = rtpTime;
            _lastSyncRtpNext = rtpNext;
        }
    }

    private static (uint Seconds, uint Fraction) MockNtpNow()
    {
        var utc = DateTime.UtcNow;
        var seconds = (ulong)(utc - DateTime.UnixEpoch).TotalSeconds;
        var fraction = (uint)((ulong)(utc.Ticks % TimeSpan.TicksPerSecond) * 4_294_967_296UL / (ulong)TimeSpan.TicksPerSecond);
        return ((uint)seconds + 2_208_988_800u, fraction);
    }

    private static void WriteNtp(byte[] packet, int offset, (uint Seconds, uint Fraction) value)
    {
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(offset, 4), value.Seconds);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(offset + 4, 4), value.Fraction);
    }

    private void RecordError(string message)
    {
        lock (_gate)
        {
            if (_errors.Count < MaxErrors)
            {
                _errors.Add(message);
            }
        }
    }

    private static UdpClient CreateUdpSocket()
    {
        var socket = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        socket.Client.ReceiveBufferSize = 64 * 1024;
        return socket;
    }

    private static int LocalPort(UdpClient socket) => ((IPEndPoint)socket.Client.LocalEndPoint!).Port;
}
