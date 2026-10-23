"""背景粒子：连线效果重做（带流光的渐变线 + 光点节点），每种效果各自一套调节参数。"""
import re
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
SCENE = ROOT / "web/src/three/floatScene.ts"
SHELL = ROOT / "web/src/ui/spaceShell.ts"
ok = []


def sub(path: Path, pattern: str, repl: str, tag: str, flags=0):
    text = path.read_text(encoding="utf-8")
    new, n = re.subn(pattern, repl, text, count=1, flags=flags)
    assert n == 1, f"{tag}: no match"
    path.write_text(new, encoding="utf-8")
    ok.append(tag)


# ============================ floatScene.ts ============================

# 1) 接口
sub(
    SCENE,
    r"  /\*\* 3D 空间背景粒子：星点 / 连线 / 三角（可叠加），dust 控制内建星尘开关 \*/\n  setBgFx\(config: \{\n    modes: string\[\];\n    count: number;\n    speed: number;\n    size: number;\n    opacity: number;\n    link: number;\n    color\?: string;\n  \}\): void;",
    """  /** 3D 空间背景粒子：星点 / 连线 / 三角 / 内建星尘，每种效果各自一套参数 */
  setBgFx(config: {
    modes?: string[];
    stars?: { count?: number; speed?: number; size?: number; opacity?: number; spin?: number };
    links?: { count?: number; speed?: number; size?: number; opacity?: number; link?: number; flow?: number };
    triangles?: { count?: number; speed?: number; size?: number; opacity?: number; spin?: number };
    dust?: { count?: number; size?: number; brightness?: number; speed?: number };
    color?: string;
  }): void;""",
    "interface",
)

# 2) 星尘材质加可调 uniform
sub(
    SCENE,
    r"      uStarColorA: \{ value: new THREE\.Color\(0x666b99\) \},\n      uStarColorB: \{ value: new THREE\.Color\(0x9e8ffa\) \},\n    \},",
    """      uStarColorA: { value: new THREE.Color(0x666b99) },
      uStarColorB: { value: new THREE.Color(0x9e8ffa) },
      // 自带星尘的可调项：大小 / 亮度 / 漂浮速度
      uDustSize: { value: 1 },
      uDustOpacity: { value: 0.76 },
      uDustSpeed: { value: 1 },
    },""",
    "dust-uniforms",
)
sub(
    SCENE,
    r"      uniform float uTime;\n      uniform float uEnergy;\n      uniform float uPixelRatio;\n      varying float vAlpha;\n      void main\(\) \{\n        vec3 p = position;\n        float drift = 1\.0 \+ uEnergy \* 0\.85;",
    """      uniform float uTime;
      uniform float uEnergy;
      uniform float uPixelRatio;
      uniform float uDustSize;
      uniform float uDustSpeed;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        float drift = (1.0 + uEnergy * 0.85) * uDustSpeed;""",
    "dust-vert",
)
sub(
    SCENE,
    r"        gl_PointSize = \(1\.2 \+ aSeed \* 2\.4\) \* \(1\.0 \+ uEnergy \* 0\.75\) \* uPixelRatio \* \(9\.0 / max\(1\.0, -mv\.z\)\);",
    "        gl_PointSize = (1.2 + aSeed * 2.4) * (1.0 + uEnergy * 0.75) * uPixelRatio * uDustSize * (9.0 / max(1.0, -mv.z));",
    "dust-size",
)
sub(
    SCENE,
    r"      varying float vAlpha;\n      uniform float uEnergy;\n      uniform vec3 uStarColorA;\n      uniform vec3 uStarColorB;\n      void main\(\) \{",
    """      varying float vAlpha;
      uniform float uEnergy;
      uniform float uDustOpacity;
      uniform vec3 uStarColorA;
      uniform vec3 uStarColorB;
      void main() {""",
    "dust-frag-decl",
)
sub(
    SCENE,
    r"        gl_FragColor = vec4\(color, a \* \(0\.55 \+ uEnergy \* 0\.42\)\);",
    "        gl_FragColor = vec4(color, a * (0.55 + uEnergy * 0.42) * uDustOpacity);",
    "dust-frag",
)

