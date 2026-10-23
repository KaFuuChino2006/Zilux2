# -*- coding: utf-8 -*-
"""粒子效果放大：范围变大、尺寸更明显、粒子只分布在前方视野、星尘更亮"""
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
    new = NL.join(lines_new) if lines_new else ""
    assert text.count(old) == 1, f"{tag}: got {text.count(old)}"
    return text.replace(old, new)


def rep1(text: str, old: str, new: str, tag: str) -> str:
    assert text.count(old) == 1, f"{tag}: got {text.count(old)}"
    return text.replace(old, new)


fs = read(FS)

# 1) 容量与分布范围：粒子更多、更靠近视野；z 只落在相机前方
fs = rep(
    fs,
    [
        "  const FX_MAX = 260;",
        "  const FX_HALF = new THREE.Vector3(18, 11, 18);",
    ],
    [
        "  const FX_MAX = 900;",
        "  const FX_HALF = new THREE.Vector3(15, 10, 15);",
        "  // z 只分布在相机前方一段区间里，避免一半粒子跑到背后看不见",
        "  const FX_NEAR = -1.8;",
        "  const FX_FAR = -22;",
        "  const FX_WRAP_Z = FX_FAR - FX_NEAR;",
    ],
    "fx-capacity",
)

# 2) 星尘上限 1300 -> 2600
fs = rep1(fs, "  const STAR_COUNT = 1300;", "  const STAR_COUNT = 2600;", "star-count")

# 3) 星点：点更大、四芒星更粗更亮
fs = rep1(
    fs,
    "        gl_PointSize = (2.4 + aSeed * 4.2) * uSize * uPixelRatio * (8.0 / depth);",
    "        gl_PointSize = clamp((3.6 + aSeed * 6.4) * uSize * uPixelRatio * (10.0 / depth), 2.0, 72.0);",
    "star-size",
)
fs = rep(
    fs,
    [
        "        float armX = (1.0 - smoothstep(0.02, 0.1, abs(r.y))) * (1.0 - smoothstep(0.28, 0.46, abs(r.x)));",
        "        float armY = (1.0 - smoothstep(0.02, 0.1, abs(r.x))) * (1.0 - smoothstep(0.28, 0.46, abs(r.y)));",
        "        float core = smoothstep(0.3, 0.03, length(r));",
        "        float a = (core * 0.55 + (armX + armY) * 0.85) * uOpacity * vTwinkle;",
    ],
    [
        "        float armX = (1.0 - smoothstep(0.05, 0.21, abs(r.y))) * (1.0 - smoothstep(0.3, 0.5, abs(r.x)));",
        "        float armY = (1.0 - smoothstep(0.05, 0.21, abs(r.x))) * (1.0 - smoothstep(0.3, 0.5, abs(r.y)));",
        "        float core = smoothstep(0.36, 0.05, length(r));",
        "        float a = clamp(core * 0.85 + (armX + armY) * 1.15, 0.0, 1.0) * uOpacity * vTwinkle;",
    ],
    "star-shape",
)

# 4) 三角：更大、描边更实
fs = rep1(
    fs,
    "        gl_PointSize = (12.0 + aSeed * 9.0) * uSize * uPixelRatio * (7.0 / depth);",
    "        gl_PointSize = clamp((18.0 + aSeed * 14.0) * uSize * uPixelRatio * (9.0 / depth), 3.0, 110.0);",
    "tri-size",
)
fs = rep1(
    fs,
    "        float a = (fill * 0.26 + edge * 0.92) * uOpacity * (0.6 + vSeed * 0.4);",
    "        float a = (fill * 0.4 + edge * 1.05) * uOpacity * (0.65 + vSeed * 0.45);",
    "tri-alpha",
)

