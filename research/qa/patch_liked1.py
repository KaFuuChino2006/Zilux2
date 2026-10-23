# -*- coding: utf-8 -*-
"""v1.12：小玻璃片更小更密更多（6×2=12 片）；新增「我喜欢的音乐」歌曲玻璃条列表。"""
import io
import shutil

p = r'E:\Zilux2开发\web\src\three\loginSpace.ts'
shutil.copyfile(p, p + '.bak-v12')
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new):
    global s
    assert s.count(old) == 1, ('anchor', old[:70], s.count(old))
    s = s.replace(old, new, 1)


# ---------- 1) 小玻璃片尺寸与布局 ----------
rep(
    """  const CHIP_W = 2.35;
  const CHIP_D = 1.45;
  const CHIP_H = 0.14;
  const CHIP_RADIUS = 0.14;""",
    """  const CHIP_W = 1.5;
  const CHIP_D = 0.95;
  const CHIP_H = 0.12;
  const CHIP_RADIUS = 0.11;""",
)
rep("  const CHIP_BASE_Y = 1.02;", "  const CHIP_BASE_Y = 0.98;")
rep(
    """  const chipSlots: Array<[number, number]> = [
    [-3.05, -1.62],
    [0, -1.62],
    [3.05, -1.62],
    [-3.05, 1.6],
    [0, 1.6],
    [3.05, 1.6],
  ];""",
    """  // 6 列 × 2 行：上排网易云、下排 QQ（间距贴紧）
  const chipSlots: Array<[number, number]> = [
    [-4.05, -0.54],
    [-2.43, -0.54],
    [-0.81, -0.54],
    [0.81, -0.54],
    [2.43, -0.54],
    [4.05, -0.54],
    [-4.05, 0.54],
    [-2.43, 0.54],
    [-0.81, 0.54],
    [0.81, 0.54],
    [2.43, 0.54],
    [4.05, 0.54],
  ];""",
)

# ---------- 2) 接口：小玻璃显隐 + 歌曲条列表 ----------
rep(
    """  /** 给小玻璃片塞内容（歌单封面/标题），null 表示空片 */
  setChipCards(cards: Array<{ title: string; subtitle?: string; cover?: string } | null>): void;""",
    """  /** 给小玻璃片塞内容（歌单封面/标题），null 表示空片 */
  setChipCards(cards: Array<{ title: string; subtitle?: string; cover?: string } | null>): void;
  /** 小玻璃片整组显隐（打开「我喜欢的音乐」时隐藏） */
  setChipsVisible(visible: boolean): void;
  /** 「我喜欢的音乐」歌曲玻璃条列表显隐 */
  setSongListVisible(visible: boolean): void;
  /** 填充歌曲玻璃条 */
  setSongs(songs: Array<{ title: string; artist?: string; durationMs?: number }>): void;""",
)

