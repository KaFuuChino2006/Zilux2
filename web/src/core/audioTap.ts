/**
 * 页面侧 PCM 取流（AirPlay 专用）。
 *
 * 投送时不再采集系统环回，而是在页面里把播放器的 <audio> 接进 AudioContext：
 * 一路走本地 gain（投送期间静音），另一路把 PCM 取出来 base64 后经宿主桥发给宿主编码投送。
 * 这样 AirPlay 只拿到本软件的声音，其他应用照常从扬声器播放。
 *
 * 取流优先用 AudioWorklet：它在音频线程里按 128 帧累积到 BLOCK_FRAMES 再交给主线程，主线程忙时
 * 也不会像 ScriptProcessor 那样丢回调（丢回调会让宿主收到的采样率低于实时，PcmRing 逐渐抽干后
 * 变成断续/无声）。AudioWorklet 不可用时回退到 ScriptProcessor。
 */

import { postMessage } from './bridge';
import { registerAppAudioContext } from './audioOutput';
import { bindAirplayMediaFlush, unbindAirplayMediaFlush } from '../airplay';

/** 页面取流的固定目标采样率；宿主按同样格式重采样到 44.1k。 */
const TARGET_RATE = 48000;
/** 每块取流的帧数（48kHz 下约 21ms）；小块更小延迟，宿主侧再攒到 120ms 水位。 */
const BLOCK_FRAMES = 1024;

/**
 * AudioWorklet 处理器源码：把输入按 BLOCK_FRAMES 累积成一块 Int16 交织 PCM，
 * 通过 port 转移给主线程（转移 buffer，零拷贝）。
 */
const WORKLET_SOURCE = `
class ZiluxTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = ${BLOCK_FRAMES};
    this.left = new Float32Array(this.block);
    this.right = new Float32Array(this.block);
    this.filled = 0;
    this.port.onmessage = (event) => {
      const next = Number(event.data && event.data.block);
      if (Number.isFinite(next) && next >= 128 && next <= 8192 && next !== this.block) {
        this.block = Math.round(next);
        this.left = new Float32Array(this.block);
        this.right = new Float32Array(this.block);
        this.filled = 0;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    if (!left) return true;
    const right = input.length > 1 ? input[1] : left;
    let offset = 0;
    while (offset < left.length) {
      const take = Math.min(left.length - offset, this.block - this.filled);
      this.left.set(left.subarray(offset, offset + take), this.filled);
      this.right.set(right.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.block) {
        const pcm = new Int16Array(this.block * 2);
        for (let i = 0; i < this.block; i += 1) {
          const l = this.left[i] ?? 0;
          const r = this.right[i] ?? 0;
          const lc = l < -1 ? -1 : l > 1 ? 1 : l;
          const rc = r < -1 ? -1 : r > 1 ? 1 : r;
          pcm[i * 2] = lc < 0 ? lc * 0x8000 : lc * 0x7fff;
          pcm[i * 2 + 1] = rc < 0 ? rc * 0x8000 : rc * 0x7fff;
        }
        this.port.postMessage({ pcm }, [pcm.buffer]);
        this.left = new Float32Array(this.block);
        this.right = new Float32Array(this.block);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('zilux-tap', ZiluxTapProcessor);
`;

let audio: HTMLAudioElement | null = null;
let context: AudioContext | null = null;
let mediaSource: MediaElementAudioSourceNode | null = null;
let localGain: GainNode | null = null;
/** 交叉淡化用的混音入口：所有 deck 的 gain 先汇到这里，再统一进 EQ / 本地 gain。 */
let deckMix: GainNode | null = null;
/** 已接进图的 deck 源节点缓存（同一元素只能建一次 MediaElementAudioSourceNode）。 */
interface DeckGraphNodes {
  source: MediaElementAudioSourceNode;
  /** 「交融」风格的低通/高通互补扫频：A 逐渐闷掉、B 逐渐变亮，两首频谱错开后叠在一起也不糊。 */
  lowpass: BiquadFilterNode;
  highpass: BiquadFilterNode;
  /** 「交融」风格的低频架（120 Hz）：在 75% 处做低频交接（A 的底鼓退出、B 的底鼓接管）。 */
  bass: BiquadFilterNode;
  /** 人声/伴奏分离用的低架/高架滤波 + 1.8 kHz 临场感峰：过渡时压低伴奏、抬高人中频。 */
  low: BiquadFilterNode;
  high: BiquadFilterNode;
  /** 1.8 kHz 临场感（峰形 EQ）：歌词衔接时抬高，让人声更靠前。 */
  presence: BiquadFilterNode;
  /** 单个 deck 的响度补偿（线性增益）：每首曲子独立对齐 LUFS，随 deck 切换各带各的补偿。 */
  trim: GainNode;
  match: GainNode;
  matchSource?: string;
  gain: GainNode;
  /** 元素取流支路：真实人声分离接管时降到 0，让分离音轨独占输出。 */
  mixGain: GainNode;
  /** 分离音轨汇入支路：stemsDeck 把 AudioBufferSourceNode 接到这里，与元素走同一条滤镜链。 */
  stemGain: GainNode;
}

