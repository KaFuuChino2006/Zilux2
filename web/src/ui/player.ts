/**
 * 播放引擎：队列、进度、音量、SMTC 上报与系统媒体键。
 *
 * 与旧前端相比只保留必要能力：
 *   - 单 <audio> 元素，队列由调用方传入（墙面/搜索结果/本地库）
 *   - CUE 分轨：track.startAt（秒）+ track.durationMs（该轨时长，0 = 播到文件尾）
 *   - 状态订阅：UI 只监听 onPlayer()，不直接摸 audio
 *   - Windows SMTC：reportMedia() ≤1 次/秒 + onMediaControl() 响应系统媒体键
 */

import { onMediaControl, reportMedia, type MediaControl } from '../core/bridge';
import { fetchStreamInfo, onlineInfo, qualityForSource, streamUrl, checkLiked, addLikedTrack, removeLikedTrack, recordRecent } from '../online/client';
import { analyzeTrack, cachedAnalysis, type AnalysisResult } from '../online/analysis';
import type { OnlineTrack } from '../online/types';
import { getSettings } from '../core/settings';
import { attachAudioTap, audioTapGraphActive, deckGraphConnected, ensureEqualizerGraph, setAudioTapVolume, setDeckGraphGain, setDeckTrimGain, setEqualizer, setLoudnessGainDb, setNightCompressor, setVocalFade } from '../core/audioTap';
import { compensationDbFor, loudnessEnabled, nightModeEnabled } from './loudness';
import {
  cancelCrossfade,
  crossfadeApplyPlaybackRate,
  crossfadeApplyVolume,
  crossfadeFinishNow,
  crossfadeIsFading,
  crossfadeTick,
  MANUAL_FADE_DEFAULT_MS,
  prepareCrossfade,
  prepareLoopCrossfade,
  readCrossfadeSettings,
  setPrefetchDebug,
  startManualCrossfade,
} from './crossfadeDeck';
import { fetchVocalRange } from './vocalStart';

export type PlayMode = 'list' | 'single' | 'shuffle';

const MODE_KEY = 'zilux2.playMode';

/** 当前 audio.src 是用哪个宿主端口（含 token）拼出来的；宿主每次启动换端口，旧地址必然失效。 */
let srcPort = 0;
/** 恢复上次播放时暂存的进度（等用户点播放、拿到新地址后再 seek）。 */
let pendingResumeMs = 0;

/* ------------------------------------------------------------------ */
/* 播放倍速（Phase 2 D：0.5–2.0，默认 1 = 与旧行为完全一致）            */
/* ------------------------------------------------------------------ */

const RATE_KEY = 'zilux2.playbackRate';
const RATE_MIN = 0.5;
const RATE_MAX = 2;

function clampRate(rate: number): number {
  const clamped = Math.max(RATE_MIN, Math.min(RATE_MAX, rate));
  return Math.round(clamped * 100) / 100;
}

function readUserRate(): number {
  try {
    const raw = localStorage.getItem(RATE_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return clampRate(parsed);
    }
  } catch {
    /* 忽略：localStorage 不可用 */
  }
  return 1;
}

let userRate = readUserRate();

/** 给 deck 设置用户倍速（preservesPitch = 变速不变调；越界夹到 0.5–2.0）。 */
function applyDeckRate(element: HTMLAudioElement, rate = userRate): void {
  try {
    const value = clampRate(rate);
    element.preservesPitch = true;
    (element as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    element.playbackRate = value;
    // 切歌时音源走 load()，浏览器会把 playbackRate 重置回 defaultPlaybackRate；
    // 两个都写，倍速才会在换歌后继续生效。
    element.defaultPlaybackRate = value;
  } catch {
    /* 忽略 */
  }
}

/**
 * 设置播放倍速（0.5–2.0，越界夹取；非数字忽略），返回实际生效值。
 * 与无缝衔接的 WSOLA tempoRate 相乘组合：过渡期间 B 的速度由引擎接管，结束后恢复用户倍速。
 */
export function setPlaybackSpeed(rate: number): number {
  if (!Number.isFinite(rate)) return userRate;
  userRate = clampRate(rate);
  try {
    localStorage.setItem(RATE_KEY, String(userRate));
  } catch {
    /* 忽略 */
  }
  applyDeckRate(audio);
  applyDeckRate(standby);
  // 过渡计划存在时把新倍速同步进引擎（B = 用户倍速 × tempoRate）。
  crossfadeApplyPlaybackRate();
  return userRate;
}

export function getPlaybackSpeed(): number {
  return userRate;
}

function readMode(): PlayMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === 'single' || saved === 'shuffle') return saved;
  } catch {
    /* 忽略 */
  }
  return 'list';
}

export interface PlayerState {
  track: OnlineTrack | null;
  queue: OnlineTrack[];
  index: number;
  playing: boolean;
  loading: boolean;
  /** 当前曲内进度（毫秒，已扣除 CUE startAt） */
  positionMs: number;
  /** 当前曲总时长（毫秒，CUE 轨取分轨时长） */
  durationMs: number;
  volume: number;
  /** 当前实际播放倍速（0.5–2.0，来自正在发声 deck） */
  rate: number;
  liked: boolean;
  /** 播放模式：列表 / 单曲循环 / 随机 */
  mode: PlayMode;
  /** 实际下发的音质标签（宿主回传，例如「无损 · FLAC 999k」），未知时为空 */
  streamQuality: string;
}

type Listener = (state: PlayerState) => void;

const listeners = new Set<Listener>();

/**
 * 双 deck：`audio` 是当前发声元素，`standby` 预留给无缝衔接的下一首。
 * 交叉淡化完成后两者交换（见 commitSeamless）；其余既有逻辑继续只认 `audio`。
 */
function createDeck(): HTMLAudioElement {
  const element = new Audio();
  element.preload = 'auto';
  // 页面侧取流（AirPlay 只投送本软件声音）需要拿到 <audio> 的 PCM：媒体走 CORS 请求，
  // 否则跨域资源接进 Web Audio 后只会输出静音。宿主 /api/stream 已带 Access-Control-Allow-Origin。
  element.crossOrigin = 'anonymous';
  return element;
}

const deckA = createDeck();
const deckB = createDeck();
let audio: HTMLAudioElement = deckA;
let standby: HTMLAudioElement = deckB;

/**
 * 淡化中途 Web Audio 图被激活时，活跃 deck 可能不是图绑定的那个元素。
 * 图的 MediaElementSource 只能绑定一个 <audio> 且无法迁移，此时音量只能退回元素音量。
 */
let activeDeckOutsideGraph = false;

/** 播放音效偏好（均衡 + 播放/暂停渐变），由 settings.applySettings 广播同步。 */
interface PlaybackFx {
  fadeEnabled: boolean;
  fadeMs: number;
  fadeOutMs: number;
  fadeInMs: number;
  fadeCurve: string;
  fadeVocal: boolean;
  fadeVocalTailMs: number;
  eqEnabled: boolean;
  eqGains: number[];
}

const FADE_FALLBACK_MS = 450;

function readPlaybackFx(): PlaybackFx {
  const playback = getSettings().playback;
  const legacy = typeof playback.fadeMs === 'number' ? playback.fadeMs : FADE_FALLBACK_MS;
  return {
    fadeEnabled: playback.fadeEnabled,
    fadeMs: legacy,
    fadeOutMs: typeof playback.fadeOutMs === 'number' ? playback.fadeOutMs : legacy,
    fadeInMs: typeof playback.fadeInMs === 'number' ? playback.fadeInMs : legacy,
    fadeCurve: typeof playback.fadeCurve === 'string' ? playback.fadeCurve : 'smooth',
    fadeVocal: playback.fadeVocal === true,
    fadeVocalTailMs: typeof playback.fadeVocalTailMs === 'number' ? playback.fadeVocalTailMs : 600,
    eqEnabled: playback.eqEnabled,
    eqGains: playback.eqGains,
  };
}

let fx = readPlaybackFx();
/** 渐变倍率：1=正常音量；淡出/淡入过程中在 0..1 之间。 */
let fadeScale = 1;
let fadeRaf = 0;
let fadeToken = 0;
/** 暂停结束时保留的人声保留量（0=无，1=最大）；恢复播放时从这里平滑回到 0。 */
let vocalHold = 0;

function applyEq(): void {
  setEqualizer(fx.eqEnabled, fx.eqGains);
}

applyEq();

window.addEventListener('zilux:playback-fx', () => {
  fx = readPlaybackFx();
  applyEq();
  // 音效开关可能建立 Web Audio 图：无缝衔接支持图内增益淡化，所以重新准备一次
  // （图内模式会自行把两个 deck 接进 deckMix），而不是像早期那样一律作废计划。
  if (state.playing) prepareSeamlessNext();
  applyPlaybackVolume();
});

function cancelFade(): void {
  fadeToken += 1;
  if (fadeRaf) {
    cancelAnimationFrame(fadeRaf);
    fadeRaf = 0;
  }
}

/** 渐变曲线：smooth 两端缓、linear 匀速、exponential 越到后面下降越快。 */
function easeFade(progress: number, curve: string): number {
  if (curve === 'linear') return progress;
  if (curve === 'exponential') return progress * progress;
  return progress * progress * (3 - 2 * progress);
}

/**
 * 平滑改变渐变倍率；token 变化（切歌/停止/重新开始渐变）时立即中止。
 * onProgress 收到原始进度 0..1，供人声保留淡出同步压低伴奏。
 */
