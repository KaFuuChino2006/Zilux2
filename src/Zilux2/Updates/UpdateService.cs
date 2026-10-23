using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using Zilux2.Settings;

namespace Zilux2.Updates;

// 自动更新通道（docs/zilux2-update-channel.md）。
//
// 页面 -> 宿主：{v:1,type:"update",action:"check"|"download"|"install"|"cancel"|"openReleasePage"}
// 宿主 -> 页面：{v:1,type:"host",event:"update",state:...}  (UpdateHostMessage)
//
// 所有状态变更都在 UI 线程之外完成，快照通过构造时传入的 postJson 回调送出；
// WebViewHost 负责把它调度回 UI 线程。安装 = 静默安装器 + 安装完成后自动启动新版本，
// 宿主在安装器启动后退出（安装器自己会先结束残留的 Zilux2 进程）。
internal sealed class UpdateService : IDisposable
{
    internal const string StateIdle = "idle";
    internal const string StateChecking = "checking";
    internal const string StateUpToDate = "up-to-date";
    internal const string StateAvailable = "available";
    internal const string StateDownloading = "downloading";
    internal const string StateDownloaded = "downloaded";
    internal const string StateInstalling = "installing";
    internal const string StateError = "error";
    internal const string StateUnavailable = "unavailable";

    private const string DefaultApiBase = "https://api.github.com";
    private const string RepoEnvironmentVariable = "ZILUX2_UPDATE_REPO";
    private const string ApiBaseEnvironmentVariable = "ZILUX2_UPDATE_API";
    private const string InstallDirEnvironmentVariable = "ZILUX2_UPDATE_INSTALL_DIR";
    private const string UninstallRegistryKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Zilux2";
    private const string SetupAssetPrefix = "Zilux2-Setup-";
    private static readonly TimeSpan AutoCheckDelay = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan AutoCheckPeriod = TimeSpan.FromHours(4);
    private static readonly TimeSpan ManualCheckThrottle = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan ApiTimeout = TimeSpan.FromSeconds(30);

    private readonly object _gate = new();
    private readonly SettingsService _settings;
    private readonly Action<string> _postJson;
    private readonly Action _requestExit;
    private readonly string _buildRepo;
    private readonly HttpClient _http;
    private Timer? _autoTimer;
    private CancellationTokenSource? _downloadCts;
    private bool _disposed;
    private bool _busy;
    private bool _installAfterDownload;
    private string _state = StateIdle;
    private string? _latestVersion;
    private string? _releaseName;
    private string? _notes;
    private string? _pageUrl;
    private string? _assetName;
    private string? _assetUrl;
    private string? _assetDigest;
    private long _assetSize;
    private long _downloaded;
    private long _total;
    private string? _setupPath;
    private string? _error;
    private string? _notice;
    private string? _repo;
    private DateTimeOffset? _checkedAt;
    private DateTimeOffset _lastCheckUtc;

    internal UpdateService(SettingsService settings, Action<string> postJson, Action requestExit)
    {
        _settings = settings;
        _postJson = postJson;
        _requestExit = requestExit;
        _buildRepo = HostInfo.UpdateRepo;
        _http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd($"Zilux2-Updater/{HostInfo.Version}");
        _http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
    }

    /// <summary>页面 ready 后推送一次当前状态，并启动自动检查定时器。</summary>
    internal void Start()
    {
        Post();
        lock (_gate)
        {
            _autoTimer ??= new Timer(_ => AutoTick(), null, AutoCheckDelay, AutoCheckPeriod);
        }
    }

    internal void PostSnapshot() => Post();

    internal void Handle(JsonElement root)
    {
        var action = ReadString(root, "action");
        switch (action)
        {
            case "check":
                BeginCheck(force: ReadBool(root, "force"), auto: false);
                break;

            case "download":
                RequestDownload(thenInstall: false);
                break;

            case "install":
                RequestInstall();
                break;

            case "cancel":
                CancelDownload();
                break;

            case "openReleasePage":
                OpenReleasePage();
                break;

            default:
                HostLog.Info($"[update] ignored action={action ?? "<missing>"}");
                break;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
        }

        _autoTimer?.Dispose();
        _autoTimer = null;
        lock (_gate)
        {
            _downloadCts?.Cancel();
        }

        _http.Dispose();
        HostLog.Info("[update] disposed");
    }

