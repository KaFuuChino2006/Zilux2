/**
 * 人声分离（stems）接口客户端：/api/stems 与 /api/stems/audio。
 * 契约见 docs/zilux2-stems-contract.md。
 *
 * 设计：
 * - 窗口 30 s，窗口号 w = floor(positionSec / 30)；
 * - /api/stems 返回 JSON 状态（ready / computing / busy / model-missing / error），
 *   ready 之后同一窗口可用 /api/stems/audio 取 WAV；
 * - 音频只取一次、decodeAudioData 成 AudioBuffer，交给 stemsDeck 排程。
 */

import { relOf } from '../ui/local';
import { api, onlineEndpoint, qualityForSource } from '../online/client';
import type { OnlineTrack } from '../online/types';

/** 分离窗口长度（秒），与宿主契约 §2 一致。 */
export const STEM_WINDOW_SEC = 30;

export type StemsState = 'ready' | 'computing' | 'busy' | 'model-missing' | 'model-downloading' | 'error';

export interface StemsPrepareResponse {
  state: StemsState;
  window: number;
  windowSec?: number;
  frames?: number;
  cached?: boolean;
  ms?: number;
  retryAfterMs?: number;
  message?: string;
  downloadUrl?: string;
  sha256?: string;
  /** model-downloading 时的下载进度（0~1）与字节数。 */
  progress?: number;
  bytes?: number;
  total?: number;
  /** 四轨残差归位前的重建误差（dBFS）；2 轨请求与旧缓存没有这个字段。 */
  reconErrorDbfs?: number;
}

/** /api/stems/model 的状态体（模型随包发布时恒为 ready）。 */
export interface StemModelStatus {
  state: 'idle' | 'downloading' | 'verifying' | 'ready' | 'failed';
  ready: boolean;
  bytes?: number;
  total?: number;
  attempt?: number;
  message?: string;
  downloadUrl?: string;
  sha256?: string;
}

/** 可取的轨：2 轨模式是 vocals/instrumental；4 轨模式另有 drums/bass/other。 */
export type StemPart = 'vocals' | 'instrumental' | 'drums' | 'bass' | 'other';

const SPEED_KEY = 'zilux2.stemSpeedMs';

/** 最近一次分离耗时（折算到 30 s 窗口的毫秒数），用于按本机实际速度估算提示文案。 */
function readSpeed(): number {
  try {
    const value = Number(localStorage.getItem(SPEED_KEY));
    return Number.isFinite(value) && value > 200 ? value : 0;
  } catch {
    return 0;
  }
}

function recordSpeed(ms: number, windowSec: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const perWindow = (ms * STEM_WINDOW_SEC) / Math.max(1, windowSec);
  const prev = readSpeed();
  const next = prev > 0 ? Math.round(prev * 0.4 + perWindow * 0.6) : Math.round(perWindow);
  try {
    localStorage.setItem(SPEED_KEY, String(next));
  } catch {
    /* 忽略 */
  }
}

/**
 * 首次分离预计等待秒数：优先用本机实测速度（跨会话记住），
 * 没测过时按 CPU 线程数粗估，最后才落回 7 s。
 */
export function estimateStemWaitSeconds(): number {
  const measured = readSpeed();
  if (measured > 0) return Math.min(120, Math.max(2, Math.round(measured / 1000)));
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 8 : 8;
  return Math.min(30, Math.max(3, Math.round(210 / Math.sqrt(Math.max(2, cores)))));
}

/**
 * 确认分离模型可用：随包发布时一次 GET 就返回 ready；安装包不带模型时
 * 走 POST /api/stems/model 触发宿主下载（约 130 MB），期间按 retryAfterMs 轮询并回报进度。
 * 返回 false 表示下载失败（调用方回退到原声并提示）。
 */
let stemsModelReady = false;

export async function ensureStemModel(
  onProgress?: (status: StemModelStatus) => void,
): Promise<boolean> {
  if (stemsModelReady) return true;
  let status = await api<StemModelStatus>('/api/stems/model', {}, 15_000);
  if (status.ready) {
    stemsModelReady = true;
    return true;
  }
  if (status.state !== 'downloading' && status.state !== 'verifying') {
    status = await api<StemModelStatus>('/api/stems/model', {}, 15_000, 'POST');
  }
  onProgress?.(status);
  // 130 MB：慢网也要给足时间，15 分钟封顶；每次失败由宿主换镜像重试。
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (status.ready) {
      stemsModelReady = true;
      return true;
    }
    if (status.state === 'failed') return false;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 600));
    status = await api<StemModelStatus>('/api/stems/model', {}, 15_000);
    onProgress?.(status);
  }
  return false;
}

