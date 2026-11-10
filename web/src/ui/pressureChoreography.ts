import {
  pressureClamp,
  pressureEase,
  pressureOut,
  pressureSnap,
  type PressurePhrase,
  type PressureShot,
} from './pressureProgram';

/**
 * Choreography is the shared performance clock. Camera, type and stage art all
 * read the same cue so a word hit, a colour accent and a graphic flash land on
 * the same frame instead of drifting apart.
 */

export type PressureEntrance =
  | 'slit'
  | 'slices'
  | 'tracking'
  | 'depth'
  | 'hinge'
  | 'wipe'
  | 'outline'
  | 'stagger'
  | 'shutter'
  | 'curtain'
  | 'typewriter'
  | 'scatter'
  | 'magnet'
  | 'whip'
  | 'stamp'
  | 'spine'
  | 'flip'
  | 'drop';

const ENTRANCES: PressureEntrance[] = [
  'slit',
  'slices',
  'tracking',
  'depth',
  'hinge',
  'wipe',
  'outline',
  'stagger',
  'shutter',
  'curtain',
  'typewriter',
  'scatter',
  'magnet',
  'whip',
  'stamp',
  'spine',
  'flip',
  'drop',
];

export interface PressureCue {
  active: number;
  previous: number;
  next: number;
  /** Eased camera target progress toward the active phrase. */
  move: number;
  /** Fast word-hit envelope, 0..1. */
  impact: number;
  /** Slower body pulse, 0..1. */
  pulse: number;
  /** 0..1 through the shot. */
  progress: number;
  /** Musical grid position in beats (92 BPM default performance tempo). */
  beat: number;
  /** Beat phase, 0..1. */
  beatPhase: number;
  /** 0..1 accent strength of the most recent glyph. */
  accent: number;
  /** 0..1 — how much the frame should feel like a cut right now. */
  cut: number;
  /** 0..1 — intensity used by art systems. */
  energy: number;
}

const mix = (from: number, to: number, t: number): number => from + (to - from) * t;

const BPM = 92;
const BEAT_MS = 60000 / BPM;

const phraseOrder = (shot: PressureShot): Array<{ phrase: PressurePhrase; index: number }> =>
  shot.phrases
    .map((phrase, index) => ({ phrase, index }))
    .sort((a, b) => a.phrase.start - b.phrase.start);

/** One score for the whole frame. */
export function pressureCue(shot: PressureShot, time: number): PressureCue {
  const ordered = phraseOrder(shot);
  if (!ordered.length) {
    return {
      active: 0,
      previous: 0,
      next: 0,
      move: 1,
      impact: 0,
      pulse: 0,
      progress: 0,
      beat: 0,
      beatPhase: 0,
      accent: 0,
      cut: 0,
      energy: 0,
    };
  }

  let at = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    if (time >= ordered[index].phrase.start - 220) at = index;
  }
  const item = ordered[at];
  const previousItem = ordered[Math.max(0, at - 1)];
  const nextItem = ordered[at + 1];
  const nextStart = nextItem?.phrase.start ?? item.phrase.start + 1800;
  const span = Math.min(560, Math.max(160, (nextStart - item.phrase.start) * 0.58));
  const move = pressureEase((time - item.phrase.start + 220) / span);

  let impact = 0;
  let accent = 0;
  for (const phrase of shot.phrases) {
    for (const glyph of phrase.glyphs) {
      if (glyph.space) continue;
      const age = time - glyph.start;
      if (age >= 0 && age < 430) {
        const hit = (1 - Math.exp(-age / 16)) * Math.exp(-age / 118);
        impact = Math.max(impact, hit);
        accent = Math.max(accent, hit * (0.55 + glyph.accent * 0.8));
      }
    }
  }

  const elapsed = Math.max(0, time - shot.start);
  const beat = elapsed / BEAT_MS;
  const beatPhase = beat - Math.floor(beat);
  const pulse = Math.exp(-beatPhase * 4.2) * (0.35 + (Number.isFinite(shot.energy) ? shot.energy : 0.5) * 0.65);
  const progress = pressureClamp(elapsed / Math.max(1, shot.end - shot.start));
  const cut = Math.max(
    impact * 0.7,
    pressureClamp((time - shot.start) / 180) * (1 - pressureClamp((time - shot.start) / 480)),
  );

  return {
    active: item.index,
    previous: previousItem.index,
    next: nextItem?.index ?? -1,
    move,
    impact: pressureClamp(impact),
    pulse: pressureClamp(pulse),
    progress,
    beat,
    beatPhase,
    accent: pressureClamp(accent),
    cut: pressureClamp(cut),
    energy: Number.isFinite(shot.energy) ? shot.energy : 0.5,
  };
}

