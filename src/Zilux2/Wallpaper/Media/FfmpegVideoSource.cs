using System.Diagnostics;
using System.IO;

namespace Zilux2.Wallpaper.Media;

/// <summary>起 ffmpeg 子进程失败的原因，用于按第 13 轮的口径给用户看。</summary>
internal enum VideoOpenFailure
{
    None,
    FfmpegMissing,
    FileMissing,
    ProcessFailed,
}

/// <summary>
/// 视频帧源：ffmpeg 解到 rawvideo（BGRA）管道，上层按固定尺寸逐帧取。
/// 选管道而不是原生绑定，是为了让 mp4/webm/mkv/mov/avi 一套代码全覆盖，
/// 且解码崩了只是子进程退出，不会拖垮宿主（第 35 轮的自愈要求同理）。
/// </summary>
internal sealed class FfmpegVideoSource : IDisposable
{
    private readonly Process _process;
    private readonly Stream _stdout;
    private readonly byte[] _frameBuffer;
    private bool _disposed;

    private FfmpegVideoSource(Process process, Stream stdout, int width, int height)
    {
        _process = process;
        _stdout = stdout;
        Width = width;
        Height = height;
        _frameBuffer = new byte[width * height * 4];
    }

    /// <summary>输出帧宽（像素）。</summary>
    public int Width { get; }

    /// <summary>输出帧高（像素）。</summary>
    public int Height { get; }

    /// <summary>帧字节数。</summary>
    public int FrameBytes => _frameBuffer.Length;

    /// <summary>
    /// 打开一路视频。region 为出帧尺寸（通常等于目标显示尺寸），
    /// trim 是片段区间、speed 是播放速度（第 80 轮），loop 决定读到片尾是不是从头再来。
    /// </summary>
    public static FfmpegVideoSource? Open(
        string path,
        int width,
        int height,
        int fps,
        long? trimInMs,
        long? trimOutMs,
        double speed,
        bool loop,
        bool hardwareDecode,
        out VideoOpenFailure failure)
    {
        failure = VideoOpenFailure.None;

        var ffmpeg = FfmpegLocator.FfmpegPath;
        if (ffmpeg is null)
        {
            failure = VideoOpenFailure.FfmpegMissing;
            return null;
        }

        if (!File.Exists(path))
        {
            failure = VideoOpenFailure.FileMissing;
            return null;
        }

        width = Math.Clamp(width, 2, 7680);
        height = Math.Clamp(height, 2, 4320);
        fps = Math.Clamp(fps, 1, 240);
        speed = Math.Clamp(speed <= 0 ? 1.0 : speed, 0.5, 2.0);

        var startInfo = new ProcessStartInfo(ffmpeg)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            CreateNoWindow = true,
        };

        void Arg(string value) => startInfo.ArgumentList.Add(value);

        Arg("-hide_banner");
        Arg("-loglevel"); Arg("error");
        Arg("-nostdin");

        // §5.6「硬解优先」：ffmpeg 自己挑可用硬件解码器，挑不到会静默回落软解。
        if (hardwareDecode) { Arg("-hwaccel"); Arg("auto"); }

        // 片段入点：放在 -i 之前是快速 seek（关键帧对齐，够壁纸用）。
        if (trimInMs is > 0) { Arg("-ss"); Arg((trimInMs.Value / 1000.0).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture)); }

        // 循环交给 ffmpeg 自己做，省掉上层重启进程的抖动。
        if (loop) { Arg("-stream_loop"); Arg("-1"); }

        Arg("-i"); Arg(path);

        if (trimInMs is > 0 && trimOutMs is { } outMs && outMs > trimInMs)
        {
            Arg("-t"); Arg(((outMs - trimInMs.Value) / 1000.0).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
        }

        Arg("-an");

        // 变速 + 定帧率 + 等比缩放进目标画布（不足处补黑边）。
        var filters = new List<string>();
        if (Math.Abs(speed - 1.0) > 0.001)
        {
            filters.Add($"setpts=PTS/{speed.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture)}");
        }
        filters.Add($"fps={fps}");
        filters.Add($"scale={width}:{height}:force_original_aspect_ratio=decrease");
        filters.Add($"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black");
        Arg("-vf"); Arg(string.Join(',', filters));

        Arg("-f"); Arg("rawvideo");
        Arg("-pix_fmt"); Arg("bgra");
        Arg("-");

        Process? process = null;
        try
        {
            process = Process.Start(startInfo);
        }
        catch (Exception exception) when (exception is IOException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            failure = VideoOpenFailure.ProcessFailed;
            return null;
        }

        if (process is null)
        {
            failure = VideoOpenFailure.ProcessFailed;
            return null;
        }

        return new FfmpegVideoSource(process, process.StandardOutput.BaseStream, width, height);
    }

    /// <summary>
    /// 读一帧到内部缓冲；成功时通过 <paramref name="frame"/> 交出只读视图。
    /// 读到片尾返回 false（上层决定是重启还是停住）。
    /// </summary>
    public bool TryReadFrame(out ReadOnlyMemory<byte> frame)
    {
        frame = default;
        if (_disposed) return false;

        try
        {
            var offset = 0;
            while (offset < _frameBuffer.Length)
            {
                var read = _stdout.Read(_frameBuffer, offset, _frameBuffer.Length - offset);
                if (read <= 0) return false;
                offset += read;
            }

            frame = _frameBuffer;
            return true;
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException)
        {
            return false;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        try
        {
            if (!_process.HasExited)
            {
                try { _process.StandardInput.WriteLine("q"); } catch (IOException) { }
                if (!_process.WaitForExit(800))
                {
                    _process.Kill(entireProcessTree: true);
                }
            }
        }
        catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            // 进程已经没了，正常。
        }
        finally
        {
            try { _stdout.Dispose(); } catch (IOException) { }
            _process.Dispose();
        }
    }
}
