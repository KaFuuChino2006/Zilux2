# -*- coding: utf-8 -*-
"""搜索：胶囊横向展开放控件 + 下方常规结果面板。"""
import io

SHELL = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
CSS = r"E:\Zilux2开发\web\src\styles\space.css"


def replace_once(text, old, new, label):
    assert text.count(old) == 1, (label, text.count(old))
    return text.replace(old, new, 1)


s = io.open(SHELL, "r", encoding="utf-8", newline="").read()

# 1) 模板：控件回到胶囊内；下方改为结果面板
old_tpl = '''      <div class="space-searchbar" data-searchbar>
        <button class="space-topsearch" data-topsearch type="button" aria-label="搜索">${icon('search', 16)}<span>搜索</span></button>
      </div>
      <div class="space-search-drop" data-search-drop hidden>
        <div class="space-search-row">
          <div class="space-search-src" data-search-src>
            <button class="space-src-btn is-on" data-search-source="netease" type="button">网易</button>
            <button class="space-src-btn" data-search-source="qq" type="button">QQ</button>
          </div>
          <input class="space-search-input" data-search-input type="search" placeholder="搜索歌曲 / 歌手 / 专辑" autocomplete="off" />
        </div>
        <div class="space-search-actions">
          <button class="space-search-go" data-search-go type="button">搜索</button>
          <button class="space-search-cancel" data-search-cancel type="button">取消</button>
        </div>
      </div>'''
new_tpl = '''      <div class="space-searchbar" data-searchbar>
        <button class="space-topsearch" data-topsearch type="button" aria-label="搜索">${icon('search', 16)}<span>搜索</span></button>
        <div class="space-search-src" data-search-src>
          <button class="space-src-btn is-on" data-search-source="netease" type="button">网易</button>
          <button class="space-src-btn" data-search-source="qq" type="button">QQ</button>
        </div>
        <input class="space-search-input" data-search-input type="search" placeholder="搜索歌曲 / 歌手 / 专辑" autocomplete="off" />
        <button class="space-search-go" data-search-go type="button">搜索</button>
        <button class="space-search-cancel" data-search-cancel type="button" aria-label="收起">×</button>
      </div>
      <div class="space-search-drop" data-search-drop hidden>
        <div class="space-search-results" data-search-results></div>
      </div>'''
s = replace_once(s, old_tpl, new_tpl, "template")

# 2) refs：增加 results 容器
old_ref = "  const searchDrop = root.querySelector<HTMLElement>('[data-search-drop]')!;"
new_ref = "  const searchDrop = root.querySelector<HTMLElement>('[data-search-drop]')!;\n  const searchResults = root.querySelector<HTMLElement>('[data-search-results]')!;"
s = replace_once(s, old_ref, new_ref, "refs")

# 3) open/close
old_open = '''  function openSearch(): void {
    searchOpen = true;
    searchBar.classList.add('is-open');
    searchDrop.hidden = false;
    window.requestAnimationFrame(() => {
      searchDrop.classList.add('is-on');
      searchInput.focus();
    });
  }'''
new_open = '''  function openSearch(): void {
    searchOpen = true;
    searchBar.classList.add('is-open');
    window.requestAnimationFrame(() => searchInput.focus());
  }

  function renderSearchResults(tracks: OnlineTrack[], keyword: string): void {
    searchResults.replaceChildren();
    tracks.forEach((track) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'search-result';
      const cover = document.createElement('img');
      cover.alt = '';
      cover.loading = 'lazy';
      if (track.cover) cover.src = track.cover;
      const meta = document.createElement('span');
      meta.className = 'search-result-meta';
      const title = document.createElement('span');
      title.className = 'search-result-title';
      title.textContent = track.title;
      const artist = document.createElement('span');
      artist.className = 'search-result-artist';
      artist.textContent = track.artist || '未知艺人';
      meta.append(title, artist);
      const tail = document.createElement('span');
      tail.className = 'search-result-tail';
      tail.textContent = track.duration ? formatDuration(track.duration) : '';
      row.append(cover, meta, tail);
      row.addEventListener('click', () => {
        void island.play(track, tracks);
        showToast(`正在播放《${track.title}》`, 'ok');
      });
      searchResults.appendChild(row);
    });
    const head = document.createElement('p');
    head.className = 'search-result-hint';
    head.textContent = `${searchSource === 'qq' ? 'QQ 音乐' : '网易云音乐'} · 「${keyword}」· ${tracks.length} 首`;
    searchResults.prepend(head);
    searchDrop.hidden = false;
    window.requestAnimationFrame(() => searchDrop.classList.add('is-on'));
  }'''
