/**
 * 「发现」API 客户端（Discover API v1）。
 *
 * 宿主已实现的 10 个只读接口：charts / chart / cats / playlists / radio /
 * artist / album / comments / podcasts / collections。
 * 全部走 GET + ?token=，回环 http 请求（页面是 https 虚拟域，不能直接 fetch，
 * 但宿主的 fetch 代理只在 https 侧拦——这里和 core/library.ts 一样，先取
 * onlineInfo() 再直连 127.0.0.1，WebView2 允许）。
 *
 * 约定：
 *   - 统一 OnlineError（code/message），UI 只按 code 做特殊处理（如 QQ 评论 501）；
 *   - 60 秒内存缓存，切换 tab / 来回进详情不重复拉；
 *   - 封面统一走 discoverCover() 补 token / 相对路径。
 */

import { OnlineError, onlineInfo } from './client';
import type { OnlineTrack } from './types';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export type DiscoverSource = 'netease' | 'qq';
export type DiscoverOrder = 'hot' | 'new';
export type CollectionKind = 'artist' | 'album' | 'mv' | 'playlist';

/** 后端在 OnlineTrack 上补了 artistId / albumId，用于点进歌手 / 专辑页。 */
export type DiscoverTrack = OnlineTrack & {
  artistId?: string;
  albumId?: string;
};

export interface DiscoverChart {
  id: string;
  title: string;
  cover?: string;
  count: number;
  updateFrequency: string;
}

export interface DiscoverChartCategory {
  title: string;
  charts: DiscoverChart[];
}

export interface DiscoverChartGroup {
  source: string;
  label: string;
  categories: DiscoverChartCategory[];
}

export interface DiscoverChartDetail {
  source: string;
  id: string;
  title: string;
  cover?: string;
  count: number;
  tracks: DiscoverTrack[];
  hasMore: boolean;
}

export interface DiscoverCat {
  id: string;
  name: string;
}

export interface DiscoverPlaylist {
  source: string;
  id: string;
  title: string;
  cover?: string;
  count: number;
  creator: string;
}

export interface DiscoverPlaylists {
  source: string;
  cat: string;
  playlists: DiscoverPlaylist[];
  hasMore: boolean;
}

export interface DiscoverArtistAlbum {
  id: string;
  title: string;
  cover?: string;
  year: string;
  count: number;
}

export interface DiscoverArtist {
  source: string;
  id: string;
  name: string;
  cover?: string;
  avatar?: string;
  description: string;
  followed: boolean;
  hotSongs: DiscoverTrack[];
  albums: DiscoverArtistAlbum[];
}

export interface DiscoverAlbum {
  source: string;
  id: string;
  title: string;
  cover?: string;
  artist: string;
  artistId?: string;
  year: string;
  description: string;
  tracks: DiscoverTrack[];
}

export interface DiscoverComment {
  user: string;
  avatar?: string;
  content: string;
  liked: number;
  time: string;
  hot: boolean;
}

export interface DiscoverComments {
  source: string;
  id: string;
  total: number;
  comments: DiscoverComment[];
  hasMore: boolean;
}

export interface DiscoverPodcast {
  id: string;
  name: string;
  cover?: string;
  radioName: string;
  djName: string;
  durationMs: number;
  description: string;
}

export interface DiscoverCollectionItem {
  id: string;
  title: string;
  cover?: string;
  subtitle: string;
}

export interface DiscoverCollections {
  source: string;
  kind: string;
  items: DiscoverCollectionItem[];
  hasMore: boolean;
}

/* ------------------------------------------------------------------ */
/* 请求 + 缓存                                                         */
/* ------------------------------------------------------------------ */

const TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  at: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();

/** 清空发现页缓存（登录态变化 / 手动刷新时可调）。 */
export function clearDiscoverCache(): void {
  cache.clear();
}

async function request(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<unknown> {
  const info = onlineInfo();
  if (!info) throw new OnlineError('not-ready', '在线源尚未就绪');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    query.set(key, String(value));
  }
  query.set('token', info.token);
  const url = `http://127.0.0.1:${info.port}${path}?${query.toString()}`;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: 'GET', signal: controller.signal, cache: 'no-store' });
    const type = resp.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) {
      if (!resp.ok) throw new OnlineError(`http-${resp.status}`, `网络请求失败（${resp.status}）`);
      throw new OnlineError('bad-response', '上游返回了无法解析的内容');
    }
    const body = (await resp.json()) as { error?: string; message?: string };
    if (!resp.ok) {
      throw new OnlineError(
        body.error ?? `http-${resp.status}`,
        body.message ?? body.error ?? `请求失败（${resp.status}）`,
      );
    }
    return body;
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

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------------ */
/* 归一化（对宿主字段保持宽容，缺字段不抛错）                          */
/* ------------------------------------------------------------------ */

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function bool(value: unknown): boolean {
  return value === true;
}

