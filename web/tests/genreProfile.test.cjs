'use strict';
/** genreProfile 单测：反推顺序、预算随曲风变化、非法输入兜底。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.resolve(__dirname, '..', 'node_modules', 'typescript'));

function load() {
  const file = path.resolve(__dirname, '..', 'src', 'core', 'automix', 'genreProfile.ts');
  const src = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require, console }, { filename: file });
  return module.exports;
}
const g = load();

const mk = (bpm, energy, vocal, meter = 4) => ({
  bpm, energy, meter, beatIntervalMs: 60_000 / bpm, audibleEndMs: 240_000,
  downbeats: [], phraseStartsMs: [], sections: [],
  activity: vocal === undefined ? undefined : { hopMs: 250, vocal: Array.from({ length: 40 }, (_, i) => (i % 10 < vocal * 10 ? 0.7 : 0.1)), drum: [], bass: [] },
});

test('慢速 + 人声密 → hip-hop（不被 ambient 抢走）', () => {
  assert.equal(g.inferGenre(mk(92, 0.45, 0.6)), 'hiphop');
});

test('150 BPM 以上 → dnb（不被 techno 抢走）', () => {
  assert.equal(g.inferGenre(mk(174, 0.8, 0.4)), 'dnb');
});

test('低能量 + 几乎无唱词 → ambient', () => {
  assert.equal(g.inferGenre(mk(80, 0.2, 0.0)), 'ambient');
});

test('112–132 区间 → house', () => {
  assert.equal(g.inferGenre(mk(124, 0.7, 0.4)), 'house');
});

test('预算随曲风变化：hip-hop 两小节 < house 四小节 < techno 八小节', () => {
  const bar = 2_000;
  const hip = g.mixBudgetMs('hiphop', bar);
  const house = g.mixBudgetMs('house', bar);
  const tech = g.mixBudgetMs('techno', bar);
  assert.ok(hip.maxFadeMs < house.maxFadeMs);
  assert.ok(house.maxFadeMs < tech.maxFadeMs);
  assert.equal(hip.maxFadeMs, 4_000);
  assert.equal(tech.maxFadeMs, 16_000);
});

test('非法 barMs 回落 2 s 小节，不产生 NaN', () => {
  const b = g.mixBudgetMs('house', Number.NaN);
  assert.ok(Number.isFinite(b.maxFadeMs) && b.maxFadeMs > 0);
});
