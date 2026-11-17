// Run with: node --test web/tests/stemPlayerAudio.test.cjs
// 4 轨播放器的音频节点行为（用假 AudioContext，不需要真音频）：起播对齐、少轨失败、
// 窗口越界、ctx 关闭后的幂等 dispose。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function loadStemPlayer(stemsClient) {
  const file = path.join(ROOT, 'src/audio/stemPlayer.ts');
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports, console, setTimeout, clearTimeout,
      require: (id) => (id === '../core/stemsClient' ? stemsClient : {}),
    },
    { filename: file },
  );
  return exports;
}

function fakeCtx() {
  const sources = [];
  const ctx = {
    currentTime: 10,
    closed: false,
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    },
    createBufferSource() {
      const s = {
        buffer: null, playbackRate: { value: 1 }, stopped: false, started: null,
        connect() {}, disconnect() {},
        start(when, offset) { s.started = { when, offset }; sources.push(s); },
        stop() { s.stopped = true; },
      };
      return s;
    },
  };
  const bus = { inputOf: () => ({ connect() {}, disconnect() {} }) };
  return { ctx, bus, sources };
}

const track = { id: 'a', source: 'local', rel: 'a.mp3', title: 'a' };

function clientOk(duration = 30) {
  return {
    STEM_WINDOW_SEC: 30,
    loadStemWindow: async () => ({ duration }),
  };
}

test('四轨用同一个 when 与同一偏移起播（轨间对齐 0）', async () => {
  const player = loadStemPlayer(clientOk());
  const { ctx, bus, sources } = fakeCtx();
  const p = await player.StemPlayer.load(ctx, track, 0, bus);
  assert.equal(p.stemOrder.length, 4);
  assert.equal(p.start({ positionSec: 12, when: 20, rate: 1 }), true);
  assert.equal(sources.length, 4);
  const whens = new Set(sources.map(s => s.started.when));
  const offsets = new Set(sources.map(s => s.started.offset));
  assert.equal(whens.size, 1, '四条 source 必须共用同一个 when');
  assert.equal([...whens][0], 20);
  assert.equal(offsets.size, 1, '四条 source 必须共用同一个偏移');
  assert.equal([...offsets][0], 12);
});

test('少一轨就整体失败：不留半出声的播放器', async () => {
  const { ctx, bus, sources } = fakeCtx();
  // vocals 返回 0 时长 ⇒ 该轨没有可播内容
  const real = loadStemPlayer(loaderWithDropout('vocals'));
  const p2 = await real.StemPlayer.load(ctx, track, 0, bus);
  assert.equal(p2.start({ positionSec: 1 }), false, '缺轨时必须返回 false');
  assert.equal(p2.isPlaying, false);
  assert.equal(sources.filter(s => !s.stopped).length, 0, '失败后不能留下仍在播的 source');
});

function loaderWithDropout(badStem) {
  return {
    STEM_WINDOW_SEC: 30,
    loadStemWindow: async (_ctx, _track, _window, stem) => ({ duration: stem === badStem ? 0 : 30 }),
  };
}

test('位置超出窗口内容时返回 false（而不是静默 playing=true）', async () => {
  const player = loadStemPlayer(clientOk(8));
  const { ctx, bus, sources } = fakeCtx();
  const p = await player.StemPlayer.load(ctx, track, 0, bus);
  assert.equal(p.start({ positionSec: 20 }), false, '偏移 20s 超过 8s 内容应判失败');
  assert.equal(sources.length, 0);
});

test('load 失败时点名是哪一轨，并带上窗口号', async () => {
  const stemsClient = {
    STEM_WINDOW_SEC: 30,
    loadStemWindow: async (_ctx, _track, _window, stem) => {
      if (stem === 'other') throw new Error('409 busy');
      return { duration: 30 };
    },
  };
  const player = loadStemPlayer(stemsClient);
  const { ctx, bus } = fakeCtx();
  await assert.rejects(
    () => player.StemPlayer.load(ctx, track, 3, bus),
    (err) => {
      assert.equal(err.name, 'StemUnavailableError');
      assert.match(err.message, /失败：other/);
      assert.match(err.message, /窗口 3/);
      assert.match(String(err.cause?.message ?? ''), /409 busy/);
      return true;
    },
  );
});

