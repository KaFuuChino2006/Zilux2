/**
 * 「话语」对话框歌词的可调项。
 *
 * 和其它效果不同，话语的画面每帧都是现画的，所以这里不走「改完重建场景」那一套：
 * 模块里只留一个活的设置对象，舞台每帧直接读它 —— 拖动滑杆时当前画面立刻变，
 * 不用重建、也不掉帧。面板打开期间改的是草稿（previewHuayuSettings 换掉活对象），
 * 取消就 restoreHuayuSettings() 读回本机存档，保存才落盘。
 */

export type HuayuSideMode = 'random' | 'alternate' | 'left' | 'right';

/** 气泡外观：auto 按歌名抽一种（同一首歌每次都一样，换歌换样子）。 */
export type HuayuBubbleStyle = 'auto' | 'jelly' | 'cream' | 'ink';
export type HuayuEnter = 'auto' | 'hop' | 'stretch' | 'swing';
export type HuayuExit = 'gentle' | 'snappy';

/** 头像外框：圆 / 圆角方（像聊天软件的方形头像）。 */
export type HuayuAvatarShape = 'circle' | 'squircle';

export type HuayuBackdrop = 'cover' | 'off';
export const HUAYU_BACKDROPS: readonly (readonly [HuayuBackdrop, string, string])[] = [
  ['cover', '封面', '把当前歌曲封面放大铺满整块背景，上面压一层很淡的亮场蒙版'],
  ['off', '关闭', '不画任何背景，直接透明底 —— 页面自己的底色/壁纸会透出来'],
];

export const HUAYU_AVATAR_SHAPES: readonly (readonly [HuayuAvatarShape, string, string])[] = [
  ['circle', '圆形', '默认的圆头像'],
  ['squircle', '圆角方', '四角收拢的方块，更像聊天软件里的头像'],
];

export const HUAYU_SHAPES = [
  ['bubble', '对话气泡', '尾尖朝向头像'],
  ['pill', '胶囊', '两端圆润，无尾尖'],
  ['card', '切角卡片', '朝外的一角斜切'],
  ['underline', '下划线', '文字下方一条细线，以圆点收尾'],
  ['rail', '侧边线', '在发言侧竖线旁排字'],
  ['elbow', '折线引导', '从头像旁折向歌词下方'],
  ['orbit', '弧线引导', '一条弧线牵引到歌词起点'],
  ['route', '站点引导', '沿虚线串联起点、转折和终点'],
  ['brackets', '取景框', '用四角短线围出歌词区域'],
  ['wave', '声波谱', '沿歌词底部排列波峰'],
  ['ticket', '票根', '双侧半圆缺口和检票虚线'],
  ['receipt', '撕边纸', '纸条底边带细锯齿'],
  ['ribbon', '燕尾旗', '消息末端剪出燕尾缺口'],
  ['tab', '索引页', '页顶带凸起的分类页签'],
  ['stack', '叠印卡', '错位叠放的双色卡面'],
  ['circuit', '电路引线', '双焊点之间的阶梯走线'],
  ['comet', '彗尾引导', '三道渐短的尾迹汇向星点'],
  ['needle', '唱针引导', '从转轴伸出的唱针靠向文字'],
  ['stitch', '针脚', '上下边沿的斜针脚'],
  ['staff', '五线谱', '歌词下方的谱线和音符'],
  ['ruler', '标尺', '长短刻度标出句子的宽度'],
  ['braid', '双股线', '两道交错的曲线托住文字'],
  ['morse', '点划电报', '交替的圆点和短划组成底纹'],
  ['postage', '邮票', '四边带齿孔的邮票轮廓'],
  ['bookmark', '书签', '侧边垂下一截双色书签'],
  ['film', '胶片', '双边方形片孔'],
  ['scroll', '卷轴', '两端卷起的纸轴'],
  ['cloud', '云笺', '上下边缘柔软起伏'],
  ['folder', '信封', '封口折线落在卡片两角'],
  ['awning', '遮阳篷', '顶部带条纹与扇贝边的短篷'],
] as const;
export type HuayuShape = typeof HUAYU_SHAPES[number][0];

