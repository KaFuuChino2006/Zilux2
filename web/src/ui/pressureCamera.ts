import type { PressureShot } from './pressureProgram';
import { pressureAnchor, pressureCue, pressureMix } from './pressureChoreography';

/**
 * A small, deterministic virtual camera. The renderer uses it for stage art and
 * typography together, so a dolly never leaves the words pasted on a moving
 * background. Values are normalized against the frame, not pixels.
 */
export interface PressureCamera {
  x: number;
  y: number;
  zoom: number;
  rotation: number;
  /** Horizontal shear used by whip-pan and flip compositions. */
  skew: number;
  /** Short impact offset, in frame units. */
  shakeX: number;
  shakeY: number;
  /** 0..1 — extra punch-in on a hard syllable. */
  punch: number;
  /** 0..1 — how much the camera is travelling laterally. */
  travel: number;
}

const DEFAULT_CAMERA: PressureCamera = {
  x: 0,
  y: 0,
  zoom: 1,
  rotation: 0,
  skew: 0,
  shakeX: 0,
  shakeY: 0,
  punch: 0,
  travel: 0,
};

const mix = (from: number, to: number, amount: number): number => from + (to - from) * amount;
const softMin = (a: number, b: number): number =>
  (a + b - Math.sqrt((a - b) ** 2 + 0.025 ** 2)) / 2;

/** Kind-specific base lens: wide poster, long lens portrait, or extreme dolly. */
function baseLens(kind: PressureShot['kind']): { zoom: number; spread: number } {
  switch (kind) {
    case 'monolith':
      return { zoom: 1.08, spread: 0.16 };
    case 'split':
      return { zoom: 1.02, spread: 0.24 };
    case 'banner':
      return { zoom: 1.05, spread: 0.18 };
    case 'tunnel':
    case 'perspective':
      return { zoom: 0.94, spread: 0.36 };
    case 'echo':
      return { zoom: 1.03, spread: 0.2 };
    case 'stack':
      return { zoom: 0.98, spread: 0.14 };
    case 'orbit':
      return { zoom: 1.06, spread: 0.28 };
    case 'grid':
      return { zoom: 0.96, spread: 0.22 };
    case 'column':
      return { zoom: 1.02, spread: 0.12 };
    case 'cut':
      return { zoom: 1.1, spread: 0.3 };
    case 'typewall':
      return { zoom: 1.12, spread: 0.3 };
    case 'frame':
      return { zoom: 0.92, spread: 0.16 };
    case 'sweep':
      return { zoom: 1.02, spread: 0.3 };
    case 'stamp':
      return { zoom: 1.04, spread: 0.1 };
    case 'collage':
      return { zoom: 1.0, spread: 0.22 };
    case 'ripple':
      return { zoom: 1.05, spread: 0.26 };
    case 'void':
      return { zoom: 0.88, spread: 0.1 };
    default:
      return { zoom: 1, spread: 0.2 };
  }
}

/** Pull back just enough that the target anchor stays inside a safe frame. */
function fitCamera(camera: PressureCamera, aspect: number): PressureCamera {
  const cos = Math.abs(Math.cos(camera.rotation));
  const sin = Math.abs(Math.sin(camera.rotation));
  const bx = cos * 0.44 * aspect + sin * 0.325;
  const by = sin * 0.44 * aspect + cos * 0.325;
  const limit = Math.min(
    (0.465 - Math.abs(camera.x) * 1.18) * aspect / bx,
    (0.345 - Math.abs(camera.y) * 1.18) / by,
  ) / 1.08;
  if (!Number.isFinite(limit) || limit <= 0) return camera;
  return { ...camera, zoom: Math.max(0.42, softMin(camera.zoom, limit)) };
}

/**
 * Move to the phrase being introduced, settle, and hold until the next singing
 * cue. The edit's incoming transition is applied by the scene; the camera here
 * carries the shot's internal intention.
 */
