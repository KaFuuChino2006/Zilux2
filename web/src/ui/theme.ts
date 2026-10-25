/**
 * 主题 + 组件样式接口（换肤的唯一入口）。
 *
 * 约定：
 *   1) 颜色 / 圆角 / 阴影 / 动效全部走 CSS 变量（语义令牌），组件类里不写死颜色；
 *   2) 组件类名统一由 `ui.*` 生成，页面只做组合，不自己拼样式名；
 *   3) 新增主题 = 在 THEMES 里加一份令牌，再调 applyTheme()，组件代码零改动。
 *
 * 迁移状态：新页面（首页 / 后续新组件）已全部使用 `ui.*` + 语义令牌；
 * 旧组件里仍有少量写死的 rgba，会在后续迭代里逐个换成令牌（换行为不变）。
 */

export type ThemeName = 'dark' | 'light';

export interface Theme {
  name: ThemeName;
  label: string;
  /** 语义令牌 → 值；applyTheme() 会逐个写到 :root */
  tokens: Record<string, string>;
}

const THEME_KEY = 'zilux2.theme';

const TYPE_TOKENS: Record<string, string> = {
  '--font-ui': "'Zilux2 Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
  '--font-num': "'Zilux2 Sans SC', ui-monospace, 'SF Mono', Menlo, monospace",
  '--radius-s': '8px',
  '--radius-m': '14px',
  '--radius-l': '20px',
  '--radius-pill': '999px',
  '--ease': 'cubic-bezier(0.22, 0.68, 0.24, 1)',
  '--dur-fast': '160ms',
  '--dur-mid': '260ms',
  '--dur-slow': '420ms',
  /* 统一展开/收起动效：搜索药丸、播放条、面板弹出都引用这一组 */
  '--dur-pop': '600ms',
  '--ease-pop': 'cubic-bezier(0.22, 1.28, 0.36, 1)',
};

const DARK: Theme = {
  name: 'dark',
  label: '深色',
  tokens: {
    ...TYPE_TOKENS,
    '--bg': '#08090c',
    '--bg-soft': '#0c0e13',
    '--surface': 'rgba(18, 19, 24, 0.72)',
    '--surface-strong': 'rgba(25, 27, 33, 0.94)',
    '--surface-hover': 'rgba(34, 36, 45, 0.92)',
    '--line': 'rgba(255, 255, 255, 0.08)',
    '--line-strong': 'rgba(255, 255, 255, 0.14)',
    '--text': '#f2f3f6',
    '--muted': '#858a95',
    '--accent': '#d9c08d',
    '--accent-soft': 'rgba(217, 192, 141, 0.16)',
    '--accent-strong': '#efdcaf',
    '--accent-contrast': '#111218',
    '--rail-bg': 'rgba(18, 19, 24, 0.58)',
    '--panel': 'rgba(18, 19, 24, 0.72)',
    '--panel-solid': '#121318',
    '--panel-raised': 'rgba(30, 31, 38, 0.86)',
    '--text-soft': '#c3c6ce',
    '--shadow': '0 18px 48px rgba(0, 0, 0, 0.55)',
    '--danger': '#ff6b6b',
    '--ink-rgb': '6 7 10',
    '--overlay-rgb': '255 255 255',
    '--shadow-1': '0 10px 28px rgba(0, 0, 0, 0.34)',
    '--shadow-2': '0 24px 64px rgba(0, 0, 0, 0.5)',
    '--scrim': 'rgba(4, 5, 8, 0.62)',
    /* 歌词页：深色主题用浅字（原设计）；浅色主题换成深字，见 LIGHT 同名令牌 */
    '--lyric-dim': 'rgb(255 255 255 / 0.42)',
    '--lyric-near': 'rgb(255 255 255 / 0.64)',
    '--lyric-active': '#ffffff',
    '--lyric-char': 'rgb(255 255 255 / 0.46)',
    '--lyric-char-active': 'rgb(255 255 255 / 0.5)',
    '--lyric-sung': '#c9942f',
    '--lyric-hot': '#e6a92e',
  },
};

