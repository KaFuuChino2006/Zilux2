import type { LumiereSongInput } from './lumiere';

/**
 * 声压 / Pressure — a deterministic performance score for kinetic typography.
 *
 * This file deliberately contains no drawing. It turns a lyric sheet into a
 * directed sequence of shots, each with a composition, a colour theme, a
 * camera intention, a graphic motif and an incoming transition. The renderer
 * can then concentrate on frame craft while the edit stays reproducible:
 * the same lyric always produces the same cut, camera move and colour arc.
 */

export type PressureKind =
  | 'monolith'
  | 'split'
  | 'banner'
  | 'tunnel'
  | 'echo'
  | 'stack'
  | 'orbit'
  | 'grid'
  | 'column'
  | 'cut'
  | 'typewall'
  | 'frame'
  | 'sweep'
  | 'stamp'
  | 'perspective'
  | 'collage'
  | 'ripple'
  | 'void';

export type PressureTheme = 'ink' | 'paper' | 'accent' | 'split' | 'cold';

export type PressureArc = 'intro' | 'verse' | 'build' | 'drop' | 'break' | 'final';

export type PressureTransitionKind =
  | 'whip'
  | 'punch'
  | 'slit'
  | 'shutter'
  | 'fold'
  | 'iris'
  | 'glitch'
  | 'panels'
  | 'carry'
  | 'wipe'
  | 'flood'
  | 'cut';

export type PressurePhraseRole = 'hero' | 'support' | 'echo' | 'caption';

export interface PressureGlyph {
  text: string;
  start: number;
  end: number;
  /** Stable index inside the phrase. */
  index: number;
  /** Visual weight used for tracking / line breaking. */
  weight: number;
  /** True for punctuation and whitespace-only glyphs. */
  space: boolean;
  /** Accent score, 0..1, used by choreography for hits. */
  accent: number;
}

export interface PressurePhrase {
  text: string;
  start: number;
  end: number;
  glyphs: PressureGlyph[];
  role: PressurePhraseRole;
  /** 0..1 — how strongly this phrase should dominate the composition. */
  weight: number;
  /** True when the phrase ends a sentence. */
  terminal: boolean;
  /** Index of the source line. */
  lineIndex: number;
}

export interface PressureFocus {
  x: number;
  y: number;
  /** 0..1, where the eye should land inside the frame. */
  weight: number;
}

export interface PressureShot {
  start: number;
  end: number;
  phrases: PressurePhrase[];
  translation: string;
  kind: PressureKind;
  hero: number;
  number: number;
  section: number;
  sectionName: PressureArc;
  theme: PressureTheme;
  /** Index into the art motif table. */
  motif: number;
  /** 0..1 dramatic energy, used for graphic scale and shard count. */
  energy: number;
  /** Phrase index that receives the accent colour. */
  accent: number;
  /** Incoming transition. */
  transitionIn: PressureTransitionKind;
  /** Stable seed for deterministic layout jitter. */
  seed: number;
  focus: PressureFocus;
  /** Optional editorial caption drawn beside the composition. */
  kicker: string;
  /** Last line of the shot, used for metadata. */
  lineIndex: number;
}

export interface PressureTransition {
  from: number;
  to: number;
  progress: number;
  kind: PressureTransitionKind;
  /** 0..1 — direction of the edit, used by masks and camera. */
  direction: number;
}

/** Clamp a number to the unit interval. */
export const pressureClamp = (value: number): number =>
  value < 0 ? 0 : value > 1 ? 1 : value;

/** A smooth, slightly theatrical ease used for camera and mask motion. */
export const pressureEase = (value: number): number => {
  const t = pressureClamp(value);
  return t * t * t * (10 + t * (-15 + t * 6));
};

/** A fast-out ease for a word landing on the beat. */
export const pressureOut = (value: number): number =>
  1 - (1 - pressureClamp(value)) ** 4;

/** A snap-in / slow-out curve for aggressive cuts. */
export const pressureSnap = (value: number): number => {
  const t = pressureClamp(value);
  return 1 - (1 - t) ** 7;
};

/** A soft in-out curve for long dolly moves. */
export const pressureSmooth = (value: number): number => {
  const t = pressureClamp(value);
  return t * t * (3 - 2 * t);
};

const hashText = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

const seedOf = (value: string, salt = 0): number =>
  (hashText(`${value}\u0000${salt}`) % 100000) / 100000;

