using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace Zilux2.Stems;

/// <summary>一次 30 s 窗口的分离结果（float32、44.1 kHz、立体声、已按统一 headroom 缩放）。</summary>
internal sealed class StemSeparationResult
{
    /// <summary>模型输出的轨数（drums / bass / other / vocals）。</summary>
    internal const int StemCount = 4;

    public required float[] VocalsLeft { get; init; }

    public required float[] VocalsRight { get; init; }

    /// <summary>
    /// 4 轨分离结果，索引与模型输出槽位一致：0=drums、1=bass、2=other、3=vocals。
    /// 每条都是 44.1 kHz 立体声、长度 <see cref="Frames"/>，与 vocals/inst 乘同一个 headroom 增益，
    /// 所以 drums+bass+other 可以直接相加（stem swap 依赖这一点）。
    /// </summary>
    public required float[][] StemLeft { get; init; }

    /// <inheritdoc cref="StemLeft"/>
    public required float[][] StemRight { get; init; }

    public required float[] InstrumentalLeft { get; init; }

    public required float[] InstrumentalRight { get; init; }

    public required int Frames { get; init; }

    /// <summary>加 headroom 之前的峰值（vocals 与 instrumental 合起来）。</summary>
    public float Peak { get; init; }

    /// <summary>两轨统一乘的增益；1 表示没有溢出。</summary>
    public float Gain { get; init; }

    public int Segments { get; init; }

    public long ElapsedMs { get; init; }
}

internal sealed class HtdemucsException : Exception
{
    internal HtdemucsException(string code, string message, Exception? innerException = null)
        : base(message, innerException)
    {
        Code = code;
    }

    internal string Code { get; }
}

/// <summary>
/// HTDemucs 模型会话：分窗推理 + 25% 重叠三角窗 OLA + 尾段钳位 + 全轨统一 headroom。
/// 模型一次输出 4 轨（drums/bass/other/vocals），这里全套累加，2 轨视图只是其中的 vocals 槽位加
/// mix − vocals 的 instrumental。
/// 算法与 tools/stems-proto/Program.cs 保持一致，只是把缓冲区复用、把推理包成可复用会话。
/// </summary>
internal sealed class HtdemucsSession : IDisposable
{
    /// <summary>模型输入维度必须等于它；否则说明模型不对，直接拒绝。</summary>
    internal const int RequiredSegmentFrames = StemsContract.SegmentFrames;

    /// <summary>输出 4 轨布局里的槽位：drums, bass, other, vocals。</summary>
    internal const int DrumStemIndex = 0;

    internal const int BassStemIndex = 1;

    internal const int OtherStemIndex = 2;

    /// <summary>输出 4 轨布局里的 vocals 槽位（drums, bass, other, vocals）。</summary>
    internal const int VocalStemIndex = 3;

    private const float OverlapRatio = 0.25f;
    private const float HeadroomPeak = 0.999f;
    private const float WeightFloor = 1e-8f;

    private readonly InferenceSession _session;
    private readonly string _inputName;
    private readonly string _outputName;
    private readonly int _segment;
    private readonly int _stride;
    private readonly float[] _window;
    private readonly object _runGate = new();
    private int _disposed;

    private HtdemucsSession(InferenceSession session, string inputName, string outputName, int segment)
    {
        _session = session;
        _inputName = inputName;
        _outputName = outputName;
        _segment = segment;
        var overlap = Math.Max(1, (int)MathF.Round(segment * OverlapRatio, MidpointRounding.AwayFromZero));
        _stride = Math.Max(1, segment - overlap);
        _window = MakeTriangleWindow(segment, overlap);
    }

    /// <summary>clamp(ProcessorCount / 2, 4, 12)：research/folia-stems-plan.md 实测 12 线程是拐点。</summary>
    internal static int DefaultThreadCount => Math.Clamp(Environment.ProcessorCount / 2, 4, 12);

    internal int SegmentFrames => _segment;

