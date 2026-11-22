'use strict';
/** speedRamp：分段变速折线（Apple speedRamp 的最小替身）。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.resolve(__dirname, '..', 'node_modules', 'typescript'));

function load() {
  const file = path.resolve(__dirname, '..', 'src', 'core', 'automix', 'speedRamp.ts');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require, console }, { filename: file });
  return module.exports;
}
const m = load();

test('rate = 1 时不变速，折线恒 1', () => {
  const p = m.planSpeedRamp(1);
  assert.equal(p.aEnd, 1);
  assert.equal(p.segments, 1);
  assert.equal(m.speedRampAt(p.a, 0.37), 1);
});

test('rate = 1.1 → A 减速到 1/1.1，四段，85% 完成', () => {
  const p = m.planSpeedRamp(1.1);
  assert.ok(Math.abs(p.aEnd - 1 / 1.1) < 1e-9);
  assert.equal(p.segments, 4);
  assert.equal(p.rampEndP, 0.85);
  assert.ok(Math.abs(m.speedRampAt(p.a, 0.85) - p.aEnd) < 1e-6);
  // 完成后到尾都不再动
  assert.ok(Math.abs(m.speedRampAt(p.a, 1) - p.aEnd) < 1e-6);
});

test('折线单调、每段都比上一段更接近目标（不会来回摆）', () => {
  const p = m.planSpeedRamp(0.8, 4, 0.8); // rate<1 → A 要加速到 1.25
  assert.ok(p.aEnd > 1);
  let prev = 1;
  for (let i = 0; i <= 100; i += 1) {
    const v = m.speedRampAt(p.a, i / 100);
    assert.ok(v >= prev - 1e-9, `在 p=${i / 100} 处回头了：${prev} → ${v}`);
    prev = v;
  }
  // 反向也要单调（减速）
  const q = m.planSpeedRamp(1.25, 4, 0.8);
  assert.ok(q.aEnd < 1);
  let down = 1;
  for (let i = 0; i <= 100; i += 1) {
    const v = m.speedRampAt(q.a, i / 100);
    assert.ok(v <= down + 1e-9, `减速时在 p=${i / 100} 处回头了：${down} → ${v}`);
    down = v;
  }
});

test('segments = 1 退化成单段直线（近似 Apple 的一条 time mapping）', () => {
  const p = m.planSpeedRamp(1.2, 1, 1);
  assert.equal(p.segments, 1);
  const mid = m.speedRampAt(p.a, 0.5);
  const expect = 1 + (1 / 1.2 - 1) * 0.5;
  assert.ok(Math.abs(mid - expect) < 0.02, `${mid} vs ${expect}`);
});

test('非法输入回落：rate=NaN → 不变速；segments 越界夹取', () => {
  assert.equal(m.planSpeedRamp(Number.NaN).aEnd, 1);
  assert.equal(m.planSpeedRamp(1.1, 99).segments, 8);
  assert.equal(m.planSpeedRamp(1.1, 0).segments, 1);
});

test('speedRampAt 越界夹到端点，空数组返回 1', () => {
  const p = m.planSpeedRamp(1.2);
  assert.equal(m.speedRampAt(p.a, -1), 1);
  assert.ok(Math.abs(m.speedRampAt(p.a, 2) - p.aEnd) < 1e-9);
  assert.equal(m.speedRampAt([], 0.5), 1);
});
