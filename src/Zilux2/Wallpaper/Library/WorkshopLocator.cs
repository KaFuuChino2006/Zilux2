using System.IO;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Zilux2.Wallpaper.Library;

/// <summary>Wallpaper Engine 工坊里的一个条目。</summary>
internal sealed record WorkshopItem(string Folder, string MediaPath, string? CoverPath, string Title, long PublishedId);

/// <summary>
/// 找机器上的 Wallpaper Engine 创意工坊内容（第 2 轮 E 的第二条素材来源）。
/// 只读：不写工坊目录、不复制文件，直接引用原路径（第 33 轮 C）。
/// </summary>
internal static partial class WorkshopLocator
{
    /// <summary>Wallpaper Engine 的创意工坊 appid。</summary>
    public const string WallpaperEngineAppId = "431960";

    private static readonly string[] VideoExtensions = { ".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v" };

    [GeneratedRegex("\"path\"\\s+\"([^\"]+)\"", RegexOptions.CultureInvariant)]
    private static partial Regex LibraryPathRegex();

    // project.json 是 JSON，键值之间有冒号（"title" : "..."）；VDF 那种纯空白分隔在这里匹配不到，
    // 匹配失败就会把标题回落成文件夹名（也就是工坊 id），库页上看到一串数字。
    [GeneratedRegex("\"title\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"", RegexOptions.CultureInvariant)]
    private static partial Regex TitleRegex();

    /// <summary>列出所有已安装的工坊条目。找不到 Steam 或没有工坊时返回空集合，不抛。</summary>
    public static List<WorkshopItem> Enumerate()
    {
        var items = new List<WorkshopItem>();
        foreach (var library in EnumerateSteamLibraries())
        {
            var contentRoot = Path.Combine(library, "steamapps", "workshop", "content", WallpaperEngineAppId);
            if (!Directory.Exists(contentRoot)) continue;

            IEnumerable<string> folders;
            try
            {
                folders = Directory.EnumerateDirectories(contentRoot);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                continue;
            }

            foreach (var folder in folders)
            {
                var item = ReadItem(folder);
                if (item is not null) items.Add(item);
            }
        }

        return items;
    }

    /// <summary>读单个工坊项目目录；没有可播放媒体时返回 null。</summary>
    private static WorkshopItem? ReadItem(string folder)
    {
        string? media = null;
        try
        {
            foreach (var file in Directory.EnumerateFiles(folder))
            {
                if (VideoExtensions.Contains(Path.GetExtension(file), StringComparer.OrdinalIgnoreCase))
                {
                    media = file;
                    break;
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        if (media is null) return null;

        var cover = FindCover(folder);
        var title = ReadTitle(folder) ?? Path.GetFileName(folder);
        var publishedId = long.TryParse(Path.GetFileName(folder), out var id) ? id : 0;
        return new WorkshopItem(folder, media, cover, title, publishedId);
    }

    private static string? FindCover(string folder)
    {
        // 有自带 preview 就用自带的（第 62 轮：wallpaper 有自己的封面就用自己的）。
        foreach (var name in new[] { "preview.gif", "preview.jpg", "preview.png", "preview.jpeg" })
        {
            var path = Path.Combine(folder, name);
            if (File.Exists(path)) return path;
        }

        return null;
    }

    private static string? ReadTitle(string folder)
    {
        var project = Path.Combine(folder, "project.json");
        if (!File.Exists(project)) return null;

        try
        {
            var text = File.ReadAllText(project);
            var match = TitleRegex().Match(text);
            if (!match.Success) return null;

            // project.json 里的 JSON 字符串转义只处理最常见的几种。
            return match.Groups[1].Value
                .Replace("\\\"", "\"", StringComparison.Ordinal)
                .Replace("\\\\", "\\", StringComparison.Ordinal)
                .Trim();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Steam 安装目录 → 所有库根目录（含注册表给的默认库）。</summary>
    private static List<string> EnumerateSteamLibraries()
    {
        var libraries = new List<string>();
        var steamPath = FindSteamPath();
        if (steamPath is null) return libraries;

        void Add(string? path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            var normalized = path.Trim().Replace("\\\\", "\\", StringComparison.Ordinal);
            if (Directory.Exists(normalized) && !libraries.Contains(normalized, StringComparer.OrdinalIgnoreCase))
            {
                libraries.Add(normalized);
            }
        }

        Add(steamPath);

        var vdf = Path.Combine(steamPath, "steamapps", "libraryfolders.vdf");
        if (!File.Exists(vdf)) return libraries;

        try
        {
            var text = File.ReadAllText(vdf);
            foreach (Match match in LibraryPathRegex().Matches(text))
            {
                Add(match.Groups[1].Value);
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // 读不到 vdf 就只用默认库。
        }

        return libraries;
    }

    private static string? FindSteamPath()
    {
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            try
            {
                using var key = RegistryKey.OpenBaseKey(hive, RegistryView.Registry32)
                    .OpenSubKey(@"Software\Valve\Steam");
                if (key?.GetValue("SteamPath") is string path && !string.IsNullOrWhiteSpace(path))
                {
                    return path;
                }
            }
            catch (Exception exception) when (exception is UnauthorizedAccessException or System.Security.SecurityException or IOException)
            {
                // 注册表不可读就试下一个 hive。
            }
        }

        return null;
    }
}
