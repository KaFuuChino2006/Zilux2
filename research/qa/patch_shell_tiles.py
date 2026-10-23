# -*- coding: utf-8 -*-
"""spaceShell：顶部搜索按钮 + 磁贴墙接线（默认打开我喜欢的歌单、滚轮滚动、点击提示）。"""
import io

P = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s = io.open(P, 'r', encoding='utf-8', newline='').read()


def rep(old, new, count=1):
    global s
    assert s.count(old) >= count, 'MISSING ANCHOR: ' + old[:80].replace('\n', ' | ')
    s = s.replace(old, new, count)


# 1) import searchOnline
rep(
    "import { isMockOnline, onOnlineChange } from '../online/client';",
    "import { isMockOnline, onOnlineChange, searchOnline } from '../online/client';",
)

# 2) 模板：顶部搜索按钮 + 搜索浮层
rep(
    '    <div class="space-wctrl" role="group" aria-label="窗口控制">',
    '''    <div class="space-topbar">
      <button class="space-topsearch" data-topsearch type="button" aria-label="搜索">${icon('search', 16)}<span>搜索</span></button>
    </div>
    <div class="space-search" data-space-search hidden>
      <div class="space-search-card" role="dialog" aria-modal="true" aria-label="搜索">
        <div class="space-search-row">
          <input class="space-search-input" data-search-input type="search" placeholder="搜索歌曲 / 歌手 / 专辑（网易云）" autocomplete="off" />
          <button class="space-topsearch space-search-go" data-search-go type="button">搜索</button>
        </div>
        <p class="space-search-hint" data-search-hint>回车搜索；结果会直接铺在空间里</p>
      </div>
    </div>
    <div class="space-wctrl" role="group" aria-label="窗口控制">''',
)

# 3) 元素引用
rep(
    "  const statusEl = root.querySelector<HTMLElement>('[data-space-status]')!;",
    """  const statusEl = root.querySelector<HTMLElement>('[data-space-status]')!;
  const topSearchBtn = root.querySelector<HTMLButtonElement>('[data-topsearch]')!;
  const searchOverlay = root.querySelector<HTMLElement>('[data-space-search]')!;
  const searchInput = root.querySelector<HTMLInputElement>('[data-search-input]')!;
  const searchGoBtn = root.querySelector<HTMLButtonElement>('[data-search-go]')!;
  const searchHintEl = root.querySelector<HTMLElement>('[data-search-hint]')!;""",
)

# 4) enterSpace：默认打开喜欢的歌单
rep(
    """    host.setChromeColor(CHROME_SPACE);
    setStatus('点击功能卡进入 · 鼠标悬停高亮');
  }""",
    """    host.setChromeColor(CHROME_SPACE);
    likedViewOpen = true;
    setStatus('拖动旋转视角 · 滚轮滚动歌曲');
    void loadLikedTiles();
  }""",
)

# 5) leaveSpace：重置
rep(
    """  function leaveSpace(): void {
    if (!entered) return;
    exitLikedView();
    entered = false;""",
    """  function leaveSpace(): void {
    if (!entered) return;
    likedViewOpen = false;
    space?.setTilesVisible(false);
    entered = false;""",
)

# 6) toggleLikedView / exitLikedView / loadLikedTiles / 搜索逻辑
old_liked = """  /* 左侧「我喜欢的音乐」：隐藏歌单玻璃片，显示歌曲玻璃条列表（相机转 270° 俯视） */
  let likedViewOpen = false;
  async function toggleLikedView(): Promise<void> {
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
  window.addEventListener('wheel', onLikedWheel, { passive: false, capture: true });

  function exitLikedView(): void {
    if (!likedViewOpen) return;
    likedViewOpen = false;
    space?.setSongListVisible(false);
    space?.setView(0.03, 0, 13.2, false);
    setStatus('点击功能卡进入 · 鼠标悬停高亮');
  }"""

