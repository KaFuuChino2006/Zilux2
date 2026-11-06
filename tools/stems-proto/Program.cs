using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace StemsProto;

internal static class Program
{
    // HTDemucs v4 fixed segment length: 343980 samples = 7.8 s @ 44100 Hz.
    // The ExportMetadata in the graph is authoritative; this default is only used when
    // --segment is not given and the graph shape cannot be read.
    private const int DefaultSegment = 343_980;

    private static int Main(string[] argv)
    {
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;

        if (argv.Length < 3)
        {
            Console.Error.WriteLine("""
                usage: StemsProto <model.onnx> <in-44k1-stereo.wav> <outdir> [options]

                  --threads N        intra-op threads              (default 4)
                  --arena on|off     ORT CPU memory arena          (default off — required for low RSS)
                  --mempattern on|off ORT memory pattern           (default off)
                  --opt 0|1|2|99     graph optimisation level      (default 99 = ALL)
                  --segment N        segment samples                (default from graph, else 343980)
                  --overlap-percent P segment overlap percent       (default 25)
                  --window-sec S     only separate the first S seconds (0 = whole file)
                  --dump4            also write all four stems (sanity: sum(stems) ~= mix)
                  --no-write         skip writing wavs (timing-only run)
                """);
            return 2;
        }

        string modelPath = argv[0];
        string wavPath = argv[1];
        string outDir = argv[2];
        int threads = 4, segment = 0;
        int overlapPct = 25;
        double windowSec = 0;
        bool arena = false, memPattern = false, dump4 = false, write = true, clampTail = false;
        GraphOptimizationLevel opt = GraphOptimizationLevel.ORT_ENABLE_ALL;

        for (int i = 3; i < argv.Length; i++)
        {
            switch (argv[i])
            {
                case "--threads": threads = int.Parse(argv[++i]); break;
                case "--arena": arena = argv[++i].Equals("on", StringComparison.OrdinalIgnoreCase); break;
                case "--mempattern": memPattern = argv[++i].Equals("on", StringComparison.OrdinalIgnoreCase); break;
                case "--segment": segment = int.Parse(argv[++i]); break;
                case "--overlap-percent": overlapPct = int.Parse(argv[++i]); break;
                case "--window-sec": windowSec = double.Parse(argv[++i]); break;
                case "--dump4": dump4 = true; break;
                case "--clamp-tail": clampTail = true; break;
                case "--no-write": write = false; break;
                case "--opt":
                    opt = int.Parse(argv[++i]) switch
                    {
                        0 => GraphOptimizationLevel.ORT_DISABLE_ALL,
                        1 => GraphOptimizationLevel.ORT_ENABLE_BASIC,
                        2 => GraphOptimizationLevel.ORT_ENABLE_EXTENDED,
                        _ => GraphOptimizationLevel.ORT_ENABLE_ALL,
                    };
                    break;
                default:
                    Console.Error.WriteLine("unknown option: " + argv[i]);
                    return 2;
            }
        }

        Directory.CreateDirectory(outDir);
        var mem = new MemProbe();
        mem.Start();
        var total = Stopwatch.StartNew();

        // ---- decode -------------------------------------------------------
        var tRead = Stopwatch.StartNew();
        var pcm = Wav.Read(wavPath);
        int frames = pcm.Frames;
        if (windowSec > 0)
            frames = Math.Min(frames, (int)Math.Round(windowSec * pcm.SampleRate));
        tRead.Stop();
        Console.WriteLine($"[in ] {wavPath}");
        Console.WriteLine($"[in ] {frames} frames = {frames / 44100.0:F2} s, 44100 Hz stereo, {pcm.Frames / 44100.0:F2} s on disk");
        Console.WriteLine($"[in ] decode {tRead.Elapsed.TotalMilliseconds:F0} ms");

        // ---- session ------------------------------------------------------
        var so = new SessionOptions
        {
            GraphOptimizationLevel = opt,
            IntraOpNumThreads = Math.Max(1, threads),
            InterOpNumThreads = 1,
            EnableCpuMemArena = arena,
            EnableMemoryPattern = memPattern,
        };

        mem.Reset();
        var tLoad = Stopwatch.StartNew();
        using var session = new InferenceSession(modelPath, so);
        tLoad.Stop();
        double loadMs = tLoad.Elapsed.TotalMilliseconds;
        long loadPeak = mem.PeakWorkingSet;
        Console.WriteLine($"[mdl] {Path.GetFileName(modelPath)}  {new FileInfo(modelPath).Length / 1048576.0:F1} MB");
        Console.WriteLine($"[mdl] session {loadMs:F0} ms, peak WS after load {MemProbe.Mb(loadPeak):F0} MB");

        string inputName = session.InputMetadata.Keys.First();
        var inDims = session.InputMetadata[inputName].Dimensions;
        if (segment <= 0)
            segment = inDims.Length == 3 && inDims[2] > 0 ? inDims[2] : DefaultSegment;
        Console.WriteLine($"[mdl] input '{inputName}' [{string.Join(",", inDims)}] -> segment {segment} ({segment / 44100.0:F3} s)");

        string outName = session.OutputMetadata.Keys.First();
        var outDims = session.OutputMetadata[outName].Dimensions;
        Console.WriteLine($"[mdl] output '{outName}' [{string.Join(",", outDims)}]");

        // ---- overlap-add --------------------------------------------------
        int overlap = segment * overlapPct / 100;
        int stride = segment - overlap;
        if (stride <= 0) { Console.Error.WriteLine("overlap >= 100%"); return 2; }

        var window = MakeTriangleWindow(segment, overlap);

        var accL = new float[frames];
        var accR = new float[frames];
        var wsum = new float[frames];
        var stems4 = dump4 ? new float[4][] { new float[frames], new float[frames], new float[frames], new float[frames] } : null;

        var mixL = new float[segment];
        var mixR = new float[segment];
        var segMs = new List<double>();

        // Panic guard: an unbounded Run() on a hostile graph could eat the machine.
        using var watchdog = new CancellationTokenSource(TimeSpan.FromMinutes(20));


        mem.Reset();
        var tRun = Stopwatch.StartNew();
        var starts = BuildSegmentStarts(frames, segment, stride, clampTail);
        for (int si = 0; si < starts.Count; si++)
        {
            int start = starts[si];
            if (watchdog.IsCancellationRequested) { Console.Error.WriteLine("watchdog fired"); break; }
            int valid = Math.Min(segment, frames - start);
            Array.Clear(mixL);
            Array.Clear(mixR);
            Array.Copy(pcm.L, start, mixL, 0, valid);
            Array.Copy(pcm.R, start, mixR, 0, valid);

            var input = new DenseTensor<float>(new[] { 1, 2, segment });
            mixL.CopyTo(input.Buffer.Span[..segment]);
            mixR.CopyTo(input.Buffer.Span[segment..(2 * segment)]);

            var tSeg = Stopwatch.StartNew();
            using var results = session.Run(new[] { NamedOnnxValue.CreateFromTensor(inputName, input) });
            tSeg.Stop();
            segMs.Add(tSeg.Elapsed.TotalMilliseconds);

            var stemsTensor = results.First(r => r.Name == outName).AsTensor<float>();
            float[]? materialised = null;
            Span<float> buf;
            if (stemsTensor is DenseTensor<float> dense) buf = dense.Buffer.Span;
            else { materialised = stemsTensor.ToArray(); buf = materialised; }
            GC.KeepAlive(materialised);
            // layout (1,4,2,segment) => ((stem*2)+ch)*segment + i ; order drums, bass, other, vocals
            const int kVocalStem = 3;
            for (int i = 0; i < segment; i++)
            {
                int idx = start + i;
                if (idx >= frames) break;
                float w = window[i];
                accL[idx] += buf[(kVocalStem * 2 + 0) * segment + i] * w;
                accR[idx] += buf[(kVocalStem * 2 + 1) * segment + i] * w;
                wsum[idx] += w;
                if (stems4 is not null)
                    for (int s = 0; s < 4; s++)
                    {
                        // only L for the sanity check is enough, but keep both for completeness
                        stems4[s][idx] += (buf[(s * 2 + 0) * segment + i] + buf[(s * 2 + 1) * segment + i]) * 0.5f * w;
                    }
            }
            Console.WriteLine($"[seg] {si,2} start={start,9} valid={valid,7} {tSeg.Elapsed.TotalMilliseconds,8:F0} ms");
        }
        tRun.Stop();
        long runPeak = mem.PeakWorkingSet;
        long runPeakPriv = mem.PeakPrivate;
        mem.Stop();

        // ---- finalise -----------------------------------------------------
        var vocL = new float[frames];
        var vocR = new float[frames];
        var insL = new float[frames];
        var insR = new float[frames];
        float vocPeak = 0f, insPeak = 0f;
        for (int i = 0; i < frames; i++)
        {
            float inv = 1f / MathF.Max(wsum[i], 1e-8f);
            float vL = accL[i] * inv, vR = accR[i] * inv;
            vocL[i] = vL; vocR[i] = vR;
            insL[i] = pcm.L[i] - vL;   // exact: vocals + instrumental == mix, per sample
            insR[i] = pcm.R[i] - vR;
            vocPeak = MathF.Max(vocPeak, MathF.Max(MathF.Abs(vL), MathF.Abs(vR)));
            insPeak = MathF.Max(insPeak, MathF.Max(MathF.Abs(insL[i]), MathF.Abs(insR[i])));
        }

        // The model is trained on material that may peak at 0 dBFS, so "mix - vocals" can exceed
        // full scale (measured 1.07 here). int16 has no headroom, so scale BOTH stems by the same
        // gain: the sum identity survives, whereas clipping to [-1, 1] would distort exactly the
        // loud passages a listener would notice.
        float writeGain = 1f;
        float bothPeak = MathF.Max(vocPeak, insPeak);
        if (bothPeak > 0.999f) writeGain = 0.999f / bothPeak;
        if (writeGain != 1f)
            for (int i = 0; i < frames; i++)
            {
                vocL[i] *= writeGain; vocR[i] *= writeGain;
                insL[i] *= writeGain; insR[i] *= writeGain;
            }

        // Sum-check: how well do the model's own 4 stems reconstruct the mix?
        double sdrDb = double.NaN;
        if (stems4 is not null)
        {
            double num = 0, den = 0;
            for (int i = 0; i < frames; i++)
            {
                double mix = 0.5 * (pcm.L[i] + pcm.R[i]);
                double sum = stems4[0][i] + stems4[1][i] + stems4[2][i] + stems4[3][i];
                double inv = 1.0 / Math.Max(wsum[i], 1e-8);
                num += (mix - sum * inv) * (mix - sum * inv);
                den += mix * mix;
            }
            sdrDb = 10 * Math.Log10(den / Math.Max(num, 1e-20));
        }

        if (write)
        {
            Wav.Write16(Path.Combine(outDir, "vocals.wav"), vocL, vocR, 44100);
            Wav.Write16(Path.Combine(outDir, "instrumental.wav"), insL, insR, 44100);
            if (stems4 is not null)
                for (int s = 0; s < 4; s++)
                {
                    var name = new[] { "drums", "bass", "other", "vocals4" }[s];
                    var norm = new float[frames];
                    for (int i = 0; i < frames; i++) norm[i] = stems4[s][i] / MathF.Max(wsum[i], 1e-8f);
                    Wav.Write16(Path.Combine(outDir, name + ".wav"), norm, norm, 44100);
                }
        }
        total.Stop();

        var summary = new
        {
            model = Path.GetFileName(modelPath),
            modelBytes = new FileInfo(modelPath).Length,
            threads,
            arena,
            memPattern,
            clampTail,
            segment,
            overlap,
            stride,
            segmentSeconds = segment / 44100.0,
            segments = segMs.Count,
            audioSeconds = frames / 44100.0,
            loadMs,
            loadPeakWsMb = MemProbe.Mb(loadPeak),
            segMsMs = segMs.Select(x => Math.Round(x, 1)).ToArray(),
            segMsMin = segMs.Count > 0 ? Math.Round(segMs.Min(), 1) : 0,
            segMsAvg = segMs.Count > 0 ? Math.Round(segMs.Average(), 1) : 0,
            segMsMax = segMs.Count > 0 ? Math.Round(segMs.Max(), 1) : 0,
            runMs = Math.Round(tRun.Elapsed.TotalMilliseconds, 1),
            runPeakWsMb = MemProbe.Mb(runPeak),
            runPeakPrivateMb = MemProbe.Mb(runPeakPriv),
            procPeakWsMb = MemProbe.Mb(Process.GetCurrentProcess().PeakWorkingSet64),
            managedHeapMb = MemProbe.Mb(GC.GetTotalMemory(false)),
            rtf = frames / 44100.0 / Math.Max(tRun.Elapsed.TotalSeconds, 1e-9),
            vocalsPeak = Math.Round(vocPeak, 4),
            instrumentalPeak = Math.Round(insPeak, 4),
            writeGain = Math.Round(writeGain, 5),
            stemsSumToMixSdrDb = double.IsNaN(sdrDb) ? (double?)null : Math.Round(sdrDb, 2),
            totalMs = Math.Round(total.Elapsed.TotalMilliseconds, 1),
        };
        File.WriteAllText(Path.Combine(outDir, "results.json"),
            JsonSerializer.Serialize(summary, new JsonSerializerOptions { WriteIndented = true }));

        Console.WriteLine();
        Console.WriteLine($"segments       : {segMs.Count} (segment {segment} = {segment / 44100.0:F3} s, overlap {overlap}, stride {stride})");
        Console.WriteLine($"audio          : {frames / 44100.0:F2} s");
        Console.WriteLine($"load           : {loadMs:F0} ms   peak WS {MemProbe.Mb(loadPeak):F0} MB");
        Console.WriteLine($"per segment    : min {summary.segMsMin} / avg {summary.segMsAvg} / max {summary.segMsMax} ms");
        Console.WriteLine($"inference total: {tRun.Elapsed.TotalSeconds:F2} s  ({summary.rtf:F2}x realtime)");
        Console.WriteLine($"peak WS run    : {MemProbe.Mb(runPeak):F0} MB   process peak {MemProbe.Mb(Process.GetCurrentProcess().PeakWorkingSet64):F0} MB");
        Console.WriteLine($"vocals peak    : {vocPeak:F3}   instrumental peak {insPeak:F3}");
        if (!double.IsNaN(sdrDb)) Console.WriteLine($"sum(stems)~mix : {sdrDb:F2} dB");
        Console.WriteLine($"wall total     : {total.Elapsed.TotalSeconds:F2} s");
        Console.WriteLine($"-> {Path.Combine(outDir, "results.json")}");
        return 0;
    }

