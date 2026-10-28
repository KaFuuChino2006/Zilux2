/**
 * 「音乐地铁图」布局算法 v3：八向正交地铁示意图（MetroData → MetroMap）。
 *
 * 纯函数、确定性（同一输入必同输出）、不依赖 DOM / 渲染模块；唯一依据
 * `research/tmp/metro-m1/schematic-layout-spec.md`（Lead 定稿）：
 *
 *   1. 按 `MetroLine.source` 选固定模板（spec §1）：
 *      - daily   ：水平线 y = -150，端点 (-875,-150) → (892,-150)；
 *      - recent  ：水平线 y = +150，端点 (-652.857,150) → (852.857,150)；
 *      - playlist：垂直线 x = -210，端点 (-210,-480) → (-210,570)；
 *      - radar   ：45° 对角线，以换乘点 (520,-150) 为 k=3、步长 57，端点 (349,-321) → (976,306)；
 *      - liked   ：八边形环线（半宽 W=488、半高 H=250、斜切角 C=178），16 站沿周长等弧长布点，
 *                  相位由「ring[12] 精确落在 (-410,-150)」反解（≈492.30），ring[4] 对称落 (410,150)；
 *      - 其它 source（local 等）：回退到从中心向外的水平直线 + 均匀布点（占位实现，不 throw）。
 *   2. 站点沿模板骨架按弧长均匀布点：端点固定，步长 = (end - start) / (站点数 - 1)。
 *   3. 换乘站 = 同一 station.id 被多条线引用：各线先算模板坐标，最终取平均（spec §2 的
 *      4 个换乘点与目标坐标误差 ≤1e-6，平均后线路仍保持正交）。
 *   4. 删除 v2 的径向铺站 / 角度摆动 / 缓弧 / 0.25 中点顺滑：直线与 45° 折线不需要顺滑，
 *      顺滑反而会把直线和八边形弄弯（目检「歪」的来源）。
 *   5. 碰撞消解（≤3 轮、只动非换乘站、每站每轮 ≤8px）保留作安全网：模板是设计好的几何，
 *      默认不触发；只有调用方显式传入 `minStationGap` 时才启用（见 MetroLayoutOptions）。
 *   6. bounds = 站点包围盒四边各外扩 padding（默认 120）。
 *   7. 可选 rotationDeg（默认 0）：全部站点绕原点旋转该角度后按旋转后包围盒重算 bounds。
 *
 * 坐标单位：世界 px，y 向下，原点 (0,0) 为线网中心附近。
 */

import type {
  MetroBounds,
  MetroData,
  MetroLine,
  MetroLineSource,
  MetroMap,
  MetroStation,
  MetroStationSeed,
} from './types';

export interface MetroLayoutOptions {
  /** v2 径向布局的站点步长（px）：v3 模板布局不再使用，保留只为兼容调用方。 */
  step?: number;
  /** v2 径向布局的起始半径（px）：v3 模板布局不再使用，保留只为兼容调用方。 */
  startRadius?: number;
  /**
   * 碰撞消解最小站距（px），默认 30。
   * v3 模板布局的坐标是设计好的精确几何，默认不执行碰撞消解（否则会把正交骨架推歪）；
   * 仅当调用方显式传入本字段时，才作为异常数据的安全网启用（只移动非换乘站）。
   */
  minStationGap?: number;
  /** bounds 外扩（px），默认 120。 */
  padding?: number;
  /**
   * 布局完成后整体绕原点旋转的角度（度），重算 bounds；默认 0（不旋转）。
   * 用于 16:9 视口下调整构图朝向，纯几何变换，不影响确定性。
   */
  rotationDeg?: number;
}

/** v2 径向布局参数默认值：v3 不再参与计算，保留仅为兼容调用方。 */
const DEFAULT_STEP = 52;
const DEFAULT_START_RADIUS = 120;
const DEFAULT_MIN_STATION_GAP = 30;
const DEFAULT_PADDING = 120;
/** 默认整体旋转角度（度）：0 表示不旋转。 */
const DEFAULT_ROTATION_DEG = 0;

/** radar 线沿 x / y 轴的每站步长（px，spec §1.4 v3.1）：k = 3 为换乘点 (520,-150)。 */
const RADAR_STEP = 57;

