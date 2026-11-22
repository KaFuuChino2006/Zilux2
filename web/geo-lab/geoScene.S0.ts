/**
 * 歌词「流速」— 单画布、连续运动的歌词动画（自研，Canvas 2D）。
 *
 * 设计方向：瑞士编辑排版 + 动态字体（kinetic type）。
 * 一句歌词像一列高速滑入的列车：从右侧带着倾斜进入，减速落位；
 * 停留时只有极轻的呼吸漂移；下一句到来时向左侧加速滑出，留下残影。
 * 没有换版式、没有整屏切块；画面始终是同一张纸，文字在纸上流过。
 * 性能：每句预渲染成两张离屏纹理（墨色/纸色），逐帧只做 drawImage + 变换。
 */

import {
  DEFAULT_GEO_SETTINGS,
  GEO_SETTINGS_KEY,
  normalizeGeoSettings,
  type GeoStyleSettings,
} from '/src/ui/geoSettings.ts';

export interface GeoSceneWord { text: string; startMs: number; endMs: number; spaceBefore?: boolean }
export interface GeoSceneLine { timeMs: number; durationMs: number; text: string; translation?: string; words: ReadonlyArray<GeoSceneWord> }
export interface GeoSong {
  trackKey?: string;
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  lyricOffsetMs?: number;
  lines: ReadonlyArray<GeoSceneLine>;
}
export interface GeoLyricTint { mode: 'solid' | 'cover' | 'gradient'; palette: string[] }
export interface GeoSceneOptions { onPainted?: () => void; style?: Partial<GeoStyleSettings> }
export interface GeoScene {
  readonly root: HTMLDivElement;
  setStyle(settings: Partial<GeoStyleSettings>): void;
  setLyricTint(tint: GeoLyricTint | null): void;
  setSong(song: GeoSong | null): void;
  update(positionMs: number, playing: boolean, energy?: number): void;
  resize(): void;
  dispose(): void;
}

const clamp = (v: number, lo = 0, hi = 1): number => (v < lo ? lo : v > hi ? hi : v);
const smooth = (t: number): number => { const x = clamp(t); return x * x * (3 - 2 * x); };
const smoother = (t: number): number => { const x = clamp(t); return x * x * x * (x * (x * 6 - 15) + 10); };

const FONTS = {
  display: `"PingFang SC","Microsoft YaHei UI","Noto Sans SC",system-ui,sans-serif`,
  yahei: `"Microsoft YaHei UI","PingFang SC",sans-serif`,
  serif: `"Songti SC","Noto Serif SC",serif`,
  mono: `"Cascadia Mono",Consolas,monospace`,
} as const;

const PAPER = '#f2eee4';
const INK = '#111111';
const MUTED = '#8f8a80';

/** 全画布共用的虚线相位缓存：几何元素不必每帧 new 一个数组。 */
const DASH_A: number[] = [1, 5];
/** 十六进制色 → "r,g,b"；非 #rrggbb 一律回落到墨色。 */
function rgbOf(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? `${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)}` : '17,17,17';
}

interface GlyphInfo { ch: string; startMs: number; width: number }
interface LineModel {
  startMs: number;
  endMs: number;
  text: string;
  translation: string;
  glyphs: GlyphInfo[];
}
interface LineTexture {
  ink: HTMLCanvasElement;
  paper: HTMLCanvasElement;
  lit: HTMLCanvasElement;
  width: number;
  height: number;
  fontPx: number;
  advances: number[];
  dpr: number;
}

function readStored(): Partial<GeoStyleSettings> {
  try {
    const raw = localStorage.getItem(GEO_SETTINGS_KEY);
    return raw ? normalizeGeoSettings(JSON.parse(raw)) : {};
  } catch { return {}; }
}

