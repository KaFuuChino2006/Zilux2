// Run with: node --test web/tests/stemGraphLifecycle.test.cjs
// G3（§8 验收）：拆图必须把图里每个节点都断开，且重复 dispose 不再重复断/不抛。
// 真实的 AudioContext 在验收脚本里跑；这里用计数替身把「建了几个节点、断了几个」变成可断言的数字。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function loadStemGraph(deps = {}) {
  const file = path.join(ROOT, 'src/audio/stemGraph.ts');
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

/** 计数用的假 WebAudio：每个节点都有 gain/delayTime/frequency 三件套，connect 记账、disconnect 记账。 */
function fakeContext() {
  const stats = { created: 0, connected: 0, disconnected: 0 };
  const param = () => ({
    value: 1,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    cancelScheduledValues() {},
    cancelAndHoldAtTime() {},
    setValueCurveAtTime() {},
    // 真 BiquadFilterNode 的频率是「当前值 + 自动化」；高通扫频会用到 index 斜坡与 Q。
    exponentialRampToValueAtTime() {},
  });
  const node = () => {
    stats.created += 1;
    return {
      gain: param(),
      delayTime: param(),
      frequency: param(),
      Q: param(),
      type: '',
      connect() { stats.connected += 1; },
      disconnect() { stats.disconnected += 1; },
    };
  };
  return {
    stats,
    ctx: {
      currentTime: 0,
      createGain: node,
      createDelay: node,
      createBiquadFilter: node,
    },
  };
}

const djMovesStub = {
  ECHO: { divisionBeats: 0.25, feedback: 0.35, dampHz: 3000, duckDb: -6, duckAttackMs: 5 },
};

test('E25：减法模式给每轨插 −1 反相器，输出 = mix − Σ(g·stem)', () => {
  const { StemGraph } = loadStemGraph({ '../core/djMoves': djMovesStub });
  const { ctx, stats } = fakeContext();
  const destination = { connect() {}, disconnect() {} };
  const graph = new StemGraph(ctx, destination, { subtractive: true });
  assert.equal(graph.bus('A').subtractive, true, 'subtractive 没落到 bus 上');
  // 加法模式每台 21 节点；减法每轨多一个反相器 ⇒ 每台 25，双台 50。
  assert.equal(stats.created, 50, `减法模式节点数不对：${stats.created}`);
  // 加法 52 条连接；减法把 duck→bus 改成 duck→invert→bus，多 8 跳 ⇒ 60。
  assert.equal(stats.connected, 60, `减法模式连接数不对：${stats.connected}`);
  const busA = graph.bus('A');
  const mix = { connect() { stats.connected += 1; }, disconnect() {} };
  busA.connectMix(mix);
  assert.equal(stats.connected, 61, 'connectMix 没接到 bus');
  graph.dispose();
});

test('G3：StemGraph.dispose 断开全部节点（21 节点/台 × 2 台）', () => {
  const { StemGraph } = loadStemGraph({ '../core/djMoves': djMovesStub });
  const { ctx, stats } = fakeContext();
  const destination = { connect() {}, disconnect() {} };
  const graph = new StemGraph(ctx, destination);
  // 每台 9 个总线节点（input/bus/hpf/lpf/duck/echoSend/delay/damp/feedback）+ 4 轨 × 3 个 = 21；双 deck = 42。
  assert.equal(stats.created, 42, `建图节点数不对：${stats.created}`);
  assert.equal(stats.connected, 52, `连接数不对：${stats.connected}`);
  graph.dispose();
  assert.equal(stats.disconnected, 42, `dispose 少断了节点：${stats.disconnected}/42`);
  // 幂等：再拆一次不许重复断（否则会把别人复用的节点断掉）。
  graph.dispose();
  assert.equal(stats.disconnected, 42, 'dispose 不是幂等的');
});

