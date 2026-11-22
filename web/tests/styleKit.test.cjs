'use strict';

/**
 * styleKit 单测：目录完整性、参数区间、硬门控、打分可解释性、稳定排序。
 *
 * 复用仓库既有范式（见 web/tests/automixV2.test.cjs）：
 * node:test + vm.runInNewContext + typescript.transpileModule。
 * 注意：vm 里必须同时提供 module 与 exports: module.exports，否则 CommonJS 导出全丢。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('E:/Zilux2开发/web/node_modules/typescript');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'core', 'automix', 'styleKit.ts');

function loadStyleKit() {
  const source = fs.readFileSync(SRC, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    js,
    { module, exports: module.exports, require: () => ({}), console },
    { filename: SRC },
  );
  return module.exports;
}

const kit = loadStyleKit();
const { STYLE_CATALOG, TRANSITION_STYLE_IDS } = kit;

const EXPECTED_IDS = [
  'bassSwap',
  'eqSwap',
  'filterSweep',
  'echoOut',
  'reverbOut',
  'loopRoll',
  'backspin',
  'slam',
  'dropSwap',
  'doubleDrop',
  'doubling',
  'acapellaOverlay',
  'halfTime',
  'keyLift',
  'longBlend',
  'cut',
];

/** 一份「理想同速」上下文：两首都是 128 BPM、同调、器乐、有前奏尾奏与 loop。 */
function idealCtx(over) {
  return Object.assign(
    {
      bpmA: 128,
      bpmB: 128,
      keyGap: 0,
      energyGap: 0.05,
      meterA: 4,
      meterB: 4,
      aVocal: true,
      bVocal: true,
      aHasIntro: true,
      bHasIntro: true,
      aHasOutro: true,
      bFirstVocalMs: 8000,
      aLoopUnits: 4,
      bLoopUnits: 4,
      fadeMsWanted: 16000,
      barMs: 1875,
      beatMs: 468.75,
      tempoSoftLimit: 6,
      tempoHardLimit: 12,
      aInstrumental: false,
      bInstrumental: false,
      hasDownbeat: true,
    },
    over,
  );
}

function byId(list, id) {
  const hit = list.find((row) => row.spec.id === id);
  assert.ok(hit, `目录里应当存在 ${id}`);
  return hit;
}

test('目录：16 种风格齐全、id 唯一、必填文案非空', () => {
  assert.equal(STYLE_CATALOG.length, 16);
  assert.equal(EXPECTED_IDS.length, 16);
  // 注意：vm 里造出来的数组与宿主数组原型不同，比较前统一搬回宿主 realm
  assert.deepEqual(
    Array.from(STYLE_CATALOG, (s) => s.id).sort(),
    EXPECTED_IDS.slice().sort(),
  );
  assert.deepEqual(Array.from(TRANSITION_STYLE_IDS), Array.from(STYLE_CATALOG, (s) => s.id));
  assert.equal(new Set(STYLE_CATALOG.map((s) => s.id)).size, 16);

  for (const spec of STYLE_CATALOG) {
    assert.ok(typeof spec.label === 'string' && spec.label.trim().length >= 2, `${spec.id} label`);
    assert.ok(typeof spec.why === 'string' && spec.why.trim().length >= 8, `${spec.id} why`);
    assert.ok(Array.isArray(spec.requires) && spec.requires.length >= 1, `${spec.id} requires`);
    for (const prim of spec.requires) {
      assert.ok(
        [
          'split',
          'sweep',
          'duck',
          'reverb',
          'echo',
          'bridge',
          'introBridge',
          'tempo',
          'cut',
          'tailHold',
        ].includes(prim),
        `${spec.id} 用了未知原语 ${prim}`,
      );
    }
    assert.ok(spec.params && typeof spec.params === 'object', `${spec.id} params`);
  }
});

