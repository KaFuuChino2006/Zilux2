# -*- coding: utf-8 -*-
"""节奏换色转场：擦除层提到 3D 画布之上（仍在 UI 之下）+ 落地用平滑过渡而非硬切"""
from pathlib import Path

CSS = Path(r"E:\Zilux2开发\web\src\styles\space.css")
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


css = read(CSS)
crlf = "\r\n"

old_rule = crlf.join(
    [
        "/* 累计拍数换色：整屏扫光层（四种样式） */",
        ".space-sweep {",
        "  /* 换色动画在背景层：位于 3D canvas(z-index: 1) 之下，只擦背景，不盖磁贴 / 歌词 / UI */",
        "  position: absolute;",
        "  inset: 0;",
        "  z-index: 0;",
    ]
)
new_rule = crlf.join(
    [
        "/* 累计拍数换色：整屏扫光层（四种样式） */",
        ".space-sweep {",
        "  /* 位于 3D canvas(z-index: 1) 之上、所有 UI(z-index >= 3) 之下：",
        "     整屏都能看到擦除转场，又不会盖住设置面板 / 播放条 / 侧栏 */",
        "  position: absolute;",
        "  inset: 0;",
        "  z-index: 2;",
    ]
)
css = rep(css, old_rule, new_rule, "sweep-z")
write(CSS, css)

ts = read(TS)

# 1) 擦除层配色半透明，能看见底下的磁贴，不会整块糊住
old_soft = crlf.join(
    [
        "    const soft = (cols: string[], lift: number[]): string =>",
        "      `radial-gradient(circle at 50% 46%, ${lighten(cols[0], lift[0])} 0%, ${lighten(cols[1], lift[1])} 52%, ${lighten(cols[2], lift[2])} 100%)`;",
    ]
)
new_soft = crlf.join(
    [
        "    const soft = (cols: string[], lift: number[]): string =>",
        "      `radial-gradient(circle at 50% 46%, ${withAlpha(lighten(cols[0], lift[0]), 0.78)} 0%, ${withAlpha(lighten(cols[1], lift[1]), 0.64)} 52%, ${withAlpha(lighten(cols[2], lift[2]), 0.52)} 100%)`;",
    ]
)
ts = rep(ts, old_soft, new_soft, "sweep-soft")

# 2) 落地改平滑：tint 两层交叉淡入（原来临时关掉过渡 -> 硬切，看起来"没有转场动画"）
old_commit = crlf.join(
    [
        "    // 擦到 ~83% 时把真实背景一次性换到新配色（此刻整屏已被新色盖住，看不出切换）",
        "    window.setTimeout(() => commitBgInstant(() => applyBgColorSetting(true)), sweepTiming().commit);",
    ]
)
new_commit = crlf.join(
    [
        "    // 擦到 ~83% 时把真实背景换成新配色；用平滑过渡（不要瞬间硬切）",
        "    window.setTimeout(() => applyBgColorSetting(false), sweepTiming().commit);",
    ]
)
ts = rep(ts, old_commit, new_commit, "sweep-commit")

# 3) 删掉不再使用的 commitBgInstant（否则 TS6133）
old_fn = crlf.join(
    [
        "  // 换色落地的一瞬间临时关掉 tint 的 1.8s 过渡：擦除层已经盖住整屏，切换不会露馅",
        "  const commitBgInstant = (apply: () => void): void => {",
        "    root.classList.add('is-tint-instant');",
        "    apply();",
        "    window.requestAnimationFrame(() => {",
        "      window.requestAnimationFrame(() => root.classList.remove('is-tint-instant'));",
        "    });",
        "  };",
    ]
)
ts = rep(ts, old_fn, "", "drop-commit-fn")

write(TS, ts)
print("OK: sweep-z, sweep-soft, sweep-commit, drop-commit-fn")
