using System.Diagnostics;
using System.IO;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Zilux2.Wallpaper.Media;
using Zilux2.Wallpaper.Model;

namespace Zilux2.Wallpaper.Library;

/// <summary>
/// 封面生成（第 62 轮）：工坊自带 preview 就直接用；没有就抽帧，抽帧自动跳过黑场。
/// 视频交给 ffmpeg 的 thumbnail 滤镜（它会分析前若干帧挑最有代表性的一帧），
/// 图片与 GIF 用 WPF 解码首帧后等比缩放——这两类没有"黑场"问题。
/// </summary>
internal static class Thumbnailer
{
    private const string FfmpegOutputArguments = "-hide_banner -loglevel error -nostdin -y";

    /// <summary>封面文件路径（按素材 id 命名，删素材时一起清）。</summary>
    public static string CoverPath(long id) => Path.Combine(WallpaperFolders.Covers, $"{id}.jpg");

    /// <summary>
    /// 给一条素材准备封面，返回封面路径（已存在则直接复用）。
    /// 失败返回 null，调用方保留“无封面”状态（第 102 轮：损坏文件要友好提示而不是崩）。
    /// </summary>
    public static string? Ensure(WallpaperAsset asset, int width = 480)
    {
        WallpaperFolders.Ensure();

        // 工坊条目自带的 preview 直接用，不再抽帧。
        if (!string.IsNullOrEmpty(asset.CoverPath) && File.Exists(asset.CoverPath))
        {
            return asset.CoverPath;
        }

        var target = CoverPath(asset.Id);
        if (File.Exists(target) && new FileInfo(target).Length > 0)
        {
            return target;
        }

        if (!File.Exists(asset.Path)) return null;

        return asset.Kind switch
        {
            AssetKind.Video => FromVideo(asset.Path, target, width, asset.TrimInMs),
            AssetKind.Gif or AssetKind.Image => FromBitmap(asset.Path, target, width),
            _ => null,
        };
    }

    /// <summary>视频抽帧：thumbnail 滤镜挑代表帧，再缩到封面宽度。</summary>
    private static string? FromVideo(string path, string target, int width, long? trimInMs)
    {
        var ffmpeg = FfmpegLocator.FfmpegPath;
        if (ffmpeg is null) return null;

        var startInfo = new ProcessStartInfo(ffmpeg)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };

        void Arg(string value) => startInfo.ArgumentList.Add(value);

        foreach (var part in FfmpegOutputArguments.Split(' ', StringSplitOptions.RemoveEmptyEntries)) Arg(part);

        // 有入点时从入点开始挑帧，否则从片头 0 开始（thumbnail 会自然跳过开头的黑场）。
        if (trimInMs is > 0)
        {
            Arg("-ss");
            Arg((trimInMs.Value / 1000.0).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
        }

        Arg("-i"); Arg(path);
        Arg("-vf"); Arg($"thumbnail=120,scale={width}:-2");
        Arg("-frames:v"); Arg("1");
        Arg("-q:v"); Arg("3");
        Arg(target);

        try
        {
            using var process = Process.Start(startInfo);
            if (process is null) return null;

            // ffmpeg 可能一直等到 stdio 关闭才退出：先自然等，再强制回收。
            if (!process.WaitForExit(20000))
            {
                try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
                return null;
            }

            return process.ExitCode == 0 && File.Exists(target) ? target : null;
        }
        catch (Exception exception) when (exception is IOException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>图片 / GIF 首帧缩放成 JPG。</summary>
    private static string? FromBitmap(string path, string target, int width)
    {
        try
        {
            var decoder = BitmapDecoder.Create(
                new Uri(path, UriKind.Absolute),
                BitmapCreateOptions.IgnoreColorProfile,
                BitmapCacheOption.OnLoad);

            if (decoder.Frames.Count == 0) return null;

            var frame = decoder.Frames[0];
            var scale = width / (double)Math.Max(1, frame.PixelWidth);
            var transformed = new TransformedBitmap(frame, new ScaleTransform(scale, scale));
            transformed.Freeze();

            var encoder = new JpegBitmapEncoder { QualityLevel = 88 };
            encoder.Frames.Add(BitmapFrame.Create(transformed));
            using var stream = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None);
            encoder.Save(stream);
            return target;
        }
        catch (Exception exception) when (exception is IOException or NotSupportedException or InvalidOperationException or ArgumentException)
        {
            return null;
        }
    }

    /// <summary>删素材时清掉封面。</summary>
    public static void Delete(long id)
    {
        try
        {
            var path = CoverPath(id);
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // 删不掉就留着，下次扫描会覆盖。
        }
    }
}
