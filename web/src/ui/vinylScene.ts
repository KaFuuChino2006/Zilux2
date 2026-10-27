/**
 * 歌词页「播放效果 · 唱片」的渲染引擎。
 *
 * 一块 canvas 画一间暖褐色的聆听室：33⅓ 转黑胶、黄铜唱臂、漂浮尘埃和一道暗角；
 * 歌词 DOM 压在唱片下方，当前句暖白大字 + 逐词高亮，和房间档互斥显示。
 *
 * 约定与房间档一致：
 *  - 只依赖 ./keywords 和 ./vinylSettings，不 import 歌词页/播放器；
 *  - update() 由外层每帧驱动，内部自己处理「暂停 → 转速渐停、唱臂抬起」；
 *  - setSong() 用签名去重，避免播放器高频回调导致重复建 DOM；
 *  - dispose() 移除 ResizeObserver、DOM 和事件。
 */

import { extractLyricKeywords, keywordForWord, type LyricKeyword } from './keywords';
import {
  lyricStyle,
  lyricStyleNeedsCharTiming,
  onLyricStyle,
  type LyricStyle,
} from './lyricStyle';
import type { RoomLyricTint } from './roomScene';
import { DEFAULT_VINYL_SETTINGS, normalizeVinylSettings, type VinylStyleSettings } from './vinylSettings';

/* ── 对外类型 ─────────────────────────────────────────────────────── */

export interface VinylSceneWord {
  text: string;
  startMs: number;
  endMs: number;
  spaceBefore?: boolean;
}

export interface VinylSceneLine {
  timeMs: number;
  durationMs: number;
  text: string;
  translation?: string;
  words: ReadonlyArray<VinylSceneWord>;
}

export interface VinylSceneSong {
  /** 用来给尘埃粒子播种，同一首歌每次进来布局一致。 */
  trackKey?: string;
  title: string;
  artist: string;
  album?: string;
  /** 专辑封面地址：有封面时直接印在唱片中心贴纸上（播放时整盘一起转）。 */
  coverUrl?: string;
  durationMs: number;
  lyricOffsetMs?: number;
  lines: ReadonlyArray<VinylSceneLine>;
}

export interface VinylSceneOptions {
  /** 第一帧真正画出来之后回调一次（包装层用它挂 is-ready / is-painted）。 */
  onPainted?: () => void;
  /** 初始观感参数；缺省用 DEFAULT_VINYL_SETTINGS。 */
  style?: Partial<VinylStyleSettings>;
}

export interface VinylScene {
  readonly root: HTMLDivElement;
  /** 更新观感/布局参数。 */
  setStyle(settings: Partial<VinylStyleSettings>): void;
  /** 「歌词颜色」档位传进来的上色信息（贴纸/唱臂/重点词跟随它）。 */
  setLyricTint(tint: RoomLyricTint | null): void;
  setSong(song: VinylSceneSong | null): void;
  /** 每帧调用一次：positionMs 为播放器位置，energy 为低频能量 0~1。 */
  update(positionMs: number, playing: boolean, energy?: number): void;
  resize(): void;
  dispose(): void;
}

/* ── 小工具 ───────────────────────────────────────────────────────── */

const TAU = Math.PI * 2;
const STYLE_ID = 'zlr-vinyl-style';
const FONT_STACK = "'Zilux2 Sans SC', 'Microsoft YaHei UI', 'Segoe UI', system-ui, sans-serif";
const FONT_FAMILIES: Record<VinylStyleSettings['fontFamily'], string> = {
  display: "'Noto Sans CJK SC', 'Noto Sans SC', 'Microsoft YaHei UI', 'Zilux2 Sans SC', system-ui, sans-serif",
  yahei: "'Microsoft YaHei UI', 'Microsoft YaHei', 'Zilux2 Sans SC', system-ui, sans-serif",
  serif: "'Noto Serif CJK SC', 'Source Han Serif SC', SimSun, serif",
  system: FONT_STACK,
};
const fontStackOf = (family: VinylStyleSettings['fontFamily']): string => FONT_FAMILIES[family];

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** 指数阻尼：把 current 往 target 拉，tau 越大跟得越快。 */
const damp = (current: number, target: number, tau: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-Math.max(0, dt) * tau));

