/**
 * 拍点锁相环（PLL）：让 B 的播放速率跟着 A（或主时钟）走，做到「听起来永远是同一拍」。
 *
 * 为什么不用 `playbackRate = bpmA / bpmB` 一算了事：
 * - 两台 deck 的时钟起点不同，理论上会累积相位误差；
 * - 真 DJ 会持续微调，听感上是「贴着走」，不是「算出来一个常数」。
 *
 * 这里只做纯计算，执行层（`stemGraph` / `crossfadeDeck`）每拍调用一次 `nextRate()`，
 * 把返回值写回 `element.playbackRate`。所有函数都是纯函数，可离线断言。
 */

export interface PllState {
  /** 当前速率（1 = 原速）。 */
  rate: number;
}

export interface PllOptions {
  /** 比例增益，默认 0.08（越大跟得越紧，越容易抖）。 */
  kp?: number;
  /** 速率上下限，默认 ±2%。 */
  maxDeviation?: number;
  /** 单次最大修正量，默认 0.004，避免 audible zipper。 */
  maxStep?: number;
}

/** 把相位误差折算到 [-0.5, 0.5) 拍，处理跨拍回绕。 */
export function wrapBeatError(errorBeats: number): number {
  if (!Number.isFinite(errorBeats)) return 0;
  const wrapped = errorBeats - Math.round(errorBeats);
  // -0.5 归到 +0.5，保证区间半开，避免边界抖动。
  return wrapped === -0.5 ? 0.5 : wrapped;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 下一拍的速率。
 *
 * @param state      当前状态（只有 rate）
 * @param expectedMs 期望这一拍落下的绝对时间（ms）
 * @param nowMs      实际时间（ms）
 * @param beatMs     一拍多少 ms
 */
export function nextRate(state: PllState, expectedMs: number, nowMs: number, beatMs: number, options: PllOptions = {}): PllState {
  const kp = options.kp ?? 0.08;
  const maxDev = options.maxDeviation ?? 0.02;
  const maxStep = options.maxStep ?? 0.004;

  if (!(beatMs > 0) || !Number.isFinite(expectedMs) || !Number.isFinite(nowMs)) {
    return { rate: clamp(state.rate, 1 - maxDev, 1 + maxDev) };
  }

  // 早到（now < expected）→ 误差为负 → 应该加速？不：早到说明我们落后于期望，
  // 需要「等一等」→ 减速。这里的符号约定：err > 0 表示我们晚了，需要加速。
  const err = wrapBeatError((nowMs - expectedMs) / beatMs);
  const delta = clamp(kp * err, -maxStep, maxStep);
  const rate = clamp(state.rate + delta, 1 - maxDev, 1 + maxDev);
  return { rate: Number(rate.toFixed(6)) };
}

/** 冷启动：直接按两首 BPM 算初始速率（折叠到最接近 1 的那一档）。 */
export function initialRate(bpmA: number, bpmB: number, options: PllOptions = {}): number {
  const maxDev = options.maxDeviation ?? 0.02;
  if (!(bpmA > 0) || !(bpmB > 0)) return 1;
  const raw = bpmB / bpmA;
  const folded = 2 ** (Math.log2(raw) - Math.round(Math.log2(raw)));
  return Number(clamp(folded, 1 - maxDev, 1 + maxDev).toFixed(6));
}

/**
 * 拍内偏移（sub-beat offset）：用低频包络互相关找 kick 的精确位置，
 * 返回 [-halfBeat, halfBeat] 内的 ms 修正量。
 * 纯函数版本只做「已知两串 kick 时间戳」的对齐；真正的包络提取在宿主侧。
 */
export function subBeatOffsetMs(kickA: number[], kickB: number[], beatMs: number): number {
  if (!kickA.length || !kickB.length) return 0;
  const b0 = kickB[0];
  let best = 0, bestDist = Infinity;
  for (const a of kickA) {
    // 只比较同一拍格内的候选，避免跨拍误配。
    // 符号约定：返回值 = 把 B 平移多少 ms 才与 A 对齐（B 晚到 → 正数）。
    const d = wrapBeatError((b0 - a) / beatMs) * beatMs;
    if (Math.abs(d) < bestDist) { bestDist = Math.abs(d); best = d; }
  }
  const half = beatMs / 2;
  return Number(clamp(best, -half, half).toFixed(3));
}

export interface TrackOptions extends PllOptions {
  /** 中心速率（默认 1）：真正要维持的播放速率，修正量围绕它浮动。 */
  center?: number;
  /**
   * 相位误差到速率的换算增益（默认 0.3）。
   *
   * 为什么不是「累加式 P 控制」：`rate` 本身是相位的一阶积分，再让它按误差累加，
   * 闭环就是双积分器（特征根 |1+i√kp| > 1），会以 ~20 拍为周期越抖越大。
   * 这里改成「按误差直接算目标速率 + 单步限幅」，相位误差单调收敛，不会来回摆。
   */
  gain?: number;
}

/**
 * 「贴着走」的速率修正：中心速率不变，只围绕它微调。
 *
 * 与 `nextRate()` 的区别：`nextRate()` 假设目标速率是 1（deck 同步场景），
 * 而过渡时 B 的中心速率可能是 1.05（128↔134 的换算），把 1 当中心会把它拽回原速。
 *
 * @param state      当前状态（rate = 上一步真正写进 element.playbackRate 的值）
 * @param errorBeats B 相对 A 的拍相位差，单位「拍」；**正数 = B 超前**（要减速）
 * @param options    center = 中心速率；maxDeviation = 相对中心的允许浮动；maxStep = 单步上限
 */
export function trackRate(state: PllState, errorBeats: number, options: TrackOptions = {}): PllState {
  const maxDev = options.maxDeviation ?? 0.01;
  const maxStep = options.maxStep ?? 0.002;
  const centerRaw = options.center;
  const center = typeof centerRaw === 'number' && Number.isFinite(centerRaw) && centerRaw > 0 ? centerRaw : 1;

  if (!Number.isFinite(errorBeats)) return { rate: Number(center.toFixed(6)) };

  const err = wrapBeatError(errorBeats);
  // B 超前（err > 0）→ 目标速率低于中心；落后则高于中心。按误差直接算目标，不做累加。
  const gain = options.gain ?? 0.3;
  const target = center * (1 - gain * err);
  // 单步限幅：避免一次写进 audible 的跳变（zipper），但只限「这一步能走多远」，不改变收敛目标。
  const stepped = clamp(target, state.rate - maxStep, state.rate + maxStep);
  const rate = clamp(stepped, center * (1 - maxDev), center * (1 + maxDev));
  return { rate: Number(rate.toFixed(6)) };
}
