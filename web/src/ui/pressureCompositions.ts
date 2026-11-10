import type { PressureCue } from './pressureChoreography';
import { pressureEntrance } from './pressureChoreography';
import type { PressureColors } from './pressureArt';
import type { PressurePhrase, PressureShot } from './pressureProgram';
import { pressureClamp } from './pressureProgram';
import type { PressureTypeEngine } from './pressureType';

/**
 * Compositions are the actual poster layouts. They only draw type and simple
 * paper shapes; stage furniture, colour and camera live in the scene. Keeping
 * the layouts separate makes each shot easy to art-direct without a 3,000-line
 * switch statement becoming unreadable.
 */

export interface CompositionInput {
  context: CanvasRenderingContext2D;
  type: PressureTypeEngine;
  shot: PressureShot;
  time: number;
  width: number;
  height: number;
  colors: PressureColors;
  cue: PressureCue;
  portrait: boolean;
  reduced: boolean;
}

interface PhraseStyle {
  fill?: string;
  weight?: number;
  tracking?: number;
  alpha?: number;
  stroke?: boolean;
  accent?: string;
  accentProgress?: number;
  mono?: boolean;
}

const phraseIndexes = (shot: PressureShot): number[] =>
  shot.phrases.map((_, index) => index);

const otherIndexes = (shot: PressureShot): number[] =>
  phraseIndexes(shot).filter((index) => index !== shot.hero);

const heroOf = (shot: PressureShot): PressurePhrase | undefined =>
  shot.phrases[shot.hero] ?? shot.phrases[0];

const paint = (
  context: CanvasRenderingContext2D,
  color: string,
  alpha: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void => {
  context.save();
  context.globalAlpha *= alpha;
  context.fillStyle = color;
  context.fillRect(x, y, width, height);
  context.restore();
};

const rule = (
  context: CanvasRenderingContext2D,
  color: string,
  alpha: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  thickness: number,
): void => {
  context.save();
  context.globalAlpha *= alpha;
  context.strokeStyle = color;
  context.lineWidth = Math.max(1, thickness);
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
  context.restore();
};

const arc = (
  context: CanvasRenderingContext2D,
  color: string,
  alpha: number,
  x: number,
  y: number,
  radius: number,
  start: number,
  end: number,
  thickness: number,
): void => {
  context.save();
  context.globalAlpha *= alpha;
  context.strokeStyle = color;
  context.lineWidth = Math.max(1, thickness);
  context.beginPath();
  context.arc(x, y, Math.max(0.1, radius), start, end);
  context.stroke();
  context.restore();
};

function phraseAt(
  input: CompositionInput,
  phrase: PressurePhrase,
  index: number,
  x: number,
  y: number,
  boxWidth: number,
  boxHeight: number,
  style: PhraseStyle = {},
): void {
  const { type, shot, time, width, height, colors } = input;
  type.drawPhrase(
    input.context,
    phrase,
    time,
    width * x,
    height * y,
    width * boxWidth,
    height * boxHeight,
    {
      fill: style.fill ?? colors.ink,
      weight: style.weight ?? 900,
      tracking: style.tracking ?? 0,
      alpha: style.alpha ?? 1,
      stroke: style.stroke ?? false,
      accent: style.accent ?? colors.accent,
      accentProgress: style.accentProgress,
      entrance: pressureEntrance(shot, index),
      mono: style.mono ?? false,
    },
  );
}

function ghost(
  input: CompositionInput,
  text: string,
  x: number,
  y: number,
  boxWidth: number,
  boxHeight: number,
  alpha: number,
  color?: string,
): void {
  input.type.drawGhost(
    input.context,
    text,
    input.width * x,
    input.height * y,
    input.width * boxWidth,
    input.height * boxHeight,
    color ?? input.colors.ink,
    alpha,
  );
}

function caption(
  input: CompositionInput,
  text: string,
  x: number,
  y: number,
  size: number,
  align: CanvasTextAlign = 'left',
  alpha = 0.6,
): void {
  input.type.drawMono(
    input.context,
    text,
    input.width * x,
    input.height * y,
    Math.max(8, Math.min(18, size)),
    input.colors.ink,
    align,
    alpha,
  );
}

function numberTag(input: CompositionInput, index: number, x: number, y: number): void {
  caption(input, String(index + 1).padStart(2, '0'), x, y, 12, 'left', 0.44);
}

/** 01 — one word is the building; everything else is signage. */
function monolith(input: CompositionInput): void {
  const { context, width, height, colors, shot, cue } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  ghost(input, hero.text, 0.5, 0.49, 1.15, 0.7, 0.055);
  paint(context, colors.ink, 0.06, 0, height * 0.46, width, 1);
  if (!input.reduced) {
    context.save();
    context.globalAlpha *= 0.06;
    context.fillStyle = colors.accent;
    context.fillRect(0, height * (0.47 + cue.move * 0.02), width, height * 0.02);
    context.restore();
  }
  phraseAt(input, hero, shot.hero, 0.5, 0.48, 0.84, 0.4, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.2 + cue.progress * 0.8,
  });
  const others = otherIndexes(shot);
  others.forEach((index, order) => {
    phraseAt(input, shot.phrases[index], index, order % 2 ? 0.79 : 0.21, order % 2 ? 0.81 : 0.19, 0.34, 0.09, {
      alpha: 0.62,
      weight: 650,
      tracking: 0.02,
    });
    numberTag(input, index, order % 2 ? 0.92 : 0.05, order % 2 ? 0.79 : 0.17);
  });
}

