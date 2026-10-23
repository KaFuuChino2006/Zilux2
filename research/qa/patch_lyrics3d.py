# -*- coding: utf-8 -*-
"""新增 3D 歌词：磁贴墙播放时下侧「歌词」按钮 → 磁贴随机飘散 + 3D 歌词从后浮现。"""
import io

ISLAND = r'E:\Zilux2开发\web\src\ui\islandPlayer.ts'
SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'
SHELL = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
CSS = r'E:\Zilux2开发\web\src\styles\space.css'


def read(path):
    return io.open(path, 'r', encoding='utf-8', newline='').read()


def write(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


# ---------------- 1. islandPlayer ----------------
s = read(ISLAND)
old = """  hide(): void;
  destroy(): void;
}"""
new = """  hide(): void;
  destroy(): void;
  /** 当前播放进度（秒） */
  currentTime(): number;
  /** 当前歌曲（未播放返回 null） */
  currentTrack(): OnlineTrack | null;
}"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    hide() {"""
new = """    currentTime() {
      return Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    },
    currentTrack() {
      return currentTrack();
    },
    hide() {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)
write(ISLAND, s)
print('islandPlayer: currentTime/currentTrack')

# ---------------- 2. floatScene ----------------
s = read(SCENE)
old = "  setTilesVisible(visible: boolean): void;"
new = "  setTilesVisible(visible: boolean): void;\n  /** 磁贴随机飘散（true）或飞回原位（false） */\n  setTilesScattered(scattered: boolean): void;"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "  let tileOffsetRows = 0;"
new = "  let tileOffsetRows = 0;\n  let tileScatter = 0;\n  let tileScatterTarget = 0;"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    tiles.forEach((tile) => {
      const appear = tileAmount;"""
new = """    tileScatter += (tileScatterTarget - tileScatter) * Math.min(1, delta * 2.2);
    const scatterEase = tileScatter * tileScatter * (3 - 2 * tileScatter);
    tiles.forEach((tile) => {
      const appear = tileAmount;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """      tile.group.position.x = slot.x + tile.pushX;
      tile.group.position.y =
        slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06;
      tile.group.position.z = 0.1 + t * 0.26 + sel * 0.22 - focusAmount * 0.45;
      tile.group.rotation.x = 0;
      tile.group.scale.setScalar(
        layoutScale * (0.94 + 0.06 * appear) * (1 + t * 0.11 + sel * 0.07),
      );"""
new = """      // 歌词模式：每块磁贴沿自己的随机方向飘散、旋转、缩小
      const seed = tile.index * 3.7 + 1.3;
      const rndX = Math.sin(seed * 12.9898) * 43758.5453;
      const rndY = Math.sin((seed + 1.7) * 78.233) * 43758.5453;
      const rndZ = Math.sin((seed + 3.1) * 39.425) * 43758.5453;
      const jitterX = (rndX - Math.floor(rndX) - 0.5) * 13;
      const jitterY = (rndY - Math.floor(rndY) - 0.5) * 8;
      const jitterZ = (rndZ - Math.floor(rndZ)) * 7;
      tile.group.position.x = slot.x + tile.pushX + jitterX * scatterEase;
      tile.group.position.y =
        slot.y + tile.pushY + (1 - appear) * -0.5 + t * 0.05 + sel * 0.06 + jitterY * scatterEase;
      tile.group.position.z =
        0.1 + t * 0.26 + sel * 0.22 - focusAmount * 0.45 + jitterZ * scatterEase * 1.8;
      tile.group.rotation.x = scatterEase * jitterY * 0.14;
      tile.group.rotation.z = -scatterEase * jitterX * 0.05;
      tile.group.scale.setScalar(
        layoutScale * (0.94 + 0.06 * appear) * (1 + t * 0.11 + sel * 0.07) * (1 - scatterEase * 0.32),
      );"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "    setTilesVisible(visible) {"
new = """    setTilesScattered(scattered: boolean) {
      tileScatterTarget = scattered ? 1 : 0;
      if (!scattered) refreshTiles();
    },
    setTilesVisible(visible) {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)
write(SCENE, s)
print('floatScene: tile scatter')

# ---------------- 3. spaceShell ----------------
s = read(SHELL)
old = "import { isMockOnline, onOnlineChange, searchOnline } from '../online/client';"
new = "import { fetchLyric, isMockOnline, onOnlineChange, searchOnline } from '../online/client';\nimport { applyTranslation, parseLrc } from '../online/lrc';"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "import { createFloatScene, type FloatSceneHandle } from '../three/floatScene';"
new = "import { createFloatScene, type FloatSceneHandle } from '../three/floatScene';\nimport { createLyricsStage, type LyricsStage } from '../three/lyricsStage';"
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """    <div class="space-foot">
      <span data-space-status>正在读取登录状态…</span>
    </div>"""
new = """    <div class="space-foot">
      <span data-space-status>正在读取登录状态…</span>
    </div>
    <button class="space-lyrics-btn" data-lyrics-btn type="button" hidden>
      <span class="space-lyrics-ico">${icon('lyrics', 15)}</span><span data-lyrics-label>歌词</span>
    </button>
    <div class="lyrics-layer" data-lyrics-layer hidden>
      <canvas class="lyrics-canvas" data-lyrics-canvas></canvas>
    </div>"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "  const statusEl = root.querySelector<HTMLElement>('[data-space-status]')!;"
new = """  const statusEl = root.querySelector<HTMLElement>('[data-space-status]')!;
  const lyricsBtn = root.querySelector<HTMLButtonElement>('[data-lyrics-btn]')!;
  const lyricsLabel = root.querySelector<HTMLElement>('[data-lyrics-label]')!;
  const lyricsLayer = root.querySelector<HTMLElement>('[data-lyrics-layer]')!;
  const lyricsCanvas = root.querySelector<HTMLCanvasElement>('[data-lyrics-canvas]')!;"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  const island = createIslandPlayer({
    onError: (message) => showToast(message, 'error'),
  });
  root.appendChild(island.element);"""
new = """  const island = createIslandPlayer({
    onError: (message) => showToast(message, 'error'),
    onStateChange: (state) => {
      if (state.playing) {
        lyricsBtn.hidden = false;
      } else if (!lyricsOpen) {
        lyricsBtn.hidden = true;
      }
      if (lyricsOpen) {
        const track = island.currentTrack();
        if (track) void loadLyricIntoStage(track);
      }
    },
  });
  root.appendChild(island.element);

  /* ------------------------------ 3D 歌词 ------------------------------ */

  let lyricsStage: LyricsStage | null = null;
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
  }

  lyricsBtn.addEventListener('click', () => {
    if (lyricsOpen) exitLyricsView();
    else void enterLyricsView();
  });"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && detailIndex >= 0) {"""
new = """  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && lyricsOpen) {
      event.preventDefault();
      exitLyricsView();
      return;
    }
    if (event.key === 'Escape' && detailIndex >= 0) {"""
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = """      disposed = true;
      island.destroy();"""
new = """      disposed = true;
      window.clearInterval(lyricsTimer);
      lyricsStage?.dispose();
      lyricsStage = null;
      island.destroy();"""
assert s.count(old) == 1
s = s.replace(old, new, 1)
write(SHELL, s)
print('spaceShell: 3D lyrics wiring')

# ---------------- 4. CSS ----------------
css = read(CSS)
css += """

/* ---------- 3D 歌词 ---------- */

.space-lyrics-btn {
  position: fixed;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  z-index: 6;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 18px;
  border: 1px solid rgba(255, 255, 255, 0.7);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.62);
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  backdrop-filter: blur(16px) saturate(150%);
  color: #353a46;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: 0 12px 28px rgba(66, 84, 140, 0.16);
  transition:
    background 0.2s ease,
    transform 0.2s ease,
    color 0.2s ease;
}

.space-lyrics-btn:hover {
  background: rgba(255, 255, 255, 0.82);
  transform: translateX(-50%) translateY(-1px);
}

.space-lyrics-btn.is-on {
  background: rgba(106, 92, 255, 0.16);
  border-color: rgba(106, 92, 255, 0.42);
  color: #4b3fd6;
}

.space-lyrics-btn[hidden] {
  display: none;
}

.space-lyrics-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: currentColor;
}

.lyrics-layer {
  position: fixed;
  inset: 0;
  z-index: 5;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.42s ease;
}

.lyrics-layer.is-open {
  opacity: 1;
}

.lyrics-layer[hidden] {
  display: none;
}

.lyrics-canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}
"""
write(CSS, css)
print('space.css: lyrics styles')
