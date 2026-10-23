# -*- coding: utf-8 -*-
"""磁贴墙环绕屏弯曲幅度：自定义面板滑块 0-100%，实时生效并持久化。"""
import io

SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'
SHELL = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'


def read(p):
    return io.open(p, 'r', encoding='utf-8', newline='').read()


def write(p, t):
    io.open(p, 'w', encoding='utf-8', newline='').write(t)


# ---------------- floatScene ----------------
s = read(SCENE)
old = "  /** 磁贴随机飘散（true）或飞回原位（false） */\n  setTilesScattered(scattered: boolean): void;"
new = """  /** 磁贴随机飘散（true）或飞回原位（false） */
  setTilesScattered(scattered: boolean): void;
  /** 环绕屏弯曲幅度 0（平面）~1（强环绕） */
  setTileBend(bend: number): void;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "  let tileScatter = 0;\n  let tileScatterTarget = 0;"
new = "  let tileScatter = 0;\n  let tileScatterTarget = 0;\n  let tileBend = 0.35;\n  let tileBendTarget = 0.35;"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "    const scatterEase = tileScatter * tileScatter * (3 - 2 * tileScatter);"
new = "    const scatterEase = tileScatter * tileScatter * (3 - 2 * tileScatter);\n    tileBend += (tileBendTarget - tileBend) * Math.min(1, delta * 5);"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """      tile.group.position.x = slot.x + tile.pushX + jitterX * scatterEase;
      tile.group.position.y =
        slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06 + jitterY * scatterEase;
      tile.group.position.z =
        0.1 + t * 0.26 + sel * 0.22 - focusAmount * 0.45 + jitterZ * scatterEase * 1.8;"""
new = """      // 环绕屏弯曲：按列位置把磁贴包成圆柱面（两侧向观众靠近并转向中心）
      const halfCols = Math.max(1, (tileCols - 1) / 2);
      const columnU = ((tile.index % tileCols) - halfCols) / halfCols;
      const bend = tileBend * layoutScale;
      const bendZ = bend * 2.4 * columnU * columnU;
      const bendX = -bend * 0.09 * columnU * Math.abs(columnU);
      const bendRotY = -columnU * tileBend * 0.55;
      tile.group.position.x = slot.x + tile.pushX + jitterX * scatterEase + bendX;
      tile.group.position.y =
        slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06 + jitterY * scatterEase;
      tile.group.position.z =
        0.1 + t * 0.26 + sel * 0.22 - focusAmount * 0.45 + jitterZ * scatterEase * 1.8 + bendZ;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """      if (flipping) {
        const delay = flipDelays[tile.index] ?? 0;
        const local = Math.min(1, Math.max(0, (flipElapsed - delay) / FLIP_ITEM_MS));
        tile.group.rotation.y = tile.committed ? 0 : local * Math.PI;
      } else if (tile.group.rotation.y !== 0) {
        tile.group.rotation.y = 0;
      }"""
