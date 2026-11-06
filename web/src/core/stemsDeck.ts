/**
 * 人声分离播放调度：用宿主 /api/stems 的真分离音轨（vocals / instrumental）替代
 * audioTap 里「搁架 EQ + 临场感提升」的假分离。
 *
 * 约定（docs/zilux2-stems-contract.md）：
 * - 分离以 30 s 窗口为单位，窗口号 = floor(位置秒 / 30)；
 * - 元素（<audio>）继续按原速播放并作为时间轴；切换期间元素支路被 mixGain 静音，
 *   分离音轨从 stemGain 汇入同一条滤镜链；
 * - 每一窗开始时按元素 currentTime 对齐起点，窗口内不再重排（≤30 s 内漂移可忽略）；
 * - 任何一步失败都回退到元素支路（EQ 兜底），绝不出现无声。
 */

import { deckAudioContext, deckStemInput, setDeckMixGain, setDeckStemGain } from './audioTap';
import { loadStemWindowBoth, prepareStemsWindow, STEM_WINDOW_SEC } from './stemsClient';
import type { OnlineTrack } from '../online/types';

interface WindowBuffers {
  vocals: AudioBuffer;
  instrumental: AudioBuffer;
}

export interface StemEntryOptions {
  element: HTMLAudioElement;
  track: OnlineTrack;
  /** 进入时的曲目位置（秒）；用于决定窗口与对齐偏移。 */
  positionSec: number;
  /** 分离播放时长（毫秒）；结束时自动交还元素支路。 */
  durationMs: number;
  /** 伴奏从 0 升到 1 的时长（毫秒），通常等于过渡时长。 */
  instRampMs?: number;
  /**
   * 人声延后入场：0 = 一开始就唱（常驻模式），0.38 = 过渡前 38% 只有 B 的伴奏，
   * 人声在随后 35% 里交叉进来（先叠伴奏、再叠人声，类似 DJ 的 EQ 分层）。
   */
  vocalFrom?: number;
}

export interface StemEntryHandle {
  /** 提前结束（淡出并交还元素支路）。 */
  stop(fadeMs?: number): void;
  /** 当前是否仍在用分离音轨。 */
  readonly active: boolean;
}

const LEAD_SEC = 0.06;
const SYNC_TOLERANCE_SEC = 0.12;

/** 每首曲目只保留一个窗口的在途请求，避免过渡瞬间重复算同一窗。 */
const inflight = new Map<string, Promise<WindowBuffers>>();
const cache = new Map<string, WindowBuffers>();
const CACHE_LIMIT = 4;

function cacheKey(track: OnlineTrack, window: number): string {
  return `${track.source}:${track.id}:${window}`;
}

/** 只让宿主把这一窗算出来（不解码、不需要音频图）；用于还没建图时的后台预热。 */
export function primeStemWindow(track: OnlineTrack, window: number): void {
  void prepareStemsWindow(track, window).catch(() => null);
}

/**
 * 预取一个窗口（宿主会同步算完，约 7 s）。失败返回 null，调用方继续走 EQ 兜底。
 * 成功时把解码后的两轨缓存在内存里（最多 4 窗，约 40 MB）。
 */
export async function prefetchStemWindow(
  context: AudioContext,
  track: OnlineTrack,
  window: number,
): Promise<WindowBuffers | null> {
  const key = cacheKey(track, window);
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return await running.catch(() => null);
  const task = (async (): Promise<WindowBuffers> => {
    let status = await prepareStemsWindow(track, window);
    // 宿主单 worker：上一次过渡/其它曲目还没算完时会回 busy/computing。
    // 后台预热不能就此放弃，按宿主给的 retryAfterMs 重试几次。
    for (let attempt = 0; status.state !== 'ready' && attempt < 3; attempt += 1) {
      if (status.state === 'model-missing' || status.state === 'error') break;
      const wait = Math.min(20_000, Math.max(1_500, status.retryAfterMs ?? 3_000));
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, wait));
      status = await prepareStemsWindow(track, window);
    }
    if (status.state !== 'ready') {
      throw new Error(status.state === 'model-missing' ? '分离模型未安装' : `分离未就绪（${status.state}）`);
    }
    const buffers = await loadStemWindowBoth(context, track, window);
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, buffers);
    return buffers;
  })();
  inflight.set(key, task);
  try {
    return await task;
  } catch {
    return null;
  } finally {
    inflight.delete(key);
  }
}

