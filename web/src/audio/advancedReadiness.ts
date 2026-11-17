/**
 * 四轨窗口预热登记表（WBS v2 §4 / T4-3 的前置条件）。
 *
 * 为什么必须预热：
 * 进阶过渡要在「过渡起点」那一刻同时启动两条 deck 的四轨，任何一步异步等待都会让
 * 声音断一下（元素已静音、分轨还没解码完 = 静音几百毫秒，这是不可接受的）。
 * 所以策略是：**只接已经预热好的窗口**。
 *
 *   - 预热发生在过渡前（`prepareCrossfade` 之后、真正开始前，通常还有十几秒）；
 *   - 预热 = 让宿主把这一窗的四轨算好并落盘（`/api/stems?stems=4`），顺手取一次
 *     让浏览器 HTTP 缓存也热起来；
 *   - 交接点只看登记表：没登记 ⇒ 工厂返回 null ⇒ 走原来的等功率曲线。
 *
 * 代价是「第一次听某首歌的进阶过渡会自动降级」，换来的是永远不会把声音搞没。
 * 预热键 = `source:id#window`，窗口 = `floor(positionSec / 30)`，与宿主的分窗口径一致。
 */

import type { OnlineTrack } from '../online/types';
import { STEM_WINDOW_SEC, prepareStemsWindow } from '../core/stemsClient';

/** 预热默认有效时长：10 分钟（一次过渡足够，过期就重新预热）。 */
export const STEM_READY_TTL_MS = 10 * 60_000;

/** 位置所在的窗口序号（与宿主 `window` 参数同口径）。 */
export function stemWindowOf(positionSec: number, windowSec = STEM_WINDOW_SEC): number {
  const sec = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
  const size = windowSec > 0 ? windowSec : STEM_WINDOW_SEC;
  return Math.max(0, Math.floor(sec / size));
}

/** 预热键：同一首歌的不同窗口互不覆盖。 */
export function stemKeyOf(track: OnlineTrack | null | undefined, positionSec: number, windowSec = STEM_WINDOW_SEC): string {
  if (!track) return '';
  const id = track.id || track.title || '';
  const source = track.source || '';
  if (!id) return '';
  return `${source}:${id}#${stemWindowOf(positionSec, windowSec)}`;
}

const ready = new Map<string, number>();

function nowMs(now?: number): number {
  if (Number.isFinite(now)) return now as number;
  return Date.now();
}

/** 登记一个已预热的窗口。 */
export function markStemReady(key: string, options: { ttlMs?: number; now?: number } = {}): void {
  if (!key) return;
  const ttl = Number.isFinite(options.ttlMs) ? Math.max(0, options.ttlMs as number) : STEM_READY_TTL_MS;
  ready.set(key, nowMs(options.now) + ttl);
}

/** 这个窗口现在能不能直接用（未登记或已过期都返回 false）。 */
export function isStemReady(key: string, now?: number): boolean {
  if (!key) return false;
  const expires = ready.get(key);
  if (expires === undefined) return false;
  if (expires <= nowMs(now)) {
    ready.delete(key);
    return false;
  }
  return true;
}

export function forgetStem(key: string): void {
  if (key) ready.delete(key);
}

/** 清空登记表（切歌/换库/测试用）。 */
export function resetStemReadiness(): void {
  ready.clear();
  inflight.clear();
}

/** 当前仍然有效的键（诊断/日志用）。 */
export function readyStemKeys(now?: number): string[] {
  const at = nowMs(now);
  const keys: string[] = [];
  for (const [key, expires] of ready) {
    if (expires > at) keys.push(key);
    else ready.delete(key);
  }
  return keys.sort();
}

export interface PrefetchTarget {
  track: OnlineTrack | null | undefined;
  /** 曲内位置（秒）。 */
  positionSec: number;
}

export interface PrefetchResult {
  /** A 的预热键（空串 = 这首歌不能做分轨）。 */
  keyA: string;
  /** B 的预热键。 */
  keyB: string;
  aReady: boolean;
  bReady: boolean;
  /** 宿主算过（cached=false）的窗口数，用于日志。 */
  computed: number;
  /** 失败原因（中文，给日志/UI 用；全部成功时为空串）。 */
  error: string;
}