new = """      if (flipping) {
        const delay = flipDelays[tile.index] ?? 0;
        const local = Math.min(1, Math.max(0, (flipElapsed - delay) / FLIP_ITEM_MS));
        tile.group.rotation.y = bendRotY + (tile.committed ? 0 : local * Math.PI);
      } else {
        tile.group.rotation.y = bendRotY;
      }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 命中判定：把弯曲位移也算进投影（不含 hover 位移，避免追捕）
old = """      // 用基础网格位置判定（不跟随 hover 放大/让位位移），避免指针与命中判定互相追逐导致震颤
      const slot = tileSlot(tile.index);
      probe.set(slot.x, slot.y, 0.1).project(camera);"""
new = """      // 用基础网格位置 + 弯曲位移判定（不跟随 hover 放大/让位位移），避免指针与命中判定互相追逐导致震颤
      const slot = tileSlot(tile.index);
      const halfCols = Math.max(1, (tileCols - 1) / 2);
      const columnU = ((tile.index % tileCols) - halfCols) / halfCols;
      const bend = tileBend * layoutScale;
      probe
        .set(
          slot.x - bend * 0.09 * columnU * Math.abs(columnU),
          slot.y,
          0.1 + bend * 2.4 * columnU * columnU,
        )
        .project(camera);"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "    setTilesScattered(scattered: boolean) {"
new = """    setTileBend(bend: number) {
      tileBendTarget = Math.max(0, Math.min(1, bend));
    },
    setTilesScattered(scattered: boolean) {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)
write(SCENE, s)
print('floatScene: cylindrical tile bend')

# ---------------- spaceShell ----------------
s = read(SHELL)
old = "  const DEFAULT_CUSTOM = { image: null as string | null, tilePageSize: 91 };"
new = "  const DEFAULT_CUSTOM = { image: null as string | null, tilePageSize: 91, tileBend: 0.35 };"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """      const tilePageSize = PAGE_SIZE_OPTIONS.includes(
        parsed.tilePageSize as (typeof PAGE_SIZE_OPTIONS)[number],
      )
        ? (parsed.tilePageSize as number)
        : DEFAULT_CUSTOM.tilePageSize;
      return { image, tilePageSize };"""
new = """      const tilePageSize = PAGE_SIZE_OPTIONS.includes(
        parsed.tilePageSize as (typeof PAGE_SIZE_OPTIONS)[number],
      )
        ? (parsed.tilePageSize as number)
        : DEFAULT_CUSTOM.tilePageSize;
      const bendRaw = Number(parsed.tileBend);
      const tileBend = Number.isFinite(bendRaw) ? Math.min(1, Math.max(0, bendRaw)) : DEFAULT_CUSTOM.tileBend;
      return { image, tilePageSize, tileBend };"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """      const parsed = JSON.parse(raw) as { image?: unknown; tilePageSize?: unknown };"""
new = """      const parsed = JSON.parse(raw) as { image?: unknown; tilePageSize?: unknown; tileBend?: unknown };"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  const applyCustom = (): void => {
    space?.setUnderlayImage(custom.image);
  };"""
new = """  const applyCustom = (): void => {
    space?.setUnderlayImage(custom.image);
    space?.setTileBend(custom.tileBend);
  };"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 模板：磁贴数量行之后加弯曲滑块
old = """            <p class="custom-tip">当前这一页铺开的封面数量；数量少磁贴更大，数量多更密集，翻页时按需加载后续歌曲</p>
          </div>
          <div class="custom-row">
            <div class="custom-label"><span>空间背景图</span></div>"""
new = """            <p class="custom-tip">当前这一页铺开的封面数量；数量少磁贴更大，数量多更密集，翻页时按需加载后续歌曲</p>
          </div>
          <div class="custom-row">
            <div class="custom-label"><span>磁贴弯曲幅度</span><b data-bend-current>35%</b></div>
            <input class="custom-slider" data-tile-bend type="range" min="0" max="100" step="1" value="35" aria-label="磁贴弯曲幅度" />
            <p class="custom-tip">让磁贴墙像环绕屏一样弯起来；0% 为平面，越大两侧包裹越强</p>
          </div>
          <div class="custom-row">
            <div class="custom-label"><span>空间背景图</span></div>"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "  const customPreview = root.querySelector<HTMLElement>('[data-custom-preview]')!;"
new = """  const customPreview = root.querySelector<HTMLElement>('[data-custom-preview]')!;
  const customBendInput = root.querySelector<HTMLInputElement>('[data-tile-bend]')!;
  const customBendCurrent = root.querySelector<HTMLElement>('[data-bend-current]')!;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  const syncCustomUi = (): void => {
    customTileCurrent.textContent = String(custom.tilePageSize);"""
new = """  const syncCustomUi = (): void => {
    customTileCurrent.textContent = String(custom.tilePageSize);
    customBendInput.value = String(Math.round(custom.tileBend * 100));
    customBendCurrent.textContent = `${Math.round(custom.tileBend * 100)}%`;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  underlayClear.addEventListener('click', () => {"""
new = """  customBendInput.addEventListener('input', () => {
    custom.tileBend = Math.min(1, Math.max(0, Number(customBendInput.value) / 100));
    space?.setTileBend(custom.tileBend);
    customBendCurrent.textContent = `${Math.round(custom.tileBend * 100)}%`;
    persistCustom();
  });
  underlayClear.addEventListener('click', () => {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)
write(SHELL, s)
print('spaceShell: bend slider')
