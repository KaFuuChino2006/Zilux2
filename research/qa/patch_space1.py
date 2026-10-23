# -*- coding: utf-8 -*-
"""v1.11：垂直俯视默认视角、去掉边缘白线、小玻璃厚度可调、小玻璃悬停放大、小玻璃放歌单封面。"""
import io
import shutil

p = r'E:\Zilux2开发\web\src\three\loginSpace.ts'
shutil.copyfile(p, p + '.bak-v11')
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new, count=1):
    global s
    assert s.count(old) == count, ('anchor not unique', old[:60], s.count(old))
    s = s.replace(old, new, count)


# ---------- 1) 接口新增两个方法 ----------
rep(
    """  /** 自定义玻璃通透度（0.3 ~ 1） */
  setGlassTransmission(value: number): void;""",
    """  /** 自定义玻璃通透度（0.3 ~ 1） */
  setGlassTransmission(value: number): void;
  /** 小玻璃片厚度（0.06 ~ 0.5） */
  setChipThickness(value: number): void;
  /** 给小玻璃片塞内容（歌单封面/标题），null 表示空片 */
  setChipCards(cards: Array<{ title: string; subtitle?: string; cover?: string } | null>): void;""",
)

# ---------- 2) 默认视角：垂直俯视 ----------
rep(
    "  // 空间视角：默认从上往下看玻璃地面；拖动旋转、中键平移、滚轮缩放\n  const view = { yaw: 0, pitch: 0.72, radius: 13.4 };\n  const viewTarget = { yaw: 0, pitch: 0.72, radius: 13.4 };",
    "  // 空间视角：默认垂直俯视看玻璃地面；拖动旋转、中键平移、滚轮缩放\n  const view = { yaw: 0, pitch: 0.03, radius: 13.2 };\n  const viewTarget = { yaw: 0, pitch: 0.03, radius: 13.2 };",
)
rep("      viewTarget.pitch = 0.72;", "      viewTarget.pitch = 0.03;")
rep("      viewTarget.radius = 13.4;", "      viewTarget.radius = 13.2;")
# 拖拽/惯性/API 的 pitch 下限放宽到 0.02（允许真正垂直俯视）
rep("      viewTarget.pitch = clamp(viewTarget.pitch - dy * 0.0042, 0.04, 1.12);", "      viewTarget.pitch = clamp(viewTarget.pitch - dy * 0.0042, 0.02, 1.12);")
rep("      viewTarget.pitch = clamp(viewTarget.pitch + pitchVelocity, 0.04, 1.12);", "      viewTarget.pitch = clamp(viewTarget.pitch + pitchVelocity, 0.02, 1.12);")
rep("    viewTarget.pitch = clamp(pitch, 0.04, 1.12);", "    viewTarget.pitch = clamp(pitch, 0.02, 1.12);")

# ---------- 3) 去掉玻璃顶部覆盖层的白色描边（白细线） ----------
rep(
    """    // 边缘高光：内外两道描边，靠内衰减，避免硬边框
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
    edge(W * 0.008, 2.2, 0.55);
    edge(W * 0.02, 1.1, 0.22);
""",
    "",
)

# ---------- 4) 小玻璃：几何可重建 + 每片独立纹理/材质/内容/hover ----------
rep(
    """  const chipSideGeo = new THREE.ExtrudeGeometry(chipShape, {
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
""",
    """  const buildChipSideGeometry = (thickness: number): THREE.ExtrudeGeometry => {
    const geometry = new THREE.ExtrudeGeometry(chipShape, {
      depth: thickness,
      bevelEnabled: true,
      bevelThickness: 0.006,
      bevelSize: 0.006,
      bevelSegments: 1,
      curveSegments: 18,
      steps: 1,
    });
    geometry.rotateX(Math.PI / 2);
    return geometry;
  };
  let chipThickness = CHIP_H;
  const chipSideGeometry = buildChipSideGeometry(chipThickness);
  spaceGeometries.push(chipSideGeometry);
""",
)

