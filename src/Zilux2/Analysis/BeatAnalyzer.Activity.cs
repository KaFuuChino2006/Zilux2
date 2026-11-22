namespace Zilux2.Analysis;

/// <summary>
/// p1-0 分析扩展（契约 docs/zilux2-beat-analysis-contract.md §2.1.5）：三路活动度曲线、
/// 调性时间线、可循环单元。全部复用 <see cref="BeatAnalyzer"/> 主分析已经算好的
/// 频段能量 / 谱通量 / 谱平坦度 / 逐小节 chroma，**不做任何源分离**。
/// </summary>
internal static partial class BeatAnalyzer
{
    /// <summary>活动度曲线的采样步长（ms）。250 ms ≈ 4 点/秒，12 分钟曲子约 2880 点。</summary>
    private const double ActivityHopMs = 250;

    /// <summary>可循环单元允许的小节长度，从长到短试。</summary>
    private static readonly int[] LoopUnitBars = { 8, 4 };

    /// <summary>两半被认定为「同一段」的 chroma 余弦相似度下限。</summary>
    private const double LoopUnitMinSimilarity = 0.86;

    /// <summary>调性时间线的转移罚：越大越不愿意切调，避免每窗口抖动。</summary>
    /// <summary>
    /// 调性转移罚，单位是「皮尔逊相关差」。
    /// 发射分是 12 音级与调性轮廓的皮尔逊 r（-1~1），相邻窗口的 r 差通常只有 0.02~0.15，
    /// 所以罚值必须与 r 同量纲：写成 3.0 时等于要求 3.0 的相关差，任何曲子都永远切不了调。
    /// 0.12 的含义是「新调比旧调每窗至少多解释 0.12 的相关」，属于真换调才会达到的量级。
    /// </summary>
    private const double KeySwitchPenalty = 0.12;

    /// <summary>逐窗调性相关性低于此值时不报调（打击乐段 / 噪声段）。</summary>
    private const double KeyTimelineMinScore = 0.35;

    /// <summary>
    /// 发射权重。首窗原来用 1.0、后续用 0.1，等于「第一窗说了算、后面全是噪声」，
    /// 配合转移罚就是永不换调。统一成 1.0，让每个窗口的证据等权。
    /// </summary>
    private const double KeyEmissionWeight = 1.0;

    /// <summary>把逐帧线索压成 250 ms 一档的三路活动度曲线（0~1）。</summary>
    private static ActivityPayload BuildActivity(
        float[] lowEnergy,
        float[] midEnergy,
        float[] highEnergy,
        float[] lowFlux,
        float[] vocalEnergy,
        float[] vocalFlatness,
        float[] sibilanceEnergy,
        int frameCount,
        double fps)
    {
        var framesPerBucket = Math.Max(1, (int)Math.Round(ActivityHopMs / 1000.0 * fps));
        var buckets = Math.Max(1, (int)Math.Ceiling(frameCount / (double)framesPerBucket));
        var bass = new double[buckets];
        var drum = new double[buckets];
        var vocal = new double[buckets];
        for (var bucket = 0; bucket < buckets; bucket++)
        {
            var from = bucket * framesPerBucket;
            var to = Math.Min(frameCount, from + framesPerBucket);
            if (to <= from) continue;
            double low = 0, mid = 0, high = 0, flux = 0, vocalSum = 0, sib = 0;
            for (var frame = from; frame < to; frame++)
            {
                low += lowEnergy[frame];
                mid += midEnergy[frame];
                high += highEnergy[frame];
                flux += lowFlux[frame];
                sib += sibilanceEnergy[frame];
                // 谐波性 = (1 − 平坦度)²：稳态浊音远高于噪声 / 镲片 / 失真。
                var tonality = 1.0 - Math.Clamp(vocalFlatness[frame], 0, 1);
                vocalSum += vocalEnergy[frame] * tonality * tonality;
            }

            var count = to - from;
            var total = low + mid + high;
            bass[bucket] = total > 1e-9 ? low / total : 0;
            drum[bucket] = flux / count;
            var presence = vocalSum > 1e-9 ? Math.Clamp(sib / (vocalSum + 1e-9) * 4, 0, 1) : 0;
            vocal[bucket] = vocalSum / count * (0.6 + 0.4 * presence);
        }

        NormalizeCurve(bass);
        NormalizeCurve(drum);
        NormalizeCurve(vocal);
        Smooth3(bass);
        Smooth3(drum);
        Smooth3(vocal);
        return new ActivityPayload
        {
            // 桶宽必须是真实值：framesPerBucket = round(250ms*fps)，fps=43.066 时
            // 是 11 帧 = 255.4ms。前端 phraseMix/introBridge 真的按 hopMs 换算时间，
            // 写死 250 会让 12 分钟处累积偏移约 15 秒。
            HopMs = Math.Round(framesPerBucket * 1000.0 / fps, 3),
            Bass = RoundCurve(bass),
            Drum = RoundCurve(drum),
            Vocal = RoundCurve(vocal),
        };
    }

