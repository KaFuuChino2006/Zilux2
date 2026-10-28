/**
 * 「音乐地铁图」类型定义（M1 假数据原型 → M2 真实数据）。
 *
 * 两层数据：
 *   1. `MetroData`：只描述「有哪些线路、哪些站、谁属于谁」，**没有坐标**（数据层产出，M1 由 metroPreview.mockMetroData 生成）；
 *   2. `MetroMap`：`MetroData` 经 `layoutMetro()` 计算后，每个站有世界坐标 + 整图 bounds（渲染层输入）。
 *
 * 约定：
 *   - 世界坐标单位 = px，zoom 1 时 1:1（方案 §7.5）；
 *   - 同一首歌出现在 ≥2 条线上 = 换乘站：同一个 `station.id` 被多条 `line.stationIds` 引用，
 *     物理上只有一个站、一份坐标（M2 由换乘检测合并出来，M1 由假数据直接给出）；
 *   - 环线（`loop`）的 `stationIds` 首尾不重复，最后一段闭合由渲染层补上；
 *   - `lineIds` / `indexInLine` 由数据层负责维护正确，渲染层不再推导。
 */

/** 线路色系（与方案 §5.2 色板一一对应，具体色值只在 metroTheme 里给）。 */
export type MetroTone = 'sunrise' | 'sea' | 'rose' | 'forest' | 'violet' | 'amber' | 'ghost';

/** 线路来源（M2 决定抓取方式；M1 只做展示）。 */
export type MetroLineSource = 'daily' | 'liked' | 'recent' | 'playlist' | 'radar' | 'local';

/** 站点上的一首歌（渲染只用 title/artist/album/durationMs/coverUrl）。 */
export interface MetroSong {
  /** 跨平台唯一键：`${source}:${id}`，换乘检测（M2）按它合并。 */
  trackKey: string;
  title: string;
  artist: string;
  album?: string;
  coverUrl?: string;
  durationMs: number;
  /** netease | qq | local */
  source: string;
  id: string;
}

/**
 * 数据层的站点（无坐标）。
 * 由 `layoutMetro()` 补上 x/y 后升级成 `MetroStation`。
 */
export interface MetroStationSeed {
  /** 站 id；换乘站被多条线共享同一个 id。 */
  id: string;
  song: MetroSong;
  /** 含本站在内的所有线路 id（≥2 即换乘站）。 */
  lineIds: string[];
  /** lineId → 本站在该线上的序号（0 起）。 */
  indexInLine: Record<string, number>;
  type: 'single' | 'transfer' | 'terminus';
  /** 停运（无版权/下架），渲染成灰色。 */
  closed?: boolean;
  /** 已收藏，渲染成星标。 */
  liked?: boolean;
}

/** 布局后的站点：数据层字段 + 世界坐标。 */
export interface MetroStation extends MetroStationSeed {
  x: number;
  y: number;
}

/** 一条线路。 */
export interface MetroLine {
  id: string;
  /** 展示名，如「今日推荐线」。 */
  name: string;
  /** 副标题（来源/更新时间），HUD 与线路信息条用。 */
  subtitle?: string;
  tone: MetroTone;
  /** 环线（首尾闭合，如「我喜欢环线」）。 */
  loop: boolean;
  /** 规划中（灰色虚线，如「私人雷达线」）。 */
  dashed: boolean;
  /** 有顺序的站 id；环线首尾不重复。 */
  stationIds: string[];
  source: MetroLineSource;
}

/** 世界坐标包围盒（含 padding，由布局层算好）。 */
export interface MetroBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 数据层：线路 + 站点（无坐标）。 */
export interface MetroData {
  lines: MetroLine[];
  stations: Record<string, MetroStationSeed>;
}

/** 渲染层：布局后的完整地图。 */
export interface MetroMap {
  lines: MetroLine[];
  stations: Record<string, MetroStation>;
  bounds: MetroBounds;
}

/** 站点卡片上的动作（M1 只接通 play 与 locate，其余给 M3 预留）。 */
export interface MetroCardAction {
  type: 'play' | 'queue' | 'next' | 'locate';
  song: MetroSong;
}

/** 列车世界坐标 + 朝向（角度：度，0 = 朝右，顺时针）。 */
export interface MetroTrainPoint {
  x: number;
  y: number;
  angleDeg: number;
}

/** 列车视觉状态：运行 / 停靠（暂停呼吸）/ 隐藏。 */
export type MetroTrainState = 'playing' | 'paused' | 'idle';

/** LOD 档位（方案 §4.3）：全网 / 中距 / 近距 / 特写。 */
export type MetroLodLevel = 'far' | 'mid' | 'near' | 'close';
