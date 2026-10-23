# -*- coding: utf-8 -*-
"""磁贴列数/行数改为独立可自定义。"""
import io

p = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

def rep(old, new, cnt=1):
    global s
    assert s.count(old) == cnt, (s.count(old), old[:60])
    s = s.replace(old, new, cnt)

# 1) 模板：每页磁贴数量 → 列数 / 行数
rep('''          <div class="custom-row">
            <div class="custom-label"><span>每页磁贴数量</span><b data-tile-count-current>91</b></div>
            <div class="custom-count">
              <button class="custom-step" data-tile-step="-10" type="button" aria-label="减少">−</button>
              <input class="custom-input" data-tile-count-input type="number" min="1" step="1" value="91" inputmode="numeric" aria-label="每页磁贴数量" />
              <button class="custom-step" data-tile-step="10" type="button" aria-label="增加">+</button>
            </div>
            <p class="custom-tip">数字可自己填（1-1200），自动按 16:9 排成网格；数量越多磁贴越小，翻页时按需加载后续歌曲</p>
          </div>''',
'''          <div class="custom-row">
            <div class="custom-label"><span>磁贴列数</span><b data-cols-current>13</b></div>
            <div class="custom-count">
              <button class="custom-step" data-cols-step="-1" type="button" aria-label="减少列数">−</button>
              <input class="custom-input" data-cols-input type="number" min="1" max="64" step="1" value="13" inputmode="numeric" aria-label="磁贴列数" />
              <button class="custom-step" data-cols-step="1" type="button" aria-label="增加列数">+</button>
            </div>
            <p class="custom-tip">横向排开几列（1-64），列越多磁贴越窄</p>
          </div>
          <div class="custom-row">
            <div class="custom-label"><span>磁贴行数</span><b data-rows-current>7</b></div>
            <div class="custom-count">
              <button class="custom-step" data-rows-step="-1" type="button" aria-label="减少行数">−</button>
              <input class="custom-input" data-rows-input type="number" min="1" max="64" step="1" value="7" inputmode="numeric" aria-label="磁贴行数" />
              <button class="custom-step" data-rows-step="1" type="button" aria-label="增加行数">+</button>
            </div>
            <p class="custom-tip">竖向排开几行（1-64）；每页共 <b data-tile-count-current>91</b> 张，翻页时按需加载后续歌曲</p>
          </div>''')

# 2) 元素引用
rep('''  const customTileInput = root.querySelector<HTMLInputElement>('[data-tile-count-input]')!;
  const customTileCurrent = root.querySelector<HTMLElement>('[data-tile-count-current]')!;''',
'''  const customTileCurrent = root.querySelector<HTMLElement>('[data-tile-count-current]')!;
  const customColsInput = root.querySelector<HTMLInputElement>('[data-cols-input]')!;
  const customRowsInput = root.querySelector<HTMLInputElement>('[data-rows-input]')!;
  const customColsCurrent = root.querySelector<HTMLElement>('[data-cols-current]')!;
  const customRowsCurrent = root.querySelector<HTMLElement>('[data-rows-current]')!;''')

# 3) DEFAULT_CUSTOM + loadCustom
rep("  const DEFAULT_CUSTOM = { image: null as string | null, tilePageSize: 91, tileBend: 0.35 };",
    "  const DEFAULT_CUSTOM = { image: null as string | null, tileCols: 13, tileRows: 7, tileBend: 0.35 };")

rep('''      const parsed = JSON.parse(raw) as { image?: unknown; tilePageSize?: unknown; tileBend?: unknown };
      const image =
        typeof parsed.image === 'string' && parsed.image.startsWith('data:image/') ? parsed.image : null;
      const sizeRaw = Number(parsed.tilePageSize);
      const tilePageSize = Number.isFinite(sizeRaw)
        ? Math.min(TILE_COUNT_MAX, Math.max(TILE_COUNT_MIN, Math.round(sizeRaw)))
        : DEFAULT_CUSTOM.tilePageSize;
      const bendRaw = Number(parsed.tileBend);
      const tileBend = Number.isFinite(bendRaw) ? Math.min(1, Math.max(0, bendRaw)) : DEFAULT_CUSTOM.tileBend;
      return { image, tilePageSize, tileBend };''',
'''      const parsed = JSON.parse(raw) as {
        image?: unknown;
        tileCols?: unknown;
        tileRows?: unknown;
        tilePageSize?: unknown;
        tileBend?: unknown;
      };
      const image =
        typeof parsed.image === 'string' && parsed.image.startsWith('data:image/') ? parsed.image : null;
      const clampCount = (value: unknown, fallback: number): number => {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(TILE_COUNT_MAX, Math.max(TILE_COUNT_MIN, Math.round(n)));
      };
      let tileCols = clampCount(parsed.tileCols, 0);
      let tileRows = clampCount(parsed.tileRows, 0);
      if (!tileCols || !tileRows) {
        // 旧版本只保存「每页磁贴数量」：按 16:9 换算成列/行
        const legacy = clampCount(parsed.tilePageSize, DEFAULT_CUSTOM.tileCols * DEFAULT_CUSTOM.tileRows);
        const grid = gridForCount(legacy);
        tileCols = grid.cols;
        tileRows = grid.rows;
      }
      const bendRaw = Number(parsed.tileBend);
      const tileBend = Number.isFinite(bendRaw) ? Math.min(1, Math.max(0, bendRaw)) : DEFAULT_CUSTOM.tileBend;
      return { image, tileCols, tileRows, tileBend };''')

