/**
 * 收听统计：按曲目累计播放次数与时长，保留 90 天的按日汇总。
 *
 * 数据示例（localStorage `zilux2.listeningStats`）：
 * {
 *   "totalMs": 5824000, "plays": 42, "updatedAt": 1761300000000,
 *   "days": { "2026-11-03": 1200000 },
 *   "tracks": {
 *     "netease:2689955959": { "key":"netease:2689955959", "source":"netease", "title":"…",
 *       "artist":"…", "cover":"…", "ms":360000, "plays":6, "lastAt":1761300000000 }
 *   }
 * }
 *
 * 只做本地统计，不上报；时间以「实际播放的墙上时间」累计（暂停/拖动不计数）。
 */

import type { OnlineTrack } from '../online/types';

export const LISTENING_STATS_KEY = 'zilux2.listeningStats';
const DAY_KEEP = 90;
const TRACK_KEEP = 2000;

export interface TrackListening {
  key: string;
  source: string;
  title: string;
  artist: string;
  cover: string;
  ms: number;
  plays: number;
  lastAt: number;
}

export interface ListeningStats {
  totalMs: number;
  plays: number;
  updatedAt: number;
  days: Record<string, number>;
  tracks: Record<string, TrackListening>;
}

type Listener = () => void;
const listeners = new Set<Listener>();

let cache: ListeningStats | null = null;
let flushTimer = 0;
let dirty = false;

function emptyStats(): ListeningStats {
  return { totalMs: 0, plays: 0, updatedAt: 0, days: {}, tracks: {} };
}

function dayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function trackKeyOf(track: OnlineTrack): string {
  return `${track.source}:${track.id}`;
}

function read(): ListeningStats {
  if (cache) return cache;
  try {
    const raw = globalThis.localStorage?.getItem(LISTENING_STATS_KEY);
    if (!raw) {
      cache = emptyStats();
      return cache;
    }
    const parsed = JSON.parse(raw) as Partial<ListeningStats> | null;
    if (!parsed || typeof parsed !== 'object') {
      cache = emptyStats();
      return cache;
    }
    const stats = emptyStats();
    stats.totalMs = typeof parsed.totalMs === 'number' && parsed.totalMs > 0 ? parsed.totalMs : 0;
    stats.plays = typeof parsed.plays === 'number' && parsed.plays > 0 ? Math.round(parsed.plays) : 0;
    stats.updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0;
    if (parsed.days && typeof parsed.days === 'object') {
      for (const [key, value] of Object.entries(parsed.days)) {
        if (typeof value === 'number' && value > 0 && /^\d{4}-\d{2}-\d{2}$/.test(key)) stats.days[key] = value;
      }
    }
    if (parsed.tracks && typeof parsed.tracks === 'object') {
      for (const [key, value] of Object.entries(parsed.tracks)) {
        if (!value || typeof value !== 'object') continue;
        const row = value as Partial<TrackListening>;
        if (typeof row.ms !== 'number' || row.ms <= 0) continue;
        stats.tracks[key] = {
          key,
          source: typeof row.source === 'string' ? row.source : '',
          title: typeof row.title === 'string' ? row.title : '',
          artist: typeof row.artist === 'string' ? row.artist : '',
          cover: typeof row.cover === 'string' ? row.cover : '',
          ms: row.ms,
          plays: typeof row.plays === 'number' && row.plays > 0 ? Math.round(row.plays) : 1,
          lastAt: typeof row.lastAt === 'number' ? row.lastAt : 0,
        };
      }
    }
    cache = stats;
    return stats;
  } catch {
    cache = emptyStats();
    return cache;
  }
}

function flush(force = false): void {
  if (!dirty && !force) return;
  const stats = read();
  // 按日只保留最近 90 天，曲目只保留最近 2000 首，避免 localStorage 无限增长。
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAY_KEEP);
  const cutoffKey = dayKey(cutoff);
  for (const key of Object.keys(stats.days)) {
    if (key < cutoffKey) delete stats.days[key];
  }
  const keys = Object.keys(stats.tracks);
  if (keys.length > TRACK_KEEP) {
    keys
      .sort((a, b) => (stats.tracks[a].lastAt || 0) - (stats.tracks[b].lastAt || 0))
      .slice(0, keys.length - TRACK_KEEP)
      .forEach((key) => delete stats.tracks[key]);
  }
  try {
    globalThis.localStorage?.setItem(LISTENING_STATS_KEY, JSON.stringify(stats));
  } catch {
    /* 忽略配额错误：统计只是附加信息 */
  }
  dirty = false;
  // 复制一份再遍历：订阅者可能在回调里重建页面并重新订阅，直接遍历原 Set 会把新订阅也执行一遍。
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      /* 单个订阅者异常不影响统计本身 */
    }
  }
}

function queueFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = globalThis.setTimeout(() => {
    flushTimer = 0;
    flush();
  }, 1800) as unknown as number;
}

// 页面关闭前尽量落盘（统计不追求严格，丢几秒可接受）。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (dirty) flush(true);
  });
}

/** 当前统计快照（只读引用，不要原地修改）。 */
export function readListeningStats(): ListeningStats {
  return read();
}

/** 计入一次「开播」（切到这首歌/重新开始）。 */
export function recordListenStart(track: OnlineTrack): void {
  const stats = read();
  const key = trackKeyOf(track);
  const row = stats.tracks[key] ?? {
    key,
    source: track.source,
    title: track.title,
    artist: track.artist,
    cover: track.cover ?? '',
    ms: 0,
    plays: 0,
    lastAt: 0,
  };
  row.plays += 1;
  row.lastAt = Date.now();
  row.title = track.title;
  row.artist = track.artist;
  row.cover = track.cover ?? row.cover;
  stats.tracks[key] = row;
  stats.plays += 1;
  stats.updatedAt = Date.now();
  queueFlush();
}

/** 累计实际播放时长（毫秒）。 */
export function recordListenTime(track: OnlineTrack, deltaMs: number): void {
  const amount = Math.round(deltaMs);
  if (!(amount > 0) || amount > 10 * 60 * 1000) return;
  const stats = read();
  const key = trackKeyOf(track);
  const row = stats.tracks[key] ?? {
    key,
    source: track.source,
    title: track.title,
    artist: track.artist,
    cover: track.cover ?? '',
    ms: 0,
    plays: 0,
    lastAt: 0,
  };
  row.ms += amount;
  row.lastAt = Date.now();
  stats.tracks[key] = row;
  stats.totalMs += amount;
  const today = dayKey();
  stats.days[today] = (stats.days[today] ?? 0) + amount;
  stats.updatedAt = Date.now();
  queueFlush();
}

export interface TopTrack extends TrackListening {
  /** 播放时长占比，0–1。 */
  share: number;
}

/** 播放最多的歌曲（按时长排序）。 */
export function topListenedTracks(limit = 10): TopTrack[] {
  const stats = read();
  const rows = Object.values(stats.tracks)
    .filter((row) => row.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit);
  return rows.map((row) => ({ ...row, share: stats.totalMs > 0 ? row.ms / stats.totalMs : 0 }));
}

export interface TopArtist {
  name: string;
  ms: number;
  share: number;
}

/** 播放最多的歌手（按时长排序）。 */
export function topListenedArtists(limit = 8): TopArtist[] {
  const stats = read();
  const byArtist = new Map<string, number>();
  for (const row of Object.values(stats.tracks)) {
    if (!row.artist || row.ms <= 0) continue;
    byArtist.set(row.artist, (byArtist.get(row.artist) ?? 0) + row.ms);
  }
  return [...byArtist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, ms]) => ({ name, ms, share: stats.totalMs > 0 ? ms / stats.totalMs : 0 }));
}

export interface DailyListening {
  day: string;
  ms: number;
}

/** 最近 N 天的每日收听时长（旧日期补 0）。 */
export function dailyListening(days = 14): DailyListening[] {
  const stats = read();
  const result: DailyListening[] = [];
  const base = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(base);
    date.setDate(date.getDate() - offset);
    const key = dayKey(date);
    result.push({ day: key, ms: stats.days[key] ?? 0 });
  }
  return result;
}

/** 清空全部收听统计。 */
export function resetListeningStats(): void {
  // 清空后不能再让排队中的 flush 把内存里的空统计写回 storage（否则键会「复活」）。
  if (flushTimer) {
    globalThis.clearTimeout(flushTimer);
    flushTimer = 0;
  }
  dirty = false;
  cache = emptyStats();
  cache.updatedAt = Date.now();
  try {
    globalThis.localStorage?.removeItem(LISTENING_STATS_KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      /* ignore */
    }
  });
}

/** 订阅统计变化（约 1.8s 合并一次）。 */
export function subscribeListeningStats(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 把毫秒格式化成「X 小时 Y 分钟」/「N 分钟」。 */
export function formatListening(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return '不到 1 分钟';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes} 分钟`;
  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}
