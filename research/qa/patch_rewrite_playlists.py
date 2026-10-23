# -*- coding: utf-8 -*-
"""新前端 v1.2：我的歌单（浏览两平台所有歌单并铺到墙面）。"""
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


# ---------- dom.ts：新增 list 图标 ----------
p = ROOT + r"\ui\dom.ts"
text = load(p)
E = nl(text)
old = "  heart:\n"
assert text.count(old) == 1
new = (
    "  list: '<path d=\"M5 7h14M5 12h14M5 17h9\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" fill=\"none\"/><circle cx=\"18.4\" cy=\"17\" r=\"1.7\" fill=\"currentColor\"/>',\n"
    "  heart:\n"
)
text = text.replace(old, new.replace("\n", E))
save(p, text)
print("dom.ts OK")

# ---------- app.ts ----------
p = ROOT + r"\ui\app.ts"
text = load(p)
E = nl(text)


def rep(old, new, label):
    global text
    o = old.replace("\n", E)
    n = new.replace("\n", E)
    assert text.count(o) == 1, "anchor: " + label
    text = text.replace(o, n)


# wall kind
rep(
    "type WallKind = 'liked' | 'local' | 'search' | 'feed';",
    "type WallKind = 'liked' | 'local' | 'search' | 'feed' | 'playlist';",
    "WallKind",
)

# import 类型
rep(
    "import { fetchLibraryOverview, fetchPlaylist, refreshLibrary } from '../core/library';",
    "import { fetchLibraryOverview, fetchPlaylist, refreshLibrary } from '../core/library';\nimport type { LibraryPlaylist } from '../core/library';",
    "library import",
)

# brand 点击回收藏
rep(
    """    const brand = h('div', { class: 'brand' }, brandMark, h('div', { class: 'brand-name', text: 'ZILUX' }));
""",
    """    const brand = h('div', { class: 'brand' }, brandMark, h('div', { class: 'brand-name', text: 'ZILUX' }));
    brand.title = '回到我喜欢的音乐';
    brand.style.cursor = 'pointer';
    brand.addEventListener('click', () => void this.showLiked());
""",
    "brand click",
)

# rail 增加歌单入口
rep(
    """      { key: 'liked', label: '我喜欢的音乐', iconName: 'heart', onClick: () => void this.showLiked() },
""",
    """      { key: 'liked', label: '我喜欢的音乐', iconName: 'heart', onClick: () => void this.showLiked() },
      { key: 'playlists', label: '我的歌单', iconName: 'list', onClick: () => void this.openPlaylistSheet() },
""",
    "rail item",
)

# 方法：插到 openDiscover 之前
methods = """  /* ------------------------------------------------------------------ */
  /* 歌单                                                                */
  /* ------------------------------------------------------------------ */

  private async openPlaylistSheet(): Promise<void> {
    if (!getAccounts().some((item) => item.loggedIn)) {
      toast('先登录网易云或 QQ 音乐，才能读取歌单');
      this.openLogin();
      return;
    }
    const ref: { body: HTMLDivElement | null } = { body: null };
    this.openSheet('我的歌单', (body) => {
      ref.body = body;
      body.append(h('div', { class: 'empty', text: '加载歌单…' }));
    });
    try {
      const overview = await fetchLibraryOverview();
      const body = ref.body;
      if (!body) return;
      body.textContent = '';
      let any = false;
      for (const state of overview.sources) {
        if (!state.loggedIn) continue;
        const items: LibraryPlaylist[] = [];
        if (state.liked) items.push(state.liked);
        items.push(...state.playlists);
        if (items.length === 0) continue;
        any = true;
        body.append(h('h3', { class: 'section-title', text: `${SOURCE_LABEL[state.source]} · ${items.length} 个歌单` }));
        const list = h('div', { class: 'list' });
        items.forEach((item) => {
          const cover =
            item.cover ??
            onlineArtwork({
              source: item.source,
              id: item.id,
              title: item.title,
              artist: item.creator ?? '',
              album: '',
              durationMs: 0,
              playable: true,
            });
          const row = h(
            'div',
            { class: 'row', title: item.title },
            h('div', { class: 'row-cover' }, h('img', { src: cover, loading: 'lazy' })),
            h(
              'div',
              { class: 'row-meta' },
              h('div', { class: 'row-name', text: item.title }),
              h('div', {
                class: 'row-artist',
                text: `${item.creator ? item.creator + ' · ' : ''}${item.count} 首`,
              }),
            ),
            h('div', { class: 'row-dur', text: item.special === 'liked' ? '喜欢' : '' }),
          );
          row.addEventListener('click', () => {
            this.sheet?.close();
            void this.showPlaylist(item);
          });
          list.append(row);
        });
        body.append(list);
      }
      if (!any) body.append(h('div', { class: 'empty', text: '这两个平台暂时没有歌单' }));
    } catch (err) {
      console.warn('[app] playlists failed', err);
      const body = ref.body;
      if (body) {
        body.textContent = '';
        body.append(h('div', { class: 'empty', text: '歌单读取失败，检查登录状态或稍后重试' }));
      }
    }
  }

  private async showPlaylist(item: LibraryPlaylist): Promise<void> {
    this.setRailActive('playlists');
    this.wall = {
      kind: 'playlist',
      title: item.title,
      subtitle: `${SOURCE_LABEL[item.source]} · ${item.count} 首`,
      tracks: [],
    };
    this.renderWall();
    const special = item.special === 'liked' ? 'liked' : undefined;
    try {
      const detail = await fetchPlaylist(item.source, item.id, 0, 200, special);
      this.wall = {
        ...this.wall,
        title: detail.title || item.title,
        subtitle: `${SOURCE_LABEL[item.source]} · ${detail.tracks.length} 首`,
        tracks: detail.tracks,
      };
      this.renderWall();
    } catch (err) {
      console.warn('[app] playlist failed', err);
      toast('歌单加载失败', 'error');
    }
  }

"""
rep("  private async openDiscover(): Promise<void> {", methods + "  private async openDiscover(): Promise<void> {", "playlist methods")

save(p, text)
print("app.ts OK")
