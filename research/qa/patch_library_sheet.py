# -*- coding: utf-8 -*-
"""歌单功能：左侧「歌单」按钮弹出歌单面板（网易云 + QQ 音乐），点歌单把磁贴墙切到该歌单。

改动：
1. 模板新增 `.library-sheet`（从左侧按钮位置弹出、放大动画）。
2. 元素引用 + 状态（librarySource / libraryOverviewCache / libraryLoading / libraryOpen）。
3. 磁贴墙数据源从「固定 liked」泛化为「当前歌单」：likedPlaylistId / likedTitle / likedSpecial。
4. 歌单面板逻辑：定位、开合、来源 tab、列表渲染、点击歌单 → loadPlaylistIntoWall。
5. rail 歌单按钮绑定、Esc 关闭、QA ?panel=library。
"""
import io

P = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(P, "r", encoding="utf-8", newline="").read()


def patch(old, new, count=1, label=""):
    global s
    assert s.count(old) == count, f"anchor miss {label or old[:60]!r} count={s.count(old)}"
    s = s.replace(old, new, count)


# ---------- 1. 模板 ----------
anchor = '    <div class="settings-sheet" data-settings-sheet hidden>'
library_markup = """    <div class="library-sheet" data-library-sheet hidden>
      <div class="library-sheet-backdrop" data-library-close></div>
      <div class="library-sheet-card" role="dialog" aria-modal="true" aria-label="我的歌单">
        <header class="library-sheet-head">
          <div>
            <h2>我的歌单</h2>
            <p>网易云与 QQ 音乐的歌单都在这里</p>
          </div>
          <button class="library-sheet-close" data-library-close type="button" aria-label="关闭">${WIN_CLOSE}</button>
        </header>
        <div class="library-sheet-tabs" data-library-tabs>
          <button class="lib-tab is-on" data-library-source="netease" type="button">网易云</button>
          <button class="lib-tab" data-library-source="qq" type="button">QQ 音乐</button>
        </div>
        <div class="library-sheet-list" data-library-list>
          <p class="library-sheet-empty">正在读取歌单…</p>
        </div>
        <p class="library-sheet-foot" data-library-foot>点一个歌单，磁贴墙就会换成它的歌曲</p>
      </div>
    </div>
"""
patch(anchor, library_markup + anchor, label="library markup")

# ---------- 2. 元素引用 ----------
patch(
    "  const accountList = root.querySelector<HTMLElement>('[data-account-list]')!;",
    """  const accountList = root.querySelector<HTMLElement>('[data-account-list]')!;
  const librarySheet = root.querySelector<HTMLElement>('[data-library-sheet]')!;
  const libraryCardEl = root.querySelector<HTMLElement>('.library-sheet-card')!;
  const libraryList = root.querySelector<HTMLElement>('[data-library-list]')!;
  const libraryFoot = root.querySelector<HTMLElement>('[data-library-foot]')!;
  const libraryTabBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-library-source]'));""",
    label="refs",
)

# ---------- 3. 导入类型 ----------
patch(
    "import { fetchLibraryOverview, fetchPlaylist, libraryReady, type MusicSource } from '../library';",
    "import {\n  fetchLibraryOverview,\n  fetchPlaylist,\n  libraryReady,\n  type LibraryPlaylist,\n  type LibrarySourceState,\n  type MusicSource,\n} from '../library';",
    label="imports",
)

# ---------- 4. 墙数据源泛化 ----------
patch(
    "  let likedSource: MusicSource = 'netease';\n  let likedPage = 1;",
    """  let likedSource: MusicSource = 'netease';
  // 当前磁贴墙对应的歌单：'liked' = 我喜欢的音乐，其他为平台歌单 id
  let likedPlaylistId = 'liked';
  let likedTitle = '我喜欢的音乐';
  let likedSpecial: 'liked' | null = 'liked';
  let likedPage = 1;""",
    label="wall source vars",
)

patch(
    "        const detail = await fetchPlaylist(source, 'liked', offset, LIKED_CHUNK_SIZE, 'liked');",
    "        const detail = await fetchPlaylist(\n          source,\n          likedPlaylistId,\n          offset,\n          LIKED_CHUNK_SIZE,\n          likedSpecial,\n        );",
    label="fetch playlist id",
)

patch(
    "    return `${label} · 我喜欢的音乐${countText}${loadedText} · 第 ${likedPage}/${likedPageCount()} 页 · 拖动旋转 / 滚轮缩放 / 翻页箭头`;",
    "    return `${label} · ${likedTitle}${countText}${loadedText} · 第 ${likedPage}/${likedPageCount()} 页 · 拖动旋转 / 滚轮缩放 / 翻页箭头`;",
    label="status text",
)

patch(
    "        setStatus(`${likedLabel(source)} · 我喜欢的音乐 · 正在加载第 ${target}/${likedPageCount()} 页…`);",
    "        setStatus(`${likedLabel(source)} · ${likedTitle} · 正在加载第 ${target}/${likedPageCount()} 页…`);",
    label="loading text",
)

