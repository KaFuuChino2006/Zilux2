/**
 * 歌词页「播放效果 · 唱片」的可调参数模型。
 *
 * 和「房间」档的 roomSettings.ts 同一套约定：一份扁平对象 + 默认值 + 归一化 +
 * localStorage 持久化。设置面板（ui/vinylSettingsPanel.ts）直接在这份模型上改，
 * 场景引擎（ui/vinylScene.ts）通过 setStyle() 接收整份配置。
 *
 * 默认观感：暖褐色聆听室 + 33⅓ 转黑胶 + 黄铜唱臂，歌词压在唱片下方的暖白大字。
 * 约定：颜色一律 `#rrggbb`；discSize 是「唱片半径 / 画面短边」的比例。
 */

export interface VinylStyleSettings {
  /* ── 歌词文字 ─────────────────────────────── */
  /** 字体：display=系统重字，yahei=微软雅黑，serif=衬线，system=自带字体。 */
  fontFamily: 'display' | 'yahei' | 'serif' | 'system';
  fontWeight: 400 | 700 | 900;
  /** 字号整体缩放（1 = 当前观感）。 */
  sizeScale: number;
  /** 字距（em）。 */
  letterSpacing: number;
  /** 未唱 / 唱过 / 正在唱 的颜色。 */
  color: string;
  sungColor: string;
  activeColor: string;
  /** 正在唱那句的辉光颜色与强度（0 关闭）。 */
  glowColor: string;
  glow: number;
  /** 重点词单独染色。 */
  keywordColors: boolean;
  /** 当前句下方显示翻译。 */
  showTranslation: boolean;
  /** 第一句歌词开口前，在唱片前方显示歌名卡。 */
  introTitle: boolean;
  /** 三态不透明度。 */
  unsungOpacity: number;
  sungOpacity: number;
  activeOpacity: number;

  /* ── 唱片本体 ─────────────────────────────── */
  /** 唱片半径占画面短边的比例。 */
  discSize: number;
  /** 唱片圆心横向位置（占画面宽）。 */
  discX: number;
  /** 唱片圆心纵向位置（占画面高）。 */
  discY: number;
  /** 黑胶盘面主色。 */
  discColor: string;
  /** 中心贴纸颜色。 */
  labelColor: string;
  /** 黄铜/金属强调色（唱臂、进度、贴纸描边）。 */
  accentColor: string;
  /** 中心贴纸半径 / 唱片半径。 */
  labelSize: number;
  /** 贴纸上写歌名与歌手。 */
  labelText: boolean;
  /** 纹路强度（0 = 光滑盘面）。 */
  grooveStrength: number;
  /** 盘面反光/高光强度。 */
  sheen: number;
  /** 漂浮尘埃数量。 */
  dust: number;
  /** 尘埃漂移速度倍数。 */
  dustSpeed: number;
  /** 颗粒噪点强度 0~1。 */
  grain: number;
  /** 暗角强度 0~1。 */
  vignette: number;
  /** 顶部暖光强度。 */
  spotGlow: number;
  bgTop: string;
  bgBottom: string;
  /** 贴纸与强调色跟随快捷设置里的「歌词颜色」。 */
  bgFollowLyrics: boolean;

  /* ── 布局 ─────────────────────────────────── */
  /** 当前句歌词的纵向位置（占画面高）。 */
  lyricY: number;
  /** 歌词最大宽度（占画面宽）。 */
  lyricWidth: number;
  /** 同时显示前后各几句（0 = 只看当前句）。 */
  neighborLines: 0 | 1 | 2;
  /** 画面底部显示歌名/歌手/进度条。 */
  showInfo: boolean;

  /* ── 唱臂与动效 ───────────────────────────── */
  /** 显示唱臂。 */
  showArm: boolean;
  /** 转速（RPM，黑胶标准 33.33）。 */
  rpm: number;
  /** 暂停时抬起唱臂。 */
  armLiftOnPause: boolean;
  /** 随音乐低频的轻微起伏。 */
  energy: number;
  /** 渲染像素比上限 1~2。 */
  dpr: number;
}

