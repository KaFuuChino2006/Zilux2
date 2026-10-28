/**
 * 「唱片店」真实数据接入（R3.5）
 *
 * 数据抓取已抽到 ui/shared/musicCollections（与「音乐地铁图」共用），本文件只负责把 5 类
 * 音乐集合映射成空间场景的 StoreSceneCollection[]：今日推荐 / 我喜欢的音乐 / 最近播放 /
 * 我的歌单 / 私人雷达。数据都带真实封面 URL（宿主 cover 代理），场景侧按 URL 懒加载纹理，
 * 失败时回退到程序化封面。
 *
 * 对外签名与返回结构、3D 墙面/唱片架行为均与抽取前一致。
 */

import { MAX_SONGS, interleaveTracks, loadMusicCollections, uniqueTracks } from '../shared/musicCollections';
import type { OnlineTrack } from '../../online/types';
import type { StoreSceneCollection, StoreSceneSong } from './storeScene';

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

/** 去重 + 截断 + 映射成场景歌曲（顺序不变）。 */
function songsOf(tracks: OnlineTrack[]): StoreSceneSong[] {
  return uniqueTracks(tracks, MAX_SONGS).map(toSong);
}

/**
 * 组装唱片店的分类数据。任一来源失败只跳过该分类，不阻塞其它分类；
 * 全部失败时返回空数组，调用方回退到演示数据。
 */
export async function loadStoreCollections(): Promise<StoreSceneCollection[]> {
  const data = await loadMusicCollections();

  // 我的歌单：shared 里每个平台一组（前 2 个歌单曲目顺序拼接），这里按平台交错、再走
  // songsOf，与抽取前的墙面歌曲顺序完全一致。
  const playlistTracks = interleaveTracks(data.playlists.map((group) => group.tracks));

  const collections: StoreSceneCollection[] = [];
  const push = (id: string, title: string, subtitle: string, tracks: OnlineTrack[]): void => {
    const songs = songsOf(tracks);
    if (songs.length > 0) collections.push({ id, title, subtitle, songs });
  };

  push('daily', '今日推荐', '多平台每日推荐', data.daily);
  push('liked', '我喜欢的音乐', '收藏的唱片', data.liked);
  push('recent', '最近播放', '最近在听的', data.recent);
  push('playlists', '我的歌单', '全部歌单精选', playlistTracks);
  push('radar', '私人雷达', '为你推荐', data.radar);
  return collections;
}
