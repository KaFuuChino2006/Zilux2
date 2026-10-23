"""给鼓点特效的「圆环」加多种绽放样式与图形。

做法：
1) 新增 15 种绽放图形的 canvas 贴图（圆环/细环/虚线环/花瓣环/六边/三角/方/菱/五角/六角/十字/齿轮/星芒/弧光/心形）；
2) 新增 16 套绽放样式（图形 + 数量 + 时长 + 缩放 + 旋转 + 缓动 + 层间错开）；
3) 触发时随机挑样式，多层错开大小/时长；池子从 10 个槽加到 16 个，贴图在触发时替换。
"""
from pathlib import Path

TARGET = Path(r"E:\Zilux2开发\web\src\three\floatScene.ts")
src = TARGET.read_text(encoding="utf-8")


def rep(old: str, new: str, label: str, count: int = 1) -> None:
    global src
    found = src.count(old)
    if found != count:
        raise SystemExit(f"FAIL {label}: count={found} (expect {count})")
    src = src.replace(old, new, count)
    print(f"OK {label}")


def splice(start_marker: str, end_marker: str, new_text: str, label: str) -> None:
    """把 [start_marker, end_marker]（含两端）整段替换成 new_text。"""
    global src
    start = src.find(start_marker)
    if start < 0:
        raise SystemExit(f"FAIL {label}: start not found")
    end = src.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"FAIL {label}: end not found")
    end += len(end_marker)
    src = src[:start] + new_text + src[end:]
    print(f"OK {label}")


# ---------- 1. 池子槽数据结构：补缓动/淡入/基础透明度 ----------
rep(
    """  interface RingBurst {
    mesh: THREE.Mesh;
    life: number;
    duration: number;
    maxScale: number;
    startScale: number;
    tint: THREE.Color;
    spin: number;
    angle: number;
  }""",
    """  interface RingBurst {
    mesh: THREE.Mesh;
    life: number;
    duration: number;
    maxScale: number;
    startScale: number;
    tint: THREE.Color;
    spin: number;
    angle: number;
    /** 缩放缓动：0 外扩、1 平滑、2 回弹、3 内收、4 线性 */
    ease: number;
    /** 前段淡入占比，避免一出现就闪 */
    fadeIn: number;
    /** 这一层的基础不透明度（后面再乘淡入淡出） */
    baseOpacity: number;
  }""",
    "RingBurst fields",
)

