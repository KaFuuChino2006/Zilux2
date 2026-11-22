/**
 * 统一运动系统（motion）：界面上所有「换内容」的动画都从这里发。
 *
 * 目标（维护者）：所有画面看起来来自同一图层，不像在切页面。做法是
 *   1) 时长/缓动/位移只认这里的两三组常量，别再各写各的；
 *   2) 每个动画都是三件套：`enter()` 入场、`leave()` 出场、`cancel()` 打断；
 *   3) 打断永远先 cancel 再重新发，不叠加、不排队；
 *   4) 同一图层内换内容用「交叉」：新内容从下方 12px / 轻微模糊里出来，旧内容往上一同幅度走掉，
 *      中间不留白 —— 这就是「同一图层」的观感来源。
 */

export interface MotionTokens {
  /** 元素级的小位移（列表行、按钮、卡片元信息）。 */
  fast: number;
  /** 区块级的常规切换（视图、整页头部）。 */
  base: number;
  /** 大块表面（封面、封面带、整页进出）。 */
  slow: number;
  /** 统一缓动：起步快、尾巴长，和今日推荐页一致。 */
  ease: string;
  /** 入场位移（px）。 */
  riseIn: number;
  /** 出场位移（px），比入场小一点，避免「甩出去」。 */
  riseOut: number;
  /** 入场起手模糊（px）。 */
  blur: number;
}

export const MOTION: MotionTokens = {
  fast: 260,
  base: 420,
  slow: 620,
  ease: 'cubic-bezier(.16, .84, .24, 1)',
  riseIn: 14,
  riseOut: 10,
  blur: 6,
};

const KEYFRAMES_IN = (riseIn: number, blur: number): Keyframe[] => [
  { opacity: 0, transform: `translate3d(0, ${riseIn}px, 0)`, filter: `blur(${blur}px)` },
  { opacity: 1, transform: 'translate3d(0, 0, 0)', filter: 'blur(0px)' },
];

const KEYFRAMES_OUT = (riseOut: number, blur: number): Keyframe[] => [
  { opacity: 1, transform: 'translate3d(0, 0, 0)', filter: 'blur(0px)' },
  { opacity: 0, transform: `translate3d(0, ${-riseOut}px, 0)`, filter: `blur(${blur}px)` },
];

/**
 * 落定：动画跑完那一帧不把元素立刻降回「裸元素」，但也不能一直留在合成层里。
 *
 * 两段式：
 *   1) 收尾那一帧把动画最后算出的 transform / filter 原样抄进行内变量，
 *      由 `.is-motion-settled` 读回去 —— 属性、矩阵、层三者都不变，
 *      所以看不到「位移一下 / 被挤一下」；
 *   2) **两帧之后再放手**（摘类 + 清变量），元素回主线程按设备像素栅格化。
 *
 * 为什么必须放手：留在合成层里的元素，文字是先在离屏纹理里画好再合成的；
 * 只要动画期间有过 scale / perspective，那份纹理就是按当时的栅格比例画的，
 * 之后不再重画 —— 表现出来就是「文字有点糊，而且概率性」（维护者 2026-11-22 报）。
 * 桥接两帧足够让最后一帧先被合成器呈现，放手时的重栅格化在静态画面上几乎看不出来。
 */
const SETTLE_CLASS = 'is-motion-settled';

/** 每个元素身上待执行的「放手」帧（用于打断：新一段开始前先撤掉）。 */
const releaseFrames = new WeakMap<Element, number>();

const dropSettle = (el: HTMLElement): void => {
  el.classList.remove(SETTLE_CLASS);
};

const cancelRelease = (el: Element): void => {
  const frame = releaseFrames.get(el);
  if (frame === undefined) return;
  cancelAnimationFrame(frame);
  releaseFrames.delete(el);
};

/** 桥接两帧后放手：让文字回到主线程按真实像素重画（否则会概率性发糊）。 */
const scheduleRelease = (el: Element): void => {
  if (!(el instanceof HTMLElement)) return;
  cancelRelease(el);
  const first = requestAnimationFrame(() => {
    const second = requestAnimationFrame(() => {
      releaseFrames.delete(el);
      dropSettle(el);
    });
    releaseFrames.set(el, second);
  });
  releaseFrames.set(el, first);
};

const settle = (el: Element): void => {
  if (!(el instanceof HTMLElement)) return;
  // 只加类（transform: none），不抄动画最后一帧的矩阵：
  // 抄 3D 矩阵再撤回去，等于让文字在 3D 表面与 2D 之间换一次渲染方式，看着就是像素级位移。
  el.classList.add(SETTLE_CLASS);
  scheduleRelease(el);
};