/** Composition-specific eye target. Kept explicit so layouts stay art-directed. */
export function pressureAnchor(
  shot: PressureShot,
  index: number,
  portrait: boolean,
): { x: number; y: number } {
  const hero = index === shot.hero;
  const support = shot.phrases.map((_, phraseIndex) => phraseIndex).filter((i) => i !== shot.hero);
  const supportIndex = support.indexOf(index);
  const count = Math.max(1, support.length);

  switch (shot.kind) {
    case 'split':
      return hero
        ? { x: portrait ? 0.5 : 0.44, y: 0.46 }
        : { x: portrait ? 0.38 : 0.55, y: 0.2 + ((supportIndex + 0.5) / count) * 0.58 };
    case 'banner':
      return hero ? { x: 0.5, y: 0.47 } : { x: 0.5, y: supportIndex ? 0.76 : 0.22 };
    case 'tunnel':
    case 'perspective':
      return hero ? { x: 0.5, y: 0.48 } : { x: 0.5, y: 0.2 + (supportIndex + 0.2) * 0.18 };
    case 'echo':
      return hero ? { x: 0.5, y: 0.48 } : { x: 0.5, y: supportIndex ? 0.77 : 0.2 };
    case 'orbit':
      return hero ? { x: 0.5, y: 0.47 } : { x: 0.5, y: supportIndex ? 0.76 : 0.2 };
    case 'grid':
      return { x: supportIndex % 2 ? 0.67 : 0.33, y: 0.28 + ((supportIndex + 1) % 3) * 0.2 };
    case 'column':
      return hero ? { x: portrait ? 0.5 : 0.56, y: 0.47 } : { x: 0.3 + supportIndex * 0.12, y: 0.28 };
    case 'cut':
      return hero ? { x: 0.42, y: 0.45 } : { x: 0.72, y: 0.24 + supportIndex * 0.23 };
    case 'typewall':
      return { x: 0.5, y: hero ? 0.46 : 0.25 + supportIndex * 0.17 };
    case 'frame':
      return hero ? { x: 0.5, y: 0.47 } : { x: 0.5, y: supportIndex ? 0.79 : 0.17 };
    case 'sweep':
      return hero ? { x: 0.5, y: 0.47 } : { x: 0.5, y: 0.27 + supportIndex * 0.21 };
    case 'stamp':
      return hero ? { x: 0.5, y: 0.5 } : { x: 0.5, y: 0.22 + supportIndex * 0.18 };
    case 'collage':
      return hero ? { x: 0.5, y: 0.46 } : { x: 0.28 + supportIndex * 0.24, y: 0.25 + supportIndex * 0.16 };
    case 'ripple':
      return hero ? { x: 0.5, y: 0.47 } : { x: 0.5, y: 0.24 + supportIndex * 0.17 };
    case 'void':
      return hero ? { x: 0.5, y: 0.47 } : { x: 0.72, y: 0.18 + supportIndex * 0.09 };
    case 'monolith':
    case 'stack':
    default:
      if (shot.phrases.length > 3) {
        return {
          x: portrait ? 0.5 : index % 2 ? 0.58 : 0.42,
          y: 0.17 + (0.62 / shot.phrases.length) * (index + 0.47),
        };
      }
      return hero ? { x: 0.5, y: 0.47 } : { x: 0.5, y: supportIndex ? 0.76 : 0.2 };
  }
}

/** 18 entrance grammars, selected by shot, phrase role and arc. */
export function pressureEntrance(shot: PressureShot, index: number): PressureEntrance {
  const roleBias =
    shot.phrases[index]?.role === 'hero' ? 4 : shot.phrases[index]?.role === 'echo' ? 2 : 0;
  const indexValue =
    (shot.number * 7 + shot.section * 5 + index * 3 + Math.floor(shot.seed * 31) + roleBias) %
    ENTRANCES.length;
  return ENTRANCES[indexValue];
}

export function pressurePhraseMotion(
  phrase: PressurePhrase,
  time: number,
  reduced: boolean,
): {
  entry: number;
  settle: number;
  hidden: boolean;
  reveal: number;
  driftX: number;
  driftY: number;
  scale: number;
  rotation: number;
} {
  const duration = Math.min(760, Math.max(180, (phrase.end - phrase.start) * 0.5));
  const raw = (time - phrase.start + 130) / duration;
  const entry = reduced ? 1 : pressureOut(raw);
  const settle = reduced ? 1 : pressureEase(raw);
  const reveal = reduced
    ? 1
    : pressureClamp(
        phrase.glyphs.reduce(
          (sum, glyph) =>
            sum +
            pressureClamp((time - glyph.start + 50) / Math.max(1, glyph.end - glyph.start)),
          0,
        ) / Math.max(1, phrase.glyphs.filter((glyph) => !glyph.space).length),
      );
  const overshoot = Math.sin(pressureClamp(raw) * Math.PI) * (1 - pressureClamp(raw));
  return {
    entry,
    settle,
    hidden: !reduced && time < phrase.start - 130,
    reveal,
    driftX: (1 - entry) * (phrase.text.length > 6 ? 0.08 : 0.12) + overshoot * 0.012,
    driftY: (1 - settle) * -0.08,
    scale: 0.94 + entry * 0.06 + overshoot * 0.035,
    rotation: (1 - entry) * (phrase.weight > 0.5 ? -0.035 : 0.022),
  };
}

