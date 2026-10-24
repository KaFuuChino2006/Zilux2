using System.IO;
using NAudio.Wave;

namespace Zilux2.Analysis;

/// <summary>Mono PCM decoded from one audio file: what the beat analyzer consumes.</summary>
internal sealed class DecodedTrack
{
    public float[] Samples { get; init; } = Array.Empty<float>();

    public int SampleRate { get; init; }

    public int SourceChannels { get; init; }

    public long DurationMs { get; init; }

    public bool Truncated { get; init; }
}

/// <summary>
/// Decodes an audio file with Media Foundation (the same decoder the host already uses for ALAC
/// .m4a), downmixes to mono and resamples to 22050 Hz for analysis. Bounded to 12 minutes so one
/// long file cannot exhaust memory; failures surface as "decode-failed" per contract §4.
/// </summary>
internal static class TrackAudioDecoder
{
    internal const int TargetSampleRate = 22050;
    internal const int MaxDurationMs = 12 * 60 * 1000;

    internal static DecodedTrack? TryDecode(string path, out string error)
    {
        error = string.Empty;
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            error = "音频文件不存在";
            return null;
        }

        try
        {
            using var reader = new MediaFoundationReader(path);
            var format = reader.WaveFormat;
            if (format.SampleRate <= 0 || format.Channels <= 0)
            {
                error = "音频流格式无效";
                return null;
            }

            var provider = reader.ToSampleProvider();
            var sourceChannels = provider.WaveFormat.Channels;
            if (sourceChannels <= 0)
            {
                error = "音频流声道数无效";
                return null;
            }

            var sourceRate = provider.WaveFormat.SampleRate;
            var step = sourceRate / (double)TargetSampleRate;
            var maxSamples = (int)Math.Ceiling(MaxDurationMs / 1000.0 * TargetSampleRate);
            var samples = new List<float>(EstimateSampleCount(reader, maxSamples));
            var resampler = new LinearResampler(step, samples, maxSamples);
            var interleaved = new float[4096 * sourceChannels];
            var sourceFrames = 0L;
            var truncated = false;

            while (true)
            {
                // NAudio 3.x 的 ISampleProvider 只暴露 Read(Span<float>)，与 WaveStream 不同。
                var read = provider.Read(interleaved.AsSpan());
                if (read <= 0)
                {
                    break;
                }

                var frames = read / sourceChannels;
                for (var frame = 0; frame < frames; frame++)
                {
                    var offset = frame * sourceChannels;
                    var sum = 0f;
                    for (var channel = 0; channel < sourceChannels; channel++)
                    {
                        sum += interleaved[offset + channel];
                    }

                    resampler.Push(sum / sourceChannels);
                    if (resampler.TargetFull)
                    {
                        truncated = true;
                        break;
                    }
                }

                sourceFrames += frames;
                if (truncated)
                {
                    break;
                }
            }

            resampler.Flush();
            if (samples.Count < 16)
            {
                error = "音频内容过短";
                return null;
            }

            // Click tracks and decoded music can overshoot [-1, 1] after conversion; keep the
            // analyzer's log-compressed flux well defined.
            var peak = 0f;
            foreach (var sample in samples)
            {
                var absolute = MathF.Abs(sample);
                if (absolute > peak)
                {
                    peak = absolute;
                }
            }

            var gain = peak > 1f ? 1f / peak : 1f;
            if (gain < 1f || float.IsNaN(gain))
            {
                for (var i = 0; i < samples.Count; i++)
                {
                    samples[i] *= gain;
                }
            }

            var durationMs = truncated
                ? MaxDurationMs
                : (long)Math.Round(sourceFrames / (double)sourceRate * 1000.0);
            if (durationMs <= 0)
            {
                durationMs = (long)Math.Round(samples.Count / (double)TargetSampleRate * 1000.0);
            }

            return new DecodedTrack
            {
                Samples = samples.ToArray(),
                SampleRate = TargetSampleRate,
                SourceChannels = sourceChannels,
                DurationMs = durationMs,
                Truncated = truncated,
            };
        }
        catch (Exception exception)
        {
            error = exception.Message;
            return null;
        }
    }

    private static int EstimateSampleCount(MediaFoundationReader reader, int maxSamples)
    {
        try
        {
            var sourceSeconds = Math.Min(reader.TotalTime.TotalSeconds, MaxDurationMs / 1000.0);
            if (sourceSeconds > 0)
            {
                return Math.Clamp((int)(sourceSeconds * TargetSampleRate), 1024, maxSamples);
            }
        }
        catch
        {
            // TotalTime can be unknown for streams; fall back to the cap.
        }

        return Math.Min(1024 * 1024, maxSamples);
    }

    /// <summary>
    /// Streaming linear resampler: source samples go in one at a time, output is appended to a
    /// bounded list. Linear interpolation is enough for onset detection (the spectral flux keeps
    /// working at 22050 Hz) and avoids pulling another NAudio resampler assembly.
    /// </summary>
    private sealed class LinearResampler
    {
        private readonly double _step;
        private readonly List<float> _output;
        private readonly int _capacity;
        private float _previous;
        private bool _hasPrevious;
        private double _position;

        internal LinearResampler(double step, List<float> output, int capacity)
        {
            _step = step > 0 ? step : 1.0;
            _output = output;
            _capacity = capacity;
        }

        internal bool TargetFull => _output.Count >= _capacity;

        internal void Push(float sample)
        {
            if (!_hasPrevious)
            {
                _previous = sample;
                _hasPrevious = true;
                return;
            }

            while (_position < 1.0)
            {
                if (_output.Count >= _capacity)
                {
                    return;
                }

                _output.Add((float)(_previous + (sample - _previous) * _position));
                _position += _step;
            }

            _position -= 1.0;
            _previous = sample;
        }

        internal void Flush()
        {
            if (_hasPrevious && _output.Count < _capacity)
            {
                _output.Add(_previous);
            }

            _hasPrevious = false;
        }
    }
}
