/**
 * 曲目「歌词人声区间」：第一句真正开始唱、最后一句唱完（曲内毫秒）。
 *
 * 用途：无缝衔接（crossfadeDeck）——
 * - B 的「开始唱词」安排过渡终点：前奏够长就跳过前奏、前奏比淡化还短就把整段前奏当过渡；
 * - A 的「最后一句唱完」实现「歌词衔接」：上一首末句刚落就接下一首首句（人声先出、伴奏渐入）。
 *
 * 数据源与歌词页一致：本地曲目同名 .lrc；在线曲目宿主 /api/lyric（LRC / YRC）。
 * 会过滤制作人员名单（作词/作曲/Lyrics by…）和纯音乐/间奏标记，避免首末句被这些行干扰。
 * 失败返回 null，调用方回退原逻辑（B 从第一个强拍起播）。结果按曲目缓存，同一首只拉一次。
 */

import { fetchLyric } from '../online/client';
import { singingRangeFromLrcText, singingRangeFromLyric, type SingingRange } from '../online/lyricRange';
import { fetchLocalLrc, lrcOf } from './local';
import type { OnlineTrack } from '../online/types';

const cache = new Map<string, SingingRange | null>();
/** 歌词接口超时：拿不到就回退普通淡化，不阻塞预排（约 1.5s 足够本地宿主返回）。 */
const FETCH_TIMEOUT_MS = 1_800;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('vocal-range timeout')), ms);
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

function cacheKey(track: OnlineTrack): string {
  return `${track.source}:${track.id}:${track.durationMs}`;
}

/** 曲目歌词人声区间；null = 无歌词 / 获取失败 / 全是制作人员行。 */
export async function fetchVocalRange(track: OnlineTrack | null): Promise<SingingRange | null> {
  if (!track) return null;
  const key = cacheKey(track);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let range: SingingRange | null = null;
  try {
    if (track.source === 'local') {
      const rel = lrcOf(track);
      if (rel) range = singingRangeFromLrcText(await withTimeout(fetchLocalLrc(rel), FETCH_TIMEOUT_MS));
    } else {
      const lyric = await withTimeout(fetchLyric(track.source, track.id), FETCH_TIMEOUT_MS);
      range = singingRangeFromLyric(lyric);
    }
  } catch {
    range = null;
  }
  cache.set(key, range);
  return range;
}

/** 曲目「开始唱词」位置（曲内毫秒）；null = 无歌词 / 获取失败。 */
export async function fetchVocalStartMs(track: OnlineTrack | null): Promise<number | null> {
  const range = await fetchVocalRange(track);
  return range && range.firstMs > 0 ? range.firstMs : null;
}

/** 清空缓存（例如切换曲库、手动换歌词后希望重新探测）。 */
export function clearVocalStartCache(): void {
  cache.clear();
}
