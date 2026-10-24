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
 * - 淡化曲线用等功率：A = cos(p·π/2)、B = sin(p·π/2)，交叉点两首各约 0.707 幅度，听感不塌陷。
 */

import {
  attachDeckToGraph,
  audioTapGraphActive,
  detachDeckFromGraph,
  setAudioTapVolume,
  setDeckGraphGain,
} from '../core/audioTap';
import type { AnalysisResult, BeatAnalysis } from '../online/analysis';
import type { OnlineTrack } from '../online/types';
import { h, toast, type Disposers } from './dom';

/* ------------------------------------------------------------------ */
/* 设置（localStorage）                                                */
/* ------------------------------------------------------------------ */

export type CrossfadeLength = 'auto' | '4' | '6' | '8';

export interface CrossfadeSettings {
  enabled: boolean;
  /** auto = 按当前歌曲 2 小节自动决定；4/6/8 = 固定秒数 */
  length: CrossfadeLength;
}

export const CROSSFADE_STORAGE_KEY = 'zilux2.crossfade';

const DEFAULT_SETTINGS: CrossfadeSettings = { enabled: true, length: 'auto' };
const LENGTH_VALUES: CrossfadeLength[] = ['4', '6', '8', 'auto'];
const FIXED_LENGTH_MS: Record<Exclude<CrossfadeLength, 'auto'>, number> = {
  '4': 4_000,
  '6': 6_000,
  '8': 8_000,
};

/** auto 长度 = 2 小节（按 A 的拍号与拍间隔），再夹在这个范围内。 */
const AUTO_BARS = 2;
const AUTO_MIN_MS = 3_000;
const AUTO_MAX_MS = 8_000;
const AUTO_FALLBACK_MS = 4_000;

/** 淡化太短听不出、太长会盖住半首歌，都夹住。 */
const MIN_FADE_MS = 1_200;
const MAX_FADE_MS = 12_000;

/** tick 到点前的提前量（rAF 约 16 ms 一帧，留一帧余量）。 */
const TRIGGER_LEAD_MS = 120;
/** 已经越过淡化起点超过这个量就放弃本次衔接（回退硬切）。 */
const MISS_TOLERANCE_MS = 900;

function normalizeLength(value: unknown): CrossfadeLength {
  return value === 'auto' || value === '4' || value === '6' || value === '8' ? value : DEFAULT_SETTINGS.length;
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
  };
  try {
    localStorage.setItem(CROSSFADE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* localStorage 不可用：忽略，仅本次会话生效 */
  }
  debug.enabled = next.enabled;
  debug.length = next.length;
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
  /** A 的「可听结尾」（曲内毫秒）：调度以它为终点；旧宿主无 audibleEndMs 时 = 曲内时长 */
  currentAudibleEndMs: number;
  /** A 的尾部静音（毫秒）= 曲内时长 - currentAudibleEndMs；无静音为 0 */
  tailSilenceMs: number;
  progress: number;
  baseVolume: number;
  events: CrossfadeDebugEvent[];
  settings: () => CrossfadeSettings;
  snapshot: () => CrossfadeDebugState;
}

