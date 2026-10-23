using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Zilux2.Online.Account;

// QQ Music QR login. The web handshake is a chain of steps: ptlogin QR (qrsig) -> ptqrlogin
// ptuiCB -> check_sig 302 (graph cookies) -> oauth2 login_jump -> authorize 302 (OAuth code) ->
// musicu QQConnectLogin (musicid + musickey). The old implementation followed the first 302 and
// expected qm_keyst to appear on its own; it never exchanged the OAuth code for QQ Music
// credentials, which is why every confirmed scan ended in "no qm_keyst/qqmusic_key cookie".
internal sealed class QqLoginProvider : IDisposable
{
    internal const string PtLoginOrigin = "https://xui.ptlogin2.qq.com";
    internal const string LoginJumpUrl = "https://graph.qq.com/oauth2.0/login_jump";
    internal const string AuthorizeEndpoint = "https://graph.qq.com/oauth2.0/authorize";
    internal const string MusicuEndpoint = "https://u.y.qq.com/cgi-bin/musicu.fcg";
    internal const string PtLoginReferer = "https://xui.ptlogin2.qq.com/";
    internal const string GraphReferer = "https://graph.qq.com/";
    internal const string MusicuReferer = "https://y.qq.com/";
    internal const int AppId = 716027609;
    internal const int ClientId = 100497308;
    internal const string Scope = "get_user_info,get_app_friends";
    internal const int QrExpiresSeconds = 120;
    internal const string CheckSigHost = "ssl.ptlogin2.graph.qq.com";
    internal const string CheckSigPath = "/check_sig";
    internal const string GraphLoginJumpHost = "graph.qq.com";
    internal const string GraphLoginJumpPath = "/oauth2.0/login_jump";
    internal const string AuthorizeRedirectHost = "y.qq.com";
    internal const string AuthorizeRedirectPath = "/portal/wx_redirect.html";
    internal const string RedirectUri =
        "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F";
    internal const string CredentialCookieDomain = ".qq.com";

    // The music API only accepts these four cookie names after the OAuth exchange.
    internal static readonly string[] GraphCookieNames = ["p_uin", "p_skey", "pt_oauth_token"];

    private static readonly Regex PtuiCbPattern = new(
        @"^\s*ptuiCB\((.*)\);?\s*$",
        RegexOptions.Compiled | RegexOptions.Singleline | RegexOptions.CultureInvariant);

