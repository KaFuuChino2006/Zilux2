using System.Globalization;
using System.IO;
using System.Text.Json;

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

    private static readonly object Gate = new();
    private static int _limitMb = DefaultMb;
    private static DateTime _stamp = DateTime.MinValue;

    private static string PolicyPath => Path.Combine(HostFolders.Root, "cache-policy.json");

    public static int LimitMb
    {
        get
        {
            Refresh();
            return _limitMb;
        }
    }

    public static long LimitBytes => LimitMb * 1024L * 1024L;

    public static int SetLimitMb(int mb)
    {
        var next = Clamp(mb);
        lock (Gate)
        {
            _limitMb = next;
            _stamp = DateTime.MinValue;
            try
            {
                Directory.CreateDirectory(HostFolders.Root);
                var temp = PolicyPath + ".tmp";
                File.WriteAllText(
                    temp,
                    JsonSerializer.Serialize(new CachePolicyFile { LimitMb = next }));
                File.Move(temp, PolicyPath, true);
                _stamp = File.GetLastWriteTimeUtc(PolicyPath);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                HostLog.Warn($"cache.policy.write-failed: {exception.Message}");
            }
        }

        return next;
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
                    return;
                }

                var stamp = File.GetLastWriteTimeUtc(PolicyPath);
                if (stamp == _stamp)
                {
                    return;
                }

                var file = JsonSerializer.Deserialize<CachePolicyFile>(File.ReadAllText(PolicyPath));
                _limitMb = Clamp(file?.LimitMb ?? DefaultMb);
                _stamp = stamp;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
            {
                HostLog.Warn($"cache.policy.read-failed: {exception.Message}");
                _limitMb = DefaultMb;
            }
        }
    }

    private sealed class CachePolicyFile
    {
        public int LimitMb { get; set; } = DefaultMb;
    }
}
