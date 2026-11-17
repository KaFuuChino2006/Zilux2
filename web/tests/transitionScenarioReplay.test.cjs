// Run with: node --test web/tests/transitionScenarioReplay.test.cjs
// 长跑场景重放：一次进阶过渡跨 4 个 30 s 窗口、中途多次变速，验证
//   * 任一时刻每个窗口只有一组（4 条）source 存活 —— 没有 G1「双声」
//   * 未起播窗口的起播时刻严格等于 (当前时刻 + (窗口边界 − 位置) / 新速率) —— 没有空档
//   * remainingSec 随真实时间单调下降，且能在 0.4 s 阈值处稳定跨界一次（兜底触发点）
//   * 长跑后 dispose 干净：全部 source 停止、无残留、再 dispose 不抛
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const WINDOW = 30;

function loadStemPlayer() {
  const file = path.join(ROOT, 'src/audio/stemPlayer.ts');
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      console,
      setTimeout,
      clearTimeout,
      require: () => ({ STEM_WINDOW_SEC: WINDOW, loadStemWindow: async () => ({ duration: WINDOW }) }),
    },
    { filename: file },
  );
  return exports;
}

function fakeCtx(startTime = 10) {
  const all = [];
  const ctx = {
    currentTime: startTime,
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    },
    createBufferSource() {
      const s = {
        buffer: null,
        playbackRate: { value: 1 },
        started: null,
        stopped: false,
        disconnected: false,
        connect() {},
        disconnect() { s.disconnected = true; },
        start(when, offset) { s.started = { when, offset }; all.push(s); },
        stop() { s.stopped = true; },
      };
      return s;
    },
  };
  const bus = { inputOf: () => ({ connect() {}, disconnect() {} }) };
  return { ctx, bus, all };
}

const track = { id: 'a', source: 'local', rel: 'a.mp3', title: 'a' };

