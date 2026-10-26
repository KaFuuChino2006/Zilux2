/**
 * 「歌曲信息」：两种呈现方式，用户可在「设置 → 歌曲信息样式」里切换。
 *
 *  - page  整页详情：大封面 + 歌名移到封面右侧，歌手 / 歌曲信息 / 音质以折叠组下拉展示；
 *  - inline 列表内展开：在点击的那一行下面就地展开同一套信息，其余行被推开。
 *
 * 数据来自 `/api/discover/song?source=&id=`（宿主 DiscoverService.GetSongInfoAsync），
 * 封面走 discoverCover() 补 token；歌手 / 专辑在调用方提供回调时渲染成可点链接。
 */

import { fmtTime, h, icon } from './dom';
import { discoverCover, discoverErrorText, fetchSongInfo, type DiscoverSong } from '../online/discover';

export type SongInfoView = 'page' | 'inline';

const VIEW_KEY = 'zilux2.songInfoView';

/** 读取用户选择的呈现方式（默认整页详情）。 */
export function songInfoView(): SongInfoView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'inline' ? 'inline' : 'page';
  } catch {
    return 'page';
  }
}

/** 写入呈现方式（设置页调用）。 */
export function setSongInfoView(view: SongInfoView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* 隐私模式忽略 */
  }
}

export interface SongInfoTarget {
  source: string;
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  cover?: string;
}

export interface SongInfoHandlers {
  onArtist?: (source: string, artistId: string) => void;
  onAlbum?: (source: string, albumId: string) => void;
  onClose?: () => void;
}