# 3) 整块背景粒子实现替换
FX_BLOCK = '''  /* ------------- 背景粒子（3D 空间内，每种效果独立参数） ------------- */
  const FX_MAX = 260;
  const FX_HALF = new THREE.Vector3(18, 11, 18);
  type FxId = 'stars' | 'links' | 'triangles';
  interface FxOpt {
    count: number;
    speed: number;
    size: number;
    opacity: number;
    link: number;
    spin: number;
    flow: number;
  }
  const FX_DEFAULT: Record<FxId, FxOpt> = {
    stars: { count: 110, speed: 1, size: 1, opacity: 0.7, link: 0, spin: 1, flow: 0 },
    links: { count: 90, speed: 0.9, size: 1, opacity: 0.55, link: 8.4, spin: 0, flow: 1 },
    triangles: { count: 60, speed: 1.1, size: 1, opacity: 0.62, link: 0, spin: 1.1, flow: 0 },
  };
  const fxOpts: Record<FxId, FxOpt> = {
    stars: { ...FX_DEFAULT.stars },
    links: { ...FX_DEFAULT.links },
    triangles: { ...FX_DEFAULT.triangles },
  };
  const fxDustOpt = { count: 1300, size: 1, brightness: 0.76, speed: 1 };
  const fxModes: Record<string, boolean> = { stars: false, links: false, triangles: false, dust: true };
  // 鼓点驱动：脉冲缩放、各自自转加速、向外爆开
  let bgFxBeat = 0;
  let bgFxBurst = 0;
  let fxSpinTime = 0;
  const fxColor = new THREE.Color(0x2b3140);

  interface FxPool {
    positions: Float32Array;
    seeds: Float32Array;
    velocity: Float32Array;
    geometry: THREE.BufferGeometry;
  }
  const makeFxPool = (): FxPool => {
    const positions = new Float32Array(FX_MAX * 3);
    const seeds = new Float32Array(FX_MAX);
    const velocity = new Float32Array(FX_MAX * 3);
    for (let i = 0; i < FX_MAX; i += 1) {
      const o = i * 3;
      positions[o] = (Math.random() - 0.5) * FX_HALF.x * 2;
      positions[o + 1] = (Math.random() - 0.5) * FX_HALF.y * 2;
      positions[o + 2] = (Math.random() - 0.5) * FX_HALF.z * 2;
      seeds[i] = Math.random();
      velocity[o] = (Math.random() - 0.5) * 0.22;
      velocity[o + 1] = (Math.random() - 0.5) * 0.16;
      velocity[o + 2] = (Math.random() - 0.5) * 0.22;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.setDrawRange(0, 0);
    return { positions, seeds, velocity, geometry };
  };
  const fxPools: Record<FxId, FxPool> = {
    stars: makeFxPool(),
    links: makeFxPool(),
    triangles: makeFxPool(),
  };

  // 星点：四芒星 SDF，每颗粒子绕自身中心自转
  const fxStarMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: fxColor },
      uOpacity: { value: 0.7 },
      uSize: { value: 1 },
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
  });

  // 三角：SDF 描边三角，每颗独立自转
  const fxTriangleMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: fxColor },
      uOpacity: { value: 0.62 },
      uSize: { value: 1 },
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
  });

  // 连线节点：柔和光点（重做后节点更小更亮，连线由下面的流光材质绘制）
  const fxNodeMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: fxColor },
      uOpacity: { value: 0.55 },
      uSize: { value: 1 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uSize;
      uniform float uPixelRatio;
      varying float vSeed;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float depth = max(0.7, -mv.z);
        gl_PointSize = (2.0 + aSeed * 3.2) * uSize * uPixelRatio * (8.0 / depth);
        vSeed = aSeed;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vSeed;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p);
        float core = smoothstep(0.16, 0.02, d);
        float halo = smoothstep(0.5, 0.06, d) * 0.35;
        float a = (core + halo) * uOpacity * (0.55 + vSeed * 0.45);
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });

  // 连线：距离渐隐 + 沿线流动的光脉冲（重做版）
  const FX_MAX_LINKS = 1400;
  const fxLinePositions = new Float32Array(FX_MAX_LINKS * 6);
  const fxLineFade = new Float32Array(FX_MAX_LINKS * 2);
  const fxLineFlow = new Float32Array(FX_MAX_LINKS * 2);
  const fxLineGeometry = new THREE.BufferGeometry();
  fxLineGeometry.setAttribute('position', new THREE.BufferAttribute(fxLinePositions, 3));
  fxLineGeometry.setAttribute('aFade', new THREE.BufferAttribute(fxLineFade, 1));
  fxLineGeometry.setAttribute('aFlow', new THREE.BufferAttribute(fxLineFlow, 1));
  fxLineGeometry.setDrawRange(0, 0);
  const fxLineMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: fxColor },
      uOpacity: { value: 0.4 },
      uTime: { value: 0 },
      uFlow: { value: 1 },
      uBeat: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aFade;
      attribute float aFlow;
      varying float vFade;
      varying float vFlow;
      void main() {
        vFade = aFade;
        vFlow = aFlow;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uTime;
      uniform float uFlow;
      uniform float uBeat;
      varying float vFade;
      varying float vFlow;
      void main() {
        // 沿线流动的亮度脉冲：像能量在粒子之间传递
        float pulse = 0.55 + 0.45 * sin((vFlow * 2.0 - uTime * uFlow) * 6.2831853);
        // 端点更亮、中段稍暗，形成柔和的光带
        float edge = 0.75 + 0.25 * abs(vFlow - 0.5) * 2.0;
        float a = uOpacity * vFade * pulse * edge * (1.0 + uBeat * 0.55);
        if (a < 0.012) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });

  const fxStars = new THREE.Points(fxPools.stars.geometry, fxStarMaterial);
  const fxTriangles = new THREE.Points(fxPools.triangles.geometry, fxTriangleMaterial);
  const fxNodes = new THREE.Points(fxPools.links.geometry, fxNodeMaterial);
  const fxLinks = new THREE.LineSegments(fxLineGeometry, fxLineMaterial);
  [fxStars, fxTriangles, fxNodes, fxLinks].forEach((object) => {
    object.frustumCulled = false;
  });
  const fxGroup = new THREE.Group();
  fxGroup.add(fxStars, fxTriangles, fxNodes, fxLinks);
  scene.add(fxGroup);

  function applyBgFxVisibility(): void {
    fxStars.visible = fxModes.stars;
    fxTriangles.visible = fxModes.triangles;
    fxNodes.visible = fxModes.links;
    fxLinks.visible = fxModes.links;
    stars.visible = fxModes.dust;
  }

  /** 单个图层的漂移 + 绕相机环绕 + 鼓点外推 */
  function stepFxPool(pool: FxPool, opt: FxOpt, delta: number, seconds: number): number {
    const dt = Math.min(0.05, delta);
    const count = Math.max(0, Math.min(FX_MAX, Math.round(opt.count)));
    const speed = Math.max(0.05, opt.speed);
    const camX = camera.position.x;
    const camY = camera.position.y;
    const camZ = camera.position.z;
    const { positions, seeds, velocity } = pool;
    for (let i = 0; i < count; i += 1) {
      const o = i * 3;
      const seed = seeds[i];
      positions[o] += (velocity[o] * speed + Math.sin(seconds * 0.21 + seed * 31.0) * 0.06 * speed) * dt;
      positions[o + 1] += (velocity[o + 1] * speed + Math.cos(seconds * 0.17 + seed * 23.0) * 0.05 * speed) * dt;
      positions[o + 2] += velocity[o + 2] * speed * dt;
      const dx = positions[o] - camX;
      if (dx > FX_HALF.x) positions[o] -= FX_HALF.x * 2;
      else if (dx < -FX_HALF.x) positions[o] += FX_HALF.x * 2;
      const dy = positions[o + 1] - camY;
      if (dy > FX_HALF.y) positions[o + 1] -= FX_HALF.y * 2;
      else if (dy < -FX_HALF.y) positions[o + 1] += FX_HALF.y * 2;
      const dz = positions[o + 2] - camZ;
      if (dz > FX_HALF.z) positions[o + 2] -= FX_HALF.z * 2;
      else if (dz < -FX_HALF.z) positions[o + 2] += FX_HALF.z * 2;
      if (bgFxBurst > 0.004) {
        const px = positions[o] - camX;
        const py = positions[o + 1] - camY;
        const pz = positions[o + 2] - camZ;
        const plen = Math.sqrt(px * px + py * py + pz * pz) || 1;
        const push = (bgFxBurst * dt * (1.5 + seed * 1.4)) / plen;
        positions[o] += px * push;
        positions[o + 1] += py * push;
        positions[o + 2] += pz * push;
      }
    }
    pool.geometry.setDrawRange(0, count);
    pool.geometry.attributes.position!.needsUpdate = true;
    return count;
  }

  /** 重新计算连线：距离越近越亮，并给每段线写入 0..1 的流动坐标 */
  function rebuildFxLinks(): void {
    const opt = fxOpts.links;
    const positions = fxPools.links.positions;
    const count = Math.max(0, Math.min(FX_MAX, Math.round(opt.count)));
    const maxDist2 = Math.max(0.5, opt.link) ** 2;
    let linkCount = 0;
    for (let i = 0; i < count && linkCount < FX_MAX_LINKS; i += 1) {
      const oi = i * 3;
      for (let j = i + 1; j < count && linkCount < FX_MAX_LINKS; j += 1) {
        const oj = j * 3;
        const dx = positions[oi] - positions[oj];
        const dy = positions[oi + 1] - positions[oj + 1];
        const dz = positions[oi + 2] - positions[oj + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > maxDist2) continue;
        const fade = Math.pow(1 - Math.sqrt(d2 / maxDist2), 0.7);
        const base = linkCount * 6;
        const vtx = linkCount * 2;
        fxLinePositions[base] = positions[oi];
        fxLinePositions[base + 1] = positions[oi + 1];
        fxLinePositions[base + 2] = positions[oi + 2];
        fxLinePositions[base + 3] = positions[oj];
        fxLinePositions[base + 4] = positions[oj + 1];
        fxLinePositions[base + 5] = positions[oj + 2];
        fxLineFade[vtx] = fade;
        fxLineFade[vtx + 1] = fade * 0.86;
        fxLineFlow[vtx] = 0;
        fxLineFlow[vtx + 1] = 1;
        linkCount += 1;
      }
    }
    fxLineGeometry.setDrawRange(0, linkCount * 2);
    fxLineGeometry.attributes.position!.needsUpdate = true;
    fxLineGeometry.attributes.aFade!.needsUpdate = true;
    fxLineGeometry.attributes.aFlow!.needsUpdate = true;
  }

  function updateBgFx(delta: number, seconds: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const beatDt = Math.min(0.05, delta);
    bgFxBeat = Math.max(0, bgFxBeat - beatDt * 2.3);
    bgFxBurst = Math.max(0, bgFxBurst - beatDt * 1.6);
    // 自转累计：鼓点时每颗粒子转得更快，安静时也一直慢慢转
    fxSpinTime += beatDt * (0.5 + bgFxBeat * 2.8);
    const beatSize = 1 + bgFxBeat * 0.6;

    fxStarMaterial.uniforms.uPixelRatio!.value = dpr;
    fxStarMaterial.uniforms.uSize!.value = fxOpts.stars.size * beatSize;
    fxStarMaterial.uniforms.uOpacity!.value = Math.min(1, fxOpts.stars.opacity + bgFxBeat * 0.36);
    fxStarMaterial.uniforms.uSpinTime!.value = fxSpinTime * fxOpts.stars.spin;

    fxTriangleMaterial.uniforms.uPixelRatio!.value = dpr;
    fxTriangleMaterial.uniforms.uSize!.value = fxOpts.triangles.size * beatSize;
    fxTriangleMaterial.uniforms.uOpacity!.value = Math.min(1, fxOpts.triangles.opacity + bgFxBeat * 0.36);
    fxTriangleMaterial.uniforms.uSpinTime!.value = fxSpinTime * fxOpts.triangles.spin;

    fxNodeMaterial.uniforms.uPixelRatio!.value = dpr;
    fxNodeMaterial.uniforms.uSize!.value = fxOpts.links.size * beatSize;
    fxNodeMaterial.uniforms.uOpacity!.value = Math.min(1, fxOpts.links.opacity + bgFxBeat * 0.3);

    fxLineMaterial.uniforms.uTime!.value = seconds;
    fxLineMaterial.uniforms.uFlow!.value = Math.max(0.02, fxOpts.links.flow);
    fxLineMaterial.uniforms.uOpacity!.value = Math.min(0.95, fxOpts.links.opacity * 1.15);
    fxLineMaterial.uniforms.uBeat!.value = bgFxBeat;

    // 自带星尘：数量（drawRange）+ 大小 / 亮度 / 漂浮速度
    starMaterial.uniforms.uDustSize!.value = fxDustOpt.size;
    starMaterial.uniforms.uDustOpacity!.value = Math.max(0, Math.min(1, fxDustOpt.brightness));
    starMaterial.uniforms.uDustSpeed!.value = Math.max(0.05, fxDustOpt.speed);
    starGeometry.setDrawRange(0, Math.max(0, Math.min(STAR_COUNT, Math.round(fxDustOpt.count))));

    if (fxModes.stars) stepFxPool(fxPools.stars, fxOpts.stars, delta, seconds);
    if (fxModes.triangles) stepFxPool(fxPools.triangles, fxOpts.triangles, delta, seconds);
    if (fxModes.links) {
      stepFxPool(fxPools.links, fxOpts.links, delta, seconds);
      rebuildFxLinks();
    }
  }

  applyBgFxVisibility();

'''

