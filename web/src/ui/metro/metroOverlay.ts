/**
 * 音乐地铁图 M2 · 应用内全屏入口（覆盖层）。
 *
 * 职责：
 *   1) 打开一个盖住整个应用的「地铁图」覆盖层（单例，重复调用幂等）；
 *   2) 异步加载真实听歌数据（`metroData.loadMetroData`），处理 加载 / 空 / 失败 三态 + 重试；
 *   3) 把渲染层 `createMetroStage` 挂进覆盖层，接通应用播放器（播放 / 整线播放 / 加入队列）；
 *   4) 维护面包屑、返回、Esc 逐级退出、焦点恢复与资源释放。
 *
 * 约定：本文件只依赖契约 §4/§5 冻结的 API；不修改任何既有模块。
 */

import type { OnlineTrack } from '../../online/types';
import { h, toast } from '../dom';
import { onPlayer, playerState, playQueue, replaceQueue } from '../player';
import { loadMetroData } from './metroData';
import { mockMetroData } from './metroPreview';
import { createMetroStage } from './metroStage';
import type { MetroStage, MetroStageOptions } from './metroStage';
import type { MetroData, MetroLine, MetroSong } from './types';

/** 开发/演示开关：`?metroMock=1` 时用 M1 假数据，未登录环境也能预演。 */
const MOCK_PARAM = 'metroMock';

/** 覆盖层 aria-label（与标题文案保持一致）。 */
const OVERLAY_LABEL = '音乐地铁图';

/** 加载态面包屑文案（契约 §4）。 */
const CRUMB_LOADING = '地铁图 · 载入中…';

/** 已打开的覆盖层句柄；非 null 即表示当前已打开（单例锁）。 */
let active: { close: () => void } | null = null;

/* ------------------------------------------------------------------ */
/* 纯函数辅助（数据映射）                                                */
/* ------------------------------------------------------------------ */

/** 播放器里曲目的唯一键：`${source}:${id}`（与地铁站点的 trackKey 同构）。 */
function playerTrackKey(track: OnlineTrack): string {
  return `${track.source}:${track.id}`;
}

/** MetroSong → 播放器队列条目（地铁图里的歌都按可播处理）。 */
function toTrack(song: MetroSong): OnlineTrack {
  return {
    source: song.source,
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album ?? '',
    durationMs: song.durationMs,
    cover: song.coverUrl ?? '',
    playable: true,
  };
}

/** 找到某首歌所在的线路（一首歌可能出现在多条线上，取第一条）。 */
function lineOfSong(data: MetroData, song: MetroSong): MetroLine | null {
  return data.lines.find((line) => line.stationIds.includes(song.trackKey)) ?? null;
}

/** 按线内顺序取出该线的 MetroSong（跳过数据里已不存在的站点）。 */
function lineSongs(data: MetroData, line: MetroLine): MetroSong[] {
  const songs: MetroSong[] = [];
  for (const stationId of line.stationIds) {
    const station = data.stations[stationId];
    if (station) songs.push(station.song);
  }
  return songs;
}