function fadeTo(
  target: number,
  ms: number,
  token: number,
  curve: string,
  onProgress?: (progress: number) => void,
): Promise<void> {
  const total = Math.max(1, ms);
  const from = fadeScale;
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const step = (): void => {
      if (token !== fadeToken) {
        resolve();
        return;
      }
      const progress = Math.min(1, (performance.now() - startedAt) / total);
      const eased = easeFade(progress, curve);
      fadeScale = from + (target - from) * eased;
      onProgress?.(progress);
      applyPlaybackVolume();
      if (progress >= 1) {
        fadeRaf = 0;
        fadeScale = target;
        applyPlaybackVolume();
        resolve();
        return;
      }
      fadeRaf = requestAnimationFrame(step);
    };
    fadeRaf = requestAnimationFrame(step);
  });
}

/** 副歌试听时临时压低主播放器音量，试听结束恢复；不影响用户音量设置。 */
let previewDuck = 1;

export function setPreviewDuck(value: number, rampMs = 0): void {
  const next = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  if (next === previewDuck) return;
  previewDuck = next;
  applyPlaybackVolume(true, rampMs);
}

function applyPlaybackVolume(immediate = false, duckRampMs = 0): void {
  // 交叉淡化进行中：两 deck 音量由引擎按等功率曲线直接控制，这里只同步基础音量。
  if (crossfadeIsFading()) {
    crossfadeApplyVolume(state.volume * previewDuck);
    return;
  }
  // 均衡器 / 人声保留淡出都需要 Web Audio 图；开启时保证图已建立，音量随之交给本地 gain。
  if ((fx.eqEnabled || fx.fadeVocal) && !audioTapGraphActive()) ensureEqualizerGraph();
  const baseVolume = state.volume * fadeScale;
  if (audioTapGraphActive() && !activeDeckOutsideGraph) {
    // 主 gain 用「不含试听 duck」的音量，试听压低调到当前 deck 自己的增益上：
    // 悬停试听元素也接在同一张图里，若压主 gain 会把试听一起压小。
    audio.volume = 1;
    setAudioTapVolume(baseVolume, immediate);
    setDeckGraphGain(audio, previewDuck, duckRampMs);
  } else {
    audio.volume = baseVolume * previewDuck;
  }
}

/** 应用当前曲目的响度补偿（有分析结果才补偿；未分析时回退 0dB）。 */
async function applyLoudnessFor(track: OnlineTrack): Promise<void> {
  if (!loudnessEnabled()) {
    setLoudnessGainDb(0);
    if (audioTapGraphActive() && !crossfadeIsFading()) setDeckTrimGain(audio, 0);
    return;
  }
  if (!ensureEqualizerGraph()) return;
  setNightCompressor(nightModeEnabled());
  const result = await analysisFor(track).catch(() => null);
  const db = compensationDbFor(result?.analysis?.loudnessLufs) ?? 0;
  // 响度补偿写在当前 deck 自己的 trim 节点上，全局增益保持 0 dB：
  // 过渡期间两首歌各带各的补偿，切换曲目时不会因为「全局增益换值 + 过渡 trim 消失」出现音量台阶。
  setLoudnessGainDb(0);
  // 过渡进行中 player 的 audio 还指着正在淡出的 A；此时写补偿会把 B 的目标套到 A 上。
  // 两个 deck 的 trim 在 prepareCrossfade 里已按各自 LUFS 设好，这里直接跳过。
  if (crossfadeIsFading()) return;
  setDeckTrimGain(audio, db);
  applyPlaybackVolume(true);
}

export function refreshLoudness(track: OnlineTrack | null | undefined): void {
  if (track) void applyLoudnessFor(track);
}

let state: PlayerState = {
  track: null,
  queue: [],
  index: -1,
  playing: false,
  loading: false,
  positionMs: 0,
  durationMs: 0,
  volume: getSettings().playback.volume,
  rate: userRate,
  liked: false,
  mode: readMode(),
  streamQuality: '',
};

attachAudioTap(audio);
setAudioTapVolume(state.volume);
// 恢复用户上次的播放倍速（默认 1.0，行为与旧版一致）。
applyDeckRate(deckA);
applyDeckRate(deckB);

/** CUE 分轨：整轨开始秒数 */
let startAt = 0;
/** CUE 分轨时长（秒），0 = 播到文件尾 */
let cueSeconds = 0;

/**
 * 「过渡一开始就显示下一首」的预览状态。
 * 淡化开始瞬间把界面（播放条 / 迷你播放器 / 平面世界 NOW / 歌词页 / 系统媒体卡片）切到 B，
 * 但 deck 交换仍等淡化结束（commitSeamless）；过渡被取消时按这里记录的 A 回退显示。
 */
interface SeamlessPreview {
  /** 正在淡入的 deck（B） */
  deck: HTMLAudioElement;
  track: OnlineTrack;
  index: number;
  /** 正在淡出的那一轨（A）与它的下标，取消时用来回退 */
  fromTrack: OnlineTrack | null;
  fromIndex: number;
  /** B 这一段的 CUE 起始秒数 */
  startAt: number;
  /** B 的曲内总时长（毫秒） */
  durationMs: number;
}

let preview: SeamlessPreview | null = null;

/** 当前真正发声的那一轨：过渡中仍是淡出的 A（此时 state.track 已经指向 B）。 */
function outgoingTrack(): OnlineTrack | null {
  return preview ? preview.fromTrack : state.track;
}

let reportTimer = 0;
let lastReportAt = 0;
let rafId = 0;

function snapshot(): PlayerState {
  return { ...state, queue: state.queue.slice() };
}

function emit(): void {
  const snap = snapshot();
  listeners.forEach((fn) => {
    try {
      fn(snap);
    } catch (err) {
      console.warn('[player] listener failed', err);
    }
  });
}

function setState(patch: Partial<PlayerState>): void {
  state = { ...state, ...patch };
  emit();
  if (state.track) schedulePersist();
}

/** 上次退出时的播放状态：启动时恢复播放条（不自动播放）。 */
const LAST_KEY = 'zilux2.lastPlay';
const LAST_QUEUE_LIMIT = 200;
let persistTimer = 0;

interface SavedPlayback {
  track: OnlineTrack;
  queue: OnlineTrack[];
  index: number;
  positionMs: number;
  mode?: PlayMode;
}

function persistNow(): void {
  const track = state.track;
  if (!track) return;
  try {
    const queue = state.queue.length > 0 ? state.queue.slice(0, LAST_QUEUE_LIMIT) : [track];
    const saved: SavedPlayback = {
      track,
      queue,
      index: Math.max(0, state.index),
      positionMs: Math.round(state.positionMs),
      mode: state.mode,
    };
    localStorage.setItem(LAST_KEY, JSON.stringify(saved));
  } catch {
    /* 忽略 */
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = 0;
    persistNow();
  }, 1200);
}

/** 启动时恢复上次播放的歌曲 / 队列 / 进度（保持暂停，等用户按播放）。 */
export function restoreLastPlayback(): boolean {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw) as Partial<SavedPlayback> | null;
    const track = saved?.track;
    if (!track || !track.id) return false;
    const queue = Array.isArray(saved?.queue) && saved.queue.length > 0 ? saved.queue : [track];
    const index = Math.max(0, Math.min(saved?.index ?? 0, queue.length - 1));
    const resumeMs = Math.max(0, saved?.positionMs ?? 0);
    applyCue(track);
    state = {
      ...state,
      track,
      queue,
      index,
      playing: false,
      loading: false,
      positionMs: resumeMs,
      durationMs: track.durationMs ?? 0,
      liked: false,
      mode: saved?.mode ?? state.mode,
    };
    audio.preload = 'metadata';
    // 注意：这里不能马上 audio.src = streamUrl(track)。
    // 宿主每次启动端口都变，这会儿在线端点往往还没推过来，拼出来的地址是坏的，
    // 之后点播放会一直失败。留到首次播放时再解析（见 ensureSource）。
    pendingResumeMs = resumeMs;
    setState({ durationMs: state.durationMs });
    emit();
    refreshLiked(track);
    return true;
  } catch (err) {
    console.warn('[player] restore failed', err);
    return false;
  }
}

/** 订阅播放状态（立即回调一次）。 */
export function onPlayer(listener: Listener): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => listeners.delete(listener);
}

export function playerState(): PlayerState {
  return snapshot();
}

/* ------------------------------------------------------------------ */
/* 进度                                                                */
/* ------------------------------------------------------------------ */

/** 当前曲内位置（毫秒） */
function positionMs(): number {
  const raw = Number.isFinite(audio.currentTime) ? audio.currentTime : startAt;
  const rel = Math.max(0, raw - startAt);
  if (cueSeconds > 0) return Math.min(rel * 1000, cueSeconds * 1000);
  return rel * 1000;
}

/** 当前曲总时长（毫秒） */
function durationMs(): number {
  if (cueSeconds > 0) return cueSeconds * 1000;
  const raw = Number.isFinite(audio.duration) ? audio.duration : 0;
  const rel = Math.max(0, raw - startAt);
  if (rel > 0) return rel * 1000;
  const fallback = state.track?.durationMs ?? 0;
  return fallback;
}

