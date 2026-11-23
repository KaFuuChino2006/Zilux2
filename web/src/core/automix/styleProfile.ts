/**
 * 风格画像（契约 §3）：把 BeatAnalysis、可选的元数据/歌词与宿主 StyleFeaturePayload
 * 折算成多标签 0..1 打分、主标签、mood、人声三态、语言与人类可读证据。
 *
 * 纯函数：不碰 DOM、不读时钟、不写全局。阈值全部集中在 STYLE_THRESHOLDS，
 * 改动任何阈值都必须同步 web/tests/styleProfile.test.cjs 的 fixture。
 *
 * 「四踩规律性 / 低频规律性」没有直接测量：用活动度曲线在「一拍滞后」上的
 * Pearson 相关做代理（稳定四踩 / 稳定 bassline 的相关接近 1，切分多的段落更低）。
 */

import type { BeatAnalysis } from '../../online/analysis';
import type { StyleFeaturePayload } from '../../online/analysisFeatures';
import { VOCAL_THRESHOLD, vocalPresence } from './vocalAnchor';

export type StyleTag =
  | 'punk'
  | 'rock'
  | 'metal'
  | 'electronic'
  | 'hiphop'
  | 'pop'
  | 'ballad'
  | 'acoustic'
  | 'ambient'
  | 'instrumental';

/** 语言判定结果；判定顺序 meta > lyrics > 文本假名/汉字比例 > other。 */
type StyleLanguage = 'ja' | 'zh' | 'en' | 'other';

export interface StyleProfile {
  v: 1;
  source: 'dsp' | 'dsp+meta';
  tags: Partial<Record<StyleTag, number>>;
  primary: StyleTag;
  mood: 'sad' | 'neutral' | 'upbeat';
  vocal: 'vocal' | 'instrumental' | 'uncertain';
  language?: StyleLanguage;
  confidence: number;
  evidence: string[];
}

export interface StyleProfileInput {
  analysis: BeatAnalysis;
  meta?: { title?: string; artist?: string; genre?: string; language?: string };
  lyrics?: { language?: string; text?: string };
  styleFeatures?: StyleFeaturePayload | null;
}

/** 输出/遍历顺序：分数并列时排在前面的标签优先当主标签。 */
export const STYLE_TAG_ORDER: readonly StyleTag[] = [
  'punk',
  'rock',
  'metal',
  'electronic',
  'hiphop',
  'pop',
  'ballad',
  'acoustic',
  'ambient',
  'instrumental',
];

/**
 * 契约 §3 判定口径的数值化。定性描述 → 阈值：
 * - 「高 tonalness」= 0.6；「低 highRatio」= 0.08；「percussivity 低」= 0.3；
 * - pop 的「无强失真」= highRatioMean < 0.12（与 rock 的入口同一条线）；
 * - 「四踩规律性 / 低频规律性」= 活动度曲线在一拍滞后上的相关（0..1）。
 * ramp.* 是阈值附近的软边宽度：分数 = Π clamp01(0.5 + (值-阈值)/(2*宽度))，
 * 恰好等于阈值时 0.5，越过阈值一个宽度即 1。
 */
