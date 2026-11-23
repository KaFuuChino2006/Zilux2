/**
 * 进阶混音 v2：过渡曲线规划（纯函数，零 DOM / 零 AudioParam）。
 *
 * 与标准路径的关系：**完全隔离**。标准路径（`web/src/ui/transitionMath.ts` 的
 * `naturalGains`）是整轨等功率交叉，冻结不动；这里的曲线只在
 * `readMixTransitionMode() === 'automixV2'` 时被 `crossfadeDeck` 取用。
 *
 * 为什么低频不能和整轨一样用等功率：
 * 两首舞曲的底鼓/贝斯在 60–120 Hz 高度相关，相关信号等功率叠加在交叠中点会 +3 dB
 * （实测整轨波动 4.1 dB，逐轨 1.4 dB）。DJ 的做法是「低频换手」——同一时刻只有一首
 * 歌持有低频，且两条低频增益之和恒为 1（线性交叉，功率和 ≤ 0 dB，中点 −3 dB），
 * 听感上低频总量不变、不会糊。
 *
 * 高频（>120 Hz）两首不相关，仍用等功率 cos/sin，保证响度恒定。
 *
 * 横轴一律用「小节进度」而不是「时间进度」：变速对齐后 A 的墙钟时间和 B 的曲内时间
 * 不再等比，按小节推进才能保证换手点落在拍上（20 s 过渡里 1 拍 ≈ 5% 进度，按时间
 * 推进会把换手点推到反拍上）。
 */

/** 分频点：低于它算「低频」，做线性换手；高于它做等功率交叉。 */
export const V2_CROSSOVER_HZ = 120;

/** A 侧扫频终点的低通截止（Hz）：再低会把 A 的低频也一起抽走，和换手打架。 */
export const V2_A_SWEEP_LP_MIN_HZ = 700;

/** B 侧扫频起点的低通截止（Hz）：B 一开始只露高频，像从隔壁房间推进来。 */
export const V2_B_SWEEP_HP_MAX_HZ = 12000;

/** 曲线采样步长（进度 0–1）。100 点足够让 AudioParam 排出听不出台阶的斜坡。 */
/** B 进场起始电平（dB）：-18 dB ≈ 从走廊尽头传进来。 */
export const V2_B_ENTRY_FROM_DB = -18;
/** 紧凑换手时 B 在「换手前」的电平：−60 dB ≈ 只有一点空气感，听不出第二首歌。 */
export const V2_B_GHOST_DB = -60;
/** 到这个进度（占整条过渡）B 已经到 0 dB，之后保持满音量等唱词。 */
export const V2_B_ENTRY_END_P = 0.9;

export const V2_CURVE_STEP = 0.01;

/** 一条曲线：t = 过渡进度 0–1，v = 增益（0–1）或频率（Hz）。 */
export interface V2CurvePoint {
  t: number;
  v: number;
}

/** 单侧 deck 的四条曲线。 */
export interface V2DeckCurves {
  /** 中低层增益（120–1200 Hz，乐器主体）：功率互补换手。 */
  mid: V2CurvePoint[];
  /** 低频段增益（线性换手）。 */
  low: V2CurvePoint[];
  /** 高频段增益（等功率交叉）。 */
  high: V2CurvePoint[];
  /** 扫频低通截止（Hz）。 */
  sweepLp: V2CurvePoint[];
  /** 扫频高通截止（Hz）。 */
  sweepHp: V2CurvePoint[];
}

