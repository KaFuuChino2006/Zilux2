# -*- coding: utf-8 -*-
"""拼字动画：把每个字拆成笔画，按笔顺逐笔拼合（接入 hanzi 笔顺数据）。"""
import io


def patch_file(path, pairs):
    s = io.open(path, 'r', encoding='utf-8', newline='').read()
    for old, new, label in pairs:
        assert s.count(old) == 1, f"anchor miss {label}: {old[:80]!r}"
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print('patched', path)


THREE = r"E:\Zilux2开发\web\src\three\floatScene.ts"
UI = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"

patch_file(
    THREE,
    [
        (
            """import * as THREE from 'three';""",
            """import * as THREE from 'three';
import { charStrokes, drawStrokeChar, loadStrokeFont, strokeFontReady } from './strokeFont';""",
            "import strokeFont",
        ),
        (
            """  /** 单行显示时每个字的横向范围（0~1 归一化），用于逐字扫光 */
  charBoxes: Array<{ x0: number; x1: number }>;
}""",
            """  /** 单行显示时每个字的横向范围（0~1 归一化），用于逐字扫光 */
  charBoxes: Array<{ x0: number; x1: number }>;
  /** 拼字动画：上一帧每个字已画出的笔画数（用于判断是否需要重绘） */
  strokeStamp: number[];
  /** 拼字动画：上次重绘时间（节流） */
  strokePaintedAt: number;
}""",
            "view fields",
        ),
        (
            """        charBoxes: [],
        amount: 0,
      };""",
            """        charBoxes: [],
        strokeStamp: [],
        strokePaintedAt: 0,
        amount: 0,
      };""",
            "view literal",
        ),
        (
            """        view.text = line.text;
        view.translation = line.translation ?? '';
        view.amount = 0;
        paintLyricLine(view);""",
            """        view.text = line.text;
        view.translation = line.translation ?? '';
        view.amount = 0;
        view.strokeStamp = [];
        paintLyricLine(view);""",
            "reset stamp on line change",
        ),
        (
            """    ctx.fillStyle = 'rgba(255,255,255,1)';
    view.charBoxes = drawLyricTextWithBoxes(ctx, view.text, W / 2, mainY, W * 0.94, 2, 56, 34, 700).map(
      (box) => ({ x0: box.x0 / W, x1: box.x1 / W }),
    );""",
            """    ctx.fillStyle = 'rgba(255,255,255,1)';
    const assemble = wordWrite && strokeFontReady() && Array.from(view.text).length <= 24;
    if (assemble) {
      // 拼字动画：把每个字拆成笔画，按当前进度逐笔拼合
      const size = fitLyricFontSize(ctx, view.text, W * 0.94, 56, 34, 700);
      const glyphs = Array.from(view.text);
      const widths = glyphs.map((glyph) => ctx.measureText(glyph).width);
      const total = widths.reduce((sum, width) => sum + width, 0);
      let cursor = W / 2 - total / 2;
      const boxes: Array<{ x0: number; x1: number }> = [];
      const charSize = size * 1.06;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      glyphs.forEach((glyph, index) => {
        const width = widths[index];
        if (glyph.trim().length === 0) {
          cursor += width;
          return;
        }
        const centerX = cursor + width / 2;
        const strokeCount = charStrokes(glyph)?.length ?? 0;
        if (strokeCount === 0) {
          ctx.fillText(glyph, centerX, mainY);
        } else {
          drawStrokeChar(ctx, glyph, centerX, mainY, charSize, view.strokeStamp[index] ?? 0);
        }
        boxes.push({ x0: cursor / W, x1: (cursor + width) / W });
        cursor += width;
      });
      view.charBoxes = boxes;
    } else {
      view.charBoxes = drawLyricTextWithBoxes(ctx, view.text, W / 2, mainY, W * 0.94, 2, 56, 34, 700).map(
        (box) => ({ x0: box.x0 / W, x1: box.x1 / W }),
      );
    }""",
            "assemble drawing",
        ),
        (
            """      material.uniforms.uCharCount!.value = charCount;
      material.uniforms.uWrite!.value = wordWrite && charCount > 0 ? 1 : 0;""",
            """      const assembleActive = wordWrite && strokeFontReady() && charCount > 0;
      material.uniforms.uCharCount!.value = charCount;
      material.uniforms.uWrite!.value = assembleActive ? 0 : wordWrite && charCount > 0 ? 1 : 0;""",
            "uWrite in assemble",
        ),
        (
            """      material.uniforms.uProgress!.value = wordFill ? lyricRevealFor(view) : 1;
      material.uniforms.uOpacity!.value = ease * enter;""",
            """      material.uniforms.uProgress!.value = wordFill ? lyricRevealFor(view) : 1;
      material.uniforms.uOpacity!.value = ease * enter;
      if (assembleActive) {
        // 笔画拼合：按字的进度逐笔画出；只有笔画数变化才重绘（节流 45ms）
        const now = performance.now();
        if (now - view.strokePaintedAt > 45) {
          const nextStamp: number[] = [];
          let changed = view.strokeStamp.length !== charCount;
          for (let i = 0; i < charCount; i += 1) {
            const char = chars![i];
            const span = Math.max(0.24, (char.end - char.start) * 1.05);
            const progress = Math.min(1, Math.max(0, (lyricClock - char.start) / span));
            const count = progress * (charStrokes(char.text)?.length ?? 0);
            nextStamp.push(count);
            if (!changed && Math.abs((view.strokeStamp[i] ?? 0) - count) > 0.04) changed = true;
          }
          if (changed) {
            view.strokeStamp = nextStamp;
            view.strokePaintedAt = now;
            paintLyricLine(view);
          }
        }
      }""",
            "assemble repaint",
        ),
        (
            """    setLyricWordOptions(options) {
      if (typeof options.fill === 'boolean') wordFill = options.fill;""",
            """    setLyricWordOptions(options) {
      if (options.write) void loadStrokeFont();
      if (typeof options.fill === 'boolean') wordFill = options.fill;""",
            "preload strokes",
        ),
    ],
)

patch_file(
    UI,
    [
        (
            """                <button class="custom-seg-btn" data-words-write="on" type="button">开</button>
                <button class="custom-seg-btn is-on" data-words-write="off" type="button">关</button>
              </div>
              <p class="custom-tip">每个字按笔画走势逐段浮现（逐字时间来自网易云逐字歌词，没有时按整句均分）</p>""",
            """                <button class="custom-seg-btn" data-words-write="on" type="button">开</button>
                <button class="custom-seg-btn is-on" data-words-write="off" type="button">关</button>
              </div>
              <p class="custom-tip">把每个字拆成笔画，按笔顺一笔一笔拼起来（首次开启会加载笔顺数据）</p>""",
            "assemble label",
        ),
        (
            """            <div class="custom-field custom-words">
              <div class="custom-label"><span>书写动画</span><b data-words-write-current>关</b></div>""",
            """            <div class="custom-field custom-words">
              <div class="custom-label"><span>拼字动画</span><b data-words-write-current>关</b></div>""",
            "assemble title",
        ),
    ],
)
print('assemble patch done')