/** 02 — a hard seam; the hero crosses it like tape. */
function split(input: CompositionInput): void {
  const { context, width, height, colors, shot } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  paint(context, colors.ink, 0.92, 0, 0, width * 0.46, height);
  paint(context, colors.accent, 0.95, width * 0.46, 0, width * 0.035, height);
  paint(context, colors.paper, 0.05, width * 0.46, 0, width * 0.54, height);
  ghost(input, hero.text, 0.5, 0.49, 1.04, 0.42, 0.045);
  phraseAt(input, hero, shot.hero, 0.51, 0.47, 0.76, 0.32, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.25 + input.cue.progress * 0.75,
  });
  const others = otherIndexes(shot);
  others.forEach((index, order) => {
    const onLeft = order % 2 === 0;
    phraseAt(input, shot.phrases[index], index, onLeft ? 0.24 : 0.73, 0.2 + order * 0.3, 0.3, 0.1, {
      fill: onLeft ? colors.paper : colors.ink,
      alpha: 0.86,
      weight: 700,
    });
  });
  caption(input, 'A/B', 0.74, 0.9, 11, 'left', 0.5);
}

/** 03 — a stage banner catches the line and tilts it. */
function banner(input: CompositionInput): void {
  const { context, width, height, colors, shot } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  context.save();
  context.translate(width * 0.5, height * 0.47);
  context.rotate(-0.075);
  paint(context, colors.accent, 0.96, -width * 0.68, -height * 0.12, width * 1.36, height * 0.24);
  context.strokeStyle = colors.ink;
  context.globalAlpha *= 0.22;
  context.lineWidth = Math.max(1, width * 0.002);
  for (let index = 0; index < 8; index += 1) {
    context.beginPath();
    context.moveTo(-width * 0.64, height * (-0.2 + index * 0.055));
    context.lineTo(width * 0.64, height * (-0.2 + index * 0.055));
    context.stroke();
  }
  context.restore();
  phraseAt(input, hero, shot.hero, 0.5, 0.47, 0.76, 0.19, {
    fill: colors.ink,
    accent: colors.paper,
    accentProgress: 0.15 + input.cue.progress * 0.7,
    weight: 950,
  });
  otherIndexes(shot).forEach((index, order) => {
    phraseAt(input, shot.phrases[index], index, order % 2 ? 0.72 : 0.28, order % 2 ? 0.78 : 0.18, 0.42, 0.07, {
      alpha: 0.72,
      weight: 650,
    });
  });
  caption(input, 'HEADLINE / 01', 0.08, 0.9, 10, 'left', 0.55);
}

