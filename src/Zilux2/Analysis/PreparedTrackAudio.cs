namespace Zilux2.Analysis;

/// <summary>
/// 「只准备音频，不解码不分析」的结果：本地曲目直接给出文件路径；在线曲目已经下载到
/// 调用方给的临时目录里。人声分离需要 44.1 kHz 立体声窗口，和 /api/analysis 的
/// 22.05 kHz 单声道解码管线不同，但曲目解析 / 质量选择 / 下载逻辑必须共用一份。
/// </summary>
internal sealed class PreparedTrackAudio
{
    public required string AudioPath { get; init; }

    /// <summary>true 表示文件是下载到缓存目录的临时副本，由调用方决定何时清理。</summary>
    public required bool IsTemporary { get; init; }

    public required string Source { get; init; }

    public required string Title { get; init; }

    public string? Artist { get; init; }
}

internal sealed class PreparedAudioOutcome
{
    public bool Ok => Audio is not null;

    public string Code { get; init; } = string.Empty;

    public string Message { get; init; } = string.Empty;

    public PreparedTrackAudio? Audio { get; init; }

    internal static PreparedAudioOutcome Success(PreparedTrackAudio audio) => new() { Audio = audio };

    internal static PreparedAudioOutcome Failure(string code, string message) => new()
    {
        Code = code,
        Message = message,
    };
}
