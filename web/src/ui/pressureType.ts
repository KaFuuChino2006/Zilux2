import type { PressureEntrance } from './pressureChoreography';
import { pressureGlyphMotion, pressurePhraseMotion } from './pressureChoreography';
import {
  pressureClamp,
  pressureEase,
  pressureOut,
  type PressurePhrase,
} from './pressureProgram';

/**
 * Typesetting for the Pressure stage.
 *
 * The stage does not use DOM text: every glyph is measured, wrapped and placed
 * on the canvas so the camera can cut through it without layout reflow. This
 * module owns the typographic rules (fit, tracking, wrapping, vertical columns,
 * glyph entrances, reveals, outlines and perspective strips).
 */

export const PRESSURE_FONT =
  '"Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif';

export const PRESSURE_MONO =
  '"Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace';

export interface PressureTextLayout {
  font: number;
  rows: string[];
  widths: number[];
  lineHeight: number;
  height: number;
  tracking: number;
}

export interface PressureTextOptions {
  fill: string;
  stroke?: boolean;
  weight?: number;
  align?: CanvasTextAlign;
  tracking?: number;
  lineHeight?: number;
  mono?: boolean;
  alpha?: number;
  accent?: string;
  accentProgress?: number;
  glow?: string;
  glowAmount?: number;
}

export interface PressurePhraseOptions extends PressureTextOptions {
  entrance: PressureEntrance;
  reveal?: number;
  glyphScale?: number;
  glyphDrift?: number;
  outlineMix?: number;
}

export interface PressurePlaneOptions {
  /** Horizontal perspective: -1 left edge recedes, 1 right edge recedes. */
  yaw: number;
  /** Vertical perspective. */
  pitch: number;
  /** Strips improve the approximation; 18–32 is enough at 1080p. */
  strips?: number;
  alpha?: number;
  clip?: (context: CanvasRenderingContext2D) => void;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

const graphemes = (text: string): string[] =>
  [...graphemeSegmenter.segment(text)].map((part) => part.segment);

const words = (text: string): string[] =>
  [...wordSegmenter.segment(text)].map((part) => part.segment);

/**
 * A measure/draw engine with a bounded cache. A single engine is created per
 * scene resize, so cache keys can omit the viewport size.
 */
export class PressureTypeEngine {
  private cache = new Map<string, PressureTextLayout>();
  private compositionCache = new Map<string, HTMLCanvasElement>();
  private width = 1;
  private context: CanvasRenderingContext2D;

  constructor(context: CanvasRenderingContext2D, width: number, _height: number) {
    this.context = context;
    this.width = Math.max(1, width);
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    void height;
    this.cache.clear();
    this.compositionCache.clear();
  }

  dispose(): void {
    this.cache.clear();
    this.compositionCache.clear();
  }

