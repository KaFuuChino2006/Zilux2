/**
 * 发现页：排行榜（榜单详情）/ 歌单广场 / 私人漫游 / 播客 / 收藏，
 * 以及从曲目行进入的歌手页、专辑页与评论 Sheet。
 *
 * 全部渲染进 app 的 wallHost（.wall），复用 dom/theme 的组件类与现有视觉语言；
 * 数据来自 Discover API v1（web/src/online/discover.ts），60s 内命中客户端缓存。
 * 这里只负责「取数 → 组装 DOM → 回调播放 / 打开歌单 / 打开 Sheet / 搜索」。
 */

import type { LibraryPlaylist } from '../core/library';
import {
  discoverCover,
  discoverErrorText,
  fetchAlbum,
  fetchArtist,
  fetchChart,
  fetchCharts,
  fetchCats,
  fetchCollections,
  fetchComments,
  fetchPlaylists,
  fetchPodcasts,
  fetchRadio,
  fmtCount,
  isLoginRequired,
  isUnsupported,
  type CollectionKind,
  type DiscoverAlbum,
  type DiscoverArtist,
  type DiscoverCat,
  type DiscoverChartDetail,
  type DiscoverChartGroup,
  type DiscoverCollectionItem,
  type DiscoverComment,
  type DiscoverOrder,
  type DiscoverPlaylist,
  type DiscoverPodcast,
  type DiscoverSource,
  type DiscoverTrack,
} from '../online/discover';
import { sourceMeta } from '../online/sources';
import { SOURCE_LABEL, type OnlineTrack } from '../online/types';
import { h, icon, toast, fmtTime } from './dom';
import { openSongInfo, songInfoView } from './songInfo';
import { ui } from './theme';
import { gradientCover } from './coverFallback';

/* -------------------------------------------------------------------------- */
/* 对外接口                                                                    */
/* -------------------------------------------------------------------------- */

export interface DiscoverHandlers {
  /** 播放某一整个列表（index 为起始曲目）。 */
  play(tracks: OnlineTrack[], index: number): void;
  /** 打开歌单详情（由 app 复用现有 showPlaylist）。 */
  openPlaylist(item: LibraryPlaylist): void;
  /** 打开右侧 Sheet（由 app 复用现有 openSheet）。 */
  openSheet(title: string, build: (body: HTMLDivElement) => void): void;
  /** 按关键词搜索（播客点击后由 app 切到搜索墙）。 */
  search(query: string): void;
}

type DiscoverTab = 'charts' | 'playlists' | 'radio' | 'podcasts' | 'collections';
type SourceFilter = 'all' | DiscoverSource;
type ViewState =
  | { kind: 'root' }
  | { kind: 'chart'; source: string; id: string }
  | { kind: 'artist'; source: string; id: string }
  | { kind: 'album'; source: string; id: string };

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

const TABS: Array<{ id: DiscoverTab; label: string }> = [
  { id: 'charts', label: '排行榜' },
  { id: 'playlists', label: '歌单广场' },
  { id: 'radio', label: '私人漫游' },
  { id: 'podcasts', label: '播客' },
  { id: 'collections', label: '收藏' },
];

const TAB_SUBTITLE: Record<DiscoverTab, string> = {
  charts: '各平台榜单集合，点击榜单查看完整曲目',
  playlists: '按分类与热度浏览平台歌单',
  radio: '为你漫游推荐，每次换一批都会重新挑歌',
  podcasts: '电台节目精选，点击按节目名搜索相关歌曲',
  collections: '你收藏的歌手、专辑与 MV',
};

/** 仅网易云支持的板块（QQ 音乐无对应能力）。 */
const NET_EASE_ONLY: DiscoverTab[] = ['radio', 'podcasts', 'collections'];

const SOURCE_OPTIONS: Array<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'netease', label: '网易云' },
  { id: 'qq', label: 'QQ' },
];

const ORDER_OPTIONS: Array<{ id: DiscoverOrder; label: string }> = [
  { id: 'hot', label: '最热' },
  { id: 'new', label: '最新' },
];

const COLLECTION_OPTIONS: Array<{ id: CollectionKind; label: string }> = [
  { id: 'artist', label: '歌手' },
  { id: 'album', label: '专辑' },
  { id: 'mv', label: 'MV' },
  { id: 'playlist', label: '歌单' },
];

const COLLECTION_EMPTY: Record<CollectionKind, string> = {
  artist: '在网易云音乐里收藏歌手后会显示在这里',
  album: '在网易云音乐里收藏专辑后会显示在这里',
  mv: '在网易云音乐里收藏 MV 后会显示在这里',
  playlist: '在网易云音乐里创建 / 收藏歌单后会显示在这里',
};

