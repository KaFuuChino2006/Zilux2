# -*- coding: utf-8 -*-
"""新前端 v1.1：待播队列（右下角）+ 启动恢复音量。"""
import io

ROOT = r"E:\Zilux2开发\web\src"


def load(path):
    with io.open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def save(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def nl(text):
    return "\r\n" if "\r\n" in text else "\n"


app_path = ROOT + r"\ui\app.ts"
text = load(app_path)
E = nl(text)


def rep(old, new, label):
    global text
    old = old.replace("\n", E)
    new = new.replace("\n", E)
    assert text.count(old) == 1, "anchor: " + label
    text = text.replace(old, new)


# 1) 字段
rep(
    """  private volumeInput!: HTMLInputElement;
""",
    """  private volumeInput!: HTMLInputElement;

  private upnextRoot!: HTMLDivElement;
  private upnextSummary!: HTMLButtonElement;
  private upnextCover!: HTMLImageElement;
  private upnextTitle!: HTMLDivElement;
  private upnextArtist!: HTMLDivElement;
  private upnextPanel!: HTMLDivElement;
  private upnextList!: HTMLUListElement;
  private upnextOpen = false;
""",
    "fields",
)

# 2) 构造函数里构建
rep(
    """    this.buildPlayerBar();
  }
""",
    """    this.buildPlayerBar();
    this.buildUpNext();
  }
""",
    "constructor",
)

# 3) 方法块插到 syncPlayer 之前
methods = """  /* ------------------------------------------------------------------ */
  /* 待播队列                                                            */
  /* ------------------------------------------------------------------ */

  private buildUpNext(): void {
    const kicker = h('div', { class: 'upnext-kicker', text: '接下来' });
    this.upnextCover = h('img', { class: 'upnext-cover', alt: '' });
    this.upnextTitle = h('div', { class: 'upnext-title', text: '' });
    this.upnextArtist = h('div', { class: 'upnext-artist', text: '' });
    this.upnextSummary = h(
      'button',
      { class: 'upnext-summary', title: '待播队列（点击展开）' },
      kicker,
      this.upnextCover,
      h('div', { class: 'upnext-meta' }, this.upnextTitle, this.upnextArtist),
      icon('chevron', 16),
    );
    this.upnextSummary.addEventListener('click', () => {
      if (this.upnextOpen) this.closeUpNext();
      else this.openUpNext();
    });

    const skip = h('button', { class: 'btn upnext-skip', text: '跳过这首' });
    skip.addEventListener('click', () => {
      next();
      this.closeUpNext();
    });
    this.upnextList = h('ul', { class: 'upnext-list' });
    this.upnextPanel = h(
      'div',
      { class: 'upnext-panel' },
      h('div', { class: 'upnext-head' }, h('div', { class: 'upnext-head-title', text: '待播队列' }), skip),
      this.upnextList,
    );
    this.upnextRoot = h('div', { class: 'upnext is-hidden' }, this.upnextPanel, this.upnextSummary);
    this.root.append(this.upnextRoot);
    document.addEventListener('pointerdown', (event) => {
      if (!this.upnextOpen) return;
      const target = event.target as Node | null;
      if (target && this.upnextRoot.contains(target)) return;
      this.closeUpNext();
    });
  }

  private openUpNext(): void {
    if (this.upnextOpen) return;
    this.upnextOpen = true;
    this.upnextRoot.classList.add('is-open');
    this.renderUpNextList();
  }

  private closeUpNext(): void {
    if (!this.upnextOpen) return;
    this.upnextOpen = false;
    this.upnextRoot.classList.remove('is-open');
  }

  private renderUpNextList(): void {
    this.upnextList.textContent = '';
    const state = playerState();
    const upcoming = state.queue.slice(state.index + 1);
    if (upcoming.length === 0) {
      this.upnextList.append(h('li', { class: 'upnext-empty', text: '队列里没有下一首了' }));
      return;
    }
    upcoming.forEach((track, offset) => {
      const index = state.index + 1 + offset;
      const row = h(
        'li',
        { class: 'upnext-row' },
        h('img', { class: 'upnext-cover', src: onlineArtwork(track), alt: '' }),
        h(
          'div',
          { class: 'upnext-row-meta' },
          h('div', { class: 'upnext-title', text: track.title }),
          h('div', { class: 'upnext-artist', text: track.artist || '未知歌手' }),
        ),
        h('span', { class: 'upnext-index', text: String(offset + 1) }),
      );
      row.addEventListener('click', () => {
        playAt(index);
        this.closeUpNext();
      });
      this.upnextList.append(row);
    });
  }

  private syncUpNext(state: PlayerState): void {
    const upcoming = state.queue[state.index + 1] ?? null;
    const visible = state.track !== null && upcoming !== null;
    this.upnextRoot.classList.toggle('is-hidden', !visible);
    if (!visible || upcoming === null) {
      this.closeUpNext();
      return;
    }
    this.upnextCover.src = onlineArtwork(upcoming);
    this.upnextTitle.textContent = upcoming.title;
    this.upnextArtist.textContent = upcoming.artist || '未知歌手';
    if (this.upnextOpen) this.renderUpNextList();
  }

"""
rep("  private syncPlayer(state: PlayerState): void {", methods + "  private syncPlayer(state: PlayerState): void {", "methods")

# 4) syncPlayer 末尾调用
rep(
    """    posters.forEach((poster, index) => {
      const item = this.wall.tracks[index];
      poster.classList.toggle('is-playing', !!item && item.id === track.id);
    });
  }
""",
    """    posters.forEach((poster, index) => {
      const item = this.wall.tracks[index];
      poster.classList.toggle('is-playing', !!item && item.id === track.id);
    });
    this.syncUpNext(state);
  }
""",
    "syncPlayer call",
)

# 5) Esc 先关待播队列
rep(
    """  escapeTopLayer(): void {
    if (this.loginOverlay) {""",
    """  escapeTopLayer(): void {
    if (this.upnextOpen) {
      this.closeUpNext();
      return;
    }
    if (this.loginOverlay) {""",
    "escape order",
)

save(app_path, text)
print("app.ts OK")

# ---- main.ts：恢复保存的音量 ----
main_path = ROOT + r"\main.ts"
text = load(main_path)
E = nl(text)


def rep2(old, new, label):
    global text
    old = old.replace("\n", E)
    new = new.replace("\n", E)
    assert text.count(old) == 1, "main anchor: " + label
    text = text.replace(old, new)


rep2(
    "import { App } from './ui/app';",
    "import { App } from './ui/app';\nimport { setVolume } from './ui/player';",
    "import",
)
rep2(
    """  const settings = await loadSettings();
""",
    """  const settings = await loadSettings();
  setVolume(settings.playback.volume);
""",
    "volume restore",
)
save(main_path, text)
print("main.ts OK")

# ---- app.css：待播队列样式 ----
css_path = ROOT + r"\styles\app.css"
text = load(css_path)
E = nl(text)
css = """/* 待播队列 --------------------------------------------------------------- */
.upnext {
  position: fixed;
  right: 22px;
  bottom: calc(var(--player-h) + 16px);
  z-index: 8;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  max-width: min(360px, 92vw);
}

.upnext.is-hidden {
  display: none;
}

.upnext-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: var(--panel);
  backdrop-filter: blur(18px) saturate(1.15);
  color: var(--text);
  cursor: pointer;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.45);
  transition: border-color 0.2s var(--ease), transform 0.2s var(--ease);
}

.upnext-summary:hover {
  border-color: rgba(217, 192, 141, 0.45);
  transform: translateY(-1px);
}

.upnext-kicker {
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--accent);
  writing-mode: horizontal-tb;
  white-space: nowrap;
}

.upnext-cover {
  width: 34px;
  height: 34px;
  object-fit: cover;
  border-radius: 8px;
  background: #191b21;
}

.upnext-meta {
  min-width: 0;
  text-align: left;
}

.upnext-title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 168px;
}

.upnext-artist {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 168px;
}

.upnext-panel {
  width: min(340px, 92vw);
  max-height: 46vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  backdrop-filter: blur(20px) saturate(1.2);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
  opacity: 0;
  transform: translateY(8px) scale(0.98);
  pointer-events: none;
  transition: opacity 0.2s var(--ease), transform 0.2s var(--ease);
  overflow: hidden;
}

.upnext.is-open .upnext-panel {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}

.upnext-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--line);
}

.upnext-head-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--muted);
}

.upnext-skip {
  padding: 6px 12px;
  font-size: 12px;
}

.upnext-list {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
}

.upnext-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.16s var(--ease);
}

.upnext-row:hover {
  background: rgba(255, 255, 255, 0.06);
}

.upnext-row-meta {
  flex: 1;
  min-width: 0;
  text-align: left;
}

.upnext-row .upnext-title,
.upnext-row .upnext-artist {
  max-width: none;
}

.upnext-index {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.upnext-empty {
  padding: 18px 12px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}
"""
text = text.rstrip() + E + E + css.replace("\n", E)
save(css_path, text)
print("app.css OK")
