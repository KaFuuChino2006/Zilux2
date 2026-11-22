/**
 * 唱词锚点：从**活动度曲线**找出人声段落，把过渡落到指定的唱词时段。
 *
 * 为什么需要它：`crossfadeDeck` 原来的「歌词衔接」完全依赖歌词时间轴
 * （`options.currentLastVocalEndMs` / `options.nextVocalStartMs`）。没歌词、歌词没对齐、
 * 或者用户只想从副歌人声进来时，那套就失效了。宿主 p1-0 起每首歌都带
 * `activity.vocal`（250 ms 一格），足够回答三个问题：
 *
 * 1. A 的最后一句唱到哪结束（决定淡化起点、以及尾奏能留多长给 A 独听）；
 * 2. B 的第一个唱词在哪（决定淡化终点）；
 * 3. B 的副歌人声 / 最强人声在哪（「自由衔接」——让 B 的前奏/主歌先垫在 A 下面，
 *    淡化正好落在 B 开唱的那一刻）。
 *
 * 全部是纯函数，只吃曲线、不碰音频，阈值改动必须有单测跟着改。
 */
import type { BeatAnalysis } from '../../online/analysis';

/** 判定「在唱」的活动度阈值（0–1，与 `v2Quality.DUCK_TRIGGER` 同源）。 */
export const VOCAL_THRESHOLD = 0.45;

/** 两段之间超过这么久的静默才切成两段（字与字之间的换气不算断句）。 */
export const VOCAL_GAP_MS = 600;

/** 短于这个长度的段落当成噪声丢掉（一个"啊"不算一句）。 */
export const VOCAL_MIN_SEGMENT_MS = 700;

/** 一段的平均活动度低于这个值不算「唱句」（纯器乐的主旋律常常落在 0.4–0.55）。 */
export const VOCAL_MIN_MEAN = 0.55;

/**
 * 整首歌到底有没有人声。
 *
 * `activity.vocal` 是按 95 分位归一化的**相对**曲线：纯器乐（合成器主旋律、弦乐垫底）
 * 在 300–3500 Hz 也很「谐波」，归一化之后照样有 0.9 的峰。所以只看「有没有高段」
 * 会把器乐误判成有人声 —— 于是末句被锚在歌中间，过渡在歌没放完时就开始了。
 *
 * 真正的判据是**形状**：人声是「断续的」且**动态大**（有气口、有强弱）；
 * 器乐主旋律是连续的、平的。两条一起看：
 * - 连续「在唱」的比例 > 0.85 → 更像器乐主旋律/铺底；
 * - p90 与中位数的差 < 0.18 → 没有动态，不像人声。
 */
export interface VocalPresenceDetail {
  kind: 'vocal' | 'instrumental' | 'unknown';
  /** 活动度超过阈值的帧占比（0–1）。 */
  voiced: number;
  /** p98 − p50，衡量「有没有进进出出的动态」。 */
  contrast: number;
  /** 人类可读的判定理由，日志与浮层直接显示，避免「静默失效」。 */
  reason: string;
}

/**
 * 判定这首先「像不像有人声」。除了三态结果，还给出占比与理由 ——
 * 之前只有三态，一旦判成器乐，下游就静默关掉唱词锚点，用户只看到「不生效」却无从判断原因。
 */