function tick(): void {
  rafId = 0;
  if (!state.track) return;
  // 兜底：引擎若在淡化中途自行取消（例如计划过期），界面不能停在已经切过去的 B 上。
  if (preview && !crossfadeIsFading()) restorePreview('engine-stopped');
  // 引擎永远看「正在淡出的 A」的进度；界面在过渡中看正在淡入的 B（preview）。
  const deckPos = positionMs();
  const deckDur = durationMs();
  const nextPos = preview ? previewPositionMs() : deckPos;
  const nextDur = preview ? preview.durationMs : deckDur;
  enforceBarLoop(deckPos);
  if (
    Math.abs(nextPos - state.positionMs) > 40 ||
    Math.abs(nextDur - state.durationMs) > 200 ||
    state.playing !== !audio.paused ||
    Math.abs(audio.playbackRate - state.rate) > 0.001
  ) {
    setState({ positionMs: nextPos, durationMs: nextDur, playing: !audio.paused, rate: audio.playbackRate });
  }
  // 到点就起播 B 并开始等功率交叉淡化（内部有开关/图表/过期守卫）。
  crossfadeTick(deckPos, deckDur);
  scheduleTick();
  maybeReport();
}

function scheduleTick(): void {
  if (rafId) return;
  rafId = window.requestAnimationFrame(tick);
}

function maybeReport(): void {
  const now = performance.now();
  if (now - lastReportAt < 1000) return;
  lastReportAt = now;
  const track = state.track;
  if (!track) return;
  window.clearTimeout(reportTimer);
  reportTimer = window.setTimeout(() => {
    const current = state.track;
    if (!current) return;
    reportMedia({
      title: current.title,
      artist: current.artist,
      album: current.album || undefined,
      coverUrl: current.cover || undefined,
      durationMs: state.durationMs,
      positionMs: state.positionMs,
      playing: state.playing,
    });
  }, 20);
}

/* ------------------------------------------------------------------ */
/* 喜欢                                                                */
/* ------------------------------------------------------------------ */

let likeToken = 0;

function refreshLiked(track: OnlineTrack | null): void {
  likeToken += 1;
  const token = likeToken;
  if (!track || track.source === 'local') {
    setState({ liked: false });
    return;
  }
  setState({ liked: false });
  void checkLiked(track.source, track.id)
    .then((liked) => {
      if (token !== likeToken) return;
      if (state.track?.id === track.id) setState({ liked });
    })
    .catch(() => {
      /* 未登录/失败：静默 */
    });
}

/** 重新查一次当前曲目的收藏状态（在线层就绪后调用，修复重启后红心显示为空）。 */
export function refreshCurrentLiked(): void {
  refreshLiked(state.track);
}

/** 收藏 / 取消收藏的结果：'liked' 已收藏、'unliked' 已取消、'error' 失败。 */
export type LikeResult = 'liked' | 'unliked' | 'error';

/** 切换「我喜欢的音乐」（收藏 / 取消收藏）。 */
export async function toggleLiked(): Promise<LikeResult> {
  const track = state.track;
  if (!track || track.source === 'local') return 'error';
  try {
    if (state.liked) {
      await removeLikedTrack(track.source, track.id);
      setState({ liked: false });
      return 'unliked';
    }
    await addLikedTrack(track.source, track.id);
    setState({ liked: true });
    return 'liked';
  } catch (err) {
    console.warn('[player] like failed', err);
    return 'error';
  }
}

/* ------------------------------------------------------------------ */
/* 播放控制                                                            */
/* ------------------------------------------------------------------ */

function applyCue(track: OnlineTrack | null): void {
  const seconds = Number(track?.startAt ?? 0);
  startAt = seconds > 0 ? seconds : 0;
  cueSeconds = track && track.durationMs > 0 && startAt > 0 ? track.durationMs / 1000 : 0;
}

function onEnded(element: HTMLAudioElement): void {
  // 只有活跃 deck 的 ended 有意义：B 在淡化中被忽略（预加载失败等场景也不切歌）。
  if (element !== audio) return;
  // 过渡进行中 A 先放完：直接收尾到 B，不要再 load 一次（自动/手动/单曲循环过渡同理）。
  if (crossfadeFinishNow('ended')) return;
  // 自然播完：用准备阶段就选好的下一首（shuffle 的随机结果在切换时不再重算）。
  const planned = takePlannedNextIndex();
  cancelSeamless('ended');
  if (state.mode === 'single') {
    seek(0);
    void audio.play().catch(() => undefined);
    return;
  }
  advance(planned);
}

function onError(element: HTMLAudioElement): void {
  // 预加载的 B 报错：放弃这次无缝衔接，不影响正在播放的 A。
  if (element !== audio) {
    cancelSeamless('standby-error');
    return;
  }
  cancelSeamless('error');
  const track = state.track;
  if (!track) return;
  setState({ playing: false, loading: false });
  const port = onlineInfo()?.port ?? 0;
  if (track.source !== 'local' && srcPort !== 0 && port !== 0 && srcPort !== port) {
    // 宿主换了端口：地址过期而已，下一次点击会重新解析，不要当成坏歌跳过
    srcPort = 0;
    audio.removeAttribute('src');
    return;
  }
  console.warn('[player] audio error', track.title, audio.error?.code, audio.error?.message);
  // 自动跳过失败曲目（最多连续跳 3 首，避免整队列空转）
  const guard = (window as unknown as { __ziluxSkip?: number }).__ziluxSkip ?? 0;
  if (guard >= 3) {
    (window as unknown as { __ziluxSkip?: number }).__ziluxSkip = 0;
    return;
  }
  (window as unknown as { __ziluxSkip?: number }).__ziluxSkip = guard + 1;
  window.setTimeout(() => {
    if (state.track?.id === track.id) next();
  }, 240);
}

/** 载入并播放队列中某一首。skipFadeIn=true 时直接全音量起播（用于悬停试听的无缝交接）。 */
function load(index: number, autoplay = true, startMs = 0, skipFadeIn = false): void {
  const track = state.queue[index] ?? null;
  if (!track) {
    stop();
    return;
  }
  // 悬停试听交接：从曲内指定位置开始（普通切歌是 0）。
  const startOffsetSec = Math.max(0, startMs) / 1000;
  const startPositionMs = startOffsetSec > 0 ? Math.round(startOffsetSec * 1000) : 0;
  // 任何显式切歌都放弃上一首的无缝衔接计划（B 的预加载一并清掉）。
  cancelSeamless('load');
  resetBarLoop();
  // 过渡期的 WSOLA 变速不跨曲残留：新的一首从用户倍速开始（默认 1 = 原速）。
  applyDeckRate(audio);
  applyDeckRate(standby);
  applyCue(track);
  setState({
    track,
    index,
    positionMs: startPositionMs,
    durationMs: cueSeconds > 0 ? cueSeconds * 1000 : track.durationMs,
    loading: true,
  });
  refreshLiked(track);
  setState({ streamQuality: '' });
  if (track.source !== 'local') {
    void fetchStreamInfo(track.source, track.id, qualityForSource(track.source))
      .then((info) => {
        if (state.track?.id !== track.id) return;
        const parts = [info.quality, info.format ? info.format.toUpperCase() : ''];
        if (info.bitrate >= 1000) parts.push(`${Math.round(info.bitrate / 1000)}k`);
        setState({ streamQuality: parts.filter(Boolean).join(' · ') });
      })
      .catch(() => {
        if (state.track?.id === track.id) setState({ streamQuality: '' });
      });
  }

  let url = '';
  try {
    url = streamUrl(track);
  } catch (err) {
    console.warn('[player] streamUrl failed', err);
    setState({ loading: false });
    return;
  }
  audio.src = url;
  attachAudioTap(audio);
  // 图未建立时不存在「活跃 deck 在图外」的问题；图建立后绑定的是此时挂上的元素。
  if (!audioTapGraphActive()) activeDeckOutsideGraph = false;
  srcPort = onlineInfo()?.port ?? 0;
  pendingResumeMs = 0;
  applyPlaybackVolume();
  if (autoplay) {
    cancelFade();
    const token = fadeToken;
    const fade = fx.fadeEnabled && !skipFadeIn ? Math.max(0, fx.fadeInMs) : 0;
    fadeScale = fade > 0 ? 0 : 1;
    vocalHold = 0;
    setVocalFade(0);
    applyPlaybackVolume(true);
    void audio
      .play()
      .then(() => {
        if (startAt > 0 || startOffsetSec > 0) {
          try {
            audio.currentTime = startAt + startOffsetSec;
          } catch {
            /* 媒体尚未就绪时交给后续 tick 的进度显示 */
          }
        }
        if (token !== fadeToken) return;
        setState({ playing: true, loading: false });
        scheduleTick();
        void recordRecent(track);
        if (fade > 0) void fadeTo(1, fade, token, fx.fadeCurve);
        // 播放已启动：异步预分析 + 预加载下一首，准备鼓点对齐的无缝衔接。
        prepareSeamlessNext();
      })
      .catch((err: unknown) => {
        console.warn('[player] play failed', err);
        fadeScale = 1;
        applyPlaybackVolume();
        setState({ playing: false, loading: false });
      });
  } else {
    setState({ playing: false, loading: false });
    // 暂停态也先预分析/预加载，用户按播放后可直接衔接。
    prepareSeamlessNext();
  }
  // 这一首是队列末尾时，提前拉下一批续上（私人漫游），避免无缝计划绕回第一首。
  maybeRefillQueue();
}

/* ------------------------------------------------------------------ */
/* 队列续接（私人漫游等无限流）                                         */
/* ------------------------------------------------------------------ */

