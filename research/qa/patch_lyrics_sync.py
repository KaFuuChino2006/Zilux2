# -*- coding: utf-8 -*-
"""歌词页：补播放进度条/时间 + 无逐词数据时按行内均匀切分逐字 + 强化整行高亮。"""
import io

LYR = r'E:\Zilux2开发\web\src\ui\lyrics.ts'
CSS = r'E:\Zilux2开发\web\src\styles\app.css'

text = io.open(LYR, 'r', encoding='utf-8', newline='').read()
eol = '\r\n' if '\r\n' in text else '\n'


def rep(old, new, label):
    global text
    old = old.replace('\n', eol)
    new = new.replace('\n', eol)
    assert text.count(old) == 1, 'anchor miss: ' + label
    text = text.replace(old, new)
    print('ok:', label)


# 1) 引入 fmtTime
rep("import { h, icon } from './dom';", "import { fmtTime, h, icon } from './dom';", 'fmtTime import')

# 2) toDocLines：无逐词数据且是中文时，按行时长均匀切分成「字」
old_doc = """function toDocLines(parsed: SourceLine[]): LyricLine[] {
  return parsed.map((line, index) => {
    const next = parsed[index + 1];
    const start = line.timeMs;
    const end = next ? next.timeMs : start + 4200;
    const sourceWords = line.words ?? [];
    const words: LyricWord[] = sourceWords.map((word, wordIndex) => {
      const nextWord = sourceWords[wordIndex + 1];
      return {
        text: word.text,
        startMs: word.startMs,
        endMs: nextWord ? nextWord.startMs : end,
      };
    });"""
new_doc = """const CJK = /[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af]/;

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
      };
    });
    if (words.length === 0) words = splitEvenly(line.text, start, end);"""
rep(old_doc, new_doc, 'toDocLines even split')

# 3) 字段
rep(
    "  private linesEl: HTMLDivElement;\n  private bgEl: HTMLDivElement;",
    "  private linesEl: HTMLDivElement;\n  private progressFill: HTMLDivElement;\n  private progressCur: HTMLSpanElement;\n  private progressDur: HTMLSpanElement;\n  private bgEl: HTMLDivElement;",
    'progress fields',
)

# 4) 构造：左侧加进度
rep(
    "          h('div', { class: 'lyrics-meta' }, this.titleEl, this.artistEl),",
    """          h('div', { class: 'lyrics-meta' }, this.titleEl, this.artistEl),
          h(
            'div',
            { class: 'lyrics-progress' },
            h('div', { class: 'lyrics-progress-track' }, this.progressFill),
            h('div', { class: 'lyrics-progress-time' }, this.progressCur, this.progressDur),
          ),""",
    'progress dom',
)
rep(
    "    this.linesEl = h('div', { class: 'lyrics-lines' });",
    """    this.linesEl = h('div', { class: 'lyrics-lines' });
    this.progressFill = h('div', { class: 'lyrics-progress-fill' });
    this.progressCur = h('span', { class: 'lyrics-progress-cur', text: '00:00' });
    this.progressDur = h('span', { class: 'lyrics-progress-dur', text: '00:00' });""",
    'progress nodes',
)

# 5) syncProgress：更新进度条与时间
rep(
    """  private syncProgress(force = false): void {
    const state = this.state;
    if (!state || this.doc.lines.length === 0) return;""",
    """  private syncProgress(force = false): void {
    const state = this.state;
    if (!state) return;
    const duration = state.durationMs || 0;
    const percent = duration > 0 ? Math.min(100, Math.max(0, (state.positionMs / duration) * 100)) : 0;
    this.progressFill.style.width = `${percent}%`;
    this.progressCur.textContent = fmtTime(state.positionMs);
    this.progressDur.textContent = fmtTime(duration);
    if (this.doc.lines.length === 0) return;""",
    'progress sync',
)
rep(
    "    this.emptyEl.style.display = this.doc.lines.length === 0 ? '' : 'none';",
    "    this.emptyEl.style.display = this.doc.lines.length === 0 ? '' : 'none';\n    this.progressFill.style.width = '0%';",
    'empty progress reset',
)

io.open(LYR, 'w', encoding='utf-8', newline='').write(text)

# 6) CSS
css = io.open(CSS, 'r', encoding='utf-8', newline='').read()
ceol = '\r\n' if '\r\n' in css else '\n'
block = """
/* ==================== 歌词页：进度条 + 更强的整行/逐词高亮 ==================== */
.lyrics-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
}
.lyrics-progress-track {
  position: relative;
  height: 4px;
  border-radius: 2px;
  background: rgb(var(--overlay-rgb) / 0.16);
  overflow: hidden;
}
.lyrics-progress-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0;
  border-radius: 2px;
  background: var(--accent);
  transition: width 0.16s linear;
}
.lyrics-progress-time {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.lyrics-right .lyric-line {
  opacity: 0.5;
  transition:
    color var(--dur-mid) var(--ease),
    opacity var(--dur-mid) var(--ease),
    transform var(--dur-pop) var(--ease-pop);
}
.lyrics-right .lyric-line.is-near {
  opacity: 0.72;
}
.lyrics-right .lyric-line.is-active {
  opacity: 1;
  transform: translateX(6px) scale(1.015);
  transform-origin: 0% 50%;
}
.lyrics-right .lyric-line.is-active::before {
  content: '';
  position: absolute;
  left: -18px;
  top: 50%;
  width: 4px;
  height: 62%;
  transform: translateY(-50%);
  border-radius: 2px;
  background: var(--accent);
  box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 70%, transparent);
}
.lyrics-right .lyric-line {
  position: relative;
}
.lyrics-right .lyric-line.is-active .lyric-char:not(.is-sung):not(.is-hot) {
  color: rgb(var(--overlay-rgb) / 0.42);
}
""".replace('\n', ceol)
if '歌词页：进度条' not in css:
    css += block
    io.open(CSS, 'w', encoding='utf-8', newline='').write(css)
    print('css appended')
else:
    print('css already')

print('done')