old_chip_block = s[s.index("  const chipOverlayCanvas = document.createElement('canvas');") : s.index("    chipGroups.push(chipGroup);\n  });") + len("    chipGroups.push(chipGroup);\n  });")]
new_chip_block = """  const chipSideCanvas = document.createElement('canvas');
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

  const chipSideMaterial = new THREE.MeshBasicMaterial({
    map: makeSpaceTexture(chipSideCanvas),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
  });
  registerSpaceMaterial(chipSideMaterial, 0.9);
  const chipCapMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
  });

  /* 每片小玻璃：独立画布（封面 + 标题）/ 纹理 / 材质，可 hover 轻微放大 */
  interface ChipCard {
    title: string;
    subtitle?: string;
    cover?: string;
  }
  interface Chip {
    group: THREE.Group;
    sideMesh: THREE.Mesh;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D | null;
    texture: THREE.CanvasTexture;
    material: THREE.MeshBasicMaterial;
    hoverT: number;
    card: ChipCard | null;
    coverImage: HTMLImageElement | null;
  }

  const chipCanvasW = 512;
  const chipCanvasH = Math.round((chipCanvasW * CHIP_D) / CHIP_W);

  const drawChipSurface = (chip: Chip): void => {
    const ctx = chip.ctx;
    if (!ctx) return;
    const W = chip.canvas.width;
    const H = chip.canvas.height;
    const radius = (W * CHIP_RADIUS) / CHIP_W;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    spaceRoundRect(ctx, 0, 0, W, H, radius);
    ctx.clip();
    // 玻璃白雾
    const haze = ctx.createLinearGradient(0, 0, W * 0.5, H);
    haze.addColorStop(0, 'rgba(255,255,255,0.13)');
    haze.addColorStop(0.55, 'rgba(255,255,255,0.05)');
    haze.addColorStop(1, 'rgba(255,255,255,0.09)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, W, H);
    const card = chip.card;
    if (card) {
      const coverH = H * 0.62;
      if (chip.coverImage) {
        const image = chip.coverImage;
        const scale = Math.max(W / image.width, coverH / image.height);
        const dw = image.width * scale;
        const dh = image.height * scale;
        ctx.drawImage(image, (W - dw) / 2, (coverH - dh) / 2, dw, dh);
      } else {
        const ph = ctx.createLinearGradient(0, 0, W, coverH);
        ph.addColorStop(0, 'rgba(122,110,255,0.55)');
        ph.addColorStop(1, 'rgba(66,194,255,0.45)');
        ctx.fillStyle = ph;
        ctx.fillRect(0, 0, W, coverH);
      }
      // 底部白磨砂信息条
      const barH = H - coverH;
      const bar = ctx.createLinearGradient(0, coverH, 0, H);
      bar.addColorStop(0, 'rgba(255,255,255,0.86)');
      bar.addColorStop(1, 'rgba(246,249,255,0.94)');
      ctx.fillStyle = bar;
      ctx.fillRect(0, coverH, W, barH);
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(23,26,33,0.92)';
      ctx.font = '600 26px "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif';
      const title = card.title.length > 12 ? `${card.title.slice(0, 12)}…` : card.title;
      ctx.fillText(title, W * 0.06, coverH + barH * 0.4);
      if (card.subtitle) {
        ctx.fillStyle = 'rgba(93,100,112,0.9)';
        ctx.font = '400 17px "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif';
        ctx.fillText(card.subtitle, W * 0.06, coverH + barH * 0.74);
      }
    }
    // 斜向反光（不画描边）
    const sheen = ctx.createLinearGradient(0, 0, W, H);
    sheen.addColorStop(0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.42, 'rgba(255,255,255,0.18)');
    sheen.addColorStop(0.56, 'rgba(255,255,255,0.04)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    chip.texture.needsUpdate = true;
  };

  const chipSlots: Array<[number, number]> = [
    [-3.05, -1.62],
    [0, -1.62],
    [3.05, -1.62],
    [-3.05, 1.6],
    [0, 1.6],
    [3.05, 1.6],
  ];
  const chips: Chip[] = [];
  chipSlots.forEach(([x, z], index) => {
    const chipGroup = new THREE.Group();
    const canvas = document.createElement('canvas');
    canvas.width = chipCanvasW;
    canvas.height = chipCanvasH;
    const ctx = canvas.getContext('2d');
    const texture = makeSpaceTexture(canvas);
    texture.repeat.set(1 / CHIP_W, 1 / CHIP_D);
    texture.offset.set(0.5, 0.5);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });
    registerSpaceMaterial(material, 0.95);
    const topMesh = new THREE.Mesh(chipTopGeo, material);
    topMesh.renderOrder = 7;
    const sideMesh = new THREE.Mesh(chipSideGeometry, [chipCapMaterial, chipSideMaterial]);
    sideMesh.renderOrder = 6;
    chipGroup.add(topMesh, sideMesh);
    chipGroup.position.set(x, CHIP_BASE_Y, z);
    chipGroup.userData.baseY = CHIP_BASE_Y;
    chipGroup.userData.phase = index * 0.9;
    spaceGroup.add(chipGroup);
    const chip: Chip = {
      group: chipGroup,
      sideMesh,
      canvas,
      ctx,
      texture,
      material,
      hoverT: 0,
      card: null,
      coverImage: null,
    };
    chips.push(chip);
    drawChipSurface(chip);
  });
  let hoveredChip = -1;
  let lastChipHoverAt = 0;"""
