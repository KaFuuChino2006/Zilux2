/**
 * Performer 的纯数据层：把 `TransitionPlan` 展开成「可在某个时间点执行的音频指令」。
 *
 * 这一层不碰 WebAudio，只产出数据；`web/src/audio/stemGraph.ts` 负责执行。
 * 这样换手曲线可以离线断言（端点、单调性、中点值），也方便以后换成 OfflineAudioContext
 * 做渲染测试。
 *
 * 两条硬规则：
 * 1. 所有时间都是「相对过渡起点」的毫秒数，由调用方加上 `ctx.currentTime` 绝对值。
 * 2. 曲线用采样数组（`setValueCurveAtTime` 的入参），不用一串 ramp，
 *    这样曲线形状与离线断言完全一致。
 */

import type { Stem, SwapAction, TransitionPlan } from './transitionPlan';
import { actionWindows, gainAt } from './transitionPlan';
import { ECHO } from './djMoves';

export type DeckId = 'A' | 'B';

/** 四轨固定顺序（补全覆盖时用）。 */
const STEM_ORDER: Stem[] = ['drums', 'bass', 'other', 'vocals'];

/** 采样点数：默认 32，足够平滑且开销可忽略。 */
export const CURVE_STEPS = 32;

export interface CurveEvent {
  kind: 'gainCurve';
  deck: DeckId;
  stem: Stem;
  /** 相对过渡起点（ms）。 */
  atMs: number;
  durationMs: number;
  /** 长度 = CURVE_STEPS + 1，从 A 端增益渐变到 B 端。 */
  curve: number[];
}

export interface DelayEvent {
  kind: 'delaySend';
  deck: DeckId;
  atMs: number;
  durationMs: number;
  from: number;
  to: number;
}

export interface DuckEvent {
  kind: 'duck';
  deck: DeckId;
  /** 指定只躲这条分轨；缺省表示整条 deck 一起躲。 */
  stem?: Stem;
  atMs: number;
  durationMs: number;
  /** dB，负值表示压低。 */
  db: number;
  attackMs: number;
}

export interface FilterEvent {
  kind: 'filter';
  deck: DeckId;
  atMs: number;
  durationMs: number;
  /** 扫哪个滤波器：`highpass` = 进场开门（闷→亮），`lowpass` = 出场关门（亮→闷）。 */
  band?: 'highpass' | 'lowpass';
  /** 起点 / 终点（Hz）。 */
  fromHz: number;
  toHz: number;
}

export type ScheduledEvent = CurveEvent | DelayEvent | DuckEvent | FilterEvent;

export interface ScheduleOptions {
  /** 采样点数，默认 `CURVE_STEPS`。 */
  steps?: number;
  /** 目标 deck（B 一般是待进场那首）。 */
  targetDeck?: DeckId;
}

/** 进场 deck 的增益曲线（长度 steps+1，0 → 1）。 */
export function buildSwapCurve(action: Pick<SwapAction, 'curve'>, steps = CURVE_STEPS): number[] {
  const n = Math.max(1, Math.floor(steps));
  const out = new Array<number>(n + 1);
  for (let i = 0; i <= n; i++) out[i] = gainAt(action, i / n).b;
  return out;
}

/**
 * 出场 deck 的增益曲线。
 *
 * **必须是 `gainAt().a`，不能是 `1 - b`**：等功率曲线的补是 `cos`，不是 `1 - sin`。
 * 用 `1 - b` 会让中点总增益变成 `0.5 + 0.707 = 1.207`（+1.6 dB），
 * 既破坏等功率，也让 50% 交点偏到 1/3 处（离线验收 C1 就是这么抓出来的）。
 */
export function buildSourceCurve(action: Pick<SwapAction, 'curve'>, steps = CURVE_STEPS): number[] {
  const n = Math.max(1, Math.floor(steps));
  const out = new Array<number>(n + 1);
  for (let i = 0; i <= n; i++) out[i] = gainAt(action, i / n).a;
  return out;
}

