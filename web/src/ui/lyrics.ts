/**
 * 沉浸式歌词页：全屏、封面模糊背景、逐行 +（有逐字数据时）逐字高亮。
 * 数据来源：QQ QRC（解密）→ 网易云 yrc → 普通 LRC → 本地同名 .lrc。
 */

import { decryptQrc } from 'qrc-decoder';
import { fetchLyric, onlineReady, onOnlineChange } from '../online/client';
import {
  applyTranslation,
  extractQrcPayload,
  isUsefulTranslation,
  pairByTime,
  parseCharLyric,
  parseLrc,
  parseQrcLyric,
  type LyricLine as SourceLine,
} from '../online/lrc';
import { SOURCE_LABEL, type OnlineTrack } from '../online/types';
import { onlineArtwork } from '../online/artwork';
import { fetchLocalLrc, localLibrary, lrcOf, onLocalLibraryChange } from './local';
import { fmtTime, h, icon } from './dom';
import { onPlayer, playerState, seek, type PlayerState } from './player';
import { getSettings, onSettingsChange } from '../core/settings';
import type { DesktopLyricsLinePayload } from '../core/bridge';
import { matchMinScore, matchTranslation, matchWordLyrics, setMatchMinScore, type LyricMatchResult } from './lyricMatch';
import { coverColorsOf, fallbackColors } from './coverColors';
import { createLumiereStage, lumiereMode, lumiereThemeForCover, setLumiereMode, type LumiereMode, type LumiereSongInput, type LumiereStage } from './lumiere';
import { createRoomStage, applyRoomStyleSettings, setRoomLyricTintProvider, type RoomStage } from './room';
import { createVinylStage, applyVinylStyleSettings, setVinylLyricTintProvider, type VinylStage } from './vinyl';
import { createFlowStage, type FlowStage } from './flow';
import { perfEvent, perfMark, perfOn } from './perfProbe';
import { createPoemStage, type PoemStage } from './poem';
import { createPressureStage, type PressureStage } from './pressure';
import type { Theme } from './lumiere-folia/types';
import type { LyricTextSettings } from './lumiereSettings';
import { LYRIC_STYLES, lyricStyle, lyricStyleNeedsCharTiming, onLyricStyle, reloadLyricStyle } from './lyricStyle';
import { BG_BLUR_PX, BG_COVER_EVENT, bgLyricsBlurLevel, bgLyricsBrightness, effectiveBgLyricsCoverStyle, lumiereEffectOn } from './bgLyricsCover';
import { applyLyricFontVar, lyricLangOf, onLyricFont } from './lyricFont';

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

// 唱片档：贴纸、唱臂与重点词也跟着「歌词颜色」走（纯色档用暖金三色）。
setVinylLyricTintProvider(() => {
  if (lyricsBgMode === 'solid') {
    return { mode: 'solid', palette: ['#c9a068', '#e8d4ae', '#ffcf8a'] };
  }
  return { mode: lyricsBgMode, palette: lumierePaletteNow ? [...lumierePaletteNow] : [] };
});

let activeLyricsView: LyricsView | null = null;

// 全局「歌词字体」变更：默认 DOM 歌词靠 --lyric-font 立即生效，画布效果重排字面；
// 背景歌词窗口是独立文档，由 lyricFont.ts 的 storage 事件同步。
onLyricFont(() => {
  applyLyricFontVar();
  activeLyricsView?.refreshLyricFont();
});

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

/** 「关闭」效果下未播放歌词的颜色；空串 = 跟随主题（默认语义色）。 */
const LYRIC_UNSUNG_KEY = 'zilux2.lyricUnsung';
const UNSUNG_HEX = /^#[0-9a-f]{6}$/i;

/** 未播放歌词颜色的预设（空串 = 跟随主题）。 */
export const LYRIC_UNSUNG_PRESETS: ReadonlyArray<{ label: string; color: string }> = [
  { label: '跟随主题', color: '' },
  { label: '墨黑', color: '#24262b' },
  { label: '暖沙', color: '#8a7355' },
  { label: '雾蓝', color: '#5d6f83' },
  { label: '青瓷', color: '#4f7d70' },
  { label: '绛紫', color: '#7a6484' },
];

function readLyricUnsungColor(): string {
  try {
    const value = window.localStorage.getItem(LYRIC_UNSUNG_KEY);
    if (value && UNSUNG_HEX.test(value)) return value.toLowerCase();
  } catch {
    // ignore
  }
  return '';
}

let lyricUnsungColorValue: string = readLyricUnsungColor();

/** 当前自定义的未播放歌词颜色；空串表示跟随主题。 */
export function lyricUnsungColor(): string {
  return lyricUnsungColorValue;
}

/** 修改未播放歌词颜色（传空串恢复跟随主题）；歌词页开着时立即生效。 */
export function setLyricUnsungColor(color: string): void {
  lyricUnsungColorValue = UNSUNG_HEX.test(color) ? color.toLowerCase() : '';
  try {
    window.localStorage.setItem(LYRIC_UNSUNG_KEY, lyricUnsungColorValue);
  } catch {
    // ignore
  }
  activeLyricsView?.applyLyricUnsungColor();
}

/** 自定义「纯色」歌词颜色；空串表示跟随主题。 */
const LYRIC_SOLID_KEY = 'zilux2.lyricSolid';
const SOLID_HEX = /^#[0-9a-fA-F]{6}$/;

function readLyricSolidColor(): string {
  try {
    const value = window.localStorage.getItem(LYRIC_SOLID_KEY);
    if (value && SOLID_HEX.test(value)) return value.toLowerCase();
  } catch {
    // ignore
  }
  return '';
}

let lyricSolidColorValue: string = readLyricSolidColor();

/** 当前自定义的纯色歌词颜色；空串表示跟随主题。 */
export function lyricSolidColor(): string {
  return lyricSolidColorValue;
}

/** 修改纯色歌词颜色（传空串恢复跟随主题）；歌词页开着时立即生效。 */
export function setLyricSolidColor(color: string): void {
  lyricSolidColorValue = SOLID_HEX.test(color) ? color.toLowerCase() : '';
  try {
    window.localStorage.setItem(LYRIC_SOLID_KEY, lyricSolidColorValue);
  } catch {
    // ignore
  }
  activeLyricsView?.applyLyricSolidColor();
}

