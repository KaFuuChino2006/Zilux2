namespace Zilux2.Audio;

/// <summary>
/// PCM source fed by the page: the web player taps its own audio graph (before the local gain
/// stage), posts 16-bit stereo PCM over the host bridge, and the AirPlay streamer pulls it from
/// here. This streams only this app's sound, so other apps keep playing on the local speakers and
/// no system-wide mute is needed.
/// <para>
/// The queue is a simple ring of interleaved floats. The capture thread waits for data and the page
/// pushes one block per AudioWorklet block (≈21 ms at 1024 frames); the AirPlay sender pads with
/// silence on underrun, so a late block never stalls the RTP clock. The queue is capped so a stalled
/// main thread can never pile up more than a few hundred milliseconds of extra latency.
/// </para>
/// </summary>
internal sealed class PcmTapSource : IAirPlayAudioSource
{
    private const int MaxBufferedMilliseconds = 260;

    private readonly object _sync = new();
    private readonly Queue<float> _queue = new();
    private int _rate = 48000;
    private int _channels = 2;
    private long _pushedSamples;
    private long _droppedSamples;

    public int SampleRate
    {
        get
        {
            lock (_sync)
            {
                return _rate;
            }
        }
    }

    public int Channels
    {
        get
        {
            lock (_sync)
            {
                return _channels;
            }
        }
    }

    public long PushedSamples => Interlocked.Read(ref _pushedSamples);

    public long DroppedSamples => Interlocked.Read(ref _droppedSamples);

    /// <summary>Applies the format announced by the page before the first block arrives.</summary>
    public void Configure(int sampleRate, int channels)
    {
        if (sampleRate is >= 8000 and <= 192000)
        {
            lock (_sync)
            {
                _rate = sampleRate;
            }
        }

        if (channels is >= 1 and <= 2)
        {
            lock (_sync)
            {
                _channels = channels;
            }
        }
    }

    /// <summary>Queues interleaved float samples; the oldest audio is dropped on overrun.</summary>
    public void Push(ReadOnlySpan<float> samples)
    {
        if (samples.IsEmpty)
        {
            return;
        }

        lock (_sync)
        {
            var capacity = Math.Max(_channels, MaxBufferedMilliseconds * _rate / 1000 * _channels);
            var overflow = _queue.Count + samples.Length - capacity;
            while (overflow-- > 0 && _queue.Count > 0)
            {
                _queue.Dequeue();
                Interlocked.Increment(ref _droppedSamples);
            }

            foreach (var sample in samples)
            {
                _queue.Enqueue(sample);
            }

            Interlocked.Add(ref _pushedSamples, samples.Length);
            Monitor.PulseAll(_sync);
        }
    }

    /// <summary>Drops buffered audio (session restart, seek, or page pause/resume).</summary>
    public void Reset()
    {
        lock (_sync)
        {
            _queue.Clear();
        }
    }

    public bool WaitForData(int timeoutMilliseconds)
    {
        var deadline = Environment.TickCount64 + Math.Max(0, timeoutMilliseconds);
        lock (_sync)
        {
            while (_queue.Count == 0)
            {
                var remaining = deadline - Environment.TickCount64;
                if (remaining <= 0)
                {
                    return false;
                }

                Monitor.Wait(_sync, (int)Math.Min(remaining, 5));
            }

            return true;
        }
    }

    public int ReadInterleaved(float[] destination)
    {
        ArgumentNullException.ThrowIfNull(destination);
        lock (_sync)
        {
            var channels = Math.Max(1, _channels);
            var count = Math.Min(destination.Length, _queue.Count);
            count -= count % channels;
            for (var i = 0; i < count; i++)
            {
                destination[i] = _queue.Dequeue();
            }

            return count;
        }
    }

    public void Dispose()
    {
        Reset();
    }
}