/** 滤波器频率下限/上限（Hz）：exponentialRamp 不接受 0，20 Hz 以下对听感也没有意义。 */
const FILTER_FREQ_MIN = 20;
const FILTER_FREQ_MAX = 20000;
/** 「低频交接」用的低架滤波中心频率（Hz）。 */
const BASS_SHELF_FREQ = 120;
const deckNodes = new Map<HTMLAudioElement, DeckGraphNodes>();
let workletNode: AudioWorkletNode | null = null;
let processor: ScriptProcessorNode | null = null;
let silentGain: GainNode | null = null;
let analyser: AnalyserNode | null = null;
let analyserSink: GainNode | null = null;
let running = false;
let pendingStart = false;
/** 播放器音量（0~1），取流期间本地 gain 恒为 0，停止取流后回落到这个值。 */
let localVolume = 1;

/** 10 段均衡器中心频率（Hz），与设置里的 eqGains 顺序一致。 */
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
const EQ_Q = 1.1;
const EQ_GAIN_LIMIT = 12;

let eqFilters: BiquadFilterNode[] = [];
let eqEnabled = false;
let eqGains: number[] = EQ_FREQS.map(() => 0);

// 人声保留淡出：暂停时压低低频/高频，让中频人声多留一会儿。
let vocalLow: BiquadFilterNode | null = null;
let vocalHigh: BiquadFilterNode | null = null;
let loudnessGain: GainNode | null = null;
let nightCompressor: DynamicsCompressorNode | null = null;
/** 0=正常，1=最大程度压低伴奏；由 player.ts 在淡出时推动。 */
let vocalFadeAmount = 0;
/** 低频/高频最大衰减量（dB），只压伴奏不碰中频人声。 */
const VOCAL_FADE_MAX_DB = 36;

/** 记录播放器元素；<audio> 只创建一次，MediaElementAudioSourceNode 也只能建一次。 */
export function attachAudioTap(element: HTMLAudioElement): void {
  const previous = audio;
  audio = element;
  // 接收端缓冲里的旧音频必须靠 FLUSH 清掉；绑定是幂等的，换 deck 也不会重复监听。
  bindAirplayMediaFlush(element);
  localVolume = Number.isFinite(element.volume) ? element.volume : 1;
  // 图已建立（EQ / 人声保留淡出 / 歌词页分析器已启用）时，新上场的 deck 也要接回图里：
  // 一是音量继续由本地 gain 接管，二是歌词页的频谱分析器能持续拿到声音。
  if (deckMix) {
    attachDeckToGraph(element);
    if (previous && previous !== element) setDeckGraphGain(previous, 0);
  }
}

/** 取流图是否已建立（建立后 @audio 的输出改走 Web Audio，音量由本地 gain 接管）。 */
export function audioTapGraphActive(): boolean {
  return mediaSource !== null;
}

/**
 * 确保播放器的本地音频图已建立，并返回共享 AudioContext。
 * 麦克风混音从这里取本软件的音乐（不采集系统里其它应用的声音）。
 */
export function ensureAppAudioGraph(): AudioContext | null {
  const ctx = ensureContext();
  if (!ctx) return null;
  if (!buildLocalGraph(ctx)) return null;
  return ctx;
}

/** 音乐混音取流点：EQ / 响度处理之后、本地音量之前；调用方只 connect，不要 disconnect。 */
export function appMusicOutputNode(): AudioNode | null {
  return nightCompressor;
}

/** 诊断：当前本地播放图状态（麦克风混音排查用）。 */
export function audioTapState(): { running: boolean; localVolume: number; localGain: number; context: string } {
  return {
    running,
    localVolume,
    localGain: localGain?.gain.value ?? -1,
    context: context?.state ?? 'none',
  };
}

/**
 * 单个 deck 的图内链路：源 → 低通 → 高通 → 低频架 → 低架（伴奏）→ 高架（伴奏）→ 临场感 → deck gain。
 * 低通/高通/低频架平时直通（20 kHz / 20 Hz / 0 dB），只在「交融」风格过渡期间做互补扫频与低频交接；
 * 搁架滤波平时 0 dB（直通），只在交叉淡化期间用来做人声/伴奏分离。
 */
function buildDeckChain(
  ctx: AudioContext,
  source: AudioNode,
): {
  chain: {
    lowpass: BiquadFilterNode;
    highpass: BiquadFilterNode;
    bass: BiquadFilterNode;
    low: BiquadFilterNode;
    high: BiquadFilterNode;
    presence: BiquadFilterNode;
    trim: GainNode;
    match: GainNode;
    gain: GainNode;
    mixGain: GainNode;
    stemGain: GainNode;
  };
} | null {
  try {
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = FILTER_FREQ_MAX;
    lowpass.Q.value = 0.7071;
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = FILTER_FREQ_MIN;
    highpass.Q.value = 0.7071;
    const bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = BASS_SHELF_FREQ;
    bass.gain.value = 0;
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 180;
    low.gain.value = 0;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 4200;
    high.gain.value = 0;
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 1800;
    presence.Q.value = 0.9;
    presence.gain.value = 0;
    const trim = ctx.createGain();
    trim.gain.value = 1;
    const match = ctx.createGain();
    match.gain.value = 1;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    // 元素与分离音轨在滤镜链前汇合：mixGain 静音元素、stemGain 放行分离音轨，
    // 两条支路共用同一套滤镜/响度补偿，切换时不会绕过 EQ。
    const mixGain = ctx.createGain();
    mixGain.gain.value = 1;
    const stemGain = ctx.createGain();
    stemGain.gain.value = 1;
    source.connect(mixGain);
    mixGain.connect(lowpass);
    stemGain.connect(lowpass);
    lowpass.connect(highpass);
    highpass.connect(bass);
    bass.connect(low);
    low.connect(high);
    high.connect(presence);
    presence.connect(trim);
    trim.connect(match);
    match.connect(gain);
    return { chain: { lowpass, highpass, bass, low, high, presence, trim, match, gain, mixGain, stemGain } };
  } catch (err) {
    console.warn('[audioTap] buildDeckChain failed', err);
    return null;
  }
}

