# -*- coding: utf-8 -*-
"""首页：去掉「晚上好」问候/副标题与搜索按钮，顶部改成「今日推荐」区块。"""
import io

HOME = r"E:\Zilux2开发\web\src\ui\home.ts"
APP = r"E:\Zilux2开发\web\src\ui\app.ts"


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


apply(
    HOME,
    "home.ts 数据结构",
    [
        (
            """export interface HomeData {
  greeting: string;
  subtitle: string;
  loggedIn: boolean;
  likedCount: number;
  localCount: number;
  recent: OnlineTrack[];
  playlists: LibraryPlaylist[];
}""",
            """export interface HomeData {
  loggedIn: boolean;
  likedCount: number;
  localCount: number;
  /** 今日推荐（每日推荐）的曲目与来源 */
  dailySource: string;
  dailyDate: string;
  dailyLoading: boolean;
  daily: OnlineTrack[];
  recent: OnlineTrack[];
  playlists: LibraryPlaylist[];
}""",
        ),
        (
            """  update(data: HomeData): void {
    this.root.textContent = '';
    this.root.append(this.buildHero(data));
""",
            """  update(data: HomeData): void {
    this.root.textContent = '';
    this.root.append(this.buildDaily(data));
""",
        ),
        (
            """  /* ------------------------------------------------------------------ */
  /* 顶部                                                                */
  /* ------------------------------------------------------------------ */

  private buildHero(data: HomeData): HTMLElement {
    const search = h('button', { class: ui.btn({ variant: 'ghost', size: 'lg', extra: 'home-search' }) }, icon('search', 18), h('span', { text: '搜索歌曲、歌手、歌单' }));
    search.addEventListener('click', () => this.callbacks.onSearch());

    const actions = h('div', { class: 'home-actions' }, search);
    if (!data.loggedIn) {
      const login = h('button', { class: ui.btn({ variant: 'primary' }) }, icon('user', 16), h('span', { text: '登录网易云 / QQ 音乐' }));
      login.addEventListener('click', () => this.callbacks.onLogin());
      actions.append(login);
    }

    return h(
      'div',
      { class: 'home-hero' },
      h('h1', { class: ui.heading(), text: data.greeting }),
      h('div', { class: ui.sub(), text: data.subtitle }),
      actions,
    );
  }""",
            """  /* ------------------------------------------------------------------ */
  /* 今日推荐（首页首屏）                                                 */
  /* ------------------------------------------------------------------ */

  private buildDaily(data: HomeData): HTMLElement {
    const section = h('section', { class: ui.section('home-daily') });
    const sourceLabel = SOURCE_LABEL[data.dailySource] ?? data.dailySource;
    const head = h(
      'div',
      { class: ui.sectionHead() },
      h(
        'div',
        {},
        h('h2', { class: ui.sectionTitle(), text: '今日推荐' }),
        h('div', { class: ui.sub(), text: `${sourceLabel} · ${data.dailyDate}` }),
      ),
      h('div', { class: 'home-actions' }),
    );
    const actions = head.querySelector<HTMLDivElement>('.home-actions');
    if (actions) {
      const more = h('button', { class: ui.sectionMore() }, h('span', { text: '查看全部' }));
      more.addEventListener('click', () => this.callbacks.onDaily());
      actions.append(more);
      if (data.daily.length > 0) {
        const playAll = h('button', { class: ui.btn({ variant: 'primary' }) }, icon('play', 16), h('span', { text: '播放全部' }));
        playAll.addEventListener('click', () => this.callbacks.onPlay(data.daily, 0));
        actions.append(playAll);
      }
    }

    if (!data.loggedIn) {
      const login = h('button', { class: ui.btn({ variant: 'primary' }) }, icon('user', 16), h('span', { text: '登录网易云 / QQ 音乐' }));
      login.addEventListener('click', () => this.callbacks.onLogin());
      section.append(
        head,
        h(
          'div',
          { class: 'home-daily-empty' },
          h('div', { class: ui.empty(), text: '登录后每天推荐一批合你口味的歌' }),
          login,
        ),
      );
      return section;
    }

    if (data.daily.length === 0) {
      section.append(head, h('div', { class: ui.empty(), text: data.dailyLoading ? '今日推荐加载中…' : '今天还没有推荐，稍后再来看看' }));
      return section;
    }

    const scroller = h('div', { class: ui.scroller() });
    data.daily.forEach((track, index) => {
      const tile = h(
        'button',
        { class: ui.tile(), title: `${track.title} - ${track.artist}` },
        h('span', { class: ui.tileCover() }, h('img', { src: onlineArtwork(track), loading: 'lazy', alt: '' })),
        h('span', { class: ui.tileName(), text: track.title }),
        h('span', { class: ui.tileMeta(), text: track.artist || '未知歌手' }),
      );
      tile.addEventListener('click', () => this.callbacks.onPlay(data.daily, index));
      scroller.append(tile);
    });
    section.append(head, scroller);
    return section;
  }""",
        ),
    ],
)

apply(
    APP,
    "app.ts 首页数据",
    [
        (
            """  private greeting(): string {
    const hour = new Date().getHours();
    if (hour < 5) return '夜深了，来点安静的歌';
    if (hour < 11) return '早上好';
    if (hour < 14) return '中午好';
    if (hour < 18) return '下午好';
    return '晚上好';
  }

""",
            "",
        ),
        (
            """    let recent: OnlineTrack[] = [];
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
    });""",
            """    let recent: OnlineTrack[] = [];
    let daily: OnlineTrack[] = [];
    if (preferred) {
      try {
        recent = (await fetchFeed(preferred, 'recent', 14)).tracks;
      } catch (err) {
        console.warn('[app] home recent failed', err);
      }
      try {
        daily = (await fetchFeed(preferred, 'daily', 14)).tracks;
      } catch (err) {
        console.warn('[app] home daily failed', err);
      }
    }
    const local = localLibrary();
    const now = new Date();
    const dailyDate = `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 每天 6:00 更新`;
    this.home.update({
      loggedIn,
      likedCount,
      localCount: local?.entries.length ?? 0,
      dailySource: preferred ?? 'netease',
      dailyDate,
      dailyLoading: false,
      daily,
      recent,
      playlists: playlists.slice(0, 14),
    });""",
        ),
    ],
)

CSSCSS = ""

# 首页今日推荐：让 head 右侧动作横排
CSS_PATH = r"E:\Zilux2开发\web\src\styles\app.css"
css = load(CSS_PATH)
assert 'home-daily-empty' not in css
add = """
/* ------------------------------ 首页：今日推荐 ------------------------------ */
.home-daily {
  padding-top: 4px;
}

.home-daily .section-head {
  align-items: flex-end;
}

.home-daily-empty {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border-radius: var(--radius-l);
  border: 1px dashed var(--line-strong);
  background: var(--surface);
}

.home-daily-empty .ui-empty {
  padding: 0;
  text-align: left;
}

.home-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
"""
save(CSS_PATH, css + ("\r\n" if "\r\n" in css else "\n") + add)
print("app.css OK")
