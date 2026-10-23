/**
 * 设置状态（Settings v1）：宿主持久化 + 浏览器 localStorage 镜像。
 * 契约：docs/zilux2-settings-contract.md
 */
import { host, hostAvailable, type HostMessage, type UpdateMode } from './bridge';
import type { StreamQuality } from '../online/types';

export type Theme = 'frost';
export const STREAM_QUALITIES = ['standard', 'high', 'lossless'] as const;
export type LyricsSize = 'small' | 'medium' | 'large';
export type WindowAnimation = 'custom' | 'native';
export type OnlineSourceId = 'netease' | 'qq' | (string & {});

/** 均衡器预设；gains 单位 dB，顺序同 EQ_BAND_FREQS。 */
export type EqPreset = 'flat' | 'pop' | 'rock' | 'jazz' | 'classical' | 'vocal' | 'bass';
export const EQ_BAND_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const EQ_PRESETS: Record<EqPreset, readonly number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  pop: [-1, 0, 2, 4, 4, 1, -1, -1, 0, 0],
  rock: [4, 3, 1, -1, -2, -1, 2, 3, 4, 3],
  jazz: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  classical: [4, 3, 2, 1, 0, 0, 0, 2, 3, 4],
  vocal: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
  bass: [6, 5, 4, 1, 0, 0, 0, 0, 0, 0],
};
export const EQ_PRESET_IDS = Object.keys(EQ_PRESETS) as EqPreset[];
export const EQ_PRESET_LABELS: Record<EqPreset, string> = {
  flat: '原声',
  pop: '流行',
  rock: '摇滚',
  jazz: '爵士',
  classical: '古典',
  vocal: '人声',
  bass: '低音',
};
export const EQ_GAIN_MIN = -12;
export const EQ_GAIN_MAX = 12;
export const FADE_MS = { min: 50, max: 3000, step: 10, fallback: 450 } as const;

export interface Settings {
  version: 1;
  general: {
    splash: boolean;
    startMaximized: boolean;
  };
  appearance: {
    theme: Theme;
    reduceMotion: boolean;
    glow: boolean;
    heroAutoRotate: boolean;
    lyricsSize: LyricsSize;
    /** 窗口过渡：custom=应用内快照动画，native=交给 Windows 原生过渡。 */
    windowAnimation: WindowAnimation;
  };
  playback: {
    defaultSource: OnlineSourceId;
    searchLimit: number;
    lyricsAutoOpen: boolean;
    /** 空间里闲置（约 3 秒没动鼠标）且正在播放时，自动切到 3D 歌词界面，鼠标一动回磁贴 */
    idleLyrics: boolean;
    /** 让 3D 画面随系统音频轻微呼吸；关闭后宿主停止推送音频特征（§10）。 */
    audioReactive: boolean;
    volume: number;
    /** 播放音质：standard=128k、high=320k、lossless=无损（宿主按平台能力自动降级）。 */
    quality: StreamQuality;
    /** 10 段均衡器：关闭时直通（全部 0dB）。 */
    eqEnabled: boolean;
    eqPreset: EqPreset;
    /** 各频段增益（dB，-12..12），顺序同 EQ_BAND_FREQS。 */
    eqGains: number[];
    /** 播放/暂停时做音量淡出淡入；关闭时保持原有的瞬时暂停。 */
    fadeEnabled: boolean;
    /** 渐变时长（毫秒，50..3000）。 */
    fadeMs: number;
  };
  downloads: {
    /** 下载目录；空字符串表示 Windows「音乐」目录。 */
    directory: string;
    /** 下载音质：standard=128k、high=320k、lossless=无损（平台/会员不支持时宿主自动降级）。 */
    quality: StreamQuality;
  };
  updates: {
    /** 启动时自动检查 + 每 4 小时轮询 */
    autoCheck: boolean;
    /** auto=自动下载并在完成后提示安装；notify=只提示新版本与 Release 页 */
    mode: UpdateMode;
    /** 更新源 owner/repo；空字符串用编译期默认值 */
    repo: string;
  };
}

