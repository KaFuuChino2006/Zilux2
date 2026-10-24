/**
 * Zilux2 真机 QA —— 全局快捷键设置面板 / 录制 / 宿主重注册（task-15）
 *
 * 覆盖：
 *   1) 设置页 UI：rail 设置 → 左侧导航「快捷键」→ [data-qa="shortcuts-section"]；
 *      4 行 [data-qa="shortcut-row"][data-action=playPause|prev|next|toggleWindow]，
 *      每行 .shortcut-key 显示组合、[data-qa="shortcut-status"] 显示宿主回执状态，
 *      [data-qa="shortcuts-enabled"] 开关默认开、[data-qa="shortcut-reset"] 恢复默认；
 *   2) 录制：点「重新录制」进入录制态（行 is-recording / 按钮「按下新组合…（Esc 取消）」），
 *      用 CDP Input.dispatchKeyEvent 发 Ctrl+Alt+U（modifiers=3），断言 pill / 状态 /
 *      宿主日志（hotkey.configured + hotkey.register + hotkey.apply）/ settings.json 全部更新；
 *   3) Esc 取消：不改变绑定、不写设置、不触发宿主重注册；
 *   4) Backspace 清除：pill 回「未设置」、settings.json 置空串、宿主 skipped reason=empty、count=3；
 *   5) 关闭总开关：4 行「未启用」、settings.json enabled=false、宿主 4 条 skipped reason=disabled
 *      + hotkey.apply enabled=false count=0；
 *   6) 重新开启 + 恢复默认：四行回默认组合、宿主 count=4、settings.json 恢复默认；
 *   7) 宿主动作：用 research/tmp/wh3.ps1 给主窗口 PostMessage WM_HOTKEY id=2（上一首），
 *      断言 host.log `hotkey.fire action=prev` + 页面 command 回执 `web:info command prev`
 *      （可用 ZILUX2_QA_WM_HOTKEY=0 关闭；WM_HOTKEY 是测试杠杆，OnHotkey 不校验注册表，
 *       不能用它断言「禁用态不触发」，禁用态由 hotkey.apply/skipped 日志覆盖）；
 *   8) page reload 一致性不做（Page.reload 已知偶发卡死）：改为断言 settings.json 持久化，
 *      并在 README §4.5 记录人工复核步骤。
 *
 * 收尾：恢复默认组合 + enabled=true、关闭设置弹窗、回首页、console 0 error。
 *
 * 环境变量：
 *   ZILUX2_QA_WM_HOTKEY=0   跳过 WM_HOTKEY 实发测试（默认执行）
 *   ZILUX2_SETTINGS_PATH    宿主 settings.json 路径（默认 %LOCALAPPDATA%\Zilux2\settings.json）
 *
 * 用法：node research/qa/suite/shortcuts.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  REPO_ROOT,
  hostLogSince,
  hostLogSize,
  hostLogTail,
  repoRel,
  runSuite,
  sleep,
} from './lib/cdp.mjs';
import { closeOverlays, goHome, openSettingsPane, pressEscape } from './lib/ui.mjs';
import {
  HOTKEY_IDS,
  SETTINGS_JSON,
  SHORTCUT_ACTIONS,
  SHORTCUT_DEFAULTS,
  SHORTCUTS,
  SHORTCUT_LABELS,
} from './lib/fixtures.mjs';

/** CDP modifiers 位掩码：Alt=1，Ctrl=2，Meta=4，Shift=8。Ctrl+Alt = 3。 */
const MOD_CTRL_ALT = 3;

/** 录制的新组合（一条普通字母键，避免和宿主默认组合/系统占用冲突）。 */
const RECORD_KEY = { keyName: 'u', code: 'KeyU', vk: 85, display: 'Ctrl + Alt + U', normalized: 'Ctrl+Alt+U' };

/** 读宿主 settings.json（宿主 SettingsService 持久化；页面不再镜像到 localStorage）。 */
function readSettingsJson() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8'));
  } catch {
    return null;
  }
}

function shortcutsOf(json) {
  return json && typeof json === 'object' && json.shortcuts ? json.shortcuts : null;
}

/** 四条动作与 enabled 都等于默认值。 */
function isDefaultShortcuts(shortcuts) {
  if (!shortcuts) return false;
  return (
    shortcuts.enabled === SHORTCUT_DEFAULTS.enabled &&
    SHORTCUT_ACTIONS.every((action) => shortcuts[action] === SHORTCUT_DEFAULTS[action])
  );
}