    private static readonly Regex PtuiCodePattern = new(
        @"^\d{1,9}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex OAuthCodePattern = new(
        "^[A-F0-9]{32}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly TimeSpan SessionLifetime = TimeSpan.FromSeconds(QrExpiresSeconds);

    private readonly AccountStore _store;
    private readonly Dictionary<string, Session> _sessions = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private bool _disposed;

    public QqLoginProvider(AccountStore store) => _store = store;

    public async Task<LoginQrResponse> CreateQrAsync(CancellationToken cancellationToken)
    {
        var session = new LoginHttpSession();
        try
        {
            var response = await session
                .GetBytesAsync(BuildQrShowUrl(Random.Shared.NextDouble()), PtLoginReferer, cancellationToken)
                .ConfigureAwait(false);
            if (response.Status != 200)
            {
                throw new AccountException("upstream-failed", $"QQ 二维码获取失败（HTTP {response.Status}）");
            }

            if (!LooksLikePng(response.Bytes))
            {
                throw new AccountException("upstream-failed", "QQ 二维码响应不是有效图片，请稍后重试");
            }

            var qrsig = ReadQrSig(response, session);
            if (qrsig.Length == 0)
            {
                throw new AccountException("upstream-failed", "QQ 没有返回 qrsig，请稍后重试");
            }

            // Keep the qrsig cookie in the jar for the poll requests even if the header parser had
            // to fall back to the container.
            session.SetCookie("ptlogin2.qq.com", "qrsig", qrsig);

            var sessionKey = RandomHex(16).ToLowerInvariant();
            lock (_gate)
            {
                PruneSessionsLocked();
                _sessions[sessionKey] = new Session(sessionKey, DateTimeOffset.UtcNow, session, qrsig);
            }

            OnlineHttp.Info($"[account] qr source=qq keyLen={sessionKey.Length} expiresIn={QrExpiresSeconds}");
            return new LoginQrResponse
            {
                Source = AccountSources.Qq,
                Mode = "image",
                Key = sessionKey,
                ImageDataUrl = "data:image/png;base64," + Convert.ToBase64String(response.Bytes),
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
            response = await session.Http
                .GetAsync(BuildPollUrl(session.QrSig), PtLoginReferer, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // Polling runs every ~2 s: a single network blip must not kill the QR session.
            OnlineHttp.Warn($"GET qq/login/status failed: {OnlineHttp.Describe(exception)}");
            return Waiting("网络波动，正在重试");
        }

        if (response.Status != 200)
        {
            OnlineHttp.Warn($"GET qq/login/status HTTP {response.Status}");
            return Waiting("网络波动，正在重试");
        }

        if (!TryParsePtuiCb(response.Body, out var code, out _, out var redirectUrl, out _))
        {
            OnlineHttp.Warn($"GET qq/login/status unparsable: {Truncate(response.Body, 120)}");
            return Waiting("等待手机扫码");
        }

        switch (code)
        {
            case "0":
                return await CompleteAsync(session, key, redirectUrl, cancellationToken).ConfigureAwait(false);
            case "65":
                RemoveSession(key);
                return Expired("二维码已过期，请重新获取");
            case "66":
                return Waiting("等待手机扫码");
            case "67":
                return new LoginStatusResponse { State = "scanned", Message = "已扫码，请在手机上确认" };
            default:
                OnlineHttp.Warn($"[account] qq login unknown code={code}");
                RemoveSession(key);
                return Failed($"QQ 登录返回未知状态（{code}），请重新获取二维码");
        }
    }

    private async Task<LoginStatusResponse> CompleteAsync(
        Session session,
        string key,
        string checkSigUrl,
        CancellationToken cancellationToken)
    {
        if (!IsValidCheckSigUrl(checkSigUrl))
        {
            RemoveSession(key);
            OnlineHttp.Warn("[account] qq login failed: check_sig url rejected");
            return Failed("QQ 登录跳转异常（平台接口调整），请重试或改用 Cookie 导入");
        }

        try
        {
            // 1. check_sig answers 302 into graph.qq.com's login_jump and sets the graph cookies.
            var checkSig = await session.Http
                .GetNoRedirectAsync(checkSigUrl, GraphReferer, cancellationToken)
                .ConfigureAwait(false);
            OnlineHttp.Info($"[account] qq login phase=check_sig status={checkSig.Status}");
            if (checkSig.Status != 302 || !TryValidateGraphLoginJump(checkSig.Location))
            {
                RemoveSession(key);
                OnlineHttp.Warn("[account] qq login failed: check_sig did not redirect to graph login_jump");
                return Failed("QQ 登录未完成（check_sig 未跳转，可能被风控），请重试或改用 Cookie 导入");
            }

            var graphCookies = ReadGraphCookies(checkSig, session.Http);
            if (GraphCookieNames.Any(name => !graphCookies.TryGetValue(name, out var value) || value.Length == 0))
            {
                RemoveSession(key);
                OnlineHttp.Warn($"[account] qq login failed: graph cookies missing count={GraphCookieNames.Length}");
                return Failed("QQ 登录未完成（缺少 OAuth 凭据），请重试或改用 Cookie 导入");
            }

            // 2. login_jump is a plain 200 page that primes the graph session.
            var loginJump = await session.Http
                .GetNoRedirectAsync(LoginJumpUrl, GraphReferer, cancellationToken)
                .ConfigureAwait(false);
            OnlineHttp.Info($"[account] qq login phase=login_jump status={loginJump.Status}");
            if (loginJump.Status is < 200 or >= 400)
            {
                RemoveSession(key);
                return Failed("QQ 登录未完成（login_jump 异常），请重试或改用 Cookie 导入");
            }

            // 3. authorize turns the graph cookies into a one-shot OAuth code on y.qq.com.
            var state = RandomHex(16).ToLowerInvariant();
            var authorizeForm = BuildAuthorizeForm(
                graphCookies["p_skey"],
                state,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                Guid.NewGuid().ToString());
            var authorize = await session.Http
                .PostFormNoRedirectAsync(AuthorizeEndpoint, authorizeForm, GraphReferer, cancellationToken)
                .ConfigureAwait(false);
            OnlineHttp.Info($"[account] qq login phase=authorize status={authorize.Status}");
            var redirectError = $"HTTP {authorize.Status}";
            var oauthCode = string.Empty;
            var authorizeOk = authorize.Status == 302 &&
                              TryValidateAuthorizeRedirect(authorize.Location, state, out oauthCode, out redirectError);
            if (!authorizeOk)
            {
                RemoveSession(key);
                OnlineHttp.Warn($"[account] qq login failed: authorize redirect rejected ({redirectError})");
                return Failed("QQ 登录授权失败（平台风控或接口调整），请稍后重试或改用 Cookie 导入");
            }

            // 4. musicu exchanges the OAuth code for the music credentials (loginType 2 = PC).
            var musicu = await session.Http
                .PostJsonAsync(MusicuEndpoint, BuildMusicuLoginBody(oauthCode), MusicuReferer, cancellationToken)
                .ConfigureAwait(false);
            string musicId = string.Empty;
            string musicKey = string.Empty;
            var credentialOk = false;
            var credentialError = $"HTTP {musicu.Status}";
            if (musicu.Status == 200)
            {
                try
                {
                    using var document = JsonDocument.Parse(musicu.Body);
                    credentialOk = TryReadCredential(document.RootElement, out musicId, out musicKey, out credentialError);
                }
                catch (JsonException)
                {
                    credentialError = "响应不是 JSON";
                }
            }

            if (!credentialOk)
            {
                RemoveSession(key);
                OnlineHttp.Warn($"[account] qq login failed: musicu credential unavailable ({credentialError})");
                return Failed($"QQ 音乐登录失败（{credentialError}），请稍后重试或改用 Cookie 导入");
            }

            var credentialCookies = BuildCredentialCookies(musicId, musicKey);
            foreach (var cookie in credentialCookies)
            {
                session.Http.SetCookie(cookie.Domain, cookie.Name, cookie.Value);
            }

            var account = await FetchAccountAsync(session.Http, musicId, cancellationToken).ConfigureAwait(false);
            try
            {
                _store.SaveLogin(AccountSources.Qq, account, credentialCookies);
            }
            catch (AccountException exception)
            {
                RemoveSession(key);
                return Failed(exception.Message);
            }

            RemoveSession(key);
            OnlineHttp.Info($"[account] login source=qq userId={musicId} keyLen={musicKey.Length}");
            return new LoginStatusResponse { State = "authorized", Message = "登录成功", Account = account };
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            RemoveSession(key);
            OnlineHttp.Warn($"POST qq/login failed: {OnlineHttp.Describe(exception)}");
            return Failed("QQ 登录网络异常，请重试或改用 Cookie 导入");
        }
    }

    private async Task<AccountInfo> FetchAccountAsync(
        LoginHttpSession session,
        string musicId,
        CancellationToken cancellationToken)
    {
        string? nickname = null;
        string? avatarDataUrl = null;
        bool? vip = null;
        var userId = musicId.Length > 0 ? musicId : null;

        try
        {
            var body = "{\"comm\":{\"ct\":24,\"cv\":0,\"uin\":\"" + (userId ?? "0") + "\"}," +
                       "\"req_1\":{\"module\":\"music.UserInfo.userInfoServer\",\"method\":\"GetLoginUserInfo\",\"param\":{}}}";
            var response = await session
                .PostJsonAsync(MusicuEndpoint, body, MusicuReferer, cancellationToken)
                .ConfigureAwait(false);
            if (response.Status == 200)
            {
                using var document = JsonDocument.Parse(response.Body);
                if (TryGetUserInfoData(document.RootElement, out var data))
                {
                    nickname = FindString(data, ["nick", "nickname", "name"], 4);
                    var avatarUrl = FindString(data, ["avatarUrl", "avatar", "headUrl", "head_pic"], 4);
                    avatarDataUrl = await AvatarEncoding.ToDataUrlAsync(session, avatarUrl, cancellationToken)
                        .ConfigureAwait(false);
                    vip = FindBool(data, ["isVip", "is_vip"], 4) ??
                          FindPositiveInt(data, ["vipType", "greenVip", "vip_type"], 4);
                    vip ??= await FetchVipAsync(session, userId ?? string.Empty, cancellationToken).ConfigureAwait(false);
                }
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // Credentials are already valid at this point; profile details are best effort.
            OnlineHttp.Warn($"GET qq/account/userinfo failed: {OnlineHttp.Describe(exception)}");
        }

        if (avatarDataUrl is null && userId is not null)
        {
            var qlogo = $"https://thirdqq.qlogo.cn/g?b=sdk&s=100&nk={Uri.EscapeDataString(userId)}";
            avatarDataUrl = await AvatarEncoding.ToDataUrlAsync(session, qlogo, cancellationToken).ConfigureAwait(false);
        }

        OnlineHttp.Info($"[account] profile source=qq userId={userId ?? "-"} vip={vip?.ToString() ?? "unknown"}");
        return new AccountInfo
        {
            Source = AccountSources.Qq,
            LoggedIn = true,
            Nickname = string.IsNullOrWhiteSpace(nickname) ? null : nickname,
            AvatarDataUrl = avatarDataUrl,
            Vip = vip,
            UserId = userId,
        };
    }

    // Rebuilds a session from persisted cookies and refreshes nickname / avatar / vip on startup.
    public async Task<AccountInfo?> RefreshAsync(
        IReadOnlyList<StoredCookie> cookies,
        CancellationToken cancellationToken)
    {
        using var session = new LoginHttpSession();
        foreach (var cookie in cookies)
        {
            if (!string.IsNullOrEmpty(cookie.Value))
            {
                session.SetCookie(cookie.Domain, cookie.Name, cookie.Value);
            }
        }

        var userId = FindCookie(cookies, "qqmusic_uin") ??
                     FindCookie(cookies, "uin") ??
                     FindCookie(cookies, "p_uin") ??
                     string.Empty;
        var musicKey = FindCookie(cookies, "qm_keyst") ?? FindCookie(cookies, "qqmusic_key");
        if (musicKey is null)
        {
            return null;
        }

        try
        {
            return await FetchAccountAsync(session, userId, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"[account] qq profile refresh failed: {OnlineHttp.Describe(exception)}");
            return null;
        }
    }

    private static string? FindCookie(IReadOnlyList<StoredCookie> cookies, string name)
    {
        foreach (var cookie in cookies)
        {
            if (string.Equals(cookie.Name, name, StringComparison.OrdinalIgnoreCase) &&
                cookie.Value.Length > 0)
            {
                return cookie.Value.TrimStart('o', '0');
            }
        }

        return null;
    }

    // Membership query (module userInfo.VipQueryServer / SRFVipQuery_V2): the payload is
    // req.data.infoMap[uin] with iVipFlag (1 = green diamond) and HugeVip (1 = super vip).
    private static async Task<bool?> FetchVipAsync(
        LoginHttpSession session,
        string musicId,
        CancellationToken cancellationToken)
    {
        var body = "{\"comm\":{\"ct\":24,\"cv\":0,\"uin\":\"" + musicId + "\"}," +
                   "\"req\":{\"module\":\"userInfo.VipQueryServer\",\"method\":\"SRFVipQuery_V2\"," +
                   "\"param\":{\"uin_list\":[\"" + musicId + "\"]}}}";
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(9));
            var response = await session
                .PostJsonAsync(MusicuEndpoint, body, MusicuReferer, timeout.Token)
                .ConfigureAwait(false);
            if (response.Status != 200)
            {
                OnlineHttp.Warn($"[account] qq vip HTTP {response.Status}");
                return null;
            }

            using var document = JsonDocument.Parse(response.Body);
            if (TryReadQqVip(document.RootElement, out var vip, out var level))
            {
                OnlineHttp.Info($"[account] qq vip level={level} vip={vip}");
                return vip;
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"[account] qq vip query failed: {OnlineHttp.Describe(exception)}");
        }

        return null;
    }

    private static bool TryReadQqVip(JsonElement root, out bool vip, out string level)
    {
        var iVipFlag = -1;
        var hugeVip = -1;
        Walk(root, 0);
        if (iVipFlag < 0 && hugeVip < 0)
        {
            vip = false;
            level = "unknown";
            return false;
        }

        vip = iVipFlag == 1 || hugeVip == 1;
        level = hugeVip == 1 ? "super" : iVipFlag == 1 ? "green" : iVipFlag == 0 ? "free" : "unknown";
        return true;

        void Walk(JsonElement element, int depth)
        {
            if (depth > 6)
            {
                return;
            }

            switch (element.ValueKind)
            {
                case JsonValueKind.Object:
                    foreach (var property in element.EnumerateObject())
                    {
                        switch (property.Name)
                        {
                            case "iVipFlag" when property.Value.ValueKind == JsonValueKind.Number:
                                if (property.Value.TryGetInt32(out var flag))
                                {
                                    iVipFlag = flag;
                                }

                                break;
                            case "HugeVip" when property.Value.ValueKind == JsonValueKind.Number:
                                if (property.Value.TryGetInt32(out var huge))
                                {
                                    hugeVip = huge;
                                }

                                break;
                        }

                        Walk(property.Value, depth + 1);
                    }

                    break;
                case JsonValueKind.Array:
                    foreach (var item in element.EnumerateArray())
                    {
                        Walk(item, depth + 1);
                    }

                    break;
            }
        }
    }

    // ---- deterministic pieces, also exercised by tools/account-selftest.ps1 (ZILUX2_ACCOUNT_SELFTEST) ----

    internal static string BuildQrShowUrl(double nonce) =>
        PtLoginOrigin + "/ssl/ptqrshow?appid=" + AppId.ToString(CultureInfo.InvariantCulture) +
        "&e=2&l=M&s=3&d=72&v=4&t=" + nonce.ToString("R", CultureInfo.InvariantCulture) +
        "&daid=383&pt_3rd_aid=" + ClientId.ToString(CultureInfo.InvariantCulture) +
        "&u1=" + Uri.EscapeDataString(LoginJumpUrl);

    internal static string BuildPollUrl(string qrsig) =>
        PtLoginOrigin + "/ssl/ptqrlogin?u1=" + Uri.EscapeDataString(LoginJumpUrl) +
        "&from_ui=1&aid=" + AppId.ToString(CultureInfo.InvariantCulture) +
        "&daid=383&pt_3rd_aid=" + ClientId.ToString(CultureInfo.InvariantCulture) +
        "&ptqrtoken=" + Hash33(qrsig, 0).ToString(CultureInfo.InvariantCulture);

    // hash33 from the QQ web login script: the server verifies ptqrtoken/g_tk against it.
    internal static int Hash33(string value, int initial)
    {
        var hash = initial;
        unchecked
        {
            foreach (var character in value)
            {
                hash = ((hash << 5) + hash + character) & 0x7FFFFFFF;
            }
        }

        return hash;
    }

    internal static bool TryParsePtuiCb(
        string body,
        out string code,
        out string message,
        out string url,
        out string nickname)
    {
        code = message = url = nickname = string.Empty;
        var match = PtuiCbPattern.Match(body ?? string.Empty);
        if (!match.Success)
        {
            return false;
        }

        var arguments = ParseQuotedArguments(match.Groups[1].Value);
        if (arguments is null || arguments.Count < 5 || !PtuiCodePattern.IsMatch(arguments[0]))
        {
            return false;
        }

        code = arguments[0];
        url = arguments[2];
        message = arguments[4];
        nickname = arguments.Count > 5 ? arguments[5] : string.Empty;
        return true;
    }

    internal static bool IsValidCheckSigUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            return false;
        }

        return uri.Scheme == Uri.UriSchemeHttps &&
               uri.IsDefaultPort &&
               string.Equals(uri.Host, CheckSigHost, StringComparison.OrdinalIgnoreCase) &&
               string.Equals(uri.AbsolutePath, CheckSigPath, StringComparison.Ordinal) &&
               string.IsNullOrEmpty(uri.UserInfo) &&
               uri.Fragment.Length == 0;
    }

