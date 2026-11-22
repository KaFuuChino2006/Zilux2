'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.resolve(__dirname, '..', 'node_modules', 'typescript'));

function load() {
  const file = path.resolve(__dirname, '..', 'src', 'core', 'automix', 'echoTail.ts');
  const src = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const ctx = { module, exports: module.exports, require, console };
  vm.runInNewContext(js, ctx, { filename: file });
  return module.exports;
}

const mod = load();

test('窗口 > 4.2 s 不做回声', () => {
  const p = mod.planEchoTail({ fadeMs: 9000, beatMs: 500, keyGap: 0 });
  assert.equal(p.enabled, false);
});

test('短窗口启用，延迟对齐到拍', () => {
  const p = mod.planEchoTail({ fadeMs: 2600, beatMs: 480, keyGap: 0 });
  assert.equal(p.enabled, true);
  assert.equal(p.divBeats, 1);
  assert.equal(p.delayMs, 480);
  assert.equal(p.tailMs, 1500);
});

test('调性越远：延迟更短、反馈更小、尾巴更短、更暗', () => {
  const near = mod.planEchoTail({ fadeMs: 2400, beatMs: 500, keyGap: 0 });
  const mid = mod.planEchoTail({ fadeMs: 2400, beatMs: 500, keyGap: 3 });
  const far = mod.planEchoTail({ fadeMs: 2400, beatMs: 500, keyGap: 5 });
  assert.ok(near.delayMs > mid.delayMs && mid.delayMs > far.delayMs);
  assert.ok(near.feedback > mid.feedback && mid.feedback > far.feedback);
  assert.ok(near.tailMs > mid.tailMs && mid.tailMs > far.tailMs);
  assert.ok(near.dampHz > far.dampHz);
});

test('尾巴受窗口约束，且不低于 400 ms', () => {
  const p = mod.planEchoTail({ fadeMs: 1200, beatMs: 500, keyGap: 0 });
  assert.equal(p.tailMs, 960); // min(1500, 1200*0.8)
  const tiny = mod.planEchoTail({ fadeMs: 300, beatMs: 500, keyGap: 0 });
  assert.equal(tiny.tailMs, 400);
});

test('beatMs 非法时回落 500', () => {
  const p = mod.planEchoTail({ fadeMs: 2000, beatMs: 0, keyGap: 0 });
  assert.equal(p.delayMs, 500);
});

test('送出包络：起点前为 0，到窗口末为 1', () => {
  const p = mod.planEchoTail({ fadeMs: 2400, beatMs: 500, keyGap: 0 });
  assert.equal(mod.echoSendAt(p, 0), 0);
  assert.equal(mod.echoSendAt(p, 0.5), 0);
  assert.ok(mod.echoSendAt(p, 0.8) > 0);
  assert.equal(mod.echoSendAt(p, 1), 1);
});

test('未启用时包络恒 0', () => {
  const p = mod.planEchoTail({ fadeMs: 9000, beatMs: 500, keyGap: 0 });
  assert.equal(mod.echoSendAt(p, 1), 0);
});
