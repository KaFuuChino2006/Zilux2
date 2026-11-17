using System.IO;
using Zilux2.Wallpaper.Model;

namespace Zilux2.Wallpaper.Media;

/// <summary>
/// 一路播放：持有 ffmpeg 帧源，在后台线程按目标帧率取帧并交给呈现层。
/// 帧回调在解码线程触发，呈现层自己负责切回 UI 线程（通常是「只存最新帧」）。
/// 暂停时不读帧（子进程会自己阻塞在管道上，CPU 归零）。
/// </summary>
internal sealed class WallpaperPlayer : IDisposable
{
    private readonly object _gate = new();
    private readonly ManualResetEventSlim _resume = new(true);
    private Thread? _thread;
    private FfmpegVideoSource? _source;
    private CancellationTokenSource? _cancellation;
    private volatile bool _paused;
    private volatile bool _disposed;

    /// <summary>一帧 BGRA 数据（缓冲区在下次回调前有效，消费方应立即拷贝或写位图）。</summary>
    public event Action<ReadOnlyMemory<byte>, int, int>? FrameReady;

    /// <summary>解码结束（片尾且不循环 / 进程挂掉）。</summary>
    public event Action<VideoOpenFailure>? Ended;

    public bool IsRunning
    {
        get
        {
            lock (_gate) return _thread is { IsAlive: true };
        }
    }

    /// <summary>开始播放。失败返回 false 并给出原因。</summary>
    public bool Play(
        WallpaperAsset asset,
        int width,
        int height,
        int fps,
        bool loop,
        bool hardwareDecode,
        out VideoOpenFailure failure)
    {
        Stop();

        if (asset.Kind != AssetKind.Video)
        {
            failure = VideoOpenFailure.FileMissing;
            return false;
        }

        var source = FfmpegVideoSource.Open(
            asset.Path, width, height, fps,
            asset.TrimInMs, asset.TrimOutMs, asset.Speed, loop, hardwareDecode, out failure);

        if (source is null) return false;

        var cancellation = new CancellationTokenSource();
        lock (_gate)
        {
            _source = source;
            _cancellation = cancellation;
            _paused = false;
            _resume.Set();
            _thread = new Thread(() => Pump(source, fps, cancellation.Token))
            {
                IsBackground = true,
                Name = "wallpaper-decode",
            };
            _thread.Start();
        }

        return true;
    }

    private void Pump(FfmpegVideoSource source, int fps, CancellationToken token)
    {
        var frameInterval = TimeSpan.FromSeconds(1.0 / Math.Clamp(fps, 1, 240));
        var nextFrame = DateTime.UtcNow;

        // 整个循环必须吞掉取消/释放类异常：Stop() 会 Cancel+清理，解码线程可能正好停在
        // token.WaitHandle / _resume.Wait(token) 上。异常一旦逃出线程，就是
        // "unhandled.appdomain" → 整个进程崩（第 2026-11-15 /media 大文件传输时踩到）。
        try
        {
            while (!token.IsCancellationRequested && !_disposed)
            {
                _resume.Wait(token);
                if (token.IsCancellationRequested || _disposed) break;

                if (!source.TryReadFrame(out var frame))
                {
                    if (!token.IsCancellationRequested && !_disposed)
                    {
                        Ended?.Invoke(VideoOpenFailure.None);
                    }
                    return;
                }

                FrameReady?.Invoke(frame, source.Width, source.Height);

                // 用绝对时间表推帧，避免累积漂移；落后太多就不睡，尽快追上。
                nextFrame += frameInterval;
                var delay = nextFrame - DateTime.UtcNow;
                if (delay > TimeSpan.Zero)
                {
                    token.WaitHandle.WaitOne(delay);
                }
                else if (delay < -frameInterval * 3)
                {
                    nextFrame = DateTime.UtcNow;
                }
            }
        }
        catch (ObjectDisposedException)
        {
            // 播放对象已停止并清理，正常收尾。
        }
        catch (OperationCanceledException)
        {
            // 取消。
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[wallpaper] decode pump failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>暂停：停止取帧，子进程因管满而自然阻塞。</summary>
    public void Pause()
    {
        _paused = true;
        _resume.Reset();
    }

    public void Resume()
    {
        _paused = false;
        _resume.Set();
    }

    public bool IsPaused => _paused;

    /// <summary>停掉当前播放（可重入）。</summary>
    public void Stop()
    {
        CancellationTokenSource? cancellation;
        FfmpegVideoSource? source;
        Thread? thread;

        lock (_gate)
        {
            cancellation = _cancellation;
            source = _source;
            thread = _thread;
            _cancellation = null;
            _source = null;
            _thread = null;
        }

        _resume.Set();
        try { cancellation?.Cancel(); } catch (ObjectDisposedException) { }
        // 不 Dispose CancellationTokenSource：解码线程可能正停在 token.WaitHandle 上，
        // Dispose 会让它抛 ObjectDisposedException。取消源没有计时器，交给 GC 即可。

        source?.Dispose();

        if (thread is { IsAlive: true } && thread != Thread.CurrentThread)
        {
            thread.Join(600);
        }

        _resume.Set();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Stop();
        _resume.Dispose();
    }
}