/** 04 — words recede into the stage until the hero blocks the tunnel. */
function tunnel(input: CompositionInput): void {
  const { context, width, height, colors, shot, cue } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  const depth = input.reduced ? 0 : cue.move * 0.06;
  for (let plane = 4; plane >= 1; plane -= 1) {
    context.save();
    context.globalAlpha *= 0.1 + (4 - plane) * 0.035;
    input.type.drawPlane(
      context,
      hero.text,
      width * 0.5,
      height * 0.47,
      width * (0.44 + plane * 0.1),
      height * (0.16 + plane * 0.03),
      { fill: colors.accent, yaw: 0.08 + plane * 0.02, pitch: 0.06, strips: 18, alpha: 0.8 },
    );
    context.restore();
  }
  const opening = 0.18 + depth;
  context.save();
  context.strokeStyle = colors.ink;
  context.globalAlpha *= 0.25;
  context.lineWidth = Math.max(1, width * 0.002);
  context.strokeRect(width * opening, height * 0.3, width * (1 - opening * 2), height * 0.36);
  context.restore();
  phraseAt(input, hero, shot.hero, 0.5, 0.48, 0.7, 0.26, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.1 + cue.progress * 0.85,
  });
  otherIndexes(shot).forEach((index, order) => {
    phraseAt(input, shot.phrases[index], index, 0.5, order ? 0.77 : 0.2, 0.52, 0.07, {
      alpha: 0.55,
      weight: 600,
    });
  });
}

/** 05 — the line is repeated, but only one copy is in focus. */
function echo(input: CompositionInput): void {
  const { context, colors, shot } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  for (let row = -3; row <= 3; row += 1) {
    if (row === 0) continue;
    context.save();
    context.globalAlpha *= 0.1 + (1 - Math.abs(row) / 4) * 0.09;
    phraseAt(input, hero, shot.hero, 0.5, 0.48 + row * 0.105, 0.72, 0.08, {
      fill: row % 2 ? colors.accent : colors.ink,
      stroke: true,
      weight: 800,
    });
    context.restore();
  }
  paint(context, colors.paper, 0.96, 0.08, 0.405, 0.84, 0.15);
  phraseAt(input, hero, shot.hero, 0.5, 0.48, 0.7, 0.12, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.2 + input.cue.progress * 0.8,
  });
  otherIndexes(shot).forEach((index, order) => {
    phraseAt(input, shot.phrases[index], index, 0.5, order ? 0.78 : 0.18, 0.6, 0.055, { alpha: 0.6 });
  });
}

/** 06 — an editorial stack; the hero gets a solid slab. */
function stack(input: CompositionInput): void {
  const { context, colors, shot } = input;
  const count = Math.max(1, shot.phrases.length);
  const top = 0.16;
  const slot = 0.64 / count;
  shot.phrases.forEach((phrase, index) => {
    const isHero = index === shot.hero;
    const y = top + slot * (index + 0.5);
    if (isHero) {
      paint(context, colors.accent, 0.92, 0.055, top + slot * index, 0.89, slot);
    }
    numberTag(input, index, 0.07, y);
    phraseAt(input, phrase, index, isHero ? 0.52 : 0.54, y, isHero ? 0.73 : 0.65, slot * 0.82, {
      fill: isHero ? colors.ink : colors.ink,
      weight: isHero ? 950 : 700,
      alpha: isHero ? 1 : 0.82,
      accent: isHero ? colors.paper : colors.accent,
      accentProgress: isHero ? 0.2 : 0.5,
    });
    if (!isHero) rule(context, colors.ink, 0.12, 0.07, top + slot * (index + 1), 0.93, top + slot * (index + 1), 1);
  });
}

