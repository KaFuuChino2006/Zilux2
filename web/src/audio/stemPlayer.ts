/**
 * 4 轨播放器（WBS v2 §1.2 P2 / T3-2），支持**跨窗续播**（第 13 轮补充）。
 *
 * 为什么必须单独一个播放器：
 * `<audio>` 元素只能 `createMediaElementSource()` 一次（`web/src/core/audioTap.ts:341`），
 * 而进阶过渡需要四条独立可调的轨。所以 4 轨模式不走元素支路，而是：
 *
 *   1. 用 `/api/stems/audio?stems=4&stem=drums|bass|other|vocals` 取四个 WAV；
 *   2. 各自 `decodeAudioData` 成 `AudioBuffer`；
 *   3. 四个 `AudioBufferSourceNode` 在**同一个 `when`** 上启动，播放偏移相同 → 天然对齐；
 *   4. 每个 source 接到 `DeckStemBus.inputOf(stem)`，由 stemGraph 做音量/回声/ducking。
 *
 * 跨窗续播：一个窗口只有 30 s，而 32 小节模板在 128 BPM 下是 60 s。`loadSpan()` 会把
 * `[startSec, startSec+spanSec)` 覆盖到的每个窗口都装进来，`start()` 按**绝对窗口边界**
 * 给每个窗口排一个 source（`startAt = when + (windowStart - position)/rate`），
 * 所以换窗处没有停顿、也不需要中途解码。
 *
 * 与元素支路的关系：4 轨模式下原 deck 元素必须静音（`element.volume = 0` 而不是 pause，
 * 否则 `currentTime` 不再推进，回退时对不上位置）。这个约束由调用方（T4）保证。
 *
 * 纯函数（`windowStartSec` / `offsetInWindowSec` / `remainingInWindowSec` / `spanWindowsSec`）
 * 单独导出，便于在 node 里直接测，不需要 AudioContext。
 */

import type { OnlineTrack } from '../online/types';
import { STEM_WINDOW_SEC, loadStemWindow, type StemPart } from '../core/stemsClient';
import type { Stem } from '../core/transitionPlan';
import type { DeckStemBus } from './stemGraph';

/** 4 轨模式的轨集合（与宿主 drums/bass/other/vocals 一致）。 */
export const FOUR_STEMS: readonly Stem[] = ['drums', 'bass', 'other', 'vocals'];

/** 一次最多连装几个窗口（再多就回退标准过渡：解码代价撑不住）。 */
export const MAX_SPAN_WINDOWS = 8;

/** 窗口起点（秒）。 */
export function windowStartSec(window: number, windowSec = STEM_WINDOW_SEC): number {
  const w = Number.isFinite(window) ? Math.max(0, Math.floor(window)) : 0;
  return w * windowSec;
}

/** 在窗口内的偏移（秒）；越界按 0 处理。 */
export function offsetInWindowSec(positionSec: number, window: number, windowSec = STEM_WINDOW_SEC): number {
  const start = windowStartSec(window, windowSec);
  const offset = (Number.isFinite(positionSec) ? positionSec : 0) - start;
  return offset > 0 ? offset : 0;
}

/** 距离窗口末还剩多少秒（用于「本窗口快放完了，该预取下一窗」）。 */
export function remainingInWindowSec(positionSec: number, window: number, windowSec = STEM_WINDOW_SEC): number {
  const left = windowSec - offsetInWindowSec(positionSec, window, windowSec);
  return left > 0 ? left : 0;
}

/** `[startSec, startSec+spanSec)` 覆盖到的窗口号（升序，至少一个）。 */
export function spanWindowsSec(startSec: number, spanSec: number, windowSec = STEM_WINDOW_SEC): number[] {
  const w = windowSec > 0 ? windowSec : STEM_WINDOW_SEC;
  const from = Number.isFinite(startSec) ? Math.max(0, startSec) : 0;
  const span = Number.isFinite(spanSec) && spanSec > 0 ? spanSec : 0;
  const first = Math.floor(from / w);
  const last = Math.floor(Math.max(from, from + span - 1e-6) / w);
  const out: number[] = [];
  for (let k = first; k <= last; k += 1) out.push(k);
  return out;
}

