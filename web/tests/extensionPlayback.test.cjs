const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const ts = require(path.join(__dirname, '..', 'node_modules', 'typescript'));

function load() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'audio', 'extensionPlayer.ts'), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  const req = (n) => (n.includes('bridgePlan') ? { tileLoopChannels: () => [] } : {});
  new Function('exports', 'require', 'module', js)(mod.exports, req, mod);
  return mod.exports;
}
const P = load();

function fakeCtx(now) {
  const calls = { start: null, stop: null, ramps: [], sets: [] };
  const param = {
    value: 1,
    setValueAtTime(v, t) { calls.sets.push([v, t]); },
    linearRampToValueAtTime(v, t) { calls.ramps.push([v, t]); },
  };
  const gain = { gain: param, connect() {}, disconnect() {} };
  const source = {
    buffer: null, onended: null,
    connect() {}, disconnect() {},
    start(...args) { calls.start = args; },
    stop(t) { calls.stop = t; },
  };
  const ctx = {
    currentTime: now,
    createBufferSource: () => source,
    createGain: () => gain,
  };
  return { ctx, calls };
}

test('bed 起播：按窗口偏移、两端淡入淡出', () => {
  const { ctx, calls } = fakeCtx(10);
  const buffer = { duration: 8 };
  const handle = P.startExtensionPlayback({
    ctx, tap: { input: {} }, buffer, atSec: 10, gainDb: -8,
    offsetSec: 0, durationSec: 6, fadeInSec: 0.6, fadeOutSec: 1.2,
  });
  assert.ok(handle);
  assert.equal(calls.start[0], 10);
  assert.equal(calls.start[1], 0);
  const base = Math.pow(10, -8 / 20);
  assert.deepEqual(calls.sets[0], [0, 10]);
  assert.equal(calls.ramps[0][0], base);
  assert.ok(Math.abs(calls.ramps[0][1] - 10.6) < 1e-9);
  assert.equal(calls.ramps[1][0], 0);
  assert.ok(Math.abs(calls.ramps[1][1] - 16) < 1e-9);
  assert.ok(Math.abs(calls.stop - 16) < 1e-9);
  handle.stop();
  assert.equal(P.extensionActive(), false);
});

test('迟到起播：偏移按已过去的时间前推，不超过 buffer', () => {
  const { ctx, calls } = fakeCtx(12.5);
  const buffer = { duration: 8 };
  const handle = P.startExtensionPlayback({
    ctx, tap: { input: {} }, buffer, atSec: 10, gainDb: 0,
    offsetSec: 1, durationSec: 4, fadeInSec: 0, fadeOutSec: 0,
  });
  assert.ok(handle);
  // 起播时刻允许留在过去（Web Audio 会当成立即开始），偏移已按迟到量前推。
  assert.equal(calls.start[0], 10);
  assert.ok(Math.abs(calls.start[1] - 3.5) < 1e-9);
  handle.stop();
});
