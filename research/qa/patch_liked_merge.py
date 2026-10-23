# -*- coding: utf-8 -*-
"""左侧「网易 / QQ」两个按钮合并为一个「收藏」，点击弹出选择展示哪个平台的「我喜欢的音乐」。"""
import io

P = r"E:\Zilux2开发\web\src\ui\spaceShell.ts"
s = io.open(P, "r", encoding="utf-8", newline="").read()


def patch(old, new, count=1, label=""):
    global s
    assert s.count(old) == count, f"anchor miss {label or old[:70]!r} count={s.count(old)}"
    s = s.replace(old, new, count)


# 1) rail：两个来源按钮 → 一个「收藏」按钮
patch(
    """      <button class="space-rail-btn space-rail-src is-on" data-liked-source="netease" type="button" aria-label="网易云我喜欢" title="网易云 · 我喜欢的音乐"><span class="rail-src-text">网易</span></button>
      <button class="space-rail-btn space-rail-src" data-liked-source="qq" type="button" aria-label="QQ我喜欢" title="QQ 音乐 · 我喜欢的音乐"><span class="rail-src-text">QQ</span></button>""",
    """      <button class="space-rail-btn" data-rail="liked" type="button" aria-label="收藏" title="收藏 · 我喜欢的音乐">${icon('heart', 18)}</button>""",
    label="rail merge",
)

# 2) 选择弹层（跟随「收藏」按钮）
patch(
    """    <div class="space-side">""",
    """    <div class="liked-pop" data-liked-pop hidden>
      <p class="liked-pop-title">我喜欢的音乐</p>
      <button class="liked-pop-item is-on" data-liked-source="netease" type="button">
        <span class="liked-pop-dot is-netease">云</span>
        <span class="liked-pop-meta"><strong>网易云音乐</strong><span data-liked-pop-count="netease">读取中…</span></span>
        <span class="liked-pop-check">✓</span>
      </button>
      <button class="liked-pop-item" data-liked-source="qq" type="button">
        <span class="liked-pop-dot is-qq">Q</span>
        <span class="liked-pop-meta"><strong>QQ 音乐</strong><span data-liked-pop-count="qq">读取中…</span></span>
        <span class="liked-pop-check">✓</span>
      </button>
    </div>
    <div class="space-side">""",
    label="liked pop markup",
)

# 3) 逻辑：放在 exitLikedView 之后
anchor = """  function exitLikedView(): void {
    if (!likedViewOpen) return;
    likedViewOpen = false;
    void loadLikedTiles();
  }
"""
assert s.count(anchor) == 1, "exitLikedView"
logic = anchor + r"""
  /* 左侧「收藏」：弹出小面板选择展示哪个平台的「我喜欢的音乐」 */
  const likedPopEl = root.querySelector<HTMLElement>('[data-liked-pop]')!;
  const likedPopCountEls = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>('[data-liked-pop-count]').forEach((el) => {
    likedPopCountEls.set(el.dataset.likedPopCount ?? '', el);
  });

  function positionLikedPop(): void {
    const railBtn = root.querySelector<HTMLButtonElement>('[data-rail="liked"]');
    if (!railBtn) return;
    const rect = railBtn.getBoundingClientRect();
    const width = 252;
    const height = 168;
    const top = Math.max(16, Math.min(window.innerHeight - height - 16, rect.top - 34));
    likedPopEl.style.width = `${width}px`;
    likedPopEl.style.top = `${top}px`;
    likedPopEl.style.left = `${rect.right + 14}px`;
  }

  function renderLikedPopCounts(): void {
    const overview = libraryOverviewCache;
    (['netease', 'qq'] as MusicSource[]).forEach((source) => {
      const el = likedPopCountEls.get(source);
      if (!el) return;
      const state = overview?.sources.find((entry) => entry.source === source);
      if (!state) {
        el.textContent = '读取中…';
        return;
      }
      if (!state.loggedIn) {
        el.textContent = '未登录';
        return;
      }
      el.textContent = state.liked ? `${state.liked.count} 首` : '暂无收藏';
    });
  }

  function openLikedSourcePicker(): void {
    if (!likedPopEl.hidden) {
      closeLikedSourcePicker();
      return;
    }
    likedPopEl.hidden = false;
    positionLikedPop();
    markLikedSource(likedSource);
    renderLikedPopCounts();
    if (!libraryOverviewCache) {
      void ensureLibraryData().then(() => renderLikedPopCounts());
    }
  }

  function closeLikedSourcePicker(): void {
    if (likedPopEl.hidden) return;
    likedPopEl.hidden = true;
  }

  function toggleLikedSourcePicker(): void {
    if (likedPopEl.hidden) openLikedSourcePicker();
    else closeLikedSourcePicker();
  }

  document.addEventListener('pointerdown', (event) => {
    if (likedPopEl.hidden) return;
    const target = event.target as Node;
    if (likedPopEl.contains(target)) return;
    const railBtn = root.querySelector<HTMLElement>('[data-rail="liked"]');
    if (railBtn?.contains(target)) return;
    closeLikedSourcePicker();
  });
  window.addEventListener('resize', () => {
    if (!likedPopEl.hidden) positionLikedPop();
  });
"""
s = s.replace(anchor, logic, 1)

