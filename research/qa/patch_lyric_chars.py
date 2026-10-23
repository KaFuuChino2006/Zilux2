# -*- coding: utf-8 -*-
"""Web 侧：逐字歌词数据链路（yrc/qrc 解析 + 每字横向范围 + 逐字扫光进度）。"""
import io


def patch_file(path, pairs):
    s = io.open(path, 'r', encoding='utf-8', newline='').read()
    for old, new, label in pairs:
        assert s.count(old) == 1, f"anchor miss {label}: {old[:70]!r}"
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print('patched', path)


BASE = r"E:\Zilux2开发\web\src"

# 1) OnlineLyric 增加 yrc 字段
patch_file(
    BASE + r"\online\types.ts",
    [(
        """  translation: string | null;
  hasTranslation: boolean;
}""",
        """  translation: string | null;
  hasTranslation: boolean;
  /** 逐字歌词原文（YRC/QRC 同构：`[start,dur](start,dur)字…`），可空 */
  yrc?: string | null;
  hasYrc?: boolean;
}""",
        "OnlineLyric.yrc",
    )],
)

# 2) lrc.ts 追加逐字解析
lrc_path = BASE + r"\online\lrc.ts"
s = io.open(lrc_path, 'r', encoding='utf-8', newline='').read()
assert 'parseCharLyric' not in s
s += """
/** 逐字歌词里的一个字（毫秒） */
export interface LyricChar {
  text: string;
  startMs: number;
  endMs: number;
}

/** 逐字歌词的一行 */
export interface LyricCharLine {
  timeMs: number;
  durationMs: number;
  chars: LyricChar[];
}

const CHAR_LINE = /^\\[(\\d+),(\\d+)\\](.*)$/;
const CHAR_TOKEN = /\\((\\d+),(\\d+)(?:,\\d+)?\\)([^()]*)/g;

/**
 * 解析逐字歌词。网易云 yrc 与 QQ qrc 同构：
 * 每行 `[行开始,行时长]`，字用 `(字开始,字时长)` 前缀，例如
 * `[1000,2000](1000,200)你(1200,200)好`。
 */
export function parseCharLyric(raw: string | null | undefined): LyricCharLine[] {
  if (!raw) return [];
  const out: LyricCharLine[] = [];
  for (const rawLine of raw.split(/\\r?\\n/)) {
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
    while ((token = CHAR_TOKEN.exec(body))) {
      const startMs = Number(token[1]);
      const charDur = Number(token[2]);
      if (!Number.isFinite(startMs)) continue;
      const text = (token[3] ?? '').trim();
      if (!text) continue;
      chars.push({ text, startMs, endMs: startMs + (Number.isFinite(charDur) ? charDur : 0) });
    }
    if (chars.length > 0) out.push({ timeMs, durationMs, chars });
  }
  return out;
}
"""
io.open(lrc_path, 'w', encoding='utf-8', newline='').write(s)
print('patched', lrc_path)

# 3) spaceShell：导入解析器 + 逐字时间轴挂到每行
patch_file(
    BASE + r"\ui\spaceShell.ts",
    [
        (
            "import { applyTranslation, parseLrc } from '../online/lrc';",
            "import { applyTranslation, parseCharLyric, parseLrc } from '../online/lrc';",
            "import parseCharLyric",
        ),
        (
            """      const lines: LyricLineData[] = parsed.map((line) => ({
        text: line.text,
        translation: line.translation,
        startTime: line.timeMs / 1000,
      }));""",
            """      // 逐字时间轴：优先用 yrc/qrc；没有时按行时长把整句均分给每个字（也能逐字点亮）
      const charLines = parseCharLyric(lyric.yrc);
      const lines: LyricLineData[] = parsed.map((line, index) => {
        const start = line.timeMs / 1000;
        const nextStart = parsed[index + 1]?.timeMs ?? 0;
        const end = nextStart > line.timeMs ? Math.min(nextStart / 1000, start + 8) : start + 4;
        const glyphs = Array.from(line.text).filter((char) => char.trim().length > 0);
        const timed = charLines.find((entry) => Math.abs(entry.timeMs - line.timeMs) <= 260);
        let chars = timed
          ? timed.chars.map((char) => ({ text: char.text, start: char.startMs / 1000, end: char.endMs / 1000 }))
          : [];
        if (chars.length === 0 && glyphs.length > 0) {
          const span = Math.max(0.4, end - start) / glyphs.length;
          chars = glyphs.map((char, i) => ({ text: char, start: start + i * span, end: start + (i + 1) * span }));
        }
        return {
          text: line.text,
          translation: line.translation,
          startTime: start,
          chars: chars.length > 0 ? chars : undefined,
        };
      });""",
            "loadLyrics3d chars",
        ),
    ],
)

