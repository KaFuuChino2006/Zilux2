// Run with: node --test web/tests/transitionPlan.test.cjs
// 纯函数层测试：不碰音频、不碰 DOM，只验证「决策」和「手感」两件事。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function loadCore(name) {
  const file = path.join(ROOT, 'src/core', name + '.ts');
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { exports, console, require: () => ({}) },
    { filename: file },
  );
  return exports;
}

const plan = loadCore('transitionPlan');
const moves = loadCore('djMoves');

/** 造一首 120 BPM、4/4、有 31 个 downbeat 的分析结果。 */
function analysis(over = {}) {
  const bpm = over.bpm ?? 120;
  const bar = (60000 / bpm) * 4;
  return {
    bpm,
    bpmConfidence: 0.9,
    meter: 4,
    meterConfidence: 0.9,
    beatIntervalMs: 60000 / bpm,
    firstBeatMs: 0,
    firstDownbeatMs: 0,
    downbeats: Array.from({ length: 31 }, (_, i) => i * bar),
    beatsMs: [],
    phraseStartsMs: Array.from({ length: 8 }, (_, i) => i * bar * 8),
    barCount: 30,
    sections: [],
    warnings: [],
    camelot: '8A',
    energy: 0.6,
    cueInMs: 0,
    ...over,
  };
}

test('Camelot 距离：同调 0、相邻 1、换字母 1、远 2+、无法解析 3', () => {
  assert.equal(plan.camelotDistance('8A', '8A'), 0);
  assert.equal(plan.camelotDistance('8A', '9A'), 1);
  assert.equal(plan.camelotDistance('8A', '7A'), 1);
  assert.equal(plan.camelotDistance('8A', '8B'), 1);
  assert.equal(plan.camelotDistance('8A', '10A'), 2);
  assert.equal(plan.camelotDistance('12A', '1A'), 1, '环上回绕算相邻');
  assert.equal(plan.camelotDistance('8A', undefined), 3);
  assert.equal(plan.camelotDistance('xx', '8A'), 3);
});

test('拍族折叠：半速/双速折回 1，正常偏差保留', () => {
  assert.equal(plan.foldTempoRatio(2), 1);
  assert.equal(plan.foldTempoRatio(0.5), 1);
  assert.ok(Math.abs(plan.foldTempoRatio(129 / 128) - 129 / 128) < 1e-9);
  const same = plan.chooseRate(128, 128);
  assert.equal(same.ratio, 1);
  assert.equal(same.deviation, 0);
  const double = plan.chooseRate(64, 128);
  assert.equal(double.ratio, 1, '64→128 应折叠成 1');
});

test('兼容性打分：同调高分放行 vocals，远调性剔除 vocals', () => {
  const close = plan.scoreCompat(analysis(), analysis({ bpm: 121 }));
  assert.equal(close.keyDistance, 0);
  assert.ok(close.allowed.includes('vocals'));
  assert.ok(close.score > 0.5, `score=${close.score}`);
  assert.match(close.reason, /调性相邻/);

  const far = plan.scoreCompat(analysis(), analysis({ camelot: '1B' }));
  assert.ok(far.keyDistance >= 2);
  assert.ok(!far.allowed.includes('vocals'));
  assert.match(far.reason, /人声只做淡出/);
});

test('标准模板：动作排在 bass0 / drums2 / other4 / vocals8', () => {
  const p = plan.planTransition({
    analysisA: analysis(),
    analysisB: analysis({ bpm: 121, cueInMs: 8000 }),
    positionMsA: 40000,
  });
  assert.equal(p.template, 'standard');
  assert.equal(p.fallback, 'none');
  // vm 沙箱返回的是另一个 realm 的数组/对象，deepStrictEqual 会因原型不同误报，
  // 统一用 JSON 比较结构。
  assert.equal(
    JSON.stringify(p.actions.map((a) => [a.stem, a.startBar])),
    JSON.stringify([['bass', 0], ['drums', 2], ['other', 4], ['vocals', 8]]),
  );
  assert.equal(p.barMs, 2000, '120 BPM 4/4 → 一小节 2000 ms');
  assert.equal(p.startMsA % p.barMs, 0, 'A 侧起点必须落在小节线');
  const beats = analysis().downbeats;
  assert.ok(beats.includes(p.startMsA), 'A 侧起点必须是 downbeat');
});

test('低置信度降级为只换低频与鼓', () => {
  const p = plan.planTransition({
    analysisA: analysis({ bpmConfidence: 0.32 }),
    analysisB: analysis(),
    positionMsA: 40000,
  });
  assert.equal(p.fallback, 'bassDrumsOnly');
  assert.ok(p.actions.every((a) => a.stem === 'bass' || a.stem === 'drums'));
  assert.match(p.warnings.join(), /置信度偏低/);
});

