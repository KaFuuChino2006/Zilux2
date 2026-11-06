using System.Buffers;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Zilux2.Stems;

/// <summary>契约里写死的音频参数（docs/zilux2-stems-contract.md §2.1）。</summary>
internal static class StemsContract
{
    internal const int SampleRate = 44_100;

    /// <summary>一个窗口 30 s；缓存文件名与窗口号都以它为单位。</summary>
    internal const int WindowMs = 30_000;

    internal const int WindowFrames = WindowMs * SampleRate / 1000;

    /// <summary>HTDemucs 的段长（样本）；模型输入维度必须是它，宿主据此分窗。</summary>
    internal const int SegmentFrames = 343_980;

    internal const int MinWindowSec = 10;
    internal const int MaxWindowSec = 30;
    internal const int DefaultWindowSec = 30;
}

internal enum StemsState
{
    Ready,
    Computing,
    Busy,
    ModelMissing,
    Error,
}

/// <summary>一次 /api/stems 请求（窗口号 + 可选的调试窗口长度）。</summary>
internal sealed class StemsRequest
{
    public required string Source { get; init; }

    public string? TrackId { get; init; }

    public string? Rel { get; init; }

    public int Window { get; init; }

    public int WindowSec { get; init; } = StemsContract.DefaultWindowSec;

    /// <summary>44.1 kHz 下的窗口起点；窗口号永远按 30 s 网格计算。</summary>
    public long StartFrame => Window * (long)StemsContract.WindowFrames;

    public int RequestedFrames => WindowSec * StemsContract.SampleRate;
}

/// <summary>服务返回给 /api/stems 的状态（序列化形状见契约 §3.1）。</summary>
internal sealed class StemsOutcome
{
    public required StemsState State { get; init; }

    public int Window { get; init; }

    public int WindowSec { get; init; } = StemsContract.DefaultWindowSec;

    public long Frames { get; init; }

    public bool Cached { get; init; }

    public long ElapsedMs { get; init; }

    public int RetryAfterMs { get; init; }

    public string Message { get; init; } = string.Empty;

    /// <summary>内部错误码，只用来选 HTTP 状态码，不进 JSON（契约 §3.1 没有 code 字段）。</summary>
    public string Code { get; init; } = string.Empty;

    public long DurationMs { get; init; }

    internal static StemsOutcome Ready(StemsRequest request, long frames, bool cached, long elapsedMs, long durationMs) =>
        new()
        {
            State = StemsState.Ready,
            Window = request.Window,
            WindowSec = request.WindowSec,
            Frames = frames,
            Cached = cached,
            ElapsedMs = elapsedMs,
            DurationMs = durationMs,
        };

    internal static StemsOutcome Computing(StemsRequest request) =>
        new()
        {
            State = StemsState.Computing,
            Window = request.Window,
            WindowSec = request.WindowSec,
            RetryAfterMs = 800,
        };

    internal static StemsOutcome Busy(StemsRequest request) =>
        new()
        {
            State = StemsState.Busy,
            Window = request.Window,
            WindowSec = request.WindowSec,
            RetryAfterMs = 500,
        };

    internal static StemsOutcome ModelMissing() =>
        new() { State = StemsState.ModelMissing };

    internal static StemsOutcome Fail(StemsRequest request, string code, string message) =>
        new()
        {
            State = StemsState.Error,
            Window = request.Window,
            WindowSec = request.WindowSec,
            Code = code,
            Message = message,
        };
}

