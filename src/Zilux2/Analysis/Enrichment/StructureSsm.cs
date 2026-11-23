namespace Zilux2.Analysis;

/// <summary>
/// 纯 DSP 结构分析：逐小节 chroma → 自相似矩阵（SSM）→ checkerboard novelty →
/// 峰值吸附 downbeat/小节边界 → 段内能量/活动度打标签。
///
/// 为什么不用模型：这条链路每一步都能手算复核、单曲 &lt;50 ms，而且不引入新的权重与许可。
/// All-in-One 导出模型就绪后作为第二意见融合，SSM 仍是兜底与默认。
/// </summary>
internal static class StructureSsm
{
    private const int MinBars = 8;
    private const int MaxBars = 1200;
    private const int MinSectionBars = 4;

    internal static StructureFeaturePayload? Analyze(BeatAnalysisPayload payload, long durationMs)
    {
        var barTimes = payload.BarChromaMs ?? Array.Empty<double>();
        var bars = Math.Min(barTimes.Length, (payload.BarChroma?.Length ?? 0) / 12);
        bars = Math.Min(bars, MaxBars);
        if (bars < MinBars)
        {
            return Fallback(payload, durationMs, bars);
        }

        var totalMs = durationMs > 0 ? durationMs : EstimateDuration(barTimes, bars);
        if (totalMs <= 0)
        {
            return Fallback(payload, durationMs, bars);
        }

        // 1) 单位化小节向量（payload 已归一，这里防御性重算，避免旧缓存/手改数据破坏余弦）。
        var vectors = new double[bars * 12];
        for (var b = 0; b < bars; b++)
        {
            var norm = 0d;
            for (var k = 0; k < 12; k++)
            {
                var v = payload.BarChroma![b * 12 + k];
                vectors[b * 12 + k] = v;
                norm += v * v;
            }

            norm = Math.Sqrt(norm);
            if (norm > 1e-9)
            {
                for (var k = 0; k < 12; k++)
                {
                    vectors[b * 12 + k] /= norm;
                }
            }
        }

        // 2) 自相似矩阵（对称，只算上三角）。
        var sim = new float[bars * bars];
        for (var i = 0; i < bars; i++)
        {
            sim[i * bars + i] = 1f;
            for (var j = i + 1; j < bars; j++)
            {
                var dot = 0d;
                for (var k = 0; k < 12; k++)
                {
                    dot += vectors[i * 12 + k] * vectors[j * 12 + k];
                }

                sim[i * bars + j] = (float)dot;
                sim[j * bars + i] = (float)dot;
            }
        }

        // 3) checkerboard novelty：核对角核（同象限为正、交叉为负），高斯权重压边缘。
        var radius = Math.Clamp(bars / 24, 3, 8);
        if (bars < radius * 2 + 3)
        {
            return Fallback(payload, durationMs, bars);
        }

        var novelty = new double[bars];
        var sigma = Math.Max(1.0, radius * 0.6);
        for (var i = radius; i < bars - radius; i++)
        {
            var sum = 0d;
            var weightSum = 0d;
            for (var u = 0; u < radius * 2; u++)
            {
                var iu = i - radius + u;
                var wu = Math.Exp(-0.5 * Math.Pow((u - radius + 0.5) / sigma, 2));
                var su = u < radius ? -1 : 1;
                for (var v = 0; v < radius * 2; v++)
                {
                    var iv = i - radius + v;
                    var wv = Math.Exp(-0.5 * Math.Pow((v - radius + 0.5) / sigma, 2));
                    var sv = v < radius ? -1 : 1;
                    var weight = wu * wv;
                    sum += su * sv * weight * sim[iu * bars + iv];
                    weightSum += weight;
                }
            }

            novelty[i] = weightSum > 1e-9 ? sum / weightSum : 0d;
        }

        var smoothed = new double[bars];
        for (var i = 0; i < bars; i++)
        {
            var prev = i > 0 ? novelty[i - 1] : novelty[i];
            var next = i + 1 < bars ? novelty[i + 1] : novelty[i];
            smoothed[i] = 0.25 * prev + 0.5 * novelty[i] + 0.25 * next;
        }

        // 4) 峰值：mean + 1.0σ，局部极大，最小间隔按曲长伸缩。
        var interior = smoothed.Skip(radius).Take(bars - radius * 2).ToArray();
        var mean = interior.Length > 0 ? interior.Average() : 0d;
        var variance = interior.Length > 0 ? interior.Select(v => (v - mean) * (v - mean)).Average() : 0d;
        var threshold = mean + Math.Sqrt(variance);
        var minGap = Math.Clamp(bars / 32, MinSectionBars, 12);

        var peaks = new List<int>();
        for (var i = radius; i < bars - radius; i++)
        {
            var v = smoothed[i];
            if (v <= threshold || v <= 0)
            {
                continue;
            }

            if (i > 0 && smoothed[i - 1] > v)
            {
                continue;
            }

            if (i + 1 < bars && smoothed[i + 1] >= v)
            {
                continue;
            }

            if (peaks.Count > 0 && i - peaks[^1] < minGap)
            {
                if (v > smoothed[peaks[^1]])
                {
                    peaks[^1] = i;
                }

                continue;
            }

            peaks.Add(i);
        }

        if (peaks.Count == 0)
        {
            return Fallback(payload, durationMs, bars);
        }

        // 5) 峰值 → 毫秒边界：吸附最近小节起点，掐掉开头/结尾不足 4 小节的变化。
        var peakNovelty = peaks.ToDictionary(p => p, p => smoothed[p]);
        var boundaries = new List<double>();
        foreach (var peak in peaks)
        {
            var snapped = SnapToBar(barTimes, bars, peak, totalMs);
            if (snapped < 0)
            {
                continue;
            }

            if (boundaries.Count > 0 && snapped - boundaries[^1] < MinSectionBars * MedianBarMs(barTimes, bars))
            {
                continue;
            }

            boundaries.Add(snapped);
        }

        if (boundaries.Count == 0)
        {
            return Fallback(payload, durationMs, bars);
        }

        // 6) 段与标签。
        var cuts = new List<double> { 0 };
        cuts.AddRange(boundaries.Where(t => t > 0 && t < totalMs));
        cuts.Add(totalMs);

        var sections = new List<AnalysisSectionPayload>();
        for (var i = 0; i < cuts.Count - 1; i++)
        {
            var start = cuts[i];
            var end = cuts[i + 1];
            if (end - start < 500)
            {
                continue;
            }

            var label = LabelSection(payload, sections.Count == 0, i == cuts.Count - 2, start, end, totalMs);
            var confidence = ConfidenceAt(peakNovelty, peaks, start, threshold);
            sections.Add(new AnalysisSectionPayload
            {
                StartMs = Math.Round(start, 1),
                EndMs = Math.Round(end, 1),
                Label = label,
                Confidence = Math.Round(confidence, 2),
            });
        }

        if (sections.Count == 0)
        {
            return Fallback(payload, durationMs, bars);
        }

        return new StructureFeaturePayload
        {
            Source = "ssm",
            Method = "ssm-checkerboard",
            BoundariesMs = boundaries.Select(t => Math.Round(t, 1)).ToArray(),
            Sections = sections.ToArray(),
            BarCount = bars,
        };
    }

