/**
 * 旋律相似度锚点（p1-1）。
 *
 * 问题：`vocalAnchor.ts` 只能回答"这一首哪里在唱"，回答不了"B 的哪一句**旋律上**最像 A 的尾段"。
 * 结果就是：A 尾段是一条下行的弦乐，B 却从一句上行的副歌切进来，即使拍对齐了也"接不住"。
 *
 * 数据来源：宿主 p1-1 的逐小节 chroma（12 音级，每小节已归一到单位长度）。
 * 归一化之后余弦相似度 = 点积，可以拿来比较两段旋律的"音级分布形状"——
 * 不需要跑任何模型，也不涉及源分离：chroma 是 STFT 幅度谱按音级折叠的结果。
 *
 * 这里只做纯计算，不碰 DOM / AudioContext，方便单测。
 */

const BINS = 12;

/** 比较窗口：4 小节（一个乐句）。再短就分不清"同一动机"和"碰巧同调"。 */
export const MELODY_WINDOW_BARS = 4;

/** 低于这个相似度认为"不像"，宁可退回首句也不硬凑。 */
export const MELODY_MIN_SIM = 0.62;

/** 候选之间相似度差在这个范围内时，选更早的那一句（不要为了 0.01 的相似度跳到 1 分钟后）。 */
export const MELODY_TIE_EPS = 0.03;

/** 每往后一首歌的第 N 个候选，扣一点点分，避免总是挑到很后面。 */
export const MELODY_INDEX_PENALTY = 0.02;

export interface BarChromaSource {
  barChromaMs?: number[];
  barChroma?: number[];
}

export interface MelodyMatch {
  entryMs: number;
  /** 0~1 的余弦相似度（未扣索引惩罚）。 */
  sim: number;
  /** 参与比较的有效小节数。 */
  bars: number;
  /** 候选在输入里是第几个（0 起）。 */
  index: number;
}

function binCount(source: BarChromaSource | null | undefined): number {
  if (!source || !Array.isArray(source.barChromaMs) || !Array.isArray(source.barChroma)) return 0;
  if (source.barChroma.length !== source.barChromaMs.length * BINS) return 0;
  return source.barChromaMs.length;
}

export function melodyBarCount(source: BarChromaSource | null | undefined): number {
  return binCount(source);
}

/** 取第 `bar` 小节的 12 维 chroma（已归一化）；越界返回 null。 */
export function barChromaAt(source: BarChromaSource | null | undefined, bar: number): number[] | null {
  const count = binCount(source);
  if (count === 0 || !Number.isInteger(bar) || bar < 0 || bar >= count) return null;
  const flat = source!.barChroma!;
  const out: number[] = [];
  for (let bin = 0; bin < BINS; bin += 1) out.push(flat[bar * BINS + bin]);
  return out;
}

/** 起点不晚于 `fileMs` 的最后一小节下标；早于第一小节返回 0，没有数据返回 -1。 */
export function barIndexNear(source: BarChromaSource | null | undefined, fileMs: number): number {
  const count = binCount(source);
  if (count === 0 || !Number.isFinite(fileMs)) return -1;
  const times = source!.barChromaMs!;
  let lo = 0;
  let hi = count - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= fileMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best < 0 ? 0 : best;
}

/**
 * 从 `fromMs` 起取 `bars` 小节的 chroma 均值，再归一到单位长度。
 * 返回值可以与另一段直接点积得到余弦相似度。
 */
export function melodyProfile(
  source: BarChromaSource | null | undefined,
  fromMs: number,
  bars: number,
): number[] | null {
  const count = binCount(source);
  if (count === 0 || !Number.isFinite(fromMs)) return null;
  const start = barIndexNear(source, fromMs);
  if (start < 0) return null;
  const want = Math.max(1, Math.min(Math.round(bars), 16));
  const sum = new Array<number>(BINS).fill(0);
  let used = 0;
  for (let i = start; i < count && used < want; i += 1) {
    const row = barChromaAt(source, i);
    if (!row) continue;
    for (let bin = 0; bin < BINS; bin += 1) sum[bin] += row[bin];
    used += 1;
  }
  if (used === 0) return null;
  let norm = 0;
  for (let bin = 0; bin < BINS; bin += 1) {
    sum[bin] /= used;
    norm += sum[bin] * sum[bin];
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-9) return null;
  for (let bin = 0; bin < BINS; bin += 1) sum[bin] /= norm;
  return sum;
}

export function cosineSimilarity(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== BINS || b.length !== BINS) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < BINS; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na * nb);
  return denom > 1e-9 ? Math.max(-1, Math.min(1, dot / denom)) : 0;
}

export interface MelodyAnchorInput {
  /** A 侧分析（提供尾段旋律）。 */
  a: BarChromaSource | null | undefined;
  /** B 侧分析（提供候选入口的旋律）。 */
  b: BarChromaSource | null | undefined;
  /** 候选入口（文件毫秒），通常是 B 的各个唱句起点。 */
  entries: number[];
  /** A 的尾段终点（通常是可听结尾）。 */
  aEndMs: number;
  windowBars?: number;
  minSim?: number;
  indexPenalty?: number;
}

/**
 * 给 B 的每个候选入口打"与 A 尾段旋律有多像"的分，按"相似度 − 索引惩罚"从高到低排。
 * 相似度不足 `minSim` 的候选仍然返回（调用方自己决定要不要用），但 `pickMelodyEntry` 会丢掉。
 */
export function rankEntriesByMelody(input: MelodyAnchorInput): MelodyMatch[] {
  const windowBars = input.windowBars ?? MELODY_WINDOW_BARS;
  const penalty = input.indexPenalty ?? MELODY_INDEX_PENALTY;
  const tail = melodyProfile(input.a, input.aEndMs, windowBars);
  if (!tail) return [];
  const seen = new Set<number>();
  const out: MelodyMatch[] = [];
  input.entries.forEach((entryMs, index) => {
    if (!Number.isFinite(entryMs) || entryMs < 0) return;
    const key = Math.round(entryMs);
    if (seen.has(key)) return;
    seen.add(key);
    const profile = melodyProfile(input.b, entryMs, windowBars);
    if (!profile) return;
    const sim = cosineSimilarity(tail, profile);
    out.push({ entryMs: key, sim, bars: Math.min(windowBars, melodyBarCount(input.b)), index });
  });
  out.sort((left, right) => (right.sim - penalty * right.index) - (left.sim - penalty * left.index));
  return out;
}

/**
 * 挑出旋律上最接得住 A 尾段的那一句。
 * 规则：
 * 1. 最佳相似度低于 `minSim` → 返回 null（调用方退回首句/默认选点）；
 * 2. 与最佳相差 ≤ `MELODY_TIE_EPS` 的候选里取**最早**的一句（不要为了小数点后两位跳很远）。
 */
export function pickMelodyEntry(input: MelodyAnchorInput): MelodyMatch | null {
  const ranked = rankEntriesByMelody(input);
  if (ranked.length === 0) return null;
  const best = ranked[0];
  if (best.sim < (input.minSim ?? MELODY_MIN_SIM)) return null;
  const tied = ranked.filter((item) => item.sim >= best.sim - MELODY_TIE_EPS);
  tied.sort((left, right) => left.entryMs - right.entryMs);
  return tied[0];
}
