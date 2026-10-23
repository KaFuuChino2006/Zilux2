using System.Diagnostics;
using Zilux2.Settings;

namespace Zilux2.Audio;

/// <summary>
/// Owns the capture thread that feeds <see cref="AudioAnalyzer"/> and publishes 30 Hz frames to
/// a single sink (the WebView host). Capture failures are non-fatal: the thread keeps retrying,
/// so unplugging the default device never takes the app down.
/// </summary>
internal sealed class AudioFeatureService : IDisposable
{
    internal const int DefaultFrameRate = 30;
    internal const int MinFrameRate = 20;
    internal const int MaxFrameRate = 60;

    /// <summary>Test hook used by tools to exercise the no-device fallback.</summary>
    internal const string DisableEnvironmentVariable = "ZILUX2_AUDIO_DISABLE";

    private const int RetryMilliseconds = 5000;
    private const int ScratchSamples = 16384;

    private readonly SettingsService? _settings;
    private readonly int _frameRate;
    private readonly int _frameIntervalMilliseconds;
    private readonly float[] _scratch = new float[ScratchSamples];

    private Thread? _thread;
    private LoopbackCapture? _capture;
    private Action<AudioFrameSnapshot>? _sink;
    private volatile bool _stopRequested;
    private volatile bool _paused;
    private volatile bool _disposed;
    private volatile bool _disabledLogged;
    private string? _lastFailure;
    private long _frameCount;

    internal AudioFeatureService(SettingsService? settings, int frameRate = DefaultFrameRate)
    {
        _settings = settings;
        _frameRate = Math.Clamp(frameRate, MinFrameRate, MaxFrameRate);
        _frameIntervalMilliseconds = Math.Max(1, 1000 / _frameRate);
    }

    /// <summary>Frames produced on the capture thread. Assign from the UI thread only.</summary>
    internal void SetSink(Action<AudioFrameSnapshot>? sink) => _sink = sink;

    /// <summary>Window visibility gate: while minimized the host stops producing frames.</summary>
    internal void SetPaused(bool paused)
    {
        if (_paused == paused)
        {
            return;
        }

        _paused = paused;
        HostLog.Info(paused ? "[audio] paused (window not visible)" : "[audio] resumed");
    }

    internal void Start()
    {
        if (_disposed || _thread is not null)
        {
            return;
        }

        _thread = new Thread(Run)
        {
            IsBackground = true,
            Name = "Zilux2-Audio",
            Priority = ThreadPriority.BelowNormal,
        };
        _thread.Start();
        HostLog.Info($"[audio] service started frameRate={_frameRate}");
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _stopRequested = true;
        try
        {
            _thread?.Join(2000);
        }
        catch (Exception exception)
        {
            HostLog.Error("[audio] thread join failed", exception);
        }

        _thread = null;
        StopCapture("service disposed");
        _sink = null;
        HostLog.Info($"[audio] disposed frames={_frameCount}");
    }

    private void Run()
    {
        var analyzer = new AudioAnalyzer();
        var stopwatch = Stopwatch.StartNew();
        var nextFrameAt = 0L;

        try
        {
            while (!_stopRequested)
            {
                var enabled = _settings?.AudioReactive ?? true;
                if (!enabled || _paused)
                {
                    if (!enabled && !_disabledLogged)
                    {
                        _disabledLogged = true;
                        HostLog.Info("[audio] disabled by settings playback.audioReactive=false");
                    }

                    StopCapture(_paused ? "window not visible" : "settings disabled");
                    Thread.Sleep(250);
                    continue;
                }

                if (_capture is null && !TryStartCapture(analyzer))
                {
                    Thread.Sleep(RetryMilliseconds);
                    continue;
                }

                var capture = _capture;
                if (capture is null)
                {
                    continue;
                }

                try
                {
                    var samples = capture.Read(_scratch);
                    if (samples > 0)
                    {
                        analyzer.Push(_scratch, samples);
                    }
                }
                catch (Exception exception)
                {
                    HostLog.Error("[audio] capture read failed", exception);
                    StopCapture("read failed");
                    Thread.Sleep(3000);
                    continue;
                }

                var now = stopwatch.ElapsedMilliseconds;
                if (now >= nextFrameAt)
                {
                    var frame = analyzer.Analyze();
                    nextFrameAt = now + _frameIntervalMilliseconds;
                    _frameCount++;
                    Publish(frame);
                }
                else
                {
                    var wait = (int)Math.Clamp(nextFrameAt - now, 1, 10);
                    capture.WaitForData(wait);
                }
            }
        }
        catch (Exception exception)
        {
            HostLog.Error("[audio] capture loop failed", exception);
        }
        finally
        {
            StopCapture("service stopped");
            HostLog.Info("[audio] service stopped");
        }
    }

    private bool TryStartCapture(AudioAnalyzer analyzer)
    {
        if (string.Equals(Environment.GetEnvironmentVariable(DisableEnvironmentVariable), "1", StringComparison.Ordinal))
        {
            LogFailureOnce("disabled by " + DisableEnvironmentVariable);
            return false;
        }

        var capture = new LoopbackCapture();
        if (!capture.TryStart())
        {
            LogFailureOnce(capture.LastError ?? "unknown error");
            capture.Dispose();
            return false;
        }

        _capture = capture;
        _lastFailure = null;
        analyzer.SampleRate = capture.SampleRate;
        analyzer.Reset();
        HostLog.Info(
            $"[audio] loopback started rate={capture.SampleRate} channels={capture.Channels} " +
            $"bits={capture.BitsPerSample} float={capture.IsFloat}");
        return true;
    }

    private void LogFailureOnce(string failure)
    {
        if (string.Equals(_lastFailure, failure, StringComparison.Ordinal))
        {
            return;
        }

        _lastFailure = failure;
        HostLog.Warn($"[audio] loopback unavailable: {failure} (retrying every {RetryMilliseconds} ms)");
    }

    private void StopCapture(string reason)
    {
        var capture = _capture;
        if (capture is null)
        {
            return;
        }

        _capture = null;
        try
        {
            capture.Dispose();
            HostLog.Info($"[audio] loopback stopped reason={reason}");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[audio] loopback stop failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private void Publish(AudioFrameSnapshot frame)
    {
        var sink = _sink;
        if (sink is null)
        {
            return;
        }

        try
        {
            // Runs on the capture thread; the consumer serializes the borrowed arrays immediately.
            sink(frame);
        }
        catch (Exception exception)
        {
            HostLog.Error("[audio] frame sink failed", exception);
        }
    }
}
