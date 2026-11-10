import type { LumiereSongInput } from './lumiere';
import { poemActiveIndex, poemCamera, poemClamp, poemEase } from './poemMotion';

type RGB = [number, number, number];
type Span = { start: number; end: number; x: number; width: number };
type Row = { text: string; y: number; width: number; spans: Span[] };
type Layout = { rows: Row[]; translations: string[]; font: number; height: number };
const fallback: RGB[] = [[100, 155, 172], [172, 121, 175], [215, 170, 116]];
const color = (c: RGB, alpha = 1) => `rgba(${c.map(Math.round).join(',')},${alpha})`;
const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => v + (b[i] - v) * t) as RGB;

/** A single persistent silk field and a continuous camera shared by all lyric lines. */
export function createPoemScene() {
  const root = document.createElement('div');
  root.className = 'zl-poem-scene';
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#080e19';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '长镜流诗');
  root.append(canvas);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('长镜流诗无法创建画布');
  const context = ctx;
  const silk = document.createElement('canvas');
  silk.width = 640; silk.height = 360;
  const field = silk.getContext('2d', { alpha: false })!;
  let song: LumiereSongInput | null = null;
  let starts: number[] = [], layouts = new Map<number, Layout>();
  let width = 0, height = 0, ratio = 1, disposed = false;
  let palette = fallback, paletteFrom = fallback, paletteTo = fallback, paletteAt = -Infinity;
  let lastPosition = 0, lastAmbience = 0, lastLabel = '';
  let dirty = true;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const family = '"Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif';

  function resize() {
    const bounds = root.getBoundingClientRect();
    const nextRatio = Math.min(2, window.devicePixelRatio || 1);
    if (bounds.width === width && bounds.height === height && ratio === nextRatio) return;
    width = bounds.width; height = bounds.height; ratio = nextRatio;
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    layouts.clear();
    dirty = true;
  }

  function layout(index: number): Layout {
    const existing = layouts.get(index);
    if (existing) return existing;
    const line = song!.lines[index], maxWidth = width * 0.76;
    let font = Math.max(18, Math.min(56, width * 0.047, height * 0.078));
    // Timed words retain their real timestamps. Plain LRC gets a gentle within-line sweep.
    const timed = line.words.length > 0 && line.words.map(w => `${w.spaceBefore ? ' ' : ''}${w.text}`).join('').replace(/\s/g, '') === line.text.replace(/\s/g, '');
    const parts = timed ? line.words.map(w => ({ text: `${w.spaceBefore ? ' ' : ''}${w.text}`, start: w.startMs, end: w.endMs }))
      : [{ text: line.text, start: line.timeMs, end: line.timeMs + Math.max(1, line.durationMs) }];
    const glyphs = parts.flatMap(part => {
      const chars = Array.from(part.text);
      return chars.map((text, i) => ({ text, start: part.start + (part.end - part.start) * i / chars.length, end: part.start + (part.end - part.start) * (i + 1) / chars.length }));
    });
    let rows: Row[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      context.font = `500 ${font}px ${family}`;
      rows = [{ text: '', y: 0, width: 0, spans: [] }];
      for (let glyphIndex = 0; glyphIndex < glyphs.length; glyphIndex++) {
        const glyph = glyphs[glyphIndex];
        let row = rows[rows.length - 1];
        let nextWidth = context.measureText(row.text + glyph.text).width;
        let wordWidth = 0;
        if (/[a-z0-9]/i.test(glyph.text) && (glyphIndex === 0 || !/[a-z0-9']/i.test(glyphs[glyphIndex - 1].text))) {
          let word = glyph.text;
          for (let j = glyphIndex + 1; j < glyphs.length && /[a-z0-9']/i.test(glyphs[j].text); j++) word += glyphs[j].text;
          wordWidth = context.measureText(word).width;
        }
        if (row.text && (nextWidth > maxWidth || (wordWidth <= maxWidth && row.width + wordWidth > maxWidth))) {
          row = { text: '', y: rows.length * font * 1.36, width: 0, spans: [] };
          rows.push(row); nextWidth = context.measureText(glyph.text).width;
        }
        row.spans.push({ start: glyph.start, end: glyph.end, x: row.width, width: nextWidth - row.width });
        row.text += glyph.text; row.width = nextWidth;
      }
      if (rows.length * font * 1.36 < height * 0.32 || font <= 14) break;
      font = Math.max(14, font * 0.82);
    }
    const translations: string[] = [];
    context.font = `400 ${Math.max(12, font * 0.34)}px ${family}`;
    for (const char of Array.from(line.translation || '')) {
      if (!translations.length) translations.push('');
      const n = translations.length - 1;
      if (context.measureText(translations[n] + char).width > maxWidth) translations.push(char);
      else translations[n] += char;
    }
    const result = { rows, translations, font, height: rows.length * font * 1.36 };
    layouts.set(index, result);
    return result;
  }

  function background(time: number, camera: number, now: number) {
    const t = reduced.matches ? 0 : time / 1000;
    palette = paletteFrom.map((c, i) => mix(c, paletteTo[i], poemEase((now - paletteAt) / 2400)));
    field.fillStyle = '#080e19'; field.fillRect(0, 0, 640, 360);
    for (let layer = 0; layer < 3; layer++) {
      const x = 320 + Math.sin(t * 0.07 + layer * 2.1) * 230;
      const y = 170 + Math.cos(t * 0.09 + layer) * 115;
      const glow = field.createRadialGradient(x, y, 0, x, y, 370);
      glow.addColorStop(0, color(palette[layer], 0.24)); glow.addColorStop(1, color(palette[layer], 0));
      field.fillStyle = glow; field.fillRect(0, 0, 640, 360);
    }
    // Adjacent translucent bands form broad silk folds, without a full-resolution blur pass.
    for (let layer = 0; layer < 3; layer++) {
      for (let strip = 0; strip < 22; strip++) {
        const band = strip / 22, drift = reduced.matches ? 0 : Math.sin(camera * 0.24) * 12;
        const base = 80 + layer * 88 + (band - 0.5) * 92 + drift;
        const wave = Math.sin(t * 0.13 + layer * 1.8) * 65;
        field.beginPath();
        field.moveTo(-50, base + wave);
        field.bezierCurveTo(130, base - 115 + Math.sin(t * 0.1 + layer) * 45, 390, base + 120 + wave, 690, base - 65);
        field.lineTo(690, base - 60);
        field.bezierCurveTo(390, base + 125 + wave, 130, base - 110 + Math.sin(t * 0.1 + layer) * 45, -50, base + wave + 5);
        field.closePath();
        field.fillStyle = color(palette[layer], Math.sin(band * Math.PI) ** 3 * 0.11);
        field.fill();
      }
    }
    const shade = field.createRadialGradient(320, 170, 30, 320, 170, 365);
    shade.addColorStop(0, 'rgba(5,10,19,.12)'); shade.addColorStop(1, 'rgba(5,10,19,.72)');
    field.fillStyle = shade; field.fillRect(0, 0, 640, 360);
    context.drawImage(silk, 0, 0, width, height);
  }

  function update(position: number, ambience = position) {
    if (disposed) return;
    resize();
    const nextPosition = Number.isFinite(position) ? position : 0;
    const nextAmbience = Number.isFinite(ambience) ? ambience : 0;
    if (!dirty && nextPosition === lastPosition && nextAmbience === lastAmbience && performance.now() - paletteAt > 2400) return;
    lastPosition = nextPosition; lastAmbience = nextAmbience; dirty = false;
    if (width < 1 || height < 1) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const time = lastPosition + (song?.lyricOffsetMs || 0);
    const camera = poemCamera(starts, time), active = poemActiveIndex(starts, time);
    background(lastAmbience, camera, performance.now());
    const label = song?.lines[active]?.text || song?.title || '长镜流诗';
    if (label !== lastLabel) { canvas.setAttribute('aria-label', label); lastLabel = label; }
    const entrance = starts.length ? poemEase((time - starts[0] + 1800) / 1400) : 0;
    if (!song || !starts.length || entrance < 1) {
      context.globalAlpha = 1 - entrance;
      context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillStyle = '#f0ede7';
      context.font = `500 ${Math.max(22, Math.min(44, width * 0.055))}px ${family}`;
      context.fillText(song?.title || '长镜流诗', width / 2, height * 0.46, width * 0.8);
      context.font = `400 ${Math.max(12, Math.min(17, width * 0.022))}px ${family}`;
      context.fillStyle = '#a9b4c3';
      context.fillText(song?.artist || '等待音乐', width / 2, height * 0.46 + 46, width * 0.8);
      context.globalAlpha = 1;
      if (!song || !starts.length || entrance === 0) return;
    }
    const center = Math.round(camera);
    for (const index of layouts.keys()) if (Math.abs(index - center) > 5) layouts.delete(index);
    for (let index = Math.max(0, center - 3); index <= Math.min(starts.length - 1, center + 3); index++) {
      const distance = index - camera, focus = Math.exp(-distance * distance * 2.6);
      const item = layout(index), { font } = item;
      const scale = 0.82 + 0.18 * focus;
      const x = width / 2 + (reduced.matches ? 0 : (Math.sin(index * 0.67) - Math.sin(camera * 0.67)) * width * 0.055);
      const y = height * 0.46 + distance * height * 0.40;
      const edgeFade = poemEase((y - height * 0.08) / (height * 0.14)) * poemEase((height * 0.94 - y) / (height * 0.14));
      const alpha = entrance * Math.exp(-Math.abs(distance) * 1.35) * edgeFade;
      if (alpha < 0.001) continue;
      context.save(); context.translate(x, y); context.scale(scale, scale);
      context.globalAlpha = alpha;
      context.font = `500 ${font}px ${family}`; context.textAlign = 'left'; context.textBaseline = 'middle';
      for (const row of item.rows) {
        const left = -row.width / 2, top = row.y - (item.height - font * 1.36) / 2;
        context.fillStyle = '#8896aa'; context.fillText(row.text, left, top);
        context.save(); context.beginPath();
        for (const span of row.spans) {
          const progress = poemClamp((time - span.start) / Math.max(1, span.end - span.start));
          if (progress <= 0) continue;
          context.rect(left + span.x - 0.5, top - font, span.width * progress + 0.5, font * 2);
        }
        context.clip(); context.fillStyle = '#fff7e9'; context.fillText(row.text, left, top); context.restore();
      }
      context.globalAlpha = alpha * (0.35 + focus * 0.65);
      context.font = `400 ${Math.max(12, font * 0.34)}px ${family}`;
      context.textAlign = 'center'; context.fillStyle = '#bac4d2';
      item.translations.forEach((text, i) => context.fillText(text, 0, item.height / 2 + font * 0.5 + i * Math.max(17, font * 0.48)));
      context.restore();
    }
  }
  const observer = new ResizeObserver(() => update(lastPosition, lastAmbience));
  observer.observe(root);
  const fontsReady = () => { layouts.clear(); dirty = true; update(lastPosition, lastAmbience); };
  const motionChanged = () => { dirty = true; update(lastPosition, lastAmbience); };
  reduced.addEventListener('change', motionChanged);
  document.fonts.addEventListener('loadingdone', fontsReady);
  return {
    root, update,
    setSong(input: LumiereSongInput | null) {
      const lines: Array<LumiereSongInput['lines'][number]> = [];
      for (const line of [...(input?.lines ?? [])].filter(line => line.text.trim() && Number.isFinite(line.timeMs)).sort((a, b) => a.timeMs - b.timeMs)) {
        const previous = lines.at(-1);
        if (previous?.timeMs === line.timeMs) {
          lines[lines.length - 1] = { ...previous, text: `${previous.text} ${line.text}`, translation: [previous.translation, line.translation].filter(Boolean).join(' / '), durationMs: Math.max(previous.durationMs, line.durationMs), words: [...previous.words, ...line.words] };
        } else lines.push(line);
      }
      song = input ? { ...input, lines } : null;
      starts = song?.lines.map(line => line.timeMs) ?? []; layouts.clear(); dirty = true;
    },
    setPalette(colors: string[]) {
      const valid = colors.filter(c => /^#[0-9a-f]{6}$/i.test(c));
      const next = valid.length ? Array.from({ length: 3 }, (_, i) => {
        const hex = valid[i % valid.length];
        return [1, 3, 5].map(n => parseInt(hex.slice(n, n + 2), 16)) as RGB;
      }) : fallback;
      if (JSON.stringify(next) === JSON.stringify(paletteTo)) return;
      paletteFrom = palette.map(c => [...c] as RGB); paletteTo = next; paletteAt = performance.now();
    },
    dispose() { disposed = true; observer.disconnect(); document.fonts.removeEventListener('loadingdone', fontsReady); reduced.removeEventListener('change', motionChanged); layouts.clear(); canvas.width = canvas.height = 1; root.remove(); },
  };
}
