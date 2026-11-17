using System.IO;
using Zilux2.Wallpaper.Data;
using Zilux2.Wallpaper.Media;
using Zilux2.Wallpaper.Model;

namespace Zilux2.Wallpaper.Library;

/// <summary>扫描进度（第 102 轮 A：导入排队/进度要能看到）。</summary>
internal sealed record ScanProgress(string Stage, int Done, int Total, string? Current);

/// <summary>一次扫描的结果。</summary>
internal sealed record ScanResult(int Added, int Updated, int Missing, int Skipped)
{
    public int Total => Added + Updated + Skipped;
}

/// <summary>
/// 素材扫描（第 2 轮 E）：工坊自动发现 + 监视目录递归，三路来源统一入 SQLite。
/// 启动时静默跑（第 61 轮 A），不阻塞 UI；调用方把它丢到后台线程。
/// </summary>
internal sealed class LibraryScanner
{
    /// <summary>监视目录最多往下走几层，防止误加 C:\ 这种根目录时扫爆。</summary>
    private const int MaxDepth = 4;

    private static readonly string[] VideoExtensions =
        { ".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v", ".wmv", ".flv", ".ts", ".mpg", ".mpeg" };

    private static readonly string[] GifExtensions = { ".gif" };

    private static readonly string[] ImageExtensions =
        { ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff" };

    private readonly LibraryStore _store;

    public LibraryScanner(LibraryStore store) => _store = store;

    /// <summary>进度回调（可在后台线程触发，UI 侧自己切线程）。</summary>
    public event Action<ScanProgress>? Progress;

    /// <summary>判断扩展名是不是壁纸素材。</summary>
    public static bool IsSupported(string path)
    {
        var extension = Path.GetExtension(path);
        return VideoExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase)
            || GifExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase)
            || ImageExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>
    /// 全量扫描：工坊 + 监视目录。返回新增/更新/失联统计。
    /// <paramref name="full"/> 为 false 时跳过已入库且未改动的文件（mtime/size 没变）。
    /// </summary>
    public ScanResult Scan(IReadOnlyList<string> watchFolders, bool full, CancellationToken token)
    {
        var candidates = new List<(string Path, AssetSource Source, string? Cover, string Title)>();

        foreach (var item in WorkshopLocator.Enumerate())
        {
            token.ThrowIfCancellationRequested();
            candidates.Add((item.MediaPath, AssetSource.Workshop, item.CoverPath, item.Title));
        }

        foreach (var folder in watchFolders)
        {
            token.ThrowIfCancellationRequested();
            if (!Directory.Exists(folder)) continue;
            CollectFolder(folder, 0, candidates, token);
        }

        var added = 0;
        var updated = 0;
        var skipped = 0;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var total = candidates.Count;

        for (var index = 0; index < candidates.Count; index++)
        {
            token.ThrowIfCancellationRequested();
            var (path, source, cover, title) = candidates[index];
            Progress?.Invoke(new ScanProgress("scan", index + 1, total, Path.GetFileName(path)));

            var stored = Upsert(path, source, cover, title, full);
            if (stored is null)
            {
                skipped++;
                continue;
            }

            seen.Add(path);
            if (stored.Value.Created) added++; else updated++;
        }

        var missing = 0;
        foreach (var asset in _store.ListForScan())
        {
            token.ThrowIfCancellationRequested();
            if (asset.Source == AssetSource.Import) continue; // 导入副本只由删除动作处理
            if (seen.Contains(asset.Path)) continue;
            if (!asset.Missing && !File.Exists(asset.Path))
            {
                _store.SetMissing(asset.Id, true);
                missing++;
            }
        }

        Progress?.Invoke(new ScanProgress("done", total, total, null));
        return new ScanResult(added, updated, missing, skipped);
    }

