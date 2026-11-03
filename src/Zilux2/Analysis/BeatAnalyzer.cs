namespace Zilux2.Analysis;

/// <summary>
/// Offline beat analysis (contract docs/zilux2-beat-analysis-contract.md §4):
/// spectral-flux onsets over a 1024/512 Hann STFT → autocorrelation + comb BPM estimate →
/// dynamic-programming beat tracking (Ellis style) → 4/3 downbeat phase selection from
/// low-band accents → bar-level novelty for phrase boundaries.
/// P0 assumes a constant tempo; drifting tracks get a "tempo-drift" warning but still return
/// the average grid. Runs on the caller's thread (the analysis service keeps it off the UI).
/// </summary>
internal static class BeatAnalyzer
{
    internal const string AnalyzerVersion = "p0-11";

    private const int WindowSize = 1024;
    private const int HopSize = 512;
    private const int EnvelopeRadius = 8;
    private const double MinBpm = 40.0;
    private const double MaxBpm = 240.0;
    private const double PreferredMinBpm = 70.0;
    private const double PreferredMaxBpm = 180.0;
    private const double BeatTightness = 100.0;
    private const int MaxDownbeats = 400;
    private const int MaxPhraseStarts = 64;
    private const int MinPhraseBars = 8;
    /// <summary>标高潮段所需的最少小节数（约 15~20 秒）。</summary>
    private const int MinClimaxBars = 8;
    /// <summary>高潮标记最多覆盖的小节数（副歌通常 16 小节；超出的部分不标，避免占掉半条进度条）。</summary>
    private const int MaxClimaxBars = 16;
    /// <summary>高潮标记最多占整曲时长的比例（短歌里 16 小节也可能太长）。</summary>
    private const double MaxClimaxWidthRatio = 0.12;
    /// <summary>高潮标记最后用的小窗：没有重复副歌时，只标能量最高的 8 小节。</summary>
    private const int FallbackClimaxBars = 8;
    /// <summary>两个段落被认定为「同一段副歌」的音色+能量轮廓余弦相似度下限。</summary>
    private const double MinChorusSimilarity = 0.88;
    /// <summary>比较段落轮廓时的重采样点数（按段落长度归一，16 小节和 12 小节也能对齐）。</summary>
    private const int SimilarityPoints = 12;
    private const double MinClimaxEnergyRatio = 1.08;
    private const int ChromaBins = 12;
    /// <summary>音级能量只统计主旋律/人声范围内的频率。</summary>
    private const double MinChromaHz = 65.0;
    private const double MaxChromaHz = 2000.0;

    /// <summary>Krumhansl 大调调性轮廓（相对主音的音级稳定度）。</summary>
    private static readonly double[] MajorProfile = { 6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88 };

    /// <summary>Krumhansl 小调调性轮廓。</summary>
    private static readonly double[] MinorProfile = { 6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17 };

    /// <summary>Camelot 轮盘：大调音级 → 编号（1~12），B 面。</summary>
    private static readonly int[] CamelotMajor = { 8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1 };

    /// <summary>Camelot 轮盘：小调音级 → 编号（1~12），A 面。</summary>
    private static readonly int[] CamelotMinor = { 5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10 };

    private static readonly float[] Hann = CreateHann();

    internal static BeatAnalysisPayload Analyze(float[] samples, int sampleRate)
    {
        var warnings = new List<string>();
        var payload = new BeatAnalysisPayload();
        var durationMs = samples.Length * 1000.0 / sampleRate;
        if (sampleRate <= 0 || samples.Length < WindowSize * 2)
        {
            warnings.Add("too-short");
            warnings.Add("low-confidence");
            payload.Warnings = warnings.ToArray();
            return payload;
        }

        var fps = sampleRate / (double)HopSize;
        var frameCount = 1 + (samples.Length - WindowSize) / HopSize;
        if (frameCount < 16)
        {
            warnings.Add("too-short");
            warnings.Add("low-confidence");
            payload.Warnings = warnings.ToArray();
            return payload;
        }

        var flux = new float[frameCount];
        var lowEnergy = new float[frameCount];
        var midEnergy = new float[frameCount];
        var highEnergy = new float[frameCount];
        ComputeOnsets(samples, frameCount, sampleRate, flux, lowEnergy, midEnergy, highEnergy, out var chromaFrames);

        var onset = NormalizeOnsets(flux);
        var (bpm, bpmConfidence) = EstimateTempo(onset, fps, out _);
        if (bpm <= 0)
        {
            bpm = 120.0;
            bpmConfidence = 0.0;
        }

        var intervalFrames = 60.0 * fps / bpm;
        var beatIntervalMs = 60000.0 / bpm;

        // Phase fit: where does the beat grid start? Sub-hop accuracy keeps firstDownbeatMs tight
        // even though the onset envelope itself is quantized to 512-sample hops.
        var phase = FitBeatPhase(onset, intervalFrames);
        var firstBeatMs = phase * 1000.0 * HopSize / sampleRate;
        var beatCount = (int)Math.Floor((durationMs - firstBeatMs) / beatIntervalMs) + 1;
        if (beatCount < 1)
        {
            beatCount = 1;
        }

        var (meter, meterPhase, meterConfidence) = DetectMeter(
            lowEnergy, frameCount, firstBeatMs, beatIntervalMs, beatCount, fps);
        var firstDownbeatMs = firstBeatMs + meterPhase * beatIntervalMs;
        if (firstDownbeatMs > durationMs + beatIntervalMs)
        {
            firstDownbeatMs = firstBeatMs;
            meterPhase = 0;
        }

        var downbeats = BuildDownbeats(firstDownbeatMs, beatIntervalMs, meter, durationMs, out var barCount);
        var phraseStarts = DetectPhrases(
            downbeats, lowEnergy, midEnergy, highEnergy, chromaFrames, frameCount, fps, out var barFeatures, out var barChroma, durationMs);
        var sections = BuildSections(
            phraseStarts, downbeats, barFeatures, barChroma, durationMs,
            out var climaxStartMs, out var climaxEndMs, out var cueInMs, out var cueOutMs);

        // Beat tracking pass: used for drift diagnostics only (the output grid is constant tempo).
        var trackedBeats = TrackBeats(onset, intervalFrames);
        if (trackedBeats.Count >= 8)
        {
            var median = MedianInterval(trackedBeats);
            if (median > 0)
            {
                var deviation = IntervalDeviation(trackedBeats, median);
                if (deviation > 0.04)
                {
                    warnings.Add("tempo-drift");
                }
            }
        }

        if (bpmConfidence < 0.35)
        {
            warnings.Add("low-confidence");
        }

        payload.Bpm = Math.Round(bpm, 2);
        payload.BpmConfidence = Math.Round(bpmConfidence, 3);
        payload.Meter = meter;
        payload.MeterConfidence = Math.Round(meterConfidence, 3);
        payload.BeatIntervalMs = Math.Round(beatIntervalMs, 2);
        payload.FirstBeatMs = Math.Round(firstBeatMs, 1);
        payload.FirstDownbeatMs = Math.Round(firstDownbeatMs, 1);
        payload.Downbeats = downbeats;
        payload.PhraseStartsMs = phraseStarts;
        payload.BarCount = barCount;
        payload.ClimaxStartMs = Math.Round(climaxStartMs, 1);
        payload.ClimaxEndMs = Math.Round(climaxEndMs, 1);
        payload.CueInMs = Math.Round(cueInMs, 1);
        payload.CueOutMs = Math.Round(cueOutMs, 1);
        var (key, keyMode) = DetectKey(chromaFrames, frameCount);
        payload.Key = key;
        payload.KeyMode = keyMode;
        payload.Camelot = key >= 0 ? CamelotOf(key, keyMode) : string.Empty;
        var (lufs, peakDb) = MeasureLoudness(samples);
        payload.Energy = Math.Round(ComputeEnergy(lowEnergy, midEnergy, highEnergy, frameCount, lufs), 3);
        payload.LoudnessLufs = Math.Round(lufs, 1);
        payload.PeakDb = Math.Round(peakDb, 1);
        payload.Sections = sections;
        payload.Warnings = warnings.Distinct(StringComparer.Ordinal).ToArray();
        return payload;
    }

