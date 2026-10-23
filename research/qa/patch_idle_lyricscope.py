# -*- coding: utf-8 -*-
"""磁贴漂浮/微旋转只在歌词模式生效；切歌立即清空上一首歌词"""
import io

F = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(F, 'r', encoding='utf-8', newline='').read()

old = "      const idleAmp = (1 - focusAmount * 0.8) * (1 - scatterEase);\n"
new = """      // 只在歌词模式（歌词界面打开、磁贴变成漂浮状态）下启用漂浮与随机旋转
      const idleAmp = lyricAmount * (1 - focusAmount * 0.8);
"""
assert s.count(old) == 1
s = s.replace(old, new, 1)
io.open(F, 'w', encoding='utf-8', newline='').write(s)

S = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
t = io.open(S, 'r', encoding='utf-8', newline='').read()
old2 = """    lyricsTrackKey = key;
    try {
      const lyric = await fetchLyric(track.source, track.id);
"""
new2 = """    lyricsTrackKey = key;
    // 切歌立刻清掉上一首的歌词（新歌前奏期间不要残留旧文字）
    space?.setLyrics([]);
    try {
      const lyric = await fetchLyric(track.source, track.id);
"""
assert t.count(old2) == 1
t = t.replace(old2, new2, 1)
io.open(S, 'w', encoding='utf-8', newline='').write(t)
print('patched idle scope + clear lyrics on track change')
