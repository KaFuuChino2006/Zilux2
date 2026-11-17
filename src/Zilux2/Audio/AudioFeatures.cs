using System.Globalization;
using System.Text;

namespace Zilux2.Audio;

/// <summary>
/// One 30 Hz feature frame. The arrays are reused by <see cref="AudioAnalyzer"/> and only stay
/// valid until the next Analyze call, so a consumer must serialize/copy them immediately.
/// </summary>
internal sealed class AudioFrameSnapshot
{
    internal AudioFrameSnapshot(float[] bins, float[] bands, float level, float peak, bool beat, float strength, float bpm)
    {
        Bins = bins;
        Bands = bands;
        Level = level;
        Peak = peak;
        Beat = beat;
        Strength = strength;
        Bpm = bpm;
    }

    internal float[] Bins { get; }

    internal float[] Bands { get; }

    internal float Level { get; }

    internal float Peak { get; }

    internal bool Beat { get; }

    /// <summary>本次 onset 的强度（谱通量 / 自适应阈值），1 表示刚好越过阈值。</summary>
    internal float Strength { get; }

    /// <summary>由 onset 间隔推出来的 BPM；样本不足时为 0。</summary>
    internal float Bpm { get; }
}

/// <summary>
/// Turns mono PCM into the visualizer feature set: 64 log-spaced spectrum bins, 8 octave-ish
/// bands, overall RMS level, held peak and a bass energy-spike beat flag.
/// A 2048-point radix-2 FFT keeps the 60/120 Hz bands meaningful at 44.1/48 kHz; the whole
/// computation is a few hundred microseconds, so it runs on the capture thread at 30 Hz.
/// </summary>
internal sealed class AudioAnalyzer
{
    internal const int WindowSize = 2048;
    internal const int BinCount = 64;
    internal const int BandCount = 8;

    private const float MinFrequency = 40f;
    private const float MaxFrequency = 16000f;
    // 真实 onset 检测（第 20 轮 D）：谱通量 + 自适应阈值 + 最小间隔。
    // 旧实现只看低频能量突增，人声/吉他一类的起音完全漏掉，且阈值固定 0.12 在安静段落狂报。
    private const float BeatCooldownMilliseconds = 95f;
    private const float OnsetThresholdSigma = 1.6f;
    private const int FluxHistorySize = 43;          // ~1.4 s @30 Hz
    private const int BpmHistorySize = 12;

    private static readonly double[] BandEdges = { 0, 60, 120, 250, 500, 1000, 2000, 4000, 20000 };

    private readonly float[] _ring = new float[WindowSize];
    private readonly float[] _window = new float[WindowSize];
    private readonly float[] _hann = new float[WindowSize];
    private readonly float[] _real = new float[WindowSize];
    private readonly float[] _imag = new float[WindowSize];
    private readonly float[] _magnitude = new float[WindowSize / 2 + 1];
    private readonly float[] _bins = new float[BinCount];
    private readonly float[] _bands = new float[BandCount];

    private int _ringWrite;
    private int _ringCount;
    private int _pendingSamples;
    private float _level;
    private float _peak;
    private float _bassAverage;
    private bool _beat;
    private float _beatStrength;
    private float _bpm;
    private long _lastBeatTimestamp;
    private readonly float[] _prevMagnitude = new float[WindowSize / 2 + 1];
    private readonly float[] _fluxHistory = new float[FluxHistorySize];
    private int _fluxWrite;
    private int _fluxCount;
    private readonly float[] _intervalHistory = new float[BpmHistorySize];
    private int _intervalWrite;
    private int _intervalCount;

    internal AudioAnalyzer()
    {
        for (var i = 0; i < WindowSize; i++)
        {
            _hann[i] = 0.5f - 0.5f * MathF.Cos(2f * MathF.PI * i / (WindowSize - 1));
        }
    }

    internal int SampleRate { get; set; } = 48000;

