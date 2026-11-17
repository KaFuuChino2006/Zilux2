using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.Json;

namespace Zilux2.Wallpaper.Media;

/// <summary>探测结果：尺寸、时长、帧率、编码名。</summary>
internal sealed class MediaInfo
{
    public int Width { get; set; }

    public int Height { get; set; }

    /// <summary>毫秒；图片为 0。</summary>
    public long DurationMs { get; set; }

    public double Fps { get; set; }

    public string VideoCodec { get; set; } = string.Empty;

    /// <summary>是否有音轨（第 4 轮：可开音轨）。</summary>
    public bool HasAudio { get; set; }

    public bool Ok => Width > 0 && Height > 0;
}

/// <summary>
/// 素材探测：视频走 ffprobe（有的话），退化到 Media Foundation 的 shell 属性；
/// 图片与 GIF 走 WIC（WPF 的 BitmapDecoder），不依赖外部工具。
/// </summary>
internal static class MediaProbe
{
    private static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v", ".wmv", ".flv", ".ts", ".mpg", ".mpeg",
    };

    private static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff",
    };

    /// <summary>按扩展名判类型；不认识返回 null。</summary>
    public static Model.AssetKind? KindOf(string path)
    {
        var extension = Path.GetExtension(path);
        if (VideoExtensions.Contains(extension)) return Model.AssetKind.Video;
        if (extension.Equals(".gif", StringComparison.OrdinalIgnoreCase)) return Model.AssetKind.Gif;
        if (ImageExtensions.Contains(extension)) return Model.AssetKind.Image;
        return null;
    }

    /// <summary>探测一个素材文件；失败返回 Ok=false，调用方标记为「解码失败/不支持」。</summary>
    public static MediaInfo Probe(string path, Model.AssetKind kind)
    {
        try
        {
            if (!File.Exists(path)) return new MediaInfo();
            return kind == Model.AssetKind.Video ? ProbeVideo(path) : ProbeImage(path, kind);
        }
        catch (Exception exception) when (exception is IOException or NotSupportedException or UnauthorizedAccessException)
        {
            return new MediaInfo();
        }
    }

    private static MediaInfo ProbeImage(string path, Model.AssetKind kind)
    {
        using var stream = File.OpenRead(path);
        var decoder = System.Windows.Media.Imaging.BitmapDecoder.Create(
            stream,
            System.Windows.Media.Imaging.BitmapCreateOptions.IgnoreColorProfile,
            System.Windows.Media.Imaging.BitmapCacheOption.None);

        var frame = decoder.Frames.Count > 0 ? decoder.Frames[0] : null;
        var info = new MediaInfo
        {
            Width = frame?.PixelWidth ?? 0,
            Height = frame?.PixelHeight ?? 0,
        };

        if (kind == Model.AssetKind.Gif && decoder.Frames.Count > 1 && frame is not null)
        {
            // GIF 用帧数 × 每帧延迟估时长；总延迟缺失时按 10fps 兜底。
            double totalMs = 0;
            foreach (var item in decoder.Frames)
            {
                var delay = item.Metadata is System.Windows.Media.Imaging.BitmapMetadata meta
                    ? ReadGifDelay(meta)
                    : 0;
                totalMs += delay > 0 ? delay : 100;
            }
            info.DurationMs = (long)totalMs;
            info.Fps = totalMs > 0 ? decoder.Frames.Count * 1000.0 / totalMs : 10;
        }

        return info;
    }

    private static double ReadGifGifDelayFallback => 100;

    private static double ReadGifDelay(System.Windows.Media.Imaging.BitmapMetadata metadata)
    {
        try
        {
            if (metadata.GetQuery("/grctlext/Delay") is ushort delay) return delay * 10.0;
        }
        catch (NotSupportedException)
        {
            // 非 GIF 元数据查询会抛；按兜底处理。
        }
        return ReadGifGifDelayFallback;
    }

    private static MediaInfo ProbeVideo(string path)
    {
        var ffprobe = FfmpegLocator.FfprobePath;
        if (ffprobe is null) return ProbeVideoViaShell(path);

        var startInfo = new ProcessStartInfo(ffprobe)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var argument in new[]
                 {
                     "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format",
                     "-select_streams", "v:0", path,
                 })
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo);
        if (process is null) return ProbeVideoViaShell(path);

        var json = process.StandardOutput.ReadToEnd();
        process.StandardError.ReadToEnd();
        if (!process.WaitForExit(8000))
        {
            try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            return ProbeVideoViaShell(path);
        }

        if (process.ExitCode != 0 || json.Length == 0) return ProbeVideoViaShell(path);

        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var info = new MediaInfo();

            if (root.TryGetProperty("streams", out var streams) && streams.GetArrayLength() > 0)
            {
                var stream = streams[0];
                info.Width = ReadInt(stream, "width");
                info.Height = ReadInt(stream, "height");
                info.VideoCodec = ReadString(stream, "codec_name");
                info.Fps = ParseFraction(ReadString(stream, "avg_frame_rate"));
                if (info.Fps <= 0) info.Fps = ParseFraction(ReadString(stream, "r_frame_rate"));
                info.DurationMs = (long)(ParseDouble(ReadString(stream, "duration")) * 1000);
                if (stream.TryGetProperty("side_data_list", out _)) { /* 旋转元数据，暂不消费 */ }
            }

            if (root.TryGetProperty("format", out var format))
            {
                if (info.DurationMs <= 0)
                {
                    info.DurationMs = (long)(ParseDouble(ReadString(format, "duration")) * 1000);
                }
                var hasAudio = ReadString(format, "format_name").Contains("mp3", StringComparison.Ordinal) is false
                               && json.Contains("\"codec_type\": \"audio\"", StringComparison.Ordinal);
                info.HasAudio = json.Contains("\"codec_type\": \"audio\"", StringComparison.Ordinal) || hasAudio;
            }

            return info;
        }
        catch (JsonException)
        {
            return ProbeVideoViaShell(path);
        }
    }

    /// <summary>
    /// 没有 ffprobe 时的降级探测：WinRT 的文件属性（系统媒体解析器），
    /// 拿得到尺寸与时长，帧率缺失（返回 0，渲染层按 30fps 兜底）。
    /// </summary>
    private static MediaInfo ProbeVideoViaShell(string path)
    {
        try
        {
            var file = Windows.Storage.StorageFile.GetFileFromPathAsync(path).AsTask().GetAwaiter().GetResult();
            var properties = file.Properties.GetVideoPropertiesAsync().AsTask().GetAwaiter().GetResult();
            return new MediaInfo
            {
                Width = (int)properties.Width,
                Height = (int)properties.Height,
                DurationMs = (long)properties.Duration.TotalMilliseconds,
                Fps = 0,
            };
        }
        catch (Exception)
        {
            return new MediaInfo();
        }
    }

    private static int ReadInt(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.TryGetInt32(out var number) ? number : 0;

    private static string ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static double ParseDouble(string value) =>
        double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) ? number : 0;

    private static double ParseFraction(string value)
    {
        if (string.IsNullOrEmpty(value)) return 0;
        var slash = value.IndexOf('/');
        if (slash <= 0) return ParseDouble(value);
        var numerator = ParseDouble(value[..slash]);
        var denominator = ParseDouble(value[(slash + 1)..]);
        return denominator > 0 ? numerator / denominator : 0;
    }
}
