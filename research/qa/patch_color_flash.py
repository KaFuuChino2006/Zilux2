# -*- coding: utf-8 -*-
"""鼓点换色过渡：文字瞬间变白再淡入新色；背景白闪后晕开新色。"""
import io

fs_path = r"E:\Zilux2开发\web\src\three\floatScene.ts"
ss_path = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
css_path = r"E:\Zilux2开发\web\src\styles\space.css"

# ---------- floatScene：歌词闪光 ----------
s = io.open(fs_path, "r", encoding="utf-8", newline="").read()

old = "  setAudioEnergy(level: number): void;"
new = "  setAudioEnergy(level: number): void;\n  /** 换色瞬间让歌词先变白再淡入新颜色 */\n  flashLyricColor(): void;"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 状态变量：紧挨 lyricColorClock
old = "  let lyricColorClock = 0;"
if old not in s:
    # 找实际声明
    old = "  let lyricColorMode: 'white' | 'flow' | 'cover' | 'rhythm' | 'rainbow' = 'white';"
    assert s.count(old) == 1
    new = "  let lyricColorMode: 'white' | 'flow' | 'cover' | 'rhythm' | 'rainbow' = 'white';\n  let lyricColorFlash = 0;"
    s = s.replace(old, new, 1)
else:
    new = "  let lyricColorClock = 0;\n  let lyricColorFlash = 0;"
    s = s.replace(old, new, 1)

# uniform 声明
old = """            uColorMode: { value: 0 },"""
new = """            uColorMode: { value: 0 },
            uFlash: { value: 0 },"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 着色器 uniform
old = """            'uniform float uColorMode;',"""
new = """            'uniform float uColorMode;',
            'uniform float uFlash;',"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 着色器颜色混合后：闪光到白
old = """            '  vec3 color = mix(baseColor, unfilledColor, unfilled);',
            '  gl_FragColor = vec4(color, alpha);',"""
new = """            '  vec3 color = mix(baseColor, unfilledColor, unfilled);',
            '  float flashMask = uFlash * (1.0 - unfilled * 0.45);',
            '  color = mix(color, vec3(1.0), clamp(flashMask, 0.0, 1.0));',
            '  alpha = clamp(alpha * (1.0 + uFlash * 0.16), 0.0, 1.0);',
            '  gl_FragColor = vec4(color, alpha);',"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# applyLyricColorUniforms 写 uFlash
old = """    uniforms.uTime!.value = lyricColorClock;
    uniforms.uEnergy!.value = audioEnergyLevel;"""
new = """    uniforms.uTime!.value = lyricColorClock;
    uniforms.uEnergy!.value = audioEnergyLevel;
    uniforms.uFlash!.value = lyricColorFlash;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# updateLyrics 里衰减
old = """  function updateLyrics(delta: number): void {
    lyricColorClock += delta;"""
new = """  function updateLyrics(delta: number): void {
    lyricColorClock += delta;
    if (lyricColorFlash > 0) lyricColorFlash = Math.max(0, lyricColorFlash - delta * 2.1);"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# handle 实现
old = """    setAudioEnergy(level) {
      audioEnergyLevel = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
    },"""
new = """    setAudioEnergy(level) {
      audioEnergyLevel = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
    },
    flashLyricColor() {
      lyricColorFlash = 1;
    },"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(fs_path, "w", encoding="utf-8", newline="").write(s)
print("floatScene lyric flash patched")

# ---------- spaceShell：背景白闪层 + 触发 ----------
s = io.open(ss_path, "r", encoding="utf-8", newline="").read()

old = """    <div class="space-sheen" data-space-sheen></div>"""
new = """    <div class="space-sheen" data-space-sheen></div>
    <div class="space-flash" data-space-flash></div>"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  const sheenLayer = root.querySelector<HTMLElement>('[data-space-sheen]')!;"""
new = """  const sheenLayer = root.querySelector<HTMLElement>('[data-space-sheen]')!;
  const flashLayer = root.querySelector<HTMLElement>('[data-space-flash]')!;
  let flashResetTimer = 0;
  const flashBackground = (): void => {
    window.clearTimeout(flashResetTimer);
    flashLayer.style.transition = 'none';
    flashLayer.style.opacity = '0.9';
    void flashLayer.offsetWidth;
    flashLayer.style.transition = 'opacity 0.95s cubic-bezier(0.22, 0.8, 0.28, 1)';
    flashLayer.style.opacity = '0';
  };"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    tintVariant += 1;
    regenerateRhythmColors();
    applyBgColorSetting(false);
    applyLyricColorSetting();"""
new = """    tintVariant += 1;
    regenerateRhythmColors();
    applyBgColorSetting(false);
    // 换色过渡：文字先瞬间变白再淡入新色，背景白闪后晕开新色
    space?.flashLyricColor();
    flashBackground();
    applyLyricColorSetting();"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(ss_path, "w", encoding="utf-8", newline="").write(s)
print("spaceShell flash patched")

# ---------- CSS ----------
css = io.open(css_path, "r", encoding="utf-8", newline="").read()
css += """

/* 鼓点换色时的背景白闪层：瞬间变白再淡出，露出新颜色 */
.space-flash {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0;
  background: radial-gradient(circle at 50% 44%, rgba(255, 255, 255, 0.98), rgba(255, 255, 255, 0.52) 46%, rgba(255, 255, 255, 0.16) 78%, transparent 100%);
  mix-blend-mode: screen;
}
"""
io.open(css_path, "w", encoding="utf-8", newline="").write(css)
print("space.css flash layer added")
