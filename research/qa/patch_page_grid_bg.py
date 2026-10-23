# -*- coding: utf-8 -*-
"""修正「每页磁贴数量」语义（24/50/91/144 网格）+ 修复空间背景图（独立层，压过 CSS 渐变、位于 canvas 之下）。"""
import io

SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'
SHELL = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
CSS = r'E:\Zilux2开发\web\src\styles\space.css'

# ========== A. floatScene: 动态网格 ==========
f = io.open(SCENE, 'r', encoding='utf-8', newline='').read()

f = f.replace(
    "  setTilePage(page: number): void;",
    "  setTilePage(page: number): void;\n  setTileGrid(cols: number, rows: number): void;",
    1,
)

old_consts = """  const TILE_COLS = 13;
  const TILE_ROWS = 7;
  const TILE_SIZE = 0.98;
  const TILE_POOL = TILE_COLS * TILE_ROWS;"""
new_consts = """  let tileCols = 13;
  let tileRows = 7;
  const TILE_SIZE = 0.98;
  // 池子按最大页（16×9=144）创建，实际每页数量由 tileCols×tileRows 决定
  const TILE_POOL = 144;"""
assert f.count(old_consts) == 1
f = f.replace(old_consts, new_consts, 1)
f = f.replace('TILE_COLS', 'tileCols').replace('TILE_ROWS', 'tileRows')

old_vis = "      tile.group.visible = tileVisible && Boolean(item);"
new_vis = """      const inPage = tile.index < tileCols * tileRows;
      tile.group.visible = tileVisible && Boolean(item) && inPage;"""
assert f.count(old_vis) == 1
f = f.replace(old_vis, new_vis, 1)

anchor = """    setTilePage(page) {
      const rows = Math.ceil(tileItems.length / tileCols);
      const maxOffset = Math.max(0, rows - tileRows);
      const total = Math.max(1, Math.ceil(rows / tileRows));
      const target = Math.min(total, Math.max(1, Math.floor(page) || 1));
      tileOffsetRows = Math.min(maxOffset, (target - 1) * tileRows);
      refreshTiles();
    },"""
new_anchor = anchor + """
    setTileGrid(cols, rows) {
      tileCols = Math.max(1, Math.floor(cols));
      tileRows = Math.max(1, Math.floor(rows));
      tileOffsetRows = 0;
      refreshTiles();
      resize();
    },"""
assert f.count(anchor) == 1
f = f.replace(anchor, new_anchor, 1)
io.open(SCENE, 'w', encoding='utf-8', newline='').write(f)
print('floatScene: dynamic tile grid')

# ========== B. spaceShell: 背景层 ==========
s = io.open(SHELL, 'r', encoding='utf-8', newline='').read()

old_canvas = """    <canvas class="space-canvas" aria-label="登录空间"></canvas>"""
new_canvas = """    <div class="space-bg" data-space-bg></div>
    <canvas class="space-canvas" aria-label="登录空间"></canvas>"""
assert s.count(old_canvas) == 1
s = s.replace(old_canvas, new_canvas, 1)

old_ref = """  const canvas = root.querySelector<HTMLCanvasElement>('.space-canvas')!;"""
new_ref = """  const canvas = root.querySelector<HTMLCanvasElement>('.space-canvas')!;
  const spaceBg = root.querySelector<HTMLElement>('[data-space-bg]')!;"""
assert s.count(old_ref) == 1
s = s.replace(old_ref, new_ref, 1)

old_bg_handler = """    onBackground: (url) => {
      root.style.setProperty('--space-bg', url ? `url("${url}")` : 'none');
    },"""
new_bg_handler = """    onBackground: (url) => {
      if (url) {
        spaceBg.style.backgroundImage = `url("${url}")`;
        spaceBg.classList.add('has-image');
      } else {
        spaceBg.style.backgroundImage = '';
        spaceBg.classList.remove('has-image');
      }
    },"""
assert s.count(old_bg_handler) == 1
s = s.replace(old_bg_handler, new_bg_handler, 1)

# ========== C. spaceShell: 每页磁贴数量 ==========
old_opts = """  const TILE_COUNT_OPTIONS = [120, 300, 480] as const;
  const DEFAULT_CUSTOM = { image: null as string | null, tileCount: 300 };"""
new_opts = """  const PAGE_SIZE_OPTIONS = [24, 50, 91, 144] as const;
  const PAGE_GRIDS: Record<number, { cols: number; rows: number }> = {
    24: { cols: 6, rows: 4 },
    50: { cols: 10, rows: 5 },
    91: { cols: 13, rows: 7 },
    144: { cols: 16, rows: 9 },
  };
  const DEFAULT_CUSTOM = { image: null as string | null, tilePageSize: 91 };"""
assert s.count(old_opts) == 1
s = s.replace(old_opts, new_opts, 1)

old_parse = """      const parsed = JSON.parse(raw) as { image?: unknown; tileCount?: unknown };
      const image =
        typeof parsed.image === 'string' && parsed.image.startsWith('data:image/') ? parsed.image : null;
      const tileCount = TILE_COUNT_OPTIONS.includes(parsed.tileCount as (typeof TILE_COUNT_OPTIONS)[number])
        ? (parsed.tileCount as number)
        : DEFAULT_CUSTOM.tileCount;
      return { image, tileCount };"""
new_parse = """      const parsed = JSON.parse(raw) as { image?: unknown; tilePageSize?: unknown };
      const image =
        typeof parsed.image === 'string' && parsed.image.startsWith('data:image/') ? parsed.image : null;
      const tilePageSize = PAGE_SIZE_OPTIONS.includes(
        parsed.tilePageSize as (typeof PAGE_SIZE_OPTIONS)[number],
      )
        ? (parsed.tilePageSize as number)
        : DEFAULT_CUSTOM.tilePageSize;
      return { image, tilePageSize };"""
