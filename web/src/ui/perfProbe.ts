/**
 * 歌词页运行时探针（只在 `localStorage.zilux2.perf === '1'` 时工作）。
 *
 * 目的：切歌卡顿要按「谁在什么时候干了多久」定位，而不是靠猜。开关打开后
 * `window.__zilux2Perf` 里会累积三类记录：
 *  - marks：命名的同步区间耗时（compile / buildScene / swapSong / dispose / theme 重建 …）
 *  - longtasks：浏览器认定的长任务（> 50ms）
 *  - gaps：相邻两帧的间隔（> 32ms），这才是用户眼睛看到的「卡」
 *
 * 关掉开关时所有函数都是空操作，不注册任何监听，也不保留任何全局状态。
 */

type PerfMark = { n: string; ms: number; t: number; d?: Record<string, number> };
type PerfPerf = {
  marks: PerfMark[];
  longtasks: { ms: number; t: number }[];
  gaps: { ms: number; t: number }[];
};

const ON = ((): boolean => {
  try {
    return localStorage.getItem('zilux2.perf') === '1';
  } catch {
    return false;
  }
})();

const MAX_MARKS = 4000;

function bucket(): PerfPerf | null {
  if (!ON || typeof window === 'undefined') return null;
  const host = window as unknown as { __zilux2Perf?: PerfPerf };
  if (!host.__zilux2Perf) host.__zilux2Perf = { marks: [], longtasks: [], gaps: [] };
  return host.__zilux2Perf;
}

export const perfOn = (): boolean => ON;

export function perfMark(name: string, startedAt: number, detail?: Record<string, number>): void {
  const store = bucket();
  if (!store) return;
  const ms = Math.round((performance.now() - startedAt) * 10) / 10;
  store.marks.push({ n: name, ms, t: Math.round(performance.now()), ...(detail ? { d: detail } : {}) });
  if (store.marks.length > MAX_MARKS) store.marks.splice(0, store.marks.length - MAX_MARKS);
}

/** 只记一条事件（耗时为 0），用于「这个操作被调用了」的时间线。 */
export function perfEvent(name: string, detail?: Record<string, number>): void {
  if (!ON) return;
  const store = bucket();
  if (!store) return;
  store.marks.push({ n: name, ms: 0, t: Math.round(performance.now()), ...(detail ? { d: detail } : {}) });
  if (store.marks.length > MAX_MARKS) store.marks.splice(0, store.marks.length - MAX_MARKS);
}

/** 只记录超过 minMs 的区间，用于每帧都会跑的热路径（避免把 marks 塞满）。 */
export function perfMarkSlow(name: string, startedAt: number, minMs: number, detail?: Record<string, number>): void {
  if (!ON) return;
  const ms = performance.now() - startedAt;
  if (ms < minMs) return;
  perfMark(name, startedAt, detail);
}

/** 同步区间计时；只在探针打开时才取时间戳。 */
export function perfTime<T>(name: string, run: () => T, detail?: () => Record<string, number>): T {
  if (!ON) return run();
  const startedAt = performance.now();
  try {
    return run();
  } finally {
    perfMark(name, startedAt, detail?.());
  }
}

/** async 版的区间计时（await 前后的总耗时）。 */
export async function perfTimeAsync<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!ON) return run();
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    perfMark(name, startedAt);
  }
}

let monitorStarted = false;

/** 长任务 + 帧间隔。幂等，只在探针打开时由 perfProbe 的导入方调用一次即可。 */
export function startPerfMonitor(): void {
  if (!ON || monitorStarted || typeof window === 'undefined') return;
  monitorStarted = true;
  const store = bucket();
  if (!store) return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) store.longtasks.push({ ms: Math.round(entry.duration), t: Math.round(entry.startTime) });
      if (store.longtasks.length > 2000) store.longtasks.splice(0, store.longtasks.length - 2000);
    });
    observer.observe({ entryTypes: ['longtask'] });
    (window as unknown as { __zilux2PerfObserver?: PerformanceObserver }).__zilux2PerfObserver = observer;
  } catch {
    /* 老内核没有 longtask：还有 gaps 兜底 */
  }
  let last = performance.now();
  const tick = (): void => {
    const now = performance.now();
    const gap = now - last;
    last = now;
    if (!document.hidden && gap > 32) {
      store.gaps.push({ ms: Math.round(gap), t: Math.round(now) });
      if (store.gaps.length > 2000) store.gaps.splice(0, store.gaps.length - 2000);
    }
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}

if (ON && typeof window !== 'undefined') startPerfMonitor();
