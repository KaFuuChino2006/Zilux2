/** 宿主桥：在 WebView2 里走 chrome.webview，在浏览器里自动降级为 no-op。 */

interface WebViewLike {
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void;
}

interface ChromeLike {
  webview?: WebViewLike;
}

declare global {
  interface Window {
    chrome?: ChromeLike;
  }
}

export interface HostMessage {
  v?: number;
  type?: string;
  event?: string;
  maximized?: boolean;
  version?: string;
  state?: unknown;
  [key: string]: unknown;
}

function webview(): WebViewLike | undefined {
  return window.chrome?.webview;
}

export function hostAvailable(): boolean {
  return !!webview();
}

function post(payload: Record<string, unknown>): void {
  const wv = webview();
  if (!wv) return;
  try {
    wv.postMessage(payload);
  } catch (err) {
    console.warn('[bridge] postMessage failed', err);
  }
}

/**
 * 发送任意 v1 消息。
 *
 * 给「页面扩展指令」（airplay 等）复用，避免每个模块自己摸 chrome.webview。
 * 无宿主时静默丢弃并返回 false，调用方可据此走降级路径。
 */
export function postMessage(payload: Record<string, unknown>): boolean {
  if (!webview()) return false;
  post(payload);
  return true;
}

/* ---- 应用更新（Update v1，见 docs/zilux2-update-channel.md） ---- */

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'unavailable';

export type UpdateMode = 'auto' | 'notify';

/**
 * 宿主推送的更新状态快照。
 *
 * 注意：协议里所有字段都在消息顶层（不是嵌在 payload 里），每次状态变化推完整快照。
 */
export interface UpdateSnapshot {
  state: UpdateState;
  currentVersion: string;
  latestVersion: string;
  releaseName: string;
  notes: string;
  pageUrl: string;
  assetName: string;
  assetSize: number;
  downloaded: number;
  total: number;
  error: string | null;
  notice: string | null;
  mode: UpdateMode;
  autoCheck: boolean;
  repo: string;
  canAutoInstall: boolean;
  checkedAt: string | null;
}

const UPDATE_STATES: readonly UpdateState[] = [
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'downloaded',
  'installing',
  'error',
  'unavailable',
];

const updateHandlers = new Set<(snapshot: UpdateSnapshot) => void>();
let updateBound = false;

function updateText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function updateBytes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 把宿主消息归一化成 UpdateSnapshot；state 不合法时返回 null（视为无效推送）。 */
function normalizeUpdateSnapshot(message: HostMessage): UpdateSnapshot | null {
  if (typeof message.state !== 'string' || !(UPDATE_STATES as readonly string[]).includes(message.state)) {
    return null;
  }
  return {
    state: message.state as UpdateState,
    currentVersion: updateText(message.currentVersion),
    latestVersion: updateText(message.latestVersion),
    releaseName: updateText(message.releaseName),
    notes: updateText(message.notes),
    pageUrl: updateText(message.pageUrl),
    assetName: updateText(message.assetName),
    assetSize: updateBytes(message.assetSize),
    downloaded: updateBytes(message.downloaded),
    total: updateBytes(message.total),
    error: updateText(message.error) || null,
    notice: updateText(message.notice) || null,
    mode: message.mode === 'notify' ? 'notify' : 'auto',
    autoCheck: message.autoCheck !== false,
    repo: updateText(message.repo),
    canAutoInstall: message.canAutoInstall === true,
    checkedAt: typeof message.checkedAt === 'string' && message.checkedAt ? message.checkedAt : null,
  };
}

