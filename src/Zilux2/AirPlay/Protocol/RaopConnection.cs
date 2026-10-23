using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using Zilux2.AirPlay.Audio;

namespace Zilux2.AirPlay.Protocol;

/// <summary>The device we intend to stream to. Discovery adapts its model into this shape.</summary>
internal sealed class RaopTarget
{
    public required string Name { get; init; }

    /// <summary>IPv4 literal (or resolvable host name) of the AirPlay receiver.</summary>
    public required string Host { get; init; }

    /// <summary>RTSP control port; classic RAOP uses 7000 for airplay, 5000 for raop.</summary>
    public int Port { get; init; } = 7000;

    /// <summary>Optional device identifier (MAC) from mDNS, used for logs and stable DACP ids.</summary>
    public string? HardwareAddress { get; init; }

    public bool RequiresPassword { get; init; }

    public override string ToString() => $"{Name} ({Host}:{Port})";
}

/// <summary>Tunables for a RAOP session.</summary>
internal sealed class RaopOptions
{
    /// <summary>Device-side buffer in milliseconds, rounded to whole 352-sample frames (default 2 s).</summary>
    public int BufferLatencyMilliseconds { get; init; } = 2000;

    public string? Password { get; init; }

    /// <summary>AES-128 key from RAOP RSA handshake; null means the stream is unencrypted (et=0).</summary>
    public byte[]? AesKey { get; init; }

    /// <summary>
    /// Announce L16 (big-endian 16-bit PCM) instead of AppleLossless. Some receivers (and every
    /// shairport-sync build) accept raw PCM, which removes the ALAC encoder from the critical path.
    /// </summary>
    public bool UseLinearPcm { get; init; }

    public byte[]? AesIv { get; init; }

    public uint Ssrc { get; init; } = 874_812_771; // matches the working TuneBlade session

    public int ConnectTimeoutMilliseconds { get; init; } = 5000;

    /// <summary>
    /// User-Agent sent on every RTSP request. Apple receivers reject unknown agents with 403,
    /// so the default advertises as iTunes (the RAOP sender Apple ships on Windows).
    /// </summary>
    public string UserAgent { get; init; } = "iTunes/12.12.10 (Windows; Microsoft Windows 10 x64)";

    public int IoTimeoutMilliseconds { get; init; } = 10_000;
}

internal sealed class RaopException : Exception
{
    public RaopException(string message, Exception? inner = null) : base(message, inner)
    {
    }
}

/// <summary>
/// Classic RAOP (AirPlay 1) sender: RTSP handshake, UDP audio plane, sync clock,
/// timing replies and resend handling. One instance == one stream to one device.
/// </summary>
internal sealed class RaopConnection : IAirPlayConnection
{
    public const int SampleRate = 44_100;
    public const int SamplesPerFrame = 352;
    public const int BytesPerFrame = SamplesPerFrame * 2 * 2; // 16-bit stereo
    public const ushort DefaultAudioPort = 6000;

    private const int HistoryCapacity = 1024; // ~8 s of audio at 352 samples/packet

    private readonly RaopTarget _target;
    private readonly RaopOptions _options;
    private readonly RtspTransport _rtsp;
    private readonly UdpClient _audioSocket;
    private readonly UdpClient _controlSocket;
    private readonly UdpClient _timingSocket;
    private readonly int _controlPort;
    private readonly int _timingPort;
    private readonly IPAddress _localAddress;
    private readonly string _rtspUri;
    private readonly string _clientInstance;
    private readonly string _dacpId;
    private readonly string _activeRemote;
    private readonly int _bufferSamples;
    private readonly RingBuffer _history = new(HistoryCapacity);
    private readonly object _sendLock = new();
    private readonly CancellationTokenSource _receiveCts = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private Task[] _receiveTasks = [];

    private IPEndPoint _deviceAudioEndPoint;
    private IPEndPoint _deviceControlEndPoint;
    private Timer? _syncTimer;
    private Aes? _aes;
    private byte[] _aesIv = new byte[16];
    private int _cseq;
    private string? _sessionId;
    private string? _digestAuthorization;
    private ushort _sequence;
    private uint _nextTimestamp;
    private uint _clockBase;
    private uint _packetsSent;
    private int _volumePercent = 70;
    private bool _streaming;
    private bool _recordSent;
    private bool _disposed;

