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

/** 从 localmusic.local 的曲目 URL 反解 rel（恢复的队列不经过 trackOf，映射表里没有）。 */
function relFromId(id: string): string | null {
  if (!id.startsWith(`${LOCAL_ORIGIN}/`)) return null;
  let path = id.slice(LOCAL_ORIGIN.length + 1);
  if (path.startsWith('?')) return null;
  const isDownload = path.startsWith('__dl/');
  if (isDownload) path = path.slice('__dl/'.length);
  if (path.length === 0) return null;
  try {
    const decoded = path.split('/').map(decodeURIComponent).join('/');
    return isDownload ? `@downloads/${decoded}` : decoded;
  } catch {
    return null;
  }
}

export function relOf(track: OnlineTrack): string | null {
  if (track.source !== 'local') return null;
  const mapped = relOfTrack.get(track.id);
  if (mapped) return mapped;
  // 断点续播/上次会话恢复的队列是序列化曲目，没走 trackOf，映射表里查不到：从 URL 反解并补登记。
  const derived = relFromId(track.id);
  if (derived) relOfTrack.set(track.id, derived);
  return derived;
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
    // D-49：宿主对「文件夹不存在」也会回推 folder；只有成功载入时才记住路径，
    // 否则失效目录会被写进 localStorage，下次启动反复恢复并报错。
    if (!payload.error) rememberFolder(payload.folder);
    notify();
  });
  const offCancel = onLocalCancel(() => {
    // 用户取消选择：保持现状
  });
  // 上次选过的文件夹在启动时自动恢复（宿主会立即回推 localLibrary）。
  const folders = localFolders();
  if (folders.length > 0) restoreLocalFolders(folders);
  return () => {
    off();
    offCancel();
  };
}

/** 让宿主弹出文件夹选择器（单选，选中后直接作为主目录扫描）。 */
export function pickLocalFolder(): void {
  host.pickLocalMusic();
}

/** 让宿主弹出文件夹选择器，只回传路径（用于「添加文件夹」到多目录列表）。 */
export function pickAdditionalLocalFolder(): void {
  host.pickAdditionalLocalMusic();
}

/** 按上次记录的文件夹恢复（宿主无异常时立即推 localLibrary）。 */
export function restoreLocalFolder(folder: string): void {
  host.restoreLocalMusic(folder);
}

/** 按多目录列表恢复：第一个是主目录，其余用 @libN/ 前缀。 */
export function restoreLocalFolders(folders: string[]): void {
  if (folders.length === 0) return;
  host.restoreLocalLibraries(folders);
}

const RESTORE_KEY = 'zilux2.localFolder';
const FOLDERS_KEY = 'zilux2.localFolders';

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
    const list = localFolders();
    if (list[0] !== folder) {
      list[0] = folder;
      window.localStorage.setItem(FOLDERS_KEY, JSON.stringify(list));
    }
  } catch {
    /* 忽略 */
  }
}

/** 已保存的曲库根目录列表（第一个是主目录；兼容旧的单目录记录）。 */
export function localFolders(): string[] {
  try {
    const raw = window.localStorage.getItem(FOLDERS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const list = parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
        if (list.length > 0) return list;
      }
    }

    const legacy = window.localStorage.getItem(RESTORE_KEY);
    if (legacy) {
      window.localStorage.setItem(FOLDERS_KEY, JSON.stringify([legacy]));
      return [legacy];
    }
  } catch {
    /* 忽略 */
  }

  return [];
}

function saveLocalFolders(folders: string[]): void {
  try {
    window.localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
  } catch {
    /* 忽略 */
  }
}

/** 把一个目录追加进曲库根列表并立即重载全部根。 */
export function addLocalFolder(folder: string): void {
  const list = localFolders();
  if (list.includes(folder)) return;
  list.push(folder);
  saveLocalFolders(list);
  restoreLocalFolders(list);
}

/** 从曲库根列表移除一个目录（主目录被移除时由下一个目录接手）。 */
export function removeLocalFolder(folder: string): void {
  const list = localFolders().filter((item) => item !== folder);
  saveLocalFolders(list);
  if (list.length === 0) {
    try {
      window.localStorage.removeItem(RESTORE_KEY);
    } catch {
      /* 忽略 */
    }
    return;
  }

  restoreLocalFolders(list);
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

/** 写一首本地曲目的标签（只传要改的字段；结果走 localResult 回执，成功后宿主播新曲库）。 */
export function writeLocalTags(track: OnlineTrack, fields: Record<string, string | number | null>): boolean {
  const rel = relOf(track);
  if (!rel) return false;
  host.writeLocalTags(rel, fields);
  return true;
}

/** 订阅删除/定位等本地曲库操作的回执。 */
export function onLocalResult(handler: (payload: { action: string; ok: boolean; message: string }) => void): () => void {
  return bridgeOnLocalResult(handler);
}
