using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Zilux2.Online;

/// <summary>页面 <c>/api/download</c> 返回的下载任务状态。</summary>
internal sealed class DownloadJob
{
    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

    [JsonPropertyName("trackId")] public string TrackId { get; init; } = string.Empty;

    [JsonPropertyName("title")] public string Title { get; set; } = string.Empty;

    [JsonPropertyName("artist")] public string Artist { get; set; } = string.Empty;

    /// <summary>实际请求的音质（standard/high/lossless，平台不支持时会自动降级）。</summary>
    [JsonPropertyName("quality")] public string Quality { get; set; } = "high";

    /// <summary>running / paused / done / error</summary>
    [JsonPropertyName("state")] public string State { get; set; } = "running";

    [JsonPropertyName("received")] public long Received { get; set; }

    [JsonPropertyName("total")] public long Total { get; set; }

    [JsonPropertyName("fileName")] public string FileName { get; set; } = string.Empty;

    [JsonPropertyName("path")] public string? Path { get; set; }

    [JsonPropertyName("error")] public string? Error { get; set; }

    [JsonPropertyName("startedAt")] public long StartedAt { get; init; } = Environment.TickCount64;
}

internal sealed class DownloadListResponse
{
    [JsonPropertyName("directory")] public string Directory { get; init; } = string.Empty;

    [JsonPropertyName("jobs")] public List<DownloadJob> Jobs { get; init; } = [];
}

internal sealed class DownloadStartResponse
{
    [JsonPropertyName("directory")] public string Directory { get; init; } = string.Empty;

    [JsonPropertyName("job")] public DownloadJob Job { get; init; } = new();
}

/// <summary>
/// 在线歌曲下载：把解析出来的播放地址整首拉到本地文件（网易云 / QQ / 酷狗 / 无名音乐都走这里）。
/// 下载目录由设置页决定，默认 Windows 音乐目录；完成后回调宿主，触发本地曲库刷新。
/// </summary>
internal sealed class DownloadService : IDisposable
{
    private const long MinValidBytes = 32L * 1024;
    private const int MaxRememberedJobs = 40;

    private static Regex? _unsafeFileNameChars;
    private static HttpClient? _client;

    private static Regex UnsafeFileNameChars => _unsafeFileNameChars ??= CreateUnsafeRegex();

    private static HttpClient Client => _client ??= CreateClient();

    private static Regex CreateUnsafeRegex()
    {
        try
        {
            return new Regex("[\\\\/:*?\"<>|\\p{Cc}]", RegexOptions.Compiled);
        }
        catch (Exception exception)
        {
            HostLog.Error("[download] regex init failed", exception);
            throw;
        }
    }

    private readonly Func<string?>? _directoryProvider;
    private readonly Func<string?>? _qualityProvider;
    private readonly Action<string>? _fileReady;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly ConcurrentDictionary<string, DownloadJob> _jobs = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, DownloadControl> _controls = new(StringComparer.Ordinal);
    private int _disposed;

    public DownloadService(
        Func<string?>? directoryProvider,
        Func<string?>? qualityProvider = null,
        Action<string>? fileReady = null)
    {
        _directoryProvider = directoryProvider;
        _qualityProvider = qualityProvider;
        _fileReady = fileReady;
    }

    /// <summary>Windows 的「音乐」目录；极端情况下退回到本机数据目录。</summary>
    public static string DefaultDirectory()
    {
        var music = Environment.GetFolderPath(Environment.SpecialFolder.MyMusic);
        return string.IsNullOrWhiteSpace(music) ? Path.Combine(HostFolders.Root, "Music") : music;
    }

    public string Directory
    {
        get
        {
            var custom = _directoryProvider?.Invoke();
            if (!string.IsNullOrWhiteSpace(custom))
            {
                try
                {
                    return System.IO.Path.GetFullPath(custom.Trim());
                }
                catch
                {
                    // 非法路径回退默认目录，下载本身不该因为一个坏设置整体不可用。
                }
            }

            return DefaultDirectory();
        }
    }

    public DownloadJob Start(IOnlineMusicProvider provider, string trackId, string? title, string? artist, string? quality = null)
    {
        var resolvedQuality = NormalizeQuality(
            string.IsNullOrWhiteSpace(quality) ? _qualityProvider?.Invoke() : quality);
        var job = new DownloadJob
        {
            Id = Guid.NewGuid().ToString("n")[..12],
            Source = provider.Name,
            TrackId = trackId,
            Title = (title ?? string.Empty).Trim(),
            Artist = (artist ?? string.Empty).Trim(),
            Quality = resolvedQuality,
        };
        _jobs[job.Id] = job;
        var control = new DownloadControl();
        _controls[job.Id] = control;
        _ = Task.Run(() => RunAsync(provider, trackId, job, resolvedQuality, control));
        TrimOldJobs();
        return job;
    }