/** 轮询 settings.json，直到 shortcuts 满足断言。 */
async function waitSettingsShortcuts(predicate, { timeoutMs = 8000, intervalMs = 150, desc = 'settings.json shortcuts' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const shortcuts = shortcutsOf(readSettingsJson());
    last = shortcuts;
    try {
      if (shortcuts && predicate(shortcuts)) return shortcuts;
    } catch {
      /* predicate 抛错按未满足处理 */
    }
    await sleep(intervalMs);
  }
  throw new Error(`${desc} 未在 ${timeoutMs}ms 内满足；实际：${JSON.stringify(last)}（${SETTINGS_JSON}）`);
}

function newLogLines(offset) {
  return hostLogSince(offset).text.split(/\r?\n/).filter(Boolean);
}

/** 等宿主日志（从 fromSize 之后）出现匹配行。 */
async function waitLog(regex, { fromSize = 0, timeoutMs = 8000, intervalMs = 200, desc = String(regex) } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = newLogLines(fromSize).find((line) => regex.test(line));
    if (hit) return hit;
    await sleep(intervalMs);
  }
  throw new Error(
    `宿主日志未出现 ${desc}（${timeoutMs}ms）。新增日志：\n${hostLogSince(fromSize).text.slice(-1200) || '（无）'}\n` +
      `host.log：${SETTINGS_JSON.replace(/settings\.json$/, 'logs\\host.log')}`,
  );
}

/** 一次性读取快捷键面板的完整 DOM 状态。 */
async function panelState(cdp) {
  return cdp.eval(`(() => {
    const section = document.querySelector(${JSON.stringify(SHORTCUTS.section)});
    const rows = Array.from(document.querySelectorAll(${JSON.stringify(SHORTCUTS.row)}));
    const enabled = document.querySelector(${JSON.stringify(SHORTCUTS.enabled)});
    const switchRoot = enabled && enabled.querySelector('.pill-switch');
    const switchButtons = enabled ? Array.from(enabled.querySelectorAll('.pill-switch-btn')) : [];
    return {
      section: !!section,
      navLabels: Array.from(document.querySelectorAll('.settings-nav-btn')).map((n) => (n.textContent || '').trim()),
      rows: rows.map((row) => {
        const key = row.querySelector(${JSON.stringify(SHORTCUTS.key)});
        const status = row.querySelector(${JSON.stringify(SHORTCUTS.status)});
        const record = row.querySelector(${JSON.stringify(SHORTCUTS.record)});
        const label = row.querySelector('.shortcut-label');
        return {
          action: row.dataset.action || '',
          label: label ? (label.textContent || '').trim() : '',
          key: key ? (key.textContent || '').trim() : '',
          keyEmpty: key ? key.classList.contains('is-empty') : false,
          status: status ? (status.textContent || '').trim() : '',
          statusKind: status && status.dataset ? status.dataset.kind || '' : '',
          recordText: record ? (record.textContent || '').trim() : '',
          recording: row.classList.contains('is-recording'),
        };
      }),
      enabled: enabled
        ? {
            dataset: enabled.dataset.enabled || '',
            switchOn: !!(switchRoot && switchRoot.classList.contains('is-on')),
            buttons: switchButtons.map((btn) => ({
              text: (btn.textContent || '').trim(),
              on: btn.classList.contains('is-on'),
            })),
          }
        : null,
      resetText: (() => {
        const node = document.querySelector(${JSON.stringify(SHORTCUTS.reset)});
        return node ? (node.textContent || '').trim() : '';
      })(),
      tip: (() => {
        const node = document.querySelector(${JSON.stringify(SHORTCUTS.tip)});
        return node ? (node.textContent || '').trim() : '';
      })(),
    };
  })()`);
}

function rowOf(state, action) {
  return state.rows.find((row) => row.action === action) || null;
}

/** 点某行的「重新录制」按钮。 */
async function clickRecord(cdp, action) {
  return cdp.click(`${SHORTCUTS.rowAction(action)} ${SHORTCUTS.record}`, {
    desc: `「${SHORTCUT_LABELS[action]}」行的录制按钮`,
    timeoutMs: 6000,
  });
}

/** 发一次完整按键（keyDown + keyUp）；modifiers 用 CDP 位掩码。 */
async function pressKey(cdp, { keyName, code, vk, modifiers = 0 }) {
  const base = {
    modifiers,
    key: keyName,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  };
  await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' });
  await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  await sleep(180);
}

/** 等某行 pill 的展示文本变成期望值。 */
async function waitRowKey(cdp, action, expected, timeoutMs = 8000) {
  return cdp.waitFor(
    `(() => {
      const row = document.querySelector(${JSON.stringify(SHORTCUTS.rowAction(action))});
      const key = row && row.querySelector(${JSON.stringify(SHORTCUTS.key)});
      return key ? (key.textContent || '').trim() : '';
    })()`,
    {
      desc: `「${SHORTCUT_LABELS[action]}」行组合显示为 ${expected}`,
      timeoutMs,
      intervalMs: 120,
      accept: (value) => value === expected,
    },
  );
}