/** 该窗口的两轨是否已经在内存里（过渡开始时据此决定要不要立刻接管）。 */
export function hasStemWindow(track: OnlineTrack, window: number): boolean {
  return cache.has(cacheKey(track, window));
}

/** 清空内存里的分离音轨（切歌/关闭功能时调用）。 */
export function clearStemCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * 开始用真分离音轨接管一个 deck。调用前元素应已 play()（元素作为静音时间轴）。
 * 返回 null 表示无法接管（宿主未就绪、窗未缓存等），调用方保持原有 EQ 路径。
 */
export async function beginStemEntry(options: StemEntryOptions): Promise<StemEntryHandle | null> {
  const { element, track, durationMs } = options;
  const context = deckAudioContext(element);
  const stemInput = deckStemInput(element);
  if (!context || !stemInput) return null;

  const windowIndex = Math.max(0, Math.floor(options.positionSec / STEM_WINDOW_SEC));
  const buffers = cache.get(cacheKey(track, windowIndex)) ?? (await prefetchStemWindow(context, track, windowIndex));
  if (!buffers) return null;

  const startedAt = context.currentTime;
  const elementStart = element.currentTime;
  const windowStartSec = windowIndex * STEM_WINDOW_SEC;
  const offsetInWindow = Math.max(0, elementStart - windowStartSec);

  const vocalsGain = context.createGain();
  const instGain = context.createGain();
  vocalsGain.gain.value = 1;
  instGain.gain.value = 0;
  vocalsGain.connect(stemInput);
  instGain.connect(stemInput);

  const sources: AudioBufferSourceNode[] = [];
  const scheduleWindow = (buffersForWindow: WindowBuffers, offsetSec: number, at: number, spanSec: number): void => {
    const span = Math.min(spanSec, buffersForWindow.vocals.duration - offsetSec);
    if (span <= 0.02) return;
    for (const [buffer, gain] of [
      [buffersForWindow.vocals, vocalsGain] as const,
      [buffersForWindow.instrumental, instGain] as const,
    ]) {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start(at, offsetSec, span);
      sources.push(source);
    }
  };

  // 元素支路静音、分离支路接管；30 ms 交叉避免爆音。
  setDeckMixGain(element, 0, 30);
  setDeckStemGain(element, 1, 30);

  const durationSec = Math.max(0, durationMs) / 1000;
  const instRamp = Math.max(0.05, (options.instRampMs ?? durationMs) / 1000);
  const now = context.currentTime;
  instGain.gain.setValueAtTime(0, now);
  instGain.gain.linearRampToValueAtTime(1, now + instRamp);
  // 分层入场：先叠 B 的伴奏，人声在 vocalFrom 之后用 35% 的过渡时长交叉进来。
  const vocalFrom = Math.min(0.9, Math.max(0, options.vocalFrom ?? 0));
  if (vocalFrom > 0) {
    const vocalStart = now + durationSec * vocalFrom;
    const vocalRamp = Math.max(0.25, durationSec * 0.35);
    vocalsGain.gain.setValueAtTime(0, now);
    vocalsGain.gain.setValueAtTime(0, vocalStart);
    vocalsGain.gain.linearRampToValueAtTime(1, vocalStart + vocalRamp);
  }

  scheduleWindow(buffers, offsetInWindow, context.currentTime + LEAD_SEC,
    Math.min(durationSec + LEAD_SEC, buffers.vocals.duration - offsetInWindow));

  let active = true;
  let finished = false;
  let timer = 0;

  const finish = (fadeMs: number): void => {
    if (finished) return;
    finished = true;
    active = false;
    if (timer !== 0) window.clearTimeout(timer);
    const fadeSec = Math.max(0.02, fadeMs / 1000);
    const t = context.currentTime;
    for (const gain of [vocalsGain, instGain]) {
      try {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0, t + fadeSec);
      } catch {
        /* 忽略 */
      }
    }
    setDeckStemGain(element, 0, fadeMs);
    setDeckMixGain(element, 1, fadeMs);
    window.setTimeout(() => {
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          /* 已结束 */
        }
        try {
          source.disconnect();
        } catch {
          /* 忽略 */
        }
      }
      try {
        vocalsGain.disconnect();
        instGain.disconnect();
      } catch {
        /* 忽略 */
      }
    }, Math.ceil(fadeSec * 1000) + 30);
  };

  // 窗口内按元素时间轴做一次轻量漂移校正：超过容差就停止重排到正确位置。
  let lastWindow = windowIndex;
  let nextWindowAt = windowStartSec + STEM_WINDOW_SEC;
  const tick = (): void => {
    if (!active) return;
    const drift = Math.abs(element.currentTime - (windowStartSec + offsetInWindow + (context.currentTime - startedAt)));
    if (drift > SYNC_TOLERANCE_SEC) {
      // 元素被 seek 或暂停：停止并交还元素支路，让上层重新判断。
      finish(120);
      return;
    }
    if (element.currentTime >= nextWindowAt) {
      const nextWindow = Math.floor(element.currentTime / STEM_WINDOW_SEC);
      if (nextWindow !== lastWindow) {
        lastWindow = nextWindow;
        nextWindowAt = (nextWindow + 1) * STEM_WINDOW_SEC;
        const key = cacheKey(track, nextWindow);
        const nextBuffers = cache.get(key);
        if (nextBuffers) {
          scheduleWindow(nextBuffers, 0, context.currentTime + LEAD_SEC, STEM_WINDOW_SEC);
        } else {
          void prefetchStemWindow(context, track, nextWindow);
        }
      }
    }
    timer = window.setTimeout(tick, 250);
  };
  timer = window.setTimeout(tick, 250);

  window.setTimeout(() => finish(180), Math.max(0, durationMs));

  return {
    stop: (fadeMs = 180) => finish(fadeMs),
    get active() {
      return active;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 常驻「纯人声 / 纯伴奏」模式：不限于过渡，跟随元素持续播放，
 * 跨 30 s 窗口自动续排；元素被 seek/暂停/切歌时通过 onDetached 交还控制权。
 * ------------------------------------------------------------------ */

export type StemPlaybackMode = 'vocals' | 'instrumental';

export interface StemModeOptions {
  element: HTMLAudioElement;
  track: OnlineTrack;
  /** 进入时的位置（秒）。 */
  positionSec: number;
  mode: StemPlaybackMode;
  /** 内部判定需要交还元素时回调（seek/暂停/漂移/窗口缺失）。 */
  onDetached?: (reason: 'seek' | 'ended' | 'error') => void;
}

export interface StemModeHandle {
  stop(fadeMs?: number): void;
  setMode(mode: StemPlaybackMode): void;
  readonly active: boolean;
}

const MODE_LEAD_SEC = 0.05;
const MODE_SYNC_TOLERANCE_SEC = 0.14;
const MODE_TICK_MS = 120;
const MODE_PREFETCH_AHEAD_SEC = 4;

/**
 * 开始常驻分离播放。成功后元素支路被静音、分离轨接管；返回 null 表示当前拿不到窗口
 * （宿主未就绪/算不出来），调用方应提示并保持原声。
 */
export async function startStemMode(options: StemModeOptions): Promise<StemModeHandle | null> {
  const { element, track } = options;
  const context = deckAudioContext(element);
  const stemInput = deckStemInput(element);
  if (!context || !stemInput) return null;

  const startWindow = Math.max(0, Math.floor(options.positionSec / STEM_WINDOW_SEC));
  const first = cache.get(cacheKey(track, startWindow)) ?? (await prefetchStemWindow(context, track, startWindow));
  if (!first) return null;

  const mode0: StemPlaybackMode = options.mode;
  const vocalsGain = context.createGain();
  const instGain = context.createGain();
  vocalsGain.gain.value = mode0 === 'vocals' ? 1 : 0;
  instGain.gain.value = mode0 === 'instrumental' ? 1 : 0;
  vocalsGain.connect(stemInput);
  instGain.connect(stemInput);

  const sources = new Set<AudioBufferSourceNode>();
  const scheduleWindow = (buffersForWindow: WindowBuffers, offsetSec: number, at: number, spanSec: number): void => {
    const span = Math.min(spanSec, buffersForWindow.vocals.duration - offsetSec);
    if (span <= 0.02) return;
    for (const [buffer, gain] of [
      [buffersForWindow.vocals, vocalsGain] as const,
      [buffersForWindow.instrumental, instGain] as const,
    ]) {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start(Math.max(context.currentTime, at), offsetSec, span);
      source.onended = () => {
        sources.delete(source);
        try {
          source.disconnect();
        } catch {
          /* 忽略 */
        }
      };
      sources.add(source);
    }
  };

  // 接管：元素静音、分离支路进图（30 ms 交叉）。
  setDeckMixGain(element, 0, 30);
  setDeckStemGain(element, 1, 30);

  const anchorCtx = context.currentTime + MODE_LEAD_SEC;
  const anchorElement = element.currentTime;
  const windowStart = startWindow * STEM_WINDOW_SEC;
  const offsetInWindow = Math.max(0, anchorElement - windowStart);
  scheduleWindow(first, offsetInWindow, anchorCtx, STEM_WINDOW_SEC - offsetInWindow);

  let active = true;
  let finished = false;
  let timer = 0;
  let scheduledThrough = startWindow;

  const finish = (fadeMs: number, reason?: 'seek' | 'ended' | 'error'): void => {
    if (finished) return;
    finished = true;
    active = false;
    if (timer !== 0) window.clearTimeout(timer);
    const fadeSec = Math.max(0.02, fadeMs / 1000);
    const t = context.currentTime;
    for (const gain of [vocalsGain, instGain]) {
      try {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0, t + fadeSec);
      } catch {
        /* 忽略 */
      }
    }
    setDeckStemGain(element, 0, fadeMs);
    setDeckMixGain(element, 1, fadeMs);
    window.setTimeout(() => {
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          /* 已结束 */
        }
        try {
          source.disconnect();
        } catch {
          /* 忽略 */
        }
      }
      sources.clear();
      try {
        vocalsGain.disconnect();
        instGain.disconnect();
      } catch {
        /* 忽略 */
      }
      if (reason) options.onDetached?.(reason);
    }, Math.ceil(fadeSec * 1000) + 30);
  };

  const tick = (): void => {
    if (!active) return;
    const expected = anchorElement + (context.currentTime - anchorCtx);
    if (Math.abs(element.currentTime - expected) > MODE_SYNC_TOLERANCE_SEC) {
      finish(120, 'seek');
      return;
    }
    if (element.ended) {
      finish(160, 'ended');
      return;
    }
    const position = element.currentTime;
    const windowIndex = Math.floor(position / STEM_WINDOW_SEC);
    // 提前预取下一窗（宿主算一窗约 7 s，留足提前量）。
    if (windowIndex + 1 > scheduledThrough && position >= (windowIndex + 1) * STEM_WINDOW_SEC - MODE_PREFETCH_AHEAD_SEC) {
      void prefetchStemWindow(context, track, windowIndex + 1);
    }
    if (windowIndex > scheduledThrough) {
      const nextIndex = windowIndex;
      const nextBuffers = cache.get(cacheKey(track, nextIndex));
      if (nextBuffers) {
        const boundary = nextIndex * STEM_WINDOW_SEC;
        const at = anchorCtx + (boundary - anchorElement);
        const offset = Math.max(0, position - boundary);
        // at 已过期时 scheduleWindow 会立即按 offset 起播，避免空窗。
        scheduleWindow(nextBuffers, offset, at, STEM_WINDOW_SEC - offset);
        scheduledThrough = nextIndex;
      } else {
        // 拿不到下一窗：交还元素，上层会提示并回退原声。
        finish(140, 'error');
        return;
      }
    }
    timer = window.setTimeout(tick, MODE_TICK_MS);
  };
  timer = window.setTimeout(tick, MODE_TICK_MS);

  return {
    stop: (fadeMs = 180) => finish(fadeMs),
    setMode: (mode) => {
      const t = context.currentTime;
      const vocalsTarget = mode === 'vocals' ? 1 : 0;
      const instTarget = mode === 'instrumental' ? 1 : 0;
      for (const [gain, target] of [
        [vocalsGain, vocalsTarget] as const,
        [instGain, instTarget] as const,
      ]) {
        try {
          gain.gain.cancelScheduledValues(t);
          gain.gain.setValueAtTime(gain.gain.value, t);
          gain.gain.linearRampToValueAtTime(target, t + 0.06);
        } catch {
          /* 忽略 */
        }
      }
    },
    get active() {
      return active;
    },
  };
}

