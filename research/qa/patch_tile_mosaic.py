"""磁贴镶嵌排版（2×2 大封面 + 其它自动让位）：floatScene 改用 tilePlan，分页改按磁贴数。"""
import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")


def load(rel):
    path = ROOT / rel
    raw = io.open(str(path), "r", encoding="utf-8", newline="").read()
    nl = "\r\n" if "\r\n" in raw else "\n"
    return path, raw.replace("\r\n", "\n"), nl


def save(path, text, nl):
    io.open(str(path), "w", encoding="utf-8", newline="").write(
        text.replace("\n", nl) if nl == "\r\n" else text
    )


def rep(text, old, new, name, count=1):
    got = text.count(old)
    if got != count:
        raise SystemExit(f"FAIL {name}: count={got} (expect {count})")
    print(f"OK: {name}")
    return text.replace(old, new)


# ---------------- floatScene.ts ----------------
p, t, nl = load("web/src/three/floatScene.ts")

t = rep(
    t,
    "import { createSettingsBoard, type BoardSettingsState } from './settingsBoard';\n",
    "import { createSettingsBoard, type BoardSettingsState } from './settingsBoard';\n"
    "import { tilePlan } from './tilePlan';\n",
    "import",
)

t = rep(
    t,
    "  let layoutScale = 1;\n"
    "  // 每块磁贴的随机大小系数（0 = 全部一样大）\n"
    "  let tileSizeVariety = 0.4;\n"
    "  // 封面大小差异：确定性伪随机，同一块磁贴每帧保持同一大小\n"
    "  function tileSizeFactor(index: number): number {\n"
    "    if (tileSizeVariety <= 0.001) return 1;\n"
    "    const h = Math.sin((index + 1) * 127.1) * 43758.5453;\n"
    "    const r = h - Math.floor(h);\n"
    "    return 1 + (r - 0.5) * 2 * tileSizeVariety * 0.24;\n"
    "  }\n"
    "\n"
    "  function tileSlot(index: number): { x: number; y: number } {\n"
    "    const size = TILE_SIZE * layoutScale;\n"
    "    // 大小不一时刻意拉开网格间距，避免放大后的磁贴互相压住\n"
    "    const spacing = size * (1 + tileSizeVariety * 0.18);\n"
    "    const col = index % tileCols;\n"
    "    const row = Math.floor(index / tileCols);\n"
    "    return {\n"
    "      x: (col - (tileCols - 1) / 2) * spacing,\n"
    "      y: ((tileRows - 1) / 2 - row) * spacing,\n"
    "    };\n"
    "  }\n",
    "  let layoutScale = 1;\n"
    "  // 封面大小差异：0 = 全部一样大；越大越多 2×2 的大封面（其它封面自动让位）\n"
    "  let tileSizeVariety = 0.4;\n"
    "  interface TileSpot {\n"
    "    col: number;\n"
    "    row: number;\n"
    "    span: number;\n"
    "    x: number;\n"
    "    y: number;\n"
    "  }\n"
    "  let tileSpots: TileSpot[] = [];\n"
    "\n"
    "  // 重新计算当前网格的镶嵌排版（大封面 + 其余顺次让位）\n"
    "  function rebuildTileSpots(): void {\n"
    "    const spacing = TILE_SIZE * (1 + tileSizeVariety * 0.04);\n"
    "    tileSpots = tilePlan(tileCols, tileRows, tileSizeVariety).map((spot) => ({\n"
    "      ...spot,\n"
    "      x: (spot.col + (spot.span - 1) / 2 - (tileCols - 1) / 2) * spacing,\n"
    "      y: ((tileRows - 1) / 2 - (spot.row + (spot.span - 1) / 2)) * spacing,\n"
    "    }));\n"
    "  }\n"
    "\n"
    "  function tileCapacityCount(): number {\n"
    "    return Math.max(1, tileSpots.length);\n"
    "  }\n"
    "\n"
    "  function tileSlot(index: number): { x: number; y: number } {\n"
    "    const spot = tileSpots[index];\n"
    "    if (!spot) {\n"
    "      const size = TILE_SIZE * layoutScale;\n"
    "      const col = index % tileCols;\n"
    "      const row = Math.floor(index / tileCols);\n"
    "      return { x: (col - (tileCols - 1) / 2) * size, y: ((tileRows - 1) / 2 - row) * size };\n"
    "    }\n"
    "    return { x: spot.x * layoutScale, y: spot.y * layoutScale };\n"
    "  }\n"
    "\n"
    "  function tileSpanOf(index: number): number {\n"
    "    const spot = tileSpots[index];\n"
    "    return spot ? spot.span : 1;\n"
    "  }\n",
    "state",
)

t = rep(
    t,
    "  buildTilePool(tileCols * tileRows);\n",
    "  rebuildTileSpots();\n  buildTilePool(tileCols * tileRows);\n",
    "init-plan",
)

t = rep(t, "      const hitSize = size * tileSizeFactor(tile.index);\n", "      const hitSize = size * tileSpanOf(tile.index);\n", "hit-test")

