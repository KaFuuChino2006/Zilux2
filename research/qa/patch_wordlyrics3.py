import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
p = ROOT / "web/src/ui/spaceShell.ts"
with io.open(str(p), "r", encoding="utf-8", newline="") as f:
    raw = f.read()
nl = "\r\n" if "\r\n" in raw else "\n"
text = raw.replace("\r\n", "\n")

old_start = """  function expandTimedChars(
    segments: Array<{ text: string; start: number; end: number }>,
    lineText: string,
  ): Array<{ text: string; start: number; end: number }> {
"""
old_end = """    return chars;
  }

  function lyricLinesFromText("""
i0 = text.index(old_start)
i1 = text.index(old_end, i0)
new_fn = """  function expandTimedChars(
    segments: Array<{ text: string; start: number; end: number }>,
    lineText: string,
  ): Array<{ text: string; start: number; end: number }> {
    const glyphs = Array.from(lineText).filter((char) => char.trim().length > 0);
    if (glyphs.length === 0 || segments.length === 0) return [];
    // 片段先展开成「字 → 时间」流：词级时间均分到词内每个字
    const stream: Array<{ char: string; start: number; end: number }> = [];
    for (const segment of segments) {
      const pieces = Array.from(segment.text).filter((char) => char.trim().length > 0);
      if (pieces.length === 0) continue;
      const span = Math.max(0.02, segment.end - segment.start);
      pieces.forEach((char, i) => {
        stream.push({
          char,
          start: segment.start + (span * i) / pieces.length,
          end: segment.start + (span * (i + 1)) / pieces.length,
        });
      });
    }
    if (stream.length === 0) return [];
    // 逐字对齐：LRC 与逐词源常有标点/括号差异，按字符匹配推进；
    // 对不上的字形用相邻时间插值，保证 chars 长度与本句字形数完全一致（渲染端要求一一对应）。
    const chars: Array<{ text: string; start: number; end: number }> = [];
    let cursor = 0;
    let prevEnd = stream[0]?.start ?? 0;
    for (let i = 0; i < glyphs.length; i += 1) {
      const glyph = glyphs[i] ?? '';
      let matchIndex = -1;
      for (let look = cursor; look < Math.min(stream.length, cursor + 4); look += 1) {
        if (stream[look]?.char === glyph) {
          matchIndex = look;
          break;
        }
      }
      if (matchIndex >= 0) {
        const entry = stream[matchIndex]!;
        chars.push({ text: glyph, start: entry.start, end: entry.end });
        prevEnd = entry.end;
        cursor = matchIndex + 1;
      } else {
        const nextStart = cursor < stream.length ? stream[cursor]!.start : prevEnd + 0.08;
        chars.push({ text: glyph, start: prevEnd, end: Math.max(prevEnd + 0.02, nextStart) });
        prevEnd = Math.max(prevEnd, nextStart);
      }
    }
    return chars;
  }

  function lyricLinesFromText("""
text = text[:i0] + new_fn + text[i1 + len(old_end):]
with io.open(str(p), "w", encoding="utf-8", newline="") as f:
    f.write(text.replace("\n", nl))
print("OK: expandTimedChars rewritten")
