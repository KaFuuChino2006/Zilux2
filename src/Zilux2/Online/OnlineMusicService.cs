using System.Security.Cryptography;
using Zilux2.Analysis;
using Zilux2.Online.Account;
using Zilux2.Online.Library;

namespace Zilux2.Online;

internal sealed record OnlineEndpoint(int Port, string Token, List<string> Sources);

// Owns the loopback HTTP server and its providers; every failure is reported, never thrown
// into the UI thread (contract docs/zilux2-online-music.md §6).
internal sealed class OnlineMusicService : IDisposable
{
    // Contract §6 allows env overrides so scripts can assert against a known token.
    private const string TokenOverrideVariable = "ZILUX2_ONLINE_TOKEN";
    private const int TokenHexLength = 32;

    private readonly Dictionary<string, IOnlineMusicProvider> _providers = new(StringComparer.OrdinalIgnoreCase);
    private LocalMusicServer? _server;
    private DownloadService? _download;
    private TrackAnalysisService? _analysis;
    private CancellationTokenSource? _accountVerifyCts;
    private bool _disposed;

    public OnlineMusicService()
    {
        // Account state is created first: both providers read persisted cookies from it.
        Accounts = new AccountService();
        foreach (var provider in new IOnlineMusicProvider[] { new NeteaseProvider(Accounts), new QqProvider(Accounts), new KugouProvider(), new Mvmp3Provider() })
        {
            _providers[provider.Name] = provider;
        }

        Sources = _providers.Keys.ToList();
        // The library shares the account cookies, so login/logout invalidate its cache lazily.
        Library = new LibraryService(Accounts);
    }

    public AccountService Accounts { get; }

    public LibraryService Library { get; }

    public IReadOnlyList<string> Sources { get; }

    /// <summary>下载目录（由 App 指向设置里的 downloads.directory；空表示 Windows 音乐目录）。</summary>
    internal Func<string?>? DownloadDirectoryProvider { get; set; }

    /// <summary>下载音质（由 App 指向设置里的 downloads.quality；空表示默认高品质）。</summary>
    internal Func<string?>? DownloadQualityProvider { get; set; }

    /// <summary>下载完成回调（宿主用它刷新本地曲库）。</summary>
    internal Action<string>? FileDownloaded { get; set; }

    /// <summary>
    /// 本地曲库 rel → 磁盘路径（离线节拍分析 /api/analysis 用）。由 WebViewHost 接到
    /// LocalMusicService.ResolveTrackPath（必须在该回调里切回 UI 线程）。
    /// </summary>
    internal Func<string?, string?>? LocalPathResolver { get; set; }

    /// <summary>
    /// 标签写入成功回调（/api/local/tag 用），参数是写成功的磁盘全路径。由 WebViewHost 接到
    /// LocalMusicService.NotifyTagWritten（必须在回调里切回 UI 线程）。
    /// </summary>
    internal Action<string>? LocalFileChanged { get; set; }

    public OnlineEndpoint? Endpoint { get; private set; }

    public string? FailureMessage { get; private set; }

    public bool IsRunning => Endpoint is not null;

    // 登录状态检测（第四十六轮）：定时验证发现掉登录时触发，宿主转发成页面提醒/托盘气泡。
    public event Action<string>? AccountSessionExpired;

    public void Start()
    {
        if (Endpoint is not null || FailureMessage is not null || _disposed)
        {
            return;
        }

        try
        {
            var token = ResolveToken();
            _download = new DownloadService(
                () => DownloadDirectoryProvider?.Invoke(),
                () => DownloadQualityProvider?.Invoke(),
                path => FileDownloaded?.Invoke(path));
            // 离线节拍分析：音质缺省跟随下载设置；本地 rel 解析回调由 WebViewHost 接入。
            _analysis = new TrackAnalysisService(
                _providers,
                () => DownloadQualityProvider?.Invoke(),
                rel => LocalPathResolver?.Invoke(rel));
            var server = new LocalMusicServer(_providers, Sources, token, Accounts, Library, _download, _analysis)
            {
                // Lambda 每次都读属性：WebViewHost 在窗口创建后才接线，而服务更早 Start。
                LocalPathResolver = rel => LocalPathResolver?.Invoke(rel),
                LocalFileChanged = path => LocalFileChanged?.Invoke(path),
            };
            var port = server.Start();
            _server = server;
            Endpoint = new OnlineEndpoint(port, token, Sources.ToList());
            OnlineHttp.Info($"started port={port} sources={string.Join(",", Sources)}");
            StartAccountVerification();
        }
        catch (Exception exception)
        {
            FailureMessage = $"在线音乐服务启动失败：{exception.Message}";
            OnlineHttp.Error("start failed", exception);
            try
            {
                _server?.Dispose();
            }
            catch (Exception disposeException)
            {
                OnlineHttp.Error("start cleanup failed", disposeException);
            }

            try
            {
                _analysis?.Dispose();
            }
            catch (Exception disposeException)
            {
                OnlineHttp.Error("analysis cleanup failed", disposeException);
            }

            _analysis = null;
            _server = null;
            Endpoint = null;
        }
    }

