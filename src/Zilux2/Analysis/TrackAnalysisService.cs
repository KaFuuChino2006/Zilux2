using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Zilux2.Local;
using Zilux2.Online;

namespace Zilux2.Analysis;

/// <summary>
/// Owns the offline beat-analysis pipeline behind /api/analysis: resolve + fetch the audio,
/// decode it, analyze it, and cache both the audio and the JSON result under
/// %LOCALAPPDATA%\Zilux2\analysis (contract §2). Also implements same-track single-flight so two
/// page requests for one song never download/analyze it twice.
/// </summary>
internal sealed class TrackAnalysisService : IDisposable
{
    private const long CacheLimitBytes = 300L * 1024 * 1024;
    private const long MinAudioBytes = 64L * 1024;
    private static readonly TimeSpan ResolveTimeout = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan DownloadTimeout = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan AnalyzeTimeout = TimeSpan.FromSeconds(60);

    private readonly IReadOnlyDictionary<string, IOnlineMusicProvider> _providers;
    private readonly Func<string?>? _qualityProvider;
    private readonly Func<string?, string?>? _localPathResolver;
    private readonly ConcurrentDictionary<string, Lazy<Task<AnalysisOutcome>>> _inflight = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _shutdown = new();
    private int _disposed;

    internal TrackAnalysisService(
        IReadOnlyDictionary<string, IOnlineMusicProvider> providers,
        Func<string?>? qualityProvider,
        Func<string?, string?>? localPathResolver)
    {
        _providers = providers;
        _qualityProvider = qualityProvider;
        _localPathResolver = localPathResolver;
        try
        {
            Directory.CreateDirectory(AudioCacheDirectory);
            Directory.CreateDirectory(JsonCacheDirectory);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"analysis.cache-unavailable: {exception.Message}");
        }
    }

    private static string CacheRoot { get; } = Path.Combine(HostFolders.Root, "analysis");

    private static string AudioCacheDirectory { get; } = Path.Combine(CacheRoot, "audio");

    private static string JsonCacheDirectory { get; } = Path.Combine(CacheRoot, "json");

    internal async Task<AnalysisOutcome> AnalyzeAsync(AnalysisRequest request, CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _disposed) == 1)
        {
            return AnalysisOutcome.Failure("internal-error", "宿主正在关闭");
        }

        var flightKey = BuildFlightKey(request);
        var lazy = _inflight.GetOrAdd(
            flightKey,
            _ => new Lazy<Task<AnalysisOutcome>>(
                () => Task.Run(() => RunAsync(request, flightKey)),
                LazyThreadSafetyMode.ExecutionAndPublication));
        Task<AnalysisOutcome> task;
        try
        {
            task = lazy.Value;
        }
        catch (Exception exception)
        {
            _inflight.TryRemove(new KeyValuePair<string, Lazy<Task<AnalysisOutcome>>>(flightKey, lazy));
            HostLog.Error($"analysis.scheduler-failed key={flightKey}", exception);
            return AnalysisOutcome.Failure("internal-error", "节拍分析启动失败");
        }

        try
        {
            return await task.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // The caller went away; the shared job keeps running so its result still lands in cache.
            throw;
        }
        finally
        {
            if (!lazy.IsValueCreated)
            {
                _inflight.TryRemove(new KeyValuePair<string, Lazy<Task<AnalysisOutcome>>>(flightKey, lazy));
            }
            else
            {
                var shared = lazy.Value;
                var pair = new KeyValuePair<string, Lazy<Task<AnalysisOutcome>>>(flightKey, lazy);
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

    private static string BuildFlightKey(AnalysisRequest request) =>
        string.Equals(request.Source, "local", StringComparison.OrdinalIgnoreCase)
            ? "local:" + (request.Rel ?? string.Empty).Trim()
            : request.Source + ":" + (request.TrackId ?? string.Empty).Trim();

    private async Task<AnalysisOutcome> RunAsync(AnalysisRequest request, string flightKey)
    {
        var stopwatch = Stopwatch.StartNew();
        var source = (request.Source ?? string.Empty).Trim().ToLowerInvariant();
        HostLog.Info($"analysis.start source={source} key={flightKey} force={request.Force}");
        try
        {
            string audioPath;
            string title = string.Empty;
            string artist = string.Empty;
            var trackId = string.Empty;
            var rel = string.Empty;
            string cacheKey;

            if (string.Equals(source, "local", StringComparison.OrdinalIgnoreCase))
            {
                rel = (request.Rel ?? string.Empty).Trim();
                var resolved = _localPathResolver?.Invoke(rel);
                if (string.IsNullOrEmpty(resolved))
                {
                    return Fail(flightKey, "not-found", "找不到本地音频文件");
                }

                audioPath = resolved;
                cacheKey = BuildLocalCacheKey(rel, resolved);
                if (!request.Force && TryReadCached(cacheKey, stopwatch, out var localCached))
                {
                    return localCached!;
                }

                try
                {
                    var tags = LocalTagReader.TryRead(audioPath);
                    title = tags?.Title ?? Path.GetFileNameWithoutExtension(audioPath);
                    artist = tags?.Artist ?? string.Empty;
                }
                catch (Exception exception)
                {
                    HostLog.Warn($"analysis.tag-read-failed {audioPath}: {exception.Message}");
                    title = Path.GetFileNameWithoutExtension(audioPath);
                }
            }
            else
            {
                if (!_providers.TryGetValue(source, out var provider))
                {
                    return Fail(flightKey, "not-found", "暂不支持该音乐平台");
                }

                trackId = (request.TrackId ?? string.Empty).Trim();
                cacheKey = $"{source}:{trackId}:{BeatAnalyzer.AnalyzerVersion}";
                if (!request.Force && TryReadCached(cacheKey, stopwatch, out var onlineCached))
                {
                    return onlineCached!;
                }

                audioPath = Path.Combine(AudioCacheDirectory, HashFileName($"{source}:{trackId}") + ".audio");
                if (!File.Exists(audioPath) || new FileInfo(audioPath).Length < MinAudioBytes)
                {
                    var resolution = await ResolveStreamAsync(provider, source, trackId, request.Quality).ConfigureAwait(false);
                    if (!resolution.IsPlayable)
                    {
                        var message = string.IsNullOrWhiteSpace(resolution.NotPlayableMessage)
                            ? "该曲目当前不可播放"
                            : resolution.NotPlayableMessage;
                        return Fail(flightKey, "not-playable", message);
                    }

                    await DownloadAudioAsync(resolution, audioPath, flightKey).ConfigureAwait(false);
                }
            }

            var decoded = await DecodeAsync(audioPath, flightKey).ConfigureAwait(false);
            if (decoded is null)
            {
                return Fail(flightKey, "decode-failed", "系统解码器无法解析该音频");
            }

            var analysis = await AnalyzePayloadAsync(decoded, flightKey).ConfigureAwait(false);
            if (analysis is null)
            {
                return Fail(flightKey, "timeout", "节拍分析超时");
            }

            var warnings = new List<string>(analysis.Warnings);
            if (decoded.SourceChannels > 1)
            {
                warnings.Add("mono-mix");
            }

            if (decoded.Truncated)
            {
                warnings.Add("truncated");
            }

            analysis.Warnings = warnings.Distinct(StringComparer.Ordinal).ToArray();
            var response = new AnalysisSuccessResponse
            {
                V = 1,
                Ok = true,
                Source = source,
                TrackId = trackId,
                Rel = rel,
                Title = title,
                Artist = artist,
                DurationMs = decoded.DurationMs,
                Cached = false,
                ElapsedMs = stopwatch.ElapsedMilliseconds,
                Analyzer = BeatAnalyzer.AnalyzerVersion,
                Analysis = analysis,
            };

            WriteJsonCache(cacheKey, response);
            HostLog.Info(
                $"analysis.done cached=false source={source} key={flightKey} bpm={analysis.Bpm:0.##} " +
                $"meter={analysis.Meter} beats={analysis.Downbeats.Length} elapsedMs={stopwatch.ElapsedMilliseconds}");
            PruneCacheInBackground();
            return AnalysisOutcome.Success(response);
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
            return Fail(flightKey, "internal-error", "宿主正在关闭");
        }
        catch (AnalysisException exception)
        {
            return Fail(flightKey, exception.Code, exception.Message);
        }
        catch (Exception exception)
        {
            HostLog.Error($"analysis.fail key={flightKey} code=internal-error", exception);
            return Fail(flightKey, "internal-error", "节拍分析失败：" + exception.Message);
        }
    }

    private AnalysisOutcome Fail(string flightKey, string code, string message)
    {
        HostLog.Warn($"analysis.fail key={flightKey} code={code} message={message}");
        return AnalysisOutcome.Failure(code, message);
    }

    private static string BuildLocalCacheKey(string rel, string path)
    {
        try
        {
            var info = new FileInfo(path);
            return string.Create(
                CultureInfo.InvariantCulture,
                $"local:{rel}:{info.Length}:{info.LastWriteTimeUtc.Ticks}:{BeatAnalyzer.AnalyzerVersion}");
        }
        catch
        {
            return $"local:{rel}:{BeatAnalyzer.AnalyzerVersion}";
        }
    }

    private static bool TryReadCached(string cacheKey, Stopwatch stopwatch, out AnalysisOutcome? outcome)
    {
        outcome = null;
        var path = Path.Combine(JsonCacheDirectory, HashFileName(cacheKey) + ".json");
        if (!File.Exists(path))
        {
            return false;
        }

        try
        {
            var json = File.ReadAllText(path);
            var response = JsonSerializer.Deserialize(json, AnalysisJsonContext.Default.AnalysisSuccessResponse);
            if (response is null ||
                !response.Ok ||
                !string.Equals(response.Analyzer, BeatAnalyzer.AnalyzerVersion, StringComparison.Ordinal))
            {
                return false;
            }

            response.Cached = true;
            response.ElapsedMs = stopwatch.ElapsedMilliseconds;
            HostLog.Info($"analysis.done cached=true key={cacheKey} bpm={response.Analysis.Bpm:0.##} elapsedMs={response.ElapsedMs}");
            outcome = AnalysisOutcome.Success(response);
            return true;
        }
        catch (Exception exception)
        {
            HostLog.Warn($"analysis.cache-read-failed key={cacheKey}: {exception.Message}");
            return false;
        }
    }

    private static void WriteJsonCache(string cacheKey, AnalysisSuccessResponse response)
    {
        try
        {
            Directory.CreateDirectory(JsonCacheDirectory);
            var path = Path.Combine(JsonCacheDirectory, HashFileName(cacheKey) + ".json");
            var temp = path + ".tmp";
            var json = JsonSerializer.Serialize(response, AnalysisJsonContext.Default.AnalysisSuccessResponse);
            File.WriteAllText(temp, json, Encoding.UTF8);
            File.Move(temp, path, overwrite: true);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"analysis.cache-write-failed key={cacheKey}: {exception.Message}");
        }
    }

    private async Task<StreamResolution> ResolveStreamAsync(
        IOnlineMusicProvider provider,
        string source,
        string trackId,
        string? quality)
    {
        var resolvedQuality = NormalizeQuality(
            string.IsNullOrWhiteSpace(quality) ? _qualityProvider?.Invoke() : quality);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
        timeout.CancelAfter(ResolveTimeout);
        try
        {
            HostLog.Info($"analysis.resolve source={source} id={trackId} quality={resolvedQuality}");
            return await provider.ResolveStreamAsync(trackId, resolvedQuality, timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!_shutdown.IsCancellationRequested)
        {
            throw new AnalysisException("upstream-failed", "获取播放地址超时，请稍后重试");
        }
        catch (Exception exception) when (exception is not AnalysisException)
        {
            HostLog.Warn($"analysis.resolve-failed source={source} id={trackId}: {exception.Message}");
            throw new AnalysisException("upstream-failed", "获取播放地址失败：" + OnlineHttp.Describe(exception));
        }
    }

    private async Task DownloadAudioAsync(StreamResolution resolution, string targetPath, string flightKey)
    {
        if (string.IsNullOrWhiteSpace(resolution.Url))
        {
            throw new AnalysisException("upstream-failed", "音频源没有返回播放地址");
        }

        Directory.CreateDirectory(AudioCacheDirectory);
        var temp = targetPath + ".part";
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, resolution.Url);
            foreach (var header in resolution.Headers)
            {
                request.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
            timeout.CancelAfter(DownloadTimeout);
            using var response = await OnlineHttp.Client
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token)
                .ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new AnalysisException("upstream-failed", $"音频源返回 HTTP {(int)response.StatusCode}");
            }

            var received = 0L;
            await using (var input = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false))
            await using (var output = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None, 64 * 1024, useAsync: true))
            {
                var buffer = new byte[64 * 1024];
                int read;
                while ((read = await input.ReadAsync(buffer, timeout.Token).ConfigureAwait(false)) > 0)
                {
                    await output.WriteAsync(buffer.AsMemory(0, read), timeout.Token).ConfigureAwait(false);
                    received += read;
                }
            }

            if (received < MinAudioBytes)
            {
                throw new AnalysisException("upstream-failed", "下载内容过小，可能不是可播放的音频");
            }

            File.Move(temp, targetPath, overwrite: true);
            HostLog.Info($"analysis.download key={flightKey} bytes={received}");
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            throw new AnalysisException("timeout", "下载音频超时，请稍后重试");
        }
        catch (HttpRequestException exception)
        {
            throw new AnalysisException("upstream-failed", "音频源连接失败：" + OnlineHttp.Describe(exception));
        }
        finally
        {
            TryDelete(temp);
        }
    }

    private async Task<DecodedTrack?> DecodeAsync(string audioPath, string flightKey)
    {
        var result = await Task.Run(
            () =>
            {
                var track = TrackAudioDecoder.TryDecode(audioPath, out var error);
                return (track, error);
            }).ConfigureAwait(false);

        if (result.track is null)
        {
            HostLog.Warn($"analysis.fail key={flightKey} code=decode-failed detail={result.error}");
            return null;
        }

        HostLog.Info(
            $"analysis.decode key={flightKey} samples={result.track.Samples.Length} " +
            $"sr={result.track.SampleRate} channels={result.track.SourceChannels} " +
            $"durationMs={result.track.DurationMs} truncated={result.track.Truncated}");
        return result.track;
    }

    private async Task<BeatAnalysisPayload?> AnalyzePayloadAsync(DecodedTrack decoded, string flightKey)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token);
        timeout.CancelAfter(AnalyzeTimeout);
        try
        {
            return await Task.Run(
                () => BeatAnalyzer.Analyze(decoded.Samples, decoded.SampleRate),
                timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            HostLog.Warn($"analysis.timeout key={flightKey}");
            return null;
        }
    }

    private static string NormalizeQuality(string? quality)
    {
        var trimmed = (quality ?? string.Empty).Trim().ToLowerInvariant();
        return trimmed is "standard" or "high" or "lossless" ? trimmed : "high";
    }

    private static void PruneCacheInBackground()
    {
        _ = Task.Run(() =>
        {
            try
            {
                PruneCache();
            }
            catch (Exception exception)
            {
                HostLog.Warn($"analysis.cache-prune-failed: {exception.Message}");
            }
        });
    }

    private static void PruneCache()
    {
        var files = new List<FileInfo>();
        foreach (var directory in new[] { AudioCacheDirectory, JsonCacheDirectory })
        {
            if (!Directory.Exists(directory))
            {
                continue;
            }

            files.AddRange(new DirectoryInfo(directory).EnumerateFiles());
        }

        var total = files.Sum(file => file.Length);
        if (total <= CacheLimitBytes)
        {
            return;
        }

        var removed = 0;
        foreach (var file in files.OrderBy(file => file.LastWriteTimeUtc))
        {
            if (total <= CacheLimitBytes)
            {
                break;
            }

            try
            {
                var length = file.Length;
                file.Delete();
                total -= length;
                removed++;
            }
            catch
            {
                // A file in use by another analysis merely delays eviction.
            }
        }

        if (removed > 0)
        {
            HostLog.Info($"analysis.cache-evicted removed={removed} totalNow={total} bytes");
        }
    }

    private static string HashFileName(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()[..32];

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
            // Best effort: a stale .part is overwritten next time.
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1)
        {
            return;
        }

        try
        {
            _shutdown.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // Already torn down.
        }

        _shutdown.Dispose();
        HostLog.Info("analysis.disposed");
    }

    /// <summary>Carries one contract error code out of the pipeline without a stack trace.</summary>
    private sealed class AnalysisException : Exception
    {
        internal AnalysisException(string code, string message) : base(message) => Code = code;

        internal string Code { get; }
    }
}
