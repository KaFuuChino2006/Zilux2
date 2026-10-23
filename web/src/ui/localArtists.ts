/** 本地曲库：按歌手聚合「本地艺术家」，头像取该歌手任一歌曲的内嵌封面。 */

import type { OnlineTrack } from '../online/types';
import { localLibrary, trackOf } from './local';

export interface LocalArtist {
  name: string;
  tracks: OnlineTrack[];
  /** 代表封面（来自歌曲内嵌封面；没有时为空串，用首字母占位）。 */
  cover: string;
}

/** 当前本地曲库的全部曲目（含下载目录合并项）。 */
export function localTracks(): OnlineTrack[] {
  const lib = localLibrary();
  if (!lib) return [];
  return lib.entries.map((entry) => trackOf(entry));
}

/** 按「歌手」把本地曲目聚合成艺术家列表；无歌手的归入「未知歌手」。 */
export function localArtists(): LocalArtist[] {
  const map = new Map<string, LocalArtist>();
  for (const track of localTracks()) {
    const name = (track.artist || '').trim() || '未知歌手';
    let artist = map.get(name);
    if (!artist) {
      artist = { name, tracks: [], cover: '' };
      map.set(name, artist);
    }
    artist.tracks.push(track);
    if (!artist.cover && track.cover) artist.cover = track.cover;
  }
  return [...map.values()].sort(
    (a, b) => b.tracks.length - a.tracks.length || a.name.localeCompare(b.name, 'zh'),
  );
}