    /// <summary>按 Krumhansl 轮廓做调性识别：返回主音音级（0~11）与调式；识别不出返回 (-1, "")。</summary>
    private static (int Key, string Mode) DetectKey(float[] chromaFrames, int frameCount)
    {
        var chroma = new double[12];
        for (var frame = 0; frame < frameCount; frame++)
        {
            for (var bin = 0; bin < ChromaBins; bin++)
            {
                chroma[bin] += chromaFrames[frame * ChromaBins + bin];
            }
        }

        var total = 0.0;
        for (var bin = 0; bin < ChromaBins; bin++)
        {
            total += chroma[bin];
        }

        if (total <= 0)
        {
            return (-1, string.Empty);
        }

        var bestScore = double.NegativeInfinity;
        var bestKey = -1;
        var bestMode = string.Empty;
        for (var tonic = 0; tonic < 12; tonic++)
        {
            var major = Correlate(chroma, MajorProfile, tonic);
            if (major > bestScore)
            {
                bestScore = major;
                bestKey = tonic;
                bestMode = "major";
            }

            var minor = Correlate(chroma, MinorProfile, tonic);
            if (minor > bestScore)
            {
                bestScore = minor;
                bestKey = tonic;
                bestMode = "minor";
            }
        }

        return (bestKey, bestMode);
    }

    /// <summary>音级能量与调性轮廓的皮尔逊相关（轮廓相对主音旋转）。</summary>
    private static double Correlate(double[] chroma, double[] profile, int tonic)
    {
        double meanChroma = 0;
        double meanProfile = 0;
        for (var index = 0; index < 12; index++)
        {
            meanChroma += chroma[index];
            meanProfile += profile[index];
        }

        meanChroma /= 12;
        meanProfile /= 12;

        double cov = 0;
        double varChroma = 0;
        double varProfile = 0;
        for (var index = 0; index < 12; index++)
        {
            var value = chroma[(tonic + index) % 12] - meanChroma;
            var reference = profile[index] - meanProfile;
            cov += value * reference;
            varChroma += value * value;
            varProfile += reference * reference;
        }

        var denominator = Math.Sqrt(varChroma * varProfile);
        return denominator > 1e-9 ? cov / denominator : 0;
    }

    private static string CamelotOf(int key, string mode) =>
        mode == "minor" ? $"{CamelotMinor[key]}A" : $"{CamelotMajor[key]}B";

    /// <summary>0~1 的听感能量：以整体响度为主，叠一点高频占比（亮而炸的曲子偏高）。</summary>
    private static double ComputeEnergy(float[] low, float[] mid, float[] high, int frameCount, double lufs)
    {
        if (frameCount <= 0)
        {
            return 0;
        }

        var total = 0.0;
        var highSum = 0.0;
        for (var i = 0; i < frameCount; i++)
        {
            total += low[i] + mid[i] + high[i];
            highSum += high[i];
        }

        var brightness = total > 0 ? highSum / total : 0;
        var loudness = Math.Clamp((lufs + 22.0) / 16.0, 0.0, 1.0);
        var bright = Math.Clamp((brightness - 0.10) / 0.30, 0.0, 1.0);
        return Math.Clamp(0.72 * loudness + 0.28 * bright, 0.0, 1.0);
    }

    /// <summary>整曲响度近似（LUFS 口径）与峰值电平（dBFS）；用于页面响度均衡。</summary>
    private static (double Lufs, double PeakDb) MeasureLoudness(float[] samples)
    {
        if (samples.Length == 0)
        {
            return (-70, -70);
        }

        double sumSquares = 0;
        double peak = 0;
        foreach (var sample in samples)
        {
            sumSquares += sample * sample;
            var magnitude = Math.Abs((double)sample);
            if (magnitude > peak)
            {
                peak = magnitude;
            }
        }

        var meanSquare = sumSquares / samples.Length;
        var lufs = meanSquare > 1e-12 ? -0.691 + 10 * Math.Log10(meanSquare) : -70;
        var peakDb = peak > 1e-6 ? 20 * Math.Log10(peak) : -70;
        return (lufs, peakDb);
    }

    private static float[] CreateHann()
    {
        var window = new float[WindowSize];
        for (var i = 0; i < WindowSize; i++)
        {
            window[i] = 0.5f - 0.5f * MathF.Cos(2f * MathF.PI * i / (WindowSize - 1));
        }

        return window;
    }

    private static void ComputeOnsets(
        float[] samples,
        int frameCount,
        int sampleRate,
        float[] flux,
        float[] lowEnergy,
        float[] midEnergy,
        float[] highEnergy,
        out float[] chromaFrames)
    {
        chromaFrames = new float[frameCount * ChromaBins];
        var real = new float[WindowSize];
        var imag = new float[WindowSize];
        var previous = new float[WindowSize / 2 + 1];
        var binHz = sampleRate / (double)WindowSize;
        var pitchBins = BuildChromaBins(binHz);
        for (var frame = 0; frame < frameCount; frame++)
        {
            var offset = frame * HopSize;
            for (var i = 0; i < WindowSize; i++)
            {
                real[i] = samples[offset + i] * Hann[i];
                imag[i] = 0f;
            }

            Fft(real, imag);

            double fluxSum = 0;
            double low = 0;
            double mid = 0;
            double high = 0;
            var chromaOffset = frame * ChromaBins;
            for (var bin = 1; bin <= WindowSize / 2; bin++)
            {
                var magnitude = Math.Sqrt(real[bin] * real[bin] + imag[bin] * imag[bin]) / WindowSize;
                // Log compression keeps quiet percussive attacks visible next to loud bass.
                var compressed = Math.Log(1.0 + 20.0 * magnitude);
                var diff = compressed - previous[bin];
                if (diff > 0)
                {
                    fluxSum += diff;
                }

                previous[bin] = (float)compressed;

                var frequency = bin * binHz;
                if (frequency < 160)
                {
                    low += magnitude;
                }
                else if (frequency < 2000)
                {
                    mid += magnitude;
                }
                else if (frequency < 8000)
                {
                    high += magnitude;
                }

                var pitch = pitchBins[bin];
                if (pitch >= 0)
                {
                    chromaFrames[chromaOffset + pitch] += (float)magnitude;
                }
            }

            flux[frame] = (float)(fluxSum / (WindowSize / 2.0));
            lowEnergy[frame] = (float)low;
            midEnergy[frame] = (float)mid;
            highEnergy[frame] = (float)high;
        }
    }