  /**
   * Fit a phrase into a box using whole-word wrapping where possible. The
   * algorithm first picks a font size from the longest unbreakable unit, then
   * repeatedly reduces until the wrapped block fits both dimensions.
   */
  layout(
    text: string,
    maxWidth: number,
    maxHeight: number,
    weight = 900,
    tracking = 0,
    mono = false,
  ): PressureTextLayout {
    const safeWidth = Math.max(1, maxWidth);
    const safeHeight = Math.max(1, maxHeight);
    const key = `${text}\u0000${safeWidth.toFixed(1)}\u0000${safeHeight.toFixed(1)}\u0000${weight}\u0000${tracking.toFixed(2)}\u0000${mono}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const fontFamily = mono ? PRESSURE_MONO : PRESSURE_FONT;
    const units = words(text);
    let font = Math.min(safeHeight * 0.9, this.width * 0.3);
    const context = this.context;
    context.font = `${weight} ${font}px ${fontFamily}`;
    const longest = Math.max(
      1,
      ...units.map((unit) => this.measureUnit(unit, tracking, font, weight, mono)),
    );
    font = Math.min(font, (font * safeWidth) / longest);

    let rows: string[] = [];
    for (let attempt = 0; attempt < 28; attempt += 1) {
      context.font = `${weight} ${font}px ${fontFamily}`;
      rows = [''];
      for (const unit of units) {
        if (this.measureUnit(unit, tracking, font, weight, mono) > safeWidth) {
          for (const glyph of graphemes(unit)) {
            const last = rows[rows.length - 1];
            if (last && this.measureUnit(last + glyph, tracking, font, weight, mono) > safeWidth) {
              rows.push('');
            }
            rows[rows.length - 1] += glyph;
          }
        } else {
          const last = rows[rows.length - 1];
          if (last && this.measureUnit(last + unit, tracking, font, weight, mono) > safeWidth) {
            rows.push('');
          }
          rows[rows.length - 1] += unit;
        }
      }
      const height = rows.length * font * 1.08;
      if (height <= safeHeight) break;
      font *= 0.9;
    }

    context.font = `${weight} ${font}px ${fontFamily}`;
    const trimmed = rows.map((row) => row.trim());
    const layout: PressureTextLayout = {
      font,
      rows: trimmed,
      widths: trimmed.map((row) => this.measureUnit(row, tracking, font, weight, mono)),
      lineHeight: font * 1.08,
      height: trimmed.length * font * 1.08,
      tracking,
    };
    if (this.cache.size > 220) {
      const first = this.cache.keys().next().value;
      if (first) this.cache.delete(first);
    }
    this.cache.set(key, layout);
    return layout;
  }

  private measureUnit(
    text: string,
    tracking: number,
    font: number,
    weight: number,
    mono: boolean,
  ): number {
    if (!text) return 0;
    const context = this.context;
    context.font = `${weight} ${font}px ${mono ? PRESSURE_MONO : PRESSURE_FONT}`;
    return context.measureText(text).width + Math.max(0, text.length - 1) * tracking * font;
  }

  /** Plain, layout-only text. Used for captions and metadata. */
  draw(
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    maxHeight: number,
    options: PressureTextOptions,
  ): PressureTextLayout {
    const layout = this.layout(
      text,
      maxWidth,
      maxHeight,
      options.weight ?? 900,
      options.tracking ?? 0,
      options.mono ?? false,
    );
    const family = options.mono ? PRESSURE_MONO : PRESSURE_FONT;
    context.save();
    context.globalAlpha *= options.alpha ?? 1;
    context.font = `${options.weight ?? 900} ${layout.font}px ${family}`;
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.fillStyle = options.fill;
    context.strokeStyle = options.fill;
    context.lineWidth = Math.max(1, layout.font * 0.012);
    if (options.glow && options.glowAmount) {
      context.shadowColor = options.glow;
      context.shadowBlur = layout.font * options.glowAmount;
    }
    layout.rows.forEach((row, index) => {
      const width = layout.widths[index];
      const left =
        options.align === 'left' ? x : options.align === 'right' ? x - width : x - width / 2;
      const top = y + (index - (layout.rows.length - 1) / 2) * layout.lineHeight;
      if (options.stroke) context.strokeText(row, left, top);
      else context.fillText(row, left, top);
      if (options.accent && options.accentProgress !== undefined) {
        const reveal = this.revealWidth(
          context,
          row,
          options.accentProgress,
          layout.font,
          options.weight ?? 900,
          options.mono ?? false,
        );
        if (reveal > 0) {
          context.save();
          context.beginPath();
          context.rect(left - 1, top - layout.font, reveal + 2, layout.font * 2);
          context.clip();
          context.fillStyle = options.accent;
          context.fillText(row, left, top);
          context.restore();
        }
      }
    });
    context.restore();
    return layout;
  }

  private revealWidth(
    context: CanvasRenderingContext2D,
    text: string,
    progress: number,
    font: number,
    weight: number,
    mono: boolean,
  ): number {
    const characters = graphemes(text);
    const reveal = pressureClamp(progress);
    let total = 0;
    let revealed = 0;
    context.font = `${weight} ${font}px ${mono ? PRESSURE_MONO : PRESSURE_FONT}`;
    for (let index = 0; index < characters.length; index += 1) {
      const width = context.measureText(characters[index]).width;
      total += width;
      if (index / Math.max(1, characters.length - 1) <= reveal) revealed = total;
    }
    return revealed;
  }

  /**
   * Phrase renderer with per-glyph transforms and a coloured singing reveal.
   * The phrase is positioned by its centre; line breaking happens first.
   */
  drawPhrase(
    context: CanvasRenderingContext2D,
    phrase: PressurePhrase,
    time: number,
    x: number,
    y: number,
    maxWidth: number,
    maxHeight: number,
    options: PressurePhraseOptions,
  ): void {
    const layout = this.layout(
      phrase.text,
      maxWidth,
      maxHeight,
      options.weight ?? 900,
      options.tracking ?? 0,
      options.mono ?? false,
    );
    const family = options.mono ? PRESSURE_MONO : PRESSURE_FONT;
    const motion = pressurePhraseMotion(phrase, time, false);
    const reveal = options.reveal ?? motion.reveal;
    const entrance = options.entrance;
    context.save();
    context.globalAlpha *= options.alpha ?? 1;

    if (motion.hidden) {
      context.globalAlpha *= 0.08;
      this.outlineRows(context, layout, x, y, options, family);
      context.restore();
      return;
    }

    const glyphCursor: number[] = [];
    let cursor = 0;
    for (const row of layout.rows) {
      const count = graphemes(row).length;
      for (let index = 0; index < count; index += 1) {
        glyphCursor.push(cursor);
        cursor += 1;
      }
    }

    let globalIndex = 0;
    layout.rows.forEach((row, rowIndex) => {
      const rowWidth = layout.widths[rowIndex];
      let left =
        options.align === 'left' ? x : options.align === 'right' ? x - rowWidth : x - rowWidth / 2;
      const top = y + (rowIndex - (layout.rows.length - 1) / 2) * layout.lineHeight;
      context.font = `${options.weight ?? 900} ${layout.font}px ${family}`;
      for (const glyphText of graphemes(row)) {
        const glyph = phrase.glyphs[globalIndex] ?? {
          text: glyphText,
          start: phrase.start,
          end: phrase.end,
          index: globalIndex,
          weight: 1,
          space: false,
          accent: 0.5,
        };
        const width = context.measureText(glyphText).width;
        const transform = pressureGlyphMotion(
          glyph,
          phrase,
          time,
          entrance,
          false,
        );
        const glyphCenterX = left + width / 2;
        const glyphCenterY = top;
        const scale = transform.scale * (options.glyphScale ?? 1);
        const alpha = transform.alpha * (options.alpha ?? 1);
        context.save();
        context.translate(
          glyphCenterX + transform.x * (options.glyphDrift ?? 1) * layout.font * 0.55,
          glyphCenterY + transform.y * layout.font * 0.55,
        );
        context.rotate(transform.rotation);
        context.transform(1, 0, transform.skew, 1, 0, 0);
        context.scale(scale, scale);
        context.globalAlpha *= pressureClamp(alpha);
        context.font = `${options.weight ?? 900} ${layout.font}px ${family}`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = options.fill;
        context.strokeStyle = options.fill;
        context.lineWidth = Math.max(1, layout.font * 0.012);
        if (options.glow && options.glowAmount) {
          context.shadowColor = options.glow;
          context.shadowBlur = layout.font * options.glowAmount;
        }
        const glyphProgress = pressureClamp(
          (time - glyph.start + 70) / Math.max(1, glyph.end - glyph.start),
        );
        if (options.accent && glyphProgress > 0.42) {
          context.fillStyle = options.accent;
        }
        if (options.stroke) context.strokeText(glyphText, 0, 0);
        else context.fillText(glyphText, 0, 0);
        if (options.outlineMix && options.outlineMix > 0) {
          context.globalAlpha *= 1 - options.outlineMix;
          context.strokeStyle = options.accent ?? options.fill;
          context.strokeText(glyphText, 0, 0);
        }
        context.restore();
        left += width + layout.tracking * layout.font;
        globalIndex += 1;
      }
      // reset to the next row's glyph cursor; the phrase is laid out row-major.
      if (row.length === 0) globalIndex += 0;
    });

    // A thin singing rule under the active phrase; it reads as a karaoke guide
    // without looking like a subtitle UI.
    if (options.accent && reveal > 0) {
      context.save();
      context.globalAlpha *= 0.42;
      context.fillStyle = options.accent;
      const width = Math.max(8, layout.widths[0] * reveal);
      context.fillRect(x - layout.widths[0] / 2, y + layout.height / 2 + layout.font * 0.18, width, Math.max(2, layout.font * 0.018));
      context.restore();
    }
    context.restore();
    void glyphCursor;
    void pressureOut;
    void pressureEase;
  }

  private outlineRows(
    context: CanvasRenderingContext2D,
    layout: PressureTextLayout,
    x: number,
    y: number,
    options: PressurePhraseOptions,
    family: string,
  ): void {
    context.save();
    context.font = `${options.weight ?? 900} ${layout.font}px ${family}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.strokeStyle = options.fill;
    context.lineWidth = Math.max(1, layout.font * 0.01);
    layout.rows.forEach((row, index) => {
      const top = y + (index - (layout.rows.length - 1) / 2) * layout.lineHeight;
      context.strokeText(row, x, top);
    });
    context.restore();
  }

