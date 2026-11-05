/**
 * 歌词页「播放效果 · 几何」场景引擎（v2）。
 *
 * 核心概念：整首歌词被编译成若干「段落（shot）」，每段一套大色块构图；
 * 段落之间用「flowAngle」无缝接力——上一段沿那个方向推出画面、下一段从反方向飘进来，
 * 画面始终连续流动，不硬切。每个字随演唱从 flowAngle 的反方向逐个飘入、落位，
 * 唱完后缓缓向外松开字距（release）。
 *
 * 四种构图（shot kind）：
 *   band   横条：强调色带横跨全宽，文字压在带里
 *   split  分割：左右两色，文字大字在主侧
 *   poster 版心：大色块从一侧伸进来形成裁切感，文字在块内
 *   frame  画框：内嵌矩形框住文字，边缘装饰线
 *
 * 这个文件是纯场景引擎，不 import 应用里的任何模块，由 ui/geo.ts 包装层接到播放器上。
 */

import { GEO_LAYOUTS, normalizeGeoSettings, type GeoLayoutId, type GeoStyleSettings } from './geoSettings';

export interface GeoSceneWord { text: string; startMs: number; endMs: number; spaceBefore?: boolean; }
export interface GeoSceneLine { timeMs: number; durationMs: number; text: string; translation?: string; words: ReadonlyArray<GeoSceneWord>; }
export interface GeoSong { trackKey?: string; title: string; artist: string; album?: string; durationMs: number; lyricOffsetMs?: number; lines: ReadonlyArray<GeoSceneLine>; }
export interface GeoLyricTint { mode: 'solid' | 'cover' | 'gradient'; palette: string[]; }
export interface GeoSceneOptions { onPainted?: () => void; style?: Partial<GeoStyleSettings>; }
export interface GeoScene {
  readonly root: HTMLDivElement;
  setStyle(settings: Partial<GeoStyleSettings>): void;
  setLyricTint(tint: GeoLyricTint | null): void;
  setSong(song: GeoSong | null): void;
  update(positionMs: number, playing: boolean, energy?: number): void;
  resize(): void;
  dispose(): void;
}

