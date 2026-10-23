import io
import sys
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
target = ROOT / "web" / "src" / "ui" / "spaceShell.ts"
text = target.read_text(encoding="utf-8")
orig = text
steps = []


def rep(name, old, new, count=1):
    global text
    if old not in text:
        print(f"FAIL: {name}: not found")
        sys.exit(1)
    if text.count(old) != count:
        print(f"FAIL: {name}: expected {count} occurrence(s), got {text.count(old)}")
        sys.exit(1)
    text = text.replace(old, new)
    steps.append(name)


# 1) paintTint：节奏模式允许只靠 rhythmColors 上色，不再被封面调色板卡住
rep(
    "tint-colors",
    """    const colors = paletteColors;
    if (!colors) return;
    // 节奏模式使用随机生成的色组（否则会和「封面」模式看起来一样）
    const palette =
      custom.bgColor === 'rhythm' && rhythmColors ? rhythmColors : colors;""",
    """    // 节奏模式使用随机生成的色组（否则会和「封面」模式看起来一样）；
    // 即使封面调色板还没就绪，节奏模式也要能立刻上色，不能保持全黑
    const colors =
      custom.bgColor === 'rhythm' ? rhythmColors ?? paletteColors : paletteColors;
    if (!colors) return;
    const palette = colors;""",
)

# 2) applyBgColorSetting：节奏模式不依赖封面调色板
rep(
    "bg-rhythm-early-return",
    """    if (!paletteColors) return;
    if (custom.bgColor === 'rhythm' && !rhythmColors) regenerateRhythmColors();""",
    """    if (custom.bgColor === 'rhythm') {
      // 节奏模式自己有配色，封面调色板没就绪也能先上色
      if (!rhythmColors) regenerateRhythmColors();
    } else if (!paletteColors) {
      return;
    }""",
)

# 3) 暂停/抓不到音频帧时也慢慢换色，不要卡在一个颜色上
rep(
    "rhythm-chance",
    """    // 能量越高越容易换；如果这台机器抓不到音频帧（level 恒 0），播放中也按较低概率缓慢换色
    const chance = level > 0.001 ? 0.02 + level * 0.04 : colorPlaying ? 0.015 : 0;""",
    """    // 能量越高越容易换；抓不到音频帧（level 恒 0）或暂停时也给底噪概率，
    // 否则选「节奏」后背景会一直停在一个颜色上（看起来像黑的）
    const chance = level > 0.001 ? 0.02 + level * 0.04 : colorPlaying ? 0.06 : 0.25;""",
)

# 4) 节奏模式兜底定时器：没有音频帧也按固定节拍缓慢换色
rep(
    "rhythm-idle-timer",
    """    paletteOf(cover);
    onAudioFrame((frame) => {""",
    """    paletteOf(cover);
    // 节奏模式兜底：宿主没推音频帧（未播放/暂停/抓不到）时也按节拍缓慢换色
    window.setInterval(() => {
      if (custom.bgColor === 'rhythm') evaluateRhythmTint();
    }, 1200);
    onAudioFrame((frame) => {""",
)

target.write_text(text, encoding="utf-8")
print("OK:", ", ".join(steps), f"(delta {len(text) - len(orig)} chars)")
