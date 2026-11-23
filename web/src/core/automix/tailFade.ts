/**
 * 尾段渐隐（母带 fade-out）识别与「补回」曲线。
 *
 * 问题：很多歌的最后 10–20 秒是母带渐隐，音量一路掉到 −40 LUFS 以下。过渡如果落在
 * 这一段，等于拿「快没气的那几秒」去接下一首 —— 听感上是 A 突然变虚、B 一进来就炸。
 *
 * 做法：从 momentary loudness 曲线里认出「单调下降的那一段」，算出「把这段补回渐隐前
 * 电平」需要多少 dB（`liftDb`），交给音频图在过渡期间按曲线抬回来。
 *
 * 三条克制：
 * 1. 只在**确认**是渐隐时才动：下降幅度 ≥ 6 dB、持续 ≥ 4 s、且大部分采样点确实在降。
 * 2. 提升上限 12 dB，且不允许把瞬时电平抬过 −1 LUFS（防削波）。
 * 3. 只补「渐隐段」，渐隐开始之前的原始动态一点不动 —— 那是音乐本身。
 */

import type { BeatAnalysis } from '../../online/analysis';

/** 补回曲线上的一个点：文件毫秒 → 该位置要抬多少 dB（≥ 0）。 */
export interface TailFadePoint {
  ms: number;
  liftDb: number;
}

export interface TailFadeInfo {
  /** 渐隐开始（文件毫秒） */
  fadeStartMs: number;
  /** 渐隐结束（一般≈可听结尾） */
  fadeEndMs: number;
  /** 渐隐前参考电平（LUFS，取渐隐前 6 秒的能量均值） */
  refLufs: number;
  /** 渐隐末电平（LUFS） */
  endLufs: number;
  /** 掉了多少 dB（正数） */
  dropDb: number;
  /** 补回曲线（已含削波保护） */
  points: TailFadePoint[];
  /** 最大提升量（dB） */
  maxLiftDb: number;
}

const WINDOW_MS = 30_000;
const MIN_DROP_DB = 5;
const MIN_FADE_MS = 2_500;
const MAX_LIFT_DB = 15;
const LOUDNESS_FLOOR = -50;
/** 补回后允许达到的最高瞬时电平：留 1 LU 余量，避免把渐隐尾音抬成削波。 */
const TARGET_CEILING_LUFS = -1;

/** 取 [at, at+span] 的能量平均电平（LUFS）；样本不足返回 null。 */
function regionLufs(times: number[], levels: number[], at: number, span: number): number | null {
  let energy = 0;
  let count = 0;
  const end = at + span;
  for (let i = 0; i < times.length; i++) {
    const level = levels[i];
    if (times[i] < at || times[i] > end) continue;
    if (!Number.isFinite(level) || level < LOUDNESS_FLOOR) continue;
    energy += 10 ** (level / 10);
    count++;
  }
  if (count < 3) return null;
  return 10 * Math.log10(energy / count);
}

/**
 * 识别尾段渐隐。
 *
 * `beforeMs` 传「可听结尾」：只看它之前的 30 秒，避免把曲尾静音算成渐隐。
 * 返回 null 表示「没有可确认的渐隐」——此时调用方完全不介入，行为与现在一致。
 */