export const HUAYU_STYLES: readonly (readonly [HuayuBubbleStyle, string, string])[] = [
  ['auto', '随曲', '按封面主色抽一套配色：收信是极浅纸色、发信是同色压深一档'],
  ['jelly', '海蓝', '石墨灰收信，海蓝色发信'],
  ['cream', '奶霜', '暖白收信，杏色发信'],
  ['ink', '黑莓', '深灰紫收信，莓紫色发信'],
];
export const HUAYU_ENTERS: readonly (readonly [HuayuEnter, string, string])[] = [
  ['auto', '混合', '随消息切换弹性动作'],
  ['hop', '跳豆', '起跳后压扁回弹'],
  ['stretch', '拉糖', '从头像一侧横向拉开'],
  ['swing', '摇铃', '绕气泡尾巴摆动落位'],
];
export const HUAYU_EXITS: readonly (readonly [HuayuExit, string, string])[] = [
  ['gentle', '软收', '沿原轨迹缓缓收拢'],
  ['snappy', '脆收', '沿原轨迹快速收拢'],
];

export interface HuayuSettings {
  /** 字号倍数：整个气泡、头像、行距都按它缩放。 */
  chatWindow: boolean;
  cameraStrength: number;
  cameraZoom: number;
  cameraZoomSpeed: number;
  /** 左侧会话列表（联系人栏）：像聊天软件左栏那样一列会话，点一下能手动切过去。 */
  showContacts: boolean;
  /** 联系人栏宽度倍数。 */
  railScale: number;
  /** 唱词停顿超过这么多秒，就自动切到下一个聊天窗口接着播。 */
  switchGapSec: number;
  /** 自动切换聊天窗口；关掉后只按手动点击的会话播。 */
  autoSwitchChat: boolean;
  /** 会话切换时旧消息退场到新会话的交叉时长，毫秒。 */
  switchMs: number;
  fontScale: number;
  /** 同屏最多几条消息（含正在唱的那条）。 */
  visibleCount: number;
  /** 最新一条消息底边落在画面高度的多少（0.755 = 靠下）。 */
  baseRatio: number;
  /** 气泡最大宽度占画面宽的比例。 */
  widthRatio: number;
  /** 圆角倍数：1 = 默认的圆润气泡，0.2 接近方角。 */
  radius: number;
  /** 左右分侧：随机（按歌名+行号定死）/ 严格交替 / 全左 / 全右。 */
  sideMode: HuayuSideMode;
  /** 气泡底色浓度，1 = 原色，0.3 = 很淡。 */
  bubbleAlpha: number;
  /** 还没唱到的字有多亮。 */
  unlitOpacity: number;
  /** 正在唱的字与气泡高光的辉光强度，0 = 关。 */
  glow: number;
  /** 显示歌词译文（气泡内下方小字）。 */
  showTranslation: boolean;
  /** 右侧消息唱完后浮出双勾「已读」。 */
  showTicks: boolean;
  /** 气泡右下角显示这句歌的时间戳。 */
  showTime: boolean;
  /** 显示圆头像（关掉后气泡直接贴边距）。 */
  showAvatar: boolean;
  /** 正在输入三点：下一句还没到的空档在它那一侧跳动。 */
  showTyping: boolean;
  /** 拆词：一句歌词按字数切成几条短消息，同一个人连着发。 */
  splitWords: boolean;
  /** 拆词每段最多多少字（含标点）。 */
  splitChars: number;
  splitChance: number;
  /** 一条消息把上一条（另一个人）的话引在顶上的概率，跟气泡样式无关，0 = 关。 */
  quoteChance: number;
  /** 每出现一句新歌词，前面已经唱过的句子被撤回的概率，0 = 关。 */
  revokeChance: number;
  /** 撤回动画时长，毫秒：气泡收掉、小字浮出的过程。 */
  revokeMs: number;
  /** 底部输入条：关掉后整块不画，落点下移到原来的位置。 */
  showComposer: boolean;
  /** 草稿逐字打出：关掉就整句直接显现（不再像有人在敲字）。 */
  draftTyping: boolean;
  /** 自己发出的消息撑开长卷用的时长，毫秒；越短越干脆。 */
  sendGrowMs: number;
  /** 入场时长，毫秒。 */
  enterMs: number;
  /** 入场上浮距离，按字号倍数（2 = 从两个字高下方漂上来）。 */
  enterRise: number;
  /** 入场侧向滑入距离，按字号倍数。 */
  enterDrift: number;
  /** 入场回弹过冲：0 = 纯缓出，1.34 = 默认的轻微过冲。 */
  overshoot: number;
  /** 弹出弹性：0 = 一次到位不晃，1 = 默认手感，2 = 明显回弹两三次。 */
  elasticity: number;
  /** 入场弹性：0 = 直线滑到位，1 = 默认轻微回弹，2 = 明显被弹簧拽过去再弹回来。 */
  enterElastic: number;
  /** 鼓起幅度：入场时体积从 1-popDepth 鼓到 1，0 = 完全不缩放只淡入。 */
  popDepth: number;
  /** 晃动角度（度）：气泡吊在头像上摆出去的最大倾角。 */
  swayAngle: number;
  /** 晃动快慢：倍数，1 = 默认约 0.31 秒一个来回。 */
  swaySpeed: number;
  /** 旧消息被顶上去的跟随速度，越大越跟手。 */
  riseSpeed: number;
  /** 气泡外观。 */
  randomShapes: boolean;
  shapeChance: number;
  shapePool: HuayuShape[];
  shape: HuayuShape;
  bubbleStyle: HuayuBubbleStyle;
  /** 入场动画。 */
  enter: HuayuEnter;
  /** 出场动画。 */
  exit: HuayuExit;
  /** 贴纸款的歪斜强度，0 = 不歪，2 = 歪得明显。 */
  tilt: number;
  /** 左侧头像上的字（默认「话」），最多 2 个字。 */
  avatarLeftText: string;
  /** 右侧头像上的字（默认「语」），最多 2 个字。 */
  avatarRightText: string;
  /** 左侧头像图片（data URL）；空 = 用渐变 + 字。 */
  avatarLeftImage: string;
  /** 右侧头像图片（data URL）；空 = 用渐变 + 字。 */
  avatarRightImage: string;
  /** 头像外框形状。 */
  avatarShape: HuayuAvatarShape;
  bgMode: HuayuBackdrop;
}

