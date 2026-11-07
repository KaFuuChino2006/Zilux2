/**
 * 无缝自动衔接（B 版 Phase 1，实验）：鼓点对齐的等功率交叉淡化。
 *
 * 设计：
 * - 引擎只管「下一首」的预加载、淡化曲线与计划状态；真正的状态迁移（PlayerState / 持久化 /
 *   SMTC 上报 / 歌词 / 最近播放）由 player.ts 在 onFinish 回调里完成。
 * - 两条淡化路径：Web Audio 图未建立时用元素音量淡化；图已建立（EQ / 人声保留淡出 / 歌词页
 *   分析器）时把两个 deck 都接进 deckMix，用各自 deck gain 做等功率曲线，主音量仍由本地 gain
 *   控制——这样歌词页的频谱分析器和均衡器在淡化期间照常工作。
 * - 时间基准统一用「文件毫秒」：CUE 分轨要加上 startAt；曲内位置 = 文件时间 - startAt*1000。
 * - 淡化曲线：A/B 都用等功率（cos/sin），但 B 用更慢的指数进入（声音不会一上来就出来），
 *   A 稍微留久一点；图内路径还会压低伴奏（低/高架滤波）——听感上像「人声先出现、伴奏慢慢融进来」，
 *   与暂停淡出的「人声保留淡出」一致。
 * - 节拍对齐用 WSOLA 变速不变调：把 B 的 playbackRate 设为 A/B 的拍间隔比（±12% 内），
 *   配合 preservesPitch（Chromium 原生时间拉伸），淡化期间两首鼓点保持同拍，结束后速率平滑回 1。
 * - Phase 2 扩展：同一引擎还负责「手动切歌」（next/prev/点列表，1.2–2.0 秒等功率短过渡，B 从
 *   0 起播、不等节拍分析）与「单曲循环曲尾重启」（淡出→同曲淡入，B 从头播）。这两类过渡共用
 *   cancel/commit 状态机与 seek 取消逻辑；玩家倍速（0.5–2.0）作为 deck 基础速率参与，过渡结束后
 *   B 恢复用户倍速，WSOLA tempoRate 只在检测器允许时叠加在自动衔接上。
 * - 歌词衔接（handoff，仅 auto 档）：A 的最后一句歌词唱完时，B 的第一句歌词正好开始——
 *   B 的起播点 = 首句位置；淡化窗口从 A 末句起（尾奏较多时先按整小节保留一段尾奏再开始），
 *   时长按两首协调后的真实小节计算（默认一个乐句 4 小节、小节很短时 8 小节），
 *   交叠终点正好落在 A 的可听结尾——不设固定秒数封顶：尾奏超过一个乐句时多出来的整小节先给 A 独听，
 *   剩下的尾奏用来交叠；尾奏比一个乐句还短时整段尾奏都用来过渡（不够 MIN_FADE_MS 时自动回退普通淡化）。
 *   B 的人声不做硬切：起音用 smoothstep 在约 2–6 秒内缓慢浮现（淡化越长越慢）；前几秒再用「人声聚焦」EQ
 *   （低频 -15 dB / 高频 -11 dB / 1.8 kHz +4.5 dB）压住伴奏、突出中频人声，随后慢慢打开；
 *   A 的尾奏在约 2 秒内让位到 45% 再随淡化收干。首句/末句都由 lyricRange.ts 过滤掉制作人员行。
 * - 过渡风格（2026-10-29）：默认「交融」，仿 QQ 音乐的「智能混音 · 进阶交融」——两首不做等功率
 *   直接相加，而是用互补的低通/高通把两首的频谱错开，并在 75% 处做低频交接：
 *   A 的低通从 20 kHz 扫到 2.3 kHz、音量先保持再一路收到 −25 dB，75% 时低频架再抽掉 15 dB；
 *   B 的高通从 10 kHz 扫到 20 Hz、音量从 −30 dB 抬到 0 dB，75% 时低频架从 −15 dB 回正。
 *   全部曲线在淡化开始时一次性排到 AudioParam 时间线（音频线程驱动，不受 rAF 掉帧影响）；
 *   「等功率」保留原来的 cos/sin 曲线（图内路径仍带人声/伴奏倾斜），可作为回退档位。
 */

import {
  attachDeckToGraph,
  audioTapClock,
  audioTapGraphActive,
  detachDeckFromGraph,
  ensureEqualizerGraph,
  releaseDeckFx,
  scheduleDeckBands,
  scheduleDeckGain,
  setAudioTapVolume,
  setDeckGraphGain,
  setDeckGraphTilt,
  setDeckGraphVocalFocus,
  setDeckTrimGain,
  type DeckBandPoint,
} from '../core/audioTap';
import type { AnalysisResult, BeatAnalysis } from '../online/analysis';
import type { OnlineTrack } from '../online/types';
import { compensationDbFor } from './loudness';
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
};
const LENGTH_MODE_VALUES: CrossfadeLengthMode[] = ['auto', 'seconds', 'beats', 'bars', 'phrase'];
const ALIGNMENT_VALUES: CrossfadeAlignment[] = ['bars', 'beats'];
const STYLE_VALUES: CrossfadeStyle[] = ['auto', 'am', 'equal', 'cut'];
const PRESET_VALUES: CrossfadePreset[] = ['balanced', 'full', 'fast'];
const CUE_MODE_VALUES: CrossfadeCueMode[] = ['auto', 'drop', 'chorus', 'intro'];
const BARS_VALUES: CrossfadeBars[] = ['auto', 4, 8, 16];
const BASS_SWAP_VALUES: CrossfadeBassSwap[] = ['off', 'bar1', 'bar2'];
const TEMPO_RANGE_VALUES: CrossfadeTempoRange[] = [0, 0.06, 0.08, 0.12];

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
const MIN_FADE_MS = 1_200;
const MAX_FADE_MS = 32_000;
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
 * 变速回正的起点（过渡进度 0–1）：前段保持与 A 对齐，后段在淡化里平滑回到用户倍速，
 * 到过渡结束时正好是正常速度，切歌后不再有「先快/慢一下再回正」的尾巴。
 */
