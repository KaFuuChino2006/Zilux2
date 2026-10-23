# -*- coding: utf-8 -*-
"""背景粒子改为 3D 空间内的实体（星点/连线/三角可多选 + 内建星尘集成）。"""
import io, sys

SCENE = r"E:\Zilux2开发\web\src\three\floatScene.ts"
SHELL = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"


def read(p):
    with io.open(p, "r", encoding="utf-8") as f:
        return f.read()


def write(p, s):
    with io.open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)


def rep(text, old, new, path, count=1):
    n = text.count(old)
    if n != count:
        sys.stderr.write("MISMATCH %s count=%d expected=%d\n---\n%s\n" % (path, n, count, old[:400]))
        raise SystemExit(1)
    return text.replace(old, new)


# ============================================================ floatScene
scene = read(SCENE)

FX_BLOCK = r'''
  /* -------------------- 背景粒子（3D 空间内，可多选叠加） -------------------- */
  const FX_MAX = 220;
  const FX_HALF = new THREE.Vector3(18, 11, 18);
  const fxPositions = new Float32Array(FX_MAX * 3);
  const fxSeeds = new Float32Array(FX_MAX);
  const fxVelocity = new Float32Array(FX_MAX * 3);
  const fxGeometry = new THREE.BufferGeometry();
  fxGeometry.setAttribute('position', new THREE.BufferAttribute(fxPositions, 3));
  fxGeometry.setAttribute('aSeed', new THREE.BufferAttribute(fxSeeds, 1));
  const fxModes: Record<string, boolean> = { stars: false, links: false, triangles: false, dust: true };
  let fxCount = 0;
  let fxSpeed = 1;
  let fxSize = 1;
  let fxOpacity = 0.7;
  let fxLinkDist = 7.8;
  const fxColor = new THREE.Color(0x2b3140);
  const fxStarMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: fxColor },
      uOpacity: { value: fxOpacity },
      uSize: { value: fxSize },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uSize;
      uniform float uPixelRatio;
      varying float vTwinkle;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float depth = max(0.7, -mv.z);
        gl_PointSize = (1.5 + aSeed * 2.6) * uSize * uPixelRatio * (8.0 / depth);
        vTwinkle = 0.55 + 0.45 * sin(aSeed * 51.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vTwinkle;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        float a = smoothstep(0.5, 0.06, d) * uOpacity * vTwinkle;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
  const fxStars = new THREE.Points(fxGeometry, fxStarMaterial);
  fxStars.frustumCulled = false;
  const fxTriangleTexture = (() => {
    const size = 64;
    const canvasEl = document.createElement('canvas');
    canvasEl.width = size;
    canvasEl.height = size;
    const ctx = canvasEl.getContext('2d')!;
    const r = size * 0.34;
    ctx.beginPath();
    ctx.moveTo(size / 2, size / 2 - r);
    ctx.lineTo(size / 2 + r * 0.87, size / 2 + r * 0.5);
    ctx.lineTo(size / 2 - r * 0.87, size / 2 + r * 0.5);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fill();
    ctx.lineWidth = 4.5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.stroke();
    const texture = new THREE.CanvasTexture(canvasEl);
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  })();
  const fxTriangleMaterial = new THREE.PointsMaterial({
    map: fxTriangleTexture,
    transparent: true,
    depthWrite: false,
    size: 0.36,
    sizeAttenuation: true,
    opacity: fxOpacity,
    color: fxColor,
  });
  const fxTriangles = new THREE.Points(fxGeometry, fxTriangleMaterial);
  fxTriangles.frustumCulled = false;
  const FX_MAX_PAIRS = (FX_MAX * (FX_MAX - 1)) / 2;
  const fxLinkPositions = new Float32Array(FX_MAX_PAIRS * 6);
  const fxLinkGeometry = new THREE.BufferGeometry();
  fxLinkGeometry.setAttribute('position', new THREE.BufferAttribute(fxLinkPositions, 3));
  fxLinkGeometry.setDrawRange(0, 0);
  const fxLinkMaterial = new THREE.LineBasicMaterial({
    color: fxColor,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  });
  const fxLinks = new THREE.LineSegments(fxLinkGeometry, fxLinkMaterial);
  fxLinks.frustumCulled = false;
  const fxGroup = new THREE.Group();
  fxGroup.add(fxStars, fxTriangles, fxLinks);
  scene.add(fxGroup);

  function seedBgFx(): void {
    for (let i = 0; i < FX_MAX; i += 1) {
      const o = i * 3;
      fxPositions[o] = (Math.random() - 0.5) * FX_HALF.x * 2;
      fxPositions[o + 1] = (Math.random() - 0.5) * FX_HALF.y * 2;
      fxPositions[o + 2] = (Math.random() - 0.5) * FX_HALF.z * 2;
      fxSeeds[i] = Math.random();
      fxVelocity[o] = (Math.random() - 0.5) * 0.22;
      fxVelocity[o + 1] = (Math.random() - 0.5) * 0.16;
      fxVelocity[o + 2] = (Math.random() - 0.5) * 0.22;
    }
    fxGeometry.attributes.aSeed!.needsUpdate = true;
    fxGeometry.attributes.position!.needsUpdate = true;
  }

  function applyBgFxVisibility(): void {
    const showPoints = fxModes.stars || fxModes.links;
    fxStars.visible = showPoints;
    fxLinks.visible = fxModes.links;
    fxTriangles.visible = fxModes.triangles;
    stars.visible = fxModes.dust;
  }

  function updateBgFx(delta: number, seconds: number): void {
    fxStarMaterial.uniforms.uPixelRatio!.value = Math.min(window.devicePixelRatio || 1, 2);
    if (fxCount <= 0) return;
    const active = fxModes.stars || fxModes.links || fxModes.triangles;
    if (!active) return;
    const dt = Math.min(0.05, delta);
    const camX = camera.position.x;
    const camY = camera.position.y;
    const camZ = camera.position.z;
    for (let i = 0; i < fxCount; i += 1) {
      const o = i * 3;
      const seed = fxSeeds[i];
      fxPositions[o] +=
        (fxVelocity[o] * fxSpeed + Math.sin(seconds * 0.21 + seed * 31.0) * 0.06 * fxSpeed) * dt;
      fxPositions[o + 1] +=
        (fxVelocity[o + 1] * fxSpeed + Math.cos(seconds * 0.17 + seed * 23.0) * 0.05 * fxSpeed) * dt;
      fxPositions[o + 2] += fxVelocity[o + 2] * fxSpeed * dt;
      const dx = fxPositions[o] - camX;
      if (dx > FX_HALF.x) fxPositions[o] -= FX_HALF.x * 2;
      else if (dx < -FX_HALF.x) fxPositions[o] += FX_HALF.x * 2;
      const dy = fxPositions[o + 1] - camY;
      if (dy > FX_HALF.y) fxPositions[o + 1] -= FX_HALF.y * 2;
      else if (dy < -FX_HALF.y) fxPositions[o + 1] += FX_HALF.y * 2;
      const dz = fxPositions[o + 2] - camZ;
      if (dz > FX_HALF.z) fxPositions[o + 2] -= FX_HALF.z * 2;
      else if (dz < -FX_HALF.z) fxPositions[o + 2] += FX_HALF.z * 2;
    }
    fxGeometry.attributes.position!.needsUpdate = true;
    if (!fxModes.links) return;
    const maxDist2 = fxLinkDist * fxLinkDist;
    let linkCount = 0;
    outer: for (let i = 0; i < fxCount; i += 1) {
      const oi = i * 3;
      for (let j = i + 1; j < fxCount; j += 1) {
        const oj = j * 3;
        const dx = fxPositions[oi] - fxPositions[oj];
        const dy = fxPositions[oi + 1] - fxPositions[oj + 1];
        const dz = fxPositions[oi + 2] - fxPositions[oj + 2];
        if (dx * dx + dy * dy + dz * dz > maxDist2) continue;
        const base = linkCount * 6;
        fxLinkPositions[base] = fxPositions[oi];
        fxLinkPositions[base + 1] = fxPositions[oi + 1];
        fxLinkPositions[base + 2] = fxPositions[oi + 2];
        fxLinkPositions[base + 3] = fxPositions[oj];
        fxLinkPositions[base + 4] = fxPositions[oj + 1];
        fxLinkPositions[base + 5] = fxPositions[oj + 2];
        linkCount += 1;
        if (linkCount >= FX_MAX_PAIRS) break outer;
      }
    }
    fxLinkGeometry.setDrawRange(0, linkCount * 2);
    fxLinkGeometry.attributes.position!.needsUpdate = true;
  }

  seedBgFx();
  fxGeometry.setDrawRange(0, 0);
  applyBgFxVisibility();

'''

