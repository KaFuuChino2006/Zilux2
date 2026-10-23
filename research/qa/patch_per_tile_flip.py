# -*- coding: utf-8 -*-
"""逐封面翻页：每块磁贴在翻到 90° 时只更新自己（逐块换图），避免一次性重绘 91 块的卡顿。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, label):
    global s
    if s.count(old) != 1:
        raise SystemExit(f'{label}: count={s.count(old)}')
    s = s.replace(old, new, 1)


# 1) Tile 增加 flipped 标记
rep(
    """    pushX: number;
    pushY: number;
    liftT: number;
  }""",
    """    pushX: number;
    pushY: number;
    liftT: number;
    flipped: boolean;
  }""",
    'tile type',
)

# 2) 创建时初始化
rep(
    """      liftT: 0,""",
    """      liftT: 0,
      flipped: false,""",
    'tile init',
)

# 3) 状态：flipping / flipElapsed 代替 flipT / pendingFlipOffset
rep(
    """  let flipT = 1;""",
    """  let flipping = false;
  let flipElapsed = 0;
  const FLIP_ITEM_MS = 0.5;""",
    'flip state',
)
rep(
    """  let pendingFlipOffset = -1;\n""",
    "",
    'pending offset',
)

# 4) 单块更新函数：只重绘这一块
rep(
    """  function refreshTiles(): void {""",
    """  function applyTileItem(tile: Tile): void {
    const row = Math.floor(tile.index / TILE_COLS);
    const itemIndex = (tileOffsetRows + row) * TILE_COLS + (tile.index % TILE_COLS);
    const item = tileItems[itemIndex];
    tile.image = null;
    if (!item) {
      tile.title = '';
      tile.group.visible = false;
      drawTile(tile);
      return;
    }
    tile.title = item.title;
    tile.group.visible = tileVisible;
    drawTile(tile);
    if (item.cover) enqueueCover(tile, item.cover);
  }

  function refreshTiles(): void {""",
    'applyTileItem',
)

# 5) frame：逐块推进并逐块换图
rep(
    """    if (flipT < 1) {
      const prevFlip = flipT;
      flipT = Math.min(1, flipT + delta / 0.9);
      if (prevFlip < 0.25 && flipT >= 0.25 && pendingFlipOffset >= 0) {
        tileOffsetRows = pendingFlipOffset;
        pendingFlipOffset = -1;
        refreshTiles();
      }
    }""",
    """    if (flipping) {
      flipElapsed += delta;
      let allDone = true;
      tiles.forEach((tile) => {
        const delay = flipDelays[tile.index] ?? 0;
        const local = Math.min(1, Math.max(0, (flipElapsed - delay) / FLIP_ITEM_MS));
        if (local < 1) allDone = false;
        if (local >= 0.5 && !tile.flipped) {
          tile.flipped = true;
          applyTileItem(tile);
        }
        if (local >= 1) tile.group.rotation.y = 0;
      });
      if (allDone) {
        flipping = false;
        tiles.forEach((tile) => {
          tile.group.rotation.y = 0;
        });
      }
    }""",
    'frame flip',
)

# 6) updateTiles：逐块翻转角度（翻转与位置无关）
rep(
    """      // 翻页翻转：0→90° 换页 →回到 0°，绕各自中心翻转
      if (flipT < 1) {
        let flipAngle = 0;
        if (flipT < 0.25) {
          // 前半段：所有磁贴一起翻到侧面（此时看不见内容，便于换页）
          flipAngle = (flipT / 0.25) * (Math.PI / 2);
        } else {
          // 后半段：按顺序（第一块→最后一块）或随机顺序逐块翻回，显出下一页封面
          const delay = flipDelays[tile.index] ?? 0;
          const local = Math.min(1, Math.max(0, (flipT - 0.25 - delay) / 0.4));
          flipAngle = (1 - local * local * (3 - 2 * local)) * (Math.PI / 2);
        }
        tile.group.rotation.y = flipAngle;
      } else if (tile.group.rotation.y !== 0) {
        tile.group.rotation.y = 0;
      }""",
    """      // 逐块翻页：每块到 90° 时换自己的图，再翻回，视觉上是封面依次翻转
      if (flipping) {
        const delay = flipDelays[tile.index] ?? 0;
        const local = Math.min(1, Math.max(0, (flipElapsed - delay) / FLIP_ITEM_MS));
        tile.group.rotation.y = Math.sin(local * Math.PI) * (Math.PI / 2);
      } else if (tile.group.rotation.y !== 0) {
        tile.group.rotation.y = 0;
      }""",
    'tile rotation',
)

# 7) turnPage 重写
rep(
    """    turnPage(direction: number) {
      if (!tileVisible || flipT < 0.999) return false;
      const rows = Math.ceil(tileItems.length / TILE_COLS);
      const maxOffset = Math.max(0, rows - TILE_ROWS);
      const next = Math.min(maxOffset, Math.max(0, tileOffsetRows + direction * TILE_ROWS));
      if (next === tileOffsetRows) return false;
      pendingFlipOffset = next;
      // 翻转顺序：一次「第一块→最后一块」顺序翻转，下一次随机顺序，轮换进行
      flipDelays = tiles.map((tile) =>
        flipMode === 'seq' ? (tile.index / Math.max(1, tiles.length)) * 0.3 : Math.random() * 0.3,
      );
      flipMode = flipMode === 'seq' ? 'rand' : 'seq';
      flipT = 0;
      return true;
    },""",
    """    turnPage(direction: number) {
      if (!tileVisible || flipping) return false;
      const rows = Math.ceil(tileItems.length / TILE_COLS);
      const maxOffset = Math.max(0, rows - TILE_ROWS);
      const next = Math.min(maxOffset, Math.max(0, tileOffsetRows + direction * TILE_ROWS));
      if (next === tileOffsetRows) return false;
      tileOffsetRows = next;
      flipping = true;
      flipElapsed = 0;
      // 逐块翻转的启动时间：一次「第一块→最后一块」顺序，下一次随机，轮换
      const count = Math.max(1, tiles.length);
      flipDelays = tiles.map((tile) =>
        flipMode === 'seq' ? (tile.index / count) * 0.5 : Math.random() * 0.5,
      );
      flipMode = flipMode === 'seq' ? 'rand' : 'seq';
      tiles.forEach((tile) => {
        tile.flipped = false;
      });
      return true;
    },""",
    'turnPage',
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('per-tile flip applied')
