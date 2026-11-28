/**
 * 歌词页「播放效果 · 话语」。
 *
 * 内容设定：整首歌就是一段聊天记录。每一句歌词是对方/自己发来的一条消息，
 * 唱到这一句才「发出去」，一句接一句从底部弹进画面，旧消息被顶上去、到顶部渐隐。
 * 左右分侧由「歌 + 行号」的确定性哈希决定（同一首歌每次进入左右一致，不会重开就换边），
 * 并强制与上一条不同侧，看起来才像有来有回。
 *
 * 画面元素：
 *   - 气泡：圆角 + 小尾巴那侧的直角、行内逐词跟唱点亮（已唱实色 / 正在唱高亮发光 / 未唱压暗）；
 *   - 译文：气泡内下方一行更小更暗的字，跟着同一句一起入场；
 *   - 头像：左侧「话」、右侧「语」，底色分别取半透明白与主题强调色；
 *   - 已发送：句子唱完后右下角浮出两个小勾（只有右侧消息有，像自己发的）；
 *   - 正在输入：句与句之间的空档，在下一句那一侧冒出三点跳动，表示下一条快来了。
 *
 * 样式契约与房间 / 唱片一致：
 *   - activate() 给 root 挂 is-on，CSS 才淡入；
 *   - 真的画出第一条消息之后才挂 is-ready / is-painted / is-content，歌词页的 CSS 看到它们才收 DOM 歌词；
 *   - deactivate() 先摘 is-on 让 CSS 淡出，700ms 后才拆画布，来回切档不硬切、不黑场；
 *   - 任何异常挂 is-failed，歌词页的 CSS 会把 DOM 歌词放回来。
 *
 * 动画三件套（AGENTS.md 硬性要求）：
 *   入场 = 气泡从自己那一侧横向滑入 + 轻微放大 + 下方 26px 归位，260ms ease-out；
 *   出场 = 被顶上来的旧气泡沿同一条轨迹的反向（向上、缩小、alpha 归零）离开，不是瞬间消失；
 *   打断 = 换句太快时，旧气泡按自己的「已经过时间」继续往上推，新气泡从自己的 0 开始入场，
 *          两个方向各自连续，谁都不会从半途跳回起点；跳播/切歌则整层淡入重来（260ms 交叉）。
 */

import {
  huayuSettings,
  saveHuayuSettings,
  buildShapeSequence,
  type HuayuShape,
  type HuayuBubbleStyle,
  type HuayuEnter,
  type HuayuSideMode,
} from './huayuSettings';
import { drawMessageMotif, lineMotifs } from './huayuMessageMotifs';
import { coverColorsOfUrl } from './coverColors';
import { onPlayer, playAt, playerState } from './player';
import type { OnlineTrack } from '../online/types';
import { onlineArtwork } from '../online/artwork';
import type { LumiereMode, LumiereSongInput } from './lumiere';
import type { Theme } from './lumiere-folia/types';

type SongLine = LumiereSongInput['lines'][number];
type Site = 'left' | 'right';

export interface HuayuStage {
  readonly root: HTMLDivElement;
  setMode(mode: LumiereMode): void;
  setSong(input: LumiereSongInput | null): void;
  setTheme(theme: Theme): void;
  activate(): void;
  deactivate(): void;
  dispose(): void;
}

/* ── 节奏与观感常数 ─────────────────────────────────────────── */

const TEARDOWN_MS = 700;
/** 顶部渐隐线：气泡越往上越淡。 */
const FADE_TOP_RATIO = 0.14;

const DEFAULT_FONT_STACK = '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

const fallback = {
  primaryColor: '#f5f1ea',
  accentColor: '#e6c184',
  secondaryColor: '#8f939b',
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
/** 轻微的过冲弹一下，气泡落地才不像贴图。 */
/** 时间戳：0:07 / 3:24，聊天记录那味道。 */
const clockText = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const minute = Math.floor(total / 60);
  const second = total % 60;
  return `${minute}:${second < 10 ? '0' : ''}${second}`;
};

