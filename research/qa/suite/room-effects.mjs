/**
 * Zilux2 QA 套件 —— 房间设置「粒子 / 流星预设」chips
 *
 * 覆盖：
 *  1. 房间设置面板入口链：.pb-quick →「歌词」tab → .quick-text-settings-btn → .sheet.text-sheet.room-sheet
 *  2. 预设行结构：.room-preset-row[data-preset-kind] > button.room-preset-chip[data-preset-id]
 *  3. 点击 chip 只改 draft（滑杆 input.ts-range / 数值 .ts-value 同步、localStorage 不变、chip 高亮）
 *  4. 点「保存」后 localStorage zilux2.roomStyle 对应字段 = 验收数值表（8 个预设全覆盖）
 *  5. 「取消」不落盘，重新打开后滑杆回到保存前数值
 *  6. 收尾还原原来的 roomStyle / lumiere，并确认全程无 console error
 *
 * 运行：node research/qa/suite/room-effects.mjs
 * 截图：research/shots/suite-YYYYMMDD/room-effects-*.png
 */
import { runSuite, sleep } from './lib/cdp.mjs';
import {
  RAIL,
  clickRail,
  closeOverlays,
  closeLyricsView,
  openLyricsView,
  pressEscape,
  readLocalStorage,
  readLocalStorageJson,
  writeLocalStorage,
} from './lib/ui.mjs';
import {
  LUMIERE_KEY,
  ROOM_PRESET_FIXTURES,
  ROOM_PRESET_FIXTURES_READY,
  ROOM_SETTINGS_KEY,
  roomPresetChipSel,
} from './lib/fixtures.mjs';

const PANEL = '.sheet.text-sheet.room-sheet';
const SAVE_BTN = '.ts-btn.is-primary';
const CANCEL_BTN = '.ts-btn';

/** data-preset-kind → 面板里的分组标题（渲染顺序：流星在粒子前）。 */
const GROUP_TITLE = { particle: '粒子', streak: '流星' };
/** 分组内 input.ts-range 的 DOM 顺序 → RoomStyleSettings 字段名。 */
const RANGE_KEYS = {
  particle: ['particleCount', 'particleSize', 'particleBrightness', 'particleSpeed', 'particleDrift'],
  streak: ['streakCount', 'streakStrength', 'streakSpeed', 'streakLength', 'streakWidth'],
};

const EPS = 1e-6;

function json(value) {
  return JSON.stringify(value);
}

function panelOpenExpr() {
  return `!!document.querySelector(${json(PANEL)})`;
}

/** 分组快照：5 个滑杆 value + 5 个 .ts-value 文本 + 行标签。 */
function groupSnapshotExpr(kind) {
  const title = GROUP_TITLE[kind];
  return `(() => {
    const panel = document.querySelector(${json(PANEL)});
    if (!panel) return { error: '房间设置面板不在 DOM 中' };
    const groups = Array.from(panel.querySelectorAll('.ts-group'));
    const group = groups.find((el) => ((el.querySelector('.ts-group-title') || {}).textContent || '').trim() === ${json(title)});
    if (!group) {
      return { error: '找不到分组「${title}」', groups: groups.map((el) => ((el.querySelector('.ts-group-title') || {}).textContent || '').trim()) };
    }
    return {
      title: ${json(title)},
      inputs: Array.from(group.querySelectorAll('input.ts-range')).map((n) => n.value),
      values: Array.from(group.querySelectorAll('.ts-value')).map((n) => (n.textContent || '').trim()),
      rows: Array.from(group.querySelectorAll('.ts-row')).map((row) => ((row.querySelector('.ts-label') || {}).textContent || '').trim()),
      chips: Array.from(group.querySelectorAll('.room-preset-chip')).map((btn) => ({
        id: btn.dataset.presetId || '',
        kind: btn.dataset.presetKind || '',
        label: (btn.textContent || '').trim(),
        active: btn.classList.contains('is-active'),
        pressed: btn.getAttribute('aria-pressed'),
        title: btn.title || '',
      })),
    };
  })()`;
}

/** 比较对象里的数值字段，返回不一致的说明数组。 */
function compareFields(actual, expect) {
  const bad = [];
  for (const [key, want] of Object.entries(expect)) {
    const got = actual ? actual[key] : undefined;
    if (typeof got !== 'number' || Math.abs(got - want) > EPS) {
      bad.push(`${key}: 期望 ${want}，实际 ${JSON.stringify(got)}`);
    }
  }
  return bad;
}

