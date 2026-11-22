const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// melodyAnchor 只吃 {barChromaMs, barChroma}，用最小桩加载，不需要 AudioContext。
function load() {
  const file = path.join(__dirname, '..', 'src', 'core', 'automix', 'melodyAnchor.ts');
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: 'CommonJS', target: 'ES2022' } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, console, Math, Number, Array, Set }, { filename: file });
  return module.exports;
}

// 生成一段 barChroma：每小节给定一个主音音级（旋律轮廓），其余给很小的扰动。
function bars(mainPitches, opts = {}) {
  const ms = [];
  const flat = [];
  mainPitches.forEach((pitch, index) => {
    ms.push(index * 2000);
    let row = new Array(12).fill(0);
    if (pitch >= 0) {
      row[pitch] = 1;
      if (opts.third) row[(pitch + 4) % 12] = 0.5;
      if (opts.fifth) row[(pitch + 7) % 12] = 0.4;
    }
    for (let i = 0; i < 12; i += 1) row[i] += opts.noise ? opts.noise * ((index + i) % 3) : 0;
    let norm = 0;
    for (const value of row) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (const value of row) flat.push(Math.round((value / norm) * 1000) / 1000);
  });
  return { barChromaMs: ms, barChroma: flat };
}

test('归一化后的逐小节 chroma 可以按点积比相似度', () => {
  const mod = load();
  const a = bars([0, 2, 4, 5], { third: true, fifth: true });
  const same = mod.melodyProfile(a, 0, 4);
  const again = mod.melodyProfile(a, 0, 4);
  assert.ok(same && again);
  assert.ok(Math.abs(mod.cosineSimilarity(same, again) - 1) < 1e-6);
  assert.ok(mod.melodyProfile(a, 0, 4));
});

test('不同旋律轮廓的相似度明显低于同一轮廓', () => {
  const mod = load();
  const a = bars([0, 0, 0, 0], { third: true, fifth: true });
  const b = bars([0, 0, 0, 0], { third: true, fifth: true });
  const c = bars([6, 6, 6, 6], { third: false, fifth: false });
  const pa = mod.melodyProfile(a, 0, 4);
  const pb = mod.melodyProfile(b, 0, 4);
  const pc = mod.melodyProfile(c, 0, 4);
  assert.ok(mod.cosineSimilarity(pa, pb) > 0.99);
  assert.ok(mod.cosineSimilarity(pa, pc) < 0.2, `实际 ${mod.cosineSimilarity(pa, pc)}`);
});

test('barIndexNear 取「起点不晚于目标」的最后一小节', () => {
  const mod = load();
  const a = bars([0, 2, 4, 5, 7]);
  assert.equal(mod.barIndexNear(a, -5), 0);
  assert.equal(mod.barIndexNear(a, 0), 0);
  assert.equal(mod.barIndexNear(a, 1999), 0);
  assert.equal(mod.barIndexNear(a, 2000), 1);
  assert.equal(mod.barIndexNear(a, 99_999), 4);
  assert.equal(mod.barIndexNear({}, 0), -1);
});

test('barChromaAt 越界返回 null，长度不匹配的数据整体作废', () => {
  const mod = load();
  const a = bars([0, 2]);
  assert.ok(mod.barChromaAt(a, 0));
  assert.equal(mod.barChromaAt(a, 2), null);
  assert.equal(mod.barChromaAt(a, -1), null);
  assert.equal(mod.melodyBarCount({ barChromaMs: [0, 2000], barChroma: [1, 0, 0] }), 0);
});

test('pickMelodyEntry 在 B 里挑出与 A 尾段同轮廓的那一句（不是第一句）', () => {
  const mod = load();
  // A 的尾段：主音 0 的那条动机（4 小节）
  const a = bars([0, 0, 0, 0], { third: true, fifth: true });
  // B：第 1 句在 0 ms 是别的调（6），第 2 句在 8000 ms 才是同一条动机
  const b = bars([6, 6, 6, 6, 0, 0, 0, 0], { noise: 0.02 });
  const picked = mod.pickMelodyEntry({
    a,
    b,
    entries: [0, 8000],
    aEndMs: 8000,
    windowBars: 4,
    minSim: 0.6,
  });
  assert.ok(picked, '应该挑到一句');
  assert.equal(picked.entryMs, 8000);
  assert.ok(picked.sim > 0.8, `相似度 ${picked.sim}`);
});

test('相似度都不够时返回 null（宁可退回首句也不硬凑）', () => {
  const mod = load();
  const a = bars([0, 0, 0, 0], { third: true, fifth: true });
  const b = bars([6, 6, 6, 6, 6, 6, 6, 6]);
  const picked = mod.pickMelodyEntry({ a, b, entries: [0, 4000], aEndMs: 8000, minSim: 0.6 });
  assert.equal(picked, null);
});

test('相似度接近时选更早的那一句（差 0.03 以内不跳远）', () => {
  const mod = load();
  const a = bars([0, 0, 0, 0], { third: true, fifth: true });
  // 两句几乎一样的轮廓，只差一点点噪声 → 应该取 0 ms
  const b = bars([0, 0, 0, 0, 0, 0, 0, 0], { noise: 0.01 });
  const picked = mod.pickMelodyEntry({ a, b, entries: [0, 8000], aEndMs: 8000, minSim: 0.5 });
  assert.ok(picked);
  assert.equal(picked.entryMs, 0);
});

test('缺 chroma 时安静地返回空结果（老缓存不炸）', () => {
  const mod = load();
  assert.deepEqual(mod.rankEntriesByMelody({ a: {}, b: {}, entries: [0], aEndMs: 1000 }), []);
  assert.equal(mod.pickMelodyEntry({ a: {}, b: {}, entries: [0], aEndMs: 1000 }), null);
  assert.equal(mod.cosineSimilarity(null, null), 0);
});

test('重复候选入口只算一次（同一句被切出两个起点）', () => {
  const mod = load();
  const a = bars([0, 0, 0, 0], { third: true, fifth: true });
  const b = bars([0, 0, 0, 0], { third: true, fifth: true });
  const ranked = mod.rankEntriesByMelody({ a, b, entries: [0, 0, 0], aEndMs: 8000 });
  assert.equal(ranked.length, 1);
});