    /// <summary>把每个 FFT bin 映射到 12 个音级（-1 = 不参与，超出人声/主旋律频段）。</summary>
    private static int[] BuildChromaBins(double binHz)
    {
        var bins = new int[WindowSize / 2 + 1];
        for (var bin = 0; bin < bins.Length; bin++)
        {
            var frequency = bin * binHz;
            if (frequency < MinChromaHz || frequency > MaxChromaHz)
            {
                bins[bin] = -1;
                continue;
            }

            var midi = 69.0 + 12.0 * Math.Log2(frequency / 440.0);
            bins[bin] = ((int)Math.Round(midi) % ChromaBins + ChromaBins) % ChromaBins;
        }

        return bins;
    }

    /// <summary>Remove the local mean, half-wave rectify, scale to unit std and smooth slightly.</summary>
    private static float[] NormalizeOnsets(float[] flux)
    {
        var count = flux.Length;
        var prefix = new double[count + 1];
        for (var i = 0; i < count; i++)
        {
            prefix[i + 1] = prefix[i] + flux[i];
        }

        var onset = new double[count];
        for (var i = 0; i < count; i++)
        {
            var from = Math.Max(0, i - EnvelopeRadius);
            var to = Math.Min(count - 1, i + EnvelopeRadius);
            var mean = (prefix[to + 1] - prefix[from]) / (to - from + 1);
            var value = flux[i] - mean;
            onset[i] = value > 0 ? value : 0;
        }

        var sum = 0.0;
        for (var i = 0; i < count; i++)
        {
            sum += onset[i];
        }

        var average = sum / count;
        var variance = 0.0;
        for (var i = 0; i < count; i++)
        {
            var diff = onset[i] - average;
            variance += diff * diff;
        }

        var std = Math.Sqrt(variance / count);
        var result = new float[count];
        for (var i = 0; i < count; i++)
        {
            result[i] = (float)Math.Max(0.0, (onset[i] - average) / (std > 1e-9 ? std : 1.0));
        }

        for (var i = 1; i < count - 1; i++)
        {
            result[i] = 0.25f * result[i - 1] + 0.5f * result[i] + 0.25f * result[i + 1];
        }

        return result;
    }

    private static (double Bpm, double Confidence) EstimateTempo(float[] onset, double fps, out double driftScore)
    {
        driftScore = 0;
        var count = onset.Length;
        var lagMin = Math.Max(2, (int)Math.Floor(60.0 * fps / MaxBpm));
        var lagMax = (int)Math.Ceiling(60.0 * fps / MinBpm);
        var ac = new double[lagMax + 2];
        for (var lag = 1; lag <= lagMax + 1; lag++)
        {
            if (lag >= count)
            {
                break;
            }

            var sum = 0.0;
            var terms = count - lag;
            for (var i = 0; i < terms; i++)
            {
                sum += onset[i] * onset[i + lag];
            }

            ac[lag] = sum / terms;
        }

        var scores = new double[lagMax + 2];
        var bestLag = -1;
        var bestScore = 0.0;
        var scoreSum = 0.0;
        var scoreCount = 0;
        for (var lag = lagMin; lag <= lagMax; lag++)
        {
            var score = CombScore(ac, lag) * PreferenceWeight(60.0 * fps / lag);
            scores[lag] = score;
            scoreSum += score;
            scoreCount++;
            if (score > bestScore)
            {
                bestScore = score;
                bestLag = lag;
            }
        }

        if (bestLag < 0)
        {
            return (0, 0);
        }

        var refinedLag = ParabolicPeak(ac, bestLag);
        if (refinedLag <= 0)
        {
            refinedLag = bestLag;
        }

        var bpm = 60.0 * fps / refinedLag;
        // Fold half/double tempo into the preferred range using the comb evidence.
        var bestFolded = bpm;
        var bestFoldedScore = CombScoreAtBpm(ac, fps, bpm) * PreferenceWeight(bpm);
        foreach (var candidate in new[] { bpm * 0.5, bpm * 2.0 })
        {
            if (candidate < MinBpm || candidate > MaxBpm)
            {
                continue;
            }

            var score = CombScoreAtBpm(ac, fps, candidate) * PreferenceWeight(candidate);
            if (score > bestFoldedScore * 1.05)
            {
                bestFolded = candidate;
                bestFoldedScore = score;
            }
        }

        bpm = bestFolded;
        // Zilux2 修正（2026-10-25）：梳状谱在倍速处天然并列（bpm 与 2·bpm 的三次泛音和几乎相等），
        // 快歌因此常被判成一半速度（节拍器 click 只剩 80 BPM 而实际是 160+）。折叠后补一次
        // 「半拍位置是否也有明显 onset」校验：若 beatLag/2 处的自相关仍有主拍足够比例强度，说明
        // 网格漏掉了隔拍的能量，把速度翻倍回真实拍。100~120 BPM 的倍速（200~240 BPM）用更严格的
        // 比例判定，避免把真正 100~120 BPM 的歌误翻倍。
        if (bpm > 0 && bpm < 120.0 && bpm * 2.0 <= MaxBpm)
        {
            var beatLag2 = 60.0 * fps / bpm;
            var acBeat2 = Interpolate(ac, beatLag2);
            var acHalf2 = Interpolate(ac, beatLag2 / 2.0);
            var threshold = bpm < 100.0 ? 0.55 : 0.78;
            if (acBeat2 > 1e-9 && acHalf2 >= acBeat2 * threshold)
            {
                bpm *= 2.0;
            }
        }
        var mean = scoreCount > 0 ? scoreSum / scoreCount : 0;
        var confidence = bestScore <= 1e-12
            ? 0
            : Math.Clamp((bestScore - mean) / bestScore, 0, 1);
        // The comb prefers the true beat period, but the prior can hide weak evidence; keep the
        // synthetic click tracks above the low-confidence threshold while staying honest on noise.
        confidence = Math.Clamp(confidence * 1.15, 0, 1);
        driftScore = 0;
        return (bpm, confidence);
    }

