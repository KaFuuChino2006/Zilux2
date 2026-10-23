# -*- coding: utf-8 -*-
"""让「累计换色」能被立刻看到：换色样式按钮点击即刻演示一次擦除；
背景换色为「关闭/纯色」时也播放擦除动画（只演示、不改背景色）。"""
import io, sys

PATH = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"

with io.open(PATH, "r", encoding="utf-8", newline="") as f:
    raw = f.read()

nl = "\r\n" if "\r\n" in raw else "\n"
text = raw

def rep(old, new, name):
    global text
    n = text.count(old)
    assert n == 1, "%s: matched %d" % (name, n)
    text = text.replace(old, new)
    print("OK:", name)

# 1) 覆盖 coverTone 分支后补一个兜底：其它背景模式下也演示一次擦除
old_tail = nl.join([
    "      playColorSweep(soft(cols, [0.52, 0.44, 0.5]));",
    "      window.setTimeout(() => applyBgColorSetting(false), 800);",
    "    }",
    "  };",
])
new_tail = nl.join([
    "      playColorSweep(soft(cols, [0.52, 0.44, 0.5]));",
    "      window.setTimeout(() => applyBgColorSetting(false), 800);",
    "      return;",
    "    }",
    "    // 背景关闭/纯色时也演示一次擦除，方便直接在面板里看效果",
    "    playColorSweep(tri(next));",
    "  };",
])
rep(old_tail, new_tail, "sweep-fallback")

# 2) 点「累计换色 开」立刻演示一次
old_on = nl.join([
    "      custom.sweep = button.dataset.sweep === '1';",
    "      syncCustomUi();",
    "      persistCustom();",
    "    });",
    "  });",
])
new_on = nl.join([
    "      custom.sweep = button.dataset.sweep === '1';",
    "      syncCustomUi();",
    "      persistCustom();",
    "      if (custom.sweep) triggerColorSweep();",
    "    });",
    "  });",
])
rep(old_on, new_on, "sweep-on-demo")

# 3) 点换色样式按钮立刻按该样式演示一次
old_style = nl.join([
    "      syncCustomUi();",
    "      persistCustom();",
    "    });",
    "  });",
    "  spectrumBtns.forEach((button) => {",
])
new_style = nl.join([
    "      syncCustomUi();",
    "      persistCustom();",
    "      triggerColorSweep();",
    "    });",
    "  });",
    "  spectrumBtns.forEach((button) => {",
])
rep(old_style, new_style, "sweep-style-demo")

with io.open(PATH, "w", encoding="utf-8", newline="") as f:
    f.write(text)
print("WROTE", PATH)
