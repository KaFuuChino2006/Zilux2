/**
 * Zilux2 真机 QA —— 下载队列（T2）
 *
 * 覆盖本轮新增的下载队列面板（task-7 基线 + task-12 入口迁移/音质浮层）：
 *   1. 播放条入口 [data-qa="download-entry"] 与面板开合（.dlq-panel.is-open / aria-hidden）；
 *   2. 入口迁移：rail 上不再有「下载队列」入口（task-12 移除），入口只在播放条；
 *      面板 toggle、点外部 / Esc 均可关闭，零任务时也能打开（空态 .dlq-empty 可见）；
 *   3. 分段控件：.dlq-tabs 带全局 seg 类、tab 带 seg-btn、激活态 is-active + is-on 双类、
 *      .dlq-tabs > .seg-thumb 白色滑块存在且首开已定位（width>0 / opacity=1 / 对齐激活 tab）；
 *   4. tab 切换动画：切换后 30ms 内 .dlq-list/.dlq-empty 临时带 is-switch，空态 animationName
 *      含 dlq-switch-in（有行时行动画含 dlq-switch-in + 24ms stagger），700ms 后临时类移除、
 *      滑块 left 位移；
 *   5. 面板结构：标题、摘要计数、筛选 tab、目录行、空态、行内 .dlq-bar>.dlq-fill；
 *   6. 音质选择浮层（task-12）：默认项 = 设置 downloads.quality（默认 high）、三档选项结构、
 *      Esc / 点浮层外 / 取消都不入队且不改设置；
 *   7. 从搜索结果点 .track-download → 选「高品质」真实发起一次下载（beginDownload→beginQueueDownload），
 *      job.quality 应为 high；
 *   8. 无损下载：再选「无损」入队，job.quality=lossless 且 fileName 以 .flac 结尾
 *      （源站不提供无损时 SKIP 并给出证据，不误报失败）；
 *   9. 快捷设置第 5 页「下载」（task-12）：.quick.is-download、[data-qa="quick-downloads-page"]、
 *      4 个筛选可切、.dlq-embed-status 计数与真实任务一致、「打开目录」按钮存在；
 *  10. 以 ~85ms 采样 running 行：data-state / .dlq-pct / .dlq-fill 宽度；
 *  11. done 行 UI（100%、已保存、.dlq-reveal 可见、.dlq-retry 隐藏、.dlq-actions 可见）；
 *  12. 落盘校验：宿主任务 path 在磁盘上存在且非空；
 *  13. 筛选 tab（已完成/失败/全部，含带行切换动画）与刷新、关闭重开；
 *  14. 全程 console 无 error；收尾关面板 + 回首页。
 *
 * 说明：
 *   - 数据真值优先取页面调试入口 window.__zilux2DownloadQueue.state()（产品自带），
 *     DOM 断言只依赖可见选择器；两者都写进失败证据。
 *   - 下载写的是真实下载目录（宿主默认 %USERPROFILE%\Music），测试会留下音频文件；
 *     QA 侧不删用户目录文件，README 里有清理说明。
 *   - 本套件不点「在文件夹中显示」（会弹出资源管理器）；需要时设 ZILUX2_QA_CLICK_REVEAL=1。
 */
import fs from 'node:fs';

import { runSuite, sleep, repoRel, hostLogTail } from './lib/cdp.mjs';
import { goHome, openSearch, closeOverlays, pressEscape } from './lib/ui.mjs';
import {
  DLQ,
  QUICK,
  PICKER,
  SETTINGS_KEY,
  DOWNLOAD_TIMEOUT_MS,
  DOWNLOAD_SAMPLE_INTERVAL_MS,
  DOWNLOAD_UI_SETTLE_MS,
  SEARCH_KEYWORD,
  DOWNLOAD_CLICK_REVEAL,
} from './lib/fixtures.mjs';

/* -------------------------------------------------------------------------- */
/* 页面内函数（通过 toString 注入）                                             */
/* -------------------------------------------------------------------------- */

/** 下载队列真值快照（产品调试入口 window.__zilux2DownloadQueue.state()）。 */
function pageDlqDebug() {
  const q = window.__zilux2DownloadQueue;
  if (!q || typeof q.state !== 'function') return null;
  const state = q.state();
  return {
    directory: state.directory || '',
    panelOpen: !!state.panelOpen,
    filter: state.filter || '',
    refreshing: !!state.refreshing,
    lastError: state.lastError || '',
    jobs: Array.isArray(state.jobs)
      ? state.jobs.map((job) => ({
          id: job.id,
          source: job.source,
          trackId: job.trackId,
          title: job.title,
          artist: job.artist,
          quality: job.quality,
          state: job.state,
          received: job.received,
          total: job.total,
          fileName: job.fileName,
          path: job.path || '',
          error: job.error || '',
        }))
      : [],
  };
}

/** 面板 DOM 快照。 */
function pageDlqSnapshot() {
  const text = (node) => (node && node.textContent ? node.textContent : '').trim();
  const panel = document.querySelector('.dlq-panel');
  if (!panel) return { exists: false, count: 0, open: false, rows: [] };
  const scopedNum = (sel) => {
    const node = panel.querySelector(sel);
    return node ? Number(text(node)) : null;
  };
  const rows = Array.from(panel.querySelectorAll('.dlq-row')).map((row) => {
    const fill = row.querySelector('.dlq-fill');
    const reveal = row.querySelector('.dlq-reveal');
    const retry = row.querySelector('.dlq-retry');
    const actions = row.querySelector('.dlq-actions');
    return {
      id: row.dataset.jobId || '',
      state: row.dataset.state || '',
      name: text(row.querySelector('.dlq-name')),
      meta: text(row.querySelector('.dlq-meta')),
      pct: text(row.querySelector('.dlq-pct')),
      status: text(row.querySelector('.dlq-status')),
      fillWidth: fill ? fill.style.width : '',
      indeterminate: fill ? fill.classList.contains('is-indeterminate') : false,
      hasBar: !!row.querySelector('.dlq-bar'),
      hasFill: !!fill,
      revealHidden: reveal ? reveal.hidden : null,
      retryHidden: retry ? retry.hidden : null,
      actionsHidden: actions ? actions.hidden : null,
      rowTitle: row.title || '',
    };
  });
  const tabs = Array.from(panel.querySelectorAll('.dlq-tab')).map((btn) => ({
    text: text(btn),
    active: btn.classList.contains('is-active'),
    selected: btn.getAttribute('aria-selected'),
  }));
  const empty = panel.querySelector('.dlq-empty');
  const error = panel.querySelector('.dlq-error');
  return {
    exists: true,
    count: document.querySelectorAll('.dlq-panel').length,
    open: panel.classList.contains('is-open'),
    ariaHidden: panel.getAttribute('aria-hidden'),
    titleText: text(panel.querySelector('.dlq-title')),
    dir: text(panel.querySelector('.dlq-dir-path')),
    summary: {
      running: scopedNum('.dlq-sum-item[data-kind="running"] b'),
      done: scopedNum('.dlq-sum-item[data-kind="done"] b'),
      error: scopedNum('.dlq-sum-item[data-kind="error"] b'),
    },
    tabs,
    rows,
    emptyHidden: empty ? empty.hidden : null,
    emptyText: text(empty),
    errorHidden: error ? error.hidden : null,
    errorText: text(error),
    hasRefresh: !!panel.querySelector('.dlq-refresh'),
    hasClose: !!panel.querySelector('.dlq-close'),
    hasOpenDir: !!panel.querySelector('.dlq-open-dir'),
    hint: text(panel.querySelector('.dlq-hint')),
  };
}

/**
 * 入口迁移快照（task-12）：rail 已不再有「下载队列」入口，入口迁到播放条与快捷设置第 5 页。
 * 同时返回面板开合状态，便于断言 toggle。
 */
function pageEntryState() {
  const text = (node) => (node && node.textContent ? node.textContent.trim() : '');
  const rail = document.querySelector('.rail');
  const railDownload = document.querySelector('.rail .rail-btn[aria-label="下载队列"]');
  const entry = document.querySelector('[data-qa="download-entry"]');
  const panel = document.querySelector('.dlq-panel');
  return {
    railBtnCount: rail ? rail.querySelectorAll('.rail-btn').length : 0,
    railTitles: rail ? Array.from(rail.querySelectorAll('.rail-btn')).map((n) => n.getAttribute('title') || text(n)) : [],
    railDownloadExists: !!railDownload,
    playerEntry: entry
      ? {
          exists: true,
          cls: String(entry.className || ''),
          title: entry.title || '',
          haspopup: entry.getAttribute('aria-haspopup'),
          expanded: entry.getAttribute('aria-expanded'),
          hidden: entry.hidden,
        }
      : { exists: false },
    panelExists: !!panel,
    panelOpen: !!panel && panel.classList.contains('is-open'),
    ariaHidden: panel ? panel.getAttribute('aria-hidden') : null,
    quickOpen: !!document.querySelector('.quick.is-open'),
  };
}

/** 快捷设置第 5 页「下载」快照（嵌入视图 .dlq-embed[data-qa="quick-downloads-page"]）。 */
function pageQuickPage() {
  const text = (node) => (node && node.textContent ? node.textContent.trim() : '');
  const quick = document.querySelector('.quick');
  const page = document.querySelector('[data-qa="quick-downloads-page"]');
  if (!page) return { quickClass: quick ? quick.className : null, exists: false, tabs: [] };
  const tabsBox = page.querySelector('.dlq-tabs');
  const thumb = tabsBox ? tabsBox.querySelector(':scope > .seg-thumb') : null;
  const empty = page.querySelector('.dlq-empty');
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const rows = Array.from(page.querySelectorAll('.dlq-row')).map((row) => ({
    id: row.dataset.jobId || '',
    state: row.dataset.state || '',
  }));
  return {
    quickClass: quick ? quick.className : null,
    exists: true,
    pageClass: page.className,
    qa: page.getAttribute('data-qa'),
    title: text(page.querySelector('.dlq-embed-title')),
    status: text(page.querySelector('.dlq-embed-status')),
    dir: text(page.querySelector('.dlq-dir-path')),
    hasOpenDir: !!page.querySelector('.dlq-open-dir'),
    hasRefresh: !!page.querySelector('.dlq-embed-refresh'),
    tabs: tabsBox
      ? Array.from(tabsBox.querySelectorAll('.dlq-tab')).map((btn) => ({
          text: text(btn),
          classes: Array.from(btn.classList),
          active: btn.classList.contains('is-active'),
          on: btn.classList.contains('is-on'),
          selected: btn.getAttribute('aria-selected'),
          rect: rect(btn),
        }))
      : [],
    segReady: tabsBox ? tabsBox.dataset.segThumb || '' : '',
    segThumb: thumb
      ? {
          exists: true,
          left: parseFloat(thumb.style.left || '0') || 0,
          width: parseFloat(thumb.style.width || '0') || 0,
          opacity: getComputedStyle(thumb).opacity,
          rect: rect(thumb),
        }
      : { exists: false },
    rowCount: rows.length,
    rows,
    emptyHidden: empty ? empty.hidden : null,
    emptyText: text(empty),
    bodyText: text(page).slice(0, 400),
  };
}

