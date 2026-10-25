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
import { analyzeTrack, type AnalysisResult } from '../online/analysis';
import type { OnlineTrack } from '../online/types';
import { getSettings } from '../core/settings';
import { attachAudioTap, audioTapGraphActive, deckGraphConnected, ensureEqualizerGraph, setAudioTapVolume, setEqualizer, setVocalFade } from '../core/audioTap';
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
import { fetchVocalStartMs } from './vocalStart';

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
    element.preservesPitch = true;
    (element as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    element.playbackRate = clampRate(rate);
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

function applyPlaybackVolume(immediate = false): void {
  // 交叉淡化进行中：两 deck 音量由引擎按等功率曲线直接控制，这里只同步基础音量。
  if (crossfadeIsFading()) {
    crossfadeApplyVolume(state.volume);
    return;
  }
  // 均衡器 / 人声保留淡出都需要 Web Audio 图；开启时保证图已建立，音量随之交给本地 gain。
  if ((fx.eqEnabled || fx.fadeVocal) && !audioTapGraphActive()) ensureEqualizerGraph();
  const volume = state.volume * fadeScale;
  if (audioTapGraphActive() && !activeDeckOutsideGraph) {
    audio.volume = 1;
    setAudioTapVolume(volume, immediate);
  } else {
    audio.volume = volume;
  }
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
  const nextPos = positionMs();
  const nextDur = durationMs();
  if (
    Math.abs(nextPos - state.positionMs) > 40 ||
    Math.abs(nextDur - state.durationMs) > 200 ||
    state.playing !== !audio.paused
  ) {
    setState({ positionMs: nextPos, durationMs: nextDur, playing: !audio.paused });
  }
  // 到点就起播 B 并开始等功率交叉淡化（内部有开关/图表/过期守卫）。
  crossfadeTick(nextPos, nextDur);
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

/** 载入并播放队列中某一首。 */
function load(index: number, autoplay = true): void {
  const track = state.queue[index] ?? null;
  if (!track) {
    stop();
    return;
  }
  // 任何显式切歌都放弃上一首的无缝衔接计划（B 的预加载一并清掉）。
  cancelSeamless('load');
  // 过渡期的 WSOLA 变速不跨曲残留：新的一首从用户倍速开始（默认 1 = 原速）。
  applyDeckRate(audio);
  applyDeckRate(standby);
  applyCue(track);
  setState({
    track,
    index,
    positionMs: 0,
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
    const fade = fx.fadeEnabled ? Math.max(0, fx.fadeInMs) : 0;
    fadeScale = fade > 0 ? 0 : 1;
    vocalHold = 0;
    setVocalFade(0);
    applyPlaybackVolume(true);
    void audio
      .play()
      .then(() => {
        if (startAt > 0) audio.currentTime = startAt;
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
}

export function playQueue(tracks: OnlineTrack[], index = 0, autoplay = true): void {
  if (tracks.length === 0) return;
  const safeIndex = Math.max(0, Math.min(index, tracks.length - 1));
  (window as unknown as { __ziluxSkip?: number }).__ziluxSkip = 0;
  state = { ...state, queue: tracks.slice() };
  load(safeIndex, autoplay);
}

/**
 * 用更完整的列表替换队列（保持当前曲目与播放进度，不重载音频）。
 * 首页卡片一开始只有预览用的少量曲目，进入播放后会异步补全整张列表，
 * 否则列表循环时会「播几首就绕回第一首」。
 */
export function replaceQueue(tracks: OnlineTrack[]): void {
  if (tracks.length === 0) return;
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

export function playAt(index: number, tracks?: OnlineTrack[]): void {
  if (tracks) {
    playQueue(tracks, index, true);
    return;
  }
  if (state.queue.length === 0) return;
  const safe = Math.max(0, Math.min(index, state.queue.length - 1));
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
      state.track === fromTrack &&
      readCrossfadeSettings().enabled,
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

export function prev(): void {
  if (state.queue.length === 0) return;
  if (positionMs() > 3000) {
    seek(0);
    return;
  }
  if (state.mode === 'shuffle' && state.queue.length > 1) {
    manualSwitch(randomOtherIndex());
    return;
  }
  const index = state.index - 1;
  manualSwitch(index < 0 ? state.queue.length - 1 : index);
}

export function seek(ms: number): void {
  if (!state.track) return;
  // 拖动进度：旧的淡化窗口失效，先取消并清理 B，再按新位置重新准备。
  cancelSeamless('seek');
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

/**
 * 取消无缝衔接：作废异步准备与预取、中止引擎里的计划/淡化（引擎会恢复 A 的音量），
 * 并清掉 B 的预加载。任何显式切歌/暂停/seek/停止/改队列/关开关都走这里。
 */
function cancelSeamless(reason: string): void {
  seamlessToken += 1;
  plannedNextIndex = null;
  plannedFor = '';
  prefetchToken += 1;
  transitionTarget = null;
  // 预分析目标跟着计划一起作废（队列/模式/seek/暂停都会走到这里）。
  setPrefetch({ key: '', title: '', state: 'idle' });
  cancelCrossfade(reason);
  clearStandbyDeck();
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
      state.track === current &&
      state.mode === 'single' &&
      readCrossfadeSettings().enabled,
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
  // 上一份计划作废（引擎内部会恢复 A 音量、暂停 B）。
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
      if (!state.playing || audio !== activeDeck || state.track !== current) return;
      if (!readCrossfadeSettings().enabled) return;
      // 取下一首「开始唱词」位置：前奏长则从唱词前定长切入，前奏短则用整段前奏过渡。
      // 取不到（无歌词/超时）返回 null，引擎回退为「B 从第一个强拍起播」的普通淡化。
      const nextVocalStartMs = await fetchVocalStartMs(nextTrack);
      if (token !== seamlessToken) return;
      if (!state.playing || audio !== activeDeck || state.track !== current) return;
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
        nextUrl,
        baseVolume: () => state.volume,
        baseRate: () => userRate,
        isValid: () =>
          token === seamlessToken &&
          state.playing &&
          audio === activeDeck &&
          state.track === current &&
          readCrossfadeSettings().enabled,
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
function wireDeck(element: HTMLAudioElement): void {
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
