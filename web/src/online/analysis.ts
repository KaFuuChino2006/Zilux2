/**
 * 节拍分析接口（P0）：GET /api/analysis（docs/zilux2-beat-analysis-contract.md §2）。
 *
 * - 本地曲目：source=local&rel=relOf(track)
 * - 在线曲目：source=<track.source>&id=<track.id>&quality=<平台音质>
 *
 * 宿主同步返回（本地约 1–5 s，在线含下载可能更久），所以超时给得比较宽；
 * 结果按「source:id」缓存在内存里，同一首并发请求只发一次（单飞）。
 */

import { relOf } from '../ui/local';
import { OnlineError, api, qualityForSource } from './client';
import type { OnlineTrack } from './types';

/** 契约 §2.1 的 analysis.sections 元素。 */
export interface BeatSection {
  startMs: number;
  endMs: number;
  label: string;
  confidence: number;
}

/** 契约 §2.1 的 analysis 字段。时间基准：相对音频文件起点。 */
export interface BeatAnalysis {
  bpm: number;
  bpmConfidence: number;
  meter: number;
  meterConfidence: number;
  beatIntervalMs: number;
  firstBeatMs: number;
  firstDownbeatMs: number;
  downbeats: number[];
  phraseStartsMs: number[];
  barCount: number;
  sections: BeatSection[];
  warnings: string[];
  /**
   * 最后可听样本位置（ms，相对音频文件起点）。p0-4 起宿主返回：
   * 尾部静音被排除，无尾部静音时 = 文件时长。旧宿主 / 旧缓存缺失，
   * 消费方（交叉淡化调度）按 durationMs 回退。
   */
  audibleEndMs?: number;
  /** 尾部静音时长（ms）= durationMs - audibleEndMs；无尾部静音为 0。缺失时同样回退。 */
  tailSilenceMs?: number;
}

/** 契约 §2.1 成功响应。 */
export interface AnalysisResult {
  v: number;
  ok: true;
  source: string;
  trackId: string;
  rel: string;
  title: string;
  artist: string;
  durationMs: number;
  cached: boolean;
  elapsedMs: number;
  analyzer: string;
  /**
   * p0-4：最后可听样本位置（ms，相对音频文件起点）与尾部静音。宿主放在响应
   * 顶层（与 durationMs 同级）；normalizeResult 会把它注入 analysis 对象，
   * 交叉淡化调度直接读 analysis.audibleEndMs。旧宿主缺失时保持 undefined。
   */
  audibleEndMs?: number;
  tailSilenceMs?: number;
  analysis: BeatAnalysis;
}

export class AnalysisError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
  }
}

/** 宿主分析可能很慢（在线曲目要现下载），给 2 分钟。 */
const ANALYSIS_TIMEOUT_MS = 120_000;

interface AnalysisResponse {
  v?: number;
  ok?: boolean;
  code?: string;
  message?: string;
  source?: string;
  trackId?: string;
  rel?: string;
  title?: string;
  artist?: string;
  durationMs?: number;
  cached?: boolean;
  elapsedMs?: number;
  analyzer?: string;
  /** p0-4：宿主把可听结尾 / 尾部静音放在响应顶层（与 durationMs 同级）。 */
  audibleEndMs?: number;
  tailSilenceMs?: number;
  analysis?: Partial<BeatAnalysis>;
}

const cache = new Map<string, AnalysisResult>();
const inflight = new Map<string, Promise<AnalysisResult>>();

/** 缓存键：本地按 rel（同文件多个 CUE 分轨共享一份分析），在线按 source:id。 */
export function analysisKey(track: OnlineTrack): string {
  if (track.source === 'local') return `local:${relOf(track) ?? track.id}`;
  return `${track.source}:${track.id}`;
}

/** 已分析过的结果（同步）；没有则 null。节拍器用它取拍点网格。 */
export function cachedAnalysis(track: OnlineTrack): AnalysisResult | null {
  return cache.get(analysisKey(track)) ?? null;
}

export function analysisCacheSize(): number {
  return cache.size;
}

/**
 * 分析一首歌。失败抛 AnalysisError（带 code/message）。
 * 同一首正在分析时复用同一个 Promise；默认命中内存缓存。
 */
