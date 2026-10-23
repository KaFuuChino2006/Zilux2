"""粒子自转（每颗粒子自己转，不再整片绕视线轴旋转）+ 磁贴翻页连点不阻塞的 UI 侧修复。"""
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
SCENE = ROOT / "web/src/three/floatScene.ts"
SHELL = ROOT / "web/src/ui/spaceShell.ts"
ok = []


def edit(path: Path, old: str, new: str, tag: str, count: int = 1):
    text = path.read_text(encoding="utf-8")
    assert text.count(old) == count, f"{tag}: expected {count} match, got {text.count(old)}"
    path.write_text(text.replace(old, new), encoding="utf-8")
    ok.append(tag)


# ---------- 1. 星点材质：每颗粒子自转 + 四芒星形状（自转可见） ----------
edit(
    SCENE,
    """  const fxStarMaterial = new THREE.ShaderMaterial({
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
  });""",
    """  const fxStarMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: fxColor },
      uOpacity: { value: fxOpacity },
      uSize: { value: fxSize },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uSpinTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uSize;
      uniform float uPixelRatio;
      uniform float uSpinTime;
      varying float vTwinkle;
      varying float vAngle;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float depth = max(0.7, -mv.z);
        gl_PointSize = (2.4 + aSeed * 4.2) * uSize * uPixelRatio * (8.0 / depth);
        vTwinkle = 0.55 + 0.45 * sin(aSeed * 51.0);
        // 每颗粒子自己的自转角：速度按 seed 各不相同
        vAngle = aSeed * 6.2831853 + uSpinTime * (0.35 + aSeed * 1.65);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vTwinkle;
      varying float vAngle;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float c = cos(vAngle);
        float s = sin(vAngle);
        vec2 r = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
        float armX = (1.0 - smoothstep(0.02, 0.1, abs(r.y))) * (1.0 - smoothstep(0.28, 0.46, abs(r.x)));
        float armY = (1.0 - smoothstep(0.02, 0.1, abs(r.x))) * (1.0 - smoothstep(0.28, 0.46, abs(r.y)));
        float core = smoothstep(0.3, 0.03, length(r));
        float a = (core * 0.55 + (armX + armY) * 0.85) * uOpacity * vTwinkle;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });""",
    "star-shader",
)

# ---------- 2. 三角材质：换成 shader，每颗三角自转 ----------
edit(
    SCENE,
    """  const fxTriangleTexture = (() => {
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
  });""",
    """  const fxTriangleMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: fxColor },
      uOpacity: { value: fxOpacity },
      uSize: { value: fxSize },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uSpinTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uSize;
      uniform float uPixelRatio;
      uniform float uSpinTime;
      varying float vAngle;
      varying float vSeed;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float depth = max(0.7, -mv.z);
        gl_PointSize = (12.0 + aSeed * 9.0) * uSize * uPixelRatio * (7.0 / depth);
        // 每颗三角绕自己的中心自转，转向与速度都按 seed 不同
        vAngle = aSeed * 6.2831853 + uSpinTime * (0.4 + aSeed * 1.4);
        vSeed = aSeed;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAngle;
      varying float vSeed;
      float sdTriangle(vec2 p) {
        const float k = 1.7320508;
        p.x = abs(p.x) - 0.5;
        p.y = -0.5 + p.y + 1.0 / (2.0 * k);
        if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
        p.x -= clamp(p.x, -1.0, 0.0);
        return -length(p) * sign(p.y);
      }
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float c = cos(vAngle);
        float s = sin(vAngle);
        vec2 r = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
        float sd = sdTriangle(r * 2.0 + vec2(0.0, 0.08));
        float fill = smoothstep(0.07, -0.02, sd);
        float edge = smoothstep(0.1, 0.0, abs(sd));
        float a = (fill * 0.26 + edge * 0.92) * uOpacity * (0.6 + vSeed * 0.4);
        if (a < 0.012) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });""",
    "triangle-shader",
)

# ---------- 3. 移除整片绕视线轴旋转，改为累计自转时间 ----------
edit(
    SCENE,
    """  // 鼓点驱动：粒子脉冲缩放、绕视线轴加速旋转、向外爆开
  let bgFxBeat = 0;
  let bgFxBurst = 0;
  const fxForward = new THREE.Vector3();""",
    """  // 鼓点驱动：粒子脉冲缩放、各自自转加速、向外爆开
  let bgFxBeat = 0;
  let bgFxBurst = 0;
  let fxSpinTime = 0;""",
    "fx-state",
)

edit(
    SCENE,
    """    const beatDt = Math.min(0.05, delta);
    bgFxBeat = Math.max(0, bgFxBeat - beatDt * 2.3);
    bgFxBurst = Math.max(0, bgFxBurst - beatDt * 1.6);""",
    """    const beatDt = Math.min(0.05, delta);
    bgFxBeat = Math.max(0, bgFxBeat - beatDt * 2.3);
    bgFxBurst = Math.max(0, bgFxBurst - beatDt * 1.6);
    // 自转累计：鼓点时每颗粒子转得更快，安静时也一直慢慢转
    fxSpinTime += beatDt * (0.5 + bgFxBeat * 2.8);""",
    "fx-spin-accum",
)

