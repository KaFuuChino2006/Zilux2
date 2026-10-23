# -*- coding: utf-8 -*-
"""逐字歌词缺翻译时，允许借其它平台的翻译（不限于当前平台）。"""
import io

LM = r'E:\Zilux2开发\web\src\ui\lyricMatch.ts'
LY = r'E:\Zilux2开发\web\src\ui\lyrics.ts'


def read(path):
    return io.open(path, 'r', encoding='utf-8', newline='').read()


def write(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


def eol(text):
    return '\r\n' if '\r\n' in text else '\n'


# ---------- lyricMatch.ts ----------
t = read(LM)
nl = eol(t)
L = lambda s: s.replace('\n', nl)

anchor = L("  translationFromBase?: boolean;")
assert t.count(anchor) == 1, 'translationFromBase anchor'
t = t.replace(anchor, anchor + L("\n  /** 逐字来自候选平台、翻译取自另一个平台（例如 QQ 逐字 + 网易云翻译）。 */\n  translationFromOther?: string;"))

old_sig = L("""/** 把当前平台（LRC+翻译）的翻译贴到别的平台的逐字行上：逐字用候选平台、翻译用原平台。 */
function attachBaseTranslation(lines: LyricLine[], baseLines: LyricLine[]): boolean {
  const translated = baseLines.filter((line) => (line.translation ?? '').trim().length > 0);""")
new_sig = L("""/** 把某个平台（LRC+翻译）的翻译贴到逐字行上：逐字用候选平台、翻译可来自任意平台。 */
function attachTranslationLines(lines: LyricLine[], sourceLines: LyricLine[]): boolean {
  const translated = sourceLines.filter((line) => (line.translation ?? '').trim().length > 0);""")
assert t.count(old_sig) == 1, 'attach signature'
t = t.replace(old_sig, new_sig)

old_best = L("  let best: LyricMatchResult | null = null;\n")
assert t.count(old_best) == 1, 'best init'
t = t.replace(old_best, L("""  let best: LyricMatchResult | null = null;
  let bestTranslation: { lines: LyricLine[]; label: string; meta: number } | null = null;
"""))

old_cont = L("      if (!text.trim()) continue;\n")
assert t.count(old_cont) == 1, 'text continue'
t = t.replace(old_cont, L("""      if (!text.trim()) continue;
      // 顺手记下这个平台的翻译（逐字时间轴可以来自别的平台，翻译借来贴即可）。
      if (!word?.hasTranslation && (lyric.translation ?? '').trim()) {
        const translated = parseLrc(lyric.translation).filter((line) => line.text.trim().length > 0);
        if (translated.length > 0 && (!bestTranslation || meta > bestTranslation.meta)) {
          bestTranslation = { lines: translated, label: labelOf(source, 'lrc'), meta };
        }
      }
"""))

start = t.find(L("  // 当前平台是「LRC + 翻译」"))
end = t.find(L("  cache.set(cacheKey, best);"), start)
assert start > 0 and end > start, 'merge block bounds'
new_merge = L("""  // 逐字版没有翻译时，按优先级借翻译：先当前平台（LRC+翻译），再其它平台带翻译的歌词。
  if (best?.lines && !best.hasTranslation) {
    if (baseHasTranslation && attachTranslationLines(best.lines, baseLines)) {
      best = { ...best, hasTranslation: true, translationFromBase: true };
    } else if (bestTranslation && attachTranslationLines(best.lines, bestTranslation.lines)) {
      best = { ...best, hasTranslation: true, translationFromOther: bestTranslation.label };
    }
  }

""")
t = t[:start] + new_merge + t[end:]
write(LM, t)
print('lyricMatch ok')

# ---------- lyrics.ts ----------
t2 = read(LY)
nl2 = eol(t2)
L2 = lambda s: s.replace('\n', nl2)

old_text = L2("""  if (lyricMatchInfo.translationFromBase) {
    return `${base}（逐字来自对方平台，翻译取自当前平台）`;
  }""")
assert t2.count(old_text) == 1, 'match text branch'
t2 = t2.replace(old_text, old_text + L2("""
  if (lyricMatchInfo.translationFromOther) {
    return `${base}（逐字来自对方平台，翻译取自 ${lyricMatchInfo.translationFromOther}）`;
  }"""))

old_src = L2("""  if (info.translationFromBase) {
    return `${base} · 逐字 ${info.label} · 翻译取自当前平台`;
  }""")
assert t2.count(old_src) == 1, 'source text branch'
t2 = t2.replace(old_src, old_src + L2("""
  if (info.translationFromOther) {
    return `${base} · 逐字 ${info.label} · 翻译取自 ${info.translationFromOther}`;
  }"""))
write(LY, t2)
print('lyrics ok')
