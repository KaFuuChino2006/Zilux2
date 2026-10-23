using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Zilux2.Online;

// 实验来源：无名音乐（mvmp3.com）。
//   · 站点本身是一个第三方聚合搜索/试听站，音频直链指向酷我（kuwo）CDN；
//   · 首次访问需要过一次「安全验证」（表单里勾选 human_check），之后靠 Cookie 会话；
//   · 只做「搜索 → 播放 → 歌词」三件事，没有账号、歌单、收藏、推荐；
//   · 上游随时可能改版/失效，所有失败都按普通上游错误处理，不影响其他平台。
internal sealed class Mvmp3Provider : IOnlineMusicProvider
{
    internal const string BaseUrl = "https://www.mvmp3.com";
    internal const string RefererUrl = "https://www.mvmp3.com/";
    private const string PlayEndpoint = BaseUrl + "/style/js/play.php";

    private static readonly TimeSpan SearchTimeout = TimeSpan.FromSeconds(12);
    private static readonly TimeSpan ResolveTimeout = TimeSpan.FromSeconds(12);
    private static readonly TimeSpan SessionTtl = TimeSpan.FromMinutes(45);

    private static readonly Regex GatePattern = new(
        @"name=""csrf_token""\s+value=""(?<token>[a-f0-9]{16,64})""",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex ItemPattern = new(
        @"<li>\s*<div class=""pic"">\s*<a href=""(?<href>[^""]+)""[^>]*>\s*<img src=""(?<pic>[^""]*)""[^>]*>.*?" +
        @"<span class=""stime"">(?<stime>[^<]*)</span>.*?<div class=""name"">\s*<a href=""[^""]+"" class=""url""[^>]*>(?<name>.*?)</a>",
        RegexOptions.Compiled | RegexOptions.Singleline | RegexOptions.IgnoreCase);

    private static readonly Regex HashPattern = new(@"/mp3/(?<hash>[a-f0-9]{32})\.html", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex TagPattern = new(@"<[^>]+>", RegexOptions.Compiled | RegexOptions.Singleline);
    private static readonly Regex AlbumPattern = new(@"<span>\s*专辑[:：]\s*(?<album>[^<]*)</span>", RegexOptions.Compiled);
    private static readonly Regex LrcMetaPattern = new(@"(?im)^\[[0-9:.]+\][^\r\n]*mvmp3\.com[^\r\n]*\r?\n?", RegexOptions.Compiled);

    private readonly CookieContainer _cookies = new();
    private readonly SemaphoreSlim _verifyLock = new(1, 1);
    private readonly Dictionary<string, PlayResult> _playCache = new(StringComparer.Ordinal);
    private readonly HttpClient _client;

    private DateTimeOffset _verifiedAt = DateTimeOffset.MinValue;

    public Mvmp3Provider()
    {
        var handler = new HttpClientHandler
        {
            UseCookies = true,
            CookieContainer = _cookies,
            AllowAutoRedirect = true,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate | DecompressionMethods.Brotli,
        };
        // 不走系统代理，与其它平台保持一致；需要代理时由 ZILUX2_ONLINE_PROXY 统一控制（目前只作用于 OnlineHttp.Client）。
        _client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    public string Name => "mvmp3";

    public async Task<List<OnlineTrack>> SearchAsync(string query, int limit, CancellationToken cancellationToken)
    {
        var take = Math.Clamp(limit, 1, 30);
        var url = $"{BaseUrl}/so/{Uri.EscapeDataString(query)}.html";
        var html = await FetchHtmlAsync(url, cancellationToken).ConfigureAwait(false);

        var tracks = ParseSearch(html, take);
        OnlineHttp.Info($"GET mvmp3/search q={query} ok {tracks.Count} tracks");
        return tracks;
    }

    public async Task<LyricData> GetLyricAsync(string id, CancellationToken cancellationToken)
    {
        var play = await PlayAsync(id, cancellationToken).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(play.Lrc))
        {
            return new LyricData();
        }

        var lrc = LrcMetaPattern.Replace(play.Lrc, string.Empty).Trim();
        return new LyricData { Lrc = lrc };
    }

    public async Task<StreamResolution> ResolveStreamAsync(string id, string? quality, CancellationToken cancellationToken)
    {
        var play = await PlayAsync(id, cancellationToken).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(play.Url))
        {
            return StreamResolution.NotPlayable("无名音乐里这首歌没有可用的播放地址（可能已下架或受限）");
        }

        // 酷我 CDN 不校验来源，但带上站点 Referer 更稳；音质固定 320kbps MP3。
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Referer"] = RefererUrl,
        };
        return StreamResolution.Playable(
            play.Url,
            headers,
            qualityLabel: "高",
            bitrate: 320,
            format: "mp3");
    }

