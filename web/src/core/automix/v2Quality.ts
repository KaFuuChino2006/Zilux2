/**
 * 进阶混音 v2 的质量门（E10）。
 *
 * 设计原则：**所有判定都在规划期完成**，播放中不再降级。理由是一次过渡只有 8–32 秒，
 * 播放中改曲线会听出"动作"；宁可事前换一个保守形态。
 *
 * 四项指标：
 * 1. `bassBumpDb`     低频叠加峰值（同一时刻两首都放低频 → 中段轰）
 * 2. `vocalOverlapBeats` 人声重叠拍数（两首同时有人声 → 咬字打架）
 * 3. `loudnessDriftLu` 过渡中的响度漂移（爬坡 / 塌陷）
 * 4. `rateJumpPctPerBeat` 变速斜率（超过 1.5%/拍 会被听成"赶"）
 *
 * 全部是纯函数，只吃分析结果 + 曲线参数，不碰 Web Audio。
 */
import type { ActivityCurves, BeatAnalysis } from '../../online/analysis';

/** 低频叠加放宽到多少 dB 还听不出来（再高就是"轰"）。 */
export const BASS_BUMP_LIMIT_DB = 2.0;

/** 人声允许重叠的拍数（1 拍 ≈ 一个字的咬合）。 */
export const VOCAL_OVERLAP_LIMIT_BEATS = 1.0;

/** 过渡中允许的响度漂移（LU）。 */
export const LOUDNESS_DRIFT_LIMIT_LU = 1.5;
/** 低于这个瞬时响度的采样不参与「混合是否平稳」的判断（静音/渐隐尾巴）。 */
const LOUD_FLOOR_LUFS = -45;

/** 变速斜率上限（% / 拍）。 */
export const RATE_JUMP_LIMIT_PCT_PER_BEAT = 1.5;

export interface QualityInput {
  /** A 的分析（要 activity）。 */
  a: BeatAnalysis;
  /** B 的分析（要 activity）。 */
  b: BeatAnalysis;
  /** A 侧过渡起点（文件时间轴 ms）。 */
  fadeStartAMs: number;
  /** B 侧过渡起点（文件时间轴 ms）。 */
  fadeStartBMs: number;
  /** 过渡时长（ms）。 */
  fadeMs: number;
  /** 拍长（ms）。 */
  beatMs: number;
  /** B 相对 A 的速率（1 = 不变速）。 */
  tempoRate: number;
  /** 低频换手窗口（进度 0~1）。 */
  handoffStartP: number;
  handoffEndP: number;
  /** B 的响度补偿（dB，正数 = B 被压低）。 */
  gainTrimDb?: number;
  /**
   * B 用「前奏渐入」进场：整条 B 从 -18 dB 起步、到 90% 才满音量。
   * 这时的混合电平本来就该先低后高，拿「平稳」去要求它只会把 B 顶 +4 dB。
   */
  bEntry?: boolean;
  /** A 是纯器乐（让位深度减半，重叠判定按 −3 dB 折算）。 */
  aInstrumental?: boolean;
  /**
   * 链路实际排的人声让位深度（dB，负值）。不传时退回旧口径：人声 −6 / 器乐 −3。
   * 远调（Camelot ≥4）会压得更深、近调更浅，指标必须按真实深度折算。
   */
  aDuckDb?: number;
  /**
   * 两首的 Camelot 距离（0–6，未知名返回 null/省略）。
   *
   * 只用于区分「同一件事」的两种重叠：同调/近调（距离 ≤3，含关系大小调）两条人声
   * 叠在一起是和声，听众当成合唱；远调（≥4）叠在一起才是咬字打架。
   * 这不是给指标放水——`vocalOverlapBeats` 一个字都不改，另开一个 `vocalClashBeats`。
   */
  keyGap?: number;
  /**
   * 紧凑换手占比（A 在 1−swapShare 之前完全原样、B 只以 −60 dB 垫底）。
   * 响度漂移只该在真正的换手段里量：前段 A 没动、B 没进来，曲线当然是平的，
   * 把整段算进去只会让「A 的渐隐 + B 的前奏」稀释掉真正的洞。
   */
  swapShare?: number;
  /**
   * 响度合成用哪种电平包络。
   *
   * `'equal'`（默认）：等功率交叉，假设 A 一路衰减、B 一路进场 —— 标准档确实如此。
   * `'compact'`：v2 链的真实形状 —— A 在 `1 − swapShare` 之前保持满电平（不是衰减），
   *   之后才快速让位；B 同时只以 −60 dB 垫底，到让位段才抬起来。
   *
   * 用等功率去量 v2 会把「A 一直满电平」当成「A 已经在衰减」，窗口开头凭空出现一个
   * 8–10 dB 的假坑（`--curves` 实测最差 4.92 LU 那一对就是这个形状）。
   */
  weights?: 'equal' | 'compact' | 'plan';
  /**
   * B 一开播就唱、没有窗口摆首句时，链路会把 **B** 的 1.5–4 kHz 压 6 dB（`buildBEntryDuck`）。
   * 指标原来只折算 A 的让位，于是这类对被判「两条人声重叠」——实际是 B 已经被压住了。
   */
  bEntryDucked?: boolean;
  /**
   * 变速斜率上限（%/拍）。默认 {@link RATE_JUMP_LIMIT_PCT_PER_BEAT}。
   * `halfTime`（2:1 折叠）、`backspin`（倒放）本来就是「故意变速」的手法，
   * 用 1.5%/拍 去卡它们只会把设计判成缺陷。
   */
  rateJumpLimit?: number;
  /**
   * 湿声尾（`echoOut` / `reverbOut` 这类带 send 的手法）。
   *
   * 指标以前只量干声：A 的干声被压掉后，延迟/混响还在响 1–2 s，
   * 耳朵听到的是"没断"，指标却记成"塌了 8 LU"。这里把 send 支路的能量
   * 按 send 电平 + 指数衰减补进合成包络，让指标和耳朵对齐。
   */
  wetTail?: {
    /** send 电平（相对干声，dB，负值）。 */
    sendDb?: number;
    /** 衰减时间常数（ms）。 */
    decayMs?: number;
    /** 从窗口哪个位置开始有湿声（0–1）。 */
    fromP?: number;
  };
  /**
   * B 侧过渡期电平包络（dB，0…+6，与 `ps` 同一网格）。
   *
   * 最差的响度塌陷不是换手时机，而是「B 前奏比 A 尾低 10–12 LU」：
   * 链路按小节把 A 关掉之后，中间几秒只剩轻前奏。包络在 A 还响着时把 B 抬起来
   * （被 A 掩蔽），等 B 的鼓/人声进来再回 0。指标必须按同一条包络折算 B 的能量，
   * 否则「已经补平」在报表上仍是塌洞。
   */
  bTrim?: number[];
  /**
   * 响度补平曲线（dB，与 `loudnessRampCurve` 同网格）：链路在 `loudnessTrim` 上按它把塌陷补回来。
   * 指标必须同口径地把这段补偿算进去，否则「修好了」和「没修」在报表上完全一样。
   */
  trimCurve?: { ps: number[]; db: number[] };
  /**
   * `weights: 'plan'` 时的真实能量包络（与 `ps` 同一网格，值 = 该点的功率增益）。
   * 由调用方从 v2 计划曲线算：`(low² + high²) / 2`（两条支路各半，起点归一到 1）。
   */
  aEnv?: number[];
  bEnv?: number[];
}

