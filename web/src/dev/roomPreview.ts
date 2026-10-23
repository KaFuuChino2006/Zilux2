/**
 * 歌词页「房间」效果独立预览入口（vite dev 下访问 /preview-room.html）。
 *
 * 与 app 完全解耦：只依赖 web/src/ui/roomScene.ts 的 createRoomScene 契约，
 * 自带一首约 4 分钟、40 行、中英混合、逐词带 startMs/endMs 的假歌 roomPreviewSong。
 *
 * URL 参数：
 *   ?t=秒          初始播放位置，默认 10（第一行歌词在 8s）
 *   ?play=0/1      默认 1；0 = 定位后暂停（截图用，画面静止但至少渲染一帧）
 *   ?debug=1       左上角极简角标：当前时间 / 行号 / 词数
 *
 * 供 headless CDP 截图脚本使用：
 *   window.__roomPreview = { seek(ms), play(), pause(), positionMs, ready, scene }
 *   ready 在 roomScene 的 onPainted（画布首次出像）后 resolve。
 */

import { createRoomScene } from '../ui/roomScene';
import type { RoomScene, RoomSceneLine, RoomSceneSong, RoomSceneWord } from '../ui/roomScene';
import {
  DEFAULT_ROOM_SETTINGS,
  ROOM_STYLE_PRESETS,
  applyRoomPreset,
  normalizeRoomSettings,
  type RoomStyleSettings,
} from '../ui/roomSettings';

