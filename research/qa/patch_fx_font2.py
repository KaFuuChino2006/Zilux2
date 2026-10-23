# -*- coding: utf-8 -*-
"""背景粒子（星点/连线/三角）+ 歌词字体悬停预览：JS 逻辑补丁。"""
import io, sys

JS = r"E:/Zilux2开发/web/src/ui/spaceShell.ts"

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

# ---------- 1. 查询 ----------
js = rep(
    js,
    "  const lyricFontSelect = root.querySelector<HTMLSelectElement>('[data-lyric-font]')!;\n"
    "  const lyricFontCurrent = root.querySelector<HTMLElement>('[data-lyric-font-current]')!;\n",
    "  const lyricFontBtn = root.querySelector<HTMLButtonElement>('[data-font-trigger]')!;\n"
    "  const lyricFontValue = root.querySelector<HTMLElement>('[data-font-value]')!;\n"
    "  const lyricFontMenu = root.querySelector<HTMLElement>('[data-font-menu]')!;\n"
    "  const lyricFontList = root.querySelector<HTMLElement>('[data-font-list]')!;\n"
    "  const lyricFontPreview = root.querySelector<HTMLElement>('[data-font-preview]')!;\n"
    "  const lyricFontCurrent = root.querySelector<HTMLElement>('[data-lyric-font-current]')!;\n"
    "\n"
    "  /** 把字体族名包成合法的 CSS font-family（带中文兜底） */\n"
    "  const lyricFontStack = (family: string): string => {\n"
    "    if (!family) return '';\n"
    "    const safe = family.replace(/[\"\\\\]/g, '');\n"
    "    return `\"${safe}\", system-ui, \"Microsoft YaHei\", sans-serif`;\n"
    "  };\n",
    "font queries",
)

js = rep(
    js,
    "  const wallpaperPosCurrent = root.querySelector<HTMLElement>('[data-wallpaper-pos-current]')!;\n",
    "  const wallpaperPosCurrent = root.querySelector<HTMLElement>('[data-wallpaper-pos-current]')!;\n"
    "  const fxCanvas = root.querySelector<HTMLCanvasElement>('[data-space-fx]')!;\n"
    "  const fxCtx = fxCanvas.getContext('2d');\n"
    "  const fxBtns = root.querySelectorAll<HTMLButtonElement>('[data-fx]');\n"
    "  const fxCurrent = root.querySelector<HTMLElement>('[data-fx-current]')!;\n"
    "  const fxOptions = root.querySelector<HTMLElement>('[data-fx-options]')!;\n"
    "  const fxCountInput = root.querySelector<HTMLInputElement>('[data-fx-count]')!;\n"
    "  const fxCountCurrent = root.querySelector<HTMLElement>('[data-fx-count-current]')!;\n"
    "  const fxSpeedInput = root.querySelector<HTMLInputElement>('[data-fx-speed]')!;\n"
    "  const fxSpeedCurrent = root.querySelector<HTMLElement>('[data-fx-speed-current]')!;\n"
    "  const fxSizeInput = root.querySelector<HTMLInputElement>('[data-fx-size]')!;\n"
    "  const fxSizeCurrent = root.querySelector<HTMLElement>('[data-fx-size-current]')!;\n"
    "  const fxOpacityInput = root.querySelector<HTMLInputElement>('[data-fx-opacity]')!;\n"
    "  const fxOpacityCurrent = root.querySelector<HTMLElement>('[data-fx-opacity-current]')!;\n"
    "  const fxLinkInput = root.querySelector<HTMLInputElement>('[data-fx-link]')!;\n"
    "  const fxLinkCurrent = root.querySelector<HTMLElement>('[data-fx-link-current]')!;\n"
    "  const FX_LABEL: Record<string, string> = { off: '关闭', stars: '星点', links: '连线', triangles: '三角' };\n",
    "fx queries",
)

# ---------- 2. DEFAULT_CUSTOM ----------
js = rep(
    js,
    "    wallpaperPos: 'cover' as 'cover' | 'contain' | 'center',\n    lyricFont: '',\n",
    "    wallpaperPos: 'cover' as 'cover' | 'contain' | 'center',\n"
    "    fxMode: 'off' as 'off' | 'stars' | 'links' | 'triangles',\n"
    "    fxCount: 90,\n"
    "    fxSpeed: 1,\n"
    "    fxSize: 1,\n"
    "    fxOpacity: 70,\n"
    "    fxLink: 140,\n"
    "    lyricFont: '',\n",
    "defaults",
)

