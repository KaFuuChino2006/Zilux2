// Run with: node --test web/tests/transitionHandoffPoint.test.cjs
// T5-3 拖动换手点 + T5-4 reason/动作一致性。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const cache = new Map();
function load(rel) {
  const file = path.resolve(ROOT, 'src', rel + '.ts');
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports, console,
      require: (name) => {
        const base = name.slice(name.lastIndexOf('/') + 1);
        if (base === 'transitionPlan') return load('core/transitionPlan');
        if (base === 'tempoGate') return load('core/tempoGate');
        if (base === 'stemSwap') return load('core/stemSwap');
        if (base === 'djMoves') return load('core/djMoves');
        return {};
      },
    },
    { filename: file },
  );
  return exports;
}

const { planTransition, actionWindows } = load('core/transitionPlan');
const { schedulePlan } = load('core/stemSwap');
const { resolveTransition, describePlan } = load('core/advancedTransition');

function analysis(o = {}) {
  return {
    bpm: 128, bpmConfidence: 0.9, meter: 4, meterConfidence: 0.9,
    beatIntervalMs: 468.75, firstBeatMs: 0, firstDownbeatMs: 0, beatsMs: [],
    tempoStability: 0.95, tempoCurveMs: [], tempoCurveBpm: [],
    downbeats: Array.from({ length: 96 }, (_, i) => i * 1875),
    phraseStartsMs: [0, 15000, 30000], barCount: 96,
    climaxStartMs: 0, climaxEndMs: 0, cueInMs: 0, cueOutMs: 0,
    key: '8A', keyMode: 'minor', camelot: '8A', energy: 0.6,
    loudnessLufs: -9, peakDb: -1, loudnessTimesMs: [], momentaryLufs: [], sections: [],
    ...o,
  };
}

test('不传覆盖值时沿用乐句锚点（行为不变）', () => {
  const base = planTransition({ analysisA: analysis(), analysisB: analysis(), positionMsA: 120000 }, 'standard');
  assert.equal(base.startMsA % 1875, 0);
});

test('拖动换手点会吸附到最近小节线', () => {
  const a = analysis();
  const target = 130400; // 130400 / 1875 = 69.55 → 最近 70 小节 = 131250
  const plan = planTransition(
    { analysisA: a, analysisB: analysis(), positionMsA: 120000, handoffOverrideMs: target },
    'standard',
  );
  assert.equal(plan.startMsA, 69 * 1875 + 1875);
});

test('拖动 3 个位置：换手点跟着走，且所有动作相对它的偏移不变', () => {
  const a = analysis();
  const bars = [120000, 123750, 127500];
  const plans = bars.map((ms) =>
    planTransition({ analysisA: a, analysisB: analysis(), positionMsA: 120000, handoffOverrideMs: ms }, 'standard'));
  // actionWindows 给的是「相对换手点的毫秒」，拖动只平移整体，不动内部结构。
  const shapes = plans.map((plan) => actionWindows(plan).map((w) => [w.stem, w.startBar, w.startMs, w.endMs]));
  assert.equal(JSON.stringify(shapes[0]), JSON.stringify(shapes[1]));
  assert.equal(JSON.stringify(shapes[0]), JSON.stringify(shapes[2]));
  for (let i = 1; i < plans.length; i++) {
    const moveBeats = (plans[i].startMsA - plans[i - 1].startMsA) / plans[i].beatMs;
    const dragBeats = (bars[i] - bars[i - 1]) / plans[i].beatMs;
    assert.ok(Math.abs(moveBeats - dragBeats) <= 1, `第 ${i} 次平移 ${moveBeats} 拍，拖动 ${dragBeats} 拍`);
  }
});

test('覆盖值被非小节线数值污染时仍然落在 downbeats 上', () => {
  const plan = planTransition(
    { analysisA: analysis(), analysisB: analysis(), positionMsA: 120000, handoffOverrideMs: 131337 },
    'standard',
  );
  assert.ok(analysis().downbeats.includes(plan.startMsA), `${plan.startMsA} 不在 downbeats 里`);
});

test('T5-4：每条 action 恰好一行「换手」，行数与动作数相等', () => {
  const templates = ['standard', 'vocalFirst', 'doubleDrop', 'bassOnly', 'filterBuild'];
  let total = 0;
  for (const template of templates) {
    const plan = planTransition({ analysisA: analysis(), analysisB: analysis({ camelot: '9A' }), positionMsA: 120000 }, template);
    const lines = describePlan(plan).filter((line) => /^小节 \d+：/.test(line));
    const windows = actionWindows(plan);
    assert.equal(lines.length, windows.length, `${template} 行数不一致`);
    for (const line of lines) assert.ok(line.includes('小节'));
    total += windows.length;
  }
  assert.ok(total > 0);
});

test('T5-4：三档置信度下 reason 与动作保持一致', () => {
  for (const confidence of [0.9, 0.5, 0.2]) {
    const resolved = resolveTransition({
      mode: 'advanced',
      analysisA: analysis({ bpmConfidence: confidence }),
      analysisB: analysis({ bpmConfidence: confidence }),
      positionMsA: 120000,
    });
    if (!resolved.plan) {
      assert.equal(resolved.events.length, 0);
      assert.ok(resolved.summary.some((line) => line.includes('标准')), '回退时 summary 要说明回落');
      continue;
    }
    const lines = resolved.summary.filter((line) => /^小节 \d+：/.test(line));
    assert.equal(lines.length, resolved.plan.actions.length);
    assert.equal(JSON.stringify(resolved.events.map((e) => e.kind)),
      JSON.stringify(schedulePlan(resolved.plan).map((e) => e.kind)));
  }
});
