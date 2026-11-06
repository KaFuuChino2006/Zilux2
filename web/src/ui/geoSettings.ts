/**
 * 歌词页「播放效果 · 几何」的可调参数模型（v2 · 凝彩）。
 *
 * 和「房间」「唱片」两档一样：一份扁平对象 + 默认值 + 归一化 + localStorage 持久化，
 * 设置面板（ui/geoSettingsPanel.ts）直接在这份模型上改，场景引擎（ui/geoScene.ts）通过 setStyle() 接整份配置。
 *
 * 「几何」现在是连续的凝彩画面：流动色场 + 辉光歌词，取景只有「居中 / 左倾 / 右倾 / 内收」
 * 四种轻微变化，换句时旧字飘散、新字升起，不再整块硬切。
 *
 * 约定：所有颜色都是 `#rrggbb`；角度用「度」，位移/尺寸用相对画面宽高的比例（0~1）。
 */

/** 配色预设：整组换掉底色、油墨、强调色与副色。 */
export type GeoPalette = 'mono' | 'prism' | 'ember' | 'lagoon' | 'pearl' | 'noir' | 'night' | 'paper' | 'acid' | 'riso';

/** 构图模板：auto 表示按曲目种子自动轮换。 */
export type GeoLayoutId = 'auto' | 'band' | 'split' | 'poster' | 'frame';

/** 副色在背景里的浓度：off 关掉、soft 当前观感、strong 更浓。 */
export type GeoAccentWash = 'off' | 'soft' | 'strong';

/** 除 auto 之外真正会被用到的模板（场景里按这个列表取样）。 */
export const GEO_LAYOUTS: ReadonlyArray<Exclude<GeoLayoutId, 'auto'>> = [
  'band',
  'split',
  'poster',
  'frame',
];

export interface GeoStyleSettings {
  /* ── 配色 ─────────────────────────────────── */
  /** 一键配色：切换会整组覆盖底色/油墨/强调/副色（其它参数不动）。 */
  palette: GeoPalette;
  /** 底色渐变的两端。 */
  bgTop: string;
  bgBottom: string;
  bgAngle: number;
  /** 油墨（未被唱到的字、细线、标记）。 */
  ink: string;
  /** 已唱过字的落色（保留字段，现由强调色渐变接管）。 */
  sungInk: string;
  /** 强调色：正在唱的字、色场主光团。 */
  accent: string;
  /** 副色：第二团光、色场冷端。 */
  secondary: string;
  /** 强调色与副色跟随快捷设置里的「歌词颜色」（纯色 / 封面色 / 自动渐变）。 */
  followLyrics: boolean;

  /* ── 字形 ─────────────────────────────────── */
  /** 字族：display=系统重字，yahei=雅黑，serif=衬线，mono=等宽。 */
  fontFamily: 'display' | 'mono' | 'serif' | 'yahei';
  fontWeight: 700 | 900;
  /** 字号整体缩放（1 = 当前观感）。 */
  sizeScale: number;
  /** 字距（em）。 */
  letterSpacing: number;
  /** 当前句下方显示译文。 */
  showTranslation: boolean;

  /* ── 构图与动效 ───────────────────────────── */
  /** 取景：居中 / 左倾 / 右倾 / 内收，或 auto 逐句轮换。 */
  layout: GeoLayoutId;
  /** 换句动效速度（0.5 = 慢、1 = 默认、2 = 快）。 */
  flow: number;
  /** 逐字浮起的时长（毫秒）：一个字从底稿亮起来要多久。 */
  revealMs: number;
  /** 随音乐低频呼吸的强度。 */
  energy: number;
  /** 几何层强度（块面 / 点阵 / 圆环 / 弧线的存在感与运动幅度），0 = 只留文字与色场。 */
  geometry: number;
  /** 背景相机与空气墨团的运动幅度（0 = 背景钉住不动）。 */
  bgMotion: number;