    private RaopConnection(
        RaopTarget target,
        RaopOptions options,
        RtspTransport rtsp,
        UdpClient audioSocket,
        UdpClient controlSocket,
        UdpClient timingSocket,
        IPAddress localAddress,
        string resourceId)
    {
        _target = target;
        _options = options;
        _rtsp = rtsp;
        _audioSocket = audioSocket;
        _controlSocket = controlSocket;
        _timingSocket = timingSocket;
        _controlPort = ((IPEndPoint)controlSocket.Client.LocalEndPoint!).Port;
        _timingPort = ((IPEndPoint)timingSocket.Client.LocalEndPoint!).Port;
        _localAddress = localAddress;
        _rtspUri = $"rtsp://{localAddress}/{resourceId}";
        _clientInstance = RandomNumberGenerator.GetHexString(16, lowercase: true);
        _dacpId = RandomNumberGenerator.GetHexString(16, lowercase: true);
        _activeRemote = RandomNumberGenerator.GetInt32(10_000_000, 99_999_999).ToString(CultureInfo.InvariantCulture);
        _bufferSamples = Math.Max(SamplesPerFrame, (int)Math.Round(options.BufferLatencyMilliseconds / 1000.0 * SampleRate / SamplesPerFrame) * SamplesPerFrame);
        _deviceAudioEndPoint = new IPEndPoint(IPAddress.Parse(target.Host), DefaultAudioPort);
        _deviceControlEndPoint = new IPEndPoint(IPAddress.Parse(target.Host), DefaultAudioPort + 1);

        if (options.AesKey is { Length: 16 })
        {
            _aes = Aes.Create();
            _aes.Mode = CipherMode.CBC;
            _aes.Padding = PaddingMode.None;
            _aes.Key = options.AesKey;
            if (options.AesIv is { Length: 16 })
            {
                _aesIv = options.AesIv;
            }

            _aes.IV = _aesIv;
        }
    }

    private void StartReceiveLoops()
    {
        _receiveTasks =
        [
            Task.Run(() => ReceiveLoopAsync(_controlSocket, "control", _receiveCts.Token)),
            Task.Run(() => ReceiveLoopAsync(_timingSocket, "timing", _receiveCts.Token)),
        ];
    }

    public RaopTarget Target => _target;

    public string TargetName => _target.Name;

    public string TargetHost => _target.Host;

    /// <summary>Last volume pushed through <see cref="SetVolume"/> (0-100).</summary>
    public int VolumePercent => Volatile.Read(ref _volumePercent);

    public string? SessionId => _sessionId;

    public int BufferSamples => _bufferSamples;

    public int BufferMilliseconds => _bufferSamples * 1000 / SampleRate;

    /// <summary>Value of the Audio-Latency header reported by the device, or 0 when absent.</summary>
    public uint DeviceAudioLatency { get; private set; }

    public ushort NextSequence => _sequence;

    public uint PacketsSent => _packetsSent;

    public bool IsStreaming => _streaming;

    /// <summary>Connects, performs OPTIONS / ANNOUNCE / SETUP. Recording starts later via <see cref="BeginStreaming"/>.</summary>
    public static RaopConnection Connect(RaopTarget target, RaopOptions? options = null)
    {
        options ??= new RaopOptions();
        var timeout = TimeSpan.FromMilliseconds(options.ConnectTimeoutMilliseconds);
        if (!IPAddress.TryParse(target.Host, out var deviceAddress))
        {
            var resolved = Dns.GetHostAddresses(target.Host)
                .FirstOrDefault(address => address.AddressFamily == AddressFamily.InterNetwork)
                ?? throw new RaopException($"Cannot resolve {target.Host} to an IPv4 address.");
            deviceAddress = resolved;
        }

        var localAddress = ResolveLocalAddress(deviceAddress);

        RtspTransport? rtsp = null;
        UdpClient? audio = null;
        UdpClient? control = null;
        UdpClient? timing = null;
        try
        {
            rtsp = RtspTransport.Connect(target.Host, target.Port, timeout);
            audio = BindUdp(6001);
            control = BindUdp(6002);
            timing = BindUdp(6003);

            var resourceId = RandomNumberGenerator.GetInt32(1_000_000_000, int.MaxValue).ToString(CultureInfo.InvariantCulture);
            var connection = new RaopConnection(target, options, rtsp, audio, control, timing, localAddress, resourceId);
            try
            {
                connection.Handshake();
                connection.StartReceiveLoops();
                return connection;
            }
            catch
            {
                connection.Dispose();
                throw;
            }
        }
        catch
        {
            rtsp?.Dispose();
            audio?.Dispose();
            control?.Dispose();
            timing?.Dispose();
            throw;
        }
    }

