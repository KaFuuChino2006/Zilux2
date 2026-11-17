// Run with: node --test web/tests/advancedReadiness.test.cjs
// 四轨预热登记表：键口径、TTL、并发预热与失败降级（T4-3 的前置条件）。
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
  const sandbox = { exports, console, require: (id) => deps[id] ?? {}, setTimeout, clearTimeout };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    sandbox,
    { filename: file },
  );
  return exports;
}

const STEM_WINDOW_SEC = 30;
const readiness = loadModule('src/audio', 'advancedReadiness', {
  '../core/stemsClient': { STEM_WINDOW_SEC, prepareStemsWindow: async () => ({ state: 'ready', window: 0, cached: true }) },
});

const track = (id) => ({ source: 'local', id, title: id, artist: '', album: '', durationMs: 180000, cover: '', playable: true });

test('stemWindowOf 以 30 秒分窗并与宿主口径一致', () => {
  assert.equal(readiness.stemWindowOf(0), 0);
  assert.equal(readiness.stemWindowOf(29.999), 0);
  assert.equal(readiness.stemWindowOf(30), 1);
  assert.equal(readiness.stemWindowOf(-5), 0);
  assert.equal(readiness.stemWindowOf(Number.NaN), 0);
  assert.equal(readiness.stemWindowOf(61, 10), 6);
});

test('stemKeyOf 带 source/id 且区分窗口；缺 id 返回空串', () => {
  const a = readiness.stemKeyOf(track('abc'), 5);
  assert.equal(a, 'local:abc#0');
  assert.equal(readiness.stemKeyOf(track('abc'), 35), 'local:abc#1');
  assert.equal(readiness.stemKeyOf(null, 5), '');
  assert.equal(readiness.stemKeyOf({ ...track(''), title: '' }, 5), '');
});

test('登记后 isStemReady 为真，过期后自动失效', () => {
  readiness.resetStemReadiness();
  readiness.markStemReady('k1', { ttlMs: 1000, now: 1000 });
  assert.equal(readiness.isStemReady('k1', 1500), true);
  assert.equal(readiness.isStemReady('k1', 2001), false);
  assert.equal(readiness.isStemReady('', 1000), false);
  assert.equal(readiness.isStemReady('missing', 1000), false);
});

test('readyStemKeys 过滤过期键并排序', () => {
  readiness.resetStemReadiness();
  readiness.markStemReady('b', { ttlMs: 1000, now: 0 });
  readiness.markStemReady('a', { ttlMs: 10, now: 0 });
  // vm 沙箱返回的数组属于另一个 realm，deepEqual 会因原型不同误报 ⇒ 比 JSON。
  assert.equal(JSON.stringify(readiness.readyStemKeys(100)), JSON.stringify(['b']));
  assert.equal(JSON.stringify(readiness.readyStemKeys(2000)), JSON.stringify([]));
});

test('prefetchStemsForTransition 成功时两侧都登记，并统计实算窗数', async () => {
  readiness.resetStemReadiness();
  const calls = [];
  const prepare = async (t, window, options) => {
    calls.push([t.id, window, options.stems, options.windowSec]);
    return { state: 'ready', window, cached: t.id === 'b' };
  };
  const result = await readiness.prefetchStemsForTransition(
    { track: track('a'), positionSec: 31 },
    { track: track('b'), positionSec: 2 },
    { prepare, now: 0 },
  );
  assert.equal(result.aReady, true);
  assert.equal(result.bReady, true);
  assert.equal(result.computed, 1);
  assert.equal(result.error, '');
  assert.equal(result.keyA, 'local:a#1');
  assert.equal(result.keyB, 'local:b#0');
  assert.deepEqual(calls, [['a', 1, 4, 30], ['b', 0, 4, 30]]);
  assert.equal(readiness.isStemReady(result.keyA, 1), true);
});

test('一侧失败只标该侧，不抛异常', async () => {
  readiness.resetStemReadiness();
  const prepare = async (t) => {
    if (t.id === 'a') throw new Error('模型缺失');
    return { state: 'ready', window: 0, cached: false };
  };
  const result = await readiness.prefetchStemsForTransition(
    { track: track('a'), positionSec: 0 },
    { track: track('b'), positionSec: 0 },
    { prepare, now: 0 },
  );
  assert.equal(result.aReady, false);
  assert.equal(result.bReady, true);
  assert.match(result.error, /模型缺失/);
  assert.equal(readiness.isStemReady(result.keyA, 0), false);
  assert.equal(readiness.isStemReady(result.keyB, 0), true);
});

test('宿主返回 error 状态视为失败', async () => {
  readiness.resetStemReadiness();
  const result = await readiness.prefetchStemsForTransition(
    { track: track('a'), positionSec: 0 },
    { track: track('b'), positionSec: 0 },
    { prepare: async () => ({ state: 'error', window: 0 }), now: 0 },
  );
  assert.equal(result.aReady, false);
  assert.equal(result.bReady, false);
  assert.match(result.error, /都没预热成功/);
});

