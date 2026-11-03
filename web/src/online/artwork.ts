/** 在线曲目封面：优先用宿主代理的真实封面，缺失时程序化生成同款风格封面。 */

import { onlineInfo } from './client';
import type { OnlineTrack } from './types';

const PALETTES: Array<[string, string]> = [
  ['#8b7bff', '#2b6bff'],
  ['#ff6ea9', '#7c5cff'],
  ['#5df2ff', '#1e3bff'],
  ['#ffb86b', '#ff5c8a'],
  ['#9dff9c', '#1f9d8b'],
  ['#ffd166', '#f26d3d'],
  ['#c4a7ff', '#5b4bff'],
  ['#7bdff2', '#2d6cdf'],
];

const cache = new Map<string, string>();

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 宿主每次启动都会换回环端口与 token，而播放队列/最近播放等数据会被持久化，
 * 里面存的封面地址可能来自上一次启动（旧端口），直接用会请求失败。
 * 这里把本机代理封面地址重新绑定到当前端口与 token 上。
 */
function rebindCover(cover: string): string {
  if (!cover) return cover;
  let url: URL;
  try {
    url = new URL(cover);
  } catch {
    return cover;
  }

  const localhost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (!localhost || !url.pathname.endsWith('/api/cover')) return cover;

  const info = onlineInfo();
  if (!info || info.port <= 0) return cover;
  if (url.port === String(info.port) && url.searchParams.get('token') === info.token) return cover;

  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (key !== 'token') params.set(key, value);
  }
  params.set('token', info.token);
  return `http://127.0.0.1:${info.port}/api/cover?${params.toString()}`;
}

/** 对外暴露：把本机代理封面地址重新绑定到当前端口与 token（兜底重试用）。 */
export function rebindCoverUrl(cover: string): string {
  return rebindCover(cover);
}

/** 该地址是否仍绑定着上一次启动的端口/旧 token。 */
function needsRebind(cover: string): boolean {
  if (!cover) return false;
  let url: URL;
  try {
    url = new URL(cover);
  } catch {
    return false;
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return false;
  if (!url.pathname.endsWith('/api/cover')) return false;
  const info = onlineInfo();
  if (!info || info.port <= 0) return false;
  return url.port !== String(info.port) || url.searchParams.get('token') !== info.token;
}

/**
 * 宿主端口/token 到达后，把「启动早期就渲染出来、仍绑着上次端口」的封面重新绑定并重载。
 * 典型场景：启动时恢复上次播放队列 → 播放条/下一首封面先渲染（此时在线服务还没就绪），
 * 请求旧端口失败后掉到渐变兜底图；扫一遍修掉，无需用户切歌。
 */
export function refreshArtworkCovers(): void {
  if (typeof document === 'undefined') return;
  for (const image of Array.from(document.images)) {
    const source = image.dataset.coverSrc || image.getAttribute('src') || '';
    if (!needsRebind(source)) continue;
    const rebased = rebindCover(source);
    if (!rebased || rebased === source) continue;
    delete image.dataset.coverFallback;
    delete image.dataset.coverRetrying;
    delete image.dataset.coverRebased;
    delete image.dataset.coverSrc;
    image.src = rebased;
  }
}

/** 程序化封面用的 XML 文本转义（标题首字可能是 & < > 等）。 */
function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * 给宿主封面代理地址追加缩放参数（只处理 /api/cover，其它地址原样返回）。
 * 宿主按 width 抽样解码并缓存缩略图，海报墙请求 300、列表行请求 120 左右即可。
 */
function withCoverWidth(cover: string, width: number): string {
  if (width <= 0) return cover;
  let url: URL;
  try {
    url = new URL(cover);
  } catch {
    return cover;
  }
  const localhost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (!localhost || !url.pathname.endsWith('/api/cover')) return cover;
  url.searchParams.set('width', String(Math.round(width)));
  return url.toString();
}

/**
 * 程序化封面：用内联 SVG data URL 代替 canvas + JPEG 编码。
 * 喜欢墙 / 待播队列动辄几百首没封面的歌，每张 canvas 建 256×256 再 toDataURL 是同步且昂贵的，
 * 一次渲染几百张会直接卡住主线程；SVG 字符串拼装几乎零成本，位图化交给图片管线异步完成。
 */
function makeCover(
  track: Pick<OnlineTrack, 'id' | 'title' | 'artist' | 'album' | 'cover'>,
  width = 0,
): string {
  const remapped = rebindCover(track.cover);
  if (remapped) {
    const sized = withCoverWidth(remapped, width);
    if (sized === remapped) return remapped;
    const sizedKey = `${track.id}:w${Math.round(width)}`;
    const cachedSize = cache.get(sizedKey);
    if (cachedSize) return cachedSize;
    cache.set(sizedKey, sized);
    return sized;
  }
  const key = `${track.id}:art`;
  const cached = cache.get(key);
  if (cached) return cached;
  const palette = PALETTES[hash(track.id) % PALETTES.length] ?? PALETTES[0]!;
  const [a, b] = palette;
  const letter = escapeXml((track.title.trim()[0] ?? '♪').toUpperCase());
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${b}"/><stop offset="1" stop-color="${a}"/></linearGradient>` +
    `<radialGradient id="r" cx="0.74" cy="0.2" r="0.9">` +
    `<stop offset="0" stop-color="#ffffff" stop-opacity="0.42"/>` +
    `<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="256" height="256" fill="url(#g)"/><rect width="256" height="256" fill="url(#r)"/>` +
    `<text x="128" y="136" text-anchor="middle" dominant-baseline="middle" ` +
    `font-family="Segoe UI, Microsoft YaHei UI, sans-serif" font-weight="700" font-size="96" ` +
    `fill="#ffffff" fill-opacity="0.92">${letter}</text></svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  cache.set(key, url);
  return url;
}

/** 曲目封面（真实代理封面优先，缺省用程序化封面）。
 *  width 可选：给宿主 /api/cover 请求缩略图（32..1024），海报只显示约 150px、列表行更小，
 *  原图常见 2000~5000 像素，几百张同时驻留会把图片解码和显存拖爆。
 */
export function onlineArtwork(
  track: Pick<OnlineTrack, 'id' | 'title' | 'artist' | 'album' | 'cover'>,
  width = 0,
): string {
  return makeCover(track, width);
}

/** 预热封面，避免一次创建过多 canvas。 */
export function warmArtwork<T extends Pick<OnlineTrack, 'id' | 'title' | 'artist' | 'album' | 'cover'>>(
  tracks: T[],
  limit = 60,
): void {
  tracks.slice(0, limit).forEach((track) => onlineArtwork(track));
}
