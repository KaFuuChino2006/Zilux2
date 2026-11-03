/**
 * 悬停试听：鼠标在封面 / 列表行上停留（默认 1 秒，设置里可调），试听 15 秒。
 * 起点默认从曲首开始，可在设置里切换为从高潮窗口开始（数据来自宿主 /api/analysis 的 climaxStartMs）。
 * 移开或点击立即停止；试听中点击这首歌，正式播放会从试听听到的位置无缝接续。
 *
 * - 高潮模式下没有分析结果时回退到 33% 位置（挑歌时也常是副歌）；
 * - 正在播放的曲目不做试听；
 * - 主播放器在放歌时会把主音量压低（duck），试听结束恢复，避免两首叠在一起。
 */

import { peekAnalysis } from '../online/analysis';
import { streamUrl } from '../online/client';
import type { OnlineTrack } from '../online/types';
import { attachDeckToGraph, audioTapGraphActive, setDeckGraphGain } from '../core/audioTap';
import { playerState, setPreviewDuck } from './player';

const DEFAULT_HOVER_DELAY_MS = 1000;
const FADE_IN_MS = 800;
const FADE_OUT_MS = 520;
const DUCK_FADE_MS = 600;
const DUCK_LEVEL = 0.16;
const PREVIEW_SETTINGS_KEY = 'zilux2.chorusPreview';

export interface ChorusPreviewSettings {
  /** 悬停多久开始试听；0 = 关闭自动试听。 */
  delayMs: number;
  /** 试听起点：intro = 从曲首开始；chorus = 从高潮/副歌窗口开始。 */
  startAt: 'intro' | 'chorus';
  /** 试听音量（相对正常播放），0.1–1；点击接管后会回到正常音量。 */
  volume: number;
  /** 单次试听最长时长（毫秒），到点自动停。 */
  maxMs: number;
  /** 点击正在试听的歌时，是否把试听接着交给正式播放。 */
  takeover: boolean;
}

const DEFAULT_VOLUME = 0.7;
const DEFAULT_MAX_MS = 15_000;

export const CHORUS_PREVIEW_MAX_CHOICES: { value: string; label: string }[] = [
  { value: '5000', label: '5 秒' },
  { value: '10000', label: '10 秒' },
  { value: '15000', label: '15 秒' },
  { value: '30000', label: '30 秒' },
  { value: '60000', label: '60 秒' },
];

const DELAY_CHOICES: { value: string; label: string }[] = [
  { value: '0', label: '关闭' },
  { value: '600', label: '0.6 秒' },
  { value: '1000', label: '1.0 秒' },
  { value: '1500', label: '1.5 秒' },
  { value: '2000', label: '2.0 秒' },
];

export function chorusPreviewDelayChoices(): { value: string; label: string }[] {
  return DELAY_CHOICES;
}

export const CHORUS_PREVIEW_START_CHOICES: { value: 'intro' | 'chorus'; label: string }[] = [
  { value: 'intro', label: '从曲首' },
  { value: 'chorus', label: '从高潮' },
];

export function readChorusPreviewSettings(): ChorusPreviewSettings {
  try {
    const raw = localStorage.getItem(PREVIEW_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        delayMs?: unknown;
        startAt?: unknown;
        volume?: unknown;
        maxMs?: unknown;
        takeover?: unknown;
      };
      const delayMs =
        typeof parsed.delayMs === 'number' && Number.isFinite(parsed.delayMs)
          ? Math.max(0, Math.min(4000, Math.round(parsed.delayMs)))
          : DEFAULT_HOVER_DELAY_MS;
      const startAt = parsed.startAt === 'chorus' ? 'chorus' : 'intro';
      const volume =
        typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)
          ? Math.max(0.1, Math.min(1, parsed.volume))
          : DEFAULT_VOLUME;
      const maxMs =
        typeof parsed.maxMs === 'number' && Number.isFinite(parsed.maxMs)
          ? Math.max(5000, Math.min(60000, Math.round(parsed.maxMs)))
          : DEFAULT_MAX_MS;
      const takeover = parsed.takeover !== false;
      return { delayMs, startAt, volume, maxMs, takeover };
    }
  } catch {
    /* 坏存档按默认处理 */
  }
  return { delayMs: DEFAULT_HOVER_DELAY_MS, startAt: 'intro', volume: DEFAULT_VOLUME, maxMs: DEFAULT_MAX_MS, takeover: true };
}

