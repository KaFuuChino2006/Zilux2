# -*- coding: utf-8 -*-
"""渐变背景：跟随灯光压暗 + 参数可自定义（速度 / 亮度 / 色相 / 鼓点换色）。"""
import io, sys

JS = r"E:/Zilux2开发/web/src/ui/spaceShell.ts"
CSS = r"E:/Zilux2开发/web/src/styles/space.css"

def load(p):
    with io.open(p, encoding="utf-8") as f:
        return f.read()

def save(p, s):
    with io.open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)

def rep(s, old, new, label):
    n = s.count(old)
    if n != 1:
        print("FAIL", label, "count=", n)
        sys.exit(1)
    return s.replace(old, new)

js = load(JS)

# ---------- 1. HTML：背景换色下新增渐变参数 ----------
js = rep(
    js,
    """              <div class="custom-row" data-solid-row hidden>
                <div class="custom-label"><span>纯色颜色</span><b data-solid-color-current>#E3E9F7</b></div>
                <input class="custom-color" type="color" data-solid-color value="#e3e9f7" />
                <p class="custom-tip">选一个低饱和的浅色更耐看，换色时会有柔和过渡</p>
              </div>
""",
    """              <div class="custom-row" data-solid-row hidden>
                <div class="custom-label"><span>纯色颜色</span><b data-solid-color-current>#E3E9F7</b></div>
                <input class="custom-color" type="color" data-solid-color value="#e3e9f7" />
                <p class="custom-tip">选一个低饱和的浅色更耐看，换色时会有柔和过渡</p>
              </div>
              <div class="custom-sub" data-gradient-options hidden>
                <div class="custom-label"><span>流动速度</span><b data-gradient-speed-current>1.0x</b></div>
                <input class="custom-slider" data-gradient-speed type="range" min="0.3" max="3" step="0.1" value="1" aria-label="渐变换色速度" />
                <div class="custom-label"><span>亮度</span><b data-gradient-brightness-current>100%</b></div>
                <input class="custom-slider" data-gradient-brightness type="range" min="20" max="100" step="2" value="100" aria-label="渐变背景亮度" />
                <div class="custom-label"><span>色相偏移</span><b data-gradient-hue-current>0°</b></div>
                <input class="custom-slider" data-gradient-hue type="range" min="0" max="360" step="5" value="0" aria-label="渐变背景色相偏移" />
                <div class="custom-label"><span>鼓点换色</span><b data-gradient-beat-current>开</b></div>
                <div class="custom-seg" data-gradient-beat-seg>
                  <button class="custom-seg-btn" data-gradient-beat="0" type="button">关</button>
                  <button class="custom-seg-btn is-on" data-gradient-beat="1" type="button">开</button>
                </div>
                <p class="custom-tip">渐变会跟着「灯光 · 背景随之变暗」一起压暗，不再是一层独立亮色</p>
              </div>
""",
    "html",
)

# ---------- 2. 查询 ----------
js = rep(
    js,
    "  const solidRow = root.querySelector<HTMLElement>('[data-solid-row]')!;\n",
    "  const solidRow = root.querySelector<HTMLElement>('[data-solid-row]')!;\n"
    "  const gradientOptions = root.querySelector<HTMLElement>('[data-gradient-options]')!;\n"
    "  const gradientSpeedInput = root.querySelector<HTMLInputElement>('[data-gradient-speed]')!;\n"
    "  const gradientSpeedCurrent = root.querySelector<HTMLElement>('[data-gradient-speed-current]')!;\n"
    "  const gradientBrightnessInput = root.querySelector<HTMLInputElement>('[data-gradient-brightness]')!;\n"
    "  const gradientBrightnessCurrent = root.querySelector<HTMLElement>('[data-gradient-brightness-current]')!;\n"
    "  const gradientHueInput = root.querySelector<HTMLInputElement>('[data-gradient-hue]')!;\n"
    "  const gradientHueCurrent = root.querySelector<HTMLElement>('[data-gradient-hue-current]')!;\n"
    "  const gradientBeatBtns = root.querySelectorAll<HTMLButtonElement>('[data-gradient-beat]');\n"
    "  const gradientBeatCurrent = root.querySelector<HTMLElement>('[data-gradient-beat-current]')!;\n",
    "queries",
)

# ---------- 3. DEFAULT_CUSTOM ----------
js = rep(
    js,
    "    solidColor: '#e3e9f7',\n",
    "    solidColor: '#e3e9f7',\n"
    "    gradientSpeed: 1,\n"
    "    gradientBrightness: 100,\n"
    "    gradientHue: 0,\n"
    "    gradientBeat: true,\n",
    "defaults",
)

