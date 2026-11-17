// Run with: node --test web/tests/transitionPerformer.test.cjs
// Performer 层纯函数测试：曲线生成、事件排序、PLL 收敛。不碰 WebAudio。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function load(name, deps = {}) {
  const file = path.join(ROOT, 'src/core', name + '.ts');
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { exports, console, require: (id) => deps[id] ?? ({}) },
    { filename: file },
  );
  return exports;
}

const plan = load('transitionPlan');
const moves = load('djMoves');
const swap = load('stemSwap', { './transitionPlan': plan, './djMoves': moves });
const pll = load('beatPll');

function analysis(over = {}) {
  const bpm = over.bpm ?? 120;
  const bar = (60000 / bpm) * 4;
  return {
    bpm, bpmConfidence: 0.9, meter: 4, meterConfidence: 0.9,
    beatIntervalMs: 60000 / bpm, firstBeatMs: 0, firstDownbeatMs: 0,
    downbeats: Array.from({ length: 31 }, (_, i) => i * bar),
    beatsMs: [], phraseStartsMs: Array.from({ length: 8 }, (_, i) => i * bar * 8),
    barCount: 30, sections: [], warnings: [], camelot: '8A', energy: 0.6, cueInMs: 0,
    ...over,
  };
}

test('增益曲线：长度 steps+1，端点 0→1，单调不回退', () => {
  const curve = swap.buildSwapCurve({ curve: 'linear' }, 16);
  assert.equal(curve.length, 17);
  assert.equal(curve[0], 0);
  assert.equal(curve[curve.length - 1], 1);
  const check = swap.validateCurve(curve);
  assert.equal(check.ok, true, check.reason);
  for (let i = 0; i < 16; i++) assert.ok(curve[i] <= curve[i + 1]);
});

test('三种曲线都通过校验，且 shelfDip 中点最低', () => {
  const lin = swap.buildSwapCurve({ curve: 'linear' }, 8);
  const eq = swap.buildSwapCurve({ curve: 'equalPower' }, 8);
  const dip = swap.buildSwapCurve({ curve: 'shelfDip' }, 8);
  for (const c of [lin, eq, dip]) assert.equal(swap.validateCurve(c).ok, true);
  assert.ok(dip[4] < lin[4], '低频交接中点必须低于线性');
  assert.ok(dip[4] < eq[4], '低频交接中点必须低于等功率');
});

test('validateCurve 能抓出坏曲线', () => {
  assert.equal(swap.validateCurve([0.2, 1]).ok, false);
  assert.equal(swap.validateCurve([0, 0.5]).ok, false);
  assert.equal(swap.validateCurve([0, 0.8, 0.5, 1]).ok, false);
});

test('schedulePlan：每个换手动作产生双向曲线，人声额外 duck', () => {
  const p = plan.planTransition({ analysisA: analysis(), analysisB: analysis(), positionMsA: 40000 });
  const events = swap.schedulePlan(p);
  const gains = events.filter((e) => e.kind === 'gainCurve');
  // 4 个动作 × 2 个 deck
  assert.equal(gains.length, p.actions.length * 2);

  const vocalsIn = gains.find((e) => e.stem === 'vocals' && e.deck === 'B');
  const vocalsOut = gains.find((e) => e.stem === 'vocals' && e.deck === 'A');
  assert.ok(vocalsIn && vocalsOut);
  assert.ok(Math.abs(vocalsIn.curve[0]) < 1e-9);
  assert.ok(Math.abs(vocalsIn.curve.at(-1) - 1) < 1e-9);
  // 出场是 gainAt().a（等功率的补是 cos，不是 1-sin），端点允许浮点误差。
  assert.ok(Math.abs(vocalsOut.curve[0] - 1) < 1e-9, '出场 deck 起点应为全开');
  assert.ok(Math.abs(vocalsOut.curve.at(-1)) < 1e-9, '出场 deck 终点应归零');
  // 人声改成「顺序交接」：出场先落到 0，留空隙后进场才起——两把人声不同框。
  assert.ok(vocalsIn.atMs >= vocalsOut.atMs + vocalsOut.durationMs,
    `人声重叠: out=${vocalsOut.atMs}+${vocalsOut.durationMs} in=${vocalsIn.atMs}`);

  const ducks = events.filter((e) => e.kind === 'duck');
  assert.equal(ducks.length, 1);
  assert.equal(ducks[0].db, -3);
  assert.equal(ducks[0].attackMs, 5);
});