/** 队列播到最后一首时拉下一批的续接器；返回空数组表示这次没拉到。 */
export type QueueRefill = () => Promise<OnlineTrack[]>;

let queueRefill: QueueRefill | null = null;
let refillInFlight = false;

function queueKeyOf(track: OnlineTrack): string {
  return `${track.source}:${track.id}`;
}

/**
 * 注册队列续接器（传 null 清除）。只在「列表模式 + 当前曲目是队列最后一首」时触发；
 * 任何显式 playQueue / replaceQueue 都会自动清除，避免普通歌单被无限续接。
 */
export function setQueueRefill(provider: QueueRefill | null): void {
  queueRefill = provider;
  refillInFlight = false;
  if (!provider) return;
  maybeRefillQueue();
  prepareSeamlessNext();
}

/** 当前曲目已经是队列最后一首时，异步拉下一批、去重后追加进队列并重排无缝衔接。 */
function maybeRefillQueue(): void {
  const provider = queueRefill;
  if (!provider || refillInFlight) return;
  if (state.mode !== 'list') return;
  if (state.queue.length === 0) return;
  if (state.index < state.queue.length - 1) return;
  const anchorIndex = state.index;
  const anchorKey = state.track ? queueKeyOf(state.track) : '';
  refillInFlight = true;
  void (async () => {
    let extra: OnlineTrack[] = [];
    try {
      const batch = await provider();
      const seen = new Set(state.queue.map(queueKeyOf));
      extra = batch.filter((track) => !seen.has(queueKeyOf(track)));
    } catch (err) {
      console.warn('[player] queue refill failed', err);
    } finally {
      refillInFlight = false;
    }
    // 拉取期间用户换过队列/曲目/清过续接器：这批结果直接丢弃。
    if (queueRefill !== provider) return;
    if (state.index !== anchorIndex) return;
    if ((state.track ? queueKeyOf(state.track) : '') !== anchorKey) return;
    if (extra.length === 0) return;
    state = { ...state, queue: [...state.queue, ...extra] };
    setState({ queue: state.queue });
    console.debug(`[player] queue refilled +${extra.length}（共 ${state.queue.length} 首）`);
    // 追加前排好的「下一首」是绕回第一首的旧计划，作废后按新队列重排。
    plannedNextIndex = null;
    plannedFor = '';
    prepareSeamlessNext();
  })();
}

/**
 * 把外部「正在播放」的元素接管为当前 deck（悬停试听点击接续用）：
 * 不重新加载、不 seek、不打断声音——元素继续放，播放器只接管状态与后续链路。
 */
export function adoptPlayingElement(
  element: HTMLAudioElement,
  track: OnlineTrack,
  queue: OnlineTrack[],
  index: number,
): boolean {
  if (element === audio || element.paused) return false;
  cancelSeamless('adopt');
  cancelFade();
  const previous = audio;
  // 顺序很重要：先停旧 deck，再恢复主音量，最后接管元素。
  // 反过来会让旧歌在 duck 恢复的那一瞬间突然变响，听起来就是「顿一下」。
  try {
    previous.pause();
  } catch {
    /* 忽略 */
  }
  setPreviewDuck(1);
  if (standby === element) standby = previous;
  audio = element;
  wireDeck(audio);
  attachAudioTap(audio);
  startAt = 0;
  cueSeconds = 0;
  fadeScale = 1;
  applyDeckRate(audio);
  const positionMs = Math.max(0, element.currentTime * 1000);
  const durationMs =
    Number.isFinite(element.duration) && element.duration > 0 ? element.duration * 1000 : (track.durationMs ?? 0);
  setState({
    track,
    queue: queue.slice(),
    index,
    playing: !element.paused,
    loading: false,
    positionMs,
    durationMs,
  });
  applyPlaybackVolume(true);
  void applyLoudnessFor(track);
  recordRecent(track);
  maybeReport();
  scheduleTick();
  prepareSeamlessNext();
  return true;
}

type QueueSwitchHandler = () => void;
const queueSwitchHandlers = new Set<QueueSwitchHandler>();

/** 订阅「换了一整套队列 / 手动点歌」：临时模式（如律动接歌图标）据此恢复原设定。 */
export function subscribeQueueSwitch(handler: QueueSwitchHandler): () => void {
  queueSwitchHandlers.add(handler);
  return () => {
    queueSwitchHandlers.delete(handler);
  };
}

function notifyQueueSwitch(): void {
  for (const handler of Array.from(queueSwitchHandlers)) {
    try {
      handler();
    } catch {
      /* 单个订阅者出错不影响播放 */
    }
  }
}

export function playQueue(tracks: OnlineTrack[], index = 0, autoplay = true, startMs = 0, skipFadeIn = false): void {
  if (tracks.length === 0) return;
  notifyQueueSwitch();
  const safeIndex = Math.max(0, Math.min(index, tracks.length - 1));
  (window as unknown as { __ziluxSkip?: number }).__ziluxSkip = 0;
  // 显式换队列：上一份续接器（私人漫游等）作废，普通歌单/搜索结果不会被无限续接。
  queueRefill = null;
  refillInFlight = false;
  state = { ...state, queue: tracks.slice() };
  load(safeIndex, autoplay, startMs, skipFadeIn);
}

/**
 * 用更完整的列表替换队列（保持当前曲目与播放进度，不重载音频）。
 * 首页卡片一开始只有预览用的少量曲目，进入播放后会异步补全整张列表，
 * 否则列表循环时会「播几首就绕回第一首」。
 */
export function replaceQueue(tracks: OnlineTrack[]): void {
  if (tracks.length === 0) return;
  // 换了一套完整列表：续接器作废（首页卡片补全列表属于同一队列，不能续接）。
  queueRefill = null;
  refillInFlight = false;
  const track = state.track;
  if (!track) {
    playQueue(tracks, 0);
    return;
  }
  const index = tracks.findIndex((item) => item.source === track.source && item.id === track.id);
  if (index < 0) return;
  // 队列内容变了，下一首也可能变：先放弃旧计划再按新队列重新准备。
  cancelSeamless('queue');
  state = { ...state, queue: tracks.slice(), index };
  setState({ queue: state.queue, index });
  prepareSeamlessNext();
}

/**
 * AutoMix 用：只替换「当前曲之后的队列」，已播部分与当前下标保持不变。
 * 会作废旧的无缝计划，按新顺序重新准备下一首。
 */
export function reorderUpcoming(upcoming: OnlineTrack[]): void {
  if (state.queue.length === 0) return;
  const head = state.queue.slice(0, Math.max(0, state.index + 1));
  const queue = [...head, ...upcoming];
  plannedNextIndex = null;
  plannedFor = '';
  cancelSeamless('queue');
  state = { ...state, queue };
  setState({ queue: state.queue });
  prepareSeamlessNext();
}

/** 播放单曲（队列只有它）。 */
export function playTrack(track: OnlineTrack): void {
  playQueue([track], 0, true);
}

/**
 * 跳过待播队列里的某首歌（从队列移除）。当前正在播放的曲目不会被移除；
 * 队列变化后重新准备无缝衔接的下一首。
 */
export function removeQueueItem(index: number): void {
  const target = Math.trunc(index);
  if (!Number.isFinite(target)) return;
  if (target < 0 || target >= state.queue.length) return;
  if (target === state.index) return;
  const queue = state.queue.slice();
  queue.splice(target, 1);
  const nextIndex = target < state.index ? state.index - 1 : state.index;
  cancelSeamless('queue');
  state = { ...state, queue, index: nextIndex };
  setState({ queue, index: nextIndex });
  prepareSeamlessNext();
}

/** 调整队列里某首歌的位置（上移/下移/优先播放），当前播放曲目的队列下标会同步修正。 */
export function moveQueueItem(from: number, to: number): void {
  if (from === to) return;
  if (from < 0 || from >= state.queue.length || to < 0 || to >= state.queue.length) return;
  const queue = state.queue.slice();
  const [item] = queue.splice(from, 1);
  if (!item) return;
  queue.splice(to, 0, item);
  let index = state.index;
  if (from === index) index = to;
  else if (from < index && to >= index) index -= 1;
  else if (from > index && to <= index) index += 1;
  cancelSeamless('queue');
  state = { ...state, queue, index };
  setState({ queue, index });
  prepareSeamlessNext();
}

/** 把一首歌插到「下一首」位置（已存在于队列时先移走再插回）。当前正在播的这首不处理。 */
export function queueNext(track: OnlineTrack): void {
  const key = queueKeyOf(track);
  const existing = state.queue.findIndex((item) => queueKeyOf(item) === key);
  if (existing === state.index) return;
  const queue = state.queue.slice();
  let index = state.index;
  if (existing >= 0) {
    queue.splice(existing, 1);
    if (existing < index) index -= 1;
  }
  if (queue.length === 0) {
    playQueue([track], 0, true);
    return;
  }
  queue.splice(Math.min(queue.length, index + 1), 0, track);
  cancelSeamless('queue');
  state = { ...state, queue, index };
  setState({ queue, index });
  prepareSeamlessNext();
}

/** 追加到播放队列末尾；已在队列中则忽略并返回 false。 */
export function queueAppend(track: OnlineTrack): boolean {
  const key = queueKeyOf(track);
  if (state.queue.some((item) => queueKeyOf(item) === key)) return false;
  state = { ...state, queue: [...state.queue, track] };
  setState({ queue: state.queue });
  // 队列尾部变了：作废按旧长度准备的「下一首」计划。
  plannedNextIndex = null;
  plannedFor = '';
  prepareSeamlessNext();
  return true;
}

