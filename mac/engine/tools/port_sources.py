#!/usr/bin/env python3
"""Generate the two rewritten mac sources from the read-only Windows sources.

This script is the audit trail for mac/engine/MacLocalMusicServer.cs and
mac/engine/MacAccountStore.cs: it copies the original file verbatim and applies a
small, asserted set of textual edits (every marker must match exactly once), so the
port can be reviewed and regenerated after upstream changes.

Usage:  python mac/engine/tools/port_sources.py
"""

from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SRC_ONLINE = REPO / "src" / "Zilux2" / "Online"
OUT_DIR = REPO / "mac" / "engine"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"[{label}] expected exactly 1 occurrence, found {count}")
    return text.replace(old, new, 1)


def cut_block(text: str, start_marker: str, end_marker: str, replacement: str, label: str) -> str:
    start = text.find(start_marker)
    end = text.find(end_marker)
    if start < 0:
        raise SystemExit(f"[{label}] start marker not found")
    if end < 0 or end <= start:
        raise SystemExit(f"[{label}] end marker not found or before start")
    return text[:start] + replacement + text[end:]


def insert_before(text: str, marker: str, snippet: str, label: str) -> str:
    count = text.count(marker)
    if count != 1:
        raise SystemExit(f"[{label}] expected exactly 1 marker occurrence, found {count}")
    index = text.index(marker)
    return text[:index] + snippet + text[index:]


# ---------------------------------------------------------------------------
# MacLocalMusicServer.cs  (from src/Zilux2/Online/LocalMusicServer.cs)
# ---------------------------------------------------------------------------

STATIC_SERVICE = r'''    // ---- mac 版新增：web 前端静态文件服务（非 /api/ 路由） ----
    // 由 Program 在 new OnlineMusicService() 之前设置；为空时所有非 API 请求返回 404 纯文本。
    public static string? WebRoot { get; set; }

    private static readonly IReadOnlyDictionary<string, string> StaticContentTypes =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [".html"] = "text/html; charset=utf-8",
            [".htm"] = "text/html; charset=utf-8",
            [".js"] = "text/javascript; charset=utf-8",
            [".mjs"] = "text/javascript; charset=utf-8",
            [".css"] = "text/css; charset=utf-8",
            [".json"] = "application/json; charset=utf-8",
            [".map"] = "application/json; charset=utf-8",
            [".ttf"] = "font/ttf",
            [".otf"] = "font/otf",
            [".woff"] = "font/woff",
            [".woff2"] = "font/woff2",
            [".png"] = "image/png",
            [".jpg"] = "image/jpeg",
            [".jpeg"] = "image/jpeg",
            [".webp"] = "image/webp",
            [".svg"] = "image/svg+xml",
            [".ico"] = "image/x-icon",
            [".txt"] = "text/plain; charset=utf-8",
        };

    private async Task<int> HandleStaticAsync(HttpListenerContext context)
    {
        var request = context.Request;
        var response = context.Response;
        var method = request.HttpMethod;
        var isHead = string.Equals(method, "HEAD", StringComparison.OrdinalIgnoreCase);
        if (!isHead && !string.Equals(method, "GET", StringComparison.OrdinalIgnoreCase))
        {
            return WritePlainText(context, 405, "method not allowed");
        }

        var root = WebRoot;
        if (string.IsNullOrWhiteSpace(root))
        {
            return WritePlainText(context, 404, "web root not configured");
        }

        string decoded;
        try
        {
            decoded = Uri.UnescapeDataString(request.Url?.AbsolutePath ?? "/");
        }
        catch (UriFormatException)
        {
            return WritePlainText(context, 400, "bad path");
        }

        if (decoded.Contains('\0'))
        {
            return WritePlainText(context, 400, "bad path");
        }

        if (decoded.Length == 0 || decoded == "/")
        {
            decoded = "/index.html";
        }

        string rootPath;
        string fullPath;
        try
        {
            rootPath = Path.GetFullPath(root);
            fullPath = Path.GetFullPath(Path.Combine(rootPath, decoded.TrimStart('/').Replace('/', Path.DirectorySeparatorChar)));
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return WritePlainText(context, 400, "bad path");
        }

        // 路径穿越防护：解码 + 归一化之后，目标仍必须位于 web-root 之内。
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var rootPrefix = rootPath.EndsWith(Path.DirectorySeparatorChar)
            ? rootPath
            : rootPath + Path.DirectorySeparatorChar;
        if (!fullPath.StartsWith(rootPrefix, comparison) &&
            !string.Equals(fullPath, rootPath, comparison))
        {
            OnlineHttp.Warn($"[static] reject traversal path={Describe(decoded)}");
            return WritePlainText(context, 404, "not found");
        }

        if (Directory.Exists(fullPath))
        {
            // 目录请求回落到目录里的 index.html。
            fullPath = Path.Combine(fullPath, "index.html");
        }

        if (!File.Exists(fullPath))
        {
            return WritePlainText(context, 404, "not found");
        }

        byte[] bytes;
        try
        {
            bytes = await File.ReadAllBytesAsync(fullPath, _shutdown.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
            return 499;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            OnlineHttp.Warn($"[static] read failed path={Describe(decoded)} err={exception.GetType().Name}");
            return WritePlainText(context, 500, "read failed");
        }

        var extension = Path.GetExtension(fullPath).ToLowerInvariant();
        response.StatusCode = 200;
        response.ContentType = StaticContentTypes.TryGetValue(extension, out var contentType)
            ? contentType
            : "application/octet-stream";
        // 前端文件经常在开发/联调时被替换，HTML/JS 一律 no-store，其它资源给短缓存。
        response.Headers["Cache-Control"] = extension is ".html" or ".js" or ".mjs"
            ? "no-store"
            : "public, max-age=3600";
        response.ContentLength64 = bytes.Length;
        if (isHead)
        {
            return 200;
        }

        response.OutputStream.Write(bytes, 0, bytes.Length);
        return 200;
    }

    private static int WritePlainText(HttpListenerContext context, int status, string text)
    {
        var response = context.Response;
        var bytes = Encoding.UTF8.GetBytes(text + "\n");
        response.StatusCode = status;
        response.ContentType = "text/plain; charset=utf-8";
        response.Headers["Cache-Control"] = "no-store";
        response.ContentLength64 = bytes.Length;
        if (!string.Equals(context.Request.HttpMethod, "HEAD", StringComparison.OrdinalIgnoreCase))
        {
            response.OutputStream.Write(bytes, 0, bytes.Length);
        }

        return status;
    }

'''