test('schedulePlan：事件按时间升序，且时间都锚在小节线', () => {
  const p = plan.planTransition({ analysisA: analysis(), analysisB: analysis(), positionMsA: 40000 });
  const events = swap.schedulePlan(p);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].atMs >= events[i - 1].atMs);
  // 人声的「进场起播」刻意错开在出场落地之后（非小节线），其余动作都锚小节线。
  for (const e of events) {
    if (e.kind === 'gainCurve' && e.stem === 'vocals' && e.deck === 'B') continue;
    assert.equal(e.atMs % p.barMs, 0, `${e.kind} 未对齐小节线`);
  }
});

test('schedulePlan：出场曲线严格递减（1→0）', () => {
  const p = plan.planTransition({ analysisA: analysis(), analysisB: analysis(), positionMsA: 40000 });
  const out = swap.schedulePlan(p).find((e) => e.kind === 'gainCurve' && e.deck === 'A' && e.stem === 'bass');
  for (let i = 1; i < out.curve.length; i++) assert.ok(out.curve[i] <= out.curve[i - 1] + 1e-9);
  assert.equal(out.curve.at(-1), 0);
});

test('回声甩尾：send 先升后降，B 被 duck，尾巴在小节线切断', () => {
  const events = swap.scheduleEchoThrow(24000, 2000, 1, 500);
  const sends = events.filter((e) => e.kind === 'delaySend');
  assert.equal(sends.length, 2);
  assert.equal(sends[0].to, 0.6);
  assert.equal(sends[1].from, 0.6);
  assert.equal(sends[1].to, 0);
  const duck = events.find((e) => e.kind === 'duck');
  assert.equal(duck.atMs, 26000, '干声切在下一小节线');
  assert.equal(duck.db, -3);
});

test('eventsEndMs：取所有事件的结束时间最大值', () => {
  const p = plan.planTransition({ analysisA: analysis(), analysisB: analysis(), positionMsA: 40000 });
  const events = swap.schedulePlan(p);
  const end = swap.eventsEndMs(events);
  assert.ok(end > 0);
  for (const e of events) assert.ok(e.atMs + e.durationMs <= end);
});

test('PLL：误差折算到 ±0.5 拍，且边界半开', () => {
  assert.equal(pll.wrapBeatError(0), 0);
  assert.equal(pll.wrapBeatError(0.4), 0.4);
  assert.equal(pll.wrapBeatError(0.6), -0.4);
  assert.equal(pll.wrapBeatError(-0.6), 0.4);
  assert.equal(pll.wrapBeatError(1.25), 0.25);
  assert.equal(pll.wrapBeatError(-0.5), 0.5);
});

test('PLL：晚到加速、早到减速，且单步不超过 maxStep', () => {
  const late = pll.nextRate({ rate: 1 }, 1000, 1050, 500);
  assert.ok(late.rate > 1, `late → rate=${late.rate}`);
  const early = pll.nextRate({ rate: 1 }, 1000, 950, 500);
  assert.ok(early.rate < 1, `early → rate=${early.rate}`);
  const far = pll.nextRate({ rate: 1 }, 0, 400, 500);
  assert.ok(Math.abs(far.rate - 1) <= 0.004 + 1e-9, '单步修正必须 ≤ maxStep');
});

