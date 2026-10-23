import io

app_path = r'E:\Zilux2开发\web\src\ui\app.ts'
css_path = r'E:\Zilux2开发\web\src\styles\app.css'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def sub(text, name, old, new, nl):
    old = old.replace('\n', nl)
    new = new.replace('\n', nl)
    got = text.count(old)
    assert got == 1, '%s: expected 1, got %d' % (name, got)
    return text.replace(old, new)


app = load(app_path)
nl = '\r\n' if '\r\n' in app else '\n'

# 1) import fetchHotPlaylists
app = sub(
    app,
    'import hot playlists',
    """import {
  addLikedTrack,
  checkLikedMany,
  fetchFeed,
  onlineReady,
  removeLikedTrack,
  searchOnline,
} from '../online/client';""",
    """import {
  addLikedTrack,
  checkLikedMany,
  fetchFeed,
  fetchHotPlaylists,
  onlineReady,
  removeLikedTrack,
  searchOnline,
} from '../online/client';""",
    nl,
)

# 2) 首页热门歌单数据源
app = sub(
    app,
    'loadHomeData playlists',
    """    let likedCount = 0;
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
    }""",
    """    let likedCount = 0;
    const playlists: LibraryPlaylist[] = [];
    if (loggedIn) {
      try {
        const overview = await fetchLibraryOverview();
        for (const state of overview.sources) {
          if (state.liked) likedCount += state.liked.count;
        }
      } catch (err) {
        console.warn('[app] home overview failed', err);
      }
    }
    try {
      const hot = await fetchHotPlaylists('qq', 14);
      playlists.push(
        ...hot.map((item) => ({
          source: item.source,
          id: item.id,
          title: item.title,
          cover: item.cover,
          count: item.count,
          creator: item.creator,
        })),
      );
    } catch (err) {
      console.warn('[app] hot playlists failed', err);
    }""",
    nl,
)

# 3) 推荐弹层 -> QQ 音乐馆热门歌单
app = sub(
    app,
    'recommend sheet',
    """  private async openRecommendSheet(): Promise<void> {
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
  }""",
    """  private async openRecommendSheet(): Promise<void> {
    const ref: { body: HTMLDivElement | null } = { body: null };
    this.openSheet('热门歌单', (body) => {
      ref.body = body;
      body.append(h('div', { class: 'empty', text: '加载 QQ 音乐热门歌单…' }));
    });
    try {
      const hot = await fetchHotPlaylists('qq', 40);
      const body = ref.body;
      if (!body) return;
      body.textContent = '';
      if (hot.length === 0) {
        body.append(h('div', { class: 'empty', text: '暂时拿不到热门歌单，稍后重试' }));
        return;
      }
      body.append(h('h3', { class: 'section-title', text: `QQ 音乐 · 音乐馆热门歌单 · ${hot.length} 个` }));
      const list = h('div', { class: 'list' });
      hot.forEach((item) => {
        const cover =
          item.cover ||
          onlineArtwork({ id: item.id, title: item.title, artist: item.creator ?? '', album: '', cover: '' });
        const row = h(
          'div',
          { class: 'row', title: item.title },
          h('div', { class: 'row-cover' }, h('img', { src: cover, loading: 'lazy', alt: '' })),
          h(
            'div',
            { class: 'row-meta' },
            h('div', { class: 'row-name', text: item.title }),
            h('div', { class: 'row-artist', text: `${item.creator ? item.creator + ' · ' : ''}${item.count} 次播放` }),
          ),
        );
        row.addEventListener('click', () => {
          this.sheet?.close();
          void this.showPlaylist({
            source: item.source,
            id: item.id,
            title: item.title,
            cover: item.cover,
            count: item.count,
            creator: item.creator,
          });
        });
        list.append(row);
      });
      body.append(list);
    } catch (err) {
      console.warn('[app] recommend failed', err);
      const body = ref.body;
      if (body) {
        body.textContent = '';
        body.append(h('div', { class: 'empty', text: '热门歌单读取失败，稍后重试' }));
      }
    }
  }""",
    nl,
)

save(app_path, app)
print('app.ts hot playlists wired')