COVER_COLORS = r'''    // mac 版：不引入 WPF 位图解码（System.Windows.Media.Imaging 只存在于 Windows 桌面框架）。
    // 前端 coverColorsOf 在拿不到主色时会用 fallbackColors 兜底，所以这里固定返回空结果，
    // 保持 HTTP 契约不变（200 + dominant/palette 字段）。
    private int HandleCoverColorsAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim().ToLowerInvariant();
        var key = NormalizeCoverKey((query["key"] ?? string.Empty).Trim());
        OnlineHttp.Info($"[cover-color] mac engine returns empty colors source={source} key={Describe(key)}");
        WriteJson(context, 200, "{\"dominant\":null,\"palette\":[]}");
        return 200;
    }

'''

FILE_HEADER = (
    "// mac 版：由 src/Zilux2/Online/LocalMusicServer.cs 复制改写（mac/engine/tools/port_sources.py 生成）。\n"
    "// 与 Windows 版的差异只有两处：\n"
    "//   1. /api/cover/colors 不再依赖 WPF 位图解码，固定返回 200 空结果（前端 fallbackColors 兜底）；\n"
    "//   2. 非 /api/ 的 GET/HEAD 请求从 --web-root 目录提供前端静态文件。\n"
    "// 其余 /api/* 路由与行为保持原样。\n"
)


