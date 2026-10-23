# -*- coding: utf-8 -*-
"""玻璃改为「透明覆盖层 + 边缘高光」方案：视觉透明可控，不再依赖 transmission/环境贴图。"""
import io

p = r'E:\Zilux2开发\web\src\three\loginSpace.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# 1) 删除 PMREM 环境贴图块（会让玻璃整体偏蓝紫）
env_start = "  /* 浅色天空环境贴图：给玻璃提供真实的反射与透射光 */"
env_end = "  envTexture.dispose();\n  pmrem.dispose();\n"
i0 = s.index(env_start)
i1 = s.index(env_end) + len(env_end)
s = s[:i0] + s[i1:]
s = s.replace("    spaceTextures.forEach((texture) => texture.dispose());\n    envRenderTarget.dispose();\n", "    spaceTextures.forEach((texture) => texture.dispose());\n", 1)

# 2) 玻璃/小玻璃材质全部替换为透明覆盖层（MeshBasic + Canvas 纹理）
old_side = """  const glassSideGeometry = buildGlassSideGeometry(glassThickness);
  spaceGeometries.push(glassSideGeometry);
  const glassSideMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xe8f2ff,
    roughness: 0.2,
    metalness: 0,
    ior: 1.46,
    clearcoat: 0.9,
    clearcoatRoughness: 0.2,
    envMapIntensity: 1.25,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.62,
    depthWrite: true,
  });
  registerSpaceMaterial(glassSideMaterial, 0.95);
  const glassSideMesh = new THREE.Mesh(glassSideGeometry, glassSideMaterial);
  glassSideMesh.renderOrder = 2;
  spaceGroup.add(glassSideMesh);

  const glassTopGeometry = new THREE.ShapeGeometry(glassShape, 28);
  glassTopGeometry.rotateX(-Math.PI / 2);
  spaceGeometries.push(glassTopGeometry);
  const glassTopMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xf4f9ff,
    roughness: 0.06,
    metalness: 0,
    ior: 1.5,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    envMapIntensity: 1.45,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.3,
    depthWrite: true,
  });
  registerSpaceMaterial(glassTopMaterial, 0.96);
  const glassTop = new THREE.Mesh(glassTopGeometry, glassTopMaterial);
  glassTop.position.y = 0.004;
  glassTop.renderOrder = 3;
  spaceGroup.add(glassTop);"""

