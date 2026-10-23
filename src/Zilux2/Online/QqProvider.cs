using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Zilux2.Online.Account;

namespace Zilux2.Online;

internal sealed class QqProvider : IOnlineMusicProvider
{
    internal const string RefererUrl = "https://y.qq.com/";
    private const string SearchEndpoint = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
    // Lead-approved fallback (2026-10-18): the desktop endpoint intermittently answers empty 500s
    // to anonymous clients while the QQ-client endpoint serves the same catalog.
    private const string FallbackSearchEndpoint = "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp";
    private const string LyricEndpoint = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg";
    private const string VkeyEndpoint = "https://u.y.qq.com/cgi-bin/musicu.fcg";

    private static readonly TimeSpan SearchTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan StreamTimeout = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan LyricTimeout = TimeSpan.FromSeconds(10);

    // Contract §4.2: any stable 10-digit number works; one per host run is enough.
    private readonly string _guid = Random.Shared.Next(1000000000, 2000000000).ToString(CultureInfo.InvariantCulture);

    private readonly AccountService? _accounts;

    public QqProvider(AccountService? accounts = null) => _accounts = accounts;

    public string Name => "qq";

    // Contract §5: a logged-in host replays persisted cookies on API hosts; the audio CDN only
    // needs the referer, so stream requests stay cookie-free.
    private string ApiCookie => _accounts?.CookieHeader(Name, "c.y.qq.com") ?? string.Empty;

    private string VkeyCookie => _accounts?.CookieHeader(Name, "u.y.qq.com") ?? string.Empty;