sub(SCENE, r"  /\* -{20} 背景粒子（3D 空间内，可多选叠加） -{20} \*/.*?  applyBgFxVisibility\(\);\n\n\n", FX_BLOCK, "fx-block", flags=re.S)

# 4) handle 实现
sub(
    SCENE,
    r"    setBgFx\(config\) \{.*?\n      applyBgFxVisibility\(\);\n    \},\n    setLyricsScale",
    """    setBgFx(config) {
      if (config.modes) {
        const modes = new Set(config.modes);
        fxModes.stars = modes.has('stars');
        fxModes.links = modes.has('links');
        fxModes.triangles = modes.has('triangles');
        fxModes.dust = modes.has('dust');
      }
      if (config.stars) Object.assign(fxOpts.stars, config.stars);
      if (config.links) Object.assign(fxOpts.links, config.links);
      if (config.triangles) Object.assign(fxOpts.triangles, config.triangles);
      if (config.dust) Object.assign(fxDustOpt, config.dust);
      fxOpts.stars.opacity = Math.max(0.02, Math.min(1, fxOpts.stars.opacity));
      fxOpts.links.opacity = Math.max(0.02, Math.min(1, fxOpts.links.opacity));
      fxOpts.triangles.opacity = Math.max(0.02, Math.min(1, fxOpts.triangles.opacity));
      if (config.color) {
        fxColor.set(config.color);
        fxStarMaterial.uniforms.uColor!.value.copy(fxColor);
        fxTriangleMaterial.uniforms.uColor!.value.copy(fxColor);
        fxNodeMaterial.uniforms.uColor!.value.copy(fxColor);
        fxLineMaterial.uniforms.uColor!.value.copy(fxColor);
      }
      applyBgFxVisibility();
    },
    setLyricsScale""",
    "setBgFx-impl",
    flags=re.S,
)

