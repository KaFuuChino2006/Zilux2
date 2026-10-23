# -*- coding: utf-8 -*-
"""把「累计换色」搬到背景层（不再盖住 3D/UI），效果改成带柔光边缘的擦除，并且只在「节奏」模式下生效。"""
import io, sys

ROOT = r"E:\Zilux2开发\web\src"
CSS = ROOT + r"\styles\space.css"
TS = ROOT + r"\ui\spaceShell.ts"


def load(path):
    raw = open(path, "rb").read().decode("utf-8")
    crlf = "\r\n" in raw
    return raw.replace("\r\n", "\n"), crlf


def save(path, text, crlf):
    if crlf:
        text = text.replace("\n", "\r\n")
    open(path, "wb").write(text.encode("utf-8"))


def sub(text, old, new, tag):
    n = text.count(old)
    assert n == 1, f"{tag}: expected 1 match, got {n}"
    return text.replace(old, new)


# ---------------- CSS ----------------
css, css_crlf = load(CSS)

css = sub(
    css,
    """.space-sweep {
  position: fixed;
  inset: 0;
  z-index: 88;
  pointer-events: none;
  opacity: 0;
  overflow: hidden;
}""",
    """.space-sweep {
  /* 换色动画在背景层：位于 3D canvas(z-index: 1) 之下，只擦背景，不盖磁贴 / 歌词 / UI */
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0;
  overflow: hidden;
  will-change: mask-position, opacity;
}""",
    "css-sweep-base",
)

MARK = "/* 背景换色：新配色从左擦到右（扫光 swipe 样式） */"
idx = css.index(MARK)
css = css[:idx] + """/* 背景换色（节奏模式）：新配色从左侧带柔光边缘擦到右侧，动画在底层，不遮挡 3D 与 UI */
.space-shell.is-tint-instant .space-tint,
.space-shell.is-tint-instant .space-sheen {
  transition: none !important;
}
.space-sweep.is-play.is-wipe {
  opacity: 1;
  background: var(--sweep-bg, rgba(255, 255, 255, 0.5));
  -webkit-mask-image: linear-gradient(
    97deg,
    #000 0%,
    #000 46%,
    rgba(0, 0, 0, 0.96) 54%,
    rgba(0, 0, 0, 0.72) 62%,
    rgba(0, 0, 0, 0.36) 69%,
    rgba(0, 0, 0, 0.1) 76%,
    transparent 84%,
    transparent 100%
  );
  mask-image: linear-gradient(
    97deg,
    #000 0%,
    #000 46%,
    rgba(0, 0, 0, 0.96) 54%,
    rgba(0, 0, 0, 0.72) 62%,
    rgba(0, 0, 0, 0.36) 69%,
    rgba(0, 0, 0, 0.1) 76%,
    transparent 84%,
    transparent 100%
  );
  -webkit-mask-size: 240% 100%;
  mask-size: 240% 100%;
  -webkit-mask-position: 100% 0;
  mask-position: 100% 0;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  filter: saturate(1.08) brightness(1.02);
  animation: space-sweep-wipe 1.18s cubic-bezier(0.33, 0.02, 0.19, 1) both;
}
.space-sweep.is-play.is-wipe::before {
  content: '';
  position: absolute;
  top: -34%;
  bottom: -34%;
  left: -56%;
  width: 66%;
  transform: rotate(8deg);
  background: radial-gradient(
    closest-side,
    rgba(255, 255, 255, 0.52),
    rgba(255, 255, 255, 0.18) 44%,
    rgba(255, 255, 255, 0.03) 68%,
    transparent 78%
  );
  filter: blur(36px);
  mix-blend-mode: screen;
  animation: space-sweep-wipe-crest 1.18s cubic-bezier(0.33, 0.02, 0.19, 1) both;
}
.space-sweep.is-play.is-wipe::after {
  content: '';
  position: absolute;
  top: -30%;
  bottom: -30%;
  left: -34%;
  width: 30%;
  transform: rotate(8deg) skewX(-7deg);
  background: linear-gradient(
    92deg,
    transparent 0%,
    rgba(255, 255, 255, 0.04) 34%,
    rgba(255, 255, 255, 0.34) 74%,
    rgba(255, 255, 255, 0.9) 93%,
    rgba(255, 255, 255, 0.42) 98%,
    transparent 100%
  );
  filter: blur(2.5px);
  mix-blend-mode: screen;
  animation: space-sweep-wipe-edge 1.18s cubic-bezier(0.33, 0.02, 0.19, 1) both;
}
@keyframes space-sweep-wipe {
  0% {
    -webkit-mask-position: 104% 0;
    mask-position: 104% 0;
  }
  92% {
    -webkit-mask-position: 0% 0;
    mask-position: 0% 0;
  }
  100% {
    -webkit-mask-position: 0% 0;
    mask-position: 0% 0;
  }
}
@keyframes space-sweep-wipe-crest {
  0% {
    left: -56%;
    opacity: 0;
  }
  12% {
    opacity: 0.9;
  }
  88% {
    opacity: 0.9;
  }
  100% {
    left: 104%;
    opacity: 0;
  }
}
@keyframes space-sweep-wipe-edge {
  0% {
    left: -34%;
    opacity: 0;
  }
  9% {
    opacity: 0.95;
  }
  91% {
    opacity: 0.9;
  }
  100% {
    left: 106%;
    opacity: 0;
  }
}
"""
save(CSS, css, css_crlf)
print("OK: css")

