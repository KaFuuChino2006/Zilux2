import sys
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发\web\src")
steps = []


def patch(path: Path, pairs):
    global text
    text = path.read_text(encoding="utf-8")
    for name, old, new in pairs:
        if old not in text:
            print(f"FAIL: {name}: not found")
            sys.exit(1)
        if text.count(old) != 1:
            print(f"FAIL: {name}: expected 1 match, got {text.count(old)}")
            sys.exit(1)
        text = text.replace(old, new)
        steps.append(name)
    path.write_text(text, encoding="utf-8")


# ---------------------------------------------------------------- islandPlayer
patch(ROOT / "ui" / "islandPlayer.ts", [
    (
        "ip-option",
        """  /** 切歌回调（用于查询喜欢状态等） */
  onTrack?(track: OnlineTrack): void;
}""",
        """  /** 切歌回调（用于查询喜欢状态等） */
  onTrack?(track: OnlineTrack): void;
  /** 从上次听到的位置继续播放时回调（秒） */
  onResume?(seconds: number): void;
}""",
    ),
    (
        "ip-progress-block",
        """  let scrubbing = false;
  let clockTimer = 0;
""",
        """  let scrubbing = false;
  let clockTimer = 0;

  /* 播放进度记忆：按「平台:id」记住上次听到的位置，下次播放同一首时接着放 */
  const PROGRESS_KEY = 'zilux2.playProgress';
  const progressKeyOf = (track: OnlineTrack): string => `${track.source}:${track.id}`;
  const readProgressMap = (): Record<string, { t: number; at: number }> => {
    try {
      const raw = window.localStorage.getItem(PROGRESS_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      return parsed as Record<string, { t: number; at: number }>;
    } catch {
      return {};
    }
  };
  function writeProgressMap(map: Record<string, { t: number; at: number }>): void {
    try {
      window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }
  let pendingResume = 0;
  let lastProgressSave = 0;
  function savedProgress(track: OnlineTrack): number {
    const entry = readProgressMap()[progressKeyOf(track)];
    if (!entry || typeof entry.t !== 'number') return 0;
    return entry.t >= 3 ? Math.round(entry.t) : 0;
  }
  function saveProgress(): void {
    const track = currentTrack();
    if (!track) return;
    const position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const map = readProgressMap();
    const key = progressKeyOf(track);
    // 开头几秒、结束前几秒都不值得记，视为「刚开始 / 已听完」
    if (position < 3 || (duration > 0 && position > duration - 4)) {
      if (map[key]) {
        delete map[key];
        writeProgressMap(map);
      }
      return;
    }
    map[key] = { t: Math.round(position), at: Date.now() };
    writeProgressMap(map);
  }
  function clearProgress(track: OnlineTrack | null): void {
    if (!track) return;
    const map = readProgressMap();
    const key = progressKeyOf(track);
    if (!map[key]) return;
    delete map[key];
    writeProgressMap(map);
  }
""",
    ),
    (
        "ip-play-index",
        """  function playIndex(nextIndex: number): void {
    if (queue.length === 0) return;
    index = ((nextIndex % queue.length) + queue.length) % queue.length;
    const track = currentTrack();
    if (!track) return;
""",
        """  function playIndex(nextIndex: number): void {
    if (queue.length === 0) return;
    // 换歌前先记住上一首听到的位置
    if (index >= 0) saveProgress();
    index = ((nextIndex % queue.length) + queue.length) % queue.length;
    const track = currentTrack();
    if (!track) return;
    pendingResume = savedProgress(track);
""",
    ),
    (
        "ip-loadedmetadata",
        """  audio.addEventListener('loadedmetadata', updateClock);
""",
        """  audio.addEventListener('loadedmetadata', () => {
    updateClock();
    if (pendingResume <= 0) return;
    const seconds = pendingResume;
    pendingResume = 0;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (duration > 0 && seconds >= duration - 2) return;
    try {
      audio.currentTime = seconds;
      options.onResume?.(seconds);
    } catch {
      /* 元数据未就绪时忽略，下次再试 */
    }
  });
""",
    ),
    (
        "ip-timeupdate",
        """  audio.addEventListener('timeupdate', updateClock);
""",
        """  audio.addEventListener('timeupdate', () => {
    updateClock();
    const now = performance.now();
    if (now - lastProgressSave > 5000) {
      lastProgressSave = now;
      saveProgress();
    }
  });
""",
    ),
    (
        "ip-pause",
        """  audio.addEventListener('pause', () => setPlaying(false));
""",
        """  audio.addEventListener('pause', () => {
    setPlaying(false);
    saveProgress();
  });
""",
    ),
    (
        "ip-ended",
        """  audio.addEventListener('ended', () => pickNext(1));
""",
        """  audio.addEventListener('ended', () => {
    clearProgress(currentTrack());
    pendingResume = 0;
    pickNext(1);
  });
""",
    ),
    (
        "ip-pagehide",
        """  audio.addEventListener('error', () => {
""",
        """  // 关窗 / 切到后台时补记一次进度
  window.addEventListener('pagehide', () => saveProgress());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProgress();
  });
  audio.addEventListener('error', () => {
""",
    ),
])