# ============================ spaceShell.ts ============================

FX_HTML = '''            <div class="custom-field">
              <div class="custom-label"><span>背景粒子</span><b data-fx-current>星尘</b></div>
              <div class="custom-seg custom-seg-multi" data-fx-seg>
                <button class="custom-seg-btn" data-fx="stars" type="button">星点</button>
                <button class="custom-seg-btn" data-fx="links" type="button">连线</button>
                <button class="custom-seg-btn" data-fx="triangles" type="button">三角</button>
                <button class="custom-seg-btn is-on" data-fx="dust" type="button">星尘</button>
              </div>
              <div class="custom-sub" data-fx-panel="stars" hidden>
                <div class="custom-label"><span>星点数量</span><b data-fx-val="stars.count">110</b></div>
                <input class="custom-slider" data-fx-opt="stars.count" type="range" min="20" max="220" step="2" value="110" aria-label="星点数量" />
                <div class="custom-label"><span>星点速度</span><b data-fx-val="stars.speed">1.0x</b></div>
                <input class="custom-slider" data-fx-opt="stars.speed" type="range" min="0.2" max="2.4" step="0.1" value="1" aria-label="星点速度" />
                <div class="custom-label"><span>星点大小</span><b data-fx-val="stars.size">1.0x</b></div>
                <input class="custom-slider" data-fx-opt="stars.size" type="range" min="0.4" max="2.6" step="0.1" value="1" aria-label="星点大小" />
                <div class="custom-label"><span>星点透明度</span><b data-fx-val="stars.opacity">70%</b></div>
                <input class="custom-slider" data-fx-opt="stars.opacity" type="range" min="10" max="100" step="5" value="70" aria-label="星点透明度" />
                <div class="custom-label"><span>星点自转</span><b data-fx-val="stars.spin">1.0x</b></div>
                <input class="custom-slider" data-fx-opt="stars.spin" type="range" min="0" max="3" step="0.1" value="1" aria-label="星点自转速度" />
              </div>
              <div class="custom-sub" data-fx-panel="links" hidden>
                <div class="custom-label"><span>连线数量</span><b data-fx-val="links.count">90</b></div>
                <input class="custom-slider" data-fx-opt="links.count" type="range" min="20" max="180" step="2" value="90" aria-label="连线粒子数量" />
                <div class="custom-label"><span>连线速度</span><b data-fx-val="links.speed">0.9x</b></div>
                <input class="custom-slider" data-fx-opt="links.speed" type="range" min="0.2" max="2.4" step="0.1" value="0.9" aria-label="连线粒子速度" />
                <div class="custom-label"><span>节点大小</span><b data-fx-val="links.size">1.0x</b></div>
                <input class="custom-slider" data-fx-opt="links.size" type="range" min="0.4" max="2.6" step="0.1" value="1" aria-label="连线节点大小" />
                <div class="custom-label"><span>连线亮度</span><b data-fx-val="links.opacity">55%</b></div>
                <input class="custom-slider" data-fx-opt="links.opacity" type="range" min="10" max="100" step="5" value="55" aria-label="连线亮度" />
                <div class="custom-label"><span>连线距离</span><b data-fx-val="links.link">8.4</b></div>
                <input class="custom-slider" data-fx-opt="links.link" type="range" min="4" max="18" step="0.4" value="8.4" aria-label="连线触发距离" />
                <div class="custom-label"><span>流光速度</span><b data-fx-val="links.flow">1.0x</b></div>
                <input class="custom-slider" data-fx-opt="links.flow" type="range" min="0" max="2.4" step="0.1" value="1" aria-label="连线流光速度" />
              </div>
              <div class="custom-sub" data-fx-panel="triangles" hidden>
                <div class="custom-label"><span>三角数量</span><b data-fx-val="triangles.count">60</b></div>
                <input class="custom-slider" data-fx-opt="triangles.count" type="range" min="10" max="140" step="2" value="60" aria-label="三角数量" />
                <div class="custom-label"><span>三角速度</span><b data-fx-val="triangles.speed">1.1x</b></div>
                <input class="custom-slider" data-fx-opt="triangles.speed" type="range" min="0.2" max="2.4" step="0.1" value="1.1" aria-label="三角速度" />
                <div class="custom-label"><span>三角大小</span><b data-fx-val="triangles.size">1.0x</b></div>
                <input class="custom-slider" data-fx-opt="triangles.size" type="range" min="0.4" max="2.6" step="0.1" value="1" aria-label="三角大小" />
                <div class="custom-label"><span>三角透明度</span><b data-fx-val="triangles.opacity">62%</b></div>
                <input class="custom-slider" data-fx-opt="triangles.opacity" type="range" min="10" max="100" step="5" value="62" aria-label="三角透明度" />
                <div class="custom-label"><span>三角自转</span><b data-fx-val="triangles.spin">1.1x</b></div>
                <input class="custom-slider" data-fx-opt="triangles.spin" type="range" min="0" max="3" step="0.1" value="1.1" aria-label="三角自转速度" />
              </div>
              <div class="custom-sub" data-fx-panel="dust" hidden>
                <div class="custom-label"><span>星尘数量</span><b data-fx-val="dust.count">1300</b></div>
                <input class="custom-slider" data-fx-opt="dust.count" type="range" min="200" max="1300" step="20" value="1300" aria-label="星尘数量" />
                <div class="custom-label"><span>星尘大小</span><b data-fx-val="dust.size">1.0x</b></div>
                <input class="custom-slider" data-fx-opt="dust.size" type="range" min="0.4" max="2.6" step="0.1" value="1" aria-label="星尘大小" />
                <div class="custom-label"><span>星尘亮度</span><b data-fx-val="dust.brightness">76%</b></div>
                <input class="custom-slider" data-fx-opt="dust.brightness" type="range" min="20" max="100" step="5" value="76" aria-label="星尘亮度" />
                <div class="custom-label"><span>星尘漂浮速度</span><b data-fx-val="dust.speed">1.0x</b></div>
                <input class="custom-slider" data-fx-opt="dust.speed" type="range" min="0.2" max="2.4" step="0.1" value="1" aria-label="星尘漂浮速度" />
              </div>
              <p class="custom-tip">每种效果单独勾选、各自调节：星点 / 连线（近距离自动连线 + 流光）/ 漂浮三角 / 自带星尘，可多选叠加</p>
            </div>'''

