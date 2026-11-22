/**
 * 进阶混音 v2 的形态选择（E9）。
 *
 * 五种形态，按"最像 DJ"到"最保守"排：
 * - `loopBridge`：重复 A 的尾段乐句把过渡补到 B 的乐句边界（最像 iOS 27）
 * - `warp`：变速对齐 + 频段换手 + 扫频（iOS 26 水平）
 * - `doubleDrop`：把 B 的 drop 对齐到 A 的 drop，只混 2 小节（高风险高回报）
 * - `fade`：短等功率交叉（不做频段分工）
 * - `cut`：不混，直接切
 *
 * 判定顺序是"先否后肯"：任何一条硬约束不满足就往下退，绝不硬上。
 * 纯函数，不碰音频；返回的 `disableSweep` / `fadeBarsOverride` 由调用方落到曲线上。
 */
import type { BeatAnalysis, LoopUnit } from '../../online/analysis';
import type { QualityReport } from './v2Quality';

export type AutomixForm = 'cut' | 'fade' | 'warp' | 'loopBridge' | 'doubleDrop';

export interface FormInput {
  a: BeatAnalysis;
  b: BeatAnalysis;
  barMs: number;
  beatMs: number;
  fadeMs: number;
  /** B 相对 A 的速率（1 = 不变速）。 */
  tempoRate: number;
  /** 调性距离（Camelot 环上 0~6）。 */
  keyGap: number;
  /** 能量差（0~1）。 */
  energyGap: number;
  /** 质量门报告（规划期跑）。 */
  quality: QualityReport;
  /** 是否已经解出可用的结构桥接。 */
  hasBridge: boolean;
  /**
   * 唱词对齐是否可用。可用时禁用 doubleDrop：那是「两段 drop 直接叠」的手法，
   * 会无视下一首的首句位置，正好和「接唱点」的诉求相反。
   */
  preferVocalAlign?: boolean;
  /** 变速软上限（默认 0.15）。 */
  tempoSoftLimit?: number;
  /** 变速硬上限（默认 0.22）。 */
  tempoHardLimit?: number;
}

export interface FormDecision {
  form: AutomixForm;
  /** 人可读的原因（进日志 / 将来进"本次为什么这样混"面板）。 */
  reasons: string[];
  /** 是否关掉扫频（`fade` 形态不需要扫频，扫了反而像"水下"）。 */
  disableSweep: boolean;
  /** 覆盖过渡小节数（`doubleDrop` 用 2 小节）；null 表示沿用排程结果。 */
  fadeBarsOverride: number | null;
  /** 是否开人声 duck（有 activity 曲线且两首都会唱时才开）。 */
  useDuck: boolean;
}

