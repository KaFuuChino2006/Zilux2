/**
 * 个人音乐库客户端（Library v1，docs/zilux2-library.md）。
 *
 * 宿主在回环 HTTP 服务上提供：
 *   GET /api/library/overview
 *   GET /api/library/playlist?source=&id=&offset=&limit=   （id=liked 表示「我喜欢的音乐」）
 *   GET /api/library/refresh?source=
 * 全部要求 ?token=，与在线音乐共用端口与 token。
 *
 * 无宿主时 ?mock=1 返回内置假数据（两平台各 1 个「我喜欢的音乐」+ 5 个歌单），仅用于界面验收。
 */

import { onAccountChange } from './account';
import { OnlineError, isMockOnline, onlineInfo, onlineReady } from '../online/client';
import { onlineArtwork } from '../online/artwork';
import type { OnlineSource, OnlineTrack } from '../online/types';

export type MusicSource = OnlineSource;

export interface LibraryPlaylist {
  source: MusicSource;
  /** 平台歌单 id；我喜欢为宿主提供的 liked 歌单 id（mock 下为 mock-liked） */
  id: string;
  title: string;
  /** 封面 URL（宿主 /api/cover 代理或 data URL），缺失时前端程序化兜底 */
  cover?: string;
  count: number;
  /** 'liked' = 我喜欢的音乐 */
  special?: 'liked' | null;
  creator?: string;
}

export interface LibrarySourceState {
  source: MusicSource;
  loggedIn: boolean;
  nickname?: string;
  avatarDataUrl?: string;
  liked: LibraryPlaylist | null;
  playlists: LibraryPlaylist[];
  /** 单源失败时的可读提示，不影响另一源 */
  error?: string;
}

export interface LibraryOverview {
  sources: LibrarySourceState[];
}

export interface PlaylistDetail {
  source: MusicSource;
  id: string;
  title: string;
  cover?: string;
  count: number;
  tracks: OnlineTrack[];
  hasMore: boolean;
}

export const LIBRARY_SOURCES: MusicSource[] = ['netease', 'qq'];

const PAGE_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 12_000;

type LibraryListener = (changed: MusicSource | null, overview: LibraryOverview) => void;

const listeners = new Set<LibraryListener>();