    /// <summary>导入：按需复制进库目录（第 33 轮 C），返回入库成功的 id 列表。</summary>
    public List<long> Import(IReadOnlyList<string> paths, bool copy, CancellationToken token)
    {
        WallpaperFolders.Ensure();
        var ids = new List<long>();

        for (var index = 0; index < paths.Count; index++)
        {
            token.ThrowIfCancellationRequested();
            var source = paths[index];
            Progress?.Invoke(new ScanProgress("import", index + 1, paths.Count, Path.GetFileName(source)));

            if (!File.Exists(source) || !IsSupported(source)) continue;

            var target = source;
            if (copy)
            {
                var name = Path.GetFileName(source);
                var destination = Path.Combine(WallpaperFolders.Library, name);
                var suffix = 1;
                while (File.Exists(destination) && !string.Equals(destination, source, StringComparison.OrdinalIgnoreCase))
                {
                    destination = Path.Combine(
                        WallpaperFolders.Library,
                        $"{Path.GetFileNameWithoutExtension(name)} ({suffix}){Path.GetExtension(name)}");
                    suffix++;
                }

                try
                {
                    File.Copy(source, destination, overwrite: false);
                    target = destination;
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    continue;
                }
            }

            if (Upsert(target, AssetSource.Import, null, Path.GetFileNameWithoutExtension(target), full: true) is { } result && result.Created)
            {
                ids.Add(result.Id);
            }
        }

        return ids;
    }

    private void CollectFolder(
        string folder,
        int depth,
        List<(string Path, AssetSource Source, string? Cover, string Title)> sink,
        CancellationToken token)
    {
        if (depth > MaxDepth) return;

        IEnumerable<string> files;
        try
        {
            files = Directory.EnumerateFiles(folder);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return;
        }

        foreach (var file in files)
        {
            token.ThrowIfCancellationRequested();
            if (IsSupported(file))
            {
                sink.Add((file, AssetSource.Watch, null, Path.GetFileNameWithoutExtension(file)));
            }
        }

        try
        {
            foreach (var child in Directory.EnumerateDirectories(folder))
            {
                token.ThrowIfCancellationRequested();
                CollectFolder(child, depth + 1, sink, token);
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // 权限不足的子目录直接跳过。
        }
    }

    /// <summary>把单个文件写进库（新增或更新），返回 (是否新增, id)；无法处理返回 null。</summary>
    private (bool Created, long Id)? Upsert(
        string path,
        AssetSource source,
        string? cover,
        string title,
        bool full)
    {
        FileInfo info;
        try
        {
            info = new FileInfo(path);
            if (!info.Exists || info.Length == 0) return null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        var existing = _store.FindByPath(path);
        if (existing is not null && !full &&
            existing.SizeBytes == info.Length &&
            existing.LastSeenAt is { } seenAt &&
            seenAt >= new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds())
        {
            // 文件没动过，但元数据可能变了（比如工坊项目的标题改了、旧版本把标题存成了文件夹名）。
            // 这里只补元数据，不重新哈希/探测，开销可以忽略。
            if (!string.IsNullOrWhiteSpace(title) && !string.Equals(existing.Title, title, StringComparison.Ordinal))
            {
                existing.Title = title;
                if (!string.IsNullOrWhiteSpace(cover)) existing.CoverPath ??= cover;
                _store.Save(existing);
                return (true, existing.Id);
            }

            return (false, existing.Id);
        }

        var hash = FileHasher.Compute(path);
        if (hash is null) return null;

        // 同内容已经在库里（比如工坊和监视目录指向同一文件）就不再入第二条。
        var duplicate = _store.FindByHash(hash);
        if (duplicate is not null && !string.Equals(duplicate.Path, path, StringComparison.OrdinalIgnoreCase))
        {
            return (false, duplicate.Id);
        }

        var kind = MediaProbe.KindOf(path);
        if (kind is null) return null;

        var probe = MediaProbe.Probe(path, kind.Value);

        var asset = existing ?? new WallpaperAsset { AddedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        asset.Path = path;
        asset.Hash = hash;
        asset.Source = source;
        asset.Kind = kind.Value;
        asset.Width = probe.Width;
        asset.Height = probe.Height;
        asset.DurationMs = probe.DurationMs;
        asset.Fps = probe.Fps;
        asset.SizeBytes = info.Length;
        asset.LastSeenAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        asset.Missing = false;
        if (asset.Title.Length == 0) asset.Title = title;
        if (cover is not null) asset.CoverPath = cover;

        var created = existing is null;
        var id = _store.Save(asset);

        // 封面按 id 命名，必须在入库拿到 id 之后抽。
        asset.Id = id;
        if (string.IsNullOrEmpty(asset.CoverPath) || !File.Exists(asset.CoverPath))
        {
            var generated = Thumbnailer.Ensure(asset);
            if (generated is not null)
            {
                asset.CoverPath = generated;
                _store.Save(asset);
            }
        }

        return (created, id);
    }
}
