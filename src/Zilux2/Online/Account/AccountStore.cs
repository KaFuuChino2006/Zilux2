using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Zilux2.Online.Account;

// Account v1 persistence (contract §3): %LOCALAPPDATA%\Zilux2\account.json, cookie values
// encrypted with DPAPI(CurrentUser). Any read/decrypt problem degrades to "logged out" instead
// of failing the host.
internal sealed class AccountStore : IDisposable
{
    // Same escape hatch style as the other services: lets scripts point at a throwaway profile.
    private const string PathOverrideVariable = "ZILUX2_ACCOUNT_PATH";
    private const int DocumentVersion = 1;

    private readonly string _path;
    private readonly object _gate = new();
    private Dictionary<string, StoredAccount> _accounts = new(StringComparer.Ordinal);
    private bool _dirty;
    private bool _disposed;

    public AccountStore(string? pathOverride = null)
    {
        var configured = pathOverride ?? Environment.GetEnvironmentVariable(PathOverrideVariable);
        _path = Path.GetFullPath(
            string.IsNullOrWhiteSpace(configured)
                ? Path.Combine(HostFolders.Root, "account.json")
                : configured);
    }

    public string FilePath => _path;

    public void Load()
    {
        lock (_gate)
        {
            _accounts = new Dictionary<string, StoredAccount>(StringComparer.Ordinal);
            _dirty = false;

            if (!File.Exists(_path))
            {
                OnlineHttp.Info($"[account] load path={_path} entries=0 (file missing)");
                return;
            }

            try
            {
                var json = File.ReadAllText(_path, Encoding.UTF8);
                var document = JsonSerializer.Deserialize(json, AccountJsonContext.Default.AccountStoreDocument);
                if (document is null || document.Version != DocumentVersion)
                {
                    OnlineHttp.Warn($"[account] load failed path={_path} err=unsupported document");
                    RemoveCorruptFile();
                    return;
                }

                foreach (var pair in document.Accounts)
                {
                    if (!AccountSources.IsKnown(pair.Key))
                    {
                        continue;
                    }

                    var cookies = TryUnprotect(pair.Value.Cookie);
                    if (cookies is null || cookies.Count == 0)
                    {
                        // Keep the rest of the document; only this source is logged out.
                        OnlineHttp.Warn($"[account] load failed path={_path} source={pair.Key} err=cookie decrypt");
                        _dirty = true;
                        continue;
                    }

                    _accounts[pair.Key] = pair.Value;
                }

                OnlineHttp.Info($"[account] load path={_path} entries={_accounts.Count}");
                if (_dirty)
                {
                    SaveLocked();
                }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
            {
                OnlineHttp.Warn($"[account] load failed path={_path} err={exception.GetType().Name}: {exception.Message}");
                RemoveCorruptFile();
            }
        }
    }

    public AccountInfo? GetAccountInfo(string source)
    {
        lock (_gate)
        {
            if (!_accounts.TryGetValue(source, out var stored))
            {
                return null;
            }

            return new AccountInfo
            {
                Source = source,
                LoggedIn = true,
                Nickname = stored.Nickname,
                AvatarDataUrl = stored.AvatarDataUrl,
                Vip = stored.Vip,
                UserId = stored.UserId,
            };
        }
    }

    public string? GetUserId(string source)
    {
        lock (_gate)
        {
            return _accounts.TryGetValue(source, out var stored) ? stored.UserId : null;
        }
    }

    public string CookieHeader(string source, string host)
    {
        lock (_gate)
        {
            if (!_accounts.TryGetValue(source, out var stored))
            {
                return string.Empty;
            }

            var cookies = TryUnprotect(stored.Cookie);
            return cookies is null ? string.Empty : CookieJar.BuildHeader(cookies, host);
        }
    }

    // Profile refresh (nickname / avatar / vip) reuses the persisted cookie list: a stale or
    // expired login simply yields null and keeps the previous stored profile.
    public IReadOnlyList<StoredCookie>? GetCookies(string source)
    {
        lock (_gate)
        {
            return _accounts.TryGetValue(source, out var stored) ? TryUnprotect(stored.Cookie) : null;
        }
    }

    public void UpdateProfile(string source, AccountInfo info)
    {
        lock (_gate)
        {
            if (!_accounts.TryGetValue(source, out var stored))
            {
                return;
            }

            _accounts[source] = stored with
            {
                Nickname = info.Nickname,
                AvatarDataUrl = info.AvatarDataUrl,
                Vip = info.Vip,
                UserId = info.UserId,
                UpdatedAt = DateTimeOffset.UtcNow.ToString("O"),
            };
            _dirty = true;
            OnlineHttp.Info($"[account] profile refreshed source={source} nickname={info.Nickname ?? "-"} vip={info.Vip?.ToString() ?? "unknown"}");
            SaveLocked();
        }
    }

    public void SaveLogin(string source, AccountInfo info, System.Net.CookieContainer container) =>
        SaveLogin(source, info, CookieJar.Snapshot(container));

    // Cookie paste import revalidates a raw Cookie header, so it never has a live CookieContainer;
    // persisting the parsed list keeps the exact same DPAPI-protected storage path.
    public void SaveLogin(string source, AccountInfo info, IReadOnlyList<StoredCookie> cookies)
    {
        if (cookies.Count == 0)
        {
            throw new AccountException("upstream-failed", "登录成功但平台没有返回凭据，请重试");
        }

        lock (_gate)
        {
            _accounts[source] = new StoredAccount
            {
                Nickname = info.Nickname,
                AvatarDataUrl = info.AvatarDataUrl,
                Vip = info.Vip,
                UserId = info.UserId,
                Cookie = Protect(CookieJar.Serialize(cookies)),
                UpdatedAt = DateTimeOffset.UtcNow.ToString("O"),
            };
            _dirty = true;
            OnlineHttp.Info($"[account] login source={source} nickname={info.Nickname ?? "-"} vip={info.Vip?.ToString() ?? "unknown"}");
            SaveLocked();
        }
    }

    public bool Remove(string source)
    {
        lock (_gate)
        {
            var removed = _accounts.Remove(source);
            if (removed)
            {
                _dirty = true;
                OnlineHttp.Info($"[account] logout source={source}");
            }

            SaveLocked();
            return removed;
        }
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
            SaveLocked();
        }
    }