export function vocalPresenceDetail(analysis: BeatAnalysis): VocalPresenceDetail {
  const curve = analysis.activity?.vocal;
  if (!curve || curve.length < 8) {
    return { kind: 'unknown', voiced: 0, contrast: 0, reason: '没有人声活动度曲线' };
  }
  const values = Array.from(curve).filter((v) => Number.isFinite(v));
  if (values.length < 8) {
    return { kind: 'unknown', voiced: 0, contrast: 0, reason: '人声曲线有效点太少' };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
  const voiced = values.filter((v) => v > VOCAL_THRESHOLD).length / values.length;
  // 用 p98 而不是 p90：真实的歌里人声只占 20–50% 的时间，p90 常常还落在「背景」上，
  // 会把人声歌判成器乐（那样整条唱词锚点就白做了）。
  const contrast = pick(0.98) - pick(0.5);
  if (voiced > 0.85) {
    // 注意：连贯说唱/整段人声也会落进这里（活动度长期在阈值以上）。
    // 判定仍按「没有进出＝不像有唱句可分」走，但理由要写出来，
    // 并给用户 `zilux2.dev.anchorforce=1` 强制启用锚点的逃生口。
    return {
      kind: 'instrumental',
      voiced,
      contrast,
      reason: `人声活动度几乎全程超过阈值（${(voiced * 100).toFixed(0)}%），没有唱句间隙`,
    };
  }
  if (contrast < 0.18) {
    return {
      kind: 'instrumental',
      voiced,
      contrast,
      reason: `动态太平（p98−p50 = ${contrast.toFixed(2)}），不像人声进出`,
    };
  }
  if (voiced < 0.02) {
    return {
      kind: 'instrumental',
      voiced,
      contrast,
      reason: `几乎全程无人声（占比 ${(voiced * 100).toFixed(1)}%）`,
    };
  }
  return { kind: 'vocal', voiced, contrast, reason: `人声占比 ${(voiced * 100).toFixed(0)}%` };
}

export function vocalPresence(
  analysis: BeatAnalysis,
): 'vocal' | 'instrumental' | 'unknown' {
  return vocalPresenceDetail(analysis).kind;
}

export type VocalAnchorMode = 'auto' | 'first' | 'chorus' | 'strongest' | 'off';

export interface VocalSegment {
  /** 段落起点（曲内毫秒）。 */
  startMs: number;
  /** 段落终点（曲内毫秒）。 */
  endMs: number;
  /** 段落内平均活动度（0–1）。 */
  mean: number;
  /** 段落内峰值活动度（0–1）。 */
  peak: number;
}

/**
 * 把 `activity.vocal` 切成「唱句」。
 *
 * 曲线是 250 ms 一格，段落边界精度也就是 ±125 ms —— 对「淡化终点落在第一个字之前
 * 150 ms」这个用途够用；真要毫秒级对齐得靠歌词或模型，这里不假装更准。
 */
export function findVocalSegments(
  analysis: BeatAnalysis,
  options: { threshold?: number; gapMs?: number; minSegmentMs?: number } = {},
): VocalSegment[] {
  const curve = analysis.activity;
  if (!curve || !Array.isArray(curve.vocal) || curve.vocal.length === 0) return [];
  const hop = Number.isFinite(curve.hopMs) && curve.hopMs > 0 ? curve.hopMs : 250;
  const threshold = options.threshold ?? VOCAL_THRESHOLD;
  const gapMs = options.gapMs ?? VOCAL_GAP_MS;
  const minSegmentMs = options.minSegmentMs ?? VOCAL_MIN_SEGMENT_MS;

  const segments: VocalSegment[] = [];
  let start = -1;
  let silent = 0;
  let sum = 0;
  let count = 0;
  let peak = 0;

  const flush = (endFrame: number): void => {
    if (start < 0) return;
    const lengthMs = (endFrame - start) * hop;
    if (lengthMs >= minSegmentMs && count > 0 && sum / count >= VOCAL_MIN_MEAN) {
      segments.push({
        startMs: Math.round(start * hop),
        endMs: Math.round(endFrame * hop),
        mean: Math.round((sum / count) * 1000) / 1000,
        peak: Math.round(peak * 1000) / 1000,
      });
    }
    start = -1;
    silent = 0;
    sum = 0;
    count = 0;
    peak = 0;
  };

  for (let i = 0; i < curve.vocal.length; i += 1) {
    const value = curve.vocal[i] ?? 0;
    if (value > threshold) {
      if (start < 0) start = i;
      silent = 0;
      sum += value;
      count += 1;
      if (value > peak) peak = value;
    } else if (start >= 0) {
      silent += 1;
      // 静默够久才算这句唱完；句内换气（<600 ms）继续算在同一段里。
      // 用毫秒比较而不是帧数：250 ms 一帧时 round(600/250)=2 帧只有 500 ms，
      // 会把换气误判成断句。
      if (silent * hop >= gapMs) flush(i - silent + 1);
    }
  }
  flush(curve.vocal.length);

  return segments;
}

/** 歌词锚点与曲线锚点差超过这么多小节，就判定其中一个错了（歌词错位/别版最常见）。 */
export const ANCHOR_DISAGREE_BARS = 8;

/**
 * 双源仲裁：歌词给的是**精确但可能错位**的坐标，活动度曲线给的是**粗糙但一定对版**的坐标。
 *
 * 错位歌词是真实存在的（LRC 别版、整轨偏移、现场版套录音室版歌词）。以前无条件优先歌词，
 * 结果就是「有些歌取词取到歌曲中段去了」「明明没唱完就过渡」—— 那些歌的歌词时间轴本就是错的。
 *
 * 规则：
 * - 一边有值就用它；
 * - 都在且差 ≤ `toleranceBars` 小节 → 用歌词（毫秒精度更高）；
 * - 差得太远 → 用曲线（对版优先于精度）。
 */
export function reconcileVocalAnchor(input: {
  lyricMs: number;
  curveMs: number;
  barMs: number;
  toleranceBars?: number;
}): { ms: number; source: 'lyric' | 'curve' | 'none'; reason: string } {
  const lyric = Number.isFinite(input.lyricMs) && input.lyricMs > 0 ? input.lyricMs : 0;
  const curve = Number.isFinite(input.curveMs) && input.curveMs > 0 ? input.curveMs : 0;
  if (lyric <= 0 && curve <= 0) return { ms: 0, source: 'none', reason: '无歌词也无唱句' };
  if (lyric <= 0) return { ms: curve, source: 'curve', reason: '无歌词，用活动度曲线' };
  if (curve <= 0) return { ms: lyric, source: 'lyric', reason: '无唱句曲线，用歌词' };
  const barMs = input.barMs > 0 ? input.barMs : 2000;
  const tolerance = Math.max(2000, (input.toleranceBars ?? ANCHOR_DISAGREE_BARS) * barMs);
  const diff = Math.abs(lyric - curve);
  if (diff <= tolerance) {
    return { ms: lyric, source: 'lyric', reason: `歌词与曲线差 ${Math.round(diff)} ms，取歌词` };
  }
  return {
    ms: curve,
    source: 'curve',
    reason: `歌词与曲线差 ${Math.round(diff)} ms（> ${Math.round(tolerance)}），歌词疑似错位，取曲线`,
  };
}

/**
 * A 的末句锚点能不能用。
 *
 * 判据只有一条：末句离可听结尾不能太远。超过一次过渡的最大长度（32 s）还当作「末句」，
 * 说明检测漏了后面的唱段（或歌词错位）—— 这时宁可不锚，让过渡照常落在结尾，
 * 也好过在歌正唱到一半时开始混。
 */
export function tailAnchorUsable(
  lastVocalEndMs: number,
  audibleEndMs: number,
  maxTailMs: number,
): boolean {
  if (!Number.isFinite(lastVocalEndMs) || lastVocalEndMs <= 0) return false;
  if (!Number.isFinite(audibleEndMs) || audibleEndMs <= 0) return true;
  return audibleEndMs - lastVocalEndMs <= maxTailMs;
}

/** A 侧：可听结尾之前最后一个唱句的结束点；没有则 0。 */
export function lastVocalEnd(analysis: BeatAnalysis, beforeMs: number): number {
  if (vocalPresence(analysis) === 'instrumental') return 0;
  const segments = findVocalSegments(analysis);
  let best = 0;
  for (const segment of segments) {
    if (segment.endMs <= beforeMs && segment.endMs > best) best = segment.endMs;
  }
  return best;
}

export interface VocalEntry {
  /** 目标唱句的起点（曲内毫秒）：淡化应当正好落在这里。 */
  ms: number;
  /** 命中的方式，写进日志用。 */
  kind: 'first' | 'chorus' | 'strongest' | 'lyrics';
  /** 人读说明。 */
  reason: string;
}

/**
 * B 侧：挑一个「唱词入口」。
 *
 * - `first`：最早一个完整唱句（最保守，等价于原来的歌词衔接首句）；
 * - `chorus`：优先落在 `chorus` / `drop` 段开头附近的唱句（B 直接从副歌人声进来）；
 * - `strongest`：平均活动度最高的唱句（通常就是副歌最饱满那句）；
 * - `auto`：交给调用方决定（这里按 `first` 处理）。
 *
 * `fromMs` 之后才考虑：避免锚到 B 的第 0 秒（那是淡入区，锚上去等于没锚）。
 */
export function selectVocalEntry(
  analysis: BeatAnalysis,
  mode: VocalAnchorMode,
  options: { fromMs?: number; barMs?: number; clearRunMs?: number } = {},
): VocalEntry | null {
  if (mode === 'off') return null;
  if (vocalPresence(analysis) === 'instrumental') return null;
  const from = Math.max(0, options.fromMs ?? 0);
  const barMs = options.barMs && options.barMs > 0 ? options.barMs : 0;
  const all = findVocalSegments(analysis).filter((s) => s.startMs >= from);
  if (!all.length) return null;
  // 穿插要求：入口之前要有一段「干净器乐」能让 B 的乐器先垫进来。
  // 否则 B 的前一句人声会落在窗口里，和 A 的末句打架。
  const clearRunMs = options.clearRunMs && options.clearRunMs > 0 ? options.clearRunMs : 0;
  const segments = clearRunMs > 0
    ? all.filter((candidate) => {
        const previous = all.filter((s) => s.endMs <= candidate.startMs).pop();
        return !previous || candidate.startMs - previous.endMs >= clearRunMs;
      })
    : all;
  if (!segments.length) {
    // 整首都在连着唱（说唱/连贯人声）：没有干净器乐段可穿插，退回普通选点，
    // 交叠期靠层 C 人声让位处理。
    const fallback = all[0]!;
    return {
      ms: fallback.startMs,
      kind: 'first',
      reason: `没有 ${Math.round(clearRunMs / 1000)} s 干净器乐段可穿插，退回 ${fallback.startMs} ms`,
    };
  }

  const first = segments[0]!;
  if (mode === 'first' || mode === 'auto') {
    return { ms: first.startMs, kind: 'first', reason: `首句 ${first.startMs} ms` };
  }

  if (mode === 'strongest') {
    let best = segments[0]!;
    for (const segment of segments) if (segment.mean > best.mean) best = segment;
    return {
      ms: best.startMs,
      kind: 'strongest',
      reason: `最强唱句 ${best.startMs} ms（均值 ${best.mean}）`,
    };
  }

  // chorus：找 chorus / drop 段落起点，取「起点前后一个乐句内」最靠前的唱句。
  const sections = (analysis.sections ?? []).filter(
    (section) => (section.label === 'chorus' || section.label === 'drop') && section.startMs >= from,
  );
  const windowMs = barMs > 0 ? barMs * 4 : 8000;
  for (const section of sections) {
    for (const segment of segments) {
      if (segment.startMs >= section.startMs - windowMs * 0.5 && segment.startMs <= section.startMs + windowMs) {
        return {
          ms: segment.startMs,
          kind: 'chorus',
          reason: `${section.label} 段人声 ${segment.startMs} ms（段起点 ${Math.round(section.startMs)}）`,
        };
      }
    }
  }

  return {
    ms: first.startMs,
    kind: 'first',
    reason: `没有副歌人声可用，退回首句 ${first.startMs} ms`,
  };
}

/** 器乐尾端锚点的类型：乐句起点 / 小节（强拍）/ 退到可听结尾。 */
export type InstrumentalAnchorKind = 'phrase' | 'bar' | 'end';

export interface InstrumentalAnchor {
  /** 文件毫秒：B 应该从这里开始垫进来（A 从这里开始让位）。 */
  ms: number;
  kind: InstrumentalAnchorKind;
  /** 该点到可听结尾的距离（小节数，向上取整），便于浮层显示与断言。 */
  barsFromEnd: number;
}

export interface InstrumentalAnchorInput {
  /** 截止点（通常是可听结尾）。 */
  beforeMs?: number;
  /** 一小节多长；缺省用 `beatIntervalMs*4`，再不行用强拍间隔中位数。 */
  barMs?: number;
  /** 尾段最多回溯多久（默认 `MAX_FADE_MS` = 32 s，和唱词锚点守卫同一个上限）。 */
  maxTailMs?: number;
  /** 尾段至少留几小节（默认 2：少于两小节就听不出"让位"，不如不锚）。 */
  minTailBars?: number;
}

const INST_MAX_TAIL_MS = 32_000;
const INST_MIN_TAIL_BARS = 2;

function barMsOf(analysis: BeatAnalysis, explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 100) return explicit;
  if (typeof analysis.beatIntervalMs === 'number' && analysis.beatIntervalMs > 100) {
    const meter = typeof analysis.meter === 'number' && analysis.meter >= 2 && analysis.meter <= 8
      ? analysis.meter
      : 4;
    return analysis.beatIntervalMs * meter;
  }
  const downbeats = analysis.downbeats;
  if (Array.isArray(downbeats) && downbeats.length >= 2) {
    const diffs: number[] = [];
    for (let i = 1; i < downbeats.length && diffs.length < 16; i += 1) {
      const diff = downbeats[i] - downbeats[i - 1];
      if (diff > 120 && diff < 5000) diffs.push(diff);
    }
    if (diffs.length > 0) {
      diffs.sort((a, b) => a - b);
      return diffs[Math.floor(diffs.length / 2)];
    }
  }
  return 2000;
}

