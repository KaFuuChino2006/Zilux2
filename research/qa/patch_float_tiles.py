# -*- coding: utf-8 -*-
"""给 floatScene.ts 加：Windows 磁贴墙（封面+底部歌名）、轨道视角（拖动旋转）、磁贴滚动 API。"""
import io

P = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(P, 'r', encoding='utf-8', newline='').read()


def rep(old, new, count=1):
    global s
    assert s.count(old) >= count, 'MISSING ANCHOR: ' + old[:80].replace('\n', ' | ')
    s = s.replace(old, new, count)


# 1) Options：磁贴点击回调
rep(
    """  /** 用户选择的背景图（dataURL / URL），null 表示恢复默认 */
  onBackground?(url: string | null): void;
}""",
    """  /** 用户选择的背景图（dataURL / URL），null 表示恢复默认 */
  onBackground?(url: string | null): void;
  /** 点击磁贴（我喜欢的歌单 / 搜索结果） */
  onTileClick?(index: number): void;
}""",
)

# 2) Handle：磁贴 API
rep(
    "  setSongs(songs: Array<{ title: string; artist?: string; durationMs?: number }>): void;",
    """  setSongs(songs: Array<{ title: string; artist?: string; durationMs?: number }>): void;
  /** 磁贴墙数据（我喜欢的歌单 / 搜索结果） */
  setTiles(list: Array<{ title: string; artist?: string; cover?: string }>): void;
  setTilesVisible(visible: boolean): void;
  scrollTiles(deltaY: number): void;""",
)

# 3) 相机轨道状态
rep(
    """  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80);
  const lookTarget = new THREE.Vector3(0, 0.62, 0);""",
    """  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80);
  const lookTarget = new THREE.Vector3(0, 0.62, 0);
  // 轨道视角：默认略俯视，拖动旋转（场景内元素位置固定）
  let orbitYaw = 0;
  let orbitPitch = 0.2;
  let orbitYawTarget = 0;
  let orbitPitchTarget = 0.2;
  const ORBIT_RADIUS = 8.9;
  let orbitting = false;""",
)

# 4) 磁贴系统（插在 songs 声明之后）
rep(
    "  let songs: Array<{ title: string; artist?: string; durationMs?: number }> = [];",
    """  let songs: Array<{ title: string; artist?: string; durationMs?: number }> = [];

  /* ------------------------------ 3D 磁贴墙 ------------------------------ */

  interface TileItem {
    title: string;
    artist?: string;
    cover?: string;
  }
  interface Tile {
    group: THREE.Group;
    plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    hit: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    texture: THREE.CanvasTexture;
    canvas: HTMLCanvasElement;
    image: HTMLImageElement | null;
    title: string;
    hoverT: number;
    index: number;
  }
  const TILE_COLS = 6;
  const TILE_ROWS = 4;
  const TILE_SIZE = 1.02;
  const TILE_POOL = TILE_COLS * TILE_ROWS;
  const TILE_TOP = 1.9;
  const tiles: Tile[] = [];
  let tileItems: TileItem[] = [];
  let tileOffsetRows = 0;
  let tileVisible = false;
  let tileAmount = 0;
  let hoveredTile = -1;

  function tileSlot(index: number): { x: number; y: number } {
    const col = index % TILE_COLS;
    const row = Math.floor(index / TILE_COLS);
    return {
      x: (col - (TILE_COLS - 1) / 2) * TILE_SIZE,
      y: TILE_TOP - row * TILE_SIZE,
    };
  }

  function drawTile(tile: Tile): void {
    const ctx = tile.canvas.getContext('2d');
    if (!ctx) return;
    const S = tile.canvas.width;
    ctx.clearRect(0, 0, S, S);
    const radius = S * 0.045;
    roundRect(ctx, 1.5, 1.5, S - 3, S - 3, radius);
    ctx.save();
    ctx.clip();
    if (tile.image) {
      const img = tile.image;
      const scale = Math.max(S / img.naturalWidth, S / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
    } else {
      const hue = (tile.index * 47) % 360;
      const grad = ctx.createLinearGradient(0, 0, S, S);
      grad.addColorStop(0, 'hsl(' + hue + ' 52% 74%)');
      grad.addColorStop(1, 'hsl(' + ((hue + 46) % 360) + ' 58% 62%)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, S, S);
    }
    const shade = ctx.createLinearGradient(0, S * 0.48, 0, S);
    shade.addColorStop(0, 'rgba(6, 8, 14, 0)');
    shade.addColorStop(1, 'rgba(6, 8, 14, 0.66)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, S * 0.48, S, S * 0.52);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.97)';
    ctx.font = '600 ' + S * 0.074 + 'px ' + FONT;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const lines = wrapLines(ctx, tile.title || '未命名', S * 0.88, 2);
    lines.forEach((line, i) => {
      ctx.fillText(line, S * 0.055, S * 0.9 - (lines.length - 1 - i) * S * 0.082);
    });
    ctx.restore();
    roundRect(ctx, 1.5, 1.5, S - 3, S - 3, radius);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2.6;
    ctx.stroke();
    tile.texture.needsUpdate = true;
  }

  for (let i = 0; i < TILE_POOL; i += 1) {
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = 512;
    tileCanvas.height = 512;
    const texture = new THREE.CanvasTexture(tileCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(TILE_SIZE * 0.985, TILE_SIZE * 0.985),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
    );
    const hit = new THREE.Mesh(
      new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
    );
    const group = new THREE.Group();
    group.add(plane);
    group.add(hit);
    const slot = tileSlot(i);
    group.position.set(slot.x, slot.y, 0.1);
    group.visible = false;
    scene.add(group);
    const tile: Tile = {
      group,
      plane,
      hit,
      texture,
      canvas: tileCanvas,
      image: null,
      title: '',
      hoverT: 0,
      index: i,
    };
    drawTile(tile);
    tiles.push(tile);
  }

  function refreshTiles(): void {
    const rows = Math.ceil(tileItems.length / TILE_COLS);
    const maxOffset = Math.max(0, rows - TILE_ROWS);
    if (tileOffsetRows > maxOffset) tileOffsetRows = maxOffset;
    if (tileOffsetRows < 0) tileOffsetRows = 0;
    tiles.forEach((tile) => {
      const row = Math.floor(tile.index / TILE_COLS);
      const itemIndex = (tileOffsetRows + row) * TILE_COLS + (tile.index % TILE_COLS);
      const item = tileItems[itemIndex];
      const slot = tileSlot(tile.index);
      tile.group.position.x = slot.x;
      tile.group.position.y = slot.y;
      tile.group.visible = tileVisible && Boolean(item);
      tile.image = null;
      if (!item) {
        tile.title = '';
        drawTile(tile);
        return;
      }
      tile.title = item.title;
      drawTile(tile);
      const cover = item.cover;
      if (cover) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          tile.image = img;
          drawTile(tile);
        };
        img.src = cover;
      }
    });
  }
""",
)