/** 默认值 = 唱片档的设计观感，改默认只动这里。 */
export const DEFAULT_VINYL_SETTINGS: VinylStyleSettings = {
  fontFamily: 'display',
  fontWeight: 900,
  sizeScale: 1,
  letterSpacing: 0.012,
  color: '#f2e7d8',
  sungColor: '#fff8ec',
  activeColor: '#ffe9c2',
  glowColor: '#ffcf8a',
  glow: 0.9,
  keywordColors: true,
  showTranslation: true,
  introTitle: true,
  unsungOpacity: 0.34,
  sungOpacity: 0.86,
  activeOpacity: 1,

  discSize: 0.3,
  discX: 0.5,
  discY: 0.36,
  discColor: '#171310',
  labelColor: '#e8d4ae',
  accentColor: '#c9a068',
  labelSize: 0.37,
  labelText: true,
  grooveStrength: 0.6,
  sheen: 0.55,
  dust: 26,
  dustSpeed: 1,
  grain: 0.055,
  vignette: 0.52,
  spotGlow: 0.5,
  bgTop: '#1d1713',
  bgBottom: '#090807',
  bgFollowLyrics: true,

  lyricY: 0.685,
  lyricWidth: 0.86,
  neighborLines: 1,
  showInfo: true,

  showArm: true,
  rpm: 33.33,
  armLiftOnPause: true,
  energy: 1,
  dpr: 1.75,
};

export const VINYL_SETTINGS_KEY = 'zilux2.vinylStyle';

/** 一键预设：只换整体配色与氛围，其它参数保持当前值。 */
export interface VinylStylePreset {
  id: string;
  label: string;
  patch: Partial<VinylStyleSettings>;
}

export const VINYL_STYLE_PRESETS: ReadonlyArray<VinylStylePreset> = [
  {
    id: 'vinyl',
    label: '黑胶',
    patch: {},
  },
  {
    id: 'midnight',
    label: '午夜',
    patch: {
      bgTop: '#10151d',
      bgBottom: '#06080c',
      discColor: '#101318',
      labelColor: '#b9c9dc',
      accentColor: '#8ea8c4',
      glowColor: '#a9c7ff',
      discSize: 0.31,
      sheen: 0.6,
      vignette: 0.58,
    },
  },
  {
    id: 'wine',
    label: '酒红',
    patch: {
      bgTop: '#22100f',
      bgBottom: '#0b0505',
      discColor: '#1a0f0e',
      labelColor: '#e9c9b0',
      accentColor: '#c98a63',
      glowColor: '#ffb27d',
      vignette: 0.55,
    },
  },
  {
    id: 'cream',
    label: '奶油',
    patch: {
      bgTop: '#2b241b',
      bgBottom: '#120f0b',
      discColor: '#1c1712',
      labelColor: '#f1e4c6',
      accentColor: '#d8b27a',
      glowColor: '#ffe6b0',
      spotGlow: 0.42,
      vignette: 0.46,
    },
  },
];

