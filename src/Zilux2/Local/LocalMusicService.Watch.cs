using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;

namespace Zilux2.Local;

/// <summary>
/// 「本地音乐目录自动监控」：把 <see cref="LocalFolderWatcher"/> 去抖后的变化增量地映射到内存曲库，
/// 需要结构性刷新时退化成一次后台全量扫描；所有 UI 交互（重推 localLibrary）一律切回 UI Dispatcher。
/// </summary>
internal sealed partial class LocalMusicService : IDisposable
{
    /// <summary>单文件变化合并窗口：目录事件先攒 1.3s，避免逐事件扫盘。</summary>
    private const int WatchDebounceMs = 1300;

    /// <summary>一个批次超过这么多路径时，增量处理不如整体重扫划算。</summary>
    private const int WatchBatchRescanThreshold = 30;

    /// <summary>宿主自己写/删文件后，这段时间内 watcher 触发的事件忽略掉。</summary>
    private const int WatchHostWriteSuppressMs = 15000;

    private static readonly Comparison<LocalTrackDto> FolderTrackOrder = static (left, right) =>
    {
        var compare = string.CompareOrdinal(left.Rel, right.Rel);
        return compare != 0 ? compare : left.StartMs.CompareTo(right.StartMs);
    };

    private readonly object _selfWriteGate = new();
    private readonly Dictionary<string, long> _recentHostWrites = new(StringComparer.OrdinalIgnoreCase);
    private LocalFolderWatcher? _folderWatcher;
    private volatile bool _disposed;
    private int _rescanBusy;
    private int _rescanPending;

    /// <summary>Load() 成功后调用：开始监听当前曲库目录（同一目录幂等；换目录会重建监听）。</summary>
    private void StartFolderWatch(string folder)
    {
        if (_disposed || string.IsNullOrWhiteSpace(folder))
        {
            return;
        }

        if (IsFileSystemRoot(folder))
        {
            // 盘符/UNC 共享根目录递归监听代价太大且通常不是用户想要的曲库范围，直接跳过。
            HostLog.Warn($"[local] watch skipped: filesystem root {folder}");
            return;
        }

        try
        {
            _folderWatcher ??= new LocalFolderWatcher(OnWatchBatch, WatchDebounceMs);
            _folderWatcher.Start(folder);
        }
        catch (Exception exception)
        {
            HostLog.Error($"[local] watch start failed: {folder}", exception);
        }
    }

    /// <summary>停止监听（切换目录失败/扫描失败/Dispose 时调用）。</summary>
    private void StopFolderWatch()
    {
        var watcher = _folderWatcher;
        _folderWatcher = null;
        if (watcher is null)
        {
            return;
        }

        try
        {
            watcher.Dispose();
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] watch dispose failed: {exception.Message}");
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        Interlocked.Exchange(ref _rescanPending, 0);
        StopFolderWatch();
        lock (_selfWriteGate)
        {
            _recentHostWrites.Clear();
        }

        HostLog.Info("[local] watcher disposed");
    }

    /// <summary>宿主自己即将改动某个文件（删除/下载落盘）时登记，watcher 在窗口期内不重复处理该路径。</summary>
    private void MarkHostWrite(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(path);
        }
        catch
        {
            return;
        }

