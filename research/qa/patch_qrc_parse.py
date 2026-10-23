import io
from pathlib import Path

def load(p):
    raw = io.open(p, "r", encoding="utf-8", newline="").read()
    return raw, raw.replace("\r\n", "\n")

def save(p, raw, text):
    io.open(p, "w", encoding="utf-8", newline="").write(text.replace("\n", "\r\n") if "\r\n" in raw else text)

lrc = Path(r"E:\Zilux2开发\web\src\online\lrc.ts")
raw, text = load(lrc)
anchor = """export function parseCharLyric(raw: string | null | undefined): LyricCharLine[] {"""
assert text.count(anchor) == 1
addition = '''export interface QrcWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface QrcLine {
  timeMs: number;
  durationMs: number;
  words: QrcWord[];
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
  for (const rawLine of raw.split(/\r?\n/)) {
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
      let wordText = body.slice(cursor, tag.index);
      cursor = QRC_TAG.lastIndex;
      const startMs = Number(tag[1]);
      const wordDur = Number(tag[2]);
      if (!wordText.trim()) continue;
      // 括号是正文的一部分时（如「GUMI (」），单独成词的纯括号并回前一个词
      if (/^[()\s]+$/.test(wordText) && words.length > 0) {
        words[words.length - 1]!.text += wordText;
        continue;
      }
      words.push({ text: wordText.trim(), startMs, endMs: startMs + (Number.isFinite(wordDur) ? wordDur : 0) });
    }
    const tail = body.slice(cursor);
    if (tail.trim() && words.length > 0) {
      words[words.length - 1]!.text += tail.trim();
    }
    if (words.length > 0) out.push({ timeMs, durationMs, words });
  }
  return out;
}

'''
text = text.replace(anchor, addition + anchor)
save(lrc, raw, text)
print("OK lrc")

shell = Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")
raw, text = load(shell)

# 1. import
old = "import { applyTranslation, extractQrcPayload, parseCharLyric, parseLrc } from '../online/lrc';"
assert text.count(old) == 1
text = text.replace(old, "import { applyTranslation, extractQrcPayload, parseCharLyric, parseLrc, parseQrcLyric } from '../online/lrc';")

# 2. pickQrcLine helper after pickTimedLine
anchor = """  /** QQ QRC 加密十六进制 → 逐字正文；失败返回空串（退回普通 LRC）。 */"""
assert text.count(anchor) == 1
helper = '''  /** 按时间就近把 QRC 行对到 LRC 行上（QRC 与 LRC 行时间可能有几十毫秒偏差）。 */
  function pickQrcLine(
    qrcLines: ReturnType<typeof parseQrcLyric>,
    parsed: Array<{ timeMs: number }>,
    lineTimeMs: number,
    index: number,
  ): ReturnType<typeof parseQrcLyric>[number] | null {
    if (qrcLines.length === 0) return null;
    let best: (typeof qrcLines)[number] | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const entry of qrcLines) {
      const delta = Math.abs(entry.timeMs - lineTimeMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = entry;
      }
    }
    if (best && bestDelta <= 900) return best;
    if (qrcLines.length === parsed.length) return qrcLines[index] ?? null;
    return null;
  }

  /** 把 QRC 词片段转成 expandTimedChars 需要的秒级片段 */
  function qrcSegmentsOf(line: ReturnType<typeof parseQrcLyric>[number] | null): Array<{ text: string; start: number; end: number }> {
    if (!line) return [];
    return line.words.map((word) => ({ text: word.text, start: word.startMs / 1000, end: word.endMs / 1000 }));
  }

'''
text = text.replace(anchor, helper + anchor)

# 3. lyricLinesFromText signature + qrc segments
old = """  function lyricLinesFromText(lrcText: string, translation?: string | null, yrc?: string | null): LyricLineData[] {
    const parsed = applyTranslation(parseLrc(lrcText), translation ?? null).filter(
      (line) => line.text.trim().length > 0,
    );
    const charLines = parseCharLyric(yrc ?? '');
    return parsed.map((line, index) => {"""
