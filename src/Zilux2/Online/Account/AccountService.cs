namespace Zilux2.Online.Account;

// Contract docs/zilux2-account-login.md §1/§3: owns the persisted account store plus the two
// QR-login providers, and answers the loopback API with already-shaped DTOs.
internal sealed class AccountService : IDisposable
{
    private static readonly string[] AllSources = [AccountSources.Netease, AccountSources.Qq];

    private readonly AccountStore _store;
    private readonly NeteaseLoginProvider _netease;
    private readonly QqLoginProvider _qq;
    private readonly AccountImporter _importer;
    private bool _disposed;

    public AccountService(string? storePathOverride = null)
    {
        _store = new AccountStore(storePathOverride);
        _store.Load();
        _netease = new NeteaseLoginProvider(_store);
        _qq = new QqLoginProvider(_store);
        _importer = new AccountImporter(_store);
        OnlineHttp.Info($"[account] ready sources=netease,qq path={_store.FilePath}");

        // Best effort, never delays startup: an already logged-in account picks up nickname,
        // avatar and membership without asking for a new scan.
        _ = Task.Run(RefreshProfilesAsync);
    }

    private async Task RefreshProfilesAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        foreach (var source in AllSources)
        {
            if (!IsLoggedIn(source))
            {
                continue;
            }

            var cookies = _store.GetCookies(source);
            if (cookies is null || cookies.Count == 0)
            {
                continue;
            }

            try
            {
                var refreshed = source switch
                {
                    AccountSources.Qq => await _qq.RefreshAsync(cookies, timeout.Token).ConfigureAwait(false),
                    _ => await _netease.RefreshAsync(cookies, timeout.Token).ConfigureAwait(false),
                };
                if (refreshed is not null)
                {
                    _store.UpdateProfile(source, refreshed);
                }
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !timeout.IsCancellationRequested)
            {
                OnlineHttp.Warn($"[account] refresh {source} failed: {OnlineHttp.Describe(exception)}");
            }
        }
    }

    public IReadOnlyList<string> Sources => AllSources;

    public string StorePath => _store.FilePath;

    public AccountListResponse BuildAccountList() => new()
    {
        Sources = AllSources
            .Select(source => _store.GetAccountInfo(source) ?? new AccountInfo { Source = source, LoggedIn = false })
            .ToList(),
    };

    public AccountInfo? GetAccount(string source) => _store.GetAccountInfo(source);

    public bool IsLoggedIn(string source) => _store.GetAccountInfo(source) is not null;

    public string? GetUserId(string source) => _store.GetUserId(source);

    public string CookieHeader(string source, string host) => _store.CookieHeader(source, host);

    public Task<LoginQrResponse> CreateLoginQrAsync(string source, CancellationToken cancellationToken) =>
        NormalizeSource(source) switch
        {
            AccountSources.Qq => _qq.CreateQrAsync(cancellationToken),
            _ => _netease.CreateQrAsync(cancellationToken),
        };

    public Task<LoginStatusResponse> PollLoginAsync(
        string source,
        string key,
        CancellationToken cancellationToken) =>
        NormalizeSource(source) switch
        {
            AccountSources.Qq => _qq.PollAsync(key, cancellationToken),
            _ => _netease.PollAsync(key, cancellationToken),
        };

    // Cookie paste import (docs/zilux2-account-login.md §9): validates the pasted header against the
    // platform API before persisting, so a stale cookie can never masquerade as a login.
    public async Task<AccountListResponse> ImportAsync(
        string source,
        string cookieHeader,
        CancellationToken cancellationToken)
    {
        await _importer.ImportAsync(NormalizeSource(source), cookieHeader, cancellationToken).ConfigureAwait(false);
        return BuildAccountList();
    }

    public bool Logout(string source)
    {
        var normalized = NormalizeSource(source);
        var removed = _store.Remove(normalized);
        OnlineHttp.Info($"[account] logout source={normalized} wasLoggedIn={removed}");
        return removed;
    }

    // 登录状态检测（第四十六轮）：用已保存的 cookie 直接问平台是否仍然有效。
    // 失效的账号会被移除并触发 SessionExpired，让上层推提醒；网络异常只标记 unknown，绝不清号。
    public event Action<string>? SessionExpired;

    public async Task<IReadOnlyList<AccountVerifyItem>> VerifySessionsAsync(CancellationToken cancellationToken = default)
    {
        var results = new List<AccountVerifyItem>();
        foreach (var source in AllSources)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var account = _store.GetAccountInfo(source);
            if (account is null || !account.LoggedIn)
            {
                results.Add(new AccountVerifyItem
                {
                    Source = source,
                    LoggedIn = false,
                    Status = AccountVerifyStatus.LoggedOut,
                });
                continue;
            }

            var cookies = _store.GetCookies(source);
            var check = cookies is { Count: > 0 }
                ? await AccountVerifier.CheckAsync(source, cookies, cancellationToken).ConfigureAwait(false)
                : AccountSessionCheck.Expired("本地缺少 cookie");

            if (string.Equals(check.Status, AccountVerifyStatus.Expired, StringComparison.Ordinal))
            {
                _store.Remove(source);
                OnlineHttp.Warn($"[account] session expired source={source} reason={check.Reason ?? "unknown"}");
                SessionExpired?.Invoke(source);
                results.Add(new AccountVerifyItem
                {
                    Source = source,
                    LoggedIn = false,
                    Status = AccountVerifyStatus.Expired,
                    Reason = check.Reason,
                });
                continue;
            }

            results.Add(new AccountVerifyItem
            {
                Source = source,
                LoggedIn = true,
                Status = check.Status,
                Reason = check.Reason,
            });
        }

        return results;
    }

    private static string NormalizeSource(string source) =>
        string.Equals(source, AccountSources.Qq, StringComparison.OrdinalIgnoreCase)
            ? AccountSources.Qq
            : AccountSources.Netease;

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _netease.Dispose();
        _qq.Dispose();
        _store.Dispose();
    }
}
