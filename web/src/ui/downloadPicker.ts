/// <reference types="vite/client" />
/**
 * 下载相关浮层（音质选择 + 播放条下载菜单）。
 *
 * 1) 音质选择：所有「下载」入口统一从 app.beginDownload() 进来，先在这里选一次音质
 *    （标准 / 高品质 / 无损），选中后才真正入队。默认值取设置里的下载音质，
 *    但本轮选择只对这一次生效 —— 不回写设置。
 * 2) 播放条下载菜单：播放条上的下载按钮先弹这个小菜单，提供「下载当前歌曲」
 *    （继续走音质选择）与「打开下载队列」两个动作。
 *
 * 两种浮层共用同一套定位/关闭/键盘逻辑，锚定在触发按钮附近（下方优先、放不下翻到上方），
 * 点浮层外 / Esc / 再点按钮都能关闭；键盘可达：↑↓ 在选项间移动、Enter 选定、Tab 在浮层内循环、Esc 取消。
 */
import '../styles/download-picker.css';
import type { StreamQuality } from '../online/types';
import { h, icon } from './dom';

export interface QualityPickerOptions {
  /** 触发按钮；用于定位与关闭后恢复焦点，可为空（此时浮层居中靠下） */
  anchor: HTMLElement | null;
  /** 歌曲标题 / 歌手，仅用于展示 */
  title: string;
  artist: string;
  /** 设置里的下载音质，作为默认选中项 */
  defaultQuality: StreamQuality;
  /** 用户选定后回调；不选（取消）时不会回调 */
  onPick: (quality: StreamQuality) => void;
}

export interface DownloadMenuTrack {
  title: string;
  artist: string;
  /** 本地歌曲不需要下载，菜单里会置灰 */
  local: boolean;
}

export interface DownloadMenuOptions {
  /** 触发按钮（播放条下载按钮），用于定位与关闭后恢复焦点 */
  anchor: HTMLElement | null;
  /** 当前播放歌曲；没有歌曲时传 null */
  track: DownloadMenuTrack | null;
  /** 选择「下载当前歌曲」后回调（app 里继续弹音质选择） */
  onDownloadTrack: () => void;
  /** 选择「打开下载队列」后回调 */
  onOpenQueue: () => void;
}

interface QualityItem {
  value: StreamQuality;
  label: string;
  note: string;
}

const QUALITY_ITEMS: QualityItem[] = [
  { value: 'standard', label: '标准', note: '128k，体积小、下载快' },
  { value: 'high', label: '高品质', note: '320k，推荐日常使用' },
  { value: 'lossless', label: '无损', note: 'FLAC，体积较大' },
];

const VIEWPORT_MARGIN = 10;
const ANCHOR_GAP = 8;

let overlay: HTMLDivElement | null = null;
let panel: HTMLDivElement | null = null;
let previousFocus: HTMLElement | null = null;
let currentAnchor: HTMLElement | null = null;
let closePicker: (() => void) | null = null;

function qualityItemOf(value: StreamQuality): QualityItem {
  return QUALITY_ITEMS.find((item) => item.value === value) ?? QUALITY_ITEMS[1];
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/** 把浮层摆在触发按钮旁边：优先下方，空间不够翻到上方，并夹在视口内。 */
function placePanel(): void {
  const root = panel;
  if (!root) return;
  const width = root.offsetWidth;
  const height = root.offsetHeight;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  if (!currentAnchor || !currentAnchor.isConnected) {
    root.dataset.side = 'bottom';
    root.style.left = `${Math.round((viewportW - width) / 2)}px`;
    root.style.top = `${Math.round(Math.max(viewportH - height - 96, VIEWPORT_MARGIN))}px`;
    return;
  }

  const anchorRect = currentAnchor.getBoundingClientRect();
  let left = anchorRect.left + anchorRect.width / 2 - width / 2;
  left = clamp(left, VIEWPORT_MARGIN, viewportW - width - VIEWPORT_MARGIN);
  let top = anchorRect.bottom + ANCHOR_GAP;
  let side: 'top' | 'bottom' = 'bottom';
  if (top + height > viewportH - VIEWPORT_MARGIN) {
    const above = anchorRect.top - ANCHOR_GAP - height;
    if (above >= VIEWPORT_MARGIN) {
      top = above;
      side = 'top';
    } else {
      top = Math.max(VIEWPORT_MARGIN, viewportH - height - VIEWPORT_MARGIN);
    }
  }
  root.dataset.side = side;
  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;
}

function close(): void {
  const root = overlay;
  if (!root) return;
  overlay = null;
  panel = null;
  closePicker = null;
  currentAnchor = null;
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('resize', placePanel);
  window.removeEventListener('scroll', close, true);
  // 先播退场动画再移除节点（120ms），避免浮层「啪」地消失。
  root.classList.remove('is-open');
  root.classList.add('is-closing');
  window.setTimeout(() => root.remove(), 170);
  const focusTarget = previousFocus;
  previousFocus = null;
  if (focusTarget && focusTarget.isConnected) focusTarget.focus({ preventScroll: true });
}

function isActionable(element: Element): boolean {
  return element.classList.contains('dlqp-option') || element.classList.contains('dlqm-item');
}

function onKeyDown(event: KeyboardEvent): void {
  if (!overlay) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key === 'Tab') {
    cycleFocus(event);
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    const active = document.activeElement;
    if (active instanceof HTMLElement && overlay.contains(active) && isActionable(active)) {
      event.preventDefault();
      event.stopPropagation();
      active.click();
    }
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    moveFocus(event.key === 'ArrowDown' ? 1 : -1);
  }
}