# ---------- 3. loadCustom 类型 ----------
js = rep(
    js,
    "        wallpaperPos?: unknown;\n        lyricFont?: unknown;\n",
    "        wallpaperPos?: unknown;\n"
    "        fxMode?: unknown;\n"
    "        fxCount?: unknown;\n"
    "        fxSpeed?: unknown;\n"
    "        fxSize?: unknown;\n"
    "        fxOpacity?: unknown;\n"
    "        fxLink?: unknown;\n"
    "        lyricFont?: unknown;\n",
    "load type",
)

# ---------- 4. loadCustom 返回值 ----------
js = rep(
    js,
    "        wallpaperPos:\n"
    "          parsed.wallpaperPos === 'contain' || parsed.wallpaperPos === 'center'\n"
    "            ? parsed.wallpaperPos\n"
    "            : 'cover',\n",
    "        wallpaperPos:\n"
    "          parsed.wallpaperPos === 'contain' || parsed.wallpaperPos === 'center'\n"
    "            ? parsed.wallpaperPos\n"
    "            : 'cover',\n"
    "        fxMode:\n"
    "          parsed.fxMode === 'stars' || parsed.fxMode === 'links' || parsed.fxMode === 'triangles'\n"
    "            ? parsed.fxMode\n"
    "            : 'off',\n"
    "        fxCount: Number.isFinite(Number(parsed.fxCount))\n"
    "          ? Math.min(200, Math.max(16, Math.round(Number(parsed.fxCount))))\n"
    "          : DEFAULT_CUSTOM.fxCount,\n"
    "        fxSpeed: Number.isFinite(Number(parsed.fxSpeed))\n"
    "          ? Math.min(2.4, Math.max(0.2, Number(parsed.fxSpeed)))\n"
    "          : DEFAULT_CUSTOM.fxSpeed,\n"
    "        fxSize: Number.isFinite(Number(parsed.fxSize))\n"
    "          ? Math.min(2.4, Math.max(0.4, Number(parsed.fxSize)))\n"
    "          : DEFAULT_CUSTOM.fxSize,\n"
    "        fxOpacity: Number.isFinite(Number(parsed.fxOpacity))\n"
    "          ? Math.min(100, Math.max(10, Math.round(Number(parsed.fxOpacity))))\n"
    "          : DEFAULT_CUSTOM.fxOpacity,\n"
    "        fxLink: Number.isFinite(Number(parsed.fxLink))\n"
    "          ? Math.min(280, Math.max(60, Math.round(Number(parsed.fxLink))))\n"
    "          : DEFAULT_CUSTOM.fxLink,\n",
    "load return",
)

# ---------- 5. applyCustom ----------
js = rep(
    js,
    "  const applyCustom = (): void => {\n    space?.setUnderlayImage(custom.image);\n    applyWallpaperPos();\n",
    "  const applyCustom = (): void => {\n    space?.setUnderlayImage(custom.image);\n    applyWallpaperPos();\n    applyFxSetting();\n",
    "applyCustom",
)

