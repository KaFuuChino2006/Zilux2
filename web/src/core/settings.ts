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
/** 迷你播放器尺寸预设：compact=360×100、standard=420×120、wide=520×150。 */
export type MiniSize = 'compact' | 'standard' | 'wide';

/** 桌面歌词主行粗细。 */
export type DesktopLyricsWeight = 'normal' | 'semibold' | 'bold';
export const MINI_SIZES: readonly MiniSize[] = ['compact', 'standard', 'wide'];
export const MINI_SIZE_LABELS: ReadonlyArray<readonly [MiniSize, string]> = [
  ['compact', '小'],
  ['standard', '标准'],
  ['wide', '宽'],
];
/** 迷你窗口的像素尺寸（与宿主 MainWindow 的预设保持一致）。 */
export const MINI_SIZE_DIMS: Record<MiniSize, { width: number; height: number }> = {
  compact: { width: 360, height: 100 },
  standard: { width: 420, height: 120 },
  wide: { width: 520, height: 150 },
};
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

/** 睡眠定时到点前的渐弱时长（秒）可选档位；0 表示不渐弱。 */
export const SLEEP_FADE_SECONDS_CHOICES: readonly number[] = [0, 5, 10, 15, 30];

/** 本软件音频输出：跟随 Windows 默认设备，或固定到某个播放设备（宿主字段同名）。 */
export type AppOutputMode = 'system' | 'device';
export const APP_OUTPUT_MODES: readonly AppOutputMode[] = ['system', 'device'];

/** 睡眠定时到点后的动作。 */
export type SleepTimerAction = 'pause' | 'minimize' | 'exit';
export const SLEEP_TIMER_ACTIONS: readonly { value: SleepTimerAction; label: string }[] = [
  { value: 'pause', label: '暂停' },
  { value: 'minimize', label: '暂停并最小化' },
  { value: 'exit', label: '退出应用' },
];
const SLEEP_TIMER_ACTION_IDS = SLEEP_TIMER_ACTIONS.map((item) => item.value);

export const FADE_CURVES: readonly { value: FadeCurve; label: string }[] = [
  { value: 'smooth', label: '平滑' },
  { value: 'linear', label: '线性' },
  { value: 'exponential', label: '指数' },
];
const FADE_CURVE_IDS = FADE_CURVES.map((item) => item.value);

/* ---- 全局快捷键（Shortcuts v1，宿主注册结果走 bridge 的 shortcuts 事件） ---- */

/** 可配置的全局快捷键动作（与宿主 schema 的键名一致）。 */
export type ShortcutAction =
  | 'playPause'
  | 'prev'
  | 'next'
  | 'toggleWindow'
  | 'volumeUp'
  | 'volumeDown'
  | 'mute'
  | 'like'
  | 'mode'
  | 'mini'
  | 'desktopLyrics'
  | 'crossfade'
  | 'appOutput'
  | 'systemOutput';

export interface ShortcutsSettings {
  /** 全局开关：关闭后宿主注销全部组合。 */
  enabled: boolean;
  /** 系统媒体键（播放/暂停、上一首、下一首）是否始终由 Zilux2 接管。 */
  alwaysHandleMediaKeys: boolean;
  /** 空字符串表示该条不绑定。 */
  playPause: string;
  prev: string;
  next: string;
  toggleWindow: string;
  volumeUp: string;
  volumeDown: string;
  mute: string;
  like: string;
  mode: string;
  mini: string;
  desktopLyrics: string;
  crossfade: string;
  /** 本软件音频输出：在「跟随系统」与指定设备之间切换。 */
  appOutput: string;
  /** Windows 默认播放设备轮换（系统级，不影响本软件通道）。 */
  systemOutput: string;
}

/** 四条可配置的全局快捷键（顺序即设置页展示顺序）。 */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  'playPause',
  'prev',
  'next',
  'toggleWindow',
  'volumeUp',
  'volumeDown',
  'mute',
  'like',
  'mode',
  'mini',
  'desktopLyrics',
  'crossfade',
  'appOutput',
  'systemOutput',
];

