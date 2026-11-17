/**
 * 动态壁纸 v2 客户端（docs/wallpaper-v2-spec.md §7）。
 * 全部端点挂在宿主回环服务的 /api/wallpaper/v2/ 下，鉴权与在线音乐共用同一 token。
 */

import { api, OnlineError, onlineEndpoint } from '../online/client';

export const WP = '/api/wallpaper/v2';

export type WallpaperKind = 'video' | 'image' | 'gif';
export type WallpaperSource = 'import' | 'watch' | 'workshop';
export type CanvasKind = 'inapp' | 'desktop';

export interface PictureTransform {
  mirrorH: boolean;
  mirrorV: boolean;
  /** 顺时针旋转，只允许 0 / 90 / 180 / 270。 */
  rotation: number;
  /** 四边裁剪百分比 0–45。 */
  cropLeft: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
  /** 缩放倍数 1–3。 */
  zoom?: number;
  /** 画面模糊半径 0–24px。 */
  blur?: number;
}

export interface WallpaperAsset {
  id: number;
  title: string;
  path: string;
  source: WallpaperSource;
  kind: WallpaperKind;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  effectiveDurationMs: number;
  fps: number | null;
  sizeBytes: number | null;
  coverPath: string | null;
  coverTimeMs: number | null;
  trimInMs: number | null;
  trimOutMs: number | null;
  speed: number;
  fitOverride: string | null;
  /** 画面变换（第 86 轮）：镜像 / 旋转 0·90·180·270 / 四边裁剪百分比。 */
  transform: PictureTransform;
  missing: boolean;
  favorite: boolean;
  addedAt: number;
}

export interface CanvasSnapshot {
  kind: string;
  assetId: number | null;
  title: string | null;
  coverPath: string | null;
  paused: boolean;
  running: boolean;
  lastError: string | null;
}

export interface WallpaperState {
  ok: boolean;
  enabled: boolean;
  libraryCount: number;
  ffmpegAvailable: boolean;
  ffmpegPath: string | null;
  inApp: CanvasSnapshot;
  desktop: CanvasSnapshot;
}

export interface LibraryPage {
  ok: boolean;
  total: number;
  offset: number;
  limit: number;
  items: WallpaperAsset[];
}

export interface WallpaperTag {
  id: number;
  name: string;
  count: number;
}

export interface WallpaperCollection {
  id: number;
  name: string;
  builtin: string | null;
  count: number;
}

export interface WallpaperOptions {
  enabled: boolean;
  inAppEnabled: boolean;
  desktopEnabled: boolean;
  desktopAttached?: boolean;
  audioEnabled: boolean;
  audioVolume: number;
  audioFollowSystem: boolean;
  musicDuckMs: number;
  musicRestoreMs: number;
  occludeThreshold: number;
  closeToTray: boolean;
  autoLaunch: string;
  pageNormal: boolean;
  pageImmersive: boolean;
  pageRoom: boolean;
  pageLogin: boolean;
  transitionMode: string;
  transitionId: string;
  transitionMs: number;
  rotationEnabled: boolean;
  rotationMinutes: number;
  rotationOrder: string;
  rotationFavoriteFirst: boolean;
  prewarm: boolean;
  frameRateLimit: number;
  renderScale: number;
  hardwareDecode: boolean;
  downsampleAbove: number;
  concurrentDecode: number;
  pauseOnMinimize: boolean;
  idleFpsAfterSec: number;
  idleFps: number;
  pauseOnBattery: boolean;
  pauseOnFullscreen: boolean;
  adaptiveQuality: boolean;
  reduceMotion: string;
  parallax: number;
  overlayEnabled: boolean;
  appearanceLink: boolean;
  beatLock: boolean;
  overlayTemplate: string;
  dimMode: string;
  dimBase: number;
  dimMax: number;
  dimEmaMs: number;
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number;
  accentFromFrame: boolean;
  fitMode: string;
  desktopSound: boolean;
  edgeBarEnabled: boolean;
  edgeBarDelayMs: number;
  visualizerEnabled: boolean;
  visualizerStyle: string;
  beatStrength: number;
  gridDensity: string;
  thumbConcurrency: number;
  cacheKeepDays: number;
  watchFolders: string[];
}