export const host = {
  ready(): void {
    post({ v: 1, type: 'ready' });
  },
  minimize(): void {
    post({ v: 1, type: 'window', action: 'minimize' });
  },
  toggleMaximize(): void {
    post({ v: 1, type: 'window', action: 'toggleMaximize' });
  },
  close(): void {
    post({ v: 1, type: 'window', action: 'close' });
  },
  /** 告诉宿主当前页面主背景色，宿主用它给窗口边条上色（避免露出不一致的边框）。 */
  setChromeColor(color: string): void {
    post({ v: 1, type: 'window', action: 'chromeColor', color });
  },
  drag(): void {
    post({ v: 1, type: 'drag' });
  },
  /** 无边框窗口：把边缘 pointerdown 交回系统缩放循环。 */
  resize(edge: 'left' | 'right' | 'top' | 'bottom'): void {
    post({ v: 1, type: 'resize', edge });
  },
  log(level: 'info' | 'warn' | 'error', message: string): void {
    post({ v: 1, type: 'log', level, message });
    if (level === 'error') console.error('[web]', message);
  },
  /* ---- 设置（Settings v1，见 docs/zilux2-settings-contract.md） ---- */
  requestSettings(): void {
    post({ v: 1, type: 'settings', action: 'request' });
  },
  /** 请求宿主枚举系统已安装字体（歌词字体选择用） */
  requestFonts(): void {
    post({ v: 1, type: 'fonts' });
  },
  /** 让宿主弹出系统文件夹选择器，扫描本地歌曲（结果走 localLibrary 事件） */
  pickLocalMusic(): void {
    post({ v: 1, type: 'local', action: 'pick' });
  },
  /** 按上次记录的文件夹路径重新载入本地歌曲库 */
  restoreLocalMusic(folder: string): void {
    post({ v: 1, type: 'local', action: 'restore', folder });
  },
  /** 重新扫描本地/下载目录（结果走 localLibrary 事件） */
  rescanLocalMusic(): void {
    post({ v: 1, type: 'local', action: 'rescan' });
  },
  /** 在资源管理器里打开下载目录（folder 为空时宿主用设置/系统音乐目录） */
  openDownloadFolder(folder?: string): void {
    post({ v: 1, type: 'local', action: 'openDownloadDir', folder: folder ?? '' });
  },
  /** 把本地/下载曲目移进回收站（结果走 localResult 事件） */
  deleteLocalTracks(rels: string[]): void {
    post({ v: 1, type: 'local', action: 'delete', rels });
  },
  /** 在资源管理器里定位一首本地/下载曲目 */
  revealLocalTrack(rel: string): void {
    post({ v: 1, type: 'local', action: 'reveal', rel });
  },
  /** 打开当前本地歌曲文件夹 */
  openLocalFolder(): void {
    post({ v: 1, type: 'local', action: 'openFolder' });
  },
  patchSettings(patch: Record<string, unknown>): void {
    post({ v: 1, type: 'settings', action: 'patch', patch });
  },
  resetSettings(): void {
    post({ v: 1, type: 'settings', action: 'reset' });
  },
  /* ---- 应用更新（Update v1，见 docs/zilux2-update-channel.md） ---- */
  /** 检查更新；force=true 跳过宿主的 60s 节流 */
  checkForUpdate(force = false): void {
    if (force) {
      post({ v: 1, type: 'update', action: 'check', force: true });
      return;
    }
    post({ v: 1, type: 'update', action: 'check' });
  },
  /** 下载已发现的新版本安装包（结果走 update 事件快照） */
  downloadUpdate(): void {
    post({ v: 1, type: 'update', action: 'download' });
  },
  /** 对已下载并校验通过的安装包静默安装并重启（Windows 实现为启动安装器后退出） */
  installUpdate(): void {
    post({ v: 1, type: 'update', action: 'install' });
  },
  /** 取消进行中的下载 */
  cancelUpdate(): void {
    post({ v: 1, type: 'update', action: 'cancel' });
  },
  /** 用系统浏览器打开最新 Release 页面（无 Release 时打开 releases 列表） */
  openReleasePage(): void {
    post({ v: 1, type: 'update', action: 'openReleasePage' });
  },
  onMessage(handler: (msg: HostMessage) => void): void {
    const wv = webview();
    if (!wv) return;
    wv.addEventListener('message', (e) => {
      const data = e.data;
      if (!data || typeof data !== 'object') return;
      handler(data as HostMessage);
    });
  },
};

/* ---- Windows Now Playing / SMTC（media event v1，见 docs/zilux2-host-contract.md §11） ---- */

