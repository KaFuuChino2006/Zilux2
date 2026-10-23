# -*- coding: utf-8 -*-
"""修复几何遮罩（尤其菱形掠影）在歌词结束后残留：每帧刷新所有歌词平面的 sweep uniform，退出歌词/换歌词时强制清空。"""
import io

path = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(path, "r", encoding="utf-8", newline="").read()

pairs = [
    # 1) 新 helper：所有歌词平面统一下发 sweep 状态
    ("""  function updateLyrics(delta: number): void {
    lyricColorClock += delta;""",
     """  /** 几何遮罩状态统一下发到所有歌词平面；空状态（-1）时任何平面都不会残留遮罩 */
  function applyLyricSweepUniforms(): void {
    for (const line of lyricLines) {
      const uniforms = line.plane.material.uniforms;
      uniforms.uSweep!.value = lyricSweepEnabled ? lyricSweep : -1;
      uniforms.uSweepKind!.value = lyricSweepKind;
      uniforms.uSweepStrength!.value = lyricSweepStrength;
    }
  }

  function updateLyrics(delta: number): void {
    lyricColorClock += delta;"""),

    # 2) 每帧推进后统一下发（在早退之前），歌词关闭时强制结束
    ("""    if (lyricSweep >= 0) {
      lyricSweep += delta / 0.62;
      if (lyricSweep > 1.35) lyricSweep = -1;
    }""",
     """    if (!lyricVisible) lyricSweep = -1;
    if (lyricSweep >= 0) {
      lyricSweep += delta / 0.62;
      if (lyricSweep > 1.35) lyricSweep = -1;
    }
    applyLyricSweepUniforms();"""),

    # 3) 换歌词数据时清空
    ("""    setLyrics(lines: LyricLineData[]) {
      lyricData = lines;
      lyricActive = -1;
      lyricPrev = -1;
      ensureLyricLines();
    },""",
     """    setLyrics(lines: LyricLineData[]) {
      lyricData = lines;
      lyricActive = -1;
      lyricPrev = -1;
      lyricSweep = -1;
      lyricSweepStrength = 0;
      ensureLyricLines();
      applyLyricSweepUniforms();
    },"""),

    # 4) 退出歌词视图时清空
    ("""    setLyricsView(visible: boolean) {
      lyricVisible = visible;
      if (visible) {""",
     """    setLyricsView(visible: boolean) {
      lyricVisible = visible;
      if (!visible) {
        lyricSweep = -1;
        lyricSweepStrength = 0;
        applyLyricSweepUniforms();
      }
      if (visible) {"""),
]

for old, new in pairs:
    assert s.count(old) == 1, "anchor: " + old[:60]
    s = s.replace(old, new, 1)

io.open(path, "w", encoding="utf-8", newline="").write(s)
print("lyric sweep stale fix applied")
