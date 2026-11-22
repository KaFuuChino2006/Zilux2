/**
 * 首页（基础播放页）：最近播放 + 推荐歌单（导航入口统一放在左侧 rail）。
 *
 * 样式全部走 `theme.ts` 的 `ui.*` 组件接口与语义令牌，换主题时页面代码不变。
 */

import type { LibraryPlaylist } from '../core/library';
import { SOURCE_LABEL, type OnlineSource, type OnlineTrack } from '../online/types';
import { fetchCats, fetchCharts, fetchPlaylists } from '../online/discover';
import { onlineArtwork } from '../online/artwork';
import { h, icon } from './dom';
import { BlockEntrance } from './blockEntrance';
import { MOTION, prefersReducedMotion } from './motion';
import { onPlayer, playerState } from './player';
import { ui } from './theme';
import { enableWheelScroll } from './wheelScroll';

/* 首页逐块运动：可变体、可打断的入场 / 出场统一交给 BlockEntrance，这里只定选择器。 */
/** 逐块目标：今日推荐卡 / 最近播放行 / 歌单封面（区块标题单独走轻量款）。 */
const HOME_ITEMS = '.daily-card, .recent-item, .ui-tile';
const HOME_HEADS = '.ui-section-head';
/** 首页的大字：区块标题 + 今日推荐那行大标题，逐字上浮显影。 */
const HOME_TITLES = '.ui-section-title, .daily-title';
/** 推荐行换 tab 时，面板内逐块运动的目标（和首页整页同一款引擎，范围缩到这一行）。 */
const PROVIDER_ITEMS = '.daily-card, .ui-tile, .home-cat-picker';

/** 热门歌单的播放次数：12345 → 1.2 万次播放。 */
function formatPlays(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '歌单';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿次播放`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万次播放`;
  return `${Math.round(value)} 次播放`;
}

export type PlayScope = 'daily' | 'recent' | 'liked' | 'radar' | 'special';

/**
 * 首页「推荐」行里的专属内容：
 * 网易云 —— 私人漫游（原私人 FM）、相似歌曲；
 * QQ 音乐 —— 猜你喜欢（私人 FM）、百万收藏、新歌推荐。
 */
export type HomeSpecialKind = 'netNew' | 'roam' | 'similar' | 'guess' | 'million' | 'newsong';

export interface HomeCallbacks {
  onLogin(): void;
  onLiked(source?: OnlineSource): void;
  onPlayLiked(source?: OnlineSource): void;
  /** 网易云「心动模式」：用我喜欢的音乐 + 当前歌曲取智能续播队列。 */
  onHeartbeat(source: OnlineSource): void;
  onRecent(): void;
  onRecommend(): void;
  onDaily(): void;
  /** 选择「今日推荐」融合哪些平台。 */
  onDailyFilter(anchor: HTMLElement): void;
  onDaily30(): void;
  onRadar(): void;
  /** 打开首页推荐行里的整页歌单（网易云私人漫游 / 相似歌曲、QQ 猜你喜欢 / 百万收藏 / 新歌推荐）。 */
  onSpecial(kind: HomeSpecialKind): void;
  onSearch(): void;
  onChart(source: string, id: string): void;
  onArtistSearch(name: string): void;
  onPlay(tracks: OnlineTrack[], index: number, scope: PlayScope, specialKind?: HomeSpecialKind): void;
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
  /** 私人雷达（网易云按账号每日生成；展示在今日推荐右侧） */
  radarAvailable: boolean;
  radarLoading: boolean;
  radar: OnlineTrack[];
  recent: OnlineTrack[];
  playlists: LibraryPlaylist[];
  /** 网易云热门歌单（第二块） */
  neteasePlaylists: LibraryPlaylist[];
  /** 每日推荐歌单（网易云 + QQ 交错，排在热门歌单之前） */
  recommendPlaylists: LibraryPlaylist[];
  /** 推荐行：网易云私人漫游 / 相似歌曲 + QQ 猜你喜欢 / 百万收藏 / 新歌推荐（没登录的平台不出卡）。 */
  specials: HomeSpecial[];
}

export interface HomeSpecial {
  kind: HomeSpecialKind;
  /** 这条内容属于哪个平台：卡片的区块标题按它分组 */
  source: OnlineSource;
  /** 「私人漫游」/「相似歌曲」/「猜你喜欢」/「百万收藏」/「新歌推荐」 */
  label: string;
  /** 卡片上的小标签，如「QQ 音乐 · 私人 FM」 */
  kicker: string;
  meta: string;
  tracks: OnlineTrack[];
}