    /// <summary>
    /// Triangular window over <paramref name="overlap"/> samples rising from 0 to 1, flat in
    /// the middle, mirrored at the tail. With stride = segment - overlap the rising and
    /// falling ramps pair up so the window sum is exactly 1 in every overlap region.
    /// </summary>
    /// <summary>
    /// Segment start offsets. Naive mode pads the final segment with silence, which wastes a
    /// whole 7.8 s inference on as little as one sample of real audio (a 30 s window needs six
    /// segments under 25% overlap, the sixth holding only 0.75 s). Clamp mode instead slides the
    /// last segment back so it fits exactly. That region is then covered by two windows whose
    /// weights sum to more than 1, but the divide-by-weight-sum in the finalise step keeps the
    /// reconstruction exact, so the audio is identical while one inference disappears.
    /// </summary>
    private static List<int> BuildSegmentStarts(int frames, int segment, int stride, bool clampTail)
    {
        var starts = new List<int>();
        if (frames <= 0) return starts;
        if (frames <= segment) { starts.Add(0); return starts; }

        for (int s = 0; ; s += stride)
        {
            int start = s;
            bool last = start + segment >= frames;
            if (last && clampTail) start = frames - segment;

            if (starts.Count == 0 || start != starts[^1]) starts.Add(start);
            if (last) break;
        }
        return starts;
    }