export function playAt(index: number, tracks?: OnlineTrack[]): void {
  if (tracks) {
    playQueue(tracks, index, true);
    return;
  }
  if (state.queue.length === 0) return;
  const safe = Math.max(0, Math.min(index, state.queue.length - 1));
  // 手动点歌属于「用户换了选择」：通知临时模式恢复。
  notifyQueueSwitch();
  // 点列表换曲：播放中走 1.2–2.0 秒短过渡，暂停中/无法过渡时回退硬切。
  manualSwitch(safe);
}

/** 懒加载音频地址：恢复出来的歌第一次播放时才拼 URL，并顺带校验宿主端口是否变了。 */
function ensureSource(): boolean {
  const track = state.track;
  if (!track) return false;
  const port = onlineInfo()?.port ?? 0;
  const same = audio.src.length > 0 && (track.source === 'local' || srcPort === port);
  if (same) return true;
  let url = '';
  try {
    url = streamUrl(track);
  } catch (err) {
    console.warn('[player] streamUrl failed', err);
    return false;
  }
  const keep = audio.currentTime > 0 && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  audio.src = url;
  attachAudioTap(audio);
  srcPort = port;
  applyPlaybackVolume();
  const resume = pendingResumeMs > 0 ? pendingResumeMs : keep * 1000;
  pendingResumeMs = 0;
  if (resume > 0) {
    const apply = (): void => {
      audio.removeEventListener('loadedmetadata', apply);
      try {
        audio.currentTime = startAt + resume / 1000;
      } catch {
        /* 忽略 */
      }
    };
    if (audio.readyState >= 1) apply();
    else audio.addEventListener('loadedmetadata', apply);
  }

  return true;
}

export function toggle(): void {
  if (!state.track) {
    if (state.queue.length > 0) playAt(0);
    return;
  }
  if (audio.paused) {
    if (!ensureSource()) {
      setState({ playing: false });
      return;
    }
    void startPlayback();
  } else {
    pausePlayback();
  }
}

/** 开始播放：渐变开启时先把音量压到 0，再按设置曲线淡入；人声保留则同步从暂停状态恢复。 */
function startPlayback(): Promise<void> {
  cancelFade();
  // 恢复播放时重建无缝衔接计划（分析结果命中缓存，代价很小）。
  cancelSeamless('resume');
  const token = fadeToken;
  const fade = fx.fadeEnabled ? Math.max(0, fx.fadeInMs) : 0;
  fadeScale = fade > 0 ? 0 : 1;
  const hold = vocalHold;
  if (fade > 0) {
    // 延续上次暂停的伴奏衰减状态：保持压低，淡入过程中再抬回正常。
    if (hold > 0) {
      ensureEqualizerGraph();
      setVocalFade(hold);
    }
  } else {
    setVocalFade(0);
    vocalHold = 0;
  }
  applyPlaybackVolume(true);
  return audio
    .play()
    .then(() => {
      if (token !== fadeToken) return;
      setState({ playing: true });
      scheduleTick();
      prepareSeamlessNext();
      if (fade > 0) {
        void fadeTo(1, fade, token, fx.fadeCurve, (progress) => {
          if (hold > 0) setVocalFade(hold * (1 - easeFade(progress, fx.fadeCurve)));
        }).then(() => {
          if (token !== fadeToken) return;
          setVocalFade(0);
          vocalHold = 0;
        });
      }
    })
    .catch(() => {
      fadeScale = 1;
      applyPlaybackVolume();
      setState({ playing: false });
    });
}

/**
 * 暂停：渐变开启时先淡出再真正暂停。
 * 人声保留开启时，伴奏（低频/高频）在暂停淡出阶段先压下去，音量再拖尾 fadeVocalTailMs，
 * 听感上人声会比伴奏多留一会儿；暂停结束后保留该衰减状态，恢复播放时再平滑接回去。
 */
function pausePlayback(): void {
  cancelFade();
  // 暂停即放弃下一首的无缝衔接计划（B 的预加载一起清掉）。
  cancelSeamless('pause');
  const token = fadeToken;
  const fadeOut = fx.fadeEnabled ? Math.max(0, fx.fadeOutMs) : 0;
  const vocalTail = fx.fadeEnabled && fx.fadeVocal ? Math.max(0, fx.fadeVocalTailMs) : 0;
  const total = fadeOut + vocalTail;
  if (vocalTail > 0) ensureEqualizerGraph();
  const finish = (): void => {
    if (token !== fadeToken) return;
    audio.pause();
    vocalHold = vocalTail > 0 ? 1 : 0;
    if (vocalHold === 0) setVocalFade(0);
    setState({ playing: false });
    // 保持 0 音量直到下次恢复播放，避免恢复瞬间 gain 从正常值回落的「首帧爆音」。
    fadeScale = fx.fadeEnabled ? 0 : 1;
    applyPlaybackVolume(true);
  };
  if (total > 0) {
    void fadeTo(0, total, token, fx.fadeCurve, (progress) => {
      if (vocalTail <= 0) return;
      const vocalProgress = fadeOut > 0 ? Math.min(1, (progress * total) / fadeOut) : 1;
      setVocalFade(vocalProgress);
    }).then(finish);
  } else {
    finish();
  }
}

/** 取「预选的下一首」下标：准备无缝衔接时已定好（shuffle 随机在那一刻选定），切歌时不再重算。 */
function takePlannedNextIndex(): number | null {
  const planned = plannedNextIndex;
  plannedNextIndex = null;
  plannedFor = '';
  if (planned === null || planned < 0 || planned >= state.queue.length) return null;
  if (planned === state.index) return null;
  return planned;
}

/** 随机挑一首「不是当前曲」的下标；队列只有一首时返回当前下标。 */
function randomOtherIndex(): number {
  const queue = state.queue;
  if (queue.length < 2) return state.index;
  let index = state.index;
  while (index === state.index) index = Math.floor(Math.random() * queue.length);
  return index;
}

/** 硬切（非过渡）时的下一首：shuffle = 随机，其余模式顺延。 */
function resolvePlainNextIndex(): number {
  const queue = state.queue;
  if (queue.length === 0) return state.index;
  if (state.mode === 'shuffle') return randomOtherIndex();
  const index = state.index + 1;
  return index >= queue.length ? 0 : index;
}

/** 播放中手动切歌的连续点击防抖窗口（同一目标 450ms 内只处理一次）。 */
let manualGuard = { key: '', at: 0 };
const MANUAL_SWITCH_DEBOUNCE_MS = 450;

/**
 * 手动切歌：播放中且无缝衔接开启时，用双 deck 做 1.2–2.0 秒等功率短过渡
 * （B 从这首开头起播，不等节拍分析、不做 BPM 对齐）；否则回退原来的硬切 load。
 * 连续快速点击时：旧计划的 token 立即失效，只保留最后一次切换。
 */
function manualSwitch(index: number): void {
  if (index < 0 || index >= state.queue.length) return;
  const target = state.queue[index];
  if (!target) return;
  const now = performance.now();
  const guardKey = `${target.source}:${target.id}:${index}`;
  if (guardKey === manualGuard.key && now - manualGuard.at < MANUAL_SWITCH_DEBOUNCE_MS) return;
  manualGuard = { key: guardKey, at: now };

  if (!state.track || !state.playing || audio.paused) {
    load(index, true);
    return;
  }
  if (!readCrossfadeSettings().enabled) {
    load(index, true);
    return;
  }
  let nextUrl = '';
  try {
    nextUrl = streamUrl(target);
  } catch (err) {
    console.warn('[player] manual switch streamUrl failed', err);
    load(index, true);
    return;
  }
  const fromTrack = state.track;
  const fromDeck = audio;
  const nextDeck = standby;
  // 旧计划/预取先作废（之后所有异步回调看到 token 变化就放弃）。
  cancelSeamless('manual');
  const token = seamlessToken;
  srcPort = onlineInfo()?.port ?? 0;
  const started = startManualCrossfade({
    active: fromDeck,
    standby: nextDeck,
    fromTitle: fromTrack.title,
    nextTitle: target.title,
    nextStartFileMs: Math.max(0, Number(target.startAt ?? 0)) * 1000,
    currentPositionMs: positionMs(),
    fadeMs: MANUAL_FADE_DEFAULT_MS,
    nextUrl,
    baseVolume: () => state.volume,
    baseRate: () => userRate,
    isValid: () =>
      token === seamlessToken &&
      state.playing &&
      audio === fromDeck &&
      outgoingTrack() === fromTrack &&
      readCrossfadeSettings().enabled,
    onStart: () =>
      beginSeamlessPreview(nextDeck, target, index, fromTrack, state.index, Math.max(0, Number(target.startAt ?? 0))),
    onFinish: () => commitSeamless(fromDeck, nextDeck, target, index),
    onFail: (reason) => {
      if (token !== seamlessToken) return;
      console.debug('[player] manual crossfade failed，回退硬切', reason);
      if (state.queue[index] === target) load(index, true);
    },
  });
  if (!started) {
    if (token === seamlessToken) load(index, true);
    return;
  }
  transitionTarget = target;
  console.debug(`[player] manual crossfade → ${target.title}（${MANUAL_FADE_DEFAULT_MS} ms）`);
}

function advance(plannedIndex: number | null = null): void {
  if (state.queue.length === 0) return;
  const index = plannedIndex ?? resolvePlainNextIndex();
  load(index, true);
}