# ---------------------------------------------------------------- spaceShell
patch(ROOT / "ui" / "spaceShell.ts", [
    (
        "ss-foot-html",
        """    <div class="space-foot">
      <span data-space-status>正在读取登录状态…</span>
    </div>""",
        """    <div class="space-foot">
      <button class="space-foot-btn" data-page-first type="button" title="回到第一页">回到第一页</button>
      <span data-space-status>正在读取登录状态…</span>
      <button class="space-foot-btn" data-page-jump type="button" title="跳转到指定页">跳页</button>
      <div class="space-page-pop" data-page-pop hidden>
        <label class="space-page-pop-label">跳到第 <input class="space-page-pop-input" data-page-input type="number" min="1" step="1" value="1" /> 页</label>
        <button class="space-foot-btn is-primary" data-page-go type="button">跳转</button>
      </div>
    </div>""",
    ),
    (
        "ss-liked-page-storage",
        """  let likedSource: MusicSource = readLikedSource();
""",
        """  let likedSource: MusicSource = readLikedSource();
  /** 记住每个平台「我的收藏」上次翻到的页码，下次进入直接复位到那一页 */
  const LIKED_PAGE_KEY = 'zilux2.likedPage';
  function readLikedPage(source: MusicSource): number {
    try {
      const raw = window.localStorage.getItem(LIKED_PAGE_KEY);
      if (!raw) return 1;
      const map = JSON.parse(raw) as Record<string, unknown>;
      const value = Number(map?.[source]);
      if (!Number.isFinite(value) || value < 1) return 1;
      return Math.min(9999, Math.floor(value));
    } catch {
      return 1;
    }
  }
  function persistLikedPage(source: MusicSource, page: number): void {
    try {
      const raw = window.localStorage.getItem(LIKED_PAGE_KEY);
      const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      map[source] = page;
      window.localStorage.setItem(LIKED_PAGE_KEY, JSON.stringify(map));
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }
""",
    ),
    (
        "ss-page-controls",
        """  root.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((button) => {
    button.addEventListener('click', () => {
      turnTiles(Number(button.dataset.page));
    });
  });
""",
        """  root.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((button) => {
    button.addEventListener('click', () => {
      turnTiles(Number(button.dataset.page));
    });
  });

  /* 页码记忆 / 跳页 / 回到第一页 */
  const pagePop = root.querySelector<HTMLElement>('[data-page-pop]');
  const pageInput = root.querySelector<HTMLInputElement>('[data-page-input]');
  const pageFirstBtn = root.querySelector<HTMLButtonElement>('[data-page-first]');
  const pageJumpBtn = root.querySelector<HTMLButtonElement>('[data-page-jump]');
  const pageGoBtn = root.querySelector<HTMLButtonElement>('[data-page-go]');

  function closePagePop(): void {
    if (!pagePop) return;
    pagePop.hidden = true;
    pageJumpBtn?.classList.remove('is-open');
  }

  function syncPageControls(): void {
    if (pageFirstBtn) pageFirstBtn.disabled = !likedViewOpen || likedPage <= 1;
    if (pageJumpBtn) pageJumpBtn.textContent = `跳页 ${likedPage}/${likedPageCount()}`;
    if (pageInput) {
      pageInput.max = String(Math.max(1, likedPageCount()));
      pageInput.value = String(likedPage);
    }
  }

  function jumpToLikedPage(rawPage: number): void {
    if (!space) return;
    closePagePop();
    const page = Number.isFinite(rawPage) ? Math.floor(rawPage) : 1;
    if (!likedViewOpen) {
      // 搜索等临时列表没有页码概念，只支持「回到第一页」
      if (page <= 1) {
        space.turnPage(-999);
        showToast('已回到第一页', 'info');
      } else {
        showToast('跳页仅在「我喜欢的音乐」视图可用', 'info');
      }
      return;
    }
    const target = Math.min(Math.max(1, likedPageCount()), Math.max(1, page));
    if (target === likedPage) {
      showToast(`已经是第 ${target} 页`, 'info');
      return;
    }
    if (likedPageBusy) {
      likedPendTarget = target;
      return;
    }
    void showLikedPage(target, true);
  }

  pageFirstBtn?.addEventListener('click', () => jumpToLikedPage(1));
  pageJumpBtn?.addEventListener('click', () => {
    if (!pagePop) return;
    if (!pagePop.hidden) {
      closePagePop();
      return;
    }
    if (pageInput) {
      pageInput.max = String(Math.max(1, likedPageCount()));
      pageInput.value = String(likedPage);
    }
    pagePop.hidden = false;
    pageJumpBtn.classList.add('is-open');
    pageInput?.focus();
    pageInput?.select();
  });
  pageGoBtn?.addEventListener('click', () => {
    if (pageInput) jumpToLikedPage(Number(pageInput.value));
  });
  pageInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      jumpToLikedPage(Number(pageInput.value));
    } else if (event.key === 'Escape') {
      closePagePop();
    }
  });
  root.addEventListener('pointerdown', (event) => {
    if (!pagePop || pagePop.hidden) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-page-pop], [data-page-jump]')) return;
    closePagePop();
  });
  syncPageControls();
""",
    ),
    (
        "ss-show-page-persist",
        """      likedPage = target;
      tileTracks = tracks;
""",
        """      likedPage = target;
      persistLikedPage(source, likedPage);
      tileTracks = tracks;
""",
    ),
    (
        "ss-show-page-status",
        """      setStatus(likedStatusText());
      // 预取下一页：打开第 1 页就同时准备好第 2 页
""",
        """      setStatus(likedStatusText());
      syncPageControls();
      // 预取下一页：打开第 1 页就同时准备好第 2 页
""",
    ),
    (
        "ss-load-restore-page",
        """    likedPage = 1;
    likedTotal = 0;
""",
        """    likedPage = readLikedPage(likedSource);
    likedTotal = 0;
""",
    ),
    (
        "ss-load-show-page",
        """    await showLikedPage(1, false);
    // 首屏拿到空列表（宿主缓存冷启动偶发）时自动再取一次
    if (likedViewOpen && likedPages.size > 0) {
      const first = likedPages.get(1);
""",
        """    await fillLikedBuffer();
    syncPageControls();
    await showLikedPage(likedPage, false);
    // 首屏拿到空列表（宿主缓存冷启动偶发）时自动再取一次
    if (likedViewOpen && likedPages.size > 0) {
      const first = likedPages.get(likedPage);
""",
    ),
    (
        "ss-load-retry-page",
        """        window.setTimeout(() => {
          if (likedViewOpen) void showLikedPage(1, false);
        }, 800);
""",
        """        window.setTimeout(() => {
          if (likedViewOpen) void showLikedPage(likedPage, false);
        }, 800);
""",
    ),
    (
        "ss-island-resume",
        """  const island = createIslandPlayer({
    onError: (message) => showToast(message, 'error'),
""",
        """  const island = createIslandPlayer({
    onError: (message) => showToast(message, 'error'),
    onResume: (seconds) => showToast(`从 ${formatClock(seconds)} 继续播放`, 'info'),
""",
    ),
])

