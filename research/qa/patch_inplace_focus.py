# -*- coding: utf-8 -*-
"""点击封面 = 原磁贴本体放大（用 1024 详情纹理替换该磁贴纹理），其他磁贴径向让位；
去掉覆盖在磁贴上的独立详情卡（detailPlane）。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# ---------- 1) 删除 detailPlane（覆盖层）----------
old = """  const detailPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1.06, 1.06),
    new THREE.MeshBasicMaterial({ map: detailTexture, transparent: true, depthWrite: false, opacity: 0 }),
  );
  detailPlane.position.set(0, 0, 0.8);
  detailPlane.visible = false;
  detailPlane.renderOrder = 20;
  (detailPlane.material as THREE.MeshBasicMaterial).depthTest = false;
  scene.add(detailPlane);
"""
assert s.count(old) == 1, 'detailPlane block missing'
s = s.replace(old, "", 1)

# ---------- 2) drawDetailTile 末尾：把详情纹理挂到聚焦磁贴 ----------
old = """    detailTexture.needsUpdate = true;
  }

  function refreshTiles(): void {"""
new = """    detailTexture.needsUpdate = true;
    // 详情直接画到被点击的那块磁贴纹理上（原封面本体放大，不额外覆盖一层）
    if (focusIndex >= 0) {
      const target = tiles[focusIndex];
      if (target) {
        target.plane.material.map = detailTexture;
        target.plane.material.needsUpdate = true;
      }
    }
  }

  function refreshTiles(): void {"""
assert s.count(old) == 1, 'drawDetailTile tail missing'
s = s.replace(old, new, 1)

# ---------- 3) frame：删除 detailPlane 跟随段 ----------
old = """    // 详情磁贴跟随聚焦
    if (focusTile) {
      detailPlane.position.set(focusTile.group.position.x, focusTile.group.position.y, 0.85);
      detailPlane.visible = focusAmount > 0.02;
      (detailPlane.material as THREE.MeshBasicMaterial).opacity = focusAmount;
      const sScale = 1.0 + 1.7 * focusAmount;
      detailPlane.scale.setScalar(sScale);
      detailPlane.rotation.z = 0;
    } else {
      detailPlane.visible = false;
    }
"""
assert s.count(old) == 1, 'frame detailPlane block missing'
s = s.replace(old, "", 1)

# ---------- 4) focusTile / unfocusTile：切换磁贴纹理 ----------
old = """    focusTile(index: number, info: TileDetailInfo) {
      focusIndex = index;
      detailInfo = info;
      selectedTile = -1;
      detailImage = null;"""
new = """    focusTile(index: number, info: TileDetailInfo) {
      const previous = focusIndex;
      focusIndex = index;
      detailInfo = info;
      selectedTile = -1;
      detailImage = null;
      if (previous >= 0 && previous !== index) {
        const prev = tiles[previous];
        if (prev) {
          prev.plane.material.map = prev.texture;
          prev.plane.material.needsUpdate = true;
        }
      }"""
assert s.count(old) == 1, 'focusTile body missing'
s = s.replace(old, new, 1)

old = """    unfocusTile() {
      focusIndex = -1;
      detailInfo = null;
      detailImage = null;
      detailPlane.visible = false;
    },"""
new = """    unfocusTile() {
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
assert s.count(old) == 1, 'unfocusTile body missing'
s = s.replace(old, new, 1)

# ---------- 5) updateTiles：让位 + 原磁贴放大 ----------
old = """      const isFocused = tile.index === focusIndex;
      const dim = focusAmount * (isFocused ? 1 : 0.55);
      tile.plane.material.opacity = appear * (1 - dim);
      tile.plane.material.color.setScalar((1 + t * 0.28 - sel * 0.05) * (1 - dim * 0.5));"""
new = """      const isFocused = tile.index === focusIndex;
      // 聚焦磁贴本体放大（详情直接替换纹理），不做覆盖层
      if (isFocused && focusAmount > 0.001) {
        const grow = 1 + focusAmount * 1.28;
        tile.group.scale.setScalar(layoutScale * grow * (0.94 + 0.06 * appear));
        tile.group.position.z = 0.1 + focusAmount * 1.15;
        tile.group.position.y += focusAmount * 0.06;
      }
      const dim = focusAmount * (isFocused ? 0 : 0.6);
      tile.plane.material.opacity = isFocused ? appear : appear * (1 - dim);
      tile.plane.material.color.setScalar(
        isFocused ? 1 : (1 + t * 0.28 - sel * 0.05) * (1 - dim * 0.5),
      );"""
assert s.count(old) == 1, 'updateTiles dim block missing'
s = s.replace(old, new, 1)

# 让位：聚焦磁贴周围推开（与 hover 避让叠加）
old = """      tile.pushX += (pushX - tile.pushX) * Math.min(1, delta * 12);
      tile.pushY += (pushY - tile.pushY) * Math.min(1, delta * 12);"""
new = """      // 聚焦时周围磁贴让位（径向推开 + 靠近的缩小）
      if (focusSlot && tile.index !== focusIndex && focusAmount > 0.01) {
        const fdx = slot.x - focusSlot.x;
        const fdy = slot.y - focusSlot.y;
        const fdist = Math.hypot(fdx, fdy) || 1;
        const freach = TILE_SIZE * layoutScale * 3.4;
        if (fdist < freach) {
          const famount = (1 - fdist / freach) * 0.85 * focusAmount;
          pushX += (fdx / fdist) * famount;
          pushY += (fdy / fdist) * famount;
        }
      }
      tile.pushX += (pushX - tile.pushX) * Math.min(1, delta * 12);
      tile.pushY += (pushY - tile.pushY) * Math.min(1, delta * 12);"""
assert s.count(old) == 1, 'push smoothing block missing'
s = s.replace(old, new, 1)

old = "    const hoveredSlot =\n      hoveredTile >= 0 ? tileSlot(hoveredTile) : selectedTile >= 0 ? tileSlot(selectedTile) : null;"
new = """    const hoveredSlot =
      hoveredTile >= 0 ? tileSlot(hoveredTile) : selectedTile >= 0 ? tileSlot(selectedTile) : null;
    const focusSlot = focusIndex >= 0 ? tileSlot(focusIndex) : null;"""
assert s.count(old) == 1, 'hoveredSlot block missing'
s = s.replace(old, new, 1)

# ---------- 6) 相机推进力度略减，便于看到邻居让位 ----------
old = "    const camDist = ORBIT_RADIUS * zoom * (1 - 0.42 * focusAmount);"
new = "    const camDist = ORBIT_RADIUS * zoom * (1 - 0.3 * focusAmount);"
assert s.count(old) == 1, 'camDist line missing'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('tile in-place focus + neighbor displacement done')
