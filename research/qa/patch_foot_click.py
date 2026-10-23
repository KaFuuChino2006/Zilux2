import io

path = r"E:\Zilux2开发\web\src\styles\space.css"
with io.open(path, "r", encoding="utf-8", newline="") as fh:
    text = fh.read()

nl = "\r\n" if "\r\n" in text else "\n"

block = nl.join([
    "",
    "/* 底部状态条：整条本体不挡 3D 拖拽（pointer-events:none），",
    "   但「回到第一页 / 跳页」等按钮与跳页面板必须恢复可点，",
    "   否则这些控件永远点不到。跳页面板改成相对状态条向上弹出，避免被外层 transform 影响定位。 */",
    ".space-foot {",
    "  pointer-events: none;",
    "}",
    ".space-foot .space-foot-btn,",
    ".space-foot .space-page-pop,",
    ".space-foot .space-page-pop-label,",
    ".space-foot .space-page-pop-input {",
    "  pointer-events: auto;",
    "}",
    ".space-foot .space-page-pop {",
    "  position: absolute;",
    "  left: 50%;",
    "  bottom: calc(100% + 12px);",
    "  transform: translateX(-50%);",
    "}",
    ".space-foot .space-page-pop-input {",
    "  width: 64px;",
    "  border-radius: var(--r-pill);",
    "  border: 1px solid rgba(23, 26, 33, 0.18);",
    "  background: rgba(255, 255, 255, 0.98);",
    "  color: inherit;",
    "  font: 600 11.5px/1 \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", system-ui, sans-serif;",
    "  padding: 4px 8px;",
    "  text-align: center;",
    "}",
    "",
])

text = text.rstrip(nl) + nl + block
with io.open(path, "w", encoding="utf-8", newline="") as fh:
    fh.write(text)
print("OK: css-foot-pointer")
