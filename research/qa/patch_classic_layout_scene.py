# -*- coding: utf-8 -*-
"""新增经典歌词样式：左侧竖排歌词 + 右侧悬浮封面。"""
import io

p = r"E:\Zilux2开发\web\src\three\floatScene.ts"
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# ---------- A. 接口 ----------
old = "  setLyricLayout(layout: 'random' | 'rise'): void;"
assert s.count(old) == 1
s = s.replace(
    old,
    "  setLyricLayout(layout: 'random' | 'rise' | 'classic'): void;\n  setClassicCover(url: string | null): void;",
    1,
)

# ---------- B. 状态 ----------
old = "  let lyricLayout: 'random' | 'rise' = 'random';"
assert s.count(old) == 1
s = s.replace(
    old,
    "  let lyricLayout: 'random' | 'rise' | 'classic' = 'random';\n  let lyricLayoutClassic = false;\n  let classicCoverGroup: THREE.Group | null = null;\n  let classicCoverMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;\n  let classicCoverCanvas: HTMLCanvasElement | null = null;\n  let classicCoverUrl: string | null = null;\n  let classicCoverAmount = 0;",
    1,
)

# ---------- C. 经典模式强制 fade 样式（分段模型不适合竖排滚动） ----------
old = "    const style = lyricEnterStyle;\n    const split = style.startsWith('split-');"
assert s.count(old) == 1
s = s.replace(
    old,
    "    const style = lyricLayoutClassic ? 'fade' : lyricEnterStyle;\n    const split = style.startsWith('split-');",
    1,
)

# ---------- D. 经典模式固定左列锚点 + 封面系统 ----------
old = "  function updateLyrics(delta: number): void {"
assert s.count(old) == 1
helpers = '''  /** 经典模式：左侧固定列，随机/升起布局沿用 lyricAnchor */
  function lyricAnchorFor(index: number, out: THREE.Vector3): void {
    if (lyricLayoutClassic) {
      out.set(-1.95, 0.3, 0.35);
      return;
    }
    lyricAnchor(index, out);
  }

  function paintClassicCover(image: HTMLImageElement): void {
    if (!classicCoverCanvas || !classicCoverMesh) return;
    const ctx = classicCoverCanvas.getContext('2d');
    if (!ctx) return;
    const W = classicCoverCanvas.width;
    const H = classicCoverCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    const r = W * 0.07;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(W, 0, W, H, r);
    ctx.arcTo(W, H, 0, H, r);
    ctx.arcTo(0, H, 0, 0, r);
    ctx.arcTo(0, 0, W, 0, r);
    ctx.closePath();
    ctx.clip();
    const scale = Math.max(W / image.width, H / image.height);
    const dw = image.width * scale;
    const dh = image.height * scale;
    ctx.drawImage(image, (W - dw) / 2, (H - dh) / 2, dw, dh);
    const grad = ctx.createLinearGradient(0, H * 0.62, 0, H);
    grad.addColorStop(0, 'rgba(8,10,18,0)');
    grad.addColorStop(1, 'rgba(8,10,18,0.62)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, H * 0.55, W, H * 0.45);
    ctx.restore();
    ctx.lineWidth = Math.max(2, W * 0.008);
    ctx.strokeStyle = 'rgba(255,255,255,0.72)';
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(W, 0, W, H, r);
    ctx.arcTo(W, H, 0, H, r);
    ctx.arcTo(0, H, 0, 0, r);
    ctx.arcTo(0, 0, W, 0, r);
    ctx.closePath();
    ctx.stroke();
    classicCoverMesh.material.map!.needsUpdate = true;
  }

  function ensureClassicCover(): void {
    if (classicCoverGroup || !lyricGroup) return;
    classicCoverCanvas = document.createElement('canvas');
    classicCoverCanvas.width = 512;
    classicCoverCanvas.height = 512;
    const texture = new THREE.CanvasTexture(classicCoverCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    classicCoverMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2.05, 2.05),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0, depthWrite: false }),
    );
    classicCoverMesh.renderOrder = 30;
    classicCoverGroup = new THREE.Group();
    classicCoverGroup.add(classicCoverMesh);
    classicCoverGroup.visible = false;
    lyricGroup.add(classicCoverGroup);
  }

  function setClassicCover(url: string | null): void {
    classicCoverUrl = url;
    if (!url) {
      if (classicCoverGroup) classicCoverGroup.visible = false;
      classicCoverAmount = 0;
      return;
    }
    ensureClassicCover();
    const cached = coverCache.get(url);
    if (cached) {
      paintClassicCover(cached);
      return;
    }
    void loadCover(url).then((image) => {
      if (!image || classicCoverUrl !== url) return;
      paintClassicCover(image);
    });
  }

  function updateClassicCover(delta: number): void {
    if (!classicCoverGroup || !classicCoverMesh) return;
    const want = lyricVisible && lyricLayoutClassic && classicCoverUrl ? 1 : 0;
    classicCoverAmount += (want - classicCoverAmount) * Math.min(1, delta * 4.5);
    const visible = classicCoverAmount > 0.01;
    classicCoverGroup.visible = visible;
    if (!visible) return;
    const t = performance.now() * 0.001;
    classicCoverGroup.position.set(1.52, 0.26 + Math.sin(t * 0.7) * 0.035, 0.4);
    const scale = 0.94 + 0.06 * classicCoverAmount;
    classicCoverGroup.scale.setScalar(scale * (classicCoverAmount < 1 ? 1 : 1));
    classicCoverGroup.lookAt(camera.position);
    classicCoverMesh.material.opacity = classicCoverAmount;
  }

  function updateLyrics(delta: number): void {'''
