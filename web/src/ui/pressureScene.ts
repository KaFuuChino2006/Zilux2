import type { LumiereSongInput } from './lumiere';
import {
  compilePressure,
  pressureIndex,
  pressureEase,
  pressureTransition,
  type PressureShot,
  type PressureTransition,
} from './pressureProgram';
import { pressureCamera, type PressureCamera } from './pressureCamera';
import { pressureCue } from './pressureChoreography';
import {
  drawPressureArt,
  drawPressureInterludeArt,
  type PressureColors,
} from './pressureArt';
import { drawComposition } from './pressureCompositions';
import { PressureTypeEngine } from './pressureType';

const INK = '#111111';
const PAPER = '#f1ecdf';
const ACCENT = '#ff4f27';
const COLD = '#1a2228';
const COLD_INK = '#dde3e6';

/**
 * 声压 — a concert-opening kinetic typography stage.
 *
 * The scene owns only presentation: clock, camera, layers, transitions and
 * metadata. The edit lives in pressureProgram, the layouts in
 * pressureCompositions, and the type in pressureType. This keeps the frame
 * logic deterministic and reviewable while allowing a very large visual surface.
 */
export function createPressureScene() {
  const root = document.createElement('div');
  root.className = 'zl-pressure-scene';
  root.style.cssText = `position:absolute;inset:0;overflow:hidden;background:${INK}`;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '声压 · 文字 PV');
  root.append(canvas);
  const ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;
  if (!ctx) throw new Error('声压无法创建画布');
  const layers = [document.createElement('canvas'), document.createElement('canvas')];
  const layerContexts = layers.map((layer) => {
    const result = layer.getContext('2d', { alpha: false });
    if (!result) throw new Error('声压无法创建转场画布');
    return result;
  });
  const typeEngines = [new PressureTypeEngine(ctx, 1, 1), new PressureTypeEngine(layerContexts[0], 1, 1), new PressureTypeEngine(layerContexts[1], 1, 1)];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let song: LumiereSongInput | null = null;
  let shots: PressureShot[] = [];
  let width = 0;
  let height = 0;
  let ratio = 1;
  let disposed = false;
  let dirty = true;
  let lastTime = NaN;
  let lastPower = 0;
  let lastLabel = '';
  let renderedShots: number[] = [];
  let camera: PressureCamera = { x: 0, y: 0, zoom: 1, rotation: 0, skew: 0, shakeX: 0, shakeY: 0, punch: 0, travel: 0 };

  const palette = (shot: PressureShot): PressureColors => {
    if (shot.theme === 'paper') {
      return { ink: INK, paper: PAPER, accent: ACCENT, soft: '#5f5b55', hard: INK, wash: 'rgba(0,0,0,.08)' };
    }
    if (shot.theme === 'accent') {
      return { ink: INK, paper: ACCENT, accent: PAPER, soft: '#ff8d70', hard: INK, wash: 'rgba(0,0,0,.12)' };
    }
    if (shot.theme === 'cold') {
      return { ink: COLD_INK, paper: COLD, accent: '#ff6a3d', soft: '#9ba9ad', hard: COLD_INK, wash: 'rgba(255,255,255,.08)' };
    }
    if (shot.theme === 'split') {
      return { ink: INK, paper: PAPER, accent: ACCENT, soft: '#6c675e', hard: INK, wash: 'rgba(0,0,0,.08)' };
    }
    return { ink: PAPER, paper: INK, accent: ACCENT, soft: '#a09b8f', hard: PAPER, wash: 'rgba(255,255,255,.08)' };
  };

  function resize(): void {
    const rect = root.getBoundingClientRect();
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    if (width === rect.width && height === rect.height && ratio === dpr) return;
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    ratio = dpr;
    for (const target of [canvas, ...layers]) {
      target.width = Math.max(1, Math.round(width * ratio));
      target.height = Math.max(1, Math.round(height * ratio));
    }
    typeEngines.forEach((engine) => engine.setSize(width, height));
    dirty = true;
  }

  function stageTransform(c: CanvasRenderingContext2D): void {
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    c.translate(width * (0.5 + camera.x + camera.shakeX), height * (0.48 + camera.y + camera.shakeY));
    if (Math.abs(camera.skew) > 0.0001) c.transform(1, 0, camera.skew, 1, 0, 0);
    c.rotate(camera.rotation);
    const zoom = camera.zoom * (1 + camera.punch * 0.035);
    c.scale(zoom, zoom);
    c.translate(-width * 0.5, -height * 0.48);
  }

  function drawBackdrop(c: CanvasRenderingContext2D, shot: PressureShot, colors: PressureColors, time: number): void {
    c.fillStyle = colors.paper;
    c.fillRect(0, 0, width, height);
    if (shot.theme === 'split') {
      c.save();
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(width * 0.52, 0);
      c.lineTo(width * 0.42, height);
      c.lineTo(0, height);
      c.closePath();
      c.fillStyle = INK;
      c.globalAlpha = 0.94;
      c.fill();
      c.restore();
    }
    if (shot.theme === 'accent') {
      c.save();
      c.globalAlpha = 0.08;
      c.fillStyle = INK;
      for (let index = 0; index < 8; index += 1) {
        c.fillRect(0, height * (0.12 + index * 0.1), width, height * 0.012);
      }
      c.restore();
    }
    // A subtle projector gate keeps pure black from feeling flat without adding fog.
    c.save();
    const vignette = c.createRadialGradient(width * 0.5, height * 0.45, width * 0.18, width * 0.5, height * 0.48, width * 0.72);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, shot.theme === 'paper' ? 'rgba(0,0,0,0.08)' : 'rgba(0,0,0,0.23)');
    c.fillStyle = vignette;
    c.fillRect(0, 0, width, height);
    c.restore();
    if (!reduced.matches) {
      c.save();
      c.globalAlpha = 0.035;
      c.fillStyle = colors.ink;
      c.fillRect(0, height * 0.5, width, 1);
      c.restore();
    }
    // A barely visible timeline keeps fast cuts readable in still captures.
    c.save();
    c.globalAlpha = 0.16;
    c.fillStyle = colors.ink;
    c.fillRect(width * 0.075, height * 0.91, width * 0.85, 1);
    c.fillStyle = colors.accent;
    c.fillRect(width * 0.075, height * 0.91, width * 0.85 * Math.min(1, (time - shot.start) / Math.max(1, shot.end - shot.start)), Math.max(2, height * 0.0022));
    c.restore();
  }

  function metadata(c: CanvasRenderingContext2D, shot: PressureShot, colors: PressureColors): void {
    const engine = typeEngines[0];
    engine.drawMono(c, song?.artist || 'ZILUX', width * 0.075, height * 0.075, Math.min(14, width * 0.009), colors.ink, 'left', 0.6);
    engine.drawMono(c, `声压 / ${shot.sectionName.toUpperCase()} / ${String(shot.number + 1).padStart(2, '0')}`, width * 0.925, height * 0.075, Math.min(11, width * 0.007), colors.ink, 'right', 0.45);
    if (shot.kicker) {
      engine.drawMono(c, shot.kicker, width * 0.075, height * 0.875, Math.min(12, width * 0.0075), colors.accent, 'left', 0.9);
    }
    engine.drawMono(c, 'PRESSURE / LIVE TYPE', width * 0.925, height * 0.875, Math.min(10, width * 0.006), colors.ink, 'right', 0.38);
    if (shot.translation) {
      engine.draw(c, shot.translation, width * 0.5, height * 0.94, width * 0.7, Math.min(18, height * 0.035), { fill: colors.ink, weight: 500, align: 'center', alpha: 0.5 });
    }
  }

  function drawFrame(c: CanvasRenderingContext2D, engineIndex: number, shot: PressureShot, time: number, power: number, transition = 0): void {
    const colors = palette(shot);
    const engine = typeEngines[engineIndex];
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    c.globalAlpha = 1;
    drawBackdrop(c, shot, colors, time);
    camera = pressureCamera(shot, time, width / height, reduced.matches);
    c.save();
    stageTransform(c);
    drawPressureArt(c, shot, time, width, height, colors, {
      reduced: reduced.matches,
      audio: power,
      transition,
    });
    drawComposition({
      context: c,
      type: engine,
      shot,
      time,
      width,
      height,
      colors,
      cue: pressureCue(shot, time),
      portrait: width / height < 1,
      reduced: reduced.matches,
    });
    c.restore();
    metadata(c, shot, colors);
  }

  function interlude(time: number): void {
    const colors: PressureColors = { ink: PAPER, paper: INK, accent: ACCENT, soft: '#9c978b', hard: PAPER, wash: 'rgba(255,255,255,.08)' };
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, width, height);
    drawPressureInterludeArt(ctx, time, width, height, colors);
    typeEngines[0].setSize(width, height);
    typeEngines[0].draw(ctx, song?.title || '声压', width * 0.37, height * 0.46, width * 0.55, height * 0.22, { fill: PAPER, weight: 950, align: 'center' });
    typeEngines[0].drawMono(ctx, 'WAITING FOR THE NEXT CUE', width * 0.075, height * 0.85, Math.min(11, width * 0.007), PAPER, 'left', 0.4);
    typeEngines[0].drawMono(ctx, song?.artist || 'ZILUX', width * 0.925, height * 0.85, Math.min(11, width * 0.007), PAPER, 'right', 0.4);
  }

  function drawTransition(c: CanvasRenderingContext2D, transition: PressureTransition, time: number, power: number): void {
    const from = shots[transition.from];
    const to = shots[transition.to];
    if (!from || !to) return;
    drawFrame(layerContexts[0], 1, from, time, power);
    drawFrame(layerContexts[1], 2, to, time, power, transition.progress);
    const p = transition.progress;
    const draw = (layer: number, x: number, y: number, w = width, h = height, alpha = 1): void => {
      c.save();
      c.globalAlpha = alpha;
      c.drawImage(layers[layer], x, y, w, h);
      c.restore();
    };
    const direction = transition.direction < 0 ? -1 : 1;
    switch (transition.kind) {
      case 'whip':
        draw(0, -width * p * direction, 0, width, height, 0.9);
        draw(1, width * direction * (1 - p), 0);
        c.save();
        c.globalAlpha = 0.8;
        c.fillStyle = ACCENT;
        c.fillRect(width * (direction > 0 ? 1 - p : p) - 3, 0, 6, height);
        c.restore();
        break;
      case 'punch': {
        const zoom = 1 + p * 0.22;
        draw(0, -width * (zoom - 1) / 2, -height * (zoom - 1) / 2, width * zoom, height * zoom, 1 - p);
        draw(1, 0, 0, width, height, p);
        break;
      }
      case 'slit': {
        draw(0, 0, 0);
        const edge = width * (1.2 - 1.4 * p);
        const slope = width * 0.18;
        c.save();
        c.beginPath();
        c.moveTo(edge - slope, 0);
        c.lineTo(width, 0);
        c.lineTo(width, height);
        c.lineTo(edge + slope, height);
        c.closePath();
        c.clip();
        draw(1, (1 - p) * width * 0.12, 0);
        c.restore();
        c.strokeStyle = ACCENT;
        c.lineWidth = Math.max(3, width * 0.006);
        c.beginPath();
        c.moveTo(edge - slope, 0);
        c.lineTo(edge + slope, height);
        c.stroke();
        break;
      }
      case 'shutter': {
        draw(1, 0, 0);
        const bands = 8;
        for (let band = 0; band < bands; band += 1) {
          if (band % 2) continue;
          const top = height * band / bands;
          const local = pressureEase((p - band * 0.04) / 0.7);
          c.save();
          c.beginPath();
          c.rect(0, top, width, height / bands);
          c.clip();
          draw(0, 0, -(1 - local) * height, width, height);
          c.restore();
        }
        break;
      }
      case 'fold': {
        draw(1, 0, 0);
        const fold = Math.abs(Math.cos(p * Math.PI));
        c.save();
        c.translate(width * 0.5, 0);
        c.scale(Math.max(0.002, fold), 1);
        c.translate(-width * 0.5, 0);
        draw(0, 0, 0);
        c.restore();
        c.save();
        c.globalAlpha = 0.8;
        c.fillStyle = ACCENT;
        c.fillRect(width * 0.5 - 2, 0, 4, height * (1 - p));
        c.restore();
        break;
      }
      case 'iris': {
        draw(1, 0, 0);
        const radius = Math.hypot(width, height) * pressureEase(p);
        c.save();
        c.beginPath();
        c.arc(width * 0.5, height * 0.47, radius, 0, Math.PI * 2);
        c.clip();
        draw(0, 0, 0);
        c.restore();
        c.strokeStyle = ACCENT;
        c.lineWidth = Math.max(3, width * 0.005);
        c.beginPath();
        c.arc(width * 0.5, height * 0.47, radius, 0, Math.PI * 2);
        c.stroke();
        break;
      }
      case 'glitch': {
        const bands = 12;
        for (let band = 0; band < bands; band += 1) {
          const top = height * band / bands;
          const offset = Math.sin(band * 7.3 + p * 20) * width * 0.06 * (1 - p);
          draw(p > 0.45 ? 0 : 1, offset, top - height * band / bands + height * band / bands, width, height / bands, band % 3 ? 0.8 : 1);
        }
        c.save();
        c.globalAlpha = 0.5;
        c.fillStyle = ACCENT;
        c.fillRect(0, height * (0.2 + p * 0.4), width, Math.max(2, height * 0.008));
        c.restore();
        break;
      }
      case 'panels': {
        draw(1, 0, 0);
        const panels = 6;
        for (let panel = 0; panel < panels; panel += 1) {
          const left = width * panel / panels;
          const local = pressureEase((p - panel * 0.05) / 0.6);
          c.save();
          c.beginPath();
          c.rect(left, 0, width / panels + 1, height);
          c.clip();
          draw(0, 0, (1 - local) * height * (panel % 2 ? 1 : -1));
          c.restore();
        }
        break;
      }
      case 'carry': {
        draw(0, -width * p * 0.7, 0);
        draw(1, width * (0.3 - p * 0.3), 0);
        break;
      }
      case 'wipe': {
        draw(0, 0, 0);
        const edge = width * (0.2 + p * 1.1);
        c.save();
        c.beginPath();
        c.moveTo(edge, 0);
        c.lineTo(width, 0);
        c.lineTo(width, height);
        c.lineTo(edge - width * 0.16, height);
        c.closePath();
        c.clip();
        draw(1, 0, 0);
        c.restore();
        c.strokeStyle = ACCENT;
        c.lineWidth = Math.max(4, width * 0.008);
        c.beginPath();
        c.moveTo(edge, 0);
        c.lineTo(edge - width * 0.16, height);
        c.stroke();
        break;
      }
      case 'flood': {
        draw(0, 0, 0);
        const top = height * (1 - pressureEase(p));
        c.save();
        c.beginPath();
        c.rect(0, top, width, height - top);
        c.clip();
        draw(1, 0, 0);
        c.restore();
        c.save();
        c.globalAlpha = 0.9;
        c.fillStyle = ACCENT;
        c.fillRect(0, top - 2, width, Math.max(3, height * 0.006));
        c.restore();
        break;
      }
      default:
        draw(1, 0, 0);
        break;
    }
  }

  function update(position: number, power = 0): void {
    if (disposed) return;
    resize();
    if (width < 1 || height < 1) return;
    const time = (Number.isFinite(position) ? position : 0) + (song?.lyricOffsetMs || 0);
    if (!dirty && time === lastTime && power === lastPower) return;
    lastTime = time;
    lastPower = power;
    dirty = false;
    const index = pressureIndex(shots, time);
    const label = index >= 0 ? shots[index].phrases.map((phrase) => phrase.text).join(' ') : song?.title || '声压';
    if (label !== lastLabel) {
      canvas.setAttribute('aria-label', label);
      lastLabel = label;
    }
    const transition = reduced.matches ? null : pressureTransition(shots, time);
    const nextRendered = transition ? [transition.from, transition.to] : [index];
    if (nextRendered.join() !== renderedShots.join()) {
      typeEngines.forEach((engine) => engine.setSize(width, height));
      renderedShots = nextRendered;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.globalAlpha = 1;
    if (index < 0) {
      interlude(time);
      return;
    }
    if (!transition) {
      const shot = shots[index];
      const previous = shots[index - 1];
      const fromIdle = !previous || shot.start - previous.end > 3500;
      const enter = fromIdle ? pressureEase((time - shot.start) / 360) : 1;
      const rest = !shots[index + 1] || shots[index + 1].start - shot.end > 3500
        ? pressureEase((time - shot.end - 650) / 1000)
        : 0;
      const alpha = enter * (1 - rest);
      if (alpha < 1) {
        interlude(time);
        if (alpha > 0.001) {
          drawFrame(layerContexts[0], 1, shot, time, power);
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.drawImage(layers[0], 0, 0, width, height);
          ctx.restore();
        }
      } else {
        drawFrame(ctx, 0, shot, time, power);
      }
      return;
    }
    drawTransition(ctx, transition, time, power);
  }

  const observer = new ResizeObserver(() => {
    dirty = true;
    update(lastTime - (song?.lyricOffsetMs || 0), lastPower);
  });
  observer.observe(root);
  const refresh = (): void => {
    typeEngines.forEach((engine) => engine.setSize(width, height));
    dirty = true;
    update(lastTime - (song?.lyricOffsetMs || 0), lastPower);
  };
  document.fonts.addEventListener('loadingdone', refresh);
  reduced.addEventListener('change', refresh);
  return {
    root,
    update,
    setSong(input: LumiereSongInput | null): void {
      song = input;
      shots = compilePressure(input);
      typeEngines.forEach((engine) => engine.setSize(width, height));
      dirty = true;
    },
    dispose(): void {
      disposed = true;
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', refresh);
      reduced.removeEventListener('change', refresh);
      typeEngines.forEach((engine) => engine.dispose());
      for (const target of [canvas, ...layers]) {
        target.width = 1;
        target.height = 1;
      }
      root.remove();
    },
  };
}
