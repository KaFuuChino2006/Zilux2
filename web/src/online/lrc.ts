/** LRC 解析与时间轴查找（网易云 / QQ 的歌词都是 LRC 文本）。 */

export interface LyricLine {
  /** 行开始时间（毫秒） */
  timeMs: number;
  text: string;
  /** 翻译（若有） */
  translation?: string;
  /** 增强 LRC 的行内词级时间轴（`<mm:ss.xx>词`），有则前端按词点亮 */
  words?: LyricWord[];
}

/** 增强 LRC 里的一个词：时间来自行内 `<mm:ss.xx>` 标签。 */
export interface LyricWord {
  text: string;
  startMs: number;
  /** 该词前面是否有空格（英文单词间距用，渲染时还原成间隙）。 */
  spaceBefore?: boolean;
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

/**
 * 解析增强 LRC 的行内词级标签：`<00:12.34>第一<00:12.80>个字`。
 * 纯 LRC 返回 null（由调用方按整句处理）。
 */
function parseWordSegments(text: string): { plain: string; words: LyricWord[] } | null {
  WORD_TAG.lastIndex = 0;
  if (!WORD_TAG.test(text)) return null;
  WORD_TAG.lastIndex = 0;
  const words: LyricWord[] = [];
  let lastIndex = 0;
  let pendingStart = -1;
  let pendingText = '';
  let prevTrailSpace = false;
  let match: RegExpExecArray | null;
  while ((match = WORD_TAG.exec(text)) !== null) {
    const prefix = text.slice(lastIndex, match.index);
    if (pendingStart >= 0) {
      pendingText += prefix;
      const trimmed = pendingText.trim();
      if (trimmed) {
        words.push({ text: trimmed, startMs: pendingStart, spaceBefore: prevTrailSpace });
        prevTrailSpace = /\s$/.test(pendingText);
      } else {
        prevTrailSpace = /\s$/.test(pendingText) || prevTrailSpace;
      }
    }
    pendingStart = toMs(match[1] ?? '0', match[2] ?? '0', match[3]);
    pendingText = '';
    lastIndex = match.index + match[0].length;
  }
  if (pendingStart >= 0) {
    pendingText += text.slice(lastIndex);
    const trimmed = pendingText.trim();
    if (trimmed) words.push({ text: trimmed, startMs: pendingStart, spaceBefore: prevTrailSpace });
  }
  if (words.length === 0) return null;
  return { plain: words.map((word) => word.text).join(''), words };
}
const META_TAG = /^\[(ti|ar|al|by|offset|re|ve):(.*)\]$/i;

function toMs(min: string, sec: string, frac?: string): number {
  const m = Number(min);
  const s = Number(sec);
  let ms = 0;
  if (frac && frac.length > 0) {
    const padded = frac.length === 1 ? `${frac}00` : frac.length === 2 ? `${frac}0` : frac.slice(0, 3);
    ms = Number(padded);
  }
  return m * 60_000 + s * 1000 + ms;
}

/** 解析 LRC：支持一行多时间戳、[offset:] 全局偏移、元数据行忽略。 */
export function parseLrc(raw: string, baseOffsetMs = 0): LyricLine[] {
  if (!raw) return [];
  const lines: LyricLine[] = [];
  let offset = baseOffsetMs;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const meta = META_TAG.exec(line);
    if (meta) {
      if (meta[1]?.toLowerCase() === 'offset') {
        const value = Number(meta[2]?.trim());
        // LRC 规范（Wikipedia / MobileRead / KDE Elisa）的 [offset:+N] 表示歌词整体「提前」N 毫秒，
        // 即时间戳要减去 N；旧实现是加，正负语义正好相反。这里按规范取负，并夹在 ±30s
        // 以防个别文件写入异常值把整首歌推到边界。
        if (Number.isFinite(value)) offset = Math.max(-30_000, Math.min(30_000, -value));
      }
      continue;
    }

    TIME_TAG.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    while ((match = TIME_TAG.exec(line)) !== null) {
      stamps.push(toMs(match[1] ?? '0', match[2] ?? '0', match[3]));
      lastIndex = match.index + match[0].length;
    }
    if (stamps.length === 0) continue;

    const text = line.slice(lastIndex).trim();
    if (!text) continue;
    const wordSegments = parseWordSegments(text);
    const display = wordSegments ? text.replace(WORD_TAG, '').trim() : text;
    for (const timeMs of stamps) {
      const entry: LyricLine = {
        // offset 已在解析 [offset:] 时换成「加到时间戳上的量」（正值=推迟），baseOffsetMs 也沿用同一约定。
        timeMs: Math.max(0, timeMs + offset),
        text: display,
      };
      if (wordSegments) {
        // D-47：逐字时间也必须应用同一个 [offset:] 位移，否则行级正确、逐字高亮整段偏移。
        entry.words = wordSegments.words.map((word) => ({
          ...word,
          startMs: Math.max(0, word.startMs + offset),
        }));
      }
      lines.push(entry);
    }
  }

