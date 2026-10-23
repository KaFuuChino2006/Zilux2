# -*- coding: utf-8 -*-
import io

p = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(p, 'r', encoding='utf-8', newline='').read()

old = "  function drawTile(tile: Tile): void {\n    paintTile(tile.canvas, tile.image, tile.title, tile.index);"
new = "  function drawTile(tile: Tile): void {\n    paintTile(tile.canvas, tile.image, tileLabelsHidden ? '' : tile.title, tile.index);"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "  function drawTileBack(tile: Tile): void {\n    paintTile(tile.backCanvas, tile.backImage, tile.backTitle, tile.index);"
new = "  function drawTileBack(tile: Tile): void {\n    paintTile(tile.backCanvas, tile.backImage, tileLabelsHidden ? '' : tile.backTitle, tile.index);"
assert s.count(old) == 1
s = s.replace(old, new, 1)

anchor = "  function drawTile(tile: Tile): void {"
assert s.count(anchor) == 1
s = s.replace(anchor, "  let tileLabelsHidden = false;\n\n" + anchor, 1)

# handle: 在 setTilesVisible 实现附近加
old = "    setTilesVisible(visible: boolean) {"
assert s.count(old) == 1
s = s.replace(old, "    setTileLabelsHidden(hidden: boolean) {\n      if (tileLabelsHidden === hidden) return;\n      tileLabelsHidden = hidden;\n      refreshTiles();\n    },\n\n" + old, 1)

old = "  setTilesVisible(visible: boolean): void;"
if s.count(old) == 1:
    s = s.replace(old, old + "\n\n  setTileLabelsHidden(hidden: boolean): void;", 1)
else:
    # 尝试其它签名
    old2 = "  setTilesVisible?: (visible: boolean) => void;"
    assert s.count(old2) == 1, "no setTilesVisible in interface"
    s = s.replace(old2, old2 + "\n\n  setTileLabelsHidden?: (hidden: boolean) => void;", 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)

p2 = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s2 = io.open(p2, 'r', encoding='utf-8', newline='').read()

# 进入歌词时隐藏磁贴标题文字，退出恢复
anchor2 = "  function enterLyricsView(): void {"
assert s2.count(anchor2) == 1
s2 = s2.replace(anchor2, anchor2 + "\n    space?.setTileLabelsHidden(true);", 1)
assert "space?.setTileLabelsHidden(true);" in s2

# exitLyricsView 内恢复
idx = s2.index("  function exitLyricsView(")
end = s2.index("\n  function ", idx + 10)
seg = s2[idx:end]
assert "setTilesScattered" in seg or True
newseg = seg.replace("space?.setTilesScattered(false);", "space?.setTilesScattered(false);\n    space?.setTileLabelsHidden(false);", 1)
if newseg == seg:
    # 兜底：在函数开头插入恢复
    newseg = seg.replace("  function exitLyricsView(", "  function exitLyricsView(", 1)
    body_start = newseg.index("{") + 1
    newseg = newseg[:body_start] + "\n    space?.setTileLabelsHidden(false);" + newseg[body_start:]
s2 = s2[:idx] + newseg + s2[end:]

io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
print("tile labels hidden in lyrics mode")