  /* ── 肌理与版面元素 ───────────────────────── */
  /** 网点/半调覆盖强度 0~1（0 = 完全没有）。 */
  halftone: number;
  /** 胶片颗粒强度 0~1。 */
  grain: number;
  /** 细网格 / 十字线强度 0~1。 */
  grid: number;
  /** 四角裁切标记。 */
  marks: boolean;
  /** 时间码与底部进度条。 */
  meta: boolean;
  /** 副色在背景里的浓度：交给场景决定第二色光团与冷端色场的铺开程度。 */
  accentWash: GeoAccentWash;
  /** 渲染像素比上限 1~2。 */
  dpr: number;
}

/** 默认值 = 现在的「凝彩」观感，改默认只动这里。 */
export const DEFAULT_GEO_SETTINGS: GeoStyleSettings = {
  palette: 'mono',
  bgTop: '#111111',
  bgBottom: '#1b1b1b',
  bgAngle: 160,
  ink: '#f4f1e8',
  sungInk: '#ffffff',
  accent: '#f4f1e8',
  secondary: '#0c0c0c',
  followLyrics: true,

  fontFamily: 'display',
  fontWeight: 900,
  sizeScale: 1,
  letterSpacing: 0.015,
  showTranslation: true,

  layout: 'auto',
  flow: 1,
  revealMs: 320,
  energy: 1,
  geometry: 1,
  bgMotion: 1,

  halftone: 0.16,
  grain: 0.05,
  grid: 0,
  marks: true,
  meta: false,
  accentWash: 'soft',
  dpr: 1.75,
};

/** v2 存档键：旧版印刷版几何的观感不再复用，只迁移字体/动效偏好。 */
export const GEO_SETTINGS_KEY = 'zilux2.geoStyle.v2';
const LEGACY_GEO_SETTINGS_KEY = 'zilux2.geoStyle';

/** 一键配色预设：只覆盖颜色字段，构图与动效保持当前值。 */
export interface GeoPalettePreset {
  id: GeoPalette;
  label: string;
  hint: string;
  patch: Pick<GeoStyleSettings, 'bgTop' | 'bgBottom' | 'bgAngle' | 'ink' | 'sungInk' | 'accent' | 'secondary'>;
}

