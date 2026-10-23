# -*- coding: utf-8 -*-
"""新增「歌词鼓点闪烁」控件：开关 + 强度滑条。"""
import io
import sys
from pathlib import Path

TARGET = Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")
text = io.open(str(TARGET), encoding="utf-8", newline="").read()
NL = "\r\n" if "\r\n" in text else "\n"


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


# 1) HTML：插在「文字发光/每字随机/间距」这一组之后
rep(
    "html",
    """                <p class="custom-tip">辉光：字形外圈的柔光晕；大小随机：每个字大小略有差异；位置偏差：每个字上下左右轻微错位；间距：字与字的间隔（100% 为默认）</p>
              </div>
""",
    """                <p class="custom-tip">辉光：字形外圈的柔光晕；大小随机：每个字大小略有差异；位置偏差：每个字上下左右轻微错位；间距：字与字的间隔（100% 为默认）</p>
              </div>
              <div class="custom-field">
                <div class="custom-label"><span>鼓点闪烁</span><b data-lyric-flash-current>开</b></div>
                <div class="custom-seg" data-lyric-flash-seg>
                  <button class="custom-seg-btn" data-lyric-flash="off" type="button">关</button>
                  <button class="custom-seg-btn is-on" data-lyric-flash="on" type="button">开</button>
                </div>
                <div class="custom-label"><span>闪烁强度</span><b data-lyric-flash-strength-current>90%</b></div>
                <input class="custom-slider" data-lyric-flash-strength type="range" min="0" max="100" step="1" value="90" aria-label="歌词鼓点闪烁强度" />
                <p class="custom-tip">每个鼓点让当前这句歌词整体亮一下（颜色向白色偏移 + 亮度提升）；关掉后歌词不再随鼓点闪，只保留颜色与进度变化</p>
              </div>
""",
)

# 2) 查询
rep(
    "query",
    """  const lyricTrackingInput = root.querySelector<HTMLInputElement>('[data-lyric-tracking]')!;
  const lyricTrackingCurrent = root.querySelector<HTMLElement>('[data-lyric-tracking-current]')!;
""",
    """  const lyricTrackingInput = root.querySelector<HTMLInputElement>('[data-lyric-tracking]')!;
  const lyricTrackingCurrent = root.querySelector<HTMLElement>('[data-lyric-tracking-current]')!;
  const lyricFlashBtns = root.querySelectorAll<HTMLButtonElement>('[data-lyric-flash]');
  const lyricFlashCurrent = root.querySelector<HTMLElement>('[data-lyric-flash-current]')!;
  const lyricFlashStrengthInput = root.querySelector<HTMLInputElement>('[data-lyric-flash-strength]')!;
  const lyricFlashStrengthCurrent = root.querySelector<HTMLElement>('[data-lyric-flash-strength-current]')!;
""",
)

# 3) 默认值
rep(
    "default",
    """    lyricFont: '',
    lyricGlow: 55,
""",
    """    lyricFont: '',
    lyricGlow: 55,
    lyricFlash: true,
    lyricFlashStrength: 90,
""",
)

# 4) Partial 类型
rep(
    "partial",
    """        lyricGlow?: unknown;
        lyricsScale?: unknown;
""",
    """        lyricGlow?: unknown;
        lyricFlash?: unknown;
        lyricFlashStrength?: unknown;
        lyricsScale?: unknown;
""",
)

# 5) loadCustom 解析
rep(
    "load",
    """        lyricGlow: clampUnit(parsed.lyricGlow, DEFAULT_CUSTOM.lyricGlow, 0, 100),
""",
    """        lyricGlow: clampUnit(parsed.lyricGlow, DEFAULT_CUSTOM.lyricGlow, 0, 100),
        lyricFlash: parsed.lyricFlash !== false,
        lyricFlashStrength: clampUnit(parsed.lyricFlashStrength, DEFAULT_CUSTOM.lyricFlashStrength, 0, 100),
""",
)

# 6) syncCustomUi
rep(
    "sync",
    """    lyricTrackingInput.value = String(custom.lyricTracking);
    lyricTrackingCurrent.textContent = `${custom.lyricTracking}%`;
""",
    """    lyricTrackingInput.value = String(custom.lyricTracking);
    lyricTrackingCurrent.textContent = `${custom.lyricTracking}%`;
    lyricFlashBtns.forEach((button) => {
      button.classList.toggle('is-on', (button.dataset.lyricFlash === 'on') === custom.lyricFlash);
    });
    lyricFlashCurrent.textContent = custom.lyricFlash ? '开' : '关';
    lyricFlashStrengthInput.value = String(custom.lyricFlashStrength);
    lyricFlashStrengthCurrent.textContent = `${custom.lyricFlashStrength}%`;
""",
)

# 7) 事件
rep(
    "handlers",
    """  lyricSizeJitterInput.addEventListener('input', () => {
""",
    """  lyricFlashBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.lyricFlash = button.dataset.lyricFlash === 'on';
      syncCustomUi();
      persistCustom();
    });
  });
  lyricFlashStrengthInput.addEventListener('input', () => {
    custom.lyricFlashStrength = Math.min(100, Math.max(0, Math.round(Number(lyricFlashStrengthInput.value) || 0)));
    lyricFlashStrengthCurrent.textContent = `${custom.lyricFlashStrength}%`;
    persistCustom();
  });
  lyricSizeJitterInput.addEventListener('input', () => {
""",
)

# 8) 鼓点回调：读取开关与强度
rep(
    "beat",
    """        space?.flashLyricColor(strength * 0.9);
""",
    """        if (custom.lyricFlash) space?.flashLyricColor(strength * (custom.lyricFlashStrength / 100));
""",
)

io.open(str(TARGET), "w", encoding="utf-8", newline="").write(text)
print("WROTE", TARGET)