/** 07 — the hero sits in a record-like orbit. */
function orbit(input: CompositionInput): void {
  const { context, width, height, colors, shot, cue } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  const cx = 0.7, cy = 0.47, radius = Math.min(width, height) * 0.255;
  for (let index = 0; index < 4; index += 1) {
    arc(context, index % 2 ? colors.accent : colors.ink, 0.18 + index * 0.03, width * cx, height * cy, radius * (0.8 + index * 0.17), index * 0.5 + cue.move, index * 0.5 + cue.move + 1.3, Math.max(2, width * 0.006));
  }
  for (let index = 0; index < 44; index += 1) {
    const angle = (index / 44) * Math.PI * 2 + 0.3;
    rule(context, colors.ink, 0.16, width * cx + Math.cos(angle) * radius * 1.18, height * cy + Math.sin(angle) * radius * 1.18, width * cx + Math.cos(angle) * radius * 1.23, height * cy + Math.sin(angle) * radius * 1.23, 1);
  }
  paint(context, colors.paper, 0.97, 0.06, 0.35, 0.56, 0.24);
  phraseAt(input, hero, shot.hero, 0.36, 0.47, 0.48, 0.2, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.2 + cue.progress * 0.8,
  });
  otherIndexes(shot).forEach((index, order) => {
    phraseAt(input, shot.phrases[index], index, 0.5, 0.2 + order * 0.26, 0.36, 0.06, { alpha: 0.7, weight: 600 });
  });
}

/** 08 — a front page grid, with numbers and a hard accent cell. */
function grid(input: CompositionInput): void {
  const { width, height, colors, shot, context } = input;
  const columns = input.portrait ? 1 : 2;
  const rows = Math.ceil(shot.phrases.length / columns);
  const cellWidth = 0.42, cellHeight = 0.3;
  const left = 0.05, top = 0.14;
  for (let index = 0; index <= columns; index += 1) rule(context, colors.ink, 0.14, width * (left + index * cellWidth), height * top, width * (left + index * cellWidth), height * (top + rows * cellHeight), 1);
  for (let index = 0; index <= rows; index += 1) rule(context, colors.ink, 0.14, width * left, height * (top + index * cellHeight), width * (left + columns * cellWidth), height * (top + index * cellHeight), 1);
  shot.phrases.forEach((phrase, index) => {
    const column = index % columns, row = Math.floor(index / columns);
    const x = left + column * cellWidth + cellWidth * 0.5;
    const y = top + row * cellHeight + cellHeight * 0.52;
    const isHero = index === shot.hero;
    if (isHero) paint(context, colors.accent, 0.92, width * (left + column * cellWidth), height * (top + row * cellHeight), width * cellWidth, height * cellHeight);
    numberTag(input, index, left + column * cellWidth + 0.02, top + row * cellHeight + 0.035);
    phraseAt(input, phrase, index, x, y, cellWidth * 0.82, cellHeight * 0.62, {
      fill: isHero ? colors.ink : colors.ink,
      weight: isHero ? 950 : 700,
      alpha: isHero ? 1 : 0.76,
      accent: isHero ? colors.paper : colors.accent,
    });
  });
  caption(input, 'LIVE / INDEX', 0.9, 0.92, 10, 'right', 0.45);
}

/** 09 — vertical columns, read right to left. */
function column(input: CompositionInput): void {
  const { context, width, height, colors, shot, portrait } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  const fontSize = Math.min(72, height * 0.085);
  const startX = width * (portrait ? 0.7 : 0.82);
  input.type.drawColumns(context, shot.phrases, startX, height * 0.18, fontSize * 1.45, fontSize, {
    fill: colors.ink,
    alpha: 0.85,
  });
  paint(context, colors.accent, 0.9, 0.07, 0.24, width * 0.012, 0.5);
  phraseAt(input, hero, shot.hero, portrait ? 0.36 : 0.38, 0.44, 0.42, 0.2, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.2 + input.cue.progress * 0.8,
  });
  otherIndexes(shot).forEach((index, order) => {
    phraseAt(input, shot.phrases[index], index, portrait ? 0.34 : 0.36, 0.66 + order * 0.08, 0.4, 0.05, { alpha: 0.55, weight: 500, mono: true });
  });
}

