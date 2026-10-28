/**
 * 「音乐地铁图」主题 token（日间纸面 / 夜间霓虹两套，方案 §5.1–5.2）。
 *
 * 唯一原则：**颜色 / 线宽 / 动效时长只在这里定义**，其它模块（渲染 CSS、卡片、列车）
 * 一律通过 CSS 变量或本文件导出的常量取值，不要在别处写死色值。
 *
 * 用法（Stage 负责调用）：
 *   const theme = resolveMetroTheme('auto');
 *   applyMetroTheme(root, theme);          // 把 token 写成 root 上的 --mt-* 变量
 *   // 渲染层 CSS 里直接 var(--mt-paper) / var(--mt-tone-sunrise) …
 */

import type { MetroTone } from './types';

export type MetroThemeName = 'light' | 'dark';
/** auto = 跟随主界面 / 系统。 */
export type MetroThemeMode = MetroThemeName | 'auto';

export interface MetroToneColors {
  /** 线路主色（描边、色点）。 */
  base: string;
  /** 发光色（暗色主题的 glow 副本 / 站点光环）。 */
  glow: string;
  /** 极淡底色（分区色块、卡片角标）。 */
  soft: string;
}

export interface MetroTheme {
  name: MetroThemeName;
  label: string;
  /** 纸面 / 夜色底。 */
  paper: string;
  /** 次级纸面（渐变终点 / 浮层底色）。 */
  paper2: string;
  /** 网格线（细 / 粗）。 */
  grid: string;
  gridStrong: string;
  text: string;
  textSoft: string;
  muted: string;
  /** 浮层（HUD / 卡片）底色，带透明以便磨砂。 */
  surface: string;
  surfaceStrong: string;
  border: string;
  shadow: string;
  accent: string;
  accentContrast: string;
  tones: Record<MetroTone, MetroToneColors>;
}

/** MG 动效参数（方案 §5.3）；渲染层生成 CSS 时用它插值，保证只有一份来源。 */
export const METRO_MOTION = {
  ease: 'cubic-bezier(.22,1,.36,1)',
  easePop: 'cubic-bezier(.34,1.56,.64,1)',
  easeStandard: 'cubic-bezier(.4,0,.2,1)',
  /** 线路描边生长。 */
  lineGrow: 900,
  /** 线路之间 stagger。 */
  lineStagger: 80,
  /** 站点弹入。 */
  stationPop: 260,
  /** 站点之间 stagger。 */
  stationStagger: 12,
  /** 镜头平移缩放。 */
  camera: 480,
  /** 线路高亮。 */
  highlight: 240,
  /** hover。 */
  hover: 180,
  /** 卡片弹入 / 收起。 */
  card: 320,
  /** 换乘脉冲循环。 */
  transferPulse: 1800,
  /** 覆盖层退出。 */
  exit: 300,
} as const;

/** 线路/站点/列车的几何尺寸（世界坐标 px，zoom 1 时 1:1）。 */
export const METRO_METRICS = {
  /** 线路基础线宽。 */
  lineWidth: 7,
  /** 高亮时线宽。 */
  lineWidthActive: 10,
  /** 普通站半径。 */
  stationRadius: 9,
  /** 换乘站外半径。 */
  transferRadius: 14,
  /** 终点站半径。 */
  terminusRadius: 11.5,
  /** 站点 hover 放大倍数（CSS 用）。 */
  stationHoverScale: 1.35,
  /** 站点标签字号。 */
  labelSize: 13,
  /** 线路名端点字号。 */
  lineLabelSize: 15,
} as const;

const LIGHT_TONES: Record<MetroTone, MetroToneColors> = {
  sunrise: { base: '#e2683c', glow: 'rgba(226, 104, 60, .35)', soft: 'rgba(226, 104, 60, .10)' },
  sea: { base: '#3f8cff', glow: 'rgba(63, 140, 255, .32)', soft: 'rgba(63, 140, 255, .09)' },
  rose: { base: '#d94f7c', glow: 'rgba(217, 79, 124, .32)', soft: 'rgba(217, 79, 124, .09)' },
  forest: { base: '#2fa58a', glow: 'rgba(47, 165, 138, .30)', soft: 'rgba(47, 165, 138, .09)' },
  violet: { base: '#8a6df0', glow: 'rgba(138, 109, 240, .30)', soft: 'rgba(138, 109, 240, .09)' },
  amber: { base: '#c9a227', glow: 'rgba(201, 162, 39, .30)', soft: 'rgba(201, 162, 39, .10)' },
  ghost: { base: '#6d6a5f', glow: 'rgba(109, 106, 95, .26)', soft: 'rgba(109, 106, 95, .08)' },
};