export function writeChorusPreviewSettings(patch: Partial<ChorusPreviewSettings>): ChorusPreviewSettings {
  const next: ChorusPreviewSettings = { ...readChorusPreviewSettings(), ...patch };
  next.delayMs = Math.max(0, Math.min(4000, Math.round(next.delayMs)));
  next.volume = Math.max(0.1, Math.min(1, next.volume));
  next.maxMs = Math.max(5000, Math.min(60000, Math.round(next.maxMs)));
  try {
    localStorage.setItem(PREVIEW_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* 存储不可用时只影响本机记忆 */
  }
  return next;
}

/** 元素上只存 data-track-key，真正对象靠渲染时注册进来。 */
const registry = new Map<string, OnlineTrack>();
const MAX_REGISTRY = 5000;

export function registerPreviewTrack(track: OnlineTrack): string {
  const key = `${track.source}:${track.id}`;
  if (registry.size >= MAX_REGISTRY) registry.clear();
  registry.set(key, track);
  return key;
}

let element: HTMLAudioElement | null = null;
let hoverTimer = 0;
let stopTimer = 0;
let fadeTimer = 0;
let hovered: HTMLElement | null = null;
let currentKey = '';
/** 本次试听在曲内的起点（毫秒），交接给正式播放时用它 + 已播时长。 */
let previewStartMs = 0;
let chip: HTMLDivElement | null = null;
/** 正在把试听交给正式播放：这期间不要因为 pointerout 等事件把试听停掉。 */
let adopting = false;

function audio(): HTMLAudioElement {
  if (!element) {
    element = new Audio();
    element.preload = 'auto';
    element.volume = 0;
    // 点击时这个元素会被直接交给播放器接管并接进 Web Audio 图；
    // 图要求跨域媒体带 CORS，宿主/本地服务都允许 zilux2.local，不加会变静音。
    element.crossOrigin = 'anonymous';
  }
  return element;
}

function ensureChip(): HTMLDivElement {
  if (!chip) {
    chip = document.createElement('div');
    chip.className = 'chorus-chip';
    chip.textContent = readChorusPreviewSettings().startAt === 'chorus' ? '副歌试听' : '试听中';
    document.body.append(chip);
  }
  return chip;
}

function placeChip(target: HTMLElement): void {
  const node = ensureChip();
  const rect = target.getBoundingClientRect();
  const width = node.offsetWidth || 84;
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left + rect.width / 2 - width / 2));
  const top = Math.min(window.innerHeight - 30, rect.top + 10);
  node.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  node.classList.add('is-on');
}

function hideChip(): void {
  chip?.classList.remove('is-on');
}

/** 元素接进音频图后音量由 deck 增益控制，否则用元素音量。 */
let attached = false;
let level = 0;

function applyLevel(value: number): void {
  level = value;
  const el = element;
  if (!el) return;
  try {
    if (attached) setDeckGraphGain(el, value);
    else el.volume = value;
  } catch {
    /* 元素已失效 */
  }
}

function ramp(to: number, durationMs: number): void {
  cancelAnimationFrame(fadeTimer);
  const from = level;
  const startedAt = performance.now();
  const step = (): void => {
    const t = Math.min(1, (performance.now() - startedAt) / durationMs);
    applyLevel(Math.max(0, Math.min(1, from + (to - from) * t)));
    if (t < 1) fadeTimer = requestAnimationFrame(step);
  };
  fadeTimer = requestAnimationFrame(step);
}

function keyOf(track: OnlineTrack): string {
  return `${track.source}:${track.id}`;
}

/**
 * 悬停试听中点了这首歌的播放：把正在播放的试听元素直接交给正式播放器继续用。
 * 不暂停、不清 src、不重新加载，交接时声音完全不断，位置天然连续。
 * 返回 null 表示当前没有在试听这首歌。
 */
export function takePreviewElement(track: OnlineTrack): HTMLAudioElement | null {
  const el = element;
  if (!el || !currentKey || el.paused || adopting) return null;
  if (currentKey !== keyOf(track)) return null;
  adopting = false;
  window.clearTimeout(stopTimer);
  window.clearTimeout(hoverTimer);
  stopTimer = 0;
  hoverTimer = 0;
  hovered = null;
  window.cancelAnimationFrame(fadeTimer);
  el.muted = false;
  const wasAttached = attached;
  attached = false;
  element = null; // 从此归播放器所有，试听模块不再碰它
  currentKey = '';
  previewStartMs = 0;
  hideChip();
  // 已接进图的元素保持增益原样，交给播放器接管；元素音量路径下也保持当前音量。
  // 主播放器的 duck 由 adoptPlayingElement 在停掉旧 deck 之后恢复，避免旧歌突然变响。
  void wasAttached;
  return el;
}

export function stopChorusPreview(): void {
  if (adopting) return; // 交接中：交给正式的淡出流程
  window.clearTimeout(hoverTimer);
  window.clearTimeout(stopTimer);
  hoverTimer = 0;
  stopTimer = 0;
  hovered = null;
  currentKey = '';
  previewStartMs = 0;
  hideChip();
  const el = element;
  if (!el) return;
  setPreviewDuck(1, DUCK_FADE_MS);
  ramp(0, FADE_OUT_MS);
  window.setTimeout(() => {
    if (level > 0.01) return;
    if (attached) {
      attached = false;
      try {
        setDeckGraphGain(el, 0);
      } catch {
        /* 忽略 */
      }
    }
    el.pause();
    el.removeAttribute('src');
    el.load();
  }, FADE_OUT_MS + 20);
}

