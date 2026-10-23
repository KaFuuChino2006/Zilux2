using System.Text.Json.Serialization;

namespace Zilux2.Online;

// Unified track model shared by both providers (contract docs/zilux2-online-music.md §3).
// Records so the server can rewrite the cover URL after the provider has resolved the raw key.
internal sealed record OnlineTrack
{
    [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;

    [JsonPropertyName("artist")] public string Artist { get; init; } = string.Empty;

    [JsonPropertyName("album")] public string Album { get; init; } = string.Empty;

    [JsonPropertyName("durationMs")] public long DurationMs { get; init; }

    [JsonPropertyName("cover")] public string Cover { get; init; } = string.Empty;

    [JsonPropertyName("playable")] public bool Playable { get; init; }

    // 是否需要 VIP / 购买才能播放（上游 fee / pay_play 推导）；null = 上游未给出。
    [JsonPropertyName("vip")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Vip { get; init; }

    // §7.3 asks QQ search results to expose the songmid as "mid"; netease leaves it unset.
    [JsonPropertyName("mid")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Mid { get; init; }

    // 发现页（research/discover-api.md）需要点歌手名/专辑名跳转，这里带上上游 id；没有则为 null。
    [JsonPropertyName("artistId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ArtistId { get; init; }

    [JsonPropertyName("albumId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? AlbumId { get; init; }

    // Raw upstream cover reference (netease picUrl / QQ album.mid); never leaves the host.
    [JsonIgnore] public string? CoverKey { get; init; }
}

internal sealed class HealthResponse
{
    [JsonPropertyName("ok")] public bool Ok { get; init; } = true;

    [JsonPropertyName("version")] public int Version { get; init; } = 1;

    [JsonPropertyName("sources")] public List<string> Sources { get; init; } = [];
}

internal sealed class SearchResponse
{
    [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

    [JsonPropertyName("query")] public string Query { get; init; } = string.Empty;

    [JsonPropertyName("tracks")] public List<OnlineTrack> Tracks { get; init; } = [];

    [JsonPropertyName("tookMs")] public long TookMs { get; init; }
}

internal sealed class LyricResponse
{
    [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("lrc")] public string Lrc { get; init; } = string.Empty;

    // Contract §5 shows "translation": null explicitly, so nulls must be written here.
    [JsonPropertyName("translation")] public string? Translation { get; init; }

    [JsonPropertyName("hasTranslation")] public bool HasTranslation { get; init; }

    // 逐字歌词原文（可选）：网易云 yrc / QQ qrc；没有逐字数据时为 null
    [JsonPropertyName("yrc")] public string? Yrc { get; init; }

    [JsonPropertyName("hasYrc")] public bool HasYrc { get; init; }

    // QQ QRC 加密十六进制（可选）：前端解密后得到逐字时间轴
    [JsonPropertyName("qrc")] public string? Qrc { get; init; }

    [JsonPropertyName("hasQrc")] public bool HasQrc { get; init; }
}

internal sealed class ErrorResponse
{
    [JsonPropertyName("error")] public string Error { get; init; } = "bad-request";

    [JsonPropertyName("message")] public string Message { get; init; } = string.Empty;
}

internal sealed class OnlineEventPayload
{
    [JsonPropertyName("port")] public int Port { get; init; }

    [JsonPropertyName("token")] public string Token { get; init; } = string.Empty;

    [JsonPropertyName("sources")] public List<string> Sources { get; init; } = [];
}

// The host→page envelope from contract §3.4 with event="online" (docs/zilux2-online-music.md §6).
internal sealed class HostOnlineMessage
{
    [JsonPropertyName("v")] public int V { get; init; } = 1;

    [JsonPropertyName("type")] public string Type { get; init; } = "host";

    [JsonPropertyName("event")] public string Event { get; init; } = "online";

    [JsonPropertyName("payload")] public OnlineEventPayload Payload { get; init; } = new();
}

internal sealed class FontsEventPayload
{
    [JsonPropertyName("families")] public List<string> Families { get; init; } = [];
}

internal sealed class HostFontsMessage
{
    [JsonPropertyName("v")] public int V { get; init; } = 1;

    [JsonPropertyName("type")] public string Type { get; init; } = "host";

    [JsonPropertyName("event")] public string Event { get; init; } = "fonts";

    [JsonPropertyName("payload")] public FontsEventPayload Payload { get; init; } = new();
}

[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(FontsEventPayload))]
[JsonSerializable(typeof(HostFontsMessage))]
[JsonSerializable(typeof(HealthResponse))]
[JsonSerializable(typeof(SearchResponse))]
[JsonSerializable(typeof(LyricResponse))]
[JsonSerializable(typeof(ErrorResponse))]
[JsonSerializable(typeof(OnlineEventPayload))]
[JsonSerializable(typeof(HostOnlineMessage))]
[JsonSerializable(typeof(DownloadListResponse))]
[JsonSerializable(typeof(DownloadStartResponse))]
internal sealed partial class OnlineJsonContext : JsonSerializerContext
{
}
