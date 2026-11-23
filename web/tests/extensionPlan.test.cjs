'use strict';
/**
 * 自延长（extensionPlan）纯函数测试：A 尾/ B 前奏的单元挑选、遍数、
 * 质量门（接缝跳变 / 谱质心漂移 / 响度差）与模型回落。
 * 另测 v2Plan 新增 windowScale/swapShareBias 的默认逐位不变。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(rel) {
  const file = path.join(__dirname, '..', rel);
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, console, Math, Number, Float32Array, Infinity });
  return module.exports;
}

const ext = load('src/core/automix/extensionPlan.ts');
const v2 = load('src/core/automix/v2Plan.ts');

const BAR = 2000;

function analysis(overrides = {}) {
  const times = [];
  const lufs = [];
  for (let t = 0; t <= 64000; t += 500) {
    times.push(t);
    lufs.push(-10);
  }
  const centroids = [];
  for (let i = 0; i < 64; i += 1) centroids.push(2000);
  return {
    audibleEndMs: 64000,
    barMs: BAR,
    loudnessLufs: -10,
    loudnessTimesMs: times,
    momentaryLufs: lufs,
    styleFeatures: { hopMs: 1000, centroidHz: centroids },
    loopUnits: [
      { startMs: 48000, endMs: 64000, bars: 8, score: 0.9, kind: 'tail' },
    ],
    ...overrides,
  };
}

const policy = { extension: { aTailBars: 4, bIntroBars: 4, maxMs: 32000 } };

test('A 尾：取最后循环单元，一遍补满缺口', () => {
  const plan = ext.planExtension({
    analysis: analysis(),
    side: 'a',
    neededMs: 6000,
    policy,
    barMs: BAR,
  });
  assert.equal(plan.source, 'a-tail');
  assert.equal(plan.unitStartMs, 48000);
  assert.equal(plan.unitMs, 16000);
  assert.equal(plan.passes, 1);
  assert.equal(plan.targetMs, 16000);
  assert.equal(plan.seamMs, 2);
  assert.ok(plan.gainDb >= -1 && plan.gainDb <= 1);
});

test('A 尾：缺 audibleEnd 时拒绝', () => {
  const plan = ext.planExtension({
    analysis: analysis({ audibleEndMs: undefined }),
    side: 'a',
    neededMs: 6000,
    policy,
    barMs: BAR,
  });
  assert.equal(plan.source, 'none');
  assert.equal(plan.targetMs, 0);
  assert.match(plan.reason, /可听结尾/);
});

test('A 尾：没有循环单元时回 none', () => {
  const plan = ext.planExtension({
    analysis: analysis({ loopUnits: [] }),
    side: 'a',
    neededMs: 6000,
    policy,
    barMs: BAR,
  });
  assert.equal(plan.source, 'none');
  assert.match(plan.reason, /没有可用/);
});

test('A 尾：遍数×小节超过 8 小节上限时拒绝', () => {
  const plan = ext.planExtension({
    analysis: analysis(),
    side: 'a',
    neededMs: 30000,
    policy,
    barMs: BAR,
  });
  assert.equal(plan.source, 'none');
  assert.match(plan.reason, /小节/);
});

test('A 尾：接缝能量跳变超过 1.5 dB 时拒绝', () => {
  const times = [];
  const lufs = [];
  for (let t = 0; t <= 64000; t += 250) {
    times.push(t);
    // 单元头 500ms 窗口安静、单元尾 500ms 窗口很响 → 循环回到头时 8 dB 的台阶。
    lufs.push(t >= 49000 ? -4 : -12);
  }
  const plan = ext.planExtension({
    analysis: analysis({ loudnessTimesMs: times, momentaryLufs: lufs }),
    side: 'a',
    neededMs: 6000,
    policy,
    barMs: BAR,
  });
  assert.equal(plan.source, 'none');
  assert.ok(plan.metrics && plan.metrics.seamJumpDb > 1.5);
});

test('A 尾：谱质心漂移超过 10% 时拒绝', () => {
  const centroids = [];
  for (let i = 0; i < 64; i += 1) centroids.push(i < 24 ? 600 : 2400);
  const plan = ext.planExtension({
    analysis: analysis({ styleFeatures: { hopMs: 1000, centroidHz: centroids } }),
    side: 'a',
    neededMs: 6000,
    policy,
    barMs: BAR,
  });
  assert.equal(plan.source, 'none');
  assert.ok(plan.metrics && plan.metrics.centroidDrift > 0.1);
});

test('A 尾：响度差超过 1 LU 时拒绝', () => {
  const plan = ext.planExtension({
    analysis: analysis({ loudnessLufs: -6 }),
    side: 'a',
    neededMs: 6000,
    policy,
    barMs: BAR,
  });
  assert.equal(plan.source, 'none');
  assert.ok(plan.metrics && Math.abs(plan.metrics.loudnessDiffLu) > 1);
});

test('B 前奏：优先 kind=repeat 的循环单元，至少两遍', () => {
  const plan = ext.planExtension({
    analysis: analysis({
      cueInMs: 16000,
      loopUnits: [
        { startMs: 0, endMs: 8000, bars: 4, score: 0.8, kind: 'repeat' },
        { startMs: 8000, endMs: 16000, bars: 4, score: 0.95, kind: 'tail' },
      ],
    }),
    side: 'b',
    neededMs: 12000,
    policy,
    barMs: BAR,
  });
  assert.equal(plan.source, 'b-intro');
  assert.equal(plan.unitStartMs, 0);
  assert.equal(plan.unitMs, 8000);
  assert.equal(plan.passes, 2);
  assert.equal(plan.targetMs, 16000);
});

test('B 前奏：没有 repeat 单元时退到前奏开头若干小节', () => {
  const plan = ext.planExtension({
    analysis: analysis({ cueInMs: 16000, loopUnits: [] }),
    side: 'b',
    neededMs: 12000,
    policy,
    barMs: BAR,
  });
  assert.equal(plan.source, 'b-intro');
  assert.equal(plan.unitStartMs, 0);
  assert.equal(plan.unitMs, 8000);
  assert.equal(plan.passes, 2);
});

test('模型产物：preferModel + modelReady 且响度合格时直接用模型', () => {
  const base = analysis({
    extension: { v: 1, source: 'model', model: 'tiny', file: 'extend/x.flac', startMs: 0, durationMs: 8000, loudnessLufs: -10 },
  });
  const plan = ext.planExtension({
    analysis: base, side: 'a', neededMs: 6000, policy, barMs: BAR,
    preferModel: true, modelReady: true,
  });
  assert.equal(plan.source, 'model');
  assert.equal(plan.passes, 1);
  assert.equal(plan.targetMs, 8000);
});

test('模型产物：响度差超限时回落到循环单元', () => {
  const base = analysis({
    extension: { v: 1, source: 'model', model: 'tiny', file: 'extend/x.flac', startMs: 0, durationMs: 8000, loudnessLufs: -18 },
  });
  const plan = ext.planExtension({
    analysis: base, side: 'a', neededMs: 6000, policy, barMs: BAR,
    preferModel: true, modelReady: true,
  });
  assert.equal(plan.source, 'a-tail');
});

test('v2Plan：windowScale/swapShareBias 默认值与显式 1/0 逐位一致', () => {
  const args = { fadeMs: 16000, barMs: BAR, rate: 1, swapShare: 0.25, bEntry: true };
  const plain = v2.buildV2Plan(args);
  const explicit = v2.buildV2Plan({ ...args, windowScale: 1, swapShareBias: 0 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(explicit)), JSON.parse(JSON.stringify(plain)));
  assert.equal(Object.prototype.hasOwnProperty.call(plain, 'duckScale'), false);
});

test('v2Plan：windowScale 只改变小节口径，swapShareBias 推动换手点', () => {
  const args = { fadeMs: 16000, barMs: BAR, rate: 1, swapShare: 0.25, bEntry: true };
  const wide = v2.buildV2Plan({ ...args, windowScale: 1.4 });
  assert.equal(wide.totalBars, 11);
  const biased = v2.buildV2Plan({ ...args, swapShareBias: 0.15 });
  assert.ok(biased.swapStartP <= v2.buildV2Plan(args).swapStartP);
});