function hexToRgb(hex: string): Rgb {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '171310';
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

const rgbStr = (rgb: Rgb): string => `rgb(${rgb.r},${rgb.g},${rgb.b})`;

const rgba = (rgb: Rgb, alpha: number): string =>
  `rgba(${rgb.r},${rgb.g},${rgb.b},${clamp(alpha, 0, 1).toFixed(3)})`;

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp(t, 0, 1);
  return {
    r: Math.round(a.r + (b.r - a.r) * k),
    g: Math.round(a.g + (b.g - a.g) * k),
    b: Math.round(a.b + (b.b - a.b) * k),
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

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 稳定的字级 hash：同一句、同一位置每次重建都拿到同一组「飘入」偏移（旋入样式用）。 */
function scatterHash(lineText: string, index: number): number {
  let hash = 2166136261;
  const key = `${index}:${lineText}`;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 由 hash 派生的 0~1 伪随机数（salt 区分不同维度）。 */
function scatterRandom(hash: number, salt: number): number {
  let value = (hash ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/* ── 制作名单词库（QRC/YRC 会把名单塞进歌词流，需要过滤） ───────────── */

const CREDIT_LABELS = new Set([
  '作词', '作曲', '编曲', '制作人', '监制', '出品', '发行', '录音', '混音', '母带', '和声',
  '吉他', '贝斯', '鼓', '键盘', '弦乐', '统筹', '策划', '美术', '设计', '词', '曲', 'op', 'sp',
  'composed', 'produced', 'written', 'arranged', 'mixed', 'mastered', 'recorded', 'engineered',
  'performed', 'lyrics', 'lyric', 'music', 'vocals', 'vocal', 'guitar', 'bass', 'drums', 'drum',
  'piano', 'keyboards', 'keyboard', 'strings', 'programming', 'producer', 'composer', 'composers',
  'lyricist', 'lyricists', 'additional', 'background',
]);

const CREDIT_PREFIXES: ReadonlyArray<string> = [
  '作曲', '作词', '编曲', '制作人', '制作', '监制', '出品', '发行', '录音', '混音', '母带',
  '和声', '吉他', '贝斯', '键盘', '弦乐', '统筹', '策划', '原唱', '演唱', '词作者', '曲作者',
  'composed', 'composer', 'producer', 'produced', 'lyrics', 'written', 'arranged', 'mix', 'master',
  'recorded', 'engineered', 'performed', 'vocals', 'guitar', 'bass', 'drums', 'piano', 'strings',
  'programming', 'music by', 'op', 'sp', 'backing', 'chorus', 'project', 'vocal',
  '配唱', '和音', '伴唱', '人声', '录音师', '混音师',
];

const CREDIT_ROLE_HINT =
  /(作词|作曲|编曲|制作|监制|出品|发行|录音|混音|母带|和声|吉他|贝斯|键盘|弦乐|统筹|策划|营销|文案|视觉|设计|演唱|原唱|配唱|人声|声明|版权|许可|授权|本作品|词|曲|lyric|compos|arrang|produc|mix|master|record|engineer|vocal|guitar|bass|drum|piano|string|program|design|promo|market|publish|director|studio|copyright)/i;

/* ── 样式（同类场景共享一份 <style>） ─────────────────────────────── */

const STYLE_CSS = `
.zl-vinyl-scene{position:absolute;inset:0;overflow:hidden;isolation:isolate;background:var(--vs-bg-bottom,#090807);font-family:var(--vs-font,${FONT_STACK});}
.zvs-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.zvs-words{position:absolute;inset:0;pointer-events:none;z-index:2}
.zvs-line{position:absolute;top:0;left:0;width:100%;text-align:center;white-space:normal;opacity:0;scale:.94;will-change:transform,opacity,scale;transform-origin:50% 50%;transition:opacity .5s ease,transform .55s cubic-bezier(.22,1,.36,1),scale .55s cubic-bezier(.22,1,.36,1),font-size .55s cubic-bezier(.22,1,.36,1)}
.zvs-line.is-visible{opacity:var(--vs-unsung-op,.34)}
.zvs-line.is-sung{opacity:var(--vs-sung-op,.86)}
.zvs-line.is-focus{opacity:var(--vs-active-op,1);scale:1}
.zvs-word{display:inline;color:var(--vs-color,#f2e7d8);transition:color .32s ease,text-shadow .32s ease}
.zvs-char{position:relative;display:inline-block;transition:color .3s ease,translate .32s ease,rotate .32s ease,opacity .3s ease}
.zvs-line.is-focus .zvs-word[data-state="2"]{color:var(--vs-active,#ffe9c2);text-shadow:0 0 calc(16px * var(--vs-glow,.9)) var(--vs-glow-color,#ffcf8a)}
.zvs-line.is-focus .zvs-word[data-state="1"]{color:var(--vs-sung,#fff8ec)}
.zvs-tr{margin-top:.34em;font-size:.42em;font-weight:400;letter-spacing:.03em;opacity:0;max-height:0;overflow:hidden;color:var(--vs-color,#f2e7d8);transition:opacity .4s ease,max-height .45s ease}
.zvs-line.is-focus .zvs-tr{opacity:.58;max-height:2.6em}
.zvs-title-card{position:absolute;left:6vw;right:6vw;top:52%;transform:translateY(-50%);text-align:center;pointer-events:none;opacity:0;transition:opacity .9s ease;color:var(--vs-active,#ffe9c2);z-index:1}
.zvs-title-card.is-visible{opacity:1}
.zvs-title{font-family:var(--vs-font,${FONT_STACK});font-weight:var(--vs-weight,900);font-size:clamp(20px,3.4vh,40px);letter-spacing:.06em;text-shadow:0 4px 30px rgba(0,0,0,.6)}
.zvs-artist{margin-top:.62em;font-size:clamp(11px,1.5vh,15px);letter-spacing:.24em;opacity:.62}
/* 歌词播放动画：和「播放效果 = 关闭」共用同一套样式语义（经典 / 上浮 / 波浪 / 摇曳 / 打字机 / 旋入）。
   这里只搬「动」，颜色仍走 --vs-* 词色令牌；逐字时机由场景按真实演唱时间写入 is-sung / is-hot。 */
@keyframes zvs-wave{0%,100%{translate:0 0}50%{translate:0 -.22em}}
@keyframes zvs-swing{0%{rotate:0deg;scale:1}18%{rotate:-6.5deg;scale:1.035}44%{rotate:5.5deg;scale:1.02}68%{rotate:-2.8deg}86%{rotate:1.1deg}100%{rotate:0deg;scale:1}}
@media (prefers-reduced-motion: no-preference){
  /* 上浮：唱到的字从下方浮起、归位到行里；下方还没轮到的行压到最低可见度。 */
  .zl-vinyl-scene.zvs-style-rise .zvs-line.is-focus .zvs-char{translate:0 .5em;opacity:.16;transition:translate .42s cubic-bezier(.22,1,.36,1),opacity .32s linear,rotate .3s ease,color .2s linear}
  .zl-vinyl-scene.zvs-style-rise .zvs-line.is-focus .zvs-char.is-hot{translate:0 0;opacity:1;transition:translate .34s cubic-bezier(.34,1.3,.64,1),opacity .2s linear,rotate .3s ease,color .12s linear}
  .zl-vinyl-scene.zvs-style-rise .zvs-line.is-focus .zvs-char.is-sung{translate:0 0;opacity:1}
  .zl-vinyl-scene.zvs-style-rise .zvs-line.is-focus ~ .zvs-line{opacity:.2!important}
  /* 波浪：当前行的字按 --ci 错开相位依次起伏，随演唱一直流动。 */
  .zl-vinyl-scene.zvs-style-wave .zvs-line.is-focus .zvs-char{animation:zvs-wave 1.7s ease-in-out infinite;animation-delay:calc(var(--ci,0) * -.12s)}
  /* 摇曳：每个字唱完的瞬间像被轻轻拨了一下，左右摆两下再停稳。 */
  .zl-vinyl-scene.zvs-style-swing .zvs-line.is-focus .zvs-char.is-sung{animation:zvs-swing .52s cubic-bezier(.36,.07,.19,.97)}
  .zl-vinyl-scene.zvs-style-swing .zvs-line.is-focus .zvs-char.is-hot{animation:none}
  /* 打字机：还没唱到的字、以及下面的整行都不显形（位置留着，不挤动整行）。 */
  .zl-vinyl-scene.zvs-style-typewriter .zvs-line.is-focus .zvs-char{opacity:0;transition:color .16s linear}
  .zl-vinyl-scene.zvs-style-typewriter .zvs-line.is-focus .zvs-char.is-hot,
  .zl-vinyl-scene.zvs-style-typewriter .zvs-line.is-focus .zvs-char.is-sung{opacity:1}
  .zl-vinyl-scene.zvs-style-typewriter .zvs-line.is-focus ~ .zvs-line{opacity:0!important}
  .zl-vinyl-scene.zvs-style-typewriter .zvs-line.is-focus ~ .zvs-line .zvs-char{opacity:0;transition:none}
  /* 旋入：还没唱到的字散在句子周围（--drift-* 按字写入），唱到哪个字就从随机方向飘回来。 */
  .zl-vinyl-scene.zvs-style-spin .zvs-line.is-focus .zvs-char{translate:calc(var(--drift-x,.42em) * var(--scatter,1)) calc(var(--drift-y,.4em) * var(--scatter,1));rotate:calc(var(--drift-rot,-16deg) * var(--scatter,1));opacity:.12;transition:translate var(--drift-dur,.6s) cubic-bezier(.22,1,.36,1),rotate var(--drift-dur,.6s) cubic-bezier(.22,1.1,.36,1),opacity .32s linear,color .2s linear}
  .zl-vinyl-scene.zvs-style-spin .zvs-line.is-focus .zvs-char.is-hot,
  .zl-vinyl-scene.zvs-style-spin .zvs-line.is-focus .zvs-char.is-sung{translate:0 0;rotate:0deg;opacity:1}
  .zl-vinyl-scene.zvs-style-spin .zvs-line.is-focus ~ .zvs-line{opacity:.2!important}
  .zl-vinyl-scene.zvs-style-spin .zvs-line:not(.is-focus) .zvs-char{translate:calc(var(--drift-x,.42em) * var(--scatter,0)) calc(var(--drift-y,.4em) * var(--scatter,0));rotate:calc(var(--drift-rot,-16deg) * var(--scatter,0));transition:translate .9s cubic-bezier(.22,1,.36,1),rotate .9s cubic-bezier(.22,1.1,.36,1)}
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_CSS;
  document.head.appendChild(style);
}

/* ── 场景内部状态 ─────────────────────────────────────────────────── */

interface Mote {
  x: number;
  y: number;
  size: number;
  speed: number;
  drift: number;
  phase: number;
  alpha: number;
}

interface LineView {
  el: HTMLDivElement;
  words: HTMLSpanElement[];
  /** 逐字 span（按字拆开，供上浮 / 波浪 / 摇曳 / 打字机 / 旋入等播放动画使用）。 */
  chars: HTMLSpanElement[];
  /** 每个词在 chars 里的起始下标；最后一个词的结尾用 chars.length 收尾。 */
  charStarts: number[];
  /** 每个词的着色状态缓存：-1 未刷、0 未唱、1 唱过、2 正在唱。 */
  states: number[];
  /** 逐字状态缓存：-1 未刷、0 未唱、1 唱过、2 正在唱。 */
  charStates: number[];
  /** 重点词颜色（null = 不染色）。 */
  kw: Array<string | null>;
}

export function createVinylScene(options: VinylSceneOptions = {}): VinylScene {
  ensureStyle();

  let cfg = normalizeVinylSettings({ ...DEFAULT_VINYL_SETTINGS, ...options.style });
  let disposed = false;

  /* ── DOM ──────────────────────────────────────────────────────── */

  const root = document.createElement('div');
  root.className = `zl-vinyl-scene zvs-style-${lyricStyle()}`;

  const canvas = document.createElement('canvas');
  canvas.className = 'zvs-canvas';
  const ctx = canvas.getContext('2d');

  const wordsLayer = document.createElement('div');
  wordsLayer.className = 'zvs-words';

  const titleCard = document.createElement('div');
  titleCard.className = 'zvs-title-card';
  const titleEl = document.createElement('div');
  titleEl.className = 'zvs-title';
  const artistEl = document.createElement('div');
  artistEl.className = 'zvs-artist';
  titleCard.append(titleEl, artistEl);

  root.append(canvas, titleCard, wordsLayer);

  /* ── 尺寸 / 缓存 ──────────────────────────────────────────────── */

  let width = 0;
  let height = 0;
  let dpr = 1;
  let cacheW = -1;
  let cacheH = -1;
  let cacheVersion = -1;
  let styleVersion = 0;
  let bgGradient: CanvasGradient | null = null;
  let spotGradient: CanvasGradient | null = null;
  let vignetteGradient: CanvasGradient | null = null;
  let shadowGradient: CanvasGradient | null = null;
  let grainPattern: CanvasPattern | null = null;
  let grainBuilt = false;

  /* ── 数据 / 播放状态 ──────────────────────────────────────────── */

  let song: VinylSceneSong | null = null;
  let lines: ReadonlyArray<VinylSceneLine> = [];
  let views: LineView[] = [];
  let keywords: LyricKeyword[] = [];
  let songKey = '';
  let lyricTint: RoomLyricTint | null = null;
  let tintKey = '';
  let activeIndex = -1;
  let lastPositionMs = 0;
  let lastPlaying = false;
  let painted = false;
  /** 前奏歌名卡是否正显示（显示时中心贴纸先不印歌名，避免两层同样的字叠在一起）。 */
  let introShown = false;

  /** 唱片累计转角（弧度）。 */
  let rotation = 0;
  /** 当前角速度（弧度/秒）。 */
  let omega = 0;
  /** 每秒动效时间步（秒）。 */
  let lastNow = 0;
  let energyNow = 0;
  /** 唱臂横向进度 0~1（平滑跟随播放进度）。 */
  let armProgress = 0;
  let armLift = 0;

  let motes: Mote[] = [];

  /** 中心贴纸的封面：地址变了就重新载入，载入失败就退回纯色贴纸。 */
  let coverSrc = '';
  let coverImg: HTMLImageElement | null = null;
  let coverReady = false;

  /** 盘面纹路（不规则圆）按半径缓存成 Path2D，播放时跟着整盘一起转。 */
  let grooveMain: Path2D | null = null;
  let grooveAccent: Path2D | null = null;
  let grooveKey = '';
  /** 盘面上会跟着转的细划痕/抛光弧，让「整盘在转」看得出来。 */
  let grooveGlints: Array<{ path: Path2D; width: number; alpha: number }> = [];

  /* ── 制作名单过滤 ─────────────────────────────────────────────── */

  /**
   * QRC/YRC 常把「作词：…」「作曲Composer…」这类制作名单混进歌词流。
   * 唱片场景只该有正文歌词，所以开唱前把名单行过滤掉（逻辑与房间场景一致）。
   */
  const looksLikeCreditLine = (text: string, index: number): boolean => {
    const raw = text.trim();
    if (!raw) return false;
    const compact = raw.toLowerCase().replace(/\s+/g, '');
    // 只有「制作人」「作词」这种独立标签行
    if (compact.length > 0 && compact.length <= 10 && CREDIT_LABELS.has(compact)) return true;
    const colon = raw.search(/[:：]/);
    if (colon > 0 && colon <= 16) {
      const label = raw.slice(0, colon).toLowerCase().replace(/\s+/g, '').replace(/by$/, '');
      if (CREDIT_LABELS.has(label)) return true;
    }
    // 「作曲Composer罗凯元」这种没有冒号的拼接行，只看行首
    if (index <= 40 && compact.length <= 40) {
      if (raw.slice(0, 40).length > 0 && CREDIT_PREFIXES.some((prefix) => raw.toLowerCase().startsWith(prefix))) {
        return true;
      }
    }
    // 「词Lyricist：林晨阳」这种角色中英混排、冒号前带角色词的名单行
    if (index <= 40 && colon > 0 && colon <= 26) {
      if (CREDIT_ROLE_HINT.test(raw.slice(0, colon))) return true;
    }
    // 「歌名 (Explicit) - 歌手」式元数据行，只在前两行判断，避免误杀正文
    if (index <= 1) {
      const normalize = (value: string): string =>
        value
          .toLowerCase()
          .replace(/[（(][^）)]*[）)]/g, '')
          .replace(/[^0-9a-z\u4e00-\u9fff]+/g, '');
      const normalized = normalize(raw);
      const normalizedTitle = normalize(song?.title ?? '');
      const normalizedArtist = normalize(song?.artist ?? '');
      const hasDash = /\s[-–—]\s/.test(raw);
      const titleHit =
        normalizedTitle.length >= 2 &&
        (normalized.includes(normalizedTitle.slice(0, Math.min(8, normalizedTitle.length))) ||
          normalizedTitle.includes(normalized.slice(0, Math.min(8, normalized.length))));
      const artistHit =
        normalizedArtist.length >= 2 &&
        normalized.includes(normalizedArtist.slice(0, Math.min(6, normalizedArtist.length)));
      if (hasDash && (titleHit || artistHit)) return true;
    }
    return false;
  };

  const filterCreditLines = (input: VinylSceneSong): VinylSceneLine[] => {
    const kept: VinylSceneLine[] = [];
    for (let i = 0; i < input.lines.length; i += 1) {
      const line = input.lines[i]!;
      const text = line.text.trim();
      if (!text) continue;
      if (looksLikeCreditLine(text, i)) continue;
      kept.push(line);
    }
    return kept.length > 0 ? kept : [...input.lines];
  };

  /* ── 派生配色 ─────────────────────────────────────────────────── */

  let accentHex = cfg.accentColor;
  let labelHex = cfg.labelColor;
  let glowHex = cfg.glowColor;
  let rgbDisc: Rgb = hexToRgb(cfg.discColor);
  let rgbAccent: Rgb = hexToRgb(cfg.accentColor);
  let rgbLabel: Rgb = hexToRgb(cfg.labelColor);
  let rgbGlow: Rgb = hexToRgb(cfg.glowColor);
  let rgbWarm: Rgb = { r: 255, g: 224, b: 178 };
  /** 「背景跟随歌词」时由歌词色板压暗出来的背景色。 */
  let tintedBg: { top: Rgb; bottom: Rgb } | null = null;
  const rgbWhite: Rgb = { r: 255, g: 248, b: 236 };
  const rgbBlack: Rgb = { r: 0, g: 0, b: 0 };

  const refreshPalette = (): void => {
    styleVersion += 1;
    const tintPalette =
      lyricTint && lyricTint.mode !== 'solid' && lyricTint.palette.length > 0 ? lyricTint.palette : null;
    // 「背景跟随歌词」只让背景压暗同源：盘面、标签、光晕仍按唱片参数配色，
    // 这样一键预设（午夜/酒红/奶油）换盘面色时不会被歌词色板盖掉。
    if (cfg.bgFollowLyrics && tintPalette) {
      const light = mixRgb(hexToRgb(tintPalette[0]!), rgbBlack, 0.74);
      const deep = mixRgb(hexToRgb(tintPalette[Math.min(tintPalette.length - 1, 2)]!), rgbBlack, 0.9);
      tintedBg = { top: light, bottom: deep };
    } else {
      tintedBg = null;
    }
    accentHex = cfg.accentColor;
    labelHex = cfg.labelColor;
    glowHex = cfg.glowColor;
    rgbDisc = hexToRgb(cfg.discColor);
    rgbAccent = hexToRgb(accentHex);
    rgbLabel = hexToRgb(labelHex);
    rgbGlow = hexToRgb(glowHex);
    rgbWarm = mixRgb(rgbGlow, { r: 255, g: 236, b: 208 }, 0.55);
  };

  const applyCssVars = (): void => {
    const style = root.style;
    style.setProperty('--vs-font', fontStackOf(cfg.fontFamily));
    style.setProperty('--vs-weight', String(cfg.fontWeight));
    style.setProperty('--vs-track', `${cfg.letterSpacing}em`);
    style.setProperty('--vs-color', cfg.color);
    style.setProperty('--vs-sung', cfg.sungColor);
    style.setProperty('--vs-active', cfg.activeColor);
    style.setProperty('--vs-glow-color', glowHex);
    style.setProperty('--vs-glow', cfg.glow.toFixed(2));
    style.setProperty('--vs-accent', accentHex);
    style.setProperty('--vs-bg-bottom', tintedBg ? rgbStr(tintedBg.bottom) : cfg.bgBottom);
    style.setProperty('--vs-unsung-op', cfg.unsungOpacity.toFixed(2));
    style.setProperty('--vs-sung-op', cfg.sungOpacity.toFixed(2));
    style.setProperty('--vs-active-op', cfg.activeOpacity.toFixed(2));
    wordsLayer.style.letterSpacing = `${cfg.letterSpacing}em`;
    wordsLayer.style.fontFamily = fontStackOf(cfg.fontFamily);
    wordsLayer.style.fontWeight = String(cfg.fontWeight);
  };

  /* ── 歌词 DOM ─────────────────────────────────────────────────── */

  const refreshKeywords = (): void => {
    if (!cfg.keywordColors || lines.length === 0) {
      keywords = [];
      return;
    }
    const tintPalette =
      lyricTint && lyricTint.mode !== 'solid' && lyricTint.palette.length > 0 ? lyricTint.palette : null;
    const palette = tintPalette ?? [accentHex, labelHex, glowHex];
    keywords = extractLyricKeywords(lines, palette);
  };

  const kwColorFor = (li: number, wi: number): string | null => {
    if (!cfg.keywordColors || keywords.length === 0) return null;
    const line = lines[li];
    const word = line?.words[wi];
    if (!word) return null;
    return keywordForWord(word.text, keywords)?.color ?? null;
  };

  const rebuildLines = (): void => {
    wordsLayer.textContent = '';
    views = [];
    activeIndex = -1;
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li]!;
      const el = document.createElement('div');
      el.className = 'zvs-line';
      const spans: HTMLSpanElement[] = [];
      const chars: HTMLSpanElement[] = [];
      const charStarts: number[] = [];
      let ci = 0;
      for (let wi = 0; wi < line.words.length; wi += 1) {
        const word = line.words[wi]!;
        const span = document.createElement('span');
        span.className = 'zvs-word';
        span.dataset.state = '0';
        charStarts.push(chars.length);
        if (wi > 0 && word.spaceBefore) span.append(document.createTextNode(' '));
        // 逐字拆开：CSS 动画挂到 .zvs-char 上；--ci 错开相位，--drift-* 是旋入用的稳定随机偏移。
        for (const ch of word.text) {
          const cs = document.createElement('span');
          cs.className = 'zvs-char';
          cs.textContent = ch;
          cs.style.setProperty('--ci', String(ci));
          const hash = scatterHash(line.text, ci);
          cs.style.setProperty('--drift-x', `${(scatterRandom(hash, 0) * 3.2 - 1.6).toFixed(2)}em`);
          cs.style.setProperty('--drift-y', `${(scatterRandom(hash, 1) * 2.2 - 1.1).toFixed(2)}em`);
          cs.style.setProperty('--drift-rot', `${(scatterRandom(hash, 2) * 60 - 30).toFixed(1)}deg`);
          cs.style.setProperty('--drift-dur', `${(0.5 + scatterRandom(hash, 3) * 0.35).toFixed(2)}s`);
          span.append(cs);
          chars.push(cs);
          ci += 1;
        }
        if (word.text.length === 0) span.append(document.createTextNode(' '));
        spans.push(span);
        el.appendChild(span);
      }
      if (line.translation && line.translation.trim()) {
        const tr = document.createElement('div');
        tr.className = 'zvs-tr';
        tr.textContent = line.translation;
        el.appendChild(tr);
      }
      wordsLayer.appendChild(el);
      views.push({
        el,
        words: spans,
        chars,
        charStarts,
        states: spans.map(() => -1),
        charStates: chars.map(() => -1),
        kw: spans.map((_, wi) => kwColorFor(li, wi)),
      });
    }
  };

  /** 布局：整块歌词区以 lyricY 为锚点，当前句居中，前后邻居按行距排开。 */
  const syncLayout = (): void => {
    if (width <= 0 || views.length === 0) return;
    const focus = activeIndex >= 0 ? activeIndex : 0;
    const base = baseFontPx();
    const gap = base * 1.88;
    const centerY = height * cfg.lyricY;
    const boxWidth = Math.round(width * cfg.lyricWidth);
    const left = Math.round(width * cfg.lyricX - boxWidth / 2);
    for (let i = 0; i < views.length; i += 1) {
      const view = views[i]!;
      const k = i - focus;
      const visible = activeIndex >= 0 ? Math.abs(k) <= cfg.neighborLines : i === 0;
      // 字号统一交给 scale 做「聚焦」缩放（与「关闭」样式一致）：切行时不再跳字号。
      const fontPx = base;
      const y = centerY + k * gap;
      view.el.style.transform = `translateY(${y.toFixed(1)}px) translateY(-50%)`;
      view.el.style.left = `${left}px`;
      view.el.style.width = `${boxWidth}px`;
      view.el.style.fontSize = `${fontPx.toFixed(2)}px`;
      // 旋入样式：整列按距当前行的远近共用一份散开系数（已唱行收拢为 0）。
      const scatter =
        activeIndex < 0 || k < 0 ? 0 : k === 0 ? 0.6 : Math.min(1, 0.6 + k * 0.15);
      view.el.style.setProperty('--scatter', scatter.toFixed(2));
      view.el.classList.toggle('is-visible', visible && (activeIndex < 0 ? i === 0 : i > focus));
      view.el.classList.toggle('is-focus', activeIndex >= 0 && visible && i === focus);
      view.el.classList.toggle('is-sung', activeIndex >= 0 && visible && i < focus);
    }
  };

  const baseFontPx = (): number => {
    const portrait = width < height * 0.92;
    const raw = Math.min(width * (portrait ? 0.082 : 0.055), height * (portrait ? 0.043 : 0.058));
    return clamp(raw, 19, portrait ? 46 : 68) * cfg.sizeScale;
  };

  /** 逐字状态：只在状态变化时写 class，避免每帧刷 DOM。 */
  const setCharState = (view: LineView, index: number, state: number): void => {
    if (view.charStates[index] === state) return;
    view.charStates[index] = state;
    const el = view.chars[index]!;
    el.classList.toggle('is-sung', state >= 1);
    el.classList.toggle('is-hot', state === 2);
  };

  const clearCharStates = (view: LineView): void => {
    for (let i = 0; i < view.chars.length; i += 1) setCharState(view, i, -1);
  };

  /** 把某一行的逐词 / 逐字状态刷到 DOM（只在状态变化时写 style / class）。 */
  const applyLineStates = (li: number, effectivePositionMs: number): void => {
    const view = views[li];
    const line = lines[li];
    if (!view || !line) return;
    const passed = effectivePositionMs === Number.POSITIVE_INFINITY;
    const future = effectivePositionMs === Number.NEGATIVE_INFINITY;
    const karaoke = line.words.some((word) => word.endMs - word.startMs > 20);
    for (let wi = 0; wi < line.words.length; wi += 1) {
      const word = line.words[wi]!;
      let state: number;
      if (passed) {
        state = 1;
      } else if (!karaoke) {
        state = effectivePositionMs >= line.timeMs ? 2 : 0;
      } else if (word.endMs > 0 && word.endMs <= effectivePositionMs) {
        state = 1;
      } else if (word.startMs <= effectivePositionMs) {
        state = 2;
      } else {
        state = 0;
      }
      if (view.states[wi] !== state) {
        view.states[wi] = state;
        const span = view.words[wi]!;
        span.dataset.state = String(state);
        const kwColor = cfg.keywordColors ? view.kw[wi] : null;
        span.style.color =
          state === 2 ? (kwColor ?? cfg.activeColor) : state === 1 ? (kwColor ?? cfg.sungColor) : (kwColor ?? cfg.color);
      }
    }

    // 逐字动画：有逐字数据（QRC/YRC）时始终按演唱进度走；普通 LRC 行只在
    // 「上浮 / 摇曳 / 打字机 / 旋入」这类需要逐字时机的样式下按句内进度均匀合成。
    const needsCharTiming = karaoke || lyricStyleNeedsCharTiming();
    if (!needsCharTiming) {
      if (view.charStates.some((state) => state !== -1)) clearCharStates(view);
      return;
    }
    const total = view.chars.length;
    if (total === 0) return;
    const spanMs = Math.max(400, line.durationMs || 2600);
    const lineRatio = clamp((effectivePositionMs - line.timeMs) / spanMs, 0, 1);
    const sung = lineRatio * total;
    for (let wi = 0; wi < line.words.length; wi += 1) {
      const start = view.charStarts[wi]!;
      const end = wi + 1 < line.words.length ? view.charStarts[wi + 1]! : total;
      const count = end - start;
      if (count <= 0) continue;
      const word = line.words[wi]!;
      if (passed) {
        for (let j = start; j < end; j += 1) setCharState(view, j, 1);
      } else if (future) {
        for (let j = start; j < end; j += 1) setCharState(view, j, 0);
      } else if (karaoke) {
        const wordStart = word.startMs;
        const wordEnd = Math.max(word.endMs, wordStart + 1);
        for (let j = start; j < end; j += 1) {
          const local = (j - start) / count;
          const charStart = wordStart + (wordEnd - wordStart) * local;
          const charEnd = wordStart + (wordEnd - wordStart) * ((j - start + 1) / count);
          const state = effectivePositionMs >= charEnd ? 1 : effectivePositionMs >= charStart ? 2 : 0;
          setCharState(view, j, state);
        }
      } else {
        for (let j = start; j < end; j += 1) {
          const state = sung >= j + 1 ? 1 : sung > j ? 2 : 0;
          setCharState(view, j, state);
        }
      }
    }
  };

  /** 重新按当前播放位置刷一遍逐字状态（切样式 / 换色板后用）。 */
  const refreshCharStates = (): void => {
    if (views.length === 0) return;
    const position = lastPositionMs - safeOffset();
    for (let i = 0; i < views.length; i += 1) {
      if (i !== activeIndex) applyLineStates(i, i < activeIndex ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
    }
    if (activeIndex >= 0) applyLineStates(activeIndex, position);
  };

  const resetWordStates = (): void => {
    for (let li = 0; li < views.length; li += 1) {
      const view = views[li]!;
      for (let wi = 0; wi < view.words.length; wi += 1) view.states[wi] = -1;
      view.charStates.fill(-1);
      for (const ch of view.chars) ch.classList.remove('is-sung', 'is-hot');
    }
    refreshKeywords();
    for (let li = 0; li < views.length; li += 1) {
      views[li]!.kw = views[li]!.words.map((_, wi) => kwColorFor(li, wi));
    }
  };

  const syncTrackText = (): void => {
    const hasSong = !!song;
    titleEl.textContent = song?.title?.trim() || '唱片';
    artistEl.textContent = song?.artist?.trim() || '';
    titleCard.classList.toggle('is-visible', hasSong && (lines.length === 0 || cfg.introTitle));
  };

  /* ── 时间轴 ───────────────────────────────────────────────────── */

  const safeOffset = (): number => {
    const offset = song?.lyricOffsetMs ?? 0;
    return Number.isFinite(offset) ? offset : 0;
  };

  const indexAt = (effectivePositionMs: number): number => {
    if (lines.length === 0) return -1;
    const first = lines[0]!;
    if (effectivePositionMs < first.timeMs - 350) return -1;
    let found = 0;
    let lo = 0;
    let hi = lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid]!.timeMs <= effectivePositionMs) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };

  const syncTitleCard = (effectivePositionMs: number): void => {
    const intro =
      !!song && cfg.introTitle && (lines.length === 0 || effectivePositionMs < (lines[0]?.timeMs ?? 0) - 250);
    introShown = intro;
    titleCard.classList.toggle('is-visible', intro);
  };

  /* ── 画布缓存 ─────────────────────────────────────────────────── */

  const ensureCaches = (): void => {
    if (!ctx) return;
    if (cacheW === width && cacheH === height && cacheVersion === styleVersion) return;
    cacheW = width;
    cacheH = height;
    cacheVersion = styleVersion;

    const minSide = Math.min(width, height);
    const radius = minSide * cfg.discSize;
    const cx = width * cfg.discX;
    const cy = height * cfg.discY;

    const bgTopRgb = tintedBg ? tintedBg.top : hexToRgb(cfg.bgTop);
    const bgBottomRgb = tintedBg ? tintedBg.bottom : hexToRgb(cfg.bgBottom);
    bgGradient = ctx.createLinearGradient(0, 0, 0, height);
    bgGradient.addColorStop(0, rgbStr(bgTopRgb));
    bgGradient.addColorStop(0.62, rgbStr(mixRgb(bgTopRgb, bgBottomRgb, 0.6)));
    bgGradient.addColorStop(1, rgbStr(bgBottomRgb));

    spotGradient = ctx.createRadialGradient(cx, cy - radius * 0.25, radius * 0.05, cx, cy, minSide * 0.92);
    spotGradient.addColorStop(0, rgba(rgbWarm, cfg.spotGlow * 0.2));
    spotGradient.addColorStop(0.45, rgba(rgbWarm, cfg.spotGlow * 0.06));
    spotGradient.addColorStop(1, rgba(rgbWarm, 0));

    vignetteGradient = ctx.createRadialGradient(
      width * 0.5,
      height * 0.44,
      minSide * 0.18,
      width * 0.5,
      height * 0.52,
      Math.max(width, height) * 0.78,
    );
    vignetteGradient.addColorStop(0, 'rgba(0,0,0,0)');
    vignetteGradient.addColorStop(1, rgba(rgbBlack, cfg.vignette));

    shadowGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 1.6);
    shadowGradient.addColorStop(0, 'rgba(0,0,0,0.55)');
    shadowGradient.addColorStop(0.6, 'rgba(0,0,0,0.28)');
    shadowGradient.addColorStop(1, 'rgba(0,0,0,0)');
  };

  const ensureGrain = (): void => {
    if (!ctx || grainBuilt) return;
    grainBuilt = true;
    const size = 160;
    const noise = document.createElement('canvas');
    noise.width = size;
    noise.height = size;
    const noiseCtx = noise.getContext('2d');
    if (!noiseCtx) return;
    const image = noiseCtx.createImageData(size, size);
    const rand = mulberry32(0x9e3779b9);
    for (let i = 0; i < image.data.length; i += 4) {
      const value = Math.floor(rand() * 255);
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
    noiseCtx.putImageData(image, 0, 0);
    grainPattern = ctx.createPattern(noise, 'repeat');
  };

  const readSize = (): void => {
    const rect = root.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(rect.width));
    const nextHeight = Math.max(1, Math.round(rect.height));
    if (nextWidth === width && nextHeight === height) return;
    width = nextWidth;
    height = nextHeight;
    dpr = clamp(window.devicePixelRatio || 1, 1, cfg.dpr);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cacheW = -1;
    cacheH = -1;
    syncLayout();
  };

  /* ── 粒子 ─────────────────────────────────────────────────────── */

  const ensureMotes = (): void => {
    if (motes.length === cfg.dust) return;
    const rand = mulberry32(hashSeed(song?.trackKey ?? 'vinyl'));
    motes = [];
    for (let i = 0; i < cfg.dust; i += 1) {
      motes.push({
        x: rand() * Math.max(1, width || 1200),
        y: rand() * Math.max(1, height || 800),
        size: 0.5 + rand() * 1.6,
        speed: 0.35 + rand() * 1,
        drift: 0.25 + rand() * 0.8,
        phase: rand() * TAU,
        alpha: 0.16 + rand() * 0.36,
      });
    }
  };

  /* ── 绘制 ─────────────────────────────────────────────────────── */

  const drawDisc = (cx: number, cy: number, radius: number): void => {
    if (!ctx) return;
    const light = mixRgb(rgbDisc, rgbWhite, 0.09);
    const deep = mixRgb(rgbDisc, rgbBlack, 0.45);
    const gradient = ctx.createRadialGradient(
      cx - radius * 0.34,
      cy - radius * 0.42,
      radius * 0.04,
      cx,
      cy,
      radius * 1.02,
    );
    gradient.addColorStop(0, rgbStr(light));
    gradient.addColorStop(0.52, rgbStr(rgbDisc));
    gradient.addColorStop(1, rgbStr(deep));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = rgba(mixRgb(rgbDisc, rgbWhite, 0.24), 0.5);
    ctx.lineWidth = Math.max(1, radius * 0.0035);
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.997, 0, TAU);
    ctx.stroke();
  };

  /**
   * 真黑胶的纹路不是完美同心圆：压片时总带一点不规则的起伏。
   * 这里给每一圈加三组不同频率的正弦扰动，按半径缓存成 Path2D；
   * 播放时整盘一起转，纹路的轻微不规则会跟着动，暂停时一起渐停。
   */
  const buildGroovePaths = (radius: number): void => {
    const key = radius.toFixed(1);
    if (key === grooveKey) return;
    grooveKey = key;
    const rand = mulberry32(0x51ed270b);
    const main = new Path2D();
    const accent = new Path2D();
    const count = 46;
    for (let i = 0; i < count; i += 1) {
      const t = i / (count - 1);
      const base = radius * (0.455 + t * 0.535);
      // 每圈半径误差 0.5~2px（R≈300 时），个别圈更明显一点
      const amp = radius * (0.0018 + rand() * 0.0042) * (i % 9 === 4 ? 1.7 : 1);
      const k1 = 2 + Math.floor(rand() * 3);
      const p1 = rand() * TAU;
      const k2 = 5 + Math.floor(rand() * 4);
      const p2 = rand() * TAU;
      const k3 = 11 + Math.floor(rand() * 5);
      const p3 = rand() * TAU;
      const path = i % 7 === 0 ? accent : main;
      const segments = 168;
      for (let s = 0; s <= segments; s += 1) {
        const angle = (s / segments) * TAU;
        const r =
          base +
          Math.sin(angle * k1 + p1) * amp +
          Math.sin(angle * k2 + p2) * amp * 0.52 +
          Math.sin(angle * k3 + p3) * amp * 0.24;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;
        if (s === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.closePath();
    }
    grooveMain = main;
    grooveAccent = accent;

    // 抛光弧：唱片转动时能看出盘面在走，暂停后停在原地。
    grooveGlints = [];
    for (let g = 0; g < 4; g += 1) {
      const startAngle = rand() * TAU;
      const span = 0.16 + rand() * 0.42;
      const ringRadius = radius * (0.58 + rand() * 0.4);
      const path = new Path2D();
      path.arc(0, 0, ringRadius, startAngle, startAngle + span);
      grooveGlints.push({
        path,
        width: Math.max(1, radius * (0.003 + rand() * 0.006)),
        alpha: 0.045 + rand() * 0.065,
      });
    }
  };

  const drawGrooves = (cx: number, cy: number, radius: number): void => {
    if (!ctx || cfg.grooveStrength <= 0.01) return;
    buildGroovePaths(radius);
    // 唱盘转的是盘面上的纹路：绕盘心旋转后再画（外沿、光照和唱臂不动）。
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    if (grooveMain) {
      ctx.strokeStyle = rgba(mixRgb(rgbDisc, rgbWhite, 0.42), cfg.grooveStrength * 0.055);
      ctx.lineWidth = Math.max(0.8, radius * 0.0026);
      ctx.stroke(grooveMain);
    }
    if (grooveAccent) {
      ctx.strokeStyle = rgba(mixRgb(rgbDisc, rgbWhite, 0.62), cfg.grooveStrength * 0.085);
      ctx.lineWidth = Math.max(1, radius * 0.0042);
      ctx.stroke(grooveAccent);
    }
    for (const glint of grooveGlints) {
      ctx.strokeStyle = rgba(mixRgb(rgbWhite, rgbWarm, 0.4), glint.alpha * cfg.grooveStrength);
      ctx.lineWidth = glint.width;
      ctx.stroke(glint.path);
    }
    ctx.restore();
  };

  /** 封面地址变化时重新加载；封面就绪后重画一帧，不用等下一次播放器回调。 */
  const ensureCover = (): void => {
    const url = song?.coverUrl ?? '';
    if (url === coverSrc) return;
    coverSrc = url;
    coverReady = false;
    coverImg = null;
    if (!url) return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (disposed || coverSrc !== url || img.naturalWidth <= 0) return;
      coverImg = img;
      coverReady = true;
      if (width > 0 && ctx) draw(lastPositionMs - safeOffset(), 1 / 60);
    };
    img.onerror = () => {
      if (coverSrc !== url) return;
      coverImg = null;
      coverReady = false;
    };
    img.src = url;
  };

  /**
   * 唱片中心贴纸：有专辑封面就直接印封面（跟着整盘一起转），
   * 没有封面时退回原来的纯色贴纸；「贴纸写歌名」只在没有封面时才印字。
   */
  const drawLabel = (cx: number, cy: number, radius: number): void => {
    if (!ctx) return;
    const labelRadius = radius * cfg.labelSize;
    const cover = coverReady && coverImg ? coverImg : null;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, labelRadius, 0, TAU);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);

    if (cover && cover.naturalWidth > 0 && cover.naturalHeight > 0) {
      // 方形封面居中裁成圆：和真实唱片贴纸一样只露中间一块。
      const iw = cover.naturalWidth;
      const ih = cover.naturalHeight;
      const side = Math.min(iw, ih);
      ctx.globalAlpha = introShown ? 0.72 : 1;
      ctx.drawImage(
        cover,
        (iw - side) / 2,
        (ih - side) / 2,
        side,
        side,
        -labelRadius,
        -labelRadius,
        labelRadius * 2,
        labelRadius * 2,
      );
      ctx.globalAlpha = 1;
      // 贴纸边缘压暗 + 左上高光，让封面像贴在黑胶上而不是浮在表面
      const edge = ctx.createRadialGradient(0, 0, labelRadius * 0.58, 0, 0, labelRadius);
      edge.addColorStop(0, 'rgba(0,0,0,0)');
      edge.addColorStop(0.86, 'rgba(0,0,0,0.16)');
      edge.addColorStop(1, 'rgba(0,0,0,0.5)');
      ctx.fillStyle = edge;
      ctx.fillRect(-labelRadius, -labelRadius, labelRadius * 2, labelRadius * 2);
      const gloss = ctx.createLinearGradient(-labelRadius, -labelRadius, labelRadius * 0.55, labelRadius);
      gloss.addColorStop(0, rgba(rgbWhite, 0.14 * cfg.sheen));
      gloss.addColorStop(0.46, rgba(rgbWhite, 0));
      ctx.fillStyle = gloss;
      ctx.fillRect(-labelRadius, -labelRadius, labelRadius * 2, labelRadius * 2);
    } else {
      const gradient = ctx.createRadialGradient(
        -labelRadius * 0.32,
        -labelRadius * 0.38,
        labelRadius * 0.08,
        0,
        0,
        labelRadius * 1.08,
      );
      gradient.addColorStop(0, rgbStr(mixRgb(rgbLabel, rgbWhite, 0.24)));
      gradient.addColorStop(0.72, rgbStr(rgbLabel));
      gradient.addColorStop(1, rgbStr(mixRgb(rgbLabel, rgbBlack, 0.18)));
      ctx.fillStyle = gradient;
      ctx.fillRect(-labelRadius, -labelRadius, labelRadius * 2, labelRadius * 2);

      ctx.strokeStyle = rgba(mixRgb(rgbLabel, rgbBlack, 0.36), 0.28);
      ctx.lineWidth = 1;
      for (const ring of [0.84, 0.66]) {
        ctx.beginPath();
        ctx.arc(0, 0, labelRadius * ring, 0, TAU);
        ctx.stroke();
      }

      if (cfg.labelText && song && !introShown) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const titleFont = Math.max(9, labelRadius * 0.155);
        const ink = rgba(mixRgb(rgbLabel, rgbBlack, 0.74), 0.94);
        ctx.fillStyle = ink;
        ctx.font = `${cfg.fontWeight} ${titleFont.toFixed(2)}px ${fontStackOf(cfg.fontFamily)}`;
        ctx.fillText(truncate(song.title.trim() || '唱片', 16), 0, -labelRadius * 0.13);
        if (song.artist.trim()) {
          ctx.globalAlpha = 0.68;
          ctx.font = `400 ${(titleFont * 0.6).toFixed(2)}px ${FONT_STACK}`;
          ctx.fillText(truncate(song.artist.trim(), 22), 0, labelRadius * 0.16);
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = rgba(rgbAccent, 0.7);
        ctx.fillRect(-labelRadius * 0.12, labelRadius * 0.34, labelRadius * 0.24, Math.max(1, labelRadius * 0.014));
        ctx.textAlign = 'left';
      }
    }
    ctx.restore();

    // 贴纸外沿：一圈细描边，把封面和黑色纹路分开
    ctx.strokeStyle = rgba(rgbBlack, 0.55);
    ctx.lineWidth = Math.max(1, radius * 0.005);
    ctx.beginPath();
    ctx.arc(cx, cy, labelRadius, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = rgba(rgbAccent, cover ? 0.42 : 0.18);
    ctx.lineWidth = Math.max(1, radius * 0.0022);
    ctx.beginPath();
    ctx.arc(cx, cy, labelRadius * 0.994, 0, TAU);
    ctx.stroke();

    // 中心孔
    ctx.fillStyle = rgba(hexToRgb(cfg.bgBottom), 0.94);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2, labelRadius * 0.05), 0, TAU);
    ctx.fill();
    ctx.strokeStyle = rgba(rgbAccent, 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
  };

  const drawSheen = (cx: number, cy: number, radius: number): void => {
    if (!ctx || cfg.sheen <= 0.01) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.996, 0, TAU);
    ctx.clip();
    const main = ctx.createRadialGradient(
      cx - radius * 0.38,
      cy - radius * 0.47,
      radius * 0.02,
      cx - radius * 0.06,
      cy - radius * 0.1,
      radius * 1.32,
    );
    main.addColorStop(0, rgba(rgbWhite, cfg.sheen * 0.17));
    main.addColorStop(0.42, rgba(rgbWhite, cfg.sheen * 0.05));
    main.addColorStop(1, rgba(rgbWhite, 0));
    ctx.fillStyle = main;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

    const lower = ctx.createRadialGradient(
      cx + radius * 0.34,
      cy + radius * 0.52,
      0,
      cx + radius * 0.22,
      cy + radius * 0.34,
      radius * 0.86,
    );
    lower.addColorStop(0, rgba(rgbGlow, cfg.sheen * 0.06));
    lower.addColorStop(1, rgba(rgbGlow, 0));
    ctx.fillStyle = lower;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();
  };

  /* ── 唱臂：真实唱机的俯视结构 ─────────────────────────────────────
     深色金属底座 + 细长臂管 + 黑色唱头壳；转轴在唱片右上方外侧，
     唱针随播放进度从外圈滑向内圈，暂停时整支臂轻轻抬起。所有尺寸按
     唱片半径取比例，唱片调多大都不会把唱臂拉长。 */
  const drawArm = (cx: number, cy: number, radius: number): void => {
    if (!ctx) return;
    const pivotAngle = -0.34;
    const pivotDist = radius * 1.34;
    const armLength = radius * 1.48;
    const outerRadius = radius * 0.9;
    const innerRadius = radius * 0.44;
    const pivotX = cx + Math.cos(pivotAngle) * pivotDist;
    const pivotY = cy + Math.sin(pivotAngle) * pivotDist;
    const reach = outerRadius + (innerRadius - outerRadius) * clamp(armProgress, 0, 1);
    const cosValue = clamp(
      (reach * reach + pivotDist * pivotDist - armLength * armLength) / (2 * reach * pivotDist),
      -1,
      1,
    );
    const stylusAngle = pivotAngle - Math.acos(cosValue);
    const contactX = cx + Math.cos(stylusAngle) * reach;
    const contactY = cy + Math.sin(stylusAngle) * reach;
    // 暂停抬臂：整支臂（臂管 + 唱头壳 + 配重）绕转轴刚性抬起一点。
    // 注意不能只把臂管的角度拧一下——那样起点转了、唱头还钉在原处，管子会被掰弯。
    const armAngle = Math.atan2(contactY - pivotY, contactX - pivotX);
    const liftAngle = armLift * 0.14;
    const ux = Math.cos(armAngle);
    const uy = Math.sin(armAngle);
    const px = -uy;
    const py = ux;
    const tubeWidth = Math.max(1.1, radius * 0.0115);
    const brass = mixRgb(rgbAccent, rgbWhite, 0.32);
    const metalMid = mixRgb(rgbAccent, rgbBlack, 0.16);
    const metalDark = mixRgb(rgbAccent, rgbBlack, 0.58);
    const ink = mixRgb(rgbBlack, mixRgb(rgbAccent, rgbBlack, 0.12), 0.55);
    // 唱头壳中心（臂管末端）：沿唱头轴向朝转轴方向偏 0.1R，唱针正好落在落点。
    const tangent = stylusAngle + Math.PI / 2;
    const headAngle = tangent + 0.38;
    const headX = contactX + Math.cos(headAngle) * radius * 0.1;
    const headY = contactY + Math.sin(headAngle) * radius * 0.1;
    const baseRadius = radius * 0.086;

    // 底座在画面上的投影。
    const baseShadow = ctx.createRadialGradient(
      pivotX + radius * 0.012,
      pivotY + radius * 0.024,
      baseRadius * 0.2,
      pivotX + radius * 0.012,
      pivotY + radius * 0.024,
      baseRadius * 1.35,
    );
    baseShadow.addColorStop(0, rgba(rgbBlack, 0.5));
    baseShadow.addColorStop(1, rgba(rgbBlack, 0));
    ctx.fillStyle = baseShadow;
    ctx.beginPath();
    ctx.arc(pivotX + radius * 0.012, pivotY + radius * 0.024, baseRadius * 1.35, 0, TAU);
    ctx.fill();

    // 底座：深色金属圆盘 + 黄铜细圈 + 轴承。
    const plateGradient = ctx.createRadialGradient(
      pivotX - baseRadius * 0.3,
      pivotY - baseRadius * 0.34,
      baseRadius * 0.1,
      pivotX,
      pivotY,
      baseRadius,
    );
    plateGradient.addColorStop(0, rgbStr(mixRgb(rgbAccent, rgbBlack, 0.34)));
    plateGradient.addColorStop(0.72, rgbStr(mixRgb(rgbAccent, rgbBlack, 0.56)));
    plateGradient.addColorStop(1, rgbStr(ink));
    ctx.fillStyle = plateGradient;
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, baseRadius, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = rgba(rgbWarm, 0.12);
    ctx.lineWidth = Math.max(1, radius * 0.0035);
    ctx.stroke();
    ctx.strokeStyle = rgba(brass, 0.4);
    ctx.lineWidth = Math.max(0.8, radius * 0.0045);
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, baseRadius * 0.66, 0, TAU);
    ctx.stroke();
    const bearingGradient = ctx.createRadialGradient(pivotX, pivotY, 0, pivotX, pivotY, baseRadius * 0.36);
    bearingGradient.addColorStop(0, rgbStr(ink));
    bearingGradient.addColorStop(1, rgbStr(metalDark));
    ctx.fillStyle = bearingGradient;
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, baseRadius * 0.36, 0, TAU);
    ctx.fill();
    // 轴承顶盖：深色小圆盘 + 细黄铜圈，不用亮色圆心（避免像一颗白螺丝）。
    ctx.fillStyle = rgbStr(mixRgb(rgbBlack, metalDark, 0.18));
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, baseRadius * 0.14, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = rgba(brass, 0.42);
    ctx.lineWidth = Math.max(0.7, radius * 0.0028);
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, baseRadius * 0.14, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = rgba(rgbBlack, 0.55);
    for (const screwAngle of [0.8, 2.5]) {
      ctx.beginPath();
      ctx.arc(
        pivotX + Math.cos(screwAngle) * baseRadius * 0.85,
        pivotY + Math.sin(screwAngle) * baseRadius * 0.85,
        Math.max(0.8, radius * 0.006),
        0,
        TAU,
      );
      ctx.fill();
    }

    // 臂管在盘面上的投影：抬臂越高，影子离唱臂越远、边缘越散（高度差）。
    const bend = radius * 0.016;
    const startX = pivotX + ux * baseRadius * 0.28;
    const startY = pivotY + uy * baseRadius * 0.28;
    const midX = (startX + headX) / 2 + px * bend;
    const midY = (startY + headY) / 2 + py * bend;
    const shadowOffset = radius * (0.022 + 0.03 * armLift);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.995, 0, TAU);
    ctx.clip();
    ctx.strokeStyle = rgba(rgbBlack, 0.3 - 0.1 * armLift);
    ctx.lineWidth = tubeWidth * (2.3 + 1.1 * armLift);
    ctx.beginPath();
    ctx.moveTo(startX + radius * 0.01, startY + shadowOffset);
    ctx.quadraticCurveTo(
      midX + radius * 0.01,
      midY + shadowOffset,
      headX + radius * 0.008,
      headY + shadowOffset + radius * 0.005,
    );
    ctx.stroke();
    ctx.restore();

    // 抬臂姿态：配重、臂管、唱头壳作为同一刚体绕转轴旋转，不再各转各的。
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(liftAngle);
    ctx.translate(-pivotX, -pivotY);

    // 配重：从转轴向后伸出的短杆 + 深色圆柱（两端黄铜圈）。
    ctx.strokeStyle = rgbStr(metalDark);
    ctx.lineWidth = tubeWidth * 1.25;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pivotX - ux * baseRadius * 0.5, pivotY - uy * baseRadius * 0.5);
    ctx.lineTo(pivotX - ux * radius * 0.2, pivotY - uy * radius * 0.2);
    ctx.stroke();
    const weightCenterX = pivotX - ux * radius * 0.24;
    const weightCenterY = pivotY - uy * radius * 0.24;
    ctx.save();
    ctx.translate(weightCenterX, weightCenterY);
    ctx.rotate(armAngle);
    const weightHalf = radius * 0.082;
    const weightR = radius * 0.054;
    const weightGradient = ctx.createLinearGradient(0, -weightR, 0, weightR);
    weightGradient.addColorStop(0, rgbStr(mixRgb(rgbAccent, rgbBlack, 0.58)));
    weightGradient.addColorStop(0.34, rgbStr(mixRgb(rgbAccent, rgbBlack, 0.42)));
    weightGradient.addColorStop(0.72, rgbStr(metalDark));
    weightGradient.addColorStop(1, rgbStr(ink));
    ctx.fillStyle = weightGradient;
    ctx.beginPath();
    ctx.roundRect(-weightHalf, -weightR, weightHalf * 2, weightR * 2, weightR * 0.42);
    ctx.fill();
    ctx.strokeStyle = rgba(rgbBlack, 0.55);
    ctx.lineWidth = Math.max(0.7, radius * 0.003);
    ctx.stroke();
    ctx.strokeStyle = rgba(brass, 0.42);
    ctx.lineWidth = Math.max(0.8, radius * 0.0042);
    for (const offset of [-0.62, 0.62]) {
      ctx.beginPath();
      ctx.moveTo(weightHalf * offset, -weightR * 0.74);
      ctx.lineTo(weightHalf * offset, weightR * 0.74);
      ctx.stroke();
    }
    // 端面：暗色圆盖，边缘一圈微亮。
    ctx.fillStyle = rgbStr(mixRgb(rgbAccent, rgbBlack, 0.62));
    ctx.beginPath();
    ctx.ellipse(-weightHalf * 0.96, 0, weightR * 0.16, weightR * 0.86, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    // 臂管：细长金属管，横向渐变模拟圆柱反光。
    const tubeGradient = ctx.createLinearGradient(
      midX - px * tubeWidth * 1.6,
      midY - py * tubeWidth * 1.6,
      midX + px * tubeWidth * 1.6,
      midY + py * tubeWidth * 1.6,
    );
    tubeGradient.addColorStop(0, rgbStr(mixRgb(rgbAccent, rgbBlack, 0.5)));
    tubeGradient.addColorStop(0.3, rgbStr(mixRgb(brass, rgbWhite, 0.18)));
    tubeGradient.addColorStop(0.58, rgbStr(metalMid));
    tubeGradient.addColorStop(1, rgbStr(ink));
    ctx.strokeStyle = rgba(rgbBlack, 0.55);
    ctx.lineWidth = tubeWidth * 1.7;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.quadraticCurveTo(midX, midY, headX, headY);
    ctx.stroke();
    ctx.strokeStyle = tubeGradient;
    ctx.lineWidth = tubeWidth;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.quadraticCurveTo(midX, midY, headX, headY);
    ctx.stroke();
    ctx.strokeStyle = rgba(rgbWhite, 0.3);
    ctx.lineWidth = Math.max(0.6, tubeWidth * 0.26);
    ctx.beginPath();
    ctx.moveTo(startX - px * tubeWidth * 0.26, startY - py * tubeWidth * 0.26);
    ctx.quadraticCurveTo(
      midX - px * tubeWidth * 0.26,
      midY - py * tubeWidth * 0.26,
      headX - px * tubeWidth * 0.26,
      headY - py * tubeWidth * 0.26,
    );
    ctx.stroke();

    // 唱头壳：以唱针落点为原点，x 轴沿唱头轴向（朝转轴一侧），唱针在原点。
    ctx.save();
    ctx.translate(contactX, contactY);
    ctx.rotate(headAngle);
    // 壳体：前窄后宽的梯形板，深色金属面，前缘一道黄铜细线。
    const shellFrontX = radius * 0.012;
    const shellRearX = radius * 0.126;
    const shellGradient = ctx.createLinearGradient(0, -radius * 0.036, 0, radius * 0.036);
    shellGradient.addColorStop(0, rgbStr(mixRgb(rgbAccent, rgbBlack, 0.64)));
    shellGradient.addColorStop(0.5, rgbStr(mixRgb(metalDark, rgbBlack, 0.46)));
    shellGradient.addColorStop(1, rgbStr(ink));
    ctx.fillStyle = shellGradient;
    ctx.beginPath();
    ctx.moveTo(shellFrontX, -radius * 0.024);
    ctx.lineTo(shellRearX, -radius * 0.035);
    ctx.lineTo(shellRearX, radius * 0.035);
    ctx.lineTo(shellFrontX, radius * 0.024);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = rgba(rgbBlack, 0.6);
    ctx.lineWidth = Math.max(0.7, radius * 0.003);
    ctx.stroke();
    // 前缘黄铜细线 + 后缘金属缝
    ctx.strokeStyle = rgba(brass, 0.38);
    ctx.lineWidth = Math.max(0.7, radius * 0.0026);
    ctx.beginPath();
    ctx.moveTo(shellFrontX + radius * 0.002, -radius * 0.023);
    ctx.lineTo(shellFrontX + radius * 0.002, radius * 0.023);
    ctx.stroke();
    ctx.strokeStyle = rgba(rgbWarm, 0.16);
    ctx.beginPath();
    ctx.moveTo(shellRearX - radius * 0.002, -radius * 0.034);
    ctx.lineTo(shellRearX - radius * 0.002, radius * 0.034);
    ctx.stroke();
    // 唱头本体：压在壳体前段的黑色方盒
    ctx.fillStyle = rgbStr(mixRgb(rgbBlack, ink, 0.4));
    ctx.beginPath();
    ctx.roundRect(radius * 0.022, -radius * 0.017, radius * 0.07, radius * 0.034, radius * 0.006);
    ctx.fill();
    ctx.strokeStyle = rgba(rgbWarm, 0.12);
    ctx.lineWidth = Math.max(0.6, radius * 0.0022);
    ctx.stroke();
    // 唱针杆：从唱头前缘伸到落点
    ctx.strokeStyle = rgbStr(brass);
    ctx.lineWidth = Math.max(0.8, radius * 0.003);
    ctx.beginPath();
    ctx.moveTo(radius * 0.03, 0);
    ctx.lineTo(radius * 0.003, 0);
    ctx.stroke();
    const tipGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 0.013);
    tipGlow.addColorStop(0, rgba(rgbWarm, 0.24 * (1 - armLift * 0.85)));
    tipGlow.addColorStop(1, rgba(rgbWarm, 0));
    ctx.fillStyle = tipGlow;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.013, 0, TAU);
    ctx.fill();
    ctx.fillStyle = rgba(rgbWarm, 0.58 * (1 - armLift * 0.8));
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(0.8, radius * 0.0036), 0, TAU);
    ctx.fill();
    // 两颗固定螺丝（打在壳体后半段，沿轴排布）
    ctx.fillStyle = rgba(brass, 0.34);
    for (const screwX of [radius * 0.05, radius * 0.105]) {
      ctx.beginPath();
      ctx.arc(screwX, radius * 0.024, Math.max(0.7, radius * 0.0032), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    ctx.restore();
  };

  const drawMotes = (dt: number): void => {
    if (!ctx || motes.length === 0) return;
    const speedScale = (lastPlaying ? 1 : 0.22) * cfg.dustSpeed;
    for (const mote of motes) {
      mote.phase += dt * 0.55;
      mote.y -= (5 + mote.speed * 12) * dt * speedScale;
      mote.x += Math.sin(mote.phase * 1.3) * mote.drift * 7 * dt * speedScale;
      if (mote.y < -12) {
        mote.y = height + 12;
        mote.x = (mote.x * 1.37 + width * 0.41) % Math.max(1, width);
      }
      if (mote.x < -12) mote.x = width + 12;
      if (mote.x > width + 12) mote.x = -12;
      const shimmer = 0.5 + 0.5 * Math.sin(mote.phase * 1.7 + mote.speed * 3);
      ctx.fillStyle = rgba(rgbWarm, mote.alpha * (0.35 + 0.65 * shimmer));
      ctx.beginPath();
      ctx.arc(mote.x, mote.y, mote.size, 0, TAU);
      ctx.fill();
    }
  };

  const drawProgressRing = (cx: number, cy: number, radius: number, effectivePositionMs: number): void => {
    if (!ctx || !song) return;
    const duration = song.durationMs;
    if (!(duration > 0)) return;
    const progress = clamp(effectivePositionMs / duration, 0, 1);
    const ringRadius = radius * 1.028;
    const start = -Math.PI / 2;
    ctx.lineWidth = Math.max(1.4, radius * 0.011);
    ctx.strokeStyle = rgba(rgbAccent, 0.16);
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, 0, TAU);
    ctx.stroke();
    if (progress > 0.001) {
      ctx.strokeStyle = rgba(rgbAccent, 0.88);
      ctx.beginPath();
      ctx.arc(cx, cy, ringRadius, start, start + progress * TAU);
      ctx.stroke();
      const headAngle = start + progress * TAU;
      const headX = cx + Math.cos(headAngle) * ringRadius;
      const headY = cy + Math.sin(headAngle) * ringRadius;
      const headGlow = ctx.createRadialGradient(headX, headY, 0, headX, headY, radius * 0.062);
      headGlow.addColorStop(0, rgba(mixRgb(rgbGlow, rgbWarm, 0.35), 0.72 * clamp(progress / 0.05, 0.2, 1)));
      headGlow.addColorStop(1, rgba(rgbGlow, 0));
      ctx.fillStyle = headGlow;
      ctx.beginPath();
      ctx.arc(headX, headY, radius * 0.062, 0, TAU);
      ctx.fill();
    }
  };

  const draw = (effectivePositionMs: number, dt: number): void => {
    if (!ctx || width <= 0 || height <= 0) return;
    ensureCaches();
    ensureGrain();

    const minSide = Math.min(width, height);
    const cx = width * cfg.discX;
    const cy = height * cfg.discY;
    const radius = minSide * cfg.discSize * (1 + energyNow * 0.004 * cfg.energy);

    ctx.clearRect(0, 0, width, height);
    if (bgGradient) {
      ctx.fillStyle = bgGradient;
      ctx.fillRect(0, 0, width, height);
    }
    if (spotGradient) {
      ctx.fillStyle = spotGradient;
      ctx.fillRect(0, 0, width, height);
    }

    // 唱片在台面上的投影
    if (shadowGradient) {
      ctx.save();
      ctx.translate(cx, cy + radius * 1.02);
      ctx.scale(1, 0.22);
      ctx.fillStyle = shadowGradient;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.6, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    drawDisc(cx, cy, radius);
    drawGrooves(cx, cy, radius);
    drawLabel(cx, cy, radius);
    drawSheen(cx, cy, radius);
    drawProgressRing(cx, cy, radius, effectivePositionMs);
    if (cfg.showArm) drawArm(cx, cy, radius);
    drawMotes(dt);

    if (vignetteGradient) {
      ctx.fillStyle = vignetteGradient;
      ctx.fillRect(0, 0, width, height);
    }

    if (cfg.grain > 0.001 && grainPattern) {
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = clamp(cfg.grain * 2.4, 0, 1);
      ctx.fillStyle = grainPattern;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
  };

  /* ── 时钟 ─────────────────────────────────────────────────────── */

  const update = (positionMs: number, playing: boolean, energy = 0): void => {
    if (disposed) return;
    const now = performance.now();
    const dt = lastNow > 0 ? clamp((now - lastNow) / 1000, 0, 0.1) : 1 / 60;
    lastNow = now;
    lastPlaying = playing;
    if (width <= 0) readSize();
    if (width <= 0) return;

    const safePosition = Number.isFinite(positionMs) ? Math.max(0, positionMs) : 0;
    lastPositionMs = safePosition;
    ensureCover();
    energyNow = damp(energyNow, clamp(Number.isFinite(energy) ? energy : 0, 0, 1), 5, dt);

    // 转速与转向：播放时匀速转，暂停/切歌时慢慢停下；唱臂同步抬起。
    const spinSign = cfg.spinDirection === 'ccw' ? -1 : 1;
    const targetOmega = playing ? (spinSign * cfg.rpm * TAU) / 60 : 0;
    omega = damp(omega, targetOmega, playing ? 3.1 : 1.5, dt);
    rotation = (rotation + omega * dt) % TAU;

    if (song && song.durationMs > 0) {
      armProgress = damp(armProgress, clamp(safePosition / song.durationMs, 0, 1), 2.6, dt);
    }
    // 抬臂姿态平滑过渡：暂停时抬起、继续播放时落下（不再瞬间跳变）。
    armLift = damp(armLift, cfg.armLiftOnPause && !playing ? 1 : 0, 8, dt);

    const effectivePosition = safePosition - safeOffset();
    const nextIndex = indexAt(effectivePosition);
    if (nextIndex !== activeIndex) {
      activeIndex = nextIndex;
      syncLayout();
      if (activeIndex >= 0) {
        for (let i = 0; i < views.length; i += 1) {
          if (i !== activeIndex) applyLineStates(i, i < activeIndex ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
        }
        applyLineStates(activeIndex, effectivePosition);
      }
    } else if (activeIndex >= 0) {
      applyLineStates(activeIndex, effectivePosition);
    }
    syncTitleCard(effectivePosition);
    draw(effectivePosition, dt);

    if (!painted) {
      painted = true;
      options.onPainted?.();
    }
  };

  /* ── 生命周期 ─────────────────────────────────────────────────── */

  const resizeObserver = new ResizeObserver(() => {
    readSize();
  });
  resizeObserver.observe(root);

  /** 快捷设置里换了歌词播放样式：换个根 class，并按当前播放位置重刷逐字状态。 */
  let currentLyricStyle: LyricStyle = lyricStyle();
  const offLyricStyle = onLyricStyle(() => {
    if (disposed) return;
    const next = lyricStyle();
    if (next === currentLyricStyle) return;
    currentLyricStyle = next;
    root.className = `zl-vinyl-scene zvs-style-${currentLyricStyle}`;
    refreshCharStates();
  });

  refreshPalette();
  applyCssVars();
  ensureMotes();

  return {
    root,

    setStyle(next: Partial<VinylStyleSettings>): void {
      if (disposed) return;
      cfg = normalizeVinylSettings({ ...cfg, ...next });
      refreshPalette();
      applyCssVars();
      ensureMotes();
      resetWordStates();
      syncLayout();
      syncTrackText();
      if (width > 0 && ctx) draw(lastPositionMs - safeOffset(), 1 / 60);
    },

    setLyricTint(tint: RoomLyricTint | null): void {
      if (disposed) return;
      const usable = tint && tint.palette.length > 0 ? tint : null;
      const key = usable ? `${usable.mode}|${usable.palette.join(',')}` : '';
      if (key === tintKey) return;
      tintKey = key;
      lyricTint = usable;
      refreshPalette();
      applyCssVars();
      resetWordStates();
      syncLayout();
      if (width > 0 && ctx) draw(lastPositionMs - safeOffset(), 1 / 60);
    },

    setSong(input: VinylSceneSong | null): void {
      if (disposed) return;
      const first = input?.lines[0];
      const last = input?.lines[input.lines.length - 1];
      const nextKey = input
        ? `${input.trackKey}|${input.title}|${input.artist}|${input.durationMs}|${input.lyricOffsetMs ?? 0}|${input.lines.length}|${first?.timeMs ?? 0}|${last?.timeMs ?? 0}|${input.coverUrl ?? ''}`
        : '';
      if (nextKey === songKey && input) {
        song = input;
        lines = input.lines;
        ensureCover();
        syncTrackText();
        return;
      }
      songKey = nextKey;
      song = input;
      ensureCover();
      lines = input ? filterCreditLines(input) : [];
      keywords = [];
      refreshKeywords();
      rebuildLines();
      ensureMotes();
      syncTrackText();
      syncLayout();
      activeIndex = -1;
      if (width > 0 && ctx) draw(lastPositionMs - safeOffset(), 1 / 60);
    },

    update,

    resize(): void {
      if (disposed) return;
      readSize();
      if (width > 0 && ctx) draw(lastPositionMs - safeOffset(), 1 / 60);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      offLyricStyle();
      resizeObserver.disconnect();
      wordsLayer.textContent = '';
      views = [];
      lines = [];
      song = null;
      coverImg = null;
      coverReady = false;
      motes = [];
      root.remove();
    },
  };
}
