const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const ts = require(path.join(__dirname, '..', 'node_modules', 'typescript'));

// 这一组测试直接跑音频图里的**排程函数**（scheduleAutomixV2 / Duck / Presence / TailBleed / Release）。
// 它们只碰 AudioParam，不碰节点连接，所以可以用一个记录调用的假参数代进去，
// 在 node 里把「排了什么自动化」逐条断言——这是体检台（没有 AudioContext）永远覆盖不到的一层。
function loadGraph() {
  const file = path.join(__dirname, '..', 'src', 'audio', 'automixV2Graph.ts');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const stub = (id) => {
    if (id.includes('audioTap')) return { attachDeckAutomixTap: () => null };
    if (id.includes('v2Plan')) return { V2_CROSSOVER_HZ: 120 };
    throw new Error(`unexpected require ${id}`);
  };
  const mod = { exports: {} };
  new Function('exports', 'require', 'module', js)(mod.exports, stub, mod);
  return mod.exports;
}
const G = loadGraph();

function param(initial = 0) {
  const calls = [];
  const p = {
    value: initial,
    calls,
    setValueAtTime(v, t) { calls.push(['set', v, t]); p.value = v; return p; },
    linearRampToValueAtTime(v, t) { calls.push(['lin', v, t]); p.value = v; return p; },
    exponentialRampToValueAtTime(v, t) { calls.push(['exp', v, t]); p.value = v; return p; },
    setTargetAtTime(v, t, tau) { calls.push(['target', v, t, tau]); return p; },
    cancelScheduledValues(t) { calls.push(['cancel', t]); return p; },
    cancelAndHoldAtTime(t) { calls.push(['hold', t]); return p; },
  };
  return p;
}

const ctx = { currentTime: 0, sampleRate: 48_000 };
// cancel/hold 的第二个参数是时间不是值：取值时必须把这两类滤掉
const valuesOf = (p) => p.calls.filter((c) => c[0] === 'set' || c[0] === 'lin' || c[0] === 'exp' || c[0] === 'target').map((c) => c[1]);
function fakeDeck() {
  return {
    midGain: { context: ctx, gain: param(0) },
    lowGain: { context: ctx, gain: param(0) },
    highGain: { context: ctx, gain: param(0) },
    sweepLp: { frequency: param(20_000) },
    sweepHp: { frequency: param(20) },
    lowTrim: { gain: param(1) },
    loudnessTrim: { gain: param(1) },
    unfade: { gain: param(1) },
    duck: { gain: param(0), frequency: param(2_500), Q: { value: 1 } },
    reverbSend: { gain: param(0) },
    reverbGain: { context: ctx, gain: param(0) },
    reverbDamp: { frequency: param(5_200) },
    aPress: { gain: param(1) },
    aDarken: { frequency: param(20_000) },
    hallSend: { context: ctx, gain: param(0) },
    hallGain: { context: ctx, gain: param(0) },
    hallPre: { delayTime: param(0.045) },
    hallConv: { buffer: null },
    hallDamp: { frequency: param(6_200) },
    echoSend: { context: ctx, gain: param(0) },
    echoDelay: { delayTime: param(0.2) },
    echoFeedback: { gain: param(0) },
    echoDamp: { frequency: param(4_000) },
    echoOut: { gain: param(0) },
  };
}

const curves = () => ({
  mid: [{ t: 0, v: 1 }, { t: 0.5, v: 0.7071 }, { t: 1, v: 0 }],
  low: [{ t: 0, v: 1 }, { t: 0.5, v: 0.5 }, { t: 1, v: 0 }],
  high: [{ t: 0, v: 1 }, { t: 0.5, v: 0.7071 }, { t: 1, v: 0 }],
  sweepLp: [{ t: 0, v: 20_000 }, { t: 1, v: 700 }],
  sweepHp: [{ t: 0, v: 12_000 }, { t: 1, v: 20 }],
});

test('主曲线只排线性斜坡，且增益从 0 起（不会满音量漏出来）', () => {
  const deck = fakeDeck();
  G.scheduleAutomixV2(deck, 10, 8, curves());
  for (const node of [deck.lowGain, deck.midGain, deck.highGain]) {
    const kinds = node.gain.calls.map((c) => c[0]);
    assert.ok(!kinds.includes('exp'), '增益不该用指数斜坡');
    assert.ok(node.gain.calls.every((c) => c[1] >= 0), '增益不能为负');
  }
  // 首点是曲线首个值，且时间不早于 startSec（预热那一次除外）
  const first = deck.lowGain.gain.calls.find((c) => c[0] === 'set');
  assert.equal(first[1], 1);
  // 频率在扫：低通从 20k 落到 700，高通从 12k 落到 20
  const lp = deck.sweepLp.frequency.calls.filter((c) => c[0] === 'exp');
  assert.ok(lp.length >= 1);
  assert.ok(lp[lp.length - 1][1] < 1_000);
  const hp = deck.sweepHp.frequency.calls.filter((c) => c[0] === 'exp');
  assert.ok(hp[hp.length - 1][1] <= 21);
});