css = ROOT / "styles" / "space.css"
css.write_text(
    css.read_text(encoding="utf-8")
    + """
/* 底部：回到第一页 / 跳页 */
.space-foot {
  display: flex;
  align-items: center;
  gap: 10px;
}
.space-foot-btn {
  border: 1px solid rgba(255, 255, 255, 0.9);
  background: rgba(255, 255, 255, 0.78);
  color: inherit;
  font: 500 11px/1 "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
  padding: 5px 10px;
  border-radius: var(--r-pill);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.18s ease, opacity 0.18s ease, transform 0.18s ease;
}
.space-foot-btn:hover {
  background: rgba(255, 255, 255, 0.98);
  transform: translateY(-1px);
}
.space-foot-btn:disabled {
  opacity: 0.4;
  cursor: default;
  transform: none;
}
.space-foot-btn.is-primary {
  background: rgba(23, 26, 33, 0.88);
  border-color: rgba(23, 26, 33, 0.88);
  color: #f7f4ec;
}
.space-page-pop {
  position: fixed;
  left: 50%;
  bottom: 92px;
  z-index: 60;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 13px;
  border-radius: var(--r-pill);
  border: 1px solid rgba(255, 255, 255, 0.92);
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 14px 34px rgba(23, 26, 33, 0.18);
  backdrop-filter: blur(18px) saturate(160%);
  color: rgba(46, 52, 64, 0.94);
  font: 500 11.5px/1.4 "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
}
.space-page-pop[hidden] {
  display: none;
}
.space-page-pop-label {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.space-page-pop-input {
  width: 64px;
  padding: 4px 8px;
  border-radius: 8px;
  border: 1px solid rgba(23, 26, 33, 0.14);
  background: rgba(255, 255, 255, 0.9);
  color: inherit;
  font: inherit;
  text-align: center;
}
.space-page-pop-input:focus {
  outline: none;
  border-color: rgba(23, 26, 33, 0.4);
}
.space-shell.is-dim .space-foot-btn,
.space-shell.is-idle .space-foot-btn {
  pointer-events: auto;
}
""",
    encoding="utf-8",
)
steps.append("css-append")

print("OK:", ", ".join(steps))