    private static List<OnlineTrack> ParseSearch(string html, int take)
    {
        var tracks = new List<OnlineTrack>();
        foreach (Match match in ItemPattern.Matches(html))
        {
            if (tracks.Count >= take)
            {
                break;
            }

            var href = match.Groups["href"].Value;
            var hashMatch = HashPattern.Match(href);
            if (!hashMatch.Success)
            {
                continue;
            }

            var rawName = WebUtility.HtmlDecode(TagPattern.Replace(match.Groups["name"].Value, string.Empty)).Trim();
            if (rawName.Length == 0)
            {
                continue;
            }

            var artist = string.Empty;
            var title = rawName;
            var split = rawName.LastIndexOf(" - ", StringComparison.Ordinal);
            if (split > 0)
            {
                artist = rawName[..split].Trim();
                title = rawName[(split + 3)..].Trim();
            }

            var pic = match.Groups["pic"].Value.Trim();
            if (pic.StartsWith("//", StringComparison.Ordinal))
            {
                pic = "https:" + pic;
            }
            else if (pic.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            {
                pic = "https://" + pic[7..];
            }

            var album = string.Empty;
            var albumMatch = AlbumPattern.Match(match.Value);
            if (albumMatch.Success)
            {
                album = WebUtility.HtmlDecode(TagPattern.Replace(albumMatch.Groups["album"].Value, string.Empty)).Trim();
            }

            tracks.Add(new OnlineTrack
            {
                Source = "mvmp3",
                Id = hashMatch.Groups["hash"].Value.ToLowerInvariant(),
                Title = title,
                Artist = artist,
                Album = album,
                DurationMs = ParseDuration(match.Groups["stime"].Value),
                Playable = true,
                CoverKey = pic.Length > 0 ? pic : null,
            });
        }

        return tracks;
    }

    private static long ParseDuration(string text)
    {
        var parts = text.Trim().Split(':');
        if (parts.Length is < 2 or > 3)
        {
            return 0;
        }

        long total = 0;
        foreach (var part in parts)
        {
            if (!long.TryParse(part, out var value))
            {
                return 0;
            }

            total = (total * 60) + value;
        }

        return total * 1000;
    }

    private async Task<PlayResult> PlayAsync(string id, CancellationToken cancellationToken)
    {
        if (_playCache.TryGetValue(id, out var cached) && cached.ExpiresAt > DateTimeOffset.UtcNow)
        {
            return cached;
        }

        await EnsureVerifiedAsync(cancellationToken).ConfigureAwait(false);

        // 站点歌曲页调用的是 player("dance", hash)：type=dance 才会返回可用的 kuwo 直链，
        // type=mp3 对同一首曲子返回的 url 为 null（实测 2026-10-22）。
        var body = $"id={Uri.EscapeDataString(id)}&type=dance";
        var text = await PostFormAsync(PlayEndpoint, body, BaseUrl + "/mp3/" + id + ".html", cancellationToken)
            .ConfigureAwait(false);

        var result = ParsePlay(id, text);
        _playCache[id] = result;
        OnlineHttp.Info($"GET mvmp3/play id={id} url={(string.IsNullOrEmpty(result.Url) ? "none" : "ok")} lrc={result.Lrc?.Length ?? 0}");
        return result;
    }

    private static PlayResult ParsePlay(string id, string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;
            var url = ReadString(root, "url");
            if (url.Length == 0)
            {
                // 部分曲目返回 {"msg":1,...,"url":null}，表示上游没有可用直链。
                return new PlayResult(id, null, ReadString(root, "lrc"), ReadString(root, "pic"));
            }

            return new PlayResult(id, url, ReadString(root, "lrc"), ReadString(root, "pic"));
        }
        catch (JsonException exception)
        {
            throw new OnlineUpstreamException("无名音乐播放接口返回异常：" + exception.Message, 502);
        }
    }