    private static float[] MakeTriangleWindow(int segment, int overlap)
    {
        var w = new float[segment];
        Array.Fill(w, 1f);
        float d = overlap > 1 ? overlap - 1 : 1;
        for (int i = 0; i < overlap && i < segment; i++)
        {
            float v = i / d;
            w[i] = v;
            w[segment - 1 - i] = v;
        }
        return w;
    }
}

/// <summary>Samples working set / private bytes on a background thread so we can report
/// the real peak of the inference phase, not just the final RSS.</summary>
internal sealed class MemProbe
{
    private readonly Process _p = Process.GetCurrentProcess();
    private Thread? _t;
    private volatile bool _run;
    private long _peakWs;
    private long _peakPriv;

    public long PeakWorkingSet => Math.Max(Interlocked.Read(ref _peakWs), _p.PeakWorkingSet64);
    public long PeakPrivate => Interlocked.Read(ref _peakPriv);

    public void Start()
    {
        _run = true;
        _t = new Thread(() =>
        {
            while (_run)
            {
                try
                {
                    _p.Refresh();
                    long ws = _p.WorkingSet64;
                    long pv = _p.PrivateMemorySize64;
                    if (ws > Interlocked.Read(ref _peakWs)) Interlocked.Exchange(ref _peakWs, ws);
                    if (pv > Interlocked.Read(ref _peakPriv)) Interlocked.Exchange(ref _peakPriv, pv);
                }
                catch { /* process may be tearing down */ }
                Thread.Sleep(20);
            }
        }) { IsBackground = true, Name = "memprobe" };
        _t.Start();
    }

    public void Reset()
    {
        Interlocked.Exchange(ref _peakWs, _p.WorkingSet64);
        Interlocked.Exchange(ref _peakPriv, _p.PrivateMemorySize64);
    }

    public void Stop() => _run = false;

    public static double Mb(long bytes) => bytes / 1048576.0;
}
