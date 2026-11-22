const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('E:/Zilux2开发/web/node_modules/typescript');
const vm = require('node:vm');

const SRC = path.resolve(__dirname, '../src/ui/hudGeometry.ts');

function load() {
  const code = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Number, Math, Object });
  return module.exports;
}

const mod = load();

test('窗口内的位置原样保留（只取整）', () => {
  assert.deepEqual({ ...mod.clampHudPosition(320, 180, 1280, 800) }, { x: 320, y: 180 });
  assert.deepEqual({ ...mod.clampHudPosition(320.6, 180.2, 1280, 800) }, { x: 321, y: 180 });
});

test('负坐标夹回 0（副屏在左边时会出现负数）', () => {
  assert.deepEqual({ ...mod.clampHudPosition(-2400, -120, 1280, 800) }, { x: 0, y: 0 });
});

test('双屏拖到 x=2400 后拔掉副屏 → 夹到留 120×60 可见', () => {
  assert.deepEqual({ ...mod.clampHudPosition(2400, 1400, 1280, 800) }, { x: 1160, y: 740 });
});

test('视口比保留量还小（极小窗口）时不出现负上限', () => {
  assert.deepEqual({ ...mod.clampHudPosition(50, 50, 100, 40) }, { x: 0, y: 0 });
});

test('坏数据（NaN）当 0 处理，不让 style 变成 NaNpx', () => {
  assert.deepEqual({ ...mod.clampHudPosition(Number.NaN, Number.NaN, 1280, 800) }, { x: 0, y: 0 });
});