export type SettingsPatch = {
  general?: Partial<Settings['general']>;
  appearance?: Partial<Settings['appearance']>;
  playback?: Partial<Settings['playback']>;
  downloads?: Partial<Settings['downloads']>;
  updates?: Partial<Settings['updates']>;
};

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  general: { splash: true, startMaximized: false },
  appearance: {
    theme: 'frost',
    reduceMotion: false,
    glow: true,
    heroAutoRotate: true,
    lyricsSize: 'medium',
    windowAnimation: 'custom',
  },
  playback: {
    defaultSource: 'netease',
    searchLimit: 20,
    lyricsAutoOpen: true,
    idleLyrics: true,
    audioReactive: true,
    volume: 0.72,
    quality: 'high',
    eqEnabled: false,
    eqPreset: 'flat',
    eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    fadeEnabled: false,
    fadeMs: FADE_MS.fallback,
  },
  downloads: { directory: '', quality: 'high' },
  updates: { autoCheck: true, mode: 'auto', repo: '' },
};

const STORAGE_KEY = 'zilux2.settings';
const HOST_TIMEOUT_MS = 900;
const LOCAL_SAVE_DELAY = 200;

const THEMES: readonly Theme[] = ['frost'];
const LYRICS_SIZES: readonly LyricsSize[] = ['small', 'medium', 'large'];
const WINDOW_ANIMATIONS: readonly WindowAnimation[] = ['custom', 'native'];
const UPDATE_MODES: readonly UpdateMode[] = ['auto', 'notify'];
// 默认平台只校验非空字符串；具体可用平台由宿主 /api/sources 决定。
const SEARCH_LIMITS = [10, 20, 30] as const;

type Listener = (settings: Settings) => void;

let current: Settings = clone(DEFAULT_SETTINGS);
const listeners = new Set<Listener>();
let localSaveTimer = 0;
let hostListenerBound = false;
let pendingHostResolve: ((settings: Settings) => void) | null = null;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function asLimit(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
  return (SEARCH_LIMITS as readonly number[]).includes(numeric) ? numeric : DEFAULT_SETTINGS.playback.searchLimit;
}

function asVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.playback.volume;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function asEqGains(value: unknown): number[] {
  const source = Array.isArray(value) ? value : [];
  return EQ_BAND_FREQS.map((_, index) => {
    const raw = source[index];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
    return Math.round(Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, raw)));
  });
}

function asFadeMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.playback.fadeMs;
  const stepped = Math.round(value / FADE_MS.step) * FADE_MS.step;
  return Math.max(FADE_MS.min, Math.min(FADE_MS.max, stepped));
}

/** 深度合并 + 白名单校验：未知字段忽略，非法值回落默认值。 */
export function normalizeSettings(raw: unknown): Settings {
  const root = asObject(raw);
  const general = asObject(root.general);
  const appearance = asObject(root.appearance);
  const playback = asObject(root.playback);
  const downloads = asObject(root.downloads);
  const updates = asObject(root.updates);

  return {
    version: 1,
    general: {
      splash: asBool(general.splash, DEFAULT_SETTINGS.general.splash),
      startMaximized: asBool(general.startMaximized, DEFAULT_SETTINGS.general.startMaximized),
    },
    appearance: {
      theme: asEnum(appearance.theme, THEMES, DEFAULT_SETTINGS.appearance.theme),
      reduceMotion: asBool(appearance.reduceMotion, DEFAULT_SETTINGS.appearance.reduceMotion),
      glow: asBool(appearance.glow, DEFAULT_SETTINGS.appearance.glow),
      heroAutoRotate: asBool(appearance.heroAutoRotate, DEFAULT_SETTINGS.appearance.heroAutoRotate),
      lyricsSize: asEnum(appearance.lyricsSize, LYRICS_SIZES, DEFAULT_SETTINGS.appearance.lyricsSize),
      windowAnimation: asEnum(appearance.windowAnimation, WINDOW_ANIMATIONS, DEFAULT_SETTINGS.appearance.windowAnimation),
    },
    playback: {
      defaultSource:
        typeof playback.defaultSource === 'string' && playback.defaultSource
          ? playback.defaultSource
          : DEFAULT_SETTINGS.playback.defaultSource,
      searchLimit: asLimit(playback.searchLimit),
      lyricsAutoOpen: asBool(playback.lyricsAutoOpen, DEFAULT_SETTINGS.playback.lyricsAutoOpen),
      idleLyrics: asBool(playback.idleLyrics, DEFAULT_SETTINGS.playback.idleLyrics),
      audioReactive: asBool(playback.audioReactive, DEFAULT_SETTINGS.playback.audioReactive),
      volume: asVolume(playback.volume),
      quality: asEnum(playback.quality, STREAM_QUALITIES, DEFAULT_SETTINGS.playback.quality),
      eqEnabled: asBool(playback.eqEnabled, DEFAULT_SETTINGS.playback.eqEnabled),
      eqPreset: asEnum(playback.eqPreset, EQ_PRESET_IDS, DEFAULT_SETTINGS.playback.eqPreset),
      eqGains: asEqGains(playback.eqGains),
      fadeEnabled: asBool(playback.fadeEnabled, DEFAULT_SETTINGS.playback.fadeEnabled),
      fadeMs: asFadeMs(playback.fadeMs),
    },
    downloads: {
      directory: typeof downloads.directory === 'string' ? downloads.directory.trim() : '',
      quality: asEnum(downloads.quality, STREAM_QUALITIES, DEFAULT_SETTINGS.downloads.quality),
    },
    updates: {
      autoCheck: asBool(updates.autoCheck, DEFAULT_SETTINGS.updates.autoCheck),
      mode: asEnum(updates.mode, UPDATE_MODES, DEFAULT_SETTINGS.updates.mode),
      repo: typeof updates.repo === 'string' ? updates.repo.trim() : '',
    },
  };
}

