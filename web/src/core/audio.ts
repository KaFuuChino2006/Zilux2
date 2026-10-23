/**
 * 音频特征：宿主用 WASAPI 环回采集，以 {type:'host', event:'audio'} 30Hz 推给页面
 * （bins[64] / bands[8] / level / peak / beat）。这里只保留最近一帧并广播给订阅者。
 * 本地预览（?mock=1&audiomock=1）会生成一条假数据，方便没有音频设备时验收动效。
 */

import { host } from './bridge';

export interface AudioFrame {
  bins: number[];
  bands: number[];
  level: number;
  peak: number;
  beat: boolean;
}

type Listener = (frame: AudioFrame) => void;

const EMPTY: AudioFrame = { bins: [], bands: [], level: 0, peak: 0, beat: false };

let frame: AudioFrame = EMPTY;
let beatAt = 0;
let initialized = false;
const listeners = new Set<Listener>();

export function initAudio(): void {
  if (initialized) return;
  initialized = true;

  host.onMessage((message) => {
    if (message.type !== 'host' || message.event !== 'audio') return;
    const payload = message.payload as
      | { bins?: unknown; bands?: unknown; level?: unknown; peak?: unknown; beat?: unknown }
      | undefined;
    if (!payload || !Array.isArray(payload.bins)) return;
    const numbers = (list: unknown[]): number[] =>
      list.map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0));
    frame = {
      bins: numbers(payload.bins),
      bands: Array.isArray(payload.bands) ? numbers(payload.bands) : [],
      level: typeof payload.level === 'number' ? payload.level : 0,
      peak: typeof payload.peak === 'number' ? payload.peak : 0,
      beat: payload.beat === true,
    };
    if (frame.beat) beatAt = performance.now();
    listeners.forEach((listener) => listener(frame));
  });

  const params = new URLSearchParams(window.location.search);
  if (params.get('mock') === '1' && params.get('audiomock') === '1') {
    window.setInterval(() => {
      const t = performance.now() / 1000;
      const bands = Array.from({ length: 8 }, (_, index) => {
        const phase = t * (1.1 + index * 0.23) + index * 1.7;
        return Math.max(0, Math.min(1, 0.32 + 0.3 * Math.sin(phase) + 0.18 * Math.sin(phase * 2.7)));
      });
      const level = Math.max(0, Math.min(1, 0.3 + 0.28 * Math.sin(t * 1.7)));
      frame = {
        bins: Array.from({ length: 64 }, (_, index) => bands[index % bands.length] ?? 0),
        bands,
        level,
        peak: Math.min(1, level * 1.2),
        beat: Math.floor(t * 2) !== Math.floor((t - 0.034) * 2),
      };
      if (frame.beat) beatAt = performance.now();
      listeners.forEach((listener) => listener(frame));
    }, 33);
  }
}

export function audioFrame(): AudioFrame {
  return frame;
}

export function onAudioFrame(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 距离上一次 beat 的毫秒数；没有 beat 时返回一个很大的值。 */
export function audioBeatAgo(): number {
  return beatAt === 0 ? Number.POSITIVE_INFINITY : performance.now() - beatAt;
}

/* 兼容旧页面（heroScene / lyricsStage / splashScene / nowPlayingPage）的旧 API */
export function latestAudio(): AudioFrame {
  return frame;
}

export function audioAvailable(): boolean {
  return frame.bins.length > 0;
}
