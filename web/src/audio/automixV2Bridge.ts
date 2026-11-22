/**
 * 结构桥接的执行层：把 A 的尾段 PCM 预渲染成 AudioBuffer，再用第三路 source 播。
 *
 * 为什么不能在元素上回跳 `currentTime`：`HTMLMediaElement` seek 回来有 20–40 ms 空洞
 * （解码器重新填充），在 120 Hz 上就是「噗」一下。所以循环必须走 buffer。
 *
 * 为什么只缓存 byte 不缓存 PCM：一次 4 分钟的歌解码成 44.1k 立体声 float ≈ 84 MB，
 * 缓存整首会吃掉几百兆；真正需要常驻的只有那 8–16 秒尾段（≈ 5 MB）。
 */

import { tileLoopChannels, BRIDGE_SEAM_MS } from '../core/automix/bridgePlan';
import { shiftPitchChannels } from './pitchShift';

interface TapHandle {
  input: GainNode;
  gate: GainNode;
  restore: () => void;
}

/** 原始字节缓存：同一首歌反复过渡时不必重复下载。 */
const byteCache = new Map<string, ArrayBuffer>();
const BYTE_CACHE_MAX = 4;

export interface BridgeRenderInput {
  ctx: AudioContext;
  /** 音频文件 URL（元素的 currentSrc / src） */
  src: string;
  /** 尾段起点（文件毫秒） */
  unitStartFileMs: number;
  /** 一遍的长度（毫秒） */
  unitMs: number;
  /** 播几遍 */
  passes: number;
}

