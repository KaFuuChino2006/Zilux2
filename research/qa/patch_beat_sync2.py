# -*- coding: utf-8 -*-
"""节奏换色与白闪同步（第二版）：换色在鼓点当帧就开始，不再延后 1.1s"""
from pathlib import Path

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


ts = read(TS)
crlf = "\r\n"

# 1) 换色落地改回「当帧」，并把白闪一起触发（鼓点回调里也已同步）
old_commit = crlf.join(
    [
        "    // 擦到 ~83% 时把真实背景换成新配色；用平滑过渡（不要瞬间硬切）",
        "    // 白闪也放在这一帧：闪烁和换色同时发生，不再一前一后",
        "    window.setTimeout(() => {",
        "      flashBackground(Math.min(1, 0.42 + strength * 0.58), true);",
        "      applyBgColorSetting(false);",
        "    }, sweepTiming().commit);",
    ]
)
new_commit = crlf.join(
    [
        "    // 换色和擦除在同一帧开始：闪、擦、变色三件事同时发生，不会一前一后",
        "    flashBackground(Math.min(1, 0.42 + strength * 0.58), true);",
        "    applyBgColorSetting(false);",
    ]
)
ts = rep(ts, old_commit, new_commit, "commit-now")

# 2) 鼓点回调：恢复「每拍立刻白闪」，换色那一拍照常闪 + 触发擦除换色
old_beat = crlf.join(
    [
        "        space?.flashLyricColor(strength * 0.9);",
        "        // 累计换色的那一拍：白闪延后到颜色落地的瞬间，让「闪」和「换色」同步；",
        "        // 其余鼓点照常立刻白闪",
        "        const willSweep =",
        "          custom.sweep && custom.bgColor === 'rhythm' && sweepBeats + 1 >= custom.sweepEvery;",
        "        if (willSweep) {",
        "          sweepBeats = 0;",
        "          triggerColorSweep(strength);",
        "        } else {",
        "          flashBackground(strength * 0.42, true);",
        "          if (custom.sweep && custom.bgColor === 'rhythm') sweepBeats += 1;",
        "        }",
    ]
)
new_beat = crlf.join(
    [
        "        space?.flashLyricColor(strength * 0.9);",
        "        flashBackground(strength * 0.42, true);",
        "        if (custom.sweep && custom.bgColor === 'rhythm') {",
        "          sweepBeats += 1;",
        "          if (sweepBeats >= custom.sweepEvery) {",
        "            sweepBeats = 0;",
        "            triggerColorSweep(strength);",
        "          }",
        "        }",
    ]
)
ts = rep(ts, old_beat, new_beat, "beat-immediate")

write(TS, ts)
print("OK: commit-now, beat-immediate")