t = rep(
    t,
    "          tileSizeFactor(tile.index) *\n",
    "          tileSpanOf(tile.index) *\n",
    "scale-span",
)

t = rep(
    t,
    "      const halfCols = Math.max(1, (tileCols - 1) / 2);\n"
    "      const columnU = ((tile.index % tileCols) - halfCols) / halfCols;\n",
    "      const halfCols = Math.max(1, (tileCols - 1) / 2);\n"
    "      // 大封面占两格：用它真实的横向位置算弯曲，避免和邻居的弧度错位\n"
    "      const columnU = Math.max(-1, Math.min(1, slot.x / Math.max(0.0001, halfCols * TILE_SIZE * layoutScale)));\n",
    "bend-column",
)

# --- 分页改成「按磁贴数」（item 偏移） ---
t = rep(
    t,
    "    return tiles.map((tile) => {\n"
    "      const row = Math.floor(tile.index / tileCols);\n"
    "      const col = tile.index % tileCols;\n"
    "      return (row * tileCols + col) * perTile + row * FLIP_ROW_GAP;\n"
    "    });\n",
    "    return tiles.map((tile) => {\n"
    "      const spot = tileSpots[tile.index];\n"
    "      const row = spot ? spot.row : Math.floor(tile.index / tileCols);\n"
    "      const col = spot ? spot.col : tile.index % tileCols;\n"
    "      return (row * tileCols + col) * perTile + row * FLIP_ROW_GAP;\n"
    "    });\n",
    "flip-delays",
)

t = rep(
    t,
    "    const rows = Math.ceil(tileItems.length / tileCols);\n"
    "    const maxOffset = Math.max(0, rows - tileRows);\n"
    "    const next = Math.min(maxOffset, Math.max(0, tileOffsetRows + direction * tileRows));\n",
    "    const capacity = tileCapacityCount();\n"
    "    const maxOffset = Math.max(0, tileItems.length - capacity);\n"
    "    const next = Math.min(maxOffset, Math.max(0, tileOffsetRows + direction * capacity));\n",
    "turn-page",
)

t = rep(
    t,
    "      const pageStart = tileOffsetRows * tileCols;\n",
    "      const pageStart = tileOffsetRows;\n",
    "classic-page-start",
)

t = rep(
    t,
    "    if (hitTile >= 0) {\n"
    "      const row = Math.floor(hitTile / tileCols);\n"
    "      const itemIndex = (tileOffsetRows + row) * tileCols + (hitTile % tileCols);\n"
    "      options.onTileClick?.(itemIndex, hitTile);\n",
    "    if (hitTile >= 0) {\n"
    "      const itemIndex = tileOffsetRows + hitTile;\n"
    "      options.onTileClick?.(itemIndex, hitTile);\n",
    "click",
)

t = rep(
    t,
    "        if (local < 1) allDone = false;\n"
    "        const row = Math.floor(tile.index / tileCols);\n"
    "        const itemIndex = (tileOffsetRows + row) * tileCols + (tile.index % tileCols);\n",
    "        if (local < 1) allDone = false;\n"
    "        const itemIndex = tileOffsetRows + tile.index;\n",
    "flip-items-1",
)

t = rep(
    t,
    "          tile.group.rotation.y = 0;\n"
    "          tile.backPlane.visible = false;\n"
    "          const row = Math.floor(tile.index / tileCols);\n"
    "          const itemIndex = (tileOffsetRows + row) * tileCols + (tile.index % tileCols);\n"
    "          const item = tileItems[itemIndex];\n",
    "          tile.group.rotation.y = 0;\n"
    "          tile.backPlane.visible = false;\n"
    "          const itemIndex = tileOffsetRows + tile.index;\n"
    "          const item = tileItems[itemIndex];\n",
    "flip-items-2",
)

t = rep(
    t,
    "      // 保留当前页位置：后台追加歌曲时不跳页\n"
    "      const rows = Math.ceil(tileItems.length / tileCols);\n"
    "      const maxOffset = Math.max(0, rows - tileRows);\n"
    "      tileOffsetRows = Math.min(maxOffset, Math.max(0, tileOffsetRows));\n",
    "      // 保留当前页位置：后台追加歌曲时不跳页\n"
    "      const capacity = tileCapacityCount();\n"
    "      const maxOffset = Math.max(0, tileItems.length - capacity);\n"
    "      tileOffsetRows = Math.min(maxOffset, Math.max(0, tileOffsetRows));\n",
    "set-tiles",
)

t = rep(
    t,
    "    pageInfo() {\n"
    "      const rows = Math.ceil(tileItems.length / tileCols);\n"
    "      const total = Math.max(1, Math.ceil(rows / tileRows));\n"
    "      const page = Math.min(total, Math.ceil(tileOffsetRows / tileRows) + 1);\n"
    "      return { page, total };\n"
    "    },\n",
    "    pageInfo() {\n"
    "      const capacity = tileCapacityCount();\n"
    "      const total = Math.max(1, Math.ceil(tileItems.length / capacity));\n"
    "      const page = Math.min(total, Math.floor(tileOffsetRows / capacity) + 1);\n"
    "      return { page, total };\n"
    "    },\n",
    "page-info",
)

