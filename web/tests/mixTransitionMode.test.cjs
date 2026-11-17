// Run with: node --test web/tests/mixTransitionMode.test.cjs
// 设置键测试：默认值、非法值回落、键名不与壁纸冲突、切换、写失败不抛。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function loadWithLocalStorage(store) {
  const file = path.join(ROOT, 'src/core', 'mixTransitionMode.ts');
  const exports = {};
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => {
      if (store.__throw) throw new Error('quota');
      store[k] = String(v);
    },
  };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { exports, console, localStorage, require: () => ({}) },
    { filename: file },
  );
  return exports;
}

test('默认 standard，键名是 mixTransitionMode（不是壁纸的 transitionMode）', () => {
  const mod = loadWithLocalStorage({});
  assert.equal(mod.MIX_TRANSITION_KEY, 'mixTransitionMode');
  assert.equal(mod.readMixTransitionMode(), 'standard');
});

test('读到 advanced 就返回 advanced', () => {
  const mod = loadWithLocalStorage({ mixTransitionMode: 'advanced' });
  assert.equal(mod.readMixTransitionMode(), 'advanced');
});

test('非法值/大小写/空串一律回落 standard', () => {
  for (const bad of ['Advanced', 'pro', '', ' standard', '1']) {
    const mod = loadWithLocalStorage({ mixTransitionMode: bad });
    assert.equal(mod.readMixTransitionMode(), 'standard', `值 ${JSON.stringify(bad)} 应回落`);
  }
});

test('写入返回生效值，非法入参写 standard', () => {
  const store = {};
  const mod = loadWithLocalStorage(store);
  assert.equal(mod.writeMixTransitionMode('advanced'), 'advanced');
  assert.equal(store.mixTransitionMode, 'advanced');
  assert.equal(mod.writeMixTransitionMode('bogus'), 'standard');
  assert.equal(store.mixTransitionMode, 'standard');
});

test('toggle 按标准 → 进阶 → 稳妥 → 标准 循环', () => {
  const store = {};
  const mod = loadWithLocalStorage(store);
  assert.equal(mod.toggleMixTransitionMode(), 'advanced');
  assert.equal(mod.toggleMixTransitionMode(), 'advancedSafe');
  assert.equal(mod.toggleMixTransitionMode(), 'standard');
});

test('稳妥档能被读回，且 wantsStemSwap/allowsDegradedSwap 语义正确', () => {
  const mod = loadWithLocalStorage({ mixTransitionMode: 'advancedSafe' });
  assert.equal(mod.readMixTransitionMode(), 'advancedSafe');
  assert.equal(mod.wantsStemSwap('advancedSafe'), true);
  assert.equal(mod.allowsDegradedSwap('advancedSafe'), false);
  assert.equal(mod.wantsStemSwap('advanced'), true);
  assert.equal(mod.allowsDegradedSwap('advanced'), true);
  assert.equal(mod.wantsStemSwap('standard'), false);
});

test('localStorage 抛错时不崩：读回 standard，写入仍返回目标值', () => {
  const store = { __throw: true };
  const mod = loadWithLocalStorage(store);
  assert.equal(mod.readMixTransitionMode(), 'standard');
  assert.equal(mod.writeMixTransitionMode('advanced'), 'advanced');
});

test('手法键：默认 auto，读写往返，非法值回落 auto', () => {
  const store = {};
  const mod = loadWithLocalStorage(store);
  assert.equal(mod.MIX_TEMPLATE_KEY, 'mixTransitionTemplate');
  assert.equal(mod.readMixTransitionTemplate(), 'auto');
  assert.equal(mod.writeMixTransitionTemplate('vocalFirst'), 'vocalFirst');
  // vm 沙箱里的 store 是另一个 realm 的对象，不能断言外层引用，只能靠读回验证
  assert.equal(mod.readMixTransitionTemplate(), 'vocalFirst');
  mod.writeMixTransitionTemplate('doubleDrop');
  assert.equal(mod.readMixTransitionTemplate(), 'doubleDrop');
  mod.writeMixTransitionTemplate('standard');
  assert.equal(mod.readMixTransitionTemplate(), 'auto', '非法值必须回落 auto');
  assert.equal(JSON.stringify(mod.MIX_TEMPLATE_ORDER), '["auto","vocalFirst","doubleDrop"]');
});
