# -*- coding: utf-8 -*-
"""聚焦详情时点击空白处缩小回磁贴墙。"""
import io

# 1) floatScene: 空白点击回调
p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()
old = "    if (hoveredFeature >= 0 && !songMode) {"
new = """    // 聚焦详情时点空白处 → 收缩回磁贴墙
    if (focusIndex >= 0) {
      options.onTileClick?.(-1);
      return;
    }
    if (hoveredFeature >= 0 && !songMode) {"""
assert s.count(old) == 1, 'feature anchor missing'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

# 2) spaceShell: -1 表示退出聚焦
p2 = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s2 = io.open(p2, 'r', encoding='utf-8', newline='').read()
old2 = """    onTileClick: (index) => {
      if (!tileTracks[index]) {"""
new2 = """    onTileClick: (index) => {
      if (index < 0) {
        hideTileDetail();
        return;
      }
      if (!tileTracks[index]) {"""
assert s2.count(old2) == 1, 'tile click anchor missing'
s2 = s2.replace(old2, new2, 1)
io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
print('background click unfocus done')