/** 下一首（单曲循环时也跳下一首）：播放中走交叉淡化。 */
export function next(): void {
  if (state.queue.length === 0) return;
  if (state.mode === 'single' && state.queue.length > 1) {
    manualSwitch((state.index + 1) % state.queue.length);
    return;
  }
  manualSwitch(takePlannedNextIndex() ?? resolvePlainNextIndex());
}

/** 切换播放模式（列表 → 单曲循环 → 随机 → 列表）。 */
export function cycleMode(): PlayMode {
  const order: PlayMode[] = ['list', 'single', 'shuffle'];
  const nextMode = order[(order.indexOf(state.mode) + 1) % order.length];
  try {
    localStorage.setItem(MODE_KEY, nextMode);
  } catch {
    /* 忽略 */
  }
  // 模式变了：旧计划与预分析目标都作废，再按新模式重建（list/shuffle 自然播完可衔接，
  // single 在曲尾做同曲淡出→淡入重启）。
  cancelSeamless('mode');
  setState({ mode: nextMode });
  prepareSeamlessNext();
  return nextMode;
}

/**
 * 上一首：直接切到播放队列的上一首。
 * 第五十八轮按反馈去掉了「播放超过 3 秒先回到本曲开头」的旧规则——原规则会让第一次点击
 * 只是重播当前歌曲、再点一次才真的切上一首，和用户预期不符（想重听本曲直接拖进度条即可）。
 */
export function prev(): void {
  if (state.queue.length === 0) return;
  if (state.mode === 'shuffle' && state.queue.length > 1) {
    manualSwitch(randomOtherIndex());
    return;
  }
  const index = state.index - 1;
  manualSwitch(index < 0 ? state.queue.length - 1 : index);
}

export function seek(ms: number): void {
  if (!state.track) return;
  // 过渡中拖进度条：界面与预告都已经指向 B，先把过渡立刻收尾（deck 交换到 B），
  // 再按用户点的新位置继续 —— 否则进度条会落到正在淡出的 A 上。
  if (preview && crossfadeIsFading()) crossfadeFinishNow('seek');
  // 拖动进度：旧的淡化窗口失效，先取消并清理 B，再按新位置重新准备。
  // keepPlan：保留已预选的下一首（shuffle 的随机结果不在 seek 时重抽）。
  cancelSeamless('seek', true);
  const duration = durationMs();
  const target = Math.max(0, Math.min(ms, duration > 0 ? duration : ms));
  try {
    audio.currentTime = startAt + target / 1000;
  } catch {
    /* 媒体尚未就绪 */
  }
  setState({ positionMs: target });
  prepareSeamlessNext();
}

export function setVolume(value: number): void {
  const volume = Math.max(0, Math.min(1, value));
  setState({ volume });
  applyPlaybackVolume();
}

export function stop(): void {
  cancelSeamless('stop');
  cancelFade();
  vocalHold = 0;
  setVocalFade(0);
  fadeScale = 1;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  setState({
    track: null,
    index: -1,
    playing: false,
    loading: false,
    positionMs: 0,
    durationMs: 0,
    liked: false,
  });
  likeToken += 1;
}

/* ------------------------------------------------------------------ */
/* 无缝衔接：准备 / 取消 / 交换 deck（player 侧状态迁移）              */
/* ------------------------------------------------------------------ */

/** 作废进行中的异步准备（分析回来的闭包看到 token != 当前值就放弃）。 */
let seamlessToken = 0;

/** 预选的下一首下标：进入准备阶段时定好（shuffle 的随机在这一刻选出），切换时不再重算。 */
let plannedNextIndex: number | null = null;
/** plannedNextIndex 属于哪首当前曲目（曲目换了就失效）。 */
let plannedFor = '';
/** 正在过渡（自动/手动/单曲循环）的目标曲目：预告条 UI 用它显示正确的「即将播放」。 */
let transitionTarget: OnlineTrack | null = null;

/** 分析结果缓存：同一首重复准备（seek / 暂停恢复 / 切模式）不再请求宿主分析器。 */
const analysisCache = new Map<string, Promise<AnalysisResult>>();
const ANALYSIS_CACHE_LIMIT = 8;

type PrefetchState = 'idle' | 'pending' | 'ready' | 'failed';
interface PrefetchRecord {
  key: string;
  title: string;
  state: PrefetchState;
}
let prefetch: PrefetchRecord = { key: '', title: '', state: 'idle' };
let prefetchToken = 0;

function trackKeyOf(track: OnlineTrack): string {
  return `${track.source}:${track.id}:${track.durationMs ?? 0}`;
}

/** 取分析结果：内存缓存命中直接复用；失败从缓存删掉以便重试。 */
function analysisFor(track: OnlineTrack): Promise<AnalysisResult> {
  const key = trackKeyOf(track);
  const cached = analysisCache.get(key);
  if (cached) return cached;
  const promise = analyzeTrack(track).catch((err: unknown) => {
    analysisCache.delete(key);
    throw err;
  });
  analysisCache.set(key, promise);
  if (analysisCache.size > ANALYSIS_CACHE_LIMIT) {
    const oldest = analysisCache.keys().next().value;
    if (typeof oldest === 'string') analysisCache.delete(oldest);
  }
  return promise;
}

/** 播放条标记用：取某首曲目的分析结果（命中缓存直接复用，未命中会请求宿主分析器）。 */
export function analysisForTrack(track: OnlineTrack): Promise<AnalysisResult> {
  return analysisFor(track);
}

/* ------------------------------------------------------------------ */
/* DJ 工具：热 cue 与小节循环                                          */
/* ------------------------------------------------------------------ */

const HOTCUES_KEY = 'zilux2.hotcues';
const HOTCUE_SLOTS = 4;

type HotCueMap = Record<string, number[]>;

function readHotCueMap(): HotCueMap {
  try {
    const raw = localStorage.getItem(HOTCUES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: HotCueMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const slots = value
        .slice(0, HOTCUE_SLOTS)
        .map((item) => (typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : -1));
      while (slots.length < HOTCUE_SLOTS) slots.push(-1);
      out[key] = slots;
    }
    return out;
  } catch {
    return {};
  }
}

let hotCueMap: HotCueMap = readHotCueMap();

function saveHotCues(): void {
  try {
    localStorage.setItem(HOTCUES_KEY, JSON.stringify(hotCueMap));
  } catch {
    /* 忽略：localStorage 不可用 */
  }
}

/** 当前曲目 4 个热 cue（-1 表示空）。 */
export function getHotCues(): number[] {
  const track = state.track;
  if (!track) return [-1, -1, -1, -1];
  const slots = hotCueMap[trackKeyOf(track)];
  return slots ? slots.slice() : [-1, -1, -1, -1];
}

/** 按热 cue：空位=在当前位置设置；已设置=跳过去。返回实际动作与位置。 */
export function toggleHotCue(slot: number): { action: 'set' | 'jump' | 'none'; ms: number } {
  const index = Math.max(0, Math.min(HOTCUE_SLOTS - 1, Math.floor(slot)));
  const track = state.track;
  if (!track) return { action: 'none', ms: 0 };
  const key = trackKeyOf(track);
  const slots = hotCueMap[key] ?? [-1, -1, -1, -1];
  const existing = slots[index] ?? -1;
  if (existing >= 0) {
    seek(existing);
    return { action: 'jump', ms: existing };
  }
  const ms = Math.round(state.positionMs);
  slots[index] = ms;
  hotCueMap[key] = slots;
  saveHotCues();
  setState({});
  return { action: 'set', ms };
}

/** 清除某个热 cue；返回是否确有清除。 */
export function clearHotCue(slot: number): boolean {
  const index = Math.max(0, Math.min(HOTCUE_SLOTS - 1, Math.floor(slot)));
  const track = state.track;
  if (!track) return false;
  const key = trackKeyOf(track);
  const slots = hotCueMap[key];
  if (!slots || (slots[index] ?? -1) < 0) return false;
  slots[index] = -1;
  hotCueMap[key] = slots;
  saveHotCues();
  setState({});
  return true;
}

let loopRange: { startMs: number; endMs: number } | null = null;

/** 当前小节循环区间（没开为 null）。 */
export function getBarLoop(): { startMs: number; endMs: number } | null {
  return loopRange ? { ...loopRange } : null;
}

function barLoopBounds(bars: number): { startMs: number; endMs: number } | null {
  const track = state.track;
  if (!track) return null;
  const analysis = cachedAnalysis(track)?.analysis;
  const downbeats = analysis?.downbeats ?? [];
  const duration = durationMs();
  if (!analysis || downbeats.length < 2 || !(duration > 0)) return null;
  const barMs = analysis.beatIntervalMs > 0 ? analysis.beatIntervalMs * (analysis.meter || 4) : 0;
  if (!(barMs > 0)) return null;
  let index = 0;
  for (let i = 0; i < downbeats.length; i += 1) {
    if (downbeats[i] <= state.positionMs + 4) index = i;
  }
  const aligned = index - (index % bars);
  const startMs = Math.max(0, downbeats[aligned] ?? 0);
  const endMs = Math.min(duration, startMs + bars * barMs);
  if (!(endMs - startMs > 200)) return null;
  return { startMs, endMs };
}