sub(
    SHELL,
    r'            <div class="custom-field">\n              <div class="custom-label"><span>背景粒子</span><b data-fx-current>星尘</b></div>.*?              <p class="custom-tip">漂浮在 3D 空间里的粒子层：星点 / 近距离自动连线 / 漂浮三角 / 自带星尘，可多选叠加</p>\n            </div>',
    FX_HTML.replace("\\\\", "\\"),
    "fx-html",
    flags=re.S,
)

FX_QUERY = '''  const fxBtns = root.querySelectorAll<HTMLButtonElement>('[data-fx]');
  const fxCurrent = root.querySelector<HTMLElement>('[data-fx-current]')!;
  const fxInputs = Array.from(root.querySelectorAll<HTMLInputElement>('[data-fx-opt]'));
  const FX_LABEL: Record<string, string> = { stars: '星点', links: '连线', triangles: '三角', dust: '星尘' };
  const FX_UI: Record<string, { min: number; max: number; step: number; unit: string; digits: number }> = {
    'stars.count': { min: 20, max: 220, step: 2, unit: '', digits: 0 },
    'stars.speed': { min: 0.2, max: 2.4, step: 0.1, unit: 'x', digits: 1 },
    'stars.size': { min: 0.4, max: 2.6, step: 0.1, unit: 'x', digits: 1 },
    'stars.opacity': { min: 10, max: 100, step: 5, unit: '%', digits: 0 },
    'stars.spin': { min: 0, max: 3, step: 0.1, unit: 'x', digits: 1 },
    'links.count': { min: 20, max: 180, step: 2, unit: '', digits: 0 },
    'links.speed': { min: 0.2, max: 2.4, step: 0.1, unit: 'x', digits: 1 },
    'links.size': { min: 0.4, max: 2.6, step: 0.1, unit: 'x', digits: 1 },
    'links.opacity': { min: 10, max: 100, step: 5, unit: '%', digits: 0 },
    'links.link': { min: 4, max: 18, step: 0.4, unit: '', digits: 1 },
    'links.flow': { min: 0, max: 2.4, step: 0.1, unit: 'x', digits: 1 },
    'triangles.count': { min: 10, max: 140, step: 2, unit: '', digits: 0 },
    'triangles.speed': { min: 0.2, max: 2.4, step: 0.1, unit: 'x', digits: 1 },
    'triangles.size': { min: 0.4, max: 2.6, step: 0.1, unit: 'x', digits: 1 },
    'triangles.opacity': { min: 10, max: 100, step: 5, unit: '%', digits: 0 },
    'triangles.spin': { min: 0, max: 3, step: 0.1, unit: 'x', digits: 1 },
    'dust.count': { min: 200, max: 1300, step: 20, unit: '', digits: 0 },
    'dust.size': { min: 0.4, max: 2.6, step: 0.1, unit: 'x', digits: 1 },
    'dust.brightness': { min: 20, max: 100, step: 5, unit: '%', digits: 0 },
    'dust.speed': { min: 0.2, max: 2.4, step: 0.1, unit: 'x', digits: 1 },
  };
  function fxBag(group: string): Record<string, number> {
    return (custom.fx as unknown as Record<string, Record<string, number>>)[group];
  }
  function fxValue(path: string): number {
    const [group, field] = path.split('.');
    return fxBag(group)?.[field] ?? 0;
  }
  function setFxValue(path: string, raw: number): void {
    const spec = FX_UI[path];
    const [group, field] = path.split('.');
    const bag = fxBag(group);
    if (!spec || !bag) return;
    const next = Math.min(spec.max, Math.max(spec.min, spec.digits === 0 ? Math.round(raw) : Math.round(raw * 10) / 10));
    bag[field] = next;
    const label = root.querySelector<HTMLElement>('[data-fx-val="' + path + '"]');
    if (label) label.textContent = next.toFixed(spec.digits) + spec.unit;
  }
  function syncFxPanels(): void {
    root.querySelectorAll<HTMLElement>('[data-fx-panel]').forEach((panel) => {
      panel.hidden = !custom.fxModes.includes(panel.dataset.fxPanel ?? '');
    });
  }'''

