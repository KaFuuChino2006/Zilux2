/**
 * 沉浸式歌词页：全屏、封面模糊背景、逐行 +（有逐字数据时）逐字高亮。
 * 数据来源：QQ QRC（解密）→ 网易云 yrc → 普通 LRC → 本地同名 .lrc。
 */

import { decryptQrc } from 'qrc-decoder';
import { fetchLyric } from '../online/client';
import {
  applyTranslation,
  extractQrcPayload,
  parseCharLyric,
  parseLrc,
  parseQrcLyric,
  type LyricLine as SourceLine,
} from '../online/lrc';
import { SOURCE_LABEL, type OnlineTrack } from '../online/types';
import { onlineArtwork } from '../online/artwork';
import { fetchLocalLrc, lrcOf } from './local';
import { fmtTime, h, icon } from './dom';
import { onPlayer, playerState, seek, type PlayerState } from './player';
import { matchMinScore, matchTranslation, matchWordLyrics, setMatchMinScore, type LyricMatchResult } from './lyricMatch';
import { coverColorsOf, fallbackColors } from './coverColors';
import { createLumiereStage, lumiereMode, lumiereThemeForCover, setLumiereMode, type LumiereMode, type LumiereSongInput, type LumiereStage } from './lumiere';
import { createRoomStage, setRoomLyricTintProvider, type RoomStage } from './room';
import type { Theme } from './lumiere-folia/types';
import type { LyricTextSettings } from './lumiereSettings';
import { lyricStyle, onLyricStyle } from './lyricStyle';
import { playbackAnalyser } from '../core/audioTap';

/** 歌词页播放效果（纯字）；导出给快捷设置用。 */
export type { LumiereMode };

/** 当前播放效果。 */
export function lyricsLumiereMode(): LumiereMode {
  return lumiereMode();
}

/** 切换播放效果；歌词页开着时立即生效。 */
export function setLyricsLumiereMode(mode: LumiereMode): void {
  setLumiereMode(mode);
  activeLyricsView?.applyLumiereMode();
}

/** 应用「文字设置」：不传就读本机保存的值；歌词页开着时立即重绘（面板实时预览也走这里）。 */
export function applyLyricTextSettings(settings?: LyricTextSettings): void {
  activeLyricsView?.applyLumiereTextSettings(settings);
}

/** 「文字设置」预览面板要的当前歌曲；歌词页没开（或还没拿到歌词）时返回 null。 */
export function lyricPreviewSong(): LumiereSongInput | null {
  const view = activeLyricsView;
  if (!view) return null;
  const song = view.buildLumiereSong();
  return song.lines.length > 0 ? song : null;
}

/** 歌词页背景：纯色 / 封面色 / 自动渐变。 */
export type LyricsBgMode = 'solid' | 'cover' | 'gradient';

/** 纯字档当前使用的主题（跟随「歌词颜色」从封面取色）。「文字设置」的预览也用它。 */
let lumiereThemeNow: Theme = lumiereThemeForCover('solid', null);
let lumierePaletteNow: string[] | null = null;

/** 「文字设置」面板创建预览舞台时用这个主题，和歌词页保持一致。 */
export function lyricsLumiereTheme(): Theme {
  return lumiereThemeNow;
}

/** 「文字设置」面板创建预览舞台时用这个色板，和歌词页保持一致（关键字按它上色）。 */
export function lyricsLumierePalette(): string[] | null {
  return lumierePaletteNow;
}

const LYRICS_BG_KEY = 'zilux2.lyricsBg';

function readLyricsBgMode(): LyricsBgMode {
  try {
    const value = window.localStorage.getItem(LYRICS_BG_KEY);
    if (value === 'solid' || value === 'cover' || value === 'gradient') {
      return value;
    }
  } catch {
    // ignore
  }
  return 'gradient';
}

let lyricsBgMode: LyricsBgMode = readLyricsBgMode();

// 把「纯色 / 封面色 / 自动渐变」档位与封面取色板交给房间场景（房间逐词按它上色）。
// 注册放在变量声明之后，避免模块初始化时读到 let 的暂时性死区。
setRoomLyricTintProvider(() => {
  // 纯色档没有封面取色，用房间标准的暖白三态（和默认观感一致）；
  // 封面色/自动渐变才走封面取色板。
  if (lyricsBgMode === 'solid') {
    return { mode: 'solid', palette: ['#fff9f2', '#fffdfa', '#ffffff'] };
  }
  return { mode: lyricsBgMode, palette: lumierePaletteNow ? [...lumierePaletteNow] : [] };
});
let activeLyricsView: LyricsView | null = null;

/** 当前歌词页背景模式（快捷设置里展示用）。 */
export function lyricsBackgroundMode(): LyricsBgMode {
  return lyricsBgMode;
}

/** 修改歌词页背景模式；歌词页开着时会立即生效。 */
export function setLyricsBackgroundMode(mode: LyricsBgMode): void {
  lyricsBgMode = mode;
  try {
    window.localStorage.setItem(LYRICS_BG_KEY, mode);
  } catch {
    // ignore
  }
  activeLyricsView?.syncBackgroundMode();
}

/** 当前行放大动效：off=不弹（直接变大）、soft=轻弹一下、bounce=弹一下、wild=弹得更狠。 */
export type LyricGrowMode = 'off' | 'soft' | 'bounce' | 'wild';

const LYRIC_GROW_KEY = 'zilux2.lyricGrow';

function readLyricGrowMode(): LyricGrowMode {
  try {
    const value = window.localStorage.getItem(LYRIC_GROW_KEY);
    if (value === 'off' || value === 'soft' || value === 'bounce' || value === 'wild') {
      return value;
    }
  } catch {
    // ignore
  }
  return 'bounce';
}

let lyricGrow: LyricGrowMode = readLyricGrowMode();

/** 当前歌词动效档位（快捷设置里展示用）。 */
export function lyricGrowMode(): LyricGrowMode {
  return lyricGrow;
}

/** 修改歌词动效档位；歌词页开着时当前行会立刻按新曲线重播一次，方便直接看效果。 */
export function setLyricGrowMode(mode: LyricGrowMode): void {
  lyricGrow = mode;
  try {
    window.localStorage.setItem(LYRIC_GROW_KEY, mode);
  } catch {
    // ignore
  }
  activeLyricsView?.replayGrow();
}

export interface LyricWord {
  text: string;
  startMs: number;
  endMs: number;
  /** 词前是否有空格（英文单词间距用，渲染时加 has-gap 类）。 */
  spaceBefore?: boolean;
}

export interface LyricLine {
  timeMs: number;
  durationMs: number;
  text: string;
  translation: string;
  words: LyricWord[];
}

export interface LyricDoc {
  lines: LyricLine[];
  /** 数据来源，便于排查（qrc/yrc/lrc/none） */
  kind: 'qrc' | 'yrc' | 'lrc' | 'none';
  trackKey: string;
}

const EMPTY: LyricDoc = { lines: [], kind: 'none', trackKey: '' };

const OFFSET_KEY = 'zilux2.lyricOffsets';

