/// <reference types="vite/client" />
/**
 * 下载队列面板 + 可嵌入视图（快捷设置「下载」页共用同一份状态）。
 *
 * 宿主（/api/download*）只提供「发起 / 列表 / 定位」三个接口，没有取消与清空，
 * 所以这里做的是：统一接管 startDownload、轮询进度、轻量 diff 更新视图、失败重试、
 * 完成后在资源管理器里定位文件。浮层面板与入口按钮按需懒创建，dispose 时清掉定时器与监听。
 *
 * 轮询策略：递归 setTimeout（非 setInterval），按状态动态调频：
 *   - 有进行中任务 / 有可见队列视图（浮层或快捷设置「下载」页）→ 1.2s
 *   - 有请求正在发起（POST 未返回）→ 0.4s
 *   - 有可见视图但全部结束 → 4s
 *   - 页面隐藏 → 5s
 *   - 没有任何可见视图且无进行中任务 → 停止轮询（下次入队 / 打开视图时重启）
 * 每次刷新都走同一次 inflight Promise 去重，避免并发 GET。
 */
import '../styles/download-queue.css';
import '../styles/download-queue-embed.css';
import { fetchDownloads, revealDownload, startDownload, type DownloadJob } from '../online/download';
import type { OnlineTrack, StreamQuality } from '../online/types';
import { getSettings } from '../core/settings';
import { host } from '../core/bridge';
import { h, icon, toast } from './dom';

export type DownloadFilter = 'all' | 'running' | 'done' | 'error';

/** 面板 / 入口按钮使用的只读快照（也暴露给 window.__zilux2DownloadQueue 便于真机排查）。 */
export interface DownloadQueueSnapshot {
  jobs: DownloadJob[];
  directory: string;
  running: number;
  done: number;
  error: number;
  filter: DownloadFilter;
  panelOpen: boolean;
  refreshing: boolean;
  lastError: string | null;
  updatedAt: number;
}

type ChangeListener = (snapshot: DownloadQueueSnapshot) => void;

interface RowRefs {
  name: HTMLDivElement;
  meta: HTMLDivElement;
  pct: HTMLDivElement;
  status: HTMLDivElement;
  fill: HTMLDivElement;
  reveal: HTMLButtonElement;
  retry: HTMLButtonElement;
  actions: HTMLDivElement;
}

interface RowHandle {
  el: HTMLDivElement;
  refs: RowRefs;
  key: string;
}

interface PanelRefs {
  root: HTMLElement;
  error: HTMLDivElement;
  refreshBtn: HTMLButtonElement;
  sumRunning: HTMLElement;
  sumDone: HTMLElement;
  sumError: HTMLElement;
  view: DownloadQueueViewImpl;
}

interface DownloadQueueDebugApi {
  state: () => DownloadQueueSnapshot;
  toggle: (open?: boolean) => void;
  open: () => void;
  close: () => void;
  refresh: () => Promise<void>;
}

type DebugWindow = Window & { __zilux2DownloadQueue?: DownloadQueueDebugApi };

const FILTERS: ReadonlyArray<{ key: DownloadFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '下载中' },
  { key: 'done', label: '已完成' },
  { key: 'error', label: '失败' },
];

const QUALITY_LABELS: Record<string, string> = {
  lossless: '无损',
  high: '高品质',
  standard: '标准',
};

const POLL_RUNNING_MS = 1200;
const POLL_HIDDEN_MS = 5000;
const POLL_IDLE_MS = 4000;
const POLL_PENDING_MS = 400;

const listeners = new Set<ChangeListener>();
const pendingKeys = new Set<string>();
// 速度：用两次 received 差 / 时间差估算，只在 running 行显示（MB/s，1 位小数）。
const speeds = new Map<string, number>();
const speedSamples = new Map<string, { received: number; at: number }>();
// 正在展示的嵌入视图（快捷设置「下载」页）；切走时移出集合即停止刷新。
const embeddedViews = new Set<DownloadQueueViewImpl>();