scene = rep(
    scene,
    "  let playEnergy = 0;\n  let playEnergyTarget = 0;\n",
    "  let playEnergy = 0;\n  let playEnergyTarget = 0;\n" + FX_BLOCK,
    SCENE,
)

# handle interface
scene = rep(
    scene,
    "  /** 自带星尘/播放光尘的主色（十六进制），系统会据此派生暗部与亮部两档 */\n  setStarColors(baseColor: string): void;\n",
    "  /** 自带星尘/播放光尘的主色（十六进制），系统会据此派生暗部与亮部两档 */\n  setStarColors(baseColor: string): void;\n"
    "  /** 3D 空间背景粒子：星点 / 连线 / 三角（可叠加），dust 控制内建星尘开关 */\n"
    "  setBgFx(config: {\n"
    "    modes: string[];\n"
    "    count: number;\n"
    "    speed: number;\n"
    "    size: number;\n"
    "    opacity: number;\n"
    "    link: number;\n"
    "    color?: string;\n"
    "  }): void;\n",
    SCENE,
)

# handle implementation
scene = rep(
    scene,
    "      playStarMaterial.uniforms.uStarColorA!.value.copy(base);\n      playStarMaterial.uniforms.uStarColorB!.value.copy(soft);\n    },\n",
    "      playStarMaterial.uniforms.uStarColorA!.value.copy(base);\n      playStarMaterial.uniforms.uStarColorB!.value.copy(soft);\n    },\n"
    "    setBgFx(config) {\n"
    "      const modes = new Set(config.modes);\n"
    "      fxModes.stars = modes.has('stars');\n"
    "      fxModes.links = modes.has('links');\n"
    "      fxModes.triangles = modes.has('triangles');\n"
    "      fxModes.dust = modes.has('dust');\n"
    "      const nextCount = Math.max(0, Math.min(FX_MAX, Math.round(config.count)));\n"
    "      if (nextCount !== fxCount) {\n"
    "        fxCount = nextCount;\n"
    "        fxGeometry.setDrawRange(0, fxCount);\n"
    "      }\n"
    "      fxSpeed = Math.max(0.1, config.speed);\n"
    "      fxSize = Math.max(0.1, config.size);\n"
    "      fxOpacity = Math.max(0.02, Math.min(1, config.opacity));\n"
    "      fxLinkDist = Math.max(0.6, config.link);\n"
    "      if (config.color) fxColor.set(config.color);\n"
    "      fxStarMaterial.uniforms.uColor!.value.copy(fxColor);\n"
    "      fxStarMaterial.uniforms.uOpacity!.value = fxOpacity;\n"
    "      fxStarMaterial.uniforms.uSize!.value = fxSize;\n"
    "      fxTriangleMaterial.color.copy(fxColor);\n"
    "      fxTriangleMaterial.opacity = fxOpacity;\n"
    "      fxTriangleMaterial.size = 0.36 * fxSize;\n"
    "      fxLinkMaterial.color.copy(fxColor);\n"
    "      fxLinkMaterial.opacity = 0.3 * fxOpacity;\n"
    "      applyBgFxVisibility();\n"
    "    },\n",
    SCENE,
)

