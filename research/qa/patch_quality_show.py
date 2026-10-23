"""显示「当前实际播放音质」：宿主 StreamResolution 带实际音质 + /api/stream/info + 前端展示。"""
import io

IFACE = r'E:\Zilux2开发\src\Zilux2\Online\IOnlineMusicProvider.cs'
NETEASE = r'E:\Zilux2开发\src\Zilux2\Online\NeteaseProvider.cs'
QQ = r'E:\Zilux2开发\src\Zilux2\Online\QqProvider.cs'
SERVER = r'E:\Zilux2开发\src\Zilux2\Online\LocalMusicServer.cs'
CLIENT = r'E:\Zilux2开发\web\src\online\client.ts'
PLAYER = r'E:\Zilux2开发\web\src\ui\player.ts'
APP = r'E:\Zilux2开发\web\src\ui\app.ts'


def patch(path, steps):
    text = io.open(path, 'r', encoding='utf-8', newline='').read()
    eol = '\r\n' if '\r\n' in text else '\n'
    for label, old, new in steps:
        old = old.replace('\n', eol)
        new = new.replace('\n', eol)
        count = text.count(old)
        assert count == 1, f'{path} / {label}: found {count}'
        text = text.replace(old, new)
        print(f'ok {label}')
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


# ---------------- StreamResolution 带实际音质 ----------------
patch(IFACE, [
    (
        'resolution props',
        '''    // Extra headers the upstream audio CDN requires (QQ needs a y.qq.com Referer).
    public IReadOnlyDictionary<string, string> Headers { get; private init; } = NoHeaders;

    public static StreamResolution Playable(string url, IReadOnlyDictionary<string, string>? headers = null) =>
        new() { IsPlayable = true, Url = url, Headers = headers ?? NoHeaders };
''',
        '''    // Extra headers the upstream audio CDN requires (QQ needs a y.qq.com Referer).
    public IReadOnlyDictionary<string, string> Headers { get; private init; } = NoHeaders;

    // 实际下发的音质（用于界面显示，例如「无损 · FLAC 999k」）。
    public string QualityLabel { get; private init; } = string.Empty;

    public int Bitrate { get; private init; }

    public string Format { get; private init; } = string.Empty;

    public static StreamResolution Playable(
        string url,
        IReadOnlyDictionary<string, string>? headers = null,
        string qualityLabel = "",
        int bitrate = 0,
        string format = "") =>
        new()
        {
            IsPlayable = true,
            Url = url,
            Headers = headers ?? NoHeaders,
            QualityLabel = qualityLabel,
            Bitrate = bitrate,
            Format = format,
        };
''',
    ),
])

# ---------------- 网易云：读实际 br/type ----------------
patch(NETEASE, [
    (
        'netease actual br',
        '''            var audioUrl = string.Empty;
            if (document.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in data.EnumerateArray())
                {
                    audioUrl = ReadString(item, "url");
                    break;
                }
            }
''',
        '''            var audioUrl = string.Empty;
            var actualBr = 0;
            var actualFormat = string.Empty;
            if (document.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in data.EnumerateArray())
                {
                    audioUrl = ReadString(item, "url");
                    actualBr = item.TryGetProperty("br", out var brElement) && brElement.TryGetInt32(out var brValue) ? brValue : 0;
                    actualFormat = ReadString(item, "type");
                    break;
                }
            }
''',
    ),
    (
        'netease playable label',
        '''            OnlineHttp.Info($"GET netease/player-url id={id} br={br} ok {upstream.TookMs}ms");
            return StreamResolution.Playable(audioUrl, new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
''',
        '''            OnlineHttp.Info($"GET netease/player-url id={id} br={br} actual={actualBr} type={actualFormat} ok {upstream.TookMs}ms");
            return StreamResolution.Playable(
                audioUrl,
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
''',
    ),
    (
        'netease close playable',
        '''            });
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"GET netease/player-url id={id} br={br} failed: {OnlineHttp.Describe(exception)}");
''',
        '''                },
                actualBr >= 900000 ? "无损" : actualBr >= 300000 ? "高音质" : "标准",
                actualBr,
                actualFormat);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            OnlineHttp.Warn($"GET netease/player-url id={id} br={br} failed: {OnlineHttp.Describe(exception)}");
''',
    ),
])

