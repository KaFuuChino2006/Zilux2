using System.Text.Json;

namespace Zilux2.Online.Account;

// Offline checks for the QR-login plumbing. They run inside the host process before any window
// or content is created (ZILUX2_ACCOUNT_SELFTEST=1), so tools/account-selftest.ps1 can verify the
// URL builders / parsers / status mapping without a real account or a fake upstream server.
internal static class AccountSelfCheck
{
    internal const string EnvironmentVariable = "ZILUX2_ACCOUNT_SELFTEST";

    public static bool IsRequested =>
        string.Equals(Environment.GetEnvironmentVariable(EnvironmentVariable), "1", StringComparison.Ordinal);

    public static int Run()
    {
        var passed = 0;
        var failed = 0;

        void Check(string name, bool condition)
        {
            if (condition)
            {
                passed++;
                HostLog.Info($"[account-selftest] PASS {name}");
            }
            else
            {
                failed++;
                HostLog.Error($"[account-selftest] FAIL {name}");
            }
        }

        // ---- QQ: deterministic handshake pieces ----
        Check("qq hash33 empty", QqLoginProvider.Hash33(string.Empty, 0) == 0);
        Check("qq hash33 abc initial 0", QqLoginProvider.Hash33("abc", 0) == 108966);
        Check("qq hash33 abc initial 5381", QqLoginProvider.Hash33("abc", 5381) == 193485963);

        var qrShowUrl = QqLoginProvider.BuildQrShowUrl(0.5);
        Check("qq qr show url appid", qrShowUrl.Contains("appid=716027609", StringComparison.Ordinal));
        Check("qq qr show url third party id", qrShowUrl.Contains("pt_3rd_aid=100497308", StringComparison.Ordinal));
        Check(
            "qq qr show url login jump encoded",
            qrShowUrl.Contains("u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump", StringComparison.Ordinal));
        Check("qq qr show url nonce", qrShowUrl.Contains("t=0.5", StringComparison.Ordinal));

        var pollUrl = QqLoginProvider.BuildPollUrl("sig1");
        Check(
            "qq poll url ptqrtoken",
            pollUrl.EndsWith(
                "ptqrtoken=" + QqLoginProvider.Hash33("sig1", 0).ToString(System.Globalization.CultureInfo.InvariantCulture),
                StringComparison.Ordinal));
        Check("qq poll url aid", pollUrl.Contains("aid=716027609", StringComparison.Ordinal));

        const string checkSig =
            "https://ssl.ptlogin2.graph.qq.com/check_sig?pttype=1&uin=123&service=ptqrlogin&nodirect=0&ptsigx=x";
        var waitingCb = QqLoginProvider.TryParsePtuiCb(
            "ptuiCB('66','0','','0','二维码未失效。', '')",
            out var waitingCode,
            out var waitingMessage,
            out _,
            out _);
        Check(
            "qq ptuiCB waiting",
            waitingCb &&
            waitingCode == "66" &&
            waitingMessage.Contains("二维码", StringComparison.Ordinal));

        var confirmedCb = QqLoginProvider.TryParsePtuiCb(
            $"ptuiCB('0','0','{checkSig}','0','登录成功！', '昵称')",
            out var confirmedCode,
            out _,
            out var confirmedUrl,
            out var confirmedNickname);
        Check(
            "qq ptuiCB confirmed",
            confirmedCb && confirmedCode == "0" && confirmedUrl == checkSig && confirmedNickname == "昵称");
        Check("qq check_sig url valid", QqLoginProvider.IsValidCheckSigUrl(checkSig));
        Check("qq check_sig url rejects http", !QqLoginProvider.IsValidCheckSigUrl(checkSig.Replace("https://", "http://", StringComparison.Ordinal)));
        Check("qq check_sig url rejects other host", !QqLoginProvider.IsValidCheckSigUrl("https://evil.example.com/check_sig"));
        Check("qq check_sig url rejects other path", !QqLoginProvider.IsValidCheckSigUrl("https://ssl.ptlogin2.graph.qq.com/other"));

        var escapedCb = QqLoginProvider.TryParsePtuiCb(
            "ptuiCB('65','0','','0','二维码已失效','a\\x21')",
            out var escapedCode,
            out _,
            out _,
            out var escapedNickname);
        Check("qq ptuiCB escape", escapedCb && escapedCode == "65" && escapedNickname == "a!");
        Check("qq ptuiCB garbage", !QqLoginProvider.TryParsePtuiCb("not a callback", out _, out _, out _, out _));
        Check(
            "qq authorize redirect graph login jump",
            QqLoginProvider.TryValidateGraphLoginJump("https://graph.qq.com/oauth2.0/login_jump?x=1"));
        Check(
            "qq login jump rejects wrong host",
            !QqLoginProvider.TryValidateGraphLoginJump("https://evil.example.com/oauth2.0/login_jump"));

        var code32 = "0123456789ABCDEF0123456789ABCDEF";
        var state = "abcdef0123456789abcdef0123456789";
        var redirectOk = QqLoginProvider.TryValidateAuthorizeRedirect(
            $"https://y.qq.com/portal/wx_redirect.html?login_type=1&code={code32}&state={state}",
            state,
            out var oauthCode,
            out var redirectError);
        Check("qq authorize redirect code", redirectOk && oauthCode == code32 && redirectError.Length == 0);
        Check(
            "qq authorize redirect state mismatch",
            !QqLoginProvider.TryValidateAuthorizeRedirect(
                $"https://y.qq.com/portal/wx_redirect.html?code={code32}&state=deadbeef",
                state,
                out _,
                out _));
        Check(
            "qq authorize redirect lowercase code",
            !QqLoginProvider.TryValidateAuthorizeRedirect(
                $"https://y.qq.com/portal/wx_redirect.html?code={code32.ToLowerInvariant()}&state={state}",
                state,
                out _,
                out _));

        var authorizeForm = QqLoginProvider.BuildAuthorizeForm("p_skey_value", state, 1700000000000, "ui-value");
        Check("qq authorize form response type", authorizeForm.Contains("response_type=code", StringComparison.Ordinal));
        Check("qq authorize form client id", authorizeForm.Contains("client_id=100497308", StringComparison.Ordinal));
        Check(
            "qq authorize form g_tk",
            authorizeForm.Contains(
                "g_tk=" + QqLoginProvider.Hash33("p_skey_value", 5381).ToString(System.Globalization.CultureInfo.InvariantCulture),
                StringComparison.Ordinal));
        Check("qq authorize form state", authorizeForm.Contains("state=" + state, StringComparison.Ordinal));
        Check("qq authorize form redirect uri", authorizeForm.Contains("redirect_uri=https%3A%2F%2Fy.qq.com%2Fportal%2Fwx_redirect.html", StringComparison.Ordinal));

        var musicuBody = QqLoginProvider.BuildMusicuLoginBody(code32);
        Check("qq musicu module", musicuBody.Contains("QQConnectLogin.LoginServer", StringComparison.Ordinal));
        Check("qq musicu method", musicuBody.Contains("\"method\":\"QQLogin\"", StringComparison.Ordinal));
        Check("qq musicu code", musicuBody.Contains("\"code\":\"" + code32 + "\"", StringComparison.Ordinal));

        Check(
            "qq credential parse ok",
            ReadCredential(
                "{\"code\":0,\"req\":{\"code\":0,\"data\":{\"loginType\":2,\"musicid\":\"1234567890\",\"musickey\":\"KEY\"}}}")
            is { Ok: true, MusicId: "1234567890", MusicKey: "KEY" });
        Check(
            "qq credential rejects loginType",
            !ReadCredential(
                "{\"code\":0,\"req\":{\"code\":0,\"data\":{\"loginType\":1,\"musicid\":\"1\",\"musickey\":\"KEY\"}}}").Ok);
        Check(
            "qq credential rejects global code",
            !ReadCredential("{\"code\":1000,\"req\":{\"code\":0,\"data\":{}}}").Ok);
        Check(
            "qq credential rejects missing musicid",
            !ReadCredential("{\"code\":0,\"req\":{\"code\":0,\"data\":{\"loginType\":2,\"musickey\":\"KEY\"}}}").Ok);

        var credentialCookies = QqLoginProvider.BuildCredentialCookies("1234567890", "KEY");
        Check(
            "qq credential cookies",
            credentialCookies.Count == 4 &&
            credentialCookies.All(cookie => cookie.Domain == ".qq.com") &&
            credentialCookies.Any(cookie => cookie.Name == "qm_keyst" && cookie.Value == "KEY") &&
            credentialCookies.Any(cookie => cookie.Name == "qqmusic_key" && cookie.Value == "KEY") &&
            credentialCookies.Any(cookie => cookie.Name == "qqmusic_uin" && cookie.Value == "1234567890") &&
            credentialCookies.Any(cookie => cookie.Name == "uin" && cookie.Value == "1234567890"));

        // ---- Netease: identity cookies, type=3 forms, status mapping ----
        Check(
            "netease desktop user agent",
            NeteaseLoginProvider.DesktopUserAgent.Contains("NeteaseMusicDesktop/3.1.29.205117", StringComparison.Ordinal));
        Check("netease unikey form type 3", NeteaseLoginProvider.BuildUniKeyForm(3) == "type=3");
        Check("netease unikey form type 1", NeteaseLoginProvider.BuildUniKeyForm(1) == "type=1");
        Check("netease poll form type 3", NeteaseLoginProvider.BuildPollForm("abc", 3) == "key=abc&type=3");
        Check("netease poll form escape", NeteaseLoginProvider.BuildPollForm("a b", 1) == "key=a%20b&type=1");

        var identity = NeteaseLoginProvider.BuildIdentityCookies(
            "0123456789abcdef0123456789abcdef",
            "fedcba9876543210fedcba9876543210",
            "fedcba9876543210fedcba9876543210,1700000000000",
            "abcdef.1700000000000.01.0",
            "20261018");
        Check(
            "netease identity os/appver/channel",
            identity.Any(cookie => cookie.Name == "os" && cookie.Value == "pc") &&
            identity.Any(cookie => cookie.Name == "appver") &&
            identity.Any(cookie => cookie.Name == "channel" && cookie.Value == "netease"));
        Check(
            "netease identity device cookies",
            identity.Any(cookie => cookie.Name == "deviceId") &&
            identity.Any(cookie => cookie.Name == "_ntes_nuid") &&
            identity.Any(cookie => cookie.Name == "_ntes_nnid" && cookie.Value.Contains(',', StringComparison.Ordinal)) &&
            identity.Any(cookie => cookie.Name == "buildver" && cookie.Value == "20261018"));
        Check(
            "netease identity versioncode",
            identity.Any(cookie => cookie.Name == "versioncode" && cookie.Value == "140") &&
            identity.Any(cookie => cookie.Name == "resolution" && cookie.Value == "1920x1080"));

        Check(
            "netease status mapping",
            Map(800, false) is { State: "expired" } &&
            Map(801, false) is { State: "waiting" } &&
            Map(802, false) is { State: "scanned" } &&
            Map(803, true) is { State: "authorized" } &&
            Map(803, false) is { State: "error" });
        Check(
            "netease risk control mapping",
            Map(8821, false) is { State: "error" } risk &&
            risk.Message.Contains("8821", StringComparison.Ordinal) &&
            risk.Message.Contains("Cookie 导入", StringComparison.Ordinal));
        Check("netease unknown status rejected", !NeteaseLoginProvider.TryMapPollStatus(999, false, out _, out _));
        Check("netease unikey parse", NeteaseLoginProvider.ParseUniKey("{\"code\":200,\"unikey\":\"abc\"}") == "abc");
        Check(
            "netease unikey parse nested",
            NeteaseLoginProvider.ParseUniKey("{\"code\":200,\"data\":{\"unikey\":\"xyz\"}}") == "xyz");
        Check("netease unikey parse invalid", NeteaseLoginProvider.ParseUniKey("not json") == string.Empty);
        Check("netease code parse", NeteaseLoginProvider.ParseCode("{\"code\":801}") == 801);
        Check("netease code parse invalid", NeteaseLoginProvider.ParseCode("<html/>") == -1);
        Check(
            "netease response cookie header",
            NeteaseLoginProvider.FindCookieInResponse(
                ["MUSIC_U=abc; Path=/; Domain=music.163.com"],
                null,
                "MUSIC_U") == "abc");
        Check(
            "netease response cookie body",
            NeteaseLoginProvider.FindCookieInResponse(null, "MUSIC_U=zzz; __csrf=csrf-value", "MUSIC_U") == "zzz");
        Check(
            "netease response cookie missing",
            NeteaseLoginProvider.FindCookieInResponse(null, "__csrf=csrf-value", "MUSIC_U") is null);

        // ---- transport plumbing shared by both platforms ----
        var response = new LoginHttpResponse(
            302,
            "{\"code\":803}",
            [1, 2, 3],
            "application/json",
            "https://graph.qq.com/oauth2.0/login_jump",
            ["p_skey=AAA; Domain=graph.qq.com; Path=/"]);
        Check(
            "login response exposes location",
            response.Location == "https://graph.qq.com/oauth2.0/login_jump");
        Check("login response exposes set-cookie", response.SetCookies is { Count: 1 });
        Check(
            "set-cookie parser",
            SetCookieParser.ToDictionary(["p_skey=AAA; Domain=graph.qq.com; Path=/"], out var domains) is { } values &&
            values.TryGetValue("p_skey", out var pskey) &&
            pskey == "AAA" &&
            domains.TryGetValue("p_skey", out var pskeyDomain) &&
            pskeyDomain == "graph.qq.com");
        Check(
            "cookie header parser",
            SetCookieParser.FromCookieHeader("a=1; b=x=y") is { } header &&
            header.TryGetValue("a", out var a) &&
            a == "1" &&
            header.TryGetValue("b", out var b) &&
            b == "x=y");

        HostLog.Info($"[account-selftest] passed={passed} failed={failed}");
        return failed;
    }

    private static (bool Ok, string MusicId, string MusicKey) ReadCredential(string json)
    {
        using var document = JsonDocument.Parse(json);
        var ok = QqLoginProvider.TryReadCredential(document.RootElement, out var musicId, out var musicKey, out _);
        return (ok, musicId, musicKey);
    }

    private static (string State, string Message) Map(int code, bool hasMusicU) =>
        NeteaseLoginProvider.TryMapPollStatus(code, hasMusicU, out var state, out var message)
            ? (state, message)
            : (string.Empty, string.Empty);
}
