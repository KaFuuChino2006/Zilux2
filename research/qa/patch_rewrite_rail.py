# -*- coding: utf-8 -*-
"""v1.5：rail 入口从首页卡片移到侧栏；侧栏默认只显示图标，鼠标悬停自动展开显示文字。"""
import io

WEB = r"E:\Zilux2开发\web"
SRC = WEB + r"\src"


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
        o = old.replace("\n", E)
        n = new.replace("\n", E)
        assert text.count(o) == 1, f"{label}: {old.splitlines()[0][:56]}"
        text = text.replace(o, n)
    save(path, text)
    print(label, "OK")


# ---------------- home.ts：删除首页入口卡片区 ----------------
apply(
    SRC + r"\ui\home.ts",
    "home.ts",
    [
        (
            " * 首页（基础播放页）：快捷入口 + 最近播放 + 推荐歌单。",
            " * 首页（基础播放页）：最近播放 + 推荐歌单（导航入口统一放在左侧 rail）。",
        ),
        (
            "    this.root.append(this.buildHero(data), this.buildEntries(data));",
            "    this.root.append(this.buildHero(data));",
        ),
        (
            """interface EntrySpec {
  key: string;
  iconName: string;
  title: string;
  sub: string;
  onClick: () => void;
}

""",
            "",
        ),
        (
            """  /* ------------------------------------------------------------------ */
  /* 六个入口                                                            */
  /* ------------------------------------------------------------------ */

  private entrySpecs(data: HomeData): EntrySpec[] {
    const likedSub = data.loggedIn ? (data.likedCount > 0 ? `${data.likedCount} 首` : '已同步') : '登录后同步';
    return [
      { key: 'liked', iconName: 'heart', title: '我喜欢的音乐', sub: likedSub, onClick: () => this.callbacks.onLiked() },
      {
        key: 'recent',
        iconName: 'clock',
        title: '最近播放',
        sub: data.recent.length > 0 ? `最近 ${data.recent.length} 首` : '保持最近播放列表',
        onClick: () => this.callbacks.onRecent(),
      },
      { key: 'recommend', iconName: 'sparkle', title: '推荐', sub: '按你的口味推荐歌单', onClick: () => this.callbacks.onRecommend() },
      { key: 'daily', iconName: 'calendar', title: '每日推荐', sub: '每天为你挑 30 首', onClick: () => this.callbacks.onDaily() },
      { key: 'daily30', iconName: 'music', title: '每日 30 首', sub: 'QQ 音乐每日榜单', onClick: () => this.callbacks.onDaily30() },
      { key: 'search', iconName: 'search', title: '搜索', sub: '找歌、找歌手、找歌单', onClick: () => this.callbacks.onSearch() },
    ];
  }

  private buildEntries(data: HomeData): HTMLElement {
    const grid = h('div', { class: 'home-entries' });
    for (const spec of this.entrySpecs(data)) {
      const button = h(
        'button',
        { class: ui.entry(), title: spec.sub },
        h('span', { class: ui.entryIcon() }, icon(spec.iconName, 20)),
        h(
          'span',
          { class: ui.entryBody() },
          h('span', { class: ui.entryTitle(), text: spec.title }),
          h('span', { class: ui.entrySub(), text: spec.sub }),
        ),
      );
      button.addEventListener('click', () => spec.onClick());
      grid.append(button);
    }
    return grid;
  }

""",
            "",
        ),
    ],
)