new_side = """  /* 侧壁：竖向渐变（底部淡蓝 → 顶部近白），半透明 */
  const glassSideCanvas = document.createElement('canvas');
  glassSideCanvas.width = 4;
  glassSideCanvas.height = 256;
  const glassSideCtx = glassSideCanvas.getContext('2d');
  if (glassSideCtx) {
    const grad = glassSideCtx.createLinearGradient(0, 256, 0, 0);
    grad.addColorStop(0, 'rgba(158, 186, 232, 0.62)');
    grad.addColorStop(0.55, 'rgba(214, 232, 252, 0.52)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.9)');
    glassSideCtx.fillStyle = grad;
    glassSideCtx.fillRect(0, 0, 4, 256);
  }
  const glassSideMaterial = new THREE.MeshBasicMaterial({
    map: makeSpaceTexture(glassSideCanvas),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  registerSpaceMaterial(glassSideMaterial, 0.95);
  const glassSideMesh = new THREE.Mesh(glassSideGeometry, glassSideMaterial);
  glassSideMesh.renderOrder = 2;
  spaceGroup.add(glassSideMesh);

  /* 顶面覆盖层：中心几乎全透（只留极淡白雾），四周一圈亮边 + 斜向扫光，形成玻璃反光 */
  const glassTopCanvas = document.createElement('canvas');
  glassTopCanvas.width = 1024;
  glassTopCanvas.height = Math.round((1024 * GROUND_D) / GROUND_W);
  const glassTopCtx = glassTopCanvas.getContext('2d');
  if (glassTopCtx) {
    const W = glassTopCanvas.width;
    const H = glassTopCanvas.height;
    const radius = (W * GROUND_RADIUS) / GROUND_W;
    glassTopCtx.clearRect(0, 0, W, H);
    glassTopCtx.save();
    spaceRoundRect(glassTopCtx, 0, 0, W, H, radius);
    glassTopCtx.clip();
    // 很淡的整体白雾（保持玻璃存在感）
    const haze = glassTopCtx.createLinearGradient(0, 0, W * 0.5, H);
    haze.addColorStop(0, 'rgba(255,255,255,0.16)');
    haze.addColorStop(0.5, 'rgba(255,255,255,0.08)');
    haze.addColorStop(1, 'rgba(255,255,255,0.12)');
    glassTopCtx.fillStyle = haze;
    glassTopCtx.fillRect(0, 0, W, H);
    // 边缘高光：内外两道描边，靠内衰减，避免硬边框
    const edge = (inset: number, width: number, alpha: number): void => {
      glassTopCtx.save();
      spaceRoundRect(
        glassTopCtx,
        inset,
        inset,
        W - inset * 2,
        H - inset * 2,
        Math.max(6, radius - inset * 0.6),
      );
      glassTopCtx.lineWidth = width;
      glassTopCtx.strokeStyle = 'rgba(255,255,255,' + alpha + ')';
      glassTopCtx.stroke();
      glassTopCtx.restore();
    };
    edge(W * 0.008, 2.4, 0.75);
    edge(W * 0.02, 1.2, 0.35);
    // 斜向扫光（大块柔和反光）
    const sheen = glassTopCtx.createLinearGradient(0, 0, W * 0.9, H);
    sheen.addColorStop(0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.34, 'rgba(255,255,255,0.18)');
    sheen.addColorStop(0.46, 'rgba(255,255,255,0.05)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    glassTopCtx.fillStyle = sheen;
    glassTopCtx.fillRect(0, 0, W, H);
    glassTopCtx.restore();
  }

  const glassTopGeometry = new THREE.ShapeGeometry(glassShape, 28);
  glassTopGeometry.rotateX(-Math.PI / 2);
  spaceGeometries.push(glassTopGeometry);
  const glassTopMaterial = new THREE.MeshBasicMaterial({
    map: makeSpaceTexture(glassTopCanvas),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  registerSpaceMaterial(glassTopMaterial, 0.96);
  const glassTop = new THREE.Mesh(glassTopGeometry, glassTopMaterial);
  glassTop.position.y = 0.004;
  glassTop.renderOrder = 3;
  spaceGroup.add(glassTop);"""
assert s.count(old_side) == 1
s = s.replace(old_side, new_side, 1)

# 3) 小玻璃材质：透明覆盖层 + 边缘高光
old_chip_top = """  const chipTopMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.05,
    metalness: 0,
    ior: 1.5,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.5,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.34,
    depthWrite: true,
  });
  registerSpaceMaterial(chipTopMaterial, 0.95);
  const chipSideMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xe4efff,
    roughness: 0.2,
    metalness: 0,
    ior: 1.46,
    clearcoat: 0.85,
    clearcoatRoughness: 0.18,
    envMapIntensity: 1.3,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.55,
    depthWrite: true,
  });
  registerSpaceMaterial(chipSideMaterial, 0.9);"""