const SOURCE_NAME: Record<string, string> = {
  netease: '网易云音乐',
  qq: 'QQ 音乐',
  kugou: '酷狗音乐',
  local: '本地文件',
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function detailRow(label: string, value: HTMLElement | string | null | undefined): HTMLElement | null {
  if (!value) return null;
  return h(
    'div',
    { class: 'sd-row' },
    h('span', { class: 'sd-label', text: label }),
    typeof value === 'string' ? h('span', { class: 'sd-value', text: value }) : h('span', { class: 'sd-value' }, value),
  );
}

function linkButton(text: string, onClick: () => void): HTMLButtonElement {
  const button = h('button', { class: 'sd-link', type: 'button', text });
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function coverNode(song: DiscoverSong, size: number): HTMLElement {
  const art = h('div', { class: 'sd-cover', style: `--sd-cover-size:${size}px` });
  const cover = discoverCover(song.cover);
  if (cover) {
    const img = h('img', { src: cover, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => {
      img.remove();
      art.append(icon('music', Math.round(size / 3)));
    });
    art.append(img);
  } else {
    art.append(icon('music', Math.round(size / 3)));
  }
  return art;
}

function group(title: string, ...children: HTMLElement[]): HTMLDetailsElement {
  const details = h('details', { class: 'sd-group', open: true });
  details.append(h('summary', { class: 'sd-group-title' }, h('span', { text: title }), icon('chevron', 14)));
  const body = h('div', { class: 'sd-group-body' });
  children.forEach((child) => body.append(child));
  details.append(body);
  return details;
}


/** 头部速览：来源 / 时长 / 发行日期，用作右侧信息位。 */
function factChips(song: DiscoverSong): HTMLElement {
  const wrap = h('div', { class: 'sd-facts' });
  const facts = [
    SOURCE_NAME[song.source] ?? song.source,
    song.durationMs > 0 ? fmtTime(song.durationMs) : '',
    song.releaseDate,
  ].filter((text) => text.length > 0);
  facts.forEach((text) => wrap.append(h('span', { class: 'sd-fact', text })));
  return wrap;
}

function artistGroup(song: DiscoverSong, handlers: SongInfoHandlers): HTMLElement | null {
  if (song.artists.length === 0) return null;
  const list = h('div', { class: 'sd-artist-list' });
  song.artists.forEach((artist) => {
    const row = h('div', { class: 'sd-artist' }, h('span', { class: 'sd-artist-name', text: artist.name }));
    if (artist.id && handlers.onArtist) {
      row.append(linkButton('查看歌手页', () => handlers.onArtist?.(song.source, artist.id ?? '')));
    }
    list.append(row);
  });
  const node = group(`歌手信息 · ${song.artists.length} 位`, list);
  node.classList.add('is-artists');
  return node;
}

function metaGroup(song: DiscoverSong): HTMLDetailsElement {
  const grid = h('div', { class: 'sd-grid' });
  [
    detailRow('来源', SOURCE_NAME[song.source] ?? song.source),
    detailRow('时长', song.durationMs > 0 ? fmtTime(song.durationMs) : ''),
    detailRow('发行日期', song.releaseDate),
    detailRow('曲目', song.trackNo > 0 ? `第 ${song.trackNo} 首${song.discNo > 1 ? `（Disc ${song.discNo}）` : ''}` : ''),
    detailRow('语种', song.language),
    detailRow('风格', song.genre),
    detailRow('歌曲 ID', song.id),
    detailRow('官方链接', song.sourceUrl ? h('span', { class: 'sd-url', text: song.sourceUrl, title: song.sourceUrl }) : ''),
  ].forEach((row) => {
    if (row) grid.append(row);
  });
  const node = group('歌曲信息', grid);
  node.classList.add('is-meta');
  return node;
}

function qualityGroup(song: DiscoverSong): HTMLDetailsElement | null {
  if (song.qualities.length === 0) return null;
  const chips = h('div', { class: 'sd-quality' });
  song.qualities.forEach((quality) => {
    chips.append(
      h(
        'span',
        { class: 'sd-quality-chip' },
        h('span', { class: 'sd-quality-name', text: quality.name }),
        h('span', { class: 'sd-quality-size', text: `${(quality.sizeBytes / 1024 / 1024).toFixed(1)} MB` }),
      ),
    );
  });
  const node = group('音质', chips);
  node.classList.add('is-quality');
  return node;
}

/* ------------------------------------------------------------------ */
/* 整页详情                                                            */
/* ------------------------------------------------------------------ */

function renderPage(song: DiscoverSong, handlers: SongInfoHandlers): HTMLElement {
  const close = (): void => handlers.onClose?.();
  const back = h('button', { class: 'sd-back', type: 'button' }, icon('chevron', 16), h('span', { text: '返回' }));
  back.addEventListener('click', close);

  const hero = h(
    'div',
    { class: 'sd-hero' },
    coverNode(song, 188),
    h(
      'div',
      { class: 'sd-heading' },
      h(
        'div',
        { class: 'sd-title-line' },
        h('span', { class: 'sd-title', text: song.title }),
        song.vip ? h('span', { class: 'sd-vip', text: 'VIP' }) : null,
        !song.playable ? h('span', { class: 'sd-vip is-muted', text: '暂不可播' }) : null,
      ),
      buildArtistLine(song, handlers),
      h('div', { class: 'sd-album', text: [song.album, song.releaseDate].filter(Boolean).join(' · ') }),
      factChips(song),
    ),
  );

  const groups = h('div', { class: 'sd-groups' });
  const artists = artistGroup(song, handlers);
  if (artists) groups.append(artists);
  groups.append(metaGroup(song));
  const quality = qualityGroup(song);
  if (quality) groups.append(quality);

  return h('div', { class: 'song-detail' }, h('div', { class: 'sd-bar' }, back, h('span', { class: 'sd-kicker', text: '歌曲信息' })), hero, groups);
}

function buildArtistLine(song: DiscoverSong, handlers: SongInfoHandlers): HTMLElement {
  const line = h('div', { class: 'sd-artists' });
  song.artists.forEach((artist, index) => {
    if (index > 0) line.append(h('span', { class: 'sd-sep', text: ' / ' }));
    const artistId = artist.id ?? '';
    if (artistId && handlers.onArtist) {
      line.append(linkButton(artist.name, () => handlers.onArtist?.(song.source, artistId)));
    } else {
      line.append(h('span', { class: 'sd-artist-name', text: artist.name }));
    }
  });
  return line;
}

/** 挂载「整页详情」为居中浮窗（与设置弹窗同层），返回卸载函数。 */
export function mountSongInfoPage(target: SongInfoTarget, handlers: SongInfoHandlers = {}): () => void {
  const root = h('div', { class: 'sd-modal' });
  const panel = h('div', { class: 'sd-modal-panel' });
  const body = h('div', { class: 'sd-modal-body' });
  let closed = false;

  const dispose = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    // 先播 160ms 退场动画再移除节点，避免整页浮窗「啪」地消失。
    root.classList.add('is-closing');
    window.setTimeout(() => root.remove(), 170);
    handlers.onClose?.();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') dispose();
  };

  const close = h('button', { class: 'icon-btn', type: 'button', title: '关闭' }, icon('close', 16));
  close.addEventListener('click', dispose);

  panel.append(h('div', { class: 'sd-modal-head' }, h('div', { class: 'sd-modal-title', text: '歌曲信息' }), close), body);
  root.append(panel);
  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) dispose();
  });
  document.addEventListener('keydown', onKey);

  const loading = h('div', { class: 'sd-loading', text: '正在读取歌曲信息…' });
  body.append(loading);
  document.body.append(root);

  void fetchSongInfo(target.source, target.id)
    .then((song) => {
      loading.remove();
      body.append(renderPage(song, { ...handlers, onClose: dispose }));
    })
    .catch((err: unknown) => {
      loading.remove();
      body.append(
        h(
          'div',
          { class: 'sd-error' },
          h('div', { class: 'sd-error-title', text: '没能读到歌曲信息' }),
          h('div', { class: 'sd-error-text', text: discoverErrorText(err) }),
          h('div', { class: 'sd-error-fallback', text: `${target.title ?? '这首歌'}${target.artist ? ` — ${target.artist}` : ''}` }),
          (() => {
            const back = h('button', { class: 'btn', type: 'button', text: '返回' });
            back.addEventListener('click', dispose);
            return h('div', { class: 'sd-error-actions' }, back);
          })(),
        ),
      );
    });

  return dispose;
}

