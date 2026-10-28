/**
 * 「音乐地铁图」渲染层：SVG DOM + 全部 CSS + HUD / 图例 / 站点卡片 / 列车视觉。
 *
 * 职责与冻结的类名、CSS 变量、行为见 research/tmp/metro-m1/contract.md §5。
 * 只有 renderer 碰 DOM 样式；camera 只改 `.mt-camera` 的 transform；stage 只调本文件导出的 API。
 *
 * 设计要点：
 *   - 所有颜色 / 动效时长 / 几何尺寸都来自 `metroTheme.ts` 的 `METRO_THEMES`
 *     （通过 root 上的 `--mt-*` 变量）与 `METRO_MOTION` / `METRO_METRICS`（生成 CSS 时插值），
 *     本文件不写死任何色值；
 *   - 世界层（纸面 / 网格 / 色晕 / 线路 / 站点 / 列车）画在一个 SVG 里，浮层（HUD / 图例 /
 *     缩放条 / 提示 / 线路信息条 / 卡片）是 DOM，互不干扰；
 *   - CSS 生成一次注入 `<style id="mt-render-css">`，destroy 时保留；
 *   - 站点、线路、图例的事件全部用委托，重建数据时无需逐个解绑。
 */

import {
  METRO_METRICS,
  METRO_MOTION,
  applyMetroTheme,
  prefersReducedMotion,
  resolveMetroTheme,
  type MetroThemeMode,
} from './metroTheme';
import type {
  MetroCardAction,
  MetroData,
  MetroLine,
  MetroLodLevel,
  MetroMap,
  MetroSong,
  MetroStation,
  MetroTone,
  MetroTrainPoint,
  MetroTrainState,
} from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const STYLE_ID = 'mt-render-css';

/** 每个 renderer 实例一套 defs id，避免同页多实例冲突（前缀仍为 mt-）。 */
let rendererSeq = 0;

/* ------------------------------------------------------------------ */
/* 基础小工具                                                          */
/* ------------------------------------------------------------------ */

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  }
  return el;
}

function htmlEl<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

function mustFind<T extends Element>(scope: ParentNode, selector: string): T {
  const el = scope.querySelector<T>(selector);
  if (!el) throw new Error(`[metro] 渲染层缺少元素：${selector}`);
  return el;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 把线路/站点色系写成局部 CSS 变量，CSS 里统一用 var(--mt-tone)。 */
function applyTone(el: HTMLElement | SVGElement, tone: MetroTone): void {
  el.style.setProperty('--mt-tone', `var(--mt-tone-${tone})`);
  el.style.setProperty('--mt-tone-glow', `var(--mt-tone-${tone}-glow)`);
  el.style.setProperty('--mt-tone-soft', `var(--mt-tone-${tone}-soft)`);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function sourceLabel(source: string): string {
  if (source === 'netease') return '网易云音乐';
  if (source === 'qq') return 'QQ 音乐';
  if (source === 'local') return '本地文件';
  return source;
}

/** 地图站名只留前若干字，避免长标题互相压字（完整信息在卡片里）。 */
function shortTitle(title: string): string {
  const chars = Array.from(title.trim());
  if (chars.length <= 13) return chars.join('');
  return `${chars.slice(0, 12).join('')}…`;
}

function firstGlyph(title: string): string {
  return Array.from(title.trim())[0] ?? '♪';
}

/** 五角星 path（收藏标记），中心 (cx, cy)，外接半径 r。 */
function starPathD(cx: number, cy: number, r: number): string {
  const inner = r * 0.44;
  const parts: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? r : inner;
    parts.push(`${i === 0 ? 'M' : 'L'}${round(cx + Math.cos(angle) * radius)} ${round(cy + Math.sin(angle) * radius)}`);
  }
  return `${parts.join(' ')}Z`;
}

/* ------------------------------------------------------------------ */
/* 图标（内联 SVG，风格参考 web/src/ui/dom.ts）                        */
/* ------------------------------------------------------------------ */

const ICON_BODY: Record<string, string> = {
  search:
    '<circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M15.6 15.6 20 20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  close:
    '<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
  locate:
    '<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="12" r="7.4" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
    '<path d="M12 2.8v2.4M12 19v2.4M2.8 12h2.4M19 12h2.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
};

function iconMarkup(name: keyof typeof ICON_BODY, size = 18): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
    `${ICON_BODY[name] ?? ''}</svg>`
  );
}

/* ------------------------------------------------------------------ */
/* 几何小工具                                                          */
/* ------------------------------------------------------------------ */

/* 折线倒角：唯一实现，算法与常量对齐 CGo OpenMap `core/path-geometry.js` ——
 * 90° 拐角半径 18px、斜角（45° 偏转 / 135° 内角）半径 8px，半径再受相邻边长 0.9 倍限制。
 * 所有线路弯曲都走这一条规则，避免手绘碎线或各自不同的圆角。 */
const ROUND_RADIUS_90 = 18;
const ROUND_RADIUS_45 = 8;
const ROUND_LIMIT_FACTOR = 0.9;

interface RoundedCorner {
  start: { x: number; y: number };
  control: { x: number; y: number };
  end: { x: number; y: number };
}

/** 单个拐角的倒角三点；共线或退化时返回 null（保持直线）。 */
function roundedCorner(
  prev: { x: number; y: number },
  curr: { x: number; y: number },
  next: { x: number; y: number },
): RoundedCorner | null {
  const v1x = curr.x - prev.x;
  const v1y = curr.y - prev.y;
  const v2x = next.x - curr.x;
  const v2y = next.y - curr.y;
  const len1 = Math.hypot(v1x, v1y);
  const len2 = Math.hypot(v2x, v2y);
  if (len1 < 0.01 || len2 < 0.01) return null;
  const u1x = v1x / len1;
  const u1y = v1y / len1;
  const u2x = v2x / len2;
  const u2y = v2y / len2;
  const dot = Math.abs(u1x * u2x + u1y * u2y);
  const targetRadius = dot < 0.1 ? ROUND_RADIUS_90 : ROUND_RADIUS_45;
  const radius = Math.min(targetRadius, len1 * ROUND_LIMIT_FACTOR, len2 * ROUND_LIMIT_FACTOR);
  return {
    start: { x: curr.x - u1x * radius, y: curr.y - u1y * radius },
    control: { x: curr.x, y: curr.y },
    end: { x: curr.x + u2x * radius, y: curr.y + u2y * radius },
  };
}

/** 二次贝塞尔段：从 start 已经 L 过去了，这里只写 Q。 */
function cornerCurveD(corner: RoundedCorner): string {
  return `Q${round(corner.control.x)} ${round(corner.control.y)} ${round(corner.end.x)} ${round(corner.end.y)}`;
}

/** 开放折线 → 标准倒角 path。 */
function roundedOpenPathD(points: readonly { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  const parts: string[] = [`M${round(points[0].x)} ${round(points[0].y)}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const corner = roundedCorner(points[index - 1], points[index], points[index + 1]);
    if (corner === null) continue;
    parts.push(`L${round(corner.start.x)} ${round(corner.start.y)}`, cornerCurveD(corner));
  }
  const last = points[points.length - 1];
  parts.push(`L${round(last.x)} ${round(last.y)}`);
  return parts.join(' ');
}

/** 闭合折线 → 标准倒角 path（每个拐角含起点都倒角）。 */
function roundedClosedPathD(points: readonly { x: number; y: number }[]): string {
  const count = points.length;
  if (count === 0) return '';
  if (count < 3) return roundedOpenPathD(points);
  const corners: Array<RoundedCorner | null> = [];
  for (let index = 0; index < count; index += 1) {
    corners.push(
      roundedCorner(points[(index - 1 + count) % count], points[index], points[(index + 1) % count]),
    );
  }
  if (corners.some((corner) => corner === null)) {
    return `${points.map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)} ${round(point.y)}`).join(' ')}Z`;
  }
  const valid = corners as RoundedCorner[];
  const parts: string[] = [`M${round(valid[0].end.x)} ${round(valid[0].end.y)}`];
  for (let index = 1; index < count; index += 1) {
    const corner = valid[index];
    parts.push(`L${round(corner.start.x)} ${round(corner.start.y)}`, cornerCurveD(corner));
  }
  parts.push(`L${round(valid[0].start.x)} ${round(valid[0].start.y)}`, cornerCurveD(valid[0]), 'Z');
  return parts.join(' ');
}

/**
 * 线路 path：优先 `pathPoints`（布局层给出的走向折点，例如环线八边形 → 标准倒角）；
 * 否则按站点顺序直连，环线末尾补 Z（与布局层契约一致）。
 */
function buildLinePathD(map: MetroMap, line: MetroLine): string {
  if (line.pathPoints !== undefined && line.pathPoints.length >= 2) {
    return line.loop ? roundedClosedPathD(line.pathPoints) : roundedOpenPathD(line.pathPoints);
  }
  const parts: string[] = [];
  line.stationIds.forEach((id, index) => {
    const station = map.stations[id];
    if (!station) return;
    parts.push(`${index === 0 ? 'M' : 'L'}${round(station.x)} ${round(station.y)}`);
  });
  if (line.loop && parts.length > 0) parts.push('Z');
  return parts.join(' ');
}

/**
 * 把站点投影到折线上，返回每站相对第一站的弧长（环线末项 = 折线周长）。
 * 站点不在折角上（CGo 模型：站点坐标与线路走向独立），所以不能按折角累加，只能投影求弧长。
 */
function stationArcsOnGuidePath(
  guide: readonly { x: number; y: number }[],
  stations: readonly { x: number; y: number }[],
  loop: boolean,
): number[] {
  const count = guide.length;
  if (count < 2 || stations.length === 0) return stations.map(() => 0);
  const segments: Array<{ x: number; y: number; dx: number; dy: number; len: number; start: number }> = [];
  let walked = 0;
  for (let index = 0; index < count; index += 1) {
    if (!loop && index === count - 1) break;
    const a = guide[index];
    const b = guide[(index + 1) % count];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    segments.push({ x: a.x, y: a.y, dx, dy, len, start: walked });
    walked += len;
  }
  const perimeter = walked;
  const arcs = stations.map((station) => {
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestArc = 0;
    for (const segment of segments) {
      const t = Math.min(
        1,
        Math.max(0, ((station.x - segment.x) * segment.dx + (station.y - segment.y) * segment.dy) / (segment.len * segment.len)),
      );
      const px = segment.x + segment.dx * t;
      const py = segment.y + segment.dy * t;
      const distance = Math.hypot(station.x - px, station.y - py);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestArc = segment.start + segment.len * t;
      }
    }
    return bestArc;
  });
  if (perimeter <= 0) return stations.map(() => 0);
  const base = arcs[0];
  const offsets: number[] = [];
  let previous = 0;
  arcs.forEach((arc, index) => {
    let value = (((arc - base) % perimeter) + perimeter) % perimeter;
    if (index > 0) {
      // 环线跨过起点时补一圈，保证弧长沿站点顺序单调递增
      while (value < previous - 1e-6) value += perimeter;
      previous = value;
    }
    offsets.push(value);
  });
  if (loop) offsets.push(perimeter);
  return offsets;
}

/** 线路端点名的摆放：沿线路方向向外 27px，按方向决定 text-anchor。 */function lineLabelPlacement(
  points: Array<{ x: number; y: number }>,
  atStart: boolean,
): { x: number; y: number; anchor: 'start' | 'middle' | 'end' } {
  const p = atStart ? points[0] : points[points.length - 1];
  const q = atStart ? points[1] : points[points.length - 2];
  let dx = p.x - q.x;
  let dy = p.y - q.y;
  const length = Math.hypot(dx, dy);
  if (length > 0.001) {
    dx /= length;
    dy /= length;
  } else {
    dx = 0;
    dy = -1;
  }
  if (Math.abs(dx) >= Math.abs(dy)) {
    return {
      x: p.x + dx * 27,
      y: p.y + 4.5,
      anchor: dx >= 0 ? 'start' : 'end',
    };
  }
  return {
    x: p.x + dx * 27,
    y: p.y + dy * 27,
    anchor: 'middle',
  };
}

/** 端点朝外方向（从线路内部指向端点外侧）：线名被站点压住时沿它微调。 */
function endpointDirection(
  points: Array<{ x: number; y: number }>,
  atStart: boolean,
): { x: number; y: number } {
  if (points.length < 2) return { x: 1, y: 0 };
  const a = atStart ? points[0] : points[points.length - 1];
  const b = atStart ? points[1] : points[points.length - 2];
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const length = Math.hypot(dx, dy);
  return length > 0.001 ? { x: dx / length, y: dy / length } : { x: 1, y: 0 };
}

/** 记录线名基准位置与可微调方向（relayoutLabels 会回到基准再避让）。 */
function annotateLineLabel(
  label: SVGTextElement,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
): void {
  label.dataset.baseX = String(x);
  label.dataset.baseY = String(y);
  label.dataset.nudgeX = String(Math.round(dirX * 1000) / 1000);
  label.dataset.nudgeY = String(Math.round(dirY * 1000) / 1000);
}

/** 站点外圈 / 内点半径（来自 METRO_METRICS；transfer 内环 ≈ 契约里的 6.5）。 */
function stationRadii(station: MetroStation): { ring: number; dot: number } {
  if (station.type === 'transfer') {
    return { ring: METRO_METRICS.transferRadius, dot: METRO_METRICS.stationRadius * 0.72 };
  }
  if (station.type === 'terminus') {
    return { ring: METRO_METRICS.terminusRadius, dot: 0 };
  }
  return { ring: METRO_METRICS.stationRadius, dot: 3 };
}

/**
 * 端点站站名的摆放：垂直于端点方向、朝地图外侧偏 ring + 13px。
 * 端点处已经有一个「沿线路方向外 27px」的线路名，这样两个标签各占一侧不会叠在一起。
 */
