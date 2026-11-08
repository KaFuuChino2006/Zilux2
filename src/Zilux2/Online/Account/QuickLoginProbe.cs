using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace Zilux2.Online.Account;

internal sealed record QuickAccount(string Id, string Nickname, string AvatarUrl);
internal sealed record BrowserQrStatus(string State, string Message, WebLoginResult? Result = null);

// UI-thread only. Keep the official page warm, including graph.qq.com's cross-origin QQ frame.
internal static class QuickLoginProbe
{
    private static readonly Dictionary<string, Session> Sessions = new();
    private static readonly Dictionary<string, SemaphoreSlim> Gates = new()
    {
        [AccountSources.Qq] = new(1, 1), [AccountSources.Netease] = new(1, 1),
    };
    private static DispatcherTimer? _cleanup;

    // Only real, visible ptlogin account tiles qualify; a default/profile image is not a local QQ.
    internal const string AccountsScript = """
        (() => [...document.querySelectorAll('#qlogin_list a.face[uin]')].flatMap(tile => {
          const rect = tile.getBoundingClientRect(), style = getComputedStyle(tile);
          const key = tile.getAttribute('uin') || '', img = tile.querySelector('img');
          const src = img?.currentSrc || img?.src || '';
          let url; try { url = new URL(src); } catch { return []; }
          if (!/^\d{5,20}$/.test(key) || rect.width < 20 || rect.height < 20 ||
              style.display === 'none' || style.visibility === 'hidden' ||
              url.protocol !== 'https:' || !/(^|\.)(qlogo|qpic)\.cn$/i.test(url.hostname)) return [];
          return [{ key, name: (tile.querySelector('.nick, .nickname')?.textContent || '').trim().slice(0,80), src }];
        }).slice(0,8))()
        """;

    public static async Task<IReadOnlyList<QuickAccount>> GetAsync(string source, CancellationToken cancellationToken)
    {
        var gate = Gates[source];
        await gate.WaitAsync(cancellationToken);
        try
        {
            // Opening/re-detecting the panel asks QQ for a fresh list, rather than stale DOM tiles.
            Remove(source);
            return await (await GetSessionAsync(source, cancellationToken)).FindAccountsAsync(cancellationToken);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception exception)
        {
            Remove(source);
            OnlineHttp.Warn($"[account] quick probe failed source={source} type={exception.GetType().Name}");
            return Array.Empty<QuickAccount>();
        }
        finally { gate.Release(); }
    }