test('参数：每种风格的时长窗口落在 1–32 s，且参数都在合法区间', () => {
  for (const spec of STYLE_CATALOG) {
    assert.ok(
      Number.isFinite(spec.minFadeMs) && spec.minFadeMs >= 1000,
      `${spec.id} minFadeMs 必须 ≥ 1000`,
    );
    assert.ok(
      Number.isFinite(spec.maxFadeMs) && spec.maxFadeMs <= 32000,
      `${spec.id} maxFadeMs 必须 ≤ 32000`,
    );
    assert.ok(spec.minFadeMs <= spec.maxFadeMs, `${spec.id} min ≤ max`);

    const p = spec.params;
    if (p.swapShare !== undefined) {
      assert.ok(p.swapShare > 0 && p.swapShare <= 1, `${spec.id} swapShare`);
    }
    if (p.sweepShare !== undefined) {
      assert.ok(p.sweepShare > 0 && p.sweepShare <= 1, `${spec.id} sweepShare`);
    }
    if (p.echoDiv !== undefined) {
      assert.ok(p.echoDiv > 0 && p.echoDiv <= 4, `${spec.id} echoDiv`);
    }
    if (p.reverbSendDb !== undefined) {
      assert.ok(p.reverbSendDb <= 0 && p.reverbSendDb >= -24, `${spec.id} reverbSendDb`);
    }
    if (p.duckDb !== undefined) {
      assert.ok(p.duckDb <= 0 && p.duckDb >= -6, `${spec.id} duckDb 受 DUCK_MAX_DB 约束`);
    }
    if (p.tailHold !== undefined) {
      assert.ok(p.tailHold >= 0 && p.tailHold <= 0.4, `${spec.id} tailHold 受 aTailHold 上限约束`);
    }
    if (p.tempoRange !== undefined) {
      assert.ok(p.tempoRange > 0 && p.tempoRange <= 100, `${spec.id} tempoRange`);
    }
    if (p.bars !== undefined) {
      assert.ok(p.bars >= 0.5, `${spec.id} bars`);
    }
  }
});

test('门控：BPM 差超过硬限时长重叠手法被挡，硬切仍然可用', () => {
  const ctx = idealCtx({ bpmB: 145 }); // 13.3%
  const ranked = kit.rankStyles(ctx);
  const longBlend = byId(ranked, 'longBlend');
  assert.match(longBlend.blockedBy, /硬限 12%/);
  assert.ok(longBlend.reasons.some((r) => r.includes('被挡')));

  const cut = byId(ranked, 'cut');
  assert.equal(cut.blockedBy, undefined, '硬切不该被 BPM 门控挡住');
  const slam = byId(ranked, 'slam');
  assert.equal(slam.blockedBy, undefined);
});

test('门控：每风格自己的 tempoRange 细分生效（7% 挡 longBlend 但放过 bassSwap）', () => {
  const ctx = idealCtx({ bpmB: 137 }); // 7.03%
  const ranked = kit.rankStyles(ctx);
  assert.match(byId(ranked, 'longBlend').blockedBy, /tempoRange 6%/);
  assert.equal(byId(ranked, 'bassSwap').blockedBy, undefined, 'bassSwap 容差 8% 应当通过');
  assert.equal(byId(ranked, 'doubleDrop').blockedBy !== undefined, true, '双 drop 容差 0.5%');
});

test('门控：keyGap ≥5 且能量差大时长重叠手法被挡；能量差小只降级', () => {
  const clash = kit.rankStyles(idealCtx({ keyGap: 6, energyGap: 0.5 }));
  assert.match(byId(clash, 'longBlend').blockedBy, /keyGap 6/);
  assert.match(byId(clash, 'acapellaOverlay').blockedBy, /keyGap 6/);
  assert.equal(byId(clash, 'cut').blockedBy, undefined);

  const mild = kit.rankStyles(idealCtx({ keyGap: 6, energyGap: 0.1 }));
  assert.equal(byId(mild, 'longBlend').blockedBy, undefined, '能量差小时不该硬挡');
  const sameKey = kit.rankStyles(idealCtx({ keyGap: 0, energyGap: 0.1 }));
  assert.ok(
    byId(mild, 'longBlend').score < byId(sameKey, 'longBlend').score,
    'keyGap 大时必须比同调低分',
  );
  assert.ok(byId(mild, 'longBlend').reasons.some((r) => r.includes('key clash')));
});

