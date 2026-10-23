using System.Diagnostics;
using System.IO;
using Zilux2.AirPlay.Protocol;
using Zilux2.Audio;

namespace Zilux2.AirPlay.Audio;

/// <summary>One receiver attached to an <see cref="AirPlayStreamer"/> (id is the UI device id).</summary>
internal readonly record struct AirPlayConnectionTarget(string DeviceId, IAirPlayConnection Connection);

/// <summary>
/// Owns one live AirPlay session: system loopback capture -> stereo resample to 44.1 kHz ->
/// 16-bit interleaved PCM -> encode (352 frames per packet) -> RTP send to one or more receivers.
/// <para>
/// Capture and sending run on two dedicated threads. The capture thread only fills an adaptive
/// PCM ring; the sender thread owns the RTP clock and emits exactly one packet every
/// 352/44100 s (≈8 ms), which is what AirPlay receivers expect. Bursts and gaps both cause
/// audible stutter, so the packet cadence here is deliberately independent of the (jittery)
/// WASAPI delivery schedule.
/// </para>
/// <para>
/// Multiple receivers share the same capture pipeline, encoder and packet timeline, so several
/// HomePods play the same audio with the same RTP timestamps (their clock anchoring is handled by
/// the transport layer). Each connection is fed the identical encoded payload and any connection
/// that keeps failing is dropped without stopping the others.
/// </para>
/// </summary>
internal sealed class AirPlayStreamer : IDisposable
{
    private const int Channels = 2;
    private const int FrameSamples = 352;
    private const int FramePcmSamples = FrameSamples * Channels;

    /// <summary>Consecutive send failures tolerated before a receiver is dropped (≈0.4 s).</summary>
    private const int MaxConsecutiveSendFailures = 50;

    /// <summary>Ring capacity in interleaved samples (≈4 s); older audio is dropped on overrun.</summary>
    private const int RingCapacitySamples = RaopConnection.SampleRate * Channels * 4;

    /// <summary>
    /// Steady-state ring water mark (interleaved samples, ≈120 ms). Small enough to keep the AirPlay
    /// delay low, large enough to absorb the page tap's block granularity and thread jitter.
    /// </summary>
    private const int TargetBufferedSamples = RaopConnection.SampleRate / 1000 * 120 * Channels;

    /// <summary>Hard ceiling: whenever the ring holds more than this (≈250 ms) it is trimmed back.</summary>
    private const int MaxBufferedSamples = RaopConnection.SampleRate / 1000 * 250 * Channels;

    private readonly RaopOptions _options;
    private readonly IAirPlayAudioEncoder _encoder;

    private readonly object _sync = new();
    private readonly List<ConnectionSlot> _connections = new();
    private IAirPlayAudioSource? _capture;
    private StereoResampler? _resampler;
    private PcmRing? _pcm;
    private CancellationTokenSource? _cts;
    private Thread? _captureThread;
    private Thread? _pump;
    private volatile bool _running;
    private int _volumePercent = 70;

    private long _framesSent;
    private long _captureReads;
    private long _captureTimeouts;
    private long _encodeFailures;
    private long _underruns;
    private long _trimmedSamples;

    public AirPlayStreamer(IAirPlayAudioEncoder encoder, RaopOptions? options = null)
    {
        _encoder = encoder ?? throw new ArgumentNullException(nameof(encoder));
        _options = options ?? new RaopOptions();
    }

    /// <summary>Raised from the pump thread when the whole session dies on its own.</summary>
    public event Action<Exception>? Faulted;

    /// <summary>Raised when a single receiver is dropped while the others keep streaming.</summary>
    public event Action<string, Exception>? ConnectionLost;

    public bool IsRunning => _running;

    public string TargetName
    {
        get
        {
            lock (_sync)
            {
                return _connections.Count == 0 ? string.Empty : _connections[0].Connection.TargetName;
            }
        }
    }

    public string TargetHost
    {
        get
        {
            lock (_sync)
            {
                return _connections.Count == 0 ? string.Empty : _connections[0].Connection.TargetHost;
            }
        }
    }

    /// <summary>Number of receivers currently attached.</summary>
    public int ConnectionCount
    {
        get { lock (_sync) return _connections.Count; }
    }

    public long FramesSent => Interlocked.Read(ref _framesSent);