  /** Vertical Chinese columns, read right to left. */
  drawColumns(
    context: CanvasRenderingContext2D,
    phrases: PressurePhrase[],
    x: number,
    y: number,
    columnGap: number,
    fontSize: number,
    options: PressureTextOptions,
  ): void {
    context.save();
    context.font = `${options.weight ?? 900} ${fontSize}px ${PRESSURE_FONT}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = options.fill;
    const characters = phrases.flatMap((phrase) => graphemes(phrase.text));
    const perColumn = 6;
    for (let index = 0; index < characters.length; index += 1) {
      const column = Math.floor(index / perColumn);
      const row = index % perColumn;
      const char = characters[index];
      if (!char || char === ' ') continue;
      context.globalAlpha = options.alpha ?? 1;
      context.fillText(char, x - column * columnGap, y + row * fontSize * 1.05);
    }
    context.restore();
  }

  /** A field of repeated hero text used as a stage backdrop. */
  drawField(
    context: CanvasRenderingContext2D,
    text: string,
    time: number,
    x: number,
    y: number,
    width: number,
    height: number,
    options: PressureTextOptions & { rows?: number; columns?: number; offset?: number },
  ): void {
    const rows = options.rows ?? 8;
    const columns = options.columns ?? 3;
    const fontSize = Math.max(12, height / rows * 0.72);
    context.save();
    context.font = `${options.weight ?? 900} ${fontSize}px ${PRESSURE_FONT}`;
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.fillStyle = options.fill;
    const offset = options.offset ?? 0;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const drift = Math.sin(time / 2200 + row * 0.7) * fontSize * 0.3;
        context.globalAlpha = (options.alpha ?? 1) * (0.2 + (row / rows) * 0.55);
        context.fillText(text, x + column * width * 0.32 + drift + offset, y + row * fontSize * 1.05);
      }
    }
    context.restore();
  }

  /**
   * Draw a text plane in coarse 3D by slicing it into vertical strips and
   * varying each strip's scale. The result is intentionally graphic, not a
   * physically correct 3D renderer: it gives the tunnel / perspective shots
   * real convergence without WebGL dependencies.
   */
  drawPlane(
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
    options: PressureTextOptions & PressurePlaneOptions,
  ): void {
    const offscreen = this.compositionCache.get(text);
    let source = offscreen;
    if (!source) {
      source = document.createElement('canvas');
      const scale = Math.min(2, window.devicePixelRatio || 1);
      source.width = Math.max(1, Math.round(width * scale));
      source.height = Math.max(1, Math.round(height * scale));
      const target = source.getContext('2d');
      if (target) {
        target.scale(scale, scale);
        target.textAlign = 'center';
        target.textBaseline = 'middle';
        const layout = this.layout(text, width * 0.92, height * 0.9, options.weight ?? 900, options.tracking ?? 0);
        target.font = `${options.weight ?? 900} ${layout.font}px ${PRESSURE_FONT}`;
        target.fillStyle = options.fill;
        layout.rows.forEach((row, rowIndex) => {
          target.fillText(
            row,
            width / 2,
            height / 2 + (rowIndex - (layout.rows.length - 1) / 2) * layout.lineHeight,
          );
        });
      }
      if (this.compositionCache.size > 18) {
        const first = this.compositionCache.keys().next().value;
        if (first) this.compositionCache.delete(first);
      }
      this.compositionCache.set(text, source);
    }

    const strips = Math.max(8, Math.min(40, options.strips ?? 24));
    context.save();
    context.globalAlpha *= options.alpha ?? 1;
    if (options.clip) options.clip(context);
    for (let strip = 0; strip < strips; strip += 1) {
      const u0 = strip / strips;
      const u1 = (strip + 1) / strips;
      const pitch0 = 1 + options.pitch * (u0 - 0.5);
      const pitch1 = 1 + options.pitch * (u1 - 0.5);
      const sx = source.width * u0;
      const sw = Math.max(1, source.width * (u1 - u0) + 1);
      const dx = x - width / 2 + width * u0;
      const dy = y - height * 0.5 * pitch0;
      const dw = width * (u1 - u0) + 1;
      const dh = height * pitch0;
      const skew = (u0 - 0.5) * options.yaw * height * 0.5;
      context.save();
      context.transform(1, skew / Math.max(1, height), 0, pitch1 / Math.max(0.2, pitch0), 0, 0);
      context.drawImage(source, sx, 0, sw, source.height, dx, dy, dw, dh);
      context.restore();
    }
    context.restore();
  }

  /** Big outlined ghost type, used behind the hero. */
  drawGhost(
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    maxHeight: number,
    color: string,
    alpha = 0.12,
  ): void {
    const layout = this.layout(text, maxWidth, maxHeight, 900, 0);
    context.save();
    context.globalAlpha *= alpha;
    context.font = `900 ${layout.font}px ${PRESSURE_FONT}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.strokeStyle = color;
    context.lineWidth = Math.max(1, layout.font * 0.008);
    layout.rows.forEach((row, index) => {
      context.strokeText(row, x, y + (index - (layout.rows.length - 1) / 2) * layout.lineHeight);
    });
    context.restore();
  }

