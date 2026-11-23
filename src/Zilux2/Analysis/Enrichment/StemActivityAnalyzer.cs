using System.IO;
using System.Security.Cryptography;
using Zilux2.Stems;

namespace Zilux2.Analysis;

/// <summary>
/// 用随包 htdemucs 直接产出四轨活动度曲线（250 ms 一格），不写 WAV、不进分轨缓存。
///
/// 为什么不复用 StemSeparationService.EnsureWindowAsync：那条路会把每个 30 s 窗口的
/// 4 轨 WAV 落盘（30 s 窗口约 21 MB），一首 4 分钟歌要 170 MB；增强分析只要 RMS，
/// 逐窗算完就丢，内存与磁盘都省一个数量级。
/// </summary>
internal static class StemActivityAnalyzer
{
    private const int HopMs = 250;
    private const int WindowSec = 30;
    private const int StemCount = 4;
    private const int Drum = 0;
    private const int Bass = 1;
    private const int Other = 2;
    private const int Vocal = 3;

    private static readonly Lazy<string> ModelSha256Lazy =
        new(ComputeModelSha256, LazyThreadSafetyMode.ExecutionAndPublication);

    internal static StemActivityPayload Analyze(string audioPath, CancellationToken cancellationToken)
    {
        var modelPath = StemSeparationService.ResolveModelPath();
        if (!File.Exists(modelPath))
        {
            throw new FileNotFoundException("找不到 htdemucs 模型：" + modelPath);
        }

        var hopFrames = StemsContract.SampleRate * HopMs / 1000;
        var first = StemSeparationService.ReadAudioWindow(audioPath, 0, WindowSec);
        if (first.Frames <= 0 || first.DurationMs <= 0)
        {
            throw new InvalidOperationException("音频没有可分析的样本");
        }

        var durationMs = first.DurationMs;
        var buckets = (int)Math.Ceiling(durationMs / (double)HopMs) + 1;
        var sums = new double[StemCount][];
        var counts = new int[StemCount][];
        for (var s = 0; s < StemCount; s++)
        {
            sums[s] = new double[buckets];
            counts[s] = new int[buckets];
        }

        // 播放期最多吃 4 个核；比默认 4..12 更保守，避免过渡时抢占音频线程。
        var threadCount = Math.Clamp(Environment.ProcessorCount / 4, 2, 4);
        using var session = HtdemucsSession.Open(modelPath, threadCount);
        var windows = (int)Math.Ceiling(durationMs / (double)(WindowSec * 1000));
        for (var w = 0; w < windows; w++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var window = w == 0
                ? first
                : StemSeparationService.ReadAudioWindow(audioPath, w, WindowSec);
            if (window.Frames <= 0)
            {
                break;
            }

            var result = session.Separate(window.Left, window.Right, window.Frames, cancellationToken);
            var baseFrame = w * (long)WindowSec * StemsContract.SampleRate;
            for (var s = 0; s < StemCount; s++)
            {
                var left = result.StemLeft[s];
                var right = result.StemRight[s];
                var sum = sums[s];
                var count = counts[s];
                for (var i = 0; i < result.Frames; i++)
                {
                    var bucket = (int)((baseFrame + i) / hopFrames);
                    if (bucket >= buckets)
                    {
                        break;
                    }

                    var l = left[i];
                    var r = right[i];
                    sum[bucket] += 0.5 * ((double)l * l + (double)r * r);
                    count[bucket]++;
                }
            }
        }

        return new StemActivityPayload
        {
            HopMs = HopMs,
            Drum = Normalize(sums[Drum], counts[Drum], buckets),
            Bass = Normalize(sums[Bass], counts[Bass], buckets),
            Other = Normalize(sums[Other], counts[Other], buckets),
            Vocal = Normalize(sums[Vocal], counts[Vocal], buckets),
            Source = "htdemucs",
            ModelSha256 = ModelSha256Lazy.Value,
            DurationMs = durationMs,
            Normalized = true,
        };
    }

    /// <summary>逐轨 95 分位归一：与 DSP activity 的 0~1 相对曲线同口径，可直接替换消费方。</summary>
    private static double[] Normalize(double[] sum, int[] count, int buckets)
    {
        var rms = new double[buckets];
        for (var i = 0; i < buckets; i++)
        {
            rms[i] = count[i] > 0 ? Math.Sqrt(sum[i] / count[i]) : 0d;
        }

        var positives = rms.Where(v => v > 1e-6).OrderBy(v => v).ToArray();
        var scale = 1d;
        if (positives.Length >= 4)
        {
            var index = Math.Clamp((int)Math.Floor(positives.Length * 0.95), 0, positives.Length - 1);
            var p95 = positives[index];
            scale = p95 > 1e-5 ? 1d / p95 : 1d;
        }

        var result = new double[buckets];
        for (var i = 0; i < buckets; i++)
        {
            result[i] = Math.Round(Math.Clamp(rms[i] * scale, 0d, 1d), 4);
        }

        return result;
    }

    private static string ComputeModelSha256()
    {
        try
        {
            var path = StemSeparationService.ResolveModelPath();
            if (!File.Exists(path))
            {
                return string.Empty;
            }

            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20);
            return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        }
        catch (Exception exception)
        {
            HostLog.Warn($"enrich.stems.sha-failed: {exception.Message}");
            return string.Empty;
        }
    }
}
