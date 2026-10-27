/**
 * 歌词页「唱片」效果独立预览入口（vite dev 下访问 /preview-vinyl.html）。
 *
 * 与 app 完全解耦：只依赖 web/src/ui/vinylScene.ts 的 createVinylScene 契约，
 * 自带一首约 48s、10 行、中英混合、逐词带 startMs/endMs 的假歌 vinylPreviewSong。
 *
 * URL 参数：
 *   ?t=秒          初始播放位置，默认 9（第一行歌词在 5s）
 *   ?play=0/1      默认 1；0 = 定位后暂停（截图用，画面静止但至少渲染一帧）
 *   ?debug=1       左上角极简角标：当前时间 / 行号 / 词数
 *   ?style=id 或 ?style=<URL 编码 JSON>  套用预设 / 覆盖设置
 *   ?lyric=id     歌词动画样式（沿用「关闭」歌词样式的 classic/rise/wave/swing/typewriter/spin）
 *   ?cover=0       不显示中心贴纸的示例封面（看纯色贴纸兜底效果）
 *
 * 供 headless CDP 截图脚本使用：
 *   window.__vinylPreview = { seek(ms), play(), pause(), positionMs, ready, scene }
 *   ready 在 vinylScene 的 onPainted（画布首次出像）后 resolve。
 */

import { createVinylScene } from '../ui/vinylScene';
import type { VinylScene, VinylSceneLine, VinylSceneSong, VinylSceneWord } from '../ui/vinylScene';
import { LYRIC_STYLES, setLyricStyle, type LyricStyle } from '../ui/lyricStyle';
import {
  DEFAULT_VINYL_SETTINGS,
  VINYL_STYLE_PRESETS,
  applyVinylPreset,
  normalizeVinylSettings,
  type VinylStyleSettings,
} from '../ui/vinylSettings';

