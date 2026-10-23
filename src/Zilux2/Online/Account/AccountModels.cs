using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Zilux2.Online.Account;

// Contract docs/zilux2-account-login.md §2: the two supported account sources.
internal static class AccountSources
{
    public const string Netease = "netease";
    public const string Qq = "qq";

    // 平台清单统一登记在 MusicSourceCatalog：新增平台只改那里。
    public static readonly string[] All = MusicSourceCatalog.All.Select(item => item.Id).ToArray();

    public static bool IsKnown(string source) => MusicSourceCatalog.IsKnown(source);
}

internal sealed class AccountInfo
{
    [JsonPropertyName("source")] public string Source { get; init; } = AccountSources.Netease;

    [JsonPropertyName("loggedIn")] public bool LoggedIn { get; init; }

    [JsonPropertyName("nickname")] public string? Nickname { get; init; }

    [JsonPropertyName("avatarDataUrl")] public string? AvatarDataUrl { get; init; }

    // null means "unknown" by contract §2, not "not a member".
    [JsonPropertyName("vip")] public bool? Vip { get; init; }

    [JsonPropertyName("userId")] public string? UserId { get; init; }
}

internal sealed class AccountListResponse
{
    [JsonPropertyName("sources")] public List<AccountInfo> Sources { get; init; } = [];
}

internal sealed class LoginQrResponse
{
    [JsonPropertyName("source")] public string Source { get; init; } = AccountSources.Netease;

    // netease renders "content" with a QR library; qq ships a ready-made PNG.
    [JsonPropertyName("mode")] public string Mode { get; init; } = "code";

    [JsonPropertyName("key")] public string Key { get; init; } = string.Empty;

