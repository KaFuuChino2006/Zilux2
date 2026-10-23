# -*- coding: utf-8 -*-
"""「我喜欢的音乐」支持融合显示 / 分平台显示。"""
import io

APP = r'E:\Zilux2开发\web\src\ui\app.ts'
CSS = r'E:\Zilux2开发\web\src\styles\app.css'

text = io.open(APP, 'r', encoding='utf-8', newline='').read()
eol = '\r\n' if '\r\n' in text else '\n'


def rep(old, new, label):
    global text
    old = old.replace('\n', eol)
    new = new.replace('\n', eol)
    assert text.count(old) == 1, 'miss: ' + label
    text = text.replace(old, new)
    print('ok:', label)


rep("  private likedCache = new Map<OnlineSource, OnlineTrack[]>();",
    "  private likedCache = new Map<OnlineSource, OnlineTrack[]>();\n  /** 我喜欢的音乐显示模式：融合（多平台）或单个平台 */\n  private likedMode: 'all' | OnlineSource = 'all';",
    'liked mode field')

# ---- showLiked + loadLiked 整段替换 ----
old_show = """  private async showLiked(source?: OnlineSource): Promise<void> {
    const preferred = source ?? (getAccounts().find((item) => item.loggedIn)?.source as OnlineSource | undefined) ?? 'netease';
    this.setRailActive('liked');
    this.wall = { kind: 'liked', title: '我喜欢的音乐', subtitle: `${SOURCE_LABEL[preferred]} · 同步中…`, tracks: [] };
    this.renderWall();
    await this.loadLiked(preferred);
  }
"""
new_show = """  private async showLiked(mode?: 'all' | OnlineSource): Promise<void> {
    if (mode) this.likedMode = mode;
    this.setRailActive('liked');
    const label = this.likedMode === 'all' ? '多平台融合' : SOURCE_LABEL[this.likedMode];
    this.wall = { kind: 'liked', title: '我喜欢的音乐', subtitle: `${label} · 同步中…`, tracks: [] };
    this.renderWall();
    if (this.likedMode === 'all') await this.loadLikedMerged();
    else await this.loadLiked(this.likedMode);
  }

  /** 用一个平台拉「我喜欢的音乐」（带缓存）。返回 null 表示该平台不可用。 */
  private async fetchLikedTracks(source: OnlineSource): Promise<OnlineTrack[] | null> {
    const cached = this.likedCache.get(source);
    if (cached && cached.length > 0) return cached;
    try {
      const overview = await fetchLibraryOverview();
      const state = overview.sources.find((item) => item.source === source);
      if (!state?.loggedIn || !state.liked) return null;
      const detail = await fetchPlaylist(source, state.liked.id, 0, 200, 'liked');
      this.likedCache.set(source, detail.tracks);
      return detail.tracks;
    } catch (err) {
      console.warn('[app] fetch liked failed', source, err);
      return null;
    }
  }

  /** 融合显示：各登录平台轮流取一首，按平台交错排列。 */
  private async loadLikedMerged(): Promise<void> {
    const sources = getAccounts()
      .filter((item) => item.loggedIn)
      .map((item) => item.source as OnlineSource);
    if (sources.length === 0) {
      this.wall = { kind: 'liked', title: '我喜欢的音乐', subtitle: '登录网易云 / QQ 音乐后自动同步', tracks: [] };
      this.renderWall();
      return;
    }
    const lists = await Promise.all(sources.map((source) => this.fetchLikedTracks(source)));
    const available = sources
      .map((source, index) => ({ source, tracks: lists[index] ?? [] }))
      .filter((item) => item.tracks.length > 0);
    if (available.length === 0) {
      this.wall = { kind: 'liked', title: '我喜欢的音乐', subtitle: '还没有同步到喜欢的歌曲', tracks: [] };
      this.renderWall();
      return;
    }
    const merged: OnlineTrack[] = [];
    const longest = Math.max(...available.map((item) => item.tracks.length));
    for (let index = 0; index < longest; index += 1) {
      for (const item of available) {
        const track = item.tracks[index];
        if (track) merged.push(track);
      }
    }
    const label = available.map((item) => SOURCE_LABEL[item.source]).join(' + ');
    this.wall = {
      kind: 'liked',
      title: '我喜欢的音乐',
      subtitle: `${label} · 融合 · ${merged.length} 首`,
      tracks: merged,
    };
    this.renderWall();
  }
"""
rep(old_show, new_show, 'showLiked merged')

