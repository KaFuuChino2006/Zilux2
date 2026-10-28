/**
 * 音乐地铁图 · 应用内全屏入口（覆盖层）。
 *
 * 用户方向（2026-10-28 晚，第二轮）：
 *   「我要的不是点击之后进去展开，而是点击的图标本身就是一个站，点击之后自动延伸出去」
 * 因此这里只有一层画布，不再有「分类页 / 线路页」两级导航：
 *   - 左侧竖直排着 5 座大图标车站（收藏 / 推荐 / 历史播放 / 热门歌单 / 私人雷达），
 *     图标是前三首歌封面的叠层，不再画灰色连线；
 *   - 点某个大图标 = 点那座车站：对应的线路立刻从图标里向右侧生长出来（站点依次弹出）；
 *   - 再点一次同一座大图标，这条线路收回；多条线路可以同时展开；
 *   - 点任意小站点弹出迷你歌曲卡（双击直接播放），当前播放曲的站点会亮起。
 *
 * 同时保留：加载 / 空 / 失败三态 + 重试、Esc 逐级（卡片 → 全部收回 → 关闭）、
 * 焦点恢复、窗口自适应（ResizeObserver），以及资源释放。
 */

import { SOURCE_LABEL } from '../../online/sources';
import type { OnlineTrack } from '../../online/types';
import { h, toast } from '../dom';
import { writeInterfaceMode } from '../interfaceMode';
import { onPlayer, playerState, playQueue } from '../player';
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

/** 大图标车站列所在的 x（大图标车站中心）。 */
const HUB_COLUMN_X = 236;
/** 大图标徽章边长（DOM 按钮，方形圆角，内部是封面叠层）。 */
const HUB_BADGE_SIZE = 68;
/** 第一条小站点相对主干线的水平距离。 */
const BRANCH_START_GAP = 128;
/** 支线右端留白。 */
const BRANCH_TAIL_PAD = 92;
/** 首行中心 y 与底部留白（窄窗口时按比例压缩）。 */
const BOARD_TOP_Y = 216;
const BOARD_BOTTOM_PAD = 210;
/** 支线生长动画时长与站点依次弹出的间隔。 */
const GROW_MS = 620;
const STAGGER_MS = 26;
/** 歌曲卡尺寸（用于贴边翻转与避让）。 */
const CARD_WIDTH = 236;
const CARD_HEIGHT = 92;
/** 布局编辑偏移上限（CSS 像素）：板块可左右/上下挪动，支线可上下挪动。 */
const EDIT_LIMIT_X = 150;
const EDIT_LIMIT_Y = 100;
/** 布局编辑的本地存储键（拖动后的位置下次打开沿用）。 */
const BOARD_EDIT_KEY = 'zilux2.metro.board';

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

/**
 * 站点唯一键：与播放器 `playerTrackKey` 同构（`source:id`）。
 * 真实数据里 `song.trackKey` 也是这个格式；假数据的 `trackKey` 是 `mock:n`，
 * 所以统一从 source/id 推导，保证「当前播放」高亮能命中站点。
 */