    public long CaptureReads => Interlocked.Read(ref _captureReads);

    public long CaptureTimeouts => Interlocked.Read(ref _captureTimeouts);

    public long EncodeFailures => Interlocked.Read(ref _encodeFailures);

    /// <summary>Packets that had to be padded with silence because capture fell behind.</summary>
    public long Underruns => Interlocked.Read(ref _underruns);

    /// <summary>Samples dropped by the latency trim (keeps the ring near the target water mark).</summary>
    public long TrimmedSamples => Interlocked.Read(ref _trimmedSamples);

    public int VolumePercent
    {
        get => Volatile.Read(ref _volumePercent);
        set
        {
            var percent = Math.Clamp(value, 0, 100);
            Volatile.Write(ref _volumePercent, percent);
            lock (_sync)
            {
                foreach (var slot in _connections)
                {
                    try { slot.Connection.SetVolume(percent); }
                    catch (Exception ex) { HostLog.Warn($"[airplay] volume failed for {slot.DeviceId}: {ex.GetType().Name}: {ex.Message}"); }
                }
            }
        }
    }

    /// <summary>
    /// Sets the volume of one attached receiver only: other receivers keep their own level.
    /// Returns false when the device is not attached (or the receiver rejected the command).
    /// </summary>
    public bool SetDeviceVolume(string deviceId, int percent)
    {
        if (string.IsNullOrEmpty(deviceId))
        {
            return false;
        }

        percent = Math.Clamp(percent, 0, 100);
        lock (_sync)
        {
            var slot = _connections.FirstOrDefault(entry => string.Equals(entry.DeviceId, deviceId, StringComparison.Ordinal));
            if (slot is null)
            {
                return false;
            }

            try
            {
                slot.Connection.SetVolume(percent);
                return true;
            }
            catch (Exception ex)
            {
                HostLog.Warn($"[airplay] volume failed for {slot.DeviceId}: {ex.GetType().Name}: {ex.Message}");
                return false;
            }
        }
    }

    /// <summary>
    /// Starts the pump on an already-connected transport and streams immediately. Throws on any
    /// handshake or capture failure; on success the stream runs until <see cref="Stop"/> or a fault.
    /// The streamer takes ownership of <paramref name="connection"/>.
    /// </summary>
    public void Start(IAirPlayConnection connection)
    {
        ArgumentNullException.ThrowIfNull(connection);
        Start(new[] { new AirPlayConnectionTarget(connection.TargetName, connection) });
    }

    /// <summary>
    /// Starts the pump on one or more already-connected transports and streams immediately.
    /// All transports share the capture pipeline, encoder and packet clock. The streamer takes
    /// ownership of every connection.
    /// </summary>
    public void Start(IReadOnlyList<AirPlayConnectionTarget> connections) => Start(connections, null);

