/**
 * 歌词页「播放效果 · 房间」的可调参数模型。
 *
 * 和「纯字」档的 lumiereSettings.ts 一样：一份扁平对象 + 默认值 + 归一化 +
 * localStorage 持久化，设置面板（ui/roomSettingsPanel.ts）直接在这份模型上改，
 * 场景引擎（ui/roomScene.ts）通过 setStyle() 接收整份配置。
 *
 * 约定：所有颜色都是 `#rrggbb`；角度用「度」，位移/深度/宽度用世界单位。
 */

export interface RoomStyleSettings {
  /* ── 歌词文字 ─────────────────────────────── */
  /** 字体：display=系统重字（Noto Black / 雅黑 Bold），yahei=微软雅黑，serif=衬线，system=自带字体。 */
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
  /** 重点词（自动从歌词里挑出的、反复出现的词）单独染色。 */
  keywordColors: boolean;
  /** 重点词字号倍率（1 = 与普通词一样大）。 */
  keywordScale: number;
  /** 第一句歌词开口前，在画面中央显示歌名（前奏不空画布）。 */
  introTitle: boolean;
  /** 前奏歌名字号倍率（1 = 当前观感）。 */
  introTitleScale: number;
  /** 三态不透明度。 */
  unsungOpacity: number;
  sungOpacity: number;
  activeOpacity: number;

  /* ── 逐词布局（离散度） ───────────────────── */
  /** 打散区域半宽（相对画面宽）。 */
  spreadX: number;
  /** 打散区域上/下边（相对画面高，相对中心，正数向下）。 */
  areaTop: number;
  areaBottom: number;
  /** 纵深离散：词相对焦点平面的前后偏移倍率（0 = 全在同一平面）。 */
  depthSpread: number;
  /** 每个词额外的随机滚转角（度，0 = 不转）。 */
  rotation: number;
  /** 同时显示前后各几句（0 = 只看当前句）。 */
  neighborLines: 0 | 1 | 2;

  /* ── 背景 ─────────────────────────────────── */
  bgTop: string;
  bgBottom: string;
  /** 渐变方向（度，0 = 从上到下，90 = 从左到右）。 */
  bgAngle: number;
  /** 画面中心柔光强度（0 关闭）。 */
  centerGlow: number;
  /** 暗角强度 0~1。 */
  vignette: number;
  /** 细长光痕强度与条数。 */
  streakStrength: number;
  streakCount: number;
  /** 流星飞行速度倍数（1 = 默认） */
  streakSpeed: number;
  /** 流星拖尾长度占当前半径的比例（0.02–0.9） */
  streakLength: number;
  /** 流星线条粗细倍数（0.3–2.5，1 = 默认） */
  streakWidth: number;
  /** 颗粒噪点强度 0~1（0.055 接近当前观感）。 */
  grain: number;
  /** 漂浮光点数量（0 关闭）。 */
  particleCount: number;
  /** 光点世界尺寸倍率。 */
  particleSize: number;
  /** 光点亮度倍率。 */
  particleBrightness: number;
  /** 光点朝镜头飘动的速度倍率。 */
  particleSpeed: number;
  /** 光点横向漂移幅度倍率。 */
  particleDrift: number;
  /** 背景渐变跟随快捷设置里的「歌词颜色」（纯色 / 封面色 / 自动渐变）。 */
  bgFollowLyrics: boolean;

  /* ── 地面长条地毯 ─────────────────────────── */
  rugVisible: boolean;
  rugColor: string;
  /** 地毯配色跟随快捷设置里的「歌词颜色」。 */
  rugFollowLyrics: boolean;
  rugWidth: number;
  rugNear: number;
  rugFar: number;
  rugBandGap: number;
  rugOpacity: number;

  /* ── 镜头 ─────────────────────────────────── */
  /** 相机高度。 */
  camHeight: number;
  /** 正在唱那句离镜头的深度（越大词越远越小）。 */
  focusDepth: number;
  /** 换句时默认前进的距离。 */
  lineGap: number;
  /** 一句唱完前镜头自己往前蹭的距离。 */
  creep: number;
  /** 换句时往后拉的概率 0~1。 */
  pullChance: number;
  pullDistance: number;
  /** 换句滚转角度范围（度，min=0 表示总是同向）。 */
  rollMin: number;
  rollMax: number;
  /** 手持晃动倍率（0 = 完全静止）。 */
  shake: number;

  /* ── 动效 ─────────────────────────────────── */
  /** 逐词从无到有浮现。 */
  entrance: boolean;
  /** 浮现时长（毫秒，0 = 瞬间出现）。 */
  entranceMs: number;
  /** 前后句的淡化倍率（1 = 当前观感，越大残影越清晰）。 */
  fadeGhost: number;
  /** 随音乐低频的呼吸强度。 */
  energy: number;
  /** 渲染像素比上限 1~2。 */
  dpr: number;
}