let jobs: DownloadJob[] = [];
let directory = '';
let filter: DownloadFilter = 'all';
let panelOpen = false;
let refreshing = false;
let refreshedOnce = false;
let lastError: string | null = null;
let updatedAt = 0;
let pendingStarts = 0;
let panel: PanelRefs | null = null;
let entryBtn: HTMLButtonElement | null = null;
let entryBadge: HTMLSpanElement | null = null;
let pollTimer = 0;
let inflight: Promise<void> | null = null;
let generation = 0;
let initialized = false;
let disposed = false;
let documentBound = false;
let lastPointerToggleAt = 0;

/* ---------- 小工具 ---------- */

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error);
  return text && text !== '[object Object]' ? text : '未知错误';
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function qualityLabel(value: string): string {
  return QUALITY_LABELS[value] ?? value;
}

function asQuality(value: string): StreamQuality | undefined {
  return value === 'lossless' || value === 'high' || value === 'standard' ? value : undefined;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function trackKey(source: string, trackId: string): string {
  return `${source}:${trackId}`;
}

function countJobs(): { running: number; done: number; error: number } {
  let running = 0;
  let done = 0;
  let error = 0;
  for (const job of jobs) {
    if (job.state === 'running') running += 1;
    else if (job.state === 'done') done += 1;
    else error += 1;
  }
  return { running, done, error };
}

function findJob(id: string | undefined): DownloadJob | undefined {
  if (!id) return undefined;
  return jobs.find((job) => job.id === id);
}

/* ---------- 通知 / 同步 ---------- */

function notify(): void {
  try {
    syncEntry();
    syncPanel();
    for (const view of embeddedViews) view.render();
  } catch (error) {
    console.warn('[downloadQueue] sync failed', error);
  }
  if (listeners.size === 0) return;
  const snapshot = downloadQueueState();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.warn('[downloadQueue] listener failed', error);
    }
  }
}

function syncEntry(): void {
  const button = entryBtn;
  if (!button) return;
  const { running } = countJobs();
  button.classList.toggle('is-active', running > 0);
  button.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
  button.title = running > 0 ? `下载队列（${running} 个任务进行中）` : '下载队列';
  const badge = entryBadge;
  if (!badge) return;
  badge.hidden = running === 0;
  const text = running > 99 ? '99+' : String(running);
  if (badge.textContent !== text) badge.textContent = text;
}

function syncPanel(): void {
  const refs = panel;
  if (!refs || disposed) return;
  const summary = countJobs();
  refs.root.classList.toggle('is-open', panelOpen);
  refs.root.setAttribute('aria-hidden', panelOpen ? 'false' : 'true');
  setText(refs.sumRunning, String(summary.running));
  setText(refs.sumDone, String(summary.done));
  setText(refs.sumError, String(summary.error));
  const errorText = lastError ? `刷新下载列表失败：${lastError}` : '';
  setText(refs.error, errorText);
  refs.error.hidden = errorText === '';
  refs.refreshBtn.classList.toggle('is-busy', refreshing);
  // 筛选 tab / 列表 / 目录三块由可复用视图渲染（与快捷设置「下载」页共用同一份实现）。
  refs.view.render();
}

function visibleJobs(): DownloadJob[] {
  const priority: Record<string, number> = { running: 0, error: 1, done: 2 };
  const list = filter === 'all' ? jobs.slice() : jobs.filter((job) => job.state === filter);
  // Array.prototype.sort 稳定，同状态内保留宿主 startedAt 倒序。
  return list.sort((a, b) => (priority[a.state] ?? 3) - (priority[b.state] ?? 3));
}

/* ---------- 行 ---------- */

function rowKey(job: DownloadJob): string {
  const speed = speeds.get(job.id);
  return [
    job.state,
    job.title,
    job.artist,
    job.quality,
    job.received,
    job.total,
    job.fileName,
    job.error ?? '',
    job.path ?? '',
    speed === undefined ? '' : speed.toFixed(0),
  ].join('\u0001');
}