    /// <summary>
    /// Same as <see cref="Start(IReadOnlyList{AirPlayConnectionTarget})"/>, but lets the caller
    /// supply the PCM source. With <paramref name="audioSource"/> null the system output is captured
    /// (classic behaviour); when the page taps its own audio graph, only this app's sound is
    /// streamed. The streamer owns the connections but never disposes the supplied source.
    /// </summary>
    public void Start(IReadOnlyList<AirPlayConnectionTarget> connections, IAirPlayAudioSource? audioSource)
    {
        if (_running) throw new InvalidOperationException("AirPlay streamer is already running.");
        ArgumentNullException.ThrowIfNull(connections);
        if (connections.Count == 0) throw new ArgumentException("At least one connection is required.", nameof(connections));

        var ownsSource = audioSource is null;
        IAirPlayAudioSource capture;
        if (ownsSource)
        {
            var loopback = new LoopbackCapture();
            if (!loopback.TryStart())
            {
                var reason = loopback.LastError ?? "loopback capture unavailable";
                loopback.Dispose();
                foreach (var target in connections) target.Connection.Dispose();
                throw new RaopException($"capture unavailable: {reason}");
            }

            capture = loopback;
        }
        else
        {
            capture = audioSource!;
        }

        // A loopback endpoint that idles is compensated with silence chunks; a page tap delivers
        // audio in real time and the sender pads underruns, so writing silence there would only
        // smear gaps into the music.
        var silenceOnIdle = ownsSource;
        var started = new List<IAirPlayConnection>();
        try
        {
            var resampler = new StereoResampler(capture.SampleRate, RaopConnection.SampleRate);
            foreach (var target in connections)
            {
                target.Connection.BeginStreaming();
                target.Connection.SetVolume(Volatile.Read(ref _volumePercent));
                started.Add(target.Connection);
            }

            lock (_sync)
            {
                _connections.Clear();
                foreach (var target in connections)
                {
                    _connections.Add(new ConnectionSlot(target.DeviceId, target.Connection));
                }

                _capture = capture;
                _resampler = resampler;
                _pcm = new PcmRing(RingCapacitySamples);
                _cts = new CancellationTokenSource();
                _running = true;
                Interlocked.Exchange(ref _framesSent, 0);
                Interlocked.Exchange(ref _captureReads, 0);
                Interlocked.Exchange(ref _captureTimeouts, 0);
                Interlocked.Exchange(ref _encodeFailures, 0);
                Interlocked.Exchange(ref _underruns, 0);
                Interlocked.Exchange(ref _trimmedSamples, 0);

                var token = _cts.Token;
                var ring = _pcm;
                var captureThread = new Thread(() => CaptureLoop(capture, silenceOnIdle, resampler, ring, token))
                {
                    IsBackground = true,
                    Name = "airplay-capture",
                    Priority = ThreadPriority.AboveNormal,
                };
                var pump = new Thread(() => SendLoop(ring, token))
                {
                    IsBackground = true,
                    Name = "airplay-pump",
                    Priority = ThreadPriority.Highest,
                };
                _captureThread = captureThread;
                _pump = pump;
                captureThread.Start();
                pump.Start();
            }

            HostLog.Info($"[airplay] streaming started targets={string.Join(", ", connections.Select(c => c.Connection.TargetName))} capture={capture.SampleRate}Hz/{capture.Channels}ch");
        }
        catch
        {
            foreach (var connection in started) TryDispose(connection);
            if (ownsSource) capture.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Attaches another already-connected transport to the running session. The new receiver joins
    /// the shared capture pipeline and packet timeline; it is owned by the streamer from then on.
    /// </summary>
    public void AddConnection(string deviceId, IAirPlayConnection connection)
    {
        ArgumentNullException.ThrowIfNull(connection);
        if (!_running) throw new InvalidOperationException("AirPlay streamer is not running.");

        try
        {
            connection.BeginStreaming();
            connection.SetVolume(Volatile.Read(ref _volumePercent));

            lock (_sync)
            {
                if (_connections.Any(slot => slot.Connection == connection))
                {
                    return;
                }

                _connections.Add(new ConnectionSlot(deviceId, connection));
            }

            HostLog.Info($"[airplay] receiver attached device={connection.TargetName} host={connection.TargetHost} receivers={ConnectionCount}");
        }
        catch
        {
            TryDispose(connection);
            throw;
        }
    }

    /// <summary>Detaches and tears down one receiver, leaving the others streaming.</summary>
    public void RemoveConnection(string deviceId, bool teardown = true)    {
        ConnectionSlot? removed = null;
        lock (_sync)
        {
            var index = _connections.FindIndex(slot => string.Equals(slot.DeviceId, deviceId, StringComparison.Ordinal));
            if (index >= 0)
            {
                removed = _connections[index];
                _connections.RemoveAt(index);
            }
        }

        if (removed is null) return;
        CloseSlot(removed, teardown);
        HostLog.Info($"[airplay] receiver detached device={removed.DeviceId} receivers={ConnectionCount}");
    }

    /// <summary>Stops streaming and tears every RAOP session down. Safe to call multiple times.</summary>
    public void Stop()
    {
        Thread? pump;
        Thread? captureThread;
        IAirPlayAudioSource? capture;
        ConnectionSlot[] connections;
        CancellationTokenSource? cts;

        lock (_sync)
        {
            if (!_running && _pump is null) return;
            _running = false;
            cts = _cts;
            pump = _pump;
            captureThread = _captureThread;
            capture = _capture;
            connections = _connections.ToArray();
            _connections.Clear();
            _cts = null;
            _pump = null;
            _captureThread = null;
            _capture = null;
            _resampler = null;
            _pcm = null;
        }

        cts?.Cancel();
        JoinThread(pump);
        JoinThread(captureThread);

        cts?.Dispose();
        capture?.Dispose();

        foreach (var slot in connections)
        {
            CloseSlot(slot, teardown: true);
        }

        HostLog.Info("[airplay] streaming stopped");
    }

    public void Dispose() => Stop();

    private static void JoinThread(Thread? thread)
    {
        if (thread is null || thread == Thread.CurrentThread) return;
        try { thread.Join(TimeSpan.FromSeconds(3)); }
        catch (Exception ex) { HostLog.Warn($"[airplay] thread join failed: {ex.GetType().Name}: {ex.Message}"); }
    }

    private static void CloseSlot(ConnectionSlot slot, bool teardown)
    {
        if (teardown)
        {
            try { slot.Connection.Teardown(); }
            catch (Exception ex) { HostLog.Warn($"[airplay] teardown failed: {ex.GetType().Name}: {ex.Message}"); }
        }

        TryDispose(slot.Connection);
    }

    private static void TryDispose(IAirPlayConnection connection)
    {
        try { connection.Dispose(); }
        catch (Exception ex) { HostLog.Warn($"[airplay] connection dispose failed: {ex.GetType().Name}: {ex.Message}"); }
    }

    /// <summary>Reads the audio source (system loopback or the page's PCM tap) and feeds the ring.</summary>
    private void CaptureLoop(IAirPlayAudioSource capture, bool silenceOnIdle, StereoResampler resampler, PcmRing ring, CancellationToken token)
    {
        var sourceRate = capture.SampleRate;
        var chunkFrames = Math.Max(256, sourceRate / 50); // ~20 ms of input audio
        var captureBuffer = new float[(chunkFrames + 64) * Channels];
        var outputFrames = (int)((chunkFrames + 64L) * RaopConnection.SampleRate / sourceRate) + 64;
        var resampled = new float[(outputFrames + 64) * Channels];
        var shorts = new short[(outputFrames + 64) * Channels];
        var lastTrimLogAt = 0L;

        try
        {
            while (!token.IsCancellationRequested)
            {
                int floatCount;
                if (capture.WaitForData(20))
                {
                    Interlocked.Increment(ref _captureReads);
                    floatCount = capture.ReadInterleaved(captureBuffer);
                }
                else if (silenceOnIdle)
                {
                    // Nothing is playing on the endpoint: keep the clock alive with silence so the
                    // receiver keeps its buffer primed instead of going idle mid-session.
                    Interlocked.Increment(ref _captureTimeouts);
                    floatCount = chunkFrames * Channels;
                    Array.Clear(captureBuffer, 0, floatCount);
                }
                else
                {
                    // Page tap: the sender pads underruns with silence, so waiting is enough.
                    Interlocked.Increment(ref _captureTimeouts);
                    continue;
                }

                if (floatCount <= 0) continue;

                var producedFrames = resampler.Process(captureBuffer, floatCount / Channels, resampled);
                if (producedFrames <= 0) continue;

                var sampleCount = producedFrames * Channels;
                for (var i = 0; i < sampleCount; i++)
                {
                    var sample = resampled[i] * 32767f;
                    shorts[i] = (short)Math.Clamp((int)MathF.Round(sample), short.MinValue, short.MaxValue);
                }

                ring.Write(shorts.AsSpan(0, sampleCount));

                // Keep the pipeline near real time: if a burst (main-thread stall, handshake
                // backlog) pushes the ring above the ceiling, drop the oldest audio back down to
                // the target instead of turning it into permanent AirPlay delay.
                var buffered = ring.Count;
                if (buffered > MaxBufferedSamples)
                {
                    var dropped = ring.Discard(buffered - TargetBufferedSamples);
                    if (dropped > 0)
                    {
                        Interlocked.Add(ref _trimmedSamples, dropped);
                        if (lastTrimLogAt == 0 || Stopwatch.GetTimestamp() - lastTrimLogAt > Stopwatch.Frequency * 2)
                        {
                            lastTrimLogAt = Stopwatch.GetTimestamp();
                            HostLog.Info($"[airplay] latency trim dropped={dropped / Channels} frames, buffered≈{(buffered - dropped) / Channels * 1000.0 / RaopConnection.SampleRate:F0}ms");
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            if (!token.IsCancellationRequested)
            {
                HostLog.Error("[airplay] capture failed", ex);
                Faulted?.Invoke(ex);
            }
        }
    }

    /// <summary>
    /// Emits exactly one packet per 352/44100 s to every attached receiver, padded with silence on
    /// underrun. The deadline is absolute (start + index * packetDuration) so the average rate can
    /// never drift.
    /// </summary>
    private void SendLoop(PcmRing ring, CancellationToken token)
    {
        var pcmFrame = new short[FramePcmSamples];
        var payloadBuffer = new byte[Math.Max(_encoder.MaxPacketBytes, 1428) + 16];
        var startTicks = Stopwatch.GetTimestamp();
        var packetTicks = (double)FrameSamples / RaopConnection.SampleRate * Stopwatch.Frequency;
        var loggedFirstPacket = false;
        var lastStatsFrame = 0L;
        long index = 0;

        // Whatever piled up during the handshake is stale audio; start the timeline at the target
        // water mark instead of playing it half a second later.
        var stale = ring.Count;
        if (stale > TargetBufferedSamples)
        {
            var dropped = ring.Discard(stale - TargetBufferedSamples);
            if (dropped > 0)
            {
                Interlocked.Add(ref _trimmedSamples, dropped);
                HostLog.Info($"[airplay] latency trim at start dropped={dropped / Channels} frames (buffered≈{TargetBufferedSamples / Channels * 1000.0 / RaopConnection.SampleRate:F0}ms)");
            }
        }

        try
        {
            while (!token.IsCancellationRequested)
            {
                var deadline = startTicks + (long)(index * packetTicks);
                WaitUntil(deadline, token);

                ConnectionSlot[] targets;
                lock (_sync)
                {
                    if (_connections.Count == 0) break;
                    targets = _connections.ToArray();
                }

                if (ring.Fill(pcmFrame) < pcmFrame.Length)
                {
                    Interlocked.Increment(ref _underruns);
                }

                var encoded = 0;
                try
                {
                    encoded = _encoder.Encode(pcmFrame, payloadBuffer);
                }
                catch (Exception ex)
                {
                    Interlocked.Increment(ref _encodeFailures);
                    HostLog.Warn($"[airplay] encode failed: {ex.GetType().Name}: {ex.Message}");
                }

                if (encoded > 0)
                {
                    if (!loggedFirstPacket)
                    {
                        loggedFirstPacket = true;
                        HostLog.Info($"[airplay] first packet bytes={encoded} rms={ComputeRms(pcmFrame):F1} receivers={targets.Length}");
                    }

                    var payload = new ReadOnlySpan<byte>(payloadBuffer, 0, encoded);
                    var delivered = false;
                    var failures = new List<(ConnectionSlot Slot, Exception Error)>();
                    foreach (var slot in targets)
                    {
                        try
                        {
                            if (slot.Connection.SendAudioFrame(payload))
                            {
                                delivered = true;
                                slot.ConsecutiveFailures = 0;
                            }
                            else
                            {
                                slot.ConsecutiveFailures++;
                            }
                        }
                        catch (Exception ex)
                        {
                            slot.ConsecutiveFailures++;
                            if (slot.ConsecutiveFailures >= MaxConsecutiveSendFailures)
                            {
                                failures.Add((slot, ex));
                            }
                        }
                    }

                    if (failures.Count > 0)
                    {
                        DropFailedReceivers(failures);
                    }

                    if (delivered)
                    {
                        var sent = Interlocked.Increment(ref _framesSent);
                        if (sent - lastStatsFrame >= 500)
                        {
                            lastStatsFrame = sent;
                            HostLog.Info(
                                $"[airplay] pump frames={sent} receivers={targets.Length} reads={CaptureReads} " +
                                $"timeouts={CaptureTimeouts} underruns={Underruns} " +
                                $"encodeFailures={EncodeFailures} trimmed={TrimmedSamples} buffered={ring.Count}");
                        }
                    }
                }

                index++;
            }
        }
        catch (Exception ex)
        {
            if (!token.IsCancellationRequested)
            {
                HostLog.Error("[airplay] pump failed", ex);
                Faulted?.Invoke(ex);
            }
        }
        finally
        {
            lock (_sync) { _running = false; }
        }
    }

    /// <summary>
    /// Removes receivers whose transport keeps throwing. The remaining receivers keep playing; if
    /// none are left the whole session is reported as faulted.
    /// </summary>
    private void DropFailedReceivers(List<(ConnectionSlot Slot, Exception Error)> failures)
    {
        var remaining = 0;
        var lost = new List<(string DeviceId, Exception Error)>();
        lock (_sync)
        {
            foreach (var (slot, error) in failures)
            {
                if (_connections.Remove(slot))
                {
                    lost.Add((slot.DeviceId, error));
                }
            }

            remaining = _connections.Count;
        }

        foreach (var (deviceId, error) in lost)
        {
            HostLog.Warn($"[airplay] receiver dropped device={deviceId}: {error.GetType().Name}: {error.Message}");
            CloseSlot(failures.First(f => f.Slot.DeviceId == deviceId).Slot, teardown: false);
            try { ConnectionLost?.Invoke(deviceId, error); }
            catch (Exception ex) { HostLog.Warn($"[airplay] connection-lost handler failed: {ex.GetType().Name}: {ex.Message}"); }
        }

        if (remaining == 0)
        {
            var reason = lost.Count > 0 ? lost[0].Error : new IOException("all receivers stopped accepting audio");
            Faulted?.Invoke(reason);
        }
    }

    private static void WaitUntil(long deadlineTimestamp, CancellationToken token)
    {
        while (true)
        {
            if (token.IsCancellationRequested) return;
            var remainingTicks = deadlineTimestamp - Stopwatch.GetTimestamp();
            if (remainingTicks <= 0) return;

            var remainingMs = remainingTicks * 1000.0 / Stopwatch.Frequency;
            if (remainingMs > 2)
            {
                // Leave ~1 ms of slack so the next spin lands on the deadline instead of after it.
                Thread.Sleep((int)(remainingMs - 1));
            }
            else
            {
                Thread.SpinWait(64);
            }
        }
    }

    private static double ComputeRms(short[] samples)
    {
        if (samples.Length == 0) return 0;
        var sum = 0.0;
        for (var i = 0; i < samples.Length; i++)
        {
            double value = samples[i];
            sum += value * value;
        }

        return Math.Sqrt(sum / samples.Length);
    }

    private sealed class ConnectionSlot(string deviceId, IAirPlayConnection connection)
    {
        public string DeviceId { get; } = deviceId;

        public IAirPlayConnection Connection { get; } = connection;

        public int ConsecutiveFailures { get; set; }
    }

    /// <summary>Fixed-capacity interleaved PCM ring shared by the capture and send threads.</summary>
    private sealed class PcmRing
    {
        private readonly short[] _buffer;
        private readonly object _gate = new();
        private int _read;
        private int _write;
        private int _count;

        public PcmRing(int capacitySamples)
        {
            _buffer = new short[Math.Max(capacitySamples, FramePcmSamples * 4)];
        }

        /// <summary>Queued sample count (interleaved).</summary>
        public int Count
        {
            get { lock (_gate) return _count; }
        }

        public void Write(ReadOnlySpan<short> samples)
        {
            lock (_gate)
            {
                foreach (var sample in samples)
                {
                    if (_count == _buffer.Length)
                    {
                        // Overrun: drop the oldest sample so the sender stays close to real time.
                        _read = (_read + 1) % _buffer.Length;
                        _count--;
                    }

                    _buffer[_write] = sample;
                    _write = (_write + 1) % _buffer.Length;
                    _count++;
                }
            }
        }

        /// <summary>Drops up to <paramref name="samples"/> queued samples (oldest first).</summary>
        public int Discard(int samples)
        {
            lock (_gate)
            {
                var drop = Math.Min(Math.Max(samples, 0), _count);
                if (drop <= 0)
                {
                    return 0;
                }

                _read = (_read + drop) % _buffer.Length;
                _count -= drop;
                return drop;
            }
        }

        /// <summary>Copies up to <paramref name="destination"/> samples, zero-filling the rest.</summary>
        public int Fill(Span<short> destination)
        {
            lock (_gate)
            {
                var take = Math.Min(destination.Length, _count);
                for (var i = 0; i < take; i++)
                {
                    destination[i] = _buffer[_read];
                    _read = (_read + 1) % _buffer.Length;
                }

                _count -= take;
                if (take < destination.Length)
                {
                    destination[take..].Clear();
                }

                return take;
            }
        }
    }
}