/** 默认值 = 现在的房间效果观感，改默认只动这里。 */
export const DEFAULT_ROOM_SETTINGS: RoomStyleSettings = {
  fontFamily: 'display',
  fontWeight: 900,
  sizeScale: 1,
  letterSpacing: 0.004,
  color: '#fff9f2',
  sungColor: '#fffdfa',
  activeColor: '#ffffff',
  glowColor: '#ffffff',
  glow: 1,
  keywordColors: true,
  keywordScale: 1.12,
  introTitle: true,
  introTitleScale: 1,
  unsungOpacity: 0.92,
  sungOpacity: 0.98,
  activeOpacity: 1,

  spreadX: 0.335,
  areaTop: 0.275,
  areaBottom: 0.01,
  depthSpread: 1,
  rotation: 4.2,
  neighborLines: 1,

  bgTop: '#a9e0cd',
  bgBottom: '#57bf9f',
  bgAngle: 53,
  centerGlow: 0.3,
  vignette: 0.42,
  streakStrength: 1,
  streakCount: 7,
  streakSpeed: 1,
  streakLength: 0.28,
  streakWidth: 1,
  grain: 0.055,
  particleCount: 36,
  particleSize: 1,
  particleBrightness: 1,
  particleSpeed: 1,
  particleDrift: 1,
  bgFollowLyrics: true,

  rugVisible: true,
  rugColor: '#faf6f0',
  rugFollowLyrics: true,
  rugWidth: 0.95,
  rugNear: 1.3,
  rugFar: 30,
  rugBandGap: 1.1,
  rugOpacity: 1,

  camHeight: 0.9,
  focusDepth: 7.6,
  lineGap: 5.6,
  creep: 0.5,
  pullChance: 0.34,
  pullDistance: 9.4,
  rollMin: 6,
  rollMax: 13,
  shake: 1,

  entrance: true,
  entranceMs: 320,
  fadeGhost: 1,
  energy: 1,
  dpr: 1.75,
};

export const ROOM_SETTINGS_KEY = 'zilux2.roomStyle';

/** 一键预设：颜色/背景/镜头的小组合，其余参数保持默认。 */
export interface RoomStylePreset {
  id: string;
  label: string;
  patch: Partial<RoomStyleSettings>;
}

export const ROOM_STYLE_PRESETS: ReadonlyArray<RoomStylePreset> = [
  {
    id: 'mint',
    label: '薄荷',
    patch: {},
  },
  {
    id: 'cream',
    label: '奶油',
    patch: {
      bgTop: '#faf3e4',
      bgBottom: '#e7d8bb',
      rugColor: '#fffaf0',
      centerGlow: 0.36,
      vignette: 0.34,
    },
  },
  {
    id: 'midnight',
    label: '午夜',
    patch: {
      bgTop: '#2b3f4d',
      bgBottom: '#101c25',
      rugColor: '#d8e8f2',
      vignette: 0.52,
      centerGlow: 0.4,
    },
  },
  {
    id: 'sakura',
    label: '樱花',
    patch: {
      bgTop: '#ffe1e8',
      bgBottom: '#f4b9c8',
      rugColor: '#fff6f8',
      vignette: 0.36,
    },
  },
];

/** 粒子快捷预设能覆盖的五个数值字段。 */
export type ParticleEffectKey =
  | 'particleCount'
  | 'particleSize'
  | 'particleBrightness'
  | 'particleSpeed'
  | 'particleDrift';

/** 流星快捷预设能覆盖的五个数值字段。 */
export type StreakEffectKey =
  | 'streakStrength'
  | 'streakCount'
  | 'streakSpeed'
  | 'streakLength'
  | 'streakWidth';

/** 效果快捷预设可以覆盖的全部数值字段（粒子 + 流星）。 */
export type RoomEffectKey = ParticleEffectKey | StreakEffectKey;

/** 粒子快捷预设：只换光点手感，颜色/背景等其它设置保持当前值。 */
export interface ParticlePreset {
  id: string;
  name: string;
  /** 一句话说明（同时用作按钮 title 提示）。 */
  hint: string;
  effect: 'particle';
  patch: Pick<RoomStyleSettings, ParticleEffectKey>;
}

/** 流星快捷预设：只换光痕手感。 */
export interface StreakPreset {
  id: string;
  name: string;
  hint: string;
  effect: 'streak';
  patch: Pick<RoomStyleSettings, StreakEffectKey>;
}

/** 效果快捷预设（两组共用，面板按 effect 分排渲染）。 */
export type RoomEffectPreset = ParticlePreset | StreakPreset;