    internal static bool TryValidateGraphLoginJump(string? location)
    {
        if (!Uri.TryCreate(location, UriKind.Absolute, out var uri))
        {
            return false;
        }

        return uri.Scheme == Uri.UriSchemeHttps &&
               uri.IsDefaultPort &&
               string.Equals(uri.Host, GraphLoginJumpHost, StringComparison.OrdinalIgnoreCase) &&
               string.Equals(uri.AbsolutePath, GraphLoginJumpPath, StringComparison.Ordinal) &&
               string.IsNullOrEmpty(uri.UserInfo) &&
               uri.Fragment.Length == 0;
    }

    internal static bool TryValidateAuthorizeRedirect(
        string? location,
        string expectedState,
        out string code,
        out string error)
    {
        code = string.Empty;
        error = string.Empty;
        if (!Uri.TryCreate(location, UriKind.Absolute, out var uri))
        {
            error = "回调地址无法解析";
            return false;
        }

        if (uri.Scheme != Uri.UriSchemeHttps ||
            !uri.IsDefaultPort ||
            !string.Equals(uri.Host, AuthorizeRedirectHost, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(uri.AbsolutePath, AuthorizeRedirectPath, StringComparison.Ordinal))
        {
            error = "回调地址不匹配";
            return false;
        }

        var query = ParseQuery(uri.Query);
        var codes = query.TryGetValue("code", out var codeValues) ? codeValues : [];
        var states = query.TryGetValue("state", out var stateValues) ? stateValues : [];
        if (codes.Count != 1 || !OAuthCodePattern.IsMatch(codes[0]))
        {
            error = "code 参数异常";
            return false;
        }

        if (states.Count != 1 || !string.Equals(states[0], expectedState, StringComparison.Ordinal))
        {
            error = "state 校验失败";
            return false;
        }

        code = codes[0];
        return true;
    }

    internal static string BuildAuthorizeForm(string pSkey, string state, long authTimeMs, string ui)
    {
        var builder = new StringBuilder();
        void Append(string name, string value)
        {
            if (builder.Length > 0)
            {
                builder.Append('&');
            }

            builder.Append(name).Append('=').Append(Uri.EscapeDataString(value));
        }

        Append("response_type", "code");
        Append("client_id", ClientId.ToString(CultureInfo.InvariantCulture));
        Append("redirect_uri", RedirectUri);
        Append("scope", Scope);
        Append("state", state);
        Append("switch", string.Empty);
        Append("from_ptlogin", "1");
        Append("src", "1");
        Append("update_auth", "1");
        Append("openapi", "1010_1030");
        Append("g_tk", Hash33(pSkey, 5381).ToString(CultureInfo.InvariantCulture));
        Append("auth_time", authTimeMs.ToString(CultureInfo.InvariantCulture));
        Append("ui", ui);
        return builder.ToString();
    }

    internal static string BuildMusicuLoginBody(string code) =>
        "{\"comm\":{\"g_tk\":5381,\"platform\":\"yqq\",\"ct\":24,\"cv\":0}," +
        "\"req\":{\"module\":\"QQConnectLogin.LoginServer\",\"method\":\"QQLogin\"," +
        "\"param\":{\"code\":\"" + code + "\"}}}";

    internal static bool TryReadCredential(
        JsonElement root,
        out string musicId,
        out string musicKey,
        out string error)
    {
        musicId = string.Empty;
        musicKey = string.Empty;
        error = string.Empty;
        var globalCode = ReadInt(root, "code");
        if (globalCode != 0)
        {
            error = $"code={globalCode}";
            return false;
        }

        if (!root.TryGetProperty("req", out var request) || request.ValueKind != JsonValueKind.Object)
        {
            error = "响应缺少 req";
            return false;
        }

        var requestCode = ReadInt(request, "code");
        if (requestCode != 0)
        {
            error = $"code={globalCode}/{requestCode}";
            return false;
        }

        if (!request.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
        {
            error = "响应缺少 data";
            return false;
        }

        var loginType = ReadInt(data, "loginType");
        if (loginType != 2)
        {
            error = $"loginType={loginType}";
            return false;
        }

        musicId = ReadText(data, "musicid");
        if (musicId.Length == 0 || !musicId.All(char.IsAsciiDigit) || musicId.All(character => character == '0'))
        {
            error = "musicid 缺失";
            return false;
        }

        musicKey = ReadText(data, "musickey");
        if (musicKey.Length == 0)
        {
            error = "musickey 缺失";
            return false;
        }

        return true;
    }

    internal static List<StoredCookie> BuildCredentialCookies(string musicId, string musicKey) =>
    [
        new StoredCookie(CredentialCookieDomain, "uin", musicId),
        new StoredCookie(CredentialCookieDomain, "qqmusic_uin", musicId),
        new StoredCookie(CredentialCookieDomain, "qm_keyst", musicKey),
        new StoredCookie(CredentialCookieDomain, "qqmusic_key", musicKey),
    ];

    private static string ReadQrSig(LoginHttpResponse response, LoginHttpSession session)
    {
        var values = SetCookieParser.ToDictionary(response.SetCookies, out var domains);
        if (values.TryGetValue("qrsig", out var value) &&
            value.Length > 0 &&
            domains.TryGetValue("qrsig", out var domain) &&
            domain.EndsWith("ptlogin2.qq.com", StringComparison.OrdinalIgnoreCase))
        {
            return value;
        }

        return session.GetCookieValue("qrsig") ?? string.Empty;
    }

    private static Dictionary<string, string> ReadGraphCookies(LoginHttpResponse response, LoginHttpSession session)
    {
        var values = SetCookieParser.ToDictionary(response.SetCookies, out var domains);
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in GraphCookieNames)
        {
            if (values.TryGetValue(name, out var value) && value.Length > 0)
            {
                // Reference only trusts graph.qq.com-scoped cookies; anything else means the hop was
                // hijacked or the platform changed its domain.
                if (domains.TryGetValue(name, out var domain) &&
                    !domain.EndsWith("graph.qq.com", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                session.SetCookie("graph.qq.com", name, value);
                result[name] = value;
            }
            else if (session.GetCookieValue(name) is { Length: > 0 } fromJar)
            {
                result[name] = fromJar;
            }
        }

        return result;
    }

    private static List<string>? ParseQuotedArguments(string inner)
    {
        var arguments = new List<string>();
        var index = 0;
        while (index < inner.Length)
        {
            while (index < inner.Length && (char.IsWhiteSpace(inner[index]) || inner[index] == ','))
            {
                index++;
            }

            if (index >= inner.Length)
            {
                break;
            }

            var quote = inner[index];
            if (quote is not ('\'' or '"'))
            {
                return null;
            }

            index++;
            var builder = new StringBuilder();
            var closed = false;
            while (index < inner.Length)
            {
                var character = inner[index];
                if (character == '\\')
                {
                    if (index + 1 >= inner.Length)
                    {
                        return null;
                    }

                    var next = inner[index + 1];
                    if (next == 'x' && index + 3 < inner.Length &&
                        TryParseHex(inner.AsSpan(index + 2, 2), out var escapeByte))
                    {
                        builder.Append((char)escapeByte);
                        index += 4;
                        continue;
                    }

                    if (next == 'u' && index + 5 < inner.Length &&
                        TryParseHex(inner.AsSpan(index + 2, 4), out var escapeUnicode))
                    {
                        builder.Append((char)escapeUnicode);
                        index += 6;
                        continue;
                    }

                    builder.Append(next switch
                    {
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        '0' => '\0',
                        _ => next,
                    });
                    index += 2;
                    continue;
                }

                if (character == quote)
                {
                    index++;
                    closed = true;
                    break;
                }

                builder.Append(character);
                index++;
            }

            if (!closed)
            {
                return null;
            }

            arguments.Add(builder.ToString());
            while (index < inner.Length && char.IsWhiteSpace(inner[index]))
            {
                index++;
            }

            if (index < inner.Length && inner[index] != ',')
            {
                return null;
            }
        }

        return arguments;
    }

    private static bool TryParseHex(ReadOnlySpan<char> text, out int value)
    {
        value = 0;
        foreach (var character in text)
        {
            var digit = character switch
            {
                >= '0' and <= '9' => character - '0',
                >= 'a' and <= 'f' => character - 'a' + 10,
                >= 'A' and <= 'F' => character - 'A' + 10,
                _ => -1,
            };
            if (digit < 0)
            {
                return false;
            }

            value = (value << 4) | digit;
        }

        return true;
    }

    private static Dictionary<string, List<string>> ParseQuery(string query)
    {
        var result = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var part in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = part.IndexOf('=');
            var rawName = separator < 0 ? part : part[..separator];
            var rawValue = separator < 0 ? string.Empty : part[(separator + 1)..];
            var name = Uri.UnescapeDataString(rawName);
            if (!result.TryGetValue(name, out var values))
            {
                values = [];
                result[name] = values;
            }

            values.Add(Uri.UnescapeDataString(rawValue));
        }

        return result;
    }

    private static int ReadInt(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value))
        {
            return -1;
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number))
        {
            return number;
        }

