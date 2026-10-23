/**
 * 歌词页「播放效果 · 房间」场景引擎。
 *
 * 参照一支薄荷绿音乐视频的静止帧做的：整个画面是一片薄荷绿的纵深空间，
 * 地上有一圈圈白色椭圆环带从画面中下方朝镜头扩出来，形成一条通透的隧道；
 * 歌词被拆成一个个词，打散在隧道里一面「正对镜头」的平面上（前后都有，近大远小），
 * 镜头水平正视前方（与歌词平面严格 90°，不做俯仰），随正在唱的那句平滑向前推进，
 * 所以词会从远处飘过来、亮起来、再从镜头两侧掠过去。底部是一条磨砂长条，写歌名与进度。
 *
 * 这个文件是纯场景引擎：不 import 应用里的任何模块，样式由自己注入，
 * 由 ui/room.ts 包装层负责接到播放器时钟上；也能被独立预览页直接跑。
 */

import { extractLyricKeywords, keywordForWord, type LyricKeyword } from './keywords';
import {
  DEFAULT_ROOM_SETTINGS,
  normalizeRoomSettings,
  type RoomStyleSettings,
} from './roomSettings';

export interface RoomSceneWord {
  text: string;
  startMs: number;
  endMs: number;
  spaceBefore?: boolean;
}

export interface RoomSceneLine {
  timeMs: number;
  durationMs: number;
  text: string;
  translation?: string;
  words: ReadonlyArray<RoomSceneWord>;
}

export interface RoomSceneSong {
  /** 可选：用来给打散布局做种子，同一首歌每次进来词的位置一致。 */
  trackKey?: string;
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  lyricOffsetMs?: number;
  lines: ReadonlyArray<RoomSceneLine>;
}

/** 上方「歌词颜色」档位（纯色 / 封面色 / 自动渐变）传进来的上色信息。 */
export interface RoomLyricTint {
  mode: 'solid' | 'cover' | 'gradient';
  palette: string[];
}

export interface RoomSceneOptions {
  /** 第一帧真正画出来之后回调一次（包装层用它挂 is-ready / is-painted）。 */
  onPainted?: () => void;
  /** 初始观感参数；缺省用 DEFAULT_ROOM_SETTINGS。 */
  style?: Partial<RoomStyleSettings>;
}

export interface RoomScene {
  readonly root: HTMLDivElement;
  /** 更新观感/布局参数；布局类参数会重排并重置镜头到当前句。 */
  setStyle(settings: Partial<RoomStyleSettings>): void;
  setLyricTint(tint: RoomLyricTint | null): void;
  setSong(song: RoomSceneSong | null): void;
  /**
   * 每帧调用一次。positionMs 是播放器位置（毫秒），playing 用来判断要不要推进；
   * energy 是音乐低频能量 0~1（可选，用来让环带随音乐轻轻呼吸）。
   */
  update(positionMs: number, playing: boolean, energy?: number): void;
  resize(): void;
  dispose(): void;
}

/* ── 场景参数（想改观感基本只动这一块） ───────────────────────────── */

/** 换句滚转过渡的阻尼：约 0.6s 转到位，像一次有意的镜头转动。 */
const CAM_ROLL_DAMP = 3.6;

/**
 * 手持镜头晃动：基础幅度（最终会乘上用户设置的 shake 倍率），
 * 只是叠在渲染上的极轻微偏移/偏航/俯仰/滚转，完全不参与歌词运动逻辑。
 */
const SHAKE_YAW = 0.013;
const SHAKE_PITCH = 0.0095;
const SHAKE_ROLL = 0.0075;
const SHAKE_X = 0.055;
const SHAKE_Y = 0.038;

/** 垂直视场角。 */
const FOV_Y = (50 * Math.PI) / 180;
const WORD_MAX_FRAC = 0.18;
const WORD_MIN_FRAC = 0.046;
/** 远处开始起雾、以及完全化进背景的深度。 */
const FOG_NEAR_DEPTH = 6;
const FOG_FAR_DEPTH = 34;

const STYLE_ID = 'zlr-room-style';

/* ── 小工具 ─────────────────────────────────────────────────────── */

const TAU = Math.PI * 2;
const FONT_STACK = "'Zilux2 Sans SC', 'Microsoft YaHei UI', 'Segoe UI', system-ui, sans-serif";
/** 可选字体族：display=系统重字（Noto Black / 雅黑 Bold），yahei=微软雅黑，serif=衬线，system=自带字体。 */
const FONT_FAMILIES: Record<RoomStyleSettings['fontFamily'], string> = {
  display: "'Noto Sans CJK SC', 'Noto Sans SC', 'Microsoft YaHei UI', 'Zilux2 Sans SC', system-ui, sans-serif",
  yahei: "'Microsoft YaHei UI', 'Microsoft YaHei', 'Zilux2 Sans SC', system-ui, sans-serif",
  serif: "'Noto Serif CJK SC', 'Source Han Serif SC', SimSun, serif",
  system: FONT_STACK,
};
const fontStackOf = (family: RoomStyleSettings['fontFamily']): string => FONT_FAMILIES[family];

/** `#rrggbb` → 三个通道；非法值回落到薄荷绿。 */
function hexChannels(hex: string): [number, number, number] {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '7fd6bd';
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}
function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexChannels(hex);
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1).toFixed(3)})`;
}
function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexChannels(a);
  const [r2, g2, b2] = hexChannels(b);
  const k = clamp(t, 0, 1);
  const to = (x: number, y: number): string => Math.round(x + (y - x) * k).toString(16).padStart(2, '0');
  return `#${to(r1, r2)}${to(g1, g2)}${to(b1, b2)}`;
}

/** 在色板里按 0~1 取色（自动渐变用）。 */
function samplePaletteColor(palette: string[], ratio: number): string {
  if (palette.length === 0) return '#ffffff';
  if (palette.length === 1) return palette[0]!;
  const clamped = Math.min(1, Math.max(0, ratio));
  const scaled = clamped * (palette.length - 1);
  const index = Math.min(palette.length - 2, Math.floor(scaled));
  return mixHex(palette[index]!, palette[index + 1]!, scaled - index);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 帧率无关的指数阻尼。 */
function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 确定性随机：同一首歌每次进来的打散位置一致。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const PUNCTUATION_ONLY = /^[\s，。！？、；：,.!?;:'"“”‘’（）()【】[\]…—~～·\-]+$/;

/**
 * QRC/在线歌词常把制作人员名单（「作词：…」「Composed by：…」「Produced by：…」）也塞进歌词流，
 * 这些不是歌词。判断方式：冒号前是很短的标签，且标签是常见制作项。
 */
const CREDIT_LABELS = new Set([
  '作词', '作曲', '编曲', '制作人', '监制', '出品', '发行', '录音', '混音', '母带', '和声',
  '吉他', '贝斯', '鼓', '键盘', '弦乐', '统筹', '策划', '美术', '设计', '词', '曲', 'op', 'sp',
  'composed', 'produced', 'written', 'arranged', 'mixed', 'mastered', 'recorded', 'engineered',
  'performed', 'lyrics', 'lyric', 'music', 'vocals', 'vocal', 'guitar', 'bass', 'drums', 'drum',
  'piano', 'keyboards', 'keyboard', 'strings', 'programming', 'producer', 'composer', 'composers',
  'lyricist', 'lyricists', 'additional', 'background',
]);

// QRC 里也常见「作曲Composer罗凯元」「制作人ProducerTINY7」这种没有冒号、直接拼接的名单行，
// 只按行首标签判断（标签至少两个字符，避免误杀以「曲」开头的正文）。
const CREDIT_PREFIXES: ReadonlyArray<string> = [
  '作曲', '作词', '编曲', '制作人', '制作', '监制', '出品', '发行', '录音', '混音', '母带',
  '和声', '吉他', '贝斯', '键盘', '弦乐', '统筹', '策划', '原唱', '演唱', '词作者', '曲作者',
  'composed', 'composer', 'producer', 'produced', 'lyrics', 'written', 'arranged', 'mix', 'master',
  'recorded', 'engineered', 'performed', 'vocals', 'guitar', 'bass', 'drums', 'piano', 'strings',
  'programming', 'music by', 'op', 'sp',
  'backing', 'chorus', 'project', 'vocals arrangement', 'vocal production', 'vocal editor',
  '配唱', '和音', '伴唱', '人声', '录音师', '混音师',
];

function looksLikeCreditPrefix(text: string): boolean {
  const compact = text.trim().toLowerCase();
  if (compact.length === 0 || compact.length > 40) return false;
  return CREDIT_PREFIXES.some((prefix) => compact.startsWith(prefix));
}

// QRC 还会出现「词Lyricist：林晨阳」「视觉设计VisualDesign：K」「母带后期混音师MasteringEngineer：…」
// 这种「中文角色 + 英文角色 + 冒号」的名单行，角色词库覆盖不到。这里用「冒号前是否出现
// 角色关键词（中英文）」来判断，冒号必须在行首一段内，避免误伤正文里的冒号。
const CREDIT_ROLE_HINT =
  /(作词|作曲|编曲|制作|监制|出品|发行|录音|混音|母带|和声|吉他|贝斯|键盘|弦乐|统筹|策划|营销|文案|视觉|设计|演唱|原唱|配唱|人声|声明|版权|许可|授权|本作品|词|曲|lyric|compos|arrang|produc|mix|master|record|engineer|vocal|guitar|bass|drum|piano|string|program|design|promo|market|publish|director|studio|copyright)/i;

function looksLikeCreditLabeled(text: string): boolean {
  const raw = text.trim();
  if (raw.length === 0 || raw.length > 60) return false;
  const colon = raw.search(/[:：]/);
  if (colon <= 0 || colon > 26) return false;
  return CREDIT_ROLE_HINT.test(raw.slice(0, colon));
}

function creditLabel(text: string): string | null {
  const colon = text.search(/[:：]/);
  if (colon <= 0 || colon > 16) return null;
  const label = text
    .slice(0, colon)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/by$/, '');
  return CREDIT_LABELS.has(label) ? label : null;
}

function looksLikeCredit(text: string): boolean {
  const raw = text.trim();
  if (creditLabel(raw)) return true;
  // QRC/YRC 里也常见「制作人」这种只有标签、没有冒号的单独一行。
  const compact = raw.toLowerCase().replace(/\s+/g, '').replace(/[:：]/g, '');
  return compact.length > 0 && compact.length <= 10 && CREDIT_LABELS.has(compact);
}

/**
 * QRC 有时会把「歌名 (Explicit) - 歌手」当成第一行歌词塞进来（QQ 音乐常见），
 * 这一行不是歌词。只在前两行里判断，避免误伤正常歌词。
 */
function looksLikeMetadata(text: string, index: number, title: string, artist: string): boolean {
  const raw = text.trim();
  if (!raw) return true;
  // 制作名单一般只出现在开头几行，放宽到前 7 行，避免误杀正文里的「词：」类内容。
  if (index <= 6 && looksLikeCredit(raw)) return true;
  if (index > 1) return false;
  const normalize = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[^0-9a-z一-鿿]+/g, '');
  const normalized = normalize(raw);
  const normalizedTitle = normalize(title);
  const normalizedArtist = normalize(artist);
  const hasDash = /\s[-–—]\s/.test(raw);
  const titleHit =
    normalizedTitle.length >= 2 &&
    (normalized.includes(normalizedTitle.slice(0, Math.min(8, normalizedTitle.length))) ||
      normalizedTitle.includes(normalized.slice(0, Math.min(8, normalized.length))));
  const artistHit =
    normalizedArtist.length >= 2 &&
    normalized.includes(normalizedArtist.slice(0, Math.min(6, normalizedArtist.length)));
  return hasDash && (titleHit || artistHit);
}