new_chip_top = """  const chipOverlayCanvas = document.createElement('canvas');
  chipOverlayCanvas.width = 512;
  chipOverlayCanvas.height = Math.round((512 * CHIP_D) / CHIP_W);
  const chipOverlayCtx = chipOverlayCanvas.getContext('2d');
  if (chipOverlayCtx) {
    const W = chipOverlayCanvas.width;
    const H = chipOverlayCanvas.height;
    const radius = (W * CHIP_RADIUS) / CHIP_W;
    chipOverlayCtx.clearRect(0, 0, W, H);
    chipOverlayCtx.save();
    spaceRoundRect(chipOverlayCtx, 0, 0, W, H, radius);
    chipOverlayCtx.clip();
    const haze = chipOverlayCtx.createLinearGradient(0, 0, W * 0.5, H);
    haze.addColorStop(0, 'rgba(255,255,255,0.2)');
    haze.addColorStop(0.55, 'rgba(255,255,255,0.08)');
    haze.addColorStop(1, 'rgba(255,255,255,0.14)');
    chipOverlayCtx.fillStyle = haze;
    chipOverlayCtx.fillRect(0, 0, W, H);
    spaceRoundRect(chipOverlayCtx, W * 0.012, H * 0.02, W * 0.976, H * 0.96, Math.max(4, radius));
    chipOverlayCtx.lineWidth = 2;
    chipOverlayCtx.strokeStyle = 'rgba(255,255,255,0.8)';
    chipOverlayCtx.stroke();
    const sheen = chipOverlayCtx.createLinearGradient(0, 0, W, H);
    sheen.addColorStop(0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.4, 'rgba(255,255,255,0.22)');
    sheen.addColorStop(0.55, 'rgba(255,255,255,0.06)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    chipOverlayCtx.fillStyle = sheen;
    chipOverlayCtx.fillRect(0, 0, W, H);
    chipOverlayCtx.restore();
  }

  const chipSideCanvas = document.createElement('canvas');
  chipSideCanvas.width = 4;
  chipSideCanvas.height = 128;
  const chipSideCtx = chipSideCanvas.getContext('2d');
  if (chipSideCtx) {
    const grad = chipSideCtx.createLinearGradient(0, 128, 0, 0);
    grad.addColorStop(0, 'rgba(158, 186, 232, 0.6)');
    grad.addColorStop(0.6, 'rgba(214, 232, 252, 0.55)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.92)');
    chipSideCtx.fillStyle = grad;
    chipSideCtx.fillRect(0, 0, 4, 128);
  }

  const chipTopMaterial = new THREE.MeshBasicMaterial({
    map: makeSpaceTexture(chipOverlayCanvas),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  registerSpaceMaterial(chipTopMaterial, 0.95);
  const chipSideMaterial = new THREE.MeshBasicMaterial({
    map: makeSpaceTexture(chipSideCanvas),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
  });
  registerSpaceMaterial(chipSideMaterial, 0.9);"""
assert s.count(old_chip_top) == 1
s = s.replace(old_chip_top, new_chip_top, 1)

# 4) 通明度自定义：控制覆盖层 opacity（通透度高 → 覆盖更少）
old_apply = """  const applyGlassTransmission = (value: number): void => {
    glassTransmission = Math.min(1, Math.max(0.3, value));
    // 通透度越高 → 玻璃本身越透明（0.3 偏磨砂，1 几乎全透）
    glassTopMaterial.opacity = 0.78 - glassTransmission * 0.55;
    glassSideMaterial.opacity = 0.92 - glassTransmission * 0.34;
    chipTopMaterial.opacity = 0.84 - glassTransmission * 0.56;
    chipSideMaterial.opacity = 0.95 - glassTransmission * 0.44;
  };"""
new_apply = """  const applyGlassTransmission = (value: number): void => {
    glassTransmission = Math.min(1, Math.max(0.3, value));
    // 通透度越高 → 玻璃覆盖层越淡（0.3 偏磨砂，1 几乎全透）
    glassTopMaterial.opacity = 0.32 + (1 - glassTransmission) * 0.62;
    glassSideMaterial.opacity = 0.34 + (1 - glassTransmission) * 0.5;
    chipTopMaterial.opacity = 0.36 + (1 - glassTransmission) * 0.6;
    chipSideMaterial.opacity = 0.4 + (1 - glassTransmission) * 0.5;
  };"""
assert s.count(old_apply) == 1
s = s.replace(old_apply, new_apply, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('glass -> transparent overlay')
