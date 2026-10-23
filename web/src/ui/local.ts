/** 本地曲库：宿主扫描结果 → 统一曲目结构（封面 / 同名 lrc 走 localmusic.local）。 */

import { onLocalCancel, onLocalLibrary, onLocalResult as bridgeOnLocalResult, host, type LocalLibraryPayload } from '../core/bridge';
import type { OnlineTrack } from '../online/types';

const LOCAL_ORIGIN = 'https://localmusic.local';

export interface LocalEntry {
  rel: string;
  name: string;
  hasCover: boolean;
  title: string;
  artist: string;
  startAt: number;
  durationMs: number;
  cue: number;
}

export interface LocalLibrary {
  folder: string;
  name: string;
  entries: LocalEntry[];
  /** rel → 同名 lrc 的 rel（按无扩展名同名匹配） */
  lyrics: Map<string, string>;
  error: string | null;
}

let library: LocalLibrary | null = null;
const listeners = new Set<(lib: LocalLibrary | null) => void>();
/** track.id → 本地 rel（歌词/封面用） */
const relOfTrack = new Map<string, string>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn(library);
    } catch (err) {
      console.warn('[local] listener failed', err);
    }
  });
}

function baseName(rel: string): string {
  const slash = rel.lastIndexOf('/');
  const name = slash >= 0 ? rel.slice(slash + 1) : rel;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function stripExt(rel: string): string {
  const dot = rel.lastIndexOf('.');
  return dot > 0 ? rel.slice(0, dot) : rel;
}

function decodeDisplayName(raw: string): string {
  // 宿主会给带编号的文件名，如「04. 歌名」；去掉前导编号与扩展名
  return raw
    .replace(/^\d{1,3}[\s._-]+/, '')
    .replace(/\.(flac|wav|mp3|m4a|dsf|ape|ogg)$/i, '')
    .trim();
}

/** 本地曲目 → 统一曲目结构（id 直接是虚拟主机 URL，供 <audio> 使用）。 */
export function trackOf(entry: LocalEntry): OnlineTrack {
  const rel = entry.rel;
  // 宿主把「下载目录」里的文件用 @downloads/ 前缀混进同一份本地曲库，走 /__dl/ 读取。
  const isDownload = rel.startsWith('@downloads/');
  const rawRel = isDownload ? rel.slice('@downloads/'.length) : rel;
  const encoded = rawRel.split('/').map(encodeURIComponent).join('/');
  const id = isDownload ? `${LOCAL_ORIGIN}/__dl/${encoded}` : `${LOCAL_ORIGIN}/${encoded}`;
  const cover = entry.hasCover
    ? `${LOCAL_ORIGIN}/__cover?rel=${encodeURIComponent(rel)}`
    : '';
  const track: OnlineTrack = {
    source: 'local',
    id,
    title: entry.title || decodeDisplayName(entry.name),
    artist: entry.artist,
    album: '',
    durationMs: entry.durationMs,
    cover,
    playable: true,
  };
  if (entry.startAt > 0) track.startAt = entry.startAt;
  relOfTrack.set(id, rel);
  return track;
}

export function relOf(track: OnlineTrack): string | null {
  if (track.source !== 'local') return null;
  return relOfTrack.get(track.id) ?? null;
}

/** 本地曲目对应的 lrc（相对路径），没有则 null。 */
export function lrcOf(track: OnlineTrack): string | null {
  const rel = relOf(track);
  if (!rel || !library) return null;
  const key = stripExt(rel);
  for (const [audio, lrc] of library.lyrics) {
    if (stripExt(audio) === key) return lrc;
  }
  // 退一步：按显示标题匹配
  const title = track.title;
  for (const [audio, lrc] of library.lyrics) {
    if (baseName(audio) === title) return lrc;
  }
  return null;
}

/** 拉取本地歌词文本（宿主带 CORS 头，可直接 fetch）。 */
export async function fetchLocalLrc(rel: string): Promise<string> {
  const url = `${LOCAL_ORIGIN}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`lrc ${resp.status}`);
  return resp.text();
}

/** 当前本地库（未选择时为 null）。 */
export function localLibrary(): LocalLibrary | null {
  return library;
}

export function onLocalLibraryChange(fn: (lib: LocalLibrary | null) => void): () => void {
  listeners.add(fn);
  fn(library);
  return () => listeners.delete(fn);
}

function normalize(payload: LocalLibraryPayload): LocalLibrary {
  const entries: LocalEntry[] = payload.tracks.map((item) => ({
    rel: item.rel,
    name: item.name,
    hasCover: item.hasCover === true,
    title: item.title ?? '',
    artist: item.artist ?? '',
    startAt: (item.startMs ?? 0) / 1000,
    durationMs: item.durationMs ?? 0,
    cue: item.cue ?? 0,
  }));
  const lyrics = new Map<string, string>();
  for (const rel of payload.lyrics ?? []) {
    if (!rel.toLowerCase().endsWith('.lrc')) continue;
    lyrics.set(stripExt(rel), rel);
  }
  return {
    folder: payload.folder,
    name: payload.name,
    entries,
    lyrics,
    error: payload.error ?? null,
  };
}

/** 订阅宿主推送；首次调用时安装全局监听。 */
export function initLocalLibrary(): () => void {
  const off = onLocalLibrary((payload) => {
    library = normalize(payload);
    rememberFolder(payload.folder);
    notify();
  });
  const offCancel = onLocalCancel(() => {
    // 用户取消选择：保持现状
  });
  // 上次选过的文件夹在启动时自动恢复（宿主会立即回推 localLibrary）。
  const folder = rememberedFolder();
  if (folder) restoreLocalFolder(folder);
  return () => {
    off();
    offCancel();
  };
}

/** 让宿主弹出文件夹选择器。 */
export function pickLocalFolder(): void {
  host.pickLocalMusic();
}

/** 按上次记录的文件夹恢复（宿主无异常时立即推 localLibrary）。 */
export function restoreLocalFolder(folder: string): void {
  host.restoreLocalMusic(folder);
}

const RESTORE_KEY = 'zilux2.localFolder';

export function rememberedFolder(): string {
  try {
    return window.localStorage.getItem(RESTORE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberFolder(folder: string): void {
  try {
    window.localStorage.setItem(RESTORE_KEY, folder);
  } catch {
    /* 忽略 */
  }
}

/** 把本地/下载曲目移进回收站（宿主推送 localResult 回执）。 */
export function deleteLocalTracks(rels: string[]): void {
  host.deleteLocalTracks(rels);
}

/** 在资源管理器里定位一首本地/下载曲目。 */
export function revealLocalTrack(track: OnlineTrack): void {
  const rel = relOf(track);
  if (rel) host.revealLocalTrack(rel);
}

/** 打开当前本地歌曲文件夹。 */
export function openLocalFolder(): void {
  host.openLocalFolder();
}

/** 订阅删除/定位等本地曲库操作的回执。 */
export function onLocalResult(handler: (payload: { action: string; ok: boolean; message: string }) => void): () => void {
  return bridgeOnLocalResult(handler);
}
