/**
 * 歌词页「播放效果 · PV」— 单画布 2D 场景（自研）。
 *
 * 这一版按《命ばっかり》文字 PV 的实际做法重写：全片是**一张张印刷海报**，
 * 「字 + 色块 + 纸片」三样东西，靠五幕换色、逐拍硬切、图形转场把歌词一句句摆出来。
 *
 * 结构上分三层：
 *   幕（Act）  —— 按整首歌的进度走过五幕：墨蓝 → 白与卡 → 朱红 → 灰绿 → 黑白收尾。
 *                 每一幕有自己的底色/字色/重音和一组可用版面，换幕是整块换色，不做渐变。
 *   镜（Shot） —— 每一句歌词是一镜。版面从本幕的池子里按「句序 + 文本」稳定地挑，
 *                 同一句永远同一版，换句也不会连着撞版；同时定下入场动效与转场。
 *   字（Char） —— 逐字时机来自 LRC/KRC 的逐字数据；唱到的字实心、正在唱的字取重音色、
 *                 还没唱的字只剩极淡的形。手写类版面靠遮罩从左到右「擦」出来。
 *
 * 节奏：默认按 12 格/秒量化（定格动画），纸片类 ease-out、故障类硬跳、手写类匀速。
 * 微动：整幅画面有 ±1px 的手持抖动与 1–4° 倾斜，静止镜头靠它维持呼吸。
 *
 * 性能：版面元素全是矢量即时绘制；逐字用一次 fillText，字宽按「字体 + 字」缓存，
 * 不在帧里 measureText；换句时的撕裂/推卡转场用一张离屏快照做切片。
 */

import { DEFAULT_PV_SETTINGS, normalizePvSettings, type PvStyleSettings } from './pvSettings';

export interface PvSceneWord { text: string; startMs: number; endMs: number; spaceBefore?: boolean }
export interface PvSceneLine {
  timeMs: number;
  durationMs: number;
  text: string;
  translation?: string;
  words: ReadonlyArray<PvSceneWord>;
}
export interface PvSong {
  trackKey?: string;
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  lyricOffsetMs?: number;
  lines: ReadonlyArray<PvSceneLine>;
}
export interface PvSceneOptions {
  onPainted?: () => void;
  /** 幕变化时通知外面（歌词页用它把控件颜色跟着换成深/浅）。 */
  onAct?: (act: number) => void;
  style?: Partial<PvStyleSettings> | Record<string, unknown>;
}
export interface PvScene {
  readonly root: HTMLDivElement;
  setStyle(settings: Partial<PvStyleSettings> | Record<string, unknown>): void;
  setSong(song: PvSong | null): void;
  update(positionMs: number, playing: boolean, energy?: number): void;
  resize(): void;
  dispose(): void;
}

/* ── 小工具 ──────────────────────────────────────────────────── */

const clamp = (v: number, lo = 0, hi = 1): number => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoother = (t: number): number => { const x = clamp(t); return x * x * x * (x * (x * 6 - 15) + 10); };
const easeOut = (t: number): number => { const x = clamp(t); return 1 - (1 - x) * (1 - x); };
const backOut = (t: number): number => {
  const x = clamp(t);
  const c = 1.70158;
  const y = x - 1;
  return 1 + (c + 1) * y * y * y + c * y * y;
};

/** PV 是定格动画：时间先量化到 12 格/秒，动效按格跳。 */
const STEP = 1000 / 12;
const stepped = (ms: number): number => Math.floor(ms / STEP) * STEP;

/** 稳定散列：同一句永远拿到同一版，不同句尽量散开。 */
function hash32(...parts: Array<string | number>): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

/* ── 字体 ────────────────────────────────────────────────────── */

/** 细衬线明朝：标题、`視界が`、`長く`、`時間` 这类被拉长切角的字。 */
const MINCHO = '"Yu Mincho","YuMincho","Noto Serif JP","Source Han Serif SC","Songti SC","STSong",SimSun,serif';
/** 手写 brush：`どこにももう`、`それでしかなかった`、`夜なんで`，情绪字。 */
const BRUSH = '"Kaiti SC","STKaiti","KaiTi","TW-Kai","LXGW WenKai","Noto Serif JP",serif';
/** 细无衬线：说明/旁白层。 */
const SANS = '"PingFang SC","Microsoft YaHei","Noto Sans JP","Hiragino Sans",sans-serif';
const MONO = '"Cascadia Mono",Consolas,"Courier New",monospace';

type FontKind = 'mincho' | 'brush' | 'heavy' | 'sans' | 'mono';

const fontOf = (kind: FontKind, px: number): string => {
  switch (kind) {
    case 'brush': return `500 ${px}px ${BRUSH}`;
    case 'heavy': return `900 ${px}px ${MINCHO}`;
    case 'sans': return `300 ${px}px ${SANS}`;
    case 'mono': return `${px}px ${MONO}`;
    default: return `400 ${px}px ${MINCHO}`;
  }
};

/* ── 五幕的色板 ──────────────────────────────────────────────── */

interface Skin {
  /** 底色 */
  bg: string;
  /** 主字色 */
  ink: string;
  /** 重音色（正在唱的字、印章、色带） */
  accent: string;
  /** 卡片/面板底色 */
  panel: string;
  /** 压在卡片上的字色 */
  panelInk: string;
  /** 小字/标记的弱色 */
  soft: string;
  /** 深色底（控件要反过来排） */
  dark: boolean;
}

/** 第一幕 · 墨蓝 (#141531)：全片出现最多的底色。 */
const SK_NAVY: Skin = { bg: '#141531', ink: '#F4F2EA', accent: '#CC353C', panel: '#F4F2EA', panelInk: '#141531', soft: '#7C82A8', dark: true };
/** 第一幕的浅版：白底 + 墨蓝字。 */
const SK_NAVY_LIGHT: Skin = { bg: '#F1EFE7', ink: '#141531', accent: '#CC353C', panel: '#141531', panelInk: '#F1EFE7', soft: '#6B7196', dark: false };
/** 第二幕 · 白与卡：白纸、墨蓝字、纸片硬投影。 */
const SK_PAPER: Skin = { bg: '#F5F3EC', ink: '#141531', accent: '#CC353C', panel: '#FFFFFF', panelInk: '#141531', soft: '#8A8E9E', dark: false };
/** 第三幕 · 朱红 (#CC353C) + 奶油 (#EEC19A)。 */
const SK_RED: Skin = { bg: '#CC353C', ink: '#F3E2C6', accent: '#141531', panel: '#EEC19A', panelInk: '#CC353C', soft: '#F0BDB0', dark: true };
const SK_CREAM: Skin = { bg: '#EEC19A', ink: '#CC353C', accent: '#141531', panel: '#CC353C', panelInk: '#EEC19A', soft: '#C08B6B', dark: false };
const SK_BLACK: Skin = { bg: '#0B0B10', ink: '#F3E2C6', accent: '#CC353C', panel: '#F3E2C6', panelInk: '#0B0B10', soft: '#6B6B78', dark: true };
/** 第四幕 · 灰绿 (#4F7673 / #91A29A) + 一点奶油。 */
const SK_SAGE: Skin = { bg: '#4F7673', ink: '#EDF2EE', accent: '#EEC19A', panel: '#91A29A', panelInk: '#16241F', soft: '#BFD0C8', dark: true };
const SK_SAGE_LIGHT: Skin = { bg: '#91A29A', ink: '#16241F', accent: '#F4F2EA', panel: '#4F7673', panelInk: '#EDF2EE', soft: '#4B5F58', dark: false };
const SK_SAGE_DEEP: Skin = { bg: '#3B5A57', ink: '#EDF2EE', accent: '#EEC19A', panel: '#91A29A', panelInk: '#16241F', soft: '#A9BBB4', dark: true };
/** 第五幕 · 黑白收尾：方块转成画框，最后收黑。 */
const SK_MONO_PAPER: Skin = { bg: '#EDECE7', ink: '#121215', accent: '#121215', panel: '#121215', panelInk: '#EDECE7', soft: '#8C8C90', dark: false };
const SK_MONO_GREY: Skin = { bg: '#4A4A4E', ink: '#EDECE7', accent: '#EDECE7', panel: '#EDECE7', panelInk: '#121215', soft: '#B4B4B8', dark: true };
const SK_MONO_INK: Skin = { bg: '#0C0C0E', ink: '#EDECE7', accent: '#EDECE7', panel: '#EDECE7', panelInk: '#0C0C0E', soft: '#707074', dark: true };