export type MediaAction = 'play' | 'pause' | 'next' | 'prev' | 'stop' | 'seek';

/** 页面 → 宿主：当前播放状态（宿主转成 SMTC「正在播放」）。 */
export interface MediaState {
  title?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  durationMs?: number;
  positionMs?: number;
  playing?: boolean;
}

/** 宿主 → 页面：系统媒体键 / 浮层按钮。 */
export interface MediaControl {
  action: MediaAction;
  positionMs?: number;
}

const MEDIA_ACTIONS: readonly MediaAction[] = ['play', 'pause', 'next', 'prev', 'stop', 'seek'];
const mediaControlHandlers = new Set<(control: MediaControl) => void>();
let mediaControlBound = false;

function finiteMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

/**
 * 上报播放状态到宿主（Windows SMTC）。
 * 频率建议 ≤10 次/秒；宿主内部按 100ms 合并，取最后一次。
 * 无宿主（浏览器预览）时静默跳过。
 */
export function reportMedia(state: MediaState): void {
  if (!webview()) return;
  const payload: Record<string, unknown> = {
    durationMs: finiteMs(state.durationMs),
    positionMs: finiteMs(state.positionMs),
    playing: state.playing === true,
  };
  if (state.title) payload.title = state.title;
  if (state.artist) payload.artist = state.artist;
  if (state.album) payload.album = state.album;
  if (state.coverUrl) payload.coverUrl = state.coverUrl;
  post({ v: 1, type: 'media', payload });
}

/**
 * 订阅宿主转发的媒体控制（play/pause/next/prev/stop/seek）。
 * 只在首次注册时挂一条 webview 监听；返回取消订阅函数。
 */
/* ---- 本地歌曲库（localLibrary event v1） ---- */

export interface LocalLibraryTrack {
  rel: string;
  name: string;
  size: number;
  /** 音频里是否内嵌封面（宿主只给标记，图片走 /__cover 单独取）。 */
  hasCover?: boolean;
  /** CUE 曲名 */
  title?: string;
  /** CUE 歌手 */
  artist?: string;
  /** CUE 分轨在镜像文件里的起始毫秒 */
  startMs?: number;
  /** CUE 分轨时长毫秒（0 = 播到文件结束） */
  durationMs?: number;
  /** CUE 曲目号（0 = 整个文件） */
  cue?: number;
}

export interface LocalLibraryPayload {
  folder: string;
  name: string;
  tracks: LocalLibraryTrack[];
  lyrics?: string[];
  error?: string | null;
}

/** 本地曲库操作（删除到回收站等）的结果回执。 */
export interface LocalResultPayload {
  action: string;
  ok: boolean;
  message: string;
}

const localLibraryHandlers = new Set<(payload: LocalLibraryPayload) => void>();
const localCancelHandlers = new Set<() => void>();
const localResultHandlers = new Set<(payload: LocalResultPayload) => void>();
let localLibraryBound = false;

/** 订阅本地曲库操作结果（删除/定位等）。 */
export function onLocalResult(handler: (payload: LocalResultPayload) => void): () => void {
  localResultHandlers.add(handler);
  onLocalLibrary(() => undefined);
  return () => {
    localResultHandlers.delete(handler);
  };
}

/** 订阅「用户取消了文件夹选择」事件，用来解锁页面按钮。 */
export function onLocalCancel(handler: () => void): () => void {
  localCancelHandlers.add(handler);
  onLocalLibrary(() => undefined);
  return () => {
    localCancelHandlers.delete(handler);
  };
}