    private static StructureFeaturePayload? Fallback(BeatAnalysisPayload payload, long durationMs, int bars)
    {
        var sections = payload.Sections ?? Array.Empty<AnalysisSectionPayload>();
        if (sections.Length < 2)
        {
            return null;
        }

        return new StructureFeaturePayload
        {
            Source = "dsp",
            Method = "dsp-sections",
            BoundariesMs = sections.Skip(1).Select(s => s.StartMs).Where(t => t > 0).ToArray(),
            Sections = sections,
            BarCount = bars,
        };
    }

    private static double SnapToBar(double[] barTimes, int bars, int index, long totalMs)
    {
        var time = index >= 0 && index < bars ? barTimes[index] : 0;
        if (time <= 0)
        {
            return -1;
        }

        // 距曲首/曲尾不足 4 小节的变化不单独立段（前奏/尾奏由 LabelSection 负责）。
        var barMs = MedianBarMs(barTimes, bars);
        if (time < barMs * MinSectionBars || time > totalMs - barMs * MinSectionBars)
        {
            return -1;
        }

        return time;
    }

    private static double MedianBarMs(double[] barTimes, int bars)
    {
        if (bars < 2)
        {
            return 2000;
        }

        var diffs = new List<double>(bars - 1);
        for (var i = 1; i < bars; i++)
        {
            var diff = barTimes[i] - barTimes[i - 1];
            if (diff > 100 && diff < 20000)
            {
                diffs.Add(diff);
            }
        }

        if (diffs.Count == 0)
        {
            return 2000;
        }

        diffs.Sort();
        return diffs[diffs.Count / 2];
    }

