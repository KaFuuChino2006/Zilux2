# -*- coding: utf-8 -*-
"""搜索药丸：未点击只显示小药丸，点击横向展开（回弹），边打边搜前 10 首，Enter/查看全部 → 渐变过渡到普通墙面列表。
   支持多平台融合搜索 / 单平台搜索，结果带平台角标。"""
import io

APP = r"E:\Zilux2开发\web\src\ui\app.ts"
CSS = r"E:\Zilux2开发\web\src\styles\app.css"


def load(path):
    with io.open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def save(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def apply(path, label, edits):
    text = load(path)
    E = "\r\n" if "\r\n" in text else "\n"
    for old, new in edits:
        o, n = old.replace("\n", E), new.replace("\n", E)
        assert text.count(o) == 1, f"{label}: {old.splitlines()[0][:60]} -> {text.count(o)}"
        text = text.replace(o, n)
    save(path, text)
    print(label, "OK")


# ---------------------------------------------------------------- app.ts
apply(
    APP,
    "app.ts 字段",
    [
        (
            "  private searchInput!: HTMLInputElement;",
            "  private searchInput!: HTMLInputElement;\n"
            "  private searchDock!: HTMLDivElement;\n"
            "  private searchPop!: HTMLDivElement;\n"
            "  private searchTabs!: HTMLDivElement;\n"
            "  private searchList!: HTMLDivElement;\n"
            "  private searchNote!: HTMLDivElement;\n"
            "  private searchDockOpen = false;\n"
            "  private searchSource: OnlineSource | 'all' = 'all';\n"
            "  private searchSeq = 0;\n"
            "  private searchTimer = 0;\n"
            "  private searchKeyword = '';",
        ),
    ],
)

apply(
    APP,
    "app.ts 顶栏搜索",
    [
        (
            """    this.searchInput = h('input', { type: 'text', placeholder: '搜索歌曲、歌手' });
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.openSearch(this.searchInput.value);
    });
    const searchPill = h(
      'button',
      { class: 'pill search-pill', title: '搜索（Enter）' },
      icon('search', 17),
      this.searchInput,
    );
    searchPill.addEventListener('click', () => {
      this.openSearch(this.searchInput.value);
    });""",
            """    this.searchInput = h('input', {
      class: 'search-dock-input',
      type: 'text',
      placeholder: '搜索歌曲、歌手（边打边搜）',
      spellcheck: 'false',
      autocomplete: 'off',
    });
    this.searchInput.addEventListener('input', () => this.scheduleSearchPreview());
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void this.commitSearch();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeSearchDock();
      }
    });

    this.searchDock = h('div', { class: 'search-dock', 'data-open': 'false' });
    const dockIcon = h('span', { class: 'search-dock-icon' }, icon('search', 17));
    const dockHint = h('span', { class: 'search-dock-hint', text: '搜索' });
    const dockClear = h('button', { class: 'search-dock-close', title: '收起搜索' }, icon('close', 14));
    this.searchDock.append(dockIcon, dockHint, this.searchInput, dockClear);

    this.searchTabs = h('div', { class: 'search-tabs' });
    this.searchList = h('div', { class: 'search-list' });
    this.searchNote = h('div', { class: 'search-note', text: '输入关键词，边打边搜' });
    const searchAllBtn = h('button', { class: 'pill search-all', title: '查看全部结果（Enter）' }, icon('search', 15), h('span', { text: '查看全部' }));
    this.searchPop = h(
      'div',
      { class: 'search-pop' },
      this.searchTabs,
      this.searchList,
      h('div', { class: 'search-foot' }, this.searchNote, searchAllBtn),
    );
    searchAllBtn.addEventListener('click', () => void this.commitSearch());
    const searchWrap = h('div', { class: 'search-wrap' }, this.searchDock, this.searchPop);
    this.searchDock.addEventListener('click', () => this.openSearchDock());
    dockClear.addEventListener('click', (event) => {
      event.stopPropagation();
      this.searchInput.value = '';
      this.closeSearchDock();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!this.searchDockOpen) return;
      const target = event.target;
      if (target instanceof Node && searchWrap.contains(target)) return;
      this.closeSearchDock();
    });""",
        ),
        (
            "      h('div', { class: 'topbar-center' }, searchPill, discoverPill),",
            "      h('div', { class: 'topbar-center' }, searchWrap, discoverPill),",
        ),
    ],
)

apply(
    APP,
    "app.ts trackRow",
    [
        (
            """  private trackRow(track: OnlineTrack, queue: OnlineTrack[], index: number): HTMLDivElement {
    const cover = onlineArtwork(track);
    const row = h(
      'div',
      { class: 'row', title: `${track.title} — ${track.artist}` },
      h('div', { class: 'row-cover' }, h('img', { src: cover, loading: 'lazy' })),
      h(
        'div',
        { class: 'row-meta' },
        h('div', { class: 'row-name', text: track.title }),
        h('div', { class: 'row-artist', text: track.artist || '未知歌手' }),
      ),
      h('div', { class: 'row-dur', text: fmtTime(track.durationMs) }),
    );
    row.addEventListener('click', () => {
      playQueue(queue, index, true);
      this.sheet?.close();
    });
    return row;
  }""",
            """  private trackRow(
    track: OnlineTrack,
    queue: OnlineTrack[],
    index: number,
    options?: { badge?: boolean; onPlay?: () => void },
  ): HTMLDivElement {
    const cover = onlineArtwork(track);
    const row = h(
      'div',
      { class: 'row', title: `${track.title} — ${track.artist}` },
      h('div', { class: 'row-cover' }, h('img', { src: cover, loading: 'lazy' })),
      h(
        'div',
        { class: 'row-meta' },
        h('div', { class: 'row-name', text: track.title }),
        h('div', { class: 'row-artist', text: track.artist || '未知歌手' }),
      ),
      options?.badge ? this.sourceTag(track.source) : null,
      h('div', { class: 'row-dur', text: fmtTime(track.durationMs) }),
    );
    row.addEventListener('click', () => {
      playQueue(queue, index, true);
      if (options?.onPlay) options.onPlay();
      else this.sheet?.close();
    });
    return row;
  }

  /** 平台角标（搜索/混合列表里标出来源）。 */
  private sourceTag(source: string): HTMLSpanElement {
    const meta = sourceMeta(source);
    return h('span', {
      class: 'source-tag',
      style: `--src-accent:${meta.accent}`,
      text: meta.short || meta.label,
    });
  }""",
        ),
    ],
)

apply(
    APP,
    "app.ts openSearch → 药丸搜索",
    [
        (
            """  private openSearch(query: string): void {
    this.openSheet('搜索', (body) => {
      const input = h('input', { class: 'search-input', type: 'text', placeholder: '歌曲 / 歌手', value: query });
      const account = getAccounts().find((item) => item.loggedIn);
      let source: OnlineSource = (account?.source as OnlineSource) ?? 'netease';
      const sourceBtns: HTMLButtonElement[] = [];
      const seg = h('div', { class: 'search-head' });
      (sourceIds() as OnlineSource[]).forEach((item) => {
        const btn = h('button', { class: `btn${item === source ? ' is-primary' : ''}`, text: SOURCE_LABEL[item] });
        btn.addEventListener('click', () => {
          source = item;
          sourceBtns.forEach((node) => node.classList.toggle('is-primary', node === btn));
          void run();
        });
        sourceBtns.push(btn);
        seg.append(btn);
      });
      const listHost = h('div', { class: 'list' });
      body.append(h('div', { class: 'search-head' }, input), seg, listHost);

      const run = async (): Promise<void> => {
        const keyword = input.value.trim();
        if (!keyword) return;
        listHost.textContent = '';
        listHost.append(h('div', { class: 'empty', text: '搜索中…' }));
        try {
          const result = await searchOnline(source, keyword, 30);
          listHost.textContent = '';
          if (result.tracks.length === 0) {
            listHost.append(h('div', { class: 'empty', text: '没有找到相关歌曲' }));
            return;
          }
          result.tracks.forEach((track, index) => listHost.append(this.trackRow(track, result.tracks, index)));
        } catch (err) {
          console.warn('[app] search failed', err);
          listHost.textContent = '';
          listHost.append(h('div', { class: 'empty', text: '搜索失败：请检查网络或登录状态' }));
        }
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void run();
      });
      window.setTimeout(() => input.focus(), 40);
      if (query.trim()) void run();
    });
  }""",
            """  /* ------------------------ 搜索：药丸展开 + 边打边搜 + 展开成墙 ------------------------ */

  private openSearchDock(): void {
    if (!this.searchDockOpen) {
      this.searchDockOpen = true;
      this.searchDock.dataset.open = 'true';
      this.searchPop.classList.add('is-open');
      this.renderSearchTabs();
      if (!this.searchInput.value.trim()) {
        this.searchList.textContent = '';
        this.searchNote.textContent = '输入关键词，边打边搜（前 10 首）';
      }
    }
    window.setTimeout(() => this.searchInput.focus(), 60);
  }

  private closeSearchDock(): void {
    this.searchDockOpen = false;
    this.searchDock.dataset.open = 'false';
    this.searchPop.classList.remove('is-open');
    this.searchInput.blur();
  }

  /** 平台分段：融合搜索 + 各平台单选。 */
  private renderSearchTabs(): void {
    this.searchTabs.textContent = '';
    const all = h('button', {
      class: `search-tab${this.searchSource === 'all' ? ' is-on' : ''}`,
      text: '融合搜索',
    });
    all.addEventListener('click', () => {
      this.searchSource = 'all';
      this.renderSearchTabs();
      void this.runSearchPreview();
    });
    this.searchTabs.append(all);
    sourceDescriptors().forEach((item) => {
      const tab = h('button', {
        class: `search-tab${this.searchSource === item.id ? ' is-on' : ''}`,
        style: `--src-accent:${item.accent}`,
        text: item.label,
      });
      tab.addEventListener('click', () => {
        this.searchSource = item.id as OnlineSource;
        this.renderSearchTabs();
        void this.runSearchPreview();
      });
      this.searchTabs.append(tab);
    });
  }

  private scheduleSearchPreview(): void {
    window.clearTimeout(this.searchTimer);
    const keyword = this.searchInput.value.trim();
    if (!keyword) {
      this.searchList.textContent = '';
      this.searchNote.textContent = '输入关键词，边打边搜（前 10 首）';
      return;
    }
    this.searchNote.textContent = '搜索中…';
    this.searchTimer = window.setTimeout(() => void this.runSearchPreview(), 220);
  }

  private searchTargets(): OnlineSource[] {
    return this.searchSource === 'all'
      ? (sourceIds() as OnlineSource[])
      : [this.searchSource as OnlineSource];
  }

  /** 融合搜索：各平台结果按轮次交错，保证优先级均衡。 */
  private mergeByPriority(lists: OnlineTrack[][]): OnlineTrack[] {
    const merged: OnlineTrack[] = [];
    let index = 0;
    while (lists.some((list) => index < list.length)) {
      lists.forEach((list) => {
        if (index < list.length) merged.push(list[index]);
      });
      index += 1;
    }
    return merged;
  }

  private async fetchSearch(keyword: string, perSource: number): Promise<OnlineTrack[]> {
    const targets = this.searchTargets();
    const lists = await Promise.all(
      targets.map(async (source) => {
        try {
          const result = await searchOnline(source, keyword, perSource);
          return result.tracks;
        } catch (err) {
          console.warn('[app] search failed', source, err);
          return [] as OnlineTrack[];
        }
      }),
    );
    return this.searchSource === 'all' ? this.mergeByPriority(lists) : (lists[0] ?? []);
  }

  /** 边打边搜：无需确认，按优先级展示前 10 首。 */
  private async runSearchPreview(): Promise<void> {
    const keyword = this.searchInput.value.trim();
    if (!keyword) return;
    const seq = ++this.searchSeq;
    this.searchKeyword = keyword;
    this.searchNote.textContent = '搜索中…';
    const merged = await this.fetchSearch(keyword, 10);
    if (seq !== this.searchSeq) return;
    const preview = merged.slice(0, 10);
    this.searchList.textContent = '';
    if (preview.length === 0) {
      this.searchNote.textContent = '没有找到相关歌曲';
      this.searchList.append(h('div', { class: 'search-empty', text: '换关键词试试，或切换平台' }));
      return;
    }
    this.searchNote.textContent = `按优先级展示前 ${preview.length} 首 · Enter 展开全部`;
    preview.forEach((track, index) => {
      this.searchList.append(
        this.trackRow(track, preview, index, {
          badge: true,
          onPlay: () => this.closeSearchDock(),
        }),
      );
    });
  }

  /** 确认（Enter / 查看全部）：渐变过渡成普通墙面列表。 */
  private async commitSearch(): Promise<void> {
    const keyword = this.searchInput.value.trim();
    if (!keyword) {
      toast('先输入要搜索的歌曲或歌手');
      return;
    }
    const seq = ++this.searchSeq;
    this.searchNote.textContent = `正在展开「${keyword}」的全部结果…`;
    const merged = await this.fetchSearch(keyword, 30);
    if (seq !== this.searchSeq) return;
    const label =
      this.searchSource === 'all' ? '融合搜索' : sourceMeta(this.searchSource as string).label;
    this.wall = {
      kind: 'search',
      title: `搜索「${keyword}」`,
      subtitle: `${label} · ${merged.length} 首`,
      tracks: merged,
    };
    this.closeSearchDock();
    this.setRailActive('search');
    this.renderWall();
    this.wallHost.classList.remove('is-swap');
    void this.wallHost.offsetWidth;
    this.wallHost.classList.add('is-swap');
    if (merged.length === 0) toast('没有找到相关歌曲');
  }""",
        ),
    ],
)

apply(
    APP,
    "app.ts 墙面角标 + 过渡",
    [
        (
            "        h('div', { class: 'poster-badge', text: String(index + 1).padStart(2, '0') }),",
            "        h('div', { class: 'poster-badge', text: String(index + 1).padStart(2, '0') }),\n"
            "        this.wall.kind === 'search'\n"
            "          ? h('div', {\n"
            "              class: 'poster-src',\n"
            "              style: `--src-accent:${sourceMeta(track.source).accent}`,\n"
            "              text: sourceMeta(track.source).short,\n"
            "            })\n"
            "          : null,",
        ),
    ],
)

apply(
    APP,
    "app.ts Esc / focusSearch",
    [
        (
            """  focusSearch(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }""",
            """  focusSearch(): void {
    this.openSearchDock();
    window.setTimeout(() => {
      this.searchInput.focus();
      this.searchInput.select();
    }, 90);
  }""",
        ),
        (
            """  escapeTopLayer(): void {
    if (this.upnextOpen) {""",
            """  escapeTopLayer(): void {
    if (this.searchDockOpen) {
      this.closeSearchDock();
      return;
    }
    if (this.upnextOpen) {""",
        ),
    ],
)

# ---------------------------------------------------------------- CSS
SEARCH_CSS = """
/* ------------------------------ 搜索药丸 + 结果弹层 ------------------------------ */
.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.search-dock {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  width: 118px;
  padding: 0 12px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--line);
  background: var(--surface);
  cursor: text;
  overflow: hidden;
  transition:
    width 0.46s cubic-bezier(0.22, 1.62, 0.36, 1),
    background 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.24s ease;
}

.search-dock:hover {
  border-color: var(--line-strong);
}

.search-dock[data-open='true'] {
  width: min(540px, 44vw);
  background: var(--surface-strong);
  border-color: var(--line-strong);
  box-shadow: var(--shadow);
}

.search-dock-icon {
  display: inline-flex;
  color: var(--muted);
  flex: none;
  transition: color 0.2s ease;
}

.search-dock[data-open='true'] .search-dock-icon {
  color: var(--accent);
}

.search-dock-hint {
  color: var(--muted);
  font-size: 13px;
  letter-spacing: 0.02em;
  white-space: nowrap;
  opacity: 1;
  transition: opacity 0.2s ease;
}

.search-dock[data-open='true'] .search-dock-hint {
  display: none;
}

.search-dock-input {
  flex: 1;
  min-width: 0;
  width: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 13.5px;
  outline: none;
  opacity: 0;
  transition:
    width 0.34s cubic-bezier(0.22, 1.5, 0.36, 1) 0.05s,
    opacity 0.2s ease 0.05s;
}

.search-dock[data-open='true'] .search-dock-input {
  width: 100%;
  opacity: 1;
}

.search-dock-input::placeholder {
  color: var(--muted);
}

.search-dock-close {
  display: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.search-dock-close:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.search-dock[data-open='true'] .search-dock-close {
  display: inline-flex;
}

.search-pop {
  position: absolute;
  top: calc(100% + 12px);
  left: 50%;
  width: min(620px, 52vw);
  padding: 12px;
  border-radius: 18px;
  border: 1px solid var(--line);
  background: var(--surface-strong);
  box-shadow: var(--shadow);
  z-index: 60;
  opacity: 0;
  pointer-events: none;
  transform: translateX(-50%) translateY(-8px) scale(0.985);
  transition:
    opacity 0.18s ease,
    transform 0.34s cubic-bezier(0.22, 1.45, 0.36, 1);
}

.search-pop.is-open {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(-50%) translateY(0) scale(1);
}

.search-tabs {
  display: flex;
  gap: 6px;
  padding: 0 2px 10px;
  flex-wrap: wrap;
}

.search-tab {
  height: 27px;
  padding: 0 12px;
  border-radius: var(--radius-pill);
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.18s ease, background 0.18s ease, border-color 0.18s ease;
}

.search-tab:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.search-tab.is-on {
  color: var(--src-accent, var(--accent));
  border-color: color-mix(in srgb, var(--src-accent, var(--accent)) 42%, transparent);
  background: color-mix(in srgb, var(--src-accent, var(--accent)) 12%, transparent);
}

.search-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: min(52vh, 430px);
  overflow-y: auto;
}

.search-list .row {
  padding: 7px 8px;
  border-radius: 11px;
}

.search-empty {
  padding: 26px 8px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}

.search-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
  padding: 8px 4px 0;
  border-top: 1px solid var(--line);
}

.search-note {
  color: var(--muted);
  font-size: 12px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-all {
  flex: none;
}

.source-tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  margin-left: auto;
  padding: 0 7px;
  border-radius: var(--radius-pill);
  border: 1px solid color-mix(in srgb, var(--src-accent, var(--accent)) 46%, transparent);
  color: var(--src-accent, var(--accent));
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.row .source-tag {
  margin-left: auto;
}

.poster-src {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: var(--radius-pill);
  border: 1px solid color-mix(in srgb, var(--src-accent, var(--accent)) 52%, transparent);
  background: color-mix(in srgb, #05060a 62%, transparent);
  color: var(--src-accent, var(--accent));
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  backdrop-filter: blur(6px);
}

/* 搜索结果展开成墙面时的渐变过渡 */
.wall.is-swap .wall-head {
  animation: wall-swap-in 0.32s ease both;
}

.wall.is-swap .wall-grid {
  animation: wall-swap-in 0.42s cubic-bezier(0.2, 0.9, 0.3, 1) both;
}

@keyframes wall-swap-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
"""


def append_css():
    text = load(CSS)
    assert 'search-dock' not in text, "CSS 已追加过"
    save(CSS, text + ("\r\n" if "\r\n" in text else "\n") + SEARCH_CSS)
    print("app.css OK")


append_css()