function focusableItems(): HTMLElement[] {
  if (!panel) return [];
  return Array.from(
    panel.querySelectorAll<HTMLElement>('.dlqp-option, .dlqm-item, .dlqp-cancel'),
  ).filter((item) => !(item instanceof HTMLButtonElement && item.disabled));
}

function moveFocus(direction: number): void {
  const items = focusableItems();
  if (items.length === 0) return;
  const active = document.activeElement;
  const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
  const next = index < 0 ? (direction > 0 ? 0 : items.length - 1) : (index + direction + items.length) % items.length;
  items[next]?.focus({ preventScroll: true });
}

function cycleFocus(event: KeyboardEvent): void {
  const items = focusableItems();
  if (items.length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  moveFocus(event.shiftKey ? -1 : 1);
}

/** 共用的浮层骨架：清掉上一次浮层、定位、入场动画、关闭监听。 */
function openPopover(root: HTMLDivElement, anchor: HTMLElement | null): void {
  closePicker?.();
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  currentAnchor = anchor && anchor.isConnected ? anchor : null;

  panel = root;
  const layer = h('div', { class: 'dlqp-overlay' }, root);
  layer.addEventListener('pointerdown', (event) => {
    // 点在浮层外（overlay 自身）即关闭；面板内的点击不处理。
    if (event.target === layer) {
      event.preventDefault();
      close();
    }
  });
  overlay = layer;
  closePicker = close;
  document.body.append(layer);

  // 先摆位置再播入场动画，避免从 (0,0) 飞过来。
  placePanel();
  window.requestAnimationFrame(() => {
    if (overlay) overlay.classList.add('is-open');
  });

  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', placePanel);
  window.addEventListener('scroll', close, true);
}

function buildQualityPanel(options: QualityPickerOptions): HTMLDivElement {
  const selected = qualityItemOf(options.defaultQuality);
  const title = h('div', { class: 'dlqp-title', text: '选择下载音质' });
  const track = h(
    'div',
    { class: 'dlqp-track', title: `${options.title} — ${options.artist}` },
    h('span', { class: 'dlqp-track-name', text: options.title || '未命名歌曲' }),
    h('span', { class: 'dlqp-track-artist', text: options.artist ? ` · ${options.artist}` : '' }),
  );

  const clearChecked = (): void => {
    for (const button of panel?.querySelectorAll<HTMLButtonElement>('.dlqp-option') ?? []) {
      button.setAttribute('aria-checked', 'false');
      button.classList.remove('is-checked');
    }
  };

  const list = h('div', { class: 'dlqp-options', role: 'radiogroup', 'aria-label': '下载音质' });
  const optionButtons: HTMLButtonElement[] = [];
  for (const item of QUALITY_ITEMS) {
    const checked = item.value === selected.value;
    const check = h('span', { class: 'dlqp-check', 'aria-hidden': 'true', text: checked ? '✓' : '' });
    const button = h(
      'button',
      {
        class: `dlqp-option${checked ? ' is-checked' : ''}`,
        type: 'button',
        role: 'radio',
        'aria-checked': checked ? 'true' : 'false',
        'data-quality': item.value,
      },
      h('span', { class: 'dlqp-option-label', text: item.label }),
      h('span', { class: 'dlqp-option-note', text: item.note }),
      item.value === selected.value ? h('span', { class: 'dlqp-option-default', text: '默认' }) : null,
      check,
    );
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      clearChecked();
      button.setAttribute('aria-checked', 'true');
      button.classList.add('is-checked');
      const checkMark = button.querySelector('.dlqp-check');
      if (checkMark) checkMark.textContent = '✓';
      close();
      options.onPick(item.value);
    });
    optionButtons.push(button);
    list.append(button);
  }

  const cancel = h('button', { class: 'dlqp-cancel', type: 'button' }, '取消');
  cancel.addEventListener('click', (event) => {
    event.stopPropagation();
    close();
  });

  const hint = h('div', {
    class: 'dlqp-hint',
    text: '仅对本次下载生效，不会修改设置里的默认音质。',
  });

  const root = h(
    'div',
    {
      class: 'dlqp-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '选择下载音质',
      'data-qa': 'download-picker',
    },
    h(
      'div',
      { class: 'dlqp-head' },
      h('div', { class: 'dlqp-head-icon', 'aria-hidden': 'true' }, icon('download', 15)),
      title,
    ),
    track,
    list,
    hint,
    cancel,
  );
  // 记住默认项，供打开后聚焦
  const defaultIndex = QUALITY_ITEMS.findIndex((item) => item.value === selected.value);
  const defaultButton = optionButtons[defaultIndex] ?? optionButtons[0];
  root.dataset.defaultIndex = String(Math.max(defaultIndex, 0));
  if (defaultButton) defaultButton.dataset.default = 'true';
  return root;
}

