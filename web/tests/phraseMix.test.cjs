// phraseMix：B 的起点必须留得下「淡化在首句之前结束」
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('E:/Zilux2开发/web/node_modules/typescript');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/core/automix/phraseMix.ts');

function load() {
  const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: () => ({}), console, Math, Number, Array, Object, Set, Map, isFinite, Infinity });
  return module.exports;
}

// 造一条 activity：drums 是按「第 n 个 hop 是否落在拍点」生成的方波，便于构造相似模式
function analysis({ durationMs, barMs = 2000, vocalAt = 0, drumAt = [] }) {
  const hopMs = 250;
  const n = Math.ceil(durationMs / hopMs);
  const drum = new Array(n).fill(0);
  for (const at of drumAt) for (let i = Math.floor(at / hopMs); i < (at + 400) / hopMs && i < n; i++) drum[i] = 1;
  const vocal = new Array(n).fill(0);
  if (vocalAt > 0) for (let i = Math.floor(vocalAt / hopMs); i < Math.min(n, (vocalAt + 6000) / hopMs); i++) vocal[i] = 0.8;
  return { durationMs, audibleEndMs: durationMs, bpm: 120, bpmConfidence: 0.9, beatIntervalMs: 500, barMs, activity: { hopMs, drum, bass: drum.slice(), vocal } };
}

test('matchDrumPhrase：B 的起点不会越过首句（淡化必须在唱词前结束）', () => {
  const mod = load();
  const a = analysis({ durationMs: 200000, drumAt: [190000, 190500, 191000, 191500] });
  // B：首句在 4.0 s；2 小节长的（1 s）鼓点模式在 40 s 处与 A 完全一致
  const b = analysis({ durationMs: 200000, vocalAt: 4000, drumAt: [40000, 40050, 40100, 40150] });
  const picked = mod.matchDrumPhrase(a, b, 192000, 150000, 0, 4000, Infinity, 2000);
  if (picked) {
    assert.ok(picked.y + picked.span <= 4000 + 300 + 0.5,
      `B 起点 ${picked.y} + 跨度 ${picked.span} 越过首句 4000ms`);
  }
});

test('matchDrumPhrase：首句很早时也不会把窗口挪到歌中间', () => {
  const mod = load();
  const a = analysis({ durationMs: 200000, drumAt: [190000, 190500, 191000, 191500] });
  const b = analysis({ durationMs: 200000, vocalAt: 2000, drumAt: [60000, 60050, 60100, 60150] });
  const picked = mod.matchDrumPhrase(a, b, 192000, 150000, 0, 2000, Infinity, 2000);
  if (picked) assert.ok(picked.y + picked.span <= 2300.5, 'B 起点越过首句');
});

test('matchDrumPhrase：没有唱词时仍可在头部 16 s 内找模式', () => {
  const mod = load();
  const a = analysis({ durationMs: 200000, drumAt: [190000, 190500, 191000, 191500] });
  const b = analysis({ durationMs: 200000, vocalAt: 0, drumAt: [8000, 8050, 8100, 8150] });
  const picked = mod.matchDrumPhrase(a, b, 192000, 150000, 0, 0, Infinity, 2000);
  if (picked) assert.ok(picked.y <= 16000, '超出头部窗口');
});

// ── 入点清晰度：B 开唱要清楚，A 要收声 ────────────────────────────
test('entryClarity：B 在落点后开唱、A 已收声 → 正分', () => {
  const mod = load();
  const x = 60000, span = 8000, y = 20000, bar = 2000;
  const a = analysis({ durationMs: 200000, vocalAt: 0 });          // A 全程无唱
  const b = analysis({ durationMs: 200000, vocalAt: y + bar * 0.6 }); // B 落点后一拍内开唱
  const v = mod.entryClarity(a, b, x, y, span, bar);
  assert.ok(v > 0.2, `v=${v}`);
});

test('entryClarity：A 还在拖音、B 又不唱 → 负分', () => {
  const mod = load();
  const x = 60000, span = 8000, y = 20000, bar = 2000;
  const a = analysis({ durationMs: 200000, vocalAt: x + span - 1200 }); // A 拖到窗口末
  const b = analysis({ durationMs: 200000, vocalAt: 0 });                 // B 没唱
  const v = mod.entryClarity(a, b, x, y, span, bar);
  assert.ok(v < -0.1, `v=${v}`);
});
