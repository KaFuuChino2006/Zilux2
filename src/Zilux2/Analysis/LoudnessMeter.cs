namespace Zilux2.Analysis;

/// <summary>
/// Streaming BS.1770 mono/stereo measurement at the decoded source sample rate.
/// K weighting, 400ms blocks / 100ms hop, -70 LUFS absolute and -10 LU relative gates.
/// PeakDb is sample peak, deliberately NOT labelled true peak.
/// Filter parametrization: https://github.com/jiixyj/libebur128 (ebur128_init_filter).
/// </summary>
internal sealed class LoudnessMeter
{
    private readonly Biquad[] _shelf;
    private readonly Biquad[] _highpass;
    private readonly int _hopFrames;
    private readonly int _sampleRate;
    private readonly Queue<double> _hops = new();
    private readonly List<double> _blocks = new();
    private readonly List<double> _times = new();
    private int _hopCount;
    private long _frames;
    private double _hopEnergy, _peak;

    internal LoudnessMeter(int sampleRate, int channels)
    {
        if (sampleRate < 8000 || channels is < 1 or > 2) throw new ArgumentOutOfRangeException();
        _sampleRate = sampleRate;
        _hopFrames = (int)Math.Round(sampleRate * 0.1);
        _shelf = new Biquad[channels];
        _highpass = new Biquad[channels];
        var k = Math.Tan(Math.PI * 1681.974450955533 / sampleRate);
        var q = 0.7071752369554196;
        var vh = Math.Pow(10, 3.999843853973347 / 20);
        var vb = Math.Pow(vh, 0.4996667741545416);
        var denominator = 1 + k / q + k * k;
        for (var c = 0; c < channels; c++)
        {
            _shelf[c] = new Biquad((vh + vb * k / q + k * k) / denominator,
                2 * (k * k - vh) / denominator, (vh - vb * k / q + k * k) / denominator,
                2 * (k * k - 1) / denominator, (1 - k / q + k * k) / denominator);
            var h = Math.Tan(Math.PI * 38.13547087602444 / sampleRate);
            var d = 1 + h / 0.5003270373238773 + h * h;
            _highpass[c] = new Biquad(1, -2, 1, 2 * (h * h - 1) / d,
                (1 - h / 0.5003270373238773 + h * h) / d);
        }
    }

    internal void PushFrame(ReadOnlySpan<float> frame)
    {
        for (var c = 0; c < _shelf.Length; c++)
        {
            var x = float.IsFinite(frame[c]) ? frame[c] : 0;
            _peak = Math.Max(_peak, Math.Abs(x));
            var weighted = _highpass[c].Process(_shelf[c].Process(x));
            _hopEnergy += weighted * weighted;
        }
        _frames++;
        if (++_hopCount < _hopFrames) return;
        _hops.Enqueue(_hopEnergy / _hopFrames);
        if (_hops.Count > 4) _hops.Dequeue();
        if (_hops.Count == 4)
        {
            _blocks.Add(_hops.Average());
            _times.Add((_frames - 2.0 * _hopFrames) * 1000 / _sampleRate);
        }
        _hopCount = 0;
        _hopEnergy = 0;
    }

    internal LoudnessMeasurement Finish()
    {
        var absolute = _blocks.Where(e => ToLufs(e) > -70).ToArray();
        var relative = absolute.Length > 0 ? absolute.Average() * 0.1 : double.PositiveInfinity;
        var gated = absolute.Where(e => e > relative).ToArray();
        return new LoudnessMeasurement(
            gated.Length > 0 ? ToLufs(gated.Average()) : -70,
            _peak > 0 ? Math.Max(-120, 20 * Math.Log10(_peak)) : -120,
            _times.Select(t => Math.Round(t, 1)).ToArray(),
            _blocks.Select(e => Math.Round(ToLufs(e), 2)).ToArray());
    }

    private static double ToLufs(double energy) => energy > 0 ? Math.Max(-120, -0.691 + 10 * Math.Log10(energy)) : -120;

    private sealed class Biquad(double b0, double b1, double b2, double a1, double a2)
    {
        private double _z1, _z2;
        internal double Process(double x)
        {
            var y = b0 * x + _z1;
            _z1 = b1 * x - a1 * y + _z2;
            _z2 = b2 * x - a2 * y;
            return y;
        }
    }
}

internal sealed record LoudnessMeasurement(double IntegratedLufs, double PeakDb, double[] TimesMs, double[] MomentaryLufs);
