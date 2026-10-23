# -*- coding: utf-8 -*-
"""v1.4：首页（基础播放页）+ 主题/组件接口接入。

注意：上一版脚本用闭包 nonlocal 改的是函数内副本，文件没真正写入；这里改成逐文件 apply(edits)。
"""
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
        assert text.count(o) == 1, f"{label}: {old.splitlines()[0][:48]}"
        text = text.replace(o, n)
    save(path, text)
    print(label, "OK")


# ---------------- dom.ts：新增图标 ----------------
apply(
    SRC + r"\ui\dom.ts",
    "dom.ts",
    [
        (
            "  refresh:\n    '<path d=\"M19 12a7 7 0 11-2.2-5.1M19 4.6V9h-4.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>',",
            "  refresh:\n    '<path d=\"M19 12a7 7 0 11-2.2-5.1M19 4.6V9h-4.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>',\n"
            "  home:\n    '<path d=\"M4.4 10.5 12 4.5l7.6 6v7.9c0 .8-.6 1.4-1.4 1.4h-3.9v-5.2H9.7v5.2H5.8c-.8 0-1.4-.6-1.4-1.4z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linejoin=\"round\"/>',\n"
            "  clock:\n    '<circle cx=\"12\" cy=\"12\" r=\"7.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\"/><path d=\"M12 8.2V12l2.8 1.8\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>',\n"
            "  calendar:\n    '<rect x=\"4.4\" y=\"6\" width=\"15.2\" height=\"13.4\" rx=\"2.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\"/><path d=\"M8 4.2v3.4M16 4.2v3.4M4.8 10.2h14.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\"/>',\n"
            "  music:\n    '<path d=\"M9 17.4V6.6l9-1.8v10.8\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><circle cx=\"6.8\" cy=\"17.4\" r=\"2.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\"/><circle cx=\"15.8\" cy=\"15.6\" r=\"2.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\"/>',",
        )
    ],
)

# ---------------- main.ts：初始化主题 ----------------
apply(
    SRC + r"\main.ts",
    "main.ts",
    [
        ("import { h, toast } from './ui/dom';", "import { h, toast } from './ui/dom';\nimport { initTheme } from './ui/theme';"),
        (
            "  const settings = await loadSettings();\n  setVolume(settings.playback.volume);",
            "  const settings = await loadSettings();\n  initTheme();\n  setVolume(settings.playback.volume);",
        ),
    ],
)

