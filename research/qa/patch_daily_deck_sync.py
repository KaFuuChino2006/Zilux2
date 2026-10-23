import io

path = r'E:\Zilux2开发\web\src\ui\home.ts'
css_path = r'E:\Zilux2开发\web\src\styles\app.css'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


text = load(path)
nl = '\r\n' if '\r\n' in text else '\n'


def sub(name, old, new, count=1):
    global text
    old = old.replace('\n', nl)
    new = new.replace('\n', nl)
    got = text.count(old)
    assert got == count, '%s: expected %d, got %d' % (name, count, got)
    text = text.replace(old, new)


sub(
    'import player',
    "import { h, icon } from './dom';",
    "import { h, icon } from './dom';\nimport { onPlayer, playerState } from './player';",
)

sub(
    'fields',
    "export class HomeView {\n  readonly root: HTMLDivElement;\n\n  constructor(private readonly callbacks: HomeCallbacks) {\n    this.root = h('div', { class: ui.page('home') });\n  }",
    "export class HomeView {\n  readonly root: HTMLDivElement;\n  private deckEl: HTMLDivElement | null = null;\n  private titleEl: HTMLHeadingElement | null = null;\n  private deckKey: string[] = [];\n  private dailyTracks: OnlineTrack[] = [];\n  private readonly playerDispose: () => void;\n\n  constructor(private readonly callbacks: HomeCallbacks) {\n    this.root = h('div', { class: ui.page('home') });\n    this.playerDispose = onPlayer((state) => {\n      this.syncDailyDeck(state.track, true);\n    });\n  }\n\n  dispose(): void {\n    this.playerDispose();\n  }",
)

sub(
    'update store refs',
    "  update(data: HomeData): void {\n    this.root.textContent = '';",
    "  update(data: HomeData): void {\n    this.dailyTracks = data.daily;\n    this.deckEl = null;\n    this.titleEl = null;\n    this.deckKey = [];\n    this.root.textContent = '';",
)

sub(
    'update sync deck',
    "    const playlists = this.buildPlaylistSection(data);\n    if (playlists) this.root.append(playlists);\n  }",
    "    const playlists = this.buildPlaylistSection(data);\n    if (playlists) this.root.append(playlists);\n\n    this.syncDailyDeck(playerState().track, false);\n  }",
)

sub(
    'deck ref + title ref',
    "    const covers = data.daily.slice(0, 5);\n    const deck = h('div', { class: 'daily-deck' });",
    "    const covers = data.daily.slice(0, 5);\n    const deck = h('div', { class: 'daily-deck' });\n    this.deckEl = deck;",
)

sub(
    'play buttons',
    "            const play = h('button', { class: 'daily-play', title: `播放今日推荐：${track.title}` }, icon('play', 18));\n            play.addEventListener('click', (event) => {\n              event.stopPropagation();\n              this.callbacks.onPlay(data.daily, 0);\n            });\n            layer.append(play);\n            layer.addEventListener('click', () => this.callbacks.onPlay(data.daily, 0));",
    "            const play = h('button', { class: 'daily-play', title: `播放今日推荐：${track.title}` }, icon('play', 18));\n            play.addEventListener('click', (event) => {\n              event.stopPropagation();\n              this.playTopTrack();\n            });\n            layer.append(play);\n            layer.addEventListener('click', () => this.playTopTrack());",
)

sub(
    'title element ref',
    "        h('h2', { class: 'daily-title', text: title }),",
    "        (this.titleEl = h('h2', { class: 'daily-title', text: title })),",
)

sub(
    'deck sync methods',
    "  /* ------------------------------------------------------------------ */\n  /* 最近播放                                                            */",
    """  /** 叠放顺序：正在播放的今日推荐曲排到最上面，其余顺延。 */
  private dailyOrder(track: OnlineTrack | null): OnlineTrack[] {
    const daily = this.dailyTracks;
    if (!track) return daily.slice(0, 5);
    const index = daily.findIndex((item) => item.source === track.source && item.id === track.id);
    if (index < 0) return daily.slice(0, 5);
    return [...daily.slice(index), ...daily.slice(0, index)].slice(0, 5);
  }

  private playTopTrack(): void {
    const top = this.dailyOrder(playerState().track)[0];
    if (!top) return;
    const index = this.dailyTracks.findIndex((item) => item.source === top.source && item.id === top.id);
    this.callbacks.onPlay(this.dailyTracks, Math.max(0, index));
  }

  /** 切歌时让今日推荐的封面叠放跟着做同样的「滑出 / 推入」过渡。 */
  private syncDailyDeck(track: OnlineTrack | null, animate: boolean): void {
    const deck = this.deckEl;
    if (!deck) return;
    const order = this.dailyOrder(track);
    if (order.length === 0) return;
    const keys = order.map((item) => `${item.source}:${item.id}`);
    const changed = keys.join('|') !== this.deckKey.join('|');
    if (!changed && animate) return;
    const layers = Array.from(deck.querySelectorAll<HTMLDivElement>('.daily-cover')).filter(
      (layer) => !layer.classList.contains('is-ghost'),
    );
    if (layers.length === 0) return;

    const oldTop = layers.find((layer) => layer.classList.contains('daily-cover-0'));
    if (animate && changed && oldTop && this.deckKey.length > 0) {
      const ghost = oldTop.cloneNode(true) as HTMLDivElement;
      ghost.classList.remove('daily-cover-0', 'is-incoming');
      ghost.classList.add('is-ghost');
      deck.append(ghost);
      window.setTimeout(() => ghost.remove(), 640);
    }

    layers.forEach((layer, index) => {
      const item = order[index];
      const image = layer.querySelector('img');
      if (image && item) image.src = onlineArtwork(item);
      layer.classList.toggle('is-empty', !item);
    });

    const newTop = layers.find((layer) => layer.classList.contains('daily-cover-0'));
    if (newTop) {
      if (animate && changed) {
        newTop.classList.remove('is-incoming');
        void newTop.offsetWidth;
        newTop.classList.add('is-incoming');
        window.setTimeout(() => newTop.classList.remove('is-incoming'), 640);
      }
      const play = newTop.querySelector<HTMLButtonElement>('.daily-play');
      if (play && order[0]) play.title = `播放今日推荐：${order[0].title}`;
    }
    if (this.titleEl && order[0]) this.titleEl.textContent = order[0].title;
    this.deckKey = keys;
  }

  /* ------------------------------------------------------------------ */
  /* 最近播放                                                            */""",
)

save(path, text)
print('home.ts daily deck sync patched')

css = load(css_path)
if '.daily-cover.is-incoming' in css:
    print('css already patched')
else:
    nlc = '\r\n' if '\r\n' in css else '\n'
    extra = '''
/* 今日推荐封面：切歌时和播放条同款「滑出 / 推入」 */
.daily-cover.is-incoming { animation: daily-cover-in .46s cubic-bezier(.22, 1, .36, 1) both; }
.daily-cover.is-ghost {
  position: absolute;
  inset: 0;
  z-index: 9;
  pointer-events: none;
  animation: daily-cover-out .46s cubic-bezier(.4, 0, .6, 1) both;
}
@keyframes daily-cover-in {
  from { transform: translateX(52%) scale(.9) rotate(3deg); opacity: 0; }
  to { transform: none; opacity: 1; }
}
@keyframes daily-cover-out {
  from { transform: none; opacity: 1; }
  to { transform: translateX(-58%) scale(.9) rotate(-5deg); opacity: 0; }
}
'''
    save(css_path, css.rstrip() + nlc + extra.replace('\n', nlc))
    print('css patched')
