using System.Text.Json.Serialization;

namespace Zilux2.Online.Discover;

// §7.4 发现页接口（research/discover-api.md v1）：与 /api/library/* 并列的一组只读接口，
// 全部把上游返回的封面 key 交给宿主重写为回环 /api/cover URL，页面侧不直连上游。

internal sealed record DiscoverChart
{
    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;

    [JsonPropertyName("cover")] public string Cover { get; init; } = string.Empty;

    [JsonPropertyName("count")] public long Count { get; init; }

    [JsonPropertyName("updateFrequency")] public string UpdateFrequency { get; init; } = string.Empty;
}

internal sealed record DiscoverChartCategory
{
    [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;

    [JsonPropertyName("charts")] public List<DiscoverChart> Charts { get; init; } = [];
}

internal sealed record DiscoverGroup
{
    [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

    [JsonPropertyName("label")] public string Label { get; init; } = string.Empty;

    [JsonPropertyName("categories")] public List<DiscoverChartCategory> Categories { get; init; } = [];
}

internal sealed record DiscoverChartsResponse
{
    [JsonPropertyName("groups")] public List<DiscoverGroup> Groups { get; init; } = [];
}

internal sealed record DiscoverChartResponse
{
    [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;

    [JsonPropertyName("cover")] public string Cover { get; init; } = string.Empty;

    [JsonPropertyName("count")] public long Count { get; init; }

    [JsonPropertyName("tracks")] public List<OnlineTrack> Tracks { get; init; } = [];

    [JsonPropertyName("hasMore")] public bool HasMore { get; init; }
}

internal sealed record DiscoverCat
{
    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
}

internal sealed record DiscoverCatsResponse
{
    [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

    [JsonPropertyName("categories")] public List<DiscoverCat> Categories { get; init; } = [];
}

internal sealed record PlaylistCard
{
    [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;

    [JsonPropertyName("cover")] public string Cover { get; init; } = string.Empty;

    [JsonPropertyName("count")] public long Count { get; init; }

    [JsonPropertyName("creator")] public string Creator { get; init; } = string.Empty;
}

internal sealed record DiscoverPlaylistsResponse
{
    [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

    [JsonPropertyName("cat")] public string Cat { get; init; } = string.Empty;

    [JsonPropertyName("playlists")] public List<PlaylistCard> Playlists { get; init; } = [];

    [JsonPropertyName("hasMore")] public bool HasMore { get; init; }
}

internal sealed record DiscoverRadioResponse
{
    [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

    [JsonPropertyName("tracks")] public List<OnlineTrack> Tracks { get; init; } = [];
}

internal sealed record ArtistAlbum
{
    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;

    [JsonPropertyName("cover")] public string Cover { get; init; } = string.Empty;

    [JsonPropertyName("year")] public int Year { get; init; }

    [JsonPropertyName("count")] public int Count { get; init; }
}

internal sealed record DiscoverArtistResponse
{
    [JsonPropertyName("source")] public string Source { get; init; } = "netease";

    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;

    [JsonPropertyName("cover")] public string Cover { get; init; } = string.Empty;

    [JsonPropertyName("avatar")] public string Avatar { get; init; } = string.Empty;

    [JsonPropertyName("description")] public string Description { get; init; } = string.Empty;

    [JsonPropertyName("followed")] public bool Followed { get; init; }

    [JsonPropertyName("hotSongs")] public List<OnlineTrack> HotSongs { get; init; } = [];

    [JsonPropertyName("albums")] public List<ArtistAlbum> Albums { get; init; } = [];
}

internal sealed record DiscoverAlbumResponse
{
    [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;

    [JsonPropertyName("cover")] public string Cover { get; init; } = string.Empty;

    [JsonPropertyName("artist")] public string Artist { get; init; } = string.Empty;

    [JsonPropertyName("artistId")] public string ArtistId { get; init; } = string.Empty;

    [JsonPropertyName("year")] public int Year { get; init; }

    [JsonPropertyName("description")] public string Description { get; init; } = string.Empty;

    [JsonPropertyName("tracks")] public List<OnlineTrack> Tracks { get; init; } = [];
}

internal sealed record DiscoverComment
{
    [JsonPropertyName("user")] public string User { get; init; } = string.Empty;

    [JsonPropertyName("avatar")] public string Avatar { get; init; } = string.Empty;

    [JsonPropertyName("content")] public string Content { get; init; } = string.Empty;

    [JsonPropertyName("liked")] public long Liked { get; init; }

