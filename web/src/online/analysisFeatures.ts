/**
 * 异步增强特征：GET /api/analysis/features（分轨活动度 + SSM 结构）。
 *
 * 基础分析（/api/analysis）仍然同步返回约 1 s 的 DSP 结果；增强在宿主侧排队跑
 * htdemucs / SSM，前端轮询这里，拿到后把结果合并进同一个 BeatAnalysis 对象。
 *
 * 设计要点：
 * - 所有 stage 都可缺失。缺失时消费方继续用 DSP 曲线（activity / 能量段落），
 *   合并函数只做「有则覆盖」，绝不把 DSP 字段清空。
 * - 曲线与段落都按毫秒、与基础契约同构，不引入 fps / 秒制。
 * - 合并带 provenance（activitySource / sectionsSource），浮层与诊断面板可显示
 *   当前听到的过渡到底用的是分轨曲线还是 DSP 曲线。
 */

import { relOf } from '../ui/local';
import { api, qualityForSource } from './client';
import type { OnlineTrack } from './types';
import type { ActivityCurves, BeatAnalysis, BeatSection } from './analysis';

/** 宿主 StemActivityPayload：250 ms 一格、逐轨 95 分位归一。 */
export interface StemActivityPayload {
  hopMs: number;
  vocal: number[];
  drum: number[];
  bass: number[];
  other: number[];
  source: string;
  modelSha256: string;
  durationMs: number;
  normalized: boolean;
}

/** 宿主 StructureFeaturePayload：SSM + checkerboard 结构。 */
export interface StructureFeaturePayload {
  source: string;
  method: string;
  boundariesMs: number[];
  sections: BeatSection[];
  barCount: number;
}

/** 宿主 StyleProfilePayload：500 ms 网格的谱统计，前端据此打多标签。 */
export interface StyleFeaturePayload {
  v: number;
  source: string;
  method: string;
  hopMs: number;
  centroidHz: number[];
  flatness: number[];
  highRatio: number[];
  percussivity: number[];
  tonalness: number[];
  dynamicRangeLu: number;
  silenceRatio: number;
  lowEnergyRatio: number;
  midEnergyRatio: number;
  highEnergyRatio: number;
}

/** 宿主 ExtensionFeaturePayload：生成式/循环延长的产物描述。 */
export interface ExtensionFeaturePayload {
  v: number;
  source: string;
  model?: string | null;
  modelSha256?: string | null;
  startMs: number;
  durationMs: number;
  loudnessLufs: number;
  prompt?: string | null;
  file: string;
}

export interface BeatFusionPayload {
  source: string;
  agreeRatio: number;
  bpm: number;
  downbeatsMs: number[];
}

export interface EmbeddingPayload {
  source: string;
  vector: number[];
}

export interface AnalysisFeatures {
  v: number;
  version: string;
  stems?: StemActivityPayload | null;
  structure?: StructureFeaturePayload | null;
  style?: StyleFeaturePayload | null;
  beatFusion?: BeatFusionPayload | null;
  embedding?: EmbeddingPayload | null;
}

export interface AnalysisFeaturesResponse {
  v?: number;
  ok?: boolean;
  trackKey?: string;
  features?: AnalysisFeatures | null;
  pending?: string[];
  status?: Record<string, string>;
}

/** 合并后的来源标记，供浮层/面板展示。 */
export type FeatureSource = 'dsp' | 'stems' | 'ssm' | 'ssm+dsp';

const FEATURES_TIMEOUT_MS = 8000;

/** 与 analysis.ts 的 analysisKey 保持同构；服务端会再算一次带 mtime 的 key。 */
function featureKey(track: OnlineTrack): string {
  if (track.source === 'local') return `local:${relOf(track) ?? track.id}`;
  return `${track.source}:${track.id}`;
}

function featureParams(track: OnlineTrack): Record<string, string> | null {
  if (track.source === 'local') {
    const rel = relOf(track);
    if (!rel) return null;
    return { source: 'local', rel };
  }
  return { source: String(track.source), id: track.id, quality: qualityForSource(String(track.source)) };
}

