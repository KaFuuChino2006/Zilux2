# -*- coding: utf-8 -*-
"""歌词辉光重做：更平滑的多环采样 + 随整句淡出、不再残影"""
from pathlib import Path

FS = Path(r"E:\Zilux2开发\web\src\three\floatScene.ts")
CRLF = "\r\n"


def read(p: Path) -> str:
    with p.open(encoding="utf-8", newline="") as f:
        return f.read()


def write(p: Path, s: str) -> None:
    with p.open("w", encoding="utf-8", newline="") as f:
        f.write(s)


def rep(text: str, old: str, new: str, tag: str, count: int = 1) -> str:
    assert text.count(old) == count, f"{tag}: expect {count}, got {text.count(old)}"
    return text.replace(old, new)


fs = read(FS)

# 1) 辉光采样：三圈共 18 个采样点，按距离加权（高斯近似），横向按画布宽高比校正
old_sample = CRLF.join(
    [
        "            '  // 辉光：在字形四周采样一圈 alpha，形成可调的柔光晕',",
        "            '  float halo = 0.0;',",
        "            '  if (uGlow > 0.002) {',",
        "            '    vec2 gr = vec2(0.014, 0.055) * uGlow;',",
        "            '    float gs = 0.0;',",
        "            '    gs += texture2D(uMap, guv + vec2(gr.x, 0.0)).a;',",
        "            '    gs += texture2D(uMap, guv - vec2(gr.x, 0.0)).a;',",
        "            '    gs += texture2D(uMap, guv + vec2(0.0, gr.y)).a;',",
        "            '    gs += texture2D(uMap, guv - vec2(0.0, gr.y)).a;',",
        "            '    gs += texture2D(uMap, guv + gr * vec2(0.72, 0.72)).a;',",
        "            '    gs += texture2D(uMap, guv - gr * vec2(0.72, 0.72)).a;',",
        "            '    gs += texture2D(uMap, guv + gr * vec2(0.72, -0.72)).a;',",
        "            '    gs += texture2D(uMap, guv + gr * vec2(-0.72, 0.72)).a;',",
        "            '    halo = clamp(gs / 8.0, 0.0, 1.0);',",
        "            '  }',",
    ]
)
new_sample = CRLF.join(
    [
        "            '  // 辉光：按「三圈 × 六向」采样字形 alpha 并做距离加权，得到柔和的类高斯光晕',",
        "            '  float halo = 0.0;',",
        "            '  if (uGlow > 0.002) {',",
        "            '    vec2 texel = vec2(4.0 / 1024.0, 1.0 / 256.0);',",
        "            '    float radius = mix(3.0, 15.0, clamp(uGlow, 0.0, 1.0));',",
        "            '    float gsum = 0.0;',",
        "            '    float wsum = 0.0;',",
        "            '    for (int ring = 1; ring <= 3; ring++) {',",
        "            '      float rad = radius * float(ring) / 3.0;',",
        "            '      float weight = 1.0 - float(ring - 1) * 0.32;',",
        "            '      for (int sp = 0; sp < 6; sp++) {',",
        "            '        float ang = float(sp) * 1.0471976 + float(ring) * 0.42;',",
        "            '        vec2 off = vec2(cos(ang) * rad * texel.x, sin(ang) * rad * texel.y);',",
        "            '        gsum += texture2D(uMap, guv + off).a * weight;',",
        "            '        wsum += weight;',",
        "            '      }',",
        "            '    }',",
        "            '    halo = clamp(gsum / max(wsum, 0.0001), 0.0, 1.0);',",
        "            '  }',",
    ]
)
fs = rep(fs, old_sample, new_sample, "halo-sample")

# 2) 辉光叠加：颜色略白、强度降低，并且跟随整句的不透明度/逐字状态一起淡出（修「文字消失后辉光还在」）
old_glow = CRLF.join(
    [
        "            '  // 柔光晕：颜色跟随当前句颜色，越往外越淡',",
        "            '  if (halo > 0.002) {',",
        "            '    float haloOut = clamp(halo * (1.0 - tex.a), 0.0, 1.0);',",
        "            '    color = mix(color, baseColor, clamp(haloOut * 1.4, 0.0, 1.0));',",
        "            '    alpha = clamp(alpha + haloOut * uGlow * 0.9, 0.0, 1.0);',",
        "            '  }',",
    ]
)
new_glow = CRLF.join(
    [
        "            '  // 柔光晕：颜色跟随当前句颜色、略偏白，越往外越淡',",
        "            '  if (halo > 0.002) {',",
        "            '    float haloOut = clamp(halo * (1.0 - tex.a), 0.0, 1.0);',",
        "            '    vec3 glowColor = mix(baseColor, vec3(1.0), 0.18);',",
        "            '    // 光晕必须和正文一起淡出：乘上整句不透明度、逐字透明度与书写状态',",
        "            '    float glowFade = uOpacity * charAlpha * written * mix(1.0, 0.34, unfilled);',",
        "            '    color = mix(color, glowColor, clamp(haloOut * 1.1, 0.0, 1.0));',",
        "            '    alpha = clamp(alpha + haloOut * uGlow * 0.62 * glowFade, 0.0, 1.0);',",
        "            '  }',",
    ]
)
fs = rep(fs, old_glow, new_glow, "halo-compose")

write(FS, fs)
print("OK: halo-sample, halo-compose")
