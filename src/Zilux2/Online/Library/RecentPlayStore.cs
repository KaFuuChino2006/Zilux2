using System.IO;
using System.Text.Json;

namespace Zilux2.Online.Library;

// 「最近播放」：QQ 音乐的第三方接口不提供播放历史，网易云有但只覆盖自己的账号。
// 因此这里维护一份本机播放记录（两个平台混在一起），既能给 QQ 兜底，也能让最近播放更贴近实际使用。
internal sealed class RecentPlayStore
{
    private const int MaxEntries = 500;
    private const int DefaultLimit = 30;

    private readonly object _gate = new();
    private readonly string _path;
    private List<OnlineTrack> _tracks = [];

    internal RecentPlayStore()
    {
        var directory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Zilux2");
        Directory.CreateDirectory(directory);
        _path = Path.Combine(directory, "recent-plays.json");
        try
        {
            if (File.Exists(_path))
            {
                var json = File.ReadAllText(_path);
                _tracks = JsonSerializer.Deserialize<List<OnlineTrack>>(json) ?? [];
            }
        }
        catch (JsonException exception)
        {
            // D-12：损坏的文件不再静默清空，先备份再重建，避免用户历史无痕丢失。
            BackupCorrupt(exception.Message);
            _tracks = [];
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            OnlineHttp.Warn($"[recent] load failed: {exception.GetType().Name} {exception.Message}");
            _tracks = [];
        }
    }

    internal void Record(OnlineTrack track)
    {
        if (string.IsNullOrWhiteSpace(track.Id) || string.IsNullOrWhiteSpace(track.Source))
        {
            return;
        }

        lock (_gate)
        {
            _tracks.RemoveAll(item => item.Source == track.Source && item.Id == track.Id);
            _tracks.Insert(0, track);
            if (_tracks.Count > MaxEntries)
            {
                _tracks.RemoveRange(MaxEntries, _tracks.Count - MaxEntries);
            }

            SaveLocked();
        }
    }

    internal List<OnlineTrack> List(string? source, int limit)
    {
        var take = Math.Clamp(limit <= 0 ? DefaultLimit : limit, 1, 500);
        lock (_gate)
        {
            IEnumerable<OnlineTrack> items = _tracks;
            if (!string.IsNullOrEmpty(source))
            {
                items = items.Where(item => string.Equals(item.Source, source, StringComparison.Ordinal));
            }

            return items.Take(take).ToList();
        }
    }

    private void SaveLocked()
    {
        var temp = _path + ".tmp";
        try
        {
            // D-12：落盘前剥掉封面代理 URL 里的回环 token，避免更新通道之外的临时凭据长期留在磁盘上。
            var serializable = _tracks.Select(StripCoverToken).ToList();
            File.WriteAllText(temp, JsonSerializer.Serialize(serializable));
            if (File.Exists(_path))
            {
                File.Replace(temp, _path, null);
            }
            else
            {
                File.Move(temp, _path);
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            OnlineHttp.Warn($"[recent] persist failed: {exception.GetType().Name}");
        }
        finally
        {
            try
            {
                if (File.Exists(temp))
                {
                    File.Delete(temp);
                }
            }
            catch
            {
                // 残留 .tmp 不影响下次启动；下次成功写入会覆盖。
            }
        }
    }

    private void BackupCorrupt(string reason)
    {
        try
        {
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            var backup = _path + ".corrupt-" + stamp;
            var index = 1;
            while (File.Exists(backup))
            {
                backup = _path + ".corrupt-" + stamp + "-" + index;
                index += 1;
            }

            File.Move(_path, backup);
            OnlineHttp.Warn($"[recent] corrupt file backed up to {backup}: {reason}");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            OnlineHttp.Warn($"[recent] backup corrupt file failed: {exception.Message}");
        }
    }

    /// <summary>只处理宿主自己的封面代理 URL；上游直链原样保留。</summary>
    private static OnlineTrack StripCoverToken(OnlineTrack track)
    {
        var cover = track.Cover;
        if (string.IsNullOrEmpty(cover) || !Uri.TryCreate(cover, UriKind.Absolute, out var uri))
        {
            return track;
        }

        if (!uri.AbsolutePath.EndsWith("/api/cover", StringComparison.OrdinalIgnoreCase))
        {
            return track;
        }

        var queryIndex = cover.IndexOf('?');
        if (queryIndex < 0)
        {
            return track;
        }

        // 直接做字符串级删除，避免 UriBuilder 重新编码已转义的 key（例如 https%3A%2F%2F...）。
        var prefix = cover[..queryIndex];
        var parts = cover[(queryIndex + 1)..]
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Where(part => !part.StartsWith("token=", StringComparison.OrdinalIgnoreCase))
            .ToArray();
        var originalCount = cover[(queryIndex + 1)..]
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Length;
        if (parts.Length == originalCount)
        {
            return track;
        }

        var rebuilt = parts.Length > 0 ? prefix + "?" + string.Join("&", parts) : prefix;
        return track with { Cover = rebuilt };
    }
}
