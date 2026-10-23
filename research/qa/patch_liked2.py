# -*- coding: utf-8 -*-
"""v1.12 spaceShell：左侧「我喜欢的音乐」入口 + 歌曲玻璃条视图（隐藏歌单玻璃片、相机转 270° 俯视）。"""
import io
import shutil

p = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
shutil.copyfile(p, p + '.bak-v12')
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new):
    global s
    assert s.count(old) == 1, ('anchor', old[:70], s.count(old))
    s = s.replace(old, new, 1)


# 1) import
rep(
    "import { fetchLibraryOverview } from '../library';",
    "import { fetchLibraryOverview, fetchPlaylist } from '../library';",
)

# 2) rail 增加「我喜欢」
rep(
    """      <button class="space-rail-btn" data-rail="library" type="button" aria-label="歌单" title="歌单">${icon('playlist', 18)}</button>""",
    """      <button class="space-rail-btn" data-rail="library" type="button" aria-label="歌单" title="歌单">${icon('playlist', 18)}</button>
      <button class="space-rail-btn" data-rail="liked" type="button" aria-label="我喜欢的音乐" title="我喜欢的音乐">${icon('heart', 18)}</button>""",
)

# 3) rail 点击
rep(
    """      if (feature === 'account') {
        openAccountSheet();
        return;
      }""",
    """      if (feature === 'account') {
        openAccountSheet();
        return;
      }
      if (feature === 'liked') {
        void toggleLikedView();
        return;
      }""",
)

# 4) liked 视图逻辑（插在 loadChipCards 之后）
rep(
    """  void loadChipCards();
  // online 端点可能晚于页面挂载就绪：等它到达后再读一次，并做一次兜底重试""",
    """  void loadChipCards();

  /* 左侧「我喜欢的音乐」：隐藏歌单玻璃片，显示歌曲玻璃条列表（相机转 270° 俯视） */
  let likedViewOpen = false;
  async function toggleLikedView(): Promise<void> {
    if (!space) return;
    if (!entered) {
      enterSpace(true);
    }
    if (likedViewOpen) {
      exitLikedView();
      return;
    }
    likedViewOpen = true;
    space.setChipsVisible(false);
    space.setSongListVisible(true);
    space.setView(0.02, Math.PI * 1.5, 13.2, true);
    setStatus('我喜欢的音乐 · 正在读取…');
    try {
      const overview = await fetchLibraryOverview();
      let songs: Array<{ title: string; artist?: string; durationMs?: number }> = [];
      for (const source of ['netease', 'qq'] as const) {
        const state = overview.sources.find((item) => item.source === source);
        if (!state?.loggedIn || !state.liked) continue;
        const detail = await fetchPlaylist(source, 'liked', 0, 12, 'liked');
        songs = detail.tracks.slice(0, 12).map((track) => ({
          title: track.title,
          artist: track.artist,
          durationMs: track.durationMs,
        }));
        if (songs.length > 0) break;
      }
      space.setSongs(songs);
      setStatus(songs.length > 0 ? '我喜欢的音乐 · 点左侧红心再点一次可返回歌单' : '我喜欢的音乐 · 暂无歌曲（请先在账号里登录平台）');
    } catch (error) {
      console.warn('[liked] 读取失败', error);
      setStatus('我喜欢的音乐 · 读取失败，稍后重试');
    }
  }

  function exitLikedView(): void {
    if (!likedViewOpen) return;
    likedViewOpen = false;
    space?.setSongListVisible(false);
    space?.setChipsVisible(true);
    space?.setView(0.03, 0, 13.2, true);
    setStatus('拖动旋转 · 中键平移 · 滚轮缩放');
  }

  // online 端点可能晚于页面挂载就绪：等它到达后再读一次，并做一次兜底重试""",
)

# 5) 小玻璃卡：每平台 6 个（共 12 片）
rep(
    """        own.slice(0, 3).forEach((playlist) => {
          cards.push({
            title: playlist.title,
            subtitle: `${SOURCE_TITLE[source]} · ${playlist.count} 首`,
            cover: playlist.cover,
          });
        });
        while (cards.length % 3 !== 0) cards.push(null);
      });
      while (cards.length < 6) cards.push(null);
      space?.setChipCards(cards.slice(0, 6));""",
    """        own.slice(0, 6).forEach((playlist) => {
          cards.push({
            title: playlist.title,
            subtitle: `${SOURCE_TITLE[source]} · ${playlist.count} 首`,
            cover: playlist.cover,
          });
        });
        while (cards.length % 6 !== 0) cards.push(null);
      });
      while (cards.length < 12) cards.push(null);
      space?.setChipCards(cards.slice(0, 12));""",
)

# 6) Esc 退出 liked 视图（优先于退出空间）
rep(
    """    if (event.key === 'Escape' && entered) {
      event.preventDefault();
      leaveSpace();
    }""",
    """    if (event.key === 'Escape' && likedViewOpen) {
      event.preventDefault();
      exitLikedView();
      return;
    }
    if (event.key === 'Escape' && entered) {
      event.preventDefault();
      leaveSpace();
    }""",
)

# 7) 离开空间时重置 liked 视图
rep(
    """  function leaveSpace(): void {
    if (!entered) return;
    entered = false;""",
    """  function leaveSpace(): void {
    if (!entered) return;
    exitLikedView();
    entered = false;""",
)

# 8) QA：?panel=liked 自动进入空间并打开我喜欢的音乐
rep(
    """  // QA：?panel=custom 直接打开自定义外观面板
  if (params.get('panel') === 'custom') {""",
    """  // QA：?panel=liked 直接进入空间并打开「我喜欢的音乐」
  if (params.get('panel') === 'liked') {
    window.setTimeout(() => {
      if (!disposed) void toggleLikedView();
    }, 900);
  }

  // QA：?panel=custom 直接打开自定义外观面板
  if (params.get('panel') === 'custom') {""",
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell patched: liked view')
