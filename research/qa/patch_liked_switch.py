# -*- coding: utf-8 -*-
"""左侧「我喜欢」来源切换按钮（网易云 / QQ） + 磁贴上限 300。"""
import io

SHELL = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
SCENE = r'E:\Zilux2开发\web\src\three\floatScene.ts'
CSS = r'E:\Zilux2开发\web\src\styles\space.css'

# ---------- spaceShell.ts ----------
s = io.open(SHELL, 'r', encoding='utf-8', newline='').read()

old_import = "import { fetchLibraryOverview, fetchPlaylist } from '../library';"
new_import = "import { fetchLibraryOverview, fetchPlaylist, type MusicSource } from '../library';"
assert s.count(old_import) == 1
s = s.replace(old_import, new_import, 1)

old_rail = """      <button class="space-rail-btn" data-rail="liked" type="button" aria-label="我喜欢的音乐" title="我喜欢的音乐">${icon('heart', 18)}</button>"""
new_rail = """      <button class="space-rail-btn space-rail-src is-on" data-liked-source="netease" type="button" aria-label="网易云我喜欢" title="网易云 · 我喜欢的音乐"><span class="rail-src-text">网易</span></button>
      <button class="space-rail-btn space-rail-src" data-liked-source="qq" type="button" aria-label="QQ我喜欢" title="QQ 音乐 · 我喜欢的音乐"><span class="rail-src-text">QQ</span></button>"""
assert s.count(old_rail) == 1
s = s.replace(old_rail, new_rail, 1)

start = s.index("  /* 默认视图：我喜欢的歌单（3D 磁贴墙：封面 + 封面靠下位置显示歌名） */")
end = s.index("  async function toggleLikedView(): Promise<void> {")
new_block = """  /* 默认视图：我喜欢的歌单（3D 磁贴墙：封面 + 封面靠下位置显示歌名） */
  let likedViewOpen = false;
  let likedSource: MusicSource = 'netease';
  const LIKED_TILE_LIMIT = 300;

  function likedLabel(source: MusicSource): string {
    return source === 'netease' ? '网易云' : 'QQ 音乐';
  }

  async function loadLikedTiles(): Promise<void> {
    if (!space) return;
    space.setTilesVisible(true);
    const label = likedLabel(likedSource);
    setStatus(`${label} · 我喜欢的音乐 · 正在读取…`);
    try {
      const detail = await fetchPlaylist(likedSource, 'liked', 0, LIKED_TILE_LIMIT, 'liked');
      const tracks = detail.tracks.slice(0, LIKED_TILE_LIMIT);
      tileTracks = tracks;
      space.setTiles(
        tracks.map((track) => ({ title: track.title, artist: track.artist, cover: track.cover })),
      );
      if (tracks.length === 0) {
        setStatus(`${label} · 我喜欢的音乐 · 暂无歌曲（请先在账号里登录平台）`);
        return;
      }
      const total = detail.count > 0 ? detail.count : tracks.length;
      const moreText = total > tracks.length ? ` · 共 ${total} 首，显示前 ${tracks.length}` : '';
      setStatus(`${label} · 我喜欢的音乐${moreText} · 拖动旋转 / 滚轮缩放 / 翻页箭头`);
    } catch (error) {
      console.warn('[liked] 读取失败', error);
      setStatus(`${label} · 我喜欢的音乐 · 读取失败，稍后重试`);
    }
  }

  function markLikedSource(source: MusicSource): void {
    root.querySelectorAll<HTMLElement>('[data-liked-source]').forEach((button) => {
      button.classList.toggle('is-on', button.dataset.likedSource === source);
    });
  }

  async function switchLikedSource(source: MusicSource): Promise<void> {
    if (!space) return;
    likedSource = source;
    markLikedSource(source);
    if (!likedViewOpen) {
      likedViewOpen = true;
      if (!entered) enterSpace(false);
    }
    await loadLikedTiles();
  }

"""
s = s[:start] + new_block + s[end:]

anchor = """      const label = feature === 'library' ? '歌单' : '设置';
      setStatus(`${label}功能即将开放`);
    });
  });
"""
bind = """      const label = feature === 'library' ? '歌单' : '设置';
      setStatus(`${label}功能即将开放`);
    });
  });

  /* 左侧「我喜欢」来源切换：网易云 / QQ 音乐 */
  root.querySelectorAll<HTMLButtonElement>('[data-liked-source]').forEach((button) => {
    button.addEventListener('click', () => {
      void switchLikedSource(button.dataset.likedSource === 'qq' ? 'qq' : 'netease');
    });
  });
"""
assert s.count(anchor) == 1
s = s.replace(anchor, bind, 1)
io.open(SHELL, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell: rail switch + liked loader')

# ---------- floatScene.ts ----------
f = io.open(SCENE, 'r', encoding='utf-8', newline='').read()
old = "      tileItems = list.slice(0, 120);"
new = "      tileItems = list.slice(0, 300);"
assert f.count(old) == 1
f = f.replace(old, new, 1)
for old_size, new_size in [
    ("    tileCanvas.width = 320;\n    tileCanvas.height = 320;", "    tileCanvas.width = 256;\n    tileCanvas.height = 256;"),
    ("    backCanvas.width = 320;\n    backCanvas.height = 320;", "    backCanvas.width = 256;\n    backCanvas.height = 256;"),
]:
    assert f.count(old_size) == 1, old_size
    f = f.replace(old_size, new_size, 1)
io.open(SCENE, 'w', encoding='utf-8', newline='').write(f)
print('floatScene: 300 tiles @256px')

# ---------- space.css ----------
c = io.open(CSS, 'r', encoding='utf-8', newline='').read()
c = c.rstrip() + """

/* 左侧「我喜欢」来源切换（网易云 / QQ）：圆钮内文字 + 平台色 + 选中态 */
.space-rail-src .rail-src-text {
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  line-height: 1;
}
.space-rail-btn[data-liked-source='netease'] {
  color: #c53030;
}
.space-rail-btn[data-liked-source='qq'] {
  color: #15803d;
}
.space-rail-btn[data-liked-source].is-on {
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 12px 26px rgba(56, 72, 110, 0.24);
  transform: translateX(2px);
}
"""
io.open(CSS, 'w', encoding='utf-8', newline='').write(c)
print('space.css: rail source styles')
