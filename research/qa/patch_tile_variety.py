"""磁贴封面大小差异：floatScene 每块磁贴随机大小 + spaceShell 滑条。"""
import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")


def load(rel):
    path = ROOT / rel
    raw = io.open(str(path), "r", encoding="utf-8", newline="").read()
    nl = "\r\n" if "\r\n" in raw else "\n"
    return path, raw.replace("\r\n", "\n"), nl


def save(path, text, nl):
    data = text.replace("\n", nl) if nl == "\r\n" else text
    io.open(str(path), "w", encoding="utf-8", newline="").write(data)


def rep(text, old, new, name, count=1):
    got = text.count(old)
    if got != count:
        raise SystemExit(f"FAIL {name}: count={got} (expect {count})")
    print(f"OK: {name}")
    return text.replace(old, new)


# ---------- floatScene.ts ----------
p, t, nl = load("web/src/three/floatScene.ts")

t = rep(
    t,
    "  let layoutScale = 1;\n",
    "  let layoutScale = 1;\n"
    "  // 每块磁贴的随机大小系数（0 = 全部一样大）\n"
    "  let tileSizeVariety = 0.4;\n"
    "  // 封面大小差异：确定性伪随机，同一块磁贴每帧保持同一大小\n"
    "  function tileSizeFactor(index: number): number {\n"
    "    if (tileSizeVariety <= 0.001) return 1;\n"
    "    const h = Math.sin((index + 1) * 127.1) * 43758.5453;\n"
    "    const r = h - Math.floor(h);\n"
    "    return 1 + (r - 0.5) * 2 * tileSizeVariety * 0.24;\n"
    "  }\n",
    "state",
)

t = rep(
    t,
    "    const size = TILE_SIZE * layoutScale;\n"
    "    const col = index % tileCols;\n"
    "    const row = Math.floor(index / tileCols);\n"
    "    return {\n"
    "      x: (col - (tileCols - 1) / 2) * size,\n"
    "      y: ((tileRows - 1) / 2 - row) * size,\n"
    "    };\n",
    "    const size = TILE_SIZE * layoutScale;\n"
    "    // 大小不一时刻意拉开网格间距，避免放大后的磁贴互相压住\n"
    "    const spacing = size * (1 + tileSizeVariety * 0.18);\n"
    "    const col = index % tileCols;\n"
    "    const row = Math.floor(index / tileCols);\n"
    "    return {\n"
    "      x: (col - (tileCols - 1) / 2) * spacing,\n"
    "      y: ((tileRows - 1) / 2 - row) * spacing,\n"
    "    };\n",
    "slot",
)

t = rep(
    t,
    "      tile.group.scale.setScalar(\n"
    "        layoutScale * (0.94 + 0.06 * appear) * (1 + t * 0.11 + sel * 0.07) * (1 - scatterEase * 0.32),\n"
    "      );\n",
    "      tile.group.scale.setScalar(\n"
    "        layoutScale *\n"
    "          tileSizeFactor(tile.index) *\n"
    "          (0.94 + 0.06 * appear) *\n"
    "          (1 + t * 0.11 + sel * 0.07) *\n"
    "          (1 - scatterEase * 0.32),\n"
    "      );\n",
    "scale",
)

t = rep(
    t,
    "      probeEdgeX.set(x + size * 0.5, slot.y, z).project(camera);\n"
    "      probeEdgeY.set(x, slot.y + size * 0.5, z).project(camera);\n",
    "      const hitSize = size * tileSizeFactor(tile.index);\n"
    "      probeEdgeX.set(x + hitSize * 0.5, slot.y, z).project(camera);\n"
    "      probeEdgeY.set(x, slot.y + hitSize * 0.5, z).project(camera);\n",
    "hit-test",
)

t = rep(
    t,
    "  setTileBend(bend: number): void;\n",
    "  setTileBend(bend: number): void;\n  setTileSizeVariety(value: number): void;\n",
    "iface",
)

t = rep(
    t,
    "    setTileBend(bend: number) {\n"
    "      tileBendTarget = Math.max(0, Math.min(3, bend));\n"
    "    },\n",
    "    setTileBend(bend: number) {\n"
    "      tileBendTarget = Math.max(0, Math.min(3, bend));\n"
    "    },\n"
    "    setTileSizeVariety(value: number) {\n"
    "      tileSizeVariety = Math.max(0, Math.min(1, value));\n"
    "    },\n",
    "impl",
)

save(p, t, nl)

# ---------- spaceShell.ts ----------
p2, s, nl2 = load("web/src/ui/spaceShell.ts")

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
    "    space?.setTileBend(custom.tileBend);\n",
    "    space?.setTileBend(custom.tileBend);\n    space?.setTileSizeVariety(custom.tileSizeVariety / 100);\n",
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

save(p2, s, nl2)
print("DONE")
