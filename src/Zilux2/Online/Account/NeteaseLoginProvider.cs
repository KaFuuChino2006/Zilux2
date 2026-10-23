using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace Zilux2.Online.Account;

// Netease QR login (contract §4): POST unikey (type=3) -> frontend renders the QR -> POST
// client/login (type=3) -> MUSIC_U cookie -> profile. The api-domain variant needs the desktop
// client identity cookies; sending a bare GET (the old code) is what upstream answered with the
// 8821 risk-control code instead of 802/803.
internal sealed class NeteaseLoginProvider : IDisposable
{
    internal const string Origin = "https://music.163.com";
    internal const string RefererUrl = "https://music.163.com/";
    internal const string UniKeyPath = "/api/login/qrcode/unikey";
    internal const string ClientLoginPath = "/api/login/qrcode/client/login";
    internal const string ProfileEndpoint = Origin + "/api/nuser/account/get";
    internal const string CookieDomain = "music.163.com";
    internal const int QrExpiresSeconds = 300;
    internal const int QrCodeType = 3;
    internal const int RiskControlCode = 8821;

    internal const string DesktopUserAgent =
        "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.29.205117";

    internal const string RiskControlMessage =
        "网易云风控拦截（8821）：请确认用网易云音乐 App 扫码并在手机上点确认；如仍失败请改用 Cookie 导入";

    private static readonly TimeSpan SessionLifetime = TimeSpan.FromSeconds(QrExpiresSeconds);

    private readonly AccountStore _store;
    private readonly Dictionary<string, Session> _sessions = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private bool _disposed;

    public NeteaseLoginProvider(AccountStore store) => _store = store;

    public async Task<LoginQrResponse> CreateQrAsync(CancellationToken cancellationToken)
    {
        var session = new LoginHttpSession(DesktopUserAgent);
        try
        {
            SeedIdentityCookies(session);

            var response = await PostFormAsync(session, UniKeyPath, BuildUniKeyForm(QrCodeType), cancellationToken)
                .ConfigureAwait(false);
            var unikey = ParseUniKey(response.Body);
            if (response.Status != 200 || unikey.Length == 0)
            {
                // Some accounts are still routed to the old type=1 endpoint; retry once so the QR
                // panel works even when the server ignores type=3.
                OnlineHttp.Warn($"[account] netease unikey type=3 failed status={response.Status}, retrying type=1");
                response = await PostFormAsync(session, UniKeyPath, BuildUniKeyForm(1), cancellationToken)
                    .ConfigureAwait(false);
                unikey = ParseUniKey(response.Body);
            }

            if (response.Status != 200)
            {
                throw new AccountException("upstream-failed", $"网易云二维码获取失败（HTTP {response.Status}）");
            }

            if (unikey.Length == 0)
            {
                throw new AccountException("upstream-failed", "网易云没有返回二维码 key，请稍后重试");
            }

            lock (_gate)
            {
                PruneSessionsLocked();
                _sessions[unikey] = new Session(unikey, DateTimeOffset.UtcNow, session);
            }

            OnlineHttp.Info($"[account] qr source=netease keyLen={unikey.Length} expiresIn={QrExpiresSeconds}");
            return new LoginQrResponse
            {
                Source = AccountSources.Netease,
                Mode = "code",
                Key = unikey,
                Content = $"{Origin}/login?codekey={unikey}",
                ExpiresIn = QrExpiresSeconds,
            };
        }
        catch
        {
            session.Dispose();
            throw;
        }
    }