/* -------------------------------------------------------------------------- */
/* 发现页                                                                      */
/* -------------------------------------------------------------------------- */

export class DiscoverView {
  private readonly host: HTMLDivElement;
  private readonly handlers: DiscoverHandlers;

  private tab: DiscoverTab = 'charts';
  private source: SourceFilter = 'all';
  private playlistCat = '全部';
  private playlistOrder: DiscoverOrder = 'hot';
  private collectionKind: CollectionKind = 'artist';
  private state: ViewState = { kind: 'root' };
  private stack: ViewState[] = [];
  /** 每次整页重绘 +1，用于丢弃迟到的异步结果。 */
  private seq = 0;

  constructor(host: HTMLDivElement, handlers: DiscoverHandlers) {
    this.host = host;
    this.handlers = handlers;
  }

  /** 从 rail 进入「发现」：回到根视图。 */
  async show(): Promise<void> {
    this.state = { kind: 'root' };
    this.stack = [];
    await this.render();
  }

  /* -------------------------------- 渲染骨架 -------------------------------- */

  private async render(): Promise<void> {
    const seq = ++this.seq;
    this.host.textContent = '';
    this.scrollTop();
    const frame = h('div', { class: 'disc' });
    this.host.append(frame);

    if (this.state.kind !== 'root') {
      frame.append(this.backBar());
      const holder = h('div', { class: 'disc-body' });
      frame.append(holder);
      holder.append(this.loadingBox());
      try {
        let content: HTMLElement;
        if (this.state.kind === 'chart') content = await this.buildChartPage(this.state.source, this.state.id, seq);
        else if (this.state.kind === 'artist') content = await this.buildArtistPage(this.state.source, this.state.id, seq);
        else content = await this.buildAlbumPage(this.state.source, this.state.id, seq);
        if (seq !== this.seq) return;
        holder.textContent = '';
        holder.append(content);
      } catch (err) {
        if (seq !== this.seq) return;
        holder.textContent = '';
        holder.append(this.errorBox(err));
        toast(discoverErrorText(err), 'error');
      }
      return;
    }

    this.buildRootHead(frame);
    const body = h('div', { class: 'disc-body' });
    frame.append(body);
    body.append(this.loadingBox());
    try {
      let content: HTMLElement;
      if (this.tab === 'charts') content = await this.chartsBody();
      else if (this.tab === 'playlists') content = await this.playlistsBody();
      else if (this.tab === 'radio') content = await this.radioBody();
      else if (this.tab === 'podcasts') content = await this.podcastsBody();
      else content = await this.collectionsBody();
      if (seq !== this.seq) return;
      body.textContent = '';
      body.append(content);
    } catch (err) {
      if (seq !== this.seq) return;
      body.textContent = '';
      body.append(this.errorBox(err));
      toast(discoverErrorText(err), 'error');
    }
  }

  private scrollTop(): void {
    // .wall 有 scroll-behavior:smooth，切换视图时先临时关掉，避免长列表滚动的长动画。
    const previous = this.host.style.scrollBehavior;
    this.host.style.scrollBehavior = 'auto';
    this.host.scrollTop = 0;
    this.host.style.scrollBehavior = previous;
  }

  private navigate(next: ViewState): void {
    if (this.state.kind !== 'root') this.stack.push(this.state);
    this.state = next;
    void this.render();
  }

  private goBack(): void {
    const previous = this.stack.pop();
    this.state = previous ?? { kind: 'root' };
    void this.render();
  }

  /* -------------------------------- 根视图头部 -------------------------------- */

  private buildRootHead(frame: HTMLDivElement): void {
    const head = h('header', { class: 'wall-head' });
    head.append(
      h(
        'div',
        {},
        h('h1', { class: 'wall-title', text: '发现' }),
        h('div', { class: 'wall-sub', text: TAB_SUBTITLE[this.tab] }),
      ),
      h('div', { class: 'wall-head-actions' }, this.sourceSeg()),
    );
    frame.append(head);

    const tabs = h('div', { class: 'disc-tabs' });
    for (const tab of TABS) {
      const btn = h('button', {
        class: `disc-tab${tab.id === this.tab ? ' is-on' : ''}`,
        type: 'button',
        text: tab.label,
      });
      btn.addEventListener('click', () => {
        if (tab.id === this.tab) return;
        this.tab = tab.id;
        if (NET_EASE_ONLY.includes(tab.id) && this.source === 'qq') {
          this.source = 'netease';
          toast('QQ 音乐暂不支持该板块，已切回网易云');
        }
        void this.render();
      });
      tabs.append(btn);
    }
    frame.append(tabs);
    if (NET_EASE_ONLY.includes(this.tab)) {
      frame.append(h('div', { class: 'disc-note' }, icon('music', 13), h('span', { text: '该板块仅支持网易云音乐' })));
    }
  }