def build_local_music_server() -> None:
    text = (SRC_ONLINE / "LocalMusicServer.cs").read_text(encoding="utf-8")

    text = replace_once(
        text,
        "using System.Windows.Media;\nusing System.Windows.Media.Imaging;\n",
        "",
        "drop-wpf-usings",
    )

    text = replace_once(
        text,
        '                "/api/cover/colors" => isGet ? await HandleCoverColorsAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),\n',
        '                "/api/cover/colors" => isGet ? HandleCoverColorsAsync(context) : MethodNotAllowed(context),\n',
        "cover-colors-dispatch",
    )

    text = replace_once(
        text,
        "            var isGet = string.Equals(method, \"GET\", StringComparison.OrdinalIgnoreCase);\n"
        "            var isPost = string.Equals(method, \"POST\", StringComparison.OrdinalIgnoreCase);\n"
        "            if (!isGet && !isPost)\n",
        "            var isGet = string.Equals(method, \"GET\", StringComparison.OrdinalIgnoreCase);\n"
        "            var isPost = string.Equals(method, \"POST\", StringComparison.OrdinalIgnoreCase);\n"
        "            var isHead = string.Equals(method, \"HEAD\", StringComparison.OrdinalIgnoreCase);\n"
        "            // HEAD 只给静态资源用；HttpListener 不允许 HEAD 响应写 body，/api/* 的 HEAD 直接回 405。\n"
        "            if (isHead && path.StartsWith(\"/api/\", StringComparison.Ordinal))\n"
        "            {\n"
        "                status = 405;\n"
        "                context.Response.StatusCode = 405;\n"
        "                return;\n"
        "            }\n"
        "\n"
        "            if (!isGet && !isPost && !isHead)\n",
        "allow-head",
    )

    text = replace_once(
        text,
        '                _ => WriteError(context, 404, "not-found", "未知接口"),\n',
        '                _ when !path.StartsWith("/api/", StringComparison.Ordinal) => await HandleStaticAsync(context).ConfigureAwait(false),\n'
        '                _ => WriteError(context, 404, "not-found", "未知接口"),\n',
        "static-dispatch",
    )

    text = cut_block(
        text,
        "    /// <summary>封面主色",
        "    private static bool TryResolveCoverUpstream(",
        COVER_COLORS,
        "cover-colors-body",
    )

    text = cut_block(
        text,
        "    private static bool TryResolveCoverUpstream(",
        "    private sealed record CoverCacheEntry",
        "",
        "drop-cover-color-helpers",
    )

    text = replace_once(
        text,
        "    public int Port { get; private set; }\n\n",
        "    public int Port { get; private set; }\n\n"
        "    // mac 版新增：web 前端静态文件根目录（见下方静态文件服务）。\n"
        "    // 由 Program 在启动服务前设置，避免改动构造签名（OnlineMusicService 仍按原签名 new）。\n",
        "webroot-property",
    )

    text = insert_before(
        text,
        "    private int WriteHealth(HttpListenerContext context)",
        STATIC_SERVICE,
        "insert-static-service",
    )

    (OUT_DIR / "MacLocalMusicServer.cs").write_text(FILE_HEADER + text, encoding="utf-8")
    print(f"wrote {OUT_DIR / 'MacLocalMusicServer.cs'} ({len(text.splitlines())} lines)")


# ---------------------------------------------------------------------------
# MacAccountStore.cs  (from src/Zilux2/Online/Account/AccountStore.cs)
# ---------------------------------------------------------------------------

ACCOUNT_STORE_HEADER = (
    "// mac 版：由 src/Zilux2/Online/Account/AccountStore.cs 复制改写（mac/engine/tools/port_sources.py 生成）。\n"
    "// 唯一差异：cookie 加密。Windows 上继续用 DPAPI(CurrentUser)（与原宿主完全一致，可复用已有登录态）；\n"
    "// macOS 上没有 System.Security.Cryptography.ProtectedData（平台不支持），改用 AES-GCM + 用户级密钥文件。\n"
    "// 其余持久化/降级逻辑与原文件逐行一致。\n"
)

ACCOUNT_STORE_PROTECTION = r'''    // Windows: 与 Windows 宿主一致的 DPAPI(CurrentUser) base64 格式（无前缀）。
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
'''


def build_account_store() -> None:
    text = (SRC_ONLINE / "Account" / "AccountStore.cs").read_text(encoding="utf-8")

    text = replace_once(
        text,
        "// Account v1 persistence (contract §3): %LOCALAPPDATA%\\Zilux2\\account.json, cookie values\n"
        "// encrypted with DPAPI(CurrentUser). Any read/decrypt problem degrades to \"logged out\" instead\n"
        "// of failing the host.\n",
        "// Account v1 persistence (contract §3): <LocalApplicationData>/Zilux2/account.json.\n"
        "// Windows: cookie values encrypted with DPAPI(CurrentUser); macOS: AES-GCM with a user-level key\n"
        "// file. Any read/decrypt problem degrades to \"logged out\" instead of failing the host.\n",
        "accountstore-doc",
    )

    text = replace_once(
        text,
        "using System.IO;\nusing System.Security.Cryptography;",
        "using System.IO;\nusing System.Runtime.CompilerServices;\nusing System.Runtime.Versioning;\nusing System.Security.Cryptography;",
        "accountstore-usings",
    )

    start = text.find("    private static string Protect(string plainText)")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise SystemExit("[accountstore-protection] markers not found")
    text = text[:start] + ACCOUNT_STORE_PROTECTION + text[end:]

    (OUT_DIR / "MacAccountStore.cs").write_text(ACCOUNT_STORE_HEADER + text, encoding="utf-8")
    print(f"wrote {OUT_DIR / 'MacAccountStore.cs'} ({len(text.splitlines())} lines)")


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    build_local_music_server()
    build_account_store()
