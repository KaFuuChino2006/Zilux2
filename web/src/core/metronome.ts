/**
 * 节拍器（P0 试听）：按节拍分析出的拍点，在播放中的音频上打 click。
 *
 * 调度方式（Web Audio）：
 *   - 首次开启时自建 AudioContext（不碰 audioTap 的 EQ 图，避免互相影响）；
 *   - setInterval 式轮询（120 ms；页面隐藏时 250 ms 兜底），每次只排未来 250 ms 内的拍点，
 *     用 ctx.currentTime + (拍点文件时间 - 当前文件时间) / 1000 调度 oscillator；
 *   - 强拍（每小节第一拍）1760 Hz，普通拍 1046 Hz，指数衰减 ~30 ms；
 *   - 播放位置用「锚点 + performance.now() 推算」，避免后台 rAF 停转时 playerState 进度停更；
 *     暂停 / 拖动 / 切歌 / 关闭时清空待发 click。
 */

import { cachedAnalysis } from '../online/analysis';
import { onPlayer, playerState, type PlayerState } from '../ui/player';

export interface MetronomeSettings {
  /** 总开关；开启后仅在播放中发声 */
  enabled: boolean;
  /** 音量 0–1 */
  volume: number;
  /** 强拍加重（每小节第一拍用更高音） */
  accent: boolean;
}

const STORAGE_KEY = 'zilux2.analysisDemo';
const TICK_FOREGROUND_MS = 120;
const TICK_HIDDEN_MS = 250;
/** 每次 tick 只排未来这么多毫秒内的拍点 */
const LOOKAHEAD_MS = 250;
const DOWNBEAT_HZ = 1760;
const BEAT_HZ = 1046;
const CLICK_DECAY_S = 0.03;
/** 播放进度跳变超过这个值就当作拖动/切歌 */
const JUMP_MS = 150;

const DEFAULT_SETTINGS: MetronomeSettings = { enabled: false, volume: 0.5, accent: true };

interface ClickAnchor {
  /** 锚点时刻的「文件内时间」（毫秒） */
  fileMs: number;
  /** performance.now() 锚点时刻 */
  at: number;
  trackKey: string;
}

interface PendingClick {
  osc: OscillatorNode;
  at: number;
}

let settings: MetronomeSettings = readSettings();
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let anchor: ClickAnchor | null = null;
let lastScheduledBeatMs = Number.NEGATIVE_INFINITY;
let pending: PendingClick[] = [];
let timer = 0;
let initialized = false;
let disposed = false;
let playerUnsubscribe: (() => void) | null = null;
const listeners = new Set<() => void>();

/* ------------------------------------------------------------------ */
/* 设置（localStorage 持久化）                                          */
/* ------------------------------------------------------------------ */

function readSettings(): MetronomeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<MetronomeSettings> | null;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS };
    return {
      enabled: parsed.enabled === true,
      volume: clampVolume(typeof parsed.volume === 'number' ? parsed.volume : DEFAULT_SETTINGS.volume),
      accent: parsed.accent !== false,
    };
  } catch (_err) {
    return { ...DEFAULT_SETTINGS };
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (_err) {
    /* localStorage 不可用时忽略 */
  }
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.volume;
  return Math.min(1, Math.max(0, value));
}

export function metronomeSettings(): MetronomeSettings {
  return { ...settings };
}

/** 修改节拍器设置（会持久化并立即生效）。返回最新设置副本。 */
export function updateMetronomeSettings(patch: Partial<MetronomeSettings>): MetronomeSettings {
  const next: MetronomeSettings = { ...settings };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (typeof patch.volume === 'number') next.volume = clampVolume(patch.volume);
  if (typeof patch.accent === 'boolean') next.accent = patch.accent;
  const changed =
    next.enabled !== settings.enabled || next.volume !== settings.volume || next.accent !== settings.accent;
  settings = next;
  if (!changed) return { ...settings };
  persist();
  if (settings.enabled) {
    void ensureContext();
    startLoop();
  } else {
    stopLoop();
    cancelPending();
    anchor = null;
  }
  applyVolume();
  emit();
  return { ...settings };
}

/** 订阅设置变化（UI 同步开关/音量）。 */
export function onMetronomeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.warn('[metronome] listener failed', err);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Web Audio click                                                    */
/* ------------------------------------------------------------------ */

async function ensureContext(): Promise<void> {
  if (disposed) return;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      console.warn('[metronome] AudioContext unavailable');
      return;
    }
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = settings.volume;
      master.connect(ctx.destination);
    } catch (err) {
      console.warn('[metronome] AudioContext creation failed', err);
      ctx = null;
      master = null;
      return;
    }
  }
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch (err) {
      console.warn('[metronome] AudioContext resume failed', err);
    }
  }
}

function applyVolume(): void {
  if (!master || !ctx) return;
  master.gain.setTargetAtTime(settings.volume, ctx.currentTime, 0.01);
}

function scheduleClick(delaySeconds: number, downbeat: boolean): void {
  if (!ctx || !master || disposed) return;
  const at = ctx.currentTime + Math.max(0, delaySeconds);
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(downbeat && settings.accent ? DOWNBEAT_HZ : BEAT_HZ, at);
  const peak = (downbeat && settings.accent ? 0.32 : 0.2) * Math.max(0.05, settings.volume);
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(peak, at + 0.002);
  env.gain.exponentialRampToValueAtTime(0.0001, at + CLICK_DECAY_S);
  osc.connect(env);
  env.connect(master);
  osc.start(at);
  osc.stop(at + CLICK_DECAY_S + 0.01);
  pending.push({ osc, at });
}

