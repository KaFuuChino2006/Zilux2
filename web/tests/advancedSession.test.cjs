// Run with: node --test web/tests/advancedSession.test.cjs
// 会话生命周期（T4 内核）用替身验证：接管静音、失败回退、cancel 拆图 + 斜坡还原。
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
  const sandbox = { exports, console, require: (id) => deps[id] ?? ({}), setTimeout, clearTimeout };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    sandbox,
    { filename: file },
  );
  return exports;
}

const moves = loadModule('src/core', 'djMoves');
const correlation = loadModule('src/core', 'correlation');
const sessionMod = loadModule('src/audio', 'advancedSession', {
  '../core/djMoves': moves,
  '../core/correlation': correlation,
});

/** 假 deck 元素：只要 volume 可读写。 */
function fakeElement(volume = 0.8) {
  return { volume };
}

/** 假图：记录 applyAll / dispose / setEchoTime。 */
function fakeGraph(log) {
  const buses = {
    A: { setEchoTime: (s) => log.push(['echoA', s]) },
    B: { setEchoTime: (s) => log.push(['echoB', s]) },
  };
  return {
    bus: (deck) => buses[deck],
    applyAll: (events, start) => {
      log.push(['applyAll', events.length, start]);
      return true;
    },
    dispose: () => log.push(['graph.dispose']),
  };
}

function fakePlayer(log, name, remainingSec = 60) {
  const player = {
    rate: 0,
    remainingSec,
    start: (o) => { player.rate = o.rate; log.push([`${name}.start`, o.positionSec, o.when, o.rate]); },
    setRate: (rate) => { player.rate = rate; log.push([`${name}.setRate`, rate]); },
    stop: () => log.push([`${name}.stop`]),
    dispose: () => log.push([`${name}.dispose`]),
  };
  return player;
}

const ADVANCED = {
  mode: 'advanced',
  plan: { beatMs: 500, rate: 1.02, template: 'standard' },
  events: [{ deck: 'A', kind: 'gainCurve', stem: 'bass', atMs: 0, durationMs: 1000, curve: [1, 0] }],
  totalMs: 2000,
  stems: ['bass'],
  summary: [],
};