    private static double CombScore(double[] ac, int lag)
    {
        var score = ac[lag];
        if (2 * lag < ac.Length)
        {
            score += 0.5 * ac[2 * lag];
        }

        if (3 * lag < ac.Length)
        {
            score += 0.25 * ac[3 * lag];
        }

        return score;
    }

    private static double CombScoreAtBpm(double[] ac, double fps, double bpm)
    {
        if (bpm < MinBpm || bpm > MaxBpm)
        {
            return 0;
        }

        var lag = 60.0 * fps / bpm;
        var score = Interpolate(ac, lag);
        score += 0.5 * Interpolate(ac, lag * 2);
        score += 0.25 * Interpolate(ac, lag * 3);
        return score;
    }

    private static double PreferenceWeight(double bpm)
    {
        if (bpm >= PreferredMinBpm && bpm <= PreferredMaxBpm)
        {
            return 1.0;
        }

        if (bpm >= PreferredMinBpm * 0.9 && bpm <= PreferredMaxBpm * 1.1)
        {
            return 0.85;
        }

        return 0.6;
    }

    private static double ParabolicPeak(double[] ac, int lag)
    {
        if (lag <= 0 || lag + 1 >= ac.Length)
        {
            return lag;
        }

        var left = ac[lag - 1];
        var center = ac[lag];
        var right = ac[lag + 1];
        var denominator = left - 2 * center + right;
        if (Math.Abs(denominator) < 1e-12)
        {
            return lag;
        }

        var offset = 0.5 * (left - right) / denominator;
        offset = Math.Clamp(offset, -0.5, 0.5);
        return lag + offset;
    }

    private static double Interpolate(double[] values, double position)
    {
        if (position <= 1)
        {
            return values.Length > 1 ? values[1] : 0;
        }

        var index = (int)Math.Floor(position);
        if (index + 1 >= values.Length)
        {
            return values[^1];
        }

        var fraction = position - index;
        return values[index] + (values[index + 1] - values[index]) * fraction;
    }

    private static float SampleOnset(float[] onset, double framePosition)
    {
        if (framePosition <= 0)
        {
            return onset[0];
        }

        var index = (int)Math.Floor(framePosition);
        if (index + 1 >= onset.Length)
        {
            return onset[^1];
        }

        var fraction = (float)(framePosition - index);
        return onset[index] + (onset[index + 1] - onset[index]) * fraction;
    }

    private static double FitBeatPhase(float[] onset, double intervalFrames)
    {
        var bestPhase = 0.0;
        var bestScore = -1.0;
        for (var step = 0; step < 4; step++)
        {
            for (var phase = step * 0.25; phase < intervalFrames; phase += 1.0)
            {
                var score = 0.0;
                var beats = 0;
                for (var position = phase; position < onset.Length - 1; position += intervalFrames)
                {
                    score += SampleOnset(onset, position);
                    beats++;
                }

                if (beats == 0)
                {
                    continue;
                }

                score /= beats;
                if (score > bestScore)
                {
                    bestScore = score;
                    bestPhase = phase;
                }
            }
        }

        // Refine around the best whole-frame phase.
        var fineBest = bestPhase;
        for (var fine = -0.25; fine <= 0.26; fine += 0.05)
        {
            var phase = bestPhase + fine;
            if (phase < 0 || phase >= intervalFrames)
            {
                continue;
            }

            var score = 0.0;
            var beats = 0;
            for (var position = phase; position < onset.Length - 1; position += intervalFrames)
            {
                score += SampleOnset(onset, position);
                beats++;
            }

            if (beats == 0)
            {
                continue;
            }

            score /= beats;
            if (score > bestScore)
            {
                bestScore = score;
                fineBest = phase;
            }
        }

        return fineBest;
    }

    private static (int Meter, int Phase, double Confidence) DetectMeter(
        float[] lowEnergy,
        int frameCount,
        double firstBeatMs,
        double beatIntervalMs,
        int beatCount,
        double fps)
    {
        if (beatCount < 10)
        {
            return (4, 0, 0.2);
        }

        var accents = new double[beatCount];
        for (var beat = 0; beat < beatCount; beat++)
        {
            var frame = (int)Math.Round((firstBeatMs + beat * beatIntervalMs) / 1000.0 * fps);
            accents[beat] = AverageAt(lowEnergy, frameCount, frame, 1);
        }

        var overall = accents.Average();
        var bestMeter = 4;
        var bestPhase = 0;
        var bestContrast = double.NegativeInfinity;
        foreach (var meter in new[] { 4, 3 })
        {
            if (beatCount < meter * 2 + 2)
            {
                continue;
            }

            for (var phase = 0; phase < meter; phase++)
            {
                var downSum = 0.0;
                var downCount = 0;
                var otherSum = 0.0;
                var otherCount = 0;
                for (var beat = phase; beat < beatCount; beat += meter)
                {
                    downSum += accents[beat];
                    downCount++;
                }

                for (var beat = 0; beat < beatCount; beat++)
                {
                    if ((beat - phase) % meter == 0)
                    {
                        continue;
                    }

                    otherSum += accents[beat];
                    otherCount++;
                }

                if (downCount == 0 || otherCount == 0)
                {
                    continue;
                }

                var contrast = (downSum / downCount - otherSum / otherCount) / (overall + 1e-9);
                if (contrast > bestContrast)
                {
                    bestContrast = contrast;
                    bestMeter = meter;
                    bestPhase = phase;
                }
            }
        }

        if (double.IsNegativeInfinity(bestContrast))
        {
            return (4, 0, 0.2);
        }

        var confidence = Math.Clamp(bestContrast, 0, 1);
        return (bestMeter, bestPhase, confidence);
    }

    private static double AverageAt(float[] values, int count, int center, int radius)
    {
        var from = Math.Max(0, center - radius);
        var to = Math.Min(count - 1, center + radius);
        if (to < from)
        {
            return 0;
        }

        var sum = 0.0;
        for (var i = from; i <= to; i++)
        {
            sum += values[i];
        }

        return sum / (to - from + 1);
    }

    private static double[] BuildDownbeats(
        double firstDownbeatMs,
        double beatIntervalMs,
        int meter,
        double durationMs,
        out int barCount)
    {
        var barInterval = beatIntervalMs * meter;
        var result = new List<double>();
        for (var time = firstDownbeatMs; time <= durationMs; time += barInterval)
        {
            if (time < 0)
            {
                continue;
            }

            result.Add(Math.Round(time, 1));
            if (result.Count >= MaxDownbeats)
            {
                break;
            }
        }

        barCount = result.Count;
        return result.ToArray();
    }

