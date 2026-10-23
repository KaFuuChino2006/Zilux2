import io
from pathlib import Path

p = Path(r"E:\Zilux2开发\web\src\three\floatScene.ts")
raw = io.open(p, "r", encoding="utf-8", newline="").read()
text = raw.replace("\r\n", "\n")

def rep(old, new, count=1):
    global text
    assert text.count(old) == count, f"anchor fail ({text.count(old)}): {old[:70]}"
    text = text.replace(old, new)

# 1) 补 ellipsize 辅助函数（放在 wrapLines 之后）
rep(
    """  if (lines.length < maxLines && current) lines.push(current);
  return lines;
}""",
    """  if (lines.length < maxLines && current) lines.push(current);
  return lines;
}

/** 单行截断：超出宽度时末尾换成省略号（磁贴底部的歌手名用） */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = Array.from(text);
  let out = '';
  for (const ch of chars) {
    if (ctx.measureText(out + ch + '…').width > maxWidth) break;
    out += ch;
  }
  return out ? `${out}…` : '…';
}""",
)

# 2) 1853 行的 tileFaceKey 补 artist
rep(
    "    tile.paintKey = tileFaceKey(tile, tile.image, tile.title);",
    "    tile.paintKey = tileFaceKey(tile, tile.image, tile.title, tile.artist);",
)

io.open(p, "w", encoding="utf-8", newline="").write(text.replace("\n", "\r\n") if "\r\n" in raw else text)
print("OK folia2")
