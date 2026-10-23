# -*- coding: utf-8 -*-
"""频谱多样式+自定义、背景换色融合(光斑+光束)、换色降频。"""
import io

ts_path = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
css_path = r"E:\Zilux2开发\web\src\styles\space.css"

s = io.open(ts_path, "r", encoding="utf-8", newline="").read()

# ---------- 1. 模板：光束层 + 频谱展开项 ----------
old = """    <div class="space-tint space-tint-a" data-space-tint-a></div>
    <div class="space-tint space-tint-b" data-space-tint-b></div>"""
new = """    <div class="space-tint space-tint-a" data-space-tint-a></div>
    <div class="space-tint space-tint-b" data-space-tint-b></div>
    <div class="space-sheen" data-space-sheen></div>"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """            <div class="custom-field">
              <div class="custom-label"><span>音频频谱</span><b data-spectrum-current>关</b></div>
              <div class="custom-seg" data-spectrum-seg>
                <button class="custom-seg-btn is-on" data-spectrum="off" type="button">关</button>
                <button class="custom-seg-btn" data-spectrum="on" type="button">开</button>
              </div>
              <p class="custom-tip">在画面底部显示实时频谱（宿主 WASAPI 采集）</p>
            </div>"""
new = """            <div class="custom-field">
              <div class="custom-label"><span>音频频谱</span><b data-spectrum-current>关</b></div>
              <div class="custom-seg" data-spectrum-seg>
                <button class="custom-seg-btn is-on" data-spectrum="off" type="button">关</button>
                <button class="custom-seg-btn" data-spectrum="on" type="button">开</button>
              </div>
              <div class="custom-sub" data-spectrum-options hidden>
                <div class="custom-label"><span>样式</span><b data-spectrum-style-current>条形</b></div>
                <div class="custom-seg" data-spectrum-style-seg>
                  <button class="custom-seg-btn is-on" data-spectrum-style="bars" type="button">条形</button>
                  <button class="custom-seg-btn" data-spectrum-style="mirror" type="button">镜像</button>
                  <button class="custom-seg-btn" data-spectrum-style="ring" type="button">圆环</button>
                  <button class="custom-seg-btn" data-spectrum-style="line" type="button">曲线</button>
                  <button class="custom-seg-btn" data-spectrum-style="dots" type="button">光点</button>
                </div>
                <div class="custom-label"><span>长度</span><b data-spectrum-height-current>64</b></div>
                <input class="custom-slider" data-spectrum-height type="range" min="28" max="160" step="1" value="64" aria-label="频谱长度" />
                <div class="custom-label"><span>粗细</span><b data-spectrum-width-current>2</b></div>
                <input class="custom-slider" data-spectrum-width type="range" min="1" max="6" step="1" value="2" aria-label="频谱粗细" />
                <div class="custom-label"><span>透明度</span><b data-spectrum-opacity-current>90%</b></div>
                <input class="custom-slider" data-spectrum-opacity type="range" min="40" max="100" step="1" value="90" aria-label="频谱透明度" />
              </div>
              <p class="custom-tip">宿主 WASAPI 采集的实时频谱；开启后可选样式并调长度/粗细/透明度</p>
            </div>"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """              <p class="custom-tip">「封面」用当前歌曲封面取色；「节奏」会跟着鼓点随机/概率换色（每 1.4 秒最多一次）</p>"""
new = """              <p class="custom-tip">「封面」用当前歌曲封面取色；「节奏」会跟着鼓点随机换色（约 3 秒最多一次）</p>"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 2. 默认值 ----------
old = """    spectrum: false,
    bgBlur: 12,"""
new = """    spectrum: false,
    spectrumStyle: 'bars' as 'bars' | 'mirror' | 'ring' | 'line' | 'dots',
    spectrumHeight: 64,
    spectrumWidth: 2,
    spectrumOpacity: 90,
    bgBlur: 12,"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 3. loadCustom 解析 ----------
old = """        spectrum?: unknown;
        bgBlur?: unknown;"""
new = """        spectrum?: unknown;
        spectrumStyle?: unknown;
        spectrumHeight?: unknown;
        spectrumWidth?: unknown;
        spectrumOpacity?: unknown;
        bgBlur?: unknown;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """        spectrum: parsed.spectrum === true,
        bgBlur: Number.isFinite(Number(parsed.bgBlur))"""
