# -*- coding: utf-8 -*-
"""修复翻页后空窗：未提交(committed)前按角度旋转；提交瞬间同帧复位角度并换正面，
updateTiles 不再把已提交磁贴的角度改回 180°。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, label):
    global s
    if s.count(old) != 1:
        raise SystemExit(f'{label}: count={s.count(old)}')
    s = s.replace(old, new, 1)


# 1) 提交时机：从 0.98 改为 1（翻到 180° 的同一帧完成接替）
rep(
    """        if (local >= 0.98 && !tile.committed) {
          // 翻到 180°：背面朝前，把同样内容画到正面并瞬间复位角度（视觉无跳变）
          tile.committed = true;
          tile.title = tile.backTitle;
          tile.image = tile.backImage;
          drawTile(tile);
          tile.group.rotation.y = 0;
          tile.backPlane.visible = false;
        }""",
    """        if (local >= 1 && !tile.committed) {
          // 翻到 180°：背面朝前，同一帧把同样内容画到正面并复位角度（不留空窗）
          tile.committed = true;
          tile.title = tile.backTitle;
          tile.image = tile.backImage;
          drawTile(tile);
          tile.group.rotation.y = 0;
          tile.backPlane.visible = false;
        }""",
    'commit timing',
)

# 2) updateTiles 角度：已提交的磁贴保持 0°，避免被重新转回 180° 导致背面剔除而消失
rep(
    """      if (flipping) {
        const delay = flipDelays[tile.index] ?? 0;
        const local = Math.min(1, Math.max(0, (flipElapsed - delay) / FLIP_ITEM_MS));
        tile.group.rotation.y = local * Math.PI;
      } else if (tile.group.rotation.y !== 0) {
        tile.group.rotation.y = 0;
      }""",
    """      if (flipping) {
        const delay = flipDelays[tile.index] ?? 0;
        const local = Math.min(1, Math.max(0, (flipElapsed - delay) / FLIP_ITEM_MS));
        tile.group.rotation.y = tile.committed ? 0 : local * Math.PI;
      } else if (tile.group.rotation.y !== 0) {
        tile.group.rotation.y = 0;
      }""",
    'rotation guard',
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('flip gap fixed')
