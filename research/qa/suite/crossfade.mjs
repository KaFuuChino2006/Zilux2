/**
 * Zilux2 QA 套件 —— B 版 Phase 1「无缝衔接（crossfade）」回归（task-20）。
 *
 * 覆盖：
 *   1. 设置 → 播放页存在 `[data-qa="crossfade-section"]`；开关/时长选项（data-length=3|5|8|10|15|20|30|auto）与
 *      localStorage `zilux2.crossfade` 双向一致。
 *   2. 时长切换（5/7/10/auto）与开关切换：localStorage、UI（aria-pressed/文本）、调试快照三处同步。
 *   3. 播放链路（task-23）：本地曲库首曲播放后分析成功 → window.__ziluxCrossfade 进入 prepared；
 *      断言 web 按宿主 p0-4 的「可听结尾」调度：`fadeStartPosMs + fadeMs ≈ currentAudibleEndMs`（±200ms）、
 *      `currentAudibleEndMs <= durationMs`，并按尾部静音断言 `tailSilenceMs > 0` 且
 *      `fadeStartPosMs + fadeMs < durationMs - 500`；prepared 事件 detail 含「可听结尾」「尾部静音」。
 *      鼠标 seek 到淡化起点（每首 96.5%~98.5% 之间的实时计算位置）→ phase 经历 prepared→fading→done，
 *      事件出现 fade-start / fade-done，播放器自动切到下一首且继续播放。
 *   4. 关闭开关后：同样 seek 到曲尾 → 普通硬切（phase 不再进入 prepared/fading、无 fade-start/fade-done 事件），
 *      曲目正常推进到下一首。
 *   5. 收藏歌单路径（task-23）：rail「我喜欢的音乐」→ 首曲播放 → prepared → seek → 自动切下一首并继续播放；
 *      在线源/网络不可用时记 SKIP（环境限制），不伪造通过。
 *   6. 收尾：恢复进入套件时的 crossfade 设置基线，回首页、关面板、console error 0。
 *
 * 注意：
 *   - 本套件会真实播放本地曲库/收藏歌单，并在结束时停留在新的曲目上（播放队列被切到本地曲库第 1 首起）；
 *     若进入时是暂停状态，收尾会恢复暂停。
 *   - 页面刷新后的设置保持（tasks 要求「刷新后保持」）没有自动化：Page.reload 在 WebView2 偶发卡死
 *     （见 HANDOFF §4），README §8 里记录了人工复核步骤；这里用「关设置再重开 + localStorage」验证。
 *   - 依赖 window.__ziluxCrossfade（web/src/ui/crossfadeDeck.ts exposeDebug）与本地曲库 ≥2 首。
 */
import { runSuite, sleep } from './lib/cdp.mjs';
import { clickRail, closeOverlays, goHome, openSettingsPane, readLocalStorage } from './lib/ui.mjs';
import { CROSSFADE, CROSSFADE_TRIGGER_TIMEOUT_MS, PLAYERBAR_HOVER, LOCAL_FOLDER_KEY } from './lib/fixtures.mjs';

const LOCAL_RAIL = '本地曲库';
const FAVORITES_RAIL = '我喜欢的音乐';
/** 封面显示偏好（app 的 posterLayout.ts 共用这一份 localStorage）。 */
const POSTER_LAYOUT_KEY = 'zilux2.posterLayout';
const LENGTH_LABELS = {
  auto: '自动',
  3: '3 秒',
  5: '5 秒',
  8: '8 秒',
  10: '10 秒',
  15: '15 秒',
  20: '20 秒',
  30: '30 秒',
};
/** task-23：web 按宿主 p0-4 的 audibleEndMs 调度淡化，fadeStartPosMs + fadeMs 应等于可听结尾（±200ms）。 */
const AUDIBLE_END_TOLERANCE_MS = 200;

/** 标记「环境限制」类失败：在线源/网络不可用时记 SKIP 而不是 FAIL。 */
function envError(message) {
  return Object.assign(new Error(`[ENV] ${message}`), { env: true });
}

/* ------------------------------------------------------------------ */
/* 页面内读取                                                          */
/* ------------------------------------------------------------------ */

async function readSettingsStorage(cdp) {
  const raw = await readLocalStorage(cdp, CROSSFADE.storageKey);
  if (raw == null) return { raw: null, value: { ...CROSSFADE.defaults }, missing: true };
  try {
    const parsed = JSON.parse(raw);
    const enabled = typeof parsed.enabled === 'boolean' ? parsed.enabled : CROSSFADE.defaults.enabled;
    // 时长在 localStorage 里是数字（3/5/...）或 'auto'，fixtures 用字符串档位；统一成字符串比较。
    const parsedLength = String(parsed.length);
    const length = CROSSFADE.lengths.includes(parsedLength) ? parsedLength : CROSSFADE.defaults.length;
    return { raw, value: { enabled, length }, missing: false };
  } catch (err) {
    return { raw, value: null, missing: false, parseError: String(err && err.message ? err.message : err) };
  }
}

function pageSettingsUi(cdp) {
  return cdp.eval(`(() => {
    const sec = document.querySelector(${JSON.stringify(CROSSFADE.section)});
    if (!sec) {
      return { exists: false, sectionTitles: Array.from(document.querySelectorAll('.settings-content .section-title')).map((n) => (n.textContent || '').trim()) };
    }
    const title = sec.querySelector('.section-title');
    const toggle = sec.querySelector(${JSON.stringify(CROSSFADE.toggle)});
    const lengths = Array.from(sec.querySelectorAll('[data-qa="crossfade-length"]')).map((b) => ({
      length: b.dataset.length || '',
      text: (b.textContent || '').trim(),
      pressed: b.getAttribute('aria-pressed'),
      on: b.classList.contains('is-on'),
    }));
    const rect = sec.getBoundingClientRect();
    return {
      exists: true,
      title: title ? (title.textContent || '').trim() : '',
      datasetEnabled: sec.dataset.enabled || '',
      toggle: toggle
        ? { text: (toggle.textContent || '').trim(), pressed: toggle.getAttribute('aria-pressed'), on: toggle.classList.contains('is-on') }
        : null,
      lengths,
      top: Math.round(rect.top),
      height: Math.round(rect.height),
    };
  })()`);
}

