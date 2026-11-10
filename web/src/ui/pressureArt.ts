import type { PressureShot } from './pressureProgram';
import { pressureCue } from './pressureChoreography';

/**
 * Stage art is deliberately peripheral. It builds architecture around the
 * typography (beams, rails, grids, holes, shards) instead of filling the centre
 * with decorative fog. Every motif has a compositional job and a cut reaction.
 */

export interface PressureColors {
  ink: string;
  paper: string;
  accent: string;
  soft: string;
  hard: string;
  wash: string;
}

export interface PressureArtOptions {
  reduced: boolean;
  audio: number;
  /** 0..1 incoming transition, used to pre-move stage structures. */
  transition?: number;
}

const TAU = Math.PI * 2;

const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;

const alpha = (value: number): number => Math.max(0, Math.min(1, value));

const line = (
  context: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void => {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
};

const ring = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  start = 0,
  end = TAU,
): void => {
  context.beginPath();
  context.arc(x, y, Math.max(0.1, radius), start, end);
  context.stroke();
};

const registration = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
): void => {
  context.beginPath();
  context.moveTo(x - size, y);
  context.lineTo(x + size, y);
  context.moveTo(x, y - size);
  context.lineTo(x, y + size);
  context.stroke();
};

const shards = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  count: number,
  seed: number,
  color: string,
  energy: number,
): void => {
  context.fillStyle = color;
  for (let index = 0; index < count; index += 1) {
    const t = (index * 0.618 + seed) % 1;
    const x = width * (0.06 + t * 0.88);
    const y = height * (0.12 + ((index * 0.37 + seed) % 1) * 0.7);
    const size = (4 + ((index * 13) % 22)) * (0.6 + energy * 0.7);
    context.globalAlpha = 0.12 + ((index % 5) * 0.05);
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + size * (index % 2 ? 1 : -1), y + size * 0.3);
    context.lineTo(x + size * 0.4, y + size);
    context.closePath();
    context.fill();
  }
};

const beam = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  originX: number,
  originY: number,
  spread: number,
  color: string,
  strength: number,
): void => {
  const gradient = context.createLinearGradient(originX, originY, originX + spread, height);
  gradient.addColorStop(0, color);
  gradient.addColorStop(0.55, color);
  gradient.addColorStop(1, 'transparent');
  context.save();
  context.globalAlpha = strength;
  context.fillStyle = gradient;
  context.beginPath();
  context.moveTo(originX - width * 0.01, originY);
  context.lineTo(originX + width * 0.01, originY);
  context.lineTo(originX + spread + width * 0.12, height);
  context.lineTo(originX + spread - width * 0.12, height);
  context.closePath();
  context.fill();
  context.restore();
};

/**
 * Draw one of nineteen stage motifs. `motif` is chosen by the edit; the motif
 * itself morphs with the cue rather than looping independently.
 */
