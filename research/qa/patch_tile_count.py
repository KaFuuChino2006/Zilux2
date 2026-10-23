# -*- coding: utf-8 -*-
"""自定义外观面板：新增「磁贴数量」选项（120 / 300 / 480），本机持久化并即时生效。"""
import io

SHELL = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
CSS = r'E:\Zilux2开发\web\src\styles\space.css'
SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'

# ---------- floatScene: 磁贴上限放宽到 500 ----------
f = io.open(SCENE, 'r', encoding='utf-8', newline='').read()
old = 'tileItems = list.slice(0, 300);'
if f.count(old) == 1:
    f = f.replace(old, 'tileItems = list.slice(0, 500);', 1)
    io.open(SCENE, 'w', encoding='utf-8', newline='').write(f)
    print('floatScene: tile cap 500')
else:
    print('floatScene: tile cap pattern not found (skip)')

# ---------- spaceShell ----------
s = io.open(SHELL, 'r', encoding='utf-8', newline='').read()

# 1) 模板：在「空间背景图」行前插入「磁贴数量」
anchor = """        <div class="custom-body">
          <div class="custom-row">
            <div class="custom-label"><span>空间背景图</span></div>"""
new_block = """        <div class="custom-body">
          <div class="custom-row">
            <div class="custom-label"><span>磁贴数量</span><b data-tile-count-current>300</b></div>
            <div class="custom-seg" data-tile-count>
              <button class="custom-seg-btn is-on" data-tile-count-option="120" type="button">120</button>
              <button class="custom-seg-btn" data-tile-count-option="300" type="button">300</button>
              <button class="custom-seg-btn" data-tile-count-option="480" type="button">480</button>
            </div>
            <p class="custom-tip">一次铺开的封面数量；越多越吃显存，翻页时会按需加载后续批次</p>
          </div>
          <div class="custom-row">
            <div class="custom-label"><span>空间背景图</span></div>"""
assert s.count(anchor) == 1
s = s.replace(anchor, new_block, 1)

# 2) 元素引用
old_ref = """  const customSheet = root.querySelector<HTMLElement>('[data-custom-sheet]')!;"""
new_ref = """  const customSheet = root.querySelector<HTMLElement>('[data-custom-sheet]')!;
  const customTileSeg = root.querySelector<HTMLElement>('[data-tile-count]')!;
  const customTileCurrent = root.querySelector<HTMLElement>('[data-tile-count-current]')!;"""
assert s.count(old_ref) == 1
s = s.replace(old_ref, new_ref, 1)

# 3) custom 结构 + 默认值 + 校验
old_default = """  const DEFAULT_CUSTOM = { image: null as string | null };"""
new_default = """  const TILE_COUNT_OPTIONS = [120, 300, 480] as const;
  const DEFAULT_CUSTOM = { image: null as string | null, tileCount: 300 };"""
assert s.count(old_default) == 1
s = s.replace(old_default, new_default, 1)

old_parse = """      const parsed = JSON.parse(raw) as { image?: unknown };
      const image =
        typeof parsed.image === 'string' && parsed.image.startsWith('data:image/') ? parsed.image : null;
      return { image };"""
new_parse = """      const parsed = JSON.parse(raw) as { image?: unknown; tileCount?: unknown };
      const image =
        typeof parsed.image === 'string' && parsed.image.startsWith('data:image/') ? parsed.image : null;
      const tileCount = TILE_COUNT_OPTIONS.includes(parsed.tileCount as (typeof TILE_COUNT_OPTIONS)[number])
        ? (parsed.tileCount as number)
        : DEFAULT_CUSTOM.tileCount;
      return { image, tileCount };"""
assert s.count(old_parse) == 1
s = s.replace(old_parse, new_parse, 1)

# 4) syncCustomUi 同步分段按钮
old_sync = """  const syncCustomUi = (): void => {
    if (custom.image) {"""
new_sync = """  const syncCustomUi = (): void => {
    customTileCurrent.textContent = String(custom.tileCount);
    customTileSeg.querySelectorAll<HTMLButtonElement>('[data-tile-count-option]').forEach((button) => {
      button.classList.toggle(
        'is-on',
        Number(button.dataset.tileCountOption) === custom.tileCount,
      );
    });
    if (custom.image) {"""
assert s.count(old_sync) == 1
s = s.replace(old_sync, new_sync, 1)

# 5) 数量切换事件（放在自定义面板 close 监听之后）
old_close = """  customOpenBtn.addEventListener('click', openCustomSheet);
  customSheet.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('[data-custom-close]')) closeCustomSheet();
  });"""
new_close = """  customOpenBtn.addEventListener('click', openCustomSheet);
  customSheet.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('[data-custom-close]')) closeCustomSheet();
  });
  customTileSeg.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tile-count-option]');
    if (!button) return;
    const value = Number(button.dataset.tileCountOption);
    if (!TILE_COUNT_OPTIONS.includes(value as (typeof TILE_COUNT_OPTIONS)[number])) return;
    if (value === custom.tileCount) return;
    custom.tileCount = value;
    persistCustom();
    syncCustomUi();
    if (likedViewOpen) void loadLikedTiles();
  });"""
assert s.count(old_close) == 1
s = s.replace(old_close, new_close, 1)

# 6) LIKED_TILE_LIMIT -> 动态 custom.tileCount
old_limit = """  const LIKED_TILE_LIMIT = 300;"""
new_limit = """  const likedTileLimit = (): number => custom.tileCount;"""
assert s.count(old_limit) == 1
s = s.replace(old_limit, new_limit, 1)
s = s.replace('LIKED_TILE_LIMIT', 'likedTileLimit()')

io.open(SHELL, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell: tile count option')

# ---------- CSS: 分段按钮 ----------
c = io.open(CSS, 'r', encoding='utf-8', newline='').read()
if '.custom-seg {' not in c:
    c += """
/* 自定义面板 · 分段选择（磁贴数量） */
.custom-seg {
  display: flex;
  gap: 8px;
}

.custom-seg-btn {
  flex: 1;
  height: 38px;
  border: 0;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.62);
  box-shadow: inset 0 0 0 1px rgba(120, 134, 168, 0.16);
  color: var(--text-soft);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.18s ease, color 0.18s ease, box-shadow 0.18s ease;
}

.custom-seg-btn:hover {
  background: rgba(255, 255, 255, 0.86);
  color: var(--text);
}

.custom-seg-btn.is-on {
  background: linear-gradient(135deg, #6a5cff, #3bb6f5);
  color: #fff;
  box-shadow: 0 8px 18px rgba(88, 96, 214, 0.28);
}
"""
    io.open(CSS, 'w', encoding='utf-8', newline='').write(c)
    print('space.css: custom seg')
else:
    print('space.css: custom-seg already present')
