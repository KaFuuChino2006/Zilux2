import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")


def patch(rel, steps):
    p = ROOT / rel
    with io.open(str(p), "r", encoding="utf-8", newline="") as f:
        raw = f.read()
    nl = "\r\n" if "\r\n" in raw else "\n"
    text = raw.replace("\r\n", "\n")
    for name, old, new in steps:
        assert text.count(old) == 1, f"{name}: count={text.count(old)}"
        text = text.replace(old, new)
    with io.open(str(p), "w", encoding="utf-8", newline="") as f:
        f.write(text.replace("\n", nl))
    print("OK:", rel, len(steps), "steps")


patch("web/src/ui/spaceShell.ts", [
    ("expand-timed-chars",
     """  function lyricLinesFromText(lrcText: string, translation?: string | null, yrc?: string | null): LyricLineData[] {
""",
     """  /**
   * 把「词级」时间轴展开成「逐字」时间轴。
   * 渲染端要求 chars 与画布上的非空白字形一一对应（空格不占字形、逐字上色按这个数组走），
   * 而 QQ QRC / 网易云 yrc 常给的是多字词片段，所以这里把每个片段的时长均分到它包含的字。
   */
  function expandTimedChars(
    segments: Array<{ text: string; start: number; end: number }>,
    lineText: string,
  ): Array<{ text: string; start: number; end: number }> {
    const glyphs = Array.from(lineText).filter((char) => char.trim().length > 0);
    if (glyphs.length === 0 || segments.length === 0) return [];
    const chars: Array<{ text: string; start: number; end: number }> = [];
    let glyphIndex = 0;
    for (const segment of segments) {
      const pieces = Array.from(segment.text).filter((char) => char.trim().length > 0);
      if (pieces.length === 0) continue;
      const span = Math.max(0.02, segment.end - segment.start);
      for (let i = 0; i < pieces.length && glyphIndex < glyphs.length; i += 1) {
        chars.push({
          text: glyphs[glyphIndex] ?? pieces[i] ?? '',
          start: segment.start + (span * i) / pieces.length,
          end: segment.start + (span * (i + 1)) / pieces.length,
        });
        glyphIndex += 1;
      }
    }
    // 片段与整句字数对不上（少见：标点/繁简差异）时，退回按整句均分，保证能逐字点亮
    if (glyphIndex < glyphs.length) {
      const start = segments[0]?.start ?? 0;
      const end = segments[segments.length - 1]?.end ?? start + 1;
      const span = Math.max(0.4, end - start) / glyphs.length;
      return glyphs.map((char, i) => ({ text: char, start: start + i * span, end: start + (i + 1) * span }));
    }
    return chars;
  }

  function lyricLinesFromText(lrcText: string, translation?: string | null, yrc?: string | null): LyricLineData[] {
"""),
    ("lyric-lines-segments",
     """      const wordTimed = (line.words ?? []).map((word, i) => {
        const nextMs = line.words?.[i + 1]?.startMs ?? word.startMs + 900;
        return { text: word.text, start: word.startMs / 1000, end: Math.max(word.startMs + 120, nextMs) / 1000 };
      });
      const timed = charLines.find((entry) => Math.abs(entry.timeMs - line.timeMs) <= 260);
      let chars = wordTimed.length > 0
        ? wordTimed
        : timed
          ? timed.chars.map((char) => ({ text: char.text, start: char.startMs / 1000, end: char.endMs / 1000 }))
          : [];
""",
     """      const wordSegments = (line.words ?? []).map((word, i) => {
        const nextMs = line.words?.[i + 1]?.startMs ?? word.startMs + 900;
        return {
          text: word.text,
          start: word.startMs / 1000,
          end: Math.max(word.startMs + 120, nextMs) / 1000,
        };
      });
      const timed = pickTimedLine(charLines, parsed, line.timeMs, index);
      const timedSegments = timed
        ? timed.chars.map((char) => ({ text: char.text, start: char.startMs / 1000, end: char.endMs / 1000 }))
        : [];
      let chars = expandTimedChars(wordSegments.length > 0 ? wordSegments : timedSegments, line.text);
"""),
    ("pick-timed-line",
     """  /** QQ QRC 加密十六进制 → 逐字正文；失败返回空串（退回普通 LRC）。 */
""",
     """  /**
   * 给一行 LRC 找到对应的逐字行：先按时间就近匹配（qrc 与 lrc 版本可能差几百毫秒），
   * 再按下标兜底（两边行数一致时最稳），都失败返回 null。
   */
  function pickTimedLine(
    charLines: Array<{ timeMs: number; chars: Array<{ text: string; startMs: number; endMs: number }> }>,
    parsed: Array<{ timeMs: number }>,
    lineTimeMs: number,
    index: number,
  ): { timeMs: number; chars: Array<{ text: string; startMs: number; endMs: number }> } | null {
    if (charLines.length === 0) return null;
    let best: (typeof charLines)[number] | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const entry of charLines) {
      const delta = Math.abs(entry.timeMs - lineTimeMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = entry;
      }
    }
    if (best && bestDelta <= 900) return best;
    if (charLines.length === parsed.length) return charLines[index] ?? null;
    return null;
  }

  /** QQ QRC 加密十六进制 → 逐字正文；失败返回空串（退回普通 LRC）。 */
"""),
    ("online-segments",
     """        const timed = charLines.find((entry) => Math.abs(entry.timeMs - line.timeMs) <= 260);
        let chars = timed
          ? timed.chars.map((char) => ({ text: char.text, start: char.startMs / 1000, end: char.endMs / 1000 }))
          : [];
""",
     """        const timed = pickTimedLine(charLines, parsed, line.timeMs, index);
        const timedSegments = timed
          ? timed.chars.map((char) => ({ text: char.text, start: char.startMs / 1000, end: char.endMs / 1000 }))
          : [];
        let chars = expandTimedChars(timedSegments, line.text);
"""),
])