export const STYLE_THRESHOLDS = {
  ramp: {
    // 0.004：C# 侧 `highRatio` 是「8 kHz 以上功率 / 总功率」，实测流行/摇滚都在
    // 0.005–0.03，用 0.02 的软边会让整段区间都处在半信半疑，完全丧失分辨力。
    ratio: 0.004,
    bpm: 6,
    energy: 0.04,
    dynamicLu: 1.5,
    stability: 0.03,
    regularity: 0.05,
    percussivity: 0.04,
    tonalness: 0.06,
    density: 0.04,
  },
  minTagScore: 0.05,
  unknown: { primary: 0.12, tag: 'pop' },
  coverage: { features: 0.4, activity: 0.2, tempoStability: 0.15, key: 0.15, energy: 0.1 },
  confidence: { coverageWeight: 0.45, separationWeight: 0.35, topWeight: 0.2, separationSpan: 0.35 },
  // highRatio 阈值按「8 kHz 以上占比」的真实刻度标定；flatness 已由 C# 输出幅度域值。
  punk: { highRatioMean: 0.018, flatnessMean: 0.22, minBpm: 140, drumMedian: 0.55 },
  metal: { highRatioMean: 0.022, flatnessMean: 0.26, minBpm: 120, maxLowRatio: 0.42 },
  rock: { highRatioMean: 0.012, drumMedian: 0.45 },
  electronic: { fourOnFloor: 0.78, tempoStability: 0.88, bassRegularity: 0.7 },
  hiphop: { minBpm: 70, maxBpm: 105, minLowRatio: 0.38, minVocalDensity: 0.4 },
  pop: { meter: 4, minBpm: 95, maxBpm: 130, minVocalDensity: 0.35, maxHighRatio: 0.08 },
  ballad: { maxBpm: 95, maxEnergy: 0.45, minDynamicRangeLu: 8 },
  acoustic: { minTonalness: 0.6, maxHighRatio: 0.05, maxPercussivity: 0.3 },
  ambient: { maxEnergy: 0.3, maxPercussivity: 0.2, minDynamicRangeLu: 10 },
  instrumental: { score: 0.95 },
  mood: { sadMaxEnergy: 0.4, upbeatMinEnergy: 0.6, upbeatMinBpm: 118, balladPresence: 0.55 },
} as const;

const VOCAL_LABEL: Readonly<Record<'vocal' | 'instrumental' | 'unknown', string>> = {
  vocal: '有唱词',
  instrumental: '器乐（无人声）',
  unknown: '不确定',
};

// ---------------------------------------------------------------------------
// 数值工具
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

function round3(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 阈值以上的软隶属度；数据缺失直接 0（宁可不出标签，也不瞎猜）。 */
function rampAbove(value: number | null | undefined, threshold: number, width: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return clamp01(0.5 + (value - threshold) / (2 * width));
}

function rampBelow(value: number | null | undefined, threshold: number, width: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return clamp01(0.5 + (threshold - value) / (2 * width));
}

function rampInside(
  value: number | null | undefined,
  low: number,
  high: number,
  width: number,
): number {
  return Math.min(rampAbove(value, low, width), rampBelow(value, high, width));
}

function mean(values: readonly number[] | null | undefined, unit = false): number | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    sum += unit ? clamp01(value) : value;
    count += 1;
  }
  return count > 0 ? sum / count : null;
}

function median(values: readonly number[] | null | undefined): number | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const clean: number[] = [];
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) clean.push(value);
  }
  if (clean.length === 0) return null;
  clean.sort((left, right) => left - right);
  const mid = Math.floor(clean.length / 2);
  if (clean.length % 2 === 1) return clean[mid];
  return (clean[mid - 1] + clean[mid]) / 2;
}