export interface QualityReport {
  bassBumpDb: number;
  vocalOverlapBeats: number;
  /**
   * 其中「真正咬字」的拍数：两边都在满嗓子（≥0.7）且调性不兼容（Camelot ≥4）。
   * 远调同时唱才是掩蔽；同调重叠属编曲。
   */
  vocalClashBeats: number;
  loudnessDriftLu: number;
  rateJumpPctPerBeat: number;
  pass: boolean;
  /** 未通过的项（英文 key，供日志/调试）。 */
  failures: string[];
  /**
   * 合成响度曲线的降采样（0.05 步长，dB）。只用于体检台分类诊断：
   * 光看 `loudnessDriftLu = 3.2` 分不清是「开头编曲空档」「中段换手塌」还是「尾巴掉」。
   */
  curve?: { ps: number[]; lufs: number[] };
  /** 建议的修正动作（规划期一次性应用）。 */
  suggestion: QualitySuggestion;
}

export interface QualitySuggestion {
  /** 低频换手窗口是否要拉长（叠加过多时的唯一无损修法）。 */
  widenHandoff: boolean;
  /** 是否要开人声 duck。 */
  enableVocalDuck: boolean;
  /** 是否要缩短过渡（人声重叠无法靠 duck 解决时）。 */
  shortenFade: boolean;
  /** 纠正后的增益补偿（dB）。 */
  gainTrimDb: number;
  /** A 是纯器乐：让位深度减半，重叠判定按 −3 dB 折算。 */
  aInstrumental?: boolean;
  /** 建议的速率上限（1 = 不变速）。 */
  tempoRate: number;
}

/** 在没有 activity 曲线时按"最坏情况"估计：两首都有低频、都有人声。 */
const NEUTRAL_ACTIVITY: ActivityCurves = {
  hopMs: 250,
  vocal: [0.6, 0.6, 0.6, 0.6],
  drum: [0.6, 0.6, 0.6, 0.6],
  bass: [0.6, 0.6, 0.6, 0.6],
};

function curveOf(analysis: BeatAnalysis): ActivityCurves {
  return analysis.activity ?? NEUTRAL_ACTIVITY;
}

/** 按文件时间取活动度（线性插值，越界夹到端点）。 */
export function sampleActivity(curve: ActivityCurves, fileMs: number): number[] {
  const values: number[][] = [curve.vocal, curve.drum, curve.bass];
  const hop = curve.hopMs > 0 ? curve.hopMs : 250;
  const position = Math.max(0, fileMs) / hop;
  const index = Math.floor(position);
  const frac = position - index;
  return values.map((series) => {
    if (series.length === 0) return 0;
    const from = series[Math.min(series.length - 1, Math.max(0, index))];
    const to = series[Math.min(series.length - 1, Math.max(0, index + 1))];
    return from + (to - from) * frac;
  });
}

/**
 * 低频叠加：v2 把 0–120Hz 在换手窗口里从 A 线性交给 B（`lowA + lowB = 1`）。
 * 若两首的低频活动度相同，和恒为 1（0 dB）；不同时按幅度相加估最坏值。
 */
export function estimateBassBumpDb(input: QualityInput): number {
  const aCurve = curveOf(input.a);
  const bCurve = curveOf(input.b);
  const steps = 64;
  let worst = 0;
  for (let i = 0; i <= steps; i += 1) {
    const p = i / steps;
    const aMs = input.fadeStartAMs + p * input.fadeMs;
    const bMs = input.fadeStartBMs + p * input.fadeMs * input.tempoRate;
    const bassA = sampleActivity(aCurve, aMs)[2];
    const bassB = sampleActivity(bCurve, bMs)[2];
    const progress = clamp01((p - input.handoffStartP) / Math.max(1e-6, input.handoffEndP - input.handoffStartP));
    const lowA = 1 - progress;
    const lowB = progress;
    // 低频是相关信号：能量相加 → 幅度相加。用「低A*值A + 低B*值B」这种凸组合
    // 永远 ≤ max(A,B)，恒等于 0 dB（旧实现因此对任何输入都报 0，永久假阴性）。
    const summed = lowA * bassA + lowB * bassB;   // 线性幅度域叠加
    const reference = Math.max(bassA, bassB, 1e-6);
    worst = Math.max(worst, 20 * Math.log10(Math.max(1, summed / reference)));
  }
  return round2(worst);
}

/**
 * 人声重叠拍数：抓 B 有人声的每一拍，看 A 在对应时刻是否也有人声。
 * 用"拍"而不是毫秒，是因为 1 拍内的人声叠是咬合、跨拍就是打架。
 */
/** 判「两边都在满嗓子」的门槛（原始曲线，未折算让位）。 */
const CLASH_BOTH = 0.7;
/** Camelot 距离 ≥ 这个值才算调性冲突（0–3 含同调、相邻调、关系大小调）。 */
const CLASH_KEY_GAP = 4;

/**
 * 真正咬字的重叠拍数：两条人声都满、而且调性不兼容。
 *
 * 与 {@link estimateVocalOverlapBeats} 的区别只在**判据**，不改既有指标：
 * 那个指标回答「有没有两条人声同时可听」，这个回答「同时可听会不会刺耳」。
 * 同调/近调的两条人声叠在一起是合唱（副歌对副歌就是这个效果），
 * 远调才是掩蔽——所以「重叠 4 拍但全在近调」不该进缺陷清单。
 */