/**
 * 打开房间设置面板：歌词页 → 快捷设置「歌词」tab → 效果模式切「房间」→ 房间设置按钮。
 * 面板已打开时直接返回。lumiere 模式会被改成 room（调用方负责记录/还原原值）。
 */
async function openRoomPanel(cdp) {
  if (await cdp.eval(panelOpenExpr())) return 'already-open';

  if (!(await cdp.eval(`!!document.querySelector('.lyrics-view')`))) {
    await openLyricsView(cdp);
  }
  if (!(await cdp.eval(`!!document.querySelector('.quick.is-open')`))) {
    await cdp.click('.pb-quick', { desc: '播放条快捷设置按钮 .pb-quick' });
  }
  await cdp.waitFor(`!!document.querySelector('.quick.is-open')`, {
    desc: '快捷设置面板 .quick.is-open',
    timeoutMs: 8000,
  });
  await cdp.clickText('.quick-tab', '歌词', { desc: '快捷设置标签「歌词」' });
  await cdp.waitFor(`!!document.querySelector('.quick-effect-seg')`, {
    desc: '歌词效果分段控件 .quick-effect-seg',
    timeoutMs: 8000,
  });

  const mode = await cdp.eval(`localStorage.getItem(${json(LUMIERE_KEY)})`);
  if (mode !== 'room') {
    await cdp.clickText('.quick-effect-seg button', '房间', { desc: '歌词效果模式「房间」' });
    await cdp.waitFor(`localStorage.getItem(${json(LUMIERE_KEY)}) === 'room'`, {
      desc: `localStorage ${LUMIERE_KEY} = room`,
      timeoutMs: 5000,
      intervalMs: 120,
    });
    await cdp.waitFor(`!!document.querySelector('.quick-effect-seg')`, {
      desc: '歌词效果分段控件（切模式后仍在）',
      timeoutMs: 5000,
    });
  }

  await cdp.click('.quick-text-settings-btn', { desc: '房间设置入口 .quick-text-settings-btn' });
  await cdp.waitFor(panelOpenExpr(), { desc: '房间设置面板 .sheet.text-sheet.room-sheet', timeoutMs: 12000 });
  await cdp.waitFor(`!!document.querySelector(${json(PANEL)}) && document.querySelectorAll('.room-preset-row').length >= 2`, {
    desc: '房间设置面板内两行预设 chips',
    timeoutMs: 8000,
  });
  return 'opened';
}

/** 关闭房间设置面板：优先「取消」（还原 persisted 值），并等面板 180ms 动画后卸载。 */
async function closeRoomPanel(cdp) {
  if (!(await cdp.eval(panelOpenExpr()))) return;
  await cdp.clickText(CANCEL_BTN, '取消', { desc: '房间设置「取消」' });
  await cdp.waitFor(`!document.querySelector(${json(PANEL)})`, {
    desc: '房间设置面板关闭（取消后）',
    timeoutMs: 6000,
    intervalMs: 100,
  });
  await sleep(120);
}