# 4) applyTileGrid / 输入处理 / syncCustomUi
rep('''  const applyTileGrid = (): void => {
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
  };
  const syncCustomUi = (): void => {
    customTileCurrent.textContent = String(custom.tilePageSize);
    customTileInput.value = String(custom.tilePageSize);''',
'''  const tilePageSize = (): number => custom.tileCols * custom.tileRows;
  const applyTileGrid = (): void => {
    space?.setTileGrid(custom.tileCols, custom.tileRows);
    customColsCurrent.textContent = String(custom.tileCols);
    customRowsCurrent.textContent = String(custom.tileRows);
    customColsInput.value = String(custom.tileCols);
    customRowsInput.value = String(custom.tileRows);
    customTileCurrent.textContent = String(tilePageSize());
  };
  const applyTileGridInput = (): void => {
    const colsRaw = Number(customColsInput.value);
    const rowsRaw = Number(customRowsInput.value);
    const cols = Number.isFinite(colsRaw)
      ? Math.min(TILE_COUNT_MAX, Math.max(TILE_COUNT_MIN, Math.round(colsRaw)))
      : custom.tileCols;
    const rows = Number.isFinite(rowsRaw)
      ? Math.min(TILE_COUNT_MAX, Math.max(TILE_COUNT_MIN, Math.round(rowsRaw)))
      : custom.tileRows;
    const changed = cols !== custom.tileCols || rows !== custom.tileRows;
    custom.tileCols = cols;
    custom.tileRows = rows;
    applyTileGrid();
    if (!changed) return;
    persistCustom();
    if (likedViewOpen) void loadLikedTiles();
  };
  const syncCustomUi = (): void => {
    customColsCurrent.textContent = String(custom.tileCols);
    customRowsCurrent.textContent = String(custom.tileRows);
    customColsInput.value = String(custom.tileCols);
    customRowsInput.value = String(custom.tileRows);
    customTileCurrent.textContent = String(tilePageSize());''')

# 5) 事件绑定
rep('''  customTileInput.addEventListener('change', applyTileCountInput);
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
  });''',
'''  [customColsInput, customRowsInput].forEach((input) => {
    input.addEventListener('change', applyTileGridInput);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-cols-step], [data-rows-step]').forEach((button) => {
    button.addEventListener('click', () => {
      const isCols = button.dataset.colsStep !== undefined;
      const delta = Number((isCols ? button.dataset.colsStep : button.dataset.rowsStep) ?? '0');
      const input = isCols ? customColsInput : customRowsInput;
      const next = Number(input.value || 0) + delta;
      input.value = String(next);
      applyTileGridInput();
    });
  });''')

# 6) liked 分页改用列×行
rep("    return Math.max(1, Math.ceil(likedTotal / custom.tilePageSize));",
    "    return Math.max(1, Math.ceil(likedTotal / tilePageSize()));")
rep('''    const offset = (page - 1) * custom.tilePageSize;
    const detail = await fetchPlaylist(source, 'liked', offset, custom.tilePageSize, 'liked');''',
'''    const offset = (page - 1) * tilePageSize();
    const detail = await fetchPlaylist(source, 'liked', offset, tilePageSize(), 'liked');''')
rep("    const tracks = detail.tracks.slice(0, custom.tilePageSize);",
    "    const tracks = detail.tracks.slice(0, tilePageSize());")

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('tile cols/rows customizable (migrates legacy tilePageSize)')