# render loop
scene = rep(
    scene,
    "    playStars.visible = playEnergy > 0.01;\n",
    "    playStars.visible = playEnergy > 0.01;\n    updateBgFx(delta, seconds);\n",
    SCENE,
)

write(SCENE, scene)

# ============================================================ spaceShell
shell = read(SHELL)

# 1. remove 2D canvas element
shell = rep(
    shell,
    '    <canvas class="space-fx" data-space-fx aria-hidden="true"></canvas>\n',
    "",
    SHELL,
)

# 2. multi-select HTML
shell = rep(
    shell,
    '''            <div class="custom-field">
              <div class="custom-label"><span>背景粒子</span><b data-fx-current>关闭</b></div>
              <div class="custom-seg" data-fx-seg>
                <button class="custom-seg-btn is-on" data-fx="off" type="button">关</button>
                <button class="custom-seg-btn" data-fx="stars" type="button">星点</button>
                <button class="custom-seg-btn" data-fx="links" type="button">连线</button>
                <button class="custom-seg-btn" data-fx="triangles" type="button">三角</button>
              </div>''',
    '''            <div class="custom-field">
              <div class="custom-label"><span>背景粒子</span><b data-fx-current>星尘</b></div>
              <div class="custom-seg" data-fx-seg>
                <button class="custom-seg-btn" data-fx="stars" type="button">星点</button>
                <button class="custom-seg-btn" data-fx="links" type="button">连线</button>
                <button class="custom-seg-btn" data-fx="triangles" type="button">三角</button>
                <button class="custom-seg-btn is-on" data-fx="dust" type="button">星尘</button>
              </div>''',
    SHELL,
)
shell = rep(
    shell,
    "              <p class=\"custom-tip\">磁贴后方的粒子层：星点漂浮 / 近距离自动连线 / 漂浮三角</p>",
    "              <p class=\"custom-tip\">漂浮在 3D 空间里的粒子层：星点 / 近距离自动连线 / 漂浮三角 / 自带星尘，可多选叠加</p>",
    SHELL,
)

# 3. queries
shell = rep(
    shell,
    "  const fxCanvas = root.querySelector<HTMLCanvasElement>('[data-space-fx]')!;\n  const fxCtx = fxCanvas.getContext('2d');\n",
    "",
    SHELL,
)
shell = rep(
    shell,
    "  const FX_LABEL: Record<string, string> = { off: '关闭', stars: '星点', links: '连线', triangles: '三角' };",
    "  const FX_LABEL: Record<string, string> = { stars: '星点', links: '连线', triangles: '三角', dust: '星尘' };",
    SHELL,
)