export function drawPressureArt(
  context: CanvasRenderingContext2D,
  shot: PressureShot,
  time: number,
  width: number,
  height: number,
  colors: PressureColors,
  options: PressureArtOptions,
): void {
  const cue = pressureCue(shot, time);
  const p = options.reduced ? 0 : cue.move;
  const hit = options.reduced ? 0 : cue.impact;
  const energy = shot.energy;
  const motif = ((shot.motif % 19) + 19) % 19;
  const accent = colors.accent;
  const ink = colors.ink;
  const lineWidth = Math.max(1, width / 1100);
  const drift = p * 0.04;
  const transition = options.transition ?? 0;

  context.save();
  context.lineWidth = lineWidth;
  context.strokeStyle = ink;
  context.fillStyle = ink;

  // A thin stage frame is common to all motifs; it keeps the poster composed
  // even when the art behind it is aggressive.
  context.globalAlpha = 0.14;
  context.strokeRect(width * 0.045, height * 0.145, width * 0.91, height * 0.71);
  context.globalAlpha = 0.32;
  registration(context, width * 0.045, height * 0.145, Math.min(width, height) * 0.012);
  registration(context, width * 0.955, height * 0.855, Math.min(width, height) * 0.012);

  switch (motif) {
    case 0: {
      // Stage beams from the floor; the drop kicks their spread.
      context.globalAlpha = 0.18 + hit * 0.2;
      const spread = width * (0.18 + p * 0.08 + energy * 0.08);
      for (let index = 0; index < 5; index += 1) {
        beam(
          context,
          width,
          height,
          width * (0.2 + index * 0.15),
          height * 0.88,
          spread * (index % 2 ? -1 : 1),
          index % 2 ? accent : ink,
          0.16 + hit * 0.2,
        );
      }
      context.globalAlpha = 0.2;
      context.strokeStyle = accent;
      for (let index = 0; index < 38; index += 1) {
        const x = width * (0.04 + index * 0.024);
        line(context, x, height * 0.82, x + width * 0.1, height * 0.18);
      }
      break;
    }
    case 1: {
      // Diagonal rails: a physical vector through the composition.
      context.save();
      context.translate(width * 0.5, height * 0.5);
      context.rotate(-0.18);
      context.globalAlpha = 0.18 + hit * 0.12;
      context.fillStyle = accent;
      context.fillRect(-width * 0.7, height * -0.08 - drift * height, width * 1.4, height * 0.1);
      context.globalAlpha = 0.1;
      context.fillStyle = ink;
      for (let index = 0; index < 7; index += 1) {
        context.fillRect(-width * 0.6, height * (0.08 + index * 0.1), width * 1.2, height * 0.012);
      }
      context.restore();
      break;
    }
    case 2: {
      // Dot matrix with a hole where the hero word will sit.
      context.fillStyle = accent;
      const columns = 24, rows = 10;
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const nx = column / (columns - 1), ny = row / (rows - 1);
          if (nx > 0.28 && nx < 0.72 && ny > 0.22 && ny < 0.78) continue;
          const distance = Math.hypot(nx - 0.5, ny - 0.5);
          context.globalAlpha = 0.08 + distance * 0.4 + hit * 0.12;
          context.beginPath();
          context.arc(width * (0.06 + nx * 0.88), height * (0.16 + ny * 0.68), Math.max(0.8, width * 0.0025 * (0.5 + distance * 2)), 0, TAU);
          context.fill();
        }
      }
      break;
    }
    case 3: {
      // Perspective frames, receding to a vanishing point.
      context.strokeStyle = accent;
      context.globalAlpha = 0.14 + hit * 0.12;
      for (let index = 0; index < 11; index += 1) {
        const z = (index + 1 + p * 0.8) / 12;
        context.strokeRect(
          width * (0.5 - 0.48 * z),
          height * (0.48 - 0.31 * z),
          width * 0.96 * z,
          height * 0.62 * z,
        );
      }
      context.globalAlpha = 0.22;
      for (const edge of [0.045, 0.955]) {
        line(context, width * edge, height * 0.145, width * 0.5, height * 0.48);
        line(context, width * edge, height * 0.855, width * 0.5, height * 0.48);
      }
      break;
    }
    case 4: {
      // Barcode: editorial, mechanical, readable as rhythm.
      context.fillStyle = ink;
      const count = 54;
      for (let index = 0; index < count; index += 1) {
        const local = 0.1 + ((index * 23) % 80) / 100;
        context.globalAlpha = 0.08 + (index % 7 === 0 ? 0.24 : 0);
        context.fillRect(width * (0.06 + index * 0.016), height * (0.19 + (1 - local) * 0.16), Math.max(1, width * 0.0035), height * local * 0.55);
      }
      context.fillStyle = accent;
      context.globalAlpha = 0.22 + hit * 0.15;
      context.fillRect(width * 0.06, height * 0.77, width * 0.88, height * 0.006);
      break;
    }
    case 5: {
      // Orbit arcs and tick marks.
      const radius = Math.min(width, height) * 0.33;
      context.strokeStyle = accent;
      context.globalAlpha = 0.18;
      context.lineWidth = Math.max(4, width * 0.006);
      for (let index = 0; index < 4; index += 1) {
        ring(context, width * 0.5, height * 0.48, radius * (0.8 + index * 0.18), index * 0.6 + p, index * 0.6 + p + 1.2);
      }
      context.lineWidth = lineWidth;
      context.strokeStyle = ink;
      for (let index = 0; index < 64; index += 1) {
        const angle = (index / 64) * TAU + p * 0.1;
        const inner = radius * 1.18;
        const outer = radius * (index % 4 === 0 ? 1.26 : 1.21);
        line(
          context,
          width * 0.5 + Math.cos(angle) * inner,
          height * 0.48 + Math.sin(angle) * inner,
          width * 0.5 + Math.cos(angle) * outer,
          height * 0.48 + Math.sin(angle) * outer,
        );
      }
      break;
    }
    case 6: {
      // Side blocks frame the type like a record sleeve.
      context.globalAlpha = 0.2;
      context.fillStyle = accent;
      context.fillRect(width * 0.045, height * 0.145, width * 0.022, height * 0.71);
      context.fillStyle = ink;
      for (let index = 0; index < 8; index += 1) {
        context.globalAlpha = 0.1 + index * 0.015;
        context.fillRect(width * 0.93, height * (0.18 + index * 0.08), width * 0.025, height * 0.035);
      }
      context.globalAlpha = 0.16;
      context.fillRect(width * 0.07, height * 0.145, width * 0.86, height * 0.012);
      break;
    }
    case 7: {
      // Long curves that echo a vocal phrase.
      context.strokeStyle = accent;
      context.globalAlpha = 0.18;
      for (let index = 0; index < 7; index += 1) {
        context.beginPath();
        context.moveTo(-width * 0.05, height * (0.2 + index * 0.02));
        context.bezierCurveTo(
          width * 0.2,
          height * (0.08 + p * 0.1),
          width * 0.82,
          height * (0.9 - index * 0.015),
          width * 1.05,
          height * (0.7 - index * 0.02),
        );
        context.stroke();
      }
      break;
    }
    case 8: {
      // Modular grid with registration blocks.
      context.strokeStyle = ink;
      context.globalAlpha = 0.12;
      for (let index = 0; index < 9; index += 1) {
        const x = width * (0.06 + index * 0.11);
        line(context, x, height * 0.16, x, height * 0.84);
      }
      for (let index = 0; index < 6; index += 1) {
        const y = height * (0.17 + index * 0.13);
        line(context, width * 0.05, y, width * 0.95, y);
      }
      context.globalAlpha = 0.2 + hit * 0.15;
      context.fillStyle = accent;
      context.fillRect(width * 0.06, height * (0.24 + (shot.number % 3) * 0.16), width * 0.2, height * 0.06);
      break;
    }
    case 9: {
      // Shards from a broken frame.
      shards(context, width, height, 26, shot.seed, accent, energy);
      context.globalAlpha = 0.16;
      context.strokeStyle = accent;
      for (let index = 0; index < 5; index += 1) {
        line(
          context,
          width * (0.1 + index * 0.18),
          height * (0.2 + (index % 2) * 0.58),
          width * (0.22 + index * 0.18),
          height * (0.78 - (index % 2) * 0.5),
        );
      }
      break;
    }
    case 10: {
      // Rings built from repeated type blocks.
      context.fillStyle = ink;
      for (let ringIndex = 0; ringIndex < 4; ringIndex += 1) {
        const radius = Math.min(width, height) * (0.16 + ringIndex * 0.075);
        const count = 18 + ringIndex * 6;
        for (let index = 0; index < count; index += 1) {
          const angle = (index / count) * TAU + p * (ringIndex % 2 ? 0.3 : -0.2);
          context.globalAlpha = 0.14 + ringIndex * 0.04;
          context.save();
          context.translate(width * 0.5 + Math.cos(angle) * radius, height * 0.48 + Math.sin(angle) * radius);
          context.rotate(angle + Math.PI / 2);
          context.fillRect(-width * 0.008, -height * 0.003, width * 0.016, height * 0.006);
          context.restore();
        }
      }
      break;
    }
    case 11: {
      // An X of tape / crossing stage trusses.
      context.save();
      context.translate(width * 0.5, height * 0.48);
      context.rotate(-0.42);
      context.globalAlpha = 0.12;
      context.fillStyle = accent;
      context.fillRect(-width * 0.65, -height * 0.035, width * 1.3, height * 0.07);
      context.rotate(0.84);
      context.fillStyle = ink;
      context.fillRect(-width * 0.65, -height * 0.02, width * 1.3, height * 0.04);
      context.restore();
      break;
    }
    case 12: {
      // Vertical rain / ticker columns.
      context.fillStyle = accent;
      for (let index = 0; index < 34; index += 1) {
        const x = width * (0.05 + index * 0.027);
        const local = (index * 17) % 100 / 100;
        const length = height * (0.03 + local * 0.12) * (0.7 + p * 0.3 + hit * 0.3);
        context.globalAlpha = 0.08 + (index % 5) * 0.025;
        context.fillRect(x, height * (0.18 + local * 0.5), Math.max(1, width * 0.0022), length);
      }
      break;
    }
    case 13: {
      // Halftone shadow field.
      context.fillStyle = ink;
      for (let row = 0; row < 14; row += 1) {
        for (let column = 0; column < 26; column += 1) {
          const nx = column / 25, ny = row / 13;
          const radius = Math.max(0.5, width * 0.0016 * (1.6 - Math.hypot(nx - 0.5, ny - 0.5)));
          context.globalAlpha = 0.06 + (1 - ny) * 0.1 + hit * 0.05;
          context.beginPath();
          context.arc(width * (0.05 + nx * 0.9), height * (0.16 + ny * 0.68), radius, 0, TAU);
          context.fill();
        }
      }
      break;
    }
    case 14: {
      // Editorial columns with folio numbers.
      context.strokeStyle = ink;
      context.globalAlpha = 0.1;
      for (let index = 0; index < 5; index += 1) {
        line(context, width * (0.12 + index * 0.19), height * 0.17, width * (0.12 + index * 0.19), height * 0.83);
      }
      context.fillStyle = accent;
      for (let index = 0; index < 3; index += 1) {
        context.globalAlpha = 0.15 + index * 0.05;
        context.fillRect(width * (0.13 + index * 0.19), height * (0.17 + (shot.number % 4) * 0.12), width * 0.08, height * 0.012);
      }
      break;
    }
    case 15: {
      // Waveform as a physical object.
      context.strokeStyle = accent;
      context.globalAlpha = 0.18 + hit * 0.12;
      context.lineWidth = Math.max(2, width * 0.003);
      context.beginPath();
      for (let index = 0; index <= 120; index += 1) {
        const x = width * (0.05 + (index / 120) * 0.9);
        const envelope = Math.sin((index / 120) * Math.PI);
        const y = height * 0.5 + Math.sin(index * 0.36 + time / 240) * height * 0.045 * envelope * (1 + energy * 0.8);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
      context.lineWidth = lineWidth;
      break;
    }
    case 16: {
      // Four heavy corner brackets; the frame itself becomes a character.
      context.strokeStyle = accent;
      context.globalAlpha = 0.28 + hit * 0.2;
      const inset = width * 0.045;
      const arm = width * 0.09;
      const top = height * 0.145, bottom = height * 0.855;
      for (const [x, y, dx, dy] of [
        [inset, top, 1, 1],
        [width - inset, top, -1, 1],
        [inset, bottom, 1, -1],
        [width - inset, bottom, -1, -1],
      ]) {
        context.beginPath();
        context.moveTo(x, y + dy * arm);
        context.lineTo(x, y);
        context.lineTo(x + dx * arm, y);
        context.stroke();
      }
      break;
    }
    case 17: {
      // Arrow lanes: forward motion without a literal arrow.
      context.fillStyle = accent;
      for (let index = 0; index < 5; index += 1) {
        const y = height * (0.22 + index * 0.13);
        context.globalAlpha = 0.12 + index * 0.02 + hit * 0.1;
        context.beginPath();
        context.moveTo(width * 0.06, y);
        context.lineTo(width * (0.84 + p * 0.05), y);
        context.lineTo(width * 0.9, y + height * 0.02);
        context.lineTo(width * 0.84, y + height * 0.04);
        context.lineTo(width * 0.06, y + height * 0.04);
        context.closePath();
        context.fill();
      }
      break;
    }
    default: {
      // Torn paper / noise field.
      context.fillStyle = ink;
      for (let index = 0; index < 70; index += 1) {
        const x = width * ((index * 0.371 + shot.seed) % 1);
        const y = height * ((index * 0.613) % 1);
        context.globalAlpha = 0.04 + (index % 4) * 0.01;
        context.fillRect(x, y, width * 0.02, height * 0.003);
      }
      context.strokeStyle = accent;
      context.globalAlpha = 0.14;
      line(context, width * 0.05, height * 0.2, width * 0.95, height * 0.78);
      break;
    }
  }

  // A single accent bar is the recurring stage motif; its vertical position
  // follows the active phrase, so the poster breathes with the vocal.
  context.globalAlpha = 0.34 + hit * 0.36;
  context.fillStyle = accent;
  const barX = cue.active % 2 ? 0.93 : 0.055;
  context.fillRect(width * barX, height * (0.22 + p * 0.38), width * 0.011, height * (0.07 + hit * 0.05));

  if (transition > 0) {
    context.globalAlpha = 0.08 + transition * 0.16;
    context.fillStyle = accent;
    context.fillRect(0, 0, width * transition * 0.06, height);
  }

  context.restore();
}

