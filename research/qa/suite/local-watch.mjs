/**
 * Zilux2 真机 QA —— 本地目录监控（T3）
 *
 * 覆盖本轮新增的「本地曲库目录实时监控」：
 *   1. 把测试目录 restore 给宿主（走页面 bridge 消息，不弹原生文件夹选择器）；
 *   2. 宿主映射成功（host.log `[local] mapped <dir> (N tracks, M lyrics)`）后本地页出现曲目；
 *   3. 往目录里放一个 mp3 → 本地页「本地 · N 首」在 ≤8s 内自动 +1（不点任何刷新/重进页面）；
 *   4. 从目录里删掉这个 mp3 → 本地页计数在 ≤8s 内自动回到基线（不重进页面）；
 *   5. 宿主 host.log 出现 watcher 处理行（`[local] watch incremental: +1 -0 ...` 等），作为根因证据；
 *   6. 收尾：让宿主重新映射回原目录 / 夹具目录，还原 zilux2.localFolder，删除测试目录。
 *
 * 注意：
 *   - 本地页的「N 首」是「本地文件夹 + 下载目录」合并值（宿主 PostMergedTracks），
 *     所以断言用 before/after 差值，不写死绝对数字。
 *   - 不在本套件里点「本地曲库」的空白态/选择文件夹，否则会弹原生 FolderBrowserDialog；
 *     测试目录通过 bridge 消息 restore 注入。
 *   - 测试目录默认 research/qa/suite/tmp-local-watch（可用 ZILUX2_WATCH_DIR 覆盖），
 *     名称不以 "." 开头（宿主会跳过隐藏目录）。
 *
 * 运行：node research/qa/suite/local-watch.mjs
 * 截图：research/shots/suite-YYYYMMDD/local-watch-*.png
 */
import fs from 'node:fs';
import path from 'node:path';

import { runSuite, sleep, REPO_ROOT, hostLogSize, hostLogSince, repoRel } from './lib/cdp.mjs';
import { RAIL, clickRail, closeOverlays, goHome, readLocalStorage, writeLocalStorage } from './lib/ui.mjs';
import {
  LOCAL_FIXTURE_DIR,
  LOCAL_WATCH_TIMEOUT_MS,
  LOCAL_FOLDER_KEY,
  fixtureMp3Files,
  dirExists,
} from './lib/fixtures.mjs';

/* -------------------------------------------------------------------------- */
/* 常量与页面内函数                                                             */
/* -------------------------------------------------------------------------- */

/** 测试目录：明确放在 suite 下，收尾时整个删除。 */
const WATCH_DIR =
  process.env.ZILUX2_WATCH_DIR || path.join(REPO_ROOT, 'research', 'qa', 'suite', 'tmp-local-watch');

/** 宿主 / 页面消息里的路径用正斜杠（bridge restore 的实测写法）。 */
function toUrlPath(p) {
  return String(p).replace(/\\/g, '/');
}

/** 页面内读取「本地曲库」墙状态（不依赖任何模块变量，可 toString 注入）。 */
function pageLocalState() {
  const wall = document.querySelector('.wall');
  const titleNode = document.querySelector('.wall-title');
  const subNode = document.querySelector('.wall-sub');
  const title = titleNode ? (titleNode.textContent || '').trim() : '';
  const sub = subNode ? (subNode.textContent || '').trim() : '';
  const match = /本地\s*·\s*(\d+)\s*首/.exec(sub);
  const rows = Array.from(document.querySelectorAll('.wall .track-row'));
  const cards = Array.from(
    document.querySelectorAll(
      '.wall .wall-card, .wall .poster, .wall .local-card, .wall .artist-card, .wall .grid-card',
    ),
  );
  const rowTitles = rows
    .map((row) => {
      const node = row.querySelector('.track-title');
      return node ? (node.textContent || '').trim() : (row.textContent || '').trim().slice(0, 40);
    })
    .slice(0, 8);
  const emptyNode = document.querySelector('.wall-empty');
  const emptyText = emptyNode ? (emptyNode.textContent || '').trim().slice(0, 80) : '';
  const activeRailNode = document.querySelector('.rail-btn.is-active');
  return {
    wallClass: wall ? wall.className : '',
    hidden: !!wall && wall.classList.contains('is-hidden'),
    title,
    sub,
    count: match ? Number(match[1]) : null,
    loading: /正在载入|已打开文件夹选择器|选择文件夹/.test(sub),
    emptyText,
    localEmpty: /选择本地歌曲文件夹|还没有本地歌曲/.test(emptyText + sub),
    rows: rows.length,
    cards: cards.length,
    rowTitles,
    activeRail: activeRailNode ? activeRailNode.getAttribute('title') || '' : '',
  };
}