# ---------- 4. loadCustom 类型 ----------
js = rep(
    js,
    "        solidColor?: unknown;\n",
    "        solidColor?: unknown;\n"
    "        gradientSpeed?: unknown;\n"
    "        gradientBrightness?: unknown;\n"
    "        gradientHue?: unknown;\n"
    "        gradientBeat?: unknown;\n",
    "load type",
)

# ---------- 5. loadCustom 返回值 ----------
js = rep(
    js,
    "        solidColor:\n"
    "          typeof parsed.solidColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(parsed.solidColor)\n"
    "            ? parsed.solidColor\n"
    "            : DEFAULT_CUSTOM.solidColor,\n",
    "        solidColor: typeof parsed.solidColor === 'string' ? parsed.solidColor : DEFAULT_CUSTOM.solidColor,\n"
    "        gradientSpeed: Number.isFinite(Number(parsed.gradientSpeed))\n"
    "          ? Math.min(3, Math.max(0.3, Math.round(Number(parsed.gradientSpeed) * 10) / 10))\n"
    "          : DEFAULT_CUSTOM.gradientSpeed,\n"
    "        gradientBrightness: Number.isFinite(Number(parsed.gradientBrightness))\n"
    "          ? Math.min(100, Math.max(20, Math.round(Number(parsed.gradientBrightness))))\n"
    "          : DEFAULT_CUSTOM.gradientBrightness,\n"
    "        gradientHue: Number.isFinite(Number(parsed.gradientHue))\n"
    "          ? Math.min(360, Math.max(0, Math.round(Number(parsed.gradientHue))))\n"
    "          : DEFAULT_CUSTOM.gradientHue,\n"
    "        gradientBeat: parsed.gradientBeat !== false,\n",
    "load return",
)

# ---------- 6. 色相偏移 + 速度 / 亮度 / 鼓点开关 ----------
js = rep(
    js,
    "  const gradientRandomColors = (): string[] => {\n    const base = Math.round(Math.random() * 360);\n",
    "  const gradientRandomColors = (): string[] => {\n    const base = Math.round(Math.random() * 360 + custom.gradientHue) % 360;\n",
    "hue base",
)

js = rep(
    js,
    "    bgGradAnim = { from: bgGradColors.slice(), to: target.slice(), start: performance.now(), dur: 680 };\n",
    "    bgGradAnim = {\n"
    "      from: bgGradColors.slice(),\n"
    "      to: target.slice(),\n"
    "      start: performance.now(),\n"
    "      dur: Math.max(120, Math.round(680 / custom.gradientSpeed)),\n"
    "    };\n",
    "transition dur",
)

js = rep(
    js,
    "      if (custom.bgColor === 'gradient' && frame.beat) {\n"
    "        const now = performance.now();\n"
    "        if (now - lastGradBeatAt > 250) {\n",
    "      if (custom.bgColor === 'gradient' && custom.gradientBeat && frame.beat) {\n"
    "        const now = performance.now();\n"
    "        if (now - lastGradBeatAt > Math.max(120, Math.round(250 / custom.gradientSpeed))) {\n",
    "beat hook",
)

# ---------- 7. applyGradientLook 并改写渐变分支 ----------
js = rep(
    js,
    """    if (custom.bgColor === 'gradient') {
      root.classList.add('is-gradient-bg');
      if (!bgGradReady || modeChanged) {
        bgGradReady = true;
        startGradientTransition(gradientRandomColors(), true);
      }
      syncLyricsDim();
""",
    """    if (custom.bgColor === 'gradient') {
      root.classList.add('is-gradient-bg');
      applyGradientLook();
      if (!bgGradReady || modeChanged) {
        bgGradReady = true;
        startGradientTransition(gradientRandomColors(), true);
      }
      syncLyricsDim();
""",
    "gradient branch",
)

js = rep(
    js,
    "  function applyBgColorSetting(immediate: boolean): void {\n",
    """  /** 渐变参数：速度决定流动动画/换色时长，亮度叠一层压暗蒙版（和灯光压暗同步） */
  function applyGradientLook(): void {
    const darkStage = custom.lighting && custom.dimBackground;
    const dim = Math.min(0.92, (darkStage ? 0.42 : 0) + (1 - custom.gradientBrightness / 100) * 0.5);
    root.style.setProperty('--bgg-dim', dim.toFixed(3));
    root.style.setProperty('--bgg-drift-dur', `${(6.5 / custom.gradientSpeed).toFixed(2)}s`);
  }

  function applyBgColorSetting(immediate: boolean): void {
""",
    "applyGradientLook",
)

