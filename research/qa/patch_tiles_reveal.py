# -*- coding: utf-8 -*-
"""磁贴墙换内容（首次加载 / 切换平台 / 重新加载）时，歌曲磁贴逐块淡入浮现，不是瞬间出现。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

old = """  let tileVisible = false;
  let tileAmount = 0;"""
new = """  let tileVisible = false;
  let tileAmount = 0;
  // 每次换内容（setTiles）时从 0 开始计时：磁贴按序号错开逐块淡入，避免整墙瞬间出现
  let tileRevealClock = 0;"""
assert s.count(old) == 1, 'state'
s = s.replace(old, new, 1)

old = """      const appear = tileAmount;"""
new = """      // 错开浮现：序号越靠后越晚出现，整墙像涟漪一样铺开
      const revealProgress = Math.min(1, Math.max(0, (tileRevealClock - tile.index * 0.0042) / 0.42));
      const revealEase = revealProgress * revealProgress * (3 - 2 * revealProgress);
      const appear = tileAmount * revealEase;"""
assert s.count(old) == 1, 'appear'
s = s.replace(old, new, 1)

old = """    tileAmount += (tileTarget - tileAmount) * Math.min(1, delta * 4.6);"""
new = """    tileAmount += (tileTarget - tileAmount) * Math.min(1, delta * 4.6);
    tileRevealClock = Math.min(4, tileRevealClock + delta);"""
assert s.count(old) == 1, 'tileAmount'
s = s.replace(old, new, 1)

old = """    setTiles(list) {
      tileItems = list.slice(0, 20000);"""
new = """    setTiles(list) {
      tileItems = list.slice(0, 20000);
      tileRevealClock = 0;"""
assert s.count(old) == 1, 'setTiles'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('tiles: staggered fade-in reveal on content change')