function songKey(song: MetroSong): string {
  return `${song.source}:${song.id}`;
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
/* 布局编辑（用户拖动调整板块与线路位置）                              */
/* ------------------------------------------------------------------ */

/** 单个板块的位置偏移（相对默认布局）。 */
interface BoardEdit {
  /** 大图标车站相对默认位置的偏移。 */
  hubDx: number;
  hubDy: number;
  /** 支线相对大图标车站的竖直偏移；非零时从图标处折出去。 */
  lineDy: number;
}

function clampEdit(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

/** 读取本地保存的布局编辑；数据损坏或存储不可用时用默认布局。 */
function readBoardEdits(): Map<string, BoardEdit> {
  const edits = new Map<string, BoardEdit>();
  try {
    const raw = localStorage.getItem(BOARD_EDIT_KEY);
    if (raw === null) return edits;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return edits;
    for (const [entryId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      const hubDx = typeof record.hubDx === 'number' ? record.hubDx : 0;
      const hubDy = typeof record.hubDy === 'number' ? record.hubDy : 0;
      const lineDy = typeof record.lineDy === 'number' ? record.lineDy : 0;
      if (!Number.isFinite(hubDx) || !Number.isFinite(hubDy) || !Number.isFinite(lineDy)) continue;
      edits.set(entryId, {
        hubDx: clampEdit(hubDx, EDIT_LIMIT_X),
        hubDy: clampEdit(hubDy, EDIT_LIMIT_Y),
        lineDy: clampEdit(lineDy, EDIT_LIMIT_Y),
      });
    }
  } catch {
    /* 存储不可用或数据损坏时用默认布局。 */
  }
  return edits;
}

/** 保存布局编辑（拖动结束时调用）。 */
function writeBoardEdits(edits: Map<string, BoardEdit>): void {
  try {
    localStorage.setItem(BOARD_EDIT_KEY, JSON.stringify(Object.fromEntries(edits)));
  } catch {
    /* 存储不可用时只在本次会话内生效。 */
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

/**
 * 某条支线上第 index 座小站的 x。
 * startOffset 用于板块被横向拖动时同步移动支线起点（终点保持贴住画布右侧）。
 */
function stationX(geo: BoardGeometry, count: number, index: number, startOffset = 0): number {
  const start = geo.branchStart + startOffset;
  if (count <= 1) return start;
  return start + ((geo.branchEnd - start) / (count - 1)) * index;
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
    text: '点大图标展开 / 收回 · 拖动大图标或支线调整位置 · 点站点查看歌曲 · 滚轮缩放 · 拖动空白处移动视角 · 双击复位 · Esc 逐级返回',
  });

  // 画布层：可整体拖动平移 / 缩放（主干线 / 支线 / 大图标 / 歌曲卡都在这层里）。
  const canvas = document.createElement('div');
  canvas.className = 'mh-canvas';
  canvas.append(svg, hubLayer, cardLayer);

  // 缩放控制条（固定右下角，避开底部播放条）。
  const zoomValue = h('span', { class: 'mh-zoom-value', 'aria-live': 'polite', text: '100%' });
  const zoomBar = h(
    'div',
    { class: 'mh-zoombar', role: 'group', 'aria-label': '缩放' },
    h('button', { class: 'mh-zoom-btn', type: 'button', 'data-act': 'out', title: '缩小', 'aria-label': '缩小', text: '−' }),
    zoomValue,
    h('button', { class: 'mh-zoom-btn', type: 'button', 'data-act': 'in', title: '放大', 'aria-label': '放大', text: '+' }),
    h('button', { class: 'mh-zoom-btn mh-zoom-reset', type: 'button', 'data-act': 'reset', title: '复位视角（也可双击空白处）', text: '复位' }),
    h('button', {
      class: 'mh-zoom-btn mh-zoom-reset',
      type: 'button',
      'data-act': 'reset-layout',
      title: '布局复位：把拖动过的板块与线路放回默认位置',
      text: '布局复位',
    }),
  );

  board.append(head, canvas, hint, zoomBar);

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
  // 挂到应用根内：`.app` 是 position:fixed（会建立堆叠上下文），播放条在其中；
  // 若挂到 body，覆盖层会整层盖住播放条，抬 z-index 也无效。
  (document.querySelector('.app') ?? document.body).append(root);
  // 打开地铁图时让底部播放条浮到覆盖层之上（用户要求播放条保持显示）。
  document.body.classList.add('is-metro-open');
  root.focus({ preventScroll: true });

  // ── 运行时状态 ─────────────────────────────────────────────────────
  let disposed = false;
  let loadVersion = 0;
  let entries: MetroGalleryEntry[] | null = null;
  let geo: BoardGeometry | null = null;
  let resizeRaf = 0;

  // 画布平移（拖动空白处移动视角）。
  let panX = 0;
  let panY = 0;
  let panPointerId: number | null = null;
  let panStartX = 0;
  let panStartY = 0;
  let panBaseX = 0;
  let panBaseY = 0;
  let panActive = false;
  let panAnimTimer = 0;
  // 画布缩放（滚轮 / 加减按钮 / 复位）。
  let zoom = 1;
  // 布局编辑：拖动大图标调整板块位置、拖动支线调整线路高度（结果本地保存）。
  const edits = readBoardEdits();
  let editMode: 'hub' | 'line' | null = null;
  let editPointerId: number | null = null;
  let editEntryId = '';
  let editStartX = 0;
  let editStartY = 0;
  let editBaseHubDx = 0;
  let editBaseHubDy = 0;
  let editBaseLineDy = 0;
  let editActive = false;
  let suppressClick = false;

  /** 已展开的板块（线路 id → 支线 SVG 组）。 */
  const expanded = new Map<string, SVGGElement>();
  /** 大图标按钮（线路 id → 按钮 + 标题节点）。 */
  const hubs = new Map<string, { button: HTMLButtonElement; label: HTMLElement }>();
  /** 当前打开的歌曲卡所在站点（entryId + 站序）。 */
  let cardAt: { entryId: string; index: number } | null = null;
  let offPlayer: (() => void) | null = null;

  const branchLayer = svgEl('g', { class: 'mh-branch-layer' });
  svg.append(branchLayer);

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

  // ── 大图标车站（DOM 按钮 + 封面叠层 + 左侧标题）─────────────────────
  /**
   * 单张封面：有真实封面时用 <img>，加载失败/无封面时回退到「首字 + 板块色」色块。
   * baseClass 同时决定子元素类名：`${base}-img` / `${base}-char`。
   */
  function coverNode(song: MetroSong, baseClass: string): HTMLElement {
    if (song.coverUrl) {
      const img = h('img', {
        class: `${baseClass}-img`,
        src: song.coverUrl,
        alt: '',
        loading: 'lazy',
        decoding: 'async',
      });
      img.addEventListener('error', () => {
        img.replaceWith(h('span', { class: `${baseClass}-char`, text: song.title.slice(0, 1) }));
      });
      return img;
    }
    return h('span', { class: `${baseClass}-char`, text: song.title.slice(0, 1) });
  }

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

    // 封面叠层：前三首歌的封面叠成一叠（后面的两层旋转露出边角）。
    const coverStack = h('span', { class: 'mh-hub-badge', 'aria-hidden': 'true' });
    entry.songs.slice(0, 3).forEach((song, index) => {
      coverStack.append(
        h(
          'span',
          { class: 'mh-hub-cover', 'data-i': String(index) },
          coverNode(song, 'mh-hub-cover'),
        ),
      );
    });
    button.append(coverStack);
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

  /** 取某板块的布局编辑（没有就建一份默认值）。 */
  function editOf(entryId: string): BoardEdit {
    let edit = edits.get(entryId);
    if (edit === undefined) {
      edit = { hubDx: 0, hubDy: 0, lineDy: 0 };
      edits.set(entryId, edit);
    }
    return edit;
  }

  /** 大图标当前位置（默认位置 + 用户拖动偏移）。 */
  function hubPosOf(index: number): { x: number; y: number } {
    if (geo === null || entries === null) return { x: 0, y: 0 };
    const entry = entries[index];
    const edit = entry === undefined ? { hubDx: 0, hubDy: 0 } : editOf(entry.id);
    return { x: geo.hubX + edit.hubDx, y: (geo.rows[index] ?? 0) + edit.hubDy };
  }

  /** 某条支线的竖直位置：支线默认与大图标同高，拖动线路后从图标处折出去。 */
  function linePosOf(index: number): { hubY: number; lineY: number } {
    if (geo === null || entries === null) return { hubY: 0, lineY: 0 };
    const entry = entries[index];
    const edit = entry === undefined ? { hubDy: 0, lineDy: 0 } : editOf(entry.id);
    const hubY = (geo.rows[index] ?? 0) + edit.hubDy;
    return { hubY, lineY: hubY + edit.lineDy };
  }

  /** 重画大图标与标题位置（不含支线）。 */
  function renderStatic(): void {
    if (geo === null || entries === null) return;
    const { width, height } = geo;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    entries.forEach((entry, index) => {
      const pos = hubPosOf(index);
      const node = hubs.get(entry.id);
      if (!node) return;
      node.button.style.left = `${pos.x}px`;
      node.button.style.top = `${pos.y}px`;
      // 标题放在徽章左侧右对齐，避免与线路重叠。
      node.label.style.left = `${pos.x - HUB_BADGE_SIZE / 2 - 22}px`;
      node.label.style.top = `${pos.y}px`;
    });
  }

  /** 重建某条已展开的支线（拖动时实时跟随，不播放入场动画）。 */
  function refreshBranch(entryId: string): void {
    if (entries === null) return;
    const index = entries.findIndex((entry) => entry.id === entryId);
    const current = expanded.get(entryId);
    if (index < 0 || current === undefined) return;
    const next = createBranch(entries[index], index, false);
    current.replaceWith(next);
    expanded.set(entryId, next);
  }

  /** 拖动过程中刷新所有受影响的位置（图标、标题、支线与歌曲卡）。 */
  function refreshEditedLayout(): void {
    if (entries === null) return;
    renderStatic();
    expanded.forEach((_group, entryId) => refreshBranch(entryId));
    if (cardAt !== null) renderCard();
  }

  /** 所有位置偏移归零并保存（缩放条上的「布局复位」）。 */
  function resetBoardEdits(): void {
    edits.forEach((edit) => {
      edit.hubDx = 0;
      edit.hubDy = 0;
      edit.lineDy = 0;
    });
    writeBoardEdits(edits);
    refreshEditedLayout();
  }

  // ── 支线（生长 / 收回）─────────────────────────────────────────────
  /**
   * 生成一条支线：路径 + 站点 + 站名。
   * animate=true 时播放「线条生长 + 站点依次弹出」；false 用于窗口尺寸变化后重排。
   */
  function createBranch(entry: MetroGalleryEntry, index: number, animate: boolean): SVGGElement {
    const pos = hubPosOf(index);
    const { hubY, lineY } = linePosOf(index);
    const edit = editOf(entry.id);
    const count = entry.songs.length;
    const group = svgEl('g', {
      class: animate ? 'mh-line is-entering' : 'mh-line is-static',
      'data-entry': entry.id,
    });
    group.style.setProperty('--mh-tone', theme.tones[entry.tone].base);
    group.style.setProperty('--mh-tone-soft', theme.tones[entry.tone].soft);

    const startX = pos.x + HUB_BADGE_SIZE / 2 - 2;
    const endX = geo?.branchEnd ?? 0;
    // 支线被拖动后与图标不同高：从图标处竖折一下再横出去（保持正交）。
    const d =
      Math.abs(lineY - hubY) < 0.5
        ? `M ${startX} ${lineY} L ${endX} ${lineY}`
        : `M ${startX} ${hubY} L ${startX} ${lineY} L ${endX} ${lineY}`;
    const path = svgEl('path', {
      class: 'mh-line-path',
      d,
    });
    const length = Math.max(0, endX - startX) + Math.abs(lineY - hubY);
    path.style.strokeDasharray = String(length);
    path.style.strokeDashoffset = animate ? String(length) : '0';
    group.append(path);

    entry.songs.forEach((song, songIndex) => {
      const x = stationX(geo as BoardGeometry, count, songIndex, edit.hubDx);
      const above = songIndex % 2 === 0;
      const station = svgEl('g', {
        class: 'mh-station',
        'data-entry': entry.id,
        'data-index': String(songIndex),
        'data-key': songKey(song),
        role: 'button',
        tabindex: '0',
        'aria-label': `${song.title} — ${song.artist}`,
        transform: `translate(${x} ${lineY})`,
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

  function closeCard(): void {
    if (cardAt === null && cardLayer.childElementCount === 0) return;
    cardAt = null;
    cardLayer.replaceChildren();
    root.classList.remove('is-card-open');
    svg.querySelectorAll<SVGGElement>('.mh-station').forEach((station) => {
      station.classList.remove('is-active');
    });
  }

  /** 渲染迷你的歌曲箭头卡：指向站点，含封面与歌曲信息；双击站点直接播放。 */
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
    const edit = editOf(entry.id);
    const { lineY } = linePosOf(rowIndex);
    const x = stationX(geo, entry.songs.length, cardAt.index, edit.hubDx);
    // 站名在偶数站上方、奇数站下方；箭头卡放在另一侧，避免压站名。
    const labelAbove = cardAt.index % 2 === 0;

    const tone = theme.tones[entry.tone];
    const tip = h('div', {
      class: 'mh-card',
      role: 'tooltip',
      'aria-label': `${song.title} — ${song.artist}`,
    });
    tip.style.setProperty('--mh-tone', tone.base);
    tip.style.setProperty('--mh-tone-soft', tone.soft);

    const cover = h(
      'span',
      { class: 'mh-card-cover', 'aria-hidden': 'true' },
      coverNode(song, 'mh-card-cover'),
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
      h('span', { class: 'mh-card-hint', text: '双击站点播放' }),
    );
    tip.append(cover, main);

    // 水平方向以站点居中，贴边时整体平移、箭头单独对准站点。
    const left = Math.max(16, Math.min(geo.width - CARD_WIDTH - 16, Math.round(x - CARD_WIDTH / 2)));
    const arrowX = Math.max(18, Math.min(CARD_WIDTH - 18, Math.round(x - left)));
    const below = labelAbove;
    let top = below ? lineY + 30 : lineY - 30 - CARD_HEIGHT;
    if (top < 88) top = lineY + 30;
    if (top + CARD_HEIGHT > geo.height - 24) top = lineY - 30 - CARD_HEIGHT;
    tip.classList.add(below ? 'is-below' : 'is-above');
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.style.setProperty('--mh-arrow-x', `${arrowX}px`);

    cardLayer.replaceChildren(tip);
    root.classList.add('is-card-open');
    svg.querySelectorAll<SVGGElement>('.mh-station').forEach((station) => {
      station.classList.toggle('is-active', station.dataset.key === songKey(song));
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
    if (panX !== 0 || panY !== 0 || zoom !== 1) applyView(false);
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
    // 拖动过大图标 / 支线后紧跟的 click 不算点击，避免误展开或误开卡。
    if (suppressClick) {
      suppressClick = false;
      return;
    }
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

  // ── 平移 / 缩放画布：拖动空白处移动视角、滚轮或按钮放大缩小 ────────
  /** 平移边界：允许拖出约三分之一屏，避免把线路拖丢（随缩放放大）。 */
  const PAN_LIMIT_X = 0.42;
  const PAN_LIMIT_Y = 0.34;
  /** 缩放范围与按钮步进、滚轮灵敏度（e 为底，指尖手感接近地图应用）。 */
  const ZOOM_MIN = 0.55;
  const ZOOM_MAX = 2.2;
  const ZOOM_STEP = 1.22;
  const WHEEL_ZOOM_RATE = 0.0016;

  /** 夹取平移范围（缩放越大允许拖得越远）。 */
  function clampPan(): void {
    if (geo === null) return;
    const maxX = geo.width * PAN_LIMIT_X * zoom;
    const maxY = geo.height * PAN_LIMIT_Y * zoom;
    panX = Math.max(-maxX, Math.min(maxX, panX));
    panY = Math.max(-maxY, Math.min(maxY, panY));
  }

  /** 应用画布变换（平移 + 缩放），并同步右下角的百分比。 */
  function applyView(animated: boolean): void {
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
    clampPan();
    if (panAnimTimer !== 0) {
      window.clearTimeout(panAnimTimer);
      panAnimTimer = 0;
    }
    canvas.classList.toggle('is-animating', animated);
    canvas.style.transform = `translate3d(${Math.round(panX)}px, ${Math.round(panY)}px, 0) scale(${zoom.toFixed(4)})`;
    zoomValue.textContent = `${Math.round(zoom * 100)}%`;
    if (animated) {
      panAnimTimer = window.setTimeout(() => {
        panAnimTimer = 0;
        canvas.classList.remove('is-animating');
      }, 360);
    }
  }

  /** 以某个屏幕点为锚点缩放：保证锚点下的画布内容不动。 */
  function zoomAt(nextZoom: number, anchorX: number, anchorY: number, animated: boolean): void {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nextZoom));
    if (Math.abs(next - zoom) < 1e-4) return;
    const ratio = next / zoom;
    panX = anchorX - (anchorX - panX) * ratio;
    panY = anchorY - (anchorY - panY) * ratio;
    zoom = next;
    applyView(animated);
  }

  /** 复位视角（缩放回 100%，平移归零）。 */
  function resetView(animated = true): void {
    zoom = 1;
    panX = 0;
    panY = 0;
    applyView(animated);
  }

  /** 滚轮缩放：以光标位置为锚点；底部缩放条上滚轮不拦截。 */
  function onBoardWheel(event: WheelEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    if (target.closest('.metro-overlay-close') !== null || target.closest('.mh-zoombar') !== null) return;
    event.preventDefault();
    const rect = board.getBoundingClientRect();
    const next = zoom * Math.exp(-event.deltaY * WHEEL_ZOOM_RATE);
    zoomAt(next, event.clientX - rect.left, event.clientY - rect.top, false);
  }

  /** 缩放条按钮：以画布中心为锚点。 */
  function onZoomBarClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    const btn = target?.closest<HTMLButtonElement>('.mh-zoom-btn');
    if (btn === null || btn === undefined) return;
    const act = btn.dataset.act;
    // 以线路网络的中心为锚点缩放，避免按钮缩放时内容整体跑出画面。
    const cx = geo === null ? board.clientWidth / 2 : (geo.hubX + geo.branchEnd) / 2;
    const cy =
      geo === null || geo.rows.length === 0
        ? board.clientHeight / 2
        : ((geo.rows[0] ?? 0) + (geo.rows[geo.rows.length - 1] ?? 0)) / 2;
    if (act === 'in') zoomAt(zoom * ZOOM_STEP, cx, cy, true);
    else if (act === 'out') zoomAt(zoom / ZOOM_STEP, cx, cy, true);
    else if (act === 'reset') resetView(true);
    else if (act === 'reset-layout') resetBoardEdits();
  }

  /** 按钮 / 站点 / 卡片上的拖动不触发平视，留给它们自己。 */
  function isPanExcluded(target: Element): boolean {
    return (
      target.closest('.mh-hub') !== null ||
      target.closest('.mh-card') !== null ||
      target.closest('.mh-station') !== null ||
      target.closest('.mh-line') !== null ||
      target.closest('.mh-zoombar') !== null ||
      target.closest('.metro-overlay-close') !== null
    );
  }

  function onBoardPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target === null || isPanExcluded(target)) return;
    panPointerId = event.pointerId;
    panActive = false;
    panStartX = event.clientX;
    panStartY = event.clientY;
    panBaseX = panX;
    panBaseY = panY;
  }

  function onBoardPointerMove(event: PointerEvent): void {
    if (panPointerId !== event.pointerId) return;
    const dx = event.clientX - panStartX;
    const dy = event.clientY - panStartY;
    // 移动超过阈值才进入拖拽，避免普通点击时闪现抓手光标。
    if (!panActive) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      panActive = true;
      board.classList.add('is-panning');
      board.setPointerCapture(event.pointerId);
    }
    panX = panBaseX + dx;
    panY = panBaseY + dy;
    applyView(false);
  }

  function onBoardPointerUp(event: PointerEvent): void {
    if (panPointerId !== event.pointerId) return;
    panPointerId = null;
    panActive = false;
    board.classList.remove('is-panning');
    if (board.hasPointerCapture(event.pointerId)) board.releasePointerCapture(event.pointerId);
  }

  // ── 布局编辑：拖动大图标移动板块、拖动支线上下移动线路 ──────────────
  function onEditPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || entries === null) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    const hub = target.closest<HTMLButtonElement>('.mh-hub');
    if (hub !== null) {
      const entryId = hub.dataset.entry;
      if (entryId === undefined) return;
      const edit = editOf(entryId);
      editMode = 'hub';
      editEntryId = entryId;
      editBaseHubDx = edit.hubDx;
      editBaseHubDy = edit.hubDy;
    } else {
      const station = target.closest<SVGGElement>('.mh-station');
      const line = target.closest<SVGElement>('.mh-line');
      const entryId = station?.dataset.entry ?? line?.getAttribute('data-entry') ?? undefined;
      if (entryId === undefined) return;
      const edit = editOf(entryId);
      editMode = 'line';
      editEntryId = entryId;
      editBaseLineDy = edit.lineDy;
    }
    editPointerId = event.pointerId;
    editStartX = event.clientX;
    editStartY = event.clientY;
    editActive = false;
  }

  function onEditPointerMove(event: PointerEvent): void {
    if (editPointerId !== event.pointerId || editMode === null) return;
    const dx = event.clientX - editStartX;
    const dy = event.clientY - editStartY;
    if (!editActive) {
      // 移动超过阈值才算拖动，普通点击仍然展开 / 开卡。
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      editActive = true;
      suppressClick = true;
      board.classList.add('is-editing');
      board.setPointerCapture(event.pointerId);
    }
    const edit = editOf(editEntryId);
    if (editMode === 'hub') {
      edit.hubDx = clampEdit(editBaseHubDx + dx, EDIT_LIMIT_X);
      edit.hubDy = clampEdit(editBaseHubDy + dy, EDIT_LIMIT_Y);
      renderStatic();
    } else {
      edit.lineDy = clampEdit(editBaseLineDy + dy, EDIT_LIMIT_Y);
    }
    refreshBranch(editEntryId);
    if (cardAt !== null) renderCard();
  }

  function onEditPointerUp(event: PointerEvent): void {
    if (editPointerId !== event.pointerId) return;
    const wasActive = editActive;
    editMode = null;
    editPointerId = null;
    editActive = false;
    board.classList.remove('is-editing');
    if (board.hasPointerCapture(event.pointerId)) board.releasePointerCapture(event.pointerId);
    if (wasActive) {
      writeBoardEdits(edits);
      renderStatic();
      refreshBranch(editEntryId);
      if (cardAt !== null) renderCard();
    }
  }

  /** 双击站点 = 直接播放这首；双击空白 = 复位视角。 */
  function onBoardDoubleClick(event: MouseEvent): void {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    const station = target.closest<SVGGElement>('.mh-station');
    if (station !== null) {
      const entryId = station.dataset.entry;
      const index = Number(station.dataset.index ?? '0');
      if (entryId === undefined || entries === null) return;
      const entry = entries.find((item) => item.id === entryId);
      if (entry === undefined) return;
      event.preventDefault();
      closeCard();
      playEntry(entry, index);
      return;
    }
    if (isPanExcluded(target)) return;
    resetView(true);
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
    board.removeEventListener('pointerdown', onBoardPointerDown);
    board.removeEventListener('pointerdown', onEditPointerDown);
    board.removeEventListener('pointermove', onBoardPointerMove);
    board.removeEventListener('pointermove', onEditPointerMove);
    board.removeEventListener('pointerup', onBoardPointerUp);
    board.removeEventListener('pointerup', onEditPointerUp);
    board.removeEventListener('pointercancel', onBoardPointerUp);
    board.removeEventListener('pointercancel', onEditPointerUp);
    board.removeEventListener('dblclick', onBoardDoubleClick);
    board.removeEventListener('wheel', onBoardWheel);
    zoomBar.removeEventListener('click', onZoomBarClick);
    if (panAnimTimer !== 0) window.clearTimeout(panAnimTimer);
    closeBtn.removeEventListener('click', close);
    window.removeEventListener('keydown', onEscape, true);
    root.remove();
    document.body.classList.remove('is-metro-open');
    // 关闭覆盖层 = 切回经典界面：同步界面模式，保证「看到的」与「记住的」一致。
    writeInterfaceMode('classic');
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
  board.addEventListener('pointerdown', onBoardPointerDown);
  board.addEventListener('pointerdown', onEditPointerDown);
  board.addEventListener('pointermove', onBoardPointerMove);
  board.addEventListener('pointermove', onEditPointerMove);
  board.addEventListener('pointerup', onBoardPointerUp);
  board.addEventListener('pointerup', onEditPointerUp);
  board.addEventListener('pointercancel', onBoardPointerUp);
  board.addEventListener('pointercancel', onEditPointerUp);
  board.addEventListener('dblclick', onBoardDoubleClick);
  board.addEventListener('wheel', onBoardWheel, { passive: false });
  zoomBar.addEventListener('click', onZoomBarClick);
  closeBtn.addEventListener('click', close);
  window.addEventListener('keydown', onEscape, true);
  active = { close };
  offPlayer = onPlayer(() => syncPlaying());

  void load();
}

/** 关闭当前地铁图覆盖层（界面模式热切换用；未打开时无操作）。 */
export function closeMetroOverlay(): void {
  active?.close();
}

/** 当前是否已打开地铁图覆盖层。 */
export function isMetroOverlayOpen(): boolean {
  return active !== null;
}