test('ctx 关闭（读 currentTime 抛错）后 dispose 仍幂等', async () => {
  const player = loadStemPlayer(clientOk());
  const { ctx, bus, sources } = fakeCtx();
  const p = await player.StemPlayer.load(ctx, track, 0, bus);
  assert.equal(p.start({ positionSec: 0, when: 11 }), true);
  // 模拟输出设备被拔掉：时钟读取抛错
  Object.defineProperty(ctx, 'currentTime', { get() { throw new Error('closed'); } });
  assert.doesNotThrow(() => p.dispose());
  assert.doesNotThrow(() => p.dispose(), 'dispose 必须幂等');
  assert.equal(p.isPlaying, false);
  assert.ok(sources.every(s => s.stopped), '所有 source 都应被 stop');
  // 关闭后再 start 直接 false，不会再造 source
  assert.equal(p.start({ positionSec: 0 }), false);
});

test('setRate 只改现有 source 的 playbackRate，并保住当前位置', async () => {
  const player = loadStemPlayer(clientOk());
  const { ctx, bus, sources } = fakeCtx();
  const p = await player.StemPlayer.load(ctx, track, 0, bus);
  p.start({ positionSec: 4, when: 10, rate: 1 });
  const before = p.positionSec;
  ctx.currentTime = 14; // 播了 4 秒
  p.setRate(1.02);
  assert.equal(sources.every(s => s.playbackRate.value === 1.02), true);
  // 换速率不改变当前位置
  assert.ok(Math.abs(p.positionSec - 8) < 0.001, `位置应保持 8s，实际 ${p.positionSec}`);
  assert.ok(before < 8);
});

test('跨窗续播：loadSpan(0,60) 两个窗口各四条 source，第二窗从窗口边界起播', async () => {
  const player = loadStemPlayer(clientOk(30));
  const { ctx, bus, sources } = fakeCtx();
  const p = await player.StemPlayer.loadSpan(ctx, track, 0, 60, bus);
  assert.equal(p.windowCount, 2, '60 s 跨度必须装两个窗口');
  assert.equal(p.start({ positionSec: 5, when: 100, rate: 1 }), true);
  assert.equal(sources.length, 8, '2 窗 × 4 轨 = 8 条 source');
  const whens = sources.map((s) => s.started.when).sort((a, b) => a - b);
  // 第一窗 4 条在 100（偏移 5），第二窗 4 条在 100+25（窗口边界 30 - 5）
  assert.equal(whens.filter((w) => Math.abs(w - 100) < 1e-6).length, 4);
  assert.equal(whens.filter((w) => Math.abs(w - 125) < 1e-6).length, 4, `第二窗起播时刻不对：${whens}`);
  const offsets = new Set(sources.map((s) => s.started.offset));
  assert.deepEqual([...offsets].sort((a, b) => a - b), [0, 5], '第二窗偏移必须是 0');
});

test('跨窗上限：超过 MAX_SPAN_WINDOWS 直接拒绝（不半装）', async () => {
  const player = loadStemPlayer(clientOk(30));
  const { ctx, bus } = fakeCtx();
  await assert.rejects(
    () => player.StemPlayer.loadSpan(ctx, track, 0, 30 * (player.MAX_SPAN_WINDOWS + 1), bus),
    /超过上限/,
  );
});

test('spanWindowsSec 纯函数：起点/终点落在边界上不越界', () => {
  const player = loadStemPlayer(clientOk(30));
  assert.deepEqual([...player.spanWindowsSec(0, 30)], [0], '整窗刚好 30 s 只装一个窗');
  assert.deepEqual([...player.spanWindowsSec(0, 30.001)], [0, 1], '多 1 ms 就要装第二窗');
  assert.deepEqual([...player.spanWindowsSec(29, 2)], [0, 1]);
  assert.deepEqual([...player.spanWindowsSec(30, 1)], [1], '正好在边界上从第二窗开始');
});

