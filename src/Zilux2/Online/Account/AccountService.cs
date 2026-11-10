namespace Zilux2.Online.Account;

// Contract docs/zilux2-account-login.md §1/§3: owns the persisted account store plus the two
// QR-login providers, and answers the loopback API with already-shaped DTOs.
internal sealed class AccountService : IDisposable
{
    private static readonly string[] AllSources = [AccountSources.Netease, AccountSources.Qq, AccountSources.Kugou];

    private readonly AccountStore _store;
    private readonly NeteaseLoginProvider _netease;
    private readonly NeteaseQqLoginProvider _neteaseQq;
    private readonly QqLoginProvider _qq;
    private readonly KugouLoginProvider _kugou;
    private readonly QqMusicAppLoginProvider _qqMusic;
    private readonly QqMusicWechatLoginProvider _qqWechat;
    private readonly AccountImporter _importer;
    private bool _disposed;

    public AccountService(string? storePathOverride = null)
    {
        _store = new AccountStore(storePathOverride);
        _store.Load();
        _netease = new NeteaseLoginProvider(_store);
        _neteaseQq = new NeteaseQqLoginProvider(_netease);
        _qq = new QqLoginProvider(_store);
        _kugou = new KugouLoginProvider(_store);
        _qqMusic = new QqMusicAppLoginProvider(_store, _qq);
        _qqWechat = new QqMusicWechatLoginProvider(_qq);
        _importer = new AccountImporter(_store);
        OnlineHttp.Info($"[account] ready sources={string.Join(",", AllSources)} path={_store.FilePath}");

        // Best effort, never delays startup: an already logged-in account picks up nickname,
        // avatar and membership without asking for a new scan.
        _ = Task.Run(RefreshProfilesAsync);
    }

