'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
function load() {
  const src = fs.readFileSync(path.join(ROOT, 'src/core/automix/phraseMix.ts'), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const cjs = { exports: {} };
  vm.runInNewContext(js, { module: cjs, exports: cjs.exports, console, Math, Number, Object, Array, Boolean, isFinite, Infinity, NaN, Set, Map });
  return cjs.exports;
}
const mod = load();

// hop=250ms；给一段 drum 曲线，endMs 之后不留样本
function analysis(drum, hopMs = 250) {
  const n = drum.length;
  return {
    beatIntervalMs: hopMs,
    meter: 4,
    audibleEndMs: n * hopMs,
    activity: {
      hopMs,
      drum,
      bass: new Array(n).fill(0),
      vocal: new Array(n).fill(0),
    },
  };
}

test('没有 activity 曲线时返回 null', () => {
  assert.strictEqual(mod.analyseResidue({ audibleEndMs: 10000 }, 10000, 2000), null);
});

test('衰减型散音：能量递减 → decaying=true，保留 0.4 小节', () => {
  // 40 个点：0–19 有鼓（0.9），20–39 递减散音
  const drum = [];
  for (let i = 0; i < 20; i++) drum.push(0.9);
  for (let i = 0; i < 20; i++) drum.push(0.6 - i * 0.025);
  const r = mod.analyseResidue(analysis(drum), drum.length * 250, 2000);
  assert.ok(r, 'should detect residue');
  assert.strictEqual(r.decaying, true);
  assert.ok(r.residueMs >= 2000 && r.residueMs <= 3000, `residue should cover the tail, got ${r.residueMs}`);
  const keep = mod.residueKeepMs(r, 2000);
  assert.strictEqual(keep, 800, '0.4 小节 = 800ms');
});

test('吊着不放的持续音：decaying=false，只留 120ms 防爆音', () => {
  const drum = [];
  for (let i = 0; i < 20; i++) drum.push(0.9);
  // 0.30 恒定：低于 0.35 不算「一击」，但也一直不衰减 → 持续垫音
  // 只留 8 格（2 s），保证最后一击仍落在 4 s 扫描窗内
  for (let i = 0; i < 8; i++) drum.push(0.3);
  const r = mod.analyseResidue(analysis(drum), drum.length * 250, 2000);
  assert.ok(r);
  assert.strictEqual(r.decaying, false);
  assert.strictEqual(mod.residueKeepMs(r, 2000), 120);
});

test('最后一击就在结尾：无散音，keep=0', () => {
  const drum = new Array(40).fill(0.9);
  const r = mod.analyseResidue(analysis(drum), drum.length * 250, 2000);
  assert.ok(r);
  assert.ok(r.residueMs < 300);
  assert.strictEqual(mod.residueKeepMs(r, 2000), 0);
});

test('全静音结尾（最后一击在很早以前、超出扫描窗）：返回 null', () => {
  const drum = new Array(40).fill(0);
  drum[0] = 0.9;
  const r = mod.analyseResidue(analysis(drum), drum.length * 250, 2000);
  // 扫描窗 = max(2*bar, 4000) = 4000ms = 16 点；第 0 点在窗外
  assert.strictEqual(r, null);
});
