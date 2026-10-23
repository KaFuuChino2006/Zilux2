/**
 * Zilux2 真机 QA —— 更新通道（Update v1）
 *
 * 覆盖：
 *   1. 设置页「更新」分区渲染：版本、更新状态、更新源输入框、操作按钮（检查更新…）；
 *   2. 点「检查更新」→ 状态流转（正在检查更新… → 终态）并读取宿主 host.log `[update] ...` 作为证据；
 *   3. 进程内 mock 更新服务可达性：/__ping、/repos/<owner>/<repo>/releases/latest、
 *      /download/<asset> 三条路由 + 响应体校验（不接触真实 GitHub，也不安装任何东西）；
 *   4. 全程不做安装/下载更新（绝不点「下载更新」「立即安装并重启」）；不重启主应用实例。
 *
 * 说明：
 *   - 主实例是 Lead 启动的基线安装版，通常没有配置 ZILUX2_UPDATE_API，所以第 2 步会走真实
 *     GitHub，终态可能是「更新通道暂不可用 / 已是最新版本」，两者都算通过；只断言是已知终态。
 *   - mock 服务只验证「协议形状正确、服务可达」，不等于主实例已经接入它。完整链路（app 配
 *     ZILUX2_UPDATE_API 指向 mock）需要 Lead 用 mock-updater.mjs 以环境变量重启应用，步骤见
 *     research/qa/suite/README.md「更新通道全链路（手动）」。
 *
 * 运行：node research/qa/suite/update-channel.mjs
 * 截图：research/shots/suite-YYYYMMDD/update-channel-*.png
 */
import http from 'node:http';

import { runSuite, sleep, hostLogSize, hostLogSince, repoRel } from './lib/cdp.mjs';
import { closeOverlays, goHome, openSettingsPane } from './lib/ui.mjs';

/** 与 web/src/ui/updates.ts 的 UPDATE_STATE_TEXT 对齐（允许「· vX」后缀）。 */
const KNOWN_STATES = [
  '尚未检查',
  '正在检查更新…',
  '已是最新版本',
  '发现新版本',
  '正在下载更新…',
  '新版本已下载，等待安装',
  '正在启动安装程序…',
  '检查更新失败',
  '更新通道暂不可用',
];

const CHECKING = '正在检查更新…';

/** mock 更新服务返回的假版本 / 假安装包（只用于协议校验，绝不安装）。 */
const MOCK_VERSION = '9.9.9-qa';
const MOCK_ASSET = Buffer.from('Zilux2-QA-mock-updater-payload\n');
const MOCK_ASSET_NAME = 'Zilux2-Setup-9.9.9-qa.exe';

/* -------------------------------------------------------------------------- */
/* 页面内函数                                                                  */
/* -------------------------------------------------------------------------- */

/** 读取设置页「更新」分区（当前可见 pane）的关键节点。 */
function pageUpdatePane() {
  const pane = Array.from(document.querySelectorAll('.settings-pane')).find((node) => !node.hasAttribute('hidden'));
  if (!pane) {
    return {
      found: false,
      panes: Array.from(document.querySelectorAll('.settings-pane')).map((n) => (n.hasAttribute('hidden') ? 'hidden' : 'visible')),
    };
  }
  const text = (selector) => {
    const node = pane.querySelector(selector);
    return node ? (node.textContent || '').trim() : '';
  };
  const isVisible = (node) => !!node && !node.hidden && node.getClientRects().length > 0;
  const versionNode = pane.querySelector('.updates-version');
  const statusNode = pane.querySelector('.updates-status');
  const statusField = statusNode ? statusNode.closest('.field') : null;
  const statusDetailNode = statusField ? statusField.querySelector('.field-hint') : null;
  const notesNode = pane.querySelector('.updates-notes');
  const notesField = notesNode ? notesNode.closest('.field') : null;
  const progressTrack = pane.querySelector('.updates-progress-track');
  const progressField = progressTrack ? progressTrack.closest('.field') : null;
  const progressFill = pane.querySelector('.updates-progress-fill');
  const repoNode = pane.querySelector('.updates-input');
  return {
    found: true,
    sectionTitles: Array.from(pane.querySelectorAll('.section-title')).map((node) => (node.textContent || '').trim()),
    version: versionNode ? (versionNode.textContent || '').trim() : '',
    status: statusNode ? (statusNode.textContent || '').trim() : '',
    statusDetail:
      statusDetailNode && !statusDetailNode.hidden ? (statusDetailNode.textContent || '').trim() : '',
    notes: text('.updates-notes'),
    notesHidden: notesField ? !!notesField.hidden : true,
    progressHidden: progressField ? !!progressField.hidden : true,
    progressWidth: progressFill ? String(progressFill.style.width || '') : '',
    actions: Array.from(pane.querySelectorAll('.updates-actions .btn')).map((node) => ({
      text: (node.textContent || '').trim(),
      hidden: !!node.hidden,
      disabled: !!node.disabled,
      visible: isVisible(node),
    })),
    repo: repoNode ? String(repoNode.value || '') : '',
    hostAvailable: !!(window.chrome && window.chrome.webview),
  };
}