/** 活动度超过阈值（VOCAL_THRESHOLD）的帧占比；与 genreProfile.vocalDensity 同口径。 */
function density(curve: readonly number[] | null | undefined, threshold: number): number | null {
  if (!Array.isArray(curve) || curve.length < 8) return null;
  let hit = 0;
  let total = 0;
  for (const value of curve) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    total += 1;
    if (value > threshold) hit += 1;
  }
  return total >= 8 ? hit / total : null;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = clamp(Math.round(q * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[index];
}

function dynamicRangeFromLufs(levels: readonly number[] | null | undefined): number | null {
  if (!Array.isArray(levels) || levels.length < 8) return null;
  const clean: number[] = [];
  for (const value of levels) {
    if (typeof value === 'number' && Number.isFinite(value)) clean.push(value);
  }
  if (clean.length < 8) return null;
  clean.sort((left, right) => left - right);
  return percentile(clean, 0.95) - percentile(clean, 0.1);
}

/** 一拍等于几帧（activity 曲线按 hopMs 采样）；无效时 0。 */
function beatLagFrames(analysis: BeatAnalysis): number {
  const hop = finiteOrNull(analysis.activity?.hopMs);
  const beat = finiteOrNull(analysis.beatIntervalMs);
  if (hop === null || hop <= 0 || beat === null || beat <= 0) return 0;
  const lag = Math.round(beat / hop);
  return lag >= 1 && lag <= 64 ? lag : 0;
}

/**
 * 曲线在 lag 帧滞后上的 Pearson 相关，夹到 0..1。
 * 恒定曲线（方差 0）视作「稳定重复」：均值 > 0.3 给 1，否则 0（静音不算四踩）。
 */
function periodicCorrelation(
  curve: readonly number[] | null | undefined,
  lag: number,
): number | null {
  if (!Array.isArray(curve) || lag <= 0) return null;
  const values: number[] = [];
  for (const value of curve) {
    if (typeof value === 'number' && Number.isFinite(value)) values.push(value);
  }
  const pairs = values.length - lag;
  if (pairs < 8) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let count = 0;
  for (let i = 0; i < pairs; i += 1) {
    const x = values[i];
    const y = values[i + lag];
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    count += 1;
  }
  if (count < 8) return null;
  const mx = sx / count;
  const my = sy / count;
  const vx = sxx / count - mx * mx;
  const vy = syy / count - my * my;
  if (vx <= 1e-9 && vy <= 1e-9) return mx > 0.3 ? 1 : 0;
  if (vx <= 1e-9 || vy <= 1e-9) return 0;
  const r = (sxy / count - mx * my) / Math.sqrt(vx * vy);
  return clamp01(r);
}

// ---------------------------------------------------------------------------
// 特征汇总
// ---------------------------------------------------------------------------

interface FeatureStats {
  present: boolean;
  centroidHzMean: number | null;
  flatnessMean: number | null;
  highRatioMean: number | null;
  percussivityMean: number | null;
  tonalnessMean: number | null;
  dynamicRangeLu: number | null;
  lowEnergyRatio: number | null;
  midEnergyRatio: number | null;
  highEnergyRatio: number | null;
  silenceRatio: number | null;
}

function summarizeFeatures(
  analysis: BeatAnalysis,
  payload: StyleFeaturePayload | null,
): FeatureStats {
  const hasCurves = payload !== null && (
    (Array.isArray(payload.centroidHz) && payload.centroidHz.length > 0)
    || (Array.isArray(payload.flatness) && payload.flatness.length > 0)
    || (Array.isArray(payload.highRatio) && payload.highRatio.length > 0)
    || (Array.isArray(payload.percussivity) && payload.percussivity.length > 0)
    || (Array.isArray(payload.tonalness) && payload.tonalness.length > 0)
  );
  const declared = finiteOrNull(payload?.dynamicRangeLu);
  const ratio = (value: unknown): number | null => {
    const numberValue = finiteOrNull(value);
    return numberValue === null ? null : clamp01(numberValue);
  };
  return {
    present: hasCurves,
    centroidHzMean: mean(payload?.centroidHz, false),
    flatnessMean: mean(payload?.flatness, true),
    highRatioMean: mean(payload?.highRatio, true),
    percussivityMean: mean(payload?.percussivity, true),
    tonalnessMean: mean(payload?.tonalness, true),
    dynamicRangeLu: declared ?? dynamicRangeFromLufs(analysis.momentaryLufs),
    lowEnergyRatio: ratio(payload?.lowEnergyRatio),
    midEnergyRatio: ratio(payload?.midEnergyRatio),
    highEnergyRatio: ratio(payload?.highEnergyRatio),
    silenceRatio: ratio(payload?.silenceRatio),
  };
}

// ---------------------------------------------------------------------------
// 语言
// ---------------------------------------------------------------------------

const LANGUAGE_TOKENS: Readonly<Record<StyleLanguage, readonly string[]>> = {
  ja: ['ja', 'jp', 'jpn', 'japanese', '日本語', '日语', '日語'],
  zh: ['zh', 'zho', 'chi', 'cmn', 'chinese', '中文', '汉语', '漢語', '普通话', '國語', '国语'],
  en: ['en', 'eng', 'english', '英文'],
  other: ['other', 'unknown', 'und', 'mul'],
};

/** 把 BCP-47 / 中文名 / 常见别名映射到四值；无法归类的非空值按 other。 */
function normalizeLanguage(raw: unknown): StyleLanguage | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  const tokens = text.split(/[\s,;/|()_-]+/).filter((token) => token.length > 0);
  for (const language of ['ja', 'zh', 'en', 'other'] as const) {
    for (const token of tokens) {
      if (LANGUAGE_TOKENS[language].includes(token)) return language;
    }
  }
  return 'other';
}

