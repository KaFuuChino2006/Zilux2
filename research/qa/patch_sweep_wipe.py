# -*- coding: utf-8 -*-
"""背景换色扫光改为「新配色从左擦到右」的整屏擦除 + 歌词节奏模式 TS 修正。"""
from pathlib import Path

SS = Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")
CSS = Path(r"E:\Zilux2开发\web\src\styles\space.css")
t = SS.read_text(encoding="utf-8")
c = CSS.read_text(encoding="utf-8")
n = 0

# 1) playColorSweep：支持传入新配色 + 擦除样式
old = """  const playColorSweep = (): void => {
    sweepLayer.className = `space-sweep is-${custom.sweepStyle}`;
    void sweepLayer.offsetWidth;
    sweepLayer.classList.add('is-play');
  };"""
new = """  let sweepTimer = 0;
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
  };"""
assert t.count(old) == 1
t = t.replace(old, new); n += 1

# 2) triggerColorSweep：先算新配色 → 整屏擦除 → 擦完再落地背景色
old = """  const triggerColorSweep = (): void => {
    playColorSweep();
    const next = gradientRandomColors();
    if (custom.bgColor === 'gradient') {
      startGradientTransition(next, false);
    } else if (custom.bgColor === 'rhythm') {
      regenerateRhythmColors();
      applyBgColorSetting(false);
    } else if (custom.bgColor === 'solid') {
      custom.solidColor = next[0];
      applyBgColorSetting(false);
    } else if (custom.bgColor === 'coverTone' || custom.bgColor === 'cover') {
      tintVariant += 1;
      applyBgColorSetting(false);
    }
  };"""
new = """  const triggerColorSweep = (): void => {
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
    }
  };"""
assert t.count(old) == 1
t = t.replace(old, new); n += 1

# 3) 歌词节奏：用时间闸门读掉 lastLyricRhythmAt（同时避免同帧重复触发）
old = """        if (custom.lyricColor === 'rhythm') {
          lyricRhythmStep += 1;"""
new = """        if (custom.lyricColor === 'rhythm' && now - lastLyricRhythmAt > 90) {
          lyricRhythmStep += 1;"""
assert t.count(old) == 1
t = t.replace(old, new); n += 1

# 4) 扫光样式文案
old = "  const SWEEP_LABEL: Record<string, string> = { swipe: '扫光', fade: '淡变', ripple: '波纹', flash: '闪白' };"
new = "  const SWEEP_LABEL: Record<string, string> = { swipe: '左扫', fade: '淡变', ripple: '波纹', flash: '闪白' };"
assert t.count(old) == 1
t = t.replace(old, new); n += 1

# 5) 追加擦除动画 CSS
css_add = """

/* 背景换色：新配色从左擦到右（扫光 swipe 样式） */
.space-sweep.is-play.is-wipe {
  opacity: 1;
  background: var(--sweep-bg, rgba(255, 255, 255, 0.5));
  animation: space-sweep-wipe 0.92s cubic-bezier(0.42, 0, 0.2, 1) both;
}
.space-sweep.is-play.is-wipe::after {
  content: '';
  position: absolute;
  top: -8%;
  bottom: -8%;
  left: -28%;
  width: 28%;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, 0.22) 48%,
    rgba(255, 255, 255, 0.58) 84%,
    rgba(255, 255, 255, 0.92) 100%
  );
  filter: blur(1.5px);
  animation: space-sweep-wipe-edge 0.92s cubic-bezier(0.42, 0, 0.2, 1) both;
}
@keyframes space-sweep-wipe {
  0% { clip-path: inset(0 100% 0 0); }
  88% { clip-path: inset(0 0 0 0); }
  100% { clip-path: inset(0 0 0 0); }
}
@keyframes space-sweep-wipe-edge {
  0% { left: -28%; opacity: 0.95; }
  88% { left: 100%; opacity: 0.85; }
  100% { left: 100%; opacity: 0; }
}
"""
c = c.rstrip() + css_add
n += 1

SS.write_text(t, encoding="utf-8")
CSS.write_text(c + "\n", encoding="utf-8")
print("OK steps:", n)