export function pressureCamera(
  shot: PressureShot,
  time: number,
  aspect = 16 / 9,
  reduced = false,
): PressureCamera {
  if (reduced || !shot.phrases.length) return { ...DEFAULT_CAMERA };
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const cue = pressureCue(shot, time);
  const lens = baseLens(shot.kind);
  const portrait = ratio < 1;

  const target = (index: number): PressureCamera => {
    const anchor = pressureAnchor(shot, index, portrait);
    if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
      return { ...DEFAULT_CAMERA, zoom: lens.zoom };
    }
    const hero = index === shot.hero;
    const roleScale = hero ? 1 : 0.93;
    const base = lens.zoom * roleScale;
    let x = (0.5 - anchor.x) * lens.spread;
    let y = (0.48 - anchor.y) * (portrait ? 0.24 : 0.17);
    let rotation = 0;
    let skew = 0;
    let travel = 0;

    switch (shot.kind) {
      case 'split':
        x += (hero ? -0.02 : 0.025);
        y += (hero ? 0.012 : -0.01);
        break;
      case 'banner':
        rotation = hero ? -0.024 : 0.03;
        x *= 0.82;
        break;
      case 'tunnel':
      case 'perspective':
        x *= 0.62;
        y *= 0.72;
        rotation = (hero ? 1 : -1) * 0.012;
        travel = 0.24;
        break;
      case 'echo':
        x *= 0.7;
        y *= 1.18;
        break;
      case 'stack':
        x *= 0.46;
        y *= 1.24;
        break;
      case 'orbit':
        rotation = (index % 2 ? 1 : -1) * 0.045;
        x *= 0.7;
        break;
      case 'grid':
        x = (anchor.x - 0.5) * 0.42;
        y = (anchor.y - 0.5) * 0.25;
        break;
      case 'column':
        x = (hero ? -0.025 : 0.04);
        y = (anchor.y - 0.5) * 0.14;
        break;
      case 'cut':
        x = (hero ? -0.06 : 0.09);
        y = (hero ? 0.025 : -0.03);
        rotation = (hero ? -1 : 1) * 0.018;
        break;
      case 'typewall':
        x *= 0.35;
        y *= 0.5;
        break;
      case 'frame':
        x *= 0.4;
        y *= 0.6;
        break;
      case 'sweep':
        x = hero ? 0.02 : -0.03;
        travel = 0.32;
        break;
      case 'stamp':
        x *= 0.25;
        y *= 0.3;
        break;
      case 'collage':
        x = (anchor.x - 0.5) * 0.6;
        y = (anchor.y - 0.5) * 0.3;
        rotation = (hero ? -1 : 1) * 0.02;
        break;
      case 'ripple':
        x *= 0.3;
        y *= 0.4;
        break;
      case 'void':
        x *= 0.5;
        y *= 0.4;
        break;
      default:
        break;
    }

    return {
      x,
      y,
      zoom: base,
      rotation,
      skew,
      shakeX: 0,
      shakeY: 0,
      punch: 0,
      travel,
    };
  };

  const to = target(cue.active);
  const from =
    cue.active === cue.previous
      ? { ...to, zoom: to.zoom - 0.075, x: to.x - 0.025, y: to.y + 0.016 }
      : target(cue.previous);

  const motion = pressureMix(0, 1, cue.move);
  const breath = Math.sin(time / 1900) * 0.004;
  const travelDirection = shot.kind === 'sweep' || shot.kind === 'banner' ? 1 : 0.35;
  const x = mix(from.x, to.x, motion) + breath * travelDirection;
  const y = mix(from.y, to.y, motion) + Math.sin(time / 2400) * 0.0035;
  const rotation = mix(from.rotation, to.rotation, motion) + Math.sin(time / 2800) * 0.0018;
  const zoom = mix(from.zoom, to.zoom, motion);
  const travel = mix(from.travel, to.travel, motion);

  // A held poster slowly pushes in; a drop gets a short punch on every accent.
  const holdPush =
    shot.kind === 'monolith' || shot.kind === 'typewall' || shot.kind === 'stamp'
      ? cue.progress * 0.035
      : 0;
  const punch = shot.sectionName === 'drop' ? cue.impact * 0.055 : cue.impact * 0.025;

  const energy = Number.isFinite(shot.energy) ? shot.energy : 0.5;
  // 冲击感交给 zoom/punch，画面位置只在 drop 段做极轻的余震；
  // 之前按 42ms 周期位移整个舞台，观感会像持续地震。
  const impactShake = shot.sectionName === 'drop' ? cue.impact * (0.0008 + energy * 0.0007) : 0;
  return fitCamera(
    {
      x,
      y,
      zoom: zoom + holdPush + punch,
      rotation,
      skew: 0,
      shakeX: Math.sin(time / 150) * impactShake,
      shakeY: Math.cos(time / 190) * impactShake * 0.55,
      punch: cue.impact,
      travel,
    },
    ratio,
  );
}

/** Parallax for foreground typography; the stage moves more than the words. */
export function pressureForeground(camera: PressureCamera): {
  x: number;
  y: number;
  zoom: number;
} {
  return { x: camera.x * 0.14 + camera.shakeX * 0.5, y: camera.y * 0.14 + camera.shakeY * 0.5, zoom: 1 };
}

/** A dedicated cut-frame camera used by transitions to keep the whip continuous. */
export function pressureWhipCamera(
  camera: PressureCamera,
  progress: number,
  direction: number,
): PressureCamera {
  const p = Math.max(0, Math.min(1, progress));
  const out = 1 - p;
  return {
    ...camera,
    x: camera.x - direction * p * 0.16,
    rotation: camera.rotation + direction * p * 0.02,
    skew: camera.skew + direction * p * 0.28,
    shakeX: camera.shakeX - direction * out * 0.012,
  };
}