new = """        spectrum: parsed.spectrum === true,
        spectrumStyle:
          parsed.spectrumStyle === 'mirror' ||
          parsed.spectrumStyle === 'ring' ||
          parsed.spectrumStyle === 'line' ||
          parsed.spectrumStyle === 'dots'
            ? parsed.spectrumStyle
            : 'bars',
        spectrumHeight: Number.isFinite(Number(parsed.spectrumHeight))
          ? Math.min(160, Math.max(28, Math.round(Number(parsed.spectrumHeight))))
          : DEFAULT_CUSTOM.spectrumHeight,
        spectrumWidth: Number.isFinite(Number(parsed.spectrumWidth))
          ? Math.min(6, Math.max(1, Math.round(Number(parsed.spectrumWidth))))
          : DEFAULT_CUSTOM.spectrumWidth,
        spectrumOpacity: Number.isFinite(Number(parsed.spectrumOpacity))
          ? Math.min(100, Math.max(40, Math.round(Number(parsed.spectrumOpacity))))
          : DEFAULT_CUSTOM.spectrumOpacity,
        bgBlur: Number.isFinite(Number(parsed.bgBlur))"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 4. QA 参数 ----------
old = """  const qaSpectrum = params.get('spectrum');
  if (qaSpectrum === '0') custom.spectrum = false;
  if (qaSpectrum === '1') custom.spectrum = true;"""
new = """  const qaSpectrum = params.get('spectrum');
  if (qaSpectrum === '0') custom.spectrum = false;
  if (qaSpectrum === '1') custom.spectrum = true;
  // QA：?specstyle=bars|mirror|ring|line|dots&specheight=28..160&specwidth=1..6&specopacity=40..100
  const qaSpecStyle = params.get('specstyle');
  if (
    qaSpecStyle === 'bars' ||
    qaSpecStyle === 'mirror' ||
    qaSpecStyle === 'ring' ||
    qaSpecStyle === 'line' ||
    qaSpecStyle === 'dots'
  ) {
    custom.spectrumStyle = qaSpecStyle;
  }
  const qaSpecHeight = Number(params.get('specheight'));
  if (Number.isFinite(qaSpecHeight)) custom.spectrumHeight = Math.min(160, Math.max(28, Math.round(qaSpecHeight)));
  const qaSpecWidth = Number(params.get('specwidth'));
  if (Number.isFinite(qaSpecWidth)) custom.spectrumWidth = Math.min(6, Math.max(1, Math.round(qaSpecWidth)));
  const qaSpecOpacity = Number(params.get('specopacity'));
  if (Number.isFinite(qaSpecOpacity)) custom.spectrumOpacity = Math.min(100, Math.max(40, Math.round(qaSpecOpacity)));"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 5. 元素引用 ----------
