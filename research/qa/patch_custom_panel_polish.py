# -*- coding: utf-8 -*-
"""自定义外观面板精修：分组、网格实时预览、滑块刻度、背景图卡片、恢复默认。"""
import io

p = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

def rep(old, new, cnt=1):
    global s
    assert s.count(old) == cnt, (s.count(old), old[:60])
    s = s.replace(old, new, cnt)

# ---- 1) 模板重排 ----
old_body = '''        <div class="custom-body">
          <div class="custom-row">
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
          </div>
          <div class="custom-row">
            <div class="custom-label"><span>磁贴弯曲幅度</span><b data-bend-current>35%</b></div>
            <input class="custom-slider" data-tile-bend type="range" min="0" max="100" step="1" value="35" aria-label="磁贴弯曲幅度" />
            <p class="custom-tip">让磁贴墙像环绕屏一样弯起来；0% 为平面，越大两侧包裹越强</p>
          </div>
          <div class="custom-row">
            <div class="custom-label"><span>空间背景图</span></div>
            <div class="custom-image">
              <div class="custom-preview" data-custom-preview><span>未选择图片</span></div>
              <div class="custom-image-actions">
                <label class="custom-btn" for="space-underlay-input">选择图片</label>
                <input id="space-underlay-input" class="custom-file" data-underlay-input type="file" accept="image/png,image/jpeg,image/webp" hidden />
                <button class="custom-btn is-quiet" data-underlay-clear type="button">清除</button>
              </div>
            </div>
            <p class="custom-tip">作为空间背景显示；建议横向图片，会自动压缩到 1600px 内</p>
          </div>
        </div>'''
new_body = '''        <div class="custom-body">
          <section class="custom-section">
            <header class="custom-section-head">
              <span class="custom-kicker">排版</span>
              <div>
                <h3>磁贴网格</h3>
                <p>每页铺开的列数与行数，改完立即生效</p>
              </div>
            </header>
            <div class="custom-grid-pair">
              <div class="custom-field">
                <div class="custom-label"><span>列数</span><b data-cols-current>13</b></div>
                <div class="custom-count">
                  <button class="custom-step" data-cols-step="-1" type="button" aria-label="减少列数">−</button>
                  <input class="custom-input" data-cols-input type="number" min="1" max="64" step="1" value="13" inputmode="numeric" aria-label="磁贴列数" />
                  <button class="custom-step" data-cols-step="1" type="button" aria-label="增加列数">+</button>
                </div>
              </div>
              <div class="custom-field">
                <div class="custom-label"><span>行数</span><b data-rows-current>7</b></div>
                <div class="custom-count">
                  <button class="custom-step" data-rows-step="-1" type="button" aria-label="减少行数">−</button>
                  <input class="custom-input" data-rows-input type="number" min="1" max="64" step="1" value="7" inputmode="numeric" aria-label="磁贴行数" />
                  <button class="custom-step" data-rows-step="1" type="button" aria-label="增加行数">+</button>
                </div>
              </div>
            </div>
            <div class="custom-gridpreview">
              <canvas class="custom-grid-canvas" data-grid-preview width="320" height="132"></canvas>
              <div class="custom-grid-meta">
                <strong><b data-tile-count-current>91</b> 张 / 页</strong>
                <span>实时网格预览</span>
              </div>
            </div>
          </section>
          <section class="custom-section">
            <header class="custom-section-head">
              <span class="custom-kicker">空间</span>
              <div>
                <h3>环绕与背景</h3>
                <p>弯曲幅度和空间背景图</p>
              </div>
            </header>
            <div class="custom-field">
              <div class="custom-label"><span>弯曲幅度</span><b data-bend-current>35%</b></div>
              <input class="custom-slider" data-tile-bend type="range" min="0" max="100" step="1" value="35" aria-label="磁贴弯曲幅度" />
              <div class="custom-scale"><span>平面</span><span>环绕</span></div>
            </div>
            <div class="custom-field">
              <div class="custom-label"><span>空间背景图</span><b class="custom-optional">可选</b></div>
              <div class="custom-image">
                <div class="custom-preview" data-custom-preview><span>未选择图片</span></div>
                <div class="custom-image-actions">
                  <label class="custom-btn" for="space-underlay-input">选择图片</label>
                  <input id="space-underlay-input" class="custom-file" data-underlay-input type="file" accept="image/png,image/jpeg,image/webp" hidden />
                  <button class="custom-btn is-quiet" data-underlay-clear type="button">清除</button>
                </div>
              </div>
              <p class="custom-tip">显示在磁贴后方的空间背景，建议横向图片，自动压到 1600px 内</p>
            </div>
          </section>
          <footer class="custom-foot">
            <button class="custom-btn is-quiet custom-reset" data-custom-reset type="button">恢复默认</button>
            <span class="custom-foot-note">修改自动保存到本机</span>
          </footer>
        </div>'''
rep(old_body, new_body)

