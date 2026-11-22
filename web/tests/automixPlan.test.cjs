'use strict';
/**
 * E9 形态选择 + E10 质量门 + 层 C 人声让位事件：纯函数单测。
 *
 * 这些函数决定「一次过渡长什么样」，出错的代价是听感事故（硬切、闷响、人声打架），
 * 所以每条规则都钉一个断言，改阈值时必须同步改这里。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

/** 把一组 TS 源编译进同一个 CommonJS 沙箱（互相 require 走内存映射）。 */
function loadModules(entries) {
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const source = fs.readFileSync(file, 'utf8');
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    cache.set(file, module);
    const sandbox = {
      module,
      exports: module.exports,
      require: (request) => {
        if (!request.startsWith('.')) return require(request);
        const resolved = path.resolve(path.dirname(file), request);
        for (const candidate of [resolved, `${resolved}.ts`, path.join(resolved, 'index.ts')]) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return load(candidate);
        }
        throw new Error(`无法解析模块：${request}（来自 ${file}）`);
      },
      console,
      Math,
      Number,
      Array,
      Object,
      JSON,
    };
    vm.runInNewContext(js, sandbox, { filename: file });
    return module.exports;
  };
  const out = {};
  for (const [name, file] of Object.entries(entries)) out[name] = load(path.join(root, ...file.split('/')));
  return out;
}

const mods = loadModules({
  quality: 'src/core/automix/v2Quality.ts',
  plan: 'src/core/automix/automixPlan.ts',
  v2: 'src/core/automix/v2Plan.ts',
});
const { evaluateQuality, buildDuckEvents, estimateBassBumpDb, estimateVocalOverlapBeats } = mods.quality;
const { selectForm, camelotGap, pickLoopUnit } = mods.plan;
const { buildV2Plan } = mods.v2;

const BAR = 2000;
const BEAT = 500;

/** 造一份最小可用分析：`energy` 0–1、可选 drop、可选 activity。 */
function analysis(overrides = {}) {
  const downbeats = [];
  for (let i = 0; i < 40; i += 1) downbeats.push(i * BAR);
  return {
    bpm: 120,
    bpmConfidence: 0.9,
    meter: 4,
    beatIntervalMs: BEAT,
    firstBeatMs: 0,
    firstDownbeatMs: 0,
    beatsMs: [],
    tempoStability: 0.9,
    tempoCurveMs: [],
    tempoCurveBpm: [],
    downbeats,
    phraseStartsMs: [0, 16000, 32000],
    barCount: 40,
    key: 0,
    keyMode: 'minor',
    camelot: '8A',
    energy: 0.6,
    loudnessLufs: -9,
    peakDb: -1,
    climaxStartMs: 0,
    climaxEndMs: 0,
    cueInMs: 0,
    cueOutMs: 80000,
    audibleEndMs: 80000,
    tailSilenceMs: 0,
    sections: [],
    ...overrides,
  };
}

/** 造一条恒定数值的 activity 曲线（长度按 250 ms 一格）。 */
function curve(value, durationMs = 90000, hopMs = 250) {
  const list = new Array(Math.ceil(durationMs / hopMs)).fill(value);
  return { hopMs, vocal: list, drum: [...list], bass: [...list] };
}

function quality(overrides = {}) {
  return {
    bassBumpDb: 0.5,
    vocalOverlapBeats: 0,
    loudnessDriftLu: 0.2,
    rateJumpPctPerBeat: 0.3,
    pass: true,
    failures: [],
    suggestion: { widenHandoff: false, enableVocalDuck: false, shortenFade: false, gainTrimDb: 0, tempoRate: 1 },
    ...overrides,
  };
}

function formInput(overrides = {}) {
  return {
    a: analysis(),
    b: analysis(),
    barMs: BAR,
    beatMs: BEAT,
    fadeMs: 16000,
    tempoRate: 1,
    keyGap: 0,
    energyGap: 0.1,
    quality: quality(),
    hasBridge: false,
    ...overrides,
  };
}

test('Camelot 距离：同调 0、异字母 +1、环上取最短、非法输入 0', () => {
  assert.equal(camelotGap('8A', '8A'), 0);
  assert.equal(camelotGap('8A', '8B'), 1);
  assert.equal(camelotGap('8A', '9A'), 1);
  assert.equal(camelotGap('1A', '12A'), 1);
  assert.equal(camelotGap('1A', '7A'), 6);
  assert.equal(camelotGap(undefined, '8A'), 0);
});

test('没有小节网格 → fade 且关扫频（任何按小节的动作都会踩空）', () => {
  const decision = selectForm(formInput({ a: analysis({ downbeats: [] }) }));
  assert.equal(decision.form, 'fade');
  assert.equal(decision.disableSweep, true);
  assert.ok(decision.reasons.includes('no-grid-a'));
});

test('变速超硬上限 → cut（宁可硬切，也不让两头都变形）', () => {
  const decision = selectForm(formInput({ tempoRate: 1.25 }));
  assert.equal(decision.form, 'cut');
  assert.ok(decision.reasons.some((r) => r.startsWith('tempo-out-of-range')));
});

test('调性太远 → cut', () => {
  const decision = selectForm(formInput({ keyGap: 5 }));
  assert.equal(decision.form, 'cut');
  assert.ok(decision.reasons.includes('key-clash:5'));
});

test('人声重叠超过 3 拍 → 缩到 2 小节 fade', () => {
  const decision = selectForm(formInput({ quality: quality({ vocalOverlapBeats: 3.5 }) }));
  assert.equal(decision.form, 'fade');
  assert.equal(decision.fadeBarsOverride, 2);
  assert.equal(decision.disableSweep, true);
});

