# -*- coding: utf-8 -*-
"""磁贴 hover：增强放大幅度 + 屏幕空间兜底命中 + QA ?hover= 强制。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 屏幕空间兜底：raycast 没命中时用投影中心找最近磁贴
old = """    hoveredTile = nextHover;
    const hoveredSlot = hoveredTile >= 0 ? tileSlot(hoveredTile) : null;"""
new = """    // raycast 没命中时，用「磁贴中心投影到屏幕」兜底，保证任意视角都能悬停
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
    hoveredTile = nextHover;
    const hoveredSlot = hoveredTile >= 0 ? tileSlot(hoveredTile) : null;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) 状态：QA 强制悬停磁贴
old = "  let selectedTile = -1;"
new = "  let selectedTile = -1;\n  let forcedHoverTile = -1;"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 3) 放大幅度增强
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

# 4) 邻居避让加大
old = "          const amount = (1 - dist / reach) * 0.1;"
new = "          const amount = (1 - dist / reach) * 0.16;"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 5) QA 接口
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

# 6) 接口类型
old = "  setSelectedTile(index: number): void;"
new = "  setSelectedTile(index: number): void;\n  setForcedHover(index: number): void;"
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('tile hover enhanced + fallback + QA')