const TEMPO_RESTORE_FROM = 0.55;

/** B 淡入曲线指数（>1 = 更晚出声）；A 淡出指数（>1 = 人声/尾音多留一会儿）。 */
const B_ENTRY_WARP = 1.9;
const A_EXIT_WARP = 1.15;
/** 人声/伴奏分离：过渡期间把伴奏（低频/高频）最多压低多少 dB，中频人声保留。 */
const TILT_MAX_DB = 9;

/** tick 到点前的提前量（rAF 约 16 ms 一帧，留一帧余量）。 */
const TRIGGER_LEAD_MS = 120;
/** 已经越过淡化起点超过这个量就放弃本次衔接（回退硬切）。 */
const MISS_TOLERANCE_MS = 900;

/** 手动切歌 / 单曲循环的短过渡：1.2–2.0 秒等功率，不做节拍分析、不做 BPM 对齐。 */
const MANUAL_FADE_MIN_MS = 1_200;
const MANUAL_FADE_MAX_MS = 2_000;
/** player 手动切歌默认使用的过渡时长（毫秒）。 */
export const MANUAL_FADE_DEFAULT_MS = 1_500;

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
    tempoRange: TEMPO_RANGE_VALUES.includes(patch.tempoRange as CrossfadeTempoRange)
      ? (patch.tempoRange as CrossfadeTempoRange)
      : current.tempoRange,
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
  if (typeof record.handoff === 'boolean') out.handoff = record.handoff;
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
    handoff: settings.handoff,
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
  if (override.handoff !== undefined) next.handoff = override.handoff;
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
  /** 过渡时长（毫秒）：自动夹到 1200–2000 */
  fadeMs: number;
  /** 单曲循环：A 曲内位置到达 >= triggerPosMs 时自动触发；缺省 0（立即开始） */
  triggerPosMs?: number;
  /** B 无法起播等失败时回调；player 据此回退硬切。 */
  onFail?: (reason: string) => void;
}

interface FadeSchedule {
  fadeStartFileMs: number;
  fadeStartPosMs: number;
  fadeMs: number;
  bStartFileMs: number;
  /** 本次过渡给 B 的播放速率（1 = 不变速） */
  tempoRate: number;
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
}

