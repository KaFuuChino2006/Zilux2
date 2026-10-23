# -*- coding: utf-8 -*-
"""放大聚焦时：点击其他任何位置（其他磁贴/详情卡/空白）都缩小回磁贴墙；只有再次点击当前磁贴才播放。"""
import io

p = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

old = """    onTileClick: (index) => {
      if (index < 0) {
        hideTileDetail();
        return;
      }
      if (!tileTracks[index]) {
        showToast('这首暂时无法播放', 'warn');
        return;
      }
      handleTileClick(index);
    },"""
new = """    onTileClick: (index) => {
      // 空白处 / 详情卡位置：缩小回磁贴墙
      if (index < 0) {
        hideTileDetail();
        return;
      }
      // 放大聚焦状态下点其他位置：先缩小回去
      if (detailIndex >= 0 && index !== detailIndex) {
        hideTileDetail();
        return;
      }
      if (!tileTracks[index]) {
        showToast('这首暂时无法播放', 'warn');
        return;
      }
      handleTileClick(index);
    },"""
assert s.count(old) == 1, 'onTileClick block missing'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('unfocus on other-click done')