/** 10 — a diagonal cut splits the frame into two arguments. */
function cut(input: CompositionInput): void {
  const { context, width, height, colors, shot } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  context.save();
  context.beginPath();
  context.moveTo(width * 0.56, 0);
  context.lineTo(width, 0);
  context.lineTo(width, height);
  context.lineTo(width * 0.38, height);
  context.closePath();
  context.fillStyle = colors.accent;
  context.globalAlpha *= 0.96;
  context.fill();
  context.restore();
  phraseAt(input, hero, shot.hero, 0.4, 0.46, 0.58, 0.38, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.1 + input.cue.progress * 0.9,
    weight: 950,
  });
  otherIndexes(shot).forEach((index, order) => {
    phraseAt(input, shot.phrases[index], index, 0.73, 0.24 + order * 0.24, 0.33, 0.08, {
      fill: colors.ink,
      weight: 650,
      alpha: 0.86,
    });
  });
  caption(input, 'CUT / 45°', 0.6, 0.9, 10, 'center', 0.5);
}

/** 11 — a wall of the hero word; the foreground copy is a clean window. */
function typewall(input: CompositionInput): void {
  const { context, width, height, colors, shot, cue } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  input.type.drawField(context, hero.text, input.time, 0.03, 0.1, width * 1.12, height * 0.82, {
    fill: colors.ink,
    rows: 7,
    columns: 3,
    alpha: 0.17 + cue.impact * 0.08,
    offset: -width * 0.02,
  });
  paint(context, colors.paper, 0.98, 0.08, 0.38, 0.84, 0.22);
  phraseAt(input, hero, shot.hero, 0.5, 0.49, 0.76, 0.17, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.25 + cue.progress * 0.75,
  });
  otherIndexes(shot).forEach((index, order) => {
    phraseAt(input, shot.phrases[index], index, 0.5, order ? 0.77 : 0.19, 0.6, 0.06, { alpha: 0.72, weight: 600 });
  });
}

/** 12 — a hard frame turns the page into a stage proscenium. */
function frame(input: CompositionInput): void {
  const { context, width, height, colors, shot } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  const inset = 0.075, top = 0.16, bottom = 0.84;
  context.save();
  context.strokeStyle = colors.accent;
  context.lineWidth = Math.max(8, width * 0.02);
  context.strokeRect(width * inset, height * top, width * (1 - inset * 2), height * (bottom - top));
  context.strokeStyle = colors.ink;
  context.lineWidth = Math.max(1, width * 0.002);
  context.globalAlpha *= 0.4;
  context.strokeRect(width * (inset + 0.035), height * (top + 0.035), width * (1 - (inset + 0.035) * 2), height * (bottom - top - 0.07));
  context.restore();
  phraseAt(input, hero, shot.hero, 0.5, 0.47, 0.68, 0.22, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.2 + input.cue.progress * 0.8,
  });
  otherIndexes(shot).forEach((index, order) => {
    phraseAt(input, shot.phrases[index], index, order % 2 ? 0.74 : 0.26, order % 2 ? 0.78 : 0.21, 0.32, 0.06, { alpha: 0.6, weight: 550 });
  });
  caption(input, 'FRAME / 01', 0.5, 0.89, 10, 'center', 0.45);
}

/** 13 — wide tracking type sweeps past the cut. */
function sweep(input: CompositionInput): void {
  const { context, width, height, colors, shot, cue } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  ghost(input, hero.text, 0.5, 0.47, 1.3, 0.2, 0.16, colors.accent);
  context.save();
  context.translate(width * 0.5, height * 0.5);
  context.rotate(-0.05);
  for (let index = 0; index < 3; index += 1) {
    const amount = pressureClamp(cue.move - index * 0.1);
    context.globalAlpha *= 0.12;
    input.type.drawTrackedLine(context, hero.text, width * (0.02 + amount * 0.1), height * (0.24 + index * 0.22), Math.min(84, width * 0.065), width * 0.012, colors.ink, 0.7);
  }
  context.restore();
  phraseAt(input, hero, shot.hero, 0.5, 0.48, 0.8, 0.2, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.2 + cue.progress * 0.8,
  });
  otherIndexes(shot).forEach((index, order) => {
    phraseAt(input, shot.phrases[index], index, 0.5, 0.7 + order * 0.06, 0.6, 0.05, { alpha: 0.55, weight: 550 });
  });
}

