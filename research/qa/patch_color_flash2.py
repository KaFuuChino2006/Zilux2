# -*- coding: utf-8 -*-
"""鼓点换色过渡：文字瞬间变白再淡入新色；背景白闪后晕开新色。"""
import io

fs_path = r"E:\Zilux2开发\web\src\three\floatScene.ts"
ss_path = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
css_path = r"E:\Zilux2开发\web\src\styles\space.css"

s = io.open(fs_path, "r", encoding="utf-8", newline="").read()

pairs = [
    ("  setAudioEnergy(level: number): void;",
     "  setAudioEnergy(level: number): void;\n  /** 换色瞬间让歌词先变白再淡入新颜色 */\n  flashLyricColor(): void;"),

    ("  let lyricColorClock = 0;",
     "  let lyricColorClock = 0;\n  let lyricColorFlash = 0;"),

    ("            uColorMode: { value: 0 },",
     "            uColorMode: { value: 0 },\n            uFlash: { value: 0 },"),

    ("            'uniform float uColorMode;',",
     "            'uniform float uColorMode;',\n            'uniform float uFlash;',"),

    ("""            '  vec3 color = mix(baseColor, unfilledColor, unfilled);',
            '  gl_FragColor = vec4(color, alpha);',""",
     """            '  vec3 color = mix(baseColor, unfilledColor, unfilled);',
            '  float flashMask = uFlash * (1.0 - unfilled * 0.45);',
            '  color = mix(color, vec3(1.0), clamp(flashMask, 0.0, 1.0));',
            '  alpha = clamp(alpha * (1.0 + uFlash * 0.16), 0.0, 1.0);',
            '  gl_FragColor = vec4(color, alpha);',"""),

    ("""    uniforms.uTime!.value = lyricColorClock;
    uniforms.uEnergy!.value = audioEnergyLevel;""",
     """    uniforms.uTime!.value = lyricColorClock;
    uniforms.uEnergy!.value = audioEnergyLevel;
    uniforms.uFlash!.value = lyricColorFlash;"""),

    ("""  function updateLyrics(delta: number): void {
    lyricColorClock += delta;""",
     """  function updateLyrics(delta: number): void {
    lyricColorClock += delta;
    if (lyricColorFlash > 0) lyricColorFlash = Math.max(0, lyricColorFlash - delta * 2.1);"""),

    ("""    setAudioEnergy(level) {
      audioEnergyLevel = Math.max(0, Math.min(1, level));
    },""",
     """    setAudioEnergy(level) {
      audioEnergyLevel = Math.max(0, Math.min(1, level));
    },
    flashLyricColor() {
      lyricColorFlash = 1;
    },"""),
]

for old, new in pairs:
    assert s.count(old) == 1, "floatScene anchor missing: " + old[:50]
    s = s.replace(old, new, 1)

io.open(fs_path, "w", encoding="utf-8", newline="").write(s)
print("floatScene lyric flash patched")

# ---------- spaceShell ----------
s = io.open(ss_path, "r", encoding="utf-8", newline="").read()

pairs = [
    ("""    <div class="space-sheen" data-space-sheen></div>""",
     """    <div class="space-sheen" data-space-sheen></div>
    <div class="space-flash" data-space-flash></div>"""),

    ("""  const sheenLayer = root.querySelector<HTMLElement>('[data-space-sheen]')!;""",
     """  const sheenLayer = root.querySelector<HTMLElement>('[data-space-sheen]')!;
  const flashLayer = root.querySelector<HTMLElement>('[data-space-flash]')!;
  const flashBackground = (): void => {
    flashLayer.style.transition = 'none';
    flashLayer.style.opacity = '0.92';
    void flashLayer.offsetWidth;
    flashLayer.style.transition = 'opacity 0.95s cubic-bezier(0.22, 0.8, 0.28, 1)';
    flashLayer.style.opacity = '0';
  };"""),

    ("""    tintVariant += 1;
    regenerateRhythmColors();
    applyBgColorSetting(false);
    applyLyricColorSetting();""",
     """    tintVariant += 1;
    regenerateRhythmColors();
    applyBgColorSetting(false);
    // 换色过渡：文字先瞬间变白再淡入新色，背景白闪后晕开新色
    space?.flashLyricColor();
    flashBackground();
    applyLyricColorSetting();"""),
]

for old, new in pairs:
    assert s.count(old) == 1, "spaceShell anchor missing: " + old[:50]
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
  background: radial-gradient(circle at 50% 44%, rgba(255, 255, 255, 0.98), rgba(255, 255, 255, 0.5) 46%, rgba(255, 255, 255, 0.14) 78%, transparent 100%);
  mix-blend-mode: screen;
}
"""
io.open(css_path, "w", encoding="utf-8", newline="").write(css)
print("space.css flash layer added")
