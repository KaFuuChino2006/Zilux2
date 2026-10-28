/**
 * 音乐集合数据层（M2）：今日推荐 / 我喜欢的音乐 / 最近播放 / 我的歌单 / 私人雷达。
 *
 * 3D「唱片店」与「音乐地铁图」共用这一份抓取逻辑（原 space/storeCollections.ts 抽出），避免两套
 * 复制粘贴。口径与 R3.5 完全一致：
 *   - 今日推荐 / 私人雷达：每个「已登录」平台各拉 MAX_SONGS 首后跨平台交错；
 *   - 我喜欢的音乐：只拉「已登录且已收藏（liked）」的平台；
 *   - 最近播放：跨平台合并（不要求登录，但 overview 成功才会尝试）；
 *   - 我的歌单：每个已登录平台取前 2 个歌单，曲目顺序拼接成该平台一组（组列表按平台顺序）；
 *   - 每类按 trackKey 去重后最多保留 MAX_SONGS 首。
 *
 * 容错：任一来源失败只跳过该来源，不抛错；overview 失败时返回全空集合（契约 §2）。
 */

import { fetchLibraryOverview, fetchPlaylist, type LibraryPlaylist, type MusicSource } from '../../core/library';
import { fetchFeed, fetchRecentMerged } from '../../online/client';
import type { OnlineTrack } from '../../online/types';

/** 每类数据的保留上限（与旧 storeCollections 一致）。 */
export const MAX_SONGS = 30;

/** 一个歌单及其曲目（地铁图「歌单线」取第一个）。 */
export interface MusicPlaylistGroup {
  /** 平台歌单信息（title/cover/count；id 已按 special 处理过） */
  playlist: LibraryPlaylist;
  tracks: OnlineTrack[];
}

/** 5 类真实音乐集合；字段为空数组表示该来源失败或无数据。 */
export interface MusicCollections {
  /** 今日推荐（多平台交错） */
  daily: OnlineTrack[];
  /** 我喜欢的音乐（多平台交错） */
  liked: OnlineTrack[];
  /** 最近播放（跨平台合并） */
  recent: OnlineTrack[];
  /** 我的歌单（每个平台一组：前 2 个歌单曲目顺序拼接，组列表按平台顺序） */
  playlists: MusicPlaylistGroup[];
  /** 私人雷达（多平台交错） */
  radar: OnlineTrack[];
}

/** 平台歌曲 → `source:id` 全局唯一键（跨平台不会撞、同平台 id 唯一）。 */
export function trackKeyOf(track: OnlineTrack): string {
  return `${track.source}:${track.id}`;
}

/** 按 trackKey 去重 + 截断，保持原有顺序。 */
export function uniqueTracks(tracks: OnlineTrack[], limit: number): OnlineTrack[] {
  const seen = new Set<string>();
  const result: OnlineTrack[] = [];
  for (const track of tracks) {
    if (result.length >= limit) break;
    const key = trackKeyOf(track);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(track);
  }
  return result;
}

/** 多组曲目按「轮流取每组第 n 首」交错，保持各组内部顺序（多平台混排用）。 */
export function interleaveTracks(groups: OnlineTrack[][]): OnlineTrack[] {
  const result: OnlineTrack[] = [];
  const longest = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < longest; index += 1) {
    for (const group of groups) {
      const track = group[index];
      if (track) result.push(track);
    }
  }
  return result;
}

/** 单个平台的信息流（每日推荐 / 私人雷达）；失败返回空数组。 */
function feedTracks(source: MusicSource, kind: 'daily' | 'radar'): Promise<OnlineTrack[]> {
  return fetchFeed(source, kind, MAX_SONGS)
    .then((feed) => feed.tracks)
    .catch(() => [] as OnlineTrack[]);
}

/** 单个歌单曲目：liked 走 special 映射（拉 MAX_SONGS），普通歌单只取前 12 首；失败返回空数组。 */
function playlistTracks(source: MusicSource, id: string, special: 'liked' | null): Promise<OnlineTrack[]> {
  return fetchPlaylist(source, id, 0, special === 'liked' ? MAX_SONGS : 12, special)
    .then((detail) => detail.tracks)
    .catch(() => [] as OnlineTrack[]);
}

/** 空集合（overview 失败时直接返回，五类皆空）。 */
function emptyCollections(): MusicCollections {
  return { daily: [], liked: [], recent: [], playlists: [], radar: [] };
}

/**
 * 拉取 5 类数据。任一来源失败只跳过该来源，不抛错；overview 失败时五类皆空。
 * 拉取顺序与旧 storeCollections 一致（并行 Promise.all，歌单按槽位分组）。
 */
export async function loadMusicCollections(): Promise<MusicCollections> {
  const overview = await fetchLibraryOverview().catch(() => null);
  if (!overview) return emptyCollections();

  const states = overview.sources;
  const loggedStates = states.filter((state) => state.loggedIn);
  const likedStates = loggedStates.filter((state) => state.liked);

  // 歌单最多取每个平台的前 2 个：曲目顺序拼接成该平台一组，组列表保持平台顺序
  // （storeCollections 再按平台交错，还原 3D 墙面原有顺序）。
  const [dailyGroups, radarGroups, likedGroups, recentTracks, playlistGroups] = await Promise.all([
    Promise.all(loggedStates.map((state) => feedTracks(state.source, 'daily'))),
    Promise.all(loggedStates.map((state) => feedTracks(state.source, 'radar'))),
    Promise.all(likedStates.map((state) => playlistTracks(state.source, state.liked!.id, 'liked'))),
    fetchRecentMerged(MAX_SONGS).catch(() => [] as OnlineTrack[]),
    Promise.all(
      loggedStates.map((state): Promise<MusicPlaylistGroup | null> => {
        const playlists = (state.playlists ?? []).slice(0, 2);
        if (playlists.length === 0) return Promise.resolve(null);
        return Promise.all(playlists.map((playlist) => playlistTracks(state.source, playlist.id, null))).then((batches) => {
          const tracks = batches.flat();
          // 空歌单（拉取失败/无曲目）不占位，保证 playlists[0] 一定有曲目可用。
          return tracks.length > 0 ? { playlist: playlists[0], tracks } : null;
        });
      }),
    ),
  ]);

  return {
    daily: uniqueTracks(interleaveTracks(dailyGroups), MAX_SONGS),
    liked: uniqueTracks(interleaveTracks(likedGroups), MAX_SONGS),
    recent: uniqueTracks(recentTracks, MAX_SONGS),
    playlists: playlistGroups.filter((group): group is MusicPlaylistGroup => group !== null),
    radar: uniqueTracks(interleaveTracks(radarGroups), MAX_SONGS),
  };
}
