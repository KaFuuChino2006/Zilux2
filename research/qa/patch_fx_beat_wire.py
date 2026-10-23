# -*- coding: utf-8 -*-
"""背景粒子跟随鼓点：暴露 pulseBgFx 接口，并在鼓点检测处调用（不受鼓点特效开关限制）。"""
import io, sys

SCENE = r"E:\Zilux2开发\web\src\three\floatScene.ts"
SHELL = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"


def read(p):
    with io.open(p, "r", encoding="utf-8") as f:
        return f.read()


def write(p, s):
    with io.open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)


def rep(text, old, new, count=1):
    n = text.count(old)
    if n != count:
        sys.stderr.write("MISMATCH count=%d expected=%d\n---\n%s\n" % (n, count, old[:600]))
        raise SystemExit(1)
    return text.replace(old, new)


scene = read(SCENE)

# 1) handle 接口新增 pulseBgFx
scene = rep(
    scene,
    "  triggerBeatEffect(kind: 'ring' | 'firework', intensity: number, colors?: string[]): void;",
    "  triggerBeatEffect(kind: 'ring' | 'firework', intensity: number, colors?: string[]): void;\n"
    "  pulseBgFx(intensity: number): void;",
)

# 2) handle 实现
scene = rep(
    scene,
    "    triggerBeatEffect(kind, intensity, colors) {\n"
    "      triggerBeatEffectInternal(kind, intensity, colors);\n"
    "    },",
    "    triggerBeatEffect(kind, intensity, colors) {\n"
    "      triggerBeatEffectInternal(kind, intensity, colors);\n"
    "    },\n"
    "    pulseBgFx(intensity) {\n"
    "      bgFxBeat = Math.max(bgFxBeat, Math.min(1.3, 0.4 + intensity * 0.95));\n"
    "      bgFxBurst = Math.max(bgFxBurst, 0.55 + intensity * 1.15);\n"
    "    },",
)

write(SCENE, scene)

shell = read(SHELL)

# 3) 鼓点检测处调用：粒子始终跟随鼓点
shell = rep(
    shell,
    "        const strength = Math.min(1, 0.22 + Math.max(0, Math.min(1, bass)) * 0.78);\n"
    "        space?.flashLyricColor(strength * 0.9);\n"
    "        flashBackground(strength * 0.42);",
    "        const strength = Math.min(1, 0.22 + Math.max(0, Math.min(1, bass)) * 0.78);\n"
    "        space?.flashLyricColor(strength * 0.9);\n"
    "        flashBackground(strength * 0.42);\n"
    "        // 背景 3D 粒子同步响应鼓点（与「鼓点特效」开关无关）\n"
    "        space?.pulseBgFx(0.45 + strength * 0.75);",
)

write(SHELL, shell)
print("FX-BEAT-WIRE-OK")
