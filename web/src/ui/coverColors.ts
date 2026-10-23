/**
 * 封面取色：把封面缩到 40×40，按面积统计主色，返回主色 + 渐变用的配色。
 * 结果按曲目缓存，避免每次切歌重复解码。
 */
import type { OnlineTrack } from '../online/types';
import { fetchCoverColors } from '../online/client';
import { host } from '../core/bridge';

export interface CoverColors {
  /** 占比最高的颜色（#rrggbb）。 */
  dominant: string;
  /** 由主色派生的配色，至少 3 个，用于自动渐变。 */
  palette: string[];
}

const cache = new Map<string, CoverColors | null>();
const inflight = new Map<string, Promise<CoverColors | null>>();

function keyOf(track: OnlineTrack): string {
  return `${track.source}:${track.id}:${track.cover ?? ''}`;
}

function hex(r: number, g: number, b: number): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return `#${[r, g, b].map((value) => clamp(value).toString(16).padStart(2, '0')).join('')}`;
}

function hueOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) {
    return 0;
  }
  let hue: number;
  if (max === r) {
    hue = ((g - b) / delta) % 6;
  } else if (max === g) {
    hue = (b - r) / delta + 2;
  } else {
    hue = (r - g) / delta + 4;
  }
  return (hue * 60 + 360) % 360;
}

function shift(color: string, degree: number, lightnessScale = 1): string {
  const value = color.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const hue = (hueOf(r, g, b) + degree + 360) % 360;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = ((max + min) / 2 / 255) * lightnessScale;
  const delta = max - min;
  const s = delta === 0 ? 0 : delta / (255 - Math.abs(max + min - 255));
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - chroma / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [chroma, x, 0];
  else if (hue < 120) rgb = [x, chroma, 0];
  else if (hue < 180) rgb = [0, chroma, x];
  else if (hue < 240) rgb = [0, x, chroma];
  else if (hue < 300) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];
  return hex((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255);
}

function buildPalette(dominant: string): string[] {
  return [dominant, shift(dominant, 26, 1.16), shift(dominant, -30, 0.78)];
}

function quantize(data: Uint8ClampedArray): CoverColors | null {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha < 128) {
      continue;
    }
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // 过暗/过亮/接近灰的颜色不参与主色统计，避免大面积黑边或白底。
    if (lum < 26 || lum > 232 || max - min < 10) {
      continue;
    }
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const found = buckets.get(key);
    if (found) {
      found.count += 1;
      found.r += r;
      found.g += g;
      found.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }
  if (buckets.size === 0) {
    return null;
  }
  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
  const picked: Array<[number, number, number]> = [];
  const pickedHex: string[] = [];
  for (const bucket of sorted) {
    const r = bucket.r / bucket.count;
    const g = bucket.g / bucket.count;
    const b = bucket.b / bucket.count;
    const tooClose = picked.some(([pr, pg, pb]) => {
      const distance = Math.abs(pr - r) + Math.abs(pg - g) + Math.abs(pb - b);
      return distance < 72;
    });
    if (tooClose) {
      continue;
    }
    picked.push([r, g, b]);
    pickedHex.push(hex(r, g, b));
    if (picked.length >= 3) {
      break;
    }
  }
  const dominant = pickedHex[0] ?? '#8a8f9c';
  const palette = pickedHex.slice();
  while (palette.length < 3) {
    palette.push(buildPalette(dominant)[palette.length] ?? dominant);
  }
  return { dominant, palette };
}

function sampleImage(image: HTMLImageElement, url: string): Uint8ClampedArray | null {
  try {
    const size = 40;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return null;
    }
    context.drawImage(image, 0, 0, size, size);
    return context.getImageData(0, 0, size, size).data;
  } catch {
    void url;
    return null;
  }
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

async function readPixels(url: string): Promise<Uint8ClampedArray | null> {
  // 优先用 <img crossOrigin>（不触发 Chromium 对 localhost 的 Private-Network 预检）
  const image = await loadImage(url);
  if (image) {
    const data = sampleImage(image, url);
    if (data) {
      return data;
    }
  }
  try {
    const response = await fetch(url, { cache: 'force-cache', mode: 'cors' });
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 40;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      bitmap.close();
      return null;
    }
    context.drawImage(bitmap, 0, 0, 40, 40);
    bitmap.close();
    return context.getImageData(0, 0, 40, 40).data;
  } catch {
    return null;
  }
}

/** 从代理封面地址里解析出宿主取色需要的 source/key。 */
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

/** 本地无封面时用标题算一个稳定的兜底渐变。 */
export function fallbackColors(seed: string): CoverColors {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const hue = Math.abs(hash) % 360;
  const dominant = `hsl(${hue} 42% 62%)`;
  return {
    dominant,
    palette: [`hsl(${hue} 42% 62%)`, `hsl(${(hue + 28) % 360} 46% 70%)`, `hsl(${(hue + 330) % 360} 38% 46%)`],
  };
}