new = """  function lyricLinesFromText(
    lrcText: string,
    translation?: string | null,
    yrc?: string | null,
    qrcText?: string | null,
  ): LyricLineData[] {
    const parsed = applyTranslation(parseLrc(lrcText), translation ?? null).filter(
      (line) => line.text.trim().length > 0,
    );
    const charLines = parseCharLyric(yrc ?? '');
    const qrcLines = parseQrcLyric(qrcText ?? '');
    return parsed.map((line, index) => {"""
assert text.count(old) == 1
text = text.replace(old, new)

old = """      const timed = pickTimedLine(charLines, parsed, line.timeMs, index);
      const timedSegments = timed
        ? timed.chars.map((char) => ({ text: char.text, start: char.startMs / 1000, end: char.endMs / 1000 }))
        : [];
      let chars = expandTimedChars(wordSegments.length > 0 ? wordSegments : timedSegments, line.text);"""
new = """      const timed = pickTimedLine(charLines, parsed, line.timeMs, index);
      const timedSegments = timed
        ? timed.chars.map((char) => ({ text: char.text, start: char.startMs / 1000, end: char.endMs / 1000 }))
        : [];
      const qrcSegments = qrcSegmentsOf(pickQrcLine(qrcLines, parsed, line.timeMs, index));
      const segments = qrcSegments.length > 0 ? qrcSegments : wordSegments.length > 0 ? wordSegments : timedSegments;
      let chars = expandTimedChars(segments, line.text);"""
assert text.count(old) == 1
text = text.replace(old, new)

# 4. searchOnlineLyrics call site: pass qrc separately
old = """        const qrcPlain = lyric.qrc ? qrcPayloadToText(lyric.qrc) : '';
        const lines = lyricLinesFromText(lyric.lrc, lyric.translation, qrcPlain || lyric.yrc);"""
new = """        const qrcPlain = lyric.qrc ? qrcPayloadToText(lyric.qrc) : '';
        const lines = lyricLinesFromText(lyric.lrc, lyric.translation, lyric.yrc, qrcPlain);"""
assert text.count(old) == 1
text = text.replace(old, new)

# 5. main online path: use QRC parser
old = """      // 逐字时间轴：优先 QQ QRC（本地解密），其次网易云 yrc；都没有时按行时长均分到字
      const qrcPlain = lyric.qrc ? qrcPayloadToText(lyric.qrc) : '';
      const charLines = parseCharLyric(qrcPlain || lyric.yrc);"""
new = """      // 逐字时间轴：优先 QQ QRC（本地解密，注意它是「文字在时间标签之前」的格式），
      // 其次网易云 yrc；都没有时按行时长均分到字
      const qrcPlain = lyric.qrc ? qrcPayloadToText(lyric.qrc) : '';
      const charLines = parseCharLyric(lyric.yrc);
      const qrcLines = parseQrcLyric(qrcPlain);"""
assert text.count(old) == 1
text = text.replace(old, new)

old = """        const timed = pickTimedLine(charLines, parsed, line.timeMs, index);
        const timedSegments = timed
          ? timed.chars.map((char) => ({ text: char.text, start: char.startMs / 1000, end: char.endMs / 1000 }))
          : [];
        let chars = expandTimedChars(timedSegments, line.text);"""
new = """        const timed = pickTimedLine(charLines, parsed, line.timeMs, index);
        const timedSegments = timed
          ? timed.chars.map((char) => ({ text: char.text, start: char.startMs / 1000, end: char.endMs / 1000 }))
          : [];
        const qrcSegments = qrcSegmentsOf(pickQrcLine(qrcLines, parsed, line.timeMs, index));
        let chars = expandTimedChars(qrcSegments.length > 0 ? qrcSegments : timedSegments, line.text);"""
assert text.count(old) == 1
text = text.replace(old, new)

save(shell, raw, text)
print("OK shell")