old = """  const spectrumCurrent = root.querySelector<HTMLElement>('[data-spectrum-current]')!;"""
new = """  const spectrumCurrent = root.querySelector<HTMLElement>('[data-spectrum-current]')!;
  const spectrumOptions = root.querySelector<HTMLElement>('[data-spectrum-options]')!;
  const spectrumStyleBtns = root.querySelectorAll<HTMLButtonElement>('[data-spectrum-style]');
  const spectrumStyleCurrent = root.querySelector<HTMLElement>('[data-spectrum-style-current]')!;
  const spectrumHeightInput = root.querySelector<HTMLInputElement>('[data-spectrum-height]')!;
  const spectrumHeightCurrent = root.querySelector<HTMLElement>('[data-spectrum-height-current]')!;
  const spectrumWidthInput = root.querySelector<HTMLInputElement>('[data-spectrum-width]')!;
  const spectrumWidthCurrent = root.querySelector<HTMLElement>('[data-spectrum-width-current]')!;
  const spectrumOpacityInput = root.querySelector<HTMLInputElement>('[data-spectrum-opacity]')!;
  const spectrumOpacityCurrent = root.querySelector<HTMLElement>('[data-spectrum-opacity-current]')!;
  const sheenLayer = root.querySelector<HTMLElement>('[data-space-sheen]')!;
  const spectrumSmooth: number[] = [];"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 6. paintTint：光斑 + 光束融合，更明显 ----------
old = """    const [c0, c1, c2] = [lighten(palette[0], 0.62), lighten(palette[1], 0.58), lighten(palette[2], 0.66)];
    front.style.filter = 'saturate(1.06)';
    front.style.background = [
      `linear-gradient(165deg, ${withAlpha(c1, 0.42)} 0%, ${withAlpha(c0, 0.3)} 52%, ${withAlpha(c2, 0.38)} 100%)`,
      `radial-gradient(120% 90% at 16% 12%, ${withAlpha(c1, 0.72)} 0%, transparent 62%)`,
      `radial-gradient(110% 95% at 84% 22%, ${withAlpha(c2, 0.62)} 0%, transparent 60%)`,
      `radial-gradient(140% 120% at 50% 110%, ${withAlpha(c0, 0.5)} 0%, transparent 66%)`,
    ].join(',');"""
new = """    const [c0, c1, c2] = [lighten(palette[0], 0.62), lighten(palette[1], 0.58), lighten(palette[2], 0.66)];
    front.style.filter = 'saturate(1.12)';
    // 大色块 + 随机位置光斑：换色时能明显看到色彩在画面里流动、融合
    const blobAX = Math.round(8 + Math.random() * 70);
    const blobAY = Math.round(10 + Math.random() * 64);
    front.style.background = [
      `linear-gradient(165deg, ${withAlpha(c1, 0.5)} 0%, ${withAlpha(c0, 0.4)} 52%, ${withAlpha(c2, 0.46)} 100%)`,
      `radial-gradient(72% 64% at ${blobAX}% ${blobAY}%, ${withAlpha(c2, 0.82)} 0%, transparent 68%)`,
      `radial-gradient(64% 58% at ${100 - blobAX}% ${100 - blobAY}%, ${withAlpha(c1, 0.76)} 0%, transparent 66%)`,
      `radial-gradient(120% 110% at 50% 118%, ${withAlpha(c0, 0.58)} 0%, transparent 70%)`,
    ].join(',');
    // 缓慢旋转的光束层，让换色像“光在空间里扫过”
    const sheenSpin = Math.round(Math.random() * 360);
    sheenLayer.style.background = `conic-gradient(from ${sheenSpin}deg at 50% 118%, transparent 0deg, ${withAlpha(c1, 0.34)} 52deg, transparent 118deg, ${withAlpha(c2, 0.38)} 176deg, transparent 244deg, ${withAlpha(c0, 0.3)} 300deg, transparent 360deg)`;
    sheenLayer.style.opacity = custom.bgColor === 'off' ? '0' : '1';"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 7. 换色频率降低 ----------
old = """    if (custom.bgColor === 'off') {
      tintLayerA.style.opacity = '0';
      tintLayerB.style.opacity = '0';
      return;
    }"""
new = """    if (custom.bgColor === 'off') {
      tintLayerA.style.opacity = '0';
      tintLayerB.style.opacity = '0';
      sheenLayer.style.opacity = '0';
      return;
    }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    tintLockUntil = performance.now() + (immediate ? 420 : 1400);"""
new = """    tintLockUntil = performance.now() + (immediate ? 900 : 3000);"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    const chance = level > 0.001 ? 0.3 + level * 0.6 : colorPlaying ? 0.4 : 0;"""
new = """    const chance = level > 0.001 ? 0.02 + level * 0.04 : colorPlaying ? 0.015 : 0;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 8. applySpectrumSetting 重写 ----------
old = """  function applySpectrumSetting(): void {
    spectrumCanvas.hidden = !custom.spectrum;
  }"""
new = """  function applySpectrumSetting(): void {
    spectrumCanvas.hidden = !custom.spectrum;
    spectrumOptions.hidden = !custom.spectrum;
    spectrumCanvas.style.height = `${custom.spectrumHeight}px`;
    spectrumCanvas.style.opacity = String(custom.spectrumOpacity / 100);
    spectrumCanvas.dataset.style = custom.spectrumStyle;
    spectrumSmooth.length = 0;
  }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 9. drawSpectrum 重写 ----------