/**
 * 粒子快捷预设：一键换漂浮光点的数量/大小/亮度/速度/漂移。
 * 数值都在 normalizeRoomSettings 的合法区间内，点完仍可拖动滑杆继续微调。
 */
export const PARTICLE_PRESETS: ReadonlyArray<ParticlePreset> = [
  {
    id: 'stardust',
    name: '星尘',
    hint: '默认观感：微亮的小光点，数量适中',
    effect: 'particle',
    patch: {
      particleCount: 36,
      particleSize: 1,
      particleBrightness: 1,
      particleSpeed: 1,
      particleDrift: 1,
    },
  },
  {
    id: 'firefly',
    name: '萤火',
    hint: '更多更亮的光点，慢慢横向飘',
    effect: 'particle',
    patch: {
      particleCount: 64,
      particleSize: 1.3,
      particleBrightness: 1.2,
      particleSpeed: 0.55,
      particleDrift: 1.6,
    },
  },
  {
    id: 'snow',
    name: '雪点',
    hint: '细密的小亮点，缓缓漂浮',
    effect: 'particle',
    patch: {
      particleCount: 72,
      particleSize: 0.55,
      particleBrightness: 1.9,
      particleSpeed: 0.4,
      particleDrift: 2.2,
    },
  },
  {
    id: 'hush',
    name: '静谧',
    hint: '极少数又大又暗的光点，画面安静下来',
    effect: 'particle',
    patch: {
      particleCount: 12,
      particleSize: 2.2,
      particleBrightness: 0.45,
      particleSpeed: 0.3,
      particleDrift: 0.6,
    },
  },
];

/** 流星快捷预设：一键换光痕的亮度/条数/速度/拖尾/粗细。 */
export const STREAK_PRESETS: ReadonlyArray<StreakPreset> = [
  {
    id: 'default',
    name: '默认',
    hint: '默认观感：七条中等亮度的流星',
    effect: 'streak',
    patch: {
      streakStrength: 1,
      streakCount: 7,
      streakSpeed: 1,
      streakLength: 0.28,
      streakWidth: 1,
    },
  },
  {
    id: 'rain',
    name: '流星雨',
    hint: '多而快、细密的流星雨',
    effect: 'streak',
    patch: {
      streakStrength: 0.85,
      streakCount: 12,
      streakSpeed: 2.2,
      streakLength: 0.2,
      streakWidth: 0.55,
    },
  },
  {
    id: 'comet',
    name: '长拖尾',
    hint: '少而亮，拖着长长的尾巴',
    effect: 'streak',
    patch: {
      streakStrength: 1,
      streakCount: 3,
      streakSpeed: 0.75,
      streakLength: 0.72,
      streakWidth: 1.6,
    },
  },
  {
    id: 'glow',
    name: '微光',
    hint: '稀疏、缓慢的微光划痕',
    effect: 'streak',
    patch: {
      streakStrength: 0.4,
      streakCount: 5,
      streakSpeed: 0.25,
      streakLength: 0.5,
      streakWidth: 1.8,
    },
  },
];

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