export const GEO_PALETTE_PRESETS: ReadonlyArray<GeoPalettePreset> = [
  {
    id: 'mono',
    label: '黑白',
    hint: '黑白灰三色 + 纸感颗粒：把画面压成只有版式、字重与块面关系的单色海报',
    patch: {
      bgTop: '#111111',
      bgBottom: '#1b1b1b',
      bgAngle: 160,
      ink: '#f4f1e8',
      sungInk: '#ffffff',
      accent: '#f4f1e8',
      secondary: '#0c0c0c',
    },
  },
  {
    id: 'prism',
    label: '凝彩',
    hint: '深靛底 + 洋红与青蓝两团流光 + 近白字：默认的凝彩观感，像颜料在水里缓慢化开',
    patch: {
      bgTop: '#07060f',
      bgBottom: '#120a1e',
      bgAngle: 158,
      ink: '#f4efff',
      sungInk: '#ffffff',
      accent: '#ff4d9d',
      secondary: '#46e0ff',
    },
  },
  {
    id: 'ember',
    label: '余烬',
    hint: '近黑底 + 橙红与琥珀金：暖调的余烬与火光',
    patch: {
      bgTop: '#0b0506',
      bgBottom: '#1b0908',
      bgAngle: 150,
      ink: '#ffeede',
      sungInk: '#fff8f0',
      accent: '#ff6a3d',
      secondary: '#ffc857',
    },
  },
  {
    id: 'lagoon',
    label: '湖光',
    hint: '深海绿底 + 薄荷与钴蓝：冷调的湖面反光',
    patch: {
      bgTop: '#03121a',
      bgBottom: '#041b26',
      bgAngle: 200,
      ink: '#e8fbff',
      sungInk: '#ffffff',
      accent: '#3ff0c8',
      secondary: '#3d7dff',
    },
  },
  {
    id: 'pearl',
    label: '珍珠',
    hint: '米白珠光底 + 莓红与靛蓝字：明亮但不刺眼的一档',
    patch: {
      bgTop: '#f7f3ec',
      bgBottom: '#e3dff0',
      bgAngle: 172,
      ink: '#171222',
      sungInk: '#0b0910',
      accent: '#ff4f7a',
      secondary: '#5a63ff',
    },
  },
  {
    id: 'noir',
    label: '墨白',
    hint: '纯黑底 + 冷白字 + 一点灰蓝：最安静的一档，像老电影的片头',
    patch: {
      bgTop: '#050507',
      bgBottom: '#0c0d12',
      bgAngle: 160,
      ink: '#e8e8ee',
      sungInk: '#ffffff',
      accent: '#c9c9d6',
      secondary: '#5b6b8c',
    },
  },
  {
    id: 'night',
    label: '暗夜',
    hint: '近黑底 + 暖白油墨 + 橙红强调 + 深青副色：最早那版印刷感',
    patch: {
      bgTop: '#0a0b0e',
      bgBottom: '#171a21',
      bgAngle: 158,
      ink: '#f3efe6',
      sungInk: '#f3efe6',
      accent: '#ff5a3c',
      secondary: '#1c6f8a',
    },
  },
  {
    id: 'paper',
    label: '纸本',
    hint: '米色纸本 + 黑墨 + 朱红 + 墨绿：像一本印刷册子的内页',
    patch: {
      bgTop: '#efe8d8',
      bgBottom: '#dcd2bd',
      bgAngle: 172,
      ink: '#14120e',
      sungInk: '#0c0b09',
      accent: '#e2381c',
      secondary: '#2d5a4a',
    },
  },
  {
    id: 'acid',
    label: '酸绿',
    hint: '荧光底 + 纯黑字 + 洋红块 + 深紫副色：最刺眼的一档，适合快歌',
    patch: {
      bgTop: '#d7ff1f',
      bgBottom: '#bfe800',
      bgAngle: 140,
      ink: '#0b0b0b',
      sungInk: '#0b0b0b',
      accent: '#ff2f6d',
      secondary: '#3a1d6b',
    },
  },
  {
    id: 'riso',
    label: '孔版',
    hint: '本白纸 + 黑字 + 朱红 + 宝蓝：Riso 孔版两色套印的味道',
    patch: {
      bgTop: '#f6f1e6',
      bgBottom: '#e7e0d1',
      bgAngle: 165,
      ink: '#1a1a1a',
      sungInk: '#111111',
      accent: '#ff4d2e',
      secondary: '#2f6bff',
    },
  },
];

/** 构图模板的中文名（面板里显示用）。 */
export const GEO_LAYOUT_LABELS: Record<Exclude<GeoLayoutId, 'auto'>, string> = {
  band: '居中',
  split: '左倾',
  poster: '右倾',
  frame: '内收',
};

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

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

const PALETTES: ReadonlyArray<GeoPalette> = ['prism', 'ember', 'lagoon', 'pearl', 'noir', 'night', 'paper', 'acid', 'riso'];
const ACCENT_WASHES: ReadonlyArray<GeoAccentWash> = ['off', 'soft', 'strong'];

/**
 * 把任意持久化内容归一化成一组合法设置（旧版本缺字段时回落到默认值）。
 * 旧版印刷几何的 rotation / slam / misprint / ghostA / ghostB 等字段直接丢弃。
 */