/** 歌词正文摘要：同曲换源 / 补翻译时行数与首末时间可能不变，签名必须带上正文。 */
function lyricsTextDigest(lines: LumiereSongInput['lines']): string {
  if (lines.length === 0) return '0';
  let hash = 0x811c9dc5;
  for (const line of lines) {
    const text = `${line.text}\u0000${line.translation}`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `${lines.length}:${hash.toString(16)}`;
}

function songSignature(input: LumiereSongInput | null): string {
  if (!input) return '';
  const first = input.lines[0];
  const last = input.lines[input.lines.length - 1];
  return `${input.trackKey}|${input.durationMs}|${input.lyricOffsetMs}|${input.lines.length}|${first?.timeMs ?? 0}|${last?.timeMs ?? 0}|${lyricsTextDigest(input.lines)}`;
}

/** 左右分侧（随机）：纯确定性哈希，跟歌名+行号定死；**不再**强制和上一条换边 ——
    之前那条强制换边把「随机」变成了严格交替，和「交替」看着一模一样。 */
function siteOf(trackKey: string, index: number, previous: Site | null): Site {
  if (!previous) {
    // 第一句也给个确定但不总在左边的起点，避免每首歌都从同一侧开聊。
    let seed = 0x9e3779b9 ^ Math.imul(index + 1, 0x85ebca6b);
    for (let i = 0; i < trackKey.length; i += 1) {
      seed ^= trackKey.charCodeAt(i);
      seed = Math.imul(seed, 0x01000193) >>> 0;
    }
    return (seed & 1) === 0 ? 'left' : 'right';
  }
  let hash = 0x9e3779b9 ^ Math.imul(index + 1, 0x85ebca6b);
  for (let i = 0; i < trackKey.length; i += 1) {
    hash ^= trackKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2545f491) >>> 0;
  // 偏一点：同一个人的概率略高于换边（约 6:4），读起来更像真实聊天里的连发。
  const flip = ((hash >>> 8) % 10) >= 4;
  if (!flip) return previous;
  return previous === 'left' ? 'right' : 'left';
}

/* ── 排版数据结构 ───────────────────────────────────────────── */

interface Glyph {
  text: string;
  width: number;
  startMs: number;
  endMs: number;
}

interface LaidRow {
  glyphs: Glyph[];
  width: number;
}

interface BubbleLayout {
  rows: LaidRow[];
  translationRows: LaidRow[];
  width: number;
  height: number;
  bodySize: number;
  bodyLineHeight: number;
  transSize: number;
  transLineHeight: number;
  padX: number;
  padY: number;
  /** 底部 meta 带的高度（时间戳 / 已读双勾），0 = 两项都关。 */
  metaH: number;
  /** 顶部引用块里那句话（已按宽度截断），空串 = 这条不引用。 */
  quoteText: string;
  /** 引用块连同上下间距一共占的高度，0 = 不引用。 */
  quoteH: number;
}

interface Entry {
  index: number;
  site: Site;
  layout: BubbleLayout;
  top: number;
  targetTop: number;
  phase: number;
  retiring: boolean;
  /** 上次算出的可见度，用来判断能否直接丢掉。 */
  fade: number;
}

/** 聊天配色：跟主题色走，但右侧气泡强调色底上的字必须压成深色才读得清。 */
interface Palette {
  leftFill: string;
  leftText: string;
  leftMuted: string;
  rightFill: string;
  rightFillEdge: string;
  rightText: string;
  rightMuted: string;
  hotOnLeft: string;
  hotOnRight: string;
  avatarLeft: string;
  avatarLeftText: string;
  avatarRight: string;
  avatarRightText: string;
  tick: string;
  typingFill: string;
  typingDot: string;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const raw = match[1]!;
  const full = raw.length === 3 ? raw.split('').map((ch) => ch + ch).join('') : raw;
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return a;
  const channel = (i: number): number => Math.round(lerp(ca[i]!, cb[i]!, t));
  return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`;
}

/** 解析 '#rgb' / '#rrggbb' / 'rgb(r g b)' / 'rgb(r g b / a)'，拿不到就返回 null。 */
function parseColor(value: string): [number, number, number, number] | null {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const raw = hex[1]!;
    const full = raw.length === 3 ? raw.split('').map((ch) => ch + ch).join('') : raw;
    const num = Number.parseInt(full, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255, 1];
  }
  const body = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (!body) return null;
  const parts = body[1]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (raw: string, max: number): number => {
    const parsed = raw.endsWith('%') ? (Number.parseFloat(raw) / 100) * max : Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [channel(parts[0]!, 255), channel(parts[1]!, 255), channel(parts[2]!, 255), parts[3] ? channel(parts[3], 1) : 1];
}

/** 两个颜色之间插值（含 alpha），逐字点亮要的就是这种连续过渡。 */
function blendColor(from: string, to: string, t: number): string {
  const a = parseColor(from);
  const b = parseColor(to);
  if (!a || !b) return t < 0.5 ? from : to;
  const k = clamp01(t);
  const channel = (i: number): number => Math.round(lerp(a[i]!, b[i]!, k));
  const alpha = Math.round(lerp(a[3], b[3], k) * 1000) / 1000;
  return `rgb(${channel(0)} ${channel(1)} ${channel(2)} / ${alpha})`;
}

/** 给任意颜色换一个 alpha。 */
function withAlpha(color: string, alpha: number): string {
  const parsed = parseColor(color);
  if (!parsed) return color;
  const value = Math.round(clamp01(alpha) * 1000) / 1000;
  return `rgb(${Math.round(parsed[0])} ${Math.round(parsed[1])} ${Math.round(parsed[2])} / ${value})`;
}

export interface HuayuStageOptions {
  /** 设置面板预览用：不跟播放器走，直接读这个时钟（毫秒）。 */
  clock?: () => number;
}

export function createHuayuStage(options: HuayuStageOptions = {}): HuayuStage {
  const externalClock = options.clock ?? null;
  const root = document.createElement('div');
  root.className = 'lyrics-stage is-huayu';

  const canvas = document.createElement('canvas');
  canvas.className = 'huayu-canvas';
  root.append(canvas);
  const ctx = canvas.getContext('2d');

  /* ── 真输入：canvas 上盖一层全透明 textarea ──────────────────
     键盘、输入法、选中、粘贴全部交给它，字形和光标仍由 canvas 自己画，
     所以看起来还是那张「聊天输入条」，但打字是真打、能发。 */
  const input = document.createElement('textarea');
  input.className = 'huayu-input';
  input.rows = 1;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('aria-label', '话语输入');
  root.append(input);
  let inputFocused = false;
  let inputValue = '';
  /** 手动发出去的消息：真的插进这条聊天流里，跟歌词气泡共用同一条长卷。 */
  interface LocalMessage {
    seq: number;
    /** 插在第几行歌词后面（发送时正在唱的那句）。 */
    atIndex: number;
    line: SongLine;
    layout: BubbleLayout;
    bornAt: number;
    top: number;
    /** 占位高度从 0 长到 1：镜头和长卷一起把它「撑」出来，不会一瞬间跳一格。 */
    grow: number;
    /** 已经淡完，正在把占位高度收回去。 */
    dying: boolean;
  }
  let locals: LocalMessage[] = [];
  let localSeq = 0;
  let lastSongMs = 0;
  let overlayBox = { x: -1, y: -1, w: -1, h: -1 };

  let disposed = false;
  let active = false;
  let mode: LumiereMode = 'off';
  let song: LumiereSongInput | null = null;
  let songKey = '';
  /** 整首歌每条消息的分侧：只跟 (trackKey, 行号) 有关，窗口怎么滑都不会变。 */
  let sides: Site[] = [];
  let theme: Theme | null = null;
  /** 「随曲」配色：从当前封面抽出来的主色；取不到就退回主题色。 */
  let coverAccent: string | null = null;
  let coverAccentKey = '';
  let palette: Palette = buildPalette(null);
  let raf = 0;
  let teardownTimer = 0;
  let painted = false;

  /* ── 播放时钟（锚定 + performance.now 补齐，不吃 40ms 的位置跳变） ── */

  let anchorMs = 0;
  let anchorAt = 0;
  let playing = false;

  const syncPlayer = (): void => {
    const state = playerState();
    anchorMs = Number.isFinite(state.positionMs) ? Math.max(0, state.positionMs) : 0;
    anchorAt = performance.now();
    playing = state.playing;
  };

  const unsubscribe = onPlayer(() => {
    syncPlayer();
  });

  /* ── 画布尺寸 ─────────────────────────────────────────────── */

  let viewWidth = 1;
  let viewHeight = 1;
  let dpr = 1;
  let bodySize = 24;
  let padX = 20;
  let padY = 15;
  let gap = 16;
  let sideMargin = 40;
  /** 右侧内容边界：对称留白只算 gutter，不再把会话栏那份宽度也留到右边。 */
  let contentRight = 1000;
  let gutter = 40;
  let avatarSize = 34;
  /** 底部输入条：高度与顶边。 */
  let composerH = 0;
  let composerTop = 0;
  /** 发送钮的悬停/按下两个连续量（0–1），都靠阻尼跟手，不做瞬时跳变。 */
  let sendHover = 0;
  let sendHoverOn = false;
  let sendPress = 0;
  /** 草稿的淡入淡出、当前露出的字数（唱完停在原位淡出，不是「啪」一下消失）。 */
  let draftAlpha = 0;
  let draftChars: string[] = [];
  let draftShown = 0;
  let avatarGap = 10;
  let maxTextWidth = 420;
  let baseY = 400;
  let fadeTop = 80;
  let fontFamily = DEFAULT_FONT_STACK;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const metrics = (): void => {
    const cfg = huayuSettings();
    // 字号整体抬一档：原来 19px 封顶，在 1080p 上像备注；现在按视高 2.8% 取，封顶 28。
    const chatFont = Math.max(17, Math.min(28, Math.min(viewWidth, viewHeight) * .028));
    bodySize = Math.max(12, Math.round(chatFont * cfg.fontScale));
    padX = Math.round(bodySize * .73);
    padY = Math.round(bodySize * .4);
    gap = Math.round(bodySize * .6);
    // 会话栏：屏幕够宽才出现；宽度有下限，太窄名字和摘要会被挤成一排省略号。
    railUnit = Math.max(13, Math.min(21, Math.round(viewHeight * .0195)));
    railW = cfg.showContacts && viewWidth >= 760
      ? Math.round(Math.min(viewWidth * 0.34, Math.max(260, viewHeight * 0.30, railUnit * 13)) * cfg.railScale)
      : 0;
    gutter = Math.max(16, Math.round(viewWidth * 0.04));
    // 左边让出会话栏，右边只留普通留白 —— 之前两边都按 railW+gutter 缩，右半屏白白空了一条。
    sideMargin = railW + gutter;
    contentRight = viewWidth - gutter;
    // 头像放大一档：原来 1.42 倍字号，压在气泡旁边像个小圆点。
    avatarSize = cfg.showAvatar ? Math.round(bodySize * 1.78) : 0;
    avatarGap = cfg.showAvatar ? Math.max(14, Math.round(bodySize * .92)) : 0;
    maxTextWidth = Math.round(Math.min(viewWidth * cfg.widthRatio, bodySize * 26));
    maxTextWidth = Math.max(bodySize, Math.min(maxTextWidth, viewWidth - sideMargin - gutter - avatarSize - avatarGap - 2 * padX));
    // 底部输入条：高度按字号走，气泡落点要抬到它上面，别让最新一条被输入框压住。
    // 关掉输入条时，这块高度直接还给画面：落点跟着下移，不留一条空白。
    const cfgForBar = huayuSettings();
    composerH = cfgForBar.showComposer ? Math.round(bodySize * 2.75) : 0;
    composerTop = viewHeight - (cfgForBar.showComposer ? Math.round(bodySize * 1.6) : 0) - composerH;
    baseY = Math.round(viewHeight * cfg.baseRatio);
    baseY = Math.min(baseY, composerTop - Math.round(gap * 2.4));
    if (cfg.chatWindow) baseY = Math.min(baseY, viewHeight - bodySize * 2.6);
    fadeTop = Math.round(viewHeight * FADE_TOP_RATIO);
  };

  /** 影响排版的设置指纹：变了就重测文字宽度（拖动字号/气泡宽度滑杆时实时跟）。 */
  const layoutKeyOf = (): string => {
    const cfg = huayuSettings();
    return `${cfg.sideMode}|${cfg.showContacts}|${cfg.railScale}|${railW}|${cfg.chatWindow}|${cfg.fontScale}|${cfg.widthRatio}|${cfg.showAvatar}|${cfg.showTime}|${cfg.showTicks}|${cfg.showTranslation}|${cfg.bubbleStyle}|${cfg.quoteChance}|${viewWidth}x${viewHeight}`;
  };
  let layoutKey = '';

  /* ── 画布坐标：按整首歌累计，和窗口里正好看到哪几条无关 ──
     基准要是跟着窗口走，老消息掉出可视条数的那一帧整摞就会重排，画面上就是「瞬间跳一下」。 */

  let spanKey = '';
  let spanTops: number[] = [0];

  const canvasTopOf = (index: number): number => {
    const key = layoutKeyOf();
    if (key !== spanKey) {
      spanKey = key;
      spanTops = [0];
    }
    for (let i = spanTops.length - 1; i < index; i += 1) {
      spanTops.push((spanTops[i] ?? 0) + layoutOf(i).height + gap);
    }
    // 自己发的消息插在某句之后，后面所有行要整体让位，不然会跟它重叠。
    let shift = 0;
    for (const msg of locals) {
      if (msg.atIndex < index) shift += (msg.layout.height + gap) * msg.grow;
    }
    return baseY + (spanTops[index] ?? 0) + shift;
  };

  const resize = (): void => {

    viewWidth = Math.max(1, Math.round(root.clientWidth || window.innerWidth));
    viewHeight = Math.max(1, Math.round(root.clientHeight || window.innerHeight));
    dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(viewWidth * dpr);
    canvas.height = Math.round(viewHeight * dpr);
    canvas.style.width = `${viewWidth}px`;
    canvas.style.height = `${viewHeight}px`;
    metrics();
    layoutKey = layoutKeyOf();
    layoutCache.clear();
    // 尺寸变了，已排好的气泡宽度全作废，重排后从当前位置继续滑。
    for (const entry of entries) entry.layout = layoutOf(entry.index);
  };

  const onWindowResize = (): void => {
    if (!active) return;
    resize();
  };
  const sizeObserver = new ResizeObserver(onWindowResize);
  sizeObserver.observe(root);

  /* ── 主题配色 ─────────────────────────────────────────────── */

  function buildPalette(source: Theme | null): Palette {
    // 随曲：颜色跟封面走（封面主色往墨色压一档，白底上不至于飘）。
    const themed = source?.accentColor ?? fallback.accentColor;
    const accent = huayuSettings().bubbleStyle === 'auto' && coverAccent
      ? mixHex(coverAccent, '#2b2530', 0.12)
      : themed;
    const primary = source?.primaryColor ?? fallback.primaryColor;
    const rightFill = accent;
    const deepAccent = mixHex(accent, '#5a3a10', 0.22);
    // 白色界面：主色往墨色压一档当正文色，白底上才立得住。
    const ink = mixHex(primary, '#2b2530', 0.66);
    return {
      leftFill: 'rgb(255 255 255 / 0.96)',
      leftText: ink,
      leftMuted: withAlpha(ink, 0.5),
      rightFill,
      rightFillEdge: deepAccent,
      rightText: '#2a1c08',
      rightMuted: 'rgb(58 40 14 / 0.66)',
      hotOnLeft: mixHex(accent, ink, 0.45),
      hotOnRight: '#3b2708',
      avatarLeft: ink,
      avatarLeftText: '#fdfaf6',
      avatarRight: accent,
      avatarRightText: '#2a1c08',
      tick: withAlpha(ink, 0.4),
      typingFill: 'rgb(255 255 255 / 0.94)',
      typingDot: withAlpha(ink, 0.45),
    };
  }

  /* ── 排版（measureText 结果按行缓存，resize / 换字 / 切歌才清） ── */

  const layoutCache = new Map<number, BubbleLayout>();

  const fontOf = (size: number, weight = 600): string => `${weight} ${size}px ${fontFamily}`;

  const glyphsOf = (line: SongLine): Glyph[] => {
    if (!ctx) return [];
    if (line.words.length === 0) {
      const start = line.timeMs;
      const end = start + Math.max(400, line.durationMs);
      return [{ text: line.text, width: ctx.measureText(line.text).width, startMs: start, endMs: end }];
    }
    // QRC 会在中文字之间也打 spaceBefore，那是分词标记不是排版空格；
    // 也有的源把英文一个词一条、spaceBefore 只标在词首。规则：
    // 只有「前面不是中日韩、后面也不是中日韩」才真的留一个空位。
    const cjkChar = /[぀-ヿ㐀-䶿一-鿿가-힯！-｠]/;
    const glyphs: Glyph[] = [];
    let previousRaw = '';
    for (const word of line.words) {
      if (word.text.length === 0) continue;
      const needSpace = word.spaceBefore === true
        && previousRaw.length > 0
        && !cjkChar.test(previousRaw.slice(-1))
        && !cjkChar.test(word.text.slice(0, 1));
      previousRaw = word.text;
      if (needSpace) {
        // 空格单独占一个字形，宽度自己定死。交给字体去排的话，主题换成中文字体后
        // 它的半角空格是 0.5 个字宽，英文词距会被撑成中文标点那么宽。
        glyphs.push({ text: ' ', width: bodySize * 0.26, startMs: word.startMs, endMs: word.startMs + 1 });
      }
      glyphs.push({
        text: word.text,
        width: 0,
        startMs: word.startMs,
        endMs: Math.max(word.endMs, word.startMs + 1),
      });
    }
    return glyphs;
  };

  /** 单个词比整行还宽（长英文 / 链接）时按字拆开，否则永远溢出。 */
  const splitWideGlyph = (glyph: Glyph, limit: number): Glyph[] => {
    if (!ctx || glyph.width <= limit) return [glyph];
    const chars = Array.from(glyph.text);
    if (chars.length <= 1) return [glyph];
    return chars.map((char) => ({
      text: char,
      width: ctx!.measureText(char).width,
      startMs: glyph.startMs,
      endMs: glyph.endMs,
    }));
  };

  const wrapGlyphs = (glyphs: Glyph[], limit: number): LaidRow[] => {
    const rows: LaidRow[] = [];
    let row: Glyph[] = [];
    let width = 0;
    const flush = (): void => {
      if (row.length > 0) rows.push({ glyphs: row, width });
      row = [];
      width = 0;
    };
    for (const raw of glyphs) {
      for (const glyph of splitWideGlyph(raw, limit)) {
        if (row.length === 0) {
          // 行首不留前导空格（英文分词会带一个）。
          const text = glyph.text.replace(/^\s+/, '');
          if (text.length === 0) continue;
          const trimmed = text === glyph.text ? glyph : { ...glyph, text, width: ctx ? ctx.measureText(text).width : glyph.width };
          row.push(trimmed);
          width = trimmed.width;
          continue;
        }
        if (width + glyph.width > limit) {
          flush();
          const text = glyph.text.replace(/^\s+/, '');
          if (text.length === 0) continue;
          const trimmed = text === glyph.text ? glyph : { ...glyph, text, width: ctx ? ctx.measureText(text).width : glyph.width };
          row.push(trimmed);
          width = trimmed.width;
          continue;
        }
        row.push(glyph);
        width += glyph.width;
      }
    }
    flush();
    return rows;
  };

  const metaHeightOf = (site: Site): number => {
    const cfg = huayuSettings();
    return cfg.showTime || (cfg.showTicks && site === 'right') ? Math.round(bodySize * 0.8) : 0;
  };

  /** 按宽度把一句话截成一行，放不下就结尾加省略号。 */
  const fitQuote = (text: string, size: number, limit: number): string => {
    if (!ctx) return text;
    const saved = ctx.font;
    ctx.font = fontOf(size, 500);
    let out = text;
    if (ctx.measureText(out).width > limit) {
      const chars = Array.from(out);
      while (chars.length > 1 && ctx.measureText(`${chars.join('')}\u2026`).width > limit) chars.pop();
      out = `${chars.join('')}\u2026`;
    }
    ctx.font = saved;
    return out;
  };

  /** 这一行抽到的签（0–1，跟歌名+行号定死，同一首歌每次进来一样）。 */
  const quoteDraw = (index: number): number =>
    spread32(hash32(`${songKey}|quote`) + Math.imul(index, 0x9e3779b1)) / 4294967296;

  /** 撤回抽签：同样跟歌名+行号定死 —— 同一首歌每次进来撤的还是那几句，不会每帧乱跳。 */
  const revokeDraw = (index: number): number =>
    spread32(hash32(`${songKey}|revoke`) + Math.imul(index, 0x85ebca6b)) / 4294967296;


  /** 这一句在这一刻是否已经被撤回：返回 0–1 的进度，-1 = 没撤回或在等待。
      触发点就是「下一句新歌词出现」那一瞬，正好符合「新歌词出现时撤回上一条旧消息」。 */
  const revokedProgress = (index: number, lyricMs: number): number => {
    const cfg = huayuSettings();
    const chance = clamp01(cfg.revokeChance);
    if (index < 0 || chance <= 0) return -1;
    if (revokeDraw(index) >= chance) return -1;
    const line = song?.lines[index];
    if (!line) return -1;
    const next = song?.lines[index + 1];
    const at = next ? lineStartMs(next) : lineEndMs(line);
    const ms = Math.max(80, cfg.revokeMs);
    if (lyricMs < at - ms) return -1;
    return clamp01((lyricMs - at) / ms);
  };

  /** 被撤回之后留下的那行小字：「你/对方撤回了一条消息」。 */
  const paintRevokeChip = (
    site: Site,
    top: number,
    layout: BubbleLayout,
    alpha: number,
    progress: number,
  ): void => {
    if (!ctx) return;
    const size = Math.round(bodySize * 0.78);
    const text = site === 'right' ? '你撤回了一条消息' : '对方撤回了一条消息';
    ctx.save();
    ctx.font = fontOf(size, 500);
    const textW = ctx.measureText(text).width;
    const padW = size * 0.78;
    const pillW = textW + padW * 2;
    const pillH = size * 1.92;
    // 居中对齐在整条消息栏的中线上（不看是哪一侧），像微信里那条「撤回了一条消息」；
    // 高度还是占原来那一格，后面所有行不会因为撤回而挪动。
    const columnCenter = (sideMargin + contentRight) / 2;
    const x = columnCenter - pillW / 2;
    const y = top + layout.height / 2 - pillH / 2;
    const ease = easeOutCubic(clamp01((progress - 0.45) / 0.55));
    ctx.globalAlpha = alpha * ease;
    if (ease <= 0.004) {
      ctx.restore();
      return;
    }
    ctx.fillStyle = 'rgb(43 37 48 / 0.055)';
    ctx.beginPath();
    ctx.roundRect(x, y, pillW, pillH, pillH / 2);
    ctx.fill();
    ctx.fillStyle = palette.leftMuted;
    ctx.textAlign = 'center';
    ctx.fillText(text, x + pillW / 2, y + pillH / 2 + size * 0.02);
    ctx.textAlign = 'left';
    ctx.restore();
  };

  /** 引用挑人：跟气泡样式无关（任何皮肤都可能随机带一句引用），按歌名+行号定死抽签。 */
  const quoteSourceOf = (index: number): number => {
    const cfg = huayuSettings();
    const chance = clamp01(cfg.quoteChance);
    if (index <= 0 || chance <= 0) return -1;
    if (quoteDraw(index) >= chance) return -1;
    // 连着两条都引用会像刷屏，隔一条再允许。
    if (index > 1 && quoteDraw(index - 1) < chance) return -1;
    const site = sides[index] ?? 'left';
    // 往上找最近一条「另一个人」的消息；同一个人（含拆词分段）不互引。
    for (let back = index - 1; back >= 0 && back >= index - 3; back -= 1) {
      const source = song?.lines[back];
      if (!source || !source.text.trim()) continue;
      if (sides[back] !== site) return back;
    }
    return -1;
  };

  const layoutOf = (index: number): BubbleLayout => {
    const cached = layoutCache.get(index);
    if (cached) return cached;
    const line = song?.lines[index];
    const empty: BubbleLayout = {
      rows: [],
      translationRows: [],
      width: padX * 2 + bodySize,
      height: padY * 2 + bodySize * 1.4,
      bodySize,
      bodyLineHeight: Math.round(bodySize * 1.28),
      transSize: Math.round(bodySize * 0.82),
      transLineHeight: Math.round(bodySize * 1.05),
      padX,
      padY,
      metaH: 0,
      quoteText: '',
      quoteH: 0,
    };
    if (!ctx || !line) {
      layoutCache.set(index, empty);
      return empty;
    }

    ctx.save();
    ctx.font = fontOf(bodySize);
    const bodyGlyphs = glyphsOf(line).map((glyph) => ({
      ...glyph,
      width: glyph.width > 0 ? glyph.width : ctx!.measureText(glyph.text).width,
    }));
    const rows = wrapGlyphs(bodyGlyphs, maxTextWidth);

    const transSize = empty.transSize;
    let translationRows: LaidRow[] = [];
    const translation = line.translation?.trim();
    if (translation && huayuSettings().showTranslation) {
      ctx.font = fontOf(transSize, 500);
      const glyph: Glyph = { text: translation, width: ctx.measureText(translation).width, startMs: 0, endMs: 0 };
      translationRows = wrapGlyphs([glyph], maxTextWidth);
    }
    ctx.restore();

    const bodyLineHeight = empty.bodyLineHeight;
    const transLineHeight = empty.transLineHeight;
    let width = 0;
    for (const row of rows) width = Math.max(width, row.width);
    for (const row of translationRows) width = Math.max(width, row.width);


    // 引用样式：抽中的这条把「另一个人」上一条的话缩成一行贴在正文上面。
    const quoteSize = Math.round(bodySize * 0.78);
    const quoteLineHeight = Math.round(quoteSize * 1.24);
    // 引用块内部：左内距 + 竖条 + 条与字的间隙 + 右内距，和 paintQuote 必须一致。
    const quotePadL = bodySize * 0.22;
    const quotePadR = bodySize * 0.3;
    const quoteBar = Math.max(2, bodySize * 0.085);
    const quoteGap = bodySize * 0.32;
    let quoteText = '';
    let quoteH = 0;
    let quoteWidth = 0;
    const quoteIndex = quoteSourceOf(index);
    if (quoteIndex >= 0) {
      const source = song?.lines[quoteIndex]?.text.trim() ?? '';
      if (source.length > 0) {
        const quoteLimit = Math.max(60, maxTextWidth - quotePadL - quoteBar - quoteGap - quotePadR);
        quoteText = fitQuote(source, quoteSize, quoteLimit);
        ctx.font = fontOf(quoteSize, 500);
        quoteWidth = ctx.measureText(quoteText).width + quotePadL + quoteBar + quoteGap + quotePadR;
        quoteH = quoteLineHeight + bodySize * 0.86;
      }
    }

    // 引用块比正文宽时，气泡跟着宽（引用块左右各留 padX）。
    if (quoteWidth > 0) width = Math.max(width, quoteWidth);

    const hasTrans = translationRows.length > 0;
    const metaH = metaHeightOf(sides[index] ?? 'left');
    const height =
      padY * 2 +
      quoteH +
      rows.length * bodyLineHeight +
      (hasTrans ? Math.round(bodySize * 0.15) + translationRows.length * transLineHeight : 0) +
      metaH;

    const layout: BubbleLayout = {
      rows,
      translationRows,
      width: Math.max(width + padX * 2, bodySize * 2.4),
      height,
      bodySize,
      bodyLineHeight,
      transSize,
      transLineHeight,
      padX,
      padY,
      metaH,
      quoteText,
      quoteH,
    };
    layoutCache.set(index, layout);
    return layout;
  };

  /* ── 消息流状态 ───────────────────────────────────────────── */

  let entries: Entry[] = [];
  let lineIndex = -1;
  let typingAlpha = 0;
  let typingSite: Site = 'left';
  let layerAlpha = 0;
  let lastFrameAt = 0;

  const resetStream = (): void => {
    entries = [];
    locals = [];
    lineIndex = -1;
    typingAlpha = 0;
    layerAlpha = 0;
    // 换歌等于换一张画布，镜头直接落位，不要从上一首的位置慢慢飘过来。
    camSnap = true;
  };

  /* ── 左侧：待播列表（联系人样式，不限条数） ───────────────── */

  /** 列表从「当前播放前 5 首」开始，一直排到队列末尾。 */
  const RAIL_HISTORY = 5;
  /** 队列比一屏长时的滚动量（px）：target 是滚轮/点击给的目标，scroll 是画出来的位置。 */
  let railScroll = 0;
  let railScrollTarget = 0;
  /** 队列窗口（当前播放前 5 首）换起点时的补偿位移，按行数记，随时间衰减到位。 */
  let railShiftRows = 0;
  let railW = 0;
  /** 待播栏自己的字号（不跟气泡字号走，气泡缩小时联系人栏也不至于糊成一团）。 */
  let railUnit = 16;
  let railAlpha = 0;
  let railY = 0;
  let railYReady = false;
  let railRows: Array<{ queueIndex: number; y: number; h: number }> = [];
  /** 待播栏列的是播放队列：当前播放前 5 首 + 当前 + 后面全部。 */
  let railQueue: Array<{ queueIndex: number; track: OnlineTrack }> = [];
  let railQueueKey = '';

  /* ── 镜头：自由跟随（文闪那种手持感），只平移、只带极轻倾角，不做缩放 ── */

  let camX = 0;
  let camVX = 0;
  let camScroll = 0;
  let camScrollV = 0;
  let camSnap = false;
  let camClock = 0;
  /* 推近：焦点先自己慢慢挪过去（camFx/camFy），再围着它缩放。换句于是是一次横摇，不是硬切。 */
  let camZoom = 0;
  let camZoomV = 0;
  let camFx = 0;
  let camFy = 0;
  let camFxV = 0;
  let camFyV = 0;

  /** 镜头焦点：正在唱的这句；它还没进视野就退回最新一条。 */
  const camFocus = (line: number): { x: number; y: number } => {
    let target = entries[entries.length - 1];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry && !entry.retiring && entry.index === line) {
        target = entry;
        break;
      }
    }
    if (!target) return { x: viewWidth * 0.5, y: baseY };
    const layout = target.layout;
    return {
      x: bubbleX(layout, target.site) + layout.width * 0.5,
      y: target.top + layout.height * 0.5,
    };
  };

  /* ── 几何 ─────────────────────────────────────────────────── */

  const bubbleX = (layout: BubbleLayout, site: Site): number => {
    if (site === 'left') return sideMargin + avatarSize + avatarGap;
    // 右侧贴到自定义的 contentRight，而不是也缩一个 railW，右边那条空带就没了。
    return contentRight - avatarSize - avatarGap - layout.width;
  };

  const avatarX = (site: Site): number =>
    site === 'left' ? sideMargin : contentRight - avatarSize;

  /* ── 绘制 ---------------------------------------------------- */

  /* ── 气泡皮肤：六种外观只换「壳」和配色，排版、分侧、逐字跟唱全部共用 ── */

  type SkinId = Exclude<HuayuBubbleStyle, 'auto'>;
  const SKIN_ORDER: SkinId[] = ['jelly', 'cream', 'ink'];
  const bubbleColors = {
    jelly: { left: '#383a40', right: '#1764ce', text: '#f8fbff', hot: '#ffffff' },
    cream: { left: '#f6eee4', right: '#efd2bb', text: '#362b25', hot: '#692f16' },
    ink: { left: '#362e40', right: '#63476e', text: '#fff5ff', hot: '#ffe3fc' },
    quote: { left: '#ffffff', right: '#f5e7d1', text: '#322b29', hot: '#634521' },
  };
  let skinId: SkinId = 'jelly';

  /** 「随曲」的壳：颜色不是预设色板，而是按当前封面主色现算 ——
      收信是封面色的极浅纸色，发信是压深一档的封面色，正文统一用暖墨色。 */
  const coverSkin = () => {
    const accent = coverAccent ?? fallback.accentColor;
    return {
      left: mixHex(accent, '#ffffff', 0.88),
      right: mixHex(accent, '#ffffff', 0.3),
      text: '#2a2418',
      hot: mixHex(accent, '#1d1710', 0.46),
    };
  };
  /** 当前生效的壳色：随曲跟封面，其余用预设色板。 */
  const skinColors = () => (huayuSettings().bubbleStyle === 'auto' ? coverSkin() : bubbleColors[skinId]);

  let shapeSequence: HuayuShape[] = [];
  let sequenceSettings: ReturnType<typeof huayuSettings> | null = null;
  let sequenceSong = '';
  const shapeForLine = (index: number): HuayuShape => {
    const cfg = huayuSettings();
    return (cfg.randomShapes && shapeSequence[index]) || cfg.shape;
  };
  const isLinear = (shape: HuayuShape) => lineMotifs.has(shape) || ['underline', 'rail', 'elbow', 'orbit', 'route', 'brackets', 'wave'].includes(shape);
  const bodyColor = (shape: HuayuShape) => isLinear(shape) ? '#322e36' : skinColors().text;
  const hotColor = (shape: HuayuShape) => isLinear(shape) ? blendColor(skinColors().right, '#201927', .48) : skinColors().hot;
  const mutedColor = (shape: HuayuShape) => withAlpha(bodyColor(shape), .68);

  const paintChrome = (shape: HuayuShape, x: number, y: number, w: number, h: number, site: Site, alpha: number) => {
    if (!ctx) return;
    const cfg = huayuSettings();
    const base = skinColors()[site];
    const unit = Math.min(bodySize, w / 2, h / 2);
    if (drawMessageMotif(ctx, shape, x, y, w, h, site === 'right', unit,
      base, blendColor(base, '#514654', .58), alpha * cfg.bubbleAlpha, avatarGap)) return;
    if (isLinear(shape) && shape !== 'underline' && shape !== 'rail') {
      ctx.save();
      ctx.translate(site === 'left' ? x : x + w, y);
      ctx.scale(site === 'left' ? 1 : -1, 1);
      ctx.globalAlpha = alpha * cfg.bubbleAlpha;
      ctx.strokeStyle = ctx.fillStyle = blendColor(base, '#504555', .5);
      ctx.lineWidth = Math.max(1.2, unit * .085);
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      const foot = h - 2;
      const reach = cfg.showAvatar ? Math.max(0, avatarGap - 3) : 0;
      const origin = Math.min(h * .5, avatarCenterY(0));
      if (shape === 'brackets') {
        for (const [cx, cy, dx, dy] of [[1, 1, 1, 1], [w-1, 1, -1, 1], [1, h-1, 1, -1], [w-1, h-1, -1, -1]]) {
          ctx.moveTo(cx + dx * unit * .55, cy);
          ctx.lineTo(cx, cy);
          ctx.lineTo(cx, cy + dy * unit * .45);
        }
      } else if (shape === 'wave') {
        const count = Math.max(3, Math.floor(w / 5));
        for (let i = 0; i < count; i++) {
          const px = (i + .5) * w / count;
          ctx.moveTo(px, foot);
          ctx.lineTo(px, foot - unit * (.08 + .22 * Math.sin(i * .69) ** 2));
        }
      } else {
        ctx.moveTo(-reach, origin);
        if (shape === 'orbit') {
          ctx.bezierCurveTo(-reach * .5, origin, -unit * .3, foot, unit * .6, foot);
          ctx.lineTo(unit * 1.4, foot);
        } else {
          if (shape === 'route') ctx.setLineDash([3, 3]);
          ctx.lineTo(-reach * .42, origin);
          ctx.lineTo(2, foot);
          ctx.lineTo(shape === 'route' ? w - 3 : unit * 1.5, foot);
        }
      }
      ctx.stroke();
      if (shape === 'route' || shape === 'orbit' || shape === 'elbow') {
        const end = shape === 'route' ? w - 3 : unit * (shape === 'orbit' ? 1.4 : 1.5);
        for (const [px, py] of [[-reach, origin], [end, foot]]) {
          ctx.beginPath();
          ctx.arc(px, py, 2.3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
      return;
    }
    if (isLinear(shape)) {
      ctx.save();
      ctx.globalAlpha = alpha * cfg.bubbleAlpha;
      const horizontal = shape === 'underline';
      const inset = Math.min(bodySize * .4, h / 4);
      const startX = site === 'left' ? x + 2 : x + w - 2;
      const endX = horizontal ? x + w - (startX - x) : startX;
      const endY = y + h - (horizontal ? 2 : inset);
      ctx.strokeStyle = ctx.fillStyle = blendColor(base, '#514654', .42);
      ctx.lineWidth = horizontal ? 1.4 : 2.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(startX, horizontal ? endY : y + inset);
      ctx.lineTo(endX, endY);
      ctx.stroke();
      if (horizontal) {
        ctx.beginPath();
        ctx.arc(startX, endY, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      return;
    }
    const glaze = ctx.createLinearGradient(x, y, x, y + h);
    const glazeTop = huayuSettings().bubbleStyle === 'auto' ? .18 : skinId === 'cream' ? .22 : .07;
    glaze.addColorStop(0, blendColor(base, '#ffffff', glazeTop));
    glaze.addColorStop(1, base);
    ctx.beginPath();
    if (['ticket', 'receipt', 'ribbon', 'tab', 'stack'].includes(shape)) {
      ctx.save();
      ctx.translate(site === 'left' ? x : x + w, y);
      ctx.scale(site === 'left' ? 1 : -1, 1);
      if (shape === 'stack') {
        ctx.globalAlpha = alpha * cfg.bubbleAlpha;
        ctx.fillStyle = blendColor(base, '#70647c', .38);
        ctx.fillRect(3, 3, w, h);
        ctx.rect(0, 0, w, h);
      } else {
        ctx.moveTo(0, 0);
        if (shape === 'tab') {
          ctx.lineTo(0, -3);
          ctx.lineTo(w * .34, -3);
          ctx.lineTo(w * .34 + 5, 0);
        }
        ctx.lineTo(w, 0);
        if (shape === 'ribbon') ctx.lineTo(w - unit * .43, h / 2);
        if (shape === 'ticket') {
          ctx.lineTo(w, h/2 - unit*.25);
          ctx.arc(w, h/2, unit*.25, -Math.PI/2, Math.PI/2, true);
        }
        ctx.lineTo(w, h);
        if (shape === 'receipt') {
          const teeth = Math.max(3, Math.round(w / 8));
          for (let i = teeth; i > 0; i--) {
            ctx.lineTo((i-.5)*w/teeth, h+3);
            ctx.lineTo((i-1)*w/teeth, h);
          }
        }
        ctx.lineTo(0, h);
        if (shape === 'ticket') {
          ctx.lineTo(0, h/2 + unit*.25);
          ctx.arc(0, h/2, unit*.25, Math.PI/2, -Math.PI/2, true);
        }
        ctx.closePath();
      }
      ctx.restore();
    } else if (shape === 'pill') {
      ctx.roundRect(x, y, w, h, Math.min(w / 2, h / 2, bodySize * 1.5 * cfg.radius));
    } else if (shape === 'card') {
      const cut = Math.min(w / 4, h / 3, bodySize * .7);
      const leftCut = site === 'right' ? cut : 0;
      const rightCut = cut - leftCut;
      ctx.moveTo(x + leftCut, y);
      ctx.lineTo(x + w - rightCut, y);
      ctx.lineTo(x + w, y + rightCut);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x, y + leftCut);
      ctx.closePath();
    } else {
      roundRect(x, y, w, h, bodySize * 1.05 * cfg.radius, site);
    }
    ctx.save();
    ctx.globalAlpha = alpha * cfg.bubbleAlpha;
    ctx.shadowColor = 'rgb(58 44 24 / .12)';
    ctx.shadowOffsetY = 3;
    ctx.shadowBlur = 10;
    ctx.fillStyle = glaze;
    ctx.fill();
    // 白底上纯白气泡会糊掉，补一根极细的边把它从背景上拎出来。
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = 'rgb(43 37 48 / 0.07)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (shape === 'ticket') {
      const seamX = site === 'left' ? x + w - unit * .42 : x + unit * .42;
      ctx.beginPath();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = withAlpha(bodyColor(shape), .35);
      ctx.moveTo(seamX, y + 2);
      ctx.lineTo(seamX, y + h - 2);
      ctx.stroke();
    }
    ctx.restore();
  };

  const drawGlyphRow = (
    shape: HuayuShape,
    row: LaidRow,
    x: number,
    y: number,
    lyricMs: number,
    alpha: number,
  ): void => {
    if (!ctx) return;
    const cfg = huayuSettings();
    const unlit = cfg.unlitOpacity;
    const body = bodyColor(shape);
    const hot = hotColor(shape);
    let cursor = x;
    for (const glyph of row.glyphs) {
      // 每个字三段连续过渡：未唱（压暗）→ 正在唱（强调色 + 轻微抬升 + 辉光）→ 已唱（本色）。
      // ramp 跟着这个字自己的演唱时长走，快歌也不会「啪」地一跳。
      const span = Math.max(60, glyph.endMs - glyph.startMs);
      const litRamp = Math.min(150, Math.max(60, span * 0.55));
      const doneRamp = Math.min(260, Math.max(110, span * 0.85));
      const lit = clamp01((lyricMs - glyph.startMs) / litRamp);
      const done = clamp01((lyricMs - glyph.endMs) / doneRamp);
      const heat = lit * (1 - done);
      const level = Math.max(lit, done);
      if (heat > 0.004) {
        const cx = cursor + glyph.width / 2;
        const lift = heat * bodySize * 0.07;
        const pop = 1 + heat * 0.04;
        ctx.save();
        ctx.translate(cx, y - lift);
        ctx.scale(pop, pop);
        ctx.translate(-cx, -y);
        ctx.fillStyle = blendColor(body, hot, heat);
        ctx.globalAlpha = alpha * lerp(unlit, 1, level);
        ctx.shadowColor = hot;
        ctx.shadowBlur = heat * bodySize * 0.62 * cfg.glow;
        ctx.fillText(glyph.text, cursor, y);
        ctx.restore();
      } else {
        ctx.fillStyle = body;
        ctx.globalAlpha = alpha * lerp(unlit, 1, level);
        ctx.shadowBlur = 0;
        ctx.fillText(glyph.text, cursor, y);
      }
      cursor += glyph.width;
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = alpha;
  };

  const avatarCenterX = (site: Site) => avatarX(site) + avatarSize / 2;
  const avatarCenterY = (top: number) => top + avatarSize / 2 + bodySize * .1;

  const roundRect = (x: number, y: number, w: number, h: number, radius: number, tail: Site): void => {
    if (!ctx) return;
    const r = Math.min(radius, w / 2, h / 2);
    ctx.save();
    ctx.translate(tail === 'left' ? x : x + w, y);
    ctx.scale(tail === 'left' ? 1 : -1, 1);
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(w, 0, w, h, r);
    ctx.arcTo(w, h, 0, h, r);
    ctx.arcTo(0, h, 0, 0, r);
    const tipY = Math.min(h / 2, Math.max(r * .4, avatarCenterY(0)));
    ctx.lineTo(0, Math.min(h - r, tipY + r * .55));
    ctx.quadraticCurveTo(0, tipY + r * .18, -r * .22, tipY);
    ctx.quadraticCurveTo(0, tipY, r * .08, tipY - r * .24);
    ctx.quadraticCurveTo(r * .2, 0, r, 0);
    ctx.closePath();
    ctx.restore();
  };

  interface Motion {
    dx: number;
    dy: number;
    sx: number;
    sy: number;
    rot: number;
  }

  /** 引用块：一小块灰底 + 左侧竖条 + 被引用的那句话（一行，超了截断）。 */
  const paintQuote = (shape: HuayuShape, x: number, top: number, layout: BubbleLayout, alpha: number): void => {
    if (!ctx || !layout.quoteText) return;
    const boxH = layout.quoteH - bodySize * 0.34;
    const qx = x + layout.padX;
    const qw = layout.width - layout.padX * 2;
    const qy = top + layout.padY + bodySize * 0.2;
    if (qw <= bodySize * 1.6 || boxH <= bodySize * 0.5) return;
    const padL = bodySize * 0.22;
    const barW = Math.max(2, bodySize * 0.085);
    const gap = bodySize * 0.32;
    ctx.save();
    ctx.globalAlpha = alpha * 0.94;
    ctx.beginPath();
    ctx.roundRect(qx, qy, qw, boxH, Math.min(bodySize * 0.4, boxH / 2));
    ctx.fillStyle = withAlpha(bodyColor(shape), 0.06);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(qx + padL, qy + boxH * 0.24, barW, boxH * 0.52, barW / 2);
    ctx.fillStyle = withAlpha(fallback.accentColor, 0.6);
    ctx.fill();
    ctx.font = fontOf(Math.round(bodySize * 0.78), 500);
    ctx.fillStyle = mutedColor(shape);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // 文字区最宽 = 块内宽 - 左内距 - 竖条 - 间隙 - 右内距；fitQuote 就是按这个预算截的，正好贴边不溢出。
    ctx.fillText(layout.quoteText, qx + padL + barW + gap, qy + boxH / 2);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
    ctx.font = fontOf(bodySize);
    ctx.textAlign = 'left';
  };

  const paintBubble = (
    shape: HuayuShape,
    line: SongLine,
    layout: BubbleLayout,
    site: Site,
    top: number,
    lyricMs: number,
    alpha: number,
    motion: Motion,
    sent: boolean,
  ): void => {
    if (!ctx || alpha <= 0.004) return;
    const cfg = huayuSettings();
    const x = bubbleX(layout, site);
    const centerX = avatarCenterX(site);
    const centerY = avatarCenterY(top);
    const tilt = cfg.tilt * (site === 'left' ? -1 : 1) * 0.016;

    ctx.save();
    ctx.translate(centerX + motion.dx, centerY + motion.dy);
    const rot = motion.rot + tilt;
    if (rot !== 0) ctx.rotate(rot);
    ctx.scale(Math.max(0, motion.sx), Math.max(0, motion.sy));
    ctx.translate(-centerX, -centerY);
    ctx.globalAlpha = alpha;

    paintChrome(shape, x, top, layout.width, layout.height, site, alpha);

    // 正文：逐词跟唱
    if (layout.quoteH > 0) paintQuote(shape, x, top, layout, alpha);

    const textX = x + layout.padX;
    let cursorY = top + layout.padY + layout.quoteH + layout.bodyLineHeight / 2;
    // 正文必须用排版的字号来画：上面画壳（paintChrome）和上一条消息的 meta/译文
    // 都会把 ctx.font 改成别的字号，不重设的话这里会拿 0.66 倍字号去画、宽度却按
    // 1 倍字号算，每个词后面就空出一截，英文词距看着特别大。
    ctx.font = fontOf(bodySize);
    ctx.textAlign = 'left';
    for (const row of layout.rows) {
      drawGlyphRow(shape, row, textX, cursorY, lyricMs, alpha);
      cursorY += layout.bodyLineHeight;
    }

    // 译文：同一句一起入场，压在正文下面
    if (cfg.showTranslation && layout.translationRows.length > 0) {
      cursorY += Math.round(bodySize * 0.15) - layout.bodyLineHeight / 2 + layout.transLineHeight / 2;
      ctx.font = fontOf(layout.transSize, 500);
      ctx.fillStyle = mutedColor(shape);
      for (const row of layout.translationRows) {
        ctx.globalAlpha = alpha * 0.72;
        ctx.fillText(row.glyphs.map((glyph) => glyph.text).join(''), textX, cursorY);
        cursorY += layout.transLineHeight;
      }
      ctx.font = fontOf(bodySize);
      ctx.globalAlpha = alpha;
    }

    // 底部 meta 带：时间戳在右，已读双勾贴在它右边（只有右侧消息有双勾，像自己发的）
    const contentH = layout.height - layout.padY * 2 - layout.metaH;
    const metaY = top + layout.padY + contentH + layout.metaH * 0.5;
    const metaFont = fontOf(Math.round(bodySize * 0.66), 500);
    const metaEdge = x + layout.width - layout.padX * 0.55;
    const step = bodySize * 0.3;
    const tickW = step * 2;
    // 已读双勾：唱完才出现。两根勾错开盖章式弹出，同时时间戳往左滑出它们的位置 ——
    // 时间是「让位」，不是被瞬间顶开；先用稍快的曲线腾地方，勾再落进去。
    const wantsTicks = layout.metaH > 0 && cfg.showTicks && sent && site === 'right';
    const tickP = wantsTicks ? clamp01((lyricMs - lineEndMs(line)) / 260) : 0;
    const tickEase = tickP <= 0 ? 0 : 1 - Math.pow(1 - tickP, 3);
    let metaRight = metaEdge - tickW * clamp01(tickEase * 1.6);
    if (wantsTicks && tickEase > 0.001) {
      ctx.strokeStyle = mutedColor(shape);
      ctx.lineWidth = Math.max(1.2, bodySize * 0.075);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 0; i < 2; i += 1) {
        const local = clamp01((tickEase - i * 0.3) / 0.7);
        if (local <= 0.001) continue;
        const bx = metaEdge - step * 0.55 - i * step * 0.95;
        // 0.55 → 1 的弹出，中途一点点过冲，像盖了个章。
        const pop = 0.55 + 0.45 * local + Math.sin(Math.PI * local) * 0.16;
        ctx.save();
        ctx.translate(bx, metaY);
        ctx.scale(pop, pop);
        ctx.translate(-bx, -metaY);
        ctx.globalAlpha = alpha * 0.9 * Math.min(1, local * 2.4);
        ctx.beginPath();
        ctx.moveTo(bx - step * 0.62, metaY);
        ctx.lineTo(bx - step * 0.2, metaY + step * 0.4);
        ctx.lineTo(bx + step * 0.55, metaY - step * 0.44);
        ctx.stroke();
        ctx.restore();
      }
      ctx.globalAlpha = alpha;
    }
    if (layout.metaH > 0 && cfg.showTime) {
      ctx.font = metaFont;
      ctx.fillStyle = mutedColor(shape);
      ctx.globalAlpha = alpha * 0.72;
      ctx.textAlign = 'right';
      ctx.fillText(clockText(line.timeMs + (song?.lyricOffsetMs ?? 0)), metaRight, metaY);
      ctx.textAlign = 'left';
      ctx.font = fontOf(bodySize);
      ctx.globalAlpha = alpha;
    }

    ctx.restore();
  };

  /* ── 头像图片：data URL 只解码一次，之后每帧直接贴 ── */

  const avatarImages = new Map<string, HTMLImageElement>();

  const avatarImageOf = (src: string): HTMLImageElement | null => {
    if (!src) return null;
    const hit = avatarImages.get(src);
    if (hit) {
      // 真 LRU：用到一次就挪到队尾，淘汰时只会淘汰「这一屏根本没在画」的封面。
      avatarImages.delete(src);
      avatarImages.set(src, hit);
      return hit.complete && hit.naturalWidth > 0 ? hit : null;
    }
    const image = new Image();
    image.decoding = 'async';
    image.src = src;
    avatarImages.set(src, image);
    // 上限留够：一屏待播行 + 左右头像 + 刚滚过去还在渐变的几行。
    while (avatarImages.size > 20) {
      const oldest = avatarImages.keys().next().value;
      if (!oldest || oldest === src) break;
      avatarImages.delete(oldest);
    }
    return null;
  };

  /** 封面地址缓存：onlineArtwork 会把端口/token 重新绑一遍、加缩略宽度，没真封面时给程序化 SVG。
   *  直接拿 track.cover 用是不行的——那串常为空，或还绑着上次启动的端口。 */
  const coverSources = new Map<string, string>();
  const coverSrcOf = (track: OnlineTrack | null | undefined): string => {
    if (!track) return '';
    const key = `${track.id}|${track.cover ?? ''}`;
    const cached = coverSources.get(key);
    if (cached) return cached;
    const src = onlineArtwork(track, 128);
    coverSources.set(key, src);
    if (coverSources.size > 24) {
      const oldest = coverSources.keys().next().value;
      if (oldest) coverSources.delete(oldest);
    }
    return src;
  };

  let trackCoverSrc = '';
  let trackCoverKey = '';
  /** 当前这首歌的封面地址：只有换歌才重新取，每帧调用不造对象。 */
  const trackCover = (): string => {
    const track = playerState().track;
    const key = track ? `${track.id}|${track.cover ?? ''}` : '';
    if (key !== trackCoverKey) {
      trackCoverKey = key;
      trackCoverSrc = coverSrcOf(track);
    }
    return trackCoverSrc;
  };

  /* ── 背景：当前歌曲封面（离屏模糊缓存）或透明 ───────────────── */

  let bgCache: HTMLCanvasElement | null = null;
  let bgCacheKey = '';
  let bgOffApplied: boolean | null = null;

  /** 封面铺底：缩到 1/3 分辨率画一次模糊，再整块放大 —— 每帧只是一次 drawImage。 */
  const buildBackdrop = (image: HTMLImageElement, key: string): void => {
    const w = Math.max(2, Math.round(viewWidth / 3));
    const h = Math.max(2, Math.round(viewHeight / 3));
    const buffer = document.createElement('canvas');
    buffer.width = w;
    buffer.height = h;
    const paint = buffer.getContext('2d');
    if (!paint) return;
    const naturalW = Math.max(1, image.naturalWidth);
    const naturalH = Math.max(1, image.naturalHeight);
    // 多放一点余量：放大后四边不会露出缓存外的空白。
    const scale = Math.max(w / naturalW, h / naturalH) * 1.18;
    const dw = naturalW * scale;
    const dh = naturalH * scale;
    paint.filter = 'blur(7px) saturate(1.06)';
    paint.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
    paint.filter = 'none';
    // 亮场蒙版：封面只当一层很淡的质地，字压上去仍然读得清。
    const veil = paint.createLinearGradient(0, 0, 0, h);
    veil.addColorStop(0, 'rgb(248 246 243 / 0.84)');
    veil.addColorStop(0.55, 'rgb(247 245 242 / 0.92)');
    veil.addColorStop(1, 'rgb(244 241 237 / 0.88)');
    paint.fillStyle = veil;
    paint.fillRect(0, 0, w, h);
    bgCache = buffer;
    bgCacheKey = key;
  };

  const paintBackdrop = (): void => {
    if (!ctx) return;
    const cfg = huayuSettings();
    const off = cfg.bgMode === 'off';
    if (bgOffApplied !== off) {
      bgOffApplied = off;
      root.classList.toggle('is-bg-off', off);
    }
    if (off) return;
    const src = trackCover();
    const image = src ? avatarImageOf(src) : null;
    // 封面还没解码好：这一帧什么都不画，让舞台自己的浅底兜着，别闪一块纯色。
    if (!image) return;
    const key = `${src}|${Math.round(viewWidth)}|${Math.round(viewHeight)}|${dpr}`;
    if (!bgCache || bgCacheKey !== key) buildBackdrop(image, key);
    if (bgCache) ctx.drawImage(bgCache, 0, 0, viewWidth, viewHeight);
  };

  const paintAvatar = (site: Site, top: number, alpha: number): void => {
    if (!ctx || !huayuSettings().showAvatar || avatarSize <= 0) return;
    const cfg = huayuSettings();
    const r = avatarSize / 2;
    const cx = avatarCenterX(site);
    const cy = avatarCenterY(top);

    // 头像外框：圆形 / 圆角方。裁剪路径统一走这里，图片和渐变底共用同一个形状。
    const shapePath = (): void => {
      if (!ctx) return;
      ctx.beginPath();
      if (cfg.avatarShape === 'squircle') {
        const radius = avatarSize * 0.3;
        ctx.roundRect(cx - r, cy - r, avatarSize, avatarSize, radius);
      } else {
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
      }
    };

    ctx.save();
    ctx.globalAlpha = alpha;

    const custom = site === 'left' ? cfg.avatarLeftImage : cfg.avatarRightImage;
    // 左边是「对方」＝这首歌：没自定义头像图时直接拿当前歌曲封面顶上。
    const src = custom || (site === 'left' ? trackCover() : '');
    const picture = avatarImageOf(src);
    if (picture) {
      // 自定义图片：铺满裁成外框形状，等比放大取中间（不变形）。
      ctx.save();
      shapePath();
      ctx.clip();
      const ratio = Math.max(avatarSize / picture.naturalWidth, avatarSize / picture.naturalHeight);
      const dw = picture.naturalWidth * ratio;
      const dh = picture.naturalHeight * ratio;
      ctx.drawImage(picture, cx - dw / 2, cy - dh / 2, dw, dh);
      ctx.restore();
    } else {
      shapePath();
      if (site === 'right') {
        const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
        grad.addColorStop(0, palette.rightFill);
        grad.addColorStop(1, palette.rightFillEdge);
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = palette.avatarLeft;
      }
      ctx.fill();
    }

    shapePath();
    ctx.strokeStyle = 'rgb(43 37 48 / 0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (!picture) {
      const text = site === 'left' ? cfg.avatarLeftText : cfg.avatarRightText;
      const glyphSize = Math.round(avatarSize * (Array.from(text).length > 1 ? 0.34 : 0.5));
      ctx.fillStyle = site === 'left' ? palette.avatarLeftText : palette.avatarRightText;
      ctx.font = fontOf(glyphSize, 700);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, cx, cy + 0.5);
    }
    ctx.restore();
    ctx.textAlign = 'left';
  };

  const paintTyping = (site: Site, alpha: number, now: number): void => {
    if (!ctx || alpha <= 0.004) return;
    const padXTyping = bodySize * 0.86;
    const padYTyping = bodySize * 0.72;
    const dotR = bodySize * 0.15;
    const step = bodySize * 0.42;
    const width = padXTyping * 2 + step * 2;
    const height = padYTyping * 2 + dotR * 2 + bodySize * 0.5;
    const top = Math.min(baseY + gap, composerTop - height - Math.round(bodySize * 0.5));
    const x = site === 'left' ? sideMargin + avatarSize + avatarGap : contentRight - avatarSize - avatarGap - width;

    ctx.save();
    ctx.globalAlpha = alpha;
    roundRect(x, top, width, height, Math.round(bodySize * 0.9), site);
    ctx.fillStyle = palette.typingFill;
    ctx.fill();
    ctx.strokeStyle = 'rgb(43 37 48 / 0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = palette.typingDot;
    const baseDotY = top + height / 2;
    for (let i = 0; i < 3; i += 1) {
      const phase = (now / 420 + i * 0.34) % 1;
      const lift = Math.sin(phase * Math.PI * 2) * bodySize * 0.12;
      const dotAlpha = 0.45 + 0.55 * Math.max(0, Math.sin(phase * Math.PI));
      ctx.globalAlpha = alpha * dotAlpha;
      ctx.beginPath();
      ctx.arc(x + padXTyping + dotR + i * step, baseDotY + lift, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };


  /* ── 出入场动画：六种入场 × 四种出场，auto 按「歌 + 行号」确定性抽 ── */

  type EnterKind = Exclude<HuayuEnter, 'auto'>;
  const ENTER_ORDER: EnterKind[] = ['hop', 'stretch', 'swing'];

  const hash32 = (text: string): number => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  };

  /** murmur3 的 fmix32：把只差一位的种子彻底打散。
   *  FNV 直接吃「歌名|引用|12」这种只差尾字的串时，相邻行号的比值只挪 0.0039，
   *  一旦压到概率线以下就会连着上百行都命中——表现就是「引了一条以后全都引用」。 */
  const spread32 = (seed: number): number => {
    let x = seed >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b) >>> 0;
    x ^= x >>> 16;
    return x >>> 0;
  };

  const enterKindOf = (index: number, cfgEnter: HuayuEnter): EnterKind => {
    if (cfgEnter !== 'auto') return cfgEnter;
    return ENTER_ORDER[hash32(`${songKey}|enter|${index}`) % ENTER_ORDER.length] ?? 'hop';
  };

  /** 临界阻尼的落位响应：从 1 单调衰减到 0，永不反向 —— 位置用它，看着是被按住停下，不是飞过头。 */
  const settleResponse = (p: number, w: number): number => Math.exp(-w * p) * (1 + w * p);

  /** 阻尼振子的「回正响应」：起步为 1，按弹性来回摆几次后归零。旋转用它 = 甩出去再回正。 */
  const ringResponse = (p: number, w: number, zeta: number): number => {
    if (zeta >= 0.999) return settleResponse(p, w);
    const wd = w * Math.sqrt(1 - zeta * zeta);
    return Math.exp(-zeta * w * p) * (Math.cos(wd * p) + (zeta * w / wd) * Math.sin(wd * p));
  };

  /** 缩放的弹簧响应：从 from 逼到 1；允许过冲（体积是唯一允许过冲的通道）。 */
  const scaleResponse = (p: number, from: number, w: number, zeta: number): number =>
    1 - (1 - from) * ringResponse(p, w, zeta);

  const motionOf = (site: Site, phase: number, kind: EnterKind): Motion => {
    const cfg = huayuSettings();
    const p = reducedMotion.matches ? 1 : clamp01(phase);
    const dir = site === 'left' ? -1 : 1;
    const enterElastic = Math.max(0, Math.min(2, cfg.enterElastic));
    const bounce = Math.max(0, Math.min(2, cfg.elasticity));

    // 位置：只走单调衰减，绝不过冲。位移一旦过冲就会「飞过自己的位置再退回来」，
    // 聊天消息那样做很假；弹感留给体积和旋转。
    const speed = 8.5 + enterElastic * 3.4;
    const approach = reducedMotion.matches ? 0 : settleResponse(p, speed);
    // 位移总量。回弹过冲滑杆在这里只当「行程幅度」用：0.42 + 0.15×过冲，默认 1.34 正好 0.62。
    const travel = approach * (0.42 + Math.min(2.2, Math.max(0, cfg.overshoot)) * 0.15);

    // 阻尼比：0.95（几乎不晃）→ 0.18（明显来回摆）。默认 1 → 0.42，过冲约 6%。
    const zeta = Math.max(0.18, Math.min(0.99, 0.95 - bounce * 0.53));

    // 体积：起点由「鼓起幅度」定，入场弹性再往下压一点（越大起得越小），频率越高收得越快。
    const depth = Math.max(0, Math.min(0.5, cfg.popDepth)) + (enterElastic - 1) * 0.03;
    const from = Math.max(0.4, Math.min(0.98, 1 - depth - (kind === 'stretch' ? 0.04 : 0)));
    const scaleW = 12 + enterElastic * 3;
    const grow = reducedMotion.matches ? 1 : scaleResponse(p, from, scaleW, zeta);

    // 旋转：绕头像那一角「晃」。枢轴在 paintBubble 里取头像中心，所以整条气泡是吊在头像上摆的。
    // 这里用起步为 0 的阻尼正弦，而不是回正型振子：回正型一出生就在最大角度，
    // 而入场头几帧 alpha 还接近 0，那一下正好看不见；起步为 0 才看得见「晃」。
    const rotAmp = (Math.max(0, Math.min(12, cfg.swayAngle)) * Math.PI) / 180 * (kind === 'swing' ? 1.6 : 1);
    const rotW = (16 + enterElastic * 4) * Math.max(0.4, Math.min(2.2, cfg.swaySpeed));
    const rotZeta = Math.max(0.22, Math.min(0.62, zeta * 0.8));
    const sway = Math.exp(-rotZeta * rotW * p) * Math.sin(rotW * p);
    const tilt = reducedMotion.matches ? 0 : sway;

    // 三种动作只在「往哪个方向走 + 体积怎么配合」上不同，弹性手感是共用的：
    //   hop    起跳落下：纵向行程为主，落位瞬间稍微压扁一点再回圆。
    //   stretch 拉糖：横向从头像一侧拉开，过程中横向略撑长、纵向略收窄。
    //   swing  摇铃：横向纵向各走一半，甩出的倾角更大。
    const lateral = kind === 'stretch' ? 1 : kind === 'swing' ? 0.5 : 0.34;
    const vertical = kind === 'hop' ? 1 : kind === 'swing' ? 0.5 : 0.3;
    const squash = kind === 'hop' ? approach * 0.06 : kind === 'stretch' ? approach * 0.1 : 0;
    return {
      dx: -dir * bodySize * cfg.enterDrift * travel * lateral,
      dy: -bodySize * cfg.enterRise * travel * vertical,
      sx: grow * (1 + squash),
      sy: grow * (1 - squash * 0.7),
      rot: dir * rotAmp * tilt,
    };
  };

  /* ── 消息流推进 ───────────────────────────────────────────── */

  const lineStartMs = (line: SongLine): number => line.timeMs + (song?.lyricOffsetMs ?? 0);
  const lineEndMs = (line: SongLine): number =>
    lineStartMs(line) + Math.max(line.durationMs, 1200);

  const activeIndexAt = (songMs: number): number => {
    const lines = song?.lines ?? [];
    let index = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (songMs + 1e-6 >= (lines[i]?.timeMs ?? 0) + (song?.lyricOffsetMs ?? 0)) index = i;
      else break;
    }
    return index;
  };

  const markPainted = (): void => {
    if (painted) return;
    painted = true;
    root.classList.add('is-ready', 'is-painted');
    if ((song?.lines.length ?? 0) > 0) root.classList.add('is-content');
  };

  let sidesMode: HuayuSideMode | '' = '';
  /** 拆词设置快照：开关或字数一变，整首歌要重新切段。 */
  let splitKey = '';

  /* ── 拆词：长句按字数切成几条短消息，同一个人连着发 ──────────
     pieceOwner 记住每个分段来自原第几行，buildSides 据此让同源分段共用一侧，
     否则一句歌词会被切成「我一句、你一句」，看着像两个人在念同一句。 */

  type HuayuLine = NonNullable<LumiereSongInput>['lines'][number];
  /** 拆句抽签：这一行要不要切开，按歌+行号定死，同一首歌每次进来切的是同样几句。 */
  const splitDraw = (trackKey: string, index: number): number =>
    spread32(hash32(`${trackKey}|split`) + Math.imul(index, 0x9e3779b1)) / 4294967296;

  type HuayuWord = HuayuLine['words'][number];

  let rawSong: LumiereSongInput | null = null;
  let pieceOwner: number[] = [];

  const splitKeyOf = (): string => {
    const cfg = huayuSettings();
    return `${cfg.splitWords}|${Math.round(cfg.splitChars)}|${Math.round(cfg.splitChance * 100)}`;
  };

  const splitSong = (input: LumiereSongInput | null): LumiereSongInput | null => {
    const cfg = huayuSettings();
    pieceOwner = [];
    if (!input) return null;
    if (!cfg.splitWords) {
      pieceOwner = input.lines.map((_, index) => index);
      return input;
    }
    const limit = Math.max(4, Math.round(cfg.splitChars));
    const offset = input.lyricOffsetMs;
    const lines: HuayuLine[] = [];
    input.lines.forEach((line, lineIndex) => {
      const chars = Array.from(line.text).filter((char) => !/\s/.test(char)).length;
      // 本来就够短、没有逐词时间、或者这次抽签没抽中（概率拆句）的句子不拆。
      const drawn = splitDraw(input.trackKey ?? '', lineIndex) < clamp01(cfg.splitChance);
      if (line.words.length < 2 || chars <= limit || !drawn) {
        lines.push(line);
        pieceOwner.push(lineIndex);
        return;
      }
      let bucket: HuayuWord[] = [];
      let count = 0;
      let firstPiece = true;
      const flush = (): void => {
        if (bucket.length === 0) return;
        const head = bucket[0]!;
        const tail = bucket[bucket.length - 1]!;
        lines.push({
          timeMs: Math.max(0, head.startMs - offset),
          durationMs: Math.max(600, tail.endMs - head.startMs),
          text: bucket.map((word) => (word.spaceBefore ? ' ' : '') + word.text).join('').trim(),
          // 译文只挂第一段，否则一句歌词的译文会在每个分段里重复一遍。
          translation: firstPiece ? line.translation : '',
          words: bucket,
        });
        pieceOwner.push(lineIndex);
        firstPiece = false;
        bucket = [];
        count = 0;
      };
      for (const word of line.words) {
        const size = Math.max(1, Array.from(word.text).length);
        if (count > 0 && count + size > limit) flush();
        bucket.push(word);
        count += size;
      }
      flush();
    });
    return { ...input, lines };
  };

  const buildSides = (input: LumiereSongInput | null): Site[] => {
    const key = input?.trackKey ?? '';
    const mode = huayuSettings().sideMode;
    const result: Site[] = [];
    let previous: Site | null = null;
    // 交替按「第几条消息」数，不按分段下标数：一句长歌词常被拆成几段，
    // 用 i % 2 会让拆出来的段把奇偶占掉，屏幕上就变成连着同侧。
    let altSlot = 0;
    for (let i = 0; i < (input?.lines.length ?? 0); i += 1) {
      const owner = pieceOwner[i] ?? i;
      const previousOwner = i > 0 ? (pieceOwner[i - 1] ?? i - 1) : -1;
      // 同一句拆出来的连续几段＝同一个人连着发，不换边。
      const sameAsPrevious = previous !== null && owner === previousOwner;
      let side: Site;
      if (mode === 'left') side = 'left';
      else if (mode === 'right') side = 'right';
      else if (sameAsPrevious) side = previous as Site;
      else if (mode === 'alternate') side = altSlot % 2 === 0 ? 'left' : 'right';
      else side = siteOf(key, i, previous);
      result.push(side);
      previous = side;
      if (!sameAsPrevious) altSlot += 1;
    }
    sidesMode = mode;
    return result;
  };

  const syncEntries = (index: number): void => {
    const cfg = huayuSettings();
    const visible = Math.max(1, Math.round(cfg.visibleCount));
    // 一条聊天记录到底：屏幕上是「当前句往前数若干句」的连续窗口。
    const mine: number[] = [];
    if (index >= 0) {
      for (let i = index; i >= 0 && mine.length < visible; i -= 1) mine.push(i);
      mine.reverse();
    }
    const wanted = new Set(mine);
    const kept = new Map<number, Entry>();
    const next: Entry[] = [];
    for (const entry of entries) {
      if (wanted.has(entry.index)) {
        kept.set(entry.index, entry);
      } else if (entry.phase > 0.01) {
        // 被折叠到渐隐线以上的旧消息继续往上走完自己的出场，不从半途消失。
        entry.retiring = true;
        next.push(entry);
      }
    }
    const newest = mine[mine.length - 1];
    for (const i of mine) {
      const site = sides[i] ?? 'left';
      const existing = kept.get(i);
      if (existing) {
        existing.retiring = false;
        existing.site = site;
        // layoutOf 有缓存，这里只是取一次，设置改了（引用概率、字号、宽度）也能跟着重排。
        existing.layout = layoutOf(i);
        next.push(existing);
        continue;
      }
      // 跳播/拖进度时中间补进来的历史消息直接落位，不做入场，否则一片乱飞。
      const isNewest = i === newest;
      const layout = layoutOf(i);
      next.push({
        index: i,
        site,
        layout,
        top: baseY - layout.height,
        targetTop: baseY - layout.height,
        phase: isNewest ? 0 : 1,
        retiring: false,
        fade: 1,
      });
    }
    next.sort((a, b) => a.index - b.index);
    entries = next;

    // 每条消息的位置只由自己的行号决定：整首歌是一张长卷，谁都不会因为窗口滑动而换位置，
    // 屏幕上的上下位移全部由镜头滚过去。
    for (const entry of entries) {
      // 出场中的旧消息保持自己原来的坐标，让镜头把它带走，不从半途重排。
      if (entry.retiring) continue;
      const top = canvasTopOf(entry.index);
      entry.targetTop = top;
      entry.top = top;
    }
  };

  /* ── 左侧会话列表 ─────────────────────────────────────────── */

  /** 队列 / 当前曲目变了才重建这几行，别每帧都造对象。 */
  const syncRailQueue = (): void => {
    const st = playerState();
    const queue = st.queue;
    const current = Math.max(0, Math.min(st.index, queue.length - 1));
    const key = `${queue.length}|${current}|${st.track?.id ?? ''}`;
    if (key === railQueueKey) return;
    railQueueKey = key;
    const previousBase = railQueue[0]?.queueIndex ?? -1;
    railQueue = [];
    // 不限制条数：从当前播放前 5 首一直排到队列末尾，超出一屏的部分靠滚轮滚。
    for (let i = Math.max(0, current - RAIL_HISTORY); i < queue.length; i += 1) {
      const track = queue[i];
      if (!track) continue;
      railQueue.push({ queueIndex: i, track });
    }
    const nextBase = railQueue[0]?.queueIndex ?? -1;
    // 点某一行切歌时窗口起点会整体挪（当前播放前 5 首变了）：把位移记成行数，
    // 由 paintRail 逐帧衰减回 0，看着就是整列顺着滑过去，而不是瞬间换一屏。
    if (previousBase >= 0 && nextBase >= 0 && previousBase !== nextBase) {
      const jump = nextBase - previousBase;
      railShiftRows = Math.abs(jump) > 14 ? 0 : -jump;
    }
  };

  /** Canvas 的 fillText maxWidth 是把字横向压扁，这里要的是省略号截断。 */
  const fitText = (text: string, limit: number): string => {
    if (!ctx || limit <= 0) return '';
    if (ctx.measureText(text).width <= limit) return text;
    const chars = Array.from(text);
    let out = '';
    for (const ch of chars) {
      if (ctx.measureText(`${out}${ch}…`).width > limit) break;
      out += ch;
    }
    return out ? `${out}…` : '';
  };

  /** 对齐到设备像素：dpr 下 1 CSS px 也可能是半格，圆形裁切 + 缩放图会因此抖动。 */
  const pxSnap = (value: number): number => Math.round(value * dpr) / dpr;

  const paintRail = (alpha: number, dt: number): void => {
    if (!ctx) return;
    railRows = [];
    syncRailQueue();
    const wantShow = railW > 0 && railQueue.length > 0;
    // 出现/收起是同一条曲线的两个方向，改开关或拖宽度都不跳。
    railAlpha = lerp(railAlpha, wantShow ? 1 : 0, 1 - Math.exp(-dt * 11));
    if (railAlpha <= 0.004) return;
    const accent = theme?.accentColor || fallback.accentColor;
    const divider = Math.max(36, bodySize * 2.8);
    const rowH = Math.round(railUnit * 3.5);
    const padXr = Math.round(railUnit * 1.1);
    const avatarR = Math.max(railUnit * 0.52, Math.min(railUnit * 0.98, railW * 0.105));
    const top = divider + railUnit * 0.45;
    // 一屏能放下多少：底部给输入条让位；比这高就靠滚轮滚。
    const viewH = Math.max(rowH, viewHeight - top - composerH - railUnit * 0.4);
    const contentH = railQueue.length * rowH;
    const maxScroll = Math.max(0, contentH - viewH);
    if (railScrollTarget > maxScroll) railScrollTarget = maxScroll;
    if (railScrollTarget < 0) railScrollTarget = 0;
    // 滚轮给的是目标值，画出来的是跟上去的位置：指数跟随，帧率无关，停下来不抖。
    railScroll = lerp(railScroll, railScrollTarget, 1 - Math.exp(-dt * 13));
    if (Math.abs(railScrollTarget - railScroll) < 0.2) railScroll = railScrollTarget;
    // 换窗补偿：衰减到 0 的过程就是「整列滑到位」。
    const shiftPx = railShiftRows * rowH;
    railShiftRows *= Math.exp(-dt * 10);
    if (Math.abs(railShiftRows) < 0.0015) railShiftRows = 0;
    const scrollY = railScroll + shiftPx;
    const playingIndex = playerState().index;
    const playingRow = railQueue.findIndex((row) => row.queueIndex === playingIndex);

    ctx.save();
    ctx.globalAlpha = railAlpha * Math.max(0.15, alpha);
    // 底板：一层极淡的竖向导光，别抢气泡的戏
    const board = ctx.createLinearGradient(0, 0, railW, 0);
    board.addColorStop(0, 'rgb(43 37 48 / 0.045)');
    board.addColorStop(1, 'rgb(43 37 48 / 0.012)');
    ctx.fillStyle = board;
    ctx.fillRect(0, 0, railW, viewHeight);
    ctx.fillStyle = 'rgb(43 37 48 / 0.08)';
    ctx.fillRect(railW - 1, 0, 1, viewHeight);

    ctx.font = fontOf(Math.round(railUnit * 0.72), 700);
    ctx.fillStyle = withAlpha(palette.leftMuted, 0.95);
    ctx.fillText('待播', padXr, divider * 0.52);

    // 列表本体裁进可视区：上下溢出部分不画，也不吃掉点击。
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top - railUnit * 0.2, railW, viewH + railUnit * 0.4);
    ctx.clip();

    // 高亮滑块：跟着「当前播放」那一行走；它被滚出视口时就停在边上看不见。
    const activeY = top + (playingRow >= 0 ? playingRow * rowH - scrollY : 0);
    if (!railYReady) {
      railY = activeY;
      railYReady = true;
    } else {
      railY = lerp(railY, activeY, 1 - Math.exp(-dt * 15));
    }
    if (playingRow >= 0) {
      ctx.fillStyle = 'rgb(43 37 48 / 0.055)';
      roundRect(padXr * 0.4, railY + 2, railW - padXr * 0.8, rowH - 4, railUnit * 0.9, 'left');
      ctx.fill();
      ctx.fillStyle = withAlpha(accent, 0.85);
      roundRect(padXr * 0.4, railY + rowH * 0.24, Math.max(2, railUnit * 0.12), rowH * 0.52, railUnit * 0.12, 'left');
      ctx.fill();
    }

    for (let index = 0; index < railQueue.length; index += 1) {
      const row = railQueue[index]!;
      const track = row.track;
      const rowY = pxSnap(top + index * rowH - scrollY);
      // 滚出视区的行不画：队列再长也只有一屏的开销。
      if (rowY + rowH < top - railUnit * 0.2 || rowY > top + viewH) continue;
      railRows.push({ queueIndex: row.queueIndex, y: rowY, h: rowH });
      const hot = row.queueIndex === playingIndex;
      const cy = pxSnap(rowY + rowH * 0.5);
      const cx = pxSnap(padXr + avatarR);
      const radius = hot ? avatarR * 1.04 : avatarR;
      const cover = avatarImageOf(coverSrcOf(track));

      if (cover) {
        // 封面当头像：圆形裁切，等比铺满。
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.clip();
        const span = radius * 2;
        const naturalW = Math.max(1, cover.naturalWidth);
        const naturalH = Math.max(1, cover.naturalHeight);
        const fit = Math.max(span / naturalW, span / naturalH);
        const dw = pxSnap(naturalW * fit);
        const dh = pxSnap(naturalH * fit);
        ctx.drawImage(cover, pxSnap(cx - dw / 2), pxSnap(cy - dh / 2), dw, dh);
        ctx.restore();
      } else {
        const hue = hash32(`${track.artist}|${track.title}`) % 360;
        const glow = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
        glow.addColorStop(0, `hsl(${hue} 60% 64%)`);
        glow.addColorStop(1, `hsl(${(hue + 44) % 360} 52% 44%)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgb(255 252 248 / 0.94)';
        ctx.font = fontOf(Math.round(radius * 0.92), 700);
        ctx.textAlign = 'center';
        ctx.fillText(Array.from(track.artist || track.title || '·')[0] ?? '·', cx, cy + 0.5);
        ctx.textAlign = 'left';
      }
      if (hot) {
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = withAlpha(accent, 0.75);
        ctx.lineWidth = Math.max(1, railUnit * 0.08);
        ctx.stroke();
      }

      const textX = cx + avatarR + railUnit * 0.62;
      const textRight = railW - padXr * 0.75;
      // 栏窄了先把右列时长整列让出来，字始终按左对齐截断，不横向压扁。
      const showMeta = textRight - textX >= railUnit * 8.4;
      const timeW = showMeta ? railUnit * 3.2 : 0;
      const room = Math.max(railUnit * 1.6, textRight - textX - timeW);
      const artistName = track.artist?.trim() || track.title?.trim() || '未知歌手';
      ctx.font = fontOf(Math.round(railUnit * 0.98), hot ? 700 : 600);
      ctx.fillStyle = hot ? palette.leftText : withAlpha(palette.leftText, 0.74);
      ctx.fillText(fitText(artistName, room), textX, cy - railUnit * 0.5);
      if (room >= railUnit * 2.4) {
        ctx.font = fontOf(Math.round(railUnit * 0.8), 500);
        ctx.fillStyle = withAlpha(palette.leftMuted, hot ? 0.92 : 0.66);
        ctx.fillText(fitText(track.title ?? '', room), textX, cy + railUnit * 0.66);
      }

      if (showMeta) {
        ctx.textAlign = 'right';
        ctx.font = fontOf(Math.max(10, Math.round(railUnit * 0.64)), 500);
        ctx.fillStyle = withAlpha(palette.leftMuted, 0.66);
        ctx.fillText(clockText(track.durationMs), textRight, cy - railUnit * 0.54);
        if (hot) {
          ctx.fillStyle = withAlpha(accent, 0.8);
          ctx.fillText('播放中', textRight, cy + railUnit * 0.64);
        }
        ctx.textAlign = 'left';
      }
    }
    ctx.restore();
    ctx.restore();
  };

  /** 点左侧会话手动切过去；自动切换发生时再交回时间轴。 */
  input.addEventListener('input', () => {
    inputValue = input.value.replace(/\s+/g, ' ');
    if (input.value !== inputValue) input.value = inputValue;
  });
  input.addEventListener('focus', () => {
    inputFocused = true;
  });
  input.addEventListener('blur', () => {
    inputFocused = false;
  });
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    // 打字时不能让空格/方向键漏到全局快捷键上去
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendLocal();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      input.blur();
    }
  });

  /** 发送钮的命中区：圆心在输入条右端，半径比画出来的稍大，好点。 */
  const sendHit = (x: number, y: number): boolean => {
    if (composerH <= 0) return false;
    const cx = contentRight - composerH * 0.52;
    const cy = composerTop + composerH / 2;
    return Math.hypot(x - cx, y - cy) <= composerH * 0.42;
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!active || disposed) return;
    const rect = canvas.getBoundingClientRect();
    const hover = sendHit(event.clientX - rect.left, event.clientY - rect.top);
    if (hover !== sendHoverOn) {
      sendHoverOn = hover;
      canvas.style.cursor = hover ? 'pointer' : '';
    }
  };

  const onPointerLeave = (): void => {
    sendHoverOn = false;
    canvas.style.cursor = '';
  };

  const onRailPointerDown = (event: PointerEvent): void => {
    if (!active || disposed) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (railW > 0 && railQueue.length > 0 && x <= railW) {
      // 点标题那一行＝收起待播栏（和设置里的「待播列表」是同一个开关），
      // 收起来之后这块宽度直接还给画面；想再打开去效果设置里勾回来。
      if (y < Math.max(36, bodySize * 2.8) * 0.72) {
        saveHuayuSettings({ ...huayuSettings(), showContacts: false });
        return;
      }
      for (const row of railRows) {
        if (y >= row.y && y < row.y + row.h) {
          if (row.queueIndex !== playerState().index) playAt(row.queueIndex);
          break;
        }
      }
      return;
    }
    // 输入条：右侧圆钮＝发送，其余区域＝开始打字
    if (composerH > 0 && y >= composerTop && y <= composerTop + composerH) {
      if (sendHit(x, y)) {
        sendPress = 1;
        sendLocal();
        return;
      }
      if (x >= sideMargin && x <= contentRight) {
        input.focus({ preventScroll: true });
        return;
      }
    }
    if (inputFocused) input.blur();
  };
  canvas.addEventListener('pointerdown', onRailPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);

  // 待播队列比一屏长时用滚轮滚；上限在 paintRail 里按内容高夹住。
  const onRailWheel = (event: WheelEvent): void => {
    if (!active || disposed || railW <= 0 || railQueue.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    if (event.clientX - rect.left > railW) return;
    const rowH = Math.round(railUnit * 3.5);
    const topY = Math.max(36, bodySize * 2.8) + railUnit * 0.45;
    const viewH = Math.max(rowH, viewHeight - topY - composerH - railUnit * 0.4);
    const maxScroll = Math.max(0, railQueue.length * rowH - viewH);
    if (maxScroll <= 0) return;
    event.preventDefault();
    railScrollTarget = Math.min(maxScroll, Math.max(0, railScrollTarget + event.deltaY));
  };
  canvas.addEventListener('wheel', onRailWheel, { passive: false });

  /* ── 底部输入条 ───────────────────────────────────────────── */

  /** 一条聊天界面的输入框：左边＋、中间草稿、右边发送。草稿就是「正在唱的这一句」，
      唱完自动清空回到占位符 —— 像是下一条消息刚打完还没发出去。 */
  /** 手动发出的消息：按当前排版量出气泡（行列与高度跟歌词气泡同一套）。 */
  const localLayoutOf = (text: string): BubbleLayout => {
    const b = bodySize;
    const empty: BubbleLayout = {
      rows: [],
      translationRows: [],
      width: padX * 2 + b,
      height: padY * 2 + b * 1.4,
      bodySize: b,
      bodyLineHeight: Math.round(b * 1.28),
      transSize: Math.round(b * 0.82),
      transLineHeight: Math.round(b * 1.05),
      padX,
      padY,
      metaH: 0,
      quoteText: '',
      quoteH: 0,
    };
    if (!ctx) return empty;
    ctx.save();
    ctx.font = fontOf(bodySize);
    const glyphs: Glyph[] = [];
    for (const ch of Array.from(text)) {
      glyphs.push({ text: ch, width: ctx.measureText(ch).width, startMs: 0, endMs: 0 });
    }
    const rows = wrapGlyphs(glyphs, maxTextWidth);
    ctx.restore();
    let widest = 0;
    for (const row of rows) widest = Math.max(widest, row.width);
    const metaH = metaHeightOf('right');
    const lineHeight = empty.bodyLineHeight;
    return {
      rows,
      translationRows: [],
      width: Math.max(widest + padX * 2, bodySize * 2.4),
      // 每个字都按「已唱」画（时间 0），高度必须把 meta 那一行算进去，跟歌词气泡对齐。
      height: padY * 2 + rows.length * lineHeight + metaH,
      bodySize,
      bodyLineHeight: lineHeight,
      transSize: empty.transSize,
      transLineHeight: empty.transLineHeight,
      padX,
      padY,
      metaH,
      quoteText: '',
      quoteH: 0,
    };
  };

  /** 发出去：不是浮层，而是往这条聊天流里插一条「我方」消息，输入框清空。 */
  const sendLocal = (): void => {
    const text = input.value.replace(/\s+/g, ' ').trim();
    if (text === '') return;
    const layout = localLayoutOf(text);
    const atIndex = Math.max(0, lineIndex);
    const line: SongLine = {
      timeMs: lastSongMs,
      durationMs: 0,
      text,
      translation: '',
      words: [],
    };
    locals.push({ seq: ++localSeq, atIndex, line, layout, bornAt: performance.now(), top: 0, grow: 0, dying: false });
    input.value = '';
    inputValue = '';
  };

  /** 每条手动消息落在长卷的哪个 y：同一条歌词后面的按发送顺序往下排。 */
  const syncLocals = (dt: number): void => {
    for (const msg of locals) {
      // 只撑开不收回：这条消息属于聊天记录，靠长卷滚出视野正常隐退（上方 fadeTop 规则），
      // 不再按时间让它消失——那样会在它身上出现「到点垮掉」的断点。
      if (msg.grow < 1) msg.grow = clamp01(msg.grow + dt / Math.max(0.08, huayuSettings().sendGrowMs / 1000));
    }
    if (locals.length === 0) return;
    locals.sort((left, right) => (left.atIndex - right.atIndex) || (left.seq - right.seq));
    const cursor = new Map<number, number>();
    for (const msg of locals) {
      let top = cursor.get(msg.atIndex);
      if (top === undefined) {
        top = canvasTopOf(msg.atIndex) + layoutOf(msg.atIndex).height + gap;
      }
      msg.top = top;
      cursor.set(msg.atIndex, top + (msg.layout.height + gap) * msg.grow);
    }
  };

  /** 画手动发出的消息：跟着长卷一起滚，出场规则与歌词气泡完全一致。 */
  const paintLocals = (
    alpha: number,
    now: number,
    lyricMs: number,
    enterMs: number,
    screenY: (y: number) => number,
  ): void => {
    if (!ctx || locals.length === 0) return;
    const cfg = huayuSettings();
    for (const msg of locals) {
      const age = now - msg.bornAt;
      const enter = clamp01(age / Math.max(60, enterMs));
      const above = fadeTop - screenY(msg.top);
      const exitFade = above <= 0 ? 1 : 1 - clamp01(above / Math.max(48, msg.layout.height * 0.85));
      const a = alpha * easeOutCubic(clamp01(enter * 2.8)) * exitFade;
      if (a <= 0.004) continue;
      // 时间戳用发送时刻，双勾直接是「已读」——它本来就是我方发出去的一条。
      paintBubble(shapeForLine(msg.atIndex), msg.line, msg.layout, 'right', msg.top, lyricMs, a, motionOf('right', Math.min(enter, exitFade), enterKindOf(msg.atIndex, cfg.enter)), true);
      paintAvatar('right', msg.top, a * 0.95);
    }
  };

  const paintComposer = (alpha: number, now: number, songMs: number, dt: number): void => {
    if (!ctx || composerH <= 0) return;
    const left = sideMargin;
    const right = contentRight;
    if (right - left < 140) return;
    const h = composerH;
    const y = composerTop;
    const midY = y + h / 2;
    const accent = theme?.accentColor || fallback.accentColor;
    // 悬停/按下：两条指数跟随，鼠标移上去微微涨、按住往下缩一点再弹回。
    sendHover = lerp(sendHover, sendHoverOn ? 1 : 0, 1 - Math.exp(-dt * 15));
    if (Math.abs(sendHover - (sendHoverOn ? 1 : 0)) < 0.002) sendHover = sendHoverOn ? 1 : 0;
    sendPress *= Math.exp(-dt * 12);
    if (sendPress < 0.002) sendPress = 0;
    // 手动输入优先：一旦用户在打字，歌词预打让位，不跟自己抢输入框。
    const manual = inputFocused || inputValue.length > 0;
    let ownChars: string[] | null = null;
    let ownShown = 0;
    if (!manual && song) {
      for (let i = Math.max(0, lineIndex); i < song.lines.length && i < lineIndex + 8; i += 1) {
        if (sides[i] !== 'right') continue;
        const target = song.lines[i];
        if (!target) continue;
        const start = lineStartMs(target);
        if (start <= songMs) continue;
        const chars = Array.from(target.text);
        if (chars.length === 0) continue;
        // 提前一点开始敲：按字数拉出打字窗口，到点前刚好敲满，紧接着气泡「发」出去。
        const windowMs = Math.min(2800, Math.max(900, chars.length * 95));
        const from = start - windowMs;
        if (songMs >= from - 120) {
          ownChars = chars;
          ownShown = huayuSettings().draftTyping
            ? Math.floor(clamp01((songMs - from) / windowMs) * chars.length)
            : chars.length;
        }
        break;
      }
    }
    if (manual) {
      draftChars = Array.from(inputValue);
      draftShown = draftChars.length;
    } else if (ownChars) {
      draftChars = ownChars;
      draftShown = ownShown;
    }
    const wantDraft = manual || ownChars !== null;
    draftAlpha = lerp(draftAlpha, wantDraft ? 1 : 0, 1 - Math.exp(-dt * (manual ? 20 : 16)));
    const draftText = draftChars.slice(0, draftShown).join('');

    ctx.save();
    ctx.globalAlpha = alpha;

    // 与消息区的分隔线：只画内容区，不压左侧会话栏
    ctx.fillStyle = 'rgb(43 37 48 / 0.055)';
    ctx.fillRect(left, y - Math.max(8, gap * 0.7), right - left, 1);

    roundRect(left, y, right - left, h, Math.round(h / 2), 'left');
    ctx.fillStyle = 'rgb(255 255 255 / 0.97)';
    ctx.shadowColor = 'rgb(58 44 24 / .10)';
    ctx.shadowOffsetY = 2;
    ctx.shadowBlur = 9;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = 'rgb(43 37 48 / 0.09)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 左侧＋
    const plusX = left + h * 0.54;
    ctx.beginPath();
    ctx.arc(plusX, midY, h * 0.29, 0, Math.PI * 2);
    ctx.fillStyle = 'rgb(43 37 48 / 0.045)';
    ctx.fill();
    ctx.strokeStyle = withAlpha(palette.leftText, 0.55);
    ctx.lineWidth = Math.max(1, h * 0.036);
    const arm = h * 0.1;
    ctx.beginPath();
    ctx.moveTo(plusX - arm, midY);
    ctx.lineTo(plusX + arm, midY);
    ctx.moveTo(plusX, midY - arm);
    ctx.lineTo(plusX, midY + arm);
    ctx.stroke();

    // 中间：草稿（逐字打出） / 占位符，两者按 draftAlpha 交叉，不会互相闪跳
    const textX = plusX + h * 0.52;
    const textRight = right - h * 1.35;
    const textMax = Math.max(40, textRight - textX);
    // 透明 textarea 落在文字区上：位置只在变化时写样式，避免每帧触发布局。
    const boxX = Math.round(textX);
    const boxY = Math.round(y + h * 0.16);
    const boxW = Math.round(textMax);
    const boxH = Math.round(h * 0.68);
    if (overlayBox.x !== boxX || overlayBox.y !== boxY || overlayBox.w !== boxW || overlayBox.h !== boxH) {
      overlayBox = { x: boxX, y: boxY, w: boxW, h: boxH };
      input.style.left = `${boxX}px`;
      input.style.top = `${boxY}px`;
      input.style.width = `${boxW}px`;
      input.style.height = `${boxH}px`;
    }
    ctx.textAlign = 'left';
    ctx.font = fontOf(Math.round(bodySize * 0.92), 500);
    const placeholderIn = draftChars.length === 0 ? alpha : alpha * clamp01(1 - draftAlpha * 1.15);
    if (placeholderIn > 0.01) {
      ctx.globalAlpha = placeholderIn;
      ctx.fillStyle = withAlpha(palette.leftMuted, 0.72);
      ctx.fillText('发消息…', textX, midY, textMax);
      ctx.globalAlpha = alpha;
    }
    let caretX = textX;
    if (draftAlpha > 0.01 && draftChars.length > 0) {
      ctx.fillStyle = withAlpha(palette.leftText, 0.82);
      ctx.globalAlpha = alpha * draftAlpha;
      // 草稿也会爆框：量出来的宽度超了就整体左移，光标始终贴在最末尾那个字后面。
      const used = ctx.measureText(draftText).width;
      const shift = Math.max(0, used - textMax);
      ctx.save();
      ctx.beginPath();
      ctx.rect(textX, y + h * 0.16, textMax, h * 0.68);
      ctx.clip();
      // 选区：原生 selection 已经在 CSS 里关掉了，这里按字宽自己铺一条，
      // 位置和 canvas 字形严丝合缝（跟草稿共用同一左移量，滚出边界也一起走）。
      const selFrom = Math.max(0, input.selectionStart ?? 0);
      const selTo = Math.max(selFrom, input.selectionEnd ?? 0);
      if (inputFocused && selTo > selFrom) {
        const chars = Array.from(inputValue);
        const before = ctx.measureText(chars.slice(0, selFrom).join('')).width;
        const span = ctx.measureText(chars.slice(selFrom, selTo).join('')).width;
        const fs = Math.round(bodySize * 0.92);
        ctx.save();
        ctx.globalAlpha = alpha * draftAlpha;
        ctx.fillStyle = withAlpha(accent, 0.22);
        ctx.fillRect(textX - shift + before, midY - fs * 0.78, Math.max(1.5, span), fs * 0.98);
        ctx.restore();
        ctx.globalAlpha = alpha * draftAlpha;
        ctx.fillStyle = withAlpha(palette.leftText, 0.82);
      }
      ctx.fillText(draftText, textX - shift, midY);
      ctx.restore();
      ctx.globalAlpha = alpha;
      caretX = textX + Math.min(used, textMax) + (used > textMax ? 0 : Math.round(bodySize * 0.1));
    }

    // 光标：方波闪烁（530ms 一档），打字时贴在字尾，空闲时停在占位符前
    if (Math.floor(now / 530) % 2 === 0) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = withAlpha(accent, 0.86);
      ctx.fillRect(caretX, midY - bodySize * 0.6, Math.max(1.5, bodySize * 0.1), bodySize * 1.2);
    }

    // 右侧发送：实心圆 + 一支素色上箭头。小尺寸下任何「图形化」的纸飞机都会糊成一团，
    // 只有圆 + 箭头这种极简符号在任何字号、任何主题色下都读得清。
    const sendX = right - h * 0.52;
    const sendScale = 1 + sendHover * 0.1 - sendPress * 0.07;
    const sendR = h * 0.32 * sendScale;
    // 悬停时垫一圈很淡的光晕，比单纯放大更容易看出「这里能点」。
    if (sendHover > 0.01) {
      ctx.beginPath();
      ctx.arc(sendX, midY, sendR * (1.42 + sendHover * 0.12), 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(accent, 0.11 * sendHover);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(sendX, midY, sendR, 0, Math.PI * 2);
    ctx.fillStyle = sendHover > 0.01 ? blendColor(accent, '#ffffff', sendHover * 0.14) : accent;
    ctx.fill();

    const arrow = sendR * 0.52;
    ctx.strokeStyle = 'rgb(255 253 248 / 0.96)';
    ctx.lineWidth = Math.max(1.6, sendR * 0.17);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(sendX, midY + arrow);
    ctx.lineTo(sendX, midY - arrow);
    ctx.moveTo(sendX - arrow * 0.74, midY - arrow * 0.2);
    ctx.lineTo(sendX, midY - arrow);
    ctx.lineTo(sendX + arrow * 0.74, midY - arrow * 0.2);
    ctx.stroke();

    ctx.restore();

    ctx.restore();
    ctx.textAlign = 'left';
  };

  function drawWindow(c: CanvasRenderingContext2D, index: number, time: number) {
    const divider = Math.max(36, bodySize * 2.8);
    const centerY = divider / 2;
    const accent = theme?.accentColor || fallback.accentColor;
    c.fillStyle = accent;
    c.beginPath();
    c.arc(sideMargin, centerY, bodySize * .2, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#2b2530';
    c.font = fontOf(Math.max(11, bodySize * .78));
    c.fillText(song?.title || '话语', sideMargin + bodySize * .65, centerY, viewWidth * .48);
    c.textAlign = 'right';
    c.fillStyle = 'rgb(43 37 48 / 0.55)';
    c.font = fontOf(Math.max(10, bodySize * .58), 500);
    c.fillText(`${index + 1} / ${song?.lines.length ?? 0} 条`, Math.max(80, contentRight), centerY);
    c.textAlign = 'left';
    c.fillStyle = accent;
    c.fillRect(0, divider - 2, viewWidth * clamp01(time / Math.max(1, song?.durationMs || 1)), 2);
    c.beginPath();
    c.rect(0, divider, viewWidth, Math.max(0, viewHeight - divider));
    c.clip();
  }

  const renderFrame = (): void => {
    if (!active || disposed) return;
    const now = performance.now();
    const dt = lastFrameAt > 0 ? Math.min(0.1, Math.max(0, (now - lastFrameAt) / 1000)) : 1 / 60;
    lastFrameAt = now;
    const raw = externalClock ? externalClock() : anchorMs + (playing ? now - anchorAt : 0);
    const songMs = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    lastSongMs = songMs;

    try {
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, viewWidth, viewHeight);
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.globalAlpha = 1;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.font = fontOf(bodySize);

        // 背景先铺：封面或透明（画在镜头变换之外，镜头推拉时背景不动）。
        paintBackdrop();

        // 整层淡入：切歌 / 跳播 / 刚进页面都从 0 起，避免上一首的句子闪一帧。
        const cfg = huayuSettings();
        // 皮肤：auto 时按歌名抽一套，同一首歌每次进来都是同一套外观。
        if (cfg.randomShapes && (cfg !== sequenceSettings || songKey !== sequenceSong)) {
          sequenceSettings = cfg;
          sequenceSong = songKey;
          let seed = hash32(song?.trackKey ?? '');
          shapeSequence = buildShapeSequence(cfg, song?.lines.length ?? 0, () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 0x100000000;
          });
        }
        skinId = cfg.bubbleStyle === 'auto'
          ? SKIN_ORDER[hash32(`${songKey}|skin`) % SKIN_ORDER.length]!
          : cfg.bubbleStyle;
        // 拖动「字号 / 气泡宽度」这类影响排版的项时，这里会自动重测并保持当前位置。
        // metrics 只是几个乘法，每帧算一遍，落点/字号这类滑杆拖动时才真的跟手。
        metrics();
        if (splitKeyOf() !== splitKey) {
          // 拆词开关/字数刚被拖动：整首歌重新切段，消息流从头排，镜头直接落位。
          splitKey = splitKeyOf();
          song = splitSong(rawSong);
          sides = buildSides(song);
          layoutCache.clear();
          resetStream();
        }
        if (sidesMode !== cfg.sideMode) sides = buildSides(song);
        const stamp = layoutKeyOf();
        if (stamp !== layoutKey) {
          layoutKey = stamp;
          layoutCache.clear();
          for (const entry of entries) entry.layout = layoutOf(entry.index);
        }


        const lines = song?.lines ?? [];
        const index = activeIndexAt(songMs);
        if (index !== lineIndex) {
          // 只有真拖动进度（往回，或往前跨好几行）才算跳播；插段、空行、极短句造成的
          // 跨一两行交给镜头自己滚过去，那才是「缓速」。
          const jump = lineIndex >= 0 && (index < lineIndex || index - lineIndex > 3);
          lineIndex = index;
          if (jump) {
            // 大跨度跳播：当成一次新的会话，淡入重来；镜头也直接落位，不要一路飘过去。
            entries = [];
            layerAlpha = 0;
            camX = 0;
            camVX = 0;
            camSnap = true;
          }
        }

        // 整层淡入：换歌/跳播/改设置时从 0 淡回来，平时恒为 1。
        layerAlpha += (1 - layerAlpha) * (1 - Math.exp(-dt * 9));
        if (layerAlpha < 0.002) layerAlpha = 0;

        syncEntries(index);
        // 手动发出的消息也要先落位：它插在当前句后面，镜头得把它算成最新的一条。
        syncLocals(dt);
        ctx.save();
        if (cfg.chatWindow) drawWindow(ctx, index, songMs);
        // 会话栏固定贴在左侧，不跟镜头走：翻会话是「界面」在动，不是画面在动。
        paintRail(layerAlpha, dt);
        if (cfg.showComposer) {
          if (input.style.display === 'none') input.style.display = '';
          paintComposer(layerAlpha, now, songMs, dt);
        } else if (input.style.display !== 'none') {
          if (inputFocused) input.blur();
          input.style.display = 'none';
          overlayBox = { x: -1, y: -1, w: -1, h: -1 };
        }
        // 镜头：自由跟随。像端着机器慢慢跟最新那条消息走 —— 只平移，另带一点极轻的手持倾角和
        // 缓慢漂移，全程不缩放；强度拉到 0 时弹簧自己回正（＝固定镜头），跳播时直接落位不飘。
        const camStrength = reducedMotion.matches ? 0 : clamp01(cfg.cameraStrength);
        const zoomWant = reducedMotion.matches ? 0 : clamp01(cfg.cameraZoom);
        camClock += dt;
        const anchor = camFocus(index);
        const spanX = viewWidth * 0.085;
        const wantX = Math.max(-spanX, Math.min(spanX, (viewWidth * 0.5 - anchor.x) * 0.16)) * camStrength;
        // 纵向：最新一条的底边要贴住 baseY。滚动量是画布模型必需的，不跟镜头强度联动，
        // 否则强度调到 0 消息就会跑出画面；强度只管横向与手持倾角。
        const tail = entries[entries.length - 1];
        let tailBottom = tail ? tail.top + tail.layout.height : Number.NEGATIVE_INFINITY;
        for (const msg of locals) {
          if (msg.top + msg.layout.height > tailBottom) tailBottom = msg.top + msg.layout.height;
        }
        const wantScroll = Number.isFinite(tailBottom) ? baseY - tailBottom : 0;
        // 缓速：弹簧很软（k 小 + 接近临界阻尼），镜头是慢慢「飘」过去的，不是追过去。
        // 「跟随速度」滑杆直接决定这根弹簧的刚度：默认 13 → k≈5.2（约 2.7 秒整定）。
        const springK = 0.65 + Math.max(4, cfg.riseSpeed) * 0.35;
        const springC = 2 * Math.sqrt(springK) * 0.96;
        // 纵向单独一套：横向的「跟着走」可以很软（那是运镜），纵向是排版基准，
        // 必须在小半秒内追平画布变长，否则新消息会停在输入条高度以下，还会因为硬压而抽帧。
        const springKv = Math.max(110, springK * 13);
        const springCv = 2 * Math.sqrt(springKv) * 1.02;
        const camStep = Math.min(1 / 30, Math.max(0, dt));
        camVX += (springK * (wantX - camX) - springC * camVX) * camStep;
        camX += camVX * camStep;
        // 焦点弹簧比平移更软一档：换句时能看清镜头是从上一句摇过来的。
        // 「推近速度」直接缩放这两根弹簧的刚度（阻尼比保持不变，快也快得稳）。
        const camEase = Math.max(0.15, cfg.cameraZoomSpeed);
        const camEase2 = camEase * camEase;
        const focusK = Math.max(1.9, springK * 0.62) * camEase2;
        const focusC = 2 * Math.sqrt(focusK) * 0.95;
        camFxV += (focusK * (anchor.x - camFx) - focusC * camFxV) * camStep;
        camFyV += (focusK * (anchor.y - camFy) - focusC * camFyV) * camStep;
        camFx += camFxV * camStep;
        camFy += camFyV * camStep;
        // 缩放比焦点再慢一点：先摇过去，再贴近，观感才像真的把镜头推进去。
        const zoomK = Math.max(1.7, springK * 0.5) * camEase2;
        const zoomC = 2 * Math.sqrt(zoomK) * 0.92;
        camZoomV += (zoomK * (zoomWant - camZoom) - zoomC * camZoomV) * camStep;
        camZoom += camZoomV * camStep;
        if (camSnap) {
          // 跳播：直接落到该在的位置，不要从上一首歌的位置飘过来。
          camSnap = false;
          camX = wantX;
          camVX = 0;
          camScroll = wantScroll;
          camScrollV = 0;
          camFx = anchor.x;
          camFy = anchor.y;
          camFxV = 0;
          camFyV = 0;
          camZoom = zoomWant;
          camZoomV = 0;
        } else {
          camScrollV += (springKv * (wantScroll - camScroll) - springCv * camScrollV) * camStep;
          camScroll += camScrollV * camStep;
        }
        const breezeX = Math.sin(camClock * 0.11 + 1.6) * viewWidth * 0.0055 * camStrength;
        const breezeY = Math.cos(camClock * 0.083 + 0.7) * viewHeight * 0.0065 * camStrength;
        const camRoll = Math.sin(camClock * 0.062 + 2.2) * 0.0052 * camStrength;
        const zoomW = clamp01(camZoom);
        const camScale = 1 + zoomW * 1.15;
        // 焦点最终落在画面水平居中、纵向偏上一点的位置；zoomW=0 时这些量全部退化成 0，
        // 变换就只剩原来的平移 + 倾角，和没加推近时一模一样。
        const camOffX = camX + breezeX;
        const camOffY = (camScroll + breezeY) * (1 - zoomW);
        const aimX = camFx + (viewWidth * 0.5 - camFx) * zoomW;
        const aimY = camFy + (viewHeight * 0.44 - camFy) * zoomW + breezeY * zoomW;
        ctx.save();
        if (
          Math.abs(aimX + camOffX - camFx) > 0.01
          || Math.abs(aimY + camOffY - camFy) > 0.01
          || Math.abs(camScale - 1) > 1e-4
          || Math.abs(camRoll) > 1e-4
        ) {
          // 先把焦点送到落点，再绕焦点缩放，最后转一点点：气泡跟着走，聊天窗边框保持不动。
          ctx.translate(aimX + camOffX, aimY + camOffY);
          ctx.rotate(camRoll);
          ctx.scale(camScale, camScale);
          ctx.translate(-camFx, -camFy);
        }
        /** 内容纵坐标 → 屏幕纵坐标：推近之后渐隐线、入场判据都得按屏幕算。 */
        const screenY = (y: number): number => (y - camFy) * camScale + aimY + camOffY;

        const lyricMs = songMs;
        const enterMs = Math.max(60, cfg.enterMs);

        for (const entry of entries) {
          const rate = entry.retiring ? (cfg.exit === 'snappy' ? -1.8 : -1) : 1;
          // 长卷滚动可能晚于换句；头像进入视野后才开始播放这条消息的弹簧。
          const avatarInView = screenY(avatarCenterY(entry.top)) <= viewHeight - bodySize;
          if (entry.retiring || entry.phase > 0 || avatarInView) {
            entry.phase = clamp01(entry.phase + dt * 1000 * rate / enterMs);
          }
          const progress = entry.phase;
          const enterAlpha = easeOutCubic(clamp01(progress * 2.8));
          // 出场：镜头把这条滚到渐隐线以上就按距离淡掉（位置不动，同轨迹反向离开画面）。
          const above = fadeTop - screenY(entry.top);
          const exitFade = above <= 0 ? 1 : 1 - clamp01(above / Math.max(48, entry.layout.height * 0.85));
          const alpha = layerAlpha * enterAlpha * exitFade;
          entry.fade = alpha;
          if (alpha <= 0.004) continue;

          const line = lines[entry.index];
          if (!line) continue;
          const sent = lyricMs >= lineEndMs(line);
          const motion = motionOf(entry.site, Math.min(progress, exitFade), enterKindOf(entry.index, cfg.enter));

          // 撤回：气泡按入场同一条轨迹收掉（原地缩、同方向淡出），再留下那行小字。
          // 进度只由时间决定，拖进度条回来会自然倒放，不会留半截动画。
          const revoke = revokedProgress(entry.index, lyricMs);
          if (revoke >= 0) {
            const left = 1 - revoke;
            if (left > 0.004) {
              const shrink = 0.9 + 0.1 * left;
              paintBubble(
                shapeForLine(entry.index),
                line,
                entry.layout,
                entry.site,
                entry.top,
                lyricMs,
                alpha * left,
                {
                  dx: motion.dx * left,
                  dy: motion.dy * left,
                  sx: motion.sx * shrink,
                  sy: motion.sy * shrink,
                  rot: motion.rot * left,
                },
                sent,
              );
              paintAvatar(entry.site, entry.top, alpha * left * 0.95);
            }
            paintRevokeChip(entry.site, entry.top, entry.layout, alpha, revoke);
            continue;
          }

          paintBubble(shapeForLine(entry.index), line, entry.layout, entry.site, entry.top, lyricMs, alpha, motion, sent);
          paintAvatar(entry.site, entry.top, alpha * 0.95);
          if (alpha > 0.9) markPainted();
        }

        // 自己发的消息：同一条长卷里的「我方」气泡，跟着镜头一起滚。
        paintLocals(layerAlpha, now, lyricMs, enterMs, screenY);

        // 气泡层到此为止：镜头还原，输入提示属于界面层，不跟着画面滚。
        ctx.restore();

        // 「正在输入」：当前句唱完、下一句还没到的空档，在下一句那一侧冒三点。
        const nextLine = lines[index + 1];
        const currentLine = lines[index];
        const currentDone = currentLine ? lyricMs >= lineEndMs(currentLine) : true;
        const nextGap = nextLine ? lineStartMs(nextLine) - lyricMs : Number.POSITIVE_INFINITY;
        const showTyping = cfg.showTyping && currentDone && nextGap > 420 && nextGap < 9000;
        if (nextLine && showTyping) typingSite = sides[index + 1] ?? 'left';
        typingAlpha = lerp(typingAlpha, showTyping ? 1 : 0, 1 - Math.exp(-dt * (showTyping ? 11 : 8)));
        if (typingAlpha > 0.004) paintTyping(typingSite, typingAlpha * layerAlpha, songMs);
        ctx.restore();
      }
    } catch (error) {
      console.error('[huayu] frame failed', error);
      root.classList.add('is-failed');
    }

    raf = window.requestAnimationFrame(renderFrame);
  };

  /** 取当前封面的主色当「随曲」配色；换歌后旧请求回来不认账。 */
  function loadCoverAccent(input: LumiereSongInput | null, key: string): void {
    coverAccentKey = key;
    const url = input?.coverUrl ?? null;
    if (!url) {
      if (coverAccent) {
        coverAccent = null;
        palette = buildPalette(theme);
      }
      return;
    }
    void coverColorsOfUrl(url).then((colors) => {
      if (coverAccentKey !== key) return;
      const next = colors?.dominant ?? null;
      if (next === coverAccent) return;
      coverAccent = next;
      palette = buildPalette(theme);
    });
  }

  /* ── 对外接口 ─────────────────────────────────────────────── */

  return {
    root,

    setMode(next: LumiereMode): void {
      mode = next;
    },

    setSong(input: LumiereSongInput | null): void {
      const nextKey = songSignature(input);
      rawSong = input;
      splitKey = splitKeyOf();
      song = splitSong(input);
      if (nextKey === songKey) {
        // 同一首歌、只是拆词设置变了：句子变了但气泡位置不必重来。
        sides = buildSides(song);
        layoutCache.clear();
        return;
      }
      songKey = nextKey;
      sides = buildSides(song);
      layoutCache.clear();
      loadCoverAccent(input, nextKey);
      resetStream();
      root.classList.toggle('is-content', (song?.lines.length ?? 0) > 0);
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    },

    setTheme(next: Theme): void {
      theme = next;
      palette = buildPalette(theme);
      fontFamily = (() => {
        const stack = next?.fontFamilyStack?.filter((name) => Boolean(name)) ?? [];
        if (stack.length > 0) return stack.map((name) => (/[",]/.test(name) ? name : `"${name}"`)).join(', ');
        return next?.fontFamily || DEFAULT_FONT_STACK;
      })();
      layoutCache.clear();
      // 字面变了：已经在场的气泡要按新字体重排，否则高度与换行还是旧的。
      for (const entry of entries) entry.layout = layoutOf(entry.index);
    },

    activate(): void {
      if (disposed) return;
      if (teardownTimer) {
        window.clearTimeout(teardownTimer);
        teardownTimer = 0;
      }
      if (active) return;
      active = true;
      root.classList.add('is-on');
      root.classList.remove('is-failed');
      resize();
      syncPlayer();
      resetStream();
      lastFrameAt = 0;
      if (!raf) raf = window.requestAnimationFrame(renderFrame);
    },

    deactivate(): void {
      if (!active) return;
      active = false;
      input.blur();
      root.classList.remove('is-on');
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      if (teardownTimer) window.clearTimeout(teardownTimer);
      teardownTimer = window.setTimeout(() => {
        teardownTimer = 0;
        if (active || disposed) return;
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        painted = false;
        root.classList.remove('is-ready', 'is-painted', 'is-content');
        resetStream();
      }, TEARDOWN_MS);
    },

    dispose(): void {
      disposed = true;
      active = false;
      sizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', onRailPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onRailWheel);
      unsubscribe();
      bgCache = null;
      bgCacheKey = '';
      if (teardownTimer) window.clearTimeout(teardownTimer);
      teardownTimer = 0;
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      layoutCache.clear();
      sides = [];
      void mode;
      root.remove();
    },
  };
}
