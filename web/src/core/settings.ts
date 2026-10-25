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

/** 暂停淡出 / 开始播放淡入可分别设置。 */
export const FADE_OUT_MS = { min: 100, max: 3000, step: 50, fallback: 450 } as const;
export const FADE_IN_MS = { min: 100, max: 3000, step: 50, fallback: 450 } as const;
export const FADE_VOCAL_TAIL_MS = { min: 0, max: 3000, step: 100, fallback: 600 } as const;

/** 渐变曲线；exponential 在尾段下降更快，听感上更晚才「没声」。 */
export type FadeCurve = 'smooth' | 'linear' | 'exponential';
export const FADE_CURVES: readonly { value: FadeCurve; label: string }[] = [
  { value: 'smooth', label: '平滑' },
  { value: 'linear', label: '线性' },
  { value: 'exponential', label: '指数' },
];
const FADE_CURVE_IDS = FADE_CURVES.map((item) => item.value);

/* ---- 全局快捷键（Shortcuts v1，宿主注册结果走 bridge 的 shortcuts 事件） ---- */

/** 可配置的全局快捷键动作（与宿主 schema 的键名一致）。 */
export type ShortcutAction = 'playPause' | 'prev' | 'next' | 'toggleWindow';

export interface ShortcutsSettings {
  /** 全局开关：关闭后宿主注销全部组合。 */
  enabled: boolean;
  /** 空字符串表示该条不绑定。 */
  playPause: string;
  prev: string;
  next: string;
  toggleWindow: string;
}

/** 四条可配置的全局快捷键（顺序即设置页展示顺序）。 */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = ['playPause', 'prev', 'next', 'toggleWindow'];

/** 设置页展示用的标签与说明。 */
export const SHORTCUT_LABELS: Record<ShortcutAction, { label: string; hint: string }> = {
  playPause: { label: '播放 / 暂停', hint: '播放或暂停当前歌曲，应用在后台时也生效' },
  prev: { label: '上一首', hint: '切到当前播放队列的上一首' },
  next: { label: '下一首', hint: '切到当前播放队列的下一首' },
  toggleWindow: { label: '显示 / 隐藏窗口', hint: '窗口最小化到托盘后也能一键呼出' },
};

/** 默认组合（与宿主 Shortcuts v1 schema 的默认值保持一致）。 */
export const SHORTCUT_DEFAULTS: ShortcutsSettings = {
  enabled: true,
  playPause: 'Ctrl+Alt+Space',
  prev: 'Ctrl+Alt+Left',
  next: 'Ctrl+Alt+Right',
  toggleWindow: 'Ctrl+Alt+Z',
};

const SHORTCUT_MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Win'] as const;
type ShortcutModifier = (typeof SHORTCUT_MODIFIERS)[number];

/** 修饰键别名 → 规范名（宿主 token 大小写不敏感）。 */
const SHORTCUT_MODIFIER_ALIASES: Record<string, ShortcutModifier> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  win: 'Win',
  meta: 'Win',
  windows: 'Win',
};

/** 允许作为主键的 token（与宿主解析器同一套）。 */
const SHORTCUT_KEY_TOKENS: readonly string[] = [
  ...Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index)),
  ...Array.from({ length: 10 }, (_, index) => String(index)),
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
  'Space',
  'Tab',
  'Enter',
  'Esc',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Up',
  'Down',
  'Left',
  'Right',
];

const SHORTCUT_KEY_ALIASES: Record<string, string> = {
  spacebar: 'Space',
  escape: 'Esc',
  return: 'Enter',
  del: 'Delete',
  ins: 'Insert',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
};

const SHORTCUT_KEY_LOOKUP = new Map<string, string>(
  SHORTCUT_KEY_TOKENS.map((token) => [token.toLowerCase(), token]),
);

/** 单个 token → 规范主键名；不是合法主键时返回 null。 */
function shortcutKeyToken(raw: string): string | null {
  // 空格键的 event.key 就是 ' '，trim 后为空，需要单独识别。
  if (raw === ' ') return 'Space';
  const lower = raw.trim().toLowerCase();
  if (!lower) return null;
  return SHORTCUT_KEY_ALIASES[lower] ?? SHORTCUT_KEY_LOOKUP.get(lower) ?? null;
}

/** 宿主设置快照里是否带 shortcuts 段（旧宿主可能还没有）。 */
function hasShortcutsSection(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(raw, 'shortcuts');
}

/**
 * 校验并规范化快捷键串：`ctrl+alt+space` → `Ctrl+Alt+Space`。
 *
 * 规则（与宿主解析器一致）：
 * - 空串合法，表示「不绑定」；
 * - 至少 1 个修饰键（Ctrl/Control/Alt/Shift/Win/Meta）+ 恰好 1 个主键；
 * - 主键白名单：A-Z、0-9、F1-F24、Space/Tab/Enter/Esc/Backspace/Delete/Insert/Home/End/PageUp/PageDown/Up/Down/Left/Right；
 * - 修饰键按 Ctrl → Alt → Shift → Win 顺序输出；非法串返回 fallback。
 */
export function normalizeShortcutBinding(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > 64) return fallback;
  const parts = trimmed.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return fallback;
  const modifiers = new Set<ShortcutModifier>();
  let key: string | null = null;
  for (const part of parts) {
    const modifier = SHORTCUT_MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    const token = shortcutKeyToken(part);
    // 未知 token，或出现第二个主键：整条串非法。
    if (!token || key !== null) return fallback;
    key = token;
  }
  if (!key || modifiers.size === 0) return fallback;
  return [...SHORTCUT_MODIFIERS.filter((modifier) => modifiers.has(modifier)), key].join('+');
}

