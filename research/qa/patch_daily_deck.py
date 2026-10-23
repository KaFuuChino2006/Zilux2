import io

path = r'E:\Zilux2开发\web\src\ui\home.ts'
with io.open(path, 'r', encoding='utf-8', newline='') as f:
    text = f.read()

nl = '\r\n' if '\r\n' in text else '\n'

start_marker = '  /* ------------------------------------------------------------------ */' + nl + '  /* 今日推荐（首页首屏）'
end_marker = '  /* ------------------------------------------------------------------ */' + nl + '  /* 最近播放'

start = text.find(start_marker)
end = text.find(end_marker, start)
assert start > 0, 'daily section start not found'
assert end > start, 'daily section end not found'

new_section = '''  /* ------------------------------------------------------------------ */
  /* 今日推荐（单卡片：封面叠放在后面，悬停封面左下角出播放按钮）         */
  /* ------------------------------------------------------------------ */

  private buildDaily(data: HomeData): HTMLElement {
    const sourceLabel = SOURCE_LABEL[data.dailySource] ?? data.dailySource;
    const covers = data.daily.slice(0, 5);
    const deck = h('div', { class: 'daily-deck' });

    if (covers.length > 0) {
      // 反向渲染：index 越大越靠后（z-index 由 CSS 决定），最上面一层带播放按钮。
      covers
        .map((track, index) => ({ track, index }))
        .reverse()
        .forEach(({ track, index }) => {
          const layer = h('div', { class: `daily-cover daily-cover-${index}`, 'data-layer': String(index) });
          layer.append(h('img', { src: onlineArtwork(track), loading: 'lazy', alt: '' }));
          if (index === 0) {
            const play = h('button', { class: 'daily-play', title: `播放今日推荐：${track.title}` }, icon('play', 18));
            play.addEventListener('click', (event) => {
              event.stopPropagation();
              this.callbacks.onPlay(data.daily, 0);
            });
            layer.append(play);
            layer.addEventListener('click', () => this.callbacks.onPlay(data.daily, 0));
          }
          deck.append(layer);
        });
    } else {
      deck.append(h('div', { class: 'daily-cover daily-cover-0 is-empty' }, icon('music', 34)));
    }

    let title: string;
    if (!data.loggedIn) {
      title = '登录后每天都有推荐';
    } else if (data.daily.length === 0) {
      title = data.dailyLoading ? '今日推荐加载中…' : '今天还没有推荐，稍后再来看看';
    } else {
      title = covers[0]?.title ?? '今日推荐';
    }
    const meta = data.loggedIn
      ? `${sourceLabel} · ${data.dailyDate}` + (data.daily.length > 0 ? ` · 共 ${data.daily.length} 首` : '')
      : '登录网易云 / QQ 音乐，同步每日推荐';

    const actions = h('div', { class: 'daily-actions' });
    if (!data.loggedIn) {
      const login = h('button', { class: ui.btn({ variant: 'primary' }) }, icon('user', 16), h('span', { text: '登录' }));
      login.addEventListener('click', () => this.callbacks.onLogin());
      actions.append(login);
    } else if (data.daily.length > 0) {
      const playAll = h('button', { class: ui.btn({ variant: 'primary' }) }, icon('play', 16), h('span', { text: '播放全部' }));
      playAll.addEventListener('click', () => this.callbacks.onPlay(data.daily, 0));
      const more = h('button', { class: ui.btn({ variant: 'ghost' }) }, h('span', { text: '查看全部' }));
      more.addEventListener('click', () => this.callbacks.onDaily());
      actions.append(playAll, more);
    }

    const card = h(
      'div',
      { class: `daily-card${covers.length > 0 ? '' : ' is-empty'}` },
      deck,
      h(
        'div',
        { class: 'daily-body' },
        h('div', { class: 'daily-kicker' }, icon('sparkle', 13), h('span', { text: '今日推荐' })),
        h('h2', { class: 'daily-title', text: title }),
        h('div', { class: 'daily-meta', text: meta }),
        actions,
      ),
    );

    return h('section', { class: ui.section('home-daily') }, card);
  }

'''

text = text[:start] + new_section.replace('\n', nl) + text[end:]

with io.open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(text)

print('home.ts buildDaily replaced, newline=%r' % nl)