export function estimateVocalClashBeats(input: QualityInput): number {
  const aCurve = curveOf(input.a);
  const bCurve = curveOf(input.b);
  const beatMs = Math.max(120, input.beatMs);
  const beats = Math.max(1, Math.floor(input.fadeMs / beatMs));
  const gap = typeof input.keyGap === 'number' && Number.isFinite(input.keyGap) ? input.keyGap : null;
  if (gap !== null && gap < CLASH_KEY_GAP) return 0;
  let clash = 0;
  for (let beat = 0; beat < beats; beat += 1) {
    const offset = beat * beatMs + beatMs * 0.5;
    const aMs = input.fadeStartAMs + offset;
    const bMs = input.fadeStartBMs + offset * input.tempoRate;
    const vocalA = sampleActivity(aCurve, aMs)[0];
    const vocalB = sampleActivity(bCurve, bMs)[0];
    if (vocalA >= CLASH_BOTH && vocalB >= CLASH_BOTH) clash += 1;
  }
  return round2(clash);
}

export function estimateVocalOverlapBeats(input: QualityInput): number {
  const aCurve = curveOf(input.a);
  const bCurve = curveOf(input.b);
  const beatMs = Math.max(120, input.beatMs);
  const beats = Math.max(1, Math.floor(input.fadeMs / beatMs));
  // 层 C 人声让位现在是真接上的（§7.50）：B 唱的时候 A 的 1.5–4 kHz 压 6 dB（器乐 3 dB）。
  //   旧指标只看两条原始曲线，把「压过之后的 A」还按满量算，于是永远报重叠。
  //   这里按实际链路折算：A 在 B 有人声的那一拍按 −6 dB（×0.501）计权，
  //   A 是纯器乐时按 −3 dB（×0.708）。阈值仍是 0.5 → 压完低于 0.5 就不算"还在唱"。
  const duckGain = Number.isFinite(input.aDuckDb)
    ? Math.pow(10, (input.aDuckDb as number) / 20)
    : (input.aInstrumental ? 0.708 : 0.501);
  // 阈值不能取 0.5：A 满嗓子 1.0 乘 0.501 就是 0.501，判据「>0.5」只在曲线恰好到 1.0 时成立，
  // 于是这个指标长期报 0（换手明显还听得见两条人声却显示「无重叠」）。取 0.35 表示
  // 「压过之后仍明显可听」—— A 需原始 >0.70（器乐 A >0.49）才算重叠。
  const audible = 0.35;
  let overlap = 0;
  for (let beat = 0; beat < beats; beat += 1) {
    const offset = beat * beatMs + beatMs * 0.5;
    const aMs = input.fadeStartAMs + offset;
    const bMs = input.fadeStartBMs + offset * input.tempoRate;
    const vocalBRaw = sampleActivity(bCurve, bMs)[0];
    // 入场让位：B 唱得太早时被压 6 dB（×0.501），按实际链路折算后再判重叠。
    const vocalB = vocalBRaw * (input.bEntryDucked ? 0.501 : 1);
    // A 判为器乐时，300–3500 Hz 里的能量多半是主旋律/弦乐而不是咬字：
    //   按 0.6 折权，避免把「旋律与唱句同频」算成两个人抢麦。
    const aWeight = input.aInstrumental ? 0.6 : 1;
    const vocalA = sampleActivity(aCurve, aMs)[0] * aWeight * (vocalB > DUCK_TRIGGER ? duckGain : 1);
    if (vocalA > audible && vocalB > 0.5) overlap += 1;
  }
  return round2(overlap);
}

/**
 * 响度漂移：把 momentary LUFS 按等功率权重合成「过渡中实际听到的响度曲线」，
 * 再量这条曲线上**中途方向反转的幅度**（先掉后涨 = 塌洞，先涨后掉 = 鼓包）。
 *
 * 为什么不是「和某一首的电平比」也不是「偏离首尾直线」（前三版，全都误报）：
 *   - A 的尾巴在渐隐、B 的前奏本来比副歌轻 8–13 LU，这是编曲不是缺陷，
 *     拿中段比高水位 → 61% 的对被判失败；
 *   - 两首歌电平差得多时，等功率叠加本来就是一条**弯**的单调曲线，
 *     拿直线去拟合 → 96% 的对被判失败（p50 4.4 LU，全是形状不是问题）。
 * 真正难听的是曲线中途掉下去又涨回来（换手空档、支路漏音）或冲上去再掉回来
 * （相关低频 +3 dB）。所以这里只看**单调性破坏**的深度，单调下降/上升一律放过。
 * 3 点平滑后统计；没有 momentary 数据时返回 0。
 */
export interface LoudnessRamp {
  /** 采样点的归一化位置（0 = 过渡开头，1 = 结束）。 */
  ps: number[];
  /** 合成后的瞬时响度（LUFS），已 3 点平滑。 */
  lufs: number[];
  /** 单调性被破坏的最大深度（LU）—— 就是 drift 指标。 */
  worst: number;
}

/**
 * 把 A/B 的 momentary LUFS 按等功率权重合成「过渡中实际听到的响度曲线」。
 *
 * 单独导出是为了排查：只看一个数字（drift = 1.8 LU）无法判断是换手空档、A 尾奏渐隐，
 * 还是 B 前奏本来就轻；`web/tools/mix-audit.cjs --curves=N` 会把最差的几对曲线打出来。
 */
/**
 * B 侧过渡期电平包络：按 A/B 在窗口内的 LUFS 差，把 B 在 A 还响着时抬到「只差 1 dB」，
 * 上限 +6 dB；B 自己顶上来之后自然回 0（差值变负 → 目标 0）。
 *
 * 只在两边都真的在响（各自峰值 10 dB 内）的采样点计算，其余沿用上一个值；
 * 结果做两遍 5 点平滑，避免包络本身变成新的电平抖动。
 */
/** 取一段曲线的窗口样本（按 ms 线性取样，缺数据回 null）。 */
function windowSamples(points: readonly number[] | null | undefined, hopMs: number,
                       startMs: number, lengthMs: number, stepMs = 250): number[] {
  if (!points || points.length === 0 || hopMs <= 0 || lengthMs <= 0) return [];
  const out: number[] = [];
  for (let t = startMs; t < startMs + lengthMs; t += stepMs) {
    const i = Math.round(t / hopMs);
    if (i >= 0 && i < points.length) out.push(points[i]);
  }
  return out;
}

function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 6) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da <= 1e-9 || db <= 1e-9) return null;
  return num / Math.sqrt(da * db);
}

/**
 * 分频点自适应：低频换手是「相关信号线性相加」，两边低频越不像（相关低），
 * 120 Hz 处的相位/音高打架就越明显。把分频点往上抬一点，让更多低频走线性互补、
 * 少一点走等功率交叉，能减轻「两首歌的底鼓/贝斯互相抵消」。
 *
 * 只在两边都真的有低频时调整：一边没低频时任何分频都一样，别白改。
 */
