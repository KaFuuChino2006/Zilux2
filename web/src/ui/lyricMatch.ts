/**
 * 跨平台歌词匹配：播放某平台歌曲时，后台去另一个平台按「歌名 + 歌手」找同一首歌的歌词。
 * 优先使用带逐字数据的版本（QQ QRC / 网易云 YRC），没有逐字就保留当前平台的歌词；
 * 无论是否替换，都返回一个匹配度（0~1），供界面显示。
 */

import { decryptQrc } from 'qrc-decoder';
import { fetchLyric, searchOnline } from '../online/client';
import { applyTranslation, extractQrcPayload, parseCharLyric, parseLrc, parseQrcLyric, type LyricLine as SourceLine } from '../online/lrc';
import { lyricSourceIds, sourceMeta } from '../online/sources';
import { SOURCE_LABEL, type OnlineTrack } from '../online/types';
import type { LyricLine } from './lyrics';

export type WordLyricKind = 'qrc' | 'yrc';

export interface LyricMatchResult {
  /** 匹配度 0~1（歌词文本相似度为主，歌名/歌手相似度为辅）。 */
  score: number;
  /** 展示用来源，例如「QQ 音乐 · 逐字（QRC）」 */
  label: string;
  kind: WordLyricKind | 'lrc';
  /** 只有逐字版本才带；没有逐字时为 null（表示保留当前平台歌词）。 */
  lines: LyricLine[] | null;
  /** true = 当前曲目本身没有任何歌词，直接线上取，不计算文本匹配度。 */
  direct?: boolean;
  /** 最佳候选是否真的带逐字歌词（false = 对方平台只有整行 LRC）。 */
  hasWord?: boolean;
  /** true = 找到逐字候选，但匹配度低于当前阈值，因此没替换。 */
  belowThreshold?: boolean;
  /** 命中的平台 id 与曲目 id，便于排查。 */
  source: string;
  id: string;
  /** 命中的逐字歌词是否带翻译。 */
  hasTranslation: boolean;
  /** true = 匹配到逐字但没翻译，而当前平台歌词带翻译，因此保留原歌词。 */
  translationKept?: boolean;
  /** 逐字来自候选平台、翻译取自当前平台（LRC+翻译 与逐字结合）。 */
  translationFromBase?: boolean;
  /** 逐字来自候选平台、翻译取自另一个平台（例如 QQ 逐字 + 网易云翻译）。 */
  translationFromOther?: string;
  /** true = 当前平台自带逐字，只从其它平台补翻译（locally 已有逐字，不替换）。 */
  translationOnly?: boolean;
}


/** 匹配度阈值（0~1）：只有达标才会用其它平台的逐字歌词替换当前歌词，可在快捷设置里调。 */
const MATCH_MIN_KEY = 'zilux2.lyricMatchMin';
const MATCH_MIN_DEFAULT = 0.55;
const MATCH_MIN_FLOOR = 0.3;
const MATCH_MIN_CEIL = 0.95;

function readMinScore(): number {
  try {
    const raw = Number(window.localStorage.getItem(MATCH_MIN_KEY));
    if (Number.isFinite(raw) && raw >= MATCH_MIN_FLOOR && raw <= MATCH_MIN_CEIL) {
      return Math.round(raw * 100) / 100;
    }
  } catch {
    // localStorage 不可用时用默认值
  }
  return MATCH_MIN_DEFAULT;
}

let minScore = readMinScore();

export function matchMinScore(): number {
  return minScore;
}

/** 调整匹配度阈值；缓存会清空，让下一次匹配用新阈值重新判断。 */
export function setMatchMinScore(value: number): void {
  const next = Math.max(MATCH_MIN_FLOOR, Math.min(MATCH_MIN_CEIL, Math.round(value * 100) / 100));
  if (next === minScore) return;
  minScore = next;
  try {
    window.localStorage.setItem(MATCH_MIN_KEY, String(next));
  } catch {
    // 忽略存储失败
  }
  cache.clear();
}
const PUNCT = /[\s\u3000-\u303f\uff00-\uff65\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]+/g;

function normalize(text: string): string {
  return text.toLowerCase().replace(PUNCT, '');
}

