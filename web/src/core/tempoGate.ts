/**
 * 速度门控（WBS v2 §6 / T6）。
 *
 * 目的：一次过渡要不要做、能做到多深，取决于「两首歌的速度到底对不对得上」。
 * 现有分析给出的 BPM 有八度歧义（常见 ×2 / ÷2，也见 2/3、3/2），
 * 所以这里不直接比较两个 bpm 数字，而是先在一个**受控候选集**里挑一个播放速率，
 * 再按「速率偏差 + 下拍相位 + 乐句密度」三项打分，最后按置信度分三档：
 *
 *   full          —— 四轨换手（有人声交换）
 *   bassDrumsOnly —— 只换低频与鼓，其他轨不冒险
 *   standard      —— 回到现有等功率过渡（冻结不动的那条路）
 *
 * 纯函数：不碰 DOM、不碰 AudioContext，方便单测与在 Worker 里跑。
 */

import type { BeatAnalysis } from '../online/analysis';

/** 候选速率：同速、半/双速、以及三连音一侧的 2/3、3/2、3/4、4/3。 */
export const TEMPO_CANDIDATES: readonly number[] = [1, 1 / 2, 2, 2 / 3, 3 / 2, 3 / 4, 4 / 3];

export type GateTier = 'full' | 'bassDrumsOnly' | 'standard';

export interface TempoCandidate {
  /** 应用到 B 的播放速率（1 = 原速）。 */
  ratio: number;
  /** B 在该速率下的等效 BPM。 */
  bpmB: number;
  /** |log2(等效 BPM / A 的 BPM)|，0 表示完全对上。 */
  deviation: number;
  /** 下拍相位吻合度 0~1。 */
  downbeatAlign: number;
  /** 乐句密度吻合度 0~1。 */
  phraseMatch: number;
  /** 综合分 0~1。 */
  score: number;
}

export interface GateOptions {
  /** 允许「完整换手」的最低 BPM 置信度。 */
  minFullConfidence?: number;
  /** 允许「只换低频+鼓」的最低 BPM 置信度。 */
  minAssistConfidence?: number;
  /** 完整换手要求的最低拍点稳定度。 */
  minFullStability?: number;
  /** 降级到低频+鼓要求的最低拍点稳定度。 */
  minAssistStability?: number;
  /** 完整换手允许的最大速率偏差（log2 距离）。 */
  maxFullDeviation?: number;
}

export interface GateDecision {
  tier: GateTier;
  /** 选中的候选（最差情况 = 1.0）。 */
  best: TempoCandidate;
  /** 全部候选，按分数降序。 */
  candidates: TempoCandidate[];
  /** 两首里较低的 BPM 置信度。 */
  confidence: number;
  /** 两首里较低的拍点稳定度。 */
  stability: number;
  /** 人类可读的原因，按判定顺序。 */
  reasons: string[];
}

const DEFAULTS: Required<GateOptions> = {
  minFullConfidence: 0.65,
  minAssistConfidence: 0.45,
  minFullStability: 0.6,
  minAssistStability: 0.4,
  maxFullDeviation: 0.06,
};

