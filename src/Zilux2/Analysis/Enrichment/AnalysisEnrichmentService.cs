using System.Collections.Concurrent;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Zilux2.Stems;
using Zilux2.Storage;

namespace Zilux2.Analysis;

/// <summary>
/// /api/analysis 之后的异步增强流水线：分轨活动度（htdemucs）与 SSM 结构。
///
/// 设计约束（contract docs/zilux2-beat-analysis-contract.md）：
/// 1. 基础分析必须保持 ~1 s 同步返回，增强绝不阻塞它；
/// 2. 每个 stage 一个独立版本与独立缓存文件，升级只失效对应 stage；
/// 3. 单 worker、可取消、播放期线程受控；失败只降级，不影响基础分析。
/// </summary>
internal sealed class AnalysisEnrichmentService : IDisposable
{
    internal const string StemsStage = "stems";
    internal const string StructureStage = "structure";
    internal const string StyleStageName = "style";
    internal const string StemsVersion = "stems/v1";
    internal const string StructureVersion = "structure/ssm-v1";
    internal const string StyleVersion = "style/dsp-v1";

    private static readonly string[] DefaultStages = { StructureStage, StemsStage, StyleStageName };

    private readonly Func<string, string?, string?, string?, string, CancellationToken, Task<PreparedAudioOutcome>>
        _prepareAudio;

    private readonly Channel<EnrichmentJob> _queue = Channel.CreateUnbounded<EnrichmentJob>(
        new UnboundedChannelOptions { SingleReader = false, AllowSynchronousContinuations = false });
    /// <summary>
    /// 续接/生成过渡专用高优先级队列：换手前必须就绪，不能排在 stems 的 30–40 s 后面。
    /// 两条 worker 每个循环先看这里，空了再等普通队列。
    /// </summary>
    private readonly Channel<EnrichmentJob> _urgent = Channel.CreateUnbounded<EnrichmentJob>(
        new UnboundedChannelOptions { SingleReader = false, AllowSynchronousContinuations = false });

    private readonly CancellationTokenSource _shutdown = new();
    private readonly ConcurrentDictionary<string, TrackState> _states = new(StringComparer.Ordinal);
    /// <summary>
    /// 分离模型一次只能跑一个（内存 ~1 GB/实例）：两条 worker 里只有拿到闸门的那个能跑 stems，
    /// style/structure 这种秒级 stage 不会被 30–40 s 的分离堵住。
    /// </summary>
    private readonly SemaphoreSlim _stemGate = new(1, 1);
    private readonly List<Task> _workers = new();
    private int _disposed;

    internal AnalysisEnrichmentService(
        Func<string, string?, string?, string?, string, CancellationToken, Task<PreparedAudioOutcome>> prepareAudio)
    {
        _prepareAudio = prepareAudio;
        try
        {
            Directory.CreateDirectory(FeatureRoot);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"enrich.cache-unavailable: {exception.Message}");
        }

