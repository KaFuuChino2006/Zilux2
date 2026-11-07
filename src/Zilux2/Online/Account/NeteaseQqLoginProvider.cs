using System.Security.Cryptography;
using System.Windows;
using System.Windows.Threading;

namespace Zilux2.Online.Account;

// The official QQ page owns qrsig, polling and the NetEase OAuth callback. Export its actual QR
// image to our panel; never generate a QQ Music QR for a NetEase login or share their cookies.
internal sealed class NeteaseQqLoginProvider(NeteaseLoginProvider netease) : IDisposable
{
    internal const string KeyPrefix = "nq:";
    internal const int ExpiresSeconds = 120;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private QuickLoginProbe.Session? _browser;
    private DispatcherTimer? _expiry;
    private string _key = "";
    private DateTimeOffset _createdAt;
    private LoginStatusResponse? _terminal;
    private bool _disposed;

    private static Task<T> OnUiAsync<T>(Func<Task<T>> action)
    {
        var dispatcher = Application.Current?.Dispatcher ?? throw new AccountException("unavailable", "宿主窗口不可用");
        return dispatcher.CheckAccess() ? action() : dispatcher.InvokeAsync(action).Task.Unwrap();
    }

    public Task<LoginQrResponse> CreateQrAsync(CancellationToken cancellationToken) => OnUiAsync(async () =>
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            CloseBrowser();
            _terminal = null;
            _key = KeyPrefix + Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            _browser = new QuickLoginProbe.Session(AccountSources.Netease, "scan-netease-qq");
            await _browser.InitializeAsync(cancellationToken);
            var image = await _browser.ReadQrImageAsync(cancellationToken);
            _createdAt = DateTimeOffset.UtcNow;
            _expiry ??= new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
            _expiry.Tick -= ExpireIdle;
            _expiry.Tick += ExpireIdle;
            _expiry.Start();
            OnlineHttp.Info("[account] qr source=netease channel=ptlogin ready");
            return new LoginQrResponse
            {
                Source = AccountSources.Netease, Channel = "ptlogin", Key = _key,
                Mode = "image", ImageDataUrl = image, ExpiresIn = ExpiresSeconds,
            };
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            CloseBrowser();
            throw new AccountException("timeout", "网易云 QQ 二维码获取超时，请刷新或切换网易云 App 扫码");
        }
        catch { CloseBrowser(); throw; }
        finally { _gate.Release(); }
    });

    public Task<LoginStatusResponse> PollAsync(string key, CancellationToken cancellationToken) => OnUiAsync(async () =>
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (key != _key) return Expired();
            if (DateTimeOffset.UtcNow - _createdAt >= TimeSpan.FromSeconds(ExpiresSeconds))
            { CloseBrowser(); return _terminal = Expired(); }
            if (_terminal is not null) return _terminal;
            if (_browser is null) return Expired();
            var status = await _browser.ReadQrStatusAsync(cancellationToken);
            if (status.Result is { } result)
            {
                var account = await netease.SaveCookiesAsync(result.Cookies.Select(c =>
                    new StoredCookie("music.163.com", c.Name, c.Value)).ToList(), cancellationToken);
                _terminal = new LoginStatusResponse { State = "authorized", Message = "网易云登录成功", Account = account };
                CloseBrowser();
                OnlineHttp.Info("[account] login source=netease channel=ptlogin ok");
                return _terminal;
            }
            var response = new LoginStatusResponse { State = status.State, Message = status.Message };
            if (status.State is "expired" or "refused" or "error") { _terminal = response; CloseBrowser(); }
            return response;
        }
        catch (AccountException exception)
        {
            CloseBrowser();
            return _terminal = new LoginStatusResponse { State = "error", Message = exception.Message };
        }
        finally { _gate.Release(); }
    });

    private static LoginStatusResponse Expired() => new() { State = "expired", Message = "QQ 二维码已过期，请刷新" };

    private void ExpireIdle(object? sender, EventArgs e)
    {
        if (_gate.CurrentCount > 0 && DateTimeOffset.UtcNow - _createdAt >= TimeSpan.FromSeconds(ExpiresSeconds))
        { _terminal ??= Expired(); CloseBrowser(); }
    }

    private void CloseBrowser()
    {
        _expiry?.Stop();
        _browser?.Dispose();
        _browser = null;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher is null || dispatcher.CheckAccess()) CloseBrowser();
        else if (!dispatcher.HasShutdownStarted) dispatcher.BeginInvoke(new Action(CloseBrowser));
    }
}