# ---------- 6. FX 引擎（插在 paintTint 之前） ----------
engine = '''  // ---------- 背景粒子层：星点 / 连线网络 / 漂浮三角 ----------
  type FxParticle = { x: number; y: number; vx: number; vy: number; r: number; rot: number; vr: number; a: number };
  let fxRaf = 0;
  let fxLast = 0;
  let fxW = 0;
  let fxH = 0;
  let fxParticles: FxParticle[] = [];
  const resizeFxLayer = (): void => {
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    fxW = window.innerWidth;
    fxH = window.innerHeight;
    fxCanvas.width = Math.max(1, Math.round(fxW * dpr));
    fxCanvas.height = Math.max(1, Math.round(fxH * dpr));
    if (fxCtx) fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const seedFxParticles = (): void => {
    const count = Math.round(custom.fxCount);
    fxParticles = Array.from({ length: count }, () => ({
      x: Math.random() * fxW,
      y: Math.random() * fxH,
      vx: (Math.random() - 0.5) * 22,
      vy: (Math.random() - 0.5) * 22,
      r: 0.8 + Math.random() * 1.8,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.9,
      a: 0.32 + Math.random() * 0.5,
    }));
  };
  const drawFxFrame = (now: number): void => {
    const delta = Math.min(0.05, Math.max(0, (now - fxLast) / 1000));
    fxLast = now;
    const mode = custom.fxMode;
    if (!fxCtx || mode === 'off') {
      fxRaf = 0;
      return;
    }
    const speed = custom.fxSpeed;
    const size = custom.fxSize;
    const alpha = custom.fxOpacity / 100;
    const link = custom.fxLink;
    fxCtx.clearRect(0, 0, fxW, fxH);
    const rgb = root.classList.contains('theme-gold') ? '212, 175, 55' : '43, 49, 64';
    const pts = fxParticles;
    for (const p of pts) {
      p.x += p.vx * speed * delta;
      p.y += p.vy * speed * delta;
      if (p.x < -24) p.x = fxW + 24;
      else if (p.x > fxW + 24) p.x = -24;
      if (p.y < -24) p.y = fxH + 24;
      else if (p.y > fxH + 24) p.y = -24;
      p.rot += p.vr * speed * delta;
    }
    if (mode === 'links') {
      fxCtx.lineWidth = 1;
      for (let i = 0; i < pts.length; i += 1) {
        for (let j = i + 1; j < pts.length; j += 1) {
          const dx = pts[i].x - pts[j].x;
          const dy = pts[i].y - pts[j].y;
          const dist = Math.hypot(dx, dy);
          if (dist > link) continue;
          fxCtx.strokeStyle = `rgba(${rgb}, ${(1 - dist / link) * 0.5 * alpha})`;
          fxCtx.beginPath();
          fxCtx.moveTo(pts[i].x, pts[i].y);
          fxCtx.lineTo(pts[j].x, pts[j].y);
          fxCtx.stroke();
        }
      }
    }
    for (const p of pts) {
      if (mode === 'triangles') {
        fxCtx.save();
        fxCtx.translate(p.x, p.y);
        fxCtx.rotate(p.rot);
        const r = p.r * size * 3.2;
        fxCtx.strokeStyle = `rgba(${rgb}, ${p.a * 0.72 * alpha})`;
        fxCtx.lineWidth = 1.1;
        fxCtx.beginPath();
        fxCtx.moveTo(0, -r);
        fxCtx.lineTo(r * 0.866, r * 0.5);
        fxCtx.lineTo(-r * 0.866, r * 0.5);
        fxCtx.closePath();
        fxCtx.stroke();
        fxCtx.fillStyle = `rgba(${rgb}, ${p.a * 0.12 * alpha})`;
        fxCtx.fill();
        fxCtx.restore();
      } else {
        fxCtx.fillStyle = `rgba(${rgb}, ${p.a * alpha})`;
        fxCtx.beginPath();
        fxCtx.arc(p.x, p.y, p.r * size, 0, Math.PI * 2);
        fxCtx.fill();
        if (mode === 'stars') {
          fxCtx.fillStyle = `rgba(255, 255, 255, ${p.a * 0.55 * alpha})`;
          fxCtx.beginPath();
          fxCtx.arc(p.x, p.y, p.r * size * 0.42, 0, Math.PI * 2);
          fxCtx.fill();
        }
      }
    }
    fxRaf = window.requestAnimationFrame(drawFxFrame);
  };
  function applyFxSetting(): void {
    const mode = custom.fxMode;
    fxCanvas.hidden = mode === 'off';
    if (mode === 'off') {
      if (fxRaf) window.cancelAnimationFrame(fxRaf);
      fxRaf = 0;
      if (fxCtx) fxCtx.clearRect(0, 0, fxW, fxH);
      return;
    }
    resizeFxLayer();
    seedFxParticles();
    if (!fxRaf) {
      fxLast = performance.now();
      fxRaf = window.requestAnimationFrame(drawFxFrame);
    }
  }

'''
js = rep(js, "  function paintTint(frontA: boolean): void {\n", engine + "  function paintTint(frontA: boolean): void {\n", "engine")

# ---------- 7. syncCustomUi：字体 + 背景粒子 ----------
js = rep(
    js,
    "    lyricFontSelect.value = custom.lyricFont && systemFontFamilies.includes(custom.lyricFont) ? custom.lyricFont : '';\n"
    "    lyricFontCurrent.textContent = custom.lyricFont || '默认';\n",
    "    lyricFontValue.textContent = custom.lyricFont || '默认（系统黑体）';\n"
    "    lyricFontCurrent.textContent = custom.lyricFont || '默认';\n"
    "    lyricFontPreview.style.fontFamily = lyricFontStack(custom.lyricFont);\n"
    "    lyricFontList.querySelectorAll<HTMLElement>('[data-font]').forEach((item) => {\n"
    "      item.classList.toggle('is-active', item.dataset.font === custom.lyricFont);\n"
    "    });\n",
    "sync font",
)