/** 拉一次增强特征；失败返回 null（增强永远不该把播放打挂）。 */
export async function fetchFeatures(
  track: OnlineTrack,
  stages: string[] = ['stems', 'structure', 'style'],
): Promise<AnalysisFeaturesResponse | null> {
  const params = featureParams(track);
  if (!params) return null;
  params.stages = stages.join(',');
  try {
    return await api<AnalysisFeaturesResponse>('/api/analysis/features', params, FEATURES_TIMEOUT_MS);
  } catch {
    return null;
  }
}

const polling = new Map<string, Promise<AnalysisFeatures | null>>();

/** 生成式延长：只排一次队，生成期间反复轻量轮询；模型缺失/失败返回 null。 */
const extensionJobs = new Map<string, Promise<AnalysisFeatures | null>>();

export function requestExtension(
  track: OnlineTrack,
  options: { startMs: number; durationMs: number; prompt?: string; mode?: 'bed' | 'continuation'; budgetMs?: number },
): Promise<AnalysisFeatures | null> {
  const params = featureParams(track);
  if (!params) return Promise.resolve(null);
  const key = `${featureKey(track)}|${Math.round(options.startMs)}|${Math.round(options.durationMs)}|${options.mode ?? 'bed'}`;
  const existing = extensionJobs.get(key);
  if (existing) return existing;
  params.stages = 'extend';
  params.extendStartMs = String(Math.max(0, Math.round(options.startMs)));
  params.extendMs = String(Math.max(0, Math.round(options.durationMs)));
  if (options.prompt) params.prompt = options.prompt;
  if (options.mode) params.mode = options.mode;
  const deadline = Date.now() + (options.budgetMs ?? 600_000);
  const job = (async (): Promise<AnalysisFeatures | null> => {
    while (Date.now() < deadline) {
      const response = await api<AnalysisFeaturesResponse>(
        '/api/analysis/features',
        params,
        FEATURES_TIMEOUT_MS,
      ).catch(() => null);
      const status = response?.status?.extend;
      if (status === 'ready' && response?.features) return response.features;
      if (status === 'unavailable' && options.mode === 'continuation') {
        // 续接模型没就绪：同一窗口改请求垫底，至少不让过渡空着。
        extensionJobs.delete(key);
        return requestExtension(track, { ...options, mode: 'bed' });
      }
      if (status === 'unavailable' || status === 'failed') return null;
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
    }
    return null;
  })();
  extensionJobs.set(key, job);
  void job.finally(() => extensionJobs.delete(key));
  return job;
}

/**
 * 轮询到所有 stage 就绪或预算耗尽。
 * 同一首并发调用复用同一个 Promise，避免过渡时打出十几条请求。
 */
export function pollFeatures(
  track: OnlineTrack,
  options: { stages?: string[]; budgetMs?: number; intervalMs?: number } = {},
): Promise<AnalysisFeatures | null> {
  const key = featureKey(track);
  const running = polling.get(key);
  if (running) return running;

  const stages = options.stages ?? ['stems', 'structure', 'style'];
  const budgetMs = options.budgetMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 900;
  const deadline = Date.now() + budgetMs;

  const task = (async (): Promise<AnalysisFeatures | null> => {
    let last: AnalysisFeatures | null = null;
    while (Date.now() < deadline) {
      const raw = await fetchFeatures(track, stages);
      if (!raw || raw.ok === false) return last;
      if (raw.features) last = raw.features;
      const pending = Array.isArray(raw.pending) ? raw.pending : [];
      if (pending.length === 0) return raw.features ?? last;
      await sleep(intervalMs);
    }
    return last;
  })();

  const tracked = task.finally(() => {
    if (polling.get(key) === tracked) polling.delete(key);
  });
  polling.set(key, tracked);
  return tracked;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanCurve(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null;
    out.push(item < 0 ? 0 : item > 1 ? 1 : item);
  }
  return out;
}

/**
 * 把增强特征合并进基础分析。返回是否真的改动了对象。
 *
 * 只覆盖能通过形状校验的字段：
 * - stems：三路曲线等长且 hop 合理 → 替换 activity，并标记 activitySource='stems'；
 * - structure：段落 start<end 且至少两段 → 替换 sections，重算 cueIn/cueOut（仅当
 *   基础分析没给或给了 0 时），并标记 sectionsSource。
 */