function liveByWindow(sources) {
  const map = new Map();
  for (const s of sources) {
    if (s.stopped) continue;
    // 起播时刻落在哪个窗口边界上：整窗起播 offset 必为 0，据此归窗
    const key = s.started.offset === 0 ? 'pending' : 'playing';
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

test('四窗长跑 + 六次变速：每个待起播窗口恰好一组 source，且起播时刻严格按新速率', async () => {
  const player = loadStemPlayer();
  const { ctx, bus, all } = fakeCtx(10);
  const p = await player.StemPlayer.loadSpan(ctx, track, 0, 4 * WINDOW, bus);
  assert.equal(p.windowCount, 4, '120 s 跨度应装四个窗口');

  const position0 = 2;
  assert.equal(p.start({ positionSec: position0, when: 10.2, rate: 1 }), true);
  assert.equal(all.length, 16, '4 窗 × 4 轨 = 16 条 source');
  // 第二窗起播 = 10.2 + (30 − 2)/1
  const w1 = all.filter((s) => Math.abs(s.started.when - 38.2) < 1e-6);
  assert.equal(w1.length, 4);

  const schedule = [
    { at: 20, rate: 1.02 },
    { at: 35, rate: 0.98 },
    { at: 50, rate: 1.0 },
    { at: 70, rate: 1.03 },
    { at: 90, rate: 0.99 },
    { at: 110, rate: 1.01 },
  ];

  for (const step of schedule) {
    ctx.currentTime = step.at;
    const before = p.positionSec;
    p.setRate(step.rate);
    const after = p.positionSec;
    assert.ok(Math.abs(after - before) < 1e-6, `变速不能让播放头跳变（${before} → ${after}）`);

    const position = after;
    // 待起播窗口：边界 > 位置，每条 4 条，起播时刻 = now + (边界 − 位置)/rate
    for (let k = 1; k < 4; k += 1) {
      const boundary = k * WINDOW;
      if (boundary <= position + 1e-6) continue;
      const expected = step.at + (boundary - position) / step.rate;
      const group = all.filter((s) => !s.stopped && s.started.offset === 0 && Math.abs(s.started.when - expected) < 1e-6);
      assert.equal(group.length, 4, `窗口 ${k} 在 t=${step.at} 应有 4 条按新速率排的 source（期望起播 ${expected.toFixed(4)}）`);
      for (const s of group) assert.ok(Math.abs(s.playbackRate.value - step.rate) < 1e-9);
    }
    // 任何窗口都不允许出现两组（同一边界两条不同 start）→ 双声
    const pendingWhens = all
      .filter((s) => !s.stopped && s.started.offset === 0)
      .map((s) => Math.round(s.started.when * 1e6) / 1e6);
    const counts = new Map();
    for (const w of pendingWhens) counts.set(w, (counts.get(w) ?? 0) + 1);
    for (const [w, n] of counts) assert.equal(n, 4, `起播时刻 ${w} 上出现了 ${n} 条 source（应为 4 条 = 1 窗 4 轨）`);
  }
});

test('变速正好落在窗口边界：已过边界的窗不许重排，后一窗只排一次', async () => {
  const player = loadStemPlayer();
  const { ctx, bus, all } = fakeCtx(10);
  const p = await player.StemPlayer.loadSpan(ctx, track, 0, 3 * WINDOW, bus);
  p.start({ positionSec: 0, when: 10, rate: 1 });
  assert.equal(all.length, 12);

  ctx.currentTime = 40; // 位置正好 30.0
  assert.ok(Math.abs(p.positionSec - 30) < 1e-6);
  p.setRate(1.05);

  const live = all.filter((s) => !s.stopped);
  assert.equal(live.length, 12, '变速不能让任何一条 source 消失');
  // 窗口 1（边界 30）已经起播：start 仍是 10、速率改成 1.05
  const w0 = live.filter((s) => Math.abs(s.started.when - 10) < 1e-6);
  assert.equal(w0.length, 4);
  for (const s of w0) assert.ok(Math.abs(s.playbackRate.value - 1.05) < 1e-9);
  // 窗口 2（边界 60）重排到 40 + 30/1.05
  const expected = 40 + 30 / 1.05;
  const w1 = live.filter((s) => Math.abs(s.started.when - expected) < 1e-6);
  assert.equal(w1.length, 4, `窗口 2 应重排到 ${expected.toFixed(4)}`);
});

test('remainingSec 在长跑中单调下降，并在 0.4 s 阈值处稳定跨界（兜底触发点）', async () => {
  const player = loadStemPlayer();
  const { ctx, bus } = fakeCtx(10);
  const p = await player.StemPlayer.loadSpan(ctx, track, 0, 2 * WINDOW, bus);
  p.start({ positionSec: 50, when: 10, rate: 1 });
  assert.ok(Math.abs(p.remainingSec - 10) < 1e-6);

  const samples = [];
  for (const t of [12, 14, 16, 18]) {
    ctx.currentTime = t;
    samples.push(p.remainingSec);
  }
  // 起播位置 50、两窗到 60 ⇒ 剩 10 s；每过 2 真实秒少 2 s
  assert.deepEqual(samples.map((v) => Math.round(v)), [8, 6, 4, 2], `剩余应单调下降：${samples}`);
  ctx.currentTime = 20; // 位置到 60（窗口末端）
  assert.equal(p.remainingSec, 0, '放完以后剩余必须是 0（不是负数）');

  // 阈值跨越：从剩 0.5 s 走到剩 0.2 s，只跨一次
  const q = await player.StemPlayer.loadSpan(ctx, track, 0, 2 * WINDOW, bus);
  ctx.currentTime = 60;
  q.start({ positionSec: 59.5, when: 60, rate: 1 });
  assert.ok(q.remainingSec > 0.4, '剩 0.5 s 时不应触发兜底');
  ctx.currentTime = 60.3;
  assert.ok(q.remainingSec < 0.4 && q.remainingSec > 0, '剩 0.2 s 时应触发兜底');
  ctx.currentTime = 60.45;
  assert.ok(q.remainingSec < 0.4, '之后持续低于阈值（不会反复跨界）');
});

test('长跑后 dispose：全部 source 停止且断开，重复 dispose 安全', async () => {
  const player = loadStemPlayer();
  const { ctx, bus, all } = fakeCtx(10);
  const p = await player.StemPlayer.loadSpan(ctx, track, 0, 4 * WINDOW, bus);
  p.start({ positionSec: 3, when: 10.2, rate: 1 });
  for (const t of [30, 60, 90, 120]) {
    ctx.currentTime = t;
    p.setRate(1.01);
    assert.ok(p.remainingSec >= 0);
  }
  p.dispose();
  assert.equal(all.every((s) => s.stopped), true, 'dispose 后不能有仍在播的 source');
  assert.equal(all.every((s) => s.disconnected), true, 'dispose 后不能有仍连着图的 source');
  assert.equal(p.isPlaying, false);
  assert.equal(p.remainingSec, 0);
  assert.doesNotThrow(() => p.dispose());
  assert.equal(p.start({ positionSec: 0 }), false, 'dispose 之后不能再起播');
});
