/**
 * 歌词页「播放效果 · PV」包装层。
 *
 * 观感全部在 ui/pvScene.ts 里（定格动画风的文字 PV：巨字裁切 / 斜切色带 / 竖排框格 /
 * 框格网 / 负片面版 / 错版叠印 / 故障 RGB / 标注页，配印刷标记、网点与扫描条），
 * 这里只负责把场景接到应用上：锚点时钟驱动、低频能量、.lyrics-stage 样式契约、
 * 离场延迟拆画布。异常时给 root 挂 is-failed，歌词页 CSS 会把 DOM 歌词放回来。
 */

import { playbackAnalyser } from '../core/audioTap';
import { onPlayer, playerState } from './player';
import type { LumiereMode, LumiereSongInput } from './lumiere';
import { createPvScene } from './pvScene';
import type { PvScene, PvSong } from './pvScene';
import { pvStyleSettings, type PvStyleSettings } from './pvSettings';

/** 当前活着的 PV 场景（面板预览 / 歌词页可能同时存在）。 */
const liveScenes = new Set<PvScene>();

/** 把观感参数推给所有正在跑的 PV 场景。 */
export function applyPvStyleSettings(settings?: PvStyleSettings): void {
  const resolved = settings ?? pvStyleSettings();
  for (const scene of liveScenes) scene.setStyle(resolved);
}

export interface PvStage {
  readonly root: HTMLDivElement;
  setMode(mode: LumiereMode): void;
  setSong(input: LumiereSongInput | null): void;
  activate(): void;
  deactivate(): void;
  dispose(): void;
}

function lyricsTextDigest(lines: LumiereSongInput['lines']): string {
  if (lines.length === 0) return '0';
  let hash = 0x811c9dc5;
  for (const line of lines) {
    const text = `${line.text}\u0000${line.translation}`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `${lines.length}:${hash.toString(16)}`;
}

function songSignature(input: LumiereSongInput | null): string {
  if (!input) return '';
  const first = input.lines[0];
  const last = input.lines[input.lines.length - 1];
  return `${input.trackKey}|${input.title}|${input.artist}|${input.durationMs}|${input.lyricOffsetMs}|${input.lines.length}|${first?.timeMs ?? 0}|${last?.timeMs ?? 0}|${lyricsTextDigest(input.lines)}`;
}

function toSceneSong(input: LumiereSongInput): PvSong {
  return {
    trackKey: input.trackKey,
    title: input.title,
    artist: input.artist,
    album: input.album,
    durationMs: input.durationMs,
    lyricOffsetMs: Number.isFinite(input.lyricOffsetMs) ? input.lyricOffsetMs : 0,
    lines: input.lines,
  };
}

export function createPvStage(): PvStage {
  const root = document.createElement('div');
  root.className = 'lyrics-stage is-pv';

  let disposed = false;
  let active = false;
  let mode: LumiereMode = 'off';
  let song: LumiereSongInput | null = null;
  let songKey = '';
  let scene: PvScene | null = null;
  let raf = 0;
  let teardownTimer = 0;
  let painted = false;

  let anchorMs = 0;
  let anchorAt = 0;
  let playing = false;
  let analyser: AnalyserNode | null = null;
  let freq: Uint8Array<ArrayBuffer> | null = null;

  const syncPlayer = (): void => {
    const state = playerState();
    anchorMs = Number.isFinite(state.positionMs) ? Math.max(0, state.positionMs) : 0;
    anchorAt = performance.now();
    playing = state.playing;
  };

  const unsubscribe = onPlayer(() => {
    syncPlayer();
  });

  const updateAudio = (): number => {
    try {
      if (!analyser) analyser = playbackAnalyser();
      if (!analyser) return 0;
      if (!freq || freq.length !== analyser.frequencyBinCount) {
        freq = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      }
      analyser.getByteFrequencyData(freq);
      let sum = 0;
      const upto = Math.max(1, Math.floor(freq.length * 0.1));
      for (let i = 0; i < upto; i += 1) sum += freq[i] ?? 0;
      return sum / upto / 255;
    } catch {
      return 0;
    }
  };

  const buildScene = (): void => {
    if (scene || disposed) return;
    try {
      scene = createPvScene({
        style: pvStyleSettings(),
        onPainted: () => {
          if (painted || disposed) return;
          painted = true;
          root.classList.add('is-ready', 'is-painted');
          if ((song?.lines.length ?? 0) > 0) root.classList.add('is-content');
        },
        // 幕会在墨蓝/朱红（深底）与白纸/灰绿浅底之间切：把当前幕的深浅写到舞台上，
        // 歌词页的关闭按钮、进度条这些控件靠它换色，不然白字会压在白纸上。
        onAct: (act) => {
          root.classList.toggle('is-pv-deep', act === 0 || act === 2);
        },
      });
      root.appendChild(scene.root);
      liveScenes.add(scene);
      scene.resize();
      scene.setSong(song ? toSceneSong(song) : null);
      root.classList.remove('is-failed');
    } catch (error) {
      scene = null;
      root.classList.add('is-failed');
      console.error('[pv] 场景创建失败', error);
    }
  };

  const teardownScene = (): void => {
    if (!scene) return;
    liveScenes.delete(scene);
    scene.dispose();
    scene = null;
    painted = false;
    root.classList.remove('is-ready', 'is-content', 'is-painted');
  };

  let frameFailure: unknown = null;

  const renderFrame = (): void => {
    if (!active || disposed || !scene) return;
    const now = performance.now();
    const rawPosition = anchorMs + (playing ? now - anchorAt : 0);
    const positionMs = Number.isFinite(rawPosition) ? Math.max(0, rawPosition) : 0;
    try {
      const energy = updateAudio();
      scene.update(positionMs, playing, energy);
    } catch (error) {
      if (frameFailure !== error) {
        frameFailure = error;
        console.error('[pv] 帧更新失败', error);
        (window as unknown as { __pvFrameError?: string }).__pvFrameError = String((error as Error)?.stack ?? error);
      }
    }
    raf = window.requestAnimationFrame(() => {
      renderFrame();
    });
  };

  return {
    root,

    setMode(next: LumiereMode): void {
      mode = next;
    },

    setSong(input: LumiereSongInput | null): void {
      const nextKey = songSignature(input);
      if (nextKey === songKey) {
        song = input;
        return;
      }
      songKey = nextKey;
      song = input;
      root.classList.toggle('is-content', (input?.lines.length ?? 0) > 0);
      if (scene) scene.setSong(input ? toSceneSong(input) : null);
    },

    activate(): void {
      if (disposed) return;
      if (teardownTimer) {
        window.clearTimeout(teardownTimer);
        teardownTimer = 0;
      }
      if (active) return;
      active = true;
      root.classList.add('is-on');
      buildScene();
      syncPlayer();
      if (!raf) {
        raf = window.requestAnimationFrame(() => {
          renderFrame();
        });
      }
    },

    deactivate(): void {
      if (!active) return;
      active = false;
      root.classList.remove('is-on');
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      if (teardownTimer) window.clearTimeout(teardownTimer);
      teardownTimer = window.setTimeout(() => {
        teardownTimer = 0;
        if (active || disposed) return;
        teardownScene();
      }, 700);
    },

    dispose(): void {
      disposed = true;
      unsubscribe();
      if (teardownTimer) window.clearTimeout(teardownTimer);
      teardownTimer = 0;
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      teardownScene();
      void mode;
      root.remove();
    },
  };
}
