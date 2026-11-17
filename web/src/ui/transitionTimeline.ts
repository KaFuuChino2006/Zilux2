/**
 * 过渡时间线（设置页「进阶过渡预览」的数据源）。
 *
 * 纯函数：`ScheduledEvent[] + barMs + totalMs` → 四条泳道上的方块。
 * 不碰 DOM、不碰音频，所以可以拿 JSON 快照直接测。
 *
 * 坐标约定：
 * - `x` / `width` 都是 **0–1 的归一化比例**，由调用方乘容器宽度；
 * - `bar` 是从 0 开始的小节序号（四条泳道共用同一把小节尺）。
 */

import type { ScheduledEvent } from '../core/stemSwap';
import type { Stem } from '../core/transitionPlan';

export const TIMELINE_STEMS: readonly Stem[] = ['drums', 'bass', 'other', 'vocals'];

export const STEM_LABELS: Record<Stem, string> = {
  drums: '鼓',
  bass: '低音',
  other: '旋律',
  vocals: '人声',
};

export interface TimelineBlock {
  /** 事件种类，UI 据此上色：换手 = 实心，回声 = 斜纹，压低 = 顶部窄条。 */
  kind: 'swap' | 'echo' | 'duck';
  deck: 'A' | 'B';
  stem: Stem;
  /** 归一化左边界与宽度（0–1）。 */
  x: number;
  width: number;
  /** 起点落在第几小节（0 起），供 UI 画小节刻度时对齐。 */
  bar: number;
  /** 用于 tooltip 的原始毫秒值。 */
  atMs: number;
  durationMs: number;
  /** 换手方向的可读标签，例如「鼓 → B」「回声」「压低 −3 dB」。 */
  label: string;
}

export interface TimelineLane {
  stem: Stem;
  label: string;
  blocks: TimelineBlock[];
}

export interface TimelineModel {
  /** 小节数（含小数则向上取整），UI 用它画刻度。 */
  bars: number;
  barMs: number;
  totalMs: number;
  lanes: TimelineLane[];
  /** 不属于任何分轨的顶部窄条（duck / 全局回声）。 */
  overhead: TimelineBlock[];
  /** 数据异常（空事件、barMs≤0）时给出原因，UI 显示占位而不是画错。 */
  emptyReason?: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** 从事件里恢复它属于哪条分轨：curve/delay 带 stem，duck 没有 stem 就按目标 deck 归到 overhead。 */
function stemOf(event: ScheduledEvent): Stem | null {
  // 只有 curve（gainCurve）带 stem；delaySend 是整条链路的发送量，duck 是总线压低，
  // 两者都画在顶部 overhead 上，不占某条分轨泳道。
  return event.kind === 'gainCurve' ? event.stem : null;
}

function labelOf(event: ScheduledEvent, stem: Stem | null): string {
  if (event.kind === 'duck') return `压低 ${event.db} dB`;
  if (event.kind === 'delaySend') return `${stem ? STEM_LABELS[stem] : '回声'}回声 → ${event.deck}`;
  return `${stem ? STEM_LABELS[stem] : '换手'} → ${event.deck}`;
}

/**
 * 主入口。`events` 里同一分轨的 A/B 两条曲线会被合并成一条「换手块」
 * （UI 上一格表示一次交接，而不是两条重叠的方块）。
 */
export function buildTimeline(
  events: readonly ScheduledEvent[],
  barMs: number,
  totalMs: number,
): TimelineModel {
  const safeBarMs = Number.isFinite(barMs) && barMs > 0 ? barMs : 0;
  const safeTotal = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : safeBarMs;
  const lanes: TimelineLane[] = TIMELINE_STEMS.map((stem) => ({
    stem,
    label: STEM_LABELS[stem],
    blocks: [],
  }));
  const overhead: TimelineBlock[] = [];
  const model: TimelineModel = {
    bars: safeBarMs > 0 ? Math.ceil(safeTotal / safeBarMs) : 0,
    barMs: safeBarMs,
    totalMs: safeTotal,
    lanes,
    overhead,
  };

  if (events.length === 0) {
    model.emptyReason = '这次过渡没有分轨动作';
    return model;
  }
  if (safeTotal <= 0) {
    model.emptyReason = '缺少小节长度，无法定位动作';
    return model;
  }

  // 先把 A/B 同窗口的曲线配对，避免同一格画两层。
  const seen = new Set<string>();
  for (const event of events) {
    const stem = stemOf(event);
    const startMs = Number.isFinite(event.atMs) ? event.atMs : 0;
    const durationMs = Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0;
    const x = clamp01(startMs / safeTotal);
    const width = clamp01((startMs + durationMs) / safeTotal) - x;
    const bar = safeBarMs > 0 ? Math.floor(startMs / safeBarMs) : 0;
    const block: TimelineBlock = {
      kind: event.kind === 'duck' ? 'duck' : event.kind === 'delaySend' ? 'echo' : 'swap',
      deck: event.deck,
      stem: stem ?? 'vocals',
      x,
      width: Math.max(width, 0),
      bar,
      atMs: startMs,
      durationMs,
      label: labelOf(event, stem),
    };

    if (!stem) {
      overhead.push(block);
      continue;
    }
    const lane = lanes.find((item) => item.stem === stem);
    if (!lane) continue;
    // A 与 B 的同一段换手只保留一条（先到者为准），宽度取两者较宽的那条。
    const pairKey = `${stem}|${block.kind}|${Math.round(startMs)}`;
    const existing = lane.blocks.find((item) => `${item.stem}|${item.kind}|${Math.round(item.atMs)}` === pairKey);
    if (existing) {
      existing.width = Math.max(existing.width, block.width);
      if (seen.has(`${pairKey}|${event.deck}`)) existing.label = `${existing.label} / ${block.label}`;
      seen.add(`${pairKey}|${event.deck}`);
      continue;
    }
    seen.add(`${pairKey}|${event.deck}`);
    lane.blocks.push(block);
  }

  for (const lane of lanes) lane.blocks.sort((left, right) => left.x - right.x);
  overhead.sort((left, right) => left.x - right.x);
  return model;
}