async function readLocalState(cdp) {
  return cdp.eval(`(${pageLocalState.toString()})()`);
}

/** 打开「本地曲库」页面并等到出现「本地 · N 首」（此时不允许正在载入空态）。 */
async function openLocalPage(cdp) {
  await clickRail(cdp, RAIL.local);
  await cdp.waitFor(`(${pageLocalState.toString()})()`, {
    timeoutMs: 15000,
    intervalMs: 150,
    desc: '本地曲库页出现「本地 · N 首」',
    accept: (state) => !!state && state.count !== null && !state.loading,
  });
  return readLocalState(cdp);
}

/** 等「本地 · N 首」里的 N 变成期望值，返回耗时和最终状态。 */
async function waitLocalCount(cdp, expected, { timeoutMs, desc }) {
  const started = Date.now();
  const state = await cdp.waitFor(`(${pageLocalState.toString()})()`, {
    timeoutMs,
    intervalMs: 120,
    desc: `${desc}（等待 N=${expected}）`,
    accept: (s) => !!s && s.count === expected && !s.loading,
  });
  return { state, elapsedMs: Date.now() - started };
}

/** 从 host.log 新增片段里挑 watcher 处理行（作为「确实是 watcher 触发的」证据）。 */
function extractWatchLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => /\[local\] watch/.test(line))
    .filter((line) => /incremental:|rescan applied:|watch rescan:|batch too large|needs rescan/.test(line));
}

async function waitWatchLog(offset, { timeoutMs = 5000, desc = '宿主 watcher 日志' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const { text } = hostLogSince(offset);
    last = text;
    const lines = extractWatchLines(text);
    if (lines.length > 0) return lines;
    await sleep(120);
  }
  throw new Error(`${desc} 未出现（${timeoutMs}ms）。新增 host.log 尾部：\n${last.slice(-1200)}`);
}

/* -------------------------------------------------------------------------- */
/* 套件                                                                        */
/* -------------------------------------------------------------------------- */