const displayWidth = (text: string): number => {
  let weight = 0;
  for (const character of text) {
    if (/\s/.test(character)) continue;
    weight += /[\u0000-\u00ff]/.test(character) ? 0.55 : 1;
  }
  return weight;
};

const isTerminal = (text: string): boolean => /[，。！？；,.!?;…]$/.test(text.trim());

const hasStrongPunctuation = (text: string): boolean => /[！!！?？]/.test(text);

const isSpace = (text: string): boolean => text.trim().length === 0;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

const graphemesOf = (text: string): string[] =>
  [...graphemeSegmenter.segment(text)].map((part) => part.segment);

const wordsOf = (text: string): string[] =>
  [...wordSegmenter.segment(text)].map((part) => part.segment);

/**
 * Split a line into phrases on semantic boundaries. The old engine only split
 * on punctuation and a crude character count; this version also keeps leading
 * verbs (让/把/将/向) as a support heading and respects English word boundaries.
 */
function phrasesOf(
  line: LumiereSongInput['lines'][number],
  lineIndex: number,
): PressurePhrase[] {
  const raw = line.words
    .map((word) => `${word.spaceBefore ? ' ' : ''}${word.text}`)
    .join('');
  const timed =
    raw.replace(/\s/g, '') === line.text.replace(/\s/g, '') &&
    line.words.length > 0;

  const parts = timed
    ? line.words.map((word) => ({
        text: `${word.spaceBefore ? ' ' : ''}${word.text}`,
        start: word.startMs,
        end: word.endMs,
      }))
    : [
        {
          text: line.text,
          start: line.timeMs,
          end: line.timeMs + Math.max(220, line.durationMs),
        },
      ];

  const glyphs: PressureGlyph[] = [];
  for (const part of parts) {
    const partStart = Number.isFinite(part.start) ? part.start : line.timeMs;
    const partEnd = Math.max(
      partStart + 1,
      Number.isFinite(part.end) ? part.end : partStart + 220,
    );
    const characters = graphemesOf(part.text);
    const totalWeight = Math.max(0.001, displayWidth(part.text));
    let running = 0;
    for (const character of characters) {
      const characterWeight = displayWidth(character);
      const localStart =
        partStart + (partEnd - partStart) * (running / totalWeight);
      running += characterWeight;
      const localEnd =
        partStart + (partEnd - partStart) * (running / totalWeight);
      glyphs.push({
        text: character,
        start: localStart,
        end: Math.max(localStart + 1, localEnd),
        index: glyphs.length,
        weight: characterWeight,
        space: isSpace(character),
        accent: 0,
      });
    }
  }

  const text = glyphs.map((glyph) => glyph.text).join('');
  const wordEnds = new Set(
    wordsOf(text).map((word) => word.length),
  );
  const runningWordEnds = new Set<number>();
  let wordOffset = 0;
  for (const word of wordsOf(text)) {
    wordOffset += word.length;
    if (wordEnds.has(word.length)) runningWordEnds.add(wordOffset);
  }

  const phrases: PressurePhrase[] = [];
  let current: PressureGlyph[] = [];

  const flush = (): void => {
    const value = current.map((glyph) => glyph.text).join('').trim();
    if (value) {
      const weight = displayWidth(value);
      const start = current.find((glyph) => !glyph.space)?.start ?? current[0].start;
      const end = [...current].reverse().find((glyph) => !glyph.space)?.end ?? current.at(-1)!.end;
      phrases.push({
        text: value,
        start,
        end: Math.max(start + 1, end),
        glyphs: current,
        role: weight > 7 ? 'hero' : 'support',
        weight: pressureClamp(weight / 12),
        terminal: isTerminal(value),
        lineIndex,
      });
    }
    current = [];
  };

  let offset = 0;
  for (let index = 0; index < glyphs.length; index += 1) {
    const glyph = glyphs[index];
    current.push(glyph);
    offset += glyph.text.length;
    const value = current.map((item) => item.text).join('');
    const weight = displayWidth(value);
    const leading =
      phrases.length === 0 &&
      /^[让把将向就从再又还]/.test(value) &&
      weight >= 3 &&
      runningWordEnds.has(offset);
    const remaining = glyphs
      .slice(index + 1)
      .map((item) => item.text)
      .join('');
    const long = weight >= 5 && runningWordEnds.has(offset) && displayWidth(remaining) > 2;
    if (isTerminal(glyph.text) || leading || long || weight >= 11) flush();
  }
  flush();

  if (!phrases.length) return [];
  // Accent scoring is intentionally independent from font size: a short,
  // hard consonant word often deserves the orange more than the longest phrase.
  for (const phrase of phrases) {
    const strong = /[打破冲撞炸裂光夜你我现在]/.test(phrase.text) ? 0.18 : 0;
    phrase.role =
      phrase.weight > 0.52 || strong > 0
        ? 'hero'
        : phrase.weight > 0.28
          ? 'support'
          : 'caption';
    for (const glyph of phrase.glyphs) {
      glyph.accent = pressureClamp(
        phrase.weight * 0.65 + strong + (hasStrongPunctuation(glyph.text) ? 0.22 : 0),
      );
    }
  }
  return phrases;
}

