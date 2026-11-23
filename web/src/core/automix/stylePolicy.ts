/**
 * 风格策略（契约 §4）：把 A/B 的 StyleProfile 与过渡上下文折算成窗口、swap、duck、
 * EQ、混响/回声送出与延长预算。
 *
 * 纯函数；契约里的 7 条硬规则逐条实现（reasons 里标出规则编号），
 * 所有输出数值在 finalize 里夹进契约范围，越界输入（NaN/负 keyGap）也按保守值处理。
 *
 * 规则叠加顺序：1 → 4 → 5 → 7；1/2/3 是互斥的「曲风对」原型，只命中第一条。
 * 后触发的规则覆盖同名字段（例：同调时规则 5 把规则 1/2/4 的 EQ 归零）。
 */

import type { StyleProfile, StyleTag } from './styleProfile';

export interface StyleEqPlan {
  aHighDb: number;
  aPresenceDb: number;
  aPresenceHz: number;
  bHighDb: number;
  bPresenceDb: number;
  bPresenceHz: number;
  bLowDb: number;
}

export interface StylePolicy {
  windowScale: number;
  swapShareBias: number;
  duckScale: number;
  reverbSendDb: number;
  echoSendDb: number;
  eq: StyleEqPlan;
  techniqueBias: Partial<Record<string, number>>;
  extension: { aTailBars: number; bIntroBars: number; maxMs: number };
  keyLift: 'off' | 'bridge-only';
  reasons: string[];
}

/** 契约 §4 的范围与门槛；单测据此做越界检查。 */
export const STYLE_POLICY_LIMITS = {
  windowScaleMin: 0.8,
  windowScaleMax: 1.4,
  windowCapOnBpmGap: 1.15,
  bpmGapThreshold: 0.12,
  swapShareBiasMin: -0.15,
  swapShareBiasMax: 0.15,
  duckScaleMin: 0.4,
  duckScaleMax: 1.2,
  sendDbMin: -12,
  sendDbMax: 0,
  eqDbMin: -3,
  eqDbMax: 3,
  presenceHzMin: 800,
  presenceHzMax: 8000,
  lowConfidence: 0.45,
  maxExtensionMs: 32_000,
  maxExtensionBars: 8,
  /** tags 里的分数达到这个值就当作「这首属于该标签」（primary 永远算）。 */
  tagPresenceMin: 0.6,
} as const;

/** 无规则命中时的中性参数；单测快照直接引用这张表。 */
export const STYLE_POLICY_DEFAULTS = {
  windowScale: 1,
  swapShareBias: 0,
  duckScale: 1,
  reverbSendDb: 0,
  echoSendDb: 0,
  aHighDb: 0,
  aPresenceDb: 0,
  aPresenceHz: 2_500,
  bHighDb: 0,
  bPresenceDb: 0,
  bPresenceHz: 2_000,
  bLowDb: 0,
  aTailBars: 4,
  bIntroBars: 4,
} as const;

const L = STYLE_POLICY_LIMITS;