# ---------------- QQ：按实际候选给标签 ----------------
patch(QQ, [
    (
        'qq playable label',
        '''            var audioUrl = purl.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? purl : sip + purl;
            OnlineHttp.Info($"POST qq/vkey id={id} quality={quality} ok {upstream.TookMs}ms");
            return StreamResolution.Playable(audioUrl, new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Referer"] = RefererUrl,
            });
''',
        '''            var audioUrl = purl.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? purl : sip + purl;
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
''',
    ),
])

# ---------------- 宿主路由 /api/stream/info ----------------
patch(SERVER, [
    (
        'route',
        '                "/api/playlists/hot" => isGet ? await HandleHotPlaylistsAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),\n',
        '                "/api/playlists/hot" => isGet ? await HandleHotPlaylistsAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),\n'
        '                "/api/stream/info" => isGet ? await HandleStreamInfoAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),\n',
    ),
    (
        'handler',
        '''    private async Task<int> HandleHotPlaylistsAsync(HttpListenerContext context)
''',
        '''    /// <summary>返回实际下发的音质（供界面显示「现在播的是不是无损」）。</summary>
    private async Task<int> HandleStreamInfoAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim();
        var provider = GetProvider(source);
        if (provider is null)
        {
            return WriteError(context, 400, "bad-request", "暂不支持该音乐平台");
        }

        var id = (query["id"] ?? string.Empty).Trim();
        if (id.Length is 0 or > 200)
        {
            return WriteError(context, 400, "bad-request", "id 参数非法");
        }

        var quality = NormalizeQuality(query["quality"]);
        try
        {
            var resolution = await provider.ResolveStreamAsync(id, quality, _shutdown.Token).ConfigureAwait(false);
            if (!resolution.IsPlayable)
            {
                return WriteError(context, 502, "upstream-error", resolution.NotPlayableMessage);
            }

            WriteJson(context, 200, JsonSerializer.Serialize(new
            {
                source,
                id,
                requested = quality,
                quality = resolution.QualityLabel,
                bitrate = resolution.Bitrate,
                format = resolution.Format,
            }));
            return 200;
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
        {
            OnlineHttp.Error("api stream/info failed", exception);
            return WriteError(context, 502, "upstream-error", "获取音质信息失败：" + OnlineHttp.Describe(exception));
        }
    }

    private async Task<int> HandleHotPlaylistsAsync(HttpListenerContext context)
''',
    ),
])

# ---------------- Web client ----------------
patch(CLIENT, [
    (
        'stream info api',
        '''/** QQ 音乐「音乐馆」热门歌单（宿主 /api/playlists/hot）。 */''',
        '''export interface StreamInfo {
  source: string;
  id: string;
  requested: string;
  quality: string;
  bitrate: number;
  format: string;
}

/** 当前曲目实际下发的音质（宿主 /api/stream/info）。 */
export async function fetchStreamInfo(source: OnlineSource, id: string, quality?: string): Promise<StreamInfo> {
  const params: Record<string, string> = { source, id };
  if (quality) params.quality = quality;
  return api<StreamInfo>('/api/stream/info', params);
}

/** QQ 音乐「音乐馆」热门歌单（宿主 /api/playlists/hot）。 */''',
    ),
])

# ---------------- player：状态带实际音质 ----------------
patch(PLAYER, [
    (
        'client import',
        "import { onlineInfo, streamUrl, checkLiked, addLikedTrack, removeLikedTrack, recordRecent } from '../online/client';",
        "import { fetchStreamInfo, onlineInfo, qualityForSource, streamUrl, checkLiked, addLikedTrack, removeLikedTrack, recordRecent } from '../online/client';",
    ),
    (
        'state field',
        '''  /** 播放模式：列表 / 单曲循环 / 随机 */
  mode: PlayMode;
''',
        '''  /** 播放模式：列表 / 单曲循环 / 随机 */
  mode: PlayMode;
  /** 实际下发的音质标签（宿主回传，例如「无损 · FLAC 999k」），未知时为空 */
  streamQuality: string;
''',
    ),
    (
        'state init',
        '''  volume: 0.8,
  liked: false,
  mode: readMode(),
''',
        '''  volume: 0.8,
  liked: false,
  mode: readMode(),
  streamQuality: '',
''',
    ),
])

print('part 1 done')
