# -*- coding: utf-8 -*-
"""改网格后点击/相机定位：命中判定改为尺寸自适应 + 相机跟随计入弯曲深度。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

def rep(old, new, cnt=1):
    global s
    assert s.count(old) == cnt, (s.count(old), old[:70])
    s = s.replace(old, new, cnt)

# 1) 命中判定：按每块磁贴的投影尺寸归一化（网格改大/改小都准确）
old_hit = '''  function tileIndexAtPointer(): number {
    if (!tileVisible || pointer.x >= 900) return -1;
    let best = -1;
    let bestDist = 0.105;
    const probe = new THREE.Vector3();
    tiles.forEach((tile) => {
      if (!tile.group.visible) return;
      // 用基础网格位置 + 弯曲位移判定（不跟随 hover 放大/让位位移），避免指针与命中判定互相追逐导致震颤
      const slot = tileSlot(tile.index);
      const halfCols = Math.max(1, (tileCols - 1) / 2);
      const columnU = ((tile.index % tileCols) - halfCols) / halfCols;
      const bend = tileBend * layoutScale;
      probe
        .set(
          slot.x - bend * 0.09 * columnU * Math.abs(columnU),
          slot.y,
          0.1 + bend * 2.4 * columnU * columnU,
        )
        .project(camera);
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
  }'''
new_hit = '''  function tileIndexAtPointer(): number {
    if (!tileVisible || pointer.x >= 900) return -1;
    // 按磁贴实际投影尺寸归一化：网格改大/改小、窗口最大化后命中都跟视觉一致
    const size = TILE_SIZE * layoutScale;
    const halfCols = Math.max(1, (tileCols - 1) / 2);
    const bend = tileBend * layoutScale;
    const probeCenter = new THREE.Vector3();
    const probeEdgeX = new THREE.Vector3();
    const probeEdgeY = new THREE.Vector3();
    let best = -1;
    let bestNorm = 1.05;
    tiles.forEach((tile) => {
      if (!tile.group.visible) return;
      const slot = tileSlot(tile.index);
      const columnU = ((tile.index % tileCols) - halfCols) / halfCols;
      const x = slot.x - bend * 0.09 * columnU * Math.abs(columnU);
      const z = 0.1 + bend * 2.4 * columnU * columnU;
      probeCenter.set(x, slot.y, z).project(camera);
      if (probeCenter.z < -1 || probeCenter.z > 1) return;
      probeEdgeX.set(x + size * 0.5, slot.y, z).project(camera);
      probeEdgeY.set(x, slot.y + size * 0.5, z).project(camera);
      const halfW = Math.max(1e-4, Math.hypot(probeEdgeX.x - probeCenter.x, probeEdgeX.y - probeCenter.y));
      const halfH = Math.max(1e-4, Math.hypot(probeEdgeY.x - probeCenter.x, probeEdgeY.y - probeCenter.y));
      const dx = (pointer.x - probeCenter.x) / halfW;
      const dy = (pointer.y - probeCenter.y) / halfH;
      const norm = Math.hypot(dx, dy);
      if (norm < bestNorm) {
        bestNorm = norm;
        best = tile.index;
      }
    });
    return bestNorm <= 1 ? best : -1;
  }'''
rep(old_hit, new_hit)

# 2) 相机跟随：把聚焦磁贴的弯曲深度（z）也计入，点了两侧弯曲列也能居中
rep('''    const targetFollowX = focusSlot ? focusSlot.x * focusAmount : 0;
    const targetFollowY = focusSlot ? focusSlot.y * focusAmount : 0;
    camFollowX += (targetFollowX - camFollowX) * Math.min(1, delta * 7);
    camFollowY += (targetFollowY - camFollowY) * Math.min(1, delta * 7);
    lookTarget.set(panX + camFollowX, 0.72 + panY + camFollowY, 0);''',
'''    const targetFollowX = focusSlot ? focusSlot.x * focusAmount : 0;
    const targetFollowY = focusSlot ? focusSlot.y * focusAmount : 0;
    // 弯曲墙两侧的磁贴会向观众方向前凸，点击它们时相机要连带深度一起对中
    let targetFollowZ = 0;
    if (focusTile && focusAmount > 0.001) {
      const halfCols = Math.max(1, (tileCols - 1) / 2);
      const columnU = ((focusTile.index % tileCols) - halfCols) / halfCols;
      targetFollowZ = (0.1 + tileBend * layoutScale * 2.4 * columnU * columnU) * focusAmount;
    }
    camFollowX += (targetFollowX - camFollowX) * Math.min(1, delta * 7);
    camFollowY += (targetFollowY - camFollowY) * Math.min(1, delta * 7);
    camFollowZ += (targetFollowZ - camFollowZ) * Math.min(1, delta * 7);
    lookTarget.set(panX + camFollowX, 0.72 + panY + camFollowY, camFollowZ);''')

# camFollowZ 声明
rep("  let camFollowX = 0;\n  let camFollowY = 0;",
    "  let camFollowX = 0;\n  let camFollowY = 0;\n  let camFollowZ = 0;")

# 相机位置 z 也加上 camFollowZ，让镜头沿深度一起跟过去
rep("    camera.position.z = Math.cos(orbitYaw) * Math.cos(orbitPitch) * camDist;",
    "    camera.position.z = Math.cos(orbitYaw) * Math.cos(orbitPitch) * camDist + camFollowZ;")

# 3) 改网格重建池时清掉旧的聚焦/选中状态，避免相机对到已销毁的索引
rep('''    setTileGrid(cols, rows) {
      tileCols = Math.max(1, Math.floor(cols));
      tileRows = Math.max(1, Math.floor(rows));
      const wanted = tileCols * tileRows;
      if (wanted !== tilePool) buildTilePool(wanted);
      tileOffsetRows = 0;
      refreshTiles();
      resize();
    },''',
'''    setTileGrid(cols, rows) {
      const nextCols = Math.max(1, Math.floor(cols));
      const nextRows = Math.max(1, Math.floor(rows));
      const changed = nextCols !== tileCols || nextRows !== tileRows;
      tileCols = nextCols;
      tileRows = nextRows;
      if (changed) {
        // 网格变了：清掉旧的聚焦/选中，否则相机会对准已经不在可见区域的索引
        focusIndex = -1;
        pendingRestoreIndex = -1;
        selectedTile = -1;
        hoveredTile = -1;
        camFollowX = 0;
        camFollowY = 0;
        camFollowZ = 0;
      }
      const wanted = tileCols * tileRows;
      if (wanted !== tilePool) buildTilePool(wanted);
      tileOffsetRows = 0;
      refreshTiles();
      resize();
    },''')

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('tile hit test scaled + camera follow includes bend depth + grid change resets focus')
