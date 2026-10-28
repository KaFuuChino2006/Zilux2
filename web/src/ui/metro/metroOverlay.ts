/**
 * 音乐地铁图 · 应用内全屏入口（覆盖层）。
 *
 * 用户方向（2026-10-28 晚，第二轮）：
 *   「我要的不是点击之后进去展开，而是点击的图标本身就是一个站，点击之后自动延伸出去」
 * 因此这里只有一层画布，不再有「分类页 / 线路页」两级导航：
 *   - 左侧一条竖直主干线上排着 5 座大图标车站（收藏 / 推荐 / 历史播放 / 热门歌单 / 私人雷达）；
 *   - 点某个大图标 = 点那座车站：对应的线路立刻从图标里向右侧生长出来（站点依次弹出）；
 *   - 再点一次同一座大图标，这条线路收回；多条线路可以同时展开；
 *   - 点任意小站点弹出歌曲卡（播放 / 加入队列），当前播放曲的站点会亮起。
 *
 * 同时保留：加载 / 空 / 失败三态 + 重试、Esc 逐级（卡片 → 全部收回 → 关闭）、
 * 焦点恢复、窗口自适应（ResizeObserver），以及资源释放。
 */

import { SOURCE_LABEL } from '../../online/sources';
import type { OnlineTrack } from '../../online/types';
import { h, icon, toast } from '../dom';
import { onPlayer, playerState, playQueue, replaceQueue } from '../player';
import { buildGalleryEntries } from './metroGallery';
import type { MetroGalleryEntry } from './metroGallery';
import { loadMetroData } from './metroData';
import { mockMetroData } from './metroPreview';
import { applyMetroTheme, resolveMetroTheme } from './metroTheme';
import type { MetroSong } from './types';

/** 开发/演示开关：`?metroMock=1` 时用 M1 假数据，未登录环境也能预演。 */
const MOCK_PARAM = 'metroMock';

/** 覆盖层 aria-label。 */
const OVERLAY_LABEL = '音乐地铁图';

/* ------------------------------------------------------------------ */
/* 布局常量（CSS 像素，与设计稿一致）                                    */
/* ------------------------------------------------------------------ */

/** 主干线所在的 x（大图标车站中心）。 */
const HUB_COLUMN_X = 236;
/** 大图标徽章直径（DOM 按钮）与 SVG 外环半径。 */
const HUB_BADGE_SIZE = 64;
const HUB_RING_RADIUS = 40;
/** 第一条小站点相对主干线的水平距离。 */
const BRANCH_START_GAP = 128;
/** 支线右端留白。 */
const BRANCH_TAIL_PAD = 92;
/** 首行中心 y 与底部留白（窄窗口时按比例压缩）。 */
const BOARD_TOP_Y = 216;
const BOARD_BOTTOM_PAD = 132;
/** 支线生长动画时长与站点依次弹出的间隔。 */
const GROW_MS = 620;
const STAGGER_MS = 26;
/** 歌曲卡尺寸（用于贴边翻转与避让）。 */
const CARD_WIDTH = 336;
const CARD_HEIGHT = 150;

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------------ */
/* 单例状态                                                            */
/* ------------------------------------------------------------------ */

/** 当前已打开的覆盖层；非 null 表示已打开（重复调用幂等）。 */
let active: { close: () => void } | null = null;

/* ------------------------------------------------------------------ */
/* 纯函数辅助                                                          */
/* ------------------------------------------------------------------ */

/** 播放器曲目唯一键：`${source}:${id}`（与地铁站点 trackKey 同构）。 */
function playerTrackKey(track: OnlineTrack): string {
  return `${track.source}:${track.id}`;
}

/** MetroSong → 播放器队列条目。 */
function toTrack(song: MetroSong): OnlineTrack {
  return {
    source: song.source,
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album ?? '',
    durationMs: song.durationMs,
    cover: song.coverUrl ?? '',
    playable: true,
  };
}

/** 毫秒 → `m:ss`。 */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 平台显示名（宿主下发前用前端兜底表）。 */
function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

/** 创建 SVG 元素并写入属性。 */
function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

/** 创建 SVG 文本节点。 */
function svgText(content: string, attrs: Record<string, string | number> = {}): SVGTextElement {
  const el = svgEl('text', attrs);
  el.textContent = content;
  return el;
}