s = s.replace(old_chip_block, new_chip_block, 1)

# ---------- 5) frame：hover 放大插值 ----------
rep(
    """      chipGroups.forEach((chip) => {
        const phase = (chip.userData.phase as number) ?? 0;
        chip.position.y = (chip.userData.baseY as number) + Math.sin(seconds * 0.55 + phase) * 0.028;
        chip.rotation.z = Math.sin(seconds * 0.42 + phase * 1.3) * 0.006;
      });""",
    """      chips.forEach((chip, index) => {
        const phase = (chip.group.userData.phase as number) ?? 0;
        const hoverTarget = hoveredChip === index ? 1 : 0;
        chip.hoverT += (hoverTarget - chip.hoverT) * Math.min(1, delta * 8);
        const hover = chip.hoverT * chip.hoverT * (3 - 2 * chip.hoverT);
        chip.group.position.y =
          ((chip.group.userData.baseY as number) ?? 1.02) + Math.sin(seconds * 0.55 + phase) * 0.028 + hover * 0.06;
        chip.group.rotation.z = Math.sin(seconds * 0.42 + phase * 1.3) * 0.006;
        chip.group.scale.setScalar(1 + hover * 0.065);
      });""",
)

# ---------- 6) pointermove：进入空间后悬停小玻璃放大 ----------
rep(
    """    if (enteredTarget) {
      canvas.style.cursor = 'grab';
      return;
    }""",
    """    if (enteredTarget) {
      if (enterAmount > 0.4) {
        const now = performance.now();
        if (now - lastChipHoverAt > 70) {
          lastChipHoverAt = now;
          raycaster.setFromCamera(pointer, camera);
          const hits = raycaster.intersectObjects(
            chips.map((chip) => chip.group.children[0]),
            false,
          );
          hoveredChip = hits.length > 0 ? chips.findIndex((chip) => chip.group.children[0] === hits[0].object) : -1;
        }
        canvas.style.cursor = hoveredChip >= 0 ? 'pointer' : 'grab';
      } else {
        canvas.style.cursor = 'grab';
      }
      return;
    }""",
)

# ---------- 7) 新增 setChipThickness / setChipCards，插在 chipShadow 之后 ----------
rep(
    """  /* ------------------------------ 交互：登录点选 + 空间视角 ------------------------------ */""",
    """  const setChipThickness = (value: number): void => {
    const next = Math.min(0.5, Math.max(0.06, value));
    if (Math.abs(next - chipThickness) < 0.001) return;
    chipThickness = next;
    const geometry = buildChipSideGeometry(next);
    spaceGeometries.push(geometry);
    chips.forEach((chip) => {
      chip.sideMesh.geometry = geometry;
    });
  };

  const setChipCards = (
    cards: Array<{ title: string; subtitle?: string; cover?: string } | null>,
  ): void => {
    chips.forEach((chip, index) => {
      chip.card = cards[index] ?? null;
      chip.coverImage = null;
      drawChipSurface(chip);
      const card = chip.card;
      if (!card?.cover) return;
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        chip.coverImage = image;
        drawChipSurface(chip);
      };
      image.onerror = () => {
        /* 封面加载失败：保留渐变占位 */
      };
      image.src = card.cover;
    });
  };

  /* ------------------------------ 交互：登录点选 + 空间视角 ------------------------------ */""",
)

# ---------- 8) handle 返回新增两个方法 ----------
rep(
    """    setGlassThickness: applyGlassThickness,
    setGlassTransmission: applyGlassTransmission,""",
    """    setGlassThickness: applyGlassThickness,
    setGlassTransmission: applyGlassTransmission,
    setChipThickness,
    setChipCards,""",
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('loginSpace patched for v1.11')