    /// <summary>除以 95 分位并夹到 0~1；全零时原样返回。</summary>
    private static void NormalizeCurve(double[] curve)
    {
        if (curve.Length == 0) return;
        var sorted = (double[])curve.Clone();
        Array.Sort(sorted);
        var reference = sorted[Math.Max(0, (int)Math.Floor((sorted.Length - 1) * 0.95))];
        if (reference <= 1e-9) return;
        for (var i = 0; i < curve.Length; i++)
        {
            curve[i] = Math.Clamp(curve[i] / reference, 0, 1);
        }
    }

    private static void Smooth3(double[] curve)
    {
        if (curve.Length < 3) return;
        var copy = (double[])curve.Clone();
        for (var i = 0; i < curve.Length; i++)
        {
            var from = Math.Max(0, i - 1);
            var to = Math.Min(curve.Length - 1, i + 1);
            double sum = 0;
            for (var j = from; j <= to; j++) sum += copy[j];
            curve[i] = sum / (to - from + 1);
        }
    }

    private static double[] RoundCurve(double[] curve)
    {
        var result = new double[curve.Length];
        for (var i = 0; i < curve.Length; i++) result[i] = Math.Round(curve[i], 3);
        return result;
    }

    /// <summary>
    /// 逐 2 小节的调性时间线：24 个状态（12 主音 × 大/小调）上做 Viterbi，
    /// 转移罚 3.0 让调性只在「真的换了调」时切。
    /// </summary>
    private static (double[] TimesMs, string[] Keys) BuildKeyTimeline(
        double[][] barChroma,
        double[] downbeats,
        double durationMs)
    {
        const int windowBars = 2;
        if (barChroma.Length < windowBars || downbeats.Length < 2)
        {
            return (Array.Empty<double>(), Array.Empty<string>());
        }

        var windows = barChroma.Length / windowBars;
        if (windows < 1) return (Array.Empty<double>(), Array.Empty<string>());
        var emissions = new double[windows][];
        var times = new double[windows];
        for (var window = 0; window < windows; window++)
        {
            var chroma = new double[ChromaBins];
            for (var offset = 0; offset < windowBars; offset++)
            {
                var bar = window * windowBars + offset;
                if (bar >= barChroma.Length) break;
                for (var bin = 0; bin < ChromaBins; bin++) chroma[bin] += barChroma[bar][bin];
            }

            var scores = new double[24];
            for (var tonic = 0; tonic < 12; tonic++)
            {
                scores[tonic] = Correlate(chroma, MajorProfile, tonic);
                scores[tonic + 12] = Correlate(chroma, MinorProfile, tonic);
            }

            emissions[window] = scores;
            var barIndex = Math.Min(downbeats.Length - 1, window * windowBars);
            var start = downbeats[barIndex];
            var end = barIndex + windowBars < downbeats.Length
                ? downbeats[barIndex + windowBars]
                : durationMs;
            times[window] = Math.Round((start + end) / 2, 1);
        }

        var cost = new double[windows][];
        var back = new int[windows][];
        cost[0] = new double[24];
        back[0] = new int[24];
        for (var state = 0; state < 24; state++)
        {
            cost[0][state] = -emissions[0][state] * KeyEmissionWeight;
            back[0][state] = state;
        }

        for (var window = 1; window < windows; window++)
        {
            cost[window] = new double[24];
            back[window] = new int[24];
            for (var state = 0; state < 24; state++)
            {
                var best = double.PositiveInfinity;
                var bestPrevious = state;
                for (var previous = 0; previous < 24; previous++)
                {
                    var candidate = cost[window - 1][previous]
                        + (previous == state ? 0 : KeySwitchPenalty)
                        - emissions[window][state] * KeyEmissionWeight;
                    if (candidate < best)
                    {
                        best = candidate;
                        bestPrevious = previous;
                    }
                }

                cost[window][state] = best;
                back[window][state] = bestPrevious;
            }
        }

        var path = new int[windows];
        var finalState = 0;
        for (var state = 1; state < 24; state++)
        {
            if (cost[windows - 1][state] < cost[windows - 1][finalState]) finalState = state;
        }

        path[windows - 1] = finalState;
        for (var window = windows - 2; window >= 0; window--)
        {
            path[window] = back[window + 1][path[window + 1]];
        }

        var keys = new string[windows];
        for (var window = 0; window < windows; window++)
        {
            var state = path[window];
            var tonic = state % 12;
            var mode = state >= 12 ? "minor" : "major";
            keys[window] = emissions[window][state] > KeyTimelineMinScore
                ? CamelotOf(tonic, mode)
                : string.Empty;
        }

        return (times, keys);
    }

