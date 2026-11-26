import { setDeckMixGain, deckStemInput, scheduleElementEntry, deckAudioContext } from '../core/audioTap';
import { ensureAutomixV2Deck, releaseAutomixV2Tail, relaxAutomixV2Chain, scheduleAutomixV2, scheduleAutomixV2Duck, scheduleAutomixV2Echo, scheduleAutomixV2Presence, scheduleAutomixV2TailBleed, scheduleAutomixV2Unfade, scheduleAutomixV2Reverb, scheduleAutomixV2Hall, scheduleAutomixV2Press, scheduleAutomixV2WetBed, scheduleWetDuck, setWetHighpass, setCrossoverHz, setLowPolarity, setLowTrimDb, scheduleLoudnessTrim } from '../audio/automixV2Graph';
import { risingPressure, buildV2Plan } from '../core/automix/v2Plan';
import { ECHO_MAX_FADE_MS, planEchoTail, type EchoTailPlan } from '../core/automix/echoTail';
import { planBackspin, type BackspinPlan } from '../core/automix/backspin';
import { planLoopRoll, type LoopRollPlan } from '../core/automix/loopRoll';
import { planDropEntry, type DropEntryPlan } from '../core/automix/dropEntry';
import { planDoubling, type DoublingPlan } from '../core/automix/doubling';
import { budgetForAnalysis, vocalDensity } from '../core/automix/genreProfile';
import { applePlanFor } from '../core/automix/appleRecipes';
import { describeStyle, rankStyles, STYLE_CATALOG, type StyleParams, type TransitionStyleId } from '../core/automix/styleKit';
import { planSpeedRamp, speedRampAt, type SpeedRampPlan } from '../core/automix/speedRamp';
import { planTempoPolicy } from '../core/automix/tempoPolicy';
import { planVocalOverlay, type VocalOverlayPlan } from '../core/automix/vocalOverlay';
import { planIntroBridge } from '../core/automix/introBridge';
import { instrumentalAnchor } from '../core/automix/vocalAnchor';
import { pickBridgeUnit, buildBridgePlan } from '../core/automix/bridgePlan';
import { renderIntroBridgeBuffer, renderBridgeBuffer, startBridgePlayback, startOverlayPlayback, renderBackspinBuffer } from '../audio/automixV2Bridge';
import { matchDrumPhrase, composePhrase, phraseGains, analyseResidue, residueKeepMs } from '../core/automix/phraseMix';
/**
 * 双 deck 自然衔接：歌词前预卷、互补增益与音频时钟调度。
 * 自动模式按节拍置信度、调性与允许变速范围选择自然融合或短过渡。
 * 手动「交融」保留扫频效果；低频换手用短斜坡，关闭时两轨均不衰减。
 * 对拍时在过渡末段先让 A 完全静音，再把 B 平滑恢复用户速度。
 * 状态提交由 player 的 onFinish 完成；暂停/seek/缓冲中断撤销音频自动化。
 */

import {
  readDeckTone,
  attachDeckToGraph,
  audioTapClock,
  audioTapGraphActive,
  detachDeckFromGraph,
  ensureEqualizerGraph,
  releaseDeckFx,
  scheduleDeckBands,
  scheduleDeckGain,
  scheduleDeckMatch,
  setAudioTapVolume,
  setDeckGraphGain,
  setDeckGraphTilt,
  setDeckGraphVocalFocus,
  setDeckTrimGain,
  type DeckBandPoint,
} from '../core/audioTap';
import { naturalGains, nearestTempoRatio, MATCHED_OVERLAP_END } from './transitionMath';
import { requestHandoff } from '../core/advancedHandoff';
import type { Handoff } from '../core/advancedHandoff';
import { stemKeyOf, prefetchStemsForTransition, prefetchStemSpan } from '../audio/advancedReadiness';
import { resolveTransition } from '../core/advancedTransition';
import { trackRate, wrapBeatError } from '../core/beatPll';
import { buildTimeline } from './transitionTimeline';
import {
  isAutomixV2,
  readMixTransitionEngine,
  readMixTransitionMode,
  readMixTransitionTemplate,
  writeMixTransitionMode,
} from '../core/mixTransitionMode';
import type { MixTransitionMode } from '../core/mixTransitionMode';
import { V2_CROSSOVER_HZ, type V2Plan } from '../core/automix/v2Plan';
import { clipLift, detectTailFade, type TailFadeInfo, type TailFadePoint } from '../core/automix/tailFade';
import {
  type IntroBridgePlan,
} from '../core/automix/introBridge';
import {
  measureLowRms,
  scheduleAutomixV2BTrim,
  scheduleAutomixV2Style,
  type AutomixV2Deck,
} from '../audio/automixV2Graph';
import {
  type DuckEvent,
  type QualityReport,
  type QualityInput,
  buildBEntryDuck,
  buildDuckEvents,
  evaluateQuality as evaluateQualityReport,
  loudnessRampCurve,
  loudnessTrimCurve,
  planBTrimCurve,
  planSplitHz,
  clampTempoRateForWindow,
  bassCorrelation,
} from '../core/automix/v2Quality';
import { type AutomixForm, type FormDecision } from '../core/automix/automixPlan';
import {
  findVocalSegments,
  lastVocalEnd,
  reconcileVocalAnchor,
  vocalEnergyNear,
  firstStrongVocalMs, firstVocalLineMs,
  selectVocalEntry,
  tailAnchorUsable,
  vocalPresence,
  type VocalAnchorMode,
} from '../core/automix/vocalAnchor';
import { MELODY_WINDOW_BARS, pickMelodyEntry } from '../core/automix/melodyAnchor';
import { vocalPresenceDetail } from '../core/automix/vocalAnchor';

import { type BridgePlan } from '../core/automix/bridgePlan';
import {
  prefetchBridgeBytes,
  type BridgeRuntime,
} from '../audio/automixV2Bridge';
import { resolveStyleProfile, type StyleProfile } from '../core/automix/styleProfile';
import { resolveStylePolicy, type StylePolicy } from '../core/automix/stylePolicy';
import { planTimbreCompDb } from '../core/automix/v2Quality';
import { planExtension, type ExtensionPlan } from '../core/automix/extensionPlan';
import {
  extensionActive,
  renderExtensionBuffer,
  startExtensionPlayback,
  type ExtensionHandle,
} from '../audio/extensionPlayer';
import type { AnalysisResult, BeatAnalysis } from '../online/analysis';
import type { OnlineTrack } from '../online/types';
import { compensationDbFor } from './loudness';
import { audibleIntroStart, regionLoudness, transitionMatchDb } from './transitionLoudness';
import { h, toast, type Disposers } from './dom';

/* ------------------------------------------------------------------ */
/* 设置（localStorage）                                                */
/* ------------------------------------------------------------------ */

/**
 * 过渡长度的计量单位：
 * - auto = 按两首拍点/小节与结构空间自适应；
 * - seconds = 固定秒数；
 * - beats / bars = 按真实拍点换算的拍数 / 小节数（变速歌按局部速度算）；
 * - phrase = 一个乐句（4 小节，小节很短时 8 小节）。
 */
export type CrossfadeLengthMode = 'auto' | 'seconds' | 'beats' | 'bars' | 'phrase';

/** 拍点对齐精度：bars = 只吸到强拍/小节线；beats = 吸到真实拍点（默认，鼓点咬合更紧）。 */
export type CrossfadeAlignment = 'bars' | 'beats';

/** 旧版设置里的过渡时长（秒或 auto），只用于迁移旧存储。 */
type LegacyCrossfadeLength = 'auto' | number;

/**
 * 过渡风格：auto = 按调性/BPM 自动选（推荐）；am = 交融（互补滤波 + 低频交接）；
 * equal = 等功率（旧曲线）；cut = 快速切入（1–2 小节，适合调性/BPM 冲突）。
 */
export type CrossfadeStyle = 'auto' | 'am' | 'equal' | 'cut';

/** 使用场景预设：balanced = 两者兼顾（默认）；full = 完整播放优先；fast = 频繁切歌优先。 */
export type CrossfadePreset = 'balanced' | 'full' | 'fast';

/** 入场时机：auto = 首个 drop 优先、其次副歌；drop / chorus = 指定段落；intro = intro 结束时进。 */
export type CrossfadeCueMode = 'auto' | 'drop' | 'chorus' | 'intro';

/** 低频交接点：off = 不做低频交接；bar1 / bar2 = B 进场后第 1 / 2 小节交接。 */
export type CrossfadeBassSwap = 'off' | 'bar1' | 'bar2';

/** BPM 对齐范围：0 = 关闭；0.06 / 0.08 / 0.12 = 最大变速比例。 */
export type CrossfadeTempoRange = 0 | 0.06 | 0.08 | 0.12;

/** 过渡长度（小节）：auto = 按场景预设取 4 / 8 小节；4 / 8 / 16 = 固定乐句数。 */
export type CrossfadeBars = 'auto' | 4 | 8 | 16;

export interface CrossfadeSettings {
  enabled: boolean;
  /** 播放条上方显示「下一首过渡预告」小卡：下一首是谁、这次大概怎么过渡、准备后从几分几秒开始。 */
  showPreview: boolean;
  /**
   * 过渡长度单位：auto = 按两首歌的拍点/小节与前后奏空间自适应（不固定 5–10 秒）；
   * seconds = 固定秒数；beats / bars / phrase = 按真实拍点换算。
   */
  lengthMode: CrossfadeLengthMode;
  /** 配合 lengthMode 的取值：seconds 用秒（3–30），beats 用拍数，bars 用小节数，phrase / auto 忽略。 */
  lengthValue: number;
  /** 拍点对齐精度：bars = 只吸强拍/小节线；beats = 吸真实拍点（默认）。 */
  alignment: CrossfadeAlignment;
  /** 交融 = 低通/高通互补扫频 + 75% 低频交接；等功率 = cos/sin 交叉淡化 */
  style: CrossfadeStyle;
  /**
   * 歌词衔接（仅过渡时长为 auto 时生效）：上一首最后一句歌词唱完的瞬间接下一首第一句，
   * 人声缓慢浮现（约 2–6 秒，随淡化长度）、伴奏先被 EQ 压住再慢慢打开；过渡时长按两首协调后的
   * 真实小节计算（尾奏多时先按整小节保留一段尾奏再交叠，交叠终点 = A 可听结尾），不设固定秒数封顶；
   * 上一首尾奏不够长（< MIN_FADE_MS）时自动回退普通淡化。
   */
  handoff: boolean;
  /** 使用场景预设：balanced = 两者兼顾；full = 完整播放优先（默认 8 小节）；fast = 频繁切歌优先（默认 4 小节、更短进入）。 */
  preset: CrossfadePreset;
  /** 入场时机：按歌曲结构选 B 的进入点。 */
  cueMode: CrossfadeCueMode;
  /** 过渡长度（小节）：auto 时按 preset 取 4/8 小节。 */
  bars: CrossfadeBars;
  /** 低频交接点：默认 B 第 2 小节；off 关闭交接。 */
  bassSwap: CrossfadeBassSwap;
  /** 是否按两首分析出的响度（LUFS）预调 B 的增益。 */
  loudnessMatch: boolean;
  /** BPM 对齐允许的最大变速比例；0 关闭变速。 */
  tempoRange: CrossfadeTempoRange;
  /** 过渡模式：标准（整轨等功率）/ 进阶（分轨换手）/ 进阶·稳妥（只在可信时换手）。 */
  mixTransitionMode: MixTransitionMode;
  /**
   * 接唱点（只在进阶 v2 生效）：把过渡的**终点**锚到下一首的哪个唱词时段。
   * - auto：有歌词用歌词首句，没有就用活动度曲线的首句；
   * - first：曲线上的第一句；
   * - chorus：副歌 / drop 段开头的唱句（B 直接从副歌人声进来）；
   * - strongest：平均活动度最高的唱句；
   * - off：不锚唱词，纯按小节与结构混。
   */
  vocalAnchor: VocalAnchorMode;
  /**
   * 最短混音时长（秒）：过渡必须**在这么多时间里**完成频段穿插与低频交接，
   * 不能一缩再缩。auto = 跟随场景预设（fast 6 s / balanced 12 s / full 20 s）。
   * 只在进阶 v2 生效：标准档保持「只受 MIN/MAX_FADE_MS 约束」的老行为。
   */
  mixFloor: CrossfadeMixFloor;
}

export const CROSSFADE_STORAGE_KEY = 'zilux2.crossfade';

/** 手动过渡时长可选档位（秒）：覆盖 3–30 秒，并留「自动」。 */
export const CROSSFADE_LENGTH_CHOICES: number[] = [3, 5, 8, 10, 15, 20, 30];
/** 按拍数过渡的可选档位。 */
export const CROSSFADE_BEAT_CHOICES: number[] = [1, 2, 4, 8, 16];
/** 按小节数过渡的可选档位。 */
export const CROSSFADE_BAR_CHOICES: number[] = [1, 2, 4, 8];
const LENGTH_MIN_SEC = 3;
const LENGTH_MAX_SEC = 30;

const DEFAULT_SETTINGS: CrossfadeSettings = {
  enabled: true,
  showPreview: true,
  lengthMode: 'auto',
  lengthValue: 10,
  alignment: 'beats',
  style: 'auto',
  handoff: true,
  preset: 'balanced',
  cueMode: 'auto',
  bars: 'auto',
  bassSwap: 'bar2',
  loudnessMatch: true,
  tempoRange: 0.08,
  mixTransitionMode: 'standard',
  vocalAnchor: 'auto',
  mixFloor: 'auto',
};
const LENGTH_MODE_VALUES: CrossfadeLengthMode[] = ['auto', 'seconds', 'beats', 'bars', 'phrase'];
const ALIGNMENT_VALUES: CrossfadeAlignment[] = ['bars', 'beats'];
const STYLE_VALUES: CrossfadeStyle[] = ['auto', 'am', 'equal', 'cut'];
const PRESET_VALUES: CrossfadePreset[] = ['balanced', 'full', 'fast'];
const CUE_MODE_VALUES: CrossfadeCueMode[] = ['auto', 'drop', 'chorus', 'intro'];
const BARS_VALUES: CrossfadeBars[] = ['auto', 4, 8, 16];
const BASS_SWAP_VALUES: CrossfadeBassSwap[] = ['off', 'bar1', 'bar2'];
const TEMPO_RANGE_VALUES: CrossfadeTempoRange[] = [0, 0.06, 0.08, 0.12];
const VOCAL_ANCHOR_VALUES: VocalAnchorMode[] = ['auto', 'first', 'chorus', 'strongest', 'off'];
export type CrossfadeMixFloor = 'auto' | 6 | 12 | 20 | 30;
const MIX_FLOOR_VALUES: CrossfadeMixFloor[] = ['auto', 6, 12, 20, 30];
/** auto 档按场景预设取的最短混音时长（毫秒）。 */
const MIX_FLOOR_PRESET_MS: Record<CrossfadePreset, number> = {
  fast: 6_000,
  balanced: 12_000,
  full: 20_000,
};

/** 这次过渡至少要多长（ms）；标准档返回 0（不受约束）。 */
function resolveMixFloorMs(settings: CrossfadeSettings): number {
  if (!isAutomixV2(effectiveMode())) return 0;
  if (settings.mixFloor === 'auto') return MIX_FLOOR_PRESET_MS[settings.preset] ?? 12_000;
  const sec = Number(settings.mixFloor);
  return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0;
}

/**
 * auto 过渡时长（自由变换，不再固定「当前歌曲 4 小节 + 5–10 秒」）：
 * - 基准小节：两首歌都能变速对齐时用 A 的小节（B 会被 WSOLA 拉齐），对不齐时取两首的谐波平均；
 * - 小节数默认一个乐句（4 小节）；小节很短（<1.3 s，快歌或双拍被分析成两倍速）时取两个乐句；
 * - 再用歌曲结构伸缩小节数：B 到「开始唱词」的前奏空间不足一个乐句时按整小节缩短；
 *   A 的尾奏与 B 的前奏都足够宽裕时放宽到 6/8 小节（否则会在最后的副歌里就开淡）；
 * - 最终只受产品安全下限/上限（MIN_FADE_MS–MAX_FADE_MS）约束，实际时长随两首歌自由变化。
 */
const AUTO_BARS = 4;
const AUTO_BARS_MID = 6;
const AUTO_BARS_LONG = 8;
/** 小节短于这个值（≈ >185 BPM，或节拍器把双拍分析成两倍速）时，一个乐句太短，取两个乐句。 */
const AUTO_SHORT_BAR_MS = 1_300;
const AUTO_FALLBACK_MS = 7_000;

/** 淡化太短听不出、太长会盖住半首歌，都夹住。上限按手动 30 秒留余量。 */
/**
 * 交换点按强拍微调：把人声/中高频的交换落在最近的 downbeat 上（前后一小节内），
 * 并把交换段拉长/缩短到 0.65–0.90 之间。找不到合适强拍时返回 undefined，保持默认 0.80。
 */
function snapVocalAt(
  downbeats: readonly number[] | undefined,
  startMs: number,
  spanMs: number,
  barMs: number,
): number | undefined {
  if (!downbeats?.length || !(spanMs > 2_000) || !(barMs > 0)) return undefined;
  const target = startMs + spanMs * 0.8;
  let best = 0;
  let bestDist = barMs;
  for (const d of downbeats) {
    if (!Number.isFinite(d)) continue;
    const dist = Math.abs(d - target);
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  if (!best) return undefined;
  const p = (best - startMs) / spanMs;
  return p >= 0.65 && p <= 0.9 ? p : undefined;
}

const MIN_FADE_MS = 1_200;
/** 短前奏不能把自动过渡压成几百毫秒。 */
const MIN_AUTO_BLEND_MS = 3_200;
/** LRC 末句结束是按句间隔估算的，给最后一个字留一点余量。 */
const VOCAL_RELEASE_MARGIN_MS = 1_000;
const MAX_FADE_MS = 32_000;

/** 自动档：本次过渡实际走哪条路径。`null` = 还没判断（回退标准）。 */
let pairMixMode: MixTransitionMode | null = null;

/**
 * 自动选择：数据够就上进阶（分频换手/节拍吸附），
 * 拍点稀、置信度低、速度差过大、调性冲突或没有活动度曲线时退回标准（等功率）。
 */
function pairIsExceptional(a: BeatAnalysis | null | undefined, b: BeatAnalysis | null | undefined): boolean {
  if (!a || !b) return true;
  // 「特别特别」的门槛：连速度都不可信、或速率差超出引擎能安全拉伸的范围、
  // 或者几乎没有拍点。其余情况一律给进阶 v2。
  if ((a.bpm ?? 0) <= 0 || (b.bpm ?? 0) <= 0) return true;
  if ((a.bpmConfidence ?? 0) < 0.2 || (b.bpmConfidence ?? 0) < 0.2) return true;
  const ratio = nearestTempoRatio((a.bpm as number) / (b.bpm as number));
  if (Math.abs(ratio - 1) > 0.22) return true;
  const beatsA = (a.beatsMs?.length ?? 0) + (a.downbeats?.length ?? 0);
  const beatsB = (b.beatsMs?.length ?? 0) + (b.downbeats?.length ?? 0);
  if (beatsA < 16 || beatsB < 16) return true;
  return false;
}

function decidePairMode(a: BeatAnalysis | null | undefined, b: BeatAnalysis | null | undefined, plannedMs = 0): MixTransitionMode {
  if (readMixTransitionMode() !== 'auto') return readMixTransitionMode();
  // 规则：计划超过 5 s 一律走进阶 v2，只有「特别特别」的配对才退回标准；
  // 5 s 及以下按数据完整度判断（短交叠里分频换手收益小、风险大）。
  if (plannedMs > 5_000) return pairIsExceptional(a, b) ? 'standard' : 'automixV2';
  const downA = a?.downbeats?.length ?? 0;
  const downB = b?.downbeats?.length ?? 0;
  const confA = a?.bpmConfidence ?? 0;
  const confB = b?.bpmConfidence ?? 0;
  const bpmA = a?.bpm ?? 0;
  const bpmB = b?.bpm ?? 0;
  const ratio = bpmA > 0 && bpmB > 0 ? nearestTempoRatio(bpmA / bpmB) : 1;
  const gap = Math.abs(ratio - 1);
  const keyGap = camelotGap(a?.camelot, b?.camelot);
  const actA = a?.activity?.vocal?.length ?? 0;
  const actB = b?.activity?.vocal?.length ?? 0;
  if (downA < 8 || downB < 8) return 'standard';
  if (confA < 0.45 || confB < 0.45) return 'standard';
  if (!(gap <= 0.18)) return 'standard';
  if (keyGap > 4) return 'standard';
  if (actA < 8 || actB < 8) return 'standard';
  return 'automixV2';
}

/** 早于窗口计算时，用设置估一个「计划时长」，只用于 >5 s 规则。 */
function estimatePlannedMs(): number {
  try {
    const st = readCrossfadeSettings();
    if (st.lengthMode === 'seconds') return Math.round(st.lengthValue * 1000);
    if (st.lengthMode === 'beats') return Math.round(st.lengthValue * 500);
    if (st.lengthMode === 'bars') return Math.round(st.lengthValue * 2000);
  } catch { /* 忽略 */ }
  return 32_000;
}

function effectiveMode(): MixTransitionMode {
  const raw = readMixTransitionMode();
  if (raw !== 'auto') return raw;
  return pairMixMode ?? 'standard';
}
/**
 * 歌词衔接的过渡时长不设固定秒数上限：按「两首协调后的小节」实时计算——
 * 先用整小节让 A 的尾奏独听一段，再用一个乐句（小节很短时两个乐句，见 AUTO_BARS / AUTO_BARS_LONG）
 * 完成交叠，交叠终点正好落在 A 的可听结尾；尾奏比一个乐句还短时整段尾奏都用来过渡。
 */
const HANDOFF_FALLBACK_BAR_MS = 2_000;

/** WSOLA 变速不变调：用原生 preservesPitch 时间拉伸，把 B 的拍间隔拉到与 A 一致（±12% 内才做）。 */
const TEMPO_RATE_MIN = 0.88;
const TEMPO_RATE_MAX = 1.12;
/**
 * 进阶混音 v2 的变速域（±20%）。
 *
 * 标准路径的死穴：±8% 只能接 4% 以内的拍速差，剩下 96% 的曲对只能「不变速硬叠」，
 * 于是过渡只能靠音量。苹果的听感签名恰恰是「0.75×–1.5× 的明显变速」——
 * 要复刻它必须放开域。v2 用 ±15% 的规划目标（`V2_TEMPO_RANGE`）+ ±20% 的硬上限：
 * 15% 以内听不出「赶」，20% 才需要靠 PLL 收拍。
 *
 * 只在 v2 模式生效，标准路径继续 ±8%，两条路互不影响。
 */
const V2_TEMPO_RANGE = 0.15;
const V2_RATE_MIN = 0.8;
const V2_RATE_MAX = 1.2;

/** 当前模式允许的速率窗口；标准档冻结在 ±12%（历史值），v2 档 ±20%。 */
/**
 * 变速对齐的「目标」是谁。
 *
 * - `next`（默认）：以**下一首**为目标。A 在过渡里被缓慢拉到 B 的 BPM，
 *   B 自己保持原速 —— 听感上就是「上一首在往下一首靠」，交接那一下两边同速。
 * - `self`：老行为。B 被拉伸去贴 A，A 保持原速。
 */
type TempoAnchor = 'next' | 'self';

function readTempoAnchor(): TempoAnchor {
  try {
    return localStorage.getItem('zilux2.dev.tempoanchor') === 'self' ? 'self' : 'next';
  } catch {
    return 'next';
  }
}

function tempoRateWindow(): { min: number; max: number } {
  return isAutomixV2(effectiveMode())
    ? { min: V2_RATE_MIN, max: V2_RATE_MAX }
    : { min: TEMPO_RATE_MIN, max: TEMPO_RATE_MAX };
}
/** 不提前起播，避免固定提前量破坏拍点相位。 */
const TRIGGER_LEAD_MS = 0;
/** 已经越过淡化起点超过这个量就放弃本次衔接（回退硬切）。 */
const MISS_TOLERANCE_MS = 900;

/** 手动切歌 / 单曲循环的短过渡边界；手动切歌由已缓存的 BPM 估算两小节。 */
const MANUAL_FADE_MIN_MS = 1_200;
const MANUAL_FADE_MAX_MS = 7_000;
/** player 手动切歌默认使用的过渡时长（毫秒）。 */
export const MANUAL_FADE_DEFAULT_MS = 3_000;

function normalizeLengthMode(value: unknown): CrossfadeLengthMode {
  return LENGTH_MODE_VALUES.includes(value as CrossfadeLengthMode)
    ? (value as CrossfadeLengthMode)
    : DEFAULT_SETTINGS.lengthMode;
}

/** 把 lengthValue 夹到当前单位的合法档位；非法值回退该单位的默认档位。 */
function normalizeLengthValue(mode: CrossfadeLengthMode, value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (mode === 'seconds') {
    const rounded = Math.round(parsed);
    return CROSSFADE_LENGTH_CHOICES.includes(rounded) ? rounded : DEFAULT_SETTINGS.lengthValue;
  }
  if (mode === 'beats') {
    const rounded = Math.round(parsed);
    return CROSSFADE_BEAT_CHOICES.includes(rounded) ? rounded : 8;
  }
  if (mode === 'bars') {
    const rounded = Math.round(parsed);
    return CROSSFADE_BAR_CHOICES.includes(rounded) ? rounded : 4;
  }
  return DEFAULT_SETTINGS.lengthValue;
}

/**
 * 读取过渡长度：新字段优先；旧版只有 length（'auto' 或秒数）时迁移成 seconds 模式，
 * 这样老用户的固定秒数设置不会在升级后失效。
 */
function readLengthSettings(record: Record<string, unknown>): {
  lengthMode: CrossfadeLengthMode;
  lengthValue: number;
} {
  if (record.lengthMode !== undefined) {
    const lengthMode = normalizeLengthMode(record.lengthMode);
    return { lengthMode, lengthValue: normalizeLengthValue(lengthMode, record.lengthValue) };
  }
  const legacy = record.length as LegacyCrossfadeLength | undefined;
  if (legacy === 'auto' || legacy === undefined) {
    return { lengthMode: 'auto', lengthValue: DEFAULT_SETTINGS.lengthValue };
  }
  const seconds = typeof legacy === 'number' ? legacy : Number(legacy);
  if (Number.isFinite(seconds) && seconds >= LENGTH_MIN_SEC && seconds <= LENGTH_MAX_SEC) {
    // 旧版档位可能不在新档位表里（如 7 秒）：取最接近的档位，保持用户原来的意图。
    let nearest = CROSSFADE_LENGTH_CHOICES[0];
    for (const choice of CROSSFADE_LENGTH_CHOICES) {
      if (Math.abs(choice - seconds) < Math.abs(nearest - seconds)) nearest = choice;
    }
    return { lengthMode: 'seconds', lengthValue: nearest };
  }
  return { lengthMode: DEFAULT_SETTINGS.lengthMode, lengthValue: DEFAULT_SETTINGS.lengthValue };
}

function normalizeAlignment(value: unknown): CrossfadeAlignment {
  return ALIGNMENT_VALUES.includes(value as CrossfadeAlignment)
    ? (value as CrossfadeAlignment)
    : DEFAULT_SETTINGS.alignment;
}

/** 读取无缝衔接设置；坏值 / 无值一律回退默认（开启 + auto + 自动风格 + 两者兼顾）。 */
export function readCrossfadeSettings(): CrossfadeSettings {
  try {
    const raw = localStorage.getItem(CROSSFADE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS };
    const record = parsed as Record<string, unknown>;
    const length = readLengthSettings(record);
    return {
      enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_SETTINGS.enabled,
      showPreview:
        typeof record.showPreview === 'boolean' ? record.showPreview : DEFAULT_SETTINGS.showPreview,
      lengthMode: length.lengthMode,
      lengthValue: length.lengthValue,
      alignment: normalizeAlignment(record.alignment),
      style: STYLE_VALUES.includes(record.style as CrossfadeStyle)
        ? (record.style as CrossfadeStyle)
        : DEFAULT_SETTINGS.style,
      handoff: typeof record.handoff === 'boolean' ? record.handoff : DEFAULT_SETTINGS.handoff,
      preset: PRESET_VALUES.includes(record.preset as CrossfadePreset)
        ? (record.preset as CrossfadePreset)
        : DEFAULT_SETTINGS.preset,
      cueMode: CUE_MODE_VALUES.includes(record.cueMode as CrossfadeCueMode)
        ? (record.cueMode as CrossfadeCueMode)
        : DEFAULT_SETTINGS.cueMode,
      bars: BARS_VALUES.includes(record.bars as CrossfadeBars)
        ? (record.bars as CrossfadeBars)
        : DEFAULT_SETTINGS.bars,
      bassSwap: BASS_SWAP_VALUES.includes(record.bassSwap as CrossfadeBassSwap)
        ? (record.bassSwap as CrossfadeBassSwap)
        : DEFAULT_SETTINGS.bassSwap,
      loudnessMatch:
        typeof record.loudnessMatch === 'boolean' ? record.loudnessMatch : DEFAULT_SETTINGS.loudnessMatch,
      tempoRange: TEMPO_RANGE_VALUES.includes(record.tempoRange as CrossfadeTempoRange)
        ? (record.tempoRange as CrossfadeTempoRange)
        : DEFAULT_SETTINGS.tempoRange,
      vocalAnchor: VOCAL_ANCHOR_VALUES.includes(record.vocalAnchor as VocalAnchorMode)
        ? (record.vocalAnchor as VocalAnchorMode)
        : DEFAULT_SETTINGS.vocalAnchor,
      mixFloor: MIX_FLOOR_VALUES.includes(record.mixFloor as CrossfadeMixFloor)
        ? (record.mixFloor as CrossfadeMixFloor)
        : DEFAULT_SETTINGS.mixFloor,
      // 模式存独立的键（壁纸已占用 transitionMode），这里只做只读投影，保证
      // readCrossfadeSettings().mixTransitionMode 与混音器读到的永远是同一个值。
      mixTransitionMode: effectiveMode(),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 合并写入设置并广播 `zilux:crossfade`（player 据此重新准备/取消，UI 据此重绘）。
 * 返回写入后的完整设置。
 */
export function writeCrossfadeSettings(patch: Partial<CrossfadeSettings>): CrossfadeSettings {
  const current = readCrossfadeSettings();
  const lengthMode = normalizeLengthMode(patch.lengthMode === undefined ? current.lengthMode : patch.lengthMode);
  const next: CrossfadeSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    showPreview:
      typeof patch.showPreview === 'boolean' ? patch.showPreview : current.showPreview,
    lengthMode,
    lengthValue: normalizeLengthValue(
      lengthMode,
      patch.lengthValue === undefined ? current.lengthValue : patch.lengthValue,
    ),
    alignment: normalizeAlignment(patch.alignment === undefined ? current.alignment : patch.alignment),
    style: STYLE_VALUES.includes(patch.style as CrossfadeStyle)
      ? (patch.style as CrossfadeStyle)
      : current.style,
    handoff: typeof patch.handoff === 'boolean' ? patch.handoff : current.handoff,
    preset: PRESET_VALUES.includes(patch.preset as CrossfadePreset)
      ? (patch.preset as CrossfadePreset)
      : current.preset,
    cueMode: CUE_MODE_VALUES.includes(patch.cueMode as CrossfadeCueMode)
      ? (patch.cueMode as CrossfadeCueMode)
      : current.cueMode,
    bars: BARS_VALUES.includes(patch.bars as CrossfadeBars) ? (patch.bars as CrossfadeBars) : current.bars,
    bassSwap: BASS_SWAP_VALUES.includes(patch.bassSwap as CrossfadeBassSwap)
      ? (patch.bassSwap as CrossfadeBassSwap)
      : current.bassSwap,
    loudnessMatch:
      typeof patch.loudnessMatch === 'boolean' ? patch.loudnessMatch : current.loudnessMatch,
    vocalAnchor: VOCAL_ANCHOR_VALUES.includes(patch.vocalAnchor as VocalAnchorMode)
      ? (patch.vocalAnchor as VocalAnchorMode)
      : current.vocalAnchor,
    mixFloor: MIX_FLOOR_VALUES.includes(patch.mixFloor as CrossfadeMixFloor)
      ? (patch.mixFloor as CrossfadeMixFloor)
      : current.mixFloor,
    tempoRange: TEMPO_RANGE_VALUES.includes(patch.tempoRange as CrossfadeTempoRange)
      ? (patch.tempoRange as CrossfadeTempoRange)
      : current.tempoRange,
    mixTransitionMode: patch.mixTransitionMode === undefined
      ? current.mixTransitionMode
      : writeMixTransitionMode(patch.mixTransitionMode),
  };
  try {
    localStorage.setItem(CROSSFADE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* localStorage 不可用：忽略，仅本次会话生效 */
  }
  debug.enabled = next.enabled;
  debug.lengthMode = next.lengthMode;
  debug.lengthValue = next.lengthValue;
  debug.alignment = next.alignment;
  debug.style = next.style;
  debug.handoff = next.handoff;
  window.dispatchEvent(new CustomEvent<CrossfadeSettings>('zilux:crossfade', { detail: next }));
  return next;
}

/* ------------------------------------------------------------------ */
/* 单曲 / 歌单过渡记忆                                                 */
/* ------------------------------------------------------------------ */

/** 单曲或歌单级的过渡覆盖；只存需要覆盖全局设置的字段。 */
export interface CrossfadeOverride {
  lengthMode?: CrossfadeLengthMode;
  lengthValue?: number;
  alignment?: CrossfadeAlignment;
  style?: CrossfadeStyle;
  /** @deprecated 歌词衔接是全局开关，不再进单曲 / 歌单记忆（旧数据里残留的值一律忽略）。 */
  handoff?: boolean;
  preset?: CrossfadePreset;
  cueMode?: CrossfadeCueMode;
  bars?: CrossfadeBars;
  bassSwap?: CrossfadeBassSwap;
  loudnessMatch?: boolean;
  tempoRange?: CrossfadeTempoRange;
}

/** 歌单记忆：覆盖值 + 记住时歌单里的曲目键，用来判断当前曲是否属于这个歌单。 */
export interface PlaylistOverrideRecord {
  override: CrossfadeOverride;
  tracks: string[];
}

interface OverrideStore {
  tracks: Record<string, CrossfadeOverride>;
  playlists: Record<string, PlaylistOverrideRecord>;
}

export const CROSSFADE_OVERRIDE_STORAGE_KEY = 'zilux2.crossfade.overrides';

function normalizeOverride(record: Record<string, unknown>): CrossfadeOverride {
  const out: CrossfadeOverride = {};
  if (record.lengthMode !== undefined) {
    out.lengthMode = normalizeLengthMode(record.lengthMode);
    out.lengthValue = normalizeLengthValue(out.lengthMode, record.lengthValue);
  }
  if (record.alignment !== undefined) out.alignment = normalizeAlignment(record.alignment);
  if (STYLE_VALUES.includes(record.style as CrossfadeStyle)) out.style = record.style as CrossfadeStyle;
  // handoff 不再进记忆（全局开关），旧数据读进来即丢弃。
  if (PRESET_VALUES.includes(record.preset as CrossfadePreset)) out.preset = record.preset as CrossfadePreset;
  if (CUE_MODE_VALUES.includes(record.cueMode as CrossfadeCueMode)) out.cueMode = record.cueMode as CrossfadeCueMode;
  if (BARS_VALUES.includes(record.bars as CrossfadeBars)) out.bars = record.bars as CrossfadeBars;
  if (BASS_SWAP_VALUES.includes(record.bassSwap as CrossfadeBassSwap)) {
    out.bassSwap = record.bassSwap as CrossfadeBassSwap;
  }
  if (typeof record.loudnessMatch === 'boolean') out.loudnessMatch = record.loudnessMatch;
  if (TEMPO_RANGE_VALUES.includes(record.tempoRange as CrossfadeTempoRange)) {
    out.tempoRange = record.tempoRange as CrossfadeTempoRange;
  }
  return out;
}

function readOverrideStore(): OverrideStore {
  const empty: OverrideStore = { tracks: {}, playlists: {} };
  try {
    const raw = localStorage.getItem(CROSSFADE_OVERRIDE_STORAGE_KEY);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const record = parsed as Record<string, unknown>;
    const tracks: Record<string, CrossfadeOverride> = {};
    const tracksRaw = record.tracks;
    if (typeof tracksRaw === 'object' && tracksRaw !== null) {
      for (const [key, value] of Object.entries(tracksRaw as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue;
        tracks[key] = normalizeOverride(value as Record<string, unknown>);
      }
    }
    const playlists: Record<string, PlaylistOverrideRecord> = {};
    const playlistsRaw = record.playlists;
    if (typeof playlistsRaw === 'object' && playlistsRaw !== null) {
      for (const [key, value] of Object.entries(playlistsRaw as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue;
        const entry = value as Record<string, unknown>;
        const override =
          typeof entry.override === 'object' && entry.override !== null
            ? normalizeOverride(entry.override as Record<string, unknown>)
            : {};
        const list = Array.isArray(entry.tracks)
          ? entry.tracks.filter((item): item is string => typeof item === 'string')
          : [];
        playlists[key] = { override, tracks: list };
      }
    }
    return { tracks, playlists };
  } catch {
    return empty;
  }
}

function writeOverrideStore(store: OverrideStore): void {
  try {
    localStorage.setItem(CROSSFADE_OVERRIDE_STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* localStorage 不可用：忽略，仅本次会话生效 */
  }
  // 让播放器 / 预告卡按新的覆盖立即重新准备。
  window.dispatchEvent(new CustomEvent<CrossfadeSettings>('zilux:crossfade', { detail: readCrossfadeSettings() }));
}

/** 曲目在覆盖存储里的键（`source:id`）。 */
export function overrideKeyOfTrack(track: Pick<OnlineTrack, 'source' | 'id'>): string {
  return `${track.source}:${track.id}`;
}

/** 读取这首歌的单独过渡覆盖。 */
export function trackOverrideOf(track: Pick<OnlineTrack, 'source' | 'id'>): CrossfadeOverride | null {
  return readOverrideStore().tracks[overrideKeyOfTrack(track)] ?? null;
}

/** 读取这个歌单记下的过渡覆盖（键由 UI 决定：`local:<id>` / `online:<source>:<id>`）。 */
export function playlistOverrideOf(key: string): PlaylistOverrideRecord | null {
  return readOverrideStore().playlists[key] ?? null;
}

/** 把一批设置记到某首歌上；传 null 清除。 */
export function setTrackOverride(
  track: Pick<OnlineTrack, 'source' | 'id'>,
  override: CrossfadeOverride | null,
): void {
  const store = readOverrideStore();
  const key = overrideKeyOfTrack(track);
  if (override === null) delete store.tracks[key];
  else store.tracks[key] = override;
  writeOverrideStore(store);
}

/** 把一批设置记到某个歌单上（同时记住歌单曲目，播到这些歌时自动套用）；传 null 清除。 */
export function setPlaylistOverride(
  key: string,
  override: CrossfadeOverride | null,
  tracks: string[] = [],
): void {
  const store = readOverrideStore();
  if (override === null) delete store.playlists[key];
  else store.playlists[key] = { override, tracks: tracks.slice() };
  writeOverrideStore(store);
}

/** 把当前全局过渡设置抽成一份覆盖（单曲 / 歌单记忆用）。 */
export function captureCrossfadeOverride(): CrossfadeOverride {
  const settings = readCrossfadeSettings();
  return {
    lengthMode: settings.lengthMode,
    lengthValue: settings.lengthValue,
    alignment: settings.alignment,
    style: settings.style,
    preset: settings.preset,
    cueMode: settings.cueMode,
    bars: settings.bars,
    bassSwap: settings.bassSwap,
    loudnessMatch: settings.loudnessMatch,
    tempoRange: settings.tempoRange,
  };
}

function applyOverride(base: CrossfadeSettings, override: CrossfadeOverride | null): CrossfadeSettings {
  if (!override) return base;
  const next: CrossfadeSettings = { ...base };
  if (override.lengthMode !== undefined) {
    next.lengthMode = normalizeLengthMode(override.lengthMode);
    next.lengthValue = normalizeLengthValue(next.lengthMode, override.lengthValue ?? base.lengthValue);
  }
  if (override.alignment !== undefined) next.alignment = normalizeAlignment(override.alignment);
  if (override.style !== undefined) next.style = override.style;
  if (override.preset !== undefined) next.preset = override.preset;
  if (override.cueMode !== undefined) next.cueMode = override.cueMode;
  if (override.bars !== undefined) next.bars = override.bars;
  // 歌词衔接是全局开关：「打开 / 关闭」必须立刻对所有曲目生效，
  // 所以单曲 / 歌单记忆里残留的 handoff 不再覆盖全局值。
  if (override.bassSwap !== undefined) next.bassSwap = override.bassSwap;
  if (override.loudnessMatch !== undefined) next.loudnessMatch = override.loudnessMatch;
  if (override.tempoRange !== undefined) next.tempoRange = override.tempoRange;
  return next;
}

/**
 * 当前曲目实际生效的过渡设置：全局设置 → 歌单记忆（按曲目归属匹配）→ 单曲记忆。
 * 调度、预告卡与设置摘要都用它，保证「记住这首歌」立刻反映到规划里。
 */
export function effectiveCrossfadeSettings(track?: OnlineTrack | null): CrossfadeSettings {
  const base = readCrossfadeSettings();
  if (!track) return base;
  const key = overrideKeyOfTrack(track);
  const store = readOverrideStore();
  let merged = base;
  for (const record of Object.values(store.playlists)) {
    if (record.tracks.includes(key)) merged = applyOverride(merged, record.override);
  }
  const own = store.tracks[key];
  if (own) merged = applyOverride(merged, own);
  return merged;
}

/* ------------------------------------------------------------------ */
/* 调试状态（给 QA / Lead 用 CDP 观测）                                */
/* ------------------------------------------------------------------ */

export type CrossfadePhase = 'idle' | 'prepared' | 'fading' | 'done' | 'canceled';

export interface CrossfadeDebugEvent {
  at: number;
/** prepared / fade-start / fade-done / cancel / graph-hard-cut / b-play-failed / miss … */
  event: string;
  detail: string;
}

/** 过渡试放台用的「进阶换手预案」（纯数据，prepare 时算好，不参与音频）。 */
export interface CrossfadePreviewBlock {
  kind: 'swap' | 'echo' | 'duck';
  deck: 'A' | 'B';
  stem: string;
  /** 归一化左边界与宽度（0–1）。 */
  x: number;
  width: number;
  label: string;
}

export interface CrossfadeAdvancedPreview {
  /** 当前设置里的模式（standard / advanced / advancedSafe）。 */
  mode: string;
  /** 预案模板（缺失时为空串）。 */
  template: string;
  barMs: number;
  totalMs: number;
  /** 中文说明（含门控结论）。 */
  summary: string[];
  blocks: CrossfadePreviewBlock[];
  /** 没有画块时的原因（中文）；有块时为空串。 */
  emptyReason: string;
}

export interface CrossfadeDebugState {
  enabled: boolean;
  lengthMode: CrossfadeLengthMode;
  lengthValue: number;
  /** 设置：拍点对齐精度（beats = 吸附真实拍点；bars = 只吸强拍/小节线） */
  alignment: CrossfadeAlignment;
  style: CrossfadeStyle;
  /** 本次过渡是否真的按「交融」曲线走（需要 Web Audio 图 + auto 档 + 非歌词衔接） */
  amActive: boolean;
  /** 设置：歌词衔接（A 末句唱完接 B 首句）是否开启 */
  handoff: boolean;
  phase: CrossfadePhase;
  /** 最近一次 cancel 的原因；正常完成时为 fade-done */
  reason: string;
  currentTitle: string;
  nextTitle: string;
  /** A 的淡化起点（曲内毫秒） */
  fadeStartPosMs: number;
  fadeMs: number;
  /** B 的起播位置（文件毫秒） */
  bStartFileMs: number;
  /** 本次过渡给 B 的播放速率（1 = 不变速；wsola 对齐时 = A/BPM 比） */
  tempoRate: number;
  /** 是否做了变速不变调的节拍对齐 */
  tempoMatched: boolean;
  /** 过渡进行中 B 的实际播放速率（前段=tempoRate，后段回正到 1） */
  tempoRateLive: number;
  /** 本次过渡是否在做拍点锁相（PLL 微调 B 的速率贴着 A 的拍走） */
  pllActive: boolean;
  /** PLL 当前写进 B 的速率（含中心速率与微调）；= tempoRateLive 的细分来源 */
  pllRate: number;
  /** PLL 最近一次测到的拍相位差（单位：拍，正数 = B 超前，要减速） */
  pllErrBeats: number;
  /** 下一次调度的「开始唱词」位置（曲内毫秒）；0 = 无歌词/未取到 */
  nextVocalStartMs: number;
  /** 本次调度是否按「开始唱词」对齐（true = B 起播点按唱词反推） */
  vocalAligned: boolean;
  /** 本次调度是否走「歌词衔接」：A 最后一句唱完的时刻开始接 B 第一句 */
  handoffActive: boolean;
  /** A 的「最后一句歌词唱完」位置（曲内毫秒）；0 = 无数据/未启用 */
  lastVocalEndPosMs: number;
  /** 歌词衔接时先保留尾奏的后移量（毫秒）：0 = 末句唱完立刻开始交接 */
  handoffHoldMs: number;
  /** A 的「可听结尾」（曲内毫秒）：调度以它为终点；旧宿主无 audibleEndMs 时 = 曲内时长 */
  currentAudibleEndMs: number;
  /** 本次过渡是否铺生成垫底：空 = 没有，否则是给预告卡显示的说明。 */
  bedPlan?: string;
  /** A 的尾部静音（毫秒）= 曲内时长 - currentAudibleEndMs；无静音为 0 */
  tailSilenceMs: number;
  /** auto 本次的目标时长（毫秒）：= autoBars × autoBarMs；手动档位/回退为 0 */
  autoFadeMs: number;
  /** auto 本次算出的小节数（手动档位/回退为 0） */
  autoBars: number;
  /** auto 使用的小节长（毫秒，两首协调后的实时长度；手动档位/回退为 0） */
  autoBarMs: number;
  /** auto 决策说明（手动档位 / 默认乐句 / 快歌两乐句 / B 前奏较短 / 尾奏前奏宽裕 / 无拍点回退） */
  autoNote: string;
  /** p0-11 结构混音：本次是否按 cue 对 cue 计划（false = 旧淡化逻辑） */
  structureActive: boolean;
  /** p0-11 结构混音：B 入场挡位（auto = 自动选 drop/副歌） */
  cueMode: string;
  /** p0-11 结构混音：本次使用的乐句数（小节） */
  phraseBars: number;
  /** p0-11 结构混音：A 让位点 / B 入场点（文件毫秒；0 = 未使用） */
  cueOutMs: number;
  cueInMs: number;
  /** 本次解析后的风格（auto 解析结果） */
  styleResolved: 'am' | 'equal' | 'cut';
  /** 低频交接在淡化进度上的位置（0–1；0 = 不交接） */
  bassHandoffP: number;
  /** 给 B 的响度补偿（dB） */
  gainTrimDb: number;
  /** 最近一次过渡类型：auto = 自然播完的鼓点衔接；manual = 手动切歌；loop = 单曲循环重启；null = 尚未过渡 */
  crossfadeKind: 'auto' | 'manual' | 'loop' | null;
  /** 下一首（预取目标）的分析是否已就绪（player 侧 prefetch；切歌瞬间已就绪可跳过等待） */
  nextAnalysisReady: boolean;
  /** 预分析状态：idle = 未开始 / pending = 分析中 / ready = 就绪 / failed = 失败 */
  prefetchState: 'idle' | 'pending' | 'ready' | 'failed';
  /** 预分析目标曲目标题（调试用；空串 = 无目标） */
  prefetchTitle: string;
  /** 最近一次准备是否命中预分析缓存（true = 无需等待宿主分析） */
  prefetchHit: boolean;
  /** 进阶换手预案（试放台用；null = 还没算过/算不出来） */
  advancedPreview: CrossfadeAdvancedPreview | null;
  /** 是否已有准备好的衔接计划（prepared 相位；手动过渡一经开始即为 false） */
  nextPrepared: boolean;
  progress: number;
  baseVolume: number;
  events: CrossfadeDebugEvent[];
  settings: () => CrossfadeSettings;
  snapshot: () => CrossfadeDebugState;
}

const debug: CrossfadeDebugState = {
  enabled: DEFAULT_SETTINGS.enabled,
  lengthMode: DEFAULT_SETTINGS.lengthMode,
  lengthValue: DEFAULT_SETTINGS.lengthValue,
  alignment: DEFAULT_SETTINGS.alignment,
  style: DEFAULT_SETTINGS.style,
  amActive: false,
  handoff: DEFAULT_SETTINGS.handoff,
  phase: 'idle',
  reason: '',
  currentTitle: '',
  nextTitle: '',
  fadeStartPosMs: 0,
  fadeMs: 0,
  bStartFileMs: 0,
  tempoRate: 1,
  tempoMatched: false,
  tempoRateLive: 1,
  pllActive: false,
  pllRate: 1,
  pllErrBeats: 0,
  nextVocalStartMs: 0,
  vocalAligned: false,
  handoffActive: false,
  lastVocalEndPosMs: 0,
  handoffHoldMs: 0,
  currentAudibleEndMs: 0,
  tailSilenceMs: 0,
  autoFadeMs: 0,
  autoBars: 0,
  autoBarMs: 0,
  autoNote: '',
  structureActive: false,
  cueMode: 'auto',
  phraseBars: 0,
  cueOutMs: 0,
  cueInMs: 0,
  styleResolved: 'am',
  bassHandoffP: 0.75,
  gainTrimDb: 0,
  crossfadeKind: null,
  nextAnalysisReady: false,
  prefetchState: 'idle',
  prefetchTitle: '',
  prefetchHit: false,
  nextPrepared: false,
  advancedPreview: null,
  progress: 0,
  baseVolume: 0,
  events: [],
  settings: () => readCrossfadeSettings(),
  snapshot: () => ({ ...debug, events: debug.events.slice() }),
};

/** 挂到 window.__ziluxCrossfade，Lead 可在 CDP 里直接读快照/事件。 */
function exposeDebug(): void {
  (window as unknown as { __ziluxCrossfade?: CrossfadeDebugState }).__ziluxCrossfade = debug;
}

exposeDebug();

// 调试快照与已存设置保持一致（否则页面加载后 debug.enabled 会误导 QA）。
const initialSettings = readCrossfadeSettings();
debug.enabled = initialSettings.enabled;
debug.lengthMode = initialSettings.lengthMode;
debug.lengthValue = initialSettings.lengthValue;
debug.alignment = initialSettings.alignment;
debug.style = initialSettings.style;
debug.handoff = initialSettings.handoff;

/**
 * 当前过渡调度快照（只读副本）。
 * 播放条用它显示「将在 X 分 Y 秒后过渡至 xxx」：phase === 'prepared' 且 fadeStartPosMs 已知时有效；
 * 手动切歌 / 单曲循环的短过渡只在 prepared 停留极短时间，不会触发长倒计时提示。
 */
export function readCrossfadeDebug(): CrossfadeDebugState {
  return debug.snapshot();
}

type CrossfadeDebugListener = (state: CrossfadeDebugState) => void;
const debugListeners = new Set<CrossfadeDebugListener>();

/**
 * 订阅过渡计划变化（准备完成 / 取消 / 开始淡化 / 结束）。
 * 播放条的渐变标记只在播放器状态变化时重绘；分析回得慢或暂停时，
 * 计划更新不会带来状态变化，需要这里的回调主动重绘。
 */
export function subscribeCrossfadeDebug(listener: CrossfadeDebugListener): () => void {
  debugListeners.add(listener);
  return () => debugListeners.delete(listener);
}

function notifyDebug(): void {
  if (debugListeners.size === 0) return;
  const state = debug.snapshot();
  for (const listener of debugListeners) {
    try {
      listener(state);
    } catch {
      /* 忽略订阅方异常，避免打断过渡调度 */
    }
  }
}

/**
 * 唱词锚点是否允许启用。
 *
 * 为什么单独抽一层：`vocalPresence` 判成器乐时，下游会把锚点整段关掉且不留痕迹，
 * 用户只感觉「不生效」。「连贯说唱 / 整段人声」正好会被 `voiced > 0.85` 判成器乐，
 * 所以这里既要把理由写进日志，也要留一个强制开关（`zilux2.dev.anchorforce=1`）。
 */
function anchorPresenceOk(analysis: BeatAnalysis | null | undefined): boolean {
  if (!analysis) return true;
  const detail = vocalPresenceDetail(analysis);
  if (detail.kind !== 'instrumental') return true;
  let forced = false;
  try {
    forced = localStorage.getItem('zilux2.dev.anchorforce') === '1';
  } catch {
    forced = false;
  }
  if (forced) {
    logEvent('automix-v2-anchor-forced', detail.reason);
    return true;
  }
  logEvent('automix-v2-anchor-blocked', detail.reason);
  return false;
}

function logEvent(event: string, detail = ''): void {
  debug.events.push({ at: Date.now(), event, detail });
  if (debug.events.length > 40) debug.events.splice(0, debug.events.length - 40);
  notifyDebug();
}

/**
 * player 侧预分析状态写入调试快照（window.__ziluxCrossfade 可直接观测）：
 * nextAnalysisReady / prefetchState / prefetchTitle / prefetchHit。
 */
export function setPrefetchDebug(
  patch: Partial<Pick<CrossfadeDebugState, 'nextAnalysisReady' | 'prefetchState' | 'prefetchTitle' | 'prefetchHit'>>,
): void {
  if (typeof patch.nextAnalysisReady === 'boolean') debug.nextAnalysisReady = patch.nextAnalysisReady;
  if (patch.prefetchState !== undefined) debug.prefetchState = patch.prefetchState;
  if (patch.prefetchTitle !== undefined) debug.prefetchTitle = patch.prefetchTitle;
  if (typeof patch.prefetchHit === 'boolean') debug.prefetchHit = patch.prefetchHit;
}

/* ------------------------------------------------------------------ */
/* 计划与引擎                                                          */
/* ------------------------------------------------------------------ */

export interface CrossfadeTrackInfo {
  track: OnlineTrack;
  /** CUE 分轨在文件里的开始秒数（0 = 整轨） */
  startAt: number;
}

/** 双 deck 过渡计划的公共字段（自动衔接 / 手动切歌 / 单曲循环共用）。 */
interface DeckPlanCommon {
  /** 当前发声 deck（A） */
  active: HTMLAudioElement;
  /** 预留给下一首的 deck（B） */
  standby: HTMLAudioElement;
  /** B 的流地址（由 player 用 streamUrl 解析好，避免本模块依赖 online 层） */
  nextUrl: string;
  /** 读取当前基础音量（用户音量 0..1） */
  baseVolume: () => number;
  /** 读取用户播放倍速（0.5–2.0，Phase 2 D）；缺省 1。过渡期间 B 在此基础上再乘 tempoRate。 */
  baseRate?: () => number;
  /** 这次准备是否仍有效（player 的 token、曲目未变、开关仍开、图未激活） */
  isValid: () => boolean;
  /** 过渡完成（A 已静音、B 已满音量）：player 负责交换 deck 与状态迁移 */
  onFinish: () => void;
  /**
   * 过渡真正开始（B 已起播、第一帧淡化之前）：player 用它把界面提前切到下一首。
   * deck 交换仍等 onFinish，所以此回调之后 state 与 deck 会短暂不一致，取消方负责回退。
   */
  onStart?: () => void;
}

export interface CrossfadePrepareOptions extends DeckPlanCommon {
  current: CrossfadeTrackInfo;
  next: CrossfadeTrackInfo;
  /** A 的曲内总时长（毫秒） */
  currentDurationMs: number;
  /** A 当前曲内位置（毫秒） */
  currentPositionMs: number;
  currentAnalysis: AnalysisResult;
  nextAnalysis: AnalysisResult;
  /** 下一首的「开始唱词」位置（曲内毫秒，player 用 vocalStart.ts 取）；null/0 = 无歌词回退普通淡化 */
  nextVocalStartMs?: number | null;
  /** 当前曲「最后一句歌词唱完」的位置（曲内毫秒，player 用 vocalStart.ts 取）；null/0 = 无歌词/未启用歌词衔接 */
  currentLastVocalEndMs?: number | null;
}

/** 手动切歌 / 单曲循环重启：短过渡，B 从该段开头起播，不等节拍分析、不做 BPM 对齐。 */
export interface ManualCrossfadeOptions extends DeckPlanCommon {
  fromTitle: string;
  nextTitle: string;
  /** B 的起播文件毫秒：整轨 0；CUE 分轨 = startAt*1000（B 始终从这一段开头播） */
  nextStartFileMs: number;
  /** A 的当前曲内位置（毫秒，仅调试快照用） */
  currentPositionMs: number;
  /** 过渡时长（毫秒）：自动夹到 1200–7000 */
  fadeMs: number;
  /** 单曲循环：A 曲内位置到达 >= triggerPosMs 时自动触发；缺省 0（立即开始） */
  triggerPosMs?: number;
  /** B 无法起播等失败时回调；player 据此回退硬切。 */
  onFail?: (reason: string) => void;
}

interface FadeSchedule {
  /** B 侧电平包络（dB，0…+6，窗口内均匀采样）；空 = 不补。 */
  bTrim?: number[];
  /** 自适应分频点（Hz）：两边低频相关性越低，越往上抬。 */
  splitHz?: number;
  beatSync?: boolean;
  cleanPickup?: boolean;
  fadeStartFileMs: number;
  fadeStartPosMs: number;
  fadeMs: number;
  bStartFileMs: number;
  /** 本次过渡给 B 的播放速率（1 = 不变速） */
  tempoRate: number;
  /** 双侧向中点靠时 A 的速率；undefined = A 原速 */
  aRate?: number;
  /** A 的可听结尾（曲内毫秒，已排除尾部静音；旧宿主回退为曲内时长） */
  audibleEndPosMs: number;
  /** A 的尾部静音（毫秒）；无静音（含旧宿主回退）为 0 */
  tailSilenceMs: number;
  /** B 的「开始唱词」位置（曲内毫秒）；0 = 未启用 */
  nextVocalStartMs: number;
  /** true = B 起播点按唱词反推（前奏够长跳过 / 前奏较短整段过渡） */
  vocalAligned: boolean;
  /** true = 本次走「歌词衔接」：A 末句唱完接 B 首句，人声先出、伴奏渐入 */
  handoff: boolean;
  /** A 的「最后一句歌词唱完」位置（曲内毫秒）；0 = 未启用 */
  lastVocalEndPosMs: number;
  /** 本次歌词衔接先保留尾奏的后移量（毫秒）：0 = 末句唱完立刻开始交接 */
  handoffHoldMs: number;
  /** auto 本次目标时长（毫秒）：= autoBars × autoBarMs；手动档位/回退为 0 */
  autoFadeMs: number;
  /** auto 本次算出的小节数（手动档位/回退为 0） */
  autoBars: number;
  /** auto 使用的小节长（毫秒，两首协调后的实时长度；手动档位/回退为 0） */
  autoBarMs: number;
  /** auto 决策说明（调试/QA 用） */
  autoNote: string;
  /** p0-11 结构混音：本次是否走 cue 对 cue 计划 */
  /** E8 结构桥接：A 尾奏被循环补齐（null/缺失 = 没补）。 */
  bridge?: BridgePlan | null;
  /** 回旋刹车：倒放 A 的最后一小节（buffer 实现，元素无法倒放）。 */
  backspin?: BackspinPlan | null;
  backspinBuffer?: AudioBuffer | null;
  loopRoll?: LoopRollPlan | null;
  loopRollBuffer?: AudioBuffer | null;
  dropEntry?: DropEntryPlan | null;
  doubling?: DoublingPlan | null;
  doublingBuffer?: AudioBuffer | null;
  /** 本次过渡采用的唱词锚点（文件毫秒），没锚时为 null。 */
  vocalAnchor?: { aLastEndMs: number; bEntryMs: number; kind?: 'vocal' | 'instrumental' | 'structure' | 'none'; melodySim?: number; instrumentalBars?: number } | null;
  /** 器乐 A 的结构接缝（最后一个乐句 → 强拍 → 结尾前 2 小节），见 `instSeam` 的用途。 */
  instSeam?: { kind: string; ms: number; barsFromEnd: number } | null;
  introBridge?: IntroBridgePlan | null;
  /** E9 形态选择结果（仅 v2 档计算）。 */
  form?: AutomixForm | null;
  /** E9 形态决策明细（原因、是否关扫频、覆盖小节数、是否开 duck）。 */
  decision?: FormDecision | null;
  /** E10 质量门报告（仅 v2 档计算）。 */
  quality?: QualityReport | null;
  /** v2 曲线计划（规划期算好，执行期直接复用，避免两处参数不一致）。 */
  v2Plan?: V2Plan | null;
  /** 层 C 人声让位事件（相对淡化起点，毫秒）。 */
  v2Duck?: DuckEvent[] | null;
  lowCorr?: number | null;
  lowInvert?: boolean;
  bTrimMax?: number;
  /** 选中的过渡手法（styleKit）。只有 v2 档会填；standard 恒为 undefined。 */
  styleId?: TransitionStyleId;
  styleParams?: StyleParams;
  styleReasons?: string[];
  /** B 侧让位（B 一开播就唱时，A 的人声还在就把 B 压住）。 */
  bDuck?: DuckEvent[] | null;
  /** 尾段渐隐补回：识别结果 + 裁到过渡窗口内的抬升曲线（文件毫秒）。 */
  tailFade?: TailFadeInfo | null;
  aUnfade?: TailFadePoint[] | null;
  structure: boolean;
  /** p0-11 结构混音：B 的入场挡位（drop / chorus / intro / auto） */
  cueMode: string;
  /** p0-11 结构混音：本次使用的乐句数（小节） */
  phraseBars: number;
  /** p0-11 结构混音：cues（文件毫秒；0 = 未使用） */
  cueInMs: number;
  cueOutMs: number;
  /** 本次解析后的实际风格（auto 解析结果） */
  style: 'am' | 'equal' | 'cut';
  /** 低频交接在淡化进度上的位置（0–1）；0 = 不做交接 */
  bassHandoffP: number;
  /** 给 B 的响度补偿增益（dB） */
  gainTrimDb: number;
  /** 响度补平的上限（dB）。默认 3；A 有明显母带渐隐时放宽到 6（那段本来就该被补回来）。 */
  loudTrimCapDb?: number;
  /** A 的器乐尾巴还要在窗口之后铺多久（0 = 没有）。 */
  aTailBleedMs?: number;
  /** A 尾巴铺着时的电平（0…0.4）。 */
  aTailHold?: number;
  /** 窗口关不住 A 末句时，尾巴需要覆盖的缺口（毫秒）；0 = 没有。 */
  tailGuardMs?: number;
  /** 人声叠加（acapellaOverlay）的零分轨降级参数。 */
  vocalOverlay?: VocalOverlayPlan | null;
  /** 变速目标是下一首（A 被拉，B 原速）时为 true。 */
  tempoInverted?: boolean;
  /** A 侧分段变速折线（Apple `speedRamp` 的最小平替），惰性生成后缓存。 */
  rampPlan?: SpeedRampPlan;
  /** 过渡的真实墙钟时长（= fadeMs × tempoRate，当目标是下一首时）。 */
  fadeWallMs?: number;
  /** 本次过渡的风格策略（EQ / duck / 窗口缩放 / 延长预算的唯一来源）。 */
  stylePolicy?: StylePolicy;
  /** A 尾自延长计划（source='none' 或无需延长时为 null）。 */
  extensionPlan?: ExtensionPlan | null;
}

interface ActivePlan {
  /** B 侧电平包络（dB，0…+6，窗口内均匀采样）；空 = 不补。 */
  bTrim?: number[];
  /** 自适应分频点（Hz）：两边低频相关性越低，越往上抬。 */
  splitHz?: number;
  /** 本次过渡的尾段混响参数（浮层回读用）。 */
  reverb?: { sendDb: number; returnDb: number; fromP: number; tailMs: number };
  /** 短过渡的尾段回声计划（只有 ≤4.2 s 的窗口才有）。 */
  echo?: EchoTailPlan | null;
  /** 响度补平的上限（dB）。默认 3；A 有明显母带渐隐时放宽到 6（那段本来就该被补回来）。 */
  loudTrimCapDb?: number;
  /** A 的器乐尾巴还要在窗口之后铺多久（0 = 没有）。 */
  aTailBleedMs?: number;
  aTailHold?: number;
  /** 为「唱完最后一句」补的尾巴长度（毫秒）；0 = 没有。 */
  tailGuardMs?: number;
  tailBleedArmed?: boolean;
  phraseMatch?: boolean;
  /** 规划期那份 schedule（质量门重算后回写，浮层/体检台读的同一份数字）。 */
  scheduleRef?: FadeSchedule | null;
  previewNotified?: boolean;
  bedWindows?: Map<number, {other:AudioBuffer; vocals:AudioBuffer}>;
  lyricProgress?: number;
  stopBed?: () => void;
  beatSync?: boolean;
  cleanPickup?: boolean;
  bridgeBuffer?: AudioBuffer;
  introBuffer?: AudioBuffer;
  /** 计划类型：auto = 自然播完的鼓点衔接；manual = 手动切歌；loop = 单曲循环曲尾重启 */
  kind: 'auto' | 'manual' | 'loop';
  options: DeckPlanCommon;
  phase: 'prepared' | 'fading';
  /**
   * Web Audio 图已建立时走「图内增益」淡化：两个 deck 都接进 deckMix，用各自 gain 做等功率曲线，
   * 主音量仍由本地 gain 控制；false = 图未建立，用元素音量淡化（旧路径）。
   */
  graphMode: boolean;
  /** 本次过渡给 B 的播放速率（WSOLA 节拍对齐；1 = 不变速） */
  tempoRate: number;
  aRate?: number;
  /** 本次是否走「歌词衔接」（A 末句唱完接 B 首句；手动/loop 恒 false） */
  handoff: boolean;
  /**
   * 本次是否走「交融」曲线（互补滤波 + 低频交接 + AudioParam 时间线）。
   * 只有 auto 档、图已建立、且没走歌词衔接时才为 true；否则退回等功率曲线。
   */
  am: boolean;
  /** A 的「最后一句歌词唱完」位置（曲内毫秒）；0 = 未启用 */
  lastVocalEndPosMs: number;
  /** 本次歌词衔接先保留尾奏的后移量（毫秒）：0 = 末句唱完立刻开始交接 */
  handoffHoldMs: number;
  /** p0-11 结构混音：本次实际风格 / 低频交接点 / B 响度补偿 / 乐句数 */
  styleResolved: 'am' | 'equal' | 'cut';
  bassHandoffP: number;
  gainTrimDb: number;
  phraseBars: number;
  fadeStartFileMs: number;
  fadeStartPosMs: number;
  fadeMs: number;
  bStartFileMs: number;
  /** A 的可听结尾（曲内毫秒）；用于 tick 里判断还剩多少可淡化时间 */
  audibleEndPosMs: number;
  /** manual/loop 的触发点（曲内毫秒）：tick 到达后开始过渡；auto 恒为 0 */
  triggerPosMs: number;
  startedAt: number;
  audioStartedAt?: number;
  timelineReady?: boolean;
  cleanup?: () => void;
  progress: number;
  baseVolume: number;
  raf: number;
  /**
   * 进阶过渡（分轨换手）的交接句柄。null/缺省 = 走原来的等功率曲线。
   * 一旦建立，增益由四轨混音器在音频时钟上排好，这里不再写 deck 增益。
   */
  advanced?: Handoff | null;
  /** 拍点锁相（PLL）的当前状态；null = 本次不做 PLL（非 auto / 缺分析 / 已到回正段） */
  pll?: { rate: number; errBeats: number } | null;
  /**
   * 进阶混音 v2 的运行时（低频换手 + 双向扫频）。
   *
   * 与 `advanced` 互斥：v2 零分轨，自己带分频链；一旦建立，deck 的 gain 就被 tap
   * 从 deckMix 上摘下挂进 v2 链，本文件不再写 deck 增益（收尾时 `stopAutomixV2` 负责接回）。
   */
  v2?: AutomixV2Runtime | null;
  /** E8 结构桥接计划（只有 v2 档会有）。 */
  bridge?: BridgePlan | null;
  /** 回旋刹车：倒放 A 的最后一小节（buffer 实现，元素无法倒放）。 */
  backspin?: BackspinPlan | null;
  backspinBuffer?: AudioBuffer | null;
  loopRoll?: LoopRollPlan | null;
  loopRollBuffer?: AudioBuffer | null;
  dropEntry?: DropEntryPlan | null;
  doubling?: DoublingPlan | null;
  doublingBuffer?: AudioBuffer | null;
  /** 本次过渡采用的唱词锚点（文件毫秒），没锚时为 null。 */
  vocalAnchor?: { aLastEndMs: number; bEntryMs: number; kind?: 'vocal' | 'instrumental' | 'structure' | 'none'; melodySim?: number; instrumentalBars?: number } | null;
  /** B 侧前奏桥（循环+移调），元素推迟起播时才有。 */
  introBridge?: IntroBridgePlan | null;
  /** E9 形态选择结果（只有 v2 档会有）。 */
  form?: AutomixForm | null;
  /** E9 决策明细。 */
  decision?: FormDecision | null;
  /** E10 质量门报告。 */
  quality?: QualityReport | null;
  /** 规划期的 v2 曲线计划（执行期复用）。 */
  v2Plan?: V2Plan | null;
  /** 层 C 人声让位事件。 */
  v2Duck?: DuckEvent[] | null;
  lowCorr?: number | null;
  lowInvert?: boolean;
  bTrimMax?: number;
  /** 选中的过渡手法（styleKit）。只有 v2 档会填；standard 恒为 undefined。 */
  styleId?: TransitionStyleId;
  styleParams?: StyleParams;
  styleReasons?: string[];
  /** B 侧让位（B 一开播就唱时，A 的人声还在就把 B 压住）。 */
  bDuck?: DuckEvent[] | null;
  /** 尾段渐隐识别结果（只做展示/日志）。 */
  tailFade?: TailFadeInfo | null;
  /** A 的渐隐补回曲线（裁到过渡窗口，文件毫秒）。 */
  aUnfade?: TailFadePoint[] | null;
  /** 人声叠加（acapellaOverlay）的降级参数。 */
  vocalOverlay?: VocalOverlayPlan | null;
  /** 变速目标是下一首（A 被拉，B 原速）。 */
  tempoInverted?: boolean;
  /** 过渡的真实墙钟时长。 */
  fadeWallMs?: number;
  /** A 侧分段变速折线（Apple `speedRamp` 的最小平替），惰性生成后缓存。 */
  rampPlan?: SpeedRampPlan;
  /** 本次过渡的风格策略（执行期只读，不再推理）。 */
  stylePolicy?: StylePolicy | null;
  /** A 尾自延长计划。 */
  extensionPlan?: ExtensionPlan | null;
  /** 规划期异步渲染好的延长 buffer。 */
  extensionBuffer?: AudioBuffer | null;
}

/** v2 过渡的运行时句柄：两侧 deck 的专用链 + 本次曲线计划。 */
interface AutomixV2Runtime {
  a: AutomixV2Deck;
  b: AutomixV2Deck;
  plan: V2Plan;
  /** 结构桥接播放句柄（buffer 接管 A 尾段时才有）。 */
  bridge?: BridgeRuntime | null;
  backspin?: BridgeRuntime | null;
  loopRoll?: BridgeRuntime | null;
  doubling?: BridgeRuntime | null;
  /** 前奏桥 buffer 句柄（B 元素推迟起播时才有）。 */
  introBridge?: BridgeRuntime | null;
  /** A 尾自延长播放句柄（buffer 循环补在 A 的 audibleEnd 之后）。 */
  extension?: ExtensionHandle | null;
  /** B 元素「推迟起播」的定时器，收尾时必须清掉。 */
  introTimer?: number | null;
  /** 幂等收尾标记。 */
  stopped: boolean;
  /** 低频电平校准：采样缓冲（A、B 的原始低频 RMS）。 */
  lowSamples?: [number, number][];
  /** 校准只做一次，做完置真。 */
  lowTrimDone?: boolean;
  /** 实际施加给 B 的低频校准量（dB）。 */
  lowTrimDb?: number;
  /** 最近一次量到的两侧低频 RMS，供浮层显示。 */
  lowLevelA?: number;
  lowLevelB?: number;
}

let activePlan: ActivePlan | null = null;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** 取模（结果恒为非负），用于拍相位计算。 */
function mod(value: number, modulo: number): number {
  if (!(modulo > 0)) return 0;
  const remainder = value % modulo;
  return remainder < 0 ? remainder + modulo : remainder;
}

function setDeckVolume(element: HTMLAudioElement, volume: number): void {
  try {
    element.volume = clamp01(volume);
  } catch {
    /* 忽略：元素可能已被移除 */
  }
}

/**
 * 20 ms 斜坡升/降音量（G2：回退不许有咔哒）。
 *
 * 进阶会话期间元素音量是 0，若回退时直接写一次目标值，就是从 0 跳到 0.7——
 * 听感上是「啪」一声。这里用 8 步绝对定时（约 2.5 ms 一步），单步不超过总量的 1/8。
 *
 * 为什么用绝对定时而不是链式回调：窗口繁忙时链式回调会被推迟，最后几步根本跑不到
 * （`advancedSession.releaseElements` 踩过同样的坑）。
 */
function rampDeckVolume(element: HTMLAudioElement, target: number, durationMs = 20): void {
  let from = 0;
  try {
    from = element.volume;
  } catch {
    return;
  }
  const to = clamp01(target);
  if (!Number.isFinite(to)) return;
  const steps = 8;
  const stepMs = Math.max(1, Math.round(durationMs / steps));
  for (let i = 1; i <= steps; i++) {
    window.setTimeout(() => {
      setDeckVolume(element, from + (to - from) * (i / steps));
    }, stepMs * i);
  }
}

/** 进阶会话接管/交还时的增益斜坡长度（T4-3 契约：20 ms）。 */
const ADVANCED_RAMP_MS = 20;

/**
 * T4-3 互斥：进阶会话靠四轨播放器出声，deck 自己的通路必须同时静音，否则同一首歌
 * 会以两条时间轴叠加（重影/双声）。
 *
 * 注意 **不能只把 `element.volume` 设成 0**：`createMediaElementSource` 抓的是元素
 * 解码输出，volume 在部分浏览器里并不作用于该 tap。图模式下必须把 deck gain 也压到 0。
 */
function muteDeckElementsForAdvanced(plan: ActivePlan): void {
  if (plan.graphMode) {
    setDeckGraphGain(plan.options.active, 0, ADVANCED_RAMP_MS);
    setDeckGraphGain(plan.options.standby, 0, ADVANCED_RAMP_MS);
    return;
  }
  rampDeckVolume(plan.options.active, 0, ADVANCED_RAMP_MS);
  rampDeckVolume(plan.options.standby, 0, ADVANCED_RAMP_MS);
}

/** 交还 deck 通路：按当前进度对应的等功率值恢复，带 20 ms 斜坡（T4-3 / G2）。 */
function restoreDeckGains(plan: ActivePlan, progress: number): void {
  const p = clamp01(progress);
  const [outGain, inGain] = plan.phraseMatch ? phraseGains(p) : naturalGains(p, overlapEnd(plan));
  if (plan.graphMode) {
    setDeckGraphGain(plan.options.active, outGain, ADVANCED_RAMP_MS);
    setDeckGraphGain(plan.options.standby, inGain, ADVANCED_RAMP_MS);
    return;
  }
  rampDeckVolume(plan.options.active, plan.baseVolume * outGain, ADVANCED_RAMP_MS);
  rampDeckVolume(plan.options.standby, plan.baseVolume * inGain, ADVANCED_RAMP_MS);
}

function smoothStep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

/**
 * 这次过渡「长什么样」——HUD 与试放台的「形态」行读的就是它。
 * 以前 `selectForm()` 从来没被调用过，字段永远是 null，那一行永远显示 `—`。
 */
function formOf(input: {
  styleId?: string | null;
  bridge?: boolean;
  dropEntry?: boolean;
  tempoInverted?: boolean;
  tempoRate?: number;
}): AutomixForm {
  if (input.styleId === 'cut' || input.styleId === 'slam') return 'cut';
  if (input.styleId === 'loopRoll' || input.bridge) return 'loopBridge';
  if (input.dropEntry) return 'doubleDrop';
  if (input.tempoInverted || Math.abs((input.tempoRate ?? 1) - 1) > 0.001) return 'warp';
  return 'fade';
}

const pitchFlagged = new WeakSet<HTMLAudioElement>();

/**
 * 设置 deck 播放速率（WSOLA 变速不变调：preservesPitch 保持音高）。
 *
 * 只在速率**真的变了**才写 `playbackRate`：Chromium 每次赋值都会重建 WSOLA 处理，
 * 即便新旧值相同也会在输出里留一个几十毫秒的断点 —— 听感就是「一进过渡卡一下」。
 * `preservesPitch` 同样会重置处理管线，所以每个元素只设一次。
 */
function setDeckPlaybackRate(element: HTMLAudioElement, rate: number): void {
  try {
    const next = Math.max(0.5, Math.min(2, rate));
    if (!pitchFlagged.has(element)) {
      pitchFlagged.add(element);
      element.preservesPitch = true;
      (element as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    }
    if (Math.abs(element.playbackRate - next) < 0.0005) return;
    element.playbackRate = next;
  } catch {
    /* 忽略 */
  }
}

/** 用户播放倍速（0.5–2.0）作为 deck 的基础速率；缺省/坏值回退 1。 */
function baseDeckRate(options: DeckPlanCommon): number {
  const raw = options.baseRate?.() ?? 1;
  if (!Number.isFinite(raw)) return 1;
  return Math.max(0.5, Math.min(2, raw));
}

/** Natural crossfade: preserve spectrum and use a single complementary gain curve. */
function overlapEnd(plan: ActivePlan): number {
  return !plan.phraseMatch && Math.abs(plan.tempoRate - 1) > 0.001 ? MATCHED_OVERLAP_END : 1;
}

function applyEqualPowerGains(plan: ActivePlan, progress: number): void {
  const [outGain, inGain] = plan.cleanPickup ? phraseGains(1-(1-progress)*plan.fadeMs/12) : plan.phraseMatch ? phraseGains(progress) : naturalGains(progress, overlapEnd(plan));
  if (plan.graphMode) {
    setAudioTapVolume(plan.baseVolume, true);
    setDeckGraphGain(plan.options.active, outGain);
    setDeckGraphGain(plan.options.standby, inGain);
  } else {
    setDeckVolume(plan.options.active, plan.baseVolume * outGain);
    setDeckVolume(plan.options.standby, plan.baseVolume * inGain);
  }
}

/** Schedule all graph gains on the audio clock; UI updates never rewrite automation. */

/**
 * 频率式过渡（DJUCED 的真实做法）：不碰分轨，用低通/高通/低频架把小节线错开换手。
 * A：低频 0.5 小节内切走，随后低通/高通一起收窄；B：低频第 N 小节接回，滤波从闷到亮。
 */
function scheduleBandSwap(plan: ActivePlan, clock: number, options: CrossfadePrepareOptions | null): void {
  try {
    const beat = Math.max(120, options?.currentAnalysis?.analysis?.beatIntervalMs ?? 500);
    const bar = beat * 4;
    const bars = Math.max(4, Math.round(plan.fadeMs / bar));
    const bassIn = Math.max(1, Math.round(bars * 0.5));
    const end = bar * bars;
    const aEl = plan.options.active;
    const bEl = plan.options.standby;
    attachDeckToGraph(aEl);
    attachDeckToGraph(bEl);
    scheduleDeckBands(aEl, clock, [
      { atMs: 0, bassDb: 0, highpassHz: 20, lowpassHz: 20000 },
      { atMs: bar * 0.5, bassDb: -40, highpassHz: 120 },
      { atMs: end * 0.7, lowpassHz: 1400, highpassHz: 380 },
      { atMs: end, lowpassHz: 700, highpassHz: 800 },
    ]);
    scheduleDeckBands(bEl, clock, [
      { atMs: 0, bassDb: -40, lowpassHz: 600, highpassHz: 520 },
      { atMs: bar * bassIn, bassDb: -12 },
      { atMs: end * 0.7, lowpassHz: 6000, highpassHz: 60 },
      { atMs: end, bassDb: 0, lowpassHz: 20000, highpassHz: 20 },
    ]);
    logEvent('band-transition', `频率换手 ${bars} 小节，低频第 ${bassIn} 小节交接`);
  } catch (err) {
    console.warn('[crossfadeDeck] band swap failed', err);
  }
}

function scheduleNaturalFade(plan: ActivePlan, clock: number, fromP = 0, spanMs = plan.fadeMs): void {
  const a = [], b = [];
  const start = clamp01(fromP);
  for (let i = 0; i <= 200; i++) {
    const p = start + (1 - start) * (i / 200);
    const [outGain, inGain] = plan.phraseMatch ? phraseGains(p) : naturalGains(p, overlapEnd(plan));
    const atMs = spanMs * i / 200;
    a.push({ atMs, gain: outGain });
    b.push({ atMs, gain: inGain });
  }
  scheduleDeckGain(plan.options.active, clock, a);
  scheduleDeckGain(plan.options.standby, clock, b);
}

/* ------------------------------------------------------------------ */
/* 「交融」风格：仿 QQ 音乐「智能混音 · 进阶交融」的互补滤波 + 低频交接   */
/* ------------------------------------------------------------------ */

/**
 * 交融曲线的一个控制点：p = 淡化进度（0..1）。
 * db = 音量（dB），lpf/hpf = 低通/高通截止频率（Hz），bass = 120 Hz 低频架增益（dB）。
 */
interface AmPoint {
  p: number;
  db?: number;
  lpf?: number;
  hpf?: number;
  bass?: number;
}

/**
 * A 曲（正在播的那首）：
 * - 低通从 20 kHz 一路扫到 2.3 kHz（10% 10k → 15% 6.5k → 25% 6k → 35% 4.8k → 40% 3k → 55% 2.3k），
 *   把高频让给 B，自己只剩中频，两首叠在一起也不糊；
 * - 音量 40% 前基本不动（给足重叠空间），之后按 dB 线性收到 −25 dB；
 * - 75% 处低频架阶跃 −15 dB，底鼓让给 B（对应 QQ 曲线里标出的「75% 低频切换」）。
 */
const AM_A_POINTS: readonly AmPoint[] = [
  { p: 0, db: 0, lpf: 20000, bass: 0 },
  { p: 0.1, db: 0, lpf: 10000 },
  { p: 0.15, db: 0, lpf: 6500 },
  { p: 0.25, db: 0, lpf: 6000 },
  { p: 0.35, db: 0, lpf: 4800 },
  { p: 0.4, db: 0, lpf: 3000 },
  { p: 0.55, db: -8, lpf: 2300 },
  { p: 1, db: -25 },
];

/**
 * B 曲（下一首）：
 * - 前 25% 是 −30 dB + 10 kHz 高通（相当于从「隔壁房间」里透进来，不会一上来就抢）；
 * - 40% 高通 3 kHz → 45% 1 kHz + 音量 −10 dB → 55% 300 Hz / −5 dB → 90% 回到 0 dB；
 * - 75% 处低频架从 −15 dB 回正，把底鼓接过来；100% 高通落到 20 Hz（全频恢复）。
 */
const AM_B_POINTS: readonly AmPoint[] = [
  { p: 0, db: -30, hpf: 10000, bass: -15 },
  { p: 0.25, db: -30, hpf: 10000 },
  { p: 0.4, hpf: 3000 },
  { p: 0.45, db: -10, hpf: 1000 },
  { p: 0.55, db: -5, hpf: 300 },
  { p: 0.9, db: 0 },
  { p: 1, db: 0, hpf: 20 },
];

/** 低频交接的进度点（QQ 曲线里的 75%）：A 的低频架掉下去、B 的低频架回正。 */
const AM_BASS_HANDOFF_P = 0.75;
/** 曲线采样步长（进度）：8 秒过渡里约 40 ms 一个点，足够密，也远低于 AudioParam 事件上限。 */
const AM_SAMPLE_STEP = 0.005;
/** 收尾把 A 从 −25 dB 再压到 −60 dB 的进度窗口：避免 fade 结束时硬切到 0 的爆音。 */
const AM_A_TAIL_P = 0.96;
const AM_A_TAIL_DB = -60;

function dbToAmp(db: number): number {
  return Math.pow(10, db / 20);
}

/** 从控制点里抽出某条曲线（按出现顺序，缺省的控制点跳过）。 */
function curveOf(points: readonly AmPoint[], key: 'db' | 'lpf' | 'hpf'): Array<{ p: number; value: number }> {
  const curve: Array<{ p: number; value: number }> = [];
  for (const point of points) {
    const value = point[key];
    if (typeof value === 'number' && Number.isFinite(value)) curve.push({ p: point.p, value });
  }
  return curve;
}

/**
 * 在控制点之间插值：音量按 dB 线性（听感均匀），滤波频率按对数线性（与 exponentialRamp 一致）。
 */
function interpolateCurve(
  curve: ReadonlyArray<{ p: number; value: number }>,
  p: number,
  logScale = false,
): number | null {
  const first = curve[0];
  if (!first) return null;
  if (p <= first.p) return first.value;
  const last = curve[curve.length - 1]!;
  if (p >= last.p) return last.value;
  for (let index = 1; index < curve.length; index += 1) {
    const right = curve[index]!;
    if (p <= right.p) {
      const left = curve[index - 1]!;
      const span = right.p - left.p;
      if (!(span > 0)) return right.value;
      const t = (p - left.p) / span;
      if (logScale && left.value > 0 && right.value > 0) {
        return Math.exp(Math.log(left.value) + (Math.log(right.value) - Math.log(left.value)) * t);
      }
      return left.value + (right.value - left.value) * t;
    }
  }
  return last.value;
}

interface AmTracks {
  aBands: DeckBandPoint[];
  bBands: DeckBandPoint[];
  aGain: Array<{ atMs: number; gain: number }>;
  bGain: Array<{ atMs: number; gain: number }>;
}

/** 把「交融」的控制点展开成 AudioParam 时间线要的采样点（时间相对淡化起点）。 */
function buildAmTracks(fadeMs: number, bassHandoffP = AM_BASS_HANDOFF_P, trimDb = 0): AmTracks {
  const duration = Math.max(1, fadeMs);
  const aDb = curveOf(AM_A_POINTS, 'db');
  const aLpf = curveOf(AM_A_POINTS, 'lpf');
  const bDb = curveOf(AM_B_POINTS, 'db');
  const bHpf = curveOf(AM_B_POINTS, 'hpf');
  const aBands: DeckBandPoint[] = [{ atMs: 0, lowpassHz: 20000, highpassHz: 20, bassDb: 0 }];
  const bBands: DeckBandPoint[] = [{ atMs: 0, lowpassHz: 20000, highpassHz: 10000, bassDb: bassHandoffP > 0 ? -15 : 0 }];
  const aGain: Array<{ atMs: number; gain: number }> = [];
  const bGain: Array<{ atMs: number; gain: number }> = [];
  const steps = Math.max(20, Math.min(400, Math.round(1 / AM_SAMPLE_STEP)));
  for (let index = 0; index <= steps; index += 1) {
    const p = index / steps;
    const atMs = p * duration;
    const aLowpass = interpolateCurve(aLpf, p, true);
    if (aLowpass !== null) aBands.push({ atMs, lowpassHz: aLowpass });
    const bHighpass = interpolateCurve(bHpf, p, true);
    if (bHighpass !== null) bBands.push({ atMs, highpassHz: bHighpass });
    const aDbValue = interpolateCurve(aDb, p);
    if (aDbValue !== null) {
      // 最后 4% 再从 −25 dB 滑到 −60 dB：fade 结束时 A 已经基本没声，收尾不会有台阶。
      const tail = p <= AM_A_TAIL_P ? 0 : (p - AM_A_TAIL_P) / (1 - AM_A_TAIL_P);
      const fadedDb = aDbValue + (AM_A_TAIL_DB - aDbValue) * tail;
      aGain.push({ atMs, gain: p === 1 ? 0 : dbToAmp(fadedDb) });
    }
    const bDbValue = interpolateCurve(bDb, p);
    if (bDbValue !== null) bGain.push({ atMs, gain: dbToAmp(bDbValue + trimDb) });
  }
  // 低频交接围绕目标拍点做短斜坡，避免瞬间改变低频能量；
  // bassHandoffP = 0 时两首低频架均保持中性。
  if (bassHandoffP <= 0) return { aBands, bBands, aGain, bGain };
  const handoffMs = Math.max(0, Math.min(duration, bassHandoffP * duration));
  const halfWindow = Math.min(120, duration * 0.08, handoffMs, duration - handoffMs);
  const from = handoffMs - halfWindow;
  const to = handoffMs + halfWindow;
  aBands.push({ atMs: from, bassDb: 0 }, { atMs: to, bassDb: -15 });
  bBands.push({ atMs: from, bassDb: -15 }, { atMs: to, bassDb: 0 });
  return { aBands, bBands, aGain, bGain };
}

/**
 * 把「交融」的整套曲线一次性排到音频线程：滤波扫频 + 低频交接走 AudioParam 时间线，
 * 音量同样走时间线（dB 采样后换线性幅度），rAF 只负责推进度与收尾——掉帧也不会让曲线变形。
 */
function scheduleAmFade(plan: ActivePlan): boolean {
  const clock = audioTapClock();
  if (clock === null) return false;
  const tracks = buildAmTracks(plan.fadeMs * overlapEnd(plan), plan.bassHandoffP);
  scheduleDeckBands(plan.options.active, clock, tracks.aBands);
  scheduleDeckBands(plan.options.standby, clock, tracks.bBands);
  scheduleDeckGain(plan.options.active, clock, tracks.aGain);
  scheduleDeckGain(plan.options.standby, clock, tracks.bGain);
  return true;
}

/** 取离目标最近的强拍；离目标超过 1.5 拍就放弃对齐（宁可普通淡化）。 */
function pickDownbeatNear(
  analysis: BeatAnalysis,
  targetFileMs: number,
  startAtMs: number,
  toleranceBeats = 1.5,
): number | null {
  const downbeats = analysis.downbeats.filter((value) => Number.isFinite(value) && value >= startAtMs);
  if (downbeats.length === 0) return null;
  const beat = analysis.beatIntervalMs > 0 ? analysis.beatIntervalMs : 500;
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const value of downbeats) {
    const distance = Math.abs(value - targetFileMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = value;
    }
  }
  if (best === null || bestDistance > beat * toleranceBeats) return null;
  return best;
}

/** 取 B 在 [from, limit] 区间内的第一个强拍；没有就 null。 */
function pickDownbeatAtOrAfter(analysis: BeatAnalysis, fromFileMs: number, limitFileMs: number): number | null {
  let best: number | null = null;
  for (const value of analysis.downbeats) {
    if (!Number.isFinite(value)) continue;
    if (value < fromFileMs) continue;
    if (limitFileMs > 0 && value > limitFileMs) continue;
    if (best === null || value < best) best = value;
  }
  return best;
}

/** 真实拍点网格：优先分析给出的 beatsMs（p0-12 起）；旧缓存没有时用「首拍 + 常数间隔」兜底。 */
function beatGridOf(analysis: BeatAnalysis): number[] {
  const beats = analysis.beatsMs;
  if (Array.isArray(beats) && beats.length >= 4) {
    return beats.filter((value) => Number.isFinite(value) && value >= 0);
  }
  const interval = beatIntervalOf(analysis);
  const first = analysis.firstBeatMs;
  if (!(interval > 0) || !Number.isFinite(first) || first < 0) return [];
  const rawEnd = analysis.audibleEndMs;
  const end =
    typeof rawEnd === 'number' && Number.isFinite(rawEnd) && rawEnd > 0 ? rawEnd : first + interval * 12_000;
  const grid: number[] = [];
  for (let value = first; value <= end + interval; value += interval) {
    grid.push(value);
    if (grid.length > 20_000) break;
  }
  return grid;
}

/**
 * 把目标时间吸附到拍点网格：
 * - bars = 只吸附强拍（小节线），兼容旧行为；
 * - beats = 吸附真实拍点（beatsMs），鼓点咬合更紧；
 * 离目标超过 1.5 拍就放弃（宁可回退原值，也不硬挪过渡起点）。
 */
function snapToGrid(
  analysis: BeatAnalysis,
  targetFileMs: number,
  startAtMs: number,
  mode: CrossfadeAlignment,
): number | null {
  // 强拍网格 4 拍才有一个，允许半小节（2 拍）以内就近吸附，否则几乎永远吸不上。
  if (mode === 'bars') return pickDownbeatNear(analysis, targetFileMs, startAtMs, 2.5);
  const tolerance = (beatIntervalOf(analysis) || 500) * 1.5;
  const beats = beatGridOf(analysis).filter((value) => value >= startAtMs);
  if (beats.length === 0) return pickDownbeatNear(analysis, targetFileMs, startAtMs);
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const value of beats) {
    const distance = Math.abs(value - targetFileMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = value;
    }
  }
  if (best === null || bestDistance > tolerance) {
    return pickDownbeatNear(analysis, targetFileMs, startAtMs);
  }
  return best;
}

/** 曲目时间线上 ≥ fileMs 的下一拍；没有 beatsMs 时返回 null（调用方回退常数网格）。 */
function nextBeatAtOrAfter(analysis: BeatAnalysis, fileMs: number): number | null {
  const beats = analysis.beatsMs;
  if (!Array.isArray(beats) || beats.length === 0) return null;
  for (const value of beats) {
    if (Number.isFinite(value) && value >= fileMs - 1) return value;
  }
  return null;
}

/** 离 targetMs 最近的拍（用 beatsMs 精确取；没有就按 beatIntervalMs 推）。 */

/** 拍间隔：优先用分析给的 beatIntervalMs，其次由 BPM 反推；都没有 = 0。 */function beatIntervalOf(analysis: BeatAnalysis): number {
  if (analysis.beatIntervalMs > 0 && Number.isFinite(analysis.beatIntervalMs)) return analysis.beatIntervalMs;
  if (analysis.bpm >= 40 && Number.isFinite(analysis.bpm)) return 60_000 / analysis.bpm;
  return 0;
}

/** 一小节的实时时长（毫秒）；拍点未知 = 0。 */
function barIntervalOf(analysis: BeatAnalysis): number {
  const beat = beatIntervalOf(analysis);
  if (!(beat > 0)) return 0;
  const meter = analysis.meter >= 2 && analysis.meter <= 16 ? analysis.meter : 4;
  return beat * meter;
}

const BPM_OVERRIDE_STORAGE = 'zilux2.bpmOverride';

/** 跟拍覆盖表：`source:id` → BPM；只影响过渡的小节对齐，不改宿主分析结果。 */
function readBpmOverrides(): Record<string, number> {
  try {
    const raw = localStorage.getItem(BPM_OVERRIDE_STORAGE);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** 记录 / 清除当前曲目的跟拍 BPM（null = 清除）。 */
export function setBpmOverride(track: OnlineTrack, bpm: number | null): void {
  const key = `${track.source}:${track.id}`;
  const overrides = readBpmOverrides();
  if (bpm === null) delete overrides[key];
  else overrides[key] = Math.round(bpm * 10) / 10;
  try {
    localStorage.setItem(BPM_OVERRIDE_STORAGE, JSON.stringify(overrides));
  } catch {
    // 存储不可用（隐私模式）时忽略
  }
}

/** 当前曲目的跟拍 BPM；没有则 null。 */
export function bpmOverrideOf(track: OnlineTrack | null | undefined): number | null {
  if (!track) return null;
  const value = readBpmOverrides()[`${track.source}:${track.id}`];
  return typeof value === 'number' && Number.isFinite(value) && value >= 40 && value <= 240 ? value : null;
}

function meterOf(analysis: BeatAnalysis): number {
  return analysis.meter >= 2 && analysis.meter <= 16 ? analysis.meter : 4;
}

/** 局部 BPM：跟拍覆盖 > 速度曲线（就近点）> 整曲 BPM。 */
function tempoAtMs(track: OnlineTrack | null | undefined, analysis: BeatAnalysis, ms: number): number {
  const override = bpmOverrideOf(track);
  if (override) return override;
  const pointsMs = analysis.tempoCurveMs;
  const pointsBpm = analysis.tempoCurveBpm;
  if (
    Array.isArray(pointsMs) &&
    Array.isArray(pointsBpm) &&
    pointsMs.length > 0 &&
    pointsMs.length === pointsBpm.length
  ) {
    // 取时间上最近的 5 个窗口做中位，避免单窗错拍把一个小节算成两倍长。
    const order = pointsMs.map((value, index) => ({ distance: Math.abs(value - ms), index }));
    order.sort((a, b) => a.distance - b.distance);
    const nearest: number[] = [];
    for (const item of order.slice(0, 5)) {
      const value = pointsBpm[item.index];
      if (value >= 40 && value <= 240) nearest.push(value);
    }
    if (nearest.length > 0) {
      nearest.sort((a, b) => a - b);
      return nearest[Math.floor(nearest.length / 2)];
    }
  }
  return analysis.bpm >= 40 ? analysis.bpm : 0;
}

/** 规划用的一小节：有跟拍覆盖时直接用覆盖 BPM；有速度曲线时取曲线中位；否则回退拍点间隔。 */
function barMsForTrack(analysis: BeatAnalysis, track?: OnlineTrack | null): number {
  const override = bpmOverrideOf(track);
  if (override) return (60_000 / override) * meterOf(analysis);
  const curve = analysis.tempoCurveBpm;
  if (Array.isArray(curve) && curve.length > 0) {
    const usable = curve.filter((value) => value >= 40 && value <= 240).sort((a, b) => a - b);
    if (usable.length > 0) {
      const median = usable[Math.floor(usable.length / 2)];
      if (median > 0) return (60_000 / median) * meterOf(analysis);
    }
  }
  return barIntervalOf(analysis);
}

/** 规划用的整曲 BPM（跟拍覆盖优先）。 */
function effectiveBpm(analysis: BeatAnalysis, track?: OnlineTrack | null): number {
  const override = bpmOverrideOf(track);
  if (override) return override;
  return analysis.bpm >= 40 ? analysis.bpm : 0;
}

/**
 * 两首协调后的一小节：能做 WSOLA 变速对齐时 B 跟随 A（用 A 的小节），
 * 拍速差太大对不齐时取两首的谐波平均，让两首歌的拍子都算数。
 */
function coordinatedBarMs(
  a: BeatAnalysis,
  b: BeatAnalysis,
  trackA?: OnlineTrack | null,
  trackB?: OnlineTrack | null,
): { barMs: number; tempoAligned: boolean } {
  const barA = barMsForTrack(a, trackA);
  const barB = barMsForTrack(b, trackB);
  const bpmA = effectiveBpm(a, trackA);
  const bpmB = effectiveBpm(b, trackB);
  const window = tempoRateWindow();
  const tempoAligned =
    bpmA >= 40 && bpmB >= 40 && bpmA / bpmB >= window.min && bpmA / bpmB <= window.max;
  if (barA > 0 && barB > 0) {
    return { barMs: tempoAligned ? barA : (2 * barA * barB) / (barA + barB), tempoAligned };
  }
  if (barA > 0) return { barMs: barA, tempoAligned: false };
  if (barB > 0) return { barMs: barB, tempoAligned: false };
  return { barMs: 0, tempoAligned: false };
}

/** A 最后一个「outro」段落的起点（文件毫秒）；没有则 null。 */
function lastOutroStartMs(analysis: BeatAnalysis): number | null {
  const sections = Array.isArray(analysis.sections) ? analysis.sections : [];
  let best: number | null = null;
  for (const section of sections) {
    if (section.label !== 'outro' || !Number.isFinite(section.startMs)) continue;
    if (best === null || section.startMs > best) best = section.startMs;
  }
  return best;
}

interface AutoFadePlan {
  /** 本次目标淡化时长（毫秒）；手动 = 固定秒数 */
  ms: number;
  /** true = 本次是 auto 决策（false = 手动固定档位） */
  auto: boolean;
  /** auto 算出的小节数（手动/回退为 0） */
  bars: number;
  /** auto 使用的小节长（毫秒；手动/回退为 0） */
  barMs: number;
  /** 决策说明（调试/QA 用） */
  note: string;
}

/**
 * auto 过渡时长：以两首歌的小节为基准，再用 A 的尾奏 / B 的前奏-唱词空间伸展或缩小小节数。
 * 不再夹 5–10 秒：慢歌 4 小节可以到十几秒，快歌/双拍取两个乐句，实际时长随两首歌自由变化。
 */
function buildAutoFadePlan(
  options: CrossfadePrepareOptions,
  ctx: {
    currentStartMs: number;
    fileAudibleEndMs: number;
    baseBStartFileMs: number;
    vocalFileMs: number;
  },
): AutoFadePlan {
  const a = options.currentAnalysis.analysis;
  const b = options.nextAnalysis.analysis;
  const { barMs, tempoAligned } = coordinatedBarMs(a, b, options.current.track, options.next.track);
  if (!(barMs > 0)) {
    return { ms: AUTO_FALLBACK_MS, auto: true, bars: 0, barMs: 0, note: '无拍点，回退固定时长' };
  }

  let bars = tempoAligned ? AUTO_BARS : AUTO_BARS_MID;
  let note = tempoAligned ? '两首变速对齐，默认一个乐句' : '两首拍速差较大，多留两小节让鼓点交叠';
  // 小节特别短（快歌 / 双拍被分析成两倍速）：一个乐句只有 4 秒上下，取两个乐句更合适。
  if (barMs < AUTO_SHORT_BAR_MS) {
    bars = AUTO_BARS_LONG;
    note = '小节很短，取两个乐句';
  }

  // B 的短前奏不缩短 A 的过渡：首句可以在交叠中开始，A 仍播到自己的结尾。
  // 长前奏可在 A 也有尾奏空间时延长到两个乐句。
  const bRoomMs = ctx.vocalFileMs > 0 ? ctx.vocalFileMs - ctx.baseBStartFileMs : 0;
  if (bRoomMs >= AUTO_BARS_LONG * barMs) {
    // 想放宽到两个乐句：A 的尾奏也要够宽，否则会在最后的副歌里就开淡。
    const outroStartMs = lastOutroStartMs(a);
    const aTailMs = outroStartMs === null ? 0 : ctx.fileAudibleEndMs - (ctx.currentStartMs + outroStartMs);
    const roomMs = Math.min(aTailMs, bRoomMs);
    if (roomMs >= AUTO_BARS_LONG * barMs) {
      bars = AUTO_BARS_LONG;
      note = 'A 尾奏 + B 前奏宽裕，取两个乐句';
    } else if (roomMs >= AUTO_BARS_MID * barMs) {
      bars = AUTO_BARS_MID;
      note = '一侧空间宽裕，取一个半乐句';
    }
  }

  const rawMs = Math.round(barMs * bars);
  return {
    ms: Math.min(MAX_FADE_MS, Math.max(MIN_FADE_MS, rawMs)),
    auto: true,
    bars,
    barMs: Math.round(barMs),
    note,
  };
}

/**
 * 手动 / 按拍长度换算成毫秒：
 * - seconds 直接用秒数；
 * - beats / bars / phrase 用「A 在该处」的局部速度换算，变速歌不会按整曲 BPM 算偏；
 * - 没有拍点数据时退回「按秒数理解」，保证旧曲目也能用。
 */
function manualFadeMs(
  settings: CrossfadeSettings,
  analysis: BeatAnalysis,
  track: OnlineTrack | null | undefined,
  atFileMs: number,
): number {
  if (settings.lengthMode === 'auto') return 0;
  if (settings.lengthMode === 'seconds') return Math.round(settings.lengthValue * 1000);
  const bpm = tempoAtMs(track, analysis, atFileMs);
  if (!(bpm >= 40)) {
    // 没有拍点数据：拍/小节/乐句无法换算，返回 0 让上层退回自动方案（不要用秒数硬套，容易忽长忽短）。
    return 0;
  }
  const beatMs = 60_000 / bpm;
  const meter = meterOf(analysis);
  if (settings.lengthMode === 'beats') return Math.round(settings.lengthValue * beatMs);
  if (settings.lengthMode === 'bars') return Math.round(settings.lengthValue * beatMs * meter);
  // phrase：一小节太短时取两个乐句，与 auto 的短小节规则一致。
  const barMs = beatMs * meter;
  const bars = barMs < AUTO_SHORT_BAR_MS ? AUTO_BARS_LONG : AUTO_BARS;
  return Math.round(bars * barMs);
}

/** 本次淡化目标时长：手动（秒 / 拍 / 小节 / 乐句），或 auto 的「两首歌小节 + 结构空间」方案。 */
function resolveFadePlan(
  options: CrossfadePrepareOptions,
  ctx: Parameters<typeof buildAutoFadePlan>[1],
): AutoFadePlan {
  const settings = effectiveCrossfadeSettings(options.current.track);
  if (settings.lengthMode !== 'auto') {
    // 用可听结尾附近的局部速度换算拍/小节；秒数模式不受影响。
    const atMs = Math.max(ctx.currentStartMs, ctx.fileAudibleEndMs - 1_000);
    const ms = manualFadeMs(settings, options.currentAnalysis.analysis, options.current.track, atMs);
    if (ms > 0) return { ms, auto: false, bars: 0, barMs: 0, note: '手动 / 按拍长度' };
    // 旧曲目没有拍点/速度数据：退回自动方案，避免用错误速度算出的长度。
  }
  return buildAutoFadePlan(options, ctx);
}

/**
 * 生成时间表：A 在「可听结尾」倒数第 fadeMs 处的强拍开始淡化，B 从自己的强拍起播。
 * task-22：淡化终点对齐 analysis.audibleEndMs（排除尾部静音）；旧宿主缺失该字段时回退曲内时长。
 * 返回 null = 这次不适合无缝（时长不够 / B 太短 / 已经错过窗口）。
 */
/** 调性距离（0 = 同调/关系大小调；越大越冲突）；缺数据返回 -1。 */
function camelotGap(a?: string, b?: string): number {
  if (!a || !b) return -1;
  const pa = /^(\d{1,2})([AB])$/.exec(a);
  const pb = /^(\d{1,2})([AB])$/.exec(b);
  if (!pa || !pb) return -1;
  const na = Number(pa[1]);
  const nb = Number(pb[1]);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return -1;
  const diff = Math.abs(na - nb);
  const wheel = Math.min(diff, 12 - diff);
  return wheel + (pa[2] === pb[2] ? 0 : 1);
}

/**
 * 风格画像缓存：同一首歌在连续过渡里会被反复取用，`resolveStyleProfile` 虽然纯函数，
 * 但一次要遍历活动度曲线与风格特征；缓存按「曲目 + 分析版本」失效，最多 64 条。
 */
const STYLE_PROFILE_CACHE = new Map<string, StyleProfile>();

function styleProfileFor(track: OnlineTrack, result: AnalysisResult): StyleProfile {
  const analysis = result.analysis;
  // 宿主分析缓存里带了 styleProfile 就直接用（Lead 在 analysis.ts 合入该字段）。
  const embedded = (analysis as BeatAnalysis & { styleProfile?: StyleProfile }).styleProfile;
  if (embedded) return embedded;
  const key = [
    track.source, track.id, track.title, track.artist,
    result.analyzer ?? '', analysis.bpm ?? 0, result.durationMs,
  ].join('|');
  const hit = STYLE_PROFILE_CACHE.get(key);
  if (hit) return hit;
  const profile = resolveStyleProfile({
    analysis,
    meta: { title: track.title, artist: track.artist },
    styleFeatures: result.features?.style ?? null,
  });
  if (STYLE_PROFILE_CACHE.size >= 64) {
    const oldest = STYLE_PROFILE_CACHE.keys().next().value;
    if (oldest !== undefined) STYLE_PROFILE_CACHE.delete(oldest);
  }
  STYLE_PROFILE_CACHE.set(key, profile);
  return profile;
}

/** 人声强度 0..1（策略只需要「这首有没有人唱、占多少时间」）。 */
function styleVocalScore(analysis: BeatAnalysis): number {
  const detail = vocalPresenceDetail(analysis);
  if (detail.kind === 'instrumental') return 0;
  if (detail.kind === 'vocal') return Math.max(0.5, Math.min(1, detail.voiced));
  return 0.4;
}

/**
 * auto 优先完整交叠。拍速或调性单独不匹配时保持等功率交叠，
 * 只有两者都明显冲突时才快速切入。
 */
/** 某条活动度曲线在文件时间段的均值（越界夹取，缺失返回 0）。 */
function meanActivity(analysis: BeatAnalysis, key: 'vocal' | 'drum' | 'bass', fromMs: number, toMs: number): number {
  const act = analysis.activity;
  const curve = act?.[key];
  if (!curve || !curve.length) return 0;
  const hop = act && act.hopMs > 0 ? act.hopMs : 250;
  const i0 = Math.max(0, Math.floor(fromMs / hop));
  const i1 = Math.min(curve.length - 1, Math.ceil(toMs / hop));
  if (i1 < i0) return 0;
  let sum = 0;
  let n = 0;
  for (let i = i0; i <= i1; i += 1) { sum += curve[i] ?? 0; n += 1; }
  return n ? sum / n : 0;
}

function resolveTransitionStyle(
  settings: CrossfadeSettings,
  analysis: BeatAnalysis,
  nextAnalysis: BeatAnalysis,
): 'am' | 'equal' | 'cut' {
  if (settings.style !== 'auto') return settings.style;
  const ratio = nearestTempoRatio(analysis.bpm / nextAnalysis.bpm);
  const difference = Math.abs(ratio - 1);
  const reliable = analysis.bpmConfidence >= 0.5 && nextAnalysis.bpmConfidence >= 0.5;
  const gap = camelotGap(analysis.camelot, nextAnalysis.camelot);
  // 低置信度只关闭变速；只有明确不兼容才短切。
  if (reliable && difference > 0.25 && gap > 5) return 'cut';
  return 'equal';
}

/** 取指定标签段落的起点（文件毫秒）；没有返回 0。 */
function sectionStartOf(analysis: BeatAnalysis, label: string): number {
  const section = (analysis.sections ?? []).find((item) => item.label === label);
  return section ? section.startMs : 0;
}

/** 把目标时间对齐到乐句网格（按 downbeats 里每 bars 个小节一个边界）；越界取最近边界。 */
function phraseCue(analysis: BeatAnalysis, targetMs: number, bars: number, fallback: number): number {
  const downbeats = analysis.downbeats ?? [];
  if (downbeats.length === 0 || !(bars > 0)) return Math.round(fallback);
  let best = 0;
  for (let index = 0; index < downbeats.length; index += 1) {
    if (index % bars !== 0) continue;
    best = index;
    if (downbeats[index] >= targetMs) break;
  }
  return Math.round(downbeats[best]);
}

interface StructureCue {
  fadeStartFileMs: number;
  fadeMs: number;
  bStartFileMs: number;
  bars: number;
  cueInMs: number;
  cueOutMs: number;
  cueMode: CrossfadeCueMode;
  /** 实际小节时长（毫秒）。手动过渡时长与结构小节数解耦后，低频交接仍按真实小节线换算。 */
  barMs: number;
}

/**
 * 结构信息只选择 B 的入场点和过渡小节长度。A 的淡化终点始终是可信的可听结尾；
 * cue-out 是启发式段落边界，不能用作淡化起点，否则识别偏早时会截掉后半首。
 */
function buildStructureCue(args: {
  settings: CrossfadeSettings;
  analysis: BeatAnalysis;
  nextAnalysis: BeatAnalysis;
  currentStartMs: number;
  currentPosMs: number;
  fileAudibleEndMs: number;
  nextStartMs: number;
  nextDurationMs: number;
  desiredMs: number;
  track?: OnlineTrack | null;
}): StructureCue | null {
  const {
    settings,
    analysis,
    nextAnalysis,
    currentStartMs,
    currentPosMs,
    fileAudibleEndMs,
    nextStartMs,
    nextDurationMs,
    desiredMs,
    track,
  } = args;
  // auto：full = 8 小节，fast = 2 小节，balanced = 4 小节（此前 fast 与 balanced 没区别）。
  const bars =
    settings.bars === 'auto'
      ? settings.preset === 'full'
        ? 8
        : settings.preset === 'fast'
          ? 2
          : 4
      : settings.bars;
  const meter = meterOf(analysis);
  const endBpm = tempoAtMs(track, analysis, fileAudibleEndMs - 1_000);
  const barMs = endBpm >= 40 ? (60_000 / endBpm) * meter : barIntervalOf(analysis);
  if (!(barMs > 0)) return null;
  let cueIn = 0;
  // 「自动」= 从曲首进、接上一首尾部（不再直接跳到副歌/drop）。
  // 手动选项仍然可以指定从 drop / 副歌 / intro 之后进。
  const headMode = settings.cueMode === 'auto';
  if (headMode) {
    cueIn = nextStartMs;
  } else if (settings.cueMode === 'intro') {
    const intro = (nextAnalysis.sections ?? []).find((item) => item.label === 'intro');
    cueIn = intro ? intro.endMs : 0;
  } else {
    cueIn = sectionStartOf(nextAnalysis, settings.cueMode);
  }
  if (!(cueIn > nextStartMs)) cueIn = nextStartMs;
  // 自动模式严格从曲首起播，不再按乐句网格把 B 往后推；手动模式仍对齐乐句。
  const alignedCueIn = headMode ? cueIn : phraseCue(nextAnalysis, cueIn, bars, cueIn);
  const earliestStart = currentStartMs + currentPosMs + 80;
  const manualMs = manualFadeMs(
    settings,
    analysis,
    track,
    fileAudibleEndMs - 1_000,
  );
  // balanced 用两首歌算出的自适应长度；其它预设及指定小节数按尾端局部 BPM 换算。
  let fadeMs = manualMs > 0 ? manualMs
    : settings.bars === 'auto' && settings.preset === 'balanced' ? desiredMs
      : Math.round(bars * barMs);
  if (settings.style === 'cut' || (manualMs <= 0 && resolveTransitionStyle(settings, analysis, nextAnalysis) === 'cut')) {
    fadeMs = Math.min(fadeMs, 2_400);
  }
  fadeMs = Math.min(MAX_FADE_MS, fadeMs);
  if (nextDurationMs > 0) {
    const room = nextDurationMs - (alignedCueIn - nextStartMs);
    if (room < MIN_FADE_MS + 400) return null;
    fadeMs = Math.min(fadeMs, Math.round(room - 400));
  }
  const target = fileAudibleEndMs - fadeMs;
  const snapped = snapToGrid(analysis, target, currentStartMs, settings.alignment);
  const fadeStart = Math.max(earliestStart, currentStartMs, snapped === null ? target : snapped);
  fadeMs = Math.round(fileAudibleEndMs - fadeStart);
  if (fadeMs < MIN_FADE_MS) return null;

  return {
    fadeStartFileMs: Math.round(fadeStart),
    fadeMs: Math.round(fadeMs),
    bStartFileMs: Math.round(alignedCueIn),
    bars,
    cueInMs: Math.round(alignedCueIn),
    cueOutMs: Math.round(fadeStart),
    cueMode: settings.cueMode,
    barMs: Math.round(barMs),
  };
}

/**
 * v2 档能真正演奏的手法：`requires` 里的原语必须已经有 DSP。
 *
 * 目录里还有 loopRoll / backspin / doubling / acapellaOverlay / halfTime / keyLift /
 * dropSwap / doubleDrop —— 它们需要新的音频原语（实时 loop 重排、倒放、移调叠加等），
 * 先保留在 styleKit 里，被选中时降级到下一个可演奏手法，并在 reasons 里写明原因。
 */
/**
 * 「苹果系」手法：苹果实际的 Smart Transitions 只用了极少数几种形状——
 * `TransitionStyles.json` 里 24 个风格，真实运行日志（`runtime-transitions.csv`）只出现
 * `Beat-Matched Pop - 16`（滤波 + delay 收尾）、`Beat-Matched Filtered Cross-Fade - 8`
 * （高通下扫 + 低通打开）、`Dead-Air Removal - 0`（掐掉空转）。
 *
 * 对应到我们的手法库：
 * - `filterSweep` ← 8 / 9（Filter high to low / Filter expansion）
 * - `echoOut`     ← 16（Pop - Delay out）
 * - `reverbOut`   ← 13 / 20（Filter soft + Reverb）
 * - `longBlend`   ← 1 / 2（Classic / Soft cross-fade）
 * - `cut`         ← 0（Dead-Air Removal 的极端形态）
 *
 * 打分仍然照旧（可解释、带 reasons），只是**平手时偏向苹果系**：苹果听感的一致性
 * 来自「总是那几种形状」，而不是每对歌都换一个新花样。
 */
const APPLE_CORE_STYLES: ReadonlySet<TransitionStyleId> = new Set<TransitionStyleId>([
  'filterSweep',
  'echoOut',
  'reverbOut',
  'longBlend',
  'cut',
]);

/** 苹果系被别的风格压过多少分才肯让步（分越高越固执）。 */
const APPLE_PREFERENCE_BIAS = 12;

/** 运行时读偏置（体检台用它做 A/B：`--store=zilux2.dev.applebias=0` 即关掉）。 */
function applePreferenceBias(): number {
  try {
    const raw = localStorage.getItem('zilux2.dev.applebias');
    if (raw === null) return APPLE_PREFERENCE_BIAS;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(20, n)) : APPLE_PREFERENCE_BIAS;
  } catch {
    return APPLE_PREFERENCE_BIAS;
  }
}

const V2_PLAYABLE_STYLES: ReadonlySet<TransitionStyleId> = new Set<TransitionStyleId>([
  'bassSwap',
  'eqSwap',
  'filterSweep',
  'echoOut',
  'reverbOut',
  'longBlend',
  'acapellaOverlay',
  'cut',
  'slam',
  'halfTime',
  'backspin',
  'loopRoll',
  'dropSwap',
  'doubleDrop',
  'doubling',
]);

interface V2StylePick {
  id: TransitionStyleId;
  label: string;
  params: StyleParams;
  reasons: string[];
  /** 原本选中但缺原语、被降级时，记录它的标签。 */
  downgradedFrom?: string;
}

/**
 * 按当前两首曲子的属性挑一种过渡手法。
 *
 * 只做决策、不碰音频：真正的参数由 startSplitMix 读 `plan.styleParams` 施加。
 * 任何异常都返回 null —— 过渡本身绝不能因为「选风格」而失败。
 */
// 手法选择里有一个 `catch { return null }`：只要任意一步抛异常，整条 v2 决策就静默退化成
// 「没有手法」（窗口还在，但没有扫频/让位/回声），体检台只会看到 `tech=-`。
// 把最后一次异常文本留在这里，报告和日志才追得下去。
let lastStyleErrorText: string | null = null;

/** 最近一次手法选择抛出的异常文本；没抛过返回 null。 */
export function lastStyleError(): string | null {
  return lastStyleErrorText;
}

function pickV2StyleFor(input: {
  a: BeatAnalysis;
  b: BeatAnalysis;
  fadeMs: number;
  barMs: number;
  beatMs: number;
  bFirstVocalFileMs?: number;
  /** B 首句的**曲内偏移**（文件毫秒 − nextStartMs）。判「有没有前奏」必须用它。 */
  bFirstVocalOffsetMs?: number;
  /** 变速之后的等效 BPM：风格打分要看「能不能对上」，不是原始 BPM。 */
  bpmAEff?: number;
  bpmBEff?: number;
  /** 未拉拍时的原始 BPM 差（百分比）。差得远时「回声收尾」反而是正解。 */
  bpmGapPct?: number;
  /** 这首曲风的「手势/短过渡」上限（`genreProfile.gestureMaxMs`）。techno/ambient 的 8 小节
      本来就长过 6 s 的默认闸门，用曲风预算替掉硬编码的 6000 才不会把它们逼回 bassSwap。 */
  gestureCapMs?: number;
}, opts?: { allowCut?: boolean }): V2StylePick | null {
  try {
    const a = input.a;
    const b = input.b;
    const presenceA = vocalPresence(a);
    const presenceB = vocalPresence(b);
    const ranked = rankStyles({
      bpmA: Number.isFinite(input.bpmAEff ?? NaN) ? (input.bpmAEff as number) : a.bpm,
      bpmB: Number.isFinite(input.bpmBEff ?? NaN) ? (input.bpmBEff as number) : b.bpm,
      keyGap: camelotGap(a.camelot, b.camelot),
      energyGap: Math.max(0, Math.min(1, Math.abs((a.energy ?? 0.5) - (b.energy ?? 0.5)))),
      meterA: a.meter,
      meterB: b.meter,
      aVocal: presenceA === 'vocal',
      bVocal: presenceB === 'vocal',
      aHasIntro: (a.sections ?? []).some((sec) => sec.label === 'intro') || (a.cueInMs ?? 0) > 0,
      // 前奏长度是「曲内偏移」，不是文件毫秒：带 startAt 的入场（续播/片段起播）
      // 用文件时间判会把「一开播就唱」误判成「有长前奏」，入口类手法全被放行。
      bHasIntro: (input.bFirstVocalOffsetMs ?? input.bFirstVocalFileMs ?? 0) >= 1_500,
    bHasDrop: (b.sections ?? []).some((sec) => sec.label === 'drop' || sec.label === 'chorus'),
      aHasOutro: (a.sections ?? []).some((sec) => sec.label === 'outro'),
      bFirstVocalMs: input.bFirstVocalFileMs ?? 0,
      aLoopUnits: (a.loopUnits ?? []).length,
      bLoopUnits: (b.loopUnits ?? []).length,
      fadeMsWanted: input.fadeMs,
      barMs: input.barMs,
      beatMs: input.beatMs,
      tempoSoftLimit: 8,
      tempoHardLimit: 15,
      aInstrumental: presenceA === 'instrumental',
      bInstrumental: presenceB === 'instrumental',
      hasDownbeat: (a.downbeats ?? []).length > 0,
    });
    const skipped: string[] = [];
    const allowCut = opts?.allowCut === true;
    // BPM 差 25%+ 时，长窗口的 echo/reverb 会拖成一片「糊响」；这种场合
    // 真正对的是硬切/砸切。这里是引擎的确定性策略，不交给打分（打分偏爱 echoOut）。
    const gapPct = input.bpmGapPct ?? 0;
    const ratio = a.bpm > 0 && b.bpm > 0 ? a.bpm / b.bpm : 1;
    const octave = Math.round(Math.log2(ratio));
    const halfDouble = Math.abs(Math.log2(ratio) - octave) < 0.06 && octave !== 0;
    const energyStep = Math.abs((a.energy ?? 0.5) - (b.energy ?? 0.5));
    // 默认不做「大差距一律砸切」：那会让全库 1/4 的歌变成硬切，与「丝滑」相反。
    // 想启用激进策略：localStorage['zilux2.dev.hardcut']='1'（体检台可用它做对照）。
    let forceHardOk = false;
    try {
      forceHardOk = localStorage.getItem('zilux2.dev.hardcut') === '1';
    } catch {
      forceHardOk = false;
    }
    if (allowCut && forceHardOk && !halfDouble && gapPct > 28 && input.fadeMs >= 8_000 && energyStep >= 0.3) {
      const hardId: TransitionStyleId =
        (a.energy ?? 0) >= 0.6 && (b.energy ?? 0) >= 0.5 ? 'slam' : 'cut';
      const row = ranked.find((r) => r.spec.id === hardId && !r.blockedBy);
      if (row) {
        return {
          id: hardId,
          label: describeStyle(hardId),
          params: row.spec.params,
          reasons: [`BPM 差 ${gapPct.toFixed(1)}%，长窗口交叠必然糊`, ...row.reasons],
        };
      }
    }
    const playable: { row: (typeof ranked)[number]; id: TransitionStyleId }[] = [];
    for (const row of ranked) {
      if (row.blockedBy) continue;
      const id = row.spec.id;
      if (!V2_PLAYABLE_STYLES.has(id)) {
        skipped.push(`${row.spec.label}（缺 ${row.spec.requires.join('/')} 原语）`);
        continue;
      }
      if (id === 'cut' || id === 'slam' || id === 'backspin') {
        // 硬切/砸切一律 opt-in：默认库里 1/4 的歌会变成硬切，与「丝滑过渡」相反。
        // 开关：localStorage['zilux2.dev.hardcut']='1'。
        if (!forceHardOk) {
          skipped.push(`${row.spec.label}（硬切需开发者开关 zilux2.dev.hardcut=1）`);
          continue;
        }
        if (!allowCut) {
          skipped.push(`${row.spec.label}（乐句交叠路径不能硬切）`);
          continue;
        }
      }
      // echoOut / reverbOut 是「短窗口收尾」手法：12 s 的长交叠里再加回声只会糊。
      const bigTempoGap = (input.bpmGapPct ?? 0) > 15;
      const shortCap = Number.isFinite(input.gestureCapMs) && (input.gestureCapMs ?? 0) > 2_400
        ? Math.round(input.gestureCapMs as number)
        : 6_000;
      if ((id === 'echoOut' || id === 'reverbOut') && input.fadeMs > shortCap && !bigTempoGap) {
        skipped.push(`${row.spec.label}（窗口 ${(input.fadeMs / 1000).toFixed(1)}s 超过 6s 上限）`);
        continue;
      }
      playable.push({ row, id });
    }
    if (playable.length > 0) {
      const best = playable[0];
      // 苹果系优先：分数差在 bias 之内时，选更像苹果的那一个。
      const bestApple = playable.find((p) => APPLE_CORE_STYLES.has(p.id));
      const bias = applePreferenceBias();
      const chosen = bias > 0 && bestApple && bestApple !== best
        && best.row.score - bestApple.row.score <= bias
        ? bestApple
        : best;
      const appleNote = chosen === bestApple && chosen !== best
        ? `苹果系优先（${chosen.row.spec.label} 比 ${best.row.spec.label} 低 ${(best.row.score - chosen.row.score).toFixed(1)} 分，差在 ${bias} 分内）`
        : null;
      const reasonList = chosen.row.reasons.slice();
      if (appleNote) reasonList.push(appleNote);
      if (skipped.length > 0) reasonList.push(`跳过：${skipped.join('、')}`);
      return {
        id: chosen.row.spec.id,
        label: chosen.row.spec.label,
        params: chosen.row.spec.params,
        reasons: reasonList,
        downgradedFrom: skipped.length > 0 ? skipped[0] : undefined,
      };
    }
    // 兜底：所有手法都被门控挡住（典型是 BPM 差 20%+ 又没到硬切），
    //   按「低频换手 + 轻扫频 + 回声收尾」处理，并把第一条拦截原因写进 reasons。
    const firstBlocked = ranked.find((row) => row.blockedBy);
    // 兜底也走苹果的形状：`Filtered Cross-Fade`（高通下扫 + 低通打开）比纯低频换手更像苹果，
    // 而且它天生带着低频让位（B 的高通一开，低频自然从 A 移过去）。
    return {
      id: 'filterSweep',
      label: describeStyle('filterSweep'),
      params: { swapShare: 0.3, sweepShare: 0.45, duckDb: -5, tailHold: 0.12 },
      reasons: [
        firstBlocked?.blockedBy ?? '没有更贴合的专用手法',
        '兜底：按苹果的滤波交叉（B 高通下扫 + A 低通变闷）处理，不强行拉拍',
      ],
      downgradedFrom: firstBlocked?.spec.label,
    };
  } catch (error) {
    lastStyleErrorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return null;
  }
}

/**
 * 窗口关不住 A 最后一句时的兜底：不再直接切走，让 A 停在 −10 dB 把这一句唱完，
 * 再在窗口后用 tailBleed 收干（最多 3 s）。乐句路径与常规路径共用同一套数字。
 */
function applyVocalTailGuard(
  schedule: FadeSchedule,
  analysis: BeatAnalysis,
  currentStartMs: number,
  audibleEndPosMs: number,
): void {
  if (!isAutomixV2(effectiveMode())) return;
  if (schedule.cleanPickup || schedule.bridge || schedule.backspin || schedule.loopRoll) return;
  if (!(audibleEndPosMs > 0)) return;
  const raw = lastVocalEnd(analysis, audibleEndPosMs);
  if (!(raw > 0)) return;
  const lastVocalFileMs = currentStartMs + Math.min(raw, audibleEndPosMs);
  const needEndMs = lastVocalFileMs + 600;
  const endNowMs = schedule.fadeStartFileMs + schedule.fadeMs;
  if (needEndMs <= endNowMs + 200) return;
  const coverMs = Math.min(3000, Math.round(needEndMs - endNowMs) + 600);
  if (!(coverMs >= 600)) return;
  schedule.aTailBleedMs = Math.max(schedule.aTailBleedMs ?? 0, coverMs);
  schedule.aTailHold = Math.max(schedule.aTailHold ?? 0, 0.32);
  schedule.tailGuardMs = coverMs;
  logEvent('automix-v2-vocal-tail',
    `窗口末端早于 A 末句 ${Math.round(needEndMs - endNowMs)}ms，A 停在 ${(20 * Math.log10(schedule.aTailHold)).toFixed(0)} dB 唱完再收（tailBleed ${coverMs}ms）`);
}

function buildSchedule(options: CrossfadePrepareOptions): FadeSchedule | null {
  pairMixMode = decidePairMode(options.currentAnalysis?.analysis, options.nextAnalysis?.analysis, estimatePlannedMs());
  if (readMixTransitionMode() === 'auto') {
    logEvent('automix-auto-mode', pairMixMode === 'automixV2' ? '自动：两首数据完整，走进阶混音' : '自动：拍点/调性/活动度不足，走标准');
  }
  const currentStartMs = options.current.startAt * 1000;
  const currentPosMs = Math.max(0, options.currentPositionMs);
  const durationMs = options.currentDurationMs;
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) return null;

  const analysis = options.currentAnalysis.analysis;
  // 可听结尾是文件毫秒：CUE 分轨先换算成段内位置再夹进 [0, durationMs]；
  // 缺失（旧宿主 / 旧缓存）或越界时回退曲内时长，行为与 task-19 一致。
  const rawAudibleEnd = analysis.audibleEndMs;
  const reportedEndPosMs = typeof rawAudibleEnd === 'number' && Number.isFinite(rawAudibleEnd)
    ? rawAudibleEnd - currentStartMs : 0;
  // 超长「静音」很可能来自错误时长/解码或旧分析缓存；保留歌曲完整性优先。
  const plausibleTailMs = Math.min(20_000, durationMs * 0.2);
  const audibleEndPosMs = reportedEndPosMs > 0 &&
    reportedEndPosMs <= durationMs && durationMs - reportedEndPosMs <= plausibleTailMs
    ? reportedEndPosMs : durationMs;
  const tailSilenceMs = Math.max(0, durationMs - audibleEndPosMs);
  const fileAudibleEndMs = currentStartMs + audibleEndPosMs;

  // ---- B 侧：优先让「淡化结束」正好落在下一首的开始唱词 ----
  const nextStartMs = options.next.startAt * 1000;
  const nextDurationMs =
    options.next.track.durationMs > 0
      ? options.next.track.durationMs
      : Math.max(0, options.nextAnalysis.durationMs - nextStartMs);
  const nextLimitMs = nextDurationMs > 0 ? nextStartMs + nextDurationMs : 0;
  const nextAnalysis = options.nextAnalysis.analysis;
  // 风格画像/策略：EQ、窗口缩放、duck 与延长预算都由这两首的画像 + 当前上下文决定。
  // 纯计算，放在 buildSchedule 规划期；播放期只读 StylePolicy，不再推理。
  const styleProfileA = styleProfileFor(options.current.track, options.currentAnalysis);
  const styleProfileB = styleProfileFor(options.next.track, options.nextAnalysis);
  // 谱质心差（整曲平均）：B 明显更暗/更亮时，用它给 presence 一点补偿。
  // 只看 style 曲线，没有就把 eq 留平；补偿上限 ±3 dB，编曲级差异（808 vs 弦乐）不硬修。
  const meanCentroidHz = (an: BeatAnalysis): number | null => {
    const cur = an.styleFeatures?.centroidHz;
    if (!cur || cur.length < 3) return null;
    let sum = 0;
    for (const v of cur) sum += v;
    return cur.length ? sum / cur.length : null;
  };
  const timbreComp = planTimbreCompDb(meanCentroidHz(analysis), meanCentroidHz(nextAnalysis));
  const stylePolicyFor = (windowMs: number, windowBarMs: number): StylePolicy => {
    const rawKeyGap = camelotGap(analysis.camelot, nextAnalysis.camelot);
    const policy = resolveStylePolicy(styleProfileA, styleProfileB, {
      // 缺调性（-1）按「相邻」中性处理，不能让未知数据误触发同调规则把 EQ 清零。
      keyGap: rawKeyGap < 0 ? 1 : rawKeyGap,
      bpmGap: analysis.bpm > 0 ? Math.abs(nextAnalysis.bpm - analysis.bpm) / analysis.bpm : 0,
      energyGap: Math.abs((analysis.energy ?? 0) - (nextAnalysis.energy ?? 0)),
      windowMs: Math.max(0, windowMs),
      barMs: Math.max(1, windowBarMs),
      aVocal: styleVocalScore(analysis),
      bVocal: styleVocalScore(nextAnalysis),
    });
    if (timbreComp) {
      const clamp3 = (v: number) => Math.max(-3, Math.min(3, Math.round(v * 10) / 10));
      policy.eq.aPresenceDb = clamp3(policy.eq.aPresenceDb + timbreComp.aPresenceDb);
      policy.eq.bPresenceDb = clamp3(policy.eq.bPresenceDb + timbreComp.bPresenceDb);
    }
    return policy;
  };
  const nextFirstDownbeat = pickDownbeatAtOrAfter(nextAnalysis, nextStartMs, nextLimitMs);
  const baseBStartFileMs = nextFirstDownbeat === null ? nextStartMs : nextFirstDownbeat;

  const settings = effectiveCrossfadeSettings(options.current.track);
  // v2 的最短混音时长：决定 E8 桥接要不要补、以及淡化窗口至少多长（标准档 = 0，不受约束）。
  const floorMs = resolveMixFloorMs(settings);

  // ---- 唱词锚点（进阶 v2）：没有歌词也能把过渡落到「B 的唱词时段」----
  // 曲线来自宿主 p1-0 的 activity.vocal（250 ms 一格）；歌词坐标精确到毫秒，
  // 所以只要歌词可用就优先用歌词，曲线只做兜底与「从副歌人声进来」的选点。
  const v2VocalAnchor = isAutomixV2(effectiveMode());
  let activityVocalEntryMs = 0;
  let activityLastVocalEndMs = 0;
  // 旋律相似度（p1-1）：只用于浮层显示与日志，0 = 没算/没有 chroma。
  let melodySim = 0;
  // 「真开唱」的强判定结果（连续 1.5s ≥0.6）。歌词常把前奏的呼吸/人声切片标成第一句，
  // 这时以曲线为准——否则 B 的整段前奏根本用不上。
  let strongVocalEntryMs = 0;
  if (v2VocalAnchor && settings.vocalAnchor !== 'off' && anchorPresenceOk(nextAnalysis)) {
    const entry = selectVocalEntry(
      nextAnalysis,
      settings.vocalAnchor === 'auto' ? 'first' : settings.vocalAnchor,
      { fromMs: nextStartMs, barMs: barIntervalOf(nextAnalysis), clearRunMs: floorMs },
    );
    if (entry) activityVocalEntryMs = entry.ms;
    // 「自动 / 首句」用强判定覆盖：连续 1.5 s ≥0.6 才算真开唱，
    // 前奏里的人声切片/呼吸不会再把过渡锚到第 2 秒（春めく 就是这种情况）。
    if (settings.vocalAnchor === 'auto' || settings.vocalAnchor === 'first') {
      // 先用「第一段唱句」（时长 ≥1.2 s、均值 ≥0.5）——它不会因为第一句偏轻就跳到第二、三句；
      // 段判定拿不到时才退回连续强度判定（1.5 s ≥0.6）。
      // 浮层开关「短句也算第一句」：放行 600–1200 ms 的短首句（Attention 这类歌），
      // 关掉时保留 1.2 s 门槛，避免前奏里的单次呼吸峰被当成第一句（春めく 第 2 秒）。
      const shortLineOk = localStorage.getItem('zilux2.dev.shortline') === '1';
      const line = firstVocalLineMs(nextAnalysis, { fromMs: nextStartMs, minMs: shortLineOk ? 600 : 1_200 });
      const strong = line > 0 ? 0 : firstStrongVocalMs(nextAnalysis, { fromMs: nextStartMs });
      const best = line > 0 ? line : strong;
      if (best > 0) {
        strongVocalEntryMs = best;
        activityVocalEntryMs = best;
      }
    }
    // ---- 旋律相似度选点：A 的尾段像什么，就在 B 里找最像的那一句 ----
    // 「自动」档才做这件事：用户明确选了首句/副歌/最强时以用户为准。
    // 需要宿主 p1-1 的逐小节 chroma；缺失时静默跳过（老缓存仍然按 activity 选点）。
    if (settings.vocalAnchor === 'auto' && !(options.nextVocalStartMs || strongVocalEntryMs || activityVocalEntryMs)) {
      const segments = findVocalSegments(nextAnalysis);
      const candidates = segments
        .map((segment) => segment.startMs)
        .filter((ms) => ms >= nextStartMs && ms <= nextStartMs + Math.max(6000, floorMs * 8));
      if (candidates.length > 1) {
        const melody = pickMelodyEntry({
          a: analysis,
          b: nextAnalysis,
          entries: candidates,
          aEndMs: fileAudibleEndMs,
          windowBars: MELODY_WINDOW_BARS,
        });
        if (melody && melody.entryMs !== activityVocalEntryMs) {
          logEvent(
            'automix-v2-melody',
            `B 入口按旋律相似度选在 ${Math.round(melody.entryMs - nextStartMs)}ms（相似度 ${melody.sim.toFixed(2)}，共 ${candidates.length} 句候选）`,
          );
          activityVocalEntryMs = melody.entryMs;
          melodySim = melody.sim;
        } else if (melody) {
          melodySim = melody.sim;
        }
      }
    }
    // ---- 入点打分：如果首句会把 A 的末句切掉，就往后再挑一句能装下 A 的唱句 ----
    // 只是「换一句进」，不改窗口公式；最多往后 16 s，且候选自身要有够清楚的人声。
    if (settings.vocalAnchor === 'auto' && !options.nextVocalStartMs && activityVocalEntryMs > 0 && anchorPresenceOk(analysis)) {
      const aLast = currentStartMs + Math.min(lastVocalEnd(analysis, fileAudibleEndMs), fileAudibleEndMs > 0 ? fileAudibleEndMs : Number.POSITIVE_INFINITY);
      const needEnd = aLast + 600;
      const endNow = activityVocalEntryMs - 150;
      if (needEnd > endNow + 400) {
        const later = findVocalSegments(nextAnalysis)
          .filter((seg) => seg.startMs - 150 >= needEnd && seg.startMs <= activityVocalEntryMs + 16000 && seg.mean >= 0.5)
          .sort((x, y) => x.startMs - y.startMs)[0];
        if (later) {
          logEvent('automix-v2-entry-score',
            `首句会把 A 末句切掉 ${Math.round(needEnd - endNow)}ms，改从 ${Math.round(later.startMs - nextStartMs)}ms 的第二句进（清晰度 ${later.mean.toFixed(2)}）`);
          activityVocalEntryMs = later.startMs;
        }
      }
    }
    if (anchorPresenceOk(analysis)) {
      activityLastVocalEndMs = lastVocalEnd(analysis, fileAudibleEndMs);
    }
  }

  const rawVocalStart = options.nextVocalStartMs;
  // 歌词坐标是「曲内毫秒」，曲线坐标是「文件毫秒」，统一到文件坐标再仲裁。
  const lyricVocalFileMs =
    typeof rawVocalStart === 'number' && Number.isFinite(rawVocalStart) && rawVocalStart > 0
      ? nextStartMs + Math.round(rawVocalStart)
      : 0;
  // 先验证歌词，再仲裁：歌词可验证时**不看距离**直接采信（毫秒精度）。
  //   距离门槛原本是 8 小节（≈19 s），Attention 的歌词 9.28 s 与曲线 28.25 s 差 18.97 s
  //   刚好卡在门槛外（bar 取 2000 时门槛 16 s），于是被误判成「歌词错位」→ 落到第二段。
  const barNextForAnchor = barIntervalOf(nextAnalysis) || 2000;
  const lyricPosGuess = lyricVocalFileMs > nextStartMs ? Math.round(lyricVocalFileMs - nextStartMs) : 0;
  // 歌词点之后一个小节内要能找到「≥600 ms 连续 ≥0.4」的唱句起头。
  //   不能要求「歌词点那一帧就 ≥0.4」：活动度是 250 ms 网格 + 特征窗，天然滞后约 250 ms
  //   （Attention 9.28 s 那帧只有 0.268，但 9.50 s 起是 0.51/0.59/0.59）。
  const vocalRunAfter = (posMs: number, windowMs: number): boolean => {
    const vocal = nextAnalysis.activity?.vocal;
    if (!vocal) return false;
    const hop = Math.max(50, nextAnalysis.activity?.hopMs || 250);
    const from = Math.max(0, Math.floor(posMs / hop));
    const to = Math.min(vocal.length - 1, Math.ceil((posMs + windowMs) / hop));
    let run = 0;
    for (let i = from; i <= to + 1; i++) {
      if ((vocal[i] ?? 0) >= 0.4) {
        run += hop;
        if (run >= 600) return true;
      } else {
        run = 0;
      }
    }
    return false;
  };
  const lyricVerified = lyricPosGuess > 0 && (() => {
    const support = vocalEnergyNear(nextAnalysis, lyricPosGuess, { beforeMs: 500, afterMs: barNextForAnchor * 2 });
    return support >= 0.4 && vocalRunAfter(lyricPosGuess, barNextForAnchor);
  })();
  const vocalReconcile = reconcileVocalAnchor({
    lyricMs: lyricVocalFileMs,
    curveMs: activityVocalEntryMs,
    barMs: barNextForAnchor,
    toleranceBars: lyricVerified ? 999 : undefined,
  });
  if (lyricVerified && v2VocalAnchor) {
    logEvent('automix-v2-lyric-verified', `B 入口取歌词 ${lyricPosGuess}ms（该处有持续唱句，验证通过）`);
  }
  if (v2VocalAnchor && vocalReconcile.source === 'curve' && lyricVocalFileMs > 0) {
    logEvent('automix-v2-anchor', `B ${vocalReconcile.reason}`);
  }
  let vocalEntryMs = v2VocalAnchor && activityVocalEntryMs > 0 &&
    (settings.vocalAnchor === 'chorus' || settings.vocalAnchor === 'strongest' || melodySim > 0)
    ? activityVocalEntryMs : vocalReconcile.ms;
  // 歌词 vs 曲线的仲裁不再看「谁更晚」，而是看「歌词说的那个位置音频里有没有人唱」。
  //   Attention：歌词 9.28 s，曲线只有 28.25 s —— 但 9.5 s 处确有 0.56 的唱句，
  //   所以歌词是对的，不能用「曲线更晚」把它推翻（那正是「过渡完已经唱过好几段」的原因）。
  //   春めく：歌词（若有）指向 2 s，可那里只有 0.57 的单帧呼吸峰、没有持续唱句 → 判为不可信。
  if (v2VocalAnchor && (settings.vocalAnchor === 'auto' || settings.vocalAnchor === 'first')) {
    const lyricPos = Math.max(0, vocalEntryMs - nextStartMs);
    const barNext = barIntervalOf(nextAnalysis) || 2000;
    const lyricIsCurve = vocalEntryMs > 0 && vocalEntryMs === activityVocalEntryMs;
    const support = lyricPos > 0 && !lyricIsCurve
      ? vocalEnergyNear(nextAnalysis, lyricPos, { beforeMs: 500, afterMs: Math.round(barNext * 2) })
      : 0;
    const lyricCoversLine = support >= 0.4 && vocalRunAfter(lyricPos, barNext);
    if (lyricCoversLine) {
      logEvent('automix-v2-lyric-verified',
        `B 入口取歌词 ${Math.round(lyricPos)}ms（该处唱句能量 ${support.toFixed(2)}，验证通过）`);
    } else if (strongVocalEntryMs > 0 && strongVocalEntryMs - vocalEntryMs > barNext * 2) {
      logEvent('automix-v2-strong-vocal',
        `B 入口按强判定取 ${Math.round(strongVocalEntryMs - nextStartMs)}ms（歌词 ${Math.round(lyricPos)}ms 处没有持续唱句，能量 ${support.toFixed(2)}）`);
      vocalEntryMs = strongVocalEntryMs;
    }
  }
  let vocalPosMs = vocalEntryMs > nextStartMs ? Math.round(vocalEntryMs - nextStartMs) : 0;
  if (vocalPosMs > 0 && nextDurationMs > 0) vocalPosMs = Math.min(vocalPosMs, nextDurationMs);
  let vocalFileMs = vocalPosMs > 0 ? nextStartMs + vocalPosMs : 0;
  // 兜底：歌词和「唱句段」都没给出入口，但 B 确实有唱句（presence=vocal）时，
  //   直接取第一段唱句的起点。没有这一步，B 开头 1–2 s 就开口的对会拿到 entry=0，
  //   于是「唱词衔接」整段不启用、B 侧让位也排不出事件（体检里 5.5% 的 NO_HANDOFF）。
  if (v2VocalAnchor && vocalFileMs === 0 && vocalPresence(nextAnalysis) === 'vocal') {
    const firstSeg = findVocalSegments(nextAnalysis).find((seg) => seg.startMs >= nextStartMs);
    if (firstSeg && (!nextLimitMs || firstSeg.startMs < nextLimitMs)) {
      vocalFileMs = Math.round(firstSeg.startMs);
      vocalPosMs = Math.round(vocalFileMs - nextStartMs);
      logEvent('automix-v2-entry-fallback', `B 入口按首段唱句兜底 ${vocalPosMs}ms`);
    }
  }
  if (v2VocalAnchor) {
    // 乐句匹配方案包成一个可失败块：拿不到合适窗口时**不要**直接返回 null
    // （那会让整次过渡退化成硬切），而是继续走下面的常规 v2 逻辑。
    const phrasePlan = ((): FadeSchedule | null => {
    const last = settings.handoff ? reconcileVocalAnchor({
      lyricMs:options.currentLastVocalEndMs ?? 0,
      curveMs:Math.max(0,activityLastVocalEndMs-currentStartMs),
      barMs:barIntervalOf(analysis),
    }).ms : 0;
    const bar = barIntervalOf(analysis) || 2000;
    const tailFade = detectTailFade(analysis, fileAudibleEndMs, { barMs: bar });
    // All anchors share a segment-relative tail budget, including CUE tracks.
    // 尾段预算要按 **A 的可听结尾** 算，不能按文件时长：带 20–30 s 静音尾巴的曲子
    //   （1012db42 这类）用文件时长会算出 tailStart=160.6 s，而它的可听结尾只有 162.2 s，
    //   结果整段过渡只剩 1.7 s（全库体检里 TOO_SHORT 的来源）。
    const tailRefEnd = fileAudibleEndMs > 0 ? fileAudibleEndMs : currentStartMs + durationMs;
    const tailSpanMs = Math.max(6000, tailRefEnd - currentStartMs);
    const tailStart = Math.max(currentStartMs + currentPosMs + 80,
      tailRefEnd - Math.min(30000, Math.round(tailSpanMs * 0.15)));
    let earliest = Math.max(currentStartMs+currentPosMs+80,tailStart);
    const trimTail = tailFade && tailFade.fadeStartMs >= earliest+MIN_FADE_MS && tailFade.dropDb >= 6;
    const hasLyricEnd = (options.currentLastVocalEndMs ?? 0) > 0;
    // Instrumental lead instruments can trigger the vocal activity detector.
    // Without a timed lyric ending, retain the entire audible outro.
    const keepOutro = !hasLyricEnd || vocalPresence(analysis) === 'instrumental';
    const entry = settings.handoff && settings.vocalAnchor !== 'off' && vocalFileMs < (nextLimitMs || Infinity)
      ? vocalFileMs : 0;
    let head = entry ? audibleIntroStart(nextAnalysis,nextStartMs,entry) : nextStartMs;
    // audibleIntroStart 只认「首句前那段连续有声」，安静段判宽了就会把整段前奏/第一段主歌
    //   当成静音跳过去 —— 听感就是「过渡完直接跳到 50 多秒、跳词」。
    //   所以只要 [起点, head) 这段其实有声音（区域响度 > -45 LUFS），就老老实实从起点播。
    if (entry && head > nextStartMs + 500) {
      // 只量「被裁掉的那一段」：真正的静音头（1–2 s 的淡入/空白）响度必然很低，
      //   而有内容却超过 2 小节的裁切（如 8–9 s 的前奏被当成静音）会明显 > -45。
      const lead = regionLoudness(nextAnalysis, nextStartMs, Math.min(head + 500, nextStartMs + 30_000));
      if (lead !== null && lead > -45) {
        head = nextStartMs;
        logEvent('automix-v2-intro-guard', `B 起点到首句之间有声（${lead.toFixed(1)} LUFS），回退从 ${Math.round(nextStartMs)}ms 起播，不跳前奏`);
      }
    }
    const drumPeak = (track: BeatAnalysis, from: number, to: number): number | null => {
      const activity = track.activity;
      if (!activity || !(activity.hopMs > 0)) return null;
      const values = activity.drum.slice(Math.max(0,Math.ceil(from/activity.hopMs)),
        Math.ceil(to/activity.hopMs)).filter(Number.isFinite);
      return values.length >= 3 ? Math.max(...values) : null;
    };
    const outgoing = drumPeak(analysis,Math.max(tailStart,fileAudibleEndMs-2*bar),fileAudibleEndMs);
    const incoming = drumPeak(nextAnalysis,entry ? Math.max(head,entry-bar) : head,
      (entry || head)+bar);
    // Walk back across the whole outro. A silent final bar cannot tell us
    // when the preceding drum phrase actually ended.
    const drums = analysis.activity;
    let lastDrum = 0;
    if (drums && drums.hopMs > 0) {
      const first = Math.max(0,Math.ceil(tailStart/drums.hopMs));
      let previous = -Infinity;
      for (let i=first; i<drums.drum.length && i*drums.hopMs<fileAudibleEndMs; i++) {
        if (!(drums.drum[i] >= 0.35)) continue;
        const at = i*drums.hopMs;
        if (at-previous <= bar) lastDrum = at;
        previous = at;
      }
    }
    const protectedEnd = lastDrum ? Math.min(fileAudibleEndMs,lastDrum+Math.min(6000,Math.max(1800,2*bar))) : 0;
    const sustained = outgoing !== null && outgoing >= 0.35;
    const drumContrast = outgoing !== null && outgoing < 0.22 && incoming !== null && incoming >= 0.45;
    const skipDecay = trimTail && !sustained && (!keepOutro || drumContrast);
    const landing = skipDecay && drumContrast ? pickDownbeatNear(analysis,tailFade.fadeStartMs,
      earliest+MIN_FADE_MS,1) : null;
    const lastDrumEnd = lastDrum+(drums?.hopMs ?? 0);
    const hasDrumlessTail = lastDrum > earliest+MIN_FADE_MS && drums &&
      fileAudibleEndMs-lastDrumEnd >= bar && drums.drum.length*drums.hopMs >= Math.max(lastDrumEnd+bar,fileAudibleEndMs-2*bar)
      && drums.drum.slice(Math.ceil(lastDrumEnd/drums.hopMs),Math.ceil(fileAudibleEndMs/drums.hopMs))
        .every(value => value < 0.25);
    // 尾段散音：最后一击之后的镲片/混响/余振。它们不在拍网格上，叠到 B 的第一击上就是「糊」。
    // 这里的做法是「截住并绕开」：只保留一小段收尾（衰减型 0.4 小节、持续型 120 ms），
    // 剩下的散音不进入过渡窗口，B 的第一击因此不会被垫在噪声上。
    const residue = analyseResidue(analysis, fileAudibleEndMs, bar);
    const residueKeep = lastDrum > 0 ? residueKeepMs(residue, bar) : 0;
    const residueEnd = lastDrum > 0 && residue
      ? Math.min(fileAudibleEndMs, Math.round(residue.lastAccentMs) + residueKeep)
      : fileAudibleEndMs;
    let end = hasDrumlessTail
      ? Math.min(lastDrumEnd, residueEnd)
      : skipDecay
        ? Math.max(protectedEnd, Math.min(tailFade.fadeStartMs, landing ?? tailFade.fadeStartMs))
        : residueEnd;
    // 母带渐隐段不进入过渡（乐句路径版）。
    //
    // 常规路径在 :3116 有一段同样的剔除，但乐句路径更早 return，压根走不到那里；
    // 而 skipDecay 的鼓点判据（outgoing 不够响 / B 更实）在 Skydive 这类「边淡出边打鼓」的
    // 尾段并不成立，窗口会原样盖到 188.4 s —— 用户听到的就是「3 分 05 秒的淡出没被排除」。
    // 只要淡出起点在 A 的末句之后，就把终点压到淡出起点，与常规路径同一口径。
    if (tailFade && tailFade.dropDb >= 8) {
      const fadeStartFile = Math.round(tailFade.fadeStartMs + 300);
      const lastWordFile = last > 0 ? Math.round(currentStartMs + last) : 0;
      const fadeFloor = Math.max(earliest + MIN_FADE_MS, lastWordFile > 0 ? lastWordFile + 300 : 0);
      if (fadeStartFile >= fadeFloor && fadeStartFile < end - 400) {
        end = fadeStartFile;
        logEvent(
          'automix-v2-tailcut',
          `剔除母带渐隐 ${tailFade.dropDb.toFixed(1)} dB / ${Math.round((tailFade.fadeEndMs - tailFade.fadeStartMs) / 1000)}s，窗口终点压到 ${end}ms`,
        );
      }
    }
    // 尾段预算（按曲长 15%、最多 30 s）与「A 的实际可听结尾」打架时，让窗口往前扩：
    //   1012db42 这类曲子的可听结尾 162.2 s，但 15% 线算出来是 160.6 s，
    //   两者只差 1.7 s → 整段过渡被压成 1.7 s 的硬切（全库体检 TOO_SHORT 的来源）。
    if (end - earliest < MIN_AUTO_BLEND_MS) {
      earliest = Math.max(currentStartMs + currentPosMs + 80,
        Math.min(earliest, Math.round(end - MIN_AUTO_BLEND_MS)));
    }
    // A 的最后一句必须唱完：不少歌的尾句比最后一击鼓点晚 1–3 s（人声拖在鼓点之后），
    // 只按鼓点/散音收尾会让过渡在中途开始——「没唱到末句就过渡」就是这个。
    // 只在不越过可听结尾、且推后量不超过两个小节时生效，避免把尾奏整段拖进来。
    const lyricLastFile = hasLyricEnd && last > 0 && last <= audibleEndPosMs ? currentStartMs + last : 0;
    // A 还有人声时绝不能收尾：以前只放宽 2 小节，How Long 的末句比最后一击鼓点晚
    // 4.75 s（≈2.2 小节）就被漏掉，过渡在末句唱到一半时开始。
    if (lyricLastFile > end && lyricLastFile <= fileAudibleEndMs && lyricLastFile - end <= Math.min(MAX_FADE_MS, 6 * bar)) {
      end = Math.round(Math.min(fileAudibleEndMs, lyricLastFile + Math.min(400, bar * 0.15)));
    }
    // 没有可用歌词时（大量本地曲目没有 LRC），上一段保护等于不存在：体检台量出 48 对
    //   「A 的人声在窗口结束后还在继续」，最多差 4 小节——听感就是「唱到一半被切走」。
    //   用活动度曲线自己找 A 的最后一句（和歌词同一套语义），仍然只在 6 小节内生效，
    //   避免把长尾奏整段拖进窗口。
    if (!(lyricLastFile > 0)) {
      const curveLastWord = currentStartMs + lastVocalEnd(analysis, audibleEndPosMs);
      if (curveLastWord > end && curveLastWord <= fileAudibleEndMs
        && curveLastWord - end <= Math.min(MAX_FADE_MS, 6 * bar)) {
        end = Math.round(Math.min(fileAudibleEndMs, curveLastWord + Math.min(400, bar * 0.15)));
      }
    }

    const anchor = vocalPresence(analysis) === 'instrumental'
      ? instrumentalAnchor(analysis,{beforeMs:end,barMs:bar}) : null;
    const release = !sustained && !drumContrast && !keepOutro && last > 0 && end-currentStartMs-last <= MAX_FADE_MS
      ? Math.max(protectedEnd,Math.min(end,currentStartMs+last)) : end;
    const fixedMs = settings.lengthMode === 'auto' ? 0 : resolveFadePlan(options,{
      currentStartMs,fileAudibleEndMs,baseBStartFileMs,vocalFileMs,
    }).ms;
    const rateLimit = Math.min(0.20,Math.max(0.15,settings.tempoRange));
    const introMs = entry ? entry-head : 0;
    // B 的首句离它起点太近（<3.2 s）时，硬把窗口压到 1.2–1.6 s 去「落在首句」是错的：
    //   那点长度连一次低频换手都放不下，听感是硬切。这种对不上就放弃唱句对齐，
    //   改用结构窗口（4 小节起），让 B 的首句自然落进窗口里。（全库体检）
    const entryUsable = entry > 0 && introMs >= MIN_AUTO_BLEND_MS;
    const entryAnchor = entryUsable ? entry : 0;
    if (entry && introMs < 250) return null;
    const targetIntro = entryUsable ? introMs : 0;
    const target = fixedMs || (targetIntro >= MIN_FADE_MS && settings.mixFloor === 'auto'
      ? Math.min(MAX_FADE_MS,targetIntro / (Math.abs(nearestTempoRatio(analysis.bpm/nextAnalysis.bpm)-1) <= rateLimit
        && Math.min(analysis.bpmConfidence,nextAnalysis.bpmConfidence) >= 0.55
        ? nearestTempoRatio(analysis.bpm/nextAnalysis.bpm) : 1))
      : Math.max(floorMs,Math.min(MAX_FADE_MS,targetIntro || 4*bar)));
    // A dense pickup before a rhythmic vocal entrance can sound like extra hits
    // on top of A's last bar. Pre-roll it silently and land on the first word.
    const beat = beatIntervalOf(analysis);
    const pickupPeak = entryUsable ? drumPeak(nextAnalysis,Math.max(head,entry-2*bar),entry) : null;
    const vocalBeat = entryUsable ? drumPeak(nextAnalysis,entry,entry+bar) : null;
    const boundary = (analysis.beatsMs ?? []).filter(t => t <= end && t >= end-bar).at(-1);
    const pickupSpan = boundary === undefined ? 0 : Math.min(MAX_FADE_MS,boundary-earliest,entry-head);
    const cleanPickup = settings.vocalAnchor === 'auto' && settings.lengthMode === 'auto'
      && lastDrum > 0 && beat > 0 && entryUsable && pickupSpan >= MIN_FADE_MS
      && (pickupPeak ?? 0) >= 0.55 && (vocalBeat ?? 0) >= 0.4 && boundary !== undefined;
    const groove = !cleanPickup && settings.vocalAnchor === 'auto' && settings.lengthMode === 'auto' && lastDrum
      ? matchDrumPhrase(analysis,nextAnalysis,end,earliest,head,entryAnchor,nextLimitMs || Infinity,bar) : null;
    const unit = !lastDrum && !sustained && !keepOutro && !trimTail && pickBridgeUnit({audibleEndMs:end,barMs:bar,
      downbeats:analysis.downbeats,sections:analysis.sections,minStartMs:Math.max(earliest,currentStartMs+last)});
    const start = Math.max(earliest,anchor?.ms ?? (last>0 ? release : end-target));
    const bridge = unit && start < end ? buildBridgePlan({unit,audibleEndMs:end,
      barMs:bar,fadeStartFileMs:start,desiredMs:target,maxPasses:3}) : null;
    const introBridge = !cleanPickup && !groove && entryUsable && !(settings.mixFloor === 'auto' && introMs >= MIN_FADE_MS) ? planIntroBridge({
      introStartMs:head,firstVocalMs:entry,barMs:barIntervalOf(nextAnalysis),targetMs:target,
      loopUnits:nextAnalysis.loopUnits,keyFrom:analysis.key,keyTo:nextAnalysis.key,
    }) : null;
    const delay = introBridge?.delayMs ?? 0;
    const bpmA = tempoAtMs(options.current.track,analysis,Math.max(earliest,end-target)) || analysis.bpm;
    const bpmB = tempoAtMs(options.next.track,nextAnalysis,head) || nextAnalysis.bpm;
    const mix = cleanPickup ? {x:boundary!-pickupSpan,y:entry-pickupSpan,span:pickupSpan,rate:1,sync:false} : groove ?? composePhrase({ a: {...analysis,bpm:bpmA}, b: {...nextAnalysis,bpm:bpmB}, earliest: bridge ? start : earliest,
      end: bridge?.extendedEndMs ?? end, head, limit: nextLimitMs || Infinity,
      release: bridge?.extendedEndMs ?? (keepOutro ? end : release),
      entry:entryAnchor ? entryAnchor+delay : 0,rateLimit,fixedMs:target,bar });
    if (!mix) return null;
    let {x,span,rate} = mix;
    // B 永远从它自己的起点（head）起播：composePhrase 给的 y 可能为了对齐鼓型往前挪，
    //   那等于把 B 的开头整段跳过（听感=跳词）。窗口长度不够就让 B 的前奏自然铺在 A 后面。
    let y = Math.round(head);
    // B 的首句必须落在淡化终点，同时**尽量少往后 seek**（跳到歌中间 = 跳词）。
    //   窗口能撑到「首句 − B 起点」就撑满：窗口越长，B 需要提前的量越少 → seek 越浅。
    //   上限 MAX_FADE_MS，所以首句离起点超过 32 s 时仍会 seek（最多 32 s），但不会更多。
    if (!introBridge && entryUsable) {
      const entryRel = Math.max(0, entryAnchor + delay - head);
      // 能撑的长度同时受三件事限制：首句位置、A 尾段可用长度、以及「过渡必须落在尾段」的
      //   既有约束（不超过曲长的 15%，硬上限 30 s）。
      const curDurMs = Math.max(0, options.currentDurationMs ?? options.currentAnalysis?.durationMs ?? 0);
      const tailCap = curDurMs > 0
        ? Math.max(MIN_FADE_MS, Math.min(30_000, Math.round(curDurMs * 0.15)))
        : MAX_FADE_MS;
      const roomCap = Math.max(MIN_FADE_MS, Math.round(end - earliest));
      const want = Math.min(MAX_FADE_MS, tailCap, roomCap, Math.max(MIN_FADE_MS, entryRel));
      if (want > span) {
        span = Math.round(want);
        x = Math.round((bridge?.extendedEndMs ?? end) - span);
      }
      // 绝不把 B seek 到歌中间：B 一律从它自己的起点（head）开始播。
      //   如果 A 的尾段装不下 B 的前奏，就让 B 的前奏在 A 结束后继续走，直到它自己的首句。
      //   这比「跳到 50 多秒」正确得多（跳词 = 直接丢掉开头的段落）。
      y = Math.round(head);
    }
    // 兜底：窗口短于 3.2 s 时（B 首句太近 / 鼓型匹配只给出很窄的窗口），
    //   只要 A 尾段还有空间就撑到 4 小节或 floor —— 1.2 s 的「过渡」等于硬切。（全库体检）
    if (!introBridge && span < MIN_AUTO_BLEND_MS) {
      const tailEnd = bridge?.extendedEndMs ?? end;
      const roomCap2 = Math.max(0, Math.round(tailEnd - earliest));
      const grow = Math.min(roomCap2, Math.max(MIN_AUTO_BLEND_MS, Math.min(floorMs || MIN_AUTO_BLEND_MS, 4 * bar)));
      if (grow > span) {
        span = Math.round(grow);
        x = Math.round(tailEnd - span);
        if (x < earliest) {
          x = Math.round(earliest);
          span = Math.round(tailEnd - x);
        }
      }
    }
    if (introBridge) {
      introBridge.delayMs = Math.max(0, span-(entry-y)/rate);
      introBridge.bufferMs = Math.ceil(introBridge.delayMs*rate);
    }
    // 乐句路径以前直接 return，完全不经过 E10 质量门 —— 全库体检里 371/371 都没有质量数据。
    //   这里补一次只读评估：附在计划上供浮层/日志看，只有严重超标才让位给常规 v2 路径。
    // 先算出真正会施加的响度补偿，再让质量门按「补偿之后」评估 ——
    //   以前质量门传 gainTrimDb:0，等于一边补偿一边判它没补偿，必然大面积 fail。
    const gainTrimDb = settings.loudnessMatch
      ? transitionMatchDb(analysis, nextAnalysis, x + Math.max(0, span - 3000), entry || y, Math.min(span, 3000), rate)
      : 0;
    // 过渡手法：按 BPM/调性/能量/唱词/结构/时长挑一种（只做决策，参数在 startSplitMix 施加）。
    let stylePick = pickV2StyleFor(
      {
        a: analysis, b: nextAnalysis, fadeMs: span, barMs: bar, beatMs: beat,
        bFirstVocalFileMs: entryUsable ? entryAnchor : 0,
        bFirstVocalOffsetMs: entryUsable ? entryAnchor : 0,
        bpmBEff: nextAnalysis.bpm * Math.max(0.5, rate),
        bpmGapPct: analysis.bpm > 0
          ? Math.abs((nextAnalysis.bpm * Math.max(0.5, rate) - analysis.bpm) / analysis.bpm) * 100
          : 0,
        gestureCapMs: budgetForAnalysis(nextAnalysis, bar).gestureMaxMs,
      },
      { allowCut: false },
    );
    // 乐句交叠路径做不了硬切：如果「允许硬切」时最优解就是 cut/slam（典型是 BPM 差 25%+），
    // 就不要用十几秒的交叠硬撑，直接放行给通用路径去砸一下。
    const cutPick = pickV2StyleFor(
      {
        a: analysis, b: nextAnalysis, fadeMs: span, barMs: bar, beatMs: beat,
        bFirstVocalFileMs: entryUsable ? entryAnchor : 0,
        bFirstVocalOffsetMs: entryUsable ? entryAnchor : 0,
        bpmBEff: nextAnalysis.bpm * Math.max(0.5, rate),
        bpmGapPct: analysis.bpm > 0
          ? Math.abs((nextAnalysis.bpm * Math.max(0.5, rate) - analysis.bpm) / analysis.bpm) * 100
          : 0,
        gestureCapMs: budgetForAnalysis(nextAnalysis, bar).gestureMaxMs,
      },
      { allowCut: true },
    );
    if (cutPick && (cutPick.id === 'cut' || cutPick.id === 'slam')) {
      logEvent('automix-v2-style-cut', `${cutPick.label}｜${cutPick.reasons[0] ?? ''}`);
      return null;
    }
    // halfTime 要改播放速率，而速率在通用路径统一求解：交给它，别在这里按 1:1 铺完。
    if (stylePick?.id === 'backspin') {
      logEvent('automix-v2-style-handoff', `回旋刹车需要短窗口 + gate，交给通用路径`);
      return null;
    }
    if (stylePick?.id === 'doubling') {
      logEvent('automix-v2-style-handoff', `叠播要另起一路 buffer 铺在 A 上，交给通用路径`);
      return null;
    }
    if (stylePick?.id === 'dropSwap' || stylePick?.id === 'doubleDrop') {
      logEvent('automix-v2-style-handoff', `drop 落点要在通用路径上改 B 的起播位置，交给它`);
      return null;
    }
    if (stylePick?.id === 'loopRoll') {
      logEvent('automix-v2-style-handoff', `循环滚奏要把 A 的这一段重复一遍，交给通用路径`);
      return null;
    }
    if (stylePick?.id === 'halfTime') {
      logEvent('automix-v2-style-handoff', `halfTime 需要 2:1 折叠速率，交给通用路径`);
      return null;
    }
    if (stylePick && (stylePick.id === 'echoOut' || stylePick.id === 'reverbOut')
      && meanActivity(analysis, 'drum', x + span - 4000, x + span) > 0.55) {
      logEvent('automix-v2-wet-dense', `A 尾鼓密度高，${stylePick.label} 改成滤波交叉`);
      stylePick = {
        id: 'filterSweep',
        label: describeStyle('filterSweep'),
        params: { swapShare: 0.3, sweepShare: 0.45, duckDb: -5, tailHold: 0.12 },
        reasons: ['A 尾鼓密度高于 0.55', '湿声会糊掉密集鼓组，退回滤波交叉'],
      };
    }
    if (stylePick) {
      logEvent('automix-v2-style', `${stylePick.label}｜${stylePick.reasons.join('；')}`);
    }
    // `groove` 那条路是按**鼓点**摆窗口的（`matchDrumPhrase`），B 的首句并不在接缝上；
    // 这时同样要压 B 的人声，否则「对齐了鼓点」变成「两条人声互盖」。（round 13）
    const phraseBDuck = entryUsable && !groove ? [] : buildBEntryDuck({
      a: analysis, fadeStartAMs: x, fadeMs: span,
      b: nextAnalysis, bStartMs: y, tempoRate: rate,
    });
    // 乐句路径的质量门也必须用**计划曲线**：原来这里走 `weights:'compact'` 的宽带模型，
    // 与通用路径（`weights:'plan'`）两套口径，同一对歌换个入口就得出不同的 drift。（round 9）
    const phrasePolicy = stylePolicyFor(span, bar);
    // 让位深度跟调性距离走：远调（Camelot ≥4）两条人声咬字会打架，压到 −8；
    // 近调/同调是和声，维持 −6；距离未知也按 −6。指标按同一条深度折算。
    const phraseKeyGap = camelotGap(analysis.camelot, nextAnalysis.camelot);
    const phraseDuckDb = phraseKeyGap === null ? -15 : phraseKeyGap >= 4 ? -15 : -15;

    // 已经由 `transitionMatchDb` 给过 B 正向补偿时，包络只补剩下的余量（总和不超过 +6），
    // 否则「窗口对齐」和「包络」两笔补偿会叠成 +9 dB。
    const phraseTrimRoom = Math.max(0, 6 - Math.max(0, gainTrimDb));
    const phraseBTrim = planBTrimCurve({
      a: analysis, b: nextAnalysis, fadeStartAMs: x, fadeStartBMs: y, fadeMs: span, tempoRate: rate,
    }).map((db) => Math.min(db, phraseTrimRoom));
    // 分频点自适应：两边低频越不像，越把分频点往上抬（更多低频走线性互补，少走等功率交叉）。
    const phraseSplitHz = planSplitHz({
      a: analysis, b: nextAnalysis, fadeStartAMs: x, fadeStartBMs: y, fadeMs: span, tempoRate: rate,
    });
    const phraseLowCorr = bassCorrelation({ a: analysis, b: nextAnalysis, fadeStartAMs: x, fadeStartBMs: y, fadeMs: span, tempoRate: rate });
    const phraseCurves = buildV2Plan({
      fadeMs: span, barMs: bar, rate,
      vocalAt: snapVocalAt(analysis.downbeats, x, span, bar),
      swapShare: Math.min(0.6, Math.max(0.06, (2 * bar) / Math.max(1, span))),
      bEntry: false,
      sweep: stylePick ? stylePick.params?.sweepShare !== 0 : true,
      sweepShare: stylePick?.params?.sweepShare,
      windowScale: phrasePolicy.windowScale,
      swapShareBias: phrasePolicy.swapShareBias,
      duckScale: phrasePolicy.duckScale,
      lowStartP: phraseLowCorr !== null && phraseLowCorr < -0.2 ? 0.8 : undefined,
    });
    const phraseQuality: QualityReport | null = (() => {
      try {
        const curves = phraseCurves;
        return qualityWithCurves({
          a: analysis, b: nextAnalysis,
          fadeStartAMs: x, fadeStartBMs: y, fadeMs: span, beatMs: beat,
          tempoRate: rate, handoffStartP: 0.78, handoffEndP: 0.92,
          gainTrimDb, bEntry: false,
          aInstrumental: vocalPresence(analysis) === 'instrumental',
          keyGap: phraseKeyGap,
          aDuckDb: vocalPresence(analysis) === 'instrumental' ? Math.max(phraseDuckDb, -3) : phraseDuckDb,
          swapShare: Math.min(0.6, Math.max(0.06, (2 * bar) / Math.max(1, span))),
          // 让位真的排了（含 groove 路径那条）就要在指标里算进去，否则压了也不算。
          bEntryDucked: !entryUsable || phraseBDuck.length > 0,
          // halfTime / backspin 在这个位置之前已经 `return null` 交给通用路径，走不到这里。
          wetTail: stylePick?.id === 'echoOut' || stylePick?.id === 'reverbOut'
            ? { sendDb: -6, decayMs: stylePick.id === 'reverbOut' ? 1_600 : 900, fromP: 0.5 }
            : undefined,
          bTrim: phraseBTrim,
        }, curves, {
          a: lowShareOf(analysis, x, span),
          b: lowShareOf(nextAnalysis, y, span * rate),
        });
      } catch { return null; }
    })();
    // 层 C 人声让位：以前只声明了 v2Duck 字段，从来没人生成过（全库体检才发现）。
    //   A 在 B 唱的地方把 1.5–4 kHz 压 6 dB，两条咬字就不会互相盖住。
    // 只在「A、B 两边都真的在唱」时收 A 的存在感，且深度封顶 3.5 dB（2026-11-24）：
    //   以前只看 B，B 每唱一句就压 A 一次，长窗里就是「压下去、松开、再压」。
    const phraseDuck = buildDuckEvents({
      a: analysis, fadeStartAMs: x,
      b: nextAnalysis, fadeStartBMs: y, fadeMs: span, tempoRate: rate,
      gateBeforeMs: entryUsable ? entryAnchor : 0,
      aInstrumental: vocalPresence(analysis) === 'instrumental',
      maxDuckDb: Math.max(-3.5, phraseDuckDb),
    });
    // B 一开播就唱（首句 < 3.2 s）：没有窗口能把首句摆到接缝上，但也不能就这么算了。
    //   反过来压 B —— A 还在唱的时候 B 的 1.5–4 kHz 压 6 dB，A 唱完立刻放开，
    //   听感是「下一首在人声底下偷进来」，而不是两条人声互盖。
    // 乐句路径的终点是「B 首句 − 窗口」，A 若还在唱就会被切在字中间。
    //   缺口在 3 s 内交给 applyVocalTailGuard 铺尾巴；超过 3 s 铺不住，也不该硬切——
    //   放行给通用路径，它会按 A 的末句重新摆窗口（B 的首句就不再精确落接缝）。
    const aLastVocalFileMs = lastVocalEnd(analysis, audibleEndPosMs);
    if (aLastVocalFileMs > 0 && x + span + 600 < aLastVocalFileMs) {
      logEvent('automix-v2-phrase-vocal-cut',
        `乐句窗口结束 ${Math.round(x + span)}ms 早于 A 末句 ${Math.round(aLastVocalFileMs)}ms，交给通用路径`);
      return null;
    }
    const tailLiftOn = localStorage.getItem('zilux2.dev.tailfade') !== '0';
    const aUnfade = tailLiftOn && tailFade && !trimTail ? clipLift(tailFade.points,x,x+span)
      .map(point => ({...point,liftDb:Math.min(6,point.liftDb)})) : null;
    return {
      cleanPickup,beatSync:mix.sync,bridge:cleanPickup ? null : bridge,introBridge,tailFade,aUnfade,vocalAnchor:{aLastEndMs:last>0 ? currentStartMs+last : 0,bEntryMs:groove ? 0 : entryAnchor,melodySim},
      fadeStartFileMs:x,fadeStartPosMs:x-currentStartMs,bStartFileMs:y,fadeMs:span,
      tempoRate:rate,structure:false,cueMode:'phrase-match',phraseBars:Math.round(span/bar),
      form: formOf({ styleId: stylePick?.id, dropEntry: false, tempoRate: rate }),
      cueInMs:y,cueOutMs:x,style:'equal',bassHandoffP:0,
      gainTrimDb,
      audibleEndPosMs,tailSilenceMs,nextVocalStartMs:vocalPosMs,vocalAligned:!groove && entryUsable,
      // handoff = 「有人声处理」；vocalAligned = 「B 的首句精确落在接缝上」。
      //   两者分开：B 一开播就唱的对靠 bDuck 处理，handoff 仍是 true，只是没对齐。
      handoff:entryUsable || phraseBDuck.some((e) => e.db < -1) || meanVocalInWindow(analysis, x, span) > 0.3,
      lastVocalEndPosMs:Math.max(0,last),handoffHoldMs:0,
      quality: phraseQuality,
      v2Plan: phraseCurves,
      bTrim: phraseBTrim,
      splitHz: phraseSplitHz,
      v2Duck: phraseDuck,
      lowCorr: phraseLowCorr,
      lowInvert: phraseLowCorr !== null && phraseLowCorr < -0.6,
      bDuck: phraseBDuck,
      styleId: stylePick?.id,
      styleParams: stylePick?.params,
      styleReasons: stylePick?.reasons,
      stylePolicy: phrasePolicy,
      extensionPlan: null,
      autoFadeMs:span,autoBars:Math.round(span/bar),autoBarMs:bar,
      autoNote: residue && residue.residueMs >= 120
        ? `尾句与前奏乐句匹配；截住 ${(residue.residueMs / 1000).toFixed(1)}s ${residue.decaying ? '衰减' : '持续'}散音，只留 ${(residueKeep / 1000).toFixed(2)}s 收尾`
        : '尾句与前奏乐句匹配',
    };
    })();
    if (phrasePlan) {
      applyVocalTailGuard(phrasePlan, analysis, currentStartMs, audibleEndPosMs);
      return phrasePlan;
    }
    logEvent('automix-v2-phrase-skip', '乐句匹配没有可用窗口，退回常规混音');
  }
  // ---- E8 结构桥接：A 尾奏不够长就把它循环补齐，让过渡仍能撑满一个乐句 ----
  // 只在 v2 档生效：标准档的行为必须保持「永远在可听结尾收干净」。
  let bridge: BridgePlan | null = null;
  // 桥接命中时，下游所有「A 的结尾」都按延长后的结尾算：过渡长度、贴拍、B 起播都跟着走。
  // 出点落强拍：在半拍上换歌最容易被听出来。可听结尾只允许在 ±0.35 小节内吸到最近强拍，
  // 超过这个距离说明结尾本来就不在网格上（现场录音/自由尾奏），硬吸会切掉最后一击。
  const schedAudibleEndMs = (() => {
    const bar = barIntervalOf(analysis) || 2_000;
    const snap = pickDownbeatNear(analysis, fileAudibleEndMs, fileAudibleEndMs - bar * 0.6);
    if (snap !== null && Math.abs(snap - fileAudibleEndMs) <= bar * 0.35) return snap;
    return fileAudibleEndMs;
  })();

  // 过渡时长（auto 需要 B 的起播点/唱词位置来判断前奏空间，所以放在 B 侧基础信息之后算）。
  const fadePlan = resolveFadePlan(options, {
    currentStartMs,
    fileAudibleEndMs: schedAudibleEndMs,
    baseBStartFileMs,
    vocalFileMs,
  });
  const desiredMs = fadePlan.ms;

  // ---- 歌词衔接（handoff）：A 最后一句唱完 = 淡化起点，B 首句 = 淡化终点，人声先出、伴奏渐入 ----
  // 只对「自动」档开放（手动固定档位保持用户指定的秒数）；A 末句之后没有足够尾奏时自动回退普通淡化。
  // p0-11 结构混音：A 尾奏让位 → B 从 drop/副歌乐句进来，时长按场景预设小节数。
  // 分析字段缺失（旧缓存 / 旧宿主）时返回 null，下面回退到原来的淡化逻辑。
  // 先准备结构回退，仅在歌词与前奏空间满足条件时由歌词方案覆盖。
  let structure = buildStructureCue({
    settings,
    analysis,
    nextAnalysis,
    currentStartMs,
    currentPosMs,
    fileAudibleEndMs: schedAudibleEndMs,
    nextStartMs,
    nextDurationMs,
    desiredMs,
    track: options.current.track,
  });
  const rawLastVocalEnd = options.currentLastVocalEndMs;
  const lyricLastEndPosMs =
    typeof rawLastVocalEnd === 'number' && Number.isFinite(rawLastVocalEnd) && rawLastVocalEnd > 0
      ? Math.round(Math.min(rawLastVocalEnd, durationMs))
      : 0;
  const curveLastEndPosMs =
    activityLastVocalEndMs > currentStartMs
      ? Math.round(Math.min(activityLastVocalEndMs - currentStartMs, Math.max(0, audibleEndPosMs - 200)))
      : 0;
  const tailReconcile = reconcileVocalAnchor({
    lyricMs: lyricLastEndPosMs,
    curveMs: curveLastEndPosMs,
    barMs: barIntervalOf(analysis),
  });
  let lastVocalEndPosMs = tailReconcile.ms;
  if (v2VocalAnchor && tailReconcile.source === 'curve' && lyricLastEndPosMs > 0) {
    logEvent('automix-v2-anchor', `A ${tailReconcile.reason}`);
  }
  // 末句离可听结尾太远 = 检测漏了后面的唱段 / 歌词错位。此时宁可不锚，
  // 让过渡落回结尾，也不要在歌还唱着的时候开始混（「明明没唱完就过渡」）。
  if (
    v2VocalAnchor &&
    lastVocalEndPosMs > 0 &&
    !tailAnchorUsable(lastVocalEndPosMs, audibleEndPosMs, MAX_FADE_MS)
  ) {
    logEvent(
      'automix-v2-anchor-skip',
      `A 末句 ${lastVocalEndPosMs}ms 距结尾 ${Math.round(audibleEndPosMs)}ms 超过 ${MAX_FADE_MS}ms，忽略锚点`,
    );
    lastVocalEndPosMs = 0;
  }
  // ---- 器乐 A：没有唱词也要能「无缝」----
  // 前两分钟是纯音乐时，`vocalPresence` 判为 instrumental，唱句锚点整条路是空的，
  // 于是只能退回"整轨淡化"。但器乐照样有结构：最后一个乐句起点 / 最后一个强拍，
  // 就是那句"该让位了"的地方 —— 拿它当末句位置，后面的 handoff / 最短混音全都能跑。
  let tailAnchorKind: 'vocal' | 'instrumental' | 'structure' | 'none' = lastVocalEndPosMs > 0 ? 'vocal' : 'none';
  let instrumentalTailBars = 0;
  // 结构锚点的语义和末句锚点相反：末句是「淡化终点」，结构点（最后一个乐句/强拍起点）
  // 是「淡化起点」——过渡应该从这里铺到 A 的可听结尾，而不是结束在这里。
  // 唱词锚点不可用有两种情况：①A 是纯器乐；②有唱词但末句离结尾太远（长器乐尾奏），
  // 被 `tailAnchorUsable` 判为不可信。两种都要退到结构锚点，否则 handoff 整条路是空的，
  // 表现就是「过渡被推到 A 最后一秒、B 从它自己的第 0 秒进来」。
  const tailAfterVocalMs = lastVocalEndPosMs > 0 ? audibleEndPosMs - lastVocalEndPosMs : 0;
  // 歌词衔接的过渡时长不设固定秒数上限，按两首协调后的真实小节实时计算：
  // - 尾奏超过一个乐句时，先把多出来的整小节留给 A（独听尾奏），交接点自然往后；
  // - 剩下的尾奏约一个乐句用来交叠，交叠终点正好落在 A 的可听结尾；
  // - 尾奏不足一个乐句时整段尾奏都用来交叠（既不会被截断，也不会被固定上限拖长）。
  const coordinated = coordinatedBarMs(analysis, nextAnalysis, options.current.track, options.next.track);
  const handoffBarMs = coordinated.barMs > 0 ? coordinated.barMs : HANDOFF_FALLBACK_BAR_MS;
  const handoffPhraseBars = handoffBarMs < AUTO_SHORT_BAR_MS ? AUTO_BARS_LONG : AUTO_BARS;
  const handoffPhraseMs = handoffBarMs * handoffPhraseBars;
  const handoffHoldRawMs =
    tailAfterVocalMs > handoffPhraseMs
      ? Math.floor((tailAfterVocalMs - handoffPhraseMs) / handoffBarMs) * handoffBarMs
      : 0;
  const handoffHoldBaseMs = Math.round(
    Math.max(0, Math.min(handoffHoldRawMs, tailAfterVocalMs - MIN_FADE_MS)),
  );
  let handoffFadeMs = Math.round(Math.max(MIN_FADE_MS, tailAfterVocalMs - handoffHoldBaseMs));
  const bTailAfterVocalMs = nextDurationMs > 0 ? nextDurationMs - vocalPosMs : Number.POSITIVE_INFINITY;
  // 只要 A 还有可听见的尾奏就成立：B 的前奏短不再等于「放弃歌词衔接」，
  // 而是把交叠缩短到「淡化正好接上 B 的第一句」（最少 MIN_FADE_MS）。
  // 「末句离结尾太远」= 后面还有一大段器乐尾声：这种歌不能用「等末句唱完」当唯一排程，
  // 否则过渡起点会被拉到歌中间（听起来就是「没放完就切歌」）。
  // 老的 handoff 判定保持不动（它靠 hold 把起点压回结尾），只把它作为
  // 「v2 铺窗口」的前置条件 —— 见下面的 floorMs 块。
  let handoff =
    settings.handoff &&
    settings.lengthMode === 'auto' &&
    lastVocalEndPosMs > 0 &&
    tailAfterVocalMs >= MIN_FADE_MS &&
    currentStartMs + lastVocalEndPosMs >= currentStartMs + currentPosMs + 80;
  let handoffHoldMs = handoff ? handoffHoldBaseMs : 0;
  // B 后半段撑不到这么长的交叠：把过渡缩短（保留量相应变多），仍不足 MIN 就回退普通淡化。
  if (handoff && Number.isFinite(bTailAfterVocalMs) && bTailAfterVocalMs - 400 < handoffFadeMs) {
    handoffFadeMs = Math.round(Math.max(MIN_FADE_MS, bTailAfterVocalMs - 400));
    handoffHoldMs = Math.round(Math.max(0, tailAfterVocalMs - handoffFadeMs));
    if (bTailAfterVocalMs - 400 < MIN_FADE_MS) {
      handoff = false;
      handoffHoldMs = 0;
    }
  }

  if (handoff) {
    structure = null;
    // 交叠终点 = B 的第一句（留 150ms，保证第一个字完整）：
    // 前奏短就只交叠这么长（不少于 MIN_FADE_MS），尾奏长时上面已按整小节留下尾奏给 A 独听，
    // 所以不论前奏多短都不会退回「普通淡化」。
    if (vocalPosMs > 0) {
      handoffFadeMs = Math.min(
        handoffFadeMs,
        Math.max(MIN_FADE_MS, Math.min(vocalPosMs - 150, tailAfterVocalMs)),
      );
      handoffHoldMs = Math.max(0, Math.round(tailAfterVocalMs - handoffFadeMs));
    }
  }
  let bStartFileMs = structure ? structure.bStartFileMs : handoff
    ? (vocalPosMs > 0
        ? Math.max(nextStartMs, Math.round(vocalFileMs - handoffFadeMs - 150))
        : baseBStartFileMs)
    : baseBStartFileMs;
  let vocalAligned = handoff;
  // 歌词衔接开着、但这首歌 fallback 到普通淡化的少数情况：B 前奏比目标淡化还短时，
  // 把整段前奏当成过渡，淡化时长随之缩短。关掉歌词衔接后不再贴唱词，
  // B 从强拍/曲首起播，让「开」和「关」听感真正不同。
  let fadeMsTarget = structure ? structure.fadeMs : desiredMs;
  if (!structure && !handoff && settings.handoff && vocalFileMs > 0) {
    const candidate = vocalFileMs - desiredMs;
    if (candidate >= nextStartMs + 250) {
      // 前奏够长：从「唱词前 desiredMs」处起播，淡化结束正好进入唱词（更早的前奏直接跳过）；
      // 起播点尽量贴在强拍上，保证淡化期间鼓点依然对齐。
      const nearby = pickDownbeatNear(nextAnalysis, candidate, nextStartMs);
      bStartFileMs = nearby !== null && Math.abs(nearby - candidate) <= 200 ? nearby : Math.round(candidate);
      vocalAligned = true;
    }
    // 前奏短于目标淡化时仍保持完整交叠，首句可在交叠中开始。
  }

  // ---- A 侧 ----
  // 器乐 A：`handoff` 要求 `lastVocalEndPosMs > 0`，纯器乐永远进不来，于是那句
  //   「用最后一个乐句/强拍当接缝」的注释一直是空头承诺（窗口仍按 `end - fadeMsTarget` 反推）。
  //   这里把它真接上：没唱词就用结构点当起点，淡化铺到 A 的可听结尾。
  const instAnchor = vocalPresence(analysis) === 'instrumental'
    ? instrumentalAnchor(analysis, { beforeMs: schedAudibleEndMs, barMs: handoffBarMs })
    : null;
  const instSeam = instAnchor !== null && instAnchor.ms > 0
    && schedAudibleEndMs - instAnchor.ms >= MIN_FADE_MS ? instAnchor : null;
  if (instSeam !== null) {
    tailAnchorKind = 'instrumental';
    instrumentalTailBars = instSeam.barsFromEnd;
  }
  // 歌词衔接：起点 = 「A 最后一句唱完」+ 按整小节先保留的尾奏（handoffHoldMs），不再贴强拍；
  // 过渡时长 = 剩余尾奏（约一个乐句），终点正好落在 A 的可听结尾，不设固定秒数封顶。
  // 其它情况：终点固定为可听结尾、按淡化时长反推起点，并尽量贴强拍。
  let fadeStartFile = structure ? structure.fadeStartFileMs : currentStartMs;
  if (!structure && handoff) {
    fadeStartFile = currentStartMs + lastVocalEndPosMs + handoffHoldMs;
    // 兜底：任何情况下都不允许把过渡起点拉到「离结尾超过一个 MAX 窗口」的地方。
    const latestFloorStart = schedAudibleEndMs - MAX_FADE_MS;
    if (fadeStartFile < latestFloorStart) fadeStartFile = latestFloorStart;
    const earliestStart = currentStartMs + currentPosMs + 80;
    if (fadeStartFile < earliestStart) {
      // 已经错过末句（分析回来太晚 / 用户 seek 过）：回退普通淡化。
      handoff = false;
      handoffHoldMs = 0;
      vocalAligned = false;
      bStartFileMs = baseBStartFileMs;
    }
  }
  // 母带渐隐（fade-out）提前探一次：它决定「剔除」还是「反向补回」。
  // 探测点取「可听结尾」与「文件时长」的较大者：Skydive 这类曲子在 audibleEnd 之后
  // 还垫着 2 s 的淡出尾巴，只看 audibleEnd 会把真正的淡出尾巴切掉一半。
  const tailProbeMs = Math.max(schedAudibleEndMs, (analysis as BeatAnalysis & { durationMs?: number }).durationMs ?? 0);
  const earlyTailFade = isAutomixV2(effectiveMode())
    ? detectTailFade(analysis, tailProbeMs, { barMs: barIntervalOf(analysis) || 2000 }) : null;
  let fadeEndFile = schedAudibleEndMs;
  // ---- 剔除渐隐段 ----
  // 若 A 的结尾是又长又深的母带渐隐（≥6 s 且掉 ≥8 dB），与其在那几秒里交接（A 已经虚了），
  // 不如把淡化终点前移到渐隐开始处：A 在还有气的电平上交棒，渐隐尾巴不再参与过渡。
  let tailCutApplied = false;
  if (
    earlyTailFade &&
    !structure &&
    earlyTailFade.dropDb >= 8 &&
    // 4.2 s 的母带淡出（Skydive）也是淡出：门槛放在 detectTailFade 的 2.5 s 之上一点即可，
    // 用 6 s 会把短促但很深的淡出全部漏掉。
    earlyTailFade.fadeEndMs - earlyTailFade.fadeStartMs >= 2_500
  ) {
    const cutMs = Math.round(earlyTailFade.fadeStartMs + 300);
    const earliestCut = Math.round(currentStartMs + currentPosMs) + MIN_FADE_MS;
    // 前置条件不再是 `!handoff`：round 15 把让位判据放宽（DUCK_TRIGGER_SOFT）之后，
    // 弱唱词的曲目也会 handoff=true，这条门会让「剔除渐隐段」整段失效 —— 用户听到的
    // 就是渐隐尾巴又回到过渡里。改成「切割点必须在 A 的实质内容之后」：
    // 末句（歌词或唱句段）之后才允许把母带渐隐剔掉。
    const lastWordFile = lastVocalEndPosMs > 0 ? Math.round(currentStartMs + lastVocalEndPosMs) : 0;
    const cutFloor = Math.max(earliestCut, lastWordFile > 0 ? lastWordFile + 300 : 0);
    if (cutMs >= cutFloor && cutMs < fadeEndFile - 400) {
      fadeEndFile = cutMs;
      tailCutApplied = true;
      logEvent(
        'automix-v2-tailcut',
        `剔除母带渐隐 ${earlyTailFade.dropDb.toFixed(1)} dB / ${Math.round((earlyTailFade.fadeEndMs - earlyTailFade.fadeStartMs) / 1000)}s，终点前移到 ${cutMs}ms`,
      );
    } else if (cutMs < cutFloor) {
      logEvent('automix-v2-tailcut-skip', `渐隐起点 ${cutMs}ms 早于末句 ${cutFloor}ms，保留渐隐段`);
    }
  }
  if (!structure && !handoff) {
    // 终点也贴拍点/强拍：只允许在可听结尾附近 ±0.6 拍内微调，避免把过渡拖进尾部静音。
    const endInterval = beatIntervalOf(analysis) || 500;
    const endSnap = snapToGrid(analysis, schedAudibleEndMs, currentStartMs, settings.alignment);
    if (
      endSnap !== null &&
      Math.abs(endSnap - schedAudibleEndMs) <= endInterval * 0.6 &&
      endSnap <= schedAudibleEndMs + endInterval * 0.5
    ) {
      fadeEndFile = endSnap;
    }
    if (instSeam !== null) {
      // 器乐：接缝落在最后一个乐句起点（没有乐句信息时退强拍），不再按毫秒反推。
      fadeStartFile = instSeam.ms;
    } else {
      const targetFileMs = fadeEndFile - fadeMsTarget;
      const snappedStart = snapToGrid(analysis, targetFileMs, currentStartMs, settings.alignment);
      fadeStartFile = snappedStart === null ? targetFileMs : snappedStart;
    }

    // 淡化窗口终点固定为拍点边界（不把淡化拖进尾部静音），只对起点夹取时长：
    // 早不过 MAX_FADE_MS、晚不过可听结尾前 MIN_FADE_MS，且不早于曲目/分段起点。
    if (fadeEndFile - fadeStartFile > MAX_FADE_MS) fadeStartFile = fadeEndFile - MAX_FADE_MS;
    if (fadeEndFile - fadeStartFile < MIN_FADE_MS) fadeStartFile = fadeEndFile - MIN_FADE_MS;
    if (fadeStartFile < currentStartMs) fadeStartFile = currentStartMs;

    // 已经错过起点（分析回来太晚 / 用户 seek 过）：从当前位置开始缩短淡化，否则放弃。
    const earliestStart = currentStartMs + currentPosMs + 80;
    if (fadeStartFile < earliestStart) fadeStartFile = earliestStart;
    if (fadeEndFile - fadeStartFile < MIN_FADE_MS) return null;
    if (fadeEndFile - fadeStartFile > MAX_FADE_MS) fadeStartFile = fadeEndFile - MAX_FADE_MS;

    // v2 最短混音（纯等功率/无人声锚点时也要生效）：终点是 A 的可听结尾，
    // 那就把起点往前推，凑够 floor —— 宁可早一点开始交叉，也不给 1–3 秒的假过渡。
    if (floorMs > 0) {
      const wanted = Math.min(MAX_FADE_MS, Math.max(floorMs, fadeEndFile - fadeStartFile));
      const candidate = Math.max(earliestStart, fadeEndFile - wanted);
      if (fadeEndFile - candidate >= MIN_FADE_MS) fadeStartFile = Math.round(candidate);
    }
  }

/**
 * A 的窗口里平均还有多少唱词（0–1）。
 *
 * 用来识别「A 已经进了纯尾奏」的对：这种对两边同时在安静段落，等功率叠加听感是空的。
 * 数据是 `activity.vocal`（250 ms 桶）。
 */
function meanVocalInWindow(analysis: BeatAnalysis, startMs: number, lengthMs: number): number {
  const curve = analysis.activity?.vocal;
  if (!curve || curve.length === 0 || !(lengthMs > 0)) return 1;
  const hop = analysis.activity?.hopMs || 250;
  const from = Math.max(0, Math.floor(startMs / hop));
  const to = Math.min(curve.length - 1, Math.floor((startMs + lengthMs) / hop));
  let sum = 0;
  let count = 0;
  for (let i = from; i <= to; i += 1) {
    sum += curve[i] ?? 0;
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

  // 器乐接缝必须是唯一真源：上面 structure 的按小节对齐、拍点对齐、floor 直推都会把起点挪走
  // （实测把乐句接缝推后 2 小节 ⇒ 过渡从乐句中间开始）。所以在算 fadeMs 之前统一再落一次。
  if (instSeam !== null) {
    const seamFloor = Math.round(currentStartMs + currentPosMs + 80);
    const seamStart = Math.max(instSeam.ms, seamFloor);
    if (fadeEndFile - seamStart >= MIN_FADE_MS) {
      fadeStartFile = seamStart;
      if (structure) {
        structure.fadeStartFileMs = seamStart;
        structure.fadeMs = Math.round(fadeEndFile - seamStart);
        structure.cueOutMs = seamStart;
      }
    }
  }

  let fadeMs = structure ? structure.fadeMs : Math.round(handoff ? handoffFadeMs : fadeEndFile - fadeStartFile);
  if (fadeMs < MIN_FADE_MS) return null;

  // 实际窗口算出来后，用真实时长重判一次自动档（短交叠可能落到 5 s 以下）。
  if (readMixTransitionMode() === 'auto') {
    const decided = decidePairMode(analysis, nextAnalysis, fadeMs);
    if (decided !== pairMixMode) {
      pairMixMode = decided;
      logEvent('automix-auto-mode', decided === 'automixV2' ? '自动：窗口 >5 s，走进阶混音' : '自动：短交叠/数据不足，走标准');
    }
  }

  // ---- 标准档也做鼓点对齐 ----
  // 老路径起点是任意帧、B 从任意帧进；这里把 A 的起点和 B 的入场都吸到
  // 各自的强拍上（只在小范围内挪，不改变自动长度的语义）。
  const stdAlign = !isAutomixV2(effectiveMode())
    && (analysis.downbeats?.length ?? 0) >= 4
    && readCrossfadeSettings().lengthMode !== 'seconds';
  if (stdAlign) {
    try {
      const barA0 = barIntervalOf(analysis) || 2_000;
      const barB0 = barIntervalOf(nextAnalysis) || barA0;
      const nearB = pickDownbeatNear(nextAnalysis, bStartFileMs, nextStartMs, barB0 * 0.6);
      if (nearB !== null && nearB >= nextStartMs) bStartFileMs = Math.round(nearB);
      const nearA = pickDownbeatNear(analysis, fadeStartFile, currentStartMs + currentPosMs + 200, barA0 * 0.3);
      if (nearA !== null) {
        const span = Math.round(fadeEndFile - nearA);
        if (span >= MIN_FADE_MS && span <= MAX_FADE_MS) {
          fadeStartFile = Math.round(nearA);
          fadeMs = span;
        }
      }
      logEvent('standard-grid', `标准档对齐：A 起点 ${Math.round(fadeStartFile)}ms · B 起点 ${Math.round(bStartFileMs)}ms · 窗口 ${Math.round(fadeMs)}ms`);
    } catch { /* 无网格就保持原值 */ }
  }

  // ---- v2：A 已经进纯尾奏时把窗口往前挪一点----
  // 「两边都安静」是听感上最空的一种过渡：A 的尾奏只剩氛围垫、B 的前奏还没进。
  // 只要 A 的窗口平均唱词 < 0.3、且起始点后面还有余地，就整体前移，
  // 让窗口跨过 A 的最后一句——有内容的一侧撑住，另一侧才有「走进来」的感觉。
  if (isAutomixV2(effectiveMode()) && !handoff && !structure && lastVocalEndPosMs > 0) {
    const meanVocal = meanVocalInWindow(analysis, fadeStartFile, fadeMs);
    if (meanVocal < 0.3) {
      const barA = barIntervalOf(analysis) || 2000;
      const room = Math.round(fadeStartFile - (currentStartMs + currentPosMs + 80));
      const want = Math.min(room, barA * 2, Math.max(0, MAX_FADE_MS - fadeMs));
      // 只有当「末句就在窗口前面一点」时才前移。纯器乐尾奏（末句离结尾还有 8 小节以上）
      // 前移两小节也够不到唱词，只是把窗口拉长，反而稀释能量——那种对的下坠属于编曲，
      // 不是链路问题（`aTailGapBars > 8` 的对在体检台里单独统计）。
      const lastVocalFile = currentStartMs + lastVocalEndPosMs;
      const gapBeforeWindow = fadeStartFile - lastVocalFile;
      if (gapBeforeWindow > barA * 4) {
        logEvent('automix-v2-outro-keep', `A 尾奏为纯器乐（末句早 ${(gapBeforeWindow / 1000).toFixed(1)}s），窗口不前移`);
      } else if (want >= Math.round(barA * 0.5)) {
        fadeStartFile = Math.round(fadeStartFile - want);
        fadeMs = Math.round(fadeMs + want);
        logEvent('automix-v2-outro-lift', `A 窗口唱词仅 ${meanVocal.toFixed(2)}，窗口前移 ${(want / 1000).toFixed(1)}s 跨过末句`);
      }
    }
  }

  // 歌词衔接（开启时）都要尊重 A 的末句：只要唱完后仍有至少一个可听的交叠窗口，
  // 就等末句结束再让 B 发声；尾奏不足时仅提前最短必要的 3.2 秒，避免为了追求完整
  // 乐句盖住多句歌词。关掉歌词衔接后这里不再介入，完全按小节 / 拍点排程。
  let vocalGuardNote = '';
  // ---- v2 最短混音：终点锚在 **A 的末句结束**（不是 B 的唱词入口），至少回溯 floorMs ----
  // 关键：不再为了等 A 的末句把起点往后推（那正是 1–3 秒短混音的来源），
  // 而是让 B 提前**穿插**进来（只放高频/鼓，低频在 A 末句之后才交接），
  // A 保持原样唱到自己的末句结束，然后才扫频变闷退出。
  //
  // 血案记录（「有些歌刚播放没多久就自动过渡」）：这里原来用 `vocalFileMs`
  // 当 mixEnd —— 那是 **B 的文件时间**（`nextStartMs + vocalPosMs`），拿它去当 A 的
  // 淡化终点，遇到「下一首前奏很短、第 5 秒就开口」的曲目，A 的过渡就被排到播放
  // 第 5 秒，听感就是「刚放就切歌」。必须锚 A 自己的末句/可听结尾。

  // 标准档（floor=0）保留原来的「等末句唱完再进」行为；v2 已改由上面统一铺窗口，
  // 这里再推起点会把刚铺好的 floor 又压回去。
  if (floorMs === 0 && settings.handoff && lastVocalEndPosMs > 0) {
    const scheduledEndFileMs = fadeStartFile + fadeMs;
    const lyricEndFileMs = currentStartMs + Math.min(lastVocalEndPosMs, audibleEndPosMs);
    // 不为安全余量挤掉本来足够的最短交叠窗口。
    const marginMs = Math.min(VOCAL_RELEASE_MARGIN_MS,
      Math.max(0, scheduledEndFileMs - lyricEndFileMs - MIN_AUTO_BLEND_MS));
    const vocalReleaseFileMs = lyricEndFileMs + marginMs;
    if (fadeStartFile < vocalReleaseFileMs) {
      const tailRoomMs = scheduledEndFileMs - vocalReleaseFileMs;
      const protectedStart = tailRoomMs >= MIN_AUTO_BLEND_MS
        ? vocalReleaseFileMs
        : scheduledEndFileMs - Math.min(fadeMs, MIN_AUTO_BLEND_MS);
      if (protectedStart > fadeStartFile) {
        fadeStartFile = Math.round(protectedStart);
        fadeMs = Math.round(scheduledEndFileMs - fadeStartFile);
        vocalGuardNote = tailRoomMs >= MIN_AUTO_BLEND_MS
          ? '等待上一首末句唱完后进入' : '尾奏不足，只提前最短交叠窗口';
        if (structure) {
          structure.fadeStartFileMs = fadeStartFile;
          structure.fadeMs = fadeMs;
          structure.cueOutMs = fadeStartFile;
        }
      }
    }
  }

  // B 太短，撑不到淡化结束：结构混音直接放弃（回退旧逻辑），旧路径回退普通方案。
  if (nextDurationMs > 0 && !vocalAligned) {
    const availableMs = nextDurationMs - (bStartFileMs - nextStartMs);
    if (availableMs < fadeMs + 400) {
      if (structure) return null;
      vocalAligned = false;
      handoff = false;
      bStartFileMs = baseBStartFileMs;
      if (nextDurationMs - (bStartFileMs - nextStartMs) < fadeMs + 400) return null;
    }
  }

  // ---- WSOLA 节拍对齐：按「目标曲」对齐拍间隔，再微调起播相位到同拍 ----
  let tempoRate = 1;
  // 只在新进阶档启用：标准档冻结为「B 贴 A」的老行为，保证两种过渡互不影响。
  const tempoAnchorNext = isAutomixV2(effectiveMode()) && readTempoAnchor() === 'next';
  let tempoInverted = false;
  // 局部速度（p0-13 曲线 / 跟拍覆盖）：B 取入场处、A 取淡化起点处；变速歌不再按整曲 BPM 算比率。
  const aBpm = tempoAtMs(options.current.track, analysis, fadeStartFile) || analysis.bpm;
  const bBpm = tempoAtMs(options.next.track, nextAnalysis, bStartFileMs) || nextAnalysis.bpm;
  // v2 档把可变速率域放宽到 ±15%（设置值更大的话以设置为准）；标准档仍是 ±8%。
  const tempoRange = isAutomixV2(effectiveMode())
    ? Math.max(settings.tempoRange, V2_TEMPO_RANGE)
    : settings.tempoRange;
  let tempoMeetA = 0;
  let tempoMeet = false;
  if (isAutomixV2(effectiveMode()) && aBpm >= 40 && bBpm >= 40
      && analysis.bpmConfidence >= 0.5 && nextAnalysis.bpmConfidence >= 0.5) {
    // 用户口径：≤25% B 贴 A；25–50% 两侧向中点靠；整倍/半整倍按错拍对齐。
    const policy = planTempoPolicy(aBpm, bBpm);
    if (policy.mode === 'meet') {
      tempoMeet = true;
      tempoMeetA = policy.aRate;
      tempoRate = policy.bRate;
      tempoInverted = false;
    } else if (policy.mode === 'b-to-a') {
      tempoRate = policy.bRate;
      tempoInverted = false;
    } else if (policy.mode === 'octave' || policy.mode === 'same' || policy.mode === 'free') {
      tempoRate = 1;
      tempoInverted = false;
    }
  } else if (aBpm >= 40 && bBpm >= 40 && tempoRange > 0 && analysis.bpmConfidence >= 0.5 && nextAnalysis.bpmConfidence >= 0.5) {
    const raw = nearestTempoRatio(aBpm / bBpm);
    // 允许范围由设置决定（标准档默认 ±8%）；超出会明显听出快/慢，宁可不变速、按原强拍起播。
    const minRate = 1 - tempoRange;
    const maxRate = 1 + tempoRange;
    if (raw >= minRate && raw <= maxRate && Math.abs(raw - 1) >= 0.004) {
      // 目标 = 下一首（默认）：把「A 跑多快」折成 tempoRate 的倒数。
      //   tempoRate 在这条链路里的含义是「每秒墙钟对应多少 B 文件毫秒」，
      //   所以 A 被拉快时（raw>1），tempoRate 要取 1/raw，B 保持 1.0。
      tempoRate = Math.round((tempoAnchorNext ? 1 / raw : raw) * 1000) / 1000;
      tempoInverted = tempoAnchorNext;
    }
  }
  // 歌词衔接时 B 的起播点就是首句，不再做「贴到同拍」的相位微调（会破坏人声对齐）；
  // 结构混音也要保持 B 正好落在乐句边界上。
  if (!handoff && !vocalAligned && settings.cueMode === 'auto' && analysis.bpmConfidence >= 0.5 && nextAnalysis.bpmConfidence >= 0.5 && Math.abs(aBpm / bBpm / tempoRate - 1) < 0.02) {
    const beatA = aBpm >= 40 ? 60_000 / aBpm : beatIntervalOf(analysis);
    const beatB = bBpm >= 40 ? 60_000 / bBpm : beatIntervalOf(nextAnalysis);
    const firstA = currentStartMs + Math.max(0, analysis.firstBeatMs);
    // 有真实拍点网格（beatsMs）时直接取下一拍，避免长曲常数网格漂移。
    const nextA = nextBeatAtOrAfter(analysis, fadeStartFile);
    const nextB = nextBeatAtOrAfter(nextAnalysis, bStartFileMs);
    const toNextA = nextA !== null ? nextA - fadeStartFile : beatA - mod(fadeStartFile - firstA, beatA);
    const toNextB =
      nextB !== null
        ? nextB - bStartFileMs
        : beatB - mod(bStartFileMs - (nextStartMs + Math.max(0, nextAnalysis.firstBeatMs)), beatB);
    // B 以 tempoRate 播放：文件偏移 / rate = 真实时间偏移；让两边下一拍落在同一时刻。
    let shift = toNextB - toNextA * tempoRate;
    while (shift > beatB / 2) shift -= beatB;
    while (shift < -beatB / 2) shift += beatB;
    if (Math.abs(shift) <= 220) bStartFileMs = Math.max(nextStartMs, Math.round(bStartFileMs + shift));
  }

  // ---- B 的前奏就是混音窗口----
  // 用户听感：B 的人声之前的伴奏才是最好的混音时间（春めく 有 18 s 前奏）。
  // 那就把过渡长度直接设成「B 从起播到真开唱」的长度：A 在这段时间里被逐段减掉，
  // B 由 -18 dB 渐入（v2Plan 的 bEntry），到唱词开口的那一刻正好满音量。

  // ---- B 的唱句必须落在淡化终点（：衔接完不是从歌词开始唱）----
  // bStartFileMs 是 **B 的文件坐标**：把 B 的起播点回推 fadeMs×tempoRate，
  // B 的第一句唱词就正好在 A 的末句结束（= 淡化终点）那一刻开口。
  let vocalEntryGapMs = 0;
  if (vocalAligned && vocalFileMs > 0 && !structure) {
    const rate = Math.max(0.5, tempoRate);
    const earliestA = Math.round(currentStartMs + currentPosMs + 80);
    // 收短的下限用 floor（v2 的「最短混音」）：以前只卡 MIN_FADE_MS=1.2 s，
    // 于是「B 前奏只有 2 s」会把 6 s 的结构过渡砍成 1.9 s，听感变成假过渡。
    // 宁可让 B 的首句在淡化过程中间开口（A 此时已被低通/让位），也不砍长度。
    // B 的前奏（首句位置）本身就是「接唱」需要的窗口长度：
    //   前奏 9.3 s 的歌唱 12 s 的 floor 会把首句顶到淡化中间；前奏 2 s 时则只做 2 s 的短接。
    //   所以下限取 min(floor, 前奏)，但绝不低于 MIN_FADE_MS。
    const bPlayRate = tempoInverted ? 1 : Math.max(0.5, tempoRate);
    const introMsForFloor = Math.max(0, Math.round((vocalFileMs - nextStartMs) / bPlayRate));
    const shortenFloorMs = Math.max(MIN_FADE_MS, Math.min(floorMs, introMsForFloor || floorMs));
    const shortenToVocal = () => {
      const room = Math.round((vocalFileMs - bStartFileMs - 100) / rate);
      if (room >= shortenFloorMs && room < fadeMs) {
        const newStart = Math.round(fadeEndFile - room);
        if (newStart >= earliestA) {
          fadeStartFile = newStart;
          fadeMs = room;
        }
      }
    };
    // A 的末句唱完就结束窗口：不让 A 后面那段「只剩器乐/渐隐」的尾巴把过渡拉长
    //   （那会让 B 的前奏在 A 已经没人声的地方空转，听感就是「衔接不上最后一句」）。
    if ((options.currentLastVocalEndMs ?? 0) > 0 && lastVocalEndPosMs > 0 && !structure) {
      const lyricWordFile = Math.round(currentStartMs + lastVocalEndPosMs);
      // LRC 的末句常比真实唱段短（尾句拖音 / ad-lib 没写进歌词）。切割点取两者较晚者：
      // 宁可多留一小节器乐，也不要在还唱着的时候把 A 切走（体检里的 A_VOCAL_CUT）。
      const curveWordFile = activityLastVocalEndMs > 0 ? Math.round(activityLastVocalEndMs) : 0;
      const lastWordFile = Math.max(lyricWordFile, curveWordFile);
      const barA = barIntervalOf(analysis) || 2000;
      // 「末句唱完」不等于「这首歌完了」：很多歌最后一个词后面还有半句/一整句的器乐回答、
      // 或者正好压在 climax 的最后一小节上。以前只留半小节，听感就是「唱到最后一个词就切」。
      // 现在留出一个**音乐上的收尾**：
      //   1) 至少一整小节（给呼吸）；
      //   2) 若下一个乐句边界在 4 小节内 → 走到乐句边界；
      //   3) 若 climax 窗口在 4 小节内结束 → 让高潮放完；
      //   4) 若当前段落（climax/outro）在 2 小节内结束 → 走到段落边界；
      // 上限 4 小节：再长就变成「为了等尾巴把 B 拖进来」。
      let holdAfterWord = Math.max(300, Math.round(barA));
      const wordAbsA = lastWordFile;
      const nextPhrase = (analysis.phraseStartsMs ?? [])
        .filter((ms) => Number.isFinite(ms) && ms > wordAbsA && ms - wordAbsA <= barA * 4)
        .sort((x, y) => x - y)[0];
      if (nextPhrase !== undefined) holdAfterWord = Math.max(holdAfterWord, Math.round(nextPhrase - wordAbsA));
      const climaxEnd = analysis.climaxEndMs ?? 0;
      if (climaxEnd > wordAbsA && climaxEnd - wordAbsA <= barA * 4) {
        holdAfterWord = Math.max(holdAfterWord, Math.round(climaxEnd - wordAbsA));
      }
      const holding = (analysis.sections ?? []).find(
        (sec) => sec.startMs <= wordAbsA && sec.endMs > wordAbsA,
      );
      if (holding && holding.endMs - wordAbsA <= barA * 2) {
        holdAfterWord = Math.max(holdAfterWord, Math.round(holding.endMs - wordAbsA));
      }
      holdAfterWord = Math.min(holdAfterWord, Math.round(barA * 4));
      const targetEnd = Math.min(schedAudibleEndMs, lastWordFile + holdAfterWord);
      const cut = fadeEndFile - targetEnd;
      if (cut > 0 && cut < fadeMs && targetEnd - earliestA >= Math.min(shortenFloorMs, fadeMs)) {
        fadeEndFile = targetEnd;
        const keep = Math.min(fadeMs, Math.max(shortenFloorMs, fadeEndFile - earliestA));
        fadeStartFile = Math.round(fadeEndFile - keep);
        fadeMs = fadeEndFile - fadeStartFile;
      }
    }
    // B 永远从它自己的起点（曲首 / CUE 起点 / 手动起点）开始播，不 seek 到歌中间：
    //   以前 wanted = 首句 − fadeMs 会把 2 soon 这种「首句在 46 s」的歌直接 seek 到 24–50 s，
    //   听感就是「过渡完直接跳到歌中间、跳词」。
    //   窗口长度 = 首句 − 起点，最长压到 MAX_FADE_MS；只有首句离起点超过上限时才必须跳。
    // 绝不把 B seek 到歌中间：B 一律从自己的起点播（曲首 / CUE 起点 / 手动起点），
    //   窗口长度 = min(当前过渡长, B 的起点到首句)，够不到就靠 shortenToVocal 收短。
    //   这样 2 soon 这种「首句在 46 s」的歌不会一进来就跳到 24–50 s（听感=跳词）。
    bStartFileMs = nextStartMs;
    shortenToVocal();
    // 起点后移会让 B 更晚开始唱：真的放不下就退回 B 的入口再收一次淡化。
    if (nextDurationMs > 0 && nextDurationMs - (bStartFileMs - nextStartMs) < fadeMs + 400) {
      bStartFileMs = baseBStartFileMs;
      shortenToVocal();
    }
    vocalEntryGapMs = Math.round(vocalFileMs - (fadeStartFile + fadeMs * rate));
    logEvent('automix-v2-vocal-align',
      `B 起播 ${(bStartFileMs / 1000).toFixed(2)}s，首句在淡化终点${vocalEntryGapMs === 0 ? '同时' : `差 ${vocalEntryGapMs}ms`}开口`);
  }
  if (nextLimitMs > 0 && bStartFileMs > nextLimitMs) bStartFileMs = nextLimitMs;

  // 风格与低频交接：auto 按调性/BPM 距离解析；交接点按结构混音的小节线换算。
  let style = resolveTransitionStyle(settings, analysis, nextAnalysis);
  if (style === 'cut' && settings.lengthMode === 'auto' && fadeMs > 2400) {
    fadeStartFile += fadeMs - 2400;
    fadeMs = 2400;
  }
  if (handoff && vocalFileMs > bStartFileMs) {
    const room = (vocalFileMs - bStartFileMs - 100) / (tempoInverted ? 1 : tempoRate);
    if (room >= MIN_AUTO_BLEND_MS && room < fadeMs) {
      fadeStartFile += fadeMs - room;
      fadeMs = room;
    }
  }
  if (fadeMs < MIN_FADE_MS) return null;

  if (settings.lengthMode !== 'auto' && settings.style === 'auto' && style === 'cut') style = 'equal';
  let bassHandoffP = AM_BASS_HANDOFF_P;
  if (settings.bassSwap === 'off') {
    bassHandoffP = 0;
  } else if (structure) {
    const swapBar = settings.bassSwap === 'bar1' ? 1 : 2;
    const structureBarMs = structure.barMs > 0 ? structure.barMs : 2000;
    bassHandoffP = Math.min(0.9, Math.max(0.12, (swapBar * structureBarMs) / fadeMs));
  }
  if (style === 'cut' && structure) bassHandoffP = 0;

  const tailFade = earlyTailFade;
  const matchFromMs = tailFade && tailFade.fadeStartMs < fadeStartFile
    ? Math.max(0, tailFade.fadeStartMs - 6_000)
    : fadeStartFile;
  const gainTrimDb = settings.loudnessMatch
    ? transitionMatchDb(analysis, nextAnalysis, matchFromMs, bStartFileMs, fadeMs,
        tempoInverted ? 1 : tempoRate) : 0;
  const TAIL_LIFT_CAP_DB = 12;
  const TAIL_LIFT_MIN_DROP_DB = 5;
  const tailLiftEnabled = (() => {
    try {
      return window.localStorage.getItem('zilux2.dev.tailfade') !== '0';
    } catch {
      return true;
    }
  })();
  const aUnfade = tailLiftEnabled && tailFade && tailFade.dropDb >= TAIL_LIFT_MIN_DROP_DB && tailFade.fadeEndMs > fadeStartFile
    ? clipLift(tailFade.points, Math.max(fadeStartFile, tailFade.fadeStartMs), fadeEndFile)
      .map((point) => ({ ms: point.ms, liftDb: Math.min(TAIL_LIFT_CAP_DB, point.liftDb) }))
    : null;

  let autoStylePick = isAutomixV2(effectiveMode())
    ? pickV2StyleFor(
        {
          a: analysis,
          b: nextAnalysis,
          fadeMs,
          barMs: fadePlan.barMs || barIntervalOf(analysis) || 2000,
          beatMs: (fadePlan.barMs || barIntervalOf(analysis) || 2000) / 4,
          bFirstVocalFileMs: vocalFileMs,
          bFirstVocalOffsetMs: vocalFileMs > 0 ? Math.max(0, vocalFileMs - nextStartMs) : 0,
          bpmAEff: tempoInverted ? analysis.bpm / Math.max(0.5, tempoRate) : analysis.bpm,
          bpmBEff: tempoInverted ? nextAnalysis.bpm : nextAnalysis.bpm * Math.max(0.5, tempoRate),
          bpmGapPct: analysis.bpm > 0
            ? Math.abs((nextAnalysis.bpm * Math.max(0.5, tempoRate) - analysis.bpm) / analysis.bpm) * 100
            : 0,
          gestureCapMs: budgetForAnalysis(
            nextAnalysis,
            fadePlan.barMs || barIntervalOf(nextAnalysis) || 2_000,
          ).gestureMaxMs,
        },
        { allowCut: true },
      )
    : null;
  if (autoStylePick) {
    logEvent('automix-v2-style', `${autoStylePick.label}｜${autoStylePick.reasons.join('；')}`);
  }
  // 回声/混响收尾只在 A 尾巴稀疏时成立：密集鼓组 + 长延迟尾会把 1.5–4 kHz 糊成一片，
  //   听感是「脏」而不是「空间」。鼓密度 >0.55 时退回滤波交叉。
  const aTailDrumDensity = (() => {
    const act = analysis.activity;
    if (!act?.drum?.length) return 0;
    const hop = act.hopMs > 0 ? act.hopMs : 250;
    const from = Math.max(0, fadeStartFile + fadeMs - 4000);
    const i0 = Math.max(0, Math.floor(from / hop));
    const i1 = Math.min(act.drum.length - 1, Math.ceil((fadeStartFile + fadeMs) / hop));
    let sum = 0;
    let n = 0;
    for (let i = i0; i <= i1; i += 1) { sum += act.drum[i] ?? 0; n += 1; }
    return n ? sum / n : 0;
  })();
  if (autoStylePick && (autoStylePick.id === 'echoOut' || autoStylePick.id === 'reverbOut') && aTailDrumDensity > 0.55) {
    logEvent('automix-v2-wet-dense',
      `A 尾鼓密度 ${aTailDrumDensity.toFixed(2)}，${autoStylePick.label} 改成滤波交叉`);
    autoStylePick = {
      id: 'filterSweep',
      label: describeStyle('filterSweep'),
      params: { swapShare: 0.3, sweepShare: 0.45, duckDb: -5, tailHold: 0.12 },
      reasons: [`A 尾鼓密度 ${aTailDrumDensity.toFixed(2)} 高于 0.55`, '湿声会糊掉密集鼓组，退回滤波交叉'],
    };
  }
  const hardCut = autoStylePick?.id === 'cut' || autoStylePick?.id === 'slam';
  if (hardCut) {
    const cutBudget = budgetForAnalysis(nextAnalysis, barIntervalOf(analysis) || 2_000).gestureMaxMs;
    const cutCeil = Math.max(2_600, Math.min(4_000, Number.isFinite(cutBudget) ? cutBudget : 4_000));
    const targetMs = Math.max(2_600, Math.min(cutCeil, Math.round(fadeMs * 0.3)));
    const anchorBeat = pickDownbeatNear(analysis, fadeEndFile, fadeStartFile) ?? fadeEndFile;
    const cutEnd = Math.max(fadeStartFile + MIN_FADE_MS, Math.min(fadeEndFile, anchorBeat));
    fadeMs = Math.max(MIN_FADE_MS, Math.min(targetMs, cutEnd - fadeStartFile));
    fadeStartFile = Math.round(cutEnd - fadeMs);
    style = 'cut';
    handoff = false;
    vocalAligned = false;
    logEvent('automix-v2-hard-cut',
      `${autoStylePick?.label ?? 'cut'}：窗口收到 ${(fadeMs / 1000).toFixed(2)}s，落点 ${Math.round(cutEnd)}ms`);
  }

  let vocalOverlay: VocalOverlayPlan | null = null;
  if (autoStylePick?.id === 'acapellaOverlay') {
    vocalOverlay = planVocalOverlay({
      aVocal: vocalDensity(analysis),
      bVocal: vocalDensity(nextAnalysis),
      keyGap: camelotGap(analysis.camelot, nextAnalysis.camelot),
      fadeMs,
    });
    if (!vocalOverlay.enabled) {
      autoStylePick = null;
      logEvent('automix-v2-overlay-skip', vocalOverlay.note);
    } else {
      logEvent('automix-v2-overlay', vocalOverlay.note);
    }
  }

  if (!hardCut && !handoff && settings.lengthMode === 'auto' && fadeMs < MIN_AUTO_BLEND_MS) {
    const barMs = barIntervalOf(analysis) || 2_000;
    const want = Math.min(MAX_FADE_MS, Math.max(MIN_AUTO_BLEND_MS, Math.round(barMs * 4)));
    const earliest2 = Math.round(currentStartMs + currentPosMs + 80);
    const start = Math.max(earliest2, Math.round(fadeEndFile - want));
    if (fadeEndFile - start >= MIN_AUTO_BLEND_MS) {
      fadeStartFile = start;
      fadeMs = fadeEndFile - start;
    }
  }

  let halfTimeFolded = false;
  if (autoStylePick?.id === 'halfTime' && analysis.bpm > 0 && nextAnalysis.bpm > 0) {
    const ratio = analysis.bpm / nextAnalysis.bpm;
    const folded = ratio > 1.5 ? 2 : ratio < 0.67 ? 0.5 : 1;
    if (folded !== 1) {
      tempoRate = folded;
      tempoInverted = false;
      halfTimeFolded = true;
      logEvent('automix-v2-halftime',
        `按 2:1 关系折叠：B 以 ×${folded} 播放（${Math.round(nextAnalysis.bpm)} → ${Math.round(nextAnalysis.bpm * folded)} BPM）`);
    }
  }

  if (isAutomixV2(effectiveMode())) {
    const barBudget = barIntervalOf(nextAnalysis) || 2_000;
    const budget = budgetForAnalysis(nextAnalysis, barBudget);
    const gesture = autoStylePick?.id === 'cut' || autoStylePick?.id === 'slam'
      || autoStylePick?.id === 'dropSwap' || autoStylePick?.id === 'backspin';
    const cap = gesture ? budget.gestureMaxMs : budget.maxFadeMs;
    if (Number.isFinite(cap) && cap >= MIN_FADE_MS && fadeMs > cap) {
      if (instSeam !== null) {
        logEvent('automix-v2-budget-skip',
          `${budget.note}；但器乐接缝在 ${Math.round(instSeam.ms)}ms，保留 ${(fadeMs / 1000).toFixed(1)}s 窗口`);
      } else {
        fadeMs = Math.round(cap);
        fadeStartFile = Math.round(fadeEndFile - fadeMs);
        logEvent('automix-v2-budget', `${budget.note}；窗口收到 ${(fadeMs / 1000).toFixed(1)}s`);
      }
    }
  }

  let dropEntry: DropEntryPlan | null = null;
  if (autoStylePick?.id === 'dropSwap' || autoStylePick?.id === 'doubleDrop') {
    dropEntry = planDropEntry({
      b: nextAnalysis,
      fromMs: nextStartMs,
      mode: autoStylePick.id,
      barMs: barIntervalOf(nextAnalysis) || 2_000,
      durationMs: nextDurationMs,
    });
    if (dropEntry.enabled) {
      bStartFileMs = dropEntry.entryFileMs;
      handoff = false;
      vocalAligned = false;
      logEvent('automix-v2-drop-entry', dropEntry.note);
    } else {
      logEvent('automix-v2-drop-skip', '没找到 drop 落点，按普通手法处理');
      dropEntry = null;
    }
  }

  let doubling: DoublingPlan | null = null;
  if (autoStylePick?.id === 'doubling') {
    const barB = barIntervalOf(nextAnalysis) || 2_000;
    const probe = planDropEntry({ b: nextAnalysis, fromMs: nextStartMs, mode: 'dropSwap', barMs: barB, durationMs: nextDurationMs });
    doubling = planDoubling({
      b: nextAnalysis,
      fromMs: nextStartMs,
      beatMs: barB / 4,
      barMs: barB,
      fadeMs,
      preferStartMs: probe.enabled ? probe.entryFileMs : 0,
    });
    if (doubling.enabled) logEvent('automix-v2-doubling', doubling.note);
    else { logEvent('automix-v2-doubling-skip', '窗口放不下叠播'); doubling = null; }
  }

  if (isAutomixV2(effectiveMode()) && !hardCut && fadeMs < MIN_AUTO_BLEND_MS) {
    const room = Math.round(fadeStartFile - (currentStartMs + currentPosMs + 80));
    const want = Math.min(room, MIN_AUTO_BLEND_MS - fadeMs);
    if (want >= 200) {
      fadeStartFile = Math.round(fadeStartFile - want);
      fadeMs = Math.round(fadeMs + want);
      logEvent('automix-v2-floor-window', `窗口补到 ${(fadeMs / 1000).toFixed(1)}s（原 ${((fadeMs - want) / 1000).toFixed(1)}s）`);
    }
  }

  if (autoStylePick) {
    const spec = STYLE_CATALOG.find((entry) => entry.id === autoStylePick!.id);
    if (spec && fadeMs + 1 < spec.minFadeMs) {
      logEvent('automix-v2-style-drop', `窗口 ${(fadeMs / 1000).toFixed(1)}s < 手法最短 ${(spec.minFadeMs / 1000).toFixed(1)}s，退回中性过渡`);
      if (halfTimeFolded) {
        tempoRate = 1;
        tempoInverted = false;
        halfTimeFolded = false;
        logEvent('automix-v2-halftime-cancel', '手法被丢弃，取消 2:1 折叠，恢复原速');
      }
      autoStylePick = {
        id: 'filterSweep',
        label: describeStyle('filterSweep'),
        params: { swapShare: 0.3, sweepShare: 0.45, duckDb: -5, tailHold: 0.12 },
        reasons: [`窗口 ${(fadeMs / 1000).toFixed(1)}s 不足 ${spec.label} 的 ${(spec.minFadeMs / 1000).toFixed(1)}s`, '退回苹果系滤波交叉'],
      };
    }
  }

  // A 末句硬保护：窗口末端早于末句 +600 ms 时把窗口延长到盖过末句（受 B 可用长度与上限约束）。
  let vocalTailShortfallMs = 0;
  if (lastVocalEndPosMs > 0) {
    const lastWordFile = currentStartMs + Math.min(lastVocalEndPosMs, audibleEndPosMs);
    const needEnd = lastWordFile + 600;
    const windowEnd = fadeStartFile + fadeMs;
    if (needEnd > windowEnd && fadeStartFile < needEnd) {
      const bRoom = nextDurationMs > 0 ? Math.max(0, nextDurationMs - (bStartFileMs - nextStartMs)) : Number.POSITIVE_INFINITY;
      const target = Math.min(fadeStartFile + MAX_FADE_MS, currentStartMs + audibleEndPosMs + 400, fadeStartFile + Math.max(0, bRoom - 400), needEnd);
      if (target > windowEnd + 200) {
        fadeMs = Math.round(target - fadeStartFile);
        logEvent('automix-v2-vocal-guard', `A 末句 ${Math.round(lastWordFile)}ms，窗口末端 ${Math.round(windowEnd)}ms → ${Math.round(fadeStartFile + fadeMs)}ms`);
      }
      const shortfall = Math.round(needEnd - (fadeStartFile + fadeMs));
      if (shortfall > 200) {
        vocalTailShortfallMs = shortfall;
        logEvent('automix-v2-vocal-tail', `窗口末端仍早于 A 末句 ${shortfall}ms，A 改为停在 -10 dB 唱完再收（tailBleed ${Math.min(3000, shortfall + 600)}ms）`);
      }
    }
  }

  const autoPolicy = stylePolicyFor(fadeMs, barIntervalOf(nextAnalysis) || 2000);
  const autoExtension = (() => {
    if (!isAutomixV2(effectiveMode()) || hardCut) return null;
    if (!lastVocalEndPosMs) return null;
    const needed = Math.max(0, fadeStartFile + fadeMs - (currentStartMs + lastVocalEndPosMs));
    if (needed <= 0) return null;
    const plan = planExtension({
      side: 'a' as const,
      analysis,
      neededMs: needed,
      policy: autoPolicy,
      barMs: barIntervalOf(nextAnalysis) || 2000,
      preferModel: false,
      modelReady: false,
    });
    return plan.source === 'none' ? null : plan;
  })();

  const lowCorr = bassCorrelation({ a: analysis, b: nextAnalysis, fadeStartAMs: fadeStartFile, fadeStartBMs: bStartFileMs, fadeMs, tempoRate });
  const trimRoom = Math.max(0, 6 - Math.max(0, gainTrimDb));
  const plannedV2 = (() => {
    if (!isAutomixV2(effectiveMode())) return null;
    if (hardCut) return null;
    const barMs = barIntervalOf(nextAnalysis) || 2000;
    const share = Math.min(0.6, Math.max(0.06, (2 * barMs) / Math.max(1, fadeMs)));
    return buildV2Plan({
      fadeMs, barMs, rate: tempoRate, swapShare: share, bEntry: true,
      vocalAt: snapVocalAt(analysis.downbeats, fadeStartFile, fadeMs, barMs),
      aTailHold: tailAnchorKind === 'vocal' && lastVocalEndPosMs > 0 ? 0.22 : 0,
      sweep: autoStylePick?.params?.sweepShare !== 0,
      sweepShare: autoStylePick?.params?.sweepShare,
      windowScale: autoPolicy.windowScale,
      swapShareBias: autoPolicy.swapShareBias,
      duckScale: autoPolicy.duckScale,
      lowStartP: lowCorr !== null && lowCorr < -0.5 ? 0.9 : lowCorr !== null && lowCorr < -0.2 ? 0.8 : undefined,
      handoffStartP: tailFadeHandoffP(earlyTailFade, fadeStartFile, fadeMs),
    });
  })();
  const introBridge = (() => {
    if (!isAutomixV2(effectiveMode()) || hardCut) return null;
    const introMs = vocalFileMs > bStartFileMs ? vocalFileMs - bStartFileMs : 0;
    if (vocalFileMs <= 0 || introMs < MIN_AUTO_BLEND_MS) return null;
    // 前奏已经够长时不需要桥；只有窗口比前奏长（或前奏太短撑不住窗口）才补。
    if (introMs >= fadeMs) return null;
    return planIntroBridge({
      introStartMs: bStartFileMs,
      firstVocalMs: vocalFileMs,
      barMs: barIntervalOf(nextAnalysis),
      targetMs: fadeMs,
      loopUnits: nextAnalysis.loopUnits,
      keyFrom: analysis.key,
      keyTo: nextAnalysis.key,
    });
  })();

  // 变速斜率：窗口内每拍最多 1% 的速率变化（整八度折叠不动），超出就夹回。
  {
    const beatMsA = barIntervalOf(analysis) / 4 || 500;
    tempoRate = clampTempoRateForWindow(tempoRate, fadeMs, beatMsA, 1);
    if (Math.abs(tempoRate - 1) > 1e-6) {
      logEvent('automix-v2-rate-clamp', `窗口 ${(fadeMs / 1000).toFixed(1)}s，速率夹到 ×${tempoRate.toFixed(3)}`);
    }
  }

  const plannedSplitHz = plannedV2
    ? planSplitHz({ a: analysis, b: nextAnalysis, fadeStartAMs: fadeStartFile, fadeStartBMs: bStartFileMs, fadeMs, tempoRate })
    : 120;
  const plannedBTrim = plannedV2
    ? planBTrimCurve({
        a: analysis, b: nextAnalysis,
        fadeStartAMs: fadeStartFile, fadeStartBMs: bStartFileMs,
        fadeMs, tempoRate,
      }).map((db) => Math.min(db, trimRoom))
    : [];
  // A 有明显的母带渐隐时，窗口里那段「本来就该被补回来」的下坠允许补更多（6 dB）；
  // 3 dB 上限会把真正的渐隐补一半、留一个 3 LU 的坑。
  // 补平的上限也收：整窗补 6 dB 会让 A 听起来被「拉高」。
  // 通用路径以前完全不生成让位事件，质量门却按「A 已压 6 dB」算重叠 —— 听感与报表
  //   都对不上。这里补上真实的让位：B 唱就压 A 的 1.5–4 kHz，深度同乐句路径。
  // A 的让位只在两边的人声真的撞上时才排，深度封顶 3.5 dB：
  //   A 是主角，长窗（20 s）里按 B 的每一句去压它，听感就是「被按住」。
  const plannedDuck = plannedV2
    ? buildDuckEvents({
        a: analysis, fadeStartAMs: fadeStartFile,
        b: nextAnalysis, fadeStartBMs: bStartFileMs, fadeMs, tempoRate,
        maxDuckDb: -3.5,
        aInstrumental: vocalPresence(analysis) === 'instrumental',
      })
    : [];

  const loudTrimCapDb = earlyTailFade && earlyTailFade.dropDb >= 8 ? 4 : 2;
  const plannedQuality: QualityReport | null = plannedV2
    ? (() => {
        try {
          return qualityWithCurves({
            a: analysis, b: nextAnalysis,
            fadeStartAMs: fadeStartFile, fadeStartBMs: bStartFileMs,
            handoffStartP: 0.78, handoffEndP: 0.92,
            fadeMs, beatMs: barIntervalOf(analysis) / 4 || 500,
            tempoRate, gainTrimDb,
            aInstrumental: vocalPresence(analysis) === 'instrumental',
            keyGap: camelotGap(analysis.camelot, nextAnalysis.camelot),
            swapShare: Math.min(0.6, Math.max(0.06, (2 * (barIntervalOf(nextAnalysis) || 2000)) / Math.max(1, fadeMs))),
            bEntryDucked: !handoff,
            // halfTime / backspin 是「故意变速」的手法：速率跳变是设计，不是缺陷。
            rateJumpLimit: autoStylePick?.id === 'halfTime' || autoStylePick?.id === 'backspin' ? 12 : undefined,
            // 带 send 的手法：湿声尾巴在干声让位后仍在响，指标要把它算进去（否则量成假塌洞）。
            wetTail: autoStylePick?.id === 'echoOut' || autoStylePick?.id === 'reverbOut'
              ? { sendDb: -6, decayMs: autoStylePick.id === 'reverbOut' ? 1_600 : 900, fromP: 0.5 }
              : undefined,
            bTrim: plannedBTrim,
            aDuckDb: -12,
          }, plannedV2, {
            a: lowShareOf(analysis, fadeStartFile, fadeMs),
            b: lowShareOf(nextAnalysis, bStartFileMs, fadeMs * tempoRate),
          }, loudTrimCapDb);
        } catch { return null; }
      })()
    : null;

  return {
    v2Plan: plannedV2,
    v2Duck: plannedDuck,
    lowCorr,
    lowInvert: lowCorr !== null && lowCorr < -0.6,
    bTrimMax: plannedBTrim.length ? Math.max(...plannedBTrim) : 0,
    quality: plannedQuality,
    bTrim: plannedBTrim,
    splitHz: plannedSplitHz,
    loudTrimCapDb,
    fadeStartFileMs: fadeStartFile,
    fadeStartPosMs: fadeStartFile - currentStartMs,
    fadeMs,
    bStartFileMs,
    tempoRate,
    aRate: tempoMeet ? tempoMeetA : undefined,
    vocalOverlay,
    tempoInverted,
    // 墙钟长度 = 曲内时长 /(用户倍速 × 实际消耗速率)。
    // A 侧被拉向 B 时用 1/tempoRate（A 快放），双侧对齐时用 aRate，B 贴 A 时用 tempoRate。
    fadeWallMs: Math.round(
      fadeMs /
        (Math.max(0.5, baseDeckRate(options)) *
          (tempoMeet ? Math.max(0.5, tempoMeetA) : tempoInverted ? 1 / Math.max(0.5, tempoRate) : Math.max(0.5, tempoRate))),
    ),
    structure: structure !== null,
    cueMode: structure ? structure.cueMode : 'off',
    phraseBars: structure ? structure.bars : 0,
    bridge,
    vocalAnchor:
      vocalFileMs > 0 || lastVocalEndPosMs > 0
        ? {
            aLastEndMs: lastVocalEndPosMs > 0 ? currentStartMs + lastVocalEndPosMs : 0,
            bEntryMs: vocalFileMs,
            kind: tailAnchorKind,
            melodySim,
            instrumentalBars: instrumentalTailBars,
          }
        : null,
    instSeam: instSeam ? { kind: instSeam.kind, ms: instSeam.ms, barsFromEnd: instSeam.barsFromEnd } : null,
    introBridge,
    // A 的器乐尾巴：末句之后还剩一大段伴奏时，不把它在窗口末切断，
    // 让它在 B 的开头底下当一件乐器继续响，然后缓慢收干。
    aTailBleedMs: (() => {
      // 只在进阶 v2 档做（标准档的等功率过渡没有「把 A 尾巴当乐器」的位置）。
      if (!isAutomixV2(effectiveMode())) return 0;
      if (hardCut || autoStylePick?.id === 'backspin' || autoStylePick?.id === 'halfTime' || autoStylePick?.id === 'loopRoll') return 0;
      if (tailAnchorKind !== 'vocal' || lastVocalEndPosMs <= 0) return 0;
      // 已经决定「把母带渐隐段剔除在过渡之外」时，绝不能再把这段尾巴当乐器铺出来：
      // 窗口终点之后的全部内容就是那段渐隐，铺出去等于把剔掉的淡出又放回 B 底下。
      if (tailCutApplied) return 0;
      const lastWordFile = currentStartMs + Math.min(lastVocalEndPosMs, audibleEndPosMs);
      const restMs = schedAudibleEndMs - lastWordFile;
      const barMs = barIntervalOf(analysis) || 2000;
      const holdMs = Math.max(300, Math.round(barMs));
      // 尾巴越长放得越多：8 s 以内按实际，8–20 s 最多铺 12 s（再多会盖住 B 的副歌）。
      const cap = restMs >= 8_000 ? 12_000 : restMs >= 5_000 ? 8_000 : 4_000;
      // 尾巴再长也不能活过整个过渡窗口：否则过渡结束 B 都进副歌了，A 的残影还在底下响。
      // B 到顶之后 A 的低音还要多留一段（「混出时间放长些」）：
      // 原来上限 0.8×窗口，会把 A 的尾巴压在 B 到顶的同一秒里切掉。
      const windowCap = Math.max(600, Math.round(fadeMs * 1.15));
      const bleed = Math.min(cap, restMs - holdMs, windowCap);
      return bleed >= 600 ? Math.round(bleed) : 0;
    })(),
    aTailHold: (() => {
      if (!isAutomixV2(effectiveMode())) return 0;
      if (hardCut || autoStylePick?.id === 'backspin' || autoStylePick?.id === 'halfTime' || autoStylePick?.id === 'loopRoll') return 0;
      if (tailAnchorKind !== 'vocal' || lastVocalEndPosMs <= 0) return 0;
      if (tailCutApplied) return 0;
      const lastWordFile = currentStartMs + Math.min(lastVocalEndPosMs, audibleEndPosMs);
      const restMs = schedAudibleEndMs - lastWordFile;
      // 尾巴很长时铺得更实一点（−11 dB），否则 −13 dB，只当空气。
      return restMs >= 8_000 ? 0.28 : 0.22;
    })(),
    tailFade,
    aUnfade,
    // 窗口关不住 A 末句时留给尾巴的缺口（毫秒）；0 = 没有。
    tailGuardMs: vocalTailShortfallMs,
    // handoff 为真但 B 的首句没能精确落在接缝上（例如 B 的唱词起点不可信、或窗口被最短混音压过），
    // 这时不能装没事：给 B 的 1.5–4 kHz 排一组入场让位，A 唱完立刻放开。
    // 乐句路径早就有这条（`phraseBDuck`），常规路径一直缺，体检台因此报 HANDOFF_UNALIGNED + VOCAL_OVERLAP。（round 11）
    bDuck: (() => {
      // A 是纯器乐时 handoff 永远为假（没有末句可交接），但 B 仍可能在 A 还没结束时就开口：
      // 那一段没有任何让位，B 的人声直接盖在 A 的乐器上。这里把「A 器乐 + B 早唱」也算进
      // 入场让位——压的是 B 的 1.5–4 kHz，等 A 收干净再放开。（round 24）
      const aInstrumentalEntry = !handoff && !vocalAligned
        && vocalPresence(analysis) === 'instrumental';
      if (!handoff && !aInstrumentalEntry) return null;
      if (handoff && vocalAligned) return null;
      try {
        const events = buildBEntryDuck({
          a: analysis, fadeStartAMs: fadeStartFile, fadeMs,
          b: nextAnalysis, bStartMs: bStartFileMs, tempoRate,
          aInstrumental: aInstrumentalEntry,
        });
        return events.length ? events : null;
      } catch { return null; }
    })(),
    styleId: autoStylePick?.id,
    styleParams: autoStylePick?.params,
    styleReasons: autoStylePick?.reasons,
    stylePolicy: autoPolicy,
    extensionPlan: autoExtension,
    form: formOf({
      styleId: autoStylePick?.id,
      bridge: Boolean(bridge),
      dropEntry: Boolean(dropEntry),
      tempoInverted,
      tempoRate,
    }),
    dropEntry,
    doubling,
    cueInMs: structure ? structure.cueInMs : 0,
    cueOutMs: structure ? structure.cueOutMs : 0,
    style,
    bassHandoffP,
    gainTrimDb,
    audibleEndPosMs: Math.round(audibleEndPosMs),
    tailSilenceMs: Math.round(tailSilenceMs),
    nextVocalStartMs: vocalPosMs,
    vocalAligned,
    handoff,
    lastVocalEndPosMs,
    handoffHoldMs,
    autoFadeMs: fadePlan.auto ? fadePlan.ms : 0,
    autoBars: fadePlan.bars,
    autoBarMs: fadePlan.barMs,
    autoNote: vocalGuardNote || (handoff
      ? `歌词衔接：A 末句 ${lastVocalEndPosMs} ms 唱完${
          handoffHoldMs > 0
            ? `，先独听 ${handoffHoldMs} ms 尾奏（约 ${Math.max(1, Math.round(handoffHoldMs / handoffBarMs))} 小节）`
            : ''
        }，再用 ${fadeMs} ms 完成交叠（约 ${Math.max(1, Math.round(fadeMs / handoffBarMs))} 小节）到 A 可听结尾，接下一首首句 ${vocalPosMs} ms`
      : settings.handoff
        ? fadePlan.note
        : `歌词衔接已关闭，按小节普通淡化（${fadePlan.note}）`),
  };
}

/**
 * 延长段起播参数：bed 从 fadeStart 整段垫底，tail 从 A 的可听结尾补位。
 * 单独提出来是为了可测——播放路径本身没有 AudioContext 就起不来。
 */
export function extensionPlaybackParams(
  plan: Pick<ActivePlan, 'extensionPlan' | 'audibleEndPosMs' | 'fadeStartPosMs' | 'fadeMs'>,
  clock: number,
  rate: number,
): { atSec: number; durationSec: number; fadeInSec: number; fadeOutSec: number; bed: boolean; coverSec?: number } | null {
  const ext = plan.extensionPlan;
  if (!ext || !(ext.targetMs > 0)) return null;
  const bed = ext.mode === 'bed';
  const safeRate = rate > 0 ? rate : 1;
  // 垫底比窗口短时，往后贴：空档总在窗口末尾（A 已经收掉、B 还没顶上来），
  //   从 fadeStart 起播会让最后几秒重新露洞。
  const atSec = bed
    ? clock
    : clock + Math.max(0, (plan.audibleEndPosMs - plan.fadeStartPosMs) / 1000 / safeRate);
  const bedSeconds = plan.fadeMs / 1000;
  return {
    atSec,
    durationSec: bed ? bedSeconds : ext.targetMs / 1000,
    fadeInSec: bed ? 0.6 : 0.02,
    fadeOutSec: bed ? Math.min(1.2, bedSeconds / 3) : 0.05,
    bed,
    ...(bed ? { coverSec: bedSeconds } : {}),
  };
}

function applySchedule(plan: ActivePlan, schedule: FadeSchedule): void {
  plan.bedWindows = undefined;
  if (schedule.cleanPickup && plan.graphMode && schedule.vocalAnchor?.bEntryMs) {
    const buffers = new Map<number,{other:AudioBuffer; vocals:AudioBuffer}>();
    plan.bedWindows = buffers;
    const ctx = deckAudioContext(plan.options.standby);
    const track = (plan.options as CrossfadePrepareOptions).next.track;
    const end = schedule.vocalAnchor.bEntryMs/1000 + 4;
    if (ctx) void import('../core/stemsClient').then(async client => {
      const first = client.stemWindowIndex(schedule.bStartFileMs/1000);
      const last = client.stemWindowIndex(Math.max(0,end-0.001));
      for (let window=first; window<=last && plan.bedWindows===buffers; window++) {
        let result = await client.prepareStemsWindow(track,window,{stems:4});
        while (plan.bedWindows===buffers && plan.phase==='prepared' &&
          (result.state==='computing' || result.state==='busy')) {
          await new Promise(resolve => setTimeout(resolve,Math.max(500,Math.min(5000,result.retryAfterMs ?? 1000))));
          if (plan.bedWindows!==buffers || plan.phase!=='prepared') return;
          result = await client.prepareStemsWindow(track,window,{stems:4});
        }
        if (result.state !== 'ready' || plan.bedWindows!==buffers) return;
        const [other,vocals] = await Promise.all((['other','vocals'] as const).map(part => client.loadStemWindow(ctx,track,window,part,{stems:4})));
        buffers.set(window,{other,vocals});
      }
    }).catch(() => logEvent('pickup-bed-unavailable','器乐分轨未就绪，保留原曲尾鼓'));
  }
  plan.cleanPickup = schedule.cleanPickup;
  plan.beatSync = schedule.beatSync;
  plan.phraseMatch = schedule.cueMode === 'phrase-match';
  plan.tempoInverted = schedule.tempoInverted ?? false;
  plan.aRate = schedule.aRate;
  plan.fadeWallMs = schedule.fadeWallMs ?? schedule.fadeMs;
  plan.styleId = schedule.styleId;
  plan.styleParams = schedule.styleParams;
  plan.styleReasons = schedule.styleReasons;
  plan.aTailBleedMs = schedule.aTailBleedMs ?? 0;
  plan.loudTrimCapDb = schedule.loudTrimCapDb ?? 3;
  plan.aTailHold = schedule.aTailHold ?? 0;
  // 窗口关不住 A 的最后一句时，用尾巴把这一句唱完再淡出：
  // 这是听感上的「不被切断」，不是把 A 留在 B 底下赖着不走，所以尾巴最多 3 s。
  const tailGuardMs = schedule.tailGuardMs ?? 0;
  if (tailGuardMs > 0 && !schedule.cleanPickup) {
    const coverMs = Math.min(3000, tailGuardMs + 600);
    plan.aTailBleedMs = Math.max(plan.aTailBleedMs, coverMs);
    plan.aTailHold = Math.max(plan.aTailHold, 0.32);
    plan.tailGuardMs = coverMs;
  }
  plan.tailBleedArmed = false;
  plan.fadeStartFileMs = schedule.fadeStartFileMs;
  plan.fadeStartPosMs = schedule.fadeStartPosMs;
  plan.fadeMs = schedule.fadeMs;
  plan.bStartFileMs = schedule.bStartFileMs;
  plan.tempoRate = schedule.tempoRate;
  plan.handoff = schedule.handoff;
  plan.lastVocalEndPosMs = schedule.lastVocalEndPosMs;
  plan.handoffHoldMs = schedule.handoffHoldMs;
  plan.audibleEndPosMs = schedule.audibleEndPosMs;
  debug.fadeStartPosMs = schedule.fadeStartPosMs;
  debug.fadeMs = schedule.fadeMs;
  debug.bStartFileMs = schedule.bStartFileMs;
  debug.tempoRate = schedule.tempoRate;
  debug.tempoMatched = Math.abs(schedule.tempoRate - 1) > 0.001;
  debug.tempoRateLive = schedule.tempoRate;
  debug.pllActive = false;
  debug.pllRate = schedule.tempoRate;
  debug.pllErrBeats = 0;
  debug.currentAudibleEndMs = schedule.audibleEndPosMs;
  debug.tailSilenceMs = schedule.tailSilenceMs;
  debug.nextVocalStartMs = schedule.nextVocalStartMs;
  debug.vocalAligned = schedule.vocalAligned;
  debug.handoffActive = schedule.handoff;
  debug.lastVocalEndPosMs = schedule.lastVocalEndPosMs;
  debug.handoffHoldMs = schedule.handoffHoldMs;
  debug.autoFadeMs = schedule.autoFadeMs;
  debug.autoBars = schedule.autoBars;
  debug.autoBarMs = schedule.autoBarMs;
  debug.autoNote = schedule.autoNote;
  plan.styleResolved = schedule.style;
  plan.bassHandoffP = schedule.bassHandoffP;
  plan.gainTrimDb = schedule.gainTrimDb;
  plan.phraseBars = schedule.phraseBars;
  plan.bridge = schedule.bridge ?? null;
  plan.vocalAnchor = schedule.vocalAnchor ?? null;
  plan.introBridge = schedule.introBridge ?? null;
  plan.introBuffer = undefined;
  const intro = plan.introBridge;
  if (intro) {
    const ctx = deckAudioContext(plan.options.active);
    const src = (plan.options as CrossfadePrepareOptions).nextUrl;
    if (ctx && src) void renderIntroBridgeBuffer({ctx,src,...intro,playbackRate:schedule.tempoRate})
      .then(buffer => { if (buffer && plan.introBridge === intro) plan.introBuffer = buffer; })
      .catch(() => {});
  }
  // 回旋刹车：只有 styleKit 选中 backspin 时才倒放；参数纯算，素材在下面预热。
  plan.backspin = schedule.styleId === 'backspin'
    ? planBackspin({
        fadeMs: schedule.fadeMs,
        barMs: barIntervalOf((plan.options as CrossfadePrepareOptions).currentAnalysis.analysis) || 2_000,
        keyGap: camelotGap(
          (plan.options as CrossfadePrepareOptions).currentAnalysis.analysis.camelot,
          (plan.options as CrossfadePrepareOptions).nextAnalysis.analysis.camelot,
        ),
        aInstrumental: vocalPresence((plan.options as CrossfadePrepareOptions).currentAnalysis.analysis) === 'instrumental',
      })
    : null;
  if (plan.backspin?.enabled) {
    const spin = plan.backspin;
    const src = plan.options.active.currentSrc || plan.options.active.src;
    const ctx = deckAudioContext(plan.options.active);
    plan.backspinBuffer = undefined;
    if (src && ctx) {
      void renderBackspinBuffer({ ctx, src, startFileMs: schedule.fadeStartFileMs, tailMs: spin.tailMs })
        .then((buffer) => { if (buffer && plan.backspin === spin) plan.backspinBuffer = buffer; })
        .catch(() => {});
    } else if (src) {
      prefetchBridgeBytes(src);
    }
    logEvent('automix-v2-backspin', spin.note);
  }
  // 循环滚奏：把 A 在窗口开头那 2–4 小节平铺两遍，接缝由 tileLoopChannels 压 2 ms。
  plan.loopRoll = schedule.styleId === 'loopRoll'
    ? planLoopRoll({
        fadeMs: schedule.fadeMs,
        barMs: barIntervalOf((plan.options as CrossfadePrepareOptions).currentAnalysis.analysis) || 2_000,
        unitBars: 4,
      })
    : null;
  if (plan.loopRoll?.enabled) {
    const roll = plan.loopRoll;
    const src = plan.options.active.currentSrc || plan.options.active.src;
    const ctx = deckAudioContext(plan.options.active);
    plan.loopRollBuffer = undefined;
    if (src && ctx) {
      void renderBridgeBuffer({ ctx, src, unitStartFileMs: schedule.fadeStartFileMs, unitMs: roll.unitMs, passes: roll.passes })
        .then((buffer) => { if (buffer && plan.loopRoll === roll) plan.loopRollBuffer = buffer; })
        .catch(() => {});
    } else if (src) {
      prefetchBridgeBytes(src);
    }
    logEvent('automix-v2-loop-roll', roll.note);
  }
  // 这里必须读 schedule：plan.doubling 在下面几十行才赋值，
  // 旧代码读 plan.doubling 恒 undefined → doubling 选中即静默无声。
  const scheduledDoubling = schedule.doubling ?? null;
  if (scheduledDoubling?.enabled) {
    const dbl = scheduledDoubling;
    const src = plan.options.standby.currentSrc || plan.options.standby.src;
    const ctx = deckAudioContext(plan.options.standby);
    plan.doublingBuffer = undefined;
    if (src && ctx) {
      void renderBridgeBuffer({ ctx, src, unitStartFileMs: dbl.sliceStartFileMs, unitMs: dbl.sliceMs, passes: dbl.repeats })
        .then((buffer) => { if (buffer && schedule.doubling === dbl) plan.doublingBuffer = buffer; })
        .catch(() => {});
    } else if (src) {
      prefetchBridgeBytes(src);
    }
  }
  plan.form = schedule.form ?? null;
  plan.decision = schedule.decision ?? null;
  plan.quality = schedule.quality ?? null;
  plan.scheduleRef = schedule;
  plan.v2Plan = schedule.v2Plan ?? null;
  plan.v2Duck = schedule.v2Duck ?? null;
  plan.dropEntry = schedule.dropEntry ?? null;
  plan.doubling = schedule.doubling ?? null;
  plan.bDuck = schedule.bDuck ?? null;
  plan.tailFade = schedule.tailFade ?? null;
  plan.aUnfade = schedule.aUnfade ?? null;
  plan.stylePolicy = schedule.stylePolicy ?? null;
  plan.extensionPlan = schedule.extensionPlan ?? null;
  plan.extensionBuffer = undefined;
  if (schedule.extensionPlan && schedule.extensionPlan.source === 'a-tail') {
    const ext = schedule.extensionPlan;
    try {
      const src = plan.options.active.currentSrc || plan.options.active.src;
      const ctx = deckAudioContext(plan.options.active);
      if (src && ctx) {
        void renderExtensionBuffer({
          ctx, src,
          unitStartFileMs: ext.unitStartMs,
          unitMs: ext.unitMs,
          passes: ext.passes,
        }).then((buffer) => {
          if (buffer && plan.extensionPlan === ext) plan.extensionBuffer = buffer;
        }).catch(() => {});
      }
    } catch {
      /* 忽略：拿不到 buffer 就不延长，主过渡照常 */
    }
  }

  if (schedule.bridge) {
    // 提前抓 A 的字节：桥接点通常在过渡开始后几秒才到，那时只解码不下载。
    try {
      const src = plan.options.active.currentSrc || plan.options.active.src;
      const ctx = deckAudioContext(plan.options.active);
      const bridge = schedule.bridge;
      plan.bridgeBuffer = undefined;
      if (src && ctx) void renderBridgeBuffer({ctx,src,...bridge}).then(buffer => {
        if (buffer && plan.bridge === bridge) plan.bridgeBuffer = buffer;
      }).catch(() => {});
      else if (src) prefetchBridgeBytes(src);
    } catch {
      /* 忽略 */
    }
    logEvent('automix-v2-bridge-plan', schedule.bridge.note);
  }
  debug.structureActive = schedule.structure;
  debug.cueMode = schedule.cueMode;
  debug.phraseBars = schedule.phraseBars;
  debug.cueOutMs = schedule.cueOutMs;
  debug.cueInMs = schedule.cueInMs;
  debug.styleResolved = schedule.style;
  debug.bassHandoffP = schedule.bassHandoffP;
  debug.gainTrimDb = schedule.gainTrimDb;
}

/** 还没等到 loadedmetadata 的 B 起始 seek：过渡取消/重排时要撤掉，避免元素复用时旧监听改位置。 */
const pendingSeeks = new WeakMap<HTMLAudioElement, () => void>();

function cancelPendingSeek(element: HTMLAudioElement): void {
  const cancel = pendingSeeks.get(element);
  if (!cancel) return;
  pendingSeeks.delete(element);
  cancel();
}

/** seek 到指定文件秒数；元数据还没到时挂一次性 loadedmetadata 兜底。 */
function seekDeck(element: HTMLAudioElement, fileSeconds: number): boolean {
  const target = Math.max(0, fileSeconds);
  // 同一个 B 元素可能在上一次取消后还挂着旧监听，先撤掉再排新的。
  cancelPendingSeek(element);
  try {
    if (element.readyState >= 1) {
      if (Math.abs(element.currentTime - target) > 0.01) element.currentTime = target;
      return true;
    }
    const apply = (): void => {
      cancelPendingSeek(element);
      try {
        if (Math.abs(element.currentTime - target) > 0.01) element.currentTime = target;
      } catch {
        /* 忽略：已进入播放，位置由 preload 决定 */
      }
    };
    element.addEventListener('loadedmetadata', apply);
    pendingSeeks.set(element, () => element.removeEventListener('loadedmetadata', apply));
    return true;
  } catch (err) {
    logEvent('b-seek-failed', messageOf(err));
    return false;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let suppressOnce = false;

/** Shift+X：本次切歌跳过无缝过渡（一次性，不改设置）。 */
export function suppressNextCrossfade(): void {
  suppressOnce = true;
}

/**
 * 准备下一首的无缝衔接（异步分析完成后由 player 调用）。
 * 成功返回 true；失败/不适合返回 false（player 无需回滚，仍走原来的 ended 硬切）。
 */
export function prepareCrossfade(options: CrossfadePrepareOptions): boolean {
  cancelCrossfade('replaced');
  if (suppressOnce) {
    suppressOnce = false;
    logEvent('prepare-skip', '本次手动禁用无缝过渡（Shift+X）');
    return false;
  }
  const schedule = buildSchedule(options);
  if (!schedule) {
    logEvent('prepare-skip', '时长/鼓点条件不满足，回退硬切');
    return false;
  }
  if (!options.isValid()) {
    logEvent('prepare-skip', '准备已过期');
    return false;
  }
  try {
    options.standby.pause();
    // restoreLastPlayback 会把当前 deck 的 preload 改成 metadata；B 要尽快拿到数据。
    options.standby.preload = 'auto';
    options.standby.src = options.nextUrl;
  } catch (err) {
    logEvent('prepare-skip', `预加载失败：${messageOf(err)}`);
    return false;
  }
  // Web Audio 图已建立（EQ / 人声保留淡出 / 歌词页分析器）时走图内增益淡化：
  // 两个 deck 都接到 deckMix 上，淡化用各自 gain 做等功率曲线，主音量仍由本地 gain 控制。
  // 「交融」风格还需要低通/高通/低频架，元素音量路径做不到：图没建立时主动建一次。
  let graphMode = audioTapGraphActive();
  if (!graphMode) {
    // 「交融」需要低通/高通/低频架，元素音量做不到：借均衡器的建图入口把图建起来（并 resume），再挂 deck。
    ensureEqualizerGraph();
    graphMode = audioTapGraphActive();
    if (graphMode) logEvent('graph-auto', '为「交融」风格建立 Web Audio 图');
  }
  if (graphMode && (!attachDeckToGraph(options.active) || !attachDeckToGraph(options.standby))) {
    logEvent('prepare-skip', '无法把两个 deck 接入 Web Audio 图，回退硬切');
    return false;
  }
  if (graphMode) {
    setDeckGraphGain(options.active, 1);
    setDeckGraphGain(options.standby, 0);
    releaseDeckFx(options.active, 1);
    releaseDeckFx(options.standby, 0);
  }
  const plan: ActivePlan = {
    kind: 'auto',
    options,
    phase: 'prepared',
    graphMode,
    tempoRate: 1,
    handoff: false,
    am: false,
    lastVocalEndPosMs: 0,
    handoffHoldMs: 0,
    styleResolved: 'am',
    bassHandoffP: AM_BASS_HANDOFF_P,
    gainTrimDb: 0,
    phraseBars: 0,
    fadeStartFileMs: 0,
    fadeStartPosMs: 0,
    fadeMs: 0,
    bStartFileMs: 0,
    audibleEndPosMs: 0,
    triggerPosMs: 0,
    startedAt: 0,
    progress: 0,
    baseVolume: 0,
    raf: 0,
  };
  applySchedule(plan, schedule);
  // 交融用于「结构自适应过渡」且没走歌词衔接时：歌词衔接有自己的浮现曲线，手动/循环窗口太短。
  // 风格解析在 buildSchedule 里按调性/BPM 距离完成（auto → am/equal/cut）；图未建立时交融不可用。
  // 快速切入使用短自然曲线；仅显式交融使用扫频。
  plan.am = graphMode && schedule.style === 'am' && !plan.handoff;
  plan.styleResolved = graphMode ? schedule.style : schedule.style === 'cut' ? 'cut' : 'equal';
  if (graphMode) {
    // 响度对齐改成「每个 deck 各自补偿」：A 用当前曲的 LUFS、B 用下一首的 LUFS，
    // 过渡曲线里不再叠加 gainTrimDb，切歌提交时也就没有「全局增益换值 + trim 消失」的双重台阶。
    const currentDb = compensationDbFor(options.currentAnalysis.analysis.loudnessLufs, options.currentAnalysis.analysis.peakDb);
    const nextDb = compensationDbFor(options.nextAnalysis.analysis.loudnessLufs, options.nextAnalysis.analysis.peakDb);
    if (!plan.phraseMatch) setDeckTrimGain(options.active, currentDb ?? 0);
    setDeckTrimGain(options.standby, nextDb ?? 0);
    // Regional correction uses its own node and survives deck commit.
  }
  // 预先把 B 的速率与伴奏倾斜设置好：淡化开始时不用临时改，避免首帧爆音。
  const baseRate = baseDeckRate(options);
  setDeckPlaybackRate(options.standby, baseRate * (plan.tempoInverted ? 1 : plan.tempoRate));
  setDeckPlaybackRate(options.active, baseRate);
  if (graphMode) {
    setDeckGraphTilt(options.active, 0, 0);
    // 交融与歌词衔接都不用「人声/伴奏倾斜」这套搁架（前者靠滤波扫频，后者靠人声聚焦）。
    setDeckGraphTilt(options.standby, 0, 0);
  }
  seekDeck(options.standby, plan.bStartFileMs / 1000);
  activePlan = plan;
  debug.phase = 'prepared';
  if (plan.kind === 'auto') {
    const poll = (): void => {
      if (activePlan !== plan || plan.phase !== 'prepared') return;
      plan.raf = 0;
      crossfadeTick(Math.max(0, options.active.currentTime * 1000 - options.current.startAt * 1000), options.currentDurationMs);
      if (activePlan === plan && plan.phase === 'prepared') plan.raf = window.setTimeout(poll, 25);
    };
    plan.raf = window.setTimeout(poll, 25);
  }

  debug.reason = '';
  debug.currentTitle = options.current.track.title;
  debug.nextTitle = options.next.track.title;
  debug.crossfadeKind = 'auto';
  debug.amActive = plan.am;
  debug.nextPrepared = true;
  debug.progress = 0;
  debug.bedPlan = plan.extensionPlan ? `${(plan.extensionPlan.targetMs / 1000).toFixed(1)}s` : '';
  debug.baseVolume = clamp01(options.baseVolume());
  logEvent(
    'prepared',
    plan.am
      ? `「${options.current.track.title}」→「${options.next.track.title}」，交融 ${plan.fadeMs} ms（A 低通 20k→2.3k、B 高通 10k→20 Hz，75% 低频交接）`
      : plan.handoff
        ? `「${options.current.track.title}」→「${options.next.track.title}」，歌词衔接：A 末句 ${plan.lastVocalEndPosMs} ms 唱完${
            plan.handoffHoldMs > 0 ? `、先保留 ${plan.handoffHoldMs} ms 尾奏` : ''
          }接 B 首句，${plan.fadeMs} ms 人声缓慢浮现、伴奏渐入`
        : `「${options.current.track.title}」→「${options.next.track.title}」，${plan.fadeMs} ms 后在曲内 ${Math.round(plan.fadeStartPosMs)} ms 处淡化（可听结尾 ${plan.audibleEndPosMs} ms，尾部静音/渐弱 ${debug.tailSilenceMs} ms）`,
  );
  debug.advancedPreview = buildAdvancedPreview(options, plan);
  prefetchAdvancedWindows(options, plan);
  return true;
}

/**
 * 过渡前预热四轨窗口（T4-3）：进阶模式才有意义，失败也只是「这次不进阶」。
 * 用与 `beginTimeline` 完全相同的两个位置（`fadeStartPosMs` / `bStartFileMs`）算窗口，
 * 保证预热键和交接时查的键一致。
 */
/**
 * 预热键（容错版）：单测里 `advancedReadiness` 可能被桩成空对象，
 * 交接点不能因为这个抛错——键算不出来就当「没预热」，退回标准曲线。
 */
/** 用户手动选的手法：`auto` 返回 undefined，让规则自己决定。 */
function templateHint(): 'vocalFirst' | 'doubleDrop' | undefined {
  try {
    const picked = readMixTransitionTemplate();
    return picked === 'vocalFirst' || picked === 'doubleDrop' ? picked : undefined;
  } catch {
    return undefined;
  }
}

function stemKeyFor(track: OnlineTrack | null | undefined, positionSec: number): string {
  try {
    return typeof stemKeyOf === 'function' ? stemKeyOf(track, positionSec) : '';
  } catch {
    return '';
  }
}

/**
 * 进阶换手预案（T5-2）：试放台要看到「哪一小节换哪条轨」，所以在 prepare 时就把
 * 门控 + 模板 + 事件算成纯数据存进 debug。它**不参与音频**，算错只影响预览。
 */
function buildAdvancedPreview(options: CrossfadePrepareOptions, plan: ActivePlan): CrossfadeAdvancedPreview | null {
  try {
    if (typeof resolveTransition !== 'function' || typeof buildTimeline !== 'function') return null;
    const mode = effectiveMode();
    const resolved = resolveTransition({
      mode: mode === 'standard' ? 'standard' : 'advanced',
      analysisA: options.currentAnalysis.analysis,
      analysisB: options.nextAnalysis.analysis,
      positionMsA: plan.fadeStartPosMs,
    });
    const barMs = resolved.plan ? Math.max(1, resolved.plan.beatMs * 4) : 0;
    const totalMs = resolved.totalMs;
    const preview: CrossfadeAdvancedPreview = {
      mode,
      template: resolved.plan?.template ?? '',
      barMs,
      totalMs,
      summary: resolved.summary.slice(0, 6),
      blocks: [],
      emptyReason: '',
    };
    if (!resolved.plan || !resolved.events.length) {
      preview.emptyReason = resolved.summary[0] ?? '当前条件下没有分轨换手';
      return preview;
    }
    const model = buildTimeline(resolved.events, barMs, totalMs);
    preview.emptyReason = model.emptyReason ?? '';
    for (const lane of model.lanes) {
      for (const block of lane.blocks) {
        preview.blocks.push({
          kind: block.kind,
          deck: block.deck,
          stem: block.stem,
          x: block.x,
          width: block.width,
          label: block.label,
        });
      }
    }
    return preview;
  } catch (err) {
    console.warn('[preview] failed', err);
    return null;
  }
}

function prefetchAdvancedWindows(options: CrossfadePrepareOptions, plan: ActivePlan): void {
  try {
    const preview = debug.advancedPreview;
    // T6-5：门控判成 standard 时这一趟根本不会有分轨动作，预热纯属白烧 CPU/磁盘，
    // 也会把 stems=4 打到宿主上去。barMs 只有真算出 plan 时才会 > 0，用它当门。
    if (!preview || !(preview.barMs > 0)) return;
    if (effectiveMode() === 'standard') return;

    const spanSec = Math.max(0, preview.totalMs / 1000);
    const a = { track: options.current?.track, positionSec: plan.fadeStartPosMs / 1000 };
    const b = { track: options.next?.track, positionSec: plan.bStartFileMs / 1000 };

    // 第 13 轮：32 小节模板（128 BPM = 60 s）跨 2~3 个 30 s 窗口，必须整段预热，
    // 否则 begin() 会在过渡中途才去解码下一窗（那就等于静音）。
    if (typeof prefetchStemSpan === 'function') {
      void prefetchStemSpan(a, b, spanSec)
        .then((result) => {
          logEvent(
            'advanced-prefetch',
            result.aReady && result.bReady
              ? `四轨已预热 ${result.keysA.length + result.keysB.length} 窗（实算 ${result.computed}）`
              : `四轨预热未完成：${result.error}`,
          );
        })
        .catch(() => {
          /* 预热失败不影响播放 */
        });
      return;
    }
    if (typeof prefetchStemsForTransition !== 'function') return;
    void prefetchStemsForTransition(a, b)
      .then((result) => {
        logEvent(
          'advanced-prefetch',
          result.aReady && result.bReady
            ? `四轨已预热（本次实算 ${result.computed} 窗）`
            : `四轨预热未完成：${result.error}`,
        );
      })
      .catch(() => {
        /* 预热失败不影响播放 */
      });
  } catch {
    /* 预热永远不能影响播放 */
  }
}

/* ------------------------------------------------------------------ */
/* Phase 2：手动切歌与单曲循环的短过渡                                  */
/* ------------------------------------------------------------------ */

/**
 * 构造手动/单曲循环的过渡计划：B 从该段开头起播，不等节拍分析、不做 BPM 对齐。
 * 返回 null = 当前 deck 无法接入 / 状态已过期。
 */
function createManualPlan(options: ManualCrossfadeOptions, kind: 'manual' | 'loop'): ActivePlan | null {
  if (!options.isValid()) {
    logEvent('manual-skip', '准备已过期');
    return null;
  }
  try {
    options.standby.pause();
    options.standby.preload = 'auto';
    options.standby.src = options.nextUrl;
  } catch (err) {
    logEvent('manual-skip', `预加载失败：${messageOf(err)}`);
    return null;
  }
  const graphMode = audioTapGraphActive();
  if (graphMode && (!attachDeckToGraph(options.active) || !attachDeckToGraph(options.standby))) {
    logEvent('manual-skip', '无法把两个 deck 接入 Web Audio 图，回退硬切');
    return null;
  }
  if (graphMode) {
    setDeckGraphGain(options.active, 1);
    setDeckGraphGain(options.standby, 0);
    setDeckGraphTilt(options.active, 0, 0);
    setDeckGraphTilt(options.standby, 0, 0);
    releaseDeckFx(options.active, 1);
    releaseDeckFx(options.standby, 0);
  }
  const requested = Number.isFinite(options.fadeMs) ? options.fadeMs : MANUAL_FADE_DEFAULT_MS;
  const fadeMs = Math.round(Math.max(MANUAL_FADE_MIN_MS, Math.min(MANUAL_FADE_MAX_MS, requested)));
  const plan: ActivePlan = {
    kind,
    options,
    phase: 'prepared',
    graphMode,
    tempoRate: 1,
    handoff: false,
    am: false,
    lastVocalEndPosMs: 0,
    handoffHoldMs: 0,
    styleResolved: 'equal',
    bassHandoffP: 0,
    gainTrimDb: 0,
    phraseBars: 0,
    fadeStartFileMs: 0,
    fadeStartPosMs: Math.max(0, Math.round(options.currentPositionMs || 0)),
    fadeMs,
    bStartFileMs: Math.max(0, Math.round(options.nextStartFileMs || 0)),
    audibleEndPosMs: 0,
    triggerPosMs: Math.max(0, Math.round(options.triggerPosMs ?? 0)),
    startedAt: 0,
    progress: 0,
    baseVolume: clamp01(options.baseVolume()),
    raf: 0,
  };
  const baseRate = baseDeckRate(options);
  setDeckPlaybackRate(options.active, baseRate);
  setDeckPlaybackRate(options.standby, baseRate);
  seekDeck(options.standby, plan.bStartFileMs / 1000);
  activePlan = plan;
  debug.phase = 'prepared';
  debug.reason = '';
  debug.currentTitle = options.fromTitle;
  debug.nextTitle = options.nextTitle;
  debug.crossfadeKind = kind;
  debug.nextPrepared = true;
  debug.fadeStartPosMs = plan.fadeStartPosMs;
  debug.fadeMs = fadeMs;
  debug.bStartFileMs = plan.bStartFileMs;
  debug.tempoRate = 1;
  debug.tempoMatched = false;
  debug.tempoRateLive = 1;
  debug.pllActive = false;
  debug.pllRate = 1;
  debug.pllErrBeats = 0;
  debug.nextVocalStartMs = 0;
  debug.vocalAligned = false;
  debug.handoffActive = false;
  debug.lastVocalEndPosMs = 0;
  debug.handoffHoldMs = 0;
  debug.currentAudibleEndMs = 0;
  debug.tailSilenceMs = 0;
  debug.autoFadeMs = 0;
  debug.autoBars = 0;
  debug.autoBarMs = 0;
  debug.autoNote = kind === 'loop' ? '单曲循环：曲尾同曲淡入重启（不等节拍）' : '手动切歌：短过渡（不等节拍）';
  debug.progress = 0;
  debug.baseVolume = plan.baseVolume;
  logEvent(
    kind === 'loop' ? 'loop-prepared' : 'manual-prepared',
    `「${options.fromTitle}」→「${options.nextTitle}」，${fadeMs} ms 等功率短过渡（B 从文件 ${plan.bStartFileMs} ms 起播）`,
  );
  return plan;
}

/**
 * 手动切歌（next/prev/点列表）：立即开始 1.2–2.0 秒等功率交叉淡化。
 * 返回 false 表示无法走过渡，调用方应立即回退硬切。
 */
export function startManualCrossfade(options: ManualCrossfadeOptions): boolean {
  cancelCrossfade('replaced');
  const plan = createManualPlan(options, 'manual');
  if (!plan) return false;
  startManualFade(plan);
  return true;
}

/** 单曲循环：先准备好「曲尾淡出 → 同曲从 0 淡入」，tick 到点自动开始。返回 false = 不适合。 */
export function prepareLoopCrossfade(options: ManualCrossfadeOptions): boolean {
  cancelCrossfade('replaced');
  const plan = createManualPlan(options, 'loop');
  return plan !== null;
}

/** 立即开始手动/循环过渡：B 从起点起播，A 等功率淡出。 */
function startManualFade(plan: ActivePlan): void {
  if (plan.phase !== 'prepared' || activePlan !== plan) return;
  if (!plan.options.isValid()) {
    cancelCrossfade('stale');
    return;
  }
  if (!plan.graphMode && audioTapGraphActive()) {
    cancelCrossfade('graph-active');
    return;
  }
  const base = clamp01(plan.options.baseVolume());
  plan.phase = 'fading';
  plan.startedAt = performance.now();
  plan.progress = 0;
  plan.baseVolume = base;
  debug.phase = 'fading';
  debug.reason = '';
  debug.progress = 0;
  debug.baseVolume = base;
  debug.nextPrepared = false;
  if (plan.graphMode) {
    setAudioTapVolume(base, true);
    setDeckGraphGain(plan.options.active, 1);
    setDeckGraphGain(plan.options.standby, 0);
    setDeckGraphTilt(plan.options.active, 0, 0);
    setDeckGraphTilt(plan.options.standby, 0, 0);
    setDeckGraphVocalFocus(plan.options.active, 0);
    setDeckGraphVocalFocus(plan.options.standby, 0);
  } else {
    setDeckVolume(plan.options.active, base);
    setDeckVolume(plan.options.standby, 0);
  }
  setDeckPlaybackRate(plan.options.standby, baseDeckRate(plan.options));
  if (!seekDeck(plan.options.standby, plan.bStartFileMs / 1000)) {
    failManualFade(plan, 'b-seek-failed');
    return;
  }
  logEvent(
    plan.kind === 'loop' ? 'loop-fade-start' : 'manual-fade-start',
    `B 从文件 ${Math.round(plan.bStartFileMs)} ms 起播，等功率 ${plan.fadeMs} ms`,
  );
  plan.raf = window.setTimeout(() => {
    if (activePlan !== plan || plan.timelineReady) return;
    if (plan.kind === 'auto') cancelCrossfade('b-start-timeout');
    else failManualFade(plan, 'b-start-timeout');
  }, 5000);
  plan.options.standby.play().then(
    () => {
      if (activePlan !== plan || plan.phase !== 'fading') return;
      beginTimeline(plan);
      if (activePlan !== plan) return;
      if (!plan.v2 && !plan.cleanPickup) notifyStart(plan);
      plan.raf = window.setTimeout(fadeStep, 25);
    },
    (err: unknown) => {
      if (activePlan !== plan) return;
      logEvent('b-play-failed', messageOf(err));
      failManualFade(plan, 'b-play-failed');
    },
  );
}

/** 手动/循环过渡失败：恢复 A 的音量与速率，通知 player 回退硬切。 */
function failManualFade(plan: ActivePlan, reason: string): void {
  if (activePlan !== plan) return;
  plan.cleanup?.();
  cancelPendingSeek(plan.options.standby);
  if (plan.raf) {
    window.clearTimeout(plan.raf);
    plan.raf = 0;
  }
  const base = clamp01(plan.options.baseVolume());
  const rate = baseDeckRate(plan.options);
  if (plan.graphMode) {
    setAudioTapVolume(base, true);
    setDeckGraphGain(plan.options.active, 1);
    setDeckGraphGain(plan.options.standby, 0);
    setDeckGraphTilt(plan.options.active, 0, 0);
    setDeckGraphVocalFocus(plan.options.active, 0);
    setDeckGraphVocalFocus(plan.options.standby, 0);
    detachDeckFromGraph(plan.options.standby);
  } else {
    setDeckVolume(plan.options.active, base);
    setDeckVolume(plan.options.standby, 0);
  }
  setDeckPlaybackRate(plan.options.active, rate);
  setDeckPlaybackRate(plan.options.standby, rate);
  try {
    plan.options.standby.pause();
  } catch {
    /* 忽略 */
  }
  activePlan = null;
  debug.phase = 'canceled';
  debug.amActive = false;
  debug.reason = reason;
  debug.progress = 0;
  debug.nextPrepared = false;
  logEvent('manual-cancel', reason);
  const onFail = (plan.options as ManualCrossfadeOptions).onFail;
  if (onFail) {
    try {
      onFail(reason);
    } catch (err) {
      console.warn('[crossfade] onFail failed', err);
    }
  }
}

/** tick 里调用：到点就起播 B 并开始淡化。 */
export function crossfadeTick(positionMs: number, durationMs: number): void {
  const plan = activePlan;
  if (!plan || plan.phase !== 'prepared' || plan.options.active.paused) return;
  if (!plan.options.isValid()) {
    cancelCrossfade('stale');
    return;
  }
  if (!plan.graphMode && audioTapGraphActive()) {
    // 图在准备之后才建立（用户中途开了 EQ / 人声保留淡出）：放弃本次衔接，回退硬切。
    cancelCrossfade('graph-active');
    return;
  }
  if (plan.kind !== 'auto') {
    // 单曲循环：曲尾前 fadeMs 处开始，B 从该段开头淡入（不做节拍分析）。
    // 手动切歌的计划在 startManualCrossfade 里已立即开始，不会以 prepared 状态被 tick 到。
    const rate = baseDeckRate(plan.options);
    let trigger = plan.triggerPosMs;
    if (plan.kind === 'loop') {
      if (!(durationMs > 0)) return; // 时长未知：等元数据 / ended 兜底
      trigger = Math.max(0, durationMs - plan.fadeMs * rate);
    }
    if (positionMs + TRIGGER_LEAD_MS < trigger) return;
    startManualFade(plan);
    return;
  }
  const autoOptions = plan.options as CrossfadePrepareOptions;
  // 实际时长和准备时差太多（元数据后到 / CUE 边界）：重建时间表，建不出来就放弃。
  if (durationMs > 0 && Math.abs(durationMs - autoOptions.currentDurationMs) > 500) {
    const updated = buildSchedule({ ...autoOptions, currentDurationMs: durationMs, currentPositionMs: positionMs });
    if (!updated) {
      cancelCrossfade('reschedule');
      return;
    }
    autoOptions.currentDurationMs = durationMs;
    applySchedule(plan, updated);
  }
  const past = positionMs - plan.fadeStartPosMs;
  if (past > MISS_TOLERANCE_MS) {
    cancelCrossfade('missed');
    return;
  }
  // task-22：剩余可淡化时间按「可听结尾」计算（尾部静音不计入），允许 +200ms 终点容差。
  const effectiveEnd = plan.audibleEndPosMs > 0 ? plan.audibleEndPosMs : durationMs;
  const remaining = effectiveEnd > 0 ? effectiveEnd + 200 - positionMs : plan.fadeMs - past;
  if (remaining < MIN_FADE_MS - 200) {
    cancelCrossfade('too-late');
    return;
  }
  if (past < -TRIGGER_LEAD_MS) return;
  if (past > 0) logEvent('late-start', `晚了 ${Math.round(past)} ms，起播成功后按剩余时间缩短淡化`);
  startFade(plan);
}

/** 过渡开始的对外通知（B 已起播）：让界面提前切到下一首，deck 交换仍等 onFinish。 */
function notifyStart(plan: ActivePlan): void {
  if (!plan.options.onStart) return;
  try {
    plan.options.onStart();
  } catch (err) {
    console.warn('[crossfade] onStart failed', err);
  }
}

/** 收尾进阶交接：幂等，任何异常都吞掉（收尾阶段不能因为拆图失败卡住）。 */
function disposeAdvanced(plan: ActivePlan): void {
  const handoff = plan.advanced;
  if (!handoff) return;
  plan.advanced = null;
  try {
    handoff.dispose();
  } catch (err) {
    console.warn('[crossfade] 进阶交接收尾失败', err);
  }
}

function startFade(plan: ActivePlan): void {
  if (plan.phase !== 'prepared') return;
  if (plan.raf) window.clearTimeout(plan.raf);
  plan.raf = 0;
  if (!plan.graphMode && audioTapGraphActive()) {
    cancelCrossfade('graph-active');
    return;
  }
  const base = clamp01(plan.options.baseVolume());
  plan.phase = 'fading';
  plan.startedAt = performance.now();
  plan.progress = 0;
  plan.baseVolume = base;
  debug.phase = 'fading';
  debug.reason = '';
  debug.progress = 0;
  debug.baseVolume = base;
  debug.amActive = plan.am;
  if (plan.graphMode) {
    // 图内淡化：主音量走本地 gain（元素音量固定 1），A/B 各自由 deck gain 控制。
    setAudioTapVolume(base, true);
    // 先把上一次过渡可能留下的自动化撤干净，再按本次风格重新起步。
    releaseDeckFx(plan.options.active, 1);
    releaseDeckFx(plan.options.standby, 0);
    setDeckGraphTilt(plan.options.active, 0, 0);
    setDeckGraphTilt(plan.options.standby, 0, 0);
    setDeckGraphVocalFocus(plan.options.active, 0);
    setDeckGraphVocalFocus(plan.options.standby, 0);
  } else {
    setDeckVolume(plan.options.active, base);
    setDeckVolume(plan.options.standby, 0);
  }
  // 准备期间 player 可能重设过 deck 属性，起播前再确保一次 WSOLA 速率与用户倍速。
  const startBaseRate = baseDeckRate(plan.options);
  setDeckPlaybackRate(plan.options.active, startBaseRate);
  setDeckPlaybackRate(plan.options.standby, startBaseRate * plan.tempoRate);
  if (!seekDeck(plan.options.standby, plan.bStartFileMs / 1000)) {
    cancelCrossfade('b-seek-failed');
    return;
  }
  logEvent(
    'fade-start',
    `B 从文件 ${Math.round(plan.bStartFileMs)} ms 起播，${plan.am ? '交融' : '等功率'} ${plan.fadeMs} ms`,
  );
  plan.raf = window.setTimeout(() => {
    if (activePlan !== plan || plan.timelineReady) return;
    if (plan.kind === 'auto') cancelCrossfade('b-start-timeout');
    else failManualFade(plan, 'b-start-timeout');
  }, 5000);
  plan.options.standby.play().then(
    () => {
      if (activePlan !== plan || plan.phase !== 'fading') return;
      beginTimeline(plan);
      if (activePlan !== plan) return;
      if (!plan.v2 && !plan.cleanPickup) notifyStart(plan);
      plan.raf = window.setTimeout(fadeStep, 25);
    },
    (err: unknown) => {
      if (activePlan !== plan) return;
      logEvent('b-play-failed', messageOf(err));
      cancelCrossfade('b-play-failed');
    },
  );
}

/**
 * E8 结构桥接的执行：把 A 的尾段预渲染成 buffer，在循环点那一刻由 buffer 接管。
 *
 * 渲染来不及、失败、或循环点已经过去 —— 一律什么都不做：A 照常在原可听结尾结束，
 * 只是延长出去的那一段只剩 B（不会爆音、不会卡住）。
 */
/**
 * B 侧前奏桥：元素先按住，由预渲染 buffer 顶住 `delayMs`，到点再 resume。
 *
 * 为什么必须用 buffer：`HTMLMediaElement` 从 0 起播要解码器预热，`currentTime` 回跳还有
 * 20–40 ms 空洞；而这里要的是「同一小节的第二遍」，回跳就等于在小节线上劈了一刀。
 *
 * 失败（渲染超时/元素不可控）时不动元素 —— 退回「前奏照播一次」的老行为，不会静音。
 */

/**
 * 过渡混响参数（可通过 localStorage 调，无需重新构建）。
 *
 * 默认值依据：送出 −8 dB（约 40%）、返回 −2 dB、从换手窗口 55% 处开始送、
 * IR 1.6 s（−60 dB）。这组能让尾巴在 A 消失后还留 0.6 s，但不会盖住 B 的第一击。
 */
interface ReverbOptions { sendDb: number; returnDb: number; fromP: number; tailMs: number }

/**
 * 我们的手法 → Apple Smart Transitions 风格 id（逆向自 TransitionStyles.json）。
 *
 * 只映射「同一套动作」的：低频换手/等功率 → 1；滤波扫频 → 8（长）/5（短）；延迟收尾 → 16（流行）/15（嘻哈）；
 * 混响收尾 → 20；硬切 → 0；splice/叠播类 → 22。
 * 没列出的（loopRoll / doubling / backspin / halfTime）是 AURemixFX 专有原语，Apple 用 `remixfx_*` 参数，
 * 我们用自己的 buffer 原语实现，不套配方。
 */
const APPLE_RECIPE_BY_STYLE: Partial<Record<TransitionStyleId, number>> = {
  bassSwap: 1,
  eqSwap: 1,
  filterSweep: 8,
  echoOut: 16,
  reverbOut: 20,
  longBlend: 1,
  cut: 0,
  slam: 22,
  dropSwap: 22,
  doubleDrop: 22,
  acapellaOverlay: 1,
  keyLift: 19,
};

function readReverbOptions(): ReverbOptions {
  // 尾段混响收短：1600 ms 的尾巴会把两首歌的残响叠在一起，听感「拖」；
  // 900 ms 只够把 A 的最后一口气送出去，不跨进 B 的第一句。
  const fallback: ReverbOptions = { sendDb: -12, returnDb: 6, fromP: 0.5, tailMs: 900 };
  try {
    const raw = window.localStorage.getItem('zilux2.dev.reverb');
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ReverbOptions>;
    const clamp = (v: unknown, lo: number, hi: number, def: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
    return {
      sendDb: clamp(parsed.sendDb, -24, 0, fallback.sendDb),
      returnDb: clamp(parsed.returnDb, -18, 3, fallback.returnDb),
      fromP: clamp(parsed.fromP, 0.5, 0.95, fallback.fromP),
      tailMs: clamp(parsed.tailMs, 300, 4000, fallback.tailMs),
    };
  } catch {
    return fallback;
  }
}


/**
 * 计划曲线的能量包络（每个采样点的功率增益）。
 * 低频支路与高频支路各占一半，起点归一到 1 —— 直接喂给质量门的 `weights: 'plan'`。
 */
/**
 * 分频段的能量占比：低频支路（≤120Hz）在整段能量里占多少。
 *
 * 不能一律按 0.5/0.5 拆 —— 流行歌的能量大部分在 120 Hz 以上（人声、鼓、吉他），
 * 按等分算会把「低频通过」当成「只有一半能量通过」，中段凭空算出 6 dB 的洞
 * （round 7 那对 6.12 LU / filterSweep / p=0.62 就是这么来的）。
 * 用 `activity.bass` 的均值当低频占比，同时夹到 0.15–0.85 防止极端值把模型带偏。
 */
/**
 * A 的母带渐隐落在窗口内时，把低频换手挪到渐隐**之前**。
 *
 * round 7 最差那对（6.12 LU / filterSweep / p=0.62）就是这个问题：A 在窗口后段做母带
 * 渐隐（−9 → −31 LUFS），而低频还压到 0.78 才换手 —— A 已经虚了，B 的贝斯还没进来。
 * 换手点跟着渐隐起点走，A 在还有气的电平上交棒。
 */
function tailFadeHandoffP(fade: { fadeStartMs: number; dropDb: number } | null | undefined,
  fadeStartFile: number, fadeMs: number): number | undefined {
  if (!fade || !(fade.dropDb >= 6)) return undefined;
  const p = (fade.fadeStartMs - fadeStartFile) / Math.max(1, fadeMs);
  if (!(p > 0.08 && p < 0.95)) return undefined;
  return Math.min(0.7, Math.max(0.05, p - 0.05));
}

function lowShareOf(analysis: BeatAnalysis, startMs: number, lengthMs: number): number {
  const curve = analysis.activity;
  if (!curve || !Array.isArray(curve.bass) || curve.bass.length < 2) return 0.4;
  const hop = curve.hopMs > 0 ? curve.hopMs : 250;
  const from = Math.max(0, Math.floor(startMs / hop));
  const to = Math.min(curve.bass.length - 1, Math.ceil((startMs + lengthMs) / hop));
  let sum = 0;
  let n = 0;
  for (let i = from; i <= to; i += 1) { sum += curve.bass[i]; n += 1; }
  const share = n > 0 ? sum / n : 0.4;
  return Math.min(0.85, Math.max(0.15, share));
}

/**
 * 把计划曲线折成"这条轨实际有多少能量在响"。
 *
 * 低频是相关信号：两条支路按**幅度**相加（`lowA + lowB = 1` 才不轰不空）；
 * 高频不相关：按**功率**相加（`cos²+sin²=1`）。所以 A 的包络不能写成 `(low²+high²)/2`，
 * 必须按各自频段的能量占比加权：`low² × lowShare + high² × (1 − lowShare)`。
 */
function planEnvOf(curves: V2Plan, side: 'a' | 'b', lowShare: number, midShare = 0.35): number[] {
  const steps = 21;
  const deck = side === 'a' ? curves.a : curves.b;
  const at = (arr: { t: number; v: number }[], p: number): number => {
    if (!arr.length) return 0;
    const i = Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))));
    return arr[i].v;
  };
  const out: number[] = [];
  // 三层各自独立换手：mid（120–1200 Hz）的窗口和高频不同，把它算进 high 会把
  // 「乐器主体还在、镲片先走」误判成响度塌洞。按各层能量占比加权才是链路真实电平。
  const mid = Math.max(0, Math.min(1 - lowShare, midShare));
  const hiShare = Math.max(0, 1 - lowShare - mid);
  for (let i = 0; i < steps; i += 1) {
    const p = i / (steps - 1);
    const lo = at(deck.low, p);
    const md = at(deck.mid, p);
    const hi = at(deck.high, p);
    out.push(lo * lo * lowShare + md * md * mid + hi * hi * hiShare);
  }
  return out;
}

/**
 * 用 v2 计划的真实曲线重算质量门。
 *
 * 规划期第一次调用（`evaluateQualityReport`）还不知道最终 `swapShare` / 扫频目标，
 * 只能拿宽带保守模型估；这里补一次「按实际链路」的复核，让汇总数字等于耳朵听到的。
 */
function qualityWithCurves(
  base: Omit<QualityInput, 'weights' | 'aEnv' | 'bEnv'>,
  curves: V2Plan,
  shares?: { a?: number; b?: number },
  trimCapDb = 4.5,
): QualityReport {
  const withPlan = {
    ...base,
    handoffStartP: curves.handoffStartP,
    handoffEndP: curves.handoffP,
    weights: 'plan' as const,
    aEnv: planEnvOf(curves, 'a', shares?.a ?? 0.4),
    bEnv: planEnvOf(curves, 'b', shares?.b ?? 0.4),
  };
  // 两遍：先量出原始曲线，再由它推补平量，最后按「补过之后」的能量重算。
  //   单遍会把链路里那条 `loudnessTrim` 当作不存在，指标永远追不上耳朵。
  const raw = evaluateQualityReport(withPlan);
  const trim = loudnessTrimCurve(loudnessRampCurve(withPlan), trimCapDb);
  if (trim.db.length < 3 || Math.max(...trim.db) < 0.25) return raw;
  return evaluateQualityReport({ ...withPlan, trimCurve: trim });
}

function startSplitMix(plan: ActivePlan, clock: number): boolean {
  const {active,standby} = plan.options;
  if (active === standby) return false;
  // 分频链初始静音，只有真正调度换手曲线时才接管元素。
  const a = ensureAutomixV2Deck(active);
  if (!a) return false;
  const b = ensureAutomixV2Deck(standby);
  if (!b) { a.dispose(); return false; }
  const options = plan.options as CrossfadePrepareOptions;
  const bar = barIntervalOf(options.currentAnalysis.analysis) / baseDeckRate(options);
  const baseSwap = Math.min(6000, Math.max(1800, 2 * bar));
  // 关键：A 唱到哪，换手就推到哪之后。
  //   holdMs = A 最后一句在窗口内占掉的时长；尾巴 tailMs 才是「允许两首一起响」的空间。
  //   A 一路唱到结尾时 tailMs→0，换手压到最后 ~1.8 s —— A 的末句不被垫住，
  //   这就是「唱到结束也不该把衔接方式抵消掉」。
  const lastWordAbs = options.current.startAt * 1000 + Math.max(0, plan.lastVocalEndPosMs ?? 0);
  const holdMs = plan.lastVocalEndPosMs && plan.lastVocalEndPosMs > 0
    ? Math.max(0, Math.min(plan.fadeMs, lastWordAbs - plan.fadeStartFileMs)) : 0;
  const tailMs = Math.max(0, plan.fadeMs - holdMs);
  // 用 min 而不是 max：换手只在「A 末句之后剩下的空间」里做，且不超过基准时长。
  //   尾巴很长（A 的末句远早于窗口结尾）→ 仍然是短换手（baseSwap），B 不会提早；
  //   尾巴很短（A 唱到结尾）→ 交换压进这几百毫秒里，A 的末句不被垫住。
  const styleParams = plan.styleParams;
  // dropSwap / doubleDrop 的换手比例来自落点求解（不跟 styleKit 的通用值走）。
  if (plan.dropEntry?.enabled && plan.dropEntry.tailHoldMs > 0) {
    plan.aTailBleedMs = Math.max(plan.aTailBleedMs ?? 0, plan.dropEntry.tailHoldMs);
    plan.aTailHold = Math.max(plan.aTailHold ?? 0, 0.3);
  }
  const styleSwap = Number.isFinite(plan.dropEntry?.swapShare ?? NaN)
    ? Math.max(0.06, Math.min(0.9, plan.dropEntry?.swapShare as number))
    : Number.isFinite(styleParams?.swapShare ?? NaN)
      ? Math.max(0.06, Math.min(0.9, styleParams?.swapShare as number))
      : null;
  // 手法给的比例是「这类过渡通常把换手压多窄」；仍然要受 A 末句的尾巴约束（tailMs），
  //   否则 bassSwap 的 0.25 会把 A 的末句垫掉。
  const baseShare = Math.max(
    0.08,
    Math.min(1, Math.min(styleSwap !== null ? Math.max(1_800, styleSwap * plan.fadeMs) : baseSwap, tailMs) / plan.fadeMs),
  );
  // 换手不钉在固定百分比上：在理想位置前后一个乐句内，挑「两边拍点最合 + B 的鼓最实」的那一拍。
  //   评分 = 0.6 ×（1 − 相位误差/半拍） + 0.4 × B 在该处的鼓活动度。
  //   这样「在哪里加入下一首的声音」是跟着节拍走的，不是死板的时间比例。
  const curA = options.currentAnalysis.analysis;
  const nextA = options.nextAnalysis.analysis;
  const beatB = beatIntervalOf(nextA) || beatIntervalOf(curA) || 500;
  const idealA = plan.fadeStartFileMs + (1 - baseShare) * plan.fadeMs;
  const beatsA = (curA.beatsMs ?? []).filter((t) => Number.isFinite(t));
  const beatsB = (nextA.beatsMs ?? []).filter((t) => Number.isFinite(t));
  let swapShare = baseShare;
  if (beatsA.length > 0 && beatsB.length > 0) {
    const bAt = (tA: number): number => plan.bStartFileMs + (tA - plan.fadeStartFileMs) * plan.tempoRate;
    const drumB = (ms: number): number => {
      const act = nextA.activity;
      if (!act || !(act.hopMs > 0)) return 0;
      const i = Math.floor(ms / act.hopMs);
      return i >= 0 && i < act.drum.length && Number.isFinite(act.drum[i]) ? act.drum[i] : 0;
    };
    const nearestB = (ms: number): number => {
      let best = Infinity;
      for (const t of beatsB) { const d = Math.abs(t - ms); if (d < best) best = d; }
      return best;
    };
    const window = Math.max(bar * 2, 1500);
    let bestScore = -Infinity;
    for (const tA of beatsA) {
      if (tA < plan.fadeStartFileMs + plan.fadeMs * 0.3) continue;
      if (tA > plan.fadeStartFileMs + plan.fadeMs - 300) continue;
      if (Math.abs(tA - idealA) > window) continue;
      const err = nearestB(bAt(tA)) / (beatB * 0.5);
      const score = 0.6 * (1 - Math.min(1, err)) + 0.4 * drumB(bAt(tA));
      if (score > bestScore) {
        bestScore = score;
        swapShare = Math.max(0.06, Math.min(0.9, (plan.fadeStartFileMs + plan.fadeMs - tA) / plan.fadeMs));
      }
    }
    if (Number.isFinite(bestScore)) {
      logEvent('automix-v2-beat-swap', `换手对齐到拍点 ${Math.round(idealA)}→${Math.round(plan.fadeStartFileMs + plan.fadeMs * (1 - swapShare))}ms（配合度 ${(bestScore * 100).toFixed(0)}%）`);
    }
  }
  const styleTail = Number.isFinite(styleParams?.tailHold ?? NaN)
    ? Math.max(0, Math.min(0.4, styleParams?.tailHold as number)) : 0;
  const aTailHold = plan.aTailBleedMs && plan.aTailBleedMs > 0
    ? Math.max(0.22, plan.aTailHold ?? 0, styleTail) : 0;
  // sweepShare === 0 的手法（bassSwap 的紧凑版、硬切类）不做扫频：扫频会暴露处理痕迹。
  const styleSweep = styleParams?.sweepShare === 0 ? false : true;
  // Apple 配方：out_gain 的下降窗就是「A 让位的宽度」，lp/hp 的时间窗就是扫频窗。
  const apple = applePlanFor(plan.styleId ? APPLE_RECIPE_BY_STYLE[plan.styleId] : undefined);
  const appleShare = apple ? Math.max(0.06, Math.min(0.9, Math.max(0.06, apple.aGoneP - apple.swapStartP))) : null;
  const finalShare = appleShare !== null ? Math.min(swapShare, appleShare) : swapShare;
  if (apple) {
    logEvent('automix-v2-apple-recipe', `套 Apple 配方 ${apple.id}「${apple.name}」（${apple.bars || '—'} 小节，A 在 ${(apple.swapStartP * 100).toFixed(0)}% 起让、${(apple.aGoneP * 100).toFixed(0)}% 让完）`);
  }
  // 配方给的目标频率也要用上：风格 8 要 A 压到 200 Hz、风格 16 要 B 从 5.2 kHz 起，
  // 硬编码的 700 Hz / 12 kHz 会让「A 退不干净、B 进得太亮」。
  const appleLpMin = apple?.aLp && apple.aLp.toHz >= 120 && apple.aLp.toHz <= 12_000 ? apple.aLp.toHz : undefined;
  const appleBStart = apple?.bHp && apple.bHp.fromHz >= 1_500 && apple.bHp.fromHz <= 20_000 ? apple.bHp.fromHz : undefined;
  const styleWindowScale = plan.stylePolicy?.windowScale;
  const styleSwapBias = plan.stylePolicy?.swapShareBias;
  const styleDuckScale = plan.stylePolicy?.duckScale;
  const curves = buildV2Plan({fadeMs:plan.fadeMs,barMs:bar,rate:plan.tempoRate,
    vocalAt: snapVocalAt(nextA.downbeats, plan.fadeStartFileMs, plan.fadeMs, bar),
    swapShare:finalShare,bEntry:true,aTailHold,sweep:styleSweep,sweepShare:styleParams?.sweepShare,
    windowScale: styleWindowScale,
    swapShareBias: styleSwapBias,
    duckScale: styleDuckScale,
    sweepStartP: apple?.aLp ? apple.aLp.t0 : undefined,
    sweepEndP: apple?.aLp ? apple.aLp.t1 : undefined,
    lpMinHz: appleLpMin,
    bHpStartHz: appleBStart,
    handoffStartP: tailFadeHandoffP(plan.tailFade, plan.fadeStartFileMs, plan.fadeMs)});
  plan.v2 = {a,b,plan:curves,stopped:false};
  plan.v2Plan = curves;
  // 质量门用**真实计划曲线**重算一遍：规划期那次调用还不知道最终 swapShare / 扫频目标，
  // 只能拿宽带保守模型估。这里把 `low/high` 的能量包络喂进去，汇总的 drift 才等于耳朵听到的。（round 6）
  if (plan.quality) {
    try {
      const ENV_STEPS = 21;
      // 低频不是「半个能量」：按各轨自己的 bass 占比加权，否则中段会被算成塌洞。（round 8 只改了规划期，这里漏了）
      // `envOf` 原来写死 `(lo²+hi²)/2`，与 `planEnvOf` 两套口径 —— 同一对歌规划期报 X、运行时报 Y。
      const envOf = (c: typeof curves.a, lowShare: number): number[] => {
        const at = (arr: { t: number; v: number }[], p: number): number => {
          if (!arr.length) return 0;
          const i = Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))));
          return arr[i].v;
        };
        const out: number[] = [];
        for (let i = 0; i < ENV_STEPS; i += 1) {
          const p = i / (ENV_STEPS - 1);
          const lo = at(c.low, p);
          const hi = at(c.high, p);
          const share = Math.min(0.85, Math.max(0.15, lowShare));
          out.push(lo * lo * share + hi * hi * (1 - share));
        }
        return out;
      };
      plan.quality = evaluateQualityReport({
        a: curA, b: nextA,
        fadeStartAMs: plan.fadeStartFileMs, fadeStartBMs: plan.bStartFileMs,
        fadeMs: plan.fadeMs, beatMs: bar / 4,
        tempoRate: plan.tempoRate,
        handoffStartP: curves.handoffStartP, handoffEndP: curves.handoffP,
        gainTrimDb: plan.gainTrimDb,
        aInstrumental: vocalPresence(curA) === 'instrumental',
        keyGap: camelotGap(curA.camelot, nextA.camelot),
        swapShare: finalShare,
        weights: 'plan',
        aEnv: envOf(curves.a, lowShareOf(curA, plan.fadeStartFileMs, plan.fadeMs)),
        bEnv: envOf(curves.b, lowShareOf(nextA, plan.bStartFileMs, plan.fadeMs * plan.tempoRate)),
        // 没有唱词交接（handoff=false）= B 一开播就唱，链路会给 B 做入场让位。
        bEntryDucked: !plan.handoff || (plan.bDuck?.length ?? 0) > 0,
      });
      if (plan.scheduleRef) plan.scheduleRef.quality = plan.quality;
    } catch { /* 质量门是诊断，不该挡住过渡 */ }
  }
  // 排程时间轴必须和 `fadeStep` 判完成用的那条一致。
  //
  // `fadeStep` 用 `plan.fadeWallMs`（曲内时长 /(用户倍速 × 实际消耗速率)）算进度，
  // 这里以前一律拿 `plan.fadeMs/1000` —— 把曲内毫秒当墙钟秒。倍速 ≠ 1 时曲线比
  // 进度长（或短），进度先到 1 就 `releaseSplitMix()` + `tap.restore()` 摘链，
  // 曲线上还剩着没走完的扫频/压音/风格 EQ，被 0 时长旁路一次性弹回 ——
  // 听感就是「过渡完成的一瞬间，之前被压下去的高音突然回来」。
  const mixSec = Math.max(0.2, (plan.fadeWallMs && plan.fadeWallMs > 0 ? plan.fadeWallMs : plan.fadeMs) / 1000);
  // `offsetMs` 类事件是曲内毫秒 → 墙钟秒的换算系数（= 1 /(倍速 × 消耗速率)）。
  const musicToWall = mixSec / Math.max(0.001, plan.fadeMs / 1000);
  scheduleAutomixV2(a,clock,mixSec,curves.a);
  scheduleAutomixV2(b,clock,mixSec,curves.b);
  // 分频点：规划期按两边低频相关性算，运行期只挪一次（不随帧改）。
  if (plan.splitHz && Number.isFinite(plan.splitHz)) {
    setCrossoverHz(a, plan.splitHz);
    setCrossoverHz(b, plan.splitHz);
    // 低频反相时把 B 的低频整体翻 180°，否则线性换手是「越换越薄」。
    setLowPolarity(b, plan.lowInvert === true);
    logEvent('automix-v2-split', `分频点 ${Math.round(plan.splitHz)} Hz（低频相关性自适应）`);
  }
  // B 侧电平包络：只抬 B、不动 A。A 还满电平的时候抬起来会被掩蔽，
  // 等 B 的鼓/人声进来包络自己回 0，不会「过渡完突然变大」。
  if (plan.bTrim && plan.bTrim.length > 1) {
    const wallMs = Math.max(200, plan.fadeWallMs ?? plan.fadeMs);
    scheduleAutomixV2BTrim(b, clock, plan.bTrim.map((db, i) => ({
      offsetMs: (i / (plan.bTrim!.length - 1)) * wallMs,
      db,
    })));
  }
  // 风格 EQ：A/B 各自的固定补偿（高频空气感、presence、B 的低频厚度），
  // 30% 到目标、末 15% 回 0 —— 与契约里的过渡补偿同一条规则，避免进歌后音色突变。
  if (plan.stylePolicy?.eq) {
    // 风格 EQ 不许在过渡一开始就改 A：A 在 80% 之前保持原样。
    // B 从 30%（低频进入）开始补偿，A 只留最后 20% 的一半量，避免「一进过渡旧歌就变味」。
    const eq = plan.stylePolicy.eq;
    scheduleAutomixV2Style(b, clock + mixSec * 0.3, mixSec * 0.7, { ...eq, side: 'b' });
    scheduleAutomixV2Style(a, clock + mixSec * 0.8, mixSec * 0.2, {
      ...eq,
      side: 'a',
      aHighDb: (eq.aHighDb ?? 0) * 0.5,
      aPresenceDb: (eq.aPresenceDb ?? 0) * 0.5,
    });
  }
  // 响度补平：规划期算出的窗口内合成响度曲线（`quality.curve`，等距 39 点）。
  // 中段塌陷多来自「A 尾奏在掉 + B 前奏还轻」，按曲线补 0–3 dB 就能把 1.5–2.9 LU 的坑抹平。
  // 只抬不降；整窗最大补偿 < 0.25 dB 时不排，省一条自动化曲线。
  const trimCurve = plan.quality?.curve ? loudnessTrimCurve(plan.quality.curve, plan.loudTrimCapDb ?? 4.5) : null;
  if (trimCurve && trimCurve.db.length > 2 && Math.max(...trimCurve.db) >= 0.25) {
    scheduleLoudnessTrim(
      a,
      clock,
      mixSec,
      trimCurve.db.map((db, i: number) => ({ p: trimCurve.ps[i] ?? i / (trimCurve.db.length - 1), db })),
    );
    logEvent('automix-v2-loudtrim', `响度补平 ≤${Math.max(...trimCurve.db).toFixed(1)} dB（${trimCurve.db.length} 点）`);
  }
  setDeckGraphGain(active,1);
  setDeckGraphGain(standby,1);
  // 手法可以要求更浅/更深的让位（默认 −6 dB）：按比例缩放，不改变曲线的相对形状。
  const baseDuckScale = Number.isFinite(styleParams?.duckDb ?? NaN)
    ? Math.max(0, Math.min(1, Math.abs(styleParams?.duckDb as number) / 6)) : 1;
  const duckScale = Math.max(0, Math.min(1.2, baseDuckScale * (plan.stylePolicy?.duckScale ?? 1)));
  if (plan.v2Duck?.length) {
    scheduleAutomixV2Duck(a, plan.v2Duck.map((e) => ({ atSec: clock + (e.offsetMs / 1000) * musicToWall, db: Math.max(-15, e.db * duckScale) })), clock + mixSec);
    logEvent('automix-v2-duck', `A 在 B 唱句处让位 ${Math.abs(Math.min(...plan.v2Duck.map((e) => e.db))).toFixed(1)} dB（${plan.v2Duck.length} 点）`);
  }
  // B 的让位只有一条通路能写 `duck.gain`：acapellaOverlay 自己会排 presence 曲线，
  // 若这里再排一遍 bDuck，两条 `setValueAtTime` 序列会互相覆盖（后写的赢，深度和时机都不对）。
  if (plan.bDuck?.length && !plan.vocalOverlay?.enabled) {
    scheduleAutomixV2Duck(b, plan.bDuck.map((e) => ({ atSec: clock + (e.offsetMs / 1000) * musicToWall, db: e.db })), clock + mixSec);
    logEvent('automix-v2-duck-b', `B 在 A 唱句底下压 ${Math.abs(Math.min(...plan.bDuck.map((e) => e.db))).toFixed(1)} dB（${plan.bDuck.length} 点）`);
  }
  if (plan.aUnfade?.length) scheduleAutomixV2Unfade(a,clock+
    Math.max(0,plan.aUnfade[0].ms-plan.fadeStartFileMs)/1000*musicToWall,plan.aUnfade);
  // 过渡尾巴的混响：两首歌都送，但 A 全量、B 减 9 dB 且更晚起送。
  // 只送 A 会听起来像「A 一个人在混响里消失」；只送 B 则新歌一开口就糊。
  const baseReverb = readReverbOptions();
  const styleSend = Number.isFinite(styleParams?.reverbSendDb ?? NaN)
    ? Math.max(-24, Math.min(0, styleParams?.reverbSendDb as number)) : null;
  const appleRev = apple?.reverb;
  const reverb = {
    ...(styleSend !== null ? { ...baseReverb, sendDb: styleSend } : baseReverb),
    ...(appleRev
      ? {
          fromP: Math.max(0.5, Math.min(0.9, appleRev.t0 || baseReverb.fromP)),
          tailMs: Math.max(400, Math.min(3_000, Math.round(appleRev.decaySec * 1_000))),
        }
      : {}),
  };
  plan.reverb = reverb;
  // Apple 的送出点在 LP1/HP1 之后（`DSPGraph.dspg` 的 `LP1 → Gain2 → Delay → Reverb`）：
  // 尾巴本身就是「已经被扫频压过」的声音，所以越到后段回响越暗、越贴主声道。
  // 我们的滤波器是扫频支路上的 sweepLp/sweepHp，对应 Apple 的 LP1/HP1 —— 走「滤波/回声/混响」
  // 这三类手法时把尾巴改到 post 取；纯换手（bassSwap/eqSwap）保持 pre，避免把低频也送进回声。
  const wetPost = plan.styleId === 'filterSweep' || plan.styleId === 'echoOut' || plan.styleId === 'reverbOut';
  try { a.setWetTap(wetPost ? 'post' : 'pre'); } catch { /* 老 deck 没有这个开关 */ }
  try { b.setWetTap('pre'); } catch { /* 同上 */ }
  logEvent('automix-v2-wet-tap', wetPost ? '送出点：滤波后（尾巴跟主声道一起变暗）' : '送出点：全带宽');
  // A 的湿声再往后压：70% 才起送、只送一半量、返回电平也降 4 dB。
  // 之前 50% 起送、return +8 dB，是「进过渡一会后发糊」的第二个来源。
  scheduleAutomixV2Reverb(a, clock, mixSec, {
    ...reverb,
    fromP: Math.max(0.7, reverb.fromP),
    sendDb: Math.min(-14, reverb.sendDb - 6),
    returnDb: Math.min(4, reverb.returnDb - 4),
  });
  scheduleAutomixV2Reverb(b, clock, mixSec, {
    sendDb: reverb.sendDb - 9,
    returnDb: reverb.returnDb,
    fromP: Math.min(0.88, reverb.fromP + 0.12),
    tailMs: reverb.tailMs,
  });
  // B 的「80% 前在混响里」：只把 300 Hz 以上送进湿声（低音保持干），
  // 50% 起送、80% 前保持、92% 前收干；B 自己唱的时候再把湿声压 8 dB（人声保持干）。
  try { setWetHighpass(a, 20); setWetHighpass(b, 300); } catch { /* 老 deck */ }
  scheduleAutomixV2WetBed(b, clock, mixSec, {
    sendDb: plan.styleId === 'reverbOut' ? -3 : -4,
    returnDb: 6,
    fromP: 0.5,
    dryAtP: 0.8,
    endDb: -30,
  });
  try {
    const actB = nextA.activity;
    if (actB && actB.hopMs > 0) {
      const points: { p: number; db: number }[] = [];
      const stepMs = 200;
      let lastDb = 0;
      for (let ms = 0; ms < plan.fadeMs; ms += stepMs) {
        const i = Math.floor((plan.bStartFileMs + ms * plan.tempoRate) / actB.hopMs);
        const v = i >= 0 && i < actB.vocal.length ? actB.vocal[i] ?? 0 : 0;
        const db = v > 0.45 ? -8 : 0;
        if (db !== lastDb) { points.push({ p: ms / plan.fadeMs, db }); lastDb = db; }
      }
      if (points.length) scheduleWetDuck(b, clock, mixSec, points);
    }
  } catch { /* 无活动度曲线就不压 */ }
  // B 顶上来的那一下压 A：陡升段同时下压 A 的电平并把它收闷，
  // 听感是「新歌起来的时候旧歌退到门后」，而不是两条轨道硬叠在一起。
  try {
    // 只在最后 15% 轻微压一下 A：30–50% 的低频进入段绝不允许把 A 收闷，
    // 否则听感是「一进过渡旧歌就变糊」。深度也收到 -2 dB、低通只到 6 kHz。
    const pressure = risingPressure(plan.v2Plan?.b ?? { low: [], high: [] }).filter((pt) => pt.p >= 0.85);
    if (pressure.some((pt) => pt.drive > 0.05)) {
      scheduleAutomixV2Press(a, clock, mixSec, pressure, {
        pressDb: plan.styleId === 'dropSwap' || plan.styleId === 'doubleDrop' ? -3 : -2,
        floorHz: 6_000,
      });
      const peak = pressure.reduce((best, pt) => (pt.drive > best.drive ? pt : best), pressure[0]!);
      logEvent(
        'automix-v2-press',
        `B 抬升段 ${Math.round(peak.p * 100)}% 处压 A ${Math.round(-5 * peak.drive * 10) / 10} dB · 收到 ${Math.round(20_000 + (1_500 - 20_000) * peak.drive)} Hz`,
      );
    }
  } catch { /* 老 deck 没有压音节点 */ }

  // 大声场：慢起、长尾，只吃「除人声外」的部分（送出链里已挖掉 2500 Hz 咬字区与 200 Hz 以下）。
  // 只在窗口够长时启用 —— 8 小节以下的空间打不开，硬塞只会糊成一片。
  const hallWanted = plan.fadeMs >= 6_000 && plan.styleId !== 'cut' && plan.styleId !== 'slam';
  if (hallWanted) {
    // 收小：原来 A −9 dB / B −12 dB 且 16% 就开、一直铺到 82%，
    // 两首歌的环境声叠在一起，听感是「混的啥也听不清」。
    // 现在：送出降 6 dB、进场推迟到 30%、峰值更短、尾巴更紧。
    const hall = {
      sendDb: plan.styleId === 'reverbOut' ? -19 : -23,
      fromP: 0.44,
      attackP: 0.42,
      releaseP: 0.68,
      tailMs: Math.max(500, Math.min(900, Math.round(plan.fadeMs * 0.05))),
    };
    scheduleAutomixV2Hall(a, clock, mixSec, {
      ...hall,
      fromP: Math.max(0.7, hall.fromP),
      sendDb: hall.sendDb - 6,
    });
    scheduleAutomixV2Hall(b, clock, mixSec, {
      ...hall,
      sendDb: hall.sendDb - 4,
      fromP: Math.min(0.85, Math.max(0.5, hall.fromP + 0.1)),
    });
    logEvent(
      'automix-v2-hall',
      `大声场 ${hall.sendDb}dB · 空间从 ${Math.round(hall.fromP * 100)}% 打开到 ${Math.round(hall.releaseP * 100)}% · 尾巴 ${hall.tailMs}ms`,
    );
  }
  // 短过渡（≤4.2 s）没有空间做长时间共存：让 A 的末句按拍点自己回响，把尾巴拖进 B 的开头。
  const keyGap = camelotGap(curA.camelot, nextA.camelot);
  // echoOut 手法：即使窗口比 4.2 s 长也做回声收尾（A 的最后一口气拖进 B）。
  const echoWanted = plan.styleId === 'echoOut' || plan.styleId === 'reverbOut';
  const echo = planEchoTail({
    fadeMs: plan.fadeMs,
    beatMs: bar / 4,
    keyGap,
    maxFadeMs: echoWanted ? Math.max(plan.fadeMs, ECHO_MAX_FADE_MS) : undefined,
  });
  if (echoWanted && Number.isFinite(styleParams?.echoDiv ?? NaN)) {
    const div = Math.max(0.25, Math.min(2, styleParams?.echoDiv as number));
    echo.divBeats = div;
    echo.delayMs = Math.round((bar / 4) * div);
  }
  // Apple 配方的延迟参数：feedback 35–60%、阻尼 3.5 kHz、延迟长度 = 1 拍（`@beat_length`）。
  if (apple?.echo) {
    echo.feedback = apple.echo.feedback;
    echo.dampHz = apple.echo.dampHz;
    if (apple.echo.divBeats) {
      echo.divBeats = apple.echo.divBeats;
      echo.delayMs = Math.round((bar / 4) * apple.echo.divBeats);
    }
    echo.sendFromP = Math.max(0.2, Math.min(0.9, apple.echo.t0 || 0));
  }
  if (echo.enabled) {
    plan.echo = echo;
    scheduleAutomixV2Echo(a, clock, mixSec, echo);
    logEvent('automix-v2-echo', echo.note);
  }
  // 人声叠加：A 的中频存在感抬起来，B 的人声在 A 唱的时候让开（零分轨的 acapella 近似）。
  if (plan.vocalOverlay?.enabled) {
    const ov = plan.vocalOverlay;
    scheduleAutomixV2Presence(a, clock, mixSec, {
      fromDb: 0,
      toDb: ov.aBoostDb,
      fromP: ov.fromP,
      releaseP: ov.releaseP,
    });
    if (ov.bDuckDb < 0) {
      scheduleAutomixV2Presence(b, clock, mixSec, {
        fromDb: 0,
        toDb: ov.bDuckDb,
        fromP: Math.max(0, ov.fromP - 0.15),
        releaseP: 0.96,
      });
    }
    logEvent('automix-v2-presence', ov.note);
  }
  // A 的器乐尾巴：窗口末不切断，从这个电平继续铺在 B 底下，再缓慢收干。
  // 收干必须赶在 `tap.restore()` 之前到听不见的位置（−80 dB 级），
  // 否则摘链那一刻残余尾巴会被旁路一起抬起来，也是「过渡完突然变亮」的一条来源。
  if (aTailHold > 0 && plan.aTailBleedMs) {
    scheduleAutomixV2TailBleed(a, clock + mixSec, Math.max(0.15, (plan.aTailBleedMs / 1000) * 0.9), aTailHold);
    logEvent('automix-v2-tail-bleed', `A 的尾巴在过渡后继续铺 ${(plan.aTailBleedMs / 1000).toFixed(1)}s（-13 dB → 静音）`);
  }
  logEvent(
    'automix-v2-reverb',
    `尾段混响 A send ${reverb.sendDb}dB / B send ${reverb.sendDb - 9}dB · return ${reverb.returnDb}dB · A 从 ${Math.round(
      reverb.fromP * 100,
    )}% 起送，全程 ${Math.round(reverb.tailMs)}ms 尾巴`,
  );
  if (plan.introBridge && plan.introBuffer) {
    const ctx = b.tap.input.context as AudioContext;
    const delaySec = Math.max(0,mixSec -
      (plan.introBridge.firstVocalMs-plan.bStartFileMs)/1000*musicToWall);
    const handle = delaySec > 0 ? startBridgePlayback({ctx,tap:b.tap,buffer:plan.introBuffer,
      atSec:clock,durationSec:delaySec,rate:standby.playbackRate}) : null;
    if (handle) {
      const runtime = plan.v2;
      runtime.introBridge = handle;
      standby.pause();
      standby.currentTime = plan.bStartFileMs/1000;
      runtime.introTimer = window.setTimeout(() => {
        if (activePlan !== plan || plan.v2 !== runtime) return;
        void standby.play().then(() => handle.stop()).catch(() => {
          if (activePlan === plan) cancelCrossfade('intro-resume-failed');
        });
      },delaySec*1000);
    }
  }
  if (plan.backspin?.enabled && plan.backspinBuffer) {
    const ctx = a.tap.input.context as AudioContext;
    plan.v2.backspin = startBridgePlayback({
      ctx, tap: a.tap, buffer: plan.backspinBuffer,
      atSec: clock, durationSec: plan.backspin.tailMs / 1000, rate: plan.backspin.rate,
    });
  }
  if (plan.doubling?.enabled && plan.doublingBuffer) {
    const dbl = plan.doubling;
    const ctx = a.tap.input.context as AudioContext;
    const at = clock + Math.max(0, mixSec - (dbl.leadMs / 1000) * musicToWall);
    const handle = startOverlayPlayback({ ctx, tap: a.tap, buffer: plan.doublingBuffer, atSec: at, durationSec: dbl.leadMs / 1000 });
    if (handle) plan.v2.doubling = handle;
  }
  if (plan.loopRoll?.enabled && plan.loopRollBuffer) {
    const ctx = a.tap.input.context as AudioContext;
    const roll = plan.loopRoll;
    plan.v2.loopRoll = startBridgePlayback({
      ctx, tap: a.tap, buffer: plan.loopRollBuffer,
      atSec: clock, durationSec: (roll.unitMs * roll.passes) / 1000,
    });
  }
  if (plan.bridge && plan.bridgeBuffer) {
    const ctx = a.tap.input.context as AudioContext;
    const delay = (plan.bridge.unitStartFileMs-active.currentTime*1000)/1000*musicToWall;
    if (delay >= 0) plan.v2.bridge = startBridgePlayback({ctx,tap:a.tap,buffer:plan.bridgeBuffer,
      atSec:clock+delay,durationSec:Math.max(0,mixSec-delay),rate:baseDeckRate(options)});
  }
  // A 尾自延长 / 生成过渡垫底：buffer 接在 tap.input（绕过元素门、仍经过 v2 链）。
  // tail：从 A 的 audibleEnd 起播，补到主过渡收尾；bed：从 fadeStart 起播，整段垫在换手下面。
  if (plan.extensionPlan?.source === 'a-tail'
    && plan.extensionBuffer && !plan.v2.extension) {
    const ctx = a.tap.input.context as AudioContext;
    const rate = active.playbackRate;
    const ext = plan.extensionPlan;
    const params = extensionPlaybackParams(plan, clock, rate);
    const bed = params?.bed === true;
    plan.v2.extension = params ? startExtensionPlayback({
      ctx,
      tap: a.tap,
      buffer: plan.extensionBuffer,
      atSec: params.atSec,
      gainDb: ext.gainDb,
      durationSec: params.durationSec,
      offsetSec: 0,
      fadeInSec: params.fadeInSec,
      fadeOutSec: params.fadeOutSec,
      coverSec: params.coverSec,
    }) : null;
    if (plan.v2.extension) {
      const label = bed
        ? ext.model === 'musicgen'
          ? '生成过渡续接（MusicGen）'
          : '生成过渡垫底（Stable Audio）'
        : ext.source === 'model' ? 'A 尾补生成段' : 'A 尾补循环';
      logEvent('automix-v2-extension', `${label} ${(ext.targetMs / 1000).toFixed(1)}s（${ext.passes} 遍 · ${ext.reason}）`);
      if (bed) {
        toast(
          `生成过渡：${ext.model === 'musicgen' ? '续接' : '垫底'} ${(
            ext.targetMs / 1000
          ).toFixed(1)}s · 随换手收尾`,
        );
      }
    }
  }
  return true;
}

function playInstrumentBed(plan: ActivePlan, clock: number): boolean {
  const deck = plan.options.standby;
  const input = deckStemInput(deck);
  const ctx = deckAudioContext(deck);
  const buffers = plan.bedWindows;
  if (!input || !ctx || !buffers?.size) return false;
  const from = deck.currentTime;
  const rate = deck.playbackRate;
  const seconds = plan.fadeMs/1000;
  const bar = barIntervalOf((plan.options as CrossfadePrepareOptions).nextAnalysis.analysis);
  const recovery = Math.min(4, Math.max(1.2,bar/1000))/rate;
  const until = from+rate*(seconds+recovery);
  const segments: {buffer:{other:AudioBuffer; vocals:AudioBuffer}; at:number; offset:number; length:number}[] = [];
  for (let window=Math.floor(from/30);window*30<until-0.001;window++) {
    const buffer=buffers.get(window);
    const pos=Math.max(from,window*30);
    const length=Math.min(until,(window+1)*30)-pos;
    if (!buffer || pos-window*30+length>Math.min(buffer.other.duration,buffer.vocals.duration)+0.02) return false;
    segments.push({buffer,at:clock+(pos-from)/rate,offset:pos-window*30,length});
  }
  if (!segments.length) return false;
  const widthNodes: AudioNode[] = [];
  const bed=ctx.createGain();
  const voice=ctx.createGain();
  const sources:AudioBufferSourceNode[]=[];
  const end=clock+seconds;
  const stop=()=> {
    for (const source of sources) { try { source.stop(); } catch {} source.disconnect(); }
    bed.disconnect();
    for (const node of widthNodes) node.disconnect();
    voice.disconnect();
    setDeckMixGain(deck,1);
  };
  try {
    bed.connect(input);
    // Add equal and opposite high-passed side energy to the stereo bed.
    // The dry center and the mono sum stay intact throughout the handoff.
    if (segments.every(segment => segment.buffer.other.numberOfChannels === 2)) {
      const split = ctx.createChannelSplitter(2);
      const invertRight = ctx.createGain();
      const side = ctx.createBiquadFilter();
      const width = ctx.createGain();
      const invertSide = ctx.createGain();
      const stereo = ctx.createChannelMerger(2);
      widthNodes.push(split,invertRight,side,width,invertSide,stereo);
      invertRight.gain.value = -1;
      invertSide.gain.value = -1;
      side.type = 'highpass';
      side.frequency.value = 220;
      side.Q.value = -3;
      width.gain.setValueAtTime(0,clock);
      width.gain.linearRampToValueAtTime(0.25,clock+seconds*0.65);
      width.gain.linearRampToValueAtTime(0.16,end);
      width.gain.linearRampToValueAtTime(0,end+recovery);
      bed.connect(split);
      split.connect(side,0);
      split.connect(invertRight,1);
      invertRight.connect(side);
      side.connect(width);
      width.connect(stereo,0,0);
      width.connect(invertSide);
      invertSide.connect(stereo,0,1);
      stereo.connect(input);
    }
    voice.connect(input);
    bed.gain.setValueAtTime(0,clock);
    bed.gain.linearRampToValueAtTime(0.32,clock+seconds*0.6);
    bed.gain.linearRampToValueAtTime(0.18,end);
    bed.gain.linearRampToValueAtTime(0,end+recovery);
    // The full mix already carries 30% of the vocal at the lyric boundary.
    // Complement its gain with the isolated vocal through the recovery.
    voice.gain.setValueAtTime(0,clock);
    voice.gain.setValueAtTime(0,Math.max(clock,end-0.10));
    voice.gain.linearRampToValueAtTime(0.7,end);
    voice.gain.linearRampToValueAtTime(0,end+recovery);
    for (const segment of segments) {
      for (const part of ['other','vocals'] as const) {
        const source=ctx.createBufferSource();
        sources.push(source);
        source.buffer=segment.buffer[part];
        source.playbackRate.value=rate;
        source.connect(part==='other' ? bed : voice);
        source.start(segment.at,segment.offset,segment.length);
      }
    }
    scheduleElementEntry(deck,clock,end,recovery);
    plan.lyricProgress=seconds/(seconds+recovery);
    plan.fadeMs+=recovery*1000;
    setDeckGraphGain(deck,1);
    plan.stopBed=stop;
    return true;
  } catch { stop(); return false; }
}

function releaseSplitMix(plan: ActivePlan, continuing: 'a' | 'b' = 'b'): void {
  plan.bedWindows=undefined;
  plan.stopBed?.();
  plan.stopBed=undefined;
  const runtime = plan.v2;
  if (!runtime) return;
  plan.v2 = null;
  if (runtime.introTimer) clearTimeout(runtime.introTimer);
  runtime.introBridge?.stop();
  runtime.bridge?.stop();
  runtime.backspin?.stop();
  runtime.loopRoll?.stop();
  runtime.doubling?.stop();
  runtime.extension?.stop();
  runtime.extension = null;
  try { runtime.a.setWetTap('pre'); } catch { /* 老 deck 没这个开关 */ }
  try { runtime.b.setWetTap('pre'); } catch { /* 同上 */ }
  // 混响/回声的尾巴先自己走完，再拆链：直接 dispose 等于把 return 一步砍到 0
  const releaseMs = 1_000;
  releaseAutomixV2Tail(runtime.a);
  releaseAutomixV2Tail(runtime.b);
  const aDeck = runtime.a;
  const bDeck = runtime.b;
  // 先把链上还挂着的过渡状态（扫频、压音、让位、风格 EQ）用真斜坡放平，再摘 tap。
  //
  // `tap.restore()` 是 0 时长的旁路：gate/input 直接 disconnect、元素 gain 一步接回干路。
  // 曲线排得准的时候链上本来就接近中性，这一步是空操作；但只要还剩一点压低
  // （手动取消、图被激活时硬切、曲线与进度差几十毫秒、尾巴没来得及收干），
  // 旁路就会把它一次性弹回来 —— 听起来就是「过渡完成后，被削掉的高音瞬间恢复」。
  const relaxMs = 180;
  try {
    relaxAutomixV2Chain(aDeck, relaxMs / 1000, continuing === 'a');
    relaxAutomixV2Chain(bDeck, relaxMs / 1000, continuing === 'b');
  } catch { /* 上下文已关闭时忽略 */ }
  window.setTimeout(() => {
    // 这 180 ms 里如果已经有新过渡接管了同一条 tap，别再拆它。
    if (activePlan) return;
    // Return both elements to their dry outputs. Only the already-fed
    // reverb/delay nodes need to survive for the tail.
    try { aDeck.tap.restore(); } catch { /* 已还原 */ }
    try { bDeck.tap.restore(); } catch { /* 已还原 */ }
  }, relaxMs);
  window.setTimeout(() => {
    aDeck.dispose();
    bDeck.dispose();
  }, releaseMs);
}

function beginTimeline(plan: ActivePlan): void {
  if (plan.raf) window.clearTimeout(plan.raf);
  plan.raf = 0;
  plan.timelineReady = true;
  plan.startedAt = performance.now();
  // File-time plan becomes wall/audio time exactly once, after successful startup.
  if (plan.kind === 'auto') {
    const options = plan.options as CrossfadePrepareOptions;
    let endFileMs = plan.fadeStartFileMs + plan.fadeMs;
    if (plan.bridge && (!plan.bridgeBuffer || !plan.graphMode)) {
      endFileMs = Math.min(endFileMs,plan.bridge.extendedEndMs-plan.bridge.extensionMs);
      plan.bridge = null;
    }
    const introRoom = plan.introBridge && (!plan.introBuffer || !plan.graphMode)
      ? (plan.introBridge.firstVocalMs-plan.bStartFileMs)/plan.tempoRate : Infinity;
    const remainingFileMs = Math.min(plan.fadeMs, introRoom,endFileMs - options.active.currentTime * 1000);
    if (remainingFileMs < MIN_FADE_MS) {
      cancelCrossfade('b-start-too-late');
      return;
    }
    const lyric = plan.vocalAnchor?.bEntryMs;
    plan.fadeMs = plan.cleanPickup && lyric
      ? Math.max(12,(lyric-options.standby.currentTime*1000)/options.standby.playbackRate)
      : remainingFileMs / baseDeckRate(options);
  }
  const clock = audioTapClock();
  if (plan.graphMode && clock !== null) {
    plan.audioStartedAt = clock;
    scheduleDeckMatch(plan.options.standby, clock, plan.gainTrimDb, plan.fadeMs, {
      // v2 的响度对齐是「整段有效」的：接上就不撤，否则过渡结束后 B 会回升 3 dB
      // 不能整首保持：B 会被永久抬 2–6 dB，听感就是「放大过、还带点混响」。
      // 过渡期间保持，之后用 8 秒（约 4 小节）慢慢放掉，跳跃感不可闻。
      maxDb: isAutomixV2(effectiveMode()) ? 2 : 3,
      holdSec: isAutomixV2(effectiveMode()) ? 8 : 4,
    });
    if (plan.cleanPickup) {
      const edge = Math.max(0,plan.fadeMs-12);
      const vocalMs=plan.fadeMs;
      const layered=playInstrumentBed(plan,clock);
      scheduleDeckGain(plan.options.active,clock,[{atMs:0,gain:1},{atMs:layered ? vocalMs*0.72 : edge,gain:1},{atMs:vocalMs,gain:0}]);
      if (!layered) scheduleDeckGain(plan.options.standby,clock,[{atMs:0,gain:0},{atMs:edge,gain:0},{atMs:plan.fadeMs,gain:1}]);
    } else if (plan.phraseMatch) {
      if (!startSplitMix(plan,clock)) scheduleNaturalFade(plan,clock);
    } else {
      // 进阶模式：把时间轴交给四轨混音器（同一 clock 启动，轨间零偏移）。
      // 标准模式或进阶不可用时 requestHandoff 返回 null，仍然走原来的等功率/交融曲线。
      const autoOptions = plan.kind === 'auto' ? (plan.options as CrossfadePrepareOptions) : null;
      plan.advanced = requestHandoff({
        mode: readMixTransitionMode(),
        kind: plan.kind,
        fadeMs: plan.fadeMs,
        tempoRate: plan.tempoRate,
        analysisA: autoOptions?.currentAnalysis?.analysis,
        analysisB: autoOptions?.nextAnalysis?.analysis,
        trackA: autoOptions?.current?.track,
        trackB: autoOptions?.next?.track,
        positionMsA: plan.fadeStartPosMs,
        positionMsB: plan.bStartFileMs,
        currentDurationMs: autoOptions?.currentDurationMs,
        nextDurationMs: autoOptions?.next?.track?.durationMs,
        elementA: plan.options.active,
        elementB: plan.options.standby,
        stemKeyA: autoOptions ? stemKeyFor(autoOptions.current?.track, plan.fadeStartPosMs / 1000) : '',
        stemKeyB: autoOptions ? stemKeyFor(autoOptions.next?.track, plan.bStartFileMs / 1000) : '',
        ...(templateHint() ? { hint: templateHint() } : {}),
      });
      if (plan.advanced) {
        try {
          plan.advanced.start(clock);
          // T4-3：加法引擎下四轨已开始出声，deck 自己的通路立刻互斥静音（元素音量在 begin()
          // 里已置 0，图模式下 volume 不作用于 element source，所以这里还要压 graph gain）。
          // 减法引擎相反：元素必须继续出声，四轨只是「被减项」，绝不能再压它的通路。
          if (readMixTransitionEngine() !== 'subtractive') muteDeckElementsForAdvanced(plan);
          logEvent('advanced-handoff', `进阶过渡：分轨换手 ${plan.fadeMs} ms`);
        } catch (err) {
          console.warn('[crossfade] 进阶交接启动失败，回落标准曲线', err);
          try {
            plan.advanced.cancel();
          } catch {
            /* 忽略 */
          }
          plan.advanced = null;
        }
      }
      if (plan.advanced && typeof plan.advanced.whenReady === 'function') {
        // 四轨是异步加载的：没接管成功就从「当前进度」接着走等功率，不从头再来。
        void plan.advanced.whenReady()
          .then((ok) => {
            if (ok || activePlan !== plan) return;
            fallbackFromAdvanced(plan);
          })
          .catch(() => {
            if (activePlan === plan) fallbackFromAdvanced(plan);
          });
      }
      if (!plan.advanced) {
        if (plan.am) scheduleAmFade(plan);
        else {
          // 非「标准」档且分轨没接管：走频率换手（低频先换、滤波错开），不再整轨等功率。
          // 手动切歌的短淡入保持全频，避免四小节滤波在交接结束时被截断。
          if (plan.kind !== 'manual' && readMixTransitionMode() !== 'standard') {
            scheduleBandSwap(plan, clock, autoOptions ?? null);
          }
          scheduleNaturalFade(plan, clock);
        }
      }
    }
  }
  // If B underruns, keep A audible instead of fading it into stalled audio.
  const onWaiting = (): void => {
    if (activePlan === plan) cancelCrossfade('b-buffering');
  };
  plan.options.standby.addEventListener('waiting', onWaiting);
  plan.cleanup = () => plan.options.standby.removeEventListener('waiting', onWaiting);
}

/**
 * B 相对 A 的拍相位差（单位：拍，正数 = B 超前）。
 *
 * 只对 auto 档有意义：手动切歌/单曲循环没有「对齐下一段」的语义，强行拉拍只会拖拍。
 * 位置优先用元素真实 currentTime（那是唯一能反映 WSOLA 实际推进的时钟），
 * 拿不到（0 / NaN / 元素已被移除）才退回 `起点 + 已过时间 × 速率` 的模型推算。
 */
function beatPhaseError(plan: ActivePlan, elapsedMs: number, liveRate: number): number | null {
  if (plan.kind !== 'auto') return null;
  const options = plan.options as CrossfadePrepareOptions;
  const a = options.currentAnalysis?.analysis;
  const b = options.nextAnalysis?.analysis;
  if (!a || !b) return null;
  const beatA = a.beatIntervalMs;
  const beatB = b.beatIntervalMs;
  if (!(beatA > 0) || !(beatB > 0) || !Number.isFinite(beatA) || !Number.isFinite(beatB)) return null;

  const elA = plan.options.active.currentTime * 1000;
  const elB = plan.options.standby.currentTime * 1000;
  const posA = Number.isFinite(elA) && elA > 0 ? elA : plan.fadeStartFileMs + elapsedMs;
  const posB = Number.isFinite(elB) && elB > 0 ? elB : plan.bStartFileMs + elapsedMs * liveRate;

  if (plan.beatSync) {
    const phase = (track: BeatAnalysis, at: number, interval: number) => {
      const beats = track.beatsMs ?? [];
      let lo = 0, hi = beats.length;
      while (lo < hi) {
        const mid = (lo+hi) >>> 1;
        if (beats[mid] <= at) lo = mid+1;
        else hi = mid;
      }
      if (lo > 0 && lo < beats.length && beats[lo] > beats[lo-1])
        return (at-beats[lo-1])/(beats[lo]-beats[lo-1]);
      return mod(at-(track.firstBeatMs ?? 0),interval)/interval;
    };
    return wrapBeatError(phase(b,posB,beatB)-phase(a,posA,beatA));
  }
  const firstA = a.firstBeatMs ?? 0;
  const firstB = b.firstBeatMs ?? 0;
  const phaseA = mod(posA - firstA, beatA) / beatA;
  const phaseB = mod(posB - firstB, beatB) / beatB;
  return wrapBeatError(phaseB - phaseA);
}

/** 本步真正写进 B 的速率：中心速率 + PLL 微调（回正段之后不再修正，交给回正斜坡）。 */
function pllLiveRate(plan: ActivePlan, center: number, elapsedMs: number): number {
  const err = beatPhaseError(plan, elapsedMs, center);
  if (err === null) {
    plan.pll = null;
    debug.pllActive = false;
    return center;
  }
  const state = plan.pll ?? { rate: center, errBeats: 0 };
  const next = trackRate({ rate: state.rate }, err, { center });
  plan.pll = { rate: next.rate, errBeats: err };
  debug.pllActive = true;
  debug.pllRate = next.rate;
  debug.pllErrBeats = Math.round(err * 1000) / 1000;
  return next.rate;
}

function fadeStep(): void {
  const plan = activePlan;
  if (!plan || plan.phase !== 'fading') return;
  plan.raf = 0;
  if (!plan.options.isValid()) {
    cancelCrossfade('stale');
    return;
  }
  if (!plan.graphMode && audioTapGraphActive()) {
    // 淡化中途 Web Audio 图被激活：立即取消并硬切到 B（元素模式下 B 只能走原生输出）。
    hardCutToStandby(plan);
    return;
  }
  const clock = audioTapClock();
  const elapsed = plan.audioStartedAt !== undefined && clock !== null
    ? (clock - plan.audioStartedAt) * 1000 : performance.now() - plan.startedAt;
  // 目标 = 下一首时，A 被拉快/拉慢，窗口的墙钟长度随之变成 fadeMs × tempoRate。
  const wallMs = plan.fadeWallMs ?? plan.fadeMs * (plan.tempoInverted ? Math.max(0.5, plan.tempoRate) : 1);
  const progress = Math.min(1, elapsed / Math.max(1, wallMs));
  const runtime = plan.v2;
  if (runtime && !runtime.lowTrimDone && progress >= Math.max(0,runtime.plan.handoffStartP-0.12)) {
    const a = measureLowRms(runtime.a), b = measureLowRms(runtime.b);
    if (a > 0.001 && b > 0.001) {
      const samples = runtime.lowSamples ??= [];
      samples.push([a,b]);
      if (samples.length >= 3) {
        const ratios = samples.map(([left,right]) => left/right).sort((x,y) => x-y);
        const db = Math.max(-8,Math.min(0,20*Math.log10(ratios[1])));
        setLowTrimDb(runtime.b,db);
        runtime.lowTrimDb = db;
        runtime.lowTrimDone = true;
      }
    }
  }
  if (!plan.previewNotified && progress >= (plan.lyricProgress ?? runtime?.plan.handoffP ?? Infinity)) {
    plan.previewNotified = true;
    notifyStart(plan);
  }
  plan.progress = progress;
  debug.progress = progress;
  // A 在 MATCHED_OVERLAP_END 处已静音，之后才恢复 B 原速：
  // 之后平滑拉回用户倍速，过渡完成的瞬间 B 已经是正常播放速度。
  if (plan.aRate && Math.abs(plan.aRate - 1) > 0.001) {
    // 双侧向中点靠：A 拉到 aRate、B 拉到 tempoRate，过渡后各自回原速。
    const baseRate = baseDeckRate(plan.options);
    const rampMs = Math.max(1_200, Math.min(6_000, Math.round(wallMs * 0.25)));
    const k = Math.min(1, elapsed / rampMs);
    const wantA = baseRate * (1 + (plan.aRate - 1) * k);
    const wantB = baseRate * (1 + (plan.tempoRate - 1) * k);
    const aEl = plan.options.active;
    if (!aEl.paused && Math.abs(aEl.playbackRate - wantA) > 0.002) setDeckPlaybackRate(aEl, wantA);
    if (!plan.options.standby.paused && Math.abs(plan.options.standby.playbackRate - wantB) > 0.002) {
      setDeckPlaybackRate(plan.options.standby, wantB);
    }
    debug.tempoRateLive = Math.round(plan.tempoRate * 1000) / 1000;
  } else if (plan.tempoInverted) {
    // 目标 = 下一首：B 保持原速，A 在过渡前段被拉到 B 的 BPM。
    // 苹果的 `speedRamp` 是几十段折线（日志里 39 / 77 段）；WebAudio 只有一个 playbackRate，
    // 折中成 4 段 ease-in-out 折线 —— 听感上不再是「一条直线匀速拉」，而是先慢、中间快、末段再慢下来。
    const baseRate = baseDeckRate(plan.options);
    if (!plan.rampPlan) plan.rampPlan = planSpeedRamp(plan.tempoRate, 4, 1);
    const rampMs = Math.max(1_200, Math.min(6_000, Math.round(wallMs * 0.25)));
    const k = Math.min(1, elapsed / rampMs);
    const wantA = baseRate * speedRampAt(plan.rampPlan.a, k);
    const aEl = plan.options.active;
    if (!aEl.paused && Math.abs(aEl.playbackRate - wantA) > 0.002) {
      setDeckPlaybackRate(aEl, wantA);
      plan.advanced?.setRates?.({ a: wantA, b: plan.options.standby.playbackRate });
    }
    setDeckPlaybackRate(plan.options.standby, baseRate);
    debug.tempoRateLive = Math.round(baseRate * 1000) / 1000;
  } else if (plan.beatSync || Math.abs(plan.tempoRate - 1) > 0.001) {
    const baseRate = baseDeckRate(plan.options);
    const matchedRate = baseRate * plan.tempoRate;
    const restore = progress <= MATCHED_OVERLAP_END
      ? 0
      : smoothStep((progress - MATCHED_OVERLAP_END) / (1 - MATCHED_OVERLAP_END));
    // 回正段（restore > 0）只走斜坡；对齐段才让 PLL 贴着 A 的拍走。
    let liveRate = plan.beatSync && !plan.options.standby.paused
      ? pllLiveRate(plan, matchedRate, elapsed) : restore > 0
      ? matchedRate + (baseRate - matchedRate) * restore
      : pllLiveRate(plan, matchedRate, elapsed);
    const entry = plan.vocalAnchor?.bEntryMs;
    if (plan.beatSync && entry && progress > 0.75 && !plan.options.standby.paused) {
      const remaining = Math.max(50,plan.fadeMs-elapsed);
      const needed = (entry-plan.options.standby.currentTime*1000)/remaining;
      liveRate = Math.max(matchedRate*0.98,Math.min(matchedRate*1.02,needed));
    }
    setDeckPlaybackRate(plan.options.standby, liveRate);
    debug.tempoRateLive = Math.round(liveRate * 1000) / 1000;
    // 进阶路径：声音实际来自四轨播放器，元素速率只是「控制信号」。
    // 直接传 liveRate（绝对速率，= 用户倍速 × tempoRate × PLL 修正），
    // 因为分轨播放器的 setRate 也是绝对的；两者必须是同一个数，否则元素时间与分轨时间分叉。
    // A 侧同理：用户可能正在推 tempo 推子，A 的元素速率变了而分轨没跟 ⇒ 几十秒后鼓点与波形错开。
    if ((plan.advanced?.setRates || plan.advanced?.setRate) && matchedRate > 0) {
      try {
        if (plan.advanced.setRates) plan.advanced.setRates({ a: plan.options.active.playbackRate, b: liveRate });
        else plan.advanced.setRate?.(liveRate);
      } catch {
        /* 忽略：会话可能正在拆 */
      }
    }
  }
  // ---- 低频电平校准（v2）：换手之前把 B 的低频拉到与 A 同响度 ----
  // 为什么必须做：两侧低频是**相关信号**（同一段鼓点），线性交叉 a+b=1 只有在
  // 「两边一样响」时才等价于能量守恒；原样相加就会在换手窗口里出现「低频被放大」。
  // 采样 4 帧（≈100 ms）取中位数，避开单帧的瞬态。
  // 分轨「先放完」兜底：span 是按小节算出来的，若文件/模型比预期短，
  // 音频会在过渡末尾静音。剩不到 0.4 s 就提前接回元素等功率，宁可少几拍换手也不要静场。
  if (plan.advanced && progress < 1) {
    let left: number | null = null;
    try {
      left = plan.advanced.remainingSec ? plan.advanced.remainingSec() : null;
    } catch {
      left = null;
    }
    if (left !== null && Number.isFinite(left) && left < 0.4) {
      logEvent('advanced-handoff', `分轨只剩 ${left.toFixed(2)} s，提前接回等功率`);
      fallbackFromAdvanced(plan);
      return;
    }
  }
  // 图内增益/滤波已排在音频时间线上；元素回退才需要按时更新音量。
  // 进阶模式的分轨增益同样在音频时钟上，这里一次都不写，避免和自动化打架。
  if (!plan.graphMode && !plan.advanced) applyEqualPowerGains(plan, progress);
  if (progress >= 1) {
    // A 还有器乐尾巴要铺：先别拆链，等它收干再 finish（元素一直在播）。
    if (!plan.tailBleedArmed && plan.aTailBleedMs && plan.aTailBleedMs > 0) {
      plan.tailBleedArmed = true;
      plan.raf = window.setTimeout(() => finishFade(plan), plan.aTailBleedMs);
      return;
    }
    finishFade(plan);
    return;
  }
  plan.raf = window.setTimeout(fadeStep, 25);
}

/**
 * 进阶交接没能接管（四轨解码失败 / 起会话抛错 / 被取消）：
 * 从**当前进度**接回等功率曲线，元素与图两条路径都要还原，否则会停在静音。
 */
function fallbackFromAdvanced(plan: ActivePlan): void {
  const handoff = plan.advanced;
  plan.advanced = null;
  if (handoff) {
    try {
      handoff.cancel();
    } catch {
      /* 忽略：交接自己已经失败 */
    }
  }
  if (activePlan !== plan) return;
  const progress = clamp01(plan.progress);
  const clock = audioTapClock();
  logEvent('advanced-handoff', `进阶未接管，从 ${(progress * 100).toFixed(0)}% 接回等功率`);
  // T4-3：deck 通路在接管成功时被压到 0，这里先按当前进度还原（20 ms 斜坡），
  // 再把剩余窗口排成等功率曲线；顺序反了就会从 0 一步跳上去（咔哒）。
  restoreDeckGains(plan, progress);
  if (plan.graphMode && clock !== null) {
    const remaining = Math.max(1, plan.fadeMs * (1 - progress));
    scheduleNaturalFade(plan, clock, progress, remaining);
  }
}

/**
 * 过渡结束后不要「一步跳回原速」：A 在过渡里被拉到 B 的拍速（§7.45 倒置模式），
 *   结束时若立刻 setDeckPlaybackRate(base)，正在收尾的尾巴会当场变快，听感像被掐了一下。
 *   这里用 smoothstep 在 ~2.4 s 内滑回去，B 同理（旧式 B→ 模式下 B 也要回自己的速）。
 */
function glideDeckRate(element: HTMLAudioElement, to: number, ms = 2_400): void {
  const from = element.playbackRate;
  if (!Number.isFinite(from) || Math.abs(from - to) < 0.002) {
    setDeckPlaybackRate(element, to);
    return;
  }
  const t0 = performance.now();
  const step = (): void => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    const v = from + (to - from) * smoothStep(k);
    setDeckPlaybackRate(element, v);
    if (k < 1) window.requestAnimationFrame(step);
    else setDeckPlaybackRate(element, to);
  };
  window.requestAnimationFrame(step);
}

function finishFade(plan: ActivePlan): void {
  if (activePlan !== plan) return;
  releaseSplitMix(plan);
  disposeAdvanced(plan);
  plan.cleanup?.();
  if (plan.raf) {
    window.clearTimeout(plan.raf);
    plan.raf = 0;
  }
  if (plan.graphMode) {
    // 图内收尾：B 满音量、A 静音并从混音入口摘下；主音量仍由本地 gain 保持。
    // releaseDeckFx 会撤掉「交融」残留的扫频/低频交接，并停在指定增益上，避免收尾继承滤镜。
    setAudioTapVolume(plan.baseVolume, true);
    releaseDeckFx(plan.options.active, 0);
    releaseDeckFx(plan.options.standby, 1);
    setDeckMixGain(plan.options.standby, 1);
    setDeckGraphTilt(plan.options.active, 0, 0);
    setDeckGraphTilt(plan.options.standby, 0, 0);
    setDeckGraphVocalFocus(plan.options.active, 0);
    setDeckGraphVocalFocus(plan.options.standby, 0);
    detachDeckFromGraph(plan.options.active);
  } else {
    setDeckVolume(plan.options.active, 0);
    setDeckVolume(plan.options.standby, plan.baseVolume);
  }
  // A 退出后的末段已完成回正，这里落到用户倍速。
  // 过渡完成的瞬间 B 就是正常速度，不再有过渡后的「变速尾巴」。
  const baseRate = baseDeckRate(plan.options);
  glideDeckRate(plan.options.standby, baseRate);
  glideDeckRate(plan.options.active, baseRate);
  debug.tempoRateLive = Math.round(baseRate * 1000) / 1000;
  activePlan = null;
  debug.phase = 'done';
  debug.amActive = false;
  debug.reason = plan.kind === 'manual' ? 'manual-done' : plan.kind === 'loop' ? 'loop-done' : 'fade-done';
  debug.nextPrepared = false;
  debug.progress = 1;
  logEvent(
    plan.kind === 'auto' ? 'fade-done' : plan.kind === 'loop' ? 'loop-fade-done' : 'manual-fade-done',
    'A 已静音、B 已满音量，交由 player 交换 deck',
  );
  try {
    plan.options.onFinish();
  } catch (err) {
    console.warn('[crossfade] onFinish failed', err);
  }
}

function hardCutToStandby(plan: ActivePlan): void {
  if (activePlan !== plan) return;
  releaseSplitMix(plan);
  disposeAdvanced(plan);
  plan.cleanup?.();
  if (plan.raf) {
    window.clearTimeout(plan.raf);
    plan.raf = 0;
  }
  const base = clamp01(plan.options.baseVolume());
  try {
    plan.options.active.pause();
  } catch {
    /* 忽略 */
  }
  setDeckVolume(plan.options.active, 0);
  setDeckVolume(plan.options.standby, base);
  if (audioTapGraphActive()) {
    // A 可能仍在图里，确保它静音（顺带撤掉交融残留的扫频）；B 没接图，继续用元素音量。
    releaseDeckFx(plan.options.active, 0);
    setDeckGraphVocalFocus(plan.options.active, 0);
    setDeckGraphVocalFocus(plan.options.standby, 0);
    detachDeckFromGraph(plan.options.standby);
  }
  // 硬切也把过渡期的变速与伴奏倾斜收掉，避免影响后面的整首播放。
  const cutBaseRate = baseDeckRate(plan.options);
  setDeckPlaybackRate(plan.options.standby, cutBaseRate);
  setDeckPlaybackRate(plan.options.active, cutBaseRate);
  plan.baseVolume = base;
  activePlan = null;
  debug.phase = 'done';
  debug.amActive = false;
  debug.reason = 'graph-hard-cut';
  debug.nextPrepared = false;
  debug.progress = 1;
  logEvent('graph-hard-cut', '淡化中途 Web Audio 图被激活，立即取消并硬切到下一首');
  try {
    plan.options.onFinish();
  } catch (err) {
    console.warn('[crossfade] onFinish failed', err);
  }
}

/** 取消准备 / 中止淡化：恢复 A 的音量、停住 B（B 的 src 由 player 清理）。 */
export function cancelCrossfade(reason = 'manual'): void {
  const plan = activePlan;
  activePlan = null;
  if (!plan) return;
  releaseSplitMix(plan, 'a');
  disposeAdvanced(plan);
  plan.cleanup?.();
  // 计划作废时 B 的起始 seek 监听也要撤掉，否则下次复用该元素会被旧目标改位置。
  cancelPendingSeek(plan.options.standby);
  if (plan.raf) {
    window.clearTimeout(plan.raf);
    plan.raf = 0;
  }
  if (plan.phase === 'fading') {
    const base = clamp01(plan.options.baseVolume());
    if (plan.graphMode) {
      setAudioTapVolume(base, true);
      releaseDeckFx(plan.options.active, 1);
      releaseDeckFx(plan.options.standby, 0);
      setDeckGraphTilt(plan.options.active, 0, 0);
      setDeckGraphTilt(plan.options.standby, 0, 0);
      setDeckGraphVocalFocus(plan.options.active, 0);
      setDeckGraphVocalFocus(plan.options.standby, 0);
      detachDeckFromGraph(plan.options.standby);
    } else {
      setDeckVolume(plan.options.active, base);
      setDeckVolume(plan.options.standby, 0);
    }
  } else if (plan.graphMode) {
    // 只准备未淡化：B 还在图外静音，摘掉即可。
    detachDeckFromGraph(plan.options.standby);
  }
  // 取消也要把过渡期的变速恢复，否则下一首会继承 B 的播放速率。
  const cancelBaseRate = baseDeckRate(plan.options);
  setDeckPlaybackRate(plan.options.standby, cancelBaseRate);
  setDeckPlaybackRate(plan.options.active, cancelBaseRate);
  debug.nextPrepared = false;
  try {
    plan.options.standby.pause();
  } catch {
    /* 忽略 */
  }
  debug.phase = 'canceled';
  debug.amActive = false;
  debug.reason = reason;
  debug.progress = 0;
  logEvent('cancel', reason);
}

/**
 * 开发者浮层用的实时快照（纯读，不改任何状态）。
 *
 * 为什么不把 `activePlan` 直接抛给 UI：
 * 1. 它是模块内私有状态，浮层拿到可变引用迟早会写出「浮层一开曲线就歪」这种 bug；
 * 2. 浮层要的是能直接显示的数（线性增益换 dB、滤波器读当前 Hz、活动度按播放位置采样），
 *    这些换算只该有一份实现；
 * 3. 快照必须是纯读的：任何写入都会在音频线程上多排一个 ramp，30 Hz 刷新会把曲线打乱。
 *
 * 位置统一用元素真实 `currentTime`（文件毫秒），与 `beatPhaseError` 同源 —— 那是唯一
 * 能反映 WSOLA 实际推进的时钟。
 */
export interface MixLayerSnapshot {
  /** 活动度 0–1（曲线缺失时为 null） */
  vocal: number | null;
  drum: number | null;
  bass: number | null;
}

export interface MixDeckSnapshot {
  title: string;
  /** 文件位置（毫秒） */
  posMs: number;
  /** 曲内位置（毫秒，已减掉 CUE 段起点） */
  songMs: number;
  durationMs: number;
  bpm: number;
  /** 当前位置的即时 BPM（走速度曲线；整曲恒定时等于 bpm） */
  bpmLive: number;
  key: string;
  camelot: string;
  /** 当前小节序号（1 起；算不出时为 0） */
  bar: number;
  /** 拍相位 0–1（0 = 正落在拍上） */
  beatPhase: number;
  /** 到下一拍的毫秒数 */
  nextBeatMs: number;
  layers: MixLayerSnapshot;
  /** 该侧的风格画像（分析增强已合并时为非空） */
  styleProfile: { primary: string; mood: string; confidence: number } | null;
  /** v2 链上的实际参数（没建链时为 null） */
  chain: {
    lowDb: number;
    highDb: number;
    splitHz: number;
    sweepLpHz: number;
    sweepHpHz: number;
    duckDb: number;
    /** 尾段渐隐补回：当前抬升量（dB，0 = 没抬） */
    unfadeDb: number;
    /** 元素门（结构桥接时被压到 0） */
    gate: number;
    /** 低频电平校准量（dB，只作用在 B 的低频支路） */
    lowTrimDb: number;
    /** 该侧低频支路当前 RMS 电平（dBFS，量不到时 −120） */
    lowLevelDb: number;
  } | null;
  playbackRate: number;
  /** 元素自身音色节点（dB / Hz）。v2 起链后会归零验证「原曲没被动过」。 */
  tone?: {
    bassDb: number;
    lowDb: number;
    highDb: number;
    presenceDb: number;
    lowpassHz: number;
    highpassHz: number;
  } | null;
}

export interface MixLiveSnapshot {
  phase: 'idle' | 'prepared' | 'fading' | 'done' | 'canceled';
  kind: 'auto' | 'manual' | 'loop' | null;
  progress: number;
  elapsedMs: number;
  fadeMs: number;
  barMs: number;
  totalBars: number;
  style: 'am' | 'equal' | 'cut';
  form: AutomixForm | null;
  handoff: boolean;
  vocalAligned: boolean;
  bassHandoffP: number;
  /** 低频换手窗口在淡化进度上的位置（无计划时为 null） */
  handoffWindow: [number, number] | null;
  /** A 保持原样到哪个进度（层 C 让位前） */
  aHoldP: number | null;
  tempoRate: number;
  tempoRateLive: number;
  pllActive: boolean;
  pllErrBeats: number;
  bridgeActive: boolean;
  bridge: { unitBars: number; passes: number; unitStartFileMs: number; extendedEndMs: number } | null;
  duckActive: boolean;
  duckEvents: number;
  /** 尾段混响参数（send/return dB）与是否已排程。 */
  reverb: { sendDb: number; returnDb: number; fromP: number; tailMs: number } | null;
  /** 混响送出量的实时值（dB；按当前进度算出的包络，null = 未排程） */
  reverbLive: { aSendDb: number; bSendDb: number; returnDb: number } | null;
  /** 短过渡的尾段回声（≤4.2 s 窗口才有）。 */
  echoLive: { divBeats: number; delayMs: number; feedback: number; outDb: number; tailMs: number; sendFromP: number; gain: number } | null;
  /** 本次选中的过渡手法（styleKit）：只读展示，不参与调度。 */
  technique: { id: TransitionStyleId; label: string; reasons: string[] } | null;
  /** 变速计划：起播速率、回正点（进度）、以及两首歌此刻的理论 BPM */
  tempo: { startRate: number; endRate: number; liveRate: number; restoreAt: number;
    bpmA: number | null; bpmB: number | null; bpmATarget: number | null; bpmBTarget: number | null; inverted?: boolean; sameTempo?: boolean } | null;
  /** 换手窗口（进度）与 B 的前奏长度（ms） */
  swap: { startP: number; endP: number; introMs: number } | null;
  /** 桥接类型：A 尾奏循环（loop）或 B 前奏循环（intro） */
  bridgeKind: 'loop' | 'intro' | null;
  /** 元素/图链总闸（1 = 正常出声，0 = 已静音） */
  gate: number;
  /** 尾段渐隐：识别结果（没有渐隐时为 null） */
  tailFade: { fadeStartMs: number; fadeEndMs: number; dropDb: number; maxLiftDb: number; refLufs: number } | null;
  /** A 当前被补回多少 dB（读 unfade 节点，实时） */
  aUnfadeDb: number;
  quality: {
    bassBumpDb: number;
    vocalOverlapBeats: number;
    loudnessDriftLu: number;
    rateJumpPctPerBeat: number;
    pass: boolean;
    failures: string[];
    suggestion: string[];
  } | null;
  reasons: string[];
  a: MixDeckSnapshot | null;
  b: MixDeckSnapshot | null;
  /** B 相对 A 的拍相位差（拍；正数 = B 超前） */
  phaseErrorBeats: number | null;
  /** 同一相位差换算成毫秒（听感上「差多少毫秒」比「差多少拍」直观） */
  phaseErrorMs: number | null;
  /** B 的有效 BPM 相对 A 的偏差百分比（含用户倍速） */
  bpmDeltaPct: number | null;
  /** 本次过渡采用的唱词锚点（文件毫秒）；没锚时为 null */
  vocalAnchor: { aLastEndMs: number; bEntryMs: number; kind?: 'vocal' | 'instrumental' | 'structure' | 'none'; melodySim?: number; instrumentalBars?: number } | null;
  /**
   * 器乐 A 用的结构接缝（最后一个乐句起点 → 强拍 → 结尾前 2 小节）。
   * 与 `fadeStartFile` 的差值能看出接缝有没有被「起点不能早于当前播放位置」这类兜底夹走。
   */
  instSeam?: { kind: string; ms: number; barsFromEnd: number } | null;
  note: string;
}

function linearToDb(value: number): number {
  if (!(value > 0)) return -120;
  return Math.max(-120, 20 * Math.log10(value));
}

/** 按文件毫秒采样一条活动度曲线（超范围给 null，不硬凑 0）。 */
function sampleLayer(curve: number[], hopMs: number, fileMs: number): number | null {
  if (!Array.isArray(curve) || curve.length === 0 || !(hopMs > 0)) return null;
  if (!Number.isFinite(fileMs) || fileMs < 0) return null;
  // 线性插值：宿主给的 activity 网格是 250ms 一格，直接取整会让浮层像「卡住不动」，
  // 插值后读数随播放连续变化（数据分辨率不变，只是显示不再跳格）。
  const exact = fileMs / hopMs;
  const index = Math.floor(exact);
  if (index < 0 || index >= curve.length) return null;
  const a = curve[index];
  const b = curve[index + 1];
  const t = exact - index;
  const value = Number.isFinite(b) && t > 0 ? a + (b - a) * t : a;
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function deckSnapshot(
  element: HTMLAudioElement,
  analysis: BeatAnalysis | undefined,
  startMs: number,
  title: string,
  durationMs: number,
  chain: AutomixV2Deck | null,
): MixDeckSnapshot {
  const elMs = Number.isFinite(element.currentTime) ? element.currentTime * 1000 : 0;
  const posMs = Math.max(0, elMs);
  const beat = analysis?.beatIntervalMs ?? 0;
  const first = analysis?.firstBeatMs ?? 0;
  const barMs = beat > 0 ? beat * (analysis?.meter || 4) : 0;
  let bar = 0;
  let beatPhase = 0;
  let nextBeatMs = 0;
  if (beat > 0) {
    const phaseRaw = (posMs - first) / beat;
    beatPhase = phaseRaw - Math.floor(phaseRaw);
    nextBeatMs = (1 - beatPhase) * beat;
    if (barMs > 0) {
      bar = Math.floor(Math.max(0, posMs - (analysis?.firstDownbeatMs ?? first)) / barMs) + 1;
    }
  }
  const hop = analysis?.activity?.hopMs ?? 0;
  return {
    title,
    posMs: Math.round(posMs),
    songMs: Math.round(Math.max(0, posMs - startMs)),
    durationMs: Math.round(durationMs),
    bpm: Math.round((analysis?.bpm ?? 0) * 10) / 10,
    bpmLive: analysis ? Math.round(tempoAtMs(undefined, analysis, posMs) * 10) / 10 : 0,
    key: analysis?.key === undefined || analysis?.key === null ? '' : String(analysis.key),
    camelot: analysis?.camelot === undefined || analysis?.camelot === null ? '' : String(analysis.camelot),
    bar,
    beatPhase: Math.round(beatPhase * 1000) / 1000,
    nextBeatMs: Math.round(nextBeatMs),
    layers: {
      vocal: sampleLayer(analysis?.activity?.vocal ?? [], hop, posMs),
      drum: sampleLayer(analysis?.activity?.drum ?? [], hop, posMs),
      bass: sampleLayer(analysis?.activity?.bass ?? [], hop, posMs),
    },
    styleProfile: analysis?.styleProfile
      ? {
          primary: analysis.styleProfile.primary,
          mood: analysis.styleProfile.mood,
          confidence: Math.round(analysis.styleProfile.confidence * 100) / 100,
        }
      : null,
    chain: chain
      ? {
          lowDb: Math.round(linearToDb(chain.lowGain.gain.value) * 10) / 10,
          highDb: Math.round(linearToDb(chain.highGain.gain.value) * 10) / 10,
          splitHz: V2_CROSSOVER_HZ,
          sweepLpHz: Math.round(chain.sweepLp.frequency.value),
          sweepHpHz: Math.round(chain.sweepHp.frequency.value),
          duckDb: Math.round(chain.duck.gain.value * 10) / 10,
          unfadeDb: Math.round(linearToDb(chain.unfade.gain.value) * 10) / 10,
          gate: Math.round(chain.tap.gate.gain.value * 100) / 100,
          lowTrimDb: Math.round(linearToDb(chain.lowTrim.gain.value) * 10) / 10,
          lowLevelDb: Math.round(linearToDb(measureLowRms(chain)) * 10) / 10,
        }
      : null,
    tone: readDeckTone(element),
    playbackRate: Math.round((element.playbackRate || 1) * 1000) / 1000,
  };
}

/** 开发者浮层用的实时快照：任何时候都能调，空闲时给 phase='idle' 的最小对象。 */
export function crossfadeLiveSnapshot(): MixLiveSnapshot {
  const plan = activePlan;
  const base: MixLiveSnapshot = {
    phase: debug.phase,
    kind: debug.crossfadeKind,
    progress: Math.round(clamp01(debug.progress) * 1000) / 1000,
    elapsedMs: 0,
    fadeMs: Math.round(debug.fadeMs),
    barMs: Math.round(debug.autoBarMs),
    totalBars: debug.autoBars,
    style: debug.styleResolved,
    form: plan?.form ?? null,
    handoff: debug.handoff,
    vocalAligned: debug.vocalAligned,
    bassHandoffP: Math.round(debug.bassHandoffP * 1000) / 1000,
    handoffWindow: null,
    aHoldP: null,
    tempoRate: Math.round(debug.tempoRate * 1000) / 1000,
    tempoRateLive: Math.round(debug.tempoRateLive * 1000) / 1000,
    pllActive: debug.pllActive,
    pllErrBeats: Math.round(debug.pllErrBeats * 1000) / 1000,
    bridgeActive: Boolean(plan?.v2?.bridge),
    bridge: null,
    duckActive: false,
    duckEvents: plan?.v2Duck?.length ?? 0,
    reverb: plan?.reverb ?? null,
    reverbLive: (() => {
      const rv = plan?.reverb;
      if (!rv) return null;
      const p = Math.max(0, Math.min(1, debug.progress));
      const gainAt = (fromP: number): number => {
        const from = Math.min(0.95, Math.max(0, fromP));
        if (p <= from) return 0;
        return Math.min(1, (p - from) / Math.max(0.05, 1 - from));
      };
      const aGain = gainAt(rv.fromP);
      const bGain = gainAt(Math.min(0.85, rv.fromP + 0.3));
      const toDb = (sendDb: number, g: number): number => (g <= 0.001 ? -120 : Math.round((sendDb + 20 * Math.log10(g)) * 10) / 10);
      return { aSendDb: toDb(rv.sendDb, aGain), bSendDb: toDb(rv.sendDb - 9, bGain), returnDb: rv.returnDb };
    })(),
    echoLive: (() => {
      const ec = plan?.echo;
      if (!ec || !ec.enabled) return null;
      const p = Math.max(0, Math.min(1, debug.progress));
      const from = Math.min(0.95, Math.max(0, ec.sendFromP));
      const gain = p <= from ? 0 : Math.min(1, (p - from) / Math.max(0.05, 1 - from));
      return { divBeats: ec.divBeats, delayMs: ec.delayMs, feedback: ec.feedback, outDb: ec.outDb, tailMs: ec.tailMs, sendFromP: ec.sendFromP, gain };
    })(),
    technique: plan?.styleId
      ? {
          id: plan.styleId,
          label: describeStyle(plan.styleId),
          reasons: plan.styleReasons ? [...plan.styleReasons] : [],
        }
      : null,
    tempo: null,
    swap: null,
    bridgeKind: null,
    gate: 1,
    tailFade: null,
    aUnfadeDb: 0,
    quality: null,
    reasons: plan?.decision?.reasons ? [...plan.decision.reasons] : [],
    a: null,
    b: null,
    phaseErrorBeats: null,
    phaseErrorMs: null,
    bpmDeltaPct: null,
    vocalAnchor: null,
    note: debug.autoNote,
  };
  if (!plan) return base;

  const options = plan.options as Partial<CrossfadePrepareOptions>;
  base.a = deckSnapshot(
    plan.options.active,
    options.currentAnalysis?.analysis,
    (options.current?.startAt ?? 0) * 1000,
    options.current?.track?.title ?? debug.currentTitle,
    options.currentDurationMs ?? 0,
    plan.v2?.a ?? null,
  );
  base.b = deckSnapshot(
    plan.options.standby,
    options.nextAnalysis?.analysis,
    (options.next?.startAt ?? 0) * 1000,
    options.next?.track?.title ?? debug.nextTitle,
    options.next?.track?.durationMs ?? options.nextAnalysis?.durationMs ?? 0,
    plan.v2?.b ?? null,
  );

  const rate0 = Math.round((plan.tempoRate || 1) * 1000) / 1000;
  const live0 = Math.round((debug.tempoRateLive || plan.tempoRate || 1) * 1000) / 1000;
  // 目标 = 下一首时，被拉的是 A：A 的速率 = 1/tempoRate，B 保持 1.0。
  const inv = Boolean(plan.tempoInverted);
  const aRate = inv ? Math.round((1 / Math.max(0.5, rate0)) * 1000) / 1000 : 1;
  base.tempo = {
    startRate: inv ? aRate : rate0,
    endRate: 1,
    liveRate: inv ? Math.round((1 / Math.max(0.5, live0)) * 1000) / 1000 : live0,
    restoreAt: MATCHED_OVERLAP_END,
    bpmA: base.a?.bpm || null,
    bpmB: base.b?.bpm || null,
    bpmATarget: base.a?.bpm && inv ? Math.round(base.a.bpm * aRate * 10) / 10 : base.a?.bpm || null,
    bpmBTarget: !inv && base.b?.bpm ? Math.round(base.b.bpm * rate0 * 10) / 10 : base.b?.bpm || null,
    inverted: inv,
    /** 两首同速：真的同速才这么说。BPM 差很大但引擎选择不拉拍时，不能报「同速」。 */
    sameTempo:
      Math.abs(rate0 - 1) < 0.004 &&
      (!base.a?.bpm || !base.b?.bpm || Math.abs(base.a.bpm / base.b.bpm - 1) < 0.01),
  };
  base.gate = Math.round((plan.v2?.a.tap.gate.gain.value ?? 1) * 100) / 100;
  base.bridgeKind = plan.v2?.introBridge ? 'intro' : plan.v2?.bridge ? 'loop' : null;

  const v2 = plan.v2Plan ?? plan.v2?.plan ?? null;
  if (v2) {
    base.handoffWindow = [Math.round(v2.handoffStartP * 1000) / 1000, Math.round(v2.handoffP * 1000) / 1000];
    const nextStartMs = Math.round((options.next?.startAt ?? 0) * 1000);
    base.swap = {
      startP: Math.round(v2.handoffStartP * 1000) / 1000,
      endP: Math.round(v2.handoffP * 1000) / 1000,
      introMs: Math.max(0, Math.round(plan.bStartFileMs - nextStartMs)),
    };
    base.aHoldP = Math.round(v2.aHoldP * 1000) / 1000;
    base.totalBars = v2.totalBars;
  }
  if (plan.bridge) {
    base.bridge = {
      unitBars: plan.bridge.unitBars,
      passes: plan.bridge.passes,
      unitStartFileMs: Math.round(plan.bridge.unitStartFileMs),
      extendedEndMs: Math.round(plan.bridge.extendedEndMs),
    };
  }
  if (plan.quality) {
    base.quality = {
      bassBumpDb: Math.round(plan.quality.bassBumpDb * 10) / 10,
      vocalOverlapBeats: Math.round(plan.quality.vocalOverlapBeats * 100) / 100,
      loudnessDriftLu: Math.round(plan.quality.loudnessDriftLu * 10) / 10,
      rateJumpPctPerBeat: Math.round(plan.quality.rateJumpPctPerBeat * 100) / 100,
      pass: plan.quality.pass,
      failures: [...plan.quality.failures],
      suggestion: [
        plan.quality.suggestion.widenHandoff ? '加宽换手窗口' : '',
        plan.quality.suggestion.enableVocalDuck ? '开启人声让位' : '',
        plan.quality.suggestion.shortenFade ? '缩短过渡' : '',
        plan.quality.suggestion.gainTrimDb !== 0
          ? `响度补偿 ${plan.quality.suggestion.gainTrimDb.toFixed(1)} dB`
          : '',
        plan.quality.suggestion.tempoRate !== 1
          ? `建议速率 ${plan.quality.suggestion.tempoRate.toFixed(3)}`
          : '',
      ].filter(Boolean),
    };
  }
  const elapsed = plan.phase === 'fading' ? clamp01(debug.progress) * plan.fadeMs : 0;
  const err = beatPhaseError(plan, elapsed, base.tempoRateLive);
  base.phaseErrorBeats = err === null ? null : Math.round(err * 1000) / 1000;
  const beatMsNow = options.nextAnalysis?.analysis?.beatIntervalMs ?? options.currentAnalysis?.analysis?.beatIntervalMs ?? 0;
  base.phaseErrorMs = err === null || beatMsNow <= 0 ? null : Math.round(err * beatMsNow);
  if (base.a && base.b && base.a.bpmLive > 0 && base.b.bpmLive > 0) {
    const effectiveB = base.b.bpmLive * base.tempoRateLive;
    base.bpmDeltaPct = Math.round(((effectiveB - base.a.bpmLive) / base.a.bpmLive) * 1000) / 10;
  }
  if (plan.vocalAnchor) {
    base.vocalAnchor = {
      aLastEndMs: Math.round(plan.vocalAnchor.aLastEndMs),
      bEntryMs: Math.round(plan.vocalAnchor.bEntryMs),
      kind: plan.vocalAnchor.kind ?? 'vocal',
      melodySim: plan.vocalAnchor.melodySim ?? 0,
      instrumentalBars: plan.vocalAnchor.instrumentalBars ?? 0,
    };
  }
  base.elapsedMs = Math.round(elapsed);
  // 让位是否真的在压：A 侧（A 唱时压自己）与 B 侧（B 早唱时压 B）都是 1.5–4 kHz 峰值滤波，
  // 但以前只看 A 侧，于是「B 一开播就唱」那 88 对（ENTRY_DUCKED）在浮层上永远显示「—」。
  const duckA = plan.v2?.a ? plan.v2.a.duck.gain.value : 0;
  const duckB = plan.v2?.b ? plan.v2.b.duck.gain.value : 0;
  base.duckActive = Math.min(duckA, duckB) < -0.3;
  base.duckEvents = (plan.v2Duck?.length ?? 0) + (plan.bDuck?.length ?? 0);
  if (plan.tailFade) {
    base.tailFade = {
      fadeStartMs: plan.tailFade.fadeStartMs,
      fadeEndMs: plan.tailFade.fadeEndMs,
      dropDb: plan.tailFade.dropDb,
      maxLiftDb: plan.tailFade.maxLiftDb,
      refLufs: plan.tailFade.refLufs,
    };
  }
  base.aUnfadeDb = plan.v2?.a ? Math.max(0, Math.round(linearToDb(plan.v2.a.unfade.gain.value) * 10) / 10) : 0;
  return base;
}

/** 当前是否正在交叉淡化（tick / 音量更新走不同路径）。 */
export function crossfadeRemainingMs(): number {
  return activePlan?.phase === 'fading' ? Math.max(0, (1 - activePlan.progress) * activePlan.fadeMs) : 0;
}

export function crossfadeProgress(): number {
  return activePlan?.phase === 'fading' ? activePlan.progress : 0;
}

export function crossfadeIsFading(): boolean {
  return activePlan !== null && activePlan.phase === 'fading';
}

/** 是否有已准备好的计划（调试/QA 用）。 */
export function crossfadeIsPrepared(): boolean {
  return activePlan !== null && activePlan.phase === 'prepared';
}

/** 用户音量变化时按当前进度重算两 deck 音量（淡出淡入过程中不能被音量更新打断）。 */
export function crossfadeApplyVolume(baseVolume: number): void {
  const plan = activePlan;
  if (!plan || plan.phase !== 'fading') return;
  plan.baseVolume = clamp01(baseVolume);
  // 图内增益已排在音频时间线上，不能用音量修改覆盖自动化；
  // 只把主音量（本地 gain）同步过去。
  if (plan.graphMode) {
    setAudioTapVolume(plan.baseVolume, true);
    return;
  }
  applyEqualPowerGains(plan, plan.progress);
}

/**
 * 立即收尾（A 的 ended 事件比最后一帧 rAF 先到等）：B 直接满音量并交给 player 交换。
 * 返回 false = 当前没有进行中的淡化。
 */
/**
 * v2 结构桥接正在接管 A 的尾段（A 的元素已经放完，但过渡还没走完）。
 * 此时 A 的 `ended` 不能触发「立刻收尾到 B」，否则桥接补出来的那几小节会被切掉。
 */
/** A 的器乐尾巴正在窗口之后铺着（这期间 onEnded 不能把它当成"放完了"）。 */
export function crossfadeTailBleedActive(): boolean {
  return Boolean(activePlan && activePlan.aTailBleedMs && activePlan.aTailBleedMs > 0
    && activePlan.phase === 'fading');
}

export function crossfadeBridgeActive(): boolean {
  return Boolean(activePlan?.v2?.bridge);
}

/**
 * A 尾自延长是否正在响：播放器 `ended` 守卫必须等它走完再收尾，
 * 否则元素一结束就把整条链拆掉，延长 buffer 会被硬切。
 */
export function crossfadeExtensionActive(): boolean {
  return extensionActive() || activePlan?.v2?.extension?.active === true;
}

export function crossfadeFinishNow(reason = 'ended'): boolean {
  const plan = activePlan;
  if (!plan || plan.phase !== 'fading') return false;
  if (!plan.timelineReady) {
    cancelCrossfade('b-not-ready');
    return false;
  }
  logEvent('force-finish', reason);
  finishFade(plan);
  return true;
}

/**
 * 用户播放倍速变化（Phase 2 D）时调用：把新的基础速率立即应用到两个 deck。
 * 过渡中 B 的速率 = 用户倍速 × 本次 tempoRate；没有过渡计划时由 player 自己设置两 deck。
 */
export function crossfadeApplyPlaybackRate(): void {
  const plan = activePlan;
  if (!plan) return;
  const rate = baseDeckRate(plan.options);
  cancelCrossfade('rate-change');
  setDeckPlaybackRate(plan.options.active, rate);
  setDeckPlaybackRate(plan.options.standby, rate);
}

/* ------------------------------------------------------------------ */
/* 设置 UI（播放页「无缝衔接（实验）」区块）                            */
/* ------------------------------------------------------------------ */

/** 快捷设置同款分段滑块：选中项底下有一枚跟随滑动的白色药丸。 */
interface SegmentedControl<T> {
  root: HTMLDivElement;
  buttons: Array<{ value: T; button: HTMLButtonElement }>;
  paint: (selected: T, animate?: boolean) => void;
  setDisabled: (disabled: boolean) => void;
  /** 释放内部 ResizeObserver（设置页每次重推都整页重建）。 */
  dispose: () => void;
}

function segmentedControl<T extends string | number | boolean>(options: {
  qa: string;
  dataAttr: string;
  items: ReadonlyArray<{ value: T; label: string; title?: string }>;
  onPick: (value: T) => void;
}): SegmentedControl<T> {
  const thumb = h('div', { class: 'quick-seg-thumb' });
  const buttons = options.items.map((item) => {
    const button = h('button', {
      class: 'quick-seg-btn',
      type: 'button',
      'data-qa': `${options.qa}-item`,
      [options.dataAttr]: String(item.value),
      title: item.title ?? item.label,
      text: item.label,
    });
    button.addEventListener('click', () => options.onPick(item.value));
    return { value: item.value, button };
  });
  const root = h(
    'div',
    { class: 'quick-seg-slider crossfade-seg', 'data-qa': options.qa },
    thumb,
    ...buttons.map((item) => item.button),
  );
  let selected: T | null = null;
  const place = (animate: boolean): void => {
    const active = buttons.find((item) => item.value === selected)?.button;
    if (!active) return;
    if (!animate) thumb.style.transition = 'none';
    thumb.style.width = `${active.offsetWidth}px`;
    thumb.style.transform = `translateX(${active.offsetLeft}px)`;
    if (!animate) {
      window.requestAnimationFrame(() => {
        thumb.style.transition = '';
      });
    }
  };
  const paint = (value: T, animate = true): void => {
    selected = value;
    for (const item of buttons) {
      const on = item.value === value;
      item.button.classList.toggle('is-on', on);
      item.button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    place(animate);
  };
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    // 设置面板/窗口宽度变化时跟着重排药丸，否则会停在旧位置。
    observer = new ResizeObserver(() => place(false));
    observer.observe(root);
  }
  const dispose = (): void => {
    // 设置页每次重推都整页重建，observer 不释放就是无界堆积（每页 15~16 个）。
    observer?.disconnect();
    observer = null;
  };
  return {
    root,
    buttons,
    paint,
    dispose,
    setDisabled: (disabled) => {
      root.classList.toggle('is-disabled', disabled);
      for (const item of buttons) item.button.disabled = disabled;
    },
  };
}

/**
 * 构造播放页「无缝衔接（实验）」区块；scope 用于设置弹窗关闭时退订。
 * QA 钩子：crossfade-section / crossfade-toggle / crossfade-length（每个选项带 data-length）。
 * 所有选项统一成快捷设置同款的分段滑块：白色药丸跟随选中项滑动。
 */
export function buildCrossfadeSection(scope: Disposers | null): HTMLElement {
  const enableRow = segmentedControl<boolean>({
    qa: 'crossfade-toggle',
    dataAttr: 'data-enabled',
    items: [
      { value: false, label: '关闭', title: '关闭后行为与之前完全一致' },
      { value: true, label: '开启', title: '开启后下一首按鼓点交叉淡化' },
    ],
    onPick: (value) => {
      writeCrossfadeSettings({ enabled: value });
      paint();
      toast(value ? '无缝衔接已开启：下一首会按鼓点交叉淡化' : '无缝衔接已关闭');
    },
  });
  const showPreviewRow = segmentedControl<boolean>({
    qa: 'crossfade-preview-card',
    dataAttr: 'data-show-preview',
    items: [
      { value: false, label: '关闭', title: '不显示播放条上方的过渡预告小卡' },
      {
        value: true,
        label: '开启',
        title: '在播放条右下「下一首」小卡里显示这次怎么过渡；进入准备阶段后显示实际淡化起点',
      },
    ],
    onPick: (value) => {
      writeCrossfadeSettings({ showPreview: value });
      paint();
      toast(value ? '过渡预告：已开启（播放条上方显示下一首怎么过渡）' : '过渡预告：已关闭');
    },
  });
  const lengthModeRow = segmentedControl<CrossfadeLengthMode>({
    qa: 'crossfade-length',
    dataAttr: 'data-length',
    items: LENGTH_MODE_VALUES.map((value) => ({
      value,
      label:
        value === 'auto'
          ? '自动'
          : value === 'seconds'
            ? '秒'
            : value === 'beats'
              ? '拍'
              : value === 'bars'
                ? '小节'
                : '乐句',
      title:
        value === 'auto'
          ? '自动：按两首歌的拍点/小节与前后奏空间自由决定，不再固定 5–10 秒'
          : value === 'seconds'
            ? '按秒数固定交叉淡化时长（3–30 秒）'
            : value === 'beats'
              ? '按真实拍点换算：BPM 附近变速时长度仍然对拍'
              : value === 'bars'
                ? '按小节换算（用 A 在过渡处的局部速度，变速歌也准）'
                : '按一个乐句（4 小节，小节很短时 8 小节）换算',
    })),
    onPick: (value) => {
      writeCrossfadeSettings({ lengthMode: value });
      paint();
      toast(
        value === 'auto'
          ? '过渡长度：自动（按拍点/小节与结构空间自适应）'
          : value === 'seconds'
            ? '过渡长度：按秒数'
            : value === 'beats'
              ? '过渡长度：按真实拍点（变速歌按局部速度换算）'
              : value === 'bars'
                ? '过渡长度：按小节（局部速度换算）'
                : '过渡长度：一个乐句（4 小节，短小节 8 小节）',
      );
    },
  });
  const lengthValueHost = h('div', { class: 'crossfade-seg-stack' });
  let lengthValueSeg: SegmentedControl<number> | null = null;
  let lengthValueMode: CrossfadeLengthMode | null = null;

  /** 按当前单位重建数值档位（秒 / 拍 / 小节；乐句与自动不显示）。 */
  function rebuildLengthValues(settings: CrossfadeSettings): void {
    if (lengthValueMode === settings.lengthMode) return;
    lengthValueMode = settings.lengthMode;
    lengthValueSeg?.dispose();
    lengthValueSeg = null;
    const choices =
      settings.lengthMode === 'seconds'
        ? CROSSFADE_LENGTH_CHOICES
        : settings.lengthMode === 'beats'
          ? CROSSFADE_BEAT_CHOICES
          : settings.lengthMode === 'bars'
            ? CROSSFADE_BAR_CHOICES
            : [];
    if (choices.length === 0) {
      lengthValueHost.replaceChildren();
      lengthValueHost.hidden = true;
      lengthValueSeg = null;
      return;
    }
    lengthValueHost.hidden = false;
    const unit = settings.lengthMode === 'seconds' ? ' 秒' : settings.lengthMode === 'beats' ? ' 拍' : ' 小节';
    const seg = segmentedControl<number>({
      qa: 'crossfade-length-value',
      dataAttr: 'data-length-value',
      items: choices.map((value) => ({ value, label: `${value}${unit}` })),
      onPick: (value) => {
        writeCrossfadeSettings({ lengthValue: value });
        paint();
      },
    });
    lengthValueHost.replaceChildren(seg.root);
    lengthValueSeg = seg;
    seg.paint(settings.lengthValue, false);
  }

  const styleRow = segmentedControl<CrossfadeStyle>({
    qa: 'crossfade-style',
    dataAttr: 'data-style',
    items: STYLE_VALUES.map((value) => ({
      value,
      label: value === 'auto' ? '自动判断' : value === 'am' ? '交融' : value === 'equal' ? '等功率' : '快速切入',
      title:
        value === 'auto'
          ? '自动判断：节拍可靠且速度可对齐时自然融合，否则短过渡'
          : value === 'am'
            ? '交融：A 的低通从 20k 扫到 2.3k、B 的高通从 10k 扫到 20 Hz，低频按小节线交接'
            : value === 'equal'
              ? '等功率：互补增益平滑交接，保持原有音色'
              : '快速切入：1–2 小节内完成，适合调性/BPM 明显冲突的两首',
    })),
    onPick: (value) => {
      writeCrossfadeSettings({ style: value });
      paint();
      toast(
        value === 'auto'
          ? '过渡风格：自动判断（调性/BPM 冲突时快速切入）'
          : value === 'am'
            ? '过渡风格：交融（互补滤波 + 低频交接）'
            : value === 'equal'
              ? '过渡风格：等功率'
              : '过渡风格：快速切入',
      );
    },
  });
  const presetRow = segmentedControl<CrossfadePreset>({
    qa: 'crossfade-preset',
    dataAttr: 'data-preset',
    items: PRESET_VALUES.map((value) => ({
      value,
      label: value === 'balanced' ? '两者兼顾' : value === 'full' ? '完整播放' : '频繁切歌',
      title:
        value === 'balanced'
          ? '两者兼顾（默认）：4 小节过渡，重视结构又不太拖沓'
          : value === 'full'
            ? '完整播放：8 小节过渡，尽量放完整段副歌/尾奏，适合听专辑'
            : '频繁切歌：4 小节 + 快速切入优先，适合一直切歌的小小节',
    })),
    onPick: (value) => {
      writeCrossfadeSettings({ preset: value });
      paint();
      toast(
        value === 'balanced'
          ? '场景：两者兼顾（4 小节过渡）'
          : value === 'full'
            ? '场景：完整播放（8 小节过渡）'
            : '场景：频繁切歌（短过渡优先）',
      );
    },
  });
  const cueRow = segmentedControl<CrossfadeCueMode>({
    qa: 'crossfade-cue',
    dataAttr: 'data-cue',
    items: CUE_MODE_VALUES.map((value) => ({
      value,
      label: value === 'auto' ? '自动' : value === 'drop' ? '进 drop' : value === 'chorus' ? '进副歌' : '进 intro 后',
      title:
        value === 'auto'
          ? '自动：B 从曲首进，A 的尾奏一边放一边交叠，尾奏播完或 B 的首句唱词开始时完成过渡'
          : value === 'drop'
            ? 'B 从首个 drop 进场（最强段），没有 drop 时回退副歌'
            : value === 'chorus'
              ? 'B 从首个副歌进场，适合缺少 drop 的流行歌'
              : 'B 等 intro 放完再进（最保守），适合前奏本身是 hook 的歌',
    })),
    onPick: (value) => {
      writeCrossfadeSettings({ cueMode: value });
      paint();
      toast(
        value === 'auto'
          ? '入场时机：自动（B 从曲首进，接上一首尾部）'
          : value === 'drop'
            ? '入场时机：B 从 drop 进'
            : value === 'chorus'
              ? '入场时机：B 从副歌进'
              : '入场时机：B 等 intro 放完再进',
      );
    },
  });
  const barsHint = h('div', {
    class: 'field-hint',
    text: '自动 = 跟随场景预设（4 或 8 小节）；固定 4 / 8 / 16 小节适合结构明确的电子/舞曲',
  });
  const barsRow = segmentedControl<CrossfadeBars>({
    qa: 'crossfade-bars',
    dataAttr: 'data-bars',
    items: BARS_VALUES.map((value) => ({
      value,
      label: value === 'auto' ? '自动' : `${value} 小节`,
      title: value === 'auto' ? '自动：按场景预设取 4 或 8 小节' : `固定 ${value} 小节完成过渡`,
    })),
    onPick: (value) => {
      writeCrossfadeSettings({ bars: value });
      paint();
      toast(value === 'auto' ? '过渡长度：自动（跟随场景预设）' : `过渡长度：${value} 小节`);
    },
  });
  const alignmentRow = segmentedControl<CrossfadeAlignment>({
    qa: 'crossfade-align',
    dataAttr: 'data-align',
    items: ALIGNMENT_VALUES.map((value) => ({
      value,
      label: value === 'beats' ? '拍点' : '小节',
      title:
        value === 'beats'
          ? '过渡起点/终点吸附到分析出的真实拍点（默认）：鼓点咬合更紧，慢歌/自由前奏也不容易错半拍'
          : '只吸附强拍/小节线：变化更少、听感更接近旧版，适合本来就规整的舞曲',
    })),
    onPick: (value) => {
      writeCrossfadeSettings({ alignment: value });
      paint();
      toast(value === 'beats' ? '拍点对齐：过渡起终点吸附到真实拍点' : '对齐精度：只吸附强拍/小节线');
    },
  });
  const bassRow = segmentedControl<CrossfadeBassSwap>({
    qa: 'crossfade-bass',
    dataAttr: 'data-bass',
    items: BASS_SWAP_VALUES.map((value) => ({
      value,
      label: value === 'off' ? '关闭' : value === 'bar1' ? '第 1 小节' : '第 2 小节',
      title:
        value === 'off'
          ? '关闭低频交接：两首低频不互换（少数情况下更自然），一般不建议'
          : `B 进场后第 ${value === 'bar1' ? 1 : 2} 小节做低频交接（底鼓换手），落小节线`,
    })),
    onPick: (value) => {
      writeCrossfadeSettings({ bassSwap: value });
      paint();
      toast(value === 'off' ? '低频交接：关闭' : `低频交接：B 第 ${value === 'bar1' ? 1 : 2} 小节`);
    },
  });
  const tempoRow = segmentedControl<CrossfadeTempoRange>({
    qa: 'crossfade-tempo',
    dataAttr: 'data-tempo',
    items: TEMPO_RANGE_VALUES.map((value) => ({
      value,
      label: value === 0 ? '关闭' : `±${Math.round(value * 100)}%`,
      title:
        value === 0
          ? '关闭变速：两首 BPM 不同时不做 beatmatch'
          : `BPM 对齐时允许最多 ±${Math.round(value * 100)}% 的变速（越大越准，过大会听出变调感）`,
    })),
    onPick: (value) => {
      writeCrossfadeSettings({ tempoRange: value });
      paint();
      toast(value === 0 ? 'BPM 对齐：关闭' : `BPM 对齐：最多 ±${Math.round(value * 100)}%`);
    },
  });
  const loudnessRow = segmentedControl<boolean>({
    qa: 'crossfade-loudness',
    dataAttr: 'data-loudness',
    items: [
      { value: false, label: '关闭', title: '不按 LUFS 预调 B 的增益' },
      {
        value: true,
        label: '开启',
        title: '按两首分析出的 LUFS 预调 B 的增益（±6 dB 内），避免下一首明显更轻或更响（需要两首都已分析）',
      },
    ],
    onPick: (value) => {
      writeCrossfadeSettings({ loudnessMatch: value });
      paint();
      toast(value ? '响度对齐：已开启（B 按 LUFS 预调 ±6 dB）' : '响度对齐：已关闭');
    },
  });
  const handoffRow = segmentedControl<boolean>({
    qa: 'crossfade-handoff',
    dataAttr: 'data-handoff',
    items: [
      { value: false, label: '关闭', title: '按拍点/小节普通淡化' },
      {
        value: true,
        label: '开启',
        title: '利用尾奏和下一首前奏完成交接，第一句开始前完成淡入（需要自动时长）',
      },
    ],
    onPick: (value) => {
      writeCrossfadeSettings({ handoff: value });
      paint();
      toast(
        value
          ? '歌词衔接已开启：从首句之前淡入，保护首句完整性'
          : '歌词衔接已关闭：恢复按拍点/小节普通淡化',
      );
    },
  });
  /**
   * 混音过渡：标准 / 进阶 v2 二选一。
   * 两条路在音频图层面就是互斥的（v2 自己挂分频链，标准路径节点零改动），
   * 所以这里只切一个键，不做任何「强度」连续调节 —— 出问题切回标准即完全回到旧行为。
   */
  const mixRow = segmentedControl<MixTransitionMode>({
    qa: 'crossfade-mix-engine',
    dataAttr: 'data-mix-mode',
    items: [
      {
        value: 'auto',
        label: '自动',
        title: '按两首的拍点、置信度、速度差、调性与活动度选：够格走进阶 v2，否则退回标准',
      },
      {
        value: 'standard',
        label: '标准',
        title: '整轨等功率交叉：与旧版逐样本一致，不做低频换手、不加扫频',
      },
      {
        value: 'automixV2',
        label: '进阶 v2',
        title:
          '按末句、拍点与前奏选择交接位置',
      },
    ],
    onPick: (value) => {
      writeMixTransitionMode(value);
      paint();
      toast(value === 'automixV2' ? '混音过渡：进阶 v2' : value === 'auto' ? '混音过渡：自动（按两首判断）' : '混音过渡：标准（整轨等功率）');
    },
  });
  const mixField = h(
    'div',
    { class: 'field' },
    h(
      'div',
      {},
      h('div', { class: 'field-label', text: '混音过渡' }),
      h('div', {
        class: 'field-hint',
        text: '智能接歌根据节拍、人声和和声选择自然换曲的位置。',
      }),
    ),
    mixRow.root,
  );


  /**
   * 接唱点：过渡的**终点**锚到下一首的哪个唱词时段。
   * 以前这一步只能靠歌词（没歌词就整段失效）；现在 v2 用 activity.vocal 自己找，
   * 所以「从副歌人声进来」这种自由衔接也能做了。
   */
  const vocalRow = segmentedControl<VocalAnchorMode>({
    qa: 'crossfade-vocal-anchor',
    dataAttr: 'data-vocal-anchor',
    items: [
      { value: 'auto', label: '自动', title: '有歌词用歌词首句，没有就用活动度曲线的首句' },
      { value: 'first', label: '首句', title: '下一首的第一句人声：最稳，与人声不叠' },
      { value: 'chorus', label: '副歌', title: '副歌/高潮段开头的唱句：直接切进最抓耳的地方' },
      { value: 'strongest', label: '最强', title: '活动度最高的唱句（通常是副歌最饱满那句）' },
      { value: 'off', label: '关闭', title: '不锚唱词，纯按小节与结构混' },
    ],
    onPick: (value) => {
      writeCrossfadeSettings({ vocalAnchor: value });
      paint();
      toast(`接唱点：${value === 'off' ? '关闭' : value === 'auto' ? '自动' : value === 'first' ? '首句' : value === 'chorus' ? '副歌' : '最强'}`);
    },
  });
  const vocalField = h(
    'div',
    { class: 'field' },
    h(
      'div',
      {},
      h('div', { class: 'field-label', text: '接唱点' }),
      h('div', {
        class: 'field-hint',
        text: '进阶 v2 把淡化终点对准下一首的这个唱词时段：选「副歌」时 B 的前奏/主歌会先垫在 A 下面，淡化正好落在开唱那一刻；仅在长度=自动且进阶 v2 生效',
      }),
    ),
    vocalRow.root,
  );

  /**
   * 最短混音：保证过渡有一段真正的时间用来做「乐器穿插 + 低频交接」，
   * 而不是被 A 的短尾奏压成 1–3 秒（那和没混一样）。
   */
  const floorRow = segmentedControl<CrossfadeMixFloor>({
    qa: 'crossfade-mix-floor',
    dataAttr: 'data-mix-floor',
    items: [
      { value: 'auto', label: '自动', title: '跟随场景预设：频繁切歌 6 s / 兼顾 12 s / 完整播放 20 s' },
      { value: 6, label: '6s', title: '最短 6 秒：约 3 小节，够做一次换手' },
      { value: 12, label: '12s', title: '最短 12 秒：约一个乐句，能听出「两首歌同时在」' },
      { value: 20, label: '20s', title: '最短 20 秒：约两个乐句，接近俱乐部混音' },
      { value: 30, label: '30s', title: '最短 30 秒：长混音，适合氛围/慢歌' },
    ],
    onPick: (value) => {
      writeCrossfadeSettings({ mixFloor: value });
      paint();
      toast(`最短混音：${value === 'auto' ? '自动' : `${value} 秒`}`);
    },
  });
  const floorField = h(
    'div',
    { class: 'field' },
    h(
      'div',
      {},
      h('div', { class: 'field-label', text: '最短混音' }),
      h('div', {
        class: 'field-hint',
        text: '过渡至少持续这么久：尾奏不够就循环补（桥接）、A 还在唱就让 B 从高频缝隙穿插进来，等 A 末句唱完再交接低频；仅进阶 v2 生效',
      }),
    ),
    floorRow.root,
  );

  const root = h('div', { class: 'analysis-section', 'data-qa': 'crossfade-section' });

  function paint(): void {
    const settings = readCrossfadeSettings();
    enableRow.paint(settings.enabled);
    showPreviewRow.paint(settings.showPreview);
    lengthModeRow.paint(settings.lengthMode);
    rebuildLengthValues(settings);
    lengthValueSeg?.paint(settings.lengthValue);
    styleRow.paint(settings.style);
    presetRow.paint(settings.preset);
    cueRow.paint(settings.cueMode);
    barsRow.paint(settings.bars);
    barsRow.setDisabled(settings.lengthMode !== 'auto');
    alignmentRow.paint(settings.alignment);
    bassRow.paint(settings.bassSwap);
    tempoRow.paint(settings.tempoRange);
    loudnessRow.paint(settings.loudnessMatch);
    handoffRow.paint(settings.handoff);
    mixRow.paint(readMixTransitionMode());
    vocalRow.paint(settings.vocalAnchor);
    vocalRow.setDisabled(!settings.handoff || settings.lengthMode !== 'auto');
    floorRow.paint(settings.mixFloor);
    floorRow.setDisabled(!isAutomixV2(effectiveMode()));
    handoffRow.setDisabled(settings.lengthMode !== 'auto');
    barsHint.textContent =
      settings.lengthMode === 'auto'
        ? '自动 = 跟随场景预设（4 或 8 小节）；固定 4 / 8 / 16 小节适合结构明确的电子 / 舞曲'
        : '已选择手动/按拍过渡时长：结构混音只决定入场点与让位点，淡化时长按上面的长度执行（小节选项暂时不生效）';
    root.dataset.enabled = settings.enabled ? '1' : '0';
  }

  const onSettingsChange = (): void => paint();
  window.addEventListener('zilux:crossfade', onSettingsChange);
  scope?.add(() => window.removeEventListener('zilux:crossfade', onSettingsChange));

  root.append(
    h('h3', { class: 'section-title', text: '无缝衔接（实验）' }),
    h('p', {
      class: 'analysis-desc',
      text: '自动模式按两首歌曲的节拍、调性和前后奏空间选择自然融合或短过渡。歌词衔接会在下一首首句之前完成淡入；节拍可靠时对齐速度，上一首退出后再恢复原速。自然过渡保持原有音色，也可以手动选择带扫频效果的交融。',
    }),
    h(
      'div',
      { class: 'analysis-metronome' },
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '自动衔接' }),
          h('div', { class: 'field-hint', text: '关闭后行为与之前完全一致' }),
        ),
        enableRow.root,
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '过渡预告' }),
          h('div', {
            class: 'field-hint',
            text: '在播放条右下「下一首」小卡里显示这次怎么过渡；进入准备阶段后显示实际淡化起点和秒数',
          }),
        ),
        showPreviewRow.root,
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '过渡时长' }),
          h('div', {
            class: 'field-hint',
            text: '自动 = 两首歌的拍点/小节 + 前奏尾奏空间自适应；也可以按秒数、拍数、小节数或一个乐句固定——拍/小节会用局部速度换算，变速歌也准',
          }),
        ),
        h('div', { class: 'crossfade-seg-stack' }, lengthModeRow.root, lengthValueHost),
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '过渡风格' }),
          h('div', {
            class: 'field-hint',
            text: '自动判断根据节拍置信度、调性和允许变速范围选择自然融合或短过渡；交融保留扫频效果；等功率保留原有音色',
          }),
        ),
        styleRow.root,
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '使用场景预设' }),
          h('div', {
            class: 'field-hint',
            text: '两者兼顾 = 4 小节过渡（默认）；完整播放 = 8 小节，尽量放完整副歌/尾奏；频繁切歌 = 短过渡优先',
          }),
        ),
        presetRow.root,
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: 'B 入场时机' }),
          h('div', {
            class: 'field-hint',
            text: '按歌曲结构选 B 的进入点：自动 = 首个 drop 优先、其次副歌，并对齐 8 小节乐句；也可以指定 drop / 副歌 / intro 后',
          }),
        ),
        cueRow.root,
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '过渡长度（小节）' }),
          barsHint,
        ),
        barsRow.root,
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '拍点对齐精度' }),
          h('div', {
            class: 'field-hint',
            text: '拍点 = 过渡起点/终点吸附到分析出的真实拍点（默认）；小节 = 只吸强拍/小节线，更接近旧版',
          }),
        ),
        alignmentRow.root,
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '低频交接' }),
          h('div', {
            class: 'field-hint',
            text: 'B 进场后第 1 / 2 小节做底鼓换手（落小节线），默认第 2 小节；关闭后两首低频不互换',
          }),
        ),
        bassRow.root,
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: 'BPM 对齐范围' }),
          h('div', {
            class: 'field-hint',
            text: '两首 BPM 不同时用 WSOLA 变速不变调对齐节拍（上一首退出后平滑回正原速）；默认 ±8%，关闭则完全不变速',
          }),
        ),
        tempoRow.root,
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '响度对齐' }),
          h('div', {
            class: 'field-hint',
            text: '按交接区间的实测响度微调下一首（最多 ±3 dB），过渡后平滑恢复；需要两首完成新版分析',
          }),
        ),
        loudnessRow.root,
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '歌词衔接' }),
          h('div', {
            class: 'field-hint',
            text: '用上一首尾奏与下一首前奏完成淡化，首句开始前清晰入场；信息不足时回退结构或普通过渡（需自动时长）',
          }),
        ),
        handoffRow.root,
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '跟拍校速' }),
          h('div', {
            class: 'field-hint',
            text: '分析给的 BPM 明显不对时：播放这首歌，按 T 连续跟拍 4 下以上，过渡的小节对齐会改用你跟的速度；Shift + T 清除。跟拍只影响过渡规划，不写回分析缓存',
          }),
        ),
        h('div', {
          class: 'field-hint',
          text: 'T = 跟拍 · Shift + T = 清除',
        }),
      ),
    ),
    h('p', {
      class: 'analysis-footnote',
      text: '歌曲分析和歌词用于选择交接位置；普通歌词的句尾时间为估算值。音频图可用时，增益和交融滤波由音频时钟调度；下一首缓冲中断时撤销过渡并恢复上一首。',
    }),
  );

  root.append(mixField);
  root.append(vocalField);
  root.append(floorField);

  // 分段滑块是整行控件：把本区块的字段统一改成「标题/说明在上、滑块在下」，
  // 和快捷设置里的档位选择长得一样，也不再随标签长度而宽窄不一。
  root.querySelectorAll('.field').forEach((field) => field.classList.add('is-stacked'));

  paint();
  return root;
}
