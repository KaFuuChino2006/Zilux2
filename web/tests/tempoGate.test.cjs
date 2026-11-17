// Run with: node --test web/tests/tempoGate.test.cjs
// 速度门控（T6）纯函数测试：候选倍率、三档判定、相位与乐句评分。
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

const gate = loadCore('tempoGate');

/** 造分析结果：默认 128 BPM、4/4、120 小节、每 8 小节一个乐句起点。 */
function analysis(over = {}) {
  const bpm = over.bpm ?? 128;
  const meter = over.meter ?? 4;
  const beatMs = 60000 / bpm;
  const barMs = beatMs * meter;
  const barCount = over.barCount ?? 120;
  return {
    bpm,
    bpmConfidence: over.bpmConfidence ?? 0.9,
    meter,
    meterConfidence: 0.9,
    beatIntervalMs: beatMs,
    firstBeatMs: 0,
    firstDownbeatMs: over.firstDownbeatMs ?? 0,
    downbeats: Array.from({ length: 16 }, (_, i) => i * barMs),
    phraseStartsMs: over.phraseStartsMs ?? Array.from({ length: Math.floor(barCount / 8) }, (_, i) => i * 8 * barMs),
    barCount,
    tempoStability: over.tempoStability,
    ...over,
  };
}

test('候选集包含同速、半/双速与三连音族，且按分数降序', () => {
  const out = gate.scoreCandidates(analysis(), analysis());
  assert.equal(out.length, 7);
  assert.equal(typeof out[0].score, 'number');
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].score >= out[i].score);
  const ratios = out.map((c) => c.ratio).sort((x, y) => x - y);
  assert.equal(JSON.stringify(ratios), JSON.stringify([1 / 2, 2 / 3, 3 / 4, 1, 4 / 3, 3 / 2, 2]));
});

test('同 BPM 同相位：×1 得分最高且偏差为 0', () => {
  const out = gate.scoreCandidates(analysis(), analysis());
  assert.equal(out[0].ratio, 1);
  assert.equal(out[0].deviation, 0);
  assert.ok(out[0].score > 0.95, `同速同相应接近满分，实际 ${out[0].score}`);
});

test('B 是 A 的双速（B 报 256）：应选 ×1/2 而不是 ×1', () => {
  const out = gate.scoreCandidates(analysis({ bpm: 128 }), analysis({ bpm: 256 }));
  assert.equal(out[0].ratio, 0.5);
  assert.ok(out[0].deviation < 1e-9);
});

test('B 报 85.33（2/3 族）：应选 ×3/2 或 ×2/3 之一，且偏差 < 0.01', () => {
  const out = gate.scoreCandidates(analysis({ bpm: 128 }), analysis({ bpm: 85.33 }));
  assert.ok(out[0].deviation < 0.01, `偏差应很小，实际 ${out[0].deviation}（选中 ${out[0].ratio}）`);
});

test('门控三档：高置信 → full；中等 → bassDrumsOnly；低 → standard', () => {
  const full = gate.decideTempoGate(analysis(), analysis({ bpm: 128 }));
  assert.equal(full.tier, 'full');
  assert.equal(gate.allowsVocals(full), true);

  const mid = gate.decideTempoGate(analysis({ bpmConfidence: 0.5, tempoStability: 0.5 }), analysis({ bpmConfidence: 0.5, tempoStability: 0.5 }));
  assert.equal(mid.tier, 'bassDrumsOnly');
  assert.equal(gate.allowsVocals(mid), false);

  const low = gate.decideTempoGate(analysis({ bpmConfidence: 0.2, tempoStability: 0.2 }), analysis({ bpmConfidence: 0.2, tempoStability: 0.2 }));
  assert.equal(low.tier, 'standard');
});

test('置信度够但速率对不上（相差 >6%）→ 降到 bassDrumsOnly', () => {
  // 128 vs 160：最接近的候选是 4/3（1.333）→ 等效 213.3 或 0.75 → 96，都差得远
  const d = gate.decideTempoGate(analysis({ bpm: 128 }), analysis({ bpm: 160 }));
  assert.equal(d.tier, 'bassDrumsOnly');
  assert.ok(d.best.deviation > 0.06, `偏差应大于 6%，实际 ${d.best.deviation}`);
  assert.ok(d.reasons.some((r) => r.includes('只换低频与鼓')));
});

test('缺 tempoStability 时回落到 bpmConfidence（不因旧缓存崩掉）', () => {
  const d = gate.decideTempoGate(analysis({ tempoStability: undefined }), analysis({ tempoStability: undefined }));
  assert.equal(d.tier, 'full');
  assert.equal(d.stability, 0.9);
});

test('下拍相位错半小节：downbeatAlign 接近 0 且给出人工确认提示', () => {
  const barMs = (60000 / 128) * 4;
  const shifted = analysis({ firstDownbeatMs: barMs / 2 });
  const d = gate.decideTempoGate(analysis(), shifted);
  assert.ok(d.best.downbeatAlign < 0.1, `相位吻合度应很低，实际 ${d.best.downbeatAlign}`);
  assert.ok(d.reasons.some((r) => r.includes('下拍相位')));
  assert.equal(gate.allowsVocals(d), false);
});

test('缺乐句数据时 phraseMatch 视为 1（不扣分）', () => {
  const noPhrase = analysis({ phraseStartsMs: [] });
  const cand = gate.scoreCandidates(analysis(), noPhrase)[0];
  assert.equal(cand.phraseMatch, 1);
});

test('非法输入不抛异常（bpm=0 / 负相位）', () => {
  const bad = analysis({ bpm: 0, firstDownbeatMs: -100, barCount: 0 });
  const d = gate.decideTempoGate(bad, bad);
  assert.ok(['full', 'bassDrumsOnly', 'standard'].includes(d.tier));
  assert.ok(Number.isFinite(d.best.score));
});