# 4. defaults
shell = rep(
    shell,
    "    fxMode: 'off' as 'off' | 'stars' | 'links' | 'triangles',",
    "    fxModes: ['dust'] as string[],",
    SHELL,
)

# 5. load type + parse
shell = rep(
    shell,
    "        fxMode?: unknown;",
    "        fxModes?: unknown;\n        fxMode?: unknown;",
    SHELL,
)
shell = rep(
    shell,
    """        fxMode:
          parsed.fxMode === 'stars' || parsed.fxMode === 'links' || parsed.fxMode === 'triangles'
            ? parsed.fxMode
            : 'off',""",
    """        fxModes: (() => {
          const allowed = new Set(['stars', 'links', 'triangles', 'dust']);
          if (Array.isArray(parsed.fxModes)) {
            return parsed.fxModes.filter((m): m is string => typeof m === 'string' && allowed.has(m));
          }
          if (parsed.fxMode === 'stars' || parsed.fxMode === 'links' || parsed.fxMode === 'triangles') {
            return [parsed.fxMode];
          }
          return [...DEFAULT_CUSTOM.fxModes];
        })(),""",
    SHELL,
)

# 6. replace 2D engine block
START = "  // ---------- 背景粒子层：星点 / 连线网络 / 漂浮三角 ----------\n"
END = "  /** 内建星尘 / 播放光尘的颜色：紫（默认）/ 跟随封面色 / 自定义 */\n"
i = shell.index(START)
j = shell.index(END, i)
NEW_FX = '''  // ---------- 背景粒子层：3D 空间内的星点 / 连线 / 三角（多选叠加） ----------
  function applyFxSetting(): void {
    const modes = custom.fxModes;
    fxOptions.hidden = modes.length === 0;
    if (!space) return;
    const gold = root.classList.contains('theme-gold');
    space.setBgFx({
      modes,
      count: custom.fxCount,
      speed: custom.fxSpeed,
      size: custom.fxSize,
      opacity: custom.fxOpacity / 100,
      link: custom.fxLink / 14,
      color: gold ? '#d9c07a' : '#3a4152',
    });
  }

'''
shell = shell[:i] + NEW_FX + shell[j:]

# 7. syncCustomUi
shell = rep(
    shell,
    """    fxBtns.forEach((button) => {
      button.classList.toggle('is-on', button.dataset.fx === custom.fxMode);
    });
    fxCurrent.textContent = FX_LABEL[custom.fxMode] ?? '关闭';
    fxOptions.hidden = custom.fxMode === 'off';""",
    """    fxBtns.forEach((button) => {
      button.classList.toggle('is-on', custom.fxModes.includes(button.dataset.fx ?? ''));
    });
    fxCurrent.textContent =
      custom.fxModes.length === 0 ? '关闭' : custom.fxModes.map((mode) => FX_LABEL[mode] ?? mode).join(' · ');
    fxOptions.hidden = custom.fxModes.length === 0;""",
    SHELL,
)

# 8. handlers
shell = rep(
    shell,
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
      const value = button.dataset.fx;
      if (value !== 'stars' && value !== 'links' && value !== 'triangles' && value !== 'dust') return;
      const next = new Set(custom.fxModes);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      custom.fxModes = [...next];
      syncCustomUi();
      applyFxSetting();
      persistCustom();
    });
  });""",
    SHELL,
)

# 9. count slider
shell = rep(
    shell,
    "    fxCountCurrent.textContent = String(custom.fxCount);\n    seedFxParticles();\n    persistCustom();",
    "    fxCountCurrent.textContent = String(custom.fxCount);\n    applyFxSetting();\n    persistCustom();",
    SHELL,
)

# 10. resize listener
shell = rep(
    shell,
    """    if (!customSheet.hidden && customSheet.classList.contains('is-open')) positionCustomSheet();
    if (fxRaf) {
      resizeFxLayer();
      seedFxParticles();
    }
""",
    """    if (!customSheet.hidden && customSheet.classList.contains('is-open')) positionCustomSheet();
""",
    SHELL,
)

# 11. theme click -> refresh 3D particle colors
shell = rep(
    shell,
    """      applyThemeUi();
      setStatus(next === 'gold' ? '已切换为黑金配色' : '已切换为白磨砂配色');""",
    """      applyThemeUi();
      applyFxSetting();
      setStatus(next === 'gold' ? '已切换为黑金配色' : '已切换为白磨砂配色');""",
    SHELL,
)

write(SHELL, shell)
print("PATCH-OK")
