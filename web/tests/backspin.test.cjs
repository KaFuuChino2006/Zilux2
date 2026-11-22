// Run with: node --test web/tests/backspin.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load() {
  const file = path.resolve(__dirname, '../src/core/automix/backspin.ts');
  const source = fs.readFileSync(file, 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { module, exports: module.exports, console },
    { filename: file },
  );
  return module.exports;
}

const mod = load();

test('窗口太短不启用：倒带不足 1 s 会听成「噗」一声', () => {
  assert.equal(mod.planBackspin({ fadeMs: 900, barMs: 2000 }).enabled, false);
  assert.equal(mod.planBackspin({ fadeMs: 0, barMs: 2000 }).enabled, false);
});

test('倒带长度取一小节，并夹在 1.0–2.4 s', () => {
  assert.equal(mod.planBackspin({ fadeMs: 12000, barMs: 2000 }).tailMs, 2000);
  assert.equal(mod.planBackspin({ fadeMs: 12000, barMs: 600 }).tailMs, 1000);
  assert.equal(mod.planBackspin({ fadeMs: 12000, barMs: 4000 }).tailMs, 2400);
});

test('倒带不超过过渡窗口本身', () => {
  assert.equal(mod.planBackspin({ fadeMs: 1300, barMs: 2000 }).tailMs, 1300);
});

test('非法 barMs / fadeMs 走安全默认，不返回 NaN', () => {
  const p = mod.planBackspin({ fadeMs: Number.NaN, barMs: Number.NaN });
  assert.equal(p.enabled, false);
  const q = mod.planBackspin({ fadeMs: 8000, barMs: Number.NaN });
  assert.equal(q.tailMs, 2000);
});

test('调性差得远时文案改成「用倒带当休止」', () => {
  const far = mod.planBackspin({ fadeMs: 8000, barMs: 2000, keyGap: 5 });
  assert.match(far.note, /调性差 5/);
  const near = mod.planBackspin({ fadeMs: 8000, barMs: 2000, keyGap: 1 });
  assert.match(near.note, /一小节倒带收尾/);
});

test('播放速率保持 1.0，去咔哒固定 5 ms', () => {
  const p = mod.planBackspin({ fadeMs: 8000, barMs: 2000 });
  assert.equal(p.rate, 1);
  assert.equal(p.declickMs, 5);
});

test('器乐尾段用「不切人声」的说法', () => {
  const p = mod.planBackspin({ fadeMs: 8000, barMs: 2000, aInstrumental: true });
  assert.match(p.note, /器乐尾段/);
});
