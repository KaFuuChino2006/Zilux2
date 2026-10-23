# -*- coding: utf-8 -*-
"""宿主改动：搜索结果带 VIP 标记；批量查询收藏状态；取消收藏接口。"""
import io

ROOT = r"E:\Zilux2开发\src\Zilux2\Online"


def load(path):
    with io.open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def save(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def apply(path, label, edits):
    text = load(path)
    E = "\r\n" if "\r\n" in text else "\n"
    for old, new in edits:
        o, n = old.replace("\n", E), new.replace("\n", E)
        assert text.count(o) == 1, f"{label}: {old.splitlines()[0][:60]} -> {text.count(o)}"
        text = text.replace(o, n)
    save(path, text)
    print(label, "OK")


# ---------------------------------------------------------------- 1) 曲目 DTO 增加 vip
apply(
    ROOT + r"\OnlineMusicModels.cs",
    "OnlineMusicModels.cs",
    [
        (
            '    [JsonPropertyName("playable")] public bool Playable { get; init; }',
            '    [JsonPropertyName("playable")] public bool Playable { get; init; }\n'
            "\n"
            "    // 是否需要 VIP / 购买才能播放（上游 fee / pay_play 推导）；null = 上游未给出。\n"
            '    [JsonPropertyName("vip")]\n'
            "    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]\n"
            "    public bool? Vip { get; init; }",
        ),
    ],
)

# ---------------------------------------------------------------- 2) 网易云：fee → vip
apply(
    ROOT + r"\NeteaseProvider.cs",
    "NeteaseProvider.cs",
    [
        (
            "                // Contract §3: fee 0 free, fee 8 free-but-lower-bitrate; 1/4 are VIP/purchase.\n"
            "                Playable = fee is 0 or 8,",
            "                // Contract §3: fee 0 free, fee 8 free-but-lower-bitrate; 1/4 are VIP/purchase.\n"
            "                Playable = fee is 0 or 8,\n"
            "                Vip = fee is not (0 or 8),",
        ),
    ],
)

# ---------------------------------------------------------------- 3) QQ：pay_play → vip
apply(
    ROOT + r"\QqProvider.cs",
    "QqProvider.cs",
    [
        (
            "                Playable = payPlay == 0,",
            "                Playable = payPlay == 0,\n"
            "                Vip = payPlay != 0,",
        ),
    ],
)

# ---------------------------------------------------------------- 4) 网易云收藏：批量查询 + 取消
apply(
    ROOT + r"\Library\NeteaseLibraryProvider.cs",
    "NeteaseLibraryProvider.cs",
    [
        (
            '        OnlineHttp.Info($"POST netease/library like pid={liked.Id} track={trackId} ok");\n    }\n',
            '        OnlineHttp.Info($"POST netease/library like pid={liked.Id} track={trackId} ok");\n'
            "    }\n"
            "\n"
            "    // 批量查询收藏状态：CheckLikedAsync 内部会缓存「我喜欢的音乐」trackIds，循环查询只打一次上游。\n"
            "    internal async Task<Dictionary<string, bool>> CheckLikedManyAsync(\n"
            "        IReadOnlyList<string> trackIds,\n"
            "        CancellationToken cancellationToken)\n"
            "    {\n"
            "        var result = new Dictionary<string, bool>(StringComparer.Ordinal);\n"
            "        foreach (var trackId in trackIds)\n"
            "        {\n"
            "            if (string.IsNullOrWhiteSpace(trackId) || trackId.Length > 64 || result.ContainsKey(trackId))\n"
            "            {\n"
            "                continue;\n"
            "            }\n"
            "\n"
            "            result[trackId] = await CheckLikedAsync(trackId, cancellationToken).ConfigureAwait(false);\n"
            "        }\n"
            "\n"
            "        return result;\n"
            "    }\n"
            "\n"
            "    // 「取消喜欢」：同一 manipulate/tracks 接口，op=del。\n"
            "    internal async Task RemoveLikedAsync(string trackId, CancellationToken cancellationToken)\n"
            "    {\n"
            "        if (!IsLoggedIn)\n"
            "        {\n"
            '            throw new OnlineUpstreamException("网易云尚未登录，请先登录", 401);\n'
            "        }\n"
            "\n"
            "        if (string.IsNullOrWhiteSpace(trackId) || trackId.Length > 64)\n"
            "        {\n"
            '            throw new OnlineUpstreamException("歌曲 id 参数非法", 400);\n'
            "        }\n"
            "\n"
            "        var snapshot = await GetSnapshotAsync(cancellationToken).ConfigureAwait(false);\n"
            "        var liked = snapshot?.Liked;\n"
            "        if (liked is null || liked.Id.Length == 0)\n"
            "        {\n"
            '            throw new OnlineUpstreamException("没有找到我喜欢的音乐", 404);\n'
            "        }\n"
            "\n"
            "        var url = \"https://music.163.com/api/playlist/manipulate/tracks\"\n"
            "            + $\"?op=del&pid={Uri.EscapeDataString(liked.Id)}\"\n"
            "            + $\"&trackIds=%5B{trackId}%5D&immutable=true&csrf_token=\";\n"
            "        var upstream = await OnlineHttp\n"
            "            .FetchTextAsync(url, NeteaseProvider.RefererUrl, Timeout, cancellationToken, HttpMethod.Post, cookie: Cookie)\n"
            "            .ConfigureAwait(false);\n"
            "\n"
            "        using var document = JsonDocument.Parse(upstream.Body);\n"
            "        var root = document.RootElement;\n"
            "        var code = root.TryGetProperty(\"code\", out var codeElement) && codeElement.TryGetInt32(out var codeValue) ? codeValue : 0;\n"
            "        if (code != 200 && code != 0)\n"
            "        {\n"
            "            OnlineHttp.Warn($\"POST netease/library unlike failed code={code} body={upstream.Body}\");\n"
            '            throw new OnlineUpstreamException($"网易云取消喜欢失败 code={code}", 502);\n'
            "        }\n"
            "\n"
            "        _likedTrackIds = null;\n"
            "        _likedTrackIdsAt = DateTime.MinValue;\n"
            '        OnlineHttp.Info($"POST netease/library unlike pid={liked.Id} track={trackId} ok");\n'
            "    }\n",
        ),
    ],
)

# ---------------------------------------------------------------- 5) QQ 收藏：批量查询 + 取消
apply(
    ROOT + r"\Library\QqLibraryProvider.cs",
    "QqLibraryProvider.cs",
    [
        (
            '        OnlineHttp.Info($"POST qq/library like mid={mid} songId={songId} ok");\n    }\n',
            '        OnlineHttp.Info($"POST qq/library like mid={mid} songId={songId} ok");\n'
            "    }\n"
            "\n"
            "    // 批量收藏状态：IsSongFanByMid 支持一次传多个 songmid，只打一次上游。\n"
            "    internal async Task<Dictionary<string, bool>> CheckLikedManyAsync(\n"
            "        IReadOnlyList<string> mids,\n"
            "        CancellationToken cancellationToken)\n"
            "    {\n"
            "        var result = new Dictionary<string, bool>(StringComparer.Ordinal);\n"
            "        if (_accounts?.IsLoggedIn(Name) != true)\n"
            "        {\n"
            "            return result;\n"
            "        }\n"
            "\n"
            "        var wanted = new List<string>();\n"
            "        foreach (var mid in mids)\n"
            "        {\n"
            "            if (string.IsNullOrWhiteSpace(mid) || mid.Length > 64 || result.ContainsKey(mid) || wanted.Contains(mid))\n"
            "            {\n"
            "                continue;\n"
            "            }\n"
            "\n"
            "            wanted.Add(mid);\n"
            "        }\n"
            "\n"
            "        if (wanted.Count == 0)\n"
            "        {\n"
            "            return result;\n"
            "        }\n"
            "\n"
            "        var uin = _accounts?.GetUserId(Name) ?? \"0\";\n"
            "        var songMids = new JsonArray();\n"
            "        foreach (var mid in wanted)\n"
            "        {\n"
            "            songMids.Add(mid);\n"
            "        }\n"
            "\n"
            "        var body = new JsonObject\n"
            "        {\n"
            "            [\"comm\"] = BuildComm(uin),\n"
            "            [\"req_1\"] = new JsonObject\n"
            "            {\n"
            "                [\"module\"] = \"music.musicasset.SongFavRead\",\n"
            "                [\"method\"] = \"IsSongFanByMid\",\n"
            "                [\"param\"] = new JsonObject\n"
            "                {\n"
            "                    [\"v_songMid\"] = songMids,\n"
            "                },\n"
            "            },\n"
            "        };\n"
            "\n"
            "        try\n"
            "        {\n"
            "            var root = await PostMusicuAsync(body, \"qq/library liked-many\", cancellationToken).ConfigureAwait(false);\n"
            "            var data = ReadRequestData(root);\n"
            "            if (data is { } readData && readData.TryGetProperty(\"m_fan\", out var fan) && fan.ValueKind == JsonValueKind.Object)\n"
            "            {\n"
            "                foreach (var mid in wanted)\n"
            "                {\n"
            "                    result[mid] = fan.TryGetProperty(mid, out var value) && value.ValueKind == JsonValueKind.True;\n"
            "                }\n"
            "            }\n"
            "        }\n"
            "        catch (OnlineUpstreamException error)\n"
            "        {\n"
            "            OnlineHttp.Warn($\"qq/library liked-many failed: {error.Message}\");\n"
            "        }\n"
            "\n"
            "        return result;\n"
            "    }\n"
            "\n"
            "    // 「取消喜欢」：PlaylistDetailWrite/DelSonglist(dirId=201)，与收藏同一协议族。\n"
            "    internal async Task RemoveLikedAsync(string mid, CancellationToken cancellationToken)\n"
            "    {\n"
            "        if (_accounts?.IsLoggedIn(Name) != true)\n"
            "        {\n"
            '            throw new OnlineUpstreamException("QQ 音乐尚未登录，请先登录", 401);\n'
            "        }\n"
            "\n"
            "        if (string.IsNullOrWhiteSpace(mid) || mid.Length > 64)\n"
            "        {\n"
            '            throw new OnlineUpstreamException("歌曲 mid 参数非法", 400);\n'
            "        }\n"
            "\n"
            "        var uin = _accounts?.GetUserId(Name) ?? \"0\";\n"
            "        var detailBody = new JsonObject\n"
            "        {\n"
            "            [\"comm\"] = BuildComm(uin),\n"
            "            [\"req_1\"] = new JsonObject\n"
            "            {\n"
            "                [\"module\"] = \"music.pf_song_detail_svr\",\n"
            "                [\"method\"] = \"get_song_detail_yqq\",\n"
            "                [\"param\"] = new JsonObject { [\"song_type\"] = 0, [\"song_mid\"] = mid },\n"
            "            },\n"
            "        };\n"
            "        var detailRoot = await PostMusicuAsync(detailBody, \"qq/library unlike detail\", cancellationToken).ConfigureAwait(false);\n"
            "        var detailData = ReadRequestData(detailRoot) ?? throw new OnlineUpstreamException(\"QQ 歌曲详情返回异常\", 502);\n"
            "        if (!detailData.TryGetProperty(\"track_info\", out var trackInfo) || trackInfo.ValueKind != JsonValueKind.Object)\n"
            "        {\n"
            '            throw new OnlineUpstreamException("QQ 歌曲详情返回异常", 502);\n'
            "        }\n"
            "\n"
            "        if (!long.TryParse(ReadId(trackInfo, \"id\"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var songId) || songId <= 0)\n"
            "        {\n"
            '            throw new OnlineUpstreamException("QQ 歌曲 id 解析失败", 502);\n'
            "        }\n"
            "\n"
            "        var writeBody = new JsonObject\n"
            "        {\n"
            "            [\"comm\"] = BuildComm(uin),\n"
            "            [\"req_1\"] = new JsonObject\n"
            "            {\n"
            "                [\"module\"] = \"music.musicasset.PlaylistDetailWrite\",\n"
            "                [\"method\"] = \"DelSonglist\",\n"
            "                [\"param\"] = new JsonObject\n"
            "                {\n"
            "                    [\"dirId\"] = 201,\n"
            "                    [\"v_songInfo\"] = new JsonArray\n"
            "                    {\n"
            "                        new JsonObject { [\"songId\"] = songId, [\"songType\"] = 0 },\n"
            "                    },\n"
            "                },\n"
            "            },\n"
            "        };\n"
            "        JsonElement writeRoot;\n"
            "        try\n"
            "        {\n"
            "            writeRoot = await PostMusicuAsync(writeBody, \"qq/library unlike write\", cancellationToken).ConfigureAwait(false);\n"
            "        }\n"
            "        catch (OnlineUpstreamException error) when (error.Message.Contains(\"500026\", StringComparison.Ordinal))\n"
            "        {\n"
            '            throw new OnlineUpstreamException("QQ 音乐暂不支持一键取消收藏（协议限制），请到 QQ 音乐客户端操作", 502);\n'
            "        }\n"
            "\n"
            "        var writeData = ReadRequestData(writeRoot);\n"
            "        if (writeData is { } data)\n"
            "        {\n"
            "            var retCode = ReadInt(data, \"retCode\");\n"
            "            if (retCode != 0)\n"
            "            {\n"
            "                OnlineHttp.Warn($\"POST qq/library unlike failed code={retCode} body={data.GetRawText()}\");\n"
            '                throw new OnlineUpstreamException($"QQ 音乐取消喜欢失败 code={retCode}", 502);\n'
            "            }\n"
            "        }\n"
            "\n"
            '        OnlineHttp.Info($"POST qq/library unlike mid={mid} songId={songId} ok");\n'
            "    }\n",
        ),
    ],
)

# ---------------------------------------------------------------- 6) LibraryService：批量 + 取消
apply(
    ROOT + r"\Library\LibraryService.cs",
    "LibraryService.cs",
    [
        (
            "        Refresh(source);\n    }\n",
            "        Refresh(source);\n"
            "    }\n"
            "\n"
            "    // 批量收藏状态（搜索结果一次点亮收藏按钮）：各音源内部各自合并请求。\n"
            "    public async Task<Dictionary<string, bool>> CheckLikedManyAsync(\n"
            "        string source,\n"
            "        IReadOnlyList<string> trackIds,\n"
            "        CancellationToken cancellationToken)\n"
            "    {\n"
            "        ThrowIfDisposed();\n"
            "        source = NormalizeSource(source);\n"
            "        if (_accounts?.IsLoggedIn(source) != true)\n"
            "        {\n"
            "            return new Dictionary<string, bool>(StringComparer.Ordinal);\n"
            "        }\n"
            "\n"
            "        var ids = trackIds\n"
            "            .Where(id => !string.IsNullOrWhiteSpace(id) && id.Length <= 64)\n"
            "            .Distinct(StringComparer.Ordinal)\n"
            "            .Take(60)\n"
            "            .ToArray();\n"
            "        if (ids.Length == 0)\n"
            "        {\n"
            "            return new Dictionary<string, bool>(StringComparer.Ordinal);\n"
            "        }\n"
            "\n"
            "        return source switch\n"
            "        {\n"
            "            AccountSources.Netease => await _netease.CheckLikedManyAsync(ids, cancellationToken).ConfigureAwait(false),\n"
            "            AccountSources.Qq => await _qq.CheckLikedManyAsync(ids, cancellationToken).ConfigureAwait(false),\n"
            "            _ => new Dictionary<string, bool>(StringComparer.Ordinal),\n"
            "        };\n"
            "    }\n"
            "\n"
            "    // 「取消喜欢」写入接口。\n"
            "    public async Task RemoveLikedAsync(string source, string trackId, CancellationToken cancellationToken)\n"
            "    {\n"
            "        ThrowIfDisposed();\n"
            "        source = NormalizeSource(source);\n"
            "        if (string.IsNullOrWhiteSpace(trackId))\n"
            "        {\n"
            '            throw new OnlineUpstreamException("缺少歌曲 id 参数", 400);\n'
            "        }\n"
            "\n"
            "        if (_accounts?.IsLoggedIn(source) != true)\n"
            "        {\n"
            '            throw new OnlineUpstreamException("该音源尚未登录，请先登录", 401);\n'
            "        }\n"
            "\n"
            "        switch (source)\n"
            "        {\n"
            "            case AccountSources.Netease:\n"
            "                await _netease.RemoveLikedAsync(trackId, cancellationToken).ConfigureAwait(false);\n"
            "                break;\n"
            "            case AccountSources.Qq:\n"
            "                await _qq.RemoveLikedAsync(trackId, cancellationToken).ConfigureAwait(false);\n"
            "                break;\n"
            "            default:\n"
            "                throw new OnlineUpstreamException(\"未知音源\", 400);\n"
            "        }\n"
            "\n"
            "        Refresh(source);\n"
            "    }\n",
        ),
    ],
)
