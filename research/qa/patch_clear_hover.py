# -*- coding: utf-8 -*-
"""播放/退出选择后立即清除 hover 残留，让封面完全回位；鼠标再次移动才恢复 hover。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, label):
    global s
    if s.count(old) != 1:
        raise SystemExit(f'{label}: count={s.count(old)}')
    s = s.replace(old, new, 1)


rep("  unfocusTile(): void;", "  unfocusTile(): void;\n  clearHover(): void;", 'handle iface')
rep("  let hoveredTile = -1;", "  let hoveredTile = -1;\n  let hoverSuppressed = false;", 'hover flag')

# 鼠标真实移动才恢复 hover
rep(
    "  const onPointerMove = (event: PointerEvent): void => {",
    "  const onPointerMove = (event: PointerEvent): void => {\n    hoverSuppressed = false;",
    'pointermove reset',
)

rep(
    """  function updateTiles(delta: number): void {
    let nextHover = tileIndexAtPointer();""",
    """  function updateTiles(delta: number): void {
    let nextHover = hoverSuppressed ? -1 : tileIndexAtPointer();""",
    'updateTiles suppress',
)

# 倒数第二行：unfocusTile 实现后加 clearHover 实现
rep(
    """    unfocusTile() {""",
    """    clearHover() {
      hoverSuppressed = true;
      hoveredTile = -1;
      tiles.forEach((tile) => {
        tile.hoverT = 0;
      });
    },
    unfocusTile() {""",
    'clearHover impl',
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('floatScene clearHover done')

# spaceShell：hideTileDetail 时清除 hover
p2 = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s2 = io.open(p2, 'r', encoding='utf-8', newline='').read()
old = """    detailIndex = -1;
    window.clearTimeout(tileDetailHideTimer);
    space?.unfocusTile();"""
new = """    detailIndex = -1;
    window.clearTimeout(tileDetailHideTimer);
    space?.clearHover();
    space?.unfocusTile();"""
if s2.count(old) != 1:
    raise SystemExit(f'spaceShell hideTileDetail: count={s2.count(old)}')
s2 = s2.replace(old, new, 1)
io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
print('spaceShell clearHover call done')