    internal void Reset()
    {
        Array.Clear(_ring);
        Array.Clear(_bins);
        Array.Clear(_bands);
        _ringWrite = 0;
        _ringCount = 0;
        _pendingSamples = 0;
        _level = 0f;
        _peak = 0f;
        _bassAverage = 0f;
        _beat = false;
        _beatStrength = 0f;
        _bpm = 0f;
        _lastBeatTimestamp = 0;
        Array.Clear(_prevMagnitude);
        Array.Clear(_fluxHistory);
        Array.Clear(_intervalHistory);
        _fluxWrite = 0;
        _fluxCount = 0;
        _intervalWrite = 0;
        _intervalCount = 0;
    }

    internal void Push(float[] samples, int count)
    {
        if (count <= 0)
        {
            return;
        }

        var take = Math.Min(count, _ring.Length);
        var offset = count - take;
        for (var i = 0; i < take; i++)
        {
            _ring[_ringWrite] = samples[offset + i];
            _ringWrite = (_ringWrite + 1) % _ring.Length;
        }

        _ringCount = Math.Min(_ringCount + take, _ring.Length);
        _pendingSamples = Math.Min(_pendingSamples + take, _ring.Length);
    }

    internal AudioFrameSnapshot Analyze()
    {
        if (_pendingSamples == 0)
        {
            // The render stream is idle (or the host itself is silent): decay to zero instead of
            // re-reporting the same stale window forever.
            DecaySilence();
            return Snapshot();
        }

        _pendingSamples = 0;

        if (_ringCount < WindowSize)
        {
            Array.Clear(_window, 0, WindowSize - _ringCount);
            Array.Copy(_ring, 0, _window, WindowSize - _ringCount, _ringCount);
        }
        else
        {
            var oldest = _ringWrite;
            Array.Copy(_ring, oldest, _window, 0, WindowSize - oldest);
            if (oldest > 0)
            {
                Array.Copy(_ring, 0, _window, WindowSize - oldest, oldest);
            }
        }

        var sumSquares = 0f;
        var peakAmplitude = 0f;
        for (var i = 0; i < WindowSize; i++)
        {
            var sample = _window[i];
            sumSquares += sample * sample;
            var absolute = MathF.Abs(sample);
            if (absolute > peakAmplitude)
            {
                peakAmplitude = absolute;
            }

            _real[i] = sample * _hann[i];
            _imag[i] = 0f;
        }

        Transform();

        // Hann coherent gain is 0.5, so a full-scale sine reads 4/N * |X| after correction.
        var scale = 4f / WindowSize;
        _magnitude[0] = 0f;
        for (var k = 1; k <= WindowSize / 2; k++)
        {
            _magnitude[k] = MathF.Sqrt(_real[k] * _real[k] + _imag[k] * _imag[k]) * scale;
        }

        var nyquist = SampleRate / 2.0;
        var binHz = (double)SampleRate / WindowSize;
        var maxFrequency = Math.Min(MaxFrequency, nyquist);
        var ratio = maxFrequency / MinFrequency;

        for (var i = 0; i < BinCount; i++)
        {
            var low = MinFrequency * Math.Pow(ratio, i / (double)BinCount);
            var high = MinFrequency * Math.Pow(ratio, (i + 1) / (double)BinCount);
            var next = Normalize(MaxMagnitude(low, high, binHz));
            _bins[i] += (next - _bins[i]) * (next > _bins[i] ? 0.5f : 0.18f);
        }

        for (var i = 0; i < BandCount; i++)
        {
            var next = Normalize(MaxMagnitude(BandEdges[i], BandEdges[i + 1], binHz));
            _bands[i] += (next - _bands[i]) * (next > _bands[i] ? 0.55f : 0.2f);
        }

        var rms = MathF.Sqrt(sumSquares / WindowSize);
        var levelNext = Normalize(rms);
        _level += (levelNext - _level) * (levelNext > _level ? 0.55f : 0.2f);

        var peakNext = Normalize(peakAmplitude);
        _peak = peakNext > _peak ? peakNext : _peak * 0.9f;

        // ---- 真实 onset：频谱通量 + 自适应阈值 + 最小间隔 ----
        // 通量只看「这一帧比上一帧多出来的能量」，对鼓、贝斯、人声起音、拨弦都敏感，
        // 而旧的低频阈值法只认 kick，且固定阈值在安静段落会误报。
        var flux = 0f;
        var loudest = 0f;
        for (var i = 0; i < _magnitude.Length; i++)
        {
            var delta = _magnitude[i] - _prevMagnitude[i];
            if (delta > 0f) flux += delta;
            if (_magnitude[i] > loudest) loudest = _magnitude[i];
            _prevMagnitude[i] = _magnitude[i];
        }

        // 静音段直接压住，避免把噪声底噪当成鼓点。
        if (loudest < 1e-4f) flux = 0f;

        // 阈值取最近 1.4 秒通量的自适应基线（均值 + k*标准差），这样不用手工标定音量。
        var fluxSum = 0f;
        var fluxSquares = 0f;
        for (var i = 0; i < _fluxCount; i++)
        {
            fluxSum += _fluxHistory[i];
            fluxSquares += _fluxHistory[i] * _fluxHistory[i];
        }

        var mean = _fluxCount > 0 ? fluxSum / _fluxCount : 0f;
        var variance = _fluxCount > 0 ? MathF.Max(0f, fluxSquares / _fluxCount - mean * mean) : 0f;
        var threshold = mean + OnsetThresholdSigma * MathF.Sqrt(variance);
        // 基线太低时给一个几乎为 0 的地板，避免「全静音 → 一点噪声就 triple」。
        if (threshold < 1e-3f) threshold = 1e-3f;

        _fluxHistory[_fluxWrite] = flux;
        _fluxWrite = (_fluxWrite + 1) % FluxHistorySize;
        if (_fluxCount < FluxHistorySize) _fluxCount++;

        var now = Environment.TickCount64;
        var cooled = now - _lastBeatTimestamp >= BeatCooldownMilliseconds;
        _beat = cooled && flux > threshold && _fluxCount >= 4;
        _beatStrength = threshold > 0f ? Math.Clamp(flux / threshold, 0f, 4f) / 4f : 0f;

        if (_beat)
        {
            if (_lastBeatTimestamp > 0)
            {
                var interval = now - _lastBeatTimestamp;
                // 60–200 BPM 之外的间隔（漏拍/静音后重启）不参与估计。
                if (interval is >= 300 and <= 1000)
                {
                    _intervalHistory[_intervalWrite] = interval;
                    _intervalWrite = (_intervalWrite + 1) % BpmHistorySize;
                    if (_intervalCount < BpmHistorySize) _intervalCount++;
                }
            }

            _lastBeatTimestamp = now;
            _bpm = EstimateBpm();
        }

        var bass = _bands[1] * 0.6f + _bands[2] * 0.4f;
        _bassAverage = _bassAverage * 0.97f + bass * 0.03f;
        return Snapshot();
    }