async function startPreview(target: HTMLElement, track: OnlineTrack): Promise<void> {
  const state = playerState();
  if (state.track && state.track.id === track.id && state.track.source === track.source) return;
  adopting = false;
  const el = audio();
  el.pause();
  el.volume = 0;
  try {
    el.src = streamUrl(track);
  } catch {
    return;
  }
  attached = false;
  const settings = readChorusPreviewSettings();
  let startMs = 0;
  if (settings.startAt === 'chorus') {
    const analysis = await peekAnalysis(track);
    if (analysis?.analysis) {
      const window = analysis.analysis;
      if (typeof window.climaxStartMs === 'number' && window.climaxStartMs > 0) startMs = window.climaxStartMs;
      else if (analysis.durationMs > 4000) startMs = analysis.durationMs * 0.33;
    } else if ((track.durationMs ?? 0) > 4000) {
      startMs = (track.durationMs ?? 0) * 0.33;
    }
  }
  if (!target.isConnected || hovered !== target) return;
  previewStartMs = startMs;
  if (chip) chip.textContent = settings.startAt === 'chorus' ? '副歌试听' : '试听中';
  previewStartMs = startMs;
  const seek = (): void => {
    try {
      el.currentTime = Math.max(0, Math.min((el.duration || track.durationMs || 0) / 1000 - 1, startMs / 1000));
    } catch {
      /* 元数据未就绪时交给下面的 canplay */
    }
  };
  if (el.readyState >= 1) seek();
  else el.addEventListener('loadedmetadata', seek, { once: true });
  // 图已在用时先把元素接进去：点击接管时只是换归属，不会再触发 createMediaElementSource 的断音。
  attached = audioTapGraphActive() && attachDeckToGraph(el);
  if (attached) {
    try {
      el.volume = 1;
    } catch {
      /* 忽略 */
    }
    applyLevel(0);
  }
  // 浏览器自动播放策略：静音起播免手势，起播后再取消静音并渐入。
  el.muted = true;
  if (!attached) el.volume = 0;
  level = 0;
  placeChip(target);
  currentKey = `${track.source}:${track.id}`;
  try {
    await el.play();
  } catch {
    hideChip();
    currentKey = '';
    setPreviewDuck(1);
    applyLevel(0);
    return;
  }
  el.muted = false;
  if (state.playing) setPreviewDuck(DUCK_LEVEL, DUCK_FADE_MS);
  // 已接进图时 deck 增益 1 就等于「播放器当前音量」（主 gain 已按用户音量设置）；
  // 元素音量路径用播放器音量作为目标，点击接手时不会先掉音量。
  // 试听音量是相对正常播放的比例，接管后由播放器自己恢复到 1。
  const previewLevel = attached
    ? settings.volume
    : Math.max(0.02, Math.min(1, state.volume * settings.volume));
  ramp(previewLevel, FADE_IN_MS);
  window.clearTimeout(stopTimer);
  stopTimer = window.setTimeout(() => stopChorusPreview(), settings.maxMs);
}

export function installChorusPreview(root: HTMLElement): void {
  const cancel = (): void => {
    window.clearTimeout(hoverTimer);
    hoverTimer = 0;
    hideChip();
    if (currentKey) stopChorusPreview();
  };

  root.addEventListener(
    'pointerover',
    (event) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest<HTMLElement>('[data-track-key]');
      if (!target) return;
      if (target === hovered) return;
      hovered = target;
      window.clearTimeout(hoverTimer);
      hoverTimer = 0;
      const delayMs = readChorusPreviewSettings().delayMs;
      if (delayMs <= 0) return;
      hoverTimer = window.setTimeout(() => {
        const key = target.dataset.trackKey ?? '';
        const track = registry.get(key);
        if (track) void startPreview(target, track);
      }, delayMs);
    },
    true,
  );

  root.addEventListener(
    'pointerout',
    (event) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest<HTMLElement>('[data-track-key]');
      if (!target || target !== hovered) return;
      const related = event.relatedTarget;
      if (related instanceof Node && target.contains(related)) return;
      hovered = null;
      cancel();
    },
    true,
  );

  const hardCancel = (): void => {
    if (currentKey || hoverTimer) cancel();
  };
  // 点在「正在试听的这首歌」上时不要立刻取消：click 会接手做无缝交接（从试听位置续播）。
  // 点其它曲目/空白、拖动、滚动或 Esc 仍然立即停止。
  root.addEventListener(
    'pointerdown',
    (event) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest<HTMLElement>('[data-track-key]');
      if (target && currentKey && target.dataset.trackKey === currentKey) return;
      hardCancel();
    },
    true,
  );
  window.addEventListener('scroll', hardCancel, true);
  window.addEventListener('wheel', hardCancel, { capture: true, passive: true });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hardCancel();
  });
  window.addEventListener('blur', hardCancel);

  // 调试钩子：CDP / 控制台可直接读试听状态与延迟设置。
  (window as unknown as { __ziluxPreview?: () => unknown }).__ziluxPreview = () => {
    const el = element;
    return {
      key: currentKey,
      startMs: previewStartMs,
      positionMs: el ? Math.round(el.currentTime * 1000) : 0,
      playing: !!el && !el.paused,
      delayMs: readChorusPreviewSettings().delayMs,
      startAt: readChorusPreviewSettings().startAt,
    };
  };
}
