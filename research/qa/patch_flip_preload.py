# -*- coding: utf-8 -*-
"""翻页前预加载目标页封面，再开始翻转。"""
import io

P = r"E:\Zilux2开发\web\src\three\floatScene.ts"


def replace_once(text, old, new, label):
    assert text.count(old) == 1, (label, text.count(old))
    return text.replace(old, new, 1)


s = io.open(P, "r", encoding="utf-8", newline="").read()

# 1) 缓存 + 加载器（插到 enqueueCover 前）
old_anchor = "  function enqueueCover(tile: Tile, url: string): void {"
new_anchor = """  /* 封面缓存与预加载：翻页前先把目标页封面解码好，翻转时不掉帧、不空白 */
  const coverCache = new Map<string, HTMLImageElement>();

  function loadCover(url: string): Promise<HTMLImageElement | null> {
    const cached = coverCache.get(url);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        coverCache.set(url, img);
        resolve(img);
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  async function preloadPageCovers(
    list: Array<{ cover?: string }>,
  ): Promise<void> {
    const urls = Array.from(
      new Set(list.map((item) => item.cover).filter((url): url is string => Boolean(url))),
    );
    if (urls.length === 0) return;
    await Promise.race([
      Promise.all(urls.map((url) => loadCover(url))),
      new Promise((resolve) => window.setTimeout(resolve, 1600)),
    ]);
  }

  function enqueueCover(tile: Tile, url: string): void {"""
s = replace_once(s, old_anchor, new_anchor, "cache-helper")

# 2) 队列加载完成也写缓存
old_pump = """      img.onload = () => {
        coverActive -= 1;
        job.tile.image = img;
        drawTile(job.tile);
        pumpCoverQueue();
      };"""
new_pump = """      img.onload = () => {
        coverActive -= 1;
        coverCache.set(job.url, img);
        job.tile.image = img;
        drawTile(job.tile);
        pumpCoverQueue();
      };"""
s = replace_once(s, old_pump, new_pump, "pump-cache")

# 3) 翻转时优先用缓存封面
old_flip = """          tile.backImage = null;
          tile.backPlane.visible = true;
          drawTileBack(tile);
          if (item?.cover) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
              tile.backImage = img;
              drawTileBack(tile);
              if (tile.committed) {
                tile.image = img;
                drawTile(tile);
              }
            };
            img.src = item.cover;
          }"""
new_flip = """          tile.backImage = item?.cover ? coverCache.get(item.cover) ?? null : null;
          tile.backPlane.visible = true;
          drawTileBack(tile);
          if (item?.cover && !tile.backImage) {
            const url = item.cover;
            void loadCover(url).then((img) => {
              if (!img) return;
              tile.backImage = img;
              drawTileBack(tile);
              if (tile.committed) {
                tile.image = img;
                drawTile(tile);
              }
            });
          }"""
s = replace_once(s, old_flip, new_flip, "flip-cache")

# 4) switchPage：先预加载再翻
old_switch = """    switchPage(list) {
      if (!tileVisible) return;
      pendingItems = list.slice(0, 20000);
      tileOffsetRows = 0;
      flipping = true;
      flipElapsed = 0;
      const count = Math.max(1, tiles.length);
      flipDelays = tiles.map((tile) =>
        flipMode === 'seq' ? (tile.index / count) * 0.5 : Math.random() * 0.5,
      );
      flipMode = flipMode === 'seq' ? 'rand' : 'seq';
      tiles.forEach((tile) => {
        tile.flipped = false;
        tile.committed = false;
        tile.backPlane.visible = false;
      });
    },"""
new_switch = """    switchPage(list) {
      if (!tileVisible || flipping || flipPreparing) return;
      const page = list.slice(0, 20000);
      flipPreparing = true;
      void (async () => {
        // 先把目标页封面全部预解码，再开始翻转（避免翻到一半封面才跳出来）
        await preloadPageCovers(page);
        if (!tileVisible) {
          flipPreparing = false;
          return;
        }
        flipPreparing = false;
        pendingItems = page;
        tileOffsetRows = 0;
        flipping = true;
        flipElapsed = 0;
        const count = Math.max(1, tiles.length);
        flipDelays = tiles.map((tile) =>
          flipMode === 'seq' ? (tile.index / count) * 0.5 : Math.random() * 0.5,
        );
        flipMode = flipMode === 'seq' ? 'rand' : 'seq';
        tiles.forEach((tile) => {
          tile.flipped = false;
          tile.committed = false;
          tile.backPlane.visible = false;
        });
      })();
    },"""
s = replace_once(s, old_switch, new_switch, "switch-preload")

# 5) 声明 flipPreparing（跟 flipping 一起）
old_decl = "  let flipping = false;"
assert s.count(old_decl) == 1, s.count(old_decl)
s = s.replace(old_decl, "  let flipping = false;\n  let flipPreparing = false;", 1)

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("flip preload wired")