        var now = Environment.TickCount64;
        lock (_selfWriteGate)
        {
            if (_recentHostWrites.Count > 256)
            {
                PruneHostWritesLocked(now);
            }

            _recentHostWrites[fullPath] = now;
        }
    }

    private bool IsRecentHostWrite(string fullPath)
    {
        var now = Environment.TickCount64;
        lock (_selfWriteGate)
        {
            if (_recentHostWrites.Count == 0)
            {
                return false;
            }

            if (_recentHostWrites.TryGetValue(fullPath, out var stamp))
            {
                if (now - stamp <= WatchHostWriteSuppressMs)
                {
                    return true;
                }

                _recentHostWrites.Remove(fullPath);
                return false;
            }

            if (_recentHostWrites.Count > 256)
            {
                PruneHostWritesLocked(now);
            }

            return false;
        }
    }

    private void PruneHostWritesLocked(long now)
    {
        var stale = new List<string>();
        foreach (var entry in _recentHostWrites)
        {
            if (now - entry.Value > WatchHostWriteSuppressMs)
            {
                stale.Add(entry.Key);
            }
        }

        foreach (var key in stale)
        {
            _recentHostWrites.Remove(key);
        }
    }

    /// <summary>把一段 UI 工作切回 Dispatcher（已在 UI 线程则直接执行）；宿主关闭后静默丢弃。</summary>
    private void PostOnUi(Action action)
    {
        if (_disposed)
        {
            return;
        }

        void Wrapped()
        {
            if (_disposed)
            {
                return;
            }

            try
            {
                action();
            }
            catch (Exception exception)
            {
                HostLog.Error("[local] watch ui apply failed", exception);
            }
        }

        try
        {
            var dispatcher = _window.Dispatcher;
            if (dispatcher.HasShutdownStarted || dispatcher.HasShutdownFinished)
            {
                return;
            }

            if (dispatcher.CheckAccess())
            {
                Wrapped();
                return;
            }

            dispatcher.BeginInvoke(DispatcherPriority.Background, (Action)Wrapped);
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] watch ui dispatch failed: {exception.Message}");
        }
    }

    /// <summary>watcher 批次入口：跑在线程池线程上，只做过滤 + 单文件读取，UI 更新一律 PostOnUi。</summary>
    private void OnWatchBatch(LocalWatchBatch batch)
    {
        if (_disposed)
        {
            return;
        }

        var root = NormalizeFolder(batch.Folder);
        if (root.Length == 0 || !IsCurrentFolder(root))
        {
            // 切目录时旧 watcher 的滞后批次，直接丢弃。
            HostLog.Info($"[local] watch ignore stale batch: {batch.Folder}");
            return;
        }

        if (batch.Structural || batch.Overflow)
        {
            HostLog.Info($"[local] watch batch needs rescan: structural={batch.Structural} overflow={batch.Overflow} ({root})");
            RequestFolderRescan(root);
            return;
        }

        var touched = new List<string>(batch.Paths.Count);
        foreach (var path in batch.Paths)
        {
            if (!IsUnderRoot(root, path) || IsInHiddenDirectory(root, path))
            {
                continue;
            }

            if (IsRecentHostWrite(path))
            {
                HostLog.Info($"[local] watch skip self change: {path}");
                continue;
            }

            touched.Add(path);
        }

        if (touched.Count == 0)
        {
            return;
        }

        if (touched.Count > WatchBatchRescanThreshold)
        {
            HostLog.Info($"[local] watch batch too large ({touched.Count} paths), rescan instead");
            RequestFolderRescan(root);
            return;
        }

        var removals = new List<string>();
        var upserts = new List<LocalTrackDto>();
        var lyricAdds = new List<string>();
        var lyricRemovals = new List<string>();
        var missing = new List<string>();

        foreach (var path in touched)
        {
            var relative = ToRelative(root, path);
            if (relative.Length == 0)
            {
                continue;
            }

            var extension = Path.GetExtension(path);
            var existsFile = false;
            var existsDirectory = false;
            try
            {
                existsFile = File.Exists(path);
                existsDirectory = Directory.Exists(path);
            }
            catch
            {
                // best effort：读不到就当不存在。
            }

            // 目录结构变化、CUE 变化都要重扫（CUE 会把镜像拆成多轨）。
            if (existsDirectory || string.Equals(extension, ".cue", StringComparison.OrdinalIgnoreCase))
            {
                HostLog.Info($"[local] watch structure change: {relative} (rescan)");
                RequestFolderRescan(root);
                return;
            }

            if (string.Equals(extension, ".lrc", StringComparison.OrdinalIgnoreCase))
            {
                if (existsFile)
                {
                    lyricAdds.Add(relative);
                }
                else
                {
                    lyricRemovals.Add(relative);
                }

                continue;
            }

            if (AudioExtensions.Contains(extension))
            {
                if (!existsFile)
                {
                    removals.Add(relative);
                    continue;
                }

                var dto = TryBuildTrack(path, relative);
                if (dto is null)
                {
                    removals.Add(relative);
                }
                else
                {
                    upserts.Add(dto);
                }

                continue;
            }

            if (!existsFile)
            {
                // 非音频文件消失：如果它在某个目录里，可能是整个目录被删，交给 UI 线程判断子树。
                missing.Add(relative);
            }
        }

        if (upserts.Count == 0 && removals.Count == 0 && lyricAdds.Count == 0 && lyricRemovals.Count == 0 && missing.Count == 0)
        {
            return;
        }

        var rawEvents = batch.RawEvents;
        PostOnUi(() => ApplyWatchChanges(root, removals, upserts, lyricAdds, lyricRemovals, missing, rawEvents));
    }

    /// <summary>把一批增量变化（+/- 单个文件）应用到内存曲库，并在 UI 线程上重推 localLibrary。</summary>
    private void ApplyWatchChanges(
        string root,
        List<string> removals,
        List<LocalTrackDto> upserts,
        List<string> lyricAdds,
        List<string> lyricRemovals,
        List<string> missing,
        int rawEvents)
    {
        if (_disposed || !IsCurrentFolder(root))
        {
            return;
        }

        // 有目录/子树的痕迹时，宁可整体重扫，也不要留半截列表。
        if (missing.Count > 0 && HasTrackedEntriesUnder(missing))
        {
            HostLog.Info($"[local] watch subtree vanished under {root} (rescan)");
            RequestFolderRescan(root);
            return;
        }

        if (HasCueTrackTouched(upserts, removals))
        {
            HostLog.Info($"[local] watch cue track changed under {root} (rescan)");
            RequestFolderRescan(root);
            return;
        }

        var removeSet = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var relative in removals)
        {
            removeSet.Add(relative);
        }

        var removed = removeSet.Count == 0 ? 0 : _folderTracks.RemoveAll(track => removeSet.Contains(track.Rel));

        var added = 0;
        foreach (var dto in upserts)
        {
            var index = _folderTracks.FindIndex(track => string.Equals(track.Rel, dto.Rel, StringComparison.OrdinalIgnoreCase));
            if (index >= 0)
            {
                _folderTracks[index] = dto;
                added += 1;
                continue;
            }

            if (_folderTracks.Count >= MaxTracks)
            {
                HostLog.Warn($"[local] watch track cap reached ({MaxTracks}), skip {dto.Rel}");
                continue;
            }

            _folderTracks.Add(dto);
            added += 1;
        }

        var lyricsChanged = false;
        foreach (var relative in lyricRemovals)
        {
            if (_folderLyrics.RemoveAll(lyric => string.Equals(lyric, relative, StringComparison.OrdinalIgnoreCase)) > 0)
            {
                lyricsChanged = true;
            }
        }

        foreach (var relative in lyricAdds)
        {
            if (_folderLyrics.Count >= 2000)
            {
                continue;
            }

            if (_folderLyrics.Exists(lyric => string.Equals(lyric, relative, StringComparison.OrdinalIgnoreCase)))
            {
                continue;
            }

            _folderLyrics.Add(relative);
            lyricsChanged = true;
        }

        if (added == 0 && removed == 0 && !lyricsChanged)
        {
            return;
        }

        if (added > 0 || removed > 0)
        {
            _folderTracks.Sort(FolderTrackOrder);
        }

        HostLog.Info($"[local] watch incremental: +{added} -{removed} lyrics={lyricsChanged} raw={rawEvents} ({root})");
        PostMergedTracks();
    }

    /// <summary>请求一次后台全量重扫；同一时间只跑一个扫描循环，重复请求合并成一次补扫。</summary>
    private void RequestFolderRescan(string root)
    {
        if (_disposed || root.Length == 0)
        {
            return;
        }

        Interlocked.Exchange(ref _rescanPending, 1);
        StartFolderRescanWorker(root);
    }

    private void StartFolderRescanWorker(string root)
    {
        if (Interlocked.CompareExchange(ref _rescanBusy, 1, 0) != 0)
        {
            return;
        }

        _ = Task.Run(() => RescanLoop(root));
    }

    /// <summary>后台扫描循环：扫描全部在线程池线程，结果切回 UI 线程应用。</summary>
    private void RescanLoop(string root)
    {
        try
        {
            while (true)
            {
                Interlocked.Exchange(ref _rescanPending, 0);
                if (_disposed || !IsCurrentFolder(root))
                {
                    return;
                }

                List<LocalTrackDto> tracks;
                var lyrics = new List<string>();
                try
                {
                    var started = Environment.TickCount64;
                    tracks = Scan(root, lyrics);
                    HostLog.Info($"[local] watch rescan: {root} ({tracks.Count} tracks, {lyrics.Count} lyrics, {Environment.TickCount64 - started}ms)");
                }
                catch (Exception exception)
                {
                    HostLog.Error($"[local] watch rescan failed: {root}", exception);
                    return;
                }

                PostOnUi(() => ApplyRescan(root, tracks, lyrics));

                if (Interlocked.Exchange(ref _rescanPending, 0) == 0)
                {
                    return;
                }

                HostLog.Info($"[local] watch rescan again (changes arrived while scanning): {root}");
            }
        }
        finally
        {
            Interlocked.Exchange(ref _rescanBusy, 0);
            // 关窗竞态：busy 清零后再看一眼有没有新请求，别把它饿死。
            if (!_disposed && Volatile.Read(ref _rescanPending) != 0)
            {
                RequestFolderRescan(root);
            }
        }
    }

    private void ApplyRescan(string root, List<LocalTrackDto> tracks, List<string> lyrics)
    {
        if (_disposed || !IsCurrentFolder(root))
        {
            return;
        }

        _folderTracks = tracks;
        _folderLyrics = lyrics;
        HostLog.Info($"[local] watch rescan applied: {tracks.Count} tracks, {lyrics.Count} lyrics ({root})");
        PostMergedTracks();
    }

    private static LocalTrackDto? TryBuildTrack(string fullPath, string relative)
    {
        try
        {
            var info = new FileInfo(fullPath);
            if (!info.Exists || info.Length == 0)
            {
                return null;
            }

            var fileName = Path.GetFileNameWithoutExtension(fullPath);
            string? tagTitle = null;
            string? tagArtist = null;
            try
            {
                var tags = LocalTagReader.TryRead(fullPath);
                if (tags is not null)
                {
                    tagTitle = tags.Title;
                    tagArtist = tags.Artist;
                }
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[local] watch read tags failed {relative}: {exception.Message}");
            }

            if (tagArtist is null && TrySplitArtistTitle(fileName, out var splitArtist, out var splitTitle))
            {
                tagArtist = splitArtist;
                tagTitle ??= splitTitle;
            }

            return new LocalTrackDto
            {
                Rel = relative,
                Name = tagTitle ?? fileName,
                Title = tagTitle,
                Artist = tagArtist,
                Size = info.Length,
                HasCover = LocalCover.Has(fullPath),
            };
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[local] watch read track failed {relative}: {exception.Message}");
            return null;
        }
    }

    /// <summary>被删路径里是否有当前曲库正在跟踪的条目（说明是目录/子树被整体删掉）。</summary>
    private bool HasTrackedEntriesUnder(List<string> relativePaths)
    {
        foreach (var relative in relativePaths)
        {
            var prefix = relative + "/";
            foreach (var track in _folderTracks)
            {
                if (track.Rel.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            foreach (var lyric in _folderLyrics)
            {
                if (lyric.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>变化涉及 CUE 拆出来的分轨（同一镜像文件多首）时不能按普通单曲替换，整目录重扫。</summary>
    private bool HasCueTrackTouched(List<LocalTrackDto> upserts, List<string> removals)
    {
        if (_folderTracks.Count == 0)
        {
            return false;
        }

        foreach (var dto in upserts)
        {
            if (IsCueTrack(dto.Rel))
            {
                return true;
            }
        }

        foreach (var relative in removals)
        {
            if (IsCueTrack(relative))
            {
                return true;
            }
        }

        return false;
    }

    private bool IsCueTrack(string rel)
    {
        foreach (var track in _folderTracks)
        {
            if (track.Cue > 0 && string.Equals(track.Rel, rel, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private bool IsCurrentFolder(string root) =>
        string.Equals(NormalizeFolder(_currentFolder), root, StringComparison.OrdinalIgnoreCase);

    private static bool IsFileSystemRoot(string folder)
    {
        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(folder));
            return !string.IsNullOrEmpty(root)
                && string.Equals(NormalizeFolder(root), NormalizeFolder(folder), StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsUnderRoot(string root, string path)
    {
        if (path.Length <= root.Length + 1)
        {
            return false;
        }

        if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var next = path[root.Length];
        return next == Path.DirectorySeparatorChar || next == Path.AltDirectorySeparatorChar;
    }

    private static string ToRelative(string root, string path)
    {
        try
        {
            return Path.GetRelativePath(root, path).Replace('\\', '/');
        }
        catch
        {
            return string.Empty;
        }
    }

    /// <summary>与 Scan 一致：跳过以「.」开头的目录（隐藏/缓存目录）。</summary>
    private static bool IsInHiddenDirectory(string root, string path)
    {
        var relative = ToRelative(root, path);
        var slash = relative.LastIndexOf('/');
        if (slash <= 0)
        {
            return false;
        }

        var directory = relative[..slash];
        var start = 0;
        while (start < directory.Length)
        {
            var end = directory.IndexOf('/', start);
            if (end < 0)
            {
                end = directory.Length;
            }

            if (end > start && directory[start] == '.')
            {
                return true;
            }

            start = end + 1;
        }

        return false;
    }

    private static string NormalizeFolder(string folder)
    {
        if (string.IsNullOrEmpty(folder))
        {
            return string.Empty;
        }

        try
        {
            return Path.TrimEndingDirectorySeparator(folder);
        }
        catch
        {
            return folder;
        }
    }
}