export function detectTailFade(
  analysis: BeatAnalysis,
  beforeMs?: number,
  options: { barMs?: number } = {},
): TailFadeInfo | null {
  if (analysis?.loudnessMethod !== 'bs1770') return null;
  const times = analysis.loudnessTimesMs ?? [];
  const levels = analysis.momentaryLufs ?? [];
  if (times.length < 12 || times.length !== levels.length) return null;

  const endMs = Number.isFinite(beforeMs) ? Number(beforeMs) : (analysis.audibleEndMs ?? 0);
  if (!(endMs > 0)) return null;
  const startMs = Math.max(0, endMs - WINDOW_MS);

  // 窗口内的采样点（保持时间顺序）
  const idx: number[] = [];
  for (let i = 0; i < times.length; i++) {
    if (times[i] < startMs || times[i] > endMs) continue;
    if (!Number.isFinite(levels[i])) continue;
    idx.push(i);
  }
  if (idx.length < 10) return null;

  // 用「局部斜率」定位渐隐起点，而不是「从后往前找非递增后缀」。
  //
  // 老实现把整段「大致在降」的区间都算进渐隐：Skydive 这类曲子在第 164 秒有一次
  // 音乐性的弱下去（−3 → −6 dB），到第 184.7 秒才是真正的母带淡出。按后缀扫，
  // 起点会被定到 164 秒，于是「剔除渐隐段」想切在 164 却切在末句之前，
  // 被末句守卫挡掉 —— 用户听到的就是「渐隐根本没被排除」。
  //
  // 做法：以 500 ms 为前瞻算每格掉多少 dB，取全程最大局部跌幅的 25%（下限 0.4 dB）
  // 当阈值，从结尾往回走「连续够陡」的那一段。慢速渐隐（0.875 dB/500 ms）与
  // 陡峭淡出（数 dB/500 ms）都能自适应，音乐起伏的缓降不会入选。
  const stepMs = Math.max(1, Math.round((times[idx[1]] ?? times[idx[0]] + 1) - times[idx[0]]));
  const span = Math.max(2, Math.round(500 / stepMs));
  const localDrop: number[] = idx.map((_, i) => (i + span < idx.length
    ? levels[idx[i]] - levels[idx[i + span]] : Number.NaN));
  let peakDrop = 0;
  for (const drop of localDrop) if (Number.isFinite(drop) && drop > peakDrop) peakDrop = drop;
  if (!(peakDrop >= 0.15)) return null;
  // 下限 0.2 dB/500 ms：慢速母带渐隐每 500 ms 只掉 0.87 dB，别被绝对阈值掐掉。
  const slopeFloor = Math.max(0.2, peakDrop * 0.25);
  // 从「最后一个能算斜率的格子」往回走，停在斜率第一次不够陡的地方 —— 那才是渐隐开始。
  let head = Math.max(0, localDrop.length - 1 - span);
  while (head > 0 && Number.isFinite(localDrop[head - 1]) && localDrop[head - 1] >= slopeFloor) head--;
  const fadeSamples = idx.slice(head);
  if (fadeSamples.length < 6) return null;

  const fadeStartMs = times[fadeSamples[0]];
  const fadeEndMs = times[fadeSamples[fadeSamples.length - 1]];
  // 段长必须够「渐隐」而不是「最后一下收尾」；这条要在修剪之后判，修剪会把平坦的头削掉。
  if (!(fadeEndMs - fadeStartMs >= MIN_FADE_MS)) return null;

  // 参考电平取「渐隐开始前**一小节**」：用户要的是「用往前一个节的音量」当基准。
  // 取 6 秒会把渐隐之前那段本来就在收的音乐起伏也算进来，基准偏低、补得不够。
  const refSpanMs = Math.max(1_500, Math.min(8_000, Math.round(options.barMs ?? 6_000)));
  const ref = regionLufs(times, levels, Math.max(0, fadeStartMs - refSpanMs), refSpanMs)
    ?? Math.max(...fadeSamples.map((i) => levels[i]));
  const end = regionLufs(times, levels, Math.max(fadeStartMs, fadeEndMs - 2_000), 2_000)
    ?? levels[fadeSamples[fadeSamples.length - 1]];
  if (!Number.isFinite(ref) || !Number.isFinite(end)) return null;
  const dropDb = ref - end;
  if (!(dropDb >= MIN_DROP_DB)) return null;

  const points: TailFadePoint[] = [];
  let maxLiftDb = 0;
  for (const i of fadeSamples) {
    const level = levels[i];
    if (!Number.isFinite(level) || level < LOUDNESS_FLOOR) continue;
    // 1) 补回到参考电平；2) 不超过 12 dB；3) 抬完不超过 ceiling
    const lift = Math.max(0, Math.min(MAX_LIFT_DB, ref - level, TARGET_CEILING_LUFS - level));
    if (lift <= 0.1) continue;
    maxLiftDb = Math.max(maxLiftDb, lift);
    points.push({ ms: Math.round(times[i]), liftDb: Math.round(lift * 100) / 100 });
  }
  if (points.length < 3 || maxLiftDb < 3) return null;
  // 缓速补偿：逐点 3 点均值柔化，避免「一两格突然多抬 6 dB」的台阶。
  for (let i = 1; i < points.length - 1; i += 1) {
    points[i].liftDb = Math.round(((points[i - 1].liftDb + points[i].liftDb * 2 + points[i + 1].liftDb) / 4) * 100) / 100;
  }

  return {
    fadeStartMs: Math.round(fadeStartMs),
    fadeEndMs: Math.round(fadeEndMs),
    refLufs: Math.round(ref * 10) / 10,
    endLufs: Math.round(end * 10) / 10,
    dropDb: Math.round(dropDb * 10) / 10,
    points,
    maxLiftDb: Math.round(maxLiftDb * 10) / 10,
  };
}

/** 在补回曲线上按文件毫秒线性插值；超出两端时取端点（曲线外恒 0）。 */
export function liftAt(points: TailFadePoint[], ms: number): number {
  if (!points.length || !Number.isFinite(ms)) return 0;
  if (ms <= points[0].ms) return points[0].liftDb;
  const last = points[points.length - 1];
  if (ms >= last.ms) return last.liftDb;
  for (let i = 1; i < points.length; i++) {
    if (points[i].ms < ms) continue;
    const prev = points[i - 1];
    const span = points[i].ms - prev.ms;
    if (!(span > 0)) return points[i].liftDb;
    const t = (ms - prev.ms) / span;
    return prev.liftDb + (points[i].liftDb - prev.liftDb) * t;
  }
  return last.liftDb;
}

/** 把补回曲线裁到过渡窗口内（并把时间平移到「相对淡化起点」），给音频图排程用。 */
export function clipLift(points: TailFadePoint[], fromMs: number, toMs: number): TailFadePoint[] {
  if (!points.length || !(toMs > fromMs)) return [];
  const out: TailFadePoint[] = [];
  // 起点先给 0、250 ms 后再到应有值：避免渐隐一开始就整段抬 6 dB 的台阶感。
  const startLift = liftAt(points, fromMs);
  out.push({ ms: fromMs, liftDb: 0 });
  out.push({ ms: Math.min(toMs, fromMs + 250), liftDb: Math.round(startLift * 100) / 100 });
  for (const point of points) {
    if (point.ms <= fromMs || point.ms >= toMs) continue;
    out.push(point);
  }
  out.push({ ms: toMs, liftDb: Math.round(liftAt(points, toMs) * 100) / 100 });
  return out.filter((point, i) => i === 0 || point.liftDb !== out[i - 1].liftDb || i === out.length - 1);
}
