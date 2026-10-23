using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace Zilux2.Local;

/// <summary>一次去抖合并后的目录变化批次（由 FileSystemWatcher 线程池事件汇总而来）。</summary>
internal sealed class LocalWatchBatch
{
    /// <summary>被监听的根目录（完整路径，已去掉结尾分隔符）。</summary>
    public string Folder { get; init; } = string.Empty;

    /// <summary>本批次出现过的路径（文件或目录的完整路径，可能包含已不存在的路径）。</summary>
    public List<string> Paths { get; init; } = new();

    /// <summary>出现过目录级变化（新建/改名/删除目录），建议整体重扫。</summary>
    public bool Structural { get; init; }

    /// <summary>FileSystemWatcher 缓冲区溢出，事件可能丢失，必须整体重扫。</summary>
    public bool Overflow { get; init; }

    /// <summary>本批次累计的原始事件数（用于日志）。</summary>
    public int RawEvents { get; init; }

    public bool IsEmpty => Paths.Count == 0 && !Structural && !Overflow;
}

/// <summary>
/// 监听一个本地音乐文件夹（递归）。FileSystemWatcher 的每个事件只入队，再由单个定时器把
/// 1.3 秒内的变化合并成一批回调出去；出错（缓冲区溢出/目录被删）时先报错再退避重建监听。
/// 所有回调都在线程池线程上，绝不直接碰 UI。
/// </summary>
internal sealed class LocalFolderWatcher : IDisposable
{
    private const int DefaultDebounceMs = 1300;
    private const int InitialRestartDelayMs = 2000;
    private const int MaxRestartDelayMs = 30000;
    private const int InternalBufferBytes = 64 * 1024;

    private readonly Action<LocalWatchBatch> _onBatch;
    private readonly int _debounceMs;
    private readonly object _gate = new();
    private readonly HashSet<string> _pending = new(StringComparer.OrdinalIgnoreCase);
    private FileSystemWatcher? _watcher;
    private System.Threading.Timer? _debounce;
    private System.Threading.Timer? _restart;
    private string _folder = string.Empty;
    private int _rawEvents;
    private bool _structural;
    private bool _overflow;
    private bool _restartPending;
    private int _restartDelayMs = InitialRestartDelayMs;
    private bool _running;
    private volatile bool _disposed;

    public LocalFolderWatcher(Action<LocalWatchBatch> onBatch, int debounceMs = DefaultDebounceMs)
    {
        _onBatch = onBatch ?? throw new ArgumentNullException(nameof(onBatch));
        _debounceMs = Math.Clamp(debounceMs, 200, 10000);
    }

    /// <summary>当前监听的根目录（未启动时为空）。</summary>
    public string Folder
    {
        get
        {
            lock (_gate)
            {
                return _folder;
            }
        }
    }