    public async Task<LoginStatusResponse> PollAsync(string key, CancellationToken cancellationToken)
    {
        var session = GetSession(key);
        if (session is null)
        {
            return Expired("二维码已过期，请重新获取");
        }

        if (DateTimeOffset.UtcNow - session.CreatedAt > SessionLifetime)
        {
            RemoveSession(key);
            return Expired("二维码已过期，请重新获取");
        }

        LoginHttpResponse response;
        try
        {
            response = await PostFormAsync(
                    session.Http,
                    ClientLoginPath,
                    BuildPollForm(key, QrCodeType),
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // A single network blip must not end the QR session; the page polls every ~2 s.
            OnlineHttp.Warn($"POST netease/login/status failed: {OnlineHttp.Describe(exception)}");
            return Waiting("网络波动，正在重试");
        }

        if (response.Status is not (200 or 201 or 302 or 400 or 502))
        {
            OnlineHttp.Warn($"POST netease/login/status HTTP {response.Status}");
            return Waiting("网络波动，正在重试");
        }

        var code = ParseCode(response.Body);
        if (!IsKnownStatus(code))
        {
            // type=1 fallback for accounts still on the legacy flow.
            OnlineHttp.Warn($"[account] netease status type=3 code={code}, retrying type=1");
            response = await PostFormAsync(session.Http, ClientLoginPath, BuildPollForm(key, 1), cancellationToken)
                .ConfigureAwait(false);
            code = ParseCode(response.Body);
        }

        // Capture credentials from the body cookie string and any Set-Cookie headers before the
        // switch, because 803 can carry MUSIC_U either way.
        RememberResponseCookies(session.Http, response);

        if (TryMapPollStatus(code, HasCookie(session, "MUSIC_U"), out var state, out var message))
        {
            if (state == "authorized")
            {
                return await CompleteAsync(session, key, cancellationToken).ConfigureAwait(false);
            }

            if (state == "expired")
            {
                RemoveSession(key);
            }

            return new LoginStatusResponse { State = state, Message = message };
        }

        RemoveSession(key);
        OnlineHttp.Warn($"[account] netease login unknown code={code}");
        return Failed("网易云返回未知登录状态，请重新获取二维码");
    }

    private async Task<LoginStatusResponse> CompleteAsync(
        Session session,
        string key,
        CancellationToken cancellationToken)
    {
        if (!HasCookie(session, "MUSIC_U"))
        {
            RemoveSession(key);
            OnlineHttp.Warn("[account] login failed source=netease err=no MUSIC_U cookie");
            return Failed("网易云没有返回登录凭据（MUSIC_U），请重新扫码或改用 Cookie 导入");
        }

        var account = await FetchAccountAsync(session, cancellationToken).ConfigureAwait(false);
        var cookies = CookieJar.Snapshot(session.Http.Cookies);
        try
        {
            _store.SaveLogin(AccountSources.Netease, account, cookies);
        }
        catch (AccountException exception)
        {
            RemoveSession(key);
            return Failed(exception.Message);
        }

        RemoveSession(key);
        OnlineHttp.Info("[account] login source=netease ok");
        return new LoginStatusResponse { State = "authorized", Message = "登录成功", Account = account };
    }

    private async Task<AccountInfo> FetchAccountAsync(Session session, CancellationToken cancellationToken)
    {
        try
        {
            var response = await GetProfileWithRetryAsync(session, cancellationToken).ConfigureAwait(false);
            if (response.Status != 200)
            {
                OnlineHttp.Warn($"GET netease/account profile HTTP {response.Status}");
                return MinimalAccount();
            }

            using var document = JsonDocument.Parse(response.Body);
            var root = document.RootElement;
            var profile = root.TryGetProperty("profile", out var profileElement) && profileElement.ValueKind == JsonValueKind.Object
                ? profileElement
                : default;
            var accountNode = root.TryGetProperty("account", out var accountElement) && accountElement.ValueKind == JsonValueKind.Object
                ? accountElement
                : default;

            var nickname = profile.ValueKind == JsonValueKind.Object ? ReadString(profile, "nickname") : string.Empty;
            if (nickname.Length == 0 && accountNode.ValueKind == JsonValueKind.Object)
            {
                nickname = ReadString(accountNode, "userName");
            }

            var userId = profile.ValueKind == JsonValueKind.Object
                ? ReadLongText(profile, "userId")
                : string.Empty;
            if (userId.Length == 0 && accountNode.ValueKind == JsonValueKind.Object)
            {
                userId = ReadLongText(accountNode, "id");
            }

            bool? vip = null;
            if (profile.ValueKind == JsonValueKind.Object)
            {
                if (profile.TryGetProperty("isVip", out var isVip) && isVip.ValueKind is JsonValueKind.True or JsonValueKind.False)
                {
                    vip = isVip.GetBoolean();
                }
                else if (profile.TryGetProperty("vipType", out var vipType) && vipType.TryGetInt32(out var vipTypeValue))
                {
                    vip = vipTypeValue > 0;
                }
            }

            vip ??= await FetchVipAsync(session, cancellationToken).ConfigureAwait(false);

            var avatarUrl = profile.ValueKind == JsonValueKind.Object ? ReadString(profile, "avatarUrl") : string.Empty;
            var avatarDataUrl = await AvatarEncoding
                .ToDataUrlAsync(session.Http, avatarUrl, cancellationToken)
                .ConfigureAwait(false);

            OnlineHttp.Info($"[account] profile source=netease userId={userId} vip={vip?.ToString() ?? "unknown"}");
            return new AccountInfo
            {
                Source = AccountSources.Netease,
                LoggedIn = true,
                Nickname = nickname.Length > 0 ? nickname : null,
                AvatarDataUrl = avatarDataUrl,
                Vip = vip,
                UserId = userId.Length > 0 ? userId : null,
            };
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // The login itself succeeded; profile details are decoration, never a reason to fail.
            OnlineHttp.Warn($"GET netease/account profile failed: {OnlineHttp.Describe(exception)}");
            return MinimalAccount();
        }
    }

    // Rebuilds a session from the persisted cookies and refreshes nickname / avatar / vip. Used at
    // startup so an already logged-in account picks up profile fixes without asking for a new scan.
    public async Task<AccountInfo?> RefreshAsync(
        IReadOnlyList<StoredCookie> cookies,
        CancellationToken cancellationToken)
    {
        using var session = new LoginHttpSession(DesktopUserAgent);
        SeedIdentityCookies(session);
        foreach (var cookie in cookies)
        {
            if (!string.IsNullOrEmpty(cookie.Value))
            {
                session.SetCookie(cookie.Domain, cookie.Name, cookie.Value);
            }
        }

        if (session.GetCookieValue("MUSIC_U") is null)
        {
            return null;
        }

        try
        {
            return await FetchAccountAsync(new Session("refresh", DateTimeOffset.UtcNow, session), cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"[account] netease profile refresh failed: {OnlineHttp.Describe(exception)}");
            return null;
        }
    }

    // The profile endpoint is occasionally slower than the QR poll; give it its own budget so a
    // slow upstream never cancels the login result, and retry once before degrading to minimal info.
    private static async Task<LoginHttpResponse> GetProfileWithRetryAsync(
        Session session,
        CancellationToken cancellationToken)
    {
        for (var attempt = 0; ; attempt++)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(9));
            try
            {
                return await session.Http.GetAsync(ProfileEndpoint, RefererUrl, timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && attempt == 0)
            {
                OnlineHttp.Warn("[account] netease profile timeout, retrying once");
            }
        }
    }

