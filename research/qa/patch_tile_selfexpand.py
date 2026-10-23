# -*- coding: utf-8 -*-
"""m09478：磁贴本体原位放大（3D），模糊层挖洞让放大磁贴清晰；不再显示任何放大卡。"""
import io

# 1) floatScene：聚焦磁贴不再淡出（要显示本体放大）
p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()
old = """        // 页面会在同一位置叠加清晰的放大卡，3D 本体淡出避免重影
        tile.plane.material.opacity *= 1 - focusAmount;"""
new = """        // 本体原地放大；周围由页面模糊层处理，放大磁贴区域挖洞保持清晰"""
if s.count(old) != 1:
    raise SystemExit(f'fade: {s.count(old)}')
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('floatScene: no fade-out')

# 2) spaceShell：显示时只设置 CSS 变量（挖洞），不再定位/显示放大卡
p2 = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s2 = io.open(p2, 'r', encoding='utf-8', newline='').read()
old2 = """    requestAnimationFrame(() => {
      // 原位放大：把放大卡直接放在被点封面原来的屏幕位置
      const focus = space?.focusScreenPoint?.() ?? null;
      if (focus) {
        const size = Math.max(200, focus.radius * 2);
        tileFocusCard.style.left = `${(focus.x - size / 2).toFixed(1)}px`;
        tileFocusCard.style.top = `${(focus.y - size / 2).toFixed(1)}px`;
        tileFocusCard.style.width = `${size.toFixed(1)}px`;
      }
      tileDetailEl.classList.add('is-open');
    });"""
new2 = """    requestAnimationFrame(() => {
      // 本体原位放大：模糊层在放大磁贴位置挖洞，洞内保持清晰
      const focus = space?.focusScreenPoint?.() ?? null;
      if (focus) {
        tileDetailEl.style.setProperty('--focus-x', `${focus.x.toFixed(1)}px`);
        tileDetailEl.style.setProperty('--focus-y', `${focus.y.toFixed(1)}px`);
        tileDetailEl.style.setProperty('--focus-r', `${focus.radius.toFixed(1)}px`);
      }
      tileDetailEl.classList.add('is-open');
    });"""
if s2.count(old2) != 1:
    raise SystemExit(f'show: {s2.count(old2)}')
s2 = s2.replace(old2, new2, 1)
io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
print('spaceShell: css vars for mask hole')

# 3) space.css：模糊层挖洞（圆形洞比磁贴外接圆略大），隐藏原位放大卡
p3 = r'E:\Zilux2开发\web\src\styles\space.css'
c = io.open(p3, 'r', encoding='utf-8', newline='').read()

old3 = """  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.3s var(--ease),
    -webkit-backdrop-filter 0.3s var(--ease),
    backdrop-filter 0.3s var(--ease);
}"""
new3 = """  opacity: 0;
  pointer-events: none;
  -webkit-mask-image: radial-gradient(
    circle calc(var(--focus-r, 220px) * 1.48) at var(--focus-x, 50%) var(--focus-y, 50%),
    transparent 0,
    transparent calc(var(--focus-r, 220px) * 1.36),
    #000 calc(var(--focus-r, 220px) * 1.48 + 40px)
  );
  mask-image: radial-gradient(
    circle calc(var(--focus-r, 220px) * 1.48) at var(--focus-x, 50%) var(--focus-y, 50%),
    transparent 0,
    transparent calc(var(--focus-r, 220px) * 1.36),
    #000 calc(var(--focus-r, 220px) * 1.48 + 40px)
  );
  transition:
    opacity 0.3s var(--ease),
    -webkit-backdrop-filter 0.3s var(--ease),
    backdrop-filter 0.3s var(--ease);
}"""
if c.count(old3) != 1:
    raise SystemExit(f'mask: {c.count(old3)}')
c = c.replace(old3, new3, 1)

c = c.replace(
    """.tile-focus-card {
  position: absolute;""",
    """.tile-focus-card {
  display: none !important;
  position: absolute;""",
    1,
)
io.open(p3, 'w', encoding='utf-8', newline='').write(c)
print('space.css: mask hole + card hidden')