HOME_METHODS = """  /* ------------------------------------------------------------------ */
  /* 首页                                                                */
  /* ------------------------------------------------------------------ */

  private preferredSource(): OnlineSource | null {
    const logged = getAccounts().filter((item) => item.loggedIn);
    const chosen = logged.find((item) => item.source === 'netease') ?? logged[0];
    return (chosen?.source as OnlineSource | undefined) ?? null;
  }

  private greeting(): string {
    const hour = new Date().getHours();
    if (hour < 5) return '夜深了，来点安静的歌';
    if (hour < 11) return '早上好';
    if (hour < 14) return '中午好';
    if (hour < 18) return '下午好';
    return '晚上好';
  }

  private async showHome(): Promise<void> {
    this.closeLyrics();
    this.homeHost.classList.remove('is-hidden');
    this.wallHost.classList.add('is-hidden');
    this.setRailActive(null);
    await this.loadHomeData();
  }

  private async loadHomeData(): Promise<void> {
    const loggedIn = getAccounts().some((item) => item.loggedIn);
    const preferred = this.preferredSource();
    let likedCount = 0;
    const playlists: LibraryPlaylist[] = [];
    if (loggedIn) {
      try {
        const overview = await fetchLibraryOverview();
        for (const state of overview.sources) {
          if (state.liked) likedCount += state.liked.count;
          if (state.loggedIn) playlists.push(...state.playlists);
        }
      } catch (err) {
        console.warn('[app] home overview failed', err);
      }
    }
    let recent: OnlineTrack[] = [];
    if (preferred) {
      try {
        recent = (await fetchFeed(preferred, 'recent', 14)).tracks;
      } catch (err) {
        console.warn('[app] home recent failed', err);
      }
    }
    const local = localLibrary();
    this.home.update({
      greeting: this.greeting(),
      subtitle: loggedIn ? '按你的口味排好队了，点封面就能播放' : '登录网易云 / QQ 音乐，同步收藏、最近播放与每日推荐',
      loggedIn,
      likedCount,
      localCount: local?.entries.length ?? 0,
      recent,
      playlists: playlists.slice(0, 14),
    });
  }

  private async showRecentWall(): Promise<void> {
    const source = this.preferredSource();
    if (!source) {
      toast('登录后才有最近播放');
      this.openLogin();
      return;
    }
    this.wall = { kind: 'recent', title: '最近播放', subtitle: `${SOURCE_LABEL[source]} · 同步中…`, tracks: [] };
    this.renderWall();
    try {
      const feed = await fetchFeed(source, 'recent', 100);
      this.wall = {
        kind: 'recent',
        title: '最近播放',
        subtitle: `${SOURCE_LABEL[source]} · ${feed.tracks.length} 首`,
        tracks: feed.tracks,
      };
      this.renderWall();
    } catch (err) {
      console.warn('[app] recent wall failed', err);
      toast('最近播放读取失败', 'error');
    }
  }

  private async showDailyWall(qqDaily = false): Promise<void> {
    const source: OnlineSource = qqDaily ? 'qq' : (this.preferredSource() ?? 'netease');
    if (!getAccounts().some((item) => item.loggedIn && item.source === source)) {
      toast(`登录${SOURCE_LABEL[source]}后才能看`);
      this.openLogin(source);
      return;
    }
    const title = qqDaily ? '每日 30 首' : '每日推荐';
    this.wall = { kind: 'feed', title, subtitle: `${SOURCE_LABEL[source]} · 同步中…`, tracks: [] };
    this.renderWall();
    try {
      const feed = await fetchFeed(source, 'daily', qqDaily ? 30 : 60);
      this.wall = { kind: 'feed', title, subtitle: `${SOURCE_LABEL[source]} · ${feed.tracks.length} 首`, tracks: feed.tracks };
      this.renderWall();
    } catch (err) {
      console.warn('[app] daily failed', err);
      toast('每日推荐读取失败', 'error');
    }
  }

  private async openRecommendSheet(): Promise<void> {
    if (!getAccounts().some((item) => item.loggedIn)) {
      toast('先登录后再看推荐');
      this.openLogin();
      return;
    }
    const ref: { body: HTMLDivElement | null } = { body: null };
    this.openSheet('推荐歌单', (body) => {
      ref.body = body;
      body.append(h('div', { class: 'empty', text: '加载推荐歌单…' }));
    });
    try {
      const overview = await fetchLibraryOverview();
      const body = ref.body;
      if (!body) return;
      body.textContent = '';
      let any = false;
      for (const state of overview.sources) {
        if (!state.loggedIn || state.playlists.length === 0) continue;
        any = true;
        body.append(h('h3', { class: 'section-title', text: `${SOURCE_LABEL[state.source]} · ${state.playlists.length} 个歌单` }));
        const list = h('div', { class: 'list' });
        state.playlists.forEach((item) => {
          const cover =
            item.cover ??
            onlineArtwork({ id: item.id, title: item.title, artist: item.creator ?? '', album: '', cover: '' });
          const row = h(
            'div',
            { class: 'row', title: item.title },
            h('div', { class: 'row-cover' }, h('img', { src: cover, loading: 'lazy', alt: '' })),
            h(
              'div',
              { class: 'row-meta' },
              h('div', { class: 'row-name', text: item.title }),
              h('div', { class: 'row-artist', text: `${item.creator ? item.creator + ' · ' : ''}${item.count} 首` }),
            ),
          );
          row.addEventListener('click', () => {
            this.sheet?.close();
            void this.showPlaylist(item);
          });
          list.append(row);
        });
        body.append(list);
      }
      if (!any) body.append(h('div', { class: 'empty', text: '暂时没有推荐歌单' }));
    } catch (err) {
      console.warn('[app] recommend failed', err);
      const body = ref.body;
      if (body) {
        body.textContent = '';
        body.append(h('div', { class: 'empty', text: '推荐歌单读取失败' }));
      }
    }
  }

"""

