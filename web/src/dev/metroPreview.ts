/**
 * 音乐地铁图 M1 独立预览入口（vite dev 下访问 /preview-metro.html）。
 *
 * 与主应用完全解耦：只依赖 `src/ui/metro/` 的模块契约与 M1 假数据。
 *
 * URL 参数：
 *   ?line=<序号>        初始高亮线路（data.lines 下标），会 focus 到该线
 *   ?station=<序号>     初始打开站点卡：有 line 时取该线第 N 站，否则取全局站表第 N 个
 *   ?theme=light|dark|auto   默认 auto
 *   ?t=<秒>             模拟播放进度（列车位置），默认 45
 *   ?sim=0/1            默认 1；0 = 冻结列车（截图用）
 *   ?scale=<数值>       初始缩放（覆盖适图结果）
 *   ?debug=1            显示右下角角标：fps / 站数 / 缩放 / LOD / 模拟时钟
 *
 * 调试 API（供 headless CDP 截图脚本使用）：
 *   window.__metroPreview = {
 *     stage, data, ready,
 *     setProgress(ms), focusLine(index), openStation(index), closeCard(), stats(),
 *   }
 */

import { mockMetroData } from '../ui/metro/metroPreview';
import { createMetroStage } from '../ui/metro/metroStage';
import type { MetroStage, MetroStageStats } from '../ui/metro/metroStage';
import type { MetroData } from '../ui/metro/types';
import type { MetroThemeMode } from '../ui/metro/metroTheme';

interface MetroPreviewApi {
  readonly stage: MetroStage;
  readonly data: MetroData;
  readonly ready: Promise<void>;
  setProgress(ms: number): void;
  focusLine(index: number): void;
  openStation(index: number): void;
  closeCard(): void;
  stats(): MetroStageStats;
}

declare global {
  interface Window {
    __metroPreview?: MetroPreviewApi;
  }
}

/* ── URL 参数 ──────────────────────────────────────────────────────── */

function readNumberParam(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readFlagParam(params: URLSearchParams, key: string, fallback: boolean): boolean {
  const raw = params.get(key);
  if (raw === null) return fallback;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

function readThemeParam(params: URLSearchParams): MetroThemeMode {
  const raw = params.get('theme');
  if (raw === 'light' || raw === 'dark') return raw;
  return 'auto';
}

/* ── 轻量 toast（不依赖主应用样式） ────────────────────────────────── */

function createToaster(): (message: string) => void {
  const element = document.createElement('div');
  element.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:104px',
    'transform:translateX(-50%) translateY(8px)',
    'padding:10px 18px',
    'border-radius:999px',
    'background:rgba(18,18,24,.84)',
    'color:#f7f4ef',
    'font-size:13px',
    'line-height:1.4',
    'letter-spacing:.01em',
    'box-shadow:0 12px 32px rgba(0,0,0,.28)',
    'backdrop-filter:blur(14px)',
    'opacity:0',
    'pointer-events:none',
    'transition:opacity .2s ease, transform .2s cubic-bezier(.22,1,.36,1)',
    'z-index:400',
    'max-width:min(560px, 80vw)',
  ].join(';');
  document.body.appendChild(element);
  let hideTimer = 0;
  return (message: string): void => {
    window.clearTimeout(hideTimer);
    element.textContent = message;
    element.style.opacity = '1';
    element.style.transform = 'translateX(-50%) translateY(0)';
    hideTimer = window.setTimeout(() => {
      element.style.opacity = '0';
      element.style.transform = 'translateX(-50%) translateY(8px)';
    }, 2200);
  };
}

/* ── 调试角标 ──────────────────────────────────────────────────────── */

function startDebugBadge(badge: HTMLElement, stage: MetroStage): void {
  badge.style.display = '';
  window.setInterval(() => {
    const stats = stage.stats();
    badge.textContent = [
      `${stats.fps} fps`,
      `${stats.lines} 线 ${stats.stations} 站`,
      `${Math.round(stats.scale * 100)}%`,
      stats.lod,
      `t=${(stats.clockMs / 1000).toFixed(1)}s`,
      `#${stats.stationIndex}`,
    ].join(' · ');
  }, 250);
}

/* ── 启动 ──────────────────────────────────────────────────────────── */

function main(): void {
  const host = document.getElementById('stage');
  if (!host) throw new Error('preview-metro.html 缺少 #stage 容器');

  const params = new URLSearchParams(window.location.search);
  const debug = readFlagParam(params, 'debug', false);
  const theme = readThemeParam(params);
  const seconds = Math.max(0, readNumberParam(params, 't', 45));
  const running = readFlagParam(params, 'sim', true);
  const lineIndex = readNumberParam(params, 'line', -1);
  const stationIndex = readNumberParam(params, 'station', -1);
  const scaleParam = readNumberParam(params, 'scale', Number.NaN);

  const data = mockMetroData();
  const toast = createToaster();
  const stage = createMetroStage(host, {
    theme,
    initialProgressMs: seconds * 1000,
    onToast: toast,
    onClose: () => toast('返回：M2 接入应用内覆盖层'),
  });

  stage.setData(data);

  if (lineIndex >= 0) {
    const line = data.lines[lineIndex];
    if (line) stage.focusLine(line.id);
  }

  if (stationIndex >= 0) {
    const stationId = resolveStationId(data, lineIndex, stationIndex);
    if (stationId) {
      stage.focusStation(stationId);
      stage.openCard(stationId);
    }
  }

  if (Number.isFinite(scaleParam) && scaleParam > 0) {
    stage.setScale(scaleParam);
  }

  if (!running) stage.setSimulation(false);

  const badge = document.getElementById('debug-badge');
  if (debug && badge) startDebugBadge(badge, stage);

  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => resolveReady());
  });

  window.__metroPreview = {
    stage,
    data,
    ready,
    setProgress: (ms) => stage.setProgress(ms),
    focusLine: (index) => {
      const line = data.lines[index];
      stage.focusLine(line ? line.id : null);
    },
    openStation: (index) => {
      const stationId = resolveStationId(data, -1, index);
      if (!stationId) return;
      stage.focusStation(stationId);
      stage.openCard(stationId);
    },
    closeCard: () => stage.closeCard(),
    stats: () => stage.stats(),
  };
}

/** 站点序号解析：有 line 时取该线第 N 站；否则按「线路顺序去重」的全局站表。 */
function resolveStationId(data: MetroData, lineIndex: number, stationIndex: number): string | null {
  if (lineIndex >= 0) {
    const line = data.lines[lineIndex];
    if (!line) return null;
    const stationId = line.stationIds[stationIndex];
    return stationId && data.stations[stationId] ? stationId : null;
  }
  const seen = new Set<string>();
  const global: string[] = [];
  for (const line of data.lines) {
    for (const stationId of line.stationIds) {
      if (seen.has(stationId)) continue;
      seen.add(stationId);
      global.push(stationId);
    }
  }
  const stationId = global[stationIndex];
  return stationId && data.stations[stationId] ? stationId : null;
}

main();
