# -*- coding: utf-8 -*-
"""歌词颜色「节奏」模式：跟随鼓点真正换色（每个鼓点轮换主色 + 每 8 拍换一组新色相）。"""
from pathlib import Path

P = Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")
t = P.read_text(encoding="utf-8")
n = 0

# A. 抽出三色生成函数
old = """  function regenerateRhythmColors(): void {
    // 色相随机 + 三个相邻色相组成一组柔和色；避免过暗/过灰
    const baseHue = Math.random() * 360;"""
new = """  function rhythmTriple(): [string, string, string] {
    // 色相随机 + 三个相邻色相组成一组柔和色；避免过暗/过灰
    const baseHue = Math.random() * 360;"""
assert t.count(old) == 1
t = t.replace(old, new); n += 1

old = """    rhythmColors = [
      hslToHex(baseHue, sat, light),
      hslToHex(baseHue + spreadA, sat * 0.92, light - 2),
      hslToHex(baseHue - spreadB, sat * 0.86, light + 2),
    ];
  }

  function applyLyricColorSetting(): void {
    const palette =
      custom.lyricColor === 'rhythm' && rhythmColors ? rhythmColors : paletteColors;
    space?.setLyricColorMode(custom.lyricColor, palette);
  }"""
new = """    return [
      hslToHex(baseHue, sat, light),
      hslToHex(baseHue + spreadA, sat * 0.92, light - 2),
      hslToHex(baseHue - spreadB, sat * 0.86, light + 2),
    ];
  }

  function regenerateRhythmColors(): void {
    rhythmColors = rhythmTriple();
  }

  /** 歌词「节奏」模式：每个鼓点把三色轮换一次，每 8 拍换一组全新色相，颜色真的跟着音乐变 */
  function applyRhythmLyricColor(forceNew = false): void {
    if (custom.lyricColor !== 'rhythm') return;
    if (forceNew || !lyricRhythmColors) lyricRhythmColors = rhythmTriple();
    const base = lyricRhythmColors;
    if (!base) return;
    const shift = lyricRhythmStep % 3;
    space?.setLyricColorMode('rhythm', [
      base[shift],
      base[(shift + 1) % 3],
      base[(shift + 2) % 3],
    ]);
  }

  function applyLyricColorSetting(): void {
    if (custom.lyricColor === 'rhythm') {
      applyRhythmLyricColor();
      return;
    }
    space?.setLyricColorMode(custom.lyricColor, paletteColors);
  }"""
assert t.count(old) == 1
t = t.replace(old, new); n += 1

# B. 状态变量
old = "  let rhythmColors: [string, string, string] | null = null;"
new = """  let rhythmColors: [string, string, string] | null = null;
  let lyricRhythmColors: [string, string, string] | null = null;
  let lyricRhythmStep = 0;
  let lyricRhythmBeats = 0;
  let lastLyricRhythmAt = 0;"""
assert t.count(old) == 1
t = t.replace(old, new); n += 1

# C. 鼓点处驱动歌词换色
old = """        // 背景 3D 粒子同步响应鼓点（与「鼓点特效」开关无关）
        space?.pulseBgFx(0.45 + strength * 0.75);"""
new = """        // 背景 3D 粒子同步响应鼓点（与「鼓点特效」开关无关）
        space?.pulseBgFx(0.45 + strength * 0.75);
        // 歌词「节奏」配色：每个鼓点轮换一次颜色，每 8 拍换一组新色相
        if (custom.lyricColor === 'rhythm') {
          lyricRhythmStep += 1;
          lyricRhythmBeats += 1;
          lastLyricRhythmAt = now;
          applyRhythmLyricColor(lyricRhythmBeats % 8 === 0);
        }"""
assert t.count(old) == 1
t = t.replace(old, new); n += 1

# D. 未播放时兜底缓慢换色（不影响背景）
old = """      lastRhythmPaint = now;
      tintVariant += 1;
      regenerateRhythmColors();
      applyBgColorSetting(false);
    }, 1200);"""
new = """      lastRhythmPaint = now;
      tintVariant += 1;
      regenerateRhythmColors();
      applyBgColorSetting(false);
      if (custom.lyricColor === 'rhythm') {
        lastLyricRhythmAt = now;
        lyricRhythmStep += 1;
        applyRhythmLyricColor(true);
      }
    }, 1200);"""
assert t.count(old) == 1
t = t.replace(old, new); n += 1

# E. 切换歌曲：节奏歌词重新取色
old = """  function onTrackColor(track: OnlineTrack | null): void {
    tintVariant = 0;
    if (custom.bgColor === 'rhythm' && !rhythmColors) regenerateRhythmColors();"""
new = """  function onTrackColor(track: OnlineTrack | null): void {
    tintVariant = 0;
    if (custom.bgColor === 'rhythm' && !rhythmColors) regenerateRhythmColors();
    if (custom.lyricColor === 'rhythm') {
      lyricRhythmColors = null;
      lyricRhythmStep = 0;
      lyricRhythmBeats = 0;
      applyRhythmLyricColor(true);
    }"""
assert t.count(old) == 1
t = t.replace(old, new); n += 1

# F. 选中「节奏」时立刻给一组颜色
old = """      if (value === 'flow' || value === 'cover' || value === 'rhythm' || value === 'rainbow') custom.lyricColor = value;
      else custom.lyricColor = 'white';
      syncCustomUi();"""
new = """      if (value === 'flow' || value === 'cover' || value === 'rhythm' || value === 'rainbow') custom.lyricColor = value;
      else custom.lyricColor = 'white';
      if (custom.lyricColor === 'rhythm') {
        lyricRhythmColors = null;
        lyricRhythmStep = 0;
        lyricRhythmBeats = 0;
        applyRhythmLyricColor(true);
      }
      syncCustomUi();"""
assert t.count(old) == 1
t = t.replace(old, new); n += 1

P.write_text(t, encoding="utf-8")
print("OK steps:", n)