sub(
    SHELL,
    r"  const fxBtns = root\.querySelectorAll<HTMLButtonElement>\('\[data-fx\]'\);.*?  const FX_LABEL: Record<string, string> = \{ stars: '星点', links: '连线', triangles: '三角', dust: '星尘' \};",
    FX_QUERY,
    "fx-query",
    flags=re.S,
)

sub(
    SHELL,
    r"    fxModes: \['dust'\] as string\[\],\n    fxCount: 90,\n    fxSpeed: 1,\n    fxSize: 1,\n    fxOpacity: 70,\n    fxLink: 140,",
    """    fxModes: ['dust'] as string[],
    fx: {
      stars: { count: 110, speed: 1, size: 1, opacity: 70, spin: 1 },
      links: { count: 90, speed: 0.9, size: 1, opacity: 55, link: 8.4, flow: 1 },
      triangles: { count: 60, speed: 1.1, size: 1, opacity: 62, spin: 1.1 },
      dust: { count: 1300, size: 1, brightness: 76, speed: 1 },
    },""",
    "fx-defaults",
)

sub(
    SHELL,
    r"        fxModes\?: unknown;\n        fxMode\?: unknown;\n        fxCount\?: unknown;\n        fxSpeed\?: unknown;\n        fxSize\?: unknown;\n        fxOpacity\?: unknown;\n        fxLink\?: unknown;",
    """        fxModes?: unknown;
        fxMode?: unknown;
        fx?: unknown;""",
    "fx-partial",
)