/** A hard, accent-only hit. Used by masks and stage art, never by body copy. */
export function pressureHit(shot: PressureShot, time: number): number {
  let hit = 0;
  for (const phrase of shot.phrases) {
    for (const glyph of phrase.glyphs) {
      if (glyph.space) continue;
      const age = time - glyph.start;
      if (age >= 0 && age < 220) {
        hit = Math.max(hit, Math.exp(-age / 42) * (0.4 + glyph.accent));
      }
    }
  }
  return pressureClamp(hit);
}

/** Per-glyph entrance transform. The renderer applies this before drawing. */
export function pressureGlyphMotion(
  glyph: PressurePhrase['glyphs'][number],
  phrase: PressurePhrase,
  time: number,
  entrance: PressureEntrance,
  reduced: boolean,
): {
  alpha: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  skew: number;
} {
  if (reduced) return { alpha: 1, x: 0, y: 0, scale: 1, rotation: 0, skew: 0 };
  const duration = Math.min(560, Math.max(120, (phrase.end - phrase.start) * 0.42));
  const raw = pressureClamp((time - glyph.start + 30) / duration);
  const out = pressureOut(raw);
  const settle = pressureEase(raw);
  const stagger = (glyph.index % 5) * 0.025;
  const local = pressureClamp((raw - stagger) / Math.max(0.001, 1 - stagger));
  const direction = glyph.index % 2 === 0 ? 1 : -1;
  const common = { alpha: out, scale: 0.82 + out * 0.18, rotation: 0, skew: 0 };

  switch (entrance) {
    case 'slit':
      return { ...common, x: 0, y: (1 - out) * 0.16, scale: 1, alpha: out };
    case 'slices':
      return { ...common, x: direction * (1 - local) * 0.2, y: 0, scale: 1 };
    case 'tracking':
      return { ...common, x: 0, y: 0, scale: 0.45 + local * 0.55, skew: (1 - local) * 0.3 };
    case 'depth':
      return { ...common, x: 0, y: 0, scale: 1.6 - local * 0.6, alpha: out * 0.8 };
    case 'hinge':
      return { ...common, x: (1 - out) * -0.1, y: (1 - out) * 0.2, rotation: (1 - out) * -0.08 };
    case 'wipe':
      return { ...common, x: (1 - out) * -0.18, y: 0, scale: 1 };
    case 'outline':
      return { ...common, x: 0, y: 0, scale: 0.96 + out * 0.04 };
    case 'stagger':
      return { ...common, x: 0, y: (1 - local) * 0.24, scale: 0.9 + local * 0.1 };
    case 'shutter':
      return { ...common, x: 0, y: 0, scale: 1, skew: (1 - out) * -0.5 };
    case 'curtain':
      return { ...common, x: (1 - out) * 0.3, y: 0, scale: 1 };
    case 'typewriter':
      return { ...common, x: 0, y: 0, scale: 1, alpha: raw < 0.04 ? 0 : 1 };
    case 'scatter':
      return { ...common, x: (1 - out) * direction * 0.35, y: (1 - out) * (glyph.index % 3 - 1) * 0.18, rotation: (1 - out) * direction * 0.4 };
    case 'magnet':
      return { ...common, x: (1 - out) * direction * 0.12, y: 0, scale: 0.7 + out * 0.3 };
    case 'whip':
      return { ...common, x: (1 - local) * direction * 0.55, y: 0, skew: (1 - local) * direction * -0.45 };
    case 'stamp':
      return { ...common, x: 0, y: 0, scale: 1.35 - settle * 0.35, alpha: out };
    case 'spine':
      return { ...common, x: 0, y: (1 - local) * -0.2, rotation: (1 - local) * 0.2 };
    case 'flip':
      return { ...common, x: 0, y: 0, scale: 1, skew: (1 - out) * 1.1 };
    case 'drop':
      return { ...common, x: 0, y: -((1 - out) ** 2) * 0.45, scale: 0.9 + out * 0.1 };
    default:
      return { ...common, x: 0, y: 0 };
  }
}

/** Blend helper shared by camera and type. */
export function pressureMix(from: number, to: number, amount: number): number {
  return mix(from, to, pressureClamp(amount));
}

/** 0..1 section intensity used by the stage. */
export function pressureArcEnergy(shot: PressureShot): number {
  const base =
    shot.sectionName === 'drop'
      ? 0.92
      : shot.sectionName === 'build'
        ? 0.72
        : shot.sectionName === 'final'
          ? 0.8
          : shot.sectionName === 'break'
            ? 0.42
            : 0.58;
  return pressureClamp(base * 0.7 + shot.energy * 0.3);
}

/** Snap used by masks that cut on the syllable. */
export function pressureCutPhase(shot: PressureShot, time: number): number {
  return pressureSnap(pressureCue(shot, time).cut);
}