    private async Task RefreshProfilesAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        foreach (var source in AllSources)
        {
            try
            {
                await RefreshProfileAsync(source, timeout.Token).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !timeout.IsCancellationRequested)
            {
                OnlineHttp.Warn($"[account] refresh {source} failed: {OnlineHttp.Describe(exception)}");
            }
        }
    }

    /// <summary>登录完成后立刻补齐昵称/头像（公开方法，供登录轮询与快捷登录复用）。</summary>
    public async Task<AccountInfo?> RefreshProfileAsync(string source, CancellationToken cancellationToken)
    {
        source = NormalizeSource(source);
        if (!IsLoggedIn(source))
        {
            return null;
        }

        var cookies = _store.GetCookies(source);
        if (cookies is null || cookies.Count == 0)
        {
            return null;
        }

        var refreshed = source switch
        {
            AccountSources.Qq => await _qq.RefreshAsync(cookies, cancellationToken).ConfigureAwait(false),
            AccountSources.Kugou => await _kugou.RefreshAsync(cookies, cancellationToken).ConfigureAwait(false),
            AccountSources.Netease => await _netease.RefreshAsync(cookies, cancellationToken).ConfigureAwait(false),
            _ => null,
        };
        if (refreshed is null)
        {
            return _store.GetAccountInfo(source);
        }

        _store.UpdateProfile(source, refreshed);
        return _store.GetAccountInfo(source);
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

    /// <summary>读取某平台的原始 cookie 列表（酷狗这类 cookie 域不是标准 host 的场景用）。</summary>
    public IReadOnlyList<StoredCookie>? GetCookies(string source) => _store.GetCookies(source);

    public Task<LoginQrResponse> CreateLoginQrAsync(string source, string? channel, CancellationToken cancellationToken) =>
        NormalizeSource(source) switch
        {
            AccountSources.Netease when string.Equals(channel, "ptlogin", StringComparison.OrdinalIgnoreCase)
                => _neteaseQq.CreateQrAsync(cancellationToken),
            // QQ 音乐 App 扫码：一个二维码，手机 QQ / 微信 / QQ 音乐 App 都能扫。
            AccountSources.Qq when string.Equals(channel, "qqmusic", StringComparison.OrdinalIgnoreCase)
                => CreateQqMusicQrAsync(cancellationToken),
            AccountSources.Qq when string.Equals(channel, "wechat", StringComparison.OrdinalIgnoreCase)
                => CreateQqWechatQrAsync(cancellationToken),
            AccountSources.Qq => _qq.CreateQrAsync(cancellationToken),
            AccountSources.Kugou => _kugou.CreateQrAsync(cancellationToken),
            _ => _netease.CreateQrAsync(cancellationToken),
        };

    private async Task<LoginQrResponse> CreateQqMusicQrAsync(CancellationToken cancellationToken)
    {
        var qr = await _qqMusic.CreateQrAsync(cancellationToken).ConfigureAwait(false);
        // 统一加 qm: 前缀，/api/account/login/status 据此路由回 App 扫码通道。
        return new LoginQrResponse
        {
            Source = qr.Source,
            Channel = qr.Channel,
            Mode = qr.Mode,
            Key = "qm:" + qr.Key,
            ImageDataUrl = qr.ImageDataUrl,
            ExpiresIn = qr.ExpiresIn,
        };
    }

    private async Task<LoginQrResponse> CreateQqWechatQrAsync(CancellationToken cancellationToken)
    {
        var qr = await _qqWechat.CreateQrAsync(cancellationToken).ConfigureAwait(false);
        return new LoginQrResponse
        {
            Source = qr.Source,
            Channel = qr.Channel,
            Mode = qr.Mode,
            Key = "wx:" + qr.Key,
            ImageDataUrl = qr.ImageDataUrl,
            ExpiresIn = qr.ExpiresIn,
        };
    }

    public Task<LoginStatusResponse> PollLoginAsync(
        string source,
        string key,
        CancellationToken cancellationToken)
    {
        var normalized = NormalizeSource(source);
        if (key.StartsWith(NeteaseQqLoginProvider.KeyPrefix, StringComparison.Ordinal))
            return normalized == AccountSources.Netease ? _neteaseQq.PollAsync(key, cancellationToken)
                : Task.FromResult(new LoginStatusResponse { State = "expired", Message = "二维码与登录平台不匹配，请刷新" });
        // QQ 音乐 App 通道的 key 带 qm: 前缀，与手机 QQ 扫码的会话区分开。
        if (normalized == AccountSources.Qq && key.StartsWith("qm:", StringComparison.Ordinal))
        {
            return Task.FromResult(_qqMusic.Poll(key[3..]));
        }

        if (normalized == AccountSources.Kugou && key.StartsWith("kg:", StringComparison.Ordinal))
        {
            return _kugou.PollAsync(key, cancellationToken);
        }

        if (normalized == AccountSources.Qq && key.StartsWith("wx:", StringComparison.Ordinal))
        {
            return Task.FromResult(_qqWechat.Poll(key[3..]));
        }

        return NormalizeSource(source) switch
        {
            AccountSources.Qq => _qq.PollAsync(key, cancellationToken),
            _ => _netease.PollAsync(key, cancellationToken),
        };
    }

    private static string? TryReadQueryValue(string url, string name)
    {
        if (string.IsNullOrEmpty(url)) return null;
        var index = url.IndexOf('?');
        if (index < 0) return null;
        var query = url[(index + 1)..];
        var hash = query.IndexOf('#');
        if (hash >= 0) query = query[..hash];
        foreach (var pair in query.Split('&'))
        {
            var eq = pair.IndexOf('=');
            if (eq <= 0) continue;
            if (string.Equals(pair[..eq], name, StringComparison.OrdinalIgnoreCase))
            {
                return Uri.UnescapeDataString(pair[(eq + 1)..]);
            }
        }

        return null;
    }
    // Both platforms authorize the selected local QQ entirely in the background.
    public async Task<AccountListResponse> QuickWebLoginAsync(string source, string accountId, CancellationToken cancellationToken)
    {
        var normalized = NormalizeSource(source);
        var app = System.Windows.Application.Current;
        if (app is null)
        {
            throw new AccountException("unavailable", "宿主窗口不可用");
        }

        var result = await app.Dispatcher
            .InvokeAsync(new Func<Task<WebLoginResult>>(() => QuickLoginProbe.LoginAsync(normalized, accountId, cancellationToken)))
            .Task.Unwrap()
            .ConfigureAwait(false);
        await SaveWebLoginResultAsync(normalized, result, cancellationToken).ConfigureAwait(false);
        OnlineHttp.Info($"[account] quick web login source={normalized} ok");
        return BuildAccountList();
    }
    // WebView2 快捷登录：打开平台官方登录页（腾讯的「本机 QQ 头像 / 二维码」由页面自己渲染），
    // 用户点一下头像即可。宿主只等登录 cookie 出现，再交给对应登录器落库。
    public async Task<AccountListResponse> WebLoginAsync(string source, CancellationToken cancellationToken)
    {
        var normalized = NormalizeSource(source);
        var app = System.Windows.Application.Current;
        if (app is null)
        {
            throw new AccountException("unavailable", "宿主窗口不可用");
        }

        WebLoginResult? result;
        try
        {
            var show = new Func<Task<WebLoginResult?>>(async () =>
            {
                var owner = app.MainWindow ?? throw new AccountException("unavailable", "宿主窗口不可用");
                if (normalized == AccountSources.Netease)
                {
                    return await LoginWebWindow.ShowAsync(
                        owner,
                        "网易云音乐 · QQ 登录",
                        "点本机 QQ 头像授权，或用手机 QQ 扫码。登录成功后窗口会自动关闭。",
                        "https://music.163.com/api/sns/authorize?snsType=5&clientType=web2&callbackType=Login&forcelogin=true",
                        "https://music.163.com",
                        "MUSIC_U").ConfigureAwait(true);
                }

                // QQ 音乐必须走 OAuth 授权页：点本机头像后 302 到 y.qq.com 的 wx_redirect 并带上 code，
                // 这个 code 还要再换 musickey，光等 qm_keyst 是等不到的。
                var authorize =
                    "https://graph.qq.com/oauth2.0/authorize?client_id=100497308&response_type=code" +
                    "&redirect_uri=" + Uri.EscapeDataString(QqLoginProvider.RedirectUri) +
                    "&state=" + Random.Shared.Next(100000, 999999) +
                    "&forcelogin=true";
                return await LoginWebWindow.ShowAsync(
                    owner,
                    "QQ 音乐 · 本机 QQ 快捷登录",
                    "点本机 QQ 头像授权，或用手机 QQ 扫码。登录成功后窗口会自动关闭。",
                    authorize,
                    "https://y.qq.com",
                    "qm_keyst",
                    "wx_redirect.html?code=").ConfigureAwait(true);
            });
            result = await app.Dispatcher.InvokeAsync(show).Task.Unwrap().ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw new AccountException("cancelled", "已取消登录");
        }

        if (result is null)
        {
            throw new AccountException("cancelled", "登录窗口已关闭");
        }

        await SaveWebLoginResultAsync(normalized, result, cancellationToken).ConfigureAwait(false);
        OnlineHttp.Info($"[account] web login source={normalized} ok");
        return BuildAccountList();
    }

    private async Task SaveWebLoginResultAsync(string normalized, WebLoginResult result, CancellationToken cancellationToken)
    {
        var cookies = result.Cookies;
        if (normalized == AccountSources.Kugou)
        {
            await _kugou.SaveWebCookiesAsync(cookies, cancellationToken).ConfigureAwait(false);
        }
        else if (normalized == AccountSources.Netease)
        {
            if (cookies.Count == 0)
            {
                throw new AccountException("cancelled", "登录窗口已关闭");
            }

            var stored = cookies
                .Select(cookie => new StoredCookie("music.163.com", cookie.Name, cookie.Value))
                .ToList();
            await _netease.SaveCookiesAsync(stored, cancellationToken).ConfigureAwait(false);
        }
        else if (TryReadQueryValue(result.Url, "code") is { Length: > 0 } oauthCode)
        {
            await _qq.SaveOAuthCodeAsync(oauthCode, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            string? musicKey = null;
            string? uin = null;
            foreach (var cookie in cookies)
            {
                if (cookie.Name is "qm_keyst" or "qqmusic_key") musicKey = cookie.Value;
                else if (cookie.Name is "uin" or "qqmusic_uin") uin = cookie.Value;
            }

            if (string.IsNullOrEmpty(musicKey) || string.IsNullOrEmpty(uin))
            {
                throw new AccountException("invalid-cookie", "没有拿到 QQ 音乐登录凭证，请重试");
            }

            // cookie 里的 uin 形如 o0123456789，musicu 要纯数字。
            var musicId = uin.TrimStart('o', 'O', '0');
            if (musicId.Length == 0) musicId = uin;
            await _qq.SaveCredentialAsync(musicId, musicKey, cancellationToken).ConfigureAwait(false);
        }
    }

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

    private static string NormalizeSource(string source)
    {
        if (string.Equals(source, AccountSources.Qq, StringComparison.OrdinalIgnoreCase))
        {
            return AccountSources.Qq;
        }

        if (string.Equals(source, AccountSources.Kugou, StringComparison.OrdinalIgnoreCase))
        {
            return AccountSources.Kugou;
        }

        return AccountSources.Netease;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _neteaseQq.Dispose();
        _netease.Dispose();
        _qq.Dispose();
        _store.Dispose();
    }
}












