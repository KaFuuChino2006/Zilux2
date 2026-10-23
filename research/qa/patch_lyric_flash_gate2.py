# -*- coding: utf-8 -*-
"""关掉「鼓点闪烁」后，歌词不再有任何随鼓点亮度/白光变化：
1) 换色柔光 flashLyricColor 也受开关控制；
2) 传给歌词 shader 的音频能量按开关归零（节奏配色模式下 uEnergy 会逐拍脉动亮度）。
"""
import io
import sys
from pathlib import Path

TARGETS = [Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")]
NL = "\r\n"


def load(path):
    return io.open(str(path), encoding="utf-8", newline="").read()


def save(path, text):
    io.open(str(path), "w", encoding="utf-8", newline="").write(text)


text = load(TARGETS[0])
if "\r\n" not in text:
    NL = "\n"


def rep(name, old, new, count=1):
    global text
    old = old.replace("\n", NL)
    new = new.replace("\n", NL)
    got = text.count(old)
    if got != count:
        print(f"FAIL {name}: count={got} expect={count}")
        sys.exit(1)
    text = text.replace(old, new)
    print(f"OK: {name}")


# 1) 换色柔光同样受开关与强度控制
rep(
    "tint-flash-gate",
    """    if (colorPlaying) space?.flashLyricColor();
""",
    """    if (colorPlaying && custom.lyricFlash) space?.flashLyricColor(custom.lyricFlashStrength / 100);
""",
)

# 2) 音频能量归零：关掉闪烁后歌词不随鼓点脉动
rep(
    "energy-gate",
    """        space?.setAudioEnergy(frame.level);
""",
    """        space?.setAudioEnergy(custom.lyricFlash ? frame.level : 0);
""",
)

save(TARGETS[0], text)
print("WROTE", TARGETS[0])