/** ?style=预设名 或 ?style=<URL 编码 JSON>：给截图脚本切换观感用。 */
function readStyleParam(params: URLSearchParams): Partial<RoomStyleSettings> {
  const raw = params.get('style');
  if (!raw) return {};
  const preset = ROOM_STYLE_PRESETS.find((item) => item.id === raw);
  if (preset) return applyRoomPreset(DEFAULT_ROOM_SETTINGS, preset);
  try {
    return normalizeRoomSettings(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

interface RoomPreviewApi {
  readonly scene: RoomScene;
  readonly ready: Promise<void>;
  readonly positionMs: number;
  seek(positionMs: number): void;
  play(): void;
  pause(): void;
}

declare global {
  interface Window {
    __roomPreview: RoomPreviewApi;
  }
}

/* ── 内置假歌：QRC 风格逐词时间，中英混合 ─────────────────────────────── */

interface RawPreviewLine {
  readonly tokens: readonly string[];
  readonly translation?: string;
}

const TRACK_DURATION_MS = 240_000;
const FIRST_LINE_MS = 8_000;
/**
 * 前 9 行压在开场 27s 内（2.2~2.6s 一行，首行 8s）：保证前 30 秒有 8 行以上，
 * 方便截图脚本在开场密集取点；之后每行 6.4~7.0s，40 行正好收在 240s。
 * 每行 durationMs 单独给定（4~6s，Lead 要求），与行间隔解耦：开场行会轻微重叠，
 * roomScene 按每个词自己的 startMs/endMs 渲染，重叠只表现为更多词同屏，是预期效果。
 */
const INTRO_GAPS_MS: readonly number[] = [2400, 2200, 2600, 2300, 2500, 2200, 2400, 2400];
const BODY_GAPS_MS: readonly number[] = [7000, 6900, 6950, 7000, 6900, 6900, 6950, 7000, 6900, 6900];
const LINE_DURATION_MIN_MS = 4000;
const LINE_DURATION_MAX_MS = 6000;
/** 每行 5~8 个词，全部落在 4~14 词的 QRC 常见区间内。 */
const RAW_PREVIEW_LINES: readonly RawPreviewLine[] = [
  { tokens: ['夜色', '落在', '窗沿', 'We', 'keep', 'the', 'lights', 'low'] },
  { tokens: ['你说', '别急', '让', '风', 'slow', 'down', 'tonight'] },
  { tokens: ['The', 'room', 'is', 'breathing', 'in', 'slow', 'motion'], translation: '房间在缓慢地呼吸' },
  { tokens: ['薄荷色', '的', '光', '沿着', '墙角', '漫开'] },
  { tokens: ['我们', '把', '影子', '折成', '纸船'] },
  { tokens: ['let', 'them', 'drift', 'into', 'the', 'quiet'] },
  { tokens: ['旧唱针', '转啊', '转', 'like', 'a', 'prayer'] },
  { tokens: ['唱片', '里', '藏', '着', '去年', '的', '夏天'] },
  { tokens: ['I', 'can', 'hear', 'the', 'city', 'falling', 'asleep'], translation: '我能听见城市睡着' },
  { tokens: ['窗外', '的', '雨', '写', '满', '玻璃'] },
  { tokens: ['每一滴', '都', '是', '未发送', '的', 'message'] },
  { tokens: ['Tell', 'me', 'where', 'the', 'night', 'goes'], translation: '告诉我夜晚会去哪里' },
  { tokens: ['当', '所有', '灯光', '都', '退成', '背景'] },
  { tokens: ['You', 'are', 'the', 'only', 'color', 'left'] },
  { tokens: ['薄荷', '与', '白', '铺满', '这', '间', 'room'] },
  { tokens: ['呼吸', '变', '慢', 'heartbeat', 'soft', 'and', 'clear'], translation: '心跳柔软而清晰' },
  { tokens: ['我们', '不', '需要', '说', '太多'] },
  { tokens: ['just', 'stay', 'here', 'for', 'a', 'little', 'while'] },
  { tokens: ['时钟', '停', '在', '三点', 'twenty', 'five'] },
  { tokens: ['月光', '落', '在', '地毯', '上', 'like', 'dust'] },
  { tokens: ['I', 'wish', 'this', 'moment', 'could', 'replay'] },
  { tokens: ['一遍', '又', '一遍', '的', 'same', 'old', 'song'] },
  { tokens: ['你', '闭', '上', '眼', 'we', 'float', 'away'] },
  { tokens: ['房间', '没有', '门', '也', '没有', 'exit'] },
  { tokens: ['只有', '我们', '和', '这', '片', 'silence'] },
  { tokens: ['如果', '明天', '太', '远', 'stay', 'with', 'me'], translation: '如果明天太远 就留在我身边' },
  { tokens: ['把', '时间', '调', '成', '慢速', '播放'] },
  { tokens: ['we', "don't", 'need', 'a', 'reason', 'now'] },
  { tokens: ['灯', '灭', '了', '也', '别', '离开'] },
  { tokens: ['The', 'floor', 'is', 'warm', 'under', 'our', 'feet'] },
  { tokens: ['像', '一整片', '薄荷', '味', '的', '海'], translation: '像一整片薄荷味的海' },
  { tokens: ['and', 'we', 'are', 'drifting', 'in', 'it'] },
  { tokens: ['如果', '梦', '会', '醒', 'let', 'it', 'linger'] },
  { tokens: ['再', '给', '我', '一秒', 'of', 'this', 'quiet'] },
  { tokens: ['你', '听', '唱针', '在', '空气', '里', 'spin'] },
  { tokens: ['Every', 'word', 'turns', 'into', 'light'], translation: '每个字都变成光' },
  { tokens: ['落', '在', '你', '睫毛', '上', 'softly'] },
  { tokens: ['我们', '就', '这样', '待', '着', 'stay', 'awhile'] },
  { tokens: ['直到', '天亮', 'before', 'we', 'know', 'it'] },
  { tokens: ['this', 'room', 'is', 'all', 'we', 'need'] },
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

function buildWords(tokens: readonly string[], startMs: number, durationMs: number): RoomSceneWord[] {
  const weights = tokens.map(tokenWeight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const words: RoomSceneWord[] = [];
  let cursor = startMs;
  tokens.forEach((text, index) => {
    const isLast = index === tokens.length - 1;
    const tailReserveMs = (tokens.length - 1 - index) * 90;
    const share = totalWeight === 0 ? 0 : (weights[index] / totalWeight) * durationMs;
    const spanMs = Math.max(90, Math.min(share, startMs + durationMs - cursor - tailReserveMs));
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

function buildLine(raw: RawPreviewLine, startMs: number, durationMs: number): RoomSceneLine {
  const words = buildWords(raw.tokens, startMs, durationMs);
  const text = words.map((word, index) => (index > 0 && word.spaceBefore ? ' ' : '') + word.text).join('');
  const line: RoomSceneLine = { timeMs: startMs, durationMs, text, words };
  if (raw.translation !== undefined) line.translation = raw.translation;
  return line;
}

/** 40 行的行首时间：开场 9 行密集压进 27s，其余按 6.4~7.0s 排到 235.2s。 */
function buildLineStartTimes(): number[] {
  const starts: number[] = [];
  let timeMs = FIRST_LINE_MS;
  RAW_PREVIEW_LINES.forEach((_raw, index) => {
    starts.push(timeMs);
    if (index < INTRO_GAPS_MS.length) {
      timeMs += INTRO_GAPS_MS[index] ?? 2400;
    } else {
      timeMs += BODY_GAPS_MS[(index - INTRO_GAPS_MS.length) % BODY_GAPS_MS.length] ?? 6900;
    }
  });
  return starts;
}

function buildPreviewSong(): RoomSceneSong {
  const starts = buildLineStartTimes();
  const lines: RoomSceneLine[] = [];
  RAW_PREVIEW_LINES.forEach((raw, index) => {
    const isLast = index === RAW_PREVIEW_LINES.length - 1;
    const nextStart = isLast ? TRACK_DURATION_MS : starts[index + 1] ?? TRACK_DURATION_MS;
    const durationMs = isLast
      ? Math.max(LINE_DURATION_MIN_MS, Math.min(LINE_DURATION_MAX_MS, TRACK_DURATION_MS - (starts[index] ?? 0)))
      : Math.min(LINE_DURATION_MAX_MS, Math.max(LINE_DURATION_MIN_MS, nextStart - (starts[index] ?? 0)));
    lines.push(buildLine(raw, starts[index] ?? FIRST_LINE_MS, durationMs));
  });
  return {
    title: '薄荷房间',
    artist: 'Zilux2 Preview',
    album: 'Preview Session',
    durationMs: TRACK_DURATION_MS,
    lyricOffsetMs: 0,
    lines,
  };
}

/** 内置假歌：40 行、中英混合、逐词时间，约 240s。 */
export const roomPreviewSong: RoomSceneSong = buildPreviewSong();

/* ── 调试角标（?debug=1） ─────────────────────────────────────────── */

interface DebugBadge {
  render(positionMs: number): void;
}

function findLineIndex(lines: readonly RoomSceneLine[], positionMs: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const line = lines[mid];
    if (line.timeMs <= positionMs) {
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
      const index = findLineIndex(roomPreviewSong.lines, positionMs);
      const line = index >= 0 ? roomPreviewSong.lines[index] : null;
      const wordCount = line ? line.words.length : 0;
      const sung = line ? line.words.filter((word) => word.endMs <= positionMs).length : 0;
      const active = line ? line.words.filter((word) => word.startMs <= positionMs && positionMs < word.endMs).length : 0;
      element.textContent =
        `t=${(positionMs / 1000).toFixed(2)}s  line=${index + 1}/${roomPreviewSong.lines.length}` +
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

/** 暂停时多渲染几帧，让 roomScene 里的镜头阻尼/淡入在截图前收敛到位。 */
const SETTLE_FRAMES = 36;

function main(): void {
  const stage = document.getElementById('stage');
  if (!stage) throw new Error('preview-room.html 缺少 #stage 容器');

  const params = new URLSearchParams(window.location.search);
  const debug = readFlagParam(params, 'debug', false);
  let positionMs = clamp(readNumberParam(params, 't', 10) * 1000, 0, roomPreviewSong.durationMs);
  let playing = readFlagParam(params, 'play', true);

  let seekRaf = 0;
  let seekFrames = 0;
  let playRaf = 0;
  let lastFrameMs = 0;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const scene = createRoomScene({
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
    positionMs = Math.min(roomPreviewSong.durationMs, positionMs + deltaMs);
    scene.update(positionMs, true);
    renderBadge();
    if (positionMs >= roomPreviewSong.durationMs) {
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
    positionMs = clamp(nextPositionMs, 0, roomPreviewSong.durationMs);
    scene.update(positionMs, playing);
    renderBadge();
    pumpSeekFrames();
  };

  window.addEventListener('resize', () => {
    scene.resize();
  });

  // 契约启动顺序：append root → resize → setSong → update(初始位置, false)。
  scene.resize();
  scene.setSong(roomPreviewSong);
  scene.update(positionMs, false);
  renderBadge();
  pumpSeekFrames();
  if (playing) play();

  window.__roomPreview = {
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