# 5) 星尘：更大更亮
fs = rep1(
    fs,
    "        gl_PointSize = (1.2 + aSeed * 2.4) * (1.0 + uEnergy * 0.75) * uPixelRatio * uDustSize * (9.0 / max(1.0, -mv.z));",
    "        gl_PointSize = clamp((2.2 + aSeed * 3.8) * (1.0 + uEnergy * 0.75) * uPixelRatio * uDustSize * (11.0 / max(1.0, -mv.z)), 1.6, 40.0);",
    "dust-size",
)

# 6) z 环绕改为「永远在相机前方」
fs = rep(
    fs,
    [
        "      const dz = positions[o + 2] - camZ;",
        "      if (dz > FX_HALF.z) positions[o + 2] -= FX_HALF.z * 2;",
        "      else if (dz < -FX_HALF.z) positions[o + 2] += FX_HALF.z * 2;",
    ],
    [
        "      const dz = positions[o + 2] - camZ;",
        "      if (dz > FX_NEAR) positions[o + 2] -= FX_WRAP_Z;",
        "      else if (dz < FX_FAR) positions[o + 2] += FX_WRAP_Z;",
    ],
    "z-wrap",
)

write(FS, fs)

ss = read(SS)

# 7) 滑条范围整体放大
ss = rep(
    ss,
    [
        "  const FX_UI: Record<string, { min: number; max: number; step: number; unit: string; digits: number }> = {",
        "    'stars.count': { min: 20, max: 220, step: 2, unit: '', digits: 0 },",
        "    'stars.speed': { min: 0.2, max: 2.4, step: 0.1, unit: 'x', digits: 1 },",
        "    'stars.size': { min: 0.4, max: 2.6, step: 0.1, unit: 'x', digits: 1 },",
        "    'stars.opacity': { min: 10, max: 100, step: 5, unit: '%', digits: 0 },",
        "    'stars.spin': { min: 0, max: 3, step: 0.1, unit: 'x', digits: 1 },",
        "    'links.count': { min: 20, max: 180, step: 2, unit: '', digits: 0 },",
        "    'links.speed': { min: 0.2, max: 2.4, step: 0.1, unit: 'x', digits: 1 },",
        "    'links.size': { min: 0.4, max: 2.6, step: 0.1, unit: 'x', digits: 1 },",
        "    'links.opacity': { min: 10, max: 100, step: 5, unit: '%', digits: 0 },",
        "    'links.link': { min: 4, max: 18, step: 0.4, unit: '', digits: 1 },",
        "    'links.flow': { min: 0, max: 2.4, step: 0.1, unit: 'x', digits: 1 },",
        "    'triangles.count': { min: 10, max: 140, step: 2, unit: '', digits: 0 },",
        "    'triangles.speed': { min: 0.2, max: 2.4, step: 0.1, unit: 'x', digits: 1 },",
        "    'triangles.size': { min: 0.4, max: 2.6, step: 0.1, unit: 'x', digits: 1 },",
        "    'triangles.opacity': { min: 10, max: 100, step: 5, unit: '%', digits: 0 },",
        "    'triangles.spin': { min: 0, max: 3, step: 0.1, unit: 'x', digits: 1 },",
        "    'dust.count': { min: 200, max: 1300, step: 20, unit: '', digits: 0 },",
        "    'dust.size': { min: 0.4, max: 2.6, step: 0.1, unit: 'x', digits: 1 },",
        "    'dust.brightness': { min: 20, max: 100, step: 5, unit: '%', digits: 0 },",
        "    'dust.speed': { min: 0.2, max: 2.4, step: 0.1, unit: 'x', digits: 1 },",
        "  };",
    ],
    [
        "  const FX_UI: Record<string, { min: number; max: number; step: number; unit: string; digits: number }> = {",
        "    'stars.count': { min: 30, max: 800, step: 10, unit: '', digits: 0 },",
        "    'stars.speed': { min: 0.1, max: 6, step: 0.1, unit: 'x', digits: 1 },",
        "    'stars.size': { min: 0.3, max: 8, step: 0.1, unit: 'x', digits: 1 },",
        "    'stars.opacity': { min: 5, max: 100, step: 5, unit: '%', digits: 0 },",
        "    'stars.spin': { min: 0, max: 10, step: 0.1, unit: 'x', digits: 1 },",
        "    'links.count': { min: 20, max: 600, step: 10, unit: '', digits: 0 },",
        "    'links.speed': { min: 0.1, max: 6, step: 0.1, unit: 'x', digits: 1 },",
        "    'links.size': { min: 0.3, max: 8, step: 0.1, unit: 'x', digits: 1 },",
        "    'links.opacity': { min: 5, max: 100, step: 5, unit: '%', digits: 0 },",
        "    'links.link': { min: 2, max: 30, step: 0.5, unit: '', digits: 1 },",
        "    'links.flow': { min: 0, max: 8, step: 0.1, unit: 'x', digits: 1 },",
        "    'triangles.count': { min: 20, max: 500, step: 10, unit: '', digits: 0 },",
        "    'triangles.speed': { min: 0.1, max: 6, step: 0.1, unit: 'x', digits: 1 },",
        "    'triangles.size': { min: 0.3, max: 8, step: 0.1, unit: 'x', digits: 1 },",
        "    'triangles.opacity': { min: 5, max: 100, step: 5, unit: '%', digits: 0 },",
        "    'triangles.spin': { min: 0, max: 10, step: 0.1, unit: 'x', digits: 1 },",
        "    'dust.count': { min: 200, max: 2600, step: 50, unit: '', digits: 0 },",
        "    'dust.size': { min: 0.3, max: 8, step: 0.1, unit: 'x', digits: 1 },",
        "    'dust.brightness': { min: 5, max: 100, step: 5, unit: '%', digits: 0 },",
        "    'dust.speed': { min: 0.1, max: 6, step: 0.1, unit: 'x', digits: 1 },",
        "  };",
        "  // 滑条真实范围以 FX_UI 为准（HTML 里写的旧范围作废）",
        "  root.querySelectorAll<HTMLInputElement>('[data-fx-opt]').forEach((input) => {",
        "    const spec = FX_UI[input.dataset.fxOpt ?? ''];",
        "    if (!spec) return;",
        "    input.min = String(spec.min);",
        "    input.max = String(spec.max);",
        "    input.step = String(spec.step);",
        "  });",
    ],
    "fx-ui",
)

