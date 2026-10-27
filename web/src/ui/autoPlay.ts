/**
 * 启动自动播放（第六十四轮）。
 *
 * 「打开软件直接播放」：启动完成后自动从所选来源开始播放。
 *   - 今日推荐：合并所有已登录且支持每日推荐的平台
 *   - 我喜欢的音乐：合并所有已登录平台的「我喜欢的音乐」
 *   - 指定歌单：用户在设置里选择的个人歌单
 *
 * 设置独立存 localStorage（属于播放行为，不进宿主同步的通用设置），
 * 启动时机由 main.ts 在 afterOnlineReady 之后调用 startAutoPlayOnBoot()。
 */

import { getAccounts } from '../core/account';
import { fetchLibraryOverview, fetchPlaylist, type LibraryPlaylist } from '../core/library';
import { fetchFeed } from '../online/client';
import { sourceMeta } from '../online/sources';
import type { OnlineSource, OnlineTrack } from '../online/types';
import { toast } from './dom';
import { playQueue } from './player';

export type AutoPlaySource = 'daily' | 'liked' | 'playlist';

export interface AutoPlaySettings {
  /** 是否启用「打开软件直接播放」 */
  enabled: boolean;
  /** 播放来源 */
  source: AutoPlaySource;
  /** 指定歌单所属平台 */
  playlistSource: OnlineSource | '';
  /** 指定歌单 id */
  playlistId: string;
  /** 指定歌单标题（展示用） */
  playlistTitle: string;
  /** 指定歌单封面（展示用） */
  playlistCover: string;
}

const STORE_KEY = 'zilux2.autoPlay';

const DEFAULT_SETTINGS: AutoPlaySettings = {
  enabled: false,
  source: 'daily',
  playlistSource: '',
  playlistId: '',
  playlistTitle: '',
  playlistCover: '',
};

function text(value: unknown, fallback: string, maxLength = 200): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed;
}

function parseSource(value: unknown): AutoPlaySource {
  return value === 'liked' || value === 'playlist' ? value : 'daily';
}

function normalize(raw: unknown): AutoPlaySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  const src = raw as Partial<Record<keyof AutoPlaySettings, unknown>>;
  return {
    enabled: src.enabled === true,
    source: parseSource(src.source),
    playlistSource: text(src.playlistSource, '') as AutoPlaySettings['playlistSource'],
    playlistId: text(src.playlistId, ''),
    playlistTitle: text(src.playlistTitle, '', 120),
    playlistCover: text(src.playlistCover, '', 300),
  };
}

let cached: AutoPlaySettings | null = null;
const listeners = new Set<(next: AutoPlaySettings) => void>();

export function autoPlaySettings(): AutoPlaySettings {
  if (cached) return cached;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    cached = raw ? normalize(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    cached = { ...DEFAULT_SETTINGS };
  }
  return cached;
}

export function saveAutoPlaySettings(patch: Partial<AutoPlaySettings>): AutoPlaySettings {
  const next = normalize({ ...autoPlaySettings(), ...patch });
  cached = next;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[autoplay] save failed', err);
  }
  listeners.forEach((cb) => {
    try {
      cb(next);
    } catch (err) {
      console.warn('[autoplay] listener failed', err);
    }
  });
  return next;
}

export function onAutoPlayChange(cb: (next: AutoPlaySettings) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 各平台个人歌单（供设置页选择用；不含「我喜欢的音乐」，它已是独立来源）。 */
export interface AutoPlayPlaylistGroup {
  source: OnlineSource;
  label: string;
  loggedIn: boolean;
  playlists: LibraryPlaylist[];
}

export async function listAutoPlayPlaylists(): Promise<AutoPlayPlaylistGroup[]> {
  const overview = await fetchLibraryOverview();
  return overview.sources
    .filter((state) => state.loggedIn)
    .map((state) => ({
      source: state.source,
      label: sourceMeta(state.source)?.label ?? state.source,
      loggedIn: state.loggedIn,
      playlists: state.playlists.filter((item) => item.special !== 'liked'),
    }));
}

/** 各列表轮流取一首，避免多平台歌曲扎堆。 */
function interleave(lists: readonly OnlineTrack[][]): OnlineTrack[] {
  const merged: OnlineTrack[] = [];
  const seen = new Set<string>();
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      const item = list[index];
      if (!item) continue;
      const key = `${item.source}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

async function resolveDaily(limitPerSource = 60): Promise<OnlineTrack[]> {
  const sources = getAccounts()
    .filter((item) => item.loggedIn)
    .filter((item) => (sourceMeta(item.source)?.feedKinds ?? []).includes('daily'))
    .map((item) => item.source);
  const lists = await Promise.all(
    sources.map(async (source) => {
      try {
        return (await fetchFeed(source, 'daily', limitPerSource)).tracks;
      } catch (err) {
        console.warn('[autoplay] daily failed', source, err);
        return [] as OnlineTrack[];
      }
    }),
  );
  return interleave(lists);
}

async function resolveLiked(limitPerSource = 300): Promise<OnlineTrack[]> {
  const overview = await fetchLibraryOverview();
  const entries = overview.sources.filter((state) => state.loggedIn && state.liked);
  const lists = await Promise.all(
    entries.map(async (state) => {
      const liked = state.liked;
      if (!liked) return [] as OnlineTrack[];
      try {
        return (await fetchPlaylist(state.source, liked.id, 0, limitPerSource, 'liked')).tracks;
      } catch (err) {
        console.warn('[autoplay] liked failed', state.source, err);
        return [] as OnlineTrack[];
      }
    }),
  );
  return interleave(lists);
}

async function resolvePlaylist(cfg: AutoPlaySettings): Promise<OnlineTrack[]> {
  if (!cfg.playlistSource || !cfg.playlistId) return [];
  try {
    const detail = await fetchPlaylist(cfg.playlistSource, cfg.playlistId, 0, 500);
    return detail.tracks;
  } catch (err) {
    console.warn('[autoplay] playlist failed', cfg.playlistSource, cfg.playlistId, err);
    return [];
  }
}

async function resolveTracks(cfg: AutoPlaySettings): Promise<OnlineTrack[]> {
  if (cfg.source === 'liked') return resolveLiked();
  if (cfg.source === 'playlist') return resolvePlaylist(cfg);
  return resolveDaily();
}

function describeSource(cfg: AutoPlaySettings): string {
  if (cfg.source === 'liked') return '我喜欢的音乐';
  if (cfg.source === 'playlist') return cfg.playlistTitle || '指定歌单';
  return '今日推荐';
}

let bootStarted = false;

/**
 * 启动完成后调用一次：满足条件时自动开始播放。
 * 失败（未登录 / 歌单为空 / 网络不可用）只提示，不影响正常启动。
 */
export async function startAutoPlayOnBoot(): Promise<void> {
  if (bootStarted) return;
  const cfg = autoPlaySettings();
  if (!cfg.enabled) return;
  bootStarted = true;
  try {
    const tracks = await resolveTracks(cfg);
    if (tracks.length === 0) {
      toast(`启动自动播放：${describeSource(cfg)}暂时没有可播放的歌曲`, 'error');
      return;
    }
    playQueue(tracks, 0, true);
  } catch (err) {
    console.warn('[autoplay] boot failed', err);
    toast('启动自动播放失败，已正常进入软件', 'error');
  }
}
