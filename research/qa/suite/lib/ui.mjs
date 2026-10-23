/**
 * Zilux2 QA 套件 —— 公共 UI 导航/查询小工具。
 *
 * 所有交互都走页面内 JS，不产生真实鼠标事件；选择器来自 web/src 的真实实现。
 * 这里只放「多套件复用」的原子动作，业务断言留在各套件里。
 */
import { sleep } from './cdp.mjs';

export const RAIL = {
  home: '首页',
  liked: '我喜欢的音乐',
  recent: '最近播放',
  recommend: '推荐',
  discover: '发现',
  playlists: '我的歌单',
  local: '本地曲库',
  airplay: '投送',
  settings: '设置',
};

export const SEL = {
  rail: (title) => `.rail-btn[title^="${title}"]`,
  homeHost: '.home-host',
  wall: '.wall',
  wallTitle: '.wall-title',
  wallSub: '.wall-sub',
  searchDock: '.search-dock',
  searchInput: '.search-dock input',
  quick: '.quick',
  quickTrigger: '.pb-quick',
  lyricsView: '.lyrics-view',
  sheet: '.sheet',
  settingsLayout: '.settings-layout',
  trackRow: '.wall .track-row',
};

export function railSel(title) {
  // 「本地曲库」按钮的 title 会随曲库载入变成「本地曲库 · 13 首」，所以统一用前缀匹配。
  return `.rail-btn[title^="${title}"]`;
}

export async function clickRail(cdp, title, { settleMs = 250, timeoutMs = 8000 } = {}) {
  const info = await cdp.click(railSel(title), { desc: `侧栏「${title}」`, timeoutMs });
  await sleep(settleMs);
  return info;
}

/** 回到首页（同时避免停在会弹原生文件夹选择器的本地页）。 */
export async function goHome(cdp) {
  await clickRail(cdp, RAIL.home);
  await cdp.waitFor(`!!document.querySelector('.home-host:not(.is-hidden) .ui-page.home')`, {
    desc: '首页 .home-host .ui-page.home 显示',
    timeoutMs: 12000,
  });
}

/** wall（右侧墙面）当前状态。 */
export async function wallState(cdp) {
  return cdp.eval(`(() => {
    const wall = document.querySelector('.wall');
    const title = document.querySelector('.wall-title');
    const sub = document.querySelector('.wall-sub');
    return {
      hidden: !wall || wall.classList.contains('is-hidden'),
      title: (title && title.textContent ? title.textContent : '').trim(),
      sub: (sub && sub.textContent ? sub.textContent : '').trim(),
      rows: document.querySelectorAll('.wall .track-row').length,
      posters: document.querySelectorAll('.wall .poster, .wall .album-card, .wall .disc').length,
    };
  })()`);
}

/**
 * 打开搜索并提交关键词，等到结果墙完成：
 * title = 搜索「kw」、副标题含「首」、不含「加载中」/「搜索中」、且 `.wall .track-row` 行数 > 0。
 * 返回 { title, sub, rows, elapsedMs }。
 *
 * 这是**真实竞态路径**的回归用例（task-8）：input 事件后同一轮 JS 立即（<50ms）派发 Enter。
 * 2026-10 曾因此让「边打边搜」preview 的 220ms 防抖在 commitSearch 之后 ++searchSeq，
 * 把提交的流式 onUpdate / 最终墙面赋值全部作废 → 墙面永久卡在「已找到 N 首 · 加载中…」。
 * 产品修复（commitSearch 开头 clearTimeout(searchTimer)）后应在 12s 内完成；
 * 若这里超时/仍含「加载中」→ 竞态回归，直接当产品 bug 报 Lead（附截图 + host.log）。
 */
export async function openSearch(cdp, keyword, { timeoutMs = 12000, settleMs = 150 } = {}) {
  if (!(await cdp.eval(`document.querySelector('.search-dock') && document.querySelector('.search-dock').dataset.open === 'true'`))) {
    await cdp.click(SEL.searchDock, { desc: '搜索框 .search-dock' });
  }
  await cdp.waitFor(`document.querySelector('.search-dock') && document.querySelector('.search-dock').dataset.open === 'true'`, {
    desc: '搜索面板展开（data-open=true）',
    timeoutMs: 8000,
  });
  const submittedAt = Date.now();
  // 关键：input 与 Enter 在同一个 eval 里连续派发，两次事件间隔 ≈0ms（<50ms），
  // 故意让「边打边搜」的 220ms 防抖定时器在产品 commitSearch 之后才到期，覆盖竞态。
  await cdp.eval(`(() => {
    const input = document.querySelector('.search-dock input');
    if (!input) return false;
    input.focus();
    input.value = ${JSON.stringify(keyword)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    return true;
  })()`);
  const wantTitle = `搜索「${keyword}」`;
  const state = await cdp.waitFor(
    `(() => {
      const t = (document.querySelector('.wall-title') && document.querySelector('.wall-title').textContent || '').trim();
      const s = (document.querySelector('.wall-sub') && document.querySelector('.wall-sub').textContent || '').trim();
      if (t !== ${JSON.stringify(wantTitle)}) return null;
      if (s.indexOf('加载中') !== -1 || s.indexOf('搜索中') !== -1) return null;
      if (s.indexOf('首') === -1) return null;
      const rows = document.querySelectorAll('.wall .track-row').length;
      if (rows === 0) return null;
      return { title: t, sub: s, rows };
    })()`,
    { desc: `搜索结果墙「${keyword}」（input 后立即 Enter，12s 内完成）`, timeoutMs, intervalMs: 150 },
  );
  const elapsedMs = Date.now() - submittedAt;
  await sleep(settleMs);
  return { ...state, elapsedMs };
}

