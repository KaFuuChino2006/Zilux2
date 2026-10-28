/**
 * 音乐地铁图 · 分类板块数据（首页「大图标 = 站点」用）。
 *
 * 用户方向（2026-10-28 晚，第二轮）：
 *   「我要的不是点击之后进去展开，而是点击的图标本身就是一个站，点击之后自动延伸出去」
 * 因此首页不再有「分类页 / 线路页」两级导航：五个板块的大图标就是主干线上的五座车站，
 * 点一下就在原位向右侧延伸出该分类自己的线路。本模块只负责把 MetroData 映射成
 * 板块的数据条目（标题 / 线名 / 图标 / 色调 / 歌曲列表），视图与交互在 metroOverlay.ts。
 *
 * 该模块不依赖 DOM，也不依赖应用播放器，可在预览页 / 测试中复用。
 */

import type { MetroData, MetroLine, MetroLineSource, MetroSong, MetroTone } from './types';

/** 板块的固定顺序与标题（标题按用户原话：收藏 / 推荐 / 历史播放 / 热门歌单）。 */
interface GallerySpec {
  source: MetroLineSource;
  title: string;
  iconName: string;
}

const GALLERY_SPECS: readonly GallerySpec[] = [
  { source: 'liked', title: '收藏', iconName: 'heart' },
  { source: 'daily', title: '推荐', iconName: 'sparkle' },
  { source: 'recent', title: '历史播放', iconName: 'clock' },
  { source: 'playlist', title: '热门歌单', iconName: 'music' },
  { source: 'radar', title: '私人雷达', iconName: 'equalizer' },
];

/** 首页一个板块（= 主干线上的一座大图标车站）。 */
export interface MetroGalleryEntry {
  /** 线路 id。 */
  id: string;
  /** 板块标题：收藏 / 推荐 / 历史播放 / 热门歌单 / 私人雷达。 */
  title: string;
  /** 线路名（今日推荐线 / 我喜欢环线 …）。 */
  subtitle: string;
  /** 歌曲数（= 站点数）。 */
  count: number;
  /** 线路色调（决定图标 / 支线颜色）。 */
  tone: MetroTone;
  /** dom.ts 里的图标名。 */
  iconName: string;
  /** 线路内歌曲（按线内顺序）。 */
  songs: readonly MetroSong[];
}

/** 按线内顺序取出该线的歌曲（跳过数据里已不存在的站点）。 */
function songsOfLine(data: MetroData, line: MetroLine): MetroSong[] {
  const songs: MetroSong[] = [];
  for (const stationId of line.stationIds) {
    const station = data.stations[stationId];
    if (station) songs.push(station.song);
  }
  return songs;
}

/** MetroData → 板块列表（按 GALLERY_SPECS 顺序；缺数据的板块自动跳过）。 */
export function buildGalleryEntries(data: MetroData): MetroGalleryEntry[] {
  const entries: MetroGalleryEntry[] = [];
  for (const spec of GALLERY_SPECS) {
    const line = data.lines.find((item) => item.source === spec.source);
    if (line === undefined) continue;
    const songs = songsOfLine(data, line);
    if (songs.length === 0) continue;
    entries.push({
      id: line.id,
      title: spec.title,
      subtitle: line.name,
      count: songs.length,
      tone: line.tone,
      iconName: spec.iconName,
      songs,
    });
  }
  return entries;
}
