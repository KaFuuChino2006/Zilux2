/** Fold half/double tempo to the ratio nearest unison, symmetrically. */
export function nearestTempoRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return 2 ** (Math.log2(ratio) - Math.round(Math.log2(ratio)));
}

export function smoothProgress(value: number): number {
  const p = Math.max(0, Math.min(1, value));
  return p * p * (3 - 2 * p);
}

/** Use one angle for both decks so uncorrelated, equally loud audio retains power. */
export function naturalGains(progress: number, overlapEnd = 1): [number, number] {
  // A linear angle gives B audible presence early, especially for short intros.
  const p = Math.max(0, Math.min(1, progress / overlapEnd));
  return [p >= 1 ? 0 : Math.cos(p * Math.PI / 2), Math.sin(p * Math.PI / 2)];
}

/** Only restore tempo after the outgoing deck is silent. */
export const MATCHED_OVERLAP_END = 0.82;