function pageDebugState(cdp) {
  return cdp.eval(`(() => {
    const d = window.__ziluxCrossfade;
    if (!d) return { missing: true };
    const s = d.snapshot();
    return {
      missing: false,
      phase: s.phase,
      enabled: s.enabled,
      length: s.length,
      reason: s.reason,
      currentTitle: s.currentTitle,
      nextTitle: s.nextTitle,
      fadeStartPosMs: s.fadeStartPosMs,
      fadeMs: s.fadeMs,
      currentAudibleEndMs: s.currentAudibleEndMs,
      tailSilenceMs: s.tailSilenceMs,
      progress: s.progress,
      baseVolume: s.baseVolume,
      events: s.events.map((e) => ({ at: e.at, event: e.event, detail: e.detail })),
      settings: d.settings ? d.settings() : null,
    };
  })()`);
}

function pagePlayerState(cdp) {
  return cdp.eval(`(() => {
    const p = window.__ziluxPlayer && window.__ziluxPlayer();
    if (!p) return { missing: true };
    return {
      missing: false,
      title: p.track ? p.track.title || '' : '',
      artist: p.track ? p.track.artist || '' : '',
      playing: !!p.playing,
      positionMs: p.positionMs,
      durationMs: p.durationMs,
      mode: p.mode,
      index: p.index,
      queueLen: p.queue ? p.queue.length : 0,
    };
  })()`);
}

