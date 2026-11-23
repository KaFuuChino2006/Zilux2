// style stage：整曲流式解码 → 30 s 窗 50% 重叠 → 500 ms 网格 DSP（centroid/flatness/highRatio/percussivity/tonalness）。
using System.Diagnostics;
using System.IO;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace Zilux2.Analysis;

/// <summary>
/// 纯 DSP 风格特征。不加载任何模型：3 秒内要能算完一首本地曲（契约 §8）。
///
/// 时间轴：帧 = 500 ms，帧 i 覆盖 [i*500ms, (i+1)*500ms)。
/// 30 s 窗以 15 s 步进滚动，重叠区的帧会被算两次，累加后取均值 —— 帧特征本身只依赖
/// 本帧 + 前一子帧（64 帧前的 1/8 秒），所以两次结果一致，均值不会引入偏差。
/// </summary>
internal static class StyleStage
{
    internal const string StageName = "style";
    internal const string StageVersion = "style/dsp-v1";

    private const int SampleRate = 44_100;
    private const int HopMs = 500;
    private const int FrameSamples = SampleRate * HopMs / 1000; // 22 050
    private const int WindowSamples = SampleRate * 30;          // 30 s
    private const int WindowHopSamples = WindowSamples / 2;     // 50% 重叠

    private const int SubFrameCount = 4;
    private const int SubFrameSamples = FrameSamples / SubFrameCount; // 5 512
    private const int FftSize = 2048;
    private const int FftBins = FftSize / 2 + 1;                      // 1 025

    /// <summary>起音检测的 RMS 环形窗口：16 个子帧 ≈ 2 s。</summary>
    private const int RmsRingSize = 16;

    private const double SilenceDb = -50;
    private const double Epsilon = 1e-12;

    private static readonly double BinHz = (double)SampleRate / FftSize;
    private static readonly int HighRatioBin = (int)(8000 / BinHz);
    private static readonly int LowBinMax = (int)(250 / BinHz);
    private static readonly int MidBinMax = (int)(2000 / BinHz);

    /// <summary>整曲分析入口；失败返回 null（契约 §2）。</summary>
    internal static StyleProfilePayload? Analyze(string audioPath, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(audioPath) || !File.Exists(audioPath))
        {
            HostLog.Warn($"style.skip: file missing {audioPath}");
            return null;
        }

