import type { OnlineTrack } from '../online/types';
import { cachedAnalysis, peekAnalysis } from '../online/analysis';

export interface MoodAnalysis {
  bpm: number;
  energy: number;
  camelot?: string;
  hasClimax: boolean;
}

export interface MoodDef {
  id: string;
  label: string;
  hint: string;
  test(analysis: MoodAnalysis): boolean;
}

/** 场景分桶规则：用宿主分析出的 BPM / 能量 / 高潮段做判定。 */
export const MOOD_DEFS: MoodDef[] = [
  {
    id: 'midnight',
    label: '深夜慢歌',
    hint: 'BPM ≤ 100 · 低能量',
    test: (analysis) => analysis.bpm > 0 && analysis.bpm <= 100 && analysis.energy < 0.7,
  },
  {
    id: 'commute',
    label: '通勤动感',
    hint: 'BPM ≥ 110 · 中高能量',
    test: (analysis) => analysis.bpm >= 110 && analysis.energy >= 0.62,
  },
  {
    id: 'focus',
    label: '专注轻听',
    hint: 'BPM 70–125 · 中低能量',
    test: (analysis) => analysis.bpm >= 70 && analysis.bpm <= 125 && analysis.energy < 0.75,
  },
  {
    id: 'burst',
    label: '高能爆发',
    hint: '能量 ≥ 0.74 或含明显高潮段',
    test: (analysis) => analysis.energy >= 0.74 || (analysis.hasClimax && analysis.energy >= 0.68),
  },
];

/** 把 BPM 折进 70–140（八度等价的常用听感区间），避免半拍/双拍误判影响分桶。 */
function foldBpm(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  let bpm = value;
  while (bpm >= 140) bpm /= 2;
  while (bpm > 0 && bpm < 70) bpm *= 2;
  return bpm;
}

function toMoodAnalysis(analysis: {
  bpm?: number;
  energy?: number;
  camelot?: string;
  climaxStartMs?: number;
  climaxEndMs?: number;
} | null | undefined): MoodAnalysis | null {
  if (!analysis) return null;
  // 节拍检测常把四拍切成两拍（或反向），把 BPM 折进 70–140 的常用区间后再分桶。
  const bpm = foldBpm(typeof analysis.bpm === 'number' ? analysis.bpm : 0);
  const energy = typeof analysis.energy === 'number' ? analysis.energy : 0;
  if (!bpm && !energy) return null;
  const start = analysis.climaxStartMs ?? 0;
  const end = analysis.climaxEndMs ?? 0;
  return { bpm, energy, camelot: analysis.camelot, hasClimax: start > 0 && end > start };
}

/** 对候选池做缓存优先分析（peekAnalysis 不触发解码），返回命中的曲目。 */
export async function matchMood(
  def: MoodDef,
  pool: OnlineTrack[],
): Promise<{ tracks: OnlineTrack[]; analyzed: number }> {
  const sample = pool.slice(0, 160);
  const results = await Promise.all(
    sample.map(async (track) => {
      const result = cachedAnalysis(track) ?? (await peekAnalysis(track).catch(() => null));
      const analysis = toMoodAnalysis(result?.analysis);
      return { track, analysis };
    }),
  );
  const hits = results.filter((entry) => entry.analysis && def.test(entry.analysis));
  return { tracks: hits.map((entry) => entry.track), analyzed: results.filter((entry) => entry.analysis).length };
}