/** 文本假名/汉字/拉丁字母比例；文本太短（<6 个字母）返回 null。 */
function detectLanguageFromText(text: unknown): StyleLanguage | null {
  if (typeof text !== 'string' || text.length < 6) return null;
  let kana = 0;
  let han = 0;
  let latin = 0;
  let letters = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff)
      || (code >= 0xff66 && code <= 0xff9f)) {
      kana += 1;
      letters += 1;
    } else if (code >= 0x4e00 && code <= 0x9fff) {
      han += 1;
      letters += 1;
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x00c0 && code <= 0x024f)) {
      latin += 1;
      letters += 1;
    }
  }
  if (letters < 6) return null;
  if (kana >= 2 && kana / letters >= 0.05) return 'ja';
  if (han / letters >= 0.05) return 'zh';
  if (latin / letters >= 0.6) return 'en';
  return null;
}

function resolveLanguage(input: StyleProfileInput): { language: StyleLanguage; reason: string } {
  const metaLanguage = normalizeLanguage(input.meta?.language);
  if (metaLanguage !== null) {
    return { language: metaLanguage, reason: `元数据 language="${input.meta?.language}"` };
  }
  const lyricLanguage = normalizeLanguage(input.lyrics?.language);
  if (lyricLanguage !== null) {
    return { language: lyricLanguage, reason: `歌词 language="${input.lyrics?.language}"` };
  }
  const textLanguage = detectLanguageFromText(input.lyrics?.text);
  if (textLanguage !== null) {
    return { language: textLanguage, reason: `歌词文本比例判定为 ${textLanguage}` };
  }
  return { language: 'other', reason: '元数据与歌词都没有可用语言信息' };
}

// ---------------------------------------------------------------------------
// 元数据 genre 加权
// ---------------------------------------------------------------------------

interface GenreHint {
  readonly keyword: string;
  readonly tag: StyleTag;
  readonly bonus: number;
}

const GENRE_HINT_BONUS = 0.2;

