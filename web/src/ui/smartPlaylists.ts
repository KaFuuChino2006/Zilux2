/**
 * 智能歌单：把「场景歌单 / 每日推荐 / 喜欢 / 最近播放」这类动态列表整份存下来。
 *
 * 本地歌单（localPlaylists.ts）只存本地文件的 trackKey，无法容纳在线曲目；
 * 这里改为直接保存歌单快照：
 *
 * 数据示例（localStorage `zilux2.smartPlaylists`）：
 * [{"id":"sp_lq3k9x_a1b2c3","name":"深夜慢歌 · 11/3","createdAt":1761300000000,
 *   "tracks":[{"source":"netease","id":"2689955959","title":"520的入场券","artist":"康熙","album":"","durationMs":174000,"cover":"/api/cover?...","playable":true}]}]
 */

import type { OnlineTrack } from '../online/types';

export const SMART_PLAYLIST_STORAGE_KEY = 'zilux2.smartPlaylists';
export const SMART_PLAYLIST_NAME_MAX = 60;
export const SMART_PLAYLIST_MAX_TRACKS = 500;

export interface SmartPlaylist {
  id: string;
  name: string;
  createdAt: number;
  tracks: OnlineTrack[];
}

type Listener = () => void;
const listeners = new Set<Listener>();

function newId(): string {
  return `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeName(value: string): string {
  const trimmed = (value ?? '').trim().slice(0, SMART_PLAYLIST_NAME_MAX);
  return trimmed || '智能歌单';
}

function sanitizeTrack(raw: unknown): OnlineTrack | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const source = typeof record.source === 'string' ? record.source : '';
  const id = typeof record.id === 'string' ? record.id : '';
  const title = typeof record.title === 'string' ? record.title : '';
  if (!source || !id || !title) return null;
  return {
    source,
    id,
    title,
    artist: typeof record.artist === 'string' ? record.artist : '',
    album: typeof record.album === 'string' ? record.album : '',
    durationMs: typeof record.durationMs === 'number' && record.durationMs > 0 ? record.durationMs : 0,
    cover: typeof record.cover === 'string' ? record.cover : '',
    playable: record.playable !== false,
    vip: record.vip === true ? true : null,
    ...(typeof record.startAt === 'number' && record.startAt > 0 ? { startAt: record.startAt } : {}),
  };
}

function sanitizeTracks(raw: unknown): OnlineTrack[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tracks: OnlineTrack[] = [];
  for (const item of raw) {
    const track = sanitizeTrack(item);
    if (!track) continue;
    const key = `${track.source}:${track.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push(track);
    if (tracks.length >= SMART_PLAYLIST_MAX_TRACKS) break;
  }
  return tracks;
}

function read(): SmartPlaylist[] {
  try {
    const raw = globalThis.localStorage?.getItem(SMART_PLAYLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const result: SmartPlaylist[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === 'string' && record.id ? record.id : newId();
      const tracks = sanitizeTracks(record.tracks);
      if (tracks.length === 0) continue;
      result.push({
        id,
        name: sanitizeName(typeof record.name === 'string' ? record.name : ''),
        createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
        tracks,
      });
    }
    return result;
  } catch {
    return [];
  }
}

function persist(next: SmartPlaylist[]): void {
  try {
    globalThis.localStorage?.setItem(SMART_PLAYLIST_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 存储被禁用时保持内存态不可用，忽略 */
  }
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      /* 单个订阅者出错不影响其它 UI */
    }
  });
}

/** 当前全部智能歌单（按创建时间倒序）。 */
export function listSmartPlaylists(): SmartPlaylist[] {
  return read().sort((a, b) => b.createdAt - a.createdAt);
}

export function getSmartPlaylist(id: string): SmartPlaylist | null {
  return read().find((playlist) => playlist.id === id) ?? null;
}

/** 新建智能歌单；返回新歌单。 */
export function createSmartPlaylist(name: string, tracks: OnlineTrack[]): SmartPlaylist {
  const playlist: SmartPlaylist = {
    id: newId(),
    name: sanitizeName(name),
    createdAt: Date.now(),
    tracks: sanitizeTracks(tracks),
  };
  persist([...read(), playlist]);
  return playlist;
}

export function deleteSmartPlaylist(id: string): boolean {
  const current = read();
  const next = current.filter((playlist) => playlist.id !== id);
  if (next.length === current.length) return false;
  persist(next);
  return true;
}

export function renameSmartPlaylist(id: string, name: string): boolean {
  const current = read();
  let changed = false;
  const next = current.map((playlist) => {
    if (playlist.id !== id) return playlist;
    changed = true;
    return { ...playlist, name: sanitizeName(name) };
  });
  if (!changed) return false;
  persist(next);
  return true;
}

/** 订阅智能歌单变化；返回退订函数。 */
export function subscribeSmartPlaylists(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