/** 所有 audio 临时静音 + 定时器兜底（prev 会新建 audio 元素）。 */
async function installAudioMuteGuard(cdp) {
  return cdp.eval(`(() => {
    const prev = Array.from(document.querySelectorAll('audio')).map((node) => !!node.muted);
    const muteAll = () => document.querySelectorAll('audio').forEach((node) => { node.muted = true; });
    muteAll();
    window.__qaAudioGuard = { prev, timer: setInterval(muteAll, 40) };
    return prev.length;
  })()`);
}

async function removeAudioMuteGuard(cdp) {
  return cdp.eval(`(() => {
    const guard = window.__qaAudioGuard;
    if (guard && guard.timer) clearInterval(guard.timer);
    document.querySelectorAll('audio').forEach((node, index) => {
      node.muted = !!(guard && guard.prev && guard.prev[index]);
    });
    delete window.__qaAudioGuard;
    return true;
  })()`);
}

/** 播放器状态（只读）。 */
async function playerState(cdp) {
  return cdp.eval(`(() => {
    const player = window.__ziluxPlayer && window.__ziluxPlayer();
    if (!player) return null;
    return { playing: !!player.playing };
  })()`);
}

/** 通过页面 bridge 模拟宿主 command（用于恢复播放状态）。 */
async function dispatchHostCommand(cdp, action) {
  return cdp.eval(`(() => {
    try {
      window.chrome.webview.dispatchEvent(new MessageEvent('message', { data: { v: 1, type: 'command', action: ${JSON.stringify(action)} } }));
      return true;
    } catch (err) {
      return String((err && err.message) || err);
    }
  })()`);
}

/** 安全恢复默认：只在非默认状态下点「恢复默认」，并等宿主重注册完成。 */
async function ensureDefaults(cdp, suite) {
  const current = shortcutsOf(readSettingsJson());
  if (isDefaultShortcuts(current)) {
    suite.note('settings.json 已是默认快捷键，跳过恢复');
    return;
  }
  const offset = hostLogSize();
  await cdp.click(SHORTCUTS.reset, { desc: '「恢复默认」按钮', timeoutMs: 6000 });
  await waitSettingsShortcuts(isDefaultShortcuts, { desc: '点恢复默认后的 settings.json' });
  await waitLog(/hotkey\.apply enabled=true count=4 reason=settings/, { fromSize: offset, timeoutMs: 8000 });
  suite.note(`已恢复默认快捷键（原值：${JSON.stringify(current)}）`);
}