await runSuite('room-effects', '房间设置：粒子/流星预设 chips（draft → 保存落盘 → 取消还原）', async (suite) => {
  const cdp = suite.cdp;

  /** 测试开始前的原始值，收尾时写回。 */
  let originalRoomRaw = null;
  let originalLumiereRaw = null;

  await suite.step('准备：记录原始 localStorage，打开房间设置面板', async () => {
    await closeOverlays(cdp);
    await clickRail(cdp, RAIL.home, { settleMs: 200 });
    await pressEscape(cdp);
    originalRoomRaw = await readLocalStorage(cdp, ROOM_SETTINGS_KEY);
    originalLumiereRaw = await readLocalStorage(cdp, LUMIERE_KEY);
    const how = await openRoomPanel(cdp);
    const info = await cdp.eval(`(() => {
      const panel = document.querySelector(${json(PANEL)});
      return {
        title: ((panel.querySelector('.sheet-title') || {}).textContent || '').trim(),
        classes: String(panel.className || ''),
        leftGroups: panel.querySelectorAll('.ts-left .ts-group').length,
        foot: Array.from(panel.querySelectorAll('.ts-foot-actions .ts-btn')).map((n) => (n.textContent || '').trim()),
        presetRows: panel.querySelectorAll('.room-preset-row').length,
      };
    })()`);
    suite.assert(info.title === '房间设置', `面板标题不是「房间设置」：${json(info.title)}`);
    suite.assert(info.presetRows === 2, `预设行数量应为 2（粒子/流星），实际 ${info.presetRows}`);
    suite.assert(info.foot.includes('保存') && info.foot.includes('取消'), `底部按钮缺少保存/取消：${json(info.foot)}`);
    await suite.shot('01-panel');
    return `origin=${how} | roomStyle=${originalRoomRaw ? `${originalRoomRaw.length}B` : 'null'} | lumiere=${json(originalLumiereRaw)} | 底部=${info.foot.join('/')}`;
  });

  await suite.step('预设行结构：kind/id/aria-pressed 齐全，默认星尘+默认高亮', async () => {
    suite.assert(ROOM_PRESET_FIXTURES_READY, 'ROOM_PRESET_FIXTURES 为空（验收数值表未同步）');
    const rows = await cdp.eval(`(() => Array.from(document.querySelectorAll(${json(PANEL)} + ' .room-preset-row')).map((row) => ({
      kind: row.dataset.presetKind || '',
      chips: Array.from(row.querySelectorAll('.room-preset-chip')).map((btn) => ({
        kind: btn.dataset.presetKind || '',
        id: btn.dataset.presetId || '',
        label: (btn.textContent || '').trim(),
        pressed: btn.getAttribute('aria-pressed'),
        active: btn.classList.contains('is-active'),
        title: btn.title || '',
      })),
    })))()`);
    suite.assert(rows.length === 2, `应有 2 行预设 chips，实际 ${rows.length}`);
    const byKind = new Map(rows.map((row) => [row.kind, row]));
    for (const kind of ['particle', 'streak']) {
      const row = byKind.get(kind);
      suite.assert(!!row, `缺少 data-preset-kind="${kind}" 的预设行，实际 kinds=${json(rows.map((r) => r.kind))}`);
      const wanted = ROOM_PRESET_FIXTURES.filter((f) => f.kind === kind);
      suite.assert(row.chips.length === wanted.length, `${kind} 行 chips 数量应为 ${wanted.length}，实际 ${row.chips.length}`);
      for (const fixture of wanted) {
        const chip = row.chips.find((c) => c.id === fixture.id);
        suite.assert(!!chip, `${kind} 行缺少 chip data-preset-id="${fixture.id}"，实际=${json(row.chips.map((c) => c.id))}`);
        suite.assert(chip.kind === kind, `chip ${fixture.id} 的 data-preset-kind 应为 ${kind}，实际 ${chip.kind}`);
        if (fixture.label) suite.assert(chip.label === fixture.label, `chip ${fixture.id} 文本应为「${fixture.label}」，实际「${chip.label}」`);
        suite.assert(chip.pressed === 'true' || chip.pressed === 'false', `chip ${fixture.id} 的 aria-pressed 应为 true/false，实际 ${json(chip.pressed)}`);
        suite.assert(!!chip.title, `chip ${fixture.id} 缺少 title 提示`);
      }
    }

    // 初始高亮只作为观测，不作为失败条件：用户真实配置可能是自定义值（Lead 已确认 initial active 可能为空）。
    const initialActive = await cdp.eval(`(() => {
      const isActive = (sel) => {
        const btn = document.querySelector(sel);
        return btn ? btn.classList.contains('is-active') : null;
      };
      return {
        stardust: isActive(${json(roomPresetChipSel('particle', 'stardust'))}),
        streakDefault: isActive(${json(roomPresetChipSel('streak', 'default'))}),
      };
    })()`);
    suite.note(
      `初始 chip 高亮（观测，不判定）：星尘=${json(initialActive.stardust)} 流星默认=${json(initialActive.streakDefault)}` +
        `（localStorage ${originalRoomRaw === null ? '为空=默认配置' : '已有自定义配置'}）`,
    );
    await suite.shot('02-preset-rows');
    return `kinds=${rows.map((r) => `${r.kind}:${r.chips.map((c) => c.id).join(',')}`).join(' | ')}`;
  });

  for (const fixture of ROOM_PRESET_FIXTURES) {
    const { kind, id, label, expect } = fixture;
    const groupTitle = GROUP_TITLE[kind];
    const chipSel = roomPresetChipSel(kind, id);
    const title = `预设「${groupTitle}·${label}」→ 保存后 localStorage 生效`;

    await suite.step(title, async () => {
      // 每轮开头保证面板是打开的（上一轮保存后已关闭）
      const how = await openRoomPanel(cdp);

      const beforeRaw = await readLocalStorage(cdp, ROOM_SETTINGS_KEY);
      const before = await cdp.eval(groupSnapshotExpr(kind));
      suite.assert(!before.error, `读取「${groupTitle}」分组失败：${before.error}${before.groups ? ` groups=${json(before.groups)}` : ''}`);
      suite.assert(before.inputs.length === 5, `「${groupTitle}」分组滑杆数量应为 5，实际 ${before.inputs.length}`);

      await cdp.click(chipSel, { desc: `预设 chip ${kind}/${id}（${label}）` });
      await sleep(220);

      const chipState = await cdp.eval(`(() => {
        const btn = document.querySelector(${json(chipSel)});
        if (!btn) return null;
        return {
          active: btn.classList.contains('is-active'),
          pressed: btn.getAttribute('aria-pressed'),
          title: btn.title || '',
        };
      })()`);
      suite.assert(!!chipState, `chip ${kind}/${id} 点击后从 DOM 消失`);
      suite.assert(chipState.active, `chip ${kind}/${id} 点击后未高亮（缺 is-active）`);
      suite.assert(chipState.pressed === 'true', `chip ${kind}/${id} 点击后 aria-pressed 应为 true，实际 ${json(chipState.pressed)}`);

      const unchangedRaw = (await readLocalStorage(cdp, ROOM_SETTINGS_KEY)) === beforeRaw;
      suite.assert(unchangedRaw, `点击 chip 后 localStorage ${ROOM_SETTINGS_KEY} 不应变化（应只改 draft，保存才落盘）`);

      const after = await cdp.eval(groupSnapshotExpr(kind));
      suite.assert(!after.error, `点击后读取「${groupTitle}」分组失败：${after.error}`);
      // 1) 滑杆 input 值 = 验收数值表（draft 已套用）
      const keys = RANGE_KEYS[kind];
      const inputBad = [];
      keys.forEach((key, index) => {
        const got = Number(after.inputs[index]);
        if (!Number.isFinite(got) || Math.abs(got - expect[key]) > EPS) {
          inputBad.push(`${key}: 期望 ${expect[key]}，滑杆实际 ${json(after.inputs[index])}`);
        }
      });
      suite.assert(inputBad.length === 0, `点击 chip 后滑杆数值不符：${inputBad.join('；')}`);
      // 2) .ts-value 文本同步：原本就与目标不同的字段，至少要有 1 项文本变化
      const expectChanged = keys.filter((key, index) => Math.abs(Number(before.inputs[index]) - expect[key]) > EPS).length;
      const textChanged = keys.filter((key, index) => before.values[index] !== after.values[index]).length;
      if (expectChanged > 0) {
        suite.assert(
          textChanged > 0,
          `点击 chip 后 .ts-value 数值文本没有变化（应同步 draft）：before=${json(before.values)} after=${json(after.values)}`,
        );
      }

      // 3) 点保存 → 面板关闭 → localStorage 对应字段 = 验收数值表
      await cdp.click(SAVE_BTN, { desc: '房间设置「保存」' });
      await cdp.waitFor(`!document.querySelector(${json(PANEL)})`, {
        desc: '房间设置面板关闭（保存后）',
        timeoutMs: 8000,
        intervalMs: 100,
      });
      const saved = await readLocalStorageJson(cdp, ROOM_SETTINGS_KEY);
      suite.assert(!!saved, `保存后 localStorage ${ROOM_SETTINGS_KEY} 为空`);
      const bad = compareFields(saved, expect);
      suite.assert(bad.length === 0, `保存后 localStorage 字段不符：${bad.join('；')}`);
      return `${how} | chip is-active ✓ | draft ${keys.length} 项滑杆匹配 | .ts-value 变化 ${textChanged}/${expectChanged} | 保存后落盘 ✓`;
    });
  }

  await suite.step('取消不落盘：点 chip → 取消 → 数值回到保存前', async () => {
    const how = await openRoomPanel(cdp);
    const savedRaw = await readLocalStorage(cdp, ROOM_SETTINGS_KEY);
    const savedObj = await readLocalStorageJson(cdp, ROOM_SETTINGS_KEY);
    suite.assert(!!savedObj, `localStorage ${ROOM_SETTINGS_KEY} 为空，无法验证取消还原`);

    // 点一个与当前落盘值不同的 chip（粒子·雪点）
    const snow = ROOM_PRESET_FIXTURES.find((f) => f.kind === 'particle' && f.id === 'snow');
    suite.assert(!!snow, 'ROOM_PRESET_FIXTURES 里缺少 particle/snow 预设，无法验证取消还原');
    await cdp.click(roomPresetChipSel('particle', snow.id), { desc: `预设 chip particle/${snow.id}` });
    await sleep(200);
    const draftSnow = await cdp.eval(groupSnapshotExpr('particle'));
    suite.assert(!draftSnow.error, `读取「粒子」分组失败：${draftSnow.error}`);
    const draftBad = RANGE_KEYS.particle.filter((key, index) => Math.abs(Number(draftSnow.inputs[index]) - snow.expect[key]) > EPS);
    suite.assert(draftBad.length === 0, `点 chip 后 draft 未套用雪点：${draftBad.join('；')}`);
    suite.assert((await readLocalStorage(cdp, ROOM_SETTINGS_KEY)) === savedRaw, '点 chip 后 localStorage 不应变化（取消前）');

    await cdp.clickText(CANCEL_BTN, '取消', { desc: '房间设置「取消」' });
    await cdp.waitFor(`!document.querySelector(${json(PANEL)})`, {
      desc: '房间设置面板关闭（取消后）',
      timeoutMs: 8000,
      intervalMs: 100,
    });
    suite.assert((await readLocalStorage(cdp, ROOM_SETTINGS_KEY)) === savedRaw, '取消后 localStorage 不应被改写');

    // 重新打开：draft 应回到 persisted（保存前）的值
    await openRoomPanel(cdp);
    for (const kind of ['particle', 'streak']) {
      const snap = await cdp.eval(groupSnapshotExpr(kind));
      suite.assert(!snap.error, `重开后读取「${GROUP_TITLE[kind]}」分组失败：${snap.error}`);
      const bad = RANGE_KEYS[kind].filter((key, index) => Math.abs(Number(snap.inputs[index]) - savedObj[key]) > EPS);
      suite.assert(bad.length === 0, `取消并重开后「${GROUP_TITLE[kind]}」滑杆未还原：${bad.map((key, i) => `${key} 期望 ${savedObj[key]}`).join('；')}`);
    }
    await suite.shot('03-cancel-reverted');
    return `${how} | 取消前 draft=雪点 ✓ | 取消后 localStorage 未变 ✓ | 重开滑杆=保存前 ✓`;
  });

  await suite.step('收尾：还原 roomStyle / lumiere 原始值', async () => {
    // 先把原始 localStorage 写回，再用「取消」让面板 apply 回 persisted（不额外产生写入）
    await writeLocalStorage(cdp, ROOM_SETTINGS_KEY, originalRoomRaw);
    await writeLocalStorage(cdp, LUMIERE_KEY, originalLumiereRaw);
    if (await cdp.eval(panelOpenExpr())) {
      await closeRoomPanel(cdp);
    }
    const nowRoom = await readLocalStorage(cdp, ROOM_SETTINGS_KEY);
    const nowLumiere = await readLocalStorage(cdp, LUMIERE_KEY);
    suite.assert(nowRoom === originalRoomRaw, `roomStyle 未还原：期望 ${json(originalRoomRaw && originalRoomRaw.slice(0, 60))}，实际 ${json(nowRoom && nowRoom.slice(0, 60))}`);
    suite.assert(nowLumiere === originalLumiereRaw, `lumiere 未还原：期望 ${json(originalLumiereRaw)}，实际 ${json(nowLumiere)}`);
    await closeLyricsView(cdp);
    await closeOverlays(cdp);
    return `roomStyle=${originalRoomRaw ? `${originalRoomRaw.length}B` : 'null'} | lumiere=${json(originalLumiereRaw)}`;
  });

  await suite.step('全程无 console error / 未捕获异常', async () => {
    await sleep(400);
    const errors = cdp.takeConsoleErrors();
    if (errors.length > 0) {
      const detail = errors
        .slice(0, 6)
        .map((err, i) => `${i + 1}. [${err.kind}] ${String(err.text).slice(0, 400)}`)
        .join('\n');
      throw new Error(`房间设置操作期间捕获 ${errors.length} 条 console 错误：\n${detail}`);
    }
    return '无 console error / 未捕获异常';
  });
});
