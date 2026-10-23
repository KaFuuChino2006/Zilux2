"""封面取色改为宿主侧解码：新增 /api/cover/colors 路由 + web 优先走宿主接口。"""
import io

HOST = r'E:\Zilux2开发\src\Zilux2\Online\LocalMusicServer.cs'
CLIENT = r'E:\Zilux2开发\web\src\online\client.ts'
COLORS = r'E:\Zilux2开发\web\src\ui\coverColors.ts'


def load(path):
    text = io.open(path, 'r', encoding='utf-8', newline='').read()
    eol = '\r\n' if '\r\n' in text else '\n'
    return text, eol


def save(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


def nl(text, eol):
    if eol == '\r\n':
        return text.replace('\n', '\r\n')
    return text


# ---------------- host ----------------
host, eol = load(HOST)


def hrep(old, new, label):
    global host
    o, n = nl(old, eol), nl(new, eol)
    c = host.count(o)
    assert c == 1, '%s count=%s' % (label, c)
    host = host.replace(o, n)


hrep(
    'using System.Text.Json;\nusing Zilux2.Online.Account;',
    'using System.Text.Json;\nusing System.Windows.Media;\nusing System.Windows.Media.Imaging;\nusing Zilux2.Online.Account;',
    'usings',
)

hrep(
    '                "/api/cover" => isGet ? await HandleCoverAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),',
    '                "/api/cover" => isGet ? await HandleCoverAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),\n'
    '                "/api/cover/colors" => isGet ? await HandleCoverColorsAsync(context).ConfigureAwait(false) : MethodNotAllowed(context),',
    'route',
)

anchor = nl(
    '    private sealed record CoverCacheEntry(byte[] Bytes, string ContentType, DateTimeOffset ExpiresAt);',
    eol,
)
assert host.count(anchor) == 1, 'anchor'

methods = nl(
    '''    /// <summary>封面主色：宿主侧解码图片统计占比最高颜色，绕开页面 canvas 跨域取不到像素的问题。</summary>
    private async Task<int> HandleCoverColorsAsync(HttpListenerContext context)
    {
        if (!ValidateToken(context.Request))
        {
            return WriteUnauthorized(context);
        }

        var query = context.Request.QueryString;
        var source = (query["source"] ?? string.Empty).Trim().ToLowerInvariant();
        var key = NormalizeCoverKey((query["key"] ?? string.Empty).Trim());
        if (key.Length == 0 || !TryResolveCoverUpstream(source, key, out var upstreamUrl, out var referer, out var cacheKey))
        {
            WriteJson(context, 200, "{\\"dominant\\":null,\\"palette\\":[]}");
            return 200;
        }

        byte[] bytes;
        if (!_coverCache.TryGetValue(cacheKey, out var cached) || cached.ExpiresAt <= DateTimeOffset.UtcNow)
        {
            try
            {
                var upstream = await OnlineHttp.FetchBytesAsync(upstreamUrl, referer, CoverTimeout, _shutdown.Token)
                    .ConfigureAwait(false);
                bytes = upstream.Bytes;
                StoreCover(cacheKey, bytes, string.IsNullOrEmpty(upstream.ContentType) ? "image/jpeg" : upstream.ContentType);
            }
            catch (Exception exception) when (exception is not OperationCanceledException || !_shutdown.IsCancellationRequested)
            {
                OnlineHttp.Warn($"[cover-color] fetch failed source={source}: {exception.Message}");
                WriteJson(context, 200, "{\\"dominant\\":null,\\"palette\\":[]}");
                return 200;
            }
        }
        else
        {
            bytes = cached.Bytes;
        }

        var colors = ComputeCoverColors(bytes);
        if (colors is null)
        {
            OnlineHttp.Warn($"[cover-color] decode failed source={source} bytes={bytes.Length}");
            WriteJson(context, 200, "{\\"dominant\\":null,\\"palette\\":[]}");
            return 200;
        }

        var paletteJson = string.Join(",", colors.Value.Palette.Select(item => "\\"" + item + "\\""));
        OnlineHttp.Info($"[cover-color] source={source} dominant={colors.Value.Dominant} palette={paletteJson}");
        WriteJson(context, 200, "{\\"dominant\\":\\"" + colors.Value.Dominant + "\\",\\"palette\\":[" + paletteJson + "]}");
        return 200;
    }

    private static bool TryResolveCoverUpstream(
        string source,
        string key,
        out string upstreamUrl,
        out string referer,
        out string cacheKey)
    {
        upstreamUrl = string.Empty;
        referer = string.Empty;
        cacheKey = string.Empty;
        switch (source)
        {
            case "netease" when IsAllowedNeteaseCoverUrl(key):
                upstreamUrl = key;
                referer = NeteaseProvider.RefererUrl;
                cacheKey = "netease|" + key;
                return true;
            case "qq" when IsAllowedQqCoverUrl(key):
                upstreamUrl = key;
                referer = QqProvider.RefererUrl;
                cacheKey = "qq|" + key;
                return true;
            case "qq" when key.Length is > 0 and <= 64 && key.All(char.IsAsciiLetterOrDigit):
                upstreamUrl = "https://y.gtimg.cn/music/photo_new/T002R300x300M000" + key + ".jpg";
                referer = QqProvider.RefererUrl;
                cacheKey = "qq|" + key;
                return true;
            case "kugou" when key.Length is > 0 and <= 32 && key.All(char.IsAsciiDigit):
                upstreamUrl = "https://imge.kugou.com/stdmusic/240/" + key + ".jpg";
                referer = KugouProvider.RefererUrl;
                cacheKey = "kugou|" + key;
                return true;
            default:
                return false;
        }
    }

    private static (string Dominant, List<string> Palette)? ComputeCoverColors(byte[] bytes)
    {
        try
        {
            using var stream = new MemoryStream(bytes);
            var decoder = BitmapDecoder.Create(stream, BitmapCreateOptions.DelayCreation, BitmapCacheOption.OnLoad);
            var frame = decoder.Frames.Count > 0 ? decoder.Frames[0] : null;
            if (frame is null || frame.PixelWidth <= 0 || frame.PixelHeight <= 0)
            {
                return null;
            }

            var source = new FormatConvertedBitmap(frame, PixelFormats.Bgra32, null, 0);
            var scale = Math.Min(40.0 / source.PixelWidth, 40.0 / source.PixelHeight);
            var width = Math.Max(1, (int)Math.Round(source.PixelWidth * scale));
            var height = Math.Max(1, (int)Math.Round(source.PixelHeight * scale));
            var scaled = new TransformedBitmap(source, new ScaleTransform(width / (double)source.PixelWidth, height / (double)source.PixelHeight));
            var stride = width * 4;
            var pixels = new byte[stride * height];
            scaled.CopyPixels(pixels, stride, 0);

            var buckets = new Dictionary<int, (long Count, long R, long G, long B)>();
            for (var index = 0; index < pixels.Length; index += 4)
            {
                var b = pixels[index];
                var g = pixels[index + 1];
                var r = pixels[index + 2];
                var a = pixels[index + 3];
                if (a < 128)
                {
                    continue;
                }
                var lum = 0.299 * r + 0.587 * g + 0.114 * b;
                var max = Math.Max(r, Math.Max(g, b));
                var min = Math.Min(r, Math.Min(g, b));
                if (lum < 26 || lum > 232 || max - min < 10)
                {
                    continue;
                }
                var bucketKey = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
                buckets.TryGetValue(bucketKey, out var bucket);
                buckets[bucketKey] = (bucket.Count + 1, bucket.R + r, bucket.G + g, bucket.B + b);
            }
            if (buckets.Count == 0)
            {
                return null;
            }

            var sorted = buckets.Values.OrderByDescending(item => item.Count).ToList();
            var picked = new List<(double R, double G, double B)>();
            foreach (var bucket in sorted)
            {
                var r = bucket.R / (double)bucket.Count;
                var g = bucket.G / (double)bucket.Count;
                var b = bucket.B / (double)bucket.Count;
                if (picked.Any(item => Math.Abs(item.R - r) + Math.Abs(item.G - g) + Math.Abs(item.B - b) < 72))
                {
                    continue;
                }
                picked.Add((r, g, b));
                if (picked.Count >= 3)
                {
                    break;
                }
            }
            if (picked.Count == 0)
            {
                return null;
            }

            var dominant = ToHex(picked[0]);
            var palette = picked.Select(ToHex).ToList();
            if (palette.Count == 1)
            {
                palette.Add(ShiftColor(picked[0], 26, 0.9, 1.14));
            }
            if (palette.Count == 2)
            {
                palette.Add(ShiftColor(picked[0], -30, 0.92, 0.8));
            }
            return (dominant, palette);
        }
        catch
        {
            return null;
        }
    }

    private static string ToHex((double R, double G, double B) color)
    {
        var r = Math.Max(0, Math.Min(255, (int)Math.Round(color.R)));
        var g = Math.Max(0, Math.Min(255, (int)Math.Round(color.G)));
        var b = Math.Max(0, Math.Min(255, (int)Math.Round(color.B)));
        return "#" + r.ToString("x2") + g.ToString("x2") + b.ToString("x2");
    }

    private static string ShiftColor((double R, double G, double B) color, double hueShift, double saturationScale, double valueScale)
    {
        var max = Math.Max(color.R, Math.Max(color.G, color.B));
        var min = Math.Min(color.R, Math.Min(color.G, color.B));
        var delta = max - min;
        var hue = 0.0;
        if (delta > 0.0001)
        {
            if (Math.Abs(max - color.R) < 0.0001)
            {
                hue = 60 * (((color.G - color.B) / delta) % 6);
            }
            else if (Math.Abs(max - color.G) < 0.0001)
            {
                hue = 60 * ((color.B - color.R) / delta + 2);
            }
            else
            {
                hue = 60 * ((color.R - color.G) / delta + 4);
            }
        }
        hue = ((hue + hueShift) % 360 + 360) % 360;
        var saturation = max <= 0 ? 0 : delta / max * saturationScale;
        var value = Math.Min(255, max * valueScale);
        var chroma = value * saturation;
        var x = chroma * (1 - Math.Abs(((hue / 60) % 2) - 1));
        var m = value - chroma;
        double r;
        double g;
        double b;
        if (hue < 60)
        {
            (r, g, b) = (chroma, x, 0);
        }
        else if (hue < 120)
        {
            (r, g, b) = (x, chroma, 0);
        }
        else if (hue < 180)
        {
            (r, g, b) = (0, chroma, x);
        }
        else if (hue < 240)
        {
            (r, g, b) = (0, x, chroma);
        }
        else if (hue < 300)
        {
            (r, g, b) = (x, 0, chroma);
        }
        else
        {
            (r, g, b) = (chroma, 0, x);
        }
        return ToHex((r + m, g + m, b + m));
    }

''',
    eol,
)
host = host.replace(anchor, methods + anchor)
save(HOST, host)
print('host ok')

# ---------------- web client ----------------
client, ceol = load(CLIENT)


def crep(old, new, label):
    global client
    o, n = nl(old, ceol), nl(new, ceol)
    c = client.count(o)
    assert c == 1, '%s count=%s' % (label, c)
    client = client.replace(o, n)


crep(
    'export interface StreamInfo {',
    '''/** 宿主侧封面取色结果（页面 canvas 取不到像素时的可靠路径）。 */
export interface HostCoverColors {
  dominant: string | null;
  palette: string[];
}

export interface StreamInfo {''',
    'cover-colors-iface',
)

crep(
    'export async function fetchStreamInfo(',
    '''export async function fetchCoverColors(source: string, key: string): Promise<HostCoverColors | null> {
  try {
    const data = await api<HostCoverColors>('/api/cover/colors', { source, key });
    if (!data || !data.dominant || !Array.isArray(data.palette) || data.palette.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

export async function fetchStreamInfo(''',
    'fetch-cover-colors',
)
save(CLIENT, client)
print('client ok')

# ---------------- web coverColors ----------------
colors, xeol = load(COLORS)


def xrep(old, new, label):
    global colors
    o, n = nl(old, xeol), nl(new, xeol)
    c = colors.count(o)
    assert c == 1, '%s count=%s' % (label, c)
    colors = colors.replace(o, n)


xrep(
    "import type { OnlineTrack } from '../online/types';\nimport { host } from '../core/bridge';",
    "import type { OnlineTrack } from '../online/types';\nimport { fetchCoverColors } from '../online/client';\nimport { host } from '../core/bridge';",
    'import',
)

start_marker = '/** 取封面主色；失败/没有封面时返回 null（调用方自行兜底）。 */'
end_marker = '/** 本地无封面时用标题算一个稳定的兜底渐变。 */'
start = colors.index(nl(start_marker, xeol))
end = colors.index(nl(end_marker, xeol))
new_block = nl(
    '''/** 从代理封面地址里解析出宿主取色需要的 source/key。 */
function hostTarget(track: OnlineTrack): { source: string; key: string } | null {
  try {
    const url = new URL(track.cover ?? '');
    if (!url.pathname.endsWith('/api/cover')) return null;
    const source = url.searchParams.get('source');
    const key = url.searchParams.get('key');
    if (!source || !key) return null;
    return { source, key };
  } catch {
    return null;
  }
}

async function hostColorsOf(track: OnlineTrack): Promise<CoverColors | null> {
  const target = hostTarget(track);
  if (!target) return null;
  const data = await fetchCoverColors(target.source, target.key);
  if (!data || !data.dominant) return null;
  return { dominant: data.dominant, palette: data.palette.slice(0, 3) };
}

/** 取封面主色；失败/没有封面时返回 null（调用方自行兜底）。 */
export function coverColorsOf(track: OnlineTrack | null): Promise<CoverColors | null> {
  if (!track || !track.cover) {
    return Promise.resolve(null);
  }
  const key = keyOf(track);
  if (cache.has(key)) {
    return Promise.resolve(cache.get(key) ?? null);
  }
  const running = inflight.get(key);
  if (running) {
    return running;
  }
  const task = (async () => {
    let colors = await hostColorsOf(track);
    let pixels = 0;
    if (!colors) {
      const data = await readPixels(track.cover as string);
      pixels = data ? data.length / 4 : 0;
      colors = data ? quantize(data) : null;
    }
    cache.set(key, colors);
    try {
      host.log(
        'info',
        `[cover-color] title=${track.title} host=${colors ? 'yes' : 'no'} pixels=${pixels} dominant=${colors?.dominant ?? 'null'} palette=${colors?.palette.join(',') ?? '-'} cover=${(track.cover ?? '').slice(0, 80)}`,
      );
    } catch {
      // ignore
    }
    return colors;
  })()
    .catch(() => null)
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

''',
    xeol,
)
colors = colors[:start] + new_block + colors[end:]
save(COLORS, colors)
print('coverColors ok')