t = rep(
    t,
    "      const rows = Math.ceil(tileItems.length / tileCols);\n"
    "      const maxOffset = Math.max(0, rows - tileRows);\n"
    "      const total = Math.max(1, Math.ceil(rows / tileRows));\n"
    "      const target = Math.min(total, Math.max(1, Math.floor(page) || 1));\n"
    "      const nextOffset = Math.min(maxOffset, (target - 1) * tileRows);\n",
    "      const capacity = tileCapacityCount();\n"
    "      const maxOffset = Math.max(0, tileItems.length - capacity);\n"
    "      const total = Math.max(1, Math.ceil(tileItems.length / capacity));\n"
    "      const target = Math.min(total, Math.max(1, Math.floor(page) || 1));\n"
    "      const nextOffset = Math.min(maxOffset, (target - 1) * capacity);\n",
    "set-page",
)

t = rep(
    t,
    "    scrollTiles(deltaY) {\n"
    "      if (!tileVisible) return;\n"
    "      const rows = Math.ceil(tileItems.length / tileCols);\n"
    "      const maxOffset = Math.max(0, rows - tileRows);\n"
    "      const next = tileOffsetRows + (deltaY > 0 ? 1 : -1);\n",
    "    scrollTiles(deltaY) {\n"
    "      if (!tileVisible) return;\n"
    "      const maxOffset = Math.max(0, tileItems.length - tileCapacityCount());\n"
    "      const next = tileOffsetRows + (deltaY > 0 ? tileCols : -tileCols);\n",
    "scroll-tiles",
)

t = rep(
    t,
    "      tileCols = nextCols;\n"
    "      tileRows = nextRows;\n",
    "      tileCols = nextCols;\n"
    "      tileRows = nextRows;\n"
    "      rebuildTileSpots();\n",
    "grid-plan",
)

t = rep(
    t,
    "  setTileSizeVariety(value: number): void;\n",
    "  setTileSizeVariety(value: number): void;\n  tileCapacity(): number;\n",
    "iface-cap",
)

t = rep(
    t,
    "    setTileSizeVariety(value: number) {\n"
    "      tileSizeVariety = Math.max(0, Math.min(1, value));\n"
    "    },\n",
    "    setTileSizeVariety(value: number) {\n"
    "      tileSizeVariety = Math.max(0, Math.min(1, value));\n"
    "      rebuildTileSpots();\n"
    "      refreshTiles();\n"
    "    },\n"
    "    tileCapacity() {\n"
    "      return tileCapacityCount();\n"
    "    },\n",
    "span-impl",
)

# refreshTiles：按 item 偏移取数据，容量改为磁贴数
t = rep(
    t,
    "  function refreshTiles(): void {\n"
    "    const rows = Math.ceil(tileItems.length / tileCols);\n"
    "    const maxOffset = Math.max(0, rows - tileRows);\n"
    "    if (tileOffsetRows > maxOffset) tileOffsetRows = maxOffset;\n"
    "    if (tileOffsetRows < 0) tileOffsetRows = 0;\n"
    "    tiles.forEach((tile) => {\n"
    "      const row = Math.floor(tile.index / tileCols);\n"
    "      const itemIndex = (tileOffsetRows + row) * tileCols + (tile.index % tileCols);\n"
    "      const item = tileItems[itemIndex];\n"
    "      const slot = tileSlot(tile.index);\n"
    "      tile.group.position.x = slot.x;\n"
    "      tile.group.position.y = slot.y;\n"
    "      const inPage = tile.index < tileCols * tileRows;\n",
    "  function refreshTiles(): void {\n"
    "    const capacity = tileCapacityCount();\n"
    "    const maxOffset = Math.max(0, tileItems.length - capacity);\n"
    "    if (tileOffsetRows > maxOffset) tileOffsetRows = maxOffset;\n"
    "    if (tileOffsetRows < 0) tileOffsetRows = 0;\n"
    "    tiles.forEach((tile) => {\n"
    "      const itemIndex = tileOffsetRows + tile.index;\n"
    "      const item = tileItems[itemIndex];\n"
    "      const slot = tileSlot(tile.index);\n"
    "      tile.group.position.x = slot.x;\n"
    "      tile.group.position.y = slot.y;\n"
    "      const inPage = tile.index < capacity;\n",
    "refresh",
)

save(p, t, nl)

# ---------------- spaceShell.ts ----------------
p2, s, nl2 = load("web/src/ui/spaceShell.ts")
s = rep(
    s,
    "  const tilePageSize = (): number => custom.tileCols * custom.tileRows;\n",
    "  // 每页能放多少张：镶嵌排版里大封面占 4 格，容量由场景算好后回读\n"
    "  const tilePageSize = (): number => {\n"
    "    const capacity = space?.tileCapacity?.() ?? 0;\n"
    "    return Math.max(1, capacity > 0 ? capacity : custom.tileCols * custom.tileRows);\n"
    "  };\n",
    "page-size",
)
save(p2, s, nl2)
print("DONE")
