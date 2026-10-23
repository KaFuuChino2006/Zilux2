# -*- coding: utf-8 -*-
"""把 loginSpace.ts 的地面玻璃/小玻璃改成真实玻璃材质，并接入自定义接口。"""
import io
import sys

p = r'E:\Zilux2开发\web\src\three\loginSpace.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

start_mark = "  addSpacePlane(shadowCanvas, GROUND_W + 0.6, GROUND_D + 0.6, -0.52, 0.62);"
end_mark = """  chipSlots.forEach(([x, z]) => {
    const shadow = new THREE.Mesh(chipShadowGeo, chipShadowMaterial);
    shadow.position.set(x, GROUND_TOP + 0.012, z);
    spaceGroup.add(shadow);
  });
"""
i0 = s.index(start_mark)
i1 = s.index(end_mark) + len(end_mark)

new_block = r'''  /* 地面投影：径向柔和阴影（随玻璃厚度下移） */
  const glassShadow = addSpacePlane(shadowCanvas, GROUND_W + 0.6, GROUND_D + 0.6, -0.9, 0.5);

  /* ---------------- 一整块有厚度的玻璃（真实玻璃材质，厚度/通透度可自定义） ---------------- */
  const DEFAULT_GLASS_THICKNESS = 0.62;
  let glassThickness = DEFAULT_GLASS_THICKNESS;
  let glassTransmission = 0.94;

  const glassShape = new THREE.Shape();
  const glassHalfW = GROUND_W / 2;
  const glassHalfD = GROUND_D / 2;
  const glassCorner = GROUND_RADIUS;
  glassShape.moveTo(-glassHalfW + glassCorner, -glassHalfD);
  glassShape.lineTo(glassHalfW - glassCorner, -glassHalfD);
  glassShape.quadraticCurveTo(glassHalfW, -glassHalfD, glassHalfW, -glassHalfD + glassCorner);
  glassShape.lineTo(glassHalfW, glassHalfD - glassCorner);
  glassShape.quadraticCurveTo(glassHalfW, glassHalfD, glassHalfW - glassCorner, glassHalfD);
  glassShape.lineTo(-glassHalfW + glassCorner, glassHalfD);
  glassShape.quadraticCurveTo(-glassHalfW, glassHalfD, -glassHalfW, glassHalfD - glassCorner);
  glassShape.lineTo(-glassHalfW, -glassHalfD + glassCorner);
  glassShape.quadraticCurveTo(-glassHalfW, -glassHalfD, -glassHalfW + glassCorner, -glassHalfD);

  const buildGlassSideGeometry = (thickness: number): THREE.ExtrudeGeometry => {
    const geometry = new THREE.ExtrudeGeometry(glassShape, {
      depth: thickness,
      bevelEnabled: true,
      bevelThickness: 0.01,
      bevelSize: 0.01,
      bevelSegments: 1,
      curveSegments: 20,
      steps: 1,
    });
    // 挤出方向 +Z：旋转 +90° 后朝 -Y，玻璃从 y=0 向下有厚度
    geometry.rotateX(Math.PI / 2);
    return geometry;
  };

  const glassSideGeometry = buildGlassSideGeometry(glassThickness);
  spaceGeometries.push(glassSideGeometry);
  const glassSideMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xeaf2ff,
    transmission: 0.8,
    roughness: 0.24,
    metalness: 0,
    ior: 1.46,
    thickness: glassThickness,
    attenuationColor: new THREE.Color(0xcfe0ff),
    attenuationDistance: 2.6,
    clearcoat: 0.5,
    clearcoatRoughness: 0.24,
    envMapIntensity: 1.15,
    side: THREE.DoubleSide,
    transparent: true,
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
    color: 0xffffff,
    transmission: glassTransmission,
    roughness: 0.1,
    metalness: 0,
    ior: 1.5,
    thickness: glassThickness,
    attenuationColor: new THREE.Color(0xdbeaff),
    attenuationDistance: 3.6,
    clearcoat: 1,
    clearcoatRoughness: 0.1,
    envMapIntensity: 1.35,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: true,
  });
  registerSpaceMaterial(glassTopMaterial, 0.96);
  const glassTop = new THREE.Mesh(glassTopGeometry, glassTopMaterial);
  glassTop.position.y = 0.004;
  glassTop.renderOrder = 3;
  spaceGroup.add(glassTop);

  /* 玻璃下方背景（默认浅色氛围，可自定义图片）：透过玻璃清晰可见 */
  const underlayTexture = makeSpaceTexture(glassCanvas);
  const underlayMaterial = new THREE.MeshBasicMaterial({
    map: underlayTexture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  registerSpaceMaterial(underlayMaterial, 1);
  underlayMaterial.depthWrite = false;
  const underlayGeometry = new THREE.ShapeGeometry(glassShape, 28);
  underlayGeometry.rotateX(-Math.PI / 2);
  spaceGeometries.push(underlayGeometry);
  const underlayMesh = new THREE.Mesh(underlayGeometry, underlayMaterial);
  underlayMesh.position.y = -0.1;
  underlayMesh.renderOrder = 1;
  spaceGroup.add(underlayMesh);

  const paintUnderlay = (image: HTMLImageElement | null): void => {
    const ctx = glassCtx;
    if (!ctx) return;
    const W = glassCanvas.width;
    const H = glassCanvas.height;
    const radius = (W * GROUND_RADIUS) / GROUND_W;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    spaceRoundRect(ctx, 0, 0, W, H, radius);
    ctx.clip();

    if (image) {
      const scale = Math.max(W / image.width, H / image.height);
      const dw = image.width * scale;
      const dh = image.height * scale;
      ctx.drawImage(image, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else {
      const base = ctx.createLinearGradient(0, 0, W, H);
      base.addColorStop(0, '#d9e4ff');
      base.addColorStop(0.45, '#ece8ff');
      base.addColorStop(1, '#cfe6ff');
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, W, H);
      const blob = (cx: number, cy: number, r: number, color: string): void => {
        const g = ctx.createRadialGradient(cx * W, cy * H, 0, cx * W, cy * H, r * W);
        g.addColorStop(0, color);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      };
      blob(0.24, 0.3, 0.5, 'rgba(120, 110, 255, 0.58)');
      blob(0.78, 0.26, 0.44, 'rgba(66, 194, 255, 0.52)');
      blob(0.56, 0.82, 0.52, 'rgba(255, 124, 188, 0.46)');
      blob(0.9, 0.88, 0.36, 'rgba(255, 200, 108, 0.4)');
      const bgGlow = ctx.createRadialGradient(W * 0.5, H * 0.44, 0, W * 0.5, H * 0.44, W * 0.62);
      bgGlow.addColorStop(0, 'rgba(255,255,255,0.16)');
      bgGlow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = bgGlow;
      ctx.fillRect(0, 0, W, H);
    }

    /* 极淡白纱 + 细噪点：保留磨砂玻璃手感，但不再挡住下方背景 */
    const veil = ctx.createLinearGradient(0, 0, W * 0.4, H);
    veil.addColorStop(0, 'rgba(255,255,255,0.13)');
    veil.addColorStop(0.5, 'rgba(255,255,255,0.09)');
    veil.addColorStop(1, 'rgba(255,255,255,0.11)');
    ctx.fillStyle = veil;
    ctx.fillRect(0, 0, W, H);
    const dots = Math.floor((W * H) / 3600);
    for (let d = 0; d < dots; d += 1) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const a = Math.random() * 0.06 + 0.015;
      ctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
      ctx.fillRect(x, y, 1.6, 1.6);
    }
    const sheen = ctx.createRadialGradient(W * 0.42, H * 0.3, 0, W * 0.42, H * 0.3, W * 0.5);
    sheen.addColorStop(0, 'rgba(255,255,255,0.08)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    underlayTexture.needsUpdate = true;
  };

  paintUnderlay(null);

  const applyGlassThickness = (value: number): void => {
    const next = Math.min(1.6, Math.max(0.1, value));
    if (Math.abs(next - glassThickness) < 0.001) return;
    glassThickness = next;
    const geometry = buildGlassSideGeometry(next);
    spaceGeometries.push(geometry);
    glassSideMesh.geometry = geometry;
    glassSideMaterial.thickness = next;
    glassTopMaterial.thickness = next;
    glassShadow.position.y = -next - 0.32;
  };

  const applyGlassTransmission = (value: number): void => {
    glassTransmission = Math.min(1, Math.max(0.3, value));
    glassTopMaterial.transmission = glassTransmission;
    glassSideMaterial.transmission = Math.min(1, glassTransmission * 0.92);
  };

  const applyUnderlayImage = (url: string | null): void => {
    if (!url) {
      paintUnderlay(null);
      return;
    }
    const image = new Image();
    image.onload = () => paintUnderlay(image);
    image.onerror = () => paintUnderlay(null);
    image.src = url;
  };

  /* ---------------- 玻璃地面上方的一片片小玻璃（真实玻璃材质，内容后续再加） ---------------- */
  const CHIP_W = 2.35;
  const CHIP_D = 1.45;
  const CHIP_H = 0.14;
  const CHIP_RADIUS = 0.14;
  const GROUND_TOP = 0.004;
  const CHIP_BASE_Y = 1.02;

  const chipShape = new THREE.Shape();
  {
    const hw = CHIP_W / 2;
    const hd = CHIP_D / 2;
    const r = CHIP_RADIUS;
    chipShape.moveTo(-hw + r, -hd);
    chipShape.lineTo(hw - r, -hd);
    chipShape.quadraticCurveTo(hw, -hd, hw, -hd + r);
    chipShape.lineTo(hw, hd - r);
    chipShape.quadraticCurveTo(hw, hd, hw - r, hd);
    chipShape.lineTo(-hw + r, hd);
    chipShape.quadraticCurveTo(-hw, hd, -hw, hd - r);
    chipShape.lineTo(-hw, -hd + r);
    chipShape.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  }

  const chipTopGeo = new THREE.ShapeGeometry(chipShape, 20);
  chipTopGeo.rotateX(-Math.PI / 2);
  spaceGeometries.push(chipTopGeo);
  const chipSideGeo = new THREE.ExtrudeGeometry(chipShape, {
    depth: CHIP_H,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.006,
    bevelSegments: 1,
    curveSegments: 18,
    steps: 1,
  });
  chipSideGeo.rotateX(Math.PI / 2);
  spaceGeometries.push(chipSideGeo);

  const chipTopMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transmission: 0.92,
    roughness: 0.1,
    metalness: 0,
    ior: 1.5,
    thickness: CHIP_H,
    attenuationColor: new THREE.Color(0xdfeaff),
    attenuationDistance: 1.6,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.35,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: true,
  });
  registerSpaceMaterial(chipTopMaterial, 0.95);
  const chipSideMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xe8f1ff,
    transmission: 0.8,
    roughness: 0.26,
    metalness: 0,
    ior: 1.46,
    thickness: CHIP_H,
    attenuationColor: new THREE.Color(0xcfe0ff),
    attenuationDistance: 1.4,
    clearcoat: 0.4,
    clearcoatRoughness: 0.2,
    envMapIntensity: 1.1,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: true,
  });
  registerSpaceMaterial(chipSideMaterial, 0.9);

  const chipSlots: Array<[number, number]> = [
    [-3.05, -1.62],
    [0, -1.62],
    [3.05, -1.62],
    [-3.05, 1.6],
    [0, 1.6],
    [3.05, 1.6],
  ];
  const chipGroups: THREE.Group[] = [];
  chipSlots.forEach(([x, z], index) => {
    const chipGroup = new THREE.Group();
    const topMesh = new THREE.Mesh(chipTopGeo, chipTopMaterial);
    topMesh.renderOrder = 7;
    const sideMesh = new THREE.Mesh(chipSideGeo, chipSideMaterial);
    sideMesh.renderOrder = 6;
    chipGroup.add(topMesh, sideMesh);
    chipGroup.position.set(x, CHIP_BASE_Y, z);
    chipGroup.userData.baseY = CHIP_BASE_Y;
    chipGroup.userData.phase = index * 0.9;
    spaceGroup.add(chipGroup);
    chipGroups.push(chipGroup);
  });

  // 每片小玻璃在玻璃地面上的柔和投影（贴地，不随浮动移动）
  const chipShadowShape = new THREE.Shape();
  {
    const hw = (CHIP_W * 1.08) / 2;
    const hd = (CHIP_D * 1.08) / 2;
    const r = CHIP_RADIUS * 1.08;
    chipShadowShape.moveTo(-hw + r, -hd);
    chipShadowShape.lineTo(hw - r, -hd);
    chipShadowShape.quadraticCurveTo(hw, -hd, hw, -hd + r);
    chipShadowShape.lineTo(hw, hd - r);
    chipShadowShape.quadraticCurveTo(hw, hd, hw - r, hd);
    chipShadowShape.lineTo(-hw + r, hd);
    chipShadowShape.quadraticCurveTo(-hw, hd, -hw, hd - r);
    chipShadowShape.lineTo(-hw, -hd + r);
    chipShadowShape.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  }
  const chipShadowGeo = new THREE.ShapeGeometry(chipShadowShape, 12);
  chipShadowGeo.rotateX(-Math.PI / 2);
  spaceGeometries.push(chipShadowGeo);
  const chipShadowMaterial = new THREE.MeshBasicMaterial({ color: 0x2a3350 });
  registerSpaceMaterial(chipShadowMaterial, 0.085);
  chipShadowMaterial.depthWrite = false;
  chipSlots.forEach(([x, z]) => {
    const shadow = new THREE.Mesh(chipShadowGeo, chipShadowMaterial);
    shadow.position.set(x, GROUND_TOP + 0.012, z);
    shadow.renderOrder = 4;
    spaceGroup.add(shadow);
  });
'''

s = s[:i0] + new_block + s[i1:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched: glass + chips replaced')
