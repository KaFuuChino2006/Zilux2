'use strict';
/**
 * loopRoll 纯函数单测：窗口太短不启用、2–4 小节夹取、不超过窗口一半、非法输入、passes 恒 2。
 * 复用 crossfade.test.cjs 那套 vm + ts.transpileModule 装载方式。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.resolve(__dirname, '..', 'node_modules', 'typescript'));

function load() {
  const file = path.resolve(__dirname, '..', 'src', 'core', 'automix', 'loopRoll.ts');
  const src = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, require, console };
  vm.runInNewContext(js, sandbox, { filename: file });
  return module.exports;
}

const loopRoll = load();

test('窗口太短不启用', () => {
  assert.equal(loopRoll.planLoopRoll({ fadeMs: 1_900, barMs: 2_000 }).enabled, false);
});

test('两小节夹取到一半窗口', () => {
  const p = loopRoll.planLoopRoll({ fadeMs: 12_000, barMs: 2_000, unitBars: 2 });
  assert.equal(p.enabled, true);
  assert.equal(p.unitMs, 4_000);
  assert.equal(p.passes, 2);
});

test('四小节也不超过窗口一半', () => {
  const p = loopRoll.planLoopRoll({ fadeMs: 6_000, barMs: 2_000, unitBars: 4 });
  assert.equal(p.enabled, true);
  assert.ok(p.unitMs <= 3_000, `unitMs=${p.unitMs}`);
  assert.equal(p.unitMs, 3_000);
});

test('非法输入不返回 NaN', () => {
  const p = loopRoll.planLoopRoll({ fadeMs: 12_000, barMs: Number.NaN });
  assert.equal(p.enabled, true);
  assert.ok(Number.isFinite(p.unitMs) && p.unitMs >= loopRoll.LOOP_ROLL_MIN_MS);
});

test('passes 恒为 2、接缝固定 2 ms', () => {
  for (const bars of [1, 2, 3, 4, 9]) {
    const p = loopRoll.planLoopRoll({ fadeMs: 20_000, barMs: 2_000, unitBars: bars });
    assert.equal(p.passes, 2);
    assert.equal(p.declickMs, loopRoll.LOOP_ROLL_SEAM_MS);
  }
});
