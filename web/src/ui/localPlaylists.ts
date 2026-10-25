/**
 * 本地自建歌单：localStorage 持久化 + 订阅通知。
 *
 * 只保存稳定的 trackKey，不保存曲目对象：
 * - 普通本地曲目 / 下载曲目：rel（相对曲库根的路径；下载曲目带 `@downloads/` 前缀），
 *   与 web/src/ui/local.ts:64 `trackOf()`、local.ts:89 `relOf()` 使用的 rel 完全一致；
 * - CUE 分轨：同一镜像文件会被拆成多首，用 `${rel}#<起始毫秒>` 区分，
 *   起始毫秒 = LocalEntry.startAt（秒）× 1000，见 web/src/ui/local.ts:136。
 *   宿主给的 startMs 是整数，round 后不会因浮点误差抖动；Windows 文件名不允许 `#`，
 *   所以该分隔符不会与真实 rel 冲突。
 *
 * 数据示例（localStorage `zilux2.localPlaylists`）：
 * [{"id":"pl_lq3k9x_a1b2c3","name":"深夜歌单","trackKeys":["专辑/01.flac","专辑/02.flac#125000"],"createdAt":1761300000000}]
 */

import type { OnlineTrack } from '../online/types';
import { localLibrary, relOf, trackOf, type LocalEntry } from './local';

/** localStorage 键（约定值，不要改）。 */
export const LOCAL_PLAYLISTS_KEY = 'zilux2.localPlaylists';

/** 歌单名最大长度。 */
export const LOCAL_PLAYLIST_NAME_MAX = 60;

export interface LocalPlaylist {
  id: string;
  name: string;
  /** 稳定本地曲目标识，格式见文件头注释。 */
  trackKeys: string[];
  createdAt: number;
}

export type LocalPlaylistListener = (playlists: LocalPlaylist[]) => void;

export interface LocalTrackKeyParts {
  /** 相对曲库根路径（下载曲目带 `@downloads/` 前缀）。 */
  rel: string;
  /** CUE 分轨起始毫秒；0 表示整个文件。 */
  startAtMs: number;
}

const listeners = new Set<LocalPlaylistListener>();
let cache: LocalPlaylist[] | null = null;

/* ------------------------------------------------------------------ */
/* trackKey：稳定本地曲目标识                                            */
/* ------------------------------------------------------------------ */

/** 用 rel（+ CUE 起始毫秒）拼稳定 trackKey。 */
export function localTrackKey(rel: string, startAtMs = 0): string {
  const clean = rel.trim();
  if (!clean) return '';
  const start = Number.isFinite(startAtMs) && startAtMs > 0 ? Math.round(startAtMs) : 0;
  return start > 0 ? `${clean}#${start}` : clean;
}

/** 解析 trackKey；非法返回 null。 */
export function parseLocalTrackKey(key: string): LocalTrackKeyParts | null {
  const raw = typeof key === 'string' ? key.trim() : '';
  if (!raw) return null;
  const hash = raw.lastIndexOf('#');
  if (hash < 0) return { rel: raw, startAtMs: 0 };
  const rel = raw.slice(0, hash);
  if (!rel) return null;
  const start = Number(raw.slice(hash + 1));
  return { rel, startAtMs: Number.isFinite(start) && start > 0 ? Math.round(start) : 0 };
}

/** LocalEntry（宿主扫描结果）→ trackKey。 */
export function trackKeyOfEntry(entry: LocalEntry): string {
  return localTrackKey(entry.rel, entry.startAt > 0 ? entry.startAt * 1000 : 0);
}

/** OnlineTrack（source='local'）→ trackKey；非本地曲目返回 null。 */
export function trackKeyOfTrack(track: OnlineTrack): string | null {
  if (track.source !== 'local') return null;
  const rel = relOf(track);
  if (!rel) return null;
  const startAt = Number(track.startAt ?? 0);
  return localTrackKey(rel, Number.isFinite(startAt) && startAt > 0 ? startAt * 1000 : 0);
}