    /// <summary>用最近若干次 onset 间隔的中位数估 BPM（中位数抗漏拍/多报）。</summary>
    private float EstimateBpm()
    {
        if (_intervalCount < 3) return _bpm;

        Span<float> sorted = stackalloc float[_intervalCount];
        for (var i = 0; i < _intervalCount; i++) sorted[i] = _intervalHistory[i];
        sorted.Sort();
        var median = sorted[_intervalCount / 2];
        if (median <= 0f) return _bpm;

        var bpm = 60000f / median;
        // 落在半速/双速区间的结果收敛到 70–180 的常用范围。
        while (bpm > 180f) bpm *= 0.5f;
        while (bpm < 70f) bpm *= 2f;
        return _bpm == 0f ? bpm : _bpm * 0.7f + bpm * 0.3f;
    }

    private void DecaySilence()
    {
        for (var i = 0; i < BinCount; i++)
        {
            _bins[i] *= 0.86f;
        }

        for (var i = 0; i < BandCount; i++)
        {
            _bands[i] *= 0.85f;
        }

        _level *= 0.7f;
        _peak *= 0.9f;
        _bassAverage *= 0.97f;
        _beat = false;
        _beatStrength = 0f;
        Array.Clear(_prevMagnitude);
        Array.Clear(_fluxHistory);
        _fluxCount = 0;
        _fluxWrite = 0;
    }

