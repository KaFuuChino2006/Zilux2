using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Zilux2.Settings;

// Contract docs/zilux2-settings-contract.md: host owns persistence, the page only sends patches.
internal sealed class SettingsService : IDisposable
{
    internal const int CurrentVersion = 1;
    internal const string PathOverrideEnvironmentVariable = "ZILUX2_SETTINGS_PATH";

    private const int SaveDebounceMilliseconds = 300;

    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);
    private static readonly JsonSerializerOptions FileJsonOptions = new() { WriteIndented = true };

    private static readonly string[] KnownTopLevelKeys = { "version", "general", "appearance", "playback", "downloads", "updates" };

    private readonly object _gate = new();
    private readonly string _path;
    private readonly System.Threading.Timer _saveTimer;
    private SettingsModel _state;
    private JsonObject? _loadedDocument;
    private bool _dirty;
    private bool _disposed;

    internal SettingsService(string? pathOverride = null)
    {
        _path = Path.GetFullPath(string.IsNullOrWhiteSpace(pathOverride) ? ResolveDefaultPath() : pathOverride.Trim());
        _state = Load(out _loadedDocument);
        _saveTimer = new System.Threading.Timer(_ => OnSaveTimer(), null, Timeout.Infinite, Timeout.Infinite);
        HostLog.Info($"[settings] ready path={_path}");
    }

    internal string SettingsPath => _path;

    internal bool StartMaximized
    {
        get
        {
            lock (_gate)
            {
                return _state.General.StartMaximized;
            }
        }
    }

    // Read by the audio feature service on its capture thread, so it must stay cheap and locked.
    internal bool AudioReactive
    {
        get
        {
            lock (_gate)
            {
                return _state.Playback.AudioReactive;
            }
        }
    }

    internal string WindowAnimation
    {
        get
        {
            lock (_gate)
            {
                return _state.Appearance.WindowAnimation;
            }
        }
    }

    /// <summary>下载目录（空字符串表示用 Windows 音乐目录）。</summary>
    internal string DownloadDirectory
    {
        get
        {
            lock (_gate)
            {
                return _state.Downloads.Directory;
            }
        }
    }

    /// <summary>下载音质（standard/high/lossless）。</summary>
    internal string DownloadQuality
    {
        get
        {
            lock (_gate)
            {
                return _state.Downloads.Quality;
            }
        }
    }

    /// <summary>启动后是否自动检查更新。</summary>
    internal bool UpdateAutoCheck
    {
        get
        {
            lock (_gate)
            {
                return _state.Updates.AutoCheck;
            }
        }
    }

    /// <summary>更新方式：auto=应用内更新，notify=仅提示。</summary>
    internal string UpdateMode
    {
        get
        {
            lock (_gate)
            {
                return _state.Updates.Mode;
            }
        }
    }

    /// <summary>设置里覆盖的 GitHub 仓库；空字符串表示使用程序集内烘焙的仓库。</summary>
    internal string UpdateRepoOverride
    {
        get
        {
            lock (_gate)
            {
                return _state.Updates.Repo;
            }
        }
    }

    internal static string ResolveDefaultPath()
    {
        var overridePath = Environment.GetEnvironmentVariable(PathOverrideEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(overridePath))
        {
            return overridePath.Trim();
        }

        return Path.Combine(HostFolders.Root, "settings.json");
    }

    // Full snapshot pushed to the page (contract section 3.2). Serialized under the lock so a
    // concurrent patch can never hand out a half-updated state.
    internal string CreateSnapshotJson()
    {
        lock (_gate)
        {
            var message = new HostSettingsMessage { State = _state };
            return JsonSerializer.Serialize(message, SettingsJsonContext.Default.HostSettingsMessage);
        }
    }

    internal void Patch(JsonElement patch)
    {
        if (patch.ValueKind != JsonValueKind.Object)
        {
            HostLog.Warn("[settings] patch ignored (not an object)");
            return;
        }

        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            var keys = ApplyKnownValues(patch, _state);
            if (keys.Count == 0)
            {
                HostLog.Warn("[settings] patch ignored (no known keys)");
                return;
            }

            HostLog.Info($"[settings] patch keys={string.Join(",", keys)}");
            MarkDirtyLocked();
        }
    }

    internal void Reset()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _state = SettingsModel.CreateDefaults();
            _loadedDocument = null;
            HostLog.Info("[settings] reset");
            MarkDirtyLocked();
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

        _saveTimer.Dispose();
        lock (_gate)
        {
            if (!_dirty)
            {
                return;
            }

            // Contract section 1: pending changes are flushed before the process exits.
            SaveLocked();
        }

        HostLog.Info("[settings] disposed");
    }

    private void MarkDirtyLocked()
    {
        _dirty = true;
        _saveTimer.Change(SaveDebounceMilliseconds, Timeout.Infinite);
    }

    private void OnSaveTimer()
    {
        try
        {
            lock (_gate)
            {
                if (_disposed || !_dirty)
                {
                    return;
                }

                SaveLocked();
            }
        }
        catch (Exception exception)
        {
            HostLog.Error("[settings] save failed", exception);
        }
    }

    private void SaveLocked()
    {
        try
        {
            var document = JsonSerializer.SerializeToNode(_state, SettingsJsonContext.Default.SettingsModel)?.AsObject();
            if (document is null)
            {
                HostLog.Error("[settings] save failed: could not serialize state");
                return;
            }

            MergeUnknownKeys(document);

            var directory = Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            // Contract section 1: temp file + replace so a crash never leaves half-written JSON.
            var tempPath = _path + ".tmp";
            File.WriteAllText(tempPath, document.ToJsonString(FileJsonOptions), Utf8NoBom);
            if (File.Exists(_path))
            {
                File.Replace(tempPath, _path, destinationBackupFileName: null);
            }
            else
            {
                File.Move(tempPath, _path);
            }

            _dirty = false;
            HostLog.Info("[settings] save ok");
        }
        catch (Exception exception)
        {
            HostLog.Error("[settings] save failed", exception);
        }
    }

    // Contract section 2: keys the host does not understand survive a save round-trip untouched.
    private void MergeUnknownKeys(JsonObject target)
    {
        if (_loadedDocument is null)
        {
            return;
        }

        foreach (var pair in _loadedDocument)
        {
            if (!KnownTopLevelKeys.Contains(pair.Key, StringComparer.Ordinal))
            {
                target[pair.Key] = pair.Value?.DeepClone();
                continue;
            }

            if (pair.Value is not JsonObject loadedSection || target[pair.Key] is not JsonObject savedSection)
            {
                continue;
            }

            foreach (var inner in loadedSection)
            {
                if (!IsKnownField(pair.Key, inner.Key))
                {
                    savedSection[inner.Key] = inner.Value?.DeepClone();
                }
            }
        }
    }

    private static bool IsKnownField(string section, string name) => section switch
    {
        "general" => name is "splash" or "startMaximized",
        "appearance" => name is "theme" or "reduceMotion" or "glow" or "heroAutoRotate" or "lyricsSize",
        "playback" => name is "defaultSource" or "searchLimit" or "lyricsAutoOpen" or "volume" or "audioReactive",
        "downloads" => name is "directory" or "quality",
        "updates" => name is "autoCheck" or "mode" or "repo",
        _ => false,
    };

    private SettingsModel Load(out JsonObject? loadedDocument)
    {
        loadedDocument = null;
        var defaults = SettingsModel.CreateDefaults();

        if (!File.Exists(_path))
        {
            HostLog.Info($"[settings] load path={_path} defaults (file missing)");
            return defaults;
        }

        string text;
        try
        {
            text = File.ReadAllText(_path, Encoding.UTF8);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[settings] load failed path={_path} err={exception.GetType().Name}: {exception.Message}");
            return defaults;
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(text);
        }
        catch (JsonException exception)
        {
            HostLog.Warn($"[settings] load failed path={_path} err=invalid json: {exception.Message}");
            BackupCorruptFile("invalid json");
            return defaults;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                HostLog.Warn($"[settings] load failed path={_path} err=root is not an object");
                BackupCorruptFile("root is not an object");
                return defaults;
            }

            if (!root.TryGetProperty("version", out var versionElement) ||
                versionElement.ValueKind != JsonValueKind.Number ||
                !versionElement.TryGetInt32(out var version) ||
                version != CurrentVersion)
            {
                HostLog.Warn($"[settings] load failed path={_path} err=unrecognized version");
                BackupCorruptFile("unrecognized version");
                return defaults;
            }

            ApplyKnownValues(root, defaults);
            loadedDocument = JsonNode.Parse(text) as JsonObject;
            HostLog.Info($"[settings] load path={_path} version={version}");
            return defaults;
        }
    }

    // Applies every known key that is present. Missing keys keep the current value, invalid
    // values fall back to the default (contract sections 1 and 2) - never throws.
    private static List<string> ApplyKnownValues(JsonElement document, SettingsModel state)
    {
        var keys = new List<string>();

        if (TryGetObject(document, "general", out var general))
        {
            state.General.Splash = ReadBool(general, "splash", true, "general.splash", keys);
            state.General.StartMaximized = ReadBool(general, "startMaximized", false, "general.startMaximized", keys);
        }

        if (TryGetObject(document, "appearance", out var appearance))
        {
            state.Appearance.Theme = ReadEnum(
                appearance, "theme", AppearanceSettings.Themes, AppearanceSettings.ThemeDark, "appearance.theme", keys);
            state.Appearance.ReduceMotion = ReadBool(appearance, "reduceMotion", false, "appearance.reduceMotion", keys);
            state.Appearance.Glow = ReadBool(appearance, "glow", true, "appearance.glow", keys);
            state.Appearance.HeroAutoRotate = ReadBool(appearance, "heroAutoRotate", true, "appearance.heroAutoRotate", keys);
            state.Appearance.LyricsSize = ReadEnum(
                appearance, "lyricsSize", AppearanceSettings.LyricsSizes, AppearanceSettings.LyricsSizeMedium, "appearance.lyricsSize", keys);
            state.Appearance.WindowAnimation = ReadEnum(
                appearance, "windowAnimation",
                AppearanceSettings.WindowAnimations,
                AppearanceSettings.WindowAnimationCustom,
                "appearance.windowAnimation",
                keys);
        }

        if (TryGetObject(document, "playback", out var playback))
        {
            state.Playback.DefaultSource = ReadEnum(
                playback, "defaultSource", PlaybackSettings.Sources, PlaybackSettings.SourceNetease, "playback.defaultSource", keys);
            state.Playback.SearchLimit = ReadAllowedInt(
                playback, "searchLimit", PlaybackSettings.SearchLimits, 20, "playback.searchLimit", keys);
            state.Playback.LyricsAutoOpen = ReadBool(playback, "lyricsAutoOpen", true, "playback.lyricsAutoOpen", keys);
            state.Playback.Volume = ReadVolume(playback, "volume", 0.72, "playback.volume", keys);
            state.Playback.AudioReactive = ReadBool(playback, "audioReactive", true, "playback.audioReactive", keys);
        }

        if (TryGetObject(document, "downloads", out var downloads))
        {
            state.Downloads.Directory = ReadDirectory(downloads, "directory", "downloads.directory", keys);
            state.Downloads.Quality = ReadEnum(
                downloads, "quality", DownloadSettings.Qualities, DownloadSettings.QualityHigh, "downloads.quality", keys);
        }

        if (TryGetObject(document, "updates", out var updates))
        {
            state.Updates.AutoCheck = ReadBool(updates, "autoCheck", true, "updates.autoCheck", keys);
            state.Updates.Mode = ReadEnum(
                updates, "mode", UpdateSettings.Modes, UpdateSettings.ModeAuto, "updates.mode", keys);
            state.Updates.Repo = ReadRepo(updates, "repo", "updates.repo", keys);
        }

        return keys;
    }

    private static bool TryGetObject(JsonElement parent, string name, out JsonElement value)
    {
        if (parent.TryGetProperty(name, out value) && value.ValueKind == JsonValueKind.Object)
        {
            return true;
        }

        value = default;
        return false;
    }

    private static bool ReadBool(JsonElement parent, string name, bool fallback, string key, List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind == JsonValueKind.True)
        {
            return true;
        }

        if (value.ValueKind == JsonValueKind.False)
        {
            return false;
        }

        HostLog.Warn($"[settings] invalid key={key} expected=bool fallback={fallback.ToString().ToLowerInvariant()}");
        return fallback;
    }

    private static string ReadEnum(
        JsonElement parent,
        string name,
        string[] allowed,
        string fallback,
        string key,
        List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString();
            if (text is not null && Array.IndexOf(allowed, text) >= 0)
            {
                return text;
            }
        }

        HostLog.Warn($"[settings] invalid key={key} expected={string.Join("|", allowed)} fallback={fallback}");
        return fallback;
    }

    private static int ReadAllowedInt(
        JsonElement parent,
        string name,
        int[] allowed,
        int fallback,
        string key,
        List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind == JsonValueKind.Number &&
            value.TryGetInt32(out var number) &&
            Array.IndexOf(allowed, number) >= 0)
        {
            return number;
        }

        HostLog.Warn($"[settings] invalid key={key} expected={string.Join("|", allowed)} fallback={fallback}");
        return fallback;
    }

    private static string ReadDirectory(JsonElement parent, string name, string key, List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return string.Empty;
        }

        keys.Add(key);
        if (value.ValueKind != JsonValueKind.String)
        {
            HostLog.Warn($"[settings] invalid key={key} expected=string fallback=<default>");
            return string.Empty;
        }

        var text = value.GetString() ?? string.Empty;
        if (text.Length == 0)
        {
            return string.Empty;
        }

        try
        {
            return Path.GetFullPath(text.Trim());
        }
        catch (Exception)
        {
            HostLog.Warn($"[settings] invalid key={key} fallback=<default> value={text}");
            return string.Empty;
        }
    }

    private static string ReadRepo(JsonElement parent, string name, string key, List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return string.Empty;
        }

        keys.Add(key);
        if (value.ValueKind != JsonValueKind.String)
        {
            HostLog.Warn($"[settings] invalid key={key} expected=\"owner/repo\" fallback=<builtin>");
            return string.Empty;
        }

        var text = (value.GetString() ?? string.Empty).Trim();
        if (text.Length == 0)
        {
            return string.Empty;
        }

        if (IsRepoSlug(text))
        {
            return text;
        }

        HostLog.Warn($"[settings] invalid key={key} expected=\"owner/repo\" fallback=<builtin> value={text}");
        return string.Empty;
    }

    // GitHub owner/repo: exactly one slash, each side non-empty and made of safe slug characters.
    private static bool IsRepoSlug(string text)
    {
        var slash = text.IndexOf('/');
        if (slash <= 0 || slash == text.Length - 1 || text.IndexOf('/', slash + 1) >= 0)
        {
            return false;
        }

        for (var index = 0; index < text.Length; index++)
        {
            if (index == slash)
            {
                continue;
            }

            var ch = text[index];
            if (!char.IsLetterOrDigit(ch) && ch != '-' && ch != '_' && ch != '.')
            {
                return false;
            }
        }

        return true;
    }

    private static double ReadVolume(JsonElement parent, string name, double fallback, string key, List<string> keys)
    {
        if (!parent.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        keys.Add(key);
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && number is >= 0.0 and <= 1.0)
        {
            // Contract section 2: volume keeps two decimals.
            return Math.Round(number, 2, MidpointRounding.AwayFromZero);
        }

        HostLog.Warn($"[settings] invalid key={key} expected=number 0.0..1.0 fallback={fallback.ToString(CultureInfo.InvariantCulture)}");
        return fallback;
    }

    private void BackupCorruptFile(string reason)
    {
        try
        {
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
            var backupPath = $"{_path}.corrupt-{stamp}";
            var index = 1;
            while (File.Exists(backupPath))
            {
                backupPath = $"{_path}.corrupt-{stamp}-{index.ToString(CultureInfo.InvariantCulture)}";
                index++;
            }

            File.Move(_path, backupPath);
            HostLog.Warn($"[settings] corrupt backup path={backupPath} reason={reason}");
        }
        catch (Exception exception)
        {
            HostLog.Error("[settings] corrupt backup failed", exception);
        }
    }
}