const debug: CrossfadeDebugState = {
  enabled: DEFAULT_SETTINGS.enabled,
  length: DEFAULT_SETTINGS.length,
  phase: 'idle',
  reason: '',
  currentTitle: '',
  nextTitle: '',
  fadeStartPosMs: 0,
  fadeMs: 0,
  bStartFileMs: 0,
  currentAudibleEndMs: 0,
  tailSilenceMs: 0,
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

function logEvent(event: string, detail = ''): void {
  debug.events.push({ at: Date.now(), event, detail });
  if (debug.events.length > 40) debug.events.splice(0, debug.events.length - 40);
}

/* ------------------------------------------------------------------ */
/* 计划与引擎                                                          */
/* ------------------------------------------------------------------ */

export interface CrossfadeTrackInfo {
  track: OnlineTrack;
  /** CUE 分轨在文件里的开始秒数（0 = 整轨） */
  startAt: number;
}

export interface CrossfadePrepareOptions {
  /** 当前发声 deck（A） */
  active: HTMLAudioElement;
  /** 预留给下一首的 deck（B） */
  standby: HTMLAudioElement;
  current: CrossfadeTrackInfo;
  next: CrossfadeTrackInfo;
  /** A 的曲内总时长（毫秒） */
  currentDurationMs: number;
  /** A 当前曲内位置（毫秒） */
  currentPositionMs: number;
  currentAnalysis: AnalysisResult;
  nextAnalysis: AnalysisResult;
  /** B 的流地址（由 player 用 streamUrl 解析好，避免本模块依赖 online 层） */
  nextUrl: string;
  /** 读取当前基础音量（用户音量 0..1） */
  baseVolume: () => number;
  /** 这次准备是否仍有效（player 的 token、曲目未变、开关仍开、图未激活） */
  isValid: () => boolean;
  /** 淡化完成（A 已静音、B 已满音量）：player 负责交换 deck 与状态迁移 */
  onFinish: () => void;
}

interface FadeSchedule {
  fadeStartFileMs: number;
  fadeStartPosMs: number;
  fadeMs: number;
  bStartFileMs: number;
  /** A 的可听结尾（曲内毫秒，已排除尾部静音；旧宿主回退为曲内时长） */
  audibleEndPosMs: number;
  /** A 的尾部静音（毫秒）；无静音（含旧宿主回退）为 0 */
  tailSilenceMs: number;
}

interface ActivePlan {
  options: CrossfadePrepareOptions;
  phase: 'prepared' | 'fading';
  /**
   * Web Audio 图已建立时走「图内增益」淡化：两个 deck 都接进 deckMix，用各自 gain 做等功率曲线，
   * 主音量仍由本地 gain 控制；false = 图未建立，用元素音量淡化（旧路径）。
   */
  graphMode: boolean;
  fadeStartFileMs: number;
  fadeStartPosMs: number;
  fadeMs: number;
  bStartFileMs: number;
  /** A 的可听结尾（曲内毫秒）；用于 tick 里判断还剩多少可淡化时间 */
  audibleEndPosMs: number;
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

function setDeckVolume(element: HTMLAudioElement, volume: number): void {
  try {
    element.volume = clamp01(volume);
  } catch {
    /* 忽略：元素可能已被移除 */
  }
}

/** 等功率淡化：A 余弦、B 正弦，交叉点各约 0.707。 */
function applyEqualPowerGains(plan: ActivePlan, progress: number): void {
  const angle = clamp01(progress) * Math.PI * 0.5;
  const outGain = Math.cos(angle);
  const inGain = Math.sin(angle);
  if (plan.graphMode) {
    // 图内：主音量（baseVolume）在本地 gain 上，deck gain 只负责 0~1 的等功率比例。
    setAudioTapVolume(plan.baseVolume, true);
    setDeckGraphGain(plan.options.active, outGain);
    setDeckGraphGain(plan.options.standby, inGain);
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

/** 本次淡化目标时长：固定值 或 auto（A 的 2 小节）。 */
function resolveFadeLength(options: CrossfadePrepareOptions): number {
  const settings = readCrossfadeSettings();
  if (settings.length !== 'auto') return FIXED_LENGTH_MS[settings.length];
  const analysis = options.currentAnalysis.analysis;
  const beat = analysis.beatIntervalMs > 0 ? analysis.beatIntervalMs : 500;
  const meter = analysis.meter >= 2 && analysis.meter <= 16 ? analysis.meter : 4;
  const twoBars = beat * meter * AUTO_BARS;
  if (!(twoBars > 0)) return AUTO_FALLBACK_MS;
  return Math.min(AUTO_MAX_MS, Math.max(AUTO_MIN_MS, twoBars));
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

  const desiredMs = resolveFadeLength(options);
  const targetFileMs = fileAudibleEndMs - desiredMs;
  const downbeat = pickDownbeatNear(analysis, targetFileMs, currentStartMs);
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

  // B 从自己的强拍起播，和 A 的淡化起点同为强拍 → 两边的强拍在淡化开始瞬间对齐。
  const nextStartMs = options.next.startAt * 1000;
  const nextDurationMs =
    options.next.track.durationMs > 0
      ? options.next.track.durationMs
      : Math.max(0, options.nextAnalysis.durationMs - nextStartMs);
  const nextLimitMs = nextDurationMs > 0 ? nextStartMs + nextDurationMs : 0;
  const bDownbeat = pickDownbeatAtOrAfter(options.nextAnalysis.analysis, nextStartMs, nextLimitMs);
  const bStartFileMs = bDownbeat === null ? nextStartMs : bDownbeat;
  // B 太短，撑不到淡化结束：放弃（回退硬切，交给原来的 ended 逻辑）。
  if (nextDurationMs > 0 && nextDurationMs - (bStartFileMs - nextStartMs) < fadeMs + 400) return null;

  return {
    fadeStartFileMs: fadeStartFile,
    fadeStartPosMs: fadeStartFile - currentStartMs,
    fadeMs,
    bStartFileMs,
    audibleEndPosMs: Math.round(audibleEndPosMs),
    tailSilenceMs: Math.round(tailSilenceMs),
  };
}

function applySchedule(plan: ActivePlan, schedule: FadeSchedule): void {
  plan.fadeStartFileMs = schedule.fadeStartFileMs;
  plan.fadeStartPosMs = schedule.fadeStartPosMs;
  plan.fadeMs = schedule.fadeMs;
  plan.bStartFileMs = schedule.bStartFileMs;
  plan.audibleEndPosMs = schedule.audibleEndPosMs;
  debug.fadeStartPosMs = schedule.fadeStartPosMs;
  debug.fadeMs = schedule.fadeMs;
  debug.bStartFileMs = schedule.bStartFileMs;
  debug.currentAudibleEndMs = schedule.audibleEndPosMs;
  debug.tailSilenceMs = schedule.tailSilenceMs;
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
    options,
    phase: 'prepared',
    graphMode,
    fadeStartFileMs: 0,
    fadeStartPosMs: 0,
    fadeMs: 0,
    bStartFileMs: 0,
    audibleEndPosMs: 0,
    startedAt: 0,
    progress: 0,
    baseVolume: 0,
    raf: 0,
  };
  applySchedule(plan, schedule);
  activePlan = plan;
  debug.phase = 'prepared';
  debug.reason = '';
  debug.currentTitle = options.current.track.title;
  debug.nextTitle = options.next.track.title;
  debug.progress = 0;
  debug.baseVolume = clamp01(options.baseVolume());
  logEvent(
    'prepared',
    `「${options.current.track.title}」→「${options.next.track.title}」，${plan.fadeMs} ms 后在曲内 ${Math.round(plan.fadeStartPosMs)} ms 处淡化（可听结尾 ${plan.audibleEndPosMs} ms，尾部静音 ${debug.tailSilenceMs} ms）`,
  );
  return true;
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
  // 实际时长和准备时差太多（元数据后到 / CUE 边界）：重建时间表，建不出来就放弃。
  if (durationMs > 0 && Math.abs(durationMs - plan.options.currentDurationMs) > 500) {
    const updated = buildSchedule({ ...plan.options, currentDurationMs: durationMs, currentPositionMs: positionMs });
    if (!updated) {
      cancelCrossfade('reschedule');
      return;
    }
    plan.options.currentDurationMs = durationMs;
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
  } else {
    setDeckVolume(plan.options.active, base);
    setDeckVolume(plan.options.standby, 0);
  }
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
    detachDeckFromGraph(plan.options.active);
  } else {
    setDeckVolume(plan.options.active, 0);
    setDeckVolume(plan.options.standby, plan.baseVolume);
  }
  activePlan = null;
  debug.phase = 'done';
  debug.reason = 'fade-done';
  debug.progress = 1;
  logEvent('fade-done', 'A 已静音、B 已满音量，交由 player 交换 deck');
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
    detachDeckFromGraph(plan.options.standby);
  }
  plan.baseVolume = base;
  activePlan = null;
  debug.phase = 'done';
  debug.reason = 'graph-hard-cut';
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
      detachDeckFromGraph(plan.options.standby);
    } else {
      setDeckVolume(plan.options.active, base);
      setDeckVolume(plan.options.standby, 0);
    }
  } else if (plan.graphMode) {
    // 只准备未淡化：B 还在图外静音，摘掉即可。
    detachDeckFromGraph(plan.options.standby);
  }
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
        'data-length': value,
        'aria-pressed': 'false',
        title:
          value === 'auto'
            ? '自动：按当前歌曲 2 小节决定（3–8 秒）'
            : `固定 ${value} 秒交叉淡化`,
      },
      value === 'auto' ? '自动' : `${value} 秒`,
    );
    lengthButtons.push({ value, button });
    lengthRow.append(button);
  }

  const root = h('div', { class: 'analysis-section', 'data-qa': 'crossfade-section' });

  function paint(): void {
    const settings = readCrossfadeSettings();
    toggle.textContent = settings.enabled ? '已开启' : '已关闭';
    toggle.classList.toggle('is-on', settings.enabled);
    toggle.setAttribute('aria-pressed', settings.enabled ? 'true' : 'false');
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

  const onSettingsChange = (): void => paint();
  window.addEventListener('zilux:crossfade', onSettingsChange);
  scope?.add(() => window.removeEventListener('zilux:crossfade', onSettingsChange));

  root.append(
    h('h3', { class: 'section-title', text: '无缝衔接（实验）' }),
    h('p', {
      class: 'analysis-desc',
      text: '当前歌曲结束前，按鼓点提前开始下一首，并按等功率曲线交叉淡化（A 余弦、B 正弦），避免曲间静音；淡化终点对齐歌曲的可听结尾，自动跳过曲尾静音（需宿主分析支持 audibleEndMs）。仅在列表循环、下一首分析成功时生效；均衡器/人声保留淡出等 Web Audio 音效开启时自动改走图内增益淡化，否则回退为原来的硬切。',
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
          h('div', { class: 'field-hint', text: '自动 = 当前歌曲 2 小节（3–8 秒）' }),
        ),
        lengthRow,
      ),
    ),
    h('p', {
      class: 'analysis-footnote',
      text: '切歌后先异步分析当前与下一首（本地约 1–5 秒），分析成功才会生效；失败静默回退硬切。开启均衡器 / 人声保留淡出 / 歌词页频谱等 Web Audio 音效时，两个 deck 都会接进混音图，用各自增益做等功率淡化（主音量不变）。',
    }),
  );

  paint();
  return root;
}