    private static List<double> TrackBeats(float[] onset, double intervalFrames)
    {
        var count = onset.Length;
        var maximum = 0f;
        foreach (var value in onset)
        {
            if (value > maximum)
            {
                maximum = value;
            }
        }

        if (maximum <= 0)
        {
            return new List<double>();
        }

        var score = new double[count];
        var previous = new int[count];
        var best = -1;
        var bestValue = double.NegativeInfinity;
        for (var frame = 0; frame < count; frame++)
        {
            score[frame] = onset[frame] / maximum;
            previous[frame] = -1;
            var from = Math.Max(0, (int)Math.Floor(frame - 2.0 * intervalFrames));
            var to = Math.Min(frame - 1, (int)Math.Ceiling(frame - 0.5 * intervalFrames));
            var bestCandidate = 0.0;
            var bestCandidateIndex = -1;
            for (var candidate = from; candidate <= to; candidate++)
            {
                var ratio = (frame - candidate) / intervalFrames;
                var penalty = -BeatTightness * Math.Pow(Math.Log(ratio), 2);
                var value = score[candidate] + penalty;
                if (value > bestCandidate)
                {
                    bestCandidate = value;
                    bestCandidateIndex = candidate;
                }
            }

            score[frame] += bestCandidate;
            previous[frame] = bestCandidateIndex;
            if (score[frame] > bestValue)
            {
                bestValue = score[frame];
                best = frame;
            }
        }

        var frames = new List<int>();
        var cursor = best;
        while (cursor >= 0)
        {
            frames.Add(cursor);
            cursor = previous[cursor];
        }

        frames.Reverse();
        return frames.Select(frame => frame * 1000.0 * HopSize / 22050.0).ToList();
    }

    private static double MedianInterval(List<double> beats)
    {
        var intervals = new List<double>(beats.Count);
        for (var i = 1; i < beats.Count; i++)
        {
            var diff = beats[i] - beats[i - 1];
            if (diff > 0)
            {
                intervals.Add(diff);
            }
        }

        if (intervals.Count == 0)
        {
            return 0;
        }

        intervals.Sort();
        return intervals[intervals.Count / 2];
    }

    private static double IntervalDeviation(List<double> beats, double median)
    {
        if (median <= 0)
        {
            return 0;
        }

        var total = 0.0;
        var count = 0;
        for (var i = 1; i < beats.Count; i++)
        {
            total += Math.Abs(beats[i] - beats[i - 1] - median);
            count++;
        }

        return count == 0 ? 0 : total / count / median;
    }

    private static double[] DetectPhrases(
        double[] downbeats,
        float[] lowEnergy,
        float[] midEnergy,
        float[] highEnergy,
        float[] chroma,
        int frameCount,
        double fps,
        out double[][] barFeatures,
        out double[][] barChroma,
        double durationMs)
    {
        barFeatures = Array.Empty<double[]>();
        barChroma = Array.Empty<double[]>();
        if (downbeats.Length < MinPhraseBars + 1)
        {
            return Array.Empty<double>();
        }

        var barCount = downbeats.Length;
        var features = new double[barCount][];
        var chromaBars = new double[barCount][];
        for (var bar = 0; bar < barCount; bar++)
        {
            var startFrame = (int)Math.Round(downbeats[bar] / 1000.0 * fps);
            var endFrame = bar + 1 < barCount
                ? (int)Math.Round(downbeats[bar + 1] / 1000.0 * fps)
                : frameCount;
            startFrame = Math.Clamp(startFrame, 0, frameCount - 1);
            endFrame = Math.Clamp(endFrame, startFrame + 1, frameCount);
            features[bar] = new[]
            {
                AverageRange(lowEnergy, startFrame, endFrame),
                AverageRange(midEnergy, startFrame, endFrame),
                AverageRange(highEnergy, startFrame, endFrame),
            };
            chromaBars[bar] = AverageChroma(chroma, startFrame, endFrame);
        }

        // Normalize each band across bars so novelty is comparable across the whole track.
        for (var band = 0; band < 3; band++)
        {
            var mean = 0.0;
            for (var bar = 0; bar < barCount; bar++)
            {
                mean += features[bar][band];
            }

            mean = Math.Max(mean / barCount, 1e-9);
            for (var bar = 0; bar < barCount; bar++)
            {
                features[bar][band] /= mean;
            }
        }

        barFeatures = features;
        barChroma = chromaBars;
        var novelty = new double[barCount];
        for (var bar = 1; bar < barCount; bar++)
        {
            var sum = 0.0;
            for (var band = 0; band < 3; band++)
            {
                var diff = features[bar][band] - features[bar - 1][band];
                sum += diff * diff;
            }

            novelty[bar] = Math.Sqrt(sum);
        }

        for (var bar = 1; bar < barCount - 1; bar++)
        {
            novelty[bar] = 0.25 * novelty[bar - 1] + 0.5 * novelty[bar] + 0.25 * novelty[bar + 1];
        }

        var meanNovelty = novelty.Average();
        var variance = novelty.Select(value => (value - meanNovelty) * (value - meanNovelty)).Average();
        var threshold = meanNovelty + 0.5 * Math.Sqrt(variance);
        var starts = new List<double>();
        var last = 0;
        for (var bar = MinPhraseBars; bar < barCount; bar++)
        {
            if (novelty[bar] < threshold || bar - last < MinPhraseBars)
            {
                continue;
            }

            var time = downbeats[bar];
            if (time >= durationMs - 500)
            {
                break;
            }

            starts.Add(time);
            last = bar;
            if (starts.Count >= MaxPhraseStarts)
            {
                break;
            }
        }

        return starts.ToArray();
    }

    private static double AverageRange(float[] values, int from, int to)
    {
        if (to <= from)
        {
            return 0;
        }

        var sum = 0.0;
        for (var i = from; i < to; i++)
        {
            sum += values[i];
        }

        return sum / (to - from);
    }

    /// <summary>小节内 12 音级能量均值，L2 归一化后只保留音色分布（与音量无关）。</summary>
    private static double[] AverageChroma(float[] chroma, int from, int to)
    {
        var result = new double[ChromaBins];
        if (to <= from)
        {
            return result;
        }

        for (var frame = from; frame < to; frame++)
        {
            var offset = frame * ChromaBins;
            for (var bin = 0; bin < ChromaBins; bin++)
            {
                result[bin] += chroma[offset + bin];
            }
        }

        var norm = 0.0;
        for (var bin = 0; bin < ChromaBins; bin++)
        {
            norm += result[bin] * result[bin];
        }

        norm = Math.Sqrt(norm);
        if (norm < 1e-9)
        {
            return result;
        }

        for (var bin = 0; bin < ChromaBins; bin++)
        {
            result[bin] /= norm;
        }

        return result;
    }