  lines.sort((a, b) => a.timeMs - b.timeMs);
  return lines;
}

/**
 * 把两组按时间排好序的行配对：每条主行最多配一条、每条译文最多用一次。
 * 先收齐所有「时间差 ≤ windowMs」的候选对，再按「时间差 → 主行序 → 译行序」排序后贪心分配；
 * 精确同时间戳会优先配上。这是 Folia 的做法，比旧的「游标只前进」稳：
 * 译文整体晚 100ms 时，旧实现从第二行起全部配不上（候选永远落后于游标）。
 */
export function pairByTime(mainTimes: number[], otherTimes: number[], windowMs: number): Array<number | null> {
  const result: Array<number | null> = new Array(mainTimes.length).fill(null);
  if (!mainTimes.length || !otherTimes.length) return result;
  interface Pair {
    main: number;
    other: number;
    delta: number;
  }
  const pairs: Pair[] = [];
  let lo = 0;
  for (let i = 0; i < mainTimes.length; i += 1) {
    const t = mainTimes[i]!;
    while (lo < otherTimes.length && (otherTimes[lo] ?? 0) < t - windowMs) lo += 1;
    for (let j = lo; j < otherTimes.length; j += 1) {
      const tj = otherTimes[j]!;
      if (tj > t + windowMs) break;
      pairs.push({ main: i, other: j, delta: Math.abs(tj - t) });
    }
  }
  pairs.sort((a, b) => a.delta - b.delta || a.main - b.main || a.other - b.other);
  const mainUsed = new Uint8Array(mainTimes.length);
  const otherUsed = new Uint8Array(otherTimes.length);
  for (const pair of pairs) {
    if (mainUsed[pair.main] || otherUsed[pair.other]) continue;
    mainUsed[pair.main] = 1;
    otherUsed[pair.other] = 1;
    result[pair.main] = pair.other;
  }
  return result;
}

/** 纯符号 / 纯标点的「译文」其实是占位（`//`、`···`、`—` 之类），不要显示。 */
const TRANSLATION_PLACEHOLDER = /^[\s\-—–·•~～/\\|_=*#.。，,、:：;；!！?？]+$/u;

function translationKey(value: string): string {
  return value.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

/**
 * 译文可读性过滤：去掉占位符，以及和原文完全相同的「译文」（很多平台会原样回填）。
 * 原文可选；两者归一化（去空格/标点/符号、小写）后相同就视为重复。
 */
export function isUsefulTranslation(text: string, original?: string): boolean {
  const value = text.trim();
  if (!value || TRANSLATION_PLACEHOLDER.test(value)) return false;
  if (original) {
    const originalKey = translationKey(original);
    if (originalKey.length > 0 && translationKey(value) === originalKey) return false;
  }
  return true;
}

/** 把翻译 LRC 合并到主歌词：按开始时间就近匹配（±1s，一对一）。 */
export function applyTranslation(lines: LyricLine[], translationRaw: string | null): LyricLine[] {
  if (!lines.length || !translationRaw) return lines;
  const trans = parseLrc(translationRaw);
  if (!trans.length) return lines;

  const merged = lines.map((line) => ({ ...line }));
  const match = pairByTime(
    merged.map((line) => line.timeMs),
    trans.map((line) => line.timeMs),
    1000,
  );
  match.forEach((index, i) => {
    if (index === null) return;
    const text = trans[index]!.text;
    const line = merged[i]!;
    if (text && isUsefulTranslation(text, line.text)) line.translation = text;
  });
  return merged;
}

/** 二分查找当前行：返回最后一个 timeMs <= positionMs 的下标，找不到返回 -1。 */
export function findActiveLine(lines: LyricLine[], positionMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = lines[mid];
    if (!line) break;
    if (line.timeMs <= positionMs + 90) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** 逐字歌词里的一个字（毫秒） */
export interface LyricChar {
  text: string;
  startMs: number;
  endMs: number;
  /** 字前是否有空格（英文单词间距用）。 */
  spaceBefore?: boolean;
}

/** 逐字歌词的一行 */
export interface LyricCharLine {
  timeMs: number;
  durationMs: number;
  chars: LyricChar[];
  /** 整行原文（保留英文单词之间的空格）。 */
  text?: string;
}

const CHAR_LINE = /^\[(\d+),(\d+)\](.*)$/;
const CHAR_TOKEN = /\((\d+),(\d+)(?:,\d+)?\)([^()]*)/g;

const QRC_CONTENT = /LyricContent="([\s\S]*?)"/;

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code) || 32))
    .replace(/&amp;/g, '&');
}