/** 校验曲线：长度、端点、单调性（linear/shelfDip 必单调，equalPower 也单调）。 */
export function validateCurve(curve: number[]): { ok: boolean; reason?: string } {
  if (curve.length < 2) return { ok: false, reason: '曲线至少两个点' };
  if (Math.abs(curve[0]) > 1e-9) return { ok: false, reason: '起点必须是 0' };
  if (Math.abs(curve[curve.length - 1] - 1) > 1e-9) return { ok: false, reason: '终点必须是 1' };
  for (let i = 1; i < curve.length; i++) {
    if (curve[i] < curve[i - 1] - 1e-9) return { ok: false, reason: `第 ${i} 点回退` };
  }
  return { ok: true };
}

/**
 * 主入口：`TransitionPlan` → 事件列表。
 *
 * 对每条 `SwapAction`：
 * - 进场 deck（默认 B）在该窗口播放增益曲线 0→1；
 * - 出场 deck（A）用同一条曲线的补（1−b）反向执行；
 * - 若动作是 `delaySend` 语义（由 `djMoves` 的 `vocalEchoThrow` 产生），额外发射一条
 *   `delaySend` 与一条对向 deck 的 `duck`（−3 dB / 5 ms attack）。
 */
export function schedulePlan(plan: TransitionPlan, options: ScheduleOptions = {}): ScheduledEvent[] {
  const steps = options.steps ?? CURVE_STEPS;
  const target: DeckId = options.targetDeck ?? 'B';
  const source: DeckId = target === 'B' ? 'A' : 'B';
  const events: ScheduledEvent[] = [];
  const covered = new Set<Stem>();

  // 起播状态由音频图负责（`StemGraph.resetDeckGains`：出场 deck 1.0、进场 deck 0.0），
  // 这里不再发 1 ms 的初始化事件——那会污染时间线与快照，也混淆「换手动作」的语义。

  /**
   * 人声**顺序交接**：先让出场 deck 的人声落到 0，留一个小空隙，再让进场 deck 起来。
   * 两把人声同时在场会互相调制（颤音打架），听感是「人声被压住 / 像变调」——
   * DJUCED 那套打垫本来就是 kill/restore，从没有两把人声同框。
   */
  const pushVocalCut = (startMs: number, endMs: number): void => {
    const dur = Math.max(40, endMs - startMs);
    const cutMs = Math.max(20, dur * 0.45);
    const gapMs = Math.max(10, Math.min(40, dur * 0.08));
    const riseStart = Math.min(startMs + dur, startMs + cutMs + gapMs);
    const riseMs = Math.max(20, startMs + dur - riseStart);
    events.push({
      kind: 'gainCurve', deck: source, stem: 'vocals',
      atMs: startMs, durationMs: cutMs, curve: buildSourceCurve({ curve: 'linear' }, steps),
    });
    // 侧链躲避跟着「出场人声下压」一起排，避免事件表乱序。
    events.push({
      kind: 'duck', deck: target, stem: 'vocals', atMs: startMs,
      durationMs: Math.max(1, endMs - startMs),
      db: ECHO.duckDb, attackMs: ECHO.duckAttackMs,
    });
    events.push({
      kind: 'gainCurve', deck: target, stem: 'vocals',
      atMs: riseStart, durationMs: riseMs, curve: buildSwapCurve({ curve: 'linear' }, steps),
    });
  };

  for (const w of actionWindows(plan)) {
    covered.add(w.stem);
    if (w.stem === 'vocals') {
      pushVocalCut(w.startMs, w.endMs);
      continue;
    }
    const curve = buildSwapCurve(w, steps);
    const srcCurve = buildSourceCurve(w, steps);
    events.push({
      kind: 'gainCurve', deck: target, stem: w.stem,
      atMs: w.startMs, durationMs: Math.max(1, w.endMs - w.startMs), curve,
    });
    events.push({
      kind: 'gainCurve', deck: source, stem: w.stem,
      atMs: w.startMs, durationMs: Math.max(1, w.endMs - w.startMs),
      curve: srcCurve,
    });
  }

  /**
   * 降级模板（bassOnly / bassDrumsOnly）只点名前两轨，剩下的 `other`/`vocals`
   * 如果没人管，就会一直挂在 A 上——B 的人声永远进不来，听感是「和声在打架」。
   * 所以给未覆盖的分轨补一条整段线性交叉，保证过渡结束时 A 全关、B 全开。
   */
  const windows = actionWindows(plan);
  if (windows.length > 0) {
    const spanStart = Math.min(...windows.map((w) => w.startMs));
    const spanEnd = Math.max(...windows.map((w) => w.endMs));
    const spanMs = Math.max(1, spanEnd - spanStart);
    const linear: Pick<SwapAction, 'curve'> = { curve: 'linear' };
    for (const stem of STEM_ORDER) {
      if (covered.has(stem)) continue;
      // 人声不能跟着整段慢慢换：两把人声叠在一起会打架，压到最后一拍内顺序交接。
      const isVocal = stem === 'vocals';
      const winMs = isVocal ? Math.min(spanMs, plan.beatMs) : spanMs;
      const startAt = isVocal ? Math.max(spanStart, spanEnd - winMs) : spanStart;
      if (isVocal) {
        pushVocalCut(startAt, startAt + winMs);
        continue;
      }
      events.push({
        kind: 'gainCurve', deck: target, stem,
        atMs: startAt, durationMs: winMs, curve: buildSwapCurve(linear, steps),
      });
      events.push({
        kind: 'gainCurve', deck: source, stem,
        atMs: startAt, durationMs: winMs, curve: buildSourceCurve(linear, steps),
      });
    }
  }

  // 回声甩尾：`vocalFirst` 会把 cue 挂在 plan 上（`djMoves.vocalEchoThrow` 的手法）。
  // 这里是它唯一的运行时出口——没有这一步，手法库里的 delaySend 永远到不了音频图。
  if (plan.filter) {
    events.push({
      kind: 'filter',
      deck: target,
      band: 'highpass',
      atMs: Math.max(0, plan.filter.startMs),
      durationMs: Math.max(1, plan.filter.lengthBeats * plan.beatMs),
      fromHz: plan.filter.fromHz,
      toHz: plan.filter.toHz,
    });
  }
  if (plan.filterOut) {
    events.push({
      kind: 'filter',
      deck: source,
      band: 'lowpass',
      atMs: Math.max(0, plan.filterOut.startMs),
      durationMs: Math.max(1, plan.filterOut.lengthBeats * plan.beatMs),
      fromHz: plan.filterOut.fromHz,
      toHz: plan.filterOut.toHz,
    });
  }

  if (plan.echo) {
    for (const event of scheduleEchoThrow(plan.echo.startMs, plan.barMs, plan.echo.lengthBeats, plan.beatMs)) {
      events.push(event);
    }
  }

  return events.sort((x, y) => x.atMs - y.atMs || x.kind.localeCompare(y.kind));
}