edit(
    SCENE,
    """    fxStarMaterial.uniforms.uSize!.value = fxSize * beatSize;
    fxStarMaterial.uniforms.uOpacity!.value = Math.min(1, fxOpacity + bgFxBeat * 0.36);
    fxTriangleMaterial.size = 0.36 * fxSize * beatSize;
    fxTriangleMaterial.opacity = Math.min(1, fxOpacity + bgFxBeat * 0.36);
    fxLinkMaterial.opacity = Math.min(0.8, 0.34 + bgFxBeat * 0.42);""",
    """    fxStarMaterial.uniforms.uSize!.value = fxSize * beatSize;
    fxStarMaterial.uniforms.uOpacity!.value = Math.min(1, fxOpacity + bgFxBeat * 0.36);
    fxStarMaterial.uniforms.uSpinTime!.value = fxSpinTime;
    fxTriangleMaterial.uniforms.uSize!.value = fxSize * beatSize;
    fxTriangleMaterial.uniforms.uOpacity!.value = Math.min(1, fxOpacity + bgFxBeat * 0.36);
    fxTriangleMaterial.uniforms.uSpinTime!.value = fxSpinTime;
    fxTriangleMaterial.uniforms.uPixelRatio!.value = Math.min(window.devicePixelRatio || 1, 2);
    fxLinkMaterial.opacity = Math.min(0.8, 0.34 + bgFxBeat * 0.42);""",
    "fx-uniform-sync",
)

edit(
    SCENE,
    """    camera.getWorldDirection(fxForward);
    const fwdX = fxForward.x;
    const fwdY = fxForward.y;
    const fwdZ = fxForward.z;
    const spinAng = beatDt * (0.05 + bgFxBeat * 2.1);
    const spinCos = Math.cos(spinAng);
    const spinSin = Math.sin(spinAng);
    const spinOne = 1 - spinCos;
""",
    "",
    "fx-forward-drop",
)

edit(
    SCENE,
    """      // 鼓点旋转：整片粒子绕视线轴加速旋转
      const dotF = px * fwdX + py * fwdY + pz * fwdZ;
      const crossX = fwdY * pz - fwdZ * py;
      const crossY = fwdZ * px - fwdX * pz;
      const crossZ = fwdX * py - fwdY * px;
      fxPositions[o] = camX + px * spinCos + crossX * spinSin + fwdX * dotF * spinOne;
      fxPositions[o + 1] = camY + py * spinCos + crossY * spinSin + fwdY * dotF * spinOne;
      fxPositions[o + 2] = camZ + pz * spinCos + crossZ * spinSin + fwdZ * dotF * spinOne;
""",
    "",
    "fx-global-spin-drop",
)

# setBgFx 里的三角材质走 uniforms
edit(
    SCENE,
    """      fxStarMaterial.uniforms.uColor!.value.copy(fxColor);
      fxStarMaterial.uniforms.uOpacity!.value = fxOpacity;
      fxStarMaterial.uniforms.uSize!.value = fxSize;
      fxTriangleMaterial.color.copy(fxColor);
      fxTriangleMaterial.opacity = fxOpacity;
      fxTriangleMaterial.size = 0.36 * fxSize;""",
    """      fxStarMaterial.uniforms.uColor!.value.copy(fxColor);
      fxStarMaterial.uniforms.uOpacity!.value = fxOpacity;
      fxStarMaterial.uniforms.uSize!.value = fxSize;
      fxTriangleMaterial.uniforms.uColor!.value.copy(fxColor);
      fxTriangleMaterial.uniforms.uOpacity!.value = fxOpacity;
      fxTriangleMaterial.uniforms.uSize!.value = fxSize;""",
    "setbggx-uniforms",
)

# ---------- 4. 磁贴翻页：UI 侧不再因为动画中而吞点击 ----------
edit(
    SHELL,
    """  function turnTiles(direction: number): void {
    if (!space) return;
    // 翻页动画/加载中忽略点击（避免连点导致状态错乱）
    if (space.isFlipping() || likedPageBusy) return;""",
    """  function turnTiles(direction: number): void {
    if (!space) return;
    // 翻页动画中继续点：交给场景排队（当前这页加速收尾后立刻接着翻）
    if (likedPageBusy) {
      if (likedViewOpen) {
        likedPendTarget = Math.min(likedPageCount(), Math.max(1, likedPage + direction));
        if (likedPendTarget === likedPage) {
          showToast(direction > 0 ? '已经是最后一页' : '已经是第一页', 'info');
        }
      }
      return;
    }""",
    "turn-guard",
)

edit(
    SHELL,
    """    } finally {
      likedPageBusy = false;
    }
  }

  async function loadLikedTiles(): Promise<void> {""",
    """    } finally {
      likedPageBusy = false;
      const pend = likedPendTarget;
      likedPendTarget = null;
      if (pend !== null && pend !== likedPage) void showLikedPage(pend, true);
    }
  }

  async function loadLikedTiles(): Promise<void> {""",
    "liked-queue-drain",
)

edit(
    SHELL,
    "  let likedPageBusy = false;",
    "  let likedPageBusy = false;\n  let likedPendTarget: number | null = null;",
    "liked-queue-state",
)

print("OK:", ", ".join(ok))