export class HomeView {
  readonly root: HTMLDivElement;
  private deckEl: HTMLDivElement | null = null;
  private titleEl: HTMLHeadingElement | null = null;
  private deckKey: string[] = [];
  private dailyTracks: OnlineTrack[] = [];
  private radarTracks: OnlineTrack[] = [];
  private likedDeckEl: HTMLDivElement | null = null;
  private likedKey: string[] = [];
  private likedTracks: OnlineTrack[] = [];
  private recentStrip: HTMLDivElement | null = null;
  private recentTracks: OnlineTrack[] = [];
  private recentShown = 0;
  private recentBound = false;
  private selectedTabs = { netease: 0, qq: 0 };
  /** 逐块入场 / 出场 / 打断。 */
  private readonly entrance: BlockEntrance;
  /** 每个推荐行面板自己的逐块运动器：换 tab 时新旧各自开演，规则与整页那套完全相同。 */
  private readonly panelMotions = new WeakMap<HTMLElement, BlockEntrance>();
  private readonly playerDispose: () => void;

  constructor(private readonly callbacks: HomeCallbacks) {
    this.root = h('div', { class: ui.page('home') });
    this.entrance = new BlockEntrance(this.root, { items: HOME_ITEMS, heads: HOME_HEADS, titles: HOME_TITLES });
    this.playerDispose = onPlayer((state) => {
      this.syncDailyDeck(state.track, true);
      this.syncLikedDeck(state.track, true);
    });
  }

  dispose(): void {
    this.playerDispose();
    this.entrance.dispose();
  }

  /**
   * 整页重建。
   * `options.animate === false` 用于「后台数据补上了」这种静默刷新：只换内容，
   * 不重放入场——否则用户正看着的页面会突然整屏重置一次。
   */
  update(data: HomeData, options: { animate?: boolean } = {}): void {
    this.dailyTracks = data.daily;
    this.radarTracks = data.radar;
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

    // 推荐行（网易云私人漫游 / 相似歌曲 + QQ 猜你喜欢 / 百万收藏 / 新歌推荐）：
    // 按平台各排一行，有数据才出，卡片沿用收藏卡的放大样式。
    for (const source of ['netease', 'qq'] as const) {
      this.root.append(this.buildProviderSection(source, data));
    }
    for (const section of this.buildSpecialSections(data.specials.filter(item => item.source === 'kugou'))) this.root.append(section);

    // 左中：各平台收藏；右侧：最近播放（窄栏，内部滚动）。下面每日推荐、热门歌单。

    const recommendPlaylists = this.buildPlaylistSection(data.recommendPlaylists, '每日推荐歌单', true);
    if (recommendPlaylists) this.root.append(recommendPlaylists);

    const playlists = this.buildPlaylistSection(data.playlists, '热门歌单', true);
    if (playlists) this.root.append(playlists);

    const neteasePlaylists = this.buildPlaylistSection(data.neteasePlaylists, '网易云热门歌单', false);
    if (neteasePlaylists) this.root.append(neteasePlaylists);

    this.syncDailyDeck(playerState().track, false);
    this.syncLikedDeck(playerState().track, false);
    // 数据落定 = 每块内容各自出发：卡片逐张翻进来、最近播放逐行落下、歌单逐个封面抬起。
    // 页面此刻没露着就不播（动画会播在隐形层上）；切回来时 reveal() 会补一遍。
    if (options.animate === false) return;
    if (this.entrance.isVisible()) this.entrance.play();
  }

  /** 只刷新今日推荐卡（切换混合平台时用，避免整页重建）。 */
  updateDaily(data: HomeData): void {
    this.dailyTracks = data.daily;
    this.deckEl = null;
    this.titleEl = null;
    this.deckKey = [];
    const current = this.root.firstElementChild;
    const next = this.buildDaily(data);
    if (current) current.replaceWith(next);
    else this.root.prepend(next);
    this.syncDailyDeck(playerState().track, false);
    // 只给换上去的这一块单独出发：切平台不该把整页其它内容再翻一遍。
    this.entrance.playOn(Array.from(next.querySelectorAll<HTMLElement>('.daily-card')));
  }