/** 切换「按小节循环」：开启时锁定当前位置所在乐句的 N 小节，再按一次关闭。 */
export function toggleBarLoop(bars = 4): { ok: boolean; loop: { startMs: number; endMs: number } | null } {
  if (loopRange) {
    loopRange = null;
    setState({});
    return { ok: true, loop: null };
  }
  const bounds = barLoopBounds(bars);
  if (!bounds) return { ok: false, loop: null };
  loopRange = bounds;
  setState({});
  return { ok: true, loop: { ...bounds } };
}

function enforceBarLoop(position: number): void {
  if (!loopRange) return;
  if (preview) return;
  if (!(loopRange.endMs > loopRange.startMs)) return;
  if (position < loopRange.endMs - 40) return;
  // 循环回到起点：直接改 currentTime，避免每次循环都重建无缝衔接计划。
  try {
    audio.currentTime = startAt + loopRange.startMs / 1000;
  } catch {
    return;
  }
  setState({ positionMs: loopRange.startMs });
}

function resetBarLoop(): void {
  if (loopRange) {
    loopRange = null;
    setState({});
  }
}

function setPrefetch(patch: Partial<PrefetchRecord>): void {
  prefetch = { ...prefetch, ...patch };
  setPrefetchDebug({
    nextAnalysisReady: prefetch.state === 'ready',
    prefetchState: prefetch.state,
    prefetchTitle: prefetch.title,
  });
}

/** 后台预分析「队列里接下来会播的那首」（模式感知 + 缓存复用，不重复请求宿主）。 */
function prefetchNextAnalysis(track: OnlineTrack | null): void {
  prefetchToken += 1;
  const token = prefetchToken;
  if (!track) {
    setPrefetch({ key: '', title: '', state: 'idle' });
    return;
  }
  const key = trackKeyOf(track);
  if (analysisCache.has(key)) {
    setPrefetch({ key, title: track.title, state: 'ready' });
    console.debug(`[player] prefetch hit：${track.title}（分析结果已在缓存，切歌无需等待）`);
    return;
  }
  setPrefetch({ key, title: track.title, state: 'pending' });
  console.debug(`[player] prefetch start：${track.title}`);
  analysisFor(track).then(
    () => {
      if (token !== prefetchToken || prefetch.key !== key) return;
      setPrefetch({ state: 'ready' });
      console.debug(`[player] prefetch ready：${track.title}`);
    },
    (err: unknown) => {
      if (token !== prefetchToken || prefetch.key !== key) return;
      setPrefetch({ state: 'failed' });
      console.debug('[player] prefetch failed', track.title, err instanceof Error ? err.message : err);
    },
  );
}

/** 预选下一首（模式感知）：list = 顺延、shuffle = 随机且本次固定、single = 无（同曲重启）。 */
function planUpcoming(): { index: number; track: OnlineTrack } | null {
  const queue = state.queue;
  const current = state.track;
  if (!current || queue.length === 0) return null;
  if (state.mode === 'single') return null;
  const currentKey = trackKeyOf(current);
  if (plannedNextIndex !== null && plannedFor === currentKey) {
    const planned = queue[plannedNextIndex];
    if (planned && plannedNextIndex !== state.index) return { index: plannedNextIndex, track: planned };
    plannedNextIndex = null;
    plannedFor = '';
  }
  if (queue.length < 2) return null;
  const index = state.mode === 'shuffle' ? randomOtherIndex() : (state.index + 1) % queue.length;
  const track = queue[index];
  if (!track || index === state.index) return null;
  plannedNextIndex = index;
  plannedFor = currentKey;
  return { index, track };
}

/**
 * 待播预览：与「自然播完 / 下一首按钮」完全一致的下一首。
 * shuffle 模式下随机结果在此刻固定，避免界面显示与真正播放的不一致。
 */
export function peekUpcoming(): { index: number; track: OnlineTrack } | null {
  return planUpcoming();
}

/** 正在过渡的目标曲目（预告条 UI 用；没有过渡时为 null）。 */
export function getTransitionTarget(): OnlineTrack | null {
  return transitionTarget;
}

function clearStandbyDeck(): void {
  try {
    standby.pause();
    standby.removeAttribute('src');
    standby.load();
  } catch {
    /* 忽略 */
  }
}

/** 过渡中界面显示的进度：从正在淡入的 B 读。 */
function previewPositionMs(): number {
  if (!preview) return positionMs();
  const raw = Number.isFinite(preview.deck.currentTime) ? preview.deck.currentTime : preview.startAt;
  return Math.max(0, (raw - preview.startAt) * 1000);
}

/**
 * 过渡开始（B 已起播、第一帧淡化之前）：把界面切到下一首。
 * 只改展示状态，不动 deck —— 音频交换仍由 commitSeamless 在淡化结束时完成。
 */
function beginSeamlessPreview(
  deck: HTMLAudioElement,
  track: OnlineTrack,
  index: number,
  fromTrack: OnlineTrack | null,
  fromIndex: number,
  nextStartAt: number,
): void {
  const rawDuration = Number.isFinite(deck.duration) && deck.duration > nextStartAt ? deck.duration - nextStartAt : 0;
  preview = {
    deck,
    track,
    index,
    fromTrack,
    fromIndex,
    startAt: nextStartAt,
    durationMs: rawDuration > 0 ? rawDuration * 1000 : (track.durationMs ?? 0),
  };
  setState({
    track,
    index,
    positionMs: previewPositionMs(),
    durationMs: preview.durationMs,
    playing: true,
    loading: false,
  });
  refreshLiked(track);
}

/** 过渡被取消：界面回退到还在发声的 A，进度继续读 A 的真实位置。 */
function restorePreview(reason: string): void {
  if (!preview) return;
  const back = preview;
  preview = null;
  setState({
    track: back.fromTrack,
    index: back.fromIndex,
    positionMs: positionMs(),
    durationMs: durationMs(),
    playing: !audio.paused,
  });
  refreshLiked(back.fromTrack);
  console.debug(`[player] seamless preview 回退（${reason}）`);
}

/**
 * 取消无缝衔接：作废异步准备与预取、中止引擎里的计划/淡化（引擎会恢复 A 的音量），
 * 并清掉 B 的预加载。任何显式切歌/暂停/seek/停止/改队列/关开关都走这里。
 */
function cancelSeamless(reason: string, keepPlan = false): void {
  seamlessToken += 1;
  // 拖进度条只是换本次过渡的起点，不该把「随机播放预选好的下一首」也换掉。
  if (!keepPlan) {
    plannedNextIndex = null;
    plannedFor = '';
  }
  prefetchToken += 1;
  transitionTarget = null;
  // 预分析目标跟着计划一起作废（队列/模式/seek/暂停都会走到这里）。
  setPrefetch({ key: '', title: '', state: 'idle' });
  cancelCrossfade(reason);
  clearStandbyDeck();
  // 过渡中界面已经切到 B：取消时回退显示到仍在发声的 A。
  restorePreview(reason);
}

/**
 * 单曲循环的无缝重启：曲尾前约 1.5 秒淡出，同时同曲从该段开头淡入（B 从头播）。
 * 不需要节拍分析/歌词，只要流地址可解析、当前段时长足够。
 */
function planSingleLoop(current: OnlineTrack, token: number): void {
  setPrefetch({ key: '', title: current.title, state: 'idle' });
  const activeDeck = audio;
  const activeStandby = standby;
  const loopIndex = state.index;
  const total = durationMs();
  const fadeMs = MANUAL_FADE_DEFAULT_MS;
  if (!(total > fadeMs + 500)) return;
  let nextUrl = '';
  try {
    nextUrl = streamUrl(current);
  } catch (err) {
    console.warn('[player] loop crossfade streamUrl failed', err);
    return;
  }
  const ok = prepareLoopCrossfade({
    active: activeDeck,
    standby: activeStandby,
    fromTitle: current.title,
    nextTitle: current.title,
    nextStartFileMs: Math.max(0, startAt) * 1000,
    currentPositionMs: positionMs(),
    fadeMs,
    triggerPosMs: Math.max(0, total - fadeMs),
    nextUrl,
    baseVolume: () => state.volume,
    baseRate: () => userRate,
    isValid: () =>
      token === seamlessToken &&
      state.playing &&
      audio === activeDeck &&
      outgoingTrack() === current &&
      state.mode === 'single' &&
      readCrossfadeSettings().enabled,
    onStart: () => beginSeamlessPreview(activeStandby, current, loopIndex, current, loopIndex, Math.max(0, startAt)),
    onFinish: () => commitSeamless(activeDeck, activeStandby, current, loopIndex),
    onFail: (reason) => {
      if (token !== seamlessToken) return;
      console.debug('[player] loop crossfade failed，曲尾回退硬重启', reason);
    },
  });
  if (ok) transitionTarget = current;
  else console.debug('[player] loop crossfade 准备跳过（回退 ended 硬重启）');
}

/**
 * 异步准备下一首：先分析 A（已知）与 B，再让引擎排淡化时间表并预加载 B。
 * 模式感知：list = 顺延下一首、shuffle = 已选好的随机下一首、single = 曲尾同曲重启；
 * 队列只有一首 / 开关关闭 / 分析失败时静默放弃，回退为原来的硬切。
 * Web Audio 图已建立时改走图内增益淡化（引擎会把两个 deck 接图）。
 */
