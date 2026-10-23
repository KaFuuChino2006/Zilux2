# -*- coding: utf-8 -*-
"""歌词放大清晰化：画布分辨率随字号倍率自适应 + 开启 mipmap/各向异性。"""
import io
import sys
from pathlib import Path

TARGET = Path(r"E:\Zilux2开发\web\src\three\floatScene.ts")
text = io.open(str(TARGET), encoding="utf-8", newline="").read()
crlf = "\r\n" in text
NL = "\r\n" if crlf else "\n"


def rep(name, old, new, count=1):
    global text
    old = old.replace("\n", NL)
    new = new.replace("\n", NL)
    got = text.count(old)
    if got != count:
        print(f"FAIL {name}: count={got} expect={count}")
        sys.exit(1)
    text = text.replace(old, new)
    print(f"OK: {name}")


# 1) 状态 + 倍率函数
rep(
    "state",
    "  let lyricsScale = 1;\n",
    """  let lyricsScale = 1;
  /** 歌词画布像素倍率：字号放大时提高画布分辨率，避免纹理被拉伸发糊 */
  let lyricTexScale = 1;
  const lyricTextureFactor = (): number => Math.min(2.5, Math.max(1, Math.round(lyricsScale * 4) / 4));
""",
)

# 2) 建画布时按倍率取分辨率
rep(
    "canvas-init",
    """      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 256;
""",
    """      const canvas = document.createElement('canvas');
      // 画布按当前字号倍率提高分辨率；绘图尺寸统一按 1024 基准等比放大，版式保持不变
      lyricTexScale = lyricTextureFactor();
      canvas.width = Math.round(1024 * lyricTexScale);
      canvas.height = Math.round(256 * lyricTexScale);
""",
)

# 3) 纹理过滤：mipmap + 各向异性
rep(
    "tex-filter",
    """      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
""",
    """      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = 4;
""",
)

# 4) paintLyricLine 内所有像素尺寸按 texScale 等比放大
rep(
    "tex-scale-var",
    """    const W = view.canvas.width;
    const H = view.canvas.height;
""",
    """    const W = view.canvas.width;
    const H = view.canvas.height;
    // 画布分辨率随字号倍率变化，字号/柔光也按 1024 基准等比缩放
    const texScale = W / 1024;
""",
)
rep("shadow", "    ctx.shadowBlur = 9;\n", "    ctx.shadowBlur = 9 * texScale;\n")
rep(
    "assemble-size",
    "fitLyricFontSize(ctx, view.text, W * 0.94, 56, 34, 700)",
    "fitLyricFontSize(ctx, view.text, W * 0.94, 56 * texScale, 34 * texScale, 700)",
)
rep(
    "glyph-size",
    "drawLyricGlyphsWithBoxes(ctx, view.text, W / 2, mainY, W * 0.94, 2, 56, 34, 700, view.index)",
    "drawLyricGlyphsWithBoxes(ctx, view.text, W / 2, mainY, W * 0.94, 2, 56 * texScale, 34 * texScale, 700, view.index)",
)
rep(
    "translation-size",
    "drawLyricText(ctx, view.translation, W / 2, H * 0.8, W * 0.9, 2, 28, 18, 500)",
    "drawLyricText(ctx, view.translation, W / 2, H * 0.8, W * 0.9, 2, 28 * texScale, 18 * texScale, 500)",
)

# 5) 分辨率切换函数（插在 paintLyricLine 之前）
rep(
    "resolution-fn",
    "  function paintLyricLine(view: LyricLineView): void {\n",
    """  /** 字号变化时重设歌词画布分辨率并重绘，保证放大后依然清晰 */
  function applyLyricResolution(): void {
    if (!lyricGroup) return;
    const next = lyricTextureFactor();
    if (Math.abs(next - lyricTexScale) < 0.001) return;
    lyricTexScale = next;
    for (const view of lyricLines) {
      view.canvas.width = Math.round(1024 * next);
      view.canvas.height = Math.round(256 * next);
      view.texture.needsUpdate = true;
      view.paintProgress = -1;
      paintLyricLine(view);
    }
  }

  function paintLyricLine(view: LyricLineView): void {
""",
)

# 6) setLyricsScale 里触发分辨率更新
rep(
    "handle-setLyricsScale",
    """    setLyricsScale(scale: number) {
      lyricsScale = Math.max(0.2, Math.min(4, scale));
    },
""",
    """    setLyricsScale(scale: number) {
      lyricsScale = Math.max(0.2, Math.min(4, scale));
      applyLyricResolution();
    },
""",
)

io.open(str(TARGET), "w", encoding="utf-8", newline="").write(text)
print("WROTE", TARGET, "crlf=", crlf)
