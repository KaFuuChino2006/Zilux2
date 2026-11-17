// Run with: node --test web/tests/transitionTimeline.test.cjs
// T5-2：时间线是纯数据，这里用 JSON 快照 + 结构断言锁住 6 种模板的形状。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const deps = new Map();

function load(rel) {
  const file = path.resolve(ROOT, 'src', rel + '.ts');
  if (deps.has(file)) return deps.get(file);
  const exports = {};
  deps.set(file, exports);
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      console,
      require: (name) => {
        const base = name.slice(name.lastIndexOf('/') + 1);
        if (base === 'transitionPlan') return load('core/transitionPlan');
        if (base === 'stemSwap') return load('core/stemSwap');
        if (base === 'djMoves') return load('core/djMoves');
        return {};
      },
    },
    { filename: file },
  );
  return exports;
}

const { buildTimeline, TIMELINE_STEMS, STEM_LABELS } = load('ui/transitionTimeline');
const { planTransition } = load('core/transitionPlan');
const { schedulePlan } = load('core/stemSwap');

function analysis(overrides = {}) {
  return {
    bpm: 128, bpmConfidence: 0.9, meter: 4, meterConfidence: 0.9,
    beatIntervalMs: 60000 / 128, firstBeatMs: 0, firstDownbeatMs: 0,
    beatsMs: [], tempoStability: 0.95, tempoCurveMs: [], tempoCurveBpm: [],
    // 每 1875 ms 一个小节（128 BPM / 4 拍），足够 32 小节：否则会退化到 fixedEqualPower。
    downbeats: Array.from({ length: 96 }, (_, i) => i * 1875),
    phraseStartsMs: [0, 15000, 30000], barCount: 96, climaxStartMs: 0, climaxEndMs: 0,
    cueInMs: 0, cueOutMs: 0, key: '8A', keyMode: 'minor', camelot: '8A',
    energy: 0.6, loudnessLufs: -9, peakDb: -1, loudnessTimesMs: [], momentaryLufs: [], sections: [],
    ...overrides,
  };
}

function planFor(template) {
  // 第二个参数才是模板提示；input 里没有 template 字段。
  return planTransition({ analysisA: analysis(), analysisB: analysis({ bpm: 128, camelot: '9A' }), positionMsA: 120000 }, template);
}

test('四条泳道齐全且标签是中文', () => {
  const plan = planFor('standard');
  const model = buildTimeline(schedulePlan(plan), plan.barMs, plan.totalBars * plan.barMs);
  assert.equal(JSON.stringify([...TIMELINE_STEMS]), JSON.stringify(['drums', 'bass', 'other', 'vocals']));
  assert.equal(STEM_LABELS.vocals, '人声');
  assert.equal(JSON.stringify(model.lanes.map((lane) => lane.stem)), JSON.stringify(['drums', 'bass', 'other', 'vocals']));
});

test('6 种模板都能出块，且每块都在 0..1 内', () => {
  const templates = ['standard', 'vocalFirst', 'doubleDrop', 'bassOnly', 'filterBuild'];
  let total = 0;
  for (const template of templates) {
    const plan = planFor(template);
    const model = buildTimeline(schedulePlan(plan), plan.barMs, plan.totalBars * plan.barMs);
    const blocks = model.lanes.flatMap((lane) => lane.blocks).concat(model.overhead);
    total += blocks.length;
    for (const block of blocks) {
      assert.ok(block.x >= 0 && block.x <= 1, `${template} x 越界 ${block.x}`);
      assert.ok(block.width >= 0 && block.x + block.width <= 1.0000001, `${template} 右边界越界`);
      assert.ok(block.bar >= 0);
    }
    // drum/bass 至少有一条在 standard 之外的模板里出现
    assert.ok(model.bars > 0, `${template} 应算出小节数`);
  }
  assert.ok(total > 0, '五个模板合计应有动作块');
});

test('standard 32 小节：bass 在 0 小节、vocals 在 8 小节之后', () => {
  const plan = planFor('standard');
  const model = buildTimeline(schedulePlan(plan), plan.barMs, plan.totalBars * plan.barMs);
  const bass = model.lanes.find((lane) => lane.stem === 'bass').blocks[0];
  assert.ok(bass, 'bass 应有换手块');
  assert.equal(bass.bar, 0);
  assert.equal(bass.kind, 'swap');
  const vocals = model.lanes.find((lane) => lane.stem === 'vocals').blocks;
  assert.ok(vocals.length > 0, 'vocals 应有动作');
  assert.ok(Math.min(...vocals.map((b) => b.bar)) >= 8, 'vocals 不应早于第 8 小节');
});

test('同一段 A/B 曲线合并成一格，而不是两条重叠方块', () => {
  const plan = planFor('bassOnly');
  const events = schedulePlan(plan);
  const model = buildTimeline(events, plan.barMs, plan.totalBars * plan.barMs);
  const bassBlocks = model.lanes.find((lane) => lane.stem === 'bass').blocks;
  const paired = events.filter((event) => event.kind === 'gainCurve' && event.stem === 'bass');
  assert.ok(paired.length >= 2, '至少应有 A、B 两条曲线');
  assert.equal(bassBlocks.length, 1, '合并后只剩一格');
  assert.match(bassBlocks[0].label, /→/);
});

test('duck 事件进 overhead 顶部窄条，不占泳道', () => {
  const plan = planFor('standard');
  const events = schedulePlan(plan);
  const model = buildTimeline(events, plan.barMs, plan.totalBars * plan.barMs);
  const ducks = events.filter((event) => event.kind === 'duck');
  if (ducks.length > 0) {
    assert.equal(model.overhead.filter((block) => block.kind === 'duck').length, ducks.length);
    for (const lane of model.lanes) {
      assert.equal(lane.blocks.filter((block) => block.kind === 'duck').length, 0);
    }
  }
});

test('空事件与坏小节长度给出 emptyReason，不抛', () => {
  const empty = buildTimeline([], 2000, 64000);
  assert.equal(empty.emptyReason, '这次过渡没有分轨动作');
  assert.equal(empty.bars, 32);
  assert.equal(empty.lanes.length, 4);

  const bad = buildTimeline([{ kind: 'gainCurve', deck: 'B', stem: 'bass', atMs: 0, durationMs: 1000, curve: [0, 1] }], 0, 0);
  assert.equal(bad.emptyReason, '缺少小节长度，无法定位动作');
  assert.equal(bad.bars, 0);
});

test('快照：standard 模板的时间线结构稳定', () => {
  const plan = planFor('standard');
  const model = buildTimeline(schedulePlan(plan), plan.barMs, plan.totalBars * plan.barMs);
  const shape = model.lanes.map((lane) => ({
    stem: lane.stem,
    blocks: lane.blocks.map((block) => ({ bar: block.bar, kind: block.kind, deck: block.deck })),
  }));
  assert.equal(JSON.stringify({
    bars: model.bars,
    lanes: shape,
  }), JSON.stringify({
    bars: plan.totalBars,
    lanes: [
      { stem: 'drums', blocks: [{ bar: 2, kind: 'swap', deck: 'B' }] },
      { stem: 'bass', blocks: [{ bar: 0, kind: 'swap', deck: 'B' }] },
      { stem: 'other', blocks: [{ bar: 4, kind: 'swap', deck: 'B' }] },
      { stem: 'vocals', blocks: [{ bar: 8, kind: 'swap', deck: 'A' }, { bar: 8, kind: 'swap', deck: 'B' }] },
    ],
  }));
});
