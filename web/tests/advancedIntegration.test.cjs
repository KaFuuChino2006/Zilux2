// Run with: node --test web/tests/advancedIntegration.test.cjs
//
// 四层接线集成测试：installAdvancedHandoff（真） → advancedSession（真） →
// stemPlayer（假） → stemGraph（假）。crossfadeDeck 的工厂在单测里一直是替身，
// 所以「安装器 ↔ 会话 ↔ 播放器/图」这层契约此前没人真跑过——
// 第 2 轮那次「整条进阶路径是死代码」正是这类缺口。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SRC = path.resolve(__dirname, '../src');

function loadTs(rel, deps) {
  const file = path.resolve(SRC, rel + '.ts');
  const src = fs.readFileSync(file, 'utf8');
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    {
      exports,
      console: { warn() {}, log() {}, error() {} },
      require: (name) => (name in deps ? deps[name] : {}),
      Math, Number, Array, Object, JSON, Promise, Error, TypeError, isFinite, Float32Array, Symbol,
    },
    { filename: file },
  );
  return exports;
}

function analysis(bpm) {
  return {
    bpm, bpmConfidence: 0.9, meter: 4, meterConfidence: 0.9,
    firstBeatMs: 0, firstDownbeatMs: 0, beatIntervalMs: 60000 / bpm,
    downbeats: Array.from({ length: 97 }, (_, i) => i * (60000 / bpm) * 4),
    phrases: [], key: '8A', camelot: '8A', energy: 0.7, loudnessLufs: -9, peakDb: -0.3,
    sections: [{ label: 'outro', startMs: 0, endMs: 600000 }],
  };
}

const REQUEST = {
  mode: 'advanced', kind: 'auto', fadeMs: 16000, tempoRate: 1,
  analysisA: analysis(120), analysisB: analysis(126),
  trackA: { source: 'local', id: 'a' }, trackB: { source: 'local', id: 'b' },
  positionMsA: 40000, positionMsB: 0,
  elementA: { volume: 1 }, elementB: { volume: 1 },
};

/** 组装一次真实链路；只有播放器/图/上下文是假件。 */
function setup({ spanReady = () => true } = {}) {
  const log = [];
  const players = [];
  const graphs = [];
  const ctx = { currentTime: 10, sampleRate: 48000, state: 'running', destination: {} };

  const djMoves = loadTs('core/djMoves', {});
  const transitionPlan = loadTs('core/transitionPlan', {});
  const tempoGate = loadTs('core/tempoGate', {});
  const stemSwap = loadTs('core/stemSwap', {
    './djMoves': djMoves, '../core/djMoves': djMoves,
    './transitionPlan': transitionPlan, '../core/transitionPlan': transitionPlan,
  });
  const advancedTransition = loadTs('core/advancedTransition', {
    '../core/transitionPlan': transitionPlan, './transitionPlan': transitionPlan,
    '../core/tempoGate': tempoGate, './tempoGate': tempoGate,
    '../core/stemSwap': stemSwap, './stemSwap': stemSwap,
  });
  const advancedHandoff = loadTs('core/advancedHandoff', {});
  const mixTransitionMode = loadTs('core/mixTransitionMode', {});
  const advancedSession = loadTs('audio/advancedSession', {
    '../core/djMoves': djMoves,
    '../core/correlation': loadTs('core/correlation', {}),
    './stemGraph': {},
  });

  function makePlayer(startSec) {
    const p = {
      startSec, rate: 1, started: 0, stopped: 0, disposed: 0, setRates: [],
      positionSec: startSec, remainingSec: 60,
      start({ when = 0, rate = 1 } = {}) { this.started += 1; this.when = when; this.rate = rate; return true; },
      setRate(r) { this.setRates.push(r); this.rate = r; },
      stop() { this.stopped += 1; },
      dispose() { this.disposed += 1; },
      monoSamples() { return new Float32Array(64).fill(0.5); },
    };
    players.push(p);
    return p;
  }

  const graph = {
    calls: { echo: [], applied: [] },
    bus(deck) { return { setEchoTime: (t) => graph.calls.echo.push([deck, t]) }; },
    applyAll(events, at) { graph.calls.applied.push([events, at]); return true; },
    dispose() { graph.calls.disposed = (graph.calls.disposed ?? 0) + 1; },
  };
  graphs.push(graph);

  const install = loadTs('audio/installAdvancedHandoff', {
    '../core/advancedHandoff': advancedHandoff,
    '../core/advancedTransition': advancedTransition,
    '../core/mixTransitionMode': mixTransitionMode,
    './stemPlayer': { FOUR_STEMS: ['drums', 'bass', 'other', 'vocals'], MAX_SPAN_WINDOWS: 4 },
    './advancedReadiness': { stemSpanKeys: () => ['k'], isStemReady: () => true, isStemSpanReady: spanReady },
    '../core/audioTap': { appMusicOutputNode: () => ({}), ensureAppAudioGraph: () => ctx },
    './stemGraph': {},
    './advancedSession': advancedSession,
  });

  const uninstall = install.installAdvancedHandoff({
    isSpanReady: spanReady,
    ensureContext: () => ctx,
    destination: () => ({}),
    createGraph: () => graph,
    loadPlayer: (_ctx, _track, startSec) => Promise.resolve(makePlayer(startSec)),
    log: (m) => log.push(m),
  });

  return { advancedHandoff, uninstall, log, players, graph, ctx };
}