/** 读取 localStorage（字符串，null 表示不存在）。 */
export async function readLocalStorage(cdp, key) {
  return cdp.eval(`localStorage.getItem(${JSON.stringify(key)})`);
}

/** 读取 JSON 形式的 localStorage。 */
export async function readLocalStorageJson(cdp, key) {
  const raw = await readLocalStorage(cdp, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { __parseError: raw.slice(0, 300) };
  }
}

/** 写/恢复 localStorage（value=null 时删除 key）。 */
export async function writeLocalStorage(cdp, key, value) {
  if (value == null) {
    await cdp.eval(`localStorage.removeItem(${JSON.stringify(key)})`);
  } else {
    await cdp.eval(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(String(value))})`);
  }
}

/** 派发一次 Escape。 */
export async function pressEscape(cdp) {
  await cdp.eval(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }))`,
  );
  await sleep(120);
}

/** 尽力关闭所有弹层（sheet / 快捷设置），不关心本来是否打开。 */
export async function closeOverlays(cdp) {
  await cdp
    .eval(`(() => {
      for (const sheet of Array.from(document.querySelectorAll('.sheet'))) {
        const btn = sheet.querySelector('.sheet-head .icon-btn, .icon-btn[title="关闭"]');
        if (btn) btn.click();
      }
      for (const login of Array.from(document.querySelectorAll('.login'))) {
        const btn = login.querySelector('.icon-btn[title="关闭"]');
        if (btn) btn.click();
      }
      if (document.querySelector('.quick.is-open')) {
        const trigger = document.querySelector('.pb-quick');
        if (trigger) trigger.click();
      }
      return true;
    })()`)
    .catch(() => {});
  await pressEscape(cdp);
  await sleep(350);
}

/** 等某个 localStorage key 变成期望值（字符串比较，可选 normalize）。 */
export async function waitLocalStorage(cdp, key, expected, { timeoutMs = 10000, normalize = (v) => v } = {}) {
  return cdp.waitFor(
    `(() => {
      const raw = localStorage.getItem(${JSON.stringify(key)});
      return raw === null ? null : raw;
    })()`,
    {
      desc: `localStorage ${key} 更新`,
      timeoutMs,
      intervalMs: 150,
      accept: (value) => value !== null && normalize(value) === normalize(expected),
    },
  );
}

/** 取界面上的 toast 文本（没有则空串）。 */
export async function toastText(cdp) {
  return cdp.eval(`(() => {
    const nodes = Array.from(document.querySelectorAll('.toast'));
    return nodes.map((n) => (n.textContent || '').trim()).filter(Boolean).join(' | ');
  })()`);
}

/** 设置页：点击左侧分区（通用/外观/播放/均衡器/下载/更新/账号/数据…）。 */
export async function openSettingsPane(cdp, paneLabel) {
  await clickRail(cdp, RAIL.settings, { settleMs: 400 });
  await cdp.waitFor(`!!document.querySelector('.settings-layout')`, { desc: '设置页两栏布局 .settings-layout', timeoutMs: 12000 });
  await cdp.clickText('.settings-nav-btn', paneLabel, { desc: `设置分区「${paneLabel}」`, timeoutMs: 8000 });
  await sleep(300);
}

/** 设置页当前内容区标题列表。 */
export async function settingsSectionTitles(cdp) {
  return cdp.eval(
    `Array.from(document.querySelectorAll('.settings-content .section-title')).map((n) => (n.textContent || '').trim())`,
  );
}

/** 打开歌词页（.pb-cover 的 click 监听会调 openLyrics；不用 pointerdown 的「词」按钮）。 */
export async function openLyricsView(cdp) {
  await cdp.click('.pb-cover', { desc: '播放条封面 .pb-cover（打开歌词页）' });
  await cdp.waitFor(
    `!!document.querySelector('.lyrics-view') && document.querySelector('.app') && document.querySelector('.app').classList.contains('is-lyrics-open')`,
    { desc: '歌词页 .lyrics-view 打开（.app.is-lyrics-open）', timeoutMs: 10000 },
  );
}

/** 关闭歌词页（再点一次封面，click 监听是「开/关」切换）。 */
export async function closeLyricsView(cdp) {
  if (!(await cdp.eval(`!!document.querySelector('.lyrics-view')`))) return;
  await cdp.eval(
    `(() => { const btn = document.querySelector('.lyrics-view .lyrics-close'); if (btn) { btn.click(); return true; } const cover = document.querySelector('.pb-cover'); if (cover) cover.click(); return false; })()`,
  );
  await cdp.waitFor(`!document.querySelector('.lyrics-view')`, { desc: '歌词页卸载（.lyrics-view 移出 DOM）', timeoutMs: 5000, intervalMs: 100 }).catch(() => {});
  await sleep(200);
}

/** 打开快捷设置的某个 tab（封面/歌词/设置/投送）。 */
export async function openQuickTab(cdp, label) {
  if (!(await cdp.eval(`!!document.querySelector('.quick.is-open')`))) {
    await cdp.click(SEL.quickTrigger, { desc: '播放条快捷设置按钮 .pb-quick' });
  }
  await cdp.waitFor(`!!document.querySelector('.quick.is-open')`, { desc: '快捷设置面板展开 .quick.is-open', timeoutMs: 8000 });
  await cdp.clickText('.quick-tab', label, { desc: `快捷设置标签「${label}」` });
  await sleep(350);
}
