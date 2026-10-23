# -*- coding: utf-8 -*-
"""扫光被裁切修复：歌词平面加大 + 遮罩平面边缘羽化 + 形状更宽更柔；并修正 beat 特效 TS 类型。"""
import io

fs = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(fs, "r", encoding="utf-8", newline="").read()

# 1) 歌词平面加大，给扫光留边距（相机拉远补偿文字观感）
old = "        new THREE.PlaneGeometry(3.2, 0.8),"
new = "        new THREE.PlaneGeometry(4.1, 1.02),"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 2) 平面边缘羽化，避免矩形硬边裁切
old2 = "'    sweepMask *= uSweepStrength * (1.0 - unfilled * 0.4);',"
new2 = """'    float edgeFade = smoothstep(0.0, 0.06, vUv.x) * (1.0 - smoothstep(0.94, 1.0, vUv.x));',
            '    edgeFade *= smoothstep(0.0, 0.1, vUv.y) * (1.0 - smoothstep(0.9, 1.0, vUv.y));',
            '    sweepMask *= uSweepStrength * (1.0 - unfilled * 0.4) * edgeFade;',"""
assert s.count(old2) == 1
s = s.replace(old2, new2, 1)

# 3) 形状更宽更柔和（视觉更大）
pairs = [
    ("'      sweepMask = 1.0 - smoothstep(0.015, 0.1, abs(band - center));',",
     "'      sweepMask = 1.0 - smoothstep(0.02, 0.17, abs(band - center));',"),
    ("'      sweepMask = 1.0 - smoothstep(0.02, 0.085, abs(dist - 0.22));',",
     "'      sweepMask = 1.0 - smoothstep(0.03, 0.15, abs(dist - 0.24));',"),
    ("'      sweepMask = 1.0 - smoothstep(0.14, 0.22, diamond);',",
     "'      sweepMask = 1.0 - smoothstep(0.1, 0.3, diamond);',"),
]
for old3, new3 in pairs:
    assert s.count(old3) == 1, old3
    s = s.replace(old3, new3, 1)

# 4) 歌词相机拉远，抵消平面变大
old4 = "const radius = 4.6 * Math.max(0.45, Math.min(1.9, zoom));"
if s.count(old4) == 1:
    s = s.replace(old4, "const radius = 5.2 * Math.max(0.45, Math.min(1.9, zoom));", 1)

io.open(fs, "w", encoding="utf-8", newline="").write(s)
print("sweep size + edge fade patched")

# spaceShell TS 类型修复
ss = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
t = io.open(ss, "r", encoding="utf-8", newline="").read()
t = t.replace(
    "space?.triggerBeatEffect(custom.beatEffect, Math.max(0.45, Math.min(1.6, bass)), pal);",
    "space?.triggerBeatEffect(custom.beatEffect as 'ring' | 'firework', Math.max(0.45, Math.min(1.6, bass)), pal);",
    1,
)
t = t.replace(
    "space?.triggerBeatEffect(custom.beatEffect === 'off' ? 'firework' : custom.beatEffect, 1.1, pal);",
    "space?.triggerBeatEffect(custom.beatEffect === 'off' ? 'firework' : (custom.beatEffect as 'ring' | 'firework'), 1.1, pal);",
    1,
)
io.open(ss, "w", encoding="utf-8", newline="").write(t)
print("shell types fixed")