async function loadBytes(src: string): Promise<ArrayBuffer | null> {
  const cached = byteCache.get(src);
  if (cached) {
    // LRU：命中后挪到队尾。
    byteCache.delete(src);
    byteCache.set(src, cached);
    return cached;
  }
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) return null;
    byteCache.set(src, bytes);
    while (byteCache.size > BYTE_CACHE_MAX) {
      const oldest = byteCache.keys().next().value;
      if (oldest === undefined) break;
      byteCache.delete(oldest);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** 预热字节（可选）：切歌前先下载，桥接时只解码不等待网络。 */
export function prefetchBridgeBytes(src: string): void {
  if (!src || byteCache.has(src)) return;
  void loadBytes(src);
}

/** 解码 + 切片 + 平铺。失败一律返回 null（调用方回落到「A 自然结束」）。 */
export async function renderBridgeBuffer(input: BridgeRenderInput): Promise<AudioBuffer | null> {
  const { ctx, src } = input;
  const unitMs = Math.max(1, Math.round(input.unitMs));
  const passes = Math.max(2, Math.floor(input.passes));
  const bytes = await loadBytes(src);
  if (!bytes) return null;
  let decoded: AudioBuffer;
  try {
    // decodeAudioData 会消费 ArrayBuffer，传副本，保证缓存还能复用。
    decoded = await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    return null;
  }
  const rate = decoded.sampleRate || ctx.sampleRate;
  const unitSamples = Math.max(1, Math.round((unitMs / 1000) * rate));
  const startSample = Math.max(0, Math.round((input.unitStartFileMs / 1000) * rate));
  const available = Math.min(unitSamples, decoded.length - startSample);
  if (available < unitSamples * 0.5) return null;
  const channels: Float32Array[] = [];
  for (let index = 0; index < decoded.numberOfChannels; index += 1) {
    const source = decoded.getChannelData(index);
    channels.push(source.subarray(startSample, startSample + unitSamples));
  }
  const seamSamples = Math.round((BRIDGE_SEAM_MS / 1000) * rate);
  const tiled = tileLoopChannels(channels, unitSamples, passes, seamSamples);
  try {
    const out = ctx.createBuffer(tiled.length, tiled[0]!.length, rate);
    for (let index = 0; index < tiled.length; index += 1) out.copyToChannel(tiled[index] as Float32Array<ArrayBuffer>, index);
    return out;
  } catch {
    return null;
  }
}

/**
 * 一根 gate 被 bridge / backspin / loopRoll 三个 overlay 共用：
 * 谁先结束就把门放开 → 仍在播的那个会跟 A 的原声叠在一起（双击、相位打架）；
 * 异常路径漏放 → A 永远没声（历史上「播放不出声」正是这一类）。所以按引用计数管理。
 */
const gateHolders = new WeakMap<AudioParam, number>();

function acquireGate(tap: TapHandle, at: number): void {
  const gate = tap.gate.gain;
  const holders = (gateHolders.get(gate) ?? 0) + 1;
  gateHolders.set(gate, holders);
  if (holders > 1) return;
  try {
    gate.cancelScheduledValues(at);
    gate.setValueAtTime(gate.value, at);
    gate.linearRampToValueAtTime(0, at + 0.012);
  } catch {
    /* 忽略 */
  }
}

function releaseGate(tap: TapHandle, ctx: AudioContext): void {
  const gate = tap.gate.gain;
  const holders = Math.max(0, (gateHolders.get(gate) ?? 1) - 1);
  gateHolders.set(gate, holders);
  if (holders > 0) return;
  try {
    const now = ctx.currentTime;
    gate.cancelScheduledValues(now);
    gate.setValueAtTime(gate.value, now);
    gate.linearRampToValueAtTime(1, now + 0.02);
  } catch {
    /* 忽略 */
  }
}

export interface BridgeRuntime {
  stop: () => void;
}

/**
 * 在 `atSec` 这一刻把 A 的声音从元素切到 buffer，并让 buffer 播 `durationSec`。
 *
 * 切换用 12 ms 线性斜坡把元素门压到 0：buffer 的第一帧与元素的同一帧是同源信号，
 * 两路短暂叠加听感上只是「同一个声音略厚」，不会出现双声或空洞。
 */
/**
 * 渲染 B 侧「前奏桥」buffer：把前奏的循环单元平铺到 `delayMs × rate` 的材料长度，
 * 再整体移调，播放时以 `rate` 播 → 墙钟时长正好等于 `delayMs`、音高落在目标调上。
 *
 * 只在过渡前跑一次；失败返回 null，调用方退回「不推迟元素」的老路径。
 */
export async function renderIntroBridgeBuffer(input: {
  ctx: AudioContext;
  src: string;
  /** 循环单元起点（B 文件毫秒）。 */
  loopStartFileMs: number;
  /** 单元长度（毫秒）。 */
  loopMs: number;
  /** 需要覆盖的墙钟时长（毫秒）。 */
  delayMs: number;
  /** 元素播放速率（buffer 也要按它播，材料时长要乘回去）。 */
  playbackRate: number;
  /** 目标移调（半音，已含速率补偿）。 */
  semitones: number;
}): Promise<AudioBuffer | null> {
  const { ctx, src } = input;
  const loopMs = Math.max(1, Math.round(input.loopMs));
  const rate = Number.isFinite(input.playbackRate) && input.playbackRate > 0 ? input.playbackRate : 1;
  const materialMs = Math.max(loopMs, Math.round(Math.max(1, input.delayMs) * rate));
  const passes = Math.max(1, Math.ceil(materialMs / loopMs));
  const bytes = await loadBytes(src);
  if (!bytes) return null;
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    return null;
  }
  const sampleRate = decoded.sampleRate || ctx.sampleRate;
  const unitSamples = Math.max(1, Math.round((loopMs / 1000) * sampleRate));
  const startSample = Math.max(0, Math.round((input.loopStartFileMs / 1000) * sampleRate));
  if (startSample + unitSamples > decoded.length) return null;
  const channels: Float32Array[] = [];
  for (let index = 0; index < decoded.numberOfChannels; index += 1) {
    const source = decoded.getChannelData(index);
    channels.push(source.slice(startSample, startSample + unitSamples));
  }
  // 平铺：接缝只压 1 ms（前奏桥要接着往下播，不需要 A 尾桥那种明显缺口）。
  const seamSamples = Math.round((1 / 1000) * sampleRate);
  const tiled = tileLoopChannels(channels, unitSamples, passes, seamSamples);
  const wanted = Math.max(1, Math.round((materialMs / 1000) * sampleRate));
  const trimmed = tiled.map((channel) => {
    if (channel.length === wanted) return channel;
    const out = new Float32Array(wanted);
    out.set(channel.subarray(0, Math.min(channel.length, wanted)), 0);
    // 材料不够就在尾部补静音（不应发生：passes 已按 ceil 取整）。
    return out;
  });
  const shifted = Math.abs(input.semitones) >= 0.05
    ? shiftPitchChannels(trimmed as Float32Array[], sampleRate, input.semitones)
    : trimmed;
  try {
    const out = ctx.createBuffer(shifted.length, shifted[0]!.length, sampleRate);
    for (let index = 0; index < shifted.length; index += 1) {
      out.copyToChannel(shifted[index] as Float32Array<ArrayBuffer>, index);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 叠播（doubling）：把一小片素材按原速重复播放，**不动 A 的 gate**——A 要一直响着当底。
 * 与 `startBridgePlayback` 的唯一区别就在这里：桥接/倒带/循环要顶替 A，叠播只是加一层。
 */
export function startOverlayPlayback(args: {
  tap: TapHandle;
  ctx: AudioContext;
  buffer: AudioBuffer;
  atSec: number;
  durationSec: number;
}): BridgeRuntime | null {
  const { tap, ctx, buffer } = args;
  const at = Math.max(0, args.atSec);
  const duration = Math.max(0.05, args.durationSec);
  let stopped = false;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = 1;
  try {
    source.connect(gain);
    gain.connect(tap.input);
  } catch {
    return null;
  }
  try {
    source.start(at);
    source.stop(at + duration);
  } catch {
    try {
      source.disconnect();
      gain.disconnect();
    } catch {
      /* 忽略 */
    }
    return null;
  }
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      source.stop();
    } catch {
      /* 已结束 */
    }
    try {
      source.disconnect();
      gain.disconnect();
    } catch {
      /* 忽略 */
    }
  };
  return {
    stop,
    get stopped() {
      return stopped;
    },
  } as BridgeRuntime;
}

export function startBridgePlayback(args: {
  tap: TapHandle;
  ctx: AudioContext;
  buffer: AudioBuffer;
  atSec: number;
  durationSec: number;
  /** 播放速率（与元素一致时要靠它把 buffer 拉齐墙钟时长）。 */
  rate?: number;
}): BridgeRuntime | null {
  const { tap, ctx, buffer } = args;
  const at = args.atSec;
  const duration = Math.max(0.05, args.durationSec);
  let stopped = false;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const rate = Number.isFinite(args.rate) && (args.rate as number) > 0 ? (args.rate as number) : 1;
  try {
    source.playbackRate.value = rate;
  } catch {
    /* 忽略：老浏览器不支持时按 1 播 */
  }
  const gain = ctx.createGain();
  gain.gain.value = 1;
  try {
    source.connect(gain);
    gain.connect(tap.input);
  } catch {
    return null;
  }
  let holding = false;
  try {
    acquireGate(tap, at);
    holding = true;
    source.start(at);
    source.stop(at + duration);
  } catch {
    try {
      source.disconnect();
      gain.disconnect();
    } catch {
      /* 忽略 */
    }
    // 门已经压下去了，失败必须放回来，否则 A 从此没声。
    if (holding) releaseGate(tap, ctx);
    return null;
  }
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      source.stop();
    } catch {
      /* 已结束 */
    }
    try {
      source.disconnect();
      gain.disconnect();
    } catch {
      /* 忽略 */
    }
    // 元素门交还给常规路径：引用计数归零才真的放开（三个 overlay 共用一根门）。
    if (holding) releaseGate(tap, ctx);
  };
  return { stop };
}

