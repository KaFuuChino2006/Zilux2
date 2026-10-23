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


# 1) 节奏色组本身加深加饱和：原来 lightness 74-82 再被 paintTint 提亮，几乎就是白色
rep(
    "rhythm-colors-vivid",
    """    const sat = 52 + Math.random() * 22;
    const light = 74 + Math.random() * 8;""",
    """    const sat = 60 + Math.random() * 24;
    const light = 54 + Math.random() * 10;""",
)

# 2) 节奏模式提亮幅度比「封面」小很多，否则会被提成纯白
rep(
    "tint-lift-by-mode",
    """    const palette = colors;
    const [c0, c1, c2] = [lighten(palette[0], 0.62), lighten(palette[1], 0.58), lighten(palette[2], 0.66)];""",
    """    const palette = colors;
    const lift = custom.bgColor === 'rhythm' ? [0.3, 0.24, 0.36] : [0.62, 0.58, 0.66];
    const [c0, c1, c2] = [
      lighten(palette[0], lift[0]),
      lighten(palette[1], lift[1]),
      lighten(palette[2], lift[2]),
    ];""",
)

# 3) 选中「节奏」时立刻生成一组新色再上色，避免沿用上一次（可能是很浅的旧色）
rep(
    "rhythm-fresh-on-select",
    """      syncCustomUi();
      applyBgColorSetting(true);
      persistCustom();
    });
  });
  solidColorInput.addEventListener('input', () => {""",
    """      if (custom.bgColor === 'rhythm') {
        regenerateRhythmColors();
        tintVariant += 1;
      }
      syncCustomUi();
      applyBgColorSetting(true);
      persistCustom();
    });
  });
  solidColorInput.addEventListener('input', () => {""",
)

target.write_text(text, encoding="utf-8")
print("OK:", ", ".join(steps), f"(delta {len(text) - len(orig)} chars)")