    private static long EstimateDuration(double[] barTimes, int bars)
    {
        if (bars <= 0)
        {
            return 0;
        }

        var last = barTimes[bars - 1];
        return (long)Math.Round(last + MedianBarMs(barTimes, bars));
    }

    private static string LabelSection(
        BeatAnalysisPayload payload,
        bool isFirst,
        bool isLast,
        double startMs,
        double endMs,
        long totalMs)
    {
        var lufs = MeanLufs(payload, startMs, endMs);
        var overall = MedianLufs(payload);
        var ratio = lufs > -70 && overall > -70 ? Math.Pow(10, (lufs - overall) / 20) : 1;
        var vocal = MeanActivity(payload.Activity?.Vocal, payload.Activity?.HopMs ?? 250, startMs, endMs);
        var drum = MeanActivity(payload.Activity?.Drum, payload.Activity?.HopMs ?? 250, startMs, endMs);
        var durationShare = totalMs > 0 ? (endMs - startMs) / totalMs : 0;

        if (isFirst && (ratio <= 0.95 || durationShare < 0.25))
        {
            return "intro";
        }

        if (isLast && ratio <= 0.98)
        {
            return "outro";
        }

        if (ratio >= 1.12 && drum >= 0.5 && vocal < 0.58)
        {
            return "drop";
        }

        if (ratio >= 1.04)
        {
            return "chorus";
        }

        if (ratio <= 0.78)
        {
            return "breakdown";
        }

        if (ratio >= 0.92 && vocal >= 0.5)
        {
            return "verse";
        }

        return "verse";
    }

    private static double ConfidenceAt(
        Dictionary<int, double> peakNovelty,
        List<int> peaks,
        double startMs,
        double threshold)
    {
        if (startMs <= 0 || peaks.Count == 0)
        {
            return 0.6;
        }

        // 找到离该段起点最近的峰（边界就是峰的小节时间）。
        var best = 0d;
        foreach (var peak in peaks)
        {
            var value = peakNovelty.TryGetValue(peak, out var v) ? v : 0;
            if (value > best)
            {
                best = value;
            }
        }

        var strength = threshold > 1e-9 ? best / threshold : 1;
        return Math.Clamp(0.45 + 0.35 * Math.Min(1, strength - 1), 0.4, 0.92);
    }

    private static double MeanLufs(BeatAnalysisPayload payload, double startMs, double endMs)
    {
        var times = payload.LoudnessTimesMs;
        var values = payload.MomentaryLufs;
        if (times is null || values is null || times.Length == 0 || values.Length == 0)
        {
            return -70;
        }

        var n = Math.Min(times.Length, values.Length);
        var sum = 0d;
        var count = 0;
        for (var i = 0; i < n; i++)
        {
            var t = times[i];
            if (t < startMs)
            {
                continue;
            }

            if (t > endMs)
            {
                break;
            }

            var v = values[i];
            if (v > -70)
            {
                sum += v;
                count++;
            }
        }

        return count > 0 ? sum / count : -70;
    }

    private static double MedianLufs(BeatAnalysisPayload payload)
    {
        var values = payload.MomentaryLufs;
        if (values is null || values.Length == 0)
        {
            return -70;
        }

        var copy = values.Where(v => v > -70).ToArray();
        if (copy.Length == 0)
        {
            return -70;
        }

        Array.Sort(copy);
        return copy[copy.Length / 2];
    }

    private static double MeanActivity(double[]? curve, double hopMs, double startMs, double endMs)
    {
        if (curve is null || curve.Length == 0 || hopMs <= 0)
        {
            return 0;
        }

        var from = Math.Max(0, (int)Math.Floor(startMs / hopMs));
        var to = Math.Min(curve.Length - 1, (int)Math.Ceiling(endMs / hopMs));
        if (to < from)
        {
            return 0;
        }

        var sum = 0d;
        for (var i = from; i <= to; i++)
        {
            sum += curve[i];
        }

        return sum / (to - from + 1);
    }
}