/** 过渡期间允许把伴奏压低的幅度（dB）。超过这个值听起来会像电话音。 */
const DECK_TILT_LIMIT_DB = 12;

/** 设置 deck 的伴奏衰减（负值 = 压低低频/高频，中频人声保留）；未接入图时静默忽略。 */
export function setDeckGraphTilt(element: HTMLAudioElement, lowDb: number, highDb: number): void {
  const node = deckNodes.get(element);
  if (!node) return;
  const clampDb = (value: number): number =>
    Number.isFinite(value) ? Math.max(-DECK_TILT_LIMIT_DB, Math.min(DECK_TILT_LIMIT_DB, value)) : 0;
  try {
    node.low.gain.value = clampDb(lowDb);
    node.high.gain.value = clampDb(highDb);
  } catch {
    /* 忽略 */
  }
}

/**
 * 歌词衔接专用「人声聚焦」：amount=1 时低频压 15 dB、高频压 11 dB，并把 1.8 kHz 临场感
 * 抬高 4.5 dB（≈ 只剩中频人声）；amount=0 恢复直通。比普通 tilt（±12 dB 上限）更狠，
 * 只用在歌词衔接的 B 声部，并随着淡化慢慢打开。
 */
export function setDeckGraphVocalFocus(element: HTMLAudioElement, amount: number): void {
  const node = deckNodes.get(element);
  if (!node) return;
  const a = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
  try {
    node.low.gain.value = -15 * a;
    node.high.gain.value = -11 * a;
    node.presence.gain.value = 4.5 * a;
  } catch {
    /* 忽略 */
  }
}

/**
 * 把一个 deck（<audio>）接进本地 Web Audio 图：源 → 该 deck 的 gain → 混音入口（EQ 前）。
 * 图不存在时会先建图（等价于 ensureEqualizerGraph 的效果）。返回 false 表示图建不起来。
 * 注意：同一个 <audio> 元素只能 createMediaElementSource 一次，所以源节点按元素缓存复用。
 */
export function attachDeckToGraph(element: HTMLAudioElement): boolean {
  const ctx = ensureContext();
  if (!ctx || !buildLocalGraph(ctx)) return false;
  if (!deckMix) return false;
  const existing = deckNodes.get(element);
  if (existing) {
    try {
      existing.gain.connect(deckMix);
    } catch {
      /* 已连接时忽略 */
    }
    element.volume = 1;
    return true;
  }
  try {
    const source = ctx.createMediaElementSource(element);
    const built = buildDeckChain(ctx, source);
    if (!built) return false;
    built.chain.gain.connect(deckMix);
    element.volume = 1;
    deckNodes.set(element, { source, ...built.chain });
    return true;
  } catch (err) {
    console.warn('[audioTap] attachDeckToGraph failed', err);
    return false;
  }
}

/** 某个 deck 是否已经接在 Web Audio 图里（交叉淡化据此决定走图内增益还是元素音量）。 */
export function deckGraphConnected(element: HTMLAudioElement): boolean {
  return deckNodes.has(element);
}

/** 设置 deck 在图里的增益（0~1）；未接入图时静默忽略。rampMs>0 时线性过渡。 */
export function setDeckGraphGain(element: HTMLAudioElement, value: number, rampMs = 0): void {
  const node = deckNodes.get(element);
  if (!node) return;
  const target = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const param = node.gain.gain;
  try {
    const now = node.gain.context.currentTime;
    param.cancelScheduledValues(now);
    if (rampMs > 0) {
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(target, now + rampMs / 1000);
    } else {
      param.value = target;
    }
  } catch {
    /* 忽略 */
  }
}

/** 分离音轨汇入点：stemsDeck 把 AudioBufferSourceNode 连到这里；图未建立时返回 null。 */
export function deckStemInput(element: HTMLAudioElement): GainNode | null {
  return deckNodes.get(element)?.stemGain ?? null;
}

/** deck 的 AudioContext 时钟（用于把分离音轨排到与元素同一时间轴上）。 */
export function deckContextTime(element: HTMLAudioElement): number | null {
  const node = deckNodes.get(element);
  return node ? node.gain.context.currentTime : null;
}

/** deck 所在的 AudioContext（分离音轨解码/排程用）；未接入图时返回 null。 */
export function deckAudioContext(element: HTMLAudioElement): AudioContext | null {
  const node = deckNodes.get(element);
  return node ? (node.gain.context as AudioContext) : null;
}

function rampGain(param: AudioParam, target: number, rampMs: number, now: number): void {
  try {
    param.cancelScheduledValues(now);
    if (rampMs > 0) {
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(target, now + rampMs / 1000);
    } else {
      param.value = target;
    }
  } catch {
    /* 忽略 */
  }
}