function terminusLabelPlacement(
  map: MetroMap,
  station: MetroStation,
  ring: number,
): { dx: number; dy: number; anchor: 'start' | 'middle' | 'end' } {
  const centerX = (map.bounds.minX + map.bounds.maxX) / 2;
  const centerY = (map.bounds.minY + map.bounds.maxY) / 2;
  let dirX = 0;
  let dirY = -1;
  for (const line of map.lines) {
    const index = line.stationIds.indexOf(station.id);
    if (index < 0) continue;
    const neighborId = index === 0 ? line.stationIds[1] : line.stationIds[index - 1];
    const neighbor = neighborId ? map.stations[neighborId] : undefined;
    if (!neighbor) continue;
    dirX = station.x - neighbor.x;
    dirY = station.y - neighbor.y;
    break;
  }
  const length = Math.hypot(dirX, dirY);
  if (length > 0.001) {
    dirX /= length;
    dirY /= length;
  } else {
    dirX = 0;
    dirY = -1;
  }
  let normalX = -dirY;
  let normalY = dirX;
  if (normalX * (station.x - centerX) + normalY * (station.y - centerY) < 0) {
    normalX = -normalX;
    normalY = -normalY;
  }
  const distance = ring + 13;
  const dx = normalX * distance;
  const dy = normalY * distance;
  const anchor: 'start' | 'middle' | 'end' =
    Math.abs(normalX) >= Math.abs(normalY) ? (normalX >= 0 ? 'start' : 'end') : 'middle';
  return { dx, dy, anchor };
}

/** 站名放站的左侧还是右侧：默认朝地图外侧，正中间按序号左右交替。 */
function labelSide(offsetX: number, index: number): 1 | -1 {
  if (Math.abs(offsetX) < 18) return index % 2 === 0 ? 1 : -1;
  return offsetX >= 0 ? 1 : -1;
}

/** 全图站点顺序：按线路顺序去重（也是入场 stagger 的顺序）。 */
function orderedStations(map: MetroMap): MetroStation[] {
  const seen = new Set<string>();
  const out: MetroStation[] = [];
  for (const line of map.lines) {
    for (const id of line.stationIds) {
      if (seen.has(id)) continue;
      const station = map.stations[id];
      if (!station) continue;
      seen.add(id);
      out.push(station);
    }
  }
  for (const station of Object.values(map.stations)) {
    if (seen.has(station.id)) continue;
    seen.add(station.id);
    out.push(station);
  }
  return out;
}

function stationPrimaryLine(map: MetroMap, station: MetroStation): MetroLine | null {
  for (const lineId of station.lineIds) {
    const line = map.lines.find((item) => item.id === lineId);
    if (line) return line;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 标签防碰撞布局（relayoutLabels 用）                                  */
/* ------------------------------------------------------------------ */

/** 屏幕 px 矩形：世界坐标 × scale（不含相机平移 —— 判定相交与平移无关）。 */
interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 站名文本的 world 尺寸（随 scale 换算到屏幕 px）。 */
interface LabelMetrics {
  width: number;
  height: number;
  ascent: number;
}

/** 候选框中心（相对站点中心、屏幕 px）与文本锚点。 */
interface LabelCandidate {
  cx: number;
  cy: number;
  anchor: 'start' | 'middle' | 'end';
}

/** effectiveOpacity 低于它视为不可见，不参与布局。 */
const LABEL_VISIBLE_EPS = 0.06;
/** 站点圆点框在屏幕 px 上额外留白（ring + 3px）。 */
const LABEL_DOT_PAD = 3;
/** 标签文本外框额外留白（覆盖 paper 描边）。 */
const LABEL_BOX_PAD = 1;
/** 相交面积超过它才算碰撞（px²）。 */
const LABEL_OVERLAP_AREA = 1;

function boxOverlapArea(a: LabelBox, b: LabelBox): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  if (width <= 0) return 0;
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (height <= 0) return 0;
  return width * height;
}

function expandLabelBox(box: LabelBox, pad: number): LabelBox {
  return { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 };
}

/** 元素在屏幕上的有效不透明度（自身 + 祖先，最多看 8 层）。 */
function effectiveOpacity(el: Element, root: HTMLElement): number {
  let value = 1;
  let node: Element | null = el;
  for (let depth = 0; node && depth < 8; depth += 1) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return 0;
    const opacity = Number(style.opacity);
    if (Number.isFinite(opacity)) value *= opacity;
    if (value <= 0.01 || node === root) break;
    node = node.parentElement;
  }
  return value;
}

/** 站名优先级：换乘 → 端点 → 收藏 → 停运 → 普通。 */
function stationLabelPriority(station: MetroStation): number {
  if (station.type === 'transfer') return 0;
  if (station.type === 'terminus') return 1;
  if (station.liked) return 2;
  if (station.closed) return 3;
  return 4;
}

/** 站点所在线的局部方向（相邻两站连线的单位向量）+ 站序（奇偶决定优先侧）。 */
function stationDirection(
  map: MetroMap,
  station: MetroStation,
): { x: number; y: number; index: number } {
  const line = stationPrimaryLine(map, station);
  if (line) {
    const index = line.stationIds.indexOf(station.id);
    if (index >= 0) {
      const beforeId = index > 0
        ? line.stationIds[index - 1]
        : line.loop
          ? line.stationIds[line.stationIds.length - 1]
          : undefined;
      const afterId = index < line.stationIds.length - 1
        ? line.stationIds[index + 1]
        : line.loop
          ? line.stationIds[0]
          : undefined;
      const before = beforeId ? map.stations[beforeId] : undefined;
      const after = afterId ? map.stations[afterId] : undefined;
      let dx = 1;
      let dy = 0;
      if (before && after) {
        dx = after.x - before.x;
        dy = after.y - before.y;
      } else if (after) {
        dx = after.x - station.x;
        dy = after.y - station.y;
      } else if (before) {
        dx = station.x - before.x;
        dy = station.y - before.y;
      }
      const length = Math.hypot(dx, dy);
      if (length > 0.001) {
        dx /= length;
        dy /= length;
      } else {
        dx = 1;
        dy = 0;
      }
      return { x: dx, y: dy, index };
    }
  }
  // 兜底：朝地图外侧
  const centerX = (map.bounds.minX + map.bounds.maxX) / 2;
  const centerY = (map.bounds.minY + map.bounds.maxY) / 2;
  let dx = station.x - centerX;
  let dy = station.y - centerY;
  const length = Math.hypot(dx, dy);
  if (length > 0.001) {
    dx /= length;
    dy /= length;
  } else {
    dx = 1;
    dy = 0;
  }
  return { x: dx, y: dy, index: 0 };
}

