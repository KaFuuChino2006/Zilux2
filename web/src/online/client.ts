/**
 * 在线音乐客户端：与宿主回环 HTTP 服务（docs/zilux2-online-music.md §5）通信。
 * 宿主在页面 ready 后推送 {type:'host', event:'online', payload:{port, token, sources}}。
 * 本地预览（无宿主）时可用 ?mock=1 打开内置演示数据，仅用于 UI 验收。
 */

import { host, type HostMessage } from '../core/bridge';
import type { OnlineInfo, OnlineLyric, OnlineSearchResult, OnlineSource, OnlineTrack, StreamQuality } from './types';
import { initSourceDescriptors, type SourceDescriptor } from './sources';

export class OnlineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OnlineError';
    this.code = code;
  }
}

type Listener = () => void;

let info: OnlineInfo | null = null;
let initialized = false;
let mockMode = false;
const listeners = new Set<Listener>();

export function initOnline(): void {
  if (initialized) return;
  initialized = true;

  const params = new URLSearchParams(window.location.search);
  if (params.get('mock') === '1') {
    mockMode = true;
    info = { port: 0, token: 'mock', sources: ['netease', 'qq'] };
  } else {
    // 开发/联调直连：?onlinePort=12345&onlineToken=xxx（绕过 WebView2 宿主消息）
    const portParam = Number(params.get('onlinePort') ?? '');
    const tokenParam = params.get('onlineToken') ?? '';
    if (Number.isFinite(portParam) && portParam > 0 && tokenParam) {
      info = { port: portParam, token: tokenParam, sources: ['netease', 'qq'] };
      host.log('info', `[online] dev direct port=${portParam}`);
    }
  }

  host.onMessage((msg: HostMessage) => {
    if (msg.type !== 'host' || msg.event !== 'online') return;
    const payload = msg.payload as Partial<OnlineInfo> | undefined;
    if (!payload || typeof payload.port !== 'number' || typeof payload.token !== 'string') {
      host.log('warn', '[online] bad online payload');
      return;
    }
    info = {
      port: payload.port,
      token: payload.token,
      sources: Array.isArray(payload.sources) ? (payload.sources as OnlineSource[]) : ['netease', 'qq'],
    };
    host.log('info', `[online] host ready port=${info.port} sources=${info.sources.join('+')}`);
    loadSourceDescriptors();
    listeners.forEach((cb) => cb());
  });
}

export function onOnlineChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function onlineInfo(): OnlineInfo | null {
  return info;
}

/** 拉取平台能力清单（宿主 GET /api/sources）；失败时沿用内置兜底。 */
function loadSourceDescriptors(): void {
  if (!info || info.port <= 0) return;
  api<{ sources: SourceDescriptor[] }>('/api/sources', {})
    .then((res) => {
      if (res && Array.isArray(res.sources)) initSourceDescriptors(res.sources);
    })
    .catch((err: unknown) => console.warn('[online] sources metadata failed', err));
}

export function onlineReady(): boolean {
  return !!info;
}

/** 「无名音乐」实验来源的本地缓存统计。 */
export interface Mvmp3CacheStat {
  count: number;
  bytes: number;
  dir?: string;
}

export async function fetchMvmp3Cache(): Promise<Mvmp3CacheStat> {
  return api<Mvmp3CacheStat>('/api/mvmp3/cache', {});
}

export async function clearMvmp3Cache(): Promise<Mvmp3CacheStat> {
  return api<Mvmp3CacheStat>('/api/mvmp3/cache', {}, 12_000, 'POST');
}

export function onlineSources(): OnlineSource[] {
  return info?.sources ?? [];
}

export function isMockOnline(): boolean {
  return mockMode;
}

/** 供 <img> 等直接引用的回环地址（自动带 token）；在线源未就绪时返回空串。 */
export function onlineEndpoint(path: string, params: Record<string, string> = {}): string {
  if (!info) return '';
  const query = new URLSearchParams({ ...params, token: info.token });
  return `${baseUrl()}${path}?${query.toString()}`;
}

function baseUrl(): string {
  if (!info) throw new OnlineError('not-ready', '在线源尚未就绪');
  return info.port === 0 ? 'http://127.0.0.1:0' : `http://127.0.0.1:${info.port}`;
}