start = s.index("  function drawSpectrum(): void {")
end = s.index("  function withAlpha(hex: string, alpha: number): string {")
new_draw = """  function drawSpectrum(): void {
    if (!custom.spectrum) return;
    const rect = spectrumCanvas.getBoundingClientRect();
    if (rect.width < 8) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = Math.max(120, rect.width);
    const cssH = Math.max(24, custom.spectrumHeight);
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (spectrumCanvas.width !== targetW) spectrumCanvas.width = targetW;
    if (spectrumCanvas.height !== targetH) spectrumCanvas.height = targetH;
    const ctx = spectrumCanvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const frameAudio = audioFrame();
    const bins = frameAudio.bins.length ? frameAudio.bins : frameAudio.bands;
    const count = 96;
    const palette = (custom.bgColor === 'rhythm' && rhythmColors) || paletteColors || ['#8b7bff', '#5df2ff', '#ff6ea9'];
    const colA = palette[0] ?? '#8b7bff';
    const colB = palette[2] ?? palette[1] ?? colA;
    const energy = frameAudio.level;
    // 快起慢落平滑：频谱随鼓点弹起、缓慢回落，视觉更顺
    for (let i = 0; i < count; i += 1) {
      const rawIndex = Math.min(bins.length - 1, Math.round((i / Math.max(1, count - 1)) * Math.max(0, bins.length - 1)));
      const target = bins.length ? Math.max(0, Math.min(1, bins[rawIndex] ?? 0)) : 0;
      const cur = spectrumSmooth[i] ?? 0;
      spectrumSmooth[i] = Math.min(1, Math.max(0, cur + (target - cur) * (target > cur ? 0.52 : 0.085) + energy * 0.02 * (1 - cur)));
    }
    const style = custom.spectrumStyle;
    const thickness = custom.spectrumWidth;
    const alpha = custom.spectrumOpacity / 100;
    const gradient = ctx.createLinearGradient(0, 0, cssW, 0);
    gradient.addColorStop(0, withAlpha(colA, 0.8 * alpha));
    gradient.addColorStop(0.5, withAlpha(colB, 0.95 * alpha));
    gradient.addColorStop(1, withAlpha(colA, 0.8 * alpha));
    ctx.fillStyle = gradient;
    ctx.strokeStyle = gradient;
    if (style === 'bars' || style === 'mirror') {
      const barCount = Math.max(16, Math.min(count, Math.round(cssW / (4.5 + thickness * 2.1))));
      const slot = cssW / barCount;
      const bw = Math.max(1.5, Math.min(slot * 0.78, 2.4 + thickness * 2.4));
      for (let i = 0; i < barCount; i += 1) {
        const value = spectrumSmooth[Math.round((i / Math.max(1, barCount - 1)) * (count - 1))] ?? 0;
        const h = Math.max(2, value * cssH * 0.98);
        const x = i * slot + (slot - bw) / 2;
        ctx.beginPath();
        ctx.roundRect(x, style === 'mirror' ? (cssH - h) / 2 : cssH - h, bw, h, bw * 0.45);
        ctx.fill();
      }
    } else if (style === 'ring') {
      const cx = cssW / 2;
      const cy = cssH * 1.18;
      const radius = cssH * 0.74;
      const segments = Math.max(24, Math.min(count, Math.round(cssW / 6)));
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1.4, 1.1 + thickness * 0.9);
      for (let i = 0; i < segments; i += 1) {
        const value = spectrumSmooth[Math.round((i / Math.max(1, segments - 1)) * (count - 1))] ?? 0;
        const angle = Math.PI + (i / Math.max(1, segments - 1)) * Math.PI;
        const len = 2 + value * cssH * 0.66;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
        ctx.lineTo(cx + Math.cos(angle) * (radius + len), cy + Math.sin(angle) * (radius + len));
        ctx.stroke();
      }
    } else if (style === 'line') {
      const step = cssW / (count - 1);
      ctx.lineWidth = Math.max(1.4, 1 + thickness * 0.8);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < count; i += 1) {
        const y = cssH - 3 - (spectrumSmooth[i] ?? 0) * (cssH - 8);
        if (i === 0) ctx.moveTo(0, y);
        else {
          const px = (i - 0.5) * step;
          const py = cssH - 3 - (((spectrumSmooth[i - 1] ?? 0) + (spectrumSmooth[i] ?? 0)) * 0.5) * (cssH - 8);
          ctx.quadraticCurveTo(px, py, i * step, y);
        }
      }
      ctx.stroke();
    } else {
      const step = cssW / (count - 1);
      for (let i = 0; i < count; i += 1) {
        const value = spectrumSmooth[i] ?? 0;
        const r = Math.max(1, 1.1 + value * (1.3 + thickness * 1.1));
        ctx.beginPath();
        ctx.arc(i * step, cssH - 2 - value * cssH * 0.9, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

"""
s = s[:start] + new_draw + s[end:]

