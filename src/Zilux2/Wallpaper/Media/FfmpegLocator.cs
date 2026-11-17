using System.IO;

namespace Zilux2.Wallpaper.Media;

/// <summary>
/// 定位 FFmpeg / FFprobe 可执行文件（第 10 轮：内置 FFmpeg 全覆盖解码）。
/// 查找顺序：环境变量 → exe 同目录 ffmpeg\ → PATH → 开发机约定目录。
/// 都找不到时由调用方降级到系统解码器，并在诊断面板里显示「未找到 FFmpeg」。
/// </summary>
internal static class FfmpegLocator
{
    private static readonly Lazy<string?> FfmpegPathLazy = new(() => Locate("ffmpeg.exe"));
    private static readonly Lazy<string?> FfprobePathLazy = new(() => Locate("ffprobe.exe"));

    /// <summary>ffmpeg.exe 的绝对路径；找不到为 null。</summary>
    public static string? FfmpegPath => FfmpegPathLazy.Value;

    /// <summary>ffprobe.exe 的绝对路径；找不到为 null。</summary>
    public static string? FfprobePath => FfprobePathLazy.Value;

    public static bool Available => FfmpegPath is not null;

    private static string? Locate(string exeName)
    {
        // 1) 显式覆盖：ZILUX2_FFMPEG_DIR 指向含 ffmpeg.exe 的目录。
        var configured = Environment.GetEnvironmentVariable("ZILUX2_FFMPEG_DIR");
        if (!string.IsNullOrWhiteSpace(configured))
        {
            var candidate = Path.Combine(configured, exeName);
            if (File.Exists(candidate)) return candidate;
        }

        var baseDirectory = AppContext.BaseDirectory;

        // 2) 随包分发：<exe目录>\ffmpeg\ffmpeg.exe。
        var bundled = Path.Combine(baseDirectory, "ffmpeg", exeName);
        if (File.Exists(bundled)) return bundled;

        // 3) PATH。
        var pathVariable = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var directory in pathVariable.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var candidate = Path.Combine(directory.Trim('"'), exeName);
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException)
            {
                // PATH 里可能有非法字符，跳过即可。
            }
        }

        // 4) 本机开发约定目录（找不到就算了，正式包会走 2）。
        foreach (var root in new[] { @"E:\zilux-bin\ffmpeg", @"C:\ffmpeg" })
        {
            if (!Directory.Exists(root)) continue;
            try
            {
                foreach (var candidate in Directory.EnumerateFiles(root, exeName, SearchOption.AllDirectories))
                {
                    return candidate;
                }
            }
            catch (IOException)
            {
                // 目录不可读就跳过。
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        return null;
    }
}