test('缺 track 的一侧直接判失败，不会去请求宿主', async () => {
  readiness.resetStemReadiness();
  let calls = 0;
  const result = await readiness.prefetchStemsForTransition(
    { track: null, positionSec: 0 },
    { track: track('b'), positionSec: 0 },
    { prepare: async () => { calls += 1; return { state: 'ready', window: 0, cached: false }; }, now: 0 },
  );
  assert.equal(calls, 1);
  assert.equal(result.aReady, false);
  assert.equal(result.bReady, true);
});

test('跨窗：stemSpanWindows/stemSpanKeys 覆盖整段，isStemSpanReady 要求全部登记', () => {
  const r = readiness;
  readiness.resetStemReadiness();
  const track = { id: 't1', title: 'T', source: 'local' };

  assert.deepEqual([...readiness.stemSpanWindows(10, 60)], [0, 1, 2], '10 s 起 60 s 跨度覆盖 3 窗');
  const keys = readiness.stemSpanKeys(track, 10, 60);
  assert.equal(keys.length, 3);
  assert.equal(keys[0], 'local:t1#0');

  assert.equal(readiness.isStemSpanReady(track, 10, 60), false, '一个都没登记时必须 false');
  readiness.markStemReady(keys[0]);
  readiness.markStemReady(keys[1]);
  assert.equal(readiness.isStemSpanReady(track, 10, 60), false, '缺最后一窗仍必须 false');
  readiness.markStemReady(keys[2]);
  assert.equal(readiness.isStemSpanReady(track, 10, 60), true);
});

test('跨窗预热：prefetchStemSpan 把每个窗口都登记，并统计实算次数', async () => {
  const r = readiness;
  readiness.resetStemReadiness();
  const calls = [];
  const prepare = async (_track, window, options) => {
    calls.push([window, options && options.stems]);
    return { state: 'ok', cached: window === 1 };
  };
  const track = { id: 't2', title: 'T2', source: 'local' };
  const result = await readiness.prefetchStemSpan({ track, positionSec: 10 }, { track, positionSec: 10 }, 60, { prepare });

  // 两条 deck 是同一首歌同一位置 ⇒ 窗口键相同，按窗口去重后只算 0/1/2 三窗
  // （同一文件同一窗算一次就够了，宿主也是按窗口缓存的）。
  assert.deepEqual(calls.map((c) => c[0]).sort(), [0, 1, 2], '同键去重：三窗各一次');
  assert.equal(result.computed, 2, '窗 0/2 实算，窗 1 命中缓存');
  assert.equal(result.aReady && result.bReady, true);
  assert.equal(readiness.isStemSpanReady(track, 10, 60), true);
});

// ---------------------------------------------------------------- 预热预算（第 30 轮）

test('跨窗预热：每条 deck 串行（全局面向上限 2），不再一次打出 8 条请求', async () => {
  readiness.resetStemReadiness();
  let inflightNow = 0;
  let maxInflight = 0;
  const calls = [];
  const prepare = async (track, window) => {
    calls.push(`${track.id}#${window}`);
    inflightNow += 1;
    maxInflight = Math.max(maxInflight, inflightNow);
    await new Promise((r) => setTimeout(r, 3));
    inflightNow -= 1;
    return { state: 'ready', window, cached: false };
  };
  const out = await readiness.prefetchStemSpan(
    { track: track('a'), positionSec: 0 },
    { track: track('b'), positionSec: 0 },
    90,
    { prepare },
  );
  assert.equal(out.aReady, true);
  assert.equal(out.bReady, true);
  assert.equal(calls.length, 6, '3 窗 × 2 deck');
  assert.equal(maxInflight, 2, '每条 deck 内部串行，两条 deck 之间并行');
  assert.equal(out.computed, 6);
  assert.deepEqual(calls, ['a#0', 'b#0', 'a#1', 'b#1', 'a#2', 'b#2']);
});

test('同一窗口的重复预热只发一次请求（去重）', async () => {
  readiness.resetStemReadiness();
  let calls = 0;
  const prepare = async (track, window) => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return { state: 'ready', window, cached: false };
  };
  const a = { track: track('x'), positionSec: 0 };
  const b = { track: track('y'), positionSec: 0 };
  const [first, second] = await Promise.all([
    readiness.prefetchStemSpan(a, b, 60, { prepare }),
    readiness.prefetchStemSpan(a, b, 60, { prepare }),
  ]);
  assert.equal(first.aReady, true);
  assert.equal(second.aReady, true);
  assert.equal(calls, 4, '2 窗 × 2 deck；第二次同窗请求复用第一次的在途 Promise');
});

test('单个窗口失败 ⇒ 该侧 false，已成功的窗口仍然登记', async () => {
  readiness.resetStemReadiness();
  const prepare = async (track, window) => (window === 1 && track.id === 'a'
    ? { state: 'error', window, cached: false }
    : { state: 'ready', window, cached: false });
  const out = await readiness.prefetchStemSpan(
    { track: track('a'), positionSec: 0 },
    { track: track('b'), positionSec: 0 },
    60,
    { prepare },
  );
  assert.equal(out.aReady, false);
  assert.equal(out.bReady, true);
  assert.ok(out.error.includes('A 侧'), out.error);
  assert.equal(readiness.isStemReady(readiness.stemKeyOf(track('a'), 0)), true, '第 0 窗已经算好并登记');
  assert.equal(readiness.isStemReady(readiness.stemKeyOf(track('a'), 30)), false, '第 1 窗失败不登记');
});