/** 标签候选：按「距站点屏幕距离」由近到远排序（近位 → 侧位 → 斜位 → 沿线路 → 远位）。 */
function labelCandidates(input: {
  dirX: number;
  dirY: number;
  parity: number;
  ringPx: number;
  labelW: number;
  labelH: number;
  maxDistance: number;
}): LabelCandidate[] {
  const { dirX, dirY, parity, ringPx, labelW, labelH, maxDistance } = input;
  // 优先侧：垂直线路的法线方向，奇偶交替
  let normalX = -dirY;
  let normalY = dirX;
  if (parity % 2 !== 0) {
    normalX = -normalX;
    normalY = -normalY;
  }
  const directions: Array<{ x: number; y: number; anchor: LabelCandidate['anchor'] }> = [
    { x: 0, y: -1, anchor: 'middle' },
    { x: 1, y: 0, anchor: 'start' },
    { x: 0, y: 1, anchor: 'middle' },
    { x: -1, y: 0, anchor: 'end' },
    { x: 1, y: -1, anchor: 'start' },
    { x: -1, y: -1, anchor: 'end' },
    { x: 1, y: 1, anchor: 'start' },
    { x: -1, y: 1, anchor: 'end' },
  ];
  const unit = (x: number, y: number): { x: number; y: number } => {
    const length = Math.hypot(x, y) || 1;
    return { x: x / length, y: y / length };
  };
  const normalScore = (x: number, y: number): number => {
    const u = unit(x, y);
    return u.x * normalX + u.y * normalY;
  };
  const ordered = [...directions].sort((a, b) => normalScore(b.x, b.y) - normalScore(a.x, a.y));

  /** 方向上的半外延（中心 → 盒子边缘），保证标签框边距站点圆点恰好 gap。 */
  const build = (
    dir: { x: number; y: number; anchor: LabelCandidate['anchor'] },
    gap: number,
  ): LabelCandidate => {
    const u = unit(dir.x, dir.y);
    const along = (Math.abs(u.x) * labelW + Math.abs(u.y) * labelH) / 2;
    const distance = ringPx + gap + along;
    return { cx: u.x * distance, cy: u.y * distance, anchor: dir.anchor };
  };

  const raw: LabelCandidate[] = [];
  for (const dir of ordered) {
    raw.push(build(dir, 3));
    raw.push(build(dir, 5));
    raw.push(build(dir, 7));
  }
  // 沿线路前后（两端以外的沿伸位，只在靠近时保留）
  const alongLine = ringPx + 4 + (Math.abs(dirX) * labelW + Math.abs(dirY) * labelH) / 2;
  raw.push({ cx: dirX * alongLine, cy: dirY * alongLine, anchor: 'middle' });
  raw.push({ cx: -dirX * alongLine, cy: -dirY * alongLine, anchor: 'middle' });

  const seen = new Set<string>();
  const kept: LabelCandidate[] = [];
  for (const candidate of raw) {
    const distance = Math.hypot(candidate.cx, candidate.cy);
    if (distance > maxDistance) continue;
    const key = `${round(candidate.cx)}|${round(candidate.cy)}|${candidate.anchor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(candidate);
  }
  // 近的优先；等距时偏好垂直侧
  kept.sort(
    (a, b) =>
      Math.hypot(a.cx, a.cy) - Math.hypot(b.cx, b.cy) ||
      normalScore(b.cx, b.cy) - normalScore(a.cx, a.cy),
  );
  return kept;
}

/** 标签框与已放置框 / 站点圆点的重叠代价（0 = 不碰撞）。 */
function labelCollisionCost(box: LabelBox, placed: LabelBox[], dots: LabelBox[]): number {
  let cost = 0;
  for (const other of placed) {
    const area = boxOverlapArea(box, other);
    if (area > LABEL_OVERLAP_AREA) cost += area;
  }
  for (const dot of dots) {
    const area = boxOverlapArea(box, dot);
    if (area > LABEL_OVERLAP_AREA) cost += area * 2;
  }
  return cost;
}

/* ------------------------------------------------------------------ */
/* SVG 骨架 + defs                                                     */
/* ------------------------------------------------------------------ */

const TONES: MetroTone[] = ['sunrise', 'sea', 'rose', 'forest', 'violet', 'amber', 'ghost'];

function buildDefs(uid: string): SVGDefsElement {
  const defs = svgEl('defs');

  // 纸面渐变：米白 → 次级纸面（世界范围大矩形铺它）
  const paper = svgEl('linearGradient', {
    id: `${uid}-paper`,
    x1: '0',
    y1: '0',
    x2: '0.38',
    y2: '1',
  });
  const paperStart = svgEl('stop', { offset: '0%' });
  paperStart.setAttribute('style', 'stop-color: var(--mt-paper)');
  const paperMid = svgEl('stop', { offset: '56%' });
  paperMid.setAttribute('style', 'stop-color: var(--mt-paper)');
  const paperEnd = svgEl('stop', { offset: '100%' });
  paperEnd.setAttribute('style', 'stop-color: var(--mt-paper-2)');
  paper.append(paperStart, paperMid, paperEnd);

  // 细网格：40px 细线 + 200px 加重线，同一个 pattern 里画，省一层 rect
  const grid = svgEl('pattern', {
    id: `${uid}-grid`,
    width: '200',
    height: '200',
    patternUnits: 'userSpaceOnUse',
  });
  const gridFineD =
    'M40 0V200M80 0V200M120 0V200M160 0V200' +
    'M0 40H200M0 80H200M0 120H200M0 160H200';
  // 主题里的网格色 alpha 很低（.055），叠两遍让纸面网格看得见但依然克制
  const gridFine = svgEl('path', { d: gridFineD });
  gridFine.setAttribute('style', 'fill: none; stroke: var(--mt-grid); stroke-width: 1');
  const gridFineEcho = svgEl('path', { d: gridFineD });
  gridFineEcho.setAttribute('style', 'fill: none; stroke: var(--mt-grid); stroke-width: 1');
  const gridStrong = svgEl('path', { d: 'M0 0V200M0 0H200' });
  gridStrong.setAttribute('style', 'fill: none; stroke: var(--mt-grid-2); stroke-width: 1.2');
  const gridStrongEcho = svgEl('path', { d: 'M0 0V200M0 0H200' });
  gridStrongEcho.setAttribute('style', 'fill: none; stroke: var(--mt-grid-2); stroke-width: 1.2');
  grid.append(gridFine, gridFineEcho, gridStrong, gridStrongEcho);

  defs.append(paper, grid);

  // 分区色晕：每条线一个 tone 的径向渐变（克制、不刺眼）
  for (const tone of TONES) {
    const zone = svgEl('radialGradient', {
      id: `${uid}-zone-${tone}`,
      cx: '50%',
      cy: '50%',
      r: '50%',
    });
    const zoneCore = svgEl('stop', { offset: '0%' });
    zoneCore.setAttribute('style', `stop-color: var(--mt-tone-${tone}); stop-opacity: 0.58`);
    const zoneMid = svgEl('stop', { offset: '56%' });
    zoneMid.setAttribute('style', `stop-color: var(--mt-tone-${tone}); stop-opacity: 0.22`);
    const zoneEdge = svgEl('stop', { offset: '100%' });
    zoneEdge.setAttribute('style', `stop-color: var(--mt-tone-${tone}); stop-opacity: 0`);
    zone.append(zoneCore, zoneMid, zoneEdge);
    defs.append(zone);
  }

  return defs;
}

interface SvgShell {
  svg: SVGSVGElement;
  cameraGroup: SVGGElement;
  paperRect: SVGRectElement;
  gridRect: SVGRectElement;
  zonesGroup: SVGGElement;
  linesGroup: SVGGElement;
  transfersGroup: SVGGElement;
  stationsGroup: SVGGElement;
  trainEl: SVGGElement;
}

function buildTrain(): SVGGElement {
  const train = svgEl('g', { class: 'mt-train is-hidden', 'data-state': 'idle' });
  train.append(svgEl('circle', { class: 'mt-train-halo', cx: 0, cy: 0, r: 24 }));
  const body = svgEl('g', { class: 'mt-train-body' });
  body.append(
    svgEl('rect', { class: 'mt-train-shell', x: -15, y: -7.5, width: 30, height: 15, rx: 7.5 }),
    svgEl('rect', { class: 'mt-train-window', x: -9.6, y: -3.4, width: 10.4, height: 6.8, rx: 2.4 }),
    svgEl('circle', { class: 'mt-train-light', cx: 10.6, cy: 0, r: 2.2 }),
  );
  train.append(body);
  return train;
}

function buildSvgShell(uid: string): SvgShell {
  const svg = svgEl('svg', { class: 'mt-svg' });
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '音乐地铁图');
  svg.append(buildDefs(uid));

  const cameraGroup = svgEl('g', { class: 'mt-camera' });
  const bg = svgEl('g', { class: 'mt-bg' });
  const paperRect = svgEl('rect', { class: 'mt-paper' });
  paperRect.setAttribute('fill', `url(#${uid}-paper)`);
  const gridRect = svgEl('rect', { class: 'mt-grid' });
  gridRect.setAttribute('fill', `url(#${uid}-grid)`);
  const zonesGroup = svgEl('g', { class: 'mt-zones' });
  bg.append(paperRect, gridRect, zonesGroup);

  const linesGroup = svgEl('g', { class: 'mt-lines' });
  const transfersGroup = svgEl('g', { class: 'mt-transfers' });
  const stationsGroup = svgEl('g', { class: 'mt-stations' });
  const trainEl = buildTrain();

  cameraGroup.append(bg, linesGroup, transfersGroup, stationsGroup, trainEl);
  svg.append(cameraGroup);

  return { svg, cameraGroup, paperRect, gridRect, zonesGroup, linesGroup, transfersGroup, stationsGroup, trainEl };
}

/* ------------------------------------------------------------------ */
/* 浮层 DOM（静态结构，事件全部委托）                                   */
/* ------------------------------------------------------------------ */

function overlayMarkup(): string {
  return `
  <header class="mt-hud">
    <div class="mt-crumb">
      <span class="mt-crumb-kicker">地铁图</span>
      <span class="mt-crumb-title">全部线路 · 0 线 0 站</span>
    </div>
    <div class="mt-hud-actions">
      <button class="mt-icon-btn" type="button" data-act="search" title="搜索站点（M3）" aria-label="搜索站点">
        ${iconMarkup('search')}
      </button>
      <button class="mt-icon-btn" type="button" data-act="close" title="返回（Esc）" aria-label="返回">
        ${iconMarkup('close')}
      </button>
    </div>
  </header>
  <div class="mt-legend" role="group" aria-label="线路图例"></div>
  <div class="mt-zoombar">
    <button class="mt-zoom-btn" type="button" data-act="out" title="缩小" aria-label="缩小">−</button>
    <span class="mt-zoom-value" aria-live="polite">100%</span>
    <button class="mt-zoom-btn" type="button" data-act="in" title="放大" aria-label="放大">+</button>
    <span class="mt-zoombar-sep" aria-hidden="true"></span>
    <button class="mt-zoom-btn mt-zoom-btn--fit" type="button" data-act="fit" title="适配全图（0）">适配</button>
  </div>
  <div class="mt-hint">拖动平移 · 滚轮缩放 · 点击站点开卡 · Esc 返回</div>
  <div class="mt-linebar" aria-hidden="true">
    <span class="mt-linebar-line">
      <span class="mt-linebar-dot" aria-hidden="true"></span>
      <strong class="mt-linebar-name"></strong>
    </span>
    <span class="mt-linebar-meta">0 站</span>
    <button class="mt-btn mt-btn--primary" type="button" data-act="play-line">播放全部</button>
    <button class="mt-icon-btn mt-icon-btn--sm" type="button" data-act="clear-line" title="取消高亮" aria-label="取消高亮">
      ${iconMarkup('close', 15)}
    </button>
  </div>
  <aside class="mt-card" aria-hidden="true" aria-label="站点歌曲卡片">
    <div class="mt-card-inner">
      <div class="mt-card-cover"></div>
      <div class="mt-card-info">
        <div class="mt-card-title"></div>
        <div class="mt-card-artist"></div>
        <div class="mt-card-album"></div>
        <div class="mt-card-tags">
          <span class="mt-card-source"></span>
          <span class="mt-card-duration"></span>
        </div>
      </div>
      <div class="mt-card-transfer"></div>
      <div class="mt-card-actions">
        <button class="mt-btn mt-btn--primary" type="button" data-act="play">播放</button>
        <button class="mt-btn" type="button" data-act="queue">加入队列</button>
        <button class="mt-btn" type="button" data-act="locate">定位</button>
      </div>
      <button class="mt-card-close" type="button" data-act="close-card" title="关闭（Esc）" aria-label="关闭卡片">
        ${iconMarkup('close', 16)}
      </button>
    </div>
  </aside>`;
}

/* ------------------------------------------------------------------ */
/* CSS（由 metroTheme / metroMotion 常量插值生成，注入一次）            */
/* ------------------------------------------------------------------ */

function buildStyleCss(): string {
  const metrics = METRO_METRICS;
  const motion = METRO_MOTION;
  const haloWidth = metrics.transferRadius + 4; // 18：halo 比线宽大一圈
  const hitWidth = metrics.transferRadius + 12; // 26：线路点击热区

  return `
.mt-root {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: var(--mt-paper);
  color: var(--mt-text);
  font-family: var(--mt-font);
  -webkit-user-select: none;
  user-select: none;
  isolation: isolate;
  --mt-ease: ${motion.ease};
  --mt-ease-pop: ${motion.easePop};
  --mt-ease-std: ${motion.easeStandard};
  --mt-halo-op: .1;
  --mt-st-scale: 1;
}
.mt-root[data-theme="dark"] { --mt-halo-op: .55; }
.mt-root[data-lod="far"] { --mt-st-scale: .66; }
.mt-root[data-lod="close"] { --mt-st-scale: 1.3; }

/* 纸面暗角（伪元素，不占一层 DOM） */
.mt-root::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background: radial-gradient(130% 100% at 50% 42%, transparent 52%, var(--mt-paper-2) 100%);
  opacity: .52;
}
.mt-root[data-theme="dark"]::after { opacity: .6; }

/* ---------- SVG 世界 ---------- */
.mt-svg {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  display: block;
  background: var(--mt-paper);
  cursor: grab;
  touch-action: none;
}
.mt-svg:active { cursor: grabbing; }
.mt-camera {
  transform-origin: 0 0;
  transition: opacity ${motion.card}ms var(--mt-ease);
}
.mt-root.is-card-open .mt-camera { opacity: .86; }
.mt-paper, .mt-grid { pointer-events: none; }
.mt-zone { opacity: .7; }
.mt-root[data-theme="dark"] .mt-zone { opacity: .85; }

/* ---------- 线路 ---------- */
.mt-lines { pointer-events: none; }
.mt-line { transition: opacity ${motion.highlight}ms var(--mt-ease); }
.mt-line-path {
  fill: none;
  stroke: var(--mt-tone);
  stroke-width: ${metrics.lineWidth}px;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: stroke-width ${motion.highlight}ms var(--mt-ease), opacity ${motion.highlight}ms var(--mt-ease);
}
.mt-line-halo {
  fill: none;
  stroke: var(--mt-tone);
  stroke-width: ${haloWidth}px;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: var(--mt-halo-op);
  pointer-events: none;
  transition: opacity ${motion.highlight}ms var(--mt-ease);
}
.mt-root[data-theme="dark"] .mt-line-halo { stroke: var(--mt-tone-glow); }
.mt-line-hit {
  fill: none;
  stroke: transparent;
  stroke-width: ${hitWidth}px;
  stroke-linecap: round;
  stroke-linejoin: round;
  pointer-events: stroke;
  cursor: pointer;
}
.mt-line[data-dashed="true"] .mt-line-path {
  stroke-dasharray: 1.6 12;
  stroke-linecap: round;
}
.mt-line[data-dashed="true"] .mt-line-halo { display: none; }

/* hover / 高亮 / 灰化 */
.mt-line.is-hover .mt-line-path { stroke-width: ${metrics.lineWidth + 2}px; }
.mt-line.is-active .mt-line-path { stroke-width: ${metrics.lineWidthActive}px; }
.mt-line.is-active .mt-line-halo { opacity: calc(var(--mt-halo-op) * 1.9); }
.mt-line.is-dim { opacity: .34; }
.mt-root[data-hover="1"] .mt-line:not(.is-hover) { opacity: .32; }
.mt-line.is-dim.is-hover { opacity: .72; }

/* 入场：普通线 stroke-dashoffset 生长；虚线线整组淡入 */
.mt-line.is-grow .mt-line-path {
  stroke-dasharray: var(--mt-len, 0);
  stroke-dashoffset: var(--mt-len, 0);
}
.mt-line.is-grow.is-in .mt-line-path {
  stroke-dashoffset: 0;
  transition: stroke-dashoffset ${motion.lineGrow}ms var(--mt-ease) var(--mt-delay, 0ms);
}
.mt-line.is-grow .mt-line-halo { opacity: 0; }
.mt-line.is-grow .mt-line-hit,
.mt-line.is-grow .mt-line-label { opacity: 0; }
.mt-line.is-grow.is-in .mt-line-halo {
  opacity: var(--mt-halo-op);
  transition: opacity ${motion.lineGrow}ms var(--mt-ease) var(--mt-delay, 0ms);
}
.mt-line.is-grow.is-in .mt-line-hit {
  opacity: 1;
  transition: opacity 400ms linear calc(var(--mt-delay, 0ms) + 380ms);
}
.mt-line.is-grow.is-in .mt-line-label {
  opacity: 1;
  transition: opacity 460ms var(--mt-ease) calc(var(--mt-delay, 0ms) + 420ms);
}
.mt-line.is-fade .mt-line-path,
.mt-line.is-fade .mt-line-hit,
.mt-line.is-fade .mt-line-label { opacity: 0; }
.mt-line.is-fade.is-in .mt-line-path {
  opacity: 1;
  transition: opacity 620ms var(--mt-ease) var(--mt-delay, 0ms);
}
.mt-line.is-fade.is-in .mt-line-hit {
  opacity: 1;
  transition: opacity 400ms linear calc(var(--mt-delay, 0ms) + 380ms);
}
.mt-line.is-fade.is-in .mt-line-label {
  opacity: 1;
  transition: opacity 460ms var(--mt-ease) calc(var(--mt-delay, 0ms) + 420ms);
}

/* 线路端点名 */
.mt-line-label {
  fill: var(--mt-tone);
  font-family: var(--mt-font);
  font-size: ${metrics.lineLabelSize}px;
  font-weight: 600;
  letter-spacing: .02em;
  paint-order: stroke;
  stroke: var(--mt-paper);
  stroke-width: 4px;
  stroke-linejoin: round;
  pointer-events: none;
}
.mt-line-label--start { fill-opacity: .72; }
.mt-root[data-theme="dark"] .mt-line-label--start { fill-opacity: .58; }
/* 环线线名在环内侧，周围没有线路压着，可以更实一点 */
.mt-line[data-loop="true"] .mt-line-label { fill-opacity: .8; }
.mt-root[data-theme="dark"] .mt-line[data-loop="true"] .mt-line-label { fill-opacity: .66; }

/* ---------- 换乘脉冲 ---------- */
.mt-transfers { pointer-events: none; }
.mt-transfer-pulse {
  fill: none;
  stroke: var(--mt-tone);
  stroke-width: 2px;
  opacity: 0;
  transform-box: fill-box;
  transform-origin: center;
  animation: mt-transfer-pulse ${motion.transferPulse}ms var(--mt-ease-std) infinite;
  animation-delay: var(--mt-pulse-delay, 0ms);
}
@keyframes mt-transfer-pulse {
  0% { transform: scale(1); opacity: .34; }
  72% { opacity: 0; }
  100% { transform: scale(2.35); opacity: 0; }
}

/* ---------- 站点 ---------- */
.mt-stations { pointer-events: none; }
.mt-station { cursor: pointer; outline: none; pointer-events: none; }
.mt-station-hit { fill: transparent; pointer-events: all; }
.mt-station-ring {
  fill: var(--mt-paper);
  stroke: var(--mt-tone);
  stroke-width: 3.2px;
  transform-box: fill-box;
  transform-origin: center;
  transform: scale(var(--mt-st-scale));
  transition: transform ${motion.hover}ms var(--mt-ease), stroke-width ${motion.hover}ms var(--mt-ease);
  pointer-events: none;
}
.mt-station-dot {
  fill: var(--mt-tone);
  stroke: none;
  transform-box: fill-box;
  transform-origin: center;
  transform: scale(var(--mt-st-scale));
  transition: transform ${motion.hover}ms var(--mt-ease);
  pointer-events: none;
}
.mt-station[data-type="transfer"] .mt-station-ring { stroke-width: 3.4px; }
.mt-station[data-type="transfer"] .mt-station-dot {
  fill: var(--mt-paper);
  stroke: var(--mt-tone);
  stroke-width: 2.4px;
}
.mt-station[data-type="terminus"] .mt-station-ring {
  fill: var(--mt-tone);
  stroke: var(--mt-paper);
  stroke-width: 2.6px;
}
.mt-station[data-type="terminus"] .mt-station-dot { display: none; }
.mt-station[data-closed="true"] .mt-station-ring { stroke: var(--mt-muted); }
.mt-station[data-closed="true"] .mt-station-dot { fill: var(--mt-muted); }
.mt-station[data-closed="true"] .mt-station-label { fill: var(--mt-muted); }
.mt-station[data-closed="true"] { opacity: .62; }

.mt-station-pulse {
  fill: none;
  stroke: var(--mt-tone);
  stroke-width: 2.4px;
  opacity: 0;
  transform-box: fill-box;
  transform-origin: center;
  pointer-events: none;
}
.mt-station.is-active .mt-station-pulse {
  animation: mt-station-pulse 2200ms var(--mt-ease-std) infinite;
}
@keyframes mt-station-pulse {
  0% { transform: scale(.92); opacity: .5; }
  70% { opacity: 0; }
  100% { transform: scale(1.85); opacity: 0; }
}
.mt-station.is-active .mt-station-label { opacity: 1; }

/* 站名：13px + paper 描边，压线也读得清 */
.mt-station-label {
  font-family: var(--mt-font);
  font-size: ${metrics.labelSize}px;
  font-weight: 500;
  letter-spacing: .01em;
  fill: var(--mt-text);
  opacity: .82;
  paint-order: stroke;
  stroke: var(--mt-paper);
  stroke-width: 3.5px;
  stroke-linejoin: round;
  pointer-events: none;
  transition: opacity ${motion.hover}ms var(--mt-ease);
}
.mt-station[data-type="transfer"] .mt-station-label,
.mt-station[data-type="terminus"] .mt-station-label { font-weight: 650; }

/* 收藏星标 */
.mt-station-star {
  fill: var(--mt-accent);
  pointer-events: none;
  transform-box: fill-box;
  transform-origin: center;
  transform: scale(var(--mt-st-scale));
}

/* 站点入场（opacity + scale .6 弹入；delay 由行内 --mt-delay 给） */
.mt-station.is-in { animation: mt-station-pop ${motion.stationPop}ms var(--mt-ease-pop) var(--mt-delay, 0ms) backwards; }
.mt-station.is-in .mt-station-ring,
.mt-station.is-in .mt-station-dot {
  animation: mt-station-body-pop ${motion.stationPop}ms var(--mt-ease-pop) var(--mt-delay, 0ms) backwards;
}
.mt-station.is-in .mt-station-label {
  animation: mt-station-label-in 220ms linear var(--mt-delay, 0ms) backwards;
}
@keyframes mt-station-pop { from { opacity: 0; } }
@keyframes mt-station-body-pop {
  from { transform: scale(calc(var(--mt-st-scale) * .6)); opacity: .3; }
}
@keyframes mt-station-label-in { from { opacity: 0; } }

/* hover：站点放大、所在线路高亮、其它线降透明度、站名强制显示 */
.mt-station.is-hover .mt-station-ring {
  transform: scale(calc(var(--mt-st-scale) * ${metrics.stationHoverScale}));
  stroke-width: 3.6px;
}
.mt-station.is-hover .mt-station-dot {
  transform: scale(calc(var(--mt-st-scale) * ${metrics.stationHoverScale}));
}
.mt-root[data-hover="1"] .mt-station.is-hover .mt-station-label,
.mt-root[data-hover="1"] .mt-station.is-soft-hover .mt-station-label { opacity: 1; }

/* LOD：far 只留线名 + 点；mid 只显示主要站；near 全部；close 更大 */
.mt-root[data-lod="far"] .mt-station-label { opacity: 0; }
.mt-root[data-lod="far"] .mt-station-star { opacity: 0; }
.mt-root[data-lod="far"] .mt-line-label--start { fill-opacity: .46; }
.mt-root[data-lod="far"] .mt-line-label { font-size: ${metrics.lineLabelSize + 1}px; }
.mt-root[data-lod="far"] .mt-transfer-pulse { opacity: 0; }
.mt-root[data-lod="mid"] .mt-station-label { opacity: 0; }
.mt-root[data-lod="mid"] .mt-station[data-type="transfer"] .mt-station-label,
.mt-root[data-lod="mid"] .mt-station[data-type="terminus"] .mt-station-label,
.mt-root[data-lod="mid"] .mt-station.is-active .mt-station-label { opacity: .92; }
.mt-root[data-lod="near"] .mt-station-label { opacity: .82; }
.mt-root[data-lod="close"] .mt-station-label { opacity: .92; }

/* 选中线路时：其它线站点/色晕一起淡下去，视线留在当前线上 */
.mt-root.is-line-highlight .mt-zone {
  opacity: .3;
  transition: opacity ${motion.highlight}ms var(--mt-ease);
}
.mt-root.is-line-highlight .mt-zone.is-active { opacity: .92; }
.mt-station { transition: opacity ${motion.highlight}ms var(--mt-ease); }
.mt-station.is-dim { opacity: .42; }

/* ---------- 列车 ---------- */
.mt-train {
  pointer-events: none;
  transform-box: fill-box;
  transform-origin: 50% 50%;
  transition: opacity 260ms var(--mt-ease);
  will-change: transform;
}
.mt-train.is-hidden,
.mt-train[data-state="idle"] { opacity: 0; }
.mt-train-halo { fill: var(--mt-accent); opacity: .16; }
.mt-train[data-state="playing"] .mt-train-halo {
  animation: mt-train-glow 2600ms ease-in-out infinite;
}
.mt-train-shell {
  fill: var(--mt-accent);
  stroke: var(--mt-paper);
  stroke-width: 1.4;
}
.mt-train-window { fill: var(--mt-paper); opacity: .94; }
.mt-train-light { fill: var(--mt-text); }
.mt-train[data-state="paused"] .mt-train-body {
  animation: mt-train-breathe 1600ms ease-in-out infinite;
}
@keyframes mt-train-glow {
  0%, 100% { opacity: .1; }
  50% { opacity: .24; }
}
@keyframes mt-train-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: .5; }
}

/* ---------- 浮层通用 ---------- */
.mt-hud, .mt-legend, .mt-zoombar, .mt-hint, .mt-linebar, .mt-card {
  position: absolute;
  z-index: 6;
}
.mt-icon-btn {
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 13px;
  border: 1px solid var(--mt-border);
  background: var(--mt-surface);
  color: var(--mt-text-soft);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  backdrop-filter: blur(18px) saturate(1.2);
  box-shadow: var(--mt-shadow);
  cursor: pointer;
  font-family: inherit;
  transition:
    transform ${motion.hover}ms var(--mt-ease),
    background ${motion.hover}ms var(--mt-ease),
    color ${motion.hover}ms var(--mt-ease);
}
.mt-icon-btn:hover { transform: translateY(-1px); background: var(--mt-surface-strong); color: var(--mt-text); }
.mt-icon-btn:active { transform: scale(.96); }
.mt-icon-btn--sm { width: 30px; height: 30px; border-radius: 50%; box-shadow: none; }
.mt-btn {
  height: 32px;
  padding: 0 15px;
  border-radius: 999px;
  border: 1px solid var(--mt-border);
  background: transparent;
  color: var(--mt-text-soft);
  font-family: inherit;
  font-size: 12px;
  letter-spacing: .05em;
  cursor: pointer;
  white-space: nowrap;
  transition:
    transform ${motion.hover}ms var(--mt-ease),
    background ${motion.hover}ms var(--mt-ease),
    color ${motion.hover}ms var(--mt-ease);
}
.mt-btn:hover { transform: translateY(-1px); background: var(--mt-surface-strong); color: var(--mt-text); }
.mt-btn:active { transform: scale(.97); }
.mt-btn--primary {
  background: var(--mt-accent);
  border-color: transparent;
  color: var(--mt-accent-contrast);
  font-weight: 600;
}
.mt-btn--primary:hover { background: var(--mt-accent); color: var(--mt-accent-contrast); filter: brightness(1.06); }
.mt-icon-btn:focus-visible,
.mt-btn:focus-visible,
.mt-legend-item:focus-visible,
.mt-zoom-btn:focus-visible,
.mt-card-close:focus-visible,
.mt-station:focus-visible .mt-station-ring {
  outline: 2px solid var(--mt-accent);
  outline-offset: 2px;
}
.mt-station:focus-visible .mt-station-ring { stroke-width: 4px; }

/* ---------- 面包屑 / HUD ---------- */
.mt-hud {
  top: 22px;
  left: 24px;
  right: 24px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  pointer-events: none;
}
.mt-crumb {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 18px 11px;
  border-radius: 16px;
  background: var(--mt-surface);
  border: 1px solid var(--mt-border);
  -webkit-backdrop-filter: blur(18px) saturate(1.25);
  backdrop-filter: blur(18px) saturate(1.25);
  box-shadow: var(--mt-shadow);
  pointer-events: none;
  max-width: min(560px, 52vw);
}
.mt-crumb-kicker {
  font-size: 10.5px;
  letter-spacing: .26em;
  color: var(--mt-muted);
  text-transform: uppercase;
}
.mt-crumb-title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: .02em;
  color: var(--mt-text);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mt-hud-actions { display: flex; gap: 8px; pointer-events: auto; }

/* ---------- 图例 ---------- */
.mt-legend {
  left: 24px;
  bottom: 26px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.mt-legend-item {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 34px;
  padding: 0 13px 0 11px;
  border-radius: 999px;
  border: 1px solid var(--mt-border);
  background: var(--mt-surface);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  backdrop-filter: blur(18px) saturate(1.2);
  color: var(--mt-text-soft);
  font-family: inherit;
  cursor: pointer;
  transition:
    transform ${motion.hover}ms var(--mt-ease),
    background ${motion.hover}ms var(--mt-ease),
    border-color ${motion.hover}ms var(--mt-ease);
}
.mt-legend-item:hover { transform: translateX(2px); background: var(--mt-surface-strong); }
.mt-legend-item.is-active {
  border-color: var(--mt-tone);
  background: var(--mt-surface-strong);
}
.mt-root.is-line-highlight .mt-legend-item:not(.is-active) { opacity: .5; }
.mt-legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--mt-tone);
  box-shadow: 0 0 0 3px var(--mt-tone-soft);
  flex: none;
}
.mt-legend-item[data-dashed="true"] .mt-legend-dot {
  background: transparent;
  border: 2px dashed var(--mt-tone);
  box-shadow: none;
}
.mt-legend-name {
  font-size: 12.5px;
  font-weight: 550;
  letter-spacing: .02em;
  color: var(--mt-text-soft);
  max-width: 132px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mt-legend-item.is-active .mt-legend-name { color: var(--mt-text); }
.mt-legend-count {
  font-size: 10.5px;
  color: var(--mt-muted);
  font-variant-numeric: tabular-nums;
}

/* ---------- 缩放条 ---------- */
.mt-zoombar {
  right: 24px;
  bottom: 26px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 5px;
  border-radius: 999px;
  background: var(--mt-surface);
  border: 1px solid var(--mt-border);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  backdrop-filter: blur(18px) saturate(1.2);
  box-shadow: var(--mt-shadow);
}
.mt-zoom-btn {
  min-width: 32px;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--mt-text-soft);
  font-family: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: background ${motion.hover}ms var(--mt-ease), color ${motion.hover}ms var(--mt-ease);
}
.mt-zoom-btn:hover { background: var(--mt-surface-strong); color: var(--mt-text); }
.mt-zoom-btn--fit { font-size: 11.5px; letter-spacing: .06em; padding: 0 10px; }
.mt-zoom-value {
  min-width: 48px;
  text-align: center;
  font-family: var(--mt-mono);
  font-size: 11.5px;
  letter-spacing: .02em;
  color: var(--mt-text-soft);
  font-variant-numeric: tabular-nums;
}
.mt-zoombar-sep { width: 1px; height: 16px; background: var(--mt-border); margin: 0 4px; }

/* ---------- 底部提示 ---------- */
.mt-hint {
  left: 50%;
  bottom: 26px;
  transform: translateX(-50%);
  padding: 7px 16px;
  border-radius: 999px;
  background: var(--mt-surface);
  border: 1px solid var(--mt-border);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
  font-size: 11.5px;
  letter-spacing: .1em;
  color: var(--mt-muted);
  white-space: nowrap;
  pointer-events: none;
  z-index: 5;
  transition: opacity ${motion.exit}ms var(--mt-ease), transform ${motion.exit}ms var(--mt-ease);
}
.mt-root.is-linebar-open .mt-hint { opacity: 0; transform: translate(-50%, 10px); }

/* ---------- 线路信息条 ---------- */
.mt-linebar {
  left: 50%;
  bottom: 76px;
  transform: translate(-50%, 14px) scale(.98);
  transform-origin: 50% 100%;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 9px 10px 9px 18px;
  border-radius: 999px;
  background: var(--mt-surface-strong);
  border: 1px solid var(--mt-border);
  -webkit-backdrop-filter: blur(20px) saturate(1.2);
  backdrop-filter: blur(20px) saturate(1.2);
  box-shadow: var(--mt-shadow);
  opacity: 0;
  pointer-events: none;
  transition: opacity ${motion.highlight}ms var(--mt-ease), transform ${motion.highlight}ms var(--mt-ease);
  z-index: 7;
}
.mt-linebar.is-open { opacity: 1; pointer-events: auto; transform: translate(-50%, 0) scale(1); }
.mt-linebar-line { display: flex; align-items: center; gap: 9px; }
.mt-linebar-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--mt-tone, var(--mt-accent));
  box-shadow: 0 0 0 4px var(--mt-tone-soft, transparent);
  flex: none;
}
.mt-linebar-name { font-size: 13.5px; font-weight: 600; letter-spacing: .02em; color: var(--mt-text); }
.mt-linebar-meta { font-size: 11.5px; color: var(--mt-muted); letter-spacing: .04em; }
.mt-linebar .mt-btn { height: 30px; padding: 0 14px; }

/* ---------- 站点卡片 ---------- */
.mt-card {
  right: 26px;
  top: 50%;
  width: min(320px, calc(100vw - 44px));
  transform: translateY(-50%);
  z-index: 8;
  pointer-events: none;
}
.mt-card-inner {
  position: relative;
  padding: 14px;
  border-radius: 20px;
  background: var(--mt-surface);
  border: 1px solid var(--mt-border);
  -webkit-backdrop-filter: blur(24px) saturate(1.25);
  backdrop-filter: blur(24px) saturate(1.25);
  box-shadow: var(--mt-shadow);
  opacity: 0;
  transform: translateY(14px) scale(.94);
  transition: opacity ${motion.card}ms var(--mt-ease), transform ${motion.card}ms var(--mt-ease);
}
.mt-card.is-open { pointer-events: auto; }
.mt-card.is-open .mt-card-inner { opacity: 1; transform: translateY(0) scale(1); }
.mt-card-cover {
  position: relative;
  height: 168px;
  border-radius: 13px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(140% 110% at 18% 0%, var(--mt-tone-soft, var(--mt-paper-2)), transparent 62%),
    linear-gradient(148deg, var(--mt-tone, var(--mt-accent)), var(--mt-tone-glow, var(--mt-paper-2)));
  box-shadow: inset 0 0 0 1px var(--mt-border);
}
.mt-card-cover-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mt-card-cover.is-art::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background:
    repeating-radial-gradient(circle at 50% 46%, rgba(0, 0, 0, .032) 0 1px, transparent 1px 12px),
    radial-gradient(120% 90% at 50% 0%, rgba(255, 255, 255, .22), transparent 58%),
    linear-gradient(180deg, transparent 58%, rgba(0, 0, 0, .12));
  pointer-events: none;
}
.mt-card-cover-art {
  position: relative;
  z-index: 1;
  font-size: 54px;
  font-weight: 650;
  color: var(--mt-accent-contrast);
  opacity: .94;
  letter-spacing: .04em;
  text-shadow: 0 2px 16px var(--mt-tone-soft, transparent);
}
.mt-card-info { padding: 13px 4px 0; }
.mt-card-title {
  font-size: 19px;
  font-weight: 650;
  line-height: 1.32;
  letter-spacing: .01em;
  color: var(--mt-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.mt-card-artist { margin-top: 4px; font-size: 13px; color: var(--mt-text-soft); }
.mt-card-album { margin-top: 3px; font-size: 11.5px; color: var(--mt-muted); }
.mt-card-album:empty, .mt-card-transfer:empty { display: none; }
.mt-card-tags { display: flex; gap: 8px; margin-top: 10px; }
.mt-card-tags > span {
  font-size: 10.5px;
  letter-spacing: .06em;
  color: var(--mt-muted);
  border: 1px solid var(--mt-border);
  border-radius: 999px;
  padding: 3px 9px;
  white-space: nowrap;
}
.mt-card-transfer {
  margin-top: 12px;
  padding: 8px 11px;
  border-radius: 10px;
  border: 1px dashed var(--mt-border);
  background: var(--mt-tone-soft, var(--mt-paper-2));
  font-size: 11.5px;
  letter-spacing: .04em;
  color: var(--mt-text-soft);
}
.mt-card-actions { display: flex; gap: 8px; margin-top: 14px; }
.mt-card-actions .mt-btn { flex: 1; height: 36px; padding: 0 10px; }
.mt-card-close {
  position: absolute;
  top: 22px;
  right: 22px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--mt-border);
  background: var(--mt-surface-strong);
  color: var(--mt-text-soft);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  cursor: pointer;
  transition: transform ${motion.hover}ms var(--mt-ease), color ${motion.hover}ms var(--mt-ease);
}
.mt-card-close:hover { transform: translateY(-1px); color: var(--mt-text); }

/* ---------- 响应式兜底 ---------- */
@media (max-width: 1000px) {
  .mt-legend-count { display: none; }
  .mt-hint { display: none; }
  .mt-crumb { max-width: 44vw; }
}
@media (max-height: 700px) {
  .mt-card-cover { height: 128px; }
}

/* ---------- 站名防碰撞（relayoutLabels） ---------- */
/* relayout 期间禁用标签 opacity 过渡，否则读到的是过渡起点、无法判断自然可见性 */
.mt-root.is-measuring .mt-station-label,
.mt-root.is-measuring .mt-line-label { transition: none !important; }
/* 所有候选位置都撞时隐藏普通站站名；换乘/端点永不隐藏 */
.mt-station-label.is-label-hidden,
.mt-line-label.is-label-hidden { opacity: 0 !important; pointer-events: none; }

/* ---------- reduced motion ---------- */
@media (prefers-reduced-motion: reduce) {
  .mt-line.is-grow .mt-line-path,
  .mt-line.is-grow.is-in .mt-line-path,
  .mt-line.is-grow .mt-line-halo,
  .mt-line.is-grow.is-in .mt-line-halo,
  .mt-line.is-grow.is-in .mt-line-hit,
  .mt-line.is-grow.is-in .mt-line-label,
  .mt-line.is-fade .mt-line-path,
  .mt-line.is-fade.is-in .mt-line-path,
  .mt-line.is-fade.is-in .mt-line-hit,
  .mt-line.is-fade.is-in .mt-line-label {
    transition-duration: .001ms !important;
    transition-delay: 0ms !important;
  }
  .mt-station.is-in,
  .mt-station.is-in .mt-station-ring,
  .mt-station.is-in .mt-station-dot,
  .mt-station.is-in .mt-station-label,
  .mt-transfer-pulse,
  .mt-station.is-active .mt-station-pulse,
  .mt-train[data-state="playing"] .mt-train-halo,
  .mt-train[data-state="paused"] .mt-train-body {
    animation: none !important;
  }
  .mt-camera,
  .mt-card-inner,
  .mt-linebar,
  .mt-icon-btn,
  .mt-btn,
  .mt-legend-item,
  .mt-zoom-btn,
  .mt-station-label,
  .mt-station-ring,
  .mt-station-dot {
    transition-duration: .001ms !important;
    transition-delay: 0ms !important;
  }
}
`;
}

const STYLE_CSS = buildStyleCss();

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_CSS;
  document.head.append(style);
}

/* ------------------------------------------------------------------ */
/* 对外类型（签名冻结）                                                */
/* ------------------------------------------------------------------ */

export interface MetroRendererOptions {
  /** 主题模式，默认 'auto'（跟随页面 data-theme / 系统偏好）。 */
  theme?: MetroThemeMode;
  /** 点击站点。 */
  onSelect?: (stationId: string) => void;
  /** 点击线路 / 图例；null = 取消高亮。 */
  onLineSelect?: (lineId: string | null) => void;
  /** 线路信息条「播放全部」。 */
  onLinePlay?: (lineId: string) => void;
  /** 卡片动作按钮。 */
  onCardAction?: (action: MetroCardAction['type'], song: MetroSong) => void;
  /** 卡片关闭按钮。 */
  onCardClose?: () => void;
  /** 缩放条按钮。 */
  onZoom?: (action: 'in' | 'out' | 'fit') => void;
  /** HUD 返回按钮。 */
  onClose?: () => void;
  /** 未实现动作的提示文案。 */
  onToast?: (message: string) => void;
}

export interface MetroLineMetric {
  path: SVGPathElement;
  /** 每个站点的累计弧长；末项 = total。环线 offsets.length = 站数 + 1。 */
  offsets: number[];
  total: number;
}

export interface MetroRenderer {
  readonly root: HTMLElement;
  readonly svg: SVGSVGElement;
  readonly cameraGroup: SVGGElement;
  /** 建图（可重复调用：清空重建 + 播放入场动画）。 */
  setData(map: MetroMap): void;
  /** 高亮某条线（null = 取消）；同时控制线路信息条与图例选中态。 */
  setHighlight(lineId: string | null): void;
  /** 当前播放歌曲：站点呼吸光环；null = 无。 */
  setActiveTrack(trackKey: string | null): void;
  /** 列车世界坐标与朝向；point=null 时隐藏。 */
  setTrain(point: MetroTrainPoint | null, state: MetroTrainState): void;
  /** 打开/关闭站点卡片；null = 关闭。 */
  setCard(stationId: string | null): void;
  setCrumb(title: string, kicker?: string): void;
  /** LOD 档位（CSS 只认这个 data 属性）。 */
  setLod(level: MetroLodLevel): void;
  /** 右下角缩放百分比显示，传原始 scale。 */
  setScaleLabel(scale: number): void;
  /**
   * 相机缩放（可选接线）：站名防碰撞布局按屏幕 px 换算是需要它；
   * 未接线时 relayoutLabels 用 cameraGroup 的 CTM 兜底。变化 > 2% 才重排。
   */
  setLabelScale(scale: number): void;
  setTheme(mode: MetroThemeMode): void;
  lineMetric(lineId: string): MetroLineMetric | null;
  destroy(): void;
}

/* ------------------------------------------------------------------ */
/* 实现                                                                */
/* ------------------------------------------------------------------ */

class MetroRendererImpl implements MetroRenderer {
  readonly root: HTMLElement;
  readonly svg: SVGSVGElement;
  readonly cameraGroup: SVGGElement;

  private readonly options: MetroRendererOptions;
  private readonly uid: string;

  private readonly paperRect: SVGRectElement;
  private readonly gridRect: SVGRectElement;
  private readonly zonesGroup: SVGGElement;
  private readonly linesGroup: SVGGElement;
  private readonly transfersGroup: SVGGElement;
  private readonly stationsGroup: SVGGElement;
  private readonly trainEl: SVGGElement;

  private readonly crumbKicker: HTMLElement;
  private readonly crumbTitle: HTMLElement;
  private readonly legendEl: HTMLElement;
  private readonly zoomValue: HTMLElement;
  private readonly linebarEl: HTMLElement;
  private readonly linebarDot: HTMLElement;
  private readonly linebarName: HTMLElement;
  private readonly linebarMeta: HTMLElement;
  private readonly cardEl: HTMLElement;
  private readonly cardCover: HTMLElement;
  private readonly cardTitle: HTMLElement;
  private readonly cardArtist: HTMLElement;
  private readonly cardAlbum: HTMLElement;
  private readonly cardSource: HTMLElement;
  private readonly cardDuration: HTMLElement;
  private readonly cardTransfer: HTMLElement;

  private map: MetroMap | null = null;
  private readonly metrics = new Map<string, MetroLineMetric>();
  private readonly lineEls = new Map<string, SVGGElement>();
  private readonly lineStationIds = new Map<string, string[]>();
  private readonly stationEls = new Map<string, SVGGElement>();
  private readonly stationById = new Map<string, MetroStation>();
  private readonly trackStationIds = new Map<string, string>();
  private readonly legendEls = new Map<string, HTMLButtonElement>();
  private readonly zoneEls = new Map<string, SVGCircleElement>();
  private readonly stationLabelEls = new Map<string, SVGTextElement>();
  private readonly labelMetrics = new Map<string, LabelMetrics>();

  private highlight: string | null = null;
  private lod: MetroLodLevel = 'near';
  private themeMode: MetroThemeMode = 'auto';
  private cardStationId: string | null = null;
  private hoveredStation: SVGGElement | null = null;
  private hoveredLine: SVGGElement | null = null;

  private readonly disposers: Array<() => void> = [];
  private timers: number[] = [];
  private rafId = 0;
  private labelScale = 0;
  private labelRafId = 0;
  private labelTimer = 0;
  private cameraObserver: MutationObserver | null = null;
  private destroyed = false;

  constructor(host: HTMLElement, options: MetroRendererOptions = {}) {
    this.options = options;
    rendererSeq += 1;
    this.uid = `mt${rendererSeq}`;
    ensureStyle();

    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    this.root = htmlEl('div', 'mt-root');
    this.root.dataset.lod = 'near';
    host.append(this.root);

    const shell = buildSvgShell(this.uid);
    this.svg = shell.svg;
    this.cameraGroup = shell.cameraGroup;
    this.paperRect = shell.paperRect;
    this.gridRect = shell.gridRect;
    this.zonesGroup = shell.zonesGroup;
    this.linesGroup = shell.linesGroup;
    this.transfersGroup = shell.transfersGroup;
    this.stationsGroup = shell.stationsGroup;
    this.trainEl = shell.trainEl;
    this.root.append(this.svg);

    this.root.insertAdjacentHTML('beforeend', overlayMarkup());
    this.crumbKicker = mustFind<HTMLElement>(this.root, '.mt-crumb-kicker');
    this.crumbTitle = mustFind<HTMLElement>(this.root, '.mt-crumb-title');
    this.legendEl = mustFind<HTMLElement>(this.root, '.mt-legend');
    this.zoomValue = mustFind<HTMLElement>(this.root, '.mt-zoom-value');
    this.linebarEl = mustFind<HTMLElement>(this.root, '.mt-linebar');
    this.linebarDot = mustFind<HTMLElement>(this.root, '.mt-linebar-dot');
    this.linebarName = mustFind<HTMLElement>(this.root, '.mt-linebar-name');
    this.linebarMeta = mustFind<HTMLElement>(this.root, '.mt-linebar-meta');
    this.cardEl = mustFind<HTMLElement>(this.root, '.mt-card');
    this.cardCover = mustFind<HTMLElement>(this.root, '.mt-card-cover');
    this.cardTitle = mustFind<HTMLElement>(this.root, '.mt-card-title');
    this.cardArtist = mustFind<HTMLElement>(this.root, '.mt-card-artist');
    this.cardAlbum = mustFind<HTMLElement>(this.root, '.mt-card-album');
    this.cardSource = mustFind<HTMLElement>(this.root, '.mt-card-source');
    this.cardDuration = mustFind<HTMLElement>(this.root, '.mt-card-duration');
    this.cardTransfer = mustFind<HTMLElement>(this.root, '.mt-card-transfer');

    this.setTheme(options.theme ?? 'auto');
    this.bind();

    // 跟随系统主题（auto 模式下实时切换）
    const themeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onThemeQuery = (): void => {
      if (this.themeMode === 'auto' && !this.destroyed) this.setTheme('auto');
    };
    if (typeof themeQuery.addEventListener === 'function') {
      themeQuery.addEventListener('change', onThemeQuery);
      this.disposers.push(() => themeQuery.removeEventListener('change', onThemeQuery));
    }

    // 相机可能自己动（fit / 手势 / Lead 的 camera.onChange 未接线时）：
    // transform 停下 160ms 后再重排，避免用过渡中的 scale 算出错误间距
    const cameraObserver = new MutationObserver(() => this.scheduleRelayout(160));
    cameraObserver.observe(this.cameraGroup, { attributes: true, attributeFilter: ['transform'] });
    this.cameraObserver = cameraObserver;
    this.disposers.push(() => {
      cameraObserver.disconnect();
      if (this.cameraObserver === cameraObserver) this.cameraObserver = null;
    });

    // 字体加载完成后文本尺寸会变：清掉量测缓存并重排一次
    const fontsReady = document.fonts?.ready;
    if (fontsReady && typeof fontsReady.then === 'function') {
      void fontsReady
        .then(() => {
          if (this.destroyed) return;
          this.labelMetrics.clear();
          this.scheduleRelayout();
        })
        .catch(() => {
          /* 忽略字体加载异常 */
        });
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  private bind(): void {
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('keydown', this.onKeyDown);
    this.stationsGroup.addEventListener('pointerover', this.onStationsOver);
    this.stationsGroup.addEventListener('pointerout', this.onStationsOut);
    this.stationsGroup.addEventListener('pointerleave', this.onStationsLeave);
    this.linesGroup.addEventListener('pointerover', this.onLinesOver);
    this.linesGroup.addEventListener('pointerout', this.onLinesOut);
    this.linesGroup.addEventListener('pointerleave', this.onLinesLeave);

    this.disposers.push(
      () => this.root.removeEventListener('click', this.onClick),
      () => this.root.removeEventListener('keydown', this.onKeyDown),
      () => this.stationsGroup.removeEventListener('pointerover', this.onStationsOver),
      () => this.stationsGroup.removeEventListener('pointerout', this.onStationsOut),
      () => this.stationsGroup.removeEventListener('pointerleave', this.onStationsLeave),
      () => this.linesGroup.removeEventListener('pointerover', this.onLinesOver),
      () => this.linesGroup.removeEventListener('pointerout', this.onLinesOut),
      () => this.linesGroup.removeEventListener('pointerleave', this.onLinesLeave),
    );
  }

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // 站点
    const stationEl = target.closest<SVGGElement>('.mt-station');
    if (stationEl && this.stationsGroup.contains(stationEl)) {
      const stationId = stationEl.dataset.station;
      if (stationId) {
        event.preventDefault();
        this.selectStation(stationId);
        return;
      }
    }

    // 线路
    const hitEl = target.closest<SVGPathElement>('.mt-line-hit');
    if (hitEl) {
      const lineId = hitEl.closest<SVGGElement>('.mt-line')?.dataset.line;
      if (lineId) this.chooseLine(lineId);
      return;
    }

    // 图例
    const legendItem = target.closest<HTMLElement>('.mt-legend-item');
    if (legendItem) {
      const lineId = legendItem.dataset.line ?? null;
      if (lineId) this.chooseLine(lineId);
      return;
    }

    const actionEl = target.closest<HTMLElement>('[data-act]');
    if (!actionEl) return;
    this.handleAction(actionEl.dataset.act ?? '');
  };

  private handleAction(action: string): void {
    switch (action) {
      case 'search':
        this.toast('搜索站点将在 M3 接入');
        return;
      case 'close':
        if (this.options.onClose) this.options.onClose();
        else this.toast('返回主界面将在 M2 接入');
        return;
      case 'out':
        this.options.onZoom?.('out');
        return;
      case 'in':
        this.options.onZoom?.('in');
        return;
      case 'fit':
        this.options.onZoom?.('fit');
        return;
      case 'play-line':
        if (this.highlight) this.options.onLinePlay?.(this.highlight);
        return;
      case 'clear-line':
        this.chooseLine(null);
        return;
      case 'close-card':
        if (this.options.onCardClose) this.options.onCardClose();
        else this.setCard(null);
        return;
      case 'play':
      case 'queue':
      case 'locate': {
        const station = this.cardStationId ? this.stationById.get(this.cardStationId) : undefined;
        if (!station) return;
        const cardAction = action as MetroCardAction['type'];
        if (this.options.onCardAction) this.options.onCardAction(cardAction, station.song);
        else this.toast(this.cardActionLabel(cardAction));
        return;
      }
      default:
        return;
    }
  }

  private cardActionLabel(action: MetroCardAction['type']): string {
    if (action === 'play') return '播放将在 M3 接入';
    if (action === 'queue') return '加入队列将在 M3 接入';
    if (action === 'locate') return '定位将在 M2 接入';
    return '该动作尚未接入';
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const stationEl = target.closest<SVGGElement>('.mt-station');
    const stationId = stationEl?.dataset.station;
    if (!stationId) return;
    event.preventDefault();
    this.selectStation(stationId);
  };

  private selectStation(stationId: string): void {
    if (this.options.onSelect) this.options.onSelect(stationId);
    else this.setCard(stationId);
  }

  /** 线路点击/图例点击：当前已高亮同一线路时传 null 表示取消。 */
  private chooseLine(lineId: string | null): void {
    if (lineId === null) {
      if (this.options.onLineSelect) this.options.onLineSelect(null);
      else this.setHighlight(null);
      return;
    }
    const next = this.highlight === lineId ? null : lineId;
    if (this.options.onLineSelect) this.options.onLineSelect(next);
    else this.setHighlight(next);
  }

  private toast(message: string): void {
    this.options.onToast?.(message);
  }

  /* ---------------- hover ---------------- */

  private readonly onStationsOver = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const stationEl = target.closest<SVGGElement>('.mt-station');
    if (!stationEl) return;
    const related = event.relatedTarget instanceof Element
      ? event.relatedTarget.closest<SVGGElement>('.mt-station')
      : null;
    if (related === stationEl) return;
    this.applyStationHover(stationEl);
  };

  private readonly onStationsOut = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const stationEl = target.closest<SVGGElement>('.mt-station');
    if (!stationEl) return;
    const related = event.relatedTarget instanceof Element
      ? event.relatedTarget.closest<SVGGElement>('.mt-station')
      : null;
    if (related === stationEl) return;
    this.clearHover();
  };

  private readonly onStationsLeave = (): void => {
    this.clearHover();
  };

  private readonly onLinesOver = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const lineEl = target.closest<SVGGElement>('.mt-line');
    if (!lineEl || !this.linesGroup.contains(lineEl)) return;
    const related = event.relatedTarget instanceof Element
      ? event.relatedTarget.closest<SVGGElement>('.mt-line')
      : null;
    if (related === lineEl) return;
    this.applyLineHover(lineEl);
  };

  private readonly onLinesOut = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const lineEl = target.closest<SVGGElement>('.mt-line');
    if (!lineEl) return;
    const related = event.relatedTarget instanceof Element
      ? event.relatedTarget.closest<SVGGElement>('.mt-line')
      : null;
    if (related === lineEl) return;
    this.clearHover();
  };

  private readonly onLinesLeave = (): void => {
    this.clearHover();
  };

  private applyStationHover(stationEl: SVGGElement): void {
    if (this.hoveredStation === stationEl && !this.hoveredLine) return;
    this.clearHover();
    this.hoveredStation = stationEl;
    stationEl.classList.add('is-hover');
    this.root.dataset.hover = '1';
    const station = this.stationById.get(stationEl.dataset.station ?? '');
    const lineIds = station?.lineIds ?? [];
    for (const lineId of lineIds) {
      const lineEl = this.lineEls.get(lineId);
      if (lineEl) lineEl.classList.add('is-hover');
      for (const stationId of this.lineStationIds.get(lineId) ?? []) {
        this.stationEls.get(stationId)?.classList.add('is-soft-hover');
      }
    }
    // hover 会让整条线的站名强制显示 → 需要重新排布
    this.scheduleRelayout();
  }

  private applyLineHover(lineEl: SVGGElement): void {
    if (this.hoveredLine === lineEl && !this.hoveredStation) return;
    this.clearHover();
    this.hoveredLine = lineEl;
    lineEl.classList.add('is-hover');
    this.root.dataset.hover = '1';
    const lineId = lineEl.dataset.line ?? '';
    for (const stationId of this.lineStationIds.get(lineId) ?? []) {
      this.stationEls.get(stationId)?.classList.add('is-soft-hover');
    }
    this.scheduleRelayout();
  }

  private clearHover(): void {
    if (this.hoveredStation) {
      this.hoveredStation.classList.remove('is-hover');
      this.hoveredStation = null;
    }
    if (this.hoveredLine) {
      this.hoveredLine.classList.remove('is-hover');
      this.hoveredLine = null;
    }
    for (const lineEl of this.lineEls.values()) lineEl.classList.remove('is-hover');
    for (const stationEl of this.stationEls.values()) stationEl.classList.remove('is-soft-hover');
    delete this.root.dataset.hover;
    this.scheduleRelayout();
  }

  /* ---------------- 数据 → 地图 ---------------- */

  setData(map: MetroMap): void {
    this.map = map;
    this.clearTimers();
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.labelRafId) {
      window.cancelAnimationFrame(this.labelRafId);
      this.labelRafId = 0;
    }
    if (this.labelTimer) {
      window.clearTimeout(this.labelTimer);
      this.labelTimer = 0;
    }
    this.metrics.clear();
    this.lineEls.clear();
    this.lineStationIds.clear();
    this.stationEls.clear();
    this.stationById.clear();
    this.trackStationIds.clear();
    this.legendEls.clear();
    this.zoneEls.clear();
    this.stationLabelEls.clear();
    this.labelMetrics.clear();
    this.clearHover();
    this.highlight = null;
    this.cardStationId = null;

    this.linesGroup.replaceChildren();
    this.transfersGroup.replaceChildren();
    this.stationsGroup.replaceChildren();
    this.zonesGroup.replaceChildren();
    this.legendEl.replaceChildren();
    this.trainEl.classList.add('is-hidden');
    this.trainEl.dataset.state = 'idle';
    this.trainEl.style.transform = 'translate(0px, 0px) rotate(0deg)';

    // 世界纸面 / 网格：比 bounds 外扩一圈，保证 fit 时铺满视口
    const boundsWidth = map.bounds.maxX - map.bounds.minX;
    const boundsHeight = map.bounds.maxY - map.bounds.minY;
    const margin = Math.max(640, Math.max(boundsWidth, boundsHeight) * 0.32);
    const worldX = round(map.bounds.minX - margin);
    const worldY = round(map.bounds.minY - margin);
    const worldW = round(boundsWidth + margin * 2);
    const worldH = round(boundsHeight + margin * 2);
    for (const rect of [this.paperRect, this.gridRect]) {
      rect.setAttribute('x', String(worldX));
      rect.setAttribute('y', String(worldY));
      rect.setAttribute('width', String(worldW));
      rect.setAttribute('height', String(worldH));
    }

    this.buildZones(map);
    this.buildLines(map);
    this.buildTransfers(map);
    this.buildStations(map);
    this.buildLegend(map);

    const stationCount = this.stationById.size;
    this.setCrumb(`全部线路 · ${map.lines.length} 线 ${stationCount} 站`, '地铁图');
    this.root.dataset.lod = this.lod;
    this.root.classList.remove('is-line-highlight', 'is-linebar-open', 'is-card-open');
    this.linebarEl.classList.remove('is-open');
    this.linebarEl.setAttribute('aria-hidden', 'true');
    this.cardEl.classList.remove('is-open');
    this.cardEl.setAttribute('aria-hidden', 'true');
    this.cardEl.removeAttribute('data-station');

    this.playEntrance();
    this.scheduleRelayout();
  }

  private buildZones(map: MetroMap): void {
    for (const line of map.lines) {
      const points = line.stationIds
        .map((id) => map.stations[id])
        .filter((station): station is MetroStation => Boolean(station));
      if (points.length === 0) continue;
      const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const centerY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      let maxDist = 0;
      for (const point of points) {
        maxDist = Math.max(maxDist, Math.hypot(point.x - centerX, point.y - centerY));
      }
      const zone = svgEl('circle', {
        class: 'mt-zone',
        cx: round(centerX),
        cy: round(centerY),
        r: round(Math.max(150, maxDist * 1.34)),
      });
      zone.dataset.line = line.id;
      zone.dataset.tone = line.tone;
      zone.setAttribute('fill', `url(#${this.uid}-zone-${line.tone})`);
      zone.setAttribute('aria-hidden', 'true');
      this.zonesGroup.append(zone);
      this.zoneEls.set(line.id, zone);
    }
  }

  private buildLines(map: MetroMap): void {
    // 虚线（雷达/推荐类）先画：细点线压在实线下面，线名也不会被点线穿过
    const ordered = [...map.lines].sort((a, b) => Number(b.dashed) - Number(a.dashed));
    for (const line of ordered) {
      const lineEl = svgEl('g', { class: 'mt-line' });
      lineEl.dataset.line = line.id;
      lineEl.dataset.tone = line.tone;
      lineEl.dataset.dashed = String(line.dashed);
      lineEl.dataset.loop = String(line.loop);
      lineEl.dataset.stations = String(line.stationIds.length);
      applyTone(lineEl, line.tone);

      const pathData = buildLinePathD(map, line);
      const halo = svgEl('path', { class: 'mt-line-halo', d: pathData });
      const path = svgEl('path', { class: 'mt-line-path', d: pathData });
      const hit = svgEl('path', { class: 'mt-line-hit', d: pathData });
      halo.setAttribute('aria-hidden', 'true');
      hit.setAttribute('aria-hidden', 'true');
      lineEl.append(halo, path, hit);

      const points = line.stationIds
        .map((id) => map.stations[id])
        .filter((station): station is MetroStation => Boolean(station))
        .map((station) => ({ x: station.x, y: station.y }));

      if (points.length >= 2) {
        if (line.loop) {
          // 环线线名放在「最高一段的中点、朝环内侧 27px」：不压环上站名，也不和线路名抢位置
          const guide = line.pathPoints ?? points;
          let topMidX = guide[0].x;
          let topMidY = Number.POSITIVE_INFINITY;
          for (let index = 0; index < guide.length; index += 1) {
            const a = guide[index];
            const b = guide[(index + 1) % guide.length];
            const midY = (a.y + b.y) / 2;
            if (midY < topMidY) {
              topMidY = midY;
              topMidX = (a.x + b.x) / 2;
            }
          }
          const centerX = guide.reduce((sum, point) => sum + point.x, 0) / guide.length;
          const centerY = guide.reduce((sum, point) => sum + point.y, 0) / guide.length;
          let inwardX = centerX - topMidX;
          let inwardY = centerY - topMidY;
          const inwardLength = Math.hypot(inwardX, inwardY);
          if (inwardLength > 0.001) {
            inwardX /= inwardLength;
            inwardY /= inwardLength;
          } else {
            inwardX = 0;
            inwardY = 1;
          }
          const labelX = topMidX + inwardX * 27;
          const labelY = topMidY + inwardY * 27;
          const label = svgEl('text', {
            class: 'mt-line-label mt-line-label--start',
            x: round(labelX),
            y: round(labelY),
          });
          label.setAttribute('text-anchor', 'middle');
          label.textContent = line.name;
          lineEl.append(label);
          annotateLineLabel(label, round(labelX), round(labelY), inwardX, inwardY);
        } else {
          const start = lineLabelPlacement(points, true);
          const startLabel = svgEl('text', {
            class: 'mt-line-label mt-line-label--start',
            x: round(start.x),
            y: round(start.y),
          });
          startLabel.setAttribute('text-anchor', start.anchor);
          startLabel.textContent = line.name;
          lineEl.append(startLabel);
          const startDir = endpointDirection(points, true);
          annotateLineLabel(startLabel, round(start.x), round(start.y), startDir.x, startDir.y);

          const end = lineLabelPlacement(points, false);
          const endLabel = svgEl('text', {
            class: 'mt-line-label mt-line-label--end',
            x: round(end.x),
            y: round(end.y),
          });
          endLabel.setAttribute('text-anchor', end.anchor);
          endLabel.textContent = line.name;
          lineEl.append(endLabel);
          const endDir = endpointDirection(points, false);
          annotateLineLabel(endLabel, round(end.x), round(end.y), endDir.x, endDir.y);
        }
      }

      this.linesGroup.append(lineEl);

      // lineMetric：普通线 offsets.length = 站数（末项 = total）；
      // 环线 offsets.length = 站数 + 1（末项 = total，供列车沿整圈跑）
      // pathPoints 线路（环线八边形）：站点不在折角上 → 把站点投影到折线求弧长，
      // 再按 `实际 path 长度 / 折线周长` 缩放；否则沿用站点直线距离累加。
      const total = pathData ? path.getTotalLength() : 0;
      let cumulative: number[];
      if (line.pathPoints !== undefined && line.pathPoints.length >= 2) {
        cumulative = stationArcsOnGuidePath(line.pathPoints, points, line.loop);
      } else {
        cumulative = [];
        let walked = 0;
        for (let index = 0; index < points.length; index += 1) {
          if (index > 0) {
            walked += Math.hypot(
              points[index].x - points[index - 1].x,
              points[index].y - points[index - 1].y,
            );
          }
          cumulative.push(walked);
        }
        if (line.loop && points.length > 1) {
          walked += Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y);
          cumulative.push(walked);
        }
      }
      const denom = cumulative.length > 0 ? cumulative[cumulative.length - 1] : 0;
      const ratio = denom > 0 && Number.isFinite(total) ? total / denom : 0;
      const offsets = cumulative.map((value) => value * ratio);
      if (offsets.length > 0) offsets[offsets.length - 1] = total;
      this.metrics.set(line.id, { path, offsets, total });
      this.lineEls.set(line.id, lineEl);
      this.lineStationIds.set(line.id, [...line.stationIds]);
    }
  }

  private buildTransfers(map: MetroMap): void {
    const transfers = orderedStations(map).filter((station) => station.lineIds.length >= 2);
    transfers.forEach((station, index) => {
      const primary = stationPrimaryLine(map, station);
      const pulse = svgEl('circle', {
        class: 'mt-transfer-pulse',
        cx: round(station.x),
        cy: round(station.y),
        r: round(METRO_METRICS.transferRadius + 3),
      });
      pulse.dataset.tone = primary?.tone ?? 'ghost';
      pulse.style.setProperty('--mt-pulse-delay', `${(index * 320) % METRO_MOTION.transferPulse}ms`);
      pulse.setAttribute('aria-hidden', 'true');
      if (primary) applyTone(pulse, primary.tone);
      this.transfersGroup.append(pulse);
    });
  }

  private buildStations(map: MetroMap): void {
    const ordered = orderedStations(map);
    const centerX = (map.bounds.minX + map.bounds.maxX) / 2;
    ordered.forEach((station, index) => {
      const primary = stationPrimaryLine(map, station);
      const tone = primary?.tone ?? 'ghost';
      const stationEl = svgEl('g', { class: 'mt-station' });
      stationEl.dataset.station = station.id;
      stationEl.dataset.type = station.type;
      stationEl.dataset.tone = tone;
      stationEl.dataset.track = station.song.trackKey;
      if (station.closed) stationEl.dataset.closed = 'true';
      if (station.liked) stationEl.dataset.liked = 'true';
      stationEl.setAttribute('tabindex', '0');
      stationEl.setAttribute('role', 'button');
      stationEl.setAttribute('aria-label', `${station.song.title} · ${station.song.artist}`);
      stationEl.setAttribute('transform', `translate(${round(station.x)} ${round(station.y)})`);
      applyTone(stationEl, tone);

      const { ring, dot } = stationRadii(station);
      const hit = svgEl('circle', {
        class: 'mt-station-hit',
        cx: 0,
        cy: 0,
        r: round(METRO_METRICS.transferRadius + 6),
      });
      hit.setAttribute('aria-hidden', 'true');
      const ringEl = svgEl('circle', { class: 'mt-station-ring', cx: 0, cy: 0, r: round(ring) });
      const dotEl = svgEl('circle', { class: 'mt-station-dot', cx: 0, cy: 0, r: round(dot) });
      ringEl.setAttribute('aria-hidden', 'true');
      dotEl.setAttribute('aria-hidden', 'true');
      const pulse = svgEl('circle', {
        class: 'mt-station-pulse',
        cx: 0,
        cy: 0,
        r: round(ring + 5),
      });
      pulse.setAttribute('aria-hidden', 'true');
      stationEl.append(hit, ringEl, dotEl, pulse);

      if (station.liked) {
        const star = svgEl('path', {
          class: 'mt-station-star',
          d: starPathD(round(ring * 0.78), round(-ring * 0.78), 4.4),
        });
        star.setAttribute('aria-hidden', 'true');
        stationEl.append(star);
      }

      const side = labelSide(station.x - centerX, index);
      const isTerminus = station.type === 'terminus';
      const placement = isTerminus ? terminusLabelPlacement(map, station, ring) : null;
      const labelX = placement ? round(placement.dx) : round(side * (ring + 7));
      const labelY = placement ? round(placement.dy + 4.5) : 4.5;
      const label = svgEl('text', {
        class: 'mt-station-label',
        x: labelX,
        y: labelY,
      });
      label.setAttribute('text-anchor', placement ? placement.anchor : side > 0 ? 'start' : 'end');
      label.textContent = shortTitle(station.song.title);
      stationEl.append(label);
      this.stationLabelEls.set(station.id, label);

      this.stationsGroup.append(stationEl);
      this.stationEls.set(station.id, stationEl);
      this.stationById.set(station.id, station);
      this.trackStationIds.set(station.song.trackKey, station.id);
    });
  }

  private buildLegend(map: MetroMap): void {
    for (const line of map.lines) {
      const item = htmlEl('button', 'mt-legend-item');
      item.type = 'button';
      item.dataset.line = line.id;
      item.dataset.tone = line.tone;
      if (line.dashed) item.dataset.dashed = 'true';
      item.setAttribute('aria-label', `${line.name}（${line.stationIds.length} 站）`);
      applyTone(item, line.tone);

      const dot = htmlEl('span', 'mt-legend-dot');
      dot.setAttribute('aria-hidden', 'true');
      const name = htmlEl('span', 'mt-legend-name');
      name.textContent = line.name;
      const count = htmlEl('span', 'mt-legend-count');
      count.textContent = `${line.stationIds.length} 站`;
      item.append(dot, name, count);

      this.legendEl.append(item);
      this.legendEls.set(line.id, item);
    }
  }

  /** 入场动画：普通线生长；虚线线淡入；站点逐站弹入；reduced-motion 时瞬时。 */
  private playEntrance(): void {
    const reduced = prefersReducedMotion();
    const lineGroups = Array.from(this.linesGroup.querySelectorAll<SVGGElement>('.mt-line'));
    const stationGroups = Array.from(this.stationsGroup.querySelectorAll<SVGGElement>('.mt-station'));

    if (!reduced) {
      lineGroups.forEach((lineEl, index) => {
        const delay = index * METRO_MOTION.lineStagger;
        lineEl.style.setProperty('--mt-delay', `${delay}ms`);
        if (lineEl.dataset.dashed === 'true') {
          // 虚线自己带 dasharray，不能做生长，改为整组淡入
          lineEl.classList.add('is-fade');
          return;
        }
        lineEl.classList.add('is-grow');
        const lineId = lineEl.dataset.line ?? '';
        const metric = this.metrics.get(lineId);
        const path = lineEl.querySelector<SVGPathElement>('.mt-line-path');
        if (path && metric) path.style.setProperty('--mt-len', `${metric.total}px`);
      });
      stationGroups.forEach((stationEl, index) => {
        stationEl.style.setProperty('--mt-delay', `${index * METRO_MOTION.stationStagger}ms`);
      });
    }

    // 强制一次样式计算，保证下一帧添加 is-in 时 transition / animation 能触发
    void this.root.getBoundingClientRect();

    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = 0;
      if (this.destroyed) return;
      for (const lineEl of lineGroups) lineEl.classList.add('is-in');
      for (const stationEl of stationGroups) stationEl.classList.add('is-in');
      if (reduced) return;

      const lineTotal = METRO_MOTION.lineGrow + (lineGroups.length - 1) * METRO_MOTION.lineStagger + 260;
      this.schedule(() => {
        for (const lineEl of lineGroups) {
          lineEl.classList.remove('is-grow', 'is-fade', 'is-in');
          lineEl.style.removeProperty('--mt-delay');
          const path = lineEl.querySelector<SVGPathElement>('.mt-line-path');
          path?.style.removeProperty('--mt-len');
        }
      }, Math.max(lineTotal, 0));

      const stationTotal =
        METRO_MOTION.stationPop + (stationGroups.length - 1) * METRO_MOTION.stationStagger + 160;
      this.schedule(() => {
        for (const stationEl of stationGroups) {
          stationEl.classList.remove('is-in');
          stationEl.style.removeProperty('--mt-delay');
        }
      }, Math.max(stationTotal, 0));

      // 入场动画结束（标签全部可见）后补一次防碰撞排布
      this.schedule(
        () => this.scheduleRelayout(),
        Math.max(lineTotal, stationTotal) + 120,
      );
    });
  }

  /* ---------------- 公开 API ---------------- */

  setHighlight(lineId: string | null): void {
    const valid = lineId !== null && this.lineEls.has(lineId) ? lineId : null;
    this.highlight = valid;
    this.scheduleRelayout();

    for (const [id, lineEl] of this.lineEls) {
      lineEl.classList.toggle('is-active', id === valid);
      lineEl.classList.toggle('is-dim', valid !== null && id !== valid);
    }
    for (const [id, item] of this.legendEls) item.classList.toggle('is-active', id === valid);
    for (const [id, zone] of this.zoneEls) {
      zone.classList.toggle('is-active', id === valid);
      zone.classList.toggle('is-dim', valid !== null && id !== valid);
    }
    for (const [id, stationEl] of this.stationEls) {
      const station = this.stationById.get(id);
      const onLine = station ? station.lineIds.includes(valid ?? '') : false;
      stationEl.classList.toggle('is-dim', valid !== null && !onLine);
    }
    this.root.classList.toggle('is-line-highlight', valid !== null);

    const line = valid && this.map ? this.map.lines.find((item) => item.id === valid) : null;
    if (!line) {
      this.linebarEl.classList.remove('is-open');
      this.linebarEl.setAttribute('aria-hidden', 'true');
      this.root.classList.remove('is-linebar-open');
      return;
    }
    this.linebarDot.style.setProperty('--mt-tone', `var(--mt-tone-${line.tone})`);
    this.linebarDot.style.setProperty('--mt-tone-soft', `var(--mt-tone-${line.tone}-soft)`);
    this.linebarName.textContent = line.name;
    this.linebarMeta.textContent = line.subtitle
      ? `${line.stationIds.length} 站 · ${line.subtitle}`
      : `${line.stationIds.length} 站`;
    this.linebarEl.classList.add('is-open');
    this.linebarEl.setAttribute('aria-hidden', 'false');
    this.root.classList.add('is-linebar-open');
  }

  setActiveTrack(trackKey: string | null): void {
    this.scheduleRelayout();
    for (const stationEl of this.stationEls.values()) stationEl.classList.remove('is-active');
    if (!trackKey) return;
    const stationId = this.trackStationIds.get(trackKey);
    if (!stationId) return;
    this.stationEls.get(stationId)?.classList.add('is-active');
  }

  setTrain(point: MetroTrainPoint | null, state: MetroTrainState): void {
    this.trainEl.dataset.state = state;
    if (!point || state === 'idle') {
      this.trainEl.classList.add('is-hidden');
      return;
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.angleDeg)) {
      this.trainEl.classList.add('is-hidden');
      return;
    }
    this.trainEl.classList.remove('is-hidden');
    this.trainEl.style.transform =
      `translate(${round(point.x)}px, ${round(point.y)}px) rotate(${round(point.angleDeg)}deg)`;
  }

  setCard(stationId: string | null): void {
    this.scheduleRelayout();
    if (!stationId) {
      this.cardStationId = null;
      this.cardEl.classList.remove('is-open');
      this.cardEl.setAttribute('aria-hidden', 'true');
      this.root.classList.remove('is-card-open');
      return;
    }
    const station = this.stationById.get(stationId);
    if (!station) {
      this.setCard(null);
      return;
    }
    this.fillCard(station);
    this.cardStationId = stationId;
    this.cardEl.classList.add('is-open');
    this.cardEl.setAttribute('aria-hidden', 'false');
    this.root.classList.add('is-card-open');
  }

  private fillCard(station: MetroStation): void {
    const song = station.song;
    const lines = this.map ? stationLines(this.map, station) : [];
    const primary = lines[0];
    applyTone(this.cardEl, primary?.tone ?? 'ghost');
    this.cardEl.setAttribute('aria-label', `${song.title} · ${song.artist} 卡片`);

    this.cardCover.replaceChildren();
    this.cardCover.classList.remove('is-art');
    if (song.coverUrl) {
      const img = document.createElement('img');
      img.className = 'mt-card-cover-img';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = song.coverUrl;
      img.addEventListener('error', () => this.renderCardCoverFallback(song.title), { once: true });
      this.cardCover.append(img);
    } else {
      this.renderCardCoverFallback(song.title);
    }

    this.cardTitle.textContent = song.title;
    this.cardArtist.textContent = song.artist;
    this.cardAlbum.textContent = song.album ?? '';
    this.cardSource.textContent = sourceLabel(song.source);
    this.cardDuration.textContent = formatDuration(song.durationMs);

    const transferNames = lines.slice(1).map((line) => line.name);
    this.cardTransfer.textContent = transferNames.length > 0
      ? `换乘 · ${transferNames.join(' / ')}`
      : '';
    this.cardEl.dataset.station = station.id;
  }

  private renderCardCoverFallback(title: string): void {
    this.cardCover.replaceChildren();
    this.cardCover.classList.add('is-art');
    const art = htmlEl('span', 'mt-card-cover-art');
    art.textContent = firstGlyph(title);
    this.cardCover.append(art);
  }

  setCrumb(title: string, kicker?: string): void {
    if (kicker !== undefined) this.crumbKicker.textContent = kicker;
    this.crumbTitle.textContent = title;
  }

  setLod(level: MetroLodLevel): void {
    this.lod = level;
    this.root.dataset.lod = level;
    // LOD 直接改变标签可见性与站点半径 → 重新排布
    this.scheduleRelayout();
  }

  setScaleLabel(scale: number): void {
    const percent = Number.isFinite(scale) ? Math.round(scale * 100) : 100;
    this.zoomValue.textContent = `${percent}%`;
  }

  setLabelScale(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0.001) return;
    if (this.labelScale > 0.001 && Math.abs(scale / this.labelScale - 1) <= 0.02) return;
    this.labelScale = scale;
    this.scheduleRelayout();
  }

  setTheme(mode: MetroThemeMode): void {
    this.themeMode = mode;
    applyMetroTheme(this.root, resolveMetroTheme(mode));
  }

  lineMetric(lineId: string): MetroLineMetric | null {
    return this.metrics.get(lineId) ?? null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimers();
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.labelRafId) {
      window.cancelAnimationFrame(this.labelRafId);
      this.labelRafId = 0;
    }
    if (this.labelTimer) {
      window.clearTimeout(this.labelTimer);
      this.labelTimer = 0;
    }
    this.cameraObserver?.disconnect();
    this.cameraObserver = null;
    this.labelMetrics.clear();
    this.stationLabelEls.clear();
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* 忽略清理异常 */
      }
    }
    this.root.remove();
  }

  /* ---------------- 标签防碰撞布局 ---------------- */

  /** 触发一次防碰撞重排（同一 rAF 内去抖；delay>0 时等相机动画停了再排）。 */
  private scheduleRelayout(delay = 0): void {
    if (this.destroyed) return;
    if (delay > 0) {
      if (this.labelTimer) window.clearTimeout(this.labelTimer);
      this.labelTimer = window.setTimeout(() => {
        this.labelTimer = 0;
        this.scheduleRelayout();
      }, delay);
      return;
    }
    if (this.labelRafId) return;
    this.labelRafId = window.requestAnimationFrame(() => {
      this.labelRafId = 0;
      if (!this.destroyed) this.relayoutLabels();
    });
  }

  /** 当前屏幕缩放：优先用 stage 传入的 scale，其次用相机 CTM 兜底。 */
  private labelScaleValue(): number {
    if (this.labelScale > 0.001) return this.labelScale;
    const scale = this.cameraGroup.getCTM()?.a;
    return scale && Number.isFinite(scale) && scale > 0.001 ? scale : 1;
  }

  /** 按可见性 + 优先级贪心摆放站名，保证标签之间、标签与站点圆点之间不重叠。 */
  private relayoutLabels(): void {
    const map = this.map;
    if (!map) return;
    const root = this.root;
    // 关掉标签 opacity 过渡，才能读到「自然的」可见性
    root.classList.add('is-measuring');
    for (const label of this.stationLabelEls.values()) label.classList.remove('is-label-hidden');
    const lineLabels = Array.from(this.linesGroup.querySelectorAll<SVGTextElement>('.mt-line-label'));
    for (const label of lineLabels) label.classList.remove('is-label-hidden');
    void root.getBoundingClientRect();
    const scale = this.labelScaleValue();
    try {
      const placed: LabelBox[] = [];
      const dots = this.stationDotBoxes(map, scale);
      for (const label of lineLabels) {
        if (effectiveOpacity(label, root) <= LABEL_VISIBLE_EPS) continue;
        // relayout 可重复执行：线名先回到基准位置，再按需沿端点外侧微调
        const baseX = Number(label.dataset.baseX ?? label.getAttribute('x') ?? '0');
        const baseY = Number(label.dataset.baseY ?? label.getAttribute('y') ?? '0');
        label.setAttribute('x', String(baseX));
        label.setAttribute('y', String(baseY));
        const box = this.lineLabelBox(label, scale);
        if (!box) continue;
        let placedBox = expandLabelBox(box, LABEL_BOX_PAD);
        const nudgeX = Number(label.dataset.nudgeX ?? '0');
        const nudgeY = Number(label.dataset.nudgeY ?? '0');
        if ((nudgeX !== 0 || nudgeY !== 0) && labelCollisionCost(placedBox, placed, dots) > 0) {
          for (let step = 1; step <= 6; step += 1) {
            const deltaX = nudgeX * step * 5;
            const deltaY = nudgeY * step * 5;
            const shifted: LabelBox = {
              x: placedBox.x + deltaX,
              y: placedBox.y + deltaY,
              width: placedBox.width,
              height: placedBox.height,
            };
            if (labelCollisionCost(shifted, placed, dots) === 0) {
              label.setAttribute('x', String(round(baseX + deltaX / scale)));
              label.setAttribute('y', String(round(baseY + deltaY / scale)));
              placedBox = shifted;
              break;
            }
          }
        }
        placed.push(placedBox);
      }
      this.placeStationLabels(map, scale, placed, dots);
    } finally {
      root.classList.remove('is-measuring');
    }
  }

  /** 站名文本的 world 尺寸（缓存；getBBox 对 display:none 无效，所以先临时归零锚点）。 */
  private stationLabelMetrics(id: string, label: SVGTextElement): LabelMetrics {
    const cached = this.labelMetrics.get(id);
    if (cached) return cached;
    const anchor = label.getAttribute('text-anchor') ?? 'start';
    const x = label.getAttribute('x') ?? '0';
    const y = label.getAttribute('y') ?? '0';
    label.setAttribute('text-anchor', 'start');
    label.setAttribute('x', '0');
    label.setAttribute('y', '0');
    let width = 0;
    let height = 0;
    try {
      const rect = label.getBBox();
      width = rect.width;
      height = rect.height;
    } catch {
      width = 0;
      height = 0;
    }
    label.setAttribute('text-anchor', anchor);
    label.setAttribute('x', x);
    label.setAttribute('y', y);
    const fallback = METRO_METRICS.labelSize;
    const metrics: LabelMetrics =
      width > 0 && height > 0
        ? { width, height, ascent: height * 0.78 }
        : { width: 40, height: fallback, ascent: fallback * 0.78 };
    this.labelMetrics.set(id, metrics);
    return metrics;
  }

  /** 线名框（屏幕 px），线名在世界坐标系里没有额外变换。 */
  private lineLabelBox(label: SVGTextElement, scale: number): LabelBox | null {
    try {
      const rect = label.getBBox();
      if (!Number.isFinite(rect.width) || rect.width <= 0 || rect.height <= 0) return null;
      return {
        x: rect.x * scale,
        y: rect.y * scale,
        width: rect.width * scale,
        height: rect.height * scale,
      };
    } catch {
      return null;
    }
  }

  /** LOD 对站点圆点的缩放系数。 */
  private dotLodScale(): number {
    return this.lod === 'far' ? 0.66 : this.lod === 'close' ? 1.3 : 1;
  }

  /** hover 时圆点会被放大到 stationHoverScale，占位框要跟着变。 */
  private stationRingScale(stationId: string): number {
    const hovered = this.stationEls.get(stationId)?.classList.contains('is-hover');
    return hovered ? METRO_METRICS.stationHoverScale : 1;
  }

  /** 所有站点圆点的占位框（屏幕 px，含 LOD 缩放后的半径）。 */
  private stationDotBoxes(map: MetroMap, scale: number): LabelBox[] {
    const lodScale = this.dotLodScale();
    const boxes: LabelBox[] = [];
    for (const station of Object.values(map.stations)) {
      const size =
        stationRadii(station).ring * lodScale * this.stationRingScale(station.id) * scale + LABEL_DOT_PAD;
      boxes.push({
        x: station.x * scale - size,
        y: station.y * scale - size,
        width: size * 2,
        height: size * 2,
      });
    }
    return boxes;
  }

  private placeStationLabels(map: MetroMap, scale: number, placed: LabelBox[], dots: LabelBox[]): void {
    const ordered = orderedStations(map);
    // 稳定排序：优先级高的先占位（同优先级保持线路顺序，保证确定性）
    ordered.sort((a, b) => stationLabelPriority(a) - stationLabelPriority(b));
    for (const station of ordered) {
      const label = this.stationLabelEls.get(station.id);
      if (!label) continue;
      if (effectiveOpacity(label, this.root) <= LABEL_VISIBLE_EPS) {
        label.classList.add('is-label-hidden');
        continue;
      }
      const metrics = this.stationLabelMetrics(station.id, label);
      const width = Math.max(metrics.width * scale, 4);
      const height = Math.max(metrics.height * scale, 4);
      const ascentPx = metrics.ascent * scale;
      // hover 时圆点会被放大，候选距离要按放大后的圆点算，否则标签会被长大后的圆点压住
      const ringPx = stationRadii(station).ring * this.stationRingScale(station.id) * scale;
      const direction = stationDirection(map, station);
      // 硬上限：站名离自己站点太远就失去关联感，宁可隐藏也不甩出去。
      // 基准是 65% 缩放下的屏幕 px（普通 24 / 换乘与端点 32），随缩放同步放宽但收紧上限。
      const important = station.type === 'transfer' || station.type === 'terminus';
      const zoomFactor = Math.min(1.2, Math.max(0.85, scale / 0.65));
      const maxDistance = (important ? 32 : 24) * zoomFactor;
      const candidates = labelCandidates({
        dirX: direction.x,
        dirY: direction.y,
        parity: direction.index,
        ringPx,
        labelW: width,
        labelH: height,
        maxDistance,
      });
      // 换乘/端点不允许隐藏：距离上限过滤后一个不剩时，退回不限距离的最近候选
      const fallbackCandidates =
        important && candidates.length === 0
          ? labelCandidates({
              dirX: direction.x,
              dirY: direction.y,
              parity: direction.index,
              ringPx,
              labelW: width,
              labelH: height,
              maxDistance: Number.POSITIVE_INFINITY,
            })
          : candidates;
      const candidateList = candidates.length > 0 ? candidates : fallbackCandidates;
      const boxFor = (candidate: LabelCandidate): LabelBox =>
        expandLabelBox(
          {
            x: station.x * scale + candidate.cx - width / 2,
            y: station.y * scale + candidate.cy - height / 2,
            width,
            height,
          },
          LABEL_BOX_PAD,
        );
      // 站名贴着自己的圆点是地铁图的常态：其它站点圆点带 3px 缓冲算障碍，
      // 自己的圆点整块豁免（候选位置本身已保证不压住圆点），只和别的站点抢空间。
      const ownHalf =
        stationRadii(station).ring * this.dotLodScale() * this.stationRingScale(station.id) * scale +
        LABEL_DOT_PAD;
      const ownDot: LabelBox = {
        x: station.x * scale - ownHalf,
        y: station.y * scale - ownHalf,
        width: ownHalf * 2,
        height: ownHalf * 2,
      };

      let chosen: LabelCandidate | null = null;
      let chosenBox: LabelBox | null = null;
      let best: LabelCandidate | null = null;
      let bestBox: LabelBox | null = null;
      let bestCost = Number.POSITIVE_INFINITY;
      for (const candidate of candidateList) {
        const box = boxFor(candidate);
        // 减去自己的圆点那部分代价：贴着自己站点不算碰撞
        const cost = labelCollisionCost(box, placed, dots) - boxOverlapArea(box, ownDot) * 2;
        if (cost <= 0.5) {
          chosen = candidate;
          chosenBox = box;
          break;
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = candidate;
          bestBox = box;
        }
      }
      if (!chosen) {
        // 普通站全候选都撞 → 隐藏；换乘/端点不许隐藏，退化为重叠最小的候选
        if (!important || candidateList.length === 0 || !best) {
          label.classList.add('is-label-hidden');
          continue;
        }
        chosen = best;
        chosenBox = bestBox ?? boxFor(best);
      }
      if (chosenBox) placed.push(chosenBox);
      this.applyLabelCandidate(label, chosen, scale, width, height, ascentPx);
    }
  }

  /** 把候选位置写回 SVG（候选中心以屏幕 px 表示，这里换回世界坐标）。 */
  private applyLabelCandidate(
    label: SVGTextElement,
    candidate: LabelCandidate,
    scale: number,
    width: number,
    height: number,
    ascentPx: number,
  ): void {
    const shift = candidate.anchor === 'start' ? -width / 2 : candidate.anchor === 'end' ? width / 2 : 0;
    label.setAttribute('text-anchor', candidate.anchor);
    label.setAttribute('x', String(round((candidate.cx + shift) / scale)));
    label.setAttribute('y', String(round((candidate.cy - height / 2 + ascentPx) / scale)));
    label.classList.remove('is-label-hidden');
  }

  /* ---------------- 内部小工具 ---------------- */

  private schedule(fn: () => void, delay: number): void {
    this.timers.push(window.setTimeout(fn, delay));
  }

  private clearTimers(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers = [];
  }
}

/* ------------------------------------------------------------------ */
/* 工厂 + 纯函数导出                                                   */
/* ------------------------------------------------------------------ */

export function createMetroRenderer(host: HTMLElement, options?: MetroRendererOptions): MetroRenderer {
  return new MetroRendererImpl(host, options);
}

/** 供 stage 构造卡片/统计时复用的小工具：站点所属线路列表（按 station.lineIds 顺序）。 */
export function stationLines(map: MetroMap, station: MetroStation): MetroLine[] {
  const lines: MetroLine[] = [];
  for (const lineId of station.lineIds) {
    const line = map.lines.find((item) => item.id === lineId);
    if (line && !lines.includes(line)) lines.push(line);
  }
  return lines;
}

/** 供 stage 调试统计用：data 转 map 后的站数/换乘数等。 */
export function summarizeData(data: MetroData): { lines: number; stations: number; transfers: number } {
  const stations = Object.values(data.stations);
  return {
    lines: data.lines.length,
    stations: stations.length,
    transfers: stations.filter((station) => station.lineIds.length >= 2).length,
  };
}