export class StemUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'StemUnavailableError';
  }
}

export interface StemPlayerOptions {
  /** 装载哪几轨，默认四轨。 */
  stems?: Stem[];
  /** 是否向宿主声明 stems=4（默认 true；老宿主会在 4 轨请求上返回 400/409）。 */
  fourStem?: boolean;
  /** 覆盖窗口长度（秒），默认 30。 */
  windowSec?: number;
}

export interface StemPlayerStartOptions {
  /** 文件内位置（秒）。 */
  positionSec: number;
  /** `ctx.currentTime` 基准的启动时刻；不给则「尽快」。 */
  when?: number;
  /** 播放速率（BPM 对齐用），默认 1。 */
  rate?: number;
  /** 增益（0~1），默认 1；分轨音量仍由 stemGraph 控制。 */
  gain?: number;
}

type WindowBuffers = Map<Stem, AudioBuffer>;

/**
 * 一个「窗口跨度」的四轨播放器。
 * 生命周期：`load()` / `loadSpan()` → `start()` →（可 `stop()` 再 `start()`）→ `dispose()`。
 */
export class StemPlayer {
  private readonly ctx: AudioContext;
  private readonly stems: Stem[];
  private readonly windowSec: number;
  /** window → (stem → buffer) */
  private readonly windows = new Map<number, WindowBuffers>();
  /** `${window}:${stem}` → source（同一分轨跨窗会有多个 source） */
  private readonly sources = new Map<string, AudioBufferSourceNode>();
  private readonly gains = new Map<Stem, GainNode>();
  private startedAtCtxTime = 0;
  private startedAtPositionSec = 0;
  private playing = false;
  private rate = 1;
  private disposed = false;

  private constructor(
    ctx: AudioContext,
    bus: DeckStemBus,
    stems: Stem[],
    windows: Map<number, WindowBuffers>,
    windowSec: number,
  ) {
    this.ctx = ctx;
    this.stems = stems;
    this.windowSec = windowSec;
    for (const [window, buffers] of windows) this.windows.set(window, buffers);
    for (const stem of stems) {
      const gain = ctx.createGain();
      gain.gain.value = 1;
      gain.connect(bus.inputOf(stem));
      this.gains.set(stem, gain);
    }
  }

  /** 拉取并解码一个窗口的四轨（向后兼容入口，等价于单窗 `loadSpan`）。 */
  static async load(
    ctx: AudioContext,
    track: OnlineTrack,
    window: number,
    bus: DeckStemBus,
    options: StemPlayerOptions = {},
  ): Promise<StemPlayer> {
    const windowSec = options.windowSec ?? STEM_WINDOW_SEC;
    return StemPlayer.loadSpan(ctx, track, windowStartSec(window, windowSec), windowSec, bus, options);
  }