        var watch = Stopwatch.StartNew();
        try
        {
            var payload = AnalyzeCore(audioPath, ct);
            if (payload is null)
            {
                HostLog.Warn($"style.empty file={Path.GetFileName(audioPath)}");
                return null;
            }

            HostLog.Info(
                $"style.done file={Path.GetFileName(audioPath)} frames={payload.CentroidHz.Length} " +
                $"dr={payload.DynamicRangeLu:F1} silence={payload.SilenceRatio:F2} elapsedMs={watch.ElapsedMilliseconds}");
            return payload;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            HostLog.Error($"style.failed file={Path.GetFileName(audioPath)}", exception);
            return null;
        }
    }

    private static StyleProfilePayload? AnalyzeCore(string audioPath, CancellationToken ct)
    {
        using var reader = new MonoReader(audioPath);
        HostLog.Info($"style.source file={Path.GetFileName(audioPath)} totalMs={(long)reader.TotalTime.TotalMilliseconds}");
        var grid = new FrameGrid();

        var window = new float[WindowSamples];
        var chunk = new float[16 * 1024];
        var fill = 0;
        long windowStart = 0;

        while (true)
        {
            ct.ThrowIfCancellationRequested();
            var read = reader.Read(chunk, 0, chunk.Length);
            if (read <= 0)
            {
                break;
            }

            var offset = 0;
            while (offset < read)
            {
                var take = Math.Min(WindowSamples - fill, read - offset);
                Array.Copy(chunk, offset, window, fill, take);
                fill += take;
                offset += take;
                if (fill < WindowSamples)
                {
                    continue;
                }

                ProcessWindow(window, WindowSamples, windowStart, 0, WindowSamples, grid, ct);
                Array.Copy(window, WindowHopSamples, window, 0, WindowSamples - WindowHopSamples);
                fill = WindowSamples - WindowHopSamples;
                windowStart += WindowHopSamples;
            }
        }

        if (fill > 0)
        {
            // 尾巴窗：前 15 s 与上一窗重叠，只补新区；整曲短于 15 s 时全发。
            var emitFrom = windowStart == 0 ? 0 : WindowHopSamples;
            if (fill <= emitFrom)
            {
                emitFrom = 0;
            }

            ProcessWindow(window, fill, windowStart, emitFrom, fill, grid, ct);
        }

        return grid.Build();
    }

    private static void ProcessWindow(
        float[] buffer,
        int length,
        long windowStart,
        int emitFrom,
        int emitTo,
        FrameGrid grid,
        CancellationToken ct)
    {
        if (length < FftSize)
        {
            return;
        }

        var re = new float[FftSize];
        var im = new float[FftSize];
        var magnitude = new float[FftBins];
        var spectrum = new float[FftBins];
        var acRe = new float[FftSize];
        var acIm = new float[FftSize];

        // 起音检测：16 个子帧（约 2 s）的 RMS 中位数作为本底，中位数不怕打击本身把阈值抬高。
        var rmsRing = new double[RmsRingSize];
        var rmsRingCount = 0;

        for (var frameStart = emitFrom; frameStart < emitTo; frameStart += FrameSamples)
        {
            ct.ThrowIfCancellationRequested();

            var available = Math.Min(FrameSamples, length - frameStart);
            if (available < SubFrameSamples)
            {
                break;
            }

            Array.Clear(spectrum);
            double low = 0, mid = 0, high = 0;

            for (var sub = 0; sub < SubFrameCount; sub++)
            {
                var start = frameStart + sub * SubFrameSamples;
                var subLength = Math.Min(SubFrameSamples + FftSize, length - start);
                if (subLength <= 0)
                {
                    break;
                }

                ComputeMagnitude(buffer, start, subLength, re, im, magnitude);

                // 子帧 RMS 相对近 2 s 中位数的跳变记为一次起音（打击/拨弦/鼓点都会抬 RMS）。
                var subAvailable = Math.Min(SubFrameSamples, length - start);
                var subSum = 0.0;
                for (var i = 0; i < subAvailable; i++)
                {
                    var sample = buffer[start + i];
                    subSum += (double)sample * sample;
                }

                var subRms = subAvailable > 0 ? Math.Sqrt(subSum / subAvailable) : 0;
                rmsRing[rmsRingCount % RmsRingSize] = subRms;
                rmsRingCount++;

                for (var bin = 0; bin < FftBins; bin++)
                {
                    var power = magnitude[bin] * magnitude[bin];
                    spectrum[bin] += power;
                    if (bin >= 1 && bin <= LowBinMax)
                    {
                        low += power;
                    }
                    else if (bin > LowBinMax && bin <= MidBinMax)
                    {
                        mid += power;
                    }
                    else if (bin > MidBinMax)
                    {
                        high += power;
                    }
                }
            }

            double sumSquares = 0;
            for (var i = 0; i < available; i++)
            {
                var sample = buffer[frameStart + i];
                sumSquares += (double)sample * sample;
            }

            var rms = Math.Sqrt(sumSquares / available);

            // 脉动度：窗口内 RMS 起伏 mean|Δrms|/mean(rms)，尺度无关，密集打击同样有效。
            var pulse = RingPulse(rmsRing, rmsRingCount);
            var metrics = BuildMetrics(spectrum, acRe, acIm, pulse, rms, low, mid, high);
            grid.Add((windowStart + frameStart) / FrameSamples, metrics);
        }
    }

    private static FrameMetrics BuildMetrics(
        float[] spectrum,
        float[] acRe,
        float[] acIm,
        double pulse,
        double rms,
        double low,
        double mid,
        double high)
    {
        double powerSum = 0;
        double weighted = 0;
        double logSum = 0;
        double highPower = 0;
        var logBins = 0;

        for (var bin = 1; bin < FftBins; bin++)
        {
            var power = spectrum[bin];
            powerSum += power;
            weighted += power * bin * BinHz;
            logSum += Math.Log(power + Epsilon);
            logBins++;
            if (bin >= HighRatioBin)
            {
                highPower += power;
            }
        }

        var centroid = powerSum > Epsilon ? weighted / powerSum : 0;
        var flatness = 0.0;
        if (powerSum > Epsilon && logBins > 0)
        {
            var geometric = Math.Exp(logSum / logBins);
            var arithmetic = powerSum / logBins;
            // 平坦度的常用定义建在**幅度**谱上（geo/arith）。这里累加的是功率，
            // 直接相除等于把标准值平方（0.2 → 0.04），失真/噪声类阈值会永远够不到。
            flatness = arithmetic > Epsilon ? Math.Sqrt(geometric / arithmetic) : 0;
        }

        var highRatio = powerSum > Epsilon ? highPower / powerSum : 0;

        // 归一化自相关峰 → 谐波性。
        var tonalness = 0.0;
        Array.Clear(acRe);
        Array.Clear(acIm);
        acRe[0] = spectrum[0];
        for (var bin = 1; bin < FftBins; bin++)
        {
            acRe[bin] = spectrum[bin];
            acIm[bin] = 0;
            if (bin < FftBins - 1)
            {
                acRe[FftSize - bin] = spectrum[bin];
            }
        }

        Fft2048.Inverse(acRe, acIm);
        var r0 = acRe[0];
        if (r0 > Epsilon)
        {
            var minLag = Math.Max(2, (int)(SampleRate / 1200.0));
            var maxLag = Math.Min(FftSize / 2, (int)(SampleRate / 55.0));
            var peak = 0.0;
            for (var lag = minLag; lag <= maxLag; lag++)
            {
                var value = acRe[lag] / r0;
                if (value > peak)
                {
                    peak = value;
                }
            }

            tonalness = Clamp01((peak - 0.2) / 0.6);
        }

        // 标定：drums≈1.06、真实 EDM≈0.28、轻击≈0.05、平滑≈0.01；0.02 起、0.42 饱和。
        var percussivity = Clamp01((pulse - 0.02) / 0.40);
        return new FrameMetrics(centroid, Clamp01(flatness), Clamp01(highRatio), percussivity, tonalness, rms, low, mid, high);
    }

    private static void ComputeMagnitude(
        float[] buffer,
        int start,
        int available,
        float[] re,
        float[] im,
        float[] magnitude)
    {
        Array.Clear(re);
        Array.Clear(im);
        var count = Math.Min(FftSize, available);
        for (var i = 0; i < count; i++)
        {
            re[i] = buffer[start + i] * Hann[i];
        }

        Fft2048.Forward(re, im);
        for (var bin = 0; bin < FftBins; bin++)
        {
            magnitude[bin] = MathF.Sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
        }
    }

    private static double Clamp01(double value) => value < 0 ? 0 : value > 1 ? 1 : value;

    private static double RingPulse(double[] ring, int count)
    {
        var span = Math.Min(count, RmsRingSize);
        if (span < 2)
        {
            return 0;
        }

        var start = count - span;
        double sum = 0;
        double delta = 0;
        var previous = ring[start % RmsRingSize];
        for (var k = start; k < count; k++)
        {
            var value = ring[k % RmsRingSize];
            sum += value;
            if (k > start)
            {
                delta += Math.Abs(value - previous);
            }

            previous = value;
        }

        return sum > Epsilon ? delta / sum : 0;
    }

    private static readonly float[] Hann = BuildHann();

    private static float[] BuildHann()
    {
        var window = new float[FftSize];
        for (var i = 0; i < FftSize; i++)
        {
            window[i] = (float)(0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (FftSize - 1)));
        }

        return window;
    }

    private readonly record struct FrameMetrics(
        double Centroid,
        double Flatness,
        double HighRatio,
        double Percussivity,
        double Tonalness,
        double Rms,
        double Low,
        double Mid,
        double High);

    /// <summary>全局 500 ms 网格；重叠窗重复写同一格时累加后取均值。</summary>
    private sealed class FrameGrid
    {
        private readonly List<double> _centroid = [];
        private readonly List<double> _flatness = [];
        private readonly List<double> _highRatio = [];
        private readonly List<double> _percussivity = [];
        private readonly List<double> _tonalness = [];
        private readonly List<double> _rms = [];
        private readonly List<double> _low = [];
        private readonly List<double> _mid = [];
        private readonly List<double> _high = [];
        private readonly List<int> _count = [];

        internal void Add(long index, in FrameMetrics metrics)
        {
            if (index < 0 || index > int.MaxValue)
            {
                return;
            }

            var slot = (int)index;
            while (_count.Count <= slot)
            {
                _centroid.Add(0);
                _flatness.Add(0);
                _highRatio.Add(0);
                _percussivity.Add(0);
                _tonalness.Add(0);
                _rms.Add(0);
                _low.Add(0);
                _mid.Add(0);
                _high.Add(0);
                _count.Add(0);
            }

            _centroid[slot] += metrics.Centroid;
            _flatness[slot] += metrics.Flatness;
            _highRatio[slot] += metrics.HighRatio;
            _percussivity[slot] += metrics.Percussivity;
            _tonalness[slot] += metrics.Tonalness;
            _rms[slot] += metrics.Rms;
            _low[slot] += metrics.Low;
            _mid[slot] += metrics.Mid;
            _high[slot] += metrics.High;
            _count[slot]++;
        }

        internal StyleProfilePayload? Build()
        {
            var length = _count.Count;
            if (length == 0)
            {
                return null;
            }

            var centroid = new double[length];
            var flatness = new double[length];
            var highRatio = new double[length];
            var percussivity = new double[length];
            var tonalness = new double[length];
            var rms = new double[length];
            double lowSum = 0, midSum = 0, highSum = 0;
            var filled = 0;

            for (var i = 0; i < length; i++)
            {
                var count = _count[i];
                if (count > 0)
                {
                    centroid[i] = _centroid[i] / count;
                    flatness[i] = _flatness[i] / count;
                    highRatio[i] = _highRatio[i] / count;
                    percussivity[i] = _percussivity[i] / count;
                    tonalness[i] = _tonalness[i] / count;
                    rms[i] = _rms[i] / count;
                    lowSum += _low[i] / count;
                    midSum += _mid[i] / count;
                    highSum += _high[i] / count;
                    filled++;
                }
                else if (i > 0)
                {
                    // 理论上不该有空洞；有的话沿用前一帧，保证数组与时间轴对齐。
                    centroid[i] = centroid[i - 1];
                    flatness[i] = flatness[i - 1];
                    highRatio[i] = highRatio[i - 1];
                    percussivity[i] = percussivity[i - 1];
                    tonalness[i] = tonalness[i - 1];
                    rms[i] = rms[i - 1];
                }
            }

            if (filled == 0)
            {
                return null;
            }

            var levelDb = new double[length];
            var silent = 0;
            for (var i = 0; i < length; i++)
            {
                levelDb[i] = 20 * Math.Log10(Math.Max(rms[i], 1e-6));
                if (levelDb[i] < SilenceDb)
                {
                    silent++;
                }
            }

            var sorted = (double[])levelDb.Clone();
            Array.Sort(sorted);
            var dynamicRange = Percentile(sorted, 0.95) - Percentile(sorted, 0.10);

            var bandTotal = lowSum + midSum + highSum;
            return new StyleProfilePayload
            {
                V = 1,
                Source = "dsp",
                Method = "band-stats-v1",
                HopMs = HopMs,
                CentroidHz = centroid,
                Flatness = flatness,
                HighRatio = highRatio,
                Percussivity = percussivity,
                Tonalness = tonalness,
                DynamicRangeLu = dynamicRange,
                SilenceRatio = (double)silent / length,
                LowEnergyRatio = bandTotal > Epsilon ? lowSum / bandTotal : 0,
                MidEnergyRatio = bandTotal > Epsilon ? midSum / bandTotal : 0,
                HighEnergyRatio = bandTotal > Epsilon ? highSum / bandTotal : 0,
            };
        }

        private static double Percentile(double[] sorted, double percentile)
        {
            if (sorted.Length == 0)
            {
                return 0;
            }

            var position = (sorted.Length - 1) * percentile;
            var low = (int)Math.Floor(position);
            var high = (int)Math.Ceiling(position);
            if (low == high)
            {
                return sorted[low];
            }

            return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
        }
    }

    /// <summary>2048 点基 2 实数 FFT（Hann 窗输入，复数输出）。</summary>
    private static class Fft2048
    {
        private const int Size = 2048;
        private static readonly int[] Reverse = BuildReverse();
        private static readonly float[] Cos = BuildCos();
        private static readonly float[] Sin = BuildSin();

        internal static void Forward(float[] re, float[] im)
        {
            for (var i = 0; i < Size; i++)
            {
                var j = Reverse[i];
                if (i >= j)
                {
                    continue;
                }

                (re[i], re[j]) = (re[j], re[i]);
                (im[i], im[j]) = (im[j], im[i]);
            }

            for (var length = 2; length <= Size; length <<= 1)
            {
                var half = length >> 1;
                var step = Size / length;
                for (var i = 0; i < Size; i += length)
                {
                    for (var j = 0; j < half; j++)
                    {
                        var k = j * step;
                        var wr = Cos[k];
                        var wi = Sin[k];
                        var u = i + j;
                        var v = u + half;
                        var tr = re[v] * wr - im[v] * wi;
                        var ti = re[v] * wi + im[v] * wr;
                        re[v] = re[u] - tr;
                        im[v] = im[u] - ti;
                        re[u] += tr;
                        im[u] += ti;
                    }
                }
            }
        }

        internal static void Inverse(float[] re, float[] im)
        {
            for (var i = 0; i < Size; i++)
            {
                im[i] = -im[i];
            }

            Forward(re, im);
            var scale = 1f / Size;
            for (var i = 0; i < Size; i++)
            {
                re[i] *= scale;
                im[i] *= -scale;
            }
        }

        private static int[] BuildReverse()
        {
            const int bits = 11;
            var reverse = new int[Size];
            for (var i = 0; i < Size; i++)
            {
                var value = 0;
                for (var bit = 0; bit < bits; bit++)
                {
                    if ((i & (1 << bit)) != 0)
                    {
                        value |= 1 << (bits - 1 - bit);
                    }
                }

                reverse[i] = value;
            }

            return reverse;
        }

        private static float[] BuildCos()
        {
            var table = new float[Size / 2];
            for (var i = 0; i < table.Length; i++)
            {
                table[i] = (float)Math.Cos(2 * Math.PI * i / Size);
            }

            return table;
        }

        private static float[] BuildSin()
        {
            var table = new float[Size / 2];
            for (var i = 0; i < table.Length; i++)
            {
                table[i] = (float)-Math.Sin(2 * Math.PI * i / Size);
            }

            return table;
        }
    }

    /// <summary>整曲流式单声道读取（44.1 kHz float），不依赖 StemSeparationService 的 30 s 固定网格。</summary>
    private sealed class MonoReader : IDisposable
    {
        private readonly MediaFoundationReader _reader;
        private readonly ISampleProvider _provider;

        internal MonoReader(string path)
        {
            _reader = new MediaFoundationReader(path);
            try
            {
                var source = _reader.ToSampleProvider();
                ISampleProvider mono = new MonoDownmix(source);
                _provider = mono.WaveFormat.SampleRate == SampleRate
                    ? mono
                    : new WdlResamplingSampleProvider(mono, SampleRate);
            }
            catch
            {
                _reader.Dispose();
                throw;
            }
        }

        internal TimeSpan TotalTime => _reader.TotalTime;

        internal int Read(float[] buffer, int offset, int count) => _provider.Read(buffer.AsSpan(offset, count));

        public void Dispose() => _reader.Dispose();
    }

    /// <summary>多声道下混成单声道：立体声取均值，≥3 声道按 FL/FR/FC/环绕加权、丢 LFE。</summary>
    private sealed class MonoDownmix : ISampleProvider
    {
        private readonly ISampleProvider _source;
        private readonly int _channels;
        private readonly float _weightSum;
        private float[] _buffer = [];

        internal MonoDownmix(ISampleProvider source)
        {
            _source = source;
            _channels = source.WaveFormat.Channels;
            WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(source.WaveFormat.SampleRate, 1);

            var sum = 0f;
            for (var channel = 0; channel < _channels; channel++)
            {
                sum += Weight(channel);
            }

            _weightSum = sum > 0 ? sum : 1;
        }

        public WaveFormat WaveFormat { get; }

        public int Read(Span<float> buffer)
        {
            var needed = buffer.Length * _channels;
            if (_buffer.Length < needed)
            {
                _buffer = new float[needed];
            }

            var read = _source.Read(_buffer.AsSpan(0, needed));
            var frames = read / _channels;
            for (var frame = 0; frame < frames; frame++)
            {
                var baseIndex = frame * _channels;
                float value;
                if (_channels == 1)
                {
                    value = _buffer[baseIndex];
                }
                else if (_channels == 2)
                {
                    value = (_buffer[baseIndex] + _buffer[baseIndex + 1]) * 0.5f;
                }
                else
                {
                    var sum = 0f;
                    for (var channel = 0; channel < _channels; channel++)
                    {
                        sum += _buffer[baseIndex + channel] * Weight(channel);
                    }

                    value = sum / _weightSum;
                }

                buffer[frame] = value;
            }

            return frames;
        }

        private static float Weight(int channel) => channel switch
        {
            3 => 0f,      // LFE 丢弃
            _ => 1f,      // FL/FR 以及 FC/环绕统一 0 dB（风格特征不追求混音精度）
        };
    }
}
