using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;
using Zilux2.Analysis;

namespace Zilux2.Stems;

/// <summary>
/// 离线 2 轨人声分离的宿主侧服务（契约 docs/zilux2-stems-contract.md）：
/// 曲目解析/下载复用 <see cref="TrackAnalysisService"/>，自己负责 44.1 kHz 立体声窗口解码、
/// 调用 <see cref="HtdemucsSession"/>、写 wNNN.vocals.wav / wNNN.inst.wav + meta.json，
/// 以及缓存预算、同一 (trackKey, window) 单飞和全局一次一个任务的闸门。
/// </summary>
internal sealed class StemSeparationService : IDisposable
{
    internal const string ModelFileName = "htdemucs-dft-fp16-transparent.onnx";

    internal const string ModelDownloadUrl =
        "https://hf-mirror.com/itamiArika/htdemucs-int8-memory/resolve/main/htdemucs-dft-fp16-transparent.onnx";

    internal const string ModelSha256 = "10d0d51c78f5ed1bc8e2c7b47f816169e810d78e4ebd510369c4a6a2b362221e";

    internal const long DefaultCacheLimitBytes = 512L * 1024 * 1024;

    /// <summary>research §5.5：单窗口计算超过 20 s 就丢弃，前端回退 EQ。</summary>
    internal const int WindowTimeoutSeconds = 20;

    /// <summary>契约 §4：空闲 60 s 释放 ORT 会话，把 2.5 GB 工作集还给系统。</summary>
    internal const int SessionIdleSeconds = 60;

    /// <summary>模型段长换算成毫秒：343,980 / 44,100 = 7.8 s，正好 7800 ms。</summary>
    internal const int ModelSegmentMs = StemsContract.SegmentFrames * 1000 / StemsContract.SampleRate;

    private static readonly TimeSpan IdleSweepPeriod = TimeSpan.FromSeconds(10);

    private readonly TrackAnalysisService _analysis;
    private readonly ConcurrentDictionary<string, Lazy<Task<StemsOutcome>>> _inflight = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _computeGate = new(1, 1);
    private readonly CancellationTokenSource _shutdown = new();
    private readonly object _sessionGate = new();
    private readonly object _modelHashGate = new();
    private readonly Timer? _idleTimer;
    private HtdemucsSession? _session;
    private DateTime _sessionUsedUtc = DateTime.UtcNow;
    private int _activeComputations;
    private int _disposed;
    private string _modelHashPath = string.Empty;
    private long _modelHashLength;
    private DateTime _modelHashWriteUtc;
    private string _modelHashValue = string.Empty;

    internal StemSeparationService(TrackAnalysisService analysis)
    {
        _analysis = analysis;
        try
        {
            Directory.CreateDirectory(CacheRoot);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"stems.cache-unavailable: {exception.Message}");
        }