function progressOf(job: DownloadJob): number | null {
  if (!Number.isFinite(job.received) || !Number.isFinite(job.total) || job.total <= 0) return null;
  const value = (job.received / job.total) * 100;
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function rowTexts(job: DownloadJob): {
  name: string;
  meta: string;
  pct: string;
  status: string;
  title: string;
  fillWidth: string;
  indeterminate: boolean;
} {
  const name = job.title || job.fileName || '未命名下载';
  const artist = job.artist || '未知歌手';
  const quality = qualityLabel(job.quality);
  const meta = quality ? `${artist} · ${quality}` : artist;
  let pct = '';
  let status = '';
  let fillWidth = '0%';
  let indeterminate = false;
  if (job.state === 'done') {
    pct = '100%';
    fillWidth = '100%';
    status = job.fileName ? `已保存 · ${job.fileName}` : '已保存到下载目录';
  } else if (job.state === 'error') {
    pct = '失败';
    fillWidth = '100%';
    status = `失败：${job.error || '未知错误'}`;
  } else {
    const progress = progressOf(job);
    const speed = speeds.get(job.id);
    const speedText = speed !== undefined && speed > 0 ? `${(speed / 1024 / 1024).toFixed(1)} MB/s` : '';
    if (progress === null) {
      pct = formatBytes(job.received);
      indeterminate = true;
      status = `正在下载${speedText ? ` · ${speedText}` : ''} · ${formatBytes(job.received)}`;
    } else {
      pct = `${Math.round(progress)}%`;
      fillWidth = `${progress.toFixed(1)}%`;
      const sizeText = `${formatBytes(job.received)}${job.total > 0 ? ` / ${formatBytes(job.total)}` : ''}`;
      status = `正在下载${speedText ? ` · ${speedText}` : ''} · ${sizeText}`;
    }
  }
  return { name, meta, pct, status, title: job.path || name, fillWidth, indeterminate };
}

function applyRow(handle: RowHandle, job: DownloadJob, key: string): void {
  const { refs } = handle;
  handle.el.dataset.jobId = job.id;
  handle.el.dataset.state = job.state;
  const texts = rowTexts(job);
  setText(refs.name, texts.name);
  setText(refs.meta, texts.meta);
  setText(refs.pct, texts.pct);
  setText(refs.status, texts.status);
  handle.el.title = texts.title;
  refs.fill.style.width = texts.fillWidth;
  refs.fill.classList.toggle('is-indeterminate', texts.indeterminate);
  refs.reveal.hidden = job.state !== 'done';
  refs.retry.hidden = job.state !== 'error';
  refs.actions.hidden = job.state === 'running';
  handle.key = key;
}

function createRow(): RowHandle {
  const name = h('div', { class: 'dlq-name' });
  const meta = h('div', { class: 'dlq-meta' });
  const pct = h('div', { class: 'dlq-pct' });
  const fill = h('div', { class: 'dlq-fill' });
  const status = h('div', { class: 'dlq-status' });
  const reveal = h(
    'button',
    { class: 'dlq-act dlq-reveal', type: 'button', title: '在文件夹中显示', 'aria-label': '在文件夹中显示' },
    icon('folder', 15),
  );
  const retry = h(
    'button',
    { class: 'dlq-act dlq-retry', type: 'button', title: '重新下载', 'aria-label': '重新下载' },
    icon('refresh', 15),
  );
  const actions = h('div', { class: 'dlq-actions' }, reveal, retry);
  const bar = h('div', { class: 'dlq-bar' }, fill);
  const cover = h('div', { class: 'dlq-cover', 'aria-hidden': 'true' }, icon('music', 13));
  const top = h(
    'div',
    { class: 'dlq-row-top' },
    cover,
    h('div', { class: 'dlq-text' }, name, meta),
    pct,
    actions,
  );
  const el = h('div', { class: 'dlq-row' }, top, bar, status);
  reveal.addEventListener('click', (event) => {
    event.stopPropagation();
    const job = findJob(el.dataset.jobId);
    if (job) void doReveal(job, reveal);
  });
  retry.addEventListener('click', (event) => {
    event.stopPropagation();
    const job = findJob(el.dataset.jobId);
    if (job) void doRetry(job, retry);
  });
  return {
    el,
    key: '',
    refs: { name, meta, pct, status, fill, reveal, retry, actions },
  };
}

async function doReveal(job: DownloadJob, button: HTMLButtonElement): Promise<void> {
  if (button.classList.contains('is-busy')) return;
  button.classList.add('is-busy');
  try {
    await revealDownload(job.id);
  } catch (error) {
    toast(`无法定位文件：${errorMessage(error)}`, 'error');
  } finally {
    window.setTimeout(() => button.classList.remove('is-busy'), 400);
  }
}

async function doRetry(job: DownloadJob, button: HTMLButtonElement): Promise<void> {
  if (job.state !== 'error' || button.classList.contains('is-busy')) return;
  button.classList.add('is-busy');
  const track: OnlineTrack = {
    source: job.source,
    id: job.trackId,
    title: job.title,
    artist: job.artist,
    album: '',
    durationMs: 0,
    cover: '',
    playable: true,
  };
  try {
    const result = await startDownload(track, asQuality(job.quality));
    if (disposed) return;
    applyList([result.job, ...jobs.filter((item) => item.id !== result.job.id)], result.directory);
    lastError = null;
    toast(`已重新加入下载队列：${job.title || '该歌曲'}`);
    notify();
    kick();
  } catch (error) {
    toast(`重试失败：${errorMessage(error)}`, 'error');
  } finally {
    button.classList.remove('is-busy');
  }
}

/* ---------- 可复用列表视图（浮层面板 / 快捷设置「下载」页共用） ---------- */

/** 可嵌入的下载队列视图：复用同一份队列状态与轮询，不复制业务逻辑。 */
export interface DownloadQueueView {
  readonly element: HTMLElement;
  /** 显示时调用：订阅状态刷新并立即取一次最新进度。 */
  activate(): void;
  /** 隐藏时调用：停止接收刷新（不再重绘，也不再因该视图触发轮询）。 */
  deactivate(): void;
  dispose(): void;
}

class DownloadQueueViewImpl implements DownloadQueueView {
  readonly element: HTMLElement;
  private readonly embedded: boolean;
  private readonly list: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private readonly dirPath: HTMLDivElement;
  private readonly tabs = new Map<DownloadFilter, HTMLButtonElement>();
  private readonly rows = new Map<string, RowHandle>();
  private readonly status: HTMLDivElement | null;
  private readonly refreshBtn: HTMLButtonElement | null;
  private enabled: boolean;
  private renderedFilter: DownloadFilter | null = null;
  private switchTimer = 0;

  constructor(embedded: boolean) {
    this.embedded = embedded;
    this.enabled = !embedded;

    const tabs = new Map<DownloadFilter, HTMLButtonElement>();
    // 统一走全局分段控件 .seg：白色滑块由 app.ts 的 enhanceSegs 自动注入，这里不手写滑块。
    const tabBar = h('div', { class: 'seg dlq-tabs', role: 'tablist' });
    for (const item of FILTERS) {
      const button = h(
        'button',
        { class: 'seg-btn dlq-tab', type: 'button', role: 'tab', 'aria-selected': 'false' },
        item.label,
      );
      button.addEventListener('click', () => this.selectFilter(item.key));
      tabs.set(item.key, button);
      tabBar.append(button);
    }
    this.tabs = tabs;

    this.list = h('div', { class: 'dlq-list' });
    this.empty = h('div', { class: 'dlq-empty' });
    this.dirPath = h('div', { class: 'dlq-dir-path' });
    const openDirBtn = h(
      'button',
      { class: 'dlq-foot-btn dlq-open-dir', type: 'button', title: '在资源管理器中打开下载目录' },
      icon('folder', 14),
      '打开目录',
    );
    openDirBtn.addEventListener('click', () => this.openDirectory());
    const foot = h('div', { class: 'dlq-foot' }, this.dirPath, openDirBtn);

    if (embedded) {
      // 快捷设置第 5 页：容器独立一层 .dlq-embed，内部仍沿用 .dlq-* 契约类名。
      this.status = h('div', { class: 'dlq-embed-status' });
      this.refreshBtn = h(
        'button',
        { class: 'dlq-embed-refresh', type: 'button', title: '刷新下载列表', 'aria-label': '刷新下载列表' },
        icon('refresh', 14),
      );
      this.refreshBtn.addEventListener('click', () => {
        void refresh().then(() => {
          if (!disposed) kick();
        });
      });
      const head = h(
        'div',
        { class: 'dlq-embed-head' },
        h('div', { class: 'dlq-embed-title', text: '下载队列' }),
        this.status,
        this.refreshBtn,
      );
      this.element = h(
        'div',
        { class: 'dlq-embed', 'data-qa': 'quick-downloads-page' },
        head,
        tabBar,
        this.list,
        this.empty,
        foot,
      );
    } else {
      this.status = null;
      this.refreshBtn = null;
      this.element = h('div', { class: 'dlq-view' }, tabBar, this.list, this.empty, foot);
    }
  }

  activate(): void {
    if (disposed) return;
    this.enabled = true;
    if (this.embedded) {
      embeddedViews.add(this);
    }
    this.render();
    kick();
  }

  deactivate(): void {
    embeddedViews.delete(this);
    if (this.embedded) this.enabled = false;
  }

  dispose(): void {
    this.deactivate();
    this.enabled = false;
    if (this.switchTimer) {
      window.clearTimeout(this.switchTimer);
      this.switchTimer = 0;
    }
    for (const [, handle] of this.rows) handle.el.remove();
    this.rows.clear();
    this.element.remove();
  }

  /** 只做字段级更新（tabs 状态 / 行 diff / 目录文案），不重建 DOM。 */
  render(): void {
    if (!this.enabled || disposed) return;
    this.syncTabs();
    this.syncRows();
    const dirText = directory || getSettings().downloads?.directory || '系统音乐目录（默认）';
    setText(this.dirPath, dirText);
    this.dirPath.title = dirText;
    if (this.status) {
      const { running, done, error } = countJobs();
      setText(this.status, `下载中 ${running} · 已完成 ${done}${error > 0 ? ` · 失败 ${error}` : ''}`);
    }
    if (this.refreshBtn) this.refreshBtn.classList.toggle('is-busy', refreshing);
    if (this.renderedFilter !== null && this.renderedFilter !== filter) this.playSwitch();
    this.renderedFilter = filter;
  }

  private selectFilter(key: DownloadFilter): void {
    if (filter === key) return;
    filter = key;
    notify();
  }

  private syncTabs(): void {
    for (const [key, button] of this.tabs) {
      const on = key === filter;
      // is-active 是 QA 套件既有契约；is-on 供全局 .seg 白色滑块定位。
      button.classList.toggle('is-active', on);
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  private syncRows(): void {
    const visible = visibleJobs();
    const seen = new Set<string>();
    let cursor: Node | null = this.list.firstChild;
    for (const job of visible) {
      seen.add(job.id);
      const key = rowKey(job);
      let handle = this.rows.get(job.id);
      if (!handle) {
        handle = createRow();
        this.rows.set(job.id, handle);
        applyRow(handle, job, key);
      } else if (handle.key !== key) {
        applyRow(handle, job, key);
      }
      if (cursor === handle.el) {
        cursor = handle.el.nextSibling;
      } else {
        this.list.insertBefore(handle.el, cursor);
      }
    }
    for (const [id, handle] of this.rows) {
      if (seen.has(id)) continue;
      handle.el.remove();
      this.rows.delete(id);
    }
    const empty = this.empty;
    empty.hidden = visible.length > 0;
    if (visible.length > 0) return;
    let text: string;
    if (!refreshedOnce) {
      text = lastError ? '下载列表暂不可用，稍后重试' : '正在读取下载列表…';
    } else if (filter === 'running') {
      text = '当前没有正在下载的任务';
    } else if (filter === 'done') {
      text = '还没有下载完成的歌曲';
    } else if (filter === 'error') {
      text = '没有失败的任务';
    } else {
      text = '暂时没有下载任务\n在搜索结果里点下载按钮，就会加入队列';
    }
    setText(empty, text);
  }

  /** tab 切换时给列表内容做一次淡入 + 上滑（行 24ms stagger）；行节点复用不受影响。 */
  private playSwitch(): void {
    const { list, empty } = this;
    list.classList.remove('is-switch');
    empty.classList.remove('is-switch');
    // 强制一次重排，保证连续切换时动画能重新播放。
    void list.offsetWidth;
    list.classList.add('is-switch');
    empty.classList.add('is-switch');
    if (this.switchTimer) window.clearTimeout(this.switchTimer);
    this.switchTimer = window.setTimeout(() => {
      this.switchTimer = 0;
      list.classList.remove('is-switch');
      empty.classList.remove('is-switch');
    }, 420);
  }

  private openDirectory(): void {
    const target = directory || getSettings().downloads?.directory || '';
    try {
      host.openDownloadFolder(target);
    } catch (err) {
      toast(`无法打开下载目录：${errorMessage(err)}`, 'error');
    }
  }
}

/** 创建可嵌入的下载队列视图（快捷设置「下载」页用）；dispose 时彻底移除节点。 */
export function createDownloadQueueView(): DownloadQueueView {
  return new DownloadQueueViewImpl(true);
}

/* ---------- 面板 ---------- */

function ensurePanel(): void {
  if (panel || disposed) return;
  const sumRunning = h('b', { text: '0' });
  const sumDone = h('b', { text: '0' });
  const sumError = h('b', { text: '0' });
  const summary = h(
    'div',
    { class: 'dlq-summary' },
    h('span', { class: 'dlq-sum-item', 'data-kind': 'running' }, '下载中 ', sumRunning),
    h('span', { class: 'dlq-sum-sep' }, '·'),
    h('span', { class: 'dlq-sum-item', 'data-kind': 'done' }, '已完成 ', sumDone),
    h('span', { class: 'dlq-sum-sep' }, '·'),
    h('span', { class: 'dlq-sum-item', 'data-kind': 'error' }, '失败 ', sumError),
  );
  const refreshBtn = h(
    'button',
    { class: 'dlq-icon-btn dlq-refresh', type: 'button', title: '刷新下载列表', 'aria-label': '刷新下载列表' },
    icon('refresh', 15),
  );
  const closeBtn = h(
    'button',
    { class: 'dlq-icon-btn dlq-close', type: 'button', title: '关闭下载面板（Esc）', 'aria-label': '关闭下载面板' },
    icon('close', 15),
  );
  const head = h(
    'div',
    { class: 'dlq-head' },
    h('div', { class: 'dlq-title', text: '下载队列' }),
    h('div', { class: 'dlq-head-actions' }, refreshBtn, closeBtn),
  );
  const error = h('div', { class: 'dlq-error' });
  error.hidden = true;
  const view = new DownloadQueueViewImpl(false);
  const hint = h('div', {
    class: 'dlq-hint',
    text: '宿主暂不支持取消或清空任务；已完成的记录保留在本次宿主会话中。',
  });
  const root = h(
    'aside',
    { class: 'dlq-panel', role: 'dialog', 'aria-label': '下载队列', 'aria-hidden': 'true', 'data-qa': 'download-panel' },
    head,
    summary,
    error,
    view.element,
    hint,
  );
  document.body.append(root);
  panel = { root, error, refreshBtn, sumRunning, sumDone, sumError, view };
  bindDocument();

  refreshBtn.addEventListener('click', () => {
    void refresh().then(() => {
      if (!disposed) kick();
    });
  });
  closeBtn.addEventListener('click', () => closeDownloadPanel());

  syncPanel();
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!panelOpen) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (panel?.root.contains(target)) return;
  if (entryBtn?.contains(target)) return;
  closeDownloadPanel();
}

function onVisibilityChange(): void {
  if (disposed) return;
  if (document.hidden) return;
  if (shouldPoll()) kick();
}

function bindDocument(): void {
  if (documentBound) return;
  documentBound = true;
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function unbindDocument(): void {
  if (!documentBound) return;
  documentBound = false;
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('visibilitychange', onVisibilityChange);
}

/* ---------- 轮询 ---------- */

function shouldPoll(): boolean {
  return panelOpen || embeddedViews.size > 0 || countJobs().running > 0 || pendingStarts > 0;
}

function pollDelay(): number {
  if (document.hidden) return POLL_HIDDEN_MS;
  if (pendingStarts > 0) return POLL_PENDING_MS;
  if (countJobs().running > 0) return POLL_RUNNING_MS;
  return POLL_IDLE_MS;
}

function schedule(delay: number): void {
  if (disposed) return;
  if (pollTimer) window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => {
    pollTimer = 0;
    void tick();
  }, delay);
}

function kick(): void {
  if (disposed) return;
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = 0;
  }
  void tick();
}

async function tick(): Promise<void> {
  if (disposed) return;
  try {
    await refresh();
    if (disposed) return;
    if (shouldPoll()) schedule(pollDelay());
  } catch (error) {
    // 兜底：任何未预期异常都不允许变成 unhandled rejection。
    console.warn('[downloadQueue] tick failed', error);
    if (!disposed) schedule(POLL_IDLE_MS);
  }
}

async function refresh(): Promise<void> {
  if (disposed) return;
  if (inflight) return inflight;
  const gen = generation;
  refreshing = true;
  notify();
  const task = (async () => {
    try {
      const list = await fetchDownloads();
      if (disposed || gen !== generation) return;
      applyList(list.jobs, list.directory);
      lastError = null;
    } catch (error) {
      if (disposed || gen !== generation) return;
      lastError = errorMessage(error);
    } finally {
      if (gen === generation) {
        refreshing = false;
        inflight = null;
      }
      if (!disposed && gen === generation) notify();
    }
  })();
  inflight = task;
  return task;
}

function applyList(nextJobs: DownloadJob[], nextDirectory?: string): void {
  const previous = new Map(jobs.map((job) => [job.id, job]));
  jobs = Array.isArray(nextJobs) ? nextJobs.slice() : [];
  if (typeof nextDirectory === 'string' && nextDirectory) directory = nextDirectory;
  updateSpeeds();
  updatedAt = Date.now();
  refreshedOnce = true;
  // 队列可见（浮层或快捷设置「下载」页）时看行状态即可，不再弹完成/失败 toast。
  if (!panelOpen && embeddedViews.size === 0) notifyFinishedTransitions(previous);
}

/** 用相邻两次快照的 received 差 / 时间差估算速度；非 running 任务立刻清掉采样。 */
function updateSpeeds(): void {
  const now = Date.now();
  const alive = new Set<string>();
  for (const job of jobs) {
    if (job.state !== 'running') {
      speeds.delete(job.id);
      speedSamples.delete(job.id);
      continue;
    }
    alive.add(job.id);
    const previous = speedSamples.get(job.id);
    if (!previous) {
      speedSamples.set(job.id, { received: job.received, at: now });
      continue;
    }
    const elapsed = (now - previous.at) / 1000;
    if (elapsed < 0.2) continue; // 同一次请求周期内的抖动忽略
    const delta = job.received - previous.received;
    if (delta >= 0) speeds.set(job.id, delta / elapsed);
    else speeds.delete(job.id);
    speedSamples.set(job.id, { received: job.received, at: now });
  }
  for (const id of Array.from(speeds.keys())) {
    if (!alive.has(id)) speeds.delete(id);
  }
}

function notifyFinishedTransitions(previous: Map<string, DownloadJob>): void {
  const dir = directory || getSettings().downloads?.directory || '';
  for (const job of jobs) {
    const before = previous.get(job.id);
    if (!before || before.state === job.state) continue;
    if (job.state === 'done') {
      toast(`已下载：${job.title || job.fileName || '歌曲'}${dir ? ` → ${dir}` : ''}`);
    } else if (job.state === 'error') {
      toast(`下载失败：${job.title || job.fileName || '歌曲'}${job.error ? `（${job.error}）` : ''}`, 'error');
    }
  }
}

/* ---------- 对外 API ---------- */

/** 把一首在线歌曲加入下载队列（所有 startDownload 调用点都应走这里）。 */
export async function beginQueueDownload(track: OnlineTrack, quality?: StreamQuality): Promise<boolean> {
  if (disposed) return false;
  if (!track || track.source === 'local') {
    toast('本地歌曲不需要下载');
    return false;
  }
  const key = trackKey(track.source, track.id);
  if (
    pendingKeys.has(key) ||
    jobs.some((job) => job.state === 'running' && job.source === track.source && job.trackId === track.id)
  ) {
    toast('这首歌已在下载队列中');
    return false;
  }
  const resolved = quality ?? getSettings().downloads?.quality ?? 'high';
  const label = qualityLabel(resolved);
  pendingKeys.add(key);
  pendingStarts += 1;
  try {
    const result = await startDownload(track, resolved);
    if (disposed) return true;
    applyList([result.job, ...jobs.filter((item) => item.id !== result.job.id)], result.directory);
    lastError = null;
    toast(`已加入下载队列：${track.title}（${label}）`);
    // 有可见的队列视图（浮层 / 快捷设置「下载」页）就不再抢焦点；都不可见时展开浮层。
    if (!panelOpen && embeddedViews.size === 0) openDownloadPanel();
    notify();
    kick();
    return true;
  } catch (error) {
    toast(`下载失败：${errorMessage(error)}`, 'error');
    return false;
  } finally {
    pendingKeys.delete(key);
    pendingStarts = Math.max(0, pendingStarts - 1);
    if (!disposed) notify();
  }
}

/** 由 app 在播放条里创建入口按钮，返回同一个实例。 */
export function createDownloadEntryButton(): HTMLButtonElement {
  if (entryBtn) return entryBtn;
  const badge = h('span', { class: 'dlq-badge', 'aria-hidden': 'true' });
  badge.hidden = true;
  const button = h(
    'button',
    {
      class: 'pb-btn pb-download',
      type: 'button',
      title: '下载队列',
      'data-qa': 'download-entry',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
    },
    icon('download', 17),
    badge,
  );
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    lastPointerToggleAt = Date.now();
    toggleDownloadPanel();
  });
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    // pointerdown 已经处理过本次点击，避免播放条展开时二次触发。
    if (Date.now() - lastPointerToggleAt < 500) return;
    toggleDownloadPanel();
  });
  entryBtn = button;
  entryBadge = badge;
  syncEntry();
  return button;
}