export function mergeEnhancedFeatures(analysis: BeatAnalysis, features: AnalysisFeatures | null): boolean {
  if (!analysis || !features) return false;
  let changed = false;

  const stems = features.stems;
  if (stems) {
    const vocal = cleanCurve(stems.vocal);
    const drum = cleanCurve(stems.drum);
    const bass = cleanCurve(stems.bass);
    const hopMs = typeof stems.hopMs === 'number' && stems.hopMs >= 80 && stems.hopMs <= 1000 ? stems.hopMs : 250;
    if (vocal && drum && bass && vocal.length === drum.length && drum.length === bass.length) {
      const activity: ActivityCurves = { hopMs, vocal, drum, bass };
      analysis.activity = activity;
      analysis.activitySource = 'stems';
      analysis.activityModel = typeof stems.modelSha256 === 'string' ? stems.modelSha256 : '';
      changed = true;
    }
  }

  const structure = features.structure;
  if (structure && Array.isArray(structure.sections)) {
    const sections: BeatSection[] = [];
    for (const raw of structure.sections) {
      if (!raw || typeof raw !== 'object') continue;
      const startMs = Number(raw.startMs);
      const endMs = Number(raw.endMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !(endMs > startMs) || startMs < 0) continue;
      sections.push({
        startMs,
        endMs,
        label: typeof raw.label === 'string' ? raw.label : '',
        confidence: typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
          ? Math.min(1, Math.max(0, raw.confidence))
          : 0.5,
      });
    }
    if (sections.length >= 2) {
      analysis.sections = sections;
      analysis.sectionsSource = structure.source === 'dsp' ? 'dsp' : 'ssm';
      analysis.boundariesMs = Array.isArray(structure.boundariesMs)
        ? structure.boundariesMs.filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
        : [];
      // cue 只在基础分析没给出时补；已有 DSP cue 时保留（它已按 8 小节乐句对齐）。
      if (!(typeof analysis.cueInMs === 'number' && analysis.cueInMs > 0)) {
        const first = sections.find((section) => section.label === 'drop' || section.label === 'chorus');
        if (first) analysis.cueInMs = first.startMs;
      }
      if (!(typeof analysis.cueOutMs === 'number' && analysis.cueOutMs > 0)) {
        const outro = [...sections].reverse().find((section) => section.label === 'outro');
        if (outro) analysis.cueOutMs = outro.startMs;
      }
      changed = true;
    }
  }

  const style = features.style;
  if (style) {
    const hopMs = typeof style.hopMs === 'number' && style.hopMs >= 80 && style.hopMs <= 1000 ? style.hopMs : 500;
    const curves = [style.centroidHz, style.flatness, style.highRatio, style.percussivity, style.tonalness];
    const lengths = curves.map((curve) => (Array.isArray(curve) ? curve.length : 0));
    const usable = lengths.every((length) => length >= 2) && lengths.every((length) => length === lengths[0]);
    if (usable) {
      analysis.styleFeatures = { ...style, hopMs };
      analysis.styleSource = style.source === 'dsp' ? 'dsp' : 'dsp';
      changed = true;
    }
  }

  if (typeof features.version === 'string' && features.version.length > 0) {
    analysis.featuresVersion = features.version;
  }
  return changed;
}

/** 当前分析是否已经用上分轨曲线（过渡质量门、浮层用它判断口径）。 */
export function hasStemCurves(analysis: BeatAnalysis | null | undefined): boolean {
  return !!analysis && analysis.activitySource === 'stems' && !!analysis.activity;
}

/** 当前分析是否已经用上 SSM 结构。 */
export function hasSsmStructure(analysis: BeatAnalysis | null | undefined): boolean {
  return !!analysis && (analysis.sectionsSource === 'ssm' || analysis.sectionsSource === 'ssm+dsp');
}

/** 给浮层/面板用的一句话来源描述。 */
export function describeFeatureSource(analysis: BeatAnalysis | null | undefined): string {
  if (!analysis) return '无分析';
  const activity = analysis.activitySource === 'stems' ? '分轨' : 'DSP';
  const sections = analysis.sectionsSource === 'ssm' ? 'SSM' : analysis.sectionsSource === 'ssm+dsp' ? 'SSM+DSP' : 'DSP';
  return `活动度 ${activity} · 结构 ${sections}`;
}