        return value.ValueKind == JsonValueKind.String &&
               int.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out number)
            ? number
            : -1;
    }

    private static string ReadText(JsonElement element, string name)
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

    private static bool LooksLikePng(byte[] bytes)
    {
        if (bytes.Length < 32 || bytes.Length > 65536)
        {
            return false;
        }

        ReadOnlySpan<byte> signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        if (!bytes.AsSpan(0, 8).SequenceEqual(signature))
        {
            return false;
        }

        // IHDR starts at offset 16 (length 4 + type 4 + signature 8); checking the dimensions
        // rejects an HTML error page that happens to start with the PNG magic.
        var width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
        var height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
        return width is > 0 and <= 2048 && height is > 0 and <= 2048;
    }

    private static string RandomHex(int byteCount)
    {
        var hex = Convert.ToHexString(RandomNumberGenerator.GetBytes(byteCount));
        return hex.ToLowerInvariant();
    }

    private static bool TryGetUserInfoData(JsonElement root, out JsonElement data)
    {
        foreach (var requestName in new[] { "req_1", "req" })
        {
            if (!root.TryGetProperty(requestName, out var request) || request.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var code = request.TryGetProperty("code", out var codeElement) && codeElement.TryGetInt32(out var parsedCode)
                ? parsedCode
                : 0;
            if (code == 0 &&
                request.TryGetProperty("data", out var payload) &&
                payload.ValueKind == JsonValueKind.Object)
            {
                data = payload;
                return true;
            }
        }

        data = default;
        return false;
    }

    private static string FindString(JsonElement element, string[] names, int depth)
    {
        if (depth <= 0)
        {
            return string.Empty;
        }

        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var name in names)
            {
                if (element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
                {
                    var text = value.GetString();
                    if (!string.IsNullOrWhiteSpace(text))
                    {
                        return text;
                    }
                }
            }

            foreach (var property in element.EnumerateObject())
            {
                var found = FindString(property.Value, names, depth - 1);
                if (found.Length > 0)
                {
                    return found;
                }
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
            {
                var found = FindString(item, names, depth - 1);
                if (found.Length > 0)
                {
                    return found;
                }
            }
        }

        return string.Empty;
    }

    private static bool? FindBool(JsonElement element, string[] names, int depth)
    {
        if (depth <= 0)
        {
            return null;
        }

        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var name in names)
            {
                if (element.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False)
                {
                    return value.GetBoolean();
                }
            }

            foreach (var property in element.EnumerateObject())
            {
                var found = FindBool(property.Value, names, depth - 1);
                if (found is not null)
                {
                    return found;
                }
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
            {
                var found = FindBool(item, names, depth - 1);
                if (found is not null)
                {
                    return found;
                }
            }
        }

        return null;
    }

    private static bool? FindPositiveInt(JsonElement element, string[] names, int depth)
    {
        if (depth <= 0)
        {
            return null;
        }

        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var name in names)
            {
                if (element.TryGetProperty(name, out var value) && value.TryGetInt32(out var number))
                {
                    return number > 0;
                }
            }

            foreach (var property in element.EnumerateObject())
            {
                var found = FindPositiveInt(property.Value, names, depth - 1);
                if (found is not null)
                {
                    return found;
                }
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
            {
                var found = FindPositiveInt(item, names, depth - 1);
                if (found is not null)
                {
                    return found;
                }
            }
        }

        return null;
    }

    private static string Truncate(string value, int length) =>
        value.Length <= length ? value : value[..length] + "…";

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

    private static LoginStatusResponse Expired(string message) =>
        new() { State = "expired", Message = message };

    private static LoginStatusResponse Failed(string message) =>
        new() { State = "error", Message = message };

    private static LoginStatusResponse Waiting(string message) =>
        new() { State = "waiting", Message = message };

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

    private sealed record Session(string Key, DateTimeOffset CreatedAt, LoginHttpSession Http, string QrSig);
}