test('门控：B 无前奏且首句 <1.5 s 时，需要干净入口的手法全部被挡', () => {
  const ctx = idealCtx({ bHasIntro: false, bFirstVocalMs: 400 });
  const ranked = kit.rankStyles(ctx);
  for (const id of ['echoOut', 'reverbOut', 'loopRoll', 'doubleDrop', 'dropSwap']) {
    const row = byId(ranked, id);
    assert.ok(row.blockedBy !== undefined, `${id} 应当被挡`);
    assert.match(row.blockedBy, /1500ms|无前奏/);
  }
  // B 首句来得晚（有 6 s 空档）时，echoOut 重新可选
  const late = kit.rankStyles(idealCtx({ bHasIntro: false, bFirstVocalMs: 6000 }));
  assert.equal(byId(late, 'echoOut').blockedBy, undefined);
});

test('门控：没有 downbeat 时只剩硬切类可用', () => {
  const ranked = kit.rankStyles(idealCtx({ hasDownbeat: false }));
  for (const row of ranked) {
    const ok = row.spec.id === 'cut' || row.spec.id === 'slam';
    assert.equal(
      row.blockedBy === undefined,
      ok,
      `${row.spec.id} 在无 downbeat 下可选性不对`,
    );
  }
  assert.deepEqual(kit.pickStyle(idealCtx({ hasDownbeat: false })).spec.id, 'cut');
});

test('门控：拍号不一致时乐句类手法被挡，且理由写明拍号', () => {
  const ranked = kit.rankStyles(idealCtx({ meterB: 3 }));
  assert.match(byId(ranked, 'longBlend').blockedBy, /拍号不一致（4\/4 对 3\/4）/);
  assert.match(byId(ranked, 'loopRoll').blockedBy, /拍号/);
  assert.equal(byId(ranked, 'cut').blockedBy, undefined);
});

test('门控：halfTime 只在 2:1 / 1:2 关系下可选', () => {
  const half = kit.rankStyles(idealCtx({ bpmB: 64, barMs: 3750 }));
  assert.equal(byId(half, 'halfTime').blockedBy, undefined);
  assert.equal(half[0].spec.id, 'halfTime', '半速关系下 halfTime 应当排第一');
  // 2:1 关系下，非 halfTime 风格按 50% 实际变速处理，应当被硬限挡掉
  assert.match(byId(half, 'bassSwap').blockedBy, /硬限 12%/);

  const notHalf = kit.rankStyles(idealCtx({ bpmB: 90 }));
  assert.match(byId(notHalf, 'halfTime').blockedBy, /不是 2:1/);
});

test('门控：doubling / loopRoll 需要 loop 单元', () => {
  const ranked = kit.rankStyles(idealCtx({ aLoopUnits: 0, bLoopUnits: 0 }));
  assert.match(byId(ranked, 'loopRoll').blockedBy, /loop 单元/);
  assert.match(byId(ranked, 'doubling').blockedBy, /loop 单元/);
});

test('打分：同速同调时 longBlend / bassSwap 排在最前，且理由可解释', () => {
  const ranked = kit.rankStyles(idealCtx());
  assert.ok(['longBlend', 'bassSwap'].includes(ranked[0].spec.id), `实际第一是 ${ranked[0].spec.id}`);
  assert.ok(ranked[0].score > 0);
  assert.ok(ranked[0].reasons.length >= 3);
  assert.ok(
    ranked[0].reasons.some((r) => r.includes('%')),
    '理由里要有具体百分比，便于解释',
  );
  const picked = kit.pickStyle(idealCtx());
  assert.ok(picked !== null && picked.blockedBy === undefined);
  assert.ok(['longBlend', 'bassSwap'].includes(picked.spec.id));
});

test('打分：rankStyles 稳定排序（同分按目录顺序，两次调用完全一致）', () => {
  const once = kit.rankStyles(idealCtx({ bpmB: 120, keyGap: 3, energyGap: 0.3 }));
  const twice = kit.rankStyles(idealCtx({ bpmB: 120, keyGap: 3, energyGap: 0.3 }));
  assert.deepEqual(
    once.map((r) => [r.spec.id, r.score]),
    twice.map((r) => [r.spec.id, r.score]),
  );
  for (let i = 1; i < once.length; i += 1) {
    assert.ok(once[i - 1].score >= once[i].score, '分数必须单调不增');
    if (once[i - 1].score === once[i].score) {
      const prev = TRANSITION_STYLE_IDS.indexOf(once[i - 1].spec.id);
      const cur = TRANSITION_STYLE_IDS.indexOf(once[i].spec.id);
      assert.ok(prev < cur, '同分时必须保持目录顺序');
    }
  }
});