# 4) rail 绑定：收藏 → 弹选择面板
patch(
    """      if (feature === 'liked') {
        void toggleLikedView();
        return;
      }""",
    """      if (feature === 'liked') {
        toggleLikedSourcePicker();
        return;
      }""",
    label="rail liked branch",
)

# 5) 来源按钮点击后收起弹层
patch(
    """  /* 左侧「我喜欢」来源切换：网易云 / QQ 音乐 */
  root.querySelectorAll<HTMLButtonElement>('[data-liked-source]').forEach((button) => {
    button.addEventListener('click', () => {
      void switchLikedSource(button.dataset.likedSource === 'qq' ? 'qq' : 'netease');
    });
  });""",
    """  /* 收藏弹层里的平台切换：网易云 / QQ 音乐 */
  root.querySelectorAll<HTMLButtonElement>('[data-liked-source]').forEach((button) => {
    button.addEventListener('click', () => {
      closeLikedSourcePicker();
      void switchLikedSource(button.dataset.likedSource === 'qq' ? 'qq' : 'netease');
    });
  });""",
    label="liked source bind",
)

# 6) 「收藏」高亮跟随 liked 视图状态
patch(
    """  async function toggleLikedView(): Promise<void> {
    if (!space) return;
    if (!entered) enterSpace(false);
    likedViewOpen = true;""",
    """  async function toggleLikedView(): Promise<void> {
    if (!space) return;
    if (!entered) enterSpace(false);
    likedViewOpen = true;
    markLikedViewState(true);""",
    label="toggle liked mark",
)

patch(
    """  function exitLikedView(): void {
    if (!likedViewOpen) return;
    likedViewOpen = false;
    void loadLikedTiles();
  }""",
    """  function exitLikedView(): void {
    if (!likedViewOpen) return;
    likedViewOpen = false;
    markLikedViewState(false);
    void loadLikedTiles();
  }""",
    label="exit liked mark",
)

# 7) markLikedSource 增加收藏视图高亮辅助
patch(
    """  function markLikedSource(source: MusicSource): void {
    root.querySelectorAll<HTMLElement>('[data-liked-source]').forEach((button) => {
      button.classList.toggle('is-on', button.dataset.likedSource === source);
    });
  }""",
    """  function markLikedSource(source: MusicSource): void {
    root.querySelectorAll<HTMLElement>('[data-liked-source]').forEach((button) => {
      button.classList.toggle('is-on', button.dataset.likedSource === source);
    });
  }

  function markLikedViewState(active: boolean): void {
    root.querySelectorAll<HTMLElement>('[data-rail="liked"]').forEach((button) => {
      button.classList.toggle('is-on', active);
    });
  }""",
    label="mark liked view state",
)

# 8) 打开歌单时取消收藏高亮
patch(
    """    likedTitle = playlist.title || '歌单';
    likedViewOpen = true;""",
    """    likedTitle = playlist.title || '歌单';
    likedViewOpen = true;
    markLikedViewState(false);""",
    label="playlist into wall marks off",
)

# 9) Esc 关闭弹层（放在关闭账号面板之后）
patch(
    """    if (event.key === 'Escape' && !librarySheet.hidden) {
      event.preventDefault();
      closeLibrarySheet();
      return;
    }""",
    """    if (event.key === 'Escape' && !librarySheet.hidden) {
      event.preventDefault();
      closeLibrarySheet();
      return;
    }
    if (event.key === 'Escape' && !likedPopEl.hidden) {
      event.preventDefault();
      closeLikedSourcePicker();
      return;
    }""",
    label="esc close picker",
)

io.open(P, "w", encoding="utf-8", newline="").write(s)
print("liked merged into favorites picker")
