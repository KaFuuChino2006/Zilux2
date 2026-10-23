import io

home_path = r'E:\Zilux2开发\web\src\ui\home.ts'
app_path = r'E:\Zilux2开发\web\src\ui\app.ts'
css_path = r'E:\Zilux2开发\web\src\styles\app.css'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


# ---------------- home.ts ----------------
home = load(home_path)
nl = '\r\n' if '\r\n' in home else '\n'


def sub_home(name, old, new):
    global home
    old = old.replace('\n', nl)
    new = new.replace('\n', nl)
    assert home.count(old) == 1, '%s: expected 1, got %d' % (name, home.count(old))
    home = home.replace(old, new)


sub_home(
    'HomeData liked',
    """  recent: OnlineTrack[];
  playlists: LibraryPlaylist[];""",
    """  recent: OnlineTrack[];
  /** 我喜欢的音乐里的前几首（用来做叠放卡片） */
  liked: OnlineTrack[];
  playlists: LibraryPlaylist[];""",
)

sub_home(
    'update split row',
    """    const recent = this.buildRecentSection(data);
    if (recent) this.root.append(recent);""",
    """    // 最近播放（左）+ 我喜欢的音乐叠放卡片（右）
    const recent = this.buildRecentSection(data);
    if (recent) {
      const split = h('div', { class: 'home-split' }, recent);
      const liked = this.buildLikedDeck(data);
      if (liked) split.append(liked);
      this.root.append(split);
    }""",
)

sub_home(
    'buildLikedDeck',
    """  /* ------------------------------------------------------------------ */
  /* 推荐歌单                                                            */
  /* ------------------------------------------------------------------ */""",
    """  /* ------------------------------------------------------------------ */
  /* 我喜欢的音乐（与今日推荐同款叠放卡片）                              */
  /* ------------------------------------------------------------------ */

  private buildLikedDeck(data: HomeData): HTMLElement | null {
    if (!data.loggedIn) return null;
    const covers = data.liked.slice(0, 5);
    const deck = h('div', { class: 'daily-deck' });
    if (covers.length > 0) {
      covers
        .map((track, index) => ({ track, index }))
        .reverse()
        .forEach(({ track, index }) => {
          const layer = h('div', { class: `daily-cover daily-cover-${index}`, 'data-layer': String(index) });
          layer.append(h('img', { src: onlineArtwork(track), loading: 'lazy', alt: '' }));
          if (index === 0) {
            const play = h('button', { class: 'daily-play', title: '播放我喜欢的音乐' }, icon('play', 18));
            play.addEventListener('click', (event) => {
              event.stopPropagation();
              this.callbacks.onPlay(data.liked, 0);
            });
            layer.append(play);
            layer.addEventListener('click', () => this.callbacks.onPlay(data.liked, 0));
          }
          deck.append(layer);
        });
    } else {
      deck.append(h('div', { class: 'daily-cover daily-cover-0 is-empty' }, icon('heart', 32)));
    }

    const card = h(
      'div',
      { class: 'daily-card liked-deck' },
      deck,
      h(
        'div',
        { class: 'daily-body' },
        h('div', { class: 'daily-kicker', text: '我喜欢的音乐' }),
        h('div', { class: 'daily-title', text: '我的红心收藏' }),
        h('div', { class: 'daily-meta', text: `共 ${data.likedCount} 首 · 自动同步` }),
        h(
          'div',
          { class: 'daily-actions' },
          (() => {
            const btn = h('button', { class: 'btn is-primary' }, icon('play', 16), h('span', { text: '播放全部' }));
            btn.addEventListener('click', () => this.callbacks.onPlay(data.liked, 0));
            return btn;
          })(),
          (() => {
            const btn = h('button', { class: 'btn' }, h('span', { text: '查看全部' }));
            btn.addEventListener('click', () => this.callbacks.onLiked());
            return btn;
          })(),
        ),
      ),
    );
    return card;
  }

  /* ------------------------------------------------------------------ */
  /* 推荐歌单                                                            */
  /* ------------------------------------------------------------------ */""",
)

save(home_path, home)
print('home liked deck')

# ---------------- app.ts ----------------
app = load(app_path)
nla = '\r\n' if '\r\n' in app else '\n'


def sub_app(name, old, new):
    global app
    old = old.replace('\n', nla)
    new = new.replace('\n', nla)
    assert app.count(old) == 1, '%s: expected 1, got %d' % (name, app.count(old))
    app = app.replace(old, new)


sub_app(
    'loadHomeData liked tracks',
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
    }""",
    """    let likedCount = 0;
    let likedTracks: OnlineTrack[] = [];
    const playlists: LibraryPlaylist[] = [];
    if (loggedIn) {
      try {
        const overview = await fetchLibraryOverview();
        let likedOwner: { source: OnlineSource; id: string } | null = null;
        for (const state of overview.sources) {
          if (state.liked) {
            likedCount += state.liked.count;
            if (!likedOwner || state.source === preferred) likedOwner = { source: state.source as OnlineSource, id: state.liked.id };
          }
        }
        if (likedOwner) {
          try {
            const liked = await fetchPlaylist(likedOwner.source, likedOwner.id, 0, 5, 'liked');
            likedTracks = liked.tracks.slice(0, 5);
          } catch (err) {
            console.warn('[app] home liked tracks failed', err);
          }
        }
      } catch (err) {
        console.warn('[app] home overview failed', err);
      }
    }""",
)

sub_app(
    'home.update liked',
    """      daily,
      recent,
      playlists: playlists.slice(0, 14),""",
    """      daily,
      recent,
      liked: likedTracks,
      playlists: playlists.slice(0, 14),""",
)
save(app_path, app)
print('app liked tracks')

# ---------------- CSS ----------------
css = load(css_path)
nlc = '\r\n' if '\r\n' in css else '\n'
if '.home-split' not in css:
    extra = '''
/* ==================== 首页：最近播放（左）+ 我喜欢的音乐叠放卡片（右） ==================== */
.home-split {
  display: flex;
  align-items: flex-start;
  gap: 18px;
}
.home-split > .section {
  flex: 0 0 min(352px, 42vw);
  min-width: 0;
  margin: 0;
}
.home-split > .liked-deck {
  flex: 1 1 auto;
  min-width: 0;
}
'''
    save(css_path, css.rstrip() + nlc + extra.replace('\n', nlc))
    print('css home-split')
