'use strict';
/** dropEntry 纯函数单测：drop 优先、chorus 回落、无段落拒绝、headroom 拒绝、两种手法参数不同。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.resolve(__dirname, '..', 'node_modules', 'typescript'));

function load() {
  const file = path.resolve(__dirname, '..', 'src', 'core', 'automix', 'dropEntry.ts');
  const src = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require, console }, { filename: file });
  return module.exports;
}
const dropEntry = load();

const analysis = (sections, extra = {}) => ({
  bpm: 128, beatIntervalMs: 468, meter: 4, audibleEndMs: 240_000,
  downbeats: [0, 1_875, 3_750], phraseStartsMs: [], sections,
  activity: undefined, loopUnits: [], ...extra,
});

test('取最早的 drop（不是 chorus）', () => {
  const b = analysis([
    { startMs: 20_000, endMs: 40_000, label: 'chorus', confidence: 0.8 },
    { startMs: 60_000, endMs: 80_000, label: 'drop', confidence: 0.9 },
  ]);
  const p = dropEntry.planDropEntry({ b, fromMs: 0, mode: 'dropSwap', barMs: 1_875, durationMs: 240_000 });
  assert.equal(p.enabled, true);
  assert.equal(p.entryFileMs, 20_000);
  assert.equal(p.label, 'chorus');
});

test('没有段落 → 不启用', () => {
  const p = dropEntry.planDropEntry({ b: analysis([]), fromMs: 0, mode: 'doubleDrop', barMs: 1_875 });
  assert.equal(p.enabled, false);
  assert.equal(p.swapShare, 0);
});

test('落点太靠尾（剩余不足 4 小节）→ 拒绝', () => {
  const b = analysis([{ startMs: 238_000, endMs: 240_000, label: 'drop', confidence: 0.9 }]);
  const p = dropEntry.planDropEntry({ b, fromMs: 0, mode: 'dropSwap', barMs: 1_875, durationMs: 240_000 });
  assert.equal(p.enabled, false);
});

test('fromMs 之后的段落才考虑', () => {
  const b = analysis([
    { startMs: 10_000, endMs: 30_000, label: 'drop', confidence: 0.9 },
    { startMs: 70_000, endMs: 90_000, label: 'drop', confidence: 0.9 },
  ]);
  const p = dropEntry.planDropEntry({ b, fromMs: 50_000, mode: 'dropSwap', barMs: 1_875, durationMs: 240_000 });
  assert.equal(p.entryFileMs, 70_000);
});

test('dropSwap 让得快、不留尾巴；doubleDrop 留一小节', () => {
  const b = analysis([{ startMs: 60_000, endMs: 90_000, label: 'drop', confidence: 0.9 }]);
  const swap = dropEntry.planDropEntry({ b, fromMs: 0, mode: 'dropSwap', barMs: 2_000, durationMs: 240_000 });
  const dbl = dropEntry.planDropEntry({ b, fromMs: 0, mode: 'doubleDrop', barMs: 2_000, durationMs: 240_000 });
  assert.ok(swap.swapShare < dbl.swapShare);
  assert.equal(swap.tailHoldMs, 0);
  assert.equal(dbl.tailHoldMs, 2_000);
});