s = s.replace(old, helpers, 1)

# ---------- E. 锚点调用替换 ----------
s = s.replace("      lyricAnchor(prevView.index, lyricAnchorTemp);", "      lyricAnchorFor(prevView.index, lyricAnchorTemp);", 1)
s = s.replace("      lyricAnchor(active, lyricAnchorTemp);", "      lyricAnchorFor(active, lyricAnchorTemp);", 1)

# ---------- F. 经典模式的竖直滚动位移 ----------
old = """      if (lyricLayout === 'rise') {
        const riseOut = out < 0.5 ? 16 * out ** 5 : 1 - Math.pow(-2 * out + 2, 5) / 2;
        prevY += riseOut * 2.6;
      }"""
assert s.count(old) == 1
s = s.replace(
    old,
    """      if (lyricLayout === 'rise') {
        const riseOut = out < 0.5 ? 16 * out ** 5 : 1 - Math.pow(-2 * out + 2, 5) / 2;
        prevY += riseOut * 2.6;
      }
      if (lyricLayoutClassic) {
        const classicOut = out * out * (3 - 2 * out);
        prevY += classicOut * 0.78;
        prevScale = 0.9 + 0.1 * prevView.amount;
      }""",
    1,
)

old = """      if (lyricLayout === 'rise') {
        const t = view.amount;
        const riseIn = t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2;
        enterY -= (1 - riseIn) * 5.6;
        enterScale *= 0.965 + 0.035 * riseIn;
      }"""
assert s.count(old) == 1
s = s.replace(
    old,
    """      if (lyricLayout === 'rise') {
        const t = view.amount;
        const riseIn = t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2;
        enterY -= (1 - riseIn) * 5.6;
        enterScale *= 0.965 + 0.035 * riseIn;
      }
      if (lyricLayoutClassic) {
        const t = view.amount;
        const classicIn = t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2;
        enterY -= (1 - classicIn) * 1.0;
        enterScale *= 0.975 + 0.025 * classicIn;
      }""",
    1,
)

# ---------- G. frame 调用 ----------
old = """    updateTiles(delta);
    flushTilePaint(18);
    updateLyrics(delta);
    updateMg(delta);"""
assert s.count(old) == 1
s = s.replace(
    old,
    """    updateTiles(delta);
    flushTilePaint(18);
    updateLyrics(delta);
    updateClassicCover(delta);
    updateMg(delta);""",
    1,
)

# ---------- H. handle 实现 ----------
old = """    setLyricLayout(layout) {
      lyricLayout = layout;
    },"""
assert s.count(old) == 1
s = s.replace(
    old,
    """    setLyricLayout(layout) {
      lyricLayout = layout;
      lyricLayoutClassic = layout === 'classic';
      if (!lyricLayoutClassic) {
        if (classicCoverGroup) classicCoverGroup.visible = false;
        classicCoverAmount = 0;
      }
    },
    setClassicCover(url) {
      setClassicCover(url);
    },""",
    1,
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print("floatScene classic layout added")
