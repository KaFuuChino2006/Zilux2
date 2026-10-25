/** 极简 DOM 工具 + 图标 + 提示条（新前端共用）。 */

export type Child = Node | string | number | null | undefined | false;

interface Props {
  class?: string;
  html?: string;
  text?: string;
  title?: string;
  type?: string;
  style?: string;
  [key: string]: string | number | boolean | undefined;
}

/** 创建元素：h('div', { class: 'x' }, child…) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, raw] of Object.entries(props)) {
      if (raw === undefined || raw === null || raw === false) continue;
      const value = String(raw);
      if (key === 'class') el.className = value;
      else if (key === 'html') el.innerHTML = value;
      else if (key === 'text') el.textContent = value;
      else el.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'number' ? String(child) : child);
  }
  return el;
}

/** 毫秒 → mm:ss */
export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* 图标                                                                */
/* ------------------------------------------------------------------ */

const ICONS: Record<string, string> = {
  play: '<path d="M8 5.2v13.6L19.2 12z" fill="currentColor" stroke="none"/>',
  pause:
    '<rect x="7" y="5" width="3.4" height="14" rx="1.1" fill="currentColor" stroke="none"/><rect x="13.6" y="5" width="3.4" height="14" rx="1.1" fill="currentColor" stroke="none"/>',
  prev: '<path d="M18 5.6v12.8L9.4 12z" fill="currentColor" stroke="none"/><rect x="5" y="5.4" width="2.6" height="13.2" rx="1.2" fill="currentColor" stroke="none"/>',
  next: '<path d="M6 5.6v12.8L14.6 12z" fill="currentColor" stroke="none"/><rect x="16.4" y="5.4" width="2.6" height="13.2" rx="1.2" fill="currentColor" stroke="none"/>',
  volumeMuted:
    '<path d="M4 9.5h3.2L12 6v12l-4.8-3.5H4z" fill="currentColor" stroke="none"/><path d="M15.2 9.6l4.2 4.8M19.4 9.6l-4.2 4.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  volume:
    '<path d="M4 9.5h3.2L12 6v12l-4.8-3.5H4z" fill="currentColor" stroke="none"/><path d="M15.4 9.2a4.2 4.2 0 010 5.6M18 6.8a7.6 7.6 0 010 10.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  lyrics:
    '<path d="M5 6.5h11M5 11h14M5 15.5h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><circle cx="18" cy="15.5" r="1.6" fill="currentColor"/>',
  repeat: '<path d="M7 7h10l-2.2-2.2M17 17H7l2.2 2.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M17 7v3.2M7 17v-3.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  repeatOne: '<path d="M7 7h10l-2.2-2.2M17 17H7l2.2 2.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M17 7v3.2M7 17v-3.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M12 10v4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  shuffle: '<path d="M5 7h3.2l7.6 10H19M19 7h-3.2L8.2 17H5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M17 4.6 19.4 7 17 9.4M17 14.6 19.4 17 17 19.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  list: '<path d="M5 7h14M5 12h14M5 17h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><circle cx="18.4" cy="17" r="1.7" fill="currentColor"/>',
  heart:
    '<path d="M12 19.5s-7.2-4.4-7.2-9.4A4.1 4.1 0 0112 7.7a4.1 4.1 0 017.2 2.4c0 5-7.2 9.4-7.2 9.4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  heartFill:
    '<path d="M12 19.5s-7.2-4.4-7.2-9.4A4.1 4.1 0 0112 7.7a4.1 4.1 0 017.2 2.4c0 5-7.2 9.4-7.2 9.4z" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.6 15.6L20 20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  sparkle:
    '<path d="M12 4l1.8 4.7L18.5 10.5l-4.7 1.8L12 17l-1.8-4.7L5.5 10.5l4.7-1.8z" fill="currentColor" stroke="none"/><path d="M17.8 15.4l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" fill="currentColor" stroke="none" opacity=".7"/>',
  sliders:
    '<path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="9.5" cy="7" r="2.4" fill="currentColor"/><circle cx="15" cy="12" r="2.4" fill="currentColor"/><circle cx="7.5" cy="17" r="2.4" fill="currentColor"/>',
  equalizer:
    '<path d="M8 4.2v15.6M12 4.2v15.6M16 4.2v15.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="15" r="2.4" fill="currentColor"/><circle cx="12" cy="8.5" r="2.4" fill="currentColor"/><circle cx="16" cy="13" r="2.4" fill="currentColor"/>',
  settings:
    '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 3.6v2.2M12 18.2v2.2M4.6 12H6.8M17.2 12h2.2M6.7 6.7l1.6 1.6M15.7 15.7l1.6 1.6M17.3 6.7l-1.6 1.6M8.3 15.7l-1.6 1.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  folder:
    '<path d="M4 8.2c0-1 .8-1.8 1.8-1.8h3.4l1.6 2h6.4c1 0 1.8.8 1.8 1.8v6.2c0 1-.8 1.8-1.8 1.8H5.8c-1 0-1.8-.8-1.8-1.8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  user: '<circle cx="12" cy="8.6" r="3.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M5.2 19.4c.6-3.4 3.4-5.2 6.8-5.2s6.2 1.8 6.8 5.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  close: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
  minimize: '<path d="M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  maximize: '<rect x="5.5" y="5.5" width="13" height="13" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  chevron: '<path d="M8 10l4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  chevronUp: '<path d="M8 14l4-4 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  chevronDown: '<path d="M8 10l4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  logout:
    '<path d="M14.5 8V6.2c0-.9-.7-1.6-1.6-1.6H6.1c-.9 0-1.6.7-1.6 1.6v11.6c0 .9.7 1.6 1.6 1.6h6.8c.9 0 1.6-.7 1.6-1.6V16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/><path d="M11 12h9m0 0l-3-3m3 3l-3 3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  refresh:
    '<path d="M19 12a7 7 0 11-2.2-5.1M19 4.6V9h-4.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  home:
    '<path d="M4.4 10.5 12 4.5l7.6 6v7.9c0 .8-.6 1.4-1.4 1.4h-3.9v-5.2H9.7v5.2H5.8c-.8 0-1.4-.6-1.4-1.4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  clock:
    '<circle cx="12" cy="12" r="7.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 8.2V12l2.8 1.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  calendar:
    '<rect x="4.4" y="6" width="15.2" height="13.4" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 4.2v3.4M16 4.2v3.4M4.8 10.2h14.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  music:
    '<path d="M9 17.4V6.6l9-1.8v10.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.8" cy="17.4" r="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="15.8" cy="15.6" r="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  airplay:
    '<path d="M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1M12 15l5 6H7l5-6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  compass:
    '<circle cx="12" cy="12" r="7.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M15.2 8.8l-2 4.4-4.4 2 2-4.4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  download: '<path d="M12 4.2v9.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8.1 9.6 12 13.5l3.9-3.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M5.2 17.4h13.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  info: '<circle cx="12" cy="12" r="7.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 10.7v5.1" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="7.9" r="1.05" fill="currentColor"/>',
  trash:
    '<path d="M5.4 7.4h13.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M9.2 7.4V5.9c0-.8.6-1.4 1.4-1.4h2.8c.8 0 1.4.6 1.4 1.4v1.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M7 7.4l.8 10.3c.1.9.8 1.5 1.7 1.5h5c.9 0 1.6-.6 1.7-1.5L17 7.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10.3 11v4.6M13.7 11v4.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  comment:
    '<path d="M4.6 6.2c0-.9.7-1.6 1.6-1.6h11.6c.9 0 1.6.7 1.6 1.6v8.2c0 .9-.7 1.6-1.6 1.6H9.4L5.4 19.2V6.2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
};

