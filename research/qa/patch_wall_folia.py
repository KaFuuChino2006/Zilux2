import io
from pathlib import Path

p = Path(r"E:\Zilux2开发\web\src\three\floatScene.ts")
raw = io.open(p, "r", encoding="utf-8", newline="").read()
text = raw.replace("\r\n", "\n")

def rep(old, new, count=1):
    global text
    assert text.count(old) == count, f"anchor fail ({text.count(old)}): {old[:70]}"
    text = text.replace(old, new)

# 1) Tile 增加 artist 字段
rep(
    """    image: HTMLImageElement | null;
    title: string;
    paintKey: string;""",
    """    image: HTMLImageElement | null;
    title: string;
    artist: string;
    paintKey: string;""",
)

# 2) 磁贴间距：Folia 128px 格子 + 8px 间距 = 6.25%
rep(
    "    const spacing = TILE_SIZE * (1 + tileSizeVariety * 0.04);",
    "    // Folia 墙面：格子 128px、间距 8px（6.25%），大封面按同样的格子比例占位\n"
    "    const spacing = TILE_SIZE * (1.0625 + tileSizeVariety * 0.02);",
)

# 3) paintTile：Folia 风格 —— 编号徽章、底部大字标题 + 歌手、更强渐变
old_paint = text
start = old_paint.index("  function paintTile(")
end = old_paint.index("  let tileLabelsHidden = false;")
new_paint = '''  function paintTile(
    canvas: HTMLCanvasElement,
    image: HTMLImageElement | null,
    title: string,
    artist: string,
    index: number,
    hideLabel = false,
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const S = canvas.width;
    ctx.clearRect(0, 0, S, S);
    const radius = S * 0.022;
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
    if (!hideLabel) {
      // Folia 同款：编号徽章（左上角、字距拉开的两位数）
      const badgeText = String(index + 1).padStart(2, '0');
      ctx.font = '800 ' + S * 0.048 + 'px ' + FONT;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const badgeW = ctx.measureText(badgeText).width + S * 0.05;
      const badgeH = S * 0.086;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
      ctx.fillRect(S * 0.075, S * 0.075, badgeW, badgeH);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
      ctx.fillText(badgeText, S * 0.1, S * 0.075 + badgeH * 0.54);
      // 底部渐变：Folia 的 5% → 24% → 92% 三段式，压得更重
      const shade = ctx.createLinearGradient(0, S * 0.34, 0, S);
      shade.addColorStop(0, 'rgba(4, 6, 10, 0)');
      shade.addColorStop(0.34, 'rgba(4, 6, 10, 0.2)');
      shade.addColorStop(0.62, 'rgba(4, 6, 10, 0.5)');
      shade.addColorStop(1, 'rgba(4, 6, 10, 0.93)');
      ctx.fillStyle = shade;
      ctx.fillRect(0, S * 0.34, S, S * 0.66);
      const pad = S * 0.075;
      let cursor = S - pad;
      // 歌手：小字、半透明（Folia small）
      if (artist) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.76)';
        ctx.font = '650 ' + S * 0.058 + 'px ' + FONT;
        ctx.textAlign = 'left';
        const artistLine = ellipsize(ctx, artist, S - pad * 2);
        ctx.fillText(artistLine, pad, cursor - S * 0.035);
        cursor -= S * 0.1;
      }
      // 标题：大字、紧字距（Folia strong）
      if (title) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
        ctx.font = '700 ' + S * 0.125 + 'px ' + FONT;
        ctx.textAlign = 'left';
        const lines = wrapLines(ctx, title, S - pad * 2, 2);
        lines.forEach((line, i) => {
          ctx.fillText(line, pad, cursor - (lines.length - 1 - i) * S * 0.14);
        });
      }
    }
    ctx.restore();
  }

'''
text = text[:start] + new_paint + text[end:]

# 4) tileFaceKey / drawTile / drawTileBack 带 artist
rep(
    """  function tileFaceKey(tile: Tile, image: HTMLImageElement | null, title: string): string {
    return `${tile.index}|${title}|${image ? image.src : ''}|${tileLabelsHidden ? 'h' : 'v'}`;
  }""",
    """  function tileFaceKey(tile: Tile, image: HTMLImageElement | null, title: string, artist: string): string {
    return `${tile.index}|${title}|${artist}|${image ? image.src : ''}|${tileLabelsHidden ? 'h' : 'v'}`;
  }""",
)
rep(
    """    const key = tileFaceKey(tile, tile.image, tile.title);
    if (tile.paintKey === key) return;
    tile.paintKey = key;
    paintTile(tile.canvas, tile.image, tile.title, tile.index, false);""",
    """    const key = tileFaceKey(tile, tile.image, tile.title, tile.artist);
    if (tile.paintKey === key) return;
    tile.paintKey = key;
    paintTile(tile.canvas, tile.image, tile.title, tile.artist, tile.index, false);""",
)
rep(
    """    const key = tileFaceKey(tile, tile.backImage, tile.backTitle);
    if (tile.backPaintKey === key) {
      tile.backPaintedSeq = flipSeq;
      return;
    }
    tile.backPaintKey = key;
    paintTile(tile.backCanvas, tile.backImage, tile.backTitle, tile.index, false);""",
    """    const key = tileFaceKey(tile, tile.backImage, tile.backTitle, tile.artist);
    if (tile.backPaintKey === key) {
      tile.backPaintedSeq = flipSeq;
      return;
    }
    tile.backPaintKey = key;
    paintTile(tile.backCanvas, tile.backImage, tile.backTitle, tile.artist, tile.index, false);""",
)

# 5) refreshTiles 写入 artist
rep(
    """      tile.title = item.title;
      const cover = item.cover;""",
    """      tile.title = item.title;
      tile.artist = item.artist ?? '';
      const cover = item.cover;""",
)

# 6) 悬停：Folia 是悬停卡片自身放大 12.5%，邻居不位移
rep(
    """          const amount = (1 - dist / reach) * 0.16;
          pushX = (dx / dist) * amount;
          pushY = (dy / dist) * amount;""",
    """          // Folia 墙面悬停时邻居不动，只把悬停卡片自己放大
          const amount = 0;
          pushX = (dx / dist) * amount;
          pushY = (dy / dist) * amount;""",
)
rep(
    "          (1 + t * 0.11 + sel * 0.07) *",
    "          (1 + t * 0.125 + sel * 0.06) *",
)

# 7) 其他 backTitle 赋值处补 artist（Tile 构造在 buildTilePool）
rep(
    """    backTitle: '',""",
    """    backTitle: '',
    artist: '',""",
) if "backTitle: ''," in text else None

io.open(p, "w", encoding="utf-8", newline="").write(text.replace("\n", "\r\n") if "\r\n" in raw else text)
print("OK wall folia")
