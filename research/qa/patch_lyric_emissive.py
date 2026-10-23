# -*- coding: utf-8 -*-
"""歌词「辉光」改为「发光」：字本身自发光 + 极窄光边，不再是大范围光晕"""
from pathlib import Path

FS = Path(r"E:\Zilux2开发\web\src\three\floatScene.ts")
SS = Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")
NL = "\r\n"


def read(p: Path) -> str:
    with p.open(encoding="utf-8", newline="") as f:
        return f.read()


def write(p: Path, s: str) -> None:
    with p.open("w", encoding="utf-8", newline="") as f:
        f.write(s)


def rep(text: str, lines_old, lines_new, tag: str) -> str:
    old = NL.join(lines_old)
    new = NL.join(lines_new)
    assert text.count(old) == 1, f"{tag}: got {text.count(old)}"
    return text.replace(old, new)


fs = read(FS)

# 1) 采样半径收紧：光边只贴着字形外扩几个像素
fs = rep(
    fs,
    [
        "            '  // 辉光：按「三圈 × 六向」采样字形 alpha 并做距离加权，得到柔和的类高斯光晕',",
    ],
    [
        "            '  // 发光：在字形外几个像素内采样 alpha，做一圈很窄的光边（不是大范围光晕）',",
    ],
    "comment",
)
fs = rep(
    fs,
    [
        "            '    vec2 texel = vec2(4.0 / 1024.0, 1.0 / 256.0);',",
        "            '    float radius = mix(3.0, 15.0, clamp(uGlow, 0.0, 1.0));',",
    ],
    [
        "            '    vec2 texel = vec2(1.0 / 1024.0, 1.0 / 256.0);',",
        "            '    float radius = mix(2.2, 9.0, clamp(uGlow, 0.0, 1.0));',",
    ],
    "radius",
)
fs = rep(
    fs,
    [
        "            '      float weight = 1.0 - float(ring - 1) * 0.32;',",
    ],
    [
        "            '      float weight = 1.0 - float(ring - 1) * 0.34;',",
    ],
    "weight",
)

# 2) 组合方式：自发光提亮字形 + 窄光边，不再做外围光晕
fs = rep(
    fs,
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
    ],
    [
        "            '  // 发光：字本身被点亮（自发光提亮），边缘只留一圈很窄的光，越亮越像灯管',",
        "            '  if (halo > 0.002) {',",
        "            '    float glowFade = uOpacity * charAlpha * written * mix(1.0, 0.34, unfilled);',",
        "            '    float emit = clamp(uGlow * glowFade, 0.0, 1.0);',",
        "            '    float rim = clamp(halo * (1.0 - tex.a), 0.0, 1.0);',",
        "            '    vec3 glowColor = mix(baseColor, vec3(1.0), 0.45);',",
        "            '    color = mix(color, glowColor, clamp(emit * tex.a * 0.5, 0.0, 1.0));',",
        "            '    color += vec3(0.62, 0.60, 0.52) * emit * rim * 0.8;',",
        "            '    color = clamp(color, 0.0, 1.0);',",
        "            '    alpha = clamp(alpha + emit * rim * 0.85, 0.0, 1.0);',",
        "            '  }',",
    ],
    "compose",
)

# 3) 画布批注：原来 16px 白色大范围模糊 → 更紧更亮的边缘，观感是“灯管边缘”而不是雾
fs = rep(
    fs,
    [
        "    ctx.shadowColor = 'rgba(255,255,255,0.35)';",
        "    ctx.shadowBlur = 16;",
    ],
    [
        "    ctx.shadowColor = 'rgba(255,255,255,0.5)';",
        "    ctx.shadowBlur = 9;",
    ],
    "baked-shadow",
)

write(FS, fs)

ss = read(SS)

# 4) UI 文案 + 默认值
ss = rep(
    ss,
    [
        '                <div class="custom-label"><span>文字辉光</span><b data-lyric-glow-current>35%</b></div>',
        '                <input class="custom-slider" data-lyric-glow type="range" min="0" max="100" step="1" value="35" aria-label="歌词文字辉光" />',
    ],
    [
        '                <div class="custom-label"><span>文字发光</span><b data-lyric-glow-current>55%</b></div>',
        '                <input class="custom-slider" data-lyric-glow type="range" min="0" max="100" step="1" value="55" aria-label="歌词文字发光" />',
    ],
    "ui-label",
)
ss = rep(
    ss,
    [
        "    lyricGlow: 35,",
    ],
    [
        "    lyricGlow: 55,",
    ],
    "ui-default",
)

write(SS, ss)
print("OK: comment, radius, weight, compose, baked-shadow, ui-label, ui-default")
