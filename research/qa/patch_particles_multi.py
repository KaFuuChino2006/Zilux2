# -*- coding: utf-8 -*-
"""背景粒子改多选：星点/连线/三角各自独立粒子层（位置各异）+ 自带星尘集成。"""
import io, sys

SPACE = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
SCENE = r"E:\Zilux2开发\web\src\three\floatScene.ts"

def ro(path):
    with io.open(path, "r", encoding="utf-8") as f:
        return f.read()

def wr(path, text):
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)

def rep(text, old, new, tag):
    if text.count(old) != 1:
        raise SystemExit("[FAIL] %s: count=%d" % (tag, text.count(old)))
    return text.replace(old, new, 1)

# ---------------- spaceShell.ts ----------------
s = ro(SPACE)

# 1) HTML：多选按钮 + 自带星尘
s = rep(s,
"""              <div class="custom-seg" data-fx-seg>
                <button class="custom-seg-btn is-on" data-fx="off" type="button">关</button>
                <button class="custom-seg-btn" data-fx="stars" type="button">星点</button>
                <button class="custom-seg-btn" data-fx="links" type="button">连线</button>
                <button class="custom-seg-btn" data-fx="triangles" type="button">三角</button>
              </div>""",
"""              <div class="custom-seg custom-seg-multi" data-fx-seg>
                <button class="custom-seg-btn is-on" data-fx="off" type="button">关</button>
                <button class="custom-seg-btn" data-fx="stars" type="button">星点</button>
                <button class="custom-seg-btn" data-fx="links" type="button">连线</button>
                <button class="custom-seg-btn" data-fx="triangles" type="button">三角</button>
                <button class="custom-seg-btn" data-fx="dust" type="button">自带星尘</button>
              </div>""",
"html seg")

s = rep(s,
"              <p class=\"custom-tip\">磁贴后方的粒子层：星点漂浮 / 近距离自动连线 / 漂浮三角</p>",
"              <p class=\"custom-tip\">可多选叠加：星点 / 连线 / 三角 / 自带星尘，各层粒子位置互不相同</p>",
"html tip")

# 2) FX 标签与多选辅助
s = rep(s,
"  const FX_LABEL: Record<string, string> = { off: '关闭', stars: '星点', links: '连线', triangles: '三角' };",
"""  const FX_LABEL: Record<string, string> = {
    off: '关闭',
    stars: '星点',
    links: '连线',
    triangles: '三角',
    dust: '自带星尘',
  };
  /** 多选：fxMode 存成逗号分隔的集合，'off' 表示全关 */
  const fxSelected = (): string[] => custom.fxMode.split(',').filter((mode) => mode && mode !== 'off');""",
"fx labels")

# 3) 默认值类型放宽
s = rep(s,
"    fxMode: 'off' as 'off' | 'stars' | 'links' | 'triangles',",
"    fxMode: 'off' as string,",
"default fxMode")

# 4) 持久化解析：兼容旧单值 + 新多值
s = rep(s,
"""        fxMode:
          parsed.fxMode === 'stars' || parsed.fxMode === 'links' || parsed.fxMode === 'triangles'
            ? parsed.fxMode
            : 'off',""",
"""        fxMode:
          typeof parsed.fxMode === 'string'
            ? parsed.fxMode
                .split(',')
                .map((mode) => mode.trim())
                .filter(
                  (mode) =>
                    mode === 'stars' || mode === 'links' || mode === 'triangles' || mode === 'dust',
                )
                .join(',') || 'off'
            : 'off',""",
"load fxMode")

# 5) 粒子数据：每个效果独立一组，位置不同
s = rep(s,
"  let fxParticles: FxParticle[] = [];",
"""  type FxFieldName = 'stars' | 'links' | 'triangles';
  const FX_FIELD_META: Record<FxFieldName, { count: number }> = {
    stars: { count: 1.3 },
    links: { count: 0.68 },
    triangles: { count: 0.6 },
  };
  const fxFields: Record<FxFieldName, FxParticle[]> = { stars: [], links: [], triangles: [] };""",
"fx fields")

# 6) seedFxParticles 改为分层填充
s = rep(s,
"""  const seedFxParticles = (): void => {
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
  };""",
"""  const seedFxParticles = (): void => {
    const base = Math.round(custom.fxCount);
    for (const name of ['stars', 'links', 'triangles'] as FxFieldName[]) {
      const count = Math.max(10, Math.round(base * FX_FIELD_META[name].count));
      fxFields[name] = Array.from({ length: count }, () => ({
        x: Math.random() * fxW,
        y: Math.random() * fxH,
        vx: (Math.random() - 0.5) * 22,
        vy: (Math.random() - 0.5) * 22,
        r: 0.8 + Math.random() * 1.8,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.9,
        a: 0.32 + Math.random() * 0.5,
      }));
    }
  };""",
"seed")

# 7) drawFxFrame 重写：按选中的效果逐层绘制
old_draw = """  const drawFxFrame = (now: number): void => {
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
  };"""