const LIGHT: Theme = {
  name: 'light',
  label: '浅色',
  tokens: {
    ...TYPE_TOKENS,
    '--bg': '#f3f1ea',
    '--bg-soft': '#eae7de',
    '--surface': 'rgba(255, 255, 255, 0.82)',
    '--surface-strong': 'rgba(255, 255, 255, 0.96)',
    '--surface-hover': 'rgba(255, 255, 255, 0.98)',
    '--line': 'rgba(24, 26, 32, 0.14)',
    '--line-strong': 'rgba(24, 26, 32, 0.24)',
    '--text': '#1b1d23',
    '--muted': '#565c66',
    '--accent': '#a9803f',
    '--accent-soft': 'rgba(169, 128, 63, 0.16)',
    '--accent-strong': '#c9a265',
    '--accent-contrast': '#fffaf0',
    '--rail-bg': 'rgba(255, 255, 255, 0.62)',
    '--panel': 'rgba(255, 255, 255, 0.74)',
    '--panel-solid': '#ffffff',
    '--panel-raised': 'rgba(255, 255, 255, 0.9)',
    '--text-soft': '#3c4149',
    '--shadow': '0 18px 44px rgba(60, 48, 28, 0.16)',
    '--danger': '#d64545',
    '--ink-rgb': '250 249 246',
    '--overlay-rgb': '24 26 32',
    '--shadow-1': '0 10px 26px rgba(40, 33, 20, 0.12)',
    '--shadow-2': '0 24px 60px rgba(40, 33, 20, 0.18)',
    '--scrim': 'rgba(240, 237, 229, 0.72)',
    /* 歌词页（浅色）：浅底上必须用深字，否则「白字压白底」看不清 */
    '--lyric-dim': 'rgb(24 26 32 / 0.62)',
    '--lyric-near': 'rgb(24 26 32 / 0.8)',
    '--lyric-active': '#16181d',
    '--lyric-char': 'rgb(24 26 32 / 0.66)',
    '--lyric-char-active': 'rgb(24 26 32 / 0.74)',
    '--lyric-sung': '#9a6a12',
    '--lyric-hot': '#8f5d00',
  },
};

export const THEMES: Record<ThemeName, Theme> = { dark: DARK, light: LIGHT };

// 目前版本先固定浅色（白色）界面；等做主题切换 UI 时再恢复读 localStorage。
function readTheme(): ThemeName {
  return 'light';
}

