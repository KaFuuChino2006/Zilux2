/**
 * 首页（基础播放页）：最近播放 + 推荐歌单（导航入口统一放在左侧 rail）。
 *
 * 样式全部走 `theme.ts` 的 `ui.*` 组件接口与语义令牌，换主题时页面代码不变。
 */

import type { LibraryPlaylist } from '../core/library';
import { SOURCE_LABEL, type OnlineSource, type OnlineTrack } from '../online/types';
import { onlineArtwork } from '../online/artwork';
import { h, icon } from './dom';
import { onPlayer, playerState } from './player';
import { ui } from './theme';

/** 热门歌单的播放次数：12345 → 1.2 万次播放。 */
function formatPlays(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '歌单';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿次播放`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万次播放`;
  return `${Math.round(value)} 次播放`;
}

export type PlayScope = 'daily' | 'recent' | 'liked';

export interface HomeCallbacks {
  onLogin(): void;
  onLiked(source?: OnlineSource): void;
  onPlayLiked(source?: OnlineSource): void;
  onRecent(): void;
  onRecommend(): void;
  onDaily(): void;
  onDaily30(): void;
  onSearch(): void;
  onPlay(tracks: OnlineTrack[], index: number, scope: PlayScope): void;
  onPlaylist(item: LibraryPlaylist): void;
}

export interface HomeCollection {
  source: OnlineSource;
  /** 「网易云收藏」/「QQ 音乐收藏」 */
  label: string;
  /** 卡片上的小标签，如「网易云音乐 · 我喜欢的音乐」 */
  kicker: string;
  loggedIn: boolean;
  count: number;
  /** 用来做叠放封面的前几首 */
  tracks: OnlineTrack[];
}

export interface HomeData {
  loggedIn: boolean;
  localCount: number;
  /** 各平台「我喜欢的音乐」卡片（左 + 中） */
  collections: HomeCollection[];
  /** 今日推荐（每日推荐）的曲目与来源 */
  dailySource: string;
  dailyDate: string;
  dailyLoading: boolean;
  daily: OnlineTrack[];
  recent: OnlineTrack[];
  playlists: LibraryPlaylist[];
  /** 网易云热门歌单（第二块） */
  neteasePlaylists: LibraryPlaylist[];
}

export class HomeView {
  readonly root: HTMLDivElement;
  private deckEl: HTMLDivElement | null = null;
  private titleEl: HTMLHeadingElement | null = null;
  private deckKey: string[] = [];
  private dailyTracks: OnlineTrack[] = [];
  private likedDeckEl: HTMLDivElement | null = null;
  private likedKey: string[] = [];
  private likedTracks: OnlineTrack[] = [];
  private recentStrip: HTMLDivElement | null = null;
  private recentTracks: OnlineTrack[] = [];
  private recentShown = 0;
  private recentBound = false;
  private readonly playerDispose: () => void;

  constructor(private readonly callbacks: HomeCallbacks) {
    this.root = h('div', { class: ui.page('home') });
    this.playerDispose = onPlayer((state) => {
      this.syncDailyDeck(state.track, true);
      this.syncLikedDeck(state.track, true);
    });
  }

  dispose(): void {
    this.playerDispose();
  }

  update(data: HomeData): void {
    this.dailyTracks = data.daily;
    this.deckEl = null;
    this.titleEl = null;
    this.deckKey = [];
    this.likedTracks = data.collections.flatMap((item) => item.tracks).slice(0, 5);
    this.likedDeckEl = null;
    this.likedKey = [];
    this.recentStrip = null;
    this.recentTracks = [];
    this.recentShown = 0;
    this.recentBound = false;
    this.root.textContent = '';
    this.root.append(this.buildDaily(data));

    const recentSection = this.buildRecentSection(data);
    const collectionCards = data.collections
      .map((item) => this.buildCollectionCard(item))
      .filter((item): item is HTMLElement => item !== null);
    const collections = h('div', { class: 'home-collections' });
    collections.append(...collectionCards);
    if (collectionCards.length > 0 || recentSection) {
      const row = h('div', { class: 'home-row' });
      // 左 + 中给两个平台收藏，最近播放收窄后放最右侧
      if (collectionCards.length > 0) row.append(collections);
      if (recentSection) row.append(recentSection);
      this.root.append(row);
    }
    this.bindRecentScroll();

    // 左中：网易云收藏 / QQ 音乐收藏；右侧：最近播放（窄栏，内部滚动）。下面热门歌单。

    const playlists = this.buildPlaylistSection(data.playlists, '热门歌单', true);
    if (playlists) this.root.append(playlists);

    const neteasePlaylists = this.buildPlaylistSection(data.neteasePlaylists, '网易云热门歌单', false);
    if (neteasePlaylists) this.root.append(neteasePlaylists);

    this.syncDailyDeck(playerState().track, false);
    this.syncLikedDeck(playerState().track, false);
  }

