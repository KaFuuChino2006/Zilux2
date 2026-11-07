namespace Zilux2.Analysis;

/// <summary>
/// Offline beat analysis (contract docs/zilux2-beat-analysis-contract.md §4):
/// SuperFlux spectral-flux onsets over a 1024/512 Hann STFT (whole-band + low/mid/high bands) →
/// per-band onset envelopes → sliding-window autocorrelation with harmonic comb voting →
/// octave disambiguation from band evidence → Ellis-style dynamic-programming beat tracking
/// (the beat grid is now the primary output; tempo drift is measured from it) →
/// 4/3 downbeat phase selection from low-band accents → bar-level novelty for phrase boundaries.
/// p0-13 also emits a per-window tempo curve (`tempoCurveMs` / `tempoCurveBpm`, median-smoothed
/// and folded toward the track BPM) so consumers can size bars locally on tempo-changing tracks.
/// Tempo is still reported as one number, but `beatsMs` carries the tracked grid so drifting
/// tracks can be consumed at their real beat positions. Runs on the caller's thread (the
/// analysis service keeps it off the UI).
/// </summary>
internal static class BeatAnalyzer
{
    internal const string AnalyzerVersion = "p0-15-tail-anchor";

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
        var lowFlux = new float[frameCount];
        var midFlux = new float[frameCount];
        var highFlux = new float[frameCount];
        var lowEnergy = new float[frameCount];
        var midEnergy = new float[frameCount];
        var highEnergy = new float[frameCount];
        ComputeOnsets(samples, frameCount, sampleRate, flux, lowFlux, midFlux, highFlux,
            lowEnergy, midEnergy, highEnergy, out var chromaFrames);

        var onset = NormalizeOnsets(flux);
        var lowOnset = NormalizeOnsets(lowFlux);
        var midOnset = NormalizeOnsets(midFlux);
        // Tempo 判据以底鼓（低频）为主、军鼓（中频）为辅；高频踩镲不参与 tempo 主判据，
        // 避免八分音符镲片把自相关锁到 2 倍速。
        var tempoOnset = MixOnsets((lowOnset, 0.55), (midOnset, 0.30), (onset, 0.15));

        var (bpm, bpmConfidence, tempoCurveMs, tempoCurveBpm) = EstimateTempo(tempoOnset, lowOnset, fps);
        var acfBpm = bpm;
        if (bpm <= 0)
        {
            bpm = 120.0;
            bpmConfidence = 0.0;
        }

        var intervalFrames = 60.0 * fps / bpm;
        var beatIntervalMs = 60000.0 / bpm;

        // 拍点跟踪是主输出：DP 网格给出真实拍点，并用其自身中位间隔测漂移。
        // ACF 与 DP 的中位速度一致（±8%）时用 DP 的值回写 BPM——DP 的整曲积分误差更小。
        var beats = TrackBeats(tempoOnset, intervalFrames, fps, durationMs, out var tempoStability);

        double firstBeatMs;
        double firstDownbeatMs;
        int meter;
        int meterPhase;
        double meterConfidence;
        double[] downbeats;
        int barCount;
        double[] beatTimesMs;
        var dpSlopeBpm = 0.0;
        var dpMedian = 0.0;
        if (beats.Count >= 10)
        {
            // DP 网格的最小二乘斜率比中位间隔更细：±0.5 帧的量化误差被整曲几十拍平均掉。
            dpSlopeBpm = BeatSlopeBpm(beats);
            if (dpSlopeBpm >= MinBpm && dpSlopeBpm <= MaxBpm && Math.Abs(dpSlopeBpm - bpm) <= bpm * 0.03)
            {
                bpm = dpSlopeBpm;
            }
            else
            {
                dpMedian = MedianInterval(beats);
                if (dpMedian > 0)
                {
                    var medianBpm = 60000.0 / dpMedian;
                    if (medianBpm >= MinBpm && medianBpm <= MaxBpm && Math.Abs(medianBpm - bpm) <= bpm * 0.06 && tempoStability >= 0.6)
                    {
                        bpm = medianBpm;
                    }
                }
            }

            beatIntervalMs = 60000.0 / bpm;
            intervalFrames = 60.0 * fps / bpm;
            firstBeatMs = beats[0];
            (meter, meterPhase, meterConfidence) = DetectMeter(beats, lowEnergy, midEnergy, frameCount, fps);
            downbeats = BuildDownbeatsFromBeats(beats, meter, meterPhase, out barCount);
            firstDownbeatMs = downbeats.Length > 0 ? downbeats[0] : firstBeatMs;
            beatTimesMs = beats.ToArray();
            if (beatTimesMs.Length > 4000)
            {
                beatTimesMs = beatTimesMs[..4000];
            }
        }
        else
        {
            // 兜底：DP 拍点不足（极短/极静）时退回「首拍 + 常数间隔」。
            var phase = FitBeatPhase(onset, intervalFrames);
            firstBeatMs = phase * 1000.0 * HopSize / sampleRate;
            (meter, meterPhase, meterConfidence) = DetectMeterConstant(
                lowEnergy,
                frameCount,
                firstBeatMs,
                beatIntervalMs,
                (int)Math.Max(1, (durationMs - firstBeatMs) / beatIntervalMs + 1),
                fps);
            firstDownbeatMs = firstBeatMs + meterPhase * beatIntervalMs;
            if (firstDownbeatMs > durationMs + beatIntervalMs)
            {
                firstDownbeatMs = firstBeatMs;
                meterPhase = 0;
            }

            downbeats = BuildDownbeats(firstDownbeatMs, beatIntervalMs, meter, durationMs, out barCount);
            beatTimesMs = BuildConstantBeatTimes(firstBeatMs, beatIntervalMs, durationMs);
            tempoStability = 0;
        }

