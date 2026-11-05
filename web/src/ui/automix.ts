import type { OnlineTrack } from '../online/types';
import { cachedAnalysis, peekAnalysis } from '../online/analysis';
import { playerState, reorderUpcoming } from './player';

function parseCamelot(key?: string): { num: number; letter: string } | null {
  if (!key) return null;
  const match = /^(\d{1,2})([AB])$/i.exec(key.trim());
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num < 1 || num > 12) return null;
  return { num, letter: match[2].toUpperCase() };
}

/** Camelot 距离：同调 0 最好；相邻/关系大小调次之；其余递增。 */
export function camelotPenalty(a?: string, b?: string): number {
  const left = parseCamelot(a);
  const right = parseCamelot(b);
  if (!left || !right) return 2.2;
  if (left.letter === right.letter) {
    const raw = Math.abs(left.num - right.num) % 12;
    const dist = Math.min(raw, 12 - raw);
    return dist === 0 ? 0 : dist === 1 ? 0.7 : dist === 2 ? 1.8 : 3.2;
  }
  return left.num === right.num ? 0.5 : 2.6;
}

/** BPM 距离：允许半速/倍速（85 与 170 视为接近），±8% 内按比例加分。 */
export function bpmPenalty(a?: number, b?: number): number {
  if (!a || !b || !Number.isFinite(a) || !Number.isFinite(b)) return 1.4;
  let ratio = b / a;
  while (ratio >= 2) ratio /= 2;
  while (ratio < 1) ratio *= 2;
  const diff = Math.abs(ratio - 1);
  return diff <= 0.08 ? diff * 5 : 4 + (diff - 0.08) * 30;
}

interface MixEntry {
  track: OnlineTrack;
  camelot?: string;
  bpm?: number;
  known: boolean;
}

async function describe(track: OnlineTrack): Promise<MixEntry> {
  const result = cachedAnalysis(track) ?? (await peekAnalysis(track).catch(() => null));
  const analysis = result?.analysis;
  return {
    track,
    camelot: analysis?.camelot,
    bpm: analysis?.bpm,
    known: Boolean(analysis?.camelot || analysis?.bpm),
  };
}

/**
 * AutoMix：以当前曲为起点，用 Camelot 调性 + BPM 贪心重排待播队列。
 * 只动「当前之后的队列」，已播部分保持不动；最多分析 40 首，其余保持原顺序追加。
 */
export async function orderUpcomingByMix(): Promise<{ total: number; analyzed: number } | null> {
  const state = playerState();
  const upcoming = state.queue.slice(state.index + 1);
  if (!state.track || upcoming.length < 2) return null;
  const queueSignature = (snapshot: ReturnType<typeof playerState>): string =>
    `${snapshot.index}|${snapshot.queue.map((track) => `${track.source}:${track.id}`).join(',')}`;
  const beforeSignature = queueSignature(state);
  const head = await describe(state.track);
  const entries = await Promise.all(upcoming.slice(0, 40).map((track) => describe(track)));
  const analyzed = entries.filter((entry) => entry.known).length + (head.known ? 1 : 0);
  const pool = entries.slice();
  const ordered: OnlineTrack[] = [];
  let previous = head;
  while (pool.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < pool.length; index += 1) {
      const entry = pool[index];
      let score = camelotPenalty(previous.camelot, entry.camelot) + bpmPenalty(previous.bpm, entry.bpm);
      if (!entry.known) score += 1.1;
      if (!previous.known) score += 1.1;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    const [next] = pool.splice(bestIndex, 1);
    ordered.push(next.track);
    previous = next;
  }
  const now = playerState();
  // 分析期间用户切歌/换了队列：这次重排基于旧快照，放弃，避免覆盖新顺序。
  if (queueSignature(now) !== beforeSignature || now.track?.id !== state.track.id) return null;
  reorderUpcoming([...ordered, ...upcoming.slice(40)]);
  return { total: upcoming.length, analyzed };
}
