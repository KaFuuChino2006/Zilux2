# -*- coding: utf-8 -*-
"""磁贴 hover/点击改用屏幕投影 + 放大幅度加强（v2 修复版）。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 插入屏幕投影判定函数
old = "  function updateTiles(delta: number): void {"
new = """  /** 用屏幕投影判定指针下的磁贴（不依赖 raycast） */
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

# 2) hover 判定替换为屏幕投影
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
    hoveredTile = nextHover;"""
new = """    let nextHover = tileIndexAtPointer();
    if (forcedHoverTile >= 0) nextHover = forcedHoverTile;
    hoveredTile = nextHover;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 3) 放大 + 避让加强
old = """          const amount = (1 - dist / reach) * 0.1;"""
new = """          const amount = (1 - dist / reach) * 0.16;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """      tile.group.position.y = slot.y + tile.pushY + (1 - appear) * -0.5 + sel * 0.06;
      tile.group.position.z = 0.1 + t * 0.16 + sel * 0.2;
      tile.group.scale.setScalar((0.94 + 0.06 * appear) * (1 + t * 0.07 + sel * 0.06));
      tile.plane.material.opacity = appear;
      tile.plane.material.color.setScalar(1 + t * 0.18 - sel * 0.05);"""
new = """      tile.group.position.y = slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06;
      tile.group.position.z = 0.1 + t * 0.26 + sel * 0.22;
      tile.group.scale.setScalar((0.94 + 0.06 * appear) * (1 + t * 0.11 + sel * 0.07));
      tile.plane.material.opacity = appear;
      tile.plane.material.color.setScalar(1 + t * 0.28 - sel * 0.05);"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 4) 状态 + 接口
old = "  let selectedTile = -1;"
new = "  let selectedTile = -1;\n  let forcedHoverTile = -1;"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    setSelectedTile(index: number) {
      selectedTile = index;
    },"""
new = """    setSelectedTile(index: number) {
      selectedTile = index;
    },
    setForcedHover(index: number) {
      forcedHoverTile = index;
    },"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "  setSelectedTile(index: number): void;"
new = "  setSelectedTile(index: number): void;\n  setForcedHover(index: number): void;"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 5) 点击改用屏幕投影判定
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
print('tile hover/click screen projection v2 done')