export interface V2PlanInput {
  /**
   * 窗口结束时 A 还留多少高频（0…0.4）。用于「A 尾巴长、当乐器铺在 B 底下」：
   * 曲线不把 A 收到 0，而是收在这个电平上，窗口结束后再由 tailBleed 收干。
   */
  aTailHold?: number;
  /** 30–50% 窗口里 B 低频抬到的目标（0.5–0.7，默认 0.62） */
  bassTarget?: number;
  /** 同一窗口里 A 低频保留到多少（0.55–0.65，默认 0.60） */
  aLowKeep?: number;
  /** 人声/中高频的交换点（整段进度，0.65–0.90，默认 0.80）；上层按强拍微调 */
  vocalAt?: number;
  /** B 中频（乐器主体）的入口，默认 0.58；越大 B 的乐器进来得越晚 */
  midAt?: number;
  /** 过渡总时长（毫秒）。 */
  fadeMs: number;
  /** 一小节多少毫秒（A 侧，已含变速）。 */
  barMs: number;
  /** 低频换手占几个小节（默认 2：第 1 小节开始换，第 3 小节前完成）。 */
  lowHandoffBars?: number;
  /** A 的低通扫频从第几成进度开始（默认 0.55：前一半留给「两首都亮」的段落）。 */
  /**
   * 低频换手窗口的中心（0–1 的过渡进度）。默认 0.45。
   * 上层会把「A 的末句唱完」的位置传进来，保证低频不会在 A 还在唱的时候被抽走。
   */
  handoffCenterP?: number;
  /**
   * 低频换手的**起点**（0–1）。优先级高于 `handoffCenterP`：上层直接把
   * 「A 末句唱完」的进度传进来，窗口就从这个点往后铺一个 span，绝不在 A 还在唱时抽低频。
   */
  handoffStartP?: number;
  /**
   * A 的全频保持点（0–1）：这段之内 A 的音量不衰减（只让 B 从 >8 kHz 的缝隙里垫进来），
   * 用来兑现「B 穿插进来时 A 还在唱自己的末句」。默认 0 = 从窗口开头就等功率淡出。
   */
  aHoldP?: number;
  /** A 低通收到的最低频率（默认 700 Hz）。Apple 配方里风格 8 会压到 200 Hz。 */
  lpMinHz?: number;
  /** B 高通的起始频率（默认 12 kHz）。Apple 风格 16 从 5.2 kHz 起。 */
  bHpStartHz?: number;
  sweepStartP?: number;
  /** A 的扫频到第几成进度停止下压（默认 1）。 */
  sweepEndP?: number;
  /** B 的高通扫频在第几成进度完全打开（默认 0.5）。 */
  bOpenP?: number;
  /**
   * B 侧「由远及近」进场：用 B 的前奏长度当混音窗口时打开。
   * 整条 B 从 -18 dB 起，到 90% 处到 0 dB——正好在 B 的第一句唱词前把音量拉满。
   */
  bEntry?: boolean;
  /**
   * 紧凑换手：把真正的换手压到最后这一段（占整条过渡的比例，0.06–0.9）。
   * 0 / 未传 = 老行为（中段换手，整条都在互相渗透）。
   */
  swapShare?: number;
  /**
   * 是否做扫频（默认 true）。`fade` 形态把它关掉：A 不压低通、B 很快全频，
   * 只保留低频换手 —— 短过渡里扫频听起来像"水下"，反而暴露处理痕迹。
   */
  sweep?: boolean;
  /** 手法声明的扫频占比（0 = 不扫，1 = 从换手中段就开始扫）。 */
  sweepShare?: number;
  /** 本次 B 的变速比例（仅用于报告，不参与曲线形状）。 */
  rate?: number;
  /**
   * 风格窗口缩放（0.8–1.4，默认 1）。
   * 只缩放本计划内部使用的窗口时长，从而改变 `totalBars` / `handoffP` 的口径；
   * 曲线按进度归一化，形状不因此改变。默认 1 时输出与未加此参数逐位一致。
   */
  windowScale?: number;
  /**
   * 风格换手占比偏置（−0.15–0.15，默认 0）：直接加到 `swapShare` 上。
   * 只影响紧凑换手的起点，不改变未传时的既有行为。
   */
  swapShareBias?: number;
  /** 低频层换手起点（0.5–0.9，默认 0.66）：两侧低频律动越不相关，越晚开始重叠，减少抵消。 */
  lowStartP?: number;
  /**
   * 风格化 duck 缩放（默认不加此键）：仅随计划透传给上层 duck 排程，
   * 不参与曲线计算；不传时 `V2Plan` 对象与旧版完全一致。
   */
  duckScale?: number;
}