export function getSettings(): Settings {
  return current;
}

export function onSettingsChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 应用设置到文档（主题/减少动效/光晕/歌词字号）并广播。 */
export function applySettings(next: Settings): void {
  current = next;
  const root = document.documentElement;
  root.dataset.theme = next.appearance.theme;
  root.dataset.lyricsSize = next.appearance.lyricsSize;
  root.classList.toggle('reduce-motion', next.appearance.reduceMotion);
  root.classList.toggle('no-glow', !next.appearance.glow);
  listeners.forEach((listener) => listener(next));
  // 播放引擎（player.ts / audioTap.ts）不订阅设置对象，避免循环依赖：这里广播音效偏好。
  window.dispatchEvent(
    new CustomEvent('zilux:playback-fx', {
      detail: {
        fadeEnabled: next.playback.fadeEnabled,
        fadeMs: next.playback.fadeMs,
        eqEnabled: next.playback.eqEnabled,
        eqGains: next.playback.eqGains,
      },
    }),
  );
}

function readLocal(): Settings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return clone(DEFAULT_SETTINGS);
    return normalizeSettings(JSON.parse(raw));
  } catch (err) {
    console.warn('[settings] localStorage 读取失败，使用默认值', err);
    return clone(DEFAULT_SETTINGS);
  }
}

function scheduleLocalSave(): void {
  window.clearTimeout(localSaveTimer);
  localSaveTimer = window.setTimeout(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch (err) {
      console.warn('[settings] localStorage 写入失败', err);
    }
  }, LOCAL_SAVE_DELAY);
}

function bindHostListener(): void {
  if (hostListenerBound || !hostAvailable()) return;
  hostListenerBound = true;
  host.onMessage((msg: HostMessage) => {
    if (msg.type !== 'host' || msg.event !== 'settings' || !msg.state) return;
    const next = normalizeSettings(msg.state);
    applySettings(next);
    pendingHostResolve?.(next);
  });
}

/** 启动时加载：宿主要求快照（900ms 超时回落本地镜像/默认值）。 */
export async function loadSettings(): Promise<Settings> {
  bindHostListener();
  let raw: unknown = null;

  if (hostAvailable()) {
    raw = await new Promise<Settings | null>((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        pendingHostResolve = null;
        resolve(null);
      }, HOST_TIMEOUT_MS);
      pendingHostResolve = (settings) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        pendingHostResolve = null;
        resolve(settings);
      };
      host.requestSettings();
    });
  }

  const state = raw ? normalizeSettings(raw) : readLocal();
  applySettings(state);
  return state;
}

/** 局部更新：立即应用；宿主在线走宿主持久化，否则写 localStorage 镜像。 */
export function patchSettings(patch: SettingsPatch): Settings {
  const merged: Settings = {
    version: 1,
    general: { ...current.general, ...patch.general },
    appearance: { ...current.appearance, ...patch.appearance },
    playback: { ...current.playback, ...patch.playback },
    downloads: { ...current.downloads, ...patch.downloads },
    updates: { ...current.updates, ...patch.updates },
  };
  const next = normalizeSettings(merged);
  applySettings(next);
  if (hostAvailable()) {
    host.patchSettings(patch);
  } else {
    scheduleLocalSave();
  }
  return next;
}

/** 恢复默认值。 */
export function resetSettings(): Settings {
  const next = clone(DEFAULT_SETTINGS);
  applySettings(next);
  if (hostAvailable()) {
    host.resetSettings();
  } else {
    window.clearTimeout(localSaveTimer);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 忽略 */
    }
  }
  return next;
}
