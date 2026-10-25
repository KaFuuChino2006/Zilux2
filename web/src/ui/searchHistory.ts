/**
 * 搜索历史（桌面端小工具）：localStorage 持久化 + 可挂载列表 UI。
 *
 * - 存储键：`zilux2.searchHistory`，最多 12 条，去重（大小写不敏感），最新在前。
 * - 记录结构：`[{ query: string, at: number }]`；兼容旧版纯字符串数组。
 * - 集成时由 Lead 决定挂载点（搜索弹层 / 设置页），本模块不依赖 app.ts。
 */
import { h, icon } from './dom';

export const SEARCH_HISTORY_STORAGE_KEY = 'zilux2.searchHistory';
export const SEARCH_HISTORY_LIMIT = 12;

/** 单条查询的最大字符数（超出截断）。 */
const MAX_QUERY_LENGTH = 120;
const STORAGE_EVENT = 'storage';

export interface SearchHistoryEntry {
  /** 已规范化（空白折叠 + 截断）的查询词。 */
  query: string;
  /** 记录时间戳（毫秒）。 */
  at: number;
}

type Listener = (entries: readonly SearchHistoryEntry[]) => void;

const listeners = new Set<Listener>();
let storageBound = false;

/* ------------------------------------------------------------------ */
/* 读写                                                                */
/* ------------------------------------------------------------------ */

function normalizeQuery(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_QUERY_LENGTH) return collapsed;
  return collapsed.slice(0, MAX_QUERY_LENGTH).trimEnd();
}

function dedupeKey(query: string): string {
  return query.toLocaleLowerCase();
}

function snapshot(entries: readonly SearchHistoryEntry[]): SearchHistoryEntry[] {
  return entries.map((entry) => ({ query: entry.query, at: entry.at }));
}

function readEntries(): SearchHistoryEntry[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY);
  } catch (err) {
    console.warn('[searchHistory] 读取失败', err);
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[searchHistory] 数据损坏，已忽略', err);
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const entries: SearchHistoryEntry[] = [];
  for (const item of parsed) {
    if (entries.length >= SEARCH_HISTORY_LIMIT) break;
    let query = '';
    let at = 0;
    if (typeof item === 'string') {
      query = normalizeQuery(item);
    } else if (item && typeof item === 'object') {
      const record = item as { query?: unknown; at?: unknown };
      query = normalizeQuery(record.query);
      at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0;
    }
    if (!query) continue;
    const key = dedupeKey(query);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ query, at: at > 0 ? at : Date.now() });
  }
  return entries;
}

function emit(entries: readonly SearchHistoryEntry[]): void {
  const payload = snapshot(entries);
  for (const listener of [...listeners]) {
    try {
      listener(payload);
    } catch (err) {
      console.warn('[searchHistory] 订阅回调异常', err);
    }
  }
}

function writeEntries(entries: readonly SearchHistoryEntry[]): SearchHistoryEntry[] {
  const next = snapshot(entries).slice(0, SEARCH_HISTORY_LIMIT);
  try {
    window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[searchHistory] 写入失败', err);
  }
  emit(next);
  return snapshot(next);
}

function bindStorageSync(): void {
  if (storageBound) return;
  storageBound = true;
  window.addEventListener(STORAGE_EVENT, (event) => {
    if (event.key !== null && event.key !== SEARCH_HISTORY_STORAGE_KEY) return;
    emit(readEntries());
  });
}

/* ------------------------------------------------------------------ */
/* 公开 API                                                            */
/* ------------------------------------------------------------------ */

/** 读取当前搜索历史（副本，最新在前）。 */
export function listSearches(): SearchHistoryEntry[] {
  return snapshot(readEntries());
}

/** 记录一次搜索：去重（大小写不敏感）后置顶，超出上限丢弃最旧。返回最新列表。 */
export function recordSearch(query: string): SearchHistoryEntry[] {
  const normalized = normalizeQuery(query);
  if (!normalized) return listSearches();
  const key = dedupeKey(normalized);
  const rest = readEntries().filter((entry) => dedupeKey(entry.query) !== key);
  return writeEntries([{ query: normalized, at: Date.now() }, ...rest]);
}

/** 移除指定查询（大小写不敏感）。返回最新列表。 */
export function removeSearch(query: string): SearchHistoryEntry[] {
  const normalized = normalizeQuery(query);
  if (!normalized) return listSearches();
  const key = dedupeKey(normalized);
  const current = readEntries();
  const next = current.filter((entry) => dedupeKey(entry.query) !== key);
  if (next.length === current.length) return snapshot(current);
  return writeEntries(next);
}