new_liked = """  /* 默认视图：我喜欢的歌单（3D 磁贴墙：封面 + 封面靠下位置显示歌名） */
  let likedViewOpen = false;
  async function loadLikedTiles(): Promise<void> {
    if (!space) return;
    space.setTilesVisible(true);
    setStatus('我喜欢的音乐 · 正在读取…');
    try {
      const overview = await fetchLibraryOverview();
      let tiles: Array<{ title: string; artist?: string; cover?: string }> = [];
      for (const source of ['netease', 'qq'] as const) {
        const state = overview.sources.find((item) => item.source === source);
        if (!state?.loggedIn || !state.liked) continue;
        const detail = await fetchPlaylist(source, 'liked', 0, 120, 'liked');
        tiles = detail.tracks.map((track) => ({
          title: track.title,
          artist: track.artist,
          cover: track.cover,
        }));
        if (tiles.length > 0) break;
      }
      space.setTiles(tiles);
      setStatus(
        tiles.length > 0
          ? `我喜欢的音乐 · ${tiles.length} 首 · 拖动旋转视角 / 滚轮滚动`
          : '我喜欢的音乐 · 暂无歌曲（请先在账号里登录平台）',
      );
    } catch (error) {
      console.warn('[liked] 读取失败', error);
      setStatus('我喜欢的音乐 · 读取失败，稍后重试');
    }
  }

  async function toggleLikedView(): Promise<void> {
    if (!space) return;
    if (!entered) enterSpace(false);
    likedViewOpen = true;
    await loadLikedTiles();
  }

  function onLikedWheel(event: WheelEvent): void {
    if (!entered || !space) return;
    event.preventDefault();
    event.stopPropagation();
    space.scrollTiles(event.deltaY);
  }
  window.addEventListener('wheel', onLikedWheel, { passive: false, capture: true });

  function exitLikedView(): void {
    if (!likedViewOpen) return;
    likedViewOpen = false;
    void loadLikedTiles();
  }

  /* 顶部搜索：输入关键词 → 在线搜索 → 结果直接铺成磁贴墙 */
  let searchBusy = false;
  function openSearch(): void {
    searchOverlay.hidden = false;
    window.requestAnimationFrame(() => {
      searchOverlay.classList.add('is-open');
      searchInput.focus();
    });
  }

  function closeSearch(): void {
    searchOverlay.classList.remove('is-open');
    window.setTimeout(() => {
      searchOverlay.hidden = true;
    }, 180);
  }

  async function runSearch(): Promise<void> {
    const keyword = searchInput.value.trim();
    if (!keyword || searchBusy) return;
    searchBusy = true;
    searchHintEl.textContent = '搜索中…';
    try {
      const result = await searchOnline('netease', keyword, 30);
      const tracks = result.tracks ?? [];
      if (tracks.length === 0) {
        searchHintEl.textContent = '没有结果，换个关键词试试';
        return;
      }
      if (!entered) enterSpace(false);
      space?.setTilesVisible(true);
      space?.setTiles(tracks.map((track) => ({ title: track.title, artist: track.artist, cover: track.cover })));
      setStatus(`搜索「${keyword}」· ${tracks.length} 首 · 拖动旋转视角 / 滚轮滚动`);
      closeSearch();
    } catch (error) {
      searchHintEl.textContent = error instanceof Error ? error.message : '搜索失败，稍后重试';
    } finally {
      searchBusy = false;
    }
  }

  topSearchBtn.addEventListener('click', () => openSearch());
  searchGoBtn.addEventListener('click', () => void runSearch());
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runSearch();
    }
  });
  searchOverlay.addEventListener('click', (event) => {
    if (event.target === searchOverlay) closeSearch();
  });"""

rep(old_liked, new_liked)

# 7) rail search → 打开搜索浮层
rep(
    """      if (feature === 'liked') {
        void toggleLikedView();
        return;
      }
      const label = feature === 'library' ? '歌单' : feature === 'search' ? '搜索' : '设置';
      setStatus(`${label}功能即将开放`);""",
    """      if (feature === 'liked') {
        void toggleLikedView();
        return;
      }
      if (feature === 'search') {
        openSearch();
        return;
      }
      const label = feature === 'library' ? '歌单' : '设置';
      setStatus(`${label}功能即将开放`);""",
)

# 8) createFloatScene：磁贴点击提示 + 进入后不再依赖功能卡
rep(
    "  space = createFloatScene(canvas, {\n    onFeature: (id) => {",
    """  space = createFloatScene(canvas, {
    onTileClick: (index) => {
      const globalIndex = index;
      showToast(globalIndex >= 0 ? '播放功能即将开放' : '这首暂时无法播放', 'info');
    },
    onFeature: (id) => {""",
)

# 9) QA：?panel=search 打开搜索
rep(
    """  // QA：?panel=custom 直接打开自定义外观面板""",
    """  // QA：?panel=search 直接打开搜索浮层
  if (params.get('panel') === 'search') {
    window.setTimeout(() => {
      if (!disposed) openSearch();
    }, 600);
  }
  // QA：?panel=custom 直接打开自定义外观面板""",
)

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell tiles patch ok')
