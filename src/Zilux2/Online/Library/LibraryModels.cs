using System.Text.Json.Serialization;

namespace Zilux2.Online.Library;

// Contract docs/zilux2-library.md §2. Providers fill the raw CoverKey; LibraryService and the
// server rewrite it into a loopback /api/cover URL so platform image hosts never leak to the page.
internal sealed record LibraryPlaylist
{
    [JsonPropertyName("source")]
    public string Source { get; init; } = string.Empty;

    [JsonPropertyName("id")]
    public string Id { get; init; } = string.Empty;

    [JsonPropertyName("title")]
    public string Title { get; init; } = string.Empty;

    [JsonPropertyName("cover")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Cover { get; init; }

    [JsonPropertyName("count")]
    public int Count { get; init; }

    // "liked" marks the special 我喜欢的音乐 card; everything else is null.
    [JsonPropertyName("special")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Special { get; init; }

    [JsonPropertyName("creator")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Creator { get; init; }

    [JsonIgnore]
    public string? CoverKey { get; init; }
}

// One source's overview. Liked is written as an explicit null when logged in but the platform
// exposes no 我喜欢 playlist (contract §1 shows "liked": null for an empty source).
internal sealed class LibrarySourceState
{
    [JsonPropertyName("source")]
    public string Source { get; init; } = string.Empty;

    [JsonPropertyName("loggedIn")]
    public bool LoggedIn { get; init; }

    [JsonPropertyName("nickname")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Nickname { get; init; }

    [JsonPropertyName("avatarDataUrl")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? AvatarDataUrl { get; init; }

    [JsonPropertyName("liked")]
    public LibraryPlaylist? Liked { get; init; }

    [JsonPropertyName("playlists")]
    public List<LibraryPlaylist> Playlists { get; init; } = [];

    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; init; }
}

internal sealed class LibraryOverview
{
    [JsonPropertyName("sources")]
    public List<LibrarySourceState> Sources { get; init; } = [];
}

internal sealed class PlaylistDetail
{
    [JsonPropertyName("source")]
    public string Source { get; init; } = string.Empty;

    [JsonPropertyName("id")]
    public string Id { get; init; } = string.Empty;

    [JsonPropertyName("title")]
    public string Title { get; init; } = string.Empty;

    [JsonPropertyName("cover")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Cover { get; init; }

    [JsonPropertyName("count")]
    public int Count { get; init; }

    [JsonPropertyName("tracks")]
    public List<OnlineTrack> Tracks { get; init; } = [];

    [JsonPropertyName("hasMore")]
    public bool HasMore { get; init; }
}

// The page only reads {ok?: boolean} (web/src/library.ts refreshLibrary), keep it minimal.
internal sealed class LibraryRefreshResponse
{
    [JsonPropertyName("ok")]
    public bool Ok { get; init; } = true;
}

// Raw provider output: same shapes as the wire models, but covers are still platform keys.
internal sealed record LibrarySnapshot(LibraryPlaylist? Liked, List<LibraryPlaylist> Playlists);

internal sealed record LibraryDetail(LibraryPlaylist Meta, List<OnlineTrack> Tracks, bool HasMore);

// 最近播放 / 每日推荐（发现面板）的原始数据；封面仍是平台 key，由服务端改写成回环 URL。
internal sealed record LibraryFeed(string Source, string Kind, List<OnlineTrack> Tracks);

[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(LibraryOverview))]
[JsonSerializable(typeof(LibraryPlaylist))]
[JsonSerializable(typeof(PlaylistDetail))]
[JsonSerializable(typeof(LibraryRefreshResponse))]
internal sealed partial class LibraryJsonContext : JsonSerializerContext
{
}
