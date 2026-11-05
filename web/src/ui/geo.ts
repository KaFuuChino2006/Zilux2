/**
 * 歌词页「播放效果 · 几何」包装层。
 *
 * 观感全部在 ui/geoScene.ts 里（文字 PV 排版：横条压字 / 竖排 / 巨字裁切 / 镜像 / 网格 /
 * 跑马灯 / 画框 / 拼章，配青品两路错版、半调网点、纸面颗粒、裁切标记与时间码），
 * 这里只负责把场景接到应用上：
 *   - 用 playerState()/onPlayer() 的锚点时钟算出当前播放位置，交给场景逐帧驱动；
 *   - 从 playbackAnalyser 取低频能量，让版式随重拍轻轻抖；
 *   - 维护 .lyrics-stage 的样式契约（is-on / is-ready / is-content / is-painted），
 *     画布出像之后歌词页的 CSS 才会把 DOM 歌词藏起来；
 *   - 离场后延迟拆掉画布，避免来回切效果时反复创建/销毁。
 *
 * 和其它几档一样：场景只用 2D canvas，真有异常就给 root 挂 is-failed，
 * 歌词页的 CSS 会把 DOM 歌词放回来，不至于黑屏。
 */

import { playbackAnalyser } from '../core/audioTap';
import { onPlayer, playerState } from './player';
import type { LumiereMode, LumiereSongInput } from './lumiere';
import { createGeoScene } from './geoScene';
import type { GeoLyricTint, GeoScene, GeoSong } from './geoScene';
import { geoStyleSettings, normalizeGeoSettings, type GeoStyleSettings } from './geoSettings';

/** 当前活着的几何场景：设置面板改参数时直接推给它们（可能同时有歌词页舞台和面板预览）。 */
const liveScenes = new Set<GeoScene>();

/** 把观感参数推给所有正在跑的几何场景（没有就什么都不做，下次创建会读持久值）。 */
export function applyGeoStyleSettings(settings?: GeoStyleSettings): void {
  const resolved = settings ? normalizeGeoSettings(settings) : geoStyleSettings();
  for (const scene of liveScenes) scene.setStyle(resolved);
}

/** 上方「歌词颜色」数据的提供者（由 ui/lyrics.ts 注册，避免本模块反向依赖歌词页）。 */
let lyricTintProvider: (() => GeoLyricTint | null) | null = null;

/** 当前生效的「歌词颜色」（面板预览用）。 */
export function currentGeoLyricTint(): GeoLyricTint | null {
  return lyricTintProvider ? lyricTintProvider() : null;
}

/** 注册/注销「歌词颜色」提供者；歌词页模块启动时调一次即可。 */
export function setGeoLyricTintProvider(provider: (() => GeoLyricTint | null) | null): void {
  lyricTintProvider = provider;
  for (const scene of liveScenes) scene.setLyricTint(provider ? provider() : null);
}

export interface GeoStage {
  readonly root: HTMLDivElement;
  setMode(mode: LumiereMode): void;
  setSong(input: LumiereSongInput | null): void;
  activate(): void;
  deactivate(): void;
  dispose(): void;
}

/** 歌词正文摘要：同曲换源/补翻译时行数与首末时间可能不变，签名必须带上正文。 */
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

/**
 * 歌词页每来一次播放器状态更新都会重建一份 song 对象（onPlayer 是高频回调），
 * 但内容其实几乎不变。这里用签名挡掉重复的 setSong —— 场景重建逐字时机要逐字量宽度，
 * 不挡住会让整机卡顿。
 */
function songSignature(input: LumiereSongInput | null): string {
  if (!input) return '';
  const first = input.lines[0];
  const last = input.lines[input.lines.length - 1];
  return `${input.trackKey}|${input.title}|${input.artist}|${input.durationMs}|${input.lyricOffsetMs}|${input.lines.length}|${first?.timeMs ?? 0}|${last?.timeMs ?? 0}|${lyricsTextDigest(input.lines)}`;
}

/** 把歌词导出的数据结构转成场景输入（结构一致，只是把类型换成场景自己的）。 */
function toSceneSong(input: LumiereSongInput): GeoSong {
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

export function createGeoStage(): GeoStage {
  const root = document.createElement('div');
  root.className = 'lyrics-stage is-geo';

  let disposed = false;
  let active = false;
  let mode: LumiereMode = 'off';
  let song: LumiereSongInput | null = null;
  let songKey = '';
  let scene: GeoScene | null = null;
  let raf = 0;
  let teardownTimer = 0;
  let painted = false;

  /* ── 播放时钟 / 音频 ──────────────────────────────────────── */

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

  /* ── 场景生命周期 ─────────────────────────────────────────── */

  const buildScene = (): void => {
    if (scene || disposed) return;
    try {
      scene = createGeoScene({
        style: geoStyleSettings(),
        onPainted: () => {
          if (painted || disposed) return;
          painted = true;
          root.classList.add('is-ready', 'is-painted');
          if ((song?.lines.length ?? 0) > 0) root.classList.add('is-content');
        },
      });
      root.appendChild(scene.root);
      liveScenes.add(scene);
      scene.setLyricTint(lyricTintProvider ? lyricTintProvider() : null);
      scene.resize();
      scene.setSong(song ? toSceneSong(song) : null);
      root.classList.remove('is-failed');
    } catch (error) {
      scene = null;
      root.classList.add('is-failed');
      console.error('[geo] 场景创建失败', error);
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

  /* ── 每帧 ─────────────────────────────────────────────────── */

  let frameFailure: unknown = null;

  const renderFrame = (): void => {
    if (!active || disposed || !scene) return;
    const now = performance.now();
    const rawPosition = anchorMs + (playing ? now - anchorAt : 0);
    const positionMs = Number.isFinite(rawPosition) ? Math.max(0, rawPosition) : 0;
    // 单帧异常不能让整条 rAF 链停掉：之前房间档一旦抛错就永久冻在那一帧。
    try {
      const energy = updateAudio();
      scene.update(positionMs, playing, energy);
    } catch (error) {
      if (frameFailure !== error) {
        frameFailure = error;
        console.error('[geo] 帧更新失败', error);
        (window as unknown as { __geoFrameError?: string }).__geoFrameError = String((error as Error)?.stack ?? error);
      }
    }
    raf = window.requestAnimationFrame(() => {
      renderFrame();
    });
  };

  /* ── 对外接口 ─────────────────────────────────────────────── */

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