/** ?style=预设名 或 ?style=<URL 编码 JSON>：给截图脚本切换观感用。 */
function readStyleParam(params: URLSearchParams): Partial<VinylStyleSettings> {
  const raw = params.get('style');
  if (!raw) return {};
  const preset = VINYL_STYLE_PRESETS.find((item) => item.id === raw);
  if (preset) return applyVinylPreset(DEFAULT_VINYL_SETTINGS, preset);
  try {
    return normalizeVinylSettings(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

interface VinylPreviewApi {
  readonly scene: VinylScene;
  readonly ready: Promise<void>;
  readonly positionMs: number;
  seek(positionMs: number): void;
  play(): void;
  pause(): void;
}

declare global {
  interface Window {
    __vinylPreview: VinylPreviewApi;
  }
}

/* ── 内置假歌：QRC 风格逐词时间，中英混合 ─────────────────────────────── */

const TRACK_DURATION_MS = 48_000;
const FIRST_LINE_MS = 5_000;
const INTRO_GAP_MS = 3_200;

/** 每行一组 token（中文按词切好，英文按单词），后面按视觉权重分逐词时间。 */
const RAW_PREVIEW_LINES: ReadonlyArray<{ tokens: readonly string[]; translation?: string }> = [
  { tokens: ['夜色', '落在', '唱片', '上'] },
  { tokens: ['old', 'songs', 'keep', 'turning'] },
  { tokens: ['暖光', '沿着', '纹路', '慢慢', '走'], translation: '暖光顺着黑胶的纹路走' },
  { tokens: ['我們', '把', '夜晚', '唱成', '了', '唱片'] },
  { tokens: ['needle', 'drops', 'into', 'the', 'quiet'] },
  { tokens: ['你', '听', '唱针', '在', '空气', '里', 'spin'] },
  { tokens: ['每', '一', '圈', '都', '是', '去年', '的', '夏天'] },
  { tokens: ['and', 'the', 'room', 'goes', 'soft', 'and', 'slow'], translation: '房间柔软又缓慢' },
  { tokens: ['如果', '明天', '太', '远', 'stay', 'with', 'me'] },
  { tokens: ['让', '这', '张', '唱片', '一直', '转', '下去'] },
];

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN_START_RE = /^[A-Za-z0-9]/;

/** 视觉权重：中文 1、英文 0.55、数字 0.6、标点 0.25，用于把行时长分给逐词。 */
function tokenWeight(token: string): number {
  let weight = 0;
  for (const char of token) {
    if (CJK_RE.test(char)) weight += 1;
    else if (/[A-Za-z]/.test(char)) weight += 0.55;
    else if (/[0-9]/.test(char)) weight += 0.6;
    else weight += 0.25;
  }
  return Math.max(0.25, weight);
}

function buildWords(tokens: readonly string[], startMs: number, durationMs: number): VinylSceneWord[] {
  const weights = tokens.map(tokenWeight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const words: VinylSceneWord[] = [];
  let cursor = startMs;
  tokens.forEach((text, index) => {
    const isLast = index === tokens.length - 1;
    const tailReserveMs = (tokens.length - 1 - index) * 80;
    const share = totalWeight === 0 ? 0 : ((weights[index] ?? 0) / totalWeight) * durationMs;
    const spanMs = Math.max(80, Math.min(share, startMs + durationMs - cursor - tailReserveMs));
    const endMs = isLast ? startMs + durationMs : Math.round(cursor + spanMs);
    words.push({
      text,
      startMs: Math.round(cursor),
      endMs: Math.max(Math.round(cursor) + 60, endMs),
      spaceBefore: index > 0 && LATIN_START_RE.test(text),
    });
    cursor = endMs;
  });
  return words;
}

/* ── 内置示例封面：预览页没有真实曲目，画一张同风格方形封面 ── */

function buildDemoCover(title: string, artist: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const grad = ctx.createLinearGradient(0, 0, 512, 512);
  grad.addColorStop(0, '#3a2a3f');
  grad.addColorStop(0.52, '#7d4b3a');
  grad.addColorStop(1, '#1d1418');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);
  const glow = ctx.createRadialGradient(392, 168, 6, 392, 168, 250);
  glow.addColorStop(0, 'rgba(255,236,200,0.92)');
  glow.addColorStop(0.34, 'rgba(255,205,150,0.34)');
  glow.addColorStop(1, 'rgba(255,205,150,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 512, 512);
  // 半圈细纹，既像封面装饰，也让旋转看得出来。
  ctx.strokeStyle = 'rgba(255,236,210,0.12)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 16; i += 1) {
    ctx.beginPath();
    ctx.arc(256, 256, 96 + i * 11, 0.08 * Math.PI, 0.92 * Math.PI);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,246,232,0.96)';
  ctx.font = '700 46px "Microsoft YaHei UI", "Noto Sans SC", sans-serif';
  ctx.fillText(title, 256, 318);
  ctx.fillStyle = 'rgba(255,246,232,0.62)';
  ctx.font = '400 22px "Segoe UI", "Microsoft YaHei UI", sans-serif';
  ctx.fillText(artist.toUpperCase(), 256, 356);
  return canvas.toDataURL('image/jpeg', 0.9);
}

const DEMO_COVER_URL = buildDemoCover('午夜唱片', 'Zilux2 Preview');

function buildPreviewSong(): VinylSceneSong {
  const lineGapMs = (TRACK_DURATION_MS - FIRST_LINE_MS - INTRO_GAP_MS) / RAW_PREVIEW_LINES.length;
  const lines: VinylSceneLine[] = RAW_PREVIEW_LINES.map((raw, index) => {
    const timeMs = Math.round(FIRST_LINE_MS + index * lineGapMs);
    const durationMs = Math.round(lineGapMs - 600);
    const words = buildWords(raw.tokens, timeMs, durationMs);
    const text = words.map((word, wordIndex) => (wordIndex > 0 && word.spaceBefore ? ' ' : '') + word.text).join('');
    const line: VinylSceneLine = { timeMs, durationMs, text, words };
    if (raw.translation !== undefined) line.translation = raw.translation;
    return line;
  });
  return {
    trackKey: 'zilux-vinyl-preview',
    title: '午夜唱片',
    artist: 'Zilux2 Preview',
    album: 'Preview Session',
    coverUrl: DEMO_COVER_URL,
    durationMs: TRACK_DURATION_MS,
    lyricOffsetMs: 0,
    lines,
  };
}

/** 内置假歌：10 行、中英混合、逐词时间，约 48s。 */
export const vinylPreviewSong: VinylSceneSong = buildPreviewSong();

/* ── 调试角标（?debug=1） ─────────────────────────────────────────── */

interface DebugBadge {
  render(positionMs: number): void;
}

function findLineIndex(lines: readonly VinylSceneLine[], positionMs: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const line = lines[mid];
    if (line && line.timeMs <= positionMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function createDebugBadge(): DebugBadge {
  const element = document.createElement('div');
  element.id = 'debug-badge';
  document.body.appendChild(element);
  return {
    render(positionMs: number): void {
      const index = findLineIndex(vinylPreviewSong.lines, positionMs);
      const line = index >= 0 ? vinylPreviewSong.lines[index] : null;
      const wordCount = line ? line.words.length : 0;
      const sung = line ? line.words.filter((word) => word.endMs <= positionMs).length : 0;
      const active = line ? line.words.filter((word) => word.startMs <= positionMs && positionMs < word.endMs).length : 0;
      element.textContent =
        `t=${(positionMs / 1000).toFixed(2)}s  line=${index + 1}/${vinylPreviewSong.lines.length}` +
        `  words=${wordCount} sung=${sung} active=${active}`;
    },
  };
}

/* ── 播放控制 ─────────────────────────────────────────────────────── */

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 暂停时多渲染几帧，让唱臂/唱片停转的阻尼在截图前收敛到位。 */
const SETTLE_FRAMES = 36;

function main(): void {
  const stage = document.getElementById('stage');
  if (!stage) throw new Error('preview-vinyl.html 缺少 #stage 容器');

  const params = new URLSearchParams(window.location.search);
  const debug = readFlagParam(params, 'debug', false);
  let positionMs = clamp(readNumberParam(params, 't', 9) * 1000, 0, vinylPreviewSong.durationMs);
  let playing = readFlagParam(params, 'play', true);
  // ?cover=0：隐藏中心封面，用来看纯色贴纸的兜底效果。
  if (!readFlagParam(params, 'cover', true)) vinylPreviewSong.coverUrl = '';
  // ?lyric=rise/wave/swing/typewriter/spin/classic：套用「播放效果 = 关闭」的歌词播放动画。
  const lyricParam = params.get('lyric');
  if (lyricParam && LYRIC_STYLES.some((item) => item.id === lyricParam)) {
    setLyricStyle(lyricParam as LyricStyle);
  }

  let seekRaf = 0;
  let seekFrames = 0;
  let playRaf = 0;
  let lastFrameMs = 0;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const scene = createVinylScene({
    style: readStyleParam(params),
    onPainted: () => {
      resolveReady();
    },
  });

  stage.appendChild(scene.root);
  const badge = debug ? createDebugBadge() : null;
  const renderBadge = (): void => {
    if (badge) badge.render(positionMs);
  };

  const seekTick = (): void => {
    seekRaf = 0;
    if (seekFrames <= 0 || playing) return;
    seekFrames -= 1;
    scene.update(positionMs, false);
    if (seekFrames > 0) seekRaf = window.requestAnimationFrame(seekTick);
  };

  const pumpSeekFrames = (): void => {
    if (playing) return;
    seekFrames = SETTLE_FRAMES;
    if (seekRaf === 0) seekRaf = window.requestAnimationFrame(seekTick);
  };

  const playTick = (nowMs: number): void => {
    if (!playing) return;
    const deltaMs = lastFrameMs === 0 ? 0 : Math.min(250, nowMs - lastFrameMs);
    lastFrameMs = nowMs;
    positionMs = Math.min(vinylPreviewSong.durationMs, positionMs + deltaMs);
    scene.update(positionMs, true);
    renderBadge();
    if (positionMs >= vinylPreviewSong.durationMs) {
      playing = false;
      playRaf = 0;
      scene.update(positionMs, false);
      return;
    }
    playRaf = window.requestAnimationFrame(playTick);
  };

  const play = (): void => {
    if (playing) return;
    playing = true;
    lastFrameMs = 0;
    seekFrames = 0;
    if (seekRaf !== 0) {
      window.cancelAnimationFrame(seekRaf);
      seekRaf = 0;
    }
    playRaf = window.requestAnimationFrame(playTick);
  };

  const pause = (): void => {
    playing = false;
    if (playRaf !== 0) {
      window.cancelAnimationFrame(playRaf);
      playRaf = 0;
    }
    scene.update(positionMs, false);
    renderBadge();
    pumpSeekFrames();
  };

  const seek = (nextPositionMs: number): void => {
    positionMs = clamp(nextPositionMs, 0, vinylPreviewSong.durationMs);
    scene.update(positionMs, playing);
    renderBadge();
    pumpSeekFrames();
  };

  window.addEventListener('resize', () => {
    scene.resize();
  });

  // 契约启动顺序：append root → resize → setSong → update(初始位置, false)。
  scene.resize();
  scene.setSong(vinylPreviewSong);
  scene.update(positionMs, false);
  renderBadge();
  pumpSeekFrames();
  if (playing) play();

  window.__vinylPreview = {
    scene,
    ready,
    get positionMs(): number {
      return positionMs;
    },
    seek,
    play,
    pause,
  };
}

main();