await runSuite('local-watch', '本地目录监控（T3）', async (suite) => {
  const cdp = suite.cdp;

  let fixtureCopyCount = 0;
  let watchDirReady = false;
  let origFolder = null;
  let baseCount = null;
  let addedPath = null;

  await suite.step('准备：检查夹具 + 建立测试目录', async () => {
    await closeOverlays(cdp);
    await goHome(cdp);

    suite.assert(dirExists(LOCAL_FIXTURE_DIR), `本地曲库夹具目录不存在：${LOCAL_FIXTURE_DIR}`);
    const mp3s = fixtureMp3Files();
    suite.assert(mp3s.length >= 1, `夹具目录里没有 mp3 文件：${LOCAL_FIXTURE_DIR}`);

    origFolder = await readLocalStorage(cdp, LOCAL_FOLDER_KEY);

    fs.rmSync(WATCH_DIR, { recursive: true, force: true });
    fs.mkdirSync(WATCH_DIR, { recursive: true });
    const copies = [];
    for (const src of mp3s.slice(0, 2)) {
      const dest = path.join(WATCH_DIR, path.basename(src));
      fs.copyFileSync(src, dest);
      copies.push(dest);
    }
    fixtureCopyCount = copies.length;
    watchDirReady = true;

    const onDisk = fs.readdirSync(WATCH_DIR).filter((name) => /\.mp3$/i.test(name));
    suite.assert(onDisk.length === fixtureCopyCount, `测试目录 mp3 数 ${onDisk.length} ≠ 期望 ${fixtureCopyCount}`);
    suite.note(`测试目录：${WATCH_DIR}（${onDisk.join(' / ')}）`);
    suite.note(`原 localStorage.${LOCAL_FOLDER_KEY} = ${origFolder === null ? '(不存在)' : origFolder}`);
    return `${fixtureCopyCount} 个 mp3 → ${repoRel(WATCH_DIR)}`;
  });

  await suite.step('恢复测试目录：宿主映射 + 本地页出现曲目', async () => {
    if (!watchDirReady) throw new Error('前序步骤没有建立测试目录');

    const logOffset = hostLogSize();
    const posted = await cdp.hostPost({ v: 1, type: 'local', action: 'restore', folder: toUrlPath(WATCH_DIR) });
    suite.assert(posted, '宿主 bridge 不可用（window.chrome.webview.postMessage 缺失）');

    // 等宿主完成扫描：host.log 出现 `[local] mapped <dir> (N tracks, M lyrics)`
    let mappedMatch = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !mappedMatch) {
      const { text } = hostLogSince(logOffset);
      mappedMatch = /\[local\] mapped ([^\n]*?) \((\d+) tracks?, (\d+) lyrics?\)/.exec(text);
      if (!mappedMatch) await sleep(150);
    }
    suite.assert(
      mappedMatch,
      `宿主 20s 内没有打印 [local] mapped（restore 未生效）。host.log 尾部：\n${hostLogSince(logOffset).text.slice(-1200)}`,
    );
    const folderTracks = Number(mappedMatch[2]);
    suite.note(`宿主映射：${mappedMatch[1]}（${folderTracks} tracks / ${mappedMatch[3]} lyrics）`);
    suite.assert(
      folderTracks === fixtureCopyCount,
      `宿主扫描到 ${folderTracks} 首，期望 ${fixtureCopyCount} 首（目录 ${WATCH_DIR}）`,
    );

    // 让页面先收到 localLibrary 事件，再切到本地页，避免空白态触发的原生选择器
    await sleep(350);
    const state = await openLocalPage(cdp);
    suite.assert(state.count !== null, `本地页没有「本地 · N 首」计数：title=「${state.title}」 sub=「${state.sub}」`);
    suite.assert(!state.localEmpty, `本地页是空态（「${state.emptyText}」），宿主映射没生效`);
    baseCount = state.count;
    suite.note(
      `本地页：title=「${state.title}」 sub=「${state.sub}」（rows=${state.rows}, cards=${state.cards}, 合并值包含下载目录）`,
    );
    await suite.shot('local-baseline');
    return state.sub;
  });

  await suite.step('新增文件：页面 ≤8s 自动 +1（不刷新、不重进页面）', async () => {
    suite.assert(baseCount !== null, '前序步骤没有拿到本地页基线计数');
    const srcMp3 = fixtureMp3Files()[0];
    suite.assert(srcMp3, '夹具目录没有 mp3，无法新增');

    addedPath = path.join(WATCH_DIR, `qa-watch-added-${Date.now()}.mp3`);
    const logOffset = hostLogSize();
    fs.copyFileSync(srcMp3, addedPath);
    suite.note(`已放入文件：${addedPath}`);

    let result;
    try {
      result = await waitLocalCount(cdp, baseCount + 1, {
        timeoutMs: LOCAL_WATCH_TIMEOUT_MS,
        desc: '新增 mp3 后本地页自动 +1',
      });
    } catch (err) {
      await suite.shot('watch-add-timeout');
      const state = await readLocalState(cdp).catch(() => null);
      throw new Error(
        `${err.message}；当前页面：${JSON.stringify(state)}；磁盘：${fs.readdirSync(WATCH_DIR).join(', ')}`,
      );
    }

    suite.assert(
      result.elapsedMs <= LOCAL_WATCH_TIMEOUT_MS,
      `新增后 ${result.elapsedMs}ms 才更新，超过验收上限 ${LOCAL_WATCH_TIMEOUT_MS}ms`,
    );
    const lines = await waitWatchLog(logOffset, { timeoutMs: 4000 }).catch(() => []);
    if (lines.length > 0) suite.note(`宿主日志：${lines.join(' | ')}`);
    else suite.note('宿主日志没有匹配到 watch 行（可能日志延迟；页面已更新，继续）');
    suite.note(`新增耗时 ${result.elapsedMs}ms（Lead 实测约 3.4s，上限 ${LOCAL_WATCH_TIMEOUT_MS}ms）`);
    await suite.shot('watch-add');
    return `${result.elapsedMs}ms → ${result.state.sub}`;
  });

  await suite.step('删除文件：页面 ≤8s 自动回到基线（不刷新、不重进页面）', async () => {
    suite.assert(addedPath, '前序步骤没有放入测试文件');
    suite.assert(fs.existsSync(addedPath), `测试文件不在了：${addedPath}`);

    const logOffset = hostLogSize();
    fs.rmSync(addedPath, { force: true });
    suite.note(`已删除文件：${addedPath}`);

    let result;
    try {
      result = await waitLocalCount(cdp, baseCount, {
        timeoutMs: LOCAL_WATCH_TIMEOUT_MS,
        desc: '删除 mp3 后本地页自动回到基线',
      });
    } catch (err) {
      await suite.shot('watch-remove-timeout');
      const state = await readLocalState(cdp).catch(() => null);
      throw new Error(
        `${err.message}；当前页面：${JSON.stringify(state)}；磁盘：${fs.readdirSync(WATCH_DIR).join(', ')}`,
      );
    }

    suite.assert(
      result.elapsedMs <= LOCAL_WATCH_TIMEOUT_MS,
      `删除后 ${result.elapsedMs}ms 才更新，超过验收上限 ${LOCAL_WATCH_TIMEOUT_MS}ms`,
    );
    const lines = await waitWatchLog(logOffset, { timeoutMs: 4000 }).catch(() => []);
    if (lines.length > 0) suite.note(`宿主日志：${lines.join(' | ')}`);
    else suite.note('宿主日志没有匹配到 watch 行（可能日志延迟；页面已恢复，继续）');
    suite.assert(
      result.state.count === baseCount,
      `删除后计数 ${result.state.count} ≠ 基线 ${baseCount}（sub=「${result.state.sub}」）`,
    );
    suite.note(`删除耗时 ${result.elapsedMs}ms（Lead 实测约 2.3s，上限 ${LOCAL_WATCH_TIMEOUT_MS}ms）`);
    await suite.shot('watch-remove');
    return `${result.elapsedMs}ms → ${result.state.sub}`;
  });

  await suite.step('收尾：宿主重新映射 + 还原 localStorage + 删除测试目录', async () => {
    // 1) 先把宿主从测试目录挪走（否则删目录后 watcher 会不断报错）
    const fallback = dirExists(LOCAL_FIXTURE_DIR) ? LOCAL_FIXTURE_DIR : null;
    const target = origFolder && dirExists(origFolder) ? origFolder : fallback;
    if (target) {
      const posted = await cdp.hostPost({ v: 1, type: 'local', action: 'restore', folder: toUrlPath(target) });
      suite.assert(posted, '收尾时无法向宿主发送 restore');
      await sleep(800);
      suite.note(`宿主已重新映射到：${target}`);
    } else {
      suite.note('原目录与夹具目录都不存在，跳过宿主重新映射');
    }

    // 2) 还原页面记住的文件夹
    await writeLocalStorage(cdp, LOCAL_FOLDER_KEY, origFolder);
    const restored = await readLocalStorage(cdp, LOCAL_FOLDER_KEY);
    suite.assert(
      restored === origFolder || (origFolder === null && restored === null),
      `localStorage.${LOCAL_FOLDER_KEY} 未还原：期望 ${JSON.stringify(origFolder)}，实际 ${JSON.stringify(restored)}`,
    );

    // 3) 删测试目录
    if (watchDirReady) {
      fs.rmSync(WATCH_DIR, { recursive: true, force: true });
      suite.assert(!fs.existsSync(WATCH_DIR), `测试目录没有删掉：${WATCH_DIR}`);
    }

    await goHome(cdp);
    suite.note(`已清理 ${repoRel(WATCH_DIR)}${addedPath ? `（含新增文件 ${path.basename(addedPath)}）` : ''}`);
    return '夹具与 localStorage 已还原';
  });
});
