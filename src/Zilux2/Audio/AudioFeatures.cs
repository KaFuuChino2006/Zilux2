using System.Globalization;
using System.Text;

namespace Zilux2.Audio;

/// <summary>
/// One 30 Hz feature frame. The arrays are reused by <see cref="AudioAnalyzer"/> and only stay
/// valid until the next Analyze call, so a consumer must serialize/copy them immediately.
/// </summary>
internal sealed class AudioFrameSnapshot
{
    internal AudioFrameSnapshot(float[] bins, float[] bands, float level, float peak, bool beat)
    {
        Bins = bins;
        Bands = bands;
        Level = level;
        Peak = peak;
        Beat = beat;
    }

    internal float[] Bins { get; }

    internal float[] Bands { get; }

    internal float Level { get; }

    internal float Peak { get; }

    internal bool Beat { get; }
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
    private const float BeatCooldownMilliseconds = 320f;

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
    private long _lastBeatTimestamp;

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
        _lastBeatTimestamp = 0;
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

        // Bass spike detection with a fixed refractory window keeps the flag from flickering on
        // sustained bass; the adaptive average makes it level-independent.
        var bass = _bands[1] * 0.6f + _bands[2] * 0.4f;
        var now = Environment.TickCount64;
        _beat = bass > 0.12f &&
                bass > _bassAverage * 1.45f &&
                now - _lastBeatTimestamp >= BeatCooldownMilliseconds;
        if (_beat)
        {
            _lastBeatTimestamp = now;
        }

        _bassAverage = _bassAverage * 0.97f + bass * 0.03f;
        return Snapshot();
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
    }

    private AudioFrameSnapshot Snapshot() => new(_bins, _bands, _level, _peak, _beat);

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
