# -*- coding: utf-8 -*-
"""修复翻页卡在最后一屏：page 计算按 maxOffset，边界自动加载下一批。"""
import io

SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'
SHELL = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'

f = io.open(SCENE, 'r', encoding='utf-8', newline='').read()
f = f.replace(
    "  turnPage(direction: number): boolean;",
    "  turnPage(direction: number): boolean;\n  isFlipping(): boolean;",
    1,
)

old_turn_tail = """      tiles.forEach((tile) => {
        tile.flipped = false;
        tile.committed = false;
        tile.backPlane.visible = false;
      });
      return true;
    },
    pageInfo() {"""
new_turn_tail = """      tiles.forEach((tile) => {
        tile.flipped = false;
        tile.committed = false;
        tile.backPlane.visible = false;
      });
      return true;
    },
    isFlipping() {
      return flipping;
    },
    pageInfo() {"""
assert f.count(old_turn_tail) == 1
f = f.replace(old_turn_tail, new_turn_tail, 1)

old_page = """    pageInfo() {
      const rows = Math.ceil(tileItems.length / tileCols);
      const total = Math.max(1, Math.ceil(rows / tileRows));
      const page = Math.min(total, Math.floor(tileOffsetRows / tileRows) + 1);
      return { page, total };
    },"""
new_page = """    pageInfo() {
      const rows = Math.ceil(tileItems.length / tileCols);
      const maxOffset = Math.max(0, rows - tileRows);
      const total = Math.floor(maxOffset / tileRows) + 1;
      const page = Math.min(total, Math.floor(tileOffsetRows / tileRows) + 1);
      return { page, total };
    },"""
assert f.count(old_page) == 1
f = f.replace(old_page, new_page, 1)

old_setpage = """    setTilePage(page) {
      const rows = Math.ceil(tileItems.length / tileCols);
      const maxOffset = Math.max(0, rows - tileRows);
      const total = Math.max(1, Math.ceil(rows / tileRows));
      const target = Math.min(total, Math.max(1, Math.floor(page) || 1));
      tileOffsetRows = Math.min(maxOffset, (target - 1) * tileRows);
      refreshTiles();
    },"""
new_setpage = """    setTilePage(page) {
      const rows = Math.ceil(tileItems.length / tileCols);
      const maxOffset = Math.max(0, rows - tileRows);
      const total = Math.floor(maxOffset / tileRows) + 1;
      const target = Math.min(total, Math.max(1, Math.floor(page) || 1));
      tileOffsetRows = Math.min(maxOffset, (target - 1) * tileRows);
      refreshTiles();
    },"""
assert f.count(old_setpage) == 1
f = f.replace(old_setpage, new_setpage, 1)

io.open(SCENE, 'w', encoding='utf-8', newline='').write(f)
print('floatScene: page boundary fix')

s = io.open(SHELL, 'r', encoding='utf-8', newline='').read()
old = """  function turnTiles(direction: number): void {
    if (!space) return;
    const before = space.pageInfo();
    if (direction > 0 && before.page >= before.total && likedViewOpen) {
      void loadLikedPage(1);
      return;
    }
    if (direction < 0 && before.page <= 1 && likedViewOpen) {
      void loadLikedPage(-1);
      return;
    }
    const ok = space.turnPage(direction);
    if (!ok) return;
    setStatus(likedStatusText());
  }"""
new = """  function turnTiles(direction: number): void {
    if (!space) return;
    // 翻页动画进行中忽略点击（避免连点导致状态错乱）
    if (space.isFlipping()) return;
    const ok = space.turnPage(direction);
    if (!ok) {
      // 已到当前批的边界：向后翻加载下一批，向前翻加载上一批
      if (likedViewOpen) {
        if (direction > 0) {
          void loadLikedPage(1);
          return;
        }
        if (likedOffset > 0) {
          void loadLikedPage(-1);
          return;
        }
      }
      showToast(direction > 0 ? '已经是最后一页' : '已经是第一页', 'info');
      return;
    }
    setStatus(likedStatusText());
  }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)
io.open(SHELL, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell: turnTiles boundary -> load batch')