        _idleTimer = new Timer(_ => ReleaseIdleSession(), null, IdleSweepPeriod, IdleSweepPeriod);
    }

    internal static string CacheRoot => Path.Combine(HostFolders.Root, "stems");

    internal long CacheLimitBytes => ReadCacheLimitBytes();

    /// <summary>
    /// 优先级：ZILUX2_STEMS_MODEL → 随包 models/htdemucs-…onnx（与 exe 同级）→
    /// 老版本用户目录 %LOCALAPPDATA%\Zilux2\models\htdemucs-…onnx。
    /// 发布版把模型一起打进安装包，不再依赖首次下载。
    /// </summary>
    internal static string ResolveModelPath()
    {
        var overridden = Environment.GetEnvironmentVariable("ZILUX2_STEMS_MODEL");
        if (!string.IsNullOrWhiteSpace(overridden))
        {
            return overridden.Trim();
        }

        var bundled = Path.Combine(AppContext.BaseDirectory, "models", ModelFileName);
        return File.Exists(bundled)
            ? bundled
            : Path.Combine(HostFolders.Root, "models", ModelFileName);
    }

    internal static bool ModelExists() => File.Exists(ResolveModelPath());

    /// <summary>
    /// 计算第 <paramref name="request"/>.Window 个窗口；缓存命中直接 ready，
    /// 否则同步算完再返回（契约 §3.1）。同窗口并发会合并到同一个任务。
    /// </summary>
    internal async Task<StemsOutcome> EnsureWindowAsync(StemsRequest request, CancellationToken cancellationToken)
    {
        var watch = Stopwatch.StartNew();
        if (Volatile.Read(ref _disposed) != 0)
        {
            return StemsOutcome.Fail(request, "internal-error", "人声分离服务已停止");
        }

        var modelPath = ResolveModelPath();
        if (!File.Exists(modelPath))
        {
            return StemsOutcome.ModelMissing();
        }

        var trackKey = BuildTrackKey(request);
        var trackDirectory = TrackDirectory(trackKey);
        string modelHash;
        try
        {
            modelHash = GetModelHash(modelPath);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            HostLog.Warn($"stems.model-hash-failed path={modelPath}: {exception.Message}");
            return StemsOutcome.Fail(request, "model-error", "无法读取人声分离模型：" + exception.Message);
        }

        if (TryReadCache(trackDirectory, request, modelHash, out var cachedFrames, out var cachedDurationMs))
        {
            HostLog.Info(
                $"stems.hit track={trackKey} window={request.Window} windowSec={request.WindowSec} " +
                $"frames={cachedFrames}");
            return StemsOutcome.Ready(
                request,
                cachedFrames,
                cached: true,
                elapsedMs: watch.ElapsedMilliseconds,
                durationMs: cachedDurationMs);
        }

        var flightKey = BuildFlightKey(trackKey, request);
        var lazy = _inflight.GetOrAdd(
            flightKey,
            _ => new Lazy<Task<StemsOutcome>>(
                () => Task.Run(() => RunAsync(request, trackKey, modelPath, modelHash, trackDirectory, flightKey)),
                LazyThreadSafetyMode.ExecutionAndPublication));

        Task<StemsOutcome> shared;
        try
        {
            shared = lazy.Value;
        }
        catch
        {
            _inflight.TryRemove(new KeyValuePair<string, Lazy<Task<StemsOutcome>>>(flightKey, lazy));
            throw;
        }

        try
        {
            return await shared.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            if (!lazy.IsValueCreated)
            {
                _inflight.TryRemove(new KeyValuePair<string, Lazy<Task<StemsOutcome>>>(flightKey, lazy));
            }
            else
            {
                var pair = new KeyValuePair<string, Lazy<Task<StemsOutcome>>>(flightKey, lazy);
                if (shared.IsCompleted)
                {
                    _inflight.TryRemove(pair);
                }
                else
                {
                    _ = shared.ContinueWith(
                        _ => _inflight.TryRemove(pair),
                        CancellationToken.None,
                        TaskContinuationOptions.ExecuteSynchronously,
                        TaskScheduler.Default);
                }
            }
        }
    }

    /// <summary>
    /// /api/stems/audio 用：只查缓存，不触发计算。缓存命中返回 WAV 路径；
    /// 否则给出 busy / model-missing / not-ready 三种状态。
    /// </summary>
    internal StemsAudioOutcome ResolveAudio(StemsRequest request, string stem)
    {
        if (Volatile.Read(ref _disposed) != 0)
        {
            return new StemsAudioOutcome
            {
                State = StemsState.Error,
                Code = "internal-error",
                Message = "人声分离服务已停止",
            };
        }

        var trackKey = BuildTrackKey(request);
        var trackDirectory = TrackDirectory(trackKey);
        if (TryFindCachedAudio(trackDirectory, request, stem, out var path, out var frames))
        {
            return new StemsAudioOutcome { State = StemsState.Ready, Path = path, Frames = frames };
        }

        var modelPath = ResolveModelPath();
        if (!File.Exists(modelPath))
        {
            return new StemsAudioOutcome { State = StemsState.ModelMissing };
        }

        if (_inflight.ContainsKey(BuildFlightKey(trackKey, request)) || _computeGate.CurrentCount == 0)
        {
            return new StemsAudioOutcome { State = StemsState.Busy };
        }

        return new StemsAudioOutcome
        {
            State = StemsState.Error,
            Code = "not-found",
            Message = "该窗口尚未分离，请先请求 /api/stems",
        };
    }

    private async Task<StemsOutcome> RunAsync(
        StemsRequest request,
        string trackKey,
        string modelPath,
        string modelHash,
        string trackDirectory,
        string flightKey)
    {
        var watch = Stopwatch.StartNew();
        // 在线曲目会先下载到 trackDirectory；读完窗口就删掉，缓存里只留契约要求的 wav + meta。
        string? temporaryAudio = null;

        // 全局只跑一个分离任务；别的窗口正在算就立刻回 busy（契约 §3.1），
        // 让前端用 EQ 兜底而不是把请求排成长队。
        if (!await _computeGate.WaitAsync(0).ConfigureAwait(false))
        {
            HostLog.Info($"stems.busy key={flightKey}");
            return StemsOutcome.Busy(request);
        }

        Interlocked.Increment(ref _activeComputations);
        try
        {
            Directory.CreateDirectory(trackDirectory);

            // 排队期间可能已经有别的请求算完了同一窗口。
            if (TryReadCache(trackDirectory, request, modelHash, out var frames, out var durationMs))
            {
                return StemsOutcome.Ready(request, frames, cached: true, watch.ElapsedMilliseconds, durationMs);
            }

            var prepared = await _analysis
                .PrepareAudioAsync(request.Source, request.TrackId, request.Rel, quality: null, trackDirectory, _shutdown.Token)
                .ConfigureAwait(false);
            if (!prepared.Ok || prepared.Audio is null)
            {
                return StemsOutcome.Fail(
                    request,
                    prepared.Code.Length == 0 ? "internal-error" : prepared.Code,
                    prepared.Message);
            }

            HostLog.Info($"stems.prepare track={trackKey} source={prepared.Audio.Source} temporary={prepared.Audio.IsTemporary}");
            temporaryAudio = prepared.Audio.IsTemporary ? prepared.Audio.AudioPath : null;

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(WindowTimeoutSeconds));

            var window = await Task.Run(
                    () => StemsWindowReader.Read(prepared.Audio.AudioPath, request.Window, request.WindowSec),
                    timeout.Token)
                .ConfigureAwait(false);
            if (window.Frames <= 0)
            {
                return StemsOutcome.Fail(request, "not-found", "窗口超出曲目长度");
            }

            // 窗口数据已经在内存里，下载的临时音频可以删了（本地曲目 IsTemporary=false）。
            if (temporaryAudio is not null)
            {
                TryDelete(temporaryAudio);
                temporaryAudio = null;
            }

            var session = EnsureSession(modelPath);
            var separation = await Task.Run(
                    () => session.Separate(window.Left, window.Right, window.Frames, timeout.Token),
                    timeout.Token)
                .ConfigureAwait(false);

            var vocalsPath = VocalsPath(trackDirectory, request.Window);
            var instrumentalPath = InstrumentalPath(trackDirectory, request.Window);
            StemsWav.Write16(vocalsPath, separation.VocalsLeft, separation.VocalsRight, separation.Frames);
            StemsWav.Write16(instrumentalPath, separation.InstrumentalLeft, separation.InstrumentalRight, separation.Frames);
            StemsMetaJson.Write(Path.Combine(trackDirectory, StemsMetaJson.FileName), new StemsMeta
            {
                TrackKey = trackKey,
                Source = prepared.Audio.Source,
                Title = prepared.Audio.Title,
                DurationMs = window.DurationMs,
                SegmentMs = ModelSegmentMs,
                ModelSha256 = modelHash,
                CreatedUtc = DateTime.UtcNow,
            });

            HostLog.Info(
                $"stems.done track={trackKey} window={request.Window} frames={separation.Frames} " +
                $"segments={separation.Segments} peak={separation.Peak:0.####} gain={separation.Gain:0.####} " +
                $"elapsedMs={watch.ElapsedMilliseconds}");
            PruneCache();
            return StemsOutcome.Ready(
                request,
                separation.Frames,
                cached: false,
                elapsedMs: watch.ElapsedMilliseconds,
                durationMs: window.DurationMs);
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
            return StemsOutcome.Fail(request, "internal-error", "宿主正在关闭");
        }
        catch (OperationCanceledException)
        {
            HostLog.Warn($"stems.timeout key={flightKey} limitSec={WindowTimeoutSeconds}");
            return StemsOutcome.Fail(
                request,
                "timeout",
                $"人声分离超时（>{WindowTimeoutSeconds} 秒），本窗口稍后重试");
        }
        catch (StemsDecodeException exception)
        {
            HostLog.Warn($"stems.decode-failed key={flightKey}: {exception.Message}");
            return StemsOutcome.Fail(request, "decode-failed", exception.Message);
        }
        catch (HtdemucsException exception)
        {
            HostLog.Warn($"stems.model-failed key={flightKey} code={exception.Code}: {exception.Message}");
            return StemsOutcome.Fail(request, exception.Code, exception.Message);
        }
        catch (Exception exception)
        {
            HostLog.Error($"stems.fail key={flightKey}: {exception}");
            return StemsOutcome.Fail(request, "internal-error", "人声分离失败：" + exception.Message);
        }
        finally
        {
            if (temporaryAudio is not null)
            {
                TryDelete(temporaryAudio);
            }

            Interlocked.Decrement(ref _activeComputations);
            _computeGate.Release();
        }
    }

    private HtdemucsSession EnsureSession(string modelPath)
    {
        lock (_sessionGate)
        {
            if (_session is not null)
            {
                _sessionUsedUtc = DateTime.UtcNow;
                return _session;
            }

            var session = HtdemucsSession.Open(modelPath, HtdemucsSession.DefaultThreadCount);
            _session = session;
            _sessionUsedUtc = DateTime.UtcNow;
            HostLog.Info($"stems.session-opened threads={HtdemucsSession.DefaultThreadCount} segment={session.SegmentFrames}");
            return session;
        }
    }

    /// <summary>定时器回调：空闲 60 s 后释放 ORT 会话；不在计算中才动手。</summary>
    private void ReleaseIdleSession()
    {
        if (Volatile.Read(ref _disposed) != 0)
        {
            return;
        }

        HtdemucsSession? idle = null;
        lock (_sessionGate)
        {
            // 计算计数在进入会话前已经 +1，这里看到 0 才说明确实没人用。
            if (Volatile.Read(ref _activeComputations) > 0 || _session is null)
            {
                return;
            }

            if (DateTime.UtcNow - _sessionUsedUtc < TimeSpan.FromSeconds(SessionIdleSeconds))
            {
                return;
            }

            idle = _session;
            _session = null;
        }

        try
        {
            idle.Dispose();
            HostLog.Info("stems.session-released idle=true");
            // ORT 的 arena 不 Dispose 就还留在进程里；研究结论是这能把 2.5 GB 工作集还给系统。
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true, compacting: true);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"stems.session-release-failed: {exception.Message}");
        }
    }

    private bool TryReadCache(
        string trackDirectory,
        StemsRequest request,
        string modelHash,
        out long frames,
        out long durationMs)
    {
        frames = 0;
        durationMs = 0;
        var metaPath = Path.Combine(trackDirectory, StemsMetaJson.FileName);
        if (!StemsMetaJson.TryRead(metaPath, out var meta) || meta is null)
        {
            return false;
        }

        // 换模型 / 换段长都视为未命中（研究 §5.3：键版本化）。
        if (!string.Equals(meta.ModelSha256, modelHash, StringComparison.OrdinalIgnoreCase) ||
            meta.SegmentMs != ModelSegmentMs)
        {
            return false;
        }

        var vocalsPath = VocalsPath(trackDirectory, request.Window);
        var instrumentalPath = InstrumentalPath(trackDirectory, request.Window);
        if (!File.Exists(vocalsPath) || !File.Exists(instrumentalPath))
        {
            return false;
        }

        var vocalsFrames = StemsWav.ReadFrameCount(vocalsPath);
        var instrumentalFrames = StemsWav.ReadFrameCount(instrumentalPath);
        if (vocalsFrames <= 0 || vocalsFrames != instrumentalFrames)
        {
            return false;
        }

        // windowSec 只用于调试，但缓存文件名不带 windowSec；按 meta 里的整曲时长
        // 反推本次请求应有的帧数，短窗口与整窗口不会互相误命中（研究 §5.3）。
        if (!FramesMatchRequest(vocalsFrames, meta.DurationMs, request))
        {
            return false;
        }

        frames = vocalsFrames;
        durationMs = meta.DurationMs;
        return true;
    }

    /// <summary>
    /// 缓存里的帧数是否就是本次请求该有的长度。整窗必须精确相等；末窗允许几十帧误差，
    /// 因为 meta.durationMs 是按毫秒取整存的，重算总帧数时会差一点点。
    /// </summary>
    private static bool FramesMatchRequest(long frames, long durationMs, StemsRequest request)
    {
        var totalFrames = (long)Math.Round(durationMs * StemsContract.SampleRate / 1000d);
        var remaining = totalFrames - request.StartFrame;
        if (remaining <= 0)
        {
            return false;
        }

        var expected = Math.Min((long)request.RequestedFrames, remaining);
        // 末窗允许 0.2 s 误差：meta.durationMs 是毫秒取整，短尾窗按毫秒反推会差几十毫秒；
        // 0.2 s 远小于 windowSec(10–30) 的帧差，不会把短窗与整窗互相误命中。
        var tolerance = expected < request.RequestedFrames
            ? Math.Max(64, StemsContract.SampleRate / 5)
            : 0;
        return Math.Abs(frames - expected) <= tolerance;
    }

    private bool TryFindCachedAudio(
        string trackDirectory,
        StemsRequest request,
        string stem,
        out string path,
        out long frames)
    {
        path = string.Empty;
        frames = 0;
        var metaPath = Path.Combine(trackDirectory, StemsMetaJson.FileName);
        if (!StemsMetaJson.TryRead(metaPath, out var meta) || meta is null || meta.SegmentMs != ModelSegmentMs)
        {
            return false;
        }

        var candidate = string.Equals(stem, "instrumental", StringComparison.Ordinal)
            ? InstrumentalPath(trackDirectory, request.Window)
            : VocalsPath(trackDirectory, request.Window);
        if (!File.Exists(candidate))
        {
            return false;
        }

        var count = StemsWav.ReadFrameCount(candidate);
        if (count <= 0)
        {
            return false;
        }

        // 与 TryReadCache 同一套帧数校验：短窗口调试写下的 wNNN 不会被整窗口误用。
        if (!FramesMatchRequest(count, meta.DurationMs, request))
        {
            return false;
        }

        // 模型换了但 meta 还是旧的：不能把旧模型的音轨当新结果发出去。
        var modelPath = ResolveModelPath();
        if (File.Exists(modelPath))
        {
            try
            {
                var modelHash = GetModelHash(modelPath);
                if (!string.Equals(modelHash, meta.ModelSha256, StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                HostLog.Warn($"stems.model-hash-failed path={modelPath}: {exception.Message}");
                return false;
            }
        }

        path = candidate;
        frames = count;
        return true;
    }

    /// <summary>
    /// 模型文件 SHA-256（按 路径+长度+mtime 记忆）。同时用于缓存键：换模型自动失效。
    /// 首次调用要读 124 MB（约 0.2–0.4 s），之后命中记忆。
    /// </summary>
    private string GetModelHash(string modelPath)
    {
        lock (_modelHashGate)
        {
            var info = new FileInfo(modelPath);
            if (string.Equals(_modelHashPath, modelPath, StringComparison.OrdinalIgnoreCase) &&
                _modelHashLength == info.Length &&
                _modelHashWriteUtc == info.LastWriteTimeUtc &&
                _modelHashValue.Length > 0)
            {
                return _modelHashValue;
            }

            using var stream = new FileStream(
                modelPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                1 << 20,
                FileOptions.SequentialScan);
            var hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            _modelHashPath = modelPath;
            _modelHashLength = info.Length;
            _modelHashWriteUtc = info.LastWriteTimeUtc;
            _modelHashValue = hash;
            return hash;
        }
    }

    private static long ReadCacheLimitBytes()
    {
        var text = Environment.GetEnvironmentVariable("ZILUX2_STEMS_CACHE_MB");
        if (long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var megabytes) && megabytes > 0)
        {
            return megabytes * 1024 * 1024;
        }

        // 设置页的缓存预算（cache-policy.json）优先于内置默认值，改了立即生效。
        return Zilux2.Storage.CachePolicy.LimitBytes;
    }

    private static string BuildTrackKey(StemsRequest request)
    {
        var source = (request.Source ?? string.Empty).Trim().ToLowerInvariant();
        return string.Equals(source, "local", StringComparison.Ordinal)
            ? "local:" + (request.Rel ?? string.Empty).Trim()
            : source + ":" + (request.TrackId ?? string.Empty).Trim();
    }

    private static string BuildFlightKey(string trackKey, StemsRequest request) =>
        string.Create(CultureInfo.InvariantCulture, $"{trackKey}|{request.Window}|{request.WindowSec}");

    private static string TrackDirectory(string trackKey) =>
        Path.Combine(CacheRoot, Sha1Hex(trackKey));

    private static string Sha1Hex(string value) =>
        Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static string VocalsPath(string directory, int window) =>
        Path.Combine(directory, string.Create(CultureInfo.InvariantCulture, $"w{window:D3}.vocals.wav"));

    private static string InstrumentalPath(string directory, int window) =>
        Path.Combine(directory, string.Create(CultureInfo.InvariantCulture, $"w{window:D3}.inst.wav"));

    /// <summary>512 MB 预算，按最旧 LastWriteTimeUtc 淘汰；先删文件，再收掉空目录。</summary>
    private void PruneCache()
    {
        try
        {
            if (!Directory.Exists(CacheRoot))
            {
                return;
            }

            var files = new List<FileInfo>();
            var limit = ReadCacheLimitBytes();
            var total = 0L;
            foreach (var path in Directory.EnumerateFiles(CacheRoot, "*", SearchOption.AllDirectories))
            {
                var info = new FileInfo(path);
                if (!info.Exists)
                {
                    continue;
                }

                files.Add(info);
                total += info.Length;
            }

            if (total <= limit)
            {
                return;
            }

            files.Sort(static (left, right) => left.LastWriteTimeUtc.CompareTo(right.LastWriteTimeUtc));
            var removed = 0;
            foreach (var file in files)
            {
                if (total <= limit)
                {
                    break;
                }

                var length = file.Length;
                try
                {
                    file.Delete();
                    total -= length;
                    removed++;
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    // 前端正在读这个窗口就跳过，下次再淘汰。
                }
            }

            var directories = Directory
                .EnumerateDirectories(CacheRoot, "*", SearchOption.AllDirectories)
                .OrderByDescending(static directory => directory.Length);
            foreach (var directory in directories)
            {
                try
                {
                    if (!Directory.EnumerateFileSystemEntries(directory).Any())
                    {
                        Directory.Delete(directory);
                    }
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    // 忽略：下次再收。
                }
            }

            HostLog.Info($"stems.prune removed={removed} remaining={total} limit={limit}");
        }
        catch (Exception exception)
        {
            HostLog.Warn($"stems.prune-failed: {exception.Message}");
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        HostLog.Info("stems.disposed");
        try
        {
            _shutdown.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // 已释放：忽略。
        }

        _idleTimer?.Dispose();

        HtdemucsSession? session;
        lock (_sessionGate)
        {
            session = _session;
            _session = null;
        }

        session?.Dispose();
        // 注意：不 Dispose _computeGate / _shutdown，避免正在跑的 finally 与
        // CancelAfter 注册撞上 ObjectDisposedException；它们没有非托管句柄，代价可忽略。
    }

    // ------------------------------------------------------------------
    // 44.1 kHz 立体声窗口解码
    // ------------------------------------------------------------------

    private sealed class DecodedWindow
    {
        public required float[] Left { get; init; }

        public required float[] Right { get; init; }

        public required int Frames { get; init; }

        public required long DurationMs { get; init; }
    }

    private sealed class StemsDecodeException : Exception
    {
        internal StemsDecodeException(string message)
            : base(message)
        {
        }
    }

    /// <summary>
    /// 用 Media Foundation 打开整首歌，seek 到窗口起点，只读窗口需要的帧；
    /// 44.1 kHz / 立体声直接读，其它采样率用 WDL 重采样，单声道复制成两轨。
    /// </summary>
    private static class StemsWindowReader
    {
        internal static DecodedWindow Read(string audioPath, int window, int windowSec)
        {
            if (!File.Exists(audioPath))
            {
                throw new StemsDecodeException("找不到音频文件");
            }

            MediaFoundationReader reader;
            try
            {
                reader = new MediaFoundationReader(audioPath);
            }
            catch (Exception exception)
            {
                throw new StemsDecodeException("无法解码音频：" + exception.Message);
            }

            using (reader)
            {
                var sourceRate = reader.WaveFormat.SampleRate;
                var sourceChannels = reader.WaveFormat.Channels;
                var totalMs = reader.TotalTime.TotalMilliseconds;
                if (sourceRate <= 0 || sourceChannels <= 0 || totalMs <= 0)
                {
                    throw new StemsDecodeException("音频格式不受支持");
                }

                var totalFrames = (long)Math.Round(totalMs * StemsContract.SampleRate / 1000d);
                var startFrame = window * (long)StemsContract.WindowFrames;
                if (startFrame >= totalFrames)
                {
                    return new DecodedWindow
                    {
                        Left = Array.Empty<float>(),
                        Right = Array.Empty<float>(),
                        Frames = 0,
                        DurationMs = (long)Math.Round(totalMs),
                    };
                }

                if (window > 0)
                {
                    if (!reader.CanSeek)
                    {
                        throw new StemsDecodeException("音频不支持定位，无法取非首个窗口");
                    }

                    reader.CurrentTime = TimeSpan.FromMilliseconds(window * (double)StemsContract.WindowMs);
                }

                var wanted = (int)Math.Min(windowSec * (long)StemsContract.SampleRate, totalFrames - startFrame);
                var provider = BuildProvider(reader);
                var left = new float[wanted];
                var right = new float[wanted];
                var buffer = new float[8192 * 2];
                var filled = 0;
                var zeroReads = 0;
                while (filled < wanted)
                {
                    var wantSamples = Math.Min(buffer.Length, (wanted - filled) * 2);
                    var read = provider.Read(buffer.AsSpan(0, wantSamples));
                    if (read <= 0)
                    {
                        // WDL 重采样器在极少数边界上可能先返回 0；连续几次 0 才当作 EOF。
                        if (++zeroReads >= 4)
                        {
                            break;
                        }

                        continue;
                    }

                    zeroReads = 0;
                    var frames = read / 2;
                    for (var i = 0; i < frames; i++)
                    {
                        left[filled + i] = buffer[i * 2];
                        right[filled + i] = buffer[i * 2 + 1];
                    }

                    filled += frames;
                }

                if (filled == 0)
                {
                    throw new StemsDecodeException("窗口内没有读到音频样本");
                }

                if (filled < left.Length)
                {
                    Array.Resize(ref left, filled);
                    Array.Resize(ref right, filled);
                }

                return new DecodedWindow
                {
                    Left = left,
                    Right = right,
                    Frames = filled,
                    DurationMs = (long)Math.Round(totalMs),
                };
            }
        }

        private static ISampleProvider BuildProvider(MediaFoundationReader reader)
        {
            var stereo = new StereoAdapter(reader.ToSampleProvider());
            return stereo.WaveFormat.SampleRate == StemsContract.SampleRate
                ? stereo
                : new WdlResamplingSampleProvider(stereo, StemsContract.SampleRate);
        }
    }

    /// <summary>任意声道数 → 交错立体声（单声道复制，≥2 声道取前两声道）。</summary>
    private sealed class StereoAdapter : ISampleProvider
    {
        private readonly ISampleProvider _source;
        private readonly int _channels;
        private float[] _buffer = Array.Empty<float>();

        internal StereoAdapter(ISampleProvider source)
        {
            _source = source;
            _channels = source.WaveFormat.Channels;
            WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(source.WaveFormat.SampleRate, 2);
        }

        public WaveFormat WaveFormat { get; }

        public int Read(Span<float> buffer)
        {
            var framesWanted = buffer.Length / 2;
            var need = framesWanted * _channels;
            if (_buffer.Length < need)
            {
                _buffer = new float[need];
            }

            var read = _source.Read(_buffer.AsSpan(0, need));
            var frames = read / _channels;
            for (var frame = 0; frame < frames; frame++)
            {
                float left;
                float right;
                if (_channels == 1)
                {
                    left = right = _buffer[frame];
                }
                else
                {
                    left = _buffer[frame * _channels];
                    right = _buffer[frame * _channels + 1];
                }

                buffer[frame * 2] = left;
                buffer[frame * 2 + 1] = right;
            }

            return frames * 2;
        }
    }

    // ------------------------------------------------------------------
    // WAV 读写（44.1 kHz / 16-bit / 立体声）
    // ------------------------------------------------------------------

    private static class StemsWav
    {
        private const int Channels = 2;
        private const int BitsPerSample = 16;
        private const int BytesPerFrame = Channels * BitsPerSample / 8;

        /// <summary>只解析头部拿 data 帧数；不是 44.1k/16-bit/立体声就返回 0。</summary>
        internal static long ReadFrameCount(string path)
        {
            try
            {
                using var stream = new FileStream(
                    path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite,
                    64 * 1024,
                    FileOptions.SequentialScan);
                using var reader = new BinaryReader(stream, Encoding.ASCII, leaveOpen: true);
                if (new string(reader.ReadChars(4)) != "RIFF")
                {
                    return 0;
                }

                reader.ReadInt32();
                if (new string(reader.ReadChars(4)) != "WAVE")
                {
                    return 0;
                }

                while (stream.Position + 8 <= stream.Length)
                {
                    var id = new string(reader.ReadChars(4));
                    var size = reader.ReadInt32();
                    if (size < 0)
                    {
                        return 0;
                    }

                    if (id == "fmt ")
                    {
                        var format = reader.ReadInt16();
                        var channels = reader.ReadInt16();
                        var sampleRate = reader.ReadInt32();
                        reader.ReadInt32();
                        reader.ReadInt16();
                        reader.ReadInt16();
                        if (format != 1 || channels != Channels || sampleRate != StemsContract.SampleRate)
                        {
                            return 0;
                        }

                        var remaining = size - 16;
                        if (remaining > 0)
                        {
                            stream.Position += remaining + (size & 1);
                        }
                        else if ((size & 1) != 0)
                        {
                            stream.Position += 1;
                        }
                    }
                    else if (id == "data")
                    {
                        return size / BytesPerFrame;
                    }
                    else
                    {
                        stream.Position += size + (size & 1);
                    }
                }

                return 0;
            }
            catch (Exception exception) when (
                exception is IOException or UnauthorizedAccessException or EndOfStreamException)
            {
                return 0;
            }
        }

        internal static void Write16(string path, float[] left, float[] right, int frames)
        {
            var temp = path + ".tmp";
            try
            {
                using (var stream = new FileStream(
                           temp,
                           FileMode.Create,
                           FileAccess.Write,
                           FileShare.None,
                           64 * 1024,
                           FileOptions.SequentialScan))
                {
                    var dataBytes = frames * BytesPerFrame;
                    Span<byte> header = stackalloc byte[44];
                    WriteHeader(header, dataBytes);
                    stream.Write(header);

                    var buffer = new byte[4096 * BytesPerFrame];
                    var index = 0;
                    while (index < frames)
                    {
                        var block = Math.Min(4096, frames - index);
                        for (var i = 0; i < block; i++)
                        {
                            BinaryPrimitives.WriteInt16LittleEndian(
                                buffer.AsSpan(i * BytesPerFrame),
                                ToInt16(left[index + i]));
                            BinaryPrimitives.WriteInt16LittleEndian(
                                buffer.AsSpan(i * BytesPerFrame + 2),
                                ToInt16(right[index + i]));
                        }

                        stream.Write(buffer.AsSpan(0, block * BytesPerFrame));
                        index += block;
                    }
                }

                File.Move(temp, path, overwrite: true);
            }
            finally
            {
                TryDelete(temp);
            }
        }

        private static void WriteHeader(Span<byte> header, int dataBytes)
        {
            "RIFF"u8.CopyTo(header);
            BinaryPrimitives.WriteInt32LittleEndian(header[4..], 36 + dataBytes);
            "WAVEfmt "u8.CopyTo(header[8..]);
            BinaryPrimitives.WriteInt32LittleEndian(header[16..], 16);
            BinaryPrimitives.WriteInt16LittleEndian(header[20..], 1);
            BinaryPrimitives.WriteInt16LittleEndian(header[22..], Channels);
            BinaryPrimitives.WriteInt32LittleEndian(header[24..], StemsContract.SampleRate);
            BinaryPrimitives.WriteInt32LittleEndian(
                header[28..],
                StemsContract.SampleRate * Channels * (BitsPerSample / 8));
            BinaryPrimitives.WriteInt16LittleEndian(header[32..], Channels * (BitsPerSample / 8));
            BinaryPrimitives.WriteInt16LittleEndian(header[34..], BitsPerSample);
            "data"u8.CopyTo(header[36..]);
            BinaryPrimitives.WriteInt32LittleEndian(header[40..], dataBytes);
        }

        private static short ToInt16(float value)
        {
            var scaled = value * 32768f;
            scaled = MathF.Max(-32768f, MathF.Min(32767f, scaled));
            return (short)MathF.Round(scaled);
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // 临时文件删不掉不影响结果。
        }
    }
}