/** 生成 SVG 图标（16×16 viewBox 24，随 currentColor）。 */
export function icon(name: keyof typeof ICONS | string, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] ?? '';
  return svg;
}

/** 同 icon()，但返回 SVG 标记字符串，给 innerHTML / 模板字符串场景用。 */
export function iconHtml(name: keyof typeof ICONS | string, size = 18): string {
  const body = ICONS[name] ?? '';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

/* ------------------------------------------------------------------ */
/* 提示                                                                */
/* ------------------------------------------------------------------ */

let toastHost: HTMLElement | null = null;

function ensureToastHost(): HTMLElement {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts' });
    document.body.append(toastHost);
  }
  return toastHost;
}

/** 顶部短提示（2.6s 自动消失）。 */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const host = ensureToastHost();
  const node = h('div', { class: kind === 'error' ? 'toast is-error' : 'toast', text: message });
  host.append(node);
  window.setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    node.style.transition = 'opacity .3s, transform .3s';
    window.setTimeout(() => node.remove(), 320);
  }, 2600);
}

/** 事件清理收集器，便于切换视图时统一解绑。 */
export class Disposers {
  private list: Array<() => void> = [];

  add(fn: () => void): void {
    this.list.push(fn);
  }

  dispose(): void {
    for (const fn of this.list.splice(0)) {
      try {
        fn();
      } catch {
        /* 忽略清理失败 */
      }
    }
  }
}
