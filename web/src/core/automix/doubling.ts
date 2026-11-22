/**
 * 叠播加厚（doubling）：把 B 的一小片（半拍 / 一拍）连打两遍，压成「加厚」的鼓，铺在 A 的最后几拍上。
 *
 * DJ 的 doubling 有两种：同一首在两条 deck 上错开半拍叠（变宽），或把一拍的切片在两拍里打两遍（变密）。
 * 这里做后者——它只需要 B 的一小片素材，不需要第二条 B 播放流，所以零分轨、也零额外解码。
 *
 * 素材来源优先取 B 的 drop / 副歌起点（那一下通常最结实），取不到就退到 B 的起播点。
 */

import type { BeatAnalysis } from '../../online/analysis';

export interface DoublingPlan {
  enabled: boolean;
  /** 切片起点（B 的文件坐标，毫秒）。 */
  sliceStartFileMs: number;
  /** 一片多长（毫秒）：半拍。 */
  sliceMs: number;
  /** 连打几遍：一小节 = 2 × meter 遍（4/4 → 8 遍）。 */
  repeats: number;
  /** 叠播从哪开始（相对过渡窗口结尾往前推一小节）。 */
  leadMs: number;
  note: string;
}

export interface DoublingInput {
  b: BeatAnalysis;
  /** B 的可播起点。 */
  fromMs: number;
  beatMs: number;
  barMs: number;
  fadeMs: number;
  /** 优先用的落点（例如 dropEntry 找到的 drop 起点）；0 表示没有。 */
  preferStartMs?: number;
}

/** 叠播最长一小节，再长就成 effect 表演。 */
export const DOUBLING_MAX_BARS = 1;
/** 一遍最少 120 ms（半拍 240 BPM 的下限），再短听不出「两下」。 */
export const DOUBLING_MIN_SLICE_MS = 120;

export function planDoubling(input: DoublingInput): DoublingPlan {
  const beatMs = Number.isFinite(input.beatMs) && input.beatMs > 80 ? input.beatMs : 500;
  const barMs = Number.isFinite(input.barMs) && input.barMs > 200 ? input.barMs : beatMs * 4;
  const fadeMs = Number.isFinite(input.fadeMs) ? Math.max(0, input.fadeMs) : 0;
  const off: DoublingPlan = {
    enabled: false, sliceStartFileMs: 0, sliceMs: 0, repeats: 0, leadMs: 0,
    note: '叠播加厚：窗口太短，放不下两遍',
  };
  if (fadeMs < barMs) return off;

  const sliceMs = Math.max(DOUBLING_MIN_SLICE_MS, Math.round(beatMs / 2));
  const leadMs = Math.min(Math.round(barMs * DOUBLING_MAX_BARS), Math.round(fadeMs * 0.5));
  const repeats = Math.max(4, Math.floor(leadMs / sliceMs));
  if (repeats * sliceMs < DOUBLING_MIN_SLICE_MS * 4) return off;

  const prefer = Number.isFinite(input.preferStartMs ?? NaN) && (input.preferStartMs ?? 0) > 0
    ? Math.round(input.preferStartMs as number)
    : 0;
  const sliceStartFileMs = prefer || Math.max(0, Math.round(input.fromMs));
  return {
    enabled: true,
    sliceStartFileMs,
    sliceMs,
    repeats,
    leadMs: repeats * sliceMs,
    note: `叠播加厚：B 的 ${(sliceMs / 1000).toFixed(2)}s 切片连打 ${repeats} 遍铺在 A 的最后 ${(repeats * sliceMs / 1000).toFixed(1)}s`,
  };
}
