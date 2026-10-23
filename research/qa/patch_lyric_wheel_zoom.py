# -*- coding: utf-8 -*-
"""歌词界面恢复鼠标滚轮缩放（滚轮改镜头距离）。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

def rep(old, new, cnt=1):
    global s
    assert s.count(old) == cnt, (s.count(old), old[:70])
    s = s.replace(old, new, cnt)

# 1) 歌词模式下也允许滚轮缩放
rep('''  const onWheel = (event: WheelEvent): void => {
    if (!entered || lyricVisible) return;
    event.preventDefault();
    // 滚轮 = 相机放大 / 缩小
    zoomTarget = Math.min(1.9, Math.max(0.42, zoomTarget * (1 + event.deltaY * 0.0012)));
  };''',
'''  const onWheel = (event: WheelEvent): void => {
    if (!entered) return;
    event.preventDefault();
    // 滚轮 = 相机放大 / 缩小（歌词界面同样生效，镜头绕当前句拉近/推远）
    zoomTarget = Math.min(1.9, Math.max(0.42, zoomTarget * (1 + event.deltaY * 0.0012)));
  };''')

# 2) 歌词镜头半径跟随 zoom（拉近/推远）
rep("      const radius = 4.6;",
    "      const radius = 4.6 / Math.max(0.5, Math.min(1.8, zoom));")

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('lyric view wheel zoom restored')
