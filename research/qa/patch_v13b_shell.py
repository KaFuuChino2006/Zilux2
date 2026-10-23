# -*- coding: utf-8 -*-
"""v1.13 spaceShell：喜欢视图平滑过渡 + 滚动（wheel capture）+ 最多 50 首。"""
import io
import shutil

p = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
shutil.copyfile(p, p + '.bak-v13')
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new):
    global s
    assert s.count(old) == 1, ('anchor', old[:70], s.count(old))
    s = s.replace(old, new, 1)


# 1) toggleLikedView：平滑过渡 + 拉取 50 首
rep(
    """  async function toggleLikedView(): Promise<void> {
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
  }""",
    """  async function toggleLikedView(): Promise<void> {
    if (!space) return;
    if (likedViewOpen) {
      exitLikedView();
      return;
    }
    likedViewOpen = true;
    if (!entered) {
      enterSpace(false);
    }
    // 玻璃片缩小淡出、歌曲条升起、镜头平滑转到 270° 俯视（不硬切）
    space.setSongListVisible(true);
    space.setView(0.02, Math.PI * 1.5, 13.2, false);
    setStatus('我喜欢的音乐 · 正在读取…');
    try {
      const overview = await fetchLibraryOverview();
      let songs: Array<{ title: string; artist?: string; durationMs?: number }> = [];
      for (const source of ['netease', 'qq'] as const) {
        const state = overview.sources.find((item) => item.source === source);
        if (!state?.loggedIn || !state.liked) continue;
        const detail = await fetchPlaylist(source, 'liked', 0, 50, 'liked');
        songs = detail.tracks.slice(0, 50).map((track) => ({
          title: track.title,
          artist: track.artist,
          durationMs: track.durationMs,
        }));
        if (songs.length > 0) break;
      }
      space.setSongs(songs);
      setStatus(
        songs.length > 0
          ? `我喜欢的音乐 · ${songs.length} 首 · 滚动查看 / 再点红心返回歌单`
          : '我喜欢的音乐 · 暂无歌曲（请先在账号里登录平台）',
      );
    } catch (error) {
      console.warn('[liked] 读取失败', error);
      setStatus('我喜欢的音乐 · 读取失败，稍后重试');
    }
  }

  function onLikedWheel(event: WheelEvent): void {
    if (!likedViewOpen || !space) return;
    event.preventDefault();
    event.stopPropagation();
    space.scrollSongs(event.deltaY);
  }
  window.addEventListener('wheel', onLikedWheel, { passive: false, capture: true });""",
)

# 2) exitLikedView：平滑返回
rep(
    """  function exitLikedView(): void {
    if (!likedViewOpen) return;
    likedViewOpen = false;
    space?.setSongListVisible(false);
    space?.setChipsVisible(true);
    space?.setView(0.03, 0, 13.2, true);
    setStatus('拖动旋转 · 中键平移 · 滚轮缩放');
  }""",
    """  function exitLikedView(): void {
    if (!likedViewOpen) return;
    likedViewOpen = false;
    space?.setSongListVisible(false);
    space?.setView(0.03, 0, 13.2, false);
    setStatus('拖动旋转 · 中键平移 · 滚轮缩放');
  }""",
)

# 3) destroy 时移除 wheel 监听
rep(
    """    window.removeEventListener('keydown', onKeyDown);""",
    """    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('wheel', onLikedWheel, { capture: true } as EventListenerOptions);""",
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell v1.13 patched')
