using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Threading;

namespace Zilux2.Stems;

/// <summary>
/// 按需下载人声分离模型（约 130 MB）。
///
/// 安装包不再带模型：首次要用分离时才落盘到 %LOCALAPPDATA%\Zilux2\models\。
/// 下载走 <see cref="Mirrors"/> 里的镜像（hf-mirror 优先，官方站兜底），
/// 落成 .part 后先校验 SHA-256 再改名，避免半截文件被会话加载。
/// </summary>
internal sealed class StemModelInstaller : IDisposable
{
    internal const string Idle = "idle";
    internal const string Downloading = "downloading";
    internal const string Verifying = "verifying";
    internal const string Ready = "ready";
    internal const string Failed = "failed";

    /// <summary>
    /// 镜像顺序：ZILUX2_STEMS_MODEL_URL 覆盖（内网/自建镜像）→ hf-mirror → 官方站。
    /// </summary>
    internal static IReadOnlyList<string> Mirrors
    {
        get
        {
            var list = new List<string>(3);
            var custom = Environment.GetEnvironmentVariable("ZILUX2_STEMS_MODEL_URL");
            if (!string.IsNullOrWhiteSpace(custom))
            {
                list.Add(custom.Trim());
            }

            list.Add("https://hf-mirror.com/itamiArika/htdemucs-int8-memory/resolve/main/" + StemSeparationService.ModelFileName);
            list.Add("https://huggingface.co/itamiArika/htdemucs-int8-memory/resolve/main/" + StemSeparationService.ModelFileName);
            return list;
        }
    }

    private static readonly TimeSpan RequestTimeout = TimeSpan.FromMinutes(20);

    private readonly object _gate = new();
    private readonly HttpClient _client;
    private CancellationTokenSource? _cts;
    private string _state = Idle;
    private long _done;
    private long _total;
    private string _error = string.Empty;
    private int _attempt;
    private int _disposed;

    internal StemModelInstaller()
    {
        _client = new HttpClient(new HttpClientHandler { UseProxy = true })
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        _client.DefaultRequestHeaders.UserAgent.ParseAdd("Zilux2/stems-model");
    }

    internal static string ModelDirectory => Path.Combine(HostFolders.Root, "models");

    internal static string TargetPath => Path.Combine(ModelDirectory, StemSeparationService.ModelFileName);

    internal StemModelStatus Status
    {
        get
        {
            lock (_gate)
            {
                return new StemModelStatus
                {
                    State = _state,
                    Bytes = Interlocked.Read(ref _done),
                    TotalBytes = Interlocked.Read(ref _total),
                    Error = _error,
                    Attempt = _attempt,
                    Path = TargetPath,
                };
            }
        }
    }

    /// <summary>模型已在盘上（随包或已下载）就直接返回 ready。</summary>
    internal bool Exists()
    {
        var path = StemSeparationService.ResolveModelPath();
        return File.Exists(path);
    }

    /// <summary>
    /// 确保有一次下载在进行：空闲或失败时重新起；已经在下载就复用。非阻塞。
    /// </summary>
    internal StemModelStatus Ensure()
    {
        if (Volatile.Read(ref _disposed) != 0)
        {
            return Status;
        }

        if (Exists())
        {
            lock (_gate)
            {
                _state = Ready;
                _error = string.Empty;
            }

            return Status;
        }

        lock (_gate)
        {
            if (_state is Downloading or Verifying)
            {
                return Status;
            }

            _state = Downloading;
            _error = string.Empty;
            _done = 0;
            _total = 0;
            _attempt++;
            _cts = new CancellationTokenSource();
            var token = _cts.Token;
            HostLog.Info($"stems.model-download start attempt={_attempt}");
            _ = Task.Run(() => DownloadAsync(token));
            return Status;
        }
    }