/* ------------------------------------------------------------------ */
/* 列表内展开                                                          */
/* ------------------------------------------------------------------ */

function renderInline(song: DiscoverSong, handlers: SongInfoHandlers, close: () => void): HTMLElement {
  const head = h(
    'div',
    { class: 'si-head' },
    coverNode(song, 130),
    h(
      'div',
      { class: 'si-heading' },
      h('div', { class: 'sd-title-line' }, h('span', { class: 'sd-title', text: song.title }), song.vip ? h('span', { class: 'sd-vip', text: 'VIP' }) : null),
      buildArtistLine(song, handlers),
      h('div', { class: 'sd-album', text: [song.album, song.releaseDate].filter(Boolean).join(' · ') }),
    ),
    factChips(song),
    (() => {
      const button = h('button', { class: 'si-close', type: 'button', title: '收起' }, icon('close', 15));
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        close();
      });
      return button;
    })(),
  );
  const groups = h('div', { class: 'sd-groups' });
  const artists = artistGroup(song, handlers);
  if (artists) groups.append(artists);
  groups.append(metaGroup(song));
  const quality = qualityGroup(song);
  if (quality) groups.append(quality);
  return h('div', { class: 'song-inline' }, head, groups);
}

/** 在 row 后面就地插入详情块，返回卸载函数（重复点同一行可切换收起）。 */
export function mountSongInfoInline(row: HTMLElement, target: SongInfoTarget, handlers: SongInfoHandlers = {}): () => void {
  const existing = row.nextElementSibling;
  if (existing instanceof HTMLElement && existing.classList.contains('si-panel')) {
    existing.remove();
    return () => undefined;
  }
  const panel = h('div', { class: 'si-panel' });
  const loading = h('div', { class: 'sd-loading', text: '正在读取歌曲信息…' });
  panel.append(loading);
  row.after(panel);
  requestAnimationFrame(() => panel.classList.add('is-open'));
  const dispose = (): void => {
    panel.classList.remove('is-open');
    window.setTimeout(() => panel.remove(), 220);
  };

  void fetchSongInfo(target.source, target.id)
    .then((song) => {
      loading.remove();
      panel.append(renderInline(song, handlers, dispose));
    })
    .catch((err: unknown) => {
      loading.remove();
      panel.append(
        h(
          'div',
          { class: 'sd-error is-inline' },
          h('div', { class: 'sd-error-title', text: '没能读到歌曲信息' }),
          h('div', { class: 'sd-error-text', text: discoverErrorText(err) }),
        ),
      );
    });

  return dispose;
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

export interface SongInfoOpenOptions extends SongInfoHandlers {
  /** 触发按钮所在的行；inline 模式必须有，page 模式不需要。 */
  row?: HTMLElement;
  /** page 模式的挂载宿主，一般是 app 的 .stage。 */
  host?: HTMLElement;
}

/** 按用户设置分发到整页详情（居中浮窗）/ 列表内展开。返回卸载函数。 */
export function openSongInfo(target: SongInfoTarget, options: SongInfoOpenOptions = {}): () => void {
  const handlers: SongInfoHandlers = {
    onArtist: options.onArtist,
    onAlbum: options.onAlbum,
    onClose: options.onClose,
  };
  if (songInfoView() === 'inline' && options.row) {
    return mountSongInfoInline(options.row, target, handlers);
  }
  return mountSongInfoPage(target, handlers);
}