/** 环线八边形尺寸（spec §1.5 v3.1）：半宽 W、半高 H、斜切角 C = W + H - 560。 */
const RING_HALF_WIDTH = 488;
const RING_HALF_HEIGHT = 250;
const RING_CORNER = RING_HALF_WIDTH + RING_HALF_HEIGHT - 560; // 178
/** 顶边 / 底边的半长（W - C = 310）。 */
const RING_FLAT_HALF_WIDTH = RING_HALF_WIDTH - RING_CORNER;
/** 环线换乘点 (-410,-150) 的横坐标绝对值（spec §2：st-5 = daily[5] × liked[12]）。 */
const RING_TRANSFER_HALF_X = 410;
/** 环线标准站数（spec §1.5 的 16 站；相位按该站数反解以对齐换乘点）。 */
const RING_STATION_COUNT = 16;

/** 碰撞消解：最多 3 轮，每站每轮最大位移 8px。 */
const COLLISION_ROUNDS = 3;
const COLLISION_MAX_MOVE = 8;

/** 数值工具用的极小量。 */
const EPSILON = 1e-6;
const TAU = Math.PI * 2;

/** 二维点（世界坐标 px）。 */
interface Point {
  x: number;
  y: number;
}

/** 换乘站平均用的原始坐标累加器。 */
interface RawSum {
  x: number;
  y: number;
  count: number;
}

/** 解析后的布局参数（默认值已补齐）。 */
interface ResolvedLayoutOptions {
  step: number;
  startRadius: number;
  minStationGap: number;
  padding: number;
  rotationDeg: number;
}

/** 直线模板的两个端点（世界 px）。 */
interface TemplateLine {
  start: Point;
  end: Point;
}

/** 八边形一条边的起止点与累计弧长信息。 */
interface OctagonSegment {
  start: Point;
  end: Point;
  /** 本条边起点在周长上的累计弧长。 */
  from: number;
  /** 本条边长度。 */
  length: number;
}

/** 环线八边形顶点（顺时针，从顶边左端 A 开始；y 向下）。 */
const OCTAGON_VERTICES: readonly Point[] = [
  { x: -RING_FLAT_HALF_WIDTH, y: -RING_HALF_HEIGHT }, // A 顶边左端 (-310,-250)
  { x: RING_FLAT_HALF_WIDTH, y: -RING_HALF_HEIGHT }, // B 顶边右端 (310,-250)
  { x: RING_HALF_WIDTH, y: -RING_HALF_HEIGHT + RING_CORNER }, // C 右边上端 (488,-72)
  { x: RING_HALF_WIDTH, y: RING_HALF_HEIGHT - RING_CORNER }, // D 右边下端 (488,72)
  { x: RING_FLAT_HALF_WIDTH, y: RING_HALF_HEIGHT }, // E 底边右端 (310,250)
  { x: -RING_FLAT_HALF_WIDTH, y: RING_HALF_HEIGHT }, // F 底边左端 (-310,250)
  { x: -RING_HALF_WIDTH, y: RING_HALF_HEIGHT - RING_CORNER }, // G 左边下端 (-488,72)
  { x: -RING_HALF_WIDTH, y: -RING_HALF_HEIGHT + RING_CORNER }, // H 左边上端 (-488,-72)
];

/** 预计算八边形各边的累计弧长（周长 P ≈ 2534.920，spec 文字圆整为 2534.915）。 */
function buildOctagon(): { segments: OctagonSegment[]; perimeter: number } {
  const segments: OctagonSegment[] = [];
  let from = 0;
  for (let index = 0; index < OCTAGON_VERTICES.length; index += 1) {
    const start = OCTAGON_VERTICES[index];
    const end = OCTAGON_VERTICES[(index + 1) % OCTAGON_VERTICES.length];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    segments.push({ start, end, from, length });
    from += length;
  }
  return { segments, perimeter: from };
}

const OCTAGON = buildOctagon();

/**
 * 环线布点相位（spec §1.5 v3.1）：由「ring[12] 精确落在 (-410,-150)」反解——
 * phase = s_transfer - 12 * (P / 16)，其中 s_transfer 为 (-410,-150) 在 H→A 边上的累计弧长。
 * 几何反解得 ≈492.30（spec 文字圆整为 492.3；直接写死 492.3 会使换乘点偏差约 7e-3 px，故用精确值）。
 */
function computeRingPhase(): number {
  const closingSegment = OCTAGON.segments[OCTAGON.segments.length - 1]; // H → A 边
  // 该边参数方程 x = -W + t * C，令 x = -410 反解 t = (W - 410) / C = 78 / 178。
  const t = (RING_HALF_WIDTH - RING_TRANSFER_HALF_X) / RING_CORNER;
  const arcToTransfer = closingSegment.from + t * closingSegment.length;
  const spacing = OCTAGON.perimeter / RING_STATION_COUNT;
  const raw = arcToTransfer - 12 * spacing;
  return ((raw % OCTAGON.perimeter) + OCTAGON.perimeter) % OCTAGON.perimeter;
}