  /** 这一层刚亮出来（app.ts 切舞台时调）：收掉可能在跑的出场，再重发一遍入场。 */
  reveal(): void {
    this.entrance.reveal();
  }

  /** 全页出场：每块沿自己入场那款的反向轨迹退回去；收完或被打断都会 resolve。 */
  playLeave(): Promise<void> {
    return this.entrance.leave();
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
          layer.append(h('img', { src: onlineArtwork(track, 300), loading: 'lazy', alt: '' }));
          if (index === 0) {
            const play = h('button', { class: 'daily-play', title: `播放今日推荐：${track.title}` }, icon('play', 18));
            play.addEventListener('click', (event) => {
              event.stopPropagation();
              this.playTopTrack();
            });
            layer.append(play);
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
    } else {
      if (data.daily.length > 0) {
        const playAll = h('button', { class: ui.btn({ variant: 'primary' }) }, icon('play', 16), h('span', { text: '播放全部' }));
        playAll.addEventListener('click', () => this.callbacks.onPlay(data.daily, 0, 'daily'));
        actions.append(playAll);
      }

      const filter = h(
        'button',
        { class: ui.btn({ variant: 'ghost' }), title: '选择今日推荐混合哪些平台' },
        icon('sliders', 16),
        h('span', { text: '混合平台' }),
      );
      filter.addEventListener('click', () => this.callbacks.onDailyFilter(filter));
      actions.append(filter);

      if (data.daily.length > 0) {
        const more = h('button', { class: ui.btn({ variant: 'ghost' }) }, h('span', { text: '查看全部' }));
        more.addEventListener('click', () => this.callbacks.onDaily());
        actions.append(more);
      }
    }

    // 封面区点击 = 进入整页；只有右侧「播放全部」才是直接播放。
    deck.addEventListener('click', () => this.callbacks.onDaily());
    deck.classList.add('is-openable');
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

    const radar = this.buildRadarCard(data);
    if (!radar) return h('section', { class: ui.section('home-daily') }, card);
    const row = h('div', { class: 'home-daily-row' });
    row.append(card, radar);
    return h('section', { class: ui.section('home-daily') }, row);
  }

  /* ------------------------------------------------------------------ */
  /* 私人雷达（网易云按账号每日更新的个人化歌单，样式与今日推荐一致）     */
  /* ------------------------------------------------------------------ */

  private buildRadarCard(data: HomeData): HTMLElement | null {
    if (!data.radarAvailable) return null;
    const covers = data.radar.slice(0, 5);
    const deck = h('div', { class: 'daily-deck radar-deck' });

    if (covers.length > 0) {
      covers
        .map((track, index) => ({ track, index }))
        .reverse()
        .forEach(({ track, index }) => {
          const layer = h('div', { class: `daily-cover daily-cover-${index}`, 'data-layer': String(index) });
          layer.append(h('img', { src: onlineArtwork(track, 300), loading: 'lazy', alt: '' }));
          if (index === 0) {
            const play = h('button', { class: 'daily-play', title: `播放私人雷达：${track.title}` }, icon('play', 18));
            play.addEventListener('click', (event) => {
              event.stopPropagation();
              this.playRadar();
            });
            layer.append(play);
          }
          deck.append(layer);
        });
    } else {
      deck.append(h('div', { class: 'daily-cover daily-cover-0 is-empty' }, icon('compass', 34)));
    }

    const title =
      data.radar.length === 0
        ? data.radarLoading
          ? '私人雷达加载中…'
          : '今天的私人雷达还没生成'
        : covers[0]?.title ?? '私人雷达';
    const meta = '网易云 · 每天 6:00 更新' + (data.radar.length > 0 ? ` · 共 ${data.radar.length} 首` : '');
    const actions = h('div', { class: 'daily-actions' });
    if (data.radar.length > 0) {
      const playAll = h('button', { class: ui.btn({ variant: 'primary' }) }, icon('play', 16), h('span', { text: '播放全部' }));
      playAll.addEventListener('click', () => this.callbacks.onPlay(data.radar, 0, 'radar'));
      const more = h('button', { class: ui.btn({ variant: 'ghost' }) }, h('span', { text: '查看全部' }));
      more.addEventListener('click', () => this.callbacks.onRadar());
      actions.append(playAll, more);
    }

    if (data.radar.length > 0) {
      // 封面区点击 = 进入雷达整页；播放/查看全部各管各的。
      deck.addEventListener('click', () => this.callbacks.onRadar());
      deck.classList.add('is-openable');
    }
    return h(
      'div',
      { class: `daily-card radar-card${covers.length > 0 ? '' : ' is-empty'}` },
      deck,
      h(
        'div',
        { class: 'daily-body' },
        h('div', { class: 'daily-kicker' }, icon('compass', 13), h('span', { text: '私人雷达' })),
        h('h2', { class: 'daily-title', text: title }),
        h('div', { class: 'daily-meta', text: meta }),
        actions,
      ),
    );
  }