    private void AutoTick()
    {
        try
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }
            }

            if (!_settings.UpdateAutoCheck)
            {
                return;
            }

            BeginCheck(force: false, auto: true);
        }
        catch (Exception exception)
        {
            HostLog.Error("[update] auto check failed", exception);
        }
    }

    // ---------------- 检查更新 ----------------

    private void BeginCheck(bool force, bool auto)
    {
        lock (_gate)
        {
            if (_disposed || _busy)
            {
                return;
            }

            if (!force && _lastCheckUtc != default &&
                DateTimeOffset.UtcNow - _lastCheckUtc < ManualCheckThrottle)
            {
                return;
            }

            _busy = true;
            _state = StateChecking;
            _error = null;
            _notice = null;
        }

        Post();
        _ = Task.Run(() => CheckWorkerAsync(auto));
    }

    private async Task CheckWorkerAsync(bool auto)
    {
        try
        {
            var repo = ResolveRepo();
            lock (_gate)
            {
                _repo = repo;
            }

            if (string.IsNullOrWhiteSpace(repo) || repo.IndexOf('/') <= 0)
            {
                SetUnavailable("未配置更新仓库：构建时没有设置 ZiluxUpdateRepo，可在设置里填写 GitHub 仓库（owner/name）。");
                return;
            }

            var apiBase = ResolveApiBase();
            var url = $"{apiBase}/repos/{repo}/releases/latest";
            HostLog.Info($"[update] check repo={repo} url={url}");

            using var timeout = new CancellationTokenSource(ApiTimeout);
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            using var response = await _http
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token)
                .ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                var status = (int)response.StatusCode;
                if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
                {
                    SetUnavailable("未找到可用版本：仓库不存在、未公开，或还没发布 Release（应用内更新需要公开仓库）。");
                }
                else if (response.StatusCode == System.Net.HttpStatusCode.Forbidden ||
                         response.StatusCode == (System.Net.HttpStatusCode)429)
                {
                    SetUnavailable("GitHub API 频率限制，请稍后再试。");
                }
                else
                {
                    SetError($"检查更新失败：GitHub 返回 HTTP {status.ToString(CultureInfo.InvariantCulture)}");
                }

                return;
            }

            var body = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
            ParseRelease(body);
        }
        catch (OperationCanceledException)
        {
            SetError("检查更新超时（网络无法连接 GitHub）。");
        }
        catch (HttpRequestException exception)
        {
            SetError($"检查更新失败：{exception.Message}");
        }
        catch (Exception exception)
        {
            HostLog.Error("[update] check failed", exception);
            SetError($"检查更新失败：{exception.GetType().Name}: {exception.Message}");
        }
    }

    private void ParseRelease(string body)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            var tag = ReadString(root, "tag_name");
            var latest = NormalizeVersion(tag);
            if (latest is null)
            {
                SetError($"无法解析 Release 版本号：{tag ?? "<missing>"}");
                return;
            }

            var notes = ReadString(root, "body") ?? string.Empty;
            if (notes.Length > 8000)
            {
                notes = notes[..8000] + "\n…";
            }

            var pageUrl = ReadString(root, "html_url");
            var releaseName = ReadString(root, "name");
            if (string.IsNullOrWhiteSpace(releaseName))
            {
                releaseName = $"Zilux2 {latest}";
            }

            var current = HostInfo.Version;
            var comparison = CompareVersions(latest, current);
            if (comparison <= 0)
            {
                lock (_gate)
                {
                    _latestVersion = latest;
                    _releaseName = releaseName;
                    _notes = notes;
                    _pageUrl = pageUrl;
                    _state = StateUpToDate;
                    _busy = false;
                    _lastCheckUtc = DateTimeOffset.UtcNow;
                    _checkedAt = _lastCheckUtc;
                    _error = null;
                    _notice = null;
                }

                HostLog.Info($"[update] up-to-date current={current} latest={latest}");
                Post();
                return;
            }

            SelectAsset(root, latest, out var assetName, out var assetUrl, out var assetSize, out var digest);

            lock (_gate)
            {
                _latestVersion = latest;
                _releaseName = releaseName;
                _notes = notes;
                _pageUrl = pageUrl;
                _assetName = assetName;
                _assetUrl = assetUrl;
                _assetSize = assetSize;
                _assetDigest = digest;
                _state = StateAvailable;
                _busy = false;
                _lastCheckUtc = DateTimeOffset.UtcNow;
                _checkedAt = _lastCheckUtc;
                _error = null;
                _notice = assetUrl is null ? "这个版本没有找到可自动安装的安装包，请打开下载页手动下载。" : null;
            }

            HostLog.Info($"[update] available current={current} latest={latest} asset={assetName ?? "<none>"} size={assetSize.ToString(CultureInfo.InvariantCulture)}");
            Post();

            // auto 模式：发现新版本后直接在后台下载（notify 模式只提示）。
            if (_settings.UpdateMode == UpdateSettings.ModeAuto && assetUrl is not null)
            {
                RequestDownload(thenInstall: false);
            }
            else if (assetUrl is null)
            {
                // 没有安装包资产时保持 available，由页面展示「打开下载页」。
            }
        }
        catch (JsonException exception)
        {
            SetError($"Release 数据解析失败：{exception.Message}");
        }
    }

    private static void SelectAsset(
        JsonElement root,
        string latest,
        out string? name,
        out string? url,
        out long size,
        out string? digest)
    {
        name = null;
        url = null;
        size = 0;
        digest = null;

        if (!root.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        var preferred = $"{SetupAssetPrefix}{latest}.exe";
        foreach (var asset in assets.EnumerateArray())
        {
            if (asset.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var assetName = ReadString(asset, "name");
            if (string.IsNullOrWhiteSpace(assetName) ||
                !assetName.StartsWith(SetupAssetPrefix, StringComparison.OrdinalIgnoreCase) ||
                !assetName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var exact = string.Equals(assetName, preferred, StringComparison.OrdinalIgnoreCase);
            if (name is not null && !exact)
            {
                continue;
            }

            name = assetName;
            url = ReadString(asset, "browser_download_url");
            if (asset.TryGetProperty("size", out var sizeElement) && sizeElement.ValueKind == JsonValueKind.Number)
            {
                sizeElement.TryGetInt64(out size);
            }

            digest = ReadString(asset, "digest");
            if (exact)
            {
                break;
            }
        }
    }

    // ---------------- 下载 ----------------

    private void RequestDownload(bool thenInstall)
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            if (_busy)
            {
                if (_state == StateDownloading && thenInstall)
                {
                    _installAfterDownload = true;
                }

                return;
            }

            if (string.IsNullOrEmpty(_assetUrl) || string.IsNullOrEmpty(_assetName))
            {
                return;
            }

            _busy = true;
            _state = StateDownloading;
            _installAfterDownload = thenInstall;
            _downloaded = 0;
            _total = _assetSize;
            _error = null;
            _notice = null;
        }

        Post();
        _ = Task.Run(DownloadWorkerAsync);
    }

    private async Task DownloadWorkerAsync()
    {
        var cts = new CancellationTokenSource();
        lock (_gate)
        {
            _downloadCts = cts;
        }

        var partPath = string.Empty;
        try
        {
            string assetName;
            string assetUrl;
            string? digest;
            long expectedSize;
            lock (_gate)
            {
                assetName = _assetName ?? throw new InvalidOperationException("missing asset name");
                assetUrl = _assetUrl ?? throw new InvalidOperationException("missing asset url");
                digest = _assetDigest;
                expectedSize = _assetSize;
            }

            var directory = Path.Combine(HostFolders.Root, "updates");
            Directory.CreateDirectory(directory);
            var targetPath = Path.Combine(directory, assetName);
            partPath = targetPath + ".part";

            // 上次已经下完的安装包直接复用（校验大小/哈希）。
            if (File.Exists(targetPath) && await VerifyFileAsync(targetPath, expectedSize, digest, cts.Token).ConfigureAwait(false))
            {
                HostLog.Info($"[update] download reused path={targetPath}");
                CompleteDownload(targetPath);
                return;
            }

            HostLog.Info($"[update] download start url={assetUrl} target={targetPath}");
            using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(30));
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cts.Token, timeout.Token);
            using var response = await _http
                .GetAsync(assetUrl, HttpCompletionOption.ResponseHeadersRead, linked.Token)
                .ConfigureAwait(false);
            response.EnsureSuccessStatusCode();

            long total = expectedSize;
            if (response.Content.Headers.ContentLength is long contentLength && contentLength > 0)
            {
                total = contentLength;
            }

            lock (_gate)
            {
                _total = total;
            }

            Post();

            long done = 0;
            var lastPost = Environment.TickCount64;
            var buffer = new byte[81920];
            await using (var input = await response.Content.ReadAsStreamAsync(linked.Token).ConfigureAwait(false))
            await using (var output = new FileStream(partPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true))
            {
                while (true)
                {
                    var read = await input.ReadAsync(buffer.AsMemory(0, buffer.Length), linked.Token).ConfigureAwait(false);
                    if (read <= 0)
                    {
                        break;
                    }

                    await output.WriteAsync(buffer.AsMemory(0, read), linked.Token).ConfigureAwait(false);
                    done += read;
                    lock (_gate)
                    {
                        _downloaded = done;
                    }

                    if (Environment.TickCount64 - lastPost >= 250)
                    {
                        lastPost = Environment.TickCount64;
                        Post();
                    }
                }

                await output.FlushAsync(linked.Token).ConfigureAwait(false);
            }

            if (expectedSize > 0 && done != expectedSize)
            {
                throw new InvalidDataException($"安装包大小不符（期望 {expectedSize}，实际 {done}）");
            }

            if (!await VerifyFileAsync(partPath, expectedSize, digest, cts.Token).ConfigureAwait(false))
            {
                throw new InvalidDataException("安装包 SHA-256 校验失败");
            }

            File.Move(partPath, targetPath, overwrite: true);
            CompleteDownload(targetPath);
        }
        catch (OperationCanceledException)
        {
            TryDelete(partPath);
            lock (_gate)
            {
                _busy = false;
                _downloaded = 0;
                _installAfterDownload = false;
                if (!string.IsNullOrEmpty(_assetUrl))
                {
                    _state = StateAvailable;
                    _notice = "已取消下载。";
                }
                else
                {
                    _state = StateIdle;
                }

                _error = null;
            }

            HostLog.Info("[update] download cancelled");
            Post();
        }
        catch (Exception exception)
        {
            TryDelete(partPath);
            HostLog.Error("[update] download failed", exception);
            lock (_gate)
            {
                _busy = false;
                _state = StateError;
                _error = $"下载更新失败：{exception.Message}";
                _downloaded = 0;
            }

            Post();
        }
        finally
        {
            lock (_gate)
            {
                if (ReferenceEquals(_downloadCts, cts))
                {
                    _downloadCts = null;
                }
            }

            cts.Dispose();
        }
    }

    private void CompleteDownload(string path)
    {
        bool installNow;
        lock (_gate)
        {
            _setupPath = path;
            long size;
            try
            {
                size = new FileInfo(path).Length;
            }
            catch (Exception)
            {
                size = _assetSize;
            }

            _downloaded = size;
            _total = size;
            _state = StateDownloaded;
            _busy = false;
            _error = null;
            _notice = null;
            installNow = _installAfterDownload;
            _installAfterDownload = false;
        }

        HostLog.Info($"[update] downloaded path={path}");
        Post();

        if (installNow)
        {
            RunInstaller();
        }
    }

    private void CancelDownload()
    {
        lock (_gate)
        {
            if (_state == StateDownloading)
            {
                _downloadCts?.Cancel();
            }
        }
    }

    private static async Task<bool> VerifyFileAsync(string path, long expectedSize, string? digest, CancellationToken token)
    {
        try
        {
            if (!File.Exists(path))
            {
                return false;
            }

            if (expectedSize > 0 && new FileInfo(path).Length != expectedSize)
            {
                return false;
            }

            if (string.IsNullOrWhiteSpace(digest))
            {
                return true;
            }

            var prefix = "sha256:";
            if (!digest.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            var expected = digest[prefix.Length..].Trim();
            if (expected.Length == 0)
            {
                return true;
            }

            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, useAsync: true);
            var hash = await SHA256.HashDataAsync(stream, token).ConfigureAwait(false);
            var actual = Convert.ToHexString(hash);
            return string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            HostLog.Warn($"[update] verify failed path={path} err={exception.Message}");
            return false;
        }
    }

    // ---------------- 安装 ----------------

    private void RequestInstall()
    {
        var needDownload = false;
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            if (_busy && _state == StateDownloading)
            {
                _installAfterDownload = true;
                return;
            }

            if (_busy)
            {
                return;
            }

            if (_state == StateDownloaded && _setupPath is not null)
            {
                needDownload = false;
            }
            else if (_state == StateAvailable && !string.IsNullOrEmpty(_assetUrl))
            {
                needDownload = true;
                _busy = true;
                _state = StateDownloading;
                _downloaded = 0;
                _total = _assetSize;
                _error = null;
                _notice = null;
            }
            else
            {
                return;
            }
        }

        if (needDownload)
        {
            Post();
            _installAfterDownload = true;
            _ = Task.Run(DownloadWorkerAsync);
            return;
        }

        RunInstaller();
    }

    private void RunInstaller()
    {
        string setupPath;
        lock (_gate)
        {
            if (_disposed || _setupPath is null)
            {
                return;
            }

            setupPath = _setupPath;
            _state = StateInstalling;
            _busy = true;
            _error = null;
            _notice = null;
        }

        Post();
        try
        {
            var installDir = ResolveInstallDir();
            HostLog.Info($"[update] installing setup={setupPath} dir={installDir}");
            var startInfo = new ProcessStartInfo(setupPath)
            {
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(setupPath) ?? AppContext.BaseDirectory,
            };
            startInfo.ArgumentList.Add("--silent");
            startInfo.ArgumentList.Add("--no-shortcuts");
            startInfo.ArgumentList.Add("--launch");
            startInfo.ArgumentList.Add("--dir");
            startInfo.ArgumentList.Add(installDir);

            var process = Process.Start(startInfo);
            if (process is null)
            {
                throw new InvalidOperationException("无法启动安装程序进程");
            }

            // 安装器会先结束本进程再覆盖安装，给 UI 一点时间把 installing 状态推给页面。
            _ = Task.Run(async () =>
            {
                await Task.Delay(1200).ConfigureAwait(false);
                _requestExit();
            });
        }
        catch (Exception exception)
        {
            HostLog.Error("[update] install failed", exception);
            lock (_gate)
            {
                _busy = false;
                _state = StateError;
                _error = $"启动安装程序失败：{exception.Message}";
            }

            Post();
        }
    }

    private static string ResolveInstallDir()
    {
        var overrideDir = Environment.GetEnvironmentVariable(InstallDirEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(overrideDir))
        {
            return Path.GetFullPath(overrideDir.Trim());
        }

        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(UninstallRegistryKey);
            if (key?.GetValue("InstallLocation") is string location &&
                !string.IsNullOrWhiteSpace(location) &&
                File.Exists(Path.Combine(location, "Zilux2.exe")))
            {
                return Path.GetFullPath(location);
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[update] install location lookup failed: {exception.Message}");
        }

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Zilux2");
    }

    // ---------------- 页面动作 ----------------

    private void OpenReleasePage()
    {
        string? pageUrl;
        lock (_gate)
        {
            pageUrl = _pageUrl;
        }

        if (string.IsNullOrWhiteSpace(pageUrl))
        {
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(pageUrl) { UseShellExecute = true });
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[update] open release page failed: {exception.Message}");
        }
    }

    // ---------------- 状态与消息 ----------------

    private void SetUnavailable(string notice)
    {
        lock (_gate)
        {
            _state = StateUnavailable;
            _busy = false;
            _notice = notice;
            _error = null;
            _lastCheckUtc = DateTimeOffset.UtcNow;
            _checkedAt = _lastCheckUtc;
        }

        HostLog.Info($"[update] unavailable: {notice}");
        Post();
    }

    private void SetError(string error)
    {
        lock (_gate)
        {
            _state = StateError;
            _busy = false;
            _error = error;
            _notice = null;
            _lastCheckUtc = DateTimeOffset.UtcNow;
            _checkedAt = _lastCheckUtc;
        }

        HostLog.Warn($"[update] error: {error}");
        Post();
    }

    internal string CreateSnapshotJson()
    {
        lock (_gate)
        {
            var message = new UpdateHostMessage
            {
                State = _state,
                CurrentVersion = HostInfo.Version,
                LatestVersion = _latestVersion,
                ReleaseName = _releaseName,
                Notes = _notes,
                PageUrl = _pageUrl,
                AssetName = _assetName,
                AssetSize = _assetSize > 0 ? _assetSize : null,
                Downloaded = _downloaded > 0 ? _downloaded : null,
                Total = _total > 0 ? _total : null,
                Error = _error,
                Notice = _notice,
                Mode = _settings.UpdateMode,
                AutoCheck = _settings.UpdateAutoCheck,
                Repo = ResolveRepo(),
                CanAutoInstall = !string.IsNullOrEmpty(_assetUrl) &&
                                 _settings.UpdateMode == UpdateSettings.ModeAuto,
                CheckedAt = _checkedAt?.ToString("o", CultureInfo.InvariantCulture),
            };
            return JsonSerializer.Serialize(message, UpdateJsonContext.Default.UpdateHostMessage);
        }
    }

    private void Post()
    {
        try
        {
            _postJson(CreateSnapshotJson());
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[update] post failed: {exception.Message}");
        }
    }

    private string ResolveRepo()
    {
        var fromEnvironment = Environment.GetEnvironmentVariable(RepoEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(fromEnvironment))
        {
            return fromEnvironment.Trim();
        }

        var configured = _settings.UpdateRepoOverride;
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured.Trim();
        }

        string? fromLock;
        lock (_gate)
        {
            fromLock = _repo;
        }

        if (!string.IsNullOrWhiteSpace(fromLock))
        {
            return fromLock;
        }

        return _buildRepo;
    }

    private static string ResolveApiBase()
    {
        var raw = Environment.GetEnvironmentVariable(ApiBaseEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(raw))
        {
            var trimmed = raw.Trim().TrimEnd('/');
            if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) &&
                (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
            {
                return trimmed;
            }

            HostLog.Warn($"[update] invalid {ApiBaseEnvironmentVariable}; using default");
        }

        return DefaultApiBase;
    }

    // ---------------- 版本比较 ----------------

    /// <summary>把 "v1.2.3" / "1.2.3" / "1.2.3-beta.1" 归一化成数字段形式（保留预发布后缀）。</summary>
    internal static string? NormalizeVersion(string? tag)
    {
        if (string.IsNullOrWhiteSpace(tag))
        {
            return null;
        }

        var text = tag.Trim();
        if (text.Length > 0 && (text[0] == 'v' || text[0] == 'V'))
        {
            text = text[1..];
        }

        return text.Length == 0 ? null : text;
    }

    /// <summary>逐段数字比较；返回 &gt;0 表示 left 更新。预发布后缀按 semver 规则低于正式版。</summary>
    internal static int CompareVersions(string left, string right)
    {
        ParseVersion(left, out var leftParts, out var leftPre);
        ParseVersion(right, out var rightParts, out var rightPre);

        var length = Math.Max(leftParts.Count, rightParts.Count);
        for (var index = 0; index < length; index++)
        {
            var a = index < leftParts.Count ? leftParts[index] : 0;
            var b = index < rightParts.Count ? rightParts[index] : 0;
            if (a != b)
            {
                return a.CompareTo(b);
            }
        }

        // 1.0.0 > 1.0.0-beta；两个预发布版本按字符串比较（够用，CI 只发正式版）。
        if (leftPre.Length == 0 && rightPre.Length > 0)
        {
            return 1;
        }

        if (leftPre.Length > 0 && rightPre.Length == 0)
        {
            return -1;
        }

        return string.CompareOrdinal(leftPre, rightPre);
    }

    private static void ParseVersion(string text, out List<int> parts, out string prerelease)
    {
        parts = new List<int>();
        prerelease = string.Empty;
        var core = text;
        var plus = core.IndexOf('+');
        if (plus >= 0)
        {
            core = core[..plus];
        }

        var dash = core.IndexOf('-');
        if (dash >= 0)
        {
            prerelease = core[(dash + 1)..];
            core = core[..dash];
        }

        foreach (var segment in core.Split('.'))
        {
            parts.Add(int.TryParse(segment, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) ? value : 0);
        }
    }

    // ---------------- 小工具 ----------------

    private static string? ReadString(JsonElement parent, string name) =>
        parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static bool ReadBool(JsonElement parent, string name) =>
        parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    private static void TryDelete(string path)
    {
        try
        {
            if (!string.IsNullOrEmpty(path) && File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[update] cleanup failed path={path} err={exception.Message}");
        }
    }
}

// 宿主 -> 页面的更新状态快照。nullable 字段为 null 时不序列化，页面只看存在的字段。
internal sealed class UpdateHostMessage
{
    public int V { get; set; } = 1;

    public string Type { get; set; } = "host";

    public string Event { get; set; } = "update";

    public string State { get; set; } = UpdateService.StateIdle;

    public string CurrentVersion { get; set; } = HostInfo.Version;

    public string? LatestVersion { get; set; }

    public string? ReleaseName { get; set; }

    public string? Notes { get; set; }

    public string? PageUrl { get; set; }

    public string? AssetName { get; set; }

    public long? AssetSize { get; set; }

    public long? Downloaded { get; set; }

    public long? Total { get; set; }

    public string? Error { get; set; }

    public string? Notice { get; set; }

    public string Mode { get; set; } = "auto";

    public bool AutoCheck { get; set; } = true;

    public string Repo { get; set; } = string.Empty;

    public bool CanAutoInstall { get; set; }

    public string? CheckedAt { get; set; }
}

[JsonSourceGenerationOptions(
    WriteIndented = false,
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(UpdateHostMessage))]
internal sealed partial class UpdateJsonContext : JsonSerializerContext
{
}