/** 停掉所有已排但还没响的 click（暂停/拖动/切歌/关闭）。 */
function cancelPending(): void {
  for (const click of pending) {
    try {
      click.osc.stop();
    } catch (_err) {
      /* 已停止的节点再 stop 不报错，防御一下 */
    }
    try {
      click.osc.disconnect();
    } catch (_err) {
      /* 忽略 */
    }
  }
  pending = [];
}

function prunePending(now: number): void {
  if (pending.length === 0) return;
  pending = pending.filter((click) => {
    if (click.at >= now - 0.25) return true;
    try {
      click.osc.disconnect();
    } catch (_err) {
      /* 忽略 */
    }
    return false;
  });
}

/* ------------------------------------------------------------------ */
/* 调度循环                                                           */
/* ------------------------------------------------------------------ */

function startLoop(): void {
  if (timer || disposed) return;
  timer = window.setTimeout(tick, TICK_FOREGROUND_MS);
}

function stopLoop(): void {
  if (!timer) return;
  window.clearTimeout(timer);
  timer = 0;
}

function tick(): void {
  timer = 0;
  if (disposed) return;
  if (!settings.enabled) {
    stopLoop();
    return;
  }
  try {
    runSchedule();
  } catch (err) {
    console.warn('[metronome] tick failed', err);
  }
  timer = window.setTimeout(tick, document.hidden ? TICK_HIDDEN_MS : TICK_FOREGROUND_MS);
}

function runSchedule(): void {
  const now = performance.now();
  const state = playerState();
  const track = state.track;
  if (!state.playing || !track) {
    anchor = null;
    cancelPending();
    return;
  }
  const result = cachedAnalysis(track);
  if (!result) {
    anchor = null;
    cancelPending();
    return;
  }
  const analysis = result.analysis;
  const interval = analysis.beatIntervalMs;
  if (!Number.isFinite(interval) || interval < 40 || interval > 4000) {
    anchor = null;
    cancelPending();
    return;
  }
  const key = trackKey(state);
  if (!anchor || anchor.trackKey !== key) {
    anchor = { fileMs: fileTimeMs(state), at: now, trackKey: key };
    lastScheduledBeatMs = anchor.fileMs - interval;
    cancelPending();
  }
  if (ctx) prunePending(ctx.currentTime);
  const fileNow = predictedFileMs(now);
  const firstBeatMs = Number.isFinite(analysis.firstBeatMs) ? analysis.firstBeatMs : 0;
  const meter = analysis.meter === 3 ? 3 : 4;
  const downOffset = Number.isFinite(analysis.firstDownbeatMs)
    ? Math.round((analysis.firstDownbeatMs - firstBeatMs) / interval)
    : 0;
  const horizon = fileNow + LOOKAHEAD_MS;
  let index = Math.max(0, Math.ceil((Math.max(fileNow - 80, lastScheduledBeatMs + 1) - firstBeatMs) / interval));
  for (let guard = 0; guard < 256; guard += 1) {
    const beatMs = firstBeatMs + index * interval;
    if (beatMs > horizon) break;
    if (beatMs < fileNow - 80) {
      index += 1;
      continue;
    }
    if (beatMs > lastScheduledBeatMs) {
      const mod = (((index - downOffset) % meter) + meter) % meter;
      scheduleClick((beatMs - fileNow) / 1000, mod === 0);
      lastScheduledBeatMs = beatMs;
    }
    index += 1;
  }
}

function predictedFileMs(now: number): number {
  if (!anchor) return fileTimeMs(playerState());
  return anchor.fileMs + (now - anchor.at);
}

/** 当前播放位置的「文件内时间」；本地 CUE 分轨要补上 startAt 偏移。 */
function fileTimeMs(state: PlayerState): number {
  return state.positionMs + (state.track?.startAt ?? 0) * 1000;
}

function trackKey(state: PlayerState): string {
  const track = state.track;
  return track ? `${track.source}:${track.id}` : '';
}

/** 播放状态变化：切歌/跳变重新取锚点，暂停时清空待发。 */
function handlePlayer(state: PlayerState): void {
  if (!settings.enabled) return;
  if (!state.playing || !state.track) {
    anchor = null;
    cancelPending();
    return;
  }
  const now = performance.now();
  const fileMs = fileTimeMs(state);
  const key = trackKey(state);
  if (!anchor || anchor.trackKey !== key || Math.abs(fileMs - predictedFileMs(now)) > JUMP_MS) {
    anchor = { fileMs, at: now, trackKey: key };
    cancelPending();
    lastScheduledBeatMs = fileMs - (cachedAnalysis(state.track)?.analysis.beatIntervalMs ?? 0);
  }
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                           */
/* ------------------------------------------------------------------ */

/** 幂等初始化：订阅播放状态；若上次退出前是开启状态则恢复调度。 */
export function initMetronome(): void {
  if (initialized || disposed) return;
  initialized = true;
  playerUnsubscribe = onPlayer(handlePlayer);
  if (settings.enabled) {
    void ensureContext();
    startLoop();
  }
}

/** 应用销毁时调用：停调度、退订、关闭 AudioContext。 */
export function disposeMetronome(): void {
  if (disposed) return;
  disposed = true;
  stopLoop();
  cancelPending();
  playerUnsubscribe?.();
  playerUnsubscribe = null;
  anchor = null;
  initialized = false;
  const closing = ctx;
  ctx = null;
  master = null;
  if (closing) {
    void closing.close().catch(() => {
      /* 已关闭时忽略 */
    });
  }
  listeners.clear();
}
