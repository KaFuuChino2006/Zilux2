# -*- coding: utf-8 -*-
"""接通「匹配歌词」窗口 + 精简封面下方来源注释。"""
import io

LM = r'E:\Zilux2开发\web\src\ui\lyricMatch.ts'
LY = r'E:\Zilux2开发\web\src\ui\lyrics.ts'
APP = r'E:\Zilux2开发\web\src\ui\app.ts'


def read(path):
    return io.open(path, 'r', encoding='utf-8', newline='').read()


def write(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


# ---------- 1. lyricMatch 暴露借接口 ----------
t = read(LM)
nl = '\r\n' if '\r\n' in t else '\n'
L = lambda s: s.replace('\n', nl)
anchor = L("export function matchCacheSize(): number {")
assert t.count(anchor) == 1
t = t.replace(anchor, L("""/** 供「匹配歌词」窗口复用：歌名/歌手/时长匹配度（0~1）。 */
export function metaMatchScore(track: OnlineTrack, candidate: OnlineTrack): number {
  return metaScore(track, candidate);
}

/** 供「匹配歌词」窗口复用：搜索关键词（由宽到窄）。 */
export function candidateQueries(track: OnlineTrack): string[] {
  return searchQueries(track);
}

export function matchCacheSize(): number {"""))
write(LM, t)
print('lyricMatch exports ok')

# ---------- 2. 精简来源注释 ----------
t2 = read(LY)
nl2 = '\r\n' if '\r\n' in t2 else '\n'
L2 = lambda s: s.replace('\n', nl2)
old = L2("""  if (info.translationFromBase) {
    return `${base} · 逐字 ${info.label} · 翻译取自当前平台`;
  }
  if (info.translationFromOther) {
    return `${base} · 逐字 ${info.label} · 翻译取自 ${info.translationFromOther}`;
  }""")
assert t2.count(old) == 1, 'source note branches'
t2 = t2.replace(old, L2("""  if (info.translationFromBase) {
    return `${base} · 翻译取自当前平台`;
  }
  if (info.translationFromOther) {
    return `${base} · 翻译取自 ${info.translationFromOther}`;
  }"""))
write(LY, t2)
print('lyrics note ok')

# ---------- 3. app.ts 接入按钮 ----------
t3 = read(APP)
nl3 = '\r\n' if '\r\n' in t3 else '\n'
L3 = lambda s: s.replace('\n', nl3)
anchor3 = L3("          cell('歌词来源', true, sourceValue),")
assert t3.count(anchor3) == 1, 'lyric source cell'
t3 = t3.replace(anchor3, anchor3 + L3("""
          cell(
            '手动选择',
            true,
            (() => {
              const button = h('button', { class: 'btn btn-ghost lp-open', text: '匹配歌词…（自己选平台）' });
              button.addEventListener('pointerdown', (event) => {
                event.preventDefault();
                event.stopPropagation();
              });
              button.addEventListener('click', () => openLyricPicker(playerState().track));
              return button;
            })(),
          ),"""))

imp = L3("import { openLyrics } from './lyrics';")
if t3.count(imp) == 1:
    pass
# 找 lyrics 相关 import 行，追加 openLyricPicker
import re
m = re.search(r"import \{[^}]*\} from '\./lyrics';", t3)
assert m, 'lyrics import'
line = m.group(0)
if 'openLyricPicker' not in t3:
    t3 = t3.replace(line, line + L3("\nimport { openLyricPicker } from './lyricPicker';"))
write(APP, t3)
print('app wired ok')
