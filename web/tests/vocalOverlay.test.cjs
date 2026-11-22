const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('E:/Zilux2开发/web/node_modules/typescript');
const vm = require('node:vm');

const SRC = path.resolve(__dirname, '../src/core/automix/vocalOverlay.ts');

function load() {
  const code = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Number, Math, console });
  return module.exports;
}

const mod = load();

test('A 人声太轻 → 不启用（没有「最后一句」可浮）', () => {
  const p = mod.planVocalOverlay({ aVocal: 0.2, bVocal: 0.6, fadeMs: 12000 });
  assert.equal(p.enabled, false);
  assert.equal(p.aBoostDb, 0);
  assert.match(p.note, /太低/);
});

test('调性差 ≥5 → 不叠，改用换手', () => {
  const p = mod.planVocalOverlay({ aVocal: 0.7, bVocal: 0.7, keyGap: 5, fadeMs: 12000 });
  assert.equal(p.enabled, false);
  assert.match(p.note, /调性差/);
});

test('正常长窗：A 抬 2–4 dB、B 让 2–6 dB', () => {
  const p = mod.planVocalOverlay({ aVocal: 0.7, bVocal: 0.6, keyGap: 1, fadeMs: 12000 });
  assert.equal(p.enabled, true);
  assert.ok(p.aBoostDb >= 2 && p.aBoostDb <= 4, `aBoostDb=${p.aBoostDb}`);
  assert.ok(p.bDuckDb <= -2 && p.bDuckDb >= -6, `bDuckDb=${p.bDuckDb}`);
  assert.equal(p.fromP, 0.3);
  assert.equal(p.releaseP, 0.94);
});

test('B 人声本来就轻 → 不让位，但 A 照样浮', () => {
  const p = mod.planVocalOverlay({ aVocal: 0.6, bVocal: 0.1, keyGap: 0, fadeMs: 10000 });
  assert.equal(p.enabled, true);
  assert.equal(p.bDuckDb, 0);
  assert.match(p.note, /不让位/);
});

test('短窗（<6 s）抬得更少、起得更晚', () => {
  const p = mod.planVocalOverlay({ aVocal: 0.9, bVocal: 0.8, keyGap: 0, fadeMs: 4000 });
  assert.equal(p.enabled, true);
  assert.ok(p.aBoostDb <= 2, `短窗应 ≤2dB，实际 ${p.aBoostDb}`);
  assert.equal(p.fromP, 0.5);
});

test('非法输入不产生 NaN', () => {
  const p = mod.planVocalOverlay({ aVocal: NaN, bVocal: NaN, keyGap: NaN, fadeMs: NaN });
  assert.equal(p.enabled, false);
  assert.ok(Number.isFinite(p.aBoostDb));
  assert.ok(Number.isFinite(p.bDuckDb));
  assert.ok(Number.isFinite(p.fromP));
});

test('dB 值都是 0.5 的整数倍（可读、便于日志比对）', () => {
  const p = mod.planVocalOverlay({ aVocal: 0.63, bVocal: 0.52, keyGap: 2, fadeMs: 9000 });
  assert.equal(Math.round(p.aBoostDb * 2) / 2, p.aBoostDb);
});
