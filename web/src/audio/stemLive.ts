/**
 * 实时分轨监听（连续跟播，不再是「抓 30 秒离线放一遍」）。
 *
 * 为什么能实时：宿主分离一段 30 秒窗口实测 6.7–7.6 s（RTF≈0.23），
 * 也就是「算 7 秒、放 30 秒」——只要提前一个窗口开始算，就不会断。
 * 所以这里的策略是**滚动窗口 + 提前预取**：
 *   1. 起播时取当前位置所在窗口，从当前位置（窗口内偏移）开始排程；
 *   2. 每 350 ms 检查一次：当已排程内容剩余 < 20 s，就把下一窗口（偏移 0）
 *      按「元素时间轴」换算成 context 时间排进去，接缝天然对齐；
 *   3. 页面 seek / 暂停 / 切歌造成的偏差 > 500 ms 时整段重排（resync）。
 *
 * 元素本身由 `audioTap.setStemMonitor(true)` 静音，分轨走 `stemMonitorBus()`，
 * 所以「回到原音」只需把 mute 放开——两条路共享同一级总音量与限幅，响度可比。
 */

import { loadStemWindowFour, prepareStemsWindow, STEM_WINDOW_SEC } from '../core/stemsClient';
import { stemMonitorBus, stemMonitorContext } from '../core/audioTap';
import type { OnlineTrack } from '../online/types';
import type { StemName } from './stemSolo';
import { STEM_NAMES } from './stemSolo';

const WINDOW_MS = STEM_WINDOW_SEC * 1000;
/** 提前多少毫秒开始准备下一窗口（分离一段约 7 s，留足余量）。 */
const PREFETCH_AHEAD_MS = 20_000;
/** 起播提前量：给它 60 ms 把节点接好，避免第一个 buffer 被截头。 */
const LEAD_MS = 60;
/** 元素时间与排程时间偏差超过这个值就整段重排。 */
const DRIFT_TOLERANCE_MS = 500;
const TICK_MS = 350;
const GAIN_MIN_DB = -48;

export interface StemLiveStatus {
  state: 'preparing' | 'playing' | 'paused' | 'stalled' | 'stopped';
  /** 当前正在听的窗口号。 */
  window: number;
  /** 当前窗口内偏移（毫秒）。 */
  windowOffsetMs: number;
  /** 已排程到「当前播放位置之后」多少毫秒（0 = 只排到此刻）。 */
  aheadMs: number;
  /** 本窗口的残差（dBFS，NaN = 旧缓存/未知）。 */
  reconDbfs: number;
  note: string;
}

export interface StemLiveOptions {
  /** 当前曲目（跟播期间可能换歌，每次取都会重新判断）。 */
  getTrack: () => OnlineTrack | null;
  getPositionMs: () => number;
  isPlaying?: () => boolean;
  /** 当前实际倍速（过渡里 B 会被变速，锚点必须按它外推）。 */
  getRate?: () => number;
  gainsDb?: Record<StemName, number>;
  solo?: StemName | null;
  onStatus?: (status: StemLiveStatus) => void;
}

export interface StemLiveHandle {
  setGain(stem: StemName, db: number): void;
  setSolo(stem: StemName | null): void;
  resync(): void;
  dispose(): void;
  status(): StemLiveStatus;
}

interface LiveNodes {
  window: number;
  sources: { stem: StemName; source: AudioBufferSourceNode; gain: GainNode }[];
}

function dbToGain(db: number): number {
  return db <= GAIN_MIN_DB ? 0 : 10 ** (db / 20);
}