    /// <summary>给定窗口长度需要推理几段（用于日志与单元测试）。</summary>
    internal int CountSegments(int frames) => BuildSegmentStarts(frames, _segment, _stride, clampTail: true).Count;

    /// <summary>打开会话；失败抛 <see cref="HtdemucsException"/>（model-load-failed / model-incompatible）。</summary>
    internal static HtdemucsSession Open(
        string modelPath,
        int threadCount,
        bool enableCpuMemArena = true,
        bool enableMemoryPattern = false,
        int interOpThreads = 1)
    {
        if (string.IsNullOrWhiteSpace(modelPath))
        {
            throw new HtdemucsException("model-load-failed", "人声分离模型路径为空");
        }

        if (!File.Exists(modelPath))
        {
            throw new HtdemucsException("model-load-failed", $"找不到人声分离模型：{modelPath}");
        }

        var options = new SessionOptions
        {
            GraphOptimizationLevel = GraphOptimizationLevel.ORT_ENABLE_ALL,
            IntraOpNumThreads = Math.Max(1, threadCount),
            InterOpNumThreads = Math.Max(1, interOpThreads),
            EnableCpuMemArena = enableCpuMemArena,
            EnableMemoryPattern = enableMemoryPattern,
        };

        InferenceSession? session = null;
        try
        {
            session = new InferenceSession(modelPath, options);

            var inputs = session.InputMetadata;
            var outputs = session.OutputMetadata;
            if (inputs.Count != 1 || outputs.Count < 1)
            {
                throw new HtdemucsException(
                    "model-incompatible",
                    $"人声分离模型 I/O 不符合预期（inputs={inputs.Count}, outputs={outputs.Count}）");
            }

            var inputName = inputs.Keys.First();
            var outputName = outputs.Keys.First();
            var segment = ReadSegmentFrames(inputs[inputName].Dimensions);
            if (segment != RequiredSegmentFrames)
            {
                throw new HtdemucsException(
                    "model-incompatible",
                    $"人声分离模型段长 {segment} 与契约要求的 {RequiredSegmentFrames} 不符");
            }

            return new HtdemucsSession(session, inputName, outputName, segment);
        }
        catch
        {
            session?.Dispose();
            throw;
        }
        finally
        {
            options.Dispose();
        }
    }

    /// <summary>
    /// 对一整窗 44.1 kHz 立体声做分离。输入数组长度至少为 <paramref name="frames"/>；
    /// 4 轨（drums/bass/other/vocals）与派生的 vocals/instrumental 都已经是统一 headroom，
    /// 峰值 ≤ 0.999。
    /// </summary>
    internal StemSeparationResult Separate(
        float[] mixLeft,
        float[] mixRight,
        int frames,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(mixLeft);
        ArgumentNullException.ThrowIfNull(mixRight);
        if (frames <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(frames), "窗口帧数必须大于 0");
        }

        if (mixLeft.Length < frames || mixRight.Length < frames)
        {
            throw new ArgumentException("输入数组长度小于窗口帧数", nameof(mixLeft));
        }