test('稳健性：pickStyle 在缺字段 / 非法字段下都不抛', () => {
  const cases = [
    undefined,
    {},
    { bpmA: 128 },
    { bpmA: NaN, bpmB: NaN, keyGap: NaN },
    { bpmA: -1, bpmB: 0, barMs: 0, fadeMsWanted: -5 },
    { bpmA: 128, bpmB: 128, keyGap: 99, energyGap: 9, aLoopUnits: -3 },
  ];
  for (const ctx of cases) {
    assert.doesNotThrow(() => kit.pickStyle(ctx));
    assert.doesNotThrow(() => kit.rankStyles(ctx));
    const picked = kit.pickStyle(ctx);
    assert.ok(picked === null || picked.blockedBy === undefined);
  }
  // 空上下文也要给出一个可用的兜底
  const empty = kit.pickStyle({});
  assert.ok(empty !== null, '空上下文不应返回 null');
  assert.ok(empty.fadeMs >= empty.spec.minFadeMs && empty.fadeMs <= empty.spec.maxFadeMs);
});

test('时长：fadeMs 永远被夹在窗口内，并对齐到整小节', () => {
  for (const row of kit.rankStyles(idealCtx({ fadeMsWanted: 30000 }))) {
    assert.ok(row.fadeMs >= row.spec.minFadeMs, `${row.spec.id} fadeMs 不低于下限`);
    assert.ok(row.fadeMs <= row.spec.maxFadeMs, `${row.spec.id} fadeMs 不超过上限`);
  }
  const bass = byId(kit.rankStyles(idealCtx({ fadeMsWanted: 16000 })), 'bassSwap');
  assert.equal(bass.fadeMs, 16875, '16000ms 应对齐到 9 小节（1875 × 9）');
});

test('文案：describeStyle 覆盖全部风格且都有实质内容', () => {
  for (const id of EXPECTED_IDS) {
    const text = kit.describeStyle(id);
    assert.equal(typeof text, 'string');
    assert.ok(text.trim().length >= 30, `${id} 的说明太短`);
  }
  assert.notEqual(kit.describeStyle('bassSwap'), kit.describeStyle('longBlend'));
  // 未知 id 也要返回兜底文案而不是抛
  assert.ok(kit.describeStyle('nope').length > 0);
});

test('参数表：styleParamTable 与目录同序，且返回副本', () => {
  const table = kit.styleParamTable();
  assert.equal(table.length, STYLE_CATALOG.length);
  assert.deepEqual(
    Array.from(table, (row) => row.id),
    Array.from(STYLE_CATALOG, (spec) => spec.id),
  );
  for (let i = 0; i < table.length; i += 1) {
    assert.deepEqual(table[i].params, STYLE_CATALOG[i].params);
    assert.equal(table[i].minFadeMs, STYLE_CATALOG[i].minFadeMs);
    assert.equal(table[i].maxFadeMs, STYLE_CATALOG[i].maxFadeMs);
  }
  table[0].params.bars = 999;
  assert.notEqual(STYLE_CATALOG[0].params.bars, 999, '参数表必须是副本');
});

test('映射：每种风格都声明了它要占用的 DSP 原语', () => {
  const expected = {
    bassSwap: ['split', 'duck', 'tempo'],
    eqSwap: ['split', 'sweep', 'duck', 'tempo'],
    filterSweep: ['sweep', 'tempo'],
    echoOut: ['echo', 'tailHold'],
    reverbOut: ['reverb', 'tailHold'],
    loopRoll: ['bridge', 'tailHold'],
    backspin: ['cut', 'tailHold'],
    slam: ['cut'],
    dropSwap: ['cut', 'bridge'],
    doubleDrop: ['split', 'duck', 'tempo'],
    doubling: ['split', 'duck', 'bridge', 'tempo'],
    acapellaOverlay: ['duck', 'bridge', 'introBridge', 'tempo'],
    halfTime: ['tempo', 'split'],
    keyLift: ['bridge', 'introBridge', 'tempo'],
    longBlend: ['split', 'sweep', 'duck', 'tempo'],
    cut: ['cut'],
  };
  for (const spec of STYLE_CATALOG) {
    assert.deepEqual(
      Array.from(spec.requires).sort(),
      expected[spec.id].slice().sort(),
      `${spec.id} 的原语映射`,
    );
  }
});
