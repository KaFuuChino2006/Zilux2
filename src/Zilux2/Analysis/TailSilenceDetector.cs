namespace Zilux2.Analysis;

/// <summary>
/// 尾端静音检测（contract docs/zilux2-beat-analysis-contract.md §2.1）：在解码并重采样后的
/// 单声道 PCM 上找「最后一处可听样本」，给无缝衔接把交叉淡化终点对齐到音乐结束而不是文件结束。
/// 阈值 -50 dBFS（20 ms RMS 窗口），连续静音 ≥300 ms 才算有效尾部静音；为避免误伤，至少保留
/// 10% 时长。无有效尾部静音时 audibleEndMs = durationMs、tailSilenceMs = 0。
/// </summary>
internal static class TailSilenceDetector
{
    internal const double ThresholdDb = -50.0;

    internal const int WindowMs = 20;

    internal const int MinSilenceMs = 300;

    internal const double MinRetainedRatio = 0.10;

    internal static readonly double ThresholdAmplitude = Math.Pow(10.0, ThresholdDb / 20.0);

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
        if (tailSilenceMs < MinSilenceMs)
        {
            // 尾部静音太短（含没有静音）：不排除，可听结尾就是文件结尾。
            return (durationMs, 0);
        }

        return (audibleEndMs, tailSilenceMs);
    }
}