test('G3：applyAll 起点在过去时整批丢弃，不排任何事件', () => {
  const { StemGraph } = loadStemGraph({ '../core/djMoves': djMovesStub });
  const { ctx } = fakeContext();
  const graph = new StemGraph(ctx, { connect() {}, disconnect() {} });
  ctx.currentTime = 10;
  const events = [
    { kind: 'gainCurve', deck: 'A', stem: 'bass', curve: [1, 1, 0, 0], startMs: 0, durationMs: 1000 },
  ];
  assert.equal(graph.applyAll(events, 5), false, '过去的起点应当被丢弃');
  assert.equal(graph.applyAll(events, 10.01), true, '容差内的起点应当接受');
  graph.dispose();
});

test('G3：setEchoTime 夹到 [0.01, 4] 秒并写进 delayTime', () => {
  const { DeckStemBus } = loadStemGraph({ '../core/djMoves': djMovesStub });
  const { ctx } = fakeContext();
  const written = [];
  const original = ctx.createDelay;
  ctx.createDelay = () => {
    const node = original();
    node.delayTime.setValueAtTime = (v) => written.push(v);
    return node;
  };
  const bus = new DeckStemBus(ctx, 'A', { connect() {}, disconnect() {} });
  bus.setEchoTime(0.0001);
  bus.setEchoTime(99);
  bus.setEchoTime(0.42);
  assert.deepEqual(written, [0.01, 4, 0.42]);
  bus.dispose();
});

test('applyAll 时间门禁：容差边界与 NaN 起点', () => {
  const { StemGraph } = loadStemGraph({ '../core/djMoves': djMovesStub });
  const { ctx } = fakeContext();
  const graph = new StemGraph(ctx, { connect() {}, disconnect() {} });
  ctx.currentTime = 10;
  const events = [
    { kind: 'gainCurve', deck: 'A', stem: 'bass', curve: [1, 1, 0, 0], atMs: 0, durationMs: 1000 },
  ];
  assert.equal(graph.applyAll(events, 10), true, '起点正好等于当前时间应允许');
  assert.equal(graph.applyAll(events, 10.5), true, '未来起点应允许');
  assert.equal(graph.applyAll(events, 9.96), true, '容差内（早 40 ms）应允许');
  assert.equal(graph.applyAll(events, 9.94), false, '超出容差（早 60 ms）应整批丢弃');
  assert.equal(graph.applyAll(events, Number.NaN), false, 'NaN 起点必须拒绝，不能写进 AudioParam');
  graph.dispose();
});

test('E22：filter 事件把高通从 320 Hz 指数推到 18 kHz', () => {
  const calls = [];
  const param = (tag) => ({
    value: 1,
    setValueAtTime: (v, t) => calls.push(['set', tag, v, t]),
    linearRampToValueAtTime: (v, t) => calls.push(['linear', tag, v, t]),
    exponentialRampToValueAtTime: (v, t) => calls.push(['exp', tag, v, t]),
    cancelScheduledValues: () => calls.push(['cancel', tag]),
    cancelAndHoldAtTime: () => calls.push(['hold', tag]),
    setValueCurveAtTime: () => {},
  });
  let created = 0;
  const node = () => {
    created += 1;
    const id = created;
    return {
      gain: param(`g${id}`),
      delayTime: param(`d${id}`),
      frequency: param(`f${id}`),
      Q: param(`q${id}`),
      type: '',
      connect() {},
      disconnect() {},
    };
  };
  const ctx = { currentTime: 4, createGain: node, createDelay: node, createBiquadFilter: node };
  const bus = new (loadStemGraph({ '../core/djMoves': djMovesStub }).DeckStemBus)(ctx, 'B', { connect() {}, disconnect() {} });

  bus.apply(
    { kind: 'filter', deck: 'B', atMs: 1000, durationMs: 4000, fromHz: 320, toHz: 18000 },
    10, // 过渡起点 10 s ⇒ 事件在 11 s 开始、15 s 结束
  );

  const setHz = calls.find((c) => c[0] === 'set' && c[2] === 320);
  assert.ok(setHz, `没把起点写成 320 Hz：${JSON.stringify(calls)}`);
  assert.equal(setHz[3], 11, '起点必须落在 11 s');
  const ramp = calls.find((c) => c[0] === 'exp' && c[2] === 18000);
  assert.ok(ramp, `没有指数斜坡到 18 kHz：${JSON.stringify(calls)}`);
  assert.equal(ramp[3], 15, '斜坡终点必须落在 15 s');
});