# 8) 默认值调大
ss = rep(
    ss,
    [
        "    fx: {",
        "      stars: { count: 110, speed: 1, size: 1, opacity: 70, spin: 1 },",
        "      links: { count: 90, speed: 0.9, size: 1, opacity: 55, link: 8.4, flow: 1 },",
        "      triangles: { count: 60, speed: 1.1, size: 1, opacity: 62, spin: 1.1 },",
        "      dust: { count: 1300, size: 1, brightness: 76, speed: 1 },",
        "    },",
    ],
    [
        "    fx: {",
        "      stars: { count: 260, speed: 1.1, size: 2.2, opacity: 88, spin: 1.4 },",
        "      links: { count: 150, speed: 1, size: 1.6, opacity: 70, link: 11, flow: 1.4 },",
        "      triangles: { count: 140, speed: 1.2, size: 2, opacity: 78, spin: 1.6 },",
        "      dust: { count: 2000, size: 1.8, brightness: 88, speed: 1.2 },",
        "    },",
    ],
    "fx-defaults",
)

# 9) 粒子颜色提亮
ss = rep1(
    ss,
    "      color: gold ? '#d9c07a' : '#3a4152',",
    "      color: gold ? '#efe0a3' : '#a8bcdf',",
    "fx-color",
)

write(SS, ss)
print("OK: fx-capacity, star-count, star-size, star-shape, tri-size, tri-alpha, dust-size, z-wrap, fx-ui, fx-defaults, fx-color")