        // 两条 worker：分离与「秒级 stage」并行，style 不必再排在 40 s 的 stems 后面。
        _workers.Add(Task.Run(() => RunAsync(_shutdown.Token)));
        _workers.Add(Task.Run(() => RunAsync(_shutdown.Token)));
    }

    internal static string FeatureRoot => Path.Combine(HostFolders.Root, "analysis", "features");

    /// <summary>把「该曲目还需要哪些 stage」入队；重复调用幂等（同曲同 stage 只排一次）。</summary>
    internal void Request(AnalysisSuccessResponse response, AnalysisRequest request, string trackKey)
    {
        if (string.IsNullOrEmpty(trackKey))
        {
            return;
        }

        var state = _states.GetOrAdd(trackKey, _ => new TrackState());
        var jobs = new List<EnrichmentJob>(3);
        lock (state.Gate)
        {
            // 顺序即优先级（Channel 是 FIFO）：style 是 500 ms 网格的纯 DSP，
            //   ~1 s 就能出结果，必须排在 30–40 s 的分离前面，播放中才有风格可用。
            if (TryLoadStyle(trackKey, out _))
            {
                state.Status[StyleStageName] = "ready";
            }
            else if (state.Queued.Add(StyleStageName))
            {
                state.Status[StyleStageName] = "pending";
                jobs.Add(new EnrichmentJob
                {
                    Kind = EnrichmentJobKind.Style,
                    Request = ToEnrichmentRequest(request, trackKey, response.DurationMs),
                });
            }

            if (TryLoadStructure(trackKey, out _))
            {
                state.Status[StructureStage] = "ready";
            }
            else if (state.Queued.Add(StructureStage))
            {
                state.Status[StructureStage] = "pending";
                jobs.Add(new EnrichmentJob
                {
                    Kind = EnrichmentJobKind.Structure,
                    Request = ToEnrichmentRequest(request, trackKey, response.DurationMs),
                    Payload = response.Analysis,
                });
            }

            if (!StemSeparationService.ModelExists())
            {
                state.Status[StemsStage] = "unavailable";
            }
            else if (TryLoadStems(trackKey, out _))
            {
                state.Status[StemsStage] = "ready";
            }
            else if (state.Queued.Add(StemsStage))
            {
                state.Status[StemsStage] = "pending";
                jobs.Add(new EnrichmentJob
                {
                    Kind = EnrichmentJobKind.Stems,
                    Request = ToEnrichmentRequest(request, trackKey, response.DurationMs),
                });
            }

        }

        foreach (var job in jobs)
        {
            _queue.Writer.TryWrite(job);
        }
    }

    /// <summary>读取已就绪的 stage；未就绪的放进 Pending，unavailable/failed 不计入。</summary>
    internal AnalysisFeaturesResponse Get(
        string trackKey,
        string[]? stages,
        long extendStartMs = 0,
        int extendMs = 0,
        string? extendMode = null)
    {
        var wanted = NormalizeStages(stages);
        var response = new AnalysisFeaturesResponse { TrackKey = trackKey };
        var features = new AnalysisFeatures();
        var readyVersions = new List<string>(2);
        var pending = new List<string>(2);
        var state = _states.TryGetValue(trackKey, out var known) ? known : null;

        foreach (var stage in wanted)
        {
            string status;
            switch (stage)
            {
                case StructureStage:
                    if (TryLoadStructure(trackKey, out var structure))
                    {
                        features.Structure = structure;
                        status = "ready";
                        readyVersions.Add(StructureVersion);
                    }
                    else
                    {
                        status = StateOf(state, stage);
                    }

                    break;

                case StemsStage:
                    if (!StemSeparationService.ModelExists())
                    {
                        status = "unavailable";
                    }
                    else if (TryLoadStems(trackKey, out var stems))
                    {
                        features.Stems = stems;
                        status = "ready";
                        readyVersions.Add(StemsVersion);
                    }
                    else
                    {
                        status = StateOf(state, stage);
                    }

                    break;

                case StyleStageName:
                    if (TryLoadStyle(trackKey, out var style))
                    {
                        features.Style = style;
                        status = "ready";
                        readyVersions.Add(StyleVersion);
                    }
                    else
                    {
                        status = StateOf(state, stage);
                    }

                    break;

                default:
                    status = "unknown";
                    break;
            }

            response.Status[stage] = status;
            if (status is "pending" or "running")
            {
                pending.Add(stage);
            }
        }

        features.Version = string.Join(';', readyVersions);
        response.Features = readyVersions.Count > 0 ? features : null;
        response.Pending = pending.Distinct(StringComparer.Ordinal).ToArray();
        return response;
    }

    /// <summary>基础分析响应里顺带回填已就绪的增强结果（没有就保持 null）。</summary>
    internal void Attach(AnalysisSuccessResponse response, string trackKey)
    {
        if (string.IsNullOrEmpty(trackKey))
        {
            return;
        }

        response.Features = Get(trackKey, null).Features;
    }

    private async Task RunAsync(CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                EnrichmentJob job;
                if (_urgent.Reader.TryRead(out var urgent))
                {
                    job = urgent;
                }
                else
                {
                    var pending = _queue.Reader.ReadAsync(token).AsTask();
                    var tick = Task.Delay(250, token);
                    if (await Task.WhenAny(pending, tick).ConfigureAwait(false) != pending)
                    {
                        continue;
                    }
                    job = await pending.ConfigureAwait(false);
                }
                await ExecuteAsync(job, token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            // 宿主关闭：正在跑的窗口由 token 取消，已写好的 stage 文件保留。
        }
        catch (Exception exception)
        {
            HostLog.Error("enrich.worker-failed", exception);
        }
    }

    private async Task ExecuteAsync(EnrichmentJob job, CancellationToken token)
    {
        var trackKey = job.Request.TrackKey;
        var state = _states.GetOrAdd(trackKey, _ => new TrackState());
        var stage = job.Kind switch
        {
            EnrichmentJobKind.Stems => StemsStage,
            EnrichmentJobKind.Style => StyleStageName,
            _ => StructureStage,
        };
        SetStatus(state, stage, "running");
        try
        {
            if (job.Kind == EnrichmentJobKind.Structure)
            {
                var payload = StructureSsm.Analyze(job.Payload ?? new BeatAnalysisPayload(), job.Request.DurationMs);
                if (payload is null)
                {
                    SetStatus(state, stage, "failed");
                    HostLog.Warn($"enrich.structure.skip key={trackKey} reason=no-boundaries");
                    return;
                }

                WriteStructure(trackKey, payload);
                SetStatus(state, stage, "ready");
                HostLog.Info(
                    $"enrich.structure.done key={trackKey} source={payload.Source} " +
                    $"sections={payload.Sections.Length} bars={payload.BarCount}");
                return;
            }

            if (job.Kind == EnrichmentJobKind.Style)
            {
                var styleDirectory = Path.Combine(FeatureRoot, "tmp", HashKey(trackKey) + "-style");
                PreparedTrackAudio? styleAudio = null;
                try
                {
                    var prepared = await _prepareAudio(
                            job.Request.Source,
                            job.Request.TrackId,
                            job.Request.Rel,
                            job.Request.Quality,
                            styleDirectory,
                            token)
                        .ConfigureAwait(false);
                    if (!prepared.Ok || prepared.Audio is null)
                    {
                        SetStatus(state, stage, "failed");
                        HostLog.Warn(
                            $"enrich.style.prepare-failed key={trackKey} code={prepared.Code} message={prepared.Message}");
                        return;
                    }

                    styleAudio = prepared.Audio;
                    var analyzed = styleAudio.AudioPath;
                    var payload = await Task.Run(() => StyleStage.Analyze(analyzed, token), token)
                        .ConfigureAwait(false);
                    if (payload is null)
                    {
                        SetStatus(state, stage, "failed");
                        HostLog.Warn($"enrich.style.skip key={trackKey} reason=no-audio");
                        return;
                    }

                    WriteStyle(trackKey, payload);
                    SetStatus(state, stage, "ready");
                    HostLog.Info(
                        $"enrich.style.done key={trackKey} frames={payload.CentroidHz.Length} " +
                        $"source={payload.Source} dynamic={payload.DynamicRangeLu:0.0}LU");
                }
                finally
                {
                    if (styleAudio?.IsTemporary == true)
                    {
                        TryDeleteDirectory(styleDirectory);
                    }
                }

                return;
            }

            var tempDirectory = Path.Combine(FeatureRoot, "tmp", HashKey(trackKey));
            // 模型不随包 / 被删时这不是错误，是能力缺失：标 unavailable，别把队列刷成失败。
            if (!StemSeparationService.ModelExists())
            {
                SetStatus(state, stage, "unavailable");
                HostLog.Warn($"enrich.stems.unavailable key={trackKey} reason=model-missing");
                return;
            }

            PreparedTrackAudio? audio = null;
            await _stemGate.WaitAsync(token).ConfigureAwait(false);
            try
            {
                var prepared = await _prepareAudio(
                        job.Request.Source,
                        job.Request.TrackId,
                        job.Request.Rel,
                        job.Request.Quality,
                        tempDirectory,
                        token)
                    .ConfigureAwait(false);
                if (!prepared.Ok || prepared.Audio is null)
                {
                    SetStatus(state, stage, "failed");
                    HostLog.Warn(
                        $"enrich.stems.prepare-failed key={trackKey} code={prepared.Code} message={prepared.Message}");
                    return;
                }

                audio = prepared.Audio;
                var payload = await Task.Run(() => StemActivityAnalyzer.Analyze(audio.AudioPath, token), token)
                    .ConfigureAwait(false);
                WriteStems(trackKey, payload);
                SetStatus(state, stage, "ready");
                HostLog.Info(
                    $"enrich.stems.done key={trackKey} durationMs={payload.DurationMs} " +
                    $"buckets={payload.Vocal.Length} model={ShortSha(payload.ModelSha256)}");
            }
            finally
            {
                if (audio?.IsTemporary == true)
                {
                    TryDeleteDirectory(tempDirectory);
                }

                _stemGate.Release();
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            SetStatus(state, stage, "pending");
            throw;
        }
        catch (Exception exception)
        {
            SetStatus(state, stage, "failed");
            HostLog.Warn($"enrich.{stage}.failed key={trackKey}: {exception.Message}");
        }
        finally
        {
            lock (state.Gate)
            {
                state.Queued.Remove(stage);
            }
        }
    }

    private static EnrichmentRequest ToEnrichmentRequest(AnalysisRequest request, string trackKey, long durationMs) =>
        new(request.Source, request.TrackId, request.Rel, request.Quality, trackKey, durationMs);

    private static void SetStatus(TrackState state, string stage, string status)
    {
        lock (state.Gate)
        {
            state.Status[stage] = status;
        }
    }

    private static string StateOf(TrackState? state, string stage)
    {
        if (state is null)
        {
            return "pending";
        }

        lock (state.Gate)
        {
            return state.Status.TryGetValue(stage, out var status) ? status : "pending";
        }
    }

    private static string[] NormalizeStages(string[]? stages)
    {
        if (stages is null || stages.Length == 0)
        {
            return DefaultStages;
        }

        var result = new List<string>(stages.Length);
        foreach (var raw in stages)
        {
            var stage = (raw ?? string.Empty).Trim().ToLowerInvariant();
            if (stage.Length > 0 && !result.Contains(stage, StringComparer.Ordinal))
            {
                result.Add(stage);
            }
        }

        return result.Count > 0 ? result.ToArray() : DefaultStages;
    }

    private static bool TryLoadStems(string trackKey, out StemActivityPayload? payload)
    {
        payload = null;
        var file = TryReadStageFile(trackKey, StemsStage, AnalysisJsonContext.Default.StemFeatureFile);
        if (file is null || !string.Equals(file.StageVersion, StemsVersion, StringComparison.Ordinal))
        {
            return false;
        }

        payload = file.Payload;
        return true;
    }

    private static bool TryLoadStructure(string trackKey, out StructureFeaturePayload? payload)
    {
        payload = null;
        var file = TryReadStageFile(trackKey, StructureStage, AnalysisJsonContext.Default.StructureFeatureFile);
        if (file is null || !string.Equals(file.StageVersion, StructureVersion, StringComparison.Ordinal))
        {
            return false;
        }

        payload = file.Payload;
        return true;
    }

    private static T? TryReadStageFile<T>(string trackKey, string stage, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> typeInfo)
        where T : class
    {
        try
        {
            var path = StagePath(trackKey, stage);
            if (!File.Exists(path))
            {
                return null;
            }

            var json = File.ReadAllText(path, Encoding.UTF8);
            return JsonSerializer.Deserialize(json, typeInfo);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"enrich.read-failed stage={stage} key={trackKey}: {exception.Message}");
            return null;
        }
    }

    private static void WriteStems(string trackKey, StemActivityPayload payload)
    {
        var file = new StemFeatureFile
        {
            StageVersion = StemsVersion,
            InputKey = trackKey,
            ModelSha256 = payload.ModelSha256,
            CreatedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Payload = payload,
        };
        WriteStageFile(trackKey, StemsStage, JsonSerializer.Serialize(file, AnalysisJsonContext.Default.StemFeatureFile));
    }

    private static void WriteStructure(string trackKey, StructureFeaturePayload payload)
    {
        var file = new StructureFeatureFile
        {
            StageVersion = StructureVersion,
            InputKey = trackKey,
            CreatedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Payload = payload,
        };
        WriteStageFile(
            trackKey,
            StructureStage,
            JsonSerializer.Serialize(file, AnalysisJsonContext.Default.StructureFeatureFile));
    }

    private static bool TryLoadStyle(string trackKey, out StyleProfilePayload? payload)
    {
        var file = TryReadStageFile(trackKey, StyleStageName, AnalysisJsonContext.Default.StyleFeatureFile);
        payload = null;
        if (file is null || !string.Equals(file.StageVersion, StyleVersion, StringComparison.Ordinal))
        {
            return false;
        }

        payload = file.Payload;
        return true;
    }

    private static void WriteStyle(string trackKey, StyleProfilePayload payload)
    {
        var file = new StyleFeatureFile
        {
            StageVersion = StyleVersion,
            InputKey = trackKey,
            CreatedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Payload = payload,
        };
        WriteStageFile(
            trackKey,
            StyleStageName,
            JsonSerializer.Serialize(file, AnalysisJsonContext.Default.StyleFeatureFile));
    }



    /// <summary>把契约里的 analysis 相对路径（features/&lt;hash&gt;/…）解析成绝对路径。</summary>
    private static string? ResolveAnalysisRelative(string relative)
    {
        if (string.IsNullOrWhiteSpace(relative))
        {
            return null;
        }

        if (Path.IsPathRooted(relative))
        {
            return relative;
        }

        var analysisRoot = Path.GetDirectoryName(FeatureRoot)!;
        return Path.Combine(analysisRoot, relative.Replace('/', Path.DirectorySeparatorChar));
    }


    private static void WriteStageFile(string trackKey, string stage, string json)
    {
        var path = StagePath(trackKey, stage);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        AtomicFile.WriteAllText(path, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    }

    private static string StagePath(string trackKey, string stage) =>
        Path.Combine(FeatureRoot, HashKey(trackKey), stage + ".json");

    internal static string HashKey(string value)
    {
        var bytes = SHA1.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(bytes.AsSpan(0, 8)).ToLowerInvariant();
    }

    private static string ShortSha(string sha) => sha.Length <= 8 ? sha : sha[..8];

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"enrich.tmp-cleanup-failed {path}: {exception.Message}");
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        try
        {
            _shutdown.Cancel();
            _queue.Writer.TryComplete();
            _urgent.Writer.TryComplete();
            try
            {
                Task.WaitAll(_workers.ToArray(), TimeSpan.FromSeconds(3));
            }
            catch (AggregateException)
            {
                // worker 被取消时抛出的是预期内的 OperationCanceledException。
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"enrich.dispose: {exception.Message}");
        }
        finally
        {
            _shutdown.Dispose();
        }
    }

    private sealed class TrackState
    {
        public object Gate { get; } = new();

        public HashSet<string> Queued { get; } = new(StringComparer.Ordinal);

        public Dictionary<string, string> Status { get; } = new(StringComparer.Ordinal);
    }
}