interface ActivePlan {
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
  progress: number;
  baseVolume: number;
  raf: number;
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

function smoothStep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

/** 设置 deck 播放速率（WSOLA 变速不变调：preservesPitch 保持音高）。 */
function setDeckPlaybackRate(element: HTMLAudioElement, rate: number): void {
  try {
    element.preservesPitch = true;
    (element as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    element.playbackRate = Math.max(0.5, Math.min(2, rate));
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

/**
 * 等功率淡化 + 人声/伴奏分离：
 * - B 的进入曲线用 p^1.9 再取正弦 → 前段几乎听不到，避免「下一首一上来就很大声」；
 * - A 的退出用 p^1.15 余弦 → 人声/尾音多留一点；
 * - 图内路径同时压低伴奏（低/高架滤波）：A 的伴奏先退、人声后走；B 的伴奏从压低回正，
 *   于是听感上是「B 的人声先出来，伴奏慢慢融进来」，与暂停淡出的人声保留一致。
 * - Phase 2：手动切歌 / 单曲循环这类 1.2–2.0 秒短过渡用纯等功率（不加权、不压伴奏），
 *   短窗口里加权会听出能量凹陷。
 * - 歌词衔接（plan.handoff）：B 的人声用 smoothstep 缓慢浮现（约 2–6 秒，淡化越长越慢），
 *   不用 58% 硬起音；B 前几秒走「人声聚焦」EQ（低频 -15 dB / 高频 -11 dB / 1.8 kHz +4.5 dB）
 *   压住伴奏、突出中频人声，再慢慢打开；A 尾音先让位到 45% 再收干。
 */
function applyEqualPowerGains(plan: ActivePlan, progress: number): void {
  const p = clamp01(progress);
  const warped = plan.kind === 'auto';
  if (plan.handoff) {
    // 歌词衔接：B 首句从淡化起点开始，但不再「硬切进 58%」——人声用 smoothstep 缓慢浮现，
    // 前几秒再用「人声聚焦」EQ 压住 B 的低频/高频、抬高 1.8 kHz，让人声先出来；
    // A 的尾奏在约 2–3.6 秒内让位到 45%，把空间让给 B 的人声，再随淡化收干。
    const fadeMs = Math.max(1, plan.fadeMs);
    const elapsed = p * fadeMs;
    // 人声浮现刻意放慢：淡化越长升得越慢（约 2–6 秒量级），但必须在淡化结束前完成，
    // 否则收尾时 B 会被直接补满、听出跳变，所以再夹一道 fadeMs * 0.85。
    const riseMs = Math.min(6000, Math.max(1800, fadeMs * 0.45), fadeMs * 0.85);
    const duckMs = Math.min(3600, Math.max(1200, fadeMs * 0.28));
    const openMs = Math.min(4200, Math.max(1200, fadeMs * 0.45));
    const rise = smoothStep(Math.min(1, elapsed / riseMs));
    const duck = smoothStep(Math.min(1, elapsed / duckMs));
    const focus = 1 - smoothStep(Math.min(1, elapsed / openMs));
    const outGain = (1 - 0.55 * duck) * Math.pow(Math.max(0, 1 - p), 1.1);
    if (plan.graphMode) {
      setAudioTapVolume(plan.baseVolume, true);
      setDeckGraphGain(plan.options.active, outGain);
      setDeckGraphGain(plan.options.standby, rise);
      // A 的伴奏先退（低频 9 dB / 高频 6.3 dB），B 的人声聚焦慢慢打开。
      setDeckGraphTilt(plan.options.active, -TILT_MAX_DB * duck, -TILT_MAX_DB * 0.7 * duck);
      setDeckGraphVocalFocus(plan.options.standby, focus);
      return;
    }
    setDeckVolume(plan.options.active, plan.baseVolume * outGain);
    setDeckVolume(plan.options.standby, plan.baseVolume * rise);
    return;
  }
  const outGain = Math.cos(Math.pow(p, warped ? A_EXIT_WARP : 1) * Math.PI * 0.5);
  const inGain = Math.sin(Math.pow(p, warped ? B_ENTRY_WARP : 1) * Math.PI * 0.5);
  if (plan.graphMode) {
    // 图内：主音量（baseVolume）在本地 gain 上，deck gain 只负责 0~1 的等功率比例。
    setAudioTapVolume(plan.baseVolume, true);
    setDeckGraphGain(plan.options.active, outGain);
    setDeckGraphGain(plan.options.standby, inGain);
    if (!warped) {
      // 短过渡不做人声/伴奏倾斜，直接等功率交叉。
      setDeckGraphTilt(plan.options.active, 0, 0);
      setDeckGraphTilt(plan.options.standby, 0, 0);
      return;
    }
    // 伴奏压低量：A 从 0 到 -TILT_MAX_DB；B 从 -TILT_MAX_DB 回到 0。
    const outTilt = -TILT_MAX_DB * smoothStep(p * 0.9);
    const inTilt = -TILT_MAX_DB * (1 - smoothStep(p * 1.35));
    setDeckGraphTilt(plan.options.active, outTilt, outTilt);
    setDeckGraphTilt(plan.options.standby, inTilt, inTilt);
    return;
  }
  setDeckVolume(plan.options.active, plan.baseVolume * outGain);
  setDeckVolume(plan.options.standby, plan.baseVolume * inGain);
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
  const bBands: DeckBandPoint[] = [{ atMs: 0, lowpassHz: 20000, highpassHz: 10000, bassDb: -15 }];
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
      aGain.push({ atMs, gain: dbToAmp(fadedDb) });
    }
    const bDbValue = interpolateCurve(bDb, p);
    if (bDbValue !== null) bGain.push({ atMs, gain: dbToAmp(bDbValue + trimDb) });
  }
  // 低频交接：默认 75% 处直接阶跃（QQ 的 step 型 automation），结构混音时按小节线换算进度；
  // bassHandoffP = 0 表示关闭交接（两首都不做低频阶跃）。
  if (bassHandoffP <= 0) return { aBands, bBands, aGain, bGain };
  const handoffMs = Math.max(0, Math.min(duration, bassHandoffP * duration));
  aBands.push({ atMs: Math.max(0, handoffMs - 1), bassDb: 0 });
  aBands.push({ atMs: handoffMs, bassDb: -15 });
  bBands.push({ atMs: Math.max(0, handoffMs - 1), bassDb: -15 });
  bBands.push({ atMs: handoffMs, bassDb: 0 });
  return { aBands, bBands, aGain, bGain };
}

/**
 * 把「交融」的整套曲线一次性排到音频线程：滤波扫频 + 低频交接走 AudioParam 时间线，
 * 音量同样走时间线（dB 采样后换线性幅度），rAF 只负责推进度与收尾——掉帧也不会让曲线变形。
 */
function scheduleAmFade(plan: ActivePlan): boolean {
  const clock = audioTapClock();
  if (clock === null) return false;
  const tracks = buildAmTracks(plan.fadeMs, plan.bassHandoffP, plan.gainTrimDb);
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
  const tempoAligned =
    bpmA >= 40 &&
    bpmB >= 40 &&
    bpmA / bpmB >= TEMPO_RATE_MIN &&
    bpmA / bpmB <= TEMPO_RATE_MAX;
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

  // B 从第一个强拍到「开始唱词」的可用前奏（文件毫秒）；没有歌词数据时为 0。
  const bRoomMs = ctx.vocalFileMs > 0 ? ctx.vocalFileMs - ctx.baseBStartFileMs : 0;
  if (bRoomMs > 0 && bRoomMs < bars * barMs) {
    // 前奏不足一个乐句：按整小节缩短；剩余部分由 B 侧「整段前奏当过渡」的逻辑兜底。
    bars = Math.max(2, Math.min(bars, Math.floor(bRoomMs / barMs)));
    note = 'B 前奏较短，按整小节缩短';
  } else if (bRoomMs >= AUTO_BARS_LONG * barMs) {
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
 * 解析本次过渡风格：auto 时按 BPM 差与调性距离选择——
 * BPM 差 > 12% 或调性隔 > 2 → 短切；否则走交融（等功率作为图未建立时的回退）。
 */
function resolveTransitionStyle(
  settings: CrossfadeSettings,
  analysis: BeatAnalysis,
  nextAnalysis: BeatAnalysis,
): 'am' | 'equal' | 'cut' {
  if (settings.style !== 'auto') return settings.style;
  const aBpm = analysis.bpm;
  const bBpm = nextAnalysis.bpm;
  const bpmDiff = aBpm >= 40 && bBpm >= 40 ? Math.abs(normalizeTempoRatio(aBpm / bBpm) - 1) : 0;
  const gap = camelotGap(analysis.camelot, nextAnalysis.camelot);
  // 专业 DJ 的默认做法是「能融就融」：只有节拍怎么也合不上（超过 ±22%，例如 96 与 128）
  // 或调性彻底打架时才改用快速切入；轻微 BPM/调性差异交给 ±8% 变速与低通/高通错开来处理。
  if (bpmDiff > 0.22) return 'cut';
  if (gap >= 5) return 'cut';
  return 'am';
}

/** 把节拍比折算到八度内（128 对 64 视作同速），返回 A/B 的等效速度比。 */
function normalizeTempoRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  let value = ratio;
  while (value >= 2) value /= 2;
  while (value < 0.5) value *= 2;
  return value;
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
 * p0-11 结构混音：A 在 cue-out（尾奏起点，对齐乐句）开始让位，B 从 cue-in（drop 优先、其次副歌，
 * 对齐 8 小节乐句）进入，淡化长度 = 场景预设的小节数。数据不足（旧缓存 / 未分析）返回 null，
 * 回退到原来的淡入淡出逻辑。
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
  nextVocalStartMs: number;
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
    nextVocalStartMs,
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
  // 结构混音的小节长按「cue-out 附近」的局部速度算：变速歌 / 跟拍覆盖都从这里生效。
  const cueOutBpm = tempoAtMs(track, analysis, typeof analysis.cueOutMs === 'number' && analysis.cueOutMs > 0 ? analysis.cueOutMs : fileAudibleEndMs);
  const barMs = cueOutBpm >= 40 ? (60_000 / cueOutBpm) * meter : barIntervalOf(analysis);
  if (!(barMs > 0)) return null;
  const rawCueOut = analysis.cueOutMs;
  const cueOutTarget = typeof rawCueOut === 'number' && rawCueOut > 0 ? rawCueOut : fileAudibleEndMs;
  const cueOut = phraseCue(analysis, cueOutTarget, bars, fileAudibleEndMs);
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
    typeof analysis.cueOutMs === 'number' && analysis.cueOutMs > 0 ? analysis.cueOutMs : fileAudibleEndMs,
  );
  const cut =
    settings.style === 'cut' || (manualMs <= 0 && resolveTransitionStyle(settings, analysis, nextAnalysis) === 'cut');
  // 手动过渡时长决定「长融合」的窗口：从可听结尾倒推 manualMs 开始，可早于结构 cue-out。
  // 快速切入不做长融合，起点仍贴结构让位点，避免把 A 的尾奏整段切掉。
  const manual = manualMs > 0 && !cut;
  let fadeStart = cueOut;
  if (manual) {
    const target = fileAudibleEndMs - manualMs;
    const snapped = snapToGrid(analysis, target, currentStartMs, settings.alignment);
    fadeStart = snapped === null ? target : snapped;
  }
  if (fadeStart < earliestStart) fadeStart = earliestStart;
  if (fadeStart >= fileAudibleEndMs - MIN_FADE_MS) return null;
  const availableMs = Math.max(0, Math.round(fileAudibleEndMs - fadeStart));
  let fadeMs: number;
  if (headMode) {
    // 目标：淡化正好结束在「A 的尾奏播完」或「B 的首句唱词开始」。
    // - B 从曲首起播；唱词前的前奏短于 A 的尾奏时，过渡结束在唱词开始处；
    // - 前奏更长时以 A 尾奏播完为终点，B 继续播自己的前奏，中间不空场。
    const vocalGap = Math.round(nextVocalStartMs > 0 ? nextVocalStartMs - nextStartMs : 0);
    const vocalEnd = vocalGap >= MIN_FADE_MS && vocalGap <= availableMs - 300 ? vocalGap : 0;
    fadeMs = manual ? Math.min(manualMs, availableMs) : vocalEnd > 0 ? vocalEnd : availableMs;
    if (fadeMs > MAX_FADE_MS) fadeMs = MAX_FADE_MS;
    // 快速切入本来就不做长融合，自动模式下也压到 2 小节以内。
    if (cut) fadeMs = Math.min(fadeMs, Math.round(barMs * 2));
  } else {
    fadeMs = manual ? Math.min(manualMs, availableMs) : Math.round(bars * barMs);
    if (cut) fadeMs = Math.min(fadeMs, Math.round(barMs * 2));
    fadeMs = Math.min(fadeMs, Math.max(MIN_FADE_MS, availableMs));
    if (nextDurationMs > 0) {
      const room = nextDurationMs - (alignedCueIn - nextStartMs);
      if (room < MIN_FADE_MS + 400) return null;
      fadeMs = Math.min(fadeMs, Math.round(room - 400));
    }
  }
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

function buildSchedule(options: CrossfadePrepareOptions): FadeSchedule | null {
  const currentStartMs = options.current.startAt * 1000;
  const currentPosMs = Math.max(0, options.currentPositionMs);
  const durationMs = options.currentDurationMs;
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) return null;

  const analysis = options.currentAnalysis.analysis;
  // 可听结尾是文件毫秒：CUE 分轨先换算成段内位置再夹进 [0, durationMs]；
  // 缺失（旧宿主 / 旧缓存）或越界时回退曲内时长，行为与 task-19 一致。
  const rawAudibleEnd = analysis.audibleEndMs;
  const hasAudibleEnd = typeof rawAudibleEnd === 'number' && Number.isFinite(rawAudibleEnd) && rawAudibleEnd > 0;
  const audibleEndPosMs = hasAudibleEnd
    ? Math.min(durationMs, Math.max(0, rawAudibleEnd - currentStartMs))
    : durationMs;
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
  const nextFirstDownbeat = pickDownbeatAtOrAfter(nextAnalysis, nextStartMs, nextLimitMs);
  const baseBStartFileMs = nextFirstDownbeat === null ? nextStartMs : nextFirstDownbeat;

  const rawVocalStart = options.nextVocalStartMs;
  const vocalPosMs =
    typeof rawVocalStart === 'number' && Number.isFinite(rawVocalStart) && rawVocalStart > 0
      ? Math.round(Math.min(rawVocalStart, nextDurationMs > 0 ? nextDurationMs : rawVocalStart))
      : 0;
  const vocalFileMs = vocalPosMs > 0 ? nextStartMs + vocalPosMs : 0;

  // 过渡时长（auto 需要 B 的起播点/唱词位置来判断前奏空间，所以放在 B 侧基础信息之后算）。
  const fadePlan = resolveFadePlan(options, {
    currentStartMs,
    fileAudibleEndMs,
    baseBStartFileMs,
    vocalFileMs,
  });
  const desiredMs = fadePlan.ms;

  // ---- 歌词衔接（handoff）：A 最后一句唱完 = 淡化起点，B 首句 = 淡化终点，人声先出、伴奏渐入 ----
  // 只对「自动」档开放（手动固定档位保持用户指定的秒数）；A 末句之后没有足够尾奏时自动回退普通淡化。
  const settings = effectiveCrossfadeSettings(options.current.track);
  // p0-11 结构混音：A 尾奏让位 → B 从 drop/副歌乐句进来，时长按场景预设小节数。
  // 分析字段缺失（旧缓存 / 旧宿主）时返回 null，下面回退到原来的淡化逻辑。
  // 歌词衔接开启时优先按唱词交接，暂不使用结构混音计划（两者语义冲突）。
  const structure = settings.handoff ? null : buildStructureCue({
    settings,
    analysis,
    nextAnalysis,
    currentStartMs,
    currentPosMs,
    fileAudibleEndMs,
    nextStartMs,
    nextDurationMs,
    nextVocalStartMs: vocalPosMs,
    track: options.current.track,
  });
  const rawLastVocalEnd = options.currentLastVocalEndMs;
  const lastVocalEndPosMs =
    typeof rawLastVocalEnd === 'number' && Number.isFinite(rawLastVocalEnd) && rawLastVocalEnd > 0
      ? Math.round(Math.min(rawLastVocalEnd, durationMs))
      : 0;
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
  let handoff =
    settings.handoff &&
    !structure &&
    settings.lengthMode === 'auto' &&
    lastVocalEndPosMs > 0 &&
    vocalFileMs > 0 &&
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

  let bStartFileMs = structure ? structure.bStartFileMs : handoff ? vocalFileMs : baseBStartFileMs;
  let vocalAligned = handoff;
  // 普通淡化时：B 前奏比目标淡化还短时，把整段前奏当成过渡，淡化时长随之缩短。
  let fadeMsTarget = structure ? structure.fadeMs : desiredMs;
  if (!structure && !handoff && vocalFileMs > 0) {
    const candidate = vocalFileMs - desiredMs;
    if (candidate >= nextStartMs + 250) {
      // 前奏够长：从「唱词前 desiredMs」处起播，淡化结束正好进入唱词（更早的前奏直接跳过）；
      // 起播点尽量贴在强拍上，保证淡化期间鼓点依然对齐。
      const nearby = pickDownbeatNear(nextAnalysis, candidate, nextStartMs);
      bStartFileMs = nearby !== null && Math.abs(nearby - candidate) <= 200 ? nearby : Math.round(candidate);
      vocalAligned = true;
    } else if (vocalFileMs - baseBStartFileMs >= MIN_FADE_MS) {
      // 前奏比目标淡化还短：把整段前奏当成过渡，淡化终点 = 唱词起点。
      fadeMsTarget = Math.max(MIN_FADE_MS, Math.min(desiredMs, vocalFileMs - baseBStartFileMs));
      bStartFileMs = baseBStartFileMs;
      vocalAligned = true;
    }
    // 前奏太短（< MIN_FADE_MS）或数据异常：保持普通淡化，B 从第一个强拍起播。
  }

  // ---- A 侧 ----
  // 歌词衔接：起点 = 「A 最后一句唱完」+ 按整小节先保留的尾奏（handoffHoldMs），不再贴强拍；
  // 过渡时长 = 剩余尾奏（约一个乐句），终点正好落在 A 的可听结尾，不设固定秒数封顶。
  // 其它情况：终点固定为可听结尾、按淡化时长反推起点，并尽量贴强拍。
  let fadeStartFile = structure ? structure.fadeStartFileMs : currentStartMs;
  if (!structure && handoff) {
    fadeStartFile = currentStartMs + lastVocalEndPosMs + handoffHoldMs;
    const earliestStart = currentStartMs + currentPosMs + 80;
    if (fadeStartFile < earliestStart) {
      // 已经错过末句（分析回来太晚 / 用户 seek 过）：回退普通淡化。
      handoff = false;
      handoffHoldMs = 0;
      vocalAligned = false;
      bStartFileMs = baseBStartFileMs;
    }
  }
  let fadeEndFile = fileAudibleEndMs;
  if (!structure && !handoff) {
    // 终点也贴拍点/强拍：只允许在可听结尾附近 ±0.6 拍内微调，避免把过渡拖进尾部静音。
    const endInterval = beatIntervalOf(analysis) || 500;
    const endSnap = snapToGrid(analysis, fileAudibleEndMs, currentStartMs, settings.alignment);
    if (
      endSnap !== null &&
      Math.abs(endSnap - fileAudibleEndMs) <= endInterval * 0.6 &&
      endSnap <= fileAudibleEndMs + endInterval * 0.5
    ) {
      fadeEndFile = endSnap;
    }
    const targetFileMs = fadeEndFile - fadeMsTarget;
    const snappedStart = snapToGrid(analysis, targetFileMs, currentStartMs, settings.alignment);
    fadeStartFile = snappedStart === null ? targetFileMs : snappedStart;

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
  }

  const fadeMs = structure ? structure.fadeMs : Math.round(handoff ? handoffFadeMs : fadeEndFile - fadeStartFile);
  if (fadeMs < MIN_FADE_MS) return null;

  // B 太短，撑不到淡化结束：结构混音直接放弃（回退旧逻辑），旧路径回退普通方案。
  if (nextDurationMs > 0) {
    const availableMs = nextDurationMs - (bStartFileMs - nextStartMs);
    if (availableMs < fadeMs + 400) {
      if (structure) return null;
      vocalAligned = false;
      handoff = false;
      bStartFileMs = baseBStartFileMs;
      if (nextDurationMs - (bStartFileMs - nextStartMs) < fadeMs + 400) return null;
    }
  }

  // ---- WSOLA 节拍对齐：把 B 的播放速率调到与 A 拍间隔一致，再微调 B 起播相位到同拍 ----
  let tempoRate = 1;
  // 局部速度（p0-13 曲线 / 跟拍覆盖）：B 取入场处、A 取淡化起点处；变速歌不再按整曲 BPM 算比率。
  const aBpm = tempoAtMs(options.current.track, analysis, fadeStartFile) || analysis.bpm;
  const bBpm = tempoAtMs(options.next.track, nextAnalysis, bStartFileMs) || nextAnalysis.bpm;
  if (aBpm >= 40 && bBpm >= 40 && settings.tempoRange > 0) {
    const raw = aBpm / bBpm;
    // 允许范围由设置决定（默认 ±8%）；超出会明显听出快/慢，宁可不变速、按原强拍起播。
    const minRate = 1 - settings.tempoRange;
    const maxRate = 1 + settings.tempoRange;
    if (raw >= minRate && raw <= maxRate && Math.abs(raw - 1) >= 0.004) {
      tempoRate = Math.round(raw * 1000) / 1000;
    }
  }
  // 歌词衔接时 B 的起播点就是首句，不再做「贴到同拍」的相位微调（会破坏人声对齐）；
  // 结构混音也要保持 B 正好落在乐句边界上。
  if (!structure && !handoff && tempoRate !== 1 && bStartFileMs > 0) {
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
    if (Math.abs(shift) <= 220) bStartFileMs = Math.round(bStartFileMs + shift);
  }
  if (nextLimitMs > 0 && bStartFileMs > nextLimitMs) bStartFileMs = nextLimitMs;

  // 风格与低频交接：auto 按调性/BPM 距离解析；交接点按结构混音的小节线换算。
  let style = resolveTransitionStyle(settings, analysis, nextAnalysis);
  // 手动过渡时长优先：自动解析出的「快速切入」与用户的长过渡意图冲突，降级为交融。
  if (settings.lengthMode !== 'auto' && settings.style === 'auto' && style === 'cut') style = 'am';
  let bassHandoffP = AM_BASS_HANDOFF_P;
  if (settings.bassSwap === 'off') {
    bassHandoffP = 0;
  } else if (structure) {
    const swapBar = settings.bassSwap === 'bar1' ? 1 : 2;
    const structureBarMs = structure.barMs > 0 ? structure.barMs : 2000;
    bassHandoffP = Math.min(0.9, Math.max(0.12, (swapBar * structureBarMs) / fadeMs));
  }
  if (style === 'cut' && structure) bassHandoffP = 0;
  // B 的响度补偿：把 B 拉到与 A 相近的 LUFS（±6 dB 内），避免下一首明显更轻/更响。
  const aLufs = analysis.loudnessLufs;
  const bLufs = nextAnalysis.loudnessLufs;
  const gainTrimDb =
    settings.loudnessMatch &&
    typeof aLufs === 'number' &&
    typeof bLufs === 'number' &&
    aLufs < -1 &&
    bLufs < -1
      ? Math.max(-6, Math.min(6, aLufs - bLufs))
      : 0;

  return {
    fadeStartFileMs: fadeStartFile,
    fadeStartPosMs: fadeStartFile - currentStartMs,
    fadeMs,
    bStartFileMs,
    tempoRate,
    structure: structure !== null,
    cueMode: structure ? structure.cueMode : 'off',
    phraseBars: structure ? structure.bars : 0,
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
    autoNote: handoff
      ? `歌词衔接：A 末句 ${lastVocalEndPosMs} ms 唱完${
          handoffHoldMs > 0
            ? `，先独听 ${handoffHoldMs} ms 尾奏（约 ${Math.max(1, Math.round(handoffHoldMs / handoffBarMs))} 小节）`
            : ''
        }，再用 ${fadeMs} ms 完成交叠（约 ${Math.max(1, Math.round(fadeMs / handoffBarMs))} 小节）到 A 可听结尾，接下一首首句 ${vocalPosMs} ms`
      : fadePlan.note,
  };
}

function applySchedule(plan: ActivePlan, schedule: FadeSchedule): void {
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
      element.currentTime = target;
      return true;
    }
    const apply = (): void => {
      cancelPendingSeek(element);
      try {
        element.currentTime = target;
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
  const settings = effectiveCrossfadeSettings(options.current.track);
  let graphMode = audioTapGraphActive();
  if (!graphMode && (settings.style === 'am' || settings.style === 'auto')) {
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
  // 冲突风格的「快速切入」也走交融链路（低频交接已关），靠低通扫频收尾，避免硬切的咔哒声。
  plan.am = graphMode && (schedule.style === 'am' || schedule.style === 'cut') && !plan.handoff;
  plan.styleResolved = graphMode ? schedule.style : schedule.style === 'cut' ? 'cut' : 'equal';
  if (graphMode) {
    // 响度对齐改成「每个 deck 各自补偿」：A 用当前曲的 LUFS、B 用下一首的 LUFS，
    // 过渡曲线里不再叠加 gainTrimDb，切歌提交时也就没有「全局增益换值 + trim 消失」的双重台阶。
    const currentDb = compensationDbFor(options.currentAnalysis.analysis.loudnessLufs);
    const nextDb = compensationDbFor(options.nextAnalysis.analysis.loudnessLufs);
    setDeckTrimGain(options.active, currentDb ?? 0);
    setDeckTrimGain(options.standby, nextDb ?? 0);
    plan.gainTrimDb = 0;
    debug.gainTrimDb = 0;
  }
  // 预先把 B 的速率与伴奏倾斜设置好：淡化开始时不用临时改，避免首帧爆音。
  const baseRate = baseDeckRate(options);
  setDeckPlaybackRate(options.standby, baseRate * plan.tempoRate);
  setDeckPlaybackRate(options.active, baseRate);
  if (graphMode) {
    setDeckGraphTilt(options.active, 0, 0);
    // 交融与歌词衔接都不用「人声/伴奏倾斜」这套搁架（前者靠滤波扫频，后者靠人声聚焦）。
    const tilt = plan.am || plan.handoff ? 0 : -TILT_MAX_DB;
    setDeckGraphTilt(options.standby, tilt, tilt);
  }
  activePlan = plan;
  debug.phase = 'prepared';
  debug.reason = '';
  debug.currentTitle = options.current.track.title;
  debug.nextTitle = options.next.track.title;
  debug.crossfadeKind = 'auto';
  debug.amActive = plan.am;
  debug.nextPrepared = true;
  debug.progress = 0;
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
  return true;
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
  plan.options.standby.play().then(
    () => {
      if (activePlan !== plan || plan.phase !== 'fading') return;
      notifyStart(plan);
      plan.raf = requestAnimationFrame(fadeStep);
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
  cancelPendingSeek(plan.options.standby);
  if (plan.raf) {
    cancelAnimationFrame(plan.raf);
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
  if (!plan || plan.phase !== 'prepared') return;
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
  if (past > 0) {
    // 起播晚了（分析刚回来 / rAF 掉帧）：把淡化时长缩短，保证在 A 结束前完成。
    const shortened = Math.max(MIN_FADE_MS, plan.fadeMs - past);
    logEvent('late-start', `晚了 ${Math.round(past)} ms，淡化 ${plan.fadeMs}→${shortened} ms`);
    plan.fadeMs = shortened;
    debug.fadeMs = shortened;
  }
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

function startFade(plan: ActivePlan): void {
  if (plan.phase !== 'prepared') return;
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
    if (plan.am) {
      // 交融：低通/高通/低频架与音量全部交给 AudioParam 时间线，倾斜与人声聚焦保持直通。
      setDeckGraphTilt(plan.options.standby, 0, 0);
      setDeckGraphVocalFocus(plan.options.active, 0);
      setDeckGraphVocalFocus(plan.options.standby, 0);
    } else if (plan.handoff) {
      setDeckGraphTilt(plan.options.standby, 0, 0);
      setDeckGraphVocalFocus(plan.options.standby, 1);
    } else {
      // 起始时 B 的伴奏压到最低（只留中频和人声），随后在淡化中慢慢回到 0dB。
      setDeckGraphTilt(plan.options.standby, -TILT_MAX_DB, -TILT_MAX_DB);
    }
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
  plan.options.standby.play().then(
    () => {
      if (activePlan !== plan || plan.phase !== 'fading') return;
      if (plan.am) {
        // B 真正出声之后才排曲线：以「现在」为 0% 起点，进度也在这里重新计时，收尾时刻才和曲线对齐。
        plan.startedAt = performance.now();
        if (!scheduleAmFade(plan)) {
          logEvent('am-fallback', '音频时钟不可用，本轮退回等功率曲线');
          plan.am = false;
          debug.amActive = false;
        }
      }
      notifyStart(plan);
      plan.raf = requestAnimationFrame(fadeStep);
    },
    (err: unknown) => {
      if (activePlan !== plan) return;
      logEvent('b-play-failed', messageOf(err));
      cancelCrossfade('b-play-failed');
    },
  );
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
  const progress = Math.min(1, (performance.now() - plan.startedAt) / Math.max(1, plan.fadeMs));
  plan.progress = progress;
  debug.progress = progress;
  // 变速回正排在淡化里：前 TEMPO_RESTORE_FROM 段与 A 保持拍点对齐，
  // 之后平滑拉回用户倍速，过渡完成的瞬间 B 已经是正常播放速度。
  if (Math.abs(plan.tempoRate - 1) > 0.001) {
    const baseRate = baseDeckRate(plan.options);
    const matchedRate = baseRate * plan.tempoRate;
    const restore = progress <= TEMPO_RESTORE_FROM
      ? 0
      : smoothStep((progress - TEMPO_RESTORE_FROM) / (1 - TEMPO_RESTORE_FROM));
    const liveRate = matchedRate + (baseRate - matchedRate) * restore;
    setDeckPlaybackRate(plan.options.standby, liveRate);
    debug.tempoRateLive = Math.round(liveRate * 1000) / 1000;
  }
  // 交融风格的增益/滤波已经排在 AudioParam 时间线上，这里只推进度，不再逐帧写参数。
  if (!plan.am) applyEqualPowerGains(plan, progress);
  if (progress >= 1) {
    finishFade(plan);
    return;
  }
  plan.raf = requestAnimationFrame(fadeStep);
}

function finishFade(plan: ActivePlan): void {
  if (activePlan !== plan) return;
  if (plan.raf) {
    cancelAnimationFrame(plan.raf);
    plan.raf = 0;
  }
  if (plan.graphMode) {
    // 图内收尾：B 满音量、A 静音并从混音入口摘下；主音量仍由本地 gain 保持。
    // releaseDeckFx 会撤掉「交融」残留的扫频/低频交接，并停在指定增益上，避免收尾继承滤镜。
    setAudioTapVolume(plan.baseVolume, true);
    releaseDeckFx(plan.options.active, 0);
    releaseDeckFx(plan.options.standby, 1);
    setDeckGraphTilt(plan.options.active, 0, 0);
    setDeckGraphTilt(plan.options.standby, 0, 0);
    setDeckGraphVocalFocus(plan.options.active, 0);
    setDeckGraphVocalFocus(plan.options.standby, 0);
    detachDeckFromGraph(plan.options.active);
  } else {
    setDeckVolume(plan.options.active, 0);
    setDeckVolume(plan.options.standby, plan.baseVolume);
  }
  // 变速只用于过渡期间：回正已经在淡化的后段做完，这里直接落到用户倍速，
  // 过渡完成的瞬间 B 就是正常速度，不再有过渡后的「变速尾巴」。
  const baseRate = baseDeckRate(plan.options);
  setDeckPlaybackRate(plan.options.standby, baseRate);
  setDeckPlaybackRate(plan.options.active, baseRate);
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
  if (plan.raf) {
    cancelAnimationFrame(plan.raf);
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
  // 计划作废时 B 的起始 seek 监听也要撤掉，否则下次复用该元素会被旧目标改位置。
  cancelPendingSeek(plan.options.standby);
  if (plan.raf) {
    cancelAnimationFrame(plan.raf);
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

/** 当前是否正在交叉淡化（tick / 音量更新走不同路径）。 */
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
  // 交融风格的增益/滤波在 AudioParam 时间线上，逐帧重算等功率会盖掉已经排好的曲线；
  // 只把主音量（本地 gain）同步过去。
  if (plan.am) {
    setAudioTapVolume(plan.baseVolume, true);
    return;
  }
  applyEqualPowerGains(plan, plan.progress);
}

/**
 * 立即收尾（A 的 ended 事件比最后一帧 rAF 先到等）：B 直接满音量并交给 player 交换。
 * 返回 false = 当前没有进行中的淡化。
 */
export function crossfadeFinishNow(reason = 'ended'): boolean {
  const plan = activePlan;
  if (!plan || plan.phase !== 'fading') return false;
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
  setDeckPlaybackRate(plan.options.active, rate);
  setDeckPlaybackRate(plan.options.standby, rate * plan.tempoRate);
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
  if (typeof ResizeObserver !== 'undefined') {
    // 设置面板/窗口宽度变化时跟着重排药丸，否则会停在旧位置。
    const observer = new ResizeObserver(() => place(false));
    observer.observe(root);
  }
  return {
    root,
    buttons,
    paint,
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
          ? '自动判断：调性接近且 BPM 差 ≤12% 时用交融，冲突时用 1–2 小节快速切入'
          : value === 'am'
            ? '交融：A 的低通从 20k 扫到 2.3k、B 的高通从 10k 扫到 20 Hz，低频按小节线交接'
            : value === 'equal'
              ? '等功率：cos/sin 交叉淡化（旧曲线），B 晚一点进入、A 多留一点尾音'
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
        title: '上一首最后一句歌词唱完的瞬间接下一首第一句：人声先出、伴奏渐入（需要过渡时长为「自动」）',
      },
    ],
    onPick: (value) => {
      writeCrossfadeSettings({ handoff: value });
      paint();
      toast(
        value
          ? '歌词衔接已开启：下一首首句会接上一首末句（人声缓慢浮现、伴奏渐入）'
          : '歌词衔接已关闭：恢复按拍点/小节普通淡化',
      );
    },
  });
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
      text: '默认按歌曲结构混音（p0-11）：宿主把两首切成 intro / build / verse / chorus / drop / breakdown / outro，并给出让位点（A 的 cueOut = 尾奏起点，对齐乐句）与推荐入场点（B 的 cueIn）。「自动」模式下 B 从曲首进场、接上一首尾部：过渡从 A 的尾奏起点开始，结束在「A 尾奏播完」或「B 首句唱词开始」，中间两轨交叠、低频交接落在 B 的第 2 小节线上；手动选项可直接从 drop / 副歌 / intro 后进场（按 8 小节乐句对齐）。两首按 LUFS 分轨预调响度（每轨独立 ±6 dB，过渡中不跳变），BPM 差在 ±8% 内用 WSOLA 变速不变调对齐，且回正排在淡化后段——过渡前段两首保持拍点对齐、后段平滑回到原速，过渡完成时 B 已经是正常播放速度；调性/BPM 冲突时自动改用 1–2 小节快速切入。分析数据缺失（旧缓存 / 未分析）、手动切歌、单曲循环时自动回退到原来的淡化逻辑；歌词衔接开启时优先走人声接人声。所有选项都可单独调整，改动立即写入本机设置。',
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
            text: '自动判断 = 调性接近且 BPM 差 ≤12% 用交融、冲突时快速切入；交融 = 互补滤波 + 按小节线低频交接（需要 Web Audio 图，会自动建立）；等功率 = 旧 cos/sin 曲线',
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
            text: '两首 BPM 不同时用 WSOLA 变速不变调对齐节拍（过渡后段自动回正原速）；默认 ±8%，关闭则完全不变速',
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
            text: '按两首 LUFS 预调 B 的增益（±6 dB 内），避免下一首明显更轻/更响；需要两首都已分析',
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
            text: '上一首末句唱完接下一首首句，人声先出、伴奏渐入；尾奏较多时先保留一点尾奏听感再交接；尾奏不够长时自动回退普通淡化（需过渡时长 = 自动）',
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
      text: '切歌后先异步分析当前与下一首（本地约 1–5 秒）并读取两首歌词的人声首末句（本地同名 .lrc / 在线歌词，自动过滤制作人员名单），任一失败则回退为普通淡化或硬切。开启均衡器 / 人声保留淡出 / 歌词页频谱等 Web Audio 音效时，两个 deck 都会接进混音图，用各自增益做等功率淡化（主音量不变），并靠低/高架滤波做「人声先出现、伴奏慢慢融合」；过渡期间用 WSOLA 变速不变调对齐鼓点（preservesPitch），结束后平滑恢复原速。「交融」风格下低通/高通/低频架与音量都排在音频线程的时间线上，页面掉帧不会影响曲线。',
    }),
  );

  // 分段滑块是整行控件：把本区块的字段统一改成「标题/说明在上、滑块在下」，
  // 和快捷设置里的档位选择长得一样，也不再随标签长度而宽窄不一。
  root.querySelectorAll('.field').forEach((field) => field.classList.add('is-stacked'));

  paint();
  return root;
}