# ---------- 2. 贴图工厂 + 样式表（替换旧的单一圆环贴图） ----------
NEW_BLOCK = r'''  /** 绽放图形：每种形状单独画一张白色贴图，触发时按样式挑 */
  type BurstShape =
    | 'ring'
    | 'ringThin'
    | 'ringDashed'
    | 'ringPetals'
    | 'hex'
    | 'triangle'
    | 'square'
    | 'diamond'
    | 'star5'
    | 'star6'
    | 'cross'
    | 'gear'
    | 'sparkle'
    | 'arc'
    | 'heart';

  const burstTextureMap = new Map<BurstShape, THREE.CanvasTexture>();

  /** 多边形路径（顶点在半径 radius 上，默认从正上方开始） */
  function polygonPath(
    ctx: CanvasRenderingContext2D,
    sides: number,
    radius: number,
    rotation = -Math.PI / 2,
  ): void {
    ctx.beginPath();
    for (let i = 0; i < sides; i += 1) {
      const angle = rotation + (i / sides) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /** 星形路径（内外半径交替） */
  function starPath(
    ctx: CanvasRenderingContext2D,
    points: number,
    outer: number,
    inner: number,
  ): void {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i += 1) {
      const radius = i % 2 === 0 ? outer : inner;
      const angle = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /** 柔光底：图形后面铺一层径向渐隐，边缘不会硬 */
  function burstGlow(ctx: CanvasRenderingContext2D, R: number): void {
    const halo = ctx.createRadialGradient(0, 0, R * 0.3, 0, 0, R * 0.5);
    halo.addColorStop(0, 'rgba(255,255,255,0)');
    halo.addColorStop(0.7, 'rgba(255,255,255,0.1)');
    halo.addColorStop(0.9, 'rgba(255,255,255,0.34)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 绕环一圈大小不一的亮点，破掉机械感 */
  function burstRingDots(ctx: CanvasRenderingContext2D, R: number, count = 56): void {
    ctx.shadowBlur = R * 0.03;
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.06;
      const radius = R * (0.455 + Math.random() * 0.035);
      const dot = R * (0.004 + Math.random() * 0.008);
      ctx.fillStyle = `rgba(255,255,255,${(0.25 + Math.random() * 0.6).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(Math.cos(angle) * radius, Math.sin(angle) * radius, dot, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** 画一种绽放图形，返回可复用的贴图（缓存） */
  function burstTexture(shape: BurstShape): THREE.CanvasTexture {
    const cached = burstTextureMap.get(shape);
    if (cached) return cached;
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const R = size / 2;
    ctx.clearRect(0, 0, size, size);
    ctx.translate(R, R);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const stroke = (width: number, alpha = 0.95): void => {
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = width;
      ctx.shadowColor = 'rgba(255,255,255,0.9)';
      ctx.shadowBlur = width * 2.2;
      ctx.stroke();
    };
    burstGlow(ctx, R);
    switch (shape) {
      case 'ring': {
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.42, 0, Math.PI * 2);
        stroke(R * 0.024);
        ctx.shadowBlur = R * 0.02;
        ctx.strokeStyle = 'rgba(255,255,255,0.42)';
        ctx.lineWidth = R * 0.007;
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.335, 0, Math.PI * 2);
        ctx.stroke();
        burstRingDots(ctx, R);
        break;
      }
      case 'ringThin': {
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.44, 0, Math.PI * 2);
        stroke(R * 0.012);
        ctx.shadowBlur = R * 0.03;
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = R * 0.005;
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.4, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'ringDashed': {
        ctx.setLineDash([R * 0.13, R * 0.1]);
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.42, 0, Math.PI * 2);
        stroke(R * 0.02);
        ctx.setLineDash([R * 0.05, R * 0.07]);
        ctx.shadowBlur = R * 0.02;
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = R * 0.008;
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.33, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      }
      case 'ringPetals': {
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.4, 0, Math.PI * 2);
        stroke(R * 0.01, 0.7);
        for (let i = 0; i < 12; i += 1) {
          const angle = (i / 12) * Math.PI * 2;
          ctx.save();
          ctx.rotate(angle);
          ctx.beginPath();
          ctx.ellipse(0, -R * 0.33, R * 0.035, R * 0.11, 0, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,255,255,${(0.55 + Math.random() * 0.35).toFixed(2)})`;
          ctx.shadowColor = 'rgba(255,255,255,0.9)';
          ctx.shadowBlur = R * 0.04;
          ctx.fill();
          ctx.restore();
        }
        break;
      }
      case 'hex': {
        polygonPath(ctx, 6, R * 0.42);
        stroke(R * 0.022);
        polygonPath(ctx, 6, R * 0.34);
        ctx.shadowBlur = R * 0.02;
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = R * 0.007;
        ctx.stroke();
        break;
      }
      case 'triangle': {
        polygonPath(ctx, 3, R * 0.44);
        stroke(R * 0.022);
        polygonPath(ctx, 3, R * 0.35, Math.PI / 2);
        ctx.shadowBlur = R * 0.02;
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = R * 0.007;
        ctx.stroke();
        break;
      }
      case 'square': {
        polygonPath(ctx, 4, R * 0.42);
        stroke(R * 0.02);
        polygonPath(ctx, 4, R * 0.32, 0);
        ctx.shadowBlur = R * 0.02;
        ctx.strokeStyle = 'rgba(255,255,255,0.42)';
        ctx.lineWidth = R * 0.007;
        ctx.stroke();
        break;
      }
      case 'diamond': {
        polygonPath(ctx, 4, R * 0.46);
        stroke(R * 0.02);
        polygonPath(ctx, 4, R * 0.3);
        ctx.shadowBlur = R * 0.02;
        ctx.strokeStyle = 'rgba(255,255,255,0.38)';
        ctx.lineWidth = R * 0.006;
        ctx.stroke();
        break;
      }
      case 'star5': {
        starPath(ctx, 5, R * 0.46, R * 0.2);
        stroke(R * 0.016);
        break;
      }
      case 'star6': {
        starPath(ctx, 6, R * 0.44, R * 0.24);
        stroke(R * 0.016);
        starPath(ctx, 3, R * 0.3, R * 0.15);
        ctx.shadowBlur = R * 0.02;
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = R * 0.006;
        ctx.stroke();
        break;
      }
      case 'cross': {
        const arm = R * 0.46;
        const thick = R * 0.075;
        ctx.beginPath();
        ctx.moveTo(-thick, -arm);
        ctx.lineTo(thick, -arm);
        ctx.lineTo(thick, -thick);
        ctx.lineTo(arm, -thick);
        ctx.lineTo(arm, thick);
        ctx.lineTo(thick, thick);
        ctx.lineTo(thick, arm);
        ctx.lineTo(-thick, arm);
        ctx.lineTo(-thick, thick);
        ctx.lineTo(-arm, thick);
        ctx.lineTo(-arm, -thick);
        ctx.lineTo(-thick, -thick);
        ctx.closePath();
        stroke(R * 0.012);
        break;
      }
      case 'gear': {
        const teeth = 14;
        const outer = R * 0.46;
        const inner = R * 0.36;
        ctx.beginPath();
        for (let i = 0; i < teeth * 2; i += 1) {
          const radius = i % 2 === 0 ? outer : inner;
          const angle = (i / (teeth * 2)) * Math.PI * 2;
          const x = Math.cos(angle) * radius;
          const y = Math.sin(angle) * radius;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        stroke(R * 0.016);
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.26, 0, Math.PI * 2);
        ctx.shadowBlur = R * 0.02;
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = R * 0.008;
        ctx.stroke();
        break;
      }
      case 'sparkle': {
        starPath(ctx, 4, R * 0.48, R * 0.1);
        stroke(R * 0.014);
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.09, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.shadowColor = 'rgba(255,255,255,0.95)';
        ctx.shadowBlur = R * 0.08;
        ctx.fill();
        break;
      }
      case 'arc': {
        for (let i = 0; i < 3; i += 1) {
          const start = (i / 3) * Math.PI * 2 + Math.random() * 0.3;
          ctx.beginPath();
          ctx.arc(0, 0, R * (0.42 - i * 0.03), start, start + Math.PI * 0.42);
          stroke(R * (0.022 - i * 0.004), 0.9 - i * 0.18);
        }
        break;
      }
      case 'heart': {
        ctx.beginPath();
        ctx.moveTo(0, R * 0.34);
        ctx.bezierCurveTo(-R * 0.5, R * 0.02, -R * 0.3, -R * 0.4, 0, -R * 0.16);
        ctx.bezierCurveTo(R * 0.3, -R * 0.4, R * 0.5, R * 0.02, 0, R * 0.34);
        ctx.closePath();
        stroke(R * 0.018);
        break;
      }
      default: {
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.42, 0, Math.PI * 2);
        stroke(R * 0.024);
        break;
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    burstTextureMap.set(shape, texture);
    return texture;
  }

  /** 一种「绽放」样式：图形 + 层数 + 时长/缩放/旋转区间 + 缓动 + 层间错开 */
  interface BurstStyle {
    shape: BurstShape;
    count: number;
    duration: [number, number];
    startScale: [number, number];
    maxScale: [number, number];
    spin: [number, number];
    opacity: number;
    ease: number;
    spread: number;
  }

  /** 16 套绽放：涟漪 / 冲击波 / 花瓣 / 螺旋 / 星芒 / 六边 / 三角 / 内收 / 十字 / 菱形 / 方格 / 齿轮 / 星点 / 弧光 / 心形 / 五角 */
  const BURST_STYLES: BurstStyle[] = [
    { shape: 'ring', count: 2, duration: [1.25, 1.7], startScale: [0.26, 0.34], maxScale: [2.8, 3.6], spin: [-0.4, 0.4], opacity: 0.62, ease: 0, spread: 0.18 },
    { shape: 'ringThin', count: 1, duration: [0.7, 0.95], startScale: [0.3, 0.36], maxScale: [4.2, 5.2], spin: [0, 0.2], opacity: 0.78, ease: 0, spread: 0 },
    { shape: 'ringPetals', count: 2, duration: [1.5, 2.0], startScale: [0.28, 0.36], maxScale: [2.2, 2.9], spin: [-1.2, 1.2], opacity: 0.62, ease: 1, spread: 0.25 },
    { shape: 'ringDashed', count: 3, duration: [1.1, 1.5], startScale: [0.2, 0.28], maxScale: [2.4, 3.0], spin: [1.6, 2.8], opacity: 0.58, ease: 0, spread: 0.3 },
    { shape: 'star6', count: 1, duration: [0.9, 1.2], startScale: [0.24, 0.3], maxScale: [3.4, 4.4], spin: [2.2, 3.4], opacity: 0.7, ease: 0, spread: 0 },
    { shape: 'hex', count: 2, duration: [1.0, 1.35], startScale: [0.22, 0.3], maxScale: [2.2, 2.8], spin: [-0.7, 0.7], opacity: 0.6, ease: 1, spread: 0.2 },
    { shape: 'triangle', count: 3, duration: [1.0, 1.4], startScale: [0.18, 0.26], maxScale: [1.9, 2.6], spin: [-1.4, 1.4], opacity: 0.55, ease: 0, spread: 0.35 },
    { shape: 'ring', count: 1, duration: [0.55, 0.8], startScale: [3.4, 4.2], maxScale: [0.16, 0.24], spin: [0, 0.3], opacity: 0.72, ease: 2, spread: 0 },
    { shape: 'cross', count: 1, duration: [0.5, 0.75], startScale: [0.3, 0.36], maxScale: [2.8, 3.6], spin: [0.4, 1.0], opacity: 0.74, ease: 4, spread: 0 },
    { shape: 'diamond', count: 2, duration: [1.1, 1.5], startScale: [0.24, 0.3], maxScale: [2.4, 3.2], spin: [-2.2, 2.2], opacity: 0.58, ease: 1, spread: 0.22 },
    { shape: 'square', count: 1, duration: [0.9, 1.2], startScale: [0.26, 0.32], maxScale: [3.0, 3.8], spin: [1.2, 2.0], opacity: 0.62, ease: 0, spread: 0 },
    { shape: 'gear', count: 2, duration: [1.4, 1.9], startScale: [0.26, 0.32], maxScale: [2.2, 2.8], spin: [-2.6, 2.6], opacity: 0.6, ease: 1, spread: 0.2 },
    { shape: 'sparkle', count: 2, duration: [0.8, 1.1], startScale: [0.14, 0.2], maxScale: [1.8, 2.4], spin: [1.8, 3.0], opacity: 0.68, ease: 0, spread: 0.3 },
    { shape: 'arc', count: 3, duration: [1.0, 1.4], startScale: [0.28, 0.34], maxScale: [2.4, 3.0], spin: [1.0, 2.0], opacity: 0.56, ease: 0, spread: 0.28 },
    { shape: 'heart', count: 1, duration: [1.3, 1.7], startScale: [0.22, 0.28], maxScale: [2.0, 2.6], spin: [-0.8, 0.8], opacity: 0.62, ease: 1, spread: 0 },
    { shape: 'star5', count: 1, duration: [1.0, 1.3], startScale: [0.28, 0.34], maxScale: [2.8, 3.6], spin: [1.4, 2.4], opacity: 0.66, ease: 0, spread: 0 },
  ];

  /** 绽放缓动：0 三次方外扩、1 平滑、2 回弹、3 内收、4 线性 */
  function easeBurst(t: number, type: number): number {
    const x = Math.max(0, Math.min(1, t));
    if (type === 1) return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    if (type === 2) {
      const c = 1.7;
      const p = x - 1;
      return 1 + (c + 1) * p * p * p + c * p * p;
    }
    if (type === 3) return x * x;
    if (type === 4) return x;
    return 1 - Math.pow(1 - x, 3);
  }
'''

