# -*- coding: utf-8 -*-
"""匹配歌词窗口：预览实时跟随播放进度 + QRC/YRC 也显示翻译。"""
import io

def read(path):
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        text = f.read()
    eol = '\r\n' if '\r\n' in text else '\n'
    return text, eol

def write(path, text):
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)

def apply(path, label, edits):
    text, eol = read(path)
    for idx, (old, new) in enumerate(edits, 1):
        old2 = old.replace('\n', eol)
        new2 = new.replace('\n', eol)
        count = text.count(old2)
        if count != 1:
            raise SystemExit('%s: 第 %d 处锚点命中 %d 次 -> %r' % (label, idx, count, old2[:70]))
        text = text.replace(old2, new2)
    write(path, text)
    print('OK %s (%d 处)' % (label, len(edits)))

picker = r'E:\Zilux2开发\web\src\ui\lyricPicker.ts'
apply(picker, 'lyricPicker', [
# 1) 顶部先算翻译行，供 QRC/YRC/LRC 三个分支共用
("""function previewLines(lyric: OnlineLyric): { lines: PreviewLine[]; word: boolean; translation: boolean } {
  const trimmed = (value: string | null | undefined): string => (value ?? '').trim();
""",
"""function previewLines(lyric: OnlineLyric): { lines: PreviewLine[]; word: boolean; translation: boolean } {
  const trimmed = (value: string | null | undefined): string => (value ?? '').trim();
  const translationLines = trimmed(lyric.translation) ? parseLrc(lyric.translation ?? '') : [];
  const pickTranslation = (timeMs: number): string | undefined =>
    translationLines.find((item) => Math.abs(item.timeMs - timeMs) <= 500)?.text;
"""),
# 2) QRC 分支（12 空格缩进）
("""            timeMs: line.timeMs,
            text: line.words.map((word) => word.text).join(''),
            word: true,
            words: line.words.map((word) => ({ text: word.text, startMs: word.startMs, endMs: word.endMs })),
          })),
          word: true,
          translation: false,""",
"""            timeMs: line.timeMs,
            text: line.words.map((word) => word.text).join(''),
            translation: pickTranslation(line.timeMs),
            word: true,
            words: line.words.map((word) => ({ text: word.text, startMs: word.startMs, endMs: word.endMs })),
          })),
          word: true,
          translation: translationLines.length > 0,"""),
# 3) YRC 分支（10 空格缩进）
("""          timeMs: line.timeMs,
          text: line.chars.map((char) => char.text).join(''),
          word: true,
          words: line.chars.map((char) => ({ text: char.text, startMs: char.startMs, endMs: char.endMs })),
        })),
        word: true,
        translation: false,""",
"""          timeMs: line.timeMs,
          text: line.chars.map((char) => char.text).join(''),
          translation: pickTranslation(line.timeMs),
          word: true,
          words: line.chars.map((char) => ({ text: char.text, startMs: char.startMs, endMs: char.endMs })),
        })),
        word: true,
        translation: translationLines.length > 0,"""),
# 4) LRC 分支复用翻译行
("""  const base = parseLrc(lyric.lrc ?? '');
  const translated = trimmed(lyric.translation) ? parseLrc(lyric.translation ?? '') : [];
  return {
    lines: base.slice(0, PREVIEW_LINES).map((line) => ({
      timeMs: line.timeMs,
      text: line.text,
      translation: translated.find((item) => Math.abs(item.timeMs - line.timeMs) <= 500)?.text,
      word: false,
    })),
    word: false,
    translation: translated.length > 0,
  };""",
"""  const base = parseLrc(lyric.lrc ?? '');
  return {
    lines: base.slice(0, PREVIEW_LINES).map((line) => ({
      timeMs: line.timeMs,
      text: line.text,
      translation: pickTranslation(line.timeMs),
      word: false,
    })),
    word: false,
    translation: translationLines.length > 0,
  };"""),
# 5) 独立 rAF 循环驱动预览进度（不依赖 onPlayer 推送时机）
("""  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    root.classList.add('is-leaving');
    unsubscribePlayer();""",
"""  let closing = false;
  // 预览进度用独立 rAF 驱动：不依赖播放状态推送的时机，打开期间始终跟着当前播放位置走。
  let rafId = 0;
  const progressLoop = (): void => {
    if (closing) return;
    syncPreviewProgress();
    rafId = window.requestAnimationFrame(progressLoop);
  };
  rafId = window.requestAnimationFrame(progressLoop);
  const close = (): void => {
    if (closing) return;
    closing = true;
    window.cancelAnimationFrame(rafId);
    root.classList.add('is-leaving');
    unsubscribePlayer();"""),
])