assert s.count(old_parse) == 1
s = s.replace(old_parse, new_parse, 1)

old_sync = """    customTileCurrent.textContent = String(custom.tileCount);
    customTileSeg.querySelectorAll<HTMLButtonElement>('[data-tile-count-option]').forEach((button) => {
      button.classList.toggle(
        'is-on',
        Number(button.dataset.tileCountOption) === custom.tileCount,
      );
    });"""
new_sync = """    customTileCurrent.textContent = String(custom.tilePageSize);
    customTileSeg.querySelectorAll<HTMLButtonElement>('[data-tile-count-option]').forEach((button) => {
      button.classList.toggle(
        'is-on',
        Number(button.dataset.tileCountOption) === custom.tilePageSize,
      );
    });"""
assert s.count(old_sync) == 1
s = s.replace(old_sync, new_sync, 1)

old_click = """    const value = Number(button.dataset.tileCountOption);
    if (!TILE_COUNT_OPTIONS.includes(value as (typeof TILE_COUNT_OPTIONS)[number])) return;
    if (value === custom.tileCount) return;
    custom.tileCount = value;
    persistCustom();
    syncCustomUi();
    if (likedViewOpen) void loadLikedTiles();"""
new_click = """    const value = Number(button.dataset.tileCountOption);
    if (!PAGE_SIZE_OPTIONS.includes(value as (typeof PAGE_SIZE_OPTIONS)[number])) return;
    if (value === custom.tilePageSize) return;
    custom.tilePageSize = value;
    persistCustom();
    syncCustomUi();
    applyTileGrid();
    if (likedViewOpen) void loadLikedTiles();"""
assert s.count(old_click) == 1
s = s.replace(old_click, new_click, 1)

# applyTileGrid 定义（放在 applyCustom 后）
old_apply = """  const applyCustom = (): void => {
    space?.setUnderlayImage(custom.image);
  };"""
new_apply = """  const applyCustom = (): void => {
    space?.setUnderlayImage(custom.image);
  };
  const applyTileGrid = (): void => {
    const grid = PAGE_GRIDS[custom.tilePageSize] ?? PAGE_GRIDS[91];
    space?.setTileGrid(grid.cols, grid.rows);
  };"""
assert s.count(old_apply) == 1
s = s.replace(old_apply, new_apply, 1)

# space 创建后应用网格 + QA 背景图演示
old_start = """  space.start();
  applyCustom();"""
new_start = """  space.start();
  applyCustom();
  applyTileGrid();
  if (params.get('bgdemo') === '1' && space) {
    const demo = document.createElement('canvas');
    demo.width = 960;
    demo.height = 540;
    const demoCtx = demo.getContext('2d');
    if (demoCtx) {
      const grad = demoCtx.createLinearGradient(0, 0, 960, 540);
      grad.addColorStop(0, '#6a5cff');
      grad.addColorStop(0.55, '#2fa8e8');
      grad.addColorStop(1, '#e263a1');
      demoCtx.fillStyle = grad;
      demoCtx.fillRect(0, 0, 960, 540);
      space.setUnderlayImage(demo.toDataURL('image/jpeg', 0.8));
    }
  }"""
assert s.count(old_start) == 1
s = s.replace(old_start, new_start, 1)

# 分批加载量固定 300 首
s = s.replace('const likedTileLimit = (): number => custom.tileCount;', 'const likedTileLimit = (): number => 300;')

# 模板：数量按钮改成每页磁贴数量
old_tpl = """            <div class="custom-label"><span>磁贴数量</span><b data-tile-count-current>300</b></div>
            <div class="custom-seg" data-tile-count>
              <button class="custom-seg-btn is-on" data-tile-count-option="120" type="button">120</button>
              <button class="custom-seg-btn" data-tile-count-option="300" type="button">300</button>
              <button class="custom-seg-btn" data-tile-count-option="480" type="button">480</button>
            </div>
            <p class="custom-tip">一次铺开的封面数量；越多越吃显存，翻页时会按需加载后续批次</p>"""
new_tpl = """            <div class="custom-label"><span>每页磁贴数量</span><b data-tile-count-current>91</b></div>
            <div class="custom-seg" data-tile-count>
              <button class="custom-seg-btn" data-tile-count-option="24" type="button">24</button>
              <button class="custom-seg-btn" data-tile-count-option="50" type="button">50</button>
              <button class="custom-seg-btn is-on" data-tile-count-option="91" type="button">91</button>
              <button class="custom-seg-btn" data-tile-count-option="144" type="button">144</button>
            </div>
            <p class="custom-tip">当前这一页铺开的封面数量；数量少磁贴更大，数量多更密集，翻页时按需加载后续歌曲</p>"""
assert s.count(old_tpl) == 1
s = s.replace(old_tpl, new_tpl, 1)

io.open(SHELL, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell: page tile grid + background layer')

# ========== D. CSS：背景层替换旧规则 ==========
c = io.open(CSS, 'r', encoding='utf-8', newline='').read()
old_css = """/* 自定义背景图（右侧「外观」面板）：作为空间最底层背景，图片压在渐变之上、星尘之下 */
.space-shell {
  background-image: var(--space-bg, none);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}"""
new_css = """/* 自定义背景图（右侧「外观」面板）：独立层压在 CSS 渐变之上、3D canvas 之下 */
.space-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  opacity: 0;
  transition: opacity 0.45s ease;
  pointer-events: none;
}

.space-bg.has-image {
  opacity: 1;
}"""
assert c.count(old_css) == 1
c = c.replace(old_css, new_css, 1)
io.open(CSS, 'w', encoding='utf-8', newline='').write(c)
print('space.css: space-bg layer')
