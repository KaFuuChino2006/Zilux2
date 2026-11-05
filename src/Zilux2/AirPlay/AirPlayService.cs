using System.IO;
using System.Net.Sockets;
using Zilux2.AirPlay.Audio;
using Zilux2.AirPlay.Protocol;
using Zilux2.Audio;

namespace Zilux2.AirPlay;

internal enum AirPlayState
{
    Idle,
    Scanning,
    Connecting,
    Streaming,
    Error,
}

/// <summary>One receiver that is currently being streamed to.</summary>
internal sealed class AirPlayActiveDevice
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    public int VolumePercent { get; init; }
}

/// <summary>Immutable snapshot pushed to the host (and from there to the page).</summary>
internal sealed class AirPlayStatus
{
    public AirPlayState State { get; init; } = AirPlayState.Idle;

    public IReadOnlyList<AirPlayDeviceInfo> Devices { get; init; } = Array.Empty<AirPlayDeviceInfo>();

    /// <summary>All receivers currently streaming (one entry per connected device).</summary>
    public IReadOnlyList<AirPlayActiveDevice> Actives { get; init; } = Array.Empty<AirPlayActiveDevice>();

    /// <summary>Primary (first) active device, kept for backward compatibility.</summary>
    public string? ActiveDeviceId { get; init; }

    public string? ActiveDeviceName { get; init; }

    /// <summary>Number of receivers currently streaming.</summary>
    public int ActiveCount => Actives.Count;

    public int VolumePercent { get; init; }

    /// <summary>Machine-readable failure code: passwordRequired | pinRequired | unsupported | busy | network | capture | internal.</summary>
    public string? Code { get; init; }

    public string? Error { get; init; }
}

/// <summary>
/// Owns discovery + one live RAOP session. Threading contract: commands may be called from any
/// thread; <see cref="StatusChanged"/> is raised on whichever thread produced the change
/// (discovery thread, connect task or pump fault), so the host must marshal it.
/// </summary>
internal sealed class AirPlayService : IDisposable
{
    private readonly IAirPlayDeviceDiscovery? _discovery;
    private readonly Func<IAirPlayAudioEncoder> _encoderFactory;
    private readonly Func<RaopTarget, RaopOptions, IAirPlayConnection>? _airPlay2Factory;
    private readonly Func<IAirPlayAudioEncoder>? _airPlay2EncoderFactory;
    private readonly Func<RaopTarget, RaopOptions, Func<CancellationToken, Task<string>>, IAirPlayConnection>? _airPlay2PinFactory;
    private readonly object _gate = new();

    private AirPlayStreamer? _streamer;
    private CancellationTokenSource? _connectCts;
    private Task? _connectTask;
    private Task _teardownTask = Task.CompletedTask;
    private TaskCompletionSource<string>? _pinWaiter;
    private string? _pinDeviceId;
    /// <summary>正在握手的目标设备；只用于 CancelConnectAsync(deviceId) 精确中止。</summary>
    private string? _connectingDeviceId;
    private IReadOnlyList<AirPlayDeviceInfo> _devices = Array.Empty<AirPlayDeviceInfo>();
    private AirPlayState _state = AirPlayState.Idle;
    private string? _code;
    private string? _error;
    private readonly List<(string Id, string Name, int Volume)> _actives = new();
    private readonly PcmTapSource _audioTap = new();
    private int _audioTapLogCount;
    private float[] _audioConvertBuffer = Array.Empty<float>();
    private int _volumePercent = 70;
    private bool _disposed;

    /// <summary>
    /// Receiver buffer latency (ms) requested from AirPlay 2 receivers in new sessions. Read by the
    /// transport factories in <c>App.xaml.cs</c>, so a change only affects the next connection.
    /// 300 ms absorbs WiFi jitter; lower values feel snappier but may crackle on a noisy network.
    /// </summary>
    private static int _defaultLatencyMilliseconds = 300;

    public static int DefaultLatencyMilliseconds
    {
        get => Volatile.Read(ref _defaultLatencyMilliseconds);
        set => Volatile.Write(ref _defaultLatencyMilliseconds, Math.Clamp(value, 100, 600));
    }

    /// <summary>Latency (ms) that will be requested by the next AirPlay 2 connection.</summary>
    public int LatencyMilliseconds => DefaultLatencyMilliseconds;