/** 是否走假数据演示模式。 */
function wantsMockData(): boolean {
  try {
    return new URL(location.href).searchParams.get(MOCK_PARAM) === '1';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 覆盖层                                                              */
/* ------------------------------------------------------------------ */

/**
 * 打开地铁图全屏覆盖层；重复调用幂等（已打开则忽略）。
 *
 * 流程：挂 DOM + 加载态 → await loadMetroData() → 建 stage + setData → 撤加载态。
 * 失败 / 空数据时显示对应状态并保留「重试」；Esc 在 stage 就绪前直接关闭覆盖层，
 * 就绪后交给 stage 自己的逐级 Esc（卡片 → 线路 → onClose）。
 */
export function openMetroOverlay(): void {
  if (active) return;

  // 关闭后用于恢复焦点（打开前聚焦的元素）。
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // ── DOM 骨架（契约 §4）──────────────────────────────────────────────
  const root = document.createElement('div');
  root.className = 'metro-overlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', OVERLAY_LABEL);
  root.tabIndex = -1;

  const stageHost = document.createElement('div');
  stageHost.className = 'metro-overlay-stage';

  const crumb = document.createElement('div');
  crumb.className = 'metro-overlay-crumb';
  crumb.textContent = CRUMB_LOADING;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'metro-overlay-close';
  closeBtn.title = '返回（Esc）';
  closeBtn.textContent = '返回';

  const stateLayer = document.createElement('div');
  stateLayer.className = 'metro-overlay-state';
  stateLayer.setAttribute('role', 'status');
  stateLayer.setAttribute('aria-live', 'polite');

  root.append(stageHost, stateLayer, crumb, closeBtn);
  document.body.append(root);
  root.focus({ preventScroll: true });

  // ── 运行时状态 ─────────────────────────────────────────────────────
  let disposed = false;
  let loadVersion = 0;
  let escArmed = false;
  let stage: MetroStage | null = null;
  let data: MetroData | null = null;
  let offPlayer: (() => void) | null = null;

  // ── 状态层：加载 / 空 / 失败 ────────────────────────────────────────
  type LoadState = 'loading' | 'empty' | 'error';

  function showState(kind: LoadState): void {
    const content = document.createDocumentFragment();
    if (kind === 'loading') {
      content.append(h('span', { class: 'metro-overlay-spinner', 'aria-hidden': 'true' }));
      content.append(h('p', { class: 'metro-overlay-state-text', text: '正在生成线路图…' }));
    } else {
      const isError = kind === 'error';
      content.append(
        h('p', {
          class: 'metro-overlay-state-title',
          text: isError ? '线路图加载失败' : '还没有足够的听歌数据',
        }),
      );
      content.append(
        h('p', {
          class: 'metro-overlay-state-text',
          text: isError ? '请稍后重试，或查看控制台日志。' : '多收藏、多听一些歌，再回来看看。',
        }),
      );
      const retry = h('button', { class: 'btn metro-overlay-retry', type: 'button', text: '重试' });
      retry.addEventListener('click', () => {
        void load();
      });
      content.append(retry);
    }
    stateLayer.replaceChildren(content);
    stateLayer.dataset.state = kind;
    stateLayer.hidden = false;
  }

  function hideState(): void {
    stateLayer.hidden = true;
    stateLayer.replaceChildren();
  }

  // ── Esc：仅 stage 未就绪时由覆盖层兜底 ─────────────────────────────
  function onEscCapture(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function armEsc(): void {
    if (disposed || escArmed) return;
    window.addEventListener('keydown', onEscCapture, true);
    escArmed = true;
  }

  function disarmEsc(): void {
    if (!escArmed) return;
    window.removeEventListener('keydown', onEscCapture, true);
    escArmed = false;
  }

  // ── 面包屑 ─────────────────────────────────────────────────────────
  /** 读取渲染层内部 HUD 的文案（渲染层在 onZoneChange 之前已写好，见 metroStage.ts）。 */
  function readStageCrumb(selector: string): string {
    return stageHost.querySelector(selector)?.textContent?.trim() ?? '';
  }

  function updateCrumb(zone: 'map' | 'line'): void {
    if (disposed) return;
    if (zone === 'line') {
      // stage 的 onZoneChange 只给 'map' | 'line'，线路名/站数复用渲染层写好的内部 crumb
      // （渲染层 focusLine 时写 kicker=`线路 · N 站`、title=线名）。
      const title = readStageCrumb('.mt-crumb-title');
      const stationPart = /(\d+)\s*站/.exec(readStageCrumb('.mt-crumb-kicker'))?.[1] ?? '';
      if (title && stationPart) {
        crumb.textContent = `地铁图 · ${title} · ${stationPart} 站`;
        return;
      }
      crumb.textContent = title ? `地铁图 · ${title}` : '地铁图 · 线路聚焦';
      return;
    }
    const stats = stage?.stats();
    const lineCount = stats?.lines ?? data?.lines.length ?? 0;
    const stationCount = stats?.stations ?? (data ? Object.keys(data.stations).length : 0);
    crumb.textContent = `地铁图 · 全部线路 · ${lineCount} 线 ${stationCount} 站`;
  }

  // ── 播放器联动 ─────────────────────────────────────────────────────
  /** 播放整条线路，并以目标歌曲为当前曲（未找到时退回第 0 首）。 */
  function playTracks(tracks: OnlineTrack[], index: number): void {
    if (tracks.length === 0) return;
    playQueue(tracks, index, true);
  }

  function playSong(song: MetroSong): void {
    const metro = data;
    if (!metro) return;
    const line = lineOfSong(metro, song);
    const songs = line ? lineSongs(metro, line) : [song];
    const tracks = songs.map(toTrack);
    const index = Math.max(0, songs.findIndex((item) => item.trackKey === song.trackKey));
    playTracks(tracks, index);
    toast(`播放《${song.title}》`);
  }

  function playLine(lineId: string): void {
    const metro = data;
    if (!metro) return;
    const line = metro.lines.find((item) => item.id === lineId);
    if (!line) return;
    const tracks = lineSongs(metro, line).map(toTrack);
    if (tracks.length === 0) return;
    playTracks(tracks, 0);
    toast(`播放线路：${line.name}`);
  }

  function queueSong(song: MetroSong): void {
    const state = playerState();
    const track = toTrack(song);
    // 播放器空闲（没有当前曲目）时不自动起播：只补齐队列并把新曲目设为待播。
    if (!state.track) {
      const nextQueue = [...state.queue, track];
      playQueue(nextQueue, nextQueue.length - 1, false);
      toast('已加入队列');
      return;
    }
    // 有当前曲目：追加到队列末尾；replaceQueue 会保留当前曲与进度（不打断播放）。
    replaceQueue([...state.queue, track]);
    toast('已加入队列');
  }

  // ── stage 生命周期 ─────────────────────────────────────────────────
  /** 释放 stage 与播放器订阅，并清空宿主（可重复调用）。 */
  function disposeStage(): void {
    if (offPlayer) {
      offPlayer();
      offPlayer = null;
    }
    const current = stage;
    stage = null;
    if (current) {
      try {
        current.dispose();
      } catch (error) {
        console.warn('[metro] 释放渲染舞台失败', error);
      }
    }
    stageHost.replaceChildren();
  }

  function mountStage(metro: MetroData): void {
    data = metro;
    const options: MetroStageOptions = {
      theme: 'auto',
      onToast: (message) => toast(message),
      onClose: close,
      onZoneChange: (zone) => updateCrumb(zone),
      onSelect: (song) => toast(`《${song.title}》— ${song.artist}`),
      onPlay: (song) => playSong(song),
      onPlayLine: (lineId) => playLine(lineId),
      onQueue: (song) => queueSong(song),
    };
    const created = createMetroStage(stageHost, options);
    stage = created;
    created.setData(metro);

    // 当前播放曲高亮（onPlayer 订阅会立即回调一次，这里显式补一次以覆盖订阅前的状态）。
    const initial = playerState();
    created.setActiveTrack(initial.track ? playerTrackKey(initial.track) : null);
    offPlayer = onPlayer((state) => {
      stage?.setActiveTrack(state.track ? playerTrackKey(state.track) : null);
    });

    hideState();
    // 数据就绪：Esc 交给 stage 的逐级返回（卡片 → 线路 → onClose）。
    disarmEsc();
    updateCrumb('map');
  }

  // ── 加载 / 重试 ────────────────────────────────────────────────────
  async function load(): Promise<void> {
    if (disposed) return;
    const version = (loadVersion += 1);
    disposeStage();
    data = null;
    crumb.textContent = CRUMB_LOADING;
    showState('loading');
    armEsc();
    try {
      const metro = wantsMockData() ? mockMetroData() : await loadMetroData();
      if (disposed || version !== loadVersion) return;
      if (metro.lines.length === 0) {
        crumb.textContent = '地铁图 · 暂无数据';
        showState('empty');
        return;
      }
      mountStage(metro);
    } catch (error) {
      if (disposed || version !== loadVersion) return;
      console.warn('[metro] 线路图数据加载失败，已展示失败态', error);
      disposeStage();
      crumb.textContent = '地铁图 · 加载失败';
      showState('error');
      armEsc();
    }
  }

  // ── 关闭（幂等）────────────────────────────────────────────────────
  function onCloseClick(): void {
    close();
  }

  function close(): void {
    if (disposed) return;
    disposed = true;
    loadVersion += 1;
    disarmEsc();
    closeBtn.removeEventListener('click', onCloseClick);
    disposeStage();
    root.remove();
    active = null;
    if (previousFocus?.isConnected) {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch {
        // 焦点恢复失败不阻塞关闭（元素可能已被重建）。
      }
    }
  }

  closeBtn.addEventListener('click', onCloseClick);
  active = { close };
  void load();
}
