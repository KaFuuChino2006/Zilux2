using System.Text.Json.Serialization;

namespace Zilux2.Analysis;

// Wire models for docs/zilux2-beat-analysis-contract.md §2. Field order matches the contract
// example so the JSON the page sees is stable and easy to diff against the doc.
internal sealed class AnalysisSuccessResponse
{
    public int V { get; set; } = 1;

    public bool Ok { get; set; } = true;

    public string Source { get; set; } = string.Empty;

    public string TrackId { get; set; } = string.Empty;

    public string Rel { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;

    public string Artist { get; set; } = string.Empty;

    public long DurationMs { get; set; }

    /// <summary>「可听结尾」位置（ms，相对文件起点，0..DurationMs）；尾部静音不足阈值时等于 DurationMs。</summary>
    public long AudibleEndMs { get; set; }

    /// <summary>尾端静音长度（ms）= DurationMs - AudibleEndMs；没有有效尾部静音时为 0。</summary>
    public long TailSilenceMs { get; set; }

    public bool Cached { get; set; }

    public long ElapsedMs { get; set; }

    public string Analyzer { get; set; } = BeatAnalyzer.AnalyzerVersion;

    public BeatAnalysisPayload Analysis { get; set; } = new();
}

internal sealed class BeatAnalysisPayload
{
    public double Bpm { get; set; }

    public double BpmConfidence { get; set; }

    public int Meter { get; set; } = 4;

    public double MeterConfidence { get; set; }

    public double BeatIntervalMs { get; set; }

    public double FirstBeatMs { get; set; }

    public double FirstDownbeatMs { get; set; }

    /// <summary>DP 跟踪出的真实拍点（ms，相对文件起点，最多 4000 个）；拍点不足时为空数组。</summary>
    public double[] BeatsMs { get; set; } = Array.Empty<double>();

    /// <summary>拍点间隔稳定度（1 = 完全稳定，0 = 漂移严重）；p0-12 起提供，旧缓存为 0。</summary>
    public double TempoStability { get; set; }

    /// <summary>速度曲线时间轴（ms，窗口中心，升序）；p0-12 起提供，与 <see cref="TempoCurveBpm"/> 等长。</summary>
    public double[] TempoCurveMs { get; set; } = Array.Empty<double>();

    /// <summary>速度曲线 BPM（中位数平滑后的逐窗估计）；用于局部小节时长与变速歌。</summary>
    public double[] TempoCurveBpm { get; set; } = Array.Empty<double>();

    public double[] Downbeats { get; set; } = Array.Empty<double>();

    public double[] PhraseStartsMs { get; set; } = Array.Empty<double>();

    public int BarCount { get; set; }

    /// <summary>高潮标记窗口起点（ms）：命中段落内能量最高的 8 小节窗口；未命中为 0。</summary>
    public double ClimaxStartMs { get; set; }

    /// <summary>高潮标记窗口终点（ms）；未命中为 0。</summary>
    public double ClimaxEndMs { get; set; }

    /// <summary>推荐混音入点（ms）：下一首从这里进场（优先 drop，其次副歌，对齐 8 小节乐句）；未识别为 0。</summary>
    public double CueInMs { get; set; }

    /// <summary>推荐混音出点（ms）：这一首从这里开始让位（末段副歌结束 / 尾奏起点，对齐乐句）；未识别为 0。</summary>
    public double CueOutMs { get; set; }

    /// <summary>调性主音音级（0=C … 11=B；未识别为 -1）。</summary>
    public int Key { get; set; } = -1;

    /// <summary>调式：major / minor；未识别为空串。</summary>
    public string KeyMode { get; set; } = string.Empty;

    /// <summary>Camelot 轮盘编号（如 8A / 8B）；未识别为空串。</summary>
    public string Camelot { get; set; } = string.Empty;

    /// <summary>整曲能量（0~1，按小节能量均值）。</summary>
    public double Energy { get; set; }

    /// <summary>整曲响度近似值（LUFS 口径，越大越响）。</summary>
    public double LoudnessLufs { get; set; }

    /// <summary>峰值电平（dBFS）。</summary>
    public double PeakDb { get; set; }

    public string LoudnessMethod { get; set; } = "mono-rms-approximation";
    public double[] LoudnessTimesMs { get; set; } = Array.Empty<double>();
    public double[] MomentaryLufs { get; set; } = Array.Empty<double>();

    public AnalysisSectionPayload[] Sections { get; set; } = Array.Empty<AnalysisSectionPayload>();

    public string[] Warnings { get; set; } = Array.Empty<string>();
}

internal sealed class AnalysisSectionPayload
{
    public double StartMs { get; set; }

    public double EndMs { get; set; }

    public string Label { get; set; } = string.Empty;

    public double Confidence { get; set; }
}

internal sealed class AnalysisErrorResponse
{
    public int V { get; set; } = 1;

    public bool Ok { get; set; }

    public string Code { get; set; } = string.Empty;

    public string Message { get; set; } = string.Empty;
}

/// <summary>One /api/analysis request after the route handler validated token/source/id.</summary>
internal readonly record struct AnalysisRequest(
    string Source,
    string? TrackId,
    string? Rel,
    string? Quality,
    bool Force,
    bool CacheOnly = false);

/// <summary>
/// Result of one analysis attempt. <see cref="Code"/> is the contract error code when
/// <see cref="Ok"/> is false ("not-found", "not-playable", "decode-failed", ...).
/// </summary>
internal sealed class AnalysisOutcome
{
    private AnalysisOutcome()
    {
    }

    public bool Ok { get; private init; }

    public AnalysisSuccessResponse? Response { get; private init; }

    public string Code { get; private init; } = string.Empty;

    public string Message { get; private init; } = string.Empty;

    internal static AnalysisOutcome Success(AnalysisSuccessResponse response) =>
        new() { Ok = true, Response = response };

    internal static AnalysisOutcome Failure(string code, string message) =>
        new() { Ok = false, Code = code, Message = message };
}

[JsonSourceGenerationOptions(WriteIndented = false, PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(AnalysisSuccessResponse))]
[JsonSerializable(typeof(AnalysisErrorResponse))]
internal sealed partial class AnalysisJsonContext : JsonSerializerContext
{
}
