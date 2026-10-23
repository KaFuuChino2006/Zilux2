# -*- coding: utf-8 -*-
import io

p = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 在 debugRepaintAll 前插入 canvas 审计
anchor = "  debugRepaintAll(marker: string): void {"
assert s.count(anchor) == 1

helper = r'''  debugAudit(): Array<{ index: number; text: string; amount: number; sig1: number; sig2: number }> {
    const hashCanvas = (canvas: HTMLCanvasElement): number => {
      const tiny = document.createElement('canvas');
      tiny.width = 24;
      tiny.height = 6;
      const tctx = tiny.getContext('2d');
      if (!tctx) return 0;
      tctx.drawImage(canvas, 0, 0, 24, 6);
      const data = tctx.getImageData(0, 0, 24, 6).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum = (sum * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7) % 2147483647;
      return sum;
    };
    return lyricLines.map((view) => {
      const sig1 = hashCanvas(view.canvas);
      paintLyricLine(view);
      const sig2 = hashCanvas(view.canvas);
      return { index: view.index, text: view.text, amount: view.amount, sig1, sig2 };
    });
  },

'''
s = s.replace(anchor, helper + anchor, 1)

old = "  debugRepaintAll(marker: string): void;"
assert s.count(old) == 1
s = s.replace(old, old + "\n  debugAudit(): Array<{ index: number; text: string; amount: number; sig1: number; sig2: number }>;", 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)

p2 = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s2 = io.open(p2, 'r', encoding='utf-8', newline='').read()
a2 = "  (window as unknown as { __lyricRed?: () => void }).__lyricRed = () => space?.debugPaintRed?.();"
assert s2.count(a2) == 1
s2 = s2.replace(a2, a2 + "\n  (window as unknown as { __lyricAudit?: () => unknown }).__lyricAudit = () => space?.debugAudit?.();", 1)
io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
print('audit hook added')