splice(
    "  /** 鼓点圆环贴图：",
    "    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());\n    return texture;\n  }",
    NEW_BLOCK.rstrip("\n"),
    "burst textures + styles",
)

# ---------- 3. 池子：10 -> 16 槽，贴图用缓存工厂 ----------
rep(
    """    // 圆环绽放池：用带柔光的贴图圆环（面片朝向相机），不是硬邦邦的几何环
    const ringTexture = createRingBurstTexture();
    for (let i = 0; i < 10; i += 1) {""",
    """    // 绽放池：每个槽一张朝向相机的面片，贴图在触发时按样式替换
    const ringTexture = burstTexture('ring');
    for (let i = 0; i < 16; i += 1) {""",
    "pool size",
)

rep(
    """        tint: new THREE.Color('#ffffff'),
        spin: 0,
        angle: 0,
      });""",
    """        tint: new THREE.Color('#ffffff'),
        spin: 0,
        angle: 0,
        ease: 0,
        fadeIn: 0,
        baseOpacity: 0,
      });""",
    "pool fields",
)

# ---------- 4. 触发：随机样式 + 多层错开 ----------
OLD_RING = """    if (kind === 'ring') {
      const spawn = (echo: boolean): void => {
        const free = ringBursts.find((item) => item.life <= 0);
        if (!free) return;
        free.life = 1;
        // 主环 + 一圈更小更快的回声环：两层错开大小/速度，看起来像涟漪扩散
        free.duration = echo ? 1.0 + Math.random() * 0.3 : 1.25 + Math.random() * 0.4;
        free.maxScale = echo ? (1.6 + power * 2.2) : (2.6 + power * 3.4);
        free.tint.copy(tint);
        const material = free.mesh.material as THREE.MeshBasicMaterial;
        material.color.copy(tint);
        material.opacity = echo ? 0.26 + power * 0.16 : 0.52 + power * 0.3;
        free.mesh.position.set(
          (Math.random() - 0.5) * 10.5,
          0.6 + Math.random() * 2.0,
          1.2 + Math.random() * 2.2,
        );
        free.mesh.scale.setScalar(echo ? 0.16 : 0.3);
        free.startScale = echo ? 0.16 : 0.3;
        free.spin = (Math.random() - 0.5) * 0.8;
        free.angle = Math.random() * Math.PI * 2;
        free.mesh.rotation.set(0, 0, free.angle);
        free.mesh.visible = true;
      };
      spawn(false);
      spawn(true);
    } else {"""