# 5) 拖拽旋转：onPointerMove / onPointerLeave / onPointerDown / onPointerUp
rep(
    """  const onPointerMove = (event: PointerEvent): void => {
    setPointerFromEvent(event);
  };""",
    """  const onPointerMove = (event: PointerEvent): void => {
    setPointerFromEvent(event);
    if (orbitting) {
      const dx = event.clientX - downX;
      const dy = event.clientY - downY;
      orbitYawTarget = orbitYaw - dx * 0.0055;
      orbitPitchTarget = Math.min(1.05, Math.max(-0.05, orbitPitch + dy * 0.0042));
    }
  };""",
)

rep(
    """  const onPointerLeave = (): void => {
    pointer.set(999, 999);
    hoveredLogin = null;
    hoveredFeature = -1;
    hoveredSong = -1;
    options.onHover?.(null);
  };""",
    """  const onPointerLeave = (): void => {
    pointer.set(999, 999);
    hoveredLogin = null;
    hoveredFeature = -1;
    hoveredSong = -1;
    hoveredTile = -1;
    options.onHover?.(null);
  };""",
)

rep(
    """  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    downX = event.clientX;
    downY = event.clientY;
    downTime = performance.now();
  };""",
    """  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    downX = event.clientX;
    downY = event.clientY;
    downTime = performance.now();
    orbitting = true;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  };""",
)

rep(
    """  const onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const moved = Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY);
    if (moved > 6 || performance.now() - downTime > 600) return;
    if (hoveredFeature >= 0 && !songMode) {""",
    """  const onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    orbitting = false;
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    const moved = Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY);
    orbitYaw = orbitYawTarget;
    orbitPitch = orbitPitchTarget;
    if (moved > 8 || performance.now() - downTime > 700) return;
    if (hoveredTile >= 0 && tileVisible) {
      const tile = tiles[hoveredTile];
      if (tile) {
        const row = Math.floor(tile.index / TILE_COLS);
        const itemIndex = (tileOffsetRows + row) * TILE_COLS + (tile.index % TILE_COLS);
        options.onTileClick?.(itemIndex);
      }
      return;
    }
    if (hoveredFeature >= 0 && !songMode) {""",
)

# 6) frame：禁用功能卡、磁贴过渡、轨道相机、tile 更新
rep(
    """    const loginTarget = entered ? 0 : 1;
    const featureTarget = entered && !songMode ? 1 : 0;
    const songTarget = songMode ? 1 : 0;
    loginAmount += (loginTarget - loginAmount) * Math.min(1, delta * 4.2);
    featureAmount += (featureTarget - featureAmount) * Math.min(1, delta * 3.8);
    songAmount += (songTarget - songAmount) * Math.min(1, delta * 4.6);""",
    """    const loginTarget = entered ? 0 : 1;
    const featureTarget = 0;
    const songTarget = songMode ? 1 : 0;
    const tileTarget = entered && tileVisible ? 1 : 0;
    loginAmount += (loginTarget - loginAmount) * Math.min(1, delta * 4.2);
    featureAmount += (featureTarget - featureAmount) * Math.min(1, delta * 3.8);
    songAmount += (songTarget - songAmount) * Math.min(1, delta * 4.6);
    tileAmount += (tileTarget - tileAmount) * Math.min(1, delta * 4.6);
    orbitYaw += (orbitYawTarget - orbitYaw) * Math.min(1, delta * 9);
    orbitPitch += (orbitPitchTarget - orbitPitch) * Math.min(1, delta * 9);""",
)

