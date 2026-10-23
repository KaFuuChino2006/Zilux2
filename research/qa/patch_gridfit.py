# -*- coding: utf-8 -*-
"""磁贴墙视口自适应：按视口宽高比自动放大磁贴网格，最大化/超宽屏下仍铺满窗口（比例问题修复）。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 网格尺寸随视口缩放：tileSlot 使用 layoutScale
old = """  function tileSlot(index: number): { x: number; y: number } {
    const col = index % TILE_COLS;
    const row = Math.floor(index / TILE_COLS);
    return {
      x: (col - (TILE_COLS - 1) / 2) * TILE_SIZE,
      y: TILE_TOP - row * TILE_SIZE,
    };
  }"""
new = """  let layoutScale = 1;

  function tileSlot(index: number): { x: number; y: number } {
    const size = TILE_SIZE * layoutScale;
    const col = index % TILE_COLS;
    const row = Math.floor(index / TILE_COLS);
    return {
      x: (col - (TILE_COLS - 1) / 2) * size,
      y: ((TILE_ROWS - 1) / 2 - row) * size,
    };
  }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) 删除不再使用的 TILE_TOP 常量
old = "  const TILE_TOP = ((TILE_ROWS - 1) / 2) * TILE_SIZE;\n"
assert s.count(old) == 1
s = s.replace(old, "", 1)

# 3) 磁贴本体随 layoutScale 放大
old = "      tile.group.scale.setScalar((0.94 + 0.06 * appear) * (1 + t * 0.11 + sel * 0.07));"
new = "      tile.group.scale.setScalar(\n        layoutScale * (0.94 + 0.06 * appear) * (1 + t * 0.11 + sel * 0.07),\n      );"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 4) resize 中按视口计算 layoutScale（保证磁贴墙铺满窗口，避免最大化后左右留白）
old = """  function resize(): void {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    if (width <= 0 || height <= 0) return;
    const pr = pickPixelRatio(width, height, { maxDpr: 2, minScale: 0.72, budget: 4_600_000 });
    renderer.setPixelRatio(pr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    starMaterial.uniforms.uPixelRatio!.value = pr;
  }"""
new = """  function resize(): void {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    if (width <= 0 || height <= 0) return;
    const pr = pickPixelRatio(width, height, { maxDpr: 2, minScale: 0.72, budget: 4_600_000 });
    renderer.setPixelRatio(pr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    starMaterial.uniforms.uPixelRatio!.value = pr;
    // 按视口宽高比放大磁贴网格：宽屏/最大化时也要铺满窗口
    const viewHeight = 2 * ORBIT_RADIUS * Math.tan((camera.fov * Math.PI) / 360);
    const viewWidth = viewHeight * camera.aspect;
    layoutScale = Math.max(
      1,
      viewWidth / (TILE_COLS * TILE_SIZE),
      viewHeight / (TILE_ROWS * TILE_SIZE),
    );
  }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('layoutScale adaptive grid done')