        var phraseStarts = DetectPhrases(
            downbeats, lowEnergy, midEnergy, highEnergy, chromaFrames, frameCount, fps, out var barFeatures, out var barChroma, durationMs);
        var sections = BuildSections(
            phraseStarts, downbeats, barFeatures, barChroma, durationMs,
            out var climaxStartMs, out var climaxEndMs, out var cueInMs, out var cueOutMs);

        if (bpmConfidence < 0.35)
        {
            warnings.Add("low-confidence");
        }

        if (beats.Count >= 16 && tempoStability < 0.6)
        {
            warnings.Add("tempo-drift");
        }

        payload.Bpm = Math.Round(bpm, 2);
        payload.BpmConfidence = Math.Round(bpmConfidence, 3);
        payload.Meter = meter;
        payload.MeterConfidence = Math.Round(meterConfidence, 3);
        payload.BeatIntervalMs = Math.Round(beatIntervalMs, 2);
        payload.FirstBeatMs = Math.Round(firstBeatMs, 1);
        payload.FirstDownbeatMs = Math.Round(firstDownbeatMs, 1);
        payload.BeatsMs = beatTimesMs;
        payload.TempoStability = Math.Round(tempoStability, 3);
        payload.TempoCurveMs = tempoCurveMs;
        payload.TempoCurveBpm = tempoCurveBpm;
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

