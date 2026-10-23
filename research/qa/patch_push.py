# -*- coding: utf-8 -*-
"""加大聚焦让位幅度，减少放大磁贴与邻居重叠。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

old = """        const freach = TILE_SIZE * layoutScale * 3.4;
        if (fdist < freach) {
          const famount = (1 - fdist / freach) * 0.85 * focusAmount;"""
new = """        const freach = TILE_SIZE * layoutScale * 4.2;
        if (fdist < freach) {
          const famount = (1 - fdist / freach) * 1.25 * focusAmount;"""
assert s.count(old) == 1, 'focus push block missing'
s = s.replace(old, new, 1)

old = "        const grow = 1 + focusAmount * 1.28;"
new = "        const grow = 1 + focusAmount * 1.18;"
assert s.count(old) == 1, 'grow line missing'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('push amount increased')
