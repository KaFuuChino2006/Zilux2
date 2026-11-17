/**
 * 高级过渡的可调参数（内部测试版）。
 *
 * 为什么要单独一层：过渡的手感（长度、各轨进入时刻、回声、滤波、人味抖动）是「耳朵决定」的，
 * 每次试都要改代码重打包显然不现实。这里把参数抽成一份可持久化的对象，
 * 面板改完立刻作用于下一次过渡，不动代码。
 *
 * 约定：**默认值 = 现有行为**。任何字段缺失/非法都回落到默认，绝不因为调参面板而改变旧表现。
 */

import type { Stem } from './transitionPlan';

export interface StartBars {
  drums: number;
  bass: number;
  other: number;
  vocals: number;
}

export interface TransitionTuning {
  /** 总长度（小节）。0 = 用模板默认（standard 32 / vocalFirst 16 / doubleDrop 8…）。 */
  bars: number;
  /** 手动换手时刻（小节）。null = 用模板默认。 */
  startBars: StartBars | null;
  /** 回声：反馈量、阻尼低通、拍分音符（0.25 = 1/4 拍）。 */
  echoFeedback: number;
  echoDampHz: number;
  echoDivision: number;
  /** filterBuild 的开门/关门频率。 */
  filterFromHz: number;
  filterToHz: number;
  /** 人味抖动幅度（毫秒）；0 = 不抖。 */
  humanizeMs: number;
  /** 四轨电平（0–1.5）：1 = 不增不减，0 = 该轨完全切掉。 */
  stemGains: StartBars;
  /** 强制走进阶换手：忽略置信度门控的降级（只在「进阶/稳妥」档有意义）。 */
  forceAdvanced: boolean;
}

export const TUNING_KEY = 'advancedTransitionTuning';

export const DEFAULT_TUNING: TransitionTuning = {
  bars: 0,
  startBars: null,
  echoFeedback: 0.35,
  echoDampHz: 3000,
  echoDivision: 0.25,
  filterFromHz: 320,
  filterToHz: 18000,
  humanizeMs: 0,
  stemGains: { drums: 1, bass: 1, other: 1, vocals: 1 },
  forceAdvanced: true,
};

const LIMITS = {
  bars: [0, 64] as const,
  bar: [0, 32] as const,
  feedback: [0, 0.7] as const,
  damp: [200, 12000] as const,
  division: [0.125, 1] as const,
  filter: [20, 20000] as const,
  humanize: [0, 40] as const,
};

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function startBarsOf(value: unknown): StartBars | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const pick = (k: Stem, fallback: number) => num(raw[k], fallback, LIMITS.bar[0], LIMITS.bar[1]);
  return {
    drums: pick('drums', 2),
    bass: pick('bass', 0),
    other: pick('other', 4),
    vocals: pick('vocals', 8),
  };
}

/** 把任意输入规整成合法调参；缺字段一律回默认。 */
export function normalizeTuning(input: unknown): TransitionTuning {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    bars: Math.round(num(raw.bars, DEFAULT_TUNING.bars, LIMITS.bars[0], LIMITS.bars[1])),
    startBars: startBarsOf(raw.startBars),
    echoFeedback: num(raw.echoFeedback, DEFAULT_TUNING.echoFeedback, LIMITS.feedback[0], LIMITS.feedback[1]),
    echoDampHz: num(raw.echoDampHz, DEFAULT_TUNING.echoDampHz, LIMITS.damp[0], LIMITS.damp[1]),
    echoDivision: num(raw.echoDivision, DEFAULT_TUNING.echoDivision, LIMITS.division[0], LIMITS.division[1]),
    filterFromHz: num(raw.filterFromHz, DEFAULT_TUNING.filterFromHz, LIMITS.filter[0], LIMITS.filter[1]),
    filterToHz: num(raw.filterToHz, DEFAULT_TUNING.filterToHz, LIMITS.filter[0], LIMITS.filter[1]),
    humanizeMs: num(raw.humanizeMs, DEFAULT_TUNING.humanizeMs, LIMITS.humanize[0], LIMITS.humanize[1]),
    stemGains: (() => {
      const g = (raw.stemGains ?? {}) as Record<string, unknown>;
      const pick = (k: keyof StartBars) => num(g[k], 1, 0, 1.5);
      return { drums: pick('drums'), bass: pick('bass'), other: pick('other'), vocals: pick('vocals') };
    })(),
    forceAdvanced: raw.forceAdvanced !== false,
  };
}

export function readTuning(): TransitionTuning {
  try {
    const raw = localStorage.getItem(TUNING_KEY);
    if (!raw) return { ...DEFAULT_TUNING };
    return normalizeTuning(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TUNING };
  }
}

export function writeTuning(patch: Partial<TransitionTuning>): TransitionTuning {
  const next = normalizeTuning({ ...readTuning(), ...patch });
  try {
    localStorage.setItem(TUNING_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式写不进去，本次会话仍生效 */
  }
  return next;
}

export function resetTuning(): TransitionTuning {
  try {
    localStorage.removeItem(TUNING_KEY);
  } catch {
    /* 忽略 */
  }
  return { ...DEFAULT_TUNING };
}

/** 供 `describePlan`/面板显示：这份调参是否真的改了默认值。 */
export function isTuningDirty(t: TransitionTuning): boolean {
  return JSON.stringify(normalizeTuning(t)) !== JSON.stringify(DEFAULT_TUNING);
}