/** 把任意持久化内容归一化成一组合法设置（旧版本缺字段时回落到默认值）。 */
export function normalizeRoomSettings(raw: unknown): RoomStyleSettings {
  const d = DEFAULT_ROOM_SETTINGS;
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
    keywordScale: num(src.keywordScale, d.keywordScale, 0.6, 2.2),
    introTitle: bool(src.introTitle, d.introTitle),
    introTitleScale: num(src.introTitleScale, d.introTitleScale, 0.5, 2.2),
    unsungOpacity: num(src.unsungOpacity, d.unsungOpacity, 0, 1),
    sungOpacity: num(src.sungOpacity, d.sungOpacity, 0, 1),
    activeOpacity: num(src.activeOpacity, d.activeOpacity, 0, 1),

    spreadX: num(src.spreadX, d.spreadX, 0.1, 0.5),
    areaTop: num(src.areaTop, d.areaTop, 0.05, 0.5),
    areaBottom: num(src.areaBottom, d.areaBottom, 0.02, 0.5),
    depthSpread: num(src.depthSpread, d.depthSpread, 0, 2),
    rotation: num(src.rotation, d.rotation, 0, 20),
    neighborLines: pick(src.neighborLines, [0, 1, 2], d.neighborLines),

    bgTop: hex(src.bgTop, d.bgTop),
    bgBottom: hex(src.bgBottom, d.bgBottom),
    bgAngle: num(src.bgAngle, d.bgAngle, 0, 360),
    centerGlow: num(src.centerGlow, d.centerGlow, 0, 1),
    vignette: num(src.vignette, d.vignette, 0, 1),
    streakStrength: num(src.streakStrength, d.streakStrength, 0, 1),
    streakCount: Math.round(num(src.streakCount, d.streakCount, 0, 12)),
    streakSpeed: num(src.streakSpeed, 1, 0.2, 3),
    streakLength: num(src.streakLength, d.streakLength, 0.02, 0.9),
    streakWidth: num(src.streakWidth, 1, 0.3, 2.5),
    grain: num(src.grain, d.grain, 0, 1),
    particleCount: Math.round(num(src.particleCount, d.particleCount, 0, 90)),
    particleSize: num(src.particleSize, d.particleSize, 0.3, 3),
    particleBrightness: num(src.particleBrightness, d.particleBrightness, 0.15, 2.5),
    particleSpeed: num(src.particleSpeed, d.particleSpeed, 0.2, 3),
    particleDrift: num(src.particleDrift, d.particleDrift, 0.2, 3),
    bgFollowLyrics: bool(src.bgFollowLyrics, d.bgFollowLyrics),

    rugVisible: bool(src.rugVisible, d.rugVisible),
    rugColor: hex(src.rugColor, d.rugColor),
    rugFollowLyrics: bool(src.rugFollowLyrics, d.rugFollowLyrics),
    rugWidth: num(src.rugWidth, d.rugWidth, 0.4, 2.4),
    rugNear: num(src.rugNear, d.rugNear, 0.8, 4),
    rugFar: num(src.rugFar, d.rugFar, 10, 60),
    rugBandGap: num(src.rugBandGap, d.rugBandGap, 0.4, 2.4),
    rugOpacity: num(src.rugOpacity, d.rugOpacity, 0, 1),

    camHeight: num(src.camHeight, d.camHeight, 0.4, 2),
    focusDepth: num(src.focusDepth, d.focusDepth, 4, 14),
    lineGap: num(src.lineGap, d.lineGap, 2, 10),
    creep: num(src.creep, d.creep, 0, 2),
    pullChance: num(src.pullChance, d.pullChance, 0, 1),
    pullDistance: num(src.pullDistance, d.pullDistance, 0, 20),
    rollMin: num(src.rollMin, d.rollMin, 0, 20),
    rollMax: num(src.rollMax, d.rollMax, 0, 20),
    shake: num(src.shake, d.shake, 0, 3),

    entrance: bool(src.entrance, d.entrance),
    entranceMs: num(src.entranceMs, d.entranceMs, 0, 1200),
    fadeGhost: num(src.fadeGhost, d.fadeGhost, 0, 2),
    energy: num(src.energy, d.energy, 0, 2),
    dpr: num(src.dpr, d.dpr, 1, 2),
  };
}

let cached: RoomStyleSettings | null = null;

/** 读取本机持久化的房间设置（首次读 localStorage，之后走内存缓存）。 */
export function roomStyleSettings(): RoomStyleSettings {
  if (cached) return cached;
  let raw: unknown = null;
  try {
    const text = window.localStorage.getItem(ROOM_SETTINGS_KEY);
    if (text) raw = JSON.parse(text) as unknown;
  } catch {
    raw = null;
  }
  cached = normalizeRoomSettings(raw);
  return cached;
}

/** 保存房间设置（同时更新内存缓存并广播给已打开的场景）。 */
export function saveRoomStyleSettings(next: RoomStyleSettings): RoomStyleSettings {
  const normalized = normalizeRoomSettings(next);
  cached = normalized;
  try {
    window.localStorage.setItem(ROOM_SETTINGS_KEY, JSON.stringify(normalized));
  } catch {
    /* 存不下就只用内存值 */
  }
  return normalized;
}

/** 把某个预设合进当前设置。 */
export function applyRoomPreset(
  base: RoomStyleSettings,
  preset: RoomStylePreset,
): RoomStyleSettings {
  return normalizeRoomSettings({ ...base, ...preset.patch });
}

/** 把某个效果快捷预设合进当前设置（只覆盖它声明的字段，其它设置保持当前值）。 */
export function applyRoomEffectPreset(base: RoomStyleSettings, preset: RoomEffectPreset): RoomStyleSettings {
  const patch: Partial<RoomStyleSettings> = preset.patch;
  const next = normalizeRoomSettings({ ...base, ...patch });
  // 粒子全关掉时点预设会像没反应，兜底留一点点。
  if (preset.effect === 'particle' && next.particleCount < 1) next.particleCount = 8;
  return next;
}

/** 当前设置是否正好等于某个效果预设（用于 chips 高亮，容忍滑杆的浮点误差）。 */
export function roomEffectPresetMatches(base: RoomStyleSettings, preset: RoomEffectPreset): boolean {
  const patch: Partial<Record<RoomEffectKey, number>> = preset.patch;
  return (Object.keys(patch) as RoomEffectKey[]).every((key) => {
    const want = patch[key];
    return typeof want !== 'number' || Math.abs(base[key] - want) <= 1e-6;
  });
}
