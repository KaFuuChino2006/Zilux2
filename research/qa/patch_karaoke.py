import io
from pathlib import Path

p = Path(r"E:\Zilux2开发\web\src\three\floatScene.ts")
raw = io.open(p, "r", encoding="utf-8", newline="").read()
text = raw.replace("\r\n", "\n")

# 1) 默认改为「已唱高亮、未唱变暗」（而不是把未唱的字完全隐藏）
old = "  let wordAppear: 'off' | 'fade' = 'fade';"
assert text.count(old) == 1
text = text.replace(old, "  // 默认「K 歌模式」：整句先暗着显示，唱到哪个字哪个字亮起（空口时停住）\n  let wordAppear: 'off' | 'fade' = 'off';")

# 2) shader: 捕获 uCharWrite，并按写入进度给亮度 + 当前字高亮
old = """            '  float charAlpha = 1.0;',
            '  float written = 1.0;',"""
new = """            '  float charAlpha = 1.0;',
            '  float written = 1.0;',
            '  float charWrite = 0.0;',"""
assert text.count(old) == 1
text = text.replace(old, new)

old = """            '      charAlpha = uCharAlpha[i];',
            '      if (uWrite > 0.5) {',"""
new = """            '      charAlpha = uCharAlpha[i];',
            '      charWrite = uCharWrite[i];',
            '      if (uWrite > 0.5) {',"""
assert text.count(old) == 1
text = text.replace(old, new)

old = """            '  float alpha = tex.a * mix(1.0, 0.34, unfilled) * uOpacity * charAlpha * written;',"""
new = """            '  float writeRamp = clamp(charWrite * 2.4, 0.0, 1.0);',
            '  written *= mix(0.5, 1.0, writeRamp);',
            '  float alpha = tex.a * mix(1.0, 0.34, unfilled) * uOpacity * charAlpha * written;',"""
assert text.count(old) == 1
text = text.replace(old, new)

old = """            '  vec3 color = mix(baseColor, unfilledColor, unfilled);',"""
new = """            '  vec3 color = mix(baseColor, unfilledColor, unfilled);',
            '  // 正在唱/刚唱到的那个字：暖白高亮并带一点光晕，逐字移动，空口时停住不动',
            '  float hot = smoothstep(0.02, 0.2, charWrite) * (1.0 - smoothstep(0.55, 0.95, charWrite));',
            '  vec3 hotColor = mix(baseColor, vec3(1.0, 0.93, 0.74), 0.72);',
            '  color = mix(color, hotColor, clamp(hot, 0.0, 1.0) * 0.92);',
            '  alpha = clamp(alpha + hot * 0.16, 0.0, 1.0);',"""
assert text.count(old) == 1
text = text.replace(old, new)

io.open(p, "w", encoding="utf-8", newline="").write(text.replace("\n", "\r\n") if "\r\n" in raw else text)
print("OK karaoke")