export function normalizeGeoSettings(raw: unknown): GeoStyleSettings {
  const d = DEFAULT_GEO_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d };
  const src = raw as Record<string, unknown>;
  return {
    palette: pick(src.palette, PALETTES, d.palette),
    bgTop: hex(src.bgTop, d.bgTop),
    bgBottom: hex(src.bgBottom, d.bgBottom),
    bgAngle: num(src.bgAngle, d.bgAngle, 0, 360),
    ink: hex(src.ink, d.ink),
    sungInk: hex(src.sungInk, d.sungInk),
    accent: hex(src.accent, d.accent),
    secondary: hex(src.secondary, d.secondary),
    followLyrics: bool(src.followLyrics, d.followLyrics),

    fontFamily: pick(src.fontFamily, ['display', 'mono', 'serif', 'yahei'], d.fontFamily),
    fontWeight: pick(src.fontWeight, [700, 900], d.fontWeight),
    sizeScale: num(src.sizeScale, d.sizeScale, 0.5, 2),
    letterSpacing: num(src.letterSpacing, d.letterSpacing, -0.08, 0.3),
    showTranslation: bool(src.showTranslation, d.showTranslation),

    layout: pick(src.layout, ['auto', ...GEO_LAYOUTS], d.layout),
    flow: num(src.flow, d.flow, 0.3, 2.5),
    revealMs: num(src.revealMs, d.revealMs, 0, 600),
    energy: num(src.energy, d.energy, 0, 2),
    geometry: num(src.geometry, d.geometry, 0, 1.6),
    bgMotion: num(src.bgMotion, d.bgMotion, 0, 2),

    halftone: num(src.halftone, d.halftone, 0, 1),
    grain: num(src.grain, d.grain, 0, 0.4),
    grid: num(src.grid, d.grid, 0, 1),
    marks: bool(src.marks, d.marks),
    meta: bool(src.meta, d.meta),
    accentWash: pick(src.accentWash, ACCENT_WASHES, d.accentWash),
    dpr: num(src.dpr, d.dpr, 1, 2),
  };
}

/** 旧版印刷几何只迁移字体与动效偏好，颜色/肌理回到新的凝彩默认。 */
function migrateLegacy(raw: unknown): GeoStyleSettings {
  const migrated = normalizeGeoSettings(raw);
  return {
    ...DEFAULT_GEO_SETTINGS,
    fontFamily: migrated.fontFamily,
    fontWeight: migrated.fontWeight,
    sizeScale: migrated.sizeScale,
    letterSpacing: migrated.letterSpacing,
    showTranslation: migrated.showTranslation,
    followLyrics: migrated.followLyrics,
    flow: migrated.flow,
    revealMs: migrated.revealMs,
    energy: migrated.energy,
    geometry: migrated.geometry,
    bgMotion: migrated.bgMotion,
    accentWash: migrated.accentWash,
    dpr: migrated.dpr,
  };
}

/** 当前保存的几何设置（读不出来就给默认值；旧存档迁移一次）。 */
export function geoStyleSettings(): GeoStyleSettings {
  try {
    const raw = window.localStorage.getItem(GEO_SETTINGS_KEY);
    if (raw) return normalizeGeoSettings(JSON.parse(raw));
    const legacy = window.localStorage.getItem(LEGACY_GEO_SETTINGS_KEY);
    if (legacy) return migrateLegacy(JSON.parse(legacy));
  } catch {
    // 读不到就走默认
  }
  return { ...DEFAULT_GEO_SETTINGS };
}

/** 写入本机并返回归一化后的那份。 */
export function saveGeoStyleSettings(settings: GeoStyleSettings): GeoStyleSettings {
  const normalized = normalizeGeoSettings(settings);
  try {
    window.localStorage.setItem(GEO_SETTINGS_KEY, JSON.stringify(normalized));
  } catch {
    // 存储不可用时本次仍生效，只是不持久
  }
  return normalized;
}

/** 套用配色预设（只改颜色字段）。 */
export function applyGeoPalette(draft: GeoStyleSettings, preset: GeoPalettePreset): GeoStyleSettings {
  return { ...draft, palette: preset.id, ...preset.patch };
}

/** 这份设置是否正好等于某个配色预设（面板里高亮用）。 */
export function geoPaletteMatches(settings: GeoStyleSettings, preset: GeoPalettePreset): boolean {
  return (Object.keys(preset.patch) as Array<keyof typeof preset.patch>).every(
    (key) => String(settings[key]).toLowerCase() === String(preset.patch[key]).toLowerCase(),
  );
}