function num(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

function round1(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function formatConf(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '?';
}

/** primary 或任一标签分数 ≥ tagPresenceMin 即视为属于该组。 */
function hasTag(profile: StyleProfile, tags: readonly StyleTag[]): boolean {
  if (!profile) return false;
  for (const tag of tags) {
    if (profile.primary === tag) return true;
    const score = profile.tags?.[tag];
    if (typeof score === 'number' && Number.isFinite(score) && score >= L.tagPresenceMin) {
      return true;
    }
  }
  return false;
}

function isInstrumental(profile: StyleProfile): boolean {
  if (!profile) return false;
  return profile.vocal === 'instrumental' || hasTag(profile, ['instrumental']);
}

function basePolicy(): StylePolicy {
  return {
    windowScale: STYLE_POLICY_DEFAULTS.windowScale,
    swapShareBias: STYLE_POLICY_DEFAULTS.swapShareBias,
    duckScale: STYLE_POLICY_DEFAULTS.duckScale,
    reverbSendDb: STYLE_POLICY_DEFAULTS.reverbSendDb,
    echoSendDb: STYLE_POLICY_DEFAULTS.echoSendDb,
    eq: {
      aHighDb: STYLE_POLICY_DEFAULTS.aHighDb,
      aPresenceDb: STYLE_POLICY_DEFAULTS.aPresenceDb,
      aPresenceHz: STYLE_POLICY_DEFAULTS.aPresenceHz,
      bHighDb: STYLE_POLICY_DEFAULTS.bHighDb,
      bPresenceDb: STYLE_POLICY_DEFAULTS.bPresenceDb,
      bPresenceHz: STYLE_POLICY_DEFAULTS.bPresenceHz,
      bLowDb: STYLE_POLICY_DEFAULTS.bLowDb,
    },
    techniqueBias: {},
    extension: {
      aTailBars: STYLE_POLICY_DEFAULTS.aTailBars,
      bIntroBars: STYLE_POLICY_DEFAULTS.bIntroBars,
      maxMs: L.maxExtensionMs,
    },
    keyLift: 'off',
    reasons: [],
  };
}

/** 统一夹值 + 默认说明；所有规则都从这里出门。 */
function finalize(
  policy: StylePolicy,
  a: StyleProfile,
  b: StyleProfile,
  ruleHit: boolean,
): StylePolicy {
  policy.windowScale = round2(clamp(policy.windowScale, L.windowScaleMin, L.windowScaleMax));
  policy.swapShareBias = round2(clamp(policy.swapShareBias, L.swapShareBiasMin, L.swapShareBiasMax));
  policy.duckScale = round2(clamp(policy.duckScale, L.duckScaleMin, L.duckScaleMax));
  policy.reverbSendDb = round1(clamp(policy.reverbSendDb, L.sendDbMin, L.sendDbMax));
  policy.echoSendDb = round1(clamp(policy.echoSendDb, L.sendDbMin, L.sendDbMax));
  policy.eq = {
    aHighDb: round1(clamp(policy.eq.aHighDb, L.eqDbMin, L.eqDbMax)),
    aPresenceDb: round1(clamp(policy.eq.aPresenceDb, L.eqDbMin, L.eqDbMax)),
    aPresenceHz: Math.round(clamp(policy.eq.aPresenceHz, L.presenceHzMin, L.presenceHzMax)),
    bHighDb: round1(clamp(policy.eq.bHighDb, L.eqDbMin, L.eqDbMax)),
    bPresenceDb: round1(clamp(policy.eq.bPresenceDb, L.eqDbMin, L.eqDbMax)),
    bPresenceHz: Math.round(clamp(policy.eq.bPresenceHz, L.presenceHzMin, L.presenceHzMax)),
    bLowDb: round1(clamp(policy.eq.bLowDb, L.eqDbMin, L.eqDbMax)),
  };
  for (const key of Object.keys(policy.techniqueBias)) {
    const value = policy.techniqueBias[key];
    if (typeof value === 'number') policy.techniqueBias[key] = round2(clamp(value, -1, 1));
  }
  policy.extension.aTailBars = Math.round(clamp(policy.extension.aTailBars, 0, L.maxExtensionBars));
  policy.extension.bIntroBars = Math.round(clamp(policy.extension.bIntroBars, 0, L.maxExtensionBars));
  policy.extension.maxMs = L.maxExtensionMs;
  if (!ruleHit) {
    policy.reasons.push(
      `无硬规则命中：${a?.primary ?? '?'}→${b?.primary ?? '?'} 用中性参数（windowScale 1、EQ 平、无送出）`,
    );
  }
  return policy;
}

export function resolveStylePolicy(
  a: StyleProfile,
  b: StyleProfile,
  ctx: {
    keyGap: number;
    bpmGap: number;
    energyGap: number;
    windowMs: number;
    barMs: number;
    aVocal: number;
    bVocal: number;
  },
): StylePolicy {
  const policy = basePolicy();
  const reasons = policy.reasons;
  const safe = ctx ?? ({} as typeof ctx);

  const keyGap = Math.max(0, Math.round(num(safe.keyGap, 0)));
  const bpmGap = Math.abs(num(safe.bpmGap, 0));
  const energyGap = clamp(num(safe.energyGap, 0), 0, 1);
  const lowConfidenceA = !(a?.confidence >= L.lowConfidence);
  const lowConfidenceB = !(b?.confidence >= L.lowConfidence);
  // 规则 3 / 5 的「RMS lowTrim」：能量差越大越压 B 的低频；只切不抬。
  const lowTrimDb = round1(-Math.min(2.5, energyGap * 3));

  reasons.push(
    `上下文：${a?.primary ?? '?'}(${formatConf(a?.confidence)}) → ${b?.primary ?? '?'}(${formatConf(b?.confidence)})，`
    + `keyGap ${keyGap}、BPM 差 ${(bpmGap * 100).toFixed(1)}%、能量差 ${energyGap.toFixed(2)}、`
    + `窗口 ${Math.round(num(safe.windowMs, 0))}ms / 小节 ${Math.round(num(safe.barMs, 0))}ms、`
    + `人声 A ${num(safe.aVocal, 0).toFixed(2)} / B ${num(safe.bVocal, 0).toFixed(2)}`,
  );

  // 规则 6：低置信保守。任何一首不敢确定，就不做风格化处理。
  if (lowConfidenceA || lowConfidenceB) {
    const who: string[] = [];
    if (lowConfidenceA) who.push(`A(${a?.primary ?? '?'} ${formatConf(a?.confidence)})`);
    if (lowConfidenceB) who.push(`B(${b?.primary ?? '?'} ${formatConf(b?.confidence)})`);
    reasons.push(
      `规则 6（保守）：${who.join('、')} confidence<0.45，windowScale=1、swapShareBias=0、EQ 全 0`,
    );
    return finalize(policy, a, b, true);
  }

  // 基础送出：不依赖「曲风对」，任何组合都按单曲风格给一点空间/尾巴。
  if (hasTag(b, ['ballad', 'ambient'])) {
    policy.reverbSendDb = -3;
    reasons.push('B 为 ballad/ambient：混响送出 -3dB，留出尾巴');
  }
  if (hasTag(a, ['punk', 'metal'])) {
    policy.echoSendDb = -6;
    reasons.push('A 为 punk/metal：回声送出 -6dB，收尾不硬切');
  }

  const clash = hasTag(a, ['punk', 'metal']) && hasTag(b, ['ballad', 'ambient']);
  const lift = hasTag(a, ['ballad', 'ambient']) && hasTag(b, ['electronic', 'hiphop']);
  const pump = hasTag(a, ['electronic', 'hiphop']) && hasTag(b, ['electronic', 'hiphop']);
  let ruleHit = false;

  if (clash) {
    ruleHit = true;
    policy.windowScale = 1.25;
    policy.eq.aPresenceDb = -1.5;
    policy.eq.aPresenceHz = 2_500;
    policy.eq.bPresenceDb = 1;
    policy.eq.bPresenceHz = 1_800;
    policy.duckScale = 0.6;
    policy.techniqueBias.cut = -1;
    policy.techniqueBias.slam = -1;
    policy.keyLift = 'bridge-only';
    reasons.push(
      '规则 1：A punk/metal → B ballad/ambient：windowScale 1.25、A 人声 −1.5dB@2.5k、'
      + 'B 人声 +1dB@1.8k、duckScale 0.6、禁 cut/slam、keyLift 仅 bridge',
    );
  } else if (lift) {
    ruleHit = true;
    policy.windowScale = 1.3;
    policy.eq.aHighDb = -1;
    policy.extension.aTailBars = 8;
    policy.extension.bIntroBars = 4;
    policy.eq.bLowDb = -1;
    reasons.push(
      '规则 2：A ballad/ambient → B electronic/hiphop：windowScale 1.3、A 高频 −1dB、'
      + 'A 尾 8 小节、B 前奏 4 小节、B 低频 −1dB',
    );
  } else if (pump) {
    ruleHit = true;
    policy.windowScale = 0.9;
    policy.swapShareBias = 0.1;
    policy.eq.bLowDb = lowTrimDb;
    reasons.push(
      `规则 3：双 electronic/hiphop：windowScale 0.9、swapShareBias +0.1、`
      + `B 低频按 RMS 校准 ${lowTrimDb}dB`,
    );
  }

  // 规则 4：B 是器乐。与 1/2/3 可叠加，B 的人声段补偿覆盖前面写的值。
  if (isInstrumental(b)) {
    ruleHit = true;
    policy.eq.bPresenceDb = 1.5;
    policy.eq.bPresenceHz = 1_200;
    policy.duckScale = Math.min(policy.duckScale, 0.5);
    policy.extension.bIntroBars = Math.max(policy.extension.bIntroBars, 8);
    reasons.push(
      '规则 4：B 为器乐：B 人声段 +1.5dB@1.2k、duckScale 0.5、入口优先 8 小节乐句',
    );
  }

  // 规则 5：同调。EQ 全归零，只保留按能量差算的低频 trim。
  if (keyGap === 0) {
    ruleHit = true;
    policy.eq = {
      aHighDb: 0,
      aPresenceDb: 0,
      aPresenceHz: STYLE_POLICY_DEFAULTS.aPresenceHz,
      bHighDb: 0,
      bPresenceDb: 0,
      bPresenceHz: STYLE_POLICY_DEFAULTS.bPresenceHz,
      bLowDb: lowTrimDb,
    };
    reasons.push(`规则 5：同调（keyGap 0），EQ 全 0，只保留 RMS lowTrim ${lowTrimDb}dB`);
  }

  // 规则 7：BPM 差大时窗口不许再放大，否则变速段太长。
  if (bpmGap > L.bpmGapThreshold && policy.windowScale > L.windowCapOnBpmGap) {
    const before = policy.windowScale;
    policy.windowScale = L.windowCapOnBpmGap;
    reasons.push(
      `规则 7：BPM 差 ${(bpmGap * 100).toFixed(1)}% > 12%，windowScale 从 ${before} 压到 1.15`,
    );
  }

  return finalize(policy, a, b, ruleHit);
}
