# -*- coding: utf-8 -*-
"""v2.11：
1) 收回聚焦放慢（进入快、退出慢）
2) 磁贴翻页：turnPage(direction) + 翻转动画（flipT 0→1，中点换页），并提供页码信息
3) 封面加载限流（并发 6，渐进加载）
"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 聚焦/收回速度分离
old = "    focusAmount += (focusTarget - focusAmount) * Math.min(1, delta * 5.5);"
new = """    // 进入聚焦快一些，收回放慢（避免"一抽就回去"）
    focusAmount +=
      (focusTarget - focusAmount) *
      Math.min(1, delta * (focusTarget > focusAmount ? 6.5 : 1.9));"""
assert s.count(old) == 1, 'focusAmount line missing'
s = s.replace(old, new, 1)

# 2) 翻页状态
old = "  let focusIndex = -1;\n  let pendingRestoreIndex = -1;\n  let focusAmount = 0;"
new = """  let focusIndex = -1;
  let pendingRestoreIndex = -1;
  let focusAmount = 0;
  // 翻页：flipT 0→1 做一次翻转动画，中点换页；pendingFlipOffset 待应用的目标行偏移
  let flipT = 1;
  let pendingFlipOffset = -1;"""
assert s.count(old) == 1, 'focus state decl missing'
s = s.replace(old, new, 1)

# 3) handle 接口加 turnPage / pageInfo
old = "  focusTile(index: number, info: TileDetailInfo): void;\n  unfocusTile(): void;"
new = """  focusTile(index: number, info: TileDetailInfo): void;
  unfocusTile(): void;
  turnPage(direction: number): boolean;
  pageInfo(): { page: number; total: number };"""
assert s.count(old) == 1, 'handle interface missing'
s = s.replace(old, new, 1)

# 4) frame：翻转推进（在 updateTiles 前处理）
old = "    updateTiles(delta);\n    if (pendingRestoreIndex >= 0 && focusAmount < 0.04) {"
new = """    if (flipT < 1) {
      const prevFlip = flipT;
      flipT = Math.min(1, flipT + delta / 0.55);
      if (prevFlip < 0.5 && flipT >= 0.5 && pendingFlipOffset >= 0) {
        tileOffsetRows = pendingFlipOffset;
        pendingFlipOffset = -1;
        refreshTiles();
      }
    }
    updateTiles(delta);
    if (pendingRestoreIndex >= 0 && focusAmount < 0.04) {"""
assert s.count(old) == 1, 'updateTiles frame block missing'
s = s.replace(old, new, 1)

# 5) updateTiles：应用翻转角度（在 scale 设置之后）
old = """      tile.group.scale.setScalar(
        layoutScale * (0.94 + 0.06 * appear) * (1 + t * 0.11 + sel * 0.07),
      );"""
new = """      tile.group.scale.setScalar(
        layoutScale * (0.94 + 0.06 * appear) * (1 + t * 0.11 + sel * 0.07),
      );
      // 翻页翻转：0→90° 换页 →回到 0°，绕各自中心翻转
      if (flipT < 1) {
        const flipAngle = (flipT < 0.5 ? flipT * 2 : (1 - flipT) * 2) * (Math.PI / 2);
        tile.group.rotation.y = flipAngle;
      } else if (tile.group.rotation.y !== 0) {
        tile.group.rotation.y = 0;
      }"""
assert s.count(old) == 1, 'scale block missing'
s = s.replace(old, new, 1)

# 6) handle 实现：turnPage / pageInfo（插在 focusTile 之前）
old = "    focusTile(index: number, info: TileDetailInfo) {"
new = """    turnPage(direction: number) {
      if (!tileVisible || flipT < 0.999) return false;
      const rows = Math.ceil(tileItems.length / TILE_COLS);
      const maxOffset = Math.max(0, rows - TILE_ROWS);
      const next = Math.min(maxOffset, Math.max(0, tileOffsetRows + direction * TILE_ROWS));
      if (next === tileOffsetRows) return false;
      pendingFlipOffset = next;
      flipT = 0;
      return true;
    },
    pageInfo() {
      const rows = Math.ceil(tileItems.length / TILE_COLS);
      const total = Math.max(1, Math.ceil(rows / TILE_ROWS));
      const page = Math.min(total, Math.floor(tileOffsetRows / TILE_ROWS) + 1);
      return { page, total };
    },
    focusTile(index: number, info: TileDetailInfo) {"""
assert s.count(old) == 1, 'focusTile decl missing'
s = s.replace(old, new, 1)

# 7) 封面加载限流：把 refreshTiles 里的 Image 加载改为队列（并发 6）
old = """      if (item?.cover) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          tile.image = img;
          drawTile(tile);
        };
        img.src = item.cover;
      }"""
new = """      if (item?.cover) {
        enqueueCover(tile, item.cover);
      }"""
if s.count(old) == 1:
    s = s.replace(old, new, 1)

# 在 refreshTiles 之前插入队列实现
old = "  function refreshTiles(): void {"
new = """  // 封面渐进加载队列：最多 6 张并发，避免首次进入时几十张图同时解码卡顿
  const coverQueue: Array<{ tile: Tile; url: string }> = [];
  let coverActive = 0;
  function pumpCoverQueue(): void {
    while (coverActive < 6 && coverQueue.length > 0) {
      const job = coverQueue.shift();
      if (!job) break;
      coverActive += 1;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        coverActive -= 1;
        job.tile.image = img;
        drawTile(job.tile);
        pumpCoverQueue();
      };
      img.onerror = () => {
        coverActive -= 1;
        pumpCoverQueue();
      };
      img.src = job.url;
    }
  }
  function enqueueCover(tile: Tile, url: string): void {
    coverQueue.push({ tile, url });
    pumpCoverQueue();
  }

  function refreshTiles(): void {"""
assert s.count(old) == 1, 'refreshTiles decl missing'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('flip page + slow unfocus + cover queue done')