# ---------------- app.ts：首页 ----------------
apply(
    SRC + r"\ui\app.ts",
    "app.ts",
    [
        ("import { host } from '../core/bridge';", "import { host } from '../core/bridge';\nimport { HomeView } from './home';"),
        (
            "type WallKind = 'liked' | 'local' | 'search' | 'feed' | 'playlist';",
            "type WallKind = 'liked' | 'local' | 'search' | 'feed' | 'playlist' | 'recent';",
        ),
        (
            "  private stage: HTMLDivElement;\n  private wallHost: HTMLDivElement;",
            "  private stage: HTMLDivElement;\n  private homeHost!: HTMLDivElement;\n  private home!: HomeView;\n  private wallHost: HTMLDivElement;",
        ),
        (
            "    brand.title = '回到我喜欢的音乐';\n    brand.style.cursor = 'pointer';\n    brand.addEventListener('click', () => void this.showLiked());",
            "    brand.title = '回到首页';\n    brand.style.cursor = 'pointer';\n    brand.addEventListener('click', () => void this.showHome());",
        ),
        (
            "    const items: Array<{ key: string; label: string; iconName: string; onClick: () => void }> = [\n      { key: 'liked',",
            "    const items: Array<{ key: string; label: string; iconName: string; onClick: () => void }> = [\n      { key: 'home', label: '首页', iconName: 'home', onClick: () => void this.showHome() },\n      { key: 'liked',",
        ),
        (
            "    const main = h('div', { class: 'main' }, rail, this.stage);\n    this.stage.append(this.wallHost);\n    this.root.append(main);",
            "    this.homeHost = h('div', { class: 'home-host' });\n    this.home = new HomeView({\n      onLogin: () => this.openLogin(),\n      onLiked: () => void this.showLiked(),\n      onRecent: () => void this.showRecentWall(),\n      onRecommend: () => void this.openRecommendSheet(),\n      onDaily: () => void this.showDailyWall(),\n      onDaily30: () => void this.showDailyWall(true),\n      onSearch: () => this.focusSearch(),\n      onPlay: (tracks, index) => playQueue(tracks, index),\n      onPlaylist: (item) => void this.showPlaylist(item),\n    });\n    this.homeHost.append(this.home.root);\n    const main = h('div', { class: 'main' }, rail, this.stage);\n    this.stage.append(this.homeHost, this.wallHost);\n    this.root.append(main);",
        ),
        (
            "    const activeKey = kind === 'playlist' ? 'playlists' : kind;",
            "    const activeKey: string | null = kind === 'playlist' ? 'playlists' : kind === 'recent' ? 'home' : kind;",
        ),
        (
            "  private renderWall(): void {\n    this.closeLyrics();\n    this.wallHost.textContent = '';",
            "  private renderWall(): void {\n    this.closeLyrics();\n    this.homeHost.classList.add('is-hidden');\n    this.wallHost.classList.remove('is-hidden');\n    this.wallHost.textContent = '';",
        ),
        (
            "  /* ------------------------------------------------------------------ */\n  /* 墙面                                                                */",
            HOME_METHODS + "  /* ------------------------------------------------------------------ */\n  /* 墙面                                                                */",
        ),
        (
            """  private async bootData(): Promise<void> {
    this.syncAccount();
    const account = getAccounts().find((item) => item.loggedIn);
    if (account) {
      this.renderWall();
      await this.loadLiked(account.source as OnlineSource);
    } else {
      this.wall = {
        kind: 'liked',
        title: '我喜欢的音乐',
        subtitle: '登录网易云或 QQ 音乐后自动同步',
        tracks: [],
      };
      this.renderWall();
    }
  }""",
            """  private async bootData(): Promise<void> {
    this.syncAccount();
    await this.showHome();
  }""",
        ),
        (
            """  /** 启动后首次进入空间：加载默认收藏或提示登录。 */
  async enter(): Promise<void> {
    const account = getAccounts().find((item) => item.loggedIn);
    if (account) {
      await this.showLiked(account.source as OnlineSource);
      return;
    }
    await this.showLiked();
    if (!getAccounts().some((item) => item.loggedIn)) {
      this.openLogin();
    }
  }""",
            """  /** 启动后首次进入：展示首页（未登录时首页自带登录入口）。 */
  async enter(): Promise<void> {
    await this.showHome();
  }""",
        ),
        (
            """    const account = getAccounts().find((item) => item.loggedIn);
    if (account) {
      await this.showLiked(account.source as OnlineSource);
    } else {
      this.openLogin();
    }""",
            """    await this.showHome();""",
        ),
    ],
)
