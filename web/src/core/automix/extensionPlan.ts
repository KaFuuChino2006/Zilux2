/**
 * 延长段规划（纯函数）：A 尾奏不够长时把最后一个循环单元平铺，B 前奏不够长时复用前奏重复段。
 *
 * 本模块只读 BeatAnalysis 的既有曲线（loopUnits / momentaryLufs / styleFeatures.centroidHz）
 * 做决策与质量门，不碰 Web Audio、不做推理、不 await。
 * 执行层在 `web/src/audio/extensionPlayer.ts`：把选中的单元解码并平铺成 AudioBuffer。
 *
 * 质量门（契约 §6）：
 * - 接缝能量跳变 ≤ 1.5 dB
 * - 谱质心漂移 ≤ 10%
 * - 响度差 ≤ 1 LU
 * 任一超标（且该项可测）直接返回 `source: 'none'`。
 */

/** 接缝处理宽度：2 ms 的极短缺口，落在小节线上通常被鼓点掩住。 */
export const EXTENSION_SEAM_MS = 2;

/** 默认最长延长量（毫秒）。 */
export const EXTENSION_DEFAULT_MAX_MS = 32_000;

/** 延长段最多覆盖的小节数（A 尾）。 */
export const EXTENSION_MAX_BARS = 8;

/** A 尾最多平铺的遍数。 */
export const EXTENSION_A_MAX_PASSES = 2;

/** B 前奏最少 / 最多平铺的遍数。 */
export const EXTENSION_B_MIN_PASSES = 2;
export const EXTENSION_B_MAX_PASSES = 4;

/** 接缝能量跳变上限（dB）。 */
export const EXTENSION_MAX_SEAM_JUMP_DB = 1.5;

/** 谱质心漂移上限（比例）。 */
export const EXTENSION_MAX_CENTROID_DRIFT = 0.1;

/** 响度差上限（LU）。 */
export const EXTENSION_MAX_LOUDNESS_DIFF_LU = 1;

export type ExtensionSource = 'a-tail' | 'b-intro' | 'model' | 'none';

/** 延长段质量门的可测项（无法测量的项为 null，不参与拒绝）。 */
export interface ExtensionGateMetrics {
  seamJumpDb: number | null;
  centroidDrift: number | null;
  loudnessDiffLu: number | null;
}

export interface ExtensionPlan {
  source: ExtensionSource;
  /** 生成段来源：stable-audio 垫底 / musicgen 真续接；loop/none 不带。 */
  model?: 'stable-audio' | 'musicgen';
  /** 单元起点（文件毫秒）。none 时为 0。 */
  unitStartMs: number;
  /** 一遍的长度（毫秒）。none 时为 0。 */
  unitMs: number;
  /** 平铺遍数。none 时为 0。 */
  passes: number;
  /** 计划总长 = unitMs × passes（毫秒）。 */
  targetMs: number;
  /** 接缝缺口宽度（毫秒）。 */
  seamMs: number;
  /** 播放增益（dB）：只做小幅响度对齐，不替代让位曲线。 */
  gainDb: number;
  reason: string;
  /**
   * `tail`：补在 A 可听结尾之后（历史行为）。
   * `bed`：整段过渡垫底——从 fadeStart 起播、随换手收尾（生成过渡开关打开时用）。
   */
  mode?: 'tail' | 'bed';
  /** 质量门实测值，供日志/浮层使用。 */
  metrics?: ExtensionGateMetrics;
  /**
   * 续接独占：真续接开启时整段过渡只放续接片段，不再叠分频换手/让位/扫频/混响/回声。
   * 开启后 `targetMs` 会等于整个换手窗口，不足部分由播放层平铺。
   */
  continuationOnly?: boolean;
}

/** 只声明本模块用得到的 BeatAnalysis 子集（结构化类型，避免把分析层依赖带进纯函数测试）。 */
export interface ExtensionLoopUnit {
  startMs: number;
  endMs: number;
  bars: number;
  score: number;
  kind: string;
}

export interface ExtensionModelPayload {
  v?: number;
  source?: string;
  model?: string | null;
  modelSha256?: string | null;
  startMs: number;
  durationMs: number;
  loudnessLufs: number;
  prompt?: string | null;
  file: string;
}

export interface ExtensionStyleFeatures {
  hopMs?: number;
  centroidHz?: number[];
}

