# -*- coding: utf-8 -*-
"""完整 180° 翻页：每块磁贴有正反两面；翻到 90° 时把下一页封面画到背面，
继续转到 180° 露出背面（新封面），完成后把新封面画到正面并把角度复位，衔接无跳变。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def cut(start_marker: str, end_marker: str) -> None:
    """用新块替换 start_marker 到 end_marker（含）之间的文本。"""
    global s
    a = s.index(start_marker)
    b = s.index(end_marker, a) + len(end_marker)
    return a, b


# ---------- A. 通用绘制 + 正反两面 ----------
a, b = cut("  function drawTile(tile: Tile): void {", "    tile.texture.needsUpdate = true;\n  }")
new_draw = """  function paintTile(
    canvas: HTMLCanvasElement,
    image: HTMLImageElement | null,
    title: string,
    index: number,
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const S = canvas.width;
    ctx.clearRect(0, 0, S, S);
    const radius = S * 0.045;
    roundRect(ctx, 1.5, 1.5, S - 3, S - 3, radius);
    ctx.save();
    ctx.clip();
    if (image) {
      const scale = Math.max(S / image.naturalWidth, S / image.naturalHeight);
      const w = image.naturalWidth * scale;
      const h = image.naturalHeight * scale;
      ctx.drawImage(image, (S - w) / 2, (S - h) / 2, w, h);
    } else {
      const hue = (index * 47) % 360;
      const grad = ctx.createLinearGradient(0, 0, S, S);
      grad.addColorStop(0, 'hsl(' + hue + ' 52% 74%)');
      grad.addColorStop(1, 'hsl(' + ((hue + 46) % 360) + ' 58% 62%)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, S, S);
    }
    const shade = ctx.createLinearGradient(0, S * 0.48, 0, S);
    shade.addColorStop(0, 'rgba(6, 8, 14, 0)');
    shade.addColorStop(1, 'rgba(6, 8, 14, 0.66)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, S * 0.48, S, S * 0.52);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.97)';
    ctx.font = '600 ' + S * 0.074 + 'px ' + FONT;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const lines = wrapLines(ctx, title || '未命名', S * 0.88, 2);
    lines.forEach((line, i) => {
      ctx.fillText(line, S * 0.055, S * 0.9 - (lines.length - 1 - i) * S * 0.082);
    });
    ctx.restore();
  }

  function drawTile(tile: Tile): void {
    paintTile(tile.canvas, tile.image, tile.title, tile.index);
    tile.texture.needsUpdate = true;
  }

  function drawTileBack(tile: Tile): void {
    paintTile(tile.backCanvas, tile.backImage, tile.backTitle, tile.index);
    tile.backTexture.needsUpdate = true;
  }"""
s = s[:a] + new_draw + s[b:]

# ---------- B. Tile 接口增加背面 ----------
old_iface = """    liftT: number;
    flipped: boolean;
  }"""
new_iface = """    liftT: number;
    flipped: boolean;
    committed: boolean;
    backCanvas: HTMLCanvasElement;
    backTexture: THREE.CanvasTexture;
    backPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    backImage: HTMLImageElement | null;
    backTitle: string;
  }"""
assert s.count(old_iface) == 1
s = s.replace(old_iface, new_iface, 1)

# ---------- C. 创建 tile 时加背面 ----------
old_create = """    const hit = new THREE.Mesh(
      new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
    );
    const group = new THREE.Group();
    group.add(plane);
    group.add(hit);"""
new_create = """    const hit = new THREE.Mesh(
      new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
    );
    const backCanvas = document.createElement('canvas');
    backCanvas.width = 320;
    backCanvas.height = 320;
    const backTexture = new THREE.CanvasTexture(backCanvas);
    backTexture.colorSpace = THREE.SRGBColorSpace;
    backTexture.generateMipmaps = false;
    backTexture.minFilter = THREE.LinearFilter;
    backTexture.magFilter = THREE.LinearFilter;
    const backPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE),
      new THREE.MeshBasicMaterial({ map: backTexture, transparent: true, depthWrite: false }),
    );
    backPlane.rotation.y = Math.PI;
    backPlane.position.z = -0.002;
    backPlane.visible = false;
    const group = new THREE.Group();
    group.add(plane);
    group.add(backPlane);
    group.add(hit);"""
assert s.count(old_create) == 1
s = s.replace(old_create, new_create, 1)

old_tile_init = """      liftT: 0,
      flipped: false,
    };"""
new_tile_init = """      liftT: 0,
      flipped: false,
      committed: false,
      backCanvas,
      backTexture,
      backPlane,
      backImage: null,
      backTitle: '',
    };"""
assert s.count(old_tile_init) == 1
s = s.replace(old_tile_init, new_tile_init, 1)

# ---------- D. 逐块翻页：占用 0→π ----------
old_frame = """    if (flipping) {
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
    }"""
new_frame = """    if (flipping) {
      flipElapsed += delta;
      let allDone = true;
      tiles.forEach((tile) => {
        const delay = flipDelays[tile.index] ?? 0;
        const local = Math.min(1, Math.max(0, (flipElapsed - delay) / FLIP_ITEM_MS));
        if (local < 1) allDone = false;
        const row = Math.floor(tile.index / TILE_COLS);
        const itemIndex = (tileOffsetRows + row) * TILE_COLS + (tile.index % TILE_COLS);
        const item = tileItems[itemIndex];
        if (local >= 0.5 && !tile.flipped) {
          // 翻到 90°：把下一页内容画到背面（每帧只处理到点的那几块）
          tile.flipped = true;
          tile.backTitle = item?.title ?? '';
          tile.backImage = null;
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
          }
        }
        if (local >= 0.98 && !tile.committed) {
          // 翻到 180°：背面朝前，把同样内容画到正面并瞬间复位角度（视觉无跳变）
          tile.committed = true;
          tile.title = tile.backTitle;
          tile.image = tile.backImage;
          drawTile(tile);
          tile.group.rotation.y = 0;
          tile.backPlane.visible = false;
        }
      });
      if (allDone) {
        flipping = false;
        tiles.forEach((tile) => {
          tile.group.rotation.y = 0;
          tile.backPlane.visible = false;
        });
      }
    }"""
assert s.count(old_frame) == 1
s = s.replace(old_frame, new_frame, 1)

# ---------- E. 角度：0 → 180° ----------
old_rot = """      // 逐块翻页：每块到 90° 时换自己的图，再翻回，视觉上是封面依次翻转
      if (flipping) {
        const delay = flipDelays[tile.index] ?? 0;
        const local = Math.min(1, Math.max(0, (flipElapsed - delay) / FLIP_ITEM_MS));
        tile.group.rotation.y = Math.sin(local * Math.PI) * (Math.PI / 2);
      } else if (tile.group.rotation.y !== 0) {
        tile.group.rotation.y = 0;
      }"""
new_rot = """      // 完整 180° 翻页：0→90° 露正面旧封面，90° 后换背面新封面，转到 180° 时由正面接替
      if (flipping) {
        const delay = flipDelays[tile.index] ?? 0;
        const local = Math.min(1, Math.max(0, (flipElapsed - delay) / FLIP_ITEM_MS));
        tile.group.rotation.y = local * Math.PI;
      } else if (tile.group.rotation.y !== 0) {
        tile.group.rotation.y = 0;
      }"""
assert s.count(old_rot) == 1
s = s.replace(old_rot, new_rot, 1)

# ---------- F. turnPage 初始化背面 ----------
old_turn = """      tiles.forEach((tile) => {
        tile.flipped = false;
      });
      return true;"""
new_turn = """      tiles.forEach((tile) => {
        tile.flipped = false;
        tile.committed = false;
        tile.backPlane.visible = false;
      });
      return true;"""
assert s.count(old_turn) == 1
s = s.replace(old_turn, new_turn, 1)

# ---------- G. dispose 释放背面资源 ----------
old_dispose = """        tile.texture.dispose();
        tile.plane.geometry.dispose();
        tile.plane.material.dispose();
        tile.hit.geometry.dispose();
        tile.hit.material.dispose();"""
new_dispose = """        tile.texture.dispose();
        tile.plane.geometry.dispose();
        tile.plane.material.dispose();
        tile.backTexture.dispose();
        tile.backPlane.geometry.dispose();
        tile.backPlane.material.dispose();
        tile.hit.geometry.dispose();
        tile.hit.material.dispose();"""
assert s.count(old_dispose) == 1
s = s.replace(old_dispose, new_dispose, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('180deg flip applied')
