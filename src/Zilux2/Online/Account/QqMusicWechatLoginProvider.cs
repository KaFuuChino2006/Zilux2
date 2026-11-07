using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Zilux2.Online.Account;

// QQ 音乐微信扫码登录（open.weixin.qq.com 网页 OAuth，tmeLoginType 1）。
//
// 流程：拉 qrconnect 页面拿 uuid 与二维码图片；后台长轮询 lp.open.weixin.qq.com 等 405（已确认）；
// 拿 OAuth code 调 musicu Login 换 musickey。手机微信扫码即可，不需要 QQ 音乐 App。

internal sealed class QqMusicWechatLoginProvider : IDisposable
{
    private const string AppId = "wx48db31d50e334801";
    private const string ConnectUrl = "https://open.weixin.qq.com/connect/qrconnect";
    private const string ImagePrefix = "https://open.weixin.qq.com/connect/qrcode/";
    private const string PollUrl = "https://lp.open.weixin.qq.com/connect/l/qrconnect";
    private const string RedirectUri = "https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/";
    private const string StyleHref = "https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect";
    private const int QrExpiresSeconds = 300;
    private const int PollBudgetMs = 10_000;

    private static readonly Regex UuidPattern = new("uuid=(.+?)\"", RegexOptions.Compiled);
    private static readonly Regex StatusPattern = new(@"window\.wx_errcode=(\d+);window\.wx_code='([^']*)'", RegexOptions.Compiled);

    private sealed class Session
    {
        public required string Key { get; init; }
        public required DateTimeOffset ExpiresAt { get; init; }
        public required QqMusicDevice Device { get; init; }
        public volatile string State = "waiting";
        public volatile string Message = "等待微信扫码…";
        public AccountInfo? Account { get; set; }
        public CancellationTokenSource Cts { get; } = new();
    }

    private readonly QqLoginProvider _qq;
    private readonly HttpClient _http;
    private readonly Dictionary<string, Session> _sessions = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private readonly CancellationTokenSource _disposeCts = new();
    private bool _disposed;

    public QqMusicWechatLoginProvider(QqLoginProvider qq)
    {
        _qq = qq;
        _http = QqMusicApi.CreateHttpClient();
    }

    public async Task<LoginQrResponse> CreateQrAsync(CancellationToken cancellationToken)
    {
        var query = string.Join('&', new[]
        {
            "appid=" + AppId,
            "redirect_uri=" + Uri.EscapeDataString(RedirectUri),
            "response_type=code",
            "scope=snsapi_login",
            "state=STATE",
            "href=" + Uri.EscapeDataString(StyleHref),
        });
        using var pageRequest = new HttpRequestMessage(HttpMethod.Get, ConnectUrl + "?" + query)
        {
            Headers = { { "User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36" } },
        };
        using var pageResponse = await _http.SendAsync(pageRequest, cancellationToken).ConfigureAwait(false);
        var html = await pageResponse.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        var uuid = UuidPattern.Match(html) is { Success: true } match ? match.Groups[1].Value : string.Empty;
        if (uuid.Length == 0)
        {
            throw new AccountException("upstream-failed", "微信没有返回二维码，请稍后重试");
        }

        using var imageResponse = await _http.GetAsync(ImagePrefix + uuid, cancellationToken).ConfigureAwait(false);
        var bytes = await imageResponse.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
        var contentType = imageResponse.Content.Headers.ContentType?.MediaType ?? "image/png";
        if (!imageResponse.IsSuccessStatusCode || bytes.Length == 0)
        {
            throw new AccountException("upstream-failed", "微信二维码图片获取失败，请稍后重试");
        }

        var session = new Session
        {
            Key = uuid,
            ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(QrExpiresSeconds),
            Device = QqMusicDevice.Create(),
        };
        lock (_gate)
        {
            _sessions[uuid] = session;
        }

        _ = Task.Run(() => PollLoopAsync(session), CancellationToken.None);
        _ = Task.Run(() => CleanupAsync(session), CancellationToken.None);
        OnlineHttp.Info($"[account] qr source=qq channel=wechat keyLen={uuid.Length} expiresIn={QrExpiresSeconds}");

        return new LoginQrResponse
        {
            Source = AccountSources.Qq,
            Channel = "wechat",
            Mode = "image",
            Key = "wx:" + uuid,
            ImageDataUrl = $"data:{contentType};base64,{Convert.ToBase64String(bytes)}",
            ExpiresIn = QrExpiresSeconds,
        };
    }

