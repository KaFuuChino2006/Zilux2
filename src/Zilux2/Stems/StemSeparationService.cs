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
/// 离线分轨的宿主侧服务（契约 docs/zilux2-stems-contract.md）：
/// 曲目解析/下载复用 <see cref="TrackAnalysisService"/>，自己负责 44.1 kHz 立体声窗口解码、
/// 调用 <see cref="HtdemucsSession"/>，写 wNNN.vocals.wav / wNNN.inst.wav + meta.json；
/// 4 轨请求额外写 wNNN.drums.wav / wNNN.bass.wav / wNNN.other.wav，
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
    /// 给增强 stage（分轨活动度 / 后续生成式延长）读一段 44.1 kHz 立体声窗口。
    /// 与分离管线共用同一套解码下混，避免两条链的参数漂移。
    /// </summary>
    internal static DecodedAudioWindow ReadAudioWindow(string audioPath, int window, int windowSec)
    {
        var decoded = StemsWindowReader.Read(audioPath, window, windowSec);
        return new DecodedAudioWindow(decoded.Left, decoded.Right, decoded.Frames, decoded.DurationMs);
    }

    internal readonly record struct DecodedAudioWindow(float[] Left, float[] Right, int Frames, long DurationMs);

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
            return StemsOutcome.ModelMissing(request);
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

        // 4 轨 stem 只可能来自 4 轨缓存：该窗口还没算过 4 轨时返回 busy，
        // 让前端继续等或去请求 /api/stems?stems=4，而不是 404 让它误判成「要重新分析」。
        if (IsFourStemStem(stem))
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
        // 4 轨残差归位后的重建误差（dBFS）：写进 meta，回归/诊断时用来证明「四轨之和 == 原音」。
        var lastReconDbfs = double.NaN;
        try
        {
            Directory.CreateDirectory(trackDirectory);
            // 计算期间钉住这首的目录：整曲目录级 LRU 不能把正在写的窗口整目录删掉。
            using var cachePin = StemCacheLru.Pin(trackDirectory);

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

            // 只有 4 轨请求才多写三轨并把 inst 换成求和；2 轨请求的落盘与旧版逐字节一致。
            if (request.FourStem)
            {
                WriteFourStem(
                    trackDirectory,
                    request.Window,
                    separation,
                    window.Left,
                    window.Right,
                    out lastReconDbfs);
            }
            // 源文件身份：读缓存时与磁盘 FileInfo 比对，不一致就按未命中重算（T2-7）。
            var sourceIdentity = ReadSourceIdentity(prepared.Audio);
            // Stems 记「已经产出了几轨」而不是「这次请求了几轨」：
            // 2 轨/4 轨来回切时，若这里写成请求值，切回 4 轨的第一个窗口会被判未命中，
            // 明明四个 wav 都在也要再跑几十秒推理。
            var metaPath = Path.Combine(trackDirectory, StemsMetaJson.FileName);
            var producedStems = request.FourStem ? StemSeparationResult.StemCount : 2;
            if (StemsMetaJson.TryRead(metaPath, out var priorMeta) && priorMeta is not null)
            {
                producedStems = Math.Max(producedStems, priorMeta.Stems);
            }

            StemsMetaJson.Write(metaPath, new StemsMeta
            {
                TrackKey = trackKey,
                Source = prepared.Audio.Source,
                Title = prepared.Audio.Title,
                DurationMs = window.DurationMs,
                SegmentMs = ModelSegmentMs,
                Stems = producedStems,
                ReconErrorDbfs = lastReconDbfs,
                ModelSha256 = modelHash,
                CreatedUtc = DateTime.UtcNow,
                SourceBytes = sourceIdentity?.Length ?? 0,
                SourceModifiedUtc = sourceIdentity?.LastWriteTimeUtc,
            });

            HostLog.Info(
                $"stems.done track={trackKey} window={request.Window} frames={separation.Frames} " +
                $"segments={separation.Segments} peak={separation.Peak:0.####} gain={separation.Gain:0.####} " +
                $"elapsedMs={watch.ElapsedMilliseconds}");
            PruneCache();
            var outcome = StemsOutcome.Ready(
                request,
                separation.Frames,
                cached: false,
                elapsedMs: watch.ElapsedMilliseconds,
                durationMs: window.DurationMs);
            outcome.ReconErrorDbfs = lastReconDbfs;
            return outcome;
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

    /// <summary>
    /// 4 轨模式的落盘：额外写 drums / bass / other，并把 inst 重写成三轨之和。
    /// 2 轨模式下 inst 仍是 mix − vocals；两种模式都满足 inst ≈ mix − vocals，
    /// 差别只有模型重建误差与 16-bit 量化（实测残差远低于 −60 dBFS）。
    /// </summary>
    private static void WriteFourStem(
        string trackDirectory,
        int window,
        StemSeparationResult separation,
        float[] mixLeft,
        float[] mixRight,
        out double reconErrorDbfs)
    {
        reconErrorDbfs = double.NaN;
        var frames = separation.Frames;
        var drumLeft = separation.StemLeft[HtdemucsSession.DrumStemIndex];
        var drumRight = separation.StemRight[HtdemucsSession.DrumStemIndex];
        var bassLeft = separation.StemLeft[HtdemucsSession.BassStemIndex];
        var bassRight = separation.StemRight[HtdemucsSession.BassStemIndex];
        var otherLeft = separation.StemLeft[HtdemucsSession.OtherStemIndex];
        var otherRight = separation.StemRight[HtdemucsSession.OtherStemIndex];

        // ---- 残差归位（C）：把「原音 − 四轨之和」补进 other ----
        // 模型重建 + 分块拼接 + 16 bit 量化都会留下误差；只要误差留在 other 里，
        // 「四轨相加 == 原音」就是恒等式（误差归位后只剩 float→16bit 的量化噪声），
        // 于是「原音」与「分轨」两条路可以无缝 A/B 对照。
        var vocalsLeft = separation.VocalsLeft;
        var vocalsRight = separation.VocalsRight;
        var foldPeak = 0f;
        var rawPeak = 0f;
        for (var i = 0; i < frames; i++)
        {
            var residualLeft = mixLeft[i] - (vocalsLeft[i] + drumLeft[i] + bassLeft[i] + otherLeft[i]);
            var residualRight = mixRight[i] - (vocalsRight[i] + drumRight[i] + bassRight[i] + otherRight[i]);
            rawPeak = MathF.Max(rawPeak, MathF.Max(MathF.Abs(residualLeft), MathF.Abs(residualRight)));
            otherLeft[i] += residualLeft;
            otherRight[i] += residualRight;
            foldPeak = MathF.Max(
                foldPeak,
                MathF.Max(
                    MathF.Abs(mixLeft[i] - (vocalsLeft[i] + drumLeft[i] + bassLeft[i] + otherLeft[i])),
                    MathF.Abs(mixRight[i] - (vocalsRight[i] + drumRight[i] + bassRight[i] + otherRight[i]))));
        }

        StemsWav.Write16(DrumsPath(trackDirectory, window), drumLeft, drumRight, frames);
        StemsWav.Write16(BassPath(trackDirectory, window), bassLeft, bassRight, frames);
        StemsWav.Write16(OtherPath(trackDirectory, window), otherLeft, otherRight, frames);

        // inst 由三轨求和生成，并顺手量一下与 mix − vocals 的残差，便于回归时确认恒等式没坏。
        var sumLeft = new float[frames];
        var sumRight = new float[frames];
        var residualPeak = 0f;
        for (var i = 0; i < frames; i++)
        {
            var left = drumLeft[i] + bassLeft[i] + otherLeft[i];
            var right = drumRight[i] + bassRight[i] + otherRight[i];
            sumLeft[i] = left;
            sumRight[i] = right;

            var residual = MathF.Max(
                MathF.Abs(left - separation.InstrumentalLeft[i]),
                MathF.Abs(right - separation.InstrumentalRight[i]));
            if (residual > residualPeak)
            {
                residualPeak = residual;
            }
        }

        StemsWav.Write16(InstrumentalPath(trackDirectory, window), sumLeft, sumRight, frames);
        reconErrorDbfs = ToDbfs(foldPeak);
        HostLog.Info(
            $"stems.inst-sum window={window} frames={frames} residualDbfs={ToDbfs(residualPeak):0.#} " +
            $"rawDbfs={ToDbfs(rawPeak):0.#} foldedDbfs={reconErrorDbfs:0.#}");
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

        // 源文件身份（T2-7）：同名文件被重导出/替换后 trackKey 不变、内容已经变了，
        // 必须按未命中重算，否则会把旧分轨发给新音频。
        if (!SourceMatches(request, meta))
        {
            return false;
        }

        var vocalsPath = VocalsPath(trackDirectory, request.Window);
        var instrumentalPath = InstrumentalPath(trackDirectory, request.Window);
        if (!File.Exists(vocalsPath) || !File.Exists(instrumentalPath))
        {
            return false;
        }

        // meta 里记录的轨数：旧 meta 缺键读成 2；4 轨请求遇到旧缓存直接判未命中，
        // 走重算而不是报错（T2-4），也不把不完整的 4 轨当结果发出去。
        if (request.FourStem && meta.Stems < StemSeparationResult.StemCount)
        {
            return false;
        }

        // 4 轨请求要求全套齐全：旧版本只算过 2 轨，缺 drums/bass/other 时按未命中处理，
        // 走重算而不是把不存在的文件当结果发出去。
        if (request.FourStem && !HasFourStem(trackDirectory, request.Window))
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
        // 命中即刷新目录时间戳：整曲目录级 LRU 用它判断「最久未访问」。
        StemCacheLru.Touch(trackDirectory);
        return true;
    }

    /// <summary>drums/bass/other 只存在于 4 轨缓存；vocals/instrumental 两代缓存都成立。</summary>
    internal static bool IsFourStemStem(string stem) => stem is "drums" or "bass" or "other";

    /// <summary>
    /// 落盘时的源文件身份：本地曲目取 FileInfo；在线曲目是临时下载文件、没有稳定身份，返回 null（T2-7）。
    /// </summary>
    private static FileInfo? ReadSourceIdentity(PreparedTrackAudio audio)
    {
        if (audio.IsTemporary || string.IsNullOrWhiteSpace(audio.AudioPath))
        {
            return null;
        }

        try
        {
            var info = new FileInfo(audio.AudioPath);
            return info.Exists ? info : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException
                                              or ArgumentException or NotSupportedException)
        {
            HostLog.Warn($"stems.source-info-failed path={audio.AudioPath}: {exception.Message}");
            return null;
        }
    }

    /// <summary>
    /// 缓存里的源文件身份是否仍与磁盘一致（T2-7）。同名文件被重导出/替换后 trackKey 并不变，
    /// 只靠路径键会一直命中旧分轨，所以这里比对字节数与修改时间（精确到 tick）。
    /// 旧 meta 缺这两个字段一律按未命中重算一次；取不到 FileInfo（文件没了/权限/网络盘）也不盲信缓存。
    /// 在线曲目是临时下载文件、没有稳定身份，保持旧行为（只校验模型/段长/轨数）。
    /// </summary>
    private bool SourceMatches(StemsRequest request, StemsMeta meta)
    {
        if (!string.Equals((request.Source ?? string.Empty).Trim(), "local", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (meta.SourceBytes <= 0 || meta.SourceModifiedUtc is null)
        {
            HostLog.Info(
                $"stems.cache-source-unknown key={meta.TrackKey} window={request.Window}: 旧 meta 没有源文件身份，按未命中重算");
            return false;
        }

        var path = _analysis?.ResolveLocalPath(request.Rel);
        if (string.IsNullOrWhiteSpace(path))
        {
            HostLog.Warn(
                $"stems.cache-source-unresolved key={meta.TrackKey} rel={request.Rel}: 无法解析源文件，按未命中处理");
            return false;
        }

        try
        {
            var info = new FileInfo(path);
            if (!info.Exists)
            {
                HostLog.Warn($"stems.cache-source-missing path={path}: 按未命中处理");
                return false;
            }

            if (info.Length != meta.SourceBytes || info.LastWriteTimeUtc != meta.SourceModifiedUtc.Value)
            {
                HostLog.Info(
                    $"stems.cache-stale key={meta.TrackKey} window={request.Window} " +
                    $"bytes={meta.SourceBytes}->{info.Length} " +
                    $"modified={meta.SourceModifiedUtc.Value:O}->{info.LastWriteTimeUtc:O}");
                return false;
            }

            return true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException
                                              or ArgumentException or NotSupportedException)
        {
            HostLog.Warn($"stems.cache-source-info-failed path={path}: {exception.Message}");
            return false;
        }
    }

    /// <summary>
    /// 4 轨是否齐全：drums/bass/other 都在，且帧数与 vocals 一致。缺一轨就返回 false，
    /// 让调用方按未命中重算（缓存里可能只有旧版写下的 2 轨）。
    /// </summary>
    private static bool HasFourStem(string trackDirectory, int window)
    {
        var vocalsFrames = StemsWav.ReadFrameCount(VocalsPath(trackDirectory, window));
        if (vocalsFrames <= 0)
        {
            return false;
        }

        return StemsWav.ReadFrameCount(DrumsPath(trackDirectory, window)) == vocalsFrames
            && StemsWav.ReadFrameCount(BassPath(trackDirectory, window)) == vocalsFrames
            && StemsWav.ReadFrameCount(OtherPath(trackDirectory, window)) == vocalsFrames;
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

        // drums/bass/other 只在 4 轨缓存里成立；meta 说是 2 轨就不算命中，
        // 由 ResolveAudio 转成 409 busy，避免把半套文件发出去。
        if (IsFourStemStem(stem) && meta.Stems < StemSeparationResult.StemCount)
        {
            return false;
        }

        // 源文件身份（T2-7）：与 TryReadCache 同一套判定，
        // 避免 /api/stems/audio 在源文件被替换后继续发旧分轨。
        if (!SourceMatches(request, meta))
        {
            return false;
        }

        // drums/bass/other 走各自的 wav；其余（含未知值）仍按旧行为落到 vocals，
        // 参数合法性由 LocalMusicServer 在入口处校验。
        var candidate = stem switch
        {
            "instrumental" => InstrumentalPath(trackDirectory, request.Window),
            "drums" => DrumsPath(trackDirectory, request.Window),
            "bass" => BassPath(trackDirectory, request.Window),
            "other" => OtherPath(trackDirectory, request.Window),
            _ => VocalsPath(trackDirectory, request.Window),
        };
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
        StemCacheLru.Touch(trackDirectory);
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

    /// <summary>预算由 StemCacheLru 统一解析（cache-policy.json 的 maxStemCacheMb / 环境变量 / 设置页）。</summary>
    private static long ReadCacheLimitBytes() => StemCacheLru.ResolveLimitBytes();

    private static string BuildTrackKey(StemsRequest request)
    {
        var source = (request.Source ?? string.Empty).Trim().ToLowerInvariant();
        return string.Equals(source, "local", StringComparison.Ordinal)
            ? "local:" + (request.Rel ?? string.Empty).Trim()
            : source + ":" + (request.TrackId ?? string.Empty).Trim();
    }

    // 4 轨与 2 轨分开单飞：否则 4 轨请求可能 join 到已在跑的 2 轨任务，
    // 拿到 ready 却没有 drums/bass/other 文件。
    private static string BuildFlightKey(string trackKey, StemsRequest request) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $"{trackKey}|{request.Window}|{request.WindowSec}|s{request.Stems}");

    private static string TrackDirectory(string trackKey) =>
        Path.Combine(CacheRoot, Sha1Hex(trackKey));

    private static string Sha1Hex(string value) =>
        Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static string VocalsPath(string directory, int window) =>
        Path.Combine(directory, string.Create(CultureInfo.InvariantCulture, $"w{window:D3}.vocals.wav"));

    private static string InstrumentalPath(string directory, int window) =>
        Path.Combine(directory, string.Create(CultureInfo.InvariantCulture, $"w{window:D3}.inst.wav"));

    private static string DrumsPath(string directory, int window) => StemPath(directory, window, "drums");

    private static string BassPath(string directory, int window) => StemPath(directory, window, "bass");

    private static string OtherPath(string directory, int window) => StemPath(directory, window, "other");

    /// <summary>4 轨 stem 的落盘路径：wNNN.drums.wav / wNNN.bass.wav / wNNN.other.wav。</summary>
    private static string StemPath(string directory, int window, string stem) =>
        Path.Combine(directory, string.Create(CultureInfo.InvariantCulture, $"w{window:D3}.{stem}.wav"));

    /// <summary>线性幅度转 dBFS，仅用于日志（0 → -inf）。</summary>
    private static double ToDbfs(float amplitude) =>
        amplitude <= 0f ? double.NegativeInfinity : 20d * Math.Log10(amplitude);

    /// <summary>
    /// 整曲目录级 LRU（T2-5）：按目录 LastWriteTimeUtc 从旧到新整目录删除，直到预算内。
    /// 正在计算的目录被 <see cref="StemCacheLru.Pin"/> 钉住，这里会跳过。
    /// </summary>
    private void PruneCache()
    {
        try
        {
            var limit = ReadCacheLimitBytes();
            var (removed, remaining) = StemCacheLru.Prune(CacheRoot, limit, StemCacheLru.IsPinned);
            if (removed > 0)
            {
                HostLog.Info($"stems.prune removed-dirs={removed} remaining={remaining} limit={limit}");
            }
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

    /// <summary>
    /// 任意声道数 → 交错立体声。
    /// 单声道复制；立体声直通；≥3 声道按「中置 −3 dB 混入、环绕 −3 dB 混入、LFE 丢弃」下混
    /// ——5.1 的声道序是 FL/FR/FC/LFE/BL/BR，只取前两声道会把中置（流行歌人声主体）整轨丢掉，
    /// 分离出的人声近乎空白，用户会以为模型没跑。
    /// </summary>
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
                else if (_channels == 2)
                {
                    left = _buffer[frame * _channels];
                    right = _buffer[frame * _channels + 1];
                }
                else
                {
                    var baseIndex = frame * _channels;
                    left = _buffer[baseIndex];
                    right = _buffer[baseIndex + 1];
                    // 中置（人声/主旋律）与环绕按 −3 dB（0.7071）混入；LFE（index 3）丢弃，
                    // 它的能量集中在 120 Hz 以下，混进来只会让分离器把低频当成人声残留。
                    if (_channels >= 3)
                    {
                        var center = _buffer[baseIndex + 2] * 0.7071f;
                        left += center;
                        right += center;
                    }

                    for (var channel = 4; channel < _channels; channel++)
                    {
                        var surround = _buffer[baseIndex + channel] * 0.7071f;
                        if ((channel & 1) == 0)
                        {
                            left += surround;
                        }
                        else
                        {
                            right += surround;
                        }
                    }
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
            // 唯一临时名：多实例/同一窗口被两条 flight 同时写时，共用 path+".tmp"
            // 会在 FileShare.None 上抛 IOException（被上层 catch 吞掉 → 缓存静默丢失），
            // finally 里的 TryDelete 还可能删掉别人正在写的文件。
            var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
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