export const DEFAULT_HUAYU_SETTINGS: HuayuSettings = {
  chatWindow: true,
  cameraStrength: 1,
  cameraZoom: 0,
  cameraZoomSpeed: 2.25,
  showContacts: true,
  railScale: 0.9,
  switchGapSec: 2,
  autoSwitchChat: true,
  switchMs: 320,
  fontScale: 1,
  visibleCount: 6,
  baseRatio: 0.755,
  widthRatio: 0.56,
  radius: 1,
  sideMode: 'random',
  bubbleAlpha: 1,
  unlitOpacity: 0.4,
  glow: 1,
  showTranslation: true,
  showTicks: true,
  showTime: true,
  showAvatar: true,
  showTyping: true,
  splitWords: true,
  splitChars: 6,
  splitChance: 0.75,
  quoteChance: 0.34,
  revokeChance: 0.12,
  revokeMs: 340,
  showComposer: true,
  draftTyping: true,
  sendGrowMs: 260,
  enterMs: 700,
  enterRise: 2,
  enterDrift: 3,
  overshoot: 2.2,
  elasticity: 0.88,
  enterElastic: 0.74,
  popDepth: 0.5,
  swayAngle: 12,
  swaySpeed: 0.55,
  riseSpeed: 13,
  randomShapes: true,
  shapeChance: 100,
  shapePool: ['underline', 'rail', 'elbow', 'orbit', 'route', 'brackets', 'wave'],
  shape: 'bubble',
  bubbleStyle: 'auto',
  enter: 'auto',
  exit: 'gentle',
  tilt: 1,
  avatarLeftText: '话',
  avatarRightText: '语',
  avatarLeftImage: '',
  avatarRightImage: '',
  avatarShape: 'circle',
  bgMode: 'off',
};

const key = 'zilux2.huayu.settings';

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

const readNumber = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;

const readInt = (value: unknown, fallback: number, min: number, max: number): number =>
  Math.round(readNumber(value, fallback, min, max));

const readBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const readSideMode = (value: unknown, fallback: HuayuSideMode): HuayuSideMode =>
  value === 'random' || value === 'alternate' || value === 'left' || value === 'right'
    ? value
    : fallback;

const readOneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** 头像上的字：留空就回默认字，长了下意识裁到 2 个字，避免把圆撑破。 */
const readAvatarText = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const text = Array.from(value.trim()).slice(0, 2).join('');
  return text.length > 0 ? text : fallback;
};

/** 头像图片：只认 data URL，长度按 localStorage 余量兜一个上限。 */
const readImage = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text.startsWith('data:image/')) return '';
  return text.length > 900_000 ? '' : text;
};

function normalize(input: (Partial<HuayuSettings> & { shapeWeights?: Partial<Record<HuayuShape, number>> }) | null | undefined): HuayuSettings {
  const fallback = DEFAULT_HUAYU_SETTINGS;
  const source = input ?? {};
  return {
    chatWindow: readBool(source.chatWindow, fallback.chatWindow),
    cameraStrength: readNumber(source.cameraStrength, fallback.cameraStrength, 0, 1),
    cameraZoom: readNumber(source.cameraZoom, fallback.cameraZoom, 0, 1),
    cameraZoomSpeed: readNumber(source.cameraZoomSpeed, fallback.cameraZoomSpeed, 0.15, 3),
    showContacts: readBool(source.showContacts, fallback.showContacts),
    railScale: readNumber(source.railScale, fallback.railScale, 0.7, 1.6),
    switchGapSec: readInt(source.switchGapSec, fallback.switchGapSec, 2, 20),
    autoSwitchChat: readBool(source.autoSwitchChat, fallback.autoSwitchChat),
    switchMs: readInt(source.switchMs, fallback.switchMs, 140, 900),
    fontScale: readNumber(source.fontScale, fallback.fontScale, 0.7, 1.7),
    visibleCount: readInt(source.visibleCount, fallback.visibleCount, 3, 14),
    baseRatio: readNumber(source.baseRatio, fallback.baseRatio, 0.45, 0.92),
    widthRatio: readNumber(source.widthRatio, fallback.widthRatio, 0.3, 0.82),
    radius: readNumber(source.radius, fallback.radius, 0.15, 1.3),
    sideMode: readSideMode(source.sideMode, fallback.sideMode),
    bubbleAlpha: readNumber(source.bubbleAlpha, fallback.bubbleAlpha, 0.25, 1),
    unlitOpacity: readNumber(source.unlitOpacity, fallback.unlitOpacity, 0.1, 0.75),
    glow: readNumber(source.glow, fallback.glow, 0, 2),
    showTranslation: readBool(source.showTranslation, fallback.showTranslation),
    showTicks: readBool(source.showTicks, fallback.showTicks),
    showTime: readBool(source.showTime, fallback.showTime),
    showAvatar: readBool(source.showAvatar, fallback.showAvatar),
    showTyping: readBool(source.showTyping, fallback.showTyping),
    splitWords: readBool(source.splitWords, fallback.splitWords),
    splitChars: readInt(source.splitChars, fallback.splitChars, 4, 20),
    splitChance: readNumber(source.splitChance, fallback.splitChance, 0, 1),
    quoteChance: readNumber(source.quoteChance, fallback.quoteChance, 0, 1),
    revokeChance: readNumber(source.revokeChance, fallback.revokeChance, 0, 1),
    revokeMs: readInt(source.revokeMs, fallback.revokeMs, 120, 900),
    showComposer: readBool(source.showComposer, fallback.showComposer),
    draftTyping: readBool(source.draftTyping, fallback.draftTyping),
    sendGrowMs: readInt(source.sendGrowMs, fallback.sendGrowMs, 80, 700),
    enterMs: readInt(source.enterMs, fallback.enterMs, 100, 700),
    enterRise: readNumber(source.enterRise, fallback.enterRise, 0, 3),
    enterDrift: readNumber(source.enterDrift, fallback.enterDrift, 0, 3),
    overshoot: readNumber(source.overshoot, fallback.overshoot, 0, 2.2),
    elasticity: readNumber(source.elasticity, fallback.elasticity, 0, 2),
    enterElastic: readNumber(source.enterElastic, fallback.enterElastic, 0, 2),
    popDepth: readNumber(source.popDepth, fallback.popDepth, 0, 0.5),
    swayAngle: readNumber(source.swayAngle, fallback.swayAngle, 0, 12),
    swaySpeed: readNumber(source.swaySpeed, fallback.swaySpeed, 0.4, 2.2),
    riseSpeed: readNumber(source.riseSpeed, fallback.riseSpeed, 4, 28),
    randomShapes: readBool(source.randomShapes, false),
    shapeChance: readInt(source.shapeChance, 100, 0, 100),
    shapePool: HUAYU_SHAPES.map(([id]) => id).filter(id => Array.isArray(source.shapePool)
      ? source.shapePool.includes(id) : (source.shapeWeights?.[id] ?? 10) > 0),
    shape: readOneOf(source.shape, HUAYU_SHAPES.map(item => item[0]), fallback.shape),
    bubbleStyle: readOneOf(source.bubbleStyle, HUAYU_STYLES.map((item) => item[0]), fallback.bubbleStyle),
    enter: readOneOf(source.enter, HUAYU_ENTERS.map((item) => item[0]), fallback.enter),
    exit: readOneOf(source.exit, HUAYU_EXITS.map((item) => item[0]), fallback.exit),
    tilt: readNumber(source.tilt, fallback.tilt, 0, 2),
    avatarLeftText: readAvatarText(source.avatarLeftText, fallback.avatarLeftText),
    avatarRightText: readAvatarText(source.avatarRightText, fallback.avatarRightText),
    avatarLeftImage: readImage(source.avatarLeftImage),
    avatarRightImage: readImage(source.avatarRightImage),
    avatarShape: readOneOf(source.avatarShape, HUAYU_AVATAR_SHAPES.map((item) => item[0]), fallback.avatarShape),
    bgMode: readOneOf(source.bgMode, HUAYU_BACKDROPS.map((item) => item[0]), fallback.bgMode),
  };
}

