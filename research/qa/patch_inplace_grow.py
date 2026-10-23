# -*- coding: utf-8 -*-
"""m09432：被点封面在原位放大（原磁贴本体），不做中央卡；周围封面仅渐进模糊。"""
import io

# ---------- floatScene.ts：聚焦磁贴原位放大，放大更明显 ----------
p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

old = """      if (isFocusTarget && focusAmount > 0.001) {
        const grow = 1 + focusAmount * 0.12;
        tile.group.scale.setScalar(layoutScale * grow * (0.94 + 0.06 * appear));"""
new = """      if (isFocusTarget && focusAmount > 0.001) {
        // 原位置放大（不做位移），放大到 1.55 倍左右
        const grow = 1 + focusAmount * 0.55;
        tile.group.scale.setScalar(layoutScale * grow * (0.94 + 0.06 * appear));"""
if s.count(old) != 1:
    raise SystemExit(f'grow: {s.count(old)}')
s = s.replace(old, new, 1)

# 聚焦时轻微前移，避免放大后与其他磁贴 z 冲突
old2 = """        tile.group.position.z = 0.1 + t * 0.26 + sel * 0.22 - focusWeight * 0.85;"""
new2 = """        tile.group.position.z = 0.1 + t * 0.26 + sel * 0.22 - focusWeight * 0.85;"""
# 聚焦磁贴前移写在 isFocusTarget 分支里
old3 = """        tile.group.scale.setScalar(layoutScale * grow * (0.94 + 0.06 * appear));"""
new3 = """        tile.group.scale.setScalar(layoutScale * grow * (0.94 + 0.06 * appear));
        tile.group.position.z += focusAmount * 0.22;"""
if s.count(old3) != 1:
    raise SystemExit(f'forward: {s.count(old3)}')
s = s.replace(old3, new3, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('floatScene: in-place grow')

# ---------- space.css：隐藏中央卡，只保留模糊层 ----------
p2 = r'E:\Zilux2开发\web\src\styles\space.css'
c = io.open(p2, 'r', encoding='utf-8', newline='').read()
old4 = """.tile-detail-card {
  width: min(50vh, 440px);"""
new4 = """.tile-detail-card {
  display: none !important;
  width: min(50vh, 440px);"""
if c.count(old4) != 1:
    raise SystemExit(f'card css: {c.count(old4)}')
c = c.replace(old4, new4, 1)
io.open(p2, 'w', encoding='utf-8', newline='').write(c)
print('space.css: central card hidden')
