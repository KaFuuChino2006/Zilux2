import type { BeatAnalysis } from '../online/analysis';
import { compensationDbFor } from './loudness';

/** Energy average of measured, audible windows. Silence/fade tails must not be boosted. */
export function regionLoudness(analysis: BeatAnalysis, startMs: number, endMs: number): number | null {
  if (analysis.loudnessMethod !== 'bs1770') return null;
  const times = analysis.loudnessTimesMs ?? [], levels = analysis.momentaryLufs ?? [];
  let energy = 0, count = 0;
  for (let i = 0; i < times.length; i++) {
    const level = levels[i];
    if (times[i] < startMs || times[i] > endMs || !Number.isFinite(level) || level < -50) continue;
    energy += 10 ** (level / 10); count++;
  }
  return count >= 3 ? 10 * Math.log10(energy / count) : null;
}

/** Independent temporary B correction. ±3dB preserves musical dynamics. */
export function transitionMatchDb(a: BeatAnalysis, b: BeatAnalysis, aStart: number, bStart: number, duration: number, rate: number): number {
  const left = regionLoudness(a, aStart, aStart + Math.min(duration, 6000));
  const right = regionLoudness(b, bStart, bStart + Math.min(duration * rate, 6000));
  if (left === null || right === null) return 0;
  const aTrim = compensationDbFor(a.loudnessLufs, a.peakDb) ?? 0;
  const bTrim = compensationDbFor(b.loudnessLufs, b.peakDb) ?? 0;
  let correction = Math.max(-3, Math.min(3, left + aTrim - right - bTrim));
  if (correction > 0) {
    // No peak evidence means no extra boost. Account for existing per-track gain.
    correction = typeof b.peakDb === 'number' && Number.isFinite(b.peakDb)
      ? Math.min(correction, Math.max(0, -3 - b.peakDb - bTrim)) : 0;
  }
  return correction;
}