    /// <summary>
    /// 可循环单元 = 前半与后半自相似的一段（8 或 4 小节），供结构桥接挑「重复哪几小节」。
    /// 只用逐小节 chroma + 能量，不做源分离。
    /// </summary>
    private static LoopUnitPayload[] BuildLoopUnits(
        double[][] barChroma,
        double[][] barFeatures,
        double[] downbeats,
        double durationMs)
    {
        var bars = barChroma.Length;
        if (bars < 8 || downbeats.Length < 4) return Array.Empty<LoopUnitPayload>();

        var candidates = new List<LoopUnitPayload>();
        foreach (var half in LoopUnitBars)
        {
            for (var start = 0; start + half * 2 <= bars; start++)
            {
                var similarity = 0.0;
                var pairs = 0;
                for (var offset = 0; offset < half; offset++)
                {
                    similarity += Cosine(barChroma[start + offset], barChroma[start + half + offset]);
                    pairs++;
                }

                if (pairs == 0) continue;
                similarity /= pairs;
                if (similarity < LoopUnitMinSimilarity) continue;
                var energyA = MeanBarEnergy(barFeatures, start, half);
                var energyB = MeanBarEnergy(barFeatures, start + half, half);
                var energyGap = Math.Abs(energyA - energyB);
                if (energyGap > 0.35) continue;
                var barIndex = Math.Min(downbeats.Length - 1, start);
                var startMs = downbeats[barIndex];
                var endBar = Math.Min(downbeats.Length - 1, start + half * 2);
                var endMs = endBar > barIndex ? downbeats[endBar] : durationMs;
                if (!(endMs > startMs)) continue;
                candidates.Add(new LoopUnitPayload
                {
                    StartMs = Math.Round(startMs, 1),
                    EndMs = Math.Round(endMs, 1),
                    Bars = half,
                    Score = Math.Round(
                        Math.Clamp(
                            0.6 * similarity + 0.25 * (1 - energyGap) + 0.15 * (1 - Math.Min(1, energyA)),
                            0,
                            1),
                        3),
                    Kind = "repeat",
                });
            }
        }

        // 按分数降序，IoU>0.5 视为同一段只留一条。
        var kept = new List<LoopUnitPayload>();
        foreach (var candidate in candidates.OrderByDescending(c => c.Score))
        {
            var overlaps = kept.Any(other =>
            {
                var intersection = Math.Max(
                    0,
                    Math.Min(candidate.EndMs, other.EndMs) - Math.Max(candidate.StartMs, other.StartMs));
                var union = Math.Max(candidate.EndMs, other.EndMs) - Math.Min(candidate.StartMs, other.StartMs);
                return union > 0 && intersection / union > 0.5;
            });
            if (!overlaps) kept.Add(candidate);
            if (kept.Count >= 8) break;
        }

        return kept.ToArray();
    }

