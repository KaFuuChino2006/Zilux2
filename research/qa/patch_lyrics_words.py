# -*- coding: utf-8 -*-
"""逐词显示修正：英文单词不要被拆成字母逐个跳。

1) 新增 `groupLatinWords()`：把连续的单个拉丁字母/数字合并成一个单词（英文按词高亮）。
2) `splitEvenly()` 改为按「中文按字 / 英文按空格分词」切分，英文无逐字数据时也按词跳动，而不是整行。
"""
import io

PATH = r'E:\Zilux2开发\web\src\ui\lyrics.ts'
text = io.open(PATH, 'r', encoding='utf-8', newline='').read()
eol = '\r\n' if '\r\n' in text else '\n'


def rep(old, new, label):
    global text
    old = old.replace('\n', eol)
    new = new.replace('\n', eol)
    assert text.count(old) == 1, 'miss: ' + label
    text = text.replace(old, new)
    print('ok:', label)


old_split = """  if (!CJK.test(text)) return [];
  const chars = Array.from(text).filter((char) => char.trim().length > 0);
  if (chars.length < 2) return [];
  const step = Math.max(90, (end - start) / chars.length);
  return chars.map((char, index) => ({
    text: char,
    startMs: Math.round(start + index * step),
    endMs: Math.round(start + (index + 1) * step),
  }));
}
"""
new_split = """  // 中日韩按字切分；其它语言（英文等）按空格分词，避免把单词拆成字母逐个跳。
  const units = CJK.test(text)
    ? Array.from(text).filter((char) => char.trim().length > 0)
    : (text.match(/\\S+\\s*/g) ?? []).filter((word) => word.trim().length > 0);
  if (units.length < 2) return [];
  const step = Math.max(90, (end - start) / units.length);
  return units.map((unit, index) => ({
    text: unit,
    startMs: Math.round(start + index * step),
    endMs: Math.round(start + (index + 1) * step),
  }));
}

/** 单个字母/数字/连接符（英文单词被逐字母打点时会用到）。 */
const LATIN_CHAR = /^[A-Za-z0-9'’\\-&]+$/;

/**
 * 英文单词合并：QRC / yrc 常按字母给时间点，直接渲染会一个字母一个字母跳。
 * 把连续的「单字母」合并回一个单词（时间取首字母开始、末字母结束）；
 * 中文逐字保持不变；带空格/标点的整词条目原样保留。
 */
function groupLatinWords(words: LyricWord[]): LyricWord[] {
  const merged: LyricWord[] = [];
  let buffer: LyricWord | null = null;
  const flush = (): void => {
    if (buffer) merged.push(buffer);
    buffer = null;
  };
  for (const word of words) {
    const piece = word.text;
    if (LATIN_CHAR.test(piece)) {
      if (buffer) {
        buffer.text += piece;
        buffer.endMs = word.endMs;
      } else {
        buffer = { text: piece, startMs: word.startMs, endMs: word.endMs };
      }
      continue;
    }
    flush();
    merged.push({ ...word });
  }
  flush();
  return merged;
}
"""
rep(old_split, new_split, 'splitEvenly + groupLatinWords')

rep("    if (words.length === 0) words = splitEvenly(line.text, start, end);",
    "    words = groupLatinWords(words);\n    if (words.length === 0) words = splitEvenly(line.text, start, end);",
    'toDocLines group')

rep("            words: line.words.map((word) => ({ ...word })),",
    "            words: groupLatinWords(line.words.map((word) => ({ ...word }))),",
    'qrc group')

rep("          words: line.chars.map((char) => ({ text: char.text, startMs: char.startMs, endMs: char.endMs })),",
    "          words: groupLatinWords(line.chars.map((char) => ({ text: char.text, startMs: char.startMs, endMs: char.endMs }))),",
    'yrc group')

io.open(PATH, 'w', encoding='utf-8', newline='').write(text)
print('lyrics.ts written')