/** 设置页展示用的标签与说明。 */
export const SHORTCUT_LABELS: Record<ShortcutAction, { label: string; hint: string }> = {
  playPause: { label: '播放 / 暂停', hint: '播放或暂停当前歌曲，应用在后台时也生效' },
  prev: { label: '上一首', hint: '切到当前播放队列的上一首' },
  next: { label: '下一首', hint: '切到当前播放队列的下一首' },
  toggleWindow: { label: '显示 / 隐藏窗口', hint: '窗口最小化到托盘后也能一键呼出' },
  volumeUp: { label: '音量加', hint: '每次 +5%，应用在后台也生效' },
  volumeDown: { label: '音量减', hint: '每次 −5%' },
  mute: { label: '静音 / 取消静音', hint: '和播放条上的音量键等效' },
  like: { label: '收藏当前歌曲', hint: '加入「我喜欢的音乐」；本地歌曲不支持' },
  mode: { label: '切换播放模式', hint: '列表循环 → 单曲循环 → 随机播放' },
  mini: { label: '迷你播放器', hint: '进入 / 退出迷你模式' },
  desktopLyrics: { label: '桌面歌词', hint: '开关独立歌词窗口' },
  crossfade: { label: '无缝衔接', hint: '临时开关自动过渡（与设置里的开关同步）' },
  appOutput: { label: '本软件输出', hint: '在「跟随系统」和设置里选定的播放设备之间切换' },
  systemOutput: { label: '系统输出轮换', hint: '切换 Windows 默认播放设备；参与轮换的设备在「系统音频」设置页勾选' },
};