/* ── 版面与入场 ──────────────────────────────────────────────── */

type LayoutId =
  | 'centerBig' | 'typeWall' | 'cardTable' | 'ring' | 'outlined'
  | 'diagonal' | 'bars' | 'columns' | 'frame' | 'collision' | 'micro' | 'endCard';

type EnterId = 'slide' | 'pop' | 'wipe' | 'slam' | 'drop' | 'iris' | 'stretch' | 'bars' | 'write' | 'spin' | 'none';

type TransitionId = 'cut' | 'dotline' | 'barwipe' | 'cardsweep' | 'boxrot' | 'glitch' | 'fade';

interface ActSkin {
  skin: Skin;
  /** 本幕可用的版面（选镜时按下标取）。 */
  layouts: LayoutId[];
  /** 本幕偏好的转场（绝大多数字仍是硬切）。 */
  transitions: TransitionId[];
  /** 与版面配套的字体。 */
  font: FontKind;
}

const ACTS: ActSkin[] = [
  // 一幕 · 墨蓝：满版字墙、环、点线圆、卡片桌的起始
  {
    skin: SK_NAVY,
    layouts: ['centerBig', 'typeWall', 'ring', 'diagonal', 'cardTable', 'outlined'],
    transitions: ['dotline', 'cut', 'cut', 'glitch'],
    font: 'mincho',
  },
  // 二幕 · 白与卡：单字、纸片、错位
  {
    skin: SK_PAPER,
    layouts: ['cardTable', 'centerBig', 'outlined', 'collision', 'micro', 'ring', 'bars'],
    transitions: ['cardsweep', 'cut', 'cut', 'barwipe'],
    font: 'mincho',
  },
  // 三幕 · 朱红：情绪爆发，满版写字与巨字
  {
    skin: SK_RED,
    layouts: ['centerBig', 'typeWall', 'outlined', 'bars', 'diagonal', 'collision', 'micro'],
    transitions: ['cut', 'glitch', 'cut', 'barwipe'],
    font: 'brush',
  },
  // 四幕 · 灰绿：报刊竖栏
  {
    skin: SK_SAGE,
    layouts: ['columns', 'columns', 'frame', 'centerBig', 'bars'],
    transitions: ['cut', 'cut', 'glitch'],
    font: 'mincho',
  },
  // 五幕 · 收尾：方块→画框、画框里的字、收黑
  {
    skin: SK_MONO_GREY,
    layouts: ['endCard', 'frame', 'endCard', 'centerBig'],
    transitions: ['boxrot', 'fade', 'cut'],
    font: 'mincho',
  },
];

/** 配色钉死到某一幕时用哪套底色（同一幕里再按页序换浅/深版）。 */
const PINNED: Record<string, Skin[]> = {
  navy: [SK_NAVY, SK_NAVY_LIGHT, SK_NAVY, SK_NAVY, SK_NAVY_LIGHT],
  red: [SK_RED, SK_CREAM, SK_RED, SK_BLACK, SK_RED],
  sage: [SK_SAGE, SK_SAGE_LIGHT, SK_SAGE_DEEP, SK_SAGE, SK_SAGE_LIGHT],
  mono: [SK_MONO_PAPER, SK_MONO_INK, SK_MONO_PAPER, SK_MONO_GREY, SK_MONO_INK],
};

const ENTERS: Record<LayoutId, EnterId[]> = {
  centerBig: ['slam', 'pop', 'drop', 'stretch'],
  typeWall: ['write', 'wipe', 'none'],
  cardTable: ['slide', 'pop', 'drop'],
  ring: ['iris', 'pop', 'spin'],
  outlined: ['wipe', 'write', 'pop'],
  diagonal: ['stretch', 'slide', 'wipe'],
  bars: ['bars', 'wipe', 'slide'],
  columns: ['drop', 'bars', 'wipe'],
  frame: ['pop', 'iris', 'slide'],
  collision: ['slam', 'pop', 'drop'],
  micro: ['none', 'wipe', 'pop'],
  endCard: ['spin', 'iris', 'pop'],
};

/* ── 场景 ───────────────────────────────────────────────────── */

interface CharInfo { ch: string; startMs: number }
interface LineModel {
  startMs: number;
  endMs: number;
  text: string;
  translation: string;
  chars: CharInfo[];
  /** 本镜定下来的版面 / 入场 / 转场 / 倾斜（编译时算一次）。 */
  layout: LayoutId;
  enter: EnterId;
  transition: TransitionId;
  tilt: number;
}

/** 五幕在句序上的比例：对齐原片的 0–20 / 20–45.4 / 45.4–61.6 / 61.6–75 / 75–90 秒。 */
const ACT_WEIGHTS = [0.22, 0.3, 0.18, 0.18, 0.12];