    private void Handshake()
    {
        var options = Request("OPTIONS", "*");
        if (!options.IsSuccess)
        {
            throw new RaopException($"{_target.Name}: OPTIONS rejected ({options.Describe()}).");
        }

        var announce = Request("ANNOUNCE", _rtspUri, body: Encoding.UTF8.GetBytes(BuildSdp()), contentType: "application/sdp");
        if (!announce.IsSuccess)
        {
            throw new RaopException($"{_target.Name}: ANNOUNCE rejected ({announce.Describe()}).");
        }

        var transport = $"RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;control_port={_controlPort};timing_port={_timingPort}";
        var setup = Request("SETUP", _rtspUri, [
            new("Transport", transport),
        ]);
        if (!setup.IsSuccess)
        {
            throw new RaopException($"{_target.Name}: SETUP rejected ({setup.Describe()}).");
        }

        _sessionId = NormalizeSession(setup.Header("Session"));
        if (string.IsNullOrEmpty(_sessionId))
        {
            throw new RaopException($"{_target.Name}: SETUP response carried no Session id.");
        }

        ParseTransport(setup.Header("Transport"));
        if (uint.TryParse(setup.Header("Audio-Latency"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var latency))
        {
            DeviceAudioLatency = latency;
        }

        HostLog.Info($"[airplay] setup ok: device={_target.Name} host={_target.Host}:{_target.Port} session={_sessionId} " +
                     $"bufferMs={BufferMilliseconds} latency={DeviceAudioLatency} audioPort={_deviceAudioEndPoint.Port} controlPort={_controlPort} timingPort={_timingPort}");
    }

    /// <summary>Sends RECORD and starts the RTP wall clock + sync timer. Call once the encoder is ready.</summary>
    public void BeginStreaming()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_recordSent)
        {
            return;
        }

        _clockBase = (uint)(_bufferSamples + 2 * SampleRate); // keep sync arithmetic from underflowing at stream start
        _sequence = 0;
        _nextTimestamp = CurrentRtpTime();
        var rtpInfo = $"seq={_sequence};rtptime={_nextTimestamp}";
        var record = Request("RECORD", _rtspUri, [
            new("Range", "npt=0-"),
            new("RTP-Info", rtpInfo),
        ]);
        if (!record.IsSuccess)
        {
            throw new RaopException($"{_target.Name}: RECORD rejected ({record.Describe()}).");
        }