# ---- 2) 元素引用 ----
rep("""  const customTileCurrent = root.querySelector<HTMLElement>('[data-tile-count-current]')!;
  const customColsInput = root.querySelector<HTMLInputElement>('[data-cols-input]')!;""",
"""  const customTileCurrent = root.querySelector<HTMLElement>('[data-tile-count-current]')!;
  const customGridCanvas = root.querySelector<HTMLCanvasElement>('[data-grid-preview]')!;
  const customResetBtn = root.querySelector<HTMLButtonElement>('[data-custom-reset]')!;
  const customColsInput = root.querySelector<HTMLInputElement>('[data-cols-input]')!;""")

# ---- 3) 网格预览 + 应用到 applyTileGrid/syncCustomUi ----
rep('''  const tilePageSize = (): number => custom.tileCols * custom.tileRows;
  const applyTileGrid = (): void => {
    space?.setTileGrid(custom.tileCols, custom.tileRows);
    customColsCurrent.textContent = String(custom.tileCols);
    customRowsCurrent.textContent = String(custom.tileRows);
    customColsInput.value = String(custom.tileCols);
    customRowsInput.value = String(custom.tileRows);
    customTileCurrent.textContent = String(tilePageSize());
  };''',
'''  const tilePageSize = (): number => custom.tileCols * custom.tileRows;
  const paintGridPreview = (): void => {
    const ctx = customGridCanvas.getContext('2d');
    if (!ctx) return;
    const W = customGridCanvas.width;
    const H = customGridCanvas.height;
    const padX = 10;
    const padY = 10;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.strokeStyle = 'rgba(106,92,255,0.16)';
    ctx.lineWidth = 1;
    const radius = 14;
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, W - 1, H - 1, radius);
    ctx.fill();
    ctx.stroke();
    const cols = Math.max(1, custom.tileCols);
    const rows = Math.max(1, custom.tileRows);
    const maxCellCols = 40;
    const maxCellRows = 22;
    const shownCols = Math.min(cols, maxCellCols);
    const shownRows = Math.min(rows, maxCellRows);
    const gapX = 2;
    const gapY = 2;
    const cellW = (W - padX * 2 - gapX * (shownCols - 1)) / shownCols;
    const cellH = (H - padY * 2 - gapY * (shownRows - 1)) / shownRows;
    for (let r = 0; r < shownRows; r += 1) {
      for (let c = 0; c < shownCols; c += 1) {
        const x = padX + c * (cellW + gapX);
        const y = padY + r * (cellH + gapY);
        const hue = 236 + ((c + r) % 6) * 8;
        ctx.fillStyle = `hsla(${hue}, 68%, 72%, ${0.42 + ((c * 7 + r * 3) % 5) * 0.06})`;
        ctx.beginPath();
        ctx.roundRect(x, y, Math.max(0.6, cellW), Math.max(0.6, cellH), Math.min(3.2, cellW * 0.18));
        ctx.fill();
      }
    }
    if (cols > shownCols || rows > shownRows) {
      ctx.fillStyle = 'rgba(23,26,33,0.42)';
      ctx.font = '600 11px "Segoe UI", "Microsoft YaHei UI", sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${cols} × ${rows}`, W - padX - 2, H - padY + 1);
    }
  };
  const applyTileGrid = (): void => {
    space?.setTileGrid(custom.tileCols, custom.tileRows);
    customColsCurrent.textContent = String(custom.tileCols);
    customRowsCurrent.textContent = String(custom.tileRows);
    customColsInput.value = String(custom.tileCols);
    customRowsInput.value = String(custom.tileRows);
    customTileCurrent.textContent = String(tilePageSize());
    paintGridPreview();
  };''')

rep('''    customColsCurrent.textContent = String(custom.tileCols);
    customRowsCurrent.textContent = String(custom.tileRows);
    customColsInput.value = String(custom.tileCols);
    customRowsInput.value = String(custom.tileRows);
    customTileCurrent.textContent = String(tilePageSize());
    customBendInput.value''',
'''    customColsCurrent.textContent = String(custom.tileCols);
    customRowsCurrent.textContent = String(custom.tileRows);
    customColsInput.value = String(custom.tileCols);
    customRowsInput.value = String(custom.tileRows);
    customTileCurrent.textContent = String(tilePageSize());
    paintGridPreview();
    customBendInput.value''')