js = rep(
    js,
    "    wallpaperPosCurrent.textContent =\n"
    "      custom.wallpaperPos === 'contain' ? '适应' : custom.wallpaperPos === 'center' ? '居中' : '填充';\n",
    "    wallpaperPosCurrent.textContent =\n"
    "      custom.wallpaperPos === 'contain' ? '适应' : custom.wallpaperPos === 'center' ? '居中' : '填充';\n"
    "    fxBtns.forEach((button) => {\n"
    "      button.classList.toggle('is-on', button.dataset.fx === custom.fxMode);\n"
    "    });\n"
    "    fxCurrent.textContent = FX_LABEL[custom.fxMode] ?? '关闭';\n"
    "    fxOptions.hidden = custom.fxMode === 'off';\n"
    "    fxCountInput.value = String(custom.fxCount);\n"
    "    fxCountCurrent.textContent = String(custom.fxCount);\n"
    "    fxSpeedInput.value = String(custom.fxSpeed);\n"
    "    fxSpeedCurrent.textContent = `${custom.fxSpeed.toFixed(1)}x`;\n"
    "    fxSizeInput.value = String(custom.fxSize);\n"
    "    fxSizeCurrent.textContent = `${custom.fxSize.toFixed(1)}x`;\n"
    "    fxOpacityInput.value = String(custom.fxOpacity);\n"
    "    fxOpacityCurrent.textContent = `${custom.fxOpacity}%`;\n"
    "    fxLinkInput.value = String(custom.fxLink);\n"
    "    fxLinkCurrent.textContent = String(custom.fxLink);\n",
    "sync fx",
)

# ---------- 8. 字体 change handler → 自定义下拉交互 ----------
old_change = '''  lyricFontSelect.addEventListener('change', () => {
    custom.lyricFont = lyricFontSelect.value;
    lyricFontCurrent.textContent = custom.lyricFont || '默认';
    space?.setLyricFontFamily(custom.lyricFont);
    persistCustom();
  });
'''
new_change = '''  const setFontPreview = (family: string): void => {
    lyricFontPreview.style.fontFamily = lyricFontStack(family);
    lyricFontValue.textContent = family || '默认（系统黑体）';
    space?.setLyricFontFamily(family);
  };
  const closeFontMenu = (): void => {
    lyricFontMenu.hidden = true;
    lyricFontBtn.setAttribute('aria-expanded', 'false');
    setFontPreview(custom.lyricFont);
  };
  lyricFontBtn.addEventListener('click', () => {
    const open = lyricFontMenu.hidden;
    lyricFontMenu.hidden = !open;
    lyricFontBtn.setAttribute('aria-expanded', String(open));
    if (!open) setFontPreview(custom.lyricFont);
  });
  lyricFontList.addEventListener('pointerover', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-font]');
    if (!item) return;
    // 悬停即换字体：3D 歌词和面板里的预览行同步变化，点一下才真正保存
    setFontPreview(item.dataset.font ?? '');
  });
  lyricFontList.addEventListener('pointerleave', () => {
    setFontPreview(custom.lyricFont);
  });
  lyricFontList.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-font]');
    if (!item) return;
    custom.lyricFont = item.dataset.font ?? '';
    space?.setLyricFontFamily(custom.lyricFont);
    syncCustomUi();
    persistCustom();
    closeFontMenu();
  });
  document.addEventListener('pointerdown', (event) => {
    if (lyricFontMenu.hidden) return;
    const target = event.target as Node | null;
    if (target && !lyricFontMenu.contains(target) && !lyricFontBtn.contains(target)) closeFontMenu();
  });
'''
js = rep(js, old_change, new_change, "font handler")