    /// <param name="discovery">mDNS browser, or null when sockets could not be created.</param>
    /// <param name="encoderFactory">Creates a fresh ALAC encoder per session.</param>
    /// <param name="airPlay2Factory">
    /// Optional AirPlay 2 (HAP-encrypted) transport factory. When set and the receiver advertises
    /// AirPlay 2, it is tried first; failures fall back to classic RAOP.
    /// </param>
    /// <param name="airPlay2PinFactory">
    /// Optional AirPlay 2 transport factory for receivers that require HAP PIN pairing (macOS
    /// "AirPlay Receiver"): it resolves the PIN through a callback so the UI can prompt the user.
    /// </param>
    public AirPlayService(
        IAirPlayDeviceDiscovery? discovery,
        Func<IAirPlayAudioEncoder> encoderFactory,
        Func<RaopTarget, RaopOptions, IAirPlayConnection>? airPlay2Factory = null,
        Func<IAirPlayAudioEncoder>? airPlay2EncoderFactory = null,
        Func<RaopTarget, RaopOptions, Func<CancellationToken, Task<string>>, IAirPlayConnection>? airPlay2PinFactory = null)
    {
        _discovery = discovery;
        _encoderFactory = encoderFactory ?? throw new ArgumentNullException(nameof(encoderFactory));
        _airPlay2Factory = airPlay2Factory;
        _airPlay2EncoderFactory = airPlay2EncoderFactory;
        _airPlay2PinFactory = airPlay2PinFactory;
        if (_discovery is not null)
        {
            _discovery.DevicesChanged += OnDevicesChanged;
        }
    }

    /// <summary>False when mDNS discovery could not be initialized; the UI then only offers the "unsupported" path.</summary>
    public bool IsDiscoveryAvailable => _discovery is not null;

    public bool IsStreaming
    {
        get
        {
            lock (_gate)
            {
                return _state == AirPlayState.Streaming;
            }
        }
    }

    public AirPlayStatus Status
    {
        get
        {
            lock (_gate)
            {
                return SnapshotLocked();
            }
        }
    }

    public event Action<AirPlayStatus>? StatusChanged;

    /// <summary>
    /// Applies the format of the page's PCM tap before the first block arrives. The page posts this
    /// when it starts tapping so the streamer resamples from the right rate.
    /// </summary>
    public void ConfigureAudioTap(int sampleRate, int channels)
    {
        _audioTap.Configure(sampleRate, channels);
        ClearCaptureErrorIfRecovered();
    }

    /// <summary>页面取流恢复后撤掉瞬时 capture 告警（错误态需要用户重连，不自动清）。</summary>
    private void ClearCaptureErrorIfRecovered()
    {
        var recovered = false;
        lock (_gate)
        {
            if (_code == "capture" && _state is AirPlayState.Streaming or AirPlayState.Connecting)
            {
                _code = null;
                _error = null;
                recovered = true;
            }
        }

        if (recovered)
        {
            HostLog.Info("[airplay] page audio capture recovered");
            Publish();
        }
    }

    /// <summary>Drops audio buffered from the page (session restart, pause, seek).</summary>
    public void ResetAudioTap()
    {
        _audioTap.Reset();
    }

    /// <summary>
    /// Queues 16-bit interleaved PCM captured by the page's audio tap. The page mutes its own local
    /// output while this is active, so only AirPlay plays the sound; other apps are untouched.
    /// </summary>
    public void PushAudio(int sampleRate, int channels, ReadOnlySpan<short> samples)
    {
        if (samples.IsEmpty)
        {
            return;
        }

        _audioTap.Configure(sampleRate, channels);
        // The page pushes ~21 ms blocks continuously; reuse the conversion buffer instead of
        // allocating a fresh float[] for every block (LOH pressure / GC jitter in the pump).
        var buffer = _audioConvertBuffer;
        if (buffer.Length < samples.Length)
        {
            buffer = new float[samples.Length];
            _audioConvertBuffer = buffer;
        }

        for (var i = 0; i < samples.Length; i++)
        {
            buffer[i] = samples[i] / 32768f;
        }

        _audioTap.Push(buffer.AsSpan(0, samples.Length));
        var pushCount = Interlocked.Increment(ref _audioTapLogCount);
        if (pushCount <= 3 || pushCount % 500 == 0)
        {
            var peak = 0f;
            foreach (var sample in buffer)
            {
                var magnitude = MathF.Abs(sample);
                if (magnitude > peak) peak = magnitude;
            }

            HostLog.Info($"[airplay] audio tap push n={pushCount} samples={samples.Length} rate={sampleRate} ch={channels} peak={peak:F3}");
        }

    }

    /// <summary>Starts mDNS browsing; idempotent. Raises a "scanning" snapshot immediately.</summary>
    public void StartScan()
    {
        if (_disposed)
        {
            return;
        }

        if (_discovery is null)
        {
            SetError("unsupported", "设备发现不可用（无法创建 mDNS 套接字）");
            return;
        }

        try
        {
            _discovery.Start();
        }
        catch (Exception ex)
        {
            HostLog.Error("[airplay] discovery start failed", ex);
            SetError("network", $"无法启动设备发现：{ex.Message}");
            return;
        }

        lock (_gate)
        {
            if (_state != AirPlayState.Streaming && _state != AirPlayState.Connecting)
            {
                _state = AirPlayState.Scanning;
                _code = null;
                _error = null;
            }
        }

        Publish();
    }