FX_LOAD = '''        fx: (() => {
          const fallback = DEFAULT_CUSTOM.fx;
          const raw = parsed.fx as Record<string, unknown> | undefined;
          const read = (group: string, field: string): number => {
            const bag = raw?.[group] as Record<string, unknown> | undefined;
            const spec = FX_UI[group + '.' + field];
            const base = (fallback as unknown as Record<string, Record<string, number>>)[group][field];
            if (!spec) return base;
            const n = Number(bag?.[field]);
            if (!Number.isFinite(n)) return base;
            return Math.min(spec.max, Math.max(spec.min, spec.digits === 0 ? Math.round(n) : Math.round(n * 10) / 10));
          };
          return {
            stars: {
              count: read('stars', 'count'),
              speed: read('stars', 'speed'),
              size: read('stars', 'size'),
              opacity: read('stars', 'opacity'),
              spin: read('stars', 'spin'),
            },
            links: {
              count: read('links', 'count'),
              speed: read('links', 'speed'),
              size: read('links', 'size'),
              opacity: read('links', 'opacity'),
              link: read('links', 'link'),
              flow: read('links', 'flow'),
            },
            triangles: {
              count: read('triangles', 'count'),
              speed: read('triangles', 'speed'),
              size: read('triangles', 'size'),
              opacity: read('triangles', 'opacity'),
              spin: read('triangles', 'spin'),
            },
            dust: {
              count: read('dust', 'count'),
              size: read('dust', 'size'),
              brightness: read('dust', 'brightness'),
              speed: read('dust', 'speed'),
            },
          };
        })(),'''