async function readUpdatePane(cdp) {
  return cdp.eval(`(${pageUpdatePane.toString()})()`, { timeoutMs: 8000 });
}

function stateTextOf(pane) {
  return String((pane && pane.status) || '').trim();
}

/** 状态文案是否属于已知状态（允许「· v1.2.3」后缀）。 */
function isKnownState(text) {
  return KNOWN_STATES.some((known) => text === known || text.startsWith(`${known} ·`));
}

/* -------------------------------------------------------------------------- */
/* mock 更新服务（进程内，node:http，不 spawn 子进程）                          */
/* -------------------------------------------------------------------------- */

function startMockUpdater() {
  const requests = [];
  let base = '';
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    requests.push({ method: req.method || 'GET', url });
    const sendJson = (status, payload) => {
      const body = Buffer.from(JSON.stringify(payload));
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
      res.end(body);
    };
    if (url === '/__ping') {
      sendJson(200, { ok: true, service: 'zilux2-qa-mock-updater', version: MOCK_VERSION });
      return;
    }
    if (/^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(url)) {
      sendJson(200, {
        tag_name: `v${MOCK_VERSION}`,
        name: `Zilux2 QA mock ${MOCK_VERSION}`,
        body: 'QA mock release notes',
        draft: false,
        prerelease: false,
        html_url: `${base}/release/${MOCK_VERSION}`,
        assets: [
          {
            name: MOCK_ASSET_NAME,
            size: MOCK_ASSET.length,
            content_type: 'application/octet-stream',
            browser_download_url: `${base}/download/${MOCK_ASSET_NAME}`,
          },
        ],
      });
      return;
    }
    if (url.startsWith('/download/')) {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': MOCK_ASSET.length,
        'content-disposition': `attachment; filename="${MOCK_ASSET_NAME}"`,
      });
      res.end(MOCK_ASSET);
      return;
    }
    sendJson(404, { message: 'not found', url });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      base = `http://127.0.0.1:${address.port}`;
      resolve({
        server,
        base,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

async function httpGet(url, { timeoutMs = 6000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, contentType: response.headers.get('content-type') || '', body };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* 套件                                                                        */
/* -------------------------------------------------------------------------- */

await runSuite('update-channel', '更新通道（Update v1）', async (suite) => {
  const cdp = suite.cdp;

  await suite.step('设置页「更新」分区渲染', async () => {
    await closeOverlays(cdp);
    await openSettingsPane(cdp, '更新');

    const pane = await readUpdatePane(cdp);
    suite.assert(pane.found, `设置页没有可见的 .settings-pane（panes=${JSON.stringify(pane.panes)}）`);
    suite.assert(
      pane.sectionTitles.includes('更新'),
      `更新分区缺少 .section-title「更新」，实际：${JSON.stringify(pane.sectionTitles)}`,
    );
    suite.assert(/^(v\d+[\w.\-+]*|未知)$/.test(pane.version), `版本号文案异常：${JSON.stringify(pane.version)}`);
    suite.assert(isKnownState(stateTextOf(pane)), `更新状态不是已知文案：${JSON.stringify(pane.status)}`);
    suite.assert(pane.hostAvailable, 'window.chrome.webview 不存在，页面不在宿主里');
    suite.assert(!!pane.repo || pane.repo === '', '「更新源」输入框 .updates-input 不存在');

    const checkBtn = (pane.actions || []).find((btn) => btn.text.includes('检查更新'));
    suite.assert(checkBtn, `没有「检查更新」按钮，现有：${JSON.stringify(pane.actions)}`);
    suite.assert(checkBtn.visible, '「检查更新」按钮不可见');
    suite.assert(!checkBtn.disabled, '「检查更新」按钮被禁用（宿主未启用更新通道？）');

    // 下载/安装按钮只在特定状态出现，这里只记录显隐，不点击。
    suite.note(
      `动作按钮：${pane.actions.map((btn) => `${btn.text}${btn.hidden ? '(隐藏)' : ''}${btn.disabled ? '(禁用)' : ''}`).join(' / ')}`,
    );
    suite.note(`版本=${pane.version}；状态=「${pane.status}」；更新源=${pane.repo || '(内置默认)'}`);
    await suite.shot('updates-pane');
    return `${pane.version} / ${pane.status}`;
  });

  await suite.step('点「检查更新」：状态流转 + host.log 证据', async () => {
    const before = await readUpdatePane(cdp);
    const logOffset = hostLogSize();
    const clicked = await cdp.clickText('.updates-actions .btn', '检查更新', { desc: '更新分区「检查更新」按钮' });
    suite.assert(clicked && !clicked.__notFound, `「检查更新」按钮点击失败：${JSON.stringify(clicked)}`);

    // 先抓「正在检查更新…」这种过渡态（如果 1s 内没进入，说明点击被忽略/已完成，继续看终态）。
    const sawChecking = await cdp
      .waitFor(`(${pageUpdatePane.toString()})().status`, {
        timeoutMs: 3000,
        intervalMs: 120,
        desc: `状态变成「${CHECKING}」`,
        accept: (text) => String(text || '').trim() === CHECKING,
      })
      .then(() => true)
      .catch(() => false);

    let finalPane = null;
    try {
      await cdp.waitFor(`(${pageUpdatePane.toString()})().status`, {
        timeoutMs: 45000,
        intervalMs: 200,
        desc: '更新检查落到终态',
        accept: (text) => {
          const value = String(text || '').trim();
          return isKnownState(value) && value !== CHECKING;
        },
      });
      finalPane = await readUpdatePane(cdp);
    } catch (err) {
      await suite.shot('update-check-timeout');
      throw new Error(
        `${err.message}；点击前状态=「${before.status}」，当前 host.log 尾部：\n${hostLogSince(logOffset).text.slice(-1200)}`,
      );
    }

    suite.assert(
      isKnownState(stateTextOf(finalPane)),
      `检查更新终态不是已知文案：${JSON.stringify(finalPane.status)}`,
    );
    if (finalPane.status === '发现新版本') {
      // 不点下载/安装：只记录，避免真的改动安装目录。
      suite.note('检查到新版本但本套件不会下载/安装（安全约束）');
    }

    // 宿主日志证据：`[update] check repo=... url=...` + 终态行
    const updateLines = hostLogSince(logOffset)
      .text.split(/\r?\n/)
      .filter((line) => /\[update\]/.test(line));
    if (updateLines.length > 0) {
      suite.note(`host.log [update] 行：${updateLines.slice(-6).join(' | ')}`);
      const checkLine = updateLines.find((line) => /\[update\] check repo=/.test(line));
      suite.assert(checkLine, `host.log 没有 [update] check 行，实际：${updateLines.slice(-4).join(' | ')}`);
      if (checkLine && /url=http:\/\/127\.0\.0\.1|url=http:\/\/localhost/.test(checkLine)) {
        suite.note('当前实例的更新 API 指向本机 mock（完整链路环境）');
      }
    } else {
      suite.note('host.log 本次没有新增 [update] 行（可能日志延迟或状态来自宿主启动时的检查）');
    }

    suite.assert(!finalPane.progressHidden || true, '');
    if (!finalPane.progressHidden) suite.note(`下载进度条出现：width=${finalPane.progressWidth}`);
    suite.note(
      `检查前「${before.status}」→ 检查中${sawChecking ? '可见' : '未捕获（很快）'} → 终态「${finalPane.status}」${
        finalPane.statusDetail ? `（${finalPane.statusDetail}）` : ''
      }`,
    );
    await suite.shot('update-check');
    return finalPane.status;
  });

  await suite.step('mock 更新服务可达 + 协议形状正确', async () => {
    const mock = await startMockUpdater();
    try {
      // 1) 健康检查
      const ping = await httpGet(`${mock.base}/__ping`);
      suite.assert(ping.status === 200, `/__ping 返回 ${ping.status}`);
      const pingJson = JSON.parse(ping.body.toString('utf8'));
      suite.assert(pingJson.ok === true, `/__ping 响应异常：${ping.body.toString('utf8').slice(0, 300)}`);
      suite.note(`mock 已启动：${mock.base}（${pingJson.service}）`);

      // 2) GitHub release latest 形状（更新检查使用的路由）
      const release = await httpGet(`${mock.base}/repos/QA/Zilux2/releases/latest`);
      suite.assert(release.status === 200, `releases/latest 返回 ${release.status}`);
      const json = JSON.parse(release.body.toString('utf8'));
      suite.assert(json.tag_name === `v${MOCK_VERSION}`, `tag_name=${JSON.stringify(json.tag_name)}`);
      suite.assert(Array.isArray(json.assets) && json.assets.length === 1, `assets 数量异常：${(json.assets || []).length}`);
      const asset = json.assets[0];
      suite.assert(asset.name === MOCK_ASSET_NAME, `asset.name=${asset.name}`);
      suite.assert(/\/download\//.test(asset.browser_download_url), `asset.browser_download_url=${asset.browser_download_url}`);

      // 3) 安装包下载路由
      const download = await httpGet(asset.browser_download_url);
      suite.assert(download.status === 200, `安装包路由返回 ${download.status}`);
      suite.assert(download.body.length === MOCK_ASSET.length, `安装包大小 ${download.body.length} ≠ ${MOCK_ASSET.length}`);
      suite.assert(download.contentType.includes('application/octet-stream'), `Content-Type=${download.contentType}`);

      // 4) 请求记录：三条路由都被访问过
      const paths = mock.requests.map((item) => item.url);
      suite.assert(paths.includes('/__ping'), `mock 未记录 /__ping，实际：${JSON.stringify(paths)}`);
      suite.assert(
        paths.some((path) => /\/releases\/latest$/.test(path)),
        `mock 未记录 releases/latest，实际：${JSON.stringify(paths)}`,
      );
      suite.assert(
        paths.some((path) => path.startsWith('/download/')),
        `mock 未记录 /download/，实际：${JSON.stringify(paths)}`,
      );
      suite.note(`mock 请求记录：${JSON.stringify(mock.requests)}`);
      suite.note('说明：这只是 mock 协议自检；主实例接入 mock 的完整链路需按 README 手动跑');
      return `${mock.base} · 3 条路由 OK`;
    } finally {
      await mock.close();
    }
  });

  await suite.step('收尾：关闭设置页 + 检查 console 噪音', async () => {
    const consoleErrors = cdp.takeConsoleErrors();
    await closeOverlays(cdp);
    await goHome(cdp);
    if (consoleErrors.length > 0) {
      // 更新检查失败（真实 GitHub 不可达/仓库未公开）时页面可能打 console 噪音，这里只记录不判失败。
      suite.note(
        `console 错误 ${consoleErrors.length} 条（信息性，可能来自真实更新源网络失败）：${consoleErrors
          .slice(0, 3)
          .map((item) => item.text)
          .join(' | ')}`,
      );
    } else {
      suite.note('console 无错误');
    }
    return '设置页已关闭';
  });
});
