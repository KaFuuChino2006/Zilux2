'use strict';
/** appleRecipes：配方是否被正确解析、映射出的参数是否符合逆向报告里的数字。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.resolve(__dirname, '..', 'node_modules', 'typescript'));

function load() {
  const file = path.resolve(__dirname, '..', 'src', 'core', 'automix', 'appleRecipes.ts');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require, console }, { filename: file });
  return module.exports;
}
const r = load();

test('配方骨架：11 种可映射风格，时长以小节计', () => {
  assert.ok(r.APPLE_RECIPES.length >= 10);
  const byId = new Map(r.APPLE_RECIPES.map((x) => [x.id, x]));
  assert.equal(byId.get(8).bars, 8);
  assert.equal(byId.get(16).bars, 4);
  assert.equal(byId.get(5).bars, 2);
});

test('风格 16（Pop - Delay out）：A 在 37.5% 起让、50% 让完，B 高通 5200→20 Hz', () => {
  const p = r.applePlanFor(16);
  assert.ok(p);
  assert.ok(Math.abs(p.swapStartP - 0.375) < 1e-6);
  assert.ok(Math.abs(p.aGoneP - 0.5) < 1e-6);
  assert.equal(p.aLp.fromHz, 20000);
  assert.equal(p.aLp.toHz, 3500);
  assert.ok(p.bHp && p.bHp.fromHz === 5200 && p.bHp.toHz === 20);
});

test('风格 8（BM - Filter high to low）：A 低通 20k→200、B 高通 20k→10、变速 1→2', () => {
  const p = r.applePlanFor(8);
  assert.equal(p.bars, 8);
  assert.equal(p.aLp.fromHz, 20000);
  assert.equal(p.aLp.toHz, 200);
  assert.equal(p.bHp.fromHz, 20000);
  assert.equal(p.bHp.toHz, 10);
  assert.ok(p.tsRate && p.tsRate.v0 === 1 && p.tsRate.v1 === 2);
});

test('风格 16 的延迟：反馈 60%、阻尼 3500 Hz、延迟 1 拍', () => {
  const p = r.applePlanFor(16);
  assert.ok(p.echo);
  assert.ok(Math.abs(p.echo.feedback - 0.6) < 1e-6);
  assert.equal(p.echo.dampHz, 3500);
  assert.equal(p.echo.divBeats, 1);
});

test('风格 20（Pop - Reverb）：有混响送出与衰减参数', () => {
  const p = r.applePlanFor(20);
  assert.ok(p.reverb);
  assert.ok(p.reverb.decaySec >= 0.3);
  assert.ok(p.reverb.t1 > p.reverb.t0);
});

test('未映射 id 返回 null，不抛', () => {
  assert.equal(r.applePlanFor(999), null);
  assert.equal(r.applePlanFor(null), null);
});