export function isDownloadPanelOpen(): boolean {
  return panelOpen;
}

export function openDownloadPanel(): void {
  if (disposed) return;
  ensurePanel();
  if (panelOpen) {
    kick();
    return;
  }
  panelOpen = true;
  notify();
  kick();
}

export function closeDownloadPanel(): void {
  if (!panelOpen) return;
  panelOpen = false;
  notify();
  if (!shouldPoll() && pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = 0;
  }
}

export function toggleDownloadPanel(force?: boolean): void {
  if (disposed) return;
  const next = typeof force === 'boolean' ? force : !panelOpen;
  if (next === panelOpen) {
    if (next) kick();
    return;
  }
  if (next) openDownloadPanel();
  else closeDownloadPanel();
}

export function downloadQueueState(): DownloadQueueSnapshot {
  const { running, done, error } = countJobs();
  return {
    jobs: jobs.slice(),
    directory,
    running,
    done,
    error,
    filter,
    panelOpen,
    refreshing,
    lastError,
    updatedAt,
  };
}

/** 订阅下载队列变化；返回取消订阅函数。 */
export function onDownloadQueueChange(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** app.mount() 时初始化：接管宿主已有的下载任务并启动轮询。 */
export function initDownloadQueue(): void {
  if (initialized) return;
  initialized = true;
  disposed = false;
  bindDocument();
  // 面板预先挂到 body（默认隐藏、加 is-open 才展开），方便自动化/回归脚本随时查询。
  ensurePanel();
  (window as DebugWindow).__zilux2DownloadQueue = {
    state: downloadQueueState,
    toggle: toggleDownloadPanel,
    open: openDownloadPanel,
    close: closeDownloadPanel,
    refresh: () => refresh(),
  };
  notify();
  kick();
}

/** app.destroy() 时清理：停轮询、移除面板与监听（面板是单例，可重复初始化）。 */
export function disposeDownloadQueue(): void {
  disposed = true;
  initialized = false;
  generation += 1;
  inflight = null;
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = 0;
  }
  unbindDocument();
  // 先销毁所有可见视图（快捷设置页 + 浮层面板内部视图），再移除浮层外壳。
  for (const view of Array.from(embeddedViews)) view.dispose();
  embeddedViews.clear();
  if (panel) {
    panel.view.dispose();
    panel.root.remove();
    panel = null;
  }
  entryBtn = null;
  entryBadge = null;
  listeners.clear();
  jobs = [];
  directory = '';
  filter = 'all';
  panelOpen = false;
  refreshing = false;
  refreshedOnce = false;
  lastError = null;
  updatedAt = 0;
  pendingStarts = 0;
  pendingKeys.clear();
  speeds.clear();
  speedSamples.clear();
  delete (window as DebugWindow).__zilux2DownloadQueue;
}
