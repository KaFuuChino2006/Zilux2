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

function makeCover(track: Pick<OnlineTrack, 'id' | 'title' | 'artist' | 'album' | 'cover'>): string {
  const remapped = rebindCover(track.cover);
  if (remapped) return remapped;
  const key = `${track.id}:art`;
  const cached = cache.get(key);
  if (cached) return cached;
  const palette = PALETTES[hash(track.id) % PALETTES.length] ?? PALETTES[0]!;
  const [a, b] = palette;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const gradient = ctx.createLinearGradient(0, 0, 256, 256);
  gradient.addColorStop(0, b);
  gradient.addColorStop(1, a);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  const glow = ctx.createRadialGradient(190, 50, 6, 190, 50, 240);
  glow.addColorStop(0, 'rgba(255,255,255,0.42)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = '700 96px "Segoe UI", "Microsoft YaHei UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((track.title.trim()[0] ?? '♪').toUpperCase(), 128, 136);
  const url = canvas.toDataURL('image/jpeg', 0.86);
  cache.set(key, url);
  return url;
}

/** 曲目封面（真实代理封面优先，缺省用程序化封面）。 */
export function onlineArtwork(
  track: Pick<OnlineTrack, 'id' | 'title' | 'artist' | 'album' | 'cover'>,
): string {
  return makeCover(track);
}

/** 预热封面，避免一次创建过多 canvas。 */
export function warmArtwork<T extends Pick<OnlineTrack, 'id' | 'title' | 'artist' | 'album' | 'cover'>>(
  tracks: T[],
  limit = 60,
): void {
  tracks.slice(0, limit).forEach((track) => onlineArtwork(track));
}