    public static async Task<WebLoginResult> LoginAsync(string source, string accountId, CancellationToken cancellationToken)
    {
        var gate = Gates[source];
        if (!await gate.WaitAsync(0, cancellationToken))
            throw new AccountException("login-busy", "正在登录，请稍候", 409);
        try { return await (await GetSessionAsync(source, cancellationToken)).LoginAsync(accountId, cancellationToken); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        { throw new AccountException("timeout", "快捷登录超时，请重试或在当前页面扫码登录"); }
        finally { Remove(source); gate.Release(); }
    }

    private static async Task<Session> GetSessionAsync(string source, CancellationToken cancellationToken)
    {
        if (Sessions.TryGetValue(source, out var existing))
        {
            if (!existing.Expired) { existing.Touch(); return existing; }
            Remove(source);
        }
        var session = new Session(source);
        Sessions[source] = session;
        try { await session.InitializeAsync(cancellationToken); }
        catch { Remove(source); throw; }
        if (_cleanup is null)
        {
            _cleanup = new DispatcherTimer { Interval = TimeSpan.FromSeconds(15) };
            _cleanup.Tick += (_, _) =>
            {
                foreach (var key in Sessions.Keys.ToArray())
                    if (Gates[key].CurrentCount > 0 && Sessions[key].Expired) Remove(key);
            };
            _cleanup.Start();
        }
        return session;
    }

    private static void Remove(string source)
    { if (Sessions.Remove(source, out var session)) session.Dispose(); }

    internal static bool IsLoginFrame(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
        uri.Scheme == Uri.UriSchemeHttps && uri.Host is
            "xui.ptlogin2.qq.com" or "ssl.ptlogin2.qq.com" or "ui.ptlogin2.qq.com" or "graph.qq.com";

    internal sealed class Session(string source, string? profileName = null) : IDisposable
    {
        private readonly WebView2 _web = new();
        private readonly Window _window = new()
        {
            Width = 640, Height = 760, Left = -4000, Top = -4000,
            ShowInTaskbar = false, ShowActivated = false, WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize, Opacity = 0,
        };
        private readonly string _state = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        private readonly TaskCompletionSource<WebLoginResult> _result = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly Dictionary<string, string> _accountKeys = new();
        private DateTimeOffset _lastUsed = DateTimeOffset.UtcNow;
        private bool _loginRequested;
        private bool _disposed;
        private readonly TaskCompletionSource<string> _qrImage = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private string _qrState = "waiting";
        private bool _qrConfirmed;
        private int _consentClicks;
        public bool Expired => _disposed || DateTimeOffset.UtcNow - _lastUsed > TimeSpan.FromSeconds(90);
        public void Touch() => _lastUsed = DateTimeOffset.UtcNow;

        public async Task InitializeAsync(CancellationToken cancellationToken)
        {
            _window.Content = _web;
            _window.Show();
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Zilux2", "login-webview"));
            cancellationToken.ThrowIfCancellationRequested();
            var options = environment.CreateCoreWebView2ControllerOptions();
            options.ProfileName = profileName ?? "quick-login-" + source;
            await _web.EnsureCoreWebView2Async(environment, options);
            var core = _web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDefaultScriptDialogsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            if (profileName is not null) core.WebResourceResponseReceived += CaptureQrResponse;
            core.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                if (IsLoginFrame(e.Uri) || IsPlatformUrl(e.Uri)) core.Navigate(e.Uri);
            };
            core.NavigationStarting += (_, e) =>
            {
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) ||
                    (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != "about")) { e.Cancel = true; return; }
                if (_loginRequested && source == AccountSources.Qq &&
                    QqLoginProvider.TryValidateAuthorizeRedirect(e.Uri, _state, out var ignoredCode, out var ignoredError))
                {
                    e.Cancel = true;
                    _result.TrySetResult(new WebLoginResult(Array.Empty<WebLoginCookie>(), e.Uri));
                }
            };
            if (source == AccountSources.Netease)
            {
                // A previous QQ's cookie must never be mistaken for this click's result.
                var cookies = await core.CookieManager.GetCookiesAsync("https://music.163.com");
                foreach (var cookie in cookies.Where(c => c.Name == "MUSIC_U")) core.CookieManager.DeleteCookie(cookie);
            }
            var url = source == AccountSources.Netease || source == AccountSources.Qq
                ? "https://music.163.com/api/sns/authorize?snsType=5&clientType=web2&callbackType=Login&forcelogin=true"
                : "https://graph.qq.com/oauth2.0/authorize?client_id=100497308&response_type=code&redirect_uri=" +
                    Uri.EscapeDataString(QqLoginProvider.RedirectUri) + "&state=" + _state + "&forcelogin=true";
            core.Navigate(url);
        }

