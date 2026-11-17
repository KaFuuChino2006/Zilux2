const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTs(rel, deps = {}) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const ctx = vm.createContext({
    module,
    exports: module.exports,
    require: (id) => deps[id] ?? {},
    console,
  });
  vm.runInContext(js, ctx);
  return module.exports;
}

const correlation = loadTs('src/core/correlation.ts');
const plan = loadTs('src/core/transitionPlan.ts');

function analysis(bpm = 120) {
  const beatMs = 60000 / bpm;
  return {
    bpm,
    bpmConfidence: 0.9,
    meter: 4,
    meterConfidence: 0.9,
    beatIntervalMs: beatMs,
    firstBeatMs: 0,
    firstDownbeatMs: 0,
    beatsMs: Array.from({ length: 256 }, (_, i) => i * beatMs),
    downbeats: Array.from({ length: 96 }, (_, i) => i * beatMs * 4),
    phraseStartsMs: Array.from({ length: 12 }, (_, i) => i * beatMs * 16),
    key: '8A',
    energy: 0.5,
  };
}

// ---- correlation.ts -------------------------------------------------------------

test('normalizedCorrelation：同相 = 1，反相 = −1，无关 ≈ 0', () => {
  const n = 4096;
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    a[i] = Math.sin((2 * Math.PI * 55 * i) / 48000);
    b[i] = a[i] * 0.5;
    c[i] = Math.sin((2 * Math.PI * 3000 * i) / 48000);
  }
  assert.ok(Math.abs(correlation.normalizedCorrelation(a, b) - 1) < 1e-9);
  assert.ok(Math.abs(correlation.normalizedCorrelation(a, Array.from(a, (v) => -v)) + 1) < 1e-9);
  assert.ok(Math.abs(correlation.normalizedCorrelation(a, c)) < 0.05);
});

test('normalizedCorrelation：过短/含 NaN 一律返回 0，不返回 NaN', () => {
  assert.strictEqual(correlation.normalizedCorrelation(new Float32Array(8), new Float32Array(8)), 0);
  const bad = new Float32Array(1024);
  bad[3] = Number.NaN;
  const ok = new Float32Array(1024).fill(0.1);
  const r = correlation.normalizedCorrelation(bad, ok);
  assert.ok(Number.isFinite(r));
});

test('lowBandCorrelation：低频同相得高分，低频与高频之间不产生相关性', () => {
  const n = 48000;
  const low = new Float32Array(n);
  const high = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    low[i] = Math.sin((2 * Math.PI * 55 * i) / 48000);
    high[i] = Math.sin((2 * Math.PI * 4000 * i) / 48000);
  }
  const rhoLow = correlation.lowBandCorrelation(low, low, 48000, 120);
  assert.ok(rhoLow > 0.95, `低频同相应接近 1，实得 ${rhoLow}`);
  // 4 kHz 正弦自己过 120 Hz 低通后只剩极小的低频残留，自相关仍≈1（这不矛盾）；
  // 真正要保证的是「低频信号 vs 高频信号」不会被低通伪造出相关性。
  const rhoCross = correlation.lowBandCorrelation(low, high, 48000, 120);
  assert.ok(Math.abs(rhoCross) < 0.5, `55 Hz 与 4 kHz 经低通后不应相关，实得 ${rhoCross}`);
});

// ---- chooseCurve / planTransition 接入 -------------------------------------------

test('chooseCurve：ρ 高走 linear，ρ 低走 equalPower，缺失保留模板默认', () => {
  assert.strictEqual(plan.chooseCurve(0.9, 'equalPower'), 'linear');
  assert.strictEqual(plan.chooseCurve(-0.8, 'equalPower'), 'linear');
  assert.strictEqual(plan.chooseCurve(0.05, 'linear'), 'equalPower');
  assert.strictEqual(plan.chooseCurve(undefined, 'shelfDip'), 'shelfDip');
  assert.strictEqual(plan.chooseCurve(Number.NaN, 'linear'), 'linear');
  assert.strictEqual(plan.CORRELATION_THRESHOLD, 0.35);
});

test('planTransition：给了 correlation 就按 ρ 覆盖模板曲线', () => {
  const a = analysis(128);
  const b = analysis(128);
  const decorrelated = plan.planTransition({
    analysisA: a,
    analysisB: b,
    positionMsA: 30000,
    correlation: { bass: 0.02, drums: 0.04, other: 0.03, vocals: 0.05 },
  });
  const correlated = plan.planTransition({
    analysisA: a,
    analysisB: b,
    positionMsA: 30000,
    correlation: { bass: 0.92, drums: 0.88, other: 0.9, vocals: 0.86 },
  });
  const byStem = (p) => Object.fromEntries(p.actions.map((x) => [x.stem, x.curve]));
  const dec = byStem(decorrelated);
  const cor = byStem(correlated);
  for (const stem of Object.keys(dec)) {
    assert.strictEqual(dec[stem], 'equalPower', `${stem} 不相关时应 equalPower`);
    assert.strictEqual(cor[stem], 'linear', `${stem} 相关时应 linear`);
  }
});

test('planTransition：不给 correlation 时与旧行为逐字段一致', () => {
  const a = analysis(128);
  const b = analysis(126);
  const plain = plan.planTransition({ analysisA: a, analysisB: b, positionMsA: 30000 });
  const explicit = plan.planTransition({
    analysisA: a,
    analysisB: b,
    positionMsA: 30000,
    correlation: {},
  });
  assert.strictEqual(
    JSON.stringify(plain.actions.map((x) => [x.stem, x.startBar, x.lengthBeats, x.curve])),
    JSON.stringify(explicit.actions.map((x) => [x.stem, x.startBar, x.lengthBeats, x.curve])),
  );
  assert.strictEqual(JSON.stringify(plain.compat), JSON.stringify(explicit.compat));
});
