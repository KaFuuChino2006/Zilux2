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

    /// <summary>模型没随包发布：宿主正在按需下载，前端继续轮询即可。</summary>
    ModelDownloading,
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

    /// <summary>
    /// 请求的分离轨数：2 = vocals/instrumental（契约默认），4 = drums/bass/other/vocals。
    /// 4 轨供进阶智能过渡的 stem swap 使用；两种模式文件名不同，互不覆盖。
    /// </summary>
    public int Stems { get; init; } = 2;

    /// <summary>是否要 4 轨结果（drums/bass/other 会额外落盘）。</summary>
    public bool FourStem => Stems >= 4;

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

    /// <summary>本次请求的轨数：2 = 只有 vocals/inst（历史行为），4 = 额外落 drums/bass/other。</summary>
    public int Stems { get; init; } = 2;

    public long Frames { get; init; }

    public bool Cached { get; init; }

    public long ElapsedMs { get; init; }

    public int RetryAfterMs { get; init; }

    public string Message { get; init; } = string.Empty;

    /// <summary>内部错误码，只用来选 HTTP 状态码，不进 JSON（契约 §3.1 没有 code 字段）。</summary>
    public string Code { get; init; } = string.Empty;

    public long DurationMs { get; init; }

    /// <summary>四轨残差归位后的重建误差（dBFS）；2 轨或旧缓存为 NaN。</summary>
    public double ReconErrorDbfs { get; set; } = double.NaN;

    /// <summary>按需下载模型时的进度（0~1）；其余状态为 0。</summary>
    public double Progress { get; init; }

    public long DownloadedBytes { get; init; }

    public long TotalBytes { get; init; }

    internal static StemsOutcome Ready(StemsRequest request, long frames, bool cached, long elapsedMs, long durationMs) =>
        new()
        {
            State = StemsState.Ready,
            Window = request.Window,
            WindowSec = request.WindowSec,
            Stems = request.Stems,
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
            Stems = request.Stems,
            RetryAfterMs = 800,
        };

    internal static StemsOutcome Busy(StemsRequest request) =>
        new()
        {
            State = StemsState.Busy,
            Window = request.Window,
            WindowSec = request.WindowSec,
            Stems = request.Stems,
            RetryAfterMs = 500,
        };

    internal static StemsOutcome ModelMissing(StemsRequest? request = null) =>
        new() { State = StemsState.ModelMissing, Stems = request?.Stems ?? 2 };

    internal static StemsOutcome ModelDownloading(StemsRequest? request, StemModelStatus status)
    {
        var total = status.TotalBytes > 0 ? status.TotalBytes : 0;
        var progress = total > 0 ? Math.Clamp((double)status.Bytes / total, 0, 1) : 0;
        return new()
        {
            State = StemsState.ModelDownloading,
            Stems = request?.Stems ?? 2,
            RetryAfterMs = 700,
            Progress = progress,
            DownloadedBytes = status.Bytes,
            TotalBytes = total,
        };
    }

    internal static StemsOutcome Fail(StemsRequest request, string code, string message) =>
        new()
        {
            State = StemsState.Error,
            Window = request.Window,
            WindowSec = request.WindowSec,
            Stems = request.Stems,
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
            // 契约 §3.1 新增：2 = 旧两轨，4 = drums/bass/other/vocals。旧客户端忽略该键即可。
            writer.WriteNumber("stems", outcome.Stems);
            switch (outcome.State)
            {
                case StemsState.Ready:
                    writer.WriteNumber("window", outcome.Window);
                    writer.WriteNumber("windowSec", outcome.WindowSec);
                    writer.WriteNumber("frames", outcome.Frames);
                    if (!double.IsNaN(outcome.ReconErrorDbfs))
                    {
                        writer.WriteNumber("reconErrorDbfs", Math.Round(outcome.ReconErrorDbfs, 2));
                    }
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
                case StemsState.ModelDownloading:
                    writer.WriteNumber("retryAfterMs", outcome.RetryAfterMs);
                    writer.WriteNumber("progress", Math.Round(outcome.Progress, 4));
                    writer.WriteNumber("bytes", outcome.DownloadedBytes);
                    writer.WriteNumber("total", outcome.TotalBytes);
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
        StemsState.ModelDownloading => "model-downloading",
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

    /// <summary>这份缓存落了几轨：2 = 旧版（vocals + inst），4 = 额外有 drums/bass/other。</summary>
    public int Stems { get; init; } = 2;

    /// <summary>
    /// 残差归位后的浮点四轨重建误差（dBFS，越小越好）。归位之后「四轨之和 == 原音」
    /// 仅受浮点舍入影响；旧缓存未标明测量阶段时为 NaN。
    /// </summary>
    public double ReconErrorDbfs { get; init; } = double.NaN;

    /// <summary>
    /// 源文件身份（T2-7）：落盘时本地源文件的字节数与修改时间（UTC）。
    /// 同名文件被重导出/替换后 trackKey 不变，读缓存必须靠这两个值判断是否已过期。
    /// 在线曲目是临时下载文件、没有稳定身份，保持 0 / null；旧 meta 缺这两个键，读侧按未命中重算。
    /// </summary>
    public long SourceBytes { get; init; }

    public DateTime? SourceModifiedUtc { get; init; }

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
                // 旧版 meta 没有 stems 键：ReadInt64 返回 0，这里按 2 处理（T2-4 的读侧容错）。
                Stems = ReadInt64(root, "stems") >= 4 ? 4 : 2,
                ReconErrorDbfs = root.TryGetProperty("reconStage", out var stage) && stage.ValueKind == JsonValueKind.String && stage.GetString() == "folded" && root.TryGetProperty("reconErrorDbfs", out var recon) && recon.ValueKind == JsonValueKind.Number
                    ? recon.GetDouble()
                    : double.NaN,
                // 旧 meta 没有这两个键：bytes=0 / 时间=null，读侧据此判未命中并重算一次（T2-7）。
                SourceBytes = ReadInt64(root, "sourceBytes"),
                SourceModifiedUtc = DateTime.TryParse(
                    ReadString(root, "sourceModifiedUtc"),
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.RoundtripKind,
                    out var sourceModified)
                    ? sourceModified
                    : null,
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
        var buffer = new ArrayBufferWriter<byte>(256);
        using (var writer = new Utf8JsonWriter(buffer, Options))
        {
            writer.WriteStartObject();
            writer.WriteString("trackKey", meta.TrackKey);
            writer.WriteString("source", meta.Source);
            writer.WriteString("title", meta.Title);
            writer.WriteNumber("durationMs", meta.DurationMs);
            writer.WriteNumber("segmentMs", meta.SegmentMs);
            writer.WriteNumber("stems", meta.Stems);
            if (!double.IsNaN(meta.ReconErrorDbfs))
            {
                writer.WriteString("reconStage", "folded");
                writer.WriteNumber("reconErrorDbfs", Math.Round(meta.ReconErrorDbfs, 2));
            }

            writer.WriteString("modelSha256", meta.ModelSha256);
            writer.WriteString("createdUtc", meta.CreatedUtc.ToString("O", CultureInfo.InvariantCulture));
            // 源文件身份：读缓存时与磁盘上的 FileInfo 比对，不一致就重算（T2-7）。
            writer.WriteNumber("sourceBytes", meta.SourceBytes);
            if (meta.SourceModifiedUtc is { } sourceModifiedUtc)
            {
                writer.WriteString(
                    "sourceModifiedUtc",
                    sourceModifiedUtc.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
            }
            writer.WriteEndObject();
        }

        Zilux2.Storage.AtomicFile.WriteAllBytes(path, buffer.WrittenSpan.ToArray());
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