/**
 * 纯音乐（没有唱词）的尾端结构锚点。
 *
 * 唱词锚点问的是"A 的最后一句唱到哪"；器乐曲没有这一句，但**结构上**仍有一个"该让位"的点：
 * 最后一个乐句的起点（或强拍）。从那里开始让位，A 剩下的那一个乐句刚好放完，B 在前一拍垫进来，
 * 听感就是"前两分钟纯音乐无缝接到下一首"。
 *
 * 只在 `vocalPresence(analysis) === 'instrumental'` 时由调用方使用——器乐判定错了会把过渡提前，
 * 所以门控放在调用方，这里只负责"给定尾段，找最晚的合法结构点"。
 */
export function instrumentalAnchor(
  analysis: BeatAnalysis,
  input: InstrumentalAnchorInput = {},
): InstrumentalAnchor | null {
  const audibleEnd = typeof analysis.audibleEndMs === 'number' && analysis.audibleEndMs > 0
    ? analysis.audibleEndMs
    : 0;
  const end = Math.min(
    typeof input.beforeMs === 'number' && Number.isFinite(input.beforeMs) ? input.beforeMs : audibleEnd,
    audibleEnd > 0 ? audibleEnd : Number.POSITIVE_INFINITY,
  );
  if (!(end > 0)) return null;
  const barMs = barMsOf(analysis, input.barMs);
  const maxTail = typeof input.maxTailMs === 'number' && input.maxTailMs > 0 ? input.maxTailMs : INST_MAX_TAIL_MS;
  const minTailBars = typeof input.minTailBars === 'number' && input.minTailBars >= 1 ? input.minTailBars : INST_MIN_TAIL_BARS;
  const minTail = barMs * minTailBars;

  const usable = (ms: number): boolean => {
    if (!Number.isFinite(ms) || ms < 0) return false;
    const tail = end - ms;
    return tail >= minTail && tail <= maxTail;
  };

  let phrase: number | null = null;
  const phraseStarts = analysis.phraseStartsMs;
  if (Array.isArray(phraseStarts)) {
    for (const ms of phraseStarts) {
      if (usable(ms) && (phrase === null || ms > phrase)) phrase = ms;
    }
  }
  if (phrase !== null) {
    return { ms: phrase, kind: 'phrase', barsFromEnd: Math.ceil((end - phrase) / barMs) };
  }

  let bar: number | null = null;
  const downbeats = analysis.downbeats;
  if (Array.isArray(downbeats)) {
    for (const ms of downbeats) {
      if (usable(ms) && (bar === null || ms > bar)) bar = ms;
    }
  }
  if (bar !== null) {
    return { ms: bar, kind: 'bar', barsFromEnd: Math.ceil((end - bar) / barMs) };
  }

  // 连强拍都没有（极短的段 / 分析失败）：退到"结尾往前 2 小节"，仍比从结尾切断好。
  const fallback = Math.round(end - Math.min(maxTail, minTail));
  if (fallback > 0 && end - fallback >= barMs) {
    return { ms: fallback, kind: 'end', barsFromEnd: Math.ceil((end - fallback) / barMs) };
  }
  return null;
}