/**
 * 真实人声分离接管时把元素支路静音（mixGain→0），分离结束后再交还（→1）。
 * 静音期间元素仍在走播放时间轴，时间不会漂移。
 */
export function setDeckMixGain(element: HTMLAudioElement, value: number, rampMs = 0): void {
  const node = deckNodes.get(element);
  if (!node) return;
  const target = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  rampGain(node.mixGain.gain, target, rampMs, node.gain.context.currentTime);
}

/** 设置分离音轨支路增益（0~1），用于淡入淡出两轨的交接。 */
export function setDeckStemGain(element: HTMLAudioElement, value: number, rampMs = 0): void {
  const node = deckNodes.get(element);
  if (!node) return;
  const target = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  rampGain(node.stemGain.gain, target, rampMs, node.gain.context.currentTime);
}

/**
 * 设置单个 deck 的响度补偿（dB，线性折算后写进图里的 trim 节点）。
 * 每首曲子各带各的补偿，过渡期间两个 deck 分别对齐自己的目标响度，切歌时不会因为
 * 「全局增益换值 + 过渡 trim 同时消失」而出现音量台阶。
 */export function setDeckTrimGain(element: HTMLAudioElement, db: number): void {
  const node = deckNodes.get(element);
  if (!node) return;
  if (node.matchSource !== element.src) {
    node.matchSource = element.src;
    node.match.gain.cancelScheduledValues(context?.currentTime ?? 0);
    node.match.gain.setValueAtTime(1, context?.currentTime ?? 0);
  }
  const clamped = Number.isFinite(db) ? Math.max(-18, Math.min(12, db)) : 0;
  const target = Math.pow(10, clamped / 20);
  try {
    node.trim.gain.cancelScheduledValues(context ? context.currentTime : 0);
    node.trim.gain.setTargetAtTime(target, context ? context.currentTime : 0, 0.08);
  } catch {
    try {
      node.trim.gain.value = target;
    } catch {
      /* 忽略 */
    }
  }
}

/** Separate from track normalization: hold the regional correction across the transition,
 * then return to neutral over four seconds. Deck commit must not cancel this envelope. */
export function scheduleDeckMatch(element: HTMLAudioElement, clock: number, db: number, fadeMs: number): void {
  const node = deckNodes.get(element);
  if (!node) return;
  const gain = 10 ** (Math.max(-3, Math.min(3, Number.isFinite(db) ? db : 0)) / 20);
  const param = node.match.gain;
  param.cancelScheduledValues(clock);
  param.setValueAtTime(gain, clock);
  param.setValueAtTime(gain, clock + fadeMs / 1000);
  param.exponentialRampToValueAtTime(1, clock + fadeMs / 1000 + 4);
}

/** 调试：各 deck 的响度补偿（dB）与当前增益，供 CDP 验收用。 */
export function readDeckTrimState(): { src: string; trimDb: number; gain: number }[] {
  return [...deckNodes.entries()].map(([element, node]) => ({
    src: (element.currentSrc || element.src || '').slice(-48),
    trimDb: Math.round(20 * Math.log10(Math.max(1e-6, node.trim.gain.value)) * 10) / 10,
    gain: Math.round(node.gain.gain.value * 1000) / 1000,
  }));
}
(window as unknown as { __ziluxDeckTrim?: () => unknown }).__ziluxDeckTrim = readDeckTrimState;

/**
 * 冻结某个 AudioParam 上已经排好的自动化：停在当前值、丢掉后面的事件。
 * cancelAndHoldAtTime 能把正在进行的斜坡停在当前位置；老内核没有它时退回 cancelScheduledValues。
 */function freezeParam(param: AudioParam, now: number): void {
  try {
    const holder = param as AudioParam & { cancelAndHoldAtTime?: (when: number) => AudioParam };
    if (typeof holder.cancelAndHoldAtTime === 'function') holder.cancelAndHoldAtTime(now);
    else param.cancelScheduledValues(now);
  } catch {
    /* 忽略：个别内核在时间点早于当前时刻时会抛错 */
  }
}

/** 当前音频时钟（秒）；图没建立时返回 null（此时只能走元素音量路径）。 */
export function audioTapClock(): number | null {
  if (!context) return null;
  return Number.isFinite(context.currentTime) ? context.currentTime : null;
}

/** 「交融」风格的滤波/低频控制点：atMs 是相对淡化起点的毫秒数。 */
export interface DeckBandPoint {
  atMs: number;
  /** 低通截止频率（Hz）：20000 = 直通，越低越闷 */
  lowpassHz?: number;
  /** 高通截止频率（Hz）：20 = 直通，越高越只剩高频 */
  highpassHz?: number;
  /** 低频架（120 Hz）增益（dB）：0 = 直通，负值 = 抽掉底鼓 */
  bassDb?: number;
}

/**
 * 把一组滤波/低频控制点一次性排到 deck 的 AudioParam 时间线：
 * 频率用 exponentialRamp（等比扫频，听感均匀），低频梯度用 linearRamp。
 * originSec 是「atMs = 0」对应的音频时钟秒数（调用方用 audioTapClock() 取）。
 */
