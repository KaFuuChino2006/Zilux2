/**
 * 节拍时钟（第 20 轮 D 的第三层：事件总线）。
 *
 * 宿主以 30Hz 推 audio 帧，其中 beat 是谱通量 onset 检测的结果、bpm 是 onset 间隔推出来的。
 * 这里把「离散的 beat 布尔」变成可持续查询的时钟：
 *   - onBeat / onDownbeat 订阅事件（带延迟补偿）
 *   - beatPhase() 返回当前处在两拍之间的位置 0..1，供 CSS / requestAnimationFrame 做平滑动效
 *   - 没有 beat 数据时（BPM 还是 0）自动退化成「跟随 level 呼吸」，不会让消费端卡住
 */

import { onAudioFrame, type AudioFrame } from './audio';

export interface BeatEvent {
  /** 这一拍估算的真实发生时刻（performance.now()，已扣掉链路延迟）。 */
  at: number;
  /** onset 强度 0..1。 */
  strength: number;
  bpm: number;
  /** 每 4 拍一个重拍。 */
  downbeat: boolean;
  /** 自增拍号。 */
  index: number;
}

type BeatListener = (event: BeatEvent) => void;

/** 宿主 30Hz 推送 + WASAPI 环回；经验值 45ms，用于把事件时间往回拉。 */
const LATENCY_COMPENSATION_MS = 45;
/** 没有新 beat 时，按 BPM 预测最多补这么多拍就不再补（防止静音后无限空转）。 */
const MAX_PREDICTED_MISSES = 2;

let lastBeatAt = 0;
let lastBpm = 0;
let beatIndex = 0;
let predictedMisses = 0;
let strength = 0;
let started = false;

const beatListeners = new Set<BeatListener>();
const downbeatListeners = new Set<BeatListener>();

function emit(at: number, level: number, bpm: number, isDownbeat: boolean): void {
  const event: BeatEvent = { at, strength: level, bpm, downbeat: isDownbeat, index: beatIndex++ };
  beatListeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      /* 单个消费端出错不能拖垮总线 */
    }
  });
  if (isDownbeat) {
    downbeatListeners.forEach((listener) => {
      try {
        listener(event);
      } catch {
        /* 同上 */
      }
    });
  }
}

function handleFrame(frame: AudioFrame): void {
  if (frame.bpm > 0) lastBpm = frame.bpm;
  strength = frame.strength;
  if (!frame.beat) return;

  const now = performance.now();
  lastBeatAt = now - LATENCY_COMPENSATION_MS;
  predictedMisses = 0;
  emit(lastBeatAt, Math.max(0.15, Math.min(1, frame.strength || 0.5)), lastBpm, beatIndex % 4 === 0);
}

/** 订阅每一拍。返回取消订阅函数。 */
export function onBeat(listener: BeatListener): () => void {
  startBeatClock();
  beatListeners.add(listener);
  return () => beatListeners.delete(listener);
}

/** 订阅重拍（每 4 拍）。 */
export function onDownbeat(listener: BeatListener): () => void {
  startBeatClock();
  downbeatListeners.add(listener);
  return () => downbeatListeners.delete(listener);
}

/**
 * 当前处在两拍之间的位置：0 表示刚过一拍，0.5 表示在两拍正中间。
 * BPM 未知（还在等第一个 onset）时返回 0。
 */
export function beatPhase(): number {
  if (lastBeatAt === 0 || lastBpm <= 0) return 0;
  const interval = 60000 / lastBpm;
  const elapsed = performance.now() - LATENCY_COMPENSATION_MS - lastBeatAt;
  if (elapsed < 0) return 0;
  return (elapsed % interval) / interval;
}

/** 距离上一拍的毫秒数；没有数据时为 Infinity。 */
export function beatAgo(): number {
  return lastBeatAt === 0 ? Number.POSITIVE_INFINITY : performance.now() - LATENCY_COMPENSATION_MS - lastBeatAt;
}

export function currentBpm(): number {
  return lastBpm;
}

export function beatStrength(): number {
  return strength;
}

/**
 * 预测节拍：当宿主推来的 beat 稀疏或抖动时，用 BPM 在拍与拍之间补齐，
 * 让绑定节拍的动效不会「一顿一顿」。由消费端的动画循环调用。
 */
export function tickPrediction(): void {
  if (lastBpm <= 0 || lastBeatAt === 0) return;
  const interval = 60000 / lastBpm;
  const elapsed = performance.now() - LATENCY_COMPENSATION_MS - lastBeatAt;
  if (elapsed < interval * (predictedMisses + 1)) return;
  if (predictedMisses >= MAX_PREDICTED_MISSES) return;
  predictedMisses++;
  emit(lastBeatAt + interval * predictedMisses, Math.max(0.1, strength * 0.5), lastBpm, beatIndex % 4 === 0);
}

export function startBeatClock(): void {
  if (started) return;
  started = true;
  onAudioFrame(handleFrame);
}