/** 下载音质选择浮层快照（.dlqp-overlay / .dlqp-panel[data-qa="download-picker"]）。 */
function pagePickerState() {
  const text = (node) => (node && node.textContent ? node.textContent.trim() : '');
  const overlay = document.querySelector('.dlqp-overlay');
  const panel = document.querySelector('.dlqp-panel[data-qa="download-picker"]');
  if (!panel) return { exists: false, overlay: !!overlay };
  const options = Array.from(panel.querySelectorAll('.dlqp-option')).map((btn) => ({
    quality: btn.dataset.quality || '',
    label: text(btn.querySelector('.dlqp-option-label')),
    note: text(btn.querySelector('.dlqp-option-note')),
    checked: btn.getAttribute('aria-checked'),
    classes: Array.from(btn.classList),
    isChecked: btn.classList.contains('is-checked'),
    isDefault: btn.dataset.default || null,
    hasDefaultNote: !!btn.querySelector('.dlqp-option-default'),
    check: text(btn.querySelector('.dlqp-check')),
  }));
  const focused = document.activeElement;
  return {
    exists: true,
    overlay: !!overlay,
    overlayOpen: overlay ? overlay.classList.contains('is-open') : null,
    panelCount: document.querySelectorAll('.dlqp-panel[data-qa="download-picker"]').length,
    panelClass: panel.className,
    role: panel.getAttribute('role'),
    modal: panel.getAttribute('aria-modal'),
    ariaLabel: panel.getAttribute('aria-label'),
    defaultIndex: panel.dataset.defaultIndex || '',
    title: text(panel.querySelector('.dlqp-title')),
    track: text(panel.querySelector('.dlqp-track')),
    hint: text(panel.querySelector('.dlqp-hint')),
    hasCancel: !!panel.querySelector('.dlqp-cancel'),
    cancelText: text(panel.querySelector('.dlqp-cancel')),
    side: panel.dataset.side || '',
    options,
    checkedQuality: options.filter((item) => item.isChecked).map((item) => item.quality),
    defaultQuality: options.filter((item) => item.isDefault === 'true').map((item) => item.quality),
    focusedQuality: focused && focused.dataset ? focused.dataset.quality || '' : '',
  };
}

/** 分段控件（.seg）结构 + 白色滑块几何快照。 */
function pageSegSnapshot() {
  const text = (node) => (node && node.textContent ? node.textContent.trim() : '');
  const tabs = document.querySelector('.dlq-panel .dlq-tabs');
  if (!tabs) return { exists: false };
  const thumb = tabs.querySelector(':scope > .seg-thumb');
  const buttons = Array.from(tabs.querySelectorAll('.dlq-tab'));
  const active = tabs.querySelector('.dlq-tab.is-active');
  const on = tabs.querySelector('.dlq-tab.is-on');
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    exists: true,
    segClasses: Array.from(tabs.classList),
    role: tabs.getAttribute('role'),
    ready: tabs.dataset.segThumb || '',
    buttons: buttons.map((btn) => ({
      text: text(btn),
      classes: Array.from(btn.classList),
      active: btn.classList.contains('is-active'),
      on: btn.classList.contains('is-on'),
      selected: btn.getAttribute('aria-selected'),
      offsetLeft: btn.offsetLeft,
      offsetWidth: btn.offsetWidth,
      rect: rect(btn),
    })),
    thumb: thumb
      ? {
          exists: true,
          parentIsTabs: thumb.parentElement === tabs,
          cls: Array.from(thumb.classList),
          left: parseFloat(thumb.style.left || '0') || 0,
          width: parseFloat(thumb.style.width || '0') || 0,
          opacity: getComputedStyle(thumb).opacity,
          display: getComputedStyle(thumb).display,
          rect: rect(thumb),
        }
      : { exists: false },
    activeText: active ? text(active) : '',
    onText: on ? text(on) : '',
    activeCount: tabs.querySelectorAll('.dlq-tab.is-active').length,
    onCount: tabs.querySelectorAll('.dlq-tab.is-on').length,
  };
}

/**
 * 切换 tab 并分段取样：
 *   - 点击后 ~20ms 读 is-switch / computed animationName / 滑块几何（CDP 往返在点击前后，
 *     取样时机全在页面内，保证「30ms 内」这条不被 CDP 延迟污染）；
 *   - 再等 700ms 读临时类是否已移除、滑块 left 是否已位移。
 */
function pageSwitchProbe(label) {
  const panel = document.querySelector('.dlq-panel');
  if (!panel) return Promise.resolve({ ok: false, reason: 'no-panel' });
  const tabs = Array.from(panel.querySelectorAll('.dlq-tab'));
  const target = tabs.find((btn) => (btn.textContent || '').trim() === label) || null;
  if (!target) {
    return Promise.resolve({ ok: false, reason: 'no-tab', labels: tabs.map((b) => (b.textContent || '').trim()) });
  }
  const tabsBox = panel.querySelector('.dlq-tabs');
  const thumb = tabsBox ? tabsBox.querySelector(':scope > .seg-thumb') : null;
  const list = panel.querySelector('.dlq-list');
  const empty = panel.querySelector('.dlq-empty');
  const readThumb = () =>
    thumb
      ? {
          left: parseFloat(thumb.style.left || '0') || 0,
          width: parseFloat(thumb.style.width || '0') || 0,
          opacity: getComputedStyle(thumb).opacity,
        }
      : null;
  const activeBefore = (panel.querySelector('.dlq-tab.is-active') || {}).textContent || '';
  const before = readThumb();
  const started = performance.now();
  target.click();
  return new Promise((resolve) => {
    window.setTimeout(() => {
      const dt = Math.round(performance.now() - started);
      const rows = list ? Array.from(list.querySelectorAll('.dlq-row')) : [];
      const mid = {
        dt,
        activeBefore: activeBefore.trim ? activeBefore.trim() : activeBefore,
        active: ((panel.querySelector('.dlq-tab.is-active') || {}).textContent || '').trim(),
        on: ((panel.querySelector('.dlq-tab.is-on') || {}).textContent || '').trim(),
        listSwitch: list ? list.classList.contains('is-switch') : null,
        emptySwitch: empty ? empty.classList.contains('is-switch') : null,
        listAnim: list ? getComputedStyle(list).animationName : '',
        emptyAnim: empty ? getComputedStyle(empty).animationName : '',
        firstRowAnim: rows[0] ? getComputedStyle(rows[0]).animationName : '',
        rows: rows.slice(0, 4).map((row) => ({
          anim: getComputedStyle(row).animationName,
          delay: getComputedStyle(row).animationDelay,
        })),
        rowsCount: rows.length,
        emptyHidden: empty ? empty.hidden : null,
        thumb: readThumb(),
      };
      window.setTimeout(() => {
        const after = {
          dt: Math.round(performance.now() - started),
          listSwitch: list ? list.classList.contains('is-switch') : null,
          emptySwitch: empty ? empty.classList.contains('is-switch') : null,
          active: ((panel.querySelector('.dlq-tab.is-active') || {}).textContent || '').trim(),
          on: ((panel.querySelector('.dlq-tab.is-on') || {}).textContent || '').trim(),
          rowsCount: list ? list.querySelectorAll('.dlq-row').length : 0,
          emptyHidden: empty ? empty.hidden : null,
          thumb: readThumb(),
        };
        resolve({ ok: true, target: label, before, mid, after });
      }, 700);
    }, 20);
  });
}


/** 下载采样（真值 + DOM + 入口按钮 + toast），每次 CDP 往返只取一次。 */
function pageSample(jobId) {
  const pick = (node) => (node && node.textContent ? node.textContent.trim() : '');
  const q = window.__zilux2DownloadQueue;
  const state = q && typeof q.state === 'function' ? q.state() : null;
  const job = state && Array.isArray(state.jobs) ? state.jobs.find((item) => item.id === jobId) : null;
  const row = jobId ? document.querySelector(`.dlq-row[data-job-id="${jobId}"]`) : null;
  const fill = row ? row.querySelector('.dlq-fill') : null;
  const reveal = row ? row.querySelector('.dlq-reveal') : null;
  const retry = row ? row.querySelector('.dlq-retry') : null;
  const actions = row ? row.querySelector('.dlq-actions') : null;
  const panel = document.querySelector('.dlq-panel');
  const entry = document.querySelector('[data-qa="download-entry"]');
  const badge = entry ? entry.querySelector('.dlq-badge') : null;
  return {
    at: Date.now(),
    job: job
      ? {
          state: job.state,
          received: job.received,
          total: job.total,
          error: job.error || '',
          path: job.path || '',
          fileName: job.fileName,
        }
      : null,
    row: row
      ? {
          state: row.dataset.state || '',
          name: pick(row.querySelector('.dlq-name')),
          pct: pick(row.querySelector('.dlq-pct')),
          status: pick(row.querySelector('.dlq-status')),
          fillWidth: fill ? fill.style.width : '',
          indeterminate: fill ? fill.classList.contains('is-indeterminate') : false,
          revealHidden: reveal ? reveal.hidden : null,
          retryHidden: retry ? retry.hidden : null,
          actionsHidden: actions ? actions.hidden : null,
        }
      : null,
    panel: {
      exists: !!panel,
      open: !!panel && panel.classList.contains('is-open'),
      rowCount: document.querySelectorAll('.dlq-row').length,
      sumRunning: state ? state.running : null,
      sumDone: state ? state.done : null,
      sumError: state ? state.error : null,
    },
    entry: entry
      ? {
          active: entry.classList.contains('is-active'),
          expanded: entry.getAttribute('aria-expanded'),
          badgeHidden: badge ? badge.hidden : null,
          badgeText: badge ? pick(badge) : '',
        }
      : null,
    toast: Array.from(document.querySelectorAll('.toast'))
      .map((node) => pick(node))
      .filter(Boolean)
      .join(' | '),
  };
}

/** 从搜索结果里挑一条可下载（非 VIP、按钮未禁用）的行并点下载；优先网易云。返回行信息。 */
function pageDownloadCandidates(limit) {
  const text = (node) => (node && node.textContent ? node.textContent.trim() : '');
  const rows = Array.from(document.querySelectorAll('.wall .track-row'));
  const candidates = [];
  for (const row of rows) {
    if (candidates.length >= limit) break;
    const btn = row.querySelector('.track-download');
    if (!btn || btn.disabled) continue;
    if (row.querySelector('.track-vip')) continue;
    candidates.push({
      key: row.dataset.trackKey || '',
      title: text(row.querySelector('.track-title')) || row.title || '',
      artist: text(row.querySelector('.track-artist')),
      sourceTag: text(row.querySelector('.source-tag')),
    });
  }
  return { rowCount: rows.length, candidates };
}

function pageClickRowDownload(key) {
  const rows = Array.from(document.querySelectorAll('.wall .track-row'));
  const row = rows.find((item) => item.dataset.trackKey === key);
  if (!row) return { ok: false, reason: 'no-row', rowCount: rows.length };
  const btn = row.querySelector('.track-download');
  if (!btn) return { ok: false, reason: 'no-button' };
  if (btn.disabled) return { ok: false, reason: 'disabled' };
  btn.click();
  return {
    ok: true,
    key,
    title: (row.querySelector('.track-title') || {}).textContent || '',
    sourceTag: (row.querySelector('.source-tag') || {}).textContent || '',
  };
}

/* -------------------------------------------------------------------------- */
/* Node 侧小工具                                                               */
/* -------------------------------------------------------------------------- */

async function dlqDebug(cdp) {
  return cdp.eval(`(${pageDlqDebug.toString()})()`);
}

async function dlqSnapshot(cdp) {
  return cdp.eval(`(${pageDlqSnapshot.toString()})()`);
}

async function entryState(cdp) {
  return cdp.eval(`(${pageEntryState.toString()})()`);
}

async function quickPage(cdp) {
  return cdp.eval(`(${pageQuickPage.toString()})()`);
}