/** 14 — a physical stamp / ticket for the line. */
function stamp(input: CompositionInput): void {
  const { context, width, height, colors, shot, cue } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  context.save();
  context.translate(width * 0.5, height * 0.47);
  context.rotate(-0.08 + cue.move * 0.02);
  context.strokeStyle = colors.accent;
  context.lineWidth = Math.max(4, width * 0.006);
  context.strokeRect(-width * 0.36, -height * 0.22, width * 0.72, height * 0.44);
  context.globalAlpha *= 0.18;
  context.strokeRect(-width * 0.33, -height * 0.19, width * 0.66, height * 0.38);
  context.restore();
  phraseAt(input, hero, shot.hero, 0.5, 0.47, 0.6, 0.18, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.25 + cue.progress * 0.75,
  });
  otherIndexes(shot).forEach((index, order) => {
    phraseAt(input, shot.phrases[index], index, 0.5, order ? 0.73 : 0.22, 0.48, 0.055, { alpha: 0.7, weight: 600 });
  });
  caption(input, 'APPROVED / LIVE', 0.5, 0.8, 10, 'center', 0.5);
}

/** 15 — layered planes with a real vanishing point. */
function perspective(input: CompositionInput): void {
  const { context, width, height, colors, shot, cue } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  for (let index = 0; index < 3; index += 1) {
    context.save();
    context.globalAlpha *= 0.12 + index * 0.06;
    input.type.drawPlane(context, hero.text, width * (0.36 + index * 0.14), height * 0.46, width * (0.4 + index * 0.14), height * (0.12 + index * 0.04), {
      fill: index === 0 ? colors.accent : colors.ink,
      yaw: (index - 1) * 0.18,
      pitch: (index - 1) * 0.08,
      strips: 22,
      alpha: 0.8,
    });
    context.restore();
  }
  context.save();
  context.strokeStyle = colors.ink;
  context.globalAlpha *= 0.15;
  for (let index = 0; index < 6; index += 1) {
    context.beginPath();
    context.moveTo(width * (0.1 + index * 0.16), height * 0.16);
    context.lineTo(width * 0.5, height * 0.47);
    context.lineTo(width * (0.1 + index * 0.16), height * 0.84);
    context.stroke();
  }
  context.restore();
  phraseAt(input, hero, shot.hero, 0.5, 0.47, 0.64, 0.2, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.2 + cue.progress * 0.8,
  });
  otherIndexes(shot).forEach((index, order) => {
    phraseAt(input, shot.phrases[index], index, 0.5, order ? 0.76 : 0.2, 0.5, 0.055, { alpha: 0.65, weight: 600 });
  });
}

/** 16 — overlapping paper cards, each phrase with its own crop. */
function collage(input: CompositionInput): void {
  const { context, width, height, colors, shot, cue } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  shot.phrases.forEach((phrase, index) => {
    if (index === shot.hero) return;
    const rotation = (index % 2 ? 1 : -1) * (0.035 + index * 0.012);
    context.save();
    context.translate(width * (0.3 + (index % 2) * 0.42), height * (0.28 + Math.floor(index / 2) * 0.3));
    context.rotate(rotation);
    paint(context, index % 2 ? colors.paper : colors.accent, 0.94, -width * 0.18, -height * 0.1, width * 0.36, height * 0.2);
    phraseAt(input, phrase, index, 0, 0.0, 0.27, 0.075, {
      fill: index % 2 ? colors.ink : colors.paper,
      alpha: 0.9,
      weight: 700,
    });
    context.restore();
  });
  paint(context, colors.paper, 0.98, 0.2, 0.35, 0.6, 0.24);
  phraseAt(input, hero, shot.hero, 0.5, 0.47, 0.55, 0.17, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.25 + cue.progress * 0.7,
  });
  caption(input, 'FRAGMENTS / 04', 0.8, 0.9, 10, 'right', 0.5);
}