/** 一句歌词拆成逐词。没有逐词时间（纯 LRC）就按字数把时长均分。 */
function segmentWords(line: RoomSceneLine): Array<{ text: string; startMs: number; endMs: number }> {
  const provided = line.words.filter((word) => word.text.trim().length > 0 && !PUNCTUATION_ONLY.test(word.text));
  if (provided.length > 0) {
    let cursor = line.timeMs;
    return provided.map((word) => {
      const start = Number.isFinite(word.startMs) ? Math.max(line.timeMs, word.startMs) : cursor;
      const end = Number.isFinite(word.endMs) && word.endMs > start ? word.endMs : start + Math.max(80, line.durationMs / provided.length);
      cursor = end;
      return { text: word.text.trim(), startMs: start, endMs: end };
    });
  }
  const tokens = (line.text.match(/[A-Za-z0-9'’\-]+|[^\sA-Za-z0-9'’\-]/g) ?? []).filter(
    (token) => token.trim().length > 0 && !PUNCTUATION_ONLY.test(token),
  );
  if (tokens.length === 0) return [];
  const weights = tokens.map((token) => Math.max(1, token.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const total = Math.max(600, line.durationMs);
  let cursor = line.timeMs;
  return tokens.map((text, index) => {
    const span = (total * weights[index]!) / totalWeight;
    const startMs = cursor;
    cursor += span;
    return { text, startMs, endMs: index === tokens.length - 1 ? line.timeMs + total : cursor };
  });
}

/* ── 样式 ───────────────────────────────────────────────────────── */

const STYLE_CSS = `
.zl-room-scene{position:absolute;inset:0;overflow:hidden;background:var(--zlr-bg,#7fd6bd);isolation:isolate;font-family:var(--zlr-font,${FONT_STACK})}
.zlr-canvas{position:absolute;inset:0;display:block;width:100%;height:100%}
.zlr-grain{position:absolute;inset:0;pointer-events:none;opacity:var(--zlr-grain,.055);mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='.55'/%3E%3C/svg%3E");background-size:140px 140px}
.zlr-words{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.zlr-line{position:absolute;inset:0;pointer-events:none}
.zlr-word{position:absolute;left:0;top:0;transform-origin:50% 50%;white-space:pre;will-change:transform,opacity;
  /* 字体/字重/字距/颜色全部来自设置面板（写在 root 的 CSS 变量上）。 */
  font-family:var(--zlr-font,${FONT_STACK});font-weight:var(--zlr-weight,900);letter-spacing:var(--zlr-track,.004em);
  color:var(--zlr-c0,#fff9f2);
  text-shadow:0 2px 22px rgba(255,255,255,.2),0 12px 32px rgba(19,83,66,.22);}
.zlr-word[data-state="1"]{color:var(--zlr-c1,#fffdfa)}
.zlr-word[data-state="2"]{color:var(--zlr-c2,#ffffff);
  text-shadow:var(--zlr-glow-shadow,0 0 22px rgba(255,255,255,.55),0 0 64px rgba(255,255,255,.26)),0 12px 32px rgba(19,83,66,.24)}
.zlr-titlecard{position:absolute;left:50%;top:44%;z-index:2;transform:translate(-50%,-50%) translateY(14px) scale(.985);
  opacity:0;pointer-events:none;text-align:center;max-width:76%;
  transition:opacity .85s cubic-bezier(.22,1,.36,1),transform 1.05s cubic-bezier(.22,1.08,.36,1)}
.zlr-titlecard.is-on{opacity:1;transform:translate(-50%,-50%) translateY(0) scale(1)}
.zlr-titlecard.is-empty{display:none}
.zlr-titlecard-kicker{display:block;font-size:11px;letter-spacing:.46em;text-indent:.46em;
  color:rgba(255,255,255,.7);margin-bottom:15px;opacity:.9}
.zlr-titlecard-name{display:block;font-family:var(--zlr-font,${FONT_STACK});font-weight:var(--zlr-weight,900);
  letter-spacing:.05em;line-height:1.16;color:var(--zlr-c0,#fff9f2);
  text-shadow:0 4px 26px rgba(20,70,58,.26),0 18px 60px rgba(20,70,58,.18)}
.zlr-titlecard-artist{display:block;margin-top:14px;font-size:14px;letter-spacing:.26em;text-indent:.26em;
  color:rgba(255,255,255,.8);opacity:.92}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_CSS;
  document.head.appendChild(style);
}

/* ── 内部数据结构 ───────────────────────────────────────────────── */

interface WordLayout {
  text: string;
  startMs: number;
  endMs: number;
  /** 词心相对画面中心的偏移（相对宽/高，k=1 时生效）。 */
  nx: number;
  ny: number;
  /** 字号占画面高的比例。 */
  sizeFrac: number;
  /** 相对 FOCUS_DEPTH 的纵深偏移（世界单位），近的词掠过得快，远的慢。 */
  depth: number;
  rot: number;
  /** 入场动画：从唱到该词的那一刻起「从无到有」随机浮现（时长/延迟/位移方向/附加旋转各不相同）。 */
  entMs: number;
  entDelayMs: number;
  entDx: number;
  entDy: number;
  entRot: number;
  span: HTMLSpanElement | null;
  /** 跟随「歌词颜色」时缓存的样式 key（避免每帧写样式） */
  tintKey?: string;
  /** 命中的重点词（关键词），没命中为 null。 */
  keyword?: LyricKeyword | null;
  state: number;
  pop: number;
}

interface LineLayout {
  timeMs: number;
  durationMs: number;
  z: number;
  words: WordLayout[];
}

interface Particle {
  /** 世界坐标：横向（米），相对走廊中心 */
  x: number;
  /** 世界坐标：高度（米），相对相机视线高度 */
  y: number;
  /** 初始深度偏移（米），配合相机前进循环 */
  depth: number;
  /** 相对相机漂移速度（米/秒，正数朝镜头） */
  speed: number;
  /** 世界尺寸（米），投影后换算成像素 */
  size: number;
  alpha: number;
  drift: number;
}

/* ── 场景本体 ───────────────────────────────────────────────────── */

export function createRoomScene(options: RoomSceneOptions = {}): RoomScene {
  ensureStyle();

  /** 当前生效的观感参数（面板 setStyle 时整体替换）。 */
  let cfg: RoomStyleSettings = normalizeRoomSettings(options.style ?? DEFAULT_ROOM_SETTINGS);

  /** 上方「歌词颜色」推下来的上色信息；null = 用房间自己的三态颜色（纯色档）。 */
  let lyricTint: RoomLyricTint | null = null;
  let lyricTintKey = '';

  /** 由「歌词颜色」色板派生出的天空/地毯色（跟随开关打开时使用）。 */
  let tintedSky: { top: string; bottom: string } | null = null;
  let tintedRug: string | null = null;

  const skyTop = (): string => (cfg.bgFollowLyrics && tintedSky ? tintedSky.top : cfg.bgTop);
  const skyBottom = (): string => (cfg.bgFollowLyrics && tintedSky ? tintedSky.bottom : cfg.bgBottom);
  const rugTint = (): string => (cfg.rugFollowLyrics && tintedRug ? tintedRug : cfg.rugColor);

  /** 从上方歌词颜色的色板推导一套和歌词同源的背景/地毯色。 */
  const computeTintColors = (tint: RoomLyricTint | null): void => {
    const palette = tint ? tint.palette.filter((c) => /^#[0-9a-f]{6}$/i.test(c)) : [];
    if (palette.length === 0) {
      tintedSky = null;
      tintedRug = null;
      return;
    }
    const light = palette[0]!;
    const deep = palette[Math.min(palette.length - 1, 2)]!;
    tintedSky = {
      top: mixHex(light, '#ffffff', 0.34),
      bottom: mixHex(deep, '#0f3a31', 0.46),
    };
    tintedRug = mixHex(mixHex(light, '#ffffff', 0.55), '#faf6f0', 0.34);
  };
  /** 整首歌里的重点词（自动提取，两档共用同一套规则）。 */
  let keywords: LyricKeyword[] = [];
  /** 提取重点词用的歌词文本（过滤掉制作名单后的原句）。 */
  let keywordSourceLines: string[] = [];

  /** 设置面板里的字体/颜色/颗粒等直接写成 CSS 变量，逐词渲染就不用每帧改样式。 */
  const applyCssVars = (): void => {
    const style = root.style;
    style.setProperty('--zlr-font', fontStackOf(cfg.fontFamily));
    style.setProperty('--zlr-weight', String(cfg.fontWeight));
    style.setProperty('--zlr-track', `${cfg.letterSpacing}em`);
    style.setProperty('--zlr-c0', cfg.color);
    style.setProperty('--zlr-c1', cfg.sungColor);
    style.setProperty('--zlr-c2', cfg.activeColor);
    style.setProperty('--zlr-grain', String(cfg.grain));
    style.setProperty('--zlr-bg', mixHex(skyTop(), skyBottom(), 0.5));
    const [gr, gg, gb] = hexChannels(cfg.glowColor);
    const glowA = clamp(cfg.glow, 0, 2);
    style.setProperty(
      '--zlr-glow-shadow',
      `0 0 ${(22 * glowA).toFixed(1)}px rgba(${gr},${gg},${gb},${(0.55 * glowA).toFixed(3)}),` +
        `0 0 ${(64 * glowA).toFixed(1)}px rgba(${gr},${gg},${gb},${(0.26 * glowA).toFixed(3)})`,
    );
  };

  const root = document.createElement('div');
  root.className = 'zl-room-scene';

  const canvas = document.createElement('canvas');
  canvas.className = 'zlr-canvas';
  const grain = document.createElement('div');
  grain.className = 'zlr-grain';
  const wordsLayer = document.createElement('div');
  wordsLayer.className = 'zlr-words';

  const emptyEl = document.createElement('div');
  emptyEl.className = 'zlr-empty';
  emptyEl.setAttribute('aria-hidden', 'true');
  const emptyMainEl = document.createElement('span');
  emptyMainEl.className = 'zlr-empty-main';
  emptyMainEl.textContent = '暂无歌词';
  const emptySubEl = document.createElement('span');
  emptySubEl.className = 'zlr-empty-sub';
  emptySubEl.textContent = '纯音乐，慢慢听';
  emptyEl.append(emptyMainEl, emptySubEl);

  // 前奏歌名卡：第一句歌词开口前在画面中央显示歌名/歌手，开口后自动淡出。
  const titleCardEl = document.createElement('div');
  titleCardEl.className = 'zlr-titlecard';
  titleCardEl.setAttribute('aria-hidden', 'true');
  const titleKickerEl = document.createElement('span');
  titleKickerEl.className = 'zlr-titlecard-kicker';
  titleKickerEl.textContent = 'NOW PLAYING';
  const titleNameEl = document.createElement('span');
  titleNameEl.className = 'zlr-titlecard-name';
  const titleArtistEl = document.createElement('span');
  titleArtistEl.className = 'zlr-titlecard-artist';
  titleCardEl.append(titleKickerEl, titleNameEl, titleArtistEl);

  root.append(canvas, grain, wordsLayer, titleCardEl, emptyEl);
  applyCssVars();

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('room scene: canvas 2d context unavailable');

  const measureCtx = document.createElement('canvas').getContext('2d');
  const measure = (text: string, sizePx: number): number => {
    if (!measureCtx) return text.length * sizePx * 0.72;
    measureCtx.font = `${cfg.fontWeight} ${sizePx.toFixed(2)}px ${fontStackOf(cfg.fontFamily)}`;
    return measureCtx.measureText(text).width;
  };

  let disposed = false;
  let painted = false;
  let song: RoomSceneSong | null = null;
  let lastSongKey = '';
  let lines: LineLayout[] = [];
  let songKey = '';
  let sizeW = 0;
  let sizeH = 0;
  let dpr = 1;
  let activeIndex = -1;
  // 镜头/排版跟随的行：行间间奏时停在上一条已唱过的句子，避免打开房间时整屏空字。
  let displayFocus = 0;
  let camZ: number | null = null;
  let camRoll = 0;
  /** 每句歌词的目标滚转角（确定性随机：方向随机、大小随机）。 */
  let rolls: number[] = [];
  /** 当前帧实际用的相机位置（camZ 可能为 null，这里统一成 0）。 */
  const camView = { x: 0, y: cfg.camHeight, z: 0 };
  // 手持晃动（纯渲染层叠加，不参与歌词运动）：位置偏移 + 极小的偏航/俯仰/滚转。
  let shakeX = 0;
  let shakeY = 0;
  let shakeRoll = 0;
  // 每帧缓存一次三角值，避免每个词都算 sin/cos。
  let camCosRoll = 1;
  let camSinRoll = 0;
  let camRollEff = 0;
  let camCosYaw = 1;
  let camSinYaw = 0;
  let camCosPitch = 1;
  let camSinPitch = 0;
  let lastPositionMs = 0;
  let lastNow = 0;
  let clockNow = 0;
  let energyNow = 0;
  let emptyTimer: number | null = null;
  let emptyShown = false;
  let introTitleShown = false;
  let titleSizeCached = -1;

  /** 前奏歌名卡显隐（只在状态变化时改 class，避免每帧写样式）。 */
  const setIntroTitleShown = (next: boolean): void => {
    if (next === introTitleShown) return;
    introTitleShown = next;
    titleCardEl.classList.toggle('is-on', next);
    titleCardEl.setAttribute('aria-hidden', next ? 'false' : 'true');
  };

  const syncTitleCard = (): void => {
    const name = song?.title?.trim() ?? '';
    const artist = song?.artist?.trim() ?? '';
    if (titleNameEl.textContent !== name) titleNameEl.textContent = name;
    if (titleArtistEl.textContent !== artist) titleArtistEl.textContent = artist;
    titleCardEl.classList.toggle('is-empty', name.length === 0);
    if (name.length === 0) setIntroTitleShown(false);
  };

  /** 没有歌词时才显示「暂无歌词」：给 0.9s 容错，避免歌词晚到时闪一下提示。 */
  const setEmptyShown = (next: boolean): void => {
    if (next === emptyShown) return;
    emptyShown = next;
    emptyEl.classList.toggle('is-on', next);
    emptyEl.setAttribute('aria-hidden', next ? 'false' : 'true');
  };
  const syncEmptyState = (hasLyrics: boolean): void => {
    if (emptyTimer !== null) {
      window.clearTimeout(emptyTimer);
      emptyTimer = null;
    }
    if (hasLyrics) {
      setEmptyShown(false);
      return;
    }
    emptyTimer = window.setTimeout(() => {
      emptyTimer = null;
      if (disposed) return;
      setEmptyShown(true);
    }, 900);
  };

  const lineEls = new Map<number, HTMLDivElement>();
  const lineAlpha = new Map<number, number>();
  let particles: Particle[] = [];
  let particlesCount = -1;
  const rebuildParticles = (): void => {
    const random = mulberry32(0x51f3a2c7);
    particles = Array.from({ length: cfg.particleCount }, () => ({
      x: (random() * 2 - 1) * 2.4,
      y: (random() * 2 - 1) * 0.95 + 0.12,
      depth: random() * 30,
      speed: 0.5 + random() * 1.5,
      size: 0.014 + random() * 0.05,
      alpha: 0.1 + random() * 0.2,
      drift: 0.2 + random() * 0.8,
    }));
    particlesCount = cfg.particleCount;
  };

  /* ── 尺寸 ─────────────────────────────────────────────────── */

  const readSize = (): void => {
    const width = root.clientWidth || window.innerWidth || 1200;
    const height = root.clientHeight || window.innerHeight || 800;
    const nextDpr = clamp(window.devicePixelRatio || 1, 1, cfg.dpr);
    if (width === sizeW && height === sizeH && nextDpr === dpr) return;
    sizeW = width;
    sizeH = height;
    dpr = nextDpr;
    canvas.width = Math.max(2, Math.round(width * dpr));
    canvas.height = Math.max(2, Math.round(height * dpr));
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      for (const word of line.words) {
        if (word.span) word.span.style.fontSize = `${(word.sizeFrac * sizeH * (cfg.keywordColors && word.keyword ? cfg.keywordScale : 1)).toFixed(2)}px`;
      }
    }
  };

  const resizeObserver = new ResizeObserver(() => {
    readSize();
  });
  resizeObserver.observe(root);

  /* ── 逐词打散布局 ─────────────────────────────────────────── */

  const placeLine = (
    tokens: Array<{ text: string; startMs: number; endMs: number }>,
    seed: number,
    width: number,
    height: number,
  ): WordLayout[] => {
    if (tokens.length === 0) return [];
    const areaHalfW = cfg.spreadX * width;
    const top = -cfg.areaTop * height;
    const bottom = -cfg.areaBottom * height;
    const areaHeight = Math.max(1, bottom - top);
    const pad = height * 0.03;
    // 1500×960 下安全区只有约 254px 高：词再多不给它足够行数，随机撒点怎么撒都会叠字。
    // 先按「至少要几行」把字号封顶，再随机撒点 —— 既有随机感，又不会退化成一行排开。
    const rowsNeeded = tokens.length <= 4 ? 1 : tokens.length <= 8 ? 2 : 3;
    const sizeCap = (areaHeight / rowsNeeded - pad) / 1.16;
    let baseFrac = clamp(0.42 / Math.pow(tokens.length, 0.6), WORD_MIN_FRAC, WORD_MAX_FRAC) * cfg.sizeScale;
    baseFrac = Math.min(baseFrac, sizeCap / height);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const random = mulberry32((seed + attempt * 0x9e3779b1) >>> 0);
      const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
      const result: WordLayout[] = [];
      let failed = false;
      for (const token of tokens) {
        const sizeFrac = baseFrac * (0.94 + random() * 0.12);
        let sizePx = sizeFrac * height;
        let textWidth = measure(token.text, sizePx) + sizePx * 0.06;
        const maxWidth = width * 0.82;
        if (textWidth > maxWidth) {
          const scale = maxWidth / textWidth;
          sizePx *= scale;
          textWidth = maxWidth;
        }
        const textHeight = sizePx * 1.16;
        const halfW = Math.max(1, Math.min(areaHalfW - textWidth / 2, areaHalfW * 0.96));
        const usableTop = top + textHeight / 2;
        const usableBottom = bottom - textHeight / 2;
        let box: { x: number; y: number; w: number; h: number } | null = null;
        for (let tries = 0; tries < 700; tries += 1) {
          const cx = (random() * 2 - 1) * Math.max(0, halfW);
          const span = Math.max(1, usableBottom - usableTop);
          const cy = usableTop + random() * span;
          const candidate = { x: cx, y: cy, w: textWidth + pad * 1.2, h: textHeight + pad };
          let overlap = false;
          for (const placed of boxes) {
            if (Math.abs(placed.x - candidate.x) < (placed.w + candidate.w) / 2 &&
              Math.abs(placed.y - candidate.y) < (placed.h + candidate.h) / 2) {
              overlap = true;
              break;
            }
          }
          if (!overlap) {
            box = candidate;
            break;
          }
        }
        if (!box) {
          failed = true;
          break;
        }
        boxes.push(box);
        result.push({
          text: token.text,
          startMs: token.startMs,
          endMs: token.endMs,
          nx: box.x / width,
          ny: box.y / height,
          sizeFrac: sizePx / height,
          depth: (random() * 1.6 - 0.7) * cfg.depthSpread,
          rot: (random() * 2 - 1) * cfg.rotation,
          entMs: cfg.entrance ? (200 + random() * 220) * Math.max(0.001, cfg.entranceMs / 320) : 0.001,
          entDelayMs: cfg.entrance ? random() * 70 : 0,
          entDx: (random() * 2 - 1) * 30,
          entDy: (random() * 2 - 1) * 24,
          entRot: (random() * 2 - 1) * 3.2,
          span: null,
          state: -1,
          pop: 0,
        });
      }
      if (!failed) return result;
      baseFrac *= 0.86;
    }
    // 极端情况（窄窗口/超长行）兜底：均匀铺开，保证不叠字。
    const result: WordLayout[] = [];
    const count = Math.max(1, tokens.length);
    tokens.forEach((token, index) => {
      result.push({
        text: token.text,
        startMs: token.startMs,
        endMs: token.endMs,
        nx: (index / (count - 1) - 0.5) * 0.72,
        ny: 0,
        sizeFrac: WORD_MIN_FRAC * cfg.sizeScale,
        depth: 0,
        rot: 0,
        entMs: cfg.entrance ? Math.max(1, cfg.entranceMs) : 0.001,
        entDelayMs: index * 40,
        entDx: 0,
        entDy: 18,
        entRot: 0,
        span: null,
        state: -1,
        pop: 0,
      });
    });
    return result;
  };

  /** 把一句拆回纯文本：优先用原始 text，没有就用词条拼（按 spaceBefore 补回空格）。 */
  const lineTextOf = (line: RoomSceneLine): string => {
    const raw = line.text.trim();
    if (raw) return raw;
    return line.words
      .map((word, index) => `${index > 0 && word.spaceBefore ? ' ' : ''}${word.text}`)
      .join('');
  };

  /** 根据当前「歌词颜色」色板重算重点词，并给每个词挂上命中的关键词。 */
  const refreshKeywords = (): void => {
    // 纯色档的色板是「暖白三色」，重点词用它就看不出来了；这时退回香槟金三色（和纯字档一致）。
    const palette =
      lyricTint && lyricTint.mode !== 'solid' && lyricTint.palette.length > 0 ? lyricTint.palette : null;
    keywords = extractLyricKeywords(
      keywordSourceLines.map((text) => ({ text, words: [] })),
      palette,
    );
    for (const line of lines) {
      for (const word of line.words) word.keyword = keywordForWord(word.text, keywords);
    }
  };

  const buildLayout = (input: RoomSceneSong): void => {
    const width = sizeW || window.innerWidth || 1200;
    const height = sizeH || window.innerHeight || 800;
    // 制作名单常常是「制作人：」独立一行 + 后面几行名字（甚至一个名字一行），
    // 所以除了按单行特征过滤，还要在开头连续块里做「标签行之后的短行也跳过」。
    let inCreditBlock = false;
    const lyricLines = input.lines.filter((line, index) => {
      if (index <= 40 && looksLikeCreditPrefix(line.text)) {
        inCreditBlock = true;
        return false;
      }
      if (index <= 40 && looksLikeCreditLabeled(line.text)) {
        inCreditBlock = true;
        return false;
      }
      if (looksLikeMetadata(line.text, index, input.title ?? '', input.artist ?? '')) {
        inCreditBlock = true;
        return false;
      }
      if (index <= 20 && inCreditBlock) {
        const raw = line.text.trim();
        const short = raw.length > 0 && raw.length <= 12;
        const prose = /[，。！？、,.!?]/.test(raw);
        // 真正的歌词（尤其中文）几乎一定会带「的了是在有我你他她它们…这类虚词」；
        // 制作名单里的名字/角色通常不带。以前只按「短且无标点」判断，会把开头
        // 十几秒的短句歌词（如「那是一座座山连着山的小村庄」）一起吃掉，
        // 导致房间效果在歌曲开头出现几十秒空窗。
        const lyricish = /[的了是在有我你他她它们吗呢吧啊这那都很又还也把被让给对从向于与和及就才再没不太过到说看想要会能可]/.test(raw);
        if (short && !prose && !lyricish) return false;
      }
      inCreditBlock = false;
      return true;
    });
    songKey = `${input.trackKey ?? ''}|${input.title}|${input.artist}|${lyricLines.length}`;
    // 镜头轨迹：默认往前推进一句，有 PULL_CHANCE 的概率改成往后拉 —— 这时新句的平面会先落在
    // 镜头身后（相对新相机 depth = FOCUS_DEPTH - PULL_DISTANCE < 0），相机退回来才把它拉进画面。
    const pathRandom = mulberry32(hashSeed(`${songKey}::camera`));
    let camPath = 0;
    const cameraPath = lyricLines.map((_, index) => {
      if (index > 0) camPath += pathRandom() < cfg.pullChance ? cfg.pullDistance : -cfg.lineGap;
      return camPath;
    });
    // 换句时画面滚转到一个新的随机角度：方向和大小都随机 —— 上一句左倾，下一句可能就右倾。
    const rollRandom = mulberry32(hashSeed(`${songKey}::roll`));
    rolls = lyricLines.map((_, index) => {
      if (index === 0) return 0;
      const direction = rollRandom() < 0.5 ? -1 : 1;
      const rollMin = (cfg.rollMin * Math.PI) / 180;
      const rollMax = Math.max(rollMin, (cfg.rollMax * Math.PI) / 180);
      return direction * (rollMin + rollRandom() * (rollMax - rollMin));
    });
    lines = lyricLines.map((line, index) => ({
      timeMs: line.timeMs,
      durationMs: Math.max(300, line.durationMs),
      z: (cameraPath[index] ?? 0) - cfg.focusDepth,
      words: placeLine(segmentWords(line), hashSeed(`${songKey}#${index}`), width, height),
    }));
    keywordSourceLines = lyricLines.map(lineTextOf);
    refreshKeywords();
    activeIndex = -1;
    camZ = null;
    particlesCount = -1;
    lineAlpha.clear();
    for (const el of lineEls.values()) el.remove();
    lineEls.clear();
  };

  const relayout = (): void => {
    if (song) {
      buildLayout(song);
      readSize();
    }
  };

  // 字体加载完再排一次版：刚打开时量出来的字宽可能还是回退字体的。
  if (document.fonts && typeof document.fonts.ready?.then === 'function') {
    void document.fonts.ready.then(() => {
      if (disposed) return;
      relayout();
    });
  }

  /* ── 行元素管理 ───────────────────────────────────────────── */

  const dropLineEl = (index: number): void => {
    const el = lineEls.get(index);
    if (!el) return;
    el.remove();
    lineEls.delete(index);
    const line = lines[index];
    if (line) for (const word of line.words) word.span = null;
    lineAlpha.delete(index);
  };

  const ensureLineEl = (index: number): HTMLDivElement | null => {
    const existing = lineEls.get(index);
    if (existing) return existing;
    const line = lines[index];
    if (!line) return null;
    const el = document.createElement('div');
    el.className = 'zlr-line';
    el.style.zIndex = String(600 - index);
    for (const word of line.words) {
      const span = document.createElement('span');
      span.className = 'zlr-word';
      span.textContent = word.text;
      span.style.fontSize = `${(word.sizeFrac * sizeH * (cfg.keywordColors && word.keyword ? cfg.keywordScale : 1)).toFixed(2)}px`;
      span.style.opacity = '0';
      span.dataset.state = '0';
      el.appendChild(span);
      word.span = span;
      word.state = 0;
    }
    wordsLayer.appendChild(el);
    lineEls.set(index, el);
    return el;
  };

  /* ── 播放位置 ─────────────────────────────────────────────── */

  const indexAt = (timeMs: number): number => {
    if (lines.length === 0) return -1;
    const lyricTime = timeMs - 1;
    if (lyricTime < lines[0]!.timeMs) return 0;
    let low = 0;
    let high = lines.length - 1;
    let answer = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const line = lines[mid]!;
      if (line.timeMs <= lyricTime) {
        answer = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return answer;
  };

  const lineProgressAt = (index: number, timeMs: number): number => {
    const line = lines[index];
    if (!line) return 0;
    return clamp((timeMs - line.timeMs) / Math.max(360, line.durationMs), 0, 1);
  };

  /* ── 背景绘制 ─────────────────────────────────────────────── */

  let gradientCache: CanvasGradient | null = null;
  let glowCache: CanvasGradient | null = null;
  let bloomCache: CanvasGradient | null = null;
  let vignetteCache: CanvasGradient | null = null;
  let cacheW = 0;
  let cacheH = 0;

  const rebuildGradients = (width: number, height: number): void => {
    // 渐变方向：0° = 从上到下，90° = 从左到右（和 CSS linear-gradient 的角度手感一致）。
    const angle = (cfg.bgAngle * Math.PI) / 180;
    const dirX = Math.sin(angle);
    const dirY = Math.cos(angle);
    const span = Math.hypot(width, height) * 0.62;
    const cx = width * 0.5;
    const cy = height * 0.5;
    const sky = ctx.createLinearGradient(cx - dirX * span, cy - dirY * span, cx + dirX * span, cy + dirY * span);
    const top = skyTop();
    const bottom = skyBottom();
    sky.addColorStop(0, top);
    sky.addColorStop(0.35, mixHex(top, bottom, 0.35));
    sky.addColorStop(0.7, mixHex(top, bottom, 0.72));
    sky.addColorStop(1, bottom);
    gradientCache = sky;

    const glowStrength = clamp(cfg.centerGlow, 0, 1);
    const glow = ctx.createRadialGradient(width * 0.5, height * 0.44, 0, width * 0.5, height * 0.44, width * 0.32);
    glow.addColorStop(0, `rgba(255,252,246,${(0.2 * glowStrength).toFixed(3)})`);
    glow.addColorStop(0.55, `rgba(255,252,246,${(0.075 * glowStrength).toFixed(3)})`);
    glow.addColorStop(1, 'rgba(255,252,246,0)');
    glowCache = glow;

    const bloom = ctx.createRadialGradient(width * 0.12, height * 0.03, 0, width * 0.12, height * 0.03, width * 0.62);
    bloom.addColorStop(0, 'rgba(255,255,252,.3)');
    bloom.addColorStop(0.4, 'rgba(255,255,252,.12)');
    bloom.addColorStop(1, 'rgba(255,255,252,0)');
    bloomCache = bloom;

    const vignetteStrength = clamp(cfg.vignette, 0, 1);
    const vignette = ctx.createRadialGradient(
      width * 0.5,
      height * 0.46,
      height * 0.24,
      width * 0.5,
      height * 0.5,
      width * 0.78,
    );
    vignette.addColorStop(0, 'rgba(18,74,60,0)');
    vignette.addColorStop(0.55, `rgba(16,72,58,${(0.06 * (vignetteStrength / 0.42)).toFixed(3)})`);
    vignette.addColorStop(1, `rgba(10,58,47,${vignetteStrength.toFixed(3)})`);
    vignetteCache = vignette;

    cacheW = width;
    cacheH = height;
  };

  /**
   * 流星：每条都有固定的世界 X/Y 基准点与一条向镜头方向循环推进的深度轨道。
   * 头部与尾部各自做一次 projectWorld 投影，得到的线段就是「从灭点附近朝镜头飞来」的轨迹；
   * 镜头前进/后退、偏航、滚转、手持晃动都会让整条轨迹跟着变（真 3D，不是屏幕空间斜线）。
   */
  const drawMeteors = (time: number): void => {
    const count = Math.round(cfg.streakCount);
    if (count <= 0 || cfg.streakStrength <= 0) return;
    const random = mulberry32(0x2f6e1b3d);
    const speed = clamp(cfg.streakSpeed, 0.05, 4);
    const tailScale = clamp(cfg.streakLength, 0.01, 1);
    const widthScale = clamp(cfg.streakWidth, 0.3, 2.5);
    const tau = Math.PI * 2;
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < count; i += 1) {
      const angle = random() * tau;
      const reach = 0.7 + random() * 5.2;
      const bx = Math.cos(angle) * reach;
      const by = Math.sin(angle) * reach * 0.72;
      const vx = (random() * 2 - 1) * 0.12;
      const vy = (random() * 2 - 1) * 0.08;
      const period = 2100 + random() * 3800;
      const phase0 = random();
      const toward = random() < 0.72;
      const strength = 0.55 + random() * 0.45;
      const tRaw = (time * speed) / period + phase0;
      const t = tRaw - Math.floor(tRaw);
      const envelope = Math.sin(Math.PI * t);
      if (envelope <= 0.02) continue;
      const nearDepth = 1.4;
      const farDepth = 30;
      // 头部深度：toward 从远到近；away 从近到远。两条端点都投影，线段自然带透视长度。
      const headDepth = toward ? farDepth - (farDepth - nearDepth) * t : nearDepth + (farDepth - nearDepth) * t;
      const trail = 2 + tailScale * 13;
      const tailDepth = toward ? headDepth + trail : Math.max(nearDepth * 0.9, headDepth - trail);
      const drift = time * 0.00012;
      const head = projectWorld(bx + vx * 40 + Math.sin(drift + i) * 0.12, by + vy * 40 + Math.cos(drift * 1.3 + i) * 0.1, camView.z - headDepth);
      const tail = projectWorld(bx + vx * 40 + Math.sin(drift + i) * 0.12, by + vy * 40 + Math.cos(drift * 1.3 + i) * 0.1, camView.z - tailDepth);
      const lengthPx = Math.hypot(head.x - tail.x, head.y - tail.y);
      if (lengthPx < 2) continue;
      const near = clamp(1 - (headDepth - nearDepth) / (farDepth - nearDepth), 0, 1);
      const alpha = (0.16 + near * 0.55) * cfg.streakStrength * envelope * strength * (toward ? 1 : 0.55);
      // 远端与镜头贴脸时都淡出，避免突然出现/消失
      const farFade = clamp((farDepth - headDepth) / 6, 0, 1);
      const nearFade = clamp((headDepth - nearDepth) / 1.6, 0, 1);
      const fade = alpha * farFade * nearFade;
      if (fade <= 0.01) continue;
      const thickness = (0.7 + near * 2.2) * clamp(cfg.streakStrength, 0.2, 3) * 0.8 * widthScale;
      // 外层柔光
      ctx.strokeStyle = `rgba(255,255,255,${(fade * 0.3).toFixed(3)})`;
      ctx.lineWidth = thickness * (2.4 + near * 3.2);
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      ctx.lineTo(head.x, head.y);
      ctx.stroke();
      // 内层亮芯（尾淡头亮）
      const grad = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.55, `rgba(255,255,255,${(fade * 0.5).toFixed(3)})`);
      grad.addColorStop(1, `rgba(255,255,255,${fade.toFixed(3)})`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = thickness * (0.7 + near * 1.6);
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      ctx.lineTo(head.x, head.y);
      ctx.stroke();
      // 头部光斑
      const glowRadius = (2 + near * 6) * (0.6 + 0.4 * widthScale);
      if (glowRadius > 2.2) {
        const headGlow = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, glowRadius);
        headGlow.addColorStop(0, `rgba(255,255,255,${Math.min(1, fade * 1.8).toFixed(3)})`);
        headGlow.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = headGlow;
        ctx.beginPath();
        ctx.arc(head.x, head.y, glowRadius, 0, tau);
        ctx.fill();
      }
    }
    ctx.restore();
  };

  /**
   * 把世界坐标投影到屏幕：歌词相机本身始终正对 -Z（只有画面滚转 roll），
   * 上面再叠一层极轻微的手持晃动（位置偏移 + 微小 pitch/yaw + roll），
   * 按焦距透视后统一做画面滚转。返回屏幕坐标和相机深度（沿视线方向的米数）。
   */
  const projectWorld = (wx: number, wy: number, wz: number): { x: number; y: number; depth: number } => {
    const dx = wx - camView.x;
    const dy = wy - camView.y;
    const dz = wz - camView.z;
    // 晃动用的小角度 pitch → yaw（量级 0.005rad 以内，肉眼只当轻微呼吸感）
    const y1 = dy * camCosPitch - dz * camSinPitch;
    const z1 = dy * camSinPitch + dz * camCosPitch;
    const x2 = dx * camCosYaw - z1 * camSinYaw;
    const z2 = dx * camSinYaw + z1 * camCosYaw;
    const depth = Math.max(0.05, -z2);
    const focal = (sizeH * 0.5) / Math.tan(FOV_Y * 0.5);
    const rx = (focal * x2) / depth;
    const ry = (-focal * y1) / depth;
    return {
      x: sizeW * 0.5 + rx * camCosRoll - ry * camSinRoll,
      y: sizeH * 0.5 + rx * camSinRoll + ry * camCosRoll,
      depth,
    };
  };

  /**
   * 地上的长条地毯：一条矩形绒毯从脚下一直铺向远处，透视后是白色梯形。
   * 毯面横向织纹按世界坐标等距排布，镜头推/拉/偏转时纹路会跟着滚动、形状随之变斜 ——
   * 运动方向（往前推 / 往回拉 / 镜头偏）用织纹和毯边一眼就能读出来。远端化进空气里，不留硬切口。
   */
  const drawRug = (width: number, time: number): void => {
    if (!cfg.rugVisible || cfg.rugOpacity <= 0) return;
    const rugOpacity = clamp(cfg.rugOpacity, 0, 1);
    // 织纹的缓慢滚动：只让「织纹条带」相对镜头往后流，地毯的两个端头始终钉在相机前后固定深度上。
    // （早先用 camZEff 同时移动端头，页面开久了 time 变大，整条毯子会一路缩到灭点附近，看起来就是「长条不见了」。）
    const scroll = (time * 0.00018) % cfg.rugBandGap;
    const nearZ = camView.z - cfg.rugNear;
    const farZ = camView.z - cfg.rugFar;
    const halfW = cfg.rugWidth;
    const nearY = projectWorld(0, 0, nearZ).y;
    const farY = projectWorld(0, 0, farZ).y;
    ctx.save();

    // 毯体：近处实、远处淡，最后化进薄荷绿里。
    const leftNear = projectWorld(-halfW, 0, nearZ);
    const rightNear = projectWorld(halfW, 0, nearZ);
    const leftFar = projectWorld(-halfW, 0, farZ);
    const rightFar = projectWorld(halfW, 0, farZ);
    const body = new Path2D();
    body.moveTo(leftNear.x, leftNear.y);
    body.lineTo(leftFar.x, leftFar.y);
    body.lineTo(rightFar.x, rightFar.y);
    body.lineTo(rightNear.x, rightNear.y);
    body.closePath();
    const bodyGradient = ctx.createLinearGradient(0, farY, 0, nearY);
    bodyGradient.addColorStop(0, rgba(rugTint(), 0));
    bodyGradient.addColorStop(0.12, rgba(rugTint(), 0.34 * rugOpacity));
    bodyGradient.addColorStop(0.42, rgba(rugTint(), 0.72 * rugOpacity));
    bodyGradient.addColorStop(1, rgba(rugTint(), 0.92 * rugOpacity));
    ctx.fillStyle = bodyGradient;
    ctx.shadowColor = rgba(rugTint(), 0.4 * rugOpacity);
    ctx.shadowBlur = Math.max(10, width * 0.014);
    ctx.fill(body);
    ctx.shadowBlur = 0;

    // 横向织纹：世界坐标等距的薄条带，近粗远细；条带按 scroll 朝镜头缓慢流动，读得出前进感。
    const bandHalf = cfg.rugBandGap * 0.14;
    const bandBase = camView.z - scroll;
    const firstBand = Math.ceil((bandBase - cfg.rugFar) / cfg.rugBandGap);
    const lastBand = Math.floor((bandBase - cfg.rugNear) / cfg.rugBandGap);
    for (let band = firstBand; band <= lastBand; band += 1) {
      const worldZ = band * cfg.rugBandGap + scroll;
      const depthMid = camView.z - worldZ;
      const fog = smoothstep(cfg.rugFar * 1.2, cfg.rugFar * 0.32, depthMid);
      const nearFade = smoothstep(cfg.rugNear * 0.92, cfg.rugNear * 1.9, depthMid);
      // 每 4 条来一道宽一点的深色横纹，毯面才有织出来的节奏，而不是一块平滑的板。
      const accent = band % 4 === 0 ? 1.6 : 1;
      const alpha = 0.24 * accent * fog * nearFade * rugOpacity;
      if (alpha <= 0.004) continue;
      const bandFarL = projectWorld(-halfW, 0, worldZ - bandHalf);
      const bandFarR = projectWorld(halfW, 0, worldZ - bandHalf);
      const bandNearR = projectWorld(halfW, 0, worldZ + bandHalf);
      const bandNearL = projectWorld(-halfW, 0, worldZ + bandHalf);
      ctx.beginPath();
      ctx.moveTo(bandFarL.x, bandFarL.y);
      ctx.lineTo(bandFarR.x, bandFarR.y);
      ctx.lineTo(bandNearR.x, bandNearR.y);
      ctx.lineTo(bandNearL.x, bandNearL.y);
      ctx.closePath();
      ctx.fillStyle = rgba(mixHex(rugTint(), '#7f9a8f', 0.55), alpha);
      ctx.fill();
    }

    // 两侧缝线，让长条更像一条真实地毯，而不是一块色块。
    for (const side of [-1, 1]) {
      const x = side * (halfW - 0.13);
      const edgeNear = projectWorld(x, 0, nearZ);
      const edgeFar = projectWorld(x, 0, farZ);
      const stitchGradient = ctx.createLinearGradient(0, farY, 0, nearY);
      stitchGradient.addColorStop(0, rgba(mixHex(rugTint(), '#7f9a8f', 0.55), 0));
      stitchGradient.addColorStop(0.5, rgba(mixHex(rugTint(), '#7f9a8f', 0.55), 0.2 * rugOpacity));
      stitchGradient.addColorStop(1, rgba(mixHex(rugTint(), '#7f9a8f', 0.55), 0.42 * rugOpacity));
      ctx.strokeStyle = stitchGradient;
      ctx.lineWidth = Math.max(1.4, width * 0.002);
      ctx.beginPath();
      ctx.moveTo(edgeFar.x, edgeFar.y);
      ctx.lineTo(edgeNear.x, edgeNear.y);
      ctx.stroke();
    }

    // 远端化进空气：沿织纹方向做线性渐隐（裁切在地毯形状内），避免出现一块突兀的椭圆色斑。
    const haze = mixHex(skyTop(), skyBottom(), 0.45);
    const dissolve = ctx.createLinearGradient(0, farY, 0, farY + (nearY - farY) * 0.26);
    dissolve.addColorStop(0, rgba(haze, 0.96));
    dissolve.addColorStop(0.4, rgba(haze, 0.58));
    dissolve.addColorStop(1, rgba(haze, 0));
    ctx.save();
    ctx.clip(body);
    ctx.fillStyle = dissolve;
    ctx.fillRect(Math.min(leftFar.x, leftNear.x) - 2, farY - 40, Math.abs(rightFar.x - leftFar.x) + 4, nearY - farY + 80);
    ctx.restore();
    ctx.restore();
  };

  let particleDebug: Array<{ x: number; y: number; radius: number; alpha: number; depth: number }> = [];

  const drawParticles = (width: number, height: number, time: number): void => {
    if (Math.round(cfg.particleCount) !== particlesCount) rebuildParticles();
    if (width < 2 || height < 2) return;
    const focal = (height * 0.5) / Math.tan(FOV_Y / 2);
    const range = 30;
    const near = 1.2;
    const camZ = camView.z;
    const debug: Array<{ x: number; y: number; radius: number; alpha: number; depth: number }> = [];
    ctx.save();
    for (const particle of particles) {
      // 深度循环：相机前进时 particles 从远处靠近、掠过镜头后回到远处
      const raw = camZ + particle.depth + time * 0.001 * particle.speed;
      const depth = (((raw - near) % range) + range) % range + near;
      const wobbleX = Math.sin(time * 0.00013 * particle.drift + particle.depth) * 0.07;
      const wobbleY = Math.cos(time * 0.00011 * particle.drift * cfg.particleDrift + particle.depth * 1.7) * 0.05;
      const projected = projectWorld(particle.x + wobbleX, particle.y + wobbleY, camZ - depth);
      const radius = Math.min(9, Math.max(0.35, ((particle.size * cfg.particleSize) * focal) / depth));
      const nearFade = Math.min(1, Math.max(0, (depth - near) / 1.4));
      const farFade = Math.min(1, Math.max(0, (range - depth) / 9));
            const alpha = particle.alpha * cfg.particleBrightness * nearFade * farFade * 0.9;
      debug.push({ x: Math.round(projected.x), y: Math.round(projected.y), radius, alpha, depth });
      if (alpha <= 0.004) continue;
      const glow = radius * 2.6;
      const grad = ctx.createRadialGradient(projected.x, projected.y, 0, projected.x, projected.y, glow);
      grad.addColorStop(0, `rgba(255,252,246,${alpha.toFixed(3)})`);
      grad.addColorStop(0.45, `rgba(255,252,246,${(alpha * 0.4).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(255,252,246,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(projected.x, projected.y, glow, 0, TAU);
      ctx.fill();
    }
    particleDebug = debug;
    ctx.restore();
  };

  const drawBackground = (time: number): void => {
    const width = sizeW;
    const height = sizeH;
    if (width < 2 || height < 2) return;
    if (cacheW !== width || cacheH !== height || !gradientCache || !glowCache || !vignetteCache || !bloomCache) {
      rebuildGradients(width, height);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (gradientCache) {
      ctx.fillStyle = gradientCache;
      ctx.fillRect(0, 0, width, height);
    }
    drawMeteors(time);
    if (glowCache) {
      ctx.fillStyle = glowCache;
      ctx.fillRect(0, 0, width, height);
    }
    if (bloomCache) {
      ctx.fillStyle = bloomCache;
      ctx.fillRect(0, 0, width, height);
    }
    drawRug(width, time);
    drawParticles(width, height, time);

    if (vignetteCache) {
      ctx.fillStyle = vignetteCache;
      ctx.fillRect(0, 0, width, height);
    }
  };

  /* ── 每帧：镜头 + 逐词 ─────────────────────────────────────── */

  const renderWords = (timeMs: number, dt: number, playing: boolean): void => {
    const width = sizeW;
    const height = sizeH;
    if (lines.length === 0 || camZ === null) return;
    const focal = (height * 0.5) / Math.tan(FOV_Y * 0.5);
    const planeUnit = cfg.focusDepth / focal;
    const active = displayFocus;
    const activeProgress = lineProgressAt(active, timeMs);
    const windowStart = Math.max(0, active - cfg.neighborLines - 1);
    const windowEnd = Math.min(lines.length - 1, active + cfg.neighborLines + 4);
    for (let index = windowStart; index <= windowEnd; index += 1) ensureLineEl(index);
    for (const index of [...lineEls.keys()]) {
      if (index < windowStart || index > windowEnd) dropLineEl(index);
    }

    for (let index = windowStart; index <= windowEnd; index += 1) {
      const line = lines[index];
      if (!line) continue;
      const depth = camZ - line.z;
      const distance = index - active;
      let base: number;
      if (distance === 0) base = 1;
      else if (distance > 0) {
        // 后面的句子只在当前句接近唱完时从隧道深处淡入，否则会一直压在主句上抢读。
        const anticipation = smoothstep(0.66, 1, activeProgress);
        base = Math.max(0.02, 0.1 * Math.pow(0.4, distance - 1)) * anticipation * cfg.fadeGhost;
      } else base = Math.max(0, 0.18 * Math.pow(0.38, -distance - 1)) * cfg.fadeGhost;
      const fog = smoothstep(FOG_FAR_DEPTH, FOG_NEAR_DEPTH, depth);
      const targetAlpha = base * fog;
      const previous = lineAlpha.get(index) ?? targetAlpha;
      const smoothed = damp(previous, targetAlpha, 6.5, dt);
      lineAlpha.set(index, smoothed);
      // 前后句的残影加一点景深虚化，避免和新句的白词糊在同一层里抢读。
      const lineEl = lineEls.get(index);
      if (lineEl) {
        const blurPx = index === active ? 0 : Math.min(2.4, (1 - smoothed) * 3.4);
        const blurValue = blurPx > 0.25 ? `blur(${blurPx.toFixed(2)}px)` : '';
        if (lineEl.style.filter !== blurValue) lineEl.style.filter = blurValue;
        // 镜头会后退，句子不一定总在后面的更深：按实际深度排一下堆叠，避免远处的词压住近处的词。
        const stacking = String(Math.max(1, 4000 - Math.round(depth * 40)));
        if (lineEl.style.zIndex !== stacking) lineEl.style.zIndex = stacking;
      }

      for (const word of line.words) {
        const span = word.span;
        if (!span) continue;
        const wordDepth = depth + word.depth;
        // 贴近镜头或者整句已经淡出就不画了：不然会变成糊在镜头上的巨大幽灵字。
        const nearFade = smoothstep(4.2, 6.4, wordDepth);
        const fade = smoothed * nearFade;
        if (wordDepth <= 1.2 || fade <= 0.012) {
          if (span.style.opacity !== '0') span.style.opacity = '0';
          continue;
        }
        // 「从无到有」：每个词只在自己唱到的时间点从空白里浮现，浮现用时/延迟/飘入方向都随机，
        // 没唱到的词完全不画 —— 所以整句不会是提前摆在那儿的一排字。
        const entrance = cfg.entrance
          ? clamp((timeMs - word.startMs - word.entDelayMs) / word.entMs, 0, 1)
          : 1;
        if (entrance <= 0) {
          if (span.style.opacity !== '0') span.style.opacity = '0';
          if (span.style.filter !== '') span.style.filter = '';
          continue;
        }
        const ease = 1 - Math.pow(1 - entrance, 3);
        let state = 0;
        if (distance < 0) state = 1;
        else if (distance === 0) {
          if (timeMs >= word.endMs) state = 1;
          else if (timeMs >= word.startMs) state = 2;
        }
        if (state !== word.state) {
          span.dataset.state = String(state);
          word.state = state;
        }
        // 上方「歌词颜色」接管词色：纯色档用标准暖白三态，封面色/自动渐变按封面色板上色。
        // 重点词（自动从整首歌词里挑出的反复出现的词）用色板里的强调色单独染色，并可按设置放大。
        const keyword = cfg.keywordColors ? word.keyword ?? null : null;
        let finalColor = '';
        if (lyricTint) {
          const palette = lyricTint.palette;
          let base: string;
          if (keyword) {
            base = keyword.color;
          } else if (lyricTint.mode === 'gradient') {
            const count = line.words.length;
            const wi = line.words.indexOf(word);
            base = samplePaletteColor(palette, count > 1 ? wi / (count - 1) : 0.5);
          } else {
            base = palette[Math.min(state, palette.length - 1)] ?? palette[0] ?? '#ffffff';
          }
          const lighten = keyword
            ? state === 2 ? 0.22 : state === 1 ? 0.12 : 0.04
            : lyricTint.mode === 'solid'
              ? 0
              : state === 2 ? 0.8 : state === 1 ? 0.62 : 0.46;
          finalColor = mixHex(base, '#ffffff', lighten);
        } else if (keyword) {
          finalColor = mixHex(keyword.color, '#ffffff', state === 2 ? 0.22 : state === 1 ? 0.1 : 0.02);
        }
        if (finalColor) {
          const tintKey = `${state}|${finalColor}|${cfg.glow}|${keyword ? 1 : 0}`;
          if (word.tintKey !== tintKey) {
            word.tintKey = tintKey;
            span.style.color = finalColor;
            if (state === 2) {
              const [tr, tg, tb] = hexChannels(finalColor);
              const glowA = clamp(cfg.glow, 0, 2);
              span.style.textShadow =
                `0 0 ${(22 * glowA).toFixed(1)}px rgba(${tr},${tg},${tb},${(0.55 * glowA).toFixed(3)}),` +
                `0 0 ${(64 * glowA).toFixed(1)}px rgba(${tr},${tg},${tb},${(0.26 * glowA).toFixed(3)}),` +
                '0 12px 32px rgba(19,83,66,0.24)';
            } else {
              span.style.textShadow = '';
            }
          }
        } else if (word.tintKey) {
          word.tintKey = undefined;
          span.style.color = '';
          span.style.textShadow = '';
        }
        word.pop = damp(word.pop, state === 2 ? 1 : 0, 14, dt);
        // 浮现时先从略大的尺寸收进来，配合半透明和随机飘移，看起来是「凭空冒出来」而不是淡入一排静态字。
        const enterScale = 1 + 0.22 * (1 - ease);
        const scale = (cfg.focusDepth / wordDepth) * enterScale * (1 + word.pop * (0.05 + energyNow * 0.03 * cfg.energy));
        const seedPhase = word.nx * 41.7 + word.ny * 23.3;
        const floatX = Math.sin(clockNow * 0.00042 + seedPhase) * 2.4;
        const floatY = Math.sin(clockNow * 0.00061 + seedPhase * 1.7) * 3.2;
        // 词在世界里的位置是固定的：镜头横移/偏航/俯仰时靠透视自然产生视差，不再用平面缩放近似。
        const projected = projectWorld(
          word.nx * width * planeUnit,
          cfg.camHeight - word.ny * height * planeUnit,
          line.z - word.depth,
        );
        const x = projected.x + floatX + word.entDx * (1 - ease);
        const y = projected.y + floatY + word.entDy * (1 - ease);
        const stateAlpha = state === 2 ? cfg.activeOpacity : state === 1 ? cfg.sungOpacity : cfg.unsungOpacity;
        const alpha = clamp(fade * stateAlpha * ease, 0, 1);
        span.style.opacity = alpha.toFixed(3);
        const blurPx = (1 - ease) * 4.5;
        const blurValue = blurPx > 0.2 ? `blur(${blurPx.toFixed(2)}px)` : '';
        if (span.style.filter !== blurValue) span.style.filter = blurValue;
        const angle = word.rot + word.entRot * (1 - ease) + camRollEff * (180 / Math.PI);
        span.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${scale.toFixed(3)}) rotate(${angle.toFixed(2)}deg) translate(-50%, -50%)`;
      }
    }
    void playing;
  };

  /* ── 对外接口 ─────────────────────────────────────────────── */

  const render = (positionMs: number, playing: boolean, energy: number): void => {
    const now = performance.now();
    const dt = lastNow > 0 ? clamp((now - lastNow) / 1000, 0.001, 0.08) : 0.016;
    lastNow = now;
    clockNow = now;
    energyNow = damp(energyNow, clamp(energy, 0, 1), 6, dt);
    readSize();
    if (sizeW < 2 || sizeH < 2) return;

    const safePosition = Number.isFinite(positionMs) ? positionMs : 0;
    const safeOffset = Number.isFinite(song?.lyricOffsetMs ?? 0) ? (song?.lyricOffsetMs ?? 0) : 0;
    const timeMs = safePosition + safeOffset;
    if (song && lines.length > 0) {
      const index = indexAt(timeMs);
      activeIndex = index;
      // 行间间奏：当前行第一个词还没开始唱时，镜头继续停在上一条句子上，
      // 否则打开房间正好卡在间奏时会整屏空无一字。
      const firstWordStart = (i: number): number => {
        const l = lines[i];
        if (!l || l.words.length === 0) return l ? l.timeMs : 0;
        return l.words[0]!.startMs;
      };
      let focus = index;
      while (focus > 0 && timeMs < firstWordStart(focus) - 60) focus -= 1;
      displayFocus = focus;
      const progress = lineProgressAt(focus, timeMs);
      const line = lines[focus]!;
      const creep = smoothstep(0, 1, progress) * cfg.creep;
      const targetZ = line.z + cfg.focusDepth - creep;
      const targetRoll = rolls[focus] ?? 0;
      const snap = camZ === null || !Number.isFinite(camZ) || Math.abs(safePosition - lastPositionMs) > 1500;
      if (snap) {
        camZ = targetZ;
        camRoll = targetRoll;
      } else {
        camZ = damp(camZ ?? targetZ, targetZ, playing ? 3.4 : 8, dt);
        camRoll = damp(camRoll, targetRoll, CAM_ROLL_DAMP, dt);
      }
    } else if (camZ === null) {
      camZ = 0;
    }

    // 手持晃动：确定性多频正弦（慢频为主 + 细频打散），只写渲染相机；
    // 上面 camZ / camRoll 的阻尼目标保持原样，歌词运动完全不受影响。
    const shakeT = clockNow * 0.001;
    const shakeAmp = (playing ? 1 : 0.62) * clamp(cfg.shake, 0, 3);
    const wobble = (a: number, b: number, c: number): number => Math.sin(shakeT * a) * 0.58 + Math.sin(shakeT * b + 1.3) * 0.29 + Math.sin(shakeT * c + 2.6) * 0.13;
    shakeX = wobble(0.61, 1.37, 2.53) * SHAKE_X * shakeAmp;
    shakeY = wobble(0.73, 1.61, 2.91) * SHAKE_Y * shakeAmp;
    shakeRoll = wobble(0.94, 2.21, 3.61) * SHAKE_ROLL * shakeAmp;
    const shakeYaw = wobble(0.83, 1.97, 3.11) * SHAKE_YAW * shakeAmp;
    const shakePitch = wobble(0.67, 1.79, 3.37) * SHAKE_PITCH * shakeAmp;

    camRollEff = camRoll + shakeRoll;
    camView.x = shakeX;
    camView.y = cfg.camHeight + shakeY;
    camView.z = camZ !== null && Number.isFinite(camZ) ? camZ : 0;
    camCosRoll = Math.cos(camRollEff);
    camSinRoll = Math.sin(camRollEff);
    camCosYaw = Math.cos(shakeYaw);
    camSinYaw = Math.sin(shakeYaw);
    camCosPitch = Math.cos(shakePitch);
    camSinPitch = Math.sin(shakePitch);

    drawBackground(clockNow);
    renderWords(timeMs, dt, playing);

    // 前奏歌名卡：歌词尚未开口（第一句歌词第一个词之前）时显示，开口立刻淡出；
    // 拖动进度条回到前奏也会重新出现。
    if (cfg.introTitle && lines.length > 0) {
      const firstStart = lines[0]!.words[0]?.startMs ?? lines[0]!.timeMs;
      const showTitle = timeMs < firstStart - 200;
      setIntroTitleShown(showTitle);
      if (showTitle) {
        const scale = clamp(cfg.introTitleScale, 0.5, 2.2);
        const nameSize = Math.round(sizeH * 0.062 * scale * 10) / 10;
        if (titleSizeCached !== nameSize) {
          titleSizeCached = nameSize;
          titleNameEl.style.fontSize = `${nameSize}px`;
          titleArtistEl.style.fontSize = `${Math.max(12, Math.round(nameSize * 0.3))}px`;
        }
      }
    } else {
      setIntroTitleShown(false);
    }

    lastPositionMs = positionMs;

    if (!painted) {
      painted = true;
      options.onPainted?.();
    }
  };

  // 调试探针：便于自动化验证粒子是真 3D（世界坐标 → projectWorld）。（只读，不影响渲染）
  (window as unknown as { __roomParticles?: () => unknown }).__roomParticles = () => particleDebug;

  return {
    root,

    setStyle(settings: Partial<RoomStyleSettings>): void {
      if (disposed) return;
      cfg = normalizeRoomSettings({ ...cfg, ...settings });
      computeTintColors(lyricTint);
      applyCssVars();
      camZ = null;
      // 背景/地毯的渐变是按尺寸缓存的，参数一变就作废。
      cacheW = -1;
      cacheH = -1;
      readSize();
      if (song && song.lines.length > 0) {
        buildLayout(song);
        syncEmptyState(lines.length > 0);
      }
    },

    setLyricTint(tint: RoomLyricTint | null): void {
      if (disposed) return;
      const usable = tint && tint.palette.length > 0 ? tint : null;
      const key = usable ? `${usable.mode}|${usable.palette.join(',')}` : '';
      if (key === lyricTintKey) return;
      lyricTintKey = key;
      lyricTint = usable;
      computeTintColors(lyricTint);
      applyCssVars();
      // 背景/地毯的渐变按尺寸缓存，色板变了要作废重画。
      cacheW = -1;
      cacheH = -1;
      // 缓存的逐词样式作废，下一帧按新色板重刷；重点词也按新色板重新挑色。
      for (const line of lines) {
        for (const word of line.words) word.tintKey = undefined;
      }
      refreshKeywords();
    },

    setSong(input: RoomSceneSong | null): void {
      if (disposed) return;
      // 同一首歌被反复 setSong 时不要重排布局（逐词 measureText 很贵），只换数据引用。
      const nextKey = input
        ? `${input.trackKey}|${input.title}|${input.artist}|${input.lines.length}|${input.lines[0]?.timeMs ?? 0}|${input.lines[input.lines.length - 1]?.timeMs ?? 0}|${input.lyricOffsetMs ?? 0}`
        : '';
      if (nextKey === lastSongKey && input) {
        song = input;
        syncTitleCard();
        lastPositionMs = -1e9;
        return;
      }
      lastSongKey = nextKey;
      song = input;
      syncTitleCard();
      if (!input) {
        lines = [];
        songKey = '';
        camZ = null;
        activeIndex = -1;
        rolls = [];
        camRoll = 0;
        for (const el of lineEls.values()) el.remove();
        lineEls.clear();
        lineAlpha.clear();
        // 连歌都没有（还没开始播）就不要弹「暂无歌词」。
        syncEmptyState(true);
        return;
      }
      if (input.lines.length === 0) {
        lines = [];
        songKey = '';
        camZ = null;
        activeIndex = -1;
        rolls = [];
        camRoll = 0;
        for (const el of lineEls.values()) el.remove();
        lineEls.clear();
        lineAlpha.clear();
        syncEmptyState(false);
        return;
      }
      readSize();
      buildLayout(input);
      // 全是制作名单/元信息时过滤后 lines 为空，也按「没有歌词」处理。
      syncEmptyState(lines.length > 0);
    },

    update(positionMs: number, playing: boolean, energy = 0): void {
      if (disposed) return;
      render(positionMs, playing, energy);
    },

    resize(): void {
      if (disposed) return;
      readSize();
      if (activeIndex >= 0) render(lastPositionMs, false, energyNow);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (emptyTimer !== null) {
        window.clearTimeout(emptyTimer);
        emptyTimer = null;
      }
      resizeObserver.disconnect();
      for (const el of lineEls.values()) el.remove();
      lineEls.clear();
      lineAlpha.clear();
      lines = [];
      song = null;
      root.remove();
    },
  };
}
