const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('E:/Zilux2开发/web/node_modules/typescript');
const vm = require('node:vm');

const SRC = path.resolve(__dirname, '../src/core/automix/v2Quality.ts');

function load() {
  const code = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Number, Math, console });
  return module.exports;
}

const mod = load();

/** 造一首「从头到尾都在满嗓子唱」的分析，方便把重叠判到最大值。 */
function singing(bpm = 120) {
  const n = 400;
  return {
    bpm,
    activity: {
      hopMs: 250,
      vocal: new Array(n).fill(1),
      drum: new Array(n).fill(0.5),
      bass: new Array(n).fill(0.5),
    },
  };
}

/** 造一首只有 0.55 的「哼唱」：可听但不满嗓子。 */
function humming(bpm = 120) {
  const a = singing(bpm);
  a.activity.vocal = new Array(a.activity.vocal.length).fill(0.55);
  return a;
}

const base = {
  fadeStartAMs: 0,
  fadeStartBMs: 0,
  fadeMs: 8000,
  beatMs: 500,
  tempoRate: 1,
  handoffStartP: 0.8,
  handoffEndP: 0.9,
};

test('两边都满嗓子 + 远调（Camelot 5）→ 每一拍都算咬字冲突', () => {
  const beats = mod.estimateVocalClashBeats({ ...base, a: singing(), b: singing(), keyGap: 5 });
  assert.equal(beats, 16);
});

test('同调 / 近调（Camelot ≤3）→ 重叠是合唱，不算冲突', () => {
  for (const gap of [0, 1, 2, 3]) {
    const beats = mod.estimateVocalClashBeats({ ...base, a: singing(), b: singing(), keyGap: gap });
    assert.equal(beats, 0, `gap=${gap} 应该是合唱而不是打架`);
  }
});

test('调性未知（没传 keyGap）→ 按最坏情况算，不放过', () => {
  const beats = mod.estimateVocalClashBeats({ ...base, a: singing(), b: singing() });
  assert.equal(beats, 16);
});

test('一边只是哼唱（0.55）→ 不算咬字冲突', () => {
  const beats = mod.estimateVocalClashBeats({ ...base, a: singing(), b: humming(), keyGap: 5 });
  assert.equal(beats, 0);
});

test('重叠指标本身不受 keyGap 影响（不改既有语义）', () => {
  const far = mod.estimateVocalOverlapBeats({ ...base, a: singing(), b: singing(), keyGap: 5 });
  const near = mod.estimateVocalOverlapBeats({ ...base, a: singing(), b: singing(), keyGap: 0 });
  assert.equal(far, near);
  assert.ok(far > 0);
});

test('evaluateQuality 把 clash 带进报告，且不进入 failures', () => {
  const report = mod.evaluateQuality({ ...base, a: singing(), b: singing(), keyGap: 5 });
  assert.equal(typeof report.vocalClashBeats, 'number');
  assert.equal(report.vocalClashBeats, report.vocalOverlapBeats);
  // 现有门控仍按「重叠」判，clash 只做诊断，不新增失败项。
  assert.ok(!report.failures.includes('vocal-clash'));
});