export function scheduleDeckBands(
  element: HTMLAudioElement,
  originSec: number,
  points: readonly DeckBandPoint[],
): void {
  const node = deckNodes.get(element);
  if (!node || !Number.isFinite(originSec)) return;
  const sorted = points.filter((point) => Number.isFinite(point.atMs)).slice().sort((a, b) => a.atMs - b.atMs);
  if (sorted.length === 0) return;
  const timeOf = (ms: number): number => originSec + Math.max(0, ms) / 1000;
  const freq = (hz: number): number => Math.max(FILTER_FREQ_MIN, Math.min(FILTER_FREQ_MAX, hz));
  try {
    for (const point of sorted) {
      const time = timeOf(point.atMs);
      if (point.lowpassHz !== undefined && Number.isFinite(point.lowpassHz)) {
        node.lowpass.frequency.exponentialRampToValueAtTime(freq(point.lowpassHz), time);
      }
      if (point.highpassHz !== undefined && Number.isFinite(point.highpassHz)) {
        node.highpass.frequency.exponentialRampToValueAtTime(freq(point.highpassHz), time);
      }
      if (point.bassDb !== undefined && Number.isFinite(point.bassDb)) {
        node.bass.gain.linearRampToValueAtTime(Math.max(-40, Math.min(12, point.bassDb)), time);
      }
    }
  } catch (err) {
    console.warn('[audioTap] scheduleDeckBands failed', err);
  }
}

/** deck gain 控制点：atMs 是相对淡化起点的毫秒数，gain 是线性幅度（0–1）。 */
export interface DeckGainPoint {
  atMs: number;
  gain: number;
}

/** 把一组增益控制点排到 deck gain 的时间线（线性插值；调用方先给一个起点值）。 */
export function scheduleDeckGain(
  element: HTMLAudioElement,
  originSec: number,
  points: readonly DeckGainPoint[],
): void {
  const node = deckNodes.get(element);
  if (!node || !Number.isFinite(originSec)) return;
  const sorted = points.filter((point) => Number.isFinite(point.atMs)).slice().sort((a, b) => a.atMs - b.atMs);
  const first = sorted[0];
  if (!first) return;
  const timeOf = (ms: number): number => originSec + Math.max(0, ms) / 1000;
  const amp = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);
  try {
    node.gain.gain.setValueAtTime(amp(first.gain), timeOf(first.atMs));
    for (let index = 1; index < sorted.length; index += 1) {
      const point = sorted[index]!;
      node.gain.gain.linearRampToValueAtTime(amp(point.gain), timeOf(point.atMs));
    }
  } catch (err) {
    console.warn('[audioTap] scheduleDeckGain failed', err);
  }
}

/**
 * 撤掉 deck 上所有已排的自动化（增益 / 低通 / 高通 / 低频架），并把滤波与倾斜复位成直通。
 * 取消、收尾、硬切都走这里，避免停在同一首曲子的中途时还带着上一段过渡的扫频。
 */
export function releaseDeckFx(element: HTMLAudioElement, gain?: number): void {
  const node = deckNodes.get(element);
  if (!node) return;
  const now = context?.currentTime ?? 0;
  const amp = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);
  try {
    freezeParam(node.gain.gain, now);
    if (gain !== undefined) node.gain.gain.setValueAtTime(amp(gain), now);
    freezeParam(node.lowpass.frequency, now);
    node.lowpass.frequency.setValueAtTime(FILTER_FREQ_MAX, now);
    freezeParam(node.highpass.frequency, now);
    node.highpass.frequency.setValueAtTime(FILTER_FREQ_MIN, now);
    freezeParam(node.bass.gain, now);
    node.bass.gain.setValueAtTime(0, now);
    node.low.gain.value = 0;
    node.high.gain.value = 0;
    node.presence.gain.value = 0;
  } catch (err) {
    console.warn('[audioTap] releaseDeckFx failed', err);
  }
}

/** 把 deck 从混音入口上摘下来（元素本身保留源节点，下次重新 attach 复用）。 */
export function detachDeckFromGraph(element: HTMLAudioElement): void {
  const node = deckNodes.get(element);
  if (!node) return;
  try {
    // 摘下来时把「交融」的扫频与「人声/伴奏分离」的搁架滤波一起复位，避免下一首继承过渡期的滤镜。
    releaseDeckFx(element);
    node.gain.disconnect();
    node.match.gain.cancelScheduledValues(context?.currentTime ?? 0);
    node.match.gain.setValueAtTime(1, context?.currentTime ?? 0);
  } catch {
    /* 忽略 */
  }
}


/** 同步播放器音量：取流图存在时元素音量固定 1，音量为本地 gain。immediate 时不做平滑，用于消除恢复播放的首帧爆音。 */
export function setAudioTapVolume(value: number, immediate = false): void {
  localVolume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  applyLocalGain(immediate);
}

/** 响度均衡增益（dB）：负值压、正值补；需要图已建立（ensureEqualizerGraph）。 */
export function setLoudnessGainDb(db: number): void {
  if (!context || !loudnessGain) return;
  const target = Math.pow(10, Math.max(-18, Math.min(12, db)) / 20);
  loudnessGain.gain.cancelScheduledValues(context.currentTime);
  loudnessGain.gain.setTargetAtTime(target, context.currentTime, 0.05);
}

