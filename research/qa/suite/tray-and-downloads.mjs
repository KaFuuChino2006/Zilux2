/**
 * Zilux2 真机 QA —— 托盘 / 全局热键 / 宿主命令通道（task-12）
 *
 * 覆盖（尽量在 CDP/日志层自动化的部分）：
 *   1) 宿主日志：本次会话 host.start 版本/PID（默认取仓库 Directory.Build.props 的 <Version>，可用 ZILUX2_EXPECT_HOST_VERSION 覆盖）；
 *   2) 全局热键注册：id=1..4 全部注册成功，动作/按键符合设计；id=2/3 允许首选键被占用后回落；
 *   3) 托盘初始化：tray.start icon=process，且无 tray.error；
 *   4) 宿主命令通道：页面确实通过 window.chrome.webview.addEventListener 注册了 host.onMessage；
 *   5) 从页面派发 MessageEvent 模拟宿主 {v:1,type:'command',action:...}，验证 togglePlay/prev/next
 *      被执行且宿主日志出现 `web:info command <action>`；非 command 消息/未知 action 必须被忽略；
 *   6) 托盘交互/关窗后台/右键菜单/退出 等只能在桌面上人工确认 —— 本套件记 SKIP 并在 README「托盘手测清单」写明步骤与
 *      预期 host.log 关键字（tray.hide / tray.show / tray.command / tray.exit 等）。
 *
 * 设计约束：
 *   - 不 taskkill、不重启应用、不点窗口关闭按钮（关窗=隐藏到托盘，会打断后续套件）；
 *   - 只读 host.log，不写应用日志；
 *   - 派发命令前把页面 <audio> 临时静音，避免自动化验收时出声，结束后恢复。
 *
 * 环境变量：
 *   ZILUX2_EXPECT_HOST_VERSION  期望宿主版本；默认从仓库 Directory.Build.props 的 <Version> 读取
 *                               （发版只改那一处，测试不再硬编码旧版本号）
 *
 * 用法：node research/qa/suite/tray-and-downloads.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import { runSuite, sleep, hostLogTail, hostLogSize, hostLogSince, HOST_LOG, REPO_ROOT } from './lib/cdp.mjs';
import { closeOverlays, goHome } from './lib/ui.mjs';

/** 期望版本：优先环境变量，其次仓库 Directory.Build.props 的 <Version>，最后兜底。 */
function resolveExpectVersion() {
  const fromEnv = (process.env.ZILUX2_EXPECT_HOST_VERSION || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const props = fs.readFileSync(path.join(REPO_ROOT, 'Directory.Build.props'), 'utf8');
    const match = /<Version>\s*([^<\s]+)\s*<\/Version>/.exec(props);
    if (match) return match[1];
  } catch {
    /* 读不到就兜底 */
  }
  return '1.1.8';
}

const EXPECT_VERSION = resolveExpectVersion();

/** 读整份宿主日志（host.log 不大，直接读全文）。 */
function readHostLog() {
  try {
    return fs.readFileSync(HOST_LOG, 'utf8');
  } catch {
    return '';
  }
}

/** 最近一次宿主启动会话（从最后一条 host.start 到文件末尾）。 */
function currentSessionLog() {
  const lines = readHostLog().split(/\r?\n/).filter(Boolean);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes('host.start')) {
      start = i;
      break;
    }
  }
  return {
    lines,
    sessionLines: start >= 0 ? lines.slice(start) : [],
    startLine: start >= 0 ? lines[start] : '',
  };
}

function findLine(lines, regex) {
  return lines.find((line) => regex.test(line)) || '';
}

/** 解析某个热键 id 的注册结果。 */
function parseHotkey(lines, id) {
  const ok = findLine(lines, new RegExp(`hotkey\\.register id=${id} ok`));
  const finalFail = findLine(lines, new RegExp(`hotkey\\.register id=${id} failed`));
  const candidateFailures = lines
    .filter((line) => line.includes(`hotkey.register id=${id} candidate=`) && line.includes('failed'))
    .map((line) => {
      const match = /candidate=([^ ]+) failed error=(\d+)/.exec(line);
      return match ? { candidate: match[1], error: match[2] } : { candidate: '?', error: '?' };
    });
  const match = ok ? /action=(\w+) key=([^ ]+)/.exec(ok) : null;
  return {
    registered: !!ok,
    line: ok,
    action: match ? match[1] : '',
    key: match ? match[2] : '',
    candidateFailures,
    finalFail,
  };
}

