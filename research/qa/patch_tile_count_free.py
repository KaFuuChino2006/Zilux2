# -*- coding: utf-8 -*-
"""磁贴数量全自定义：数字输入（1-1200），自动按 16:9 排网格；动态磁贴池。"""
import io

SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'
SHELL = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'


def read(p):
    return io.open(p, 'r', encoding='utf-8', newline='').read()


def write(p, t):
    io.open(p, 'w', encoding='utf-8', newline='').write(t)


# ---------------- floatScene：动态池 ----------------
s = read(SCENE)
old = """  const TILE_SIZE = 0.98;
  // 池子按最大页（16×9=144）创建，实际每页数量由 tileCols×tileRows 决定
  const TILE_POOL = 144;"""
new = """  const TILE_SIZE = 0.98;
  // 磁贴池按当前网格动态创建，行列与数量都可任意自定义
  let tilePool = 0;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  for (let i = 0; i < TILE_POOL; i += 1) {
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = 256;
    tileCanvas.height = 256;"""
new = """  function disposeTilePool(): void {
    tiles.forEach((tile) => {
      scene.remove(tile.group);
      tile.texture.dispose();
      tile.plane.geometry.dispose();
      (tile.plane.material as THREE.Material).dispose();
      tile.hit.geometry.dispose();
      (tile.hit.material as THREE.Material).dispose();
      tile.backTexture.dispose();
      tile.backPlane.geometry.dispose();
      (tile.backPlane.material as THREE.Material).dispose();
    });
    tiles.length = 0;
  }

  function buildTilePool(count: number): void {
    disposeTilePool();
    tilePool = Math.max(1, count);
    // 数量越多单张纹理越小，控制显存占用
    const texSize = tilePool > 700 ? 176 : tilePool > 420 ? 208 : 256;
    hoveredTile = -1;
    selectedTile = -1;
    focusIndex = -1;
    pendingRestoreIndex = -1;
    forcedHoverTile = -1;
    for (let i = 0; i < tilePool; i += 1) {
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = texSize;
    tileCanvas.height = texSize;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    const backCanvas = document.createElement('canvas');
    backCanvas.width = 256;
    backCanvas.height = 256;"""
new = """    const backCanvas = document.createElement('canvas');
    backCanvas.width = texSize;
    backCanvas.height = texSize;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    drawTile(tile);
    tiles.push(tile);
  }

  /* 详情磁贴"""
new = """    drawTile(tile);
    tiles.push(tile);
    }
  }

  buildTilePool(tileCols * tileRows);

  /* 详情磁贴"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    setTileGrid(cols, rows) {
      tileCols = Math.max(1, Math.floor(cols));
      tileRows = Math.max(1, Math.floor(rows));
      tileOffsetRows = 0;
      refreshTiles();
      resize();
    },"""
new = """    setTileGrid(cols, rows) {
      tileCols = Math.max(1, Math.floor(cols));
      tileRows = Math.max(1, Math.floor(rows));
      const wanted = tileCols * tileRows;
      if (wanted !== tilePool) buildTilePool(wanted);
      tileOffsetRows = 0;
      refreshTiles();
      resize();
    },"""
assert s.count(old) == 1
s = s.replace(old, new, 1)
write(SCENE, s)
print('floatScene: dynamic tile pool')

# ---------------- spaceShell：数字输入 ----------------
s = read(SHELL)
old = """          <div class="custom-row">
            <div class="custom-label"><span>每页磁贴数量</span><b data-tile-count-current>91</b></div>
            <div class="custom-seg" data-tile-count>
              <button class="custom-seg-btn" data-tile-count-option="24" type="button">24</button>
              <button class="custom-seg-btn" data-tile-count-option="50" type="button">50</button>
              <button class="custom-seg-btn is-on" data-tile-count-option="91" type="button">91</button>
              <button class="custom-seg-btn" data-tile-count-option="144" type="button">144</button>
            </div>
            <p class="custom-tip">当前这一页铺开的封面数量；数量少磁贴更大，数量多更密集，翻页时按需加载后续歌曲</p>
          </div>"""