export function createPvScene(options: PvSceneOptions = {}): PvScene {
  const root = document.createElement('div');
  root.className = 'pv-scene';
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  root.append(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('pv scene: 2d context unavailable');
  /** 换句转场的离屏快照。 */
  const snap = document.createElement('canvas');
  const snapCtx = snap.getContext('2d');
  const measure = document.createElement('canvas').getContext('2d');

  let settings: PvStyleSettings = normalizePvSettings({ ...DEFAULT_PV_SETTINGS, ...(options.style ?? {}) });
  let song: PvSong | null = null;
  let lines: LineModel[] = [];
  let width = 0;
  let height = 0;
  let ratio = 1;
  let painted = false;
  let disposed = false;
  let energyNow = 0;
  let playingNow = false;
  /** 上一次通知出去的幕号（用于 onAct）。 */
  let actNow = -1;

  /* ── 编译：每句一镜 ─────────────────────────────────────── */

  const actIndexOf = (index: number, total: number): number => {
    if (total <= 1) return 0;
    const t = index / Math.max(1, total - 1);
    let acc = 0;
    for (let i = 0; i < ACT_WEIGHTS.length; i += 1) {
      acc += ACT_WEIGHTS[i]!;
      if (t < acc || i === ACT_WEIGHTS.length - 1) return i;
    }
    return ACT_WEIGHTS.length - 1;
  };

  const compile = (next: PvSong | null): void => {
    song = next;
    lines = [];
    actNow = -1;
    if (!next) return;
    const raw = [...next.lines].sort((a, b) => a.timeMs - b.timeMs);
    const models: Array<{ startMs: number; endMs: number; text: string; translation: string; chars: CharInfo[] }> = [];
    raw.forEach((line, i) => {
      const text = line.text.replace(/\s+/g, ' ').trim();
      if (!text) return;
      const end = i + 1 < raw.length
        ? Math.max(line.timeMs + 420, raw[i + 1]!.timeMs)
        : line.timeMs + Math.max(2400, line.durationMs || 0);
      const src = line.words.length
        ? line.words
        : Array.from(text).map((ch, j) => {
          const span = Math.max(150, (line.durationMs || 2400) / Math.max(1, text.length));
          return { text: ch, startMs: line.timeMs + j * span, endMs: line.timeMs + (j + 1) * span };
        });
      const chars: CharInfo[] = [];
      for (const word of src) {
        const wordChars = Array.from(word.text);
        const span = (word.endMs - word.startMs) / Math.max(1, wordChars.length);
        wordChars.forEach((ch, j) => {
          chars.push({ ch, startMs: word.startMs + span * j });
        });
      }
      if (chars.length === 0) return;
      models.push({ startMs: line.timeMs, endMs: end, text, translation: line.translation ?? '', chars });
    });
    // 镜号分配：同一幕里避免连续撞版。
    let prevLayout: LayoutId | null = null;
    let prevPrev: LayoutId | null = null;
    lines = models.map((model, index) => {
      const act = actIndexOf(index, models.length);
      const pool = ACTS[act]!.layouts;
      const seed = hash32(model.text, index, act);
      let layout = pool[seed % pool.length]!;
      if (layout === prevLayout && prevLayout === prevPrev && pool.length > 1) {
        layout = pool[(seed + 1) % pool.length]!;
      } else if (layout === prevLayout && pool.length > 2) {
        layout = pool[(seed + 1) % pool.length]!;
      }
      prevPrev = prevLayout;
      prevLayout = layout;
      const enters = ENTERS[layout] ?? ['pop'];
      const enter = enters[hash32('e', seed, layout) % enters.length]!;
      const rawTrans = ACTS[act]!.transitions;
      // 大多数换句仍是硬切；只有转场强度打开、且这一镜轮到转场时才用图形转场。
      const roll = hash32('t', seed) % 100;
      const wanted = settings.transitions > 0.02 && roll < 34 + settings.transitions * 24;
      const transition = wanted ? rawTrans[hash32('tx', seed) % rawTrans.length]! : 'cut';
      const tilt = settings.tilt > 0 ? ((hash32('r', seed) % 1000) / 1000 - 0.5) * 0.06 * settings.tilt : 0;
      return { ...model, layout, enter, transition, tilt };
    });
  };

  /* ── 幕 ─────────────────────────────────────────────────── */

  /** 按当前时间落在第几句，再折算到幕。 */
  const actIndexAt = (now: number): number => {
    if (lines.length === 0) return 0;
    let index = 0;
    for (let i = 0; i < lines.length; i += 1) if (lines[i]!.startMs <= now) index = i;
    return actIndexOf(index, lines.length);
  };

  const skinFor = (li: number): Skin => {
    if (settings.palette === 'arc') return ACTS[actIndexOf(li, lines.length)]!.skin;
    const table = PINNED[settings.palette] ?? PINNED.navy!;
    return table[li % table.length] ?? SK_NAVY;
  };

  const fontFor = (li: number): FontKind => {
    if (settings.palette === 'arc') return ACTS[actIndexOf(li, lines.length)]!.font;
    if (settings.palette === 'red') return 'brush';
    return 'mincho';
  };

  /* ── 时间轴 ─────────────────────────────────────────────── */

  interface Flow { flow: number; index: number; t: number; span: number }

  const flowAt = (now: number): Flow => {
    let index = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]!.startMs <= now) index = i;
      else break;
    }
    if (index < 0) return { flow: 0, index: 0, t: 0, span: 0 };
    const next = lines[index + 1];
    if (!next) return { flow: index, index, t: 0, span: 0 };
    const gap = Math.max(240, next.startMs - lines[index]!.startMs);
    // 硬切是 90% 的换句；有转场时给转场留一点时间，画面前后都是同一构图。
    const span = clamp(gap * 0.26, 220, 520) * clamp(0.5 + settings.transitions * 0.5, 0.5, 1.25);
    const from = next.startMs - span;
    const t = now <= from ? 0 : smoother(clamp((now - from) / span));
    return { flow: index + t, index, t, span };
  };

  /* ── 字宽缓存 ───────────────────────────────────────────── */

  const BASE_PX = 200;
  const advanceCache = new Map<string, number>();

  const advanceOf = (ch: string, kind: FontKind, px: number): number => {
    if (ch === ' ' || ch === '　') return px * 0.32;
    const key = `${kind}|${ch}`;
    let base = advanceCache.get(key);
    if (base === undefined) {
      if (!measure) base = BASE_PX * 0.9;
      else {
        measure.font = fontOf(kind, BASE_PX);
        base = Math.min(BASE_PX * 1.1, Math.max(BASE_PX * 0.12, measure.measureText(ch).width));
      }
      advanceCache.set(key, base);
    }
    return (base * px) / BASE_PX;
  };

  /**
   * 字身框装不下的墨迹：明朝/手写的飞白、假名的撇捺经常探出 advance 之外。
   * 排版只按 advance 算宽度时巨字会悄悄顶到画边，所以额外记下左右两边各多出多少。
   */
  const inkCache = new Map<string, { l: number; r: number }>();
  const inkOf = (ch: string, kind: FontKind): { l: number; r: number } => {
    const key = `${kind}|${ch}`;
    const hit = inkCache.get(key);
    if (hit) return hit;
    let l = 0;
    let r = 0;
    if (measure) {
      measure.font = fontOf(kind, BASE_PX);
      const m = measure.measureText(ch);
      const left = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0;
      const right = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : m.width;
      l = Math.max(0, -left);
      r = Math.max(0, right - m.width);
    }
    const box = { l, r };
    inkCache.set(key, box);
    return box;
  };

  /** 一行真正占的宽度（advance + 两端多出来的墨）。 */
  const inkWidth = (model: LineModel, kind: FontKind, size: number, tracking = 0): number => {
    const w = rowWidth(model, kind, size, tracking);
    const first = model.chars[0];
    const last = model.chars[model.chars.length - 1];
    if (!first || !last) return w;
    return w + ((inkOf(first.ch, kind).l + inkOf(last.ch, kind).r) * size) / BASE_PX;
  };

  /* ── 绘制基础 ───────────────────────────────────────────── */

  type G = CanvasRenderingContext2D;

  const rect = (g: G, x: number, y: number, w: number, h: number, color: string, alpha = 1): void => {
    if (alpha <= 0.004) return;
    g.save();
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
    g.restore();
  };

  /** 绕中心旋转的色块/纸片。 */
  const plate = (g: G, cx: number, cy: number, w: number, h: number, rot: number, color: string, alpha = 1): void => {
    if (alpha <= 0.004) return;
    g.save();
    g.globalAlpha = alpha;
    g.translate(cx, cy);
    g.rotate(rot);
    g.fillStyle = color;
    g.fillRect(-w / 2, -h / 2, w, h);
    g.restore();
  };

  /** 硬投影（不虚化，offset 6–10px）：纸片像贴在底上。 */
  const shadowPlate = (g: G, cx: number, cy: number, w: number, h: number, rot: number, alpha: number): void => {
    if (alpha <= 0.004) return;
    const off = Math.max(5, Math.min(11, Math.min(width, height) * 0.008));
    g.save();
    g.globalAlpha = 0.24 * alpha;
    g.translate(cx + off, cy + off);
    g.rotate(rot);
    g.fillStyle = '#000000';
    g.fillRect(-w / 2, -h / 2, w, h);
    g.restore();
  };

  const circle = (g: G, cx: number, cy: number, r: number, color: string, alpha = 1): void => {
    if (alpha <= 0.004 || r <= 0) return;
    g.save();
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };

  const ring = (g: G, cx: number, cy: number, r: number, lw: number, color: string, alpha = 1): void => {
    if (alpha <= 0.004 || r <= 0) return;
    g.save();
    g.globalAlpha = alpha;
    g.strokeStyle = color;
    g.lineWidth = lw;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  };

  const line = (g: G, x1: number, y1: number, x2: number, y2: number, lw: number, color: string, alpha = 1): void => {
    if (alpha <= 0.004) return;
    g.save();
    g.globalAlpha = alpha;
    g.strokeStyle = color;
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
    g.restore();
  };

  const micro = (g: G, text: string, x: number, y: number, px: number, color: string, align: CanvasTextAlign = 'left', alpha = 0.8): void => {
    if (!text || alpha <= 0.01) return;
    g.save();
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.font = fontOf('mono', px);
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.fillText(text, x, y);
    g.restore();
  };

  /** 竖排小字（报刊栏、说明页用）。没有 CJK 的串退回横排，避免英文被转 90°。 */
  const vertical = (g: G, text: string, x: number, y: number, px: number, color: string, alpha = 0.8, gap = 1.18): void => {
    if (!text) return;
    const cjk = /[぀-ヿ㐀-鿿]/.test(text);
    if (!cjk) {
      micro(g, text.slice(0, 24), x, y, px, color, 'left', alpha);
      return;
    }
    g.save();
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.font = fontOf('mono', px);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    Array.from(text).slice(0, 30).forEach((ch, i) => g.fillText(ch, x, y + i * px * gap));
    g.restore();
  };

  const withClip = (g: G, x: number, y: number, w: number, h: number, draw: () => void): void => {
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    draw();
    g.restore();
  };

  /* ── 字 ─────────────────────────────────────────────────── */

  interface Place { x: number; y: number; size: number; rot: number; index: number }

  const charState = (model: LineModel, j: number, now: number): { p: number; sung: boolean; hot: boolean } => {
    const ch = model.chars[j]!;
    const next = model.chars[j + 1];
    const p = clamp((stepped(now) - ch.startMs) / (STEP * 2));
    const hot = now >= ch.startMs && (!next || now < next.startMs);
    return { p, sung: now >= ch.startMs, hot };
  };

  interface PaintOptions {
    /** 未唱到的字的透明度 */
    unsung?: number;
    /** 重音色（默认取主字色） */
    hotColor?: string;
    /** 空心：唱到之前只描边，唱到之后填实 */
    outline?: boolean;
    /** 手写感的逐字抖动幅度（相对字号） */
    jitter?: number;
    /** 每个字的独立旋转（手写墙用） */
    wobble?: number;
  }

  /**
   * 画一串字。字色按「未唱 → 已唱 → 正在唱」三档；hotColor 给正在唱的字。
   * 未唱到的字只留极淡的形，正在唱的那个字取重音色并轻轻顶一下。
   */
  const paintChars = (
    g: G,
    model: LineModel,
    places: Place[],
    kind: FontKind,
    color: string,
    now: number,
    opts: PaintOptions = {},
  ): void => {
    const hot = opts.hotColor ?? color;
    const seed = hash32('c', model.text);
    const fontCache = new Map<number, string>();
    for (const place of places) {
      const ch = model.chars[place.index];
      if (!ch || ch.ch === ' ') continue;
      const st = charState(model, place.index, now);
      const alpha = st.sung ? lerp(0.5, 1, clamp(st.p * 1.5)) : (opts.unsung ?? 0.12);
      if (alpha <= 0.004) continue;
      let font = fontCache.get(place.size);
      if (!font) {
        font = fontOf(kind, place.size);
        fontCache.set(place.size, font);
      }
      const wob = (opts.wobble ?? 0) * ((hash32(seed, place.index) % 1000) / 1000 - 0.5);
      const jit = (opts.jitter ?? 0) * place.size * ((hash32(seed, place.index, 7) % 1000) / 1000 - 0.5);
      g.save();
      g.translate(place.x + jit * 0.3, place.y + jit);
      g.rotate(place.rot + wob);
      g.globalAlpha = Math.min(1, alpha);
      g.fillStyle = st.hot ? hot : color;
      g.strokeStyle = st.hot ? hot : color;
      g.font = font;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      if (st.hot) {
        const pop = 1 + 0.05 * (1 - clamp(st.p));
        g.scale(pop, pop);
      }
      if (opts.outline) {
        // 空心字：唱到之前只有描边，唱到之后填实（"描边生长"）。
        g.lineWidth = lerp(0.6, Math.max(1.2, place.size * 0.014), clamp(st.p));
        if (st.p >= 1) g.fillText(ch.ch, 0, 0);
        g.strokeText(ch.ch, 0, 0);
      } else {
        g.fillText(ch.ch, 0, 0);
      }
      g.restore();
    }
  };

  /** 沿一行的位置（左起，带字距）。 */
  const layoutRow = (model: LineModel, kind: FontKind, size: number, startX: number, y: number, rot: number, tracking = 0): Place[] => {
    const places: Place[] = [];
    let x = startX;
    model.chars.forEach((ch, j) => {
      const adv = advanceOf(ch.ch, kind, size);
      places.push({ x: x + adv / 2, y, size, rot, index: j });
      x += adv + tracking;
    });
    return places;
  };

  const rowWidth = (model: LineModel, kind: FontKind, size: number, tracking = 0, from = 0, to = model.chars.length): number => {
    let total = 0;
    for (let j = from; j < to; j += 1) {
      const ch = model.chars[j];
      if (!ch) break;
      total += advanceOf(ch.ch, kind, size) + tracking;
    }
    return Math.max(0, total - tracking);
  };

  /** 字数太多时整行等比缩到可用宽度内（PV 的做法是宁愿缩小也不换行）。 */
  const fitSize = (model: LineModel, kind: FontKind, size: number, avail: number): number => {
    // 1.02 给 tilt 与「正在唱的字的 1.05 顶出」留一点余量。
    const natural = inkWidth(model, kind, size) * 1.02;
    return natural > avail && natural > 0 ? (avail / natural) * size : size;
  };

  /* ── 入场 ───────────────────────────────────────────────── */

  /** 页面落定后，第 slot 个装饰元素登场（2 格起、1.6 格淡入）。 */
  const reveal = (model: LineModel, slot: number, now: number): number => {
    const t0 = model.startMs + slot * STEP * 1.6;
    return smoother(clamp((now - t0) / (STEP * 1.6)));
  };

  interface EnterState { dx: number; dy: number; s: number; rot: number; a: number; clipW: number }
  const enterState = (model: LineModel, now: number): EnterState => {
    const raw = clamp((stepped(now) - model.startMs) / (STEP * 3.2));
    const e = easeOut(raw);
    const base: EnterState = { dx: 0, dy: 0, s: 1, rot: 0, a: 1, clipW: 1 };
    switch (model.enter) {
      case 'slide': return { ...base, dx: (1 - e) * width * 0.4, rot: (1 - e) * (model.tilt + 0.035), a: clamp(raw * 2) };
      case 'pop': return { ...base, s: lerp(0.9, 1, backOut(raw)), a: clamp(raw * 2.4) };
      case 'slam': return { ...base, s: lerp(1.42, 1, backOut(raw)), a: clamp(raw * 3) };
      case 'drop': return { ...base, dy: -(1 - e) * height * 0.3, a: clamp(raw * 2) };
      case 'iris': return { ...base, clipW: smoother(clamp(raw * 0.9)) };
      case 'stretch': return { ...base, dx: (1 - e) * -width * 0.18, a: clamp(raw * 2) };
      case 'bars': return { ...base, clipW: smoother(clamp(raw)) };
      case 'write': return { ...base, clipW: smoother(clamp(raw * 0.8)) };
      case 'wipe': return { ...base, clipW: smoother(clamp(raw * 0.8)) };
      case 'spin': return { ...base, rot: (1 - e) * Math.PI * 0.5, s: lerp(0.7, 1, e), a: clamp(raw * 2) };
      default: return base;
    }
  };

  /** 把整镜的入场变换套到绘制上；wipe/bars/iris 这类再用形状裁剪。 */
  const withEnter = (model: LineModel, now: number, draw: () => void): void => {
    const g = ctx;
    const st = enterState(model, now);
    g.save();
    g.translate(width / 2 + st.dx, height / 2 + st.dy);
    g.rotate(st.rot);
    g.scale(st.s, st.s);
    g.translate(-width / 2, -height / 2);
    g.globalAlpha = st.a;
    if (st.clipW < 0.999) {
      g.beginPath();
      if (model.enter === 'iris') {
        const r = Math.hypot(width, height) * 0.5 * st.clipW;
        g.arc(width / 2, height / 2, r, 0, Math.PI * 2);
      } else if (model.enter === 'bars') {
        const hh = height * clamp(st.clipW * 1.2);
        g.rect(0, (height - hh) / 2, width, hh);
      } else {
        g.rect(0, 0, width * st.clipW, height);
      }
      g.clip();
    }
    draw();
    g.restore();
  };

  /* ── 版面 ───────────────────────────────────────────────── */

  const baseSize = (): number => Math.min(height * 0.3, width * 0.17) * settings.sizeScale;

  /** 印刷物的角标：四个角的裁切标记。 */
  const furniture = (g: G, skin: Skin, a = 1): void => {
    const m = Math.min(width, height) * 0.035;
    const len = Math.min(width, height) * 0.05;
    g.save();
    g.globalAlpha = 0.3 * a;
    g.strokeStyle = skin.ink;
    g.lineWidth = 1;
    const corners: Array<[number, number, number, number]> = [
      [m, m, 1, 1], [width - m, m, -1, 1], [m, height - m, 1, -1], [width - m, height - m, -1, -1],
    ];
    for (const [x, y, sx, sy] of corners) {
      g.beginPath();
      g.moveTo(x, y + len * sy);
      g.lineTo(x, y);
      g.lineTo(x + len * sx, y);
      g.stroke();
    }
    g.restore();
  };

  const ticks = (g: G, x: number, y: number, count: number, step: number, len: number, color: string, alpha: number): void => {
    if (alpha <= 0.01) return;
    g.save();
    g.globalAlpha = alpha;
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < count; i += 1) {
      g.moveTo(x + i * step, y);
      g.lineTo(x + i * step, y + len);
    }
    g.stroke();
    g.restore();
  };

  const hatch = (g: G, x: number, y: number, w: number, h: number, color: string, gap: number, alpha: number): void => {
    if (alpha <= 0.01) return;
    withClip(g, x, y, w, h, () => {
      g.save();
      g.globalAlpha = alpha;
      g.strokeStyle = color;
      g.lineWidth = 1.4;
      g.beginPath();
      for (let i = -h; i < w + h; i += gap) {
        g.moveTo(x + i, y + h);
        g.lineTo(x + i + h, y);
      }
      g.stroke();
      g.restore();
    });
  };

  /** ① 居中大字：一个字占 40–70% 画面，四周全空。 */
  const layoutCenterBig = (model: LineModel, skin: Skin, kind: FontKind, now: number): void => {
    const g = ctx;
    const size = fitSize(model, kind, baseSize() * 1.55, width * 0.9);
    const w = rowWidth(model, kind, size);
    const y = height * 0.53;
    paintChars(g, model, layoutRow(model, kind, size, (width - w) / 2, y, model.tilt), kind, skin.ink, now, { hotColor: skin.accent });
    if (model.chars.length <= 4) {
      const a = reveal(model, 1, now);
      const x0 = width / 2 - w * 0.62;
      const x1 = width / 2 + w * 0.62;
      line(g, x0, y + size * 0.62, x1, y + size * 0.62, 1.2, skin.ink, 0.38 * a);
      ticks(g, x0, y + size * 0.66, 18, Math.max(8, (x1 - x0) / 18), 9, skin.ink, 0.3 * a);
    }
  };

  /** ② 满版字墙：同一句重复书写铺满全屏，一条重音色带横穿。 */
  const layoutTypeWall = (model: LineModel, skin: Skin, kind: FontKind, now: number): void => {
    const g = ctx;
    const kind2: FontKind = kind === 'mincho' ? 'brush' : kind;
    const rows = 6;
    const size = Math.max(height * 0.1, baseSize() * 0.62);
    const rowH = height / rows;
    const drift = Math.sin(stepped(now) * 0.0004) * width * 0.05;
    const w = Math.max(1, rowWidth(model, kind2, size));
    const repeat = Math.max(1, Math.ceil((width * 1.3) / w));
    for (let r = 0; r < rows; r += 1) {
      const a = reveal(model, r, now);
      if (a <= 0.01) continue;
      const rot = model.tilt * 1.6 + (r % 2 === 0 ? -0.03 : 0.02);
      g.save();
      g.globalAlpha = a * (r === 2 || r === 3 ? 0.95 : 0.42);
      for (let k = 0; k < repeat; k += 1) {
        const x = ((r * 73 + k * 61) % Math.max(1, Math.round(width * 0.5))) - width * 0.2 + drift * (r % 2 === 0 ? 1 : -1);
        const places = layoutRow(model, kind2, size, x, rowH * (r + 0.5), rot);
        paintChars(g, model, places, kind2, skin.ink, now, { hotColor: skin.accent, unsung: 0.1, jitter: 0.03, wobble: 0.05 });
      }
      g.restore();
    }
    // 一条横穿的色带（原片这里常用重音色）。
    const bandA = reveal(model, 1, now);
    plate(g, width / 2, height * 0.5, width * 1.2, height * 0.13, model.tilt * 0.6, skin.accent, 0.9 * bandA);
  };

  /** ③ 卡片桌：多张纸卡散落在底色上，轻微旋转 + 硬投影，字竖排写在卡里。 */
  const layoutCardTable = (model: LineModel, skin: Skin, kind: FontKind, now: number): void => {
    const g = ctx;
    const total = model.chars.length;
    const cardCount = clamp(Math.ceil(total / 3), 1, 4);
    const per = Math.ceil(total / cardCount);
    const cardW = Math.min(width * 0.3, (width * 0.78) / cardCount);
    const cardH = height * 0.44;
    const size = Math.min(cardW * 0.42, (cardH * 0.86) / Math.max(1, per));
    for (let c = 0; c < cardCount; c += 1) {
      const a = reveal(model, c, now);
      if (a <= 0.01) continue;
      const slide = (1 - a) * width * 0.3;
      const cx = width * 0.5 + (c - (cardCount - 1) / 2) * (cardW + width * 0.035) + slide;
      const cy = height * 0.5 + (c % 2 === 0 ? -1 : 1) * height * 0.045;
      const rot = (c % 2 === 0 ? -1 : 1) * 0.035 + model.tilt * 0.5;
      shadowPlate(g, cx, cy, cardW, cardH, rot, a);
      plate(g, cx, cy, cardW, cardH, rot, skin.panel, a);
      const from = c * per;
      const to = Math.min(total, from + per);
      const places: Place[] = [];
      const colH = (to - from) * size * 1.06;
      for (let j = from; j < to; j += 1) {
        places.push({ x: cx, y: cy - colH / 2 + (j - from) * size * 1.06 + size * 0.5, size, rot, index: j });
      }
      paintChars(g, model, places, kind, skin.panelInk, now, { hotColor: skin.accent, unsung: 0.2 });
    }
  };

  /** ④ 圆与环：大圆/圆环做遮罩，字被圈在环心，环持续旋转。 */
  const layoutRing = (model: LineModel, skin: Skin, kind: FontKind, now: number): void => {
    const g = ctx;
    const r = Math.min(width, height) * 0.28;
    const cx = width * 0.5;
    const cy = height * 0.5;
    const a = reveal(model, 0, now);
    circle(g, cx, cy, r * lerp(0.7, 1, a), skin.panel, 0.96 * a);
    g.save();
    g.translate(cx, cy);
    g.rotate(now * 0.00018);
    g.globalAlpha = 0.9 * a;
    g.strokeStyle = skin.ink;
    g.lineWidth = r * 0.16;
    g.beginPath();
    g.arc(0, 0, r * 1.24, 0.4, Math.PI * 1.7);
    g.stroke();
    g.restore();
    const count = model.chars.length;
    const perRow = count <= 3 ? count : Math.ceil(count / Math.min(3, Math.ceil(count / 3)));
    const rows = Math.ceil(count / perRow);
    const size = Math.min(r * 0.78, (r * 1.2) / Math.max(1, Math.ceil(Math.sqrt(count))));
    const places: Place[] = [];
    for (let j = 0; j < count; j += 1) {
      const rIdx = Math.floor(j / perRow);
      const cIdx = j % perRow;
      const inRow = Math.min(perRow, count - rIdx * perRow);
      places.push({
        x: cx + (cIdx - (inRow - 1) / 2) * size * 1.06,
        y: cy + (rIdx - (rows - 1) / 2) * size * 1.06,
        size,
        rot: 0,
        index: j,
      });
    }
    paintChars(g, model, places, kind, skin.panelInk, now, { hotColor: skin.accent, unsung: 0.22 });
  };

  /** ⑤ 空心字：描边生长，唱到才填实。 */
  const layoutOutlined = (model: LineModel, skin: Skin, kind: FontKind, now: number): void => {
    const g = ctx;
    const size = fitSize(model, kind, baseSize() * 1.2, width * 0.86);
    const w = rowWidth(model, kind, size);
    const y = height * 0.5;
    paintChars(g, model, layoutRow(model, kind, size, (width - w) / 2, y, model.tilt * 0.6), kind, skin.ink, now, {
      hotColor: skin.accent,
      outline: true,
      unsung: 0.5,
    });
    const a = reveal(model, 1, now);
    hatch(g, width * 0.06, height * 0.12, width * 0.14, height * 0.09, skin.ink, 7, 0.3 * a);
    ticks(g, width * 0.06, height * 0.84, 20, 10, 9, skin.ink, 0.32 * a);
  };

  /** ⑥ 斜切带：整屏被一条斜带切开，字沿斜带排。 */
  const layoutDiagonal = (model: LineModel, skin: Skin, kind: FontKind, now: number): void => {
    const g = ctx;
    const rot = -0.16 + model.tilt;
    const bandH = height * 0.34;
    const a = reveal(model, 0, now);
    const wipe = smoother(clamp((stepped(now) - model.startMs) / (STEP * 4)));
    g.save();
    g.translate(width / 2, height * 0.5);
    g.rotate(rot);
    plate(g, 0, 0, width * 1.5, bandH, 0, skin.accent, 0.94 * a);
    plate(g, 0, -bandH / 2 + 2, width * 1.5, 5, 0, skin.ink, 0.85 * a);
    g.restore();
    const size = fitSize(model, kind, baseSize() * 1.02, width * 0.8);
    const w = rowWidth(model, kind, size);
    const places = layoutRow(model, kind, size, width / 2 - w / 2, height * 0.5 + (1 - wipe) * height * 0.06, rot);
    paintChars(g, model, places, kind, skin.panelInk, now, { hotColor: skin.bg, unsung: 0.24 });
    if (a > 0.5) {
      plate(g, width * (0.18 + 0.06 * Math.sin(model.tilt * 40)), height * 0.82, size * 0.34, size * 0.2, model.tilt, skin.accent, 0.7);
    }
  };

  /** ⑦ 条带：横条从两侧推入，字嵌在条里。 */
  const layoutBars = (model: LineModel, skin: Skin, kind: FontKind, now: number): void => {
    const g = ctx;
    const count = clamp(Math.ceil(model.chars.length / 2), 1, 3);
    const per = Math.ceil(model.chars.length / count);
    const byWidth = fitSize(model, kind, baseSize() * 0.9, width * 0.9);
    // 竖着叠几条时也要能被画面高度兜住，否则最上/最下一条会顶出画外。
    const byHeight = (height * 0.86) / (1.42 * (1 + 1.2 * (count - 1)));
    const size = Math.min(byWidth, byHeight);
    const barH = size * 1.42;
    for (let k = 0; k < count; k += 1) {
      const a = reveal(model, k, now);
      if (a <= 0.01) continue;
      const y = height * 0.5 + (k - (count - 1) / 2) * barH * 1.2;
      const from = k * per;
      const to = Math.min(model.chars.length, from + per);
      const w = rowWidth(model, kind, size, 0, from, to);
      const dir = k % 2 === 0 ? -1 : 1;
      const x0 = width / 2 - w / 2 + (1 - a) * width * 0.5 * dir;
      plate(g, x0 + w / 2, y, w + size * 0.9, barH, 0, k % 2 === 0 ? skin.panel : skin.accent, a);
      const places: Place[] = [];
      for (let j = from; j < to; j += 1) {
        places.push({ x: x0 + rowWidth(model, kind, size, 0, from, j) + advanceOf(model.chars[j]!.ch, kind, size) / 2, y, size, rot: 0, index: j });
      }
      paintChars(g, model, places, kind, k % 2 === 0 ? skin.panelInk : skin.bg, now, { hotColor: skin.panelInk, unsung: 0.22 });
    }
  };

  /** ⑧ 报刊竖栏：暗-亮-暗三条竖栏，字压在中间栏里，右侧一列微小竖排歌词。 */
  const layoutColumns = (model: LineModel, skin: Skin, kind: FontKind, now: number): void => {
    const g = ctx;
    const colW = width / 3;
    plate(g, colW / 2, height / 2, colW, height, 0, skin.bg, 1);
    plate(g, colW * 1.5, height / 2, colW, height, 0, skin.panel, 1);
    plate(g, colW * 2.5, height / 2, colW, height, 0, skin.bg, 1);
    const cx = colW * 1.5;
    const count = model.chars.length;
    const size = Math.min(colW * 0.46, (height * 0.62) / Math.max(1, count));
    const gap = size * 1.24;
    const top = height * 0.5 - ((count - 1) * gap) / 2;
    const a = reveal(model, 0, now);
    // 细黑框从细长成（scale Y）。
    const boxH = Math.min(height * 0.8, count * gap + size * 1.2) * smoother(clamp(a * 1.2));
    if (boxH > 4) {
      g.save();
      g.globalAlpha = 0.9;
      g.strokeStyle = skin.panelInk;
      g.lineWidth = 1.4;
      g.strokeRect(cx - size * 1.1, height * 0.5 - boxH / 2, size * 2.2, boxH);
      g.restore();
    }
    const places: Place[] = [];
    for (let j = 0; j < count; j += 1) {
      const drop = (1 - reveal(model, 1 + (count - j), now)) * -height * 0.06;
      places.push({ x: cx, y: top + j * gap + drop, size, rot: 0, index: j });
    }
    paintChars(g, model, places, kind, skin.panelInk, now, { hotColor: skin.accent, unsung: 0.26 });
    // 两侧栏的微小竖排（像一路被慢慢拉动的报纸栏）
    const drift = (now * 0.012) % 40;
    for (let c = 0; c < 3; c += 1) {
      vertical(g, `${song?.title ?? ''} ${model.text}`, colW * 2.5 + c * colW * 0.16, height * 0.18 - drift + c * 12, 9, skin.soft, 0.5);
    }
    vertical(g, song?.artist ?? '', colW * 0.5, height * 0.2, 9, skin.soft, 0.45);
    micro(g, `NO.${String(count).padStart(2, '0')}`, cx, height * 0.9, 9, skin.soft, 'center', 0.5);
  };

  /** ⑨ 画框：方块转成画框，字在框内；底层一行巨字从下往上压入。 */
  const layoutFrame = (model: LineModel, skin: Skin, kind: FontKind, now: number): void => {
    const g = ctx;
    const raw = clamp((stepped(now) - model.startMs) / (STEP * 6));
    // 方块 0°→45°→90° 并放大，末段填充变描边（"方块转成画框"）。
    const phase = smoother(raw);
    const rot = phase <= 0.55 ? lerp(0, Math.PI / 4, phase / 0.55) : lerp(Math.PI / 4, Math.PI / 2, (phase - 0.55) / 0.45);
    const frameW = Math.min(width * 0.72, height * 1.05) * lerp(0.42, 1, phase);
    const frameH = Math.min(height * 0.62, width * 0.58) * lerp(0.5, 1, phase);
    shadowPlate(g, width / 2, height / 2, frameW, frameH, rot * 0.2, clamp(raw * 2));
    if (phase < 0.86) {
      plate(g, width / 2, height / 2, frameW, frameH, rot * 0.2, skin.panel, 1);
    } else {
      g.save();
      g.strokeStyle = skin.panel;
      g.lineWidth = Math.max(3, Math.min(frameW, frameH) * 0.055);
      g.strokeRect(width / 2 - frameW / 2, height / 2 - frameH / 2, frameW, frameH);
      g.restore();
    }
    // 框里的竖条 + 竖排字
    const stripW = frameW * 0.3;
    const stripA = phase > 0.86 ? 0.96 : 0;
    plate(g, width / 2, height / 2, stripW, frameH * 0.86, 0, skin.panelInk, stripA);
    const count = model.chars.length;
    const size = Math.min(stripW * 0.46, (frameH * 0.78) / Math.max(1, count));
    const gap = size * 1.1;
    const top = height / 2 - ((count - 1) * gap) / 2;
    const places: Place[] = [];
    for (let j = 0; j < count; j += 1) places.push({ x: width / 2, y: top + j * gap, size, rot: 0, index: j });
    paintChars(g, model, places, kind, skin.panel, now, { hotColor: skin.accent, unsung: 0.2 });
    // 底层巨字从下往上压入
    const bgA = reveal(model, 2, now);
    if (bgA > 0.02) {
      const bgKind: FontKind = 'brush';
      const bgSize = height * 0.3;
      const bw = rowWidth(model, bgKind, bgSize);
      g.save();
      g.globalAlpha = 0.6 * bgA;
      paintChars(g, model, layoutRow(model, bgKind, bgSize, width / 2 - bw / 2, height * 0.86 + (1 - bgA) * height * 0.2, 0), bgKind, skin.ink, now, { unsung: 0.4 });
      g.restore();
    }
  };

  /** ⑩ 对撞叠印：两半字相向撞在一起。 */
  const layoutCollision = (model: LineModel, skin: Skin, kind: FontKind, now: number): void => {
    const g = ctx;
    const size = fitSize(model, kind, baseSize() * 1.3, width * 0.8);
    const mid = Math.ceil(model.chars.length / 2);
    const leftW = rowWidth(model, kind, size, 0, 0, mid);
    const leftPlaces = layoutRow(model, kind, size, width / 2 - leftW, height * 0.5, model.tilt).filter((p) => p.index < mid);
    const rightPlaces = layoutRow(model, kind, size, width / 2, height * 0.5, model.tilt).filter((p) => p.index >= mid);
    const push = (1 - smoother(clamp((stepped(now) - model.startMs) / (STEP * 4)))) * width * 0.16;
    const shift = (places: Place[], dx: number): Place[] => places.map((p) => ({ ...p, x: p.x + dx }));
    paintChars(g, model, shift(leftPlaces, -push), kind, skin.ink, now, { hotColor: skin.accent });
    paintChars(g, model, shift(rightPlaces, push), kind, skin.ink, now, { hotColor: skin.accent });
  };

  /** ⑪ 说明页：近白大空屏，正中一行小字，极慢淡入。 */
  const layoutMicro = (model: LineModel, skin: Skin, kind: FontKind, now: number): void => {
    const g = ctx;
    const a = smoother(clamp((stepped(now) - model.startMs) / (STEP * 8)));
    const size = Math.min(baseSize() * 0.42, (width * 0.4) / Math.max(1, model.chars.length));
    const w = rowWidth(model, kind, size);
    if (a > 0.01) {
      g.save();
      g.globalAlpha = a;
      paintChars(g, model, layoutRow(model, kind, size, width / 2 - w / 2, height * 0.5, model.tilt * 0.4), kind, skin.ink, now, {
        hotColor: skin.accent,
        unsung: 0.28,
      });
      g.restore();
    }
    const trans = settings.showTranslation ? (model.translation || '') : '';
    if (trans) micro(g, trans.slice(0, 40), width / 2, height * 0.6, Math.max(9, height * 0.014), skin.soft, 'center', 0.6 * a);
    furniture(g, skin, 0.6 * a);
  };

  /** ⑫ 收尾卡：竖排短句落在白卡上，外面套一圈画框。 */
  const layoutEndCard = (model: LineModel, skin: Skin, kind: FontKind, now: number): void => {
    const g = ctx;
    const center = width * 0.5;
    const cardW = Math.min(width * 0.26, height * 0.36);
    const cardH = height * 0.5;
    const a = reveal(model, 0, now);
    shadowPlate(g, center, height * 0.5, cardW, cardH, model.tilt * 0.5, a);
    plate(g, center, height * 0.5, cardW, cardH, model.tilt * 0.5, skin.panel, a);
    const count = model.chars.length;
    const size = Math.min(cardW * 0.36, (cardH * 0.82) / Math.max(1, count));
    const gap = size * 1.16;
    const top = height * 0.5 - ((count - 1) * gap) / 2;
    const places: Place[] = [];
    for (let j = 0; j < count; j += 1) places.push({ x: center, y: top + j * gap, size, rot: model.tilt * 0.5, index: j });
    paintChars(g, model, places, kind, skin.panelInk, now, { hotColor: skin.accent, unsung: 0.2 });
    const fw = cardW * 1.9;
    const fh = cardH * 1.26;
    g.save();
    g.globalAlpha = 0.85 * reveal(model, 1, now);
    g.strokeStyle = skin.panel;
    g.lineWidth = Math.max(2, cardW * 0.035);
    g.strokeRect(center - fw / 2, height * 0.5 - fh / 2, fw, fh);
    g.restore();
  };

  /* ── 页 ─────────────────────────────────────────────────── */

  const drawPage = (li: number, now: number, dx: number): void => {
    const model = lines[li];
    if (!model) return;
    const g = ctx;
    const skin = skinFor(li);
    const kind = fontFor(li);
    g.save();
    g.translate(dx, 0);
    g.fillStyle = skin.bg;
    g.fillRect(-2, -2, width + 4, height + 4);
    withEnter(model, now, () => {
      switch (model.layout) {
        case 'typeWall': layoutTypeWall(model, skin, kind, now); break;
        case 'cardTable': layoutCardTable(model, skin, kind, now); break;
        case 'ring': layoutRing(model, skin, kind, now); break;
        case 'outlined': layoutOutlined(model, skin, kind, now); break;
        case 'diagonal': layoutDiagonal(model, skin, kind, now); break;
        case 'bars': layoutBars(model, skin, kind, now); break;
        case 'columns': layoutColumns(model, skin, kind, now); break;
        case 'frame': layoutFrame(model, skin, kind, now); break;
        case 'collision': layoutCollision(model, skin, kind, now); break;
        case 'micro': layoutMicro(model, skin, kind, now); break;
        case 'endCard': layoutEndCard(model, skin, kind, now); break;
        default: layoutCenterBig(model, skin, kind, now); break;
      }
    });
    // 译文：左下角一行小字（说明页与竖栏页自己带，别重复）
    const trans = settings.showTranslation ? (model.translation || '') : '';
    if (trans && model.layout !== 'micro' && model.layout !== 'columns') {
      micro(g, trans.slice(0, 44), width * 0.06, height * 0.935, Math.max(10, height * 0.015), skin.soft, 'left', 0.72 * reveal(model, 2, now));
    }
    g.restore();
  };

  /* ── 转场 ───────────────────────────────────────────────── */

  const takeSnapshot = (): void => {
    if (!snapCtx) return;
    if (snap.width !== canvas.width || snap.height !== canvas.height) {
      snap.width = canvas.width;
      snap.height = canvas.height;
    }
    snapCtx.setTransform(1, 0, 0, 1, 0, 0);
    snapCtx.clearRect(0, 0, snap.width, snap.height);
    snapCtx.drawImage(canvas, 0, 0);
  };

  /** 撕裂：把画面切成若干横条，交替左右位移（单帧跳变，不缓动）。 */
  const glitchSlices = (g: G, amount: number, seed: number): void => {
    const bands = 6 + Math.floor(amount * 6);
    const step = canvas.height / bands;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (let b = 0; b < bands; b += 1) {
      const dir = b % 2 === 0 ? 1 : -1;
      const jump = hash32(b, seed) % 100;
      const off = dir * (0.02 + (jump / 100) * 0.18) * amount * canvas.width;
      const sy = Math.round(b * step);
      const sh = Math.ceil(step) + 1;
      g.drawImage(canvas, 0, sy, canvas.width, sh, off, sy, canvas.width, sh);
    }
    g.restore();
  };

  interface TransitionState { id: TransitionId; t: number; seed: number }

  const drawTransition = (state: TransitionState, older: () => void, newer: () => void): void => {
    const g = ctx;
    const t = clamp(state.t);
    switch (state.id) {
      case 'cut':
        if (t < 0.5) older();
        else newer();
        return;
      case 'fade':
        if (t < 0.5) older();
        else {
          newer();
          rect(g, 0, 0, width, height, '#050507', smoother((t - 0.5) * 2));
        }
        return;
      case 'dotline': {
        // 点 → 线 → 圆：白屏上落一点，点拉成细线，线中央鼓起一个圆，圆外变底。
        if (t < 0.35) {
          older();
          circle(g, width / 2, height / 2, 2 + (t / 0.35) * 4, '#141531', 0.9);
          return;
        }
        if (t < 0.62) {
          older();
          const p = (t - 0.35) / 0.27;
          line(g, width / 2 - (width / 2) * p, height / 2, width / 2 + (width / 2) * p, height / 2, 1.4, '#141531', 0.85);
          return;
        }
        {
          newer();
          const p = smoother((t - 0.62) / 0.38);
          const r = Math.hypot(width, height) * 0.5 * p;
          g.save();
          g.beginPath();
          g.rect(0, 0, width, height);
          g.arc(width / 2, height / 2, r, 0, Math.PI * 2, true);
          g.clip();
          older();
          g.restore();
          ring(g, width / 2, height / 2, r, Math.max(2, 6 * (1 - p)), '#141531', 0.9 * (1 - p));
        }
        return;
      }
      case 'barwipe': {
        // 白条从右擦入把画面刷白，停一下再硬切到新页。
        if (t < 0.72) {
          older();
          const bw = width * smoother(t / 0.72);
          plate(g, width - bw / 2, height / 2, bw, height * 1.02, 0, '#F4F2EA', 1);
          return;
        }
        newer();
        return;
      }
      case 'cardsweep': {
        // 一张大白卡从左侧横扫进来盖住旧页，卡面再写出新字。
        const p = smoother(clamp(t / 0.55));
        if (p < 0.995) {
          older();
          const cw = width * 1.05 * p;
          shadowPlate(g, cw / 2, height / 2, cw, height * 1.02, 0, p);
          plate(g, cw / 2, height / 2, cw, height * 1.02, 0, '#F4F2EA', 1);
          return;
        }
        newer();
        return;
      }
      case 'boxrot': {
        // 方块 0°→90° 放大盖住画面，末段变描边成为下一镜的画框。
        if (t < 0.78) {
          older();
          const p = smoother(t / 0.78);
          const size = Math.max(width, height) * lerp(0.24, 1.14, p);
          plate(g, width / 2, height / 2, size, size, lerp(0, Math.PI / 2, p), '#141531', 1);
          return;
        }
        newer();
        const q = smoother((t - 0.78) / 0.22);
        g.save();
        g.globalAlpha = (1 - q) * 0.9;
        g.strokeStyle = '#141531';
        g.lineWidth = Math.max(2, width * 0.01) * (1 - q) + 1;
        g.strokeRect(width * 0.04, height * 0.06, width * 0.92, height * 0.88);
        g.restore();
        return;
      }
      case 'glitch': {
        // 撕裂错位：几帧内横条左右跳，最后落回新页。
        newer();
        const amt = clamp(settings.glitch) * (1 - t);
        if (amt > 0.02) glitchSlices(g, amt, state.seed);
        return;
      }
      default:
        newer();
    }
  };

  /* ── 全局层：手持抖动、颗粒、页眉页脚 ───────────────────── */

  const noise = ((): CanvasPattern | null => {
    const tile = document.createElement('canvas');
    tile.width = 96;
    tile.height = 96;
    const tg = tile.getContext('2d');
    if (!tg) return null;
    const img = tg.createImageData(96, 96);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + Math.random() * 127;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 26 + Math.random() * 40;
    }
    tg.putImageData(img, 0, 0);
    return ctx.createPattern(tile, 'repeat');
  })();

  const drawGrain = (g: G, now: number, skin: Skin): void => {
    if (settings.grain <= 0.01) return;
    const k = clamp(settings.grain, 0, 1.5);
    // 颗粒：整块噪声贴图，每秒跳 8 次（不是每帧，免得像电视雪花）。
    if (noise) {
      g.save();
      g.globalAlpha = 0.05 * k;
      g.globalCompositeOperation = 'overlay';
      const step = Math.floor(now / 125);
      g.translate(((step * 37) % 96) - 96, ((step * 53) % 96) - 96);
      g.fillStyle = noise;
      g.fillRect(0, 0, width + 192, height + 192);
      g.restore();
    }
    // 极细的行扫描线。
    g.save();
    g.globalAlpha = (skin.dark ? 0.07 : 0.045) * k;
    g.fillStyle = skin.dark ? '#FFFFFF' : '#000000';
    for (let y = 0; y < height; y += 3) g.fillRect(0, y, width, 1);
    g.restore();
    // 缓慢下移的一条亮带
    const sweep = ((now * 0.05) % (height + 260)) - 130;
    g.save();
    g.globalAlpha = 0.05 * k;
    const grad = g.createLinearGradient(0, sweep - 90, 0, sweep + 90);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, skin.dark ? 'rgba(255,255,255,1)' : 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, sweep - 90, width, 180);
    g.restore();
  };

  const drawChrome = (g: G, now: number, skin: Skin, fl: Flow): void => {
    if (!settings.showChrome) return;
    const pad = Math.min(width, height) * 0.038;
    const px = Math.max(9, Math.round(height * 0.0135));
    g.save();
    g.globalAlpha = 0.32;
    g.strokeStyle = skin.ink;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(pad, pad + px * 1.9);
    g.lineTo(width - pad, pad + px * 1.9);
    g.stroke();
    g.restore();
    micro(g, 'PV', pad, pad + px * 0.8, px + 1, skin.accent, 'left', 0.9);
    micro(g, (song?.title ?? '').slice(0, 30), width - pad, pad + px * 0.8, px, skin.soft, 'right', 0.7);
    const pos = Math.max(0, Math.floor(now / 1000));
    micro(g, `${String(Math.floor(pos / 60)).padStart(2, '0')}:${String(pos % 60).padStart(2, '0')}`, width - pad, height - pad, px, skin.soft, 'right', 0.6);
    micro(g, `${String(Math.floor(fl.flow) + 1).padStart(2, '0')} / ${String(lines.length).padStart(2, '0')}`, pad, height - pad, px, skin.soft, 'left', 0.55);
  };

  /* ── 帧 ─────────────────────────────────────────────────── */

  /** 把世界变换挂好（手持抖动 + 倾斜 + 3% 出血），供页面与转场共用。 */
  const enterWorld = (g: G, jx: number, jy: number, tilt: number): void => {
    g.save();
    g.translate(width / 2 + jx, height / 2 + jy);
    g.rotate(tilt);
    g.scale(1.03, 1.03);
    g.translate(-width / 2, -height / 2);
    g.beginPath();
    g.rect(-width * 0.02, -height * 0.02, width * 1.04, height * 1.04);
    g.clip();
  };

  const frame = (now: number, energy: number, playing: boolean): void => {
    if (width <= 0 || height <= 0) return;
    energyNow = clamp(energy);
    playingNow = playing;
    const g = ctx;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, height);

    const act = actIndexAt(now);
    if (act !== actNow) {
      actNow = act;
      options.onAct?.(act);
    }

    const fl = flowAt(now);
    const base = Math.floor(fl.flow);
    const curModel = lines[base];
    const nextModel = lines[fl.index + 1];
    const skinUse = curModel ? skinFor(base) : ACTS[0]!.skin;
    g.fillStyle = skinUse.bg;
    g.fillRect(0, 0, width, height);

    // 手持抖动 + 倾斜：前后两页共用同一个变换，转场时才不会"两层各抖各的"。
    const jitterAmp = settings.tilt * (1 + energyNow * 1.6) * 0.9;
    const jx = Math.sin(now * 0.0021) * jitterAmp;
    const jy = Math.cos(now * 0.0027) * jitterAmp;
    const tiltNow = settings.tilt * 0.008 * Math.sin(now * 0.00031);

    if (fl.span > 0 && fl.t > 0 && curModel && nextModel) {
      const newer = (): void => drawPage(fl.index + 1, now, width * (1 - fl.t));
      if (curModel.transition === 'cut' || curModel.transition === 'glitch') {
        // 硬切 / 撕裂：旧页被整体推走，新页整体推进来（撕裂在同一帧末切片）。
        enterWorld(g, jx, jy, tiltNow);
        drawPage(fl.index, now, -width * fl.t);
        drawPage(fl.index + 1, now, width * (1 - fl.t));
        if (curModel.transition === 'glitch') glitchSlices(g, clamp(settings.glitch) * 0.9, fl.index + 11);
        g.restore();
      } else {
        // 图形转场：先把旧页画满并留快照，再让转场函数在快照之上画新页。
        enterWorld(g, jx, jy, tiltNow);
        drawPage(fl.index, now, 0);
        g.restore();
        takeSnapshot();
        const oldDraw = (): void => {
          if (snapCtx) {
            g.save();
            g.setTransform(ratio, 0, 0, ratio, 0, 0);
            g.drawImage(snap, 0, 0, width, height);
            g.restore();
          }
        };
        enterWorld(g, jx, jy, tiltNow);
        drawTransition({ id: curModel.transition, t: fl.t, seed: fl.index + 7 }, oldDraw, newer);
        g.restore();
      }
    } else if (curModel) {
      enterWorld(g, jx, jy, tiltNow);
      drawPage(base, now, 0);
      g.restore();
    } else if (lines.length > 0) {
      // 还没唱到第一句：先立一张空的版面，别让开场是纯色。
      const first = lines[0]!;
      enterWorld(g, jx, jy, tiltNow);
      drawPage(0, Math.min(now, first.startMs), 0);
      g.restore();
    }

    drawGrain(g, now, skinUse);
    drawChrome(g, now, skinUse, fl);

    // 片尾：整首的最后 4% 把画面收黑，只留署名。
    const total = song?.durationMs ?? 0;
    if (total > 12000 && now > total * 0.96) {
      const k = smoother(clamp((now - total * 0.96) / (total * 0.035)));
      rect(g, 0, 0, width, height, '#050507', k * 0.94);
      const a = clamp((1 - k) * 1.4) * 0.5;
      micro(g, song?.title ?? '', width * 0.06, height * 0.86, Math.max(10, height * 0.014), '#EDECE7', 'left', a);
      micro(g, song?.artist ?? '', width * 0.06, height * 0.885, Math.max(9, height * 0.012), '#8C8C90', 'left', a * 0.9);
    }

    if (!painted) {
      painted = true;
      options.onPainted?.();
    }
  };

  /* ── 尺寸 ───────────────────────────────────────────────── */

  const resize = (): void => {
    const box = root.getBoundingClientRect();
    const w = Math.max(320, Math.round(box.width || window.innerWidth));
    const h = Math.max(240, Math.round(box.height || window.innerHeight));
    ratio = clamp(settings.dpr, 1, 2.5);
    width = w;
    height = h;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    snap.width = canvas.width;
    snap.height = canvas.height;
    advanceCache.clear();
    painted = false;
  };

  resize();

  return {
    root,

    setStyle(next: Partial<PvStyleSettings> | Record<string, unknown>): void {
      settings = normalizePvSettings({ ...settings, ...(next as Partial<PvStyleSettings>) });
      ratio = clamp(settings.dpr, 1, 2.5);
      // 布局与转场是按设置挑的：改了就按同一份歌词重新分镜。
      if (song) compile(song);
      painted = false;
    },

    setSong(next: PvSong | null): void {
      compile(next);
    },

    update(positionMs: number, playing: boolean, energy = 0): void {
      if (disposed) return;
      const now = Number.isFinite(positionMs) ? Math.max(0, positionMs) : 0;
      frame(now, energy, playing);
    },

    resize,

    dispose(): void {
      disposed = true;
      advanceCache.clear();
      root.remove();
      void energyNow;
      void playingNow;
    },
  };
}