# ---------- 3) 歌曲条引擎：插在 chips 创建结束（lastChipHoverAt）之后 ----------
rep(
    """  let hoveredChip = -1;
  let lastChipHoverAt = 0;""",
    """  let hoveredChip = -1;
  let lastChipHoverAt = 0;

  /* ------------------------------ 「我喜欢的音乐」歌曲玻璃条 ------------------------------ */
  const SONG_ROW_COUNT = 12;
  const SONG_ROW_W = 7.8;
  const SONG_ROW_T = 0.5;
  const SONG_ROW_GAP = 0.65;
  const SONG_ROW_Y = 0.3;

  const songListGroup = new THREE.Group();
  songListGroup.visible = false;
  spaceGroup.add(songListGroup);

  const songRowGeometry = new THREE.PlaneGeometry(SONG_ROW_W, SONG_ROW_T);
  songRowGeometry.rotateX(-Math.PI / 2);
  songRowGeometry.rotateY(Math.PI / 2);
  spaceGeometries.push(songRowGeometry);

  const songRowCanvasW = 1024;
  const songRowCanvasH = Math.round((songRowCanvasW * SONG_ROW_T) / SONG_ROW_W);

  interface SongRow {
    mesh: THREE.Mesh;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D | null;
    texture: THREE.CanvasTexture;
    material: THREE.MeshBasicMaterial;
  }

  const formatSongTime = (durationMs?: number): string => {
    if (!durationMs || durationMs <= 0) return '--:--';
    const total = Math.round(durationMs / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const paintSongRow = (
    row: SongRow,
    index: number,
    song: { title: string; artist?: string; durationMs?: number } | null,
  ): void => {
    const ctx = row.ctx;
    if (!ctx) return;
    const W = row.canvas.width;
    const H = row.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    spaceRoundRect(ctx, 0, 0, W, H, H * 0.22);
    ctx.clip();
    // 白磨砂玻璃条
    const haze = ctx.createLinearGradient(0, 0, W, 0);
    haze.addColorStop(0, 'rgba(255,255,255,0.16)');
    haze.addColorStop(0.05, 'rgba(255,255,255,0.1)');
    haze.addColorStop(0.95, 'rgba(255,255,255,0.1)');
    haze.addColorStop(1, 'rgba(255,255,255,0.16)');
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, W, H);
    const sheen = ctx.createLinearGradient(0, 0, 0, H);
    sheen.addColorStop(0, 'rgba(255,255,255,0.22)');
    sheen.addColorStop(0.5, 'rgba(255,255,255,0.02)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle';
    const midY = H * 0.5;
    // 序号
    ctx.fillStyle = 'rgba(93,100,112,0.55)';
    ctx.font = '600 24px "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif';
    ctx.fillText(`${(index + 1).toString().padStart(2, '0')}`, W * 0.016, midY + 1);
    if (song) {
      ctx.fillStyle = 'rgba(23,26,33,0.92)';
      ctx.font = '600 27px "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif';
      const title = song.title.length > 22 ? `${song.title.slice(0, 22)}…` : song.title;
      ctx.fillText(title, W * 0.062, midY + 1);
      ctx.fillStyle = 'rgba(93,100,112,0.85)';
      ctx.font = '400 20px "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif';
      const artist = (song.artist ?? '').length > 14 ? `${(song.artist ?? '').slice(0, 14)}…` : song.artist ?? '';
      ctx.fillText(artist, W * 0.36, midY + 2);
      ctx.fillStyle = 'rgba(93,100,112,0.75)';
      ctx.font = '400 20px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(formatSongTime(song.durationMs), W * 0.972, midY + 1);
      ctx.textAlign = 'left';
    }
    ctx.restore();
    row.texture.needsUpdate = true;
  };

  const songRows: SongRow[] = [];
  for (let index = 0; index < SONG_ROW_COUNT; index += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = songRowCanvasW;
    canvas.height = songRowCanvasH;
    const ctx = canvas.getContext('2d');
    const texture = makeSpaceTexture(canvas);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    registerSpaceMaterial(material, 0.95);
    const mesh = new THREE.Mesh(songRowGeometry, material);
    mesh.renderOrder = 8;
    const x = (index - (SONG_ROW_COUNT - 1) / 2) * SONG_ROW_GAP;
    mesh.position.set(x, SONG_ROW_Y, 0);
    songListGroup.add(mesh);
    const row: SongRow = { mesh, canvas, ctx, texture, material };
    paintSongRow(row, index, null);
    songRows.push(row);
  }

  const setChipsVisible = (visible: boolean): void => {
    chips.forEach((chip) => {
      chip.group.visible = visible;
    });
  };

  const setSongListVisible = (visible: boolean): void => {
    songListGroup.visible = visible;
  };

  const setSongs = (songs: Array<{ title: string; artist?: string; durationMs?: number }>): void => {
    songRows.forEach((row, index) => {
      paintSongRow(row, index, songs[index] ?? null);
    });
  };""",
)

# 4) handle 返回
rep(
    """    setChipThickness,
    setChipCards,""",
    """    setChipThickness,
    setChipCards,
    setChipsVisible,
    setSongListVisible,
    setSongs,""",
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('loginSpace patched: 12 chips + song rows')