const RING_PHASE = computeRingPhase();

/** 确定性字符串哈希（FNV-1a 32bit）→ [0, 1)。 */
function hash01(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/** 角度（度）→ 弧度。 */
function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** 打包线路布局参数。 */
function resolveOptions(options?: MetroLayoutOptions): ResolvedLayoutOptions {
  return {
    step: options?.step ?? DEFAULT_STEP,
    startRadius: options?.startRadius ?? DEFAULT_START_RADIUS,
    minStationGap: options?.minStationGap ?? DEFAULT_MIN_STATION_GAP,
    padding: options?.padding ?? DEFAULT_PADDING,
    rotationDeg: options?.rotationDeg ?? DEFAULT_ROTATION_DEG,
  };
}

/** 沿直线段均匀取 count 个点：端点固定，步长 = (end - start) / (count - 1)。 */
function linePointsFor(template: TemplateLine, count: number): Point[] {
  if (!(count > 0)) return [];
  const points: Point[] = [];
  if (count === 1) {
    points.push({ x: template.start.x, y: template.start.y });
    return points;
  }
  for (let k = 0; k < count; k += 1) {
    const t = k / (count - 1);
    points.push({
      x: template.start.x + (template.end.x - template.start.x) * t,
      y: template.start.y + (template.end.y - template.start.y) * t,
    });
  }
  return points;
}

/** 八边形环线：沿周长等弧长取 count 个点，起点相位 RING_PHASE（不重复首点）。 */
function ringPointsFor(count: number): Point[] {
  if (!(count > 0)) return [];
  const points: Point[] = [];
  const lastSegment = OCTAGON.segments[OCTAGON.segments.length - 1];
  for (let j = 0; j < count; j += 1) {
    const distance = (RING_PHASE + (j * OCTAGON.perimeter) / count) % OCTAGON.perimeter;
    let segment = lastSegment;
    for (const candidate of OCTAGON.segments) {
      if (distance < candidate.from + candidate.length) {
        segment = candidate;
        break;
      }
    }
    const t = (distance - segment.from) / segment.length;
    points.push({
      x: segment.start.x + (segment.end.x - segment.start.x) * t,
      y: segment.start.y + (segment.end.y - segment.start.y) * t,
    });
  }
  return points;
}

/** source → 模板骨架点（spec §1；未知 source 回退中心水平线占位，不 throw）。 */
function templatePoints(source: MetroLineSource, count: number): Point[] {
  switch (source) {
    case 'daily':
      return linePointsFor({ start: { x: -875, y: -150 }, end: { x: 892, y: -150 } }, count);
    case 'recent': {
      // spec §1.2：k=5 → (-210,150)（st-40 电子羊）、k=12 → (410,150)（st-24 蓝色海岸线）；
      // 用这两点反推精确端点（步长 620/7），避免 spec 里 3 位小数的端点造成换乘平均误差。
      const recentStep = 620 / 7;
      const recentStart = { x: -210 - 5 * recentStep, y: 150 };
      const recentEnd = { x: -210 + 12 * recentStep, y: 150 };
      return linePointsFor({ start: recentStart, end: recentEnd }, count);
    }
    case 'playlist':
      return linePointsFor({ start: { x: -210, y: -480 }, end: { x: -210, y: 570 } }, count);
    case 'radar': {
      // spec §1.4 v3.1：以换乘点 (520,-150) 为 k=3、步长 57，反推 k=0 / k=11 两端。
      const radarStart = { x: 520 - 3 * RADAR_STEP, y: -150 - 3 * RADAR_STEP };
      const radarEnd = { x: 520 + 8 * RADAR_STEP, y: -150 + 8 * RADAR_STEP };
      return linePointsFor({ start: radarStart, end: radarEnd }, count);
    }
    case 'liked':
      return ringPointsFor(count);
    default:
      return linePointsFor({ start: { x: -600, y: 0 }, end: { x: 600, y: 0 } }, count);
  }
}

/** 累加一条线的「模板坐标」到 rawSums（同一站被多线引用时自然多处累加）。 */
function appendRaw(rawSums: Map<string, RawSum>, stationId: string, point: Point): void {
  const sum = rawSums.get(stationId);
  if (sum === undefined) {
    rawSums.set(stationId, { x: point.x, y: point.y, count: 1 });
    return;
  }
  sum.x += point.x;
  sum.y += point.y;
  sum.count += 1;
}

/** 统计每个站被哪些线路引用（同一线路内的重复引用只算一次）。 */
function collectLineReferences(lines: readonly MetroLine[]): Map<string, Set<string>> {
  const referencedBy = new Map<string, Set<string>>();
  for (const line of lines) {
    const seen = new Set<string>();
    for (const stationId of line.stationIds) {
      if (seen.has(stationId)) continue;
      seen.add(stationId);
      const refs = referencedBy.get(stationId);
      if (refs === undefined) {
        referencedBy.set(stationId, new Set([line.id]));
      } else {
        refs.add(line.id);
      }
    }
  }
  return referencedBy;
}

/** 单轮碰撞消解中把某站沿 (ux, uy) 推 amount px，受每轮 8px 上限约束；返回实际位移。 */
function pushStation(
  coords: Map<string, Point>,
  moved: Map<string, number>,
  stationId: string,
  ux: number,
  uy: number,
  amount: number,
): number {
  const allowance = COLLISION_MAX_MOVE - (moved.get(stationId) ?? 0);
  const current = coords.get(stationId);
  if (current === undefined || allowance <= 0 || amount <= 0) return 0;
  const applied = Math.min(amount, allowance);
  coords.set(stationId, {
    x: current.x + ux * applied,
    y: current.y + uy * applied,
  });
  moved.set(stationId, (moved.get(stationId) ?? 0) + applied);
  return applied;
}

/**
 * 碰撞消解（安全网，v3 默认不启用）：两两排斥 ≤3 轮，目标站距 minStationGap，
 * 只移动非换乘站；每轮按当前距离从近到远处理，避免近对预算被远对吃光。
 */
function resolveCollisions(
  coords: Map<string, Point>,
  isTransfer: (stationId: string) => boolean,
  targetGap: number,
): void {
  if (!(targetGap > 0)) return;
  const ids = Array.from(coords.keys());

  for (let round = 0; round < COLLISION_ROUNDS; round += 1) {
    const moved = new Map<string, number>();

    const pairs: Array<{ left: number; right: number; distance: number }> = [];
    for (let i = 0; i < ids.length; i += 1) {
      const aId = ids[i];
      const a = coords.get(aId);
      if (a === undefined) continue;
      const aMovable = !isTransfer(aId);
      for (let j = i + 1; j < ids.length; j += 1) {
        const bId = ids[j];
        if (!aMovable && isTransfer(bId)) continue;
        const b = coords.get(bId);
        if (b === undefined) continue;
        const distance = Math.hypot(b.x - a.x, b.y - a.y);
        if (distance >= targetGap) continue;
        pairs.push({ left: i, right: j, distance });
      }
    }
    pairs.sort(
      (first, second) =>
        first.distance - second.distance || first.left - second.left || first.right - second.right,
    );

    for (const pair of pairs) {
      const aId = ids[pair.left];
      const bId = ids[pair.right];
      const a = coords.get(aId);
      const b = coords.get(bId);
      if (a === undefined || b === undefined) continue;

      const aMovable = !isTransfer(aId);
      const bMovable = !isTransfer(bId);
      if (!aMovable && !bMovable) continue;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= targetGap) continue;

      let ux: number;
      let uy: number;
      if (dist > EPSILON) {
        ux = dx / dist;
        uy = dy / dist;
      } else {
        // 完全重合：用确定性 hash 角度分开，避免 NaN。
        const angle = hash01(`${aId}\u0000${bId}`) * TAU;
        ux = Math.cos(angle);
        uy = Math.sin(angle);
      }
      const overlap = targetGap - dist;

      if (aMovable && bMovable) {
        const half = overlap / 2;
        const usedA = pushStation(coords, moved, aId, -ux, -uy, half);
        const usedB = pushStation(coords, moved, bId, ux, uy, half);
        let remain = overlap - usedA - usedB;
        if (remain > EPSILON) {
          remain -= pushStation(coords, moved, bId, ux, uy, remain);
        }
        if (remain > EPSILON) {
          pushStation(coords, moved, aId, -ux, -uy, remain);
        }
      } else if (aMovable) {
        pushStation(coords, moved, aId, -ux, -uy, overlap);
      } else {
        pushStation(coords, moved, bId, ux, uy, overlap);
      }
    }
  }
}