    [JsonPropertyName("content")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Content { get; init; }

    [JsonPropertyName("imageDataUrl")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ImageDataUrl { get; init; }

    [JsonPropertyName("expiresIn")] public int ExpiresIn { get; init; }
}

internal sealed class LoginStatusResponse
{
    [JsonPropertyName("state")] public string State { get; init; } = "waiting";

    [JsonPropertyName("message")] public string Message { get; init; } = string.Empty;

    [JsonPropertyName("account")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public AccountInfo? Account { get; init; }
}

internal sealed class LogoutResponse
{
    [JsonPropertyName("ok")] public bool Ok { get; init; } = true;
}

// Persisted shape of account.json. Cookie values are DPAPI-protected (contract §3), so this type
// only ever holds ciphertext plus display fields.
internal sealed class AccountStoreDocument
{
    [JsonPropertyName("version")] public int Version { get; init; } = 1;

    [JsonPropertyName("accounts")] public Dictionary<string, StoredAccount> Accounts { get; init; } = new(StringComparer.Ordinal);
}

internal sealed record StoredAccount
{
    [JsonPropertyName("nickname")] public string? Nickname { get; init; }

    [JsonPropertyName("avatarDataUrl")] public string? AvatarDataUrl { get; init; }

    [JsonPropertyName("vip")] public bool? Vip { get; init; }

    [JsonPropertyName("userId")] public string? UserId { get; init; }

    // Base64 of DPAPI(CurrentUser) over the cookie list JSON.
    [JsonPropertyName("cookie")] public string Cookie { get; init; } = string.Empty;

    [JsonPropertyName("updatedAt")] public string UpdatedAt { get; init; } = string.Empty;
}

internal sealed record StoredCookie(
    [property: JsonPropertyName("domain")] string Domain,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("value")] string Value);

// Carries the HTTP status the loopback API should answer with.
internal sealed class AccountException : Exception
{
    public AccountException(string code, string message, int statusCode = 502) : base(message)
    {
        Code = code;
        StatusCode = statusCode;
    }

    public string Code { get; }

    public int StatusCode { get; }
}

// Location/Set-Cookie are raw on purpose: the QQ OAuth handshake and the netease 803 response can
// only be finished by inspecting them ourselves (contract task-31), so the session never hides them.
internal sealed record LoginHttpResponse(
    int Status,
    string Body,
    byte[] Bytes,
    string? ContentType,
    string? Location = null,
    IReadOnlyList<string>? SetCookies = null);

// One QR login owns one cookie jar: the platform sets cookies on several host names during the
// handshake and later API calls must replay exactly those cookies.
internal sealed class LoginHttpSession : IDisposable
{
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(15);

    private readonly CookieContainer _cookies = new();
    private readonly HttpClient _client;
    private readonly HttpClient _noRedirectClient;
    private readonly string? _userAgent;
    private bool _disposed;

    public LoginHttpSession(string? userAgent = null)
    {
        _userAgent = string.IsNullOrWhiteSpace(userAgent) ? null : userAgent;
        var proxy = ResolveProxy();
        _client = CreateClient(allowAutoRedirect: true, proxy);
        _noRedirectClient = CreateClient(allowAutoRedirect: false, proxy);
    }

    public CookieContainer Cookies => _cookies;

    public void SetCookie(string domain, string name, string value)
    {
        if (string.IsNullOrEmpty(name) || value.Length == 0)
        {
            return;
        }

        // A fixed expiry keeps identity cookies alive for the whole QR handshake: session cookies
        // would be dropped by the jar as soon as the creation response is done.
        try
        {
            _cookies.Add(new Cookie(name, value, "/", domain)
            {
                Expires = DateTime.UtcNow.AddDays(7),
            });
        }
        catch (CookieException)
        {
            // CookieContainer rejects a few characters, notably the comma in netease's
            // "_ntes_nnid=<uuid>,<timestamp>". Quoting keeps the value intact on the wire and is
            // the cookie-value form RFC 6265 allows.
            try
            {
                _cookies.Add(new Cookie(name, "\"" + value + "\"", "/", domain)
                {
                    Expires = DateTime.UtcNow.AddDays(7),
                });
            }
            catch (CookieException exception)
            {
                OnlineHttp.Warn($"[account] cookie rejected name={name}: {exception.Message}");
            }
        }
    }

    public string? GetCookieValue(string name)
    {
        foreach (Cookie cookie in _cookies.GetAllCookies())
        {
            if (string.Equals(cookie.Name, name, StringComparison.OrdinalIgnoreCase) && cookie.Value.Length > 0)
            {
                return cookie.Value;
            }
        }

        return null;
    }

    public async Task<LoginHttpResponse> GetAsync(string url, string? referer, CancellationToken cancellationToken)
    {
        using var request = OnlineHttp.NewRequest(HttpMethod.Get, url, referer);
        return await SendAsync(_client, request, cancellationToken).ConfigureAwait(false);
    }

    public async Task<LoginHttpResponse> GetBytesAsync(string url, string? referer, CancellationToken cancellationToken)
    {
        using var request = OnlineHttp.NewRequest(HttpMethod.Get, url, referer);
        return await SendAsync(_client, request, cancellationToken).ConfigureAwait(false);
    }

    // QQ answers the OAuth hops with 302s whose Location and Set-Cookie are the payload; letting
    // HttpClient follow them silently is exactly what broke the previous login implementation.
    public async Task<LoginHttpResponse> GetNoRedirectAsync(
        string url,
        string? referer,
        CancellationToken cancellationToken)
    {
        using var request = OnlineHttp.NewRequest(HttpMethod.Get, url, referer);
        return await SendAsync(_noRedirectClient, request, cancellationToken).ConfigureAwait(false);
    }

    public async Task<LoginHttpResponse> PostFormAsync(
        string url,
        string body,
        string? referer,
        CancellationToken cancellationToken)
    {
        using var request = OnlineHttp.NewRequest(HttpMethod.Post, url, referer);
        request.Content = new StringContent(body, Encoding.UTF8, "application/x-www-form-urlencoded");
        return await SendAsync(_client, request, cancellationToken).ConfigureAwait(false);
    }

    public async Task<LoginHttpResponse> PostFormNoRedirectAsync(
        string url,
        string body,
        string? referer,
        CancellationToken cancellationToken)
    {
        using var request = OnlineHttp.NewRequest(HttpMethod.Post, url, referer);
        request.Content = new StringContent(body, Encoding.UTF8, "application/x-www-form-urlencoded");
        return await SendAsync(_noRedirectClient, request, cancellationToken).ConfigureAwait(false);
    }

    public async Task<LoginHttpResponse> PostJsonAsync(
        string url,
        string body,
        string? referer,
        CancellationToken cancellationToken)
    {
        using var request = OnlineHttp.NewRequest(HttpMethod.Post, url, referer);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        return await SendAsync(_client, request, cancellationToken).ConfigureAwait(false);
    }

    // The dev box runs a local HTTP proxy (127.0.0.1:7896) and the system proxy sent netease's
    // risk control into 8821; a desktop client connects directly. ZILUX2_ONLINE_PROXY is the
    // documented escape hatch and matches OnlineHttp's behavior.
    private static IWebProxy? ResolveProxy()
    {
        var value = Environment.GetEnvironmentVariable("ZILUX2_ONLINE_PROXY");
        return !string.IsNullOrWhiteSpace(value) && Uri.TryCreate(value, UriKind.Absolute, out var uri)
            ? new WebProxy(uri)
            : null;
    }

    private HttpClient CreateClient(bool allowAutoRedirect, IWebProxy? proxy)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = allowAutoRedirect,
            AutomaticDecompression = DecompressionMethods.None,
            UseCookies = true,
            CookieContainer = _cookies,
            ConnectTimeout = RequestTimeout,
            UseProxy = proxy is not null,
            Proxy = proxy,
        };
        return new HttpClient(handler) { Timeout = RequestTimeout };
    }

