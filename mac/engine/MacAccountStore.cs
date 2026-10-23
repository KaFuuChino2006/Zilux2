// mac 版：由 src/Zilux2/Online/Account/AccountStore.cs 复制改写（mac/engine/tools/port_sources.py 生成）。
// 唯一差异：cookie 加密。Windows 上继续用 DPAPI(CurrentUser)（与原宿主完全一致，可复用已有登录态）；
// macOS 上没有 System.Security.Cryptography.ProtectedData（平台不支持），改用 AES-GCM + 用户级密钥文件。
// 其余持久化/降级逻辑与原文件逐行一致。
using System.IO;
using System.Runtime.CompilerServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Zilux2.Online.Account;

// Account v1 persistence (contract §3): <LocalApplicationData>/Zilux2/account.json.
// Windows: cookie values encrypted with DPAPI(CurrentUser); macOS: AES-GCM with a user-level key
// file. Any read/decrypt problem degrades to "logged out" instead of failing the host.
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

    // Windows: 与 Windows 宿主一致的 DPAPI(CurrentUser) base64 格式（无前缀）。
    // 其它平台: "aesgcm:" + base64(nonce[12] | tag[16] | ciphertext)，密钥在 HostFolders.Root/account.key。
    //
    // 关键点：ProtectedData 在 macOS 上运行时不支持（甚至可能不进 self-contained 产物），
    // 所以 DPAPI 调用必须放在 NoInlining 的独立方法里——只有 Windows 分支执行到时 JIT 才会去
    // 解析那个类型，避免 macOS 上启动即 FileNotFoundException。
    private const string AesGcmPrefix = "aesgcm:";
    private const int AesKeySize = 32;
    private const int AesNonceSize = 12;
    private const int AesTagSize = 16;
    private static readonly object AesKeyGate = new();
    private static readonly byte[] AesAssociatedData = Encoding.UTF8.GetBytes("Zilux2.AccountStore.v1");
    private static byte[]? _aesKey;

    private static string Protect(string plainText)
    {
        var plain = Encoding.UTF8.GetBytes(plainText);
        if (OperatingSystem.IsWindows())
        {
            return ProtectWithDpapi(plain);
        }

        return ProtectWithAesGcm(plain);
    }

    private static List<StoredCookie>? TryUnprotect(string protectedBase64)
    {
        try
        {
            byte[] plain;
            if (protectedBase64.StartsWith(AesGcmPrefix, StringComparison.Ordinal))
            {
                plain = UnprotectWithAesGcm(protectedBase64);
            }
            else
            {
                // Windows 宿主写入的 DPAPI 格式；在其它平台上解不开，按“未登录”降级。
                if (!OperatingSystem.IsWindows())
                {
                    return null;
                }

                plain = UnprotectWithDpapi(protectedBase64);
            }

            return CookieJar.Parse(Encoding.UTF8.GetString(plain));
        }
        catch (Exception exception) when (exception is CryptographicException or FormatException or ArgumentException or PlatformNotSupportedException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    [SupportedOSPlatform("windows")]
    private static string ProtectWithDpapi(byte[] plain)
    {
        var protectedBytes = ProtectedData.Protect(
            plain,
            optionalEntropy: null,
            DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(protectedBytes);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    [SupportedOSPlatform("windows")]
    private static byte[] UnprotectWithDpapi(string protectedBase64) =>
        ProtectedData.Unprotect(
            Convert.FromBase64String(protectedBase64),
            optionalEntropy: null,
            DataProtectionScope.CurrentUser);

    private static string ProtectWithAesGcm(byte[] plain)
    {
        var key = GetAesKey();
        var nonce = RandomNumberGenerator.GetBytes(AesNonceSize);
        var cipher = new byte[plain.Length];
        var tag = new byte[AesTagSize];
        using (var aes = new AesGcm(key, AesTagSize))
        {
            aes.Encrypt(nonce, plain, cipher, tag, AesAssociatedData);
        }

        var payload = new byte[nonce.Length + tag.Length + cipher.Length];
        Buffer.BlockCopy(nonce, 0, payload, 0, nonce.Length);
        Buffer.BlockCopy(tag, 0, payload, nonce.Length, tag.Length);
        Buffer.BlockCopy(cipher, 0, payload, nonce.Length + tag.Length, cipher.Length);
        return AesGcmPrefix + Convert.ToBase64String(payload);
    }

    private static byte[] UnprotectWithAesGcm(string protectedBase64)
    {
        var payload = Convert.FromBase64String(protectedBase64[AesGcmPrefix.Length..]);
        if (payload.Length < AesNonceSize + AesTagSize)
        {
            throw new FormatException("aesgcm payload too short");
        }

        var nonce = payload.AsSpan(0, AesNonceSize);
        var tag = payload.AsSpan(AesNonceSize, AesTagSize);
        var cipher = payload.AsSpan(AesNonceSize + AesTagSize);
        var plain = new byte[cipher.Length];
        using var aes = new AesGcm(GetAesKey(), AesTagSize);
        aes.Decrypt(nonce, cipher, tag, plain, AesAssociatedData);
        return plain;
    }

    private static byte[] GetAesKey()
    {
        lock (AesKeyGate)
        {
            if (_aesKey is not null)
            {
                return _aesKey;
            }

            var path = Path.Combine(HostFolders.Root, "account.key");
            try
            {
                if (File.Exists(path))
                {
                    var existing = Convert.FromBase64String(File.ReadAllText(path).Trim());
                    if (existing.Length == AesKeySize)
                    {
                        _aesKey = existing;
                        return existing;
                    }
                }

                Directory.CreateDirectory(HostFolders.Root);
                var key = RandomNumberGenerator.GetBytes(AesKeySize);
                File.WriteAllText(path, Convert.ToBase64String(key), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
                TryRestrictKeyPermissions(path);
                _aesKey = key;
                return key;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or FormatException or CryptographicException)
            {
                // 密钥文件不可用时退化为进程内临时密钥：本次启动能登录，重启后需要重新登录。
                OnlineHttp.Warn($"[account] key file unavailable path={path} err={exception.GetType().Name}; using process-local key");
                _aesKey = RandomNumberGenerator.GetBytes(AesKeySize);
                return _aesKey;
            }
        }
    }

    private static void TryRestrictKeyPermissions(string path)
    {
        try
        {
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or PlatformNotSupportedException)
        {
            // 收紧权限是 best effort，不影响功能。
            OnlineHttp.Warn($"[account] chmod key failed: {exception.GetType().Name}");
        }
    }
}
