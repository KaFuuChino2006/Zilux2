namespace Zilux2.Analysis;

/// <summary>
/// 尾端静音检测（contract docs/zilux2-beat-analysis-contract.md §2.1）：在解码并重采样后的
/// 单声道 PCM 上找「最后一处可听样本」，给无缝衔接把交叉淡化终点对齐到音乐结束而不是文件结束。
/// 阈值 -50 dBFS（20 ms RMS 窗口），连续静音 ≥300 ms 才算有效尾部静音；为避免误伤，至少保留
/// 10% 时长。无有效尾部静音时 audibleEndMs = durationMs、tailSilenceMs = 0。
///
/// Zilux2 追加（2026-10-25）：不少歌曲结尾不是数字静音，而是「渐弱」到 -20~-45 dBFS 后直接
/// 结束；这种渐弱收尾同样不应计入可听内容，否则交叉淡化会一路拖到文件末尾。因此当真静音不足
/// 300 ms 时，再尝试「渐弱收尾」检测（250 ms 能量块 + 2 s 滑窗斜率）：若结尾存在一段持续的
/// 衰减（电平明显低于曲身、整体衰减 ≥8 dB），则把可听结尾前移到渐弱开始处，尾部计入
/// tailSilenceMs。
/// </summary>
internal static class TailSilenceDetector
{
    internal const double ThresholdDb = -50.0;

    internal const int WindowMs = 20;

    internal const int MinSilenceMs = 300;

    internal const double MinRetainedRatio = 0.10;

    internal static readonly double ThresholdAmplitude = Math.Pow(10.0, ThresholdDb / 20.0);

    // ---- 渐弱收尾检测参数 ----

    /// <summary>能量统计块长度（毫秒）。</summary>
    internal const int FadeBlockMs = 250;

    /// <summary>斜率拟合窗口长度（秒）。</summary>
    internal const double FadeWindowSeconds = 2.0;

    /// <summary>窗口斜率不超过该值（dB/s）才算处在渐弱段内。</summary>
    internal const double FadeSlopeDbPerSec = -0.7;

    /// <summary>尾块电平至少比曲身低多少 dB 才可能是渐弱收尾。</summary>
    internal const double FadeEndDropDb = 8.0;

    /// <summary>渐弱段整体衰减至少多少 dB。</summary>
    internal const double FadeTotalDropDb = 8.0;

    /// <summary>有效渐弱段最短时长（毫秒）。</summary>
    internal const int FadeMinTailMs = 2000;

    /// <summary>有效渐弱段最长时长（毫秒）。</summary>
    internal const int FadeMaxTailMs = 20000;

    /// <summary>渐弱段占整曲的最大比例。</summary>
    internal const double FadeMaxTailRatio = 0.40;

    /// <summary>渐弱开始处电平与曲身电平的最大差距（dB），防止把整首安静歌曲误判成渐弱。</summary>
    internal const double FadeStartNearBodyDb = 6.0;

    /// <summary>
    /// 返回 (audibleEndMs, tailSilenceMs)，均已按 <paramref name="durationMs"/> 钳制。
    /// </summary>
    internal static (long AudibleEndMs, long TailSilenceMs) Detect(
        float[] samples,
        int sampleRate,
        long durationMs)
    {
        if (durationMs <= 0)
        {
            return (0, 0);
        }

        if (samples.Length == 0 || sampleRate <= 0)
        {
            return (durationMs, 0);
        }

        var windowSize = Math.Max(1, (int)((long)sampleRate * WindowMs / 1000));
        var lastAudible = -1;
        var end = samples.Length;
        while (end > 0)
        {
            var start = Math.Max(0, end - windowSize);
            double energy = 0;
            for (var i = start; i < end; i++)
            {
                energy += samples[i] * samples[i];
            }

            var rms = Math.Sqrt(energy / (end - start));
            if (rms > ThresholdAmplitude)
            {
                // 窗口层判定可听后再逐样本细化，避免把整个 20 ms 窗口都算进可听部分。
                for (var i = end - 1; i >= start; i--)
                {
                    if (Math.Abs(samples[i]) > ThresholdAmplitude)
                    {
                        lastAudible = i;
                        break;
                    }
                }

                break;
            }

            end = start;
        }

        long audibleEndMs = lastAudible < 0
            ? 0
            : (long)Math.Ceiling((lastAudible + 1) * 1000.0 / sampleRate);

        // 至少保留 10% 时长；再钳制到 [0, durationMs]。
        var minRetainedMs = (long)Math.Ceiling(durationMs * MinRetainedRatio);
        if (audibleEndMs < minRetainedMs)
        {
            audibleEndMs = minRetainedMs;
        }

        if (audibleEndMs > durationMs)
        {
            audibleEndMs = durationMs;
        }

        var tailSilenceMs = durationMs - audibleEndMs;
        if (tailSilenceMs >= MinSilenceMs)
        {
            return (audibleEndMs, tailSilenceMs);
        }

        // 真静音不足 300 ms：可能是「渐弱收尾」，再尝试一次渐弱检测。
        if (TryDetectFadeOut(samples, sampleRate, durationMs, out var fadeEndMs))
        {
            return (fadeEndMs, durationMs - fadeEndMs);
        }

        // 尾部静音太短（含没有静音）：不排除，可听结尾就是文件结尾。
        return (durationMs, 0);
    }