function readStored(): HuayuSettings {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...DEFAULT_HUAYU_SETTINGS };
    return normalize(JSON.parse(raw) as Partial<HuayuSettings>);
  } catch {
    return { ...DEFAULT_HUAYU_SETTINGS };
  }
}

/** 舞台每帧直接读这个对象：不复制、不分配，拖动滑杆零延迟。 */
let live: HuayuSettings = readStored();

/** 只读视角：舞台里用，不要改它。 */
export function huayuSettings(): Readonly<HuayuSettings> {
  return live;
}

/** 面板拿草稿副本用。 */
export function currentHuayuSettings(): HuayuSettings {
  return { ...live };
}

/** 面板拖动时把草稿推进画面（不落盘）。 */
export function previewHuayuSettings(value: HuayuSettings): void {
  live = normalize(value);
}

/** 保存到本机并立刻生效。 */
export function saveHuayuSettings(value: HuayuSettings = live): void {
  live = normalize(value);
  try {
    localStorage.setItem(key, JSON.stringify(live));
  } catch {
    /* 本地存档写不进去时不影响当前画面 */
  }
}

/** 取消 / 关面板：丢回本机存档。 */
export function restoreHuayuSettings(): void {
  live = readStored();
}

/** 按歌词顺序计算，跳播、重播均复用相同的历史。 */
export function buildShapeSequence(cfg: Readonly<HuayuSettings>, count: number, random: () => number): HuayuShape[] {
  const pool = cfg.shapePool;
  const lastSeen = pool.map(() => -1);
  return Array.from({ length: count }, (_, line) => {
    let chosen = cfg.shape;
    if (cfg.randomShapes && pool.length && random() * 100 < cfg.shapeChance) {
      // 已连续错过六句时，下一抽为 2 倍；再错过一句升为 3 倍。
      const weights = lastSeen.map(last => Math.max(1, line - last - 5));
      let point = random() * weights.reduce((a, b) => a + b, 0);
      for (let i = 0; i < pool.length; i++) {
        point -= weights[i]!;
        if (point < 0) {
          chosen = pool[i]!;
          break;
        }
      }
    }
    const index = pool.indexOf(chosen);
    if (index >= 0) lastSeen[index] = line;
    return chosen;
  });
}