function prepareSeamlessNext(): void {
  seamlessToken += 1;
  const token = seamlessToken;
  // 上一份计划作废（引擎内部会恢复 A 音量、暂停 B）；若界面已在过渡中切到 B，先退回 A。
  restorePreview('replace');
  cancelCrossfade('replace');
  clearStandbyDeck();
  // 预分析状态跟着重排（同一首重排会命中缓存，不重复请求宿主）。
  prefetchToken += 1;
  transitionTarget = null;

  const idlePrefetch = (): void => setPrefetch({ key: '', title: '', state: 'idle' });
  if (!state.playing) {
    idlePrefetch();
    return;
  }
  if (!readCrossfadeSettings().enabled) {
    idlePrefetch();
    return;
  }
  const current = state.track;
  if (!current) {
    idlePrefetch();
    return;
  }
  // 单曲循环：曲尾同曲淡出 → 同曲从该段开头淡入重启（B 从头播，不等节拍分析）。
  if (state.mode === 'single') {
    planSingleLoop(current, token);
    return;
  }
  const queue = state.queue;
  if (queue.length < 2) {
    idlePrefetch();
    return;
  }
  const upcoming = planUpcoming();
  if (!upcoming) {
    idlePrefetch();
    return;
  }
  const nextTrack = upcoming.track;
  const nextIndex = upcoming.index;

  // 捕获准备时的 deck 引用：过程中若发生过 deck 交换则这次准备作废。
  const activeDeck = audio;
  const standbyDeck = standby;
  const currentStartAt = startAt;
  const currentIndex = state.index;
  const currentDurationMs = durationMs();
  const currentPositionMs = positionMs();
  // 预分析「接下来会播的那首」：命中缓存时切歌瞬间无需等待宿主分析。
  const currentCacheHit = analysisCache.has(trackKeyOf(current));
  const nextCacheHit = analysisCache.has(trackKeyOf(nextTrack));
  console.debug(
    `[player] seamless prepare ${currentCacheHit || nextCacheHit ? 'prefetch-hit' : 'prefetch-miss'}：` +
      `${current.title}${currentCacheHit ? '(缓存)' : ''} → ${nextTrack.title}${nextCacheHit ? '(已预分析)' : ''}`,
  );
  setPrefetchDebug({ prefetchHit: nextCacheHit });
  prefetchNextAnalysis(nextTrack);

  Promise.all([analysisFor(current), analysisFor(nextTrack)])
    .then(async ([currentResult, nextResult]) => {
      if (token !== seamlessToken) return;
      if (!state.playing || audio !== activeDeck || outgoingTrack() !== current) return;
      if (!readCrossfadeSettings().enabled) return;
      // 取两首歌词的人声首末句：B 的首句用于对齐过渡终点（前奏长/短两种安排），
      // A 的末句用于「歌词衔接」（A 末句唱完接 B 首句）。取不到（无歌词/超时）返回 null，
      // 引擎回退为普通淡化（B 从第一个强拍起播）。
      const [nextRange, currentRange] = await Promise.all([fetchVocalRange(nextTrack), fetchVocalRange(current)]);
      const nextVocalStartMs = nextRange && nextRange.firstMs > 0 ? nextRange.firstMs : null;
      const currentLastVocalEndMs = currentRange && currentRange.lastEndMs > 0 ? currentRange.lastEndMs : null;
      if (token !== seamlessToken) return;
      if (!state.playing || audio !== activeDeck || outgoingTrack() !== current) return;
      if (!readCrossfadeSettings().enabled) return;
      let nextUrl = '';
      try {
        nextUrl = streamUrl(nextTrack);
      } catch (err) {
        console.warn('[player] seamless streamUrl failed', err);
        return;
      }
      const prepared = prepareCrossfade({
        active: activeDeck,
        standby: standbyDeck,
        current: { track: current, startAt: currentStartAt },
        next: { track: nextTrack, startAt: Number(nextTrack.startAt ?? 0) },
        currentDurationMs,
        currentPositionMs,
        currentAnalysis: currentResult,
        nextAnalysis: nextResult,
        nextVocalStartMs,
        currentLastVocalEndMs,
        nextUrl,
        baseVolume: () => state.volume,
        baseRate: () => userRate,
        isValid: () =>
          token === seamlessToken &&
          state.playing &&
          audio === activeDeck &&
          outgoingTrack() === current &&
          readCrossfadeSettings().enabled,
        onStart: () =>
          beginSeamlessPreview(
            standbyDeck,
            nextTrack,
            nextIndex,
            current,
            currentIndex,
            Number(nextTrack.startAt ?? 0),
          ),
        onFinish: () => commitSeamless(activeDeck, standbyDeck, nextTrack, nextIndex),
      });
      if (prepared) {
        transitionTarget = nextTrack;
      } else {
        console.warn('[player] seamless prepare skipped（回退硬切）');
      }
    })
    .catch((err: unknown) => {
      // 分析失败是常态（不支持 / 宿主返回错误）：静默回退，不影响正常播放。
      if (token === seamlessToken) clearStandbyDeck();
      console.warn('[player] seamless analyze skipped（回退硬切）', err instanceof Error ? err.message : err);
    });
}

/**
 * 引擎淡化完成（或图激活硬切）后交换 deck，并把所有既有行为迁移到新曲：
 * track/index、时长与进度、音质、喜欢、持久化、SMTC 上报、最近播放、歌词页进度、下次准备。
 */
function commitSeamless(
  previousDeck: HTMLAudioElement,
  nextDeck: HTMLAudioElement,
  track: OnlineTrack,
  index: number,
): void {
  if (audio !== previousDeck || standby !== nextDeck) {
    cancelSeamless('commit-stale');
    return;
  }
  cancelFade();
  seamlessToken += 1;
  // 界面可能已经在过渡开始时切到了这首：收尾时清掉预览，后面的 setState 直接以新 deck 为准。
  preview = null;
  audio = nextDeck;
  standby = previousDeck;
  // 过渡结束：新 deck 回到用户倍速（引擎已把 WSOLA tempoRate 平滑拉回），旧预选/过渡目标作废。
  applyDeckRate(audio, userRate);
  applyDeckRate(standby, userRate);
  plannedNextIndex = null;
  plannedFor = '';
  transitionTarget = null;
  // 图内模式时 B 已在 deckMix 里（gain=1），切换后继续走图；只有元素模式的硬切需要标记
  // 「当前 deck 不在图里」以便 applyPlaybackVolume 走元素音量。
  activeDeckOutsideGraph = audioTapGraphActive() && !deckGraphConnected(audio);
  try {
    previousDeck.pause();
    previousDeck.removeAttribute('src');
    previousDeck.load();
  } catch {
    /* 忽略 */
  }
  applyCue(track);
  fadeScale = 1;
  vocalHold = 0;
  setVocalFade(0);
  setState({
    track,
    index,
    positionMs: positionMs(),
    durationMs: durationMs(),
    playing: true,
    loading: false,
  });
  refreshLiked(track);
  setState({ streamQuality: '' });
  if (track.source !== 'local') {
    void fetchStreamInfo(track.source, track.id, qualityForSource(track.source))
      .then((info) => {
        if (state.track !== track) return;
        const parts = [info.quality, info.format ? info.format.toUpperCase() : ''];
        if (info.bitrate >= 1000) parts.push(`${Math.round(info.bitrate / 1000)}k`);
        setState({ streamQuality: parts.filter(Boolean).join(' · ') });
      })
      .catch(() => {
        if (state.track === track) setState({ streamQuality: '' });
      });
  }
  attachAudioTap(audio);
  applyPlaybackVolume(true);
  void recordRecent(track);
  maybeReport();
  scheduleTick();
  // 无缝过渡也可能落在队列末尾（续接批次里的最后一首）：同样提前续上。
  maybeRefillQueue();
  prepareSeamlessNext();
}

function onLoadedMetadata(element: HTMLAudioElement): void {
  if (element !== audio) return;
  if (startAt > 0) {
    try {
      audio.currentTime = startAt;
    } catch {
      /* 忽略 */
    }
  }
  setState({ durationMs: durationMs() });
}

/** 两个 deck 都要接事件：B 的 ended/error 用来及时放弃衔接计划，不触发切歌。 */
const wiredDecks = new WeakSet<HTMLAudioElement>();

function wireDeck(element: HTMLAudioElement): void {
  if (wiredDecks.has(element)) return;
  wiredDecks.add(element);
  element.addEventListener('ended', () => onEnded(element));
  element.addEventListener('error', () => onError(element));
  element.addEventListener('loadedmetadata', () => onLoadedMetadata(element));
}

wireDeck(deckA);
wireDeck(deckB);

/* 设置里的无缝衔接开关/时长变化：关 = 立即取消并回退硬切；开 = 重新准备。 */
window.addEventListener('zilux:crossfade', () => {
  if (!readCrossfadeSettings().enabled) {
    cancelSeamless('disabled');
    return;
  }
  if (state.playing) prepareSeamlessNext();
});

/* 系统媒体键 / Windows 浮层按钮 */
onMediaControl((control: MediaControl) => {
  switch (control.action) {
    case 'play':
      if (audio.paused) toggle();
      break;
    case 'pause':
      if (!audio.paused) toggle();
      break;
    case 'next':
      next();
      break;
    case 'prev':
      prev();
      break;
    case 'stop':
      stop();
      break;
    case 'seek':
      if (typeof control.positionMs === 'number') seek(control.positionMs);
      break;
  }
});

/* 退出前把最后状态落盘 */
window.addEventListener('pagehide', persistNow);
window.addEventListener('beforeunload', persistNow);

/* 音量跟随设置 */
window.addEventListener('zilux:volume', (event) => {
  const detail = (event as CustomEvent<number>).detail;
  if (typeof detail === 'number') setVolume(detail);
});