const KIND_KEYWORDS: Array<[RegExp, PressureKind[]]> = [
  [/沉默|打破|撕|裂|断|碎/, ['split', 'cut', 'collage']],
  [/心跳|响彻|声|震|轰|撞|炸/, ['typewall', 'ripple', 'stamp']],
  [/现在|此刻|就|一秒|瞬间/, ['monolith', 'stamp', 'frame']],
  [/向前|冲|穿过|奔跑|飞|追/, ['tunnel', 'perspective', 'sweep']],
  [/光|照亮|闪耀|一道|亮/, ['banner', 'sweep', 'frame']],
  [/黑夜|漫长|远|空|无|沉默/, ['void', 'echo', 'column']],
  [/你|身旁|拥抱|靠近|手/, ['collage', 'frame', 'orbit']],
  [/梦|未完成|话|折|纸|写/, ['column', 'grid', 'stack']],
  [/夜|星|月|天空|宇宙/, ['orbit', 'ripple', 'void']],
  [/城市|街|人群|世界/, ['grid', 'stack', 'echo']],
];

const KINDS: PressureKind[] = [
  'monolith',
  'split',
  'banner',
  'tunnel',
  'echo',
  'stack',
  'orbit',
  'grid',
  'column',
  'cut',
  'typewall',
  'frame',
  'sweep',
  'stamp',
  'perspective',
  'collage',
  'ripple',
  'void',
];

const THEMES: PressureTheme[] = ['ink', 'paper', 'accent', 'split', 'cold'];

const TRANSITIONS_BY_KIND: Record<PressureKind, PressureTransitionKind[]> = {
  monolith: ['punch', 'shutter', 'flood'],
  split: ['slit', 'panels', 'cut'],
  banner: ['wipe', 'whip', 'fold'],
  tunnel: ['punch', 'whip', 'iris'],
  echo: ['shutter', 'panels', 'carry'],
  stack: ['panels', 'fold', 'carry'],
  orbit: ['iris', 'flood', 'punch'],
  grid: ['panels', 'shutter', 'glitch'],
  column: ['wipe', 'fold', 'slit'],
  cut: ['cut', 'slit', 'glitch'],
  typewall: ['punch', 'carry', 'flood'],
  frame: ['iris', 'fold', 'shutter'],
  sweep: ['whip', 'wipe', 'punch'],
  stamp: ['punch', 'cut', 'shutter'],
  perspective: ['punch', 'fold', 'whip'],
  collage: ['glitch', 'panels', 'carry'],
  ripple: ['flood', 'iris', 'wipe'],
  void: ['shutter', 'iris', 'wipe'],
};

const safeTransitions = (kind: PressureKind): PressureTransitionKind[] => [
  ...(TRANSITIONS_BY_KIND[kind] ?? ['cut']),
];

function chooseKind(
  text: string,
  number: number,
  previous: PressureKind | undefined,
  seed: number,
): PressureKind {
  const matches: PressureKind[] = [];
  for (const [pattern, kinds] of KIND_KEYWORDS) {
    if (pattern.test(text)) matches.push(...kinds);
  }
  const pool = matches.length ? matches : KINDS;
  let choice = pool[Math.floor(seed * pool.length) % pool.length];
  if (choice === previous) {
    const alternatives = KINDS.filter((kind) => kind !== previous);
    choice = alternatives[(number + Math.floor(seed * 17)) % alternatives.length];
  }
  return choice;
}

