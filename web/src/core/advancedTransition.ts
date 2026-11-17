/**
 * 进阶过渡的接线层（唯一入口）。
 *
 * 目的：把「要不要走进阶」这件事从播放链路里隔离出来，`crossfadeDeck` 以后只需要：
 *
 *   const resolved = resolveTransition({ ... , mode });
 *   if (resolved.plan) { 构建 StemGraph 并按 resolved.events 调度 }
 *   else { 走原来的 naturalGains }
 *
 * 这里不 import 任何音频代码，纯粹做决策 + 生成给 UI 用的可读时间线。
 */

import type { TransitionTuning } from './transitionTuning';

import type { BeatAnalysis } from '../online/analysis';
import type { Stem, Template, TransitionMode } from './transitionPlan';
import { planForMode } from './transitionPlan';
import { actionWindows } from './transitionPlan';
import { schedulePlan, eventsEndMs, type ScheduledEvent } from './stemSwap';
import { decideTempoGate, type GateDecision } from './tempoGate';

export interface ResolveInput {
  mode: TransitionMode;
  analysisA: BeatAnalysis;
  analysisB: BeatAnalysis;
  positionMsA: number;
  hint?: Template;
  /** 分轨低频互相关（−1..1）。给了就按 ρ 选 linear / equalPower；不给沿用模板默认。 */
  correlation?: Partial<Record<Stem, number>>;
  /** 面板调参（内部测试版）；缺省 = 默认值。 */
  tuning?: TransitionTuning;
}

export interface ResolvedTransition {
  mode: TransitionMode;
  /** `null` 表示走标准过渡（等功率交叉），调用方不得构建 StemGraph。 */
  plan: ReturnType<typeof planForMode>;
  events: ScheduledEvent[];
  /** 过渡总时长（ms），含回声尾巴。 */
  totalMs: number;
  /** 参与换手的轨。 */
  stems: Stem[];
  /** 给 UI / 日志用的中文说明。 */
  summary: string[];
  /** 速度门控的判定明细（标准模式也可能是降级后的结果）。 */
  gate?: GateDecision;
}

const STEM_LABELS: Record<Stem, string> = {
  bass: '低频', drums: '鼓', other: '乐器', vocals: '人声',
};

export function resolveTransition(input: ResolveInput): ResolvedTransition {
  if (input.mode !== 'advanced') {
    return {
      mode: 'standard',
      plan: null,
      events: [],
      totalMs: 0,
      stems: [],
      summary: ['标准过渡：整轨等功率交叉（naturalGains），不构建分轨图'],
    };
  }

  // 速度门控：先把「这两首歌到底对不对得上」判死，再决定换手深度（T6）。
  // 面板「强制进阶」= 用户明确要求去掉门控：这里连 standard 早退都不做。
  const forcedEarly = input.tuning?.forceAdvanced === true;
  const gate = decideTempoGate(input.analysisA, input.analysisB);
  if (!forcedEarly && gate.tier === 'standard') {
    return {
      mode: 'standard',
      plan: null,
      events: [],
      totalMs: 0,
      stems: [],
      summary: ['速度门控判定：回退标准等功率过渡', ...gate.reasons],
      gate,
    };
  }

  // 辅助档只换低频与鼓，人声与乐器不参与，避免对不齐时出现二重唱。
  // forceAdvanced（面板开关）= 用户明确要求「无论如何按进阶走」，跳过降级。
  const forced = input.tuning?.forceAdvanced === true;
  const effectiveGate = forced && gate.tier !== 'full'
    ? { ...gate, tier: 'full' as const, reasons: [...gate.reasons, '面板已强制进阶：忽略置信度降级'] }
    : gate;
  const hint: Template | undefined = input.hint ?? (effectiveGate.tier === 'bassDrumsOnly' ? 'bassOnly' : undefined);
  const plan = planForMode('advanced', {
    analysisA: input.analysisA,
    analysisB: input.analysisB,
    positionMsA: input.positionMsA,
    ...(input.correlation ? { correlation: input.correlation } : {}),
    ...(input.tuning ? { tuning: input.tuning } : {}),
  }, hint);

  if (!plan) {
    return {
      mode: 'standard',
      plan: null,
      events: [],
      totalMs: 0,
      stems: [],
      summary: ['进阶方案不可用（缺下拍/数据不足），回落标准等功率交叉', ...gate.reasons],
      gate,
    };
  }

  const events = schedulePlan(plan);
  const stems = Array.from(new Set(plan.actions.map((a) => a.stem)));
  return {
    mode: 'advanced',
    plan,
    events,
    totalMs: eventsEndMs(events),
    stems,
    summary: [...describePlan(plan), `速度门控：${gate.tier}｜${gate.reasons.join('；')}`],
    gate,
  };
}

/** 把方案翻成人话，UI 直接显示；也用于验收时肉眼核对「动作是否和文案一致」。 */
export function describePlan(plan: NonNullable<ResolvedTransition['plan']>): string[] {
  const lines: string[] = [];
  lines.push(`模板 ${plan.template}｜${plan.totalBars} 小节｜速率 ${plan.rate.toFixed(4)}×｜兜底 ${plan.fallback}`);
  lines.push(`兼容性 ${plan.compat.score.toFixed(2)}：${plan.compat.reason}`);
  for (const w of actionWindows(plan)) {
    lines.push(
      `小节 ${w.startBar}：${STEM_LABELS[w.stem]} 换手 ${w.lengthBeats} 拍（${w.curve}）` +
      ` → ${(w.startMs / 1000).toFixed(2)}s–${(w.endMs / 1000).toFixed(2)}s`,
    );
  }
  for (const warning of plan.warnings) lines.push(`⚠ ${warning}`);
  return lines;
}

/**
 * 兜底判定：进阶链路出任何异常都应该回到标准过渡，不能把声音搞没。
 * 调用方在 try/catch 的 catch 里调用它，拿到 `null` 就继续用 naturalGains。
 */
export function fallbackToStandard(error: unknown): ResolvedTransition {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    mode: 'standard',
    plan: null,
    events: [],
    totalMs: 0,
    stems: [],
    summary: [`进阶过渡失败，已回落到标准等功率交叉：${reason}`],
  };
}