    /// <summary>Stops browsing; a live stream is unaffected. Idempotent.</summary>
    public void StopScan()
    {
        if (_disposed)
        {
            return;
        }

        try
        {
            _discovery?.Stop();
        }
        catch (Exception ex)
        {
            HostLog.Warn($"[airplay] discovery stop failed: {ex.GetType().Name}: {ex.Message}");
        }

        lock (_gate)
        {
            if (_state == AirPlayState.Scanning)
            {
                _state = AirPlayState.Idle;
            }
        }

        Publish();
    }

    /// <summary>
    /// Connects to the discovered device and starts (or joins) system audio streaming. Calling it
    /// again while already streaming attaches another receiver to the same capture pipeline and
    /// packet timeline. Runs the blocking RAOP handshake on a worker thread; failures surface as an
    /// "error" snapshot with a stable code.
    /// </summary>
    public void Connect(string deviceId, string? password)
    {
        if (_disposed)
        {
            return;
        }

        AirPlayDeviceInfo? device;
        var alreadyStreaming = false;
        lock (_gate)
        {
            device = _devices.FirstOrDefault(d => string.Equals(d.Id, deviceId, StringComparison.Ordinal));
            if (_actives.Any(active => string.Equals(active.Id, deviceId, StringComparison.Ordinal)))
            {
                HostLog.Info($"[airplay] device already streaming id={deviceId}");
                return;
            }

            alreadyStreaming = _state == AirPlayState.Streaming && _streamer is not null;
        }

        if (device is null)
        {
            // While a session is already streaming this is a secondary "add receiver" request;
            // turning the whole snapshot into Error would hide a working stream. Surface it as a
            // transient notice instead and keep the existing state.
            if (alreadyStreaming)
            {
                SetTransientError("internal", "设备已不在列表中，请重新扫描");
            }
            else
            {
                SetError("internal", "设备已不在列表中，请重新扫描");
            }
            return;
        }

        if (device.RequiresPassword && string.IsNullOrEmpty(password))
        {
            if (alreadyStreaming)
            {
                SetTransientError("passwordRequired", "该设备需要密码");
            }
            else
            {
                SetError("passwordRequired", "该设备需要密码");
            }
            return;
        }

        CancelConnect();

        var cts = new CancellationTokenSource();
        _connectCts = cts;

        // Publish "connecting" even when another receiver already streams: adding a receiver still
        // performs a full handshake and the UI must show the new device as connecting. ConnectCore
        // restores Streaming on success and on a failed add (the first receiver keeps playing).
        lock (_gate)
        {
            _state = AirPlayState.Connecting;
            _code = null;
            _error = null;
            _connectingDeviceId = device.Id;
        }

        Publish();

        var token = cts.Token;
        _connectTask = Task.Run(() => ConnectCore(device, password, token), CancellationToken.None);
    }

    /// <summary>
    /// P2-54: cancels a handshake only when the given device is the one currently connecting.
    /// Does not touch receivers that are already streaming; safe to call when idle or after the
    /// handshake completed (no-op). Never blocks the UI thread (cancellation is asynchronous).
    /// </summary>
    public Task CancelConnectAsync(string deviceId)
    {
        if (_disposed)
        {
            return Task.CompletedTask;
        }

        lock (_gate)
        {
            if (_state != AirPlayState.Connecting)
            {
                return Task.CompletedTask;
            }

            if (!string.IsNullOrEmpty(_connectingDeviceId) &&
                !string.Equals(_connectingDeviceId, deviceId, StringComparison.Ordinal))
            {
                return Task.CompletedTask;
            }
        }

        CancelConnect();
        return Task.CompletedTask;
    }

    /// <summary>Tears every session down and returns to idle. Safe to call when not streaming.</summary>
    public void Disconnect()
    {
        if (_disposed)
        {
            return;
        }

        CancelConnect();
        AirPlayStreamer? streamer;
        lock (_gate)
        {
            streamer = _streamer;
            _streamer = null;
            _actives.Clear();
            // A disconnect is a user-visible return to idle, even after an error: the error
            // banner must not survive the teardown that the user just requested.
            _state = AirPlayState.Idle;
            _code = null;
            _error = null;
        }

        // Publish before the blocking teardown so the UI leaves "streaming" immediately.
        Publish();

        if (streamer is not null)
        {
            // Stop/Dispose joins the pump and capture threads and sends TEARDOWN; keep it off
            // the UI thread and remember the task so a new connect does not overlap it.
            _teardownTask = Task.Run(() => StopStreamer(streamer));
        }
    }

