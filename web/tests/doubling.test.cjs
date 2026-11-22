'use strict';
/** doubling 纯函数单测：窗口太短拒绝、半拍切片、连打遍数与 lead 一致、优先 drop 落点、非法输入。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.resolve(__dirname, '..', 'node_modules', 'typescript'));

function load() {
  const file = path.resolve(__dirname, '..', 'src', 'core', 'automix', 'doubling.ts');
  const src = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require, console }, { filename: file });
  return module.exports;
}
const doubling = load();
const b = { bpm: 128, beatIntervalMs: 468, meter: 4, audibleEndMs: 240_000, sections: [], downbeats: [], phraseStartsMs: [] };

test('窗口比一小节还短 → 不启用', () => {
  assert.equal(doubling.planDoubling({ b, fromMs: 0, beatMs: 468, barMs: 1_875, fadeMs: 1_500 }).enabled, false);
});

test('切片是半拍，遍数 × 切片 = lead', () => {
  const p = doubling.planDoubling({ b, fromMs: 0, beatMs: 500, barMs: 2_000, fadeMs: 12_000 });
  assert.equal(p.enabled, true);
  assert.equal(p.sliceMs, 250);
  assert.equal(p.repeats * p.sliceMs, p.leadMs);
  assert.ok(p.leadMs <= 2_000 + 1);
});

test('优先用 drop 落点当素材起点', () => {
  const p = doubling.planDoubling({ b, fromMs: 3_000, beatMs: 500, barMs: 2_000, fadeMs: 12_000, preferStartMs: 61_000 });
  assert.equal(p.sliceStartFileMs, 61_000);
});

test('没有 drop 落点时退回 B 的起播点', () => {
  const p = doubling.planDoubling({ b, fromMs: 3_000, beatMs: 500, barMs: 2_000, fadeMs: 12_000 });
  assert.equal(p.sliceStartFileMs, 3_000);
});

test('非法 beatMs/barMs 不产生 NaN，且 lead 不超过窗口一半', () => {
  const p = doubling.planDoubling({ b, fromMs: 0, beatMs: Number.NaN, barMs: Number.NaN, fadeMs: 4_000 });
  assert.equal(p.enabled, true);
  assert.ok(Number.isFinite(p.sliceMs) && p.sliceMs > 0);
  assert.ok(p.leadMs <= 2_000);
});
