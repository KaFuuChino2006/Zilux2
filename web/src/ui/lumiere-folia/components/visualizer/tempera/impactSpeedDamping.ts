// The camera spring is shared by overlap and wenflash. A fast pan already carries a lot of
// screen motion; adding the same elastic bump on top makes it read as a much bigger kick than
// it does at rest. This is a pure, deterministic damping curve for the impact only: slow moves
// keep the authored feel, fast moves lose amplitude and ring, and the hand-off is smooth.
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export const IMPACT_SPEED_SPAN = 1900;

export function impactSpeedScale(
  speed: number,
  dampPercent = 62,
  fromSpeed = 700,
): number {
  const damp = Math.max(0, Math.min(2, dampPercent / 100));
  if (damp <= 0) return 1;
  const from = Math.max(0, Math.min(3000, fromSpeed));
  const t = clamp01((speed - from) / IMPACT_SPEED_SPAN);
  const eased = t * t * (3 - 2 * t);
  return clamp01(1 - damp * eased);
}

export function impactSpringDamping(
  speed: number,
  dampPercent = 62,
  fromSpeed = 700,
): {
  amplitude: number;
  frequency: number;
  decay: number;
} {
  const amplitude = impactSpeedScale(speed, dampPercent, fromSpeed);
  return {
    amplitude,
    // Fast moves should not whip: lower the ring frequency a little and shorten the tail more.
    frequency: 0.68 + 0.32 * amplitude,
    decay: 0.55 + 0.45 * amplitude,
  };
}