/** 订阅个人库变化（刷新/登录变化后触发）。 */
export function onLibraryChange(cb: LibraryListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(changed: MusicSource | null, overview: LibraryOverview): void {
  listeners.forEach((cb) => {
    try {
      cb(changed, overview);
    } catch (err) {
      console.warn('[library] listener failed', err);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

/** 拉取两平台个人库汇总（只返回数据，不广播；广播统一走 refreshLibrary，避免 fetch→notify→refresh 递归）。 */
export async function fetchLibraryOverview(): Promise<LibraryOverview> {
  if (isMockOnline()) return mockOverview();
  const resp = await request<Partial<LibraryOverview>>('/api/library/overview', {}, 'GET');
  return normalizeOverview(resp);
}

/**
 * 拉取歌单详情（曲目分页）。
 * 宿主约定 id='liked' 表示「我喜欢的音乐」；UI 侧拿到的是 liked 歌单真实 id，
 * 这里按 special 集中映射，调用方无需关心真实 id。
 */
export async function fetchPlaylist(
  source: MusicSource,
  id: string,
  offset = 0,
  limit = PAGE_LIMIT,
  special?: 'liked' | null,
): Promise<PlaylistDetail> {
  const requestId = special === 'liked' ? 'liked' : id;
  if (isMockOnline()) return mockPlaylist(source, requestId, offset, limit);
  const resp = await request<Partial<PlaylistDetail>>(
    '/api/library/playlist',
    { source, id: requestId, offset: String(offset), limit: String(limit) },
    'GET',
  );
  return normalizePlaylistDetail(resp, source, requestId);
}

/** 使某源缓存失效并重新拉取；不传 source 时刷新两源。成功后广播 onLibraryChange。 */
export async function refreshLibrary(source?: MusicSource): Promise<LibraryOverview> {
  if (isMockOnline()) {
    const overview = mockOverview();
    notify(source ?? null, overview);
    return overview;
  }
  const params: Record<string, string> = source ? { source } : {};
  await request<{ ok?: boolean }>('/api/library/refresh', params, 'GET');
  const overview = await fetchLibraryOverview();
  notify(source ?? null, overview);
  return overview;
}

/** 当前是否具备拉取个人库的条件（在线源就绪或 mock）。 */
export function libraryReady(): boolean {
  return isMockOnline() || onlineReady();
}

/* ------------------------------------------------------------------ */
/* 登录态联动：账号变化 → 宿主缓存失效 → 广播（视图只订阅 onLibraryChange） */
/* ------------------------------------------------------------------ */

let accountSyncInstalled = false;

/** 安装一次账号变化监听（幂等；模块加载时自动安装）。 */
export function ensureAccountSync(): void {
  if (accountSyncInstalled) return;
  accountSyncInstalled = true;
  onAccountChange((changed) => {
    // null = 启动时的批量刷新，各视图首次 fetch 会自行处理，无需额外拉取
    if (!changed || !libraryReady()) return;
    void refreshLibrary(changed).catch((err: unknown) => {
      console.debug('[library] refresh after account change failed', err);
    });
  });
}

/* ------------------------------------------------------------------ */
/* HTTP 请求（与 online/client.ts、account.ts 同款：token + 中文错误）  */
/* ------------------------------------------------------------------ */

async function request<T>(
  path: string,
  params: Record<string, string>,
  method: 'GET' | 'POST',
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const info = onlineInfo();
  if (!info) throw new OnlineError('not-ready', '在线源尚未就绪');
  const query = new URLSearchParams({ ...params, token: info.token });
  const url = `http://127.0.0.1:${info.port}${path}?${query.toString()}`;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method, signal: controller.signal, cache: 'no-store' });
    const type = resp.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) {
      if (!resp.ok) throw new OnlineError(`http-${resp.status}`, `网络请求失败（${resp.status}）`);
      throw new OnlineError('bad-response', '上游返回了无法解析的内容');
    }
    const body = (await resp.json()) as T & { error?: string; message?: string };
    if (!resp.ok) {
      throw new OnlineError(
        body.error ?? `http-${resp.status}`,
        body.message ?? `请求失败（${resp.status}）`,
      );
    }
    return body as T;
  } catch (err) {
    if (err instanceof OnlineError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new OnlineError('timeout', '请求超时，请稍后重试');
    }
    throw new OnlineError('network', '无法连接在线源，请确认宿主已启动');
  } finally {
    window.clearTimeout(timer);
  }
}

/** 回环封面 URL 补 token（宿主 /api/* 都要求 ?token=；绝对 URL 由宿主拼出时可能漏掉）。 */
function withLoopbackToken(url: string): string {
  const info = onlineInfo();
  if (!info) return url;
  if (!/^http:\/\/127\.0\.0\.1(:\d+)?\//.test(url)) return url;
  if (/(?:[?&])token=[^&]/.test(url)) return url;
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}token=${info.token}`;
}

/** 封面兜底：宿主可能返回 /api/cover 相对路径或未带 token 的回环 URL，这里统一补全。 */
function resolveCover(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^data:/.test(url)) return url;
  if (/^http:\/\//.test(url)) return withLoopbackToken(url);
  if (/^https:\/\//.test(url)) return url;
  const info = onlineInfo();
  if (!info || !url.startsWith('/')) return url;
  const joiner = url.includes('?') ? '&' : '?';
  return `http://127.0.0.1:${info.port}${url}${joiner}token=${info.token}`;
}

/* ------------------------------------------------------------------ */
/* 响应归一化（对宿主字段保持宽容）                                     */
/* ------------------------------------------------------------------ */

function asSource(value: unknown): MusicSource | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizePlaylist(
  input: Partial<LibraryPlaylist> | null | undefined,
  fallbackSource: MusicSource,
): LibraryPlaylist | null {
  if (!input || typeof input.id !== 'string' || !input.id) return null;
  const source = asSource(input.source) ?? fallbackSource;
  const count = typeof input.count === 'number' && input.count >= 0 ? input.count : 0;
  const playlist: LibraryPlaylist = {
    source,
    id: input.id,
    title: typeof input.title === 'string' && input.title ? input.title : '未命名歌单',
    count,
    special: input.special === 'liked' ? 'liked' : null,
  };
  const cover = resolveCover(typeof input.cover === 'string' ? input.cover : undefined);
  if (cover) playlist.cover = cover;
  if (typeof input.creator === 'string' && input.creator) playlist.creator = input.creator;
  return playlist;
}

function normalizeOverview(input: Partial<LibraryOverview> | undefined): LibraryOverview {
  const bySource = new Map<MusicSource, LibrarySourceState>();
  for (const raw of input?.sources ?? []) {
    const source = asSource((raw as { source?: unknown } | null)?.source);
    if (!source) continue;
    const item = raw as Partial<LibrarySourceState>;
    const state: LibrarySourceState = {
      source,
      loggedIn: item.loggedIn === true,
      liked: normalizePlaylist(item.liked, source),
      playlists: Array.isArray(item.playlists)
        ? item.playlists
            .map((playlist) => normalizePlaylist(playlist, source))
            .filter((playlist): playlist is LibraryPlaylist => playlist !== null)
        : [],
    };
    if (typeof item.nickname === 'string' && item.nickname) state.nickname = item.nickname;
    if (typeof item.avatarDataUrl === 'string' && item.avatarDataUrl.startsWith('data:image/')) {
      state.avatarDataUrl = item.avatarDataUrl;
    }
    if (typeof item.error === 'string' && item.error) state.error = item.error;
    bySource.set(source, state);
  }
  return {
    sources: LIBRARY_SOURCES.map(
      (source) => bySource.get(source) ?? { source, loggedIn: false, liked: null, playlists: [] },
    ),
  };
}

function normalizeTrack(input: Partial<OnlineTrack>, fallbackSource: MusicSource): OnlineTrack | null {
  if (!input || typeof input.id !== 'string' || !input.id) return null;
  const source = asSource(input.source) ?? fallbackSource;
  return {
    source,
    id: input.id,
    title: typeof input.title === 'string' && input.title ? input.title : '未知曲目',
    artist: typeof input.artist === 'string' && input.artist ? input.artist : '未知歌手',
    album: typeof input.album === 'string' ? input.album : '',
    durationMs: typeof input.durationMs === 'number' && input.durationMs > 0 ? input.durationMs : 0,
    cover: resolveCover(typeof input.cover === 'string' ? input.cover : undefined) ?? '',
    playable: input.playable === true,
  };
}

function normalizePlaylistDetail(
  input: Partial<PlaylistDetail> | undefined,
  fallbackSource: MusicSource,
  fallbackId: string,
): PlaylistDetail {
  const source = asSource(input?.source) ?? fallbackSource;
  const tracks = (Array.isArray(input?.tracks) ? input.tracks : [])
    .map((track) => normalizeTrack(track, source))
    .filter((track): track is OnlineTrack => track !== null);
  const detail: PlaylistDetail = {
    source,
    id: typeof input?.id === 'string' && input.id ? input.id : fallbackId,
    title: typeof input?.title === 'string' && input.title ? input.title : '歌单',
    count: typeof input?.count === 'number' && input.count >= 0 ? input.count : tracks.length,
    tracks,
    hasMore: input?.hasMore === true,
  };
  const cover = resolveCover(typeof input?.cover === 'string' ? input.cover : undefined);
  if (cover) detail.cover = cover;
  return detail;
}

/* ------------------------------------------------------------------ */
/* mock：?mock=1（无宿主本地预览）时使用                                 */
/* ------------------------------------------------------------------ */

const MOCK_LIKED_COUNT = 24;
const MOCK_PLAYLIST_COUNT = 5;

const MOCK_NE_PLAYLISTS: Array<{ id: string; title: string; creator: string; titles: string[] }> = [
  {
    id: 'mock-1',
    title: '夜航电台',
    creator: '我创建的',
    titles: ['夜航星图', '凌晨四点的街', '海雾信号', '卫星失联', '慢速雨刷', '末班地铁', '霓虹渡口', '失重散步'],
  },
  {
    id: 'mock-2',
    title: '周五通勤',
    creator: '我创建的',
    titles: ['早班列车', '玻璃幕墙', '第七个路口', '城市褪色', '加班到十点', '便利店灯光', '回家路上'],
  },
  {
    id: 'mock-3',
    title: '深夜书桌',
    creator: '我创建的',
    titles: ['台灯与纸', '翻页声', '旧木桌', '钢笔漏水', '雨敲窗', '零点之后', '安静的电池'],
  },
  {
    id: 'mock-4',
    title: '雨夜白噪音',
    creator: '我创建的',
    titles: ['檐下滴水', '雨披与路灯', '远处雷声', '湿透的球鞋', '伞骨轻响', '雨停前'],
  },
  {
    id: 'mock-5',
    title: '华语漫游',
    creator: '我创建的',
    titles: ['南方来信', '青苔巷口', '台风过境', '晚风邮差', '旧磁带', '海边的信', '时间邮局', '慢慢'],
  },
];

const MOCK_QQ_PLAYLISTS: Array<{ id: string; title: string; creator: string; titles: string[] }> = [
  {
    id: 'mock-q-1',
    title: '夜跑节拍',
    creator: '我创建的',
    titles: ['第十公里', '心跳过速', '霓虹跑道', '逆风冲刺', '零点配速', '汗与灯', '呼吸节奏', '终点线'],
  },
  {
    id: 'mock-q-2',
    title: '开车兜风',
    creator: '我创建的',
    titles: ['环城高架', '风从窗缝来', '收费站在闪', '无尽隧道', '后视镜里的城', '下高速', '夜路'],
  },
  {
    id: 'mock-q-3',
    title: '闹钟前最后一首',
    creator: '我创建的',
    titles: ['再睡五分钟', '窗帘缝的光', '闹钟响起前', '早餐铺', '牙膏味', '出门右转'],
  },
  {
    id: 'mock-q-4',
    title: '考试周循环',
    creator: '我创建的',
    titles: ['草稿纸', '错题本', '图书馆闭馆', '咖啡因', '倒计时', '最后一页', '放空'],
  },
  {
    id: 'mock-q-5',
    title: '周末醒来',
    creator: '我创建的',
    titles: ['阳台风', '晒被子', '午后三点', '冰镇汽水', '洗衣房', '慢镜头', '傍晚散步'],
  },
];

const MOCK_ARTISTS = ['陈墨', '雾岛乐队', '林晚', '许星野', '白噪计划', '南岸', '夜行者', '齐默'];
const MOCK_ALBUMS = ['夜航', '城市碎片', '雨声采样', '慢速反射', '霓虹之外', '无人区'];

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mockTracks(source: MusicSource, seed: string, titles: string[]): OnlineTrack[] {
  const base = hash(`${source}:${seed}`);
  return titles.map((title, index) => {
    const pick = (offset: number, list: string[]): string => list[(base + index * offset) % list.length] ?? list[0]!;
    const track: OnlineTrack = {
      source,
      id: `mock-${source}-${hash(`${seed}:${index}`)}`,
      title,
      artist: pick(3, MOCK_ARTISTS),
      album: pick(5, MOCK_ALBUMS),
      durationMs: (150 + ((base + index * 17) % 120)) * 1000,
      cover: '',
      playable: true,
    };
    track.cover = onlineArtwork(track);
    return track;
  });
}

function mockLiked(source: MusicSource): { playlist: LibraryPlaylist; tracks: OnlineTrack[] } {
  const titles = Array.from({ length: MOCK_LIKED_COUNT }, (_, i) => `喜欢的歌 ${String(i + 1).padStart(2, '0')}`);
  const tracks = mockTracks(source, `${source}-liked`, titles);
  const playlist: LibraryPlaylist = {
    source,
    id: 'mock-liked',
    title: '我喜欢的音乐',
    cover: onlineArtwork(tracks[0]!),
    count: tracks.length,
    special: 'liked',
  };
  return { playlist, tracks };
}

function mockSource(source: MusicSource): LibrarySourceState {
  const liked = mockLiked(source);
  const defs = source === 'netease' ? MOCK_NE_PLAYLISTS : MOCK_QQ_PLAYLISTS;
  const playlists = defs.slice(0, MOCK_PLAYLIST_COUNT).map((def) => {
    const tracks = mockTracks(source, def.id, def.titles);
    return {
      source,
      id: def.id,
      title: def.title,
      cover: onlineArtwork(tracks[0]!),
      count: tracks.length,
      special: null,
      creator: def.creator,
    } satisfies LibraryPlaylist;
  });
  return {
    source,
    loggedIn: true,
    nickname: source === 'netease' ? '夜航星（演示）' : '星河漫游者（演示）',
    liked: liked.playlist,
    playlists,
  };
}

const mockCache = new Map<MusicSource, LibrarySourceState>();

function mockOverview(): LibraryOverview {
  return {
    sources: LIBRARY_SOURCES.map((source) => {
      const cached = mockCache.get(source);
      if (cached) return cached;
      const state = mockSource(source);
      mockCache.set(source, state);
      return state;
    }),
  };
}

function mockPlaylist(source: MusicSource, id: string, offset: number, limit: number): PlaylistDetail {
  const state = mockOverview().sources.find((item) => item.source === source) ?? mockSource(source);
  const liked = mockLiked(source);
  const isLiked = id === 'liked' || id === state.liked?.id;
  const ref = isLiked ? liked.playlist : state.playlists.find((playlist) => playlist.id === id);
  if (!ref) throw new OnlineError('not-found', '没有找到该歌单');
  const allTracks = isLiked
    ? liked.tracks
    : mockTracks(source, ref.id, mockTrackTitles(source, ref.id));
  const count = isLiked ? allTracks.length : ref.count;
  const slice = allTracks.slice(offset, offset + limit);
  return {
    source,
    id: ref.id,
    title: ref.title,
    cover: ref.cover,
    count,
    tracks: slice,
    hasMore: offset + slice.length < allTracks.length,
  };
}

function mockTrackTitles(source: MusicSource, playlistId: string): string[] {
  const defs = source === 'netease' ? MOCK_NE_PLAYLISTS : MOCK_QQ_PLAYLISTS;
  const def = defs.find((item) => item.id === playlistId);
  if (def) return def.titles;
  return Array.from({ length: 12 }, (_, i) => `曲目 ${i + 1}`);
}

// 模块加载即安装登录态联动（登录/退出后自动刷新「我的音乐」）。
ensureAccountSync();