  private playRadar(): void {
    const list = this.radarTracks;
    if (list.length === 0) return;
    this.callbacks.onPlay(list, 0, 'radar');
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
      if (image && item) image.src = onlineArtwork(item, 300);
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
      if (image && item) image.src = onlineArtwork(item, 300);
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
        h('img', { class: 'recent-thumb', src: track.cover || onlineArtwork(track, 120), alt: '', loading: 'lazy' }),
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
    const canPlay = item.tracks.some((track) => track.playable);
    const deck = h('div', { class: 'daily-deck' });

    if (covers.length > 0) {
      covers
        .map((track, index) => ({ track, index }))
        .reverse()
        .forEach(({ track, index }) => {
          const layer = h('div', { class: `daily-cover daily-cover-${index}` });
          layer.append(h('img', { src: track.cover || onlineArtwork(track, 300), loading: 'lazy', alt: '' }));
          if (index === 0 && canPlay) {
            const play = h('button', { class: 'daily-play', type: 'button', title: `播放${item.label}` }, icon('play', 18));
            play.addEventListener('click', (event) => {
              event.stopPropagation();
              this.callbacks.onLiked(item.source);
            });
            layer.append(play);
            layer.addEventListener('click', () => this.callbacks.onLiked(item.source));
          } else {
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
    if (canPlay) actions.append(playAll);
    if (item.source === 'netease' && item.loggedIn) {
      // 心动模式是网易云独有的智能续播：以「我喜欢的音乐 + 当前歌曲」为种子。
      const heartbeat = h(
        'button',
        { class: ui.btn({ variant: 'ghost' }), title: '心动模式：按我喜欢的音乐智能续播' },
        icon('sparkle', 16),
        h('span', { text: '心动模式' }),
      );
      heartbeat.addEventListener('click', () => this.callbacks.onHeartbeat(item.source));
      actions.append(heartbeat);
    }
    actions.append(more);

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

  /* ------------------------------------------------------------------ */
  /* 推荐行（网易云：私人漫游 / 相似歌曲；QQ：猜你喜欢 / 百万收藏 / 新歌） */
  /* ------------------------------------------------------------------ */

  /**
   * 首页推荐行换 tab：和切页面走同一套逐块运动，不是整块淡入淡出。
   * 旧面板里每块沿自己入场那款反向退场（反向错帧，最后进来的先走），收完再摘；
   * 新面板每块随机挑款、各自延迟散开落定 —— 就是 `HomeView.entrance` 在整页上做的事，
   * 只是把范围缩到这一行，所以观感和「离开首页 / 回到首页」一致。
   */
  private swapProviderBody(body: HTMLElement, next: HTMLElement): void {
    if (prefersReducedMotion()) {
      body.replaceChildren(next);
      return;
    }
    // 先让新面板入位再开演：逐块入场要在文档里才看得见（CSS 动画未渲染时不推进）。
    for (const el of Array.from(body.children) as HTMLElement[]) {
      if (el === next) continue;
      el.classList.add('is-provider-leaving');
      const motion = this.panelMotion(el);
      // 打断规则：同一实例再调 leave() 会先把上一段收干净，不叠加、不排队。
      void motion.leave().then(() => {
        motion.dispose();
        this.panelMotions.delete(el);
        el.remove();
      });
      // 兜底：掉帧 / 后台标签页里收尾定时器不一定准时，到点直接摘，
      // 免得退场块叠在内容上、越切越多。
      window.setTimeout(() => el.remove(), MOTION.base + 420);
    }
    body.append(next);
    const motion = this.panelMotion(next);
    // 空壳（「暂无推荐内容」/「加载失败」）不演，和整页那条「加载中不演」的规矩一致。
    if (motion.hasTargets()) motion.play();
  }

  /** 面板自己的逐块运动器（复用，不每次新建：打断要落在同一实例上）。 */
  private panelMotion(panel: HTMLElement): BlockEntrance {
    let motion = this.panelMotions.get(panel);
    if (!motion) {
      motion = new BlockEntrance(panel, { items: PROVIDER_ITEMS });
      this.panelMotions.set(panel, motion);
    }
    return motion;
  }

  private buildProviderSection(source: 'netease' | 'qq', data: HomeData): HTMLElement {
    const netease = source === 'netease';
    const labels = netease ? ['为你推荐', '官方歌单', '精品歌单', '风格分类'] : ['热门歌单', '新歌速递', '榜单推荐', '歌手精选'];
    const title = netease ? '网易云推荐' : 'QQ 音乐推荐';
    const head = h('div', { class: ui.sectionHead() }, h('h2', { class: ui.sectionTitle(), text: title }));
    // 复用全站统一的分段控件 .seg：白色滑块由 app.ts 的 enhanceSegs 注入并负责滑动，
    // 这里只加 .home-provider-tabs 做首页这一行的排布微调。
    const tabs = h('div', { class: 'seg seg-sm home-provider-tabs' });
    head.append(tabs);
    if (!netease) {
      const more = h('button', { class: ui.sectionMore(), text: '查看更多 ›' });
      more.onclick = () => this.callbacks.onRecommend();
      head.append(more);
    }
    const body = h('div', { class: 'home-provider-body' });
    const section = h('section', { class: ui.section('home-provider') }, head, body);
    const specials = data.specials.filter(item => item.source === source);
    const tracks = specials.flatMap(item => item.tracks);
    let version = 0;
    const buttons = labels.map((text, index) => {
      const button = h('button', { class: 'seg-btn home-provider-tab', text });
      button.onclick = () => void select(index);
      tabs.append(button);
      return button;
    });
    const select = async (index: number): Promise<void> => {
      const current = ++version;
      this.selectedTabs[source] = index;
      buttons.forEach((button, n) => {
        button.classList.toggle('is-on', n === index);
        button.setAttribute('aria-pressed', String(n === index));
      });
      // 内容先在离屏的 panel 里建好，最后再一次性交叉换上去：
      // 换的时候如果先塞空容器，区块高度会瞬间塌一下，下面的推荐行跟着跳。
      const panel = h('div', { class: 'home-provider-panel' });
      // `animate` 只给「异步补进来的那一批」用：面板已经上场之后再换内容，
      // 新块要自己再开一次入场（否则它们会静止地凭空出现，和整页刷新时不重播的规矩不同）。
      const shelf = (items: LibraryPlaylist[], open?: (item: LibraryPlaylist) => void, animate = false): void => {
        const result = this.buildPlaylistSection(items, '', false, open);
        const filled = result?.lastElementChild ?? h('p', { class: 'ui-empty', text: '暂无推荐内容' });
        panel.replaceChildren(filled);
        if (animate) this.panelMotion(panel).playOn(Array.from(filled.querySelectorAll<HTMLElement>(PROVIDER_ITEMS)));
      };
      try {
        if (netease && index === 0) {
          const row = h('div', { class: 'home-collections' });
          for (const item of specials) {
            const card = this.buildSpecialCard(item);
            if (card) row.append(card);
          }
          if (row.childElementCount) panel.append(row);
          else shelf(data.neteasePlaylists);
        } else if (!netease && index === 0) {
          const items = data.playlists.filter(item => item.source === source);
          const initial = items.length ? items : data.recommendPlaylists.filter(item => item.source === source);
          shelf(initial);
          if (initial.length < 12) {
            try {
              const page = await fetchPlaylists(source, '全部', 'hot', 0, 24);
              if (current !== version) return;
              const merged = new Map(initial.map(item => [item.id, item]));
              for (const item of page.playlists) merged.set(item.id, { ...item, source });
              shelf([...merged.values()], undefined, true);
            } catch { /* Keep the already loaded shelf available offline. */ }
          }
        } else if (netease && index === 3) {
          const cats = await fetchCats(source);
          if (current !== version) return;
          const results = h('div');
          // 原生 <select> 的下拉列表是系统绘制的：圆角、配色、动效一概改不了，
          // 和这套界面摆在一起像一块外挂控件。这里换成自定义下拉——触发器沿用 tab 的胶囊形，
          // 列表走面板令牌，出入场与全站一致（淡入下移 / 反向收回，过渡本身就能打断）。
          const picker = h('div', { class: 'home-cat-picker' });
          const currentName = h('span', { class: 'home-cat-current', text: cats[0]?.name ?? '全部' });
          const trigger = h(
            'button',
            { class: 'home-cat-trigger', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
            currentName,
            icon('chevronDown', 13),
          );
          const menu = h('div', { class: 'home-cat-menu', role: 'listbox', 'aria-label': '歌单风格' });
          let open = false;
          let activeId = cats[0]?.id ?? '全部';
          const setOpen = (next: boolean): void => {
            if (open === next) return;
            open = next;
            picker.classList.toggle('is-open', next);
            trigger.setAttribute('aria-expanded', String(next));
            if (next) menu.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
          };
          const options: HTMLElement[] = [];
          const load = async (): Promise<void> => {
            const cat = activeId;
            try {
              const page = await fetchPlaylists(source, cat);
              if (activeId !== cat) return;
              // 面板已经上场了，这批结果是后到的：让它们自己再开一次逐块入场。
              const tiles = this.buildPlaylistSection(page.playlists.map(item => ({ ...item, source })), '', false);
              const filled = tiles?.lastElementChild ?? h('p', { text: '暂无歌单' });
              results.replaceChildren(filled);
              if (panel.isConnected) {
                this.panelMotion(panel).playOn(Array.from(filled.querySelectorAll<HTMLElement>(PROVIDER_ITEMS)));
              }
            } catch { if (activeId === cat) results.textContent = '歌单暂时无法加载'; }
          };
          const choose = (id: string, name: string): void => {
            activeId = id;
            currentName.textContent = name;
            for (const option of options) option.setAttribute('aria-selected', String(option.dataset.id === id));
            setOpen(false);
            void load();
          };
          for (const cat of cats) {
            const option = h('button', {
              class: 'home-cat-option',
              type: 'button',
              role: 'option',
              'aria-selected': String(cat.id === activeId),
              text: cat.name,
            });
            option.dataset.id = cat.id;
            option.onclick = () => choose(cat.id, cat.name);
            options.push(option);
            menu.append(option);
          }
          trigger.onclick = (event) => {
            event.stopPropagation();
            setOpen(!open);
          };
          // 面板会随 tab 切换被整段替换掉：监听在 document 上，所以每次触发都先看看自己还在不在，
          // 不在就顺手摘掉，别给已经卸掉的面板留钩子。
          const onOutside = (event: PointerEvent): void => {
            if (!picker.isConnected) {
              dropListeners();
              return;
            }
            if (!open || picker.contains(event.target as Node)) return;
            setOpen(false);
          };
          const onKey = (event: KeyboardEvent): void => {
            if (!picker.isConnected) {
              dropListeners();
              return;
            }
            if (!open || event.key !== 'Escape') return;
            event.stopPropagation();
            setOpen(false);
            trigger.focus();
          };
          const dropListeners = (): void => {
            document.removeEventListener('pointerdown', onOutside, true);
            document.removeEventListener('keydown', onKey, true);
          };
          document.addEventListener('pointerdown', onOutside, true);
          document.addEventListener('keydown', onKey, true);
          picker.append(trigger, menu);
          panel.append(picker, results);
          // 不 await：picker 先上场，歌单结果到了自己填进去（和切页后异步补内容一致）。
          void load();
        } else if (netease && index === 2) {
          shelf([...data.neteasePlaylists].sort((a, b) => b.count - a.count));
        } else if (netease || index === 2) {
          const groups = await fetchCharts(source);
          if (current !== version) return;
          const charts = groups.flatMap(group => group.categories.flatMap(cat => cat.charts));
          shelf(charts.map(chart => ({ ...chart, source })), item => this.callbacks.onChart(source, item.id));
        } else if (index === 1) {
          const item = specials.find(entry => entry.kind === 'newsong');
          const card = item && this.buildSpecialCard(item);
          if (card) panel.append(h('div', { class: 'home-collections' }, card));
          else panel.textContent = '暂无新歌推荐';
        } else {
          const artists = new Map<string, LibraryPlaylist>();
          for (const track of [...tracks, ...data.recent.filter(t => t.source === source)]) {
            if (track.artist && !artists.has(track.artist)) artists.set(track.artist, {
              source, id: track.artist, title: track.artist, cover: track.cover, count: 0,
            });
          }
          shelf([...artists.values()], item => this.callbacks.onArtistSearch(item.title));
        }
      } catch { panel.textContent = '推荐暂时无法加载，点击分类可重试'; }
      if (current !== version) return;
      this.swapProviderBody(body, panel);
    };
    void select(this.selectedTabs[source]);
    return section;
  }

  private buildSpecialSections(items: HomeSpecial[]): HTMLElement[] {
    const sections: HTMLElement[] = [];
    const order: OnlineSource[] = ['netease', 'qq', 'kugou'];
    for (const source of order) {
      const group = items.filter((item) => item.source === source);
      const cards = group
        .map((item) => this.buildSpecialCard(item))
        .filter((item): item is HTMLElement => item !== null);
      if (cards.length === 0) continue;
      const row = h('div', { class: 'home-collections' });
      row.append(...cards);
      const title = source === 'netease' ? '网易云推荐' : source === 'qq' ? 'QQ 音乐推荐' : '酷狗推荐';
      sections.push(
        h(
          'section',
          { class: ui.section('home-special') },
          h('div', { class: ui.sectionHead() }, h('h2', { class: ui.sectionTitle(), text: title })),
          row,
        ),
      );
    }
    return sections;
  }

  private buildSpecialCard(item: HomeSpecial): HTMLElement | null {
    const covers = item.tracks.slice(0, 5);
    if (covers.length === 0) return null;
    const deck = h('div', { class: 'daily-deck' });
    covers
      .map((track, index) => ({ track, index }))
      .reverse()
      .forEach(({ track, index }) => {
        const layer = h('div', { class: `daily-cover daily-cover-${index}` });
        layer.append(h('img', { src: track.cover || onlineArtwork(track, 300), loading: 'lazy', alt: '' }));
        if (index === 0) {
          const play = h(
            'button',
            { class: 'daily-play', type: 'button', title: `播放${item.label}` },
            icon('play', 18),
          );
          play.addEventListener('click', (event) => {
            event.stopPropagation();
            this.callbacks.onPlay(item.tracks, 0, 'special', item.kind);
          });
          layer.append(play);
        }
        layer.addEventListener('click', () => this.callbacks.onSpecial(item.kind));
        deck.append(layer);
      });

    const actions = h('div', { class: 'daily-actions' });
    const playAll = h(
      'button',
      { class: ui.btn({ variant: 'primary' }) },
      icon('play', 16),
      h('span', { text: '播放全部' }),
    );
    playAll.addEventListener('click', () => this.callbacks.onPlay(item.tracks, 0, 'special', item.kind));
    const more = h('button', { class: ui.btn({ variant: 'ghost' }) }, h('span', { text: '查看全部' }));
    more.addEventListener('click', () => this.callbacks.onSpecial(item.kind));
    actions.append(playAll, more);

    const card = h(
      'div',
      { class: 'daily-card' },
      deck,
      h(
        'div',
        { class: 'daily-body' },
        h('div', { class: 'daily-kicker' }, icon('sparkle', 13), h('span', { text: item.kicker })),
        h('h2', { class: 'daily-title', text: item.label }),
        h('div', { class: 'daily-meta', text: item.meta }),
        actions,
      ),
    );
    return h('section', { class: ui.section('home-liked') }, card);
  }

  private buildPlaylistSection(items: LibraryPlaylist[], title: string, withMore: boolean, open = this.callbacks.onPlaylist): HTMLElement | null {
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
    enableWheelScroll(scroller);
    items.forEach((item) => {
      const cover =
        item.cover ??
        onlineArtwork({ id: item.id, title: item.title, artist: item.creator ?? '', album: '', cover: '' }, 300);
      const tile = h(
        'button',
        { class: ui.tile(), title: item.title },
        h('span', { class: ui.tileCover() }, h('img', { src: cover, loading: 'lazy', alt: '' })),
        h('span', { class: ui.tileName(), text: item.title }),
        h('span', { class: ui.tileMeta(), text: `${SOURCE_LABEL[item.source] ?? ''} · ${formatPlays(item.count)}` }),
      );
      tile.addEventListener('click', () => open(item));
      scroller.append(tile);
    });
    section.append(head, scroller);
    return section;
  }
}