/** 默认组合（与宿主 Shortcuts v1 schema 的默认值保持一致）。 */
export const SHORTCUT_DEFAULTS: ShortcutsSettings = {
  enabled: true,
  alwaysHandleMediaKeys: true,
  playPause: 'Ctrl+Alt+Space',
  prev: 'Ctrl+Alt+Left',
  next: 'Ctrl+Alt+Right',
  toggleWindow: 'Ctrl+Alt+Z',
  volumeUp: '',
  volumeDown: '',
  mute: '',
  like: '',
  mode: '',
  mini: '',
  desktopLyrics: '',
  crossfade: '',
  appOutput: '',
  systemOutput: '',
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
 * 校验并规范化快捷键串：`ctrl+alt+space` → `Ctrl+Alt+Space`，`a` → `A`。
 *
 * 规则（与宿主解析器一致）：
 * - 空串合法，表示「不绑定」；
 * - 可以只有 1 个主键（单键），也可以带任意个修饰键（Ctrl/Control/Alt/Shift/Win/Meta）；
 * - 主键白名单：A-Z、0-9、F1-F24、Space/Tab/Enter/Esc/Backspace/Delete/Insert/Home/End/PageUp/PageDown/Up/Down/Left/Right；
 * - 修饰键按 Ctrl → Alt → Shift → Win 顺序输出；非法串返回 fallback。
 */
export function normalizeShortcutBinding(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > 64) return fallback;
  const parts = trimmed.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return fallback;
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
  if (!key) return fallback;
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
    /** 启动画面主标题；空串回退 ZILUX2。 */
    splashTitle: string;
    /** 启动画面副标题；空串回退默认文案。 */
    splashSubtitle: string;
    startMaximized: boolean;
    /** 开机自启（HKCU Run）；关闭时启动即注销注册项。 */
    autoLaunch: boolean;
    /** 开机自启时不显示主界面（只驻留托盘）；手动打开仍正常显示。 */
    autoStartHidden: boolean;
    /** 监控本地曲库文件夹（新增/删除实时同步）；关闭后需手动重新扫描。 */
    watchLocalFolder: boolean;
    /** Windows 系统媒体控制（任务栏媒体弹窗/音量键旁卡片）。 */
    mediaSession: boolean;
    /** 桌面歌词独立窗口（无边框、置顶、可拖动）。 */
    desktopLyrics: boolean;
    /** 锁定后鼠标穿透；解锁后可拖动。 */
    desktopLyricsLocked: boolean;
    /** 主行字号，28..64（默认 40）。 */
    desktopLyricsFontSize: number;
    /** 主行粗细。 */
    desktopLyricsWeight: DesktopLyricsWeight;
    /** 胶囊底色不透明度百分比，30..90（默认 40）。 */
    desktopLyricsBackdropOpacity: number;
    desktopLyricsTopmost: boolean;
    /** 桌面背景歌词：把歌词页效果镜像到桌面壁纸层；开启期间软件内歌词页不显示歌词。 */
    backgroundLyrics: boolean;
    /** 「系统输出轮换」快捷键参与轮换的设备（端点 ID；空数组 = 全部活动设备）。 */
    systemOutputRotation: string[];
  };
  appearance: {
    theme: Theme;
    reduceMotion: boolean;
    glow: boolean;
    lyricsSize: LyricsSize;
    /** 窗口过渡：常规状态由 Windows 处理；custom 为关闭到托盘补整窗淡出。 */
    windowAnimation: WindowAnimation;
    /** 底部播放条常驻展开：开着时不再依赖鼠标悬停，播放条始终保持展开形态。 */
    playerBarExpanded: boolean;
    /** 迷你播放器尺寸预设。 */
    miniSize: MiniSize;
    /** 迷你播放器是否置顶。 */
    miniAlwaysOnTop: boolean;
  };
  playback: {
    defaultSource: OnlineSourceId;
    searchLimit: number;
    /** 空间里闲置（约 3 秒没动鼠标）且正在播放时，自动切到 3D 歌词界面，鼠标一动回磁贴 */
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
    /** 睡眠定时到点前的音量渐弱时长（秒，0..60；0 表示不渐弱）。 */
    sleepFadeSeconds: number;
    /** 睡眠定时到点后的动作：pause 暂停 / minimize 暂停并最小化 / exit 退出应用。 */
    sleepAction: SleepTimerAction;
    /** 本软件音频输出：system = 跟随 Windows 默认设备；device = 固定到 appOutputDeviceId。 */
    appOutputMode: AppOutputMode;
    /** 浏览器 setSinkId 用的设备 deviceId；mode=device 时生效。 */
    appOutputDeviceId: string;
  };
  shortcuts: ShortcutsSettings;
  downloads: {
    /** 下载目录；空字符串表示 Windows「音乐」目录。 */
    directory: string;
    /** 下载音质：standard=128k、high=320k、lossless=无损（平台/会员不支持时宿主自动降级）。 */
    quality: StreamQuality;
    /** 同时下载的任务数（1–4）；超出的任务会排队。 */
    maxConcurrent: number;
    /** 文件名模板：支持 {artist} {title} {id} {quality}。 */
    fileNameTemplate: string;
    /** 下载完成后自动打开文件所在文件夹。 */
    openFolderWhenDone: boolean;
  };
  updates: {
    /** 启动时自动检查 + 每 4 小时轮询 */
    autoCheck: boolean;
    /** auto=自动下载并在完成后提示安装；notify=只提示新版本与 Release 页 */
    mode: UpdateMode;
    /** 更新源 owner/repo；空字符串用编译期默认值 */
    repo: string;
    /** 检查更新/下载时直连 GitHub（绕过系统代理）；代理出口 IP 被限流时打开 */
    directConnection: boolean;
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
  general: { splash: true, splashTitle: 'ZILUX2', splashSubtitle: '新一代创意播放器', startMaximized: false, autoLaunch: false, autoStartHidden: true, watchLocalFolder: true, mediaSession: true, desktopLyrics: false, desktopLyricsLocked: false, desktopLyricsFontSize: 40, desktopLyricsWeight: 'normal', desktopLyricsBackdropOpacity: 40, desktopLyricsTopmost: true, backgroundLyrics: false, systemOutputRotation: [] },
  appearance: {
    theme: 'frost',
    reduceMotion: false,
    glow: true,
    lyricsSize: 'medium',
    windowAnimation: 'custom',
    playerBarExpanded: false,
    miniSize: 'standard',
    miniAlwaysOnTop: true,
  },
  playback: {
    defaultSource: 'netease',
    searchLimit: 20,
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
    sleepFadeSeconds: 15,
    sleepAction: 'pause',
    appOutputMode: 'system',
    appOutputDeviceId: '',
  },
  shortcuts: { ...SHORTCUT_DEFAULTS },
  downloads: { directory: '', quality: 'high', maxConcurrent: 2, fileNameTemplate: '{artist} - {title}', openFolderWhenDone: false },
  updates: { autoCheck: true, mode: 'auto', repo: '', directConnection: false },
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

export type SettingsChangeOrigin = 'load' | 'local' | 'host' | 'reset';

export interface SettingsChangeMeta {
  origin: SettingsChangeOrigin;
  previous: Settings;
}

type Listener = (settings: Settings, meta: SettingsChangeMeta) => void;

let current: Settings = clone(DEFAULT_SETTINGS);
const listeners = new Set<Listener>();
let localSaveTimer = 0;
let hostListenerBound = false;
let pendingHostResolve: ((settings: Settings) => void) | null = null;
/** 已发给宿主、但还没在宿主快照里回显的 patch：防止慢快照把本地刚改的值回滚。 */
let pendingHostPatches: SettingsPatch[] = [];

function settingsEqual(left: Settings, right: Settings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

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

function asFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.general.desktopLyricsFontSize;
  return Math.round(Math.min(64, Math.max(28, value)));
}

function asBackdropOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.general.desktopLyricsBackdropOpacity;
  return Math.round(Math.min(90, Math.max(30, value)));
}

