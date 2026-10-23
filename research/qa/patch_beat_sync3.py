# -*- coding: utf-8 -*-
"""节奏换色：不再依赖「累计换色」开关（开关只管擦除动画），颜色一定随拍更换"""
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

# 1) 鼓点里：节奏模式一定累计，不要求「累计换色」开关打开
old_beat = crlf.join(
    [
        "        if (custom.sweep && custom.bgColor === 'rhythm') {",
        "          sweepBeats += 1;",
        "          if (sweepBeats >= custom.sweepEvery) {",
        "            sweepBeats = 0;",
        "            triggerColorSweep(strength);",
        "          }",
        "        }",
    ]
)
new_beat = crlf.join(
    [
        "        // 节奏模式下颜色一定按累计拍数更换（「累计换色」开关只控制擦除动画），",
        "        // 换色与这一拍的白闪同帧发生",
        "        if (custom.bgColor === 'rhythm') {",
        "          sweepBeats += 1;",
        "          if (sweepBeats >= custom.sweepEvery) {",
        "            sweepBeats = 0;",
        "            triggerColorSweep(strength);",
        "          }",
        "        }",
    ]
)
ts = rep(ts, old_beat, new_beat, "beat-no-toggle-gate")

# 2) 擦除动画仅在开关打开时播放，颜色照常换
old_play = "    playColorSweep(soft(cols, [0.3, 0.24, 0.18]));"
new_play = "    if (custom.sweep) playColorSweep(soft(cols, [0.3, 0.24, 0.18]));"
ts = rep(ts, old_play, new_play, "sweep-optional")

# 3) 节奏模式的零散随机换色彻底停掉：只保留「累计拍数」这一条换色路径
old_eval = crlf.join(
    [
        "  function evaluateRhythmTint(): void {",
        "    if (custom.bgColor !== 'rhythm') return;",
        "    // 累计换色开启时，颜色只由「累计 N 拍擦一次」来换；",
        "    // 否则鼓点会再随机重绘一套色，看起来就是“擦完又变回原来那个灰的”",
        "    if (custom.sweep) return;",
    ]
)
new_eval = crlf.join(
    [
        "  function evaluateRhythmTint(): void {",
        "    // 节奏换色只由「累计 N 拍」触发（和白闪同帧）；这里不再随机重绘，",
        "    // 否则会出现擦完又被随机色覆盖、换色和白闪对不上的情况",
        "    if (custom.bgColor === 'rhythm') return;",
    ]
)
ts = rep(ts, old_eval, new_eval, "stop-random-rhythm")

write(TS, ts)
print("OK: beat-no-toggle-gate, sweep-optional, stop-random-rhythm")