/** 站点包围盒四边各外扩 padding；无站点时返回退化到原点的空 bounds。 */
function computeBounds(stations: readonly MetroStation[], padding: number): MetroBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const station of stations) {
    if (station.x < minX) minX = station.x;
    if (station.y < minY) minY = station.y;
    if (station.x > maxX) maxX = station.x;
    if (station.y > maxY) maxY = station.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
  };
}

/** MetroData → MetroMap：按 source 套正交模板给每站补世界坐标 + 算 bounds。纯函数、确定性。 */
export function layoutMetro(data: MetroData, options?: MetroLayoutOptions): MetroMap {
  const config = resolveOptions(options);

  // 链 A：换乘站判定（仅碰撞安全网使用；模板坐标本身不改 seed.type 语义）。
  const referencedBy = collectLineReferences(data.lines);
  const isTransferStation = (stationId: string): boolean => {
    const refs = referencedBy.get(stationId);
    if (refs !== undefined && refs.size >= 2) return true;
    const seed: MetroStationSeed | undefined = data.stations[stationId];
    return seed !== undefined && seed.type === 'transfer';
  };

  // 链 B：逐线套模板取「原始坐标」；同一换乘站在每条线上各有一份，累加后平均。
  const rawSums = new Map<string, RawSum>();
  for (const line of data.lines) {
    const points = templatePoints(line.source, line.stationIds.length);
    for (let k = 0; k < line.stationIds.length; k += 1) {
      appendRaw(rawSums, line.stationIds[k], points[k]);
    }
  }

  // 链 C：换乘站取各线模板坐标平均（spec §2 的 4 个换乘点误差 <1px）。
  const coords = new Map<string, Point>();
  for (const [stationId, sum] of rawSums) {
    coords.set(stationId, { x: sum.x / sum.count, y: sum.y / sum.count });
  }
  // 异常数据兜底：未被任何线路引用的站放到中心水平线上（确定性，不 throw）。
  for (const stationId of Object.keys(data.stations)) {
    if (coords.has(stationId)) continue;
    coords.set(stationId, { x: (hash01(stationId) - 0.5) * 1200, y: 0 });
  }

  // 链 D：碰撞消解安全网 —— 模板坐标是精确设计几何，默认不执行；显式传 minStationGap 才启用。
  if (options?.minStationGap !== undefined) {
    resolveCollisions(coords, isTransferStation, config.minStationGap);
  }

  // 链 E：可选整体旋转（默认 0 跳过）：绕原点旋转全部站点坐标，bounds 按旋转后包围盒重算。
  if (config.rotationDeg !== 0) {
    const rotation = degToRad(config.rotationDeg);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    for (const [stationId, point] of coords) {
      coords.set(stationId, {
        x: point.x * cos - point.y * sin,
        y: point.x * sin + point.y * cos,
      });
    }
  }

  // 链 F：写出 MetroStation（保留数据层全部字段，只补 x/y）并按原始线路顺序返回。
  const stations: Record<string, MetroStation> = {};
  for (const stationId of Object.keys(data.stations)) {
    const seed: MetroStationSeed | undefined = data.stations[stationId];
    const point = coords.get(stationId);
    if (seed === undefined || point === undefined) continue;
    stations[stationId] = { ...seed, x: point.x, y: point.y };
  }

  return {
    lines: data.lines.slice(),
    stations,
    bounds: computeBounds(Object.values(stations), config.padding),
  };
}

/** 线路按 stationIds 顺序的坐标序列（环线不重复首点）——供渲染层/列车使用。 */
export function linePoints(map: MetroMap, line: MetroLine): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (const stationId of line.stationIds) {
    const station = map.stations[stationId];
    if (station === undefined) continue;
    points.push({ x: station.x, y: station.y });
  }
  return points;
}

/** 数字格式化：保留 2 位小数，避免 SVG path 里出现超长浮点/-0。 */
function formatCoord(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** 线路 SVG path 数据：普通线 `M x y L x y …`；环线末尾补 `Z`。 */
export function linePathD(map: MetroMap, line: MetroLine): string {
  const points = linePoints(map, line);
  if (points.length === 0) return '';
  let path = `M ${formatCoord(points[0].x)} ${formatCoord(points[0].y)}`;
  for (let i = 1; i < points.length; i += 1) {
    path += ` L ${formatCoord(points[i].x)} ${formatCoord(points[i].y)}`;
  }
  if (line.loop) path += ' Z';
  return path;
}
