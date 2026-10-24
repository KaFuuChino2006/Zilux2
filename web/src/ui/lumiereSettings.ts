/**
 * 歌词「文字设置」：把 folia 绘光运行时里可以自定义、且对纯字档有效的那部分参数暴露出来。
 * 数值存本机（localStorage），保存后由舞台实时应用；面板里的每一次拖动都走同一套应用逻辑做实时预览。
 */
import { DEFAULT_LUMIERE_TUNING, type LumiereRenderQuality, type LumiereTuning } from './lumiere-folia/types';
import type { TextBeamStyle } from './lumiere-folia/components/visualizer/lumiere/types';

/** 文字设置可调的字段（是 LumiereTuning 的子集，外加画质档）。 */
export interface LyricTextSettings {
  // 文字
  unlitOpacity: number;
  textBloom: number;
  keywordColors: boolean;
  themeColorMix: number;
  windowNeighbors: 1 | 2;
  // 动效
  decay: number;
  echo: number;
  trails: boolean;
  hideTrails: boolean;
  seamlessTransitions: boolean;
  // 光感
  lightIntensity: number;
  audioResponse: number;
  bloom: number;
  renderQuality: LumiereRenderQuality;
  // 光柱（纯字档的画在文字后面的光柱与雾）
  beams: boolean;
  /** 光柱样式：静光 / 缓息 / 流幕 / 聚光 / 斜光 / 交叉 / 仰光 / 虹光（见 lumiere-folia 的 light/textBeams.ts）。 */
  beamStyle: TextBeamStyle;
  /** 自动轮换：每隔 16 秒自动换一套光柱样式（按下一条注释里的轮换顺序，切换处平滑过渡）。 */
  beamAuto: boolean;
  /** 光柱粗细与长度倍数（1 = 原始）。 */
  beamScale: number;
  /** 光柱整体左右偏移（按画面宽的比例，负左正右）。 */
  beamOffsetX: number;
  /** 光柱整体上下偏移（按画面高的比例，负上正下）。 */
  beamOffsetY: number;
  // 背景光柱与雾
  fogDensity: number;
  fogOctaves: number;
  moteAmount: number;
}

export const DEFAULT_TEXT_SETTINGS: LyricTextSettings = {
  unlitOpacity: DEFAULT_LUMIERE_TUNING.unlitOpacity,
  textBloom: DEFAULT_LUMIERE_TUNING.textBloom,
  keywordColors: DEFAULT_LUMIERE_TUNING.keywordColors,
  themeColorMix: DEFAULT_LUMIERE_TUNING.themeColorMix,
  windowNeighbors: DEFAULT_LUMIERE_TUNING.windowNeighbors,
  decay: DEFAULT_LUMIERE_TUNING.decay,
  echo: DEFAULT_LUMIERE_TUNING.echo,
  trails: DEFAULT_LUMIERE_TUNING.trails,
  hideTrails: DEFAULT_LUMIERE_TUNING.hideTrails,
  seamlessTransitions: DEFAULT_LUMIERE_TUNING.seamlessTransitions,
  lightIntensity: 1.25,
  audioResponse: DEFAULT_LUMIERE_TUNING.audioResponse,
  bloom: DEFAULT_LUMIERE_TUNING.bloom,
  renderQuality: DEFAULT_LUMIERE_TUNING.renderQuality,
  beams: true,
  beamStyle: 'calm',
  beamAuto: true,
  beamScale: 1,
  beamOffsetX: 0,
  beamOffsetY: 0,
  // 纯字档的光柱是「稀薄体积光」，雾比绘光原版背景淡很多；这些默认值就是纯字舞台的默认观感。
  fogDensity: 0.35,
  fogOctaves: DEFAULT_LUMIERE_TUNING.fogOctaves,
  moteAmount: DEFAULT_LUMIERE_TUNING.moteAmount,
};

