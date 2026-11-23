namespace Zilux2.Analysis;

/// <summary>
/// 一个 stage 的磁盘文件（%LOCALAPPDATA%\Zilux2\analysis\features\&lt;hash&gt;\&lt;stage&gt;.json）。
/// 头字段让缓存可以按 stage 独立失效：模型或算法升级只重算对应 stage，不动基础分析。
/// </summary>
internal sealed class StemFeatureFile
{
    public string Stage { get; set; } = "stems";

    public string StageVersion { get; set; } = string.Empty;

    public string InputKey { get; set; } = string.Empty;

    public string ModelSha256 { get; set; } = string.Empty;

    public long CreatedAtMs { get; set; }

    public StemActivityPayload Payload { get; set; } = new();
}

internal sealed class StructureFeatureFile
{
    public string Stage { get; set; } = "structure";

    public string StageVersion { get; set; } = string.Empty;

    public string InputKey { get; set; } = string.Empty;

    public long CreatedAtMs { get; set; }

    public StructureFeaturePayload Payload { get; set; } = new();
}

/// <summary>style stage：谱统计（500ms 网格）。</summary>
internal sealed class StyleFeatureFile
{
    public string Stage { get; set; } = "style";

    public string StageVersion { get; set; } = string.Empty;

    public string InputKey { get; set; } = string.Empty;

    public long CreatedAtMs { get; set; }

    public StyleProfilePayload Payload { get; set; } = new();
}

/// <summary>一次增强请求的曲目身份；audio 由 TrackAnalysisService.PrepareAudioAsync 解析/下载。</summary>
internal readonly record struct EnrichmentRequest(
    string Source,
    string? TrackId,
    string? Rel,
    string? Quality,
    string TrackKey,
    long DurationMs);

internal enum EnrichmentJobKind
{
    Structure,
    Stems,
    Style,
}

internal sealed class EnrichmentJob
{
    public required EnrichmentJobKind Kind { get; init; }

    public required EnrichmentRequest Request { get; init; }

    /// <summary>structure stage 的输入快照（基础分析结果）；stems stage 为 null。</summary>
    public BeatAnalysisPayload? Payload { get; init; }
}