/* -------------------------------------------------------------------------- */
/* WM_HOTKEY 实发测试：放在 suite.step 之外，方便「不可自动化」时记 SKIP 而不是 PASS/FAIL */
/* -------------------------------------------------------------------------- */
async function runWmHotkeyCheck(suite, cdp) {
  const name = '宿主动作：WM_HOTKEY id=2（上一首）→ hotkey.fire + 页面 command 回执';
  if (process.env.ZILUX2_QA_WM_HOTKEY === '0') {
    suite.skip(name, '已按 ZILUX2_QA_WM_HOTKEY=0 跳过（WM_HOTKEY 是测试杠杆，见 README §4.5）');
    return;
  }
  const script = path.join(REPO_ROOT, 'research', 'tmp', 'wh3.ps1');
  if (!fs.existsSync(script)) {
    suite.skip(name, `找不到 ${repoRel(script)}（真机辅助脚本），改为人工验证（README §4.5）`);
    return;
  }

  const started = Date.now();
  let guarded = false;
  try {
    const before = await playerState(cdp);
    await installAudioMuteGuard(cdp);
    guarded = true;
    const offset = hostLogSize();
    const spawn = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, 'hotkey', String(HOTKEY_IDS.prev)],
      { stdio: 'ignore', timeout: 25000 },
    );
    suite.assert(
      spawn.status === 0,
      `wh3.ps1 退出码 ${spawn.status}${spawn.error ? `（${spawn.error.message}）` : ''}`,
    );
    const fireLine = await waitLog(/hotkey\.fire action=prev\b/, {
      fromSize: offset,
      timeoutMs: 8000,
      desc: 'hotkey.fire action=prev',
    });
    const commandLine = await waitLog(/web:info command prev\b/, {
      fromSize: offset,
      timeoutMs: 8000,
      desc: 'web:info command prev',
    });

    // prev 可能把「暂停」带成「播放」：测试前若为暂停则恢复暂停（避免留下外放声音）。
    let restored = '';
    const after = await playerState(cdp);
    if (before && after && before.playing === false && after.playing === true) {
      const resumeOffset = hostLogSize();
      await dispatchHostCommand(cdp, 'togglePlay');
      await waitLog(/web:info command togglePlay\b/, {
        fromSize: resumeOffset,
        timeoutMs: 6000,
        desc: '恢复暂停的 togglePlay',
      });
      restored = '；已恢复为暂停';
    }
    suite.record(
      'PASS',
      name,
      `${fireLine.replace(/^.*?hotkey\.fire/, 'hotkey.fire')}；${commandLine.replace(/^.*?web:info/, 'web:info')}${restored}`,
      Date.now() - started,
    );
  } catch (err) {
    const evidence = await suite.captureEvidence('wm-hotkey');
    suite.record('FAIL', name, err && err.message ? err.message : String(err), Date.now() - started, evidence);
  } finally {
    if (guarded) await removeAudioMuteGuard(cdp).catch(() => {});
    await goHome(cdp).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */

await runSuite('shortcuts', '全局快捷键：设置面板 / 录制 / 宿主重注册（task-15）', async (suite) => {
  const cdp = suite.cdp;
  let initialShortcuts = null;

  /* ---------------------------------------------------------------------- */
  await suite.step('准备：打开设置 →「快捷键」页 / 基线设置', async () => {
    await closeOverlays(cdp);
    await goHome(cdp);
    await openSettingsPane(cdp, SHORTCUTS.navLabel);
    await cdp.waitFor(`!!document.querySelector(${JSON.stringify(SHORTCUTS.section)})`, {
      desc: '快捷键设置区 [data-qa="shortcuts-section"]',
      timeoutMs: 8000,
    });
    await ensureDefaults(cdp, suite);
    const state = await panelState(cdp);
    suite.assert(state.navLabels.includes(SHORTCUTS.navLabel), `设置左侧导航没有「${SHORTCUTS.navLabel}」：${JSON.stringify(state.navLabels)}`);
    suite.assert(state.section, '快捷键设置区不可见');
    initialShortcuts = shortcutsOf(readSettingsJson());
    suite.assert(initialShortcuts, `读不到 settings.json 的 shortcuts 段（${SETTINGS_JSON}）`);
    await suite.shot('settings-shortcuts');
    return `导航 ${state.navLabels.length} 项；shortcuts=${JSON.stringify(initialShortcuts)}`;
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('结构：4 行动作 / 默认组合 / 行内状态 / 总开关 / 恢复默认按钮', async () => {
    const state = await panelState(cdp);
    suite.assert(state.rows.length === 4, `应有 4 行 [data-qa="shortcut-row"]，实际 ${state.rows.length}`);
    const actions = state.rows.map((row) => row.action);
    suite.assert(
      JSON.stringify(actions) === JSON.stringify(SHORTCUT_ACTIONS),
      `行顺序应为 ${SHORTCUT_ACTIONS.join('/')}，实际 ${actions.join('/')}`,
    );
    for (const action of SHORTCUT_ACTIONS) {
      const row = rowOf(state, action);
      suite.assert(!!row, `缺少动作 ${action} 的快捷键行`);
      suite.assert(
        row.label === SHORTCUT_LABELS[action],
        `动作 ${action} 的行标题应为「${SHORTCUT_LABELS[action]}」，实际「${row.label}」`,
      );
      suite.assert(/^Ctrl \+ Alt \+ /.test(row.key), `动作 ${action} 的组合显示不合法：「${row.key}」`);
      suite.assert(
        /已生效|已回落到|未启用|未设置/.test(row.status),
        `动作 ${action} 的状态文案异常：「${row.status}」`,
      );
      suite.assert(row.statusKind !== '', `动作 ${action} 的状态缺少 data-kind`);
      suite.assert(row.recordText === '重新录制', `动作 ${action} 的录制按钮文案应为「重新录制」，实际「${row.recordText}」`);
      suite.assert(!row.recording, `动作 ${action} 行不应处于录制态`);
    }
    // 默认组合展示
    suite.assert(rowOf(state, 'playPause').key === 'Ctrl + Alt + Space', 'playPause 默认组合显示错误');
    suite.assert(rowOf(state, 'toggleWindow').key === 'Ctrl + Alt + Z', 'toggleWindow 默认组合显示错误');
    // 总开关：默认开
    suite.assert(state.enabled, '缺少 [data-qa="shortcuts-enabled"] 总开关');
    suite.assert(state.enabled.dataset === 'true', `总开关 data-enabled 应为 true，实际 ${state.enabled.dataset}`);
    suite.assert(state.enabled.switchOn, '总开关的 .pill-switch 没有 is-on');
    const onButton = state.enabled.buttons.find((btn) => btn.text === '开');
    const offButton = state.enabled.buttons.find((btn) => btn.text === '关');
    suite.assert(!!onButton && !!offButton, `总开关应有「关」「开」两个按钮，实际 ${JSON.stringify(state.enabled.buttons)}`);
    suite.assert(onButton.on && !offButton.on, '总开关默认应停在「开」');
    // 恢复默认按钮与提示
    suite.assert(state.resetText === '恢复默认', `应有「恢复默认」按钮，实际「${state.resetText}」`);
    suite.assert(/全局快捷键在应用后台/.test(state.tip), `缺少快捷键说明文字（.shortcut-tip）`);
    return `4 行：${state.rows.map((row) => `${row.action}=${row.key}(${row.statusKind})`).join(' · ')}`;
  });

  /* ---------------------------------------------------------------------- */
  await suite.step(`录制：点「上一首」→ CDP 发 Ctrl+Alt+U → pill / settings.json / 宿主重注册`, async () => {
    const offset = hostLogSize();
    await clickRecord(cdp, 'prev');
    await cdp.waitFor(
      `(() => { const row = document.querySelector(${JSON.stringify(SHORTCUTS.rowAction('prev'))}); return !!row && row.classList.contains('is-recording'); })()`,
      { desc: '「上一首」行进入录制态', timeoutMs: 4000 },
    );
    const recording = await panelState(cdp);
    const prevRow = rowOf(recording, 'prev');
    suite.assert(prevRow.statusKind === 'recording', `录制态 status data-kind 应为 recording，实际「${prevRow.statusKind}」`);
    suite.assert(
      prevRow.recordText === '按下新组合…（Esc 取消）',
      `录制态按钮文案应为「按下新组合…（Esc 取消）」，实际「${prevRow.recordText}」`,
    );
    suite.assert(
      /按下组合/.test(prevRow.status),
      `录制态状态文案应提示按下组合，实际「${prevRow.status}」`,
    );

    await pressKey(cdp, { ...RECORD_KEY, modifiers: MOD_CTRL_ALT });
    await waitRowKey(cdp, 'prev', RECORD_KEY.display);
    await waitSettingsShortcuts((shortcuts) => shortcuts.prev === RECORD_KEY.normalized, {
      desc: 'settings.json shortcuts.prev 更新',
    });

    const configured = await waitLog(new RegExp(`hotkey\\.configured action=prev value=${RECORD_KEY.normalized.replace(/\+/g, '\\+')}\\b`), {
      fromSize: offset,
      timeoutMs: 8000,
      desc: `hotkey.configured action=prev value=${RECORD_KEY.normalized}`,
    });
    const registered = await waitLog(
      new RegExp(`hotkey\\.register id=2 ok action=prev key=${RECORD_KEY.normalized.replace(/\+/g, '\\+')}\\b`),
      { fromSize: offset, timeoutMs: 8000, desc: 'hotkey.register id=2 ok' },
    );
    await waitLog(/hotkey\.apply enabled=true count=4 reason=settings/, {
      fromSize: offset,
      timeoutMs: 8000,
      desc: 'hotkey.apply enabled=true count=4 reason=settings',
    });

    const after = await panelState(cdp);
    const row = rowOf(after, 'prev');
    suite.assert(row.key === RECORD_KEY.display, `pill 应显示 ${RECORD_KEY.display}，实际「${row.key}」`);
    suite.assert(row.status === '已生效', `新组合状态应为「已生效」，实际「${row.status}」`);
    suite.assert(!row.recording, '录制完成后行不应仍是录制态');
    suite.assert(row.recordText === '重新录制', '录制完成后按钮应恢复「重新录制」');

    const toast = await cdp.evalOpt(
      `(() => Array.from(document.querySelectorAll('.toast')).map((n) => (n.textContent || '').trim()).join(' | '))()`,
      '',
    );
    suite.assert(
      /快捷键已更新：上一首 → Ctrl \+ Alt \+ U/.test(toast),
      `缺少「快捷键已更新」toast，实际「${toast}」`,
    );
    await suite.shot('recording-prev-recorded');
    return `${configured.replace(/^.*?hotkey\.configured/, 'hotkey.configured')}；${registered.replace(/^.*?hotkey\.register/, 'hotkey.register')}`;
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('录制取消：Esc 不改变绑定 / 不写 settings.json / 不触发宿主重注册', async () => {
    const before = shortcutsOf(readSettingsJson());
    const offset = hostLogSize();
    await clickRecord(cdp, 'next');
    await cdp.waitFor(
      `(() => { const row = document.querySelector(${JSON.stringify(SHORTCUTS.rowAction('next'))}); return !!row && row.classList.contains('is-recording'); })()`,
      { desc: '「下一首」行进入录制态', timeoutMs: 4000 },
    );
    await pressKey(cdp, { keyName: 'Escape', code: 'Escape', vk: 27, modifiers: 0 });
    await cdp.waitFor(
      `(() => { const row = document.querySelector(${JSON.stringify(SHORTCUTS.rowAction('next'))}); return !!row && !row.classList.contains('is-recording'); })()`,
      { desc: '「下一首」行退出录制态', timeoutMs: 4000 },
    );
    await sleep(400);
    const after = shortcutsOf(readSettingsJson());
    suite.assert(
      JSON.stringify(after) === JSON.stringify(before),
      `Esc 取消后 settings.json 应保持不变：before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );
    const state = await panelState(cdp);
    suite.assert(rowOf(state, 'next').key === 'Ctrl + Alt + Right', 'Esc 取消后「下一首」组合不应变化');
    const lines = newLogLines(offset);
    suite.assert(
      !lines.some((line) => /settings\] patch keys=.*shortcuts\.next/.test(line) || /hotkey\.apply /.test(line)),
      `Esc 取消后不应触发设置 patch / 宿主重注册，新增日志：\n${lines.slice(-6).join('\n')}`,
    );
    // 录制取消不应关掉设置弹窗（录制态在 window capture 阶段吞掉 Escape）
    const sheetCount = await cdp.evalOpt(`document.querySelectorAll('.settings-layout').length`, 0);
    suite.assert(sheetCount === 1, 'Esc 取消录制后设置弹窗不应被关闭');
    return 'Esc 后绑定/设置/宿主注册均未变化';
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('录制清除：Backspace →「未设置」+ 宿主 skipped reason=empty + count=3', async () => {
    const offset = hostLogSize();
    const before = shortcutsOf(readSettingsJson());
    suite.assert(before && before.toggleWindow === 'Ctrl+Alt+Z', `清除前 toggleWindow 应为默认值，实际 ${JSON.stringify(before)}`);
    await clickRecord(cdp, 'toggleWindow');
    await cdp.waitFor(
      `(() => { const row = document.querySelector(${JSON.stringify(SHORTCUTS.rowAction('toggleWindow'))}); return !!row && row.classList.contains('is-recording'); })()`,
      { desc: '「显示 / 隐藏窗口」行进入录制态', timeoutMs: 4000 },
    );
    await pressKey(cdp, { keyName: 'Backspace', code: 'Backspace', vk: 8, modifiers: 0 });
    await waitRowKey(cdp, 'toggleWindow', '未设置');
    await waitSettingsShortcuts((shortcuts) => shortcuts.toggleWindow === '', {
      desc: 'settings.json shortcuts.toggleWindow 清空',
    });
    const state = await panelState(cdp);
    const row = rowOf(state, 'toggleWindow');
    suite.assert(row.keyEmpty, '清除后 pill 应带 is-empty（未设置）');
    suite.assert(row.status === '未设置', `清除后状态应为「未设置」，实际「${row.status}」`);
    await waitLog(/hotkey\.configured action=toggleWindow value=$/, {
      fromSize: offset,
      timeoutMs: 8000,
      desc: 'hotkey.configured action=toggleWindow value=（空）',
    });
    await waitLog(/hotkey\.register id=4 skipped action=toggleWindow reason=empty/, {
      fromSize: offset,
      timeoutMs: 8000,
      desc: 'hotkey.register id=4 skipped reason=empty',
    });
    await waitLog(/hotkey\.apply enabled=true count=3 reason=settings/, {
      fromSize: offset,
      timeoutMs: 8000,
      desc: 'hotkey.apply enabled=true count=3 reason=settings',
    });
    return 'toggleWindow 已清除；宿主 count=3';
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('总开关：关闭 → 4 行「未启用」/ settings enabled=false / 宿主 enabled=false count=0', async () => {
    const offset = hostLogSize();
    await cdp.clickText(SHORTCUTS.switchBtn, '关', { desc: '快捷键总开关「关」', timeoutMs: 6000 });
    await cdp.waitFor(
      `(() => { const field = document.querySelector(${JSON.stringify(SHORTCUTS.enabled)}); return !!field && field.dataset.enabled === 'false'; })()`,
      { desc: '总开关 data-enabled 变为 false', timeoutMs: 6000 },
    );
    await waitSettingsShortcuts((shortcuts) => shortcuts.enabled === false, {
      desc: 'settings.json shortcuts.enabled=false',
    });
    const state = await panelState(cdp);
    suite.assert(state.enabled.dataset === 'false', `总开关 data-enabled 应为 false，实际 ${state.enabled.dataset}`);
    suite.assert(!state.enabled.switchOn, '关闭后 .pill-switch 不应有 is-on');
    for (const action of SHORTCUT_ACTIONS) {
      const row = rowOf(state, action);
      suite.assert(row.status === '未启用', `关闭总开关后「${SHORTCUT_LABELS[action]}」状态应为「未启用」，实际「${row.status}」`);
      suite.assert(row.statusKind === 'muted', `关闭总开关后「${SHORTCUT_LABELS[action]}」状态 kind 应为 muted，实际「${row.statusKind}」`);
    }
    for (const id of [1, 2, 3, 4]) {
      await waitLog(new RegExp(`hotkey\\.register id=${id} skipped action=\\w+ reason=disabled`), {
        fromSize: offset,
        timeoutMs: 8000,
        desc: `hotkey.register id=${id} skipped reason=disabled`,
      });
    }
    await waitLog(/hotkey\.apply enabled=false count=0 reason=settings/, {
      fromSize: offset,
      timeoutMs: 8000,
      desc: 'hotkey.apply enabled=false count=0',
    });
    await suite.shot('shortcuts-disabled');
    return '宿主已注销全部热键（enabled=false count=0）';
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('重新开启：settings enabled=true / 宿主恢复注册（toggleWindow 为空 → count=3）', async () => {
    const offset = hostLogSize();
    await cdp.clickText(SHORTCUTS.switchBtn, '开', { desc: '快捷键总开关「开」', timeoutMs: 6000 });
    await cdp.waitFor(
      `(() => { const field = document.querySelector(${JSON.stringify(SHORTCUTS.enabled)}); return !!field && field.dataset.enabled === 'true'; })()`,
      { desc: '总开关 data-enabled 变为 true', timeoutMs: 6000 },
    );
    await waitSettingsShortcuts((shortcuts) => shortcuts.enabled === true, {
      desc: 'settings.json shortcuts.enabled=true',
    });
    await waitLog(/hotkey\.apply enabled=true count=3 reason=settings/, {
      fromSize: offset,
      timeoutMs: 8000,
      desc: 'hotkey.apply enabled=true count=3 reason=settings',
    });
    await waitLog(/hotkey\.register id=4 skipped action=toggleWindow reason=empty/, {
      fromSize: offset,
      timeoutMs: 8000,
      desc: 'toggleWindow 仍为空 → skipped reason=empty',
    });
    const state = await panelState(cdp);
    suite.assert(state.enabled.switchOn, '重新开启后 .pill-switch 应有 is-on');
    const onButton = state.enabled.buttons.find((btn) => btn.text === '开');
    suite.assert(onButton && onButton.on, '重新开启后「开」按钮应为激活态');
    suite.assert(rowOf(state, 'prev').key === 'Ctrl + Alt + U', '重新开启后 prev 应保留录制的新组合');
    return '宿主已恢复注册（count=3）';
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('恢复默认：四行回默认 / settings.json 默认 / 宿主 count=4', async () => {
    const offset = hostLogSize();
    await cdp.click(SHORTCUTS.reset, { desc: '「恢复默认」按钮', timeoutMs: 6000 });
    await waitSettingsShortcuts(isDefaultShortcuts, { desc: '恢复默认后的 settings.json' });
    await waitRowKey(cdp, 'prev', 'Ctrl + Alt + Left');
    await waitRowKey(cdp, 'toggleWindow', 'Ctrl + Alt + Z');
    await waitLog(/hotkey\.apply enabled=true count=4 reason=settings/, {
      fromSize: offset,
      timeoutMs: 8000,
      desc: 'hotkey.apply enabled=true count=4 reason=settings',
    });
    await waitLog(/hotkey\.register id=4 ok action=toggleWindow key=Ctrl\+Alt\+Z/, {
      fromSize: offset,
      timeoutMs: 8000,
      desc: 'hotkey.register id=4 ok action=toggleWindow key=Ctrl+Alt+Z',
    });
    const state = await panelState(cdp);
    const defaults = shortcutsOf(readSettingsJson());
    suite.assert(isDefaultShortcuts(defaults), `恢复默认后 settings.json 应为默认值：${JSON.stringify(defaults)}`);
    for (const action of SHORTCUT_ACTIONS) {
      const row = rowOf(state, action);
      suite.assert(
        /^Ctrl \+ Alt \+ \S+$/.test(row.key),
        `恢复默认后「${SHORTCUT_LABELS[action]}」组合展示异常：「${row.key}」`,
      );
      suite.assert(
        /^已生效$/.test(row.status) || /^已回落到 Ctrl \+ Alt \+ Shift \+ (Left|Right)$/.test(row.status),
        `恢复默认后「${SHORTCUT_LABELS[action]}」状态异常：「${row.status}」`,
      );
    }
    suite.assert(rowOf(state, 'playPause').key === 'Ctrl + Alt + Space', 'playPause 应回默认');
    suite.assert(rowOf(state, 'prev').key === 'Ctrl + Alt + Left', 'prev 应回默认');
    suite.assert(rowOf(state, 'next').key === 'Ctrl + Alt + Right', 'next 应回默认');
    suite.assert(rowOf(state, 'toggleWindow').key === 'Ctrl + Alt + Z', 'toggleWindow 应回默认');
    suite.assert(state.enabled.dataset === 'true', '恢复默认后总开关应启用');
    await suite.shot('shortcuts-reset');
    return `settings.json=${JSON.stringify(defaults)}`;
  });

  /* ---------------------------------------------------------------------- */
  await runWmHotkeyCheck(suite, cdp);

  /* ---------------------------------------------------------------------- */
  await suite.step('持久化：settings.json shortcuts 段默认值 + 重开设置页显示一致（reload 见 README §4.5）', async () => {
    const json = readSettingsJson();
    suite.assert(json && json.shortcuts, `settings.json 缺少 shortcuts 段：${SETTINGS_JSON}`);
    suite.assert(isDefaultShortcuts(json.shortcuts), `settings.json shortcuts 应为默认值：${JSON.stringify(json.shortcuts)}`);
    // 关掉设置弹窗再重新打开：走一遍 render（页面 reload 有已知卡死风险，不自动化）。
    await pressEscape(cdp);
    await cdp.waitFor(`document.querySelectorAll('.settings-layout').length === 0`, {
      desc: '设置弹窗关闭',
      timeoutMs: 6000,
    });
    await openSettingsPane(cdp, SHORTCUTS.navLabel);
    await cdp.waitFor(`!!document.querySelector(${JSON.stringify(SHORTCUTS.section)})`, {
      desc: '重开后快捷键设置区',
      timeoutMs: 8000,
    });
    const state = await panelState(cdp);
    for (const action of SHORTCUT_ACTIONS) {
      const row = rowOf(state, action);
      const expected = SHORTCUT_DEFAULTS[action].split('+').join(' + ');
      suite.assert(
        row.key === expected,
        `重开后「${SHORTCUT_LABELS[action]}」应显示 ${expected}，实际「${row.key}」`,
      );
      suite.assert(
        row.statusKind === 'ok' || row.statusKind === 'warn',
        `重开后「${SHORTCUT_LABELS[action]}」状态异常：「${row.status}」`,
      );
    }
    suite.assert(rowOf(state, 'toggleWindow').key === 'Ctrl + Alt + Z', '重开后 toggleWindow 显示应为默认组合');
    suite.note('页面 reload 后的一致性未自动化（Page.reload 偶发卡死），README §4.5 有手工步骤');
    return 'settings.json 持久化默认值；重开面板显示一致';
  });

  /* ---------------------------------------------------------------------- */
  await suite.step('收尾：恢复默认 / 关闭面板回首页 / console 0 error', async () => {
    const json = readSettingsJson();
    if (!isDefaultShortcuts(shortcutsOf(json))) {
      await ensureDefaults(cdp, suite);
    }
    const state = await panelState(cdp);
    if (state.enabled && state.enabled.dataset !== 'true') {
      await cdp.clickText(SHORTCUTS.switchBtn, '开', { desc: '收尾恢复快捷键开关', timeoutMs: 6000 });
    }
    await closeOverlays(cdp);
    await goHome(cdp);
    const clean = await cdp.eval(`(() => ({
      home: !!document.querySelector('.home-host:not(.is-hidden) .ui-page.home'),
      sheets: document.querySelectorAll('.sheet').length,
      quick: document.querySelectorAll('.quick.is-open').length,
    }))()`);
    suite.assert(clean.home, '收尾后应回到首页');
    suite.assert(clean.sheets === 0, `收尾后不应有弹窗，实际 ${clean.sheets}`);
    suite.assert(clean.quick === 0, '收尾后快捷设置应关闭');
    const errors = cdp.takeConsoleErrors();
    suite.assert(
      errors.length === 0,
      `收尾时 console/未捕获错误应为 0，实际 ${errors.length} 条：\n${errors
        .slice(0, 6)
        .map((item) => `[${item.kind}] ${item.text}`)
        .join('\n')}\nhost.log 尾部：\n${hostLogTail(12)}`,
    );
    return `默认快捷键已恢复；弹窗 0；console 0`;
  });
});