/** 夜间模式：打开压缩器，压峰值、抬低处；关闭恢复直通。 */
export function setNightCompressor(on: boolean): void {
  if (!context || !nightCompressor) return;
  nightCompressor.ratio.value = on ? 6 : 1;
  nightCompressor.threshold.value = on ? -20 : -22;
}

/**
 * 设置 10 段均衡器：enabled=false 时所有频段回到 0dB（等同直通）。
 * 音频图尚未建立时只记录偏好，等播放第一次建立 Web Audio 图时再生效。
 */
export function setEqualizer(enabled: boolean, gains: number[] | null | undefined): void {
  eqEnabled = enabled === true;
  if (Array.isArray(gains)) {
    eqGains = EQ_FREQS.map((_, index) => clampEqGain(gains[index]));
  }
  applyEqGains();
}

/**
 * 人声保留淡出：amount=0 正常，1 时把低频（<220Hz）与高频（>4.2kHz）各压低
 * VOCAL_FADE_MAX_DB dB，只留下人声所在的中频；图未建立时只记录偏好。
 */
export function setVocalFade(amount: number): void {
  vocalFadeAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
  applyVocalFade();
}

/**
 * 确保均衡器可用的本地音频图：EQ 只能跑在 Web Audio 里，首次调用会把 <audio> 接进
 * AudioContext（此后音量由本地 gain 接管，播放器侧的 applyPlaybackVolume 已兼容）。
 * 返回 false 表示当前还建不了图（例如 <audio> 尚未 attach）。
 */
export function ensureEqualizerGraph(): boolean {
  const ctx = ensureContext();
  if (!ctx || !buildLocalGraph(ctx)) return false;
  try {
    void ctx.resume();
  } catch {
    // 上下文被策略挂起时，恢复后输出自然生效。
  }
  applyEqGains();
  applyVocalFade();
  return true;
}

/**
 * 歌词页播放效果要的频谱分析器：首次调用时把播放器的输出接进 AudioContext
 * （不改变听感：分析器后面挂 0 增益），返回 AnalyserNode。
 * 和投送取流共用同一个 MediaElementAudioSourceNode，所以也能在投送时用。
 */
export function playbackAnalyser(): AnalyserNode | null {
  const ctx = ensureContext();
  if (!ctx || !buildLocalGraph(ctx) || !mediaSource) return null;
  if (!analyser) {
    try {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.76;
      analyserSink = ctx.createGain();
      analyserSink.gain.value = 0;
      const analyserSource = eqOutput();
      if (!analyserSource) return null;
      analyserSource.connect(analyser);
      analyser.connect(analyserSink);
      analyserSink.connect(ctx.destination);
    } catch (err) {
      console.warn('[audioTap] analyser unavailable', err);
      analyser = null;
      analyserSink = null;
      return null;
    }
  }
  try {
    void ctx.resume();
  } catch {
    // 上下文尚未获准恢复时，频谱只是先读不到数据
  }
  return analyser;
}

export async function startAudioTap(): Promise<void> {
  // wantRunning is set before the async work starts: stopAudioTap may run while this call is
  // awaiting the worklet/graph, and it must be able to cancel the startup (otherwise the local
  // gain would be muted after the cast already failed).
  wantRunning = true;
  if (running || pendingStart) return;
  pendingStart = true;
  try {
    const ctx = ensureContext();
    if (!ctx) {
      reportCaptureFailure('AudioContext 不可用');
      return;
    }
    if (!buildLocalGraph(ctx)) {
      reportCaptureFailure('无法创建本地音频图');
      return;
    }
    const tapReady = await ensureTapGraph(ctx);
    if (!wantRunning) return;
    if (!tapReady) {
      reportCaptureFailure('AudioWorklet 与 ScriptProcessor 均不可用');
      return;
    }
    try {
      await ctx.resume();
    } catch {
      // 上下文被策略挂起时仍继续，下一次 resume 会补上。
    }
    if (!wantRunning) return;
    captureFailureReported = '';
    captureRetryAttempts = 0;
    running = true;
    applyLocalGain();
    postMessage({ v: 1, type: 'audio', action: 'config', rate: ctx.sampleRate, channels: 2 });
  } finally {
    pendingStart = false;
  }
}

let wantRunning = false;

/** 取流失败只上报一次，避免每次重连都重复弹同一个错误。 */
let captureFailureReported = '';

/** 契约 §12.3：采集失败每 5s 重试；页面保持 wantRunning，宿主保持 connecting/streaming。 */
const CAPTURE_RETRY_MS = 5000;
const CAPTURE_MAX_RETRIES = 12;
let captureRetryAttempts = 0;
let captureRetryTimer = 0;

function reportCaptureFailure(reason: string): void {
  if (captureFailureReported !== reason) {
    captureFailureReported = reason;
    postMessage({ v: 1, type: 'audio', action: 'captureError', error: reason });
  }
  scheduleCaptureRetry();
}

function scheduleCaptureRetry(): void {
  if (!wantRunning || running || captureRetryTimer !== 0) return;
  if (captureRetryAttempts >= CAPTURE_MAX_RETRIES) {
    console.warn('[audioTap] capture retry limit reached');
    return;
  }
  captureRetryTimer = window.setTimeout(() => {
    captureRetryTimer = 0;
    if (!wantRunning || running) return;
    captureRetryAttempts += 1;
    void startAudioTap();
  }, CAPTURE_RETRY_MS);
}