    private static AnalysisSectionPayload[] BuildSections(
        double[] phraseStarts,
        double[] downbeats,
        double[][] barFeatures,
        double[][] barChroma,
        double durationMs,
        out double climaxStartMs,
        out double climaxEndMs,
        out double cueInMs,
        out double cueOutMs)
    {
        climaxStartMs = 0;
        climaxEndMs = 0;
        cueInMs = 0;
        cueOutMs = 0;
        var boundaries = new List<double> { 0 };
        foreach (var start in phraseStarts)
        {
            if (start > 1000 && start < durationMs)
            {
                boundaries.Add(start);
            }
        }

        if (boundaries[^1] < durationMs)
        {
            boundaries.Add(durationMs);
        }

        var sections = new List<AnalysisSectionPayload>(boundaries.Count);
        for (var i = 0; i + 1 < boundaries.Count; i++)
        {
            var start = boundaries[i];
            var end = boundaries[i + 1];
            if (end - start < 100)
            {
                continue;
            }

            sections.Add(new AnalysisSectionPayload
            {
                StartMs = Math.Round(start, 1),
                EndMs = Math.Round(end, 1),
                Label = string.Empty,
                Confidence = 0.3,
            });
        }

        if (sections.Count == 0)
        {
            sections.Add(new AnalysisSectionPayload
            {
                StartMs = 0,
                EndMs = Math.Round(durationMs, 1),
                Label = string.Empty,
                Confidence = 0.3,
            });
        }

        MarkClimax(sections, downbeats, barFeatures, barChroma, durationMs, out climaxStartMs, out climaxEndMs);
        LabelSections(sections, downbeats, barFeatures, durationMs, out cueInMs, out cueOutMs);

        return sections.ToArray();
    }

    /// <summary>
    /// 结构标注（p0-11）：在小节能量/低频占比/段落内走势上给每段打 intro / build / verse /
    /// chorus / drop / breakdown / outro，并给出两个混音 cue：
    /// <list type="bullet">
    /// <item>cueIn：下一首进场点——首个 drop（没有则首个副歌，再没有则 intro 结束），对齐 8 小节乐句；</item>
    /// <item>cueOut：这一首让位点——尾奏起点（没有则末段起点），对齐 8 小节乐句。</item>
    /// </list>
    /// 这是按小节统计的近似分段，不保证和人工标注一致；识别不到时 cue 为 0，调用方回退旧逻辑。
    /// </summary>
    private static void LabelSections(
        List<AnalysisSectionPayload> sections,
        double[] downbeats,
        double[][] barFeatures,
        double durationMs,
        out double cueInMs,
        out double cueOutMs)
    {
        cueInMs = 0;
        cueOutMs = 0;
        if (sections.Count == 0 || barFeatures.Length == 0 || downbeats.Length < 2)
        {
            return;
        }

        var barCount = barFeatures.Length;
        var barEnergy = new double[barCount];
        var barLow = new double[barCount];
        for (var bar = 0; bar < barCount; bar++)
        {
            var feature = barFeatures[bar];
            if (feature is null || feature.Length < 3)
            {
                continue;
            }

            barEnergy[bar] = (feature[0] * 0.45 + feature[1] * 0.30 + feature[2] * 0.45) / 1.2;
            barLow[bar] = feature[0];
        }

        var total = 0.0;
        for (var bar = 0; bar < barCount; bar++)
        {
            total += barEnergy[bar];
        }

        var average = Math.Max(total / barCount, 1e-9);
        var stats = new List<(int FromBar, int ToBar, double Mean, double Low, double Rise, int Bars)>();
        for (var index = 0; index < sections.Count; index++)
        {
            var fromBar = FirstBarAtOrAfter(downbeats, sections[index].StartMs);
            var toBar = FirstBarAtOrAfter(downbeats, sections[index].EndMs);
            fromBar = Math.Clamp(fromBar, 0, barCount);
            toBar = Math.Clamp(toBar, fromBar, barCount);
            var bars = toBar - fromBar;
            var sum = 0.0;
            var lowSum = 0.0;
            for (var bar = fromBar; bar < toBar; bar++)
            {
                sum += barEnergy[bar];
                lowSum += barLow[bar];
            }

            var mean = bars > 0 ? sum / bars : 0;
            var low = bars > 0 ? lowSum / bars : 0;
            var rise = 0.0;
            if (bars >= 4)
            {
                var headSum = 0.0;
                var tailSum = 0.0;
                var headCount = 0;
                var tailCount = 0;
                for (var bar = fromBar; bar < toBar; bar++)
                {
                    var quarter = Math.Max(1, bars / 4);
                    if (bar < fromBar + quarter)
                    {
                        headSum += barEnergy[bar];
                        headCount++;
                    }
                    else if (bar >= toBar - quarter)
                    {
                        tailSum += barEnergy[bar];
                        tailCount++;
                    }
                }

                var head = headCount > 0 ? headSum / headCount : 0;
                var tail = tailCount > 0 ? tailSum / tailCount : 0;
                rise = head > 1e-9 ? tail / head - 1 : 0;
            }

            stats.Add((fromBar, toBar, mean, low, rise, bars));
        }

        // 先给每段一个结构标签；首段/末段的 intro/outro 判定优先，避免被 drop 规则抢走。
        for (var index = 0; index < sections.Count; index++)
        {
            var stat = stats[index];
            var last = index == sections.Count - 1;
            var label = "verse";
            var confidence = 0.3;
            if (index == 0 && sections.Count >= 3 && (stat.Mean <= average * 0.95 || sections[index].EndMs - sections[index].StartMs < durationMs * 0.25))
            {
                label = "intro";
                confidence = 0.5;
            }
            else if (last && sections.Count >= 3 && (stat.Mean <= average * 0.95 || sections[index].EndMs - sections[index].StartMs < durationMs * 0.3))
            {
                label = "outro";
                confidence = 0.5;
            }
            else if (stat.Mean < average * 0.55 && stat.Bars >= MinClimaxBars)
            {
                label = "breakdown";
                confidence = 0.45;
            }
            else if (stat.Mean >= average * 1.18 && stat.Low >= 1.12 && stat.Bars >= MinClimaxBars / 2 && index > 0)
            {
                label = "drop";
                confidence = 0.55;
            }
            else if (stat.Mean >= average * 1.04)
            {
                label = "chorus";
                confidence = 0.5;
            }
            else if (stat.Rise >= 0.12 && stat.Mean >= average * 0.7)
            {
                label = "build";
                confidence = 0.4;
            }

            sections[index].Label = label;
            sections[index].Confidence = confidence;
        }

        // cueIn：首个 drop → 首个副歌 → intro 之后的第一段；都对齐 8 小节乐句。
        var phraseBars = 8;
        var firstInMs = 0.0;
        var cueInSection = -1;
        for (var index = 0; index < sections.Count; index++)
        {
            if (sections[index].Label is "drop" or "chorus")
            {
                firstInMs = sections[index].StartMs;
                cueInSection = index;
                break;
            }
        }

        if (cueInSection < 0)
        {
            for (var index = 0; index < sections.Count; index++)
            {
                if (sections[index].Label != "intro")
                {
                    firstInMs = sections[index].StartMs;
                    cueInSection = index;
                    break;
                }
            }
        }

        if (cueInSection >= 0)
        {
            // 不论 drop 还是副歌，入点都落在 8 小节乐句线上。
            firstInMs = PhraseAtOrAfter(downbeats, firstInMs, phraseBars);
            cueInMs = Math.Min(firstInMs, Math.Max(0, durationMs - 1000));
        }

        // cueOut：尾奏起点；没有尾奏时取最后一段的起点；再没有就按曲长留 8 小节。
        var lastOutro = -1;
        for (var index = sections.Count - 1; index >= 0; index--)
        {
            if (sections[index].Label == "outro")
            {
                lastOutro = index;
                break;
            }
        }

        var barMs = downbeats.Length >= 2
            ? Math.Max((downbeats[^1] - downbeats[0]) / (downbeats.Length - 1), 1.0)
            : Math.Max(durationMs / Math.Max(downbeats.Length, 1), 1.0);
        var fallbackOut = Math.Max(0, durationMs - barMs * phraseBars);
        var outMs = lastOutro >= 0 ? sections[lastOutro].StartMs : fallbackOut;
        cueOutMs = PhraseAtOrBefore(downbeats, outMs, phraseBars);
        if (cueOutMs < 0 || cueOutMs > durationMs)
        {
            cueOutMs = 0;
        }

        if (cueInMs > 0 && cueOutMs > 0 && cueOutMs <= cueInMs)
        {
            cueOutMs = 0;
        }
    }