function chooseTheme(
  arc: PressureArc,
  number: number,
  previous: PressureTheme | undefined,
  seed: number,
): PressureTheme {
  const byArc: Record<PressureArc, PressureTheme[]> = {
    intro: ['ink', 'ink', 'paper'],
    verse: ['ink', 'paper', 'split'],
    build: ['paper', 'split', 'accent'],
    drop: ['accent', 'ink', 'split'],
    break: ['paper', 'cold', 'ink'],
    final: ['ink', 'accent', 'paper'],
  };
  const pool = byArc[arc];
  let choice = pool[(number + Math.floor(seed * pool.length)) % pool.length];
  if (choice === previous) {
    choice = THEMES[(THEMES.indexOf(choice) + 1) % THEMES.length];
  }
  return choice;
}

function arcFor(time: number, duration: number): PressureArc {
  const progress = duration > 0 ? time / duration : 0;
  if (progress < 0.06 || time < 6000) return 'intro';
  if (progress < 0.28) return 'verse';
  if (progress < 0.5) return 'build';
  if (progress < 0.76) return 'drop';
  if (progress < 0.9) return 'break';
  return 'final';
}

function energyFor(arc: PressureArc, weight: number, punctuation: boolean): number {
  const base =
    arc === 'drop' ? 0.82 : arc === 'build' ? 0.64 : arc === 'final' ? 0.7 : arc === 'break' ? 0.38 : arc === 'intro' ? 0.36 : 0.5;
  return pressureClamp(base + weight * 0.24 + (punctuation ? 0.16 : 0));
}

function kickerFor(shot: PressureShot, index: number): string {
  const lexicon = [
    'A STAGE IN BLACK',
    'NOISE / LIGHT',
    'HOLD THE FRAME',
    'ONE MORE TIME',
    'BREAK THE SILENCE',
    'PUSH THROUGH',
    'THE NIGHT OPENS',
    'ALL AT ONCE',
    'KEEP MOVING',
    'AFTER THE HIT',
  ];
  return `${String(index + 1).padStart(2, '0')} / ${lexicon[shot.number % lexicon.length]}`;
}

/**
 * Compile a lyric sheet into a directed sequence. The compiler is intentionally
 * deterministic and clock-based: no renderer state leaks back into the edit.
 */
export function compilePressure(input: LumiereSongInput | null): PressureShot[] {
  if (!input) return [];
  const lines = [...input.lines]
    .filter((line) => line.text.trim() && Number.isFinite(line.timeMs))
    .sort((a, b) => a.timeMs - b.timeMs);
  const shots: PressureShot[] = [];
  const lastLine = lines.at(-1);
  const duration = Math.max(1, input.durationMs || (lastLine ? lastLine.timeMs + lastLine.durationMs : 1));
  let section = 0;
  let previousKind: PressureKind | undefined;
  let previousTheme: PressureTheme | undefined;
  let previousEnd = -Infinity;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const phrases = phrasesOf(line, lineIndex);
    if (!phrases.length) continue;
    if (line.timeMs - previousEnd > 2400) section += 1;

    // Long lines get a second composition rather than one dense block.
    const groupSize = phrases.length >= 7 ? 2 : phrases.length >= 5 ? 3 : 4;
    for (let cursor = 0; cursor < phrases.length; cursor += groupSize) {
      const group = phrases.slice(cursor, cursor + groupSize);
      if (!group.length) continue;
      const first = group[0];
      const start = Math.max(
        previousEnd + 120,
        cursor === 0 ? Math.min(line.timeMs, first.start) : first.start,
      );
      const end = Math.max(start + 700, group.at(-1)!.end + 420);
      const seed = seedOf(group.map((phrase) => phrase.text).join(''), lineIndex + cursor);
      const arc = arcFor(start, duration);
      const text = group.map((phrase) => phrase.text).join(' ');
      const kind = chooseKind(text, shots.length, previousKind, seed);
      const theme = chooseTheme(arc, shots.length, previousTheme, seed);
      const hero = group.reduce(
        (best, phrase, index, all) =>
          phrase.end - phrase.start > all[best].end - all[best].start ? index : best,
        0,
      );
      const accent = group.reduce(
        (best, phrase, index, all) =>
          phrase.glyphs.reduce((sum, glyph) => sum + glyph.accent, 0) >
          all[best].glyphs.reduce((sum, glyph) => sum + glyph.accent, 0)
            ? index
            : best,
        0,
      );
      const transitions = safeTransitions(kind);
      const transitionIn = transitions[(shots.length + section) % transitions.length];
      const energy = energyFor(
        arc,
        Math.max(...group.map((phrase) => phrase.weight)),
        group.some((phrase) => hasStrongPunctuation(phrase.text)),
      );
      const shot: PressureShot = {
        start,
        end,
        phrases: group,
        translation: line.translation || '',
        kind,
        hero,
        number: shots.length,
        section,
        sectionName: arc,
        theme,
        motif: Math.floor(seed * 19) % 19,
        energy,
        accent,
        transitionIn,
        seed,
        focus: { x: 0.5, y: 0.45, weight: energy },
        kicker: '',
        lineIndex,
      };
      shot.kicker = kickerFor(shot, shots.length);
      shots.push(shot);
      previousKind = kind;
      previousTheme = theme;
      previousEnd = end;
    }
  }

  // Keep a readable tail for the last phrase and guarantee no zero-width shot.
  for (let index = 0; index < shots.length; index += 1) {
    const shot = shots[index];
    const next = shots[index + 1];
    const ceiling = next ? next.start - 140 : Math.max(shot.end, duration);
    shot.end = Math.max(shot.start + 500, Math.min(shot.end, ceiling));
    if (!shot.phrases.some((phrase) => phrase.text.trim())) {
      shot.phrases = shot.phrases.filter((phrase) => phrase.text.trim());
    }
  }
  return shots;
}

