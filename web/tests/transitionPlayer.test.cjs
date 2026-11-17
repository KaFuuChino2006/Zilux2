// Run with: node --test web/tests/transitionPlayer.test.cjs
// 4 轨播放器里可测的纯逻辑：窗口换算、偏移、剩余时长。音频节点部分需要真 AudioContext，放到验收脚本。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function loadModule(rel, name, deps = {}) {
  const file = path.join(ROOT, rel, name + '.ts');
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { exports, console, require: (id) => deps[id] ?? ({}), setTimeout, clearTimeout },
    { filename: file },
  );
  return exports;
}

const stemsClientStub = { STEM_WINDOW_SEC: 30, loadStemWindow: async () => { throw new Error('not used'); } };
const player = loadModule('src/audio', 'stemPlayer', {
  '../core/stemsClient': stemsClientStub,
  './stemGraph': {},
});

test('windowStartSec：窗口号 × 窗口长度，非法值按 0', () => {
  assert.equal(player.windowStartSec(0), 0);
  assert.equal(player.windowStartSec(1), 30);
  assert.equal(player.windowStartSec(3, 10), 30);
  assert.equal(player.windowStartSec(-2), 0);
  assert.equal(player.windowStartSec(Number.NaN), 0);
});

test('offsetInWindowSec：位置折进窗口，越界不返回负数', () => {
  assert.equal(player.offsetInWindowSec(0, 0), 0);
  assert.equal(player.offsetInWindowSec(12.5, 0), 12.5);
  assert.equal(player.offsetInWindowSec(45, 1), 15);
  assert.equal(player.offsetInWindowSec(5, 1), 0); // 位置早于窗口起点 → 夹到 0
});

test('remainingInWindowSec：窗口末尾递减到 0', () => {
  assert.equal(player.remainingInWindowSec(0, 0), 30);
  assert.equal(player.remainingInWindowSec(10, 0), 20);
  assert.equal(player.remainingInWindowSec(30, 1), 30);
  assert.equal(player.remainingInWindowSec(60, 1), 0);
});

test('FOUR_STEMS 顺序与宿主一致：drums/bass/other/vocals', () => {
  assert.equal(JSON.stringify([...player.FOUR_STEMS]), JSON.stringify(['drums', 'bass', 'other', 'vocals']));
});