new_draw = """  const has2dFx = (): boolean =>
    fxSelected().some((mode) => mode === 'stars' || mode === 'links' || mode === 'triangles');
  const drawFxFrame = (now: number): void => {
    const delta = Math.min(0.05, Math.max(0, (now - fxLast) / 1000));
    fxLast = now;
    const selected = fxSelected();
    if (!fxCtx || !has2dFx()) {
      fxRaf = 0;
      return;
    }
    const speed = custom.fxSpeed;
    const size = custom.fxSize;
    const alpha = custom.fxOpacity / 100;
    const link = custom.fxLink;
    fxCtx.clearRect(0, 0, fxW, fxH);
    const rgb = root.classList.contains('theme-gold') ? '212, 175, 55' : '43, 49, 64';
    for (const name of ['stars', 'links', 'triangles'] as FxFieldName[]) {
      if (!selected.includes(name)) continue;
      const pts = fxFields[name];
      for (const p of pts) {
        p.x += p.vx * speed * delta;
        p.y += p.vy * speed * delta;
        if (p.x < -24) p.x = fxW + 24;
        else if (p.x > fxW + 24) p.x = -24;
        if (p.y < -24) p.y = fxH + 24;
        else if (p.y > fxH + 24) p.y = -24;
        p.rot += p.vr * speed * delta;
      }
      if (name === 'links') {
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
        if (name === 'triangles') {
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
        } else if (name === 'stars') {
          fxCtx.fillStyle = `rgba(${rgb}, ${p.a * alpha})`;
          fxCtx.beginPath();
          fxCtx.arc(p.x, p.y, p.r * size, 0, Math.PI * 2);
          fxCtx.fill();
          fxCtx.fillStyle = `rgba(255, 255, 255, ${p.a * 0.55 * alpha})`;
          fxCtx.beginPath();
          fxCtx.arc(p.x, p.y, p.r * size * 0.42, 0, Math.PI * 2);
          fxCtx.fill();
        } else {
          fxCtx.fillStyle = `rgba(${rgb}, ${p.a * alpha})`;
          fxCtx.beginPath();
          fxCtx.arc(p.x, p.y, p.r * size, 0, Math.PI * 2);
          fxCtx.fill();
        }
      }
    }
    fxRaf = window.requestAnimationFrame(drawFxFrame);
  };"""

s = rep(s, old_draw, new_draw, "drawFxFrame")

# 8) applyFxSetting：多选 + 星尘开关
old_apply = """  function applyFxSetting(): void {
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
  }"""

new_apply = """  function applyFxSetting(): void {
    const selected = fxSelected();
    fxCanvas.hidden = !has2dFx();
    space?.setStarDustVisible(selected.includes('dust'));
    if (!has2dFx()) {
      if (fxRaf) window.cancelAnimationFrame(fxRaf);
      fxRaf = 0;
      if (fxCtx) fxCtx.clearRect(0, 0, fxW, fxH);
      return;
    }
    resizeFxLayer();
    const seeded = (['stars', 'links', 'triangles'] as FxFieldName[]).every(
      (name) => fxFields[name].length > 0,
    );
    if (!seeded) seedFxParticles();
    if (!fxRaf) {
      fxLast = performance.now();
      fxRaf = window.requestAnimationFrame(drawFxFrame);
    }
  }"""

s = rep(s, old_apply, new_apply, "applyFxSetting")

# 9) syncCustomUi：多选高亮 + 汇总标签
s = rep(s,
"""    fxBtns.forEach((button) => {
      button.classList.toggle('is-on', button.dataset.fx === custom.fxMode);
    });
    fxCurrent.textContent = FX_LABEL[custom.fxMode] ?? '关闭';
    fxOptions.hidden = custom.fxMode === 'off';""",
"""    const selectedFx = fxSelected();
    fxBtns.forEach((button) => {
      const value = button.dataset.fx ?? 'off';
      button.classList.toggle('is-on', value === 'off' ? selectedFx.length === 0 : selectedFx.includes(value));
    });
    fxCurrent.textContent = selectedFx.length
      ? selectedFx.map((mode) => FX_LABEL[mode] ?? mode).join(' · ')
      : '关闭';
    fxOptions.hidden = selectedFx.length === 0;""",
"sync fx")

# 10) 点击处理：多选切换
s = rep(s,
"""  fxBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.fx;
      custom.fxMode = value === 'stars' || value === 'links' || value === 'triangles' ? value : 'off';
      syncCustomUi();
      applyFxSetting();
      persistCustom();
    });
  });""",
"""  fxBtns.forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.fx ?? 'off';
      if (value === 'off') {
        custom.fxMode = 'off';
      } else {
        const current = fxSelected();
        const next = current.includes(value)
          ? current.filter((mode) => mode !== value)
          : [...current, value];
        custom.fxMode = next.length ? next.join(',') : 'off';
      }
      syncCustomUi();
      applyFxSetting();
      persistCustom();
    });
  });""",
"fx click")

wr(SPACE, s)

# ---------------- floatScene.ts ----------------
t = ro(SCENE)

t = rep(t,
"  setStarColors(baseColor: string): void;\n",
"  setStarColors(baseColor: string): void;\n  /** 自带星尘是否显示（背景粒子多选里的「自带星尘」开关） */\n  setStarDustVisible(visible: boolean): void;\n",
"api decl")

t = rep(t,
"""  const playStars = new THREE.Points(playStarGeometry, playStarMaterial);
  playStars.visible = false;
  scene.add(playStars);
  let playEnergy = 0;""",
"""  const playStars = new THREE.Points(playStarGeometry, playStarMaterial);
  playStars.visible = false;
  scene.add(playStars);
  let starDustVisible = true;
  let playEnergy = 0;""",
"dust var")

t = rep(t,
"    playStars.visible = playEnergy > 0.01;",
"    playStars.visible = starDustVisible && playEnergy > 0.01;",
"playStars visible")

t = rep(t,
"""      playStarMaterial.uniforms.uStarColorA!.value.copy(base);
      playStarMaterial.uniforms.uStarColorB!.value.copy(soft);
    },""",
"""      playStarMaterial.uniforms.uStarColorA!.value.copy(base);
      playStarMaterial.uniforms.uStarColorB!.value.copy(soft);
    },
    setStarDustVisible(visible: boolean) {
      starDustVisible = visible;
      stars.visible = visible;
      if (!visible) playStars.visible = false;
    },""",
"api impl")

wr(SCENE, t)
print("PATCH-PARTICLES-MULTI-OK")