test('进阶交接全链路：安装器 → 会话 → 播放器/图（真模块，只有 IO 是假的）', async () => {
  const h = setup();
  const handoff = h.advancedHandoff.requestHandoff(REQUEST);
  assert.ok(handoff, '预热就绪时应产出交接对象');

  handoff.start(12);
  // whenReady 要等 begin() 走完（加载 → 起播 → applyAll），所以先等它再断言。
  const ready = await handoff.whenReady();

  assert.equal(h.log.filter((m) => m.includes('四轨窗口未预热')).length, 0);
  // 每条 deck 一个 StemPlayer（内部装四轨），所以是 2 个播放器、各自起播一次。
  assert.equal(h.players.length, 2, `两条 deck 各一个播放器，实际 ${h.players.length}`);
  assert.ok(h.players.every((p) => p.started === 1), '每个播放器只起播一次');
  assert.ok(h.players.every((p) => p.when === 12), '两条 deck 共用同一个 when（轨间对齐）');

  const applied = h.graph.calls.applied[0];
  assert.ok(applied && applied[0].length > 0, 'applyAll 必须收到非空事件表');
  assert.equal(applied[1], 12);
  assert.ok(h.graph.calls.echo.length >= 2, '两条 deck 都要设回声时间');
  assert.equal(ready, true);

  handoff.setRates({ a: 1.02, b: 1.05 });
  assert.deepEqual(h.players.map((p) => p.setRates), [[1.02], [1.05]], 'A 跟 A 的速率、B 跟 B 的');
  assert.ok(Math.abs(handoff.remainingSec() - 60) < 1e-9);

  handoff.cancel();
  handoff.cancel();
  assert.ok(h.players.every((p) => p.disposed === 1), 'cancel 幂等：播放器只拆一次');
  assert.equal(h.graph.calls.disposed, 1);
  h.uninstall();
});

test('进阶·稳妥档：置信度只到 bassDrumsOnly 时回落标准，进阶档照常换手', () => {
  const lowConfidence = { ...analysis(120), bpmConfidence: 0.5 };
  const base = { ...REQUEST, analysisA: lowConfidence };

  const strict = setup();
  assert.equal(
    strict.advancedHandoff.requestHandoff({ ...base, mode: 'advancedSafe' }),
    null,
    '稳妥档不允许降级换手',
  );
  assert.ok(strict.log.some((m) => m.includes('稳妥档')), '必须说明为什么回落');
  strict.uninstall();

  const loose = setup();
  assert.ok(
    loose.advancedHandoff.requestHandoff({ ...base, mode: 'advanced' }),
    '进阶档在 bassDrumsOnly 下应继续换手',
  );
  loose.uninstall();
});

test('预热未就绪 ⇒ requestHandoff 返回 null（标准路径不受影响）', () => {
  const h = setup({ spanReady: () => false });
  assert.equal(h.advancedHandoff.requestHandoff(REQUEST), null);
  assert.ok(h.log.some((m) => m.includes('未预热')), '必须留下可诊断日志');
  h.uninstall();
});
