# -*- coding: utf-8 -*-
"""重写 updateTiles：位置逻辑简单清晰——悬停轻推、聚焦时选中最高、周围按距离逐级下降、其余不动。"""
import io
import re

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

start = s.index('  function updateTiles(delta: number): void {')
end = s.index('  function updateCards(delta: number): void {')
new_fn = '''  function updateTiles(delta: number): void {
    const focusSlotPos = focusIndex >= 0 ? tileSlot(focusIndex) : null;
    let nextHover = hoverSuppressed ? -1 : tileIndexAtPointer();
    if (forcedHoverTile >= 0) nextHover = forcedHoverTile;
    // 聚焦时关闭悬停判定，避免让位与聚焦层次叠加导致位置错乱
    if (focusSlotPos && focusAmount > 0.05) nextHover = -1;
    hoveredTile = nextHover;
    tiles.forEach((tile) => {
      const appear = tileAmount;
      const slot = tileSlot(tile.index);
      const isFocused = tile.index === focusIndex;
      const hoverTarget = hoveredTile === tile.index ? 1 : 0;
      tile.hoverT += (hoverTarget - tile.hoverT) * Math.min(1, delta * 10);
      const t = tile.hoverT * tile.hoverT * (3 - 2 * tile.hoverT);
      // 悬停让位：仅未聚焦时生效，邻居沿远离悬停磁贴方向轻推
      let pushX = 0;
      let pushY = 0;
      if (!focusSlotPos && hoveredTile >= 0 && tile.index !== hoveredTile) {
        const hoverSlot = tileSlot(hoveredTile);
        const dx = slot.x - hoverSlot.x;
        const dy = slot.y - hoverSlot.y;
        const dist = Math.hypot(dx, dy) || 1;
        const reach = TILE_SIZE * 2;
        if (dist < reach) {
          const amount = (1 - dist / reach) * 0.12;
          pushX = (dx / dist) * amount;
          pushY = (dy / dist) * amount;
        }
      }
      tile.pushX += (pushX - tile.pushX) * Math.min(1, delta * 12);
      tile.pushY += (pushY - tile.pushY) * Math.min(1, delta * 12);
      // 聚焦高低层次：选中封面最高，距离越远越低
      let drop = 0;
      if (focusSlotPos && !isFocused) {
        const cells = Math.hypot(slot.x - focusSlotPos.x, slot.y - focusSlotPos.y) / TILE_SIZE;
        drop = Math.min(1, Math.max(0, (cells - 0.6) / 3.2)) * focusAmount;
      }
      const lift = isFocused ? focusAmount * 0.22 : 0;
      tile.group.position.x = slot.x + tile.pushX;
      tile.group.position.y =
        slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + lift - drop * 0.6;
      tile.group.position.z = 0.1 + t * 0.26 + (isFocused ? focusAmount * 0.8 : 0);
      tile.group.rotation.x = drop * 0.12;
      const grow = isFocused ? 1 + focusAmount * 0.7 : 1;
      tile.group.scale.setScalar(
        layoutScale * (0.94 + 0.06 * appear) * (1 + t * 0.11) * grow * (1 - drop * 0.04),
      );
      // 完整 180° 翻页：0→90° 露正面旧封面，90° 后换背面新封面，转到 180° 时由正面接替
      if (flipping) {
        const delay = flipDelays[tile.index] ?? 0;
        const local = Math.min(1, Math.max(0, (flipElapsed - delay) / FLIP_ITEM_MS));
        tile.group.rotation.y = tile.committed ? 0 : local * Math.PI;
      } else if (tile.group.rotation.y !== 0) {
        tile.group.rotation.y = 0;
      }
      tile.plane.material.opacity = appear;
      tile.plane.material.color.setScalar(1 + t * 0.28);
      if (appear <= 0.02) tile.group.visible = false;
    });
  }

'''
s = s[:start] + new_fn + s[end:]

# 删除不再使用的 selectedTile（避免 TS6133）
s = s.replace('  let selectedTile = -1;\n', '', 1)
s = re.sub(r'[ \t]*selectedTile = index;\n', '', s)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('updateTiles rewritten')
