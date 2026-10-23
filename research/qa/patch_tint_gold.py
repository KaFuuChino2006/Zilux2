# -*- coding: utf-8 -*-
"""修复：黑金主题下「节奏 / 封面」换色层被 display:none 强制隐藏 -> 背景一直是黑的。
做法：
1) applyBgColorSetting 里加 is-tint-on 类（节奏 / 封面模式用叠层换色）；
2) space.css 末尾追加规则：黑金主题在 is-tint-on 时允许 .space-tint / .space-sheen 显示。
"""
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
TS = ROOT / "web/src/ui/spaceShell.ts"
CSS = ROOT / "web/src/styles/space.css"

ts = TS.open(encoding="utf-8", newline="").read()
css = CSS.open(encoding="utf-8", newline="").read()

needle = "    window.clearTimeout(tintTimer);\r\n    root.classList.remove('is-solid-bg');\r\n"
assert ts.count(needle) == 1, "applyBgColorSetting anchor"
add = (
    "    window.clearTimeout(tintTimer);\r\n"
    "    // 节奏 / 封面模式靠 .space-tint 叠层上色；加个标记，避免黑金主题把它们整层隐藏\n"
    "    root.classList.toggle('is-tint-on', custom.bgColor === 'rhythm' || custom.bgColor === 'cover');\r\n"
    "    root.classList.remove('is-solid-bg');\r\n"
)
ts = ts.replace(needle, add)
TS.write_text(ts, encoding="utf-8", newline="")

css_add = (
    "\r\n"
    "/* ===== 黑金主题：节奏 / 封面的换色叠层要能显示（原来被整层 display:none -> 背景全黑） ===== */\r\n"
    ".space-shell.theme-gold.is-tint-on .space-tint,\r\n"
    ".space-shell.theme-gold.is-tint-on .space-sheen {\r\n"
    "  display: block !important;\r\n"
    "}\r\n"
    "/* 叠层在 3D canvas 之下，只染背景；黑金主题的底噪压暗层继续垫在最下面 */\r\n"
    ".space-shell.theme-gold.is-tint-on .space-tint {\r\n"
    "  z-index: 0 !important;\r\n"
    "}\r\n"
    ".space-shell.theme-gold.is-tint-on .space-sheen {\r\n"
    "  z-index: 0 !important;\r\n"
    "}\r\n"
)
if "theme-gold.is-tint-on" not in css:
    css = css + css_add
CSS.write_text(css, encoding="utf-8", newline="")
print("OK: ts-is-tint-on, css-gold-tint")