/** trackKey → 当前曲库里的 LocalEntry；曲库未载入/已变化时返回 null。 */
export function entryOfTrackKey(key: string): LocalEntry | null {
  const parts = parseLocalTrackKey(key);
  const library = localLibrary();
  if (!parts || !library) return null;
  const startAtMs = Math.round(parts.startAtMs);
  return (
    library.entries.find(
      (entry) => entry.rel === parts.rel && Math.round(entry.startAt * 1000) === startAtMs,
    ) ?? null
  );
}

/** trackKey → 统一曲目对象（可用现有行组件/播放器；映射也会登记 rel，供 relOf 使用）。 */
export function trackOfTrackKey(key: string): OnlineTrack | null {
  const entry = entryOfTrackKey(key);
  return entry ? trackOf(entry) : null;
}

/** 批量把 trackKey 解析成曲目；当前曲库已不存在的 key 会被跳过（返回数组长度可能小于入参）。 */
export function tracksOfKeys(keys: string[]): OnlineTrack[] {
  const tracks: OnlineTrack[] = [];
  for (const key of keys) {
    const track = trackOfTrackKey(key);
    if (track) tracks.push(track);
  }
  return tracks;
}

/* ------------------------------------------------------------------ */
/* 持久化                                                                */
/* ------------------------------------------------------------------ */

function clonePlaylist(playlist: LocalPlaylist): LocalPlaylist {
  return { ...playlist, trackKeys: [...playlist.trackKeys] };
}

function cloneAll(playlists: LocalPlaylist[]): LocalPlaylist[] {
  return playlists.map(clonePlaylist);
}

function sanitizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) return '新建歌单';
  return name.slice(0, LOCAL_PLAYLIST_NAME_MAX);
}

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

function sanitizePlaylist(raw: unknown): LocalPlaylist | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as { id?: unknown; name?: unknown; trackKeys?: unknown; createdAt?: unknown };
  if (typeof item.id !== 'string' || !item.id.trim()) return null;
  return {
    id: item.id,
    name: sanitizeName(item.name),
    trackKeys: sanitizeKeys(item.trackKeys),
    createdAt:
      typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
        ? item.createdAt
        : Date.now(),
  };
}

function readFromStorage(): LocalPlaylist[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_PLAYLISTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // 兼容以后可能加版本包裹的 `{ v, playlists: [] }` 形态。
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { playlists?: unknown } | null)?.playlists;
    if (!Array.isArray(list)) return [];
    const playlists: LocalPlaylist[] = [];
    const ids = new Set<string>();
    for (const item of list) {
      const playlist = sanitizePlaylist(item);
      if (!playlist || ids.has(playlist.id)) continue;
      ids.add(playlist.id);
      playlists.push(playlist);
    }
    return playlists;
  } catch (err) {
    console.warn('[localPlaylists] 读取失败，按空歌单处理', err);
    return [];
  }
}

function state(): LocalPlaylist[] {
  if (!cache) cache = readFromStorage();
  return cache;
}

function persist(next: LocalPlaylist[]): void {
  cache = next;
  try {
    window.localStorage.setItem(LOCAL_PLAYLISTS_KEY, JSON.stringify(next));
  } catch (err) {
    // localStorage 不可用（隐私/配额）时仍在内存生效，只记录日志。
    console.warn('[localPlaylists] 保存失败（localStorage 不可用）', err);
  }
  listeners.forEach((fn) => {
    try {
      fn(cloneAll(next));
    } catch (err) {
      console.warn('[localPlaylists] listener failed', err);
    }
  });
}

