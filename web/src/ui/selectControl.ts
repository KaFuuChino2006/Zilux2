/**
 * 自绘下拉选择器。
 *
 * 原生 <select> 的弹层由 Chromium 自己画（灰底选中行、系统字体），没法跟软件主题统一；
 * 这里用「按钮 + 挂到 body 的浮层」重做一遍，样式全部走 app.css 的 --ui-select-- 变量。
 *
 * 浮层挂到 body 而不是按钮旁边：壁纸抽屉、设置面板都是 overflow 滚动容器，
 * 挂在里面会被裁掉。
 */
import { h, icon } from './dom';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectControlOptions {
  options: SelectOption[];
  value?: string;
  onChange: (value: string) => void;
  /** 触发器额外 class（wp-select / set-select 等）。 */
  className?: string;
  title?: string;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  /** 浮层最小宽度，默认 168。 */
  menuWidth?: number;
}

export interface SelectControl {
  root: HTMLButtonElement;
  getValue(): string;
  setValue(value: string): void;
  setOptions(options: SelectOption[], value?: string): void;
  setDisabled(disabled: boolean): void;
  setInvalid(invalid: boolean): void;
}

/** 同一时间只允许一个下拉浮层；开新的先把旧的收掉。 */
let activeClose: (() => void) | null = null;

export function createSelectControl(options: SelectControlOptions): SelectControl {
  let items = options.options.slice();
  let value = options.value ?? items[0]?.value ?? '';
  // 初始值不在选项里（历史数据/字段还没值）时退回第一项，和原生 <select> 的表现一致。
  if (items.length > 0 && !items.some((item) => item.value === value)) value = items[0].value;
  let disabled = options.disabled === true;

  const labelEl = h('span', { class: 'ui-select-label' });
  const caret = h('span', { class: 'ui-select-caret' }, icon('chevron', 15));
  const root = h(
    'button',
    {
      class: `ui-select${options.className ? ` ${options.className}` : ''}`,
      type: 'button',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-label': options.ariaLabel ?? options.title ?? '选择',
    },
    labelEl,
    caret,
  ) as HTMLButtonElement;
  if (options.title) root.title = options.title;

  let menu: HTMLElement | null = null;

  const paint = (): void => {
    const found = items.find((item) => item.value === value);
    labelEl.textContent = found?.label ?? options.placeholder ?? '请选择';
    root.classList.toggle('is-empty', !found);
    root.disabled = disabled;
  };

  const onOutside = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (!target) return;
    if (menu?.contains(target) || root.contains(target)) return;
    close();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
    root.focus();
  };

  /**
   * 滚动/改窗口大小时只跟随锚点，不关闭。
   * 壁纸网格会自己滚动（懒加载），一关菜单就选不了了。
   */
  const onViewportChange = (): void => {
    if (!menu) return;
    const host = root.getBoundingClientRect();
    if (host.bottom < 0 || host.top > window.innerHeight) {
      close();
      return;
    }
    position();
  };

  function close(): void {
    if (!menu) return;
    menu.remove();
    menu = null;
    if (activeClose === close) activeClose = null;
    root.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('scroll', onViewportChange, true);
  }

  const choose = (next: string): void => {
    if (next === value) {
      close();
      return;
    }
    value = next;
    paint();
    close();
    root.focus();
    options.onChange(next);
  };

  const position = (): void => {
    if (!menu) return;
    const host = root.getBoundingClientRect();
    const width = Math.max(host.width, options.menuWidth ?? 168);
    menu.style.width = `${Math.round(width)}px`;
    const height = menu.offsetHeight;
    let left = host.left;
    left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
    let top = host.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, host.top - height - 6);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.visibility = 'visible';
  };

  const open = (): void => {
    if (disabled || menu) return;
    activeClose?.();
    activeClose = close;
    const list = h('div', { class: 'ui-menu-list', role: 'listbox' });
    for (const item of items) {
      const isOn = item.value === value;
      const row = h(
        'button',
        {
          class: `ui-menu-item${isOn ? ' is-on' : ''}`,
          type: 'button',
          role: 'option',
          'aria-selected': isOn ? 'true' : 'false',
        },
        h('span', { class: 'ui-menu-label', text: item.label }),
        h('span', { class: 'ui-menu-check', text: isOn ? '✓' : '' }),
      ) as HTMLButtonElement;
      if (item.disabled) row.disabled = true;
      row.addEventListener('click', () => choose(item.value));
      list.append(row);
    }
    list.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const rows = [...list.querySelectorAll<HTMLButtonElement>('.ui-menu-item:not(:disabled)')];
      const index = rows.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
      rows[(next + rows.length) % rows.length]?.focus();
    });

    menu = h('div', { class: 'ui-menu' }, list);
    menu.style.visibility = 'hidden';
    document.body.append(menu);
    root.setAttribute('aria-expanded', 'true');
    position();
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    const current = list.querySelector<HTMLButtonElement>('.ui-menu-item.is-on')
      ?? list.querySelector<HTMLButtonElement>('.ui-menu-item:not(:disabled)');
    current?.focus();
  };

  root.addEventListener('click', () => (menu ? close() : open()));
  root.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
    }
  });

  paint();

  return {
    root,
    getValue: () => value,
    setValue: (next: string) => {
      value = next;
      paint();
    },
    setOptions: (next: SelectOption[], nextValue?: string) => {
      items = next.slice();
      if (nextValue !== undefined) value = nextValue;
      if (items.length > 0 && !items.some((item) => item.value === value)) value = items[0].value;
      else if (items.length === 0) value = '';
      paint();
      close();
    },
    setDisabled: (next: boolean) => {
      disabled = next;
      paint();
      if (next) close();
    },
    setInvalid: (next: boolean) => root.classList.toggle('is-invalid', next),
  };
}
