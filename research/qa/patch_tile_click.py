# -*- coding: utf-8 -*-
"""磁贴 hover/点击改为屏幕空间投影判定（不依赖 raycast），修复点击无反应。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 新增：屏幕空间磁贴索引判定（用 group.position 投影，任意视角准确）
old = """  function updateTiles(delta: number): void {"""
new = """  /** 用屏幕投影判定指针下的磁贴（不依赖 raycast，避免矩阵/可见性问题） */
  function tileIndexAtPointer(): number {
    if (!tileVisible || pointer.x >= 900) return -1;
    let best = -1;
    let bestDist = 0.105;
    const probe = new THREE.Vector3();
    tiles.forEach((tile) => {
      if (!tile.group.visible) return;
      const p = tile.group.position;
      probe.set(p.x, p.y, p.z).project(camera);
      if (probe.z < -1 || probe.z > 1) return;
      const dx = probe.x - pointer.x;
      const dy = probe.y - pointer.y;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) {
        bestDist = dist;
        best = tile.index;
      }
    });
    return best;
  }

  function updateTiles(delta: number): void {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) hover 判定改为屏幕投影（保留 forcedHover）
old = """    const now = performance.now();
    let nextHover = -1;
    if (tileVisible && pointer.x < 900 && now - lastTileHoverAt > 80) {
      lastTileHoverAt = now;
      raycaster.setFromCamera(pointer, camera);
      const visibleTiles = tiles.filter((tile) => tile.group.visible).map((tile) => tile.hit);
      const hits = raycaster.intersectObjects(visibleTiles, false);
      if (hits.length > 0) {
        const found = tiles.findIndex((tile) => tile.hit === hits[0].object);
        if (found >= 0) nextHover = found;
      }
    }
    // raycast 没命中时，用「磁贴中心投影到屏幕」兜底，保证任意视角都能悬停
    if (nextHover < 0 && forcedHoverTile < 0 && pointer.x < 900) {
      let best = -1;
      let bestDist = 0.115;
      const probe = new THREE.Vector3();
      tiles.forEach((tile) => {
        if (!tile.group.visible) return;
        const slot = tileSlot(tile.index);
        probe.set(slot.x + tile.pushX, slot.y + tile.pushY, 0.1);
        probe.project(camera);
        if (probe.z < -1 || probe.z > 1) return;
        const dx = probe.x - pointer.x;
        const dy = probe.y - pointer.y;
        const dist = Math.hypot(dx, dy);
        if (dist < bestDist) {
          bestDist = dist;
          best = tile.index;
        }
      });
      nextHover = best;
    }
    if (forcedHoverTile >= 0) nextHover = forcedHoverTile;
    hoveredTile = nextHover;"""
new = """    let nextHover = tileIndexAtPointer();
    if (forcedHoverTile >= 0) nextHover = forcedHoverTile;
    hoveredTile = nextHover;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 3) 点击：不再依赖 hoveredTile，直接在 pointerup 时用屏幕投影算磁贴
old = """    const moved = Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY);
    if (moved > 8 || performance.now() - downTime > 700) return;
    if (hoveredTile >= 0 && tileVisible) {
      const tile = tiles[hoveredTile];
      if (tile) {
        const row = Math.floor(tile.index / TILE_COLS);
        const itemIndex = (tileOffsetRows + row) * TILE_COLS + (tile.index % TILE_COLS);
        options.onTileClick?.(itemIndex);
      }
      return;
    }"""
new = """    const moved = Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY);
    if (moved > 8 || performance.now() - downTime > 700) return;
    // 用屏幕投影判定点击的磁贴（不依赖上一帧的 hoveredTile）
    const hitTile = tileIndexAtPointer();
    if (hitTile >= 0) {
      const row = Math.floor(hitTile / TILE_COLS);
      const itemIndex = (tileOffsetRows + row) * TILE_COLS + (hitTile % TILE_COLS);
      options.onTileClick?.(itemIndex);
      return;
    }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('tile hover/click via screen projection done')
