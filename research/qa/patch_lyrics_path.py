# -*- coding: utf-8 -*-
"""歌词落点改为顺序蜿蜒走廊：下一句就在附近，镜头逐句平滑推进、不晃。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

a = s.index("  function lyricAnchor(index: number, out: THREE.Vector3): THREE.Vector3 {")
b = s.index("\n  function updateLyrics", a)
new_fn = '''  function lyricAnchor(index: number, out: THREE.Vector3): THREE.Vector3 {
    const safe = Math.max(0, index);
    // 顺序蜿蜒走廊：相邻句紧挨着（约 1.2~1.6 单位），镜头逐句平滑推进，不会来回乱晃
    const angle = safe * 0.55;
    const drift = Math.sin(safe * 0.13) * 0.55;
    return out.set(
      Math.cos(angle) * 2.5 + drift,
      Math.sin(angle) * 0.85 + 0.35 + Math.sin(safe * 0.21) * 0.22,
      -safe * 0.17 + Math.sin(angle * 0.6) * 0.9,
    );
  }
'''
s = s[:a] + new_fn + s[b + 1:]

# 镜头跟随稍快一点、摆动更小，避免"晃"
pairs = [
    ("      lyricLookTarget.y += Math.sin(seconds * 0.33) * 0.16;", "      lyricLookTarget.y += Math.sin(seconds * 0.33) * 0.09;"),
    ("lyricCamPos.set(\n        lyricLookTarget.x + Math.sin(yaw) * Math.cos(pitch) * radius + Math.sin(seconds * 0.24) * 0.3,",
     "lyricCamPos.set(\n        lyricLookTarget.x + Math.sin(yaw) * Math.cos(pitch) * radius + Math.sin(seconds * 0.24) * 0.12,"),
    ("      lyricCamSmooth.lerp(lyricCamPos, Math.min(1, delta * 2.0));", "      lyricCamSmooth.lerp(lyricCamPos, Math.min(1, delta * 2.6));"),
    ("      lyricLookSmooth.lerp(lyricLookTarget, Math.min(1, delta * 2.6));", "      lyricLookSmooth.lerp(lyricLookTarget, Math.min(1, delta * 3.2));"),
]
for old, new in pairs:
    assert s.count(old) == 1, old[:50]
    s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('lyric anchors -> sequential winding corridor')