    private AudioFrameSnapshot Snapshot() => new(_bins, _bands, _level, _peak, _beat, _beatStrength, _bpm);

    private float MaxMagnitude(double lowFrequency, double highFrequency, double binHz)
    {
        var first = (int)Math.Max(1, Math.Floor(lowFrequency / binHz));
        var last = (int)Math.Min(_magnitude.Length - 1, Math.Ceiling(highFrequency / binHz));
        if (last < first)
        {
            last = first;
        }

        var maximum = 0f;
        for (var k = first; k <= last; k++)
        {
            if (_magnitude[k] > maximum)
            {
                maximum = _magnitude[k];
            }
        }

        return maximum;
    }

    private static float Normalize(float amplitude)
    {
        if (amplitude <= 1e-6f)
        {
            return 0f;
        }

        var decibels = 20f * MathF.Log10(amplitude);
        return Math.Clamp((decibels + 60f) / 60f, 0f, 1f);
    }

    private void Transform()
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
                (_real[i], _real[j]) = (_real[j], _real[i]);
                (_imag[i], _imag[j]) = (_imag[j], _imag[i]);
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
                    var oddReal = _real[odd] * currentReal - _imag[odd] * currentImag;
                    var oddImag = _real[odd] * currentImag + _imag[odd] * currentReal;
                    _real[odd] = _real[even] - (float)oddReal;
                    _imag[odd] = _imag[even] - (float)oddImag;
                    _real[even] = (float)(_real[even] + oddReal);
                    _imag[even] = (float)(_imag[even] + oddImag);

                    var nextReal = currentReal * stepReal - currentImag * stepImag;
                    currentImag = currentReal * stepImag + currentImag * stepReal;
                    currentReal = nextReal;
                }
            }
        }
    }
}

/// <summary>
/// Serializes a frame into the host->page message. Manual formatting keeps the message under the
/// 600 byte budget and the 3-decimal rounding stable (JSON number serializers are free to emit
/// long representations).
/// </summary>
internal static class AudioMessage
{
    internal static string Build(AudioFrameSnapshot frame)
    {
        var builder = new StringBuilder(720);
        builder.Append("{\"v\":1,\"type\":\"host\",\"event\":\"audio\",\"payload\":{\"bins\":[");
        AppendArray(builder, frame.Bins);
        builder.Append("],\"bands\":[");
        AppendArray(builder, frame.Bands);
        builder.Append("],\"level\":");
        AppendNumber(builder, frame.Level);
        builder.Append(",\"peak\":");
        AppendNumber(builder, frame.Peak);
        builder.Append(",\"beat\":");
        builder.Append(frame.Beat ? "true" : "false");
        builder.Append(",\"strength\":");
        AppendNumber(builder, frame.Strength);
        builder.Append(",\"bpm\":");
        // BPM 不在 0..1 之间，不能走 AppendNumber 的归一化 clamp。
        builder.Append(frame.Bpm.ToString("F1", CultureInfo.InvariantCulture));
        builder.Append("}}");
        return builder.ToString();
    }

    private static void AppendArray(StringBuilder builder, float[] values)
    {
        for (var i = 0; i < values.Length; i++)
        {
            if (i > 0)
            {
                builder.Append(',');
            }

            AppendNumber(builder, values[i]);
        }
    }

    private static void AppendNumber(StringBuilder builder, float value)
    {
        builder.Append(Math.Clamp(value, 0f, 1f).ToString("F3", CultureInfo.InvariantCulture));
    }
}