  private sourceSeg(): HTMLDivElement {
    const neteaseOnly = NET_EASE_ONLY.includes(this.tab);
    return this.seg<SourceFilter>(
      SOURCE_OPTIONS,
      this.source,
      (id) => {
        this.source = id;
      },
      (id) => neteaseOnly && id === 'qq',
      () => {
        // 点了「仅支持网易云」板块里的 QQ：明确切回网易云，让分段状态与 toast 一致。
        this.source = 'netease';
        void this.render();
      },
    );
  }

  /** 通用分段控件（来源 / 排序 / 收藏类型）。 */
  private seg<T extends string>(
    options: Array<{ id: T; label: string }>,
    current: T,
    onPick: (id: T) => void,
    isDisabled?: (id: T) => boolean,
    onDisabled?: () => void,
  ): HTMLDivElement {
    const wrap = h('div', { class: 'seg' });
    for (const option of options) {
      const disabled = isDisabled ? isDisabled(option.id) : false;
      const btn = h('button', {
        class: `seg-btn${option.id === current ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`,
        type: 'button',
        text: option.label,
        title: disabled ? '该板块仅支持网易云音乐' : option.label,
      });
      btn.addEventListener('click', () => {
        if (disabled) {
          toast('QQ 音乐暂不支持，已切回网易云');
          onDisabled?.();
          return;
        }
        if (option.id === current) return;
        onPick(option.id);
        void this.render();
      });
      wrap.append(btn);
    }
    return wrap;
  }

  /* -------------------------------- 排行榜 ---------------------------------- */

  private async chartsBody(): Promise<HTMLElement> {
    const source = this.source === 'all' ? undefined : this.source;
    const groups = await fetchCharts(source);
    if (groups.length === 0) return this.emptyBox('暂时没有榜单数据');
    const wrap = h('div', { class: 'disc-sections' });
    for (const group of groups) {
      wrap.append(this.chartGroupSection(group));
    }
    return wrap;
  }

  private chartGroupSection(group: DiscoverChartGroup): HTMLElement {
    const section = h(
      'section',
      { class: ui.section() },
      h(
        'div',
        { class: ui.sectionHead() },
        h('h3', { class: ui.sectionTitle(), text: group.label || '榜单' }),
        h('span', { class: 'disc-src-label', text: SOURCE_LABEL[group.source] ?? group.source }),
      ),
    );
    for (const category of group.categories) {
      section.append(h('div', { class: 'disc-sub', text: category.title }));
      const row = h('div', { class: ui.scroller() });
      for (const chart of category.charts) {
        const meta = [chart.count > 0 ? `${fmtCount(chart.count)} 首` : '', chart.updateFrequency].filter(Boolean).join(' · ');
        row.append(
          this.tile(chart.cover, chart.title, meta, () => this.navigate({ kind: 'chart', source: group.source, id: chart.id })),
        );
      }
      section.append(row);
    }
    return section;
  }

  /* -------------------------------- 榜单详情 -------------------------------- */

