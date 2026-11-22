/**
 * 人声叠加（`acapellaOverlay`）的零分轨降级实现。
 *
 * 真正的 acapella overlay 要「A 只留人声 + B 只留伴奏」，那是源分离的活 —— 而本项目
 * 已经明确废弃 4 轨实时分离（分离有损、SDR ≈ 9 dB、播放期变调）。零分轨能做的近似是：
 *
 * 1. A 的咬字/清晰度频段（1.5–4 kHz）在过渡后段抬 2–4 dB —— 让最后一句「浮」出来；
 * 2. B 在 A 还在唱的时候把人声让位压 2–6 dB —— 两句不打架；
 * 3. 强调在窗口末回落，避免 B 已独唱时 A 的残影还亮着。
 *
 * 听感目标是「A 的最后一句浮在 B 的伴奏上」，不是「两个 acapella 叠在一起」——
 * 后者在零分轨下只能靠运气，不如老实做前者。
 */

export interface VocalOverlayInput {
  /** A 的人声密度（0..1，`activity.vocal` 的段落均值）。 */
  aVocal: number;
  /** B 的人声密度。 */
  bVocal: number;
  /** Camelot 距离，越远越不敢把两句叠一起。 */
  keyGap?: number;
  /** 窗口长度，短窗没空间「浮起来」。 */
  fadeMs?: number;
}

export interface VocalOverlayPlan {
  enabled: boolean;
  /** A 中频强调（dB，0..4）。 */
  aBoostDb: number;
  /** B 人声让位（dB，−6..0）。 */
  bDuckDb: number;
  /** A 的强调从窗口哪个位置开始爬（0..1）。 */
  fromP: number;
  /** 强调在窗口哪个位置开始回落（0..1）。 */
  releaseP: number;
  note: string;
}

/** A 至少要有人声可「浮」；太轻的段落抬 3 dB 只会抬出底噪。 */
export const OVERLAY_MIN_A_VOCAL = 0.34;
/** B 的人声太轻时不需要让位（没有冲突）。 */
export const OVERLAY_BUSY_B_VOCAL = 0.3;
export const OVERLAY_KEY_GAP_LIMIT = 5;
/** 短窗（< 6 s）没有「先铺垫再浮起」的空间。 */
export const OVERLAY_SHORT_MS = 6_000;

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
}

function half(v: number): number {
  return Math.round(v * 2) / 2;
}

export function planVocalOverlay(input: VocalOverlayInput): VocalOverlayPlan {
  const aVocal = clamp(input.aVocal ?? 0, 0, 1);
  const bVocal = clamp(input.bVocal ?? 0, 0, 1);
  const keyGap = clamp(input.keyGap ?? 0, 0, 6);
  const fadeMs = clamp(input.fadeMs ?? 8_000, 0, 40_000);

  if (aVocal < OVERLAY_MIN_A_VOCAL) {
    return {
      enabled: false,
      aBoostDb: 0,
      bDuckDb: 0,
      fromP: 1,
      releaseP: 1,
      note: `A 的人声密度 ${aVocal.toFixed(2)} 太低，没有「最后一句」可浮`,
    };
  }
  if (keyGap >= OVERLAY_KEY_GAP_LIMIT) {
    return {
      enabled: false,
      aBoostDb: 0,
      bDuckDb: 0,
      fromP: 1,
      releaseP: 1,
      note: `调性差 ${keyGap}，两句叠一起会打架，改用换手`,
    };
  }

  const short = fadeMs < OVERLAY_SHORT_MS;
  const rawBoost = 1.5 + aVocal * 2.5 - keyGap * 0.25;
  // 抬 A 的人声只是「让它不被 B 盖住」，不是把它推上去：上限从 4 dB 收到 2 dB。
  const aBoostDb = half(clamp(short ? Math.min(1.5, rawBoost) : rawBoost, 0, 2));
  const bDuckDb = bVocal >= OVERLAY_BUSY_B_VOCAL ? -Math.round(clamp(2 + bVocal * 4, 2, 6)) : 0;
  const fromP = short ? 0.5 : 0.3;
  const releaseP = 0.94;

  return {
    enabled: true,
    aBoostDb,
    bDuckDb,
    fromP,
    releaseP,
    note: `A 中频 +${aBoostDb.toFixed(1)}dB 浮出最后一句`
      + (bDuckDb < 0 ? `，B 人声让 ${bDuckDb}dB` : '，B 人声本来就轻，不让位'),
  };
}
