const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ts = require(path.join(__dirname, '..', 'node_modules', 'typescript'));
const fs = require('node:fs');

function load() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'automix', 'v2Quality.ts'), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  new Function('exports', 'require', 'module', js)(mod.exports, require, mod);
  return mod.exports;
}
const Q = load();
const N = 200;
const times = Array.from({ length: N }, (_, i) => i * 100);
const mk = (prof) => ({
  loudnessTimesMs: times,
  momentaryLufs: prof,
  activity: { hopMs: 250, vocal: new Array(400).fill(0.6), drum: new Array(400).fill(0.5), bass: new Array(400).fill(0.5) },
});
// A 在后半段掉 6 dB，B 全程稳定：合成曲线先涨后掉 → 有方向反转
const a = mk(times.map((_, i) => (i < 100 ? -9 : -9 - 0.06 * (i - 100))));
const b = mk(times.map((_, i) => (i < 100 ? -18 : -13)));
const base = { a, b, fadeStartAMs: 0, fadeStartBMs: 0, fadeMs: 12000, tempoRate: 1, beatMs: 500, weights: 'equal' };

test('loudnessTrimCurve 只抬不降且受 cap 约束', () => {
  const curve = Q.loudnessRampCurve(base);
  const trim = Q.loudnessTrimCurve(curve, 3);
  assert.equal(trim.db.length, curve.lufs.length);
  assert.ok(trim.db.every((v) => v >= 0 && v <= 3));
  assert.ok(Math.max(...trim.db) > 0);
  const capped = Q.loudnessTrimCurve(curve, 0.5);
  assert.ok(capped.db.every((v) => v <= 0.5));
});

test('把补平量算进指标后漂移不变大', () => {
  const curve = Q.loudnessRampCurve(base);
  const trim = Q.loudnessTrimCurve(curve, 6);
  const raw = Q.evaluateQuality(base).loudnessDriftLu;
  const withTrim = Q.evaluateQuality({ ...base, trimCurve: trim }).loudnessDriftLu;
  assert.ok(withTrim <= raw + 1e-6, `withTrim=${withTrim} raw=${raw}`);
});

test('cap 越大，补平后的漂移越小或不变', () => {
  const curve = Q.loudnessRampCurve(base);
  const d3 = Q.evaluateQuality({ ...base, trimCurve: Q.loudnessTrimCurve(curve, 3) }).loudnessDriftLu;
  const d6 = Q.evaluateQuality({ ...base, trimCurve: Q.loudnessTrimCurve(curve, 6) }).loudnessDriftLu;
  assert.ok(d6 <= d3 + 1e-6, `d6=${d6} d3=${d3}`);
});