    private static double MeanBarEnergy(double[][] barFeatures, int start, int length)
    {
        double sum = 0;
        var count = 0;
        for (var i = start; i < start + length && i < barFeatures.Length; i++)
        {
            sum += barFeatures[i][0];
            count++;
        }

        return count > 0 ? sum / count : 0;
    }

    internal const int BarChromaBins = 12;

    /// <summary>
    /// 把逐小节 chroma 摊平成「起点 ms + 12 个数一组」的紧凑曲线，供前端做旋律相似度。
    /// 每小节先归一到单位长度：这样两段旋律的相似度就等于点积，且不受力度影响。
    /// </summary>
    internal static (double[] Ms, double[] Flat) FlattenBarChroma(
        double[][] barChroma, double[] downbeats, double durationMs)
    {
        if (barChroma.Length == 0)
        {
            return (Array.Empty<double>(), Array.Empty<double>());
        }

        var barMs = 0.0;
        if (downbeats.Length >= 2)
        {
            var diffs = new List<double>();
            for (var i = 1; i < downbeats.Length && diffs.Count < 16; i++)
            {
                var diff = downbeats[i] - downbeats[i - 1];
                if (diff > 120 && diff < 5000)
                {
                    diffs.Add(diff);
                }
            }

            if (diffs.Count > 0)
            {
                diffs.Sort();
                barMs = diffs[diffs.Count / 2];
            }
        }

        if (barMs <= 0 && barChroma.Length > 0)
        {
            barMs = durationMs / barChroma.Length;
        }

        var ms = new double[barChroma.Length];
        var flat = new double[barChroma.Length * BarChromaBins];
        for (var bar = 0; bar < barChroma.Length; bar++)
        {
            ms[bar] = Math.Round(
                bar < downbeats.Length ? downbeats[bar] : bar * barMs, 1);
            var row = barChroma[bar];
            double norm = 0;
            for (var bin = 0; bin < BarChromaBins; bin++)
            {
                var value = row is not null && bin < row.Length ? row[bin] : 0;
                if (value < 0 || double.IsNaN(value))
                {
                    value = 0;
                }

                flat[bar * BarChromaBins + bin] = value;
                norm += value * value;
            }

            norm = Math.Sqrt(norm);
            for (var bin = 0; bin < BarChromaBins; bin++)
            {
                var index = bar * BarChromaBins + bin;
                flat[index] = norm > 1e-9 ? Math.Round(flat[index] / norm, 3) : 0;
            }
        }

        return (ms, flat);
    }

    private static double Cosine(double[] left, double[] right)
    {
        double dot = 0, leftNorm = 0, rightNorm = 0;
        var length = Math.Min(left.Length, right.Length);
        for (var i = 0; i < length; i++)
        {
            dot += left[i] * right[i];
            leftNorm += left[i] * left[i];
            rightNorm += right[i] * right[i];
        }

        var denominator = Math.Sqrt(leftNorm * rightNorm);
        return denominator > 1e-12 ? dot / denominator : 0;
    }
}
