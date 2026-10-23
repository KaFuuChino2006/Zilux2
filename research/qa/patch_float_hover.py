# -*- coding: utf-8 -*-
"""给 floatScene 磁贴加：hover 放大 + 邻居避让 + 选中态。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) Tile 接口加避让/选中平滑量
old = """    title: string;
    hoverT: number;
    index: number;
  }"""
new = """    title: string;
    hoverT: number;
    index: number;
    pushX: number;
    pushY: number;
    liftT: number;
  }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) 状态：选中磁贴
old = "  let hoveredTile = -1;"
new = "  let hoveredTile = -1;\n  let selectedTile = -1;"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 3) 磁贴对象初始化
old = """      hoverT: 0,
      index: i,
    };"""
new = """      hoverT: 0,
      index: i,
      pushX: 0,
      pushY: 0,
      liftT: 0,
    };"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 4) updateTiles：hover 放大 + 邻居避让 + 选中态
old = """    hoveredTile = nextHover;
    tiles.forEach((tile) => {
      const hoverTarget = hoveredTile === tile.index ? 1 : 0;
      tile.hoverT += (hoverTarget - tile.hoverT) * Math.min(1, delta * 9);
      const t = tile.hoverT * tile.hoverT * (3 - 2 * tile.hoverT);
      const appear = tileAmount;
      const slot = tileSlot(tile.index);
      tile.group.position.y = slot.y + (1 - appear) * -0.5;
      tile.group.position.z = 0.1 + t * 0.14;
      tile.group.scale.setScalar((0.94 + 0.06 * appear) * (1 + t * 0.05));
      tile.plane.material.opacity = appear;
      tile.plane.material.color.setScalar(1 + t * 0.16);
      if (appear <= 0.02) tile.group.visible = false;
    });"""
new = """    hoveredTile = nextHover;
    const hoveredSlot = hoveredTile >= 0 ? tileSlot(hoveredTile) : null;
    tiles.forEach((tile) => {
      const hoverTarget = hoveredTile === tile.index ? 1 : 0;
      tile.hoverT += (hoverTarget - tile.hoverT) * Math.min(1, delta * 10);
      const t = tile.hoverT * tile.hoverT * (3 - 2 * tile.hoverT);
      const selectedTarget = selectedTile === tile.index ? 1 : 0;
      tile.liftT += (selectedTarget - tile.liftT) * Math.min(1, delta * 8);
      const sel = tile.liftT * tile.liftT * (3 - 2 * tile.liftT);
      const appear = tileAmount;
      const slot = tileSlot(tile.index);
      // 悬停时周围磁贴避让：沿远离悬停磁贴的方向让开一点
      let pushX = 0;
      let pushY = 0;
      if (hoveredSlot && tile.index !== hoveredTile) {
        const dx = slot.x - hoveredSlot.x;
        const dy = slot.y - hoveredSlot.y;
        const dist = Math.hypot(dx, dy) || 1;
        const reach = TILE_SIZE * 2.3;
        if (dist < reach) {
          const amount = (1 - dist / reach) * 0.1;
          pushX = (dx / dist) * amount;
          pushY = (dy / dist) * amount;
        }
      }
      tile.pushX += (pushX - tile.pushX) * Math.min(1, delta * 12);
      tile.pushY += (pushY - tile.pushY) * Math.min(1, delta * 12);
      tile.group.position.x = slot.x + tile.pushX;
      tile.group.position.y = slot.y + tile.pushY + (1 - appear) * -0.5 + sel * 0.06;
      tile.group.position.z = 0.1 + t * 0.16 + sel * 0.2;
      tile.group.scale.setScalar((0.94 + 0.06 * appear) * (1 + t * 0.07 + sel * 0.06));
      tile.plane.material.opacity = appear;
      tile.plane.material.color.setScalar(1 + t * 0.18 - sel * 0.05);
      if (appear <= 0.02) tile.group.visible = false;
    });"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 5) 对外 API：选中磁贴
old = """    setTilesVisible(visible) {
      tileVisible = visible;"""
new = """    setSelectedTile(index: number) {
      selectedTile = index;
    },
    setTilesVisible(visible) {
      tileVisible = visible;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('floatScene tiles hover/避让/选中 done')
