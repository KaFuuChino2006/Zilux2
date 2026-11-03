import { h } from './dom';

/**
 * 歌曲右键菜单（全局单例）。
 *
 * 用法：`openTrackMenu({ x, y, items: [...] })`。菜单挂在 body 上，
 * 点击外部、按 Esc、滚动或窗口缩放都会关闭；同一时间只会存在一个菜单。
 * 这里只负责渲染与交互，具体动作由调用方传入。
 */

export interface TrackMenuItem {
  /** 菜单文字。 */
  label: string;
  /** 右侧浅色说明（可选），例如「下一首播放」。 */
  hint?: string;
  /** 危险操作（红色）。 */
  danger?: boolean;
  /** 置灰不可点。 */
  disabled?: boolean;
  /** 点击后的动作；返回后菜单自动关闭。 */
  run: () => void;
}

export interface TrackMenuOptions {
  x: number;
  y: number;
  items: TrackMenuItem[];
}

const EDGE = 10;
const GAP = 6;

let menu: HTMLDivElement | null = null;
let cleanup: (() => void) | null = null;

function closeTrackMenu(): void {
  if (!menu) return;
  menu.remove();
  menu = null;
  cleanup?.();
  cleanup = null;
}

function placeMenu(element: HTMLDivElement, x: number, y: number): void {
  element.style.left = '0px';
  element.style.top = '0px';
  const rect = element.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - EDGE;
  const maxY = window.innerHeight - rect.height - EDGE;
  const left = Math.max(EDGE, Math.min(x, maxX));
  let top = y;
  // 光标下方放不下就翻到上方（和系统菜单一致）。
  if (top + rect.height + EDGE > window.innerHeight) top = Math.max(EDGE, y - rect.height - GAP);
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(Math.max(EDGE, Math.min(top, maxY)))}px`;
}

export function openTrackMenu(options: TrackMenuOptions): void {
  closeTrackMenu();
  if (options.items.length === 0) return;

  const buttons: HTMLButtonElement[] = [];
  const element = h('div', { class: 'track-menu', role: 'menu' });
  for (const item of options.items) {
    const button = h(
      'button',
      {
        class: `track-menu-item${item.danger ? ' is-danger' : ''}`,
        type: 'button',
        role: 'menuitem',
        disabled: item.disabled ?? false,
      },
      h('span', { class: 'track-menu-label', text: item.label }),
      item.hint ? h('span', { class: 'track-menu-hint', text: item.hint }) : null,
    );
    if (!item.disabled) {
      button.addEventListener('click', () => {
        const run = item.run;
        closeTrackMenu();
        run();
      });
    }
    buttons.push(button);
    element.append(button);
  }
  element.append(h('div', { class: 'track-menu-hintbar', text: 'Esc 关闭 · ↑↓ 选择' }));

  document.body.append(element);
  placeMenu(element, options.x, options.y);
  menu = element;

  const focusAt = (index: number): void => {
    const enabled = buttons.filter((button) => !button.disabled);
    if (enabled.length === 0) return;
    const target = enabled[((index % enabled.length) + enabled.length) % enabled.length];
    target?.focus();
  };
  focusAt(0);

  element.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const enabled = buttons.filter((button) => !button.disabled);
      const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
      focusAt(current + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      closeTrackMenu();
    }
  });

  const onPointerDown = (event: PointerEvent): void => {
    if (!menu) return;
    if (event.target instanceof Node && menu.contains(event.target)) return;
    closeTrackMenu();
  };
  const onBlur = (): void => closeTrackMenu();
  const onScroll = (): void => closeTrackMenu();
  // capture：页面里其它 pointerdown 处理拦不住关闭。
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', closeTrackMenu);
  window.addEventListener('scroll', onScroll, true);
  cleanup = () => {
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', closeTrackMenu);
    window.removeEventListener('scroll', onScroll, true);
  };
}

export function closeTrackMenuIfOpen(): void {
  closeTrackMenu();
}
