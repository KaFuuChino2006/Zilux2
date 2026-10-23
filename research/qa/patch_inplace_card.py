# -*- coding: utf-8 -*-
"""m09444：在原封面位置放大（DOM 原位放大卡），周围模糊；3D 聚焦磁贴隐藏避免重影。"""
import io

# ---------- floatScene.ts：聚焦磁贴淡出（由原位放大卡替代） ----------
p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

old = """      if (isFocusTarget && focusAmount > 0.001) {
        // 原位置放大（不做位移），放大到 1.55 倍左右
        const grow = 1 + focusAmount * 0.55;
        tile.group.scale.setScalar(layoutScale * grow * (0.94 + 0.06 * appear));
        tile.group.position.z += focusAmount * 0.22;"""
new = """      if (isFocusTarget && focusAmount > 0.001) {
        // 原位置放大（不做位移），放大到 1.55 倍左右
        const grow = 1 + focusAmount * 0.55;
        tile.group.scale.setScalar(layoutScale * grow * (0.94 + 0.06 * appear));
        tile.group.position.z += focusAmount * 0.22;
        // 页面会在同一位置叠加清晰的放大卡，3D 本体淡出避免重影
        tile.plane.material.opacity *= 1 - focusAmount;"""
if s.count(old) != 1:
    raise SystemExit(f'grow: {s.count(old)}')
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('floatScene: focused tile fades out')

# ---------- spaceShell.ts：模板加原位放大卡 ----------
p2 = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s2 = io.open(p2, 'r', encoding='utf-8', newline='').read()

old2 = """    <aside class="tile-detail" data-tile-detail hidden>
      <div class="tile-detail-card">
        <div class="tile-detail-cover">
          <img data-tile-cover alt="" />
        </div>
        <div class="tile-detail-body">
          <h3 data-tile-title>—</h3>
          <p data-tile-artist>—</p>
          <p class="tile-detail-meta" data-tile-meta>—</p>
          <p class="tile-detail-tip">再次点击封面播放 · 双击播放 · Esc 关闭</p>
        </div>
      </div>
    </aside>"""
new2 = """    <aside class="tile-detail" data-tile-detail hidden>
      <div class="tile-focus-card" data-tile-focus-card>
        <img data-tile-cover alt="" />
        <div class="tile-focus-info">
          <strong data-tile-title>—</strong>
          <span data-tile-artist>—</span>
          <span class="tile-focus-meta" data-tile-meta>—</span>
        </div>
      </div>
    </aside>"""
if s2.count(old2) != 1:
    raise SystemExit(f'template: {s2.count(old2)}')
s2 = s2.replace(old2, new2, 1)

# 元素引用：追加 focus card
old3 = """  const tileMetaEl = root.querySelector<HTMLElement>('[data-tile-meta]')!;
  let tileDetailHideTimer = 0;"""
new3 = """  const tileMetaEl = root.querySelector<HTMLElement>('[data-tile-meta]')!;
  const tileFocusCard = root.querySelector<HTMLElement>('[data-tile-focus-card]')!;
  let tileDetailHideTimer = 0;"""
if s2.count(old3) != 1:
    raise SystemExit(f'refs: {s2.count(old3)}')
s2 = s2.replace(old3, new3, 1)

# showTileDetail：用原位放大卡代替中央卡（尺寸取 focusScreenPoint）
old4 = """    window.clearTimeout(tileDetailHideTimer);
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
new4 = """    window.clearTimeout(tileDetailHideTimer);
    tileDetailEl.hidden = false;
    requestAnimationFrame(() => {
      // 原位放大：把放大卡直接放在被点封面原来的屏幕位置
      const focus = space?.focusScreenPoint?.() ?? null;
      if (focus) {
        const size = Math.max(200, focus.radius * 2);
        tileFocusCard.style.left = `${(focus.x - size / 2).toFixed(1)}px`;
        tileFocusCard.style.top = `${(focus.y - size / 2).toFixed(1)}px`;
        tileFocusCard.style.width = `${size.toFixed(1)}px`;
      }
      tileDetailEl.classList.add('is-open');
    });
    space.focusTile(index, {"""
if s2.count(old4) != 1:
    raise SystemExit(f'show: {s2.count(old4)}')
s2 = s2.replace(old4, new4, 1)
io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
print('spaceShell: in-place focus card')

# ---------- space.css：去 mask 洞，改原位放大卡样式 ----------
p3 = r'E:\Zilux2开发\web\src\styles\space.css'
c = io.open(p3, 'r', encoding='utf-8', newline='').read()

start = c.index('  -webkit-mask-image: radial-gradient(')
end = c.index('  transition:\n    opacity 0.3s var(--ease),\n    -webkit-backdrop-filter 0.3s var(--ease),\n    backdrop-filter 0.3s var(--ease);\n}')
c = c[:start] + c[end:]

old5 = """.tile-detail-card {
  display: none !important;
  width: min(50vh, 440px);"""
new5 = """.tile-focus-card {
  position: absolute;
  border-radius: 24px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.95);
  box-shadow: 0 30px 90px rgba(30, 38, 72, 0.3);
  opacity: 0;
  transform: scale(0.94);
  transition:
    transform 0.32s cubic-bezier(0.22, 0.61, 0.36, 1),
    opacity 0.24s var(--ease);
}
.tile-detail.is-open .tile-focus-card {
  opacity: 1;
  transform: scale(1);
}
.tile-focus-card img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  display: block;
}
.tile-focus-info {
  display: grid;
  gap: 3px;
  padding: 10px 12px 12px;
  background: rgba(255, 255, 255, 0.92);
}
.tile-focus-info strong {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tile-focus-info span {
  font-size: 12px;
  color: var(--text-dim);
}
.tile-focus-meta {
  opacity: 0.8;
}
.tile-detail-card {
  display: none !important;
  width: min(50vh, 440px);"""
if c.count(old5) != 1:
    raise SystemExit(f'card: {c.count(old5)}')
c = c.replace(old5, new5, 1)
io.open(p3, 'w', encoding='utf-8', newline='').write(c)
print('space.css: in-place card styles')