test('让位曲线夹在 −9..0 dB', () => {
  const deck = fakeDeck();
  G.scheduleAutomixV2Duck(deck, [
    { atSec: 5, db: 0 },
    { atSec: 6, db: -3.5 },
    { atSec: 7, db: -40 },
    { atSec: 8, db: 12 },
    { atSec: 9, db: Number.NaN },
  ]);
  const values = valuesOf(deck.duck.gain);
  assert.ok(values.every((v) => v >= -9 && v <= 0), `越界: ${values.join(',')}`);
  assert.equal(values[0], 0);
});

test('人声叠加允许 +4 dB，但结尾必须回 0', () => {
  const deck = fakeDeck();
  G.scheduleAutomixV2Presence(deck, 5, 10, { fromDb: -6, toDb: 9, fromP: 0.3, releaseP: 0.9 });
  const values = valuesOf(deck.duck.gain);
  assert.ok(values.every((v) => v >= -9 && v <= 4), `越界: ${values.join(',')}`);
  assert.equal(values[values.length - 1], 0);
});

test('长尾收干先掐掉旧自动化再排气（否则从旧目标值硬跳）', () => {
  const deck = fakeDeck();
  deck.highGain.gain.value = 0.32;
  G.scheduleAutomixV2TailBleed(deck, 12, 2.5, 0.32);
  const kinds = deck.highGain.gain.calls.map((c) => c[0]);
  const firstRamp = kinds.findIndex((k) => k === 'exp' || k === 'lin');
  const lastCancel = Math.max(kinds.lastIndexOf('cancel'), kinds.lastIndexOf('hold'));
  assert.ok(lastCancel >= 0, '必须取消旧自动化');
  assert.ok(lastCancel < firstRamp, '取消要排在任何斜坡之前');
  const sets = deck.highGain.gain.calls.filter((c) => c[0] === 'set');
  assert.ok(sets.every((c) => c[1] >= 0.0002), '指数斜坡不能从 0 起');
});

test('收尾用 setTargetAtTime 释放混响/回声，不是一刀砍', () => {
  const deck = fakeDeck();
  G.releaseAutomixV2Tail(deck, 0.9);
  assert.ok(deck.reverbGain.gain.calls.some((c) => c[0] === 'target'));
  assert.ok(deck.echoOut.gain.calls.some((c) => c[0] === 'target'));
});

test('补平曲线只抬不降且受 cap', () => {
  const deck = fakeDeck();
  G.scheduleLoudnessTrim(deck, 4, 10, [
    { p: 0, db: 0 },
    { p: 0.5, db: 2.4 },
    { p: 1, db: 9 },
  ]);
  const values = valuesOf(deck.loudnessTrim.gain);
  // scheduleLoudnessTrim 内部按 dB→线性换算，只允许 >=1
  assert.ok(values.every((v) => v >= 0.999), `出现衰减: ${values.join(',')}`);
});


test('scheduleAutomixV2Hall 慢起、封顶、收尾归零', () => {
  const deck = fakeDeck();
  G.scheduleAutomixV2Hall(deck, 10, 12, { sendDb: -9, fromP: 0.16, attackP: 0.55, releaseP: 0.82, tailMs: 2000 });
  const send = valuesOf(deck.hallSend.gain);
  const peak = 10 ** (-9 / 20);
  // 慢起：第一个爬升点必须明显低于峰值（不是一刀切到位）
  const ramps = send.filter((v) => v > 0);
  assert.ok(ramps[0] < peak * 0.4, `firstRamp=${ramps[0]} peak=${peak}`);
  assert.ok(Math.abs(Math.max(...send) - peak) < 1e-6, `max=${Math.max(...send)}`);
  // 尾部线性归零
  assert.ok(deck.hallSend.gain.calls.some((c) => c[0] === 'lin' && c[1] === 0));
});


test('scheduleAutomixV2Press 陡升段压音并把 A 收闷，结尾回原值', () => {
  const deck = fakeDeck();
  G.scheduleAutomixV2Press(deck, 4, 10, [
    { p: 0, drive: 0 },
    { p: 0.3, drive: 1 },
    { p: 0.6, drive: 0.4 },
    { p: 1, drive: 0 },
  ], { pressDb: -5, floorHz: 1500 });
  const gains = valuesOf(deck.aPress.gain);
  const hz = valuesOf(deck.aDarken.frequency);
  // 压音：最低点 = −5 dB
  assert.ok(Math.abs(Math.min(...gains) - 10 ** (-5 / 20)) < 1e-6, `minGain=${Math.min(...gains)}`);
  // 收闷：最低截止 = 1500 Hz
  assert.ok(Math.abs(Math.min(...hz) - 1500) < 1e-6, `minHz=${Math.min(...hz)}`);
  // 结束时必须回 1 与 20 kHz（否则会一直闷着）
  assert.equal(gains[gains.length - 1], 1);
  assert.equal(hz[hz.length - 1], 20_000);
});
