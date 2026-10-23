# -*- coding: utf-8 -*-
import io

p = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) Tile 增加 paintKey / backPaintKey
old = """    image: HTMLImageElement | null;
    title: string;
    hoverT: number;"""
assert s.count(old) == 1, "tile interface anchor"
s = s.replace(old, """    image: HTMLImageElement | null;
    title: string;
    paintKey: string;
    backPaintKey: string;
    hoverT: number;""", 1)

# 2) 创建 Tile 时补字段
old = """      image: null,
      title: '',
      hoverT: 0,"""
if s.count(old) != 1:
    # 打印附近以便定位
    idx = s.find("image: null,")
    raise SystemExit("creation anchor not found; near: " + repr(s[idx-80:idx+200]))
s = s.replace(old, """      image: null,
      title: '',
      paintKey: '',
      backPaintKey: '',
      hoverT: 0,""", 1)

# 3) drawTile / drawTileBack 增加缓存键跳过；新增分批绘制队列
old = """  let tileLabelsHidden = false;

  function drawTile(tile: Tile): void {
    paintTile(tile.canvas, tile.image, tileLabelsHidden ? '' : tile.title, tile.index);
    tile.texture.needsUpdate = true;
  }

  function drawTileBack(tile: Tile): void {
    paintTile(tile.backCanvas, tile.backImage, tileLabelsHidden ? '' : tile.backTitle, tile.index);
    tile.backTexture.needsUpdate = true;
  }
"""
new = """  let tileLabelsHidden = false;

  /** 首屏/翻页需要重绘的磁贴；每帧只画一部分，避免一次重绘 200+ 张导致卡顿 */
  const dirtyTilePaint = new Set<number>();

  function tileFaceKey(tile: Tile, image: HTMLImageElement | null, title: string): string {
    return `${tile.index}|${title}|${image ? image.src : ''}|${tileLabelsHidden ? 'h' : 'v'}`;
  }

  function drawTile(tile: Tile): void {
    const key = tileFaceKey(tile, tile.image, tile.title);
    if (tile.paintKey === key) return;
    tile.paintKey = key;
    paintTile(tile.canvas, tile.image, tileLabelsHidden ? '' : tile.title, tile.index);
    tile.texture.needsUpdate = true;
  }

  function drawTileBack(tile: Tile): void {
    const key = tileFaceKey(tile, tile.backImage, tile.backTitle);
    if (tile.backPaintKey === key) return;
    tile.backPaintKey = key;
    paintTile(tile.backCanvas, tile.backImage, tileLabelsHidden ? '' : tile.backTitle, tile.index);
    tile.backTexture.needsUpdate = true;
  }

  /** 每帧最多绘制 limit 张，平滑分摊文字渲染与纹理上传 */
  function flushTilePaint(limit = 18): void {
    if (dirtyTilePaint.size === 0) return;
    let painted = 0;
    for (const index of Array.from(dirtyTilePaint)) {
      dirtyTilePaint.delete(index);
      const tile = tiles[index];
      if (tile) drawTile(tile);
      painted += 1;
      if (painted >= limit) break;
    }
  }

  function clearTilePaintQueue(): void {
    dirtyTilePaint.clear();
  }
"""
assert s.count(old) == 1, "drawTile anchor"
s = s.replace(old, new, 1)

# 4) refreshTiles：改为分批绘制，并从封面缓存直接取图，减少二次重绘
old = """    tiles.forEach((tile) => {
      const row = Math.floor(tile.index / tileCols);
      const itemIndex = (tileOffsetRows + row) * tileCols + (tile.index % tileCols);
      const item = tileItems[itemIndex];
      const slot = tileSlot(tile.index);
      tile.group.position.x = slot.x;
      tile.group.position.y = slot.y;
      const inPage = tile.index < tileCols * tileRows;
      tile.group.visible = tileVisible && Boolean(item) && inPage;
      tile.image = null;
      if (!item) {
        tile.title = '';
        drawTile(tile);
        return;
      }
      tile.title = item.title;
      drawTile(tile);
      const cover = item.cover;
      if (cover) {
        enqueueCover(tile, cover);
      }
    });"""