  /** Small technical labels with tracking. */
  drawMono(
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    size: number,
    color: string,
    align: CanvasTextAlign = 'left',
    alpha = 1,
  ): void {
    context.save();
    context.font = `500 ${Math.max(8, size)}px ${PRESSURE_MONO}`;
    context.fillStyle = color;
    context.globalAlpha *= alpha;
    context.textAlign = align;
    context.textBaseline = 'middle';
    context.fillText(text.toUpperCase(), x, y);
    context.restore();
  }

  /** Dot-matrix / halftone type made from circles. */
  drawHalftone(
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
    alpha: number,
    time: number,
  ): void {
    const source = document.createElement('canvas');
    source.width = 240;
    source.height = 120;
    const target = source.getContext('2d');
    if (!target) return;
    target.fillStyle = '#fff';
    target.textAlign = 'center';
    target.textBaseline = 'middle';
    target.font = `900 92px ${PRESSURE_FONT}`;
    target.fillText(text, 120, 62);
    const data = target.getImageData(0, 0, source.width, source.height).data;
    context.save();
    context.globalAlpha *= alpha;
    context.fillStyle = color;
    const step = 4;
    for (let py = 0; py < source.height; py += step) {
      for (let px = 0; px < source.width; px += step) {
        const value = data[(py * source.width + px) * 4 + 3];
        if (value < 40) continue;
        const radius = (value / 255) * (width / 240) * 1.5;
        const wobble = Math.sin(time / 700 + px * 0.02) * radius * 0.18;
        context.beginPath();
        context.arc(
          x + (px / source.width - 0.5) * width + wobble,
          y + (py / source.height - 0.5) * height,
          Math.max(0.4, radius),
          0,
          Math.PI * 2,
        );
        context.fill();
      }
    }
    context.restore();
  }