    private async Task<LoginHttpResponse> SendAsync(
        HttpClient client,
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_userAgent is not null)
        {
            request.Headers.UserAgent.Clear();
            request.Headers.TryAddWithoutValidation("User-Agent", _userAgent);
        }

        using var response = await client
            .SendAsync(request, HttpCompletionOption.ResponseContentRead, cancellationToken)
            .ConfigureAwait(false);
        var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
        var setCookies = response.Headers.TryGetValues("Set-Cookie", out var cookies)
            ? cookies.ToList()
            : null;
        var location = response.Headers.TryGetValues("Location", out var locations)
            ? locations.LastOrDefault()
            : null;
        return new LoginHttpResponse(
            (int)response.StatusCode,
            Encoding.UTF8.GetString(bytes),
            bytes,
            response.Content.Headers.ContentType?.ToString(),
            location,
            setCookies);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _client.Dispose();
        _noRedirectClient.Dispose();
    }
}

// Set-Cookie parsing shared by the QQ OAuth hops and the netease 803 response. Values may contain
// '=' (base64) and attributes appear in any order, so splitting on every ';' would corrupt them.
internal static class SetCookieParser
{
    public static Dictionary<string, string> ToDictionary(
        IReadOnlyList<string>? setCookies,
        out Dictionary<string, string> domains)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var domainMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (setCookies is not null)
        {
            foreach (var header in setCookies)
            {
                if (string.IsNullOrWhiteSpace(header))
                {
                    continue;
                }

                var attributes = header.Split(';');
                var separator = attributes[0].IndexOf('=');
                if (separator <= 0)
                {
                    continue;
                }

                var name = attributes[0][..separator].Trim();
                var value = attributes[0][(separator + 1)..].Trim();
                if (name.Length == 0)
                {
                    continue;
                }

                values[name] = value;
                for (var index = 1; index < attributes.Length; index++)
                {
                    var attribute = attributes[index].Trim();
                    if (attribute.StartsWith("Domain=", StringComparison.OrdinalIgnoreCase))
                    {
                        domainMap[name] = attribute["Domain=".Length..].Trim().TrimStart('.');
                        break;
                    }
                }
            }
        }

