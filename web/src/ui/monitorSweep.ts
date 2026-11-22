/**
 * 真屏扫光：用户在「画布设置」里点选某块屏时，那块屏的实际壁纸自上而下扫过一道炫彩光，
 * 让人一眼确认「选的是这一块」，而不是只在弹层里高亮。
 *
 * 由宿主通过 `{type:'host', event:'monitorSweep'}` 触发（每块桌面表面各收各的），
 * 这里只负责画一层满屏渐变、跑完一次就撤掉 —— 不改壁纸状态。
 */

const SWEEP_CLASS = 'wp-screen-sweep-fx';
const RUN_CLASS = 'wp-screen-sweep-fx-run';
/** 与 CSS 的动画时长（1.7s）对齐，多给 140ms 让淡出帧走完再摘类。 */
const SWEEP_MS = 1840;

let layer: HTMLElement | null = null;
let timer = 0;
let lastAt = 0;
/** 上一次扫光开始后 1.9s 内忽略重复触发：整屏上一道带子够醒目了，
 *  半路被重新点一下又从头重放会变成「一直闪」。 */
const REPLAY_GUARD_MS = 1900;

function ensureLayer(): HTMLElement {
  if (layer && layer.isConnected) return layer;
  const el = document.createElement('div');
  el.className = SWEEP_CLASS;
  el.setAttribute('aria-hidden', 'true');
  document.body.append(el);
  layer = el;
  return el;
}

/**
 * 先把这层挂进 DOM（页面启动时调一次）。
 * 现场新建元素再立刻加动画类，WebView2 里偶尔会把动画起点算到 0、整段被跳过，
 * 扫光就「看不见」；元素先存在、后面只切类，才不会踩这个坑。
 */
export function initMonitorSweep(): void {
  if (typeof document === 'undefined' || !document.body) return;
  ensureLayer();
}

/** 播一次扫光；连续触发会从头重放（不叠加多层）。 */
export function playMonitorSweep(): void {
  if (typeof document === 'undefined' || !document.body) return;
  const now = Date.now();
  if (now - lastAt < REPLAY_GUARD_MS) return;
  lastAt = now;
  const el = ensureLayer();
  el.classList.remove(RUN_CLASS);
  // 摘类后等一帧再加回来：强制重排 + 让动画的起点落在这一帧之后，
  // 否则同一元素上连续触发不会重播。
  window.requestAnimationFrame(() => {
    void el.offsetWidth;
    el.classList.add(RUN_CLASS);
  });
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    el.classList.remove(RUN_CLASS);
  }, SWEEP_MS);
}
