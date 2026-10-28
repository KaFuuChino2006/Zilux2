/**
 * 「音乐地铁图」M2 数据层：真实音乐集合 → MetroData（只有线路/站点关系，坐标由布局层计算）。
 *
 * 五条线固定顺序 daily → liked → recent → playlist → radar，与 metroLayout 按 line.source
 * 选模板的顺序一致（契约 §3.1）：
 *   daily    今日推荐线  sunrise  普通  20 站
 *   liked    我喜欢环线  rose     环线  16 站（loop；空则整线隐藏）
 *   recent   最近播放线  sea      普通  18 站
 *   playlist 歌单线      forest   普通  16 站（取第一个歌单；空则整线隐藏）
 *   radar    私人雷达线  ghost    虚线  12 站（dashed）
 *
 * 换乘（契约 §3.2）：站点 id 直接用 `trackKeyOf`（`source:id`），同一首歌出现在多条线上时
 * 天然合并成一个站；`lineIds` 按线顺序 push、`indexInLine` 记录线内序号、`type` 按引用线数
 * 与端点位置推导。纯函数、确定性（不随机、不依赖对象键顺序做语义）。
 */

import type { MetroData, MetroLine, MetroLineSource, MetroSong, MetroStationSeed, MetroTone } from './types';
import { loadMusicCollections, trackKeyOf, uniqueTracks, type MusicCollections } from '../shared/musicCollections';
import type { OnlineTrack } from '../../online/types';

export interface MetroDataOptions {
  /** 每条线最多站数；默认 20（五线表里 16/18/12 更小的取更小值） */
  stationsPerLine?: number;
  /** 换乘检测：默认按同歌曲（trackKey）；'song+artist' 预留，本轮不实现 */
  transferBy?: 'song' | 'song+artist';
}

/** 五线表的静态部分；tracks / subtitle 按真实数据在 build 阶段填充。 */
interface LineSpec {
  id: 'daily' | 'liked' | 'recent' | 'playlist' | 'radar';
  name: string;
  /** 固定副标题；playlist 用第一个歌单的标题覆盖 */
  subtitle: string;
  tone: MetroTone;
  loop: boolean;
  dashed: boolean;
  source: MetroLineSource;
  /** 该线站数上限（契约 §3.1 表格） */
  limit: number;
}

/** 五线表（顺序＝线路顺序＝布局模板优先级）。 */
const LINE_SPECS: ReadonlyArray<LineSpec> = [
  {
    id: 'daily',
    name: '今日推荐线',
    subtitle: '多平台每日推荐',
    tone: 'sunrise',
    loop: false,
    dashed: false,
    source: 'daily',
    limit: 20,
  },
  {
    id: 'liked',
    name: '我喜欢环线',
    subtitle: '收藏的一圈一圈',
    tone: 'rose',
    loop: true,
    dashed: false,
    source: 'liked',
    limit: 16,
  },
  {
    id: 'recent',
    name: '最近播放线',
    subtitle: '最近在听的',
    tone: 'sea',
    loop: false,
    dashed: false,
    source: 'recent',
    limit: 18,
  },
  {
    id: 'playlist',
    name: '歌单线',
    subtitle: '',
    tone: 'forest',
    loop: false,
    dashed: false,
    source: 'playlist',
    limit: 16,
  },
  {
    id: 'radar',
    name: '私人雷达线',
    subtitle: '为你推荐',
    tone: 'ghost',
    loop: false,
    dashed: true,
    source: 'radar',
    limit: 12,
  },
];

/** 取某条线的原始曲目（playlist 线取第一个歌单；其余直接取对应集合）。 */
function tracksOf(collections: MusicCollections, lineId: LineSpec['id']): OnlineTrack[] {
  switch (lineId) {
    case 'daily':
      return collections.daily;
    case 'liked':
      return collections.liked;
    case 'recent':
      return collections.recent;
    case 'playlist':
      return collections.playlists[0]?.tracks ?? [];
    case 'radar':
      return collections.radar;
  }
}

/** 平台歌曲 → 站点上的歌；album/cover 的空串归一为 undefined（渲染层按「有值才显示」处理）。 */
function toMetroSong(track: OnlineTrack): MetroSong {
  return {
    trackKey: trackKeyOf(track),
    title: track.title,
    artist: track.artist,
    album: track.album || undefined,
    coverUrl: track.cover || undefined,
    durationMs: track.durationMs,
    source: track.source,
    id: track.id,
  };
}

/**
 * 纯函数：MusicCollections → MetroData。
 *
 * - 每线按 trackKey 去重后取前 N 首（N 取五线表上限与 stationsPerLine 的较小值），保留原顺序；
 * - 空线直接不输出（不占位），全部为空时返回 `{ lines: [], stations: {} }`；
 * - 跨线同 trackKey 合并为同一个 `MetroStationSeed`（换乘站）。
 */
export function buildMetroData(collections: MusicCollections, options?: MetroDataOptions): MetroData {
  const stationsPerLine = Math.max(0, Math.floor(options?.stationsPerLine ?? 20));
  const firstPlaylist = collections.playlists[0];
  const stations: Record<string, MetroStationSeed> = {};
  const lines: MetroLine[] = [];

  for (const spec of LINE_SPECS) {
    const limit = Math.min(spec.limit, stationsPerLine);
    const tracks = uniqueTracks(tracksOf(collections, spec.id), limit);
    // 空线隐藏（不输出占位线路）。
    if (tracks.length === 0) continue;

    const stationIds: string[] = [];
    for (const track of tracks) {
      const id = trackKeyOf(track);
      let station = stations[id];
      if (!station) {
        station = {
          id,
          song: toMetroSong(track),
          lineIds: [],
          indexInLine: {},
          type: 'single',
        };
        stations[id] = station;
      }
      // 跨线同歌：lineIds 按线路顺序记录，indexInLine 记本线内序号（同线内已由 uniqueTracks 去重）。
      station.lineIds.push(spec.id);
      station.indexInLine[spec.id] = stationIds.length;
      stationIds.push(id);
    }

    lines.push({
      id: spec.id,
      name: spec.name,
      subtitle: spec.id === 'playlist' ? (firstPlaylist?.playlist.title ?? '') : spec.subtitle,
      tone: spec.tone,
      loop: spec.loop,
      dashed: spec.dashed,
      stationIds,
      source: spec.source,
    });
  }

  // 第二遍：type 依赖「被几条线引用」，必须等全部线路建完。
  for (const line of lines) {
    const lastIndex = line.stationIds.length - 1;
    line.stationIds.forEach((stationId, index) => {
      const station = stations[stationId];
      if (station.lineIds.length > 1) station.type = 'transfer';
      else station.type = index === 0 || index === lastIndex ? 'terminus' : 'single';
    });
  }

  return { lines, stations };
}

/**
 * 拉真实数据并建图（应用内入口用）。全部来源失败 / 无数据时返回空图
 * （overlay 以 `lines.length === 0` 判空态），不向调用方抛错。
 */
export async function loadMetroData(options?: MetroDataOptions): Promise<MetroData> {
  try {
    const collections = await loadMusicCollections();
    return buildMetroData(collections, options);
  } catch (error) {
    // loadMusicCollections 内部已逐来源容错，这里只兜底极端情况（如宿主桥异常）。
    console.warn('[metro] 加载真实数据失败，使用空线路图', error);
    return { lines: [], stations: {} };
  }
}
