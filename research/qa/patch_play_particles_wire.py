# -*- coding: utf-8 -*-
"""接线：handle 增加 setPlaying，播放状态驱动粒子增强。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

def rep(old, new, file_content, cnt=1):
    assert file_content.count(old) == cnt, (file_content.count(old), old[:80])
    return file_content.replace(old, new, cnt)

s = rep("  setTileBend(bend: number): void;",
        "  setTileBend(bend: number): void;\n  setPlaying(playing: boolean): void;",
        s)

io.open(p, 'w', encoding='utf-8', newline='').write(s)

p2 = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s2 = io.open(p2, 'r', encoding='utf-8', newline='').read()
s2 = rep("""    onStateChange: (state) => {
      if (state.playing) {""",
"""    onStateChange: (state) => {
      // 播放时让空间粒子更丰富（暂停/停止回落）
      space?.setPlaying(state.playing);
      if (state.playing) {""", s2)
io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
print('setPlaying wired')