type ShotKind = Exclude<GeoLayoutId, 'auto'>;
interface TimedGlyph { ch: string; startMs: number; endMs: number; restOffsetX: number; space: boolean; }
interface ShotLayout {
  kind: ShotKind;
  blocks: ReadonlyArray<{ x: number; y: number; w: number; h: number; colorKey: 'accent' | 'secondary' | 'ink' | 'paper'; }>;
  textCX: number; textCY: number; textMaxW: number; textMaxH: number;
  extra: Record<string, number | string>;
}
interface GeoCompiledShot {
  index: number; startMs: number; endMs: number; lyricEndMs: number;
  text: string; translation: string; glyphs: TimedGlyph[]; flowAngle: number; layout: ShotLayout; fontSize: number;
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (Math.imul(h, 0x01000193)) >>> 0; }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let st = seed >>> 0;
  return () => { st = (st + 0x6d2b79f5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (v: number, lo: number, hi: number): number => v < lo ? lo : v > hi ? hi : v;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * clamp(t, 0, 1);
function easeOutExpo(t: number): number { const p = clamp(t, 0, 1); return p >= 1 ? 1 : 1 - Math.pow(2, -10 * p); }
function easeOutQuart(t: number): number { const x = 1 - clamp(t, 0, 1); return 1 - x * x * x * x; }
function hexChannels(hex: string): [number, number, number] { const v = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : 'f0ece4'; return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]; }
function rgba(hex: string, alpha: number): string { const [r, g, b] = hexChannels(hex); return `rgba(${r},${g},${b},${(Math.min(1,Math.max(0,alpha))).toFixed(3)})`; }
function luminance(hex: string): number { const [r, g, b] = hexChannels(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

const FONT_STACKS: Record<GeoStyleSettings['fontFamily'], string> = {
  display: "'Noto Sans CJK SC','Noto Sans SC','Microsoft YaHei UI','Zilux2 Sans SC',system-ui,sans-serif",
  mono: "'JetBrains Mono','Cascadia Mono',Consolas,'Courier New',monospace",
  serif: "'Noto Serif CJK SC','Source Han Serif SC',SimSun,serif",
  yahei: "'Microsoft YaHei UI','Microsoft YaHei','Zilux2 Sans SC',system-ui,sans-serif",
};

const STYLE_ID = 'zlr-geo-v2-style';
function nonSpaceCount(text: string): number { return Array.from(text).filter(c => !/s/.test(c)).length; }

function buildGlyphsForSlice(
  words: ReadonlyArray<GeoSceneWord>,
  fallbackStart: number,
  fallbackDuration: number,
): Array<Omit<TimedGlyph, 'restOffsetX'>> {
  const text = words.map(w => w.text).join('');
  const chars = Array.from(text);
  const result: Array<Omit<TimedGlyph, 'restOffsetX'>> = [];
  const nonSpaceWords = words.filter(w => /S/.test(w.text));
  if (nonSpaceWords.length > 0) {
    let wi = 0, usedInWord = 0;
    for (const ch of chars) {
      if (/s/.test(ch)) {
        const prev = result[result.length - 1];
        result.push({ ch, startMs: prev?.startMs ?? fallbackStart, endMs: prev?.endMs ?? fallbackStart, space: true });
        continue;
      }
      while (wi < nonSpaceWords.length && usedInWord >= nonSpaceCount(nonSpaceWords[wi]!.text)) { wi++; usedInWord = 0; }
      const word = nonSpaceWords[wi];
      if (word) {
        const count = Math.max(1, nonSpaceCount(word.text));
        const from = word.startMs, to = Math.max(from + 40, word.endMs);
        result.push({ ch, startMs: from + (to - from) * usedInWord / count, endMs: from + (to - from) * (usedInWord + 1) / count, space: false });
        usedInWord++;
      } else {
        const filled = result.filter(g => !g.space).length;
        const total = Math.max(filled + 1, nonSpaceCount(text));
        const t0 = fallbackStart + fallbackDuration * filled / total;
        result.push({ ch, startMs: t0, endMs: t0 + fallbackDuration / total, space: false });
      }
    }
  } else {
    const total = Math.max(1, nonSpaceCount(text));
    let i = 0;
    for (const ch of chars) {
      if (/s/.test(ch)) { result.push({ ch, startMs: fallbackStart, endMs: fallbackStart, space: true }); continue; }
      const t0 = fallbackStart + fallbackDuration * i / total;
      result.push({ ch, startMs: t0, endMs: t0 + fallbackDuration / total, space: false });
      i++;
    }
  }
  return result;
}

function computeLayout(kind: ShotKind, rng: () => number): ShotLayout {
  switch (kind) {
    case 'band': {
      const bandY = 0.25 + rng() * 0.38, bandH = 0.24 + rng() * 0.16;
      return { kind, extra: { bandY, bandH }, blocks: [{ x: -0.08, y: bandY, w: 1.16, h: bandH, colorKey: 'accent' }], textCX: 0.5, textCY: bandY + bandH * 0.5, textMaxW: 0.86, textMaxH: bandH * 0.76 };
    }
    case 'split': {
      const splitX = 0.42 + rng() * 0.20, leftIsPrimary = rng() > 0.4, w0 = leftIsPrimary ? splitX : (1 - splitX);
      return { kind, extra: { splitX, leftIsPrimary: leftIsPrimary ? 1 : 0 }, blocks: [{ x: -0.06, y: -0.06, w: splitX + 0.06, h: 1.12, colorKey: leftIsPrimary ? 'secondary' : 'paper' }], textCX: leftIsPrimary ? splitX * 0.5 : splitX + (1 - splitX) * 0.5, textCY: 0.5, textMaxW: w0 * 0.86, textMaxH: 0.7 };
    }
    case 'poster': {
      const side = Math.floor(rng() * 4), extent = 0.5 + rng() * 0.24;
      let bx = 0, by = 0, bw = 0, bh = 0, cx = 0, cy = 0;
      switch (side) {
        case 0: bx=-0.08; by=-0.08; bw=extent+0.08; bh=1.16; cx=extent*0.48; cy=0.5; break;
        case 1: bx=1-extent; by=-0.08; bw=extent+0.08; bh=1.16; cx=1-extent*0.48; cy=0.5; break;
        case 2: bx=-0.08; by=-0.08; bw=1.16; bh=extent+0.08; cx=0.5; cy=extent*0.44; break;
        default: bx=-0.08; by=1-extent; bw=1.16; bh=extent+0.08; cx=0.5; cy=1-extent*0.44; break;
      }
      const mw = side <= 1 ? extent * 0.82 : 0.82, mh = side >= 2 ? extent * 0.7 : 0.7;
      return { kind, extra: { side, extent }, blocks: [{ x: bx, y: by, w: bw, h: bh, colorKey: 'ink' }], textCX: cx, textCY: cy, textMaxW: mw, textMaxH: mh };
    }
    case 'frame': {
      const ix = 0.07 + rng() * 0.04, iy = 0.09 + rng() * 0.05;
      return { kind, extra: { insetX: ix, insetY: iy }, blocks: [{ x: ix, y: iy, w: 1-ix*2, h: 1-iy*2, colorKey: 'secondary' }], textCX: 0.5, textCY: 0.5, textMaxW: (1-ix*2)*0.84, textMaxH: (1-iy*2)*0.7 };
    }
  }
}


function compileShots(song: GeoSong, rng: () => number): GeoCompiledShot[] {
  const offset = song.lyricOffsetMs ?? 0;
  const shots: GeoCompiledShot[] = [];
  let prevAngle = Math.PI / 2;
  let shotIdx = 0;

  const shuffled = [...GEO_LAYOUTS];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const kindAt = (idx: number): ShotKind => shuffled[idx % shuffled.length]!;

  for (const line of song.lines) {
    const words = line.words.filter((w) => /\S/.test(w.text));
    const charCount = nonSpaceCount(line.text);
    const lineDuration = Math.max(180, line.durationMs || 0);

    let numSlices = 1;
    if (charCount > 9 && lineDuration > 3200) numSlices = 2;
    if (charCount > 15 && lineDuration > 5000) numSlices = 3;

    const slices: (typeof words)[] = [];
    if (numSlices === 1 || words.length === 0) {
      slices.push(words);
    } else {
      const target = Math.ceil(words.length / numSlices);
      for (let i = 0; i < words.length; i += target) slices.push(words.slice(i, i + target));
    }

    for (const slice of slices) {
      const sliceText = slice.map((w) => w.text).join('');
      const rawStart = (slice[0]?.startMs ?? line.timeMs) + offset;
      const rawEnd = (slice[slice.length - 1]?.endMs ?? line.timeMs + lineDuration) + offset;
      const startMs = rawStart;
      const lyricEndMs = Math.max(rawStart + 180, rawEnd);

      const drift = (rng() - 0.5) * 0.55;
      const angle = clamp(prevAngle + drift, Math.PI * 0.22, Math.PI * 0.78);
      prevAngle = angle;

      const kind = kindAt(shotIdx);
      const layoutRng = mulberry32(hashString(`${song.trackKey ?? 'geo'}|${shotIdx}`));
      const layout = computeLayout(kind, layoutRng);

      const rawGlyphs = buildGlyphsForSlice(slice, startMs, lyricEndMs - startMs);
      const glyphs: TimedGlyph[] = rawGlyphs.map((g) => ({ ...g, restOffsetX: 0 }));

      shots.push({
        index: shotIdx++,
        startMs,
        endMs: lyricEndMs + 1000,
        lyricEndMs,
        text: sliceText,
        translation: numSlices === 1 ? (line.translation ?? '') : '',
        glyphs,
        flowAngle: angle,
        layout,
        fontSize: 64,
      });
    }
  }

  for (let i = 0; i < shots.length - 1; i++) shots[i]!.endMs = shots[i + 1]!.startMs;
  return shots;
}

export function createGeoScene(options: GeoSceneOptions = {}): GeoScene {
  const root = document.createElement('div');
  root.className = 'zl-geo-scene';

  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = '.zl-geo-scene{position:absolute;inset:0;overflow:hidden;background:#0a0b0e}\n.zl-geo-scene canvas{display:block;position:absolute;top:0}';
    document.head.append(st);
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('[geo] canvas 2d unavailable');
  root.append(canvas);

  let settings: GeoStyleSettings = normalizeGeoSettings({ ...options.style });
  let tint: GeoLyricTint | null = null;
  let song: GeoSong | null = null;
  let shots: GeoCompiledShot[] = [];
  let width = 0, height = 0, ratio = 1, gutterNow = 0;
  let disposed = false, painted = false;
  let paintedCb = options.onPainted;
  let energySmooth = 0, lastPos = 0;

  const glyphW = new Map<string, number>();
  const measureCh = (font: string, ch: string): number => {
    const key = `${font}|${ch}`;
    const cached = glyphW.get(key);
    if (cached !== undefined) return cached;
    ctx.font = font;
    const w = ctx.measureText(ch).width;
    if (glyphW.size > 3000) glyphW.clear();
    glyphW.set(key, w);
    return w;
  };

  interface Pal { bg: string; paper: string; ink: string; accent: string; secondary: string; light: boolean; }

  const resolvePal = (): Pal => {
    let accent = settings.accent, secondary = settings.secondary;
    if (settings.followLyrics && tint && tint.palette.length > 0 && tint.mode !== 'solid') {
      accent = tint.palette[0] ?? accent;
      secondary = tint.palette[1] ?? secondary;
    }
    const light = luminance(settings.bgTop) > 0.5;
    return {
      bg: settings.bgTop,
      paper: light ? settings.bgTop : settings.ink,
      ink: light ? settings.ink : settings.bgTop,
      accent, secondary, light,
    };
  };

  const blockColor = (key: ShotLayout['blocks'][number]['colorKey'], p: Pal): string => {
    if (key === 'accent') return p.accent;
    if (key === 'secondary') return p.secondary;
    if (key === 'ink') return p.ink;
    return p.paper;
  };

  const contrastOn = (bg: string, p: Pal): string =>
    Math.abs(luminance(bg) - luminance(p.paper)) >= Math.abs(luminance(bg) - luminance(p.ink))
      ? p.paper : p.ink;

  const leftGutter = (): number => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--rail-w').trim();
    const w = Number.parseFloat(raw);
    if (!Number.isFinite(w) || w <= 0) return 0;
    return document.querySelector('.app')?.classList.contains('is-lyrics-open') ? w : 0;
  };

  const applySize = (): boolean => {
    const rect = root.getBoundingClientRect();
    const fullW = Math.max(1, rect.width || root.clientWidth || window.innerWidth);
    const cssH = Math.max(1, rect.height || root.clientHeight || window.innerHeight);
    const gutter = leftGutter();
    const cssW = Math.max(1, fullW - gutter);
    const dpr = clamp(window.devicePixelRatio || 1, 1, settings.dpr);
    if (Math.abs(cssW - width) < 0.5 && Math.abs(cssH - height) < 0.5 && dpr === ratio && Math.abs(gutter - gutterNow) < 0.5) return false;
    width = cssW; height = cssH; ratio = dpr; gutterNow = gutter;
    canvas.style.left = `${gutter}px`;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    recomputeGlyphs();
    return true;
  };

  const layoutGlyphs = (shot: GeoCompiledShot): void => {
    if (width === 0) return;
    const { layout, glyphs } = shot;
    const fw = settings.fontWeight, ff = FONT_STACKS[settings.fontFamily];
    const regionW = layout.textMaxW * width;
    const regionH = layout.textMaxH * height;
    const testFont = `${fw} 100px ${ff}`;
    let totalW = 0;
    for (const g of glyphs.filter((g) => !g.space)) totalW += measureCh(testFont, g.ch) * (1 + settings.letterSpacing);
    const fsByW = totalW > 0 ? (regionW / totalW) * 100 : regionH;
    const fontSize = clamp(Math.min(fsByW, regionH * 0.82) * settings.sizeScale, height * 0.055, height * 0.55);
    shot.fontSize = fontSize;
    const font = `${fw} ${fontSize.toFixed(1)}px ${ff}`;
    let cursor = 0;
    for (const g of glyphs) {
      if (g.space) { g.restOffsetX = cursor; cursor += measureCh(font, ' ') * 0.5; continue; }
      const cw = measureCh(font, g.ch) * (1 + settings.letterSpacing);
      g.restOffsetX = cursor + cw / 2;
      cursor += cw;
    }
    const half = cursor / 2;
    for (const g of glyphs) g.restOffsetX -= half;
  };

  const recomputeGlyphs = (): void => { for (const s of shots) layoutGlyphs(s); };

  let grainPat: CanvasPattern | null = null;
  let dotPat: CanvasPattern | null = null;

  const buildTextures = (): void => {
    const grain = document.createElement('canvas');
    grain.width = 96; grain.height = 96;
    const gc = grain.getContext('2d');
    if (gc) {
      const img = gc.createImageData(96, 96);
      const r = mulberry32(0xc0ffee);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.round(100 + r() * 155);
        img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
      }
      gc.putImageData(img, 0, 0);
    }
    grainPat = ctx.createPattern(grain, 'repeat');
    const cell = Math.max(4, Math.round(Math.min(width || 1280, height || 720) * 0.013));
    const dots = document.createElement('canvas');
    dots.width = cell; dots.height = cell;
    const dc = dots.getContext('2d');
    if (dc) { dc.fillStyle = '#fff'; dc.beginPath(); dc.arc(cell / 2, cell / 2, cell * 0.18, 0, Math.PI * 2); dc.fill(); }
    dotPat = ctx.createPattern(dots, 'repeat');
  };

  const findIdx = (nowMs: number): number => {
    if (!shots.length) return -1;
    let lo = 0, hi = shots.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (shots[mid]!.startMs <= nowMs) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  };

  const drawBg = (shot: GeoCompiledShot, p: Pal): void => {
    for (const b of shot.layout.blocks) {
      ctx.fillStyle = blockColor(b.colorKey, p);
      ctx.fillRect((b.x - 0.06) * width, (b.y - 0.06) * height, (b.w + 0.12) * width, (b.h + 0.12) * height);
    }
    if (shot.layout.kind === 'split') {
      const sx = Number(shot.layout.extra.splitX);
      ctx.save(); ctx.fillStyle = rgba(p.ink, 0.7);
      ctx.fillRect(sx * width - 1.5, 0, 3, height); ctx.restore();
    } else if (shot.layout.kind === 'frame') {
      const ix = Number(shot.layout.extra.insetX), iy = Number(shot.layout.extra.insetY);
      const arm = Math.min(width, height) * 0.04;
      ctx.save();
      ctx.strokeStyle = rgba(p.ink, 0.62); ctx.lineWidth = Math.max(1.5, width * 0.0018);
      ctx.strokeRect(ix * width, iy * height, (1 - ix * 2) * width, (1 - iy * 2) * height);
      ctx.strokeStyle = p.accent; ctx.lineWidth = Math.max(2.5, width * 0.003);
      ctx.beginPath();
      ctx.moveTo(ix * width, iy * height + arm); ctx.lineTo(ix * width, iy * height); ctx.lineTo(ix * width + arm, iy * height);
      ctx.moveTo((1 - ix) * width - arm, iy * height); ctx.lineTo((1 - ix) * width, iy * height); ctx.lineTo((1 - ix) * width, iy * height + arm);
      ctx.moveTo((1 - ix) * width, (1 - iy) * height - arm); ctx.lineTo((1 - ix) * width, (1 - iy) * height); ctx.lineTo((1 - ix) * width - arm, (1 - iy) * height);
      ctx.moveTo(ix * width + arm, (1 - iy) * height); ctx.lineTo(ix * width, (1 - iy) * height); ctx.lineTo(ix * width, (1 - iy) * height - arm);
      ctx.stroke(); ctx.restore();
    }
  };

  const drawGlyphs = (shot: GeoCompiledShot, nowMs: number, p: Pal): void => {
    const { layout, glyphs, fontSize, flowAngle } = shot;
    if (!glyphs.length || fontSize <= 0) return;
    const fw = settings.fontWeight, ff = FONT_STACKS[settings.fontFamily];
    ctx.font = `${fw} ${fontSize.toFixed(1)}px ${ff}`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const bgC = layout.blocks[0] ? blockColor(layout.blocks[0].colorKey, p) : p.bg;
    const baseColor = contrastOn(bgC, p);
    const accentColor = p.accent;
    const unsungAlpha = 0.22;
    const revMs = Math.max(1, settings.revealMs);
    const eAngle = flowAngle + Math.PI;
    const eDX = Math.cos(eAngle), eDY = Math.sin(eAngle);
    const eDist = Math.min(width, height) * 0.072;
    const cx = layout.textCX * width, cy = layout.textCY * height;
    for (const g of glyphs) {
      if (g.space) continue;
      const rx = cx + g.restOffsetX, ry = cy;
      const enterStart = g.startMs - revMs;
      let ox = 0, oy = 0, alpha = 1, color = baseColor, scale = 1;
      if (nowMs < enterStart) {
        alpha = unsungAlpha;
      } else if (nowMs < g.startMs) {
        const p2 = easeOutExpo((nowMs - enterStart) / revMs);
        ox = eDX * eDist * (1 - p2); oy = eDY * eDist * (1 - p2);
        alpha = lerp(unsungAlpha, 1, p2);
        color = p2 > 0.55 ? accentColor : baseColor;
        scale = 1 + 0.085 * (1 - easeOutQuart(p2));
      } else if (nowMs < g.endMs) {
        color = accentColor; scale = 1.032;
      } else {
        const rw = Math.max(900, shot.lyricEndMs - g.endMs + 1200);
        const rt = clamp((nowMs - g.endMs) / rw, 0, 1);
        const rd = easeOutQuart(rt) * 5;
        ox = (g.restOffsetX >= 0 ? 1 : -1) * rd;
        alpha = 0.9;
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      if (scale !== 1) { ctx.translate(rx + ox, ry + oy); ctx.scale(scale, scale); ctx.translate(-(rx + ox), -(ry + oy)); }
      ctx.fillStyle = color;
      ctx.fillText(g.ch, rx + ox, ry + oy);
      ctx.restore();
    }
    if (settings.showTranslation && shot.translation) {
      const ts = Math.max(10, Math.min(width, height) * 0.019);
      ctx.save();
      ctx.font = `500 ${ts}px ${FONT_STACKS.yahei}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = rgba(baseColor, 0.52);
      ctx.fillText(shot.translation, width * 0.93, height - Math.min(width, height) * 0.058);
      ctx.restore();
    }
  };

  const drawShot = (shot: GeoCompiledShot, nowMs: number, p: Pal): void => {
    drawBg(shot, p);
    drawGlyphs(shot, nowMs, p);
  };

  const drawTextures = (p: Pal): void => {
    if (settings.halftone > 0 && dotPat) {
      ctx.save(); ctx.globalCompositeOperation = p.light ? 'multiply' : 'screen';
      ctx.globalAlpha = 0.075 * settings.halftone; ctx.fillStyle = dotPat;
      ctx.fillRect(0, 0, width, height); ctx.restore();
    }
    if (settings.grain > 0 && grainPat) {
      ctx.save(); ctx.globalCompositeOperation = p.light ? 'multiply' : 'overlay';
      ctx.globalAlpha = settings.grain * 2.1; ctx.fillStyle = grainPat;
      ctx.fillRect(0, 0, width, height); ctx.restore();
    }
  };

  const drawGrid = (p: Pal): void => {
    if (settings.grid <= 0) return;
    const step = Math.max(28, Math.min(width, height) / 11);
    ctx.save(); ctx.strokeStyle = rgba(p.ink, 0.038 * settings.grid); ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = (width % step) / 2; x < width; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, height); }
    for (let y = (height % step) / 2; y < height; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(width, Math.round(y) + 0.5); }
    ctx.stroke(); ctx.restore();
  };

  const drawChrome = (p: Pal, nowMs: number, progress: number): void => {
    if (settings.marks) {
      const s = Math.min(width, height), pad = s * 0.038, arm = s * 0.032;
      ctx.save(); ctx.strokeStyle = rgba(p.ink, 0.34); ctx.lineWidth = 1;
      ctx.beginPath();
      const corners: [number, number, number, number][] = [[pad, pad, 1, 1], [width - pad, pad, -1, 1], [pad, height - pad, 1, -1], [width - pad, height - pad, -1, -1]];
      for (const [x, y, sx, sy] of corners) { ctx.moveTo(x + arm * sx, y); ctx.lineTo(x, y); ctx.lineTo(x, y + arm * sy); }
      ctx.stroke(); ctx.restore();
    }
    if (settings.meta) {
      const s = Math.min(width, height), pad = s * 0.05, mono = Math.max(10, s * 0.015);
      const sec = Math.floor(progress * Math.max(1, song?.durationMs ?? 0) / 1000);
      const tc = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
      ctx.save(); ctx.font = `500 ${mono}px ${FONT_STACKS.mono}`; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = rgba(p.ink, 0.46);
      ctx.textAlign = 'left'; ctx.fillText(`ZLX / ${String(Math.max(0, findIdx(nowMs) + 1)).padStart(2, '0')}`, pad, pad + mono);
      ctx.textAlign = 'right'; ctx.fillText(tc, width - pad, pad + mono);
      ctx.fillStyle = rgba(p.ink, 0.1); ctx.fillRect(pad, height - pad * 0.7, width - pad * 2, 1.5);
      ctx.fillStyle = rgba(p.accent, 0.85); ctx.fillRect(pad, height - pad * 0.7 - 0.5, (width - pad * 2) * clamp(progress, 0, 1), 2.5);
      ctx.restore();
    }
    void nowMs;
  };

  const drawIntro = (p: Pal): void => {
    const title = song?.title ?? '';
    if (!title) return;
    const s = Math.min(width, height);
    const nc = Array.from(title).filter((c) => !/\s/.test(c)).length;
    const fs = clamp(width * 0.78 / Math.max(1, nc), s * 0.1, s * 0.38) * settings.sizeScale;
    ctx.save();
    ctx.font = `${settings.fontWeight} ${fs}px ${FONT_STACKS[settings.fontFamily]}`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillStyle = rgba(p.ink, 0.9); ctx.fillText(title, width / 2, height * 0.52);
    ctx.font = `500 ${Math.max(10, s * 0.019)}px ${FONT_STACKS.yahei}`;
    ctx.fillStyle = rgba(p.ink, 0.46); ctx.fillText((song?.artist ?? '').toUpperCase(), width / 2, height * 0.63);
    ctx.restore();
  };

  const render = (posMs: number): void => {
    if (disposed || width <= 0 || height <= 0) return;
    const nowMs = posMs + (song?.lyricOffsetMs ?? 0);
    const idx = findIdx(nowMs);
    const shot = idx >= 0 ? shots[idx]! : null;
    const p = resolvePal();

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const ang = (settings.bgAngle * Math.PI) / 180;
    const cx = width / 2, cy = height / 2;
    const reach = (Math.abs(Math.cos(ang)) * width + Math.abs(Math.sin(ang)) * height) / 2;
    const bgGrad = ctx.createLinearGradient(cx - Math.cos(ang) * reach, cy - Math.sin(ang) * reach, cx + Math.cos(ang) * reach, cy + Math.sin(ang) * reach);
    bgGrad.addColorStop(0, settings.bgTop); bgGrad.addColorStop(1, settings.bgBottom);
    ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, width, height);

    drawGrid(p);

    if (!shot) {
      drawTextures(p); drawIntro(p);
      drawChrome(p, nowMs, 0);
      if (!painted) { painted = true; const cb = paintedCb; paintedCb = undefined; cb?.(); }
      return;
    }

    const sinceStart = nowMs - shot.startMs;
    const shotDur = shot.endMs - shot.startMs;
    const handoffMs = clamp((shotDur * 0.28) / settings.flow, 360, 900);
    const inHandoff = sinceStart < handoffMs && idx > 0;
    const prev = inHandoff ? (shots[idx - 1] ?? null) : null;

    let cTx = 0, cTy = 0, pTx = 0, pTy = 0;
    if (inHandoff && prev) {
      const et = easeOutExpo(sinceStart / handoffMs);
      const ea = shot.flowAngle + Math.PI;
      cTx = Math.cos(ea) * width * (1 - et); cTy = Math.sin(ea) * height * (1 - et);
      const xt = sinceStart / handoffMs;
      pTx = Math.cos(shot.flowAngle) * width * xt; pTy = Math.sin(shot.flowAngle) * height * xt;
    }

    const jitter = energySmooth * settings.energy * 1.4;
    const jx = jitter > 0.12 ? (Math.random() - 0.5) * jitter : 0;
    const jy = jitter > 0.12 ? (Math.random() - 0.5) * jitter : 0;

    if (prev) { ctx.save(); ctx.translate(pTx + jx, pTy + jy); drawShot(prev, nowMs, p); ctx.restore(); }
    ctx.save(); ctx.translate(cTx + jx, cTy + jy); drawShot(shot, nowMs, p); ctx.restore();

    drawTextures(p);
    drawChrome(p, nowMs, posMs / Math.max(1, song?.durationMs ?? 0));
    if (!painted) { painted = true; const cb = paintedCb; paintedCb = undefined; cb?.(); }
  };

  const prepareSong = (next: GeoSong | null): void => {
    song = next;
    if (!next || !next.lines.length) { shots = []; return; }
    const rng = mulberry32(hashString(next.trackKey ?? 'zilux-geo-v2'));
    shots = compileShots(next, rng);
    if (width > 0) recomputeGlyphs();
  };

  applySize(); buildTextures();

  const obs = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (applySize()) { buildTextures(); render(lastPos); } })
    : null;
  obs?.observe(root);

  return {
    root,
    setStyle(next: Partial<GeoStyleSettings>): void {
      settings = normalizeGeoSettings({ ...settings, ...next });
      glyphW.clear(); recomputeGlyphs(); buildTextures(); render(lastPos);
    },
    setLyricTint(next: GeoLyricTint | null): void {
      tint = next ? { mode: next.mode, palette: [...next.palette] } : null;
    },
    setSong(next: GeoSong | null): void { prepareSong(next); render(lastPos); },
    update(posMs: number, playing: boolean, energy = 0): void {
      lastPos = Number.isFinite(posMs) ? Math.max(0, posMs) : 0;
      const target = playing ? clamp(energy, 0, 1) : 0;
      energySmooth += (target - energySmooth) * (target > energySmooth ? 0.52 : 0.1);
      render(lastPos);
    },
    resize(): void { applySize(); buildTextures(); },
    dispose(): void { disposed = true; obs?.disconnect(); root.remove(); },
  };
}
