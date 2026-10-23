using System.Security.Cryptography;
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

    public OnlineEndpoint? Endpoint { get; private set; }

    public string? FailureMessage { get; private set; }

    public bool IsRunning => Endpoint is not null;

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
            var server = new LocalMusicServer(_providers, Sources, token, Accounts, Library, _download);
            var port = server.Start();
            _server = server;
            Endpoint = new OnlineEndpoint(port, token, Sources.ToList());
            OnlineHttp.Info($"started port={port} sources={string.Join(",", Sources)}");
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

            _server = null;
            Endpoint = null;
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

        try
        {
            _download?.Dispose();
        }
        catch (Exception exception)
        {
            OnlineHttp.Error("download dispose failed", exception);
        }

        _download = null;

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