patch(
    "    setStatus(`${likedLabel(likedSource)} · 我喜欢的音乐 · 正在读取…`);",
    "    setStatus(`${likedLabel(likedSource)} · ${likedTitle} · 正在读取…`);",
    label="read text",
)

# ---------- 5. 歌单面板逻辑（放在 exitLikedView 之后） ----------
anchor_logic = """  function exitLikedView(): void {
    if (!likedViewOpen) return;
    likedViewOpen = false;
    void loadLikedTiles();
  }
"""
assert s.count(anchor_logic) == 1, "exitLikedView anchor"
library_logic = anchor_logic + r"""
  /* 左侧「歌单」：从按钮旁弹出歌单面板（网易云 / QQ 音乐），点歌单把磁贴墙切过去 */
  let librarySource: MusicSource = 'netease';
  let libraryOverviewCache: { sources: LibrarySourceState[] } | null = null;
  let libraryLoading = false;

  function libraryState(): LibrarySourceState | null {
    return libraryOverviewCache?.sources.find((entry) => entry.source === librarySource) ?? null;
  }

  function librarySourceLabel(source: MusicSource): string {
    return source === 'netease' ? '网易云' : 'QQ 音乐';
  }

  function positionLibrarySheet(): void {
    const railBtn = root.querySelector<HTMLButtonElement>('[data-rail="library"]');
    if (!railBtn) return;
    const rect = railBtn.getBoundingClientRect();
    const width = Math.min(408, window.innerWidth - 120);
    const height = Math.min(560, window.innerHeight - 96);
    const top = Math.max(20, Math.min(window.innerHeight - height - 20, rect.top - 56));
    const left = Math.max(84, rect.right + 16);
    libraryCardEl.style.width = `${width}px`;
    libraryCardEl.style.maxHeight = `${height}px`;
    libraryCardEl.style.top = `${top}px`;
    libraryCardEl.style.left = `${left}px`;
  }

  function renderLibraryRow(playlist: LibraryPlaylist): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'library-row';
    const cover = document.createElement('img');
    cover.alt = '';
    cover.loading = 'lazy';
    if (playlist.cover) cover.src = playlist.cover;
    cover.addEventListener('error', () => {
      cover.removeAttribute('src');
      cover.classList.add('is-empty');
    });
    const meta = document.createElement('span');
    meta.className = 'library-row-meta';
    const title = document.createElement('strong');
    title.textContent = playlist.title || '未命名歌单';
    const sub = document.createElement('span');
    sub.textContent =
      playlist.special === 'liked'
        ? `我喜欢的音乐 · ${playlist.count} 首`
        : `${playlist.count} 首${playlist.creator ? ` · ${playlist.creator}` : ''}`;
    meta.append(title, sub);
    const arrow = document.createElement('span');
    arrow.className = 'library-row-arrow';
    arrow.textContent = '›';
    row.append(cover, meta, arrow);
    row.addEventListener('click', () => {
      void openPlaylistIntoWall(playlist);
    });
    return row;
  }

  function renderLibraryList(): void {
    libraryList.replaceChildren();
    const state = libraryState();
    if (libraryLoading && !state) {
      libraryList.innerHTML = '<p class="library-sheet-empty">正在读取歌单…</p>';
      return;
    }
    if (!state) {
      libraryList.innerHTML = '<p class="library-sheet-empty">歌单读取失败，点一下重试</p>';
      return;
    }
    if (!state.loggedIn) {
      const empty = document.createElement('div');
      empty.className = 'library-sheet-empty';
      empty.textContent = `${librarySourceLabel(librarySource)}还没有登录，登录后歌单才会同步过来`;
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'library-login-btn';
      go.textContent = '去登录';
      go.addEventListener('click', () => {
        closeLibrarySheet();
        openAccountSheet();
      });
      empty.append(go);
      libraryList.append(empty);
      return;
    }
    const playlists: LibraryPlaylist[] = [];
    if (state.liked) playlists.push(state.liked);
    for (const playlist of state.playlists) {
      if (playlist.id === state.liked?.id && playlist.special === 'liked') continue;
      playlists.push(playlist);
    }
    if (playlists.length === 0) {
      libraryList.innerHTML = '<p class="library-sheet-empty">这个平台还没有歌单</p>';
      return;
    }
    playlists.forEach((playlist) => {
      libraryList.append(renderLibraryRow(playlist));
    });
    if (state.error) {
      libraryFoot.textContent = `${librarySourceLabel(librarySource)}：${state.error}`;
    } else {
      libraryFoot.textContent = '点一个歌单，磁贴墙就会换成它的歌曲';
    }
  }

  async function ensureLibraryData(): Promise<void> {
    if (libraryLoading) return;
    if (libraryOverviewCache) {
      renderLibraryList();
      return;
    }
    libraryLoading = true;
    renderLibraryList();
    try {
      libraryOverviewCache = await fetchLibraryOverview();
    } catch (error) {
      console.warn('[library] 歌单面板读取失败', error);
      libraryOverviewCache = null;
    } finally {
      libraryLoading = false;
      if (!librarySheet.hidden) renderLibraryList();
    }
  }

  function openLibrarySheet(): void {
    librarySheet.hidden = false;
    libraryCardEl.classList.remove('is-open');
    positionLibrarySheet();
    window.requestAnimationFrame(() => {
      if (!librarySheet.hidden) libraryCardEl.classList.add('is-open');
    });
    root.querySelectorAll<HTMLElement>('[data-rail="library"]').forEach((button) => {
      button.classList.add('is-on');
    });
    void ensureLibraryData();
  }

  function closeLibrarySheet(): void {
    if (librarySheet.hidden) return;
    libraryCardEl.classList.remove('is-open');
    librarySheet.hidden = true;
    root.querySelectorAll<HTMLElement>('[data-rail="library"]').forEach((button) => {
      button.classList.remove('is-on');
    });
  }

  function toggleLibrarySheet(): void {
    if (librarySheet.hidden) openLibrarySheet();
    else closeLibrarySheet();
  }

  async function openPlaylistIntoWall(playlist: LibraryPlaylist): Promise<void> {
    if (!space) return;
    closeLibrarySheet();
    likedSource = playlist.source;
    markLikedSource(playlist.source);
    likedSpecial = playlist.special === 'liked' || playlist.id === 'liked' ? 'liked' : null;
    likedPlaylistId = likedSpecial === 'liked' ? 'liked' : playlist.id;
    likedTitle = playlist.title || '歌单';
    likedViewOpen = true;
    if (!entered) enterSpace(false);
    await loadLikedTiles();
  }

  libraryTabBtns.forEach((button) => {
    button.addEventListener('click', () => {
      librarySource = button.dataset.librarySource === 'qq' ? 'qq' : 'netease';
      libraryTabBtns.forEach((entry) => entry.classList.toggle('is-on', entry === button));
      renderLibraryList();
      if (!libraryOverviewCache) void ensureLibraryData();
    });
  });
  root.querySelectorAll<HTMLElement>('[data-library-close]').forEach((entry) => {
    entry.addEventListener('click', () => closeLibrarySheet());
  });
  window.addEventListener('resize', () => {
    if (!librarySheet.hidden) positionLibrarySheet();
  });
"""
s = s.replace(anchor_logic, library_logic, 1)

