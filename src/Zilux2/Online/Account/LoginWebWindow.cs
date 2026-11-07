using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace Zilux2.Online.Account;

// 内嵌 WebView2 打开平台官方登录页：平台页面自己会显示「快捷登录」（本机 QQ 头像 / 二维码），
// 用户在页面里点一下即可。宿主只负责等登录 cookie 出现，然后交给账号服务落库。
//
// 这样不碰腾讯的本地私有接口，也不需要复刻 OAuth 跳转。

internal sealed record WebLoginCookie(string Name, string Value, string Domain);
internal sealed record WebLoginResult(IReadOnlyList<WebLoginCookie> Cookies, string Url);

internal sealed class LoginWebWindow : Window
{
    private readonly TaskCompletionSource<WebLoginResult?> _completion =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly WebView2 _web;
    private readonly string _cookieDomain;
    private readonly string _cookieName;
    private readonly string? _successUrlFragment;
    private readonly DispatcherTimer _timer;
    private bool _closing;

    private LoginWebWindow(string title, string hint, string startUrl, string cookieDomain, string cookieName, string? successUrlFragment)
    {
        Title = title;
        Width = 480;
        Height = 760;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.CanResize;
        _cookieDomain = cookieDomain;
        _cookieName = cookieName;
        _successUrlFragment = successUrlFragment;

        _web = new WebView2();
        var hintBar = new TextBlock
        {
            Text = hint,
            Margin = new Thickness(14, 10, 14, 10),
            TextWrapping = TextWrapping.Wrap,
            FontSize = 13,
        };
        var grid = new Grid();
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        Grid.SetRow(hintBar, 0);
        Grid.SetRow(_web, 1);
        grid.Children.Add(hintBar);
        grid.Children.Add(_web);
        Content = grid;

        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1.5) };
        _timer.Tick += async (_, _) => await CheckCookiesAsync();
        Closed += (_, _) =>
        {
            _timer.Stop();
            if (!_closing)
            {
                _completion.TrySetResult(null);
            }
        };
        Loaded += async (_, _) =>
        {
            try
            {
                var dataDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Zilux2",
                    "login-webview");
                var environment = await CoreWebView2Environment.CreateAsync(null, dataDir);
                await _web.EnsureCoreWebView2Async(environment);
                _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
                _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                _web.CoreWebView2.NavigationCompleted += async (_, _) => await CheckCookiesAsync();
                _web.Source = new Uri(startUrl);
                _timer.Start();
            }
            catch (Exception exception)
            {
                OnlineHttp.Warn($"[account] login webview failed: {OnlineHttp.Describe(exception)}");
                Close();
            }
        };
    }

    private async Task CheckCookiesAsync()
    {
        if (_closing || _web.CoreWebView2 is null) return;
        var url = _web.Source?.AbsoluteUri ?? "";
        if (!string.IsNullOrEmpty(_successUrlFragment) && url.Contains(_successUrlFragment, StringComparison.OrdinalIgnoreCase))
        {
            _closing = true;
            _timer.Stop();
            _completion.TrySetResult(new WebLoginResult(Array.Empty<WebLoginCookie>(), url));
            Close();
            return;
        }
        try
        {
            var cookies = await _web.CoreWebView2.CookieManager.GetCookiesAsync(_cookieDomain);
            var match = cookies.FirstOrDefault(cookie =>
                string.Equals(cookie.Name, _cookieName, StringComparison.OrdinalIgnoreCase) && cookie.Value.Length > 0);
            if (match is null) return;

            _closing = true;
            _timer.Stop();
            _completion.TrySetResult(new WebLoginResult(
                cookies
                    .Where(cookie => cookie.Value.Length > 0)
                    .Select(cookie => new WebLoginCookie(cookie.Name, cookie.Value, cookie.Domain))
                    .ToList(),
                url));
            Close();
        }
        catch (Exception exception)
        {
            OnlineHttp.Warn($"[account] login webview cookie read failed: {OnlineHttp.Describe(exception)}");
        }
    }

    /// <summary>在 UI 线程调用：打开登录窗，等 cookie 出现或用户关闭。</summary>
    public static Task<WebLoginResult?> ShowAsync(
        Window owner,
        string title,
        string hint,
        string startUrl,
        string cookieDomain,
        string cookieName,
        string? successUrlFragment = null)
    {
        var window = new LoginWebWindow(title, hint, startUrl, cookieDomain, cookieName, successUrlFragment) { Owner = owner };
        window.Show();
        window.Activate();
        return window._completion.Task;
    }
}