  /** Draw a phrase with the final line tracked to a shared baseline. */
  drawTrackedLine(
    context: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    size: number,
    tracking: number,
    color: string,
    alpha = 1,
  ): void {
    context.save();
    context.font = `900 ${size}px ${PRESSURE_FONT}`;
    context.fillStyle = color;
    context.globalAlpha *= alpha;
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    const characters = graphemes(text);
    const widths = characters.map((char) => context.measureText(char).width);
    const total = widths.reduce((sum, item) => sum + item, 0) + tracking * (characters.length - 1);
    let cursor = x - total / 2;
    characters.forEach((char, index) => {
      context.fillText(char, cursor, y);
      cursor += widths[index] + tracking;
    });
    context.restore();
  }

  /**
   * A stage-safe measurement helper for composition code that only needs the
   * biggest font size that will not overflow.
   */
  fitSize(text: string, width: number, height: number, weight = 900): number {
    return this.layout(text, width, height, weight, 0).font;
  }

  /** Preload the typeface before the first frame when the browser supports it. */
  async warm(): Promise<void> {
    if (!('fonts' in document)) return;
    try {
      await document.fonts.load(`900 48px ${PRESSURE_FONT}`);
      await document.fonts.load(`500 20px ${PRESSURE_MONO}`);
    } catch {
      // A missing font is not fatal; the canvas falls back to the same stack.
    }
  }
}

export const pressureText = (
  engine: PressureTypeEngine,
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  options: PressureTextOptions,
): void => {
  engine.draw(context, text, x, y, width, height, options);
};
