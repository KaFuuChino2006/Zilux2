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

    public double[] Downbeats { get; set; } = Array.Empty<double>();

    public double[] PhraseStartsMs { get; set; } = Array.Empty<double>();

    public int BarCount { get; set; }

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
    bool Force);

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
