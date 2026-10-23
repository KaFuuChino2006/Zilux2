import io

path = r"E:\Zilux2开发\web\src\three\loginSpace.ts"
src = io.open(path, encoding="utf-8").read()

start_marker = "  /* ------------------------------ 空间大厅（进入后） ------------------------------ */"
end_marker = "  /* ------------------------------ 交互 ------------------------------ */"
i = src.find(start_marker)
j = src.find(end_marker)
assert i != -1 and j != -1 and i < j, (i, j)

new_block = r'''  /* ------------------------------ 玻璃地面空间（进入后） ------------------------------ */

  const GROUND_Y = -1.92;
  const GROUND_W = 23;
  const GROUND_D = 13;
  const GROUND_RADIUS = 1.7;
  const groundCenter = new THREE.Vector3(0, GROUND_Y, 0);

  const spaceGroup = new THREE.Group();
  spaceGroup.visible = false;
  spaceGroup.position.y = GROUND_Y;
  group.add(spaceGroup);

  const spaceMats: THREE.MeshBasicMaterial[] = [];
  const spaceOpacity: number[] = [];
  const spaceTextures: THREE.CanvasTexture[] = [];
  const spaceGeometries: THREE.BufferGeometry[] = [];

  const registerSpaceTexture = (texture: THREE.CanvasTexture): void => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    spaceTextures.push(texture);
  };

  const registerSpaceMaterial = (material: THREE.MeshBasicMaterial, opacity: number): void => {
    material.transparent = true;
    material.opacity = 0;
    material.depthWrite = false;
    spaceMats.push(material);
    spaceOpacity.push(opacity);
  };

  const makeSpaceTexture = (canvas: HTMLCanvasElement): THREE.CanvasTexture => {
    const texture = new THREE.CanvasTexture(canvas);
    registerSpaceTexture(texture);
    return texture;
  };

  const spaceRoundRect = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void => {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  };

  const groundCanvas = { w: 1400, h: Math.round((1400 * GROUND_D) / GROUND_W) };

  /* 圆角遮罩：alphaMap 中白色不透明、黑色透明，用于裁出圆角地面 */
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = 1024;
  maskCanvas.height = Math.round((1024 * GROUND_D) / GROUND_W);
  const maskCtx = maskCanvas.getContext('2d');
  if (maskCtx) {
    maskCtx.fillStyle = '#000000';
    maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.fillStyle = '#ffffff';
    spaceRoundRect(
      maskCtx,
      0,
      0,
      maskCanvas.width,
      maskCanvas.height,
      (maskCanvas.width * GROUND_RADIUS) / GROUND_W,
    );
    maskCtx.fill();
  }
  const groundMask = makeSpaceTexture(maskCanvas);

  /* 玻璃下方的「自定义背景」：默认浅色极光；后续换成用户图片也只替换这张纹理 */
  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = groundCanvas.w;
  bgCanvas.height = groundCanvas.h;
  const bgCtx = bgCanvas.getContext('2d');
  if (bgCtx) {
    const W = bgCanvas.width;
    const H = bgCanvas.height;
    const base = bgCtx.createLinearGradient(0, 0, W, H);
    base.addColorStop(0, '#eef2ff');
    base.addColorStop(0.45, '#f7f3ff');
    base.addColorStop(1, '#eaf6ff');
    bgCtx.fillStyle = base;
    bgCtx.fillRect(0, 0, W, H);

    const blob = (cx: number, cy: number, r: number, color: string): void => {
      const g = bgCtx.createRadialGradient(cx * W, cy * H, 0, cx * W, cy * H, r * W);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      bgCtx.fillStyle = g;
      bgCtx.fillRect(0, 0, W, H);
    };
    blob(0.24, 0.3, 0.5, 'rgba(138, 123, 255, 0.34)');
    blob(0.78, 0.26, 0.44, 'rgba(90, 208, 255, 0.28)');
    blob(0.56, 0.82, 0.52, 'rgba(255, 158, 203, 0.24)');
    blob(0.9, 0.88, 0.36, 'rgba(255, 214, 140, 0.20)');

    bgCtx.strokeStyle = 'rgba(106, 92, 255, 0.10)';
    bgCtx.lineWidth = 2;
    for (let k = 1; k <= 4; k += 1) {
      bgCtx.beginPath();
      bgCtx.arc(W * 0.5, H * 0.55, W * 0.12 * k, 0, Math.PI * 2);
      bgCtx.stroke();
    }
    const sweep = bgCtx.createLinearGradient(0, H, W, 0);
    sweep.addColorStop(0, 'rgba(255,255,255,0)');
    sweep.addColorStop(0.5, 'rgba(255,255,255,0.34)');
    sweep.addColorStop(1, 'rgba(255,255,255,0)');
    bgCtx.fillStyle = sweep;
    bgCtx.fillRect(0, 0, W, H);
  }
  const bgBlurCanvas = document.createElement('canvas');
  bgBlurCanvas.width = bgCanvas.width;
  bgBlurCanvas.height = bgCanvas.height;
  const bgBlurCtx = bgBlurCanvas.getContext('2d');
  if (bgBlurCtx) {
    bgBlurCtx.filter = 'blur(26px)';
    bgBlurCtx.drawImage(bgCanvas, 0, 0);
    bgBlurCtx.filter = 'none';
  }

  /* 磨砂玻璃层：白纱 + 细噪点 + 中心柔光 */
  const glassCanvas = document.createElement('canvas');
  glassCanvas.width = groundCanvas.w;
  glassCanvas.height = groundCanvas.h;
  const glassCtx = glassCanvas.getContext('2d');
  if (glassCtx) {
    const W = glassCanvas.width;
    const H = glassCanvas.height;
    glassCtx.clearRect(0, 0, W, H);
    spaceRoundRect(glassCtx, 0, 0, W, H, (W * GROUND_RADIUS) / GROUND_W);
    const veil = glassCtx.createLinearGradient(0, 0, W * 0.4, H);
    veil.addColorStop(0, 'rgba(255,255,255,0.72)');
    veil.addColorStop(0.5, 'rgba(255,255,255,0.58)');
    veil.addColorStop(1, 'rgba(255,255,255,0.66)');
    glassCtx.fillStyle = veil;
    glassCtx.fill();

    const dots = Math.floor((W * H) / 2600);
    for (let d = 0; d < dots; d += 1) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const a = Math.random() * 0.05 + 0.012;
      glassCtx.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
      glassCtx.fillRect(x, y, 1.6, 1.6);
    }
    const sheen = glassCtx.createRadialGradient(W * 0.42, H * 0.3, 0, W * 0.42, H * 0.3, W * 0.5);
    sheen.addColorStop(0, 'rgba(255,255,255,0.20)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    glassCtx.fillStyle = sheen;
    glassCtx.fillRect(0, 0, W, H);
  }

  /* 玻璃边缘高光：单独一层，保持锐利 */
  const edgeCanvas = document.createElement('canvas');
  edgeCanvas.width = groundCanvas.w * 2;
  edgeCanvas.height = glassCanvas.height * 2;
  const edgeCtx = edgeCanvas.getContext('2d');
  if (edgeCtx) {
    const W = edgeCanvas.width;
    const H = edgeCanvas.height;
    const radius = (W * GROUND_RADIUS) / GROUND_W;
    spaceRoundRect(edgeCtx, 4, 4, W - 8, H - 8, radius);
    edgeCtx.strokeStyle = 'rgba(255,255,255,0.95)';
    edgeCtx.lineWidth = 5;
    edgeCtx.stroke();
    spaceRoundRect(edgeCtx, 12, 12, W - 24, H - 24, radius * 0.98);
    edgeCtx.strokeStyle = 'rgba(255,255,255,0.42)';
    edgeCtx.lineWidth = 10;
    edgeCtx.stroke();
    spaceRoundRect(edgeCtx, 10, 10, W - 20, H - 20, radius);
    edgeCtx.strokeStyle = 'rgba(23,26,33,0.10)';
    edgeCtx.lineWidth = 2;
    edgeCtx.stroke();
  }

  /* 地面投影：让玻璃板悬浮在空间里 */
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = 1024;
  shadowCanvas.height = Math.round((1024 * GROUND_D) / GROUND_W);
  const shadowCtx = shadowCanvas.getContext('2d');
  if (shadowCtx) {
    const W = shadowCanvas.width;
    const H = shadowCanvas.height;
    const halo = shadowCtx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.56);
    halo.addColorStop(0, 'rgba(23, 26, 33, 0.20)');
    halo.addColorStop(0.62, 'rgba(23, 26, 33, 0.12)');
    halo.addColorStop(1, 'rgba(23, 26, 33, 0)');
    shadowCtx.fillStyle = halo;
    shadowCtx.fillRect(0, 0, W, H);
  }

  const addSpacePlane = (
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    positionY: number,
    opacity: number,
    alphaMap?: THREE.Texture,
  ): THREE.Mesh => {
    const material = new THREE.MeshBasicMaterial({ map: makeSpaceTexture(canvas), alphaMap });
    registerSpaceMaterial(material, opacity);
    const geometry = new THREE.PlaneGeometry(width, height);
    spaceGeometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = positionY;
    spaceGroup.add(mesh);
    return mesh;
  };

  addSpacePlane(shadowCanvas, GROUND_W + 2.4, GROUND_D + 2.4, -0.34, 0.85);
  addSpacePlane(bgBlurCanvas, GROUND_W - 0.85, GROUND_D - 0.85, -0.12, 0.96, groundMask);
  addSpacePlane(glassCanvas, GROUND_W, GROUND_D, 0, 1, groundMask);
  addSpacePlane(edgeCanvas, GROUND_W, GROUND_D, 0.006, 1, groundMask);

'''

src = src[:i] + new_block + src[j:]
io.open(path, "w", encoding="utf-8", newline="\n").write(src)
print("hall block replaced; new length", len(src))
