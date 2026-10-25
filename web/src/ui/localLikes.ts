/**
 * 本地曲目收藏（红心）：与在线「我喜欢的音乐」完全分开存储，由 app.ts 合并展示。
 *
 * localStorage 键：`zilux2.localLiked`
 * 值：`{"v":1,"keys":["专辑/01.flac","专辑/02.flac#125000"]}`
 * key 与 localPlaylists 的 trackKey 完全一致（rel / rel#CUE起始毫秒），格式依据见
 * web/src/ui/localPlaylists.ts 文件头注释。
 */

import type { OnlineTrack } from '../online/types';
import { trackKeyOfTrack } from './localPlaylists';

/** localStorage 键（约定值，不要改）。 */
export const LOCAL_LIKED_KEY = 'zilux2.localLiked';

export type LocalLikedListener = (keys: string[]) => void;

interface StoredLiked {
  v?: number;
  keys?: unknown;
}

const listeners = new Set<LocalLikedListener>();
let cache: string[] | null = null;

function sanitizeKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function readFromStorage(): string[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_LIKED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // 兼容早期直接存数组的形态。
    const list = Array.isArray(parsed) ? parsed : (parsed as StoredLiked | null)?.keys;
    return sanitizeKeys(list);
  } catch (err) {
    console.warn('[localLikes] 读取失败，按未收藏处理', err);
    return [];
  }
}

function state(): string[] {
  if (!cache) cache = readFromStorage();
  return cache;
}

function persist(next: string[]): void {
  cache = next;
  try {
    window.localStorage.setItem(LOCAL_LIKED_KEY, JSON.stringify({ v: 1, keys: next }));
  } catch (err) {
    // localStorage 不可用时仍在内存生效，只记录日志。
    console.warn('[localLikes] 保存失败（localStorage 不可用）', err);
  }
  listeners.forEach((fn) => {
    try {
      fn([...next]);
    } catch (err) {
      console.warn('[localLikes] listener failed', err);
    }
  });
}

/** 入参可以是 trackKey 字符串，也可以是 source='local' 的 OnlineTrack（内部换算成同一 key）。 */
function keyOf(target: string | OnlineTrack): string | null {
  if (typeof target === 'string') {
    const key = target.trim();
    return key || null;
  }
  return trackKeyOfTrack(target);
}

/** 是否已收藏（target 无法换算成 key 时返回 false）。 */
export function isLocalLiked(target: string | OnlineTrack): boolean {
  const key = keyOf(target);
  return key ? state().includes(key) : false;
}

/** 切换收藏；返回切换后的收藏状态（target 无 key 时返回 false）。 */
export function toggleLocalLike(target: string | OnlineTrack): boolean {
  const key = keyOf(target);
  if (!key) return false;
  const current = state();
  const liked = current.includes(key);
  persist(liked ? current.filter((item) => item !== key) : [...current, key]);
  return !liked;
}

/** 显式设置收藏状态；返回操作后是否处于收藏（target 无 key 时返回 false）。 */
export function setLocalLiked(target: string | OnlineTrack, liked: boolean): boolean {
  const key = keyOf(target);
  if (!key) return false;
  const current = state();
  const exists = current.includes(key);
  if (exists === liked) return exists;
  persist(liked ? [...current, key] : current.filter((item) => item !== key));
  return liked;
}

/** 已收藏的 key 列表（收藏顺序，旧 → 新；需要「最新在前」时调用方自行 reverse）。 */
export function likedLocalKeys(): string[] {
  return [...state()];
}

/** 已收藏数量。 */
export function likedLocalCount(): number {
  return state().length;
}

/** 清空全部本地收藏（设置页「清空本地缓存」用；无数据时不触发通知）。 */
export function clearLocalLikes(): void {
  if (state().length) persist([]);
}

/** 订阅变化；立即回调一次当前列表，返回取消函数。 */
export function subscribe(fn: LocalLikedListener): () => void {
  listeners.add(fn);
  fn(likedLocalKeys());
  return () => {
    listeners.delete(fn);
  };
}