    private async Task DownloadAsync(CancellationToken cancellationToken)
    {
        var directory = ModelDirectory;
        var partPath = TargetPath + ".part";
        var failure = string.Empty;
        try
        {
            Directory.CreateDirectory(directory);
            foreach (var url in Mirrors)
            {
                try
                {
                    await DownloadFromAsync(url, partPath, cancellationToken).ConfigureAwait(false);
                    failure = string.Empty;
                    break;
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception exception)
                {
                    failure = exception.Message;
                    HostLog.Warn($"stems.model-download mirror-failed url={url}: {exception.Message}");
                }
            }

            if (failure.Length > 0)
            {
                throw new InvalidOperationException(failure);
            }
        }
        catch (OperationCanceledException)
        {
            lock (_gate)
            {
                _state = Idle;
            }

            TryDelete(partPath);
            HostLog.Info("stems.model-download cancelled");
        }
        catch (Exception exception)
        {
            lock (_gate)
            {
                _state = Failed;
                _error = exception.Message;
            }

            TryDelete(partPath);
            HostLog.Warn($"stems.model-download failed: {exception.Message}");
        }
    }

    private async Task DownloadFromAsync(string url, string partPath, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            _state = Downloading;
        }

        using var timeout = new CancellationTokenSource(RequestTimeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        using var response = await _client
            .GetAsync(url, HttpCompletionOption.ResponseHeadersRead, linked.Token)
            .ConfigureAwait(false);
        response.EnsureSuccessStatusCode();

        var total = response.Content.Headers.ContentLength ?? 0;
        if (total > 0)
        {
            Interlocked.Exchange(ref _total, total);
        }

        long done = 0;
        var buffer = new byte[1 << 16];
        await using (var input = await response.Content.ReadAsStreamAsync(linked.Token).ConfigureAwait(false))
        await using (var output = new FileStream(partPath, FileMode.Create, FileAccess.Write, FileShare.None, buffer.Length, useAsync: true))
        {
            while (true)
            {
                var read = await input.ReadAsync(buffer.AsMemory(), linked.Token).ConfigureAwait(false);
                if (read <= 0)
                {
                    break;
                }

                await output.WriteAsync(buffer.AsMemory(0, read), linked.Token).ConfigureAwait(false);
                done += read;
                Interlocked.Exchange(ref _done, done);
            }

            await output.FlushAsync(linked.Token).ConfigureAwait(false);
        }

        lock (_gate)
        {
            _state = Verifying;
        }

        var actual = await Task.Run(() => Sha256Of(partPath), cancellationToken).ConfigureAwait(false);
        if (!string.Equals(actual, StemSeparationService.ModelSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException(
                string.Create(CultureInfo.InvariantCulture,
                    $"模型校验失败（期望 {StemSeparationService.ModelSha256[..12]}…，实际 {actual[..12]}…）"));
        }

        Directory.CreateDirectory(Path.GetDirectoryName(TargetPath)!);
        File.Move(partPath, TargetPath, overwrite: true);
        Interlocked.Exchange(ref _done, new FileInfo(TargetPath).Length);
        Interlocked.Exchange(ref _total, Interlocked.Read(ref _done));
        lock (_gate)
        {
            _state = Ready;
            _error = string.Empty;
        }

        HostLog.Info($"stems.model-download ready path={TargetPath} bytes={Interlocked.Read(ref _done)}");
    }

    private static string Sha256Of(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, useAsync: false);
        using var sha = SHA256.Create();
        var hash = sha.ComputeHash(stream);
        return Convert.ToHexString(hash).ToLowerInvariant();
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
            // 下次下载会覆盖。
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        lock (_gate)
        {
            _cts?.Cancel();
            _cts?.Dispose();
            _cts = null;
        }

        _client.Dispose();
    }
}

internal sealed class StemModelStatus
{
    public string State { get; set; } = StemModelInstaller.Idle;

    public long Bytes { get; set; }

    public long TotalBytes { get; set; }

    public string Error { get; set; } = string.Empty;

    public int Attempt { get; set; }

    public string Path { get; set; } = string.Empty;
}
