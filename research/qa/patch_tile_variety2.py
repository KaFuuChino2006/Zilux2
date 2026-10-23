"""磁贴封面大小差异：仅 spaceShell 侧（floatScene 已由上一脚本完成）。"""
import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
path = ROOT / "web/src/ui/spaceShell.ts"
raw = io.open(str(path), "r", encoding="utf-8", newline="").read()
nl = "\r\n" if "\r\n" in raw else "\n"
s = raw.replace("\r\n", "\n")


def rep(text, old, new, name, count=1):
    got = text.count(old)
    if got != count:
        raise SystemExit(f"FAIL {name}: count={got} (expect {count})")
    print(f"OK: {name}")
    return text.replace(old, new)


s = rep(
    s,
    "                <span>实时网格预览</span>\n"
    "              </div>\n"
    "            </div>\n"
    "          </section>\n",
    "                <span>实时网格预览</span>\n"
    "              </div>\n"
    "            </div>\n"
    "            <div class=\"custom-field\">\n"
    "              <div class=\"custom-label\"><span>封面大小差异</span><b data-tile-variety-current>40%</b></div>\n"
    "              <input class=\"custom-slider\" data-tile-variety type=\"range\" min=\"0\" max=\"100\" step=\"1\" value=\"40\" aria-label=\"封面大小差异\" />\n"
    "              <div class=\"custom-scale\"><span>一样大</span><span>错落</span></div>\n"
    "            </div>\n"
    "          </section>\n",
    "html",
)

s = rep(
    s,
    "  const customBendInput = root.querySelector<HTMLInputElement>('[data-tile-bend]')!;\n",
    "  const customBendInput = root.querySelector<HTMLInputElement>('[data-tile-bend]')!;\n"
    "  const tileVarietyInput = root.querySelector<HTMLInputElement>('[data-tile-variety]')!;\n"
    "  const tileVarietyCurrent = root.querySelector<HTMLElement>('[data-tile-variety-current]')!;\n",
    "query",
)

s = rep(s, "    tileBend: 0.35,\n", "    tileBend: 0.35,\n    tileSizeVariety: 40,\n", "default")
s = rep(s, "        tileBend?: unknown;\n", "        tileBend?: unknown;\n        tileSizeVariety?: unknown;\n", "partial")

s = rep(
    s,
    "      const bendRaw = Number(parsed.tileBend);\n"
    "      const tileBend = Number.isFinite(bendRaw) ? Math.min(3, Math.max(0, bendRaw)) : DEFAULT_CUSTOM.tileBend;\n",
    "      const bendRaw = Number(parsed.tileBend);\n"
    "      const tileBend = Number.isFinite(bendRaw) ? Math.min(3, Math.max(0, bendRaw)) : DEFAULT_CUSTOM.tileBend;\n"
    "      const varietyRaw = Number(parsed.tileSizeVariety);\n"
    "      const tileSizeVariety = Number.isFinite(varietyRaw)\n"
    "        ? Math.min(100, Math.max(0, Math.round(varietyRaw)))\n"
    "        : DEFAULT_CUSTOM.tileSizeVariety;\n",
    "load",
)

s = rep(s, "        tileBend,\n", "        tileBend,\n        tileSizeVariety,\n", "load-return")

s = rep(
    s,
    "    applyStarColor();\n    space?.setTileBend(custom.tileBend);\n",
    "    applyStarColor();\n    space?.setTileBend(custom.tileBend);\n    space?.setTileSizeVariety(custom.tileSizeVariety / 100);\n",
    "apply",
)

s = rep(
    s,
    "    customBendInput.value = String(Math.round(custom.tileBend * 100));\n"
    "    customBendCurrent.textContent = `${Math.round(custom.tileBend * 100)}%`;\n",
    "    customBendInput.value = String(Math.round(custom.tileBend * 100));\n"
    "    customBendCurrent.textContent = `${Math.round(custom.tileBend * 100)}%`;\n"
    "    tileVarietyInput.value = String(custom.tileSizeVariety);\n"
    "    tileVarietyCurrent.textContent = `${custom.tileSizeVariety}%`;\n",
    "sync",
)

s = rep(
    s,
    "  customBendInput.addEventListener('input', () => {\n"
    "    custom.tileBend = Math.min(3, Math.max(0, Number(customBendInput.value) / 100));\n"
    "    space?.setTileBend(custom.tileBend);\n"
    "    customBendCurrent.textContent = `${Math.round(custom.tileBend * 100)}%`;\n"
    "    persistCustom();\n"
    "  });\n",
    "  customBendInput.addEventListener('input', () => {\n"
    "    custom.tileBend = Math.min(3, Math.max(0, Number(customBendInput.value) / 100));\n"
    "    space?.setTileBend(custom.tileBend);\n"
    "    customBendCurrent.textContent = `${Math.round(custom.tileBend * 100)}%`;\n"
    "    persistCustom();\n"
    "  });\n"
    "  tileVarietyInput.addEventListener('input', () => {\n"
    "    custom.tileSizeVariety = Math.min(100, Math.max(0, Math.round(Number(tileVarietyInput.value) || 0)));\n"
    "    space?.setTileSizeVariety(custom.tileSizeVariety / 100);\n"
    "    tileVarietyCurrent.textContent = `${custom.tileSizeVariety}%`;\n"
    "    persistCustom();\n"
    "  });\n",
    "handler",
)

io.open(str(path), "w", encoding="utf-8", newline="").write(s.replace("\n", nl) if nl == "\r\n" else s)
print("DONE")