    private static string ReadString(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value))
        {
            return string.Empty;
        }

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString()?.Trim() ?? string.Empty,
            JsonValueKind.Number => value.ToString(),
            _ => string.Empty,
        };
    }

    private async Task<string> FetchHtmlAsync(string url, CancellationToken cancellationToken)
    {
        var html = await GetTextAsync(url, cancellationToken).ConfigureAwait(false);
        if (!IsGate(html))
        {
            return html;
        }

        await EnsureVerifiedAsync(cancellationToken, force: true).ConfigureAwait(false);
        html = await GetTextAsync(url, cancellationToken).ConfigureAwait(false);
        if (IsGate(html))
        {
            throw new OnlineUpstreamException("无名音乐安全验证未通过（站点可能更新了验证方式）", 403);
        }

        return html;
    }

    private static bool IsGate(string html) =>
        html.Contains("csrf_token", StringComparison.OrdinalIgnoreCase) &&
        !html.Contains("class=\"url\"", StringComparison.OrdinalIgnoreCase);

    private async Task EnsureVerifiedAsync(CancellationToken cancellationToken, bool force = false)
    {
        if (!force && DateTimeOffset.UtcNow - _verifiedAt < SessionTtl)
        {
            return;
        }

        await _verifyLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!force && DateTimeOffset.UtcNow - _verifiedAt < SessionTtl)
            {
                return;
            }

            var home = await GetTextAsync(BaseUrl + "/", cancellationToken).ConfigureAwait(false);
            if (!IsGate(home) && !GatePattern.IsMatch(home))
            {
                _verifiedAt = DateTimeOffset.UtcNow;
                OnlineHttp.Info("GET mvmp3/verify already-ok");
                return;
            }

            var match = GatePattern.Match(home);
            if (!match.Success)
            {
                throw new OnlineUpstreamException("无名音乐需要安全验证，但页面里找不到校验参数", 403);
            }

            var token = match.Groups["token"].Value;
            var post = await PostFormAsync(
                    BaseUrl + "/",
                    "csrf_token=" + Uri.EscapeDataString(token) + "&human_check=on",
                    BaseUrl + "/",
                    cancellationToken)
                .ConfigureAwait(false);

            if (IsGate(post))
            {
                throw new OnlineUpstreamException("无名音乐安全验证失败（站点可能更新了验证方式）", 403);
            }

            _verifiedAt = DateTimeOffset.UtcNow;
            OnlineHttp.Info("GET mvmp3/verify ok");
        }
        finally
        {
            _verifyLock.Release();
        }
    }

    private async Task<string> GetTextAsync(string url, CancellationToken cancellationToken)
    {
        using var request = NewRequest(HttpMethod.Get, url);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(SearchTimeout);
        using var response = await _client.SendAsync(request, HttpCompletionOption.ResponseContentRead, timeout.Token)
            .ConfigureAwait(false);
        var status = (int)response.StatusCode;
        if (!response.IsSuccessStatusCode)
        {
            throw new OnlineUpstreamException($"upstream HTTP {status}", status);
        }

        return await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
    }

    private async Task<string> PostFormAsync(string url, string body, string referer, CancellationToken cancellationToken)
    {
        using var request = NewRequest(HttpMethod.Post, url, referer);
        request.Content = new StringContent(body, Encoding.UTF8, "application/x-www-form-urlencoded");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(SearchTimeout);
        using var response = await _client.SendAsync(request, HttpCompletionOption.ResponseContentRead, timeout.Token)
            .ConfigureAwait(false);
        var status = (int)response.StatusCode;
        if (!response.IsSuccessStatusCode)
        {
            throw new OnlineUpstreamException($"upstream HTTP {status}", status);
        }

        return await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
    }

    private HttpRequestMessage NewRequest(HttpMethod method, string url, string? referer = null)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.TryAddWithoutValidation("User-Agent", OnlineHttp.UserAgent);
        request.Headers.TryAddWithoutValidation("Accept", method == HttpMethod.Post
            ? "text/html,application/json,application/xhtml+xml,*/*"
            : "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8");
        request.Headers.TryAddWithoutValidation("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
        request.Headers.TryAddWithoutValidation("Referer", referer ?? RefererUrl);
        return request;
    }

    private sealed record PlayResult(string Id, string? Url, string? Lrc, string? Pic)
    {
        public DateTimeOffset ExpiresAt { get; } = DateTimeOffset.UtcNow.AddMinutes(10);
    }
}