    /// <summary>暂停一个进行中的任务：保留 received/total，state 变为 paused（幂等）。</summary>
    public bool Pause(string jobId)
    {
        if (!TryGetJob(jobId, out var job, out var control))
        {
            return false;
        }

        if (!control.Pause())
        {
            return string.Equals(job.State, "paused", StringComparison.Ordinal);
        }

        job.State = "paused";
        OnlineHttp.Info($"[download] paused {job.Source}:{job.TrackId} ({job.Received}/{job.Total}B)");
        return true;
    }

    /// <summary>继续一个已暂停的任务（幂等：running 状态下调用也返回 true）。</summary>
    public bool Resume(string jobId)
    {
        if (!TryGetJob(jobId, out var job, out var control))
        {
            return false;
        }

        if (!control.Resume())
        {
            return string.Equals(job.State, "running", StringComparison.Ordinal);
        }

        if (string.Equals(job.State, "paused", StringComparison.Ordinal))
        {
            job.State = "running";
        }

        OnlineHttp.Info($"[download] resumed {job.Source}:{job.TrackId}");
        return true;
    }

    /// <summary>取消一个进行中/已暂停的任务：保留列表项并标记 error「已取消」，不删磁盘文件。</summary>
    public bool Cancel(string jobId)
    {
        if (!TryGetJob(jobId, out var job, out var control))
        {
            return false;
        }

        if (job.State is not ("running" or "paused"))
        {
            return false;
        }

        control.Cancel();
        job.State = "error";
        job.Error = "已取消";
        OnlineHttp.Info($"[download] canceled {job.Source}:{job.TrackId}");
        return true;
    }

    /// <summary>
    /// 清空队列里已完成/失败的任务（只从内存列表移除，绝不删除磁盘文件），返回移除条数。
    /// 进行中/已暂停的任务不受影响。
    /// </summary>
    public int ClearFinished()
    {
        var cleared = 0;
        foreach (var pair in _jobs)
        {
            if (pair.Value.State is not ("done" or "error"))
            {
                continue;
            }

            if (!_jobs.TryRemove(pair.Key, out _))
            {
                continue;
            }

            if (_controls.TryRemove(pair.Key, out var control))
            {
                control.MarkCompleted();
                control.Dispose();
            }

            cleared += 1;
        }

        if (cleared > 0)
        {
            OnlineHttp.Info($"[download] cleared {cleared} finished jobs");
        }

        return cleared;
    }

    private bool TryGetJob(
        string? jobId,
        [NotNullWhen(true)] out DownloadJob? job,
        [NotNullWhen(true)] out DownloadControl? control)
    {
        job = null;
        control = null;
        if (string.IsNullOrWhiteSpace(jobId) || !_jobs.TryGetValue(jobId, out var found))
        {
            return false;
        }

        if (!_controls.TryGetValue(jobId, out var foundControl))
        {
            return false;
        }

        job = found;
        control = foundControl;
        return true;
    }

    private static string NormalizeQuality(string? quality)
    {
        if (string.Equals(quality, "standard", StringComparison.OrdinalIgnoreCase))
        {
            return "standard";
        }

        if (string.Equals(quality, "lossless", StringComparison.OrdinalIgnoreCase))
        {
            return "lossless";
        }

        return "high";
    }

    public DownloadListResponse Snapshot()
    {
        var jobs = _jobs.Values
            .OrderByDescending(item => item.StartedAt)
            .Take(30)
            .ToList();
        return new DownloadListResponse { Directory = Directory, Jobs = jobs };
    }

    /// <summary>按任务 id 找已完成的文件路径；id 为空时取最近完成的一条。</summary>
    public string? FindFinishedPath(string jobId)
    {
        if (!string.IsNullOrWhiteSpace(jobId) && _jobs.TryGetValue(jobId, out var job))
        {
            return job.State == "done" ? job.Path : null;
        }

        return _jobs.Values
            .Where(item => item.State == "done" && !string.IsNullOrEmpty(item.Path))
            .OrderByDescending(item => item.StartedAt)
            .Select(item => item.Path)
            .FirstOrDefault();
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
            // 已经释放过。
        }

