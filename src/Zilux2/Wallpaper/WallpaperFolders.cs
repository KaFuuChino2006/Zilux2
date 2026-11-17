using System.IO;

namespace Zilux2.Wallpaper;

/// <summary>
/// 动态壁纸模块的磁盘布局（docs/wallpaper-v2-spec.md §4）。
/// 全部放在 %LOCALAPPDATA%\Zilux2\wallpaper 下，和日志目录同级，卸载时一样删。
/// </summary>
internal static class WallpaperFolders
{
    /// <summary>模块根目录。</summary>
    public static string Root { get; } = Path.Combine(HostFolders.Root, "wallpaper");

    /// <summary>导入副本目录：手动添加的素材复制到这里，原文件删了也不影响壁纸。</summary>
    public static string Library { get; } = Path.Combine(Root, "library");

    /// <summary>封面抽帧缓存。清缓存只删这里，不动 library。</summary>
    public static string Covers { get; } = Path.Combine(Root, "covers");

    /// <summary>SQLite 索引库。</summary>
    public static string Database { get; } = Path.Combine(Root, "wallpaper.db");

    /// <summary>首次使用时建目录；重复调用无害。</summary>
    public static void Ensure()
    {
        Directory.CreateDirectory(Root);
        Directory.CreateDirectory(Library);
        Directory.CreateDirectory(Covers);
    }
}