export function stopAudioTap(): void {
  wantRunning = false;
  captureRetryAttempts = 0;
  if (captureRetryTimer !== 0) {
    window.clearTimeout(captureRetryTimer);
    captureRetryTimer = 0;
  }
  if (!running) {
    // 起点可能停在半成品（worklet 已建、running 还没置 true），同样要拆掉节点。
    teardownTapNodes();
    return;
  }
  running = false;
  applyLocalGain();
  postMessage({ v: 1, type: 'audio', action: 'reset' });
  teardownTapNodes();
}

/**
 * 拆掉取流支路（worklet / ScriptProcessor / 静音 gain）。
 * Tear the tap branch down so the next start builds a fresh sampler against the live context.
 * Leaving the nodes connected keeps the worklet/processor running for nothing.
 */
function teardownTapNodes(): void {
  try {
    workletNode?.disconnect();
  } catch {
    // already disconnected
  }
  workletNode = null;
  if (processor) {
    try {
      processor.disconnect();
    } catch {
      // already disconnected
    }
    processor.onaudioprocess = null;
    processor = null;
  }
  try {
    silentGain?.disconnect();
  } catch {
    // already disconnected
  }
  silentGain = null;
}

/**
 * 页面卸载时调用（P2-57）：取消在途启动与重试、停掉 worklet、解绑播放事件。
 * 不关闭 AudioContext、也不拆本地 EQ/音量图——那些是页面级共享资源，由宿主页面生命周期决定。
 * 重复调用安全；之后再次 startAudioTap() 会重新建取流支路。
 */
export function disposeAudioTap(): void {
  wantRunning = false;
  captureRetryAttempts = 0;
  captureFailureReported = '';
  if (captureRetryTimer !== 0) {
    window.clearTimeout(captureRetryTimer);
    captureRetryTimer = 0;
  }
  if (running) {
    running = false;
    applyLocalGain();
    postMessage({ v: 1, type: 'audio', action: 'reset' });
  }
  teardownTapNodes();
  if (audio) unbindAirplayMediaFlush(audio);
}

function ensureContext(): AudioContext | null {
  if (context) return context;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    console.warn('[audioTap] AudioContext unavailable');
    return null;
  }
  try {
    context = new Ctor({ sampleRate: TARGET_RATE, latencyHint: 'playback' });
  } catch {
    try {
      context = new Ctor();
    } catch (err) {
      console.warn('[audioTap] AudioContext creation failed', err);
      return null;
    }
  }
  // 本软件输出通道：设备切换时统一改这条 AudioContext 的 sinkId。
  registerAppAudioContext(context);
  return context;
}

/** 本地发声链路：<audio> → 10 段 EQ → 本地 gain → 输出（投送时 gain 归 0 静音本软件）。 */
function buildLocalGraph(ctx: AudioContext): boolean {
  if (!audio) return false;
  if (!mediaSource) {
    try {
      mediaSource = ctx.createMediaElementSource(audio);
    } catch (err) {
      console.warn('[audioTap] createMediaElementSource failed', err);
      mediaSource = null;
      return false;
    }
    const source = mediaSource;
    if (!source) return false;
    // 元素音量改由本地 gain 接管，避免「元素 × gain」双重衰减。
    // 注意：localVolume 可能来自上一次淡出/暂停时的 0；建图瞬间以元素当前音量为准，
    // 否则麦克风混音触发建图后本机音乐会一直是静音。
    const initialVolume = Number.isFinite(audio.volume) ? audio.volume : localVolume;
    localVolume = initialVolume;
    audio.volume = 1;
    localGain = ctx.createGain();
    localGain.gain.value = running ? 0 : initialVolume;
    // 所有 deck 的 gain 先汇到 deckMix，再统一进 EQ：交叉淡化时两首共用同一条 EQ/分析链路。
    deckMix = ctx.createGain();
    deckMix.gain.value = 1;
    const builtDeck = buildDeckChain(ctx, source);
    if (!builtDeck) {
      // Roll the half-built graph back: leaving mediaSource set would make the next call skip
      // construction (and stay silent forever); leaving audio.volume=1 would also lose local volume.
      try {
        source.disconnect();
        localGain.disconnect();
        deckMix.disconnect();
      } catch {
        // nodes may not be connected yet
      }
      mediaSource = null;
      localGain = null;
      deckMix = null;
      deckNodes.clear();
      audio.volume = localVolume;
      return false;
    }
    builtDeck.chain.gain.connect(deckMix);
    deckNodes.set(audio, { source, ...builtDeck.chain });
    // 均衡器始终串在 deckMix 与 localGain 之间：关闭时全部 0dB，等价直通。
    eqFilters = EQ_FREQS.map((freq) => {
      const filter = ctx.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = freq;
      filter.Q.value = EQ_Q;
      filter.gain.value = 0;
      return filter;
    });
    // 人声保留用的一对搁架滤波器：只在淡出时介入，平时 0dB。
    vocalLow = ctx.createBiquadFilter();
    vocalLow.type = 'lowshelf';
    vocalLow.frequency.value = 220;
    vocalLow.gain.value = 0;
    vocalHigh = ctx.createBiquadFilter();
    vocalHigh.type = 'highshelf';
    vocalHigh.frequency.value = 4200;
    vocalHigh.gain.value = 0;
    let tail: AudioNode = deckMix;
    for (const filter of eqFilters) {
      tail.connect(filter);
      tail = filter;
    }
    tail.connect(vocalLow);
    vocalLow.connect(vocalHigh);
    loudnessGain = ctx.createGain();
    loudnessGain.gain.value = 1;
    nightCompressor = ctx.createDynamicsCompressor();
    nightCompressor.threshold.value = -22;
    nightCompressor.knee.value = 12;
    nightCompressor.ratio.value = 1;
    nightCompressor.attack.value = 0.004;
    nightCompressor.release.value = 0.24;
    vocalHigh.connect(loudnessGain);
    loudnessGain.connect(nightCompressor);
    nightCompressor.connect(localGain);
    localGain.connect(ctx.destination);
    applyEqGains();
    applyVocalFade();
  }
  return true;
}