/** 「真正开始唱」的强判定：曲线连续 ≥ 该值 1500 ms 才算第一句。 */
export const STRONG_VOCAL_THRESHOLD = 0.6;
export const STRONG_VOCAL_HOLD_MS = 1500;

/**
 * 第一句「真唱」的起点（文件毫秒）。
 *
 * 为什么需要它：`findVocalSegments` 用的是 0.45 阈值 + 600 ms 断句，前奏里的
 * 人声切片、呼吸、和声垫都会命中（春めく 的前奏在第 2 秒就有一个 0.57 的短峰），
 * 于是「B 的第一句」被算成 2 s，而耳朵听到的第一句在 17 s。
 * 这里改成「连续 1.5 s 都在 0.6 以上」——短峰过不了，真正开唱才过。
 *
 * 没有曲线、或整首都不达标时返回 0（调用方退回原判定）。
 */
/**
 * B 的第一句「唱句」起点（按段判定，不按连续强度）。
 *
 * `firstStrongVocalMs` 要求连续 1.5 s ≥0.6，遇到「第一句比较轻、第二句才唱满」的歌会跳到第二、
 * 第三句 —— 用户听到的就是「过渡完了往后好多句才开始唱」。这里改成用切句结果：
 * 第一段时长 ≥1.2 s 且均值 ≥0.5 就算第一句（0.75 s 的呼吸/切片自然被排除）。
 */