export interface StemTailLoopHandle {
  /** 结束尾小节循环，淡出并把元素支路交还。 */
  stop(fadeMs?: number): void;
  readonly active: boolean;
}

/**
 * A 尾小节循环：把 A 最后一个小节（vocals + instrumental）循环 1–2 次，
 * 用于在自动过渡里把「A 的尾奏」再延长一小节，给 B 更多人声交叉时间。
 *
 * 只在该窗口已经解码缓存时才可用（调用方先用 hasStemWindow 判断）；返回 null 表示无法接管。
 * 元素支路在循环开始时静音，循环结束/取消时交还，任何失败都回到元素原声。
 */
export function startStemTailLoop(options: {
  element: HTMLAudioElement;
  track: OnlineTrack;
  /** 循环起点（曲内毫秒，必须落在小节线上） */
  positionMs: number;
  /** 一个小节的长度（毫秒） */
  barMs: number;
  /** 循环几次（1–2） */
  repeats: number;
}): StemTailLoopHandle | null {
  const context = deckAudioContext(options.element);
  const stemInput = deckStemInput(options.element);
  if (!context || !stemInput) return null;
  const windowIndex = Math.max(0, Math.floor(options.positionMs / 1000 / STEM_WINDOW_SEC));
  const buffers = cache.get(cacheKey(options.track, windowIndex));
  if (!buffers) return null;
  const offset = Math.max(0, options.positionMs / 1000 - windowIndex * STEM_WINDOW_SEC);
  const span = Math.max(0.05, options.barMs / 1000);
  const repeats = Math.min(2, Math.max(1, Math.round(options.repeats)));
  if (offset + span > buffers.vocals.duration - 0.01) return null;

  const loopGain = context.createGain();
  loopGain.gain.value = 1;
  loopGain.connect(stemInput);
  const startAt = context.currentTime + 0.03;
  const sources: AudioBufferSourceNode[] = [];
  for (const buffer of [buffers.vocals, buffers.instrumental]) {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = offset;
    source.loopEnd = Math.min(buffer.duration, offset + span);
    source.connect(loopGain);
    source.start(startAt, offset);
    sources.push(source);
  }
  // 元素支路让位给循环轨：20 ms 交叉，接缝处不至于爆音。
  setDeckStemGain(options.element, 1, 20);
  setDeckMixGain(options.element, 0, 20);
  const endAt = startAt + span * repeats;
  let active = true;
  let timer = 0;
  const finish = (fadeMs = 140): void => {
    if (!active) return;
    active = false;
    if (timer !== 0) {
      window.clearTimeout(timer);
      timer = 0;
    }
    const fadeSec = Math.max(0.02, fadeMs / 1000);
    const t = context.currentTime;
    try {
      loopGain.gain.cancelScheduledValues(t);
      loopGain.gain.setValueAtTime(loopGain.gain.value, t);
      loopGain.gain.linearRampToValueAtTime(0, t + fadeSec);
    } catch {
      /* 忽略 */
    }
    setDeckStemGain(options.element, 0, fadeMs);
    setDeckMixGain(options.element, 1, fadeMs);
    window.setTimeout(() => {
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          /* 已结束 */
        }
        try {
          source.disconnect();
        } catch {
          /* 忽略 */
        }
      }
      try {
        loopGain.disconnect();
      } catch {
        /* 忽略 */
      }
    }, fadeMs + 80);
  };
  timer = window.setTimeout(() => finish(140), Math.max(80, (endAt - context.currentTime) * 1000));
  return {
    stop: (fadeMs = 140) => finish(fadeMs),
    get active() {
      return active;
    },
  };
}