        domains = domainMap;
        return values;
    }

    public static Dictionary<string, string> FromCookieHeader(string? header)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(header))
        {
            return values;
        }

        foreach (var part in header.Split(';'))
        {
            var pair = part.Trim();
            var separator = pair.IndexOf('=');
            if (separator <= 0)
            {
                continue;
            }

            var name = pair[..separator].Trim();
            if (name.Length > 0)
            {
                values[name] = pair[(separator + 1)..].Trim();
            }
        }

        return values;
    }
}

internal static class CookieJar
{
    public static List<StoredCookie> Snapshot(CookieContainer container)
    {
        var cookies = new List<StoredCookie>();
        foreach (Cookie cookie in container.GetAllCookies())
        {
            if (!string.IsNullOrEmpty(cookie.Name))
            {
                cookies.Add(new StoredCookie(cookie.Domain, cookie.Name, cookie.Value));
            }
        }

        return cookies;
    }

    // Replays the subset of cookies that belongs to the request host. Domain matching follows
    // RFC 6265 closely enough for the handful of platforms involved here.
    public static string BuildHeader(IReadOnlyList<StoredCookie> cookies, string host)
    {
        var selected = new List<StoredCookie>();
        foreach (var cookie in cookies)
        {
            if (MatchesDomain(cookie.Domain, host))
            {
                selected.Add(cookie);
            }
        }

        if (selected.Count == 0)
        {
            return string.Empty;
        }

        // More specific domains first so that e.g. y.qq.com wins over .qq.com on duplicate names.
        selected.Sort((left, right) =>
            NormalizeDomain(right.Domain).Length.CompareTo(NormalizeDomain(left.Domain).Length));

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var builder = new StringBuilder();
        foreach (var cookie in selected)
        {
            if (!seen.Add(cookie.Name))
            {
                continue;
            }

            if (builder.Length > 0)
            {
                builder.Append("; ");
            }

            builder.Append(cookie.Name).Append('=').Append(cookie.Value);
        }

        return builder.ToString();
    }

    private static bool MatchesDomain(string cookieDomain, string host)
    {
        var domain = NormalizeDomain(cookieDomain);
        if (domain.Length == 0)
        {
            return false;
        }

        return host.Equals(domain, StringComparison.OrdinalIgnoreCase) ||
               host.EndsWith("." + domain, StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizeDomain(string domain) => domain.TrimStart('.');

    public static string Serialize(IReadOnlyList<StoredCookie> cookies) =>
        JsonSerializer.Serialize(cookies, AccountJsonContext.Default.ListStoredCookie);

    public static List<StoredCookie> Parse(string json)
    {
        try
        {
            return JsonSerializer.Deserialize(json, AccountJsonContext.Default.ListStoredCookie) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }
}

internal static class AvatarEncoding
{
    private const int MaxAvatarBytes = 512 * 1024;

    // The frontend wants a <img src>; keep downloads small so account.json/HTTP payloads stay sane.
    public static async Task<string?> ToDataUrlAsync(
        LoginHttpSession session,
        string? avatarUrl,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(avatarUrl))
        {
            return null;
        }

        try
        {
            var response = await session.GetBytesAsync(avatarUrl, null, cancellationToken).ConfigureAwait(false);
            if (response.Status is not (200 or 206) || response.Bytes.Length is 0 or > MaxAvatarBytes)
            {
                return null;
            }

            var contentType = string.IsNullOrEmpty(response.ContentType) ? "image/jpeg" : response.ContentType;
            return $"data:{contentType};base64,{Convert.ToBase64String(response.Bytes)}";
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            OnlineHttp.Warn($"account avatar fetch failed: {exception.GetType().Name}");
            return null;
        }
    }
}

[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(AccountInfo))]
[JsonSerializable(typeof(AccountListResponse))]
[JsonSerializable(typeof(LoginQrResponse))]
[JsonSerializable(typeof(LoginStatusResponse))]
[JsonSerializable(typeof(LogoutResponse))]
[JsonSerializable(typeof(AccountStoreDocument))]
[JsonSerializable(typeof(List<StoredCookie>))]
internal sealed partial class AccountJsonContext : JsonSerializerContext
{
}