/// <summary>
/// 手写 Utf8JsonWriter 而不是反射/源生成序列化：状态体很小、字段随 state 变化，
/// 手写能保证契约里的键顺序和「只在对应 state 出现字段」。
/// </summary>
internal static class StemsJson
{
    private static readonly JsonWriterOptions Options = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        Indented = false,
        SkipValidation = false,
    };

    internal static string Serialize(StemsOutcome outcome)
    {
        var buffer = new ArrayBufferWriter<byte>(256);
        using (var writer = new Utf8JsonWriter(buffer, Options))
        {
            writer.WriteStartObject();
            writer.WriteString("state", StateName(outcome.State));
            switch (outcome.State)
            {
                case StemsState.Ready:
                    writer.WriteNumber("window", outcome.Window);
                    writer.WriteNumber("windowSec", outcome.WindowSec);
                    writer.WriteNumber("frames", outcome.Frames);
                    writer.WriteBoolean("cached", outcome.Cached);
                    writer.WriteNumber("ms", outcome.ElapsedMs);
                    break;
                case StemsState.Computing:
                case StemsState.Busy:
                    writer.WriteNumber("window", outcome.Window);
                    writer.WriteNumber("retryAfterMs", outcome.RetryAfterMs);
                    break;
                case StemsState.ModelMissing:
                    writer.WriteString("downloadUrl", StemSeparationService.ModelDownloadUrl);
                    writer.WriteString("sha256", StemSeparationService.ModelSha256);
                    break;
                default:
                    writer.WriteString("message", outcome.Message);
                    break;
            }

            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    /// <summary>/api/stems/audio 的 404 体：契约只规定状态码，这里给前端一个可解析的 JSON。</summary>
    internal static string SerializeNotReady(int window, string message)
    {
        var buffer = new ArrayBufferWriter<byte>(128);
        using (var writer = new Utf8JsonWriter(buffer, Options))
        {
            writer.WriteStartObject();
            writer.WriteString("state", "not-ready");
            writer.WriteNumber("window", window);
            writer.WriteString("message", message);
            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static string StateName(StemsState state) => state switch
    {
        StemsState.Ready => "ready",
        StemsState.Computing => "computing",
        StemsState.Busy => "busy",
        StemsState.ModelMissing => "model-missing",
        _ => "error",
    };
}

/// <summary>/api/stems/audio 的查询结果：命中缓存时给出 WAV 路径，否则只给出状态。</summary>
internal sealed class StemsAudioOutcome
{
    public required StemsState State { get; init; }

    public string Path { get; init; } = string.Empty;

    public long Frames { get; init; }

    public string Code { get; init; } = string.Empty;

    public string Message { get; init; } = string.Empty;
}

/// <summary>缓存目录里的 meta.json（契约 §3.3）；字段名与契约一一对应。</summary>
internal sealed class StemsMeta
{
    public required string TrackKey { get; init; }

    public required string Source { get; init; }

    public required string Title { get; init; }

    public required long DurationMs { get; init; }

    public required int SegmentMs { get; init; }

    public required string ModelSha256 { get; init; }

    public required DateTime CreatedUtc { get; init; }
}

internal static class StemsMetaJson
{
    internal const string FileName = "meta.json";

    private static readonly JsonWriterOptions Options = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        Indented = true,
    };

    internal static bool TryRead(string path, out StemsMeta? meta)
    {
        meta = null;
        try
        {
            if (!File.Exists(path))
            {
                return false;
            }

            using var document = JsonDocument.Parse(File.ReadAllText(path, Encoding.UTF8));
            var root = document.RootElement;
            var trackKey = ReadString(root, "trackKey");
            var modelSha256 = ReadString(root, "modelSha256");
            if (trackKey.Length == 0 || modelSha256.Length == 0)
            {
                return false;
            }

            meta = new StemsMeta
            {
                TrackKey = trackKey,
                Source = ReadString(root, "source"),
                Title = ReadString(root, "title"),
                DurationMs = ReadInt64(root, "durationMs"),
                SegmentMs = (int)ReadInt64(root, "segmentMs"),
                ModelSha256 = modelSha256,
                CreatedUtc = DateTime.TryParse(
                    ReadString(root, "createdUtc"),
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.RoundtripKind,
                    out var created)
                    ? created
                    : DateTime.MinValue,
            };
            return true;
        }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException)
        {
            HostLog.Warn($"stems.meta-read-failed {Path.GetFileName(Path.GetDirectoryName(path))}: {exception.Message}");
            return false;
        }
    }

    internal static void Write(string path, StemsMeta meta)
    {
        var temp = path + ".tmp";
        var buffer = new ArrayBufferWriter<byte>(256);
        using (var writer = new Utf8JsonWriter(buffer, Options))
        {
            writer.WriteStartObject();
            writer.WriteString("trackKey", meta.TrackKey);
            writer.WriteString("source", meta.Source);
            writer.WriteString("title", meta.Title);
            writer.WriteNumber("durationMs", meta.DurationMs);
            writer.WriteNumber("segmentMs", meta.SegmentMs);
            writer.WriteString("modelSha256", meta.ModelSha256);
            writer.WriteString("createdUtc", meta.CreatedUtc.ToString("O", CultureInfo.InvariantCulture));
            writer.WriteEndObject();
        }

        File.WriteAllBytes(temp, buffer.WrittenSpan.ToArray());
        File.Move(temp, path, overwrite: true);
    }

    private static string ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static long ReadInt64(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number &&
        value.TryGetInt64(out var number)
            ? number
            : 0;
}