# 灯光开关 / 背景变暗切换时同步渐变压暗
js = rep(
    js,
    "    root.classList.toggle('is-dark-stage', custom.lighting && custom.dimBackground);\n",
    "    root.classList.toggle('is-dark-stage', custom.lighting && custom.dimBackground);\n"
    "    if (custom.bgColor === 'gradient') applyGradientLook();\n",
    "light dim sync",
)

# ---------- 8. syncCustomUi ----------
js = rep(
    js,
    "    solidRow.hidden = custom.bgColor !== 'solid';\n",
    "    solidRow.hidden = custom.bgColor !== 'solid';\n"
    "    gradientOptions.hidden = custom.bgColor !== 'gradient';\n"
    "    gradientSpeedInput.value = String(custom.gradientSpeed);\n"
    "    gradientSpeedCurrent.textContent = `${custom.gradientSpeed.toFixed(1)}x`;\n"
    "    gradientBrightnessInput.value = String(custom.gradientBrightness);\n"
    "    gradientBrightnessCurrent.textContent = `${custom.gradientBrightness}%`;\n"
    "    gradientHueInput.value = String(custom.gradientHue);\n"
    "    gradientHueCurrent.textContent = `${custom.gradientHue}°`;\n"
    "    gradientBeatBtns.forEach((button) => {\n"
    "      button.classList.toggle('is-on', (button.dataset.gradientBeat === '1') === custom.gradientBeat);\n"
    "    });\n"
    "    gradientBeatCurrent.textContent = custom.gradientBeat ? '开' : '关';\n",
    "sync ui",
)

# ---------- 9. handlers ----------
js = rep(
    js,
    """  solidColorInput.addEventListener('input', () => {
    custom.solidColor = solidColorInput.value;
    solidColorCurrent.textContent = custom.solidColor.toUpperCase();
    if (custom.bgColor === 'solid') applyBgColorSetting(true);
    persistCustom();
  });
""",
    """  solidColorInput.addEventListener('input', () => {
    custom.solidColor = solidColorInput.value;
    solidColorCurrent.textContent = custom.solidColor.toUpperCase();
    if (custom.bgColor === 'solid') applyBgColorSetting(true);
    persistCustom();
  });
  gradientSpeedInput.addEventListener('input', () => {
    custom.gradientSpeed = Math.min(3, Math.max(0.3, Math.round(Number(gradientSpeedInput.value) * 10) / 10));
    gradientSpeedCurrent.textContent = `${custom.gradientSpeed.toFixed(1)}x`;
    applyGradientLook();
    persistCustom();
  });
  gradientBrightnessInput.addEventListener('input', () => {
    custom.gradientBrightness = Math.min(100, Math.max(20, Math.round(Number(gradientBrightnessInput.value) || 100)));
    gradientBrightnessCurrent.textContent = `${custom.gradientBrightness}%`;
    applyGradientLook();
    persistCustom();
  });
  gradientHueInput.addEventListener('input', () => {
    custom.gradientHue = Math.min(360, Math.max(0, Math.round(Number(gradientHueInput.value) || 0)));
    gradientHueCurrent.textContent = `${custom.gradientHue}°`;
    if (custom.bgColor === 'gradient') startGradientTransition(gradientRandomColors());
    persistCustom();
  });
  gradientBeatBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.gradientBeat = button.dataset.gradientBeat === '1';
      syncCustomUi();
      persistCustom();
    });
  });
""",
    "handlers",
)

save(JS, js)
print("OK js")

css = load(CSS)
css = css.rstrip() + """

/* 渐变背景：参数可自定义（速度 / 亮度 / 色相偏移 / 鼓点换色）
   —— 之前 .is-gradient-bg 用 !important 直接盖掉 .is-dark-stage 的压暗，进入空间时
   渐变会比其它背景亮一截；这里补一层压暗蒙版，跟着「灯光 · 背景随之变暗」一起走。 */
.space-shell.is-gradient-bg {
  animation-duration: var(--bgg-drift-dur, 6.5s) !important;
}
.space-shell.is-gradient-bg::before,
.space-shell.is-gradient-bg.is-dark-stage::before {
  background: radial-gradient(circle at 50% 42%, #141a28 0%, #0a0d15 58%, #04050a 100%) !important;
  opacity: var(--bgg-dim, 0) !important;
}
.custom-sheet .custom-sub[hidden] {
  display: none !important;
}
"""
save(CSS, css)
print("OK css")
