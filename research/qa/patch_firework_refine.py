# -*- coding: utf-8 -*-
"""细化烟花：多种爆炸形态（牡丹/环形/垂柳/双层/闪烁）、每粒独立颜色/大小/闪烁、冲击波环、辉光点精灵。"""
import io

path = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(path, "r", encoding="utf-8", newline="").read()

# 1) 替换 SparkBurst 接口与粒子池创建
old = """  interface SparkBurst {
    points: THREE.Points;
    positions: THREE.BufferAttribute;
    velocities: Float32Array;
    life: number;
    duration: number;
  }
  const ringBursts: RingBurst[] = [];
  const sparkBursts: SparkBurst[] = [];
  let beatFxReady = false;
"""
new = """  interface SparkBurst {
    points: THREE.Points;
    positions: THREE.BufferAttribute;
    velocities: Float32Array;
    colors: THREE.BufferAttribute;
    sizes: THREE.BufferAttribute;
    seeds: THREE.BufferAttribute;
    material: THREE.ShaderMaterial;
    life: number;
    duration: number;
    gravity: number;
  }
  const ringBursts: RingBurst[] = [];
  const sparkBursts: SparkBurst[] = [];
  let beatFxReady = false;
  const SPARK_COUNT = 260;

  function createSparkShader(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uFade: { value: 0 },
        uTime: { value: 0 },
        uPixelRatio: { value: renderer.getPixelRatio() },
      },
      vertexShader: [
        'attribute vec3 aColor;',
        'attribute float aSize;',
        'attribute float aSeed;',
        'uniform float uTime;',
        'uniform float uPixelRatio;',
        'varying vec3 vColor;',
        'varying float vTwinkle;',
        'void main() {',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  gl_Position = projectionMatrix * mv;',
        '  float tw = 0.62 + 0.38 * sin(uTime * (2.4 + aSeed * 2.8) + aSeed * 12.56);',
        '  vTwinkle = 0.7 + 0.6 * tw;',
        '  vColor = aColor;',
        '  gl_PointSize = aSize * uPixelRatio * (52.0 / max(0.6, -mv.z)) * (0.8 + 0.45 * tw);',
        '}',
      ].join('\\n'),
      fragmentShader: [
        'uniform float uFade;',
        'varying vec3 vColor;',
        'varying float vTwinkle;',
        'void main() {',
        '  vec2 uv = gl_PointCoord - 0.5;',
        '  float d = length(uv);',
        '  if (d > 0.5) discard;',
        '  float core = smoothstep(0.34, 0.0, d);',
        '  float glow = smoothstep(0.5, 0.12, d);',
        '  float alpha = (core * 1.0 + glow * 0.5) * uFade * vTwinkle;',
        '  if (alpha < 0.01) discard;',
        '  gl_FragColor = vec4(vColor * (1.2 + 0.9 * core), alpha);',
        '}',
      ].join('\\n'),
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
  }
"""
assert s.count(old) == 1, "spark interface anchor"
s = s.replace(old, new, 1)

# 2) 替换粒子池创建（4×96 -> 6×260 带属性）
old = """    // 烟花粒子池
    for (let i = 0; i < 4; i += 1) {
      const count = 96;
      const geometry = new THREE.BufferGeometry();
      const positions = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
      geometry.setAttribute('position', positions);
      const material = new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.12,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        sizeAttenuation: true,
      });
      const points = new THREE.Points(geometry, material);
      points.visible = false;
      points.renderOrder = 26;
      scene.add(points);
      sparkBursts.push({
        points,
        positions,
        velocities: new Float32Array(count * 3),
        life: 0,
        duration: 1.4,
      });
    }"""
new = """    // 烟花粒子池（每发 260 粒，独立颜色/大小/闪烁）
    for (let i = 0; i < 6; i += 1) {
      const count = SPARK_COUNT;
      const geometry = new THREE.BufferGeometry();
      const positions = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
      const colors = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
      const sizes = new THREE.BufferAttribute(new Float32Array(count), 1);
      const seeds = new THREE.BufferAttribute(new Float32Array(count), 1);
      geometry.setAttribute('position', positions);
      geometry.setAttribute('aColor', colors);
      geometry.setAttribute('aSize', sizes);
      geometry.setAttribute('aSeed', seeds);
      const material = createSparkShader();
      const points = new THREE.Points(geometry, material);
      points.visible = false;
      points.renderOrder = 26;
      scene.add(points);
      sparkBursts.push({
        points,
        positions,
        velocities: new Float32Array(count * 3),
        colors,
        sizes,
        seeds,
        material,
        life: 0,
        duration: 1.4,
        gravity: 1.1,
      });
    }"""