        // 取消所有任务（包括暂停中的：它们挂在 TaskCompletionSource 上，必须靠 token 唤醒）。
        foreach (var control in _controls.Values)
        {
            control.Cancel();
        }

        foreach (var control in _controls.Values)
        {
            control.Dispose();
        }

        _controls.Clear();
        _shutdown.Dispose();
    }

    private async Task RunAsync(
        IOnlineMusicProvider provider,
        string trackId,
        DownloadJob job,
        string quality,
        DownloadControl control)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(_shutdown.Token, control.Cancellation.Token);
        var token = linked.Token;
        var partPath = string.Empty;
        try
        {
            await control.WaitWhilePausedAsync(token).ConfigureAwait(false);
            var resolution = await provider.ResolveStreamAsync(trackId, quality, token).ConfigureAwait(false);
            if (!resolution.IsPlayable || string.IsNullOrWhiteSpace(resolution.Url))
            {
                throw new InvalidOperationException(
                    string.IsNullOrWhiteSpace(resolution.NotPlayableMessage)
                        ? "没有可用的播放地址"
                        : resolution.NotPlayableMessage);
            }

            var directory = Directory;
            System.IO.Directory.CreateDirectory(directory);
            var extension = GuessExtension(resolution.Url, resolution.Format);
            var fileName = BuildFileName(job.Artist, job.Title, trackId, extension);
            var targetPath = System.IO.Path.Combine(directory, fileName);
            partPath = targetPath + ".part";
            job.FileName = fileName;

            await control.WaitWhilePausedAsync(token).ConfigureAwait(false);
            using var request = new HttpRequestMessage(HttpMethod.Get, resolution.Url);
            foreach (var header in resolution.Headers)
            {
                request.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }

            using var response = await Client
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token)
                .ConfigureAwait(false);
            response.EnsureSuccessStatusCode();
            job.Total = response.Content.Headers.ContentLength ?? 0;

            await using (var input = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false))
            await using (var output = new FileStream(partPath, FileMode.Create, FileAccess.Write, FileShare.None, 64 * 1024, useAsync: true))
            {
                var buffer = new byte[64 * 1024];
                while (true)
                {
                    // 暂停点放在读写之间：暂停期间不再继续往磁盘写，已收字节计入 received。
                    await control.WaitWhilePausedAsync(token).ConfigureAwait(false);
                    var read = await input.ReadAsync(buffer, token).ConfigureAwait(false);
                    if (read <= 0)
                    {
                        break;
                    }

                    await control.WaitWhilePausedAsync(token).ConfigureAwait(false);
                    await output.WriteAsync(buffer.AsMemory(0, read), token).ConfigureAwait(false);
                    job.Received += read;
                }
            }

            if (job.Received < MinValidBytes)
            {
                throw new InvalidOperationException("下载内容过小，可能不是可播放的音频文件");
            }

            File.Move(partPath, targetPath, overwrite: true);
            job.Path = targetPath;
            job.State = "done";
            OnlineHttp.Info($"[download] done {job.Source}:{job.TrackId} quality={job.Quality} -> {targetPath} ({job.Received}B)");
            try
            {
                _fileReady?.Invoke(targetPath);
            }
            catch (Exception callbackError)
            {
                OnlineHttp.Warn($"[download] file callback failed: {callbackError.Message}");
            }
        }
        catch (OperationCanceledException)
        {
            // 取消（控制台按钮或宿主退出）统一落到 error「已取消」；磁盘上的 .part 在 finally 清掉。
            job.State = "error";
            job.Error = "已取消";
        }
        catch (Exception exception)
        {
            job.State = "error";
            job.Error = exception.Message;
            OnlineHttp.Warn($"[download] failed {job.Source}:{job.TrackId}: {exception.Message}");
        }
        finally
        {
            control.MarkCompleted();
            if (partPath.Length > 0)
            {
                try
                {
                    if (File.Exists(partPath))
                    {
                        File.Delete(partPath);
                    }
                }
                catch
                {
                    // 残留 .part 不影响下次下载（会被覆盖）。
                }
            }
        }
    }

    private static string BuildFileName(string artist, string title, string trackId, string extension)
    {
        var namePart = string.IsNullOrWhiteSpace(title) ? trackId : title;
        var safeArtist = Clean(artist);
        var safeTitle = Clean(namePart);
        var stem = safeArtist.Length > 0 ? $"{safeArtist} - {safeTitle}" : safeTitle;
        if (stem.Length == 0)
        {
            stem = "track-" + trackId;
        }

        if (stem.Length > 120)
        {
            stem = stem[..120].Trim();
        }

        return stem + extension;
    }

    private static string Clean(string value)
    {
        var cleaned = UnsafeFileNameChars.Replace(value ?? string.Empty, " ").Trim();
        cleaned = Regex.Replace(cleaned, "\\s{2,}", " ");
        return cleaned.Length > 80 ? cleaned[..80].Trim() : cleaned;
    }

    private static string GuessExtension(string url, string format)
    {
        var normalized = (format ?? string.Empty).Trim().ToLowerInvariant();
        var extension = normalized switch
        {
            "mp3" => ".mp3",
            "flac" => ".flac",
            "m4a" or "aac" => ".m4a",
            "wav" => ".wav",
            "ogg" or "opus" => ".ogg",
            _ => string.Empty,
        };
        if (extension.Length > 0)
        {
            return extension;
        }

        try
        {
            var path = new Uri(url).AbsolutePath;
            var suffix = System.IO.Path.GetExtension(path).ToLowerInvariant();
            if (suffix is ".mp3" or ".flac" or ".m4a" or ".aac" or ".wav" or ".ogg" or ".opus")
            {
                return suffix;
            }
        }
        catch
        {
            // url 不是标准绝对地址时按默认格式处理。
        }

        return ".mp3";
    }

    private void TrimOldJobs()
    {
        if (_jobs.Count <= MaxRememberedJobs)
        {
            return;
        }

        foreach (var pair in _jobs.OrderBy(item => item.Value.StartedAt).Take(_jobs.Count - MaxRememberedJobs).ToList())
        {
            if (pair.Value.State is "running" or "paused")
            {
                continue;
            }

            if (!_jobs.TryRemove(pair.Key, out _))
            {
                continue;
            }

            if (_controls.TryRemove(pair.Key, out var control))
            {
                control.MarkCompleted();
                control.Dispose();
            }
        }
    }

    /// <summary>
    /// 单个下载任务的控制块：暂停闸门（TaskCompletionSource，暂停时 await，恢复时完成）+ 取消源。
    /// 状态读写都在 _gate 锁内，避免 pause/resume/cancel 与下载线程竞争。
    /// </summary>
    private sealed class DownloadControl : IDisposable
    {
        private readonly object _gate = new();
        private TaskCompletionSource? _resume;
        private bool _paused;
        private bool _completed;
        private bool _disposed;

        public CancellationTokenSource Cancellation { get; } = new();

        public bool Pause()
        {
            lock (_gate)
            {
                if (_completed || _paused)
                {
                    return false;
                }

                _paused = true;
                _resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                return true;
            }
        }

        public bool Resume()
        {
            TaskCompletionSource? resume;
            lock (_gate)
            {
                if (_completed || !_paused)
                {
                    return false;
                }

                _paused = false;
                resume = _resume;
                _resume = null;
            }

            resume?.TrySetResult();
            return true;
        }

        public bool Cancel()
        {
            lock (_gate)
            {
                if (_completed)
                {
                    return false;
                }
            }

            try
            {
                Cancellation.Cancel();
                return true;
            }
            catch (ObjectDisposedException)
            {
                return false;
            }
        }

        /// <summary>暂停时挂起；<paramref name="token"/> 取消（宿主退出/取消任务）时抛出唤醒调用方。</summary>
        public async Task WaitWhilePausedAsync(CancellationToken token)
        {
            while (true)
            {
                Task? wait;
                lock (_gate)
                {
                    if (!_paused || _completed)
                    {
                        return;
                    }

                    wait = _resume?.Task;
                }

                if (wait is null)
                {
                    return;
                }

                await wait.WaitAsync(token).ConfigureAwait(false);
            }
        }

        public void MarkCompleted()
        {
            TaskCompletionSource? resume;
            lock (_gate)
            {
                _completed = true;
                _paused = false;
                resume = _resume;
                _resume = null;
            }

            resume?.TrySetResult();
        }

        public void Dispose()
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                _disposed = true;
            }

            try
            {
                Cancellation.Dispose();
            }
            catch (ObjectDisposedException)
            {
                // 已经释放过。
            }
        }
    }

    private static HttpClient CreateClient()
    {
        var handler = new HttpClientHandler { AutomaticDecompression = DecompressionMethods.All };
        var client = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(10) };
        client.DefaultRequestHeaders.TryAddWithoutValidation(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36");
        return client;
    }
}