const STORE_KEY = 'zilux2.lyricText';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** 把任意输入收敛成合法设置：缺字段补默认、数字夹到取值范围。 */
export function normalizeTextSettings(raw: Partial<LyricTextSettings> | null | undefined): LyricTextSettings {
  const base = { ...DEFAULT_TEXT_SETTINGS };
  if (!raw || typeof raw !== 'object') return base;
  const num = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
  };
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
  const quality = (value: unknown, fallback: LumiereRenderQuality): LumiereRenderQuality =>
    value === 'full' || value === 'balanced' || value === 'low' ? value : fallback;
  const beamStyle = (value: unknown, fallback: TextBeamStyle): TextBeamStyle =>
    value === 'calm'
    || value === 'breathe'
    || value === 'curtain'
    || value === 'focus'
    || value === 'diagonal'
    || value === 'cross'
    || value === 'rise'
    || value === 'rainbow'
      ? value
      : fallback;
  return {
    unlitOpacity: num(raw.unlitOpacity, base.unlitOpacity, 0.05, 0.6),
    textBloom: num(raw.textBloom, base.textBloom, 0, 2),
    keywordColors: bool(raw.keywordColors, base.keywordColors),
    themeColorMix: num(raw.themeColorMix, base.themeColorMix, 0, 1),
    windowNeighbors: raw.windowNeighbors === 1 ? 1 : 2,
    decay: num(raw.decay, base.decay, 0, 2),
    echo: num(raw.echo, base.echo, 0, 2),
    trails: bool(raw.trails, base.trails),
    hideTrails: bool(raw.hideTrails, base.hideTrails),
    seamlessTransitions: bool(raw.seamlessTransitions, base.seamlessTransitions),
    lightIntensity: num(raw.lightIntensity, base.lightIntensity, 0.3, 2),
    audioResponse: num(raw.audioResponse, base.audioResponse, 0, 2),
    bloom: num(raw.bloom, base.bloom, 0, 2),
    renderQuality: quality(raw.renderQuality, base.renderQuality),
    beams: bool(raw.beams, base.beams),
    beamStyle: beamStyle(raw.beamStyle, base.beamStyle),
    beamAuto: bool(raw.beamAuto, base.beamAuto),
    beamScale: num(raw.beamScale, base.beamScale, 0.2, 3),
    beamOffsetX: num(raw.beamOffsetX, base.beamOffsetX, -0.8, 0.8),
    beamOffsetY: num(raw.beamOffsetY, base.beamOffsetY, -0.8, 0.8),
    fogDensity: num(raw.fogDensity, base.fogDensity, 0, 2),
    fogOctaves: Math.round(num(raw.fogOctaves, base.fogOctaves, 2, 6)),
    moteAmount: num(raw.moteAmount, base.moteAmount, 0, 2),
  };
}

/** 读取本机保存的文字设置（读不到或坏掉就回默认）。 */
export function lyricTextSettings(): LyricTextSettings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_TEXT_SETTINGS };
    return normalizeTextSettings(JSON.parse(raw) as Partial<LyricTextSettings>);
  } catch {
    return { ...DEFAULT_TEXT_SETTINGS };
  }
}

/** 保存文字设置（只写本机，应用由调用方触发）。 */
export function saveLyricTextSettings(next: LyricTextSettings): LyricTextSettings {
  const normalized = normalizeTextSettings(next);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(normalized));
  } catch {
    // 存不下就只在本次会话生效，不打断用户。
  }
  return normalized;
}

/** 把文字设置叠到一份完整的运行时 tuning 上（textOnly / themeIcons 等由舞台自己决定）。 */
export function textSettingsToTuning(base: LumiereTuning, settings: LyricTextSettings): LumiereTuning {
  return {
    ...base,
    unlitOpacity: settings.unlitOpacity,
    textBloom: settings.textBloom,
    keywordColors: settings.keywordColors,
    themeColorMix: settings.themeColorMix,
    windowNeighbors: settings.windowNeighbors,
    decay: settings.decay,
    echo: settings.echo,
    trails: settings.trails,
    hideTrails: settings.hideTrails,
    seamlessTransitions: settings.seamlessTransitions,
    lightIntensity: settings.lightIntensity,
    audioResponse: settings.audioResponse,
    bloom: settings.bloom,
    renderQuality: settings.renderQuality,
    textBeams: settings.beams,
    textBeamStyle: settings.beamStyle,
    textBeamAuto: settings.beamAuto,
    textBeamScale: settings.beamScale,
    textBeamOffsetX: settings.beamOffsetX,
    textBeamOffsetY: settings.beamOffsetY,
    fogDensity: settings.fogDensity,
    fogOctaves: settings.fogOctaves,
    moteAmount: settings.moteAmount,
  };
}
