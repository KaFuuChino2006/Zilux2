/**
 * MG 画布（首页平面世界）的数据模型与静态配置。
 *
 * 这里只放纯数据 / 纯函数，不碰 DOM，方便 app.ts 只依赖 fromHomeData() 把
 * 首页数据转成画布输入；具体渲染见 mgplane.ts。
 */

import type { OnlineTrack } from '../../online/types';
import type { HomeData } from '../home';

/** 画布上可「打开列表」的分类（与 callbacks.openList 对齐）。 */
export type MgListKind = 'daily' | 'recent' | 'liked' | 'radar' | 'local';

/** 画布向外抛的所有交互回调（由 app.ts 提供，模块自身不直接跳转/开播）。 */
export interface MgPlaneCallbacks {
  play(tracks: OnlineTrack[], index: number, scope: MgListKind): void;
  openList(kind: MgListKind): void;
  search(): void;
  login(): void;
  /** 打开「发现」页（原左侧栏「发现」）。 */
  discover(): void;
  /** 打开「我的歌单」浮层（原左侧栏「我的歌单」）。 */
  myPlaylists(): void;
  /** 打开设置浮层（原左侧栏底部「设置」）。 */
  settings(): void;
  /** 打开账号面板（原顶栏账号入口）。 */
  account(): void;
  /** 打开歌词浮层（原播放条歌词入口）。 */
  lyrics(): void;
  /** 当前歌词窗口（供播放台展示；无歌词时为空串）。 */
  lyric(): { prev: string; now: string; next: string };
  /** 世界列表滚动到底部时按需加载更多曲目（返回空数组表示已经到底）。 */
  moreTracks(kind: MgListKind, offset: number, limit: number): Promise<OnlineTrack[]>;
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
};

/** 有限世界尺寸（世界单位；缩放 z=1 时 1 单位 = 1 CSS 像素）。 */
export const MG_WORLD_W = 6000;
export const MG_WORLD_H = 3400;
/** 安全边：相机中心限制在世界内缩 400 单位范围内。 */
export const MG_SAFE = 400;

/** 分区表 + 中心 NOW 的世界坐标（区中心点）。
 *
 * 画布上已经没有分区：2026-10-29 按用户要求先删掉画布内的歌单 / 分类展示
 * （今日推荐 / 最近播放 / 我喜欢的音乐 / 私人雷达），随后又把最后剩下的「本地曲库」
 * 也删了。现在整张平面只有中心 NOW 一张卡；分区数据结构保留，方便以后加回来。
 */
export interface MgZoneSpec {
  kind: MgListKind;
  no: string;
  en: string;
  cn: string;
  hint: string;
  x: number;
  y: number;
}

export const MG_ZONES: MgZoneSpec[] = [];

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
 * 合并去重（卡片最多 5 首），likedCount 取各卡片 count 之和。
 * 画布当前只渲染「本地曲库」一个分区（歌单 / 其它分类区都只在经典首页与浮层里出现），
 * 这里搬运的几组曲目数据保留给后续分区复用。
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
  };
}