export function firstVocalLineMs(
  analysis: BeatAnalysis,
  options: { fromMs?: number; minMs?: number; minMean?: number } = {},
): number {
  const fromMs = Math.max(0, options.fromMs ?? 0);
  // 默认 1200 ms：段门槛由 findVocalSegments 先把关（≥700 ms、均值 ≥0.55），这里再要
  // 1.2 s 是为了滤掉「前奏里的单次呼吸/切片峰」——春めく 前奏第 2 秒就有一个 750 ms 的峰，
  // 放行它会把整个过渡压成 2 s。
  // 有些歌第一句本身就很短（Charlie Puth《Attention》开头那句 750 ms），需要放行时由调用方
  // 传 minMs: 600（浮层开关「短句也算第一句」）。
  const minMs = Math.max(200, options.minMs ?? 1_200);
  const minMean = Math.max(0, Math.min(1, options.minMean ?? 0.5));
  if (vocalPresence(analysis) === 'instrumental') return 0;
  const segments = findVocalSegments(analysis);
  for (const segment of segments) {
    if (segment.endMs <= fromMs) continue;
    if (segment.endMs - segment.startMs >= minMs && segment.mean >= minMean) {
      return Math.max(fromMs, Math.round(segment.startMs));
    }
  }
  const first = segments.find((segment) => segment.endMs > fromMs);
  return first ? Math.max(fromMs, Math.round(first.startMs)) : 0;
}

