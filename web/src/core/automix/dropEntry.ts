/**
 * drop 落点（dropSwap / doubleDrop）：B 不从曲首进，而是直接切到它的第一个 drop / 副歌起点。
 *
 * 为什么要单独一个模块：这两种手法的**唯一区别**是「A 让得多快」——
 * - dropSwap：A 在同一个 downbeat 上干脆退出，全场只听到一个 drop（零重叠，最安全）。
 * - doubleDrop：A 的尾巴留在 B 的 drop 下面一小节，两个 drop 叠在一起（能量翻倍，要求同速）。
 * 落点求解（B 的 drop 在哪、是否在下一首可播范围内）与参数求解（swapShare / tailHold）放在一起，
 * 便于单测，也避免 `crossfadeDeck` 里再长出一段 if。
 */

import type { BeatAnalysis } from '../../online/analysis';

export interface DropEntryPlan {
  enabled: boolean;
  /** B 的文件坐标（毫秒）：drop / 副歌起点；未命中为 0。 */
  entryFileMs: number;
  /** 命中的段类型。 */
  label: 'drop' | 'chorus' | 'none';
  /** A 让位的比例（0–1）：dropSwap 很短，doubleDrop 留一小节。 */
  swapShare: number;
  /** A 的尾巴在 B 的 drop 下留多久（毫秒），仅 doubleDrop 非 0。 */
  tailHoldMs: number;
  note: string;
}

export interface DropEntryInput {
  b: BeatAnalysis;
  /** B 的可播起点（通常是 0 或裁掉前导静音后的位置）。 */
  fromMs: number;
  mode: 'dropSwap' | 'doubleDrop';
  barMs: number;
  /** B 的有效时长，用来拒绝「drop 在歌尾之外」。 */
  durationMs?: number;
}

/** drop 落点往后至少留这么多音频，否则切过去立刻结束。 */
export const DROP_MIN_HEADROOM_MS = 20_000;
/** dropSwap 时 A 只留 12% 窗口退出（≈半小节）。 */
export const DROP_SWAP_SHARE = 0.12;
/** doubleDrop 时 A 的尾巴在 B 的 drop 下留一小节（不超过窗口的一半）。 */
export const DOUBLE_DROP_HOLD_BARS = 1;

const OFF: DropEntryPlan = {
  enabled: false, entryFileMs: 0, label: 'none', swapShare: 0, tailHoldMs: 0,
  note: '没有找到可瞄准的 drop 落点',
};

export function planDropEntry(input: DropEntryInput): DropEntryPlan {
  const barMs = Number.isFinite(input.barMs) && input.barMs > 200 ? input.barMs : 2_000;
  const from = Number.isFinite(input.fromMs) ? Math.max(0, input.fromMs) : 0;
  const end = Number.isFinite(input.durationMs) && (input.durationMs ?? 0) > 0
    ? Math.max(0, input.durationMs as number)
    : Number.isFinite(input.b.audibleEndMs) ? input.b.audibleEndMs : 0;

  const sections = input.b.sections ?? [];
  const pick = sections
    .filter((s) => (s.label === 'drop' || s.label === 'chorus') && Number.isFinite(s.startMs))
    .filter((s) => s.startMs >= from)
    .filter((s) => !end || end - s.startMs >= Math.min(DROP_MIN_HEADROOM_MS, barMs * 4))
    .sort((x, y) => x.startMs - y.startMs)[0];

  if (!pick) return OFF;

  const entryFileMs = Math.round(pick.startMs);
  if (input.mode === 'dropSwap') {
    return {
      enabled: true,
      entryFileMs,
      label: pick.label as 'drop' | 'chorus',
      swapShare: DROP_SWAP_SHARE,
      tailHoldMs: 0,
      note: `dropSwap：B 直接切到 ${pick.label}（${(entryFileMs / 1000).toFixed(1)}s），A 在同一拍退出`,
    };
  }
  return {
    enabled: true,
    entryFileMs,
    label: pick.label as 'drop' | 'chorus',
    swapShare: 0.35,
    tailHoldMs: Math.round(barMs * DOUBLE_DROP_HOLD_BARS),
    note: `doubleDrop：B 的 ${pick.label} 落在 ${(entryFileMs / 1000).toFixed(1)}s，A 的尾巴多留一小节`,
  };
}