sub(
    SHELL,
    r"        fxModes: \(\(\) => \{.*?          : DEFAULT_CUSTOM\.fxLink,\n        fx: \(\(\) => \{",
    FX_LOAD,
    "fx-load",
    flags=re.S,
)

FX_APPLY = '''  // ---------- 背景粒子层：3D 空间内的星点 / 连线 / 三角 / 星尘，各自一套参数 ----------
  function applyFxSetting(): void {
    syncFxPanels();
    if (!space) return;
    const gold = root.classList.contains('theme-gold');
    const fx = custom.fx;
    space.setBgFx({
      modes: custom.fxModes,
      color: gold ? '#d9c07a' : '#3a4152',
      stars: {
        count: fx.stars.count,
        speed: fx.stars.speed,
        size: fx.stars.size,
        opacity: fx.stars.opacity / 100,
        spin: fx.stars.spin,
      },
      links: {
        count: fx.links.count,
        speed: fx.links.speed,
        size: fx.links.size,
        opacity: fx.links.opacity / 100,
        link: fx.links.link,
        flow: fx.links.flow,
      },
      triangles: {
        count: fx.triangles.count,
        speed: fx.triangles.speed,
        size: fx.triangles.size,
        opacity: fx.triangles.opacity / 100,
        spin: fx.triangles.spin,
      },
      dust: {
        count: fx.dust.count,
        size: fx.dust.size,
        brightness: fx.dust.brightness / 100,
        speed: fx.dust.speed,
      },
    });
  }

  /** 内建星尘 / 播放光尘的颜色'''

sub(
    SHELL,
    r"  // -{10} 背景粒子层：3D 空间内的星点 / 连线 / 三角（多选叠加） -{10}\n  function applyFxSetting\(\): void \{.*?\n  /\*\* 内建星尘 / 播放光尘的颜色",
    FX_APPLY,
    "fx-apply",
    flags=re.S,
)

FX_SYNC = '''    fxBtns.forEach((button) => {
      button.classList.toggle('is-on', custom.fxModes.includes(button.dataset.fx ?? ''));
    });
    fxCurrent.textContent =
      custom.fxModes.length === 0 ? '关闭' : custom.fxModes.map((mode) => FX_LABEL[mode] ?? mode).join(' · ');
    syncFxPanels();
    fxInputs.forEach((input) => {
      const path = input.dataset.fxOpt ?? '';
      const spec = FX_UI[path];
      if (!spec) return;
      const value = fxValue(path);
      input.value = String(value);
      const label = root.querySelector<HTMLElement>('[data-fx-val="' + path + '"]');
      if (label) label.textContent = value.toFixed(spec.digits) + spec.unit;
    });'''

sub(
    SHELL,
    r"    fxBtns\.forEach\(\(button\) => \{\n      button\.classList\.toggle\('is-on', custom\.fxModes\.includes\(button\.dataset\.fx \?\? ''\)\);\n    \}\);.*?    fxLinkInput\.value = String\(custom\.fxLink\);\n    fxLinkCurrent\.textContent = String\(custom\.fxLink\);",
    FX_SYNC,
    "fx-sync",
    flags=re.S,
)

FX_HANDLERS = '''  fxBtns.forEach((button) => {
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
  });
  // 每种粒子效果各自的滑条
  fxInputs.forEach((input) => {
    input.addEventListener('input', () => {
      const path = input.dataset.fxOpt ?? '';
      if (!FX_UI[path]) return;
      setFxValue(path, Number(input.value));
      applyFxSetting();
      persistCustom();
    });
  });
  // 内建星尘 / 播放光尘的颜色：紫 / 跟随封面色 / 自定义'''

sub(
    SHELL,
    r"  fxBtns\.forEach\(\(button\) => \{\n    button\.addEventListener\('click', \(\) => \{\n      const value = button\.dataset\.fx;.*?  // 内建星尘 / 播放光尘的颜色：紫 / 跟随封面色 / 自定义",
    FX_HANDLERS,
    "fx-handlers",
    flags=re.S,
)

print("OK:", ", ".join(ok))
