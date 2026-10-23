"""手势：捏合方向修正 + 张开手掌远近控制缩放（手掌越大=越靠近镜头=放大）。"""
import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")


def edit(rel, steps):
    path = ROOT / rel
    raw = io.open(path, "r", encoding="utf-8", newline="").read()
    nl = "\r\n" if "\r\n" in raw else "\n"
    t = raw.replace("\r\n", "\n")
    for label, old, new in steps:
        got = t.count(old)
        if got == 0 and new and new in t:
            print("SKIP(already):", label)
            continue
        if got != 1:
            raise SystemExit(f"FAIL {label}: count={got}")
        t = t.replace(old, new)
        print("OK:", label)
    io.open(path, "w", encoding="utf-8", newline="").write(t.replace("\n", nl))


edit(
    "web/src/ui/gesture.ts",
    [
        # 1) 回调语义：捏合/远近统一为「缩放强度」，正数=放大（靠近）
        (
            "gesture-callback-doc",
            "  /** 捏合缩放：scale 为相邻两帧的距离比值，>1 放大、<1 缩小 */\n"
            "  onPinch?: (scale: number) => void;",
            "  /**\n"
            "   * 缩放强度：正数表示放大（镜头靠近），负数表示缩小（远离）。\n"
            "   * 来自两处：拇指+食指捏合张合、张开手掌的前后远近（手掌越大=越靠近镜头）。\n"
            "   */\n"
            "  onPinch?: (strength: number) => void;",
        ),
        # 2) 新增手掌远近状态
        (
            "gesture-state",
            "  let pinchActive = false;\n  let pinchPrev = 1;",
            "  let pinchActive = false;\n"
            "  let pinchPrev = 1;\n"
            "  // 张开手掌时的掌宽（腕点→中指根），用于按「手离镜头远近」缩放\n"
            "  let palmPrev = 0;\n"
            "  let palmSeenAt = 0;",
        ),
        # 3) 捏合方向修正（张开=放大），并累计手掌远近
        (
            "gesture-pinch",
            "    if (pinching) {\n"
            "      if (!pinchActive) {\n"
            "        pinchActive = true;\n"
            "        pinchPrev = pinchRatio;\n"
            "      } else if (pinchPrev > 0.001 && pinchRatio > 0.001) {\n"
            "        const scale = pinchPrev / pinchRatio;\n"
            "        if (Math.abs(scale - 1) > 0.004) {\n"
            "          callbacks.onPinch?.(Math.min(1.12, Math.max(0.9, scale)));\n"
            "        }\n"
            "        pinchPrev = pinchRatio;\n"
            "      }\n"
            "      fistFrames = 0;\n"
            "      openFrames = 0;\n"
            "      xHistory = [];\n"
            "      return;\n"
            "    }",
            "    if (pinching) {\n"
            "      if (!pinchActive) {\n"
            "        pinchActive = true;\n"
            "        pinchPrev = pinchRatio;\n"
            "      } else if (pinchPrev > 0.001 && pinchRatio > 0.001) {\n"
            "        // 两指张开 → 放大；收拢 → 缩小\n"
            "        const strength = (pinchRatio - pinchPrev) * 2.6;\n"
            "        if (Math.abs(strength) > 0.012) {\n"
            "          callbacks.onPinch?.(Math.min(0.5, Math.max(-0.5, strength)));\n"
            "        }\n"
            "        pinchPrev = pinchRatio;\n"
            "      }\n"
            "      fistFrames = 0;\n"
            "      openFrames = 0;\n"
            "      xHistory = [];\n"
            "      return;\n"
            "    }",
        ),
        # 4) 张开手掌：按掌宽变化缩放（手往前伸=掌宽变大=放大）
        (
            "gesture-palm-zoom",
            "    if (openLike) {\n"
            "      openFrames += 1;\n"
            "      xHistory.push({ x: palmX, t });",
            "    if (openLike) {\n"
            "      openFrames += 1;\n"
            "      // 手掌远近缩放：掌宽变大说明手更靠近镜头 → 放大；变小则缩小\n"
            "      if (palmPrev > 0.001 && t - palmSeenAt < 260) {\n"
            "        const ratio = handSize / palmPrev;\n"
            "        if (Math.abs(ratio - 1) > 0.012 && t - lastSwipeAt > 220) {\n"
            "          callbacks.onPinch?.(Math.min(0.45, Math.max(-0.45, (ratio - 1) * 2.2)));\n"
            "        }\n"
            "      }\n"
            "      palmPrev = palmPrev > 0.001 && t - palmSeenAt < 260 ? palmPrev * 0.72 + handSize * 0.28 : handSize;\n"
            "      palmSeenAt = t;\n"
            "      xHistory.push({ x: palmX, t });",
        ),
        # 5) 没看到手时清空手掌基准
        (
            "gesture-reset",
            "      handSeen = false;\n"
            "      pinchActive = false;\n"
            "      fistFrames = 0;",
            "      handSeen = false;\n"
            "      pinchActive = false;\n"
            "      palmPrev = 0;\n"
            "      fistFrames = 0;",
        ),
    ],
)

edit(
    "web/src/ui/spaceShell.ts",
    [
        (
            "shell-zoom-map",
            "        onPinch: (scale) => {\n          space?.zoomBy(scale);\n        },",
            "        onPinch: (strength) => {\n"
            "          // strength>0 = 放大（镜头靠近）：zoom 越小离得越近，用指数映射保证手感均匀\n"
            "          space?.zoomBy(Math.exp(-strength * 0.9));\n"
            "        },",
        ),
    ],
)
print("DONE")