# ---- renderWall 头部：加融合/分平台切换 ----
old_head = """    const head = h(
      'div',
      { class: 'wall-head' },
      h(
        'div',
        {},
        h('h1', { class: 'wall-title', text: title }),
        subtitle ? h('div', { class: 'wall-sub', text: subtitle }) : null,
      ),
      tracks.length > 0
        ? (() => {
            const btn = h('button', { class: 'pill', title: '播放全部' }, icon('play', 16), h('span', { text: '播放全部' }));
            btn.addEventListener('click', () => playQueue(tracks, 0, true));
            return btn;
          })()
        : null,
    );
    this.wallHost.append(head);"""
new_head = """    const actions: HTMLElement[] = [];
    if (this.wall.kind === 'liked') {
      const modes: Array<{ id: 'all' | OnlineSource; label: string }> = [{ id: 'all', label: '融合' }];
      for (const account of getAccounts()) {
        if (!account.loggedIn) continue;
        modes.push({ id: account.source as OnlineSource, label: sourceMeta(account.source).short });
      }
      if (modes.length > 1) {
        const seg = h('div', { class: 'seg seg-sm liked-modes' });
        modes.forEach((mode) => {
          const btn = h('button', {
            class: `seg-btn${this.likedMode === mode.id ? ' is-on' : ''}`,
            text: mode.label,
            title: mode.id === 'all' ? '多平台融合显示' : `${sourceMeta(mode.id).label} 的喜欢`,
          });
          btn.addEventListener('click', () => {
            if (this.likedMode === mode.id) return;
            void this.showLiked(mode.id);
          });
          seg.append(btn);
        });
        actions.push(seg);
      }
    }
    if (tracks.length > 0) {
      const btn = h('button', { class: 'pill', title: '播放全部' }, icon('play', 16), h('span', { text: '播放全部' }));
      btn.addEventListener('click', () => playQueue(tracks, 0, true));
      actions.push(btn);
    }
    const head = h(
      'div',
      { class: 'wall-head' },
      h(
        'div',
        {},
        h('h1', { class: 'wall-title', text: title }),
        subtitle ? h('div', { class: 'wall-sub', text: subtitle }) : null,
      ),
      actions.length > 0 ? h('div', { class: 'wall-head-actions' }, ...actions) : null,
    );
    this.wallHost.append(head);"""
rep(old_head, new_head, 'wall head actions')

# ---- 融合模式下海报显示平台角标 ----
rep("        this.wall.kind === 'search'\n          ? h('div', {",
    "        this.wall.kind === 'search' || (this.wall.kind === 'liked' && this.likedMode === 'all')\n          ? h('div', {",
    'poster source tag in merged liked')

io.open(APP, 'w', encoding='utf-8', newline='').write(text)
print('app.ts written')

css = io.open(CSS, 'r', encoding='utf-8', newline='').read()
ceol = '\r\n' if '\r\n' in css else '\n'
block = """
/* 我喜欢的音乐：融合 / 分平台切换 */
.wall-head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.seg-sm {
  padding: 2px;
}
.seg-sm .seg-btn {
  padding: 5px 12px;
  font-size: 12px;
}
""".replace('\n', ceol)
if '我喜欢的音乐：融合 / 分平台切换' not in css:
    css += block
    io.open(CSS, 'w', encoding='utf-8', newline='').write(css)
    print('css appended')
else:
    print('css exists')
print('done')
