# -*- coding: utf-8 -*-
"""3D 歌词完整显示（自动缩字号/换行，不再出现省略号）+ 歌词模式禁用滚轮缩放。"""
import io

SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'


def read(p):
    return io.open(p, 'r', encoding='utf-8', newline='').read()


def write(p, t):
    io.open(p, 'w', encoding='utf-8', newline='').write(t)


s = read(SCENE)

# 1) 歌词模式禁用滚轮缩放（相机由歌词跟随接管）
old = """  const onWheel = (event: WheelEvent): void => {
    if (!entered) return;"""
new = """  const onWheel = (event: WheelEvent): void => {
    if (!entered || lyricVisible) return;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) 画布加大，留足横向空间
old = """      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 256;"""
new = """      const canvas = document.createElement('canvas');
      canvas.width = 1536;
      canvas.height = 384;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 3) 重写文字绘制：自动缩字号 + 超长换行，绝不出省略号
old = """  function clipTextWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let out = text;
    while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) {
      out = out.slice(0, -1);
    }
    return out + '…';
  }

  function paintLyricLine(view: LyricLineView): void {
    const ctx = view.canvas.getContext('2d');
    if (!ctx) return;
    const W = view.canvas.width;
    const H = view.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const hasTranslation = view.translation.trim().length > 0;
    const mainSize = view.active ? 74 : 54;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (view.active) {
      ctx.shadowColor = 'rgba(146, 122, 255, 0.85)';
      ctx.shadowBlur = 26;
    }
    ctx.fillStyle = view.active ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.66)';
    ctx.font = '700 ' + mainSize + 'px ' + LYRIC_FONT;
    const mainY = hasTranslation ? H * 0.4 : H * 0.5;
    ctx.fillText(clipTextWidth(ctx, view.text, W * 0.94), W / 2, mainY);
    if (hasTranslation) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = view.active ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.4)';
      ctx.font = '500 ' + (view.active ? 36 : 28) + 'px ' + LYRIC_FONT;
      ctx.fillText(clipTextWidth(ctx, view.translation, W * 0.9), W / 2, H * 0.76);
    }
    view.texture.needsUpdate = true;
  }"""
new = """  function fitLyricFontSize(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
    baseSize: number,
    minSize: number,
    weight: number,
  ): number {
    let size = baseSize;
    ctx.font = weight + ' ' + size + 'px ' + LYRIC_FONT;
    while (size > minSize && ctx.measureText(text).width > maxWidth) {
      size = Math.max(minSize, size - 2);
      ctx.font = weight + ' ' + size + 'px ' + LYRIC_FONT;
    }
    return size;
  }

  function drawLyricText(
    ctx: CanvasRenderingContext2D,
    text: string,
    centerX: number,
    centerY: number,
    maxWidth: number,
    maxLines: number,
    baseSize: number,
    minSize: number,
    weight: number,
  ): void {
    if (!text) return;
    const size = fitLyricFontSize(ctx, text, maxWidth, baseSize, minSize, weight);
    let lines = [text];
    if (ctx.measureText(text).width > maxWidth) {
      // 缩到最小字号仍放不下：按字符均衡拆成多行，完整显示（不省略）
      lines = [];
      const perLine = Math.max(1, Math.ceil(text.length / maxLines));
      for (let i = 0; i < text.length; i += perLine) {
        lines.push(text.slice(i, i + perLine));
      }
    }
    const lineHeight = size * 1.16;
    const startY = centerY - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, index) => {
      ctx.fillText(line, centerX, startY + index * lineHeight);
    });
  }

  function paintLyricLine(view: LyricLineView): void {
    const ctx = view.canvas.getContext('2d');
    if (!ctx) return;
    const W = view.canvas.width;
    const H = view.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const hasTranslation = view.translation.trim().length > 0;
    if (view.active) {
      ctx.shadowColor = 'rgba(146, 122, 255, 0.85)';
      ctx.shadowBlur = 30;
    }
    ctx.fillStyle = view.active ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.66)';
    drawLyricText(
      ctx,
      view.text,
      W / 2,
      hasTranslation ? H * 0.38 : H * 0.5,
      W * 0.94,
      2,
      view.active ? 96 : 72,
      view.active ? 56 : 44,
      700,
    );
    if (hasTranslation) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = view.active ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.4)';
      drawLyricText(
        ctx,
        view.translation,
        W / 2,
        H * 0.8,
        W * 0.9,
        2,
        view.active ? 46 : 36,
        view.active ? 30 : 24,
        500,
      );
    }
    view.texture.needsUpdate = true;
  }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

write(SCENE, s)
print('floatScene: lyrics fit (no ellipsis) + wheel disabled in lyrics mode')