/** keyword 一律小写、去掉空白/连字符后参与 includes 匹配。 */
const GENRE_HINTS: readonly GenreHint[] = [
  { keyword: 'punk', tag: 'punk', bonus: GENRE_HINT_BONUS },
  { keyword: '朋克', tag: 'punk', bonus: GENRE_HINT_BONUS },
  { keyword: 'rock', tag: 'rock', bonus: GENRE_HINT_BONUS },
  { keyword: '摇滚', tag: 'rock', bonus: GENRE_HINT_BONUS },
  { keyword: 'metal', tag: 'metal', bonus: GENRE_HINT_BONUS },
  { keyword: '金属', tag: 'metal', bonus: GENRE_HINT_BONUS },
  { keyword: 'electronic', tag: 'electronic', bonus: GENRE_HINT_BONUS },
  { keyword: 'electronica', tag: 'electronic', bonus: GENRE_HINT_BONUS },
  { keyword: 'edm', tag: 'electronic', bonus: GENRE_HINT_BONUS },
  { keyword: 'electro', tag: 'electronic', bonus: GENRE_HINT_BONUS },
  { keyword: 'house', tag: 'electronic', bonus: GENRE_HINT_BONUS },
  { keyword: 'techno', tag: 'electronic', bonus: GENRE_HINT_BONUS },
  { keyword: 'trance', tag: 'electronic', bonus: GENRE_HINT_BONUS },
  { keyword: 'dubstep', tag: 'electronic', bonus: GENRE_HINT_BONUS },
  { keyword: 'dnb', tag: 'electronic', bonus: GENRE_HINT_BONUS },
  { keyword: 'drum&bass', tag: 'electronic', bonus: GENRE_HINT_BONUS },
  { keyword: 'synthwave', tag: 'electronic', bonus: GENRE_HINT_BONUS },
  { keyword: '电子', tag: 'electronic', bonus: GENRE_HINT_BONUS },
  { keyword: 'hiphop', tag: 'hiphop', bonus: GENRE_HINT_BONUS },
  { keyword: 'rap', tag: 'hiphop', bonus: GENRE_HINT_BONUS },
  { keyword: 'trap', tag: 'hiphop', bonus: GENRE_HINT_BONUS },
  { keyword: '说唱', tag: 'hiphop', bonus: GENRE_HINT_BONUS },
  { keyword: '嘻哈', tag: 'hiphop', bonus: GENRE_HINT_BONUS },
  { keyword: 'pop', tag: 'pop', bonus: GENRE_HINT_BONUS },
  { keyword: '流行', tag: 'pop', bonus: GENRE_HINT_BONUS },
  { keyword: 'ballad', tag: 'ballad', bonus: GENRE_HINT_BONUS },
  { keyword: '慢歌', tag: 'ballad', bonus: GENRE_HINT_BONUS },
  { keyword: '抒情', tag: 'ballad', bonus: GENRE_HINT_BONUS },
  { keyword: 'acoustic', tag: 'acoustic', bonus: GENRE_HINT_BONUS },
  { keyword: 'folk', tag: 'acoustic', bonus: GENRE_HINT_BONUS },
  { keyword: 'unplugged', tag: 'acoustic', bonus: GENRE_HINT_BONUS },
  { keyword: '民谣', tag: 'acoustic', bonus: GENRE_HINT_BONUS },
  { keyword: '原声', tag: 'acoustic', bonus: GENRE_HINT_BONUS },
  { keyword: 'ambient', tag: 'ambient', bonus: GENRE_HINT_BONUS },
  { keyword: '氛围', tag: 'ambient', bonus: GENRE_HINT_BONUS },
  { keyword: '环境', tag: 'ambient', bonus: GENRE_HINT_BONUS },
  { keyword: 'instrumental', tag: 'instrumental', bonus: GENRE_HINT_BONUS },
  { keyword: '纯音乐', tag: 'instrumental', bonus: GENRE_HINT_BONUS },
  { keyword: '器乐', tag: 'instrumental', bonus: GENRE_HINT_BONUS },
];

