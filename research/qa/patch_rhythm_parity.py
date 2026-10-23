# -*- coding: utf-8 -*-
"""节奏换色：擦除层移到歌词暗化层之上；歌词模式不再整体压黑；换色落地时机对齐动画
用户反馈（m05140）：磁贴墙看是纯硬切、进歌词后整屏变暗，两边差别太大。
"""
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
TS = ROOT / "web/src/ui/spaceShell.ts"
CSS = ROOT / "web/src/styles/space.css"
CRLF = "\r\n"


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

# 1) 把 .space-sweep 从 flash 之后挪到 lyrics-dim 之后：同为 z-index:0 时靠 DOM 顺序叠放，
#    这样擦除层在歌词模式也盖在暗化层之上，两种视图看到的换色动画一致。
ts = rep(
    ts,
    '    <div class="space-flash" data-space-flash></div>' + CRLF
    + '    <div class="space-sweep" data-space-sweep></div>' + CRLF
    + '    <canvas class="space-spectrum" data-spectrum width="720" height="128" hidden></canvas>' + CRLF
    + '    <div class="lyrics-dim" data-lyrics-dim></div>',
    '    <div class="space-flash" data-space-flash></div>' + CRLF
    + '    <canvas class="space-spectrum" data-spectrum width="720" height="128" hidden></canvas>' + CRLF
    + '    <div class="lyrics-dim" data-lyrics-dim></div>' + CRLF
    + '    <div class="space-sweep" data-space-sweep></div>',
    "dom-sweep",
)

# 2) 换色落地时间对齐擦拭动画（CSS 1.18s，92% 时整屏已被新色覆盖）
ts = rep(
    ts,
    "    swipe: { commit: 980, clear: 1560 },",
    "    swipe: { commit: 1120, clear: 1780 },",
    "sweep-timing",
)

# 3) 节奏模式下打个标记，供 CSS 减弱歌词暗化层
ts = rep(
    ts,
    "    root.classList.toggle('is-tint-on', custom.bgColor === 'rhythm' || custom.bgColor === 'cover');",
    "    root.classList.toggle('is-tint-on', custom.bgColor === 'rhythm' || custom.bgColor === 'cover');" + CRLF
    + "    root.classList.toggle('is-rhythm-bg', custom.bgColor === 'rhythm');",
    "rhythm-flag",
)
write(TS, ts)

# 4) CSS：歌词模式在节奏换色下只轻微压暗，让背景颜色继续可见
css = read(CSS)
css += CRLF.join(
    [
        "",
        "/* 节奏换色 + 歌词模式：只轻微压暗，保留背景颜色；擦除层在其上方（DOM 顺序） */",
        ".space-shell.is-rhythm-bg .lyrics-dim {",
        "  background: radial-gradient(circle at 50% 46%, rgba(2, 3, 6, 0.42), rgba(0, 0, 0, 0.62));",
        "}",
        ".space-shell.is-rhythm-bg .lyrics-dim.is-on {",
        "  opacity: 1;",
        "}",
        "",
    ]
)
write(CSS, css)
print("OK: dom-sweep, sweep-timing, rhythm-flag, css")
