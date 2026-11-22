/**
 * 曲风预算：同一套手法在不同曲风里的「合适长度」差很多。
 *
 * 没有 genre 标签（宿主分析器只给 bpm / meter / energy / 唱词活动度），
 * 所以用可解释的启发式反推一个**粗略**曲风，只用来决定「过渡最长能多长 / 手势手法最多几秒」。
 * 反推错了代价很小（只是长度差一两小节），所以宁可简单、可读、可单测。
 */

import type { BeatAnalysis } from '../../online/analysis';

export type GenreGuess = 'hiphop' | 'house' | 'techno' | 'dnb' | 'pop' | 'ambient';

export interface MixBudget {
  /** 普通手法（bassSwap / eqSwap / longBlend…）最长多少毫秒。 */
  maxFadeMs: number;
  /** cut / slam / dropSwap 这类「手势」最长多少毫秒。 */
  gestureMaxMs: number;
  genre: GenreGuess;
  note: string;
}

/** energy 缺省时按 0.5 处理（老缓存没有这个字段）。 */
function energyOf(a: BeatAnalysis): number {
  const e = a.energy;
  return Number.isFinite(e) ? Math.max(0, Math.min(1, e as number)) : 0.5;
}

/** 全曲人声密度（0..1）：`activity.vocal > 0.45` 的采样占比。 */
export function vocalDensity(a: BeatAnalysis): number {
  const vocal = a.activity?.vocal ?? [];
  if (vocal.length < 8) return 0.5;
  let voiced = 0;
  for (const v of vocal) if (v > 0.45) voiced += 1;
  return voiced / vocal.length;
}

/**
 * 反推曲风（只用于长度预算，不要拿它当标签展示）。
 *
 * 顺序有意义：先判「慢 + 人声密」的 hip-hop，再判快于 150 的 dnb，
 * 否则 90 BPM 的 hip-hop 会被 ambient 抢走、170 BPM 的 dnb 会被 techno 抢走。
 */
export function inferGenre(a: BeatAnalysis): GenreGuess {
  const bpm = Number.isFinite(a.bpm) && a.bpm > 0 ? a.bpm : 120;
  const energy = energyOf(a);
  const vocal = vocalDensity(a);

  if (bpm < 105 && vocal >= 0.35) return 'hiphop';
  if (bpm >= 150) return 'dnb';
  if (energy <= 0.28 && vocal <= 0.2) return 'ambient';
  if (bpm >= 132) return 'techno';
  if (bpm >= 112) return 'house';
  return 'pop';
}

export function mixBudgetMs(genre: GenreGuess, barMs: number): MixBudget {
  const bar = Number.isFinite(barMs) && barMs > 200 ? barMs : 2_000;
  switch (genre) {
    case 'hiphop':
      // 说唱靠人声推进，长重叠会糊词；两小节刚好一个 bar。
      return { maxFadeMs: Math.round(bar * 2), gestureMaxMs: 2_600, genre, note: 'hip-hop：两小节，超过就糊词' };
    case 'house':
      return { maxFadeMs: Math.round(bar * 4), gestureMaxMs: 4_000, genre, note: 'house：四小节，接近 DJ 常规' };
    case 'techno':
      return { maxFadeMs: Math.round(bar * 8), gestureMaxMs: 6_000, genre, note: 'techno：八小节，长混不违和' };
    case 'dnb':
      // 170 BPM 的小节只有 1.4 s，八小节也就 11 s。
      return { maxFadeMs: Math.round(bar * 8), gestureMaxMs: 4_800, genre, note: 'dnb：八小节（小节本身很短）' };
    case 'ambient':
      return { maxFadeMs: Math.round(bar * 8), gestureMaxMs: 6_000, genre, note: 'ambient：八小节，慢一点更好' };
    default:
      return { maxFadeMs: Math.round(bar * 4), gestureMaxMs: 4_000, genre, note: '流行：四小节，稳' };
  }
}

/** 一步到位：曲目 + 小节长度 → 预算。 */
export function budgetForAnalysis(a: BeatAnalysis, barMs: number): MixBudget {
  return mixBudgetMs(inferGenre(a), barMs);
}
