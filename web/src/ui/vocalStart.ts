/**
 * 下一首「开始唱词」位置（曲内毫秒）：歌词首行的时间。
 *
 * 用途：无缝衔接（crossfadeDeck）按它安排 B 的起播点——
 * - 前奏够长：从「唱词前 fadeMs」处起播，淡化结束时正好进入唱词（跳过更早的纯前奏）；
 * - 前奏比淡化还短：把整段前奏当作过渡，淡化终点落在唱词起点。
 *
 * 数据源与歌词页一致：本地曲目同名 .lrc；在线曲目宿主 /api/lyric（LRC / YRC）。失败返回 null，
 * 调用方回退原逻辑（B 从第一个强拍起播）。结果按曲目缓存，同一首只拉一次。
 */

import { fetchLyric } from '../online/client';
import { parseLrc } from '../online/lrc';
import { fetchLocalLrc, lrcOf } from './local';
import type { OnlineTrack } from '../online/types';

const cache = new Map<string, number>();
/** 歌词接口超时：拿不到就回退普通淡化，不阻塞预排（约 1.5s 足够本地宿主返回）。 */
const FETCH_TIMEOUT_MS = 1_800;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('vocal-start timeout')), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** 取歌词第一句有效人声的时间（毫秒）；跳过纯空白/纯装饰行。 */
function firstLineMs(raw: string | null | undefined): number {
  if (!raw) return 0;
  if (/^\s*\[\d+,\d+\]/.test(raw)) {
    // YRC 逐字：行格式 [startMs,durationMs](...)，没有标准 LRC 头时按它取最早一行。
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*\[(\d+),(\d+)\]/.exec(line);
      if (!match) continue;
      const startMs = Number(match[1]);
      const text = line.replace(/^\s*\[\d+,\d+\]/, '').replace(/\(\d+,\d+\)/g, '');
      if (Number.isFinite(startMs) && startMs > 0 && /[\p{L}\p{N}]/u.test(text)) return startMs;
    }
    return 0;
  }
  for (const line of parseLrc(raw)) {
    const text = (line.text ?? '').trim();
    if (line.timeMs > 0 && /[\p{L}\p{N}]/u.test(text)) return Math.round(line.timeMs);
  }
  return 0;
}

function cacheKey(track: OnlineTrack): string {
  return `${track.source}:${track.id}:${track.durationMs}`;
}

/** 曲目「开始唱词」位置（曲内毫秒）；null = 无歌词 / 获取失败。 */
export async function fetchVocalStartMs(track: OnlineTrack | null): Promise<number | null> {
  if (!track) return null;
  const key = cacheKey(track);
  const hit = cache.get(key);
  if (hit !== undefined) return hit > 0 ? hit : null;
  try {
    let ms = 0;
    if (track.source === 'local') {
      const rel = lrcOf(track);
      if (rel) ms = firstLineMs(await withTimeout(fetchLocalLrc(rel), FETCH_TIMEOUT_MS));
    } else {
      const lyric = await withTimeout(fetchLyric(track.source, track.id), FETCH_TIMEOUT_MS);
      ms = firstLineMs(lyric.lrc) || firstLineMs(lyric.yrc);
    }
    cache.set(key, ms);
    return ms > 0 ? ms : null;
  } catch {
    cache.set(key, 0);
    return null;
  }
}

/** 清空缓存（例如切换曲库、手动换歌词后希望重新探测）。 */
export function clearVocalStartCache(): void {
  cache.clear();
}
