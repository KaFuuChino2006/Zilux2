// Run with: node --test web/tests/advancedHandoff.test.cjs
// 交接点契约：标准模式不触碰工厂；进阶模式的任何异常都必须安全回落。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function load() {
  const file = path.join(ROOT, 'src/core', 'advancedHandoff.ts');
  const exports = {};
  const warnings = [];
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { exports, console: { warn: (...args) => warnings.push(args.join(' ')) }, require: () => ({}) },
    { filename: file },
  );
  return { mod: exports, warnings };
}

function fakeHandoff() {
  const calls = [];
  return {
    calls,
    handoff: {
      start: (clock) => calls.push(['start', clock]),
      cancel: () => calls.push(['cancel']),
      dispose: () => calls.push(['dispose']),
    },
  };
}

const REQ = { mode: 'advanced', kind: 'auto', fadeMs: 8000, tempoRate: 1.02 };

test('没有注入工厂时返回 null，且 hasHandoffFactory 为 false', () => {
  const { mod } = load();
  assert.equal(mod.hasHandoffFactory(), false);
  assert.equal(mod.requestHandoff(REQ), null);
});

test('标准模式即使有工厂也不调用（老路径零变化）', () => {
  const { mod } = load();
  let called = 0;
  mod.setHandoffFactory(() => {
    called += 1;
    return fakeHandoff().handoff;
  });
  assert.equal(mod.requestHandoff({ ...REQ, mode: 'standard' }), null);
  assert.equal(called, 0);
  assert.equal(mod.hasHandoffFactory(), true);
});

test('进阶模式把请求原样交给工厂并返回同一个对象', () => {
  const { mod } = load();
  const seen = [];
  const { handoff } = fakeHandoff();
  mod.setHandoffFactory((request) => {
    seen.push(request);
    return handoff;
  });
  assert.equal(mod.requestHandoff(REQ), handoff);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'auto');
  assert.equal(seen[0].fadeMs, 8000);
  assert.equal(seen[0].tempoRate, 1.02);
});

test('工厂返回 null 时回落标准路径', () => {
  const { mod } = load();
  mod.setHandoffFactory(() => null);
  assert.equal(mod.requestHandoff(REQ), null);
});

test('工厂抛错时不冒泡，只留下告警', () => {
  const { mod, warnings } = load();
  mod.setHandoffFactory(() => {
    throw new Error('boom');
  });
  assert.equal(mod.requestHandoff(REQ), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /boom/);
});

test('工厂返回残缺对象（缺 dispose）时拒绝并告警', () => {
  const { mod, warnings } = load();
  mod.setHandoffFactory(() => ({ start() {}, cancel() {} }));
  assert.equal(mod.requestHandoff(REQ), null);
  assert.match(warnings.join('\n'), /start\/cancel\/dispose/);
});

test('稳妥档也走工厂（两档进阶都算 advanced）', () => {
  const { mod } = load();
  const { handoff } = fakeHandoff();
  mod.setHandoffFactory(() => handoff);
  assert.equal(mod.requestHandoff({ ...REQ, mode: 'advancedSafe' }), handoff);
});

test('setHandoffFactory(null) 能清掉工厂', () => {
  const { mod } = load();
  mod.setHandoffFactory(() => fakeHandoff().handoff);
  assert.equal(mod.hasHandoffFactory(), true);
  mod.setHandoffFactory(null);
  assert.equal(mod.hasHandoffFactory(), false);
  assert.equal(mod.requestHandoff(REQ), null);
});
