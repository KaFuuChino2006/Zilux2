# -*- coding: utf-8 -*-
"""spaceShell：接入灵动岛播放器（点击磁贴播放，底部三胶囊）。"""
import io

P = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s = io.open(P, 'r', encoding='utf-8', newline='').read()


def rep(old, new, count=1):
    global s
    assert s.count(old) >= count, 'MISSING ANCHOR: ' + old[:80].replace('\n', ' | ')
    s = s.replace(old, new, count)


# 1) import
rep(
    "import { isMockOnline, onOnlineChange, searchOnline } from '../online/client';",
    "import { isMockOnline, onOnlineChange, searchOnline, type OnlineTrack } from '../online/client';",
)
rep(
    "import { icon } from './icons';",
    "import { icon } from './icons';\nimport { createIslandPlayer } from './islandPlayer';",
)

# 2) 播放器实例 + 当前磁贴曲目
rep(
    "  space.start();\n  applyCustom();",
    """  space.start();
  applyCustom();

  let tileTracks: OnlineTrack[] = [];
  const island = createIslandPlayer({
    onError: (message) => showToast(message, 'error'),
  });
  root.appendChild(island.element);""",
)

# 3) 磁贴点击 → 播放
rep(
    """    onTileClick: (index) => {
      const globalIndex = index;
      showToast(globalIndex >= 0 ? '播放功能即将开放' : '这首暂时无法播放', 'info');
    },""",
    """    onTileClick: (index) => {
      const track = tileTracks[index];
      if (!track) {
        showToast('这首暂时无法播放', 'warn');
        return;
      }
      island.play(track, tileTracks);
    },""",
)

# 4) liked 数据：保存曲目
rep(
    """        const detail = await fetchPlaylist(source, 'liked', 0, 120, 'liked');
        tiles = detail.tracks.map((track) => ({
          title: track.title,
          artist: track.artist,
          cover: track.cover,
        }));
        if (tiles.length > 0) break;""",
    """        const detail = await fetchPlaylist(source, 'liked', 0, 120, 'liked');
        tileTracks = detail.tracks.slice();
        tiles = detail.tracks.map((track) => ({
          title: track.title,
          artist: track.artist,
          cover: track.cover,
        }));
        if (tiles.length > 0) break;""",
)

# 5) 搜索结果：保存曲目
rep(
    """      if (!entered) enterSpace(false);
      space?.setTilesVisible(true);
      space?.setTiles(tracks.map((track) => ({ title: track.title, artist: track.artist, cover: track.cover })));
      setStatus(`搜索「${keyword}」· ${tracks.length} 首 · 拖动旋转视角 / 滚轮滚动`);""",
    """      if (!entered) enterSpace(false);
      tileTracks = tracks;
      space?.setTilesVisible(true);
      space?.setTiles(tracks.map((track) => ({ title: track.title, artist: track.artist, cover: track.cover })));
      setStatus(`搜索「${keyword}」· ${tracks.length} 首 · 拖动旋转视角 / 滚轮滚动`);""",
)

# 6) QA：?play=1 自动播放喜欢的歌单第一首（真机验证底部胶囊）
rep(
    """  // QA：?panel=search 直接打开搜索浮层""",
    """  // QA：?play=1 自动播放我喜欢的歌单第一首（验证灵动岛播放器）
  if (params.get('play') === '1') {
    window.setTimeout(() => {
      if (disposed) return;
      const track = tileTracks[0];
      if (track) island.play(track, tileTracks);
    }, 2600);
  }

  // QA：?panel=search 直接打开搜索浮层""",
)

# 7) destroy 清理播放器
rep(
    "    destroy(): void {\n      disposed = true;",
    "    destroy(): void {\n      disposed = true;\n      island.destroy();",
)

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell island patch ok')