export interface BackspinRenderInput {
  ctx: AudioContext;
  src: string;
  /** 倒带起点（文件毫秒）：一般是 A 的淡化起点。 */
  startFileMs: number;
  /** 倒带时长（毫秒）。 */
  tailMs: number;
  /** 首尾去咔哒的长度（毫秒）。 */
  declickMs?: number;
}

/**
 * 倒放 A 的一小段：切片 → 逐声道反转 → 首尾 5 ms 淡入淡出。
 *
 * 元素上做不到（playbackRate 不能为负），所以必须走 buffer + 第三路 source。
 * 反转用就地 `reverse()`（TypedArray 自带），比逐样本循环快一个数量级。
 */
export async function renderBackspinBuffer(
  input: BackspinRenderInput,
): Promise<AudioBuffer | null> {
  const { ctx, src } = input;
  const tailMs = Math.max(200, Math.round(input.tailMs));
  const bytes = await loadBytes(src);
  if (!bytes) return null;
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    return null;
  }
  const rate = decoded.sampleRate || ctx.sampleRate;
  const startSample = Math.max(0, Math.round((input.startFileMs / 1000) * rate));
  let length = Math.min(Math.round((tailMs / 1000) * rate), decoded.length - startSample);
  if (length < rate * 0.2) return null;
  const declick = Math.max(1, Math.min(length >> 2, Math.round(((input.declickMs ?? 5) / 1000) * rate)));
  try {
    const out = ctx.createBuffer(decoded.numberOfChannels, length, rate);
    for (let index = 0; index < decoded.numberOfChannels; index += 1) {
      const source = decoded.getChannelData(index);
      const slice = new Float32Array(length);
      slice.set(source.subarray(startSample, startSample + length));
      slice.reverse();
      for (let i = 0; i < declick; i += 1) {
        const gain = i / declick;
        slice[i] *= gain;
        slice[length - 1 - i] *= gain;
      }
      out.copyToChannel(slice, index);
    }
    return out;
  } catch {
    return null;
  }
  // length 在下面被重新声明过？不会：上面是 let length，闭包内只读。
}
