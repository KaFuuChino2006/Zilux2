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
 *   B 的起播点 = 首句位置、淡化窗口 = A 末句到可听结尾（尾奏不够 MIN_FADE_MS 时自动回退普通淡化）。
 *   B 的人声不做硬切：起音用 smoothstep 在约 2–6 秒内缓慢浮现（淡化越长越慢）；前几秒再用「人声聚焦」EQ
 *   （低频 -15 dB / 高频 -11 dB / 1.8 kHz +4.5 dB）压住伴奏、突出中频人声，随后慢慢打开；
 *   A 的尾奏在约 2 秒内让位到 45% 再随淡化收干。首句/末句都由 lyricRange.ts 过滤掉制作人员行。
 */

import {
  attachDeckToGraph,
  audioTapGraphActive,
  detachDeckFromGraph,
  setAudioTapVolume,
  setDeckGraphGain,
  setDeckGraphTilt,
  setDeckGraphVocalFocus,
} from '../core/audioTap';
import type { AnalysisResult, BeatAnalysis } from '../online/analysis';
import type { OnlineTrack } from '../online/types';
import { h, toast, type Disposers } from './dom';

/* ------------------------------------------------------------------ */
/* 设置（localStorage）                                                */
/* ------------------------------------------------------------------ */

export type CrossfadeLength = 'auto' | number;

export interface CrossfadeSettings {
  enabled: boolean;
  /** auto = 按两首歌的拍点/小节与前后奏空间自适应（不固定 5–10 秒）；3–30 的整数 = 固定秒数 */
  length: CrossfadeLength;
  /**
   * 歌词衔接（仅过渡时长为 auto 时生效）：上一首最后一句歌词唱完的瞬间接下一首第一句，
   * 人声缓慢浮现（约 2–6 秒，随淡化长度）、伴奏先被 EQ 压住再慢慢打开；上一首尾奏不够长（< MIN_FADE_MS）
   * 时自动回退普通淡化。
   */
  handoff: boolean;
}

export const CROSSFADE_STORAGE_KEY = 'zilux2.crossfade';

/** 手动过渡时长可选档位（秒）：覆盖 3–30 秒，并留「自动」。 */
export const CROSSFADE_LENGTH_CHOICES: number[] = [3, 5, 8, 10, 15, 20, 30];
const LENGTH_MIN_SEC = 3;
const LENGTH_MAX_SEC = 30;

const DEFAULT_SETTINGS: CrossfadeSettings = { enabled: true, length: 'auto', handoff: true };
const LENGTH_VALUES: CrossfadeLength[] = [...CROSSFADE_LENGTH_CHOICES, 'auto'];

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

/** WSOLA 变速不变调：用原生 preservesPitch 时间拉伸，把 B 的拍间隔拉到与 A 一致（±12% 内才做）。 */
const TEMPO_RATE_MIN = 0.88;
const TEMPO_RATE_MAX = 1.12;
/** 过渡结束后把 B 的播放速率平滑拉回 1 的时长（ms）。 */
const TEMPO_RETURN_MS = 650;

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

function normalizeLength(value: unknown): CrossfadeLength {
  if (value === 'auto') return 'auto';
  // 数字或数字字符串（旧版档位 4/5/6/7/8/10 秒同此路径）；夹在 3–30 秒。
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (Number.isFinite(parsed)) {
    const seconds = Math.round(parsed);
    if (seconds >= LENGTH_MIN_SEC && seconds <= LENGTH_MAX_SEC) return seconds;
  }
  return DEFAULT_SETTINGS.length;
}

