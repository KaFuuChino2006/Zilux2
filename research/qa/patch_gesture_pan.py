"""捏合手势改为「鼠标中键式」平移镜头。

- gesture.ts: 新增 onPan 回调（捏合时手掌中心位移 → 镜头平移），去掉捏合缩放。
- floatScene.ts: handle 加 panBy(dxPx, dyPx)，与中键拖拽同款数学。
- spaceShell.ts: 接线 onPan → space.panBy(...)。
"""

import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
WEB = ROOT / "web" / "src"


def load(path: Path) -> tuple[str, bool]:
    raw = io.open(path, "r", encoding="utf-8", newline="").read()
    crlf = "\r\n" in raw
    return (raw.replace("\r\n", "\n"), crlf)


def save(path: Path, text: str, crlf: bool) -> None:
    if crlf:
        text = text.replace("\n", "\r\n")
    io.open(path, "w", encoding="utf-8", newline="").write(text)


def rep(text: str, old: str, new: str, label: str, count: int = 1) -> str:
    got = text.count(old)
    assert got == count, f"{label}: count={got} expected={count}"
    print(f"OK: {label}")
    return text.replace(old, new)


# ---------------- gesture.ts ----------------
p = WEB / "ui" / "gesture.ts"
text, crlf = load(p)

text = rep(
    text,
    "  onPinch?: (strength: number) => void;",
    """  /** 捏合拖动时的手掌中心位移（归一化）→ 镜头平移，类似鼠标中键拖拽 */
  onPan?: (dx: number, dy: number) => void;
  onPinch?: (strength: number) => void;""",
    "gesture-callback",
)

text = rep(
    text,
    "  let pinchPrev = 1;",
    """  let pinchPrev = 0;
  let pinchPrevX = 0;
  let pinchPrevY = 0;""",
    "gesture-pinch-state",
)

text = rep(
    text,
    """    if (pinching) {
      if (!pinchActive) {
        pinchActive = true;
        pinchPrev = pinchRatio;
      } else if (pinchPrev > 0.001 && pinchRatio > 0.001) {
        // 两指张开 → 放大；收拢 → 缩小
        const strength = (pinchRatio - pinchPrev) * 2.6;
        if (Math.abs(strength) > 0.012) {
          callbacks.onPinch?.(Math.min(0.5, Math.max(-0.5, strength)));
        }
        pinchPrev = pinchRatio;
      }""",
    """    if (pinching) {
      if (!pinchActive) {
        pinchActive = true;
        pinchPrev = pinchRatio;
        pinchPrevX = palmX;
        pinchPrevY = palmY;
      } else {
        // 捏合 + 移动 = 鼠标中键拖拽：按手掌中心位移平移 3D 摄像机
        const dx = palmX - pinchPrevX;
        const dy = palmY - pinchPrevY;
        pinchPrevX = palmX;
        pinchPrevY = palmY;
        if (Math.abs(dx) + Math.abs(dy) > 0.004) {
          callbacks.onPan?.(dx, dy);
        }
        pinchPrev = pinchRatio;
      }""",
    "gesture-pinch-pan",
)

save(p, text, crlf)

# ---------------- floatScene.ts ----------------
p = WEB / "three" / "floatScene.ts"
text, crlf = load(p)

text = rep(
    text,
    "  zoomBy(factor: number): void;",
    """  panBy(dxPixels: number, dyPixels: number): void;
  zoomBy(factor: number): void;""",
    "scene-iface-pan",
)

text = rep(
    text,
    """    zoomBy(factor) {
      zoomTarget = Math.min(2.6, Math.max(0.3, zoomTarget * factor));
    },""",
    """    panBy(dxPixels, dyPixels) {
      if (!entered) return;
      // 与鼠标中键拖拽同款数学：像素位移 → 世界平移
      panTargetX = Math.min(10, Math.max(-10, panTargetX - dxPixels * 0.0062 * zoom));
      panTargetY = Math.min(6.5, Math.max(-6.5, panTargetY + dyPixels * 0.0052 * zoom));
    },
    zoomBy(factor) {
      zoomTarget = Math.min(2.6, Math.max(0.3, zoomTarget * factor));
    },""",
    "scene-impl-pan",
)

save(p, text, crlf)

# ---------------- spaceShell.ts ----------------
p = WEB / "ui" / "spaceShell.ts"
text, crlf = load(p)

text = rep(
    text,
    """        onPinch: (strength) => {
          // strength>0 = 放大（镜头靠近）：zoom 越小离得越近，用指数映射保证手感均匀
          space?.zoomBy(Math.exp(-strength * 0.9));
        },""",
    """        onPan: (dx, dy) => {
          // 前置摄像头未镜像：手往右 → 画面 x 变小；换算成「拖动方向」的像素
          space?.panBy(-dx * 620, dy * 460);
        },
        onPinch: (strength) => {
          // strength>0 = 放大（镜头靠近）：zoom 越小离得越近，用指数映射保证手感均匀
          space?.zoomBy(Math.exp(-strength * 0.9));
        },""",
    "shell-onpan",
)

save(p, text, crlf)

print("DONE")