export function firstStrongVocalMs(
  analysis: BeatAnalysis | null | undefined,
  options: { threshold?: number; holdMs?: number; fromMs?: number } = {},
): number {
  const curve = analysis?.activity?.vocal;
  if (!Array.isArray(curve) || curve.length < 2) return 0;
  const hop = Math.max(20, Math.round(analysis?.activity?.hopMs ?? 250));
  const threshold = options.threshold ?? STRONG_VOCAL_THRESHOLD;
  const holdMs = options.holdMs ?? STRONG_VOCAL_HOLD_MS;
  const fromMs = Math.max(0, options.fromMs ?? 0);
  const needFrames = Math.max(1, Math.ceil(holdMs / hop));
  const first = Math.max(0, Math.floor(fromMs / hop));
  let runStart = -1;
  let run = 0;
  for (let i = first; i < curve.length; i += 1) {
    const value = curve[i];
    if (Number.isFinite(value) && value >= threshold) {
      if (run === 0) runStart = i;
      run += 1;
      if (run >= needFrames) {
        // activity 曲线是「文件时间」：index 0 = 文件第 0 秒。
        // 不要加 cueInMs——那是「从哪一秒开始播」的建议点（本机实测 30–48 s），
        // 加到曲线时间上会把入口推到歌中间（踩过）。
        return Math.round(runStart * hop);
      }
    } else {
      run = 0;
      runStart = -1;
    }
  }
  return 0;
}

/**
 * 某个时刻附近有没有真实唱句能量（用于**验证歌词坐标**，而不是盲信或盲弃）。
 *
 * 歌词是毫秒精度的，但网易云/QQ 的 LRC 经常整体偏移（不同版本、剪辑版、翻唱），
 * 而 activity 曲线一定对版、只是段边界粗。所以判据不是「谁更晚」，而是
 * 「歌词说的那个位置，音频里到底有没有人在唱」。
 */
export function vocalEnergyNear(
  analysis: BeatAnalysis,
  ms: number,
  options: { beforeMs?: number; afterMs?: number; threshold?: number } = {},
): number {
  const vocal = analysis.activity?.vocal;
  if (!vocal || vocal.length < 2) return 0;
  const hop = Math.max(50, analysis.activity?.hopMs || 250);
  const before = Math.max(0, options.beforeMs ?? 500);
  const after = Math.max(0, options.afterMs ?? 2000);
  const from = Math.max(0, Math.floor((ms - before) / hop));
  const to = Math.min(vocal.length - 1, Math.ceil((ms + after) / hop));
  let peak = 0;
  for (let i = from; i <= to; i++) if (vocal[i] > peak) peak = vocal[i];
  return peak;
}