# ---------------- TS ----------------
ts, ts_crlf = load(TS)

# 1) playColorSweep: 按样式配好时长 + commitBgInstant 助手
ts = sub(
    ts,
    """  let sweepTimer = 0;
  const playColorSweep = (bg?: string): void => {
    const wipe = custom.sweepStyle === 'swipe';
    sweepLayer.className = `space-sweep is-${wipe ? 'wipe' : custom.sweepStyle}`;
    sweepLayer.style.setProperty('--sweep-bg', bg ?? 'rgba(255, 255, 255, 0.42)');
    void sweepLayer.offsetWidth;
    sweepLayer.classList.add('is-play');
    window.clearTimeout(sweepTimer);
    sweepTimer = window.setTimeout(() => {
      sweepLayer.className = 'space-sweep';
    }, 1400);
  };""",
    """  let sweepTimer = 0;
  const SWEEP_TIMING: Record<string, { commit: number; clear: number }> = {
    swipe: { commit: 980, clear: 1560 },
    fade: { commit: 760, clear: 1320 },
    ripple: { commit: 820, clear: 1380 },
    flash: { commit: 340, clear: 900 },
  };
  const sweepTiming = (): { commit: number; clear: number } =>
    SWEEP_TIMING[custom.sweepStyle] ?? SWEEP_TIMING.swipe;
  const playColorSweep = (bg?: string): void => {
    const wipe = custom.sweepStyle === 'swipe';
    sweepLayer.className = `space-sweep is-${wipe ? 'wipe' : custom.sweepStyle}`;
    sweepLayer.style.setProperty('--sweep-bg', bg ?? 'rgba(255, 255, 255, 0.42)');
    void sweepLayer.offsetWidth;
    sweepLayer.classList.add('is-play');
    window.clearTimeout(sweepTimer);
    sweepTimer = window.setTimeout(() => {
      sweepLayer.className = 'space-sweep';
    }, sweepTiming().clear);
  };
  // 换色落地的一瞬间临时关掉 tint 的 1.8s 过渡：擦除层已经盖住整屏，切换不会露馅
  const commitBgInstant = (apply: () => void): void => {
    root.classList.add('is-tint-instant');
    apply();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => root.classList.remove('is-tint-instant'));
    });
  };""",
    "ts-sweep-timing",
)