new = """          <div class="custom-row">
            <div class="custom-label"><span>每页磁贴数量</span><b data-tile-count-current>91</b></div>
            <div class="custom-count">
              <button class="custom-step" data-tile-step="-10" type="button" aria-label="减少">−</button>
              <input class="custom-input" data-tile-count-input type="number" min="1" step="1" value="91" inputmode="numeric" aria-label="每页磁贴数量" />
              <button class="custom-step" data-tile-step="10" type="button" aria-label="增加">+</button>
            </div>
            <p class="custom-tip">数字可自己填（1-1200），自动按 16:9 排成网格；数量越多磁贴越小，翻页时按需加载后续歌曲</p>
          </div>"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "  const PAGE_SIZE_OPTIONS = [24, 50, 91, 144] as const;"
new = "  const TILE_COUNT_MIN = 1;\n  const TILE_COUNT_MAX = 1200;"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  const customTileSeg = root.querySelector<HTMLElement>('[data-tile-count]')!;"""
new = """  const customTileInput = root.querySelector<HTMLInputElement>('[data-tile-count-input]')!;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """      const tilePageSize = PAGE_SIZE_OPTIONS.includes(
        parsed.tilePageSize as (typeof PAGE_SIZE_OPTIONS)[number],
      )
        ? (parsed.tilePageSize as number)
        : DEFAULT_CUSTOM.tilePageSize;"""
new = """      const sizeRaw = Number(parsed.tilePageSize);
      const tilePageSize = Number.isFinite(sizeRaw)
        ? Math.min(TILE_COUNT_MAX, Math.max(TILE_COUNT_MIN, Math.round(sizeRaw)))
        : DEFAULT_CUSTOM.tilePageSize;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  const applyTileGrid = (): void => {
    const grid = PAGE_GRIDS[custom.tilePageSize] ?? PAGE_GRIDS[91];
    space?.setTileGrid(grid.cols, grid.rows);
  };"""
new = """  const gridForCount = (count: number): { cols: number; rows: number } => {
    // 按 16:9 视口密度自动排布：列数 ≈ sqrt(count × 16/9)，行数向上取整
    const cols = Math.max(1, Math.round(Math.sqrt(count * (16 / 9))));
    const rows = Math.max(1, Math.ceil(count / cols));
    return { cols, rows };
  };
  const applyTileGrid = (): void => {
    const grid = gridForCount(custom.tilePageSize);
    space?.setTileGrid(grid.cols, grid.rows);
    customTileCurrent.textContent = String(custom.tilePageSize);
    customTileInput.value = String(custom.tilePageSize);
  };
  const applyTileCountInput = (): void => {
    const raw = Number(customTileInput.value);
    if (!Number.isFinite(raw)) {
      customTileInput.value = String(custom.tilePageSize);
      return;
    }
    const count = Math.min(TILE_COUNT_MAX, Math.max(TILE_COUNT_MIN, Math.round(raw)));
    customTileInput.value = String(count);
    if (count === custom.tilePageSize) {
      applyTileGrid();
      return;
    }
    custom.tilePageSize = count;
    persistCustom();
    applyTileGrid();
    if (likedViewOpen) void loadLikedTiles();
  };"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  const syncCustomUi = (): void => {
    customTileCurrent.textContent = String(custom.tilePageSize);
    customBendInput.value = String(Math.round(custom.tileBend * 100));"""
new = """  const syncCustomUi = (): void => {
    customTileCurrent.textContent = String(custom.tilePageSize);
    customTileInput.value = String(custom.tilePageSize);
    customBendInput.value = String(Math.round(custom.tileBend * 100));"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    customTileSeg.querySelectorAll<HTMLButtonElement>('[data-tile-count-option]').forEach((button) => {
      button.classList.toggle(
        'is-on',
        Number(button.dataset.tileCountOption) === custom.tilePageSize,
      );
    });
"""
assert s.count(old) == 1
s = s.replace(old, "", 1)

old = """  customTileSeg.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tile-count-option]');
    if (!button) return;
    const value = Number(button.dataset.tileCountOption);
    if (!PAGE_SIZE_OPTIONS.includes(value as (typeof PAGE_SIZE_OPTIONS)[number])) return;
    if (value === custom.tilePageSize) return;
    custom.tilePageSize = value;
    persistCustom();
    syncCustomUi();
    applyTileGrid();
    if (likedViewOpen) void loadLikedTiles();
  });"""
new = """  customTileInput.addEventListener('change', applyTileCountInput);
  customTileInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      customTileInput.blur();
    }
  });
  root.querySelectorAll<HTMLButtonElement>('[data-tile-step]').forEach((button) => {
    button.addEventListener('click', () => {
      const delta = Number(button.dataset.tileStep ?? '0');
      const next = Number(customTileInput.value || 0) + delta;
      customTileInput.value = String(next);
      applyTileCountInput();
    });
  });"""
assert s.count(old) == 1
s = s.replace(old, new, 1)
write(SHELL, s)
print('spaceShell: free tile count input')