function num(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 小节时长（ms）。meter 缺失按 4/4。 */
export function barMsOf(analysis: BeatAnalysis, beatMs?: number): number {
  const meter = num(analysis.meter, 4) || 4;
  const beat = beatMs ?? num(analysis.beatIntervalMs, 0);
  const safeBeat = beat > 0 ? beat : 60000 / Math.max(40, num(analysis.bpm, 120));
  return safeBeat * meter;
}

/**
 * 下拍相位吻合度：把两边的下拍落点折到「一小节」里，算圆环距离。
 * 1 = 完全重合，0 = 差半小节。
 */
export function downbeatAlignment(a: BeatAnalysis, b: BeatAnalysis, ratio: number): number {
  const safeRatio = ratio > 0 ? ratio : 1;
  const barA = barMsOf(a);
  const barB = barMsOf(b) / safeRatio;
  if (!(barA > 0) || !(barB > 0)) return 0;
  const period = Math.max(barA, barB);
  const phaseA = num(a.firstDownbeatMs, 0) % barA;
  const phaseB = num(b.firstDownbeatMs, 0) % barB;
  const raw = Math.abs(phaseA - (phaseB * barA) / barB);
  const dist = Math.min(raw, period - raw) / (period / 2);
  return clamp01(1 - dist);
}

/**
 * 乐句密度吻合度：每小节里「乐句起点」的比例越接近，越容易在换手时对上百。
 * 缺 `phraseStartsMs` 时两边都按 0 处理 ⇒ 返回 1（不因缺数据而扣分）。
 */
export function phraseAlignment(a: BeatAnalysis, b: BeatAnalysis): number {
  const density = (analysis: BeatAnalysis): number | null => {
    const starts = analysis.phraseStartsMs;
    if (!Array.isArray(starts) || !starts.length) return null;
    const bars = num(analysis.barCount, 0);
    if (!(bars > 0)) return null;
    return starts.length / bars;
  };
  const da = density(a);
  const db = density(b);
  if (da === null || db === null) return 1;
  return clamp01(1 - Math.abs(da - db) * 4);
}

/** 给定一个速率，算 B 的等效 BPM 与相对 A 的偏差。 */
export function deviationOf(a: BeatAnalysis, b: BeatAnalysis, ratio: number): number {
  const bpmA = Math.max(1, num(a.bpm, 120));
  const bpmB = Math.max(1, num(b.bpm, 120)) * ratio;
  return Math.abs(Math.log2(bpmB / bpmA));
}

/** 对候选集逐个打分，按分数降序返回。 */
export function scoreCandidates(a: BeatAnalysis, b: BeatAnalysis): TempoCandidate[] {
  const bpmB0 = Math.max(1, num(b.bpm, 120));
  const scored = TEMPO_CANDIDATES.map((ratio) => {
    const deviation = deviationOf(a, b, ratio);
    const downbeatAlign = downbeatAlignment(a, b, ratio);
    const phraseMatch = phraseAlignment(a, b);
    const score = 0.55 * Math.exp(-2.5 * deviation) + 0.3 * downbeatAlign + 0.15 * phraseMatch;
    return {
      ratio,
      bpmB: bpmB0 * ratio,
      deviation,
      downbeatAlign,
      phraseMatch,
      score: clamp01(score),
    };
  });
  scored.sort((x, y) => (y.score - x.score) || (x.deviation - y.deviation));
  return scored;
}

/**
 * 三档门控。
 * 判定顺序：置信度/稳定度 → 速率偏差 → 档位；任何一步不满足就降档。
 */
export function decideTempoGate(
  a: BeatAnalysis,
  b: BeatAnalysis,
  options: GateOptions = {},
): GateDecision {
  const opts = { ...DEFAULTS, ...options };
  const candidates = scoreCandidates(a, b);
  const best = candidates[0];
  const confidence = Math.min(clamp01(num(a.bpmConfidence, 0.5)), clamp01(num(b.bpmConfidence, 0.5)));
  const stability = Math.min(
    clamp01(num(a.tempoStability, num(a.bpmConfidence, 0.5))),
    clamp01(num(b.tempoStability, num(b.bpmConfidence, 0.5))),
  );

  const reasons: string[] = [];
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const ratioText = Number.isInteger(best.ratio) ? String(best.ratio) : best.ratio.toFixed(2);

  reasons.push(`BPM 置信度 min=${confidence.toFixed(2)}（完整换手需 ≥${opts.minFullConfidence}）`);
  reasons.push(`拍点稳定度 min=${stability.toFixed(2)}（完整换手需 ≥${opts.minFullStability}）`);
  reasons.push(
    `候选倍率 ×${ratioText}：B 等效 ${best.bpmB.toFixed(1)} BPM，与 A 的 ${num(a.bpm, 0).toFixed(1)} 相差 ${pct(best.deviation)}`,
  );

  let tier: GateTier = 'standard';
  if (confidence >= opts.minFullConfidence && stability >= opts.minFullStability) {
    if (best.deviation <= opts.maxFullDeviation) {
      tier = 'full';
      reasons.push('三条件均满足 → 完整四轨换手');
    } else {
      tier = 'bassDrumsOnly';
      reasons.push(`速率偏差 ${pct(best.deviation)} > ${pct(opts.maxFullDeviation)} → 只换低频与鼓`);
    }
  } else if (confidence >= opts.minAssistConfidence && stability >= opts.minAssistStability) {
    tier = 'bassDrumsOnly';
    reasons.push('置信度/稳定度只够辅助档 → 只换低频与鼓');
  } else {
    reasons.push('置信度或稳定度不足 → 回退标准等功率过渡');
  }

  if (best.downbeatAlign < 0.6 && tier === 'full') {
    reasons.push(`下拍相位吻合度仅 ${pct(best.downbeatAlign)}，换手点可能错半小节（建议人工确认）`);
  }

  return { tier, best, candidates, confidence, stability, reasons };
}

/** 门控结果是否允许人声参与交换。 */
export function allowsVocals(decision: GateDecision): boolean {
  return decision.tier === 'full' && decision.best.downbeatAlign >= 0.5;
}