export interface WallpaperStorage {
  ok: boolean;
  libraryCount: number;
  favorites: number;
  mediaBytes: number;
  coverCount: number;
  coverBytes: number;
  root: string;
}

export interface WallpaperDiagnostics extends WallpaperStorage {
  ffmpegAvailable: boolean;
  ffmpegPath: string | null;
  frameRateLimit?: number;
  renderScale?: number;
  hardwareDecode?: boolean;
  inApp: CanvasSnapshot;
  desktop: CanvasSnapshot;
}

export type LibrarySort = 'added' | 'title' | 'size' | 'duration' | 'resolution';

export interface LibraryQuery {
  query?: string;
  kind?: WallpaperKind | '';
  source?: WallpaperSource | '';
  favorites?: boolean;
  resolution?: string;
  duration?: string;
  size?: string;
  collection?: number;
  tag?: number;
  sort?: LibrarySort;
  offset?: number;
  limit?: number;
}

/* ------------------------------------------------------------------ 端点封装 */

export function fetchState(): Promise<WallpaperState> {
  return api<WallpaperState>(`${WP}/state`);
}

/* ------------------------------------------------------------------ 多屏（第 88 轮） */

/** 一块屏的桌面画布：跟随全局时 assetId 就是全局那张，follow 标记「没单独指定」。 */
export interface WallpaperMonitor {
  key: string;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  primary: boolean;
  assetId: number | null;
  fps: number;
  /** 这块屏的刷新率上限（宿主从 Windows 显示模式读出来的），帧率选项不超过它。 */
  maxFps: number;
  follow: boolean;
  attached: boolean;
  title: string | null;
  coverPath: string | null;
}

export function fetchMonitors(): Promise<{ ok: boolean; items: WallpaperMonitor[] }> {
  return api(`${WP}/monitors`);
}

/** follow=true 跟全局走；否则把这块屏钉到 assetId 上。 */
export function saveMonitor(patch: {
  key: string;
  assetId?: number;
  fps?: number;
  follow?: boolean;
}): Promise<{ ok: boolean }> {
  return api(`${WP}/monitors`, {}, 20_000, 'PUT', patch);
}

/* ------------------------------------------------------------------ 画布参数（第 89 轮） */

/** 一个画布自己的画面参数；没设过的项回落到素材本身的 transform。 */
export interface CanvasPicture {
  mirrorH: boolean;
  mirrorV: boolean;
  rotation: number;
  cropLeft: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
  zoom: number;
  blur: number;
}

/** 画布参数快照：inapp 只有一份；desktop 每块屏各一份（monitor 是屏的稳定键）。 */
export interface CanvasSettingsState {
  ok: boolean;
  kind: CanvasKind;
  monitor: string | null;
  follow: boolean;
  assetId: number | null;
  fps: number;
  maxFps: number;
  picture: CanvasPicture;
}

export function fetchCanvasSettings(kind: CanvasKind, monitor?: string | null): Promise<CanvasSettingsState> {
  const params: Record<string, string> = {};
  if (monitor) params.monitor = monitor;
  return api(`${WP}/canvas/${kind}/settings`, params);
}

/** 只发要改的键（模糊 / 裁剪 / 缩放 / 帧率…），后端按画布合并进 filter_json。 */
export function saveCanvasSettings(
  kind: CanvasKind,
  monitor: string | null,
  patch: Partial<CanvasPicture> & { fps?: number },
): Promise<CanvasSettingsState> {
  return api(`${WP}/canvas/${kind}/settings`, {}, 20_000, 'PUT', { monitor: monitor ?? undefined, ...patch });
}

export function fetchLibrary(query: LibraryQuery = {}): Promise<LibraryPage> {
  const params: Record<string, string> = {};
  if (query.query) params.query = query.query;
  if (query.kind) params.kind = query.kind;
  if (query.source) params.source = query.source;
  if (query.favorites) params.favorites = '1';
  if (query.resolution) params.resolution = query.resolution;
  if (query.duration) params.duration = query.duration;
  if (query.size) params.size = query.size;
  if (query.collection) params.collection = String(query.collection);
  if (query.tag) params.tag = String(query.tag);
  if (query.sort) params.sort = query.sort;
  if (query.offset) params.offset = String(query.offset);
  if (query.limit) params.limit = String(query.limit);
  return api<LibraryPage>(`${WP}/library/items`, params, 20_000);
}