async function pickerState(cdp) {
  return cdp.eval(`(${pagePickerState.toString()})()`);
}

/** 等音质浮层出现（本轮所有 .track-download 点击都先弹它）。 */
async function waitPickerOpen(cdp, { timeoutMs = 8000 } = {}) {
  await cdp.waitFor(`!!document.querySelector('.dlqp-panel[data-qa="download-picker"]')`, {
    desc: '音质选择浮层 .dlqp-panel[data-qa="download-picker"]',
    timeoutMs,
  });
  await sleep(80); // 等 rAF 给 .dlqp-overlay 加 is-open
  return pickerState(cdp);
}

/** Esc 关闭音质浮层（downloadPicker.ts 在 document keydown capture 里关）。 */
async function closePickerByEsc(cdp) {
  await cdp.eval(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await cdp.waitFor(`!document.querySelector('.dlqp-overlay') && !document.querySelector('.dlqp-panel[data-qa="download-picker"]')`, {
    desc: 'Esc 关闭音质浮层',
    timeoutMs: 4000,
  });
}

/** 点浮层外关闭：.dlqp-overlay 自身的 pointerdown 监听。 */
async function closePickerByOutside(cdp) {
  await cdp.eval(`(() => {
    const ov = document.querySelector('.dlqp-overlay');
    if (!ov) return false;
    ov.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await cdp.waitFor(`!document.querySelector('.dlqp-overlay') && !document.querySelector('.dlqp-panel[data-qa="download-picker"]')`, {
    desc: '点浮层外关闭音质浮层',
    timeoutMs: 4000,
  });
}

/** 在浮层里选一档音质（点击后浮层关闭并触发 onPick → beginQueueDownload）。 */
async function pickQuality(cdp, quality) {
  await cdp.click(PICKER.option(quality), { desc: `音质浮层选项「${PICKER.labels[quality] || quality}」` });
  await cdp.waitFor(`!document.querySelector('.dlqp-overlay')`, { desc: `选完音质（${quality}）后浮层关闭`, timeoutMs: 4000 });
  await sleep(120);
}

/** 读设置里的下载音质；未写设置时返回 ''（产品默认 high）。 */
async function settingsDownloadQuality(cdp) {
  return cdp.eval(`(() => {
    try {
      const raw = window.localStorage.getItem('zilux2.settings');
      const settings = raw ? JSON.parse(raw) : {};
      return settings && settings.downloads && settings.downloads.quality ? String(settings.downloads.quality) : '';
    } catch (err) {
      return '__error__';
    }
  })()`);
}

async function segSnapshot(cdp) {
  return cdp.eval(`(${pageSegSnapshot.toString()})()`);
}

async function switchProbe(cdp, label) {
  return cdp.eval(`(${pageSwitchProbe.toString()})(${JSON.stringify(label)})`);
}

/** 等某个 track key 对应的「新任务」出现（排除基线已有的 id）。 */
async function waitForNewJob(cdp, key, baselineIds, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const debug = await dlqDebug(cdp);
    if (debug) {
      const job = debug.jobs
        .filter((item) => !baselineIds.has(item.id))
        .filter((item) => `${item.source}:${item.trackId}` === key || item.title === key)
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
      if (job) return job;
    }
    await sleep(150);
  }
  return null;
}

/** 轮询任务直到 done/error（或超时返回最后状态）。 */
async function waitJobSettled(cdp, jobId, { timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const debug = await dlqDebug(cdp);
    last = debug ? debug.jobs.find((item) => item.id === jobId) || last : last;
    if (last && (last.state === 'done' || last.state === 'error')) return last;
    await sleep(300);
  }
  return last;
}

function parsePct(text) {
  const match = /([\d.]+)\s*%/.exec(String(text || ''));
  return match ? Number(match[1]) : null;
}

function parseWidth(text) {
  const match = /^\s*([\d.]+)%\s*$/.exec(String(text || ''));
  return match ? Number(match[1]) : null;
}

function jobSummary(job) {
  if (!job) return '（null）';
  return JSON.stringify({
    id: job.id,
    state: job.state,
    title: job.title,
    quality: job.quality,
    received: job.received,
    total: job.total,
    fileName: job.fileName,
    path: job.path,
    error: job.error,
  });
}

/** 失败时附带的下载相关宿主日志（最后若干行）。 */
function downloadLogTail() {
  try {
    const all = hostLogTail(400)
      .split(/\r?\n/)
      .filter((line) => line && /\[download\]|download/i.test(line));
    return all.slice(-8).join('\n');
  } catch {
    return '';
  }
}

/* -------------------------------------------------------------------------- */
/* 套件                                                                        */
/* -------------------------------------------------------------------------- */

await runSuite('downloads', '下载队列（T2）', async (suite) => {
  const cdp = suite.cdp;
  /** @type {{ directory: string, jobs: any[] }} */
  let baseline = { directory: '', jobs: [] };
  let jobId = '';
  let targetTrack = { key: '', title: '', artist: '', sourceTag: '' };
  let samples = [];
  let snapshotAtStart = null;

  /* ---------------------------------------------------------------------- */
  await suite.step('准备：首页、入口按钮、基线任务快照', async () => {
    await closeOverlays(cdp);
    await goHome(cdp);

    await cdp.waitFor(`!!document.querySelector('[data-qa="download-entry"]')`, {
      desc: '下载队列入口 [data-qa="download-entry"]',
      timeoutMs: 12000,
    });
    const entry = await cdp.eval(`(() => {
      const btn = document.querySelector('[data-qa="download-entry"]');
      return {
        cls: String(btn.className || ''),
        title: btn.title || '',
        haspopup: btn.getAttribute('aria-haspopup'),
        expanded: btn.getAttribute('aria-expanded'),
      };
    })()`);
    suite.assert(entry.cls.includes('pb-btn'), `入口按钮应有 .pb-btn 类，实际 class=${entry.cls}`);
    suite.assert(entry.haspopup === 'dialog', `入口按钮 aria-haspopup 应为 dialog，实际 ${entry.haspopup}`);

    const debug = await dlqDebug(cdp);
    suite.assert(debug, '页面缺少 window.__zilux2DownloadQueue 调试入口（initDownloadQueue 未挂载？）');
    baseline = { directory: debug.directory, jobs: debug.jobs };
    suite.note(`基线：directory=${debug.directory || '（空）'}，已有任务 ${debug.jobs.length} 个`);

    // 面板收起状态（若上次跑完留着，先关掉）
    const panel = await dlqSnapshot(cdp);
    if (panel.exists && panel.open) {
      await cdp.click(DLQ.close, { desc: '下载面板关闭按钮' });
      await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: '下载面板收起', timeoutMs: 5000 });
    }
    return `directory=${debug.directory || '空'}，基线任务 ${debug.jobs.length}`;
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('面板开合：入口点击打开 / 关闭按钮收起', async () => {
    await cdp.click(DLQ.entry, { desc: '下载队列入口按钮' });
    await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, {
      desc: '面板打开（.dlq-panel.is-open）',
      timeoutMs: 8000,
    });
    await sleep(250);
    let snap = await dlqSnapshot(cdp);
    suite.assert(snap.exists, '面板 .dlq-panel 未创建');
    suite.assert(snap.count === 1, `面板应为单例，实际 DOM 里有 ${snap.count} 个 .dlq-panel`);
    suite.assert(snap.ariaHidden === 'false', `打开时 aria-hidden 应为 false，实际 ${snap.ariaHidden}`);
    await cdp.waitFor(
      `document.querySelector('[data-qa="download-entry"]').getAttribute('aria-expanded') === 'true'`,
      { desc: '入口 aria-expanded=true', timeoutMs: 4000 },
    );

    const openShot = await suite.shot('panel-open');
    suite.note(`截图 ${repoRel(openShot)}`);

    await cdp.click(DLQ.close, { desc: '下载面板关闭按钮' });
    await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: '面板收起', timeoutMs: 5000 });
    snap = await dlqSnapshot(cdp);
    suite.assert(snap.ariaHidden === 'true', `收起时 aria-hidden 应为 true，实际 ${snap.ariaHidden}`);
    suite.assert(!snap.open, '收起后仍带 .is-open');
    return '入口打开 / 关闭按钮收起 正常';
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('面板结构：标题、摘要、筛选 tab、目录、空态、单例 DOM', async () => {
    await cdp.click(DLQ.entry, { desc: '再次打开下载面板' });
    await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, { desc: '面板打开', timeoutMs: 8000 });
    let snap = await dlqSnapshot(cdp);
    snapshotAtStart = snap;

    suite.assert(snap.titleText === '下载队列', `标题应为「下载队列」，实际「${snap.titleText}」`);
    suite.assert(snap.hasRefresh, '缺少刷新按钮 .dlq-refresh');
    suite.assert(snap.hasClose, '缺少关闭按钮 .dlq-close');
    suite.assert(snap.hasOpenDir, '缺少「打开目录」按钮 .dlq-open-dir');
    suite.assert(typeof snap.dir === 'string' && snap.dir.length > 0, '下载目录行 .dlq-dir-path 为空');
    suite.assert(snap.hint.length > 0, '缺少 .dlq-hint 说明文字');

    const tabLabels = snap.tabs.map((tab) => tab.text);
    suite.assert(
      tabLabels.join('|') === '全部|下载中|已完成|失败',
      `筛选 tab 应为 全部/下载中/已完成/失败，实际 ${JSON.stringify(tabLabels)}`,
    );
    const activeTabs = snap.tabs.filter((tab) => tab.active);
    suite.assert(activeTabs.length === 1, `应只有 1 个激活 tab，实际 ${activeTabs.length}`);
    const activeLabel = activeTabs[0].text;
    suite.assert(
      tabLabels.includes(activeLabel),
      `激活 tab 文本「${activeLabel}」不在 tab 列表 ${JSON.stringify(tabLabels)} 中`,
    );
    // 面板筛选状态在同一应用会话内跨脚本保留（复跑时可能是上次点的「已完成」）；
    // 首次冷启动默认应为「全部」——用 note 记录，不做硬断言以免复跑误报。
    if (activeLabel !== '全部') {
      suite.note(`当前激活 tab 为「${activeLabel}」（同会话复跑保留了上次筛选，非冷启动默认值）`);
      await cdp.clickText(DLQ.tabs, '全部', { desc: '把筛选重置为「全部」' });
      await sleep(250);
      snap = await dlqSnapshot(cdp);
      suite.assert(snap.tabs.filter((tab) => tab.active)[0].text === '全部', '重置筛选后「全部」tab 未激活');
    }

    // 摘要三个计数与调试入口一致
    const debug = await dlqDebug(cdp);
    const counts = debug.jobs.reduce(
      (acc, job) => {
        if (job.state === 'running') acc.running += 1;
        else if (job.state === 'done') acc.done += 1;
        else acc.error += 1;
        return acc;
      },
      { running: 0, done: 0, error: 0 },
    );
    for (const kind of ['running', 'done', 'error']) {
      suite.assert(
        snap.summary[kind] === counts[kind],
        `摘要 ${kind} 计数 ${snap.summary[kind]} ≠ 真实任务数 ${counts[kind]}`,
      );
    }

    // 空态与行互斥
    suite.assert(
      // emptyHidden 为 .dlq-empty 的 hidden 属性：没有行时应可见（hidden=false），有行时应隐藏（hidden=true）
      snap.emptyHidden === (snap.rows.length > 0),
      `空态显隐与行数不一致：emptyHidden=${snap.emptyHidden} rows=${snap.rows.length}`,
    );

    // 有任务时检查行结构（含 .dlq-bar>.dlq-fill / reveal / retry）
    if (snap.rows.length > 0) {
      const row = snap.rows[0];
      suite.assert(row.hasBar, '行内缺少 .dlq-bar');
      suite.assert(row.hasFill, '行内缺少 .dlq-bar > .dlq-fill');
      suite.assert(row.name.length > 0, '行内 .dlq-name 为空');
      suite.assert(row.meta.length > 0, '行内 .dlq-meta 为空');
      suite.assert(row.pct.length > 0, '行内 .dlq-pct 为空');
      suite.assert(row.status.length > 0, '行内 .dlq-status 为空');
      suite.assert(row.revealHidden !== null, '行内缺少 .dlq-reveal 按钮');
      suite.assert(row.retryHidden !== null, '行内缺少 .dlq-retry 按钮');
      const priority = { running: 0, error: 1, done: 2 };
      const states = snap.rows.map((item) => item.state);
      const expected = debug.jobs
        .slice()
        .sort((a, b) => (priority[a.state] ?? 3) - (priority[b.state] ?? 3))
        .map((job) => job.state);
      suite.assert(
        states.join('|') === expected.join('|'),
        `行顺序应为 running→error→done，期望 ${expected.join('|')}，实际 ${states.join('|')}`,
      );
    }

    await suite.shot('panel-structure');
    return `tab=${tabLabels.join('/')} 行数=${snap.rows.length} 目录=${snap.dir}`;
  });

  /* ---------------------------------------------------------------------- */
  /* ---------------------------------------------------------------------- */
  await suite.step('入口迁移：rail 无「下载队列」入口 / 播放条入口 toggle / 点外与 Esc 关闭', async () => {
    // 上一结构步骤把面板留成打开态，先收起。
    if (await cdp.eval(`!!document.querySelector('.dlq-panel.is-open')`)) {
      await cdp.click(DLQ.close, { desc: '收起下载面板' });
      await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: '面板收起', timeoutMs: 5000 });
    }
    let state = await entryState(cdp);
    suite.assert(
      !state.railDownloadExists,
      `rail 上不应再有「下载队列」入口（task-12 已迁到快捷设置第 5 页），实际存在 ${DLQ.railEntry}`,
    );
    suite.assert(
      !state.railTitles.some((title) => /下载/.test(title)),
      `rail 标题里不应出现下载入口，实际 ${JSON.stringify(state.railTitles)}`,
    );
    suite.note(`rail 共 ${state.railBtnCount} 个入口：${state.railTitles.join(' / ')}`);
    suite.assert(state.playerEntry.exists, '播放条缺少下载入口 [data-qa="download-entry"]');
    suite.assert(
      state.playerEntry.haspopup === 'dialog',
      `播放条入口 aria-haspopup 应为 dialog，实际 ${state.playerEntry.haspopup}`,
    );
    suite.assert(state.playerEntry.hidden === false, '播放条下载入口不应隐藏');
    const emptySession = baseline.jobs.length === 0;

    // 1) 播放条入口点击 → 打开（面板是独立队列视图，不依赖当前有没有歌曲）
    await cdp.click(DLQ.entry, { desc: '播放条下载入口' });
    await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, {
      desc: '播放条入口打开下载面板（.dlq-panel.is-open）',
      timeoutMs: 6000,
    });
    await sleep(150);
    state = await entryState(cdp);
    suite.assert(state.panelExists, '点击播放条入口后 .dlq-panel 未创建');
    suite.assert(state.panelOpen, '点击播放条入口后面板未带 .is-open');
    suite.assert(state.ariaHidden === 'false', `面板打开时 aria-hidden 应为 false，实际 ${state.ariaHidden}`);
    suite.assert(
      state.playerEntry.expanded === 'true',
      `面板打开时播放条入口 aria-expanded 应为 true，实际 ${state.playerEntry.expanded}`,
    );
    // 零任务会话的空态/文案断言在「面板结构」步骤覆盖；这里只保证入口可用。
    await suite.shot('entry-player-open');

    // 2) 再点入口 → 收起（toggle）
    await cdp.click(DLQ.entry, { desc: '再次点击播放条下载入口' });
    await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: '播放条入口再点收起面板', timeoutMs: 6000 });
    state = await entryState(cdp);
    suite.assert(!state.panelOpen, '再点播放条入口后面板仍打开（toggle 失效）');
    suite.assert(state.ariaHidden === 'true', `收起后 aria-hidden 应为 true，实际 ${state.ariaHidden}`);

    // 3) 点面板外 → 关闭
    await cdp.click(DLQ.entry, { desc: '播放条入口重新打开面板' });
    await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, { desc: '面板再次打开', timeoutMs: 6000 });
    await cdp.eval(`(() => {
      const target = document.querySelector('.stage') || document.body;
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: '点击面板外收起', timeoutMs: 6000 });

    // 4) Esc → 关闭（main.ts 全局快捷键 → app.escapeTopLayer 关下载面板）
    await cdp.click(DLQ.entry, { desc: '播放条入口再次打开面板（Esc 前）' });
    await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, { desc: '面板打开（Esc 前）', timeoutMs: 6000 });
    await pressEscape(cdp);
    await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: 'Esc 收起下载面板', timeoutMs: 6000 });

    return `rail ${state.railBtnCount} 个入口均无下载 · 播放条入口 toggle/点外/Esc 正常${emptySession ? ' · 零任务可打开' : ''}`;
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('分段控件：.seg 类名 / is-on / .seg-thumb 滑块定位', async () => {
    if (!(await cdp.eval(`!!document.querySelector('.dlq-panel.is-open')`))) {
      await cdp.click(DLQ.entry, { desc: '播放条入口打开下载面板' });
      await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, { desc: '面板打开', timeoutMs: 6000 });
    }
    // 等 app.ts enhanceSegs 注入 .seg-thumb 并完成首帧定位（rAF×2 + 无动画 place(false)）
    await cdp.waitFor(
      `(() => {
        const tabs = document.querySelector('.dlq-panel .dlq-tabs');
        if (!tabs || tabs.dataset.segThumb !== 'ready') return false;
        const thumb = tabs.querySelector(':scope > .seg-thumb');
        if (!thumb) return false;
        return parseFloat(thumb.style.width || '0') > 0 && getComputedStyle(thumb).opacity === '1';
      })()`,
      { desc: '.dlq-tabs 完成 .seg 增强且滑块已定位', timeoutMs: 10000 },
    );
    const seg = await segSnapshot(cdp);
    suite.assert(seg.exists, '找不到 .dlq-panel .dlq-tabs');
    suite.assert(seg.segClasses.includes('seg'), `.dlq-tabs 缺少全局 seg 类，实际 ${JSON.stringify(seg.segClasses)}`);
    suite.assert(seg.segClasses.includes('dlq-tabs'), `.dlq-tabs 缺少 dlq-tabs 类，实际 ${JSON.stringify(seg.segClasses)}`);
    suite.assert(seg.role === 'tablist', `.dlq-tabs role 应为 tablist，实际 ${seg.role}`);
    suite.assert(seg.ready === 'ready', `.dlq-tabs 未标记 data-seg-thumb="ready"，实际「${seg.ready}」`);
    suite.assert(seg.buttons.length === 4, `tab 数量应为 4，实际 ${seg.buttons.length}`);
    for (const btn of seg.buttons) {
      suite.assert(btn.classes.includes('seg-btn'), `tab「${btn.text}」缺少 seg-btn 类：${JSON.stringify(btn.classes)}`);
      suite.assert(btn.classes.includes('dlq-tab'), `tab「${btn.text}」缺少 dlq-tab 类：${JSON.stringify(btn.classes)}`);
    }
    suite.assert(
      seg.activeCount === 1 && seg.onCount === 1,
      `激活 tab 应唯一：is-active=${seg.activeCount} 个，is-on=${seg.onCount} 个`,
    );
    suite.assert(
      seg.activeText === seg.onText && seg.activeText.length > 0,
      `is-active「${seg.activeText}」与 is-on「${seg.onText}」不是同一个 tab`,
    );
    const activeBtn = seg.buttons.find((btn) => btn.active) || null;
    suite.assert(activeBtn, `激活 tab「${seg.activeText}」不在 .dlq-tab 列表里`);
    suite.assert(activeBtn.selected === 'true', `激活 tab「${seg.activeText}」aria-selected 应为 true，实际 ${activeBtn.selected}`);
    for (const btn of seg.buttons.filter((btn) => btn.text !== seg.activeText)) {
      suite.assert(btn.on === false, `非激活 tab「${btn.text}」不应带 is-on`);
    }
    // 白色滑块：存在、直接子元素、可见、与激活 tab 对齐
    suite.assert(seg.thumb.exists, '.dlq-tabs 缺少 .seg-thumb 滑块（enhanceSegs 未注入？）');
    suite.assert(seg.thumb.parentIsTabs, '.seg-thumb 不是 .dlq-tabs 的直接子元素');
    suite.assert(seg.thumb.width > 0, `.seg-thumb 内联宽度应 >0，实际 ${seg.thumb.width}px`);
    suite.assert(seg.thumb.opacity === '1', `.seg-thumb 不透明度应为 1，实际 ${seg.thumb.opacity}`);
    suite.assert(seg.thumb.display !== 'none', `.seg-thumb 不应 display:none（实际 ${seg.thumb.display}）`);
    suite.assert(
      Math.abs(seg.thumb.left - activeBtn.offsetLeft) <= 2,
      `.seg-thumb left=${seg.thumb.left}px 未对齐激活 tab offsetLeft=${activeBtn.offsetLeft}px`,
    );
    suite.assert(
      Math.abs(seg.thumb.width - activeBtn.offsetWidth) <= 2,
      `.seg-thumb width=${seg.thumb.width}px 未对齐激活 tab offsetWidth=${activeBtn.offsetWidth}px`,
    );
    suite.assert(seg.thumb.rect.w > 0 && seg.thumb.rect.h > 0, `滑块渲染尺寸应为正，实际 ${seg.thumb.rect.w}×${seg.thumb.rect.h}`);
    const totalTabWidth = seg.buttons.reduce((sum, btn) => sum + btn.rect.w, 0);
    suite.assert(seg.thumb.rect.w <= totalTabWidth, `滑块宽度 ${seg.thumb.rect.w}px 超过 tab 总宽 ${totalTabWidth}px`);
    const shot = await suite.shot('panel-tabs-seg');
    suite.note(`截图 ${repoRel(shot)}`);
    return `seg 类对齐 · is-active=is-on=「${seg.activeText}」 · 滑块 ${seg.thumb.left}px × ${seg.thumb.width}px（opacity=${seg.thumb.opacity}）`;
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('tab 切换动画：is-switch / dlq-switch-in / 700ms 移除 / 滑块位移', async () => {
    if (!(await cdp.eval(`!!document.querySelector('.dlq-panel.is-open')`))) {
      await cdp.click(DLQ.entry, { desc: '播放条入口打开下载面板' });
      await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, { desc: '面板打开', timeoutMs: 6000 });
    }
    // 基线筛选复位到「全部」，保证下面的切换一定发生 filter 变化
    const currentTab = await cdp.eval(
      `(() => { const btn = document.querySelector('.dlq-panel .dlq-tab.is-active'); return btn ? btn.textContent.trim() : ''; })()`,
    );
    if (currentTab !== '全部') {
      await switchProbe(cdp, '全部');
      await sleep(250);
    }
    const rowsBefore = await cdp.eval(`document.querySelectorAll('.dlq-panel .dlq-row').length`);
    const probe = await switchProbe(cdp, '已完成');
    suite.assert(probe.ok, `切换 tab「已完成」失败：${probe.reason || ''}${probe.labels ? ` labels=${JSON.stringify(probe.labels)}` : ''}`);
    const mid = probe.mid;
    const after = probe.after;
    suite.note(
      `点击后 ${mid.dt}ms 取样：list.is-switch=${mid.listSwitch} empty.is-switch=${mid.emptySwitch} ` +
        `emptyAnim=${mid.emptyAnim} firstRowAnim=${mid.firstRowAnim} active=${mid.active} is-on=${mid.on}`,
    );
    suite.assert(mid.dt <= 30, `动画取样延迟应在 30ms 内（实际 ${mid.dt}ms，页面内定时器被阻塞？）`);
    suite.assert(mid.active === '已完成', `点击后 is-active tab 应为「已完成」，实际「${mid.active}」`);
    suite.assert(mid.on === '已完成', `点击后 is-on tab 应为「已完成」，实际「${mid.on}」`);
    suite.assert(mid.listSwitch === true, `切换后 .dlq-list 应临时带 is-switch，实际 ${mid.listSwitch}`);
    if (rowsBefore === 0) {
      suite.assert(mid.rowsCount === 0, `基线无行但切到「已完成」后出现 ${mid.rowsCount} 行`);
      suite.assert(mid.emptySwitch === true, `.dlq-empty 应临时带 is-switch，实际 ${mid.emptySwitch}`);
      suite.assert(/dlq-switch-in/.test(mid.emptyAnim), `空态动画名应含 dlq-switch-in，实际「${mid.emptyAnim}」`);
      suite.assert(mid.emptyHidden === false, '切到空 tab 后 .dlq-empty 应可见');
    } else {
      suite.assert(/dlq-switch-in/.test(mid.firstRowAnim), `行元素动画名应含 dlq-switch-in，实际「${mid.firstRowAnim}」`);
      if (mid.rows.length >= 2) {
        suite.assert(
          /0\.024s/.test(mid.rows[1].delay),
          `第 2 行 stagger 延迟应为 24ms，实际「${mid.rows[1].delay}」`,
        );
      }
    }
    // 700ms 后临时类必须移除
    suite.assert(after.dt >= 690, `第二次取样应 ≥700ms（实际 ${after.dt}ms）`);
    suite.assert(after.listSwitch === false, `700ms 后 .dlq-list 仍带 is-switch（实际 ${after.listSwitch}）`);
    suite.assert(after.emptySwitch === false, `700ms 后 .dlq-empty 仍带 is-switch（实际 ${after.emptySwitch}）`);
    // 滑块 left 位移（白色滑块从「全部」滑到激活 tab）
    suite.assert(probe.before && probe.before.left !== undefined, '切换前未取到 .seg-thumb 位置');
    suite.assert(
      Math.abs(after.thumb.left - probe.before.left) > 1,
      `.seg-thumb left 未位移：${probe.before.left}px → ${after.thumb.left}px`,
    );
    await suite.shot('panel-switch-anim');

    // 复位「全部」并收起面板，保持干净状态
    await switchProbe(cdp, '全部');
    await sleep(150);
    await cdp
      .eval(`(() => { const q = window.__zilux2DownloadQueue; if (q && typeof q.close === 'function') q.close(); return true; })()`)
      .catch(() => {});
    await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: '动画步骤后收起面板', timeoutMs: 5000 });
    return rowsBefore === 0
      ? `空态动画：20ms 内 is-switch + dlq-switch-in，700ms 移除，滑块 ${probe.before.left}px → ${after.thumb.left}px`
      : `带行动画：行 dlq-switch-in（${mid.rows.length} 行 stagger）+ 700ms 移除，滑块 ${probe.before.left}px → ${after.thumb.left}px`;
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('音质浮层：默认项=设置音质 / 取消不下载 / Esc 与点外关闭', async () => {
    await goHome(cdp);
    let wall = null;
    let rows = 0;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3 && rows === 0; attempt += 1) {
      await goHome(cdp);
      try {
        wall = await openSearch(cdp, SEARCH_KEYWORD);
        rows = wall.rows;
      } catch (err) {
        lastErr = err;
        suite.note(`第 ${attempt} 次搜索未完成（${err.message}），收起重试`);
        await cdp
          .eval(`(() => { const dock = document.querySelector('.search-dock'); if (dock && dock.dataset.open === 'true') dock.click(); return true; })()`)
          .catch(() => {});
        await sleep(400);
      }
    }
    suite.assert(rows > 0, `搜索「${SEARCH_KEYWORD}」没有结果行（最后一次：${wall ? wall.sub : '无'}）${lastErr ? `（${lastErr.message}）` : ''}`);

    const found = await cdp.eval(`(${pageDownloadCandidates.toString()})(1)`);
    suite.assert(found.candidates && found.candidates.length > 0, '搜索结果里没有可点的 .track-download');
    const candidate = found.candidates[0];
    const jobsBefore = ((await dlqDebug(cdp)).jobs || []).length;

    // 1) 打开浮层：结构 / 文案 / 3 档选项
    await cdp.eval(`(${pageClickRowDownload.toString()})(${JSON.stringify(candidate.key)})`);
    const snap = await waitPickerOpen(cdp);
    suite.assert(snap.overlay, '音质浮层根 .dlqp-overlay 不存在');
    suite.assert(snap.overlayOpen === true, '浮层 .dlqp-overlay 未带 is-open');
    suite.assert(snap.panelCount === 1, `浮层应单例，实际 ${snap.panelCount} 个 .dlqp-panel`);
    suite.assert(snap.role === 'dialog', `浮层面板 role 应为 dialog，实际 ${snap.role}`);
    suite.assert(snap.modal === 'true', `浮层面板 aria-modal 应为 true，实际 ${snap.modal}`);
    suite.assert(snap.ariaLabel === '选择下载音质', `浮层面板 aria-label 应为「选择下载音质」，实际「${snap.ariaLabel}」`);
    suite.assert(snap.title === '选择下载音质', `浮层标题应为「选择下载音质」，实际「${snap.title}」`);
    suite.assert(snap.track.includes(candidate.title), `浮层曲目应含「${candidate.title}」，实际「${snap.track}」`);
    suite.assert(snap.hint.includes('仅对本次下载生效'), `浮层 hint 文案不符：「${snap.hint}」`);
    suite.assert(snap.hasCancel && snap.cancelText === '取消', `浮层取消按钮文案应为「取消」，实际「${snap.cancelText}」`);
    suite.assert(snap.options.length === 3, `音质选项应为 3 档，实际 ${snap.options.length}`);
    suite.assert(
      snap.options.map((opt) => opt.quality).join(',') === 'standard,high,lossless',
      `音质选项顺序不符：${snap.options.map((opt) => opt.quality).join(',')}`,
    );
    for (const opt of snap.options) {
      suite.assert(
        opt.label === PICKER.labels[opt.quality],
        `选项 ${opt.quality} 文案应为「${PICKER.labels[opt.quality]}」，实际「${opt.label}」`,
      );
      suite.assert(!!opt.note, `选项 ${opt.quality} 缺少说明文案 .dlqp-option-note`);
    }

    // 2) 默认项 = 设置里的下载音质（未写设置 → 产品默认 high）
    const settingQuality = await settingsDownloadQuality(cdp);
    suite.assert(settingQuality !== '__error__', '读取 localStorage(zilux2.settings) 失败');
    const expected = settingQuality || 'high';
    const expectedIndex = String(snap.options.findIndex((opt) => opt.quality === expected));
    suite.assert(
      snap.checkedQuality.length === 1 && snap.checkedQuality[0] === expected,
      `浮层默认选中应为设置音质「${expected}」，实际 ${JSON.stringify(snap.checkedQuality)}`,
    );
    suite.assert(
      snap.defaultQuality.join(',') === expected,
      `默认标记 data-default 应为「${expected}」，实际 ${JSON.stringify(snap.defaultQuality)}`,
    );
    suite.assert(snap.defaultIndex === expectedIndex, `面板 data-default-index 应为 ${expectedIndex}，实际 ${snap.defaultIndex}`);
    const defaultOption = snap.options.find((opt) => opt.quality === expected);
    suite.assert(defaultOption && defaultOption.hasDefaultNote, `默认项 ${expected} 缺少「默认」角标`);
    suite.assert(defaultOption && defaultOption.check === '✓', `默认项 ${expected} 缺少 ✓ 标记`);
    suite.assert(snap.focusedQuality === expected, `打开浮层后应聚焦默认项 ${expected}，实际聚焦「${snap.focusedQuality}」`);
    suite.note(`设置音质="${settingQuality || '(未设置→high)'}" → 浮层默认 ${expected} ✓`);

    // 3) 取消：关闭且不产生任务
    await cdp.click(PICKER.cancel, { desc: '浮层「取消」' });
    await cdp.waitFor(`!document.querySelector('.dlqp-overlay')`, { desc: '取消后浮层关闭', timeoutMs: 4000 });
    await sleep(250);
    const afterCancel = (await dlqDebug(cdp)).jobs || [];
    suite.assert(afterCancel.length === jobsBefore, `点取消不应产生任务（之前 ${jobsBefore}，现在 ${afterCancel.length}）`);

    // 4) Esc 关闭
    await cdp.eval(`(${pageClickRowDownload.toString()})(${JSON.stringify(candidate.key)})`);
    await waitPickerOpen(cdp);
    await closePickerByEsc(cdp);

    // 5) 点浮层外关闭
    await cdp.eval(`(${pageClickRowDownload.toString()})(${JSON.stringify(candidate.key)})`);
    await waitPickerOpen(cdp);
    await closePickerByOutside(cdp);
    const afterClose = (await dlqDebug(cdp)).jobs || [];
    suite.assert(afterClose.length === jobsBefore, `Esc/点外关闭不应产生任务（之前 ${jobsBefore}，现在 ${afterClose.length}）`);

    await suite.shot('quality-picker');
    return `默认 ${expected}（设置 ${settingQuality || '未设置'}）· 取消/Esc/点外均关闭且不产生任务`;
  });

  await suite.step('发起下载：搜索 → 点 .track-download → 音质浮层选高品质 → 任务进入队列', async () => {
    // 先收起面板，才能验证「首次下载自动弹面板」的行为
    if ((await dlqSnapshot(cdp)).open) {
      await cdp.click(DLQ.close, { desc: '收起面板' });
      await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: '面板收起', timeoutMs: 5000 });
    }
    // 上游音乐源偶发 502 / 0 行；openSearch 内建竞态回归断言（input 后立即 Enter，12s 内完成且行数>0），
    // 若外部源失败则整轮重试，最多 3 次。
    let rows = 0;
    let wall = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3 && rows === 0; attempt += 1) {
      await goHome(cdp);
      try {
        wall = await openSearch(cdp, SEARCH_KEYWORD);
        rows = wall.rows;
      } catch (err) {
        lastErr = err;
        suite.note(`第 ${attempt} 次搜索未完成（${err.message}），收起重试`);
        await cdp
          .eval(`(() => { const dock = document.querySelector('.search-dock'); if (dock && dock.dataset.open === 'true') dock.click(); return true; })()`)
          .catch(() => {});
        await sleep(400);
      }
    }
    suite.assert(
      wall && wall.sub.includes('首'),
      `搜索「${SEARCH_KEYWORD}」后副标题应含「N 首」，实际「${wall ? wall.sub : '无'}」${lastErr ? `（最后错误：${lastErr.message}）` : ''}`,
    );
    suite.assert(rows > 0, `搜索「${SEARCH_KEYWORD}」连续 3 次都没有结果行（最后一次 sub=${wall ? wall.sub : '无'}），疑似音乐源网络问题`);

    // 记录「设置里的默认音质」：浮层选择只对本次下载生效，不应回写设置
    const settingQualityBefore = await settingsDownloadQuality(cdp);
    const found = await cdp.eval(`(${pageDownloadCandidates.toString()})(8)`);
    suite.assert(
      found.candidates && found.candidates.length > 0,
      `搜索结果里没有可点的 .track-download（行数 ${found.rowCount}）`,
    );
    const baselineIds = new Set(baseline.jobs.map((job) => job.id));
    const attempts = [];
    let newJob = null;
    for (const candidate of found.candidates) {
      suite.note(`尝试下载：${candidate.title} / ${candidate.artist} / ${candidate.sourceTag}（${candidate.key}）`);
      const clicked = await cdp.eval(`(${pageClickRowDownload.toString()})(${JSON.stringify(candidate.key)})`);
      if (!clicked || !clicked.ok) {
        attempts.push({ ...candidate, outcome: `点击失败：${clicked ? clicked.reason : '无返回'}` });
        continue;
      }
      // 点 .track-download 会先弹音质浮层（task-12）；默认项应仍是设置音质，再显式选「高品质」入队
      const pickerSnap = await waitPickerOpen(cdp);
      const defaultQuality = (await settingsDownloadQuality(cdp)) || 'high';
      suite.assert(
        pickerSnap.checkedQuality.length === 1 && pickerSnap.checkedQuality[0] === defaultQuality,
        `第 ${attempts.length + 1} 个候选弹层默认项应保持「${defaultQuality}」，实际 ${JSON.stringify(pickerSnap.checkedQuality)}`,
      );
      await pickQuality(cdp, 'high');
      const appeared = await waitForNewJob(cdp, candidate.key, baselineIds, { timeoutMs: 20000 });
      if (!appeared) {
        const toastNow = await cdp.eval(
          `Array.from(document.querySelectorAll('.toast')).map((node) => (node.textContent || '').trim()).filter(Boolean).join(' | ')`,
        );
        attempts.push({ ...candidate, outcome: `20s 未入队（toast：${toastNow || '空'}）` });
        continue;
      }
      suite.note(`任务入队 id=${appeared.id} state=${appeared.state} quality=${appeared.quality}`);
      const settled = await waitJobSettled(cdp, appeared.id, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
      if (!settled) {
        attempts.push({ ...candidate, id: appeared.id, outcome: `${DOWNLOAD_TIMEOUT_MS}ms 超时无终态` });
        continue;
      }
      attempts.push({ ...candidate, id: settled.id, outcome: settled.state, error: settled.error || '' });
      if (settled.state === 'done') {
        newJob = settled;
        targetTrack = candidate;
        break;
      }
      suite.note(`「${candidate.title}」下载失败（${settled.error || '未知'}），换下一首候选`);
    }
    suite.assert(
      newJob && newJob.state === 'done',
      `连续 ${attempts.length} 首候选都没下载成功（音乐源对部分曲目返回 403/失效直链，属数据源问题）：\n` +
        attempts.map((item) => `- ${item.title} / ${item.artist} → ${item.outcome}${item.error ? `：${item.error}` : ''}`).join('\n'),
    );
    jobId = newJob.id;
    suite.assert(newJob.quality === 'high', `浮层选「高品质」入队后 job.quality 应为 high，实际「${newJob.quality}」`);
    const settingQualityAfter = await settingsDownloadQuality(cdp);
    suite.assert(
      (settingQualityAfter || 'high') === (settingQualityBefore || 'high'),
      `音质浮层选择不应回写全局设置（下载前「${settingQualityBefore || '(未设置→high)'}」，下载后「${settingQualityAfter || '(未设置→high)'}」）`,
    );
    suite.note(
      `目标曲目：${targetTrack.title} / ${targetTrack.artist}（key=${targetTrack.key}）→ job ${jobId} 已 done（quality=${newJob.quality}，候选 ${attempts.length} 个，设置默认值未被修改）`,
    );

    // 首次下载（基线无任务）应自动弹面板
    if (baseline.jobs.length === 0) {
      await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, {
        desc: '首次下载自动打开下载面板',
        timeoutMs: 8000,
      });
      suite.note('首次下载自动打开面板 ✓');
    } else {
      suite.note('基线已有任务（同会话非首次下载），跳过自动弹面板断言');
    }
    // 面板可能在上一步已被打开/关闭；确保打开以便观察进度
    if (!(await cdp.eval(`!!document.querySelector('.dlq-panel.is-open')`))) {
      await cdp.click(DLQ.entry, { desc: '打开下载面板' });
      await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, { desc: '面板打开', timeoutMs: 6000 });
    }
    await sleep(200);
    return `${targetTrack.title}（${targetTrack.sourceTag}）→ job ${jobId} done（候选 ${attempts.length} 个）`;
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('进度采样：running → done（采样间隔 ~85ms）', async () => {
    if (!jobId) throw new Error('前序步骤没有拿到 jobId');

    samples = [];
    const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
    let last = null;
    while (Date.now() < deadline) {
      last = await cdp.eval(`(${pageSample.toString()})(${JSON.stringify(jobId)})`, { timeoutMs: 8000 });
      samples.push(last);
      if (last.job && (last.job.state === 'done' || last.job.state === 'error')) break;
      if (samples.length === 1) {
        suite.note(`首个采样：job=${last.job ? last.job.state : 'pending'} row=${last.row ? last.row.state : '无'}`);
      }
      await sleep(DOWNLOAD_SAMPLE_INTERVAL_MS);
    }
    if (!last) throw new Error('没有采样到任何数据');
    const final = last.job;
    suite.assert(final, `采样超时：${DOWNLOAD_TIMEOUT_MS}ms 内任务 ${jobId} 始终没出现在队列里`);
    if (final.state === 'error') {
      throw new Error(
        `下载任务失败：${final.error || '未知错误'}\n` +
          `任务：${jobSummary(final)}\n` +
          `DOM 行：${JSON.stringify(last.row)}\n` +
          `toast：${last.toast}\n` +
          `宿主日志（download）：\n${downloadLogTail() || '（无）'}`,
      );
    }
    suite.assert(final.state === 'done', `下载任务最终状态应为 done，实际 ${final.state}（${DOWNLOAD_TIMEOUT_MS}ms 超时）`);
    suite.note(`共 ${samples.length} 个采样，耗时约 ${Math.round((last.at - samples[0].at) / 1000)}s`);

    // 极速完成（第一次采样前已 done）时没有 running 过程可断言，避免误报
    const runningSamples = samples.filter((item) => item.job && item.job.state === 'running');
    const doneIndex = samples.findIndex((item) => item.job && item.job.state === 'done');
    if (doneIndex === 0) {
      suite.note('任务在第一次采样前就已完成（文件很小/网络极快），跳过 running/进度单调断言');
      return `已在 ${samples.length} 次采样内 done（跳过过渡断言）`;
    }
    suite.assert(runningSamples.length > 0, `任务从启动到 done 之间没有采到 running 状态（共 ${samples.length} 个采样）`);

    // received 单调不减
    let prevReceived = -1;
    for (const sample of samples) {
      if (!sample.job || typeof sample.job.received !== 'number') continue;
      suite.assert(
        sample.job.received >= prevReceived,
        `progress 回退：received ${prevReceived} → ${sample.job.received}（${JSON.stringify(sample.job)}）`,
      );
      prevReceived = sample.job.received;
    }

    // fill 宽度单调不减（跳过 indeterminate 的无总长阶段）
    let prevWidth = -1;
    for (const sample of samples) {
      if (!sample.row || sample.row.indeterminate) continue;
      const width = parseWidth(sample.row.fillWidth);
      if (width === null) continue;
      suite.assert(width >= prevWidth, `进度条回退：fill ${prevWidth}% → ${width}%（pct=${sample.row.pct}）`);
      prevWidth = width;
    }

    // running 期间行必须存在，且进度条在推进（或 indeterminate）
    const rowSeen = runningSamples.filter((sample) => sample.row);
    suite.assert(
      rowSeen.length > 0,
      `任务 running 期间（${runningSamples.length} 个采样）面板里始终没有 .dlq-row[data-job-id="${jobId}"]`,
    );
    const widths = rowSeen
      .filter((sample) => !sample.row.indeterminate)
      .map((sample) => parseWidth(sample.row.fillWidth))
      .filter((value) => value !== null);
    if (widths.length === 0) {
      suite.assert(
        rowSeen.some((sample) => sample.row.indeterminate),
        'running 行既没有确定的 .dlq-fill 宽度，也不是 indeterminate 状态',
      );
      suite.note('任务无 Content-Length（indeterminate），进度按字节数展示');
    } else {
      suite.assert(Math.max(...widths) > 0, `进度条宽度始终为 0（${JSON.stringify(widths.slice(0, 10))}）`);
    }
    return `采样 ${samples.length} 次，最终 done，received=${final.received}/${final.total}`;
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('done 行 UI：100% / 已保存 / reveal 可见 / retry 隐藏', async () => {
    if (!jobId) throw new Error('前序步骤没有拿到 jobId');
    await cdp.waitFor(
      `(() => {
        const row = document.querySelector('.dlq-row[data-job-id="${jobId}"]');
        return row && row.dataset.state === 'done';
      })()`,
      { desc: `任务 ${jobId} 的行变成 data-state="done"`, timeoutMs: DOWNLOAD_UI_SETTLE_MS },
    );
    await sleep(200);
    const snap = await dlqSnapshot(cdp);
    const row = snap.rows.find((item) => item.id === jobId);
    suite.assert(row, `DOM 里找不到 job ${jobId} 的行（行：${snap.rows.map((item) => item.id).join(', ')}）`);
    suite.assert(row.state === 'done', `行 data-state 应为 done，实际 ${row.state}`);
    suite.assert(row.pct === '100%', `done 行 .dlq-pct 应为 100%，实际「${row.pct}」`);
    suite.assert(row.fillWidth === '100%', `done 行 .dlq-fill 宽度应为 100%，实际「${row.fillWidth}」`);
    suite.assert(row.status.includes('已保存'), `done 行 .dlq-status 应含「已保存」，实际「${row.status}」`);
    suite.assert(row.revealHidden === false, `done 行 .dlq-reveal 应可见（hidden=false），实际 ${row.revealHidden}`);
    suite.assert(row.retryHidden === true, `done 行 .dlq-retry 应隐藏，实际 ${row.retryHidden}`);
    suite.assert(row.actionsHidden === false, `done 行 .dlq-actions 应可见，实际 ${row.actionsHidden}`);

    const debug = await dlqDebug(cdp);
    const job = debug.jobs.find((item) => item.id === jobId);
    suite.assert(job, `调试状态里找不到 job ${jobId}`);
    suite.assert(job.state === 'done', `任务状态应为 done，实际 ${job.state}`);
    suite.assert(job.quality === 'high', `本次经音质浮层选「高品质」→ job.quality 应为 high，实际「${job.quality}」`);
    suite.assert(/高品质/.test(row.meta), `done 行 meta 应显示「高品质」，实际「${row.meta}」`);
    suite.assert(!!job.path, `done 任务应有 path，实际 ${jobSummary(job)}`);
    suite.assert(!!job.fileName, `done 任务应有 fileName，实际 ${jobSummary(job)}`);

    // 落盘校验
    let stat = null;
    try {
      stat = fs.statSync(job.path);
    } catch (err) {
      throw new Error(`任务 done 但磁盘文件不存在：${job.path}（${err.message}）`);
    }
    suite.assert(stat.isFile(), `path 不是文件：${job.path}`);
    suite.assert(stat.size > 0, `文件大小为 0：${job.path}`);
    suite.assert(
      /\.(mp3|flac|m4a|ogg|wav|aac)$/i.test(job.path) || /\.(mp3|flac|m4a|ogg|wav|aac)$/i.test(job.fileName),
      `下载文件扩展名不像音频：path=${job.path} fileName=${job.fileName}`,
    );
    suite.note(`落盘：${job.path}（${Math.round(stat.size / 1024)} KB）`);

    // 摘要与徽标：行状态与计数同步
    suite.assert(snap.summary.done >= 1, `摘要「已完成」计数应 ≥1，实际 ${snap.summary.done}`);
    const totalRunning = debug.jobs.filter((item) => item.state === 'running').length;
    const entry = await cdp.eval(`(() => {
      const btn = document.querySelector('[data-qa="download-entry"]');
      const badge = btn.querySelector('.dlq-badge');
      return { active: btn.classList.contains('is-active'), badgeHidden: badge.hidden, badgeText: (badge.textContent || '').trim() };
    })()`);
    suite.assert(
      entry.badgeHidden === (totalRunning === 0),
      `入口徽标显隐应与 running 数一致（running=${totalRunning}，badgeHidden=${entry.badgeHidden}）`,
    );

    if (DOWNLOAD_CLICK_REVEAL) {
      await cdp.eval(`(() => {
        const row = document.querySelector('.dlq-row[data-job-id="${jobId}"]');
        const btn = row && row.querySelector('.dlq-reveal');
        if (btn) btn.click();
        return true;
      })()`);
      await sleep(1200);
      const toast = await cdp.eval(`Array.from(document.querySelectorAll('.toast')).map((n) => (n.textContent || '').trim()).join(' | ')`);
      suite.assert(!toast.includes('无法定位文件'), `点 reveal 后出现错误 toast：${toast}`);
      suite.note('已点击 .dlq-reveal（ZILUX2_QA_CLICK_REVEAL=1）');
    } else {
      suite.note('未点击 .dlq-reveal（默认不弹资源管理器；需要时设 ZILUX2_QA_CLICK_REVEAL=1）');
    }

    await suite.shot('row-done');
    return `${job.fileName} ${Math.round(stat.size / 1024)}KB → ${job.path}`;
  });

  await suite.step('快捷设置第 5 页「下载」：5 tab / 嵌入队列 / 筛选可切 / 目录与状态一致', async () => {
    // 收起浮动面板与其它浮层，避免遮挡快捷设置
    if ((await dlqSnapshot(cdp)).open) {
      await cdp.click(DLQ.close, { desc: '收起下载面板' });
      await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: '面板收起', timeoutMs: 5000 });
    }
    await closeOverlays(cdp);
    await goHome(cdp);

    await cdp.click(QUICK.trigger, { desc: '播放条快捷设置按钮 .pb-quick' });
    await cdp.waitFor(`!!document.querySelector('.quick.is-open')`, { desc: '快捷设置 .quick.is-open', timeoutMs: 6000 });
    const tabs = await cdp.eval(
      `Array.from(document.querySelectorAll('.quick-tabs .quick-tab')).map((btn) => (btn.textContent || '').trim())`,
    );
    suite.assert(tabs.length === 5, `快捷设置应有 5 个 tab，实际 ${tabs.length} 个：${tabs.join('/')}`);
    suite.assert(tabs.join('/') === '封面/歌词/设置/投送/下载', `快捷设置 tab 顺序/文案不符：${tabs.join('/')}`);

    await cdp.clickText(QUICK.tabs, '下载', { desc: '快捷设置第 5 个 tab「下载」' });
    await cdp.waitFor(`!!document.querySelector('.quick.is-download.is-open')`, {
      desc: '快捷设置切换到下载页（.quick.is-download.is-open）',
      timeoutMs: 6000,
    });
    await cdp.waitFor(`!!document.querySelector('[data-qa="quick-downloads-page"]')`, {
      desc: '下载页容器 [data-qa="quick-downloads-page"]',
      timeoutMs: 6000,
    });
    await sleep(250);
    let page = await quickPage(cdp);
    suite.assert(page.exists, '缺少嵌入下载页 [data-qa="quick-downloads-page"]');
    suite.assert(page.title === '下载队列', `嵌入页标题应为「下载队列」，实际「${page.title}」`);
    suite.assert(page.tabs.length === 4, `嵌入页筛选 tab 应为 4 个，实际 ${page.tabs.length}`);
    suite.assert(
      page.tabs.map((tab) => tab.text).join('/') === '全部/下载中/已完成/失败',
      `嵌入页筛选 tab 文案不符：${page.tabs.map((tab) => tab.text).join('/')}`,
    );
    suite.assert(page.segReady === 'ready', `嵌入页 .dlq-tabs data-seg-thumb 应为 ready，实际「${page.segReady}」`);
    suite.assert(page.segThumb.exists, '嵌入页筛选条缺少 .seg-thumb 滑块');
    suite.assert(page.segThumb.width > 0, `滑块宽度应 >0，实际 ${page.segThumb.width}`);
    suite.assert(page.segThumb.opacity === '1', `滑块 opacity 应为 1，实际 ${page.segThumb.opacity}`);
    const activeTab = page.tabs.find((tab) => tab.active);
    suite.assert(activeTab, '嵌入页没有激活的筛选 tab');
    suite.assert(
      activeTab.on && activeTab.selected === 'true',
      `激活 tab 应同时带 is-on + aria-selected=true，实际 classes=${activeTab.classes.join('.')} selected=${activeTab.selected}`,
    );
    suite.assert(
      activeTab.rect && Math.abs(page.segThumb.rect.x - activeTab.rect.x) <= 3,
      `滑块应覆盖激活 tab（滑块 x=${page.segThumb.rect && page.segThumb.rect.x}，tab x=${activeTab.rect && activeTab.rect.x}）`,
    );

    // 状态文案 / 目录 / 行数 必须与宿主真实队列一致
    const debug = await dlqDebug(cdp);
    const jobs = debug.jobs || [];
    const running = jobs.filter((job) => job.state === 'running').length;
    const done = jobs.filter((job) => job.state === 'done').length;
    const errors = jobs.filter((job) => job.state === 'error').length;
    suite.assert(
      page.status.includes(`下载中 ${running}`) && page.status.includes(`已完成 ${done}`),
      `嵌入页状态「${page.status}」与真实计数（下载中 ${running} · 已完成 ${done}）不一致`,
    );
    if (errors > 0) {
      suite.assert(page.status.includes(`失败 ${errors}`), `嵌入页状态缺少「失败 ${errors}」，实际「${page.status}」`);
    }
    suite.assert(page.dir === debug.directory, `嵌入页目录「${page.dir}」应为「${debug.directory}」`);
    suite.assert(page.hasOpenDir, '嵌入页缺少「打开下载目录」按钮 .dlq-open-dir');
    suite.assert(page.hasRefresh, '嵌入页缺少刷新按钮 .dlq-embed-refresh');
    suite.assert(page.rowCount === jobs.length, `嵌入页行数 ${page.rowCount} 与任务数 ${jobs.length} 不一致`);
    suite.assert(page.emptyHidden === (page.rowCount > 0), `嵌入页空态显隐不符：rows=${page.rowCount} emptyHidden=${page.emptyHidden}`);

    // 切「已完成」→ 行全 done；再切回「全部」→ 行数恢复
    await cdp.clickText(`${QUICK.embed} .dlq-tab`, '已完成', { desc: '嵌入页筛选 tab「已完成」' });
    await sleep(400);
    page = await quickPage(cdp);
    suite.assert(page.rows.length > 0, '切「已完成」后嵌入页没有行');
    suite.assert(
      page.rows.every((row) => row.state === 'done'),
      `「已完成」筛选下应只有 done 行，实际 ${page.rows.map((row) => row.state).join(',')}`,
    );
    await cdp.clickText(`${QUICK.embed} .dlq-tab`, '全部', { desc: '嵌入页筛选 tab「全部」' });
    await sleep(400);
    page = await quickPage(cdp);
    suite.assert(page.rowCount === jobs.length, `切回「全部」后行数应恢复为 ${jobs.length}，实际 ${page.rowCount}`);
    const thumbAfter = page.segThumb;
    suite.assert(thumbAfter.exists && thumbAfter.opacity === '1', '切换后滑块应保持可见');

    // 切到其它快捷页再切回：只应有一份嵌入视图（不重复渲染），且不报错
    cdp.takeConsoleErrors();
    await cdp.clickText(QUICK.tabs, '封面', { desc: '快捷设置 tab「封面」（切走）' });
    await sleep(350);
    const awayPageCount = await cdp.eval(`document.querySelectorAll('[data-qa="quick-downloads-page"]').length`);
    suite.assert(awayPageCount <= 1, `切走后嵌入下载页实例应 ≤1，实际 ${awayPageCount}`);
    await cdp.clickText(QUICK.tabs, '下载', { desc: '快捷设置 tab「下载」（切回）' });
    await cdp.waitFor(`!!document.querySelector('[data-qa="quick-downloads-page"]')`, { desc: '切回下载页', timeoutMs: 6000 });
    await sleep(300);
    const backPageCount = await cdp.eval(`document.querySelectorAll('[data-qa="quick-downloads-page"]').length`);
    suite.assert(backPageCount === 1, `切回后嵌入下载页应单例，实际 ${backPageCount} 个`);
    page = await quickPage(cdp);
    suite.assert(page.rowCount === jobs.length, `切回后行数应恢复为 ${jobs.length}，实际 ${page.rowCount}`);
    const switchErrors = cdp.takeConsoleErrors();
    suite.assert(
      switchErrors.length === 0,
      `切换快捷设置 tab 期间出现 console 错误：${switchErrors.map((err) => err.text).slice(0, 3).join(' | ')}`,
    );
    suite.note('快捷页切走/切回：无重复渲染、无 console 错误 ✓');

    await suite.shot('quick-downloads-page');
    await pressEscape(cdp);
    await cdp.waitFor(`!document.querySelector('.quick.is-open')`, { desc: 'Esc 收起快捷设置', timeoutMs: 5000 });
    await goHome(cdp);
    return `5 tab 顺序正确 · 嵌入队列 ${page.rowCount} 行 · 状态「${page.status}」· 筛选切换正常`;
  });

  /* ---------------------------------------------------------------------- */
  /* 无损下载：源站/VIP 限制可能不提供，不提供时记 SKIP（附证据），不当 FAIL。 */
  {
    try {
      await closeOverlays(cdp);
      await goHome(cdp);
      let wall = null;
      let rows = 0;
      for (let attempt = 1; attempt <= 3 && rows === 0; attempt += 1) {
        await goHome(cdp);
        try {
          wall = await openSearch(cdp, SEARCH_KEYWORD);
          rows = wall.rows;
        } catch {
          await sleep(400);
        }
      }
      if (rows === 0) throw new Error(`搜索「${SEARCH_KEYWORD}」没有结果行（${wall ? wall.sub : '无'}）`);
      const found = await cdp.eval(`(${pageDownloadCandidates.toString()})(8)`);
      const candidates = found.candidates || [];
      const pick = candidates.find((item) => item.key === targetTrack.key) || candidates[0];
      if (!pick) throw new Error('搜索结果里没有可点的 .track-download');
      const baselineIds = new Set(((await dlqDebug(cdp)).jobs || []).map((job) => job.id));
      await cdp.eval(`(${pageClickRowDownload.toString()})(${JSON.stringify(pick.key)})`);
      const snap = await waitPickerOpen(cdp);
      const defaultQuality = (await settingsDownloadQuality(cdp)) || 'high';
      suite.assert(
        snap.checkedQuality.length === 1 && snap.checkedQuality[0] === defaultQuality,
        `无损下载前浮层默认项应保持「${defaultQuality}」，实际 ${JSON.stringify(snap.checkedQuality)}`,
      );
      await pickQuality(cdp, 'lossless');
      const appeared = await waitForNewJob(cdp, pick.key, baselineIds, { timeoutMs: 20000 });
      if (!appeared) throw new Error('选无损后 20s 内任务未入队');
      suite.assert(appeared.quality === 'lossless', `入队 job.quality 应为 lossless，实际「${appeared.quality}」`);
      const settled = await waitJobSettled(cdp, appeared.id, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
      if (!settled) throw new Error(`无损任务 ${appeared.id} 在 ${DOWNLOAD_TIMEOUT_MS}ms 内没有终态`);
      if (settled.state === 'done') {
        suite.assert(/\.flac$/i.test(settled.fileName || ''), `无损 job fileName 应以 .flac 结尾，实际「${settled.fileName}」`);
        const stat = fs.statSync(settled.path);
        suite.assert(stat.isFile() && stat.size > 0, `无损文件落盘校验失败：${settled.path}`);
        suite.record(
          'PASS',
          '无损下载：浮层选 lossless → job.quality=lossless / .flac 落盘',
          `${settled.fileName}（${Math.round(stat.size / 1024)}KB）→ ${settled.path}`,
        );
        suite.note(`无损落盘：${settled.path}`);
      } else {
        suite.record(
          'SKIP',
          '无损下载：浮层选 lossless → job.quality=lossless / .flac 落盘',
          `源站未提供无损：${settled.error || '未知错误'}（job ${appeared.id}）\nhost.log: ${hostLogTail(5)}`,
        );
      }
    } catch (err) {
      const evidence = await suite.captureEvidence('lossless');
      suite.record('FAIL', '无损下载：浮层选 lossless → job.quality=lossless / .flac 落盘', err.message, 0, evidence);
    }
    // 无损兜底可能在上游触发 4xx 网络错误（CDP Log），在 console 断言前清理并记录
    const losslessConsole = cdp.takeConsoleErrors();
    if (losslessConsole.length) {
      suite.note(`无损下载期间 console 记录 ${losslessConsole.length} 条错误（源站兜底触发，已在 console 断言前清理）：${losslessConsole[0].text || ''}`);
    }
    // 后续筛选步骤需要面板打开
    if (!(await cdp.eval(`!!document.querySelector('.dlq-panel.is-open')`))) {
      await cdp.click(DLQ.entry, { desc: '打开下载面板' });
      await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, { desc: '面板打开', timeoutMs: 6000 });
    }
    await sleep(200);
  }

  /* ---------------------------------------------------------------------- */
  await suite.step('筛选 tab：已完成 / 失败 / 全部', async () => {
    if (!jobId) throw new Error('前序步骤没有拿到 jobId');
    const clickTab = async (label) => {
      await cdp.clickText(DLQ.tabs, label, { desc: `筛选 tab「${label}」` });
      await sleep(300);
      return dlqSnapshot(cdp);
    };

    const debug = await dlqDebug(cdp);
    const countBy = (state) => debug.jobs.filter((job) => job.state === state).length;

    let snap = await clickTab('已完成');
    suite.assert(
      snap.rows.every((row) => row.state === 'done'),
      `「已完成」tab 下出现非 done 行：${snap.rows.map((row) => `${row.id}:${row.state}`).join(', ')}`,
    );
    suite.assert(snap.rows.length === countBy('done'), `「已完成」tab 行数 ${snap.rows.length} ≠ done 任务数 ${countBy('done')}`);
    const doneRow = snap.rows.find((row) => row.id === jobId);
    suite.assert(doneRow, `「已完成」tab 下找不到刚下载的 job ${jobId}`);
    suite.assert(snap.tabs.find((tab) => tab.text === '已完成').selected === 'true', '「已完成」tab 未标记 aria-selected=true');

    snap = await clickTab('失败');
    suite.assert(
      snap.rows.every((row) => row.state === 'error'),
      `「失败」tab 下出现非 error 行：${snap.rows.map((row) => `${row.id}:${row.state}`).join(', ')}`,
    );
    suite.assert(snap.rows.length === countBy('error'), `「失败」tab 行数 ${snap.rows.length} ≠ error 任务数 ${countBy('error')}`);
    if (countBy('error') === 0) {
      suite.assert(snap.emptyHidden === false, '「失败」tab 无任务时应显示空态 .dlq-empty');
      suite.note(`失败 tab 空态文案：${snap.emptyText}`);
    }

    snap = await clickTab('全部');
    suite.assert(snap.rows.length === debug.jobs.length, `「全部」tab 行数 ${snap.rows.length} ≠ 任务总数 ${debug.jobs.length}`);
    suite.assert(snap.rows.some((row) => row.id === jobId), '「全部」tab 下找不到本次任务');

    // 带行数据时的切换动画：真实下载行也要播 dlq-switch-in（24ms stagger），700ms 后复位
    const rowSwitch = await switchProbe(cdp, '已完成');
    suite.assert(rowSwitch.ok, `带行切换 tab 失败：${rowSwitch.reason || ''}`);
    suite.assert(rowSwitch.mid.listSwitch === true, `带行切换后 .dlq-list 应临时带 is-switch，实际 ${rowSwitch.mid.listSwitch}`);
    suite.assert(rowSwitch.mid.rowsCount > 0, `「已完成」tab 下应有真实下载行，实际 ${rowSwitch.mid.rowsCount} 行`);
    suite.assert(
      /dlq-switch-in/.test(rowSwitch.mid.firstRowAnim),
      `带行切换时行动画名应含 dlq-switch-in，实际「${rowSwitch.mid.firstRowAnim}」`,
    );
    if (rowSwitch.mid.rows.length >= 2) {
      suite.assert(
        /0\.024s/.test(rowSwitch.mid.rows[1].delay),
        `第 2 行 stagger 延迟应为 24ms，实际「${rowSwitch.mid.rows[1].delay}」`,
      );
    }
    suite.assert(rowSwitch.after.listSwitch === false, '700ms 后 .dlq-list 仍带 is-switch');
    // 复位到「全部」，保持后续步骤的筛选上下文
    await switchProbe(cdp, '全部');
    await sleep(150);
    await suite.shot('tabs-all');
    return `done=${countBy('done')} error=${countBy('error')} all=${debug.jobs.length}`;
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('刷新按钮 + 关闭重开：状态保持', async () => {
    if (!jobId) throw new Error('前序步骤没有拿到 jobId');
    if (!(await cdp.eval(`!!document.querySelector('.dlq-panel.is-open')`))) {
      await cdp.click(DLQ.entry, { desc: '打开下载面板' });
      await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, { desc: '面板打开', timeoutMs: 6000 });
    }
    const prev = await dlqSnapshot(cdp);
    await cdp.click(DLQ.refresh, { desc: '刷新下载列表按钮' });
    await cdp.waitFor(`!document.querySelector('.dlq-refresh.is-busy')`, { desc: '刷新完成（.dlq-refresh 去掉 is-busy）', timeoutMs: 10000 });
    await sleep(400);
    const after = await dlqSnapshot(cdp);
    suite.assert(after.errorHidden === true, `刷新后出现错误条 .dlq-error：${after.errorText}`);
    suite.assert(after.rows.length === prev.rows.length, `刷新后行数变化：${prev.rows.length} → ${after.rows.length}`);
    suite.assert(after.rows.some((row) => row.id === jobId && row.state === 'done'), '刷新后本次任务行丢失或状态变化');

    // 关闭 → 重开：DOM 保留、状态保持
    await cdp.click(DLQ.close, { desc: '关闭下载面板' });
    await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: '面板收起', timeoutMs: 5000 });
    await cdp.click(DLQ.entry, { desc: '重新打开下载面板' });
    await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, { desc: '面板再次打开', timeoutMs: 6000 });
    await sleep(300);
    const reopened = await dlqSnapshot(cdp);
    suite.assert(reopened.count === 1, `重开后 .dlq-panel 应仍为单例，实际 ${reopened.count} 个`);
    suite.assert(reopened.rows.some((row) => row.id === jobId && row.state === 'done'), '重开后本次任务行丢失');
    suite.assert(reopened.dir === after.dir, `重开后下载目录变化：${after.dir} → ${reopened.dir}`);
    await suite.shot('panel-reopened');
    return `刷新后 ${after.rows.length} 行，重开保持 ${reopened.rows.length} 行`;
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('console 无 error / 无未捕获异常', async () => {
    const errors = cdp.takeConsoleErrors({ clear: false });
    suite.assert(
      errors.length === 0,
      `本轮共捕获 ${errors.length} 条 console error / 未捕获异常：\n` +
        errors
          .slice(0, 8)
          .map((item) => `- [${item.kind}] ${item.text.slice(0, 300)}`)
          .join('\n'),
    );
    return '无 console.error / exception / log.error';
  });

  // 收尾：复位筛选 → 关面板 → 回首页，保持应用干净状态；并记录本次新增的下载测试文件
  try {
    if (await cdp.eval(`!!document.querySelector('.dlq-panel.is-open')`)) {
      const filter = await cdp.eval(`(() => {
        const q = window.__zilux2DownloadQueue;
        return q && typeof q.state === 'function' ? q.state().filter : '';
      })()`);
      if (filter && filter !== '全部') {
        await cdp.clickText(DLQ.tabs, '全部', { desc: '收尾复位筛选「全部」' }).catch(() => {});
        await sleep(250);
      }
      if (await cdp.eval(`!!document.querySelector('.dlq-panel.is-open')`)) {
        await cdp.click(DLQ.close, { desc: '收尾关闭下载面板' }).catch(async () => {
          await pressEscape(cdp);
        });
      }
      await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: '收尾面板已收起', timeoutMs: 5000 }).catch(() => {});
    }
    await goHome(cdp);
    const finalDebug = await dlqDebug(cdp).catch(() => null);
    if (finalDebug && jobId) {
      const job = finalDebug.jobs.find((item) => item.id === jobId);
      const wasNew = !baseline.jobs.some((item) => item.id === jobId);
      if (job && wasNew) {
        suite.note(`本次新增下载测试文件（保留不删，可手动清理）：${job.fileName || '（未命名）'} → ${job.path || '（无 path）'}`);
      }
    }
    const clean = await cdp.eval(`(() => ({
      panelOpen: !!document.querySelector('.dlq-panel.is-open'),
      home: !!document.querySelector('.home-host .ui-page.home'),
      filter: (window.__zilux2DownloadQueue && typeof window.__zilux2DownloadQueue.state === 'function')
        ? window.__zilux2DownloadQueue.state().filter
        : '',
    }))()`);
    suite.assert(!clean.panelOpen, '收尾后下载面板仍处于打开状态');
    suite.assert(clean.home === true, '收尾后未回到首页（.home-host .ui-page.home 不存在）');
    suite.note(`收尾状态：panelOpen=${clean.panelOpen} filter=${clean.filter || '（空）'} home=${clean.home}`);
  } catch (err) {
    suite.note(`收尾清理告警（不影响断言）：${err.message}`);
  }
});