export function startStemLive(options: StemLiveOptions): StemLiveHandle | null {
  const bus = stemMonitorBus();
  const ctx = stemMonitorContext();
  if (!bus || !ctx) return null;

  const gains: Record<StemName, number> = { ...(options.gainsDb ?? {}) } as Record<StemName, number>;
  for (const stem of STEM_NAMES) {
    if (!Number.isFinite(gains[stem])) gains[stem] = 0;
  }
  let solo: StemName | null = options.solo ?? null;

  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let nodes: LiveNodes[] = [];
  let scheduledUntilMs = 0;
  let nextWindow = 0;
  let anchorElementMs = 0;
  let anchorCtxSec = 0;
  /** 上一拍的 (位置, context 时间)：用它外推，倍速变化不会误判成 seek。 */
  let lastPos = 0;
  let lastCtxSec = 0;
  /** 当前正在跟的曲目；`playerState` 换了歌就整段重排。 */
  let liveTrack: OnlineTrack | null = null;
  let pendingWindow: number | null = null;
  /** 每次 stopAll（切歌 / 暂停 / resync）自增，用来让在飞的加载结果作废。 */
  let generation = 0;
  let recon = Number.NaN;
  let state: StemLiveStatus['state'] = 'preparing';
  let note = '准备第一个窗口…';
  let paused = false;

  const gainFor = (stem: StemName): number => {
    if (solo && solo !== stem) return 0;
    return dbToGain(gains[stem]);
  };

  const status = (): StemLiveStatus => {
    const pos = Math.max(0, options.getPositionMs());
    const window = Math.floor(pos / WINDOW_MS);
    const ahead = Math.max(0, Math.round(scheduledUntilMs - pos));
    return {
      state: disposed ? 'stopped' : state,
      window,
      windowOffsetMs: Math.round(pos - window * WINDOW_MS),
      aheadMs: ahead,
      reconDbfs: recon,
      note,
    };
  };

  const publish = (): void => {
    options.onStatus?.(status());
  };

  const stopAll = (): void => {
    // 让所有在飞的 scheduleWindow 结果作废：否则切歌瞬间那一次加载完成时，
    // 它会把自己 push 进 nodes 并按旧曲的 context 时间起播——听感是「新歌开头
    // 叠了一下上一首的分轨」。（m08602）
    generation += 1;
    for (const group of nodes) {
      for (const { source, gain } of group.sources) {
        try {
          source.onended = null;
          source.stop();
        } catch {
          /* 已经停了 */
        }
        try {
          source.disconnect();
          gain.disconnect();
        } catch {
          /* 已经断了 */
        }
      }
    }
    nodes = [];
  };

  const scheduleWindow = async (window: number, offsetMs: number, startCtxSec: number): Promise<boolean> => {
    const gen = generation;
    pendingWindow = window;
    try {
      const track = liveTrack;
      if (!track) return false;
      const prepared = await prepareStemsWindow(track, window, { stems: 4 });
      if (disposed || gen !== generation) return false;
      if (prepared.state !== 'ready') {
        state = 'stalled';
        note =
          prepared.state === 'computing' || prepared.state === 'busy'
            ? '宿主还在分离…'
            : prepared.message || '窗口未就绪';
        publish();
        return false;
      }
      if (Number.isFinite(prepared.reconErrorDbfs)) recon = prepared.reconErrorDbfs as number;
      const buffers = await loadStemWindowFour(ctx, track, window, 4);
      if (disposed || gen !== generation) return false;
      const group: LiveNodes = { window, sources: [] };
      const offsetSec = Math.max(0, offsetMs / 1000);
      const lengthSec = Math.max(0.05, (WINDOW_MS - offsetMs) / 1000);
      for (const stem of STEM_NAMES) {
        const buffer = buffers[stem];
        if (!buffer) continue;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = gainFor(stem);
        source.connect(gain);
        gain.connect(bus);
        const startOffset = Math.min(offsetSec, Math.max(0, buffer.duration - 0.02));
        source.start(startCtxSec, startOffset, Math.min(lengthSec, buffer.duration - startOffset));
        source.onended = () => {
          try {
            source.disconnect();
            gain.disconnect();
          } catch {
            /* 已经断了 */
          }
        };
        group.sources.push({ stem, source, gain });
      }
      nodes.push(group);
      // 只保留「还在响」和「刚排上」的两组，避免长时间跑积累节点。
      while (nodes.length > 2) {
        const stale = nodes.shift();
        if (!stale) break;
        for (const { source, gain } of stale.sources) {
          try {
            source.onended = null;
            source.stop();
          } catch {
            /* 已经停了 */
          }
          try {
            source.disconnect();
            gain.disconnect();
          } catch {
            /* 已经断了 */
          }
        }
      }
      state = 'playing';
      note = '实时分轨中';
      publish();
      return true;
    } catch (error) {
      if (disposed) return false;
      state = 'stalled';
      note = error instanceof Error ? error.message : '分轨准备失败';
      publish();
      return false;
    } finally {
      if (pendingWindow === window) pendingWindow = null;
    }
  };

  const resync = (): void => {
    stopAll();
    liveTrack = options.getTrack();
    const pos = Math.max(0, options.getPositionMs());
    lastPos = pos;
    lastCtxSec = ctx.currentTime;
    const window = Math.floor(pos / WINDOW_MS);
    const offsetMs = pos - window * WINDOW_MS;
    const startCtxSec = ctx.currentTime + LEAD_MS / 1000;
    anchorElementMs = pos;
    anchorCtxSec = startCtxSec;
    scheduledUntilMs = (window + 1) * WINDOW_MS;
    nextWindow = window + 1;
    state = 'preparing';
    note = `准备窗口 ${window}…`;
    publish();
    void scheduleWindow(window, offsetMs, startCtxSec);
  };

  const tick = (): void => {
    if (disposed) return;
    const pos = Math.max(0, options.getPositionMs());
    const playing = options.isPlaying ? options.isPlaying() : true;
    const track = options.getTrack();
    const trackChanged =
      (track?.id ?? '') !== (liveTrack?.id ?? '') || (track?.source ?? '') !== (liveTrack?.source ?? '');
    if (trackChanged) {
      resync();
      return;
    }

    if (!playing) {
      if (!paused) {
        paused = true;
        stopAll();
        state = 'paused';
        note = '已暂停';
        publish();
      }
      return;
    }
    if (paused) {
      paused = false;
      resync();
      return;
    }
    if (nodes.length === 0 && pendingWindow === null) {
      resync();
      return;
    }

    // 偏差过大（seek / 切歌）就整段重排。外推用「上一拍 + 当前倍速」，
    // 过渡里 B 的倍速会从 1 变到 1.0x–1.2x，用固定 1 倍会误判成连续 seek。
    const rate = options.getRate ? Math.max(0.25, options.getRate()) : 1;
    const expected = lastPos + (ctx.currentTime - lastCtxSec) * 1000 * rate;
    if (Math.abs(pos - expected) > DRIFT_TOLERANCE_MS) {
      resync();
      return;
    }
    lastPos = pos;
    lastCtxSec = ctx.currentTime;

    // 预取下一窗口：按元素时间轴换算 context 时间，接缝天然对得上。
    if (pendingWindow === null && scheduledUntilMs - pos < PREFETCH_AHEAD_MS) {
      const boundaryElementMs = scheduledUntilMs;
      const atCtxSec = anchorCtxSec + (boundaryElementMs - anchorElementMs) / 1000;
      const window = nextWindow;
      nextWindow += 1;
      scheduledUntilMs = boundaryElementMs + WINDOW_MS;
      // 预取失败（宿主还在分离 / 网络断）时要把游标退回去，否则下一拍会去排 window+1，
      // 这一整个窗口就永久空着了——听感是「分轨试听突然静音 30 秒」。（m08400）
      void scheduleWindow(window, 0, Math.max(ctx.currentTime + 0.02, atCtxSec)).then((ok) => {
        if (ok || disposed) return;
        nextWindow = Math.min(nextWindow, window);
        scheduledUntilMs = Math.min(scheduledUntilMs, boundaryElementMs);
      });
      note = `准备下一窗口 ${window}…`;
      publish();
    }
  };

  timer = setInterval(tick, TICK_MS);
  resync();

  return {
    setGain(stem: StemName, db: number): void {
      gains[stem] = Number.isFinite(db) ? db : 0;
      for (const group of nodes) {
        for (const node of group.sources) {
          if (node.stem !== stem) continue;
          node.gain.gain.setTargetAtTime(gainFor(stem), ctx.currentTime, 0.01);
        }
      }
    },
    setSolo(value: StemName | null): void {
      solo = value;
      for (const group of nodes) {
        for (const node of group.sources) {
          node.gain.gain.setTargetAtTime(gainFor(node.stem), ctx.currentTime, 0.01);
        }
      }
    },
    resync,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      stopAll();
      state = 'stopped';
      note = '已停止';
      publish();
    },
    status,
  };
}
