/**
 * Zilux2 真机 QA —— 下载队列（T2）
 *
 * 覆盖本轮新增的下载队列面板：
 *   1. 入口按钮 [data-qa="download-entry"] 与面板开合（.dlq-panel.is-open / aria-hidden）；
 *   2. rail 常驻入口 .rail .rail-btn[aria-label="下载队列"]：存在、点开、再点收起（toggle），
 *      零任务时也能打开（空态 .dlq-empty 可见），点外部 / Esc 均可关闭；
 *   3. 分段控件：.dlq-tabs 带全局 seg 类、tab 带 seg-btn、激活态 is-active + is-on 双类、
 *      .dlq-tabs > .seg-thumb 白色滑块存在且首开已定位（width>0 / opacity=1 / 对齐激活 tab）；
 *   4. tab 切换动画：切换后 30ms 内 .dlq-list/.dlq-empty 临时带 is-switch，空态 animationName
 *      含 dlq-switch-in（有行时行动画含 dlq-switch-in + 24ms stagger），700ms 后临时类移除、
 *      滑块 left 位移；
 *   5. 面板结构：标题、摘要计数、筛选 tab、目录行、空态、行内 .dlq-bar>.dlq-fill；
 *   6. 从搜索结果点 .track-download 真实发起一次下载（走 app.beginDownload → beginQueueDownload）；
 *   7. 以 ~85ms 采样 running 行：data-state / .dlq-pct / .dlq-fill 宽度；
 *   8. done 行 UI（100%、已保存、.dlq-reveal 可见、.dlq-retry 隐藏、.dlq-actions 可见）；
 *   9. 落盘校验：宿主任务 path 在磁盘上存在且非空；
 *  10. 筛选 tab（已完成/失败/全部，含带行切换动画）与刷新、关闭重开；
 *  11. 全程 console 无 error；收尾关面板 + 回首页。
 *
 * 说明：
 *   - 数据真值优先取页面调试入口 window.__zilux2DownloadQueue.state()（产品自带），
 *     DOM 断言只依赖可见选择器；两者都写进失败证据。
 *   - 下载写的是真实下载目录（宿主默认 %USERPROFILE%\Music），测试会留下一个音频文件；
 *     QA 侧不删用户目录文件，README 里有清理说明。
 *   - 本套件不点「在文件夹中显示」（会弹出资源管理器）；需要时设 ZILUX2_QA_CLICK_REVEAL=1。
 */
import fs from 'node:fs';