rep(
    """    // 相机视差：鼠标轻微推动镜头，产生 3D 深度感
    const targetCamX = pointerX > 1.5 ? 0 : pointerX * 0.32;
    const targetCamY = pointerY > 1.5 ? 0.45 : 0.45 + pointerY * 0.18;
    camera.position.x += (targetCamX - camera.position.x) * Math.min(1, delta * 5);
    camera.position.y += (targetCamY - camera.position.y) * Math.min(1, delta * 5);
    camera.position.z = 7.4 + (1 - featureAmount) * 0.4;
    lookTarget.set(pointerX > 1.5 ? 0 : pointerX * 0.08, 0.62 + (pointerY > 1.5 ? 0 : pointerY * 0.05), 0);
    camera.lookAt(lookTarget);""",
    """    // 轨道相机：拖动旋转视角，场景内元素位置固定
    camera.position.x = Math.sin(orbitYaw) * Math.cos(orbitPitch) * ORBIT_RADIUS;
    camera.position.y = 0.62 + Math.sin(orbitPitch) * ORBIT_RADIUS;
    camera.position.z = Math.cos(orbitYaw) * Math.cos(orbitPitch) * ORBIT_RADIUS;
    lookTarget.set(0, 0.72, 0);
    camera.lookAt(lookTarget);""",
)

rep(
    """    updateHover();
    updateSongHover();
    updateCards(delta);""",
    """    updateHover();
    updateSongHover();
    updateCards(delta);
    updateTiles(delta);""",
)

# 7) updateTiles 函数（插在 updateCards 定义之前）
rep(
    "  function updateCards(delta: number): void {",
    """  function updateTiles(delta: number): void {
    const now = performance.now();
    let nextHover = -1;
    if (tileVisible && pointer.x < 900 && now - lastHoverAt > 80) {
      raycaster.setFromCamera(pointer, camera);
      const visibleTiles = tiles.filter((tile) => tile.group.visible).map((tile) => tile.hit);
      const hits = raycaster.intersectObjects(visibleTiles, false);
      if (hits.length > 0) {
        const found = tiles.findIndex((tile) => tile.hit === hits[0].object);
        if (found >= 0) nextHover = found;
      }
    }
    hoveredTile = nextHover;
    tiles.forEach((tile) => {
      const hoverTarget = hoveredTile === tile.index ? 1 : 0;
      tile.hoverT += (hoverTarget - tile.hoverT) * Math.min(1, delta * 9);
      const t = tile.hoverT * tile.hoverT * (3 - 2 * tile.hoverT);
      const appear = tileAmount;
      const slot = tileSlot(tile.index);
      tile.group.position.y = slot.y + (1 - appear) * -0.5;
      tile.group.position.z = 0.1 + t * 0.14;
      tile.group.scale.setScalar((0.94 + 0.06 * appear) * (1 + t * 0.05));
      tile.plane.material.opacity = appear;
      tile.plane.material.color.setScalar(1 + t * 0.16);
      if (appear <= 0.02) tile.group.visible = false;
    });
  }

  function updateCards(delta: number): void {""",
)

# 8) 返回 API（插在 setSongs 之前）
rep(
    """    setSongs(list) {""",
    """    setTiles(list) {
      tileItems = list.slice(0, 120);
      tileOffsetRows = 0;
      refreshTiles();
    },
    setTilesVisible(visible) {
      tileVisible = visible;
      if (!visible) {
        tiles.forEach((tile) => {
          tile.group.visible = false;
          tile.hoverT = 0;
        });
      }
    },
    scrollTiles(deltaY) {
      if (!tileVisible) return;
      const rows = Math.ceil(tileItems.length / TILE_COLS);
      const maxOffset = Math.max(0, rows - TILE_ROWS);
      const next = tileOffsetRows + (deltaY > 0 ? 1 : -1);
      const clamped = Math.min(maxOffset, Math.max(0, next));
      if (clamped !== tileOffsetRows) {
        tileOffsetRows = clamped;
        refreshTiles();
      }
    },
    setSongs(list) {""",
)

# 9) dispose 清理磁贴
rep(
    """      songRows.forEach((row) => {
        row.texture.dispose();
        row.plane.geometry.dispose();
        row.plane.material.dispose();
      });""",
    """      songRows.forEach((row) => {
        row.texture.dispose();
        row.plane.geometry.dispose();
        row.plane.material.dispose();
      });
      tiles.forEach((tile) => {
        tile.texture.dispose();
        tile.plane.geometry.dispose();
        tile.plane.material.dispose();
        tile.hit.geometry.dispose();
        tile.hit.material.dispose();
      });""",
)

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('floatScene tiles patch ok')
