namespace Zilux2.AirPlay.Audio;

/// <summary>
/// Streaming band-limited sample-rate converter for interleaved stereo float audio.
/// Uses a Blackman-windowed sinc kernel evaluated directly per output sample: at 44.1 kHz
/// output with 32 taps this is ~2.8 M multiply-adds per second, far cheaper than the
/// encoder, so no polyphase table is needed. Stateful: feed fixed-size capture chunks.
/// </summary>
internal sealed class StereoResampler
{
    private const int DefaultTaps = 32;
    private readonly double _step;
    private readonly int _taps;
    private readonly int _half;
    private readonly int _inputRate;
    private readonly int _outputRate;
    private readonly List<float> _left = new(4096);
    private readonly List<float> _right = new(4096);
    private long _consumedFrames;
    private long _nextOutputIndex;

    public StereoResampler(int inputRate, int outputRate, int taps = DefaultTaps)
    {
        if (inputRate <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(inputRate));
        }

        if (outputRate <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(outputRate));
        }

        _inputRate = inputRate;
        _outputRate = outputRate;
        _step = (double)inputRate / outputRate;
        _taps = Math.Max(8, taps % 2 == 0 ? taps : taps + 1);
        _half = _taps / 2;
    }

    public int InputRate => _inputRate;

    public int OutputRate => _outputRate;

    public long ProducedFrames => _nextOutputIndex;

    public bool IsIdentity => _inputRate == _outputRate;

    /// <summary>
    /// Appends <paramref name="inputFrames"/> stereo frames and writes as many output frames
    /// as the history allows. <paramref name="output"/> must hold at least
    /// <c>ceil(inputFrames / step) + taps</c> stereo frames; the return value is frames written.
    /// </summary>
    public int Process(ReadOnlySpan<float> input, int inputFrames, Span<float> output)
    {
        if (inputFrames <= 0)
        {
            return 0;
        }

        for (var frame = 0; frame < inputFrames; frame++)
        {
            _left.Add(input[frame * 2]);
            _right.Add(input[frame * 2 + 1]);
        }

        var produced = 0;
        while (true)
        {
            var position = _nextOutputIndex * _step;      // position in absolute input frames
            var center = (int)Math.Floor(position);
            var firstNeeded = center - _half + 1;          // absolute input frame indexes required
            var lastNeeded = center + _half;
            var available = _consumedFrames + _left.Count;
            if (lastNeeded >= available || output.Length < (produced + 1) * 2)
            {
                break;
            }

            var left = 0.0;
            var right = 0.0;
            for (var tap = 0; tap < _taps; tap++)
            {
                var absolute = firstNeeded + tap;
                if (absolute < _consumedFrames || absolute >= available)
                {
                    continue;
                }

                var weight = Kernel(position - absolute);
                var index = (int)(absolute - _consumedFrames);
                left += _left[index] * weight;
                right += _right[index] * weight;
            }

            output[produced * 2] = (float)left;
            output[produced * 2 + 1] = (float)right;
            produced++;
            _nextOutputIndex++;
        }

        DropConsumedHistory();
        return produced;
    }

    /// <summary>Drops input frames that no future output sample can reference.</summary>
    private void DropConsumedHistory()
    {
        var nextCenter = (int)Math.Floor(_nextOutputIndex * _step);
        var keepFrom = nextCenter - _half;
        var drop = keepFrom - (int)_consumedFrames;
        if (drop <= 0)
        {
            return;
        }

        drop = Math.Min(drop, _left.Count);
        _left.RemoveRange(0, drop);
        _right.RemoveRange(0, drop);
        _consumedFrames += drop;
    }

    /// <summary>Normalized sinc with a Blackman window; t is the distance in input samples.</summary>
    private double Kernel(double distance)
    {
        var x = Math.Abs(distance);
        if (x > _half)
        {
            return 0;
        }

        var x2 = distance * distance;
        var sinc = x < 1e-9 ? 1.0 : Math.Sin(Math.PI * distance) / (Math.PI * distance);
        var t = (x / _half) * 0.5 + 0.5; // 0..1 across the kernel
        var window = 0.42 - 0.5 * Math.Cos(2 * Math.PI * t) + 0.08 * Math.Cos(4 * Math.PI * t);
        return sinc * window;
    }
}