function recList<T>(value: unknown, map: (item: Rec) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    const r = rec(item);
    if (!r) continue;
    const mapped = map(r);
    if (mapped) out.push(mapped);
  }
  return out;
}

function trackOf(item: Rec, fallbackSource: string): DiscoverTrack | null {
  const id = str(item.id);
  if (!id) return null;
  return {
    source: str(item.source, fallbackSource),
    id,
    title: str(item.title, '未知歌曲'),
    artist: str(item.artist, '未知歌手'),
    album: str(item.album),
    durationMs: num(item.durationMs),
    cover: str(item.cover),
    playable: item.playable === false ? false : true,
    vip: bool(item.vip),
    ...(str(item.artistId) ? { artistId: str(item.artistId) } : {}),
    ...(str(item.albumId) ? { albumId: str(item.albumId) } : {}),
  };
}

function tracksOf(value: unknown, fallbackSource: string): DiscoverTrack[] {
  return recList(value, (item) => trackOf(item, fallbackSource));
}

function sourceOf(value: unknown, fallback: DiscoverSource = 'netease'): string {
  const text = str(value);
  return text || fallback;
}

/** 回环封面补 token：绝对 http 127 地址补 token，相对路径拼宿主地址。 */
export function discoverCover(url: string | undefined | null): string {
  if (!url) return '';
  const info = onlineInfo();
  if (!info) return url;
  if (url.startsWith('data:')) return url;
  if (/^https:\/\//.test(url)) return url;
  if (/^http:\/\//.test(url)) {
    if (!/^http:\/\/127\.0\.0\.1(:\d+)?\//.test(url)) return url;
    if (/(?:[?&])token=[^&]/.test(url)) return url;
    return `${url}${url.includes('?') ? '&' : '?'}token=${info.token}`;
  }
  if (!url.startsWith('/')) return url;
  return `http://127.0.0.1:${info.port}${url}${url.includes('?') ? '&' : '?'}token=${info.token}`;
}

/* ------------------------------------------------------------------ */
/* 1. 排行榜总览                                                       */
/* ------------------------------------------------------------------ */

export async function fetchCharts(source?: DiscoverSource | 'all'): Promise<DiscoverChartGroup[]> {
  const key = `charts:${source ?? 'all'}`;
  return cached(key, async () => {
    const body = rec(await request('/api/discover/charts', { source: source === 'all' ? undefined : source }));
    return recList(body?.groups, (group) => {
      const categories = recList(group.categories, (cat) => ({
        title: str(cat.title, '分类'),
        charts: recList(cat.charts, (chart) => {
          const id = str(chart.id);
          if (!id) return null;
          return {
            id,
            title: str(chart.title, '未命名榜单'),
            cover: str(chart.cover) || undefined,
            count: num(chart.count),
            updateFrequency: str(chart.updateFrequency),
          } satisfies DiscoverChart;
        }),
      }));
      if (categories.length === 0) return null;
      return {
        source: sourceOf(group.source),
        label: str(group.label, sourceOf(group.source)),
        categories,
      } satisfies DiscoverChartGroup;
    });
  });
}

/* ------------------------------------------------------------------ */
/* 2. 榜单详情                                                         */
/* ------------------------------------------------------------------ */

export async function fetchChart(
  source: string,
  id: string,
  offset = 0,
  limit = 100,
): Promise<DiscoverChartDetail> {
  const key = `chart:${source}:${id}:${offset}:${limit}`;
  return cached(key, async () => {
    const body = rec(await request('/api/discover/chart', { source, id, offset, limit }));
    return {
      source: sourceOf(body?.source, source as DiscoverSource),
      id: str(body?.id, id),
      title: str(body?.title, '榜单'),
      cover: str(body?.cover) || undefined,
      count: num(body?.count),
      tracks: tracksOf(body?.tracks, source),
      hasMore: bool(body?.hasMore),
    } satisfies DiscoverChartDetail;
  });
}

/* ------------------------------------------------------------------ */
/* 3. 歌单分类                                                         */
/* ------------------------------------------------------------------ */

export async function fetchCats(source: DiscoverSource = 'netease'): Promise<DiscoverCat[]> {
  return cached(`cats:${source}`, async () => {
    const body = rec(await request('/api/discover/cats', { source }));
    const cats = recList(body?.categories, (item) => {
      const id = str(item.id);
      if (!id) return null;
      return { id, name: str(item.name, id) } satisfies DiscoverCat;
    });
    if (cats.length === 0) cats.push({ id: '全部', name: '全部' });
    return cats;
  });
}

/* ------------------------------------------------------------------ */
/* 4. 歌单广场                                                         */
/* ------------------------------------------------------------------ */

export async function fetchPlaylists(
  source: DiscoverSource,
  cat = '全部',
  order: DiscoverOrder = 'hot',
  offset = 0,
  limit = 30,
): Promise<DiscoverPlaylists> {
  const key = `playlists:${source}:${cat}:${order}:${offset}:${limit}`;
  return cached(key, async () => {
    const body = rec(await request('/api/discover/playlists', { source, cat, order, offset, limit }));
    return {
      source: sourceOf(body?.source, source),
      cat: str(body?.cat, cat),
      playlists: recList(body?.playlists, (item) => {
        const id = str(item.id);
        if (!id) return null;
        return {
          source: sourceOf(item.source, source),
          id,
          title: str(item.title, '未命名歌单'),
          cover: str(item.cover) || undefined,
          count: num(item.count),
          creator: str(item.creator),
        } satisfies DiscoverPlaylist;
      }),
      hasMore: bool(body?.hasMore),
    } satisfies DiscoverPlaylists;
  });
}

/* ------------------------------------------------------------------ */
/* 5. 私人漫游（不缓存，每次「换一批」都要新数据）                     */
/* ------------------------------------------------------------------ */

export async function fetchRadio(count = 12): Promise<DiscoverTrack[]> {
  const body = rec(await request('/api/discover/radio', { count }));
  return tracksOf(body?.tracks, 'netease');
}

/* ------------------------------------------------------------------ */
/* 6. 歌手                                                             */
/* ------------------------------------------------------------------ */

export async function fetchArtist(
  source: string,
  id: string,
  limit = 50,
): Promise<DiscoverArtist> {
  return cached(`artist:${source}:${id}:${limit}`, async () => {
    const body = rec(await request('/api/discover/artist', { source, id, limit }));
    return {
      source: sourceOf(body?.source, source as DiscoverSource),
      id: str(body?.id, id),
      name: str(body?.name, '未知歌手'),
      cover: str(body?.cover) || undefined,
      avatar: str(body?.avatar) || undefined,
      description: str(body?.description),
      followed: bool(body?.followed),
      hotSongs: tracksOf(body?.hotSongs, source),
      albums: recList(body?.albums, (item) => {
        const albumId = str(item.id);
        if (!albumId) return null;
        return {
          id: albumId,
          title: str(item.title, '未知专辑'),
          cover: str(item.cover) || undefined,
          year: str(item.year),
          count: num(item.count),
        } satisfies DiscoverArtistAlbum;
      }),
    } satisfies DiscoverArtist;
  });
}

/* ------------------------------------------------------------------ */
/* 7. 专辑                                                             */
/* ------------------------------------------------------------------ */

export async function fetchAlbum(source: string, id: string): Promise<DiscoverAlbum> {
  return cached(`album:${source}:${id}`, async () => {
    const body = rec(await request('/api/discover/album', { source, id }));
    return {
      source: sourceOf(body?.source, source as DiscoverSource),
      id: str(body?.id, id),
      title: str(body?.title, '未知专辑'),
      cover: str(body?.cover) || undefined,
      artist: str(body?.artist, '未知歌手'),
      artistId: str(body?.artistId) || undefined,
      year: str(body?.year),
      description: str(body?.description),
      tracks: tracksOf(body?.tracks, source),
    } satisfies DiscoverAlbum;
  });
}

/* ------------------------------------------------------------------ */
/* 8. 评论                                                             */
/* ------------------------------------------------------------------ */

export async function fetchComments(
  source: string,
  id: string,
  offset = 0,
  limit = 20,
): Promise<DiscoverComments> {
  return cached(`comments:${source}:${id}:${offset}:${limit}`, async () => {
    const body = rec(await request('/api/discover/comments', { source, id, offset, limit }));
    return {
      source: sourceOf(body?.source, source as DiscoverSource),
      id: str(body?.id, id),
      total: num(body?.total),
      comments: recList(body?.comments, (item) => ({
        user: str(item.user, '匿名用户'),
        avatar: str(item.avatar) || undefined,
        content: str(item.content),
        liked: num(item.liked),
        time: str(item.time),
        hot: bool(item.hot),
      } satisfies DiscoverComment)),
      hasMore: bool(body?.hasMore),
    } satisfies DiscoverComments;
  });
}

/* ------------------------------------------------------------------ */
/* 9. 播客（只列不播）                                                 */
/* ------------------------------------------------------------------ */

export async function fetchPodcasts(limit = 12): Promise<DiscoverPodcast[]> {
  return cached(`podcasts:${limit}`, async () => {
    const body = rec(await request('/api/discover/podcasts', { limit }));
    return recList(body?.programs, (item) => {
      const id = str(item.id);
      if (!id) return null;
      return {
        id,
        name: str(item.name, '未命名节目'),
        cover: str(item.cover) || undefined,
        radioName: str(item.radioName),
        djName: str(item.djName),
        durationMs: num(item.durationMs),
        description: str(item.description),
      } satisfies DiscoverPodcast;
    });
  });
}

/* ------------------------------------------------------------------ */
/* 10. 收藏（歌手 / 专辑 / MV；仅网易云）                              */
/* ------------------------------------------------------------------ */

export async function fetchCollections(
  source: DiscoverSource,
  kind: CollectionKind,
  offset = 0,
  limit = 30,
): Promise<DiscoverCollections> {
  const key = `collections:${source}:${kind}:${offset}:${limit}`;
  return cached(key, async () => {
    const body = rec(await request('/api/discover/collections', { source, kind, offset, limit }));
    return {
      source: sourceOf(body?.source, source),
      kind: str(body?.kind, kind),
      items: recList(body?.items, (item) => {
        const id = str(item.id);
        if (!id) return null;
        return {
          id,
          title: str(item.title, '未命名'),
          cover: str(item.cover) || undefined,
          subtitle: str(item.subtitle),
        } satisfies DiscoverCollectionItem;
      }),
      hasMore: bool(body?.hasMore),
    } satisfies DiscoverCollections;
  });
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 数字 → 1.2万 / 3.4亿（播放量、评论总数用）。 */
export function fmtCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return String(Math.round(value));
}

/** 从错误里取用户可读文案。 */
export function discoverErrorText(err: unknown, fallback = '加载失败，请稍后重试'): string {
  if (err instanceof OnlineError) return err.message || fallback;
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

/** 是否“平台不支持”（QQ 的评论 / 收藏等 501）。 */
export function isUnsupported(err: unknown): boolean {
  return (
    err instanceof OnlineError &&
    (err.code === 'unsupported' || err.code === 'http-501' || /51|unsupported/i.test(err.code))
  );
}

/** 是否未登录（私人漫游 / 收藏）。 */
export function isLoginRequired(err: unknown): boolean {
  return (
    err instanceof OnlineError &&
    (err.code === 'login-required' || err.code === 'http-401' || err.code === 'unauthorized')
  );
}

/* ------------------------------------------------------------------ */
/* 11. 歌曲信息（两端）                                                */
/* ------------------------------------------------------------------ */

export interface DiscoverSongArtist {
  id?: string;
  name: string;
}

export interface DiscoverSongQuality {
  name: string;
  sizeBytes: number;
}

export interface DiscoverSong {
  source: string;
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  artists: DiscoverSongArtist[];
  album: string;
  albumId?: string;
  cover?: string;
  durationMs: number;
  releaseDate: string;
  vip: boolean;
  playable: boolean;
  trackNo: number;
  discNo: number;
  language: string;
  genre: string;
  qualities: DiscoverSongQuality[];
  sourceUrl: string;
}

/** 单曲信息：标题 / 歌手 / 专辑 / 发行日期 / 时长 / 音质体积等（网易云、QQ 均支持）。 */
export async function fetchSongInfo(source: string, id: string): Promise<DiscoverSong> {
  return cached(`song:${source}:${id}`, async () => {
    const body = rec(await request('/api/discover/song', { source, id }));
    return {
      source: sourceOf(body?.source, source as DiscoverSource),
      id: str(body?.id, id),
      title: str(body?.title, '未知歌曲'),
      artist: str(body?.artist, '未知歌手'),
      artistId: str(body?.artistId) || undefined,
      artists: recList(body?.artists, (item) => {
        const name = str(item.name);
        if (!name) return null;
        return { id: str(item.id) || undefined, name } satisfies DiscoverSongArtist;
      }),
      album: str(body?.album),
      albumId: str(body?.albumId) || undefined,
      cover: str(body?.cover) || undefined,
      durationMs: num(body?.durationMs),
      releaseDate: str(body?.releaseDate),
      vip: bool(body?.vip),
      playable: bool(body?.playable),
      trackNo: num(body?.trackNo),
      discNo: num(body?.discNo),
      language: str(body?.language),
      genre: str(body?.genre),
      qualities: recList(body?.qualities, (item) => {
        const name = str(item.name);
        if (!name) return null;
        return { name, sizeBytes: num(item.sizeBytes) } satisfies DiscoverSongQuality;
      }),
      sourceUrl: str(body?.sourceUrl),
    } satisfies DiscoverSong;
  });
}
