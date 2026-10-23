# -*- coding: utf-8 -*-
"""调整 3D 磨砂玻璃地面的尺寸、相机与材质，并让进入后的背景更冷更深。"""
import io
import sys

TS = r"E:\Zilux2开发\web\src\three\loginSpace.ts"
CSS = r"E:\Zilux2开发\web\src\styles\space.css"

errors = []


def load(path):
    with io.open(path, "r", encoding="utf-8-sig", newline="") as fh:
        return fh.read()


def save(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        errors.append("%s: expected 1 match, found %d" % (label, count))
        return text
    return text.replace(old, new, 1)


ts = load(TS)

ts = replace_once(
    ts,
    "  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);",
    "  const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 60);",
    "camera fov",
)

ts = replace_once(
    ts,
    "  const GROUND_W = 23;\n  const GROUND_D = 13;\n  const GROUND_RADIUS = 1.7;",
    "  const GROUND_W = 16.5;\n  const GROUND_D = 9.4;\n  const GROUND_RADIUS = 1.35;",
    "ground size",
)

ts = replace_once(
    ts,
    "  const view = { yaw: 0, pitch: 0.3, radius: 8.8 };\n  const viewTarget = { yaw: 0, pitch: 0.3, radius: 8.8 };",
    "  const view = { yaw: 0, pitch: 0.42, radius: 12.6 };\n  const viewTarget = { yaw: 0, pitch: 0.42, radius: 12.6 };",
    "default view",
)

# 玻璃下方背景：更冷、更饱和，透过玻璃才能看见颜色
ts = replace_once(
    ts,
    "    base.addColorStop(0, '#eef2ff');\n    base.addColorStop(0.45, '#f7f3ff');\n    base.addColorStop(1, '#eaf6ff');",
    "    base.addColorStop(0, '#dfe8ff');\n    base.addColorStop(0.45, '#f2f1ff');\n    base.addColorStop(1, '#d9ecff');",
    "bg base gradient",
)

ts = replace_once(
    ts,
    "    blob(0.24, 0.3, 0.5, 'rgba(138, 123, 255, 0.34)');\n    blob(0.78, 0.26, 0.44, 'rgba(90, 208, 255, 0.28)');\n    blob(0.56, 0.82, 0.52, 'rgba(255, 158, 203, 0.24)');\n    blob(0.9, 0.88, 0.36, 'rgba(255, 214, 140, 0.20)');",
    "    blob(0.24, 0.3, 0.5, 'rgba(126, 118, 255, 0.50)');\n    blob(0.78, 0.26, 0.44, 'rgba(74, 198, 255, 0.44)');\n    blob(0.56, 0.82, 0.52, 'rgba(255, 136, 194, 0.38)');\n    blob(0.9, 0.88, 0.36, 'rgba(255, 206, 120, 0.32)');",
    "bg blobs",
)

ts = replace_once(
    ts,
    "    bgCtx.strokeStyle = 'rgba(106, 92, 255, 0.10)';",
    "    bgCtx.strokeStyle = 'rgba(106, 92, 255, 0.14)';",
    "bg arcs",
)

# 玻璃白纱更透，磨砂颗粒更明显，中心柔光稍强
ts = replace_once(
    ts,
    "    veil.addColorStop(0, 'rgba(255,255,255,0.72)');\n    veil.addColorStop(0.5, 'rgba(255,255,255,0.58)');\n    veil.addColorStop(1, 'rgba(255,255,255,0.66)');",
    "    veil.addColorStop(0, 'rgba(255,255,255,0.52)');\n    veil.addColorStop(0.5, 'rgba(255,255,255,0.42)');\n    veil.addColorStop(1, 'rgba(255,255,255,0.48)');",
    "glass veil",
)

ts = replace_once(
    ts,
    "      const a = Math.random() * 0.05 + 0.012;",
    "      const a = Math.random() * 0.07 + 0.02;",
    "glass dots",
)

ts = replace_once(
    ts,
    "    sheen.addColorStop(0, 'rgba(255,255,255,0.20)');",
    "    sheen.addColorStop(0, 'rgba(255,255,255,0.28)');",
    "glass sheen",
)

# 悬浮阴影更强、离地更近
ts = replace_once(
    ts,
    "    halo.addColorStop(0, 'rgba(23, 26, 33, 0.20)');\n    halo.addColorStop(0.62, 'rgba(23, 26, 33, 0.12)');",
    "    halo.addColorStop(0, 'rgba(23, 26, 33, 0.26)');\n    halo.addColorStop(0.62, 'rgba(23, 26, 33, 0.16)');",
    "shadow halo",
)

ts = replace_once(
    ts,
    "  addSpacePlane(shadowCanvas, GROUND_W + 2.4, GROUND_D + 2.4, -0.34, 0.85);",
    "  addSpacePlane(shadowCanvas, GROUND_W + 2.2, GROUND_D + 2.2, -0.28, 0.9);",
    "shadow plane",
)

if errors:
    sys.stderr.write("ABORT loginSpace:\n" + "\n".join(errors) + "\n")
    sys.exit(1)

save(TS, ts)

css = load(CSS)

css = replace_once(
    css,
    """.space-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
}""",
    """/* 进入空间后的冷调背景：让白色磨砂玻璃板从页面里浮出来 */
.space-shell::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 1.1s cubic-bezier(0.22, 0.61, 0.36, 1);
  background:
    radial-gradient(1200px 720px at 26% 18%, rgba(122, 148, 255, 0.36), rgba(226, 236, 255, 0) 66%),
    radial-gradient(1100px 700px at 80% 16%, rgba(112, 210, 255, 0.30), rgba(226, 240, 255, 0) 64%),
    radial-gradient(1000px 640px at 62% 92%, rgba(196, 158, 255, 0.26), rgba(230, 238, 255, 0) 62%),
    radial-gradient(900px 600px at 14% 88%, rgba(255, 176, 214, 0.22), rgba(232, 240, 255, 0) 60%),
    linear-gradient(165deg, #dee5f6 0%, #e9eefb 46%, #dbe6f7 100%);
}

.space-shell.is-entered::before {
  opacity: 1;
}

.space-canvas {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
}""",
    "space css backdrop",
)

if errors:
    sys.stderr.write("ABORT space.css:\n" + "\n".join(errors) + "\n")
    sys.exit(1)

save(CSS, css)
print("glass edits applied")
