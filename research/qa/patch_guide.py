import io
from pathlib import Path

nl = '\r\n'
ts = Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")
raw = io.open(ts, "r", encoding="utf-8", newline="").read()
text = raw.replace("\r\n", "\n")

def rep(old, new, count=1):
    global text
    assert text.count(old) == count, f"anchor fail ({text.count(old)}): {old[:60]}"
    text = text.replace(old, new)

rep(
    "import { showToast } from './toast';",
    "import { createGuide } from './guide';\nimport { installTooltips } from './tooltip';\nimport { showToast } from './toast';",
)
rep(
    "  root.appendChild(island.element);",
    "  root.appendChild(island.element);\n  installTooltips(root);\n  const guide = createGuide(root);",
)
rep(
    "    maybeRestoreLocalLibrary();\n    wakeShellUi();",
    "    maybeRestoreLocalLibrary();\n    wakeShellUi();\n    guide.maybeShow();",
)

io.open(ts, "w", encoding="utf-8", newline="").write(text.replace("\n", nl))
print("OK spaceShell")
