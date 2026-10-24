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
import { analyzeTrack } from '../online/analysis';
import type { OnlineTrack } from '../online/types';
import { getSettings } from '../core/settings';
import { attachAudioTap, audioTapGraphActive, deckGraphConnected, ensureEqualizerGraph, setAudioTapVolume, setEqualizer, setVocalFade } from '../core/audioTap';
import {
  cancelCrossfade,
  crossfadeApplyVolume,
  crossfadeFinishNow,
  crossfadeIsFading,
  crossfadeTick,
  prepareCrossfade,
  readCrossfadeSettings,
} from './crossfadeDeck';

export type PlayMode = 'list' | 'single' | 'shuffle';

const MODE_KEY = 'zilux2.playMode';

/** 当前 audio.src 是用哪个宿主端口（含 token）拼出来的；宿主每次启动换端口，旧地址必然失效。 */
let srcPort = 0;
/** 恢复上次播放时暂存的进度（等用户点播放、拿到新地址后再 seek）。 */
let pendingResumeMs = 0;

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
  // 淡化进行中 A 先放完：直接收尾到 B，不要再 load 一次。
  if (crossfadeFinishNow('ended')) return;
  cancelSeamless('ended');
  if (state.mode === 'single') {
    seek(0);
    void audio.play().catch(() => undefined);
    return;
  }
  advance();
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

export function playAt(index: number, tracks?: OnlineTrack[]): void {
  if (tracks) {
    playQueue(tracks, index, true);
    return;
  }
  const safe = Math.max(0, Math.min(index, state.queue.length - 1));
  load(safe, true);
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

function advance(): void {
  if (state.queue.length === 0) return;
  if (state.mode === 'shuffle' && state.queue.length > 1) {
    let index = state.index;
    while (index === state.index) index = Math.floor(Math.random() * state.queue.length);
    load(index, true);
    return;
  }
  const index = state.index + 1;
  load(index >= state.queue.length ? 0 : index, true);
}

/** 下一首（单曲循环时也跳下一首）。 */
export function next(): void {
  if (state.queue.length === 0) return;
  if (state.mode === 'single' && state.queue.length > 1) {
    const index = state.index + 1;
    load(index >= state.queue.length ? 0 : index, true);
    return;
  }
  advance();
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
  // 无缝衔接只在列表循环下成立：切模式先放弃旧计划，再按新模式决定是否重新准备。
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
    let index = state.index;
    while (index === state.index) index = Math.floor(Math.random() * state.queue.length);
    load(index, true);
    return;
  }
  const index = state.index - 1;
  load(index < 0 ? state.queue.length - 1 : index, true);
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
 * 取消无缝衔接：作废异步准备、中止引擎里的计划/淡化（引擎会恢复 A 的音量），
 * 并清掉 B 的预加载。任何显式切歌/暂停/seek/停止/改队列/关开关都走这里。
 */
function cancelSeamless(reason: string): void {
  seamlessToken += 1;
  cancelCrossfade(reason);
  clearStandbyDeck();
}

/**
 * 异步准备下一首：先分析 A（已知）与 B，再让引擎排淡化时间表并预加载 B。
 * 分析失败（AnalysisError）、单曲循环/随机、队列只有一首时静默放弃，行为回退为原来的硬切
 * （ended → load 下一首）。Web Audio 图已建立时改走图内增益淡化（引擎会把两个 deck 接图）。
 */
function prepareSeamlessNext(): void {
  seamlessToken += 1;
  const token = seamlessToken;
  // 上一份计划作废（引擎内部会恢复 A 音量、暂停 B）。
  cancelCrossfade('replace');
  clearStandbyDeck();

  if (!state.playing) return;
  const settings = readCrossfadeSettings();
  if (!settings.enabled) return;
  if (state.mode !== 'list') return;
  const queue = state.queue;
  if (queue.length < 2) return;
  const current = state.track;
  if (!current) return;
  const nextIndex = state.index + 1 >= queue.length ? 0 : state.index + 1;
  const nextTrack = queue[nextIndex];
  if (!nextTrack || nextIndex === state.index) return;

  // 捕获准备时的 deck 引用：过程中若发生过 deck 交换则这次准备作废。
  const activeDeck = audio;
  const standbyDeck = standby;
  const currentStartAt = startAt;
  const currentDurationMs = durationMs();
  const currentPositionMs = positionMs();

  Promise.all([analyzeTrack(current), analyzeTrack(nextTrack)])
    .then(([currentResult, nextResult]) => {
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
        nextUrl,
        baseVolume: () => state.volume,
        isValid: () =>
          token === seamlessToken &&
          state.playing &&
          audio === activeDeck &&
          state.track === current &&
          readCrossfadeSettings().enabled,
        onFinish: () => commitSeamless(activeDeck, standbyDeck, nextTrack, nextIndex),
      });
      if (!prepared) console.warn('[player] seamless prepare skipped（回退硬切）');
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