# ---------- 10. syncCustomUi 频谱项 ----------
old = """    spectrumCurrent.textContent = custom.spectrum ? '开' : '关';"""
new = """    spectrumCurrent.textContent = custom.spectrum ? '开' : '关';
    spectrumOptions.hidden = !custom.spectrum;
    spectrumStyleBtns.forEach((button) => {
      button.classList.toggle('is-on', button.dataset.spectrumStyle === custom.spectrumStyle);
    });
    spectrumStyleCurrent.textContent =
      custom.spectrumStyle === 'mirror'
        ? '镜像'
        : custom.spectrumStyle === 'ring'
          ? '圆环'
          : custom.spectrumStyle === 'line'
            ? '曲线'
            : custom.spectrumStyle === 'dots'
              ? '光点'
              : '条形';
    spectrumHeightInput.value = String(custom.spectrumHeight);
    spectrumHeightCurrent.textContent = String(custom.spectrumHeight);
    spectrumWidthInput.value = String(custom.spectrumWidth);
    spectrumWidthCurrent.textContent = String(custom.spectrumWidth);
    spectrumOpacityInput.value = String(custom.spectrumOpacity);
    spectrumOpacityCurrent.textContent = `${custom.spectrumOpacity}%`;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 11. 事件绑定 ----------
old = """  spectrumBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.spectrum = button.dataset.spectrum === 'on';
      syncCustomUi();
      applySpectrumSetting();
      persistCustom();
    });
  });"""
new = """  spectrumBtns.forEach((button) => {
    button.addEventListener('click', () => {
      custom.spectrum = button.dataset.spectrum === 'on';
      syncCustomUi();
      applySpectrumSetting();
      persistCustom();
    });
  });
  spectrumStyleBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.spectrumStyle;
      custom.spectrumStyle =
        value === 'mirror' || value === 'ring' || value === 'line' || value === 'dots' ? value : 'bars';
      syncCustomUi();
      applySpectrumSetting();
      persistCustom();
    });
  });
  spectrumHeightInput.addEventListener('input', () => {
    custom.spectrumHeight = Math.min(160, Math.max(28, Math.round(Number(spectrumHeightInput.value) || 64)));
    spectrumHeightCurrent.textContent = String(custom.spectrumHeight);
    applySpectrumSetting();
    persistCustom();
  });
  spectrumWidthInput.addEventListener('input', () => {
    custom.spectrumWidth = Math.min(6, Math.max(1, Math.round(Number(spectrumWidthInput.value) || 2)));
    spectrumWidthCurrent.textContent = String(custom.spectrumWidth);
    persistCustom();
  });
  spectrumOpacityInput.addEventListener('input', () => {
    custom.spectrumOpacity = Math.min(100, Math.max(40, Math.round(Number(spectrumOpacityInput.value) || 90)));
    spectrumOpacityCurrent.textContent = `${custom.spectrumOpacity}%`;
    applySpectrumSetting();
    persistCustom();
  });"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(ts_path, "w", encoding="utf-8", newline="").write(s)
print("spaceShell patched")

# ---------- 12. CSS 追加 ----------
css = io.open(css_path, "r", encoding="utf-8", newline="").read()
css += """

/* 频谱：更宽更长、随样式自适应（覆盖旧固定尺寸） */
.space-spectrum {
  position: absolute;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  width: min(1180px, calc(100vw - 380px));
  height: 64px;
  z-index: 3;
  pointer-events: none;
  opacity: 0.9;
  transition: height 0.22s ease, opacity 0.22s ease;
}
.space-spectrum[hidden] {
  display: none !important;
}
/* 缓慢旋转的光束层，换色时像光在空间里扫过 */
.space-sheen {
  position: absolute;
  inset: -14%;
  z-index: 0;
  pointer-events: none;
  opacity: 0;
  transition: opacity 1.8s ease;
  mix-blend-mode: soft-light;
  filter: blur(30px) saturate(1.2);
  animation: space-sheen-spin 42s linear infinite;
}
@keyframes space-sheen-spin {
  from { transform: rotate(0deg) scale(1.05); }
  to { transform: rotate(360deg) scale(1.05); }
}
/* 背景色渐变过渡放慢，换色更像“慢慢晕开” */
.space-tint {
  transition: opacity 1.8s ease;
}
/* 面板内子分组（频谱展开项） */
.custom-sub {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin: 4px 0 2px;
  padding: 11px 12px 9px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.78);
}
.custom-sub[hidden] {
  display: none !important;
}
"""
io.open(css_path, "w", encoding="utf-8", newline="").write(css)
print("space.css appended")
