/**
 * 更新通道（Update v1）：宿主推送的快照 + 手动操作封装。
 * 协议见 docs/zilux2-update-channel.md。
 * 浏览器预览（无宿主）时所有操作静默降级，界面由 hostAvailable() 决定禁用/隐藏。
 */

import { host, hostAvailable, onUpdateState, type UpdateSnapshot, type UpdateState } from '../core/bridge';

/** 各状态的展示文案（设置页与提示共用）。 */
export const UPDATE_STATE_TEXT: Record<UpdateState, string> = {
  idle: '尚未检查',
  checking: '正在检查更新…',
  'up-to-date': '已是最新版本',
  available: '发现新版本',
  downloading: '正在下载更新…',
  downloaded: '新版本已下载，等待安装',
  installing: '正在启动安装程序…',
  error: '检查更新失败',
  unavailable: '更新通道暂不可用',
};

/** 初始快照：宿主推第一份快照之前界面用这个渲染。 */
const EMPTY_SNAPSHOT: UpdateSnapshot = {
  state: 'idle',
  currentVersion: '',
  latestVersion: '',
  releaseName: '',
  notes: '',
  pageUrl: '',
  assetName: '',
  assetSize: 0,
  downloaded: 0,
  total: 0,
  error: null,
  notice: null,
  mode: 'auto',
  autoCheck: true,
  repo: '',
  canAutoInstall: false,
  checkedAt: null,
};

let snapshot: UpdateSnapshot = { ...EMPTY_SNAPSHOT };
const listeners = new Set<(next: UpdateSnapshot) => void>();
let initialized = false;

function notify(): void {
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (error) {
      console.warn('[updates] listener failed', error);
    }
  });
}

/** 当前更新快照（只读）。 */
export function updateSnapshot(): UpdateSnapshot {
  return snapshot;
}

/** 订阅快照变化；返回取消函数。 */
export function onUpdateChange(listener: (next: UpdateSnapshot) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 页面启动时调用一次：绑定宿主推送。
 * 是否自动检查由宿主按 settings.updates.autoCheck 决定，前端不轮询、也不主动触发。
 */
export function initUpdates(): void {
  if (initialized) return;
  initialized = true;
  if (!hostAvailable()) return;
  onUpdateState((next) => {
    snapshot = next;
    notify();
  });
}

/** 检查更新（用户主动点击时 force=true，跳过宿主 60s 节流）。 */
export function checkForUpdate(): void {
  if (!hostAvailable()) return;
  host.checkForUpdate(true);
}

/** 下载新版本（notify 模式下用户手动点击）。 */
export function downloadUpdate(): void {
  if (!hostAvailable()) return;
  host.downloadUpdate();
}

/** 安装已下载的新版本（宿主会启动安装程序并退出）。 */
export function installUpdate(): void {
  if (!hostAvailable()) return;
  host.installUpdate();
}

/** 取消正在进行的下载。 */
export function cancelUpdate(): void {
  if (!hostAvailable()) return;
  host.cancelUpdate();
}

/** 在系统浏览器里打开 Release 页面。 */
export function openReleasePage(): void {
  if (!hostAvailable()) return;
  host.openReleasePage();
}

/** 下载进度百分比（0–100 的整数）；总量未知时返回 0。 */
export function updateProgress(current: UpdateSnapshot): number {
  if (!Number.isFinite(current.total) || current.total <= 0) return 0;
  const percent = Math.round((current.downloaded / current.total) * 100);
  return Math.min(100, Math.max(0, percent));
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

/** 字节数 → 人类可读（如 12.3 MB）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}
