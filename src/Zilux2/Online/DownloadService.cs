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

    /// <summary>运行任务；仅内存使用，cancel 时用于等待 .part 清理完成。</summary>
    internal Task? Completion { get; set; }
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
    private const int DownloadReadTimeoutSeconds = 60;
    private const int MaxPathLength = 259;

    /// <summary>Windows 设备名（带扩展名同样被系统保留，例如 con.mp3 也打不开）。</summary>
    private static readonly HashSet<string> ReservedStems = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

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
    private readonly Func<int>? _maxConcurrentProvider;
    private readonly Func<string?>? _templateProvider;
    private readonly Func<bool>? _openFolderProvider;
    private readonly Action<string>? _fileReady;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly ConcurrentDictionary<string, DownloadJob> _jobs = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, DownloadControl> _controls = new(StringComparer.Ordinal);
    private readonly object _slotsGate = new();
    private int _activeDownloads;
    private int _disposed;

    public DownloadService(
        Func<string?>? directoryProvider,
        Func<string?>? qualityProvider = null,
        Action<string>? fileReady = null,
        Func<int>? maxConcurrentProvider = null,
        Func<string?>? templateProvider = null,
        Func<bool>? openFolderProvider = null)
    {
        _directoryProvider = directoryProvider;
        _qualityProvider = qualityProvider;
        _fileReady = fileReady;
        _maxConcurrentProvider = maxConcurrentProvider;
        _templateProvider = templateProvider;
        _openFolderProvider = openFolderProvider;
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
        job.Completion = Task.Run(() => RunAsync(provider, trackId, job, resolvedQuality, control));
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
    /// 取消并等待运行任务退出（幂等）：用于页面 abort / 关闭下载面板时确保 .part 已清理。
    /// 返回 false 仅表示任务不存在或已经完成；已取消过的任务重复调用返回 true。
    /// </summary>
    public async Task<bool> CancelDownloadAsync(string jobId)
    {
        if (!TryGetJob(jobId, out var job, out var control))
        {
            return false;
        }

        if (string.Equals(job.State, "done", StringComparison.Ordinal))
        {
            return false;
        }

        var alreadyCanceled = string.Equals(job.Error, "已取消", StringComparison.Ordinal);
        if (!alreadyCanceled)
        {
            if (job.State is not ("running" or "paused"))
            {
                return false;
            }

            control.Cancel();
            job.State = "error";
            job.Error = "已取消";
            OnlineHttp.Info($"[download] canceled {job.Source}:{job.TrackId} (awaiting cleanup)");
        }

        // D-06/cancel：RunAsync 的 finally 会删除本次 .part；等待它完成，避免接口返回后文件仍在。
        var completion = job.Completion;
        if (completion is not null)
        {
            try
            {
                await completion.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                OnlineHttp.Warn($"[download] cancel cleanup timed out {job.Source}:{job.TrackId}");
            }
            catch (Exception exception)
            {
                OnlineHttp.Warn($"[download] cancel cleanup failed {job.Source}:{job.TrackId}: {exception.Message}");
            }
        }

        // 兜底：万一 RunAsync 在登记 .part 前就被取消，也把残留删掉。
        DeleteActivePart(control);

        // 取消请求与完成竞争时，以最终状态为准：已落成品就不谎报“已取消”。
        if (string.Equals(job.State, "done", StringComparison.Ordinal))
        {
            return false;
        }

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

    /// <summary>按任务 id 找已完成的文件路径；只有 id 为空时才取最近完成的一条。</summary>
    public string? FindFinishedPath(string jobId)
    {
        if (!string.IsNullOrWhiteSpace(jobId))
        {
            // D-10：指定了 id 却查不到时不再回退到“最近完成”，避免在资源管理器里选中别的文件。
            return _jobs.TryGetValue(jobId, out var job) && job.State == "done" ? job.Path : null;
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
        var slotHeld = false;
        try
        {
            while (true)
            {
                await control.WaitWhilePausedAsync(token).ConfigureAwait(false);
                // 并发闸门放在解析地址之前：排队中的任务不占网络，也不浪费一次 URL 解析。
                await WaitForSlotAsync(token).ConfigureAwait(false);
                slotHeld = true;

                try
                {
                    var attempt = await DownloadOnceAsync(provider, trackId, job, quality, control, token).ConfigureAwait(false);
                    partPath = attempt.PartPath;

                    // 下载完成时如果用户刚点了暂停，先不落成品；恢复后重新拉一遍，保证状态与进度一致。
                    if (control.IsPauseRequested)
                    {
                        throw new PauseRequestedException();
                    }

                    // D-01/D-04：这里只搬运已经校验过长度（响应头有 Content-Length 时）的 .part；短读在
                    // DownloadOnceAsync 里会直接抛错并删掉 .part，绝不会覆盖同名成品。
                    File.Move(attempt.PartPath, attempt.TargetPath, overwrite: true);
                    job.Path = attempt.TargetPath;
                    job.State = "done";
                    OnlineHttp.Info($"[download] done {job.Source}:{job.TrackId} quality={job.Quality} -> {attempt.TargetPath} ({job.Received}B)");
                    try
                    {
                        _fileReady?.Invoke(attempt.TargetPath);
                    }
                    catch (Exception callbackError)
                    {
                        OnlineHttp.Warn($"[download] file callback failed: {callbackError.Message}");
                    }

                    if (_openFolderProvider?.Invoke() == true)
                    {
                        RevealInExplorer(attempt.TargetPath);
                    }

                    return;
                }
                catch (PauseRequestedException)
                {
                    // D-05：暂停时释放并发槽和上游连接；D-06：保留 .part 与已收字节，恢复后从断点续传。
                    slotHeld = false;
                    ReleaseSlot();
                    job.State = "paused";
                    OnlineHttp.Info($"[download] paused; part kept ({job.Received}B) {job.Source}:{job.TrackId}");
                }
                finally
                {
                    if (slotHeld)
                    {
                        ReleaseSlot();
                        slotHeld = false;
                    }
                }
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
            // D-06：只有用户主动取消才丢掉半成品；暂停/网络失败都保留 .part，重试时按 Range 续传。
            if (control.Cancellation.IsCancellationRequested)
            {
                var leftover = partPath.Length > 0 ? partPath : control.ActivePartPath;
                if (!string.IsNullOrEmpty(leftover))
                {
                    try
                    {
                        if (File.Exists(leftover))
                        {
                            File.Delete(leftover);
                        }
                    }
                    catch
                    {
                        // 残留 .part 不影响下次下载（续传或覆盖都会处理）。
                    }
                }

                control.ActivePartPath = null;
            }
        }
    }

    /// <summary>删除本次尝试的 .part；失败只记日志，避免掩盖原始异常。</summary>
    private static void DeleteActivePart(DownloadControl control)
    {
        var path = control.ActivePartPath;
        control.ActivePartPath = null;
        if (string.IsNullOrEmpty(path))
        {
            return;
        }

        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            OnlineHttp.Warn($"[download] delete part failed path={path}: {exception.Message}");
        }
    }

    /// <summary>
    /// 执行一次完整下载（解析地址 → 写 .part → 校验长度）。暂停/取消由 <paramref name="control"/> 与
    /// <paramref name="token"/> 驱动；暂停用 <see cref="PauseRequestedException"/> 跳出，由调用方释放槽后重试。
    /// </summary>
    private async Task<(string TargetPath, string PartPath)> DownloadOnceAsync(
        IOnlineMusicProvider provider,
        string trackId,
        DownloadJob job,
        string quality,
        DownloadControl control,
        CancellationToken token)
    {
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
        var fileName = BuildFileName(job, quality, extension, directory);
        var targetPath = ResolveTargetPath(directory, fileName, job);
        var partPath = targetPath + ".part";
        control.ActivePartPath = partPath;
        job.FileName = System.IO.Path.GetFileName(targetPath);

        // D-06：已有 .part 时从断点续传；服务端不支持 Range（回 200）则自动退化为整段重下。
        long existing = 0;
        try
        {
            if (File.Exists(partPath))
            {
                existing = new FileInfo(partPath).Length;
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            existing = 0;
        }

        job.Received = existing;
        job.Total = 0;

        await control.WaitWhilePausedAsync(token).ConfigureAwait(false);
        if (control.IsPauseRequested)
        {
            throw new PauseRequestedException();
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, resolution.Url);
        foreach (var header in resolution.Headers)
        {
            request.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }

        if (existing > 0)
        {
            request.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(existing, null);
        }

        // D-07：HttpClient 不再有 10 分钟整体超时；建立连接/拿响应头最多 60 秒，之后按“读取停滞 60 秒”计。
        using var connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        connectTimeout.CancelAfter(TimeSpan.FromSeconds(60));
        HttpResponseMessage response;
        try
        {
            response = await Client
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, connectTimeout.Token)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new TimeoutException("连接下载服务器超时（60 秒）");
        }

        // D-06 边界：.part 恰好已是完整文件时，Range 起点会得到 416。删掉半成品重下一次，
        // 避免任务永久卡在 416；正常断点（起点 < 总长）不受影响。
        if (response.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable && existing > 0)
        {
            response.Dispose();
            OnlineHttp.Warn($"[download] range rejected for full part, restarting {job.Source}:{job.TrackId}");
            try
            {
                if (File.Exists(partPath))
                {
                    File.Delete(partPath);
                }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                OnlineHttp.Warn($"[download] could not delete full part: {exception.Message}");
            }

            existing = 0;
            job.Received = 0;
            using var retryRequest = new HttpRequestMessage(HttpMethod.Get, resolution.Url);
            foreach (var header in resolution.Headers)
            {
                retryRequest.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }

            using var retryTimeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            retryTimeout.CancelAfter(TimeSpan.FromSeconds(60));
            try
            {
                response = await Client
                    .SendAsync(retryRequest, HttpCompletionOption.ResponseHeadersRead, retryTimeout.Token)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                throw new TimeoutException("连接下载服务器超时（60 秒）");
            }
        }

        using (response)
        {
            response.EnsureSuccessStatusCode();
            var contentLength = response.Content.Headers.ContentLength;
            var contentRange = response.Content.Headers.ContentRange;
            var resumed = existing > 0
                && response.StatusCode == HttpStatusCode.PartialContent
                && contentRange?.From == existing;

            long expectedTotal;
            if (resumed)
            {
                // Content-Range: bytes <from>-<to>/<total>，Length 是完整文件大小。
                expectedTotal = contentRange!.Length
                    ?? (contentRange.To is { } to ? to + 1 : existing + (contentLength ?? 0));
                if (contentRange.Length is null && contentLength is { } remaining)
                {
                    expectedTotal = existing + remaining;
                }
            }
            else
            {
                existing = 0;
                expectedTotal = contentLength ?? 0;
            }

            job.Total = expectedTotal;
            job.Received = existing;

            // D-09：先确认磁盘剩余空间，不足时不要写一半再报错。
            var needed = expectedTotal > existing ? expectedTotal - existing : 0;
            if (needed > 0)
            {
                long free = -1;
                try
                {
                    var root = System.IO.Path.GetPathRoot(directory);
                    if (!string.IsNullOrEmpty(root))
                    {
                        free = new DriveInfo(root).AvailableFreeSpace;
                    }
                }
                catch (Exception exception) when (exception is ArgumentException or IOException or UnauthorizedAccessException)
                {
                    // 驱动器信息不可用时交给写入过程报错，不阻断下载。
                    OnlineHttp.Warn($"[download] free-space check unavailable: {exception.Message}");
                }

                if (free >= 0 && free < needed + 16L * 1024 * 1024)
                {
                    throw new IOException(
                        $"磁盘空间不足：还需 {needed / (1024 * 1024)} MB，可用 {free / (1024 * 1024)} MB");
                }
            }

            await using var input = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
            var decoder = string.IsNullOrWhiteSpace(resolution.EncryptionKey)
                ? null
                : Enum.TryParse<Zilux2.Online.Qq.QmcMode>(resolution.EncryptionMode, out var qmcMode)
                    ? Zilux2.Online.Qq.QmcDecoder.TryCreate(resolution.EncryptionKey, qmcMode)
                    : null;
            await using var output = new FileStream(
                partPath,
                resumed ? FileMode.Append : FileMode.Create,
                FileAccess.Write,
                FileShare.None,
                64 * 1024,
                useAsync: true);
            var buffer = new byte[64 * 1024];
            long written = existing;
            using var readTimeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            while (true)
            {
                if (control.IsPauseRequested)
                {
                    throw new PauseRequestedException();
                }

                readTimeout.CancelAfter(TimeSpan.FromSeconds(DownloadReadTimeoutSeconds));
                int read;
                try
                {
                    read = await input.ReadAsync(buffer, readTimeout.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!token.IsCancellationRequested)
                {
                    throw new TimeoutException($"下载超时：{DownloadReadTimeoutSeconds} 秒内没有收到数据");
                }

                if (read <= 0)
                {
                    break;
                }

                if (control.IsPauseRequested)
                {
                    throw new PauseRequestedException();
                }

                if (decoder is not null)
                {
                    // QMC2：断点续传时 written 就是密文绝对偏移，按块原地解密再落盘。
                    decoder.Apply(written, buffer.AsSpan(0, read));
                }

                await output.WriteAsync(buffer.AsMemory(0, read), token).ConfigureAwait(false);
                written += read;
                job.Received = written;
            }

            await output.FlushAsync(token).ConfigureAwait(false);

            // D-01：响应头声明了长度就必须收满；否则不能把半成品当成品。
            if (expectedTotal > 0 && written != expectedTotal)
            {
                throw new InvalidDataException($"下载不完整：收到 {written} / {expectedTotal} 字节");
            }

            // QMC2 加密档：收满后剥掉 musicex/QTag 尾部元数据（长度校验用的是密文长度）。
            if (decoder is not null)
            {
                var trimmed = Zilux2.Online.Qq.QmcDecoder.TrimTail(output, written);
                if (trimmed > 0)
                {
                    OnlineHttp.Info($"[download] qmc tail trimmed {trimmed}B source={job.Source}:{job.TrackId}");
                    written -= trimmed;
                    job.Received = written;
                }
            }

            if (written < MinValidBytes)
            {
                throw new InvalidOperationException("下载内容过小，可能不是可播放的音频文件");
            }

            control.ActivePartPath = null;
            return (targetPath, partPath);
        }
    }

    private sealed class PauseRequestedException : Exception
    {
        public PauseRequestedException() : base("download paused")
        {
        }
    }

    /// <summary>
    /// 并发闸门：同时进行的下载不超过设置里的上限（1–4）。这里用轮询而不是固定容量的
    /// SemaphoreSlim，是因为设置页改并发后要立刻生效，而 SemaphoreSlim 的容量创建后就固定了。
    /// </summary>
    private async Task WaitForSlotAsync(CancellationToken token)
    {
        while (true)
        {
            var limit = Math.Clamp(_maxConcurrentProvider?.Invoke() ?? 2, 1, 4);
            lock (_slotsGate)
            {
                if (_activeDownloads < limit)
                {
                    _activeDownloads += 1;
                    OnlineHttp.Info($"[download] slot acquired active={_activeDownloads} limit={limit}");
                    return;
                }
            }

            await Task.Delay(120, token).ConfigureAwait(false);
        }
    }

    private void ReleaseSlot()
    {
        lock (_slotsGate)
        {
            _activeDownloads = Math.Max(0, _activeDownloads - 1);
        }
    }

    /// <summary>在资源管理器里选中刚下好的文件；任何失败都只记日志。</summary>
    private static void RevealInExplorer(string path)
    {
        try
        {
            var startInfo = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = $"/select,\"{path}\"",
                UseShellExecute = true,
            };
            System.Diagnostics.Process.Start(startInfo)?.Dispose();
        }
        catch (Exception exception)
        {
            OnlineHttp.Warn($"[download] reveal failed: {exception.Message}");
        }
    }

    private string BuildFileName(DownloadJob job, string quality, string extension, string directory)
    {
        var trackId = job.TrackId;
        var artist = job.Artist;
        var title = job.Title;
        var namePart = string.IsNullOrWhiteSpace(title) ? trackId : title;
        var safeArtist = Clean(artist);
        var safeTitle = Clean(namePart);
        var template = (_templateProvider?.Invoke() ?? string.Empty).Trim();
        string stem;
        if (template.Length == 0)
        {
            stem = safeArtist.Length > 0 ? $"{safeArtist} - {safeTitle}" : safeTitle;
        }
        else
        {
            stem = template
                .Replace("{artist}", safeArtist, StringComparison.Ordinal)
                .Replace("{title}", safeTitle, StringComparison.Ordinal)
                .Replace("{id}", Clean(trackId), StringComparison.Ordinal)
                .Replace("{quality}", Clean(quality), StringComparison.Ordinal);
            // 模板里可能留下分隔符（例如没有歌手时的 " - 歌名"），再清洗一遍首尾与连续空格。
            stem = Clean(stem);
        }

        if (stem.Length == 0)
        {
            stem = "track-" + trackId;
        }

        if (stem.Length > 120)
        {
            stem = stem[..120].Trim();
        }

        stem = SanitizeStem(stem);
        stem = FitStemToDirectory(stem, extension, directory);
        return stem + extension;
    }

    /// <summary>D-08：补上 Windows 设备名、结尾点/空格等文件系统保留规则。</summary>
    private static string SanitizeStem(string stem)
    {
        var cleaned = Regex.Replace((stem ?? string.Empty).Trim(), "\\s{2,}", " ");
        cleaned = cleaned.TrimEnd('.', ' ');
        if (cleaned.Length == 0 || cleaned is "." or "..")
        {
            cleaned = "track";
        }

        var dot = cleaned.IndexOf('.');
        var baseName = dot >= 0 ? cleaned[..dot] : cleaned;
        if (ReservedStems.Contains(baseName))
        {
            cleaned = "_" + cleaned;
        }

        return cleaned;
    }

    /// <summary>确保「目录 + 文件名」不超过 Windows 的 259 字符预算，并保留扩展名。</summary>
    private static string FitStemToDirectory(string stem, string extension, string directory)
    {
        var budget = MaxPathLength - directory.Length - 1 - extension.Length;
        if (budget < 8)
        {
            throw new InvalidOperationException($"下载目录路径过长，无法保存文件：{directory}");
        }

        if (stem.Length > budget)
        {
            stem = stem[..budget].TrimEnd('.', ' ');
        }

        if (stem.Length == 0)
        {
            stem = "track";
        }

        return stem;
    }

    /// <summary>
    /// D-04：目标已存在时避让为「name (2).ext」。只有模板显式使用 {id} 且文件名里确实带着本任务 id 时，
    /// 才认为这是同一首歌的重复下载，允许覆盖；其余情况一律另起名字，避免不同歌曲互相覆盖。
    /// </summary>
    private string ResolveTargetPath(string directory, string fileName, DownloadJob job)
    {
        var target = Path.Combine(directory, fileName);
        if (!File.Exists(target))
        {
            return target;
        }

        var templateUsesId = (_templateProvider?.Invoke() ?? string.Empty)
            .Contains("{id}", StringComparison.Ordinal);
        if (templateUsesId && fileName.Contains(Clean(job.TrackId), StringComparison.OrdinalIgnoreCase))
        {
            return target;
        }

        var stem = Path.GetFileNameWithoutExtension(fileName);
        var extension = Path.GetExtension(fileName);
        for (var index = 2; index < 1000; index++)
        {
            var suffix = $" ({index})";
            var budget = MaxPathLength - directory.Length - 1 - extension.Length - suffix.Length;
            if (budget < 8)
            {
                throw new InvalidOperationException($"下载目录路径过长，无法保存文件：{directory}");
            }

            var baseStem = stem.Length > budget ? stem[..budget].TrimEnd('.', ' ') : stem;
            var candidateStem = SanitizeStem(baseStem + suffix);
            var candidate = Path.Combine(directory, candidateStem + extension);
            // File.Exists 在 Windows 上大小写不敏感；这里再比较一次长度以便超长时继续收缩。
            if (candidate.Length <= MaxPathLength && !File.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new InvalidOperationException("同名文件过多，请调整文件名模板或清理下载目录");
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

        /// <summary>当前尝试正在写的 .part；失败/暂停时由 RunAsync 负责清理，避免半成品留在磁盘。</summary>
        public string? ActivePartPath { get; set; }

        /// <summary>供下载循环在读写之间快速检查；真正的等待仍走 <see cref="WaitWhilePausedAsync"/>。</summary>
        public bool IsPauseRequested
        {
            get
            {
                lock (_gate)
                {
                    return _paused && !_completed;
                }
            }
        }

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
        // D-07：整体超时交给每次“建连 60s / 读停滞 60s”的 CTS，大无损文件不再被 10 分钟一刀切。
        var client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        client.DefaultRequestHeaders.TryAddWithoutValidation(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36");
        return client;
    }
}