const DARK_TONES: Record<MetroTone, MetroToneColors> = {
  sunrise: { base: '#ff8b5e', glow: 'rgba(255, 139, 94, .55)', soft: 'rgba(255, 139, 94, .13)' },
  sea: { base: '#5ea3ff', glow: 'rgba(94, 163, 255, .55)', soft: 'rgba(94, 163, 255, .13)' },
  rose: { base: '#ff6f9c', glow: 'rgba(255, 111, 156, .55)', soft: 'rgba(255, 111, 156, .13)' },
  forest: { base: '#45c9a6', glow: 'rgba(69, 201, 166, .50)', soft: 'rgba(69, 201, 166, .13)' },
  violet: { base: '#a98cff', glow: 'rgba(169, 140, 255, .52)', soft: 'rgba(169, 140, 255, .13)' },
  amber: { base: '#e8bf49', glow: 'rgba(232, 191, 73, .50)', soft: 'rgba(232, 191, 73, .13)' },
  ghost: { base: '#9a968a', glow: 'rgba(154, 150, 138, .40)', soft: 'rgba(154, 150, 138, .10)' },
};

const LIGHT: MetroTheme = {
  name: 'light',
  label: '日间纸面',
  paper: '#f4efe6',
  paper2: '#e9e2d4',
  grid: 'rgba(46, 38, 28, .055)',
  gridStrong: 'rgba(46, 38, 28, .11)',
  text: '#241e17',
  textSoft: '#4f463b',
  muted: '#8c8172',
  surface: 'rgba(255, 252, 246, .74)',
  surfaceStrong: 'rgba(255, 253, 249, .90)',
  border: 'rgba(46, 38, 28, .13)',
  shadow: '0 18px 44px rgba(60, 45, 25, .16)',
  accent: '#c9952f',
  accentContrast: '#fffaf0',
  tones: LIGHT_TONES,
};

const DARK: MetroTheme = {
  name: 'dark',
  label: '夜间霓虹',
  paper: '#0b1020',
  paper2: '#070a15',
  grid: 'rgba(180, 200, 255, .05)',
  gridStrong: 'rgba(180, 200, 255, .10)',
  text: '#eef2ff',
  textSoft: '#c0c9e2',
  muted: '#7f8aa8',
  surface: 'rgba(14, 19, 36, .72)',
  surfaceStrong: 'rgba(20, 26, 48, .92)',
  border: 'rgba(180, 200, 255, .14)',
  shadow: '0 22px 56px rgba(0, 0, 0, .55)',
  accent: '#e2c98a',
  accentContrast: '#141a30',
  tones: DARK_TONES,
};

export const METRO_THEMES: Record<MetroThemeName, MetroTheme> = { light: LIGHT, dark: DARK };

/** 主界面主题（html[data-theme]）优先，其次系统 prefers-color-scheme。 */
export function prefersDark(): boolean {
  const declared = document.documentElement.dataset.theme;
  if (declared === 'dark') return true;
  if (declared === 'light') return false;
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

/** 'auto' → 解析成具体明暗主题。 */
export function resolveMetroTheme(mode: MetroThemeMode = 'auto'): MetroTheme {
  if (mode === 'auto') return prefersDark() ? DARK : LIGHT;
  return METRO_THEMES[mode];
}

/** 主题 → CSS 变量表（`--mt-*`）。 */
export function metroThemeVars(theme: MetroTheme): Record<string, string> {
  const vars: Record<string, string> = {
    '--mt-paper': theme.paper,
    '--mt-paper-2': theme.paper2,
    '--mt-grid': theme.grid,
    '--mt-grid-2': theme.gridStrong,
    '--mt-text': theme.text,
    '--mt-text-soft': theme.textSoft,
    '--mt-muted': theme.muted,
    '--mt-surface': theme.surface,
    '--mt-surface-strong': theme.surfaceStrong,
    '--mt-border': theme.border,
    '--mt-shadow': theme.shadow,
    '--mt-accent': theme.accent,
    '--mt-accent-contrast': theme.accentContrast,
    '--mt-font': "'Zilux2 Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
    '--mt-mono': "ui-monospace, 'Cascadia Mono', Consolas, monospace",
  };
  for (const [tone, colors] of Object.entries(theme.tones)) {
    vars[`--mt-tone-${tone}`] = colors.base;
    vars[`--mt-tone-${tone}-glow`] = colors.glow;
    vars[`--mt-tone-${tone}-soft`] = colors.soft;
  }
  return vars;
}

/** 把主题 token 写到元素上（idempotent，切主题时覆盖同名变量即可）。 */
export function applyMetroTheme(root: HTMLElement, theme: MetroTheme): void {
  root.dataset.theme = theme.name;
  root.dataset.tone = theme.name;
  const vars = metroThemeVars(theme);
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
}

/** prefers-reduced-motion（方案 §5.4：入场/切换瞬时或 ≤120ms，列车改静态点）。 */
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}
