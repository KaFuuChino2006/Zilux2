// Run with: node --test web/tests/transitionWiring.test.cjs
// 接线层测试：标准模式必须完全不产出音频事件；进阶模式产出可读时间线；异常必须可回落。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function load(name, deps = {}) {
  const file = path.join(ROOT, 'src/core', name + '.ts');
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { exports, console, require: (id) => deps[id] ?? ({}) },
    { filename: file },
  );
  return exports;
}

const plan = load('transitionPlan');
const moves = load('djMoves');
const gate = load('tempoGate');
const swap = load('stemSwap', { './transitionPlan': plan, './djMoves': moves });
const wire = load('advancedTransition', { './transitionPlan': plan, './stemSwap': swap, './tempoGate': gate });

function analysis(over = {}) {
  const bpm = over.bpm ?? 120;
  const bar = (60000 / bpm) * 4;
  return {
    bpm, bpmConfidence: 0.9, meter: 4, meterConfidence: 0.9,
    beatIntervalMs: 60000 / bpm, firstBeatMs: 0, firstDownbeatMs: 0,
    downbeats: Array.from({ length: 31 }, (_, i) => i * bar),
    beatsMs: [], phraseStartsMs: Array.from({ length: 8 }, (_, i) => i * bar * 8),
    barCount: 30, sections: [], warnings: [], camelot: '8A', energy: 0.6, cueInMs: 0,
    ...over,
  };
}

const base = () => ({ analysisA: analysis(), analysisB: analysis(), positionMsA: 40000 });

test('标准模式：不产出任何事件、不产出 plan（现有过渡零影响）', () => {
  const r = wire.resolveTransition({ mode: 'standard', ...base() });
  assert.equal(r.mode, 'standard');
  assert.equal(r.plan, null);
  assert.equal(r.events.length, 0);
  assert.equal(r.totalMs, 0);
  assert.equal(r.stems.length, 0);
  assert.match(r.summary[0], /标准过渡/);
});

test('进阶模式：产出 plan + 事件 + 轨集合 + 总时长', () => {
  const r = wire.resolveTransition({ mode: 'advanced', ...base() });
  assert.equal(r.mode, 'advanced');
  assert.ok(r.plan);
  assert.ok(r.events.length > 0);
  assert.deepEqual([...r.stems].sort(), ['bass', 'drums', 'other', 'vocals']);
  assert.ok(r.totalMs >= r.plan.totalBars * r.plan.barMs * 0.25, '总时长应覆盖主体');
});

test('进阶模式：人话时间线包含模板、速率、每个动作', () => {
  const r = wire.resolveTransition({ mode: 'advanced', ...base() });
  const text = r.summary.join('\n');
  assert.match(text, /模板/);
  assert.match(text, /速率 1\.0000×/);
  assert.match(text, /小节 0：低频 换手/);
  assert.match(text, /小节 8：人声 换手/);
});

test('低置信度（0.3）→ 速度门控判标准，不产出 plan', () => {
  const r = wire.resolveTransition({
    mode: 'advanced',
    analysisA: analysis({ bpmConfidence: 0.3 }),
    analysisB: analysis(),
    positionMsA: 40000,
  });
  assert.equal(r.mode, 'standard');
  assert.equal(r.plan, null);
  assert.equal(r.events.length, 0);
  assert.ok(r.summary.some((l) => l.includes('速度门控')));
  assert.equal(r.gate.tier, 'standard');
});

test('中等置信度（0.5）→ 只换低频与鼓，人声不参与', () => {
  const r = wire.resolveTransition({
    mode: 'advanced',
    analysisA: analysis({ bpmConfidence: 0.5, tempoStability: 0.5 }),
    analysisB: analysis({ bpmConfidence: 0.5, tempoStability: 0.5 }),
    positionMsA: 40000,
  });
  assert.equal(r.mode, 'advanced');
  assert.ok(r.plan, '辅助档仍应产出方案');
  assert.equal(r.gate.tier, 'bassDrumsOnly');
  for (const stem of r.stems) assert.ok(['bass', 'drums'].includes(stem), `不应含 ${stem}`);
  assert.ok(r.summary.some((l) => l.includes('速度门控')));
});

test('fallbackToStandard：任何异常都返回可用的标准模式', () => {
  const r = wire.fallbackToStandard(new Error('decode failed'));
  assert.equal(r.mode, 'standard');
  assert.equal(r.plan, null);
  assert.equal(r.events.length, 0);
  assert.match(r.summary[0], /回落/);
  assert.match(r.summary[0], /decode failed/);
  // 非 Error 也要能处理
  assert.match(wire.fallbackToStandard('boom').summary[0], /boom/);
});

test('模式字符串拼错时按标准处理（防御性）', () => {
  const r = wire.resolveTransition({ mode: 'Advanced', ...base() });
  assert.equal(r.mode, 'standard');
  assert.equal(r.events.length, 0);
});
