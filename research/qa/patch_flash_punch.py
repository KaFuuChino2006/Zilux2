# -*- coding: utf-8 -*-
"""白闪更强烈：闪层提到 3D 画布之上（不再被磁贴挡住）+ 提高亮度与覆盖范围"""
from pathlib import Path

CSS = Path(r"E:\Zilux2开发\web\src\styles\space.css")
TS = Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")


def read(p: Path) -> str:
    with p.open(encoding="utf-8", newline="") as f:
        return f.read()


def write(p: Path, s: str) -> None:
    with p.open("w", encoding="utf-8", newline="") as f:
        f.write(s)


def rep(text: str, old: str, new: str, tag: str, count: int = 1) -> str:
    assert text.count(old) == count, f"{tag}: expect {count}, got {text.count(old)}"
    return text.replace(old, new)


crlf = "\r\n"

# ---------- CSS：闪层浮到 3D 画布之上（UI 之下） ----------
css = read(CSS)
old_css = crlf.join(
    [
        ".space-flash {",
        "  position: absolute;",
        "  inset: 0;",
        "  z-index: 0;",
        "  pointer-events: none;",
        "  opacity: 0;",
    ]
)
new_css = crlf.join(
    [
        ".space-flash {",
        "  position: absolute;",
        "  inset: 0;",
        "  /* 闪层必须在 3D 画布(z-index:1) 之上：否则白闪只照亮背景、被磁贴挡住，",
        "     看起来一点都不亮。仍然在 UI(z-index >= 3) 之下，不挡操作。 */",
        "  z-index: 2;",
        "  pointer-events: none;",
        "  opacity: 0;",
        "  will-change: opacity;",
    ]
)
css = rep(css, old_css, new_css, "flash-z")
write(CSS, css)

# ---------- TS：鼓点白闪强度/覆盖范围 ----------
ts = read(TS)

# 1) 鼓点调用的力度：由 0.42 倍改成 0.35~0.9 的强闪
old_call = "        flashBackground(strength * 0.42, true);"
new_call = "        flashBackground(0.35 + strength * 0.55, true);"
ts = rep(ts, old_call, new_call, "flash-strength")

# 2) 亮度上限提高、下限提高
old_alpha = "    const alpha = Math.min(0.92, Math.max(0.03, 0.92 * strength * scale));"
new_alpha = "    const alpha = Math.min(0.9, Math.max(0.16, 1.02 * strength * scale));"
ts = rep(ts, old_alpha, new_alpha, "flash-alpha")

# 3) 中心更白更亮、边缘更远：整屏都有肉眼可见的提亮
old_bg = crlf.join(
    [
        "    flashLayer.style.background = `radial-gradient(120% 92% at 50% 42%, ${withAlpha(accent, 0.98)} 0%, ${withAlpha(accent, 0.5)} 48%, ${withAlpha(accent, 0)} 80%)`;",
    ]
)
new_bg = crlf.join(
    [
        "    flashLayer.style.background = [",
        "      `radial-gradient(150% 118% at 50% 44%, rgba(255, 255, 255, 0.99) 0%, ${withAlpha(accent, 0.86)} 32%, ${withAlpha(accent, 0.34)} 68%, ${withAlpha(accent, 0)} 96%)`,",
        "      `radial-gradient(80% 60% at 50% 44%, rgba(255, 255, 255, 0.96) 0%, ${withAlpha(accent, 0.5)} 46%, ${withAlpha(accent, 0)} 88%)`,",
        "    ].join(',');",
    ]
)
ts = rep(ts, old_bg, new_bg, "flash-bg")

write(TS, ts)
print("OK: flash-z, flash-strength, flash-alpha, flash-bg")