# 2) triggerColorSweep: 只在节奏模式换色
ts = sub(
    ts,
    """  const triggerColorSweep = (): void => {
    const next = gradientRandomColors();
    const tri = (cols: string[]): string =>
      `linear-gradient(118deg, ${cols[0]} 0%, ${cols[1]} 52%, ${cols[2]} 100%)`;
    const soft = (cols: string[], lift: number[]): string =>
      `radial-gradient(circle at 50% 46%, ${lighten(cols[0], lift[0])} 0%, ${lighten(cols[1], lift[1])} 52%, ${lighten(cols[2], lift[2])} 100%)`;
    if (custom.bgColor === 'gradient') {
      playColorSweep(tri(next));
      window.setTimeout(() => startGradientTransition(next, true), 800);
      return;
    }
    if (custom.bgColor === 'rhythm') {
      regenerateRhythmColors();
      const cols = rhythmColors ?? next;
      playColorSweep(soft(cols, [0.3, 0.24, 0.18]));
      window.setTimeout(() => applyBgColorSetting(true), 800);
      return;
    }
    if (custom.bgColor === 'solid') {
      custom.solidColor = next[0];
      playColorSweep(next[0]);
      window.setTimeout(() => applyBgColorSetting(true), 800);
      return;
    }
    if (custom.bgColor === 'coverTone' || custom.bgColor === 'cover') {
      tintVariant += 1;
      const cols = paletteColors ?? next;
      playColorSweep(soft(cols, [0.52, 0.44, 0.5]));
      window.setTimeout(() => applyBgColorSetting(false), 800);
      return;
    }
    // 背景关闭/纯色时也演示一次擦除，方便直接在面板里看效果
    playColorSweep(tri(next));
  };""",
    """  const triggerColorSweep = (): void => {
    // 累计换色只属于「节奏」：纯色/封面/渐变都保持用户自己选的颜色
    if (custom.bgColor !== 'rhythm') return;
    const next = gradientRandomColors();
    const soft = (cols: string[], lift: number[]): string =>
      `radial-gradient(circle at 50% 46%, ${lighten(cols[0], lift[0])} 0%, ${lighten(cols[1], lift[1])} 52%, ${lighten(cols[2], lift[2])} 100%)`;
    regenerateRhythmColors();
    tintVariant += 1;
    const cols = rhythmColors ?? next;
    playColorSweep(soft(cols, [0.3, 0.24, 0.18]));
    // 擦到 ~83% 时把真实背景一次性换到新配色（此刻整屏已被新色盖住，看不出切换）
    window.setTimeout(() => commitBgInstant(() => applyBgColorSetting(true)), sweepTiming().commit);
  };""",
    "ts-trigger-sweep",
)

# 3) 鼓点累计只在节奏模式计数
ts = sub(
    ts,
    """        if (custom.sweep) {
          sweepBeats += 1;""",
    """        if (custom.sweep && custom.bgColor === 'rhythm') {
          sweepBeats += 1;""",
    "ts-beat-guard",
)

# 4) syncCustomUi: 非节奏模式隐藏「累计换色」
ts = sub(
    ts,
    """    sweepOptions.classList.toggle('is-off', !custom.sweep);""",
    """    sweepOptions.hidden = custom.bgColor !== 'rhythm';
    sweepOptions.classList.toggle('is-off', !custom.sweep);""",
    "ts-sync-hidden",
)

# 5) 面板 tip 文案
ts = sub(
    ts,
    """<p class="custom-tip">累计到指定拍数后整屏换一次背景色；「左扫」会把新配色从左侧一路擦到右侧，显示最明显</p>""",
    """<p class="custom-tip">只在「节奏」换色下可用：累计到指定拍数后，整屏把背景擦成新配色；「左扫」是带柔光边缘的擦除，最明显</p>""",
    "ts-tip",
)

save(TS, ts, ts_crlf)
print("OK: ts")
