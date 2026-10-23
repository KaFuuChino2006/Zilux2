# -*- coding: utf-8 -*-
"""PV 文字歌词 3D 化：floatScene 内置 PV 歌词层（空间中排布 + 镜头漂移），spaceShell 接线。"""
import io


def patch(path, pairs, label):
    s = io.open(path, 'r', encoding='utf-8', newline='').read()
    for name, old, new in pairs:
        assert s.count(old) == 1, f"anchor miss [{label}:{name}]: {old[:90]!r}"
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    print(f'patched {label}')


fs = r"E:\Zilux2开发\web\src\three\floatScene.ts"
ss = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
css = r"E:\Zilux2开发\web\src\styles\space.css"

patch(fs, [
    (
        'interface',
        "  /** 3D 歌词模式开关（歌词漂浮在飘散的磁贴之间） */\n  setLyricsView(visible: boolean): void;",
        "  /** 3D 歌词模式开关（歌词漂浮在飘散的磁贴之间） */\n  setLyricsView(visible: boolean): void;\n  /** PV 文字歌词（3D 场景内的柔和文字层，镜头缓慢漂移） */\n  setLyricPvMode(enabled: boolean): void;",
    ),
    (
        'state',
        "  let lyricsScale = 1;\n  let lyricEnterStyle: LyricEnterStyle = 'fade';",
        """  let lyricsScale = 1;
  let lyricEnterStyle: LyricEnterStyle = 'fade';
  /** PV 文字歌词（3D 场景内）：三句在空间中上下排布，镜头缓慢漂移 */
  let lyricPv = false;
  let pvAmount = 0;
  let pvCamReady = false;
  const pvAnchor = new THREE.Vector3();
  const pvCamTarget = new THREE.Vector3();
  const pvCamSmooth = new THREE.Vector3();
  type PvLineSlot = {
    plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    texture: THREE.CanvasTexture;
    index: number;
  };
  let pvGroup: THREE.Group | null = null;
  const pvLines: PvLineSlot[] = [];""",
    ),
    (
        'ensure+paint+update',
        "  function updateLyrics(delta: number): void {",
        """  function ensurePvLines(): void {
    if (pvGroup) return;
    pvGroup = new THREE.Group();
    pvGroup.renderOrder = 6;
    for (let slot = 0; slot < 3; slot += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = 1536;
      canvas.height = 512;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      const texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        opacity: 0,
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.47), material);
      plane.renderOrder = 6;
      plane.frustumCulled = false;
      pvGroup.add(plane);
      pvLines.push({ plane, canvas, ctx, texture, index: -1 });
    }
    scene.add(pvGroup);
  }

  function paintPvLine(slot: PvLineSlot, line: LyricLineData): void {
    const { ctx, canvas } = slot;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const translation = (line.translation ?? '').trim();
    const mainY = translation ? H * 0.4 : H * 0.5;
    ctx.shadowColor = 'rgba(200,214,255,0.55)';
    ctx.shadowBlur = 26;
    ctx.fillStyle = 'rgba(255,255,255,0.98)';
    const size = fitLyricFontSize(ctx, line.text, W * 0.9, 76, 40, 600);
    ctx.font = `600 ${Math.round(size)}px ${LYRIC_FONT}`;
    ctx.fillText(line.text, W / 2, mainY);
    if (translation) {
      ctx.shadowBlur = 12;
      ctx.shadowColor = 'rgba(190,205,255,0.4)';
      ctx.font = `500 ${Math.round(size * 0.42)}px ${LYRIC_FONT}`;
      ctx.fillStyle = 'rgba(206,220,255,0.7)';
      ctx.fillText(translation, W / 2, mainY + size * 0.8);
    }
    slot.texture.needsUpdate = true;
  }

  function updatePvLyrics(delta: number): void {
    const target = lyricPv && lyricData.length > 0 ? 1 : 0;
    pvAmount += (target - pvAmount) * Math.min(1, delta * 3.2);
    if (pvAmount <= 0.004 && target === 0) {
      if (pvGroup) pvGroup.visible = false;
      if (!lyricPv) pvCamReady = false;
      return;
    }
    ensurePvLines();
    if (!pvGroup) return;
    pvGroup.visible = true;
    const active = lyricActive;
    if (active < 0) {
      pvLines.forEach((slot) => {
        slot.plane.material.opacity = 0;
      });
      return;
    }
    lyricAnchor(active, pvAnchor);
    pvLines.forEach((slot, k) => {
      const rel = k - 1;
      const index = active + rel;
      const line = index >= 0 ? lyricData[index] : undefined;
      if (!line) {
        slot.plane.visible = false;
        return;
      }
      slot.plane.visible = true;
      if (slot.index !== index) {
        slot.index = index;
        paintPvLine(slot, line);
      }
      const sway = Math.sin(seconds * 0.33 + rel * 1.6) * 0.07;
      const drift = Math.cos(seconds * 0.26 + rel * 2.2) * 0.035;
      const offsetY = rel === 0 ? 0 : rel < 0 ? 0.94 : -0.94;
      const offsetZ = rel === 0 ? 0.4 : -0.7 - Math.abs(rel) * 0.3;
      slot.plane.position.set(pvAnchor.x + sway, pvAnchor.y + offsetY + drift, pvAnchor.z + offsetZ);
      slot.plane.scale.setScalar(rel === 0 ? 1.34 : 0.8);
      slot.plane.rotation.z = rel * 0.012 + Math.sin(seconds * 0.21 + rel) * 0.006;
      slot.plane.material.opacity = (rel === 0 ? 1 : 0.32) * pvAmount;
    });
    pvCamTarget.set(
      pvAnchor.x + Math.sin(seconds * 0.17) * 0.26,
      pvAnchor.y + 0.1 + Math.cos(seconds * 0.14) * 0.06,
      pvAnchor.z + 3.05 + Math.sin(seconds * 0.11) * 0.15,
    );
    if (!pvCamReady) {
      pvCamSmooth.copy(pvCamTarget);
      pvCamReady = true;
    }
    pvCamSmooth.lerp(pvCamTarget, Math.min(1, delta * 2.3));
    camera.position.copy(pvCamSmooth);
    camera.up.set(0, 1, 0);
    camera.lookAt(pvAnchor);
  }

  function updateLyrics(delta: number): void {""",
    ),
    (
        'frame call',
        "    camera.lookAt(lookTarget);\n\n    starMaterial.uniforms.uTime!.value = seconds;",
        "    camera.lookAt(lookTarget);\n    updatePvLyrics(delta);\n\n    starMaterial.uniforms.uTime!.value = seconds;",
    ),
    (
        'tile hide',
        "  function updateTiles(delta: number): void {",
        """  function updateTiles(delta: number): void {
    if (pvAmount > 0.02) {
      tiles.forEach((tile) => {
        tile.group.visible = false;
      });
      return;
    }""",
    ),
    (
        'handle impl',
        "    setLyricsView(visible: boolean) {\n      lyricVisible = visible;",
        "    setLyricPvMode(enabled: boolean) {\n      lyricPv = enabled;\n      if (!enabled) pvCamReady = false;\n      ensurePvLines();\n    },\n    setLyricsView(visible: boolean) {\n      lyricVisible = visible;",
    ),
    (
        'dispose',
        "      if (lyricGroup) {\n        scene.remove(lyricGroup);",
        """      if (pvGroup) {
        scene.remove(pvGroup);
        pvLines.forEach((slot) => {
          slot.texture.dispose();
          slot.plane.geometry.dispose();
          slot.plane.material.dispose();
        });
        pvLines.length = 0;
        pvGroup = null;
      }
      if (lyricGroup) {
        scene.remove(lyricGroup);""",
    ),
], 'floatScene')