/** 17 — rings of type expand like a struck drum. */
function ripple(input: CompositionInput): void {
  const { context, width, height, colors, shot, cue } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  const cx = 0.5, cy = 0.47;
  for (let index = 0; index < 5; index += 1) {
    const radius = Math.min(width, height) * (0.14 + index * 0.07 + cue.move * 0.025);
    arc(context, index % 2 ? colors.accent : colors.ink, 0.15 + (5 - index) * 0.035, width * cx, height * cy, radius, 0.2 + index * 0.2, 5.8 - index * 0.3, Math.max(2, width * 0.004));
  }
  phraseAt(input, hero, shot.hero, 0.5, 0.47, 0.56, 0.2, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.2 + cue.progress * 0.8,
  });
  otherIndexes(shot).forEach((index, order) => {
    const angle = -0.8 + order * 0.9;
    phraseAt(input, shot.phrases[index], index, 0.5 + Math.cos(angle) * 0.26, 0.47 + Math.sin(angle) * 0.2, 0.28, 0.06, { alpha: 0.7, weight: 600 });
  });
}

/** 18 — silence as a composition: one word, a lot of air. */
function emptyFrame(input: CompositionInput): void {
  const { context, width, height, colors, shot, cue } = input;
  const hero = heroOf(shot);
  if (!hero) return;
  paint(context, colors.ink, 0.05, 0, 0, width * 0.02, height);
  phraseAt(input, hero, shot.hero, 0.29, 0.5, 0.4, 0.21, {
    fill: colors.ink,
    accent: colors.accent,
    accentProgress: 0.15 + cue.progress * 0.85,
    weight: 950,
  });
  otherIndexes(shot).forEach((index, order) => {
    phraseAt(input, shot.phrases[index], index, 0.79, 0.2 + order * 0.12, 0.26, 0.045, { alpha: 0.46, weight: 500, mono: true });
    rule(context, colors.ink, 0.12, width * 0.65, height * (0.18 + order * 0.12), width * 0.9, height * (0.18 + order * 0.12), 1);
  });
  caption(input, 'VOID / 00', 0.08, 0.88, 10, 'left', 0.4);
}

export function drawComposition(input: CompositionInput): void {
  switch (input.shot.kind) {
    case 'monolith': monolith(input); break;
    case 'split': split(input); break;
    case 'banner': banner(input); break;
    case 'tunnel': tunnel(input); break;
    case 'echo': echo(input); break;
    case 'stack': stack(input); break;
    case 'orbit': orbit(input); break;
    case 'grid': grid(input); break;
    case 'column': column(input); break;
    case 'cut': cut(input); break;
    case 'typewall': typewall(input); break;
    case 'frame': frame(input); break;
    case 'sweep': sweep(input); break;
    case 'stamp': stamp(input); break;
    case 'perspective': perspective(input); break;
    case 'collage': collage(input); break;
    case 'ripple': ripple(input); break;
    case 'void': emptyFrame(input); break;
    default: monolith(input); break;
  }
}

/** A small composition map used by the scene's diagnostics overlay. */
export const PRESSURE_COMPOSITIONS: Record<PressureShot['kind'], string> = {
  monolith: '巨字海报',
  split: '硬切双栏',
  banner: '倾斜横额',
  tunnel: '字体隧道',
  echo: '重复字阵',
  stack: '编辑堆叠',
  orbit: '唱片轨道',
  grid: '网格索引',
  column: '竖排名录',
  cut: '对角切开',
  typewall: '文字墙',
  frame: '舞台画框',
  sweep: '横扫长镜',
  stamp: '印章落版',
  perspective: '纵深平面',
  collage: '拼贴纸片',
  ripple: '声波涟漪',
  void: '留白定格',
};