/** 窗口内两侧 bass 活动的 Pearson 相关（−1…1）；任一侧没有低频返回 null。 */
export function bassCorrelation(input: {a: BeatAnalysis; b: BeatAnalysis; fadeStartAMs: number; fadeStartBMs: number; fadeMs: number; tempoRate: number}): number | null {
  const hopA = input.a.activity?.hopMs || 250;
  const hopB = input.b.activity?.hopMs || 250;
  const ca = windowSamples(input.a.activity?.bass, hopA, input.fadeStartAMs, input.fadeMs);
  const cb = windowSamples(input.b.activity?.bass, hopB,
    input.fadeStartBMs / Math.max(0.5, input.tempoRate), input.fadeMs / Math.max(0.5, input.tempoRate));
  if (ca.length < 8 || cb.length < 8) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < ca.length; i += 1) { ma += ca[i]; mb += cb[i]; }
  ma /= ca.length; mb /= cb.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ca.length; i += 1) {
    const x = ca[i] - ma, y = cb[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da < 1e-9 || db < 1e-9) return null;
  return num / Math.sqrt(da * db);
}

export function planSplitHz(input: {
  a: BeatAnalysis; b: BeatAnalysis;
  fadeStartAMs: number; fadeStartBMs: number; fadeMs: number; tempoRate: number;
}): number {
  const hopA = input.a.activity?.hopMs ?? 0;
  const hopB = input.b.activity?.hopMs ?? 0;
  const bassA = windowSamples(input.a.activity?.bass, hopA, input.fadeStartAMs, input.fadeMs);
  const bassB = windowSamples(input.b.activity?.bass, hopB,
    input.fadeStartBMs / Math.max(0.5, input.tempoRate), input.fadeMs / Math.max(0.5, input.tempoRate));
  const n = Math.min(bassA.length, bassB.length);
  if (n < 6) return 120;
  const median = (xs: number[]) => {
    const s = [...xs].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)] ?? 0;
  };
  if (median(bassA.slice(0, n)) < 0.08 || median(bassB.slice(0, n)) < 0.08) return 120;
  const corr = pearson(bassA.slice(0, n), bassB.slice(0, n));
  if (corr === null) return 120;
  // corr 1 → 120 Hz；corr 0 → 150 Hz；corr -1 → 180 Hz。
  const hz = 120 + 30 * (1 - Math.max(-1, Math.min(1, corr)));
  return Math.round(hz / 5) * 5;
}