/** 读取无缝衔接设置；坏值 / 无值一律回退默认（开启 + auto）。 */
export function readCrossfadeSettings(): CrossfadeSettings {
  try {
    const raw = localStorage.getItem(CROSSFADE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS };
    const record = parsed as Record<string, unknown>;
    return {
      enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_SETTINGS.enabled,
      length: normalizeLength(record.length),
      handoff: typeof record.handoff === 'boolean' ? record.handoff : DEFAULT_SETTINGS.handoff,
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
  const next: CrossfadeSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    length: patch.length === undefined ? current.length : normalizeLength(patch.length),
    handoff: typeof patch.handoff === 'boolean' ? patch.handoff : current.handoff,
  };
  try {
    localStorage.setItem(CROSSFADE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* localStorage 不可用：忽略，仅本次会话生效 */
  }
  debug.enabled = next.enabled;
  debug.length = next.length;
  debug.handoff = next.handoff;
  window.dispatchEvent(new CustomEvent<CrossfadeSettings>('zilux:crossfade', { detail: next }));
  return next;
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
  length: CrossfadeLength;
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
  /** 下一次调度的「开始唱词」位置（曲内毫秒）；0 = 无歌词/未取到 */
  nextVocalStartMs: number;
  /** 本次调度是否按「开始唱词」对齐（true = B 起播点按唱词反推） */
  vocalAligned: boolean;
  /** 本次调度是否走「歌词衔接」：A 最后一句唱完的时刻开始接 B 第一句 */
  handoffActive: boolean;
  /** A 的「最后一句歌词唱完」位置（曲内毫秒）；0 = 无数据/未启用 */
  lastVocalEndPosMs: number;
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
  length: DEFAULT_SETTINGS.length,
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
  nextVocalStartMs: 0,
  vocalAligned: false,
  handoffActive: false,
  lastVocalEndPosMs: 0,
  currentAudibleEndMs: 0,
  tailSilenceMs: 0,
  autoFadeMs: 0,
  autoBars: 0,
  autoBarMs: 0,
  autoNote: '',
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
debug.length = initialSettings.length;
debug.handoff = initialSettings.handoff;

/**
 * 当前过渡调度快照（只读副本）。
 * 播放条用它显示「将在 X 分 Y 秒后过渡至 xxx」：phase === 'prepared' 且 fadeStartPosMs 已知时有效；
 * 手动切歌 / 单曲循环的短过渡只在 prepared 停留极短时间，不会触发长倒计时提示。
 */
export function readCrossfadeDebug(): CrossfadeDebugState {
  return debug.snapshot();
}

function logEvent(event: string, detail = ''): void {
  debug.events.push({ at: Date.now(), event, detail });
  if (debug.events.length > 40) debug.events.splice(0, debug.events.length - 40);
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
  /** auto 本次目标时长（毫秒）：= autoBars × autoBarMs；手动档位/回退为 0 */
  autoFadeMs: number;
  /** auto 本次算出的小节数（手动档位/回退为 0） */
  autoBars: number;
  /** auto 使用的小节长（毫秒，两首协调后的实时长度；手动档位/回退为 0） */
  autoBarMs: number;
  /** auto 决策说明（调试/QA 用） */
  autoNote: string;
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
  /** A 的「最后一句歌词唱完」位置（曲内毫秒）；0 = 未启用 */
  lastVocalEndPosMs: number;
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

/** 过渡结束后把 B 的速率平滑拉回目标速率（默认 1，Phase 2 改为用户倍速），避免整首歌带着过渡期的变速继续放。 */
function returnDeckTempoToNormal(element: HTMLAudioElement, from: number, to = 1): void {
  const target = Number.isFinite(to) && to > 0 ? to : 1;
  if (!Number.isFinite(from) || Math.abs(from - target) < 0.001) {
    setDeckPlaybackRate(element, target);
    return;
  }
  const started = performance.now();
  const step = (): void => {
    const t = Math.min(1, (performance.now() - started) / TEMPO_RETURN_MS);
    setDeckPlaybackRate(element, from + (target - from) * smoothStep(t));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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

/** 取离目标最近的强拍；离目标超过 1.5 拍就放弃对齐（宁可普通淡化）。 */
function pickDownbeatNear(analysis: BeatAnalysis, targetFileMs: number, startAtMs: number): number | null {
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
  if (best === null || bestDistance > beat * 1.5) return null;
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

/** 拍间隔：优先用分析给的 beatIntervalMs，其次由 BPM 反推；都没有 = 0。 */
function beatIntervalOf(analysis: BeatAnalysis): number {
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

/**
 * 两首协调后的一小节：能做 WSOLA 变速对齐时 B 跟随 A（用 A 的小节），
 * 拍速差太大对不齐时取两首的谐波平均，让两首歌的拍子都算数。
 */
function coordinatedBarMs(a: BeatAnalysis, b: BeatAnalysis): { barMs: number; tempoAligned: boolean } {
  const barA = barIntervalOf(a);
  const barB = barIntervalOf(b);
  const tempoAligned =
    a.bpm >= 40 &&
    b.bpm >= 40 &&
    a.bpm / b.bpm >= TEMPO_RATE_MIN &&
    a.bpm / b.bpm <= TEMPO_RATE_MAX;
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
  const { barMs, tempoAligned } = coordinatedBarMs(a, b);
  if (!(barMs > 0)) {
    return { ms: AUTO_FALLBACK_MS, auto: true, bars: 0, barMs: 0, note: '无拍点，回退固定时长' };
  }

  let bars = AUTO_BARS;
  let note = tempoAligned ? '两首变速对齐，默认一个乐句' : '两首拍速差较大，取平均小节';
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

/** 本次淡化目标时长：手动固定秒数，或 auto 的「两首歌小节 + 结构空间」方案。 */
function resolveFadePlan(
  options: CrossfadePrepareOptions,
  ctx: Parameters<typeof buildAutoFadePlan>[1],
): AutoFadePlan {
  const settings = readCrossfadeSettings();
  if (settings.length !== 'auto') {
    return { ms: settings.length * 1000, auto: false, bars: 0, barMs: 0, note: '手动档位' };
  }
  return buildAutoFadePlan(options, ctx);
}

/**
 * 生成时间表：A 在「可听结尾」倒数第 fadeMs 处的强拍开始淡化，B 从自己的强拍起播。
 * task-22：淡化终点对齐 analysis.audibleEndMs（排除尾部静音）；旧宿主缺失该字段时回退曲内时长。
 * 返回 null = 这次不适合无缝（时长不够 / B 太短 / 已经错过窗口）。
 */
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
  const settings = readCrossfadeSettings();
  const rawLastVocalEnd = options.currentLastVocalEndMs;
  const lastVocalEndPosMs =
    typeof rawLastVocalEnd === 'number' && Number.isFinite(rawLastVocalEnd) && rawLastVocalEnd > 0
      ? Math.round(Math.min(rawLastVocalEnd, durationMs))
      : 0;
  const tailAfterVocalMs = lastVocalEndPosMs > 0 ? audibleEndPosMs - lastVocalEndPosMs : 0;
  const handoffFadeMs = Math.round(Math.min(MAX_FADE_MS, Math.max(MIN_FADE_MS, tailAfterVocalMs)));
  const bTailAfterVocalMs = nextDurationMs > 0 ? nextDurationMs - vocalPosMs : Number.POSITIVE_INFINITY;
  const canHandoff =
    settings.handoff &&
    settings.length === 'auto' &&
    lastVocalEndPosMs > 0 &&
    vocalFileMs > 0 &&
    tailAfterVocalMs >= MIN_FADE_MS &&
    currentStartMs + lastVocalEndPosMs >= currentStartMs + currentPosMs + 80 &&
    bTailAfterVocalMs >= handoffFadeMs + 400;
  let handoff = canHandoff;

  let plannedFadeMs = handoff ? handoffFadeMs : desiredMs;
  let bStartFileMs = handoff ? vocalFileMs : baseBStartFileMs;
  let vocalAligned = handoff;
  if (!handoff && vocalFileMs > 0) {
    const candidate = vocalFileMs - desiredMs;
    if (candidate >= nextStartMs + 250) {
      // 前奏够长：从「唱词前 desiredMs」处起播，淡化结束正好进入唱词（更早的前奏直接跳过）；
      // 起播点尽量贴在强拍上，保证淡化期间鼓点依然对齐。
      const nearby = pickDownbeatNear(nextAnalysis, candidate, nextStartMs);
      bStartFileMs = nearby !== null && Math.abs(nearby - candidate) <= 200 ? nearby : Math.round(candidate);
      vocalAligned = true;
    } else if (vocalFileMs - baseBStartFileMs >= MIN_FADE_MS) {
      // 前奏比目标淡化还短：把整段前奏当成过渡，淡化终点 = 唱词起点。
      plannedFadeMs = Math.max(MIN_FADE_MS, Math.min(desiredMs, vocalFileMs - baseBStartFileMs));
      bStartFileMs = baseBStartFileMs;
      vocalAligned = true;
    }
    // 前奏太短（< MIN_FADE_MS）或数据异常：保持普通淡化，B 从第一个强拍起播。
  }

  // ---- A 侧：终点固定为可听结尾，按本次淡化时长反推起点，并尽量贴强拍 ----
  // 歌词衔接时起点就是「最后一句唱完」，不再贴强拍（要正好接上人声）。
  const targetFileMs = fileAudibleEndMs - plannedFadeMs;
  const downbeat = handoff ? null : pickDownbeatNear(analysis, targetFileMs, currentStartMs);
  let fadeStartFile = downbeat === null ? targetFileMs : downbeat;

  // 淡化窗口终点固定为可听结尾（不把淡化拖进尾部静音），只对起点夹取时长：
  // 早不过 MAX_FADE_MS、晚不过可听结尾前 MIN_FADE_MS，且不早于曲目/分段起点。
  if (fileAudibleEndMs - fadeStartFile > MAX_FADE_MS) fadeStartFile = fileAudibleEndMs - MAX_FADE_MS;
  if (fileAudibleEndMs - fadeStartFile < MIN_FADE_MS) fadeStartFile = fileAudibleEndMs - MIN_FADE_MS;
  if (fadeStartFile < currentStartMs) fadeStartFile = currentStartMs;

  // 已经错过起点（分析回来太晚 / 用户 seek 过）：从当前位置开始缩短淡化，否则放弃。
  const earliestStart = currentStartMs + currentPosMs + 80;
  if (fadeStartFile < earliestStart) fadeStartFile = earliestStart;
  if (fileAudibleEndMs - fadeStartFile < MIN_FADE_MS) return null;
  if (fileAudibleEndMs - fadeStartFile > MAX_FADE_MS) fadeStartFile = fileAudibleEndMs - MAX_FADE_MS;

  const fadeMs = Math.round(fileAudibleEndMs - fadeStartFile);
  if (fadeMs < MIN_FADE_MS) return null;

  // B 太短，撑不到淡化结束：回退普通方案（B 从开头/第一个强拍起播）；仍不行就放弃。
  if (nextDurationMs > 0) {
    const availableMs = nextDurationMs - (bStartFileMs - nextStartMs);
    if (availableMs < fadeMs + 400) {
      vocalAligned = false;
      handoff = false;
      bStartFileMs = baseBStartFileMs;
      if (nextDurationMs - (bStartFileMs - nextStartMs) < fadeMs + 400) return null;
    }
  }

  // ---- WSOLA 节拍对齐：把 B 的播放速率调到与 A 拍间隔一致，再微调 B 起播相位到同拍 ----
  let tempoRate = 1;
  const aBpm = analysis.bpm;
  const bBpm = nextAnalysis.bpm;
  if (aBpm >= 40 && bBpm >= 40) {
    const raw = aBpm / bBpm;
    // 超过 ±12% 会明显听出快/慢，宁可不变速、按原强拍起播。
    if (raw >= TEMPO_RATE_MIN && raw <= TEMPO_RATE_MAX && Math.abs(raw - 1) >= 0.004) {
      tempoRate = Math.round(raw * 1000) / 1000;
    }
  }
  // 歌词衔接时 B 的起播点就是首句，不再做「贴到同拍」的相位微调（会破坏人声对齐）。
  if (!handoff && tempoRate !== 1 && bStartFileMs > 0) {
    const beatA = analysis.beatIntervalMs > 0 ? analysis.beatIntervalMs : 60_000 / aBpm;
    const beatB = nextAnalysis.beatIntervalMs > 0 ? nextAnalysis.beatIntervalMs : 60_000 / bBpm;
    const firstA = currentStartMs + Math.max(0, analysis.firstBeatMs);
    const firstB = nextStartMs + Math.max(0, nextAnalysis.firstBeatMs);
    const toNextA = beatA - mod(fadeStartFile - firstA, beatA); // A 到下一拍的真实时间
    const toNextB = beatB - mod(bStartFileMs - firstB, beatB); // B 文件内到下一拍
    // B 以 tempoRate 播放：文件偏移 / rate = 真实时间偏移；让两边下一拍落在同一时刻。
    let shift = toNextB - toNextA * tempoRate;
    while (shift > beatB / 2) shift -= beatB;
    while (shift < -beatB / 2) shift += beatB;
    if (Math.abs(shift) <= 220) bStartFileMs = Math.round(bStartFileMs + shift);
  }
  if (nextLimitMs > 0 && bStartFileMs > nextLimitMs) bStartFileMs = nextLimitMs;

  return {
    fadeStartFileMs: fadeStartFile,
    fadeStartPosMs: fadeStartFile - currentStartMs,
    fadeMs,
    bStartFileMs,
    tempoRate,
    audibleEndPosMs: Math.round(audibleEndPosMs),
    tailSilenceMs: Math.round(tailSilenceMs),
    nextVocalStartMs: vocalPosMs,
    vocalAligned,
    handoff,
    lastVocalEndPosMs,
    autoFadeMs: fadePlan.auto ? fadePlan.ms : 0,
    autoBars: fadePlan.bars,
    autoBarMs: fadePlan.barMs,
    autoNote: handoff
      ? `歌词衔接：A 末句 ${lastVocalEndPosMs} ms 唱完，接下一首首句 ${vocalPosMs} ms`
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
  plan.audibleEndPosMs = schedule.audibleEndPosMs;
  debug.fadeStartPosMs = schedule.fadeStartPosMs;
  debug.fadeMs = schedule.fadeMs;
  debug.bStartFileMs = schedule.bStartFileMs;
  debug.tempoRate = schedule.tempoRate;
  debug.tempoMatched = Math.abs(schedule.tempoRate - 1) > 0.001;
  debug.currentAudibleEndMs = schedule.audibleEndPosMs;
  debug.tailSilenceMs = schedule.tailSilenceMs;
  debug.nextVocalStartMs = schedule.nextVocalStartMs;
  debug.vocalAligned = schedule.vocalAligned;
  debug.handoffActive = schedule.handoff;
  debug.lastVocalEndPosMs = schedule.lastVocalEndPosMs;
  debug.autoFadeMs = schedule.autoFadeMs;
  debug.autoBars = schedule.autoBars;
  debug.autoBarMs = schedule.autoBarMs;
  debug.autoNote = schedule.autoNote;
}

/** seek 到指定文件秒数；元数据还没到时挂一次性 loadedmetadata 兜底。 */
function seekDeck(element: HTMLAudioElement, fileSeconds: number): boolean {
  const target = Math.max(0, fileSeconds);
  try {
    if (element.readyState >= 1) {
      element.currentTime = target;
      return true;
    }
    const apply = (): void => {
      element.removeEventListener('loadedmetadata', apply);
      try {
        element.currentTime = target;
      } catch {
        /* 忽略：已进入播放，位置由 preload 决定 */
      }
    };
    element.addEventListener('loadedmetadata', apply);
    return true;
  } catch (err) {
    logEvent('b-seek-failed', messageOf(err));
    return false;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 准备下一首的无缝衔接（异步分析完成后由 player 调用）。
 * 成功返回 true；失败/不适合返回 false（player 无需回滚，仍走原来的 ended 硬切）。
 */
export function prepareCrossfade(options: CrossfadePrepareOptions): boolean {
  cancelCrossfade('replaced');
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
  const graphMode = audioTapGraphActive();
  if (graphMode && (!attachDeckToGraph(options.active) || !attachDeckToGraph(options.standby))) {
    logEvent('prepare-skip', '无法把两个 deck 接入 Web Audio 图，回退硬切');
    return false;
  }
  if (graphMode) {
    setDeckGraphGain(options.active, 1);
    setDeckGraphGain(options.standby, 0);
  }
  const plan: ActivePlan = {
    kind: 'auto',
    options,
    phase: 'prepared',
    graphMode,
    tempoRate: 1,
    handoff: false,
    lastVocalEndPosMs: 0,
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
  // 预先把 B 的速率与伴奏倾斜设置好：淡化开始时不用临时改，避免首帧爆音。
  const baseRate = baseDeckRate(options);
  setDeckPlaybackRate(options.standby, baseRate * plan.tempoRate);
  setDeckPlaybackRate(options.active, baseRate);
  if (graphMode) {
    setDeckGraphTilt(options.active, 0, 0);
    setDeckGraphTilt(options.standby, -TILT_MAX_DB, -TILT_MAX_DB);
  }
  activePlan = plan;
  debug.phase = 'prepared';
  debug.reason = '';
  debug.currentTitle = options.current.track.title;
  debug.nextTitle = options.next.track.title;
  debug.crossfadeKind = 'auto';
  debug.nextPrepared = true;
  debug.progress = 0;
  debug.baseVolume = clamp01(options.baseVolume());
  logEvent(
    'prepared',
    plan.handoff
      ? `「${options.current.track.title}」→「${options.next.track.title}」，歌词衔接：A 末句 ${plan.lastVocalEndPosMs} ms 唱完接 B 首句，${plan.fadeMs} ms 人声缓慢浮现、伴奏渐入`
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
    lastVocalEndPosMs: 0,
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
  debug.nextVocalStartMs = 0;
  debug.vocalAligned = false;
  debug.handoffActive = false;
  debug.lastVocalEndPosMs = 0;
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
  if (plan.graphMode) {
    // 图内淡化：主音量走本地 gain（元素音量固定 1），A/B 各自由 deck gain 控制。
    setAudioTapVolume(base, true);
    setDeckGraphGain(plan.options.active, 1);
    setDeckGraphGain(plan.options.standby, 0);
    // 起始时 B 的伴奏压到最低（只留中频和人声），随后在淡化中慢慢回到 0dB。
    setDeckGraphTilt(plan.options.active, 0, 0);
    if (plan.handoff) {
      setDeckGraphTilt(plan.options.standby, 0, 0);
      setDeckGraphVocalFocus(plan.options.standby, 1);
    } else {
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
  logEvent('fade-start', `B 从文件 ${Math.round(plan.bStartFileMs)} ms 起播，淡化 ${plan.fadeMs} ms`);
  plan.options.standby.play().then(
    () => {
      if (activePlan !== plan || plan.phase !== 'fading') return;
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
  applyEqualPowerGains(plan, progress);
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
    setAudioTapVolume(plan.baseVolume, true);
    setDeckGraphGain(plan.options.active, 0);
    setDeckGraphGain(plan.options.standby, 1);
    setDeckGraphTilt(plan.options.active, 0, 0);
    setDeckGraphTilt(plan.options.standby, 0, 0);
    setDeckGraphVocalFocus(plan.options.active, 0);
    setDeckGraphVocalFocus(plan.options.standby, 0);
    detachDeckFromGraph(plan.options.active);
  } else {
    setDeckVolume(plan.options.active, 0);
    setDeckVolume(plan.options.standby, plan.baseVolume);
  }
  // 变速不变调只用于过渡期间：结束后把 B 的速率平滑拉回用户倍速（默认 1），整首歌恢复原速。
  const baseRate = baseDeckRate(plan.options);
  const bRate = baseRate * plan.tempoRate;
  if (Math.abs(bRate - baseRate) >= 0.001) {
    returnDeckTempoToNormal(plan.options.standby, bRate, baseRate);
  } else {
    setDeckPlaybackRate(plan.options.standby, baseRate);
  }
  setDeckPlaybackRate(plan.options.active, baseRate);
  activePlan = null;
  debug.phase = 'done';
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
    // A 可能仍在图里，确保它静音；B 没接图，继续用元素音量。
    setDeckGraphGain(plan.options.active, 0);
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
  if (plan.raf) {
    cancelAnimationFrame(plan.raf);
    plan.raf = 0;
  }
  if (plan.phase === 'fading') {
    const base = clamp01(plan.options.baseVolume());
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

/**
 * 构造播放页「无缝衔接（实验）」区块；scope 用于设置弹窗关闭时退订。
 * QA 钩子：crossfade-section / crossfade-toggle / crossfade-length（每个选项带 data-length）。
 */
export function buildCrossfadeSection(scope: Disposers | null): HTMLElement {
  const toggle = h('button', {
    class: 'analysis-toggle',
    type: 'button',
    'data-qa': 'crossfade-toggle',
    'aria-pressed': 'false',
  });
  const lengthRow = h('div', { class: 'analysis-actions' });
  const lengthButtons: Array<{ value: CrossfadeLength; button: HTMLButtonElement }> = [];
  for (const value of LENGTH_VALUES) {
    const button = h(
      'button',
      {
        class: 'analysis-toggle',
        type: 'button',
        'data-qa': 'crossfade-length',
        'data-length': String(value),
        'aria-pressed': 'false',
        title:
          value === 'auto'
            ? '自动：按两首歌的拍点/小节与前后奏空间自由决定，不再固定 5–10 秒'
            : `固定 ${value} 秒交叉淡化`,
      },
      value === 'auto' ? '自动' : `${value} 秒`,
    );
    lengthButtons.push({ value, button });
    lengthRow.append(button);
  }

  const handoffToggle = h('button', {
    class: 'analysis-toggle',
    type: 'button',
    'data-qa': 'crossfade-handoff',
    'aria-pressed': 'false',
    title: '上一首最后一句歌词唱完的瞬间接下一首第一句：人声先出、伴奏渐入（需要过渡时长为「自动」）',
  });

  const root = h('div', { class: 'analysis-section', 'data-qa': 'crossfade-section' });

  function paint(): void {
    const settings = readCrossfadeSettings();
    toggle.textContent = settings.enabled ? '已开启' : '已关闭';
    toggle.classList.toggle('is-on', settings.enabled);
    toggle.setAttribute('aria-pressed', settings.enabled ? 'true' : 'false');
    handoffToggle.textContent = settings.handoff ? '已开启' : '已关闭';
    handoffToggle.classList.toggle('is-on', settings.handoff);
    handoffToggle.setAttribute('aria-pressed', settings.handoff ? 'true' : 'false');
    handoffToggle.disabled = settings.length !== 'auto';
    handoffToggle.title = settings.handoff
      ? '歌词衔接已开启：上一首末句唱完接下一首首句（需要过渡时长 = 自动）'
      : '歌词衔接已关闭：按拍点/小节普通淡化';
    for (const { value, button } of lengthButtons) {
      const on = value === settings.length;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    root.dataset.enabled = settings.enabled ? '1' : '0';
  }

  toggle.addEventListener('click', () => {
    const current = readCrossfadeSettings();
    const next = writeCrossfadeSettings({ enabled: !current.enabled });
    paint();
    toast(next.enabled ? '无缝衔接已开启：下一首会按鼓点交叉淡化' : '无缝衔接已关闭');
  });
  for (const { value, button } of lengthButtons) {
    button.addEventListener('click', () => {
      writeCrossfadeSettings({ length: value });
      paint();
    });
  }
  handoffToggle.addEventListener('click', () => {
    const current = readCrossfadeSettings();
    const next = writeCrossfadeSettings({ handoff: !current.handoff });
    paint();
    toast(
      next.handoff
        ? '歌词衔接已开启：下一首首句会接上一首末句（人声缓慢浮现、伴奏渐入）'
        : '歌词衔接已关闭：恢复按拍点/小节普通淡化',
    );
  });

  const onSettingsChange = (): void => paint();
  window.addEventListener('zilux:crossfade', onSettingsChange);
  scope?.add(() => window.removeEventListener('zilux:crossfade', onSettingsChange));

  root.append(
    h('h3', { class: 'section-title', text: '无缝衔接（实验）' }),
    h('p', {
      class: 'analysis-desc',
      text: '当前歌曲结束前，按鼓点提前开始下一首，并按等功率曲线交叉淡化（B 用更慢的进入曲线，避免一上来就大声；A 多留一点尾音），避免曲间静音；淡化终点对齐歌曲的可听结尾，自动跳过曲尾静音与明显渐弱收尾（需宿主分析支持 audibleEndMs，p0-5 起）。淡化结束时机对齐下一首的「开始唱词」（有歌词时）：前奏较长会跳过前奏、从唱词前若干秒切入；前奏较短则把整段前奏当作过渡，结束时正好进入唱词。过渡时长「自动」不再固定 5–10 秒：以两首歌的小节为基准（默认一个乐句 4 小节，拍速差大时取两首的平均小节），B 前奏到唱词的空间不足时按整小节缩短、A 尾奏与 B 前奏都宽裕时放宽到 6–8 小节、小节很短（快歌/双拍）时取两个乐句，实际时长随歌曲自由变化。两首 BPM 不同时会用 WSOLA 变速不变调（±12% 内）把 B 的节拍拉齐，过渡结束后平滑恢复原速；图内路径下 A 的伴奏先退、B 的伴奏慢慢回正，人声先出现、伴奏后融进来。自然播完（列表循环 / 随机播放）与单曲循环都会自动衔接；手动切歌（下一首 / 上一首 / 点列表）走 1.2–2.0 秒等功率短过渡，不等节拍分析。均衡器/人声保留淡出等 Web Audio 音效开启时自动改走图内增益淡化，否则回退为原来的硬切。「歌词衔接」（默认开启，仅过渡时长=自动时生效）：上一首最后一句歌词唱完的瞬间接下一首第一句——B 的起播点直接对准首句，B 的人声用约 2–6 秒缓慢浮现（淡化越长越慢）、不再硬切入，前几秒用「人声聚焦」把 B 的低频/高频压住、抬高 1.8 kHz 临场感，让中频人声先出来，伴奏随后慢慢打开；如果上一首末句之后没有足够长的尾奏（不足 1.2 秒），自动回退成上面的普通淡化。首句/末句都会过滤歌词里的制作人员名单（作词、作曲、Lyrics by…）和间奏标记，避免过渡点落到没人唱的地方。',
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
        toggle,
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '过渡时长' }),
          h('div', { class: 'field-hint', text: '自动 = 两首歌的拍点/小节 + 前奏尾奏空间自适应，时长自由变化；手动可选 3–30 秒' }),
        ),
        lengthRow,
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
            text: '上一首末句唱完立刻接下一首首句，人声先出、伴奏渐入；尾奏不够长时自动回退普通淡化（需过渡时长 = 自动）',
          }),
        ),
        handoffToggle,
      ),
    ),
    h('p', {
      class: 'analysis-footnote',
      text: '切歌后先异步分析当前与下一首（本地约 1–5 秒）并读取两首歌词的人声首末句（本地同名 .lrc / 在线歌词，自动过滤制作人员名单），任一失败则回退为普通淡化或硬切。开启均衡器 / 人声保留淡出 / 歌词页频谱等 Web Audio 音效时，两个 deck 都会接进混音图，用各自增益做等功率淡化（主音量不变），并靠低/高架滤波做「人声先出现、伴奏慢慢融合」；过渡期间用 WSOLA 变速不变调对齐鼓点（preservesPitch），结束后平滑恢复原速。',
    }),
  );

  paint();
  return root;
}
