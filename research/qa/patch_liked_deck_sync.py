# -*- coding: utf-8 -*-
"""我喜欢的音乐叠放卡片：切歌时也做封面滑出/推入（与今日推荐一致）。"""
import io

HOME = r'E:\Zilux2开发\web\src\ui\home.ts'
text = io.open(HOME, 'r', encoding='utf-8', newline='').read()
eol = '\r\n' if '\r\n' in text else '\n'


def rep(old, new, label):
    global text
    old = old.replace('\n', eol)
    new = new.replace('\n', eol)
    assert text.count(old) == 1, 'anchor miss: ' + label
    text = text.replace(old, new)
    print('ok:', label)


# 1) 字段
rep(
    "  private deckKey: string[] = [];\n  private dailyTracks: OnlineTrack[] = [];",
    "  private deckKey: string[] = [];\n  private dailyTracks: OnlineTrack[] = [];\n"
    "  private likedDeckEl: HTMLDivElement | null = null;\n"
    "  private likedKey: string[] = [];\n"
    "  private likedTracks: OnlineTrack[] = [];",
    'fields',
)

# 2) 播放器回调里同步喜欢卡片
rep(
    "      this.syncDailyDeck(state.track, true);\n    });",
    "      this.syncDailyDeck(state.track, true);\n      this.syncLikedDeck(state.track, true);\n    });",
    'player hook',
)

# 3) update()：重置 + 保存喜欢列表
rep(
    "    this.dailyTracks = data.daily;\n    this.deckEl = null;\n    this.titleEl = null;\n    this.deckKey = [];",
    "    this.dailyTracks = data.daily;\n    this.deckEl = null;\n    this.titleEl = null;\n    this.deckKey = [];\n"
    "    this.likedTracks = data.liked;\n    this.likedDeckEl = null;\n    this.likedKey = [];",
    'update reset',
)
rep(
    "    this.syncDailyDeck(playerState().track, false);\n  }",
    "    this.syncDailyDeck(playerState().track, false);\n    this.syncLikedDeck(playerState().track, false);\n  }",
    'update sync',
)

# 4) buildLikedDeck 记录叠放容器
rep(
    "    const covers = data.liked.slice(0, 5);\n    const deck = h('div', { class: 'daily-deck' });",
    "    const covers = data.liked.slice(0, 5);\n    const deck = h('div', { class: 'daily-deck' });\n    this.likedDeckEl = deck;",
    'liked deck ref',
)

# 5) 新增 syncLikedDeck（放在 syncDailyDeck 结束之后、最近播放段之前）
anchor = """  /* ------------------------------------------------------------------ */
  /* 最近播放                                                            */"""
addition = """  /** 切歌时让我喜欢的音乐叠放卡片也做「滑出 / 推入」过渡。 */
  private syncLikedDeck(track: OnlineTrack | null, animate: boolean): void {
    const deck = this.likedDeckEl;
    if (!deck) return;
    const liked = this.likedTracks;
    let order: OnlineTrack[];
    if (!track) {
      order = liked.slice(0, 5);
    } else {
      const index = liked.findIndex((item) => item.source === track.source && item.id === track.id);
      order = index < 0 ? liked.slice(0, 5) : [...liked.slice(index), ...liked.slice(0, index)].slice(0, 5);
    }
    if (order.length === 0) return;
    const keys = order.map((item) => `${item.source}:${item.id}`);
    const changed = keys.join('|') !== this.likedKey.join('|');
    if (!changed && animate) return;
    const layerIndex = (layer: HTMLDivElement): number => {
      const matched = /daily-cover-(\\d+)/.exec(layer.className);
      return matched ? Number(matched[1]) : 99;
    };
    const layers = Array.from(deck.querySelectorAll<HTMLDivElement>('.daily-cover'))
      .filter((layer) => !layer.classList.contains('is-ghost'))
      .sort((a, b) => layerIndex(a) - layerIndex(b));
    if (layers.length === 0) return;

    const oldTop = layers.find((layer) => layer.classList.contains('daily-cover-0'));
    if (animate && changed && oldTop && this.likedKey.length > 0) {
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
      if (play && order[0]) play.title = `播放我喜欢的音乐：${order[0].title}`;
    }
    this.likedKey = keys;
  }

  /* ------------------------------------------------------------------ */
  /* 最近播放                                                            */"""
rep(anchor, addition, 'syncLikedDeck method')

io.open(HOME, 'w', encoding='utf-8', newline='').write(text)
print('done')