    // VIP facts are not part of profile on every account; ask the music-vip endpoint and treat any
    // positive level / associator flag as membership.
    private static async Task<bool?> FetchVipAsync(Session session, CancellationToken cancellationToken)
    {
        string[] endpoints =
        [
            Origin + "/api/vip/info",
            Origin + "/api/music-vip-membership/front/vip/info",
        ];
        foreach (var endpoint in endpoints)
        {
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(9));
                var response = await session.Http.GetAsync(endpoint, RefererUrl, timeout.Token).ConfigureAwait(false);
                if (response.Status != 200)
                {
                    continue;
                }

                using var document = JsonDocument.Parse(response.Body);
                if (TryReadNeteaseVip(document.RootElement, out var vip))
                {
                    OnlineHttp.Info($"[account] netease vip endpoint={endpoint[(Origin.Length + 1)..]} vip={vip}");
                    return vip;
                }
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                OnlineHttp.Warn($"[account] netease vip query failed: {OnlineHttp.Describe(exception)}");
            }
        }

        return null;
    }

    private static bool TryReadNeteaseVip(JsonElement root, out bool vip)
    {
        var found = false;
        var result = false;
        Walk(root, 0);
        vip = result;
        return found;

        void Walk(JsonElement element, int depth)
        {
            if (found || depth > 4 || element.ValueKind != JsonValueKind.Object)
            {
                return;
            }

            foreach (var property in element.EnumerateObject())
            {
                if (found)
                {
                    return;
                }

                switch (property.Name)
                {
                    case "isVip" or "isVipUser" when property.Value.ValueKind is JsonValueKind.True or JsonValueKind.False:
                        result = property.Value.GetBoolean();
                        found = true;
                        return;
                    case "redVipLevel" or "redVipAnnualCount" or "vipType" or "vipCode" or "vipLevel" or "musicPackage" or "associator":
                        if (property.Value.ValueKind == JsonValueKind.Number &&
                            property.Value.TryGetInt32(out var level))
                        {
                            result = level > 0;
                            found = true;
                            return;
                        }

                        break;
                }

                if (property.Value.ValueKind == JsonValueKind.Object)
                {
                    Walk(property.Value, depth + 1);
                }
            }
        }
    }

    // ---- deterministic pieces, also exercised by tools/account-selftest.ps1 (ZILUX2_ACCOUNT_SELFTEST) ----

    internal static string BuildUniKeyForm(int type) => "type=" + type.ToString(CultureInfo.InvariantCulture);

    internal static string BuildPollForm(string key, int type) =>
        "key=" + Uri.EscapeDataString(key) +
        "&type=" + type.ToString(CultureInfo.InvariantCulture);

    // Values copied from the desktop client's request identity. Without them the api domain
    // treats the QR poll as an anonymous browser and answers 8821 instead of 802/803.
    internal static List<StoredCookie> BuildIdentityCookies(
        string deviceId,
        string ntesNuid,
        string ntesNnid,
        string wnmcid,
        string buildVersion)
    {
        return
        [
            new StoredCookie(CookieDomain, "os", "pc"),
            new StoredCookie(CookieDomain, "appver", "3.1.29.205117"),
            new StoredCookie(CookieDomain, "channel", "netease"),
            new StoredCookie(CookieDomain, "versioncode", "140"),
            new StoredCookie(CookieDomain, "resolution", "1920x1080"),
            new StoredCookie(CookieDomain, "deviceId", deviceId),
            new StoredCookie(CookieDomain, "_ntes_nuid", ntesNuid),
            new StoredCookie(CookieDomain, "_ntes_nnid", ntesNnid),
            new StoredCookie(CookieDomain, "buildver", buildVersion),
            new StoredCookie(CookieDomain, "__remember_me", "true"),
            new StoredCookie(CookieDomain, "ntes_kaola_ad", "1"),
            new StoredCookie(CookieDomain, "WEVNSM", "1.0.0"),
            new StoredCookie(CookieDomain, "WNMCID", wnmcid),
        ];
    }

    // Netease answers the poll with HTTP 200 even for its own status codes, so the mapping has to
    // be explicit. 8821 is risk control, not expiry: the message must tell the user what to do.
    internal static bool TryMapPollStatus(int code, bool hasMusicU, out string state, out string message)
    {
        state = string.Empty;
        message = string.Empty;
        switch (code)
        {
            case 800:
                state = "expired";
                message = "二维码已过期，请重新获取";
                return true;
            case 801:
                state = "waiting";
                message = "等待手机扫码";
                return true;
            case 802:
                state = "scanned";
                message = "已扫码，请在手机上确认";
                return true;
            case 803:
                state = hasMusicU ? "authorized" : "error";
                message = hasMusicU ? "登录成功" : "网易云没有返回登录凭据（MUSIC_U），请重新扫码或改用 Cookie 导入";
                return true;
            case RiskControlCode:
                state = "error";
                message = RiskControlMessage;
                return true;
            default:
                return false;
        }
    }

    internal static bool IsKnownStatus(int code) => TryMapPollStatus(code, false, out _, out _);

    internal static string ParseUniKey(string? body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return string.Empty;
        }

        try
        {
            using var document = JsonDocument.Parse(body);
            var unikey = ReadString(document.RootElement, "unikey");
            if (unikey.Length == 0 &&
                document.RootElement.TryGetProperty("data", out var data) &&
                data.ValueKind == JsonValueKind.Object)
            {
                unikey = ReadString(data, "unikey");
            }

            return unikey;
        }
        catch (JsonException)
        {
            return string.Empty;
        }
    }

    internal static int ParseCode(string? body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return -1;
        }

        try
        {
            using var document = JsonDocument.Parse(body);
            return ReadInt(document.RootElement, "code", -1);
        }
        catch (JsonException)
        {
            return -1;
        }
    }

    internal static string? FindCookieInResponse(
        IReadOnlyList<string>? setCookies,
        string? bodyCookieString,
        string name)
    {
        var fromHeaders = SetCookieParser.ToDictionary(setCookies, out _);
        if (fromHeaders.TryGetValue(name, out var value) && value.Length > 0)
        {
            return value;
        }

        var fromBody = SetCookieParser.FromCookieHeader(bodyCookieString);
        return fromBody.TryGetValue(name, out var bodyValue) && bodyValue.Length > 0 ? bodyValue : null;
    }

    private static async Task<LoginHttpResponse> PostFormAsync(
        LoginHttpSession session,
        string path,
        string form,
        CancellationToken cancellationToken)
    {
        return await session.PostFormAsync(Origin + path, form, RefererUrl, cancellationToken).ConfigureAwait(false);
    }

    private static void SeedIdentityCookies(LoginHttpSession session)
    {
        var deviceId = RandomHex(16);
        var ntesNuid = RandomHex(16);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var cookies = BuildIdentityCookies(
            deviceId,
            ntesNuid,
            $"{ntesNuid},{now.ToString(CultureInfo.InvariantCulture)}",
            $"{RandomHex(3)}.{now.ToString(CultureInfo.InvariantCulture)}.01.0",
            DateTimeOffset.Now.ToString("yyyyMMdd", CultureInfo.InvariantCulture));
        foreach (var cookie in cookies)
        {
            session.SetCookie(cookie.Domain, cookie.Name, cookie.Value);
        }
    }

    private static void RememberResponseCookies(LoginHttpSession session, LoginHttpResponse response)
    {
        var fromHeaders = SetCookieParser.ToDictionary(response.SetCookies, out _);
        foreach (var pair in fromHeaders)
        {
            session.SetCookie(CookieDomain, pair.Key, pair.Value);
        }

        string? bodyCookie = null;
        if (!string.IsNullOrWhiteSpace(response.Body))
        {
            try
            {
                using var document = JsonDocument.Parse(response.Body);
                if (document.RootElement.TryGetProperty("cookie", out var cookieElement) &&
                    cookieElement.ValueKind == JsonValueKind.String)
                {
                    bodyCookie = cookieElement.GetString();
                }
            }
            catch (JsonException)
            {
                // Error pages are plain HTML; nothing to remember there.
            }
        }

        foreach (var pair in SetCookieParser.FromCookieHeader(bodyCookie))
        {
            session.SetCookie(CookieDomain, pair.Key, pair.Value);
        }
    }

    private static string RandomHex(int byteCount) =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes(byteCount)).ToLowerInvariant();

    private static AccountInfo MinimalAccount() => new()
    {
        Source = AccountSources.Netease,
        LoggedIn = true,
    };

    private Session? GetSession(string key)
    {
        lock (_gate)
        {
            return _sessions.TryGetValue(key, out var session) ? session : null;
        }
    }

    private void RemoveSession(string key)
    {
        Session? session;
        lock (_gate)
        {
            if (!_sessions.Remove(key, out session))
            {
                session = null;
            }
        }

        session?.Http.Dispose();
    }

    private void PruneSessionsLocked()
    {
        var now = DateTimeOffset.UtcNow;
        var stale = _sessions
            .Where(pair => now - pair.Value.CreatedAt > SessionLifetime)
            .Select(pair => pair.Key)
            .ToList();
        foreach (var key in stale)
        {
            if (_sessions.Remove(key, out var session))
            {
                session.Http.Dispose();
            }
        }

        // At most one live QR per platform is needed; drop the oldest extras.
        while (_sessions.Count > 2)
        {
            var oldest = _sessions.OrderBy(pair => pair.Value.CreatedAt).First().Key;
            if (_sessions.Remove(oldest, out var session))
            {
                session.Http.Dispose();
            }
        }
    }

    private static bool HasCookie(Session session, string name)
    {
        foreach (var cookie in CookieJar.Snapshot(session.Http.Cookies))
        {
            if (string.Equals(cookie.Name, name, StringComparison.OrdinalIgnoreCase) && cookie.Value.Length > 0)
            {
                return true;
            }
        }

        return false;
    }

    private static LoginStatusResponse Expired(string message) =>
        new() { State = "expired", Message = message };

    private static LoginStatusResponse Failed(string message) =>
        new() { State = "error", Message = message };

    private static LoginStatusResponse Waiting(string message) =>
        new() { State = "waiting", Message = message };

    private static string ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static string ReadLongText(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value))
        {
            return string.Empty;
        }

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? string.Empty,
            JsonValueKind.Number => value.GetRawText(),
            _ => string.Empty,
        };
    }

    private static int ReadInt(JsonElement element, string name, int fallback)
    {
        if (!element.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number))
        {
            return number;
        }

        if (value.ValueKind == JsonValueKind.String &&
            int.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out number))
        {
            return number;
        }

        return fallback;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        lock (_gate)
        {
            foreach (var session in _sessions.Values)
            {
                session.Http.Dispose();
            }

            _sessions.Clear();
        }
    }

    private sealed record Session(string Key, DateTimeOffset CreatedAt, LoginHttpSession Http);
}