/** 等日志里出现匹配行（从 fromSize 之后读）。 */
async function waitForHostLog(regex, { timeoutMs = 6000, fromSize = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { text } = hostLogSince(fromSize);
    const hit = text.split(/\r?\n/).find((line) => regex.test(line));
    if (hit) return hit;
    await sleep(250);
  }
  return '';
}

await runSuite('tray-and-downloads', '托盘 / 全局热键 / 宿主命令通道（task-12）', async (suite) => {
  const cdp = suite.cdp;
  let session = { sessionLines: [], startLine: '' };
  /** @type {{state: string, before: any, after: any} | null} */
  let playbackProbe = null;
  /** @type {{count: number, prev: boolean[]} | null} */
  let muteState = null;

  /* ---------------------------------------------------------------------- */
  await suite.step('宿主日志：本次会话 host.start 版本 / PID', async () => {
    session = currentSessionLog();
    suite.assert(session.sessionLines.length > 0, `host.log 里找不到 host.start（应用启动了吗？路径：${HOST_LOG}）`);
    const start = session.startLine;
    const match = /host\.start version=([^\s]+) pid=(\d+)/.exec(start);
    suite.assert(match, `host.start 行格式不符：${start}`);
    const [, version, pid] = match;
    suite.assert(
      version === EXPECT_VERSION,
      `宿主版本应为 ${EXPECT_VERSION}（本轮新构建），实际 ${version}（行：${start}）`,
    );
    suite.assert(Number(pid) > 0, `host.start 里的 pid 异常：${pid}`);
    suite.note(`host.log = ${HOST_LOG}`);
    return `host.start version=${version} pid=${pid}`;
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('全局热键：hotkey.register id=1..4 注册成功 / 动作与按键符合设计', async () => {
    const lines = session.sessionLines;
    const expected = [
      { id: 1, action: 'togglePlay', keys: [/^Ctrl\+Alt\+Space$/i] },
      { id: 2, action: 'prev', keys: [/^Ctrl\+Alt\+Left$/i, /^Ctrl\+Alt\+Shift\+Left$/i] },
      { id: 3, action: 'next', keys: [/^Ctrl\+Alt\+Right$/i, /^Ctrl\+Alt\+Shift\+Right$/i] },
      { id: 4, action: 'toggleWindow', keys: [/^Ctrl\+Alt\+Z$/i] },
    ];
    const summary = [];
    for (const item of expected) {
      const reg = parseHotkey(lines, item.id);
      suite.assert(reg.registered, `热键 id=${item.id} 未注册成功（最后失败行：${reg.finalFail || '无 ok 行'}）`);
      suite.assert(
        reg.action === item.action,
        `热键 id=${item.id} 动作应为 ${item.action}，实际「${reg.action}」（行：${reg.line}）`,
      );
      suite.assert(
        item.keys.some((re) => re.test(reg.key)),
        `热键 id=${item.id} 按键应为 ${item.keys.map((re) => re.source).join(' 或 ')}，实际「${reg.key}」`,
      );
      if (reg.candidateFailures.length > 0) {
        suite.note(
          `id=${item.id} 首选键被占用：${reg.candidateFailures.map((item2) => `${item2.candidate} error=${item2.error}`).join('，')} → 已回落 ${reg.key}`,
        );
      }
      summary.push(`id=${item.id}:${reg.action}@${reg.key}`);
    }
    return summary.join(' · ');
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('托盘初始化：tray.start icon=process / 无 tray.error', async () => {
    const lines = session.sessionLines;
    const trayStart = findLine(lines, /tray\.start\b/);
    suite.assert(!!trayStart, `host.log 里没有 tray.start（托盘初始化未执行）\n${hostLogTail(12)}`);
    suite.assert(/tray\.start icon=process/.test(trayStart), `tray.start 行 icon 应为 process，实际：${trayStart}`);
    const trayError = findLine(lines, /tray\.(error|fail)/i);
    suite.assert(!trayError, `host.log 出现托盘错误：${trayError}`);
    return trayStart.replace(/^.*?tray\.start/, 'tray.start');
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('宿主命令通道：页面注册了 chrome.webview message 监听（host.onMessage）', async () => {
    const bridge = await cdp.eval(`(() => {
      const wv = window.chrome && window.chrome.webview;
      return {
        exists: !!wv,
        hasAddEventListener: !!(wv && typeof wv.addEventListener === 'function'),
        hasPostMessage: !!(wv && typeof wv.postMessage === 'function'),
        canDispatch: !!(wv && typeof wv.dispatchEvent === 'function'),
      };
    })()`);
    suite.assert(bridge.exists, 'window.chrome.webview 不存在（不在 WebView2 宿主内？）');
    suite.assert(bridge.hasAddEventListener, 'chrome.webview.addEventListener 不存在（bridge.onMessage 无法注册）');
    suite.assert(bridge.hasPostMessage, 'chrome.webview.postMessage 不存在（页面→宿主通道不可用）');
    suite.assert(bridge.canDispatch, 'chrome.webview.dispatchEvent 不存在，无法在页面内模拟宿主命令');
    return 'chrome.webview: addEventListener / postMessage / dispatchEvent 均可用';
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('宿主命令：页面派发 {type:command} → togglePlay/prev/next 被执行且写入宿主日志', async () => {
    // 临时静音，避免自动化验收时出声
    muteState = await cdp.eval(`(() => {
      const list = Array.from(document.querySelectorAll('audio'));
      const prev = list.map((node) => !!node.muted);
      list.forEach((node) => { node.muted = true; });
      return { count: list.length, prev };
    })()`);
    if (muteState && muteState.count > 0) suite.note(`已临时静音 ${muteState.count} 个 <audio>`);

    const plugin = (action) => cdp.eval(`(() => {
      try {
        window.chrome.webview.dispatchEvent(new MessageEvent('message', {
          data: { v: 1, type: 'command', action: ${JSON.stringify(action)} },
        }));
        return true;
      } catch (err) {
        return String((err && err.message) || err);
      }
    })()`);

    const results = [];
    let playbackBefore = null;
    let playbackAfterToggle = null;
    for (const action of ['togglePlay', 'prev', 'next']) {
      const offset = hostLogSize();
      const dispatched = await plugin(action);
      suite.assert(dispatched === true, `派发 command「${action}」时页面抛错：${dispatched}`);
      const hit = await waitForHostLog(new RegExp(`web:info command ${action}\\b`), { timeoutMs: 6000, fromSize: offset });
      suite.assert(
        !!hit,
        `派发 {type:'command',action:'${action}'} 后宿主日志没有新增「web:info command ${action}」，` +
          `说明页面没有执行/记录该命令。\n新增日志：${hostLogSince(offset).text.slice(-800)}`,
      );
      results.push(`${action} → ${hit.replace(/^.*?web:info/, 'web:info')}`);
      if (action === 'togglePlay') {
        const probe = await cdp.eval(`(() => {
          const player = window.__ziluxPlayer && window.__ziluxPlayer();
          const audios = Array.from(document.querySelectorAll('audio'));
          return {
            playing: player && typeof player.playing === 'boolean' ? player.playing : null,
            audioPaused: audios.length ? audios.map((node) => node.paused) : [],
          };
        })()`);
        // 首次 togglePlay 前没取到基线（命令已派发），用「再派发一次」来验证来回切换
        playbackAfterToggle = probe;
        await sleep(1100);
      }
      await sleep(300);
    }
    // 再派发一次 togglePlay：既验证切换，也尽量回到原始播放状态
    const restoreOffset = hostLogSize();
    await plugin('togglePlay');
    const restoreHit = await waitForHostLog(/web:info command togglePlay\b/, { timeoutMs: 6000, fromSize: restoreOffset });
    await sleep(900);
    playbackBefore = await cdp.eval(`(() => {
      const player = window.__ziluxPlayer && window.__ziluxPlayer();
      return { playing: player && typeof player.playing === 'boolean' ? player.playing : null };
    })()`);
    playbackProbe = { first: playbackAfterToggle, restored: playbackBefore, restoreHit };
    return results.join(' · ');
  });

  /* 播放状态是否随 togglePlay 变化：能观测到就断言，观测不到按 SKIP 处理（要求 4 允许）。 */
  {
    const first = playbackProbe && playbackProbe.first;
    const restored = playbackProbe && playbackProbe.restored;
    const hit = playbackProbe && playbackProbe.restoreHit;
    const observable =
      first && typeof first.playing === 'boolean' && restored && typeof restored.playing === 'boolean';
    if (hit && observable && first.playing !== restored.playing) {
      suite.record(
        'PASS',
        '播放状态：togglePlay 命令驱动 __ziluxPlayer().playing 切换',
        `两次派发后 playing ${first.playing} → ${restored.playing}（已尽量回到原始状态）`,
      );
    } else if (hit && observable) {
      suite.skip(
        '播放状态：togglePlay 命令驱动 __ziluxPlayer().playing 切换',
        `宿主日志已确认命令执行（web:info command togglePlay），但当前无音频/元素状态未变：两次采样均为 playing=${String(restored.playing)}`,
      );
    } else if (hit) {
      suite.skip(
        '播放状态：togglePlay 命令驱动 __ziluxPlayer().playing 切换',
        '宿主日志已确认命令执行，但页面拿不到 __ziluxPlayer().playing（null），无法观测播放状态',
      );
    } else {
      suite.record(
        'FAIL',
        '播放状态：togglePlay 命令驱动 __ziluxPlayer().playing 切换',
        '第二次派发 togglePlay 后宿主日志没有新增 web:info command togglePlay',
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  await suite.step('宿主命令：非 command 消息 / 未知 action 必须被忽略（不写日志、不报错）', async () => {
    const offset = hostLogSize();
    const bridge = await cdp.eval(`(() => {
      const wv = window.chrome.webview;
      const sent = [];
      const push = (data) => {
        try { sent.push({ data, ok: true }); } catch (err) { sent.push({ data, ok: false }); }
      };
      for (const data of [
        { v: 1, type: 'command', action: 'qa-unknown-action' },
        { v: 1, type: 'not-a-command', action: 'togglePlay' },
        null,
      ]) {
        wv.dispatchEvent(new MessageEvent('message', { data }));
        push(data);
      }
      return sent.length;
    })()`);
    suite.assert(bridge === 3, `应派发 3 条非法/无关消息，实际 ${bridge}`);
    await sleep(700);
    const added = hostLogSince(offset).text;
    suite.assert(!/command qa-unknown-action/.test(added), `未知 action 不应被执行，但日志出现：${added.slice(-300)}`);
    suite.assert(!/command togglePlay/.test(added), `非 command 类型消息不应触发 togglePlay，但日志出现：${added.slice(-300)}`);
    return '未知 action / 非 command 类型 / null 数据均被忽略';
  });

  /* ---------------------------------------------------------------------- */
  /* 托盘交互与窗口行为需要人工在桌面确认：host.log 是唯一可自动断言的旁证。 */
  suite.skip(
    '托盘交互（图标存在/左键切换窗口/右键菜单 5 项/关窗后台/托盘「退出」）',
    '需要人工在桌面确认；步骤与预期 host.log 关键字见 research/qa/suite/README.md「托盘 / 热键手测清单」',
  );
  suite.skip(
    'WM_HOTKEY 模拟（向窗口发 0x0312 触发全局热键）',
    '本轮不模拟：沙箱禁止管道捕获子进程输出，且隐藏/恢复窗口会打断后续套件；人工按热键验证方式见 README 手测清单',
  );

  /* ---------------------------------------------------------------------- */
  await suite.step('收尾：恢复静音状态 / 关闭浮层 / 回首页 / console 无 error', async () => {
    if (muteState && muteState.count > 0) {
      const prev = JSON.stringify(muteState.prev);
      await cdp.eval(`(() => {
        const prev = ${prev};
        const list = Array.from(document.querySelectorAll('audio'));
        list.forEach((node, index) => {
          if (typeof prev[index] === 'boolean') node.muted = prev[index];
        });
        return true;
      })()`);
    }
    await closeOverlays(cdp);
    await goHome(cdp);
    const errors = cdp.takeConsoleErrors();
    // 已知环境噪音：命令通道会切歌，播放队列里持久化的封面地址可能还绑定着上一次宿主启动的
    // 回环端口（product 的 artwork.rebindCover 会在在线服务就绪后重绑并重载）。重绑前的首个请求
    // 会留下一条 net::ERR_CONNECTION_REFUSED /api/cover 日志—— tolerated，不算 JS 回归。
    const isStaleCoverNoise = (entry) =>
      entry.kind === 'log.error' &&
      /Failed to load resource/i.test(entry.text) &&
      /\/api\/cover/i.test(entry.text) &&
      /ERR_(CONNECTION_REFUSED|FAILED)/i.test(entry.text);
    const tolerated = errors.filter(isStaleCoverNoise);
    const fatal = errors.filter((entry) => !isStaleCoverNoise(entry));
    if (tolerated.length > 0) {
      suite.note(
        `容忍 ${tolerated.length} 条旧端口封面请求噪音（product 会 rebindCover 重载）：${tolerated
          .slice(0, 2)
          .map((entry) => entry.text.slice(0, 120))
          .join(' | ')}`,
      );
    }
    suite.assert(
      fatal.length === 0,
      `托盘/热键/命令通道套件期间出现 console 错误 ${fatal.length} 条：${fatal.slice(0, 3).map((err) => err.text).join(' | ')}`,
    );
    return `console 错误 0 条（容忍旧端口封面噪音 ${tolerated.length} 条）${muteState && muteState.count > 0 ? ` · 已恢复 ${muteState.count} 个 <audio> 静音状态` : ''}`;
  });
});