# 4) floatScene：类型、每字横向范围、逐字扫光
patch_file(
    BASE + r"\three\floatScene.ts",
    [
        (
            """export interface LyricLineData {
  text: string;
  translation?: string;
  startTime: number;
}""",
            """export interface LyricLineData {
  text: string;
  translation?: string;
  startTime: number;
  /** 逐字时间轴（秒）：有则可按字逐个点亮 */
  chars?: Array<{ text: string; start: number; end: number }>;
}""",
            "LyricLineData.chars",
        ),
        (
            """  text: string;
  translation: string;
  active: boolean;
}""",
            """  text: string;
  translation: string;
  active: boolean;
  /** 单行显示时每个字的横向范围（0~1 归一化），用于逐字扫光 */
  charBoxes: Array<{ x0: number; x1: number }>;
}""",
            "LyricLineView.charBoxes",
        ),
        (
            """  function paintLyricLine(view: LyricLineView): void {""",
            """  /** 与 drawLyricText 一致，但单行时额外记录每个字的横向范围（像素） */
  function drawLyricTextWithBoxes(
    ctx: CanvasRenderingContext2D,
    text: string,
    centerX: number,
    centerY: number,
    maxWidth: number,
    maxLines: number,
    baseSize: number,
    minSize: number,
    weight: number,
  ): Array<{ x0: number; x1: number }> {
    if (!text) return [];
    const size = fitLyricFontSize(ctx, text, maxWidth, baseSize, minSize, weight);
    let lines = [text];
    if (ctx.measureText(text).width > maxWidth) {
      lines = [];
      const perLine = Math.max(1, Math.ceil(text.length / maxLines));
      for (let i = 0; i < text.length; i += perLine) lines.push(text.slice(i, i + perLine));
    }
    const lineHeight = size * 1.16;
    const startY = centerY - ((lines.length - 1) * lineHeight) / 2;
    const boxes: Array<{ x0: number; x1: number }> = [];
    lines.forEach((line, index) => {
      const y = startY + index * lineHeight;
      if (lines.length === 1) {
        const glyphs = Array.from(line);
        const total = ctx.measureText(line).width;
        let cursor = centerX - total / 2;
        for (const glyph of glyphs) {
          const width = ctx.measureText(glyph).width;
          if (glyph.trim().length > 0) boxes.push({ x0: cursor, x1: cursor + width });
          cursor += width;
        }
      }
      ctx.fillText(line, centerX, y);
    });
    return lines.length === 1 ? boxes : [];
  }

  /** 逐字扫光位置：返回当前应点亮到 x 比例（0~1） */
  function lyricRevealFor(view: LyricLineView): number {
    const chars = lyricData[view.index]?.chars;
    if (chars && chars.length > 1 && view.charBoxes.length === chars.length) {
      let index = -1;
      for (let i = 0; i < chars.length; i += 1) {
        if (chars[i].start <= lyricClock) index = i;
        else break;
      }
      if (index < 0) return 0;
      if (index >= chars.length - 1) {
        const last = chars[index];
        const span = Math.max(0.05, last.end - last.start);
        const frac = Math.min(1, Math.max(0, (lyricClock - last.start) / span));
        const box = view.charBoxes[index];
        return box.x0 + (box.x1 - box.x0) * frac;
      }
      const box = view.charBoxes[index];
      const char = chars[index];
      const span = Math.max(0.05, char.end - char.start);
      const frac = Math.min(1, Math.max(0, (lyricClock - char.start) / span));
      return box.x0 + (box.x1 - box.x0) * frac;
    }
    return lyricProgress;
  }

  function paintLyricLine(view: LyricLineView): void {""",
            "drawLyricTextWithBoxes",
        ),
        (
            """    ctx.fillStyle = 'rgba(255,255,255,1)';
    drawLyricText(ctx, view.text, W / 2, mainY, W * 0.94, 2, 56, 34, 700);""",
            """    ctx.fillStyle = 'rgba(255,255,255,1)';
    view.charBoxes = drawLyricTextWithBoxes(ctx, view.text, W / 2, mainY, W * 0.94, 2, 56, 34, 700).map(
      (box) => ({ x0: box.x0 / W, x1: box.x1 / W }),
    );""",
            "paintLyricLine boxes",
        ),
        (
            """        text: '',
        translation: '',
        active: false,
        amount: 0,
      };""",
            """        text: '',
        translation: '',
        active: false,
        charBoxes: [],
        amount: 0,
      };""",
            "view creation charBoxes",
        ),
        (
            """  let lyricProgress = 0;""",
            """  let lyricProgress = 0;
  let lyricClock = 0;""",
            "lyricClock state",
        ),
        (
            """    material.uniforms.uProgress!.value = lyricProgress;""",
            """    material.uniforms.uProgress!.value = lyricRevealFor(view);""",
            "uniform char reveal",
        ),
        (
            """    setLyricsTime(current: number) {
      if (!lyricVisible || lyricData.length === 0) return;""",
            """    setLyricsTime(current: number) {
      lyricClock = current;
      if (!lyricVisible || lyricData.length === 0) return;""",
            "setLyricsTime lyricClock",
        ),
    ],
)
print('web char lyric patch done')