    [JsonPropertyName("time")] public string Time { get; init; } = string.Empty;

    [JsonPropertyName("hot")] public bool Hot { get; init; }
}

internal sealed record DiscoverCommentsResponse
{
    [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("total")] public long Total { get; init; }

    [JsonPropertyName("comments")] public List<DiscoverComment> Comments { get; init; } = [];

    [JsonPropertyName("hasMore")] public bool HasMore { get; init; }
}

internal sealed record DiscoverProgram
{
    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;

    [JsonPropertyName("cover")] public string Cover { get; init; } = string.Empty;

    [JsonPropertyName("radioName")] public string RadioName { get; init; } = string.Empty;

    [JsonPropertyName("djName")] public string DjName { get; init; } = string.Empty;

    [JsonPropertyName("durationMs")] public long DurationMs { get; init; }

    [JsonPropertyName("description")] public string Description { get; init; } = string.Empty;
}

internal sealed record DiscoverPodcastsResponse
{
    [JsonPropertyName("source")] public string Source { get; init; } = "netease";

    [JsonPropertyName("programs")] public List<DiscoverProgram> Programs { get; init; } = [];
}

internal sealed record CollectionItem
{
    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;

    [JsonPropertyName("cover")] public string Cover { get; init; } = string.Empty;

    [JsonPropertyName("subtitle")] public string Subtitle { get; init; } = string.Empty;
}

internal sealed record DiscoverCollectionsResponse
{
    [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

    [JsonPropertyName("kind")] public string Kind { get; init; } = string.Empty;

    [JsonPropertyName("hasMore")] public bool HasMore { get; init; }

    [JsonPropertyName("items")] public List<CollectionItem> Items { get; init; } = [];
}


internal sealed record DiscoverSongArtist
{
    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
}

internal sealed record DiscoverSongQuality
{
    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;

    [JsonPropertyName("sizeBytes")] public long SizeBytes { get; init; }
}

internal sealed record DiscoverSongResponse
{
    [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;

    [JsonPropertyName("artist")] public string Artist { get; init; } = string.Empty;

    [JsonPropertyName("artistId")] public string? ArtistId { get; init; }

    [JsonPropertyName("artists")] public List<DiscoverSongArtist> Artists { get; init; } = [];

    [JsonPropertyName("album")] public string Album { get; init; } = string.Empty;

    [JsonPropertyName("albumId")] public string? AlbumId { get; init; }

    [JsonPropertyName("cover")] public string Cover { get; init; } = string.Empty;

    [JsonPropertyName("durationMs")] public long DurationMs { get; init; }

    [JsonPropertyName("releaseDate")] public string ReleaseDate { get; init; } = string.Empty;

    [JsonPropertyName("vip")] public bool Vip { get; init; }

    [JsonPropertyName("playable")] public bool Playable { get; init; }

    [JsonPropertyName("trackNo")] public int TrackNo { get; init; }

    [JsonPropertyName("discNo")] public int DiscNo { get; init; }

    [JsonPropertyName("language")] public string Language { get; init; } = string.Empty;

    [JsonPropertyName("genre")] public string Genre { get; init; } = string.Empty;

    [JsonPropertyName("qualities")] public List<DiscoverSongQuality> Qualities { get; init; } = [];

    [JsonPropertyName("sourceUrl")] public string SourceUrl { get; init; } = string.Empty;
}

// 服务端可预期的失败（缺登录 / 上游不支持 / 参数错误），携带要回给页面的状态码与错误码。
internal sealed class DiscoverException : Exception
{
    public DiscoverException(int status, string code, string message) : base(message)
    {
        Status = status;
        Code = code;
    }

    public int Status { get; }

    public string Code { get; }
}

[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(DiscoverChartsResponse))]
[JsonSerializable(typeof(DiscoverChartResponse))]
[JsonSerializable(typeof(DiscoverCatsResponse))]
[JsonSerializable(typeof(DiscoverPlaylistsResponse))]
[JsonSerializable(typeof(DiscoverRadioResponse))]
[JsonSerializable(typeof(DiscoverArtistResponse))]
[JsonSerializable(typeof(DiscoverAlbumResponse))]
[JsonSerializable(typeof(DiscoverCommentsResponse))]
[JsonSerializable(typeof(DiscoverPodcastsResponse))]
[JsonSerializable(typeof(DiscoverCollectionsResponse))]
[JsonSerializable(typeof(DiscoverSongResponse))]
internal sealed partial class DiscoverJsonContext : JsonSerializerContext
{
}
