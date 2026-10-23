using System.Text.Json.Serialization;

namespace Zilux2.Online;

// 多平台扩展点（新增音乐 App 时改这里，不用到处写死平台名）：
//   1) 在 MusicSourceCatalog.All 里登记一条描述（id / 显示名 / 主色 / 登录模式 / 能力）；
//   2) 实现 IOnlineMusicProvider 并在 OnlineMusicService 的 provider 列表里注册；
//   3) 需要扫码登录的话实现 IAccountProvider（见 Account/ 目录）并登记；
//   4) 页面不需要改：登录卡片、搜索分段、默认音源下拉都按 GET /api/sources 动态渲染。
internal sealed class MusicSourceDescriptor
{
    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;

    [JsonPropertyName("label")] public string Label { get; init; } = string.Empty;

    // 源标识（头像占位、平台角标用的单字）
    [JsonPropertyName("short")] public string Short { get; init; } = string.Empty;

    // 平台主色，页面用它在登录卡/角标上做渐变
    [JsonPropertyName("accent")] public string Accent { get; init; } = "#d9c08d";

    // code = 平台内扫码后轮询状态；image = 直接展示一张二维码图片（QQ 账号体系）
    [JsonPropertyName("loginMode")] public string LoginMode { get; init; } = "image";

    [JsonPropertyName("loginHint")] public string LoginHint { get; init; } = string.Empty;

    // 发现页可拉的榜单：recent / daily
    [JsonPropertyName("feedKinds")] public List<string> FeedKinds { get; init; } = [];

    // 是否提供逐字（词级）歌词，页面据此决定是否走逐字渲染
    [JsonPropertyName("supportsWordLyrics")] public bool SupportsWordLyrics { get; init; }

    // 是否支持写入「喜欢」；不支持时页面隐藏红心
    [JsonPropertyName("supportsLikedWrite")] public bool SupportsLikedWrite { get; init; }

    // 是否有「每日 30 首」入口
    [JsonPropertyName("hasDaily30")] public bool HasDaily30 { get; init; }

    // 隐藏平台：只在「歌词搜索/匹配」里出现，不参与播放、登录、收藏、推荐
    [JsonPropertyName("hidden")] public bool Hidden { get; init; }

    // 实验平台：默认不在任何页面出现，用户在「设置 → 实验功能」里显式开启后才可见。
    [JsonPropertyName("experimental")] public bool Experimental { get; init; }

    // 可选音质；页面按当前播放平台动态渲染（最多一项表示不支持切换）
    [JsonPropertyName("qualities")] public List<SourceQuality> Qualities { get; init; } = [];
}

// 一个平台的音质选项：id 与 /api/stream?quality= 的取值一致
internal sealed class SourceQuality
{
    [JsonPropertyName("id")] public string Id { get; init; } = "high";

    [JsonPropertyName("label")] public string Label { get; init; } = string.Empty;

    [JsonPropertyName("detail")] public string Detail { get; init; } = string.Empty;
}

internal sealed class MusicSourceListResponse
{
    [JsonPropertyName("sources")] public List<MusicSourceDescriptor> Sources { get; init; } = [];
}

[JsonSourceGenerationOptions(WriteIndented = false)]
[JsonSerializable(typeof(MusicSourceListResponse))]
internal sealed partial class MusicSourceJsonContext : JsonSerializerContext
{
}

internal static class MusicSourceCatalog
{
    public const string Netease = "netease";
    public const string Qq = "qq";
    public const string Kugou = "kugou";
    public const string Mvmp3 = "mvmp3";

    public static readonly IReadOnlyList<MusicSourceDescriptor> All =
    [
        new MusicSourceDescriptor
        {
            Id = Netease,
            Label = "网易云音乐",
            Short = "网",
            Accent = "#ff5a5f",
            LoginMode = "code",
            LoginHint = "在网易云 App 扫码后确认登录",
            FeedKinds = ["recent", "daily"],
            SupportsWordLyrics = true,
            SupportsLikedWrite = true,
            HasDaily30 = false,
            Qualities =
            [
                new SourceQuality { Id = "standard", Label = "标准", Detail = "128 kbps · MP3" },
                new SourceQuality { Id = "high", Label = "极高", Detail = "320 kbps · MP3" },
                new SourceQuality { Id = "lossless", Label = "无损", Detail = "FLAC · 需会员" },
            ],
        },
        new MusicSourceDescriptor
        {
            Id = Qq,
            Label = "QQ 音乐",
            Short = "Q",
            Accent = "#31c27c",
            LoginMode = "image",
            LoginHint = "打开手机 QQ 扫一扫，用 QQ 账号登录",
            FeedKinds = ["recent", "daily"],
            SupportsWordLyrics = true,
            SupportsLikedWrite = true,
            HasDaily30 = true,
            Qualities =
            [
                new SourceQuality { Id = "standard", Label = "标准", Detail = "128 kbps · MP3" },
                new SourceQuality { Id = "high", Label = "高", Detail = "320 kbps · MP3" },
                new SourceQuality { Id = "lossless", Label = "无损", Detail = "FLAC · 需会员" },
            ],
        },
        new MusicSourceDescriptor
        {
            Id = Kugou,
            Label = "酷狗音乐",
            Short = "酷",
            Accent = "#2fb0ff",
            // 酷狗只当歌词来源：不做登录 / 播放 / 收藏。
            Hidden = true,
            LoginMode = "",
            LoginHint = "仅用于歌词搜索",
            FeedKinds = [],
            // KRC 逐字歌词可解密，前端能逐字点亮
            SupportsWordLyrics = true,
            SupportsLikedWrite = false,
            HasDaily30 = false,
            Qualities = [],
        },
        new MusicSourceDescriptor
        {
            Id = Mvmp3,
            Label = "无名音乐",
            Short = "无",
            Accent = "#7c5cff",
            // 实验来源：第三方聚合试听站（mvmp3.com），默认隐藏，需要在设置里手动开启。
            Experimental = true,
            Hidden = false,
            LoginMode = "",
            LoginHint = "实验来源，无需登录",
            FeedKinds = [],
            SupportsWordLyrics = false,
            SupportsLikedWrite = false,
            HasDaily30 = false,
            Qualities =
            [
                new SourceQuality { Id = "high", Label = "高", Detail = "320 kbps · MP3" },
            ],
        },
    ];

    public static MusicSourceDescriptor? Find(string source) =>
        All.FirstOrDefault(item => string.Equals(item.Id, source, StringComparison.OrdinalIgnoreCase));

    public static bool IsKnown(string source) => Find(source) is not null;

    public static string Normalize(string source) => Find(source)?.Id ?? source.Trim().ToLowerInvariant();
}
