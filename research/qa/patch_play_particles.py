# -*- coding: utf-8 -*-
"""播放时增强背景粒子：星尘提亮加速 + 新增一层播放粒子。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

def rep(old, new, cnt=1):
    global s
    assert s.count(old) == cnt, (s.count(old), old[:80])
    s = s.replace(old, new, cnt)

# 1) 星尘材质：加能量 uniform（播放时更亮、更大、更活跃）
rep("""    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        p.y += sin(uTime * 0.16 + aSeed * 6.283) * 0.3;
        p.x += cos(uTime * 0.1 + aSeed * 4.0) * 0.24;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float twinkle = 0.5 + 0.5 * sin(uTime * 0.8 + aSeed * 30.0);
        vAlpha = twinkle * smoothstep(26.0, 5.0, -mv.z);
        gl_PointSize = (1.2 + aSeed * 2.4) * uPixelRatio * (9.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        float a = smoothstep(0.5, 0.05, d) * vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(0.4, 0.42, 0.6, a * 0.55);
      }
    `,
  });""",
"""    uniforms: {
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uEnergy;
      uniform float uPixelRatio;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        float drift = 1.0 + uEnergy * 0.85;
        p.y += sin(uTime * 0.16 * drift + aSeed * 6.283) * (0.3 + uEnergy * 0.42);
        p.x += cos(uTime * 0.1 * drift + aSeed * 4.0) * (0.24 + uEnergy * 0.34);
        p.z += sin(uTime * 0.13 * drift + aSeed * 9.2) * uEnergy * 0.3;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float twinkle = 0.5 + 0.5 * sin(uTime * (0.8 + uEnergy * 1.5) + aSeed * 30.0);
        vAlpha = twinkle * smoothstep(26.0, 5.0, -mv.z) * (1.0 + uEnergy * 0.55);
        gl_PointSize = (1.2 + aSeed * 2.4) * (1.0 + uEnergy * 0.75) * uPixelRatio * (9.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      uniform float uEnergy;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        float a = smoothstep(0.5, 0.05, d) * min(1.0, vAlpha);
        if (a < 0.01) discard;
        vec3 color = mix(vec3(0.4, 0.42, 0.6), vec3(0.62, 0.56, 0.98), uEnergy * 0.85);
        gl_FragColor = vec4(color, a * (0.55 + uEnergy * 0.42));
      }
    `,
  });""")

# 2) 新增播放粒子层（插在 stars 之后）
rep("""  const stars = new THREE.Points(starGeometry, starMaterial);
  scene.add(stars);""",
"""  const stars = new THREE.Points(starGeometry, starMaterial);
  scene.add(stars);

  // 播放时额外浮现的一层「光尘」：更亮、更靠前、带上升流动
  const PLAY_STAR_COUNT = 900;
  const playStarPositions = new Float32Array(PLAY_STAR_COUNT * 3);
  const playStarSeeds = new Float32Array(PLAY_STAR_COUNT);
  for (let i = 0; i < PLAY_STAR_COUNT; i += 1) {
    const radius = 2.5 + Math.random() * 12;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    playStarPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    playStarPositions[i * 3 + 1] = radius * Math.cos(phi) * 0.55 - 0.4;
    playStarPositions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta) + 1.5;
    playStarSeeds[i] = Math.random();
  }
  const playStarGeometry = new THREE.BufferGeometry();
  playStarGeometry.setAttribute('position', new THREE.BufferAttribute(playStarPositions, 3));
  playStarGeometry.setAttribute('aSeed', new THREE.BufferAttribute(playStarSeeds, 1));
  const playStarMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uEnergy;
      uniform float uPixelRatio;
      varying float vAlpha;
      varying float vSeed;
      void main() {
        vec3 p = position;
        // 缓慢上升 + 侧向漂浮
        p.y += mod(uTime * (0.18 + aSeed * 0.22), 6.0) - 1.4;
        p.x += sin(uTime * (0.22 + aSeed * 0.3) + aSeed * 12.0) * 0.42;
        p.z += cos(uTime * (0.18 + aSeed * 0.26) + aSeed * 8.0) * 0.36;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float pulse = 0.55 + 0.45 * sin(uTime * (1.4 + uEnergy * 2.2) + aSeed * 40.0);
        vAlpha = pulse * smoothstep(24.0, 4.0, -mv.z) * uEnergy;
        vSeed = aSeed;
        gl_PointSize = (2.0 + aSeed * 3.2) * (1.0 + uEnergy * 0.6) * uPixelRatio * (10.0 / max(1.0, -mv.z));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying float vSeed;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        float a = smoothstep(0.5, 0.0, d) * vAlpha;
        if (a < 0.005) discard;
        vec3 color = mix(vec3(0.55, 0.62, 1.0), vec3(0.85, 0.62, 1.0), vSeed);
        gl_FragColor = vec4(color, a * 0.85);
      }
    `,
  });
  const playStars = new THREE.Points(playStarGeometry, playStarMaterial);
  playStars.visible = false;
  scene.add(playStars);
  let playEnergy = 0;
  let playEnergyTarget = 0;""")

# 3) frame 中更新能量 + uTime
rep("    starMaterial.uniforms.uTime!.value = seconds;",
"""    starMaterial.uniforms.uTime!.value = seconds;
    playEnergy += (playEnergyTarget - playEnergy) * Math.min(1, delta * 1.7);
    starMaterial.uniforms.uEnergy!.value = playEnergy;
    playStarMaterial.uniforms.uTime!.value = seconds;
    playStarMaterial.uniforms.uEnergy!.value = playEnergy;
    playStars.visible = playEnergy > 0.01;""")

# 4) pixelRatio 同步
rep("    starMaterial.uniforms.uPixelRatio!.value = pr;",
"""    starMaterial.uniforms.uPixelRatio!.value = pr;
    playStarMaterial.uniforms.uPixelRatio!.value = pr;""")

# 5) handle: setPlaying
rep("    setTileBend(bend: number) {",
"""    setPlaying(playing: boolean) {
      playEnergyTarget = playing ? 1 : 0;
    },
    setTileBend(bend: number) {""")

# 6) dispose
rep("      starMaterial.dispose();",
"""      starMaterial.dispose();
      playStarGeometry.dispose();
      playStarMaterial.dispose();""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('play particle layer added')
