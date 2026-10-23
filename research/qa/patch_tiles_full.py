# -*- coding: utf-8 -*-
"""磁贴铺满全窗口 + 上下俯仰角度范围/灵敏度加大。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 网格铺满：13 列 × 8 行，单元格 0.98，垂直居中
old = """  const TILE_COLS = 6;
  const TILE_ROWS = 4;
  const TILE_SIZE = 1.02;
  const TILE_POOL = TILE_COLS * TILE_ROWS;
  const TILE_TOP = 1.9;"""
new = """  const TILE_COLS = 13;
  const TILE_ROWS = 8;
  const TILE_SIZE = 0.98;
  const TILE_POOL = TILE_COLS * TILE_ROWS;
  // 让磁贴网格在屏幕垂直方向居中
  const TILE_TOP = ((TILE_ROWS - 1) / 2) * TILE_SIZE;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) 磁贴纹理 512 → 320（104 块控制显存）
s = s.replace("    tileCanvas.width = 512;\n    tileCanvas.height = 512;",
              "    tileCanvas.width = 320;\n    tileCanvas.height = 320;", 1)

# 3) 上下俯仰：范围 1°~55°，灵敏度提高，默认更斜一点
old = "  let orbitPitch = 0.2;"
new = "  let orbitPitch = 0.3;"
assert s.count(old) == 1
s = s.replace(old, new, 1)
old = "  let orbitPitchTarget = 0.2;"
new = "  let orbitPitchTarget = 0.3;"
assert s.count(old) == 1
s = s.replace(old, new, 1)
s = s.replace("orbitPitchTarget = Math.min(0.63, Math.max(0.03, orbitPitchTarget + dy * 0.0042));",
              "orbitPitchTarget = Math.min(0.95, Math.max(0.02, orbitPitchTarget + dy * 0.0068));", 1)
s = s.replace("pitchVelocity = dy * 0.0042 * 0.55;",
              "pitchVelocity = dy * 0.0068 * 0.55;", 1)
s = s.replace("orbitPitchTarget = Math.min(0.63, Math.max(0.03, orbitPitchTarget + pitchVelocity));",
              "orbitPitchTarget = Math.min(0.95, Math.max(0.02, orbitPitchTarget + pitchVelocity));", 1)

# 4) 相机略拉远，保证 8 行磁贴铺满且能看到边缘
s = s.replace("  const ORBIT_RADIUS = 8.9;", "  const ORBIT_RADIUS = 9.2;", 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('tiles fullscreen + pitch range done')
