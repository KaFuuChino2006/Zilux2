# -*- coding: utf-8 -*-
"""回滚到「聚焦入场 0.55s + 相机跟随单独平滑」那个版本（邻居不参与聚焦位移的版本）。"""
import io
import re

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# ---- 1) 恢复 updateTiles 到回滚版本 ----
start = s.index('  function updateTiles(delta: number): void {')
end = s.index('  function updateCards(delta: number): void {')
new_fn = '''  function updateTiles(delta: number): void {
    let nextHover = hoverSuppressed ? -1 : tileIndexAtPointer();
    if (forcedHoverTile >= 0) nextHover = forcedHoverTile;
    hoveredTile = nextHover;
    const hoveredSlot =
      hoveredTile >= 0 ? tileSlot(hoveredTile) : selectedTile >= 0 ? tileSlot(selectedTile) : null;
    tiles.forEach((tile) => {
      const appear = tileAmount;
      const slot = tileSlot(tile.index);
      const hoverTarget = hoveredTile === tile.index ? 1 : 0;
      tile.hoverT += (hoverTarget - tile.hoverT) * Math.min(1, delta * 10);
      const t = tile.hoverT * tile.hoverT * (3 - 2 * tile.hoverT);
      const selectedTarget = selectedTile === tile.index ? 1 : 0;
      tile.liftT += (selectedTarget - tile.liftT) * Math.min(1, delta * 8);
      const sel = tile.liftT * tile.liftT * (3 - 2 * tile.liftT);
      // 悬停时邻居沿远离悬停磁贴方向轻推
      let pushX = 0;
      let pushY = 0;
      if (hoveredSlot && tile.index !== hoveredTile && tile.index !== selectedTile) {
        const dx = slot.x - hoveredSlot.x;
        const dy = slot.y - hoveredSlot.y;
        const dist = Math.hypot(dx, dy) || 1;
        const reach = TILE_SIZE * 2.3;
        if (dist < reach) {
          const amount = (1 - dist / reach) * 0.16;
          pushX = (dx / dist) * amount;
          pushY = (dy / dist) * amount;
        }
      }
      tile.pushX += (pushX - tile.pushX) * Math.min(1, delta * 14);
      tile.pushY += (pushY - tile.pushY) * Math.min(1, delta * 14);
      tile.group.position.x = slot.x + tile.pushX;
      tile.group.position.y =
        slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06;
      tile.group.position.z = 0.1 + t * 0.26 + sel * 0.22 - focusAmount * 0.45;
      tile.group.rotation.x = 0;
      tile.group.scale.setScalar(
        layoutScale * (0.94 + 0.06 * appear) * (1 + t * 0.11 + sel * 0.07),
      );
      // 完整 180° 翻页：0→90° 露正面旧封面，90° 后换背面新封面，转到 180° 时由正面接替
      if (flipping) {
        const delay = flipDelays[tile.index] ?? 0;
        const local = Math.min(1, Math.max(0, (flipElapsed - delay) / FLIP_ITEM_MS));
        tile.group.rotation.y = tile.committed ? 0 : local * Math.PI;
      } else if (tile.group.rotation.y !== 0) {
        tile.group.rotation.y = 0;
      }
      const isFocused = tile.index === focusIndex;
      const isFocusTarget = isFocused || tile.index === pendingRestoreIndex;
      if (isFocusTarget && focusAmount > 0.001) {
        const grow = 1 + focusAmount * 0.7;
        tile.group.scale.multiplyScalar(grow);
        tile.group.position.z += focusAmount * 1.35;
        tile.group.position.y += focusAmount * 0.04;
      }
      tile.plane.material.opacity = appear;
      tile.plane.material.color.setScalar(isFocused ? 1 : 1 + t * 0.28 - sel * 0.05);
      if (appear <= 0.02) tile.group.visible = false;
    });
  }

'''
s = s[:start] + new_fn + s[end:]

# ---- 2) 恢复 selectedTile 变量及赋值 ----
if '  let selectedTile = -1;' not in s:
    s = s.replace('  let hoveredTile = -1;', '  let hoveredTile = -1;\n  let selectedTile = -1;', 1)

s = s.replace(
    """    setSelectedTile(_index: number) {
    },""",
    """    setSelectedTile(index: number) {
      selectedTile = index;
    },""",
    1,
)

s = s.replace(
    """    focusTile(index: number, info: TileDetailInfo) {
      void info;
      focusIndex = index;
    },""",
    """    focusTile(index: number, info: TileDetailInfo) {
      void info;
      focusIndex = index;
      selectedTile = index;
    },""",
    1,
)

s = s.replace(
    """      focusIndex = -1;
    },
    setTilesVisible(visible) {""",
    """      focusIndex = -1;
      selectedTile = -1;
    },
    setTilesVisible(visible) {""",
    1,
)

# ---- 3) 相机恢复：去掉 focusShiftZ（视线/相机 z 不随聚焦前移） ----
old_cam = """    // 选中封面微微前移时，视线与相机同步前移，保持居中
    const focusShiftZ = focusAmount * 0.8;
    lookTarget.set(panX + camFollowX, 0.72 + panY + camFollowY, focusShiftZ);
    camera.position.x =
      panX + camFollowX + Math.sin(orbitYaw) * Math.cos(orbitPitch) * camDist;
    camera.position.y = 0.62 + panY + camFollowY + Math.sin(orbitPitch) * camDist;
    camera.position.z =
      focusShiftZ + Math.cos(orbitYaw) * Math.cos(orbitPitch) * camDist;"""
new_cam = """    lookTarget.set(panX + camFollowX, 0.72 + panY + camFollowY, 0);
    camera.position.x =
      panX + camFollowX + Math.sin(orbitYaw) * Math.cos(orbitPitch) * camDist;
    camera.position.y = 0.62 + panY + camFollowY + Math.sin(orbitPitch) * camDist;
    camera.position.z = Math.cos(orbitYaw) * Math.cos(orbitPitch) * camDist;"""
if old_cam not in s:
    raise SystemExit('camera block not found')
s = s.replace(old_cam, new_cam, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('rolled back to v09694 behavior')
