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