    /// <summary>
    /// p0-12 onset 前端：谱幅值先做频率向 max 滤波（SuperFlux，抑制颤音/滑音谐波峰在时间差分里
    /// 产生的假通量），再取对数压缩后做时间差分；同时按频段（&lt;160Hz / &lt;2000Hz / 其余）累加
    /// 分频段通量，供 tempo 判据与倍速消歧使用。频段能量仍用原始幅值，避免 max 滤波抹平滑低频包络。
    /// </summary>
    private static void ComputeOnsets(
        float[] samples,
        int frameCount,
        int sampleRate,
        float[] flux,
        float[] lowFlux,
        float[] midFlux,
        float[] highFlux,
        float[] lowEnergy,
        float[] midEnergy,
        float[] highEnergy,
        out float[] chromaFrames)
    {
        chromaFrames = new float[frameCount * ChromaBins];
        var real = new float[WindowSize];
        var imag = new float[WindowSize];
        var magnitudes = new float[WindowSize / 2 + 1];
        var previousPeak = new float[WindowSize / 2 + 1];
        var binHz = sampleRate / (double)WindowSize;
        var pitchBins = BuildChromaBins(binHz);
        // 22.05kHz 下 bin 间距约 21.5Hz，±1 bin ≈ ±21Hz；高采样率时按比例放宽。
        var maxRadius = sampleRate <= 24000 ? 1 : 2;
        for (var frame = 0; frame < frameCount; frame++)
        {
            var offset = frame * HopSize;
            for (var i = 0; i < WindowSize; i++)
            {
                real[i] = samples[offset + i] * Hann[i];
                imag[i] = 0f;
            }

            Fft(real, imag);

            for (var bin = 1; bin <= WindowSize / 2; bin++)
            {
                magnitudes[bin] = (float)(Math.Sqrt(real[bin] * real[bin] + imag[bin] * imag[bin]) / WindowSize);
            }

            double fluxSum = 0;
            double lowFluxSum = 0;
            double midFluxSum = 0;
            double highFluxSum = 0;
            double low = 0;
            double mid = 0;
            double high = 0;
            var chromaOffset = frame * ChromaBins;
            for (var bin = 1; bin <= WindowSize / 2; bin++)
            {
                var peak = 0f;
                var fromBin = Math.Max(1, bin - maxRadius);
                var toBin = Math.Min(WindowSize / 2, bin + maxRadius);
                for (var other = fromBin; other <= toBin; other++)
                {
                    if (magnitudes[other] > peak)
                    {
                        peak = magnitudes[other];
                    }
                }

                // Log compression keeps quiet percussive attacks visible next to loud bass.
                var compressed = Math.Log(1.0 + 20.0 * peak);
                var diff = compressed - previousPeak[bin];
                if (diff > 0)
                {
                    var frequencyForFlux = bin * binHz;
                    fluxSum += diff;
                    if (frequencyForFlux < 160)
                    {
                        lowFluxSum += diff;
                    }
                    else if (frequencyForFlux < 2000)
                    {
                        midFluxSum += diff;
                    }
                    else if (frequencyForFlux < 8000)
                    {
                        highFluxSum += diff;
                    }
                }

                previousPeak[bin] = (float)compressed;

                var magnitude = magnitudes[bin];
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
                    chromaFrames[chromaOffset + pitch] += magnitude;
                }
            }

            var norm = WindowSize / 2.0;
            flux[frame] = (float)(fluxSum / norm);
            lowFlux[frame] = (float)(lowFluxSum / norm);
            midFlux[frame] = (float)(midFluxSum / norm);
            highFlux[frame] = (float)(highFluxSum / norm);
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

    /// <summary>把多路 onset 包络按权重混成一路（用于 tempo 判据的分频段加权）。</summary>
    private static float[] MixOnsets(params (float[] Values, double Weight)[] parts)
    {
        if (parts.Length == 0)
        {
            return Array.Empty<float>();
        }

        var count = parts[0].Values.Length;
        var totalWeight = 0.0;
        foreach (var part in parts)
        {
            totalWeight += part.Weight;
        }

        var result = new float[count];
        if (totalWeight <= 0)
        {
            return result;
        }

        for (var i = 0; i < count; i++)
        {
            var sum = 0.0;
            foreach (var part in parts)
            {
                sum += part.Values[i] * part.Weight;
            }

            result[i] = (float)(sum / totalWeight);
        }

        return result;
    }

    /// <summary>
    /// p0-12 tempo 估计：滑窗自相关 + 谐波梳状投票。
    /// - 8 秒窗 / 1 秒跳；逐窗按自身峰值归一后累加，静音前奏/尾奏不会稀释整曲平均；
    /// - 倍速消歧改用「隔拍能量差」与「半拍位置底鼓/军鼓能量」两条频段证据；
    /// - 置信度 = 峰值 margin（0.55）+ 窗口一致度（0.45）。
    /// </summary>
    private static (double Bpm, double Confidence, double[] CurveMs, double[] CurveBpm) EstimateTempo(
        float[] tempoOnset, float[] lowOnset, double fps)
    {
        var count = tempoOnset.Length;
        var lagMin = Math.Max(2, (int)Math.Floor(60.0 * fps / MaxBpm));
        var lagMax = Math.Min(count - 2, (int)Math.Ceiling(60.0 * fps / MinBpm));
        if (lagMax <= lagMin + 2)
        {
            return (0, 0, Array.Empty<double>(), Array.Empty<double>());
        }

        var windowFrames = Math.Min(count, Math.Max(lagMax * 3, (int)Math.Round(8.0 * fps)));
        var hopFrames = Math.Max(1, Math.Min(windowFrames / 4, (int)Math.Round(1.0 * fps)));
        var aggregate = new double[lagMax + 2];
        // 原始 ACF 的聚合副本：抛物线细化在它上面做，避免梳状谱的多延迟叠加把峰顶抹平。
        var acfAggregate = new double[lagMax + 2];
        var votes = new List<double>(64);
        var windowCount = 0;
        var curveMs = new List<double>(64);
        var curveBpm = new List<double>(64);
        var gridBpms = new List<double>(128);
        for (var value = MinBpm; value <= MaxBpm + 0.001; value += 2.0)
        {
            gridBpms.Add(value);
        }

        var gridCos = new double[gridBpms.Count];
        var gridSin = new double[gridBpms.Count];
        for (var index = 0; index < gridBpms.Count; index++)
        {
            var omega = 2.0 * Math.PI * gridBpms[index] / 60.0 / fps;
            gridCos[index] = Math.Cos(omega);
            gridSin[index] = Math.Sin(omega);
        }

        for (var start = 0; start + windowFrames <= count; start += hopFrames)
        {
            var energy = 0.0;
            for (var i = start; i < start + windowFrames; i++)
            {
                energy += tempoOnset[i];
            }

            if (energy <= windowFrames * 1e-3)
            {
                continue;
            }

            var mean = energy / windowFrames;
            var bestTempoScore = 0.0;
            var bestTempoIndex = -1;
            var tempoScores = new double[gridBpms.Count];
            for (var index = 0; index < gridBpms.Count; index++)
            {
                var re = 0.0;
                var im = 0.0;
                var cos = 1.0;
                var sin = 0.0;
                var cosStep = gridCos[index];
                var sinStep = gridSin[index];
                for (var i = start; i < start + windowFrames; i++)
                {
                    var value = tempoOnset[i] - mean;
                    re += value * cos;
                    im += value * sin;
                    var nextCos = (cos * cosStep) - (sin * sinStep);
                    sin = (sin * cosStep) + (cos * sinStep);
                    cos = nextCos;
                }

                var tempoScore = Math.Sqrt((re * re) + (im * im)) / windowFrames * PreferenceWeight(gridBpms[index]);
                tempoScores[index] = tempoScore;
                if (tempoScore > bestTempoScore)
                {
                    bestTempoScore = tempoScore;
                    bestTempoIndex = index;
                }
            }

            if (bestTempoIndex >= 0 && bestTempoScore > 1e-9)
            {
                var bpmAtPeak = gridBpms[bestTempoIndex];
                if (bestTempoIndex > 0 && bestTempoIndex < gridBpms.Count - 1)
                {
                    var left = tempoScores[bestTempoIndex - 1];
                    var center = tempoScores[bestTempoIndex];
                    var right = tempoScores[bestTempoIndex + 1];
                    var denominator = left - (2 * center) + right;
                    if (Math.Abs(denominator) > 1e-12)
                    {
                        var offset = 0.5 * (left - right) / denominator;
                        if (Math.Abs(offset) <= 1)
                        {
                            bpmAtPeak += offset * 2.0;
                        }
                    }
                }

                curveMs.Add((start + (windowFrames / 2.0)) / fps * 1000.0);
                curveBpm.Add(bpmAtPeak);
            }
            var local = new double[lagMax + 2];
            for (var lag = 1; lag <= lagMax; lag++)
            {
                var sum = 0.0;
                var terms = windowFrames - lag;
                for (var i = start; i + lag < start + windowFrames; i++)
                {
                    sum += (tempoOnset[i] - mean) * (tempoOnset[i + lag] - mean);
                }

                local[lag] = terms > 0 ? sum / terms : 0;
            }

            var localMax = 0.0;
            var bestLag = lagMin;
            var raw = new double[lagMax + 2];
            Array.Copy(local, raw, lagMax + 1);
            for (var lag = lagMin; lag <= lagMax; lag++)
            {
                var score = CombScore(local, lag) * PreferenceWeight(60.0 * fps / lag);
                local[lag] = score;
                if (score > localMax)
                {
                    localMax = score;
                }

                if (score > local[bestLag])
                {
                    bestLag = lag;
                }
            }

            if (localMax <= 1e-9)
            {
                continue;
            }

            for (var lag = lagMin; lag <= lagMax; lag++)
            {
                aggregate[lag] += local[lag] / localMax;
                acfAggregate[lag] += raw[lag] / localMax;
            }

            votes.Add(60.0 * fps / bestLag);
            windowCount++;
        }

        if (windowCount == 0)
        {
            return (0, 0, Array.Empty<double>(), Array.Empty<double>());
        }

        var best = lagMin;
        for (var lag = lagMin; lag <= lagMax; lag++)
        {
            if (aggregate[lag] > aggregate[best])
            {
                best = lag;
            }
        }

        var second = -1;
        var separation = Math.Max(2, (int)Math.Round(best * 0.06));
        for (var lag = lagMin; lag <= lagMax; lag++)
        {
            if (Math.Abs(lag - best) <= separation)
            {
                continue;
            }

            if (second < 0 || aggregate[lag] > aggregate[second])
            {
                second = lag;
            }
        }

        var margin = second > 0 && aggregate[best] > 1e-9
            ? Math.Clamp((aggregate[best] - aggregate[second]) / aggregate[best], 0, 1)
            : 0.0;

        // 用原始 ACF 在梳状峰附近做亚帧细化，避免 43Hz 帧率下 BPM 被量化成整数延迟（如 143.5 = lag18）。
        var refineLag = best;
        var fromLag = Math.Max(lagMin, best - 1);
        var toLag = Math.Min(lagMax, best + 1);
        for (var lag = fromLag; lag <= toLag; lag++)
        {
            if (acfAggregate[lag] > acfAggregate[refineLag])
            {
                refineLag = lag;
            }
        }

        var refinedLag = ParabolicPeak(acfAggregate, refineLag);
        if (refinedLag <= 0)
        {
            refinedLag = best;
        }

        var bpm = 60.0 * fps / refinedLag;
        bpm = FoldOctaves(bpm, aggregate, fps);
        bpm = CorrectOctaveWithBandEvidence(bpm, tempoOnset, lowOnset, fps);
        bpm = Math.Clamp(bpm, MinBpm, MaxBpm);
        // 置信度低说明「哪个梳状峰才是拍」本身有歧义：这时再用 onset 网格命中率
        // 在倍速 / 三连音候选里挑解释力明显更强的那个（1.06 的余量防止来回抖）。
        var initialAgreement = AgreementRatio(votes, bpm);
        if (0.55 * margin + 0.45 * initialAgreement < 0.50)
        {
            bpm = RefineWithGridEvidence(bpm, tempoOnset, fps);
        }

        var agreementRatio = AgreementRatio(votes, bpm);
        var confidence = Math.Clamp(0.55 * margin + 0.45 * agreementRatio, 0, 1);

        // 速度曲线做 5 点中位数平滑，抑制个别窗口的倍速跳动。
        var smoothedBpm = new double[curveBpm.Count];
        for (var index = 0; index < curveBpm.Count; index++)
        {
            var from = Math.Max(0, index - 2);
            var to = Math.Min(curveBpm.Count - 1, index + 2);
            var slice = new double[to - from + 1];
            for (var neighbour = from; neighbour <= to; neighbour++)
            {
                slice[neighbour - from] = curveBpm[neighbour];
            }

            Array.Sort(slice);
            smoothedBpm[index] = slice[slice.Length / 2];
        }

        // 曲线里仍可能整段跳到 2× / 0.5×（典型：一半窗 114、一半窗 228）。
        // 以整曲 BPM 为锚把每个点折叠到最近的倍速档位，避免过渡小节长被曲线里的错拍带偏。
        if (bpm >= 40 && bpm <= 240)
        {
            for (var index = 0; index < smoothedBpm.Length; index++)
            {
                var value = smoothedBpm[index];
                if (!(value >= 8) || !double.IsFinite(value))
                {
                    continue;
                }

                while (value > bpm * 1.5)
                {
                    value /= 2;
                }

                while (value < bpm / 1.5)
                {
                    value *= 2;
                }

                smoothedBpm[index] = Math.Round(value, 1);
            }
        }

        return (bpm, confidence, curveMs.ToArray(), smoothedBpm);
    }

    /// <summary>窗口投票与最终 BPM 的一致率（同速 ±3%、倍速 ±6%）。</summary>
    private static double AgreementRatio(List<double> votes, double bpm)
    {
        if (votes.Count == 0 || bpm <= 0)
        {
            return 0;
        }

        var agreement = 0;
        foreach (var vote in votes)
        {
            var ratio = vote / bpm;
            if (Math.Abs(ratio - 1.0) <= 0.03 || Math.Abs(ratio - 2.0) <= 0.06 || Math.Abs(ratio - 0.5) <= 0.03)
            {
                agreement++;
            }
        }

        return agreement / (double)votes.Count;
    }

    /// <summary>候选速度在 onset 上的网格命中率（每拍平均 onset 强度，取 4 个相位里最好的）。</summary>
    private static double GridScore(float[] onset, double fps, double bpm)
    {
        if (bpm <= 0)
        {
            return 0;
        }

        var interval = 60.0 * fps / bpm;
        if (interval < 2)
        {
            return 0;
        }

        var best = 0.0;
        for (var step = 0; step < 4; step++)
        {
            var phase = interval * step / 4.0;
            var sum = 0.0;
            var count = 0;
            for (var position = phase; position < onset.Length - 1; position += interval)
            {
                sum += SampleOnset(onset, position);
                count++;
            }

            if (count >= 8)
            {
                var score = sum / count;
                if (score > best)
                {
                    best = score;
                }
            }
        }

        return best;
    }

    /// <summary>低置信时在倍速 / 三连音候选里挑网格解释力明显更强的速度。</summary>
    private static double RefineWithGridEvidence(double bpm, float[] onset, double fps)
    {
        var best = bpm;
        var bestScore = GridScore(onset, fps, bpm) * PreferenceWeight(bpm);
        foreach (var candidate in new[] { bpm * 2.0, bpm * 0.5, bpm * 2.0 / 3.0, bpm * 1.5 })
        {
            if (candidate < MinBpm || candidate > MaxBpm)
            {
                continue;
            }

            var score = GridScore(onset, fps, candidate) * PreferenceWeight(candidate);
            if (score > bestScore * 1.06)
            {
                best = candidate;
                bestScore = score;
            }
        }

        return best;
    }

    /// <summary>按聚合梳状谱把 b/2、b、2b 里解释能量更高的候选挑出来（保留 5% 偏好余量）。</summary>
    private static double FoldOctaves(double bpm, double[] aggregate, double fps)
    {
        var best = bpm;
        var bestScore = ScoreAtBpm(aggregate, fps, bpm) * PreferenceWeight(bpm);
        foreach (var candidate in new[] { bpm * 0.5, bpm * 2.0 })
        {
            if (candidate < MinBpm || candidate > MaxBpm)
            {
                continue;
            }

            var score = ScoreAtBpm(aggregate, fps, candidate) * PreferenceWeight(candidate);
            if (score > bestScore * 1.05)
            {
                best = candidate;
                bestScore = score;
            }
        }

        return best;
    }

    private static double ScoreAtBpm(double[] aggregate, double fps, double bpm)
    {
        var lag = 60.0 * fps / bpm;
        if (lag >= aggregate.Length - 1)
        {
            return aggregate[^1];
        }

        return Interpolate(aggregate, lag);
    }

    /// <summary>
    /// 倍速消歧（p0-12）：
    /// 1) 高速候选（&gt;195）检查隔拍能量——EDM 的八分踩镲会让梳状谱锁到 2×，若奇偶拍能量差
    ///    很大，说明真实拍是它的一半；
    /// 2) 低速候选（&lt;125）检查半拍位置是否还有底鼓/军鼓——有则说明网格漏掉了隔拍，速度应加倍。
    /// </summary>
    private static double CorrectOctaveWithBandEvidence(double bpm, float[] tempoOnset, float[] lowOnset, double fps)
    {
        if (bpm > 195.0 && bpm * 0.5 >= MinBpm)
        {
            if (BeatAlternation(tempoOnset, bpm, fps) < 0.55)
            {
                bpm *= 0.5;
            }
        }

        if (bpm < 125.0 && bpm * 2.0 <= MaxBpm)
        {
            var midpoint = MidpointRatio(tempoOnset, bpm, fps);
            var lowMidpoint = MidpointRatio(lowOnset, bpm, fps);
            if (midpoint >= 0.78 && lowMidpoint >= 0.55)
            {
                bpm *= 2.0;
            }
        }

        return bpm;
    }

    /// <summary>奇偶拍的能量比（1 = 两拍同等强；越小说明一强一弱，候选速度其实是真实拍的两倍）。</summary>
    private static double BeatAlternation(float[] onset, double bpm, double fps)
    {
        var period = 60.0 * fps / bpm;
        var phase = BestGridPhase(onset, period);
        var even = 0.0;
        var odd = 0.0;
        var evenCount = 0;
        var oddCount = 0;
        var index = 0;
        for (var position = phase; position < onset.Length - 1; position += period)
        {
            var value = SampleOnset(onset, position);
            if ((index++ & 1) == 0)
            {
                even += value;
                evenCount++;
            }
            else
            {
                odd += value;
                oddCount++;
            }
        }

        if (evenCount == 0 || oddCount == 0)
        {
            return 1.0;
        }

        var maximum = Math.Max(even / evenCount, odd / oddCount);
        var minimum = Math.Min(even / evenCount, odd / oddCount);
        return maximum <= 1e-9 ? 1.0 : minimum / maximum;
    }

    /// <summary>半拍位置的 onset 能量 / 拍点位置能量；接近 1 说明这个候选漏掉了隔拍。</summary>
    private static double MidpointRatio(float[] onset, double bpm, double fps)
    {
        var period = 60.0 * fps / bpm;
        var phase = BestGridPhase(onset, period);
        var onBeat = 0.0;
        var onCount = 0;
        var midpoint = 0.0;
        var midpointCount = 0;
        for (var position = phase; position < onset.Length - 1; position += period)
        {
            onBeat += SampleOnset(onset, position);
            onCount++;
        }

        for (var position = phase + period / 2.0; position < onset.Length - 1; position += period)
        {
            midpoint += SampleOnset(onset, position);
            midpointCount++;
        }

        if (onCount == 0 || midpointCount == 0 || onBeat <= 1e-9)
        {
            return 0;
        }

        return (midpoint / midpointCount) / (onBeat / onCount);
    }

    /// <summary>在 [0, period) 内找让拍点位置平均 onset 最大的相位。</summary>
    private static double BestGridPhase(float[] onset, double period)
    {
        var bestPhase = 0.0;
        var bestScore = -1.0;
        var step = Math.Max(0.25, period / 24.0);
        for (var phase = 0.0; phase < period; phase += step)
        {
            var sum = 0.0;
            var count = 0;
            for (var position = phase; position < onset.Length - 1; position += period)
            {
                sum += SampleOnset(onset, position);
                count++;
            }

            if (count == 0)
            {
                continue;
            }

            var score = sum / count;
            if (score > bestScore)
            {
                bestScore = score;
                bestPhase = phase;
            }
        }

        return bestPhase;
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

    /// <summary>用 DP 拍点取低频/中频重音：中频参与拍号判断，低频决定小节相位。</summary>
    private static (int Meter, int Phase, double Confidence) DetectMeter(
        IReadOnlyList<double> beats,
        float[] lowEnergy,
        float[] midEnergy,
        int frameCount,
        double fps)
    {
        if (beats.Count < 10)
        {
            return (4, 0, 0.2);
        }

        var lowAccents = new double[beats.Count];
        var combinedAccents = new double[beats.Count];
        for (var beat = 0; beat < beats.Count; beat++)
        {
            var frame = (int)Math.Round(beats[beat] / 1000.0 * fps);
            var low = AverageAt(lowEnergy, frameCount, frame, 1);
            var mid = AverageAt(midEnergy, frameCount, frame, 1);
            lowAccents[beat] = low;
            // 拍号看「底鼓 + 军鼓」的整体重音，否则只有底鼓的段落会退化成随机拍号。
            combinedAccents[beat] = low + 0.5 * mid;
        }

        var (meter, _, confidence) = DetectMeterFromAccents(combinedAccents);
        var phase = PickDownbeatPhase(lowAccents, meter);
        return (meter, phase, confidence);
    }

    /// <summary>常数间隔网格（DP 拍点不足时的兜底），行为与 p0-11 一致。</summary>
    private static (int Meter, int Phase, double Confidence) DetectMeterConstant(
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

        return DetectMeterFromAccents(accents);
    }

    /// <summary>
    /// 从每拍重音里挑 4/3 拍：4/4 是绝对主流，3 拍只有在解释力明显更好时才采用；
    /// 相位另由 <see cref="PickDownbeatPhase"/> 用低频（底鼓）决定。
    /// </summary>
    private static (int Meter, int Phase, double Confidence) DetectMeterFromAccents(double[] accents)
    {
        var (phase4, contrast4) = ContrastForMeter(accents, 4);
        var (phase3, contrast3) = ContrastForMeter(accents, 3);
        if (double.IsNegativeInfinity(contrast4) && double.IsNegativeInfinity(contrast3))
        {
            return (4, 0, 0.2);
        }

        if (contrast3 > contrast4 + 0.12)
        {
            return (3, phase3, Math.Clamp(contrast3, 0, 1));
        }

        return (4, phase4, Math.Clamp(contrast4, 0, 1));
    }

    /// <summary>某个拍号下「强拍重音均值 - 其余拍重音均值」的归一化对比度，并给出相位。</summary>
    private static (int Phase, double Contrast) ContrastForMeter(double[] accents, int meter)
    {
        var beatCount = accents.Length;
        if (beatCount < meter * 2 + 2)
        {
            return (0, double.NegativeInfinity);
        }

        var overall = accents.Average();
        var bestPhase = 0;
        var bestContrast = double.NegativeInfinity;
        for (var phase = 0; phase < meter; phase++)
        {
            var downSum = 0.0;
            var downCount = 0;
            var otherSum = 0.0;
            var otherCount = 0;
            for (var beat = 0; beat < beatCount; beat++)
            {
                if ((beat - phase) % meter == 0)
                {
                    downSum += accents[beat];
                    downCount++;
                }
                else
                {
                    otherSum += accents[beat];
                    otherCount++;
                }
            }

            if (downCount == 0 || otherCount == 0)
            {
                continue;
            }

            var contrast = (downSum / downCount - otherSum / otherCount) / (overall + 1e-9);
            if (contrast > bestContrast)
            {
                bestContrast = contrast;
                bestPhase = phase;
            }
        }

        return (bestPhase, bestContrast);
    }

    /// <summary>底鼓（低频重音）最强的那一拍是小节第一拍；重音几乎持平（如四踩）时视为第 0 拍。</summary>
    private static int PickDownbeatPhase(double[] lowAccents, int meter)
    {
        if (meter <= 0 || lowAccents.Length < meter * 2)
        {
            return 0;
        }

        var mean = lowAccents.Average();
        var spread = lowAccents.Max() - lowAccents.Min();
        // 四踩底鼓 / 纯 click 这类没有低频重音差的素材，相位不可辨，默认落在第 0 拍。
        if (mean <= 1e-6 || spread <= 0.08 * mean)
        {
            return 0;
        }

        var bestPhase = 0;
        var bestScore = double.NegativeInfinity;
        for (var phase = 0; phase < meter; phase++)
        {
            var sum = 0.0;
            var count = 0;
            for (var beat = phase; beat < lowAccents.Length; beat += meter)
            {
                sum += lowAccents[beat];
                count++;
            }

            if (count == 0)
            {
                continue;
            }

            var score = sum / count;
            if (score > bestScore)
            {
                bestScore = score;
                bestPhase = phase;
            }
        }

        // 强拍重音至少要高出平均 12% 才有资格当小节第一拍：四踩底鼓、clap 漏低频这类
        // 轻微差异不该把相位推到第 1/2 拍，否则小节线整体错位。
        if (!double.IsNegativeInfinity(bestScore) && bestScore < mean * 1.12)
        {
            return 0;
        }

        return bestPhase;
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

    /// <summary>
    /// p0-12 拍点跟踪：Ellis 式动态规划给出拍点网格，并用网格自身的中位拍间隔测漂移。
    /// DP 只在有能量的区域跟踪，首尾静音段由 <see cref="ExtendBeats"/> 按中位间隔补齐。
    /// </summary>
    private static List<double> TrackBeats(float[] onset, double intervalFrames, double fps, double durationMs, out double stability)
    {
        stability = 0;
        var beats = RunBeatDp(onset, intervalFrames, fps);
        if (beats.Count < 8)
        {
            return beats;
        }

        var median = MedianInterval(beats);
        if (median > 0)
        {
            // ACF 的峰值偏差会累计成整曲漂移：中位间隔差 1% 以上就按它再跟踪一次。
            if (Math.Abs(median * fps / 1000.0 - intervalFrames) / intervalFrames > 0.01)
            {
                var retry = RunBeatDp(onset, median * fps / 1000.0, fps);
                if (retry.Count >= beats.Count / 2)
                {
                    beats = retry;
                    median = MedianInterval(beats);
                }
            }

            if (median > 0)
            {
                var deviation = IntervalDeviation(beats, median);
                stability = Math.Clamp(1.0 - deviation / 0.08, 0, 1);
            }
        }

        return ExtendBeats(beats, fps, durationMs);
    }

    /// <summary>Ellis 式动态规划拍点跟踪（原 TrackBeats 主体，抽出来便于用不同间隔重跑）。</summary>
    private static List<double> RunBeatDp(float[] onset, double intervalFrames, double fps)
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

        if (maximum <= 0 || intervalFrames < 2)
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
        return frames.Select(frame => frame * 1000.0 / fps).ToList();
    }

    /// <summary>把拍点按中位间隔补到 0 与歌曲结尾，避免长前奏/尾奏没有拍点。</summary>
    private static List<double> ExtendBeats(List<double> beats, double fps, double durationMs)
    {
        if (beats.Count < 2)
        {
            return beats;
        }

        var median = MedianInterval(beats);
        if (median <= 0)
        {
            return beats;
        }

        var times = new List<double>(beats);
        var first = times[0];
        var guard = 0;
        while (first - median >= median * 0.25 && guard++ < 6000)
        {
            first -= median;
            times.Insert(0, Math.Max(0, first));
        }

        var last = times[^1];
        guard = 0;
        while (last + median <= durationMs - median * 0.25 && guard++ < 6000)
        {
            last += median;
            times.Add(last);
        }

        // 去掉越界/重复项（DP 偶尔会在同一拍附近给两个点）。
        var cleaned = new List<double>(times.Count);
        foreach (var time in times)
        {
            if (time < 0 || time > durationMs)
            {
                continue;
            }

            if (cleaned.Count > 0 && time - cleaned[^1] < median * 0.25)
            {
                continue;
            }

            cleaned.Add(Math.Round(time, 1));
        }

        return cleaned;
    }

    /// <summary>按拍点和小节相位直接取强拍位置（p0-12 主路径）。</summary>
    private static double[] BuildDownbeatsFromBeats(IReadOnlyList<double> beats, int meter, int phase, out int barCount)
    {
        meter = meter <= 0 ? 4 : meter;
        var result = new List<double>();
        for (var beat = ((phase % meter) + meter) % meter; beat < beats.Count; beat += meter)
        {
            result.Add(Math.Round(beats[beat], 1));
            if (result.Count >= MaxDownbeats)
            {
                break;
            }
        }

        barCount = result.Count;
        return result.ToArray();
    }

    /// <summary>常数间隔拍点（兜底路径），最多 4000 个。</summary>
    private static double[] BuildConstantBeatTimes(double firstBeatMs, double beatIntervalMs, double durationMs)
    {
        var count = (int)Math.Floor((durationMs - firstBeatMs) / beatIntervalMs) + 1;
        if (count < 1)
        {
            count = 1;
        }

        if (count > 4000)
        {
            count = 4000;
        }

        var beats = new double[count];
        for (var i = 0; i < count; i++)
        {
            beats[i] = Math.Round(firstBeatMs + i * beatIntervalMs, 1);
        }

        return beats;
    }

    /// <summary>拍点序列对拍号索引做最小二乘拟合，返回 BPM（ms/拍 的倒数）；漂移曲目会偏高/偏低由 stability 标示。</summary>
    private static double BeatSlopeBpm(List<double> beats)
    {
        var count = beats.Count;
        if (count < 2 || beats[^1] <= beats[0])
        {
            return 0;
        }

        var meanIndex = (count - 1) / 2.0;
        var meanTime = 0.0;
        foreach (var beat in beats)
        {
            meanTime += beat;
        }

        meanTime /= count;
        var numerator = 0.0;
        var denominator = 0.0;
        for (var i = 0; i < count; i++)
        {
            var dx = i - meanIndex;
            numerator += dx * (beats[i] - meanTime);
            denominator += dx * dx;
        }

        if (denominator <= 0)
        {
            return 0;
        }

        var slopeMs = numerator / denominator;
        return slopeMs > 0 ? 60000.0 / slopeMs : 0;
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
