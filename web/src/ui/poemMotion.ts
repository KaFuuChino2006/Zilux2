/** Playback-time based motion: seeking produces the same frame, without a spring catching up. */
export const poemClamp = (v: number): number => Math.max(0, Math.min(1, v));
export const poemEase = (v: number): number => {
  const t = poemClamp(v);
  return t * t * t * (10 + t * (-15 + t * 6));
};

export function poemActiveIndex(starts: readonly number[], time: number): number {
  let low = 0, high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= time) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/** Neighbouring transition windows never overlap, even in rapid lyrics. */
export function poemCamera(starts: readonly number[], time: number): number {
  if (starts.length < 2) return 0;
  const active = poemActiveIndex(starts, time);
  for (const next of [Math.max(1, active), Math.max(1, active + 1)]) {
    if (next >= starts.length) continue;
    const before = Math.min(380, Math.max(0, starts[next] - starts[next - 1]) * 0.32);
    const after = Math.min(620, Math.max(0, (starts[next + 1] ?? starts[next] + 2000) - starts[next]) * 0.44);
    const begin = starts[next] - before, end = starts[next] + after;
    if (time >= begin && time <= end && end > begin) {
      return next - 1 + poemEase((time - begin) / (end - begin));
    }
  }
  return Math.max(0, Math.min(starts.length - 1, active));
}