function asEqGains(value: unknown): number[] {
  const source = Array.isArray(value) ? value : [];
  return EQ_BAND_FREQS.map((_, index) => {
    const raw = source[index];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
    return Math.round(Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, raw)));
  });
}

/** 设备 ID 数组（最多 32 项、每项 ≤512 字符、去重）；非数组回落空数组。 */
function asDeviceIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (result.length >= 32) break;
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text && text.length <= 512 && !result.includes(text)) result.push(text);
  }
  return result;
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
    alwaysHandleMediaKeys: asBool(
      value.alwaysHandleMediaKeys,
      SHORTCUT_DEFAULTS.alwaysHandleMediaKeys,
    ),
    playPause: normalizeShortcutBinding(value.playPause, SHORTCUT_DEFAULTS.playPause),
    volumeUp: normalizeShortcutBinding(value.volumeUp, ''),
    volumeDown: normalizeShortcutBinding(value.volumeDown, ''),
    mute: normalizeShortcutBinding(value.mute, ''),
    like: normalizeShortcutBinding(value.like, ''),
    mode: normalizeShortcutBinding(value.mode, ''),
    mini: normalizeShortcutBinding(value.mini, ''),
    desktopLyrics: normalizeShortcutBinding(value.desktopLyrics, ''),
    crossfade: normalizeShortcutBinding(value.crossfade, ''),
    prev: normalizeShortcutBinding(value.prev, SHORTCUT_DEFAULTS.prev),
    next: normalizeShortcutBinding(value.next, SHORTCUT_DEFAULTS.next),
    toggleWindow: normalizeShortcutBinding(value.toggleWindow, SHORTCUT_DEFAULTS.toggleWindow),
    appOutput: normalizeShortcutBinding(value.appOutput, ''),
    systemOutput: normalizeShortcutBinding(value.systemOutput, ''),
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
      splashTitle: typeof general.splashTitle === 'string'
        ? general.splashTitle.slice(0, 48)
        : DEFAULT_SETTINGS.general.splashTitle,
      splashSubtitle: typeof general.splashSubtitle === 'string'
        ? general.splashSubtitle.slice(0, 48)
        : DEFAULT_SETTINGS.general.splashSubtitle,
      startMaximized: asBool(general.startMaximized, DEFAULT_SETTINGS.general.startMaximized),
      autoLaunch: asBool(general.autoLaunch, DEFAULT_SETTINGS.general.autoLaunch),
      autoStartHidden: asBool(general.autoStartHidden, DEFAULT_SETTINGS.general.autoStartHidden),
      watchLocalFolder: asBool(general.watchLocalFolder, DEFAULT_SETTINGS.general.watchLocalFolder),
      mediaSession: asBool(general.mediaSession, DEFAULT_SETTINGS.general.mediaSession),
      desktopLyrics: asBool(general.desktopLyrics, DEFAULT_SETTINGS.general.desktopLyrics),
      desktopLyricsLocked: asBool(general.desktopLyricsLocked, DEFAULT_SETTINGS.general.desktopLyricsLocked),
      desktopLyricsFontSize: asFontSize(general.desktopLyricsFontSize),
      desktopLyricsWeight: asEnum(general.desktopLyricsWeight, ['normal', 'semibold', 'bold'], DEFAULT_SETTINGS.general.desktopLyricsWeight),
      desktopLyricsBackdropOpacity: asBackdropOpacity(general.desktopLyricsBackdropOpacity),
      desktopLyricsTopmost: asBool(general.desktopLyricsTopmost, DEFAULT_SETTINGS.general.desktopLyricsTopmost),
      backgroundLyrics: asBool(general.backgroundLyrics, DEFAULT_SETTINGS.general.backgroundLyrics),
      systemOutputRotation: asDeviceIdList(general.systemOutputRotation),
    },
    appearance: {
      theme: asEnum(appearance.theme, THEMES, DEFAULT_SETTINGS.appearance.theme),
      reduceMotion: asBool(appearance.reduceMotion, DEFAULT_SETTINGS.appearance.reduceMotion),
      glow: asBool(appearance.glow, DEFAULT_SETTINGS.appearance.glow),
      lyricsSize: asEnum(appearance.lyricsSize, LYRICS_SIZES, DEFAULT_SETTINGS.appearance.lyricsSize),
      windowAnimation: asEnum(appearance.windowAnimation, WINDOW_ANIMATIONS, DEFAULT_SETTINGS.appearance.windowAnimation),
      playerBarExpanded: asBool(appearance.playerBarExpanded, DEFAULT_SETTINGS.appearance.playerBarExpanded),
      miniSize: asEnum(appearance.miniSize, MINI_SIZES, DEFAULT_SETTINGS.appearance.miniSize),
      miniAlwaysOnTop: asBool(appearance.miniAlwaysOnTop, DEFAULT_SETTINGS.appearance.miniAlwaysOnTop),
    },
    playback: {
      defaultSource:
        typeof playback.defaultSource === 'string' && playback.defaultSource
          ? playback.defaultSource
          : DEFAULT_SETTINGS.playback.defaultSource,
      searchLimit: asLimit(playback.searchLimit),
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
      sleepFadeSeconds: SLEEP_FADE_SECONDS_CHOICES.includes(Math.round(Number(playback.sleepFadeSeconds)))
        ? Math.round(Number(playback.sleepFadeSeconds))
        : DEFAULT_SETTINGS.playback.sleepFadeSeconds,
      sleepAction: asEnum(playback.sleepAction, SLEEP_TIMER_ACTION_IDS, DEFAULT_SETTINGS.playback.sleepAction),
      appOutputMode: asEnum(playback.appOutputMode, APP_OUTPUT_MODES, DEFAULT_SETTINGS.playback.appOutputMode),
      appOutputDeviceId:
        typeof playback.appOutputDeviceId === 'string' && playback.appOutputDeviceId.length <= 512
          ? playback.appOutputDeviceId.trim()
          : DEFAULT_SETTINGS.playback.appOutputDeviceId,
    },
    shortcuts: asShortcuts(shortcuts),
    downloads: {
      directory: typeof downloads.directory === 'string' ? downloads.directory.trim() : '',
      quality: asEnum(downloads.quality, STREAM_QUALITIES, DEFAULT_SETTINGS.downloads.quality),
      maxConcurrent:
        typeof downloads.maxConcurrent === 'number' && downloads.maxConcurrent >= 1 && downloads.maxConcurrent <= 4
          ? Math.round(downloads.maxConcurrent)
          : DEFAULT_SETTINGS.downloads.maxConcurrent,
      fileNameTemplate: (() => {
        const template = typeof downloads.fileNameTemplate === 'string' ? downloads.fileNameTemplate.trim() : '';
        const hasToken = /\{(artist|title|id|quality)\}/.test(template);
        return template && template.length <= 120 && hasToken ? template : DEFAULT_SETTINGS.downloads.fileNameTemplate;
      })(),
      openFolderWhenDone: asBool(downloads.openFolderWhenDone, DEFAULT_SETTINGS.downloads.openFolderWhenDone),
    },
    updates: {
      autoCheck: asBool(updates.autoCheck, DEFAULT_SETTINGS.updates.autoCheck),
      mode: asEnum(updates.mode, UPDATE_MODES, DEFAULT_SETTINGS.updates.mode),
      repo: typeof updates.repo === 'string' ? updates.repo.trim() : '',
      directConnection: asBool(updates.directConnection, DEFAULT_SETTINGS.updates.directConnection),
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

/** 应用设置到文档（歌词字号/减少动效/光晕/播放条）并广播；origin 供界面判断是否需要整体回读。 */
export function applySettings(next: Settings, origin: SettingsChangeOrigin = 'local'): void {
  const previous = current;
  current = next;
  const root = document.documentElement;
  // 主题只由 ui/theme.ts 写 data-theme：这里再写一次会把 theme.ts 写入的 light/dark
  // 覆盖成设置里的 'frost'，让 :root[data-theme='light'] 样式与 color-scheme 全部失效。
  root.dataset.lyricsSize = next.appearance.lyricsSize;
  root.classList.toggle('reduce-motion', next.appearance.reduceMotion);
  root.classList.toggle('no-glow', !next.appearance.glow);
  root.classList.toggle('is-pb-expanded', next.appearance.playerBarExpanded);
  // 值没变化时不广播：宿主对本地 patch 的回执快照不会把已渲染的控件再刷一遍。
  if (!settingsEqual(previous, next)) {
    listeners.forEach((listener) => listener(next, { origin, previous }));
  }
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
    const state = pendingHostPatches.length > 0 ? applyPendingPatches(next) : next;
    applySettings(state, 'host');
    pendingHostResolve?.(state);
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

  // 契约：宿主 900 ms 内没回快照时用默认值启动；只有确认没有宿主时才读本地镜像。
  const state = raw
    ? normalizeSettings(raw)
    : hostAvailable()
      ? clone(DEFAULT_SETTINGS)
      : readLocal();
  // 旧宿主快照没有 shortcuts 段时，优先保留本地镜像里的快捷键配置。
  if (raw && !hasShortcutsSection(raw)) {
    state.shortcuts = { ...readLocal().shortcuts };
  }
  applySettings(state, 'load');
  return state;
}

function mergePatch(base: Settings, patch: SettingsPatch): Settings {
  return {
    version: 1,
    general: { ...base.general, ...patch.general },
    appearance: { ...base.appearance, ...patch.appearance },
    playback: { ...base.playback, ...patch.playback },
    shortcuts: { ...base.shortcuts, ...patch.shortcuts },
    downloads: { ...base.downloads, ...patch.downloads },
    updates: { ...base.updates, ...patch.updates },
  };
}

/** 把尚未回显的本地 patch 叠加到宿主快照上；快照已经包含的 patch 直接淘汰。 */
function applyPendingPatches(snapshot: Settings): Settings {
  if (pendingHostPatches.length === 0) return snapshot;
  const remaining: SettingsPatch[] = [];
  let merged = snapshot;
  for (const patch of pendingHostPatches) {
    const next = mergePatch(merged, patch);
    // 宿主可能拒绝了非法值并在快照里回落到合法值；按归一化后的结果判断，
    // 否则同一条会被无限重放。
    const normalized = normalizeSettings(next);
    if (settingsEqual(merged, normalized)) continue;
    remaining.push(patch);
    merged = normalized;
  }
  pendingHostPatches = remaining;
  return remaining.length > 0 ? normalizeSettings(merged) : snapshot;
}

/** 局部更新：立即应用；宿主在线走宿主持久化，否则写 localStorage 镜像。 */
export function patchSettings(patch: SettingsPatch): Settings {
  const merged = mergePatch(current, patch);
  const next = normalizeSettings(merged);
  if (hostAvailable()) pendingHostPatches.push(patch);
  applySettings(next, 'local');
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
  pendingHostPatches = [];
  applySettings(next, 'reset');
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

