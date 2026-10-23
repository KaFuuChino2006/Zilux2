# -*- coding: utf-8 -*-
"""三项修复：
1) 连线节点偏小 -> 放大节点点大小；
2) 黑金主题下节奏换色发灰 -> 提亮/加饱和 + screen 混合；
3) 「只有闪那一下换了之后又变回原样」-> 累计换色开启时，鼓点不再偷偷重绘另一套颜色。
"""
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
FS = ROOT / "web/src/three/floatScene.ts"
TS = ROOT / "web/src/ui/spaceShell.ts"
CSS = ROOT / "web/src/styles/space.css"


def read(p: Path) -> str:
    with p.open(encoding="utf-8", newline="") as f:
        return f.read()


def write(p: Path, s: str) -> None:
    with p.open("w", encoding="utf-8", newline="") as f:
        f.write(s)


# ---------- 1) 连线节点放大 ----------
fs = read(FS)
old = "        gl_PointSize = (2.0 + aSeed * 3.2) * uSize * uPixelRatio * (8.0 / depth);"
assert fs.count(old) == 1, "node point size shader"
fs = fs.replace(old, "        gl_PointSize = (3.4 + aSeed * 5.2) * uSize * uPixelRatio * (8.0 / depth);")

old = "    fxNodeMaterial.uniforms.uSize!.value = fxOpts.links.size * beatSize;"
assert fs.count(old) == 1, "node size uniform"
fs = fs.replace(old, "    fxNodeMaterial.uniforms.uSize!.value = fxOpts.links.size * beatSize * 2.05;")
write(FS, fs)

# ---------- 2/3) 换色提亮 + 累计换色时不再被鼓点覆盖 ----------
ts = read(TS)

old = "  function evaluateRhythmTint(): void {\r\n    if (custom.bgColor !== 'rhythm') return;\r\n"
assert ts.count(old) == 1, "evaluateRhythmTint head"
ts = ts.replace(
    old,
    "  function evaluateRhythmTint(): void {\r\n"
    "    if (custom.bgColor !== 'rhythm') return;\r\n"
    "    // 累计换色开启时，颜色只由「累计 N 拍擦一次」来换；\r\n"
    "    // 否则鼓点会再随机重绘一套色，看起来就是“擦完又变回原来那个灰的”\r\n"
    "    if (custom.sweep) return;\r\n",
)

old = "    front.style.filter = 'saturate(1.12)';"
assert ts.count(old) == 1, "tint filter"
ts = ts.replace(
    old,
    "    const goldTone = root.classList.contains('theme-gold');\r\n"
    "    const boost = goldTone ? 1.85 : 1.25;\r\n"
    "    // 黑金主题底色很暗，同样的半透明色叠上去会发灰，这里整体提亮、加饱和\r\n"
    "    const tone = (input: string, alpha: number): string =>\r\n"
    "      withAlpha(input, Math.min(0.96, alpha * boost));\r\n"
    "    front.style.filter = goldTone ? 'saturate(1.5) brightness(1.14)' : 'saturate(1.12)';",
)

pairs = [
    ("${withAlpha(c1, 0.5)}", "${tone(c1, 0.5)}"),
    ("${withAlpha(c0, 0.4)}", "${tone(c0, 0.4)}"),
    ("${withAlpha(c2, 0.46)}", "${tone(c2, 0.46)}"),
    ("${withAlpha(c2, 0.82)}", "${tone(c2, 0.82)}"),
    ("${withAlpha(c1, 0.76)}", "${tone(c1, 0.76)}"),
    ("${withAlpha(c0, 0.58)}", "${tone(c0, 0.58)}"),
    ("${withAlpha(c1, 0.34)}", "${tone(c1, 0.34)}"),
    ("${withAlpha(c2, 0.38)}", "${tone(c2, 0.38)}"),
    ("${withAlpha(c0, 0.3)}", "${tone(c0, 0.3)}"),
]
for a, b in pairs:
    assert ts.count(a) == 1, f"tint color {a}"
    ts = ts.replace(a, b)
write(TS, ts)

# ---------- CSS：黑金主题下叠层用 screen 混合，颜色更亮更通透 ----------
css = read(CSS)
if "theme-gold.is-tint-on .space-tint,\r\n.space-shell.theme-gold.is-tint-on .space-sheen {\r\n  mix-blend-mode" not in css:
    css += (
        "\r\n"
        "/* 黑金主题底色暗：换色叠层改用 screen 混合，颜色不会被压成灰 */\r\n"
        ".space-shell.theme-gold.is-tint-on .space-tint,\r\n"
        ".space-shell.theme-gold.is-tint-on .space-sheen {\r\n"
        "  mix-blend-mode: screen;\r\n"
        "}\r\n"
    )
write(CSS, css)
print("OK: node-size, rhythm-vivid, sweep-priority, gold-screen")
