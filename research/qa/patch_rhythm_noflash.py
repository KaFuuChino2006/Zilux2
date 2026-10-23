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
        print(f"FAIL: {name}: expected {count}, got {text.count(old)}")
        sys.exit(1)
    text = text.replace(old, new)
    steps.append(name)


# 1) 记录上一次节奏换色时间
rep(
    "last-rhythm-paint",
    "  let tintLockUntil = 0;",
    "  let tintLockUntil = 0;\n  let lastRhythmPaint = 0;",
)

# 2) 节奏换色不再整屏白闪，只做柔和交叉淡入
rep(
    "rhythm-no-flash",
    """    tintVariant += 1;
    regenerateRhythmColors();
    applyBgColorSetting(false);
    // 换色过渡：文字先瞬间变白再淡入新色，背景白闪后晕开新色
    space?.flashLyricColor();
    flashBackground();
    applyLyricColorSetting();""",
    """    tintVariant += 1;
    regenerateRhythmColors();
    applyBgColorSetting(false);
    lastRhythmPaint = now;
    // 换色只做柔和交叉淡入，不再整屏白闪（白闪只由「鼓点白闪」设置控制）
    if (colorPlaying) space?.flashLyricColor();
    applyLyricColorSetting();""",
)

# 3) 兜底定时器：只在未播放时慢慢换色（不闪），播放中由鼓点驱动
rep(
    "rhythm-idle-gate",
    """    // 节奏模式兜底：宿主没推音频帧（未播放/暂停/抓不到）时也按节拍缓慢换色
    window.setInterval(() => {
      if (custom.bgColor === 'rhythm') evaluateRhythmTint();
    }, 1200);""",
    """    // 节奏模式兜底：只在没播放时慢慢换一档颜色，且不做白闪；播放中交给鼓点驱动
    window.setInterval(() => {
      if (custom.bgColor !== 'rhythm' || colorPlaying) return;
      const now = performance.now();
      if (now - lastRhythmPaint < 7000) return;
      lastRhythmPaint = now;
      tintVariant += 1;
      regenerateRhythmColors();
      applyBgColorSetting(false);
    }, 1200);""",
)

target.write_text(text, encoding="utf-8")
print("OK:", ", ".join(steps), f"(delta {len(text) - len(orig)} chars)")