    public async Task<List<OnlineTrack>> SearchAsync(string query, int limit, CancellationToken cancellationToken)
    {
        var primaryUrl = $"{SearchEndpoint}?p=1&n={limit}&w={Uri.EscapeDataString(query)}&format=json&aggr=1&cr=1&new_json=1";
        var primaryStatus = "unknown";
        string? primaryError = null;

        // Primary endpoint keeps the contract's single retry (300 ms) for transient failures.
        for (var attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                var upstream = await OnlineHttp.FetchTextAsync(primaryUrl, RefererUrl, SearchTimeout, cancellationToken, cookie: ApiCookie)
                    .ConfigureAwait(false);
                primaryStatus = upstream.Status.ToString(CultureInfo.InvariantCulture);
                if (string.IsNullOrWhiteSpace(upstream.Body))
                {
                    primaryError = "empty body";
                }
                else
                {
                    using var document = JsonDocument.Parse(upstream.Body);
                    var tracks = ParseSearch(document.RootElement);
                    if (tracks.Count > 0)
                    {
                        OnlineHttp.Info($"GET qq/search q={query} ok {tracks.Count} tracks {upstream.TookMs}ms");
                        await ApplyEntitlementsAsync(tracks, cancellationToken).ConfigureAwait(false);
                        return tracks;
                    }

                    primaryError = "no tracks parsed";
                }
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                primaryStatus = DescribeStatus(exception);
                primaryError = OnlineHttp.Describe(exception);
                OnlineHttp.Warn($"GET qq/search q={query} primary failed: {OnlineHttp.Describe(exception)}");
            }

            if (attempt == 0)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(300), cancellationToken).ConfigureAwait(false);
            }
        }

        // Fallback only runs when the primary produced no tracks; the normal path costs one request.
        var fallbackUrl = $"{FallbackSearchEndpoint}?p=1&n={limit}&w={Uri.EscapeDataString(query)}&format=json";
        var fallbackStatus = "not-attempted";
        Exception? fallbackFailure = null;
        try
        {
            var upstream = await OnlineHttp.FetchTextAsync(fallbackUrl, RefererUrl, SearchTimeout, cancellationToken, cookie: ApiCookie)
                .ConfigureAwait(false);
            fallbackStatus = upstream.Status.ToString(CultureInfo.InvariantCulture);
            if (string.IsNullOrWhiteSpace(upstream.Body))
            {
                fallbackStatus += " empty-body";
            }
            else
            {
                using var document = JsonDocument.Parse(upstream.Body);
                var tracks = ParseSearch(document.RootElement);
                if (tracks.Count > 0)
                {
                    OnlineHttp.Info($"qq search fallback=search_for_qq_cp ok n={tracks.Count} {upstream.TookMs}ms primary={primaryStatus}");
                    await ApplyEntitlementsAsync(tracks, cancellationToken).ConfigureAwait(false);
                    return tracks;
                }

                fallbackStatus += " no-tracks";
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            fallbackStatus = DescribeStatus(exception);
            fallbackFailure = exception;
        }

        OnlineHttp.Warn(
            $"qq search failed: primary={primaryStatus} ({primaryError ?? "no tracks"}) " +
            $"fallback={fallbackStatus} ({(fallbackFailure is null ? "no tracks" : OnlineHttp.Describe(fallbackFailure))})");
        throw new OnlineUpstreamException(
            $"QQ 搜索主备端点均失败 (primary={primaryStatus}, fallback={fallbackStatus})",
            502);
    }

    private static string DescribeStatus(Exception exception) =>
        exception is OnlineUpstreamException upstream
            ? upstream.StatusCode.ToString(CultureInfo.InvariantCulture)
            : exception.GetType().Name;

    public async Task<LyricData> GetLyricAsync(string id, CancellationToken cancellationToken)
    {
        var url = $"{LyricEndpoint}?songmid={Uri.EscapeDataString(id)}&format=json&nobase64=1";
        try
        {
            var upstream = await OnlineHttp.FetchTextAsync(url, RefererUrl, LyricTimeout, cancellationToken, cookie: ApiCookie)
                .ConfigureAwait(false);
            var json = StripJsonp(upstream.Body);
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var retcode = root.TryGetProperty("retcode", out var codeElement) && codeElement.TryGetInt32(out var code)
                ? code
                : 0;
            var lrc = retcode == 0 ? DecodeHtml(ReadString(root, "lyric")) : string.Empty;
            var translation = retcode == 0 ? DecodeHtml(ReadString(root, "trans")) : string.Empty;
            var qrc = retcode == 0 ? await TryFetchQrcAsync(id, cancellationToken).ConfigureAwait(false) : null;
            OnlineHttp.Info($"GET qq/lyric id={id} ok lrcChars={lrc.Length} qrcHexChars={qrc?.Length ?? 0} {upstream.TookMs}ms");
            return new LyricData
            {
                Lrc = lrc,
                Translation = string.IsNullOrWhiteSpace(translation) ? null : translation,
                Qrc = qrc,
            };
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"GET qq/lyric id={id} failed: {OnlineHttp.Describe(exception)}");
            throw;
        }
    }

    /// <summary>QQ QRC 逐词歌词（加密十六进制）：失败返回 null，不影响普通 LRC 主流程。</summary>
    private async Task<string?> TryFetchQrcAsync(string id, CancellationToken cancellationToken)
    {
        var body =
            "{\"comm\":{\"ct\":11,\"cv\":\"1003006\",\"v\":\"1003006\",\"uin\":\"0\"}," +
            "\"req\":{\"module\":\"music.musichallSong.PlayLyricInfo\",\"method\":\"GetPlayLyricInfo\"," +
            $"\"param\":{{\"songMID\":\"{id}\",\"format\":\"qrc\",\"qrc\":1}}}}}}";
        try
        {
            var upstream = await OnlineHttp.FetchTextAsync(
                    VkeyEndpoint,
                    RefererUrl,
                    LyricTimeout,
                    cancellationToken,
                    HttpMethod.Post,
                    body,
                    VkeyCookie)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(upstream.Body);
            if (!document.RootElement.TryGetProperty("req", out var req) ||
                !req.TryGetProperty("data", out var data))
            {
                OnlineHttp.Warn($"GET qq/qrc id={id} failed: no data");
                return null;
            }

            var hex = ReadString(data, "lyric");
            if (string.IsNullOrWhiteSpace(hex))
            {
                OnlineHttp.Warn($"GET qq/qrc id={id} failed: empty lyric");
                return null;
            }

            OnlineHttp.Info($"GET qq/qrc id={id} ok hexChars={hex.Length} {upstream.TookMs}ms");
            return hex;
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"GET qq/qrc id={id} failed: {OnlineHttp.Describe(exception)}");
            return null;
        }
    }

    public async Task<StreamResolution> ResolveStreamAsync(string id, string? quality, CancellationToken cancellationToken)
    {
        // Logged-in hosts must pass the real uin; anonymous requests keep the old "0" shape.
        var uin = _accounts?.GetUserId(Name) ?? "0";
        foreach (var candidate in QqQualityCandidates(quality))
        {
            var resolution = await ResolveStreamOnceAsync(id, uin, candidate, cancellationToken).ConfigureAwait(false);
            if (resolution.IsPlayable)
            {
                return resolution;
            }
        }
        return StreamResolution.NotPlayable("该歌曲需要 QQ 音乐会员或已下架");
    }

    private static string[] QqQualityCandidates(string? quality) => (quality ?? string.Empty).Trim().ToLowerInvariant() switch
    {
        "lossless" => ["lossless", "high", "standard"],
        "standard" => ["standard"],
        _ => ["high", "standard"],
    };

    private async Task<StreamResolution> ResolveStreamOnceAsync(string id, string uin, string quality, CancellationToken cancellationToken)
    {
        var body = BuildVkeyBody(id, uin, quality);
        try
        {
            var upstream = await OnlineHttp.FetchTextAsync(
                    VkeyEndpoint,
                    RefererUrl,
                    StreamTimeout,
                    cancellationToken,
                    HttpMethod.Post,
                    body,
                    cookie: VkeyCookie)
                .ConfigureAwait(false);

            using var document = JsonDocument.Parse(upstream.Body);
            var root = document.RootElement;
            var purl = string.Empty;
            var result = 0;
            var sip = string.Empty;

            if (root.TryGetProperty("req_0", out var request) && request.ValueKind == JsonValueKind.Object)
            {
                if (request.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
                {
                    if (data.TryGetProperty("sip", out var sipElement) && sipElement.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var entry in sipElement.EnumerateArray())
                        {
                            sip = entry.GetString() ?? string.Empty;
                            break;
                        }
                    }

                    if (data.TryGetProperty("midurlinfo", out var infos) && infos.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var info in infos.EnumerateArray())
                        {
                            purl = ReadString(info, "purl");
                            result = info.TryGetProperty("result", out var resultElement) && resultElement.TryGetInt32(out var resultValue)
                                ? resultValue
                                : 0;
                            break;
                        }
                    }
                }
            }

            if (string.IsNullOrEmpty(purl))
            {
                OnlineHttp.Info($"POST qq/vkey id={id} quality={quality} not-playable result={result} {upstream.TookMs}ms");
                return StreamResolution.NotPlayable("该歌曲需要 QQ 音乐会员或已下架");
            }

            var audioUrl = purl.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? purl : sip + purl;
            var ext = purl.Contains(".flac", StringComparison.OrdinalIgnoreCase) ? "flac"
                : purl.Contains(".m4a", StringComparison.OrdinalIgnoreCase) ? "m4a"
                : purl.Contains(".mp3", StringComparison.OrdinalIgnoreCase) ? "mp3"
                : "m4a";
            var bitrate = quality switch
            {
                "lossless" => 999000,
                "standard" => 128000,
                _ => 320000,
            };
            var qualityLabel = quality switch
            {
                "lossless" => "无损",
                "standard" => "标准",
                _ => "高音质",
            };
            OnlineHttp.Info($"POST qq/vkey id={id} quality={quality} ext={ext} ok {upstream.TookMs}ms");
            return StreamResolution.Playable(
                audioUrl,
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["Referer"] = RefererUrl,
                },
                qualityLabel,
                bitrate,
                ext);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"POST qq/vkey id={id} quality={quality} failed: {OnlineHttp.Describe(exception)}");
            throw;
        }
    }

    private string BuildVkeyBody(string id, string uin, string? quality = null) => BuildVkeyBody([id], uin, quality);

    // Anonymous hosts must keep uin "0"; logged-in hosts pass their real uin plus cookie
    // (contract §5), which is what turns pay_play>0 tracks into playable ones.
    private string BuildVkeyBody(IEnumerable<string> ids, string uin, string? quality = null)
    {
        var songmids = new JsonArray();
        var filenames = new JsonArray();
        var prefix = QqQualityPrefix(quality);
        var extension = QqQualityExtension(quality);
        foreach (var id in ids)
        {
            songmids.Add(id);
            filenames.Add($"{prefix}{id}{id}.{extension}");
        }

        return new JsonObject
        {
            ["req"] = new JsonObject
            {
                ["module"] = "CDN.SrfCdnDispatchServer",
                ["method"] = "GetCdnDispatch",
                ["param"] = new JsonObject { ["guid"] = _guid, ["calltype"] = 0, ["userip"] = string.Empty },
            },
            ["req_0"] = new JsonObject
            {
                ["module"] = "vkey.GetVkeyServer",
                ["method"] = "CgiGetVkey",
                ["param"] = new JsonObject
                {
                    ["guid"] = _guid,
                    ["songmid"] = songmids,
                    ["filename"] = filenames,
                    ["songtype"] = new JsonArray(0),
                    ["uin"] = uin,
                    ["loginflag"] = 1,
                    ["platform"] = "20",
                },
            },
            ["comm"] = new JsonObject { ["uin"] = uin, ["format"] = "json", ["ct"] = 24, ["cv"] = 0 },
        }.ToJsonString();
    }

    // QQ 的 file 前缀决定音质：M500=128k mp3、M800=320k mp3、F000=无损 flac。
    private static string QqQualityPrefix(string? quality) => (quality ?? string.Empty).Trim().ToLowerInvariant() switch
    {
        "lossless" => "F000",
        "standard" => "M500",
        _ => "M800",
    };

    private static string QqQualityExtension(string? quality) =>
        (quality ?? string.Empty).Trim().ToLowerInvariant() == "lossless" ? "flac" : "mp3";

    // Contract §5: after login, pay_play>0 tracks may still resolve; a vkey that returns a purl
    // is the only reliable entitlement signal, so candidates are checked in one batch.
    private async Task ApplyEntitlementsAsync(List<OnlineTrack> tracks, CancellationToken cancellationToken)
    {
        if (_accounts is null || !_accounts.IsLoggedIn(Name))
        {
            return;
        }

        var candidates = tracks.Where(track => !track.Playable).ToList();
        if (candidates.Count == 0)
        {
            return;
        }

        try
        {
            var body = BuildVkeyBody(candidates.Select(track => track.Id), _accounts.GetUserId(Name) ?? "0");
            var upstream = await OnlineHttp.FetchTextAsync(
                    VkeyEndpoint,
                    RefererUrl,
                    StreamTimeout,
                    cancellationToken,
                    HttpMethod.Post,
                    body,
                    cookie: VkeyCookie)
                .ConfigureAwait(false);
            using var document = JsonDocument.Parse(upstream.Body);
            var playable = ParseVkeyPlayable(document.RootElement);
            var updated = 0;
            for (var index = 0; index < tracks.Count; index++)
            {
                if (!tracks[index].Playable && playable.Contains(tracks[index].Id))
                {
                    tracks[index] = tracks[index] with { Playable = true };
                    updated++;
                }
            }

            OnlineHttp.Info($"POST qq/vkey batch ids={candidates.Count} playable={updated} {upstream.TookMs}ms");
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"POST qq/vkey batch ids={candidates.Count} failed: {OnlineHttp.Describe(exception)}");
        }
    }

    private static HashSet<string> ParseVkeyPlayable(JsonElement root)
    {
        var playable = new HashSet<string>(StringComparer.Ordinal);
        if (!root.TryGetProperty("req_0", out var request) ||
            !request.TryGetProperty("data", out var data) ||
            !data.TryGetProperty("midurlinfo", out var infos) ||
            infos.ValueKind != JsonValueKind.Array)
        {
            return playable;
        }

        foreach (var info in infos.EnumerateArray())
        {
            var mid = FirstNonEmpty(ReadString(info, "songmid"), ReadString(info, "mid"));
            if (mid.Length > 0 && ReadString(info, "purl").Length > 0)
            {
                playable.Add(mid);
            }
        }

        return playable;
    }

    /// <summary>QQ 音乐「音乐馆」热门歌单（匿名可拉，不需要登录）。</summary>
    internal async Task<List<HotPlaylistItem>> GetHotPlaylistsAsync(int limit, CancellationToken cancellationToken)
    {
        var url = "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?picmid=1&rnd=0.2&g_tk=5381" +
                  "&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0" +
                  "&platform=yqq.json&needNewCode=0&categoryId=10000000&sortId=5&sin=0&ein=" +
                  Math.Max(0, limit - 1).ToString(CultureInfo.InvariantCulture);
        var upstream = await OnlineHttp.FetchTextAsync(url, RefererUrl, SearchTimeout, cancellationToken).ConfigureAwait(false);
        var items = new List<HotPlaylistItem>();
        using var document = JsonDocument.Parse(upstream.Body);
        var root = document.RootElement;
        if (!root.TryGetProperty("data", out var data) ||
            !data.TryGetProperty("list", out var list) ||
            list.ValueKind != JsonValueKind.Array)
        {
            return items;
        }

        foreach (var element in list.EnumerateArray())
        {
            var id = ReadString(element, "dissid");
            var title = ReadString(element, "dissname");
            if (id.Length == 0 || title.Length == 0)
            {
                continue;
            }

            var image = ReadString(element, "imgurl");
            if (image.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            {
                image = "https://" + image[7..];
            }

            var listens = element.TryGetProperty("listennum", out var listenElement) &&
                          listenElement.TryGetInt64(out var count)
                ? count
                : 0;
            var creator = element.TryGetProperty("creator", out var creatorElement) &&
                          creatorElement.ValueKind == JsonValueKind.Object
                ? ReadString(creatorElement, "name")
                : string.Empty;
            items.Add(new HotPlaylistItem(id, title, image, listens, creator));
        }

        OnlineHttp.Info($"qq/hotlists count={items.Count}");
        return items;
    }

    private static List<OnlineTrack> ParseSearch(JsonElement root)
    {
        var tracks = new List<OnlineTrack>();
        if (!root.TryGetProperty("data", out var data) ||
            !data.TryGetProperty("song", out var songContainer) ||
            !songContainer.TryGetProperty("list", out var list) ||
            list.ValueKind != JsonValueKind.Array)
        {
            return tracks;
        }

        foreach (var item in list.EnumerateArray())
        {
            // Primary (new_json) uses mid/name/album.mid/pay.pay_play; the fallback endpoint
            // flattens the same fields to songmid/songname/albummid/payplay.
            var mid = FirstNonEmpty(ReadString(item, "mid"), ReadString(item, "songmid"));
            if (mid.Length == 0)
            {
                continue;
            }

            var title = FirstNonEmpty(ReadString(item, "name"), ReadString(item, "songname"));

            var artists = new List<string>();
            if (item.TryGetProperty("singer", out var singerElement) && singerElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var singer in singerElement.EnumerateArray())
                {
                    var name = ReadString(singer, "name");
                    if (name.Length > 0)
                    {
                        artists.Add(name);
                    }
                }
            }

            var albumName = string.Empty;
            var coverKey = string.Empty;
            if (item.TryGetProperty("album", out var album) && album.ValueKind == JsonValueKind.Object)
            {
                albumName = ReadString(album, "name");
                coverKey = ReadString(album, "mid");
            }

            albumName = FirstNonEmpty(albumName, ReadString(item, "albumname"));
            coverKey = FirstNonEmpty(coverKey, ReadString(item, "albummid"));

            // pay.pay_play == 0 means the anonymous host can fetch a vkey (contract §4.2).
            // The fallback shape exposes the same flag either as pay.playplay or top-level payplay.
            var payPlay = 1;
            if (item.TryGetProperty("pay", out var pay) && pay.ValueKind == JsonValueKind.Object)
            {
                if (TryReadInt(pay, "pay_play", out var payPlayValue) || TryReadInt(pay, "payplay", out payPlayValue))
                {
                    payPlay = payPlayValue;
                }
            }
            else if (TryReadInt(item, "payplay", out var legacyPayPlay))
            {
                payPlay = legacyPayPlay;
            }

            var intervalSeconds = item.TryGetProperty("interval", out var intervalElement) && intervalElement.TryGetInt64(out var interval)
                ? interval
                : 0;

            tracks.Add(new OnlineTrack
            {
                Source = "qq",
                Id = mid,
                Mid = mid,
                Title = title,
                Artist = string.Join(" / ", artists),
                Album = albumName,
                DurationMs = intervalSeconds * 1000,
                Playable = payPlay == 0,
                Vip = payPlay != 0,
                CoverKey = coverKey.Length > 0 ? coverKey : null,
            });
        }

        return tracks;
    }

    private static string FirstNonEmpty(string first, string second) => first.Length > 0 ? first : second;

    private static bool TryReadInt(JsonElement element, string name, out int value)
    {
        if (element.TryGetProperty(name, out var property))
        {
            if (property.ValueKind == JsonValueKind.Number && property.TryGetInt32(out value))
            {
                return true;
            }

            if (property.ValueKind == JsonValueKind.String &&
                int.TryParse(property.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
            {
                return true;
            }
        }

        value = 0;
        return false;
    }

    private static string StripJsonp(string body)
    {
        // Contract §4.2 says format=json returns plain JSON; keep a JSONP fallback anyway.
        var text = body.Trim();
        if (text.StartsWith('{'))
        {
            return text;
        }

        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        return start >= 0 && end > start ? text[start..(end + 1)] : text;
    }

    private static string ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static string DecodeHtml(string text)
    {
        if (text.Length == 0 || text.IndexOf('&') < 0)
        {
            return text;
        }

        var builder = new StringBuilder(text.Length);
        for (var index = 0; index < text.Length; index++)
        {
            if (text[index] != '&')
            {
                builder.Append(text[index]);
                continue;
            }

            var semicolon = text.IndexOf(';', index + 1);
            if (semicolon < 0 || semicolon - index > 10)
            {
                builder.Append(text[index]);
                continue;
            }

            var entity = text[(index + 1)..semicolon];
            var decoded = entity switch
            {
                "amp" => "&",
                "lt" => "<",
                "gt" => ">",
                "quot" => "\"",
                "apos" => "'",
                "nbsp" => " ",
                _ => DecodeNumericEntity(entity),
            };

            if (decoded is null)
            {
                builder.Append(text[index]);
                continue;
            }

            builder.Append(decoded);
            index = semicolon;
        }

        return builder.ToString();
    }

    private static string? DecodeNumericEntity(string entity)
    {
        if (entity.Length < 2 || entity[0] != '#')
        {
            return null;
        }

        int codePoint;
        if (entity[1] is 'x' or 'X')
        {
            if (!int.TryParse(entity[2..], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out codePoint))
            {
                return null;
            }
        }
        else if (!int.TryParse(entity[1..], NumberStyles.Integer, CultureInfo.InvariantCulture, out codePoint))
        {
            return null;
        }

        return codePoint is > 0 and <= 0x10FFFF ? char.ConvertFromUtf32(codePoint) : null;
    }
}


/// <summary>QQ 音乐热门歌单条目（服端内部模型，封面在返回前改写成回环代理 URL）。</summary>
internal sealed record HotPlaylistItem(string Id, string Title, string ImageUrl, long ListenCount, string Creator);