  /* ------------------------------------------------------------------ */
  /* 今日推荐（单卡片：封面叠放在后面，悬停封面左下角出播放按钮）         */
  /* ------------------------------------------------------------------ */

  private buildDaily(data: HomeData): HTMLElement {
    const sourceLabel = SOURCE_LABEL[data.dailySource] ?? data.dailySource;
    const covers = data.daily.slice(0, 5);
    const deck = h('div', { class: 'daily-deck' });
    this.deckEl = deck;

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
              this.playTopTrack();
            });
            layer.append(play);
            layer.addEventListener('click', () => this.playTopTrack());
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
      playAll.addEventListener('click', () => this.callbacks.onPlay(data.daily, 0, 'daily'));
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
        (this.titleEl = h('h2', { class: 'daily-title', text: title })),
        h('div', { class: 'daily-meta', text: meta }),
        actions,
      ),
    );

    return h('section', { class: ui.section('home-daily') }, card);
  }

  /** 叠放顺序：正在播放的今日推荐曲排到最上面，其余顺延。 */
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
    this.callbacks.onPlay(this.dailyTracks, Math.max(0, index), 'daily');
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
    // 注意：DOM 里的叠放层是倒序插入的，必须按 .daily-cover-N 的序号排序，
    // 否则会把最底层的图当成最上面一层，出现「封面和正在播放的歌对不上」。
    const layerIndex = (layer: HTMLDivElement): number => {
      const matched = /daily-cover-(\d+)/.exec(layer.className);
      return matched ? Number(matched[1]) : 99;
    };
    const layers = Array.from(deck.querySelectorAll<HTMLDivElement>('.daily-cover'))
      .filter((layer) => !layer.classList.contains('is-ghost'))
      .sort((a, b) => layerIndex(a) - layerIndex(b));
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

  /** 切歌时让我喜欢的音乐叠放卡片也做「滑出 / 推入」过渡。 */
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
      const matched = /daily-cover-(\d+)/.exec(layer.className);
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
  /* 最近播放                                                            */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* 我喜欢的音乐（与今日推荐同款叠放卡片）                              */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* 推荐歌单                                                            */
  /* ------------------------------------------------------------------ */

  private buildRecentSection(data: HomeData): HTMLElement | null {
    const items = data.recent;
    if (items.length === 0) return null;
    this.recentTracks = items;
    this.recentShown = Math.min(10, items.length);

    const section = h('section', { class: `${ui.section()} home-recent` });
    const head = h(
      'div',
      { class: ui.sectionHead() },
      h('h2', { class: ui.sectionTitle(), text: '最近播放' }),
    );
    const more = h('button', { class: ui.sectionMore() }, h('span', { text: '查看全部' }));
    more.addEventListener('click', () => this.callbacks.onRecent());
    head.append(more);

    const strip = h('div', { class: 'recent-strip' });
    this.recentStrip = strip;
    this.appendRecentRows(this.recentShown);

    section.append(head, strip);
    return section;
  }

  private appendRecentRows(count: number): void {
    const strip = this.recentStrip;
    if (!strip) return;
    const start = strip.childElementCount;
    const end = Math.min(this.recentTracks.length, start + count);
    for (let index = start; index < end; index += 1) {
      const track = this.recentTracks[index];
      const row = h(
        'button',
        { class: 'recent-item', type: 'button', title: `${track.title} - ${track.artist}` },
        h('img', { class: 'recent-thumb', src: track.cover || onlineArtwork(track), alt: '', loading: 'lazy' }),
        h('span', { class: 'recent-name', text: track.title }),
        h('span', { class: 'recent-artist', text: track.artist }),
      );
      row.addEventListener('click', () => this.callbacks.onPlay(this.recentTracks, index, 'recent'));
      strip.append(row);
    }
    this.recentShown = end;
  }

  private growRecent(): void {
    if (this.recentShown >= this.recentTracks.length) return;
    this.appendRecentRows(10);
  }

  private bindRecentScroll(): void {
    if (this.recentBound) return;
    this.recentBound = true;
    const handler = (event: Event): void => {
      const el = event.currentTarget as HTMLElement | null;
      if (!el) return;
      if (el.scrollTop + el.clientHeight < el.scrollHeight - 120) return;
      this.growRecent();
    };
    if (this.recentStrip) {
      this.recentStrip.addEventListener('scroll', handler);
      return;
    }
    this.root.addEventListener('scroll', handler);
  }

  private buildCollectionCard(item: HomeCollection): HTMLElement | null {
    if (!item.loggedIn && item.count <= 0) return null;
    const covers = item.tracks.slice(0, 5);
    const deck = h('div', { class: 'daily-deck' });

    if (covers.length > 0) {
      covers
        .map((track, index) => ({ track, index }))
        .reverse()
        .forEach(({ track, index }) => {
          const layer = h('div', { class: `daily-cover daily-cover-${index}` });
          layer.append(h('img', { src: track.cover || onlineArtwork(track), loading: 'lazy', alt: '' }));
          if (index === 0) {
            const play = h('button', { class: 'daily-play', type: 'button', title: `播放${item.label}` }, icon('play', 18));
            play.addEventListener('click', (event) => {
              event.stopPropagation();
              this.callbacks.onLiked(item.source);
            });
            layer.append(play);
            layer.addEventListener('click', () => this.callbacks.onLiked(item.source));
          }
          deck.append(layer);
        });
    } else {
      deck.append(h('div', { class: 'daily-cover daily-cover-0 is-empty' }, icon('heart', 32)));
    }

    const actions = h('div', { class: 'daily-actions' });
    const playAll = h('button', { class: ui.btn({ variant: 'primary' }) }, icon('play', 16), h('span', { text: '播放全部' }));
    playAll.addEventListener('click', () => this.callbacks.onPlayLiked(item.source));
    const more = h('button', { class: ui.btn({ variant: 'ghost' }) }, h('span', { text: '查看全部' }));
    more.addEventListener('click', () => this.callbacks.onLiked(item.source));
    actions.append(playAll, more);

    const card = h(
      'div',
      { class: 'daily-card' },
      deck,
      h(
        'div',
        { class: 'daily-body' },
        h('div', { class: 'daily-kicker' }, icon('heart', 13), h('span', { text: item.kicker })),
        h('h2', { class: 'daily-title', text: item.label }),
        h('div', { class: 'daily-meta', text: item.count > 0 ? `共 ${item.count} 首 · 自动同步` : '登录后自动同步' }),
        actions,
      ),
    );

    return h('section', { class: ui.section('home-liked') }, card);
  }

  private buildPlaylistSection(items: LibraryPlaylist[], title: string, withMore: boolean): HTMLElement | null {
    if (items.length === 0) return null;
    const section = h('section', { class: ui.section() });
    const head = h(
      'div',
      { class: ui.sectionHead() },
      h('h2', { class: ui.sectionTitle(), text: title }),
    );
    if (withMore) {
      const more = h('button', { class: ui.sectionMore() }, h('span', { text: '全部歌单' }));
      more.addEventListener('click', () => this.callbacks.onRecommend());
      head.append(more);
    }

    const scroller = h('div', { class: ui.scroller() });
    // 鼠标滚轮竖向滚动时，把横向歌单平滑滚起来（rAF 缓动，不直接位移）
    let target = scroller.scrollLeft;
    let raf = 0;
    const maxScroll = (): number => Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const step = (): void => {
      const max = maxScroll();
      if (target > max) target = max;
      if (target < 0) target = 0;
      const distance = target - scroller.scrollLeft;
      if (Math.abs(distance) < 0.6) {
        scroller.scrollLeft = target;
        raf = 0;
        return;
      }
      scroller.scrollLeft += distance * 0.22;
      raf = window.requestAnimationFrame(step);
    };
    const kick = (): void => {
      if (raf === 0) raf = window.requestAnimationFrame(step);
    };
    scroller.addEventListener(
      'wheel',
      (event) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        const max = maxScroll();
        if (max <= 0) return;
        event.preventDefault();
        target = Math.max(0, Math.min(max, target + event.deltaY * 1.35));
        kick();
      },
      { passive: false },
    );
    scroller.addEventListener(
      'pointerdown',
      () => {
        target = scroller.scrollLeft;
        if (raf !== 0) {
          window.cancelAnimationFrame(raf);
          raf = 0;
        }
      },
      { passive: true },
    );
    items.forEach((item) => {
      const cover =
        item.cover ??
        onlineArtwork({ id: item.id, title: item.title, artist: item.creator ?? '', album: '', cover: '' });
      const tile = h(
        'button',
        { class: ui.tile(), title: item.title },
        h('span', { class: ui.tileCover() }, h('img', { src: cover, loading: 'lazy', alt: '' })),
        h('span', { class: ui.tileName(), text: item.title }),
        h('span', { class: ui.tileMeta(), text: `${SOURCE_LABEL[item.source] ?? ''} · ${formatPlays(item.count)}` }),
      );
      tile.addEventListener('click', () => this.callbacks.onPlaylist(item));
      scroller.append(tile);
    });
    section.append(head, scroller);
    return section;
  }
}
