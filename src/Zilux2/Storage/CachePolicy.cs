using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Zilux2.Storage;

/// <summary>
/// 磁盘缓存预算（用户可在设置里调整）。单独存 cache-policy.json，避免改动 settings.json
/// 的固定字段顺序与前端 SettingsPatch 契约。
/// </summary>
internal static class CachePolicy
{
    public const int MinMb = 128;

    public const int MaxMb = 16384;

    public const int DefaultMb = 2048;

    // 四轨分离缓存（stems）的独立上限，和上面的整体缓存预算存在同一个文件里。
    // 0 是合法值（不自动清理），范围 128–16384，其余值一律回落 DefaultStemMb。
    public const int MinStemMb = 128;

    public const int MaxStemMb = 16384;

    public const int DefaultStemMb = 2048;

    private static readonly object Gate = new();
    private static int _limitMb = DefaultMb;
    private static int _maxStemCacheMb = DefaultStemMb;
    // 文件里是否真的写了 maxStemCacheMb：缺键时 StemCacheLru 才能继续回落到环境变量。
    private static bool _hasStemKey;
    private static string? _pathOverride;
    private static DateTime _stamp = DateTime.MinValue;

    private static string PolicyPath => _pathOverride ?? Path.Combine(HostFolders.Root, "cache-policy.json");

    /// <summary>测试注入：把策略文件指到临时目录，避免改动用户真实的 cache-policy.json。</summary>
    internal static string? PolicyPathOverride
    {
        get => _pathOverride;
        set
        {
            lock (Gate)
            {
                _pathOverride = value;
                _stamp = DateTime.MinValue;
            }
        }
    }

    public static int LimitMb
    {
        get
        {
            Refresh();
            return _limitMb;
        }
    }

    public static long LimitBytes => LimitMb * 1024L * 1024L;

    /// <summary>stems 分离缓存上限（MB）；0 = 不自动清理。缺键时给 <see cref="DefaultStemMb"/>。</summary>
    public static int MaxStemCacheMb
    {
        get
        {
            Refresh();
            return _maxStemCacheMb;
        }
    }

    /// <summary>
    /// 文件里是否显式配置了 maxStemCacheMb（含非法的回落值）。缺键返回 false，
    /// 让 <see cref="Zilux2.Stems.StemCacheLru"/> 继续走环境变量 / 整体预算回落链。
    /// </summary>
    internal static bool TryGetMaxStemCacheMb(out int megabytes)
    {
        Refresh();
        megabytes = _maxStemCacheMb;
        return _hasStemKey;
    }

    public static int SetLimitMb(int mb)
    {
        var next = Clamp(mb);
        lock (Gate)
        {
            _limitMb = next;
            _stamp = DateTime.MinValue;
            WriteLocked(root => SetProperty(root, "limitMb", next));
        }

        return next;
    }

    /// <summary>保存 stems 缓存上限；0 合法（不清理），非法值回落 <see cref="DefaultStemMb"/>，不抛。</summary>
    public static int SetMaxStemCacheMb(int mb)
    {
        var next = NormalizeStemMb(mb);
        lock (Gate)
        {
            _maxStemCacheMb = next;
            _hasStemKey = true;
            _stamp = DateTime.MinValue;
            WriteLocked(root => SetProperty(root, "maxStemCacheMb", next));
        }

        return next;
    }

    /// <summary>0 合法（不清理）；128–16384 原样；负数、1–127、超上限回落 <see cref="DefaultStemMb"/>。</summary>
    public static int NormalizeStemMb(int mb)
    {
        if (mb == 0)
        {
            return 0;
        }

        return mb is >= MinStemMb and <= MaxStemMb ? mb : DefaultStemMb;
    }

    public static int Clamp(int mb)
    {
        if (mb <= 0)
        {
            return DefaultMb;
        }

        return Math.Min(MaxMb, Math.Max(MinMb, mb));
    }

    private static void Refresh()
    {
        lock (Gate)
        {
            try
            {
                if (!File.Exists(PolicyPath))
                {
                    _limitMb = DefaultMb;
                    _maxStemCacheMb = DefaultStemMb;
                    _hasStemKey = false;
                    return;
                }

                var stamp = File.GetLastWriteTimeUtc(PolicyPath);
                if (stamp == _stamp)
                {
                    return;
                }

                using var document = JsonDocument.Parse(File.ReadAllText(PolicyPath));
                var root = document.RootElement;
                _limitMb = ReadInt(root, "limitMb") is { } limit ? Clamp(limit) : DefaultMb;
                if (ReadInt(root, "maxStemCacheMb") is { } stem)
                {
                    // 显式写了键就按它的值（含非法值回落到 2048）；只有缺键才让上层继续回落。
                    _maxStemCacheMb = NormalizeStemMb(stem);
                    _hasStemKey = true;
                }
                else
                {
                    _maxStemCacheMb = DefaultStemMb;
                    _hasStemKey = false;
                }

                _stamp = stamp;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
            {
                HostLog.Warn($"cache.policy.read-failed: {exception.Message}");
                _limitMb = DefaultMb;
                _maxStemCacheMb = DefaultStemMb;
                _hasStemKey = false;
            }
        }
    }

    /// <summary>大小写不敏感地读一个整数键；缺失、非数字、溢出都返回 null（调用方决定回落）。</summary>
    private static int? ReadInt(JsonElement root, string name)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        foreach (var property in root.EnumerateObject())
        {
            if (!string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (property.Value.ValueKind != JsonValueKind.Number ||
                !property.Value.TryGetInt64(out var value))
            {
                return null;
            }

            return value switch
            {
                > int.MaxValue => int.MaxValue,
                < int.MinValue => int.MinValue,
                _ => (int)value,
            };
        }

        return null;
    }

    /// <summary>写回：先读原 JSON 再只改自己的键，未知键（含 web 端新增的）原样保留。</summary>
    private static void WriteLocked(Action<JsonObject> mutate)
    {
        try
        {
            var path = PolicyPath;
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var root = ReadObject(path) ?? new JsonObject();
            mutate(root);
            var temp = path + ".tmp";
            File.WriteAllText(temp, root.ToJsonString());
            File.Move(temp, path, true);
            // 下一次读取必须重新解析：刚刚只改了一个键，内存里的其它字段（比如
            // maxStemCacheMb）可能还停在写之前的旧值，不能拿新 mtime 冒充「已同步」。
            _stamp = DateTime.MinValue;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            HostLog.Warn($"cache.policy.write-failed: {exception.Message}");
        }
    }

    private static JsonObject? ReadObject(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            return JsonNode.Parse(File.ReadAllText(path)) as JsonObject;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            HostLog.Warn($"cache.policy.read-failed: {exception.Message}");
            return null;
        }
    }

    /// <summary>改键但保留原有拼写（老文件是 LimitMb，新文件写 limitMb），避免同一文件出现两份。</summary>
    private static void SetProperty(JsonObject root, string name, int value)
    {
        foreach (var pair in root)
        {
            if (string.Equals(pair.Key, name, StringComparison.OrdinalIgnoreCase))
            {
                root[pair.Key] = value;
                return;
            }
        }

        root[name] = value;
    }
}
