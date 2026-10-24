/// <reference types="vite/client" />
/**
 * 下载音质选择浮层。
 *
 * 所有「下载」入口统一从 app.beginDownload() 进来，先在这里选一次音质（标准 / 高品质 / 无损），
 * 选中后才真正入队。默认值取设置里的下载音质，但本轮选择只对这一次生效 —— 不回写设置。
 *
 * 浮层锚定在触发按钮附近（下方优先、放不下翻到上方），点浮层外 / Esc / 再点按钮都能关闭；
 * 键盘可达：↑↓ 在选项间移动、Enter 选定、Tab 在浮层内循环、Esc 取消。
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
  root.remove();
  const focusTarget = previousFocus;
  previousFocus = null;
  if (focusTarget && focusTarget.isConnected) focusTarget.focus({ preventScroll: true });
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
    if (active instanceof HTMLElement && overlay.contains(active) && active.classList.contains('dlqp-option')) {
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
  return Array.from(panel.querySelectorAll<HTMLElement>('.dlqp-option, .dlqp-cancel'));
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

function buildPanel(options: QualityPickerOptions): HTMLDivElement {
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

/** 打开音质选择浮层；同一时间只存在一个（再次调用会先关旧的）。 */
export function openQualityPicker(options: QualityPickerOptions): void {
  closePicker?.();
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  currentAnchor = options.anchor && options.anchor.isConnected ? options.anchor : null;

  const root = buildPanel(options);
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

  const focusIndex = Number(root.dataset.defaultIndex ?? '0');
  const focusTarget = root.querySelectorAll<HTMLButtonElement>('.dlqp-option')[focusIndex];
  (focusTarget ?? root.querySelector<HTMLButtonElement>('.dlqp-option'))?.focus({ preventScroll: true });
}

/** 关闭音质浮层（不触发 onPick）；app.destroy() 时调用避免残留浮层。 */
export function closeQualityPicker(): void {
  closePicker?.();
}