# ---------- 9. 背景粒子 handlers（跟在壁纸位置 handler 之后） ----------
old_wp = '''  wallpaperPosBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.wallpaperPos;
      custom.wallpaperPos = value === 'contain' || value === 'center' ? value : 'cover';
      syncCustomUi();
      applyWallpaperPos();
      persistCustom();
    });
  });
'''
new_wp = old_wp + '''  fxBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.fx;
      custom.fxMode = value === 'stars' || value === 'links' || value === 'triangles' ? value : 'off';
      syncCustomUi();
      applyFxSetting();
      persistCustom();
    });
  });
  fxCountInput.addEventListener('input', () => {
    custom.fxCount = Math.min(200, Math.max(16, Math.round(Number(fxCountInput.value) || 90)));
    fxCountCurrent.textContent = String(custom.fxCount);
    seedFxParticles();
    persistCustom();
  });
  fxSpeedInput.addEventListener('input', () => {
    custom.fxSpeed = Math.min(2.4, Math.max(0.2, Math.round(Number(fxSpeedInput.value) * 10) / 10));
    fxSpeedCurrent.textContent = `${custom.fxSpeed.toFixed(1)}x`;
    persistCustom();
  });
  fxSizeInput.addEventListener('input', () => {
    custom.fxSize = Math.min(2.4, Math.max(0.4, Math.round(Number(fxSizeInput.value) * 10) / 10));
    fxSizeCurrent.textContent = `${custom.fxSize.toFixed(1)}x`;
    persistCustom();
  });
  fxOpacityInput.addEventListener('input', () => {
    custom.fxOpacity = Math.min(100, Math.max(10, Math.round(Number(fxOpacityInput.value) || 70)));
    fxOpacityCurrent.textContent = `${custom.fxOpacity}%`;
    persistCustom();
  });
  fxLinkInput.addEventListener('input', () => {
    custom.fxLink = Math.min(280, Math.max(60, Math.round(Number(fxLinkInput.value) || 140)));
    fxLinkCurrent.textContent = String(custom.fxLink);
    persistCustom();
  });
'''
js = rep(js, old_wp, new_wp, "fx handlers")

# ---------- 10. resize 时重排粒子 ----------
js = rep(
    js,
    "  window.addEventListener('resize', () => {\n"
    "    if (!customSheet.hidden && customSheet.classList.contains('is-open')) positionCustomSheet();\n"
    "  });\n",
    "  window.addEventListener('resize', () => {\n"
    "    if (!customSheet.hidden && customSheet.classList.contains('is-open')) positionCustomSheet();\n"
    "    if (fxRaf) {\n"
    "      resizeFxLayer();\n"
    "      seedFxParticles();\n"
    "    }\n"
    "  });\n",
    "resize fx",
)

# ---------- 11. fillLyricFontOptions 重写 ----------
old_fill = '''  const fillLyricFontOptions = (): void => {
    const selected = custom.lyricFont && systemFontFamilies.includes(custom.lyricFont) ? custom.lyricFont : '';
    const frag = document.createDocumentFragment();
    const base = document.createElement('option');
    base.value = '';
    base.textContent = '默认（系统黑体）';
    frag.appendChild(base);
    for (const family of systemFontFamilies) {
      const option = document.createElement('option');
      option.value = family;
      option.textContent = family;
      frag.appendChild(option);
    }
    lyricFontSelect.replaceChildren(frag);
    lyricFontSelect.value = selected;
    lyricFontCurrent.textContent = custom.lyricFont || '默认';
  };
'''
new_fill = '''  const fillLyricFontOptions = (): void => {
    const selected = custom.lyricFont && systemFontFamilies.includes(custom.lyricFont) ? custom.lyricFont : '';
    const frag = document.createDocumentFragment();
    const makeItem = (family: string, label: string): HTMLElement => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'custom-font-item';
      item.dataset.font = family;
      item.innerHTML = `<span class="custom-font-name">${label}</span><span class="custom-font-sample">歌词预览 Aa 字</span>`;
      const sample = item.querySelector<HTMLElement>('.custom-font-sample');
      if (sample) sample.style.fontFamily = lyricFontStack(family);
      item.classList.toggle('is-active', family === selected);
      return item;
    };
    frag.appendChild(makeItem('', '默认（系统黑体）'));
    for (const family of systemFontFamilies) frag.appendChild(makeItem(family, family));
    lyricFontList.replaceChildren(frag);
    lyricFontValue.textContent = selected || '默认（系统黑体）';
    lyricFontCurrent.textContent = custom.lyricFont || '默认';
    lyricFontPreview.style.fontFamily = lyricFontStack(selected);
  };
'''
js = rep(js, old_fill, new_fill, "fill fonts")

save(JS, js)
print("OK part2")