    /// <summary>开始监听；同一目录重复调用是幂等的，换目录会先停掉旧监听。</summary>
    public void Start(string folder)
    {
        if (_disposed || string.IsNullOrWhiteSpace(folder))
        {
            return;
        }

        string fullPath;
        try
        {
            fullPath = Path.TrimEndingDirectorySeparator(Path.GetFullPath(folder));
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] watch start failed: invalid path \"{folder}\": {exception.Message}");
            return;
        }

        if (!Directory.Exists(fullPath))
        {
            HostLog.Warn($"[local] watch start skipped: folder missing {fullPath}");
            return;
        }

        lock (_gate)
        {
            if (_running && _watcher is not null && !_restartPending
                && string.Equals(_folder, fullPath, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
        }

        Stop();
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _folder = fullPath;
            _running = true;
            _restartDelayMs = InitialRestartDelayMs;
            _restartPending = false;
            _pending.Clear();
            _rawEvents = 0;
            _structural = false;
            _overflow = false;
            _debounce ??= new System.Threading.Timer(OnDebounceDue, null, Timeout.Infinite, Timeout.Infinite);
            _restart ??= new System.Threading.Timer(OnRestartDue, null, Timeout.Infinite, Timeout.Infinite);
        }

        CreateWatcher(fullPath, restart: false);
    }

    /// <summary>停止监听并取消所有挂起的重启/去抖。</summary>
    public void Stop()
    {
        FileSystemWatcher? watcher;
        string folder;
        lock (_gate)
        {
            watcher = _watcher;
            _watcher = null;
            _running = false;
            _restartPending = false;
            _pending.Clear();
            _rawEvents = 0;
            _structural = false;
            _overflow = false;
            folder = _folder;
        }

        CancelTimers();
        Detach(watcher);
        if (folder.Length > 0)
        {
            HostLog.Info($"[local] watch stopped: {folder}");
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        Stop();
        System.Threading.Timer? debounce;
        System.Threading.Timer? restart;
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            debounce = _debounce;
            _debounce = null;
            restart = _restart;
            _restart = null;
        }

        try
        {
            debounce?.Dispose();
        }
        catch
        {
            // Dispose 永远不抛。
        }

        try
        {
            restart?.Dispose();
        }
        catch
        {
            // Dispose 永远不抛。
        }
    }

    private void CreateWatcher(string folder, bool restart)
    {
        FileSystemWatcher? watcher = null;
        try
        {
            watcher = new FileSystemWatcher(folder)
            {
                IncludeSubdirectories = true,
                InternalBufferSize = InternalBufferBytes,
                Filter = "*",
                NotifyFilter = NotifyFilters.FileName
                    | NotifyFilters.DirectoryName
                    | NotifyFilters.LastWrite
                    | NotifyFilters.Size
                    | NotifyFilters.CreationTime,
            };
            watcher.Created += OnCreated;
            watcher.Changed += OnChanged;
            watcher.Deleted += OnDeleted;
            watcher.Renamed += OnRenamed;
            watcher.Error += OnWatcherError;
            watcher.EnableRaisingEvents = true;
        }
        catch (Exception exception)
        {
            if (watcher is not null)
            {
                try
                {
                    watcher.Dispose();
                }
                catch
                {
                    // 创建失败时尽力释放，异常不进宿主。
                }
            }

            HostLog.Error($"[local] watch error: create failed for {folder}", exception);
            ScheduleRestart();
            return;
        }

        FileSystemWatcher? previous = null;
        bool accepted;
        lock (_gate)
        {
            // 重启期间如果目录已经切换/停止，就别把新 watcher 挂上去了。
            accepted = !_disposed && _running && string.Equals(_folder, folder, StringComparison.OrdinalIgnoreCase);
            if (accepted)
            {
                previous = _watcher;
                _watcher = watcher;
                _restartPending = false;
                _restartDelayMs = InitialRestartDelayMs;
            }
        }

        if (!accepted)
        {
            Detach(watcher);
            return;
        }

        Detach(previous);
        HostLog.Info($"[local] watch started: {folder}{(restart ? " (restarted)" : string.Empty)}");
    }

    private void Enqueue(string path)
    {
        if (_disposed || string.IsNullOrEmpty(path))
        {
            return;
        }

        var structural = false;
        try
        {
            structural = Directory.Exists(path);
        }
        catch
        {
            // 路径都读到一半了就别再抛。
        }

        lock (_gate)
        {
            if (!_running)
            {
                return;
            }

            _pending.Add(path);
            _rawEvents += 1;
            if (structural)
            {
                _structural = true;
            }
        }

        var timer = _debounce;
        if (timer is null)
        {
            return;
        }

        try
        {
            timer.Change(_debounceMs, Timeout.Infinite);
        }
        catch (ObjectDisposedException)
        {
            // 正在 Dispose，忽略。
        }
    }

    private void OnCreated(object? sender, FileSystemEventArgs e) => Enqueue(e.FullPath);

    private void OnChanged(object? sender, FileSystemEventArgs e) => Enqueue(e.FullPath);

    private void OnDeleted(object? sender, FileSystemEventArgs e)
    {
        // 删除事件里路径已经不在了，但目录本身的删除也要算结构变化；服务端会按前缀判断子树。
        Enqueue(e.FullPath);
    }

    private void OnRenamed(object? sender, RenamedEventArgs e)
    {
        Enqueue(e.OldFullPath);
        Enqueue(e.FullPath);
    }

    private void OnWatcherError(object? sender, ErrorEventArgs e)
    {
        if (_disposed)
        {
            return;
        }

        Exception? exception = null;
        try
        {
            exception = e.GetException();
        }
        catch
        {
            // GetException 理论上不抛，兜底。
        }

        var overflow = exception is InternalBufferOverflowException;
        string folder;
        lock (_gate)
        {
            folder = _folder;
        }

        var detail = exception is null ? "unknown" : $"{exception.GetType().Name}: {exception.Message}";
        HostLog.Warn($"[local] watch error: {detail} ({folder})");

        // 缓冲区溢出意味着事件已经丢了：立刻让服务端整体重扫一次，不等重建成功。
        if (overflow && folder.Length > 0)
        {
            Publish(new LocalWatchBatch { Folder = folder, Structural = true, Overflow = true });
        }

        DetachCurrentWatcher();
        ScheduleRestart();
    }

    private void OnDebounceDue(object? state)
    {
        if (_disposed)
        {
            return;
        }

        LocalWatchBatch? batch = null;
        lock (_gate)
        {
            if (!_running || (_pending.Count == 0 && !_structural && !_overflow))
            {
                return;
            }

            batch = new LocalWatchBatch
            {
                Folder = _folder,
                Paths = new List<string>(_pending),
                Structural = _structural,
                Overflow = _overflow,
                RawEvents = _rawEvents,
            };
            _pending.Clear();
            _structural = false;
            _overflow = false;
            _rawEvents = 0;
        }

        if (batch is null || batch.IsEmpty)
        {
            return;
        }

        HostLog.Info($"[local] watch event batch: {batch.RawEvents} raw, {batch.Paths.Count} paths, structural={batch.Structural}");
        Publish(batch);
    }

    private void OnRestartDue(object? state)
    {
        if (_disposed)
        {
            return;
        }

        string folder;
        lock (_gate)
        {
            if (!_running)
            {
                return;
            }

            folder = _folder;
        }

        if (folder.Length == 0)
        {
            return;
        }

        if (!Directory.Exists(folder))
        {
            HostLog.Warn($"[local] watch restart postponed: folder missing {folder}");
            ScheduleRestart();
            return;
        }

        HostLog.Info($"[local] watch restarting: {folder}");
        CreateWatcher(folder, restart: true);
    }

    private void ScheduleRestart()
    {
        string folder;
        int delay;
        System.Threading.Timer? timer;
        lock (_gate)
        {
            if (_disposed || !_running || string.IsNullOrEmpty(_folder))
            {
                return;
            }

            folder = _folder;
            delay = _restartDelayMs;
            _restartDelayMs = Math.Min(_restartDelayMs * 2, MaxRestartDelayMs);
            _restartPending = true;
            timer = _restart;
        }

        HostLog.Info($"[local] watch restart in {delay}ms: {folder}");
        if (timer is null)
        {
            return;
        }

        try
        {
            timer.Change(delay, Timeout.Infinite);
        }
        catch (ObjectDisposedException)
        {
            // 正在 Dispose，忽略。
        }
    }

    private void DetachCurrentWatcher()
    {
        FileSystemWatcher? watcher;
        lock (_gate)
        {
            watcher = _watcher;
            _watcher = null;
            _pending.Clear();
            _structural = false;
            _overflow = false;
            _rawEvents = 0;
        }

        Detach(watcher);
    }

    private void Publish(LocalWatchBatch batch)
    {
        if (_disposed)
        {
            return;
        }

        try
        {
            _onBatch(batch);
        }
        catch (Exception exception)
        {
            HostLog.Error("[local] watch batch handler failed", exception);
        }
    }

    private void CancelTimers()
    {
        try
        {
            _debounce?.Change(Timeout.Infinite, Timeout.Infinite);
        }
        catch (ObjectDisposedException)
        {
            // 已释放。
        }

        try
        {
            _restart?.Change(Timeout.Infinite, Timeout.Infinite);
        }
        catch (ObjectDisposedException)
        {
            // 已释放。
        }
    }

    private void Detach(FileSystemWatcher? watcher)
    {
        if (watcher is null)
        {
            return;
        }

        try
        {
            watcher.EnableRaisingEvents = false;
        }
        catch
        {
            // 目录已经不存在时可能抛，忽略。
        }

        try
        {
            watcher.Created -= OnCreated;
            watcher.Changed -= OnChanged;
            watcher.Deleted -= OnDeleted;
            watcher.Renamed -= OnRenamed;
            watcher.Error -= OnWatcherError;
        }
        catch
        {
            // 事件解绑失败不值得让宿主崩。
        }

        try
        {
            watcher.Dispose();
        }
        catch
        {
            // Dispose 永远不抛。
        }
    }
}
