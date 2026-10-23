# -*- coding: utf-8 -*-
"""m09444：模糊层挖洞（mask），让被点封面在原位的 3D 放大清晰可见，周围仍渐变模糊。"""
import io

# ---------- floatScene.ts：暴露聚焦磁贴的屏幕位置/半径 ----------
p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

anchor = """    onView() {
      return () => undefined;
    },
    start,"""
if s.count(anchor) != 1:
    raise SystemExit(f'anchor: {s.count(anchor)}')
new_anchor = """    onView() {
      return () => undefined;
    },
    /** 聚焦磁贴当前在页面上的中心点与半径（px），供页面模糊层挖洞 */
    focusScreenPoint(): { x: number; y: number; radius: number } | null {
      if (focusIndex < 0) return null;
      const tile = tiles[focusIndex];
      if (!tile) return null;
      const rect = canvas.getBoundingClientRect();
      const center = new THREE.Vector3();
      tile.group.getWorldPosition(center);
      const projected = center.clone().project(camera);
      const x = (projected.x * 0.5 + 0.5) * rect.width;
      const y = (-projected.y * 0.5 + 0.5) * rect.height;
      const halfWorld = (TILE_SIZE * layoutScale * 1.55) / 2;
      const edge = center.clone();
      edge.x += halfWorld;
      edge.project(camera);
      const ex = (edge.x * 0.5 + 0.5) * rect.width;
      const radius = Math.max(140, Math.abs(ex - x) * 1.08);
      return { x, y, radius };
    },
    start,"""
s = s.replace(anchor, new_anchor, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('floatScene: focusScreenPoint added')

# ---------- spaceShell.ts：取坐标写入 CSS 变量 ----------
p2 = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s2 = io.open(p2, 'r', encoding='utf-8', newline='').read()

old = """    window.clearTimeout(tileDetailHideTimer);
    tileDetailEl.hidden = false;
    requestAnimationFrame(() => tileDetailEl.classList.add('is-open'));
    space.focusTile(index, {"""
new = """    window.clearTimeout(tileDetailHideTimer);
    tileDetailEl.hidden = false;
    requestAnimationFrame(() => {
      // 模糊层在聚焦磁贴位置挖洞：原位放大的封面清晰，周围保持模糊
      const focus = space?.focusScreenPoint?.() ?? null;
      if (focus) {
        tileDetailEl.style.setProperty('--focus-x', `${focus.x.toFixed(1)}px`);
        tileDetailEl.style.setProperty('--focus-y', `${focus.y.toFixed(1)}px`);
        tileDetailEl.style.setProperty('--focus-r', `${focus.radius.toFixed(1)}px`);
      }
      tileDetailEl.classList.add('is-open');
    });
    space.focusTile(index, {"""
if s2.count(old) != 1:
    raise SystemExit(f'show hook: {s2.count(old)}')
s2 = s2.replace(old, new, 1)
io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
print('spaceShell: css vars set')

# ---------- space.css：mask 挖洞 ----------
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
    circle var(--focus-r, 220px) at var(--focus-x, 50%) var(--focus-y, 50%),
    transparent 0,
    transparent calc(var(--focus-r, 220px) * 0.82),
    #000 calc(var(--focus-r, 220px) * 0.82 + 46px)
  );
  mask-image: radial-gradient(
    circle var(--focus-r, 220px) at var(--focus-x, 50%) var(--focus-y, 50%),
    transparent 0,
    transparent calc(var(--focus-r, 220px) * 0.82),
    #000 calc(var(--focus-r, 220px) * 0.82 + 46px)
  );
  transition:
    opacity 0.3s var(--ease),
    -webkit-backdrop-filter 0.3s var(--ease),
    backdrop-filter 0.3s var(--ease);
}"""
if c.count(old3) != 1:
    raise SystemExit(f'mask: {c.count(old3)}')
c = c.replace(old3, new3, 1)
io.open(p3, 'w', encoding='utf-8', newline='').write(c)
print('space.css: mask hole')