assert s.count(old) == 1, "spark pool anchor"
s = s.replace(old, new, 1)

# 3) 替换 firework 触发分支
old = """    } else {
      const slot = sparkBursts.find((item) => item.life <= 0) ?? sparkBursts[0]!;
      slot.life = 1;
      slot.duration = 1.25 + Math.random() * 0.4;
      const originX = (Math.random() - 0.5) * 9.4;
      const originY = 1.1 + Math.random() * 2.2;
      const originZ = -2.2 - Math.random() * 2.4;
      const count = slot.positions.count;
      for (let i = 0; i < count; i += 1) {
        slot.positions.setXYZ(i, originX, originY, originZ);
        const dir = new THREE.Vector3(
          Math.random() - 0.5,
          Math.random() - 0.5,
          Math.random() - 0.5,
        ).normalize();
        const speed = (1.3 + Math.random() * 2.4) * (0.7 + power * 0.8);
        slot.velocities[i * 3] = dir.x * speed;
        slot.velocities[i * 3 + 1] = dir.y * speed;
        slot.velocities[i * 3 + 2] = dir.z * speed;
      }
      slot.positions.needsUpdate = true;
      const material = slot.points.material as THREE.PointsMaterial;
      material.color.copy(tint);
      material.opacity = 0.95;
      material.size = 0.12 + power * 0.05;
      slot.points.visible = true;
    }"""
new = """    } else {
      const slot = sparkBursts.find((item) => item.life <= 0) ?? sparkBursts[0]!;
      slot.life = 1;
      slot.duration = 1.9 + Math.random() * 0.55;
      const originX = (Math.random() - 0.5) * 8.6;
      const originY = 1.0 + Math.random() * 2.3;
      const originZ = -2.0 - Math.random() * 2.2;
      const count = slot.positions.count;
      const palette = colors && colors.length ? colors : ['#a99bff'];
      const base = new THREE.Color(pick());
      const base2 = new THREE.Color(pick());
      const kind = Math.floor(Math.random() * 5); // 0 牡丹 1 环形 2 垂柳 3 双层 4 闪烁
      slot.gravity = kind === 2 ? 2.4 : 1.15;
      const speedScale = (0.85 + power * 0.85) * (kind === 3 ? 1.15 : 1);
      for (let i = 0; i < count; i += 1) {
        slot.positions.setXYZ(i, originX, originY, originZ);
        // 方向：按不同爆炸形态
        let dx = Math.random() - 0.5;
        let dy = Math.random() - 0.5;
        let dz = Math.random() - 0.5;
        if (kind === 1) {
          // 环形：在一个斜向圆盘上
          const a = Math.random() * Math.PI * 2;
          const tilt = -0.35;
          dx = Math.cos(a);
          dy = Math.sin(a) * Math.cos(tilt);
          dz = Math.sin(a) * Math.sin(tilt);
        } else if (kind === 2) {
          // 垂柳：向上偏置
          dy = Math.random() * 0.9 + 0.15;
        } else if (kind === 3) {
          // 双层：一半外壳一半内壳
          const shell = i % 2 === 0 ? 1.0 : 0.55;
          dx *= shell;
          dy *= shell;
          dz *= shell;
        }
        const dir = new THREE.Vector3(dx, dy, dz).normalize();
        const speed = (1.5 + Math.random() * 3.0) * speedScale;
        slot.velocities[i * 3] = dir.x * speed;
        slot.velocities[i * 3 + 1] = dir.y * speed;
        slot.velocities[i * 3 + 2] = dir.z * speed * 0.55;
        // 颜色：调色板两色渐变 + 少量白色高光星
        const mixColor = Math.random() < 0.18 ? new THREE.Color('#ffffff') : base.clone().lerp(base2, Math.random());
        mixColor.lerp(new THREE.Color('#ffffff'), Math.random() * 0.45);
        slot.colors.setXYZ(i, mixColor.r, mixColor.g, mixColor.b);
        slot.sizes.setX(i, (0.55 + Math.random() * 1.1) * (0.8 + power * 0.4));
        slot.seeds.setX(i, Math.random());
      }
      slot.positions.needsUpdate = true;
      slot.colors.needsUpdate = true;
      slot.sizes.needsUpdate = true;
      slot.seeds.needsUpdate = true;
      slot.material.uniforms.uFade!.value = 1;
      slot.material.uniforms.uTime!.value = 0;
      slot.points.visible = true;
      // 冲击波：爆点同时放一圈快速扩散环
      const shock = ringBursts.find((item) => item.life <= 0);
      if (shock) {
        shock.life = 1;
        shock.duration = 0.7;
        shock.maxScale = 1.1 + power * 1.6;
        const sm = shock.mesh.material as THREE.MeshBasicMaterial;
        sm.color.copy(base);
        sm.opacity = 0.55;
        shock.mesh.position.set(originX, originY, originZ);
        shock.mesh.scale.setScalar(0.3);
        shock.mesh.rotation.set(0, 0, 0);
        shock.mesh.visible = true;
      }
    }"""
