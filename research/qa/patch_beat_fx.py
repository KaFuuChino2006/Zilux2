# -*- coding: utf-8 -*-
"""鼓点特效：背景圆环绽放 / 烟花粒子；由宿主音频帧的 beat 或低音超阈值触发。"""
import io

fs_path = r"E:\Zilux2开发\web\src\three\floatScene.ts"
ss_path = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"

s = io.open(fs_path, "r", encoding="utf-8", newline="").read()

pairs = [
    # 1) 接口
    ("""  /** 歌词几何遮罩划过（斜带/圆环/菱形掠影），默认开 */
  setLyricSweepEnabled(enabled: boolean): void;""",
     """  /** 歌词几何遮罩划过（斜带/圆环/菱形掠影），默认开 */
  setLyricSweepEnabled(enabled: boolean): void;
  /** 鼓点特效：背景圆环绽放 / 烟花粒子（intensity 0..1.6，colors 用于取色） */
  triggerBeatEffect(kind: 'ring' | 'firework', intensity: number, colors?: string[]): void;"""),

    # 2) 特效实现（插在 frame 之前）
    ("""  function frame(now: number): void {
    if (disposed) return;""",
     """  interface RingBurst {
    mesh: THREE.Mesh;
    life: number;
    duration: number;
    maxScale: number;
    tint: THREE.Color;
  }
  interface SparkBurst {
    points: THREE.Points;
    positions: THREE.BufferAttribute;
    velocities: Float32Array;
    life: number;
    duration: number;
  }
  const ringBursts: RingBurst[] = [];
  const sparkBursts: SparkBurst[] = [];
  let beatFxReady = false;

  function ensureBeatEffects(): void {
    if (beatFxReady) return;
    beatFxReady = true;
    // 圆环绽放池
    for (let i = 0; i < 6; i += 1) {
      const geometry = new THREE.RingGeometry(0.9, 1.0, 72);
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.renderOrder = 25;
      scene.add(mesh);
      ringBursts.push({ mesh, life: 0, duration: 1.1, maxScale: 4, tint: new THREE.Color('#ffffff') });
    }
    // 烟花粒子池
    for (let i = 0; i < 4; i += 1) {
      const count = 72;
      const geometry = new THREE.BufferGeometry();
      const positions = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
      geometry.setAttribute('position', positions);
      const material = new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.085,
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
    }
  }

  function triggerBeatEffect(kind: 'ring' | 'firework', intensity: number, colors?: string[]): void {
    ensureBeatEffects();
    const power = Math.max(0.35, Math.min(1.6, intensity));
    const pick = (): string => {
      if (!colors || colors.length === 0) return '#a99bff';
      return colors[Math.floor(Math.random() * colors.length)] ?? '#a99bff';
    };
    const tint = new THREE.Color(pick());
    if (kind === 'ring') {
      const slot = ringBursts.find((item) => item.life <= 0) ?? ringBursts[0]!;
      slot.life = 1;
      slot.duration = 1.0 + Math.random() * 0.35;
      slot.maxScale = 2.4 + power * 3.2;
      slot.tint.copy(tint);
      const material = slot.mesh.material as THREE.MeshBasicMaterial;
      material.color.copy(tint);
      material.opacity = 0.5 + power * 0.3;
      slot.mesh.position.set(
        (Math.random() - 0.5) * 10.5,
        0.6 + Math.random() * 1.9,
        -1.8 - Math.random() * 2.6,
      );
      slot.mesh.scale.setScalar(0.32);
      slot.mesh.rotation.set(0, 0, 0);
      slot.mesh.visible = true;
    } else {
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
        const speed = (1.1 + Math.random() * 2.1) * (0.65 + power * 0.75);
        slot.velocities[i * 3] = dir.x * speed;
        slot.velocities[i * 3 + 1] = dir.y * speed;
        slot.velocities[i * 3 + 2] = dir.z * speed;
      }
      slot.positions.needsUpdate = true;
      const material = slot.points.material as THREE.PointsMaterial;
      material.color.copy(tint);
      material.opacity = 0.95;
      material.size = 0.08 + power * 0.03;
      slot.points.visible = true;
    }
  }

  function updateBeatEffects(delta: number): void {
    for (const slot of ringBursts) {
      if (slot.life <= 0) continue;
      slot.life -= delta / slot.duration;
      const material = slot.mesh.material as THREE.MeshBasicMaterial;
      if (slot.life <= 0) {
        slot.mesh.visible = false;
        material.opacity = 0;
        continue;
      }
      const t = 1 - slot.life;
      slot.mesh.scale.setScalar(0.32 + t * slot.maxScale);
      slot.mesh.lookAt(camera.position);
      material.opacity = Math.max(0, slot.life) * (0.55 + 0.35 * (1 - t));
    }
    for (const slot of sparkBursts) {
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
    }
  }

  function frame(now: number): void {
    if (disposed) return;"""),

    # 3) 每帧更新（渲染前）
    ("""    updateTiles(delta);
    updateLyrics(delta);""",
     """    updateTiles(delta);
    updateLyrics(delta);
    updateBeatEffects(delta);"""),

    # 4) handle 实现
    ("""    setLyricSweepEnabled(enabled) {
      lyricSweepEnabled = enabled;
      if (!enabled) lyricSweep = -1;
    },""",
     """    setLyricSweepEnabled(enabled) {
      lyricSweepEnabled = enabled;
      if (!enabled) lyricSweep = -1;
    },
    triggerBeatEffect(kind, intensity, colors) {
      triggerBeatEffectInternal(kind, intensity, colors);
    },"""),
]

for old, new in pairs:
    assert s.count(old) == 1, "floatScene anchor: " + old[:60]
    s = s.replace(old, new, 1)

# 由于函数名与 handle 方法同名，改内部函数名避免冲突
s = s.replace("function triggerBeatEffect(kind: 'ring' | 'firework'", "function triggerBeatEffectInternal(kind: 'ring' | 'firework'", 1)

io.open(fs_path, "w", encoding="utf-8", newline="").write(s)
print("floatScene beat effects patched")
