/**
 * 延长段执行层：把 extensionPlan 选中的循环单元解码、平铺成 AudioBuffer 并按排程播放。
 *
 * 只做 decode / 排程，不推理、不 await 播放路径：
 * - `renderExtensionBuffer` 在预排期阶段异步解码（applySchedule 时调用一次）；
 * - `startExtensionPlayback` 同步建节点，接 `tap.input`（绕过元素 gate，经过 deck 的 v2 链）；
 * - `extensionActive()` 供 onEnded 守卫判断「延长段还在响」。
 */

import { tileLoopChannels } from '../core/automix/bridgePlan';

/** 与 extensionPlan 保持一致：2 ms 接缝缺口。 */
const SEAM_MS = 2;

/** 每个 src 只保留一份编码字节，避免重复网络请求。 */
const byteCache = new Map<string, Promise<ArrayBuffer>>();

const liveHandles = new Set<ExtensionHandle>();

export interface ExtensionRenderInput {
  ctx: BaseAudioContext;
  src: string;
  /** 单元起点（文件毫秒）。 */
  unitStartFileMs: number;
  /** 一遍的长度（毫秒）。 */
  unitMs: number;
  /** 平铺遍数，允许 1（A 尾可能只需一遍）。 */
  passes: number;
}

export interface StartExtensionInput {
  ctx: AudioContext;
  tap: { input: AudioNode };
  buffer: AudioBuffer;
  /** 期望起播的音频时钟时间（秒）。已经过去时用 offset 追赶。 */
  atSec: number;
  gainDb: number;
  /** 计划总长（秒）；缺省播完整个 buffer。 */
  durationSec?: number;
  /** 从 buffer 内第几秒开始播（生成过渡用整段垫底时留 0）。 */
  offsetSec?: number;
  /** 两端淡入淡出长度（秒）；缺省 0.02 / 0.05，垫底模式用更长值。 */
  fadeInSec?: number;
  fadeOutSec?: number;
  /** 需要铺满的时长（秒）；超过 buffer 长度时重复平铺，用于「与窗口等长」的垫底。 */
  coverSec?: number;
}

export interface ExtensionHandle {
  readonly active: boolean;
  stop(): void;
  dispose(): void;
}

function fetchBytes(src: string): Promise<ArrayBuffer> {
  const cached = byteCache.get(src);
  if (cached) {
    // 命中即刷新 LRU 顺序，避免连续过渡时把正在复用的那首挤掉。
    byteCache.delete(src);
    byteCache.set(src, cached);
    return cached;
  }
  const pending = fetch(src, { cache: 'force-cache' }).then((response) => {
    if (!response.ok) throw new Error(`延长段素材加载失败: ${response.status}`);
    return response.arrayBuffer();
  });
  byteCache.set(src, pending);
  while (byteCache.size > 4) {
    const oldest = byteCache.keys().next().value;
    if (oldest === undefined) break;
    byteCache.delete(oldest);
  }
  pending.catch(() => byteCache.delete(src));
  return pending;
}

function extractUnit(buffer: AudioBuffer, startSec: number, unitSec: number): Float32Array[] {
  const rate = buffer.sampleRate;
  const start = Math.max(0, Math.round(startSec * rate));
  const length = Math.max(1, Math.round(unitSec * rate));
  const channels: Float32Array[] = [];
  for (let index = 0; index < buffer.numberOfChannels; index += 1) {
    const source = buffer.getChannelData(index);
    const unit = new Float32Array(length);
    const available = Math.max(0, Math.min(length, source.length - start));
    if (available > 0) unit.set(source.subarray(start, start + available));
    channels.push(unit);
  }
  return channels;
}

/** 载入宿主生成好的延长 wav（analysis 根相对路径经 feature-audio 端点取回）。 */

/** 解码并平铺一段单元；任何失败都返回 null（调用方静默跳过延长）。 */
export async function renderExtensionBuffer(input: ExtensionRenderInput): Promise<AudioBuffer | null> {
  const { ctx, src } = input;
  if (!src) return null;
  const unitMs = Number.isFinite(input.unitMs) ? input.unitMs : 0;
  const passes = Math.max(1, Math.floor(Number.isFinite(input.passes) ? input.passes : 1));
  if (!(unitMs > 0)) return null;
  try {
    const bytes = await fetchBytes(src);
    const decoded = await ctx.decodeAudioData(bytes.slice(0));
    const channels = extractUnit(decoded, Math.max(0, input.unitStartFileMs) / 1000, unitMs / 1000);
    const seamSamples = Math.max(1, Math.round((ctx.sampleRate * SEAM_MS) / 1000));
    const tiled = tileLoopChannels(channels, channels[0]?.length ?? 1, passes, seamSamples);
    const frames = tiled[0]?.length ?? 0;
    if (frames <= 0) return null;
    const out = ctx.createBuffer(tiled.length, frames, ctx.sampleRate);
    for (let index = 0; index < tiled.length; index += 1) {
      out.copyToChannel(new Float32Array(tiled[index]!), 0);
    }
    return out;
  } catch (error) {
    console.warn('[extension] 延长段解码失败', error);
    return null;
  }
}