/** 回声甩尾事件：把 A 的人声送进 delay 总线，然后在下一小节线切断干声。 */
export function scheduleEchoThrow(startMs: number, barMs: number, lengthBeats: number, beatMs: number): ScheduledEvent[] {
  // 输入全部先净化：分析结果缺字段 / BPM 为 0 / barMs 算不出来时，绝不能把 NaN 写进
  // AudioParam 排程——`start(NaN)` 在部分浏览器上是「立即播放」，听感就是莫名一声爆音。
  const safeStart = Number.isFinite(startMs) && startMs > 0 ? startMs : 0;
  const safeBeat = Number.isFinite(beatMs) && beatMs > 0 ? beatMs : 500;
  const safeBar = Number.isFinite(barMs) && barMs > 0 ? barMs : safeBeat * 4;
  const safeLen = Number.isFinite(lengthBeats) && lengthBeats > 0 ? lengthBeats : 2;
  const sendMs = Math.max(1, safeLen * safeBeat);
  return [
    { kind: 'delaySend', deck: 'A', atMs: safeStart, durationMs: sendMs, from: 0, to: 0.6 },
    { kind: 'delaySend', deck: 'A', atMs: safeStart + safeBar, durationMs: sendMs * 2, from: 0.6, to: 0 },
    {
      // 只躲 B 的人声：A 的回声尾巴要空间，但 B 的低频/鼓不该跟着一起塌。
      kind: 'duck', deck: 'B', stem: 'vocals', atMs: safeStart + safeBar,
      durationMs: safeBar, db: ECHO.duckDb, attackMs: ECHO.duckAttackMs,
    },
  ];
}

/** 兜底：任意事件列表里最晚结束的时间（用于判断过渡何时可以拆图）。 */
export function eventsEndMs(events: ScheduledEvent[]): number {
  let end = 0;
  for (const e of events) {
    const v = e.atMs + e.durationMs;
    if (Number.isFinite(v)) end = Math.max(end, v);
  }
  return end;
}