/** 清空搜索历史（直接移除存储键）。返回空列表。 */
export function clearSearch(): SearchHistoryEntry[] {
  try {
    window.localStorage.removeItem(SEARCH_HISTORY_STORAGE_KEY);
  } catch (err) {
    console.warn('[searchHistory] 清空失败', err);
  }
  emit([]);
  return [];
}

/** 订阅变化（含其它标签页的 storage 同步）。返回取消订阅函数。 */
export function subscribeSearches(listener: Listener): () => void {
  bindStorageSync();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 订阅变化的简写别名（任务约定的 API 名）。 */
export function subscribe(listener: Listener): () => void {
  return subscribeSearches(listener);
}

/* ------------------------------------------------------------------ */
/* 可挂载列表 UI                                                       */
/* ------------------------------------------------------------------ */

export interface SearchHistoryPanelOptions {
  /** 点击某条历史时回调（通常填入搜索框并触发搜索）。 */
  onPick?: (query: string) => void;
  /** 是否显示单条删除按钮，默认 true。 */
  removable?: boolean;
  /** 是否显示「清空」按钮，默认 true。 */
  clearable?: boolean;
  /** 最多显示多少条，默认与存储上限一致（12）。 */
  limit?: number;
  /** 无记录时的占位文案。 */
  emptyText?: string;
  /** 追加在根节点上的 class。 */
  className?: string;
}

export interface SearchHistoryPanelHandle {
  element: HTMLElement;
  /** 依据最新存储重绘。 */
  refresh: () => void;
  /** 解绑订阅并移除节点。 */
  dispose: () => void;
}

/**
 * 构建搜索历史列表面板（自带所有事件与刷新逻辑）。
 * 建议挂载：搜索弹层 `.search-pop` 顶部 / 设置页「播放」附近。
 */
export function buildSearchHistoryPanel(
  options: SearchHistoryPanelOptions = {},
): SearchHistoryPanelHandle {
  const onPick = options.onPick;
  const removable = options.removable !== false;
  const clearable = options.clearable !== false;
  const limit = Math.max(
    1,
    Math.min(SEARCH_HISTORY_LIMIT, Math.round(options.limit ?? SEARCH_HISTORY_LIMIT)),
  );
  const emptyText = options.emptyText ?? '还没有搜索记录';
  const rootClass = options.className ? `sh-panel ${options.className}` : 'sh-panel';

  let disposed = false;

  const clearBtn = h(
    'button',
    {
      type: 'button',
      class: 'sh-clear',
      'data-qa': 'search-history-clear',
      title: '清空搜索历史',
      'aria-label': '清空搜索历史',
    },
    icon('trash', 14),
    h('span', { text: '清空' }),
  );

  const head = h(
    'div',
    { class: 'sh-head' },
    h('div', { class: 'sh-title' }, icon('search', 14), h('span', { text: '搜索历史' })),
    clearBtn,
  );

  const list = h('div', { class: 'sh-list' });
  const empty = h('div', { class: 'sh-empty', text: emptyText });
  const element = h('div', { class: rootClass, 'data-qa': 'search-history' }, head, list, empty);

  clearBtn.addEventListener('click', () => {
    clearSearch();
  });

  const render = (): void => {
    if (disposed) return;
    const entries = listSearches().slice(0, limit);
    list.replaceChildren();
    for (const entry of entries) {
      const pick = h(
        'button',
        {
          type: 'button',
          class: onPick ? 'sh-pick' : 'sh-pick is-static',
          'data-qa': 'search-history-item',
          'data-query': entry.query,
          title: entry.query,
        },
        h('span', { class: 'sh-item-icon' }, icon('search', 14)),
        h('span', { class: 'sh-item-text', text: entry.query }),
      );
      if (onPick) {
        pick.addEventListener('click', () => {
          onPick(entry.query);
        });
      }
      const item = h('div', { class: 'sh-item' }, pick);
      if (removable) {
        const removeBtn = h(
          'button',
          {
            type: 'button',
            class: 'sh-remove',
            'data-qa': 'search-history-remove',
            title: '移除这条记录',
            'aria-label': `移除「${entry.query}」`,
          },
          icon('close', 13),
        );
        removeBtn.addEventListener('click', () => {
          removeSearch(entry.query);
        });
        item.append(removeBtn);
      }
      list.append(item);
    }
    empty.hidden = entries.length > 0;
    clearBtn.hidden = !clearable || entries.length === 0;
    head.hidden = !clearable && entries.length === 0;
  };

  const unsubscribe = subscribeSearches(render);
  render();

  return {
    element,
    refresh: render,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      element.remove();
    },
  };
}