    // 登录状态检测（第四十六轮）：启动 20s 后首检，之后每 5 分钟一次。
    // 只问已登录的平台；网络异常保留账号（unknown），平台明确拒绝才清号并提醒。
    private void StartAccountVerification()
    {
        if (_accountVerifyCts is not null)
        {
            return;
        }

        _accountVerifyCts = new CancellationTokenSource();
        Accounts.SessionExpired += OnAccountSessionExpired;
        _ = Task.Run(() => VerifyAccountsLoopAsync(_accountVerifyCts.Token));
    }

    private void OnAccountSessionExpired(string source) => AccountSessionExpired?.Invoke(source);

    private async Task VerifyAccountsLoopAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(20), cancellationToken).ConfigureAwait(false);
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    var results = await Accounts.VerifySessionsAsync(cancellationToken).ConfigureAwait(false);
                    var expired = results
                        .Where(item => string.Equals(item.Status, AccountVerifyStatus.Expired, StringComparison.Ordinal))
                        .Select(item => item.Source)
                        .ToList();
                    if (expired.Count > 0)
                    {
                        OnlineHttp.Info($"[account] verify expired={string.Join(",", expired)}");
                    }
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception exception)
                {
                    OnlineHttp.Warn($"[account] verify failed: {OnlineHttp.Describe(exception)}");
                }

                await Task.Delay(TimeSpan.FromMinutes(5), cancellationToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            // 宿主退出时取消，忽略。
        }
    }

    public OnlineEventPayload BuildEventPayload()
    {
        var endpoint = Endpoint ?? throw new InvalidOperationException("online music service is not running");
        return new OnlineEventPayload
        {
            Port = endpoint.Port,
            Token = endpoint.Token,
            Sources = endpoint.Sources.ToList(),
        };
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        try
        {
            _server?.Dispose();
        }
        catch (Exception exception)
        {
            OnlineHttp.Error("dispose failed", exception);
        }

        _server = null;
        Endpoint = null;

        // 分析任务可能在写缓存/下载音频，先撤它再撤下载与账号。
        try
        {
            _analysis?.Dispose();
        }
        catch (Exception exception)
        {
            OnlineHttp.Error("analysis dispose failed", exception);
        }

        _analysis = null;

        try
        {
            _download?.Dispose();
        }
        catch (Exception exception)
        {
            OnlineHttp.Error("download dispose failed", exception);
        }

        _download = null;

        // 登录检测循环先停：它会在宿主退出后继续访问网络。
        try
        {
            _accountVerifyCts?.Cancel();
            _accountVerifyCts?.Dispose();
            _accountVerifyCts = null;
            Accounts.SessionExpired -= OnAccountSessionExpired;
        }
        catch (Exception exception)
        {
            OnlineHttp.Warn($"[account] verify loop stop failed: {OnlineHttp.Describe(exception)}");
        }

        // Flushes a pending account.json write; the QR sessions never outlive the host.
        try
        {
            Accounts.Dispose();
        }
        catch (Exception exception)
        {
            OnlineHttp.Error("account dispose failed", exception);
        }
    }

    private static string ResolveToken()
    {
        var configured = Environment.GetEnvironmentVariable(TokenOverrideVariable)?.Trim();
        if (configured is { Length: TokenHexLength } && configured.All(Uri.IsHexDigit))
        {
            OnlineHttp.Info("token source=env");
            return configured.ToLowerInvariant();
        }

        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        OnlineHttp.Info("token source=generated");
        return token;
    }
}