export interface V2Plan {
  /** 过渡跨了几个小节（至少 2）。 */
  totalBars: number;
  /** 低频换手完成的进度点（0–1）。 */
  handoffP: number;
  /** 低频换手开始的进度点（0–1）：B 的中高频先起来，低频后交。 */
  handoffStartP: number;
  /** A 侧曲线。 */
  a: V2DeckCurves;
  /** B 侧曲线。 */
  b: V2DeckCurves;
  /** 采样步长。 */
  step: number;
  /** 人读的一句话（写进调试面板/日志）。 */
  note: string;
  /** A 侧保持原样到哪个进度（层 C 让位前的 hold 段；0 = 不留）。 */
  aHoldP: number;
  /** 紧凑模式下「开始换手」的进度（0 = 没启用紧凑换手）。 */
  swapStartP: number;
  /** 风格化 duck 缩放；只有输入显式给出时才存在此键。 */
  duckScale?: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/** 线性插值采样一条曲线在给定进度的值（曲线是分段线性采样数组）。 */
export function sampleCurve(curve: readonly V2CurvePoint[], t: number): number {
  if (!curve.length) return 0;
  const p = clamp(t, 0, 1);
  const first = curve[0]!;
  const last = curve[curve.length - 1]!;
  if (p <= first.t) return first.v;
  if (p >= last.t) return last.v;
  for (let i = 1; i < curve.length; i += 1) {
    const prev = curve[i - 1]!;
    const next = curve[i]!;
    if (p <= next.t) {
      const span = next.t - prev.t;
      const k = span > 0 ? (p - prev.t) / span : 0;
      return prev.v + (next.v - prev.v) * k;
    }
  }
  return last.v;
}

/**
 * 低频换手增益：A = 1 − p，B = p，p 在 [startP, endP] 窗口内从 0 走到 1。
 *
 * 两条之和恒为 1，功率和 (1−p)² + p² 在 p = 0.5 处取最大值 0.5（−3 dB），
 * 全程 ≤ 0 dB —— 这就是「低频不叠」的数学表述。
 *
 * 窗口**不从 0 开始**：B 刚入场时它的中高频还被压缩着（高通 12 kHz、等功率曲线才起头），
 * 此刻把 B 的 0–120 Hz 直接放到满，会得到「只有低频、没有琴体」的闷响。
 * 所以等 B 的中高频升到约 0.85 再交低频：换手窗口 = [handoffP/2, handoffP]。
 */
export function lowHandoffGain(
  progress: number,
  startP: number,
  endP: number,
): { a: number; b: number } {
  const start = clamp(startP, 0, 0.99);
  const end = clamp(endP, start + 1e-3, 1);
  const p = clamp((progress - start) / (end - start), 0, 1);
  return { a: 1 - p, b: p };
}

/** 高频等功率交叉：A = cos(pπ/2)，B = sin(pπ/2)，平方和恒为 1。 */
export function highEqualPowerGain(progress: number): { a: number; b: number } {
  const p = clamp(progress, 0, 1);
  return { a: Math.cos((p * Math.PI) / 2), b: Math.sin((p * Math.PI) / 2) };
}

/**
 * 对数扫频：from → to，进度 p∈[0,1]。
 *
 * 频率必须按指数走，人耳才听成「匀速下压」；线性走会在前 20% 就塌掉，
 * 听起来是「噗」地一下闷掉而不是「慢慢变远」。
 */
export function logSweep(fromHz: number, toHz: number, p: number): number {
  const k = clamp(p, 0, 1);
  const lo = Math.max(20, Math.min(fromHz, toHz));
  const hi = Math.max(20, Math.max(fromHz, toHz));
  if (hi <= lo) return lo;
  const value = fromHz * Math.pow(toHz / fromHz, k);
  return clamp(value, lo, hi);
}

/**
 * 生成一次过渡的完整曲线计划。
 *
 * 形状（以 8 小节、20 s 为例）：
 *   0–2 小节：低频从 A 线性换到 B（总量不变），两首高频同时在场；
 *   2–5 小节：B 的高通从 12 kHz 一路开到 20 Hz，像从远处走近；
 *   4.4 小节起：A 的低通从 20 kHz 压到 700 Hz，同时 A 高频按等功率继续让位；
 *   末小节：A 只剩 700 Hz 以下的一层薄影，自然消失。
 */
/**
 * B 的进场音量（线性增益）。平滑用 smoothstep，避免 0 dB 处出现折角。
 * `p >= V2_B_ENTRY_END_P` 时恒为 1。
 */
export function bEntryGain(p: number): number {
  const t = Math.max(0, Math.min(1, p / V2_B_ENTRY_END_P));
  const eased = t * t * (3 - 2 * t);
  const from = 10 ** (V2_B_ENTRY_FROM_DB / 20);
  return from + (1 - from) * eased;
}

export function buildV2Plan(input: V2PlanInput): V2Plan {
  const step = V2_CURVE_STEP;
  const barMs = Number.isFinite(input.barMs) && input.barMs > 0 ? input.barMs : 2000;
  const rawFadeMs = Number.isFinite(input.fadeMs) && input.fadeMs > 0 ? input.fadeMs : barMs * 4;
  // 风格窗口缩放：只在显式给出且非 1 时参与运算，保证默认输出逐位不变。
  const windowScale = Number.isFinite(input.windowScale) ? clamp(input.windowScale as number, 0.8, 1.4) : 1;
  const fadeMs = windowScale === 1 ? rawFadeMs : rawFadeMs * windowScale;
  const totalBars = Math.max(2, Math.round(fadeMs / barMs));
  const lowHandoffBars = clamp(input.lowHandoffBars ?? 2, 1, Math.max(1, totalBars - 1));
  const sweepEnabled = input.sweep !== false;
  // B 的「从远处走近」：高通 12 kHz → 20 Hz。必须先开完，低频才交得过去。
  const bOpenP = clamp(input.bOpenP ?? (sweepEnabled ? 0.25 : 0.15), 0.05, 0.6);

  // ---- 紧凑换手----
  // 用户听感：「17 s 过渡里人声、乐器、低音全都在响，很杂」「应该是接近尾端剩几秒
  // 才做完整的换调」。所以长窗前段 A **一点不动**，B 只是极低电平的「幽灵」，
  // 真正的换手压缩到最后 swapShare 这一段里完成。
  const rawSwapShare = Number.isFinite(input.swapShare) ? (input.swapShare as number) : 0;
  const swapShareRaw = Number.isFinite(input.swapShareBias)
    ? clamp(rawSwapShare + (input.swapShareBias as number), 0, 1)
    : rawSwapShare;
  const compact = swapShareRaw > 0 && swapShareRaw <= 1;
  const swapShare = compact ? clamp(swapShareRaw, 0, 1) : 1;
  // 换手从 30% 开始：鼓点/贝斯先换地基，中频 50% 才进 20%，人声 80% 后才交换。
  // 旧值 1-swapShare（默认≈0.5）会让低频换手晚于中频，听感是「人声先过来、地基后到」。
  const swapStartP = compact ? Math.min(1 - swapShare, 0.3) : 0;
  const swapSpan = compact ? Math.max(1e-6, 1 - swapStartP) : 1;
  // bEntry（B 前奏当窗口）要 B 从 -18 dB 就能听见；其余情况只留 -60 dB 幽灵。
  // compact 不能无条件改成 -60 dB：那会让「前奏当窗口」的那条路 80% 的时间里 B 是哑的。

  // 非紧凑模式仍用「中段换手」的老窗口（B 有琴体了再交低频）。
  const span = clamp(lowHandoffBars / totalBars, 0.05, 0.35);
  const explicitStart = input.handoffStartP;
  const rawStart = Number.isFinite(explicitStart)
    ? (explicitStart as number)
    : clamp(input.handoffCenterP ?? 0.45, 0.2, 0.9) - span;
  const legacyStartP = clamp(Math.max(rawStart, bOpenP), 0.02, 0.95 - span);
  const legacyEndP = clamp(legacyStartP + span, legacyStartP + 0.02, 0.97);
  const legacySweepStart = sweepEnabled ? clamp(input.sweepStartP ?? legacyEndP, legacyEndP, 0.95) : 1;
  const legacySweepEnd = sweepEnabled ? clamp(input.sweepEndP ?? 1, legacySweepStart, 1) : 1;

  // 紧凑模式的对外口径：低频换手发生在 swap 段的 10%–60%。
  const handoffStartP = compact ? swapStartP + 0.1 * swapSpan : legacyStartP;
  const handoffP = compact ? swapStartP + 0.6 * swapSpan : legacyEndP;
  const sweepStartP = compact ? handoffP : legacySweepStart;
  // 紧凑模式的 A 扫频在最后 85% 内完成，末尾一定到 700 Hz（由 aLpP 计算）。
  const aHoldP = compact ? swapStartP : clamp(input.aHoldP ?? 0, 0, 0.85);

  const aLow: V2CurvePoint[] = [];
  const bLow: V2CurvePoint[] = [];
  const aMid: V2CurvePoint[] = [];
  const bMid: V2CurvePoint[] = [];
  const aHigh: V2CurvePoint[] = [];
  const bHigh: V2CurvePoint[] = [];
  const aLp: V2CurvePoint[] = [];
  const aHp: V2CurvePoint[] = [];
  const bLp: V2CurvePoint[] = [];
  const bHp: V2CurvePoint[] = [];

  const count = Math.round(1 / step);
  // Apple 配方可以把「A 收到多低 / B 从多高起」写进参数；缺省时保持原来的 700 Hz / 12 kHz。
  const lpMinHz = Number.isFinite(input.lpMinHz) ? Math.max(60, Math.min(20_000, input.lpMinHz as number)) : V2_A_SWEEP_LP_MIN_HZ;
  const bHpStartHz = Number.isFinite(input.bHpStartHz) ? Math.max(20, Math.min(20_000, input.bHpStartHz as number)) : V2_B_SWEEP_HP_MAX_HZ;
  for (let i = 0; i <= count; i += 1) {
    const p = Math.min(1, i * step);
    let aLowV: number;
    let bLowV: number;
    let aMidV: number;
    let bMidV: number;
    let aHighV: number;
    let bHighV: number;
    let aLpP: number;
    let bHpP: number;

    if (compact) {
      // v = 换手段内的进度（0 = 还是 A 的完整结尾，1 = 已经完全换成 B）
      const v = clamp((p - swapStartP) / swapSpan, 0, 1);
      // ---- 三层各自错开换手----
      // 用户要的是「乐器、人声、低音、其他**分开**混进来，各层自己混自己的」，
      // 而不是把整首歌当一个整体在最后 20% 一次性换掉。所以按频段拆三层，
      // 每层有自己的窗口，窗口彼此只交叠一小段：
      //   中低 120–1200 Hz（乐器主体）  0.00 → 0.34
      //   高频 >1200 Hz（人声/镲片）    0.20 → 0.58
      //   低频 ≤120 Hz（贝斯/底鼓）     0.40 → 0.95
      //   （低频收得比别层晚、也比别层长：B 到顶那一刻 A 的贝斯还在，
      //     两把贝斯重叠一小段再交给 B，听感是「混出来」而不是「被切走」）
      // 听感顺序：先听出"伴奏换了"，再听出"人声过来了"，最后低音才换地基。
      // 顺序要**严格排开**：任意时刻只有一层在换。
      // 原来的 0–0.34 / 0.20–0.58 / 0.40–0.95 三层互相压着，换手段里同时有三层各半，
      // 听感就是「太乱」。现在中低换完才换高频，高频换完才换低频。
      // ---- 30/50/80 的三段式（用户口径）----
      //   30%–50%：B 低频从 0 抬到 50–70%，A 低频只削到 55–65%（不是切走）
      //   50%      ：B 中频以 ~20% 进来垫着
      //   80% 之后 ：人声交换，A 的中/高频收掉，B 中频抬满、低频补到 1
      // 百分比是**整段过渡的进度**，不是换手段内部进度。
      // 两侧低频律动越不像，越晚开始叠（lowStartP 由 bassCorrelation 决定）。
      const bassStart = clamp(input.lowStartP ?? 0.30, 0.30, 0.45);
      const bassEnd = bassStart + 0.20;
      // 用户听感：B 的乐器还是进得太快，把中频入口再往后推（默认 58%）。
      const midAt = clamp(input.midAt ?? 0.58, 0.45, 0.70);
      // 交换点可被外部按强拍微调（0.65–0.90），默认 0.80。
      const vocalAt = clamp(input.vocalAt ?? 0.80, 0.65, 0.90);
      const smooth = (t: number) => t * t * (3 - 2 * t);
      const bTarget = clamp(input.bassTarget ?? 0.62, 0.5, 0.7);
      const aKeep = clamp(input.aLowKeep ?? 0.6, 0.55, 0.65);

      if (p <= bassStart) {
        bLowV = 0;
        aLowV = 1;
      } else if (p < bassEnd) {
        const t = smooth((p - bassStart) / (bassEnd - bassStart));
        bLowV = bTarget * t;
        aLowV = 1 - (1 - aKeep) * t;
      } else {
        // 50% 之后不再「保持」：B 低频从 0.62 一路平滑爬到 1，A 同步从 0.60 收到 0。
        const t = smooth((p - bassEnd) / Math.max(1e-6, 1 - bassEnd));
        bLowV = bTarget + (1 - bTarget) * t;
        aLowV = aKeep * (1 - t);
      }

      // 中频：从 50% 起**连续**爬升到 100%（不再先到 0.2 再在 80% 跳满）。
      // 用户口径：B 应该是从 50% 左右开始慢慢加进来，而不是尾段一瞬间出现。
      if (p < midAt) {
        bMidV = 0;
      } else {
        bMidV = smooth((p - midAt) / Math.max(1e-6, 1 - midAt));
      }
      if (p < vocalAt) {
        aMidV = 1;
      } else {
        const t = smooth((p - vocalAt) / Math.max(1e-6, 1 - vocalAt));
        // 等功率收尾：A 在交换段开头几乎不动，到窗口末才归零，
        // 比 t^0.7 松得多（用户口径：交换瞬间太紧，放宽松点）。
        aMidV = Math.max(0, Math.cos(Math.min(1, t) * Math.PI / 2));
      }

      // 高频跟随中频：人声/镲片一起在 80% 后交换。
      {
        const hold = Math.min(0.4, Math.max(0, input.aTailHold ?? 0));
        aHighV = hold + (1 - hold) * Math.min(1, aMidV);
      }
      const bHighTarget = bMidV <= 0 ? 0 : Math.min(1, bMidV + 0.05);
      // 非 bEntry 时用 5% 窗口把 B 从 0 拉进幽灵电平（避免第 0 帧硬起 -60 dB）；
      // bEntry 的语义本来就是「B 从 -18 dB 就听得见」，不能渐入，否则前奏当窗口失效。
      const fadeIn = input.bEntry ? 1 : Math.min(1, v / Math.max(0.02, 0.05));
      // 紧凑换手：未触发的频段必须是**绝对静音**（用户口径：从零到目标），
      // 不能用 ghost/−30 dB 垫音，否则「还没进入」的频段一直在响。
      bHighV = 0;
      // 取 max 而不是相乘：换手前曲线本来是 0，乘任何数都还是 0。
      // 中/高频：触发前恒 0，触发后从 0 平滑到目标；B 的进场不做 ghost 预垫。
      bMidV = bMidV * fadeIn;
      bHighV = bHighTarget * fadeIn;
      // B 的高通必须在低频交接前开完，否则 B 的低频被自己挡着。
      // B 的高通必须在低频交换开始前开完，否则 B 的低频被自己挡着。
      bHpP = clamp(p / Math.max(step, bassStart), 0, 1);
      // A 的低通在换手后半段压到 700 Hz ——「变闷退出」发生在这几秒里。
      // 扫频起点由手法的 sweepShare 决定。
      // 以前这里写死 0.60，等于 filterSweep(1.0) / longBlend(0.35) / eqSwap(0.4) 的
      // 「扫多宽」全部无效 —— 16 种手法里有一半只在窗口长度上不同。
      const sweepLead = Number.isFinite(input.sweepShare) ? Math.max(0, Math.min(1, input.sweepShare as number)) : 0.4;
      const aSweepFrom = clamp(1 - 0.55 * sweepLead, 0.45, 1);
      aLpP = sweepEnabled ? clamp((v - aSweepFrom) / Math.max(0.05, 1 - aSweepFrom), 0, 1) : 0;
    } else {
      const low = lowHandoffGain(p, legacyStartP, legacyEndP);
      aLowV = low.a;
      bLowV = low.b;
      if (aHoldP > 0 && p < aHoldP) {
        aHighV = 1;
        bHighV = 0.18 * (p / aHoldP);
      } else if (aHoldP > 0) {
        const holdSpan = Math.max(1e-6, 1 - aHoldP);
        const t = Math.min(1, (p - aHoldP) / holdSpan);
        aHighV = Math.cos((t * Math.PI) / 2);
        bHighV = 0.18 + 0.82 * Math.sin((t * Math.PI) / 2);
      } else {
        const high = highEqualPowerGain(p);
        aHighV = high.a;
        bHighV = high.b;
      }
      aMidV = aHighV;
      bMidV = bHighV;
      aLpP = p <= legacySweepStart ? 0 : (p - legacySweepStart) / Math.max(1e-6, legacySweepEnd - legacySweepStart);
      bHpP = p <= 0 ? 0 : Math.min(1, p / bOpenP);
    }

    // B 的「由远及近」整体电平：只在前奏当窗口时启用（bEntry）。
    // 紧凑模式下 B 的进场已在 bHighV 里表达，这里不再叠一层。
    const entry = !compact && input.bEntry === true ? bEntryGain(p) : 1;
    aLow.push({ t: p, v: Number(aLowV.toFixed(5)) });
    aMid.push({ t: p, v: Number(aMidV.toFixed(5)) });
    bMid.push({ t: p, v: Number((bMidV * entry).toFixed(5)) });
    bLow.push({ t: p, v: Number((bLowV * entry).toFixed(5)) });
    aHigh.push({ t: p, v: Number(aHighV.toFixed(5)) });
    bHigh.push({ t: p, v: Number((bHighV * entry).toFixed(5)) });

    aLp.push({ t: p, v: Math.round(logSweep(20000, lpMinHz, aLpP)) });
    // A 的高通保持 20 Hz：不许一边低通下压一边收窄高通，否则中频先空出来变成「电话音」。
    aHp.push({ t: p, v: 20 });
    // B 的高通**永远**要开完：`sweep:false` 的语义只是「A 不变闷」，
    // 若连 B 的高通都不开，B 就只剩 12 kHz 以上，交接时下盘是空的（低频像被抽走再填回）。
    bHp.push({ t: p, v: Math.round(logSweep(bHpStartHz, 20, bHpP)) });
    bLp.push({ t: p, v: 20000 });
  }

  const entryNote = !compact && input.bEntry
    ? `，B 从 ${V2_B_ENTRY_FROM_DB}dB 渐入到 ${Math.round(V2_B_ENTRY_END_P * 100)}% 满音量`
    : '';
  const compactNote = compact
    ? `，A 在 ${Math.round(swapStartP * 100)}% 前保持原样，最后 ${(swapShare * 100).toFixed(0)}% 才换手`
    : '';
  const note = sweepEnabled
    ? `v2：${totalBars} 小节，低频在第 ${lowHandoffBars} 小节内换手，A 低通自 ${Math.round(
        sweepStartP * 100,
      )}% 压到 ${Math.round(lpMinHz)}Hz，B 高通在 ${Math.round(bOpenP * 100)}% 前开完${entryNote}${compactNote}`
    : `v2：${totalBars} 小节，只做低频换手（无扫频）${entryNote}${compactNote}`;

  const plan: V2Plan = {
    totalBars,
    handoffP,
    handoffStartP,
    swapStartP,
    step,
    note,
    aHoldP,
    a: {
      mid: dedupe(aMid),
      low: dedupe(aLow),
      high: dedupe(aHigh),
      sweepLp: dedupe(aLp),
      sweepHp: dedupe(aHp),
    },
    b: {
      mid: dedupe(bMid),
      low: dedupe(bLow),
      high: dedupe(bHigh),
      sweepLp: dedupe(bLp),
      sweepHp: dedupe(bHp),
    },
  };
  // 只有输入显式给出才挂键：旧调用拿到的对象与改动前逐键一致。
  if (Number.isFinite(input.duckScale)) plan.duckScale = clamp(input.duckScale as number, 0, 2);
  return plan;
}

/**
 * 去掉「值没变」的中间点：曲线只有几百个点，但 AudioParam 每个点都是一次
 * 自动化事件；把平台段压成两点能显著减少事件数（尤其 `sweepHp` 恒 20 Hz 时）。
 */
function dedupe(points: V2CurvePoint[]): V2CurvePoint[] {
  if (points.length <= 2) return points;
  const out: V2CurvePoint[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = out[out.length - 1]!;
    const cur = points[i]!;
    const next = points[i + 1]!;
    const flat = Math.abs(cur.v - prev.v) < 1e-9 && Math.abs(next.v - cur.v) < 1e-9;
    if (!flat) out.push(cur);
  }
  out.push(points[points.length - 1]!);
  return out;
}

/**
 * 低频叠加估算（dB）：把两条低频增益当功率相加。
 *
 * 用途只有两个：单测断言「全程 ≤ 0 dB」，以及调试面板里给一个可对照的数字。
 * 真实底鼓是相关的，实际峰值不会到 0 dB，这个函数是上界。
 */
export function lowBumpDb(progress: number, startP: number, endP: number): number {
  const { a, b } = lowHandoffGain(progress, startP, endP);
  const power = a * a + b * b;
  return power <= 1e-9 ? -120 : 10 * Math.log10(power);
}

/**
 * 「B 抬起来的那一下压 A」的驱动曲线。
 *
 * B 的总增益（低频与高频的功率和）在换手前后会快速爬升；爬得越陡，说明「新歌正在顶上来」。
 * 把这段斜率归一化成 0..1 的 drive，交给音频侧去同时做两件事：
 * - 压 A 的电平（`pressDb`，最多 −5 dB），让位；
 * - 把 A 的低通往下拉（`darkHz`，20000 → 1500 Hz），听感是「上一首退到门后」。
 *
 * 只对陡升段（默认 ≥0.9 dB/1% 窗口）响应，平缓的交叉（bassSwap 那种）不触发，
 * 否则整段都在压，等于把 A 白送掉。
 */
export interface PressPoint {
  /** 归一化位置。 */
  p: number;
  /** 驱动强度 0..1（含 8% 的释放尾巴）。 */
  drive: number;
}

export function risingPressure(
  b: Pick<V2DeckCurves, 'low' | 'high'>,
  options: { step?: number; thresholdDb?: number; hold?: number; release?: number } = {},
): PressPoint[] {
  const step = clamp(options.step ?? 0.01, 0.005, 0.1);
  const threshold = Math.max(0.2, options.thresholdDb ?? 0.9);
  const hold = clamp(options.hold ?? 0.04, 0, 0.3);
  const release = clamp(options.release ?? 0.12, 0, 0.5);
  const power = (t: number): number => {
    const lo = sampleCurve(b.low, t);
    const hi = sampleCurve(b.high, t);
    return Math.max(1e-6, (lo * lo + hi * hi) / 2);
  };
  const raw: PressPoint[] = [];
  for (let t = 0; t <= 1 + 1e-9; t += step) {
    const p = Math.min(1, Math.round(t * 1000) / 1000);
    const next = Math.min(1, p + step);
    const riseDb = 10 * Math.log10(power(next) / power(p));
    // 阈值以上线性归一到 1：0.9 dB → 0，3.5 dB/1% → 1。
    const drive = clamp((riseDb - threshold) / 2.6, 0, 1);
    raw.push({ p, drive });
  }
  // 保持 + 释放：陡升之后 A 不会立刻「回来」，而是慢慢退出（hold 段维持，release 段线性衰减）。
  const out: PressPoint[] = [];
  let held = 0;
  let cool = 0;
  for (const point of raw) {
    if (point.drive > held) {
      held = point.drive;
      cool = hold + release;
    } else if (cool > 0) {
      cool = Math.max(0, cool - step);
      held = Math.max(point.drive, held * 0.94);
    }
    out.push({ p: point.p, drive: Math.round(Math.max(point.drive, cool > 0 ? held : 0) * 1000) / 1000 });
  }
  return out;
}
