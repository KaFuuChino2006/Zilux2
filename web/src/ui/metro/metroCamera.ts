/**
 * 「音乐地铁图」相机：平移 / 缩放 / 适图 / 镜头动画。
 *
 * 只做数学与输入，不认识业务；由 metroStage 创建并驱动。
 * 行为规范见 research/tmp/metro-m1/contract.md §4（方案 §4.1 / §7.5 / §8.4）。
 *
 * 坐标约定：
 *   - 世界坐标 → 屏幕坐标：`screen = world * scale + translate`；
 *   - 相机只写 `.mt-camera` 的 `style.transform = translate(tx,ty) scale(scale)`，
 *     `transform-origin: 0 0` 由 renderer 的 CSS 提供，本模块不碰 group 的其它样式/DOM。
 */

import { METRO_MOTION, prefersReducedMotion } from './metroTheme';
import type { MetroBounds } from './types';

export interface MetroCameraState {
  scale: number;
  tx: number;
  ty: number;
}

export interface MetroCameraOptions {
  /** 最小缩放，默认 0.3。 */
  minScale?: number;
  /** 最大缩放，默认 4。 */
  maxScale?: number;
  /** 适图留白比例，默认 0.88。 */
  fitPadding?: number;
}

export interface MetroCamera {
  readonly svg: SVGSVGElement;
  readonly group: SVGGElement;
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
  setBounds(bounds: MetroBounds): void;
  /** 适配全图：scale 使 bounds 完整可见并居中；animate=true 时 480ms 缓动。 */
  fit(animate?: boolean): void;
  /** 屏幕坐标锚点缩放；anchor 缺省为视口中心。 */
  zoomBy(factor: number, anchor?: { x: number; y: number }): void;
  /** 绝对缩放（保持视口中心的世界点不动）。 */
  zoomTo(scale: number): void;
  /** 把某个世界点移到视口中心（可选同时缩放）。 */
  focusPoint(point: { x: number; y: number }, scale?: number): void;
  onChange(callback: ((state: MetroCameraState) => void) | null): void;
  /** 本次 pointerdown→pointerup 是否发生过拖拽（>4px）；读取后自动复位。 */
  consumeDragFlag(): boolean;
  dispose(): void;
}

const DEFAULT_MIN_SCALE = 0.3;
const DEFAULT_MAX_SCALE = 4;
const DEFAULT_FIT_PADDING = 0.88;

/** 拖拽判定阈值（屏幕 px，方案 §4.1「超过 4px 视为拖拽」）。 */
const DRAG_THRESHOLD = 4;
/** 双击空白放大倍数（契约 §4.2）。 */
const DOUBLE_CLICK_FACTOR = 1.6;
/** 滚轮灵敏度（契约 §4.2 固定公式 exp(-deltaY * 0.0015)）。 */
const WHEEL_ZOOM_RATE = 0.0015;
/** 这些元素上的 pointerdown 不开始空白平移（契约 §4.2）。 */
const INTERACTIVE_SELECTOR =
  '.mt-station, .mt-line, .mt-hud, .mt-card, .mt-legend, .mt-zoombar, .mt-linebar, .mt-hint';

interface DragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startTx: number;
  startTy: number;
  moved: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