function dbToGain(db: number): number {
  if (!Number.isFinite(db) || db === 0) return 1;
  return Math.pow(10, db / 20);
}

/** 同步起播一段延长 buffer；返回幂等句柄。 */
export function startExtensionPlayback(input: StartExtensionInput): ExtensionHandle | null {
  const { ctx, tap, buffer } = input;
  const now = ctx.currentTime;
  const at = Number.isFinite(input.atSec) ? Math.max(0, input.atSec) : now;
  const lateSec = Math.max(0, now - at);
  if (lateSec >= buffer.duration) return null;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  const baseGain = dbToGain(input.gainDb);
  gain.gain.value = baseGain;
  const extra: Array<{ src: AudioBufferSourceNode; gain: GainNode }> = [];
  source.connect(gain);
  gain.connect(tap.input);

  let stopped = false;
  const handle: ExtensionHandle = {
    get active() {
      return !stopped;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      liveHandles.delete(handle);
      for (const part of extra) {
        try {
          part.src.stop();
        } catch {
          /* 已经结束 */
        }
        try {
          part.src.disconnect();
          part.gain.disconnect();
        } catch {
          /* 已断开 */
        }
      }
      try {
        source.stop();
      } catch {
        /* 已经结束 */
      }
      try {
        source.disconnect();
      } catch {
        /* 已断开 */
      }
      try {
        gain.disconnect();
      } catch {
        /* 已断开 */
      }
    },
    dispose() {
      handle.stop();
    },
  };

  source.onended = () => {
    if (!stopped) handle.stop();
  };

  const offsetSec = Math.max(0, Number.isFinite(input.offsetSec) ? (input.offsetSec as number) : 0);
  const startOffset = Math.min(buffer.duration - lateSec, offsetSec + lateSec);
  const durationSec = Number.isFinite(input.durationSec) && (input.durationSec as number) > 0
    ? Math.min(buffer.duration - startOffset, input.durationSec as number)
    : buffer.duration - startOffset;
  if (!(durationSec > 0)) return null;

  // 两端淡入淡出：生成过渡是「垫底」，硬起硬收会被听成插播；循环延长默认很短。
  const fadeIn = Math.max(0, input.fadeInSec ?? 0.02);
  const fadeOut = Math.max(0, input.fadeOutSec ?? 0.05);
  const playFrom = Math.max(at, now);
  try {
    if (fadeIn > 0.001) {
      gain.gain.setValueAtTime(0, playFrom);
      gain.gain.linearRampToValueAtTime(baseGain, playFrom + Math.min(fadeIn, durationSec * 0.5));
    } else {
      gain.gain.setValueAtTime(baseGain, playFrom);
    }
    if (fadeOut > 0.001) {
      const holdUntil = playFrom + Math.max(0, durationSec - fadeOut);
      gain.gain.setValueAtTime(baseGain, holdUntil);
      gain.gain.linearRampToValueAtTime(0, playFrom + durationSec);
    }
  } catch {
    /* 参数已经排过时（极少），保持当前增益 */
  }

  try {
    source.start(at, startOffset);
    if (durationSec < buffer.duration - startOffset) {
      source.stop(at + durationSec);
    }
  } catch (error) {
    console.warn('[extension] 起播失败', error);
    handle.stop();
    return null;
  }
  // 垫底要「与窗口等长」：生成段比窗口短时按 60 ms 交叠重复铺满，不拉时长、不改调。
  const coverSec = Math.max(0, Number.isFinite(input.coverSec) ? (input.coverSec as number) : 0);
  if (coverSec > durationSec + 0.5 && buffer.duration >= 1) {
    const step = Math.max(0.5, durationSec - 0.06);
    const repeats = Math.min(3, Math.ceil((coverSec - durationSec) / step));
    for (let index = 1; index <= repeats; index += 1) {
      const segStart = at + index * step;
      const segDur = Math.min(buffer.duration, coverSec - index * step + 0.06);
      if (!(segDur > 0.3)) break;
      const seg = ctx.createBufferSource();
      seg.buffer = buffer;
      const segGain = ctx.createGain();
      segGain.gain.value = 0;
      seg.connect(segGain);
      segGain.connect(tap.input);
      try {
        segGain.gain.setValueAtTime(0, segStart);
        segGain.gain.linearRampToValueAtTime(baseGain, segStart + 0.06);
        segGain.gain.setValueAtTime(baseGain, segStart + Math.max(0.07, segDur - 0.06));
        segGain.gain.linearRampToValueAtTime(0, segStart + segDur);
        seg.start(segStart, 0, segDur);
      } catch {
        break;
      }
      extra.push({ src: seg, gain: segGain });
    }
  }

  liveHandles.add(handle);
  return handle;
}

/** 是否有延长段正在响（给 onEnded 守卫用）。 */
export function extensionActive(): boolean {
  for (const handle of liveHandles) {
    if (handle.active) return true;
  }
  return false;
}