/** A compact poster lockup used in the quiet interlude. */
export function drawPressureInterludeArt(
  context: CanvasRenderingContext2D,
  time: number,
  width: number,
  height: number,
  colors: PressureColors,
): void {
  context.save();
  context.strokeStyle = colors.accent;
  context.lineWidth = Math.max(8, width * 0.018);
  const radius = Math.min(width * 0.31, height * 0.3);
  const rotation = time / 5000;
  context.save();
  context.translate(width * 0.7, height * 0.48);
  context.rotate(rotation);
  ring(context, 0, 0, radius, 0, Math.PI * 1.62);
  context.restore();
  context.strokeStyle = colors.ink;
  context.lineWidth = Math.max(1, width * 0.0015);
  for (let index = 0; index < 12; index += 1) {
    const x = width * (0.06 + index * 0.08);
    line(context, x, height * 0.18, x, height * 0.24);
  }
  context.fillStyle = colors.accent;
  context.fillRect(width * 0.075, height * 0.74, width * 0.18, height * 0.018);
  context.restore();
}

/** Shared colour resolver for the scene. */
export function pressureColors(
  ink: string,
  paper: string,
  accent: string,
  theme: PressureShot['theme'],
): PressureColors {
  if (theme === 'paper') {
    return {
      ink: paper,
      paper: paper,
      accent,
      soft: ink,
      hard: paper,
      wash: 'rgba(0,0,0,0.08)',
    };
  }
  if (theme === 'accent') {
    return {
      ink: paper,
      paper: accent,
      accent: ink,
      soft: ink,
      hard: paper,
      wash: 'rgba(0,0,0,0.1)',
    };
  }
  if (theme === 'cold') {
    return {
      ink: '#dde3e6',
      paper: '#1a2228',
      accent: '#ff6a3d',
      soft: '#9ba9ad',
      hard: '#dde3e6',
      wash: 'rgba(255,255,255,0.08)',
    };
  }
  return {
    ink,
    paper,
    accent,
    soft: paper,
    hard: ink,
    wash: 'rgba(255,255,255,0.08)',
  };
}

/** Reduce a colour to alpha; keeps the stage from importing a colour library. */
export function withAlpha(color: string, value: number): string {
  const amount = alpha(value);
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    const r = Number.parseInt(full.slice(0, 2), 16);
    const g = Number.parseInt(full.slice(2, 4), 16);
    const b = Number.parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${amount})`;
  }
  return color;
}

/** Vertical position helper used by the art and scene. */
export function pressureBand(shot: PressureShot, p: number): number {
  return lerp(0.22, 0.6, pressureCue(shot, 0).move * 0 + p);
}