/** Camelot 环上的最短距离（0 = 同调，6 = 最远）。 */
export function camelotGap(a?: string, b?: string): number {
  const parse = (value?: string): { number: number; letter: string } | null => {
    if (!value) return null;
    const match = /^(\d{1,2})([AB])$/.exec(value.trim().toUpperCase());
    if (!match) return null;
    const number = Number(match[1]);
    if (!Number.isFinite(number) || number < 1 || number > 12) return null;
    return { number, letter: match[2] };
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  const raw = Math.abs(left.number - right.number);
  let distance = Math.min(raw, 12 - raw);
  // 同一编号不同字母（8A vs 8B）是平行大小调，隔一层；这里按 +1 记。
  if (left.letter !== right.letter) distance += 1;
  return Math.min(6, distance);
}

/** 从 loopUnits 里挑一个落在 [fromMs, toMs] 的最高分单元。 */
export function pickLoopUnit(
  analysis: BeatAnalysis,
  fromMs: number,
  toMs: number,
): LoopUnit | null {
  const units = analysis.loopUnits;
  if (!Array.isArray(units) || units.length === 0) return null;
  let best: LoopUnit | null = null;
  for (const unit of units) {
    if (unit.startMs < fromMs || unit.endMs > toMs) continue;
    if (!best || unit.score > best.score) best = unit;
  }
  return best;
}

/** 两首是否都有可用的 drop（用于 doubleDrop 判定）。 */
function hasDrop(analysis: BeatAnalysis): boolean {
  return (analysis.sections ?? []).some((section) => section.label === 'drop');
}

export function selectForm(input: FormInput): FormDecision {
  const reasons: string[] = [];
  const soft = input.tempoSoftLimit ?? 0.15;
  const hard = input.tempoHardLimit ?? 0.22;
  const deviation = Math.abs(input.tempoRate - 1);
  const hasGridA = (input.a.downbeats?.length ?? 0) >= 2;
  const hasGridB = (input.b.downbeats?.length ?? 0) >= 2;
  const eitherSings = hasVocals(input.a) || hasVocals(input.b);

  // 1) 没有小节网格 → 只能淡入淡出，任何按小节的动作都会踩空。
  if (!hasGridA || !hasGridB) {
    reasons.push(!hasGridA && !hasGridB ? 'no-grid-both' : !hasGridA ? 'no-grid-a' : 'no-grid-b');
    return decision('fade', reasons, { disableSweep: true, fadeBarsOverride: null, useDuck: false });
  }

  // 2) 变速超出硬上限 / 调性太远 → 不混，切。硬切听起来比"两头都变形"好。
  if (deviation > hard) {
    reasons.push(`tempo-out-of-range:${deviation.toFixed(3)}`);
    return decision('cut', reasons, { disableSweep: true, fadeBarsOverride: null, useDuck: false });
  }
  if (input.keyGap >= 5) {
    reasons.push(`key-clash:${input.keyGap}`);
    return decision('cut', reasons, { disableSweep: true, fadeBarsOverride: null, useDuck: false });
  }

  // 3) 人声重叠就算开 duck 也救不回来（两首都一直在唱）→ 缩短过渡。
  if (input.quality.vocalOverlapBeats > 3) {
    reasons.push(`vocal-overlap:${input.quality.vocalOverlapBeats}`);
    return decision('fade', reasons, { disableSweep: true, fadeBarsOverride: 2, useDuck: false });
  }

  // 4) 结构桥接可用 → 最优先（它能真正做到"乐句对齐 + 零音色代价"）。
  if (input.hasBridge) {
    reasons.push('loop-bridge');
    return decision('loopBridge', reasons, {
      disableSweep: false,
      fadeBarsOverride: null,
      useDuck: eitherSings,
    });
  }

  // 4.5) 唱词对齐可用 → 不许 doubleDrop：那是「两段 drop 直接叠」，
  // 会无视下一首首句的位置，和「接唱点」的诉求正好相反；继续往下走 warp / fade。
  // 5) 两首都有 drop 且能量接近 → doubleDrop（只混 2 小节，靠 drop 的冲击盖住接缝）。
  if (
    !input.preferVocalAlign
    && hasDrop(input.a) && hasDrop(input.b) && input.energyGap <= 0.25 && deviation <= soft
  ) {
    reasons.push('double-drop');
    return decision('doubleDrop', reasons, {
      disableSweep: false,
      fadeBarsOverride: 2,
      useDuck: eitherSings,
    });
  }

  // 6) 需要变速 → warp；不需要 → fade（少动就少错）。
  if (deviation > 0.002) {
    reasons.push(`warp:${input.tempoRate.toFixed(3)}`);
    return decision('warp', reasons, {
      disableSweep: false,
      fadeBarsOverride: null,
      useDuck: eitherSings,
    });
  }

  reasons.push('no-warp-needed');
  return decision('fade', reasons, { disableSweep: true, fadeBarsOverride: null, useDuck: eitherSings });
}

function decision(
  form: AutomixForm,
  reasons: string[],
  options: { disableSweep: boolean; fadeBarsOverride: number | null; useDuck: boolean },
): FormDecision {
  return { form, reasons, ...options };
}

/** 有 activity 曲线且人声活动度中位数 > 0.35 才算"会唱"。 */
function hasVocals(analysis: BeatAnalysis): boolean {
  const vocal = analysis.activity?.vocal;
  if (!Array.isArray(vocal) || vocal.length === 0) return false;
  const sample = vocal.length > 200 ? vocal.filter((_, i) => i % Math.ceil(vocal.length / 200) === 0) : vocal;
  const sorted = [...sample].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return median > 0.35;
}