new = """    tiles.forEach((tile) => {
      const row = Math.floor(tile.index / tileCols);
      const itemIndex = (tileOffsetRows + row) * tileCols + (tile.index % tileCols);
      const item = tileItems[itemIndex];
      const slot = tileSlot(tile.index);
      tile.group.position.x = slot.x;
      tile.group.position.y = slot.y;
      const inPage = tile.index < tileCols * tileRows;
      tile.group.visible = tileVisible && Boolean(item) && inPage;
      if (!item) {
        tile.title = '';
        tile.image = null;
        dirtyTilePaint.add(tile.index);
        return;
      }
      tile.title = item.title;
      const cover = item.cover;
      const cached = cover ? coverCache.get(cover) ?? null : null;
      tile.image = cached;
      dirtyTilePaint.add(tile.index);
      if (cover && !cached) {
        enqueueCover(tile, cover);
      }
    });"""
assert s.count(old) == 1, "refreshTiles body anchor"
s = s.replace(old, new, 1)

# 5) 帧循环里冲刷绘制队列（放在 updateTiles 之后）
old = """    updateTiles(delta);
    updateLyrics(delta);"""
assert s.count(old) == 1
s = s.replace(old, """    updateTiles(delta);
    flushTilePaint(18);
    updateLyrics(delta);""", 1)

# 6) 建池/清池时重置队列，防止旧索引错画
old = """  function disposeTilePool(): void {
    tiles.forEach((tile) => {"""
assert s.count(old) == 1
s = s.replace(old, """  function disposeTilePool(): void {
    clearTilePaintQueue();
    tiles.forEach((tile) => {""", 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print("tile paint cache + staged flush patched")

# 7) 翻页提交：用背面画布快速 blit 到正面（背面期间已绘制，省 216 次全量重绘）
old = """    backPlane: THREE.Mesh;
    committed: boolean;"""
assert s.count(old) == 1, "tile backPlane anchor"
s = s.replace(old, """    backPlane: THREE.Mesh;
    committed: boolean;
    backPaintedSeq: number;""", 1)

old = """      committed: false,"""
assert s.count(old) == 1
s = s.replace(old, """      committed: false,
      backPaintedSeq: -1,""", 1)

old = """  let tileLabelsHidden = false;"""
assert s.count(old) == 1
s = s.replace(old, """  let tileLabelsHidden = false;
  let flipSeq = 0;""", 1)

old = """  function drawTileBack(tile: Tile): void {
    const key = tileFaceKey(tile, tile.backImage, tile.backTitle);
    if (tile.backPaintKey === key) return;
    tile.backPaintKey = key;
    paintTile(tile.backCanvas, tile.backImage, tileLabelsHidden ? '' : tile.backTitle, tile.index);
    tile.backTexture.needsUpdate = true;
  }"""
assert s.count(old) == 1, "drawTileBack anchor"
s = s.replace(old, """  function drawTileBack(tile: Tile): void {
    const key = tileFaceKey(tile, tile.backImage, tile.backTitle);
    if (tile.backPaintKey === key) {
      tile.backPaintedSeq = flipSeq;
      return;
    }
    tile.backPaintKey = key;
    paintTile(tile.backCanvas, tile.backImage, tileLabelsHidden ? '' : tile.backTitle, tile.index);
    tile.backTexture.needsUpdate = true;
    tile.backPaintedSeq = flipSeq;
  }

  /** 背面已画好时直接拷到正面：一次 drawImage 代替整张重绘（翻页提交阶段省 CPU） */
  function blitBackToFront(tile: Tile): void {
    if (tile.backPaintedSeq !== flipSeq) {
      drawTile(tile);
      return;
    }
    const ctx = tile.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, tile.canvas.width, tile.canvas.height);
    ctx.drawImage(tile.backCanvas, 0, 0);
    tile.paintKey = tileFaceKey(tile, tile.image, tile.title);
    tile.texture.needsUpdate = true;
  }""", 1)

old = """          tile.title = tile.backTitle;
          tile.image = tile.backImage;
          drawTile(tile);
          tile.group.rotation.y = 0;"""
assert s.count(old) == 1, "commit anchor"
s = s.replace(old, """          tile.title = tile.backTitle;
          tile.image = tile.backImage;
          blitBackToFront(tile);
          tile.group.rotation.y = 0;""", 1)

# 在 switchPage / turnPage 开始时推进 flipSeq
old = """  function switchPage(list: TileItem[]): void {"""
if s.count(old) == 1:
    s = s.replace(old, """  function switchPage(list: TileItem[]): void {
    flipSeq += 1;""", 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print("patch file extended with blit optimization")
