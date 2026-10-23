# -*- coding: utf-8 -*-
"""宿主侧：网易云歌词接口增加逐字歌词（yrc），/api/lyric 返回 yrc 字段。"""
import io


def patch_file(path, pairs):
    s = io.open(path, 'r', encoding='utf-8', newline='').read()
    for old, new, label in pairs:
        assert s.count(old) == 1, f"anchor miss {label}: {old[:70]!r}"
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print('patched', path)


BASE = r"E:\Zilux2开发\src\Zilux2\Online"

patch_file(
    BASE + r"\IOnlineMusicProvider.cs",
    [(
        "internal sealed class LyricData\n{\n    public string Lrc { get; init; } = string.Empty;\n\n    public string? Translation { get; init; }\n}",
        "internal sealed class LyricData\n{\n    public string Lrc { get; init; } = string.Empty;\n\n    public string? Translation { get; init; }\n\n    // 逐字歌词原文（网易云 yrc / QQ qrc，格式 `[start,dur](start,dur)字…`），前端自行解析\n    public string? Yrc { get; init; }\n}",
        "LyricData.Yrc",
    )],
)

patch_file(
    BASE + r"\NeteaseProvider.cs",
    [
        (
            'var url = $"{LyricEndpoint}?id={Uri.EscapeDataString(id)}&lv=-1&kv=-1&tv=-1";',
            'var url = $"{LyricEndpoint}?id={Uri.EscapeDataString(id)}&lv=-1&kv=-1&tv=-1&yv=-1&rv=-1";',
            "lyric url yv",
        ),
        (
            """            var translation = root.TryGetProperty("tlyric", out var translationElement) && translationElement.ValueKind == JsonValueKind.Object
                ? ReadString(translationElement, "lyric")
                : string.Empty;
            OnlineHttp.Info($"GET netease/lyric id={id} ok lrcChars={lrc.Length} {upstream.TookMs}ms");
            return new LyricData { Lrc = lrc, Translation = string.IsNullOrWhiteSpace(translation) ? null : translation };""",
            """            var translation = root.TryGetProperty("tlyric", out var translationElement) && translationElement.ValueKind == JsonValueKind.Object
                ? ReadString(translationElement, "lyric")
                : string.Empty;
            var yrc = root.TryGetProperty("yrc", out var yrcElement) && yrcElement.ValueKind == JsonValueKind.Object
                ? ReadString(yrcElement, "lyric")
                : string.Empty;
            OnlineHttp.Info($"GET netease/lyric id={id} ok lrcChars={lrc.Length} yrcChars={yrc.Length} {upstream.TookMs}ms");
            return new LyricData
            {
                Lrc = lrc,
                Translation = string.IsNullOrWhiteSpace(translation) ? null : translation,
                Yrc = string.IsNullOrWhiteSpace(yrc) ? null : yrc,
            };""",
            "netease yrc parse",
        ),
    ],
)

patch_file(
    BASE + r"\OnlineMusicModels.cs",
    [(
        '    [JsonPropertyName("hasTranslation")] public bool HasTranslation { get; init; }\n}',
        '    [JsonPropertyName("hasTranslation")] public bool HasTranslation { get; init; }\n\n    // 逐字歌词原文（可选）：网易云 yrc / QQ qrc；没有逐字数据时为 null\n    [JsonPropertyName("yrc")] public string? Yrc { get; init; }\n\n    [JsonPropertyName("hasYrc")] public bool HasYrc { get; init; }\n}',
        "LyricResponse.Yrc",
    )],
)

patch_file(
    BASE + r"\LocalMusicServer.cs",
    [(
        """                Lrc = lyric.Lrc,
                Translation = lyric.Translation,
                HasTranslation = !string.IsNullOrWhiteSpace(lyric.Translation),""",
        """                Lrc = lyric.Lrc,
                Translation = lyric.Translation,
                HasTranslation = !string.IsNullOrWhiteSpace(lyric.Translation),
                Yrc = lyric.Yrc,
                HasYrc = !string.IsNullOrWhiteSpace(lyric.Yrc),""",
        "server lyric response",
    )],
)
print('host yrc patch done')