/** 订阅宿主扫描完成的本地歌曲库（选择文件夹或按记录恢复后推送）。 */
export function onLocalLibrary(handler: (payload: LocalLibraryPayload) => void): () => void {
  localLibraryHandlers.add(handler);
  if (!localLibraryBound) {
    localLibraryBound = true;
    host.onMessage((message) => {
      if (message.type === 'host' && message.event === 'localResult') {
        const payload = message.payload as Partial<LocalResultPayload> | undefined;
        if (!payload || typeof payload !== 'object') return;
        const normalized: LocalResultPayload = {
          action: typeof payload.action === 'string' ? payload.action : '',
          ok: payload.ok === true,
          message: typeof payload.message === 'string' ? payload.message : '',
        };
        localResultHandlers.forEach((listener) => {
          try {
            listener(normalized);
          } catch (err) {
            console.warn('[bridge] localResult handler failed', err);
          }
        });
        return;
      }
      if (message.type === 'host' && message.event === 'localCancel') {
        localCancelHandlers.forEach((listener) => {
          try {
            listener();
          } catch (err) {
            console.warn('[bridge] localCancel handler failed', err);
          }
        });
        return;
      }
      if (message.type !== 'host' || message.event !== 'localLibrary') return;
      const payload = message.payload;
      if (!payload || typeof payload !== 'object') return;
      const raw = payload as Partial<LocalLibraryPayload>;
      const tracks = Array.isArray(raw.tracks) ? raw.tracks : [];
      const normalized: LocalLibraryPayload = {
        folder: typeof raw.folder === 'string' ? raw.folder : '',
        name: typeof raw.name === 'string' ? raw.name : '',
        tracks: tracks
          .filter(
            (item): item is LocalLibraryTrack =>
              !!item && typeof item.rel === 'string' && typeof item.name === 'string',
          )
          .map((item) => ({
            ...item,
            hasCover: item.hasCover === true,
            title: typeof item.title === 'string' && item.title ? item.title : undefined,
            artist: typeof item.artist === 'string' && item.artist ? item.artist : undefined,
            startMs: Number(item.startMs) > 0 ? Number(item.startMs) : 0,
            durationMs: Number(item.durationMs) > 0 ? Number(item.durationMs) : 0,
            cue: Number(item.cue) > 0 ? Number(item.cue) : 0,
          })),
        lyrics: Array.isArray(raw.lyrics)
          ? (raw.lyrics as unknown[]).filter((item): item is string => typeof item === 'string')
          : [],
        error: typeof raw.error === 'string' && raw.error ? raw.error : null,
      };
      localLibraryHandlers.forEach((listener) => {
        try {
          listener(normalized);
        } catch (err) {
          console.warn('[bridge] localLibrary handler failed', err);
        }
      });
    });
  }
  return () => {
    localLibraryHandlers.delete(handler);
  };
}

export function onMediaControl(handler: (control: MediaControl) => void): () => void {
  mediaControlHandlers.add(handler);
  if (!mediaControlBound) {
    mediaControlBound = true;
    host.onMessage((message) => {
      if (message.type !== 'host' || message.event !== 'mediaControl') return;
      const payload = message.payload;
      if (!payload || typeof payload !== 'object') return;
      const raw = payload as { action?: unknown; positionMs?: unknown };
      if (typeof raw.action !== 'string' || !(MEDIA_ACTIONS as readonly string[]).includes(raw.action)) {
        return;
      }
      const control: MediaControl = { action: raw.action as MediaAction };
      if (control.action === 'seek') {
        control.positionMs = finiteMs(raw.positionMs);
      }
      mediaControlHandlers.forEach((listener) => {
        try {
          listener(control);
        } catch (err) {
          console.warn('[bridge] mediaControl handler failed', err);
        }
      });
    });
  }
  return () => {
    mediaControlHandlers.delete(handler);
  };
}

/** 订阅宿主推送的更新状态快照（页面 ready 后立即推一次，之后每次状态变化都推完整快照）。 */
export function onUpdateState(handler: (snapshot: UpdateSnapshot) => void): () => void {
  updateHandlers.add(handler);
  if (!updateBound) {
    updateBound = true;
    host.onMessage((message) => {
      if (message.type !== 'host' || message.event !== 'update') return;
      const snapshot = normalizeUpdateSnapshot(message);
      if (!snapshot) return;
      updateHandlers.forEach((listener) => {
        try {
          listener(snapshot);
        } catch (err) {
          console.warn('[bridge] update handler failed', err);
        }
      });
    });
  }
  return () => {
    updateHandlers.delete(handler);
  };
}
