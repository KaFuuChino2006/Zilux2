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
/** 0=正常，1=最大程度压低伴奏；由 player.ts 在淡出时推动。 */
let vocalFadeAmount = 0;
/** 低频/高频最大衰减量（dB），只压伴奏不碰中频人声。 */
const VOCAL_FADE_MAX_DB = 36;

/** 记录播放器元素；<audio> 只创建一次，MediaElementAudioSourceNode 也只能建一次。 */
export function attachAudioTap(element: HTMLAudioElement): void {
  audio = element;
  localVolume = Number.isFinite(element.volume) ? element.volume : 1;
}

/** 取流图是否已建立（建立后 @audio 的输出改走 Web Audio，音量由本地 gain 接管）。 */
export function audioTapGraphActive(): boolean {
  return mediaSource !== null;
}

/** 同步播放器音量：取流图存在时元素音量固定 1，音量为本地 gain。immediate 时不做平滑，用于消除恢复播放的首帧爆音。 */
export function setAudioTapVolume(value: number, immediate = false): void {
  localVolume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  applyLocalGain(immediate);
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
  if (running || pendingStart) return;
  pendingStart = true;
  try {
    const ctx = ensureContext();
    if (!ctx || !buildLocalGraph(ctx)) return;
    const tapReady = await ensureTapGraph(ctx);
    if (!tapReady) return;
    try {
      await ctx.resume();
    } catch {
      // 上下文被策略挂起时仍继续，下一次 resume 会补上。
    }
    running = true;
    applyLocalGain();
    postMessage({ v: 1, type: 'audio', action: 'config', rate: ctx.sampleRate, channels: 2 });
  } finally {
    pendingStart = false;
  }
}

export function stopAudioTap(): void {
  if (!running) return;
  running = false;
  applyLocalGain();
  postMessage({ v: 1, type: 'audio', action: 'reset' });
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
    audio.volume = 1;
    localGain = ctx.createGain();
    localGain.gain.value = running ? 0 : localVolume;
    // 均衡器始终串在 source 与 localGain 之间：关闭时全部 0dB，等价直通。
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
    let tail: AudioNode = source;
    for (const filter of eqFilters) {
      tail.connect(filter);
      tail = filter;
    }
    tail.connect(vocalLow);
    vocalLow.connect(vocalHigh);
    vocalHigh.connect(localGain);
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