  private async buildChartPage(source: string, id: string, seq: number): Promise<HTMLElement> {
    const detail = await fetchChart(source, id, 0, 100);
    if (seq !== this.seq) return h('div');
    const wrap = h('div', { class: 'disc-detail' });
    wrap.append(this.chartHero(detail));

    const tracks: DiscoverTrack[] = [...detail.tracks];
    const list = h('div', { class: 'disc-track-list' });
    const more = h('div', { class: 'disc-more' });
    const renderRows = (): void => {
      list.textContent = '';
      tracks.forEach((track, index) => list.append(this.trackRow(track, tracks, index)));
    };
    renderRows();
    wrap.append(
      h('div', { class: 'disc-sub-title', text: `曲目 · ${fmtCount(detail.count)} 首` }),
      list,
      more,
    );

    const syncMore = (hasMore: boolean): void => {
      more.textContent = '';
      if (!hasMore) return;
      const btn = h('button', { class: ui.btn({ size: 'sm' }), type: 'button', text: '加载更多' });
      btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = '加载中…';
        void (async () => {
          try {
            const next = await fetchChart(source, id, tracks.length, 100);
            tracks.push(...next.tracks);
            renderRows();
            syncMore(next.hasMore && next.tracks.length > 0);
          } catch (err) {
            toast(discoverErrorText(err, '加载更多失败'), 'error');
            btn.disabled = false;
            btn.textContent = '加载更多';
          }
        })();
      });
      more.append(btn);
    };
    syncMore(detail.hasMore);
    return wrap;
  }

  private chartHero(detail: DiscoverChartDetail): HTMLElement {
    return this.hero({
      cover: detail.cover,
      kicker: `${SOURCE_LABEL[detail.source] ?? detail.source} · 排行榜`,
      title: detail.title,
      meta: `${fmtCount(detail.count)} 首`,
      actions: detail.tracks.length > 0 ? this.playAllButton(detail.tracks, '播放全部') : undefined,
    });
  }

  /* -------------------------------- 歌单广场 -------------------------------- */

  private async playlistsBody(): Promise<HTMLElement> {
    const wrap = h('div', { class: 'disc-playlists' });
    let cats: DiscoverCat[];
    if (this.source === 'qq') {
      cats = [{ id: '全部', name: '全部' }];
    } else {
      try {
        cats = await fetchCats('netease');
      } catch {
        cats = [{ id: '全部', name: '全部' }];
      }
    }
    if (!cats.some((cat) => cat.id === this.playlistCat)) this.playlistCat = '全部';

    const chips = h('div', { class: 'disc-chips' });
    for (const cat of cats) {
      const chip = h('button', {
        class: ui.chip(cat.id === this.playlistCat),
        type: 'button',
        text: cat.name,
      });
      chip.addEventListener('click', () => {
        if (this.playlistCat === cat.id) return;
        this.playlistCat = cat.id;
        void this.render();
      });
      chips.append(chip);
    }
    wrap.append(
      h(
        'div',
        { class: 'disc-toolbar' },
        chips,
        this.seg<DiscoverOrder>(ORDER_OPTIONS, this.playlistOrder, (id) => {
          this.playlistOrder = id;
        }),
      ),
    );

    const items: DiscoverPlaylist[] = [];
    if (this.source === 'qq') {
      const data = await fetchPlaylists('qq', '全部', this.playlistOrder);
      items.push(...data.playlists);
    } else if (this.source === 'netease') {
      const data = await fetchPlaylists('netease', this.playlistCat, this.playlistOrder);
      items.push(...data.playlists);
    } else {
      // 「全部」= 网易云当前分类 + QQ 的「全部」分类；单源失败不影响另一源。
      const [netease, qq] = await Promise.all([
        fetchPlaylists('netease', this.playlistCat, this.playlistOrder).catch(() => null),
        fetchPlaylists('qq', '全部', this.playlistOrder).catch(() => null),
      ]);
      if (netease) items.push(...netease.playlists);
      if (qq) items.push(...qq.playlists);
      if (!netease && !qq) throw new Error('歌单广场加载失败');
    }

    if (items.length === 0) {
      wrap.append(this.emptyBox('这个分类下暂时没有歌单', '换一个分类或切到「全部」看看'));
      return wrap;
    }
    const grid = h('div', { class: 'disc-grid' });
    for (const item of items) grid.append(this.playlistCard(item));
    wrap.append(grid);
    return wrap;
  }

  private playlistCard(item: DiscoverPlaylist): HTMLButtonElement {
    const meta = [SOURCE_LABEL[item.source] ?? item.source, item.creator, item.count > 0 ? `${fmtCount(item.count)} 首` : '']
      .filter(Boolean)
      .join(' · ');
    const btn = this.tile(item.cover, item.title, meta, () =>
      this.handlers.openPlaylist({
        source: item.source,
        id: item.id,
        title: item.title,
        cover: item.cover,
        count: item.count,
        creator: item.creator,
        special: null,
      }),
    );
    btn.title = item.title;
    return btn;
  }

  /* -------------------------------- 私人漫游 -------------------------------- */

  private async radioBody(): Promise<HTMLElement> {
    const tracks = await fetchRadio(12);
    const wrap = h('div', { class: 'disc-radio' });
    wrap.append(
      h(
        'div',
        { class: 'disc-bar' },
        h('div', { class: 'disc-bar-text' }, icon('sparkle', 15), h('span', { text: '为你漫游推荐 · 每次换一批都会重新挑歌' })),
        this.swapButton(),
      ),
    );
    if (tracks.length === 0) {
      wrap.append(this.emptyBox('漫游暂时没有推荐', '登录网易云后再点「换一批」试试'));
      return wrap;
    }
    wrap.append(this.trackList(tracks));
    wrap.append(h('div', { class: 'disc-actions' }, this.playAllButton(tracks, '播放全部')));
    return wrap;
  }

  private swapButton(): HTMLButtonElement {
    const btn = h('button', { class: ui.btn({ size: 'sm' }), type: 'button' }, icon('refresh', 14), h('span', { text: '换一批' }));
    btn.addEventListener('click', () => {
      btn.disabled = true;
      void this.render();
    });
    return btn;
  }

  /* --------------------------------- 播客 ---------------------------------- */

  private async podcastsBody(): Promise<HTMLElement> {
    const programs = await fetchPodcasts(12);
    if (programs.length === 0) return this.emptyBox('暂时没有播客推荐');
    const grid = h('div', { class: 'disc-grid' });
    for (const program of programs) grid.append(this.podcastCard(program));
    return h(
      'div',
      { class: 'disc-podcasts' },
      h('div', { class: 'disc-bar-text' }, icon('airplay', 15), h('span', { text: '节目暂不支持直接播放，点击会按节目名搜索相关歌曲' })),
      grid,
    );
  }

  private podcastCard(program: DiscoverPodcast): HTMLButtonElement {
    const meta = [program.radioName, program.djName, program.durationMs > 0 ? fmtTime(program.durationMs) : '']
      .filter(Boolean)
      .join(' · ');
    const btn = this.tile(program.cover, program.name, meta, () => {
      toast('已按节目名搜索');
      this.handlers.search(program.name);
    });
    if (program.description) btn.title = program.description;
    return btn;
  }

  /* --------------------------------- 收藏 ---------------------------------- */

  private async collectionsBody(): Promise<HTMLElement> {
    const wrap = h('div', { class: 'disc-collections' });
    wrap.append(
      this.seg<CollectionKind>(COLLECTION_OPTIONS, this.collectionKind, (id) => {
        this.collectionKind = id;
      }),
    );
    let data;
    try {
      data = await fetchCollections('netease', this.collectionKind);
    } catch (err) {
      wrap.append(this.errorBox(err));
      toast(discoverErrorText(err), 'error');
      return wrap;
    }
    if (data.items.length === 0) {
      wrap.append(this.emptyBox('还没有收藏内容', COLLECTION_EMPTY[this.collectionKind]));
      return wrap;
    }
    const grid = h('div', { class: 'disc-grid' });
    for (const item of data.items) grid.append(this.collectionCard(item));
    wrap.append(grid);
    if (data.hasMore) {
      wrap.append(h('div', { class: 'disc-foot-note', text: '仅展示前 30 条收藏' }));
    }
    return wrap;
  }

  private collectionCard(item: DiscoverCollectionItem): HTMLButtonElement {
    const kind = this.collectionKind;
    const btn = this.tile(item.cover, item.title, item.subtitle, () => {
      if (kind === 'artist') this.navigate({ kind: 'artist', source: 'netease', id: item.id });
      else if (kind === 'album') this.navigate({ kind: 'album', source: 'netease', id: item.id });
      else if (kind === 'playlist') {
        // 收藏歌单的 subtitle 形如「创建者 · 133 首」，从里面还原曲目数用于歌单详情副标题。
        const count = Number(/(\d+)\s*首/.exec(item.subtitle)?.[1] ?? '0');
        const creator = item.subtitle.split(' · ')[0] ?? '';
        this.handlers.openPlaylist({
          source: 'netease',
          id: item.id,
          title: item.title,
          cover: item.cover,
          count: Number.isFinite(count) ? count : 0,
          creator,
          special: null,
        });
      } else {
        toast('MV 暂不支持播放');
      }
    });
    return btn;
  }

  /* --------------------------------- 歌手 ---------------------------------- */

  private async buildArtistPage(source: string, id: string, seq: number): Promise<HTMLElement> {
    const artist = await fetchArtist(source, id, 50);
    if (seq !== this.seq) return h('div');
    const wrap = h('div', { class: 'disc-detail' });
    wrap.append(this.artistHero(artist));
    if (artist.hotSongs.length > 0) {
      wrap.append(h('div', { class: 'disc-sub-title', text: `热门歌曲 · ${artist.hotSongs.length} 首` }));
      wrap.append(this.trackList(artist.hotSongs));
    }
    if (artist.albums.length > 0) wrap.append(this.artistAlbums(artist));
    if (artist.hotSongs.length === 0 && artist.albums.length === 0) {
      wrap.append(this.emptyBox('该歌手暂无可展示的内容'));
    }
    return wrap;
  }

  private artistHero(artist: DiscoverArtist): HTMLElement {
    const meta = [
      artist.followed ? '已收藏' : '',
      `${artist.hotSongs.length} 首热门歌曲`,
      `${artist.albums.length} 张专辑`,
    ]
      .filter(Boolean)
      .join(' · ');
    return this.hero({
      cover: artist.avatar || artist.cover,
      round: true,
      kicker: `${SOURCE_LABEL[artist.source] ?? artist.source} · 歌手`,
      title: artist.name,
      meta,
      desc: this.descBlock(artist.description),
      actions: artist.hotSongs.length > 0 ? this.playAllButton(artist.hotSongs, '播放热门歌曲') : undefined,
    });
  }

  private artistAlbums(artist: DiscoverArtist): HTMLElement {
    const section = h(
      'section',
      { class: ui.section() },
      h('div', { class: ui.sectionHead() }, h('h3', { class: ui.sectionTitle(), text: '专辑' })),
    );
    const grid = h('div', { class: 'disc-grid' });
    for (const album of artist.albums) {
      const meta = [album.year, album.count > 0 ? `${album.count} 首` : ''].filter(Boolean).join(' · ');
      const btn = this.tile(album.cover, album.title, meta, () =>
        this.navigate({ kind: 'album', source: artist.source, id: album.id }),
      );
      grid.append(btn);
    }
    section.append(grid);
    return section;
  }

  /* --------------------------------- 专辑 ---------------------------------- */

  private async buildAlbumPage(source: string, id: string, seq: number): Promise<HTMLElement> {
    const album = await fetchAlbum(source, id);
    if (seq !== this.seq) return h('div');
    const wrap = h('div', { class: 'disc-detail' });
    wrap.append(this.albumHero(album));
    if (album.tracks.length === 0) {
      wrap.append(this.emptyBox('这张专辑暂时没有可播放的曲目'));
      return wrap;
    }
    wrap.append(h('div', { class: 'disc-sub-title', text: `曲目 · ${album.tracks.length} 首` }));
    wrap.append(this.trackList(album.tracks));
    return wrap;
  }

  private albumHero(album: DiscoverAlbum): HTMLElement {
    const meta = h('div', { class: 'disc-hero-meta' });
    const artistId = album.artistId;
    if (artistId) {
      const link = h('button', { class: 'disc-link', type: 'button', text: album.artist });
      link.addEventListener('click', () => this.navigate({ kind: 'artist', source: album.source, id: artistId }));
      meta.append(link);
    } else {
      meta.append(h('span', { text: album.artist }));
    }
    const year = [album.year, `${album.tracks.length} 首`].filter(Boolean).join(' · ');
    if (year) meta.append(h('span', { class: 'disc-sep', text: ' · ' }), h('span', { text: year }));
    return this.hero({
      cover: album.cover,
      kicker: `${SOURCE_LABEL[album.source] ?? album.source} · 专辑`,
      title: album.title,
      metaNode: meta,
      desc: this.descBlock(album.description),
      actions: album.tracks.length > 0 ? this.playAllButton(album.tracks, '播放全部') : undefined,
    });
  }

  /* -------------------------------- 通用组件 -------------------------------- */

  private backBar(): HTMLElement {
    const bar = h('div', { class: 'disc-crumb' });
    const back = h('button', { class: 'disc-back', type: 'button', title: '返回发现' }, icon('chevron', 16), h('span', { text: '返回发现' }));
    back.addEventListener('click', () => this.goBack());
    bar.append(back);
    return bar;
  }

  private hero(options: {
    cover?: string;
    round?: boolean;
    kicker: string;
    title: string;
    meta?: string;
    metaNode?: HTMLElement;
    desc?: HTMLElement | null;
    actions?: HTMLElement;
  }): HTMLElement {
    const art = this.coverBox(
      options.cover,
      options.round ? 'disc-hero-art is-round' : 'disc-hero-art',
      options.round ? 34 : 30,
      options.title,
    );
    const info = h('div', { class: 'disc-hero-info' });
    info.append(
      h('div', { class: 'disc-kicker', text: options.kicker }),
      h('h2', { class: 'disc-hero-title', text: options.title }),
    );
    if (options.metaNode) info.append(options.metaNode);
    else if (options.meta) info.append(h('div', { class: 'disc-hero-meta', text: options.meta }));
    if (options.desc) info.append(options.desc);
    if (options.actions) info.append(options.actions);
    return h('div', { class: 'disc-hero' }, art, info);
  }

  private tile(cover: string | undefined, name: string, meta: string, onClick: () => void): HTMLButtonElement {
    const btn = h(
      'button',
      { class: ui.tile(), type: 'button', title: name },
      this.coverBox(cover, ui.tileCover(), 24, name),
      h('span', { class: ui.tileName(), text: name }),
      h('span', { class: ui.tileMeta(), text: meta || ' ' }),
    );
    btn.addEventListener('click', onClick);
    return btn;
  }

  private coverBox(url: string | undefined | null, className: string, iconSize = 24, seed?: string): HTMLElement {
    const box = h('span', { class: className });
    const fallback = seed ? gradientCover(seed) : null;
    const src = discoverCover(url) || fallback;
    if (src) {
      const img = h('img', { src, loading: 'lazy', alt: '' });
      img.addEventListener('error', () => {
        img.remove();
        if (fallback) {
          box.append(h('img', { src: fallback, alt: '' }));
        } else {
          box.append(icon('music', iconSize));
        }
      });
      box.append(img);
    } else {
      box.append(icon('music', iconSize));
    }
    return box;
  }

  private descBlock(text: string): HTMLElement | null {
    if (!text) return null;
    const desc = h('p', { class: 'disc-desc', text, title: '点击展开 / 收起简介' });
    desc.addEventListener('click', () => desc.classList.toggle('is-open'));
    return desc;
  }

  private playAllButton(tracks: DiscoverTrack[], label: string): HTMLButtonElement {
    const btn = h(
      'button',
      { class: ui.btn({ variant: 'primary', size: 'sm' }), type: 'button' },
      icon('play', 14),
      h('span', { text: label }),
    );
    btn.disabled = tracks.length === 0;
    btn.addEventListener('click', () => {
      if (tracks.length > 0) this.handlers.play(tracks, 0);
    });
    return btn;
  }

  private trackList(tracks: DiscoverTrack[]): HTMLDivElement {
    const list = h('div', { class: 'disc-track-list' });
    tracks.forEach((track, index) => list.append(this.trackRow(track, tracks, index)));
    return list;
  }

  private trackRow(track: DiscoverTrack, queue: DiscoverTrack[], index: number): HTMLDivElement {
    const row = h('div', { class: 'disc-track' });

    const play = h('button', { class: 'disc-row-btn', type: 'button', title: '播放' }, icon('play', 13));
    play.addEventListener('click', (event) => {
      event.stopPropagation();
      this.handlers.play(queue, index);
    });

    const comment = h('button', { class: 'disc-row-btn disc-cmt', type: 'button', title: '评论' }, icon('comment', 15));
    comment.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openComments(track);
    });

    const info = h('button', { class: 'disc-row-btn disc-info', type: 'button', title: '歌曲信息' }, icon('info', 15));
    info.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openSongInfo(track, row);
    });

    const titleLine = h(
      'div',
      { class: 'disc-t-title' },
      h('span', { class: 'disc-t-name', text: track.title }),
      track.vip ? h('span', { class: 'disc-vip', text: 'VIP' }) : null,
    );

    const sub = h('div', { class: 'disc-t-sub' });
    const artistId = track.artistId;
    if (artistId) {
      const link = h('button', { class: 'disc-link', type: 'button', text: track.artist || '未知歌手' });
      link.addEventListener('click', (event) => {
        event.stopPropagation();
        this.navigate({ kind: 'artist', source: track.source, id: artistId });
      });
      sub.append(link);
    } else {
      sub.append(h('span', { text: track.artist || '未知歌手' }));
    }
    const albumId = track.albumId;
    if (track.album) {
      sub.append(h('span', { class: 'disc-sep', text: ' · ' }));
      if (albumId) {
        const link = h('button', { class: 'disc-link', type: 'button', text: track.album });
        link.addEventListener('click', (event) => {
          event.stopPropagation();
          this.navigate({ kind: 'album', source: track.source, id: albumId });
        });
        sub.append(link);
      } else {
        sub.append(h('span', { text: track.album }));
      }
    }

    row.append(
      h('span', { class: 'disc-idx', text: String(index + 1).padStart(2, '0') }),
      this.coverBox(track.cover || undefined, 'disc-cover-sm', 18, track.title),
      h('div', { class: 'disc-t-meta' }, titleLine, sub),
      this.sourceTag(track.source),
      h('span', { class: 'disc-dur', text: fmtTime(track.durationMs) }),
      play,
      info,
      comment,
    );
    row.addEventListener('click', () => this.handlers.play(queue, index));
    return row;
  }

  private sourceTag(source: string): HTMLElement {
    const meta = sourceMeta(source);
    const tag = h('span', { class: 'source-tag', text: meta.short || meta.label || source });
    tag.style.setProperty('--src-accent', meta.accent);
    return tag;
  }

  /* --------------------------------- 评论 ---------------------------------- */

  /** 歌曲信息：按设置走「整页详情」或「列表内展开」。 */
  private openSongInfo(track: DiscoverTrack, row: HTMLElement): void {
    void songInfoView;
    openSongInfo(
      {
        source: track.source,
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        cover: track.cover,
      },
      {
        row,
        host: this.host,
        onArtist: (source, artistId) => this.navigate({ kind: 'artist', source, id: artistId }),
        onAlbum: (source, albumId) => this.navigate({ kind: 'album', source, id: albumId }),
      },
    );
  }

  private openComments(track: DiscoverTrack): void {
    this.handlers.openSheet(`评论 · ${track.title}`, (body) => {
      this.buildComments(body, track.source, track.id);
    });
  }

  private buildComments(body: HTMLDivElement, source: string, songId: string): void {
    const totalEl = h('span', { class: 'disc-total', text: '评论加载中…' });
    const head = h(
      'div',
      { class: 'disc-comments-head' },
      totalEl,
      h('span', { class: 'disc-src-label', text: SOURCE_LABEL[source] ?? source }),
    );
    const list = h('div', { class: 'disc-comments' });
    const more = h('div', { class: 'disc-more' });
    body.append(head, list, more);

    let offset = 0;
    let loading = false;
    let exhausted = false;

    const load = (): void => {
      if (loading || exhausted) return;
      loading = true;
      const current = more.querySelector('button');
      if (current) {
        current.disabled = true;
        current.textContent = '加载中…';
      }
      void (async () => {
        try {
          const data = await fetchComments(source, songId, offset, 20);
          offset += data.comments.length;
          exhausted = !data.hasMore || data.comments.length === 0;
          totalEl.textContent = `共 ${fmtCount(data.total)} 条评论`;
          if (data.comments.length === 0) {
            if (list.childElementCount === 0) list.append(this.emptyBox('还没有评论'));
          } else {
            for (const comment of data.comments) list.append(this.commentNode(comment));
          }
          more.textContent = '';
          if (!exhausted) {
            const btn = h('button', { class: ui.btn({ size: 'sm' }), type: 'button', text: '加载更多' });
            btn.addEventListener('click', () => load());
            more.append(btn);
          } else if (offset > 0) {
            more.append(h('div', { class: 'disc-foot-note', text: '已加载全部评论' }));
          }
        } catch (err) {
          if (isUnsupported(err)) {
            totalEl.textContent = '该平台暂不支持评论';
            toast('该平台暂不支持评论', 'error');
          } else {
            toast(discoverErrorText(err, '评论加载失败'), 'error');
            if (list.childElementCount === 0) list.append(this.errorBox(err));
          }
        } finally {
          loading = false;
        }
      })();
    };
    load();
  }

  private commentNode(comment: DiscoverComment): HTMLElement {
    const avatar = h('span', { class: 'disc-c-avatar' });
    const src = discoverCover(comment.avatar);
    if (src) {
      const img = h('img', { src, loading: 'lazy', alt: '' });
      img.addEventListener('error', () => {
        img.remove();
        avatar.append(icon('user', 16));
      });
      avatar.append(img);
    } else {
      avatar.append(icon('user', 16));
    }
    const head = h('div', { class: 'disc-c-head' }, h('span', { class: 'disc-c-user', text: comment.user }));
    if (comment.hot) head.append(h('span', { class: 'disc-hot', text: '热评' }));
    const time = formatCommentTime(comment.time);
    if (time) head.append(h('span', { class: 'disc-c-time', text: time }));
    return h(
      'div',
      { class: 'disc-comment' },
      avatar,
      h(
        'div',
        { class: 'disc-c-body' },
        head,
        h('p', { class: 'disc-c-text', text: comment.content }),
        h('div', { class: 'disc-c-foot' }, icon('heart', 12), h('span', { text: fmtCount(comment.liked) })),
      ),
    );
  }

  /* -------------------------------- 状态占位 -------------------------------- */

  private loadingBox(text = '正在加载…'): HTMLElement {
    return h('div', { class: 'disc-loading' }, h('span', { class: 'disc-spinner' }), h('span', { text }));
  }

  private emptyBox(title: string, hint?: string): HTMLElement {
    return h(
      'div',
      { class: 'disc-empty' },
      h('div', { class: 'disc-empty-title', text: title }),
      hint ? h('div', { class: 'disc-empty-hint', text: hint }) : null,
    );
  }

  private errorBox(err: unknown): HTMLElement {
    if (isLoginRequired(err)) {
      return this.emptyBox('需要登录网易云音乐', '登录后即可使用私人漫游 / 收藏 / 评论');
    }
    const retry = h('button', { class: ui.btn({ size: 'sm' }), type: 'button', text: '重试' });
    retry.addEventListener('click', () => {
      void this.render();
    });
    return h(
      'div',
      { class: 'disc-empty' },
      h('div', { class: 'disc-empty-title', text: discoverErrorText(err) }),
      retry,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

/** 评论时间：兼容时间戳秒/毫秒与已格式化的字符串。 */
function formatCommentTime(value: string): string {
  const text = (value || '').trim();
  if (!text) return '';
  if (/^\d{10}$/.test(text)) return shortDate(new Date(Number(text) * 1000));
  if (/^\d{13}$/.test(text)) return shortDate(new Date(Number(text)));
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return text;
}

function shortDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  if (year === new Date().getFullYear()) return `${month}-${day}`;
  return `${year}-${month}-${day}`;
}
