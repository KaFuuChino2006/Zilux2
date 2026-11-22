'use strict';
/**
 * 结构桥接（E8）纯函数测试：尾段挑选、补遍数求解、PCM 平铺。
 * 只测数学与决策，不碰 Web Audio（执行层在 automixV2Bridge.ts，需要真 context）。
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
  vm.runInNewContext(js, { module, exports: module.exports, console, Math, Number, Float32Array });
  return module.exports;
}

const bridge = load('src/core/automix/bridgePlan.ts');

const BAR = 2000;
const downbeats = Array.from({ length: 120 }, (_, i) => i * BAR);

test('尾段优先取 4 小节且贴强拍', () => {
  const unit = bridge.pickBridgeUnit({
    audibleEndMs: 40 * BAR,
    barMs: BAR,
    downbeats,
    sections: [{ startMs: 24 * BAR, endMs: 40 * BAR, label: 'outro', confidence: 0.8 }],
  });
  assert.ok(unit, '应当找到尾段');
  assert.equal(unit.bars, 4);
  assert.equal(unit.endMs, 40 * BAR);
  assert.equal(unit.startMs, 36 * BAR);
});

test('跨段落的 4 小节被拒，退到 2 小节', () => {
  const unit = bridge.pickBridgeUnit({
    audibleEndMs: 40 * BAR,
    barMs: BAR,
    downbeats,
    // 38 小节处换段：4 小节窗跨段，2 小节窗在 outro 里
    sections: [
      { startMs: 24 * BAR, endMs: 38 * BAR, label: 'chorus', confidence: 0.9 },
      { startMs: 38 * BAR, endMs: 40 * BAR, label: 'outro', confidence: 0.9 },
    ],
  });
  assert.ok(unit);
  assert.equal(unit.bars, 2);
  assert.equal(unit.startMs, 38 * BAR);
});

test('尾段置信度过低时不补', () => {
  const unit = bridge.pickBridgeUnit({
    audibleEndMs: 40 * BAR,
    barMs: BAR,
    downbeats,
    sections: [{ startMs: 24 * BAR, endMs: 40 * BAR, label: 'outro', confidence: 0.1 }],
  });
  assert.equal(unit, null);
});

test('起点离强拍太远（>1/4 小节）时不补', () => {
  const unit = bridge.pickBridgeUnit({
    audibleEndMs: 40 * BAR + 700,
    barMs: BAR,
    downbeats,
    sections: [],
    unitBars: [4],
  });
  assert.equal(unit, null);
});

test('自然尾奏够长时不补', () => {
  const unit = { startMs: 36 * BAR, endMs: 40 * BAR, bars: 4 };
  const plan = bridge.buildBridgePlan({
    fadeStartFileMs: 32 * BAR,
    desiredMs: 4 * BAR,
    audibleEndMs: 40 * BAR,
    barMs: BAR,
    unit,
  });
  assert.equal(plan, null);
});

test('自然尾奏 6 秒、目标 4 小节：用 2 小节尾段补 1 遍', () => {
  const unit = { startMs: 38 * BAR, endMs: 40 * BAR, bars: 2 };
  const plan = bridge.buildBridgePlan({
    fadeStartFileMs: 37 * BAR,
    desiredMs: 4 * BAR,
    audibleEndMs: 40 * BAR,
    barMs: BAR,
    unit,
  });
  assert.ok(plan);
  assert.equal(plan.passes, 2);
  assert.equal(plan.extensionMs, 2 * BAR);
  assert.equal(plan.extendedEndMs, 42 * BAR);
  assert.equal(plan.unitStartFileMs, 38 * BAR);
  // 循环点必须落在淡化起点之后，否则切换动作会打断淡化。
  assert.ok(plan.unitStartFileMs >= 37 * BAR);
});

test('4 小节尾段在短尾奏场景下会被 minStartMs 挡住', () => {
  const unit = bridge.pickBridgeUnit({
    audibleEndMs: 40 * BAR,
    barMs: BAR,
    downbeats,
    sections: [],
    minStartMs: 37 * BAR,
  });
  assert.ok(unit);
  assert.equal(unit.bars, 2, '4 小节起点太早，应退到 2 小节');
});

test('循环点落在淡化起点之前时拒绝', () => {
  const unit = { startMs: 36 * BAR, endMs: 40 * BAR, bars: 4 };
  const plan = bridge.buildBridgePlan({
    fadeStartFileMs: 37 * BAR, // 淡化起点在尾段内部
    desiredMs: 6 * BAR,
    audibleEndMs: 40 * BAR,
    barMs: BAR,
    unit,
  });
  assert.equal(plan, null);
});

test('缺口超出最大遍数时拒绝（宁可短，不硬凑）', () => {
  const unit = { startMs: 36 * BAR, endMs: 40 * BAR, bars: 4 };
  const plan = bridge.buildBridgePlan({
    fadeStartFileMs: 22 * BAR,
    desiredMs: 8 * BAR,
    audibleEndMs: 40 * BAR,
    barMs: BAR,
    unit,
    maxPasses: 3,
  });
  assert.equal(plan, null);
});

test('平铺遍数正确、长度严格等于 unit × passes', () => {
  const unitSamples = 8;
  const source = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  const out = bridge.tileLoopChannels([source], unitSamples, 3, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 24);
  for (let pass = 0; pass < 3; pass += 1) {
    for (let i = 0; i < unitSamples; i += 1) {
      assert.ok(Math.abs(out[0][pass * unitSamples + i] - source[i]) < 1e-6);
    }
  }
});

test('接缝只在边界附近压幅度，不改变长度', () => {
  const unitSamples = 64;
  const source = new Float32Array(unitSamples).fill(1);
  const out = bridge.tileLoopChannels([source], unitSamples, 2, 8);
  assert.equal(out[0].length, unitSamples * 2);
  const boundary = unitSamples;
  // 接缝正中：约 −6 dB
  assert.ok(out[0][boundary - 4] < 0.8, `接缝应压幅，实际 ${out[0][boundary - 4]}`);
  // 远离接缝处不动
  assert.ok(Math.abs(out[0][0] - 1) < 1e-6);
  assert.ok(Math.abs(out[0][unitSamples * 2 - 1] - 1) < 1e-6);
});