import { runSuite, sleep, repoRel, hostLogTail } from './lib/cdp.mjs';
import { goHome, openSearch, closeOverlays, pressEscape } from './lib/ui.mjs';
import {
  DLQ,
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

/** rail 常驻「下载队列」入口 + 面板开合快照。 */
function pageRailEntry() {
  const text = (node) => (node && node.textContent ? node.textContent.trim() : '');
  const rail = document.querySelector('.rail');
  const btn = document.querySelector('.rail .rail-btn[aria-label="下载队列"]');
  const panel = document.querySelector('.dlq-panel');
  const entry = document.querySelector('[data-qa="download-entry"]');
  const empty = document.querySelector('.dlq-panel .dlq-empty');
  const q = window.__zilux2DownloadQueue;
  const state = q && typeof q.state === 'function' ? q.state() : null;
  return {
    railBtnCount: rail ? rail.querySelectorAll('.rail-btn').length : 0,
    exists: !!btn,
    cls: btn ? String(btn.className || '') : '',
    title: btn ? btn.title || '' : '',
    ariaLabel: btn ? btn.getAttribute('aria-label') : null,
    label: btn ? text(btn.querySelector('.rail-label')) : '',
    panelExists: !!panel,
    panelOpen: !!panel && panel.classList.contains('is-open'),
    ariaHidden: panel ? panel.getAttribute('aria-hidden') : null,
    entryExpanded: entry ? entry.getAttribute('aria-expanded') : null,
    jobs: state ? state.jobs.length : null,
    rows: document.querySelectorAll('.dlq-panel .dlq-row').length,
    emptyHidden: empty ? empty.hidden : null,
    emptyText: text(empty),
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

async function railEntry(cdp) {
  return cdp.eval(`(${pageRailEntry.toString()})()`);
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
  await suite.step('常驻入口：rail「下载队列」toggle / 无任务也能打开 / 点外与 Esc 关闭', async () => {
    // 上一结构步骤把面板留成打开态，先收起再验证 rail 入口从零打开。
    if (await cdp.eval(`!!document.querySelector('.dlq-panel.is-open')`)) {
      await cdp.click(DLQ.close, { desc: '收起下载面板' });
      await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: '面板收起', timeoutMs: 5000 });
    }
    await cdp.waitFor(`!!document.querySelector('.rail .rail-btn[aria-label="下载队列"]')`, {
      desc: 'rail 常驻「下载队列」入口',
      timeoutMs: 8000,
    });
    let snap = await railEntry(cdp);
    suite.assert(snap.exists, '缺少 rail 常驻入口 .rail .rail-btn[aria-label="下载队列"]');
    suite.assert(snap.cls.includes('rail-btn'), `rail 下载入口 class 应含 rail-btn，实际「${snap.cls}」`);
    suite.assert(snap.title === '下载队列', `rail 下载入口 title 应为「下载队列」，实际「${snap.title}」`);
    suite.assert(snap.ariaLabel === '下载队列', `rail 下载入口 aria-label 应为「下载队列」，实际「${snap.ariaLabel}」`);
    suite.assert(snap.label === '下载队列', `rail 下载入口文案应为「下载队列」，实际「${snap.label}」`);
    const emptySession = baseline.jobs.length === 0;

    // 1) rail 点击 → 打开
    await cdp.click(DLQ.railEntry, { desc: 'rail「下载队列」常驻入口' });
    await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, {
      desc: 'rail 入口打开下载面板（.dlq-panel.is-open）',
      timeoutMs: 6000,
    });
    await sleep(150);
    snap = await railEntry(cdp);
    suite.assert(snap.panelExists, '点击 rail 入口后 .dlq-panel 未创建');
    suite.assert(snap.panelOpen, '点击 rail 入口后面板未带 .is-open');
    suite.assert(snap.ariaHidden === 'false', `面板打开时 aria-hidden 应为 false，实际 ${snap.ariaHidden}`);
    suite.assert(snap.entryExpanded === 'true', `面板打开时播放条入口 aria-expanded 应为 true，实际 ${snap.entryExpanded}`);
    if (emptySession) {
      suite.assert(snap.jobs === 0, `基线无任务，但调试入口 jobs=${snap.jobs}`);
      suite.assert(snap.rows === 0, `无任务时面板不应有 .dlq-row，实际 ${snap.rows} 行`);
      suite.assert(snap.emptyHidden === false, `无任务时 .dlq-empty 应可见（hidden=false），实际 ${snap.emptyHidden}`);
      suite.assert(snap.emptyText.length > 0, '无任务时 .dlq-empty 文案为空');
      suite.note(`零任务会话验证通过：不下载也能打开面板，空态文案「${snap.emptyText}」`);
    } else {
      suite.note(`宿主会话已有 ${snap.jobs} 个任务，跳过「零任务空态」断言（冷启动时本步骤已覆盖）`);
    }
    await suite.shot('rail-entry-open');

    // 2) 再点 rail → 收起（toggle，验证 pointerdown 放行没把开关互相抵消）
    await cdp.click(DLQ.railEntry, { desc: '再次点击 rail「下载队列」入口' });
    await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: 'rail 再点收起面板', timeoutMs: 6000 });
    snap = await railEntry(cdp);
    suite.assert(!snap.panelOpen, 'rail 再点后面板仍打开（toggle 失效）');
    suite.assert(snap.ariaHidden === 'true', `收起后 aria-hidden 应为 true，实际 ${snap.ariaHidden}`);

    // 3) 点面板外 → 关闭
    await cdp.click(DLQ.railEntry, { desc: 'rail 入口重新打开面板' });
    await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, { desc: '面板再次打开', timeoutMs: 6000 });
    await cdp.eval(`(() => {
      const target = document.querySelector('.stage') || document.body;
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: '点击面板外收起', timeoutMs: 6000 });

    // 4) Esc → 关闭（main.ts 全局快捷键 → app.escapeTopLayer 关下载面板）
    await cdp.click(DLQ.railEntry, { desc: 'rail 入口再次打开面板（Esc 前）' });
    await cdp.waitFor(`!!document.querySelector('.dlq-panel.is-open')`, { desc: '面板打开（Esc 前）', timeoutMs: 6000 });
    await pressEscape(cdp);
    await cdp.waitFor(`!document.querySelector('.dlq-panel.is-open')`, { desc: 'Esc 收起下载面板', timeoutMs: 6000 });

    return `rail 入口存在（rail 共 ${snap.railBtnCount} 个按钮）· 点开/再点收/点外/Esc 均正常${emptySession ? ' · 零任务空态可打开' : ''}`;
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('分段控件：.seg 类名 / is-on / .seg-thumb 滑块定位', async () => {
    if (!(await cdp.eval(`!!document.querySelector('.dlq-panel.is-open')`))) {
      await cdp.click(DLQ.railEntry, { desc: 'rail 入口打开下载面板' });
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
      await cdp.click(DLQ.railEntry, { desc: 'rail 入口打开下载面板' });
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
  await suite.step('发起下载：搜索 → 点 .track-download → 任务进入队列', async () => {
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
    suite.note(`目标曲目：${targetTrack.title} / ${targetTrack.artist}（key=${targetTrack.key}）→ job ${jobId} 已 done（重试 ${attempts.length - 1} 次）`);

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