# ---------------- app.ts：rail 入口 + 文字标签 ----------------
apply(
    SRC + r"\ui\app.ts",
    "app.ts",
    [
        (
            """      { key: 'liked', label: '我喜欢的音乐', iconName: 'heart', onClick: () => void this.showLiked() },
      { key: 'playlists', label: '我的歌单', iconName: 'list', onClick: () => void this.openPlaylistSheet() },
      { key: 'local', label: '本地曲库', iconName: 'folder', onClick: () => this.showLocal() },
      { key: 'discover', label: '发现', iconName: 'sparkle', onClick: () => this.openDiscover() },""",
            """      { key: 'liked', label: '我喜欢的音乐', iconName: 'heart', onClick: () => void this.showLiked() },
      { key: 'recent', label: '最近播放', iconName: 'clock', onClick: () => void this.showRecentWall() },
      { key: 'recommend', label: '推荐', iconName: 'sparkle', onClick: () => void this.openRecommendSheet() },
      { key: 'daily', label: '每日推荐', iconName: 'calendar', onClick: () => void this.showDailyWall() },
      { key: 'daily30', label: '每日 30 首', iconName: 'music', onClick: () => void this.showDailyWall(true) },
      { key: 'playlists', label: '我的歌单', iconName: 'list', onClick: () => void this.openPlaylistSheet() },
      { key: 'local', label: '本地曲库', iconName: 'folder', onClick: () => this.showLocal() },
      { key: 'search', label: '搜索', iconName: 'search', onClick: () => this.focusSearch() },
      { key: 'discover', label: '发现', iconName: 'shuffle', onClick: () => this.openDiscover() },""",
        ),
        (
            """      const btn = h('button', { class: 'rail-btn', title: item.label }, icon(item.iconName, 20));""",
            """      const btn = h(
        'button',
        { class: 'rail-btn', title: item.label, 'aria-label': item.label },
        h('span', { class: 'rail-icon' }, icon(item.iconName, 20)),
        h('span', { class: 'rail-label', text: item.label }),
      );""",
        ),
        (
            """    const settingsBtn = h('button', { class: 'rail-btn', title: '设置' }, icon('settings', 20));""",
            """    const settingsBtn = h(
      'button',
      { class: 'rail-btn', title: '设置', 'aria-label': '设置' },
      h('span', { class: 'rail-icon' }, icon('settings', 20)),
      h('span', { class: 'rail-label', text: '设置' }),
    );""",
        ),
        (
            """  private homeHost!: HTMLDivElement;
  private home!: HomeView;
  private wallHost: HTMLDivElement;""",
            """  private homeHost!: HTMLDivElement;
  private home!: HomeView;
  private feedRailKey: string | null = null;
  private wallHost: HTMLDivElement;""",
        ),
        (
            """  private setRailActive(kind: WallKind | 'settings' | null): void {
    const activeKey: string | null = kind === 'playlist' ? 'playlists' : kind === 'recent' ? 'home' : kind;""",
            """  private setRailActive(kind: WallKind | 'settings' | 'home' | 'discover' | null): void {
    const activeKey: string | null =
      kind === 'playlist' ? 'playlists' : kind === 'feed' ? this.feedRailKey : kind;""",
        ),
        (
            "    this.setRailActive(null);\n    await this.loadHomeData();",
            "    this.setRailActive('home');\n    await this.loadHomeData();",
        ),
        (
            """    const title = qqDaily ? '每日 30 首' : '每日推荐';
    this.wall = { kind: 'feed', title, subtitle: `${SOURCE_LABEL[source]} · 同步中…`, tracks: [] };""",
            """    const title = qqDaily ? '每日 30 首' : '每日推荐';
    this.feedRailKey = qqDaily ? 'daily30' : 'daily';
    this.wall = { kind: 'feed', title, subtitle: `${SOURCE_LABEL[source]} · 同步中…`, tracks: [] };""",
        ),
        (
            """      toast('登录后可查看每日推荐与最近播放');
      return;
    }
    const source = account.source as OnlineSource;
    this.openSheet('发现', (body) => {""",
            """      toast('登录后可查看每日推荐与最近播放');
      return;
    }
    const source = account.source as OnlineSource;
    this.setRailActive('discover');
    this.openSheet('发现', (body) => {""",
        ),
    ],
)

# ---------------- app.css：rail 悬停展开 ----------------
CSS = SRC + r"\styles\app.css"
with io.open(CSS, "r", encoding="utf-8", newline="") as fh:
    css = fh.read()
E = "\r\n" if "\r\n" in css else "\n"
if ".rail-label" in css:
    print("app.css already patched")
else:
    add = r"""
/* ==========================================================================
   左侧栏：默认只有图标，鼠标悬停自动展开显示文字
   ========================================================================== */
.main {
  display: block;
}

.rail {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: var(--rail-w);
  padding: 10px 12px 22px;
  align-items: stretch;
  gap: 8px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
  z-index: 30;
  background: transparent;
  border-right: 1px solid transparent;
  transition: width 0.26s var(--ease), background 0.26s var(--ease), border-color 0.26s var(--ease),
    box-shadow 0.26s var(--ease);
}

.rail::-webkit-scrollbar {
  display: none;
}

.rail:hover,
.rail:focus-within {
  width: 196px;
  background: var(--panel-solid);
  border-right-color: var(--line);
  box-shadow: var(--shadow);
}

.rail-btn {
  width: 44px;
  min-height: 44px;
  height: 44px;
  padding: 0;
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  border-radius: var(--radius-pill);
  overflow: hidden;
  transition: width 0.26s var(--ease), padding 0.26s var(--ease), gap 0.26s var(--ease),
    background 0.18s var(--ease), color 0.18s var(--ease), border-color 0.18s var(--ease),
    border-radius 0.26s var(--ease);
}

.rail:hover .rail-btn,
.rail:focus-within .rail-btn {
  width: 100%;
  max-width: 172px;
  padding: 0 13px;
  justify-content: flex-start;
  gap: 11px;
  border-radius: var(--radius-pill);
}

.rail-icon {
  display: grid;
  place-items: center;
  flex: 0 0 20px;
}

.rail-label {
  max-width: 0;
  opacity: 0;
  overflow: hidden;
  white-space: nowrap;
  font-size: 12.5px;
  letter-spacing: 0.01em;
  transition: opacity 0.16s var(--ease), max-width 0.26s var(--ease);
}

.rail:hover .rail-label,
.rail:focus-within .rail-label {
  max-width: 132px;
  opacity: 1;
}

.rail-spacer {
  flex: 1 0 8px;
  min-height: 8px;
}

.stage {
  position: absolute;
  inset: 0 0 0 var(--rail-w);
  overflow: hidden;
}
"""
    css = css.rstrip("\r\n") + E * 2 + add.replace("\n", E).lstrip("\r\n")
    save(CSS, css)
    print("app.css OK")