test('A 快放完时退化到固定等功率', () => {
  const p = plan.planTransition({
    analysisA: analysis(),
    analysisB: analysis(),
    positionMsA: 59500,
  });
  assert.equal(p.fallback, 'fixedEqualPower');
  assert.ok(p.warnings.some((w) => w.includes('剩余不足')));
});

test('增益曲线：linear 中点 0.5/0.5，equalPower 中点 0.707，shelfDip 更低', () => {
  const lin = plan.gainAt({ curve: 'linear' }, 0.5);
  assert.ok(Math.abs(lin.a - 0.5) < 1e-9 && Math.abs(lin.b - 0.5) < 1e-9);

  const eq = plan.gainAt({ curve: 'equalPower' }, 0.5);
  assert.ok(Math.abs(eq.a - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(eq.a * eq.a + eq.b * eq.b - 1) < 1e-9, '等功率：功率恒为 1');

  const dip = plan.gainAt({ curve: 'shelfDip' }, 0.5);
  assert.ok(dip.a < 0.5, '低频交接中点必须压下去，避免 +3 dB');
  assert.ok(Math.abs(dip.a + dip.b - (1 - 0.3)) < 1e-9);

  // 注意：gainAt 的返回值来自 vm 沙箱里的另一个 realm，deepStrictEqual 会因为
  // 原型不同而误报，所以逐字段比较。
  const atStart = plan.gainAt({ curve: 'linear' }, -1);
  assert.equal(atStart.a, 1);
  assert.equal(atStart.b, 0);
  const atEnd = plan.gainAt({ curve: 'linear' }, 2);
  assert.equal(atEnd.a, 0);
  assert.equal(atEnd.b, 1);
});

test('动作窗口：开始/结束时间按小节与拍换算', () => {
  const p = plan.planTransition({
    analysisA: analysis(), analysisB: analysis(), positionMsA: 40000,
  });
  const w = plan.actionWindows(p);
  const vocals = w.find((x) => x.stem === 'vocals');
  assert.equal(vocals.startMs, 8 * p.barMs);
  assert.equal(vocals.endMs, 8 * p.barMs + 1 * p.beatMs);
});

test('手法库：三个模板都能展开，且换手点都在小节线上', () => {
  for (const build of [moves.MOVE_TEMPLATES.club32, moves.MOVE_TEMPLATES.vocalOverBeat16, moves.MOVE_TEMPLATES.echoCut8]) {
    const list = build();
    const acts = moves.expandMoves(list);
    assert.ok(acts.length > 0);
    for (const act of acts) {
      assert.ok(Number.isInteger(act.startBar), `${act.stem} 的小节号必须是整数`);
      assert.ok(act.startBar >= 0);
      assert.ok(act.lengthBeats > 0);
    }
  }
});

test('回声参数固定：1/4 拍、反馈 0.35、阻尼 3 kHz、ducking −3 dB', () => {
  assert.equal(moves.ECHO.divisionBeats, 0.25);
  assert.equal(moves.ECHO.feedback, 0.35);
  assert.equal(moves.ECHO.dampHz, 3000);
  assert.equal(moves.ECHO.duckDb, -3);
  assert.equal(moves.ECHO.duckAttackMs, 5);
});

test('echoDelaySec 跟着 BPM 走，非法 BPM 回落 120', () => {
  // 120 BPM 的 1/4 拍 = 0.5 s/拍 × 0.25 = 0.125 s
  assert.equal(moves.echoDelaySec(120), 0.125);
  assert.equal(moves.echoDelaySec(60), 0.25);
  assert.equal(moves.echoDelaySec(undefined), 0.125);
  assert.equal(moves.echoDelaySec(0), 0.125);
  assert.equal(moves.echoDelaySec(999), 0.125);
});

test('人味：同一 seed 可复现，startBar 不变，jitter 在 ±humanize 内', () => {
  const list = moves.MOVE_TEMPLATES.club32();
  const a = moves.humanize(list, 42);
  const b = moves.humanize(moves.MOVE_TEMPLATES.club32(), 42);
  assert.equal(JSON.stringify(a), JSON.stringify(b), '同 seed 必须完全一致');

  const base = moves.expandMoves(moves.MOVE_TEMPLATES.club32());
  assert.equal(a.length, base.length);
  a.forEach((act, i) => {
    assert.equal(act.startBar, base[i].startBar, '结构不许抖：小节号必须一致');
    assert.ok(Math.abs(act.jitterMs) <= 12, `jitter 超界：${act.jitterMs}`);
    assert.ok(act.lengthBeats > 0);
  });

  const c = moves.humanize(list, 43);
  assert.notEqual(JSON.stringify(a.map((x) => x.jitterMs)), JSON.stringify(c.map((x) => x.jitterMs)), '换 seed 应该不一样');
});

test('模板自动选择（第 23 轮）：两首都够热 + 调性不冲突 → doubleDrop', () => {
  const out = plan.planTransition({
    analysisA: analysis({ energy: 0.78 }),
    analysisB: analysis({ energy: 0.74 }),
    positionMsA: 30_000,
  });
  assert.equal(out.template, 'doubleDrop');
  assert.equal(out.totalBars, 8, 'doubleDrop 固定 8 小节');
  const vocal = out.actions.find((a) => a.stem === 'vocals');
  assert.ok(vocal, 'doubleDrop 必须包含人声换手');
});

test('模板自动选择：能量差大时走 filterBuild，不会因为两首都热就炸', () => {
  const out = plan.planTransition({
    analysisA: analysis({ energy: 0.8 }),
    analysisB: analysis({ energy: 0.3 }),
    positionMsA: 30_000,
  });
  assert.equal(out.template, 'filterBuild');
});

test('模板自动选择：A 在尾奏 → 回到 32 小节的 standard', () => {
  const out = plan.planTransition({
    analysisA: analysis({ energy: 0.5, sections: [{ startMs: 0, endMs: 120_000, label: 'outro', confidence: 0.8 }] }),
    analysisB: analysis({ energy: 0.55 }),
    positionMsA: 30_000,
  });
  assert.equal(out.template, 'standard');
  assert.equal(out.totalBars, 32);
});

test('模板自动选择：速度差 >6% 时不管多热都只换鼓+低音', () => {
  const out = plan.planTransition({
    analysisA: analysis({ bpm: 120, energy: 0.8 }),
    analysisB: analysis({ bpm: 132, energy: 0.8 }),
    positionMsA: 30_000,
  });
  assert.equal(out.template, 'bassOnly');
  const stems = new Set(out.actions.map((a) => a.stem));
  assert.ok([...stems].every((s) => s === 'bass' || s === 'drums'));
});

test('sectionLabelAt：左闭右开，缺 sections 返回空串', () => {
  const a = analysis({ sections: [
    { startMs: 0, endMs: 1000, label: 'intro', confidence: 1 },
    { startMs: 1000, endMs: 2000, label: 'climax', confidence: 1 },
  ] });
  assert.equal(plan.sectionLabelAt(a, 0), 'intro');
  assert.equal(plan.sectionLabelAt(a, 999), 'intro');
  assert.equal(plan.sectionLabelAt(a, 1000), 'climax', '边界归后一段');
  assert.equal(plan.sectionLabelAt(a, 5000), '');
  assert.equal(plan.sectionLabelAt(analysis(), 100), '');
  assert.equal(plan.sectionLabelAt(undefined, 100), '');
});

test('vocalFirst：plan 带上回声甩尾 cue，且 schedulePlan 真的发出 delaySend', () => {
  const swapPath = path.join(ROOT, 'src/core/stemSwap.ts');
  const swap = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(swapPath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { exports: swap, console, require: (id) => (id.includes('transitionPlan') ? plan : id.includes('djMoves') ? moves : {}) },
    { filename: swapPath },
  );

  const out = plan.planTransition(
    { analysisA: analysis({ energy: 0.55 }), analysisB: analysis({ energy: 0.55 }), positionMsA: 30_000 },
    'vocalFirst',
  );
  assert.equal(out.template, 'vocalFirst');
  assert.ok(out.echo, 'vocalFirst 必须带 echo cue');
  assert.equal(out.echo.lengthBeats, 1);

  const events = swap.schedulePlan(out);
  const sends = events.filter((e) => e.kind === 'delaySend');
  assert.ok(sends.length >= 2, `delaySend 至少两条（送出 + 收回），实得 ${sends.length}`);
  assert.equal(sends[0].from, 0);
  assert.equal(sends[0].to, 0.6);
  assert.ok(events.some((e) => e.kind === 'duck'), '甩尾时对向 deck 要侧链躲避');
});

test('其他模板不带 echo cue（不给自己加戏）', () => {
  for (const hint of ['standard', 'bassOnly', 'doubleDrop', 'filterBuild']) {
    const out = plan.planTransition(
      { analysisA: analysis(), analysisB: analysis(), positionMsA: 30_000 },
      hint,
    );
    assert.equal(out.echo, undefined, `${hint} 不应该带 echo`);
  }
});

test('filterBuild 带滤波扫频，其他模板不带（E22）', () => {
  const hot = analysis();
  const cold = { ...analysis(), energy: 0.2 };
  const build = plan.planTransition({ analysisA: hot, analysisB: cold, positionMsA: 30000, positionMsB: 0 });
  assert.equal(build.template, 'filterBuild');
  assert.ok(build.filter, 'filterBuild 必须带扫频参数');
  assert.equal(build.filter.fromHz, 320);
  assert.equal(build.filter.toHz, 18000);
  assert.ok(build.filter.lengthBeats >= 8, `扫频长度太短：${build.filter.lengthBeats}`);

  const std = plan.planTransition({ analysisA: analysis(), analysisB: analysis(), positionMsA: 30000, positionMsB: 0 });
  assert.equal(std.template, 'standard');
  assert.equal(std.filter, undefined, '标准模板不该带扫频');
});
