/**
 * 「音乐地铁图」Stage：把数据、布局、渲染、相机、列车模拟串成一条可玩的原型。
 *
 * 职责：
 *  - MetroData → layoutMetro → MetroMap → renderer.setData
 *  - 相机：适图 / 线路聚焦 / 站点聚焦 / LOD 切换 / 缩放百分比
 *  - 列车：M1 用「沿线 ping-pong 模拟时钟」驱动（每段 9s），逐帧 setTrain
 *  - 交互编排：站点点击开卡、线路/图例高亮、卡片动作、空白取消、Esc 返回、空格暂停
 *
 * 接口冻结见 research/tmp/metro-m1/contract.md §7；本文件由 Lead 维护。
 */

import { createMetroCamera } from './metroCamera';
import { layoutMetro } from './metroLayout';
import { mockMetroData } from './metroPreview';
import { createMetroRenderer, summarizeData } from './metroRender';
import type { MetroThemeMode } from './metroTheme';
import type {
  MetroBounds,
  MetroData,
  MetroLine,
  MetroLodLevel,
  MetroMap,
  MetroSong,
  MetroStation,
  MetroTrainPoint,
} from './types';

/** 列车每跑一站（相邻两站间）的模拟时长。 */
const SEGMENT_MS = 9000;
/** 线路聚焦时 bounds 外扩，给线名和 halo 留空间。 */
const LINE_BOUNDS_PADDING = 140;
/** 聚焦站点时至少放到的缩放。 */
const STATION_FOCUS_SCALE = 1.1;

export interface MetroStageOptions {
  theme?: MetroThemeMode;
  /** 为 true 时自动用 M1 假数据建图（等价于手动 setData(mockMetroData())）。 */
  mock?: boolean;
  /**
   * 自定义布局（默认 `layoutMetro`）。用于「单线直线页」等变体：
   * 覆盖层在分类首页点进某条线路后传入 `layoutStraightLine`，让该线画成一条水平直线。
   */
  layout?: (data: MetroData) => MetroMap;
  /**
   * 站名排布方式（透传给渲染层）：
   * - 'auto'（默认）：贪心避让，适合多线全图；
   * - 'alternate'：上下交替两行，适合单线横向直线页（结果确定、不抖动）。
   */
  labelLayout?: 'auto' | 'alternate';
  /** 列车模拟初始进度（ms），默认 0。 */
  initialProgressMs?: number;
  onSelect?: (song: MetroSong) => void;
  onPlay?: (song: MetroSong) => void;
  /** 点线路条「播放全部」：播放整条线路。未提供时退回 onPlay(首站歌曲)。 */
  onPlayLine?: (lineId: string) => void;
  /** 站点卡片「加入队列」：加入播放队列。未提供时退回轻提示。 */
  onQueue?: (song: MetroSong) => void;
  onZoneChange?: (zone: 'map' | 'line') => void;
  onReady?: () => void;
  onToast?: (message: string) => void;
  onClose?: () => void;
}

export interface MetroStageStats {
  fps: number;
  stations: number;
  lines: number;
  scale: number;
  lod: MetroLodLevel;
  clockMs: number;
  stationIndex: number;
  running: boolean;
}

export interface MetroStage {
  root: HTMLElement;
  setData(data: MetroData): void;
  setActiveTrack(trackKey: string | null): void;
  /** M1 模拟播放进度（ms）：把列车拨到对应位置。 */
  setProgress(ms: number): void;
  setSimulation(running: boolean): void;
  focusLine(lineId: string | null): void;
  focusStation(stationId: string): void;
  openCard(stationId: string): void;
  closeCard(): void;
  setTheme(mode: MetroThemeMode): void;
  setScale(scale: number): void;
  fit(): void;
  stats(): MetroStageStats;
  dispose(): void;
}