/** 每个标签最多吃一次加权；返回进 HUD 的证据行。 */
function applyGenreHints(scores: Record<StyleTag, number>, genre: string | undefined): string[] {
  if (typeof genre !== 'string') return [];
  const normalized = genre.toLowerCase().replace(/[\s\-_/]+/g, '');
  if (normalized.length === 0) return [];
  const used = new Set<StyleTag>();
  const evidence: string[] = [];
  for (const hint of GENRE_HINTS) {
    if (used.has(hint.tag)) continue;
    if (!normalized.includes(hint.keyword)) continue;
    used.add(hint.tag);
    scores[hint.tag] = clamp01(scores[hint.tag] + hint.bonus);
    evidence.push(`元数据 genre="${genre}" → ${hint.tag} 加权 +${hint.bonus}`);
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// 打分
// ---------------------------------------------------------------------------

interface TagInputs {
  bpm: number;
  meter: number;
  keyMode: string;
  energy: number | null;
  drumMedian: number | null;
  vocalDensity: number | null;
  fourOnFloor: number | null;
  bassRegularity: number | null;
  tempoStability: number | null;
  presence: 'vocal' | 'instrumental' | 'unknown';
  stats: FeatureStats;
}

function scoreTags(input: TagInputs): Record<StyleTag, number> {
  const T = STYLE_THRESHOLDS;
  const R = T.ramp;
  const stats = input.stats;
  const electronicScore =
    rampAbove(input.fourOnFloor, T.electronic.fourOnFloor, R.regularity)
    * rampAbove(input.tempoStability, T.electronic.tempoStability, R.stability)
    * rampAbove(input.bassRegularity, T.electronic.bassRegularity, R.regularity);
  const notElectronic = 1 - electronicScore;
  const bpm = input.bpm;
  const punk =
    rampAbove(stats.highRatioMean, T.punk.highRatioMean, R.ratio)
    * rampAbove(stats.flatnessMean, T.punk.flatnessMean, R.ratio)
    * rampAbove(bpm, T.punk.minBpm, R.bpm)
    * rampAbove(input.drumMedian, T.punk.drumMedian, R.density);
  const rock =
    rampAbove(stats.highRatioMean, T.rock.highRatioMean, R.ratio)
    * rampAbove(input.drumMedian, T.rock.drumMedian, R.density)
    * notElectronic;
  const metal =
    rampAbove(stats.highRatioMean, T.metal.highRatioMean, R.ratio)
    * rampAbove(stats.flatnessMean, T.metal.flatnessMean, R.ratio)
    * rampAbove(bpm, T.metal.minBpm, R.bpm)
    * rampBelow(stats.lowEnergyRatio, T.metal.maxLowRatio, R.ratio);
  const hiphop =
    rampInside(bpm, T.hiphop.minBpm, T.hiphop.maxBpm, R.bpm)
    * rampAbove(stats.lowEnergyRatio, T.hiphop.minLowRatio, R.ratio)
    * rampAbove(input.vocalDensity, T.hiphop.minVocalDensity, R.density);
  const ballad =
    (input.keyMode === 'minor' ? 1 : 0)
    * rampBelow(bpm, T.ballad.maxBpm, R.bpm)
    * rampBelow(input.energy, T.ballad.maxEnergy, R.energy)
    * rampAbove(stats.dynamicRangeLu, T.ballad.minDynamicRangeLu, R.dynamicLu);
  const acoustic =
    rampAbove(stats.tonalnessMean, T.acoustic.minTonalness, R.tonalness)
    * rampBelow(stats.highRatioMean, T.acoustic.maxHighRatio, R.ratio)
    * rampBelow(stats.percussivityMean, T.acoustic.maxPercussivity, R.percussivity)
    * notElectronic;
  const ambient =
    rampBelow(input.energy, T.ambient.maxEnergy, R.energy)
    * rampBelow(stats.percussivityMean, T.ambient.maxPercussivity, R.percussivity)
    * rampAbove(stats.dynamicRangeLu, T.ambient.minDynamicRangeLu, R.dynamicLu);
  // pop 是「没有更具体证据时的解释」，不是与具体风格并列的第五个候选：
  //   BPM/人声/无失真这三条几乎覆盖所有主流歌，若让它以满分参与竞争，
  //   任何摇滚/电子/嘻哈都会被压成 pop（实测 703 首里 62% 落到 pop）。
  //   所以用「具体风格越强，pop 解释力越低」的残差项压它。
  //   只压「已经明显像别的风格」的部分（specific>0.55），避免把弱证据的普通流行歌也压到没底。
  const specific = Math.max(punk, rock, metal, electronicScore, hiphop, ballad, acoustic, ambient);
  const specificExcess = Math.min(1, Math.max(0, (specific - 0.55) / 0.45));
  const popBase =
    (input.meter === T.pop.meter ? 1 : 0)
    * rampInside(bpm, T.pop.minBpm, T.pop.maxBpm, R.bpm)
    * rampAbove(input.vocalDensity, T.pop.minVocalDensity, R.density)
    * rampBelow(stats.highRatioMean, T.pop.maxHighRatio, R.ratio);
  return {
    punk,
    rock,
    metal,
    electronic: electronicScore,
    hiphop,
    pop: popBase * (1 - 0.7 * specificExcess),
    ballad,
    acoustic,
    ambient,
    instrumental: input.presence === 'instrumental' ? T.instrumental.score : 0,
  };
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

function fmt(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

export function resolveStyleProfile(input: StyleProfileInput): StyleProfile {
  const request: StyleProfileInput = input ?? ({} as StyleProfileInput);
  const analysis = request.analysis ?? ({} as BeatAnalysis);
  const meta = request.meta ?? {};
  const lyrics = request.lyrics ?? {};
  const feature = request.styleFeatures ?? null;

  const bpm = finiteOrNull(analysis.bpm) ?? 0;
  const meter = finiteOrNull(analysis.meter) ?? 4;
  const keyMode = typeof analysis.keyMode === 'string' ? analysis.keyMode.toLowerCase() : '';
  const energy = finiteOrNull(analysis.energy);
  const tempoStability = finiteOrNull(analysis.tempoStability);
  const hasActivity = !!analysis.activity
    && Array.isArray(analysis.activity.vocal)
    && analysis.activity.vocal.length >= 8;

  const stats = summarizeFeatures(analysis, feature);
  const drumMedian = median(analysis.activity?.drum);
  const vocalDensity = density(analysis.activity?.vocal, VOCAL_THRESHOLD);
  const lag = beatLagFrames(analysis);
  const fourOnFloor = periodicCorrelation(analysis.activity?.drum, lag);
  const bassRegularity = periodicCorrelation(analysis.activity?.bass, lag);
  const presence = vocalPresence(analysis);

  const scores = scoreTags({
    bpm,
    meter,
    keyMode,
    energy,
    drumMedian,
    vocalDensity,
    fourOnFloor,
    bassRegularity,
    tempoStability,
    presence,
    stats,
  });
  const genreEvidence = applyGenreHints(scores, meta.genre);

  let primary: StyleTag = STYLE_TAG_ORDER[0];
  let best = -1;
  for (const tag of STYLE_TAG_ORDER) {
    if (scores[tag] > best) {
      best = scores[tag];
      primary = tag;
    }
  }
  if (best < STYLE_THRESHOLDS.minTagScore) {
    primary = presence === 'instrumental' ? 'instrumental' : STYLE_THRESHOLDS.unknown.tag;
    scores[primary] = Math.max(scores[primary], STYLE_THRESHOLDS.unknown.primary);
  }

  let secondTag: StyleTag | null = null;
  let second = 0;
  for (const tag of STYLE_TAG_ORDER) {
    if (tag === primary) continue;
    if (scores[tag] > second) {
      second = scores[tag];
      secondTag = tag;
    }
  }

  const top = clamp01(scores[primary]);
  const separation = clamp01(
    (top - second) / STYLE_THRESHOLDS.confidence.separationSpan,
  );
  const coverage =
    (stats.present ? STYLE_THRESHOLDS.coverage.features : 0)
    + (hasActivity ? STYLE_THRESHOLDS.coverage.activity : 0)
    + (tempoStability !== null ? STYLE_THRESHOLDS.coverage.tempoStability : 0)
    + (keyMode.length > 0 ? STYLE_THRESHOLDS.coverage.key : 0)
    + (energy !== null ? STYLE_THRESHOLDS.coverage.energy : 0);
  const confidence = round3(clamp01(
    STYLE_THRESHOLDS.confidence.coverageWeight * coverage
    + STYLE_THRESHOLDS.confidence.separationWeight * separation
    + STYLE_THRESHOLDS.confidence.topWeight * top,
  // 没有谱特征时只剩 BPM/活动度/调性，主标签只是「默认解释」：
  //   压低置信度，UI 才有依据显示「待补特征」，而不是把 pop 当结论。
  ) * (stats.present ? 1 : 0.35));

  const isBallad = primary === 'ballad'
    || scores.ballad >= STYLE_THRESHOLDS.mood.balladPresence;
  let mood: 'sad' | 'neutral' | 'upbeat' = 'neutral';
  let moodReason = '能量与调式都不满足 sad/upbeat，按 neutral';
  if (isBallad && keyMode === 'minor' && energy !== null
    && energy < STYLE_THRESHOLDS.mood.sadMaxEnergy) {
    mood = 'sad';
    moodReason = `ballad 且小调且能量 ${energy.toFixed(2)}<0.4`;
  } else if (energy !== null && energy >= STYLE_THRESHOLDS.mood.upbeatMinEnergy
    && bpm >= STYLE_THRESHOLDS.mood.upbeatMinBpm) {
    mood = 'upbeat';
    moodReason = `能量 ${energy.toFixed(2)}≥0.6 且 ${Math.round(bpm)} BPM≥118`;
  }

  const { language, reason: languageReason } = resolveLanguage(request);

  const tags: Partial<Record<StyleTag, number>> = {};
  for (const tag of STYLE_TAG_ORDER) {
    const value = round3(clamp01(scores[tag]));
    if (value >= STYLE_THRESHOLDS.minTagScore || tag === primary) tags[tag] = value;
  }

  const evidence: string[] = [];
  const bpmText = bpm > 0 ? `${Math.round(bpm)} BPM` : 'BPM 未知';
  const energyText = energy === null ? '能量未知' : `能量 ${energy.toFixed(2)}`;
  const keyText = keyMode.length > 0 ? `调式 ${keyMode}` : '调式未知';
  evidence.push(`${bpmText} · ${meter}/4 · ${energyText} · ${keyText}`);
  if (stats.present) {
    evidence.push(
      `谱特征：质心 ${fmt(stats.centroidHzMean, 0)}Hz、高频占比 ${fmt(stats.highRatioMean)}、`
      + `平坦度 ${fmt(stats.flatnessMean)}、瞬态 ${fmt(stats.percussivityMean)}、`
      + `谐波性 ${fmt(stats.tonalnessMean)}、动态 ${fmt(stats.dynamicRangeLu, 1)}LU`,
    );
  } else {
    evidence.push('无 C# 谱特征（styleFeatures 缺失）：失真/占比/动态类标签按缺失处理');
  }
  evidence.push(
    `人声：${VOCAL_LABEL[presence]}`
    + (vocalDensity === null
      ? ''
      : `（活动度>${VOCAL_THRESHOLD} 的帧占 ${(vocalDensity * 100).toFixed(0)}%）`),
  );
  evidence.push(
    `主标签 ${primary}（${(top * 100).toFixed(0)}%）`
    + (secondTag === null ? '' : `，次选 ${secondTag}（${(second * 100).toFixed(0)}%）`),
  );
  evidence.push(...genreEvidence);
  evidence.push(`mood ${mood}：${moodReason}`);
  evidence.push(`语言 ${language}：${languageReason}`);

  const usedMeta = Boolean(meta.genre || meta.language || lyrics.language || lyrics.text);
  return {
    v: 1,
    source: usedMeta ? 'dsp+meta' : 'dsp',
    tags,
    primary,
    mood,
    vocal: presence === 'instrumental' ? 'instrumental' : presence === 'vocal' ? 'vocal' : 'uncertain',
    language,
    confidence,
    evidence,
  };
}
