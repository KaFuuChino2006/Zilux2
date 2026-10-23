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
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException)
        {
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

            try
            {
                File.WriteAllText(_path, JsonSerializer.Serialize(_tracks));
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                OnlineHttp.Warn($"[recent] persist failed: {exception.GetType().Name}");
            }
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
}