type Prepare = typeof prepareStemsWindow;

/**
 * 并发预热两条 deck 的四轨窗口。任何一首失败都只把对应侧标 false，
 * 不抛异常（预热失败等于「这次不做进阶」，绝不能影响播放）。
 */
export async function prefetchStemsForTransition(
  a: PrefetchTarget,
  b: PrefetchTarget,
  options: { windowSec?: number; prepare?: Prepare; ttlMs?: number; now?: number } = {},
): Promise<PrefetchResult> {
  const windowSec = options.windowSec ?? STEM_WINDOW_SEC;
  const prepare = options.prepare ?? prepareStemsWindow;
  const keyA = stemKeyOf(a.track, a.positionSec, windowSec);
  const keyB = stemKeyOf(b.track, b.positionSec, windowSec);
  const result: PrefetchResult = { keyA, keyB, aReady: false, bReady: false, computed: 0, error: '' };

  const run = async (target: PrefetchTarget, key: string): Promise<boolean> => {
    if (!target.track || !key) return false;
    const onComputed = () => {
      result.computed += 1;
    };
    try {
      return await prepareOnce(
        target.track,
        stemWindowOf(target.positionSec, windowSec),
        key,
        prepare,
        { windowSec, ttlMs: options.ttlMs, now: options.now },
        onComputed,
      );
    } catch (error) {
      if (!result.error) result.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  };

  const [aReady, bReady] = await Promise.all([run(a, keyA), run(b, keyB)]);
  result.aReady = aReady;
  result.bReady = bReady;
  if (!result.error && (!aReady || !bReady)) {
    result.error = !aReady && !bReady ? '两条 deck 都没预热成功' : aReady ? 'B 侧预热失败' : 'A 侧预热失败';
  }
  return result;
}

// ---------------------------------------------------------------- 跨窗（第 13 轮）

/**
 * `[startSec, startSec+spanSec)` 覆盖的窗口号（与 `stemPlayer.spanWindowsSec` 同口径）。
 * 这里单独实现一份是为了不让 readiness 依赖音频层。
 */
export function stemSpanWindows(startSec: number, spanSec: number, windowSec = STEM_WINDOW_SEC): number[] {
  const size = windowSec > 0 ? windowSec : STEM_WINDOW_SEC;
  const from = Number.isFinite(startSec) ? Math.max(0, startSec) : 0;
  const span = Number.isFinite(spanSec) && spanSec > 0 ? spanSec : 0;
  const first = stemWindowOf(from, size);
  const last = stemWindowOf(Math.max(from, from + span - 1e-6), size);
  const out: number[] = [];
  for (let w = first; w <= last; w += 1) out.push(w);
  return out;
}

/** 跨窗预热键列表（第一项与 `stemKeyOf` 一致）。 */
export function stemSpanKeys(track: OnlineTrack | null | undefined, positionSec: number, spanSec: number, windowSec = STEM_WINDOW_SEC): string[] {
  const size = windowSec > 0 ? windowSec : STEM_WINDOW_SEC;
  return stemSpanWindows(positionSec, spanSec, size)
    .map((w) => stemKeyOf(track, windowStartOf(w, size), size))
    .filter((key) => key !== '');
}

function windowStartOf(window: number, windowSec: number): number {
  return Math.max(0, Math.floor(window)) * windowSec;
}

/** 这一段跨度的窗口是否全都预热好了。 */
export function isStemSpanReady(
  track: OnlineTrack | null | undefined,
  positionSec: number,
  spanSec: number,
  windowSec = STEM_WINDOW_SEC,
  now?: number,
): boolean {
  const keys = stemSpanKeys(track, positionSec, spanSec, windowSec);
  return keys.length > 0 && keys.every((key) => isStemReady(key, now));
}

export interface SpanPrefetchResult {
  keysA: string[];
  keysB: string[];
  aReady: boolean;
  bReady: boolean;
  computed: number;
  error: string;
}

/** 同一窗口的在途请求：重复预热（用户反复点「准备」）只发一次。 */
const inflight = new Map<string, Promise<boolean>>();

/**
 * 预热一个窗口，并按 `key` 去重。
 *
 * 为什么要去重：宿主一次只算一窗（30 s 窗 ≈ 7 s），`prepareCrossfade` 又可能被
 * 连续触发（改设置、重新准备、切歌回来），不去重就会把同一窗排成好几条请求，
 * 白白占住分离队列、把真正需要的下一窗往后推。
 */
function prepareOnce(
  track: OnlineTrack,
  window: number,
  key: string,
  prepare: Prepare,
  options: { windowSec: number; ttlMs?: number; now?: number },
  onComputed: () => void,
): Promise<boolean> {
  const existing = key ? inflight.get(key) : undefined;
  if (existing) return existing;
  const task = (async () => {
    // 抛出去的异常由调用方接住并记进 result.error（预热失败要有可读原因，
    // 不能只剩一个 false）。去重时多个调用方会拿到同一个 rejection，各自接住即可。
    const response = await prepare(track, window, { windowSec: options.windowSec, stems: 4 });
    if (!response || response.state === 'error') return false;
    if (!response.cached) onComputed();
    if (key) markStemReady(key, { ttlMs: options.ttlMs, now: options.now });
    return true;
  })();
  if (key) {
    inflight.set(key, task);
    // 注意：不能用 `void task.finally(...)` —— finally 派生出一个会跟着 reject 的新
    // Promise，没人接就是 unhandledRejection。这里两个分支都接住。
    const cleanup = () => {
      if (inflight.get(key) === task) inflight.delete(key);
    };
    task.then(cleanup, cleanup);
  }
  return task;
}

/**
 * 预热两条 deck 覆盖整段过渡的**全部窗口**。
 *
 * 并发策略：**每条 deck 内部串行、两条 deck 之间并行**（全局面向上限 2）。
 * 之前是把整段窗口一股脑 `Promise.all` 出去，4 窗 × 2 deck = 8 条 `/api/stems`
 * 同时打进来；宿主每窗都要建一次会话（峰值工作集 ~2.8 GB），并发只会让内存翻倍、
 * 还会让最先需要的那一窗排在队尾。串行后总耗时略长，但内存与延迟都可预期。
 *
 * 单个窗口预热失败只标该侧 false，不抛异常（等价于「这次不进阶」）。
 */
export async function prefetchStemSpan(
  a: PrefetchTarget,
  b: PrefetchTarget,
  spanSec: number,
  options: { windowSec?: number; prepare?: Prepare; ttlMs?: number; now?: number } = {},
): Promise<SpanPrefetchResult> {
  const windowSec = options.windowSec ?? STEM_WINDOW_SEC;
  const prepare = options.prepare ?? prepareStemsWindow;
  const keysA = stemSpanKeys(a.track, a.positionSec, spanSec, windowSec);
  const keysB = stemSpanKeys(b.track, b.positionSec, spanSec, windowSec);
  const result: SpanPrefetchResult = { keysA, keysB, aReady: false, bReady: false, computed: 0, error: '' };

  const run = async (target: PrefetchTarget, keys: string[]): Promise<boolean> => {
    if (!target.track || keys.length === 0) return false;
    const windows = stemSpanWindows(target.positionSec, spanSec, windowSec);
    const onComputed = () => {
      result.computed += 1;
    };
    try {
      // 串行：同一条 deck 的窗口按顺序算，避免同时开多个分离会话。
      for (let i = 0; i < windows.length; i += 1) {
        const key = keys[i] ?? '';
        const ok = await prepareOnce(target.track, windows[i], key, prepare, { windowSec, ttlMs: options.ttlMs, now: options.now }, onComputed);
        if (!ok) return false;
      }
      return true;
    } catch (error) {
      if (!result.error) result.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  };

  const [aReady, bReady] = await Promise.all([run(a, keysA), run(b, keysB)]);
  result.aReady = aReady;
  result.bReady = bReady;
  if (!result.error && (!aReady || !bReady)) {
    result.error = !aReady && !bReady ? '两条 deck 都没预热成功' : aReady ? 'B 侧预热失败' : 'A 侧预热失败';
  }
  return result;
}
