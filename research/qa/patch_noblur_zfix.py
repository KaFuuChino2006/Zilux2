# -*- coding: utf-8 -*-
"""m09506：去掉模糊层；放大磁贴前置避免被邻居遮挡；收回更快并彻底复位。"""
import io

# ---------- floatScene.ts ----------
p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 放大磁贴大幅前置（越过邻居），邻居在聚焦时后退
old = """        // 本体原地放大；周围由页面模糊层处理，放大磁贴区域挖洞保持清晰
"""
new = """        // 本体放大并显著前置：避免被周围磁贴遮挡（z 提升到所有邻居之前）
        tile.group.position.z += focusAmount * 1.35;
"""
if s.count(old) != 1:
    raise SystemExit(f'z-front: {s.count(old)}')
s = s.replace(old, new, 1)

# 2) 邻居聚焦时轻微后退
old2 = """      tile.group.position.z = 0.1 + t * 0.26 + sel * 0.22 - focusWeight * 0.85;"""
new2 = """      tile.group.position.z =
        0.1 + t * 0.26 + sel * 0.22 - focusWeight * 0.85 - focusAmount * 0.45;"""
if s.count(old2) != 1:
    raise SystemExit(f'neighbor-back: {s.count(old2)}')
s = s.replace(old2, new2, 1)

# 3) 收回更快
old3 = """    const focusDur = focusTargetT > focusT ? 0.5 : 0.6;"""
new3 = """    const focusDur = focusTargetT > focusT ? 0.42 : 0.34;"""
if s.count(old3) != 1:
    raise SystemExit(f'dur: {s.count(old3)}')
s = s.replace(old3, new3, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('floatScene patched')

# ---------- spaceShell.ts：不再显示模糊层 ----------
p2 = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s2 = io.open(p2, 'r', encoding='utf-8', newline='').read()
old4 = """    window.clearTimeout(tileDetailHideTimer);
    tileDetailEl.hidden = false;
    requestAnimationFrame(() => {
      // 本体原位放大：模糊层在放大磁贴位置挖洞，洞内保持清晰
      const focus = space?.focusScreenPoint?.() ?? null;
      if (focus) {
        tileDetailEl.style.setProperty('--focus-x', `${focus.x.toFixed(1)}px`);
        tileDetailEl.style.setProperty('--focus-y', `${focus.y.toFixed(1)}px`);
        tileDetailEl.style.setProperty('--focus-r', `${focus.radius.toFixed(1)}px`);
      }
      tileDetailEl.classList.add('is-open');
    });
    space.focusTile(index, {"""
new4 = """    // 不再使用页面层模糊/遮罩：只让 3D 磁贴本体展开
    tileDetailEl.hidden = true;
    space.focusTile(index, {"""
if s2.count(old4) != 1:
    raise SystemExit(f'show: {s2.count(old4)}')
s2 = s2.replace(old4, new4, 1)

old5 = """    tileDetailEl.classList.remove('is-open');
    window.clearTimeout(tileDetailHideTimer);
    tileDetailHideTimer = window.setTimeout(() => {
      if (!tileDetailEl.classList.contains('is-open')) tileDetailEl.hidden = true;
    }, 320);
    space?.unfocusTile();"""
new5 = """    window.clearTimeout(tileDetailHideTimer);
    space?.unfocusTile();"""
if s2.count(old5) != 1:
    raise SystemExit(f'hide: {s2.count(old5)}')
s2 = s2.replace(old5, new5, 1)
io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
print('spaceShell patched')

# ---------- space.css：详情层彻底隐藏 ----------
p3 = r'E:\Zilux2开发\web\src\styles\space.css'
c = io.open(p3, 'r', encoding='utf-8', newline='').read()
old6 = """.tile-detail {
  position: fixed;"""
new6 = """.tile-detail {
  display: none !important;
  position: fixed;"""
if c.count(old6) != 1:
    raise SystemExit(f'css: {c.count(old6)}')
c = c.replace(old6, new6, 1)
io.open(p3, 'w', encoding='utf-8', newline='').write(c)
print('space.css patched')
