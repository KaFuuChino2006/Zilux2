# -*- coding: utf-8 -*-
"""spaceShell：顶部搜索改为就地展开的搜索栏（不弹中间浮层）。"""
import io

P = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s = io.open(P, 'r', encoding='utf-8', newline='').read()


def rep(old, new, count=1):
    global s
    assert s.count(old) >= count, 'MISSING ANCHOR: ' + old[:80].replace('\n', ' | ')
    s = s.replace(old, new, count)


# 1) 模板：搜索按钮 + 就地展开输入
rep(
    """    <div class="space-topbar">
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
    </div>""",
    """    <div class="space-topbar">
      <div class="space-searchbar" data-searchbar>
        <button class="space-topsearch" data-topsearch type="button" aria-label="搜索">${icon('search', 16)}<span>搜索</span></button>
        <input class="space-search-input" data-search-input type="search" placeholder="搜索歌曲 / 歌手 / 专辑（网易云）" autocomplete="off" hidden />
        <button class="space-search-go" data-search-go type="button" hidden>搜索</button>
        <button class="space-search-cancel" data-search-cancel type="button" aria-label="收起" hidden>×</button>
      </div>
    </div>""",
)

# 2) 元素引用
rep(
    """  const topSearchBtn = root.querySelector<HTMLButtonElement>('[data-topsearch]')!;
  const searchOverlay = root.querySelector<HTMLElement>('[data-space-search]')!;
  const searchInput = root.querySelector<HTMLInputElement>('[data-search-input]')!;
  const searchGoBtn = root.querySelector<HTMLButtonElement>('[data-search-go]')!;
  const searchHintEl = root.querySelector<HTMLElement>('[data-search-hint]')!;""",
    """  const searchBar = root.querySelector<HTMLElement>('[data-searchbar]')!;
  const topSearchBtn = root.querySelector<HTMLButtonElement>('[data-topsearch]')!;
  const searchInput = root.querySelector<HTMLInputElement>('[data-search-input]')!;
  const searchGoBtn = root.querySelector<HTMLButtonElement>('[data-search-go]')!;
  const searchCancelBtn = root.querySelector<HTMLButtonElement>('[data-search-cancel]')!;""",
)

# 3) openSearch / closeSearch / runSearch
rep(
    """  /* 顶部搜索：输入关键词 → 在线搜索 → 结果直接铺成磁贴墙 */
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
      tileTracks = tracks;
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
  });""",
    """  /* 顶部搜索：点击按钮就在顶部展开成搜索栏，输入回车搜索，结果铺成磁贴墙 */
  let searchBusy = false;
  let searchOpen = false;
  function openSearch(): void {
    searchOpen = true;
    searchBar.classList.add('is-open');
    topSearchBtn.hidden = true;
    searchInput.hidden = false;
    searchGoBtn.hidden = false;
    searchCancelBtn.hidden = false;
    window.requestAnimationFrame(() => searchInput.focus());
  }

  function closeSearch(): void {
    if (!searchOpen) return;
    searchOpen = false;
    searchBar.classList.remove('is-open');
    topSearchBtn.hidden = false;
    searchInput.hidden = true;
    searchGoBtn.hidden = true;
    searchCancelBtn.hidden = true;
    searchInput.value = '';
  }

  async function runSearch(): Promise<void> {
    const keyword = searchInput.value.trim();
    if (!keyword || searchBusy) return;
    searchBusy = true;
    setStatus('搜索中…');
    try {
      const result = await searchOnline('netease', keyword, 30);
      const tracks = result.tracks ?? [];
      if (tracks.length === 0) {
        showToast('没有结果，换个关键词试试', 'warn');
        return;
      }
      if (!entered) enterSpace(false);
      tileTracks = tracks;
      space?.setTilesVisible(true);
      space?.setTiles(tracks.map((track) => ({ title: track.title, artist: track.artist, cover: track.cover })));
      setStatus(`搜索「${keyword}」· ${tracks.length} 首 · 拖动旋转视角 / 滚轮滚动`);
      closeSearch();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '搜索失败，稍后重试', 'error');
    } finally {
      searchBusy = false;
    }
  }

  topSearchBtn.addEventListener('click', () => openSearch());
  searchGoBtn.addEventListener('click', () => void runSearch());
  searchCancelBtn.addEventListener('click', () => closeSearch());
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runSearch();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
    }
  });""",
)

# 4) Esc 优先收起搜索栏
rep(
    """  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !customSheet.hidden) {""",
    """  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && searchOpen) {
      event.preventDefault();
      closeSearch();
      return;
    }
    if (event.key === 'Escape' && !customSheet.hidden) {""",
)

io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('spaceShell inline search patch ok')
