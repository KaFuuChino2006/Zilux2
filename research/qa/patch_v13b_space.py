# -*- coding: utf-8 -*-
"""v1.13 loginSpace：歌曲墙交叉过渡 + hover 高亮 + 滚动（60 槽位池）。"""
import io
import shutil

p = r'E:\Zilux2开发\web\src\three\loginSpace.ts'
shutil.copyfile(p, p + '.bak-v13b')
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new):
    global s
    assert s.count(old) == 1, ('anchor', old[:70], s.count(old))
    s = s.replace(old, new, 1)


# 1) 手动透明度材质支持
rep(
    """  const spaceMats: THREE.Material[] = [];
  const spaceOpacity: number[] = [];""",
    """  const spaceMats: THREE.Material[] = [];
  const spaceOpacity: number[] = [];
  const spaceManual: boolean[] = [];""",
)
rep(
    """  const registerSpaceMaterial = (material: THREE.Material, opacity: number): void => {""",
    """  const registerSpaceMaterial = (material: THREE.Material, opacity: number, manual = false): void => {""",
)
rep(
    """    spaceMats.push(material);
    spaceOpacity.push(opacity);
  };""",
    """    spaceMats.push(material);
    spaceOpacity.push(opacity);
    spaceManual.push(manual);
  };""",
)
rep(
    """      spaceMats.forEach((material, matIndex) => {
        material.opacity = spaceAlpha * (spaceOpacity[matIndex] ?? 1);
      });""",
    """      spaceMats.forEach((material, matIndex) => {
        if (spaceManual[matIndex]) return;
        material.opacity = spaceAlpha * (spaceOpacity[matIndex] ?? 1);
      });""",
)

# 2) 常量 & 画布尺寸（60 槽位池）
rep(
    """  const SONG_ROW_COUNT = 12;
  const SONG_ROW_W = 7.8;""",
    """  const SONG_ROW_MAX = 60;
  const SONG_ROW_W = 7.8;""",
)
rep("  const songRowCanvasW = 1024;", "  const songRowCanvasW = 768;")

# 3) hover 状态变量
rep(
    """  let hoveredChip = -1;
  let lastChipHoverAt = 0;""",
    """  let hoveredChip = -1;
  let lastChipHoverAt = 0;
  let hoveredSongRow = -1;
  let lastSongHoverAt = 0;""",
)

# 4) SongRow 接口 + hoverT
rep(
    """  interface SongRow {
    mesh: THREE.Mesh;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D | null;
    texture: THREE.CanvasTexture;
    material: THREE.MeshBasicMaterial;
  }""",
    """  interface SongRow {
    mesh: THREE.Mesh;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D | null;
    texture: THREE.CanvasTexture;
    material: THREE.MeshBasicMaterial;
    hoverT: number;
  }""",
)

# 5) 创建循环：60 槽位池，材质手动透明度
rep(
    "  for (let index = 0; index < SONG_ROW_COUNT; index += 1) {",
    "  for (let index = 0; index < SONG_ROW_MAX; index += 1) {",
)
rep(
    """    registerSpaceMaterial(material, 0.95);
    const mesh = new THREE.Mesh(songRowGeometry, material);
    mesh.renderOrder = 8;
    const x = ((SONG_ROW_COUNT - 1) / 2 - index) * SONG_ROW_GAP;
    mesh.position.set(x, SONG_ROW_Y, 0);
    songListGroup.add(mesh);
    const row: SongRow = { mesh, canvas, ctx, texture, material };""",
    """    registerSpaceMaterial(material, 0.95, true);
    material.opacity = 0;
    const mesh = new THREE.Mesh(songRowGeometry, material);
    mesh.renderOrder = 8;
    mesh.visible = false;
    mesh.position.set(0, SONG_ROW_Y, 0);
    songListGroup.add(mesh);
    const row: SongRow = { mesh, canvas, ctx, texture, material, hoverT: 0 };""",
)

# 6) setSongs 重写（布局/滚动范围/初始位置）
rep(
    """  const setSongs = (songs: Array<{ title: string; artist?: string; durationMs?: number }>): void => {
    songRows.forEach((row, index) => {
      paintSongRow(row, index, songs[index] ?? null);
    });
  };""",
    """  let activeSongCount = 0;
  let songScroll = 0;
  let songScrollTarget = 0;
  let songScrollLimit = 0;

  const setSongs = (songs: Array<{ title: string; artist?: string; durationMs?: number }>): void => {
    activeSongCount = Math.min(SONG_ROW_MAX, songs.length);
    const half = ((activeSongCount - 1) * SONG_ROW_GAP) / 2;
    songRows.forEach((row, index) => {
      const active = index < activeSongCount;
      row.mesh.visible = active;
      row.mesh.position.x = ((activeSongCount - 1) / 2 - index) * SONG_ROW_GAP;
      row.mesh.position.y = SONG_ROW_Y;
      row.hoverT = 0;
      paintSongRow(row, index, active ? songs[index] ?? null : null);
    });
    songScrollLimit = Math.max(0, half - 4.4);
    songScroll = -songScrollLimit;
    songScrollTarget = songScroll;
    songListGroup.position.x = songScroll;
  };

  const scrollSongs = (deltaY: number): void => {
    songScrollTarget = clamp(songScrollTarget + deltaY * 0.012, -songScrollLimit, songScrollLimit);
  };""",
)