/** 字符 bigram 的 Jaccard 相似度，用来比较两版歌词是不是同一首歌。 */
function similarity(a: string, b: string): number {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = new Set<string>();
  for (let i = 0; i < left.length - 1; i += 1) grams.add(left.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i < right.length - 1; i += 1) {
    if (grams.has(right.slice(i, i + 2))) hit += 1;
  }
  const total = Math.max(1, left.length + right.length - 2);
  return (2 * hit) / total;
}

function metaScore(track: OnlineTrack, candidate: OnlineTrack): number {
  const title = similarity(track.title, candidate.title);
  if (!title) return 0;
  const artist = track.artist && candidate.artist ? similarity(track.artist, candidate.artist) : 0.5;
  const duration =
    track.durationMs && candidate.durationMs
      ? Math.max(0, 1 - Math.abs(track.durationMs - candidate.durationMs) / 20000)
      : 0.5;
  return title * 0.6 + artist * 0.28 + duration * 0.12;
}

function docText(lines: SourceLine[] | LyricLine[]): string {
  return lines.map((line) => line.text ?? '').join('\n');
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
 * 逐字候选是否覆盖到整首：既不能明显短于当前歌词，也不能只覆盖前段（试听/片段版）。
 * 不满足就不拿它替换，否则会出现「歌词播到几十秒就没了」。
 */
function wordCoversSong(
  candidate: ReadonlyArray<{ timeMs: number; durationMs?: number }>,
  durationMs: number | undefined,
  baseLines: ReadonlyArray<{ timeMs: number; durationMs?: number }>,
): boolean {
  const coverage = lyricCoverageMs(candidate);
  if (coverage <= 0) return false;
  const total = durationMs && durationMs > 0 ? durationMs : 0;
  const floor = Math.max(lyricCoverageMs(baseLines) * 0.85, total * 0.6);
  return coverage >= floor;
}



interface WordDoc {
  kind: WordLyricKind;
  lines: LyricLine[];
  text: string;
  /** 这一版逐字歌词是否带翻译（带翻译的优先于不带翻译的）。 */
  hasTranslation: boolean;
}

/** 把平台翻译贴到逐字行上：按时间戳就近匹配（翻译 LRC 与逐字行时间通常一致）。 */
function attachTranslation(lines: LyricLine[], translation: string | null | undefined): boolean {
  const text = (translation ?? '').trim();
  if (!text) return false;
  const translated = parseLrc(text).filter((line) => line.text.trim().length > 0);
  if (translated.length === 0) return false;
  let attached = 0;
  for (const line of lines) {
    let best: SourceLine | null = null;
    let bestDelta = Number.MAX_SAFE_INTEGER;
    for (const item of translated) {
      const delta = Math.abs(item.timeMs - line.timeMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = item;
      }
    }
    if (best && bestDelta <= 600) {
      line.translation = best.text;
      attached += 1;
    }
  }
  return attached > 0;
}

/** 把某个平台（LRC+翻译）的翻译贴到逐字行上：逐字用候选平台、翻译可来自任意平台。 */
type TimedLine = { timeMs: number; translation?: string | null };

function attachTranslationLines(lines: LyricLine[], sourceLines: TimedLine[]): boolean {
  const translated = sourceLines.filter((line) => (line.translation ?? '').trim().length > 0);
  if (translated.length === 0) return false;
  let attached = 0;
  for (const line of lines) {
    let nearest: TimedLine | null = null;
    let bestDelta = Number.MAX_SAFE_INTEGER;
    for (const item of translated) {
      const delta = Math.abs(item.timeMs - line.timeMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        nearest = item;
      }
    }
    if (nearest && bestDelta <= 800) {
      line.translation = (nearest.translation ?? '').trim();
      attached += 1;
    }
  }
  return attached > 0;
}

/** 把平台歌词响应转成「逐字版本」（没有逐字数据时返回 null）。 */
function wordDocOf(lyric: {
  lrc?: string | null;
  yrc?: string | null;
  qrc?: string | null;
  translation?: string | null;
}): WordDoc | null {
  if (lyric.qrc) {
    try {
      const payload = extractQrcPayload(decryptQrc(lyric.qrc));
      const qrcLines = parseQrcLyric(payload);
      if (qrcLines.length > 0) {
        const lines: LyricLine[] = qrcLines.map((line) => ({
          timeMs: line.timeMs,
          durationMs: line.durationMs,
          text: line.text ?? line.words.map((word) => word.text).join(''),
          translation: '',
          words: line.words.map((word) => ({ ...word })),
        }));
        const hasTranslation = attachTranslation(lines, lyric.translation);
        return { kind: 'qrc', lines, text: docText(lines), hasTranslation };
      }
    } catch {
      /* 解密失败就当作没有逐字 */
    }
  }
  if (lyric.yrc) {
    const charLines = parseCharLyric(lyric.yrc);
    if (charLines.length > 0) {
      const lines: LyricLine[] = charLines.map((line) => ({
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
      }));
      const hasTranslation = attachTranslation(lines, lyric.translation);
      return { kind: 'yrc', lines, text: docText(lines), hasTranslation };
    }
  }
  return null;
}

function linesFromLrc(lrc: string | null | undefined, translation: string | null | undefined): LyricLine[] {
  const translated = applyTranslation(parseLrc(lrc ?? ''), translation ?? '');
  return translated
    .filter((line) => line.text.trim().length > 0)
    .map((line, index, all) => {
      const next = all[index + 1];
      const durationMs = next ? Math.max(200, next.timeMs - line.timeMs) : 3200;
      return { timeMs: line.timeMs, durationMs, text: line.text, translation: line.translation ?? '', words: [] };
    });
}

const cache = new Map<string, LyricMatchResult | null>();
const inflight = new Map<string, Promise<LyricMatchResult | null>>();

/** 平台返回的歌名/歌手常混入不换行空格、全角空格、`/` 等，先清洗再拿去搜索。 */
function cleanText(text: string): string {
  return text
    .replace(/[\u00a0\u1680\u2000-\u200d\u202f\u205f\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function primaryArtist(artist: string): string {
  const first = artist.split(/[/&、,，;；|]|\bfeat\.?\b|\bft\.?\b/i)[0] ?? '';
  return cleanText(first);
}

function bareTitle(title: string): string {
  const pairs: Array<[string, string]> = [
    ['(', ')'],
    ['（', '）'],
    ['[', ']'],
    ['【', '】'],
  ];
  let text = title;
  for (const [open, close] of pairs) {
    let result = '';
    let depth = 0;
    for (const char of text) {
      if (char === open) {
        depth += 1;
        continue;
      }
      if (char === close && depth > 0) {
        depth -= 1;
        continue;
      }
      if (depth === 0) result += char;
    }
    text = result;
  }
  const stripped = cleanText(text);
  return stripped || cleanText(title);
}

/** 依次尝试「歌名 + 主歌手」「歌名」「去括号歌名」等写法，直到搜到结果。 */
function searchQueries(track: OnlineTrack): string[] {
  const title = cleanText(track.title);
  const bare = bareTitle(track.title);
  const artist = primaryArtist(track.artist ?? '');
  const candidates = [
    artist ? `${title} ${artist}` : title,
    title,
    bare !== title ? bare : '',
    artist && bare !== title ? `${bare} ${artist}` : '',
  ];
  const seen: string[] = [];
  for (const query of candidates) {
    if (query && !seen.includes(query)) seen.push(query);
  }
  return seen;
}

function labelOf(source: string, kind: WordLyricKind | 'lrc'): string {
  const platform = SOURCE_LABEL[source] ?? sourceMeta(source)?.label ?? source;
  if (kind === 'qrc') return `${platform} · 逐字（QRC）`;
  if (kind === 'yrc') return `${platform} · 逐字（YRC）`;
  return `${platform} · LRC`;
}

/**
 * 在其它在线平台里找这首歌的歌词。
 * - 找到逐字版且文本相似度达标 → 返回可替换的 lines；
 * - 只有普通 LRC → lines 为 null（保留当前平台歌词），但仍返回匹配度；
 * - 完全没有匹配 → null。
 */
export function matchWordLyrics(track: OnlineTrack, baseLines: LyricLine[]): Promise<LyricMatchResult | null> {
  const cacheKey = `${track.source}:${track.id}`;
  const running = inflight.get(cacheKey);
  if (running) return running;
  const task = runMatch(track, baseLines).finally(() => {
    inflight.delete(cacheKey);
  });
  inflight.set(cacheKey, task);
  return task;
}

/** 曲目完全没有歌词时：直接按歌名/歌手去线上取，优先逐字版本，忽略匹配度阈值。 */
async function runDirectMatch(track: OnlineTrack): Promise<LyricMatchResult | null> {
  const targets = lyricSourceIds().filter((id) => id !== track.source && id !== 'local');
  for (const source of targets) {
    let results: OnlineTrack[] = [];
    for (const query of searchQueries(track)) {
      try {
        results = (await searchOnline(source, query, 6)).tracks;
      } catch {
        results = [];
      }
      if (results.length > 0) break;
    }
    const scored = results
      .map((candidate) => ({ candidate, meta: metaScore(track, candidate) }))
      .filter((item) => item.meta >= 0.5)
      .sort((a, b) => b.meta - a.meta)
      .slice(0, 3);
    for (const { candidate, meta } of scored) {
      let lyric;
      try {
        lyric = await fetchLyric(source, candidate.id);
      } catch {
        continue;
      }
      const word = wordDocOf(lyric);
      const lines = word ? word.lines : linesFromLrc(lyric.lrc, lyric.translation);
      if (lines.length === 0) continue;
      const kind: WordLyricKind | 'lrc' = word?.kind ?? 'lrc';
      return {
        direct: true,
        score: meta,
        label: labelOf(source, kind),
        kind,
        lines,
        hasWord: Boolean(word && word.lines.length > 0),
        source,
        id: candidate.id,
        hasTranslation: word?.hasTranslation ?? Boolean((lyric.translation ?? '').trim()),
      };
    }
  }
  return null;
}

async function runMatch(
  track: OnlineTrack,
  baseLines: LyricLine[],
): Promise<LyricMatchResult | null> {
  if (track.source === 'local') {
    // 本地歌曲没有平台歌词，可直接用线上平台任意逐字数据（走下面的通用流程）。
  }
  const cacheKey = `${track.source}:${track.id}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const baseText = docText(baseLines);
  // 当前平台歌词是否带翻译：带翻译的整行歌词优先于「只是有逐字、没翻译」的候选。
  const baseHasTranslation = baseLines.some((line) => (line.translation ?? '').trim().length > 0);
  if (!baseText.trim()) {
    // 完全没有歌词（本地没配 lrc / 平台也没有）：直接线上取，忽略匹配度
    const direct = await runDirectMatch(track);
    cache.set(cacheKey, direct);
    return direct;
  }

  const targets = lyricSourceIds().filter((id) => id !== track.source && id !== 'local');
  if (targets.length === 0) {
    cache.set(cacheKey, null);
    return null;
  }

  let best: LyricMatchResult | null = null;
  let bestTranslation: { lines: TimedLine[]; label: string; meta: number } | null = null;

  for (const source of targets) {
    let results: OnlineTrack[] = [];
    for (const query of searchQueries(track)) {
      try {
        results = (await searchOnline(source, query, 8)).tracks;
      } catch {
        results = [];
      }
      if (results.length > 0) break;
    }
    if (results.length === 0) continue;
    const scored = results
      .map((candidate) => ({ candidate, meta: metaScore(track, candidate) }))
      .filter((item) => item.meta >= 0.5)
      .sort((a, b) => b.meta - a.meta)
      .slice(0, 3);

    for (const { candidate, meta } of scored) {
      let lyric;
      try {
        lyric = await fetchLyric(source, candidate.id);
      } catch {
        continue;
      }
      const word = wordDocOf(lyric);
      const text = word?.text ?? (lyric.lrc ? docText(parseLrc(lyric.lrc)) : '');
      if (!text.trim()) continue;
      // 顺手记下这个平台的翻译（逐字时间轴可以来自别的平台，翻译借来贴即可）。
      const rawTranslation = (lyric.translation ?? '').trim();
      if (!word?.hasTranslation && rawTranslation) {
        const translated = parseLrc(rawTranslation).filter((line) => line.text.trim().length > 0);
        if (translated.length > 0 && (!bestTranslation || meta > bestTranslation.meta)) {
          bestTranslation = { lines: translated, label: labelOf(source, 'lrc'), meta };
        }
      }
      const textScore = similarity(baseText, text);
      // 歌词文本是主要判据，元数据只做辅助；避免把同专辑不同曲匹配上。
      // 逐字歌词里「带翻译」的优先级更高（要求：有翻译的逐字 > 单纯逐字）。
      const translationBonus = word?.hasTranslation ? 0.06 : 0;
      const score = Math.min(1, textScore * 0.72 + meta * 0.28 + translationBonus);
      const kind: WordLyricKind | 'lrc' = word?.kind ?? 'lrc';
      // 逐字候选要覆盖到整首：片段版（只到几十秒）不拿来替换，否则播到一半就没词。
      const coverageOk = !word || wordCoversSong(word.lines, track.durationMs, baseLines);
      const hasWord = Boolean(word && word.lines.length > 0 && coverageOk);
      if (!best || score > best.score) {
        best = {
          score,
          label: labelOf(source, kind),
          kind,
          lines: word && hasWord && score >= minScore ? word.lines : null,
          hasWord,
          belowThreshold: hasWord && score < minScore,
          source,
          id: candidate.id,
          hasTranslation: word?.hasTranslation ?? false,
        };
      }
      if (word && score >= minScore) break;
    }
    if (best?.lines) break;
  }

  // 逐字版没有翻译时，按优先级借翻译：先当前平台（LRC+翻译），再其它平台带翻译的歌词。
  if (best?.lines && !best.hasTranslation) {
    if (baseHasTranslation && attachTranslationLines(best.lines, baseLines)) {
      best = { ...best, hasTranslation: true, translationFromBase: true };
    } else if (bestTranslation && attachTranslationLines(best.lines, bestTranslation.lines)) {
      best = { ...best, hasTranslation: true, translationFromOther: bestTranslation.label };
    }
  }

  cache.set(cacheKey, best);
  return best;
}

const translationCache = new Map<string, LyricMatchResult | null>();
const translationInflight = new Map<string, Promise<LyricMatchResult | null>>();

/**
 * 当前平台自带逐字、但没有翻译时：只去其它平台找翻译，按时间戳贴到现有逐字行上。
 * 返回的 result.lines 为 null（不替换逐字），translationOnly 为 true。
 */
export function matchTranslation(track: OnlineTrack, baseLines: LyricLine[]): Promise<LyricMatchResult | null> {
  const key = `${track.source}:${track.id}`;
  const running = translationInflight.get(key);
  if (running) return running;
  const task = runTranslationMatch(track, baseLines).finally(() => {
    translationInflight.delete(key);
  });
  translationInflight.set(key, task);
  return task;
}

async function runTranslationMatch(track: OnlineTrack, baseLines: LyricLine[]): Promise<LyricMatchResult | null> {
  const key = `${track.source}:${track.id}`;
  if (translationCache.has(key)) return translationCache.get(key) ?? null;
  const targets = lyricSourceIds().filter((id) => id !== track.source && id !== 'local');
  let best: { lines: TimedLine[]; label: string; meta: number } | null = null;
  for (const source of targets) {
    let results: OnlineTrack[] = [];
    for (const query of searchQueries(track)) {
      try {
        results = (await searchOnline(source, query, 8)).tracks;
      } catch {
        results = [];
      }
      if (results.length > 0) break;
    }
    const scored = results
      .map((candidate) => ({ candidate, meta: metaScore(track, candidate) }))
      .filter((item) => item.meta >= 0.5)
      .sort((a, b) => b.meta - a.meta)
      .slice(0, 3);
    for (const { candidate, meta } of scored) {
      let lyric;
      try {
        lyric = await fetchLyric(source, candidate.id);
      } catch {
        continue;
      }
      const raw = (lyric.translation ?? '').trim();
      if (!raw) continue;
      const lines = parseLrc(raw).filter((line) => line.text.trim().length > 0) as TimedLine[];
      if (lines.length === 0) continue;
      if (!best || meta > best.meta) {
        best = { lines, label: `${SOURCE_LABEL[source] ?? source}`, meta };
      }
      if (best.meta >= 0.85) break;
    }
    if (best && best.meta >= 0.85) break;
  }
  let result: LyricMatchResult | null = null;
  if (best && attachTranslationLines(baseLines, best.lines)) {
    result = {
      score: best.meta,
      label: '当前平台逐字',
      kind: 'lrc',
      lines: null,
      source: track.source,
      id: track.id,
      hasTranslation: true,
      translationOnly: true,
      translationFromOther: best.label,
    };
  }
  translationCache.set(key, result);
  return result;
}

/** 供「匹配歌词」窗口复用：歌名/歌手/时长匹配度（0~1）。 */
export function metaMatchScore(track: OnlineTrack, candidate: OnlineTrack): number {
  return metaScore(track, candidate);
}

/** 供「匹配歌词」窗口复用：搜索关键词（由宽到窄）。 */
export function candidateQueries(track: OnlineTrack): string[] {
  return searchQueries(track);
}

export function matchCacheSize(): number {
  return cache.size;
}