/** 把十六进制颜色转成带透明度的 rgb() 语义值（未播放歌词的四个语义令牌共用）。 */
function unsungTone(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgb(${r} ${g} ${b} / ${alpha})`;
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
let primeRetryKey = '';
let primeRetryAt = 0;
/** 已经预取过的下一首（trackKey），避免 onPlayer 高频回调重复请求。 */
let prefetchKey = '';
let lyricMatchInfo: LyricMatchResult | null = null;
let lyricMatchSkipped = false;
let lyricMatchDone = false;
/** 'word' = 找逐字替换；'translation' = 已有逐字、只补翻译。 */
let lyricMatchMode: 'word' | 'translation' | 'direct' = 'word';
/** 手动选择的歌词来源（非空时不再自动匹配）。 */
let manualAmll = false;
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
  if (info.lines) {
    // base 已经写了「平台 · 格式 · 匹配 N%」；info.label 同样是「平台 · 逐字（QRC）」，
    // 直接拼上去会变成「QQ 音乐 · 逐字（QRC）· 匹配 100% · 逐字 QQ 音乐 · 逐字（QRC）」，
    // 在封面下方那一行里既重复又被省略号切掉。同平台就不再罗列一遍。
    const label = info.label ?? '';
    const platform = label.split(' · ')[0]?.trim() ?? '';
    return platform && base.startsWith(`${platform} ·`) ? base : `${base} · 逐字 ${label}`;
  }
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
  // 阈值变了，下一首预取的匹配结论也作废，重新按新阈值算一遍。
  prefetchKey = '';
  maybePrefetchNextLyric();
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
  const gen = ++lyricGeneration;
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
        if (gen !== lyricGeneration || lastDoc?.trackKey !== base.trackKey) return;
        lyricMatchDone = true;
        lyricMatchInfo = result;
        if (result) updateCurrentLyricLine();
        notifyMatch();
      })
      .catch(() => {
        if (gen !== lyricGeneration || lastDoc?.trackKey !== base.trackKey) return;
        lyricMatchDone = true;
        lyricMatchInfo = null;
        notifyMatch();
      });
    return;
  }
  void matchWordLyrics(track, base.lines)
    .then((result) => {
      if (gen !== lyricGeneration || lastDoc?.trackKey !== base.trackKey) return;
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
          if (gen !== lyricGeneration || lastDoc?.trackKey !== base.trackKey) return;
          lyricMatchDone = true;
          lyricMatchInfo = translated ?? result;
          if (translated && lastDoc) {
            lastDoc = { ...lastDoc, lines: base.lines };
            updateCurrentLyricLine();
          }
          notifyMatch();
        })
        .catch(() => {
          if (gen !== lyricGeneration || lastDoc?.trackKey !== base.trackKey) return;
          lyricMatchDone = true;
          lyricMatchInfo = result;
          notifyMatch();
        });
    })
    .catch(() => {
      if (gen !== lyricGeneration || lastDoc?.trackKey !== base.trackKey) return;
      lyricMatchDone = true;
      lyricMatchInfo = null;
      notifyMatch();
    });
}
let lastDoc: LyricDoc | null = null;

/**
 * 歌词代际：每次开始匹配/手动选源/清空都 +1。异步回调落地前必须比对它，
 * 否则「匹配途中手动选了来源」会被后台结果覆盖（界面回到自动匹配内容，
 * 但 `manualLyricLabel` 还显示手动）。
 */
let lyricGeneration = 0;

/** 当前窗口已解析好的歌词文档（背景歌词发布器用它判断同一首是否从「无歌词」变成「有歌词」）。 */
export function currentLyricDoc(): LyricDoc | null {
  return lastDoc;
}

/** 桌面背景歌词场景：跳过网络拉歌，歌词文档由主窗口经共享 localStorage 送进来。 */
let externalLyricMode = false;

export function setExternalLyricMode(enabled: boolean): void {
  externalLyricMode = enabled;
}

// 当前歌播放时提前准备下一首：队列/当前曲目变化都会触发，key 相同则跳过。
onPlayer(() => maybePrefetchNextLyric());
// 宿主接口/本地曲库晚于页面就绪时，等它们可用再补一次预取。
onOnlineChange(() => maybePrefetchNextLyric());
onLocalLibraryChange(() => maybePrefetchNextLyric());
maybePrefetchNextLyric();

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

/**
 * 预取下一首的歌词与跨平台逐字匹配结果：当前歌还在播时就把下一首准备好。
 *
 * 换歌后 `primeLyrics` 会直接命中 `preloadLyricSong` 的文档缓存，
 * `startLyricMatch` 会直接命中 `lyricMatch` 的结果缓存 —— 不再等播放开始后才去搜逐字替换。
 * 这里只填缓存，不动当前曲目的 lastDoc / 来源标签 / 匹配状态。
 */
export function prefetchUpcomingLyric(track: OnlineTrack | null): void {
  if (!track) return;
  if (track.source === 'local' ? !localLibrary() : !onlineReady()) return;
  const key = trackKeyOf(track);
  if (!key || key === trackKeyOf(playerState().track)) return;
  void preloadLyricSong(track)
    .then((input) => {
      if (input.lines.length === 0) return;
      // 手动来源由用户指定，不预跑自动匹配（换歌后会沿用同一份手动歌词）。
      if (readManual()[key]) return;
      const baseLines = input.lines as LyricLine[];
      return matchWordLyrics(track, baseLines).then((result) => {
        if (result?.lines) {
          // 预匹配到的逐字歌词要写回缓存：备场舞台是按 preloadLyricSong 的这份歌词建的，
          // 若这里丢掉匹配结果，切歌后 startLyricMatch 再匹配一次就会换掉整份文本，
          // 触发一次整场重建（实测 95~375ms，正好落在切歌后第一秒）。
          const cached = upcomingLyrics.get(key);
          if (cached) {
            cached.doc = {
              ...cached.doc,
              kind: result.kind === 'lrc' ? cached.doc.kind : result.kind,
              lines: result.lines,
            };
            if (result.label) cached.label = result.label;
          }
          return;
        }
        const baseHasTranslation = baseLines.some((line) => (line.translation ?? '').trim().length > 0);
        if (baseHasTranslation) return;
        return matchTranslation(track, baseLines);
      });
    })
    .catch(() => undefined);
}

/** 队列里的下一首变化时才重新预取（onPlayer 是高频回调，靠 key 去重）。 */
function maybePrefetchNextLyric(): void {
  if (externalLyricMode) return;
  const state = playerState();
  const next = state.queue[state.index + 1] ?? null;
  if (!next) return;
  const key = trackKeyOf(next);
  if (!key || key === prefetchKey) return;
  // 宿主接口还没就绪时不记 key，等下一次 onPlayer 再试。
  if (next.source === 'local' ? !localLibrary() : !onlineReady()) return;
  prefetchKey = key;
  prefetchUpcomingLyric(next);
}

/**
 * 从 localStorage 重读所有共享歌词外观（背景/未播放颜色/纯色/动效档位/偏移/播放样式）。
 *
 * 这些值原本都是模块级变量、只在窗口加载时读一次；桌面背景歌词是第二个窗口，
 * 主窗口改了设置后它只收到 storage 事件，必须重读一遍才能真正用上新值。
 * 只更新模块变量，重绘由调用方（LyricsView.refreshSharedStyle）负责。
 */
export function reloadSharedLyricSettings(): void {
  lyricsBgMode = readLyricsBgMode();
  lyricUnsungColorValue = readLyricUnsungColor();
  lyricSolidColorValue = readLyricSolidColor();
  lyricGrow = readLyricGrowMode();
  const offsets = readOffsets();
  for (const key of Object.keys(lyricOffsets)) delete lyricOffsets[key];
  Object.assign(lyricOffsets, offsets);
  reloadLyricStyle();
}

/** 打开快捷设置/歌词页之前先把歌词拉下来，这样来源与当前句立刻可见。 */
export function primeLyrics(track: OnlineTrack | null): void {
  const key = trackKeyOf(track);
  if (!key || primeKey === key) return;
  // 恢复播放先于宿主 ready 回执，不能把接口未就绪当作「这首没有歌词」。
  if (track?.source === 'local' ? !localLibrary() : !onlineReady()) return;
  if (primeRetryKey === key && performance.now() < primeRetryAt) return;
  if (lastDoc && lastDoc.trackKey === key) return;
  primeKey = key;
  void loadLyricDoc(track, true)
    .then((doc) => {
      if (doc.trackKey === key && trackKeyOf(playerState().track) === key) {
        primeRetryKey = '';
        lastDoc = doc;
        updateCurrentLyricLine();
        notifyMatch();
        if (track) startLyricMatch(track, doc);
      }
    })
    .catch(() => {
      // 网络暂时失败不缓存空文档；播放状态/兜底轮询会在退避后重试。
      primeRetryKey = key;
      primeRetryAt = performance.now() + 3000;
    })
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

/**
 * 重复时间戳（间奏里同一时刻挂两行、或时间轴被工具压平）会让 `activeIndexOf` 只停在最后那一行，
 * 前面那行永远没有高亮窗口，时长也算成 0。这里做一次单调化：时间戳至少 +1 ms 递增，
 * 时长按下一行（修好后的）起点推算，最小 200 ms。
 */
function normalizeLineTimes(lines: LyricLine[]): LyricLine[] {
  if (lines.length === 0) return lines;
  for (let i = 1; i < lines.length; i += 1) {
    const prev = lines[i - 1];
    const line = lines[i];
    if (!prev || !line) continue;
    if (line.timeMs <= prev.timeMs) {
      lines[i] = { ...line, timeMs: prev.timeMs + 1 };
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1];
    if (!line) continue;
    const span = (next ? next.timeMs : line.timeMs + 4200) - line.timeMs;
    if (!(line.durationMs > 0) || span > 0) {
      lines[i] = { ...line, durationMs: Math.max(200, span) };
    }
  }

  return lines;
}

function toDocLines(parsed: SourceLine[]): LyricLine[] {
  const built = parsed.map((line, index) => {
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
      durationMs: Math.max(200, end - start),
      text: line.text,
      translation: line.translation ?? '',
      words,
    };
  });
  return normalizeLineTimes(built);
}

interface PlatformLyric {
  qrc?: string | null;
  qrcText?: string | null;
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

/**
 * 逐字歌词（QRC/YRC）补翻译。
 *
 * 平台的逐字轨只带正文，译文在同一个响应里的另一条 `translation` 轨上；
 * 以前这里直接写死 `translation: ''`，于是「匹配歌词」预览能看到译文、
 * 真正播放的歌词页却没有（歌词页只能靠跨平台匹配再捞一次）。
 * 这里和 LRC 路径共用同一套规则：按行时间做 ±1s 的一对一贪心配对，
 * 并过滤空占位/与原文重复的译文。
 */
function attachTranslations(lines: LyricLine[], raw: string | null | undefined): LyricLine[] {
  if (!raw || lines.length === 0) return lines;
  const translated = parseLrc(raw)
    .map((line) => ({ timeMs: line.timeMs, text: line.text.trim() }))
    .filter((line) => line.text.length > 0);
  if (translated.length === 0) return lines;
  const pairs = pairByTime(
    lines.map((line) => line.timeMs),
    translated.map((line) => line.timeMs),
    1000,
  );
  lines.forEach((line, index) => {
    const target = pairs[index];
    if (target === null || target === undefined) return;
    const text = translated[target].text;
    if (isUsefulTranslation(text, line.text)) line.translation = text;
  });
  return lines;
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
  if (lyric.qrcText || lyric.qrc) {
    try {
      const payload = extractQrcPayload(lyric.qrcText ?? decryptQrc(lyric.qrc ?? ''));
      const qrcLines = parseQrcLyric(payload);
      if (qrcLines.length > 0 && !wordLyricTooShort(qrcLines, track.durationMs, lrcLines)) {
        return {
          doc: {
            kind: 'qrc',
            trackKey: key,
            lines: attachTranslations(
              qrcLines.map((line) => ({
                timeMs: line.timeMs,
                durationMs: line.durationMs,
                text: line.text ?? joinWords(line.words),
                translation: '',
                words: line.words.map((word) => ({ ...word })),
              })),
              lyric.translation,
            ),
          },
          label: `${prefix}${platform} · 逐字（QRC）${lyric.translation ? ' + 翻译' : ''}`,
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
          lines: attachTranslations(
            charLines.map((line) => ({
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
            lyric.translation,
          ),
        },
        label: `${prefix}${platform} · 逐字（YRC）${lyric.translation ? ' + 翻译' : ''}`,
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

const upcomingLyrics=new Map<string,{doc:LyricDoc;label:string;manualLabel:string;choice:string}>();
const upcomingLoads=new Map<string,Promise<LumiereSongInput>>();

/** Prepare only the queued song; never overwrite the current lyric document or source label. */
export function preloadLyricSong(track:OnlineTrack):Promise<LumiereSongInput>{
 const key=trackKeyOf(track),manual=readManual()[key],choice=manual?`${manual.source}:${manual.id}`:'';
 const requestKey=`${key}|${choice}`;
 const pending=upcomingLoads.get(requestKey);if(pending)return pending;
 const request=(async()=>{
  let cached=upcomingLyrics.get(key);
  if(!cached||cached.choice!==choice){
   let built:{doc:LyricDoc;label:string}|null=null;
   if(track.source==='local'){
    if(!localLibrary())throw new Error('Local lyric library is not ready');
    const rel=lrcOf(track);
    built={doc:{...EMPTY,trackKey:key,lines:rel?toDocLines(parseLrc(await fetchLocalLrc(rel))):[]},label:'本地 LRC 文件'};
   }else{
    if(manual){try{const candidate=docFromLyric(track,await fetchLyric(manual.source,manual.id),`${manual.label} · 手动选择 · `);if(candidate.doc.lines.length)built=candidate;}catch{/* Fall back to the track's own source. */}}
    if(!built)built=docFromLyric(track,await fetchLyric(track.source,track.id));
   }
   cached={...built,manualLabel:manual&&built.label.includes('手动选择')?manual.label:'',choice};
   upcomingLyrics.set(key,cached);
   while(upcomingLyrics.size>4)upcomingLyrics.delete(upcomingLyrics.keys().next().value!);
  }
  return {trackKey:key,title:track.title,artist:track.artist,album:track.album??'',coverUrl:onlineArtwork(track,300),durationMs:track.durationMs??0,lyricOffsetMs:lyricOffsetOf(key),lines:cached.doc.lines};
 })().finally(()=>upcomingLoads.delete(requestKey));
 upcomingLoads.set(requestKey,request);return request;
}

/** 拉取并解析当前曲目歌词。 */
export async function loadLyricDoc(track: OnlineTrack | null, throwOnFetchError = false): Promise<LyricDoc> {
  if (!track) return EMPTY;
  const key = trackKeyOf(track);
  lyricSource = '';
  lyricMatchInfo = null;
  lyricMatchSkipped = false;
  lyricMatchDone = false;
  manualLyricLabel = '';
  const warmed=upcomingLyrics.get(key);
  const selected=readManual()[key];
  if(warmed&&warmed.choice===(selected?`${selected.source}:${selected.id}`:'')){
    lyricSource=warmed.label;manualLyricLabel=warmed.manualLabel;return warmed.doc;
  }

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
      if (throwOnFetchError) throw err;
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
    if (throwOnFetchError) throw err;
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
/** 用 AMLL TTML DB 的逐字歌词替换当前曲目（手动选择，优先于自动匹配）。 */
export async function applyManualAmllLyric(track: OnlineTrack): Promise<boolean> {
  manualAmll = true;
  try {
    return await applyManualLyric(track, track.source, track.id, 'AMLL TTML DB');
  } finally {
    manualAmll = false;
  }
}
export async function applyManualLyric(
  track: OnlineTrack,
  source: string,
  id: string,
  label: string,
): Promise<boolean> {
  lyricGeneration += 1;
  try {
    const lyric = await fetchLyric(source, id, manualAmll ? { amll: true } : undefined);
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
  lyricGeneration += 1;
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
// total 已对齐运动档位：soft=base(420)、bounce=slow(620)；wild 是用户可选的极端档，刻意更长。
const GROW_PROFILES: Record<LyricGrowMode, { rise: number; total: number; overshoot: number }> = {
  off: { rise: 0, total: 0, overshoot: 0 },
  soft: { rise: 130, total: 420, overshoot: 0.58 },
  bounce: { rise: 150, total: 620, overshoot: 1.10 },
  wild: { rise: 160, total: 780, overshoot: 1.85 },
};

/**
 * 当前行的放大曲线（0 → 1）。
 * 起句先快速冲到 1+overshoot，再平滑回落、稳住。
 * 用真实时间（performance.now）而不是播放进度驱动，避免进度按 40ms 跳变导致动画一顿一顿。
 */
/** 毫秒 → 歌词行首显示用的 m:ss。 */
function clockText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

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


/** 普通 LRC 行里可动的单元：CJK 单字、外文按词；空白只作为 has-gap 间距，不单独立 span。 */
const PLAIN_TOKEN_RE =
  /(\s+)|([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff])|([^\s\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]+)/gu;

function splitPlainTokens(text: string): Array<{ text: string; spaceBefore: boolean }> {
  const tokens: Array<{ text: string; spaceBefore: boolean }> = [];
  let gap = false;
  for (const match of text.matchAll(PLAIN_TOKEN_RE)) {
    if (match[1] !== undefined) {
      gap = tokens.length > 0;
      continue;
    }
    const token = match[2] ?? match[3] ?? '';
    if (!token) continue;
    tokens.push({ text: token, spaceBefore: gap });
    gap = false;
  }
  return tokens;
}

/** 把译文按语言切成连续的 run，供每个语言套用自己的字体。标点/空白跟随前一段。 */
function splitLangRuns(text: string): Array<{ text: string; lang: ReturnType<typeof lyricLangOf> }> {
  const runs: Array<{ text: string; lang: ReturnType<typeof lyricLangOf> }> = [];
  for (const ch of Array.from(text)) {
    const lang = lyricLangOf(ch);
    const last = runs[runs.length - 1];
    if (last && (last.lang === lang || !lang)) {
      last.text += ch;
    } else if (last && !last.lang) {
      last.lang = lang;
      last.text += ch;
    } else {
      runs.push({ text: ch, lang });
    }
  }
  return runs;
}

/** 稳定的字级 hash：同一句、同一位置每次渲染得到同一组「飘入」偏移，避免重渲染时字乱跳。 */
function scatterHash(lineText: string, index: number): number {
  let hash = 2166136261;
  const key = `${index}:${lineText}`;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 由 hash 派生的 0~1 伪随机数（salt 区分不同维度，同一字不同维度各自随机）。 */
function scatterRandom(hash: number, salt: number): number {
  let value = (hash ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
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

/** 桌面歌词窗口用：与关闭效果时的歌词栏相同，提供上下文和当前句译文。 */
export function currentLyricDisplay(): {
  previous: string; now: string; next: string; translation: string; words: LyricWord[]; activeWord: number;
  positionMs: number; playing: boolean; index: number; lines: DesktopLyricsLinePayload[]; linesStart: number;
} {
  const doc = lastDoc;
  const state = playerState();
  const track = state.track;
  const empty = {
    previous: '', now: '', next: '', translation: '', words: [] as LyricWord[], activeWord: -1,
    positionMs: state.positionMs, playing: state.playing, index: -1, lines: [] as DesktopLyricsLinePayload[], linesStart: 0,
  };
  if (!doc || doc.lines.length === 0 || !track) return empty;
  // 换歌后新歌词还没拉回来时，lastDoc 仍是上一首的——不能把上一首的句子推给桌面歌词。
  if (doc.trackKey !== `${track.source}:${track.id}`) return empty;
  const position = state.positionMs + lyricOffsetOf(doc.trackKey);
  const index = activeIndexOf(doc.lines, position);
  const line = doc.lines[index];
  const words = line?.words ?? [];
  let activeWord = -1;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    if (position >= word.startMs && position < word.endMs) {
      activeWord = i;
      break;
    }
  }
  // 上下文窗口：当前句前 14 句到后 9 句，最多 24 行（宿主收到就整体替换上下文）。
  const windowStart = Math.max(0, index - 14);
  const windowEnd = Math.min(doc.lines.length, index + 10, windowStart + 24);
  const lines: DesktopLyricsLinePayload[] = [];
  for (let i = windowStart; i < windowEnd; i += 1) {
    const entry = doc.lines[i]!;
    lines.push({
      text: entry.text,
      translation: entry.translation,
      startMs: entry.timeMs,
      endMs: entry.timeMs + entry.durationMs,
      words: entry.words.map((word) => ({ text: word.text, spaceBefore: word.spaceBefore, startMs: word.startMs, endMs: word.endMs })),
    });
  }
  return {
    previous: doc.lines[index - 1]?.text ?? '',
    now: line?.text ?? '',
    next: doc.lines[index + 1]?.text ?? '',
    translation: line?.translation ?? '',
    words,
    activeWord,
    positionMs: position,
    playing: state.playing,
    index,
    lines,
    linesStart: windowStart,
  };
}

/**
 * 当前歌词窗口（上一句 / 正在唱的一句 / 下一句），供首页平面世界的播放台展示。
 * 无歌词或还没加载完时三行都返回空串。
 */
export function currentLyricSnapshot(): { prev: string; now: string; next: string } {
  const doc = lastDoc;
  if (!doc || doc.lines.length === 0) return { prev: '', now: '', next: '' };
  const state = playerState();
  const position = state.positionMs + lyricOffsetOf(doc.trackKey);
  const index = activeIndexOf(doc.lines, position);
  return {
    prev: doc.lines[index - 1]?.text ?? '',
    now: doc.lines[index]?.text ?? '',
    next: doc.lines[index + 1]?.text ?? '',
  };
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
  private transBar: HTMLDivElement;
  private transBarTarget = '';
  private transBarVisible = false;
  private transBarTimer: number | null = null;
  private progressFill: HTMLDivElement;
  private progressCur: HTMLSpanElement;
  private progressDur: HTMLSpanElement;
  private bgEl: HTMLDivElement;
  private bgMode: LyricsBgMode = lyricsBgMode;
  private bgToken = 0;
  private palette: string[] | null = null;
  private tintedIndex = -1;
  /** 歌曲信息反差色采样用的封面地址，换封面才重新采样。 */
  private metaToneKey = '';
  private flowLast = 0;
  private coverWrapEl: HTMLDivElement;
  private metaEl: HTMLDivElement;
  private coverEl: HTMLImageElement;
  private coverRetries = 0;
  private coverRetryTimer = 0;
  /** 「封面在左」的模糊副本：贴在清晰封面下面，强度与背景歌词共用。 */
  private coverBlurEl: HTMLDivElement;
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
  /** 上一次真正写进 --grow 的量化值（避免每帧重写导致字形重采样）。 */
  private lastGrowWritten = -1;
  /** 每行的基准字号/行高（未放大时量一次）。放大改用 font-size，必须知道基准值。 */
  private lineBaseMetrics = new WeakMap<HTMLElement, { size: number; lineHeight: number }>();
  /** 钉成布局根时记下这一行占几行文本，版面变化后按它重钉高度。 */
  private growRows = new WeakMap<HTMLElement, number>();
  /** 最近一次写进字号的曲线值：版面变化重算时照着它复原，不然当前行会瞬间缩回基准字号。 */
  private lastGrowApplied = 1;
  /** 「苹果」样式：逐字按时间刷亮（写 --kf），别的模式不写。 */
  /** 「苹果」样式是独立界面：自己一套 DOM、弹簧滚动与逐字刷亮，不碰默认歌词的样式与设置。 */
  /** 背景歌词窗是否已经落过一次居中偏移（第一次要硬落位，不能滑）。 */
  private bgOffsetSnapped = false;
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
  /** 播放效果（唱片）舞台：暖褐聆听室 + 33⅓ 转黑胶 + 黄铜唱臂，歌词压在唱片下方。 */
  private vinylStage: VinylStage | null = null;
  private flowStage: FlowStage | null = null;
  private poemStage: PoemStage | null = null;
  private pressureStage: PressureStage | null = null;
  /** 进页时等画布第一次出像的监听（见 watchStagePaint）。 */
  private stageObserver: MutationObserver | null = null;
  /** 已出像但 is-covered 还没挂上时，撤「准备中」的短计时器。 */
  private stagePaintTimer = 0;
  /** 默认歌词页的播放样式（见 lyricStyle.ts）：只切 root 上的 lyric-style-<id> class，动画全在 CSS 里。 */
  private styleUnsub: (() => void) | null = null;
  /** 「封面在左」样式与桌面背景歌词共用，快捷设置里改了要当场切换。 */
  private coverStyleUnsub: (() => void) | null = null;
  /** 设置面板改歌词字号：不重开歌词页也要立刻换行高。 */
  private settingsUnsub: (() => void) | null = null;
  private coverStyleInitialized = false;
  private coverSwitchTimer = 0;
  /** 封面切换代次：连续切歌/换图时，上一次预载的回调会因代次不符而作废，避免旧封面写回。 */
  private coverSwapToken = 0;
  /** 已写入背景层的封面 URL：播放器每 100ms 推一次进度，URL 没变就不必重写 style。 */
  private bannerUrl = '';
  /** 已按封面取过色的曲目 key：同一首歌重复推送进度时不再重跑取色。 */
  private tintKey = '';
  /** 上次逐字配色写入时间：长歌词时限到 ~15fps，避免 60fps 重写整行 span。 */
  private tintPaintAt = 0;
  /** 上一次交给播放效果舞台的歌词快照，用于挡掉高频重复的 setSong。 */
  private lumiereSongKey = '';
  private lumiereSongOffset = 0;
  private lumiereSongDoc: LyricDoc | null = null;
  private lumiereSongDuration = 0;
  /** 长歌词的行偏移/行高缓存：同步时只读缓存，避免每帧对活动行读 offsetTop 强制布局。 */
  private lineMetrics: Array<{ top: number; height: number }> = [];
  private resizeTimer = 0;
  private lyricsSizeApplied = '';
  /** 上一次重算「放大余量」的时间：版面过渡（进歌词页、换封面宽高、切字号）期间也要跟手修正。 */
  /** 逐字状态的上一行与缓存：同一行内只 toggle 发生变化的 span。 */
  private charStateLine = -1;
  private charStateCache: number[] = [];

  /** 窗口尺寸变化：字号是 vw 夹取、封面请求宽度也跟窗口走，去抖后重测并换更高分辨率封面。 */
  private readonly onWindowResize = (): void => {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (this.disposed) return;
      this.lineMetrics = [];
      this.applyLyricsSizeSetting();
      this.refreshCoverResolution();
      this.measureLines();
      this.syncProgress(true);
      this.recapEmphasis();
    }, 180);
  };

  constructor(private readonly onClose: () => void) {
    this.bgEl = h('div', { class: 'lyrics-bg' });
    this.coverEl = h('img', { class: 'lyrics-cover', alt: '' });
    this.coverEl.decoding = 'async';
    this.coverEl.onerror = () => {
      const key = this.lastTrackKey;
      const track = this.state?.track;
      if (!track || this.disposed) return;
      this.coverEl.src = onlineArtwork({ ...track, cover: '' });
      window.clearTimeout(this.coverRetryTimer);
      if (this.coverRetries >= 3) return;
      this.coverRetryTimer = window.setTimeout(() => {
        if (this.disposed || this.lastTrackKey !== key || !this.state?.track) return;
        this.coverEl.src = onlineArtwork(this.state.track, this.coverRequestWidth());
      }, 500 * 2 ** this.coverRetries++);
    };
    this.titleEl = h('div', { class: 'lyrics-title', text: '未在播放' });
    this.artistEl = h('div', { class: 'lyrics-artist', text: '' });
    this.sourceEl = h('div', { class: 'lyrics-source', text: '' });
    this.linesEl = h('div', { class: 'lyrics-lines' });
    this.transBar = h('div', { class: 'lyrics-transbar is-empty' });
    this.progressFill = h('div', { class: 'lyrics-progress-fill' });
    this.progressCur = h('span', { class: 'lyrics-progress-cur', text: '00:00' });
    this.progressDur = h('span', { class: 'lyrics-progress-dur', text: '00:00' });
    this.emptyEl = h('div', { class: 'lyrics-empty', text: '这首歌还没有歌词' });
    this.rightEl = h('div', { class: 'lyrics-right' }, this.linesEl, this.emptyEl);

    this.coverBlurEl = h('div', { class: 'lyrics-cover-blur' });
    this.coverWrapEl = h('div', { class: 'lyrics-cover-wrap' }, this.coverEl);
    this.metaEl = h('div', { class: 'lyrics-meta' }, this.titleEl, this.artistEl, this.sourceEl);

    const closeBtn = h('button', { class: 'lyrics-close', title: '收起歌词' }, icon('chevron', 22));
    closeBtn.addEventListener('click', () => this.onClose());

    const scrim = h('div', { class: 'lyrics-scrim' });
    this.root = h(
      'div',
      { class: 'lyrics-view' },
      this.bgEl,
      scrim,
      closeBtn,
      h(
        'div',
        { class: 'lyrics-frame' },
        h(
          'div',
          { class: 'lyrics-left' },
          this.coverBlurEl,
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
      this.transBar,
    );

    this.applyLumiereMode();
    this.applyLyricStyle();
    this.applyLyricUnsungColor();
    this.applyLyricsSizeSetting();
    this.styleUnsub = onLyricStyle(() => {
      // 样式切换可能改变字号/行高，行缓存先作废。
      this.lineMetrics = [];
      this.applyLyricStyle();
    });
    window.addEventListener('resize', this.onWindowResize);
    let firstViewportObservation = true;
    this.domLayoutObserver = new ResizeObserver(() => {
      if (firstViewportObservation) {
        firstViewportObservation = false;
        return;
      }
      if (this.disposed || this.covered || this.browsing()) return;
      requestAnimationFrame(() => { if (!this.disposed && !this.covered) { this.measureLines(); this.syncProgress(true); this.recapEmphasis(); } });
    });
    // Observe the viewport only. Animated lyric font sizes also resize the content.
    this.domLayoutObserver.observe(this.rightEl);
    this.settingsUnsub = onSettingsChange(() => {
      const before = this.lyricsSizeApplied;
      this.applyLyricsSizeSetting();
      // 字号变了：行高缓存已作废，暂停时也立刻按新字号重新居中一次。
      if (before !== this.lyricsSizeApplied) { this.syncProgress(true); this.recapEmphasis(); }
    });

    // 字体换上去以后字宽会变（同一句可能从两行变一行），落定后再校一次放大余量。
    if (document.fonts?.status === 'loading') void document.fonts.ready.then(() => {
      if (this.disposed) return;
      this.measureLines();
      this.recapEmphasis();
    });

    // 「封面在左」：软件内歌词页和桌面背景歌词保持一致，共用 bgLyricsCover 里的样式选择。
    this.applyCoverStyle();
    this.applyBgBrightness();
    const onCoverStyle = (): void => {
      // 事件同时代表「封面样式 / 模糊强度 / 封面之后 / 亮度」四种改动：
      // applyCoverStyle 只在样式真的翻转时才继续，模糊强度必须无条件重算，
      // 否则停在「封面在左」时拖模糊滑块不会有任何变化。
      this.applyCoverStyle();
      this.applyCoverBlurStyle();
      this.applyBgBrightness();
    };
    window.addEventListener(BG_COVER_EVENT, onCoverStyle);
    this.coverStyleUnsub = () => window.removeEventListener(BG_COVER_EVENT, onCoverStyle);

    // 切歌瞬间匹配结果会分几批回调（每批一份 doc）。以前每批都立刻 render 一次，
    // 一帧里连做三遍整份歌词 DOM 重建（实测 3×20~40ms = 70ms+，正好压在切歌帧上）。
    // 现在只记最新 doc，同一帧内多次回调合并成一次绘制。
    let docPaint = 0, docPaintAt = 0, docKey = '';
    // 匹配只在「真的换了内容」时才重画：预匹配结果写回缓存后，切歌后的再次匹配内容相同，
    // 不该再重建一遍整份歌词 DOM 与画面。
    const contentKey = (doc: LyricDoc | null): string => doc
      ? [doc.kind, doc.trackKey, doc.lines.length,
        doc.lines.reduce((sum, line) => sum + line.text.length + (line.translation?.length ?? 0) + (line.words?.length ?? 0) * 4, 0),
        doc.lines[0]?.text ?? '', doc.lines[doc.lines.length - 1]?.text ?? ''].join('|')
      : '';
    this.matchUnsub = onLyricMatch(() => {
      if (this.disposed) return;
      if (lastDoc && lastDoc.trackKey === this.lastTrackKey && this.doc !== lastDoc) {
        this.doc = lastDoc;
        const key = contentKey(lastDoc);
        if (key === docKey) return;
        docKey = key;
        // 匹配结果是「粗匹配 → 精匹配」连着来的：只留最后一次，90ms 内的中间稿不画，
        // 否则切歌帧要连做两遍整份歌词 DOM 重建（实测 47ms + 29ms 全落在这一帧）。
        const now = performance.now();
        if (docPaint) window.clearTimeout(docPaint); else docPaintAt = now;
        const delay = now - docPaintAt > 200 ? 0 : 90;
        docPaint = window.setTimeout(() => {
          docPaint = 0;
          if (this.disposed) return;
          this.render();
          // 匹配结果会替换整份歌词：画布效果的主题字体按新文本的主要语言重算一次，
          // 否则会沿用上一首/上一版歌词的语言字体。
          this.applyLumiereTheme();
        }, delay);
      }
    });

    this.unsubscribe = onPlayer((state) => {
      if (this.disposed) return;
      const playerAt=perfOn()?performance.now():0;
      this.state = state;
      this.syncTrack();
      this.syncLumiereSong();
      this.schedule();
      if(playerAt)perfMark('lyrics.onPlayer',playerAt);
    });

    // 滚轮手动浏览歌词：临时脱离自动居中，停手几秒后回到当前行
    this.rightEl.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });

    activeLyricsView = this;
  }

  private syncTrack(): void {
    this.applyLyricsSizeSetting();
    const track = this.state?.track ?? null;
    const key = trackKeyOf(track);
    const coverUrl = track ? onlineArtwork(track, this.coverRequestWidth()) : '';
    const changed = key !== this.lastTrackKey && this.lastTrackKey !== '';
    if (changed) {
      this.spawnMetaGhost();
      this.bgEl.classList.remove('is-switching');
      void this.bgEl.offsetWidth;
      this.bgEl.classList.add('is-switching');
      window.setTimeout(() => this.bgEl.classList.remove('is-switching'), 620);
    }
    const coverChanged = coverUrl !== this.bannerUrl;
    if (coverChanged || key !== this.lastTrackKey) {
      window.clearTimeout(this.coverRetryTimer);
      this.coverRetries = 0;
    }
    if (coverChanged) {
      this.bannerUrl = coverUrl;
      this.bgEl.style.backgroundImage = coverUrl ? `url("${coverUrl}")` : 'none';
      void this.refreshMetaTone(track, coverUrl);
    }
    if (key !== this.tintKey) {
      this.tintKey = key;
      void this.applyTextTint();
    }
    if (changed) {
      this.swapCoverWithFade(coverUrl);
      this.metaEl.classList.remove('is-switching');
      this.metaEl.classList.add('is-switching');
      window.setTimeout(() => this.metaEl.classList.remove('is-switching'), 620);
    } else if (coverChanged) {
      this.coverEl.src = coverUrl;
      this.coverBlurEl.style.backgroundImage = coverUrl ? `url("${coverUrl}")` : 'none';
    }
    if (this.titleEl.textContent !== (track?.title ?? '未在播放')) this.titleEl.textContent = track?.title ?? '未在播放';
    if (this.artistEl.textContent !== (track?.artist ?? '')) this.artistEl.textContent = track?.artist ?? '';
    if (changed || key !== this.lastTrackKey) {
      this.lastTrackKey = key;
      void this.reload(track);
    }
  }

  /**
   * 歌曲信息（标题/歌手/来源）压在封面或模糊封面上：按封面整体明暗自动切换反差色。
   * 优先用宿主取色（/api/cover/colors，跨域安全、与封面主色一致）；拿不到再退回本地像素采样。
   * 亮底→深字（is-meta-dark），暗底→浅字（is-meta-light），中间调沿用主题色。
   */
  private async refreshMetaTone(track: OnlineTrack | null, coverUrl: string): Promise<void> {
    const toneKey = track ? `${track.source}:${track.id}:${track.cover ?? ''}` : '';
    if (!toneKey || toneKey === this.metaToneKey) return;
    this.metaToneKey = toneKey;
    let luminance: number | null = null;
    const colors = await coverColorsOf(track);
    if (this.disposed || toneKey !== this.metaToneKey) return;
    if (colors) {
      const swatches = [colors.dominant, ...colors.palette].slice(0, 4);
      const values = swatches.map(color => this.colorLuminance(color));
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      // 主色占封面面积最大；模糊背景大致等于整张封面的平均观感，主色权重更高。
      luminance = this.colorLuminance(colors.dominant) * 0.55 + average * 0.45;
    } else if (coverUrl) {
      luminance = await this.sampleMetaLuminance(coverUrl);
      if (this.disposed || toneKey !== this.metaToneKey) return;
    }
    this.root.classList.toggle('is-meta-dark', luminance !== null && luminance >= 0.58);
    this.root.classList.toggle('is-meta-light', luminance !== null && luminance <= 0.42);
  }

  /** 把 #rrggbb / rgb() / hsl() 颜色换算成 0~1 的感知亮度。 */
  private colorLuminance(color: string): number {
    const text = color.trim();
    let rgb: [number, number, number] | null = null;
    if (text.startsWith('#') && text.length >= 7) {
      rgb = [parseInt(text.slice(1, 3), 16), parseInt(text.slice(3, 5), 16), parseInt(text.slice(5, 7), 16)];
    } else {
      const hsl = text.match(/hsl\(\s*([\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i);
      if (hsl) {
        const hue = ((Number(hsl[1]) % 360) + 360) % 360 / 360;
        const sat = Number(hsl[2]) / 100;
        const light = Number(hsl[3]) / 100;
        const chroma = (1 - Math.abs(2 * light - 1)) * sat;
        const x = chroma * (1 - Math.abs(((hue * 6) % 2) - 1));
        const m = light - chroma / 2;
        const table: Array<[number, number, number]> = [
          [chroma, x, 0],
          [x, chroma, 0],
          [0, chroma, x],
          [0, x, chroma],
          [x, 0, chroma],
          [chroma, 0, x],
        ];
        const pick = table[Math.floor(hue * 6) % 6] ?? [0, 0, 0];
        rgb = [(pick[0] + m) * 255, (pick[1] + m) * 255, (pick[2] + m) * 255];
      } else {
        const match = text.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
        if (match) rgb = [Number(match[1]), Number(match[2]), Number(match[3])];
      }
    }
    if (!rgb) return 0.5;
    return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  }

  /** 本地像素兜底：取封面右上区域的平均亮度（封面跨域被污染时返回 null）。 */
  private async sampleMetaLuminance(url: string): Promise<number | null> {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.referrerPolicy = 'no-referrer';
    image.decoding = 'async';
    const loaded = await new Promise<boolean>((resolve) => {
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
      image.src = url;
    });
    if (!loaded || this.disposed) return null;
    try {
      const size = 32;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(image, 0, 0, size, size);
      const data = context.getImageData(0, 0, size, size).data;
      // 对应屏幕上歌曲信息的位置：封面右半、上三分之一。
      let sum = 0;
      let count = 0;
      for (let y = 0; y < Math.round(size * 0.34); y += 1) {
        for (let x = Math.round(size * 0.5); x < size; x += 1) {
          const i = (y * size + x) * 4;
          sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          count += 1;
        }
      }
      return count > 0 ? sum / count : null;
    } catch {
      return null;
    }
  }

  /**
   * 版面变了（窗口尺寸 / 歌词列宽度 / 字号字体）就重算当前行的放大余量。
   * 换行时会算一次，但歌词页是在进页动画里量出来的：那一帧列宽可能还没定，
   * 只算一次会让首句带着旧的（偏大的）余量放大，右侧同样会被切掉。
   */
  private recapEmphasis(): void {
    if (this.disposed || this.covered || this.activeIndex < 0) return;
    const el = this.lineEls[this.activeIndex];
    // 版面变了（窗口最大化 / 字号档位 / 字体加载完成）时基准字号也会变：
    // 缓存不清就会一直拿旧基准算放大——最大化后 CSS 把行字号提到 76px，
    // 这里还按 29px 放大，当前行反而比周围的普通行小一圈。
    //
    // 这里**只换基准再重钉**，不 resetGrowStyle：拆掉布局根会让这一行当场重排、
    // 还会把 ResizeObserver 再叫一次（observer 就挂在 .lyrics-lines 上），
    // 一拆一钉之间画面会抖，窗口态下看起来就像「动画坏了」。
    const before = this.baseMetricsOf(el);
    this.lineBaseMetrics.delete(el);
    this.growRows.delete(el);
    const next = this.baseMetricsOf(el);
    this.applyLineEmphasisCap(this.activeIndex);
    this.pinGrowBox(el);
    if (before.size !== next.size || before.lineHeight !== next.lineHeight) {
      this.applyGrowFrame(el, this.lastGrowApplied);
    }
  }

  /**
   * 当前行的放大只向右扩展；长句已经贴到歌词列右缘时，按剩余空间收小放大倍数，
   * 避免最后几个字被 .lyrics-right 的 overflow 裁掉。
   * 结果写进 --line-emph（0~0.207），CSS 用 scale(1 + var(--line-emph) * var(--grow))。
   *
   * 这一条必须在**每次换行**时都算一次（`syncProgress` 里 changed 分支 + 尺寸/字号变化时重算）：
   * 只靠 CSS 的默认 0.207，长句起句放大后会冲出歌词列，右侧被硬切——用户看到的就是
   * 「歌词右边被切掉」。
   */
  /**
   * 取这一行的基准字号与行高（放大前量一次，之后一直用）。
   * 量的时候要先摘掉自己写过的行内字号，否则量到的是「已经放大过」的值。
   */
  private baseMetricsOf(el: HTMLElement): { size: number; lineHeight: number } {
    const cached = this.lineBaseMetrics.get(el);
    if (cached) return cached;
    const prevSize = el.style.getPropertyValue('font-size');
    const prevSizePrio = el.style.getPropertyPriority('font-size');
    const prevLh = el.style.getPropertyValue('line-height');
    const prevLhPrio = el.style.getPropertyPriority('line-height');
    el.style.removeProperty('font-size');
    el.style.removeProperty('line-height');
    const computed = getComputedStyle(el);
    const size = Number.parseFloat(computed.fontSize) || 29;
    const lineHeight = Number.parseFloat(computed.lineHeight) || size * 1.46;
    if (prevSize) el.style.setProperty('font-size', prevSize, prevSizePrio);
    if (prevLh) el.style.setProperty('line-height', prevLh, prevLhPrio);
    const metrics = { size, lineHeight };
    this.lineBaseMetrics.set(el, metrics);
    return metrics;
  }

  /**
   * 把放大写进字号：`基准字号 × (1 + 余量 × 曲线值)`，行高钉死在基准行高上。
   * 行高不动 → 字号变大也不会把下面几行顶下去；字号由浏览器按设备像素重新排版，
   * 所以放大全程都是清晰的（transform 缩放会整段模糊）。
   * 用 important 写行内声明：字号在各版面档位里被 CSS 用 !important 定死过，
   * 只有行内 important 能压过它们。
   */
  private applyGrowFrame(el: HTMLElement | undefined, grow: number): void {
    if (!el) return;
    this.lastGrowApplied = grow;
    const emphText = el.style.getPropertyValue('--line-emph');
    const emph = Number.parseFloat(emphText);
    const { size } = this.baseMetricsOf(el);
    const factor = 1 + (Number.isFinite(emph) ? emph : 0) * grow;
    el.style.setProperty('font-size', `${(size * factor).toFixed(2)}px`, 'important');
  }

  /**
   * 把当前行钉成一个独立的布局根：固定宽高 + `contain: layout`。
   *
   * 为什么必须这么做：放大改成改字号之后，每一次字号变化都会让这一行重新排版；
   * 如果它和整列歌词（几十行）共用一个格式化上下文，浏览器每帧要把整列的
   * max-content / 行盒重算一遍——实测单帧从 5.8ms 涨到 10.7ms，起句那一下就是「卡」。
   * 钉成独立布局根后，字号变化的影响被关在这一行里，实测回落到与静止时一样（5.2ms），
   * 曲线可以按原来的弹性重放而不掉帧。
   */
  private pinGrowBox(el: HTMLElement | undefined): void {
    if (!el) return;
    const { lineHeight } = this.baseMetricsOf(el);
    // 已经在钉着的时候，行数用「现有钉死高度 ÷ 新行高」换算：
    // 直接按 rect.height 算的话，rect 高度里带着旧行高，换版面时行数会算错（钉成 1 行 → 折行被裁）。
    const pinned = Number.parseFloat(el.style.getPropertyValue('height'));
    const rows = Number.isFinite(pinned) && pinned > 0
      ? Math.max(1, Math.round(pinned / Math.max(1, lineHeight)))
      : Math.max(1, Math.round(el.getBoundingClientRect().height / Math.max(1, lineHeight)));
    this.growRows.set(el, rows);
    el.style.setProperty('line-height', `${lineHeight.toFixed(2)}px`, 'important');
    // 宽度必须钉成「整列可用宽」，不能钉成这一行此刻的文字宽：
    // 行是 width:max-content，钉成文字宽之后再放大字号，字就挤不下、会折到下一行，
    // 看着就是「弹的时候文字自己在挪位置」。钉满整列宽后字号只向右长，不换行。
    el.style.setProperty('width', '100%', 'important');
    el.style.setProperty('height', `${(lineHeight * rows).toFixed(2)}px`, 'important');
    el.style.setProperty('contain', 'layout', 'important');
  }

  /** 版面变了（窗口缩放 / 字体变化）时重钉一次布局根，宽度与行数跟着版面走。 */
  /** 还原这一行被放大后的行内字号，并解除布局根（宽度交还给版面）。 */
  private resetGrowStyle(el: HTMLElement | undefined): void {
    if (!el) return;
    el.style.removeProperty('font-size');
    el.style.removeProperty('line-height');
    el.style.removeProperty('width');
    el.style.removeProperty('height');
    el.style.removeProperty('contain');
  }

  private applyLineEmphasisCap(index: number): void {
    const el = this.lineEls[index];
    if (!el) return;
    const chars = this.charEls[index] ?? [];
    if (chars.length === 0) {
      // 没量到字宽时不放大：宁可少一点强调，也不能让长句冲出歌词列被 overflow 裁掉。
      el.style.setProperty('--line-emph', '0');
      return;
    }
    const rightRect = this.rightEl.getBoundingClientRect();
    // 量余量必须在「基准字号」下量：这一行可能正处在放大中途（甚至是被
    // ResizeObserver 触发的重算），带着放大后的字号量出来的字宽偏大，
    // 余量被算小 → 放大忽大忽小，看起来就是「弹一下又缩回去」。
    const inlineSize = el.style.getPropertyValue('font-size');
    const inlinePrio = el.style.getPropertyPriority('font-size');
    if (inlineSize) el.style.removeProperty('font-size');
    const lineRect = el.getBoundingClientRect();
    const transform = getComputedStyle(el).transform;
    let scale = 1;
    if (transform && transform !== 'none') {
      try {
        scale = new DOMMatrixReadOnly(transform).a || 1;
      } catch {
        scale = 1;
      }
    }
    let textRight = lineRect.left;
    for (const span of chars) {
      const rect = span.getBoundingClientRect();
      if (rect.right > textRight) textRight = rect.right;
    }
    if (inlineSize) el.style.setProperty('font-size', inlineSize, inlinePrio);
    // 还原成未放大的版面宽度：transform-origin 在行首，左缘不随缩放移动。
    const baseWidth = (textRight - lineRect.left) / scale;
    // 右缘以歌词列的内容盒为准（.lyrics-lines 的 padding-right 不算可用空间），
    // 再扣掉 active 行固定的 8px 右移与 4px 安全余量；之前直接用列外框，
    // 长句会多算 16px 余量，放大后最后几个字仍被 overflow 裁掉。
    // 可用右缘 = 歌词列（.lyrics-right）的内边距盒：列本身留了一段右侧余量给「起句放大」，
    // 放大只能长到 padding 边界为止，越过就会被 overflow 裁掉。
    const colPadRight = Number.parseFloat(getComputedStyle(this.rightEl).paddingRight) || 0;
    const contentRight = rightRect.right - colPadRight - 2;
    const room = contentRight - lineRect.left - 12;
    // 放大曲线会先冲过 1（wild 档峰值 2.85），按峰值反推每行的最大放大余量，
    // 否则长句在起句瞬间仍会越过右缘被裁掉。
    const peakGrow = 1 + (GROW_PROFILES[lyricGrow]?.overshoot ?? 0);
    const maxScale = baseWidth > 8 ? room / baseWidth : 1.34;
    // 0.34 是观感上限（≈ 原来 scale 1.34 的强调力度）；长句由 room 压小。
    const raw = (maxScale - 1) / Math.max(1, peakGrow);
    // 长句也不能完全没有弹性：留 3.2% 的底线（约 1px），量出来确实没空间时才归零。
    const floor = baseWidth > 8 && room > baseWidth ? 0.032 : 0;
    const emph = Math.max(floor, Math.min(0.34, raw));
    const next = emph.toFixed(4);
    if (el.style.getPropertyValue('--line-emph') !== next) {
      el.style.setProperty('--line-emph', next);
    }
  }

  /**
   * 换封面：先预载新图，加载完再把旧图做成 ghost 淡出、新图淡入。
   * 之前是直接替换 src，新图解码前会先出现一帧空白，看起来就像硬切。
   */
  private swapCoverWithFade(url: string): void {
    const previous = this.coverEl.getAttribute('src') ?? '';
    // 每次切图都换一个代次：旧图预载完成得晚（或 700ms 兜底才到）时不再把旧封面写回去。
    const token = ++this.coverSwapToken;
    let swapped = false;
    const swap = (): void => {
      if (this.disposed || swapped || token !== this.coverSwapToken) return;
      swapped = true;
      if (previous) this.spawnCoverGhost(previous);
      this.coverEl.src = url;
      this.coverBlurEl.style.backgroundImage = url ? `url("${url}")` : 'none';
      this.coverEl.classList.remove('is-switching');
      void this.coverEl.offsetWidth;
      this.coverEl.classList.add('is-switching');
      window.setTimeout(() => this.coverEl.classList.remove('is-switching'), 620);
    };
    if (!url || url === previous) {
      swapped = true;
      this.coverEl.src = url;
      return;
    }
    const image = new Image();
    // decode() 在后台线程把位图准备好再换：否则首次绘制时才解码，模糊层会额外掉一帧。
    image.onload = () => {
      const ready = typeof image.decode === 'function' ? image.decode() : Promise.resolve();
      void ready.catch(() => undefined).then(swap);
    };
    image.onerror = swap;
    image.src = url;
    window.setTimeout(swap, 700);
  }

  private spawnCoverGhost(url: string): void {
    const ghost = h('div', { class: 'lyrics-cover-ghost' });
    ghost.style.backgroundImage = `url("${url}")`;
    this.coverWrapEl.append(ghost);
    window.setTimeout(() => ghost.remove(), 560);
  }

  syncBackgroundMode(): void {
    if (this.disposed) return;
    this.bgMode = lyricsBgMode;
    void this.applyTextTint();
  }

  /**
   * 封面请求宽度：歌词页普通模式 300 足够；「封面在左」时封面会被放大到半屏，
   * 必须向宿主要大图（宿主 width>600 会改向上游请求高分辨率封面，否则就是三百像素拉大）。
   */
  private coverRequestWidth(): number {
    if (document.documentElement.classList.contains('is-bg-lyrics-scene')) return 300;
    // 「封面在左」的封面层现在铺满整宽（右侧用 mask 渐隐），所以按整窗宽度要大图。
    return effectiveBgLyricsCoverStyle() === 'cover' ? Math.min(2048, Math.max(900, Math.round(window.innerWidth))) : 300;
  }

  private refreshCoverResolution(): void {
    const track = this.state?.track ?? null;
    if (!track || this.disposed) return;
    const src = onlineArtwork(track, this.coverRequestWidth());
    if (this.coverEl.getAttribute('src') !== src) {
      this.coverEl.src = src;
    }
    const blurImage = src ? `url("${src}")` : '';
    if (this.coverBlurEl.style.backgroundImage !== blurImage) {
      this.coverBlurEl.style.backgroundImage = blurImage;
    }
  }

  /**
   * 歌词字号设置：样式表已经按 `:root[data-lyrics-size]` 定义 --lyric-line-size，
   * 这里只负责在档位变化时作废行度量并重测（字号变了行高/偏移就变了）。
   */
  private applyLyricsSizeSetting(): void {
    const size = getSettings().appearance.lyricsSize;
    if (size === this.lyricsSizeApplied) return;
    this.lyricsSizeApplied = size;
    this.lineMetrics = [];
    // 字号变化会改行高：立即重测一次，避免后续每帧回落实读 offsetTop。
    this.measureLines();
  }

  /** 缓存每一行的相对偏移与高度；渲染/字号变化/窗口尺寸变化后各测一次。 */
  private measureLines(): void {
    if (this.disposed || this.lineEls.length === 0) {
      this.lineMetrics = [];
      return;
    }
    this.lineMetrics = this.lineEls.map((el) => ({ top: el.offsetTop, height: el.offsetHeight }));
  }

  /** 取某行的偏移/高度：缓存缺失或高度为 0（行被隐藏）时回落实读，保证不会被顶到错误位置。 */
  private metricOf(index: number, el: HTMLElement | undefined): { top: number; height: number } {
    if (el) this.lineMetrics[index] = { top: el.offsetTop, height: el.offsetHeight };
    const cached = this.lineMetrics[index];
    if (cached && cached.height > 0) return cached;
    return el ? { top: el.offsetTop, height: el.offsetHeight } : { top: 0, height: 0 };
  }

  /** 关闭效果下背景图案亮度：写到歌词视图，CSS 用它乘到封面/壁纸的 brightness 上。 */
  private applyBgBrightness(): void {
    if (this.disposed) return;
    const value = String(bgLyricsBrightness() / 100);
    this.root.style.setProperty('--lyrics-bg-brightness', value);
    // 自定义页面背景在 .app 外层，借同一个变量在歌词打开时一起压暗/提亮。
    document.documentElement.style.setProperty('--lyrics-bg-brightness', value);
  }

  /** 封面模糊强度（和桌面背景歌词共用设置）：只改 root 上的 CSS 变量与开关类。 */
  private applyCoverBlurStyle(): void {
    if (this.disposed) return;
    if (lumiereEffectOn()) {
      this.root.classList.remove('is-cover-blur');
      return;
    }
    const level = bgLyricsBlurLevel();
    this.root.style.setProperty('--cover-blur', `${BG_BLUR_PX[level]}px`);
    this.root.classList.toggle('is-cover-blur', level !== 'off');
  }

  /**
   * 「封面在左」：只影响播放效果为「关闭」的 DOM 歌词（纯字/房间/唱片有画布，CSS 里有 :not(.is-lumiere) 门槛）。
   * 背景场景自己用 `is-bg-cover-left` + `.bg-cover-left` 层，这里只处理软件内歌词页。
   */
  applyCoverStyle(): void {
    if (this.disposed) return;
    if (document.documentElement.classList.contains('is-bg-lyrics-scene')) return;
    const wantCover = effectiveBgLyricsCoverStyle() === 'cover';
    if (!this.coverStyleInitialized) {
      this.root.classList.toggle('is-cover-left', wantCover);
      this.coverStyleInitialized = true;
      this.applyCoverBlurStyle();
      this.refreshCoverResolution();
      return;
    }
    if (this.root.classList.contains('is-cover-left') === wantCover) return;
    // 纯壁纸 ⇄ 封面在左：先把歌词压暗，再换布局，最后淡回（封面图本身由 CSS 过渡）。
    this.root.classList.add('is-cover-switching');
    window.clearTimeout(this.coverSwitchTimer);
    window.setTimeout(() => {
      if (this.disposed) return;
      this.root.classList.toggle('is-cover-left', wantCover);
      this.applyCoverBlurStyle();
      this.refreshCoverResolution();
      this.coverSwitchTimer = window.setTimeout(() => this.root.classList.remove('is-cover-switching'), 340);
    }, 160);
  }

  /** 应用「未播放歌词颜色」：写到歌词视图上，空串恢复主题语义色（关闭效果下生效）。 */
  applyLyricUnsungColor(): void {
    if (this.disposed) return;
    const root = this.root;
    const custom = lyricUnsungColor();
    const keys = [
      '--lyric-dim',
      '--lyric-near',
      '--lyric-char',
      '--lyric-char-active',
      '--lyric-unsung',
      '--lyric-unsung-near',
      '--lyric-unsung-char',
    ];
    if (!custom) {
      for (const key of keys) root.style.removeProperty(key);
      return;
    }
    const dark = document.documentElement.dataset.theme === 'dark';
    // 语义令牌（译文 / 未唱字）沿用主题默认透明度；正在播放行的字与行色保持完全不透明。
    const tone = dark
      ? [0.42, 0.64, 0.46, 1, 0.84, 0.9, 1]
      : [0.62, 0.8, 0.66, 1, 0.84, 0.9, 1];
    keys.forEach((key, index) => root.style.setProperty(key, unsungTone(custom, tone[index])));
  }

  /** 应用播放效果（纯字 / 房间）：切换舞台模式、开关渲染循环、同步歌词文档。 */
  applyLumiereMode(): void {
    if (this.disposed) return;
    this.stageObserver?.disconnect();
    this.stageObserver = null;
    if (this.stagePaintTimer) {
      window.clearTimeout(this.stagePaintTimer);
      this.stagePaintTimer = 0;
    }
    const mode = lumiereMode();
    const textOn = mode === 'text';
    const roomOn = mode === 'room';
    const vinylOn = mode === 'vinyl';
    const flowOn = (mode === 'flow' || mode === 'overlap' || mode === 'wenflash');
    const poemOn = mode === 'poem';
    const pressureOn = mode === 'pressure';
    const anyOn = textOn || roomOn || vinylOn || flowOn || poemOn || pressureOn;
    // 纯字 / 房间 / 唱片都由 canvas 画歌词，DOM 歌词与封面栏让位；什么时候藏由 CSS 的 is-painted 门槛决定，
    // 画布还没出像时默认歌词页仍然可见，不会闪灰。
    if (anyOn && !this.lumiereText) {
      this.lumiereText = createLumiereStage({ textOnly: true });
      this.roomStage = createRoomStage();
      this.vinylStage = createVinylStage();
      this.flowStage = createFlowStage();
      this.poemStage = createPoemStage();
      this.pressureStage = createPressureStage();
      this.bgEl.nextElementSibling?.after(
      this.lumiereText.root,
      this.roomStage.root,
      this.vinylStage.root,
      this.flowStage.root,
      this.poemStage.root,
      this.pressureStage.root,
      );
      this.lumiereSongDoc = null;
      this.applyLumiereTheme();
    }
    this.root.classList.toggle('is-lumiere', anyOn);
    this.root.classList.toggle('is-lumiere-text', anyOn);
    this.root.classList.toggle('is-lumiere-pure', textOn);
    this.root.classList.toggle('is-room', roomOn);
    this.root.classList.toggle('is-vinyl', vinylOn);
    this.root.classList.toggle('is-flow', flowOn);
    // 重合单独一个类：壁纸在背后时它要保留纸底（不能走 screen 混合，否则纸和字一起被滤掉）。
    this.root.classList.toggle('is-overlap', mode === 'overlap' || mode === 'wenflash');
    this.root.classList.toggle('is-poem', poemOn);
    this.root.classList.toggle('is-pressure', pressureOn);
    // 进页暗场里那句「… · 准备中」按当前播放效果写：canvas 舞台全走 is-lumiere-text，
    // 固定写「纯字」会让重合 / 拼合也显示成纯字。CSS 里用 attr() 读这个属性。
    const stageLabel =
      mode === 'wenflash' ? '文闪' : mode === 'overlap' ? '重合'
      : mode === 'flow' ? '拼合'
      : mode === 'text' ? '纯字'
      : mode === 'room' ? '房间'
      : mode === 'vinyl' ? '唱片'
      : '歌词';
    this.root.dataset.lumiereHint = anyOn ? `${stageLabel} · 准备中` : '';
    // 播放效果开启/关闭会改变「封面在左」是否生效，切完模式立即重算一次。
    if (this.coverEl) {
      this.applyCoverStyle();
      this.applyCoverBlurStyle();
    }
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
    const vinyl = this.vinylStage;
    if (vinyl) {
      vinyl.setMode(vinylOn ? 'vinyl' : 'off');
      if (vinylOn) vinyl.activate();
      else vinyl.deactivate();
    }
    // 刚进歌词页时先别露默认封面：等画布第一次出像再撤 is-lumiere-fresh（进页那一瞬是暗场 + 加载提示）。
    const flow = this.flowStage;
    if (flow) {
      flow.setMode(flowOn ? mode : 'off');
      if (flowOn) flow.activate();
      else flow.deactivate();
    }
    const poem = this.poemStage;
    if (poemOn) poem?.activate();
    else poem?.deactivate();
    const pressure = this.pressureStage;
    if (pressureOn) pressure?.activate();
    else pressure?.deactivate();
    const stageRoot = pressureOn ? pressure?.root : poemOn ? poem?.root : flowOn ? flow?.root : roomOn ? room?.root : vinylOn ? vinyl?.root : stage?.root;
    const painted = stageRoot ? stageRoot.classList.contains('is-painted') : false;
    const failed = stageRoot ? stageRoot.classList.contains('is-failed') : false;
    if (anyOn && stageRoot && !painted && !failed) {
      this.root.classList.add('is-lumiere-fresh');
      this.watchStagePaint(stageRoot);
    } else {
      this.root.classList.remove('is-lumiere-fresh');
    }
    if (anyOn) this.syncLumiereSong();
    else this.restoreDomLyrics();
  }

  /** Restore measurable DOM before positioning: content-visibility invalidates cached geometry. */
  private restoreDomLyrics(): void {
    this.covered = false;
    this.coverStart = 0;
    this.root.classList.remove('is-covered', 'is-lumiere-fresh');
    window.clearTimeout(this.manualTimer);
    window.cancelAnimationFrame(this.manualRaf);
    this.manualRaf = 0;
    this.manualUntil = this.manualShift = this.manualTarget = 0;
    this.lineMetrics = [];
    this.charStateLine = -1;
    this.charStateCache = [];
    this.measureLines();
    this.syncProgress(true);
    this.applyOffset(false);
  }

  /** 应用默认歌词页的播放样式；切换后立即生效、不重载歌词（动画定义全在 app.css 的 lyric-style-* 段）。 */
  private applyLyricStyle(): void {
    if (this.disposed) return;
    // 播放样式会改变字号/行高/字距，行缓存先作废，syncProgress 会回落实读并等下次重测。
    this.lineMetrics = [];
    const style = lyricStyle();
    for (const item of LYRIC_STYLES) this.root.classList.remove(`lyric-style-${item.id}`);
    this.root.classList.add(`lyric-style-${style}`);
    // 样式切换会改行高，重测后再按新布局居中，别让自动滚动停在上一个样式的偏移上。
    this.measureLines();
    // 需要逐字时机的样式（上浮/摇曳/打字机）切过来后立刻补算当前句的逐字状态，不等下一帧。
    if (this.state) this.syncProgress();
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
        return;
      }
      // 已经出像、但 is-covered 迟迟没挂上（画布在播、DOM 歌词早已淡出）时别把
      // 「准备中」留在屏幕上等 6 秒兜底：给淡出 320ms，然后就撤。
      if (stageRoot.classList.contains('is-painted') && !this.stagePaintTimer) {
        this.stagePaintTimer = window.setTimeout(() => {
          this.stagePaintTimer = 0;
          if (this.stageObserver !== observer) return;
          observer.disconnect();
          this.stageObserver = null;
          this.root.classList.remove('is-lumiere-fresh');
        }, 320);
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
      coverUrl: track ? onlineArtwork(track, 300) : '',
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
    lumiereThemeNow = lumiereThemeForCover(this.bgMode, this.palette, this.doc.lines.map((line) => line.text).join(' '));
    lumierePaletteNow = this.palette ? [...this.palette] : null;
    this.lumiereText?.setTheme(lumiereThemeNow, lumierePaletteNow);
    {perfEvent('lyrics.theme.flow');const startedAt=perfOn()?performance.now():0;this.flowStage?.setTheme(lumiereThemeNow);if(startedAt)perfMark('lyrics.theme.flow',startedAt);}
  }

  /** 「歌词字体」变了：主题、房间/唱片布局与两张画布效果都按新字面刷新。 */
  refreshLyricFont(): void {
    applyLyricFontVar();
    this.applyLumiereTheme();
    applyRoomStyleSettings();
    applyVinylStyleSettings();
    this.poemStage?.refreshFont();
    this.pressureStage?.refreshFont();
  }

  /** 把当前歌词文档交给播放效果舞台（整首歌词）。 */
  private syncLumiereSong(): void {
    const track = this.state?.track ?? null;
    const key = this.doc.trackKey || trackKeyOf(track);
    const duration = this.state?.durationMs || track?.durationMs || 0;
    const offset = lyricOffsetOf(key);
    // onPlayer 在背景场景是 100ms 一次：曲目/歌词/时长都没变就不必重编译整首歌。
    if (key === this.lumiereSongKey && this.doc === this.lumiereSongDoc && duration === this.lumiereSongDuration && offset === this.lumiereSongOffset) {
      return;
    }
    this.lumiereSongKey = key;
    this.lumiereSongOffset = offset;
    this.lumiereSongDoc = this.doc;
    this.lumiereSongDuration = duration;
    const input = this.buildLumiereSong();
    this.lumiereText?.setSong(input);
    this.roomStage?.setSong(input);
    this.vinylStage?.setSong(input);
    {perfEvent('lyrics.song.flow');const startedAt=perfOn()?performance.now():0;this.flowStage?.setSong(input);if(startedAt)perfMark('lyrics.song.flow',startedAt);}
    this.poemStage?.setSong(input);
    this.pressureStage?.setSong(input);
  }


  /** 按模式给歌词文字上色：纯色=主题色，封面色=封面主色，自动渐变=色板逐字渐变。 */
  private async applyTextTint(): Promise<void> {
    const token = ++this.bgToken;
    const flowTrack = this.state?.track ?? null;
    void coverColorsOf(flowTrack).then(colors => {
      if (!this.disposed && token === this.bgToken) {
        const palette = (colors ?? fallbackColors(`${flowTrack?.title ?? ""}|${flowTrack?.artist ?? ""}`)).palette;
        {perfEvent('lyrics.palette.flow');const startedAt=perfOn()?performance.now():0;this.flowStage?.setPalette(palette);if(startedAt)perfMark('lyrics.palette.flow',startedAt);}
        this.poemStage?.setPalette(palette);
      }
    }).catch(() => {});
    const mode = this.bgMode;
    if (mode === 'solid') {
      const solid = lyricSolidColor();
      this.palette = solid
        ? [solid, this.mixColor(solid, '#ffffff', 0.18), this.mixColor(solid, '#ffffff', 0.34)]
        : null;
      this.applyLumiereTheme();
      this.paintActiveLineTint();
      this.colorKey = '';
      this.paintLyricColors(Math.max(0, this.activeIndex));
      return;
    }
    const track = this.state?.track ?? null;
    const colors = (await coverColorsOf(track)) ?? fallbackColors(`${track?.title ?? ''}|${track?.artist ?? ''}`);
    if (this.disposed || token !== this.bgToken || mode !== this.bgMode) return;
    this.palette = colors.palette;
    this.applyLumiereTheme();
    this.paintActiveLineTint();
    this.colorKey = '';
    this.paintLyricColors(Math.max(0, this.activeIndex));
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
  /** 暗场提亮：保留色相，把过暗的十六进制颜色往白色里混，避免滚动歌词看不见。 */
  private browseTint(color: string): string {
    const text = color.trim();
    if (!text.startsWith('#') || text.length !== 7) return color;
    const r = parseInt(text.slice(1, 3), 16);
    const g = parseInt(text.slice(3, 5), 16);
    const b = parseInt(text.slice(5, 7), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (lum >= 0.62) return color;
    // 只把过暗的颜色抬到可读亮度（L≈0.62），保留色相与饱和度，不把用户选的颜色洗成白色。
    const ratio = Math.round(Math.max(6, Math.min(92, ((1 - 0.62) / (1 - lum)) * 100)));
    return `color-mix(in oklch, ${color} ${ratio}%, white)`;
  }

  /** 去掉颜色里的 alpha（rgb(r g b / a) / rgba(...) / #rrggbbaa），保留色相。 */
  private opaqueColor(color: string): string {
    const text = color.trim();
    const slash = text.match(/^rgb\(([^)]+)\)$/i);
    if (slash) {
      const body = slash[1].split('/')[0].trim();
      const parts = body.split(/[\s,]+/).filter(Boolean).slice(0, 3);
      if (parts.length === 3) return `rgb(${parts.join(' ')})`;
    }
    const rgba = text.match(/^rgba\(([^)]+)\)$/i);
    if (rgba) {
      const parts = rgba[1].split(/[\s,]+/).filter(Boolean).slice(0, 3);
      if (parts.length === 3) return `rgb(${parts.join(' ')})`;
    }
    if (/^#[0-9a-f]{8}$/i.test(text)) return text.slice(0, 7);
    return text;
  }

  /** 浏览态把过暗的颜色抬到可读亮度（保留色相）——歌词舞台始终是暗底。 */
  private ensureReadable(color: string): string {
    return this.browseTint(color);
  }

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

  /** 自定义「纯色」歌词颜色变了：按当前档位重算调色板并重涂当前行。 */
  applyLyricSolidColor(): void {
    if (this.disposed) return;
    void this.applyTextTint();
    this.paintActiveLineTint();
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
    // 「纯色」档且用户指定了颜色：尊重用户选择，不再压暗成墨色。
    if (this.bgMode === 'solid' && lyricSolidColor()) {
      activeEl.style.setProperty('--lyric-bar-a', first);
      activeEl.style.setProperty('--lyric-bar-b', first);
      activeEl.style.setProperty('--lyric-bar-c', first);
      activeEl.style.setProperty('--lyric-hot', first);
      activeEl.style.setProperty('--lyric-line', first);
      activeEl.style.setProperty('--lyric-glow', `0 0 16px ${this.mixColor(first, '#ffffff', 0.3)}`);
      for (const span of this.charEls[this.activeIndex] ?? []) {
        if (span.classList.contains('is-hot')) {
          span.style.setProperty('--lyric-hot', first);
          span.style.setProperty('--lyric-glow', `0 0 16px ${this.mixColor(first, '#ffffff', 0.3)}`);
          span.style.removeProperty('--lyric-sung');
          continue;
        }
        span.style.removeProperty('--lyric-hot');
        span.style.removeProperty('--lyric-glow');
        if (span.classList.contains('is-sung')) span.style.setProperty('--lyric-sung', first);
        else span.style.removeProperty('--lyric-sung');
      }
      return;
    }
    // 自动渐变模式：行底色与竖条颜色由 paintGradientFlow 独占写入。
    // 两个写者交替覆盖同一批变量，会让横线/竖条颜色每隔一帧跳一次（用户看到的闪烁）。
    if (this.bgMode === 'gradient') return;
    // 左侧竖条跟随歌词颜色：封面色用主色
    activeEl.style.setProperty('--lyric-bar-a', first);
    activeEl.style.setProperty('--lyric-bar-b', first);
    activeEl.style.setProperty('--lyric-bar-c', first);
    const hotBase = first;
    // 文字用色要先压暗，否则浅色封面上「亮色」歌词会糊成灰白
    const hotColor = this.readableTint(this.mixColor(hotBase, '#ffffff', 0.34));
    const spans = this.charEls[this.activeIndex] ?? [];
    const glow = `0 0 18px ${this.mixColor(hotColor, second, 0.45)}, 0 0 10px ${this.mixColor(hotColor, '#1b1b1b', 0.35)}`;
    activeEl.style.setProperty('--lyric-hot', hotColor);
    activeEl.style.setProperty('--lyric-glow', glow);
    activeEl.style.setProperty('--lyric-line', hotColor);
    spans.forEach((span) => {
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
        span.style.setProperty('--lyric-sung', this.readableTint(first));
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
  }


  /** 旧歌名做一层 ghost，让切歌看起来是「旧的滑出、新的推入」；封面由 swapCoverWithFade 单独处理。 */
  private spawnMetaGhost(): void {
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
    if (externalLyricMode) {
      // 背景场景不拉歌：等主窗口把文档写进快照后由 applyExternalDoc 送进来。
      this.render();
      return;
    }
    const token = ++this.loadToken;
    const cached = lastDoc?.trackKey === trackKeyOf(track) && lastDoc.lines.length ? lastDoc : null;
    const doc = await (cached ?? loadLyricDoc(track));
    if (this.disposed || token !== this.loadToken) return;
    this.doc = doc;
    lastDoc = doc;
    this.render();
    this.applyLumiereTheme();
    if (track && !cached) startLyricMatch(track, doc);
  }

  /** 背景场景：直接应用外部（共享快照）送来的歌词文档。 */
  applyExternalDoc(doc: LyricDoc | null): void {
    if (this.disposed) return;
    this.doc = doc ?? EMPTY;
    lastDoc = doc ?? null;
    this.render();
    this.applyLumiereTheme();
  }

  /** 背景场景：另一窗口改了共享设置（样式/背景/偏移）后重新取本地设置并重绘。 */
  refreshSharedStyle(): void {
    if (this.disposed) return;
    // 背景窗口的模块变量只在加载时读过一次；跨窗口 storage 事件后必须先重读本地存储，
    // 否则下面几个 apply* 读到的仍是旧值（典型：改了播放样式/纯色/偏移，背景歌词不跟）。
    reloadSharedLyricSettings();
    this.bgMode = lyricsBgMode;
    void this.applyTextTint();
    this.applyLumiereMode();
    this.applyLyricStyle();
    this.applyLyricUnsungColor();
    this.applyLyricsSizeSetting();
    this.render();
    this.applyLyricSolidColor();
    // 「文字设置」也是导入时读一次：背景窗口在运行时改字号/字重也要重放一遍调参。
    this.applyLumiereTextSettings();
  }

  private buildLineWords(line: LyricLine, lineEl: HTMLElement, chars: HTMLSpanElement[]): void {
    const fragment = document.createDocumentFragment();
    // 逐字数据优先；没有逐字数据的行（普通 LRC 的非 CJK 行）按「CJK 单字 / 外文词」切成可动 span，
    // 让上浮/波浪/摇曳/打字机/旋入这些播放动画整首歌都有落点。--ci 是字在句内的序号，CSS 用它错开动画相位；
    // --drift-x / --drift-y / --drift-rot / --drift-dur 是每个字稳定的随机「飘入」偏移（旋入用，随机方向飘回来组成句子）。
    const tokens: Array<{ text: string; spaceBefore: boolean }> = line.words.length > 0
      ? line.words.map((word) => ({ text: word.text, spaceBefore: word.spaceBefore === true }))
      : splitPlainTokens(line.text);
    tokens.forEach((token, index) => {
      const gap = index > 0 && token.spaceBefore;
      const lang = lyricLangOf(token.text);
      const span = h('span', {
        class: gap ? 'lyric-char has-gap' : 'lyric-char',
        text: token.text,
        'data-lang': lang || undefined,
        'data-c': token.text,
      });
      const hash = scatterHash(line.text, index);
      // 一次写完整条 style：setProperty 连写 5 次会让每个字触发 5 次样式失效，
      // 452 个字就是 2000+ 次；合并成一条字符串只走一次解析。
      span.setAttribute(
        'style',
        `--ci:${index};--drift-x:${(scatterRandom(hash, 0) * 3.2 - 1.6).toFixed(2)}em;`
          + `--drift-y:${(scatterRandom(hash, 1) * 2.2 - 1.1).toFixed(2)}em;`
          + `--drift-rot:${(scatterRandom(hash, 2) * 60 - 30).toFixed(1)}deg;`
          + `--drift-dur:${(0.5 + scatterRandom(hash, 3) * 0.35).toFixed(2)}s`,
      );
      chars.push(span);
      fragment.append(span);
    });
    if (tokens.length === 0) fragment.append(line.text || ' ');
    if (lineEl.firstChild?.nodeType === Node.TEXT_NODE) lineEl.firstChild.replaceWith(fragment);
    else lineEl.prepend(fragment);
  }

  private lineVisibility?: IntersectionObserver;

  private render(): void {
    const renderAt=perfOn()?performance.now():0;
    this.lineVisibility?.disconnect();
    this.lineVisibility ??= new IntersectionObserver(entries => {
      for (const entry of entries) {
        (entry.target as HTMLElement).style.visibility = entry.isIntersecting ? '' : 'hidden';
      }
    }, { root: this.rightEl, rootMargin: '180px 0px' });
    this.linesEl.textContent = '';
    this.lineEls = [];
    this.colorKey = '';
    this.charEls = [];
    this.lineMetrics = [];
    this.charStateLine = -1;
    this.charStateCache = [];
    this.activeIndex = -1;
    this.bgOffsetSnapped = false;
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
    if (this.doc.lines.length === 0) {
      this.updateTranslationBar('');
      return;
    }

    // 整首歌一次性建到 DocumentFragment 里再挂上去：原来每 append 一行都让浏览器重排一次，
    // 84 行 × 逐字 span 的歌曲在切歌时会掉一帧（用户感觉「卡一下」）。
    const frag = document.createDocumentFragment();
    const initialIndex = activeIndexOf(this.doc.lines, (this.state?.positionMs ?? 0) + lyricOffsetOf(this.doc.trackKey));
    for (const line of this.doc.lines) {
      const lineEl = h('div', { class: 'lyric-line' });
      if (Math.abs(this.lineEls.length - initialIndex) > 6) lineEl.style.visibility = 'hidden';
      const chars: HTMLSpanElement[] = [];
      if (Math.abs(this.lineEls.length - initialIndex) <= 3) {
        this.buildLineWords(line, lineEl, chars);
      } else {
        lineEl.append(document.createTextNode(line.text || ' '));
      }
      // 手动滚轮浏览歌词时，行首会显示这句的播放时间（见 .lyrics-view.is-manual）。
      // 放在行内绝对定位，跟着行一起滚，不需要额外同步位移。
      lineEl.append(h('span', { class: 'lyric-time', text: clockText(line.timeMs) }));
      if (line.translation) {
        const transEl = h('span', { class: 'lyric-trans' });
        for (const run of splitLangRuns(line.translation)) {
          transEl.append(h('span', { class: 'lyric-trans-run', text: run.text, 'data-lang': run.lang || undefined }));
        }
        lineEl.append(transEl);
      }
      this.lineEls.push(lineEl);
      this.charEls.push(chars);
      frag.append(lineEl);
      this.lineVisibility.observe(lineEl);
    }
    this.linesEl.append(frag);
    this.measureLines();
    this.syncProgress(true);
    if(renderAt)perfMark('lyrics.render',renderAt,{lines:this.doc.lines.length});
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
    // 进度条每帧都在动：宽度变化不足 0.2% 时不写 DOM，避免 60 次/秒的样式失效
    // （整页重排时这一帧的开销会叠加到切歌卡顿上）。时间文本同理，秒变了才写。
    if (force || Math.abs(percent - this.progressPercent) >= 0.2) {
      this.progressPercent = percent;
      this.progressFill.style.width = `${percent}%`;
    }
    if (force || Math.floor(state.positionMs / 1000) !== Math.floor(this.progressPosMs / 1000)) {
      this.progressPosMs = state.positionMs;
      this.progressCur.textContent = fmtTime(state.positionMs);
    }
    if (force || duration !== this.progressDurMs) {
      this.progressDurMs = duration;
      this.progressDur.textContent = fmtTime(duration);
    }
    if (this.doc.lines.length === 0) return;
    const lyricPos = state.positionMs + lyricOffsetOf(this.lastTrackKey);
    const nextIndex = activeIndexOf(this.doc.lines, lyricPos);
    if (nextIndex !== this.activeIndex || force) {
      for (let i = Math.max(0, nextIndex - 1); i <= Math.min(this.doc.lines.length - 1, nextIndex + 2); i++) {
        const el = this.lineEls[i];
        if (el?.firstChild?.nodeType === Node.TEXT_NODE && this.charEls[i]?.length === 0) {
          this.buildLineWords(this.doc.lines[i], el, this.charEls[i]);
        }
      }
      const prev = this.activeIndex;
      const changed = nextIndex !== this.activeIndex;
      this.activeIndex = nextIndex;
      if (changed) this.growStartAt = performance.now();
      if (changed) this.lumiereText?.pulse();
      if (changed && prev >= 0) {
        this.lineEls[prev]?.classList.remove('is-active', 'is-near');
        // 上一行被放大过：把行内字号还原，否则它会永远停在放大后的字号上。
        this.resetGrowStyle(this.lineEls[prev]);
        // 上一行唱完后必须清掉逐字状态，否则最后一个字的 is-hot 会一直亮着
        this.charEls[prev]?.forEach((span) => span.classList.remove('is-sung', 'is-hot'));
      }
      // 换行后逐字状态缓存属于上一行，直接作废。
      this.charStateLine = -1;
      this.charStateCache = [];
      this.lineEls.forEach((el, index) => {
        el.classList.toggle('is-active', index === nextIndex);
        el.classList.toggle('is-near', index === nextIndex - 1 || index === nextIndex + 1);
        // 离当前行的行数：CSS 靠它做「越远越模糊」（默认歌词的景深）。
        el.style.setProperty('--d', String(Math.abs(index - nextIndex)));
      });
      this.applyFade();
      // 换行即重算放大余量：这一行的字宽是新的，默认 0.207 很可能让它冲出右缘被裁。
      this.applyLineEmphasisCap(nextIndex);
      const activeEl = this.lineEls[nextIndex];
      if (activeEl) {
        activeEl.style.setProperty('--p', '0');
        // 起句从基准字号重新长：先还原上一轮放大过的行内字号，把这一行钉成布局根，
        // 再按曲线第一帧写一次。钉根必须在写字号之前（这时量的才是自然版面宽度）。
        if (changed) {
          this.resetGrowStyle(activeEl);
          this.pinGrowBox(activeEl);
          this.applyGrowFrame(activeEl, 0);
        }
        // .lyrics-lines 自身就是 offsetParent（position:absolute），行内偏移来自渲染后缓存；
        // 缓存缺失（例如刚切字号还没重测）才回落实读。
        const metric = this.metricOf(nextIndex, activeEl);
        this.autoOffset = -(metric.top + metric.height / 2);
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
    // 译文条内部要 getBoundingClientRect + checkVisibility（强制布局），不能每帧都问：
    // 换行时必查，其余情况最多每 300ms 复查一次（滚动后译文行可能露出来）。
    const transNow = performance.now();
    if (this.activeIndex !== this.transCheckIndex || transNow - this.transCheckAt > 300 || force) {
      this.transCheckIndex = this.activeIndex;
      this.transCheckAt = transNow;
      this.updateTranslationBar(activeLine?.translation ?? '');
    }
    // 当前行的演唱进度（0~1），驱动行下方的金色进度线
    // 播放结束（或停在最后一帧）时，未唱到的字不能继续停在散开/半透明的中间态：
    // 旋入等样式靠逐字状态归位，而音频结束后不会再有下一个字被唱到，画面会永久歪着。
    // 这里只负责收尾归位，不改逐字配色——颜色仍按实际演唱进度保留。
    const ended = duration > 0 && state.positionMs >= duration - 200;
    this.root.classList.toggle('is-lyric-ended', ended);
    const activeEl = this.lineEls[this.activeIndex];
    if (activeEl && activeLine) {
      const spanMs = Math.max(240, activeLine.durationMs || 2600);
      const ratio = Math.min(1, Math.max(0, (lyricPos - activeLine.timeMs) / spanMs));
      const progress = ended ? '1' : ratio.toFixed(3);
      if (activeEl.style.getPropertyValue('--p') !== progress) activeEl.style.setProperty('--p', progress);
      // 当前行的放大系数：起句快速弹入，冲过最大字号一点再平滑回落；
      // 计时用真实时间，跟播放进度的 40ms 跳变解耦，动起来是顺的。
      // 播放已结束时直接落到 1，避免停在收尾的缩放中间帧上。
      const grow = ended ? 1 : growAt(performance.now() - this.growStartAt);
      // 抖动根因：growAt 是弹簧，尾部会以 1e-3 量级一直微调，而 --grow 每帧都写进
      // transform 的 scale —— 整行文字就按「分数像素」的比例反复重采样，看起来是
      // 持续的字形抖动（弹出结束后仍然抖）。这里做量化：变化小于 0.004 就不重写，
      // 让缩放尽早定死在一个值上；重启起句时 growStartAt 会重置，不影响动画本身。
      const quantized = Math.round(grow * 250) / 250;
      if (quantized !== this.lastGrowWritten) {
        // 放大只改字号：transform/scale 会把文字画进缩放表面，起句途中和落定之后都发虚。
        this.applyGrowFrame(activeEl, quantized);
        this.lastGrowWritten = quantized;
      }

      if (this.bgMode === 'gradient') this.paintGradientFlow(performance.now());
    }
    if (activeLine && activeLine.words.length > 0) {
      const states = charStates(activeLine, lyricPos);
      const spans = this.charEls[this.activeIndex] ?? [];
      // 同一行内状态大多不变：只 toggle 与上一帧不同的 span，避免每帧重写整行 class。
      const cachePrev = this.charStateLine === this.activeIndex ? this.charStateCache : [];
      const count = Math.max(states.length, cachePrev.length);
      const nextStates: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const value = states[i] ?? 0;
        nextStates[i] = value;
        if (cachePrev[i] === value) continue;
        const span = spans[i];
        if (!span) continue;
        span.classList.toggle('is-sung', value >= 1);
        span.classList.toggle('is-hot', value === 2);
      }
      // 苹果样式是独立界面，逐字由它自己的 ::before 遮罩画，这里不需要再写 --kf。
      this.charStateLine = this.activeIndex;
      this.charStateCache = nextStates;
    } else if (activeLine) {
      // 没有逐字数据的歌词行：只有「上浮/摇曳/打字机」这类需要逐字时机的样式才合成逐字状态
      // （按句内进度均匀铺开），普通 LRC 也能跟着演唱逐字动；其它样式保持经典式的整行状态。
      this.charStateLine = -1;
      this.charStateCache = [];
      this.syncPlainCharStates(activeLine, lyricPos);
    }
    // 逐字配色只影响样式：换行时立即刷，其余时候限到 ~15fps（长歌词一行几百个 span）。
    const now = performance.now();
    if (this.activeIndex !== this.tintedIndex || now - this.tintPaintAt >= 66) {
      this.tintPaintAt = now;
      this.paintActiveLineTint();
    }
  }

  /**
   * 苹果样式的逐字刷亮：每字写一个 --kf（0–100），CSS 用水平渐变遮罩把「亮层」裁到该位置，
   * 于是正在唱的字由左到右被刷亮，唱过的保持全亮、没唱的留在暗层。
   * 只写一行、只写变化的字，量化到 0.5 避免每帧重排。
   */
  private syncPlainCharStates(line: LyricLine, lyricPos: number): void {
    const spans = this.charEls[this.activeIndex] ?? [];
    if (spans.length === 0) return;
    if (!lyricStyleNeedsCharTiming()) {
      for (const span of spans) span.classList.remove('is-sung', 'is-hot');
      return;
    }
    const spanMs = Math.max(400, line.durationMs || 2600);
    const ratio = Math.min(1, Math.max(0, (lyricPos - line.timeMs) / spanMs));
    const sung = ratio * spans.length;
    spans.forEach((span, index) => {
      const state = sung >= index + 1 ? 1 : sung > index ? 2 : 0;
      span.classList.toggle('is-sung', state >= 1);
      span.classList.toggle('is-hot', state === 2);
    });
  }

  /** 切换动效档位后，让当前行立刻按新曲线重播一次（快捷设置里能直接看到效果）。 */
  replayGrow(): void {
    if (this.disposed || this.activeIndex < 0) return;
    // 档位变了峰值也变了，先按新曲线重算放大余量再重播。
    this.applyLineEmphasisCap(this.activeIndex);
    this.growStartAt = performance.now();
    this.lastGrowWritten = -1;
    this.lineBaseMetrics = new WeakMap();
    this.growRows = new WeakMap();
    const el = this.lineEls[this.activeIndex];
    this.resetGrowStyle(el);
    this.pinGrowBox(el);
    this.applyGrowFrame(el, 0);
  }

  /** 画布接管后是否已经把 DOM 歌词整棵停渲染（延迟到淡出结束，避免切换时闪一下）。 */
  private covered = false;
  private domLayoutObserver: ResizeObserver | null = null;
  private coverStart = 0;

  /** 播放效果画布已经接管画面（出像之后）：DOM 歌词整棵是透明的，没必要再逐帧刷它。 */
  private lumiereCoversLyrics(): boolean {
    const mode = lumiereMode();
    if (mode === 'off') return false;
    const stage = mode === 'pressure' ? this.pressureStage : mode === 'poem' ? this.poemStage : (mode === 'flow' || mode === 'overlap' || mode === 'wenflash') ? this.flowStage : mode === 'room' ? this.roomStage : mode === 'vinyl' ? this.vinylStage : this.lumiereText;
    if (!stage) return false;
    const classes = stage.root.classList;
    return classes.contains('is-on') && classes.contains('is-ready')
      && classes.contains('is-content') && classes.contains('is-painted') && !classes.contains('is-failed');
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
          this.restoreDomLyrics();
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
  private transCheckIndex = -2;
  private transCheckAt = 0;
  /** 底部译文条的 DOM 跟随定时器：只要高亮行变了就同步，不依赖 activeIndex 的内部推进。 */
  private transSyncTimer = 0;

  private progressPercent = -1;
  private progressPosMs = -1;
  private progressDurMs = -1;

  private colorKey = '';
  private paintedBase = -1;
  private gradPhase = 0;
  private gradTimer: number | null = null;

  private applyFade(): void {
    const browsing = this.browsing();
    const base = this.activeIndex >= 0 ? this.activeIndex : 0;
    this.linesEl.classList.toggle('is-browsing', browsing);

    // 几何与节奏：只写 --fade / --scatter，不碰颜色。
    this.lineEls.forEach((el, index) => {
      const distance = Math.abs(index - base);
      const fade = browsing || distance === 0 ? 1 : Math.max(0, 1 - (distance - 1) * 0.3);
      el.style.setProperty('--fade', fade.toFixed(3));
      const scatter = browsing
        ? 0
        : index === base
          ? 0.6
          : index > base
            ? Math.min(1, 0.6 + (index - base - 1) * 0.15)
            : 0;
      el.style.setProperty('--scatter', scatter.toFixed(3));
    });

    this.paintLyricColors(base);
  }

  /**
   * 歌词文字颜色的唯一写者。
   *
   * 语义（与设置面板一致）：
   *  - 已播放的行：纯色档用「纯色颜色」；封面色/自动渐变档交还给现有色板动画
   *    （逐字 --lyric-sung 由 paintActiveLineTint / paintGradientFlow 驱动）；
   *  - 正在播放的行与待播放的行：统一「未播放颜色」。
   * 透明度只在手动浏览时强制为 1，其余交给样式表。
   */
  private paintLyricColors(base: number): void {
    const solid = this.bgMode === 'solid' ? lyricSolidColor() : '';
    const palette = this.palette;
    const sungColorFor = (index: number): string => {
      if (this.bgMode === 'solid') return solid;
      if (!palette || palette.length === 0) return '';
      const tone =
        this.bgMode === 'gradient' ? this.samplePalette((index * 0.21) % 1) : palette[0];
      return this.opaqueColor(tone);
    };
    const unsung = this.ensureReadable(
      this.opaqueColor(
        lyricUnsungColor() ||
          getComputedStyle(this.root).getPropertyValue('--lyric-unsung').trim() ||
          '#fff',
      ),
    );
    const gradKey = palette && palette.length ? palette.join(',') : '';
    const key = `${this.lineEls.length}|${this.bgMode}|${solid}|${unsung}|${gradKey}`;
    const full = key !== this.colorKey;
    if (!full && base === this.paintedBase) return;
    const first = full ? 0 : Math.min(base, this.paintedBase);
    const last = full ? this.lineEls.length - 1 : Math.max(base, this.paintedBase);
    this.colorKey = key;
    this.paintedBase = base;

    for (let index = first; index <= last; index++) {
      const el = this.lineEls[index];
      const sungLine = index < base;
      const activeLine = index === base;
      const sung = sungColorFor(index);
      const color = sungLine && sung ? this.ensureReadable(sung) : unsung;
      const gradient = activeLine && this.bgMode !== 'solid' && !!palette && palette.length > 0;
      el.classList.remove('has-lyric-gradient', 'grad-animated');
      el.style.removeProperty('--lyric-grad');
      if (gradient) {
        el.style.removeProperty('color');
      } else {
        if (color) el.style.setProperty('color', color, 'important');
        else el.style.removeProperty('color');
      }


      for (const ch of this.charEls[index] ?? []) {

        if (gradient) continue;
        if (color && sungLine) ch.style.setProperty('--lyric-sung', color);
        else ch.style.removeProperty('--lyric-sung');
        if (color) ch.style.setProperty('color', color, 'important');
        else ch.style.removeProperty('color');
      }
    }

    if (this.bgMode === 'solid' || !palette || palette.length === 0) this.stopGradientScan();
    else this.paintActiveGradient(this.bgMode === 'gradient');
  }

  /** 正在播放行的渐变：逐字按色板取色；自动渐变档再叠加持续移动的相位。 */
  private paintActiveGradient(animated: boolean): void {
    const chars = this.charEls[this.activeIndex] ?? [];
    if (chars.length === 0) return;
    if (animated) this.startGradientScan();
    else {
      this.stopGradientScan();
      this.gradPhase = 0;
    }
    const count = Math.max(1, chars.length - 1);
    chars.forEach((ch, index) => {
      const tone = this.samplePalette((index / count + this.gradPhase) % 1);
      ch.style.setProperty('color', this.ensureReadable(tone), 'important');
    });
  }

  private startGradientScan(): void {
    if (this.gradTimer !== null) return;
    this.gradTimer = window.setInterval(() => {
      if (this.disposed || this.bgMode !== 'gradient' || this.activeIndex < 0) {
        this.stopGradientScan();
        return;
      }
      this.gradPhase = (this.gradPhase + 0.02) % 1;
      this.paintActiveGradient(true);
    }, 90);
  }

  private stopGradientScan(): void {
    if (this.gradTimer !== null) {
      window.clearInterval(this.gradTimer);
      this.gradTimer = null;
    }
  }

  /**
   * 译文兜底条：当前行有译文，但当前歌词样式没把行内译文显示出来时，
   * 在播放条上方补一条，保证任何动效下都能看到翻译。
   */
  private updateTranslationBar(text: string): void {
    // 兜底同步：以 DOM 里带 is-active 的那一行为准。
    // 这套歌词有两套推进（内部 activeIndex 与 DOM 高亮类），画布/封面舞台上内部索引可能不推进，
    // 于是底部条永远停在第一次写入的句子上。这里每 250ms 直接读高亮行的行内译文，
    // 变了就刷新，和内部状态解耦。
    if (!this.transSyncTimer) {
      this.transSyncTimer = window.setInterval(() => {
        if (this.disposed) { window.clearInterval(this.transSyncTimer); this.transSyncTimer = 0; return; }
        // 画布接管后 DOM 歌词整棵停止更新（隐藏且不再刷），此时必须按播放时间从
        // 数据里取当前行的译文，不能再去读 DOM（那会永远读到停住的那一行）。
        let next = '';
        if (this.lumiereCoversLyrics() && this.state) {
          const index = activeIndexOf(this.doc.lines, this.state.positionMs + lyricOffsetOf(this.lastTrackKey));
          next = (this.doc.lines[index]?.translation ?? '').trim();
        } else {
          const line = document.querySelector('.lyric-line.is-active');
          next = (line?.querySelector('.lyric-trans')?.textContent ?? '').trim();
        }
        if (!next) {
          if (this.transBarTarget) {
            this.transBarTarget = '';
            this.transBarVisible = false;
            this.transBar.classList.add('is-empty');
            this.transBar.textContent = '';
          }
          return;
        }
        if (next === this.transBarTarget) return;
        this.transBarTarget = next;
        this.transBarVisible = true;
        this.transBar.classList.remove('is-empty');
        // 走和常规路径同一套换句动画：旧句先淡出，140ms 后换字，新句再进入。
        if (this.transBarTimer !== null) {
          window.clearTimeout(this.transBarTimer);
          this.transBarTimer = null;
        }
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          this.transBar.classList.remove('is-changing');
          this.transBar.textContent = next;
          return;
        }
        this.transBar.classList.add('is-changing');
        this.transBarTimer = window.setTimeout(() => {
          this.transBarTimer = null;
          if (this.disposed) return;
          this.transBar.textContent = this.transBarTarget;
          this.transBar.classList.remove('is-changing');
        }, 140);
      }, 250);
    }
    const value = (text ?? '').trim();
    const inline = value
      ? this.lineEls[this.activeIndex]?.querySelector('.lyric-trans') as HTMLElement | null
      : null;
    let inlineVisible = false;
    if (inline) {
      const rect = inline.getBoundingClientRect();
      const visible = typeof inline.checkVisibility === 'function'
        ? inline.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })
        : getComputedStyle(inline).display !== 'none';
      // 画布动效会把整棵 DOM 歌词淡出：此时行内译文其实看不见，改由底部条兜底。
      inlineVisible = visible && rect.height > 2 && rect.width > 2 &&
        rect.bottom > 0 && rect.top < window.innerHeight;
    }
    const show = Boolean(value && !inlineVisible);
    const target = show ? value : '';
    if (target === this.transBarTarget && show === this.transBarVisible) return;
    this.transBarTarget = target;
    if (this.transBarTimer !== null) {
      window.clearTimeout(this.transBarTimer);
      this.transBarTimer = null;
    }
    if (!show) {
      this.transBarVisible = false;
      this.transBar.classList.remove('is-changing');
      this.transBar.classList.add('is-empty');
      // 顺手把旧句清掉：这一分支以前只挂 is-empty 不清文本，一旦 inlineVisible 判定
      // 在封面/画布舞台上误判成「行内译文可见」，条上就会永远停在上一句（甚至停在
      // TME 那条版权声明上）。清空后即使判定反复摇摆，也不会显示过期译文。
      this.transBar.textContent = '';
      this.transBarTarget = '';
      return;
    }
    if (!this.transBarVisible || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.transBar.textContent = value;
      this.transBar.classList.remove('is-changing');
      this.transBar.classList.remove('is-empty');
      this.transBarVisible = true;
      return;
    }
    // 旧句先退场，待胶囊透明后替换文字，新句再进入；避免换句时文字和宽度硬跳。
    this.transBar.classList.add('is-changing');
    this.transBarTimer = window.setTimeout(() => {
      this.transBarTimer = null;
      if (this.disposed) return;
      this.transBar.textContent = this.transBarTarget;
      this.transBar.classList.remove('is-changing');
    }, 140);
    this.transBar.classList.remove('is-empty');
    this.transBarVisible = true;
  }

  private applyOffset(animate: boolean): void {
    // 桌面歌词窗刚打开时，首帧的行高与居中偏移是「边量边算」出来的：
    // 这一步若带着过渡，整块歌词会从上一帧的位置滑到新位置，看起来就是「闪现位移」。
    // 所以背景场景的第一趟偏移直接落位，之后的行切换照常滑动。
    const snap = animate && !this.bgOffsetSnapped;
    this.linesEl.style.transition = animate && !snap ? '' : 'none';
    // 取整到整数像素：autoOffset 是量出来的居中线，常带小数（实测 -1.17px 这种）。
    // 整块文字落在分数像素上，字形每一帧都按不同的子像素相位采样，看起来就是
    // 「边缘发虚 / 轻微游移」；播放结束后偏移再变一点点，就是那 1px 的跳动。
    // 行高量出来本来就是整数，取整不会改变版面，只去掉子像素漂移。
    const offset = Math.round(this.autoOffset + this.manualShift);
    this.linesEl.style.transform = `translateY(${offset}px)`;
    if (animate) this.bgOffsetSnapped = true;
  }

  private onWheel(event: WheelEvent): void {
    if (this.doc.lines.length === 0) return;
    event.preventDefault();
    const step = event.deltaMode === 1 ? event.deltaY * 18 : event.deltaY * 1.05;
    this.manualTarget -= step;
    this.clampManual();
    this.manualUntil = performance.now() + 3200;
    this.root.classList.add('is-manual');
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
    this.root.classList.remove('is-manual');
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
        // 偏移语义是「正数=歌词提前」：显示位置要换算回播放位置，否则点行会偏 offset 毫秒。
        const offset = lyricOffsetOf(this.doc.trackKey || this.lastTrackKey);
        seek(Math.max(0, line.timeMs - offset));
        this.resumeAuto();
      }
    });
  }

  dispose(): void {
    this.lineVisibility?.disconnect();
    window.clearTimeout(this.coverRetryTimer);
    this.coverEl.onerror = null;
    if (activeLyricsView === this) {
      activeLyricsView = null;
    }
    currentLyricText = '';
    this.disposed = true;
    if (this.transBarTimer !== null) window.clearTimeout(this.transBarTimer);
    // 作废还在途中的封面预载回调。
    this.coverSwapToken += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.matchUnsub?.();
    this.matchUnsub = null;
    this.coverStyleUnsub?.();
    this.coverStyleUnsub = null;
    this.settingsUnsub?.();
    this.settingsUnsub = null;
    window.clearTimeout(this.coverSwitchTimer);
    window.clearTimeout(this.resizeTimer);
    window.clearInterval(this.transSyncTimer);
    this.transSyncTimer = 0;
    window.removeEventListener('resize', this.onWindowResize);
    this.domLayoutObserver?.disconnect();
    this.domLayoutObserver = null;
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
    this.vinylStage?.dispose();
    this.vinylStage = null;
    this.flowStage?.dispose();
    this.flowStage = null;
    this.poemStage?.dispose();
    this.poemStage = null;
    this.pressureStage?.dispose();
    this.pressureStage = null;
    this.stageObserver?.disconnect();
    this.stageObserver = null;
    this.styleUnsub?.();
    this.styleUnsub = null;
    this.root.remove();
  }
}