function formatTransform(state: MetroCameraState): string {
  return `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
}

/** 事件目标是否落在交互元素上（这些元素的 pointerdown 不归相机管）。 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null;
}

export function createMetroCamera(
  svg: SVGSVGElement,
  group: SVGGElement,
  options: MetroCameraOptions = {},
): MetroCamera {
  const minScale = options.minScale ?? DEFAULT_MIN_SCALE;
  const maxScale = Math.max(options.maxScale ?? DEFAULT_MAX_SCALE, minScale);
  const fitPadding = options.fitPadding ?? DEFAULT_FIT_PADDING;

  /** 当前镜头状态（世界坐标 → 屏幕坐标的仿射参数）。 */
  let scale = 1;
  let tx = 0;
  let ty = 0;
  /** 适图用的世界包围盒；未设置时 fit 安全 no-op。 */
  let bounds: MetroBounds | null = null;
  /** 一次 pointerdown→pointerup 内是否发生过 >4px 拖拽（consume 之后不复位）。 */
  let dragFlag = false;
  let drag: DragState | null = null;
  let callback: ((state: MetroCameraState) => void) | null = null;
  let rafId = 0;

  function notify(): void {
    if (callback) callback({ scale, tx, ty });
  }

  /**
   * 写入新状态：只有值真的变化时才改 DOM / 回调，避免拖拽 0 位移与重复 fit 的空回调。
   * 非法数值（NaN/Infinity）一律丢弃：布局层万一给出坏 bounds，相机不能把 transform 写坏。
   */
  function apply(nextScale: number, nextTx: number, nextTy: number): void {
    if (!Number.isFinite(nextScale) || !Number.isFinite(nextTx) || !Number.isFinite(nextTy)) return;
    const next = clamp(nextScale, minScale, maxScale);
    if (next === scale && nextTx === tx && nextTy === ty) return;
    scale = next;
    tx = nextTx;
    ty = nextTy;
    group.style.transform = formatTransform({ scale, tx, ty });
    notify();
  }

  function applyState(state: MetroCameraState): void {
    apply(state.scale, state.tx, state.ty);
  }

  function cancelAnimation(): void {
    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  /** rAF + easeOutCubic 补间到目标状态；reduced-motion 时 0 时长直接跳变。 */
  function animateTo(target: MetroCameraState): void {
    cancelAnimation();
    const same =
      target.scale === scale && target.tx === tx && target.ty === ty;
    if (same) return;
    const duration = prefersReducedMotion() ? 0 : METRO_MOTION.camera;
    if (duration <= 0) {
      applyState(target);
      return;
    }
    const fromScale = scale;
    const fromTx = tx;
    const fromTy = ty;
    const startAt = performance.now();
    const step = (now: number): void => {
      rafId = 0;
      const t = clamp((now - startAt) / duration, 0, 1);
      const e = easeOutCubic(t);
      apply(
        fromScale + (target.scale - fromScale) * e,
        fromTx + (target.tx - fromTx) * e,
        fromTy + (target.ty - fromTy) * e,
      );
      if (t < 1) rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  /** 当前视口尺寸（相机假设 svg 铺满视口，契约 §4.2）。 */
  function viewportSize(): { width: number; height: number } {
    const rect = svg.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  /** 适图目标状态；无 bounds / 尺寸非法时返回 null（安全 no-op）。 */
  function fitTarget(): MetroCameraState | null {
    if (!bounds) return null;
    const b = bounds;
    const bw = b.maxX - b.minX;
    const bh = b.maxY - b.minY;
    const vp = viewportSize();
    if (!(bw > 0) || !(bh > 0) || !(vp.width > 0) || !(vp.height > 0)) return null;
    if (!Number.isFinite(bw) || !Number.isFinite(bh)) return null;
    const nextScale = clamp(
      Math.min(vp.width / bw, vp.height / bh) * fitPadding,
      minScale,
      maxScale,
    );
    return {
      scale: nextScale,
      tx: (vp.width - bw * nextScale) / 2 - b.minX * nextScale,
      ty: (vp.height - bh * nextScale) / 2 - b.minY * nextScale,
    };
  }

  function setBounds(nextBounds: MetroBounds): void {
    bounds = {
      minX: nextBounds.minX,
      minY: nextBounds.minY,
      maxX: nextBounds.maxX,
      maxY: nextBounds.maxY,
    };
  }

  function fit(animate = false): void {
    const target = fitTarget();
    if (!target) return;
    if (animate) {
      animateTo(target);
      return;
    }
    cancelAnimation();
    applyState(target);
  }

  function zoomBy(factor: number, anchor?: { x: number; y: number }): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const nextScale = clamp(scale * factor, minScale, maxScale);
    if (nextScale === scale) return;
    cancelAnimation();
    const vp = viewportSize();
    const ax = anchor ? anchor.x : vp.width / 2;
    const ay = anchor ? anchor.y : vp.height / 2;
    const k = nextScale / scale;
    apply(nextScale, ax - (ax - tx) * k, ay - (ay - ty) * k);
  }

  function zoomTo(nextScale: number): void {
    if (!Number.isFinite(nextScale)) return;
    const target = clamp(nextScale, minScale, maxScale);
    if (target === scale) return;
    cancelAnimation();
    const vp = viewportSize();
    const k = target / scale;
    const cx = vp.width / 2;
    const cy = vp.height / 2;
    apply(target, cx - (cx - tx) * k, cy - (cy - ty) * k);
  }

  function focusPoint(point: { x: number; y: number }, targetScale?: number): void {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const vp = viewportSize();
    const wanted = targetScale ?? scale;
    const nextScale = clamp(Number.isFinite(wanted) ? wanted : scale, minScale, maxScale);
    animateTo({
      scale: nextScale,
      tx: vp.width / 2 - point.x * nextScale,
      ty: vp.height / 2 - point.y * nextScale,
    });
  }

  function setOnChange(nextCallback: ((state: MetroCameraState) => void) | null): void {
    callback = typeof nextCallback === 'function' ? nextCallback : null;
    // 注册时同步一次当前状态：stage 若先 onChange 后 fit，也能立刻拿到正确 LOD / 百分比。
    if (callback) callback({ scale, tx, ty });
  }

  function consumeDragFlag(): boolean {
    const value = dragFlag;
    dragFlag = false;
    return value;
  }

  /* ------------------------------ 输入：拖拽平移 ------------------------------ */

  function onPointerDown(event: PointerEvent): void {
    // 任何交互都打断镜头动画（契约 §4.2「动画期间用户再次交互直接打断」）。
    cancelAnimation();
    dragFlag = false;
    if (event.button !== 0 || !event.isPrimary) return;
    if (isInteractiveTarget(event.target)) return;
    drag = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startTx: tx,
      startTy: ty,
      moved: false,
    };
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      // 指针已失效 / 环境不支持时忽略：拖拽仍能工作，只是移出 svg 后可能提前结束。
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      drag.moved = true;
      dragFlag = true;
    }
    apply(scale, drag.startTx + dx, drag.startTy + dy);
  }

  function endDrag(event: PointerEvent): void {
    try {
      if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    } catch {
      // 指针已释放时 release 会抛错，忽略即可。
    }
    drag = null;
  }

  function onPointerUp(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    endDrag(event);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    endDrag(event);
  }

  function onLostPointerCapture(event: PointerEvent): void {
    if (drag && event.pointerId === drag.pointerId) drag = null;
  }

  /* ------------------------------ 输入：滚轮缩放 ------------------------------ */

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    cancelAnimation();
    const rect = svg.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    const nextScale = clamp(scale * Math.exp(-event.deltaY * WHEEL_ZOOM_RATE), minScale, maxScale);
    if (nextScale === scale) return;
    const k = nextScale / scale;
    apply(nextScale, cx - (cx - tx) * k, cy - (cy - ty) * k);
  }

  /* ------------------------------ 输入：双击放大 ------------------------------ */

  function onDoubleClick(event: MouseEvent): void {
    if (event.button !== 0) return;
    if (isInteractiveTarget(event.target)) return;
    const rect = svg.getBoundingClientRect();
    zoomBy(DOUBLE_CLICK_FACTOR, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  }

  /* -------------------------------- 生命周期 -------------------------------- */

  function dispose(): void {
    cancelAnimation();
    drag = null;
    dragFlag = false;
    callback = null;
    svg.removeEventListener('pointerdown', onPointerDown);
    svg.removeEventListener('pointermove', onPointerMove);
    svg.removeEventListener('pointerup', onPointerUp);
    svg.removeEventListener('pointercancel', onPointerCancel);
    svg.removeEventListener('lostpointercapture', onLostPointerCapture);
    svg.removeEventListener('wheel', onWheel);
    svg.removeEventListener('dblclick', onDoubleClick);
  }

  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerCancel);
  svg.addEventListener('lostpointercapture', onLostPointerCapture);
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('dblclick', onDoubleClick);

  // 初始 transform 由相机接管（之后只有本模块改它），避免 renderer / 旧样式残留。
  group.style.transform = formatTransform({ scale, tx, ty });

  const camera: MetroCamera = {
    svg,
    group,
    get scale(): number {
      return scale;
    },
    get tx(): number {
      return tx;
    },
    get ty(): number {
      return ty;
    },
    setBounds,
    fit,
    zoomBy,
    zoomTo,
    focusPoint,
    onChange: setOnChange,
    consumeDragFlag,
    dispose,
  };
  return camera;
}