    /// <summary>Stops and disposes one streamer; never throws.</summary>
    private static void StopStreamer(AirPlayStreamer streamer)
    {
        try
        {
            streamer.Stop();
        }
        catch (Exception ex)
        {
            HostLog.Warn($"[airplay] stop failed: {ex.GetType().Name}: {ex.Message}");
        }

        try
        {
            streamer.Dispose();
        }
        catch (Exception ex)
        {
            HostLog.Warn($"[airplay] streamer dispose failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    /// <summary>
    /// Reports that the page audio tap could not start. The receiver session can only deliver
    /// silence, so it is torn down and the documented "capture" code is published instead of
    /// leaving the UI in a fake streaming state.
    /// </summary>
    public void ReportCaptureFailure(string? detail)
    {
        if (_disposed)
        {
            return;
        }

        var reason = string.IsNullOrWhiteSpace(detail) ? string.Empty : detail.Trim();
        if (reason.Length > 200)
        {
            reason = reason[..200];
        }

        HostLog.Warn($"[airplay] page audio capture failed: {(reason.Length == 0 ? "(no detail)" : reason)}");

        // 契约 §12.3：采集失败按 capture 每 5s 重试。这里不能立即断开：
        // 页面在 connecting/streaming 下才会重试取流，断开会让 app.ts 停掉取流并无法恢复。
        var message = reason.Length == 0
            ? "无法采集页面音频，正在重试"
            : $"无法采集页面音频，正在重试：{reason}";

        lock (_gate)
        {
            if (_state is AirPlayState.Streaming or AirPlayState.Connecting)
            {
                _code = "capture";
                _error = message;
            }
            else
            {
                _state = AirPlayState.Error;
                _code = "capture";
                _error = message;
            }
        }

        Publish();
    }

    /// <summary>Detaches one receiver; the remaining receivers keep playing.</summary>
    public void DisconnectDevice(string deviceId)
    {
        if (_disposed || string.IsNullOrEmpty(deviceId))
        {
            return;
        }

        AirPlayStreamer? streamer;
        var remaining = 0;
        lock (_gate)
        {
            streamer = _streamer;
            _actives.RemoveAll(active => string.Equals(active.Id, deviceId, StringComparison.Ordinal));
            remaining = _actives.Count;
            if (remaining == 0 && _state == AirPlayState.Streaming)
            {
                _state = AirPlayState.Idle;
                _code = null;
                _error = null;
            }
        }

        if (streamer is null)
        {
            // No live stream: this is a cancel of an in-flight handshake (e.g. the PIN prompt). Stop
            // the connect task and fall back to idle so Publish() restores the local output.
            CancelConnect();
            lock (_gate)
            {
                if (_state == AirPlayState.Connecting)
                {
                    _state = AirPlayState.Idle;
                    _code = null;
                    _error = null;
                }
            }

            Publish();
            return;
        }

        if (remaining == 0)
        {
            Disconnect();
            return;
        }

        // Publish first: the UI must drop the receiver immediately, while TEARDOWN (blocking RTSP)
        // runs on a worker. _teardownTask also serializes the next ConnectCore so the port/session
        // cannot overlap with the old one.
        Publish();
        _teardownTask = Task.Run(() =>
        {
            try
            {
                streamer.RemoveConnection(deviceId);
            }
            catch (Exception ex)
            {
                HostLog.Warn($"[airplay] remove receiver failed: {ex.GetType().Name}: {ex.Message}");
            }
        });
    }

    /// <summary>
    /// P2-51 volume semantics: this is the <em>global</em> level. It overrides every receiver that is
    /// currently streaming and becomes the level applied to receivers that join later
    /// (<see cref="ConnectCore"/> reads <c>_volumePercent</c>); the page clears per-device overrides
    /// when the global slider moves. <see cref="SetVolume(string,int)"/> only touches one receiver
    /// and deliberately does not change this base value.
    /// </summary>
    public void SetVolume(int percent)
    {
        percent = Math.Clamp(percent, 0, 100);
        AirPlayStreamer? streamer;
        lock (_gate)
        {
            _volumePercent = percent;
            for (var i = 0; i < _actives.Count; i++)
            {
                _actives[i] = (_actives[i].Id, _actives[i].Name, percent);
            }

            streamer = _streamer;
        }

        if (streamer is not null)
        {
            try
            {
                streamer.VolumePercent = percent;
            }
            catch (Exception ex)
            {
                HostLog.Warn($"[airplay] volume failed: {ex.GetType().Name}: {ex.Message}");
            }
        }

        Publish();
    }

    /// <summary>
    /// Sets one receiver's volume only (the others keep their own level). Unknown devices are
    /// ignored; an empty id falls back to <see cref="SetVolume(int)"/> (all devices).
    /// </summary>
    public void SetVolume(string deviceId, int percent)
    {
        if (string.IsNullOrEmpty(deviceId))
        {
            SetVolume(percent);
            return;
        }

        percent = Math.Clamp(percent, 0, 100);
        AirPlayStreamer? streamer;
        lock (_gate)
        {
            var index = _actives.FindIndex(active => string.Equals(active.Id, deviceId, StringComparison.Ordinal));
            if (index < 0)
            {
                return;
            }

            _actives[index] = (_actives[index].Id, _actives[index].Name, percent);
            streamer = _streamer;
        }

        if (streamer is not null)
        {
            try
            {
                streamer.SetDeviceVolume(deviceId, percent);
            }
            catch (Exception ex)
            {
                HostLog.Warn($"[airplay] volume failed device={deviceId}: {ex.GetType().Name}: {ex.Message}");
            }
        }

        Publish();
    }

    /// <summary>
    /// Discards audio already queued on every active receiver (pause / seek / track change).
    /// Fire-and-forget: returns when the FLUSH attempts have been dispatched, never throws.
    /// Contract: page sends <c>{v:1,type:'airplay',action:'flush'}</c>; the bridge forwards it here.
    /// </summary>
    public Task FlushAsync()
    {
        AirPlayStreamer? streamer;
        lock (_gate)
        {
            if (_disposed)
            {
                return Task.CompletedTask;
            }
            streamer = _streamer;
        }

        return streamer?.FlushAllAsync() ?? Task.CompletedTask;
    }

    /// <summary>
    /// Changes the requested AirPlay 2 output latency (100–600 ms, clamped). Existing sessions keep
    /// the latency they negotiated, so this applies from the next connection on.
    /// </summary>
    public void SetLatency(int milliseconds)
    {
        var value = Math.Clamp(milliseconds, 100, 600);
        var previous = DefaultLatencyMilliseconds;
        DefaultLatencyMilliseconds = value;
        if (value != previous)
        {
            HostLog.Info($"[airplay] latency {previous}ms -> {value}ms (applies on next connect)");
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        if (_discovery is not null)
        {
            _discovery.DevicesChanged -= OnDevicesChanged;
        }

        CancelConnect();

        // Exit path: give the cancelled connect a bounded chance to release sockets before the
        // streamer/discovery are torn down. (CancelConnect itself must not block the UI thread.)
        var connectTask = _connectTask;
        if (connectTask is not null && !connectTask.IsCompleted && connectTask.Id != Task.CurrentId)
        {
            try
            {
                connectTask.Wait(TimeSpan.FromSeconds(3));
            }
            catch (AggregateException)
            {
                // ConnectCore reports its own failures.
            }
        }

        // Let an in-flight background teardown finish first: it may still own the streamer's
        // threads, UDP ports and the shared PTP lease.
        if (!_teardownTask.IsCompleted)
        {
            try
            {
                _teardownTask.Wait(TimeSpan.FromSeconds(3));
            }
            catch (AggregateException)
            {
                // StopStreamer never throws; the wait is best effort.
            }
        }

        AirPlayStreamer? streamer;
        lock (_gate)
        {
            streamer = _streamer;
            _streamer = null;
            _actives.Clear();
            _state = AirPlayState.Idle;
        }

        if (streamer is not null)
        {
            try
            {
                streamer.Dispose();
            }
            catch (Exception ex)
            {
                HostLog.Warn($"[airplay] streamer dispose failed: {ex.GetType().Name}: {ex.Message}");
            }
        }

        try
        {
            _discovery?.Dispose();
        }
        catch (Exception ex)
        {
            HostLog.Warn($"[airplay] discovery dispose failed: {ex.GetType().Name}: {ex.Message}");
        }

        HostLog.Info("[airplay] service disposed");
    }

    private void ConnectCore(AirPlayDeviceInfo device, string? password, CancellationToken token)
    {
        if (token.IsCancellationRequested)
        {
            return;
        }

        // A previous session may still be sending TEARDOWN and releasing its UDP ports / PTP
        // lease in the background. Give it a bounded head start before opening a new session.
        if (!_teardownTask.IsCompleted)
        {
            try
            {
                _teardownTask.Wait(TimeSpan.FromSeconds(3));
            }
            catch (AggregateException)
            {
                // StopStreamer never throws; the wait is best effort.
            }
        }

        AirPlayStreamer? streamer = null;
        IAirPlayConnection? connection = null;
        try
        {
            var target = new RaopTarget
            {
                Name = device.Name,
                Host = device.Host,
                Port = device.Port,
                RequiresPassword = device.RequiresPassword,
            };
            var options = new RaopOptions { Password = string.IsNullOrEmpty(password) ? null : password };

            HostLog.Info($"[airplay] connect {device.Host}:{device.Port} name={device.Name} ap2={device.SupportsAirPlay2}");
            connection = ConnectTransport(device, target, options, token);
            if (token.IsCancellationRequested)
            {
                connection.Dispose();
                return;
            }

            AirPlayStreamer? existing;
            lock (_gate)
            {
                existing = _streamer;
            }

            if (existing is not null && existing.IsRunning)
            {
                // Another receiver is already streaming: attach to the same capture pipeline and
                // packet timeline so every device plays the exact same audio.
                existing.AddConnection(device.Id, connection);
                connection = null; // owned by the streamer from here on
                lock (_gate)
                {
                    if (!_actives.Any(active => string.Equals(active.Id, device.Id, StringComparison.Ordinal)))
                    {
                        _actives.Add((device.Id, device.Name, Volatile.Read(ref _volumePercent)));
                    }

                    _state = AirPlayState.Streaming;
                    _code = null;
                    _error = null;
                }

                HostLog.Info($"[airplay] receiver added device={device.Name} actives={Status.ActiveCount}");
                Publish();
                return;
            }

            // AirPlay 2 realtime streams are decoded as ALAC and ignore the advertised
            // format, so that transport needs the uncompressed-access ("escape") encoder
            // instead of the classic compressed ALAC encoder.
            var encoder = connection is Ap2AudioConnection && _airPlay2EncoderFactory is not null
                ? _airPlay2EncoderFactory()
                : _encoderFactory();
            streamer = new AirPlayStreamer(encoder);
            streamer.Faulted += OnStreamerFaulted;
            streamer.ConnectionLost += OnConnectionLost;
            streamer.VolumePercent = Volatile.Read(ref _volumePercent);
            // The page starts tapping as soon as we enter "connecting" and keeps pushing in real
            // time while the handshake runs; that stale audio is roughly the handshake duration of
            // extra latency, so throw it away right before the streamer starts pulling.
            _audioTap.Reset();
            streamer.Start(new[] { new AirPlayConnectionTarget(device.Id, connection) }, _audioTap);
            connection = null; // owned by the streamer from here on

            lock (_gate)
            {
                if (!token.IsCancellationRequested && !_disposed)
                {
                    _streamer = streamer;
                    _state = AirPlayState.Streaming;
                    _actives.Clear();
                    _actives.Add((device.Id, device.Name, Volatile.Read(ref _volumePercent)));
                    _code = null;
                    _error = null;
                }
            }

            if (token.IsCancellationRequested || _disposed)
            {
                streamer.Dispose();
                return;
            }

            HostLog.Info($"[airplay] streaming started device={device.Name} volume={_volumePercent}");
            Publish();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            if (token.IsCancellationRequested || _disposed)
            {
                TryDispose(connection);
                streamer?.Dispose();
                return;
            }

            HostLog.Error("[airplay] connect failed", ex);
            try
            {
                TryDispose(connection);
                streamer?.Dispose();
            }
            catch
            {
                // ignored: already reporting the original failure
            }

            var (code, message) = MapError(ex);
            if (_streamer is { IsRunning: true })
            {
                // A second receiver failed to join while the first one keeps playing: restore the
                // streaming state (Connect published "connecting" for the add) and report a
                // transient error without tearing the working stream down.
                lock (_gate)
                {
                    if (_state == AirPlayState.Connecting)
                    {
                        _state = AirPlayState.Streaming;
                    }
                }
                SetTransientError(code, message);
            }
            else
            {
                SetError(code, message);
            }
        }
    }

    /// <summary>
    /// Picks the transport for a device: AirPlay 2 (HAP) when the receiver advertises it and a
    /// factory is wired up, otherwise the classic RAOP handshake. AirPlay 2 failures fall back so a
    /// device that merely advertises the bit but rejects pairing still works on the legacy path.
    /// </summary>
    private IAirPlayConnection ConnectTransport(AirPlayDeviceInfo device, RaopTarget target, RaopOptions options, CancellationToken token)
    {
        if (device.SupportsAirPlay2 && _airPlay2Factory is not null)
        {
            try
            {
                HostLog.Info("[airplay] trying airplay2 transport");
                var connection = _airPlay2Factory(target, options);
                if (connection is not null)
                {
                    return connection;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                if (token.IsCancellationRequested)
                {
                    throw;
                }

                HostLog.Warn($"[airplay] airplay2 transport failed: {ex.GetType().Name}: {ex.Message}");

                // macOS "AirPlay Receiver" rejects transient pairing with HTTP 470 and expects the
                // on-screen PIN instead. The PIN prompt must run inside the retry's pin provider:
                // /pair-pin-start (which makes the receiver display the code) happens just before
                // the provider is invoked, so asking earlier can show a code that is not on screen.
                if (_airPlay2PinFactory is not null && IsPairingRequiresPin(ex))
                {
                    try
                    {
                        HostLog.Info($"[airplay] retrying airplay2 transport with PIN device={device.Name}");
                        return _airPlay2PinFactory(target, options, _ => Task.FromResult(RequestPin(device, token)));
                    }
                    catch (Exception pinEx) when (pinEx is not OperationCanceledException)
                    {
                        if (token.IsCancellationRequested)
                        {
                            throw;
                        }
                        HostLog.Warn($"[airplay] airplay2 PIN retry failed: {pinEx.GetType().Name}: {pinEx.Message}");
                    }
                }

                HostLog.Warn("[airplay] falling back to RAOP transport");
            }
        }

        return RaopConnection.Connect(target, options);
    }

    private static void TryDispose(IAirPlayConnection? connection)
    {
        if (connection is null)
        {
            return;
        }

        try
        {
            connection.Dispose();
        }
        catch
        {
            // ignored: caller is already reporting the original failure
        }
    }

    private void OnConnectionLost(string deviceId, Exception exception)
    {
        var remaining = 0;
        lock (_gate)
        {
            _actives.RemoveAll(active => string.Equals(active.Id, deviceId, StringComparison.Ordinal));
            remaining = _actives.Count;
        }

        HostLog.Warn($"[airplay] device dropped from stream id={deviceId}: {exception.GetType().Name}: {exception.Message}");

        if (remaining == 0)
        {
            AirPlayStreamer? streamer;
            lock (_gate)
            {
                streamer = _streamer;
                _streamer = null;
                _actives.Clear();
            }

            // Network-level loss, not an internal bug: map to the documented "network" code.
            SetError("network", $"投送中断：{exception.Message}");
            if (streamer is not null)
            {
                _teardownTask = Task.Run(() => StopStreamer(streamer));
            }
            return;
        }

        SetTransientError("network", $"设备已断开：{exception.Message}");
    }

    private void OnStreamerFaulted(Exception exception)
    {
        AirPlayStreamer? streamer;
        lock (_gate)
        {
            streamer = _streamer;
            _streamer = null;
            _actives.Clear();
        }

        HostLog.Warn($"[airplay] stream ended: {exception.GetType().Name}: {exception.Message}");

        if (streamer is null)
        {
            // OnConnectionLost already finalized this session (e.g. last receiver dropped); do not
            // overwrite its network error with a generic internal one.
            return;
        }

        // Dispose from a worker: Stop() joins the capture thread (up to 3 s) and this handler runs
        // on the pump thread itself.
        _teardownTask = Task.Run(() => StopStreamer(streamer));
        SetError("internal", $"投送中断：{exception.Message}");
    }

    private void OnDevicesChanged(IReadOnlyList<AirPlayDeviceInfo> devices)
    {
        lock (_gate)
        {
            _devices = devices;
        }

        HostLog.Info($"[airplay] found {devices.Count} device(s)");
        Publish();
    }

    /// <summary>How long a macOS PIN prompt stays valid before the connect attempt fails.</summary>
    private const int PinTimeoutMilliseconds = 120_000;

    /// <summary>
    /// Feeds the on-screen PIN shown by a receiver that requires HAP PIN pairing (macOS
    /// "AirPlay Receiver"). Called from the host when the page submits the PIN field.
    /// </summary>
    public void ProvidePin(string? deviceId, string pin)
    {
        if (string.IsNullOrWhiteSpace(pin))
        {
            return;
        }

        string candidate = pin.Trim();
        // A malformed PIN would be sent to the receiver and consume one of its few attempts; reject
        // it locally so the pending waiter stays alive. HAP PINs are exactly four ASCII digits.
        if (candidate.Length != 4 || !candidate.All(char.IsAsciiDigit))
        {
            HostLog.Warn("[airplay] pin ignored: expected exactly 4 digits");
            return;
        }

        TaskCompletionSource<string>? waiter;
        lock (_gate)
        {
            waiter = _pinWaiter;
            if (_pinDeviceId is not null && !string.IsNullOrEmpty(deviceId)
                && !string.Equals(_pinDeviceId, deviceId, StringComparison.Ordinal))
            {
                HostLog.Warn($"[airplay] pin ignored: waiting for device {_pinDeviceId}, got {deviceId}");
                return;
            }

            _pinWaiter = null;
            _pinDeviceId = null;
        }

        if (waiter is null)
        {
            HostLog.Warn("[airplay] pin received but no pairing is waiting for it");
            return;
        }

        HostLog.Info($"[airplay] pin received device={deviceId ?? "(any)"}");
        waiter.TrySetResult(candidate);
    }

    /// <summary>Blocks the connect task until the page/host supplies the receiver's PIN.</summary>
    private string RequestPin(AirPlayDeviceInfo device, CancellationToken token)
    {
        var waiter = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_gate)
        {
            _pinWaiter = waiter;
            _pinDeviceId = device.Id;
            _state = AirPlayState.Connecting;
            _code = "pinRequired";
            _error = "请在 Mac 屏幕上查看配对码并输入";
        }

        HostLog.Info($"[airplay] pin required device={device.Name} hint=check the receiver screen");
        Publish();

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(PinTimeoutMilliseconds);
            return waiter.Task.WaitAsync(timeout.Token).GetAwaiter().GetResult();
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new TimeoutException($"等待配对码超时（{PinTimeoutMilliseconds / 1000} 秒），请重新连接。");
        }
        finally
        {
            lock (_gate)
            {
                if (ReferenceEquals(_pinWaiter, waiter))
                {
                    _pinWaiter = null;
                    _pinDeviceId = null;
                }
            }
        }
    }

    /// <summary>True when the failure means the receiver wants PIN pairing instead of transient.</summary>
    private static bool IsPairingRequiresPin(Exception exception)
    {
        var message = exception.Message;
        return message.Contains("470", StringComparison.Ordinal)
            || message.Contains("Authorization Required", StringComparison.OrdinalIgnoreCase)
            || message.Contains("pair-pin-start", StringComparison.OrdinalIgnoreCase)
            || message.Contains("PIN", StringComparison.Ordinal);
    }

    private void CancelConnect()
    {
        var cts = Interlocked.Exchange(ref _connectCts, null);

        TaskCompletionSource<string>? pinWaiter;
        lock (_gate)
        {
            pinWaiter = _pinWaiter;
            _pinWaiter = null;
            _pinDeviceId = null;
            _connectingDeviceId = null;
        }

        pinWaiter?.TrySetCanceled();

        if (cts is null)
        {
            WaitForConnectTask();
            return;
        }

        try
        {
            cts.Cancel();
            cts.Dispose();
        }
        catch (ObjectDisposedException)
        {
            // ignored: another caller already disposed it
        }

        WaitForConnectTask();
    }

    /// <summary>
    /// Waits a bounded time for the in-flight connect task to observe cancellation. Handshakes
    /// that ignore the token (RAOP fallback) are bounded by their own socket timeouts.
    /// </summary>
    private void WaitForConnectTask()
    {
        var task = _connectTask;
        if (task is null || task.IsCompleted || task.Id == Task.CurrentId)
        {
            return;
        }

        // CancelConnect runs on the UI thread (and from Disconnect). Blocking there for a handshake
        // that ignores its token freezes the window; observe completion in the background instead.
        // Dispose still does a bounded synchronous wait on the exit path.
        _ = task.ContinueWith(
            static completed =>
            {
                _ = completed.Exception; // mark observed; ConnectCore reports its own errors.
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    /// <summary>Publishes an error without leaving the streaming state (a second receiver failed).</summary>
    private void SetTransientError(string code, string message)
    {
        lock (_gate)
        {
            _code = code;
            _error = message;
        }

        HostLog.Warn($"[airplay] error code={code} message={message}");
        Publish();
    }

    private void SetError(string code, string message)
    {
        lock (_gate)
        {
            _state = AirPlayState.Error;
            _code = code;
            _error = message;
        }

        HostLog.Warn($"[airplay] error code={code} message={message}");
        Publish();
    }

    private AirPlayStatus SnapshotLocked()
    {
        AirPlayActiveDevice[] actives = _actives.Count == 0
            ? Array.Empty<AirPlayActiveDevice>()
            : _actives.Select(active => new AirPlayActiveDevice
            {
                Id = active.Id,
                Name = active.Name,
                VolumePercent = active.Volume,
            }).ToArray();

        return new AirPlayStatus
        {
            State = _state,
            Devices = _devices,
            Actives = actives,
            ActiveDeviceId = actives.Length > 0 ? actives[0].Id : null,
            ActiveDeviceName = actives.Length > 0 ? actives[0].Name : null,
            VolumePercent = _volumePercent,
            Code = _code,
            Error = _error,
        };
    }

    private void Publish()
    {
        AirPlayStatus status;
        lock (_gate)
        {
            status = SnapshotLocked();
        }

        var handler = StatusChanged;
        if (handler is null)
        {
            return;
        }

        try
        {
            handler(status);
        }
        catch (Exception ex)
        {
            HostLog.Warn($"[airplay] status handler failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    private static (string Code, string Message) MapError(Exception ex)
    {
        var text = ex.Message ?? string.Empty;
        if (ex is SocketException ||
            ex is IOException ||
            ex is TimeoutException ||
            text.Contains("timed out", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("timeout", StringComparison.OrdinalIgnoreCase))
        {
            return ("network", "连接设备失败，请检查网络与防火墙设置");
        }

        if (text.Contains("403", StringComparison.Ordinal) ||
            text.Contains("forbidden", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("AirPlay 2", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("pairing", StringComparison.OrdinalIgnoreCase))
        {
            return ("unsupported", "该设备需要 AirPlay 2 配对认证，当前版本暂不支持");
        }

        if (text.Contains("401", StringComparison.Ordinal) ||
            text.Contains("unauthorized", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("password", StringComparison.OrdinalIgnoreCase))
        {
            return ("passwordRequired", "该设备要求密码，请输入正确密码");
        }

        if (text.Contains("capture", StringComparison.OrdinalIgnoreCase))
        {
            return ("capture", "无法采集系统声音（没有可用的默认输出设备）");
        }

        return ("internal", string.IsNullOrWhiteSpace(text) ? "未知错误" : text);
    }
}