export async function analyzeTrack(track: OnlineTrack, options: { force?: boolean } = {}): Promise<AnalysisResult> {
  const key = analysisKey(track);
  if (!options.force) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  const running = inflight.get(key);
  if (running) return running;

  const params: Record<string, string> = {};
  if (track.source === 'local') {
    const rel = relOf(track);
    if (!rel) throw new AnalysisError('not-found', '这首本地曲目缺少文件路径，无法分析');
    params.source = 'local';
    params.rel = rel;
  } else {
    params.source = String(track.source);
    params.id = track.id;
    params.quality = qualityForSource(String(track.source));
  }
  if (options.force) params.force = '1';

  const pending = api<AnalysisResponse>('/api/analysis', params, ANALYSIS_TIMEOUT_MS).then(
    (raw) => {
      if (!raw || raw.ok !== true) {
        throw new AnalysisError(raw?.code ?? 'internal-error', raw?.message ?? '节拍分析失败');
      }
      const result = normalizeResult(raw, track);
      cache.set(key, result);
      return result;
    },
    (err: unknown) => {
      throw toAnalysisError(err);
    },
  );
  const tracked = pending.finally(() => {
    if (inflight.get(key) === tracked) inflight.delete(key);
  });
  inflight.set(key, tracked);
  return tracked;
}

function toAnalysisError(err: unknown): AnalysisError {
  if (err instanceof AnalysisError) return err;
  if (err instanceof OnlineError) {
    if (err.code === 'mock-unsupported') return new AnalysisError(err.code, '演示模式下不支持节拍分析');
    return new AnalysisError(err.code, err.message);
  }
  return new AnalysisError('network', err instanceof Error ? err.message : '无法连接宿主，请确认应用已启动');
}

function normalizeResult(raw: AnalysisResponse, track: OnlineTrack): AnalysisResult {
  const source = raw.analysis;
  if (!source || typeof source.beatIntervalMs !== 'number' || !(source.beatIntervalMs > 0)) {
    throw new AnalysisError('bad-response', '宿主返回的分析结果格式不正确');
  }
  const beatIntervalMs = source.beatIntervalMs;
  const firstBeatMs = num(source.firstBeatMs, 0);
  const durationMs = num(raw.durationMs, track.durationMs);
  const analysis: BeatAnalysis = {
    bpm: num(source.bpm, beatIntervalMs > 0 ? 60_000 / beatIntervalMs : 0),
    bpmConfidence: clamp01(num(source.bpmConfidence, 0)),
    meter: num(source.meter, 4),
    meterConfidence: clamp01(num(source.meterConfidence, 0)),
    beatIntervalMs,
    firstBeatMs,
    firstDownbeatMs: num(source.firstDownbeatMs, firstBeatMs),
    downbeats: numbers(source.downbeats),
    phraseStartsMs: numbers(source.phraseStartsMs),
    barCount: num(source.barCount, 0),
    sections: Array.isArray(source.sections)
      ? source.sections.filter((item): item is BeatSection => !!item && typeof item === 'object' && typeof item.startMs === 'number')
      : [],
    warnings: strings(source.warnings),
  };
  // p0-4：可听结尾 / 尾部静音。宿主字段在响应顶层（与 durationMs 同级）；
  // 同时兼容放在 analysis 对象里的写法（防御旧草案）。缺失时保持 undefined，
  // 交叉淡化调度回退 durationMs（task-19 行为不变）。
  const rawAudibleEnd = raw.audibleEndMs ?? source.audibleEndMs;
  if (typeof rawAudibleEnd === 'number' && Number.isFinite(rawAudibleEnd) && rawAudibleEnd > 0) {
    const audibleEndMs = durationMs > 0 ? Math.min(durationMs, rawAudibleEnd) : rawAudibleEnd;
    analysis.audibleEndMs = Math.max(0, audibleEndMs);
    const rawTail = raw.tailSilenceMs ?? source.tailSilenceMs;
    analysis.tailSilenceMs =
      typeof rawTail === 'number' && Number.isFinite(rawTail) && rawTail >= 0
        ? rawTail
        : durationMs > 0
          ? Math.max(0, durationMs - analysis.audibleEndMs)
          : 0;
  }
  return {
    v: num(raw.v, 1),
    ok: true,
    source: raw.source ?? String(track.source),
    trackId: raw.trackId ?? track.id,
    rel: raw.rel ?? '',
    title: raw.title ?? track.title,
    artist: raw.artist ?? track.artist,
    durationMs,
    cached: raw.cached === true,
    elapsedMs: num(raw.elapsedMs, 0),
    analyzer: raw.analyzer ?? '',
    audibleEndMs: analysis.audibleEndMs,
    tailSilenceMs: analysis.tailSilenceMs,
    analysis,
  };
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function numbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