        private static bool IsPlatformUrl(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
            uri.Scheme == Uri.UriSchemeHttps && uri.Host is "music.163.com" or "y.qq.com";

        private async void CaptureQrResponse(object? sender, CoreWebView2WebResourceResponseReceivedEventArgs e)
        {
            if (_disposed || !Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var uri) ||
                !IsLoginFrame(e.Request.Uri) || e.Response.StatusCode != 200) return;
            var image = uri.AbsolutePath.EndsWith("/ptqrshow", StringComparison.Ordinal);
            var status = uri.AbsolutePath.EndsWith("/ptqrlogin", StringComparison.Ordinal);
            if (!image && !status) return;
            try
            {
                using var stream = await e.Response.GetContentAsync();
                if (stream is null || _disposed) return;
                using var bytes = new MemoryStream();
                var buffer = new byte[8192];
                int count;
                while ((count = await stream.ReadAsync(buffer)) > 0)
                {
                    if (bytes.Length + count > 256 * 1024) return;
                    bytes.Write(buffer, 0, count);
                }
                if (_disposed) return;
                var content = bytes.ToArray();
                if (image && content.Length > 8 && content.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }))
                    _qrImage.TrySetResult("data:image/png;base64," + Convert.ToBase64String(content));
                if (status && QqLoginProvider.TryParsePtuiCb(Encoding.UTF8.GetString(content), out var code, out _, out _, out _))
                {
                    if (code == "0") { _qrConfirmed = true; _qrState = "scanned"; }
                    else if (!_qrConfirmed) _qrState = MapQrState(code);
                }
                else if (status) OnlineHttp.Warn($"[account] QQ scan status unreadable source={source} bytes={content.Length}");
            }
            catch (Exception exception)
            {
                if (!_disposed) OnlineHttp.Warn($"[account] QQ scan response source={source} type={exception.GetType().Name}");
            }
        }

        internal static string MapQrState(string code) => code switch
        { "0" or "67" => "scanned", "65" => "expired", "66" => "waiting", "68" => "refused", _ => "error" };

        public async Task<string> ReadQrImageAsync(CancellationToken cancellationToken)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(18));
            return await _qrImage.Task.WaitAsync(timeout.Token);
        }

        private async Task<WebLoginResult?> ReadNeteaseResultAsync()
        {
            if (source != AccountSources.Netease || !IsPlatformUrl(_web.Source?.AbsoluteUri ?? "")) return null;
            var cookies = await _web.CoreWebView2.CookieManager.GetCookiesAsync("https://music.163.com");
            return cookies.Any(c => c.Name == "MUSIC_U" && c.Value.Length > 0)
                ? new WebLoginResult(cookies.Where(c => c.Value.Length > 0)
                    .Select(c => new WebLoginCookie(c.Name, c.Value, c.Domain)).ToList(), _web.Source?.AbsoluteUri ?? "")
                : null;
        }

        private async Task ConfirmConsentAsync()
        {
            if (_consentClicks >= 2) return;
            foreach (var context in await GetContextsAsync())
                if (await ClickAsync(context, "document.querySelector('#authBtn, #authorize_button')"))
                { _consentClicks++; break; }
        }

        public async Task<BrowserQrStatus> ReadQrStatusAsync(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_qrConfirmed)
            {
                var result = await ReadNeteaseResultAsync();
                if (result is not null) return new("authorized", "登录成功", result);
                await ConfirmConsentAsync();
                return new("scanned", "手机 QQ 已确认，正在完成网易云授权…");
            }
            return new(_qrState, _qrState switch
            {
                "scanned" => "已扫码，请在手机 QQ 上确认",
                "expired" => "QQ 二维码已过期，请刷新",
                "refused" => "已取消 QQ 登录，请重新扫码",
                "error" => "QQ 扫码未完成，请刷新后重试",
                _ => "使用手机 QQ 扫码登录网易云音乐",
            });
        }

        public async Task<IReadOnlyList<QuickAccount>> FindAccountsAsync(CancellationToken cancellationToken)
        {
            for (var attempt = 0; attempt < 30; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var accounts = new List<QuickAccount>();
                foreach (var context in await GetContextsAsync())
                {
                    using var evaluated = await EvaluateAsync(context, AccountsScript, true);
                    if (!TryValue(evaluated, out var value) || value.ValueKind != JsonValueKind.Array) continue;
                    foreach (var item in value.EnumerateArray())
                    {
                        var key = item.GetProperty("key").GetString()!;
                        var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(source + ":" + key)));
                        if (accounts.Any(a => a.Id == id)) continue;
                        _accountKeys[id] = key;
                        var name = item.GetProperty("name").GetString();
                        accounts.Add(new QuickAccount(id, string.IsNullOrWhiteSpace(name) ? "本机 QQ" : name,
                            item.GetProperty("src").GetString()!));
                    }
                }
                if (accounts.Count > 0) { Touch(); return accounts; }
                await Task.Delay(350, cancellationToken);
            }
            return Array.Empty<QuickAccount>();
        }

        public async Task<WebLoginResult> LoginAsync(string accountId, CancellationToken cancellationToken)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(45));
            var token = timeout.Token;
            var accounts = await FindAccountsAsync(token);
            if (!accounts.Any(a => a.Id == accountId) || !_accountKeys.TryGetValue(accountId, out var key))
                throw new AccountException("account-unavailable", "这个 QQ 已退出或不可用，请刷新本机 QQ 或在当前页面扫码登录");
            _loginRequested = true;
            var clicked = false;
            foreach (var context in await GetContextsAsync())
            {
                if (await ClickAsync(context, $"document.querySelector('#qlogin_list a.face[uin=\"{key}\"]')"))
                { clicked = true; break; }
            }
            if (!clicked) throw new AccountException("account-unavailable", "本机 QQ 状态已变化，请刷新后重试");
            while (true)
            {
                token.ThrowIfCancellationRequested();
                if (_result.Task.IsCompleted) return await _result.Task;
                if (await ReadNeteaseResultAsync() is { } netease) return netease;
                // Only official OAuth confirmation, after the user has chosen a QQ account.
                await ConfirmConsentAsync();
                await Task.Delay(500, token);
            }
        }

        private async Task<List<int>> GetContextsAsync()
        {
            var contexts = new List<int>();
            string json;
            try { json = await _web.CoreWebView2.CallDevToolsProtocolMethodAsync("Page.getFrameTree", "{}"); }
            catch (System.Runtime.InteropServices.COMException) { return contexts; }
            using var tree = JsonDocument.Parse(json);
            await Walk(tree.RootElement.GetProperty("frameTree"));
            return contexts;
            async Task Walk(JsonElement node)
            {
                var frame = node.GetProperty("frame");
                if (IsLoginFrame(frame.GetProperty("url").GetString() ?? ""))
                {
                    try
                    {
                        using var world = JsonDocument.Parse(await _web.CoreWebView2.CallDevToolsProtocolMethodAsync(
                            "Page.createIsolatedWorld", JsonSerializer.Serialize(new { frameId = frame.GetProperty("id").GetString(), worldName = "zilux2-quick-login" })));
                        contexts.Add(world.RootElement.GetProperty("executionContextId").GetInt32());
                    }
                    catch (System.Runtime.InteropServices.COMException) { /* frame navigated */ }
                }
                if (node.TryGetProperty("childFrames", out var children)) foreach (var child in children.EnumerateArray()) await Walk(child);
            }
        }

        private async Task<JsonDocument> EvaluateAsync(int contextId, string expression, bool returnByValue)
        {
            try
            {
                return JsonDocument.Parse(await _web.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.evaluate",
                    JsonSerializer.Serialize(new { contextId, expression, returnByValue })));
            }
            catch (System.Runtime.InteropServices.COMException)
            { return JsonDocument.Parse("{\"result\":{}}"); } // frame navigated; retry with fresh contexts
        }

        private static bool TryValue(JsonDocument document, out JsonElement value)
        {
            value = default;
            return document.RootElement.TryGetProperty("result", out var result) && result.TryGetProperty("value", out value);
        }

        private async Task<bool> ClickAsync(int contextId, string elementExpression)
        {
            string? objectId = null;
            try
            {
                using var evaluated = await EvaluateAsync(contextId, "(() => { const e = " + elementExpression +
                    "; if (!e || e.disabled) return null; const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(e).visibility!=='hidden' ? e : null; })()", false);
                if (!evaluated.RootElement.GetProperty("result").TryGetProperty("objectId", out var id)) return false;
                objectId = id.GetString();
                var core = _web.CoreWebView2;
                await core.CallDevToolsProtocolMethodAsync("DOM.scrollIntoViewIfNeeded", JsonSerializer.Serialize(new { objectId }));
                using var quads = JsonDocument.Parse(await core.CallDevToolsProtocolMethodAsync("DOM.getContentQuads", JsonSerializer.Serialize(new { objectId })));
                var list = quads.RootElement.GetProperty("quads");
                if (list.GetArrayLength() == 0) return false;
                var quad = list[0].EnumerateArray().Select(v => v.GetDouble()).ToArray();
                var x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
                var y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
                // Browser input stays inside WebView2; no foreground activation or OS cursor movement.
                await core.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseMoved", x, y }));
                await core.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mousePressed", x, y, button = "left", buttons = 1, clickCount = 1 }));
                await core.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", JsonSerializer.Serialize(new { type = "mouseReleased", x, y, button = "left", buttons = 0, clickCount = 1 }));
                return true;
            }
            catch (System.Runtime.InteropServices.COMException) { return false; }
            finally
            {
                if (objectId is not null)
                    try { await _web.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.releaseObject", JsonSerializer.Serialize(new { objectId })); } catch { }
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _web.Dispose();
            _window.Close();
        }
    }
}