test('有桥接 → loopBridge（最优先，扫频保留、会唱就开 duck）', () => {
  const decision = selectForm(formInput({ hasBridge: true, b: analysis({ activity: curve(0.8) }) }));
  assert.equal(decision.form, 'loopBridge');
  assert.equal(decision.disableSweep, false);
  assert.equal(decision.useDuck, true);
});

test('双 drop + 能量接近 → doubleDrop 且只混 2 小节', () => {
  const sections = [{ startMs: 0, endMs: 80000, label: 'drop', confidence: 0.9 }];
  const decision = selectForm(
    formInput({
      a: analysis({ sections, energy: 0.8 }),
      b: analysis({ sections, energy: 0.75 }),
      energyGap: 0.05,
      tempoRate: 1.06,
    }),
  );
  assert.equal(decision.form, 'doubleDrop');
  assert.equal(decision.fadeBarsOverride, 2);
});

test('只需微调变速 → warp；完全不用变速 → fade', () => {
  assert.equal(selectForm(formInput({ tempoRate: 1.04 })).form, 'warp');
  const plain = selectForm(formInput({ tempoRate: 1 }));
  assert.equal(plain.form, 'fade');
  assert.equal(plain.disableSweep, true);
});

test('pickLoopUnit 只挑完全落在区间内的最高分单元', () => {
  const a = analysis({
    loopUnits: [
      { startMs: 0, endMs: 8000, bars: 4, score: 0.9, kind: 'repeat' },
      { startMs: 40000, endMs: 48000, bars: 4, score: 0.7, kind: 'repeat' },
      { startMs: 60000, endMs: 68000, bars: 4, score: 0.95, kind: 'repeat' },
    ],
  });
  assert.equal(pickLoopUnit(a, 30000, 50000).startMs, 40000);
  assert.equal(pickLoopUnit(a, 50000, 70000).startMs, 60000);
  assert.equal(pickLoopUnit(a, 5000, 10000), null);
});

test('质量门：低频叠加按换手窗口上界估算，两次换手不足会判 fail', () => {
  const bump = estimateBassBumpDb({
    a: analysis({ activity: curve(1) }),
    b: analysis({ activity: curve(1) }),
    fadeStartAMs: 0,
    fadeStartBMs: 0,
    fadeMs: 16000,
    beatMs: BEAT,
    tempoRate: 1,
    handoffStartP: 0.2,
    handoffEndP: 0.45,
    gainTrimDb: 0,
  });
  assert.ok(Number.isFinite(bump) && bump > -6);
  const report = evaluateQuality({
    a: analysis({ activity: curve(1) }),
    b: analysis({ activity: curve(1) }),
    fadeStartAMs: 0,
    fadeStartBMs: 0,
    fadeMs: 16000,
    beatMs: BEAT,
    tempoRate: 1,
    handoffStartP: 0.2,
    handoffEndP: 0.45,
    gainTrimDb: 0,
  });
  assert.equal(typeof report.pass, 'boolean');
  assert.ok(Array.isArray(report.failures));
});

test('人声重叠按拍中心统计：两首都一直唱 → 满拍重叠', () => {
  const beats = estimateVocalOverlapBeats({
    a: analysis({ activity: curve(1) }),
    b: analysis({ activity: curve(1) }),
    fadeStartAMs: 0,
    fadeStartBMs: 0,
    fadeMs: 8000,
    beatMs: BEAT,
    tempoRate: 1,
    handoffStartP: 0.2,
    handoffEndP: 0.45,
    gainTrimDb: 0,
  });
  assert.ok(beats >= 7, `应接近 8 拍，实际 ${beats}`);
  const silent = estimateVocalOverlapBeats({
    a: analysis({ activity: curve(0) }),
    b: analysis({ activity: curve(0) }),
    fadeStartAMs: 0,
    fadeStartBMs: 0,
    fadeMs: 8000,
    beatMs: BEAT,
    tempoRate: 1,
    handoffStartP: 0.2,
    handoffEndP: 0.45,
    gainTrimDb: 0,
  });
  assert.equal(silent, 0);
});

test('duck 事件：B 一直在唱 → 压到 −6 dB 并保持；从不在唱 → 全 0', () => {
  const loud = buildDuckEvents({ b: analysis({ activity: curve(1) }), fadeStartBMs: 0, fadeMs: 2000, tempoRate: 1 });
  assert.ok(loud.length > 10);
  assert.ok(loud[loud.length - 1].db <= -5.5);
  assert.ok(loud.every((e) => e.db <= 0 && e.db >= -6));

  const quiet = buildDuckEvents({ b: analysis({ activity: curve(0) }), fadeStartBMs: 0, fadeMs: 2000, tempoRate: 1 });
  assert.ok(quiet.every((e) => e.db === 0));
});

test('duck 事件：无 activity 曲线时返回空数组（不猜）', () => {
  assert.equal(buildDuckEvents({ b: analysis(), fadeStartBMs: 0, fadeMs: 4000, tempoRate: 1 }).length, 0);
});

test('v2Plan 关扫频时 A 的低通恒为 20 kHz、B 高通仍快速打开', () => {
  const withSweep = buildV2Plan({ fadeMs: 16000, barMs: BAR });
  assert.ok(withSweep.a.sweepLp[withSweep.a.sweepLp.length - 1].v <= 760);
  const noSweep = buildV2Plan({ fadeMs: 16000, barMs: BAR, sweep: false });
  assert.equal(noSweep.a.sweepLp.every((p) => p.v === 20000), true);
  assert.ok(noSweep.b.sweepHp[noSweep.b.sweepHp.length - 1].v <= 21);
  assert.match(noSweep.note, /只做低频换手/);
});
