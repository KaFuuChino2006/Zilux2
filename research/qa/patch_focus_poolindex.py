# -*- coding: utf-8 -*-
"""修复翻页后点击封面放大错位：视觉聚焦改用池子索引（poolIndex），数据仍用 itemIndex。"""
import io

SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'
SHELL = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'

f = io.open(SCENE, 'r', encoding='utf-8', newline='').read()
old = "  onTileClick?(index: number): void;"
new = "  onTileClick?(index: number, poolIndex?: number): void;"
assert f.count(old) == 1
f = f.replace(old, new, 1)

old = "      options.onTileClick?.(itemIndex);"
new = "      options.onTileClick?.(itemIndex, hitTile);"
assert f.count(old) == 1
f = f.replace(old, new, 1)

# 磁贴数据数组不占显存（只有池内 144 块纹理），放宽上限以便分批加载到全部歌曲
old = "      tileItems = list.slice(0, 500);"
new = "      tileItems = list.slice(0, 20000);"
assert f.count(old) == 1
f = f.replace(old, new, 1)
io.open(SCENE, 'w', encoding='utf-8', newline='').write(f)
print('floatScene: poolIndex passthrough + tileItems limit')

s = io.open(SHELL, 'r', encoding='utf-8', newline='').read()
old = "    onTileClick: (index) => {"
new = "    onTileClick: (index, poolIndex) => {"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "      handleTileClick(index);"
new = "      handleTileClick(index, poolIndex);"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  function showTileDetail(index: number): void {
    const track = tileTracks[index];
    if (!track || !space) return;
    detailIndex = index;"""
new = """  function showTileDetail(index: number, poolIndex?: number): void {
    const track = tileTracks[index];
    if (!track || !space) return;
    detailIndex = index;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    space.focusTile(index, {
      title: track.title || '未命名',"""
new = """    // 视觉聚焦用池子内下标（0..144），数据仍用全局 itemIndex
    space.focusTile(poolIndex ?? index, {
      title: track.title || '未命名',"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  function handleTileClick(index: number): void {
    const now = performance.now();"""
new = """  function handleTileClick(index: number, poolIndex?: number): void {
    const now = performance.now();"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    if (isDouble || detailIndex === index) {
      const track = tileTracks[index];
      if (track) {
        island.play(track, tileTracks);
        showToast(`正在播放《${track.title}》`, 'ok');
      }
      hideTileDetail();
      return;
    }
    showTileDetail(index);
  }"""
new = """    if (isDouble || detailIndex === index) {
      const track = tileTracks[index];
      if (track) {
        island.play(track, tileTracks);
        showToast(`正在播放《${track.title}》`, 'ok');
      }
      hideTileDetail();
      return;
    }
    showTileDetail(index, poolIndex);
  }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 状态栏标注当前是第几批，避免误以为页数回滚
old = """    const moreText =
      likedTotal > likedLoaded ? ` · 共 ${likedTotal} 首（已加载 ${likedLoaded}）` : ` · 共 ${likedTotal} 首`;
    return `${label} · 我喜欢的音乐${moreText}${pageText} · 拖动旋转 / 滚轮缩放 / 翻页箭头`;"""
new = """    const moreText =
      likedTotal > likedLoaded ? ` · 共 ${likedTotal} 首（已加载 ${likedLoaded}）` : ` · 共 ${likedTotal} 首`;
    const batchNo = Math.floor(likedOffset / Math.max(1, likedTileLimit())) + 1;
    const batchText = likedTotal > likedLoaded ? ` · 第 ${batchNo} 批` : '';
    return `${label} · 我喜欢的音乐${moreText}${batchText}${pageText} · 拖动旋转 / 滚轮缩放 / 翻页箭头`;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)
io.open(SHELL, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell: poolIndex focus + batch label')