export function planBTrimCurve(input: {
  a: BeatAnalysis;
  b: BeatAnalysis;
  fadeStartAMs: number;
  fadeStartBMs: number;
  fadeMs: number;
  tempoRate: number;
}): number[] {
  const levelsA = windowLevels(input.a, input.fadeStartAMs, input.fadeMs);
  const levelsB = windowLevels(input.b, input.fadeStartBMs, input.fadeMs * Math.max(0.5, input.tempoRate));
  if (levelsA.length < 4 || levelsB.length < 4) return [];
  const pick = (arr: number[], p: number): number | null => {
    const pos = p * (arr.length - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(arr.length - 1, i0 + 1);
    const a = arr[i0];
    const b = arr[i1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (a < LOUD_FLOOR_LUFS || b < LOUD_FLOOR_LUFS) return null;
    return a + (b - a) * (pos - i0);
  };
  const finite = (v: number[]) => v.filter((x) => Number.isFinite(x) && x > LOUD_FLOOR_LUFS);
  const aMax = Math.max(...finite(levelsA), LOUD_FLOOR_LUFS);
  // 参考取 A 的峰值：过渡的目标是「B 接住 A 的电平」，不是「两边谁响跟谁」。
  //   取 max 时 B 比 A 响永远补 0，drift 只能靠 gainTrimDb 的 ±3 dB 兜，兜不住。
  //   B 更响时允许把 B 压下来（负值），A 始终不动（A 不许被改）。
  const refLevel = aMax;
  const steps = Math.max(8, Math.min(160, Math.min(levelsA.length, levelsB.length) - 1));
  const raw: number[] = [];
  let last = 0;
  for (let i = 0; i <= steps; i += 1) {
    const p = i / steps;
    const a = pick(levelsA, p);
    const b = pick(levelsB, p);
    // B 只要不是静音就参与；A 是否在响不影响参考电平（A 结束后的两秒正是洞最深的地方）。
    if (b === null) {
      raw.push(last);
      continue;
    }
    // A 还在响时，B 抬过 6 dB 会在 A 抽走后形成一个上凸；A 已经没了（窗内取不到电平）
    // 就没有掩蔽问题，这一段的洞必须由 B 自己补，cap 放到 9 dB。
    // A 已经进入收尾（比自己的峰值低 12 dB 以上）时，B 不再有掩蔽问题，
    //   这一段必须让 B 自己把洞补上；否则末尾 20% 会塌。
    const aFading = a !== null && a < aMax - 12;
    const capDb = (a === null || aFading) ? 9 : 6;
    const floorDb = -6;
    const diff = refLevel - b;
    // 只给「B 更轻」留 1 dB 余量；B 更响时按实差压，不留余量（否则同电平也会被压 0.75）。
    // 余量只在 A 还在响时需要（避免 B 顶出上凸）；A 走后 B 必须正好接住 A 的峰值，
    //   否则末尾会留下一个和余量等深的洞。
    const marginDb = (a === null || aFading) ? 0 : 3.0;
    // A 已经在收尾/消失时不再有掩蔽问题，直接补满（1.0）；A 还在响时仍留 0.75 的保守系数，
    //   避免把 B 顶出一个上凸。
    const fill = (a === null || aFading) ? 1 : 0.75;
    last = Math.max(floorDb, Math.min(capDb, fill * diff - marginDb));
    raw.push(last);
  }
  // 不做时间平滑：250 ms 网格就是 LUFS 的测量分辨率，任何平滑都会把
  //   「前奏轻 → 副歌重」的台阶抹成斜坡，drift 反而被低估/高估。
  //   曲线本身是 linearRamp 到每个点，连续、无阶跃。
  return raw.map((v) => round2(Math.max(-6, Math.min(9, v))));
}

export function loudnessRampCurve(input: QualityInput): LoudnessRamp {
  const levelsA = windowLevels(input.a, input.fadeStartAMs, input.fadeMs);
  const levelsB = windowLevels(input.b, input.fadeStartBMs, input.fadeMs * input.tempoRate);
  if (levelsA.length < 3 || levelsB.length < 3) return { ps: [], lufs: [], worst: 0 };
  const compensation = input.gainTrimDb ?? 0;
  const sample = (levels: number[], p: number): number | null => {
    const pos = p * (levels.length - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(levels.length - 1, i0 + 1);
    const a = levels[i0];
    const b = levels[i1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (a < LOUD_FLOOR_LUFS || b < LOUD_FLOOR_LUFS) return null;
    return a + (b - a) * (pos - i0);
  };
  const pickArr = (arr: number[] | undefined, p: number): number => {
    if (!arr || arr.length < 2) return 0;
    const pos = p * (arr.length - 1);
    const i0 = Math.floor(pos);
    const i1 = Math.min(arr.length - 1, i0 + 1);
    const v0 = arr[i0];
    const v1 = arr[i1];
    if (!Number.isFinite(v0) || !Number.isFinite(v1)) return 0;
    return v0 + (v1 - v0) * (pos - i0);
  };
  const ps: number[] = [];
  const raw: number[] = [];
  const steps = Math.max(4, levelsA.length - 1);
  // 「谁在响」的判据：只有 A/B 各自都在自己窗内 10 dB 以内的段落才参与判定。
  //   否则量到的是编曲（B 的前奏本来就比 A 的副歌轻 10 dB），不是混音缺陷。
  const finite = (v: number[]) => v.filter((x) => Number.isFinite(x) && x > LOUD_FLOOR_LUFS);
  const aMax = Math.max(...finite(levelsA), LOUD_FLOOR_LUFS);
  const bMax = Math.max(...finite(levelsB), LOUD_FLOOR_LUFS);
  const ACTIVE_MARGIN_DB = 10;
  for (let i = 0; i <= steps; i += 1) {
    const p = i / steps;
    const a = sample(levelsA, p);
    const b = sample(levelsB, p);
    if (a === null || b === null) continue;
    if (a < aMax - ACTIVE_MARGIN_DB || b < bMax - ACTIVE_MARGIN_DB) continue;
    // 权重是**能量增益**（不是幅度）：`cos²+sin²=1` 才是等功率，写成 cos/sin 会在中点凭空 +3 dB。
    let wA: number;
    let wB: number;
    if (input.weights === 'plan' && input.aEnv?.length && input.bEnv?.length) {
      // 直接采计划曲线：A 的低/高支路增益平方和、B 同理。这是链路的真实电平，
      // 再往上套任何「等功率 / 保持」假设都只是猜测。
      const pick = (arr: number[], p: number): number => {
        const pos = p * (arr.length - 1);
        const i0 = Math.floor(pos);
        const i1 = Math.min(arr.length - 1, i0 + 1);
        const v0 = arr[i0];
        const v1 = arr[i1];
        if (!Number.isFinite(v0) || !Number.isFinite(v1)) return 0;
        return Math.max(0, v0 + (v1 - v0) * (pos - i0));
      };
      wA = pick(input.aEnv, p);
      wB = pick(input.bEnv, p);
    } else if (input.weights === 'compact') {
      // v2 真实形状：A 满电平保持到让位段起点（1 − swapShare），之后线性让位；
      // B 全程以 −60 dB 垫底，进入让位段才抬起。深度用 dB 线性插值（听感尺度）。
      const share = Math.min(0.95, Math.max(0.06, input.swapShare ?? 0.35));
      const from = 1 - share;
      const t = p <= from ? 0 : Math.min(1, (p - from) / Math.max(0.001, share));
      wA = Math.pow(10, (-60 * t) / 10);
      wB = Math.pow(10, (-60 * (1 - t)) / 10);
    } else {
      wA = Math.cos(p * (Math.PI / 2)) ** 2;
      wB = Math.sin(p * (Math.PI / 2)) ** 2;
    }
    ps.push(round2(p));
    // 湿声：send 支路在 A 干声衰减后仍在响，按 send 电平 + 指数衰减折成能量加到 A 侧。
    //   没有这一项，`echoOut`/`reverbOut` 会被量成 8 LU 的塌洞（实际听感是尾巴接住了）。
    let wet = 0;
    if (input.wetTail) {
      const fromP = Math.min(0.95, Math.max(0, input.wetTail.fromP ?? 0.55));
      const sendDb = Number.isFinite(input.wetTail.sendDb) ? (input.wetTail.sendDb as number) : -6;
      const decayMs = Math.max(200, input.wetTail.decayMs ?? 1_200);
      if (p >= fromP) {
        const ramp = Math.min(1, (p - fromP) / 0.08);
        const ageMs = (p - fromP) * input.fadeMs;
        wet = Math.pow(10, (a + sendDb) / 10) * ramp * Math.exp(-ageMs / decayMs);
      }
    }
    let trimDb = 0;
    if (input.trimCurve && input.trimCurve.db.length > 1) {
      const tc = input.trimCurve;
      const pos = p * (tc.db.length - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(tc.db.length - 1, i0 + 1);
      trimDb = tc.db[i0] + (tc.db[i1] - tc.db[i0]) * (pos - i0);
    }
    // B 的电平包络：先抬起来再回 0，报表必须跟链路同口径。
    const bTrimDb = pickArr(input.bTrim, p);
    raw.push(10 * Math.log10(Math.max(1e-12,
      Math.pow(10, a / 10) * wA + wet + Math.pow(10, (b - compensation + bTrimDb) / 10) * wB)) + trimDb);
  }
  if (raw.length < 4) return { ps, lufs: raw.map(round2), worst: 0 };
  // 3 点平滑（单点毛刺不算塌洞）
  const curve: number[] = raw.map((v, i) => (i === 0 || i === raw.length - 1 ? v : (raw[i - 1] + v + raw[i + 1]) / 3));
  let worst = 0;
  let dir = 0;
  let extreme = curve[0];
  for (let i = 1; i < curve.length; i += 1) {
    const delta = curve[i] - curve[i - 1];
    if (Math.abs(delta) < 0.02) continue;
    const d = delta > 0 ? 1 : -1;
    if (dir === 0) { dir = d; extreme = curve[i]; continue; }
    if (d === dir) { extreme = curve[i]; continue; }
    worst = Math.max(worst, Math.abs(curve[i] - extreme));
    dir = d;
    extreme = curve[i];
  }
  return { ps, lufs: curve.map(round2), worst: round2(worst) };
}

/**
 * 响度漂移：合成曲线中途方向反转的幅度（先掉后涨 = 塌洞，先涨后掉 = 鼓包）。
 *
 * 为什么不是「和某一首的电平比」也不是「偏离首尾直线」（前三版，全都误报）：
 *   - A 的尾巴在渐隐、B 的前奏本来比副歌轻 8–13 LU，这是编曲不是缺陷，
 *     拿中段比高水位 → 61% 的对被判失败；
 *   - 两首歌电平差得多时，等功率叠加本来就是一条**弯**的单调曲线，
 *     拿直线去拟合 → 96% 的对被判失败（p50 4.4 LU，全是形状不是问题）。
 * 采样窗必须覆盖整个交叉段：早期版本从 1−swapShare 起采（只量尾段），
 * B 在中段掉 14 LU 时只要尾段平就报 0.00。没有 momentary 数据时返回 0。
 */
export function estimateLoudnessDriftLu(input: QualityInput): number {
  return loudnessRampCurve(input).worst;
}

/**
 * B 侧让位：B 一起播就开唱的对（首句离它的起点 < 3.2 s）没有任何窗口
 * 能把「B 的首句」摆到接缝上，硬对齐只会把 B seek 到歌中间。这时换个方向处理：
 * 让 B 在 **A 还在唱的时候先压着走** —— 只要 A 的人声还在，就把 B 的 1.5–4 kHz 压住，
 * A 一唱完立刻放开。听感就是 DJ 的「下一首在人声底下偷进来」，两条人声不会互盖。
 * 深度自适应：A 只是轻声哼压 3 dB，A 满嗓子才压到 6 dB；B 自己很轻时再减 25%。
 * 返回的是 B 侧时间轴上的事件（offsetMs 相对 B 的过渡起点）。
 */
export function buildBEntryDuck(input: {
  a: BeatAnalysis;
  fadeStartAMs: number;
  fadeMs: number;
  stepMs?: number;
  attackMs?: number;
  releaseMs?: number;
  maxDuckDb?: number;
  /** B 自己的活动度（可选）：B 本身唱得很轻时没必要压那么深。 */
  b?: BeatAnalysis;
  /**
   * A 是纯器乐：没有「A 的人声」可让位，但 B 早唱时仍会盖住 A 的乐器。
   * 这时改用「B 唱多响就压多深」的常驻让位（A 一侧活动度恒为 0，不能拿它算深度）。
   */
  aInstrumental?: boolean;
  bStartMs?: number;
  tempoRate?: number;
}): DuckEvent[] {
  const curve = input.a.activity;
  if (!curve || !Array.isArray(curve.vocal) || curve.vocal.length === 0) return [];
  const stepMs = input.stepMs ?? 40;
  const attack = input.attackMs ?? 20;
  const release = input.releaseMs ?? 80;
  const maxDuck = Math.abs(input.maxDuckDb ?? -6);
  const bCurve = input.b?.activity;
  const bFrom = Number.isFinite(input.bStartMs) ? (input.bStartMs as number) : 0;
  const bRate = Number.isFinite(input.tempoRate) && (input.tempoRate as number) > 0 ? (input.tempoRate as number) : 1;
  const events: DuckEvent[] = [];
  let current = 0;
  const steps = Math.max(1, Math.floor(input.fadeMs / stepMs));
  for (let i = 0; i <= steps; i += 1) {
    const offsetMs = i * stepMs;
    const aMs = input.fadeStartAMs + offsetMs;
    const vocal = sampleActivity(curve, aMs)[0];
    const aDepth =
      vocal > DUCK_TRIGGER
        ? 3 + 3 * Math.min(1, (vocal - DUCK_TRIGGER) / 0.4)
        : DUCK_TRIGGER_SOFT < vocal
          ? 1.5 + 1.5 * Math.min(1, (vocal - DUCK_TRIGGER_SOFT) / (DUCK_TRIGGER - DUCK_TRIGGER_SOFT))
          : 0;
    const bVocal = bCurve ? sampleActivity(bCurve, bFrom + offsetMs * bRate)[0] : 1;
    // 提前 400 ms 看到 B 要开唱就先把让位收掉：否则「B 第一句」正好落在还压着的那几帧上，
    // 听感是新人声一进来就被闷住，80 ms release 根本来不及。
    const bAhead = bCurve
      ? Math.max(
        sampleActivity(bCurve, bFrom + (offsetMs + 200) * bRate)[0] ?? 0,
        sampleActivity(bCurve, bFrom + (offsetMs + 400) * bRate)[0] ?? 0,
      )
      : 0;
    const bScale = bVocal < 0.3 ? 0.75 : 1;
    // B 自己正在唱时不能压 B：新歌的人声是主角，压掉会让「下一首一进来就闷」。
    // 该让位的是 A 的人声（层 C 由 B 的活动度驱动），不是 B 的首句。
    const bSinging = bVocal > 0.35 || bAhead > 0.35;
    const target = input.aInstrumental
      ? (bVocal > 0.3 ? -Math.min(maxDuck, maxDuck * 0.75) : 0)
      : bSinging ? 0 : aDepth > 0 ? -Math.min(maxDuck, aDepth * bScale) : 0;
    const tau = target < current ? attack : release;
    const alpha = 1 - Math.exp(-stepMs / Math.max(1, tau));
    current += (target - current) * alpha;
    events.push({ offsetMs, db: Math.round(current * 100) / 100 });
  }
  return events;
}

function windowLevels(analysis: BeatAnalysis, startMs: number, lengthMs: number): number[] {
  const times = analysis.loudnessTimesMs;
  const levels = analysis.momentaryLufs;
  if (!Array.isArray(times) || !Array.isArray(levels) || times.length === 0) return [];
  const out: number[] = [];
  const step = 100;
  for (let offset = 0; offset <= lengthMs; offset += step) {
    const t = startMs + offset;
    const value = sampleSeries(times, levels, t);
    if (value !== null) out.push(value);
  }
  return out;
}

function sampleSeries(times: number[], values: number[], t: number): number | null {
  if (t <= times[0]) return values[0];
  if (t >= times[times.length - 1]) return values[values.length - 1];
  let low = 0;
  let high = times.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (times[mid] <= t) low = mid;
    else high = mid;
  }
  const span = times[high] - times[low];
  if (!(span > 0)) return values[low];
  const frac = (t - times[low]) / span;
  return values[low] + (values[high] - values[low]) * frac;
}

/**
 * 谱质心补偿：B 比 A 暗时给 B 抬一点 presence、A 收一点；反过来同理。
 * 只补 4–12 dB 的差，最多 ±3 dB——质心差太大是编曲（808 vs 弦乐），不是换手能修的。
 */
export function planTimbreCompDb(aHz: number | null | undefined, bHz: number | null | undefined): {
  aPresenceDb: number; bPresenceDb: number;
} | null {
  if (!(aHz && bHz) || !(aHz > 0) || !(bHz > 0)) return null;
  const gap = 200 * Math.log10(bHz / aHz); // 正 = B 更亮
  const abs = Math.abs(gap);
  if (abs < 4) return null;
  const amount = Math.min(3, (abs - 4) * 0.6);
  if (amount < 0.2) return null;
  const round1 = (v: number) => Math.round(v * 10) / 10;
  // 亮的一侧收 presence、暗的一侧补 presence；另一侧补得少一点，避免两边一起变亮。
  return gap > 0
    ? { aPresenceDb: round1(amount * 0.6), bPresenceDb: round1(-amount) }
    : { aPresenceDb: round1(-amount), bPresenceDb: round1(amount * 0.6) };
}

/** 把变速压到窗口能承受的斜率内：`|rate−1| ≤ 1.5% × 拍数`。返回夹取后的 rate。 */
export function clampTempoRateForWindow(rate: number, fadeMs: number, beatMs: number, limitPct = 1.5): number {
  if (!(fadeMs > 0) || !(beatMs > 0) || !Number.isFinite(rate)) return rate;
  // halfTime / doubleTime 是「整八度折叠」，不是微调：2.0 或 0.5 必须原样保留，
  //   否则会被当成 ±100% 的超大斜率压回 1.0 附近，手法直接失效。
  const octave = Math.abs(Math.log2(rate));
  if (octave >= 0.94 && Math.abs(octave - Math.round(octave)) < 0.06) return rate;
  const beats = Math.max(1, fadeMs / Math.max(120, beatMs));
  const maxSide = (limitPct * beats) / 100;
  if (Math.abs(rate - 1) <= maxSide) return rate;
  return Math.round((1 + Math.sign(rate - 1) * maxSide) * 1000) / 1000;
}

export function estimateRateJumpPctPerBeat(input: QualityInput): number {
  const perSide = Math.abs(input.tempoRate - 1);
  const beats = Math.max(1, input.fadeMs / Math.max(120, input.beatMs));
  return round2(((perSide / beats) * 100));
}

/** 四项一起算，并给出规划期修正建议。 */
/**
 * 两侧是否都有 activity 曲线。
 *
 * 缺曲线时**不能按最坏情况估**（历史实现用 0.6 铺满，结果每首歌都被判「人声重叠」，
 * 过渡被硬砍到 2 小节）；缺数据就当作「不知道」，跳过这两项，其余指标照常。
 */
function hasActivity(analysis: BeatAnalysis): boolean {
  const curve = analysis.activity;
  return Boolean(curve && Array.isArray(curve.vocal) && curve.vocal.length > 1);
}

export function evaluateQuality(input: QualityInput): QualityReport {
  const known = hasActivity(input.a) && hasActivity(input.b);
  const bassBumpDb = known ? estimateBassBumpDb(input) : 0;
  const vocalOverlapBeats = known ? estimateVocalOverlapBeats(input) : 0;
  // 咬字冲突单独记：同调重叠属编曲，不该被当成缺陷（重叠指标本身不变）。
  const vocalClashBeats = known ? estimateVocalClashBeats(input) : 0;
  const loudnessDriftLu = input.bEntry === true ? 0 : estimateLoudnessDriftLu(input);
  const ramp = input.bEntry === true ? null : loudnessRampCurve(input);
  const rateJumpPctPerBeat = estimateRateJumpPctPerBeat(input);
  const failures: string[] = [];
  if (bassBumpDb > BASS_BUMP_LIMIT_DB) failures.push('bass-bump');
  if (vocalOverlapBeats > VOCAL_OVERLAP_LIMIT_BEATS) failures.push('vocal-overlap');
  if (loudnessDriftLu > LOUDNESS_DRIFT_LIMIT_LU) failures.push('loudness-drift');
  const rateLimit = Number.isFinite(input.rateJumpLimit) && (input.rateJumpLimit as number) > 0
    ? (input.rateJumpLimit as number)
    : RATE_JUMP_LIMIT_PCT_PER_BEAT;
  if (rateJumpPctPerBeat > rateLimit) failures.push('rate-jump');
  const suggestion: QualitySuggestion = {
    widenHandoff: bassBumpDb > BASS_BUMP_LIMIT_DB,
    enableVocalDuck: known && vocalOverlapBeats > 0,
    shortenFade: vocalOverlapBeats > VOCAL_OVERLAP_LIMIT_BEATS,
    // 只是提示，真实增益来自 transitionMatchDb；单次最多 ±2 dB，避免「一进来就炸」。
    gainTrimDb: round2(clamp((input.gainTrimDb ?? 0) + clamp(loudnessDriftLu * 0.25, -2, 2), -6, 6)),
    tempoRate: clamp(input.tempoRate, 0.8, 1.2),
  };
  return {
    bassBumpDb,
    vocalOverlapBeats,
    vocalClashBeats,
    loudnessDriftLu,
    rateJumpPctPerBeat,
    pass: failures.length === 0,
    failures,
    suggestion,
    curve: ramp && ramp.lufs.length > 0 ? { ps: ramp.ps, lufs: ramp.lufs } : undefined,
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 人声让位的最大深度（dB）：−6 dB 足够让另一首钻出来，再深 A 会变电话音。 */
export const DUCK_MAX_DB = -6;

/** 让位触发阈值：B 的人声活动度超过它才算"在唱"。 */
export const DUCK_TRIGGER = 0.45;
/**
 * 弱唱词的兜底触发线。
 *
 * `DUCK_TRIGGER` 是「明确在唱」的线；但有些歌末段是低吟/和声垫/混在伴奏里的哼唱，
 * 活动度稳定在 0.30–0.45，用 0.45 一刀切会让整段「有唱词但没人声可交接」——表现就是
 * 计划里 handoff=false、B 一开播就唱、两边糊在一起（体检台 `NO_HANDOFF`）。
 * 所以 0.30–0.45 之间给一条浅让位（1.5–3.0 dB），既承认「确实在唱」，又不把伴奏压空。
 */
export const DUCK_TRIGGER_SOFT = 0.3;

export interface DuckEvent {
  /** 相对过渡起点的偏移（ms）。 */
  offsetMs: number;
  /** 目标增益（dB，0 … −6）。 */
  db: number;
}

/**
 * 层 C：按 B 的人声活动度生成 A 的让位曲线。
 *
 * 用一阶平滑（attack 20 ms / release 80 ms）在 40 ms 网格上采样：attack 快是为了
 * 人声一进来就让开，release 慢是为了不在字与字之间"抽气"。
 */
export function buildDuckEvents(input: {
  b: BeatAnalysis;
  /**
   * A 的活动度曲线。给了就只在「两边真的同时有人声」时让位——
   * 这是 1.2.11 的修正：以前只看 B，B 每唱一句就把 A 的存在感压一次，
   * 20 s 的长窗里听感就是「A 被按下去 → 松开 → 又按下去」。
   * 不给则退回只看 B 的旧行为（老调用方与测试兼容）。
   */
  a?: BeatAnalysis;
  fadeStartBMs: number;
  /** A 侧同刻的文件毫秒起点（默认 0）；只在给了 `a` 时有意义。 */
  fadeStartAMs?: number;
  fadeMs: number;
  tempoRate: number;
  maxDuckDb?: number;
  attackMs?: number;
  releaseMs?: number;
  stepMs?: number;
  /**
   * 这道门之前的 B 一律不许触发让位（B 的文件毫秒）。
   * 用 `firstStrongVocalMs` 的结果：B 前奏里的人声切片/呼吸不能把 A 压闷，
   * 否则「一进过渡 A 就像被加了低音」（实测春めく前奏第 2 秒就有 0.57 的假峰）。
   */
  gateBeforeMs?: number;
  /** A 是纯器乐时让位深度减半：没有人声要躲，压 2.5 kHz 只会让 A 变闷。 */
  aInstrumental?: boolean;
}): DuckEvent[] {
  const curve = input.b.activity;
  if (!curve || !Array.isArray(curve.vocal) || curve.vocal.length === 0) return [];
  const aCurve = input.a?.activity;
  const aVocal = aCurve && Array.isArray(aCurve.vocal) && aCurve.vocal.length > 0 ? aCurve : null;
  const stepMs = input.stepMs ?? 40;
  const attack = input.attackMs ?? 30;
  const release = input.releaseMs ?? 140;
  const baseDuck = input.maxDuckDb ?? DUCK_MAX_DB;
  const maxDuck = input.aInstrumental ? Math.max(baseDuck, DUCK_MAX_DB / 2) : baseDuck;
  const gateMs = Number.isFinite(input.gateBeforeMs) ? (input.gateBeforeMs as number) : 0;
  const aStartMs = input.fadeStartAMs ?? 0;
  // A 也要在唱才算「撞上」：A 是器乐尾奏/换气时，把它的 2.5 kHz 收下去只会变闷。
  const A_COLLIDE = 0.28;
  // 撞上要连续一小段才算数：前奏里的呼吸、切片只有一两个采样点，一碰就压是「抽一下」。
  const sustainMs = Math.max(80, Math.min(240, stepMs * 3));
  const events: DuckEvent[] = [];
  let current = 0;
  let overlapMs = 0;
  let ducking = false;
  const steps = Math.max(1, Math.floor(input.fadeMs / stepMs));
  for (let i = 0; i <= steps; i += 1) {
    const offsetMs = i * stepMs;
    const bMs = input.fadeStartBMs + offsetMs * input.tempoRate;
    const vocal = sampleActivity(curve, bMs)[0];
    const aLevel = aVocal ? sampleActivity(aVocal, aStartMs + offsetMs)[0] : 1;
    const gated = bMs < gateMs - 1;
    const collide = !gated && vocal > DUCK_TRIGGER_SOFT && aLevel > A_COLLIDE;
    if (collide) overlapMs += stepMs;
    else overlapMs = 0;
    if (!ducking && overlapMs >= sustainMs) ducking = true;
    // 滞回：B 掉到软阈值以下 15%，或 A 已经不在唱，才松手——唱句里换气不再「一回一压」。
    if (ducking && (gated || vocal < DUCK_TRIGGER_SOFT * 0.85 || (aVocal && aLevel < A_COLLIDE * 0.8))) ducking = false;
    // 深度跟着两边的演唱强度走：两边都唱得实才压到底，否则只压三分之一。
    const depth = ducking
      ? Math.max(0.35, Math.min(1, (vocal - DUCK_TRIGGER_SOFT) / 0.5) * Math.min(1, aLevel / 0.6))
      : 0;
    const target = ducking ? maxDuck * depth : 0;
    const tau = target < current ? attack : release;
    const alpha = 1 - Math.exp(-stepMs / Math.max(1, tau));
    current += (target - current) * alpha;
    events.push({ offsetMs, db: Math.round(current * 100) / 100 });
  }
  return events;
}

/**
 * 由响度曲线推出补平量：把整窗的最高点当基准，把低于它的部分按 dB 填回来。
 *
 * 只抬不降、上限 `capDb`（默认 3 dB）：
 *   - 只抬：`loudnessTrim` 是「补平」不是「压限」，压下来会把本来合适的窗口压扁；
 *   - 3 dB 上限：塌到 4 LU 以上多半是编曲换段（副歌→主歌），硬补会把人声抬得突出来。
 */
export function loudnessTrimCurve(
  curve: Pick<LoudnessRamp, 'ps' | 'lufs'>,
  capDb = 3,
  leadP = 0.12,
): { ps: number[]; db: number[] } {
  if (curve.lufs.length < 3) return { ps: [], db: [] };
  const ref = Math.max(...curve.lufs);
  const raw = curve.lufs.map((v) => Math.max(0, Math.min(capDb, ref - v)));
  const lead = Math.max(0, Math.min(0.4, leadP));
  if (lead <= 0) return { ps: curve.ps.slice(), db: raw.map(round2) };
  // 「抬升提前」：用前视最大值把补偿量提前 lead 个窗口宽度落下——
  // 塌陷还没到，电平台阶已经在爬，听感是「呼吸先张开」而不是「掉了再补」。
  const out = raw.map((_, i) => {
    const limit = curve.ps[i] + lead;
    let best = raw[i];
    for (let j = i; j < raw.length && curve.ps[j] <= limit; j++) best = Math.max(best, raw[j]);
    return best;
  });
  // 前视的硬边会形成台阶，用 3 点均值柔一次（不改变峰值，只把角磨圆）。
  const smooth = out.map((v, i) => {
    const a = out[Math.max(0, i - 1)];
    const b = out[Math.min(out.length - 1, i + 1)];
    return Math.max(v, (a + v + b) / 3);
  });
  return { ps: curve.ps.slice(), db: smooth.map(round2) };
}
