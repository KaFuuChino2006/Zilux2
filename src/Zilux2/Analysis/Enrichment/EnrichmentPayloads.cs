// Enhanced analysis payloads (enrichment stages). Kept in the untracked Enrichment folder so a
// parallel `git checkout` of tracked files cannot wipe the contract again.
using System.Text.Json.Serialization;

namespace Zilux2.Analysis;

/// <summary>每个 stage 都可单独缺失，消费方必须按 null 回退到 DSP 曲线。</summary>
internal sealed class AnalysisFeatures
{
    public int V { get; set; } = 1;

    /// <summary>已就绪 stage 的版本拼接，用于前端判断是否需要重新拉取。</summary>
    public string Version { get; set; } = string.Empty;

    public StemActivityPayload? Stems { get; set; }

    public StructureFeaturePayload? Structure { get; set; }

    /// <summary>style stage：500 ms 网格谱统计；缺失时前端只用现有 DSP 曲线。</summary>
    public StyleProfilePayload? Style { get; set; }

    /// <summary>extend stage：生成式/循环延长产物；缺失表示没有或模型未安装。</summary>

    public BeatFusionPayload? BeatFusion { get; set; }

    public EmbeddingPayload? Embedding { get; set; }
}

/// <summary>htdemucs 四轨活动度：250 ms 一格、逐轨 95 分位归一、0~1。</summary>
internal sealed class StemActivityPayload
{
    public double HopMs { get; set; } = 250;

    public double[] Vocal { get; set; } = Array.Empty<double>();

    public double[] Drum { get; set; } = Array.Empty<double>();

    public double[] Bass { get; set; } = Array.Empty<double>();

    public double[] Other { get; set; } = Array.Empty<double>();

    public string Source { get; set; } = "htdemucs";

    public string ModelSha256 { get; set; } = string.Empty;

    public long DurationMs { get; set; }

    public bool Normalized { get; set; } = true;
}

/// <summary>SSM 结构：边界吸附到小节线，段落标签由能量/活动度近似。</summary>
internal sealed class StructureFeaturePayload
{
    public string Source { get; set; } = "ssm";

    public string Method { get; set; } = "ssm-checkerboard";

    public double[] BoundariesMs { get; set; } = Array.Empty<double>();

    public AnalysisSectionPayload[] Sections { get; set; } = Array.Empty<AnalysisSectionPayload>();

    public int BarCount { get; set; }
}

/// <summary>生成式/循环延长产物：File 相对 analysis 根（features/&lt;hash&gt;/extend/…），播放期只读。</summary>

internal sealed class BeatFusionPayload
{
    public string Source { get; set; } = "fusion";

    public double AgreeRatio { get; set; }

    public bool Adopted { get; set; }
}

internal sealed class EmbeddingPayload
{
    public string Model { get; set; } = string.Empty;

    public float[] Vector { get; set; } = Array.Empty<float>();
}

/// <summary>/api/analysis/features 的响应；pending 为空表示所有请求的 stage 已就绪或不可用。</summary>
internal sealed class AnalysisFeaturesResponse
{
    public int V { get; set; } = 1;

    public bool Ok { get; set; } = true;

    public string TrackKey { get; set; } = string.Empty;

    public AnalysisFeatures? Features { get; set; }

    public string[] Pending { get; set; } = Array.Empty<string>();

    public Dictionary<string, string> Status { get; set; } = new(StringComparer.Ordinal);
}

[JsonSourceGenerationOptions(WriteIndented = false, PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(AnalysisFeaturesResponse))]
internal sealed partial class EnrichmentJsonContext : JsonSerializerContext
{
}