/** 展示用：`Ctrl+Alt+Space` → `Ctrl + Alt + Space`；空串 → 空串。 */
export function formatShortcutForDisplay(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' + ');
}

/**
 * 把一次浏览器 keydown 转成组合串（供设置页录制使用）。
 *
 * 纯修饰键（Control/Alt/Shift/Meta 自身）返回 null；无法识别的主键返回 null。
 * 是否要求修饰键由调用方决定（这里不强制，便于提示「需要搭配修饰键」）。
 */
export function shortcutBindingFromEvent(event: KeyboardEvent): string | null {
  const key = shortcutKeyToken(event.key);
  if (!key) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Win');
  return [...modifiers, key].join('+');
}

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
    /** 底部播放条常驻展开：开着时不再依赖鼠标悬停，播放条始终保持展开形态。 */
    playerBarExpanded: boolean;
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
    /** 旧版单一渐变时长（毫秒，50..3000）；新配置分别使用 fadeOutMs / fadeInMs。 */
    fadeMs: number;
    /** 暂停淡出时长（毫秒，100..3000）。 */
    fadeOutMs: number;
    /** 开始播放淡入时长（毫秒，100..3000）。 */
    fadeInMs: number;
    /** 渐变曲线：smooth 平滑 / linear 线性 / exponential 指数。 */
    fadeCurve: FadeCurve;
    /** 人声保留淡出：暂停时先压低低频与高频，让人声频段多停留一会儿。 */
    fadeVocal: boolean;
    /** 人声保留尾音（毫秒，0..3000）；淡出总时长 = fadeOutMs + 该值。 */
    fadeVocalTailMs: number;
  };
  shortcuts: ShortcutsSettings;
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
  shortcuts?: Partial<Settings['shortcuts']>;
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
    playerBarExpanded: false,
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
    fadeOutMs: FADE_OUT_MS.fallback,
    fadeInMs: FADE_IN_MS.fallback,
    fadeCurve: 'smooth',
    fadeVocal: false,
    fadeVocalTailMs: FADE_VOCAL_TAIL_MS.fallback,
  },
  shortcuts: { ...SHORTCUT_DEFAULTS },
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

type MsRange = { readonly min: number; readonly max: number; readonly step: number; readonly fallback: number };

function asMs(value: unknown, range: MsRange, fallback = range.fallback): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const stepped = Math.round(value / range.step) * range.step;
  return Math.max(range.min, Math.min(range.max, stepped));
}

function asFadeMs(value: unknown): number {
  return asMs(value, FADE_MS);
}

function asShortcuts(value: Record<string, unknown>): ShortcutsSettings {
  return {
    enabled: asBool(value.enabled, SHORTCUT_DEFAULTS.enabled),
    playPause: normalizeShortcutBinding(value.playPause, SHORTCUT_DEFAULTS.playPause),
    prev: normalizeShortcutBinding(value.prev, SHORTCUT_DEFAULTS.prev),
    next: normalizeShortcutBinding(value.next, SHORTCUT_DEFAULTS.next),
    toggleWindow: normalizeShortcutBinding(value.toggleWindow, SHORTCUT_DEFAULTS.toggleWindow),
  };
}

/** 深度合并 + 白名单校验：未知字段忽略，非法值回落默认值。 */
export function normalizeSettings(raw: unknown): Settings {
  const root = asObject(raw);
  const general = asObject(root.general);
  const appearance = asObject(root.appearance);
  const playback = asObject(root.playback);
  const shortcuts = asObject(root.shortcuts);
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
      playerBarExpanded: asBool(appearance.playerBarExpanded, DEFAULT_SETTINGS.appearance.playerBarExpanded),
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
      // 兼容旧配置：只有 fadeMs 时用它作为淡出/淡入的缺省值。
      fadeOutMs: asMs(playback.fadeOutMs ?? playback.fadeMs, FADE_OUT_MS),
      fadeInMs: asMs(playback.fadeInMs ?? playback.fadeMs, FADE_IN_MS),
      fadeCurve: asEnum(playback.fadeCurve, FADE_CURVE_IDS, DEFAULT_SETTINGS.playback.fadeCurve),
      fadeVocal: asBool(playback.fadeVocal, DEFAULT_SETTINGS.playback.fadeVocal),
      fadeVocalTailMs: asMs(playback.fadeVocalTailMs, FADE_VOCAL_TAIL_MS),
    },
    shortcuts: asShortcuts(shortcuts),
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
  root.classList.toggle('is-pb-expanded', next.appearance.playerBarExpanded);
  listeners.forEach((listener) => listener(next));
  // 播放引擎（player.ts / audioTap.ts）不订阅设置对象，避免循环依赖：这里广播音效偏好。
  window.dispatchEvent(
    new CustomEvent('zilux:playback-fx', {
      detail: {
        fadeEnabled: next.playback.fadeEnabled,
        fadeMs: next.playback.fadeMs,
        fadeOutMs: next.playback.fadeOutMs,
        fadeInMs: next.playback.fadeInMs,
        fadeCurve: next.playback.fadeCurve,
        fadeVocal: next.playback.fadeVocal,
        fadeVocalTailMs: next.playback.fadeVocalTailMs,
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
    // 兼容还没下发 shortcuts 段的旧宿主：保留页面当前快捷键，别被默认值冲掉。
    if (!hasShortcutsSection(msg.state)) next.shortcuts = { ...current.shortcuts };
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
  // 旧宿主快照没有 shortcuts 段时，优先保留本地镜像里的快捷键配置。
  if (raw && !hasShortcutsSection(raw)) {
    state.shortcuts = { ...readLocal().shortcuts };
  }
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
    shortcuts: { ...current.shortcuts, ...patch.shortcuts },
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
