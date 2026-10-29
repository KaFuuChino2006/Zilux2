/**
 * MG 画布（首页平面世界）的数据模型与静态配置。
 *
 * 这里只放纯数据 / 纯函数，不碰 DOM，方便 app.ts 只依赖 fromHomeData() 把
 * 首页数据转成画布输入；具体渲染见 mgplane.ts。
 */

import type { LibraryPlaylist } from '../../core/library';
import type { OnlineTrack } from '../../online/types';
import type { HomeData } from '../home';

/** 画布上可「打开列表」的分类（与 callbacks.openList 对齐）。 */
export type MgListKind = 'daily' | 'recent' | 'liked' | 'radar' | 'local';

/** 画布向外抛的所有交互回调（由 app.ts 提供，模块自身不直接跳转/开播）。 */
export interface MgPlaneCallbacks {
  play(tracks: OnlineTrack[], index: number, scope: MgListKind | 'playlist'): void;
  openList(kind: MgListKind): void;
  search(): void;
  login(): void;
  openPlaylist(item: LibraryPlaylist): void;
}

/** 画布渲染所需的全部数据（首页每次刷新时整体传入，模块内部做增量）。 */
export interface MgPlaneData {
  loggedIn: boolean;
  localCount: number;
  daily: OnlineTrack[];
  recent: OnlineTrack[];
  likedTracks: OnlineTrack[];
  likedCount: number;
  radarAvailable: boolean;
  radar: OnlineTrack[];
  playlists: LibraryPlaylist[];
}

/** 空数据（未登录、宿主未就绪时先用它渲染骨架）。 */
export const MG_EMPTY_DATA: MgPlaneData = {
  loggedIn: false,
  localCount: 0,
  daily: [],
  recent: [],
  likedTracks: [],
  likedCount: 0,
  radarAvailable: false,
  radar: [],
  playlists: [],
};

/** 有限世界尺寸（世界单位；缩放 z=1 时 1 单位 = 1 CSS 像素）。 */
export const MG_WORLD_W = 6000;
export const MG_WORLD_H = 3400;
/** 安全边：相机中心限制在世界内缩 400 单位范围内。 */
export const MG_SAFE = 400;

/** 六个分类区 + 中心 NOW + 歌单区的世界坐标（区中心点）。 */
export interface MgZoneSpec {
  kind: MgListKind;
  no: string;
  en: string;
  cn: string;
  hint: string;
  x: number;
  y: number;
}

export const MG_ZONES: MgZoneSpec[] = [
  { kind: 'daily', no: '01', en: 'DAILY', cn: '今日推荐', hint: '每天 6:00 更新', x: 1500, y: 900 },
  { kind: 'recent', no: '02', en: 'RECENT', cn: '最近播放', hint: '按播放时间排序', x: 4500, y: 900 },
  { kind: 'liked', no: '03', en: 'LIKED', cn: '我喜欢的音乐', hint: '收藏过的曲目', x: 1500, y: 2520 },
  { kind: 'radar', no: '06', en: 'RADAR', cn: '私人雷达', hint: '只属于你的推荐', x: 3000, y: 3020 },
  { kind: 'local', no: '05', en: 'LOCAL', cn: '本地曲库', hint: '本地文件与收藏', x: 3000, y: 560 },
];

/** 歌单区（点击展开曲目环，不进入 openList）。 */
export const MG_PLAYLIST_ZONE = { no: '04', en: 'PLAYLISTS', cn: '热门歌单', x: 4500, y: 2520 };

/** 中心 NOW 封面与标题排版锚点。 */
export const MG_NOW = { x: 2280, y: 1360 };

/** 每个分类的展示曲目（截断到画布上实际渲染的数量，避免可见封面过多）。 */
export const MG_ZONE_LIMIT: Record<MgListKind, number> = {
  daily: 9,
  recent: 5,
  liked: 8,
  radar: 6,
  local: 5,
};

export function mgZoneTracks(data: MgPlaneData, kind: MgListKind): OnlineTrack[] {
  const source = kind === 'daily' ? data.daily : kind === 'recent' ? data.recent : kind === 'liked' ? data.likedTracks : kind === 'radar' ? data.radar : [];
  return source.slice(0, MG_ZONE_LIMIT[kind]);
}

/** 曲目唯一键（source + id）。 */
export function mgTrackKey(track: OnlineTrack): string {
  return `${track.source}:${track.id}`;
}

/** 毫秒 → 3:48 形式（曲目时长用）。 */
export function mgDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 是否本地来源（本地曲库不做在线收藏）。 */
export function mgIsLocal(track: OnlineTrack): boolean {
  return track.source === 'local';
}

/**
 * 首页数据 → 画布数据。
 *
 * HomeData 里没有单独的 likedTracks：用各平台「我喜欢的音乐」收藏卡片里的前几首
 * 合并去重（卡片最多 5 首，足够铺 03 区的 8 格）；likedCount 取各卡片 count 之和。
 */
export function fromHomeData(data: HomeData): MgPlaneData {
  const likedTracks: OnlineTrack[] = [];
  const seen = new Set<string>();
  for (const collection of data.collections) {
    for (const track of collection.tracks) {
      const key = mgTrackKey(track);
      if (seen.has(key)) continue;
      seen.add(key);
      likedTracks.push(track);
    }
  }
  const likedCount = data.collections.reduce((sum, item) => sum + Math.max(0, item.count), 0);
  return {
    loggedIn: data.loggedIn,
    localCount: data.localCount,
    daily: data.daily,
    recent: data.recent,
    likedTracks,
    likedCount: likedCount > 0 ? likedCount : likedTracks.length,
    radarAvailable: data.radarAvailable,
    radar: data.radar,
    playlists: data.playlists,
  };
}