export function createMetroStage(host: HTMLElement, options: MetroStageOptions = {}): MetroStage {
  const renderer = createMetroRenderer(host, {
    theme: options.theme ?? 'auto',
    labelLayout: options.labelLayout ?? 'auto',
    onSelect: (stationId) => {
      const station = map?.stations[stationId];
      if (!station) return;
      openCard(stationId);
      options.onSelect?.(station.song);
    },
    onLineSelect: (lineId) => focusLine(lineId),
    onLinePlay: (lineId) => playLine(lineId),
    onCardAction: (action, song) => handleCardAction(action, song),
    onCardClose: () => closeCard(),
    onZoom: (action) => {
      if (action === 'in') camera.zoomBy(1.25);
      else if (action === 'out') camera.zoomBy(1 / 1.25);
      else fit();
    },
    onClose: () => goBack(),
    onToast: (message) => options.onToast?.(message),
  });
  const camera = createMetroCamera(renderer.svg, renderer.cameraGroup);

  let data: MetroData | null = null;
  let map: MetroMap | null = null;
  let summary = { lines: 0, stations: 0, transfers: 0 };
  let activeBounds: MetroBounds | null = null;
  let activeLineId: string | null = null;
  let activeTrackKey: string | null = null;
  let highlightedLineId: string | null = null;
  let cardStationId: string | null = null;
  let lod: MetroLodLevel = 'far';
  let clockMs = options.initialProgressMs ?? 0;
  let running = true;
  let trainDirty = true;
  let stationIndex = -1;
  let fps = 0;
  let disposed = false;

  let lastFrame = 0;
  let frames = 0;
  let fpsSince = performance.now();

  // ── 相机 / LOD ────────────────────────────────────────────────────────────

  camera.onChange((state) => {
    renderer.setScaleLabel(state.scale);
    renderer.setLabelScale(state.scale);
    const next = lodForScale(state.scale);
    if (next !== lod) {
      lod = next;
      renderer.setLod(lod);
    }
  });

  function lodForScale(scale: number): MetroLodLevel {
    if (scale < 0.3) return 'far';
    if (scale < 0.75) return 'mid';
    if (scale < 1.4) return 'near';
    return 'close';
  }

  // ── 数据 / 建图 ───────────────────────────────────────────────────────────

  function setData(next: MetroData): void {
    data = next;
    summary = summarizeData(next);
    map = (options.layout ?? layoutMetro)(next);
    renderer.setData(map);
    renderer.setHighlight(null);
    renderer.setCard(null);
    highlightedLineId = null;
    cardStationId = null;
    const line = pickDefaultLine(map);
    activeLineId = line ? line.id : null;
    activeTrackKey = null;
    stationIndex = -1;
    clockMs = options.initialProgressMs ?? 0;
    activeBounds = map.bounds;
    camera.setBounds(map.bounds);
    camera.fit(false);
    renderer.setScaleLabel(camera.scale);
    lod = lodForScale(camera.scale);
    renderer.setLod(lod);
    renderer.setLabelScale(camera.scale);
    trainDirty = true;
    updateFromClock();
    if (data.lines.length > 0) {
      renderer.setCrumb(`全部线路 · ${summary.lines} 线 ${summary.stations} 站`, '地铁图');
    }
    options.onReady?.();
  }

  function pickDefaultLine(target: MetroMap): MetroLine | null {
    const priority: Array<MetroLine['source']> = ['recent', 'daily', 'liked', 'playlist', 'radar', 'local'];
    for (const source of priority) {
      const found = target.lines.find((line) => line.source === source);
      if (found) return found;
    }
    return target.lines[0] ?? null;
  }

  function activeLine(): MetroLine | null {
    if (!map || !activeLineId) return null;
    return map.lines.find((line) => line.id === activeLineId) ?? null;
  }

  function lineBounds(line: MetroLine, padding = LINE_BOUNDS_PADDING): MetroBounds | null {
    if (!map) return null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const stationId of line.stationIds) {
      const station = map.stations[stationId];
      if (!station) continue;
      minX = Math.min(minX, station.x);
      minY = Math.min(minY, station.y);
      maxX = Math.max(maxX, station.x);
      maxY = Math.max(maxY, station.y);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    return { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding };
  }

  // ── 列车模拟 ──────────────────────────────────────────────────────────────

  /** ping-pong 折返序列：0,1,…,n-1,n-2,…,1 → 共 2(n-1) 段。 */
  function pingPongVertex(step: number, count: number): number {
    return step <= count - 1 ? step : 2 * (count - 1) - step;
  }

  function trainPosition(line: MetroLine): { point: MetroTrainPoint; stationIndex: number } | null {
    const metric = renderer.lineMetric(line.id);
    if (!metric) return null;
    const count = line.stationIds.length;
    const total = metric.total;
    if (count < 2 || !(total > 0)) return null;

    const unit = clockMs / SEGMENT_MS;
    let len = 0;
    let nearest = 0;
    let reverse = false;

    if (line.loop) {
      const whole = Math.floor(unit);
      const j = ((whole % count) + count) % count;
      const frac = unit - whole;
      const from = metric.offsets[j] ?? 0;
      const to = metric.offsets[j + 1] ?? total;
      len = from + (to - from) * frac;
      nearest = frac < 0.5 ? j : (j + 1) % count;
    } else {
      const segCount = 2 * (count - 1);
      const phase = ((unit % segCount) + segCount) % segCount;
      const step = Math.floor(phase);
      const frac = phase - step;
      const fromIndex = pingPongVertex(step, count);
      const toIndex = pingPongVertex(step + 1, count);
      const from = metric.offsets[fromIndex] ?? 0;
      const to = metric.offsets[toIndex] ?? from;
      len = from + (to - from) * frac;
      reverse = toIndex < fromIndex;
      nearest = frac < 0.5 ? fromIndex : toIndex;
    }

    const clamped = Math.min(total, Math.max(0, len));
    const sample = Math.max(1.5, total * 0.0015);
    const before = metric.path.getPointAtLength(Math.max(0, clamped - sample));
    const after = metric.path.getPointAtLength(Math.min(total, clamped + sample));
    let angleDeg = (Math.atan2(after.y - before.y, after.x - before.x) * 180) / Math.PI;
    if (reverse) angleDeg += 180;
    const point = metric.path.getPointAtLength(clamped);
    return { point: { x: point.x, y: point.y, angleDeg }, stationIndex: nearest };
  }

  function updateFromClock(): void {
    if (!map) return;
    const line = activeLine();
    if (!line) {
      renderer.setTrain(null, 'idle');
      renderer.setActiveTrack(null);
      stationIndex = -1;
      return;
    }
    const position = trainPosition(line);
    if (!position) {
      renderer.setTrain(null, 'idle');
      return;
    }
    renderer.setTrain(position.point, running ? 'playing' : 'paused');
    stationIndex = position.stationIndex;
    const stationId = line.stationIds[position.stationIndex];
    const station = stationId ? map.stations[stationId] : undefined;
    if (station && station.song.trackKey !== activeTrackKey) {
      activeTrackKey = station.song.trackKey;
      renderer.setActiveTrack(activeTrackKey);
    }
  }

  function frame(now: number): void {
    if (disposed) return;
    rafId = requestAnimationFrame(frame);
    if (lastFrame === 0) lastFrame = now;
    const delta = Math.min(120, now - lastFrame);
    lastFrame = now;
    if (running && map) clockMs += delta;
    if (map && (running || trainDirty)) {
      updateFromClock();
      trainDirty = false;
    }
    frames += 1;
    if (now - fpsSince >= 500) {
      fps = Math.round((frames * 1000) / (now - fpsSince));
      frames = 0;
      fpsSince = now;
    }
  }

  let rafId = requestAnimationFrame(frame);

  // ── 高亮 / 卡片 / 播放 ────────────────────────────────────────────────────

  function focusLine(lineId: string | null): void {
    if (!map) return;
    let target: MetroLine | null = lineId ? map.lines.find((line) => line.id === lineId) ?? null : null;
    if (target && highlightedLineId === target.id) target = null; // 再点一次取消
    highlightedLineId = target ? target.id : null;
    renderer.setHighlight(highlightedLineId);
    const bounds = target ? lineBounds(target) ?? map.bounds : map.bounds;
    activeBounds = bounds;
    camera.setBounds(bounds);
    camera.fit(true);
    if (target) renderer.setCrumb(target.name, `线路 · ${target.stationIds.length} 站`);
    else renderer.setCrumb(`全部线路 · ${summary.lines} 线 ${summary.stations} 站`, '地铁图');
    options.onZoneChange?.(target ? 'line' : 'map');
  }

  function focusStation(stationId: string): void {
    if (!map) return;
    const station = map.stations[stationId];
    if (!station) return;
    camera.focusPoint({ x: station.x, y: station.y }, Math.max(camera.scale, STATION_FOCUS_SCALE));
  }

  function openCard(stationId: string): void {
    if (!map || !map.stations[stationId]) return;
    cardStationId = stationId;
    renderer.setCard(stationId);
  }

  function closeCard(): void {
    if (!cardStationId) return;
    cardStationId = null;
    renderer.setCard(null);
  }

  function goBack(): void {
    if (cardStationId) {
      closeCard();
      return;
    }
    if (highlightedLineId) {
      focusLine(null);
      return;
    }
    options.onClose?.();
  }

  function stationByTrack(trackKey: string): MetroStation | null {
    if (!map) return null;
    for (const station of Object.values(map.stations)) {
      if (station.song.trackKey === trackKey) return station;
    }
    return null;
  }

  function setActiveTrack(trackKey: string | null): void {
    if (!map) return;
    if (trackKey === null) {
      activeTrackKey = null;
      activeLineId = null;
      renderer.setActiveTrack(null);
      renderer.setTrain(null, 'idle');
      trainDirty = true;
      return;
    }
    const station = stationByTrack(trackKey);
    if (!station) return;
    activeTrackKey = trackKey;
    let line = activeLine();
    if (!line || !station.lineIds.includes(line.id)) {
      line = null;
      for (const lineId of station.lineIds) {
        const candidate = map.lines.find((item) => item.id === lineId);
        if (candidate) {
          line = candidate;
          break;
        }
      }
    }
    if (line) {
      activeLineId = line.id;
      clockMs = (station.indexInLine[line.id] ?? 0) * SEGMENT_MS;
    }
    renderer.setActiveTrack(trackKey);
    trainDirty = true;
    updateFromClock();
  }

  function playLine(lineId: string): void {
    if (!map) return;
    const line = map.lines.find((item) => item.id === lineId);
    if (!line) return;
    if (options.onPlayLine) {
      options.onPlayLine(lineId);
      return;
    }
    const first = map.stations[line.stationIds[0]];
    if (!first) return;
    options.onPlay?.(first.song);
    options.onToast?.(`播放线路：${line.name}`);
  }

  function handleCardAction(action: 'play' | 'queue' | 'next' | 'locate', song: MetroSong): void {
    if (action === 'play') {
      options.onPlay?.(song);
      return;
    }
    if (action === 'next') {
      options.onPlay?.(song);
      options.onToast?.(`下一首：${song.title}`);
      return;
    }
    if (action === 'queue') {
      if (options.onQueue) options.onQueue(song);
      else options.onToast?.(`已加入队列：${song.title}`);
      return;
    }
    const station = stationByTrack(song.trackKey);
    if (!station) return;
    focusStation(station.id);
    renderer.setCard(station.id);
    cardStationId = station.id;
  }

  // ── 交互 ──────────────────────────────────────────────────────────────────

  function onSvgClick(event: MouseEvent): void {
    if (camera.consumeDragFlag()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.mt-station, .mt-line, .mt-hud, .mt-legend, .mt-zoombar, .mt-linebar, .mt-card, .mt-icon-btn')) {
      return;
    }
    if (cardStationId) {
      closeCard();
      return;
    }
    if (highlightedLineId) focusLine(null);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      goBack();
      if (cardStationId || highlightedLineId) event.preventDefault();
      return;
    }
    if (event.code === 'Space' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      setSimulation(!running);
    }
  }

  // 鼠标点过按钮后把焦点交还地图：否则空格会被按钮吞掉，模拟播放不响应
  renderer.root.addEventListener('pointerup', () => {
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement) active.blur();
  });

  function setSimulation(nextRunning: boolean): void {
    running = nextRunning;
    trainDirty = true;
    updateFromClock();
  }

  renderer.svg.addEventListener('click', onSvgClick);
  window.addEventListener('keydown', onKeyDown);

  const resizeObserver = new ResizeObserver(() => {
    if (disposed || !map) return;
    camera.setBounds(activeBounds ?? map.bounds);
    camera.fit(false);
  });
  resizeObserver.observe(host);

  // ── 对外 API ─────────────────────────────────────────────────────────────

  function setProgress(ms: number): void {
    clockMs = ms;
    trainDirty = true;
    updateFromClock();
  }

  function fit(): void {
    if (!map) return;
    camera.setBounds(activeBounds ?? map.bounds);
    camera.fit(true);
  }

  function stats(): MetroStageStats {
    return {
      fps,
      stations: summary.stations,
      lines: summary.lines,
      scale: camera.scale,
      lod,
      clockMs,
      stationIndex,
      running,
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(rafId);
    renderer.svg.removeEventListener('click', onSvgClick);
    window.removeEventListener('keydown', onKeyDown);
    resizeObserver.disconnect();
    camera.dispose();
    renderer.destroy();
  }

  if (options.mock) {
    setData(mockMetroData());
  } else if (options.initialProgressMs === undefined) {
    clockMs = 0;
  }

  return {
    root: renderer.root,
    setData,
    setActiveTrack,
    setProgress,
    setSimulation,
    focusLine,
    focusStation,
    openCard,
    closeCard,
    setTheme: (mode) => renderer.setTheme(mode),
    setScale: (scale) => camera.zoomTo(scale),
    fit,
    stats,
    dispose,
  };
}
