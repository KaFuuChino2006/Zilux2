/**
 * 歌词页「播放效果 · 几何」的可调参数模型。
 *
 * 和「房间」「唱片」两档一样：一份扁平对象 + 默认值 + 归一化 + localStorage 持久化，
 * 设置面板（ui/geoSettingsPanel.ts）直接在这份模型上改，场景引擎（ui/geoScene.ts）通过 setStyle() 接整份配置。
 *
 * 「几何」做的是连贯的文字 PV 画面：歌词被切成若干段（shot），每段一套大色块构图
 *（横条 / 分割 / 版心 / 画框），相邻段沿同一个镜头方向（flowAngle）无缝接力——
 * 上一段继续往那个方向推出画面、下一段从反方向飘进来，画面始终在动，不硬切。
 * 每个字随演唱从 flowAngle 的反方向逐个飘入、落位，唱完后缓缓向外松开字距。
 *
 * 约定：所有颜色都是 `#rrggbb`；角度用「度」，位移/尺寸用相对画面宽高的比例（0~1）。
 */

/** 配色预设：整组换掉底色、油墨、强调色与副色。 */
export type GeoPalette = 'night' | 'paper' | 'acid' | 'cyan' | 'riso';

/** 构图模板：auto 表示按曲目种子自动轮换全部模板。 */
export type GeoLayoutId = 'auto' | 'band' | 'split' | 'poster' | 'frame';

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
  /** 底色渐变的两端与方向。 */
  bgTop: string;
  bgBottom: string;
  bgAngle: number;
  /** 油墨（未被唱到的字、线框、标记）。 */
  ink: string;
  /** 已唱过字的颜色；默认与油墨同色，只在唱到的瞬间压上强调色。 */
  sungInk: string;
  /** 强调色：正在唱的字、被填充的色块、进度条。 */
  accent: string;
  /** 副色：分割构图里的另一半、画框里的填充。 */
  secondary: string;
  /** 强调色跟随快捷设置里的「歌词颜色」（纯色 / 封面色 / 自动渐变）。 */
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
  /** 固定用某一种模板，或 auto 按曲目种子轮换。 */
  layout: GeoLayoutId;
  /** 段落接力的速度（0.5 = 慢推、1 = 默认、2 = 快切），控制交接窗口时长。 */
  flow: number;
  /** 逐字点亮时长（毫秒）：一个字从飘入到落位要多久。 */
  revealMs: number;
  /** 随音乐低频抖动的强度。 */
  energy: number;

  /* ── 肌理与版面元素 ───────────────────────── */
  /** 网点/半调覆盖强度 0~1（0 = 完全没有）。 */
  halftone: number;
  /** 胶片颗粒强度 0~1。 */
  grain: number;
  /** 细网格 / 十字线强度 0~1。 */
  grid: number;
  /** 四角裁切标记与居中套准标记。 */
  marks: boolean;
  /** 版面编号、时间码、进度条这类印刷标记。 */
  meta: boolean;
  /** 渲染像素比上限 1~2。 */
  dpr: number;
}

/** 默认值 = 现在的几何观感，改默认只动这里。 */
export const DEFAULT_GEO_SETTINGS: GeoStyleSettings = {
  palette: 'night',
  bgTop: '#0a0b0e',
  bgBottom: '#171a21',
  bgAngle: 158,
  ink: '#f3efe6',
  sungInk: '#f3efe6',
  accent: '#ff5a3c',
  secondary: '#1c6f8a',
  followLyrics: true,

  fontFamily: 'display',
  fontWeight: 900,
  sizeScale: 1,
  letterSpacing: 0.01,
  showTranslation: true,

  layout: 'auto',
  flow: 1,
  revealMs: 210,
  energy: 1,

  halftone: 0.42,
  grain: 0.045,
  grid: 0.34,
  marks: true,
  meta: true,
  dpr: 1.75,
};

export const GEO_SETTINGS_KEY = 'zilux2.geoStyle';

/** 一键配色预设：只覆盖颜色字段，构图与动效保持当前值。 */
export interface GeoPalettePreset {
  id: GeoPalette;
  label: string;
  hint: string;
  patch: Pick<GeoStyleSettings, 'bgTop' | 'bgBottom' | 'bgAngle' | 'ink' | 'sungInk' | 'accent' | 'secondary'>;
}

export const GEO_PALETTE_PRESETS: ReadonlyArray<GeoPalettePreset> = [
  {
    id: 'night',
    label: '暗夜',
    hint: '近黑底 + 暖白油墨 + 橙红强调 + 深青副色：最常见的那种 PV 印刷感',
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
    id: 'cyan',
    label: '蓝晒',
    hint: '深蓝底 + 冰蓝字 + 亮青块 + 深靛副色：像蓝晒图或夜里的复印稿',
    patch: {
      bgTop: '#0a2136',
      bgBottom: '#061320',
      bgAngle: 200,
      ink: '#d8ecff',
      sungInk: '#eaf6ff',
      accent: '#59b8ff',
      secondary: '#0d3a6b',
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
  band: '横条',
  split: '分割',
  poster: '版心',
  frame: '画框',
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

/**
 * 把任意持久化内容归一化成一组合法设置（旧版本缺字段时回落到默认值）。
 * 旧版本的 rotation / slam / misprint / ghostA / ghostB 等字段会直接被丢弃——
 * 新的几何档不再用错版叠印与硬切撞击，改用 flowAngle 连贯接力。
 */
export function normalizeGeoSettings(raw: unknown): GeoStyleSettings {
  const d = DEFAULT_GEO_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d };
  const src = raw as Record<string, unknown>;
  return {
    palette: pick(src.palette, ['night', 'paper', 'acid', 'cyan', 'riso'], d.palette),
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

    halftone: num(src.halftone, d.halftone, 0, 1),
    grain: num(src.grain, d.grain, 0, 0.4),
    grid: num(src.grid, d.grid, 0, 1),
    marks: bool(src.marks, d.marks),
    meta: bool(src.meta, d.meta),
    dpr: num(src.dpr, d.dpr, 1, 2),
  };
}

/** 当前保存的几何设置（读不出来就给默认值）。 */
export function geoStyleSettings(): GeoStyleSettings {
  try {
    const raw = window.localStorage.getItem(GEO_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_GEO_SETTINGS };
    return normalizeGeoSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_GEO_SETTINGS };
  }
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