test('变速重排：未起播的窗口按新速率重新定时，正在播的窗口只调速率（防双声/空档）', async () => {
  const player = loadStemPlayer(clientOk(30));
  const { ctx, bus, sources } = fakeCtx();
  const p = await player.StemPlayer.loadSpan(ctx, track, 0, 60, bus);
  assert.equal(p.start({ positionSec: 5, when: 100, rate: 1 }), true);
  assert.equal(sources.length, 8);
  const firstWindowSources = sources.filter((s) => Math.abs(s.started.when - 100) < 1e-6);
  assert.equal(firstWindowSources.length, 4);

  ctx.currentTime = 110; // 已播 10 s ⇒ 位置 15 s，第二窗（边界 30 s）还没起播
  p.setRate(1.02);

  // 第二窗必须重排到 110 + (30-15)/1.02 = 124.7059
  const secondWindow = sources.filter((s) => !firstWindowSources.includes(s) && !s.stopped);
  assert.equal(secondWindow.length, 4, '第二窗四条轨都要重排');
  for (const s of secondWindow) {
    assert.ok(Math.abs(s.started.when - 124.7059) < 1e-3, `第二窗起播时刻应为 124.7059，实际 ${s.started.when}`);
    assert.equal(s.started.offset, 0, '整窗起播偏移必须是 0');
    assert.ok(Math.abs(s.playbackRate.value - 1.02) < 1e-9);
  }
  // 旧排程必须被撤掉（不留一条仍在 125 s 起播的 source）
  const stale = sources.filter((s) => firstWindowSources.includes(s) === false && s.stopped === false && Math.abs(s.started.when - 125) < 1e-6);
  assert.equal(stale.length, 0, '不能留下按旧速率排程的 source');

  // 第一窗仍在播：start 时刻不动，速率跟着改
  for (const s of firstWindowSources) {
    assert.equal(s.stopped, false);
    assert.equal(s.started.when, 100);
    assert.ok(Math.abs(s.playbackRate.value - 1.02) < 1e-9);
  }
  // 位置换算跟着新速率走：再过 10 s ⇒ 15 + 10*1.02 = 25.2
  ctx.currentTime = 120;
  assert.ok(Math.abs(p.positionSec - 25.2) < 1e-6, `位置应为 25.2，实际 ${p.positionSec}`);
});

test('变速重排：速率非法值（NaN/0）不破坏已在播的排程', async () => {
  const player = loadStemPlayer(clientOk(30));
  const { ctx, bus, sources } = fakeCtx();
  const p = await player.StemPlayer.loadSpan(ctx, track, 0, 60, bus);
  p.start({ positionSec: 0, when: 10, rate: 1 });
  const before = sources.map((s) => s.started.when);
  ctx.currentTime = 12;
  p.setRate(NaN);
  p.setRate(0);
  const alive = sources.filter((s) => !s.stopped);
  assert.equal(alive.length, 8, '非法速率不能让任何一条 source 消失');
  assert.deepEqual(sources.map((s) => s.started.when), before, '非法速率不重排');
});

test('remainingSec：按已装载窗口末端算剩余真实秒，变速后按真实时间折算', async () => {
  const player = loadStemPlayer(clientOk(30));
  const { ctx, bus } = fakeCtx();
  const p = await player.StemPlayer.loadSpan(ctx, track, 0, 60, bus);
  assert.equal(p.remainingSec, 0, '没起播时没有剩余');

  p.start({ positionSec: 50, when: 10, rate: 1 });
  // 装了两窗（0~60 s），从 50 s 起播 ⇒ 还剩 10 s 音频
  assert.ok(Math.abs(p.remainingSec - 10) < 1e-6, `应为 10 s，实际 ${p.remainingSec}`);

  // 变速 2× 之后，同样的音频只够 5 真实秒
  p.setRate(2);
  assert.ok(Math.abs(p.remainingSec - 5) < 0.05, `2× 时应约 5 s，实际 ${p.remainingSec}`);
});