# ---------- 6. rail 绑定 ----------
patch(
    """      if (feature === 'settings') {
        openSettingsSheet();
        return;
      }
      setStatus('歌单功能即将开放');""",
    """      if (feature === 'settings') {
        openSettingsSheet();
        return;
      }
      if (feature === 'library') {
        toggleLibrarySheet();
        return;
      }
      setStatus('功能即将开放');""",
    label="rail binding",
)

# ---------- 7. 切回「我喜欢」时重置歌单来源 ----------
patch(
    """  async function switchLikedSource(source: MusicSource): Promise<void> {
    if (!space) return;
    likedSource = source;""",
    """  async function switchLikedSource(source: MusicSource): Promise<void> {
    if (!space) return;
    likedSource = source;
    likedPlaylistId = 'liked';
    likedTitle = '我喜欢的音乐';
    likedSpecial = 'liked';""",
    label="switch liked resets playlist",
)

patch(
    """    if (!entered) enterSpace(false);
    likedViewOpen = true;
    await loadLikedTiles();
  }

  function exitLikedView(): void {""",
    """    if (!entered) enterSpace(false);
    likedViewOpen = true;
    likedPlaylistId = 'liked';
    likedTitle = '我喜欢的音乐';
    likedSpecial = 'liked';
    await loadLikedTiles();
  }

  function exitLikedView(): void {""",
    label="toggle liked resets playlist",
)

# ---------- 8. Esc 关闭 ----------
patch(
    """    if (event.key === 'Escape' && !accountSheet.hidden) {
      event.preventDefault();
      closeAccountSheet();
      return;
    }""",
    """    if (event.key === 'Escape' && !accountSheet.hidden) {
      event.preventDefault();
      closeAccountSheet();
      return;
    }
    if (event.key === 'Escape' && !librarySheet.hidden) {
      event.preventDefault();
      closeLibrarySheet();
      return;
    }""",
    label="esc close",
)

# ---------- 9. QA panel=library ----------
patch(
    """  // QA：?panel=custom 直接打开自定义外观面板""",
    """  // QA：?panel=library 直接打开歌单面板
  if (params.get('panel') === 'library') {
    window.setTimeout(() => {
      if (!disposed) openLibrarySheet();
    }, 700);
  }

  // QA：?panel=custom 直接打开自定义外观面板""",
    label="qa panel",
)

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("library sheet patched")