test('PLL：连续收敛——误差单调变小', () => {
  let rate = 1, expected = 0, now = 6, beat = 500;
  const errors = [];
  for (let i = 0; i < 30; i++) {
    const next = pll.nextRate({ rate }, expected, now, beat);
    rate = next.rate;
    // 用当前速率推进真实时间：rate 快 → 追得更快
    now += beat / rate;
    expected += beat;
    errors.push(Math.abs(now - expected));
  }
  assert.ok(errors[errors.length - 1] < errors[0], `误差应收敛：${errors[0]} → ${errors.at(-1)}`);
});

test('PLL：速率被限制在 ±2%', () => {
  let rate = 1;
  for (let i = 0; i < 200; i++) rate = pll.nextRate({ rate }, 0, 500, 500).rate;
  assert.ok(rate <= 1.02 + 1e-9, `rate=${rate}`);
  assert.ok(rate >= 0.98 - 1e-9);
});

test('PLL：初始速率按拍族折叠', () => {
  assert.equal(pll.initialRate(128, 128), 1);
  assert.equal(pll.initialRate(64, 128), 1);
  assert.ok(Math.abs(pll.initialRate(128, 129) - 1.0078) < 0.002);
});

test('拍内偏移：返回 ±半拍内的修正量', () => {
  const off = pll.subBeatOffsetMs([0, 500, 1000], [12, 512, 1012], 500);
  assert.ok(Math.abs(off) <= 250);
  assert.ok(Math.abs(off - 12) < 1, `应贴到 12ms，实际 ${off}`);
  assert.equal(pll.subBeatOffsetMs([], [0], 500), 0);
});

test('PLL（trackRate）：B 超前就减速、落后就加速，围绕中心速率而不是 1', () => {
  const center = 1.05;
  const ahead = pll.trackRate({ rate: center }, 0.3, { center });
  assert.ok(ahead.rate < center, `超前应减速：${ahead.rate}`);
  const behind = pll.trackRate({ rate: center }, -0.3, { center });
  assert.ok(behind.rate > center, `落后应加速：${behind.rate}`);
  // 中心速率 1.05 不能被拉回 1.x 的 2% 带宽里
  assert.ok(behind.rate > 1.02, `不应该被拽回 1：${behind.rate}`);
});

test('PLL（trackRate）：单步不超过 maxStep，浮动不超过 center×(1±maxDeviation)', () => {
  let rate = 1.05;
  for (let i = 0; i < 500; i++) {
    const next = pll.trackRate({ rate }, 0.5, { center: 1.05, maxDeviation: 0.01, maxStep: 0.002 });
    assert.ok(Math.abs(next.rate - rate) <= 0.002 + 1e-9, `单步过大：${rate} → ${next.rate}`);
    rate = next.rate;
  }
  assert.ok(rate >= 1.05 * 0.99 - 1e-9 && rate <= 1.05 * 1.01 + 1e-9, `越界：${rate}`);
});

test('PLL（trackRate）：相位误差按拍回绕，±0.5 拍附近不抖', () => {
  const center = 1;
  const atHalf = pll.trackRate({ rate: center }, 0.5, { center });
  const atMinusHalf = pll.trackRate({ rate: center }, -0.5, { center });
  const atOneAndHalf = pll.trackRate({ rate: center }, 1.5, { center });
  assert.equal(atHalf.rate, atMinusHalf.rate, '±0.5 拍应当等价');
  assert.equal(atHalf.rate, atOneAndHalf.rate, '1.5 拍应当折回 ±0.5');
  assert.equal(pll.trackRate({ rate: center }, Number.NaN, { center }).rate, center);
});