/** 应用主题：写 dataset + 令牌，组件样式自动跟随。 */
export function applyTheme(name: ThemeName): Theme {
  const theme = THEMES[name] ?? THEMES.dark;
  const root = document.documentElement;
  root.dataset.theme = theme.name;
  for (const [key, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(key, value);
  }
  try {
    localStorage.setItem(THEME_KEY, theme.name);
  } catch {
    /* 忽略 */
  }
  return theme;
}

export function initTheme(): ThemeName {
  return applyTheme(readTheme()).name;
}

export function currentTheme(): ThemeName {
  return (document.documentElement.dataset.theme as ThemeName | undefined) ?? 'light';
}

/* -------------------------------------------------------------------------- */
/* 控制色（整站主题色）                                                        */
/* -------------------------------------------------------------------------- */

const ACCENT_KEY = 'zilux2.accentColor';

/** 用户可自定义的「控制色」预设；空串 = 跟随当前主题默认金色。 */
export const ACCENT_PRESETS: ReadonlyArray<{ label: string; color: string }> = [
  { label: '默认金', color: '' },
  { label: '樱粉', color: '#d98aa4' },
  { label: '薄荷', color: '#5fb99f' },
  { label: '天青', color: '#6f9fd8' },
  { label: '薰衣草', color: '#9182cc' },
  { label: '杏橙', color: '#d69a5e' },
  { label: '朱砂', color: '#d06a63' },
  { label: '青瓷', color: '#5aa8b8' },
];

/** 控制色会覆盖的语义令牌（顺序即声明顺序，重置时按主题令牌还原）。 */
const ACCENT_TOKENS = [
  '--accent',
  '--accent-strong',
  '--accent-soft',
  '--accent-contrast',
  '--bg',
  '--bg-soft',
  '--panel-solid',
] as const;

type Rgb = [number, number, number];

function parseHexRgb(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbToHex([r, g, b]: Rgb): string {
  const toHex = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return [from[0] + (to[0] - from[0]) * amount, from[1] + (to[1] - from[1]) * amount, from[2] + (to[2] - from[2]) * amount];
}

function rgbLuma([r, g, b]: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 读取已保存的控制色（'' = 跟随主题默认）。 */
export function readAccentColor(): string {
  try {
    const raw = localStorage.getItem(ACCENT_KEY) ?? '';
    const rgb = parseHexRgb(raw);
    return rgb ? rgbToHex(rgb) : '';
  } catch {
    return '';
  }
}

/** 保存控制色；传 '' 表示恢复当前主题默认色。 */
export function writeAccentColor(hex: string): void {
  try {
    if (parseHexRgb(hex)) localStorage.setItem(ACCENT_KEY, rgbToHex(parseHexRgb(hex) as Rgb));
    else localStorage.removeItem(ACCENT_KEY);
  } catch {
    /* 忽略隐私模式写入失败 */
  }
}

/**
 * 应用控制色：一个颜色统一驱动按钮/高亮/描边，并给页面底色混一点同色相，
 * 保证整站"同一个控制色"而不会把文字对比度拉坏。
 */
export function applyAccentColor(hex: string): void {
  const root = document.documentElement;
  const theme = THEMES[currentTheme()] ?? THEMES.light;
  const rgb = parseHexRgb(hex);
  const reset = (): void => {
    for (const key of ACCENT_TOKENS) {
      root.style.removeProperty(key);
      const base = theme.tokens[key];
      if (base) root.style.setProperty(key, base);
    }
  };
  if (!rgb) {
    reset();
    return;
  }
  const light = currentTheme() === 'light';
  const baseBg = parseHexRgb(theme.tokens['--bg'] ?? '#f3f1ea') ?? [243, 241, 234];
  const baseBgSoft = parseHexRgb(theme.tokens['--bg-soft'] ?? '#eae7de') ?? [234, 231, 222];
  const basePanel = parseHexRgb(theme.tokens['--panel-solid'] ?? '#ffffff') ?? [255, 255, 255];
  const strong = light ? mixRgb(rgb, [255, 255, 255], 0.18) : mixRgb(rgb, [0, 0, 0], 0.18);
  root.style.setProperty('--accent', rgbToHex(rgb));
  root.style.setProperty('--accent-strong', rgbToHex(strong));
  root.style.setProperty('--accent-soft', `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, 0.18)`);
  root.style.setProperty('--accent-contrast', rgbLuma(rgb) > 0.62 ? '#1b1d23' : '#fffaf0');
  root.style.setProperty('--bg', rgbToHex(mixRgb(baseBg, rgb, light ? 0.028 : 0.12)));
  root.style.setProperty('--bg-soft', rgbToHex(mixRgb(baseBgSoft, rgb, light ? 0.034 : 0.14)));
  root.style.setProperty('--panel-solid', rgbToHex(mixRgb(basePanel, rgb, light ? 0.016 : 0.1)));
}

/* -------------------------------------------------------------------------- */
/* 组件样式接口                                                                */
/* -------------------------------------------------------------------------- */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'ghost' | 'icon';
type Size = 'sm' | 'md' | 'lg';

interface ButtonOptions {
  variant?: ButtonVariant;
  size?: Size;
  extra?: string;
}

interface CardOptions {
  interactive?: boolean;
  flat?: boolean;
  extra?: string;
}

/**
 * 组件类名工厂：页面只调用这里的函数，换主题时不需要改页面。
 * 对应样式在 `styles/app.css` 的「组件层」里，全部引用语义令牌。
 */
export const ui = {
  page: (extra?: string): string => cx('ui-page', extra),
  heading: (): string => 'ui-heading',
  sub: (): string => 'ui-sub',
  section: (extra?: string): string => cx('ui-section', extra),
  sectionHead: (): string => 'ui-section-head',
  sectionTitle: (): string => 'ui-section-title',
  sectionMore: (): string => 'ui-section-more',
  card: (options: CardOptions = {}): string =>
    cx('ui-card', options.interactive !== false && 'is-interactive', options.flat && 'is-flat', options.extra),
  entry: (): string => 'ui-entry',
  entryIcon: (): string => 'ui-entry-icon',
  entryBody: (): string => 'ui-entry-body',
  entryTitle: (): string => 'ui-entry-title',
  entrySub: (): string => 'ui-entry-sub',
  btn: (options: ButtonOptions = {}): string =>
    cx('ui-btn', `ui-btn--${options.variant ?? 'ghost'}`, options.size && options.size !== 'md' ? `ui-btn--${options.size}` : '', options.extra),
  chip: (active = false, extra?: string): string => cx('ui-chip', active && 'is-active', extra),
  scroller: (extra?: string): string => cx('ui-scroller', extra),
  tile: (extra?: string): string => cx('ui-tile', extra),
  tileCover: (): string => 'ui-tile-cover',
  tileName: (): string => 'ui-tile-name',
  tileMeta: (): string => 'ui-tile-meta',
  empty: (): string => 'ui-empty',
  row: (current = false): string => cx('ui-row', current && 'is-current'),
  rowCover: (): string => 'ui-row-cover',
  rowBody: (): string => 'ui-row-body',
  rowName: (): string => 'ui-row-name',
  rowMeta: (): string => 'ui-row-meta',
  rowExtra: (): string => 'ui-row-extra',
  iconBox: (): string => 'ui-icon-box',
} as const;

export type Ui = typeof ui;