export async function api<T>(
  path: string,
  params: Record<string, string> = {},
  timeoutMs = 12_000,
  method = 'GET',
  payload?: unknown,
): Promise<T> {
  if (mockMode) return mockApi<T>(path, params);
  const current = info;
  if (!current) throw new OnlineError('not-ready', '在线源尚未就绪');
  const query = new URLSearchParams({ ...params, token: current.token });
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl()}${path}?${query.toString()}`, {
      method,
      signal: controller.signal,
      cache: 'no-store',
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const type = resp.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) {
      if (!resp.ok) throw new OnlineError(`http-${resp.status}`, `网络请求失败（${resp.status}）`);
      throw new OnlineError('bad-response', '上游返回了无法解析的内容');
    }
    const body = (await resp.json()) as T & { error?: string; message?: string };
    if (!resp.ok) {
      throw new OnlineError(body.error ?? `http-${resp.status}`, body.message ?? `请求失败（${resp.status}）`);
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

export async function searchOnline(
  source: OnlineSource,
  query: string,
  limit = 20,
): Promise<OnlineSearchResult> {
  const keyword = query.trim();
  if (!keyword) return { source, query: '', tracks: [] };
  return api<OnlineSearchResult>('/api/search', { source, q: keyword, limit: String(limit) });
}

/** 宿主侧封面取色结果（页面 canvas 取不到像素时的可靠路径）。 */
export interface HostCoverColors {
  dominant: string | null;
  palette: string[];
}

export interface StreamInfo {
  source: string;
  id: string;
  requested: string;
  quality: string;
  bitrate: number;
  format: string;
}

/** 当前曲目实际下发的音质（宿主 /api/stream/info）。 */
export async function fetchCoverColors(source: string, key: string): Promise<HostCoverColors | null> {
  try {
    const data = await api<HostCoverColors>('/api/cover/colors', { source, key });
    if (!data || !data.dominant || !Array.isArray(data.palette) || data.palette.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

export async function fetchStreamInfo(source: OnlineSource, id: string, quality?: string): Promise<StreamInfo> {
  const params: Record<string, string> = { source, id };
  if (quality) params.quality = quality;
  return api<StreamInfo>('/api/stream/info', params);
}

/** QQ 音乐「音乐馆」热门歌单（宿主 /api/playlists/hot）。 */
export interface HotPlaylist {
  source: OnlineSource;
  id: string;
  title: string;
  cover: string;
  count: number;
  creator?: string;
}

export async function fetchHotPlaylists(source: OnlineSource = 'qq', limit = 24): Promise<HotPlaylist[]> {
  const data = await api<{ source: string; playlists: HotPlaylist[] }>('/api/playlists/hot', {
    source,
    limit: String(limit),
  });
  return Array.isArray(data.playlists) ? data.playlists : [];
}

/** 多平台融合的最近播放（本软件播放顺序 + 各平台最近播放）。 */
export async function fetchRecentMerged(limit = 40): Promise<OnlineTrack[]> {
  const data = await api<{ tracks: OnlineTrack[] }>('/api/library/recent/merged', { limit: String(limit) });
  return Array.isArray(data.tracks) ? data.tracks : [];
}

export async function fetchLyric(source: OnlineSource, id: string): Promise<OnlineLyric> {
  return api<OnlineLyric>('/api/lyric', { source, id });
}

/** /api/library/feed 的 kind：最近播放 / 每日推荐 / 私人雷达（网易云）。 */
export type FeedKind = 'recent' | 'daily' | 'radar';

/** 发现面板：最近播放 / 每日推荐（/api/library/feed）。 */
export async function fetchFeed(
  source: OnlineSource,
  kind: FeedKind,
  limit = 60,
): Promise<{ source: OnlineSource; kind: FeedKind; tracks: OnlineTrack[] }> {
  if (mockMode) {
    const label = kind === 'daily' ? '每日推荐' : kind === 'radar' ? '私人雷达' : '最近播放';
    const platform = source === 'qq' ? 'QQ 音乐' : '网易云音乐';
    const tracks: OnlineTrack[] = Array.from({ length: 8 }, (_, index) => ({
      source,
      id: `mock-feed-${kind}-${index}`,
      title: `${label} ${String(index + 1).padStart(2, '0')}`,
      artist: platform,
      album: '',
      durationMs: 180_000 + index * 12_000,
      cover: '',
      playable: true,
    }));
    return { source, kind, tracks };
  }
  return api<{ source: OnlineSource; kind: FeedKind; tracks: OnlineTrack[] }>('/api/library/feed', {
    source,
    kind,
    limit: String(limit),
  });
}

/** 查询歌曲是否已在对应平台「我喜欢的音乐」中。 */
export async function checkLiked(source: OnlineSource, id: string): Promise<boolean> {
  if (mockMode) return false;
  const body = await api<{ liked?: boolean }>('/api/library/liked', { source, id });
  return body.liked === true;
}

/** 批量查询收藏状态（搜索结果一次点亮收藏按钮）。 */
export async function checkLikedMany(
  source: OnlineSource,
  ids: string[],
): Promise<Record<string, boolean>> {
  if (mockMode || ids.length === 0) return {};
  const body = await api<{ liked?: Record<string, boolean> }>('/api/library/liked', {
    source,
    ids: ids.join(','),
  });
  return body.liked ?? {};
}

/** 取消「我喜欢的音乐」收藏（宿主调用平台接口）。 */
export async function removeLikedTrack(source: OnlineSource, id: string): Promise<void> {
  if (mockMode) return;
  const current = info;
  if (!current) throw new OnlineError('not-ready', '在线源尚未就绪');
  const query = new URLSearchParams({ source, id, token: current.token });
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const resp = await fetch(`${baseUrl()}/api/library/unlike?${query.toString()}`, {
      method: 'POST',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!resp.ok) throw new OnlineError('unlike-failed', `取消收藏失败（HTTP ${resp.status}）`);
  } finally {
    window.clearTimeout(timer);
  }
}

/** 加入「我喜欢的音乐」（宿主写入平台收藏）。 */
export async function addLikedTrack(source: OnlineSource, id: string): Promise<void> {
  if (mockMode) return;
  const current = info;
  if (!current) throw new OnlineError('not-ready', '在线源尚未就绪');
  const query = new URLSearchParams({ source, id, token: current.token });
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12_000);
  try {
    const resp = await fetch(`${baseUrl()}/api/library/like?${query.toString()}`, {
      method: 'POST',
      signal: controller.signal,
      cache: 'no-store',
    });
    const type = resp.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) {
      throw new OnlineError(`http-${resp.status}`, `网络请求失败（${resp.status}）`);
    }
    const body = (await resp.json()) as { error?: string; message?: string };
    if (!resp.ok) {
      throw new OnlineError(body.error ?? `http-${resp.status}`, body.message ?? '加入喜欢失败');
    }
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

/** 音频流地址（宿主代理，支持 Range，供 <audio> 直接使用）。 */
const QUALITY_KEY = 'zilux2.qualityBySource';

function readQualityMap(): Record<string, StreamQuality> {
  try {
    const raw = localStorage.getItem(QUALITY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, StreamQuality> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === 'standard' || value === 'high' || value === 'lossless') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

let defaultQuality: StreamQuality = 'high';
let qualityBySource: Record<string, StreamQuality> = readQualityMap();

/** 默认音质（设置里的全局值），没有单独设置过的平台用它。 */
export function setStreamQuality(next: StreamQuality): void {
  defaultQuality = next;
}

/** 某平台当前使用的音质。 */
export function qualityForSource(source: string): StreamQuality {
  return qualityBySource[source] ?? defaultQuality;
}

/** 记住某平台选择的音质；下一次解析播放地址时生效。 */
export function setQualityForSource(source: string, next: StreamQuality): void {
  qualityBySource[source] = next;
  try {
    localStorage.setItem(QUALITY_KEY, JSON.stringify(qualityBySource));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function streamUrl(track: OnlineTrack): string {
  // 本地歌曲：id 就是 https://localmusic.local/... 的完整地址，直接交给 <audio>
  if (track.source === 'local') return track.id;
  if (mockMode) return mockAudioUrl();
  const current = info;
  if (!current) throw new OnlineError('not-ready', '在线源尚未就绪');
  const query = new URLSearchParams({
    source: track.source,
    id: track.id,
    token: current.token,
    quality: qualityForSource(track.source),
  });
  if (track.source === 'mvmp3') {
    // 宿主会把歌名/歌手写进缓存旁的文件里，本地曲库按友好名称显示。
    query.set('title', track.title);
    query.set('artist', track.artist);
  }
  return `${baseUrl()}/api/stream?${query.toString()}`;
}

/* ------------------------------------------------------------------ */
/* mock：仅 ?mock=1 时启用，用于无宿主时的 UI 验收                        */
/* ------------------------------------------------------------------ */

const MOCK_TRACKS: Omit<OnlineTrack, 'cover'>[] = [
  { source: 'netease', id: 'mock-ne-1', title: '夜航星', artist: '林一', album: '夜航星', durationMs: 214000, playable: true },
  { source: 'netease', id: 'mock-ne-2', title: '雨落之前', artist: '苏晚', album: '雨落之前', durationMs: 198000, playable: true },
  { source: 'netease', id: 'mock-ne-3', title: '回声走廊', artist: '陈默', album: '回声走廊', durationMs: 236000, playable: false },
  { source: 'qq', id: 'mock-qq-1', title: '银河慢车', artist: '顾星河', album: '银河慢车', durationMs: 262000, playable: true },
  { source: 'qq', id: 'mock-qq-2', title: '潮汐之间', artist: '蔡雨桐', album: '潮汐之间', durationMs: 245000, playable: true },
  { source: 'qq', id: 'mock-qq-3', title: '纸月', artist: '徐念', album: '纸月', durationMs: 188000, playable: false },
];

const coverCache = new Map<string, string>();

function mockCover(seed: string): string {
  const cached = coverCache.get(seed);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 200;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  const grad = ctx.createLinearGradient(0, 0, 200, 200);
  grad.addColorStop(0, `hsl(${hue} 80% 62%)`);
  grad.addColorStop(1, `hsl(${(hue + 80) % 360} 70% 34%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 200, 200);
  const radial = ctx.createRadialGradient(150, 40, 4, 150, 40, 180);
  radial.addColorStop(0, 'rgba(255,255,255,0.45)');
  radial.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, 200, 200);
  const url = canvas.toDataURL('image/png');
  coverCache.set(seed, url);
  return url;
}