export function createGeoScene(options: GeoSceneOptions = {}): GeoScene {
  const root = document.createElement('div');
  root.className = 'geo-scene';
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  root.append(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('geo scene: 2d context unavailable');

  let settings: GeoStyleSettings = normalizeGeoSettings({ ...DEFAULT_GEO_SETTINGS, ...readStored(), ...(options.style ?? {}) });
  let tint: GeoLyricTint | null = null;
  let song: GeoSong | null = null;
  let lines: LineModel[] = [];
  let width = 0;
  let height = 0;
  let ratio = 1;
  let painted = false;
  let paintedCb = options.onPainted;
  let lastNow = 0;
  let raf = 0;
  let disposed = false;
  let grainPattern: CanvasPattern | null = null;
  let dotPattern: CanvasPattern | null = null;
  let bgX = -1;
  // 整页卷动位置：一句 = 一整页画面，pagePos 是“现在第几页被推到画面中央”。
  let pagePos = 0;
  let bgY = -1;
  let textureEpoch = 0;
  const textures = new Map<number, LineTexture>();
  const measure = document.createElement('canvas').getContext('2d');

  const accent = (): string => {
    if (settings.palette === 'mono' || settings.palette === 'noir' || settings.palette === 'paper') return INK;
    if (settings.followLyrics && tint?.palette[0]) return tint.palette[0];
    return settings.accent || INK;
  };

  const compile = (next: GeoSong | null): void => {
    song = next;
    lines = [];
    textures.clear();
    textureEpoch++;
    if (!next) return;
    const raw = [...next.lines].sort((a, b) => a.timeMs - b.timeMs);
    raw.forEach((line, i) => {
      if (!line.text.trim()) return;
      const end = i + 1 < raw.length ? Math.max(line.timeMs + 500, raw[i + 1]!.timeMs) : line.timeMs + Math.max(2600, line.durationMs || 0);
      const src = line.words.length
        ? line.words
        : Array.from(line.text).map((ch, j) => {
          const span = Math.max(180, (line.durationMs || 2600) / Math.max(1, Array.from(line.text).length));
          return { text: ch, startMs: line.timeMs + j * span, endMs: line.timeMs + (j + 1) * span };
        });
      const glyphs: GlyphInfo[] = [];
      for (const w of src) {
        const chars = Array.from(w.text);
        chars.forEach((ch, j) => {
          glyphs.push({ ch, startMs: w.startMs + ((w.endMs - w.startMs) * j) / chars.length, width: 0 });
        });
      }
      if (glyphs.length) lines.push({ startMs: line.timeMs, endMs: end, text: line.text, translation: line.translation ?? '', glyphs });
    });
  };

  const fontFor = (size: number): string => `${settings.fontWeight} ${size.toFixed(1)}px ${FONTS[settings.fontFamily]}`;

  const buildTexture = (line: LineModel, index: number): LineTexture => {
    const cached = textures.get(index);
    if (cached) return cached;
    const maxW = width * 0.86;
    let fontPx = Math.min(height * 0.17, width * 0.115) * settings.sizeScale;
    if (!measure) throw new Error('geo scene: measure context unavailable');
    measure.font = fontFor(fontPx);
    let textW = line.glyphs.reduce((s, g) => s + measure.measureText(g.ch).width, 0);
    if (textW > maxW) {
      fontPx *= maxW / textW;
      measure.font = fontFor(fontPx);
      textW = line.glyphs.reduce((s, g) => s + measure.measureText(g.ch).width, 0);
    }
    const padX = fontPx * 0.16;
    const padY = fontPx * 0.24;
    const w = Math.ceil(textW + padX * 2);
    const h = Math.ceil(fontPx * 1.18 + padY * 2);
    const dpr = 2;
    const make = (fill: string): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = Math.ceil(w * dpr);
      c.height = Math.ceil(h * dpr);
      const g = c.getContext('2d');
      if (!g) return c;
      g.scale(dpr, dpr);
      g.fillStyle = fill;
      g.font = fontFor(fontPx);
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      let x = padX;
      for (const glyph of line.glyphs) {
        g.fillText(glyph.ch, x, h / 2);
        x += g.measureText(glyph.ch).width;
      }
      return c;
    };
    const inkTex = make(INK);
    const paperTex = make(PAPER);
    const lit = document.createElement('canvas');
    lit.width = inkTex.width;
    lit.height = inkTex.height;
    const lg = lit.getContext('2d');
    if (lg) {
      lg.scale(dpr, dpr);
      lg.fillStyle = accent();
      lg.fillRect(0, 0, w, h);
      lg.drawImage(paperTex, 0, 0, w, h);
    }
    const advances = line.glyphs.map((g) => measure!.measureText(g.ch).width);
    const tex: LineTexture = { ink: inkTex, paper: paperTex, lit, width: w, height: h, fontPx, advances, dpr };
    textures.set(index, tex);
    return tex;
  };

  interface Chunk {
    text: string;
    glyphs: GlyphInfo[];
    startMs: number;
    endMs: number;
  }
  const chunkCache = new Map<number, Chunk[]>();

  const chunksOf = (line: LineModel, index: number): Chunk[] => {
    const cached = chunkCache.get(index);
    if (cached) return cached;
    const glyphsAll = line.glyphs;
    const n = glyphsAll.length;
    const want = n <= 4 ? 1 : n <= 8 ? 2 : n <= 12 ? 3 : 1;
    const cuts: number[] = [0];
    for (let k = 1; k < want; k++) {
      let cut = Math.round((n * k) / want);
      for (let j = 0; j < 6 && cut + j < n; j++) {
        if (' 　，、。！？!?.,'.includes(glyphsAll[cut + j]!.ch)) { cut = cut + j + 1; break; }
      }
      if (cut > cuts[cuts.length - 1]! && cut < n) cuts.push(cut);
    }
    cuts.push(n);
    const chunks: Chunk[] = [];
    for (let k = 0; k < cuts.length - 1; k++) {
      const from = cuts[k]!;
      const to = cuts[k + 1]!;
      const glyphs = glyphsAll.slice(from, to);
      if (!glyphs.length) continue;
      const startMs = glyphs[0]!.startMs;
      const nextStart = glyphsAll[to]?.startMs ?? line.endMs;
      chunks.push({ text: glyphs.map((g) => g.ch).join(''), glyphs, startMs, endMs: Math.max(startMs + 260, nextStart) });
    }
    chunkCache.set(index, chunks);
    return chunks;
  };

  const chunkLine = (chunk: Chunk): LineModel => ({ startMs: chunk.startMs, endMs: chunk.endMs, text: chunk.text, translation: '', glyphs: chunk.glyphs });

  const layoutChunk = (mode: number, i: number, count: number): { x: number; y: number; size: number; rot: number } => {
    if (count <= 1) return { x: width * 0.5, y: height * 0.5, size: 1, rot: 0 };
    const two = mode === 1
      ? [{ x: 0.5, y: 0.34, size: 1.08, rot: -0.01 }, { x: 0.5, y: 0.64, size: 0.88, rot: 0.01 }]
      : mode === 2
        ? [{ x: 0.28, y: 0.36, size: 1.12, rot: -0.015 }, { x: 0.7, y: 0.66, size: 0.9, rot: 0.015 }]
        : [{ x: 0.33, y: 0.36, size: 1.08, rot: -0.01 }, { x: 0.66, y: 0.65, size: 0.88, rot: 0.012 }];
    const three = mode === 1
      ? [{ x: 0.5, y: 0.28, size: 0.98, rot: -0.008 }, { x: 0.5, y: 0.53, size: 0.86, rot: 0.01 }, { x: 0.5, y: 0.75, size: 0.7, rot: -0.006 }]
      : mode === 2
        ? [{ x: 0.26, y: 0.34, size: 1.14, rot: -0.015 }, { x: 0.68, y: 0.6, size: 0.92, rot: 0.012 }, { x: 0.8, y: 0.82, size: 0.62, rot: 0.02 }]
        : [{ x: 0.24, y: 0.3, size: 1.02, rot: -0.012 }, { x: 0.55, y: 0.55, size: 0.9, rot: 0.008 }, { x: 0.78, y: 0.78, size: 0.7, rot: 0.016 }];
    const table = count === 2 ? two : three;
    const t = table[Math.min(i, table.length - 1)]!;
    return { x: width * t.x, y: height * t.y, size: t.size, rot: t.rot };
  };

  /**
   * 版面板：背景不是“一整层在那里平移”，而是由一组真实存在的图形拼出来的。
   * 每句换一种**版式**（大块面 / 圈与弧 / 横带 / 密排记号 / 竖列 / 稀疏记号 六种轮换），
   * 版式由句号决定 → 每句是另一张构图，不是同一张图上元素乱晃。
   * 种子固定 → 同一句里这些图形是稳定实体，不会每帧抖成噪声；换句才换一批。
   * 生成时避开文字块的位置，保证它们始终是“背景”，不压字。
   */
  interface Plate {
    kind: number;
    x: number;
    y: number;
    w: number;
    h: number;
    rot: number;
    depth: number;
    tone: number;
    phase: number;
  }

  const plateCache = new Map<string, Plate[]>();

  const rand01 = (seed: number): number => {
    const v = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return v - Math.floor(v);
  };

  /** 六种版式，逐句轮换：每句换一张构图，视觉上是“背景被换掉了”。 */
  const PLATE_FORMS = 6;

  const platesOf = (
    lineIndex: number,
    blocks: ReadonlyArray<{ x: number; y: number; hw: number; hh: number }>,
  ): Plate[] => {
    const key = `${lineIndex}:${Math.round(width)}x${Math.round(height)}`;
    const cached = plateCache.get(key);
    if (cached) return cached;
    const form = ((lineIndex % PLATE_FORMS) + PLATE_FORMS) % PLATE_FORMS;
    const out: Plate[] = [];
    const base = lineIndex * 91.7 + form * 13.1;
    const minSide = Math.min(width, height);

    const free = (x: number, y: number, hw: number, hh: number): boolean =>
      blocks.every(
        (b) =>
          Math.abs(x - b.x) > b.hw + hw + width * 0.012 ||
          Math.abs(y - b.y) > b.hh + hh + height * 0.012,
      );

    // 图形整体放大一档：版式要“大”，不能只是些小碎块在纸上飘。
    const PLATE_SCALE = 1.4;
    const emit = (p: Plate): void => {
      p.w *= PLATE_SCALE;
      p.h *= PLATE_SCALE;
      if (free(p.x, p.y, p.w * 0.5, p.h * 0.5)) out.push(p);
    };

    if (form === 0) {
      // ① 大块面：几块几乎铺满的色版，压得住画面。
      for (let k = 0; k < 4; k += 1) {
        const s = base + k * 7.3;
        emit({
          kind: k % 3 === 0 ? 1 : 0,
          x: width * (0.1 + 0.8 * rand01(s)),
          y: height * (0.08 + 0.84 * rand01(s + 1.1)),
          w: width * (0.16 + 0.26 * rand01(s + 2.2)),
          h: height * (0.1 + 0.22 * rand01(s + 3.3)),
          rot: (rand01(s + 4.4) - 0.5) * 0.3,
          depth: 0.42 + 0.7 * rand01(s + 5.5),
          tone: 0.11 + 0.11 * rand01(s + 6.6),
          phase: rand01(s + 7.7) * Math.PI * 2,
        });
      }
    } else if (form === 1) {
      // ② 圈与弧：半径大到跨半个画面，再加几根短杠。
      for (let k = 0; k < 5; k += 1) {
        const s = base + k * 5.9;
        const r = minSide * (0.24 + 0.34 * rand01(s + 2.4));
        emit({
          kind: k % 2 === 0 ? 2 : 3,
          x: width * (0.08 + 0.84 * rand01(s)),
          y: height * (0.08 + 0.84 * rand01(s + 1.2)),
          w: r * 2,
          h: r * 2,
          rot: (rand01(s + 3.6) - 0.5) * 0.9,
          depth: 0.4 + 0.78 * rand01(s + 4.8),
          tone: 0.12 + 0.12 * rand01(s + 6.1),
          phase: rand01(s + 7.9) * Math.PI * 2,
        });
      }
      for (let k = 0; k < 5; k += 1) {
        const s = base + 40 + k * 3.7;
        emit({
          kind: 4,
          x: width * (0.08 + 0.84 * rand01(s)),
          y: height * (0.08 + 0.84 * rand01(s + 1.3)),
          w: width * (0.1 + 0.24 * rand01(s + 2.9)),
          h: height * 0.01,
          rot: (rand01(s + 3.1) - 0.5) * 0.7,
          depth: 0.5 + 0.7 * rand01(s + 4.2),
          tone: 0.16 + 0.12 * rand01(s + 5.4),
          phase: rand01(s + 6.5) * Math.PI * 2,
        });
      }
    } else if (form === 2) {
      // ③ 横带：几条贯穿画面的横条，构图偏横向。
      for (let k = 0; k < 5; k += 1) {
        const s = base + k * 6.1;
        emit({
          kind: k % 2 === 0 ? 0 : 4,
          x: width * 0.5,
          y: height * (0.1 + 0.8 * rand01(s)),
          w: width * (0.5 + 0.44 * rand01(s + 1.9)),
          h: height * (0.03 + 0.08 * rand01(s + 2.7)),
          rot: (rand01(s + 3.5) - 0.5) * 0.1,
          depth: 0.44 + 0.66 * rand01(s + 4.6),
          tone: 0.09 + 0.09 * rand01(s + 5.8),
          phase: rand01(s + 6.9) * Math.PI * 2,
        });
      }
    } else if (form === 3) {
      // ④ 密排记号：一整片小十字与点阵，做纹理。
      for (let k = 0; k < 12; k += 1) {
        const s = base + k * 2.9;
        const cell = Math.floor(k / 6);
        const col = k % 6;
        emit({
          kind: k % 3 === 0 ? 5 : k % 3 === 1 ? 6 : 2,
          x: width * (0.08 + 0.84 * ((col + 0.15 + 0.7 * rand01(s)) / 6)),
          y: height * (0.08 + 0.84 * ((cell + 0.15 + 0.7 * rand01(s + 0.7)) / 4)),
          w: width * (0.03 + 0.05 * rand01(s + 1.5)),
          h: height * (0.02 + 0.04 * rand01(s + 2.3)),
          rot: (rand01(s + 3.2) - 0.5) * 1.2,
          depth: 0.48 + 0.72 * rand01(s + 4.1),
          tone: 0.15 + 0.13 * rand01(s + 5.3),
          phase: rand01(s + 6.4) * Math.PI * 2,
        });
      }
    } else if (form === 4) {
      // ⑤ 竖列：几条贯穿画面的竖条，构图偏纵向。
      for (let k = 0; k < 5; k += 1) {
        const s = base + k * 6.7;
        emit({
          kind: k % 2 === 0 ? 0 : 1,
          x: width * (0.08 + 0.84 * rand01(s)),
          y: height * (0.42 + 0.2 * rand01(s + 1.4)),
          w: width * (0.03 + 0.07 * rand01(s + 2.1)),
          h: height * (0.3 + 0.34 * rand01(s + 3.2)),
          rot: (rand01(s + 4.3) - 0.5) * 0.12,
          depth: 0.44 + 0.68 * rand01(s + 5.4),
          tone: 0.10 + 0.10 * rand01(s + 6.6),
          phase: rand01(s + 7.8) * Math.PI * 2,
        });
      }
    } else {
      // ⑥ 稀疏记号：留白最多的一张，只有少量小记号。
      for (let k = 0; k < 8; k += 1) {
        const s = base + k * 8.3;
        emit({
          kind: k % 4 === 0 ? 1 : k % 4 === 1 ? 2 : k % 4 === 2 ? 4 : 6,
          x: width * (0.06 + 0.88 * rand01(s)),
          y: height * (0.06 + 0.88 * rand01(s + 1.9)),
          w: width * (0.04 + 0.12 * rand01(s + 2.8)),
          h: height * (0.03 + 0.1 * rand01(s + 3.7)),
          rot: (rand01(s + 4.6) - 0.5) * 0.5,
          depth: 0.4 + 0.8 * rand01(s + 5.5),
          tone: 0.13 + 0.12 * rand01(s + 6.4),
          phase: rand01(s + 7.3) * Math.PI * 2,
        });
      }
    }

    plateCache.set(key, out);
    return out;
  };

  const drawLine = (index: number, now: number): void => {
    const line = lines[index];
    if (!line) return;
    const next = lines[index + 1];
    const exitStart = (next?.startMs ?? line.endMs) - 700;
    // 有下一句时，文字**不再自己退场**：它跟着整页一起滑出去，
    // 旧句歌词在页面滑走之前始终保持运动，而不是原地淡掉。
    const exit = next ? 0 : smoother((now - exitStart) / 720);
    if (exit >= 1) return;
    const dir = index % 2 === 0 ? 1 : -1;
    const chunks = chunksOf(line, index);
    const mode = index % 4;
    const base = Math.min(height * 0.17, width * 0.135) * settings.sizeScale;
    const cam = 1 + 0.012 * Math.sin(now * 0.0009 + index);

    let active = 0;
    for (let i = 0; i < chunks.length; i++) if (now >= chunks[i]!.startMs) active = i;
    const lap = layoutChunk(mode, active, chunks.length);
    const washR = Math.max(width, height) * 0.34;
    const g = ctx.createRadialGradient(lap.x, lap.y, 0, lap.x, lap.y, washR);
    g.addColorStop(0, 'rgba(17,17,17,0.08)');
    g.addColorStop(1, 'rgba(17,17,17,0)');
    ctx.fillStyle = g;
    ctx.fillRect(lap.x - washR, lap.y - washR, washR * 2, washR * 2);
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = 'rgba(17,17,17,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(width * 0.06, lap.y + height * 0.12);
    ctx.lineTo(lap.x, lap.y + height * 0.12);
    ctx.stroke();
    ctx.restore();

    chunks.forEach((chunk, i) => {
      const key = index * 10 + i;
      const tex = buildTexture(chunkLine(chunk), key);
      const lay = layoutChunk(mode, i, chunks.length);
      const targetFont = base * lay.size;
      const sc = targetFont / tex.fontPx;
      const delay = i * 70;
      const chunkP = smoother((now - (line.startMs - 700) - delay) / 800);
      const started = now >= chunk.startMs;
      const alpha = (started ? 1 : 0.55) * (1 - exit);
      if (alpha <= 0.01) return;
      const isCurrent = started && (i + 1 >= chunks.length || now < chunks[i + 1]!.startMs);
      const style = (index + i) % 4;
      const driftX = Math.sin(now * 0.0005 + index * 1.7 + i) * width * 0.004;
      const driftY = Math.cos(now * 0.0006 + i * 2.1) * height * 0.004;
      const exitX = -exit * dir * width * 0.34;
      const exitY = -exit * height * 0.02;

      if (i === 0) {
        ctx.save();
        ctx.globalAlpha = clamp(alpha * 0.026 * chunkP);
        ctx.translate(lay.x + driftX - width * 0.04, lay.y + driftY - height * 0.02);
        ctx.rotate(lay.rot - 0.01);
        ctx.scale(sc * cam * 1.55, sc * cam * 1.55);
        ctx.drawImage(tex.ink, -tex.width / 2, -tex.height / 2, tex.width, tex.height);
        ctx.restore();
      }

      ctx.save();
      ctx.translate(lay.x + driftX + exitX, lay.y + driftY + exitY);
      ctx.rotate(lay.rot + (1 - chunkP) * 0.02);
      const cscale = sc * cam * (isCurrent ? 1 + 0.02 * Math.sin(clamp((now - chunk.startMs) / 420) * Math.PI) : 1);
      ctx.scale(cscale, cscale);

      // 反白块从中间横向展开，文字再逐字破土。
      if (style === 1) {
        const totalAdv = tex.advances.reduce((x, y) => x + y, 0);
        let sungAdv = 0;
        for (let j = 0; j < chunk.glyphs.length; j++) {
          if (now >= chunk.glyphs[j]!.startMs) sungAdv += tex.advances[j] ?? 0;
        }
        const fracW = totalAdv > 0 ? sungAdv / totalAdv : 0;
        const bh = tex.height - tex.fontPx * 0.04;
        const bw = (tex.width - tex.fontPx * 0.12) * fracW;
        if (bw > 2) {
          ctx.globalAlpha = clamp(alpha * smooth(clamp(fracW * 6)));
          ctx.fillStyle = accent();
          ctx.fillRect(-tex.width / 2 + tex.fontPx * 0.06, -bh / 2, bw, bh);
        }
        ctx.globalAlpha = clamp(alpha);
      }

      // 逐字动画：每个字从基线以下升起、放大、带一点旋转，并带遮罩显影。
      const padX = (tex.width - tex.advances.reduce((a, b) => a + b, 0)) / 2;
      const fx = index % 5;
      if (style === 1) {
        ctx.save();
        ctx.beginPath();
        const cbw = tex.width - tex.fontPx * 0.12;
        const cbh = tex.height - tex.fontPx * 0.04;
        ctx.rect(-cbw / 2, -cbh / 2, cbw, cbh);
        ctx.clip();
      }
      let cum = 0;
      for (let j = 0; j < chunk.glyphs.length; j++) {
        const adv = tex.advances[j] ?? tex.fontPx * 0.9;
        const p = smoother((now - (line.startMs - 780) - delay - j * 32) / 920);
        if (p <= 0) { cum += adv; continue; }
        const paint = style === 1 ? tex.paper : tex.ink;
        let gx = -tex.width / 2 + padX + cum + adv / 2;
        let fxGy = 0;
        let fxRot = 0;
        const gc = j - (chunk.glyphs.length - 1) / 2;
        if (fx === 1) { fxGy = tex.fontPx * 0.0045 * gc * gc; fxRot = gc * 0.04; }
        else if (fx === 2) { fxGy = Math.sin(now * 0.0016 + cum * 0.03 + i * 1.3) * tex.fontPx * 0.17; fxRot = Math.sin(now * 0.0013 + cum * 0.024) * 0.055; }
        else if (fx === 3) { fxGy = ((j + i) % 3 - 1) * tex.fontPx * 0.22; }
        else if (fx === 4) { gx += Math.sin(now * 0.0009 + j * 0.6 + i) * tex.fontPx * 0.12; fxRot = Math.sin(now * 0.0007 + j * 0.4) * 0.03; }
        const motion = style === 1 ? 0.15 : 1;
        const gy = (1 - p) * (1 - p) * tex.fontPx * 0.95 * motion + Math.sin(now * 0.0012 + j * 0.7 + i) * tex.fontPx * 0.012 + fxGy;
        ctx.save();
        ctx.translate(gx, gy);
        ctx.rotate((1 - p) * 0.44 * motion * (j % 2 === 0 ? 1 : -1) + fxRot);
        const gs = style === 1 ? 0.98 + 0.02 * p : 0.8 + 0.2 * p + 0.035 * Math.sin(p * Math.PI);
        ctx.scale(gs, gs);
        const sungP = smoother(clamp((now - chunk.glyphs[j]!.startMs) / 140));
        ctx.globalAlpha = clamp(alpha * p * (0.03 + 0.97 * sungP));
        if (style === 2) {
          ctx.strokeStyle = accent();
          ctx.lineWidth = Math.max(1.1, tex.fontPx * 0.024);
          ctx.font = `${settings.fontWeight} ${tex.fontPx.toFixed(1)}px ${FONTS[settings.fontFamily]}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.strokeText(chunk.glyphs[j]!.ch, 0, 0);
          ctx.globalAlpha = clamp(alpha * p * 0.16);
          ctx.fillStyle = accent();
          ctx.fillText(chunk.glyphs[j]!.ch, 0, 0);
        } else {
          const srcY = tex.height * (1 - p);
          const srcH = tex.height * p;
          ctx.drawImage(paint, (padX + cum) * tex.dpr, srcY * tex.dpr, adv * tex.dpr, srcH * tex.dpr, -adv / 2, -tex.height / 2 + srcY, adv, srcH);
        }
        ctx.restore();
        cum += adv;
      }
      if (style === 1) ctx.restore();

      // 当前词块：一条按演唱比例生长的强调线，从第一字下方开始。
      if (isCurrent && chunkP > 0.35) {
        let frac = 0;
        for (let j = 0; j < chunk.glyphs.length; j++) {
          const cg = chunk.glyphs[j]!;
          const nx = chunk.glyphs[j + 1]?.startMs ?? chunk.endMs;
          if (now >= nx) frac += 1;
          else if (now >= cg.startMs) frac += clamp((now - cg.startMs) / Math.max(1, nx - cg.startMs));
        }
        const runW = (tex.width - tex.fontPx * 0.3) * (frac / Math.max(1, chunk.glyphs.length));
        ctx.globalAlpha = clamp(alpha);
        ctx.fillStyle = accent();
        ctx.fillRect(-tex.width / 2 + tex.fontPx * 0.15, tex.height / 2 - tex.fontPx * 0.07, Math.max(2, runW), Math.max(2, tex.fontPx * 0.032));
      }
      if (style === 3) {
        ctx.globalAlpha = clamp(alpha * 0.9);
        ctx.fillStyle = accent();
        ctx.fillRect(-tex.width / 2 - tex.fontPx * 0.1, -tex.height * 0.22, Math.max(2, tex.fontPx * 0.03), tex.height * 0.44);
      }
      if (fx === 4) {
        ctx.save();
        ctx.globalAlpha = clamp(alpha * 0.08);
        ctx.scale(1, -1);
        ctx.translate(0, tex.height * 0.55);
        ctx.drawImage(tex.ink, -tex.width / 2, -tex.height / 2, tex.width, tex.height);
        ctx.restore();
      }
      ctx.restore();

      if (i === 0) {
        ctx.save();
        ctx.globalAlpha = clamp(alpha * 0.5);
        ctx.translate(lay.x + driftX + exitX, lay.y + driftY + exitY);
        ctx.rotate(lay.rot);
        ctx.fillStyle = MUTED;
        ctx.font = `600 ${Math.max(9, base * 0.075)}px ${FONTS.mono}`;
        ctx.textAlign = 'left';
        ctx.fillText(`A—${String(index + 1).padStart(2, '0')}`, -tex.width * sc / 2, -tex.height * sc / 2 - base * 0.05);
        ctx.restore();
      }
    });
    if (line.translation) {
      ctx.save();
      const tp = smooth(clamp((now - (line.startMs + 160)) / 640));
      ctx.globalAlpha = clamp(tp * (1 - exit) * 0.55);
      ctx.fillStyle = MUTED;
      ctx.font = `500 ${Math.max(12, base * 0.16)}px ${FONTS.yahei}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(line.translation, width * 0.5, height * 0.83);
      ctx.restore();
    }
  };

  const drawBackdrop = (now: number, index: number, total: number, progress: number): void => {
    // 背景运动幅度：相机推拉横移、墨团漂移与几何层的重排幅度都乘这一档，0 = 背景钉住不动。
    const bgm = settings.bgMotion;
    const TINTS = ['232,224,207', '221,229,232', '236,221,224', '228,233,221'];
    const sec = Math.floor(index / 8) % TINTS.length;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = `rgba(${TINTS[sec]},0.8)`;
    ctx.fillRect(0, 0, width, height);

    // 背景整体也在运动：缓慢推拉、横移与轻微旋转，并按句从一侧滑入，和文字层形成视差。
    const bgLine = lines[index];
    // 换句时整张纸“翻一页”：版面向上推、轻微推近 + 旋转，几何层与色场一起走。
    // 用 max(...) 让交界前后两侧都取到同一个峰值，运动连续、不会在换句那一帧突然归零。
    const nextLineStart = bgLine ? (lines[index + 1]?.startMs ?? bgLine.endMs + 900) : 0;
    const lineIn = bgLine ? smoother(clamp((now - bgLine.startMs) / 700)) : 1;
    // 背景比文字晚起步，但**必须在换句那一帧之前退干净**：如果留到下一句开场还没退完，
    // 换句瞬间就会"啪"地切断，读起来像急刹车。窗口放到 900ms、正好在 nextLineStart 收尾。
    const lineOut = bgLine ? smoother(clamp((now - (nextLineStart - 900)) / 900)) : 0;
    const lineA = lineIn * (1 - lineOut);
    // 换句时背景不完全退场：留 28% 的底在纸面上，纸面不会在两句之间闪成一片空白，
    // 而是由背景“带着”这次更替走完。
    const lineVis = 0.28 + 0.72 * lineA;
    // 语段换景（每 6 句）时多一次更大的“翻页”，幅度比换句明显一档。
    const secIdx = lines.length ? Math.floor(index / 6) : 0;
    const secLine = lines.length ? lines[secIdx * 6] : undefined;
    const secWipe = secLine ? 1 - smoother(clamp((now - secLine.startMs + 620) / 900)) : 0;
    const bgSwipe = 0.86 * Math.max(lineOut, 1 - lineIn, secWipe * 1.25);
    // 镜头量先算出来，供各纵深层做视差：深层几乎不动，近层跟着镜头走。
    const camDX = (Math.sin(now * 0.00011 + index * 0.6) * width * 0.018 + bgSwipe * width * 0.06 * (index % 2 ? 1 : -1)) * bgm;
    const camDY = (Math.cos(now * 0.00009 + index * 0.4) * height * 0.01 + bgSwipe * height * 0.12) * bgm;
    const camRot = (Math.sin(now * 0.00007 + index * 0.3) * 0.0045 + bgSwipe * 0.018 * (index % 2 ? 1 : -1)) * bgm;
    const bgZoom = (1.03 + 0.012 * Math.sin(now * 0.00008) * bgm) * (1 + bgSwipe * 0.06 * bgm);
    // 整页卷动：一句 = 一整页画面。句内进度 pg 决定这一页被推到哪。
    // 速度曲线 1 + 0.7·cos(2π·pg)：换句处最快、句中最慢；两端速度都不为零，
    // 所以任何一帧都不会突然刹车，也不会和下一句的起点对不上。
    if (bgLine) {
      // 全页滑动只发生在换句前的 900ms：其余时间整页钉住不动，歌词留在画面正中央，
      // 不会因为“一直在滑”而把正在唱的字提前推出画外。
      pagePos = index + smoother(clamp((now - (nextLineStart - 900)) / 900));
    } else {
      pagePos = index;
    }
    const pageDX = (li: number): number => (li - pagePos) * width;
    ctx.save();
    ctx.translate(width / 2 + camDX, height / 2 + camDY);
    ctx.rotate(camRot);
    ctx.scale(bgZoom, bgZoom);
    ctx.translate(-width / 2, -height / 2);

    // 视差：外层已经把整张纸按镜头搬过一遍，这里按层的纵深把多余的位移抵回来。
    // 于是远层几乎不动、近层跟着镜头走，层与层之间被拉开，画面才是“很多块板子拼起来的”。
    const par = (depth: number): void => {
      ctx.translate(-camDX * (1 - depth), -camDY * (1 - depth));
      ctx.rotate(-camRot * (1 - depth) * 0.7);
    };

    // 三团缓慢移动的墨色空气：左上主墨、右下淡墨、右上一点冷色（若强调色不是墨）。
    // 远层（0.3）：几乎钉在纸上，只做极慢的呼吸。
    ctx.save();
    par(0.3);
    const wash = (cx: number, cy: number, rad: number, alpha: number, rgb: string): void => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, `rgba(${rgb},${alpha})`);
      g.addColorStop(0.6, `rgba(${rgb},${alpha * 0.32})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    };
    wash(width * (0.16 + Math.sin(now * 0.00005) * 0.03 * bgm), height * (0.3 + Math.cos(now * 0.00006) * 0.04 * bgm), Math.max(width, height) * 0.58, 0.12, '17,17,17');
    wash(width * (0.86 + Math.cos(now * 0.00004) * 0.02 * bgm), height * (0.74 + Math.sin(now * 0.00005) * 0.03 * bgm), Math.max(width, height) * 0.42, 0.07, '17,17,17');
    const acc = accent();
    if (acc !== INK) {
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(acc);
      // 副色浓度：第二团光在背景里铺开的程度，off = 完全不出现在背景里。
      const washA = settings.accentWash === 'strong' ? 0.2 : settings.accentWash === 'soft' ? 0.1 : 0;
      if (m && washA > 0) wash(width * 0.78, height * 0.2, width * (0.34 + 0.1 * Math.min(bgm, 1.5)), washA, `${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)}`);
    }
    ctx.restore();

    // 背景响应歌词：斜切色面、点阵与弧线跟随当前词块移动和呼吸。
    ctx.save();
    par(0.58);
    if (lines.length) {
      const line = lines[index];
      if (line) {
        const chunks = chunksOf(line, index);
        let ai = 0;
        for (let i = 0; i < chunks.length; i++) if (now >= chunks[i]!.startMs) ai = i;
        const lp = layoutChunk(index % 4, ai, chunks.length);
        // 色面/点阵/圆环共用换句包络：进场从 0 长起、换句前收掉，句末只轻微回落不消失。
        const local = lineVis * (1 - 0.35 * clamp((now - (line.startMs + 2600)) / 900));
        // 这一句/这一块共用的量：几何元素统一从这里取，避免各处口径不一。
        const inkRGB = rgbOf(INK);
        const lw = (px: number): number => px / (ratio * bgZoom);
        // 几何强度：点阵与圆环的存在感也乘这一档，0 = 只留文字与色场。
        const gq = settings.geometry;
        // 每次换块都重新“塑造”一次：块的扫出、环的生长都从这里起算。
        const grow = smoother(clamp((now - chunks[ai]!.startMs + 120) / 620));
        ctx.save();
        ctx.globalAlpha = 0.5 * local;
        ctx.translate(lp.x, lp.y);
        ctx.rotate(0.07 * Math.sin(now * 0.00022 + index) + (index % 2 ? 0.045 : -0.045));
        ctx.fillStyle = 'rgba(17,17,17,0.04)';
        ctx.fillRect(-width * 0.34, -height * 0.22, width * 0.68, height * 0.44);
        ctx.strokeStyle = 'rgba(17,17,17,0.09)';
        ctx.lineWidth = 1;
        ctx.strokeRect(-width * 0.34, -height * 0.22, width * 0.68, height * 0.44);
        ctx.restore();

        const cols = 9, rows = 6;
        const spanX = width * 0.52, spanY = height * 0.34;
        // 点阵落进一条 Path2D 一次 fill，半径逐点闪烁：低频、幅度小，不外溢。
        const dots = new Path2D();
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const px = lp.x - spanX / 2 + (spanX * c) / (cols - 1);
            const py = lp.y - spanY / 2 + (spanY * r) / (rows - 1);
            const d = Math.hypot((px - lp.x) / spanX, (py - lp.y) / spanY);
            if (d > 1) continue;
            // 按到圆心的距离给相位差：越靠外越慢，呼吸感逐点错开。
            const tw = 0.5 + 0.5 * Math.sin(now * 0.0009 - d * 3.4 + c * 0.9 + r * 1.3);
            const rad = Math.max(0.6, 3.4 * (1 - d)) * (0.55 + 0.75 * tw);
            dots.moveTo(px + rad, py);
            dots.arc(px, py, rad, 0, Math.PI * 2);
          }
        }
        ctx.save();
        ctx.fillStyle = `rgba(${inkRGB},0.9)`;
        ctx.globalAlpha = 0.15 * local * Math.min(1.35, gq * 1.2);
        ctx.fill(dots);
        ctx.restore();

        // 圆环：半径随演唱进度与呼吸扩张，外圈更细的同心环错相反向。
        const ringR = Math.min(width, height) * 0.18;
        const ringGrow = 0.82 + 0.18 * grow;
        const breathe = 0.025 * Math.sin(now * 0.0006);
        ctx.save();
        ctx.strokeStyle = `rgba(${inkRGB},0.9)`;
        ctx.lineWidth = lw(1);
        ctx.globalAlpha = 0.09 * local * (0.6 + 0.4 * grow) * Math.min(1.35, gq * 1.2);
        ctx.beginPath();
        ctx.arc(lp.x, lp.y, ringR * ringGrow * (1 + breathe), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.055 * local * grow * Math.min(1.35, gq * 1.2);
        ctx.beginPath();
        ctx.arc(lp.x, lp.y, ringR * (1.34 + 0.06 * Math.sin(now * 0.0006 + 1.6)) * (0.9 + 0.1 * grow), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();

    // 几何块面跟着歌词走：位置、尺寸、旋转都由当前词块和演唱比例驱动。
    // 中景层（0.82）：跟着镜头走大半，和远层、近层拉开纵深。
    ctx.save();
    par(0.82);
    if (lines.length) {
      const line = lines[index];
      if (line) {
        const gchunks = chunksOf(line, index);
        let ai = 0;
        for (let i = 0; i < gchunks.length; i++) if (now >= gchunks[i]!.startMs) ai = i;
        const lp = layoutChunk(index % 4, ai, gchunks.length);
        let frac = 0;
        const ch = gchunks[ai]!;
        for (let j = 0; j < ch.glyphs.length; j++) {
          const cg = ch.glyphs[j]!;
          const nx = ch.glyphs[j + 1]?.startMs ?? ch.endMs;
          if (now >= nx) frac += 1;
          else if (now >= cg.startMs) frac += clamp((now - cg.startMs) / Math.max(1, nx - cg.startMs));
        }
        frac /= Math.max(1, ch.glyphs.length);
        if (bgX < 0) { bgX = lp.x; bgY = lp.y; }
        bgX += (lp.x - bgX) * 0.09;
        bgY += (lp.y - bgY) * 0.09;
        // 几何层自己的进出场：提前一点淡入、在换句那一帧之前归零，两端都带缓动，
        // 不会“啪”地出现、也不会在换句时被硬切掉。
        const geoIn = smoother(clamp((now - (line.startMs - 320)) / 780));
        const geoVis = geoIn * (1 - lineOut);
        const pulse = 0.5 + 0.5 * Math.sin(now * 0.0011 + index);
        // 与上面点阵/圆环同口径的共用量：同一套换句包络，进场从 0 长起、换句前收掉。
        const local = geoVis;
        const inkRGB = rgbOf(INK);
        const lw = (px: number): number => px / (ratio * bgZoom);
        const grow = smoother(clamp((now - ch.startMs + 120) / 620));
        // 退场与文字层同一时间轴：几何块面跟着文字一起收掉，不留孤立的色块。
        const exitBg = lineOut;
        // 几何强度：所有几何元素的存在感与运动幅度都乘这一档，0 = 只剩文字与色场。
        const geo = settings.geometry;

        // 换块时整层几何“重排”一次：元素从上一块的位置平滑移到新块，而不是各自漂移。
        // ai === 0 表示这句刚开场：此时要从“上一句最后一块”的版面插值过来，
        // 否则换句那一帧几何会瞬移到新位置——看起来就是形状被直接重新画了一遍。
        const prevLp =
          ai > 0
            ? layoutChunk(index % 4, ai - 1, gchunks.length)
            : index > 0 && lines[index - 1]
              ? (() => {
                  const pcs = chunksOf(lines[index - 1]!, index - 1);
                  return pcs.length
                    ? layoutChunk((index - 1) % 4, pcs.length - 1, pcs.length)
                    : lp;
                })()
              : lp;
        const reshape = smoother(clamp((now - ch.startMs + 60) / 760));
        const rpX = prevLp.x + (lp.x - prevLp.x) * reshape;
        const rpY = prevLp.y + (lp.y - prevLp.y) * reshape;
        const rpRot = (prevLp.rot ?? 0) + ((lp.rot ?? 0) - (prevLp.rot ?? 0)) * reshape;

        if (geo <= 0.001) {
          // 关掉几何层时不留任何几何痕迹，直接落到下面的段落底纹。
        } else {
        // ① 大色块：画面主体。入场后常驻，换块时按 reshape 从上一块扫向新块、并随演唱横向扩展。
        // 单独一个包络（不再跟着 local 衰减），否则句子后段会整个消失。
        const blockIn = smoother(clamp((now - line.startMs + 520) / 700));
        const blockA = clamp((0.12 + 0.08 * frac) * blockIn * geoVis * (1 - exitBg) * Math.min(1, geo * 1.35));
        if (blockA > 0.004) {
          ctx.save();
          ctx.globalAlpha = blockA;
          // 色块不从字块正中长起，而是从字块的长边外侧探出去，一个字都不压在墨块里。
          const dirX = lp.x > width * 0.5 ? -1 : 1;
          // 竖直方向反向一份：色块从字块的另一侧探出去，正好落在字块与上/下一块之间的空档里。
          const dirY = lp.y < height * 0.42 ? 1 : lp.y > height * 0.58 ? -1 : 0;
          const ex = rpX + dirX * width * 0.245 * reshape;
          const ey = rpY + dirY * height * 0.115 * reshape;
          ctx.translate(ex, ey);
          ctx.rotate(-0.05 + 0.02 * Math.sin(now * 0.0004) + rpRot * 0.6);
          const bw = width * (0.2 + 0.12 * frac), bh = height * (0.15 + 0.04 * frac);
          // 从靠近字块的一侧扫出：宽度随 reshape 长满，像色版被推上版面。
          const bx = dirX > 0 ? 0 : -bw * (0.35 + 0.65 * reshape);
          const by = -bh / 2;
          // 反白块会把垫在它身下的东西整个吃掉。让色块的描边一直延伸到墨块里，
          // 等于给墨块镶了一道版面色边，被吃掉的那一半就变成了“框”。
          ctx.save();
          ctx.beginPath();
          ctx.rect(
            dirX > 0 ? 0 : -width * 0.42,
            -height * 0.2,
            width * 0.42,
            height * 0.4,
          );
          ctx.clip();
          ctx.strokeStyle = `rgba(${inkRGB},0.92)`;
          ctx.lineWidth = lw(1.6);
          ctx.strokeRect(bx, by, bw * (0.35 + 0.65 * reshape), bh);
          ctx.restore();
          ctx.fillStyle = `rgba(${inkRGB},1)`;
          ctx.fillRect(bx, by, bw * (0.35 + 0.65 * reshape), bh);
          ctx.restore();
        }

        ctx.save();
        // ③ 空心矩形：虚线随时间推进，在“扫描”版面；位置从上一块的对角镜像位重排过来。
        const rectX = width - bgX * 0.35 + (rpX - lp.x) * 0.5;
        const rectY = height - bgY * 0.4 + (rpY - lp.y) * 0.5;
        ctx.translate(rectX, rectY);
        ctx.rotate(0.1 * Math.sin(now * 0.00035 + 1.4) + rpRot);
        ctx.globalAlpha = geoVis * Math.min(1, geo * 1.2);
        const scan = (now * 0.022) % 24;
        ctx.setLineDash(DASH_A);
        ctx.lineDashOffset = -scan;
        ctx.strokeStyle = `rgba(${inkRGB},0.20)`;
        ctx.lineWidth = lw(1);
        ctx.strokeRect(-width * 0.15, -height * 0.09, width * 0.3, height * 0.18);
        ctx.lineDashOffset = scan * 1.4;
        ctx.strokeStyle = `rgba(${inkRGB},0.26)`;
        ctx.strokeRect(-width * 0.13, -height * 0.07, width * 0.26 * (0.2 + 0.8 * reshape), height * 0.14);
        ctx.setLineDash([]);
        ctx.restore();

        ctx.save();
        // ④ 小实心方块：在词块右上角，随重拍呼吸。
        const ss = Math.max(8, (12 + 10 * pulse) * (0.7 + 0.3 * Math.min(geo, 1.3)));
        ctx.translate(lp.x + width * 0.22, lp.y - height * 0.14);
        ctx.rotate(0.4 * Math.sin(now * 0.0006));
        ctx.fillStyle = accent();
        ctx.globalAlpha = geoVis * clamp(0.75 * Math.min(1, geo * 1.1));
        ctx.fillRect(-ss / 2, -ss / 2, ss, ss);
        ctx.restore();

        ctx.save();
        // ⑤ 文字左侧的竖条：高度跟着演唱进度生长，并随 reshape 从上一块的高度过渡。
        const barH = height * (0.12 + 0.28 * frac);
        ctx.fillStyle = `rgba(${inkRGB},0.16)`;
        ctx.globalAlpha = geoVis * Math.min(1, geo * 1.2);
        ctx.fillRect(width * 0.085 + (rpY - lp.y) * 0.12, rpY - barH / 2, Math.max(3, width * 0.004), barH);
        ctx.restore();

        ctx.save();
        // ⑥ 三条横线：随 reshape 在上一块与当前块之间滑动，长度跟着演唱走。
        ctx.strokeStyle = `rgba(${inkRGB},0.11)`;
        ctx.globalAlpha = geoVis * Math.min(1, geo * 1.15);
        ctx.lineWidth = lw(1);
        for (let k = 0; k < 3; k++) {
          const yy = rpY + height * (k - 1) * 0.09;
          const xx = width * 0.1 + Math.sin(now * 0.0004 + k * 1.7) * width * 0.04 + (rpX - lp.x) * 0.18;
          ctx.beginPath();
          ctx.moveTo(xx, yy);
          ctx.lineTo(xx + width * (0.18 + 0.1 * frac), yy);
          ctx.stroke();
        }
        ctx.restore();

        // ⑦ 斜向扫光：每唱过一个字多推一次，像印刷机扫过一块色版；只在句子中段出现。
        {
          const periodMs = 1500;
          const sungNow = clamp((now - ch.startMs) / Math.max(1, ch.endMs - ch.startMs));
          const sp = ((now - ch.startMs) / periodMs) % 1;
          const up = smooth(clamp(sp / 0.12));
          const down = 1 - smooth(clamp((sp - 0.18) / 0.82));
          const bA = clamp(0.5 + 0.8 * sungNow) * local * up * down * 0.09 * (1 - exitBg);
          if (bA > 0.012) {
            const w0 = width * 0.05;
            const xAt = -width * 0.08 + sp * width * 1.16;
            const slant = height * 0.22;
            const gs = ctx.createLinearGradient(xAt - w0, 0, xAt + w0, 0);
            gs.addColorStop(0, `rgba(${inkRGB},0)`);
            gs.addColorStop(0.5, `rgba(${inkRGB},1)`);
            gs.addColorStop(1, `rgba(${inkRGB},0)`);
            ctx.save();
            // 只擦过词块附近的那一段，不要横贯整张纸，否则会读成漏光。
            ctx.beginPath();
            ctx.rect(rpX - width * 0.34, rpY - height * 0.22, width * 0.68, height * 0.44);
            ctx.clip();
            ctx.globalAlpha = bA;
            ctx.fillStyle = gs;
            ctx.beginPath();
            ctx.moveTo(xAt, -height * 0.02);
            ctx.lineTo(xAt + slant, -height * 0.02);
            ctx.lineTo(xAt + slant * 2, height * 1.02);
            ctx.lineTo(xAt + slant, height * 1.02);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
        }

        // ⑧ 块间的编辑分割线：两块并置时，在两块之间那条真实的空白带里拉一根细线，
        // 由已唱进度从中段向两端生长。放在字与字的空档里，不压在字上。
        if (gchunks.length > 1) {
          const a0 = layoutChunk(index % 4, 0, gchunks.length);
          const a1 = layoutChunk(index % 4, 1, gchunks.length);
          const stacked = Math.abs(a0.x - a1.x) < width * 0.1;
          ctx.save();
          ctx.strokeStyle = `rgba(${inkRGB},0.9)`;
          ctx.lineWidth = lw(1);
          ctx.globalAlpha = 0.22 * local * grow * (1 - exitBg) * (0.35 + 0.65 * frac);
          ctx.beginPath();
          if (stacked) {
            // 上下堆叠：线横在上方那块字的下沿与下方那块的顶沿之间。
            const yy = (a0.y + a1.y) / 2;
            const half = width * 0.2 * grow;
            ctx.moveTo(width / 2 - half, yy);
            ctx.lineTo(width / 2 + half, yy);
          } else {
            // 左右错落：线沿两块之间的小块，垂直于排布方向。
            const x0 = (a0.x + a1.x) / 2;
            const y0 = (a0.y + a1.y) / 2;
            const half = height * 0.09 * grow;
            ctx.moveTo(x0, y0 - half);
            ctx.lineTo(x0, y0 + half);
          }
          ctx.stroke();
          ctx.restore();
        }
        }
      }
    }
    ctx.restore();

    // ── 版面板：背景由一整组真实图形拼出来，而且**逐句整张换掉** ───────────────
    // 每句一套六种版式之一（大块面/圈与弧/横带/密排记号/竖列/稀疏记号），
    // 换句时旧构图整组向左推出、新构图从右侧推进来，像换了一页版面。
    // 每套构图的包络只取决于它自己那一句的绝对时间，所以同一套构图在任何时刻的
    // 位置都连续，三套同时在场上滑动也不会跳帧。
    if (settings.geometry > 0.001 && lines.length) {
      const gqA = Math.min(1.4, settings.geometry);
      const drawPlateSet = (li: number): void => {
        const lm = lines[li];
        if (!lm) return;
        // 整页滑动：这一页整体横移到自己的位置，页内所有图形刚性跟着走，
        // 不做逐元素淡入淡出——画面是“整张滑出去、下一张滑进来”，不是叠化。
        const dx = pageDX(li);
        if (Math.abs(dx) > width * 1.15) return;
        const pcs = chunksOf(lm, li);
        const blocks = pcs.map((_, i) => {
          const l = layoutChunk(li % 4, i, pcs.length);
          return { x: l.x, y: l.y, hw: width * 0.33 * l.size, hh: height * 0.115 * l.size };
        });
        let pai = 0;
        for (let i = 0; i < pcs.length; i += 1) if (now >= pcs[i]!.startMs) pai = i;
        const lpNow = layoutChunk(li % 4, pai, pcs.length);
        const lpFirst = layoutChunk(li % 4, 0, pcs.length);
        const driftX = (lpNow.x - lpFirst.x) * 0.55;
        const driftY = (lpNow.y - lpFirst.y) * 0.55;
        const plates = platesOf(li, blocks);
        for (let k = 0; k < plates.length; k += 1) {
          const p = plates[k]!;
          // 整页刚性入场：不再逐块错峰，页内图形跟着页面一起滑进来。
          const inP = 1;
          const a = p.tone * inP * gqA;
          if (a <= 0.004) continue;
          ctx.save();
          par(p.depth);
          // 从文字块“推出去”落位：入场时板子从当前词块附近滑到自己的位置，
          // 眼睛能看出是这句词把版面推开的，而不是背景自己在动。
          ctx.translate(p.x + dx + driftX * p.depth, p.y + driftY * p.depth);
          ctx.rotate(p.rot + Math.sin(now * 0.00032 + p.phase) * 0.004 * bgm);
          const sc = (0.9 + 0.1 * inP) * (1 + 0.004 * Math.sin(now * 0.00046 + p.phase));
          ctx.scale(sc, sc);
          ctx.lineWidth = 1;
          switch (p.kind) {
            case 0: // 实心块面：纸上的灰底
              ctx.fillStyle = `rgba(17,17,17,${a})`;
              ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
              break;
            case 1: // 空心框
              ctx.strokeStyle = `rgba(17,17,17,${a * 1.7})`;
              ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h);
              break;
            case 2: // 完整圈
              ctx.strokeStyle = `rgba(17,17,17,${a * 2})`;
              ctx.beginPath();
              ctx.arc(0, 0, Math.min(p.w, p.h) / 2, 0, Math.PI * 2);
              ctx.stroke();
              break;
            case 3: // 一段弧
              ctx.strokeStyle = `rgba(17,17,17,${a * 2.2})`;
              ctx.beginPath();
              ctx.arc(0, 0, Math.min(p.w, p.h) / 2, -Math.PI * 0.15, Math.PI * 0.85);
              ctx.stroke();
              break;
            case 4: // 短杠
              ctx.fillStyle = `rgba(17,17,17,${a * 1.5})`;
              ctx.fillRect(-p.w / 2, -height * 0.0035, p.w, height * 0.007);
              break;
            case 5: // 点阵块
              if (dotPattern) {
                ctx.globalAlpha = Math.min(1, a * 5);
                ctx.fillStyle = dotPattern;
                ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
              }
              break;
            default: // 十字
              ctx.strokeStyle = `rgba(17,17,17,${a * 1.3})`;
              ctx.beginPath();
              ctx.moveTo(-p.w / 2, 0);
              ctx.lineTo(p.w / 2, 0);
              ctx.moveTo(0, -p.h / 2);
              ctx.lineTo(0, p.h / 2);
              ctx.stroke();
              break;
          }
          ctx.restore();
        }
      };
      // 同一时刻最多三套构图在场上：上一句还在滑出、这一句在位、下一句推进来。
      // 画当前页与下一页：两页正好拼满画面，滑到一半时各占一半，永远没有空档。
      if (index > 0) drawPlateSet(index - 1);
      drawPlateSet(index);
      if (lines[index + 1]) drawPlateSet(index + 1);
    }

    // 换句擦版：新一句来时，一道宽斜光带从纸面下沿扫到上沿（约 700ms 走完）。
    // 和相机推版叠在一起，换句读作“整张纸被抽走一页”，而不是文字单独换掉。
    if (bgLine && settings.geometry > 0.001) {
      const bandP = lineIn;
      const bandA = Math.sin(Math.PI * bandP) * 0.1 * Math.min(1, settings.geometry);
      if (bandA > 0.002) {
        ctx.save();
        ctx.translate(width / 2, height * (1.18 - 1.42 * bandP));
        ctx.rotate(-0.16);
        const g = ctx.createLinearGradient(0, -height * 0.1, 0, height * 0.1);
        g.addColorStop(0, 'rgba(17,17,17,0)');
        g.addColorStop(0.42, `rgba(17,17,17,${bandA})`);
        g.addColorStop(0.58, `rgba(17,17,17,${bandA})`);
        g.addColorStop(1, 'rgba(17,17,17,0)');
        ctx.fillStyle = g;
        ctx.fillRect(-width * 1.3, -height * 0.1, width * 2.6, height * 0.2);
        ctx.restore();
      }
    }

    // 背景随换句换景：三种灰阶场景跟着每一句走，而不是每 6 句才翻一次，
    // 这样“文字换句”和“背景换景”是同一拍，连带一起更替。
    const mode = index % 3;
    ctx.save();
    // 场景叠层的显隐也走换句包络，换景不是硬切，是和版面一起推上来的。
    // 同时受「几何强度」约束：拉到 0 时场景叠层也一并消失，只留文字与色场。
    ctx.globalAlpha = lineVis * Math.min(1, settings.geometry);
    if (mode === 1) {
      ctx.save();
      ctx.translate(width * 0.5, height * 0.5);
      ctx.rotate(-0.16 + Math.sin(now * 0.00003) * 0.01);
      ctx.fillStyle = 'rgba(17,17,17,0.05)';
      ctx.fillRect(-width * 0.8, -height * 0.22, width * 1.6, height * 0.44);
      ctx.restore();
      ctx.strokeStyle = 'rgba(17,17,17,0.05)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 7; i++) {
        ctx.beginPath();
        ctx.moveTo(width * 0.06, height * i / 7);
        ctx.lineTo(width * 0.94, height * i / 7);
        ctx.stroke();
      }
    } else if (mode === 2) {
      const cx = width * 0.78, cy = height * 0.28;
      ctx.strokeStyle = 'rgba(17,17,17,0.06)';
      ctx.lineWidth = 1;
      for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, Math.min(width, height) * (0.1 + i * 0.09), 0, Math.PI * 2);
        ctx.stroke();
      }
      if (dotPattern) {
        ctx.save();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = dotPattern;
        ctx.fillRect(width * 0.05, height * 0.68, width * 0.34, height * 0.2);
        ctx.restore();
      }
    }
    ctx.restore();

    // 缓慢旋转的两道细弧（瑞士海报里的几何骨架）。
    ctx.save();
    ctx.strokeStyle = 'rgba(17,17,17,0.07)';
    ctx.lineWidth = 1;
    for (const [r, a] of [[0.47, 0.0], [0.63, 0.5]] as const) {
      ctx.beginPath();
      ctx.arc(width * 0.82, height * 0.18, Math.min(width, height) * r, a + now * 0.00002, a + now * 0.00002 + Math.PI * 1.35);
      ctx.stroke();
    }
    ctx.restore();

    // 一条横向扫光带：慢慢穿过纸面，给静止画面一点空气感。
    const sy = height * (0.34 + Math.sin(now * 0.000035) * 0.22);
    const sweep = ctx.createLinearGradient(0, sy - height * 0.1, 0, sy + height * 0.1);
    sweep.addColorStop(0, 'rgba(17,17,17,0)');
    sweep.addColorStop(0.5, 'rgba(17,17,17,0.045)');
    sweep.addColorStop(1, 'rgba(17,17,17,0)');
    ctx.save();
    ctx.translate(Math.sin(now * 0.00004) * width * 0.08, 0);
    ctx.fillStyle = sweep;
    ctx.fillRect(-width * 0.1, sy - height * 0.1, width * 1.2, height * 0.2);
    ctx.restore();

    // 左上角网点区（缓存 pattern，一次 fillRect）。
    if (!dotPattern) {
      const tile = document.createElement('canvas');
      tile.width = 14;
      tile.height = 14;
      const g = tile.getContext('2d');
      if (g) { g.fillStyle = 'rgba(17,17,17,0.5)'; g.beginPath(); g.arc(2, 2, 1, 0, Math.PI * 2); g.fill(); }
      dotPattern = ctx.createPattern(tile, 'repeat');
    }
    if (dotPattern) {
      ctx.save();
      ctx.globalAlpha = 0.10;
      ctx.fillStyle = dotPattern;
      ctx.fillRect(width * 0.03, height * 0.05, width * 0.24, height * 0.2);
      ctx.restore();
    }

    // 右侧竖排大字水印（曲名），极淡，随呼吸缓移。
    if (song) {
      ctx.save();
      ctx.translate(width * 0.945, height * 0.52 + Math.sin(now * 0.00006) * height * 0.01);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = 'rgba(17,17,17,0.035)';
      ctx.font = `900 ${Math.min(width, height) * 0.19}px ${FONTS[settings.fontFamily]}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((song.title || '').toUpperCase().slice(0, 12), 0, 0);
      ctx.restore();
    }

    // 极细的编辑参考线。
    ctx.strokeStyle = 'rgba(17,17,17,0.13)';
    ctx.lineWidth = 1;
    for (const p of [0.18, 0.5, 0.82]) {
      ctx.beginPath();
      ctx.moveTo(width * 0.06, height * p + 0.5);
      ctx.lineTo(width * 0.94, height * p + 0.5);
      ctx.stroke();
    }

    // 左侧竖排元信息 + 右上角计数 + 右下角时间码。
    ctx.save();
    ctx.translate(width * 0.045, height * 0.5);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = MUTED;
    ctx.font = `500 ${Math.max(10, height * 0.013)}px ${FONTS.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = song ? `${song.title.toUpperCase()}  —  ${song.artist}` : 'ZILUX2  —  LYRICS';
    ctx.fillText(label, 0, 0);
    ctx.restore();

    ctx.fillStyle = MUTED;
    ctx.font = `500 ${Math.max(10, height * 0.012)}px ${FONTS.mono}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    if (total > 0) ctx.fillText(`${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, width * 0.94, height * 0.045);
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatTime(now), width * 0.94, height * 0.95);

    // 底部走动的进度线。
    ctx.strokeStyle = 'rgba(17,17,17,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(width * 0.06, height * 0.93);
    ctx.lineTo(width * 0.94, height * 0.93);
    ctx.stroke();
    ctx.strokeStyle = accent();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(width * 0.06, height * 0.93);
    ctx.lineTo(width * (0.06 + 0.88 * progress), height * 0.93);
    ctx.stroke();

    ctx.restore();

    // 颗粒 + 暗角。
    if (!grainPattern) {
      const tile = document.createElement('canvas');
      tile.width = 160;
      tile.height = 160;
      const g = tile.getContext('2d');
      if (g) {
        const r = mulberry(0x9e3779b9);
        g.fillStyle = '#000';
        for (let y = 0; y < 160; y += 2) for (let x = 0; x < 160; x += 2) if (r() < 0.22) g.fillRect(x, y, 1, 1);
      }
      grainPattern = ctx.createPattern(tile, 'repeat');
    }
    if (grainPattern) {
      ctx.save();
      ctx.globalAlpha = 0.05;
      ctx.fillStyle = grainPattern;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
    const vig = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.max(width, height) * 0.72);
    vig.addColorStop(0, 'rgba(17,17,17,0)');
    vig.addColorStop(1, 'rgba(17,17,17,0.16)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, width, height);
  };

  const drawIntro = (now: number): void => {
    if (!song) return;
    const e = smooth(now / 900);
    const title = song.title || 'ZILUX2';
    let fontPx = Math.min(height * 0.17, (width * 0.84) / Math.max(2, Array.from(title).length * 0.96));
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = INK;
    ctx.font = `900 ${fontPx.toFixed(1)}px ${FONTS[settings.fontFamily]}`;
    const chars = Array.from(title);
    let total = 0;
    for (const ch of chars) total += ctx.measureText(ch).width;
    let x = width / 2 - total / 2;
    chars.forEach((ch, i) => {
      const p = smooth(clamp((now - 120 - i * 70) / 650));
      const w = ctx.measureText(ch).width;
      ctx.globalAlpha = p;
      ctx.fillText(ch, x + w / 2, height * 0.46 + (1 - p) * height * 0.06);
      x += w;
    });
    ctx.globalAlpha = e * 0.85;
    ctx.fillStyle = accent();
    ctx.fillRect(width * 0.5 - (total * 0.5) * e, height * 0.46 + fontPx * 0.66, total * e, 3);
    ctx.globalAlpha = e * 0.6;
    ctx.fillStyle = MUTED;
    ctx.font = `500 ${Math.max(12, fontPx * 0.16)}px ${FONTS.yahei}`;
    ctx.fillText(song.artist, width / 2, height * 0.46 + fontPx * 0.92);
    ctx.restore();
  };

  const frame = (now: number): void => {
    if (!width || !height) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!song || !lines.length) {
      drawBackdrop(now, 0, 0, 0);
      drawIntro(now);
      finish();
      return;
    }
    let index = 0;
    for (let i = 0; i < lines.length; i++) if (lines[i]!.startMs <= now + 300) index = i;
    drawBackdrop(now, index, lines.length, clamp(now / Math.max(1, song.durationMs)));
    // 摄像机：极慢的推拉与横移，叠在文字层上，背景保持稳定形成视差。
    const camZoom = 1.015 + 0.012 * Math.sin(now * 0.00011) + (index % 3) * 0.004;
    const camX = Math.sin(now * 0.00008) * width * 0.008;
    const camY = Math.cos(now * 0.00007) * height * 0.004;
    ctx.save();
    ctx.translate(width / 2 + camX, height / 2 + camY);
    ctx.scale(camZoom, camZoom);
    ctx.translate(-width / 2, -height / 2);
    // 文字也挂到自己那一页上：换句时文字跟着整页一起横移，
    // 而不是“背景滑走了、文字还钉在原地”。系数 0.55 让文字比版面少走一点，
    // 保持视差，也保证滑到一半时字还在画面里读得清。
    const lp = (li: number): void => {
      ctx.save();
      // 文字与版面同速同距（1.0）：相邻两句的文字正好隔着一整屏，
      // 滑到一半时各占一半、不会互相压在一起。
      ctx.translate((li - pagePos) * width, 0);
      drawLine(li, now);
      ctx.restore();
    };
    if (index > 0) lp(index - 1);
    lp(index);
    if (index + 1 < lines.length) {
      const nextStart = lines[index + 1]!.startMs;
      if (now >= nextStart - 900) lp(index + 1);
    }
    ctx.restore();
    finish();
  };

  const finish = (): void => {
    if (!painted) {
      painted = true;
      const cb = paintedCb;
      paintedCb = undefined;
      cb?.();
    }
  };

  const resize = (): void => {
    const box = root.getBoundingClientRect();
    width = Math.max(1, box.width);
    height = Math.max(1, box.height);
    ratio = clamp(settings.dpr, 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    textures.clear();
    plateCache.clear();
  };

  const update = (positionMs: number, _playing: boolean, _energy?: number): void => {
    if (disposed) return;
    lastNow = positionMs + (song?.lyricOffsetMs ?? 0);
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!disposed) frame(lastNow);
    });
  };

  const setStyle = (next: Partial<GeoStyleSettings>): void => {
    settings = normalizeGeoSettings({ ...settings, ...next });
    textures.clear();
  };
  const setLyricTint = (next: GeoLyricTint | null): void => { tint = next; textures.clear(); };
  const setSong = (next: GeoSong | null): void => {
    compile(next);
    resize();
    if (next?.lines[0]) update(next.lines[0].timeMs, false);
  };

  const ro = new ResizeObserver(() => { resize(); if (lastNow >= 0) frame(lastNow); });
  ro.observe(root);
  const onStorage = (): void => {
    settings = normalizeGeoSettings({ ...settings, ...readStored() });
    textures.clear();
  };
  window.addEventListener('storage', onStorage);

  const dispose = (): void => {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener('storage', onStorage);
    root.remove();
  };

  resize();
  return { root, setStyle, setLyricTint, setSong, update, resize, dispose };
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