        _recordSent = true;
        _streaming = true;
        _syncTimer = new Timer(_ => SendSync(), null, 1000, 1000);
        HostLog.Info($"[airplay] record ok: device={_target.Name} seq={_sequence} rtptime={_nextTimestamp} bufferSamples={_bufferSamples}");
    }

    /// <summary>
    /// Sends one ALAC frame (352 stereo samples) as an RTP audio packet.
    /// Safe to call from the capture/encoder thread; drops packets when not streaming.
    /// </summary>
    public bool SendAudioFrame(ReadOnlySpan<byte> alacPayload)
    {
        if (_disposed || !_streaming || alacPayload.IsEmpty)
        {
            return false;
        }

        var payload = alacPayload;
        if (_aes is not null)
        {
            // RAOP encrypts whole 16-byte blocks with AES-128-CBC and leaves a short tail in the clear.
            var aligned = payload.Length / 16 * 16;
            var buffer = new byte[payload.Length];
            if (aligned > 0)
            {
                var cipher = _aes.EncryptCbc(payload[..aligned], _aesIv, PaddingMode.None);
                cipher.CopyTo(buffer, 0);
            }

            payload[aligned..].CopyTo(buffer.AsSpan(aligned));
            payload = buffer;
        }

        lock (_sendLock)
        {
            var packet = RaopPackets.BuildAudioPacket(_sequence, _nextTimestamp, _options.Ssrc, payload);
            _history.Add(_sequence, packet);
            try
            {
                _audioSocket.Send(packet, packet.Length, _deviceAudioEndPoint);
            }
            catch (SocketException ex)
            {
                HostLog.Warn($"[airplay] audio send failed: {ex.Message}");
                return false;
            }

            _sequence = unchecked((ushort)(_sequence + 1));
            _nextTimestamp += SamplesPerFrame;
            _packetsSent++;
            return true;
        }
    }

    public void SetVolume(int percent)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        percent = Math.Clamp(percent, 0, 100);
        Volatile.Write(ref _volumePercent, percent);
        var decibels = percent == 0 ? -144 : Math.Max(-144, -30.0 * (100 - percent) / 100.0);
        var body = string.Create(CultureInfo.InvariantCulture, $"volume: {decibels.ToString("N6", CultureInfo.InvariantCulture)}\r\n");
        var response = Request("SET_PARAMETER", _rtspUri, [
            new("Content-Type", "text/parameters"),
        ], Encoding.UTF8.GetBytes(body));
        if (!response.IsSuccess)
        {
            HostLog.Warn($"[airplay] volume rejected: {response.Describe()}");
        }
    }

    /// <summary>FLUSH drops device-side buffered audio; used when switching tracks or pausing.</summary>
    public void Flush()
    {
        if (_disposed || !_recordSent)
        {
            return;
        }

        lock (_sendLock)
        {
            var response = Request("FLUSH", _rtspUri, [
                new("RTP-Info", $"seq={_sequence};rtptime={_nextTimestamp}"),
            ]);
            if (!response.IsSuccess)
            {
                HostLog.Warn($"[airplay] flush rejected: {response.Describe()}");
            }
        }
    }

    public void Teardown()
    {
        if (_disposed || _sessionId is null)
        {
            return;
        }

        try
        {
            var response = Request("TEARDOWN", _rtspUri);
            if (!response.IsSuccess)
            {
                HostLog.Warn($"[airplay] teardown rejected: {response.Describe()}");
            }
        }
        catch (Exception ex)
        {
            HostLog.Warn($"[airplay] teardown failed: {ex.Message}");
        }
    }

    private uint CurrentRtpTime() => unchecked(_clockBase + (uint)(_clock.Elapsed.TotalSeconds * SampleRate));

    private void SendSync()
    {
        if (_disposed || !_streaming)
        {
            return;
        }

        try
        {
            var now = CurrentRtpTime();
            var rtpNext = unchecked(now - RaopPackets.SyncLatencyCompensation);
            var rtpTime = unchecked(rtpNext - (uint)_bufferSamples);
            var packet = RaopPackets.BuildSyncPacket(rtpTime, NtpTimestamp.Now(), rtpNext);
            _audioSocket.Send(packet, packet.Length, _deviceControlEndPoint);
        }
        catch (Exception ex)
        {
            HostLog.Warn($"[airplay] sync send failed: {ex.Message}");
        }
    }

    private async Task ReceiveLoopAsync(UdpClient socket, string name, CancellationToken cancellationToken)
    {
        var scratch = new byte[2048];
        while (!cancellationToken.IsCancellationRequested)
        {
            UdpReceiveResult result;
            try
            {
                result = await socket.ReceiveAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            catch (Exception ex)
            {
                HostLog.Warn($"[airplay] {name} receive failed: {ex.Message}");
                return;
            }

            try
            {
                HandleControlPacket(result.Buffer, result.RemoteEndPoint, name);
            }
            catch (Exception ex)
            {
                HostLog.Warn($"[airplay] {name} packet handling failed: {ex.Message}");
            }
        }
    }

    private void HandleControlPacket(byte[] packet, IPEndPoint remote, string socketName)
    {
        if (RaopPackets.TryParseTimingRequest(packet, out var sequence, out var origin))
        {
            var now = NtpTimestamp.Now();
            var response = RaopPackets.BuildTimingResponse(sequence, origin, now, now);
            // Reply from the socket the request arrived on; some devices watch both ports.
            var sender = socketName == "timing" ? _timingSocket : _controlSocket;
            sender.Send(response, response.Length, remote);
            return;
        }

        if (RaopPackets.TryParseResendRequest(packet, out var firstSequence, out var count))
        {
            ResendPackets(firstSequence, count, remote);
        }
    }

    private void ResendPackets(ushort firstSequence, ushort count, IPEndPoint remote)
    {
        // Cap the burst: a malicious/broken request must not stall the audio thread.
        var limit = Math.Min(count, (ushort)64);
        var buffer = new byte[2048];
        for (var i = 0; i < limit; i++)
        {
            var wanted = unchecked((ushort)(firstSequence + i));
            if (!_history.TryGet(wanted, out var stored))
            {
                continue;
            }

            var total = RaopPackets.BuildResendResponse(stored, buffer);
            var destination = new IPEndPoint(IPAddress.Parse(_target.Host), DefaultAudioPort);
            _audioSocket.Send(buffer, total, destination);
            _audioSocket.Send(buffer, total, remote);
        }
    }

    private RtspResponse Request(string method, string uri, IEnumerable<KeyValuePair<string, string>>? headers = null, byte[]? body = null, string? contentType = null)
    {
        var list = new List<KeyValuePair<string, string>>
        {
            new("CSeq", (++_cseq).ToString(CultureInfo.InvariantCulture)),
            new("User-Agent", _options.UserAgent),
            new("Client-Instance", _clientInstance),
            new("DACP-ID", _dacpId),
            new("Active-Remote", _activeRemote),
        };

        if (_sessionId is not null)
        {
            list.Add(new("Session", _sessionId));
        }

        if (contentType is not null)
        {
            list.Add(new("Content-Type", contentType));
        }

        if (_digestAuthorization is not null)
        {
            list.Add(new("Authorization", BuildDigest(uri, method)));
        }

        if (headers is not null)
        {
            list.AddRange(headers);
        }

        var response = _rtsp.Send(method, uri, list, body);
        if (response.StatusCode != 401 || string.IsNullOrEmpty(_options.Password))
        {
            if (response.StatusCode == 403)
            {
                throw new RaopException($"{_target.Name}: {method} forbidden (403) — the device likely requires AirPlay 2 pairing.");
            }

            return response;
        }

        // Password-protected device: authenticate once, then retry the same request.
        if (!RtspDigestChallenge.TryParse(response.Header("WWW-Authenticate"), out var challenge))
        {
            throw new RaopException($"{_target.Name}: {method} requires a password but no digest challenge was offered.");
        }

        _digestChallenge = challenge;
        _digestAuthorization = BuildDigest(uri, method);
        return Request(method, uri, headers, body, contentType);
    }

    private RtspDigestChallenge? _digestChallenge;

    private string BuildDigest(string uri, string method)
    {
        if (_digestChallenge is null)
        {
            return _digestAuthorization ?? string.Empty;
        }

        return _digestChallenge.BuildAuthorization("AirPlay", _options.Password ?? string.Empty, method, uri);
    }

    private string BuildSdp()
    {
        var builder = new StringBuilder();
        builder.Append("v=0\r\n");
        builder.Append("o=iTunes ").Append(RandomNumberGenerator.GetInt32(1_000_000_000, int.MaxValue)).Append(" 0 IN IP4 ")
            .Append(_localAddress).Append("\r\n");
        builder.Append("s=iTunes\r\n");
        builder.Append("c=IN IP4 ").Append(_localAddress).Append("\r\n");
        builder.Append("t=0 0\r\n");
        builder.Append("m=audio 0 RTP/AVP 96\r\n");
        builder.Append("a=rtpmap:96 ").Append(_options.UseLinearPcm ? "L16/44100/2" : "AppleLossless").Append("\r\n");
        builder.Append("a=fmtp:96 ").Append(SamplesPerFrame).Append(" 0 16 40 10 14 2 255 0 0 44100\r\n");
        if (_aes is not null)
        {
            builder.Append("a=rsaaeskey:").Append(Convert.ToBase64String(_aes.Key)).Append("\r\n");
            builder.Append("a=aesiv:").Append(Convert.ToBase64String(_aesIv)).Append("\r\n");
        }

        return builder.ToString();
    }

    private void ParseTransport(string? transport)
    {
        if (string.IsNullOrWhiteSpace(transport))
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
            var value = part[(equals + 1)..].Trim();
            switch (key.ToLowerInvariant())
            {
                case "server_port" when int.TryParse(value, out var audioPort):
                    _deviceAudioEndPoint = new IPEndPoint(_deviceAudioEndPoint.Address, audioPort);
                    _deviceControlEndPoint = new IPEndPoint(_deviceAudioEndPoint.Address, audioPort + 1);
                    break;
                case "control_port" when int.TryParse(value, out var controlPort):
                    _deviceControlEndPoint = new IPEndPoint(_deviceAudioEndPoint.Address, controlPort);
                    break;
                case "timing_port" when int.TryParse(value, out var timingPort):
                    _ = timingPort; // devices rarely use this; requests arrive on the control socket
                    break;
            }
        }
    }

    private static string? NormalizeSession(string? session)
    {
        if (string.IsNullOrWhiteSpace(session))
        {
            return null;
        }

        var semicolon = session.IndexOf(';');
        return (semicolon >= 0 ? session[..semicolon] : session).Trim();
    }

    private static IPAddress ResolveLocalAddress(IPAddress deviceAddress)
    {
        using var probe = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        try
        {
            probe.Connect(new IPEndPoint(deviceAddress, 7000));
            if (probe.LocalEndPoint is IPEndPoint endpoint && !endpoint.Address.Equals(IPAddress.Any))
            {
                return endpoint.Address;
            }
        }
        catch
        {
            // fall through to loopback
        }

        return IPAddress.Loopback;
    }

    private static UdpClient BindUdp(int startPort)
    {
        for (var port = startPort; port < startPort + 500; port++)
        {
            try
            {
                var client = new UdpClient(new IPEndPoint(IPAddress.Any, port));
                client.Client.ReceiveBufferSize = 24 * 1024;
                return client;
            }
            catch (SocketException)
            {
                // port busy, try the next one
            }
        }

        throw new RaopException($"No free UDP port in range {startPort}-{startPort + 499}.");
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _streaming = false;
        _syncTimer?.Dispose();
        _syncTimer = null;
        _receiveCts.Cancel();

        try
        {
            _audioSocket.Dispose();
            _controlSocket.Dispose();
            _timingSocket.Dispose();
        }
        catch
        {
            // ignore
        }

        try
        {
            Task.WaitAll(_receiveTasks, TimeSpan.FromSeconds(1));
        }
        catch
        {
            // ignore
        }

        _rtsp.Dispose();
        _aes?.Dispose();
        _receiveCts.Dispose();
        HostLog.Info($"[airplay] connection disposed: device={_target.Name} packets={_packetsSent}");
    }

    /// <summary>Fixed-size ring buffer of sent packets so the device can request retransmits.</summary>
    private sealed class RingBuffer
    {
        private readonly byte[][] _packets;
        private readonly ushort[] _sequences;
        private readonly bool[] _valid;
        private int _writeIndex;

        public RingBuffer(int capacity)
        {
            _packets = new byte[capacity][];
            _sequences = new ushort[capacity];
            _valid = new bool[capacity];
        }

        public void Add(ushort sequence, byte[] packet)
        {
            var index = _writeIndex;
            _packets[index] = packet;
            _sequences[index] = sequence;
            _valid[index] = true;
            _writeIndex = (_writeIndex + 1) % _packets.Length;
        }

        public bool TryGet(ushort sequence, out byte[] packet)
        {
            for (var i = 0; i < _packets.Length; i++)
            {
                var index = (_writeIndex - 1 - i + _packets.Length) % _packets.Length;
                if (_valid[index] && _sequences[index] == sequence)
                {
                    packet = _packets[index];
                    return true;
                }
            }

            packet = [];
            return false;
        }
    }
}
