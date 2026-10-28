/**
 * 「唱片店」真实数据接入（R3.5）
 *
 * 把 今日推荐 / 我喜欢的音乐 / 最近播放 / 我的歌单 / 私人雷达 映射到现有在线音乐接口，
 * 供空间场景的菜单墙与大唱片架使用。数据都带真实封面 URL（宿主 cover 代理），
 * 场景侧按 URL 懒加载纹理，失败时回退到程序化封面。
 */

import { fetchLibraryOverview, fetchPlaylist, type MusicSource } from '../../core/library';
import { fetchFeed, fetchRecentMerged } from '../../online/client';
import type { OnlineTrack } from '../../online/types';
import type { StoreSceneCollection, StoreSceneSong } from './storeScene';

const MAX_SONGS = 30;

function toSong(track: OnlineTrack): StoreSceneSong {
  return {
    trackKey: `${track.source}:${track.id}`,
    title: track.title,
    artist: track.artist,
    album: track.album,
    coverUrl: track.cover || undefined,
    durationMs: track.durationMs,
  };
}

function dedupe(tracks: OnlineTrack[]): OnlineTrack[] {
  const seen = new Set<string>();
  const result: OnlineTrack[] = [];
  for (const track of tracks) {
    const key = `${track.source}:${track.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(track);
  }
  return result;
}

function interleave(groups: OnlineTrack[][]): OnlineTrack[] {
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

function songsOf(tracks: OnlineTrack[]): StoreSceneSong[] {
  return dedupe(tracks).slice(0, MAX_SONGS).map(toSong);
}

function playlistPage(source: MusicSource, id: string, special: 'liked' | null): Promise<OnlineTrack[]> {
  return fetchPlaylist(source, id, 0, special === 'liked' ? MAX_SONGS : 12, special)
    .then((detail) => detail.tracks)
    .catch(() => [] as OnlineTrack[]);
}

/**
 * 组装唱片店的分类数据。任一来源失败只跳过该分类，不阻塞其它分类；
 * 全部失败时返回空数组，调用方回退到演示数据。
 */
export async function loadStoreCollections(): Promise<StoreSceneCollection[]> {
  const overview = await fetchLibraryOverview().catch(() => null);
  const states = overview?.sources ?? [];
  const loggedStates = states.filter((state) => state.loggedIn);
  const likedStates = loggedStates.filter((state) => state.liked);

  const [dailyGroups, radarGroups, likedGroups, recentTracks, playlistGroups] = await Promise.all([
    Promise.all(
      loggedStates.map((state) =>
        fetchFeed(state.source, 'daily', MAX_SONGS)
          .then((feed) => feed.tracks)
          .catch(() => [] as OnlineTrack[]),
      ),
    ),
    Promise.all(
      loggedStates.map((state) =>
        fetchFeed(state.source, 'radar', MAX_SONGS)
          .then((feed) => feed.tracks)
          .catch(() => [] as OnlineTrack[]),
      ),
    ),
    Promise.all(likedStates.map((state) => playlistPage(state.source, state.liked!.id, 'liked'))),
    fetchRecentMerged(MAX_SONGS).catch(() => [] as OnlineTrack[]),
    Promise.all(
      loggedStates.map((state) =>
        (state.playlists ?? []).slice(0, 2).reduce<Promise<OnlineTrack[]>>(
          (previous, playlist) =>
            previous.then((acc) =>
              playlistPage(state.source, playlist.id, null).then((tracks) => acc.concat(tracks)),
            ),
          Promise.resolve([] as OnlineTrack[]),
        ),
      ),
    ),
  ]);

  const collections: StoreSceneCollection[] = [];
  const push = (id: string, title: string, subtitle: string, tracks: OnlineTrack[]): void => {
    const songs = songsOf(tracks);
    if (songs.length > 0) collections.push({ id, title, subtitle, songs });
  };

  push('daily', '今日推荐', '多平台每日推荐', interleave(dailyGroups));
  push('liked', '我喜欢的音乐', '收藏的唱片', interleave(likedGroups));
  push('recent', '最近播放', '最近在听的', recentTracks);
  push('playlists', '我的歌单', '全部歌单精选', interleave(playlistGroups));
  push('radar', '私人雷达', '为你推荐', interleave(radarGroups));
  return collections;
}