        lock (_runGate)
        {
            ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
            return SeparateCore(mixLeft, mixRight, frames, cancellationToken);
        }
    }

    private StemSeparationResult SeparateCore(
        float[] mixLeft,
        float[] mixRight,
        int frames,
        CancellationToken cancellationToken)
    {
        var watch = Stopwatch.StartNew();

        // 尾段窗口可能短于一个模型段（例如 3 秒尾部）：补静音到整段再推理，
        // 输出只保留真实帧数；否则 ReadSegment 会越界（Index outside the bounds）。
        var outputFrames = frames;
        if (frames < _segment)
        {
            var paddedLeft = new float[_segment];
            var paddedRight = new float[_segment];
            Array.Copy(mixLeft, paddedLeft, frames);
            Array.Copy(mixRight, paddedRight, frames);
            mixLeft = paddedLeft;
            mixRight = paddedRight;
            frames = _segment;
        }

        var starts = BuildSegmentStarts(frames, _segment, _stride, clampTail: true);

        // 4 轨累加器，索引与模型输出槽位一致（drums/bass/other/vocals）。
        // 多累加 3 轨只是一点内存带宽，远小于一次 ORT 推理，所以总是累加全套：
        // 2 轨请求只取 vocals 槽位，4 轨请求直接拿全部；同一窗口的 vocals 在两种模式下
        // 逐样本一致，切换模式不会听到音色变化。
        var stemCount = StemSeparationResult.StemCount;
        var stemLeft = new float[stemCount][];
        var stemRight = new float[stemCount][];
        for (var stem = 0; stem < stemCount; stem++)
        {
            stemLeft[stem] = new float[frames];
            stemRight[stem] = new float[frames];
        }

        var weightSum = new float[frames];

        // 复用同一块输入张量：每段只覆盖 Buffer，避免 5 段分配 5 次 2.7MB。
        var input = new DenseTensor<float>(new[] { 1, 2, _segment });
        var inputSpan = input.Buffer.Span;

        foreach (var start in starts)
        {
            cancellationToken.ThrowIfCancellationRequested();

            for (var i = 0; i < _segment; i++)
            {
                inputSpan[i] = mixLeft[start + i];
                inputSpan[_segment + i] = mixRight[start + i];
            }

            using var results = _session.Run(new[] { NamedOnnxValue.CreateFromTensor(_inputName, input) });
            var tensor = FindOutput(results);
            if (tensor is DenseTensor<float> dense)
            {
                Accumulate(dense.Buffer.Span, start);
            }
            else
            {
                Accumulate(tensor.ToArray(), start);
            }
        }

        void Accumulate(ReadOnlySpan<float> output, int start)
        {
            // 输出布局 (1, 4, 2, segment)：槽位 0..3 = drums/bass/other/vocals，
            // 每个槽位里两个声道各占一段。
            if (output.Length < stemCount * 2 * _segment)
            {
                throw new HtdemucsException(
                    "inference-failed",
                    $"人声分离模型输出长度 {output.Length} 小于预期 {stemCount * 2 * _segment}");
            }

            for (var stem = 0; stem < stemCount; stem++)
            {
                var leftOffset = stem * 2 * _segment;
                var rightOffset = leftOffset + _segment;
                var targetLeft = stemLeft[stem];
                var targetRight = stemRight[stem];
                for (var i = 0; i < _segment; i++)
                {
                    var weight = _window[i];
                    var index = start + i;
                    targetLeft[index] += output[leftOffset + i] * weight;
                    targetRight[index] += output[rightOffset + i] * weight;
                }
            }

            for (var i = 0; i < _segment; i++)
            {
                weightSum[start + i] += _window[i];
            }
        }

        // 就地归一化：stemLeft/stemRight 从累加缓冲直接变成最终 4 轨，省掉一份 42 MB 的拷贝。
        var vocalLeft = new float[outputFrames];
        var vocalRight = new float[outputFrames];
        var instrumentalLeft = new float[outputFrames];
        var instrumentalRight = new float[outputFrames];
        var peak = 0f;
        for (var i = 0; i < outputFrames; i++)
        {
            // 三角窗权重和恒 > 0；下限只是防御性写法（与原型一致）。
            var inverse = 1f / MathF.Max(weightSum[i], WeightFloor);
            for (var stem = 0; stem < stemCount; stem++)
            {
                stemLeft[stem][i] *= inverse;
                stemRight[stem][i] *= inverse;
            }

            var left = stemLeft[VocalStemIndex][i];
            var right = stemRight[VocalStemIndex][i];
            var instLeft = mixLeft[i] - left;
            var instRight = mixRight[i] - right;

            vocalLeft[i] = left;
            vocalRight[i] = right;
            instrumentalLeft[i] = instLeft;
            instrumentalRight[i] = instRight;

            // peak 只看 vocals + instrumental：headroom 增益必须与旧 2 轨实现逐样本一致，
            // 否则同一窗口在旧版/新版算出的音轨对不上。4 轨沿用同一增益，保证仍可与 inst 相加。
            var magnitude = MathF.Max(
                MathF.Max(MathF.Abs(left), MathF.Abs(right)),
                MathF.Max(MathF.Abs(instLeft), MathF.Abs(instRight)));
            if (magnitude > peak)
            {
                peak = magnitude;
            }
        }

        // instrumental = mix − vocals 的峰值可能略超 1（实测 1.07）；所有轨同乘一个增益，
        // 恒等式不变，前端也不会听到某一路比另一路更响。
        var gain = peak > HeadroomPeak ? HeadroomPeak / peak : 1f;
        if (gain < 1f)
        {
            for (var i = 0; i < outputFrames; i++)
            {
                vocalLeft[i] *= gain;
                vocalRight[i] *= gain;
                instrumentalLeft[i] *= gain;
                instrumentalRight[i] *= gain;
                for (var stem = 0; stem < stemCount; stem++)
                {
                    stemLeft[stem][i] *= gain;
                    stemRight[stem][i] *= gain;
                }
            }
        }

        return new StemSeparationResult
        {
            VocalsLeft = vocalLeft,
            VocalsRight = vocalRight,
            StemLeft = stemLeft,
            StemRight = stemRight,
            InstrumentalLeft = instrumentalLeft,
            InstrumentalRight = instrumentalRight,
            Frames = outputFrames,
            Peak = peak,
            Gain = gain,
            Segments = starts.Count,
            ElapsedMs = watch.ElapsedMilliseconds,
        };
    }

    private Tensor<float> FindOutput(IDisposableReadOnlyCollection<DisposableNamedOnnxValue> results)
    {
        foreach (var result in results)
        {
            if (string.Equals(result.Name, _outputName, StringComparison.Ordinal))
            {
                return result.AsTensor<float>();
            }
        }

        return results.First().AsTensor<float>();
    }

    /// <summary>分窗起点：最后一段钳位到 frames − segment，避免补零推理且尾段结果一致。</summary>
    internal static List<int> BuildSegmentStarts(int frames, int segment, int stride, bool clampTail)
    {
        var starts = new List<int>();
        if (frames <= 0)
        {
            return starts;
        }

        if (frames <= segment)
        {
            starts.Add(0);
            return starts;
        }

        for (var candidate = 0; ; candidate += stride)
        {
            var start = candidate;
            var last = start + segment >= frames;
            if (last && clampTail)
            {
                start = frames - segment;
            }

            if (starts.Count == 0 || start != starts[^1])
            {
                starts.Add(start);
            }

            if (last)
            {
                break;
            }
        }

        return starts;
    }

    /// <summary>两端 25% 三角窗，中间恒 1；OLA 除以权重和得到无重叠泄漏的结果。</summary>
    internal static float[] MakeTriangleWindow(int segment, int overlap)
    {
        var window = new float[segment];
        Array.Fill(window, 1f);
        var span = overlap > 1 ? overlap - 1 : 1;
        for (var i = 0; i < overlap && i < segment; i++)
        {
            var value = i / (float)span;
            window[i] = value;
            window[segment - 1 - i] = value;
        }

        return window;
    }

    private static int ReadSegmentFrames(int[] dimensions)
    {
        // 只看最后一维；前两维允许是 -1 / 1 / 2（不同导出会带/不带 batch 动态维度）。
        if (dimensions.Length >= 3 && dimensions[^1] > 0)
        {
            return dimensions[^1];
        }

        throw new HtdemucsException(
            "model-incompatible",
            $"人声分离模型输入维度非法：{string.Join(",", dimensions)}");
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        // 等当前推理跑完再释放，避免 ORT 在 Run 中途被 Dispose。
        lock (_runGate)
        {
            _session.Dispose();
        }
    }
}