function newId(): string {
  return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ */
/* 歌单 API                                                              */
/* ------------------------------------------------------------------ */

/** 全部歌单（按创建顺序；返回深拷贝，调用方可安全修改）。 */
export function listPlaylists(): LocalPlaylist[] {
  return cloneAll(state());
}

/** 单个歌单；不存在返回 null。 */
export function getPlaylist(id: string): LocalPlaylist | null {
  const found = state().find((playlist) => playlist.id === id);
  return found ? clonePlaylist(found) : null;
}

/** 新建歌单；trackKeys 可省。返回新歌单（id/createdAt 已生成）。 */
export function createPlaylist(name: string, trackKeys: string[] = []): LocalPlaylist {
  const playlist: LocalPlaylist = {
    id: newId(),
    name: sanitizeName(name),
    trackKeys: sanitizeKeys(trackKeys),
    createdAt: Date.now(),
  };
  persist([...state(), playlist]);
  return clonePlaylist(playlist);
}

/** 改名；空名会退化为「新建歌单」。歌单不存在返回 false。 */
export function renamePlaylist(id: string, name: string): boolean {
  const current = state();
  const index = current.findIndex((playlist) => playlist.id === id);
  if (index < 0) return false;
  const next = [...current];
  next[index] = { ...current[index], name: sanitizeName(name) };
  persist(next);
  return true;
}

/** 删除歌单；不存在返回 false。 */
export function deletePlaylist(id: string): boolean {
  const current = state();
  const next = current.filter((playlist) => playlist.id !== id);
  if (next.length === current.length) return false;
  persist(next);
  return true;
}

/** 加曲目（去重，保持既有顺序）；返回真正新增的数量。 */
export function addTracks(playlistId: string, keys: string[]): number {
  const current = state();
  const index = current.findIndex((playlist) => playlist.id === playlistId);
  if (index < 0) return 0;
  const playlist = current[index];
  const existing = new Set(playlist.trackKeys);
  const added = sanitizeKeys(keys).filter((key) => !existing.has(key));
  if (!added.length) return 0;
  const next = [...current];
  next[index] = { ...playlist, trackKeys: [...playlist.trackKeys, ...added] };
  persist(next);
  return added.length;
}

/** 从歌单移除一首；不存在返回 false。 */
export function removeTrack(playlistId: string, key: string): boolean {
  const current = state();
  const index = current.findIndex((playlist) => playlist.id === playlistId);
  if (index < 0) return false;
  const target = typeof key === 'string' ? key.trim() : '';
  if (!target) return false;
  const playlist = current[index];
  const trackKeys = playlist.trackKeys.filter((item) => item !== target);
  if (trackKeys.length === playlist.trackKeys.length) return false;
  const next = [...current];
  next[index] = { ...playlist, trackKeys };
  persist(next);
  return true;
}

/** 拖拽排序：把 from 位置的曲目移到 to（0 起，越界/相同返回 false）。 */
export function reorder(playlistId: string, from: number, to: number): boolean {
  const current = state();
  const index = current.findIndex((playlist) => playlist.id === playlistId);
  if (index < 0) return false;
  const playlist = current[index];
  const { trackKeys } = playlist;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
  if (from < 0 || from >= trackKeys.length || to < 0 || to >= trackKeys.length) return false;
  if (from === to) return false;
  const nextKeys = [...trackKeys];
  const [moved] = nextKeys.splice(from, 1);
  nextKeys.splice(to, 0, moved);
  const next = [...current];
  next[index] = { ...playlist, trackKeys: nextKeys };
  persist(next);
  return true;
}

/** 某首曲目所在的全部歌单（用于「已加入歌单」标记）。 */
export function playlistsContaining(key: string): LocalPlaylist[] {
  const target = typeof key === 'string' ? key.trim() : '';
  if (!target) return [];
  return state()
    .filter((playlist) => playlist.trackKeys.includes(target))
    .map(clonePlaylist);
}

/** 订阅变化；立即回调一次当前列表，返回取消函数。 */
export function subscribe(fn: LocalPlaylistListener): () => void {
  listeners.add(fn);
  fn(listPlaylists());
  return () => {
    listeners.delete(fn);
  };
}