    /// <summary>向上取到最近的 8 小节乐句边界（ms）；越界返回最后一个乐句边界。</summary>
    private static double PhraseAtOrAfter(double[] downbeats, double timeMs, int phraseBars)
    {
        if (downbeats.Length == 0 || phraseBars <= 0)
        {
            return timeMs;
        }

        var bar = FirstBarAtOrAfter(downbeats, timeMs);
        var aligned = (int)Math.Ceiling(bar / (double)phraseBars) * phraseBars;
        if (aligned >= downbeats.Length)
        {
            aligned = Math.Max(0, (downbeats.Length - 1) / phraseBars * phraseBars);
        }

        return aligned < downbeats.Length ? downbeats[aligned] : timeMs;
    }

    /// <summary>向下取到最近的 8 小节乐句边界（ms）；越界返回 0。</summary>
    private static double PhraseAtOrBefore(double[] downbeats, double timeMs, int phraseBars)
    {
        if (downbeats.Length == 0 || phraseBars <= 0)
        {
            return Math.Max(0, timeMs);
        }

        var bar = FirstBarAtOrAfter(downbeats, timeMs);
        if (bar >= downbeats.Length)
        {
            bar = downbeats.Length - 1;
        }

        var aligned = bar / phraseBars * phraseBars;
        return aligned >= 0 && aligned < downbeats.Length ? downbeats[aligned] : 0;
    }

    /// <summary>
    /// 给「高潮段」打标并给出进度条标记窗口。副歌通常重复 2~3 次，所以先在内部段落里找
    /// 音色+能量轮廓相似（<see cref="MinChorusSimilarity"/>）且足够响的一对段，标其中
    /// <b>第一次出现</b>的位置，截到 <see cref="MaxClimaxBars"/> 小节；找不到重复段时回退到
    /// 能量最高的 <see cref="FallbackClimaxBars"/> 小节窗口。这是结构近似，不等于人工标注。
    /// </summary>
    private static void MarkClimax(
        List<AnalysisSectionPayload> sections,
        double[] downbeats,
        double[][] barFeatures,
        double[][] barChroma,
        double durationMs,
        out double climaxStartMs,
        out double climaxEndMs)
    {
        climaxStartMs = 0;
        climaxEndMs = 0;
        if (sections.Count < 3 ||
            barFeatures.Length < MinClimaxBars ||
            barChroma.Length != barFeatures.Length ||
            downbeats.Length < MinClimaxBars)
        {
            return;
        }

        // 每小节能量：低频和高频更能代表「响」，中频权重略低；barFeatures 已按频段均值归一化，
        // 加权后全曲均值约等于 1，阈值可以直接按倍数判断。
        var barEnergy = new double[barFeatures.Length];
        for (var bar = 0; bar < barFeatures.Length; bar++)
        {
            var feature = barFeatures[bar];
            if (feature is null || feature.Length < 3)
            {
                continue;
            }

            barEnergy[bar] = (feature[0] * 0.45 + feature[1] * 0.30 + feature[2] * 0.45) / 1.2;
        }

        // 3 小节滑动平均，压掉单小节的鼓点抖动。
        var smooth = new double[barEnergy.Length];
        for (var bar = 0; bar < barEnergy.Length; bar++)
        {
            var from = Math.Max(0, bar - 1);
            var to = Math.Min(barEnergy.Length, bar + 2);
            var sum = 0.0;
            for (var i = from; i < to; i++)
            {
                sum += barEnergy[i];
            }

            smooth[bar] = sum / (to - from);
        }

        var total = 0.0;
        for (var bar = 0; bar < smooth.Length; bar++)
        {
            total += smooth[bar];
        }

        var average = Math.Max(total / smooth.Length, 1e-9);

        var candidates = new List<(int Index, int FromBar, int ToBar, double Mean)>();
        for (var index = 1; index + 1 < sections.Count; index++)
        {
            var section = sections[index];
            if (!string.IsNullOrEmpty(section.Label))
            {
                continue;
            }

            var fromBar = FirstBarAtOrAfter(downbeats, section.StartMs);
            var toBar = FirstBarAtOrAfter(downbeats, section.EndMs);
            var bars = toBar - fromBar;
            if (bars < MinClimaxBars)
            {
                continue;
            }

            var sum = 0.0;
            for (var bar = fromBar; bar < toBar; bar++)
            {
                sum += smooth[bar];
            }

            candidates.Add((index, fromBar, toBar, sum / bars));
        }

        if (candidates.Count == 0)
        {
            return;
        }

        // 先找「重复出现的副歌」：两段轮廓足够像、且都比平均响，取能量最高的一对，
        // 标记第一次出现的位置——这才是听众心里的「高潮起点」。
        var profiles = new double[candidates.Count][];
        for (var i = 0; i < candidates.Count; i++)
        {
            profiles[i] = BuildSectionProfile(candidates[i].FromBar, candidates[i].ToBar, smooth, barChroma);
        }

        var chorusA = -1;
        var chorusB = -1;
        var chorusScore = double.MinValue;
        for (var i = 0; i < candidates.Count; i++)
        {
            for (var j = i + 1; j < candidates.Count; j++)
            {
                if (candidates[i].Mean < average * 0.95 || candidates[j].Mean < average * 0.95)
                {
                    continue;
                }

                var similarity = CosineProfile(profiles[i], profiles[j]);
                if (similarity < MinChorusSimilarity)
                {
                    continue;
                }

                // 两段都够响、又足够像：能量下限越高越可能是副歌，相似度做微弱加权。
                var score = Math.Min(candidates[i].Mean, candidates[j].Mean) * (1.0 + 0.05 * similarity);
                if (score <= chorusScore)
                {
                    continue;
                }

                chorusScore = score;
                chorusA = i;
                chorusB = j;
            }
        }

        if (chorusA >= 0 && chorusB >= 0)
        {
            var first = candidates[chorusA].FromBar <= candidates[chorusB].FromBar ? chorusA : chorusB;
            var chosen = candidates[first];
            var bars = Math.Min(chosen.ToBar - chosen.FromBar, MaxClimaxBars);
            // 短歌里 16 小节可能占掉三成进度条，再按曲长收一次（至少保留 8 小节）。
            var barMs = downbeats.Length >= 2
                ? Math.Max((downbeats[^1] - downbeats[0]) / (downbeats.Length - 1), 1.0)
                : Math.Max(durationMs / Math.Max(downbeats.Length, 1), 1.0);
            var maxBarsByDuration = (int)Math.Floor(durationMs * MaxClimaxWidthRatio / barMs);
            bars = Math.Min(bars, Math.Max(maxBarsByDuration, MinClimaxBars));
            climaxStartMs = downbeats[chosen.FromBar];
            var endBar = chosen.FromBar + bars;
            climaxEndMs = endBar < downbeats.Length ? downbeats[endBar] : durationMs;
            return;
        }

        // 没有重复副歌：退回「能量最高段落 + 段落内最优 8 小节」。
        var bestIndex = -1;
        var bestScoreValue = 0.0;
        for (var i = 0; i < candidates.Count; i++)
        {
            var bars = candidates[i].ToBar - candidates[i].FromBar;
            // 略偏爱长一点的段落，避免只挑到一两拍的鼓点爆点。
            var score = candidates[i].Mean * (1.0 + 0.05 * Math.Min(1.0, (bars - MinClimaxBars) / 16.0));
            if (score <= bestScoreValue)
            {
                continue;
            }

            bestScoreValue = score;
            bestIndex = candidates[i].Index;
        }

        if (bestIndex < 0 || bestScoreValue < average * MinClimaxEnergyRatio)
        {
            return;
        }

        var sectionStartBar = FirstBarAtOrAfter(downbeats, sections[bestIndex].StartMs);
        var sectionEndBar = FirstBarAtOrAfter(downbeats, sections[bestIndex].EndMs);
        if (sectionEndBar - sectionStartBar < MinClimaxBars)
        {
            return;
        }

        var windowStart = sectionStartBar;
        var windowMean = double.MinValue;
        for (var start = sectionStartBar; start + FallbackClimaxBars <= sectionEndBar; start++)
        {
            var sum = 0.0;
            for (var bar = start; bar < start + FallbackClimaxBars; bar++)
            {
                sum += smooth[bar];
            }

            var mean = sum / FallbackClimaxBars;
            if (mean <= windowMean)
            {
                continue;
            }

            windowMean = mean;
            windowStart = start;
        }

        climaxStartMs = downbeats[windowStart];
        var windowEndBar = windowStart + FallbackClimaxBars;
        climaxEndMs = windowEndBar < downbeats.Length ? downbeats[windowEndBar] : durationMs;
    }

