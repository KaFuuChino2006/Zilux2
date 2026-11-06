/**
 * 网易云「心动模式」自动续排。
 *
 * 心动模式一次只回 30 首左右；这里记住首次请求的「我喜欢的音乐」歌单 id 与种子曲目，
 * 在队列快播到尾巴（剩余 ≤ {@link REFILL_REMAINING} 首）时用「最新播放的心动曲目」作种子
 * 再取一批，按 `source:id` 去重后追加——不打断当前播放、不重复入队。
 *
 * 失败策略：
 *   - 请求失败：静默（不弹提示），等下一次切歌再试；
 *   - 返回空 / 全部重复：记一次 {@link EMPTY_COOLDOWN_MS} 的短冷却，避免在尾巴上空转；
 *   - 退出心动模式 / 换队列 / 清空队列：作废在途请求（generation 标记位），不再写回队列。
 *
 * 与播放器的分工：队列的追加与去重由 player 的 lookahead 续接器完成，
 * 这里只负责「取哪一批」与「要不要继续」。
 */

import { api } from '../online/client';
import type { OnlineTrack } from '../online/types';
import { onPlayer, setLookaheadRefill, type LookaheadRefill } from './player';

/** 每次续排取多少首（宿主上限 50，与首次心动模式保持一致）。 */
const REFILL_LIMIT = 30;
/** 队列剩余（当前下标之后的曲目数）≤ 该值时开始预取。 */
const REFILL_REMAINING = 2;
/** 空批次 / 全部重复后的冷却时间：避免在队列尾部反复空转。 */
const EMPTY_COOLDOWN_MS = 60_000;
/** 单次续排请求超时（宿主 eapi 最坏也要十几秒）。 */
const REFILL_TIMEOUT_MS = 20_000;

/** 心动模式上下文：歌单 id 首次请求时固定，种子随切歌更新。 */
export interface HeartRadioContext {
  playlistId: string;
  seedId: string;
}

let context: HeartRadioContext | null = null;
/** 在途请求标记位：每次退出/重启自增，闭包里看到旧值就丢弃结果。 */
let generation = 0;
/** 空批次冷却截止时间（毫秒时间戳）。 */
let cooldownUntil = 0;
/** 跟随切歌更新种子。 */
let unsubscribePlayer: (() => void) | null = null;
/** 当前挂在播放器上的续接器（退出时整块摘掉）。 */
let activeRefill: LookaheadRefill | null = null;

/** 心动模式是否仍处于「续排中」。 */
export function heartRadioActive(): boolean {
  return context !== null;
}

/** 当前种子曲目 id（调试/展示用；未开启时为空串）。 */
export function heartRadioSeed(): string {
  return context?.seedId ?? '';
}

/**
 * 开启心动模式续排。调用方应已把首批曲目 `playQueue()` 进队列——
 * 播放器换队列时会先清掉旧的续接器，所以必须在开播之后再注册。
 */
export function startHeartRadio(playlistId: string, seedId: string): void {
  if (!playlistId || !seedId) return;
  stopHeartRadio();
  context = { playlistId, seedId };
  cooldownUntil = 0;
  // 切歌时把种子换成最近播放的心动曲目，下一批更贴近当前口味。
  unsubscribePlayer = onPlayer((state) => {
    const track = state.track;
    const current = context;
    if (!current || !track || track.source !== 'netease' || !track.id) return;
    if (current.seedId === track.id) return;
    context = { ...current, seedId: track.id };
  });
  const refill: LookaheadRefill = {
    remaining: REFILL_REMAINING,
    load: fetchBatch,
    onAppended: (added) => {
      if (added === 0) cooldownUntil = Date.now() + EMPTY_COOLDOWN_MS;
    },
    // 播放器换队列 / 停播时清掉了续接器：同步退出，别留下幽灵状态。
    onCleared: () => release(),
  };
  activeRefill = refill;
  setLookaheadRefill(refill);
}

/** 关闭心动模式续排（队列继续播放，只是不再自动续）。 */
export function stopHeartRadio(): void {
  const hadRefill = activeRefill !== null;
  release();
  // 摘掉播放器上的续接器：在途请求靠 generation 标记位作废。
  if (hadRefill) setLookaheadRefill(null);
}

/** 只清内部状态（不碰播放器），供续接器 onCleared 回调用。 */
function release(): void {
  generation += 1;
  context = null;
  cooldownUntil = 0;
  activeRefill = null;
  const off = unsubscribePlayer;
  unsubscribePlayer = null;
  if (off) off();
}

/** 取下一批心动曲目；抛错 = 这次没取到（播放器静默重试下一次切歌）。 */
async function fetchBatch(): Promise<OnlineTrack[]> {
  const current = context;
  if (!current) return [];
  if (Date.now() < cooldownUntil) throw new Error('heart-radio-cooldown');
  const token = generation;
  const response = await api<{ tracks?: OnlineTrack[] }>(
    '/api/netease/intelligence',
    { playlist: current.playlistId, songId: current.seedId, count: String(REFILL_LIMIT) },
    REFILL_TIMEOUT_MS,
    'GET',
  );
  // 请求期间用户退出了心动模式：结果直接丢弃，不写回队列。
  if (token !== generation || !context) return [];
  return (response.tracks ?? []).filter((track) => track && typeof track.id === 'string' && track.id.length > 0);
}