# 7) 切歌目标（动画驱动）
rep(
    """  const setSongListVisible = (visible: boolean): void => {
    songListGroup.visible = visible;
  };""",
    """  let songViewOpen = false;
  let songViewAmount = 0;

  const setSongListVisible = (visible: boolean): void => {
    songViewOpen = visible;
  };""",
)

# 8) wheel：歌曲视图下不缩放
rep(
    """  const onWheel = (event: WheelEvent): void => {
    if (enterAmount < 0.4) return;
    event.preventDefault();""",
    """  const onWheel = (event: WheelEvent): void => {
    if (enterAmount < 0.4) return;
    if (songViewAmount > 0.5) return;
    event.preventDefault();""",
)

# 9) frame：cross-fade + song rows 渲染
rep(
    """      const seconds = performance.now() / 1000;
      const hoverNow = performance.now();
      if (enterAmount > 0.4 && pointer.x < 900 && hoverNow - lastChipHoverAt > 100) {""",
    """      const seconds = performance.now() / 1000;
      // 歌单玻璃片 ↔ 我喜欢的音乐歌曲条：交叉过渡
      const songTarget = songViewOpen ? 1 : 0;
      songViewAmount += (songTarget - songViewAmount) * Math.min(1, delta * 4.6);
      if (songViewAmount < 0.0015) songViewAmount = 0;
      if (songViewAmount > 0.9985) songViewAmount = 1;
      const songEase = songViewAmount * songViewAmount * (3 - 2 * songViewAmount);
      const chipEase = 1 - songEase;
      const hoverNow = performance.now();
      if (enterAmount > 0.4 && pointer.x < 900 && hoverNow - lastChipHoverAt > 100 && chipEase > 0.3) {""",
)
rep(
    """      chips.forEach((chip, index) => {
        const phase = (chip.group.userData.phase as number) ?? 0;
        const hoverTarget = hoveredChip === index ? 1 : 0;
        chip.hoverT += (hoverTarget - chip.hoverT) * Math.min(1, delta * 8);
        const hover = chip.hoverT * chip.hoverT * (3 - 2 * chip.hoverT);
        chip.group.position.y =
          ((chip.group.userData.baseY as number) ?? 1.02) + Math.sin(seconds * 0.55 + phase) * 0.028 + hover * 0.08;
        chip.group.rotation.z = Math.sin(seconds * 0.42 + phase * 1.3) * 0.006;
        chip.group.scale.setScalar(1 + hover * 0.09);
      });""",
    """      chips.forEach((chip, index) => {
        const phase = (chip.group.userData.phase as number) ?? 0;
        const hoverTarget = hoveredChip === index ? 1 : 0;
        chip.hoverT += (hoverTarget - chip.hoverT) * Math.min(1, delta * 8);
        const hover = chip.hoverT * chip.hoverT * (3 - 2 * chip.hoverT);
        chip.group.visible = chipEase > 0.01;
        chip.group.position.y =
          ((chip.group.userData.baseY as number) ?? 1.02) +
          Math.sin(seconds * 0.55 + phase) * 0.028 +
          hover * 0.08 -
          (1 - chipEase) * 0.55;
        chip.group.rotation.z = Math.sin(seconds * 0.42 + phase * 1.3) * 0.006;
        chip.group.scale.setScalar((1 + hover * 0.09) * (0.05 + 0.95 * chipEase));
      });
      // 歌曲玻璃条：淡入 + 升起 + hover 高亮 + 滚动
      songScroll += (songScrollTarget - songScroll) * Math.min(1, delta * 8);
      songListGroup.visible = songEase > 0.004;
      if (songListGroup.visible) {
        songListGroup.position.x = songScroll;
        songListGroup.position.y = -0.42 * (1 - songEase);
        const songHoverNow = performance.now();
        if (pointer.x < 900 && songEase > 0.55 && songHoverNow - lastSongHoverAt > 90) {
          lastSongHoverAt = songHoverNow;
          raycaster.setFromCamera(pointer, camera);
          const meshes = songRows.filter((row) => row.mesh.visible).map((row) => row.mesh);
          const hits = raycaster.intersectObjects(meshes, false);
          hoveredSongRow = hits.length > 0 ? songRows.findIndex((row) => row.mesh === hits[0].object) : -1;
        } else if (songEase <= 0.5) {
          hoveredSongRow = -1;
        }
        songRows.forEach((row, index) => {
          if (!row.mesh.visible) {
            row.material.opacity = 0;
            return;
          }
          const hoverTarget = hoveredSongRow === index ? 1 : 0;
          row.hoverT += (hoverTarget - row.hoverT) * Math.min(1, delta * 10);
          const t = row.hoverT * row.hoverT * (3 - 2 * row.hoverT);
          row.mesh.position.y = SONG_ROW_Y + t * 0.085;
          row.mesh.scale.set(1 + t * 0.02, 1, 1 + t * 0.02);
          row.material.opacity = 0.94 * songEase * (0.8 + 0.2 * t);
          row.material.color.setScalar(0.94 + 0.18 * t);
        });
        if (songEase > 0.6) {
          canvas.style.cursor = hoveredSongRow >= 0 ? 'pointer' : 'grab';
        }
      }""",
)

# 10) handle 增加 scrollSongs
rep(
    """    setChipsVisible,
    setSongListVisible,
    setSongs,""",
    """    setChipsVisible,
    setSongListVisible,
    setSongs,
    scrollSongs,""",
)
rep(
    "  setChipsVisible(visible: boolean): void;",
    "  setChipsVisible(visible: boolean): void;\n  scrollSongs(deltaY: number): void;",
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('loginSpace v1.13 patched')