    private void SaveLocked()
    {
        if (!_dirty)
        {
            return;
        }

        try
        {
            var document = new AccountStoreDocument
            {
                Accounts = new Dictionary<string, StoredAccount>(_accounts, StringComparer.Ordinal),
            };
            var json = JsonSerializer.Serialize(document, AccountJsonContext.Default.AccountStoreDocument);
            var directory = Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var tempPath = _path + ".tmp";
            File.WriteAllText(tempPath, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            if (File.Exists(_path))
            {
                File.Replace(tempPath, _path, null);
            }
            else
            {
                File.Move(tempPath, _path);
            }

            _dirty = false;
            OnlineHttp.Info($"[account] save path={_path} entries={_accounts.Count}");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            OnlineHttp.Error($"[account] save failed path={_path}", exception);
        }
    }

    private void RemoveCorruptFile()
    {
        try
        {
            if (File.Exists(_path))
            {
                File.Delete(_path);
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            OnlineHttp.Warn($"[account] corrupt file delete failed: {exception.Message}");
        }

        _accounts.Clear();
        _dirty = false;
    }

    private static string Protect(string plainText)
    {
        var protectedBytes = ProtectedData.Protect(
            Encoding.UTF8.GetBytes(plainText),
            optionalEntropy: null,
            DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(protectedBytes);
    }

    private static List<StoredCookie>? TryUnprotect(string protectedBase64)
    {
        try
        {
            var plain = ProtectedData.Unprotect(
                Convert.FromBase64String(protectedBase64),
                optionalEntropy: null,
                DataProtectionScope.CurrentUser);
            return CookieJar.Parse(Encoding.UTF8.GetString(plain));
        }
        catch (Exception exception) when (exception is CryptographicException or FormatException or ArgumentException)
        {
            return null;
        }
    }
}