    /// <summary>
    /// 把段落重采样成 <see cref="SimilarityPoints"/> 个点，每点 = 12 音级 chroma 均值 +
    /// 0.7×平滑能量；副歌重复时两者的音色与能量走向会高度一致，即使小节数不同也能对齐比较。
    /// </summary>
    private static double[] BuildSectionProfile(int fromBar, int toBar, double[] smooth, double[][] barChroma)
    {
        var bars = Math.Max(toBar - fromBar, 1);
        var stride = ChromaBins + 1;
        var profile = new double[SimilarityPoints * stride];
        for (var point = 0; point < SimilarityPoints; point++)
        {
            var start = fromBar + (int)Math.Floor(bars * (double)point / SimilarityPoints);
            var end = fromBar + (int)Math.Floor(bars * (double)(point + 1) / SimilarityPoints);
            end = Math.Clamp(end, start + 1, toBar);
            start = Math.Clamp(start, fromBar, toBar - 1);
            var offset = point * stride;
            for (var bin = 0; bin < ChromaBins; bin++)
            {
                var sum = 0.0;
                for (var bar = start; bar < end; bar++)
                {
                    sum += barChroma[bar][bin];
                }

                profile[offset + bin] = sum / (end - start);
            }

            var energy = 0.0;
            for (var bar = start; bar < end; bar++)
            {
                energy += smooth[bar];
            }

            profile[offset + ChromaBins] = 0.7 * energy / (end - start);
        }

        return profile;
    }

    /// <summary>两个段落轮廓的余弦相似度（0~1）；任一范数为 0 视为不相似。</summary>
    private static double CosineProfile(double[] a, double[] b)
    {
        var dot = 0.0;
        var normA = 0.0;
        var normB = 0.0;
        var length = Math.Min(a.Length, b.Length);
        for (var i = 0; i < length; i++)
        {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        var scale = Math.Sqrt(normA) * Math.Sqrt(normB);
        return scale < 1e-9 ? 0.0 : dot / scale;
    }

    /// <summary>升序时间数组里第一个 ≥ 目标时间的小节下标；越界返回数组长度。</summary>
    private static int FirstBarAtOrAfter(double[] downbeats, double timeMs)
    {
        var low = 0;
        var high = downbeats.Length;
        while (low < high)
        {
            var mid = (low + high) / 2;
            if (downbeats[mid] < timeMs)
            {
                low = mid + 1;
            }
            else
            {
                high = mid;
            }
        }

        return low;
    }

    /// <summary>In-place radix-2 FFT, same butterfly layout as AudioFeatures.AudioAnalyzer.</summary>
    private static void Fft(float[] real, float[] imag)
    {
        const int size = WindowSize;
        for (int i = 1, j = 0; i < size; i++)
        {
            var bit = size >> 1;
            for (; (j & bit) != 0; bit >>= 1)
            {
                j ^= bit;
            }

            j ^= bit;
            if (i < j)
            {
                (real[i], real[j]) = (real[j], real[i]);
                (imag[i], imag[j]) = (imag[j], imag[i]);
            }
        }

        for (var length = 2; length <= size; length <<= 1)
        {
            var angle = -2.0 * Math.PI / length;
            var stepReal = Math.Cos(angle);
            var stepImag = Math.Sin(angle);
            for (var start = 0; start < size; start += length)
            {
                var currentReal = 1.0;
                var currentImag = 0.0;
                for (var k = 0; k < length / 2; k++)
                {
                    var even = start + k;
                    var odd = even + length / 2;
                    var oddReal = real[odd] * currentReal - imag[odd] * currentImag;
                    var oddImag = real[odd] * currentImag + imag[odd] * currentReal;
                    real[odd] = real[even] - (float)oddReal;
                    imag[odd] = imag[even] - (float)oddImag;
                    real[even] = (float)(real[even] + oddReal);
                    imag[even] = (float)(imag[even] + oddImag);

                    var nextReal = currentReal * stepReal - currentImag * stepImag;
                    currentImag = currentReal * stepImag + currentImag * stepReal;
                    currentReal = nextReal;
                }
            }
        }
    }
}