NEW_RING = """    if (kind === 'ring') {
      // 每次随机挑一种绽放样式：16 种图形/速度/旋转组合，避免每次都一样
      const style = BURST_STYLES[Math.floor(Math.random() * BURST_STYLES.length)]!;
      const range = (pair: [number, number]): number => pair[0] + Math.random() * (pair[1] - pair[0]);
      const originX = (Math.random() - 0.5) * 10.5;
      const originY = 0.6 + Math.random() * 2.0;
      const originZ = 1.2 + Math.random() * 2.2;
      for (let layer = 0; layer < style.count; layer += 1) {
        const free = ringBursts.find((item) => item.life <= 0);
        if (!free) break;
        free.life = 1;
        free.duration = range(style.duration) * (1 + layer * 0.14);
        free.startScale = range(style.startScale) * (1 - layer * 0.16);
        free.maxScale = range(style.maxScale) * (1 + layer * style.spread);
        free.ease = style.ease;
        free.fadeIn = 0.1 + layer * 0.04;
        free.baseOpacity = style.opacity * (layer === 0 ? 1 : 0.72) * (0.85 + power * 0.3);
        free.tint.copy(tint);
        const material = free.mesh.material as THREE.MeshBasicMaterial;
        material.map = burstTexture(style.shape);
        material.color.copy(tint);
        material.opacity = 0;
        free.mesh.position.set(
          originX + (Math.random() - 0.5) * 0.6 * layer,
          originY + (Math.random() - 0.5) * 0.5 * layer,
          originZ,
        );
        free.mesh.scale.setScalar(free.startScale);
        free.spin = range(style.spin) * (layer % 2 === 0 ? 1 : -1);
        free.angle = Math.random() * Math.PI * 2;
        free.mesh.rotation.set(0, 0, free.angle);
        free.mesh.visible = true;
      }
    } else {"""