function pageWallRows(cdp, count = 3) {
  return cdp.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('.wall .track-row')).slice(0, ${count});
    return rows.map((r) => ({
      key: r.dataset.trackKey || '',
      title: ((r.querySelector('.track-title') || {}).textContent || '').trim(),
      artist: ((r.querySelector('.track-artist') || {}).textContent || '').trim(),
    }));
  })()`);
}

/** 等 localStorage 里的 crossfade 设置满足条件。 */
function waitSettingsStorage(cdp, accept, desc, timeoutMs = 8000) {
  return cdp.waitFor(
    `(() => {
      try {
        const raw = localStorage.getItem(${JSON.stringify(CROSSFADE.storageKey)});
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return { enabled: parsed.enabled, length: String(parsed.length) };
      } catch (e) {
        return null;
      }
    })()`,
    { desc, timeoutMs, intervalMs: 100, accept },
  );
}

/** 等调试快照满足条件。 */
function waitDebug(cdp, accept, desc, timeoutMs = 10000) {
  return cdp.waitFor(`(() => { const d = window.__ziluxCrossfade; if (!d) return null; const s = d.snapshot(); return s; })()`, {
    desc,
    timeoutMs,
    intervalMs: 120,
    accept,
  });
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */

async function clickInSettings(cdp, selector, desc) {
  await cdp.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, {
    desc: `设置页元素存在：${desc}`,
    timeoutMs: 6000,
    intervalMs: 100,
  });
  await cdp.click(selector, { desc });
  await sleep(260);
}

/** 悬停播放条：先等 .playerbar .track 展开，再等宽度稳定（展开动画结束）后才返回 rect，避免用动画中尺寸算 seek。 */
async function hoverPlayerbar(cdp) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: PLAYERBAR_HOVER.x, y: PLAYERBAR_HOVER.y, button: 'none' });
  const grab = () =>
    cdp.eval(`(() => {
      const t = document.querySelector('.playerbar .track');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return r.width > 100 && r.height > 4 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
    })()`);
  let prev = null;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const cur = await grab();
    if (cur && prev && Math.abs(cur.w - prev.w) < 1 && Math.abs(cur.x - prev.x) < 1) return cur;
    prev = cur;
    await sleep(120);
  }
  return cdp.waitFor(
    `(() => {
      const t = document.querySelector('.playerbar .track');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return r.width > 100 && r.height > 4 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
    })()`,
    { desc: '播放条进度条展开（.playerbar .track 可见）', timeoutMs: 3000, intervalMs: 100 },
  );
}

/** 在播放条进度条上按比例 seek（真实鼠标事件：mousePressed + mouseReleased）。 */
async function seekByMouse(cdp, fraction) {
  const rect = await hoverPlayerbar(cdp);
  const x = Math.round(rect.x + rect.w * fraction);
  const y = Math.round(rect.y + rect.h / 2);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return { x, y, rect, fraction };
}

/** 通过宿主命令通道切换播放/暂停（tray/shortcuts 同款通道）。 */
async function dispatchHostCommand(cdp, action) {
  return cdp.eval(
    `window.chrome.webview.dispatchEvent(new MessageEvent('message', { data: { v: 1, type: 'command', action: ${JSON.stringify(action)} } })); true`,
  );
}

/** 关掉所有可能挡路的弹层（设置 sheet / quick / login / 下载面板）。 */
async function closeAllLayers(cdp) {
  await closeOverlays(cdp);
  await cdp
    .eval(`(() => {
      const panel = document.querySelector('.dlq-panel.is-open');
      if (panel) {
        const close = panel.querySelector('.dlq-close');
        if (close) close.click();
      }
      return true;
    })()`)
    .catch(() => {});
  await sleep(200);
}

async function ensurePlaying(cdp) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await pagePlayerState(cdp);
    if (state.playing) return state;
    await sleep(200);
  }
  return pagePlayerState(cdp);
}

/* ------------------------------------------------------------------ */
/* 套件主体                                                            */
/* ------------------------------------------------------------------ */

await runSuite('crossfade', '无缝衔接（crossfade 设置 + 播放交叉淡化 + 关闭后硬切）', async (suite) => {
  const cdp = suite.cdp;
  let baselineStorage = { enabled: true, length: 'auto' };
  let baselinePlayer = { playing: false };
  let baselineLayout = 'grid';
  let localReady = false;
  let firstTitle = '';
  let secondTitle = '';

  /* ---------------- 1. 准备：本地曲库 + 基线设置 ---------------- */
  await suite.step('准备：读 crossfade 基线设置 + 本地曲库就绪（≥2 首）', async () => {
    await closeAllLayers(cdp);
    await goHome(cdp);
    baselineLayout = (await readLocalStorage(cdp, POSTER_LAYOUT_KEY)) || 'grid';
    await clickRail(cdp, LOCAL_RAIL, { settleMs: 900 });
    // 本地曲库默认可能是「网格」封面布局（用户偏好持久化在 zilux2.posterLayout），
    // 而本套件与 fixtures 都基于横条列表的 .track-row；先确保切到「横条」再等行。
    await cdp.eval(`(() => {
      const rows = document.querySelectorAll('.wall .track-row').length;
      if (rows >= 2) return rows;
      const btn = Array.from(document.querySelectorAll('.layout-modes .seg-btn')).find((b) => (b.textContent || '').trim() === '横条');
      if (btn) { btn.click(); return 'clicked'; }
      return 'no-layout-seg';
    })()`);
    await cdp.waitFor(
      `(() => { const wall = document.querySelector('.wall'); const rows = document.querySelectorAll('.wall .track-row').length; return wall && !wall.classList.contains('is-hidden') && rows >= 2 ? rows : null; })()`,
      { desc: '本地曲库墙体 ≥2 行', timeoutMs: 25000, intervalMs: 200 },
    );
    const rows = await pageWallRows(cdp, 3);
    suite.assert(rows.length >= 2, `本地曲库不足 2 首（实际 ${rows.length}）`);
    firstTitle = rows[0].title;
    secondTitle = rows[1].title;
    suite.assert(firstTitle.length > 0 && secondTitle.length > 0, `本地曲库标题为空：${JSON.stringify(rows)}`);

    const storage = await readSettingsStorage(cdp);
    suite.assert(storage.value !== null, `localStorage.${CROSSFADE.storageKey} 不是合法 JSON：${String(storage.raw).slice(0, 200)}`);
    baselineStorage = { ...storage.value };
    baselinePlayer = await pagePlayerState(cdp);
    const folder = await readLocalStorage(cdp, LOCAL_FOLDER_KEY);
    const debug = await pageDebugState(cdp);
    suite.assert(!debug.missing, 'window.__ziluxCrossfade 不存在（调试接口缺失）');
    suite.assert(debug.settings && debug.settings.enabled === baselineStorage.enabled, `调试接口 settings() 与 localStorage 不一致：${JSON.stringify(debug.settings)}`);
    localReady = true;
    return `本地曲库 ${rows.length} 首（${firstTitle} → ${secondTitle}），folder=${folder || 'null'}，基线 ${JSON.stringify(baselineStorage)}，播放中=${baselinePlayer.playing}`;
  });

  if (!localReady) {
    suite.skip('crossfade 设置 / 播放链路', '本地曲库不可用，无法继续（见准备步骤失败证据）');
    return;
  }

  /* ---------------- 2. 设置页区块结构 ---------------- */
  await suite.step('设置→播放：无缝衔接区块结构 + 与 localStorage 一致', async () => {
    await openSettingsPane(cdp, '播放');
    await cdp.waitFor(`!!document.querySelector(${JSON.stringify(CROSSFADE.section)})`, {
      desc: 'crossfade-section 出现在播放页',
      timeoutMs: 8000,
      intervalMs: 120,
    });
    const ui = await pageSettingsUi(cdp);
    suite.assert(ui.exists, 'crossfade-section 不存在');
    suite.assert(ui.title === '无缝衔接（实验）', `区块标题不符：${JSON.stringify(ui.title)}`);
    suite.assert(ui.toggle !== null, 'crossfade-toggle 不存在');
    const storage = await readSettingsStorage(cdp);
    suite.assert(storage.value !== null, 'localStorage 设置不是合法 JSON');
    suite.assert(ui.toggle.text === (storage.value.enabled ? '已开启' : '已关闭'), `开关文本与设置不一致：UI「${ui.toggle.text}」vs enabled=${storage.value.enabled}`);
    suite.assert(ui.toggle.pressed === String(storage.value.enabled), `开关 aria-pressed=${ui.toggle.pressed} 与 enabled=${storage.value.enabled} 不一致`);
    suite.assert(ui.datasetEnabled === (storage.value.enabled ? '1' : '0'), `section data-enabled=${ui.datasetEnabled} 与 enabled 不一致`);
    const seen = ui.lengths.map((item) => item.length).sort();
    const want = [...CROSSFADE.lengths].sort();
    suite.assert(JSON.stringify(seen) === JSON.stringify(want), `时长选项 data-length 不符：${JSON.stringify(seen)}，期望 ${JSON.stringify(want)}`);
    for (const item of ui.lengths) {
      suite.assert(item.text === LENGTH_LABELS[item.length], `时长「${item.length}」按钮文案不符：${JSON.stringify(item.text)}`);
      suite.assert(item.pressed === String(item.length === storage.value.length), `时长「${item.length}」aria-pressed=${item.pressed} 与当前 ${storage.value.length} 不一致`);
    }
    await suite.shot('crossfade-settings');
    return `区块「${ui.title}」开关「${ui.toggle.text}」，4 个时长选项 ${JSON.stringify(seen)}，与 localStorage ${JSON.stringify(storage.value)} 一致`;
  });

  /* ---------------- 3. 时长切换 ---------------- */
  await suite.step('时长切换：4 / 6 / 8 / 自动 均写入 localStorage 且 UI/快照同步', async () => {
    const observed = [];
    for (const value of CROSSFADE.lengths) {
      await clickInSettings(cdp, CROSSFADE.lengthOption(value), `时长选项「${LENGTH_LABELS[value]}」`);
      await waitSettingsStorage(cdp, (v) => v && v.length === value, `localStorage.length === "${value}"`, 6000);
      // UI 重绘由 zilux:crossfade 事件驱动，等 aria-pressed 稳定。
      await cdp.waitFor(
        `(() => {
          const btn = document.querySelector(${JSON.stringify(CROSSFADE.lengthOption(value))});
          return btn && btn.getAttribute('aria-pressed') === 'true' && btn.classList.contains('is-on');
        })()`,
        { desc: `时长「${value}」按钮 aria-pressed=true/is-on`, timeoutMs: 4000, intervalMs: 80 },
      );
      const others = await cdp.eval(
        `Array.from(document.querySelectorAll('[data-qa="crossfade-length"]')).filter((b) => b.dataset.length !== ${JSON.stringify(value)}).map((b) => b.getAttribute('aria-pressed'))`,
      );
      suite.assert(others.every((pressed) => pressed === 'false'), `切换「${value}」后其它选项 aria-pressed 未复位：${JSON.stringify(others)}`);
      const debug = await pageDebugState(cdp);
      suite.assert(String(debug.length) === String(value), `调试快照 length=${debug.length} 与 UI「${value}」不一致`);
      observed.push(value);
    }
    // 回到基线时长，后面播放链路用基线的 auto/固定值。
    await clickInSettings(cdp, CROSSFADE.lengthOption(baselineStorage.length), `恢复基线时长「${LENGTH_LABELS[baselineStorage.length]}」`);
    await waitSettingsStorage(cdp, (v) => v && v.length === baselineStorage.length, 'localStorage.length 恢复基线', 6000);
    return `依次切换 ${observed.join(' → ')} 均落盘并同步 UI/快照，已恢复基线 ${baselineStorage.length}`;
  });

  /* ---------------- 4. 开关关闭 / 开启 ---------------- */
  await suite.step('开关：关闭/开启写 localStorage，UI aria-pressed 与调试快照同步', async () => {
    // 关闭
    if ((await readSettingsStorage(cdp)).value.enabled) {
      await clickInSettings(cdp, CROSSFADE.toggle, '无缝衔接开关（关闭）');
    }
    await waitSettingsStorage(cdp, (v) => v && v.enabled === false, 'localStorage.enabled === false', 6000);
    let ui = await pageSettingsUi(cdp);
    let debug = await pageDebugState(cdp);
    suite.assert(ui.toggle.text === '已关闭', `关闭后开关文本：${JSON.stringify(ui.toggle.text)}`);
    suite.assert(ui.toggle.pressed === 'false', `关闭后 aria-pressed=${ui.toggle.pressed}`);
    suite.assert(ui.datasetEnabled === '0', `关闭后 section data-enabled=${ui.datasetEnabled}`);
    suite.assert(debug.enabled === false, `关闭后调试快照 enabled=${debug.enabled}`);
    suite.assert(debug.settings && debug.settings.enabled === false, `关闭后 debug.settings()=${JSON.stringify(debug.settings)}`);
    await suite.shot('crossfade-toggle-off');

    // 再打开
    await clickInSettings(cdp, CROSSFADE.toggle, '无缝衔接开关（开启）');
    await waitSettingsStorage(cdp, (v) => v && v.enabled === true, 'localStorage.enabled === true', 6000);
    ui = await pageSettingsUi(cdp);
    debug = await pageDebugState(cdp);
    suite.assert(ui.toggle.text === '已开启', `开启后开关文本：${JSON.stringify(ui.toggle.text)}`);
    suite.assert(ui.toggle.pressed === 'true', `开启后 aria-pressed=${ui.toggle.pressed}`);
    suite.assert(ui.datasetEnabled === '1', `开启后 section data-enabled=${ui.datasetEnabled}`);
    suite.assert(debug.enabled === true, `开启后调试快照 enabled=${debug.enabled}`);
    await suite.shot('crossfade-toggle-on');
    return '关闭→enabled=false（UI/aria/data-enabled/快照一致）；开启→enabled=true 已恢复';
  });

  /* ---------------- 5. 播放准备 ---------------- */
  await suite.step('播放准备：本地曲库首曲播放后进入 prepared（awaits 分析成功）', async () => {
    await closeAllLayers(cdp);
    await clickRail(cdp, LOCAL_RAIL, { settleMs: 900 });
    await cdp.waitFor(`document.querySelectorAll('.wall .track-row').length >= 2`, { desc: '本地曲库 ≥2 行', timeoutMs: 20000, intervalMs: 200 });
    const rows = await pageWallRows(cdp, 3);
    suite.assert(rows[0].title === firstTitle, `本地曲库首行变化：${rows[0].title} vs ${firstTitle}`);
    await cdp.eval(`(() => { const row = document.querySelector('.wall .track-row'); if (!row) return false; row.click(); return true; })()`);
    await cdp.waitFor(
      // 注意：不要返回 p.index（首曲 index=0 是 falsy，waitFor 会永远不满足）。
      `(() => { const p = window.__ziluxPlayer && window.__ziluxPlayer(); return !!(p && p.playing && p.track && p.track.title === ${JSON.stringify(firstTitle)}) || null; })()`,
      { desc: `开始播放「${firstTitle}」`, timeoutMs: 20000, intervalMs: 150 },
    );
    let prepared = await waitDebug(
      cdp,
      (s) => s && s.phase === 'prepared' && s.currentTitle === firstTitle && !!s.nextTitle,
      `crossfade 进入 prepared（「${firstTitle}」→下一首）`,
      CROSSFADE_TRIGGER_TIMEOUT_MS,
    );
    // task-23：本轮断言需要「有尾部静音的曲目」。本机本地曲库正常都有（host.log analysis.done 里
    // tailSilenceMs>0）；若首曲恰好没有尾部静音，顺延换下一首，避免把测试数据问题误判为产品 bug。
    if (!(Number.isFinite(prepared.tailSilenceMs) && prepared.tailSilenceMs > 0)) {
      const fallbackRows = await pageWallRows(cdp, 4);
      let found = false;
      for (let i = 1; i < fallbackRows.length && !found; i += 1) {
        const row = fallbackRows[i];
        await cdp.eval(`(() => { const r = document.querySelectorAll('.wall .track-row')[${i}]; if (!r) return false; r.click(); return true; })()`);
        await cdp
          .waitFor(
            `(() => { const p = window.__ziluxPlayer && window.__ziluxPlayer(); return !!(p && p.playing && p.track && p.track.title === ${JSON.stringify(row.title)}) || null; })()`,
            { desc: `切换播放「${row.title}」`, timeoutMs: 20000, intervalMs: 150 },
          )
          .catch(() => null);
        const candidate = await waitDebug(
          cdp,
          (s) => s && s.phase === 'prepared' && s.currentTitle === row.title && s.tailSilenceMs > 0,
          `「${row.title}」进入 prepared（tailSilenceMs>0）`,
          CROSSFADE_TRIGGER_TIMEOUT_MS,
        ).catch(() => null);
        if (candidate) {
          prepared = candidate;
          firstTitle = row.title;
          if (fallbackRows[i + 1]) secondTitle = fallbackRows[i + 1].title;
          found = true;
          suite.note(`首曲无尾部静音，改用本地第 ${i + 1} 行「${firstTitle}」（tailSilenceMs=${Math.round(prepared.tailSilenceMs)}）`);
        }
      }
      suite.assert(found, `本地曲库前 ${fallbackRows.length} 行都没有检测到尾部静音（tailSilenceMs>0），无法验证尾部静音断言`);
    }
    suite.note(
      `prepared：${prepared.currentTitle} → ${prepared.nextTitle}，fadeStartPosMs=${Math.round(prepared.fadeStartPosMs)}，` +
        `fadeMs=${Math.round(prepared.fadeMs)}，currentAudibleEndMs=${Math.round(prepared.currentAudibleEndMs)}，tailSilenceMs=${Math.round(prepared.tailSilenceMs)}`,
    );
    suite.assert(prepared.nextTitle === secondTitle, `预加载的下一首「${prepared.nextTitle}」与本地曲库第二行「${secondTitle}」不一致`);
    suite.assert(prepared.fadeStartPosMs > 0, `fadeStartPosMs=${prepared.fadeStartPosMs} 应为正数`);
    suite.assert(prepared.fadeMs >= 1000, `fadeMs=${prepared.fadeMs} 过短（产品下限 1200ms）`);
    suite.assert(prepared.enabled === true && String(prepared.length) === String(baselineStorage.length), `快照设置不符：enabled=${prepared.enabled} length=${prepared.length}`);
    const player = await ensurePlaying(cdp);
    suite.assert(player.title === firstTitle && player.playing, `播放状态异常：${JSON.stringify(player)}`);

    // ---- task-23 新增：按可听结尾（audibleEndMs）调度 + 尾部静音断言 ----
    suite.assert(Number.isFinite(prepared.currentAudibleEndMs) && prepared.currentAudibleEndMs > 0, `快照缺少 currentAudibleEndMs：${JSON.stringify(prepared.currentAudibleEndMs)}（宿主 p0-4 应上报 audibleEndMs）`);
    suite.assert(Number.isFinite(prepared.tailSilenceMs) && prepared.tailSilenceMs > 0, `快照 tailSilenceMs=${JSON.stringify(prepared.tailSilenceMs)} 应为正数（本机本地曲目有尾部静音）`);
    suite.assert(prepared.currentAudibleEndMs <= player.durationMs + 1, `currentAudibleEndMs=${Math.round(prepared.currentAudibleEndMs)} 超过 durationMs=${Math.round(player.durationMs)}`);
    const planDelta = Math.abs(prepared.fadeStartPosMs + prepared.fadeMs - prepared.currentAudibleEndMs);
    suite.assert(
      planDelta <= AUDIBLE_END_TOLERANCE_MS,
      `调度公式偏差 ${Math.round(planDelta)}ms > ±${AUDIBLE_END_TOLERANCE_MS}ms（fadeStart=${Math.round(prepared.fadeStartPosMs)} + fadeMs=${Math.round(prepared.fadeMs)} vs 可听结尾=${Math.round(prepared.currentAudibleEndMs)}）`,
    );
    suite.assert(
      prepared.fadeStartPosMs + prepared.fadeMs < player.durationMs - 500,
      `淡化结束点 ${Math.round(prepared.fadeStartPosMs + prepared.fadeMs)}ms 未早于曲尾 ${Math.round(player.durationMs)}ms 前 500ms（尾部静音 ${Math.round(prepared.tailSilenceMs)}ms）`,
    );
    const preparedEvents = (prepared.events || []).filter((e) => e.event === 'prepared');
    const lastPreparedEv = preparedEvents[preparedEvents.length - 1];
    suite.assert(!!lastPreparedEv && /可听结尾/.test(lastPreparedEv.detail || ''), `prepared 事件 detail 缺少「可听结尾」：${JSON.stringify(lastPreparedEv && lastPreparedEv.detail)}`);
    suite.assert(!!lastPreparedEv && /尾部静音/.test(lastPreparedEv.detail || ''), `prepared 事件 detail 缺少「尾部静音」：${JSON.stringify(lastPreparedEv && lastPreparedEv.detail)}`);
    return `prepared「${firstTitle}」→「${secondTitle}」，fade ${Math.round(prepared.fadeMs)}ms，起点 ${Math.round(prepared.fadeStartPosMs)}ms，可听结尾 ${Math.round(prepared.currentAudibleEndMs)}ms（尾部静音 ${Math.round(prepared.tailSilenceMs)}ms，公式偏差 ${Math.round(planDelta)}ms）`;
  });

  /* ---------------- 6. 触发交叉淡化 ---------------- */
  await suite.step('触发交叉淡化：seek 到淡化点 → prepared→fading→done，自动切到下一首', async () => {
    const before = await pageDebugState(cdp);
    suite.assert(before.phase === 'prepared', `触发前 phase=${before.phase}（期望 prepared）`);
    // task-23：触发前再次核对调度基准 = 可听结尾（宿主 p0-4 的 audibleEndMs，不是文件总长）。
    suite.assert(Number.isFinite(before.currentAudibleEndMs) && before.currentAudibleEndMs > 0, `触发前快照缺少 currentAudibleEndMs：${JSON.stringify(before.currentAudibleEndMs)}`);
    const triggerDelta = Math.abs(before.fadeStartPosMs + before.fadeMs - before.currentAudibleEndMs);
    suite.assert(triggerDelta <= AUDIBLE_END_TOLERANCE_MS, `触发前调度公式偏差 ${Math.round(triggerDelta)}ms > ±${AUDIBLE_END_TOLERANCE_MS}ms（fadeStart+${Math.round(before.fadeMs)} vs ${Math.round(before.currentAudibleEndMs)}）`);
    // 注意：调试事件数组有 40 条上限并会跨用例/跨运行累积，不能按长度切片；
    // 页面和 Node 同一台机器但时钟仍有 ±ms 抖动，用「事件键集合」做差集抓本次新事件最稳。
    const knownEvents = new Set(before.events.map((e) => `${e.at}|${e.event}`));
    const player = await pagePlayerState(cdp);
    suite.assert(player.durationMs > 0, `播放器 durationMs=${player.durationMs} 无法计算 seek 目标`);
    const fraction = Math.min(0.985, Math.max(0.9, (before.fadeStartPosMs + 250) / player.durationMs));
    const seek = await seekByMouse(cdp, fraction);
    suite.note(
      `seek 到 ${(fraction * 100).toFixed(1)}%（x=${seek.x}, y=${seek.y}），目标淡化起点 ${Math.round(before.fadeStartPosMs)}ms / 可听结尾 ${Math.round(before.currentAudibleEndMs)}ms / 总长 ${Math.round(player.durationMs)}ms`,
    );
    // seek 后应在 ~1s 内跳到曲尾附近（若 seek 事件处理稍慢，最多等 5s）。
    const target = await pagePlayerState(cdp);
    const duration = target.durationMs > 0 ? target.durationMs : player.durationMs;
    const seekOk = await cdp
      .waitFor(
        `(() => { const p = window.__ziluxPlayer && window.__ziluxPlayer(); if (!p) return null; return p.positionMs > ${JSON.stringify(duration)} * 0.85 ? p.positionMs : null; })()`,
        { desc: 'seek 后播放位置跳到曲尾附近', timeoutMs: 5000, intervalMs: 100 },
      )
      .catch(() => null);
    suite.assert(seekOk !== null, `seek 未生效：position 仍不在曲尾附近（duration=${Math.round(duration)}）`);
    const actualFraction = Number(seekOk) / duration;
    suite.assert(
      Math.abs(actualFraction - fraction) <= 0.06,
      `seek 落点 ${(actualFraction * 100).toFixed(1)}% 与目标 ${(fraction * 100).toFixed(1)}% 偏差 >6%（鼠标可能点到进度条外或播放条动画未完成）`,
    );

    const phases = [];
    const started = Date.now();
    let switchedState = null;
    let midProgress = null;
    while (Date.now() - started < CROSSFADE_TRIGGER_TIMEOUT_MS) {
      const snapshot = await pageDebugState(cdp);
      const state = await pagePlayerState(cdp);
      const key = `${snapshot.phase}|${state.title}|${state.playing}`;
      if (phases.length === 0 || phases[phases.length - 1].key !== key) {
        phases.push({ key, t: Date.now() - started, phase: snapshot.phase, title: state.title, playing: state.playing, progress: Number((snapshot.progress || 0).toFixed(3)) });
      }
      if (snapshot.phase === 'fading' && snapshot.progress > 0 && snapshot.progress < 1) {
        midProgress = snapshot.progress;
      }
      // 交换 deck 后 player 可能立刻又准备了下一对（phase 从 done 回到 prepared），
      // 所以以「切到下一首且继续播放」作为完成信号，再回头核对事件。
      if (state.title === before.nextTitle && state.playing) {
        switchedState = { snapshot, state };
        break;
      }
      await sleep(90);
    }
    suite.assert(switchedState !== null, `交叉淡化未在 ${CROSSFADE_TRIGGER_TIMEOUT_MS}ms 内切换曲目，phase=${(await pageDebugState(cdp)).phase}`);
    const elapsed = Date.now() - started;
    const after = await pageDebugState(cdp);
    const newEvents = after.events.filter((e) => !knownEvents.has(`${e.at}|${e.event}`));
    const eventsAfter = newEvents.map((e) => e.event);
    suite.assert(eventsAfter.includes('fade-start'), `事件缺少 fade-start（本次事件：${JSON.stringify(eventsAfter)}）`);
    suite.assert(eventsAfter.includes('fade-done'), `事件缺少 fade-done：${JSON.stringify(eventsAfter)}`);
    const fadingSeen = phases.some((p) => p.phase === 'fading');
    suite.assert(fadingSeen, `轮询没有观测到 fading 相位（相位轨迹：${JSON.stringify(phases.map((p) => p.phase))}）`);
    suite.assert(midProgress !== null && midProgress > 0 && midProgress < 1, `没有采到淡化中间进度（midProgress=${midProgress}）`);
    const finalPlayer = await pagePlayerState(cdp);
    suite.assert(finalPlayer.title === before.nextTitle, `切换后曲目「${finalPlayer.title}」≠「${before.nextTitle}」`);
    suite.assert(finalPlayer.playing === true, `切换后未继续播放：${JSON.stringify(finalPlayer)}`);
    suite.assert(finalPlayer.index > 0 || finalPlayer.queueLen > 1, `播放队列索引异常：${JSON.stringify(finalPlayer)}`);
    // Lead 实测「prepared → fade-start → fade-done」整段 < 15s；本步骤的 elapsed 还包含
    // seek 之后取消/重新分析的延迟（偶发 10s 左右），所以用「淡化链事件时长」严格断言，elapsed 只做上限兜底。
    const fadeStartEv = newEvents.find((e) => e.event === 'fade-start');
    const fadeDoneEv = newEvents.find((e) => e.event === 'fade-done');
    suite.assert(fadeStartEv && fadeDoneEv && fadeDoneEv.at >= fadeStartEv.at, '事件里缺少可配对的 fade-start / fade-done');
    const fadeChainMs = fadeDoneEv.at - fadeStartEv.at;
    suite.assert(fadeChainMs > 1200 && fadeChainMs < 12000, `淡化链时长 ${fadeChainMs}ms 超出 1.2s~12s 合理区间`);
    suite.assert(elapsed < 20000, `交叉淡化全过程 ${elapsed}ms 超过 20s 兜底上限（Lead 实测准备段 < 15s）`);
    const fadeEvent = newEvents.find((e) => e.event === 'fade-start');
    suite.note(`相位轨迹：${phases.map((p) => `${p.phase}@${p.t}ms(${p.title || '-'})`).join(' → ')}`);
    suite.note(`fade-start 事件：${fadeEvent ? fadeEvent.detail : '（无 detail）'}`);
    await suite.shot('crossfade-done');
    return `${before.currentTitle} → ${before.nextTitle}：prepared→fading→done，${elapsed}ms 完成并继续播放（${Math.round(before.fadeMs)}ms 淡化）`;
  });

  /* ---------------- 7. 关闭开关后的普通硬切 ---------------- */
  await suite.step('关闭开关后：seek 到曲尾为普通硬切（无淡化事件），曲目正常推进', async () => {
    const beforeToggle = await pagePlayerState(cdp);
    const currentTitle = beforeToggle.title;
    const rows = await cdp.eval(`Array.from(document.querySelectorAll('.wall .track-title')).slice(0, 4).map((n) => (n.textContent || '').trim())`);
    const currentIdx = rows.indexOf(currentTitle);
    suite.assert(currentIdx >= 0 && currentIdx + 1 < rows.length, `无法从本地曲库找到「${currentTitle}」的下一首（rows=${JSON.stringify(rows)}）`);
    const expectedNext = rows[currentIdx + 1];

    await openSettingsPane(cdp, '播放');
    await cdp.waitFor(`!!document.querySelector(${JSON.stringify(CROSSFADE.toggle)})`, { desc: 'crossfade-toggle 存在', timeoutMs: 6000, intervalMs: 120 });
    await clickInSettings(cdp, CROSSFADE.toggle, '无缝衔接开关（关闭，准备硬切用例）');
    await waitSettingsStorage(cdp, (v) => v && v.enabled === false, 'localStorage.enabled === false', 6000);
    await closeAllLayers(cdp); // 必须先关设置遮罩：否则 CDP 鼠标事件会点到遮罩上（关闭弹层而不是 seek）
    await clickRail(cdp, LOCAL_RAIL, { settleMs: 700 });
    await ensurePlaying(cdp);

    const debugBefore = await pageDebugState(cdp);
    const knownEvents = new Set(debugBefore.events.map((e) => `${e.at}|${e.event}`));
    const seek = await seekByMouse(cdp, 0.996);
    suite.note(`硬切用例 seek 99.6%（x=${seek.x}）`);
    await cdp.waitFor(
      `(() => { const p = window.__ziluxPlayer && window.__ziluxPlayer(); return !!(p && p.track && p.track.title === ${JSON.stringify(expectedNext)} && p.playing) || null; })()`,
      { desc: `关闭开关后曲尾硬切到「${expectedNext}」`, timeoutMs: 30000, intervalMs: 150 },
    );
    const after = await pageDebugState(cdp);
    const newEvents = after.events.filter((e) => !knownEvents.has(`${e.at}|${e.event}`));
    const fadeEvents = newEvents.filter((e) => e.event === 'fade-start' || e.event === 'fade-done' || e.event === 'prepared');
    suite.assert(fadeEvents.length === 0, `关闭开关后仍出现淡化/准备事件：${JSON.stringify(fadeEvents.map((e) => e.event))}`);
    suite.assert(after.phase !== 'fading' && after.phase !== 'prepared', `关闭开关后 phase=${after.phase}（不应是 fading/prepared）`);
    suite.assert(after.enabled === false, `关闭开关后快照 enabled=${after.enabled}`);
    const finalPlayer = await pagePlayerState(cdp);
    suite.assert(finalPlayer.title === expectedNext && finalPlayer.playing, `硬切后状态异常：${JSON.stringify(finalPlayer)}`);
    await suite.shot('crossfade-hardcut');
    return `关闭后「${currentTitle}」→「${expectedNext}」正常硬切，无 fade-start/fade-done/prepared 事件，phase=${after.phase}`;
  });

  /* ---------------- 8. 收藏歌单路径（在线源；环境不可用时 SKIP） ---------------- */
  {
    const stepName = '收藏歌单路径：rail「我喜欢的音乐」首曲 prepared → seek → 自动切下一首并继续播放';
    const startedAt = Date.now();
    let envReason = '';
    try {
      // 硬切用例把开关关掉了，这里先恢复 enabled=true；收尾会再按进入时的基线还原。
      await openSettingsPane(cdp, '播放');
      await cdp.waitFor(`!!document.querySelector(${JSON.stringify(CROSSFADE.toggle)})`, { desc: 'crossfade-toggle 存在', timeoutMs: 6000, intervalMs: 120 });
      if ((await readSettingsStorage(cdp)).value.enabled !== true) {
        await clickInSettings(cdp, CROSSFADE.toggle, '无缝衔接开关（收藏歌单用例：开启）');
        await waitSettingsStorage(cdp, (v) => v && v.enabled === true, 'localStorage.enabled === true', 6000);
      }
      await closeAllLayers(cdp);

      await clickRail(cdp, FAVORITES_RAIL, { settleMs: 900 });
      const rowsOk = await cdp
        .waitFor(
          `(() => { const rows = document.querySelectorAll('.wall .track-row').length; return rows >= 1 ? rows : null; })()`,
          { desc: '收藏歌单出现 ≥1 行（需已登录）', timeoutMs: 25000, intervalMs: 200 },
        )
        .catch(() => null);
      if (!rowsOk) {
        envReason = '收藏歌单为空或未登录';
        throw envError(envReason);
      }
      const rows = await pageWallRows(cdp, 3);
      const favoriteTitle = rows[0].title;
      if (!favoriteTitle) {
        envReason = '收藏歌单首行标题为空';
        throw envError(envReason);
      }
      const expectedNext = rows[1] ? rows[1].title : '';

      await cdp.eval(`(() => { const row = document.querySelector('.wall .track-row'); if (!row) return false; row.click(); return true; })()`);
      const playingOk = await cdp
        .waitFor(
          `(() => { const p = window.__ziluxPlayer && window.__ziluxPlayer(); return !!(p && p.playing && p.track && p.track.title === ${JSON.stringify(favoriteTitle)}) || null; })()`,
          { desc: `收藏歌单首曲开始播放「${favoriteTitle}」`, timeoutMs: 25000, intervalMs: 150 },
        )
        .catch(() => null);
      if (!playingOk) {
        envReason = `收藏歌单首曲未能播放「${favoriteTitle}」（在线源/网络不可用）`;
        throw envError(envReason);
      }
      const prepared = await waitDebug(
        cdp,
        (s) => s && s.phase === 'prepared' && s.currentTitle === favoriteTitle && !!s.nextTitle,
        `收藏歌单 crossfade 进入 prepared（「${favoriteTitle}」→下一首）`,
        20000,
      ).catch(() => null);
      if (!prepared) {
        envReason = `在线曲目分析未就绪/未进入 prepared（「${favoriteTitle}」，在线源不可用）`;
        throw envError(envReason);
      }
      const player = await pagePlayerState(cdp);
      suite.assert(Number.isFinite(prepared.currentAudibleEndMs) && prepared.currentAudibleEndMs > 0, `收藏歌单快照缺少 currentAudibleEndMs：${JSON.stringify(prepared.currentAudibleEndMs)}`);
      suite.assert(prepared.currentAudibleEndMs <= player.durationMs + 1, `收藏歌单 currentAudibleEndMs=${Math.round(prepared.currentAudibleEndMs)} 超过 durationMs=${Math.round(player.durationMs)}`);
      const planDelta = Math.abs(prepared.fadeStartPosMs + prepared.fadeMs - prepared.currentAudibleEndMs);
      suite.assert(
        planDelta <= AUDIBLE_END_TOLERANCE_MS,
        `收藏歌单调度公式偏差 ${Math.round(planDelta)}ms（fadeStart=${Math.round(prepared.fadeStartPosMs)} + fadeMs=${Math.round(prepared.fadeMs)} vs 可听结尾=${Math.round(prepared.currentAudibleEndMs)}）`,
      );
      if (expectedNext) suite.assert(prepared.nextTitle === expectedNext, `收藏歌单预加载下一首「${prepared.nextTitle}」≠ 列表第二行「${expectedNext}」`);

      const knownEvents = new Set((prepared.events || []).map((e) => `${e.at}|${e.event}`));
      const fraction = Math.min(0.985, Math.max(0.9, (prepared.fadeStartPosMs + 250) / player.durationMs));
      await seekByMouse(cdp, fraction);
      const switched = await cdp
        .waitFor(
          `(() => { const p = window.__ziluxPlayer && window.__ziluxPlayer(); return !!(p && p.track && p.track.title === ${JSON.stringify(prepared.nextTitle)} && p.playing) || null; })()`,
          { desc: `收藏歌单淡化后切到「${prepared.nextTitle}」`, timeoutMs: CROSSFADE_TRIGGER_TIMEOUT_MS, intervalMs: 150 },
        )
        .catch(() => null);
      if (!switched) {
        envReason = `收藏歌单 seek 后未切换曲目（在线流/分析不可用）`;
        throw envError(envReason);
      }
      const after = await pageDebugState(cdp);
      const newEvents = after.events.filter((e) => !knownEvents.has(`${e.at}|${e.event}`));
      const events = newEvents.map((e) => e.event);
      suite.assert(events.includes('fade-start'), `收藏歌单事件缺少 fade-start：${JSON.stringify(events)}`);
      suite.assert(events.includes('fade-done'), `收藏歌单事件缺少 fade-done：${JSON.stringify(events)}`);
      const finalState = await pagePlayerState(cdp);
      suite.assert(finalState.title === prepared.nextTitle && finalState.playing, `收藏歌单切换后状态异常：${JSON.stringify(finalState)}`);
      await suite.shot('crossfade-favorites');
      suite.record(
        'PASS',
        stepName,
        `「${favoriteTitle}」→「${prepared.nextTitle}」：prepared（可听结尾 ${Math.round(prepared.currentAudibleEndMs)}ms，尾部静音 ${Math.round(prepared.tailSilenceMs)}ms，公式偏差 ${Math.round(planDelta)}ms）→ seek → fade-start/fade-done → 继续播放`,
        Date.now() - startedAt,
      );
    } catch (err) {
      if (err && err.env) {
        await suite.shot('crossfade-favorites-skip').catch(() => {});
        suite.record('SKIP', stepName, `${envReason}（环境限制，不计产品 bug）`, Date.now() - startedAt);
      } else {
        const evidence = await suite.captureEvidence('favorites').catch(() => '');
        suite.record('FAIL', stepName, String((err && err.message) || err), Date.now() - startedAt, evidence);
      }
    }
  }

  /* ---------------- 9. 恢复基线 + 收尾 ---------------- */
  await suite.step('恢复基线设置 + 页面收尾（回首页、关面板、console error 0）', async () => {
    await openSettingsPane(cdp, '播放');
    await cdp.waitFor(`!!document.querySelector(${JSON.stringify(CROSSFADE.toggle)})`, { desc: 'crossfade-toggle 存在', timeoutMs: 6000, intervalMs: 120 });
    const current = (await readSettingsStorage(cdp)).value;
    if (current.enabled !== baselineStorage.enabled) {
      await clickInSettings(cdp, CROSSFADE.toggle, '开关恢复基线');
    }
    if (current.length !== baselineStorage.length) {
      await clickInSettings(cdp, CROSSFADE.lengthOption(baselineStorage.length), '时长恢复基线');
    }
    await waitSettingsStorage(cdp, (v) => v && v.enabled === baselineStorage.enabled && v.length === baselineStorage.length, 'localStorage 恢复基线设置', 8000);
    const storage = await readSettingsStorage(cdp);
    suite.assert(storage.value.enabled === baselineStorage.enabled && storage.value.length === baselineStorage.length, `基线未恢复：${JSON.stringify(storage.value)} vs ${JSON.stringify(baselineStorage)}`);
    const ui = await pageSettingsUi(cdp);
    suite.assert(ui.toggle.pressed === String(baselineStorage.enabled), `恢复后开关 aria-pressed=${ui.toggle.pressed}`);
    suite.assert(ui.datasetEnabled === (baselineStorage.enabled ? '1' : '0'), `恢复后 data-enabled=${ui.datasetEnabled}`);
    const debug = await pageDebugState(cdp);
    suite.assert(debug.enabled === baselineStorage.enabled && String(debug.length) === String(baselineStorage.length), `恢复后调试快照 ${JSON.stringify({ enabled: debug.enabled, length: debug.length })}`);

    // 封面布局恢复基线（套件为了让 .track-row 可见可能切到了「横条」）。
    const layoutNow = (await readLocalStorage(cdp, POSTER_LAYOUT_KEY)) || 'grid';
    if (layoutNow !== baselineLayout) {
      const label = baselineLayout === 'list' ? '横条' : '网格';
      await clickRail(cdp, LOCAL_RAIL, { settleMs: 700 });
      await cdp.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('.layout-modes .seg-btn')).find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)});
        if (btn) { btn.click(); return true; }
        return false;
      })()`);
      await sleep(300);
      const restoredLayout = (await readLocalStorage(cdp, POSTER_LAYOUT_KEY)) || 'grid';
      suite.assert(restoredLayout === baselineLayout, `封面布局未恢复基线：${restoredLayout}（期望 ${baselineLayout}）`);
    }

    await closeAllLayers(cdp);
    await goHome(cdp);
    const layers = await cdp.eval(`({
      sheets: document.querySelectorAll('.sheet').length,
      quickOpen: !!document.querySelector('.quick.is-open'),
      dlqOpen: !!document.querySelector('.dlq-panel.is-open'),
      wallHidden: !!document.querySelector('.wall.is-hidden'),
    })`);
    suite.assert(layers.sheets === 0, `收尾后仍有 ${layers.sheets} 个 .sheet 弹层`);
    suite.assert(!layers.quickOpen, '收尾后快捷设置仍打开');
    suite.assert(!layers.dlqOpen, '收尾后下载面板仍打开');

    // 播放状态还原：进入套件时若是暂停，收尾时恢复暂停（播放曲目已被本套件改变，这里只对齐播放/暂停）。
    const finalPlayer = await pagePlayerState(cdp);
    if (baselinePlayer.playing === false && finalPlayer.playing === true) {
      await dispatchHostCommand(cdp, 'togglePlay');
      const paused = await cdp.waitFor(
        `(() => { const p = window.__ziluxPlayer && window.__ziluxPlayer(); return p && p.playing === false ? true : null; })()`,
        { desc: '收尾恢复暂停状态', timeoutMs: 8000, intervalMs: 150 },
      );
      suite.assert(paused === true, '收尾无法恢复暂停状态');
    }
    const consoleErrors = cdp.takeConsoleErrors({ clear: true });
    suite.assert(consoleErrors.length === 0, `console 出现 ${consoleErrors.length} 条 error：${JSON.stringify(consoleErrors.slice(0, 3))}`);
    const playerEnd = await pagePlayerState(cdp);
    suite.note(`收尾播放状态：${playerEnd.title}（playing=${playerEnd.playing}，index=${playerEnd.index}）`);
    return `基线 ${JSON.stringify(baselineStorage)} 已恢复；无弹层、回首页、console error 0`;
  });

  if (!localReady) {
    // 理论到不了（前面已 return），留作防御。
    suite.skip('crossfade 收尾', '本地曲库未就绪');
  }
});