export function fetchAsset(id: number): Promise<{ ok: boolean; item: WallpaperAsset; tags: string[] }> {
  return api(`${WP}/library/items/${id}`);
}

export interface WallpaperSequenceItem {
  assetId: number;
  sort: number;
  durationMs: number | null;
  transitionId: string | null;
}

export interface WallpaperSequence {
  id: number;
  name: string;
  canvas: CanvasKind | null;
  loop: boolean;
  items: WallpaperSequenceItem[];
}

export interface WallpaperPreset {
  id: number;
  name: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface WallpaperRule {
  id: number;
  name: string;
  enabled: boolean;
  priority: number;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
}

export function fetchSequences(): Promise<{ ok: boolean; items: WallpaperSequence[] }> {
  return api(`${WP}/sequences`);
}

export function saveSequence(sequence: {
  id?: number;
  name: string;
  canvas?: CanvasKind | null;
  loop?: boolean;
  items: Array<{ assetId: number; durationMs?: number | null; transitionId?: string | null }>;
}): Promise<{ ok: boolean; item: WallpaperSequence }> {
  return api(`${WP}/sequences`, {}, 20_000, 'POST', sequence);
}

export function deleteSequence(id: number): Promise<{ ok: boolean }> {
  return api(`${WP}/sequences/${id}`, {}, 10_000, 'DELETE');
}

/** sequenceId = 0 表示退出序列、回到单张。 */
export function applySequence(kind: CanvasKind, sequenceId: number): Promise<{ ok: boolean; canvas: CanvasSnapshot }> {
  return api(`${WP}/canvas/${kind}/sequence`, {}, 15_000, 'POST', { sequenceId });
}

export function fetchPresets(): Promise<{ ok: boolean; items: WallpaperPreset[] }> {
  return api(`${WP}/presets`);
}

export function savePreset(preset: {
  id?: number;
  name: string;
  kind?: string;
  payload: Record<string, unknown>;
}): Promise<{ ok: boolean; id: number }> {
  return api(`${WP}/presets`, {}, 15_000, 'POST', preset);
}

export function deletePreset(id: number): Promise<{ ok: boolean }> {
  return api(`${WP}/presets/${id}`, {}, 10_000, 'DELETE');
}

export function fetchRules(): Promise<{ ok: boolean; items: WallpaperRule[] }> {
  return api(`${WP}/rules`);
}

export function saveRule(rule: {
  id?: number;
  name: string;
  enabled?: boolean;
  priority?: number;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
}): Promise<{ ok: boolean; id: number }> {
  return api(`${WP}/rules`, {}, 15_000, 'POST', rule);
}

export function deleteRule(id: number): Promise<{ ok: boolean }> {
  return api(`${WP}/rules/${id}`, {}, 10_000, 'DELETE');
}

export function patchAsset(
  id: number,
  patch: {
    title?: string;
    tags?: string[];
    favorite?: boolean;
    trimInMs?: number | null;
    trimOutMs?: number | null;
    speed?: number;
    fitOverride?: string | null;
    transform?: Partial<PictureTransform>;
  },
): Promise<{ ok: boolean; item: WallpaperAsset; tags: string[] }> {
  return api(`${WP}/library/items/${id}`, {}, 20_000, 'PUT', patch);
}

export function localizeAsset(id: number): Promise<{ ok: boolean; path?: string; alreadyLocal?: boolean }> {
  return api(`${WP}/library/items/${id}/localize`, {}, 45_000, 'POST', {});
}

export function deleteAsset(id: number): Promise<{ ok: boolean; id: number }> {
  return api(`${WP}/library/items/${id}`, {}, 20_000, 'DELETE');
}

export function scanLibrary(full = false): Promise<{ ok: boolean; added: number; updated: number; missing: number; skipped: number }> {
  return api(`${WP}/library/scan`, {}, 300_000, 'POST', { full: full ? 'true' : 'false' });
}

export function importFiles(paths: string[], copy: boolean): Promise<{ ok: boolean; added: number; ids: number[] }> {
  return api(`${WP}/library/import`, {}, 300_000, 'POST', { paths, copy: copy ? 'true' : 'false' });
}

export function fetchTags(): Promise<{ ok: boolean; tags: WallpaperTag[] }> {
  return api(`${WP}/library/tags`);
}

export function fetchCollections(): Promise<{ ok: boolean; collections: WallpaperCollection[] }> {
  return api(`${WP}/library/collections`);
}

export function applyAsset(assetId: number, canvas: CanvasKind = 'inapp'): Promise<{ ok: boolean; canvas: CanvasSnapshot }> {
  return api(`${WP}/canvas/${canvas}/apply`, {}, 20_000, 'POST', { assetId });
}

export function pauseCanvas(paused: boolean, canvas: CanvasKind = 'inapp'): Promise<{ ok: boolean; canvas: CanvasSnapshot }> {
  return api(`${WP}/canvas/${canvas}/pause`, {}, 20_000, 'POST', { paused: paused ? 'true' : 'false' });
}

export function nextWallpaper(canvas: CanvasKind = 'inapp'): Promise<{ ok: boolean; canvas: CanvasSnapshot }> {
  return api(`${WP}/canvas/${canvas}/next`, {}, 20_000, 'POST', {});
}

/**
 * 设置里的「页面显示壁纸」四个开关（pageNormal / pageImmersive / pageRoom / pageLogin）。
 * 壁纸层要不要在某类页面退场由它们决定，所以这里缓存一份最近读到的值：
 * 任何一次 options 读写都会刷新，壁纸层再据此重算可见性（见 wallpaperLayer.ts）。
 */
interface PageWallpaperSwitches {
  normal: boolean;
  immersive: boolean;
  room: boolean;
  login: boolean;
}

let pageSwitches: PageWallpaperSwitches = { normal: true, immersive: false, room: false, login: false };
let pageSwitchesLoaded = false;

/** 某类页面是否允许铺壁纸。 */
export function pageWallpaperAllowed(page: keyof PageWallpaperSwitches): boolean {
  return pageSwitches[page] === true;
}

/** 四个开关有没有成功读到过（没读到就别拿默认值当用户的设置）。 */
export function pageSwitchesKnown(): boolean {
  return pageSwitchesLoaded;
}

/** 补读一次设置（页面刚起来时在线端点可能还没就绪，第一次读会失败）。 */
export function refreshPageWallpaperSwitches(): void {
  void fetchOptions().catch(() => {});
}

/** 歌词页（沉浸播放页）是否允许铺壁纸。 */
export function pageImmersiveEnabled(): boolean {
  return pageWallpaperAllowed('immersive');
}

/** 读某一类页面的壁纸开关（快捷设置里的「动态壁纸」段用它回显）。 */
export function pageWallpaperSwitch(page: keyof PageWallpaperSwitches): boolean {
  return pageSwitches[page] === true;
}

/** 改某一类页面的壁纸开关：写回 options，壁纸层收到事件立刻重算。 */
export async function setPageWallpaper(page: keyof PageWallpaperSwitches, on: boolean): Promise<void> {
  const key =
    page === 'normal'
      ? 'pageNormal'
      : page === 'immersive'
        ? 'pageImmersive'
        : page === 'room'
          ? 'pageRoom'
          : 'pageLogin';
  await patchOptions({ [key]: on } as Partial<WallpaperOptions>);
}

function rememberOptions(options: WallpaperOptions | undefined): void {
  if (!options) return;
  pageSwitchesLoaded = true;
  const next: PageWallpaperSwitches = {
    normal: options.pageNormal !== false,
    immersive: options.pageImmersive === true,
    room: options.pageRoom === true,
    login: options.pageLogin === true,
  };
  const same = (Object.keys(next) as Array<keyof PageWallpaperSwitches>).every((key) => next[key] === pageSwitches[key]);
  if (same) return;
  pageSwitches = next;
  // 跨窗口通知：桌面背景歌词是另一个 WebView2，模块状态不共享，
  // 只能靠同源 localStorage 的 storage 事件把「样式变了」传过去。
  try {
    localStorage.setItem('zilux2.wallpaperOptionsStamp', JSON.stringify({ at: Date.now(), ...next }));
  } catch {
    // 无存储权限时退化成只在当前窗口生效。
  }
  // 设置页刚改完就要生效：壁纸层监听它重算「当前页要不要让位」。
  window.dispatchEvent(new Event('zilux:wallpaper-options'));
}

export async function fetchOptions(): Promise<{ ok: boolean; options: WallpaperOptions }> {
  const res = await api<{ ok: boolean; options: WallpaperOptions }>(`${WP}/options`);
  rememberOptions(res.options);
  return res;
}

export async function patchOptions(patch: Partial<WallpaperOptions>): Promise<{ ok: boolean; options: WallpaperOptions }> {
  const res = await api<{ ok: boolean; options: WallpaperOptions }>(`${WP}/options`, {}, 20_000, 'PUT', patch);
  rememberOptions(res.options);
  return res;
}

export function exportDiagnostics(): Promise<{ ok: boolean; path: string }> {
  return api(`${WP}/diagnostics/export`, {}, 30_000, 'POST', {});
}

export function runSelfCheck(): Promise<{
  ok: boolean;
  failures: number;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}> {
  return api(`${WP}/selfcheck`, {}, 30_000, 'POST', {});
}

export function attachDesktop(): Promise<{ ok: boolean; reason?: string | null; canvas?: CanvasSnapshot }> {
  return api(`${WP}/desktop/attach`, {}, 20_000, 'POST', {});
}

export function detachDesktop(): Promise<{ ok: boolean }> {
  return api(`${WP}/desktop/detach`, {}, 20_000, 'POST', {});
}

export function fetchStorage(): Promise<WallpaperStorage> {
  return api(`${WP}/storage`);
}

export function cleanStorage(): Promise<{ ok: boolean; removed: number; freedBytes: number }> {
  return api(`${WP}/storage/clean`, {}, 120_000, 'POST', {});
}

export function fetchDiagnostics(): Promise<WallpaperDiagnostics> {
  return api(`${WP}/diagnostics`);
}

/* ------------------------------------------------------------------ 素材地址 */

/** 封面 / 原文件都是回环地址（带 token），可直接给 img / video 用。 */
export function coverUrl(id: number, cacheKey?: number): string {
  const params: Record<string, string> = {};
  if (cacheKey) params.v = String(cacheKey);
  return onlineEndpoint(`${WP}/cover/${id}`, params);
}

export function mediaUrl(id: number, cacheKey?: number): string {
  const params: Record<string, string> = {};
  if (cacheKey) params.v = String(cacheKey);
  return onlineEndpoint(`${WP}/media/${id}`, params);
}

export function isWallpaperReady(err: unknown): boolean {
  return !(err instanceof OnlineError && err.code === 'not-ready');
}

/* ------------------------------------------------------------------ 展示助手 */

export function fmtSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '—';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

export function fmtResolution(asset: Pick<WallpaperAsset, 'width' | 'height'>): string {
  if (!asset.width || !asset.height) return '—';
  const long = Math.max(asset.width, asset.height);
  const short = Math.min(asset.width, asset.height);
  if (long >= 3800) return `4K ${short}p`;
  if (long >= 2500) return `1440p`;
  if (long >= 1900) return `1080p`;
  if (long >= 1200) return `720p`;
  return `${long}×${short}`;
}

export const SOURCE_LABELS: Record<WallpaperSource, string> = {
  import: '导入',
  watch: '目录',
  workshop: '工坊',
};

export const KIND_LABELS: Record<WallpaperKind, string> = {
  video: '视频',
  image: '图片',
  gif: 'GIF',
};

export const TRANSITION_LABELS: Record<string, string> = {
  none: '无',
  fade: '淡化',
  'fade-black': '黑场',
  'fade-white': '白闪',
  'slide-left': '左推',
  'slide-right': '右推',
  'slide-up': '上滑',
  'zoom-in': '推近',
  'blur-dissolve': '模糊叠化',
  'radial-blur': '径向模糊',
  exposure: '曝光',
  glitch: '故障',
  'film-grain': '胶片颗粒',
  'dissolve-noise': '斑点溶解',
  ripple: '水波纹',
};

export const VISUALIZER_LABELS: Record<string, string> = {
  spectrum: '频谱',
  wave: '波形',
  ring: '圆环',
  particles: '粒子',
};