rep(OLD_RING, NEW_RING, "ring trigger")

# ---------- 5. 更新：按每层缓动/缩放/淡入淡出 ----------
rep(
    """      const t = 1 - slot.life;
      const base = slot.startScale ?? 0.3;
      slot.mesh.scale.setScalar(base + t * slot.maxScale);
      // 先面向相机，再绕自身法线慢慢转：环上的细波纹和亮点随之流动，看起来更有细节
      slot.mesh.lookAt(camera.position);
      slot.angle += slot.spin * delta;
      slot.mesh.rotateZ(slot.angle);
      material.opacity = Math.max(0, slot.life) * (0.55 + 0.35 * (1 - t));""",
    """      const t = 1 - slot.life;
      const eased = easeBurst(t, slot.ease);
      const scale = slot.startScale + (slot.maxScale - slot.startScale) * eased;
      slot.mesh.scale.setScalar(Math.max(0.02, scale));
      // 先面向相机，再绕自身法线转：图形上的细节随之流动
      slot.mesh.lookAt(camera.position);
      slot.angle += slot.spin * delta;
      slot.mesh.rotateZ(slot.angle);
      const fadeIn = slot.fadeIn > 0 ? Math.min(1, t / slot.fadeIn) : 1;
      material.opacity = slot.baseOpacity * fadeIn * Math.pow(slot.life, 0.58);""",
    "ring update",
)

TARGET.write_text(src, encoding="utf-8")
print("DONE")