const clearSettle = (el: Element): void => {
  if (!(el instanceof HTMLElement)) return;
  cancelRelease(el);
  dropSettle(el);
};

/** 每个元素身上只允许有一条「我们发的」动画，重复调用先撤旧的。 */
const running = new WeakMap<Element, Animation>();

const cancelOne = (el: Element): void => {
  const current = running.get(el);
  if (!current) return;
  running.delete(el);
  clearSettle(el);
  try {
    current.cancel();
  } catch {
    /* 已经结束/被浏览器回收：忽略 */
  }
};

export interface MotionOptions {
  /** 覆盖时长（毫秒）。 */
  duration?: number;
  /** 覆盖位移。 */
  rise?: number;
  /** 覆盖缓动。 */
  ease?: string;
  /** 延迟多久开始（毫秒）。逐张错帧用，别在调用方写 setTimeout。 */
  delay?: number;
  /** 结束后是否把内联样式清掉（默认清，回到 CSS 说了算）。 */
  clear?: boolean;
}

/**
 * 入场。元素需要是「本来就在布局里」的节点（display 不为 none），
 * 否则动画会在下一帧才开始。返回 Promise，在结束或被 cancel 时 resolve。
 */
export function enter(el: Element, options: MotionOptions = {}): Promise<void> {
  const duration = options.duration ?? MOTION.base;
  const delay = options.delay ?? 0;
  const rise = options.rise ?? MOTION.riseIn;
  const ease = options.ease ?? MOTION.ease;
  const clear = options.clear ?? true;
  cancelOne(el);
  const elWithAnim = el as Element & { animate?: Element['animate'] };
  if (typeof elWithAnim.animate !== 'function') return Promise.resolve();
  const animation = elWithAnim.animate(KEYFRAMES_IN(rise, MOTION.blur), {
    duration,
    delay,
    easing: ease,
    fill: 'both',
  });
  running.set(el, animation);
  return new Promise((resolve) => {
    animation.addEventListener('finish', () => {
      if (running.get(el) === animation) running.delete(el);
      if (clear) {
        // 先把最后一帧钉成静态值，再撤动画：顺序反了就会闪一下。
        settle(el);
        try {
          (animation as Animation).cancel();
        } catch {
          /* noop */
        }
      }
      resolve();
    });
    animation.addEventListener('cancel', () => resolve());
  });
}

/** 出场：往上一同幅度走掉并轻微模糊，和入场是同一套位移语言。 */
export function leave(el: Element, options: MotionOptions = {}): Promise<void> {
  const duration = options.duration ?? MOTION.fast;
  const rise = options.rise ?? MOTION.riseOut;
  const ease = options.ease ?? MOTION.ease;
  const clear = options.clear ?? true;
  cancelOne(el);
  const elWithAnim = el as Element & { animate?: Element['animate'] };
  if (typeof elWithAnim.animate !== 'function') return Promise.resolve();
  const animation = elWithAnim.animate(KEYFRAMES_OUT(rise, MOTION.blur), {
    duration,
    easing: ease,
    fill: 'both',
  });
  running.set(el, animation);
  return new Promise((resolve) => {
    animation.addEventListener('finish', () => {
      if (running.get(el) === animation) running.delete(el);
      if (clear) {
        try {
          (animation as Animation).cancel();
        } catch {
          /* noop */
        }
      }
      resolve();
    });
    animation.addEventListener('cancel', () => resolve());
  });
}

/** 打断：撤掉这个元素上我们发过的动画，元素立即回到 CSS 决定的状态。 */
export function cancel(el: Element): void {
  cancelOne(el);
}

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

/**
 * 自带关键帧的动画（浮层这种带 translate(-50%) 定位的，通用 enter/leave 套不上）。
 * 同样进 running 记账：重复调用先 cancel，落定后清内联，语义和 enter/leave 一致。
 */
export function play(el: Element, frames: Keyframe[], options: MotionOptions = {}): Promise<void> {
  cancelOne(el);
  const duration = options.duration ?? MOTION.base;
  const ease = options.ease ?? MOTION.ease;
  return new Promise((resolve) => {
    let animation: Animation;
    try {
      animation = el.animate(frames, { duration, delay: options.delay ?? 0, easing: ease, fill: 'both' });
    } catch {
      resolve();
      return;
    }
    running.set(el, animation);
    const done = (): void => {
      if (running.get(el) === animation) running.delete(el);
      if (options.clear !== false) {
        // 浮层这类自带关键帧的动画同样要落定，不然结束那一下整块重新栅格化。
        settle(el);
        if (el instanceof HTMLElement) el.style.removeProperty('opacity');
      }
      resolve();
    };
    animation.addEventListener('finish', done);
    animation.addEventListener('cancel', done);
  });
}