    /// <summary>
    /// 检测「渐弱收尾」：把结尾一段持续衰减的电平视为结束，返回渐弱开始位置（毫秒）。
    /// </summary>
    private static bool TryDetectFadeOut(
        float[] samples,
        int sampleRate,
        long durationMs,
        out long audibleEndMs)
    {
        audibleEndMs = 0;

        var blockSamples = Math.Max(1, (int)((long)sampleRate * FadeBlockMs / 1000));
        var blockCount = samples.Length / blockSamples;
        if (blockCount < 12)
        {
            return false;
        }

        var blockDb = new double[blockCount];
        for (var block = 0; block < blockCount; block += 1)
        {
            var start = block * blockSamples;
            double energy = 0;
            for (var i = start; i < start + blockSamples; i += 1)
            {
                energy += samples[i] * samples[i];
            }

            var mean = energy / blockSamples;
            blockDb[block] = 10.0 * Math.Log10(mean + 1e-30);
        }

        // 曲身电平用 80 分位；尾块电平用最后 4 块的中位数，避免个别尾块抖动。
        var sorted = (double[])blockDb.Clone();
        Array.Sort(sorted);
        var bodyDb = sorted[(int)Math.Round((sorted.Length - 1) * 0.80)];

        var tailFrom = Math.Max(0, blockCount - 4);
        var tailTo = blockCount;
        var tailValues = new double[tailTo - tailFrom];
        Array.Copy(blockDb, tailFrom, tailValues, 0, tailValues.Length);
        Array.Sort(tailValues);
        var endDb = tailValues[tailValues.Length / 2];
        if (endDb > bodyDb - FadeEndDropDb)
        {
            return false;
        }

        var windowBlocks = (int)Math.Round(FadeWindowSeconds * 1000.0 / FadeBlockMs);
        if (windowBlocks < 2)
        {
            windowBlocks = 2;
        }

        if (blockCount <= windowBlocks + 1)
        {
            return false;
        }

        var secondsPerBlock = FadeBlockMs / 1000.0;

        // 从结尾往前扫：只要 2 秒窗口的斜率仍是明显下降，就继续把渐弱起点往前推。
        var bestStart = -1;
        for (var endBlock = blockCount; endBlock - windowBlocks > 0; endBlock -= 1)
        {
            var slope = FitSlopePerBlock(blockDb, endBlock - windowBlocks, endBlock) / secondsPerBlock;
            if (slope <= FadeSlopeDbPerSec)
            {
                bestStart = endBlock - windowBlocks;
                continue;
            }

            break;
        }

        if (bestStart < 0)
        {
            return false;
        }

        var tailMs = (long)(blockCount - bestStart) * FadeBlockMs;
        if (tailMs < FadeMinTailMs || tailMs > FadeMaxTailMs)
        {
            return false;
        }

        if (tailMs > durationMs * FadeMaxTailRatio)
        {
            return false;
        }

        var drop = blockDb[bestStart] - endDb;
        if (drop < FadeTotalDropDb)
        {
            return false;
        }

        if (blockDb[bestStart] < bodyDb - FadeStartNearBodyDb)
        {
            return false;
        }

        var fadeStartMs = Math.Min((long)bestStart * FadeBlockMs, durationMs);
        var minRetainedMs = (long)Math.Ceiling(durationMs * MinRetainedRatio);
        if (fadeStartMs < minRetainedMs)
        {
            fadeStartMs = minRetainedMs;
        }

        if (fadeStartMs <= 0 || fadeStartMs >= durationMs)
        {
            return false;
        }

        audibleEndMs = fadeStartMs;
        return true;
    }

    /// <summary>对 blockDb[start..end) 做最小二乘直线拟合，返回每个能量块的平均变化量（dB/块）。</summary>
    private static double FitSlopePerBlock(double[] blockDb, int start, int end)
    {
        var count = end - start;
        if (count < 2)
        {
            return 0;
        }

        double sumX = 0;
        double sumY = 0;
        double sumXy = 0;
        double sumXx = 0;
        for (var i = 0; i < count; i += 1)
        {
            var x = i;
            var y = blockDb[start + i];
            sumX += x;
            sumY += y;
            sumXy += x * y;
            sumXx += x * x;
        }

        var denominator = count * sumXx - sumX * sumX;
        if (Math.Abs(denominator) < 1e-9)
        {
            return 0;
        }

        return (count * sumXy - sumX * sumY) / denominator;
    }
}
