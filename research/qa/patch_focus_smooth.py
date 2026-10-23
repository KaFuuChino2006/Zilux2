# -*- coding: utf-8 -*-
"""修三处：
1) 取消聚焦时先平滑缩小、纹理等动画结束再换回（不再瞬间收回）；
2) hover 判定用基础网格位置，避免放大/让位位移导致指针与判定互相追逐造成震颤；
3) 中键平移上下方向再翻正。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 中键平移：上下翻正（水平保持 -dx）
old = "      panTargetY = Math.min(4.2, Math.max(-4.2, panTargetY - dy * 0.0052 * zoom));"
new = "      panTargetY = Math.min(4.2, Math.max(-4.2, panTargetY + dy * 0.0052 * zoom));"
assert s.count(old) == 1, 'panY line missing'
s = s.replace(old, new, 1)

# 2) hover/点击判定改用基础网格位置
old = """    tiles.forEach((tile) => {
      if (!tile.group.visible) return;
      const p = tile.group.position;
      probe.set(p.x, p.y, p.z).project(camera);"""
new = """    tiles.forEach((tile) => {
      if (!tile.group.visible) return;
      // 用基础网格位置判定（不跟随 hover 放大/让位位移），避免指针与命中判定互相追逐导致震颤
      const slot = tileSlot(tile.index);
      probe.set(slot.x, slot.y, 0.1).project(camera);"""
assert s.count(old) == 1, 'tileIndexAtPointer body missing'
s = s.replace(old, new, 1)

# 3) 新增 pendingRestoreIndex
old = "  let focusIndex = -1;\n  let focusAmount = 0;"
new = "  let focusIndex = -1;\n  let pendingRestoreIndex = -1;\n  let focusAmount = 0;"
assert s.count(old) == 1, 'focus state decl missing'
s = s.replace(old, new, 1)

# 4) updateTiles：取消聚焦时仍按 focusAmount 平滑收缩
old = """      const isFocused = tile.index === focusIndex;
      // 聚焦磁贴本体放大（详情直接替换纹理），不做覆盖层
      if (isFocused && focusAmount > 0.001) {"""
new = """      const isFocused = tile.index === focusIndex;
      const isFocusTarget = isFocused || tile.index === pendingRestoreIndex;
      // 聚焦磁贴本体放大；取消聚焦后按 focusAmount 平滑缩回
      if (isFocusTarget && focusAmount > 0.001) {"""
assert s.count(old) == 1, 'updateTiles focus block missing'
s = s.replace(old, new, 1)

# 5) unfocusTile：延后恢复纹理
old = """    unfocusTile() {
      if (focusIndex >= 0) {
        const tile = tiles[focusIndex];
        if (tile) {
          tile.plane.material.map = tile.texture;
          tile.plane.material.needsUpdate = true;
        }
      }
      focusIndex = -1;
      detailInfo = null;
      detailImage = null;
    },"""
new = """    unfocusTile() {
      if (focusIndex >= 0) {
        // 纹理延后到缩回动画结束再换回，避免瞬间跳变
        pendingRestoreIndex = focusIndex;
      }
      focusIndex = -1;
      detailInfo = null;
      detailImage = null;
    },"""
assert s.count(old) == 1, 'unfocusTile body missing'
s = s.replace(old, new, 1)

# 6) focusTile 时清理挂起的恢复
old = """      const previous = focusIndex;
      focusIndex = index;
      detailInfo = info;
      selectedTile = -1;
      detailImage = null;
      if (previous >= 0 && previous !== index) {"""
new = """      const previous = focusIndex >= 0 ? focusIndex : pendingRestoreIndex;
      pendingRestoreIndex = -1;
      focusIndex = index;
      detailInfo = info;
      selectedTile = -1;
      detailImage = null;
      if (previous >= 0 && previous !== index) {"""
assert s.count(old) == 1, 'focusTile body missing'
s = s.replace(old, new, 1)

# 7) frame：缩回动画结束后恢复纹理
old = "    updateTiles(delta);\n\n    renderer.render(scene, camera);"
new = """    updateTiles(delta);
    if (pendingRestoreIndex >= 0 && focusAmount < 0.04) {
      const tile = tiles[pendingRestoreIndex];
      if (tile) {
        tile.plane.material.map = tile.texture;
        tile.plane.material.needsUpdate = true;
      }
      pendingRestoreIndex = -1;
    }

    renderer.render(scene, camera);"""
assert s.count(old) == 1, 'frame render tail missing'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('focus transition + hover jitter + panY fixed')