assert s.count(old) == 1, "firework trigger anchor"
s = s.replace(old, new, 1)

# 4) 替换 firework 更新分支
old = """    for (const slot of sparkBursts) {
      if (slot.life <= 0) continue;
      slot.life -= delta / slot.duration;
      const material = slot.points.material as THREE.PointsMaterial;
      if (slot.life <= 0) {
        slot.points.visible = false;
        material.opacity = 0;
        continue;
      }
      const array = slot.positions.array as Float32Array;
      const drag = Math.max(0, 1 - delta * 1.4);
      for (let i = 0; i < slot.positions.count; i += 1) {
        array[i * 3] += slot.velocities[i * 3]! * delta;
        array[i * 3 + 1] += slot.velocities[i * 3 + 1]! * delta - delta * 0.6;
        array[i * 3 + 2] += slot.velocities[i * 3 + 2]! * delta;
        slot.velocities[i * 3] = slot.velocities[i * 3]! * drag;
        slot.velocities[i * 3 + 1] = slot.velocities[i * 3 + 1]! * drag;
        slot.velocities[i * 3 + 2] = slot.velocities[i * 3 + 2]! * drag;
      }
      slot.positions.needsUpdate = true;
      material.opacity = Math.max(0, slot.life) * 0.95;
    }"""
new = """    for (const slot of sparkBursts) {
      if (slot.life <= 0) continue;
      slot.life -= delta / slot.duration;
      if (slot.life <= 0) {
        slot.points.visible = false;
        slot.material.uniforms.uFade!.value = 0;
        continue;
      }
      const array = slot.positions.array as Float32Array;
      const drag = Math.max(0, 1 - delta * 1.15);
      const t = 1 - slot.life;
      for (let i = 0; i < slot.positions.count; i += 1) {
        array[i * 3] += slot.velocities[i * 3]! * delta;
        array[i * 3 + 1] += slot.velocities[i * 3 + 1]! * delta;
        array[i * 3 + 2] += slot.velocities[i * 3 + 2]! * delta;
        slot.velocities[i * 3 + 1] = slot.velocities[i * 3 + 1]! - slot.gravity * delta;
        slot.velocities[i * 3] = slot.velocities[i * 3]! * drag;
        slot.velocities[i * 3 + 1] = slot.velocities[i * 3 + 1]! * drag;
        slot.velocities[i * 3 + 2] = slot.velocities[i * 3 + 2]! * drag;
      }
      slot.positions.needsUpdate = true;
      slot.material.uniforms.uFade!.value = Math.min(1, t * 12) * slot.life;
      slot.material.uniforms.uTime!.value += delta;
    }"""
assert s.count(old) == 1, "spark update anchor"
s = s.replace(old, new, 1)

io.open(path, "w", encoding="utf-8", newline="").write(s)
print("refined fireworks patched")