/** 播放条下载按钮的小菜单：下载当前歌曲（继续选音质）/ 打开下载队列。 */
function buildDownloadMenu(options: DownloadMenuOptions): HTMLDivElement {
  const track = options.track;
  const downloadable = !!track && !track.local;

  const trackLine = h(
    'div',
    { class: 'dlqp-track', title: track ? `${track.title} — ${track.artist}` : '' },
    track
      ? h('span', { class: 'dlqp-track-name', text: track.title || '未命名歌曲' })
      : h('span', { class: 'dlqp-track-name', text: '当前没有播放歌曲' }),
    track && track.artist ? h('span', { class: 'dlqp-track-artist', text: ` · ${track.artist}` }) : null,
  );

  const currentNote = track
    ? track.local
      ? '本地歌曲无需下载'
      : '选择音质后下载「' + track.title + '」'
    : '当前没有正在播放的歌曲';
  const downloadItem = h(
    'button',
    {
      class: `dlqp-option dlqm-item${downloadable ? '' : ' is-disabled'}`,
      type: 'button',
      role: 'menuitem',
      'data-action': 'download-current',
      'aria-disabled': downloadable ? 'false' : 'true',
      ...(downloadable ? {} : { disabled: 'true' }),
    },
    h('span', { class: 'dlqm-icon', 'aria-hidden': 'true' }, icon('download', 15)),
    h('span', { class: 'dlqp-option-label', text: '下载当前歌曲' }),
    h('span', { class: 'dlqp-option-note', text: currentNote }),
  );
  downloadItem.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!downloadable) return;
    close();
    options.onDownloadTrack();
  });

  const queueItem = h(
    'button',
    {
      class: 'dlqp-option dlqm-item',
      type: 'button',
      role: 'menuitem',
      'data-action': 'open-queue',
    },
    h('span', { class: 'dlqm-icon', 'aria-hidden': 'true' }, icon('list', 15)),
    h('span', { class: 'dlqp-option-label', text: '打开下载队列' }),
    h('span', { class: 'dlqp-option-note', text: '查看下载进度与已完成文件' }),
  );
  queueItem.addEventListener('click', (event) => {
    event.stopPropagation();
    close();
    options.onOpenQueue();
  });

  const hint = h('div', {
    class: 'dlqp-hint',
    text: '「下载当前歌曲」会先选音质（仅本次生效）；下载中可随时打开队列查看进度。',
  });

  return h(
    'div',
    {
      class: 'dlqp-panel dlqm-panel',
      role: 'menu',
      'aria-label': '下载',
      'data-qa': 'download-menu',
    },
    h(
      'div',
      { class: 'dlqp-head' },
      h('div', { class: 'dlqp-head-icon', 'aria-hidden': 'true' }, icon('download', 15)),
      h('div', { class: 'dlqp-title', text: '下载' }),
    ),
    trackLine,
    h('div', { class: 'dlqm-items' }, downloadItem, queueItem),
    hint,
  );
}

/** 打开音质选择浮层；同一时间只存在一个（再次调用会先关旧的）。 */
export function openQualityPicker(options: QualityPickerOptions): void {
  const root = buildQualityPanel(options);
  openPopover(root, options.anchor);
  const focusIndex = Number(root.dataset.defaultIndex ?? '0');
  const focusTarget = root.querySelectorAll<HTMLButtonElement>('.dlqp-option')[focusIndex];
  (focusTarget ?? root.querySelector<HTMLButtonElement>('.dlqp-option'))?.focus({ preventScroll: true });
}

/** 打开播放条下载菜单；同一时间只存在一个（再次调用会先关旧的）。 */
export function openDownloadMenu(options: DownloadMenuOptions): void {
  const root = buildDownloadMenu(options);
  openPopover(root, options.anchor);
  const first = root.querySelector<HTMLButtonElement>('.dlqm-item:not(.is-disabled)');
  first?.focus({ preventScroll: true });
}

/** 关闭下载浮层（音质选择或菜单；不触发 onPick）；app.destroy() 时调用避免残留浮层。 */
export function closeQualityPicker(): void {
  closePicker?.();
}