function mockSearch(source: OnlineSource, query: string): OnlineSearchResult {
  const keyword = query.trim();
  const tracks = MOCK_TRACKS.filter((item) => item.source === source)
    .filter((item) => !keyword || item.title.includes(keyword) || item.artist.includes(keyword))
    .map((item) => ({ ...item, cover: mockCover(item.id) }));
  return { source, query: keyword, tracks, tookMs: 42 };
}

function mockLyric(source: OnlineSource, id: string): OnlineLyric {
  const track = MOCK_TRACKS.find((item) => item.id === id);
  const duration = (track?.durationMs ?? 200_000) / 1000;
  const rows: string[] = [];
  for (let t = 0, i = 0; t + 2 < duration; t += 4, i += 1) {
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(Math.floor(t % 60)).padStart(2, '0');
    rows.push(`[${mm}:${ss}.00]${track?.title ?? '演示'} · 第 ${i + 1} 句歌词`);
  }
  return {
    source,
    id,
    lrc: rows.join('\n'),
    translation: null,
    hasTranslation: false,
  };
}

const MOCK_WAV_SECONDS = 32;
let mockWav: string | null = null;

/** 生成一段 32 秒的和弦 WAV（data URL），让播放器/进度条/歌词在离线也能动起来。 */
function mockAudioUrl(): string {
  if (mockWav) return mockWav;
  const sampleRate = 8000;
  const total = Math.floor(MOCK_WAV_SECONDS * sampleRate);
  const bytes = new ArrayBuffer(44 + total * 2);
  const view = new DataView(bytes);
  const writeText = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, total * 2, true);
  const chords = [
    [220.0, 277.18, 329.63],
    [196.0, 246.94, 293.66],
    [174.61, 220.0, 261.63],
    [196.0, 246.94, 329.63],
  ];
  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const chord = chords[Math.floor(t / 4) % chords.length] ?? chords[0]!;
    const fade = Math.min(1, t / 0.8) * Math.min(1, (MOCK_WAV_SECONDS - t) / 0.8);
    const beat = Math.max(0, Math.sin(t * Math.PI * 2)) ** 24 * 0.18;
    const sample =
      (Math.sin(2 * Math.PI * chord[0]! * t) * 0.12 +
        Math.sin(2 * Math.PI * chord[1]! * t) * 0.09 +
        Math.sin(2 * Math.PI * chord[2]! * t) * 0.07) *
        fade +
      beat;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
  }
  const binary = new Uint8Array(bytes);
  let text = '';
  const chunk = 0x8000;
  for (let i = 0; i < binary.length; i += chunk) {
    text += String.fromCharCode(...binary.subarray(i, i + chunk));
  }
  mockWav = `data:audio/wav;base64,${btoa(text)}`;
  return mockWav;
}

function mockApi<T>(path: string, params: Record<string, string>): Promise<T> {
  if (path === '/api/search') {
    return Promise.resolve(mockSearch(params.source as OnlineSource, params.q ?? '') as T);
  }
  if (path === '/api/lyric') {
    return Promise.resolve(mockLyric(params.source as OnlineSource, params.id ?? '') as T);
  }
  return Promise.reject(new OnlineError('mock-unsupported', '演示模式下不支持该接口'));
}

/** 记录本机播放历史（宿主持久化，最近播放用；失败静默）。 */
export async function recordRecent(track: OnlineTrack): Promise<void> {
  if (isMockOnline()) return;
  const current = info;
  if (!current || current.port <= 0) return;
  try {
    const token = encodeURIComponent(current.token);
    const response = await fetch(`${baseUrl()}/api/library/recent?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: track.source,
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationMs: track.durationMs,
        cover: track.cover,
      }),
    });
    if (!response.ok) return;
  } catch {
    // 记录历史失败不影响播放
  }
}