/* ── 归一化工具 ─────────────────────────────────────────────── */

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function num(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

function hex(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`.toLowerCase();
  }
  return fallback;
}

function pick<T extends string | number>(raw: unknown, options: ReadonlyArray<T>, fallback: T): T {
  return options.includes(raw as T) ? (raw as T) : fallback;
}

/** 把任意持久化内容归一化成一组合法设置（旧版本缺字段时回落到默认值）。 */
export function normalizeVinylSettings(raw: unknown): VinylStyleSettings {
  const d = DEFAULT_VINYL_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d };
  const src = raw as Record<string, unknown>;
  return {
    fontFamily: pick(src.fontFamily, ['display', 'yahei', 'serif', 'system'], d.fontFamily),
    fontWeight: pick(src.fontWeight, [400, 700, 900], d.fontWeight),
    sizeScale: num(src.sizeScale, d.sizeScale, 0.6, 1.8),
    letterSpacing: num(src.letterSpacing, d.letterSpacing, -0.05, 0.2),
    color: hex(src.color, d.color),
    sungColor: hex(src.sungColor, d.sungColor),
    activeColor: hex(src.activeColor, d.activeColor),
    glowColor: hex(src.glowColor, d.glowColor),
    glow: num(src.glow, d.glow, 0, 2),
    keywordColors: bool(src.keywordColors, d.keywordColors),
    showTranslation: bool(src.showTranslation, d.showTranslation),
    introTitle: bool(src.introTitle, d.introTitle),
    unsungOpacity: num(src.unsungOpacity, d.unsungOpacity, 0, 1),
    sungOpacity: num(src.sungOpacity, d.sungOpacity, 0, 1),
    activeOpacity: num(src.activeOpacity, d.activeOpacity, 0, 1),

    discSize: num(src.discSize, d.discSize, 0.12, 1.8),
    discX: num(src.discX, d.discX, 0.3, 0.7),
    discY: num(src.discY, d.discY, 0.22, 0.55),
    discColor: hex(src.discColor, d.discColor),
    labelColor: hex(src.labelColor, d.labelColor),
    accentColor: hex(src.accentColor, d.accentColor),
    labelSize: num(src.labelSize, d.labelSize, 0.24, 0.48),
    labelText: bool(src.labelText, d.labelText),
    grooveStrength: num(src.grooveStrength, d.grooveStrength, 0, 1),
    sheen: num(src.sheen, d.sheen, 0, 1),
    dust: Math.round(num(src.dust, d.dust, 0, 70)),
    dustSpeed: num(src.dustSpeed, d.dustSpeed, 0.2, 3),
    grain: num(src.grain, d.grain, 0, 1),
    vignette: num(src.vignette, d.vignette, 0, 1),
    spotGlow: num(src.spotGlow, d.spotGlow, 0, 1),
    bgTop: hex(src.bgTop, d.bgTop),
    bgBottom: hex(src.bgBottom, d.bgBottom),
    bgFollowLyrics: bool(src.bgFollowLyrics, d.bgFollowLyrics),

    lyricY: num(src.lyricY, d.lyricY, 0.52, 0.86),
    lyricWidth: num(src.lyricWidth, d.lyricWidth, 0.5, 1),
    neighborLines: pick(src.neighborLines, [0, 1, 2], d.neighborLines),
    showInfo: bool(src.showInfo, d.showInfo),

    showArm: bool(src.showArm, d.showArm),
    rpm: num(src.rpm, d.rpm, 20, 45),
    armLiftOnPause: bool(src.armLiftOnPause, d.armLiftOnPause),
    energy: num(src.energy, d.energy, 0, 2),
    dpr: num(src.dpr, d.dpr, 1, 2),
  };
}

let cached: VinylStyleSettings | null = null;

/** 读取本机持久化的唱片设置（首次读 localStorage，之后走内存缓存）。 */
export function vinylStyleSettings(): VinylStyleSettings {
  if (cached) return cached;
  let raw: unknown = null;
  try {
    const text = window.localStorage.getItem(VINYL_SETTINGS_KEY);
    if (text) raw = JSON.parse(text) as unknown;
  } catch {
    raw = null;
  }
  cached = normalizeVinylSettings(raw);
  return cached;
}

/** 保存唱片设置（更新内存缓存；调用方再广播给已打开的场景）。 */
export function saveVinylStyleSettings(next: VinylStyleSettings): VinylStyleSettings {
  const normalized = normalizeVinylSettings(next);
  cached = normalized;
  try {
    window.localStorage.setItem(VINYL_SETTINGS_KEY, JSON.stringify(normalized));
  } catch {
    /* 存不下就只用内存值 */
  }
  return normalized;
}

/** 把某个预设合进当前设置。 */
export function applyVinylPreset(base: VinylStyleSettings, preset: VinylStylePreset): VinylStyleSettings {
  return normalizeVinylSettings({ ...base, ...preset.patch });
}

/** 当前设置是否正好套着某个预设（用于 chips 高亮）。 */
export function vinylPresetMatches(base: VinylStyleSettings, preset: VinylStylePreset): boolean {
  const patch = preset.patch;
  return (Object.keys(patch) as Array<keyof VinylStyleSettings>).every((key) => {
    const want = patch[key];
    if (typeof want === 'number') return Math.abs((base[key] as number) - want) <= 1e-6;
    if (typeof want === 'boolean') return base[key] === want;
    return base[key] === want;
  });
}