/** 建取流链路：优先 AudioWorklet，失败回退 ScriptProcessor。 */
async function ensureTapGraph(ctx: AudioContext): Promise<boolean> {
  if (workletNode || processor) return true;
  if (await ensureWorklet(ctx)) return true;
  return ensureScriptProcessor(ctx);
}

async function ensureWorklet(ctx: AudioContext): Promise<boolean> {
  if (!mediaSource) return false;
  if (typeof ctx.audioWorklet?.addModule !== 'function') return false;
  let url = '';
  try {
    url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, 'zilux-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    node.port.onmessage = handleWorkletBlock;
    node.port.postMessage({ type: 'setBlock', block: BLOCK_FRAMES });
    silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    (eqOutput() ?? mediaSource).connect(node);
    node.connect(silentGain);
    silentGain.connect(ctx.destination);
    workletNode = node;
    return true;
  } catch (err) {
    console.warn('[audioTap] AudioWorklet unavailable, falling back to ScriptProcessor', err);
    return false;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

function ensureScriptProcessor(ctx: AudioContext): boolean {
  if (!mediaSource) return false;
  try {
    processor = ctx.createScriptProcessor(BLOCK_FRAMES, 2, 2);
    processor.onaudioprocess = handleProcess;
    silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    (eqOutput() ?? mediaSource).connect(processor);
    processor.connect(silentGain);
    silentGain.connect(ctx.destination);
    return true;
  } catch (err) {
    console.warn('[audioTap] ScriptProcessor unavailable', err);
    processor = null;
    return false;
  }
}

function applyLocalGain(immediate = false): void {
  if (!context || !localGain) return;
  const target = running ? 0 : localVolume;
  try {
    if (immediate) {
      localGain.gain.cancelScheduledValues(context.currentTime);
      localGain.gain.setValueAtTime(target, context.currentTime);
    } else {
      localGain.gain.setTargetAtTime(target, context.currentTime, 0.02);
    }
  } catch {
    localGain.gain.value = target;
  }
}

function clampEqGain(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(-EQ_GAIN_LIMIT, Math.min(EQ_GAIN_LIMIT, value));
}

/** 均衡器链路输出节点：建图前回落到 mediaSource，供 analyser / 取流复用。 */
function eqOutput(): AudioNode | null {
  return eqFilters.length > 0 ? eqFilters[eqFilters.length - 1] : mediaSource;
}

function applyEqGains(): void {
  if (!context || eqFilters.length === 0) return;
  const now = context.currentTime;
  eqFilters.forEach((filter, index) => {
    const gain = eqEnabled ? clampEqGain(eqGains[index]) : 0;
    try {
      filter.gain.setTargetAtTime(gain, now, 0.03);
    } catch {
      filter.gain.value = gain;
    }
  });
}

function applyVocalFade(): void {
  if (!context || !vocalLow || !vocalHigh) return;
  const now = context.currentTime;
  const gain = -VOCAL_FADE_MAX_DB * Math.max(0, Math.min(1, vocalFadeAmount));
  for (const filter of [vocalLow, vocalHigh]) {
    try {
      filter.gain.setTargetAtTime(gain, now, 0.03);
    } catch {
      filter.gain.value = gain;
    }
  }
}

function handleWorkletBlock(event: MessageEvent): void {
  if (!running || !context) return;
  const data = event.data as { pcm?: Int16Array } | null;
  const pcm = data?.pcm;
  if (!(pcm instanceof Int16Array) || pcm.length === 0) return;
  postMessage({
    v: 1,
    type: 'audio',
    action: 'push',
    rate: context.sampleRate,
    channels: 2,
    data: encodeBase64(pcm),
  });
}

function handleProcess(event: AudioProcessingEvent): void {
  if (!running || !context) return;
  const input = event.inputBuffer;
  const frames = input.length;
  const channels = Math.min(2, input.numberOfChannels);
  if (frames === 0 || channels === 0) return;
  const pcm = new Int16Array(frames * channels);
  for (let ch = 0; ch < channels; ch += 1) {
    const data = input.getChannelData(ch);
    for (let i = 0; i < frames; i += 1) {
      const raw = data[i] ?? 0;
      const value = raw < -1 ? -1 : raw > 1 ? 1 : raw;
      pcm[i * channels + ch] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
  }
  postMessage({
    v: 1,
    type: 'audio',
    action: 'push',
    rate: context.sampleRate,
    channels,
    data: encodeBase64(pcm),
  });
}

function encodeBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  const chunk = 0x4000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