test('PLL（trackRate）：相位误差单调收敛，不会越抖越大（双积分器回归）', () => {
  // 复用文件顶部已加载的 pll
  const beatMs = 500;
  let rate = 1;
  let err = 30 / beatMs; // B 起播超前 30 ms
  const trail = [];
  // 相位演化：err_{n+1} = err_n + (rate_n - 1)（一拍内、以拍为单位）
  for (let i = 0; i < 32; i++) {
    rate = pll.trackRate({ rate }, err, { center: 1 }).rate;
    err += rate - 1;
    trail.push(Math.abs(err) * beatMs);
  }
  // 1) 不得发散：后段峰值不超过初值。
  assert.ok(Math.max(...trail) <= 30.001, `振荡放大：${Math.max(...trail).toFixed(2)} ms`);
  // 2) 8 拍内进入 ±5 ms。
  const settled = trail.findIndex((v, i) => trail.slice(i).every((x) => x < 5));
  assert.ok(settled >= 0 && settled <= 8, `第 ${settled} 拍才收敛`);
  // 3) 稳态残差为 0（纯函数无噪声时应完全消除）。
  assert.ok(trail.at(-1) < 0.5, `残余 ${trail.at(-1).toFixed(3)} ms`);
  assert.ok(Math.abs(rate - 1) < 0.0005, `末态速率应回到中心附近，实际 ${rate}`);
});

test('回声甩尾：BPM/小节长度缺失时排程仍是有限值（不写 NaN 进 AudioParam）', () => {
  const swap2 = load('stemSwap', { './transitionPlan': plan, './djMoves': moves });
  const cases = [
    { name: 'NaN 全套', args: [Number.NaN, Number.NaN, Number.NaN, Number.NaN] },
    { name: 'BPM 为 0', args: [0, 0, 2, 0] },
    { name: '负值', args: [-500, -1000, -2, -500] },
    { name: '只有小节缺失', args: [480, Number.NaN, 2, 500] },
  ];
  for (const c of cases) {
    const events = swap2.scheduleEchoThrow(...c.args);
    assert.equal(events.length, 3, `${c.name}: 事件数`);
    for (const e of events) {
      assert.ok(Number.isFinite(e.atMs) && e.atMs >= 0, `${c.name}: atMs 必须是有限非负值，实际 ${e.atMs}`);
      assert.ok(Number.isFinite(e.durationMs) && e.durationMs >= 1, `${c.name}: durationMs ${e.durationMs}`);
    }
    assert.ok(Number.isFinite(swap2.eventsEndMs(events)), `${c.name}: eventsEndMs 必须是有限值`);
  }
});

test('echoDelaySec 在 BPM 越界时回落到 120（1/4 拍 = 0.125 s）', () => {
  const moves2 = load('djMoves', {});
  assert.equal(moves2.echoDelaySec(30), 0.125);
  assert.equal(moves2.echoDelaySec(300), 0.125);
  assert.equal(moves2.echoDelaySec(Number.NaN), 0.125);
  assert.equal(moves2.echoDelaySec(undefined), 0.125);
  assert.ok(Math.abs(moves2.echoDelaySec(128) - 60 / 128 * 0.25) < 1e-9);
});

test('schedulePlan 把滤波扫频排成一条 filter 事件（E22）', () => {
  const cold = { ...analysis(), energy: 0.2 };
  const p = plan.planTransition({ analysisA: analysis(), analysisB: cold, positionMsA: 30000 });
  assert.equal(p.template, 'filterBuild');
  const filters = swap.schedulePlan(p).filter((e) => e.kind === 'filter');
  assert.equal(filters.length, 2, 'filterBuild 应排「B 开门 + A 关门」两条');
  const open = filters.find((e) => e.deck === 'B');
  const close = filters.find((e) => e.deck === 'A');
  assert.ok(open && close, `缺一条：${JSON.stringify(filters)}`);
  assert.equal(open.band, 'highpass');
  assert.equal(open.fromHz, 320);
  assert.equal(open.toHz, 18000);
  assert.equal(open.durationMs, Math.max(1, p.filter.lengthBeats * p.beatMs));
  assert.equal(close.band, 'lowpass');
  assert.equal(close.fromHz, 20000);
  assert.equal(close.toHz, 700);
  assert.equal(close.durationMs, Math.max(1, p.filterOut.lengthBeats * p.beatMs));

  const plain = plan.planTransition({ analysisA: analysis(), analysisB: analysis(), positionMsA: 30000 });
  assert.equal(swap.schedulePlan(plain).filter((e) => e.kind === 'filter').length, 0);
});
