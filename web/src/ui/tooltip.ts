/**
 * 自定义悬停提示：把元素上的原生 `title` 提示换成应用统一样式的浮层。
 *
 * 原生 title 提示由浏览器/系统绘制，字体、圆角、毛玻璃都不跟 app 一致；这里用事件委托
 * 在 pointerover 时把 title 暂存并移除（原生提示因此不会出现），在 body 上显示一颗
 * 与面板同风格的浮层，离开 / 点击 / 滚动 / 失焦时还原 title 并隐藏浮层。
 *
 * 动态创建的按钮不需要逐个接入：任何带 title 的元素都自动生效；想禁用某个元素，
 * 给它加 `data-no-tooltip` 即可。
 */

const SHOW_DELAY_MS = 380;
const GAP = 9;
const EDGE = 8;

let tip: HTMLDivElement | null = null;
let target: HTMLElement | null = null;
let savedTitle: string | null = null;
let showTimer = 0;
let frame = 0;

function ensureTip(): HTMLDivElement {
  if (tip) return tip;
  const el = document.createElement('div');
  el.className = 'app-tooltip';
  el.setAttribute('role', 'tooltip');
  document.body.append(el);
  tip = el;
  return el;
}

/** 把浮层放在元素上方居中；上方放不下时翻到下方，并水平夹在视口内。 */
function place(el: HTMLElement): void {
  const host = ensureTip();
  const rect = el.getBoundingClientRect();
  const width = host.offsetWidth;
  const height = host.offsetHeight;
  const center = rect.left + rect.width / 2;
  let left = center - width / 2;
  left = Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE));
  let top = rect.top - height - GAP;
  if (top < EDGE) top = rect.bottom + GAP;
  host.style.left = `${Math.round(left)}px`;
  host.style.top = `${Math.round(top)}px`;
}

/** 播放条悬停展开等场景元素会平移，浮层跟着最新位置走（每帧最多一次）。 */
function schedulePlace(): void {
  if (frame) return;
  frame = window.requestAnimationFrame(() => {
    frame = 0;
    if (target && tip?.classList.contains('is-visible')) place(target);
  });
}

function show(): void {
  showTimer = 0;
  const el = target;
  if (!el || savedTitle === null) return;
  if (!el.isConnected) {
    hide();
    return;
  }
  const host = ensureTip();
  host.textContent = savedTitle;
  host.classList.add('is-visible');
  place(el);
}

function hide(): void {
  if (showTimer) {
    window.clearTimeout(showTimer);
    showTimer = 0;
  }
  if (frame) {
    window.cancelAnimationFrame(frame);
    frame = 0;
  }
  tip?.classList.remove('is-visible');
  if (target && savedTitle !== null) target.setAttribute('title', savedTitle);
  target = null;
  savedTitle = null;
}

function pick(event: Event): HTMLElement | null {
  const from = event.target as Element | null;
  const el = from?.closest?.('[title]') as HTMLElement | null;
  if (!el || !el.getAttribute('title')) return null;
  if (el.hasAttribute('data-no-tooltip')) return null;
  return el;
}

function onOver(event: PointerEvent): void {
  const el = pick(event);
  if (!el || el === target) return;
  hide();
  const title = el.getAttribute('title');
  if (!title) return;
  target = el;
  savedTitle = title;
  el.removeAttribute('title');
  showTimer = window.setTimeout(show, SHOW_DELAY_MS);
}

function onOut(event: PointerEvent): void {
  if (!target) return;
  const to = event.relatedTarget as Node | null;
  if (to && target.contains(to)) return;
  hide();
}

/** 安装全局悬停提示（页面生命周期内装一次即可）。 */
export function installAppTooltips(): void {
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  document.addEventListener('pointerdown', () => hide(), true);
  document.addEventListener('pointermove', () => {
    if (tip?.classList.contains('is-visible')) schedulePlace();
  }, { capture: true, passive: true });
  document.addEventListener('scroll', () => hide(), true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  }, true);
  window.addEventListener('blur', () => hide());
  window.addEventListener('resize', () => {
    if (tip?.classList.contains('is-visible')) schedulePlace();
  });
}
