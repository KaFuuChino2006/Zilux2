# -*- coding: utf-8 -*-
"""v2.7：滚轮=缩放、中键=平移相机、点击磁贴=相机飞向磁贴并放大显示详情。"""
import io

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

# ---------- 1) 状态 ----------
old = "  const ORBIT_RADIUS = 9.2;"
new = """  const ORBIT_RADIUS = 9.2;
  let zoom = 1;
  let zoomTarget = 1;
  let panX = 0;
  let panY = 0;
  let panTargetX = 0;
  let panTargetY = 0;
  let panning = false;
  let panLastX = 0;
  let panLastY = 0;
  let focusIndex = -1;
  let focusAmount = 0;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 2) 滚轮缩放 + 中键平移 ----------
old = """  const onPointerMove = (event: PointerEvent): void => {
    setPointerFromEvent(event);
    if (orbitting) {"""
new = """  const onWheel = (event: WheelEvent): void => {
    if (!entered) return;
    event.preventDefault();
    // 滚轮 = 相机放大 / 缩小
    zoomTarget = Math.min(1.9, Math.max(0.42, zoomTarget * (1 + event.deltaY * 0.0012)));
  };
  canvas.addEventListener('wheel', onWheel, { passive: false });

  const onPointerMove = (event: PointerEvent): void => {
    setPointerFromEvent(event);
    if (panning) {
      const dx = event.clientX - panLastX;
      const dy = event.clientY - panLastY;
      panLastX = event.clientX;
      panLastY = event.clientY;
      // 中键 = 平移 3D 摄像机位置（世界 XY 平面）
      panTargetX = Math.min(6.5, Math.max(-6.5, panTargetX + dx * 0.0062 * zoom));
      panTargetY = Math.min(4.2, Math.max(-4.2, panTargetY + dy * 0.0052 * zoom));
      return;
    }
    if (orbitting) {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;"""
new = """  const onPointerDown = (event: PointerEvent): void => {
    if (event.button === 1 && entered) {
      // 中键平移
      event.preventDefault();
      panning = true;
      panLastX = event.clientX;
      panLastY = event.clientY;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      canvas.style.cursor = 'move';
      return;
    }
    if (event.button !== 0) return;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  const onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    orbitting = false;"""
new = """  const onPointerUp = (event: PointerEvent): void => {
    if (event.button === 1) {
      panning = false;
      canvas.style.cursor = '';
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      return;
    }
    if (event.button !== 0) return;
    orbitting = false;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# pointerleave / cancel 时结束平移
old = """  const onPointerLeave = (): void => {
    pointer.set(999, 999);"""
new = """  const onPointerLeave = (): void => {
    panning = false;
    pointer.set(999, 999);"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 3) 详情磁贴（放大显示歌曲详情） ----------
old = """  function refreshTiles(): void {"""
new = """  /* 详情磁贴：点击某块磁贴后，在它上方放大显示详情卡 */
  const detailCanvas = document.createElement('canvas');
  detailCanvas.width = 1024;
  detailCanvas.height = 1024;
  const detailTexture = new THREE.CanvasTexture(detailCanvas);
  detailTexture.colorSpace = THREE.SRGBColorSpace;
  detailTexture.generateMipmaps = false;
  detailTexture.minFilter = THREE.LinearFilter;
  detailTexture.magFilter = THREE.LinearFilter;
  const detailPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1.06, 1.06),
    new THREE.MeshBasicMaterial({ map: detailTexture, transparent: true, depthWrite: false, opacity: 0 }),
  );
  detailPlane.position.set(0, 0, 0.8);
  detailPlane.visible = false;
  scene.add(detailPlane);
  let detailInfo: TileDetailInfo | null = null;
  let detailImage: HTMLImageElement | null = null;

  function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawDetailTile(): void {
    const ctx = detailCanvas.getContext('2d');
    if (!ctx) return;
    const S = detailCanvas.width;
    ctx.clearRect(0, 0, S, S);
    // 白磨砂底
    roundRectPath(ctx, S * 0.02, S * 0.02, S * 0.96, S * 0.96, S * 0.06);
    const bg = ctx.createLinearGradient(0, 0, 0, S);
    bg.addColorStop(0, 'rgba(255,255,255,0.95)');
    bg.addColorStop(1, 'rgba(246,248,253,0.92)');
    ctx.fillStyle = bg;
    ctx.fill();
    // 封面
    const pad = S * 0.07;
    const coverSize = S - pad * 2;
    const coverY = pad;
    if (detailImage) {
      ctx.save();
      roundRectPath(ctx, pad, coverY, coverSize, coverSize, S * 0.045);
      ctx.clip();
      const img = detailImage;
      const scale = Math.max(coverSize / img.width, coverSize / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, pad + (coverSize - dw) / 2, coverY + (coverSize - dh) / 2, dw, dh);
      ctx.restore();
    } else {
      ctx.save();
      roundRectPath(ctx, pad, coverY, coverSize, coverSize, S * 0.045);
      ctx.clip();
      const g = ctx.createLinearGradient(pad, coverY, pad + coverSize, coverY + coverSize);
      g.addColorStop(0, 'rgba(203,214,246,0.95)');
      g.addColorStop(1, 'rgba(246,232,255,0.95)');
      ctx.fillStyle = g;
      ctx.fillRect(pad, coverY, coverSize, coverSize);
      ctx.restore();
    }
    // 信息条
    const info = detailInfo;
    const barY = coverY + coverSize - S * 0.3;
    const barGrad = ctx.createLinearGradient(0, barY, 0, barY + S * 0.3);
    barGrad.addColorStop(0, 'rgba(8,10,18,0)');
    barGrad.addColorStop(1, 'rgba(8,10,18,0.72)');
    ctx.save();
    roundRectPath(ctx, pad, coverY, coverSize, coverSize, S * 0.045);
    ctx.clip();
    ctx.fillStyle = barGrad;
    ctx.fillRect(pad, barY, coverSize, S * 0.3);
    ctx.restore();
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.98)';
    ctx.font = `700 ${Math.round(S * 0.062)}px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif`;
    const title = info?.title || '未命名';
    let titleText = title;
    while (titleText.length > 1 && ctx.measureText(titleText).width > coverSize - S * 0.1) {
      titleText = titleText.slice(0, -1);
    }
    if (titleText !== title) titleText += '…';
    ctx.fillText(titleText, pad + S * 0.035, barY + S * 0.115);
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.font = `500 ${Math.round(S * 0.038)}px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif`;
    ctx.fillText(info?.artist || '未知歌手', pad + S * 0.035, barY + S * 0.19);
    ctx.fillStyle = 'rgba(255,255,255,0.66)';
    ctx.font = `500 ${Math.round(S * 0.032)}px "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif`;
    const meta = [info?.album, info?.duration].filter(Boolean).join(' · ');
    ctx.fillText(meta, pad + S * 0.035, barY + S * 0.255);
    detailTexture.needsUpdate = true;
  }

  function refreshTiles(): void {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 4) 相机：zoom / pan / focus ----------
old = """    // 轨道相机：拖动旋转视角，场景内元素位置固定
    camera.position.x = Math.sin(orbitYaw) * Math.cos(orbitPitch) * ORBIT_RADIUS;
    camera.position.y = 0.62 + Math.sin(orbitPitch) * ORBIT_RADIUS;
    camera.position.z = Math.cos(orbitYaw) * Math.cos(orbitPitch) * ORBIT_RADIUS;
    lookTarget.set(0, 0.72, 0);
    camera.lookAt(lookTarget);"""
new = """    // 相机：滚轮缩放、中键平移、点击磁贴时飞向该磁贴并放大
    zoom += (zoomTarget - zoom) * Math.min(1, delta * 6);
    panX += (panTargetX - panX) * Math.min(1, delta * 8);
    panY += (panTargetY - panY) * Math.min(1, delta * 8);
    const focusTarget = focusIndex >= 0 ? 1 : 0;
    focusAmount += (focusTarget - focusAmount) * Math.min(1, delta * 5.5);
    const focusTile = focusIndex >= 0 ? tiles[focusIndex] : null;
    const focusX = focusTile ? focusTile.group.position.x : 0;
    const focusY = focusTile ? focusTile.group.position.y - 0.72 : 0;
    const camDist = ORBIT_RADIUS * zoom * (1 - 0.42 * focusAmount);
    lookTarget.set(panX + focusX * focusAmount, 0.72 + panY + focusY * focusAmount, 0);
    camera.position.x =
      panX + focusX * focusAmount + Math.sin(orbitYaw) * Math.cos(orbitPitch) * camDist;
    camera.position.y =
      0.62 + panY + focusY * focusAmount + Math.sin(orbitPitch) * camDist;
    camera.position.z = Math.cos(orbitYaw) * Math.cos(orbitPitch) * camDist;
    camera.lookAt(lookTarget);
    // 详情磁贴跟随聚焦
    if (focusTile) {
      detailPlane.position.set(focusTile.group.position.x, focusTile.group.position.y, 0.85);
      detailPlane.visible = focusAmount > 0.02;
      (detailPlane.material as THREE.MeshBasicMaterial).opacity = focusAmount;
      const sScale = 1.0 + 1.7 * focusAmount;
      detailPlane.scale.setScalar(sScale);
      detailPlane.rotation.z = 0;
    } else {
      detailPlane.visible = false;
    }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 5) 聚焦时压暗其它磁贴 ----------
old = """      tile.plane.material.opacity = appear;
      tile.plane.material.color.setScalar(1 + t * 0.28 - sel * 0.05);"""
new = """      const dim = focusAmount * (tile.index === focusIndex ? 1 : 0.55);
      tile.plane.material.opacity = appear * (1 - focusAmount * (tile.index === focusIndex ? 1 : 0.55));
      tile.plane.material.color.setScalar((1 + t * 0.28 - sel * 0.05) * (1 - dim * 0.6));"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 6) API：聚焦/取消聚焦（带详情数据） ----------
old = """    setForcedHover(index: number) {
      forcedHoverTile = index;
    },"""
new = """    setForcedHover(index: number) {
      forcedHoverTile = index;
    },
    focusTile(index: number, info: TileDetailInfo) {
      focusIndex = index;
      detailInfo = info;
      selectedTile = -1;
      detailImage = null;
      if (info.cover) {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
          detailImage = image;
          drawDetailTile();
        };
        image.src = info.cover;
      }
      drawDetailTile();
    },
    unfocusTile() {
      focusIndex = -1;
      detailInfo = null;
      detailImage = null;
      detailPlane.visible = false;
    },"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 7) 接口类型 ----------
old = """  setForcedHover(index: number): void;"""
new = """  setForcedHover(index: number): void;
  focusTile(index: number, info: TileDetailInfo): void;
  unfocusTile(): void;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# ---------- 8) 清理 wheel 监听 ----------
old = """      canvas.removeEventListener('pointermove', onPointerMove);"""
new = """      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointermove', onPointerMove);"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('floatScene: zoom/pan/focus detail done')