export interface ExtensionAnalysis {
  audibleEndMs?: number;
  cueInMs?: number;
  bpm?: number;
  downbeats?: number[];
  loopUnits?: readonly ExtensionLoopUnit[];
  loudnessLufs?: number;
  loudnessTimesMs?: number[];
  momentaryLufs?: number[];
  styleFeatures?: ExtensionStyleFeatures | null;
  extension?: ExtensionModelPayload | null;
}

export interface ExtensionPolicyLike {
  extension: {
    /** A 尾用多少小节（默认 4）。 */
    aTailBars: number;
    /** B 前奏用多少小节（默认 4）。 */
    bIntroBars: number;
    /** 最长延长量（毫秒，默认 32000）。 */
    maxMs: number;
  };
}

export interface PlanExtensionInput {
  analysis: ExtensionAnalysis;
  side: 'a' | 'b';
  /** 需要补足的时长（毫秒）：A = 可听结尾到窗口终点的缺口；B = B 起播前的等待。 */
  neededMs: number;
  policy: ExtensionPolicyLike;
  barMs: number;
  /** 宿主已有模型延长产物时优先用它；失败自动回落到循环。 */
  preferModel?: boolean;
  /**
   * 模型产物是否已经解码可用。规划层拿不到 PCM，默认 false；
   * 调用方只有在真的持有模型 AudioBuffer 时才置 true，避免计划指向无法播放的素材。
   */
  modelReady?: boolean;
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

function policyMaxMs(policy: ExtensionPolicyLike): number {
  const value = finite(policy?.extension?.maxMs);
  return value > 0 ? Math.min(120_000, Math.max(1_000, value)) : EXTENSION_DEFAULT_MAX_MS;
}

/** 最近的 momentary LUFS 采样（找不到返回 null）。 */
function lufsAt(analysis: ExtensionAnalysis, ms: number): number | null {
  const times = analysis.loudnessTimesMs;
  const values = analysis.momentaryLufs;
  if (!times || !values || times.length === 0 || values.length === 0) return null;
  const limit = Math.min(times.length, values.length);
  if (limit === 0) return null;
  let best = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < limit; index += 1) {
    const t = times[index]!;
    const distance = Math.abs(t - ms);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  if (best < 0) return null;
  const value = values[best]!;
  return Number.isFinite(value) ? value : null;
}

/** [start, end) 内 momentary LUFS 的均值（至少两个采样才返回，否则 null）。 */
export function meanMomentaryLufs(analysis: ExtensionAnalysis, startMs: number, endMs: number): number | null {
  const times = analysis.loudnessTimesMs;
  const values = analysis.momentaryLufs;
  if (!times || !values) return null;
  const limit = Math.min(times.length, values.length);
  let sum = 0;
  let count = 0;
  for (let index = 0; index < limit; index += 1) {
    const t = times[index]!;
    if (t < startMs || t >= endMs) continue;
    const value = values[index]!;
    if (!Number.isFinite(value)) continue;
    sum += value;
    count += 1;
  }
  return count >= 2 ? sum / count : null;
}

/** [start, end) 内谱质心均值（至少两个采样才返回）。 */
export function meanCentroidHz(analysis: ExtensionAnalysis, startMs: number, endMs: number): number | null {
  const features = analysis.styleFeatures;
  const centroids = features?.centroidHz;
  if (!centroids || centroids.length === 0) return null;
  const hop = Number.isFinite(features?.hopMs) && (features?.hopMs as number) > 0 ? (features?.hopMs as number) : 500;
  let sum = 0;
  let count = 0;
  for (let index = 0; index < centroids.length; index += 1) {
    const t = index * hop;
    if (t < startMs || t >= endMs) continue;
    const value = centroids[index]!;
    if (!Number.isFinite(value) || value <= 0) continue;
    sum += value;
    count += 1;
  }
  return count >= 2 ? sum / count : null;
}

/** 全曲谱质心均值（质量门的参考亮度）。 */
export function overallCentroidHz(analysis: ExtensionAnalysis): number | null {
  const centroids = analysis.styleFeatures?.centroidHz;
  if (!centroids || centroids.length === 0) return null;
  let sum = 0;
  let count = 0;
  for (const value of centroids) {
    if (!Number.isFinite(value) || value <= 0) continue;
    sum += value;
    count += 1;
  }
  return count >= 2 ? sum / count : null;
}

/** 循环接缝的能量跳变（dB）：单元末端的平均电平 vs 单元开头的平均电平。 */
export function seamJumpDb(analysis: ExtensionAnalysis, unitStartMs: number, unitEndMs: number): number | null {
  const unitMs = unitEndMs - unitStartMs;
  if (!(unitMs > 0)) return null;
  const window = Math.max(200, Math.min(500, unitMs / 4));
  const head = meanMomentaryLufs(analysis, unitStartMs, unitStartMs + window);
  const tail = meanMomentaryLufs(analysis, unitEndMs - window, unitEndMs);
  if (head === null && tail === null) return null;
  if (head === null || tail === null) {
    // 单端可测时退到「接缝两侧最近采样」比较。
    const a = lufsAt(analysis, unitEndMs - window / 2);
    const b = lufsAt(analysis, unitStartMs + window / 2);
    if (a === null || b === null) return null;
    return Math.abs(a - b);
  }
  return Math.abs(tail - head);
}

/** 质量门：只拒绝可测且超标的项。 */
export function evaluateExtensionGate(input: {
  analysis: ExtensionAnalysis;
  unitStartMs: number;
  unitEndMs: number;
}): { ok: boolean; metrics: ExtensionGateMetrics; reasons: string[] } {
  const { analysis, unitStartMs, unitEndMs } = input;
  const metrics: ExtensionGateMetrics = {
    seamJumpDb: seamJumpDb(analysis, unitStartMs, unitEndMs),
    centroidDrift: null,
    loudnessDiffLu: null,
  };
  const reasons: string[] = [];
  if (metrics.seamJumpDb !== null && metrics.seamJumpDb > EXTENSION_MAX_SEAM_JUMP_DB) {
    reasons.push(`接缝能量跳变 ${metrics.seamJumpDb.toFixed(1)} dB > ${EXTENSION_MAX_SEAM_JUMP_DB} dB`);
  }
  const unitCentroid = meanCentroidHz(analysis, unitStartMs, unitEndMs);
  const overall = overallCentroidHz(analysis);
  if (unitCentroid !== null && overall !== null && overall > 1) {
    const drift = Math.abs(unitCentroid - overall) / overall;
    metrics.centroidDrift = drift;
    if (drift > EXTENSION_MAX_CENTROID_DRIFT) {
      reasons.push(`谱质心漂移 ${(drift * 100).toFixed(1)}% > ${(EXTENSION_MAX_CENTROID_DRIFT * 100).toFixed(0)}%`);
    }
  }
  const unitLufs = meanMomentaryLufs(analysis, unitStartMs, unitEndMs);
  const reference = finite(analysis.loudnessLufs) !== 0 ? finite(analysis.loudnessLufs) : null;
  if (unitLufs !== null && reference !== null) {
    const diff = unitLufs - reference;
    metrics.loudnessDiffLu = diff;
    if (Math.abs(diff) > EXTENSION_MAX_LOUDNESS_DIFF_LU) {
      reasons.push(`响度差 ${diff.toFixed(1)} LU > ${EXTENSION_MAX_LOUDNESS_DIFF_LU} LU`);
    }
  } else if (unitLufs !== null) {
    metrics.loudnessDiffLu = 0;
  }
  return { ok: reasons.length === 0, metrics, reasons };
}

function nonePlan(reason: string, metrics?: ExtensionGateMetrics): ExtensionPlan {
  return {
    source: 'none',
    unitStartMs: 0,
    unitMs: 0,
    passes: 0,
    targetMs: 0,
    seamMs: EXTENSION_SEAM_MS,
    gainDb: 0,
    reason,
    ...(metrics ? { metrics } : {}),
  };
}

function gainForUnit(analysis: ExtensionAnalysis, unitStartMs: number, unitEndMs: number): number {
  const unitLufs = meanMomentaryLufs(analysis, unitStartMs, unitEndMs);
  const reference = finite(analysis.loudnessLufs) !== 0 ? finite(analysis.loudnessLufs) : null;
  if (unitLufs === null || reference === null) return 0;
  // 只做小幅细调：质量门保证差值 ≤ 1 LU，这里最多再修 1 dB。
  return clamp(reference - unitLufs, -1, 1);
}

function lastTailUnit(analysis: ExtensionAnalysis, audibleEndMs: number, barMs: number): ExtensionLoopUnit | null {
  const units = analysis.loopUnits;
  if (!units || units.length === 0) return null;
  const limit = audibleEndMs > 0 ? audibleEndMs + EXTENSION_SEAM_MS : Infinity;
  const valid = units.filter((unit) => {
    if (!unit) return false;
    const start = finite(unit.startMs);
    const end = finite(unit.endMs);
    if (!(end > start)) return false;
    if (end > limit) return false;
    if (end - start < Math.max(250, barMs * 0.5)) return false;
    if (!(finite(unit.bars) > 0)) return false;
    return true;
  });
  if (valid.length === 0) return null;
  return valid.reduce((latest, unit) => (unit.endMs >= latest.endMs ? unit : latest));
}

function bestIntroUnit(analysis: ExtensionAnalysis, introEndMs: number, barMs: number): ExtensionLoopUnit | null {
  const units = analysis.loopUnits;
  if (!units || units.length === 0) return null;
  const candidates = units.filter((unit) => {
    if (!unit || unit.kind !== 'repeat') return false;
    const start = finite(unit.startMs);
    const end = finite(unit.endMs);
    if (!(end > start)) return false;
    if (start < 0 || end > introEndMs + EXTENSION_SEAM_MS) return false;
    if (end - start < Math.max(250, barMs * 0.5)) return false;
    return finite(unit.bars) > 0;
  });
  if (candidates.length === 0) return null;
  return candidates.reduce((best, unit) => (finite(unit.score) > finite(best.score) ? unit : best));
}

function modelPlan(input: PlanExtensionInput, neededMs: number): ExtensionPlan | null {
  const { analysis, policy } = input;
  if (!input.preferModel || !input.modelReady) return null;
  const model = analysis.extension;
  if (!model || typeof model.file !== 'string' || model.file.length === 0) return null;
  const durationMs = finite(model.durationMs);
  if (!(durationMs > 0)) return null;
  const maxMs = policyMaxMs(policy);
  if (durationMs > maxMs) {
    return nonePlan(`模型延长 ${Math.round(durationMs / 1000)}s 超过上限 ${Math.round(maxMs / 1000)}s`);
  }
  if (neededMs > 0 && durationMs < neededMs * 0.9) {
    return null;
  }
  const reference = finite(analysis.loudnessLufs) !== 0 ? finite(analysis.loudnessLufs) : null;
  const modelLufs = finite(model.loudnessLufs);
  let diff: number | null = null;
  if (reference !== null && Number.isFinite(model.loudnessLufs)) {
    diff = modelLufs - reference;
    if (Math.abs(diff) > EXTENSION_MAX_LOUDNESS_DIFF_LU) {
      return null;
    }
  }
  const metrics: ExtensionGateMetrics = {
    seamJumpDb: null,
    centroidDrift: null,
    loudnessDiffLu: diff,
  };
  return {
    source: 'model',
    unitStartMs: Math.max(0, finite(model.startMs)),
    unitMs: Math.round(durationMs),
    passes: 1,
    targetMs: Math.round(durationMs),
    seamMs: EXTENSION_SEAM_MS,
    gainDb: diff === null ? 0 : clamp(-diff, -1, 1),
    reason: `模型延长 ${Math.round(durationMs / 1000)}s（${model.model || model.source || 'model'}）`,
    metrics,
  };
}

/**
 * 规划一次延长。
 *
 * - A 尾：取 loopUnits 里最后一个有效单元，passes 1–2，总长 ≤ min(maxMs, 8 小节)。
 * - B 前奏：优先前奏里 kind='repeat' 的循环单元；没有就退回前奏开头 aIntroBars 小节。
 * - 模型产物（preferModel + modelReady）优先；任一质量门失败就回落到循环。
 */
export function planExtension(input: PlanExtensionInput): ExtensionPlan {
  const { analysis, side, policy } = input;
  const barMs = Number.isFinite(input.barMs) && input.barMs > 0 ? input.barMs : 2_000;
  const neededMs = Math.max(0, finite(input.neededMs));
  const maxMs = policyMaxMs(policy);

  const model = modelPlan(input, neededMs);
  if (model) {
    if (model.source !== 'none') return model;
    // 模型被上限拒绝时仍允许循环兜底（除非循环本身也不可用）。
  }

  if (side === 'a') {
    const audibleEnd = finite(analysis.audibleEndMs);
    if (!(audibleEnd > 0)) return nonePlan('缺少可听结尾，不能规划尾奏延长');
    const unit = lastTailUnit(analysis, audibleEnd, barMs);
    if (!unit) return nonePlan('没有可用的尾奏循环单元');
    const unitStartMs = Math.round(finite(unit.startMs));
    const unitEndMs = Math.round(finite(unit.endMs));
    const unitMs = unitEndMs - unitStartMs;
    if (!(unitMs > 0)) return nonePlan('尾奏循环单元长度无效');
    const bars = Math.max(1, Math.round(finite(unit.bars)));
    const maxPasses = EXTENSION_A_MAX_PASSES;
    let passes = clamp(Math.ceil(neededMs / unitMs), 1, maxPasses);
    if (neededMs <= 0) passes = 1;
    const totalMs = unitMs * passes;
    if (totalMs > maxMs) return nonePlan(`尾奏延长 ${(totalMs / 1000).toFixed(1)}s 超过上限 ${(maxMs / 1000).toFixed(1)}s`);
    if (bars * passes > EXTENSION_MAX_BARS) {
      return nonePlan(`尾奏延长 ${bars * passes} 小节超过 ${EXTENSION_MAX_BARS} 小节上限`);
    }
    if (neededMs > 0 && totalMs < neededMs * 0.9) {
      return nonePlan(`尾奏单元 ${(unitMs / 1000).toFixed(1)}s × ${passes} 遍补不满缺口 ${(neededMs / 1000).toFixed(1)}s`);
    }
    const gate = evaluateExtensionGate({ analysis, unitStartMs, unitEndMs });
    if (!gate.ok) return nonePlan(gate.reasons.join('；'), gate.metrics);
    return {
      source: 'a-tail',
      unitStartMs,
      unitMs,
      passes,
      targetMs: Math.round(totalMs),
      seamMs: EXTENSION_SEAM_MS,
      gainDb: gainForUnit(analysis, unitStartMs, unitEndMs),
      reason: `A 尾奏补 ${passes} 遍 ${bars} 小节（${(totalMs / 1000).toFixed(1)}s）`,
      metrics: gate.metrics,
    };
  }

  // ---- B 前奏 ----
  const cueIn = finite(analysis.cueInMs);
  const introEndMs = cueIn > barMs * 0.5 ? cueIn : barMs * 8;
  const policyBars = Math.max(1, Math.min(EXTENSION_MAX_BARS, Math.round(finite(policy?.extension?.bIntroBars) || 4)));
  let unitStartMs = 0;
  let unitMs = 0;
  let bars = policyBars;
  let unitEndMs = 0;
  const picked = bestIntroUnit(analysis, introEndMs, barMs);
  if (picked) {
    unitStartMs = Math.round(finite(picked.startMs));
    unitEndMs = Math.round(finite(picked.endMs));
    unitMs = unitEndMs - unitStartMs;
    bars = Math.max(1, Math.round(finite(picked.bars)));
  } else {
    // 没有可循环单元：用前奏开头 4/2 小节，不能越过 cueIn。
    const roomBars = Math.max(1, Math.floor(introEndMs / barMs));
    bars = Math.min(policyBars, roomBars);
    unitStartMs = 0;
    unitMs = Math.round(bars * barMs);
    unitEndMs = unitMs;
  }
  if (!(unitMs > 0)) return nonePlan('B 前奏单元长度无效');
  const minPasses = EXTENSION_B_MIN_PASSES;
  const maxPasses = EXTENSION_B_MAX_PASSES;
  const passes = clamp(Math.ceil(neededMs / unitMs), minPasses, maxPasses);
  const totalMs = unitMs * passes;
  if (totalMs > maxMs) return nonePlan(`前奏延长 ${(totalMs / 1000).toFixed(1)}s 超过上限 ${(maxMs / 1000).toFixed(1)}s`);
  if (neededMs > 0 && totalMs < neededMs * 0.9) {
    return nonePlan(`前奏单元 ${(unitMs / 1000).toFixed(1)}s × ${passes} 遍补不满缺口 ${(neededMs / 1000).toFixed(1)}s`);
  }
  const gate = evaluateExtensionGate({ analysis, unitStartMs, unitEndMs });
  if (!gate.ok) return nonePlan(gate.reasons.join('；'), gate.metrics);
  return {
    source: 'b-intro',
    unitStartMs,
    unitMs,
    passes,
    targetMs: Math.round(totalMs),
    seamMs: EXTENSION_SEAM_MS,
    gainDb: gainForUnit(analysis, unitStartMs, unitEndMs),
    reason: picked
      ? `B 前奏复用 ${bars} 小节循环单元 × ${passes}（${(totalMs / 1000).toFixed(1)}s）`
      : `B 前奏开头 ${bars} 小节 × ${passes}（${(totalMs / 1000).toFixed(1)}s）`,
    metrics: gate.metrics,
  };
}