    public LoginStatusResponse Poll(string key)
    {
        Session? session;
        lock (_gate)
        {
            _sessions.TryGetValue(key, out session);
        }

        if (session is null)
        {
            return new LoginStatusResponse { State = "expired", Message = "二维码已过期，请重新生成" };
        }

        if (session.Account is { } account)
        {
            return new LoginStatusResponse { State = "authorized", Message = "登录成功", Account = account };
        }

        if (DateTimeOffset.UtcNow >= session.ExpiresAt && session.State == "waiting")
        {
            return new LoginStatusResponse { State = "expired", Message = "二维码已过期，请重新生成" };
        }

        return new LoginStatusResponse { State = session.State, Message = session.Message };
    }

    private async Task PollLoopAsync(Session session)
    {
        try
        {
            while (!session.Cts.IsCancellationRequested)
            {
                var url = PollUrl + "?uuid=" + Uri.EscapeDataString(session.Key) + "&_=" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                using var request = new HttpRequestMessage(HttpMethod.Get, url)
                {
                    Headers =
                    {
                        { "Referer", "https://open.weixin.qq.com/" },
                        { "User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36" },
                    },
                };
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(session.Cts.Token);
                timeout.CancelAfter(PollBudgetMs);
                try
                {
                    using var response = await _http.SendAsync(request, timeout.Token).ConfigureAwait(false);
                    var text = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
                    var match = StatusPattern.Match(text);
                    if (!match.Success)
                    {
                        await Task.Delay(1500, session.Cts.Token).ConfigureAwait(false);
                        continue;
                    }

                    var code = int.Parse(match.Groups[1].Value);
                    var wxCode = match.Groups[2].Value;
                    switch (code)
                    {
                        case 408:
                            session.State = "waiting";
                            session.Message = "等待微信扫码…";
                            break;
                        case 404:
                            session.State = "scanned";
                            session.Message = "已扫码，请在手机上确认";
                            break;
                        case 405:
                            await ExchangeAsync(session, wxCode).ConfigureAwait(false);
                            return;
                        case 402:
                            session.State = "expired";
                            session.Message = "二维码已过期，请重新生成";
                            return;
                        case 403:
                            session.State = "refused";
                            session.Message = "已在手机上取消登录";
                            return;
                    }
                }
                catch (OperationCanceledException) when (!session.Cts.IsCancellationRequested)
                {
                    // 长轮询到预算上限没有状态变化，属于正常返回。
                }
            }
        }
        catch (OperationCanceledException)
        {
            // 会话取消
        }
        catch (Exception exception)
        {
            session.State = "error";
            session.Message = "微信扫码通道异常，请重新生成二维码";
            OnlineHttp.Warn($"[account] wechat qr failed: {OnlineHttp.Describe(exception)}");
        }
    }

    private async Task ExchangeAsync(Session session, string code)
    {
        try
        {
            // 换凭证是 musicu 调用，需要 Android 设备上下文；这里才去取 QIMEI，避免拖慢二维码生成。
            var (q16, q36) = await QimeiBootstrap.FetchAsync(_http, session.Device, session.Cts.Token).ConfigureAwait(false);
            session.Device.Qimei = q16;
            session.Device.Qimei36 = q36;
            var credential = await QqMusicApi.ExchangeWechatCredentialAsync(_http, session.Device, code, session.Cts.Token)
                .ConfigureAwait(false);
            var musicId = credential?["musicid"]?.ToString()
                          ?? credential?["str_musicid"]?.ToString()
                          ?? string.Empty;
            var musicKey = credential?["musickey"]?.GetValue<string>() ?? string.Empty;
            if (musicKey.Length == 0)
            {
                throw new AccountException("upstream-failed", "微信登录没有返回 musickey，请重试");
            }

            var account = await _qq.SaveCredentialAsync(musicId, musicKey, session.Cts.Token).ConfigureAwait(false);
            session.Account = account;
            session.State = "authorized";
            session.Message = "登录成功";
            OnlineHttp.Info($"[account] login source=qq channel=wechat userId={musicId} keyLen={musicKey.Length}");
        }
        catch (Exception exception)
        {
            session.State = "error";
            session.Message = exception is AccountException accountException
                ? accountException.Message
                : "微信登录凭证交换失败，请重试";
            OnlineHttp.Warn($"[account] wechat exchange failed: {OnlineHttp.Describe(exception)}");
        }
    }

    private async Task CleanupAsync(Session session)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(QrExpiresSeconds + 60), _disposeCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        lock (_gate)
        {
            _sessions.Remove(session.Key);
        }

        try
        {
            session.Cts.Cancel();
        }
        catch
        {
            // ignore
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _disposeCts.Cancel();
        lock (_gate)
        {
            foreach (var session in _sessions.Values)
            {
                try
                {
                    session.Cts.Cancel();
                }
                catch
                {
                    // ignore
                }
            }

            _sessions.Clear();
        }

        _http.Dispose();
        _disposeCts.Dispose();
    }
}