  /**
   * 拉取并解码覆盖 `[startSec, startSec+spanSec)` 的全部窗口。
   * 任一窗口任一轨失败即抛 `StemUnavailableError`（调用方回退标准过渡）。
   */
  static async loadSpan(
    ctx: AudioContext,
    track: OnlineTrack,
    startSec: number,
    spanSec: number,
    bus: DeckStemBus,
    options: StemPlayerOptions = {},
  ): Promise<StemPlayer> {
    const stems = options.stems ?? [...FOUR_STEMS];
    const fourStem = options.fourStem ?? true;
    const windowSec = options.windowSec ?? STEM_WINDOW_SEC;
    const windows = spanWindowsSec(startSec, spanSec, windowSec);
    if (windows.length > MAX_SPAN_WINDOWS) {
      throw new StemUnavailableError(
        `过渡跨度 ${(spanSec / windowSec).toFixed(1)} 窗超过上限 ${MAX_SPAN_WINDOWS} 窗`,
      );
    }
    const loaded = new Map<number, WindowBuffers>();
    for (const window of windows) {
      const settled = await Promise.allSettled(
        stems.map((stem) => loadStemWindow(ctx, track, window, stem as StemPart, fourStem ? { stems: 4 } : {})),
      );
      const failed = stems.filter((_, i) => settled[i].status === 'rejected');
      if (failed.length > 0) {
        const first = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        throw new StemUnavailableError(
          `4 轨音频不可用（失败：${failed.join('/')}；窗口 ${window}）`,
          first.reason,
        );
      }
      const buffers: WindowBuffers = new Map();
      stems.forEach((stem, i) => buffers.set(stem, (settled[i] as PromiseFulfilledResult<AudioBuffer>).value));
      loaded.set(window, buffers);
    }
    return new StemPlayer(ctx, bus, stems, loaded, windowSec);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get stemOrder(): readonly Stem[] {
    return this.stems;
  }

  /** 装了几个窗口（诊断用）。 */
  get windowCount(): number {
    return this.windows.size;
  }

  /** 已加载音频的总时长（秒），用于「够不够放完这次过渡」的自检。 */
  get bufferDurationSec(): number {
    const firstWindow = Math.min(...this.windows.keys());
    const first = this.windows.get(firstWindow)?.get(this.stems[0]);
    if (!first) return 0;
    return first.duration * this.windows.size;
  }

  /**
   * 已装载音频还能放多少**真实秒**（不是文件秒）。
   * 进阶过渡的时长是算出来的（`totalBars × beatMs × 4`），一旦模型/文件比预期短，
   * 分轨会先放完而过渡还没结束 —— 听起来就是「最后半秒突然静音」。调用方拿它做兜底。
   */
  get remainingSec(): number {
    if (!this.playing || this.windows.size === 0) return 0;
    const last = Math.max(...this.windows.keys());
    const end = windowStartSec(last, this.windowSec) + this.windowSec;
    const left = end - this.positionSec;
    return left > 0 ? left / this.rate : 0;
  }

  /**
   * 取该分轨**首个窗口**的前 `maxSamples` 个采样（左右平均），用于低频互相关测量。
   * 只读、不复制整窗（默认 4 s ≈ 192k 采样），没有该轨数据返回 null。
   */
  monoSamples(stem: Stem, maxSamples = 192000): Float32Array | null {
    if (this.windows.size === 0) return null;
    const firstWindow = Math.min(...this.windows.keys());
    const buffer = this.windows.get(firstWindow)?.get(stem);
    if (!buffer) return null;
    const n = Math.min(maxSamples, buffer.length);
    if (!(n > 0)) return null;
    const out = new Float32Array(n);
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    for (let i = 0; i < n; i += 1) out[i] = (left[i] + right[i]) / 2;
    return out;
  }

  private nowSec(): number {
    try {
      const t = this.ctx.currentTime;
      return Number.isFinite(t) ? t : this.startedAtCtxTime;
    } catch {
      return this.startedAtCtxTime;
    }
  }

  get positionSec(): number {
    if (!this.playing) return this.startedAtPositionSec;
    const elapsed = (this.nowSec() - this.startedAtCtxTime) * this.rate;
    return this.startedAtPositionSec + Math.max(0, elapsed);
  }

  /**
   * 启动（或从新位置重启）。
   * 每个窗口的四个 source 共用同一个绝对启动时刻，换窗点按窗口边界对齐 → 无缝且轨间 0 误差。
   */
  start(options: StemPlayerStartOptions): boolean {
    this.stop();
    if (this.disposed) return false;
    const now = this.nowSec();
    const when = Math.max(now, options.when ?? now);
    this.rate = options.rate && options.rate > 0 ? options.rate : 1;
    const positionSec = Math.max(0, options.positionSec);
    this.startedAtPositionSec = positionSec;
    this.startedAtCtxTime = when;

    let expected = 0;
    for (const [window, buffers] of [...this.windows.entries()].sort((a, b) => a[0] - b[0])) {
      const windowStart = windowStartSec(window, this.windowSec);
      const offset = Math.max(0, positionSec - windowStart);
      const lead = Math.max(0, windowStart - positionSec) / this.rate;
      // 整窗都在 positionSec 之前 → 跳过（不回放历史音频）。
      if (windowStart + this.windowSec <= positionSec) continue;
      const anyBuffer = buffers.get(this.stems[0]);
      if (!anyBuffer || offset >= anyBuffer.duration) continue;
      for (const stem of this.stems) {
        const buffer = buffers.get(stem);
        const gain = this.gains.get(stem);
        if (!buffer || !gain) continue;
        // 空轨（0 时长）或偏移已越过该轨末尾：不建 source，让下面的计数校验把它判成失败。
        if (offset >= buffer.duration) continue;
        try {
          const source = this.ctx.createBufferSource();
          source.buffer = buffer;
          source.playbackRate.value = this.rate;
          source.connect(gain);
          gain.gain.value = options.gain ?? 1;
          source.start(when + lead, offset);
          this.sources.set(`${window}:${stem}`, source);
        } catch {
          /* ctx 已关闭 / source 创建失败：按起播失败处理 */
        }
      }
      expected += this.stems.length;
    }

    if (expected === 0) {
      this.stop();
      return false;
    }
    // 少一轨就整体失败：只出声部乐器比回退标准过渡更难听，也更难查。
    if (this.sources.size !== expected) {
      this.stop();
      return false;
    }
    this.playing = true;
    return true;
  }

  /** 立即停止并断开所有 source（保留 buffers，便于再次 start）。 */
  stop(): void {
    for (const source of this.sources.values()) {
      try {
        source.stop();
      } catch {
        /* 已停止 */
      }
      try {
        source.disconnect();
      } catch {
        /* 已断开 */
      }
    }
    this.sources.clear();
    if (this.playing) this.startedAtPositionSec = this.positionSec;
    this.playing = false;
  }

  /** 调整速率（PLL 用）。
   *
   * 只改 `playbackRate` 是不够的：跨窗时每个窗口的启动时刻是**按旧速率**算好的绝对时间
   * （`when + (windowStart - position)/rate`）。速率一变，播放头走到窗口边界的时间就变了，
   * 而已经排好的 source 还按旧时刻起播 —— 结果要么中间空一段（变速变慢），要么新旧两窗
   * 叠着放 200 ms+（变速变快），后者就是 G1「双声」。所以这里必须把**尚未起播**的窗口
   * 重新排时，正在播的窗口则只调速率（不动它的 start，避免咔哒）。
   */
  setRate(rate: number): void {
    if (this.disposed) return;
    // 非法速率整段忽略：宁可保持当前速率，也不要因为一个 NaN 重排掉正在播的排程。
    if (!Number.isFinite(rate) || rate <= 0) return;
    const next = rate;
    const now = this.nowSec();
    const position = this.positionSec;
    const wasPlaying = this.playing;
    this.rate = next;
    this.startedAtPositionSec = position;
    this.startedAtCtxTime = now;

    for (const [key, source] of [...this.sources.entries()]) {
      source.playbackRate.value = next;
      if (!wasPlaying) continue;
      const window = Number(key.slice(0, key.indexOf(':')));
      const windowStart = windowStartSec(window, this.windowSec);
      // 已经在播的窗（边界在当前位置之前）保持原排程。
      if (windowStart <= position + 1e-6) continue;
      // 尚未起播：撤掉旧排程，按新速率重排。
      try {
        source.stop();
      } catch {
        /* 已停止 */
      }
      try {
        source.disconnect();
      } catch {
        /* 已断开 */
      }
      this.sources.delete(key);
      const stem = key.slice(key.indexOf(':') + 1) as Stem;
      const buffers = this.windows.get(window);
      const buffer = buffers?.get(stem);
      const gain = this.gains.get(stem);
      if (!buffer || !gain) continue;
      try {
        const fresh = this.ctx.createBufferSource();
        fresh.buffer = buffer;
        fresh.playbackRate.value = next;
        fresh.connect(gain);
        fresh.start(now + (windowStart - position) / next, 0);
        this.sources.set(key, fresh);
      } catch {
        /* ctx 已关闭：保持已删除状态，由调用方的失败路径处理 */
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    for (const gain of this.gains.values()) {
      try {
        gain.disconnect();
      } catch {
        /* 已断开 */
      }
    }
    this.gains.clear();
    this.windows.clear();
  }
}