export function stemWindowIndex(positionSec: number): number {  if (!Number.isFinite(positionSec) || positionSec < 0) return 0;
  return Math.floor(positionSec / STEM_WINDOW_SEC);
}

/** 宿主需要的曲目定位参数，与 /api/analysis 同一套（本地 rel / 在线 source+id+quality）。 */
function trackParams(track: OnlineTrack): Record<string, string> | null {
  if (track.source === 'local') {
    const rel = relOf(track);
    if (!rel) return null;
    return { source: 'local', rel };
  }
  return {
    source: String(track.source),
    id: track.id,
    quality: qualityForSource(String(track.source)),
  };
}

/**
 * 请求宿主准备一个窗口。首次调用会同步算完再返回（约 7 s，超时给 60 s），
 * 期间调用方应继续用 EQ 兜底（见 audioTap.setVocalFade）。
 */
export async function prepareStemsWindow(
  track: OnlineTrack,
  window: number,
  options: { force?: boolean; windowSec?: number; stems?: 2 | 4 } = {},
): Promise<StemsPrepareResponse> {
  const params = trackParams(track);
  if (!params) throw new Error('这首曲目缺少文件路径，无法做人声分离');
  params.window = String(Math.max(0, Math.floor(window)));
  params.windowSec = String(Math.round(options.windowSec ?? STEM_WINDOW_SEC));
  if (options.force) params.force = '1';
  // 4 轨模式必须先声明，否则宿主只算 2 轨、随后取 drums/bass/other 会 409（v2 T2-3）。
  if (options.stems === 4) params.stems = '4';
  const windowSec = Math.round(options.windowSec ?? STEM_WINDOW_SEC);
  const response = await api<StemsPrepareResponse>('/api/stems', params, 60_000);
  // cached 命中是旧的耗时，不参与估算；只记真正算过的一次。
  if (!response.cached && response.ms) recordSpeed(response.ms, windowSec);
  return response;
}

/** 取一个窗口的一轨 WAV 并解码；未就绪时抛错（调用方按状态回退）。 */export async function loadStemWindow(
  context: AudioContext,
  track: OnlineTrack,
  window: number,
  part: StemPart,
  options: { stems?: 2 | 4 } = {},
): Promise<AudioBuffer> {
  const params = trackParams(track);
  if (!params) throw new Error('这首曲目缺少文件路径，无法做人声分离');
  params.window = String(Math.max(0, Math.floor(window)));
  // 音频端必须和准备端用同一个 windowSec：曲尾短窗口的帧数不足 30 s，
  // 不带这个参数时宿主会按默认窗口找文件、直接 404。
  params.windowSec = String(Math.round(STEM_WINDOW_SEC));
  params.stem = part;
  // 4 轨模式要显式声明：宿主按 stems 决定找哪套缓存文件（v2 T2-3）。
  if (options.stems === 4) params.stems = '4';
  const url = onlineEndpoint('/api/stems/audio', params);
  if (!url) throw new Error('在线源尚未就绪');
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`分离音轨未就绪（HTTP ${response.status}）`);
  }
  const bytes = await response.arrayBuffer();
  return context.decodeAudioData(bytes.slice(0));
}

/** 同时取一个窗口的两轨（vocals / instrumental）。 */
export async function loadStemWindowBoth(
  context: AudioContext,
  track: OnlineTrack,
  window: number,
): Promise<{ vocals: AudioBuffer; instrumental: AudioBuffer }> {
  const [vocals, instrumental] = await Promise.all([
    loadStemWindow(context, track, window, 'vocals'),
    loadStemWindow(context, track, window, 'instrumental'),
  ]);
  return { vocals, instrumental };
}

/**
 * 四轨窗口（内部测试版实时推拉用）：drums / bass / other / vocals。
 * 宿主未装四轨（老版本/失败）时抛错，调用方回落到 `loadStemWindowBoth`。
 */
export async function loadStemWindowFour(
  context: AudioContext,
  track: OnlineTrack,
  window: number,
  stems = 4,
): Promise<{ drums: AudioBuffer; bass: AudioBuffer; other: AudioBuffer; vocals: AudioBuffer; instrumental?: AudioBuffer }> {
  const [drums, bass, other, vocals] = await Promise.all([
    loadStemWindow(context, track, window, 'drums', { stems: stems === 4 ? 4 : 2 }),
    loadStemWindow(context, track, window, 'bass', { stems: stems === 4 ? 4 : 2 }),
    loadStemWindow(context, track, window, 'other', { stems: stems === 4 ? 4 : 2 }),
    loadStemWindow(context, track, window, 'vocals', { stems: stems === 4 ? 4 : 2 }),
  ]);
  return { drums, bass, other, vocals };
}