export function pressureIndex(shots: readonly PressureShot[], time: number): number {
  let low = 0;
  let high = shots.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (shots[middle].start <= time) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/**
 * The cut begins just before the sung line and resolves after the first
 * syllable. Words still enter on their own clock; only the frame anticipates.
 */
export function pressureTransition(
  shots: readonly PressureShot[],
  time: number,
): PressureTransition | null {
  const current = pressureIndex(shots, time);
  for (const next of [current, current + 1]) {
    if (next < 1 || next >= shots.length) continue;
    const previous = shots[next - 1];
    const shot = shots[next];
    if (shot.start - previous.end > 3600) continue;
    const before = Math.min(360, Math.max(70, (shot.start - previous.start) * 0.08));
    const after = Math.min(560, Math.max(120, ((shots[next + 1]?.start ?? shot.start + 3000) - shot.start) * 0.26));
    if (time >= shot.start - before && time < shot.start + after) {
      const direction = (shot.number % 2 === 0 ? 1 : -1) * (0.6 + (shot.seed % 0.4));
      return {
        from: next - 1,
        to: next,
        progress: pressureEase((time - shot.start + before) / (before + after)),
        kind: shot.transitionIn,
        direction,
      };
    }
  }
  return null;
}

export function phraseProgress(phrase: PressurePhrase, time: number): number {
  const glyphs = phrase.glyphs.filter((glyph) => !glyph.space);
  if (!glyphs.length) return 0;
  return (
    glyphs.reduce(
      (sum, glyph) =>
        sum + pressureClamp((time - glyph.start) / Math.max(1, glyph.end - glyph.start)),
      0,
    ) / glyphs.length
  );
}

/** 0..1 word-level hit envelope, used by art and camera. */
export function phraseImpact(phrase: PressurePhrase, time: number): number {
  let impact = 0;
  for (const glyph of phrase.glyphs) {
    if (glyph.space) continue;
    const age = time - glyph.start;
    if (age >= 0 && age < 420) {
      impact = Math.max(
        impact,
        (1 - Math.exp(-age / 18)) * Math.exp(-age / 120) * (0.5 + glyph.accent * 0.8),
      );
    }
  }
  return pressureClamp(impact);
}

export function shotProgress(shot: PressureShot, time: number): number {
  return pressureClamp((time - shot.start) / Math.max(1, shot.end - shot.start));
}

export function hookSeconds(shot: PressureShot): number {
  const first = shot.phrases[0];
  return first ? first.start - shot.start : 0;
}

export function labelOf(shot: PressureShot): string {
  return shot.phrases.map((phrase) => phrase.text).join(' ');
}

export function isPressureKind(value: string): value is PressureKind {
  return (KINDS as string[]).includes(value);
}

export function isPressureTransitionKind(value: string): value is PressureTransitionKind {
  return (
    value === 'whip' ||
    value === 'punch' ||
    value === 'slit' ||
    value === 'shutter' ||
    value === 'fold' ||
    value === 'iris' ||
    value === 'glitch' ||
    value === 'panels' ||
    value === 'carry' ||
    value === 'wipe' ||
    value === 'flood' ||
    value === 'cut'
  );
}