/** 是否走假数据演示模式。 */
function wantsMockData(): boolean {
  try {
    return new URL(location.href).searchParams.get(MOCK_PARAM) === '1';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 几何                                                               */
/* ------------------------------------------------------------------ */

interface BoardGeometry {
  width: number;
  height: number;
  hubX: number;
  /** 每座大图标车站的中心 y（与 entries 一一对应）。 */
  rows: readonly number[];
  /** 支线第一座小站与最后一站的中心 x。 */
  branchStart: number;
  branchEnd: number;
}

/** 按画布尺寸算主干线 / 支线的位置；纯函数，便于测试。 */
function computeGeometry(width: number, height: number, count: number): BoardGeometry {
  const hubX = width >= 1120 ? HUB_COLUMN_X : Math.max(150, Math.round(width * 0.19));
  const top = Math.min(BOARD_TOP_Y, Math.max(158, height * 0.24));
  const bottom = Math.max(top + Math.max(200, count * 40), height - BOARD_BOTTOM_PAD);
  const gap = count > 1 ? (bottom - top) / (count - 1) : 0;
  const rows: number[] = [];
  for (let index = 0; index < count; index += 1) rows.push(Math.round(top + gap * index));
  const branchStart = hubX + BRANCH_START_GAP;
  const branchEnd = Math.max(branchStart + 180, width - BRANCH_TAIL_PAD);
  return { width, height, hubX, rows, branchStart, branchEnd };
}

/** 某条支线上第 index 座小站的 x。 */
function stationX(geo: BoardGeometry, count: number, index: number): number {
  if (count <= 1) return geo.branchStart;
  return geo.branchStart + ((geo.branchEnd - geo.branchStart) / (count - 1)) * index;
}

/* ------------------------------------------------------------------ */
/* 覆盖层                                                              */
/* ------------------------------------------------------------------ */

/**
 * 打开音乐地铁图全屏覆盖层；重复调用幂等。
 *
 * 打开后：加载数据 → 画主干线与 5 座大图标车站 → 用户点图标展开 / 收回支线。
 */
export function openMetroOverlay(): void {
  if (active) return;

  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const theme = resolveMetroTheme('auto');

  // ── DOM 骨架 ────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.className = 'metro-overlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', OVERLAY_LABEL);
  root.tabIndex = -1;
  applyMetroTheme(root, theme);
  // 动画时长通过 CSS 变量下发给样式表（生长 / 站点弹出间隔）。
  root.style.setProperty('--mh-grow', `${GROW_MS}ms`);
  root.style.setProperty('--mh-stagger', `${STAGGER_MS}ms`);

  const board = document.createElement('div');
  board.className = 'metro-overlay-board';

  const head = h(
    'header',
    { class: 'mh-head' },
    h('p', { class: 'mh-kicker', text: '音乐地铁图' }),
    h('h1', { class: 'mh-title', text: '点一下板块，线路会从图标里长出来' }),
    h('p', { class: 'mh-sub', text: '五座大图标车站就是五个板块；再点一次可以收回。' }),
  );

  const svg = svgEl('svg', { class: 'mh-svg', role: 'group', 'aria-label': '分类主干线与支线' });

  const hubLayer = document.createElement('div');
  hubLayer.className = 'mh-hubs';

  const cardLayer = document.createElement('div');
  cardLayer.className = 'mh-cards';

  const hint = h('p', {
    class: 'mh-hint',
    text: '点大图标展开 / 收回 · 点站点查看歌曲 · Esc 逐级返回',
  });

  board.append(head, svg, hubLayer, cardLayer, hint);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'metro-overlay-close';
  closeBtn.title = '关闭（Esc）';
  closeBtn.textContent = '关闭';

  const stateLayer = document.createElement('div');
  stateLayer.className = 'metro-overlay-state';
  stateLayer.setAttribute('role', 'status');
  stateLayer.setAttribute('aria-live', 'polite');

  root.append(board, stateLayer, closeBtn);
  document.body.append(root);
  root.focus({ preventScroll: true });

  // ── 运行时状态 ─────────────────────────────────────────────────────
  let disposed = false;
  let loadVersion = 0;
  let entries: MetroGalleryEntry[] | null = null;
  let geo: BoardGeometry | null = null;
  let resizeRaf = 0;

  /** 已展开的板块（线路 id → 支线 SVG 组）。 */
  const expanded = new Map<string, SVGGElement>();
  /** 大图标按钮（线路 id → 按钮 + 标题节点）。 */
  const hubs = new Map<string, { button: HTMLButtonElement; label: HTMLElement }>();
  /** 当前打开的歌曲卡所在站点（entryId + 站序）。 */
  let cardAt: { entryId: string; index: number } | null = null;
  let offPlayer: (() => void) | null = null;

  const trunkLayer = svgEl('g', { class: 'mh-trunk-layer' });
  const branchLayer = svgEl('g', { class: 'mh-branch-layer' });
  const ringLayer = svgEl('g', { class: 'mh-ring-layer' });
  svg.append(trunkLayer, branchLayer, ringLayer);

  // ── 状态层：加载 / 空 / 失败 ────────────────────────────────────────
  type LoadState = 'loading' | 'empty' | 'error';

  function showState(kind: LoadState): void {
    const content = document.createDocumentFragment();
    if (kind === 'loading') {
      content.append(h('span', { class: 'metro-overlay-spinner', 'aria-hidden': 'true' }));
      content.append(h('p', { class: 'metro-overlay-state-text', text: '正在生成线路图…' }));
    } else {
      const isError = kind === 'error';
      content.append(
        h('p', {
          class: 'metro-overlay-state-title',
          text: isError ? '线路图加载失败' : '还没有足够的听歌数据',
        }),
      );
      content.append(
        h('p', {
          class: 'metro-overlay-state-text',
          text: isError ? '请稍后重试，或查看控制台日志。' : '多收藏、多听一些歌，再回来看看。',
        }),
      );
      const retry = h('button', { class: 'btn metro-overlay-retry', type: 'button', text: '重试' });
      retry.addEventListener('click', () => {
        void load();
      });
      content.append(retry);
    }
    stateLayer.replaceChildren(content);
    stateLayer.dataset.state = kind;
    stateLayer.hidden = false;
  }

  function hideState(): void {
    stateLayer.hidden = true;
    stateLayer.replaceChildren();
  }

  // ── 大图标车站（DOM 按钮 + SVG 外环 + 下方标题）─────────────────────
  function createHubNode(entry: MetroGalleryEntry): void {
    const tone = theme.tones[entry.tone];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mh-hub';
    button.dataset.entry = entry.id;
    button.dataset.tone = entry.tone;
    button.style.setProperty('--mh-tone', tone.base);
    button.style.setProperty('--mh-tone-glow', tone.glow);
    button.style.setProperty('--mh-tone-soft', tone.soft);
    button.setAttribute('aria-label', `${entry.title}：${entry.subtitle} · ${entry.count} 首`);
    button.setAttribute('aria-expanded', 'false');
    button.append(
      h('span', { class: 'mh-hub-badge', 'aria-hidden': 'true' }, icon(entry.iconName, 28)),
    );
    button.append(h('span', { class: 'mh-hub-count', 'aria-hidden': 'true', text: String(entry.count) }));

    const label = h(
      'span',
      { class: 'mh-hub-text', 'aria-hidden': 'true' },
      h('span', { class: 'mh-hub-title', text: entry.title }),
      h('span', { class: 'mh-hub-sub', text: entry.subtitle }),
    );

    hubLayer.append(button, label);
    hubs.set(entry.id, { button, label });
  }

  /** 重画主干线、大图标外环与标题位置（不含支线）。 */
  function renderStatic(): void {
    if (geo === null || entries === null) return;
    const { width, height } = geo;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    trunkLayer.replaceChildren();
    ringLayer.replaceChildren();

    const first = geo.rows[0] ?? 0;
    const last = geo.rows[geo.rows.length - 1] ?? 0;
    trunkLayer.append(
      svgEl('path', {
        class: 'mh-trunk',
        d: `M ${geo.hubX} ${first - HUB_RING_RADIUS - 26} L ${geo.hubX} ${last + HUB_RING_RADIUS + 26}`,
      }),
    );

    entries.forEach((entry, index) => {
      const rowY = geo?.rows[index] ?? 0;
      const tone = theme.tones[entry.tone];
      const ring = svgEl('circle', {
        class: 'mh-hub-ring',
        cx: geo?.hubX ?? 0,
        cy: rowY,
        r: HUB_RING_RADIUS,
      });
      ring.style.setProperty('--mh-tone', tone.base);
      ring.style.setProperty('--mh-tone-soft', tone.soft);
      ringLayer.append(ring);

      const node = hubs.get(entry.id);
      if (node) {
        node.button.style.left = `${geo?.hubX ?? 0}px`;
        node.button.style.top = `${rowY}px`;
        // 标题放在徽章左侧右对齐，避免与竖直主干线重叠。
        node.label.style.left = `${(geo?.hubX ?? 0) - HUB_BADGE_SIZE / 2 - 22}px`;
        node.label.style.top = `${rowY}px`;
      }
    });
  }

  // ── 支线（生长 / 收回）─────────────────────────────────────────────
  /**
   * 生成一条支线：路径 + 站点 + 站名。
   * animate=true 时播放「线条生长 + 站点依次弹出」；false 用于窗口尺寸变化后重排。
   */
  function createBranch(entry: MetroGalleryEntry, index: number, animate: boolean): SVGGElement {
    const rowY = geo?.rows[index] ?? 0;
    const count = entry.songs.length;
    const group = svgEl('g', {
      class: animate ? 'mh-line is-entering' : 'mh-line is-static',
      'data-entry': entry.id,
    });
    group.style.setProperty('--mh-tone', theme.tones[entry.tone].base);
    group.style.setProperty('--mh-tone-soft', theme.tones[entry.tone].soft);

    const startX = (geo?.hubX ?? 0) + HUB_RING_RADIUS - 6;
    const endX = geo?.branchEnd ?? 0;
    const path = svgEl('path', {
      class: 'mh-line-path',
      d: `M ${startX} ${rowY} L ${endX} ${rowY}`,
    });
    const length = Math.max(0, endX - startX);
    path.style.strokeDasharray = String(length);
    path.style.strokeDashoffset = animate ? String(length) : '0';
    group.append(path);

    entry.songs.forEach((song, songIndex) => {
      const x = stationX(geo as BoardGeometry, count, songIndex);
      const above = songIndex % 2 === 0;
      const station = svgEl('g', {
        class: 'mh-station',
        'data-entry': entry.id,
        'data-index': String(songIndex),
        'data-key': song.trackKey,
        role: 'button',
        tabindex: '0',
        'aria-label': `${song.title} — ${song.artist}`,
        transform: `translate(${x} ${rowY})`,
      });
      station.style.setProperty('--mh-i', String(songIndex));
      station.append(
        svgEl('circle', { class: 'mh-station-halo', r: 15 }),
        svgEl('circle', { class: 'mh-station-dot', r: 7.5 }),
      );
      if (songIndex === 0 || songIndex === count - 1) station.classList.add('is-terminus');
      const label = svgText(song.title, {
        class: 'mh-station-label',
        x: 0,
        y: above ? -22 : 30,
        'text-anchor': 'middle',
      });
      station.append(label);
      group.append(station);
    });

    if (animate) {
      // 下一帧把 dashoffset 归零，让线条从图标处生长出去。
      requestAnimationFrame(() => {
        path.style.strokeDashoffset = '0';
      });
    }
    return group;
  }

  function addBranch(entryId: string): void {
    if (entries === null) return;
    const index = entries.findIndex((item) => item.id === entryId);
    if (index < 0) return;
    if (expanded.has(entryId)) return;
    const group = createBranch(entries[index], index, true);
    branchLayer.append(group);
    expanded.set(entryId, group);
    syncPlaying();
  }

  function removeBranch(entryId: string): void {
    const group = expanded.get(entryId);
    if (group) group.remove();
    expanded.delete(entryId);
    if (cardAt?.entryId === entryId) closeCard();
  }

  function toggleEntry(entryId: string): void {
    const node = hubs.get(entryId);
    const willOpen = !expanded.has(entryId);
    if (willOpen) {
      addBranch(entryId);
    } else {
      removeBranch(entryId);
    }
    node?.button.setAttribute('aria-expanded', String(willOpen));
    node?.button.classList.toggle('is-open', willOpen);
  }

  function collapseAll(): void {
    for (const entryId of [...expanded.keys()]) removeBranch(entryId);
    for (const [, node] of hubs) {
      node.button.setAttribute('aria-expanded', 'false');
      node.button.classList.remove('is-open');
    }
    closeCard();
  }

  // ── 歌曲卡 ────────────────────────────────────────────────────────
  function syncPlaying(): void {
    const track = playerState().track;
    const key = track ? playerTrackKey(track) : null;
    svg.querySelectorAll<SVGGElement>('.mh-station').forEach((station) => {
      station.classList.toggle('is-playing', key !== null && station.dataset.key === key);
    });
  }

  function playEntry(entry: MetroGalleryEntry, index: number): void {
    const tracks = entry.songs.map(toTrack);
    if (tracks.length === 0) return;
    playQueue(tracks, index, true);
    toast(`播放《${entry.songs[index]?.title ?? ''}》`);
  }

  function queueEntry(entry: MetroGalleryEntry, index: number): void {
    const song = entry.songs[index];
    if (song === undefined) return;
    const track = toTrack(song);
    const state = playerState();
    if (!state.track) {
      // 播放器空闲时不自动起播：只补齐队列并把它设为待播曲目。
      const nextQueue = [...state.queue, track];
      playQueue(nextQueue, nextQueue.length - 1, false);
    } else {
      replaceQueue([...state.queue, track]);
    }
    toast(`已加入队列：${song.title}`);
  }

  function closeCard(): void {
    if (cardAt === null && cardLayer.childElementCount === 0) return;
    cardAt = null;
    cardLayer.replaceChildren();
    root.classList.remove('is-card-open');
    svg.querySelectorAll<SVGGElement>('.mh-station').forEach((station) => {
      station.classList.remove('is-active');
    });
  }

  /** 渲染 / 重新定位歌曲卡（卡片内容由 cardAt 决定）。 */
  function renderCard(): void {
    if (cardAt === null || entries === null || geo === null) {
      cardLayer.replaceChildren();
      root.classList.remove('is-card-open');
      return;
    }
    const entry = entries.find((item) => item.id === cardAt?.entryId);
    if (entry === undefined) {
      closeCard();
      return;
    }
    const song = entry.songs[cardAt.index];
    if (song === undefined) {
      closeCard();
      return;
    }
    const rowIndex = entries.findIndex((item) => item.id === entry.id);
    const rowY = geo.rows[rowIndex] ?? 0;
    const x = stationX(geo, entry.songs.length, cardAt.index);

    const tone = theme.tones[entry.tone];
    const card = h('div', {
      class: 'mh-card',
      role: 'dialog',
      'aria-label': `${song.title} — ${song.artist}`,
    });
    card.style.setProperty('--mh-tone', tone.base);
    card.style.setProperty('--mh-tone-soft', tone.soft);

    const cover = h(
      'span',
      { class: 'mh-card-cover', 'aria-hidden': 'true' },
      h('span', { class: 'mh-card-cover-char', text: song.title.slice(0, 1) }),
    );
    const main = h(
      'span',
      { class: 'mh-card-main' },
      h('span', { class: 'mh-card-title', text: song.title }),
      h('span', { class: 'mh-card-artist', text: song.artist }),
      h('span', {
        class: 'mh-card-meta',
        text: `${sourceLabel(song.source)} · ${formatDuration(song.durationMs)} · ${entry.subtitle}`,
      }),
    );
    const playBtn = h('button', {
      type: 'button',
      class: 'mh-card-btn is-primary',
      text: '播放',
    }) as HTMLButtonElement;
    playBtn.addEventListener('click', () => {
      playEntry(entry, cardAt?.index ?? 0);
    });
    const queueBtn = h('button', {
      type: 'button',
      class: 'mh-card-btn',
      text: '加入队列',
    }) as HTMLButtonElement;
    queueBtn.addEventListener('click', () => {
      queueEntry(entry, cardAt?.index ?? 0);
    });
    const cardClose = h('button', {
      type: 'button',
      class: 'mh-card-close',
      title: '关闭',
      'aria-label': '关闭歌曲卡',
      text: '×',
    }) as HTMLButtonElement;
    cardClose.addEventListener('click', () => closeCard());

    card.append(
      h('span', { class: 'mh-card-top' }, cover, main),
      h('span', { class: 'mh-card-actions' }, playBtn, queueBtn),
      cardClose,
    );

    // 贴边翻转：默认放在站点右侧，右侧放不下时换到左侧；纵向限制在画布内。
    const preferRight = x + 22 + CARD_WIDTH <= geo.width - 16;
    const left = Math.max(16, Math.min(geo.width - CARD_WIDTH - 16, preferRight ? x + 22 : x - 22 - CARD_WIDTH));
    // 优先放在支线下方（避开站名行），下方放不下时翻到上方。
    const belowTop = rowY + 48;
    const preferBelow = belowTop + CARD_HEIGHT <= geo.height - 20;
    const top = Math.max(
      86,
      Math.min(geo.height - CARD_HEIGHT - 20, preferBelow ? belowTop : rowY - 48 - CARD_HEIGHT),
    );
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;

    cardLayer.replaceChildren(card);
    root.classList.add('is-card-open');
    svg.querySelectorAll<SVGGElement>('.mh-station').forEach((station) => {
      station.classList.toggle('is-active', station.dataset.key === song.trackKey);
    });
  }

  function openCard(entryId: string, index: number): void {
    cardAt = { entryId, index };
    renderCard();
  }

  // ── 重排（尺寸变化）───────────────────────────────────────────────
  function relayout(): void {
    if (disposed || entries === null) return;
    const width = board.clientWidth;
    const height = board.clientHeight;
    if (width < 2 || height < 2) return;
    geo = computeGeometry(width, height, entries.length);
    renderStatic();
    // 尺寸变化后重建已展开支线（不重播生长动画）。
    branchLayer.replaceChildren();
    expanded.clear();
    entries.forEach((entry, index) => {
      const node = hubs.get(entry.id);
      if (node?.button.getAttribute('aria-expanded') !== 'true') return;
      const group = createBranch(entry, index, false);
      branchLayer.append(group);
      expanded.set(entry.id, group);
    });
    renderCard();
    syncPlaying();
  }

  const resizeObserver = new ResizeObserver(() => {
    if (resizeRaf !== 0) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      relayout();
    });
  });

  // ── 事件 ──────────────────────────────────────────────────────────
  function onBoardClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    if (target.closest('.mh-card') !== null) return;

    const hub = target.closest<HTMLButtonElement>('.mh-hub');
    if (hub !== null) {
      const entryId = hub.dataset.entry;
      if (entryId !== undefined) toggleEntry(entryId);
      return;
    }
    const station = target.closest<SVGGElement>('.mh-station');
    if (station !== null) {
      const entryId = station.dataset.entry;
      const index = Number(station.dataset.index ?? '0');
      if (entryId !== undefined) openCard(entryId, index);
      return;
    }
    if (cardAt !== null) closeCard();
  }

  function onBoardKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    const station = target.closest<SVGGElement>('.mh-station');
    if (station === null) return;
    event.preventDefault();
    const entryId = station.dataset.entry;
    const index = Number(station.dataset.index ?? '0');
    if (entryId !== undefined) openCard(entryId, index);
  }

  function onEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (cardAt !== null) {
      event.preventDefault();
      closeCard();
      return;
    }
    if (expanded.size > 0) {
      event.preventDefault();
      collapseAll();
      return;
    }
    event.preventDefault();
    close();
  }

  // ── 加载 / 重试 ────────────────────────────────────────────────────
  async function load(): Promise<void> {
    if (disposed) return;
    const version = (loadVersion += 1);
    entries = null;
    geo = null;
    closeCard();
    hubLayer.replaceChildren();
    hubs.clear();
    branchLayer.replaceChildren();
    expanded.clear();
    trunkLayer.replaceChildren();
    ringLayer.replaceChildren();
    showState('loading');
    try {
      const metro = wantsMockData() ? mockMetroData() : await loadMetroData();
      if (disposed || version !== loadVersion) return;
      const next = buildGalleryEntries(metro);
      if (next.length === 0) {
        showState('empty');
        return;
      }
      entries = next;
      entries.forEach((entry) => createHubNode(entry));
      hideState();
      relayout();
      resizeObserver.observe(board);
    } catch (error) {
      if (disposed || version !== loadVersion) return;
      console.warn('[metro] 线路图数据加载失败，已展示失败态', error);
      entries = null;
      showState('error');
    }
  }

  // ── 关闭（幂等）────────────────────────────────────────────────────
  function close(): void {
    if (disposed) return;
    disposed = true;
    loadVersion += 1;
    resizeObserver.disconnect();
    if (resizeRaf !== 0) cancelAnimationFrame(resizeRaf);
    if (offPlayer) {
      offPlayer();
      offPlayer = null;
    }
    board.removeEventListener('click', onBoardClick);
    board.removeEventListener('keydown', onBoardKeyDown);
    closeBtn.removeEventListener('click', close);
    window.removeEventListener('keydown', onEscape, true);
    root.remove();
    active = null;
    if (previousFocus?.isConnected) {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch {
        // 焦点恢复失败不阻塞关闭。
      }
    }
  }

  board.addEventListener('click', onBoardClick);
  board.addEventListener('keydown', onBoardKeyDown);
  closeBtn.addEventListener('click', close);
  window.addEventListener('keydown', onEscape, true);
  active = { close };
  offPlayer = onPlayer(() => syncPlaying());

  void load();
}