# ---- 4) 恢复默认 ----
rep("  customOpenBtn.addEventListener('click', openCustomSheet);",
'''  customResetBtn.addEventListener('click', () => {
    custom.tileCols = DEFAULT_CUSTOM.tileCols;
    custom.tileRows = DEFAULT_CUSTOM.tileRows;
    custom.tileBend = DEFAULT_CUSTOM.tileBend;
    if (custom.image) {
      custom.image = null;
      applyCustom();
    } else {
      space?.setTileBend(custom.tileBend);
    }
    applyTileGrid();
    syncCustomUi();
    persistCustom();
    showToast('已恢复默认外观', 'ok');
  });
  customOpenBtn.addEventListener('click', openCustomSheet);''')

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ---- 5) CSS 追加 ----
css_path = r'E:\Zilux2开发\web\src\styles\space.css'
css = io.open(css_path, 'r', encoding='utf-8', newline='').read()
css += '''
/* ── 自定义外观面板精修（分组 / 网格预览 / 滑块刻度 / 恢复默认） ── */
.custom-sheet-card {
  width: min(560px, calc(100vw - 48px));
  max-height: min(760px, calc(100vh - 56px));
  overflow: auto;
}
.custom-body {
  display: grid;
  gap: 14px;
}
.custom-section {
  display: grid;
  gap: 12px;
  padding: 16px 18px 18px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.72);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8), 0 10px 26px rgba(28, 36, 66, 0.05);
}
.custom-section-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.custom-kicker {
  flex: none;
  margin-top: 1px;
  padding: 3px 8px;
  border-radius: 8px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: #5b52d6;
  background: rgba(106, 92, 255, 0.11);
}
.custom-section-head h3 {
  margin: 0;
  font-size: 14.5px;
  font-weight: 650;
  color: #1b1f2b;
}
.custom-section-head p {
  margin: 3px 0 0;
  font-size: 11.5px;
  color: #7a8194;
}
.custom-grid-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.custom-field {
  display: grid;
  gap: 8px;
}
.custom-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: #343a4a;
}
.custom-label b {
  font-variant-numeric: tabular-nums;
  font-size: 12.5px;
  font-weight: 650;
  color: #5b52d6;
}
.custom-label .custom-optional {
  font-weight: 500;
  color: #9aa1ad;
}
.custom-count {
  display: grid;
  grid-template-columns: 38px 1fr 38px;
  align-items: center;
  gap: 6px;
  padding: 4px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.66);
  border: 1px solid rgba(255, 255, 255, 0.86);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 6px 16px rgba(28, 36, 66, 0.05);
}
.custom-step {
  height: 34px;
  border: 0;
  border-radius: 10px;
  background: rgba(106, 92, 255, 0.1);
  color: #4d45c4;
  font-size: 17px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  transition: background 0.16s var(--ease), transform 0.16s var(--ease);
}
.custom-step:hover {
  background: rgba(106, 92, 255, 0.18);
}
.custom-step:active {
  transform: scale(0.94);
}
.custom-input {
  width: 100%;
  height: 34px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-size: 15px;
  font-weight: 650;
  color: #1b1f2b;
  outline: none;
  appearance: textfield;
  -moz-appearance: textfield;
}
.custom-input::-webkit-outer-spin-button,
.custom-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.custom-input:focus {
  box-shadow: 0 0 0 2px rgba(106, 92, 255, 0.24);
  border-radius: 10px;
}
.custom-gridpreview {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.42);
  border: 1px solid rgba(255, 255, 255, 0.72);
}
.custom-grid-canvas {
  flex: none;
  width: 208px;
  height: 86px;
  border-radius: 12px;
}
.custom-grid-meta {
  display: grid;
  gap: 4px;
}
.custom-grid-meta strong {
  font-size: 13px;
  font-weight: 650;
  color: #1b1f2b;
  font-variant-numeric: tabular-nums;
}
.custom-grid-meta strong b {
  font-size: 17px;
  color: #5b52d6;
}
.custom-grid-meta span {
  font-size: 11px;
  color: #8a90a0;
}
.custom-scale {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: #9aa1ad;
  padding: 0 2px;
}
.custom-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(106, 92, 255, 0.16), rgba(59, 182, 245, 0.42), rgba(226, 99, 161, 0.4));
  outline: none;
  cursor: pointer;
}
.custom-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid #6a5cff;
  box-shadow: 0 4px 12px rgba(106, 92, 255, 0.32);
  cursor: grab;
}
.custom-slider::-webkit-slider-thumb:active {
  cursor: grabbing;
}
.custom-image {
  display: grid;
  gap: 10px;
}
.custom-preview {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 96px;
  border-radius: 16px;
  border: 1px dashed rgba(106, 92, 255, 0.26);
  background: rgba(255, 255, 255, 0.34);
  background-size: cover;
  background-position: center;
  color: #9aa1ad;
  font-size: 11.5px;
  overflow: hidden;
}
.custom-preview.has-image {
  border-style: solid;
  border-color: rgba(255, 255, 255, 0.9);
}
.custom-image-actions {
  display: flex;
  gap: 8px;
}
.custom-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 14px;
  border-radius: 10px;
  border: 1px solid rgba(106, 92, 255, 0.22);
  background: rgba(106, 92, 255, 0.1);
  color: #4d45c4;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.16s var(--ease), transform 0.16s var(--ease);
}
.custom-btn:hover {
  background: rgba(106, 92, 255, 0.18);
}
.custom-btn:active {
  transform: scale(0.97);
}
.custom-btn.is-quiet {
  border-color: rgba(23, 26, 33, 0.1);
  background: rgba(255, 255, 255, 0.5);
  color: #5d6470;
}
.custom-btn.is-quiet:hover {
  background: rgba(255, 255, 255, 0.78);
}
.custom-tip {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: #8a90a0;
}
.custom-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 4px 4px;
}
.custom-foot-note {
  font-size: 11px;
  color: #9aa1ad;
}
.custom-reset {
  height: 34px;
  padding: 0 16px;
  border-radius: 12px;
}
'''
io.open(css_path, 'w', encoding='utf-8', newline='').write(css)
print('custom panel polish applied')
