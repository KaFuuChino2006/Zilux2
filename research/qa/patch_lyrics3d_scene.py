# -*- coding: utf-8 -*-
"""3D 歌词：歌词作为 three 场景里的悬浮文字平面，漂浮在飘散的磁贴之间。"""
import io

SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'
SHELL = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'


def read(p):
    return io.open(p, 'r', encoding='utf-8', newline='').read()


def write(p, t):
    io.open(p, 'w', encoding='utf-8', newline='').write(t)


# ---------------- floatScene ----------------
s = read(SCENE)

old = """  /** 环绕屏弯曲幅度 0（平面）~1（强环绕） */
  setTileBend(bend: number): void;"""
new = """  /** 环绕屏弯曲幅度 0（平面）~1（强环绕） */
  setTileBend(bend: number): void;
  /** 设置歌词行（时间轴），配合 setLyricsView 在 3D 空间里显示 */
  setLyrics(lines: LyricLineData[]): void;
  /** 3D 歌词模式开关（歌词漂浮在飘散的磁贴之间） */
  setLyricsView(visible: boolean): void;
  /** 刷新歌词当前播放时间（秒） */
  setLyricsTime(seconds: number): void;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 3D 歌词实现：插在 buildTilePool 初始调用之后
old = """  buildTilePool(tileCols * tileRows);

  /* 详情磁贴"""
new = """  buildTilePool(tileCols * tileRows);

  /* ------------------------------ 3D 歌词 ------------------------------ */

  const LYRIC_SLOTS = 7;
  const LYRIC_ACTIVE_SLOT = 3;
  const LYRIC_FONT = '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif';
  let lyricGroup: THREE.Group | null = null;
  const lyricLines: LyricLineView[] = [];
  let lyricData: LyricLineData[] = [];
  let lyricAmount = 0;
  let lyricVisible = false;
  let lyricActive = -1;

  function clipTextWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let out = text;
    while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) {
      out = out.slice(0, -1);
    }
    return out + '…';
  }

  function paintLyricLine(view: LyricLineView): void {
    const ctx = view.canvas.getContext('2d');
    if (!ctx) return;
    const W = view.canvas.width;
    const H = view.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const hasTranslation = view.translation.trim().length > 0;
    const mainSize = view.active ? 74 : 54;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (view.active) {
      ctx.shadowColor = 'rgba(146, 122, 255, 0.85)';
      ctx.shadowBlur = 26;
    }
    ctx.fillStyle = view.active ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.66)';
    ctx.font = '700 ' + mainSize + 'px ' + LYRIC_FONT;
    const mainY = hasTranslation ? H * 0.4 : H * 0.5;
    ctx.fillText(clipTextWidth(ctx, view.text, W * 0.94), W / 2, mainY);
    if (hasTranslation) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = view.active ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.4)';
      ctx.font = '500 ' + (view.active ? 36 : 28) + 'px ' + LYRIC_FONT;
      ctx.fillText(clipTextWidth(ctx, view.translation, W * 0.9), W / 2, H * 0.76);
    }
    view.texture.needsUpdate = true;
  }

  function ensureLyricLines(): void {
    if (lyricGroup) return;
    lyricGroup = new THREE.Group();
    lyricGroup.position.set(0, 0.25, 2.35);
    lyricGroup.rotation.x = -0.04;
    scene.add(lyricGroup);
    for (let i = 0; i < LYRIC_SLOTS; i += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 256;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(7.7, 1.92),
        new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
        }),
      );
      plane.renderOrder = 40;
      const group = new THREE.Group();
      group.add(plane);
      group.position.y = (LYRIC_ACTIVE_SLOT - i) * 1.32;
      group.scale.setScalar(0.9);
      lyricGroup.add(group);
      const view: LyricLineView = {
        group,
        plane,
        texture,
        canvas,
        text: '',
        translation: '',
        active: false,
      };
      paintLyricLine(view);
      lyricLines.push(view);
    }
  }

  function syncLyricSlots(): void {
    if (!lyricGroup) return;
    if (lyricData.length === 0) {
      lyricLines.forEach((view) => {
        view.plane.material.opacity = 0;
      });
      return;
    }
    for (let i = 0; i < LYRIC_SLOTS; i += 1) {
      const view = lyricLines[i];
      const line = lyricData[lyricActive + (i - LYRIC_ACTIVE_SLOT)];
      const text = line ? line.text : '';
      const translation = line && line.translation ? line.translation : '';
      const active = i === LYRIC_ACTIVE_SLOT;
      if (view.text !== text || view.translation !== translation || view.active !== active) {
        view.text = text;
        view.translation = translation;
        view.active = active;
        paintLyricLine(view);
      }
    }
  }

  function updateLyrics(delta: number): void {
    const target = lyricVisible ? 1 : 0;
    lyricAmount += (target - lyricAmount) * Math.min(1, delta * 4.5);
    if (!lyricGroup) {
      if (lyricAmount > 0.01) ensureLyricLines();
      if (!lyricGroup) return;
    }
    lyricGroup.visible = lyricAmount > 0.02;
    if (!lyricGroup.visible) return;
    const ease = lyricAmount * lyricAmount * (3 - 2 * lyricAmount);
    lyricLines.forEach((view, i) => {
      const offset = i - LYRIC_ACTIVE_SLOT;
      const dist = Math.abs(offset);
      const targetY = -offset * 1.32;
      view.group.position.y += (targetY - view.group.position.y) * Math.min(1, delta * 6);
      view.group.position.z = -dist * 0.42 - (1 - ease) * 0.7;
      const scale = (dist === 0 ? 1 : dist === 1 ? 0.8 : 0.64) * (0.9 + 0.1 * ease);
      view.group.scale.setScalar(scale);
      const baseOpacity = dist === 0 ? 1 : dist === 1 ? 0.4 : 0.16;
      view.plane.material.opacity = baseOpacity * ease;
    });
    lyricGroup.position.x = Math.sin(seconds * 0.32) * 0.34;
    lyricGroup.position.y = 0.25 + Math.sin(seconds * 0.52) * 0.07;
    lyricGroup.rotation.z = Math.sin(seconds * 0.21) * 0.014;
    lyricGroup.rotation.y = Math.sin(seconds * 0.17) * 0.02;
  }

  /* 详情磁贴"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# frame 中调用 updateLyrics
old = "    updateTiles(delta);"
new = "    updateTiles(delta);\n    updateLyrics(delta);"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# handle 方法
old = """    setTileBend(bend: number) {
      tileBendTarget = Math.max(0, Math.min(1, bend));
    },"""
new = """    setTileBend(bend: number) {
      tileBendTarget = Math.max(0, Math.min(1, bend));
    },
    setLyrics(lines: LyricLineData[]) {
      lyricData = lines;
      lyricActive = -1;
      ensureLyricLines();
      syncLyricSlots();
    },
    setLyricsView(visible: boolean) {
      lyricVisible = visible;
      if (visible) ensureLyricLines();
    },
    setLyricsTime(current: number) {
      if (!lyricVisible || lyricData.length === 0) return;
      let active = -1;
      for (let i = 0; i < lyricData.length; i += 1) {
        if (lyricData[i].startTime <= current + 0.05) active = i;
        else break;
      }
      if (active !== lyricActive) {
        lyricActive = active;
        syncLyricSlots();
      }
    },"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# dispose 释放歌词资源
old = """      starGeometry.dispose();
      starMaterial.dispose();
      renderer.dispose();"""
new = """      if (lyricGroup) {
        scene.remove(lyricGroup);
        lyricLines.forEach((view) => {
          view.texture.dispose();
          view.plane.geometry.dispose();
          view.plane.material.dispose();
        });
        lyricLines.length = 0;
        lyricGroup = null;
      }
      starGeometry.dispose();
      starMaterial.dispose();
      renderer.dispose();"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 类型定义：放在文件顶部接口区域内（TileDetailInfo 之后）
old = "export interface TileDetailInfo {"
new = """export interface LyricLineData {
  text: string;
  translation?: string;
  startTime: number;
}

export interface LyricLineView {
  group: THREE.Group;
  plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  text: string;
  translation: string;
  active: boolean;
}

export interface TileDetailInfo {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)
write(SCENE, s)
print('floatScene: 3D lyrics planes')

# ---------------- spaceShell ----------------
s = read(SHELL)

old = "import { createLyricsStage, type LyricsStage } from '../three/lyricsStage';"
new = "import type { LyricLineData } from '../three/floatScene';"
assert s.count(old) == 1
s = s.replace(old, new, 1)

# 删除 DOM 歌词层模板与引用
old = """    <div class="lyrics-layer" data-lyrics-layer hidden>
      <canvas class="lyrics-canvas" data-lyrics-canvas></canvas>
    </div>
"""
assert s.count(old) == 1
s = s.replace(old, "", 1)

old = """  const lyricsLayer = root.querySelector<HTMLElement>('[data-lyrics-layer]')!;
  const lyricsCanvas = root.querySelector<HTMLCanvasElement>('[data-lyrics-canvas]')!;
"""
assert s.count(old) == 1
s = s.replace(old, "", 1)

# 重写歌词逻辑
old = """  let lyricsStage: LyricsStage | null = null;
  let lyricsOpen = false;
  let lyricsTimer = 0;
  let lyricsTrackKey = '';

  async function loadLyricIntoStage(track: OnlineTrack): Promise<void> {
    if (!lyricsStage) return;
    const key = `${track.source}:${track.id}`;
    if (lyricsTrackKey === key) return;
    lyricsTrackKey = key;
    try {
      const lyric = await fetchLyric(track.source, track.id);
      const parsed = applyTranslation(parseLrc(lyric.lrc), lyric.translation).filter(
        (line) => line.text.trim().length > 0,
      );
      const stageLines = parsed.map((line, index, list) => ({
        text: line.text,
        translation: line.translation,
        startTime: line.timeMs / 1000,
        endTime: (list[index + 1]?.timeMs ?? line.timeMs + 7000) / 1000,
      }));
      lyricsStage.setLines(stageLines);
      if (stageLines.length === 0) showToast('这首歌暂时没有歌词', 'info');
    } catch (error) {
      console.warn('[lyrics] 歌词读取失败', error);
      showToast('歌词读取失败，稍后再试', 'warn');
    }
  }

  async function enterLyricsView(): Promise<void> {
    const track = island.currentTrack();
    if (!track) {
      showToast('先放一首歌，再看歌词', 'info');
      return;
    }
    lyricsOpen = true;
    lyricsBtn.classList.add('is-on');
    lyricsLabel.textContent = '返回';
    lyricsLayer.hidden = false;
    window.requestAnimationFrame(() => lyricsLayer.classList.add('is-open'));
    if (!lyricsStage) {
      lyricsStage = createLyricsStage(lyricsCanvas, { maxLines: 7, pixelBudget: 3_600_000 });
    }
    lyricsStage.resize();
    lyricsStage.start();
    space?.setTilesScattered(true);
    void loadLyricIntoStage(track);
    window.clearInterval(lyricsTimer);
    lyricsTimer = window.setInterval(() => {
      lyricsStage?.setTime(island.currentTime());
    }, 100);
    setStatus('歌词模式 · 点「返回」或按 Esc 回到封面墙');
  }

  function exitLyricsView(): void {
    if (!lyricsOpen && lyricsLayer.hidden) return;
    lyricsOpen = false;
    window.clearInterval(lyricsTimer);
    lyricsTimer = 0;
    lyricsStage?.stop();
    lyricsLayer.classList.remove('is-open');
    window.setTimeout(() => {
      if (!lyricsOpen) lyricsLayer.hidden = true;
    }, 360);
    lyricsBtn.classList.remove('is-on');
    lyricsLabel.textContent = '歌词';
    lyricsTrackKey = '';
    space?.setTilesScattered(false);
    if (island.element.hidden) {
      lyricsBtn.hidden = true;
    } else {
      lyricsBtn.hidden = false;
      setStatus(likedStatusText());
    }
  }"""
new = """  let lyricsOpen = false;
  let lyricsTimer = 0;
  let lyricsTrackKey = '';

  async function loadLyrics3d(track: OnlineTrack): Promise<void> {
    const key = `${track.source}:${track.id}`;
    if (lyricsTrackKey === key) return;
    lyricsTrackKey = key;
    try {
      const lyric = await fetchLyric(track.source, track.id);
      const parsed = applyTranslation(parseLrc(lyric.lrc), lyric.translation).filter(
        (line) => line.text.trim().length > 0,
      );
      const lines: LyricLineData[] = parsed.map((line) => ({
        text: line.text,
        translation: line.translation,
        startTime: line.timeMs / 1000,
      }));
      space?.setLyrics(lines);
      if (lines.length === 0) showToast('这首歌暂时没有歌词', 'info');
      else space?.setLyricsTime(island.currentTime());
    } catch (error) {
      console.warn('[lyrics] 歌词读取失败', error);
      showToast('歌词读取失败，稍后再试', 'warn');
    }
  }

  async function enterLyricsView(): Promise<void> {
    const track = island.currentTrack();
    if (!track) {
      showToast('先放一首歌，再看歌词', 'info');
      return;
    }
    lyricsOpen = true;
    lyricsBtn.classList.add('is-on');
    lyricsLabel.textContent = '返回';
    space?.unfocusTile();
    space?.setLyricsView(true);
    space?.setLyricsTime(island.currentTime());
    space?.setTilesScattered(true);
    void loadLyrics3d(track);
    window.clearInterval(lyricsTimer);
    lyricsTimer = window.setInterval(() => {
      space?.setLyricsTime(island.currentTime());
    }, 100);
    setStatus('歌词模式 · 点「返回」或按 Esc 回到封面墙');
  }

  function exitLyricsView(): void {
    if (!lyricsOpen) return;
    lyricsOpen = false;
    window.clearInterval(lyricsTimer);
    lyricsTimer = 0;
    space?.setLyricsView(false);
    space?.setTilesScattered(false);
    lyricsBtn.classList.remove('is-on');
    lyricsLabel.textContent = '歌词';
    lyricsTrackKey = '';
    if (island.element.hidden) {
      lyricsBtn.hidden = true;
    } else {
      lyricsBtn.hidden = false;
      setStatus(likedStatusText());
    }
  }"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "        if (track) void loadLyricIntoStage(track);"
new = "        if (track) void loadLyrics3d(track);"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """      window.clearInterval(lyricsTimer);
      lyricsStage?.dispose();
      lyricsStage = null;"""
new = """      window.clearInterval(lyricsTimer);
      space?.setLyricsView(false);"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

write(SHELL, s)
print('spaceShell: 3D lyrics wired to floatScene')
