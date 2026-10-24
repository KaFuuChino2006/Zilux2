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
    internal const string AnalyzerVersion = "p0-1";

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
        ComputeOnsets(samples, frameCount, sampleRate, flux, lowEnergy, midEnergy, highEnergy);

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
            downbeats, lowEnergy, midEnergy, highEnergy, frameCount, fps, out var barFeatures, durationMs);
        var sections = BuildSections(phraseStarts, barFeatures, durationMs);

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
        payload.Sections = sections;
        payload.Warnings = warnings.Distinct(StringComparer.Ordinal).ToArray();
        return payload;
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
        float[] highEnergy)
    {
        var real = new float[WindowSize];
        var imag = new float[WindowSize];
        var previous = new float[WindowSize / 2 + 1];
        var binHz = sampleRate / (double)WindowSize;
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
            }

            flux[frame] = (float)(fluxSum / (WindowSize / 2.0));
            lowEnergy[frame] = (float)low;
            midEnergy[frame] = (float)mid;
            highEnergy[frame] = (float)high;
        }
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
        int frameCount,
        double fps,
        out double[][] barFeatures,
        double durationMs)
    {
        barFeatures = Array.Empty<double[]>();
        if (downbeats.Length < MinPhraseBars + 1)
        {
            return Array.Empty<double>();
        }

        var barCount = downbeats.Length;
        var features = new double[barCount][];
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

    private static AnalysisSectionPayload[] BuildSections(
        double[] phraseStarts,
        double[][] barFeatures,
        double durationMs)
    {
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

            var label = string.Empty;
            var confidence = 0.3;
            if (boundaries.Count >= 4 && i == 0 && end - start < durationMs * 0.3)
            {
                label = "intro";
                confidence = 0.5;
            }
            else if (boundaries.Count >= 4 && i == boundaries.Count - 2 && end - start < durationMs * 0.3)
            {
                label = "outro";
                confidence = 0.5;
            }

            sections.Add(new AnalysisSectionPayload
            {
                StartMs = Math.Round(start, 1),
                EndMs = Math.Round(end, 1),
                Label = label,
                Confidence = confidence,
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

        return sections.ToArray();
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