s = replace_once(s, old_open, new_open, "open+render")

old_close = '''  function closeSearch(): void {
    if (!searchOpen) return;
    searchOpen = false;
    searchBar.classList.remove('is-open');
    searchDrop.classList.remove('is-on');
    searchDrop.hidden = true;
    searchInput.value = '';
  }'''
new_close = '''  function closeSearch(): void {
    if (!searchOpen) return;
    searchOpen = false;
    searchBar.classList.remove('is-open');
    searchDrop.classList.remove('is-on');
    searchDrop.hidden = true;
    searchResults.replaceChildren();
    searchInput.value = '';
  }'''
s = replace_once(s, old_close, new_close, "close")

# 4) runSearch：结果进面板，不再替换磁贴墙
old_run = '''      if (!entered) enterSpace(false);
      tileTracks = tracks;
      space?.setTilesVisible(true);
      space?.setTiles(tracks.map((track) => ({ title: track.title, artist: track.artist, cover: track.cover })));
      const srcLabel = searchSource === 'qq' ? 'QQ 音乐' : '网易云音乐';
      setStatus(`${srcLabel} 搜索「${keyword}」· ${tracks.length} 首 · 拖动旋转视角 / 滚轮滚动`);
      closeSearch();'''
new_run = '''      renderSearchResults(tracks, keyword);'''
s = replace_once(s, old_run, new_run, "run")

# 5) 点击面板外收起
old_bind = "  topSearchBtn.addEventListener('click', () => {\n    if (searchOpen) closeSearch();\n    else openSearch();\n  });"
new_bind = '''  topSearchBtn.addEventListener('click', () => {
    if (searchOpen) closeSearch();
    else openSearch();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!searchOpen) return;
    const target = event.target as Node | null;
    if (target && (searchBar.contains(target) || searchDrop.contains(target))) return;
    closeSearch();
  });'''
s = replace_once(s, old_bind, new_bind, "outside-close")

io.open(SHELL, "w", encoding="utf-8", newline="").write(s)
print("search pill+results wired")

c = io.open(CSS, "r", encoding="utf-8", newline="").read()
c += """

/* 搜索：胶囊横向展开（控件只在展开时显示） */
.space-searchbar {
  width: 138px;
  justify-content: flex-start;
  overflow: hidden;
  transition: width 0.3s cubic-bezier(0.22, 0.8, 0.28, 1), background 0.18s ease,
    box-shadow 0.18s ease;
}

.space-searchbar.is-open {
  width: min(720px, calc(100vw - 260px));
}

.space-searchbar:not(.is-open) .space-search-src,
.space-searchbar:not(.is-open) .space-search-input,
.space-searchbar:not(.is-open) .space-search-go,
.space-searchbar:not(.is-open) .space-search-cancel {
  display: none;
}

.space-searchbar .space-search-input {
  width: 100%;
  min-width: 0;
  flex: 1;
  height: 38px;
  border: 0;
  background: transparent;
  padding: 0 6px;
  font-size: 14px;
  color: #171a21;
  outline: none;
}

/* 搜索结果：按钮下方常规下拉面板 */
.space-search-drop {
  position: absolute;
  top: 58px;
  left: 50%;
  width: min(640px, calc(100vw - 160px));
  max-height: min(440px, 56vh);
  overflow-y: auto;
  padding: 8px;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(24px) saturate(150%);
  box-shadow: 0 18px 48px rgba(23, 26, 33, 0.16);
  opacity: 0;
  transform: translate(-50%, -8px);
  transition: opacity 0.2s ease, transform 0.22s cubic-bezier(0.22, 0.8, 0.28, 1);
  z-index: 8;
}

.space-search-drop.is-on {
  opacity: 1;
  transform: translate(-50%, 0);
}

.space-search-drop[hidden] {
  display: none;
}

.search-result-hint {
  margin: 4px 8px 6px;
  font-size: 12px;
  color: #8a90a0;
}

.search-result {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease;
}

.search-result:hover {
  background: rgba(106, 92, 255, 0.08);
}

.search-result img {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  object-fit: cover;
  flex: none;
  background: rgba(23, 26, 33, 0.06);
}

.search-result-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.search-result-title {
  font-size: 13.5px;
  font-weight: 500;
  color: #171a21;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-result-artist {
  font-size: 12px;
  color: #8a90a0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-result-tail {
  font-size: 12px;
  color: #8a90a0;
  flex: none;
}
"""
io.open(CSS, "w", encoding="utf-8", newline="").write(c)
print("css appended (pill expand + results list)")