function baseInput(over = {}) {
  const log = [];
  return {
    log,
    ctx: { currentTime: 10 },
    destination: {},
    resolved: ADVANCED,
    a: {
      element: fakeElement(0.8),
      baseVolume: 0.8,
      positionSec: 62.5,
      rate: 1,
      load: async () => fakePlayer(log, 'A'),
    },
    b: {
      element: fakeElement(0.6),
      baseVolume: 0.6,
      positionSec: 12.25,
      rate: 1.02,
      load: async () => fakePlayer(log, 'B'),
    },
    createGraph: () => fakeGraph(log),
    ...over,
  };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

test('标准模式：不接管、不建图、元素音量不动', async () => {
  const input = baseInput({ resolved: { mode: 'standard', plan: null, events: [], totalMs: 0, stems: [], summary: [] } });
  const session = await sessionMod.AdvancedSession.begin(input);
  assert.equal(session.active, false);
  assert.equal(input.a.element.volume, 0.8);
  assert.equal(input.log.length, 0);
});

test('进阶模式：元素静音 → 建图 → 两条 deck 同一时刻启动 → 一次性排曲线', async () => {
  const input = baseInput();
  const session = await sessionMod.AdvancedSession.begin(input);
  assert.equal(session.active, true);
  assert.equal(input.a.element.volume, 0);
  assert.equal(input.b.element.volume, 0);
  const startA = input.log.find((e) => e[0] === 'A.start');
  const startB = input.log.find((e) => e[0] === 'B.start');
  assert.ok(startA && startB);
  assert.equal(startA[2], startB[2], '两条 deck 必须同一个 when');
  assert.equal(startA[1], 62.5);
  assert.equal(startB[1], 12.25);
  assert.equal(startA[3], 1, 'A 保持自己的速率（不参与 tempo 匹配）');
  assert.equal(startB[3], 1.02, 'B 用元素当前速率（= 用户倍速 × tempoRate）');
  const apply = input.log.find((e) => e[0] === 'applyAll');
  assert.equal(apply[1], 1);
  assert.equal(session.eventCount, 1);
});

test('E26 减法引擎：元素保持可听（不静音），四轨只做被减项', async () => {
  const input = baseInput();
  input.subtractive = true;
  const session = await sessionMod.AdvancedSession.begin(input);
  assert.equal(session.active, true);
  // 减法引擎的关键：元素不能被静音，否则「mix − Σ」里根本没有 mix。
  assert.equal(input.a.element.volume, input.a.baseVolume, 'A 的元素音量不许被改');
  assert.equal(input.b.element.volume, input.b.baseVolume, 'B 的元素音量也不许被改');
  // 曲线照样一次性排进去（语义在 stemGraph 里翻成 g−1）。
  const apply = input.log.find((e) => e[0] === 'applyAll');
  assert.ok(apply, '事件没排进去');
  assert.equal(session.eventCount, 1);
});

test('回声时间跟拍：plan.beatMs=500 → 1/4 拍 = 0.125 s', async () => {
  const input = baseInput();
  const session = await sessionMod.AdvancedSession.begin(input);
  assert.equal(session.echoTimeSec, 0.125);
  const echoes = input.log.filter((e) => e[0].startsWith('echo'));
  assert.equal(echoes.length, 2);
  assert.equal(echoes[0][1], 0.125);
  assert.equal(echoes[1][1], 0.125);
});

test('加载失败：回退到 inactive，拆图、元素音量斜坡还原，不抛异常', async () => {
  const log = [];
  const input = baseInput({
    log,
    createGraph: () => fakeGraph(log),
    b: { element: fakeElement(0.6), baseVolume: 0.6, positionSec: 0, load: async () => { throw new Error('409 busy'); } },
  });
  const session = await sessionMod.AdvancedSession.begin(input);
  assert.equal(session.active, false);
  assert.ok(log.some((e) => e[0] === 'graph.dispose'));
  await flush();
  assert.equal(input.a.element.volume, 0.8, 'A 音量应还原到 baseVolume');
  assert.equal(input.b.element.volume, 0.6, 'B 音量应还原到 baseVolume');
});

test('cancel：停播 + 拆图 + 20 ms 斜坡还原到 baseVolume', async () => {
  const input = baseInput();
  const session = await sessionMod.AdvancedSession.begin(input);
  session.cancel();
  assert.equal(session.active, false);
  assert.ok(input.log.some((e) => e[0] === 'A.dispose'));
  assert.ok(input.log.some((e) => e[0] === 'B.dispose'));
  assert.ok(input.log.some((e) => e[0] === 'graph.dispose'));
  await flush();
  assert.equal(input.a.element.volume, 0.8);
  assert.equal(input.b.element.volume, 0.6);
});

test('cancel 幂等：重复调用不会二次拆图', async () => {
  const input = baseInput();
  const session = await sessionMod.AdvancedSession.begin(input);
  session.cancel();
  session.cancel();
  assert.equal(input.log.filter((e) => e[0] === 'graph.dispose').length, 1);
});

test('setRates：A / B 各自跟住自己的元素速率，非法值只影响该侧', async () => {
  const input = baseInput();
  const session = await sessionMod.AdvancedSession.begin(input);
  assert.equal(session.active, true);
  assert.equal(session.aRate > 0, true, '起播后 A 的速率应当是元素速率');

  session.setRates({ a: 1.5, b: 1.47 });
  assert.equal(session.aRate, 1.5);
  assert.equal(session.bRate, 1.47);
  const calls = input.log.filter((e) => e[0].endsWith('.setRate'));
  assert.deepEqual(calls.map((e) => [e[0], Math.round(e[1] * 1000) / 1000]), [['A.setRate', 1.5], ['B.setRate', 1.47]]);

  // 只给一侧：另一侧不动
  session.setRates({ b: 1.46 });
  assert.equal(session.aRate, 1.5, '没给 a 时 A 必须保持不变');
  assert.equal(session.bRate, 1.46);

  // 非法值：只忽略该侧
  session.setRates({ a: Number.NaN, b: Number.NaN });
  assert.equal(session.aRate, 1.5);
  assert.equal(session.bRate, 1.46);
  assert.equal(input.log.filter((e) => e[0].endsWith('.setRate')).length, 3, '非法值不得产生新调用');
});

test('PLL 速率只改 B：A 速率不动，B 按传入的绝对值微调', async () => {
  const input = baseInput();
  const session = await sessionMod.AdvancedSession.begin(input);
  assert.equal(session.active, true);
  const playerA = input.log.filter((e) => e[0].startsWith('A.'));
  assert.equal(session.bRate, 1.02, '起播后 B 的速率应当是 plan.rate');

  session.setRate(1.031);
  assert.equal(session.bRate, 1.031);
  const setRates = input.log.filter((e) => e[0].endsWith('.setRate'));
  assert.equal(setRates.length, 1, '只允许动一条 deck');
  assert.equal(setRates[0][0], 'B.setRate', '必须是 B');
  assert.equal(setRates[0][1], 1.031);

  // 非法值直接忽略：宁可不动，也不要把声音拉飞。
  session.setRate(Number.NaN);
  session.setRate(0);
  assert.equal(session.bRate, 1.031);
  assert.equal(input.log.filter((e) => e[0].endsWith('.setRate')).length, 1);

  // cancel 之后不许再动速率（播放器已经停了）。
  session.cancel();
  session.setRate(1.05);
  assert.equal(input.log.filter((e) => e[0].endsWith('.setRate')).length, 1);
  assert.equal(playerA.length > 0, true);
});

test('四轨起播失败（player.start 返回 false）：整场判失败、拆图还原，不半出声', async () => {
  const log = [];
  const input = baseInput({
    log,
    createGraph: () => fakeGraph(log),
    b: {
      element: fakeElement(0.6),
      baseVolume: 0.6,
      positionSec: 0,
      load: async () => ({ start: () => false, stop() {}, dispose() {} }),
    },
  });
  const session = await sessionMod.AdvancedSession.begin(input);
  assert.equal(session.active, false, '起播失败必须判 inactive，让调用方回退');
  assert.ok(log.some((e) => e[0] === 'graph.dispose'));
  await flush();
  assert.equal(input.a.element.volume, 0.8);
  assert.equal(input.b.element.volume, 0.6);
});

test('A/B 速率来自各自元素：用户倍速 1.5 × tempoRate 0.98 时 B 起播 1.47、A 起播 1.5', async () => {
  const log = [];
  const input = baseInput({
    a: {
      element: fakeElement(0.8),
      baseVolume: 0.8,
      positionSec: 10,
      rate: 1.5,
      load: async () => fakePlayer(log, 'A'),
    },
    b: {
      element: fakeElement(0.6),
      baseVolume: 0.6,
      positionSec: 5,
      rate: 1.47,
      load: async () => fakePlayer(log, 'B'),
    },
  });
  const session = await sessionMod.AdvancedSession.begin(input);
  assert.equal(session.active, true);
  assert.equal(log.find((e) => e[0] === 'A.start')[3], 1.5);
  assert.equal(log.find((e) => e[0] === 'B.start')[3], 1.47);
  // 之后的 PLL 微调是绝对值：直接落到分轨 B 上，不再乘一次 center
  session.setRate(1.48);
  const adjusts = log.filter((e) => e[0] === 'B.setRate');
  assert.equal(adjusts.length, 1);
  assert.equal(adjusts[0][1], 1.48);
});

test('remainingSec 取两侧最小值；实现没提供时为 null（不做兜底）', async () => {
  const log = [];
  const input = baseInput({
    a: { element: fakeElement(0.8), baseVolume: 0.8, positionSec: 10, rate: 1, load: async () => fakePlayer(log, 'A', 12) },
    b: { element: fakeElement(0.6), baseVolume: 0.6, positionSec: 5, rate: 1, load: async () => fakePlayer(log, 'B', 3.5) },
  });
  const session = await sessionMod.AdvancedSession.begin(input);
  assert.equal(session.remainingSec, 3.5, '应当取先放完的那条');

  const bare = baseInput({
    a: { element: fakeElement(0.8), baseVolume: 0.8, positionSec: 10, rate: 1, load: async () => ({ start: () => true, stop() {}, dispose() {} }) },
    b: { element: fakeElement(0.6), baseVolume: 0.6, positionSec: 5, rate: 1, load: async () => ({ start: () => true, stop() {}, dispose() {} }) },
  });
  const s2 = await sessionMod.AdvancedSession.begin(bare);
  assert.equal(s2.remainingSec, null, '实现不提供 remainingSec 时必须返回 null');
});

/** 带 monoSamples 的假播放器（用于相关度测量）。 */
function samplingPlayer(log, name, samples) {
  const player = fakePlayer(log, name);
  player.monoSamples = (stem) => (stem === 'bass' ? samples : null);
  return player;
}

test('replan：加载后按实测相关度重排，applyAll 收到新事件；相关度可读', async () => {
  const n = 8192;
  const wave = new Float32Array(n);
  for (let i = 0; i < n; i += 1) wave[i] = Math.sin((2 * Math.PI * 55 * i) / 48000);

  const replacement = [
    { deck: 'A', kind: 'gainCurve', stem: 'bass', atMs: 0, durationMs: 1000, curve: [1, 0] },
    { deck: 'B', kind: 'gainCurve', stem: 'bass', atMs: 0, durationMs: 1000, curve: [0, 1] },
  ];
  let measured = null;
  const input = baseInput({
    a: {
      element: fakeElement(0.8), baseVolume: 0.8, positionSec: 62.5, rate: 1,
      load: async () => samplingPlayer(input.log, 'A', wave),
    },
    b: {
      element: fakeElement(0.6), baseVolume: 0.6, positionSec: 12.25, rate: 1.02,
      load: async () => samplingPlayer(input.log, 'B', wave),
    },
    replan: (correlation) => {
      measured = correlation;
      return { events: replacement };
    },
  });
  const session = await sessionMod.AdvancedSession.begin(input);
  assert.equal(session.active, true);
  assert.ok(measured && typeof measured.bass === 'number');
  assert.ok(measured.bass > 0.9, `同源低频 ρ 应接近 1，实得 ${measured && measured.bass}`);
  const apply = input.log.find((e) => e[0] === 'applyAll');
  assert.equal(apply[1], 2, 'applyAll 应收到重排后的 2 条事件');
  assert.equal(session.eventCount, 2);
  assert.ok(session.correlation.bass > 0.9);
});

test('replan：返回 null 时沿用原事件，不影响起播', async () => {
  const input = baseInput({ replan: () => null });
  const session = await sessionMod.AdvancedSession.begin(input);
  assert.equal(session.active, true);
  const apply = input.log.find((e) => e[0] === 'applyAll');
  assert.equal(apply[1], 1);
  assert.equal(JSON.stringify(session.correlation), '{}', '没有 monoSamples 时相关度应为空对象');
});

test('replan：抛错时吞掉并沿用原事件（不能让一次测量失败毁掉整场过渡）', async () => {
  const input = baseInput({ replan: () => { throw new Error('boom'); } });
  const session = await sessionMod.AdvancedSession.begin(input);
  assert.equal(session.active, true);
  const apply = input.log.find((e) => e[0] === 'applyAll');
  assert.equal(apply[1], 1);
});