function readOffsets(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(OFFSET_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/** 每首歌独立记忆的歌词时间轴偏移（毫秒，正数=歌词提前）。 */
const lyricOffsets: Record<string, number> = readOffsets();
let lyricSource = '';
let primeKey = '';
let lyricMatchInfo: LyricMatchResult | null = null;
let lyricMatchSkipped = false;
let lyricMatchDone = false;
/** 'word' = 找逐字替换；'translation' = 已有逐字、只补翻译。 */
let lyricMatchMode: 'word' | 'translation' | 'direct' = 'word';
/** 手动选择的歌词来源（非空时不再自动匹配）。 */
let manualLyricLabel = '';
/** 每首歌记住的手动歌词来源：trackKey -> { source, id, label }。 */
const MANUAL_KEY = 'zilux2.lyricManual';
interface ManualLyric {
  source: string;
  id: string;
  label: string;
}
function readManual(): Record<string, ManualLyric> {
  try {
    const raw = window.localStorage.getItem(MANUAL_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, ManualLyric>;
  } catch {
    return {};
  }
}
function writeManual(map: Record<string, ManualLyric>): void {
  try {
    window.localStorage.setItem(MANUAL_KEY, JSON.stringify(map));
  } catch {
    /* 忽略写入失败 */
  }
}
const matchListeners = new Set<() => void>();

function notifyMatch(): void {
  matchListeners.forEach((listener) => listener());
}

/** 订阅「后台匹配结果」变化（歌词页据此升级为逐字版本）。 */
export function onLyricMatch(listener: () => void): () => void {
  matchListeners.add(listener);
  return () => {
    matchListeners.delete(listener);
  };
}

export function currentLyricMatch(): LyricMatchResult | null {
  return lyricMatchInfo;
}

function percent(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

/** 当前歌词来源的平台名（如「QQ 音乐」），用于「翻译取自…」。 */
function basePlatformName(): string {
  const first = lyricSource.split('·')[0]?.trim() ?? '';
  return first.length > 0 ? first : '当前平台';
}

/** 快捷设置里显示的匹配度文案。 */
export function lyricMatchText(): string {
  if (manualLyricLabel) return `手动选择：${manualLyricLabel}`;
  const translationMode = lyricMatchMode === 'translation';
  const directMode = lyricMatchMode === 'direct';
  if (lyricMatchSkipped) return '当前平台已自带逐字与翻译，无需匹配';
  if (!lyricMatchDone) {
    return directMode ? '正在线上查找歌词…' : translationMode ? '正在搜索翻译…' : '匹配中…';
  }
  if (!lyricMatchInfo) {
    if (directMode) return '线上也没找到歌词';
    return translationMode ? '没找到其它平台的翻译，保留原歌词' : '没找到其它平台的逐字歌词，保留原歌词';
  }
  if (lyricMatchInfo.direct) {
    return `线上歌词：${lyricMatchInfo.label}（${percent(lyricMatchInfo.score)}%）`;
  }
  if (lyricMatchInfo.translationKept) {
    return `${lyricMatchInfo.label} · ${percent(lyricMatchInfo.score)}%（没翻译，保留当前平台带翻译的歌词）`;
  }
  const base = `${lyricMatchInfo.label} · ${percent(lyricMatchInfo.score)}%`;
  if (lyricMatchInfo.translationOnly) {
    return `翻译取自 ${lyricMatchInfo.translationFromOther ?? '其它平台'}（${percent(lyricMatchInfo.score)}%）`;
  }
  if (lyricMatchInfo.translationFromBase) {
    return `${base}（逐字来自对方平台，翻译取自 ${basePlatformName()}）`;
  }
  if (lyricMatchInfo.translationFromOther) {
    return `${base}（逐字来自对方平台，翻译取自 ${lyricMatchInfo.translationFromOther}）`;
  }
  if (lyricMatchInfo.lines) return base;
  if (lyricMatchInfo.belowThreshold) {
    return `${lyricMatchInfo.label} · ${percent(lyricMatchInfo.score)}%（低于阈值 ${percent(lyricMatchMinScore())}%，保留原歌词）`;
  }
  return `${base}（对方平台只有整行歌词，无逐字）`;
}

/** 歌词页封面下方的来源注释：当前平台歌词 + 跨平台匹配结果 + 翻译来源。 */
export function lyricSourceText(): string {
  if (!lyricSource) return '';
  const info = lyricMatchInfo;
  const translationMode = lyricMatchMode === 'translation';
  const directMode = lyricMatchMode === 'direct';
  if (manualLyricLabel) return `${lyricSource} · 手动选择`;
  if (lyricMatchSkipped) return `${lyricSource} · 已自带逐字与翻译`;
  if (!lyricMatchDone) {
    return directMode ? '线上歌词 · 正在查找…' : `${lyricSource} · ${translationMode ? '正在搜索翻译…' : '正在匹配逐字…'}`;
  }
  if (!info) {
    if (directMode) return '线上歌词 · 未找到';
    return `${lyricSource} · ${translationMode ? '未找到其它平台的翻译' : '其它平台未匹配到逐字'}`;
  }
  if (info.direct) {
    return `线上歌词 · ${info.label} · 匹配 ${percent(info.score)}%`;
  }
  const base = `${lyricSource} · 匹配 ${percent(info.score)}%`;
  if (info.translationOnly) {
    return `${lyricSource} · 翻译取自 ${info.translationFromOther ?? '其它平台'}`;
  }
  if (info.translationFromBase) {
    return `${base} · 翻译取自 ${basePlatformName()}`;
  }
  if (info.translationFromOther) {
    return `${base} · 翻译取自 ${info.translationFromOther}`;
  }
  if (info.translationKept) return `${base} · 保留当前平台带翻译的歌词`;
  if (info.lines) return `${base} · 逐字 ${info.label}`;
  if (info.belowThreshold) return `${base} · 低于阈值 ${percent(lyricMatchMinScore())}%，未替换`;
  return `${base} · 其它平台无逐字（只有整行）`;
}

/** 当前跨平台匹配度阈值（0~1）。 */
export function lyricMatchMinScore(): number {
  return matchMinScore();
}

/** 调整匹配度阈值，并立刻用新阈值重跑当前歌曲的后台匹配。 */
export function setLyricMatchMinScore(value: number): void {
  setMatchMinScore(value);
  const current = playerState().track;
  if (!lastDoc || !current) {
    lyricMatchDone = false;
    lyricMatchInfo = null;
    notifyMatch();
    return;
  }
  startLyricMatch(current, lastDoc);
}

/** 后台匹配逐字歌词：命中就替换 lastDoc 并通知界面，未命中只更新匹配度。 */
function startLyricMatch(track: OnlineTrack, base: LyricDoc): void {
  lyricMatchInfo = null;
  if (manualLyricLabel) {
    // 用户手动选了歌词来源：以手动选择为准，不再后台替换。
    lyricMatchSkipped = true;
    lyricMatchDone = true;
    notifyMatch();
    return;
  }
  const baseHasTranslation = base.lines.some((line) => (line.translation ?? '').trim().length > 0);
  // 当前平台歌词本身就有逐字数据：有翻译就不用再匹配，没翻译仍去其它平台找翻译。
  const alreadyWordLevel = base.kind === 'qrc' || base.kind === 'yrc';
  const hasLyrics = base.lines.length > 0;
  // 当前曲目完全没有歌词 → 直接线上取（不比较匹配度）
  lyricMatchMode = !hasLyrics ? 'direct' : alreadyWordLevel ? 'translation' : 'word';
  lyricMatchSkipped = hasLyrics && alreadyWordLevel && baseHasTranslation;
  lyricMatchDone = false;
  notifyMatch();
  if (alreadyWordLevel) {
    if (baseHasTranslation) return;
    void matchTranslation(track, base.lines)
      .then((result) => {
        if (lastDoc?.trackKey !== base.trackKey) return;
        lyricMatchDone = true;
        lyricMatchInfo = result;
        if (result) updateCurrentLyricLine();
        notifyMatch();
      })
      .catch(() => {
        if (lastDoc?.trackKey !== base.trackKey) return;
        lyricMatchDone = true;
        lyricMatchInfo = null;
        notifyMatch();
      });
    return;
  }
  void matchWordLyrics(track, base.lines)
    .then((result) => {
      if (lastDoc?.trackKey !== base.trackKey) return;
      if (result?.lines || baseHasTranslation) {
        lyricMatchDone = true;
        lyricMatchInfo = result;
        if (result?.lines) {
          lastDoc = { ...base, kind: result.kind === 'lrc' ? base.kind : result.kind, lines: result.lines };
          lyricSource = result.label;
          updateCurrentLyricLine();
        }
        notifyMatch();
        return;
      }
      // 没匹配到逐字（本地 LRC / 在线整行歌词同理）：再向其它平台借一份翻译贴到现有歌词上
      void matchTranslation(track, base.lines)
        .then((translated) => {
          if (lastDoc?.trackKey !== base.trackKey) return;
          lyricMatchDone = true;
          lyricMatchInfo = translated ?? result;
          if (translated && lastDoc) {
            lastDoc = { ...lastDoc, lines: base.lines };
            updateCurrentLyricLine();
          }
          notifyMatch();
        })
        .catch(() => {
          if (lastDoc?.trackKey !== base.trackKey) return;
          lyricMatchDone = true;
          lyricMatchInfo = result;
          notifyMatch();
        });
    })
    .catch(() => {
      if (lastDoc?.trackKey !== base.trackKey) return;
      lyricMatchDone = true;
      lyricMatchInfo = null;
      notifyMatch();
    });
}
let lastDoc: LyricDoc | null = null;

function writeOffsets(): void {
  try {
    window.localStorage.setItem(OFFSET_KEY, JSON.stringify(lyricOffsets));
  } catch {
    /* 忽略写入失败 */
  }
}

/** 当前曲目的歌词来源说明（本地 LRC / QQ QRC / 网易云 YRC / LRC）。 */
export function currentLyricSource(): string {
  return lyricSource;
}

export function lyricOffsetOf(trackKey: string): number {
  return lyricOffsets[trackKey] ?? 0;
}

export function setLyricOffset(ms: number, trackKey: string): void {
  if (!trackKey) return;
  const value = Math.max(-6000, Math.min(6000, Math.round(ms / 10) * 10));
  if (value === 0) delete lyricOffsets[trackKey];
  else lyricOffsets[trackKey] = value;
  writeOffsets();
}

/** 打开快捷设置/歌词页之前先把歌词拉下来，这样来源与当前句立刻可见。 */
export function primeLyrics(track: OnlineTrack | null): void {
  const key = trackKeyOf(track);
  if (!key || primeKey === key) return;
  if (lastDoc && lastDoc.trackKey === key) return;
  primeKey = key;
  void loadLyricDoc(track)
    .then((doc) => {
      if (doc.trackKey === key) {
        lastDoc = doc;
        updateCurrentLyricLine();
        if (track) startLyricMatch(track, doc);
      }
    })
    .catch(() => undefined)
    .finally(() => {
      if (primeKey === key) primeKey = '';
    });
}

function trackKeyOf(track: OnlineTrack | null): string {
  if (!track) return '';
  return `${track.source}:${track.id}`;
}

/** 把逐字数据拼成整行文本（按 spaceBefore 补回英文单词之间的空格）。 */
function joinWords(words: { text: string; spaceBefore?: boolean }[]): string {
  return words
    .map((item, index) => `${index > 0 && item.spaceBefore ? ' ' : ''}${item.text}`)
    .join('');
}

/** 纯 LRC 行 → 带时长/逐字信息的统一行（时长用下一行开始时间推算）。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

/** 没有逐词数据时，按整行时长把中文/日文逐字均匀铺开，做出逐字效果。 */
function splitEvenly(text: string, start: number, end: number): LyricWord[] {
  if (!CJK.test(text)) return [];
  const chars = Array.from(text).filter((char) => char.trim().length > 0);
  if (chars.length < 2) return [];
  const step = Math.max(90, (end - start) / chars.length);
  return chars.map((char, index) => ({
    text: char,
    startMs: Math.round(start + index * step),
    endMs: Math.round(start + (index + 1) * step),
  }));
}

function toDocLines(parsed: SourceLine[]): LyricLine[] {
  return parsed.map((line, index) => {
    const next = parsed[index + 1];
    const start = line.timeMs;
    const end = next ? next.timeMs : start + 4200;
    const sourceWords = line.words ?? [];
    let words: LyricWord[] = sourceWords.map((word, wordIndex) => {
      const nextWord = sourceWords[wordIndex + 1];
      return {
        text: word.text,
        startMs: word.startMs,
        endMs: nextWord ? nextWord.startMs : end,
        spaceBefore: word.spaceBefore,
      };
    });
    if (words.length === 0) words = splitEvenly(line.text, start, end);
    return {
      timeMs: start,
      durationMs: Math.max(0, end - start),
      text: line.text,
      translation: line.translation ?? '',
      words,
    };
  });
}

interface PlatformLyric {
  qrc?: string | null;
  yrc?: string | null;
  lrc?: string | null;
  translation?: string | null;
}

/** 歌词覆盖到的最后时间（毫秒）：最后一句起点 + 句长。 */
function lyricCoverageMs(lines: ReadonlyArray<{ timeMs: number; durationMs?: number }>): number {
  let last = 0;
  for (const line of lines) {
    last = Math.max(last, line.timeMs + Math.max(400, line.durationMs ?? 0));
  }
  return last;
}

/**
 * 逐字歌词有时只带片段（平台试听版/裁剪版，只到几十秒）。
 * 如果它覆盖不到整首的大半、而同一份响应里的 LRC 明显更长，就退回 LRC，
 * 否则会出现「歌词播到几十秒以后就没了」。
 */
function wordLyricTooShort(
  wordLines: ReadonlyArray<{ timeMs: number; durationMs?: number }>,
  durationMs: number | undefined,
  lrcLines: ReadonlyArray<LyricLine>,
): boolean {
  const wordCoverage = lyricCoverageMs(wordLines);
  if (wordCoverage <= 0) return true;
  const lrcCoverage = lyricCoverageMs(lrcLines);
  if (lrcCoverage <= wordCoverage * 1.05) return false;
  const total = durationMs && durationMs > 0 ? durationMs : 0;
  const threshold = total > 0 ? total * 0.6 : lrcCoverage * 0.6;
  return wordCoverage < threshold;
}

/** 平台歌词负载（QRC / YRC / LRC）→ 统一歌词文档 + 来源说明。 */
function docFromLyric(
  track: OnlineTrack,
  lyric: PlatformLyric,
  prefix = '',
): { doc: LyricDoc; label: string } {
  const key = trackKeyOf(track);
  const platform = SOURCE_LABEL[track.source] ?? track.source;
  // 同一份响应里的 LRC：逐字版只覆盖片段时用它兜底。
  const lrcLines = toDocLines(applyTranslation(parseLrc(lyric.lrc ?? ''), lyric.translation ?? ''));
  if (lyric.qrc) {
    try {
      const payload = extractQrcPayload(decryptQrc(lyric.qrc));
      const qrcLines = parseQrcLyric(payload);
      if (qrcLines.length > 0 && !wordLyricTooShort(qrcLines, track.durationMs, lrcLines)) {
        return {
          doc: {
            kind: 'qrc',
            trackKey: key,
            lines: qrcLines.map((line) => ({
              timeMs: line.timeMs,
              durationMs: line.durationMs,
              text: line.text ?? joinWords(line.words),
              translation: '',
              words: line.words.map((word) => ({ ...word })),
            })),
          },
          label: `${prefix}${platform} · 逐字（QRC）`,
        };
      }
    } catch (err) {
      console.warn('[lyrics] qrc decode failed', err);
    }
  }
  if (lyric.yrc) {
    const charLines = parseCharLyric(lyric.yrc);
    if (charLines.length > 0 && !wordLyricTooShort(charLines, track.durationMs, lrcLines)) {
      return {
        doc: {
          kind: 'yrc',
          trackKey: key,
          lines: charLines.map((line) => ({
            timeMs: line.timeMs,
            durationMs: line.durationMs,
            text: line.text ?? line.chars.map((char) => char.text).join(''),
            translation: '',
            words: line.chars.map((char) => ({
              text: char.text,
              startMs: char.startMs,
              endMs: char.endMs,
              spaceBefore: char.spaceBefore,
            })),
          })),
        },
        label: `${prefix}${platform} · 逐字（YRC）`,
      };
    }
  }
  return {
    doc: {
      kind: 'lrc',
      trackKey: key,
      lines: lrcLines,
    },
    label: `${prefix}${platform} · LRC${lyric.translation ? ' + 翻译' : ''}`,
  };
}

/** 拉取并解析当前曲目歌词。 */
export async function loadLyricDoc(track: OnlineTrack | null): Promise<LyricDoc> {
  if (!track) return EMPTY;
  const key = trackKeyOf(track);
  lyricSource = '';
  lyricMatchInfo = null;
  lyricMatchSkipped = false;
  lyricMatchDone = false;
  manualLyricLabel = '';

  // 本地曲目：同名 .lrc
  if (track.source === 'local') {
    const rel = lrcOf(track);
    if (!rel) return { ...EMPTY, trackKey: key };
    try {
      const text = await fetchLocalLrc(rel);
      lyricSource = '本地 LRC 文件';
      return {
        kind: 'lrc',
        trackKey: key,
        lines: toDocLines(parseLrc(text)),
      };
    } catch (err) {
      console.warn('[lyrics] local lrc failed', err);
      return { ...EMPTY, trackKey: key };
    }
  }

  // 0) 手动选择的来源优先（记住到本曲目）
  const manual = readManual()[key];
  if (manual) {
    try {
      const picked = await fetchLyric(manual.source, manual.id);
      const built = docFromLyric(track, picked, `${manual.label} · 手动选择 · `);
      if (built.doc.lines.length > 0) {
        manualLyricLabel = manual.label;
        lyricSource = built.label;
        return built.doc;
      }
    } catch (err) {
      console.warn('[lyrics] manual lyric failed', err);
    }
  }

  let lyric;
  try {
    lyric = await fetchLyric(track.source, track.id);
  } catch (err) {
    console.warn('[lyrics] fetch failed', err);
    return { ...EMPTY, trackKey: key };
  }
  const built = docFromLyric(track, lyric);
  lyricSource = built.label;
  // 诊断：歌词只覆盖到歌曲前段时打一条日志（正常应该覆盖到最后一句）。
  if (track.durationMs && track.durationMs > 0) {
    const coverage = lyricCoverageMs(built.doc.lines);
    if (coverage < track.durationMs * 0.6) {
      console.info(
        '[lyrics] short coverage',
        `${Math.round(coverage / 1000)}s / ${Math.round(track.durationMs / 1000)}s`,
        built.label,
        track.title,
      );
    }
  }
  return built.doc;
}

/** 当前曲目是否手动选了歌词来源。 */
export function manualLyricLabelOf(): string {
  return manualLyricLabel;
}

/** 手动指定这首歌用哪个平台的哪份歌词（会记住）。 */
export async function applyManualLyric(
  track: OnlineTrack,
  source: string,
  id: string,
  label: string,
): Promise<boolean> {
  try {
    const lyric = await fetchLyric(source, id);
    const built = docFromLyric(track, lyric, `${label} · 手动选择 · `);
    if (built.doc.lines.length === 0) return false;
    const key = trackKeyOf(track);
    const map = readManual();
    map[key] = { source, id, label };
    writeManual(map);
    manualLyricLabel = label;
    lyricSource = built.label;
    lyricMatchInfo = null;
    lyricMatchSkipped = true;
    lyricMatchDone = true;
    lastDoc = built.doc;
    updateCurrentLyricLine();
    notifyMatch();
    return true;
  } catch (err) {
    console.warn('[lyrics] apply manual failed', err);
    return false;
  }
}

/** 恢复自动匹配（清掉本曲目的手动选择）。 */
export function clearManualLyric(track: OnlineTrack): void {
  const key = trackKeyOf(track);
  const map = readManual();
  if (map[key]) {
    delete map[key];
    writeManual(map);
  }
  manualLyricLabel = '';
  // 恢复自动匹配后必须重新拉一次歌词，否则来源注释还停留在手动选择上
  lyricMatchInfo = null;
  lyricMatchSkipped = false;
  lyricMatchDone = false;
  primeKey = '';
  void loadLyricDoc(track)
    .then((doc) => {
      if (doc.trackKey !== key) return;
      lastDoc = doc;
      updateCurrentLyricLine();
      notifyMatch();
      startLyricMatch(track, doc);
    })
    .catch(() => undefined);
}

/** 找出当前应高亮的行（最近一条 timeMs ≤ position + 60ms）。 */
function activeIndexOf(lines: LyricLine[], positionMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = lines[mid];
    if (!line) break;
    if (line.timeMs <= positionMs + 60) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * 每档动效的曲线参数：
 * rise = 冲到峰值用时，total = 整段动画用时，overshoot = 越过最大字号的幅度（0.32 = 多放大 32%）。
 * 曲线形状固定为「ease-out 冲上去 → 单调回落」，只回弹一次，不来回震荡。
 */
const GROW_PROFILES: Record<LyricGrowMode, { rise: number; total: number; overshoot: number }> = {
  off: { rise: 0, total: 0, overshoot: 0 },
  soft: { rise: 130, total: 360, overshoot: 0.58 },
  bounce: { rise: 150, total: 510, overshoot: 1.10 },
  wild: { rise: 160, total: 780, overshoot: 1.85 },
};

/**
 * 当前行的放大曲线（0 → 1）。
 * 起句先快速冲到 1+overshoot，再平滑回落、稳住。
 * 用真实时间（performance.now）而不是播放进度驱动，避免进度按 40ms 跳变导致动画一顿一顿。
 */
function growAt(elapsedMs: number): number {
  const profile = GROW_PROFILES[lyricGrow];
  const { rise: RISE_MS, total: TOTAL_MS, overshoot: OVERSHOOT } = profile;
  // off：不弹，直接停在最大字号
  if (TOTAL_MS <= 0 || OVERSHOOT <= 0) return 1;
  if (elapsedMs <= 0) return 0;
  if (elapsedMs >= TOTAL_MS) return 1;
  if (elapsedMs < RISE_MS) {
    // 上升段：ease-out，越接近峰值越慢，冲上去正好停住
    const u = elapsedMs / RISE_MS;
    return (1 + OVERSHOOT) * (1 - Math.pow(1 - u, 3));
  }
  // 回落段：从峰值平滑落回 1（单调收敛，不来回震荡）
  const u = (elapsedMs - RISE_MS) / (TOTAL_MS - RISE_MS);
  return 1 + OVERSHOOT * Math.pow(1 - u, 3);
}

/** 逐字高亮：返回每字状态（0 未唱 / 1 已唱 / 2 正在唱）。 */
function charStates(line: LyricLine, positionMs: number): Array<0 | 1 | 2> {  const states: Array<0 | 1 | 2> = [];
  let hotUsed = false;
  for (const word of line.words) {
    if (positionMs >= word.endMs) states.push(1);
    else if (positionMs >= word.startMs) {
      // 只让当前这一个字带高亮
      if (hotUsed) states.push(1);
      else {
        states.push(2);
        hotUsed = true;
      }
    } else states.push(0);
  }
  return states;
}


// 供快捷设置面板显示当前正在唱的一句（打开过歌词页后即有效）
let currentLyricText = '';

export function currentLyricLine(): string {
  if (currentLyricText) return currentLyricText;
  const doc = lastDoc;
  if (!doc || doc.lines.length === 0) return '';
  const state = playerState();
  const position = state.positionMs + lyricOffsetOf(doc.trackKey);
  const index = activeIndexOf(doc.lines, position);
  return doc.lines[index]?.text ?? '';
}

/** 偏移/切歌后刷新缓存的当前句（供快捷面板直接读取）。 */
export function updateCurrentLyricLine(): void {
  const doc = lastDoc;
  const state = playerState();
  if (!doc || doc.lines.length === 0) {
    currentLyricText = '';
    return;
  }
  const position = state.positionMs + lyricOffsetOf(doc.trackKey);
  const index = activeIndexOf(doc.lines, position);
  currentLyricText = doc.lines[index]?.text ?? '';
}

export class LyricsView {
  readonly root: HTMLDivElement;

  private linesEl: HTMLDivElement;
  private progressFill: HTMLDivElement;
  private progressCur: HTMLSpanElement;
  private progressDur: HTMLSpanElement;
  private bgEl: HTMLDivElement;
  private bgMode: LyricsBgMode = lyricsBgMode;
  private bgToken = 0;
  private palette: string[] | null = null;
  private tintedIndex = -1;
  private flowLast = 0;
  private coverWrapEl: HTMLDivElement;
  private metaEl: HTMLDivElement;
  private coverEl: HTMLImageElement;
  private titleEl: HTMLDivElement;
  private artistEl: HTMLDivElement;
  private sourceEl: HTMLDivElement;
  private matchUnsub: (() => void) | null = null;
  private emptyEl: HTMLDivElement;

  private doc: LyricDoc = EMPTY;
  private state: PlayerState | null = null;
  private lineEls: HTMLDivElement[] = [];
  private charEls: HTMLSpanElement[][] = [];
  private activeIndex = -1;
  /** 当前行放大动画的起点时间（performance.now），换行时重置。 */
  private growStartAt = 0;
  private rafId = 0;
  private disposed = false;
  private loadToken = 0;
  private lastTrackKey = '';
  private unsubscribe: (() => void) | null = null;
  private rightEl: HTMLDivElement;
  /** 自动居中后的位移（负值向上），滚轮浏览时作为基准。 */
  private autoOffset = 0;
  /** 用户手动浏览产生的额外位移。 */
  private manualShift = 0;
  private manualUntil = 0;
  /** 上一帧是否处于手动浏览状态：用来在滚动开始/结束时重排距离渐隐。 */
  private fadeBrowsing = false;
  private manualTimer = 0;
  /** 手动滚动的目标位移（缓动追踪它，做出丝滑惯性）。 */
  private manualTarget = 0;
  private manualRaf = 0;
  private manualLastTs = 0;
  /** 播放效果（纯字）舞台：folia 绘光的文字层；关闭时整块不渲染，省性能。 */
  private lumiereText: LumiereStage | null = null;
  /** 播放效果（房间）舞台：纯色布景墙 + 长条地毯的 3D 空间，歌词浮在地毯上方。 */
  private roomStage: RoomStage | null = null;
  /** 进页时等画布第一次出像的监听（见 watchStagePaint）。 */
  private stageObserver: MutationObserver | null = null;
  /** 默认歌词页的播放样式（经典/发光/渐变/频谱，见 lyricStyle.ts）：底部频谱条与样式 class。 */
  private spectrumEl: HTMLDivElement;
  private spectrumCanvas: HTMLCanvasElement;
  private spectrumRaf = 0;
  private spectrumData: Uint8Array<ArrayBuffer> | null = null;
  private styleUnsub: (() => void) | null = null;

  constructor(private readonly onClose: () => void) {
    this.bgEl = h('div', { class: 'lyrics-bg' });
    this.coverEl = h('img', { class: 'lyrics-cover', alt: '' });
    this.titleEl = h('div', { class: 'lyrics-title', text: '未在播放' });
    this.artistEl = h('div', { class: 'lyrics-artist', text: '' });
    this.sourceEl = h('div', { class: 'lyrics-source', text: '' });
    this.linesEl = h('div', { class: 'lyrics-lines' });
    this.progressFill = h('div', { class: 'lyrics-progress-fill' });
    this.progressCur = h('span', { class: 'lyrics-progress-cur', text: '00:00' });
    this.progressDur = h('span', { class: 'lyrics-progress-dur', text: '00:00' });
    this.emptyEl = h('div', { class: 'lyrics-empty', text: '这首歌还没有歌词' });
    this.rightEl = h('div', { class: 'lyrics-right' }, this.linesEl, this.emptyEl);

    this.coverWrapEl = h('div', { class: 'lyrics-cover-wrap' }, this.coverEl);
    this.metaEl = h('div', { class: 'lyrics-meta' }, this.titleEl, this.artistEl, this.sourceEl);

    // 频谱律动：默认歌词页底部的频谱条（样式切到「频谱」时才显示，见 lyricStyle.ts）。
    this.spectrumCanvas = document.createElement('canvas');
    this.spectrumEl = h('div', { class: 'lyrics-spectrum' }, this.spectrumCanvas) as HTMLDivElement;

    const closeBtn = h('button', { class: 'lyrics-close', title: '收起歌词' }, icon('chevron', 22));
    closeBtn.addEventListener('click', () => this.onClose());

    const scrim = h('div', { class: 'lyrics-scrim' });
    this.lumiereText = createLumiereStage({ textOnly: true });
    this.roomStage = createRoomStage();

    this.root = h(
      'div',
      { class: 'lyrics-view' },
      this.bgEl,
      scrim,
      this.spectrumEl,
      this.lumiereText.root,
      this.roomStage.root,
      closeBtn,
      h(
        'div',
        { class: 'lyrics-frame' },
        h(
          'div',
          { class: 'lyrics-left' },
          this.coverWrapEl,
          this.metaEl,
          h(
            'div',
            { class: 'lyrics-progress' },
            h('div', { class: 'lyrics-progress-track' }, this.progressFill),
            h('div', { class: 'lyrics-progress-time' }, this.progressCur, this.progressDur),
          ),
        ),
        this.rightEl,
      ),
    );

    this.applyLumiereMode();
    this.applyLyricStyle();
    this.styleUnsub = onLyricStyle(() => this.applyLyricStyle());

    this.matchUnsub = onLyricMatch(() => {
      if (this.disposed) return;
      if (lastDoc && lastDoc.trackKey === this.lastTrackKey) {
        this.doc = lastDoc;
        this.render();
      }
    });

    this.unsubscribe = onPlayer((state) => {
      if (this.disposed) return;
      this.state = state;
      this.syncTrack();
      this.syncLumiereSong();
      this.syncProgress();
      this.schedule();
    });

    // 滚轮手动浏览歌词：临时脱离自动居中，停手几秒后回到当前行
    this.rightEl.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });

    activeLyricsView = this;
  }

  private syncTrack(): void {
    const track = this.state?.track ?? null;
    const key = trackKeyOf(track);
    const coverUrl = track ? onlineArtwork(track) : '';
    const changed = key !== this.lastTrackKey && this.lastTrackKey !== '';
    if (changed) {
      this.spawnGhosts();
      this.bgEl.classList.remove('is-switching');
      void this.bgEl.offsetWidth;
      this.bgEl.classList.add('is-switching');
      window.setTimeout(() => this.bgEl.classList.remove('is-switching'), 620);
    }
    this.bgEl.style.backgroundImage = coverUrl ? `url("${coverUrl}")` : 'none';
    void this.applyTextTint();
    this.coverEl.src = coverUrl;
    this.titleEl.textContent = track?.title ?? '未在播放';
    this.artistEl.textContent = track?.artist ?? '';
    if (changed) {
      this.coverEl.classList.remove('is-switching');
      this.metaEl.classList.remove('is-switching');
      void this.coverEl.offsetWidth;
      this.coverEl.classList.add('is-switching');
      this.metaEl.classList.add('is-switching');
      window.setTimeout(() => {
        this.coverEl.classList.remove('is-switching');
        this.metaEl.classList.remove('is-switching');
      }, 620);
    }
    if (changed || key !== this.lastTrackKey) {
      this.lastTrackKey = key;
      void this.reload(track);
    }
  }

  syncBackgroundMode(): void {
    if (this.disposed) return;
    this.bgMode = lyricsBgMode;
    void this.applyTextTint();
  }

  /** 应用播放效果（纯字 / 房间）：切换舞台模式、开关渲染循环、同步歌词文档。 */
  applyLumiereMode(): void {
    if (this.disposed) return;
    const mode = lumiereMode();
    const textOn = mode === 'text';
    const roomOn = mode === 'room';
    const anyOn = textOn || roomOn;
    // 纯字 / 房间都由 canvas 画歌词，DOM 歌词与封面栏让位；什么时候藏由 CSS 的 is-painted 门槛决定，
    // 画布还没出像时默认歌词页仍然可见，不会闪灰。
    this.root.classList.toggle('is-lumiere', anyOn);
    this.root.classList.toggle('is-lumiere-text', anyOn);
    this.root.classList.toggle('is-lumiere-pure', textOn);
    this.root.classList.toggle('is-room', roomOn);
    const stage = this.lumiereText;
    if (stage) {
      stage.setMode(textOn ? 'text' : 'off');
      if (textOn) stage.activate();
      else stage.deactivate();
    }
    const room = this.roomStage;
    if (room) {
      room.setMode(roomOn ? 'room' : 'off');
      if (roomOn) room.activate();
      else room.deactivate();
    }
    // 刚进歌词页时先别露默认封面：等画布第一次出像再撤 is-lumiere-fresh（进页那一瞬是暗场 + 加载提示）。
    const stageRoot = roomOn ? room?.root : stage?.root;
    const painted = stageRoot ? stageRoot.classList.contains('is-painted') : false;
    const failed = stageRoot ? stageRoot.classList.contains('is-failed') : false;
    if (anyOn && stageRoot && !painted && !failed) {
      this.root.classList.add('is-lumiere-fresh');
      this.watchStagePaint(stageRoot);
    } else {
      this.root.classList.remove('is-lumiere-fresh');
    }
    if (anyOn) this.syncLumiereSong();
  }

  /** 应用默认歌词页的播放样式（经典/发光/渐变/频谱）；切换后立即生效、不重载歌词。 */
  private applyLyricStyle(): void {
    if (this.disposed) return;
    const style = lyricStyle();
    this.root.classList.remove('lyric-style-classic', 'lyric-style-glow', 'lyric-style-gradient', 'lyric-style-spectrum');
    this.root.classList.add(`lyric-style-${style}`);
    if (style === 'spectrum') this.startSpectrum();
    else this.stopSpectrum();
    if (this.activeIndex >= 0) this.paintGradientTones();
  }

  private startSpectrum(): void {
    if (this.spectrumRaf || this.disposed) return;
    const ctx = this.spectrumCanvas.getContext('2d');
    if (!ctx) return;
    const render = (now: number): void => {
      this.spectrumRaf = 0;
      if (this.disposed || lyricStyle() !== 'spectrum') return;
      this.drawSpectrum(ctx, now);
      this.spectrumRaf = window.requestAnimationFrame(render);
    };
    this.spectrumRaf = window.requestAnimationFrame(render);
  }

  private stopSpectrum(): void {
    if (this.spectrumRaf) window.cancelAnimationFrame(this.spectrumRaf);
    this.spectrumRaf = 0;
  }

  /** 频谱条颜色：从主题强调色取 rgb，空值回退到暖金。 */
  private spectrumAccent(): string {
    const raw = getComputedStyle(this.root).getPropertyValue('--accent').trim();
    const hex = /^#([0-9a-f]{6})$/i.exec(raw);
    if (hex) {
      const value = parseInt(hex[1], 16);
      return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
    }
    const rgb = /^rgb\((\d+)[ ,]+(\d+)[ ,]+(\d+)\)$/i.exec(raw);
    if (rgb) return `${rgb[1]}, ${rgb[2]}, ${rgb[3]}`;
    return '217, 192, 141';
  }

  /** 画一帧频谱：64 根镜像条，低频在中心、向两侧扩散，底部渐隐。 */
  private drawSpectrum(ctx: CanvasRenderingContext2D, _now: number): void {
    const width = this.spectrumEl.clientWidth || this.root.clientWidth || 800;
    const height = this.spectrumEl.clientHeight || 240;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (this.spectrumCanvas.width !== pixelWidth || this.spectrumCanvas.height !== pixelHeight) {
      this.spectrumCanvas.width = pixelWidth;
      this.spectrumCanvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const analyser = playbackAnalyser();
    if (!analyser) return;
    const bins = analyser.frequencyBinCount;
    if (!this.spectrumData || this.spectrumData.length !== bins) this.spectrumData = new Uint8Array(bins);
    analyser.getByteFrequencyData(this.spectrumData);
    const data = this.spectrumData;
    const accent = this.spectrumAccent();
    const bars = 64;
    const step = width / bars;
    const barWidth = Math.max(2, step * 0.56);
    const maxBin = Math.max(8, Math.floor(bins * 0.62));
    const gradient = ctx.createLinearGradient(0, height, 0, height * 0.2);
    gradient.addColorStop(0, `rgba(${accent}, 0.55)`);
    gradient.addColorStop(0.55, `rgba(${accent}, 0.24)`);
    gradient.addColorStop(1, `rgba(${accent}, 0)`);
    ctx.fillStyle = gradient;
    ctx.shadowColor = `rgba(${accent}, 0.35)`;
    ctx.shadowBlur = 16;
    for (let i = 0; i < bars; i += 1) {
      const t = i / (bars - 1);
      const bin = Math.min(maxBin - 1, Math.floor(Math.pow(t, 1.35) * maxBin));
      const level = data[bin] / 255;
      const barHeight = Math.max(2, level * height * 0.9);
      const x = i * step + (step - barWidth) / 2;
      ctx.beginPath();
      ctx.roundRect(x, height - barHeight, barWidth, barHeight, barWidth / 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  /** 等舞台第一次出像（或确认失败）就撤掉 is-lumiere-fresh；6 秒兜底别一直暗着。 */
  private watchStagePaint(stageRoot: HTMLElement): void {
    this.stageObserver?.disconnect();
    const observer = new MutationObserver(() => {
      if (!stageRoot.classList.contains('is-painted') && !stageRoot.classList.contains('is-failed')) return;
      // 出像之后 DOM 歌词还没真正退场（:has 规则要等 is-content，is-covered 还要等淡出），
      // 这时候就撤 is-lumiere-fresh 会露出 0.5s 的默认歌词页 —— 所以等到 is-covered 或超时再撤。
      if (stageRoot.classList.contains('is-failed') || this.root.classList.contains('is-covered')) {
        observer.disconnect();
        if (this.stageObserver === observer) this.stageObserver = null;
        this.root.classList.remove('is-lumiere-fresh');
      }
    });
    observer.observe(stageRoot, { attributes: true, attributeFilter: ['class'] });
    observer.observe(this.root, { attributes: true, attributeFilter: ['class'] });
    this.stageObserver = observer;
    window.setTimeout(() => {
      if (this.stageObserver !== observer) return;
      observer.disconnect();
      this.stageObserver = null;
      this.root.classList.remove('is-lumiere-fresh');
    }, 6000);
  }

  /** 应用「文字设置」：歌词页舞台与面板里的实时预览都走这里。 */
  applyLumiereTextSettings(settings?: LyricTextSettings): void {
    if (this.disposed) return;
    this.lumiereText?.applyTextSettings(settings);
  }

  /** 组装交给播放效果舞台的整首歌（歌词页与「文字设置」预览面板共用）。 */
  buildLumiereSong(): LumiereSongInput {
    const track = this.state?.track ?? null;
    const trackKey = this.doc.trackKey || trackKeyOf(track);
    return {
      trackKey,
      title: track?.title ?? '',
      artist: track?.artist ?? '',
      album: track?.album ?? '',
      durationMs: this.state?.durationMs || track?.durationMs || 0,
      lyricOffsetMs: lyricOffsetOf(trackKey),
      lines: this.doc.lines.map((line) => ({
        timeMs: line.timeMs,
        durationMs: line.durationMs,
        text: line.text,
        translation: line.translation,
        words: line.words,
      })),
    };
  }

  /** 「歌词颜色」跟着封面走时，纯字档的灯光与字色也一起换成封面色。 */
  private applyLumiereTheme(): void {
    lumiereThemeNow = lumiereThemeForCover(this.bgMode, this.palette);
    lumierePaletteNow = this.palette ? [...this.palette] : null;
    this.lumiereText?.setTheme(lumiereThemeNow, lumierePaletteNow);
  }

  /** 把当前歌词文档交给播放效果舞台（整首歌词）。 */
  private syncLumiereSong(): void {
    const input = this.buildLumiereSong();
    this.lumiereText?.setSong(input);
    this.roomStage?.setSong(input);
  }


  /** 按模式给歌词文字上色：纯色=主题色，封面色=封面主色，自动渐变=色板逐字渐变。 */
  private async applyTextTint(): Promise<void> {
    const token = ++this.bgToken;
    const mode = this.bgMode;
    if (mode === 'solid') {
      this.palette = null;
      this.applyLumiereTheme();
      this.paintActiveLineTint();
      return;
    }
    const track = this.state?.track ?? null;
    const colors = (await coverColorsOf(track)) ?? fallbackColors(`${track?.title ?? ''}|${track?.artist ?? ''}`);
    if (this.disposed || token !== this.bgToken || mode !== this.bgMode) return;
    this.palette = colors.palette;
    this.applyLumiereTheme();
    this.paintActiveLineTint();
  }

  /** 混合两个 #rrggbb 颜色。 */
  private mixColor(from: string, to: string, ratio: number): string {
    const parse = (value: string): [number, number, number] => {
      const text = value.trim();
      if (text.startsWith('#') && text.length === 7) {
        return [
          parseInt(text.slice(1, 3), 16),
          parseInt(text.slice(3, 5), 16),
          parseInt(text.slice(5, 7), 16),
        ];
      }
      const match = text.match(/hsl\(([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)/);
      if (match) {
        const hue = Number(match[1]) / 360;
        const sat = Number(match[2]) / 100;
        const light = Number(match[3]) / 100;
        const c = (1 - Math.abs(2 * light - 1)) * sat;
        const x = c * (1 - Math.abs(((hue * 6) % 2) - 1));
        const m = light - c / 2;
        let rgb: [number, number, number];
        if (hue < 1 / 6) rgb = [c, x, 0];
        else if (hue < 2 / 6) rgb = [x, c, 0];
        else if (hue < 3 / 6) rgb = [0, c, x];
        else if (hue < 4 / 6) rgb = [0, x, c];
        else if (hue < 5 / 6) rgb = [x, 0, c];
        else rgb = [c, 0, x];
        return [Math.round((rgb[0] + m) * 255), Math.round((rgb[1] + m) * 255), Math.round((rgb[2] + m) * 255)];
      }
      return [200, 200, 200];
    };
    const a = parse(from);
    const b = parse(to);
    const mix = (x: number, y: number) => Math.round(x + (y - x) * ratio);
    const value = (channel: number) => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, '0');
    return `#${value(mix(a[0], b[0]))}${value(mix(a[1], b[1]))}${value(mix(a[2], b[2]))}`;
  }

  /** 封面色板取出的颜色多半偏浅，压暗到能在浅色背景上看清：过亮的颜色往墨色里混。 */
  private readableTint(color: string): string {
    const text = color.trim();
    if (!text.startsWith('#') || text.length !== 7) return color;
    const r = parseInt(text.slice(1, 3), 16);
    const g = parseInt(text.slice(3, 5), 16);
    const b = parseInt(text.slice(5, 7), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const target = 0.24; // 压到接近墨色，浅色背景上也能一眼看清
    if (lum <= target) return color;
    const ink = 0.11; // #1b1d23 的亮度
    const ratio = Math.min(0.88, (lum - target) / Math.max(0.05, lum - ink));
    return this.mixColor(color, '#1b1d23', ratio);
  }

  /** 在色板里按 0~1 取色（多色自动渐变用）。 */
  private samplePalette(ratio: number): string {
    const palette = this.palette ?? [];
    if (palette.length === 0) return '#c9c9c9';
    if (palette.length === 1) return palette[0];
    const clamped = Math.max(0, Math.min(1, ratio));
    const scaled = clamped * (palette.length - 1);
    const index = Math.min(palette.length - 2, Math.floor(scaled));
    return this.mixColor(palette[index], palette[index + 1], scaled - index);
  }

  /**
   * 「渐变」歌词样式：给当前行每个字写一个 --lyric-grad 色，按色板从行首到行尾过渡；
   * 没有封面色板时用主题强调色与暖白混出渐变。其它样式下清掉这些变量。
   */
  private paintGradientTones(): void {
    const activeEl = this.lineEls[this.activeIndex];
    const spans = this.charEls[this.activeIndex] ?? [];
    if (!activeEl) return;
    if (lyricStyle() !== 'gradient') {
      activeEl.style.removeProperty('--lyric-grad');
      for (const span of spans) span.style.removeProperty('--lyric-grad');

      return;
    }
    const accent = getComputedStyle(this.root).getPropertyValue('--accent').trim() || '#d9c08d';
    const palette = this.palette ?? null;
    const count = Math.max(1, spans.length - 1);
    const shift = (performance.now() / 6200) % 1;
    spans.forEach((span, index) => {
      const t = (index / count + shift) % 1;
      const tone = palette && palette.length > 0
        ? this.readableTint(this.samplePalette(t))
        : this.mixColor(this.readableTint(accent), '#f4e3bd', t);
      span.style.setProperty('--lyric-grad', tone);
    });
    // 没逐字数据的行（整行 textContent）用中段色兜底
    activeEl.style.setProperty('--lyric-grad', this.mixColor(this.readableTint(accent), '#f4e3bd', 0.4));
  }

  /** 只给当前行重新上色：已唱字走色板渐变、当前字提亮，未唱字保持主题灰。 */
  private paintActiveLineTint(): void {
    const previous = this.tintedIndex;
    this.tintedIndex = this.activeIndex;
    if (previous >= 0 && previous !== this.activeIndex) {
      const previousEl = this.lineEls[previous];
      previousEl?.style.removeProperty('--lyric-bar-a');
      previousEl?.style.removeProperty('--lyric-bar-b');
      previousEl?.style.removeProperty('--lyric-bar-c');
      previousEl?.style.removeProperty('--lyric-hot');
      previousEl?.style.removeProperty('--lyric-glow');
      previousEl?.style.removeProperty('--lyric-line');
      this.charEls[previous]?.forEach((span) => {
        span.style.removeProperty('--lyric-sung');
        span.style.removeProperty('--lyric-hot');
        span.style.removeProperty('--lyric-glow');

      });
    }
    const palette = this.palette;
    const activeEl = this.lineEls[this.activeIndex];
    if (!activeEl) return;
    if (!palette) {
      activeEl.style.removeProperty('--lyric-bar-a');
      activeEl.style.removeProperty('--lyric-bar-b');
      activeEl.style.removeProperty('--lyric-bar-c');
      activeEl.style.removeProperty('--lyric-hot');
      activeEl.style.removeProperty('--lyric-glow');
      activeEl.style.removeProperty('--lyric-line');
      this.charEls[this.activeIndex]?.forEach((span) => {
        span.style.removeProperty('--lyric-sung');
        span.style.removeProperty('--lyric-hot');
        span.style.removeProperty('--lyric-glow');

      });
      return;
    }
    const [first, second] = palette;
    const gradientMode = this.bgMode === 'gradient';
    // 左侧竖条跟随歌词颜色：封面色用主色，自动渐变用色板中段
    const barColor = gradientMode ? this.samplePalette(0.5) : first;
    activeEl.style.setProperty('--lyric-bar-a', first);
    activeEl.style.setProperty('--lyric-bar-b', barColor);
    activeEl.style.setProperty('--lyric-bar-c', first);
    const hotBase = gradientMode ? this.samplePalette(0.66) : first;
    // 文字用色要先压暗，否则浅色封面上「亮色」歌词会糊成灰白
    const hotColor = this.readableTint(this.mixColor(hotBase, '#ffffff', 0.34));
    const spans = this.charEls[this.activeIndex] ?? [];
    const count = Math.max(1, spans.length - 1);
    const glow = `0 0 18px ${this.mixColor(hotColor, second, 0.45)}, 0 0 10px ${this.mixColor(hotColor, '#1b1b1b', 0.35)}`;
    activeEl.style.setProperty('--lyric-hot', hotColor);
    activeEl.style.setProperty('--lyric-glow', glow);
    activeEl.style.setProperty('--lyric-line', hotColor);
    spans.forEach((span, index) => {
      if (span.classList.contains('is-hot')) {
        span.style.setProperty('--lyric-hot', hotColor);
        span.style.setProperty('--lyric-glow', glow);
        span.style.removeProperty('--lyric-sung');

        return;
      }
      span.style.removeProperty('--lyric-hot');
      span.style.removeProperty('--lyric-glow');
      if (span.classList.contains('is-sung')) {
        // 自动渐变：沿封面色板多色过渡；封面色：统一用主色
        span.style.setProperty('--lyric-sung', this.readableTint(gradientMode ? this.samplePalette(index / count) : first));
        return;
      }
      span.style.removeProperty('--lyric-sung');
    });

  }

  /** 自动渐变：让颜色沿整句缓慢流动，而不是每个字固定一个色。 */
  private paintGradientFlow(now: number): void {
    if (now - this.flowLast < 40) return;
    this.flowLast = now;
    const palette = this.palette;
    const activeEl = this.lineEls[this.activeIndex];
    if (!palette || !activeEl) return;
    const shift = (now / 6200) % 1;
    const spans = this.charEls[this.activeIndex] ?? [];
    const count = Math.max(1, spans.length - 1);
    spans.forEach((span, index) => {
      const t = (index / count + shift) % 1;
      const tone = this.readableTint(this.samplePalette(t));
      if (span.classList.contains('is-hot')) {
        const hot = this.readableTint(this.mixColor(tone, '#ffffff', 0.34));
        span.style.setProperty('--lyric-hot', hot);
        span.style.setProperty('--lyric-glow', `0 0 18px ${this.mixColor(hot, palette[1] ?? hot, 0.45)}`);
        return;
      }
      if (span.classList.contains('is-sung')) span.style.setProperty('--lyric-sung', tone);
    });
    const barA = this.samplePalette(shift);
    const barB = this.samplePalette((shift + 0.34) % 1);
    const barC = this.samplePalette((shift + 0.67) % 1);
    activeEl.style.setProperty('--lyric-bar-a', barA);
    activeEl.style.setProperty('--lyric-bar-b', barB);
    activeEl.style.setProperty('--lyric-bar-c', barC);
    activeEl.style.setProperty('--lyric-line', this.readableTint(barB));
    const hotSpan = spans.find((span) => span.classList.contains('is-hot'));
    if (hotSpan) {
      const hot = this.readableTint(this.mixColor(barB, '#ffffff', 0.34));
      activeEl.style.setProperty('--lyric-hot', hot);
      activeEl.style.setProperty('--lyric-glow', `0 0 18px ${this.mixColor(hot, barC, 0.45)}`);
    }
    if (lyricStyle() === 'gradient') this.paintGradientTones();
  }


  /** 旧封面 / 旧歌名做一层 ghost，让切歌看起来是「旧的滑出、新的推入」。 */
  private spawnGhosts(): void {
    const oldCover = this.coverEl.src;
    if (oldCover) {
      const ghost = h('div', { class: 'lyrics-cover-ghost' });
      ghost.style.backgroundImage = `url("${oldCover}")`;
      this.coverWrapEl.append(ghost);
      window.setTimeout(() => ghost.remove(), 560);
    }

    const ghostMeta = h(
      'div',
      { class: 'lyrics-meta-ghost' },
      h('div', { class: 'lyrics-title', text: this.titleEl.textContent ?? '' }),
      h('div', { class: 'lyrics-artist', text: this.artistEl.textContent ?? '' }),
    );
    this.metaEl.append(ghostMeta);
    window.setTimeout(() => ghostMeta.remove(), 560);
  }

  private async reload(track: OnlineTrack | null): Promise<void> {
    const token = ++this.loadToken;
    const doc = await loadLyricDoc(track);
    if (this.disposed || token !== this.loadToken) return;
    this.doc = doc;
    lastDoc = doc;
    this.render();
    if (track) startLyricMatch(track, doc);
  }

  private render(): void {
    this.linesEl.textContent = '';
    this.lineEls = [];
    this.charEls = [];
    this.activeIndex = -1;
    this.linesEl.style.transform = 'translateY(0px)';
    this.linesEl.style.transition = 'none';
    this.autoOffset = 0;
    this.manualShift = 0;
    this.manualTarget = 0;
    this.manualUntil = 0;
    window.clearTimeout(this.manualTimer);
    if (this.manualRaf) {
      window.cancelAnimationFrame(this.manualRaf);
      this.manualRaf = 0;
    }
    this.setSourceText(lyricSourceText());
    this.syncLumiereSong();
    this.emptyEl.style.display = this.doc.lines.length === 0 ? '' : 'none';
    this.progressFill.style.width = '0%';
    if (this.doc.lines.length === 0) return;

    for (const line of this.doc.lines) {
      const lineEl = h('div', { class: 'lyric-line' });
      const chars: HTMLSpanElement[] = [];
      if (line.words.length > 0) {
        for (let index = 0; index < line.words.length; index += 1) {
          const word = line.words[index]!;
          const gap = index > 0 && word.spaceBefore === true;
          const span = h('span', { class: gap ? 'lyric-char has-gap' : 'lyric-char', text: word.text });
          chars.push(span);
          lineEl.append(span);
        }
      } else {
        lineEl.textContent = line.text || ' ';
      }
      if (line.translation) {
        lineEl.append(h('span', { class: 'lyric-trans', text: line.translation }));
      }
      this.lineEls.push(lineEl);
      this.charEls.push(chars);
      this.linesEl.append(lineEl);
    }
    this.syncProgress(true);
    window.requestAnimationFrame(() => {
      if (!this.disposed) this.linesEl.style.transition = '';
    });
  }

  /** 歌词来源行：文字变化时做一次淡入上浮，避免硬切。 */
  private setSourceText(text: string): void {
    if (this.sourceEl.textContent === text) return;
    this.sourceEl.textContent = text;
    this.sourceEl.classList.remove('is-updating');
    void this.sourceEl.offsetWidth;
    this.sourceEl.classList.add('is-updating');
  }

  private syncProgress(force = false): void {
    const state = this.state;
    if (!state) return;
    const duration = state.durationMs || 0;
    const percent = duration > 0 ? Math.min(100, Math.max(0, (state.positionMs / duration) * 100)) : 0;
    this.progressFill.style.width = `${percent}%`;
    this.progressCur.textContent = fmtTime(state.positionMs);
    this.progressDur.textContent = fmtTime(duration);
    if (this.doc.lines.length === 0) return;
    const lyricPos = state.positionMs + lyricOffsetOf(this.lastTrackKey);
    const nextIndex = activeIndexOf(this.doc.lines, lyricPos);
    if (nextIndex !== this.activeIndex || force) {
      const prev = this.activeIndex;
      const changed = nextIndex !== this.activeIndex;
      this.activeIndex = nextIndex;
      if (changed) this.growStartAt = performance.now();
      if (changed) this.lumiereText?.pulse();
      if (prev >= 0) {
        this.lineEls[prev]?.classList.remove('is-active', 'is-near');
        // 上一行唱完后必须清掉逐字状态，否则最后一个字的 is-hot 会一直亮着
        this.charEls[prev]?.forEach((span) => span.classList.remove('is-sung', 'is-hot'));
      }
      this.lineEls.forEach((el, index) => {
        el.classList.toggle('is-active', index === nextIndex);
        el.classList.toggle('is-near', index === nextIndex - 1 || index === nextIndex + 1);
      });
      this.applyFade();
      const activeEl = this.lineEls[nextIndex];
      if (activeEl) {
        activeEl.style.setProperty('--p', '0');
        if (changed) activeEl.style.setProperty('--grow', '0');
        // .lyrics-lines 自身就是 offsetParent（position:absolute），offsetTop 直接是行内偏移。
        this.autoOffset = -(activeEl.offsetTop + activeEl.offsetHeight / 2);
        if (!this.browsing()) this.applyOffset(true);
      }
    }
    // 手动滚动/浏览时把距离渐隐解除，不然滚上去的句子全是透明的没法看
    const browsingNow = this.browsing();
    if (browsingNow !== this.fadeBrowsing) {
      this.fadeBrowsing = browsingNow;
      this.applyFade();
    }
    const activeLine = this.doc.lines[this.activeIndex];
    currentLyricText = activeLine ? activeLine.text : '';
    // 当前行的演唱进度（0~1），驱动行下方的金色进度线
    const activeEl = this.lineEls[this.activeIndex];
    if (activeEl && activeLine) {
      const spanMs = Math.max(240, activeLine.durationMs || 2600);
      const ratio = Math.min(1, Math.max(0, (lyricPos - activeLine.timeMs) / spanMs));
      activeEl.style.setProperty('--p', ratio.toFixed(3));
      // 当前行的放大系数：起句快速弹入，冲过最大字号一点再平滑回落；
      // 计时用真实时间，跟播放进度的 40ms 跳变解耦，动起来是顺的。
      const grow = growAt(performance.now() - this.growStartAt);
      activeEl.style.setProperty('--grow', grow.toFixed(4));
      if (this.bgMode === 'gradient') this.paintGradientFlow(performance.now());
      if (lyricStyle() === 'gradient') this.paintGradientTones();
    }
    if (activeLine && activeLine.words.length > 0) {
      const states = charStates(activeLine, lyricPos);
      const spans = this.charEls[this.activeIndex] ?? [];
      states.forEach((value, index) => {
        const span = spans[index];
        if (!span) return;
        span.classList.toggle('is-sung', value >= 1);
        span.classList.toggle('is-hot', value === 2);
      });
    }
    this.paintActiveLineTint();
  }

  /** 切换动效档位后，让当前行立刻按新曲线重播一次（快捷设置里能直接看到效果）。 */
  replayGrow(): void {
    if (this.disposed || this.activeIndex < 0) return;
    this.growStartAt = performance.now();
    this.lineEls[this.activeIndex]?.style.setProperty('--grow', '0');
  }

  /** 画布接管后是否已经把 DOM 歌词整棵停渲染（延迟到淡出结束，避免切换时闪一下）。 */
  private covered = false;
  private coverStart = 0;

  /** 播放效果画布已经接管画面（出像之后）：DOM 歌词整棵是透明的，没必要再逐帧刷它。 */
  private lumiereCoversLyrics(): boolean {
    const mode = lumiereMode();
    if (mode === 'off') return false;
    const stage = mode === 'room' ? this.roomStage : this.lumiereText;
    if (!stage) return false;
    const classes = stage.root.classList;
    return classes.contains('is-on') && classes.contains('is-painted');
  }

  /** 画面被接管时只维护全局“当前歌词文本”，让状态栏/系统媒体信息不至于停住。 */
  private syncCoveredText(): void {
    const state = this.state;
    if (!state || this.doc.lines.length === 0) return;
    const lyricPos = state.positionMs + lyricOffsetOf(this.lastTrackKey);
    const index = activeIndexOf(this.doc.lines, lyricPos);
    currentLyricText = this.doc.lines[index]?.text ?? '';
  }

  private schedule(): void {
    if (this.rafId || this.disposed) return;
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = 0;
      const covered = this.lumiereCoversLyrics();
      if (covered) {
        if (!this.covered) {
          if (!this.coverStart) this.coverStart = performance.now();
          else if (performance.now() - this.coverStart > 200) {
            this.covered = true;
            this.root.classList.add('is-covered');
          }
        }
        this.syncCoveredText();
      } else {
        this.coverStart = 0;
        if (this.covered) {
          this.covered = false;
          this.root.classList.remove('is-covered');
        }
        this.syncProgress();
      }
      this.schedule();
    });
  }

  /** 用户是否正在手动浏览歌词（此时不跟随自动居中）。 */
  private browsing(): boolean {
    return this.manualUntil > performance.now();
  }

  /**
   * 每行的可见度：默认按「离当前句几行」渐隐，越远越淡直到消失；
   * 用户手动滚动浏览时全部恢复为可见，否则滚上去的句子全是透明的没法看。
   */
  private applyFade(): void {
    const browsing = this.browsing();
    const base = this.activeIndex >= 0 ? this.activeIndex : 0;
    this.lineEls.forEach((el, index) => {
      const distance = Math.abs(index - base);
      const fade = browsing || distance === 0 ? 1 : Math.max(0, 1 - (distance - 1) * 0.3);
      el.style.setProperty('--fade', fade.toFixed(3));
    });
  }

  private applyOffset(animate: boolean): void {
    this.linesEl.style.transition = animate ? '' : 'none';
    this.linesEl.style.transform = `translateY(${this.autoOffset + this.manualShift}px)`;
  }

  private onWheel(event: WheelEvent): void {
    if (this.doc.lines.length === 0) return;
    event.preventDefault();
    const step = event.deltaMode === 1 ? event.deltaY * 18 : event.deltaY * 1.05;
    this.manualTarget -= step;
    this.clampManual();
    this.manualUntil = performance.now() + 3200;
    window.clearTimeout(this.manualTimer);
    this.manualTimer = window.setTimeout(() => this.resumeAuto(), 3200);
    this.startManualLoop();
  }

  /** 手动滚动的缓动循环：每帧向目标位移靠拢，跟手又有惯性。 */
  private startManualLoop(): void {
    if (this.manualRaf) return;
    this.manualLastTs = performance.now();
    const step = (now: number): void => {
      this.manualRaf = 0;
      if (this.disposed) return;
      const dt = Math.max(1, now - this.manualLastTs);
      this.manualLastTs = now;
      const diff = this.manualTarget - this.manualShift;
      if (Math.abs(diff) < 0.4) {
        this.manualShift = this.manualTarget;
        this.applyOffset(false);
        return;
      }
      // 时间相关的指数缓动，高刷新率/低帧率观感一致
      const k = 1 - Math.pow(0.0009, dt / 1000);
      this.manualShift += diff * k;
      this.applyOffset(false);
      this.manualRaf = window.requestAnimationFrame(step);
    };
    this.manualRaf = window.requestAnimationFrame(step);
  }

  private clampManual(): void {
    const viewH = this.rightEl.clientHeight || 0;
    const contentH = this.linesEl.scrollHeight || 0;
    const total = this.autoOffset + this.manualTarget;
    const min = -(Math.max(0, contentH - Math.max(0, viewH) / 2));
    const max = Math.max(0, viewH) * 0.35;
    const clamped = Math.min(max, Math.max(min, total));
    this.manualTarget = clamped - this.autoOffset;
  }

  /** 回到自动跟随当前歌词行。 */
  private resumeAuto(): void {
    window.clearTimeout(this.manualTimer);
    this.manualTimer = 0;
    if (this.manualRaf) {
      window.cancelAnimationFrame(this.manualRaf);
      this.manualRaf = 0;
    }
    this.manualShift = 0;
    this.manualTarget = 0;
    this.manualUntil = 0;
    this.applyOffset(true);
  }

  /** 点击歌词行跳转（便于手动对齐）。 */
  bindSeek(): void {
    this.linesEl.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const lineEl = target.closest('.lyric-line');
      if (!(lineEl instanceof HTMLElement)) return;
      const index = this.lineEls.indexOf(lineEl as HTMLDivElement);
      const line = this.doc.lines[index];
      if (line) {
        seek(line.timeMs);
        this.resumeAuto();
      }
    });
  }

  dispose(): void {
    if (activeLyricsView === this) {
      activeLyricsView = null;
    }
    currentLyricText = '';
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.matchUnsub?.();
    this.matchUnsub = null;
    if (this.rafId) window.cancelAnimationFrame(this.rafId);
    window.clearTimeout(this.manualTimer);
    if (this.manualRaf) {
      window.cancelAnimationFrame(this.manualRaf);
      this.manualRaf = 0;
    }
    this.lumiereText?.dispose();
    this.lumiereText = null;
    this.roomStage?.dispose();
    this.roomStage = null;
    this.stageObserver?.disconnect();
    this.stageObserver = null;
    this.stopSpectrum();
    this.styleUnsub?.();
    this.styleUnsub = null;
    this.spectrumData = null;
    this.root.remove();
  }
}
