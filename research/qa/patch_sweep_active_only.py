# -*- coding: utf-8 -*-
"""修复：扫光出现在已经消失（淡出后）的旧歌词上。遮罩只作用于当前句。"""
import io

path = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(path, "r", encoding="utf-8", newline="").read()

old = """  /** 几何遮罩状态统一下发到所有歌词平面；空状态（-1）时任何平面都不会残留遮罩 */
  function applyLyricSweepUniforms(): void {
    for (const line of lyricLines) {
      const uniforms = line.plane.material.uniforms;
      uniforms.uSweep!.value = lyricSweepEnabled ? lyricSweep : -1;
      uniforms.uSweepKind!.value = lyricSweepKind;
      uniforms.uSweepStrength!.value = lyricSweepStrength;
    }
  }"""

new = """  /** 几何遮罩状态统一下发：只作用于当前句；旧句/淡出中的句一律关闭，避免“已经消失的歌词还在扫光” */
  function applyLyricSweepUniforms(): void {
    for (const line of lyricLines) {
      const uniforms = line.plane.material.uniforms;
      const isActive = line.index === lyricActive;
      uniforms.uSweep!.value = lyricSweepEnabled && isActive ? lyricSweep : -1;
      uniforms.uSweepKind!.value = lyricSweepKind;
      uniforms.uSweepStrength!.value = lyricSweepStrength;
    }
  }"""

assert s.count(old) == 1
s = s.replace(old, new, 1)

# applyLyricColorUniforms 不再写 sweep（由每帧 applyLyricSweepUniforms 统一控制）
old2 = """    uniforms.uSweep!.value = lyricSweepEnabled ? lyricSweep : -1;
    uniforms.uSweepKind!.value = lyricSweepKind;
    uniforms.uSweepStrength!.value = lyricSweepStrength;
"""
assert s.count(old2) == 1
s = s.replace(old2, "", 1)

io.open(path, "w", encoding="utf-8", newline="").write(s)
print("sweep restricted to active line")