/**
 * 从解密后的 QRC XML 里取出逐字歌词正文（`[start,dur](start,dur)字…`）。
 * 非 XML（已是纯正文）时原样返回；解析失败返回空串。
 */
export function extractQrcPayload(decrypted: string): string {
  if (!decrypted) return '';
  const match = QRC_CONTENT.exec(decrypted);
  const body = match ? unescapeXml(match[1] ?? '') : decrypted;
  if (!body.includes('[')) return '';
  return body
    .replace(/\[(ti|ar|al|by|offset|re|ve):[^\]]*\]/gi, '')
    .replace(/\r/g, '');
}

/**
 * 解析逐字歌词。网易云 yrc 与 QQ qrc 同构：
 * 每行 `[行开始,行时长]`，字用 `(字开始,字时长)` 前缀，例如
 * `[1000,2000](1000,200)你(1200,200)好`。
 */
export interface QrcWord {
  text: string;
  startMs: number;
  endMs: number;
  /** 词前是否有空格（英文单词间距用）。 */
  spaceBefore?: boolean;
}

export interface QrcLine {
  timeMs: number;
  durationMs: number;
  words: QrcWord[];
  /** 整行原文（保留英文单词之间的空格），用于还原显示文本。 */
  text?: string;
}

const QRC_LINE = /^\[(\d+),(\d+)\](.*)$/;
const QRC_TAG = /\((\d+),(\d+)(?:,\d+)?\)/g;

/**
 * QQ QRC 解密后的正文格式：`[行开始,行时长]词(词开始,词时长)词(词开始,词时长)...`
 * 文字在时间标签「之前」（与网易云 yrc 的 `(start,dur,0)字` 相反），所以单独解析。
 */
export function parseQrcLyric(raw: string | null | undefined): QrcLine[] {
  if (!raw) return [];
  const out: QrcLine[] = [];
  for (const rawLine of raw.split(new RegExp('\r?\n'))) {
    const line = rawLine.trim();
    if (!line) continue;
    const head = QRC_LINE.exec(line);
    if (!head) continue;
    const timeMs = Number(head[1]);
    const durationMs = Number(head[2]);
    const body = head[3] ?? '';
    if (!body) continue;
    const words: QrcWord[] = [];
    QRC_TAG.lastIndex = 0;
    let cursor = 0;
    let tag: RegExpExecArray | null;
    while ((tag = QRC_TAG.exec(body))) {
      const wordText = body.slice(cursor, tag.index);
      cursor = QRC_TAG.lastIndex;
      const startMs = Number(tag[1]);
      const wordDur = Number(tag[2]);
      if (!wordText.trim()) continue;
      // 括号是正文的一部分时（如「GUMI (」），单独成词的纯括号并回前一个词
      if (/^[()\s]+$/.test(wordText) && words.length > 0) {
        words[words.length - 1]!.text += wordText;
        continue;
      }
      words.push({
        text: wordText.trim(),
        startMs,
        endMs: startMs + (Number.isFinite(wordDur) ? wordDur : 0),
        spaceBefore: words.length > 0 && /^\s/.test(wordText),
      });
    }
    const tail = body.slice(cursor);
    if (tail.trim() && words.length > 0) {
      words[words.length - 1]!.text += tail.trim();
    }
    if (words.length > 0) out.push({ timeMs, durationMs, words, text: body.replace(QRC_TAG, '').trim() });
  }
  return out;
}

export function parseCharLyric(raw: string | null | undefined): LyricCharLine[] {
  if (!raw) return [];
  const out: LyricCharLine[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const head = CHAR_LINE.exec(line);
    if (!head) continue;
    const timeMs = Number(head[1]);
    const durationMs = Number(head[2]);
    const body = head[3] ?? '';
    if (!body) continue;
    const chars: LyricChar[] = [];
    CHAR_TOKEN.lastIndex = 0;
    let token: RegExpExecArray | null;
    let prevTrailSpace = false;
    while ((token = CHAR_TOKEN.exec(body))) {
      const startMs = Number(token[1]);
      const charDur = Number(token[2]);
      if (!Number.isFinite(startMs)) continue;
      const raw = token[3] ?? '';
      const text = raw.trim();
      if (!text) {
        prevTrailSpace = /\s/.test(raw) || prevTrailSpace;
        continue;
      }
      chars.push({
        text,
        startMs,
        endMs: startMs + (Number.isFinite(charDur) ? charDur : 0),
        spaceBefore: chars.length > 0 && prevTrailSpace,
      });
      prevTrailSpace = /\s$/.test(raw);
    }
    if (chars.length > 0) {
      out.push({ timeMs, durationMs, chars, text: body.replace(/\(\d+,\d+(?:,\d+)?\)/g, '').trim() });
    }
  }
  return out;
}
