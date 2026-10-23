/** 没有内嵌封面（本地曲目常见）时，按歌名/歌手去线上平台找一张封面。 */

import { searchOnline } from './client';
import { sourceIds, sourceMeta } from './sources';
import type { OnlineTrack } from './types';

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function keyOf(track: OnlineTrack): string {
  return `${track.source}:${track.id}`;
}

function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\d{1,3}[\s._-]+/, '')
    .replace(/[\s\-_·・.,，。!！?？'"“”‘’()（）[\]【】]/g, '')
    .trim();
}

/** 清洗本地文件名里常见的编号/扩展名残留。 */
function cleanTitle(title: string): string {
  return title
    .replace(/^\d{1,3}[\s._-]+/, '')
    .replace(/\.(flac|wav|mp3|m4a|dsf|ape|ogg)$/i, '')
    .trim();
}

/**
 * 返回线上封面地址（宿主代理 URL）；找不到返回 null。
 * 已带封面的曲目直接返回原封面，不发起搜索。
 */
export function lookupCover(track: OnlineTrack): Promise<string | null> {
  if (track.cover) return Promise.resolve(track.cover);
  const key = keyOf(track);
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const running = inflight.get(key);
  if (running) return running;

  const title = cleanTitle(track.title);
  const artist = track.artist.trim();
  const query = artist && !title.includes(artist) ? `${title} ${artist}` : title;

  const task = (async (): Promise<string | null> => {
    for (const source of sourceIds().filter((id) => sourceMeta(id).experimental !== true)) {
      let tracks: OnlineTrack[] = [];
      try {
        tracks = (await searchOnline(source, query, 6)).tracks;
      } catch {
        continue;
      }
      const withCover = tracks.filter((item) => item.cover);
      if (withCover.length === 0) continue;
      const exact = withCover.find((item) => norm(item.title) === norm(title));
      const picked = exact ?? withCover[0]!;
      cache.set(key, picked.cover);
      return picked.cover;
    }
    cache.set(key, null);
    return null;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, task);
  return task;
}