patch(ss, [
    (
        'ticker',
        """  function stepLyricsClock(): void {
    if (!lyricsOpen) return;
    if (lyricMode === 'pv') {
      pvLyrics.setTime(island.currentTime());
    } else {
      space?.setLyricsTime(island.currentTime());
    }
    lyricsTimer = window.requestAnimationFrame(stepLyricsClock);
  }""",
        """  function stepLyricsClock(): void {
    if (!lyricsOpen) return;
    // 两种模式都用 3D 歌词引擎的时间轴；PV 的 DOM 层只保留背景氛围（不再画字）
    space?.setLyricsTime(island.currentTime());
    lyricsTimer = window.requestAnimationFrame(stepLyricsClock);
  }""",
    ),
    (
        'enter pv',
        """    if (lyricMode === 'pv') {
      // PV 模式：隐藏磁贴封面，只留柔和文字 PV（回退时磁贴再回来）
      space?.setLyricsView(false);
      space?.setTilesVisible(false);
      pvLyrics.show();
      setStatus('PV 歌词模式 · 点「返回」或按 Esc 回到封面墙');
    } else {
      lyricsDim.classList.add('is-on');
      space?.setLyricsView(true);
      space?.setLyricsTime(island.currentTime());
      space?.setTilesScattered(true);
      setStatus('歌词模式 · 点「返回」或按 Esc 回到封面墙');
    }""",
        """    if (lyricMode === 'pv') {
      // PV 模式：3D 场景内的柔和文字层（磁贴隐藏，回退时磁贴再回来）
      lyricsDim.classList.add('is-on');
      space?.setTilesScattered(false);
      space?.setLyricsView(true);
      space?.setLyricPvMode(true);
      space?.setLyricsTime(island.currentTime());
      pvLyrics.show();
      root.classList.add('pv-3d');
      setStatus('PV 歌词模式 · 点「返回」或按 Esc 回到封面墙');
    } else {
      space?.setLyricPvMode(false);
      root.classList.remove('pv-3d');
      pvLyrics.hide();
      lyricsDim.classList.add('is-on');
      space?.setLyricsView(true);
      space?.setLyricsTime(island.currentTime());
      space?.setTilesScattered(true);
      setStatus('歌词模式 · 点「返回」或按 Esc 回到封面墙');
    }""",
    ),
    (
        'exit',
        """    space?.setLyricsView(false);
    space?.setTilesScattered(false);
    pvLyrics.hide();""",
        """    space?.setLyricsView(false);
    space?.setLyricPvMode(false);
    space?.setTilesScattered(false);
    pvLyrics.hide();
    root.classList.remove('pv-3d');""",
    ),
    (
        'pvtest qa',
        """        lyricMode = 'pv';
        pvLyrics.setLines([
          { text: '夜に駆ける', translation: '向着夜晚奔跑', start: 0, end: 3.2 },
          { text: '柔和的光落在你我之间', translation: '温柔的光洒落在我们之间', start: 3.2, end: 6.6 },
          { text: '忘れないように', translation: '为了不要忘记', start: 6.6, end: 9.8 },
        ]);
        pvLyrics.show();
        pvLyrics.setTime(3.6);
        space?.setTilesVisible(false);
        lyricsOpen = true;
        lyricsBtn.classList.add('is-on');
        setStatus('PV 歌词模式 · QA');""",
        """        lyricMode = 'pv';
        space?.setLyrics([
          { text: '夜に駆ける', translation: '向着夜晚奔跑', startTime: 0 },
          { text: '柔和的光落在你我之间', translation: '温柔的光洒落在我们之间', startTime: 2 },
          { text: '忘れないように', translation: '为了不要忘记', startTime: 4 },
        ]);
        space?.setLyricsView(true);
        space?.setLyricPvMode(true);
        space?.setLyricsTime(2.4);
        pvLyrics.show();
        root.classList.add('pv-3d');
        lyricsDim.classList.add('is-on');
        lyricsOpen = true;
        lyricsBtn.classList.add('is-on');
        setStatus('PV 歌词模式 · QA');""",
    ),
], 'spaceShell')

s = io.open(css, 'r', encoding='utf-8', newline='').read()
s += """
/* PV 模式：DOM 层只留氛围/灰尘，文字由 3D 场景绘制 */
.pv-3d .pv-stage {
  display: none;
}
.pv-3d .pv-layer {
  background: none;
}
"""
io.open(css, 'w', encoding='utf-8', newline='').write(s)
print('css pv-3d')
