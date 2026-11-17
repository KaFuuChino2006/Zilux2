// Run with: node --test web/tests/crossfade.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function harness({ graph = true } = {}) {
  let clock = 10, now = 1000;
  const store = new Map(), timers = new Map(), calls = [], modules = new Map();
  // T6-5：进阶预热是可选的（门控判成 standard 时不该发生），用间谍记录调用次数。
  const readiness = { prefetchCalls: [], stemKeyOf: () => 'stub', isStemReady: () => false,
    prefetchStemsForTransition: (a, b) => { readiness.prefetchCalls.push([a, b]);
      return Promise.resolve({ keyA: 'a', keyB: 'b', aReady: true, bReady: true, computed: 2 }); } };
  const audio = new Proxy({
    audioTapClock: () => clock,
    audioTapGraphActive: () => graph,
    attachDeckToGraph: () => true,
  }, { get: (target, key) => target[key] ?? ((...args) => calls.push([key, ...args])) });
  const window = { addEventListener() {}, dispatchEvent() {},
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); } };
  function load(name) {
    // core/ 下的纯函数模块与 ui/ 分目录：按名找，让 crossfadeDeck 的新依赖也能加载。
    const uiFile = path.resolve(__dirname, '../src/ui', name + '.ts');
    const coreFile = path.resolve(__dirname, '../src/core', name + '.ts');
    const file = fs.existsSync(uiFile) ? uiFile : coreFile;
    if (modules.has(file)) return modules.get(file);
    let source = fs.readFileSync(file, 'utf8');
    if (name === 'crossfadeDeck') source += '\nexport { buildSchedule, buildAmTracks, resolveTransitionStyle, readCrossfadeDebug };';
    const exports = {};
    modules.set(file, exports);
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, {
      exports, console, window, performance: { now: () => now },
      localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
      CustomEvent: class {},
      require: name => name.includes('advancedReadiness') ? readiness
        : name.includes('audioTap') ? audio
        : ['./transitionMath', './transitionLoudness', './loudness', './advancedHandoff', './mixTransitionMode',
           './transitionTimeline', '../core/advancedHandoff', '../core/mixTransitionMode',
           '../core/advancedTransition', '../core/transitionPlan', '../core/tempoGate', '../core/djMoves',
           '../core/stemSwap', './tempoGate', './transitionPlan', './djMoves', './stemSwap',
           '../core/beatPll', './beatPll'].includes(name)
          ? load(name.slice(name.lastIndexOf('/') + 1)) : {},
    }, { filename: file });
    return exports;
  }
  class Deck extends EventTarget {
    currentTime = 0; readyState = 4; playbackRate = 1; volume = 1; paused = false;
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
  }
  const engine = load('crossfadeDeck');
  function analysis(bpm = 120) {
    return { bpm, bpmConfidence: .9, meter: 4, meterConfidence: .9,
      firstBeatMs: 0, firstDownbeatMs: 0, beatIntervalMs: 60000 / bpm,
      downbeats: Array.from({ length: 31 }, (_, i) => i * 2000),
      beatsMs: Array.from({ length: 121 }, (_, i) => i * 500),
      sections: [], cueOutMs: 48000, audibleEndMs: 60000, camelot: '8A', warnings: [] };
  }
  function options() {
    const active = new Deck(), standby = new Deck();
    return { active, standby, current: { startAt: 0, track: { source: 'local', id: 'a', durationMs: 60000 } },
      next: { startAt: 0, track: { source: 'local', id: 'b', durationMs: 60000 } },
      currentPositionMs: 1000, currentDurationMs: 60000,
      currentAnalysis: { analysis: analysis(), durationMs: 60000 },
      nextAnalysis: { analysis: analysis(), durationMs: 60000 },
      nextVocalStartMs: 8000, currentLastVocalEndMs: 50000,
      nextUrl: 'test.mp3', baseVolume: () => .7, baseRate: () => 1,
      isValid: () => true, onFinish() {} };
  }
  return { engine, load, calls, timers, analysis, options, store, readiness,
    advance(seconds) { clock += seconds; now += seconds * 1000; },
    poll() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); } };
}

test('gain power stays constant, endpoints are exact, and A is silent before tempo recovery', () => {
  const { naturalGains, MATCHED_OVERLAP_END } = harness().load('transitionMath');
  for (const end of [1, MATCHED_OVERLAP_END]) {
    for (let i = 0; i <= 1000; i++) {
      const [a, b] = naturalGains(i / 1000, end);
      assert.ok(Math.abs(a * a + b * b - 1) < 1e-12);
      if (i / 1000 >= end) assert.equal(a, 0);
    }
  }
});

test('AutoMix tempo score is symmetric and handles half/double tempo', () => {
  const { bpmPenalty } = harness().load('automix');
  assert.ok(Math.abs(bpmPenalty(120, 118) - bpmPenalty(118, 120)) < 1e-10);
  assert.ok(bpmPenalty(120, 118) < .1);
  assert.equal(bpmPenalty(85, 170), 0);
});

test('bass off stays neutral; enabled exchange ramps over at least 100ms', () => {
  const { buildAmTracks } = harness().engine;
  const off = buildAmTracks(8000, 0);
  for (const bands of [off.aBands, off.bBands]) {
    assert.ok(bands.filter(p => p.bassDb !== undefined).every(p => p.bassDb === 0));
  }
  const on = buildAmTracks(8000, .5);
  for (const bands of [on.aBands, on.bBands]) {
    const points = bands.filter(p => p.bassDb !== undefined);
    assert.ok(points.at(-1).atMs - points.at(-2).atMs >= 100);
  }
  assert.equal(on.aGain.at(-1).gain, 0);
});

test('lyric pre-roll finishes before first word, including accelerated B', () => {
  const h = harness(), opts = h.options();
  opts.nextAnalysis.analysis = h.analysis(114);
  const s = h.engine.buildSchedule(opts);
  assert.equal(s.handoff, true);
  assert.ok(s.bStartFileMs < opts.nextVocalStartMs);
  assert.ok(s.bStartFileMs + s.fadeMs * s.tempoRate <= opts.nextVocalStartMs);
  assert.ok(s.fadeStartPosMs >= opts.currentLastVocalEndMs);
});

test('missing lyric timing falls back to structure; poor tempo evidence preserves an audible blend', () => {
  const h = harness(), opts = h.options();
  opts.currentLastVocalEndMs = null;
  opts.currentAnalysis.analysis.bpmConfidence = .2;
  const s = h.engine.buildSchedule(opts);
  assert.equal(s.structure, true);
  assert.equal(s.handoff, false);
  assert.equal(s.style, 'equal');
  assert.equal(s.tempoRate, 1);
  assert.ok(s.fadeMs >= 3200);
});

test('a two-minute song never ends at an early cue-out or an incomplete lyric timestamp', () => {
  const h = harness(), opts = h.options();
  opts.current.track.durationMs = opts.currentDurationMs = opts.currentAnalysis.durationMs = 120000;
  opts.currentAnalysis.analysis.audibleEndMs = 120000;
  opts.currentAnalysis.analysis.cueOutMs = 60000;
  opts.currentLastVocalEndMs = 60000;
  opts.nextVocalStartMs = 3500;
  const s = h.engine.buildSchedule(opts);
  assert.ok(s.fadeStartPosMs >= 100000, `started at ${s.fadeStartPosMs}ms`);
  assert.ok(Math.abs(s.fadeStartPosMs + s.fadeMs - 120000) < 10);
  assert.ok(s.fadeMs >= 6000, `collapsed to ${s.fadeMs}ms`);
});

test('suspicious audible-end metadata does not cut off half a song', () => {
  const h = harness(), opts = h.options();
  opts.current.track.durationMs = opts.currentDurationMs = opts.currentAnalysis.durationMs = 120000;
  opts.currentAnalysis.analysis.audibleEndMs = 60000;
  opts.currentLastVocalEndMs = null;
  const s = h.engine.buildSchedule(opts);
  assert.equal(s.audibleEndPosMs, 120000);
  assert.ok(Math.abs(s.fadeStartPosMs + s.fadeMs - 120000) < 10);
});

test('automatic overlap varies with song tempo and explicit seconds stay fixed', () => {
  const a = harness(), fast = a.options();
  fast.currentLastVocalEndMs = null;
  fast.nextVocalStartMs = 3500;
  const fastMs = a.engine.buildSchedule(fast).fadeMs;
  const b = harness(), slow = b.options();
  slow.currentLastVocalEndMs = null;
  slow.nextVocalStartMs = 3500;
  slow.currentAnalysis.analysis = b.analysis(80);
  slow.nextAnalysis.analysis = b.analysis(80);
  const slowMs = b.engine.buildSchedule(slow).fadeMs;
  assert.ok(slowMs > fastMs + 2000, `${fastMs}ms and ${slowMs}ms`);
  const c = harness(), fixed = c.options();
  c.engine.writeCrossfadeSettings({ lengthMode: 'seconds', lengthValue: 3 });
  fixed.currentLastVocalEndMs = null;
  assert.ok(Math.abs(c.engine.buildSchedule(fixed).fadeMs - 3000) < 750);
});

test('B stays silent until the last lyric finishes when enough outro remains', async () => {
  const h = harness(), opts = h.options();
  opts.currentLastVocalEndMs = 55000;
  opts.nextVocalStartMs = 1500; // short B intro must not bypass A's last line
  const s = h.engine.buildSchedule(opts);
  assert.equal(s.handoff, false);
  assert.ok(s.fadeStartPosMs >= 55400, `B starts at ${s.fadeStartPosMs}ms`);
  assert.ok(Math.abs(s.fadeStartPosMs + s.fadeMs - 60000) < 10);
  assert.ok(s.fadeMs >= 3200);
  assert.equal(h.engine.prepareCrossfade(opts), true);
  h.engine.crossfadeTick(55000, 60000);
  assert.equal(h.calls.some(c => c[0] === 'scheduleDeckGain'), false);
  opts.active.currentTime = s.fadeStartPosMs / 1000;
  h.engine.crossfadeTick(s.fadeStartPosMs, 60000);
  await Promise.resolve();
  assert.equal(h.calls.filter(c => c[0] === 'scheduleDeckGain').length, 2);
});

test('a very short outro overlaps only the minimum needed before the final lyric ends', () => {
  const h = harness(), opts = h.options();
  opts.currentLastVocalEndMs = 59000;
  opts.nextVocalStartMs = 1500;
  const s = h.engine.buildSchedule(opts);
  assert.ok(Math.abs(s.fadeMs - 3200) < 10, `overlap ${s.fadeMs}ms`);
  assert.ok(Math.abs(s.fadeStartPosMs + s.fadeMs - 60000) < 10);
  assert.ok(s.fadeStartPosMs > 56000);
});

test('a fixed length also waits for the final lyric when the outro has room', () => {
  const h = harness(), opts = h.options();
  h.engine.writeCrossfadeSettings({ lengthMode: 'seconds', lengthValue: 15 });
  opts.currentLastVocalEndMs = 54000;
  const s = h.engine.buildSchedule(opts);
  assert.ok(s.fadeStartPosMs >= 54400);
  assert.ok(s.fadeMs >= 3200 && s.fadeMs < 6000);
  assert.ok(Math.abs(s.fadeStartPosMs + s.fadeMs - 60000) < 10);
});

test('short or missing B intro never collapses automatic mixing into a sub-second fade', () => {
  for (const vocalMs of [100, 450, 900, 1500, 0]) {
    const h = harness(), opts = h.options();
    opts.nextVocalStartMs = vocalMs;
    opts.currentLastVocalEndMs = 50000;
    const s = h.engine.buildSchedule(opts);
    assert.ok(s, `schedule should exist for intro ${vocalMs}ms`);
    assert.ok(s.fadeMs >= 3200, `intro ${vocalMs}ms collapsed fade to ${s.fadeMs}ms`);
    assert.equal(s.handoff, false);
  }
});

test('when the first word is too early, B remains audible during a multi-second overlap', () => {
  const h = harness(), opts = h.options();
  opts.nextVocalStartMs = 500;
  const schedule = h.engine.buildSchedule(opts);
  const { naturalGains } = h.load('transitionMath');
  const [a, b] = naturalGains(500 / schedule.fadeMs);
  assert.ok(a > .5 && b > 0);
  assert.ok(schedule.fadeMs >= 3200);
});

test('short-intro playback schedules several seconds of simultaneous A and B audio', async () => {
  const h = harness(), opts = h.options();
  opts.nextVocalStartMs = 450;
  h.engine.prepareCrossfade(opts);
  const planned = h.engine.readCrossfadeDebug();
  opts.active.currentTime = planned.fadeStartPosMs / 1000;
  h.engine.crossfadeTick(planned.fadeStartPosMs, 60000);
  await Promise.resolve();
  const gains = h.calls.filter(c => c[0] === 'scheduleDeckGain');
  assert.equal(gains.length, 2);
  const a = gains[0][3], b = gains[1][3];
  const quarter = 50;
  assert.ok(a[quarter].gain > .5 && b[quarter].gain > .2);
  assert.ok(a.at(-1).atMs >= 3200);
  assert.equal(a.at(-1).gain, 0);
  assert.equal(b.at(-1).gain, 1);
});

test('delayed play starts automation at zero; volume leaves automation intact; buffering cancels it', async () => {
  const h = harness(), opts = h.options();
  let resolvePlay;
  opts.standby.play = () => new Promise(resolve => { resolvePlay = resolve; });
  assert.equal(h.engine.prepareCrossfade(opts), true);
  const start = h.engine.readCrossfadeDebug().fadeStartPosMs;
  opts.active.currentTime = start / 1000;
  h.engine.crossfadeTick(start, 60000);
  assert.equal(h.calls.filter(c => c[0] === 'scheduleDeckGain').length, 0);
  h.advance(.3); opts.active.currentTime += .3;
  resolvePlay(); await Promise.resolve();
  const gains = h.calls.filter(c => c[0] === 'scheduleDeckGain');
  assert.equal(gains.length, 2);
  assert.equal(gains[0][2], 10.3);
  assert.equal(gains[0][3][0].gain, 1);
  assert.equal(gains[1][3][0].gain, 0);
  const writes = h.calls.filter(c => c[0] === 'setDeckGraphGain').length;
  h.engine.crossfadeApplyVolume(.4);
  assert.equal(h.calls.filter(c => c[0] === 'setDeckGraphGain').length, writes);
  opts.standby.dispatchEvent(new Event('waiting'));
  assert.equal(h.engine.crossfadeIsFading(), false);
  assert.equal(h.engine.readCrossfadeDebug().reason, 'b-buffering');
  assert.equal(h.timers.size, 0);
});

test('audio timeline accounts for user playback speed and completes without animation frames', async () => {
  const h = harness(), opts = h.options();
  opts.baseRate = () => 2;
  let finished = false;
  opts.onFinish = () => { finished = true; };
  h.engine.prepareCrossfade(opts);
  const debug = h.engine.readCrossfadeDebug();
  opts.active.currentTime = debug.fadeStartPosMs / 1000;
  h.poll(); // prepared timer triggers independently of UI
  await Promise.resolve();
  const schedule = h.calls.find(c => c[0] === 'scheduleDeckGain')[3];
  assert.ok(Math.abs(schedule.at(-1).atMs - debug.fadeMs / 2) < 1);
  h.advance(debug.fadeMs / 2000 + .05);
  h.poll();
  assert.equal(finished, true);
});

test('late trigger deducts elapsed file time once, not twice', async () => {
  const h = harness(), opts = h.options();
  h.engine.prepareCrossfade(opts);
  const planned = h.engine.readCrossfadeDebug();
  opts.active.currentTime = (planned.fadeStartPosMs + 200) / 1000;
  h.engine.crossfadeTick(planned.fadeStartPosMs + 200, 60000);
  await Promise.resolve();
  const points = h.calls.find(c => c[0] === 'scheduleDeckGain')[3];
  assert.ok(Math.abs(points.at(-1).atMs - (planned.fadeMs - 200)) < 1);
});

test('cancel before play resolves cannot restart automation or commit an unready deck', async () => {
  const h = harness(), opts = h.options();
  let resolvePlay, committed = false;
  opts.standby.play = () => new Promise(resolve => { resolvePlay = resolve; });
  opts.onFinish = () => { committed = true; };
  h.engine.prepareCrossfade(opts);
  const start = h.engine.readCrossfadeDebug().fadeStartPosMs;
  opts.active.currentTime = start / 1000;
  h.engine.crossfadeTick(start, 60000);
  assert.equal(h.engine.crossfadeFinishNow(), false);
  resolvePlay(); await Promise.resolve();
  assert.equal(committed, false);
  assert.equal(h.calls.some(c => c[0] === 'scheduleDeckGain'), false);
  assert.equal(h.timers.size, 0);
});

test('paused A does not trigger a prepared transition', () => {
  const h = harness(), opts = h.options();
  h.engine.prepareCrossfade(opts);
  opts.active.currentTime = h.engine.readCrossfadeDebug().fadeStartPosMs / 1000;
  opts.active.paused = true;
  h.poll();
  assert.equal(h.engine.crossfadeIsPrepared(), true);
  h.engine.cancelCrossfade('pause');
  assert.equal(h.timers.size, 0);
});

test('matched playback rate hugs A while audible, then recovers', async () => {
  const h = harness(), opts = h.options();
  opts.nextAnalysis.analysis = h.analysis(114);
  h.engine.prepareCrossfade(opts);
  const planned = h.engine.readCrossfadeDebug();
  opts.active.currentTime = planned.fadeStartPosMs / 1000;
  h.engine.crossfadeTick(planned.fadeStartPosMs, 60000);
  await Promise.resolve();
  const matched = opts.standby.playbackRate;
  h.advance(planned.fadeMs * .8 / 1000); h.poll();
  // A 还听得见的时候，B 贴着 A 的拍走：允许 PLL 在中心速率 ±1% 内微调，
  // 但不许跑出这个带宽（跑出去就是追错拍或者抖动）。
  const audible = opts.standby.playbackRate;
  assert.ok(Math.abs(audible - matched) <= matched * 0.0101, `对齐段越界：${audible} vs ${matched}`);
  h.advance(planned.fadeMs * .1 / 1000); h.poll();
  assert.ok(opts.standby.playbackRate < matched && opts.standby.playbackRate > 1);
  const points = h.calls.find(c => c[0] === 'scheduleDeckGain')[3];
  assert.ok(points.filter(p => p.atMs >= planned.fadeMs * .82).every(p => p.gain === 0));
});

test('manual transition uses audio automation and rejection restores original deck', async () => {
  const h = harness(), opts = h.options();
  const manual = { ...opts, nextStartFileMs: 0, fadeMs: 1500, fromTitle: 'A', nextTitle: 'B' };
  assert.equal(h.engine.startManualCrossfade(manual), true);
  await Promise.resolve();
  assert.equal(h.calls.filter(c => c[0] === 'scheduleDeckGain').length, 2);
  h.engine.cancelCrossfade('seek');
  assert.equal(h.timers.size, 0);
  let failed = false;
  opts.standby.play = () => Promise.reject(new Error('media unavailable'));
  h.engine.startManualCrossfade({ ...manual, onFail: () => { failed = true; } });
  await Promise.resolve();
  assert.equal(failed, true);
  assert.equal(h.engine.crossfadeIsFading(), false);
  assert.equal(h.timers.size, 0);
});

test('regional matching uses measured energy, ignores silence, caps gain and respects peak headroom', () => {
  const h = harness(), { transitionMatchDb, regionLoudness } = h.load('transitionLoudness');
  const a = { ...h.analysis(), loudnessLufs: -14, peakDb: -8, loudnessMethod: 'bs1770',
    loudnessTimesMs: [200, 300, 400, 500], momentaryLufs: [-18, -18, -18, -100] };
  const b = { ...a, momentaryLufs: [-22, -22, -22, -100] };
  assert.equal(regionLoudness(a, 0, 1000), -18);
  assert.equal(transitionMatchDb(a, b, 0, 0, 1000, 1), 3);
  assert.equal(transitionMatchDb(b, a, 0, 0, 1000, 1), -3);
  assert.equal(transitionMatchDb(a, { ...b, peakDb: -3 }, 0, 0, 1000, 1), 0);
  assert.equal(transitionMatchDb(a, { ...b, loudnessMethod: 'mono-rms-approximation' }, 0, 0, 1000, 1), 0);
  assert.equal(regionLoudness({ ...a, momentaryLufs: [-100, -100, -100, -100] }, 0, 1000), null);
});

test('进阶交接请求带上分析/曲目/元素与预热键（T4-3 接线）', async () => {
  const h = harness();
  const handoff = h.load('advancedHandoff');
  // 标准模式下 requestHandoff 直接返回 null（连工厂都不调），所以先把模式切成进阶。
  h.load('mixTransitionMode').writeMixTransitionMode('advanced');
  let captured = null;
  handoff.setHandoffFactory((request) => {
    captured = request;
    return null; // 立刻回落标准曲线，测试只关心请求内容
  });
  const opts = h.options();
  opts.currentLastVocalEndMs = 55000;
  opts.nextVocalStartMs = 1500;
  assert.equal(h.engine.prepareCrossfade(opts), true);
  const s = h.engine.buildSchedule(opts);
  opts.active.currentTime = s.fadeStartPosMs / 1000;
  h.engine.crossfadeTick(s.fadeStartPosMs, 60000);
  await Promise.resolve();
  assert.ok(captured, '工厂没有被调用');
  assert.equal(captured.kind, 'auto');
  assert.equal(captured.analysisA.bpm, 120);
  assert.equal(captured.analysisB.bpm, 120);
  assert.equal(captured.trackA.id, 'a');
  assert.equal(captured.trackB.id, 'b');
  assert.equal(captured.elementA, opts.active);
  assert.equal(captured.elementB, opts.standby);
  assert.equal(captured.positionMsA, Math.round(s.fadeStartPosMs));
  assert.equal(captured.positionMsB, Math.round(s.bStartFileMs));
  // 键来自 stemKeyOf（这里用间谍返回 'stub'）：算不出来时回落到 ''，但绝不抛错。
  assert.equal(captured.stemKeyA, 'stub');
  assert.equal(captured.stemKeyB, 'stub');
  handoff.setHandoffFactory(null);
});

test('分轨路也吃 PLL：进阶会话按相对修正调 B 的速率（T3-6 延伸）', async () => {
  const h = harness();
  const handoff = h.load('advancedHandoff');
  h.load('mixTransitionMode').writeMixTransitionMode('advanced');

  const rates = [];
  const pairs = [];
  handoff.setHandoffFactory(() => ({
    start() {},
    whenReady: () => Promise.resolve(true),
    cancel() {},
    dispose() {},
    setRate: (rate) => rates.push(rate),
    setRates: (r) => { pairs.push(r); if (typeof r.b === 'number') rates.push(r.b); },
  }));

  const opts = h.options();
  // 让 B 需要变速：126 vs 120 ⇒ tempoRate ≈ 0.952
  opts.nextAnalysis = { analysis: h.analysis(126), durationMs: 60000 };
  opts.currentLastVocalEndMs = 55000;
  opts.nextVocalStartMs = 1500;
  assert.equal(h.engine.prepareCrossfade(opts), true);
  const s = h.engine.buildSchedule(opts);
  opts.active.currentTime = s.fadeStartPosMs / 1000;
  h.engine.crossfadeTick(s.fadeStartPosMs, 60000);
  await Promise.resolve();
  h.advance(0.05);
  h.poll();
  assert.ok(rates.length > 0, '进阶会话一次速率都没收到');

  h.advance(0.05);
  h.poll();
  assert.ok(rates.length >= 2, '每步 tick 都该把速率推给分轨路');
  const last = rates.at(-1);
  const center = Math.abs(s.tempoRate) > 0.001 ? s.tempoRate : 1;
  assert.ok(Math.abs(last - center) <= center * 0.0101,
    `分轨速率 ${last} 应贴着中心 ${center}（±1%）`);
  assert.ok(rates.every((r) => Number.isFinite(r) && r > 0), '不允许推出非法速率');
  // A 侧速率也必须一起推：用户推 tempo 推子时两侧分轨要跟住各自的元素
  assert.ok(pairs.length > 0, 'setRates 一次都没被调用');
  const lastPair = pairs.at(-1);
  assert.ok(Math.abs(lastPair.a - opts.active.playbackRate) < 1e-9,
    `A 速率 ${lastPair.a} 应等于元素速率 ${opts.active.playbackRate}`);
  assert.ok(Math.abs(lastPair.b - last) < 1e-9, 'B 速率与 setRate 路径一致');
  handoff.setHandoffFactory(null);
});

test('试放台预案：进阶模式给出泳道块，标准模式给出原因（T5-2）', async () => {
  const h = harness();
  const setMode = (mode) => h.load('mixTransitionMode').writeMixTransitionMode(mode);
  const prepare = () => {
    const opts = h.options();
    opts.currentLastVocalEndMs = 55000;
    opts.nextVocalStartMs = 1500;
    h.engine.prepareCrossfade(opts);
    const deck = h.load('crossfadeDeck');
    return typeof deck.readCrossfadeDebug === 'function' ? deck.readCrossfadeDebug() : null;
  };

  setMode('standard');
  let state = prepare();
  const std = state && state.advancedPreview;
  assert.ok(std, '标准模式也要有预案占位（否则试放台没东西可画）');
  assert.equal(std.mode, 'standard');
  assert.equal(std.blocks.length, 0);
  assert.ok(std.emptyReason.length > 0, '标准模式要说明为什么没有换手');

  setMode('advanced');
  state = prepare();
  const adv = state && state.advancedPreview;
  assert.ok(adv, '进阶模式必须算出预案');
  assert.equal(adv.mode, 'advanced');
  assert.ok(adv.barMs > 0, 'preview.barMs 不该是 0');
  assert.ok(adv.totalMs > 0, 'preview.totalMs 不该是 0');
  assert.ok(adv.blocks.length > 0, '进阶模式应该至少画出一个换手块');
  for (const block of adv.blocks) {
    assert.ok(['swap', 'echo', 'duck'].includes(block.kind));
    assert.ok(block.deck === 'A' || block.deck === 'B');
    assert.ok(block.x >= 0 && block.x <= 1, `x 越界：${block.x}`);
    assert.ok(block.width > 0 && block.x + block.width <= 1.0001, `width 越界：${block.x}+${block.width}`);
  }
  setMode('standard');
});

test('PLL 接入：变速过渡时按拍相位微调 B 的速率（T3-6）', async () => {
  const h = harness();
  const opts = h.options();
  // A=120、B=126：tempoRate≈0.952，必然走变速对齐段。
  opts.nextAnalysis = { analysis: h.analysis(126), durationMs: 60000 };
  assert.equal(h.engine.prepareCrossfade(opts), true);
  const s = h.engine.buildSchedule(opts);
  const center = s.tempoRate;
  assert.ok(Math.abs(center - 1) > 0.01, `本用例需要变速：${center}`);

  opts.active.currentTime = s.fadeStartPosMs / 1000;
  opts.standby.currentTime = s.bStartFileMs / 1000;
  h.engine.crossfadeTick(s.fadeStartPosMs, 60000);
  await Promise.resolve();
  h.advance(0.05);
  h.poll();
  const first = h.engine.readCrossfadeDebug();
  assert.equal(first.phase, 'fading');
  assert.equal(first.pllActive, true, 'PLL 应当已接管');
  assert.ok(Math.abs(first.pllRate - center) <= Math.abs(center) * 0.0101, `pllRate 越界：${first.pllRate}`);

  // 控制律本身（超前减速 / 落后加速 / 单步限幅）由 transitionPerformer.test.cjs 的
  // trackRate 三条用例覆盖；这里只保证「变速过渡确实交给 PLL 接管且不越界」。
  // 元素 currentTime 会被引擎在起播时重写，用它对拍会变成测引擎而不是测 PLL。
  assert.ok(Number.isFinite(first.pllErrBeats), 'PLL 应当给出一个有限的相位差');
});

test('G2 回退无咔哒：进阶没接管时从当前进度接着排曲线，起点连续', async () => {
  const h = harness(); // 图模式：进阶只在图里生效
  const handoff = h.load('advancedHandoff');
  h.load('mixTransitionMode').writeMixTransitionMode('advanced');

  let cancelled = 0;
  handoff.setHandoffFactory(() => ({
    start() {},
    whenReady: () => Promise.resolve(false), // 模拟四轨解码失败
    cancel: () => { cancelled += 1; },
    dispose() {},
  }));

  const opts = h.options();
  opts.currentLastVocalEndMs = 55000;
  opts.nextVocalStartMs = 1500;
  assert.equal(h.engine.prepareCrossfade(opts), true);
  const s = h.engine.buildSchedule(opts);
  opts.active.currentTime = s.fadeStartPosMs / 1000;
  h.engine.crossfadeTick(s.fadeStartPosMs, 60000);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(cancelled, 1, '回退必须恰好取消一次');

  // 回退时排的 A 曲线：起点必须等于「回退那一刻」的等功率值，不能跳回 0。
  const gainCalls = h.calls.filter((c) => c[0] === 'scheduleDeckGain' && c[1] === opts.active);
  assert.ok(gainCalls.length > 0, '回退必须重新排一条增益曲线');
  const points = gainCalls.at(-1)[3];
  assert.ok(Array.isArray(points) && points.length > 1, '曲线点缺失');
  const startGain = points[0].gain;
  const [expect0] = h.load('transitionMath').naturalGains(0, 1);
  assert.ok(Math.abs(startGain - expect0) < 1e-6, `曲线起点 ${startGain} 应等于当前进度值 ${expect0}`);
  // 相邻点步长足够细（200 段），不会听出阶跃。
  const maxStep = Math.max(...points.slice(1).map((p, i) => Math.abs(p.gain - points[i].gain)));
  assert.ok(maxStep < 0.02, `单步 ${maxStep} 太大，会有咔哒`);
  const last = points.at(-1).gain;
  assert.ok(Math.abs(last - 0) < 1e-6, `A 必须收到 0，实际 ${last}`);
  handoff.setHandoffFactory(null);
});

test('T4-3 互斥静音：进阶接管后 deck 图增益压到 0，回退按当前进度还原', async () => {
  const h = harness();
  const handoff = h.load('advancedHandoff');
  h.load('mixTransitionMode').writeMixTransitionMode('advanced');
  // 减法引擎（默认）不压元素通路；这条用例测的是加法引擎的互斥静音，显式切回加法。
  h.load('mixTransitionMode').writeMixTransitionEngine('additive');

  let readyResolve = null;
  handoff.setHandoffFactory(() => ({
    start() {},
    whenReady: () => new Promise(resolve => { readyResolve = resolve; }),
    cancel() {},
    dispose() {},
  }));

  const opts = h.options();
  assert.equal(h.engine.prepareCrossfade(opts), true);
  const s = h.engine.buildSchedule(opts);
  opts.active.currentTime = s.fadeStartPosMs / 1000;
  h.engine.crossfadeTick(s.fadeStartPosMs, 60000);
  await Promise.resolve();

  // 接管成功：两条 deck 通路都必须被压到 0（20 ms 斜坡），否则同一首歌会双声。
  const muted = h.calls.filter(c => c[0] === 'setDeckGraphGain' && c[2] === 0 && c[3] === 20);
  assert.equal(muted.length, 2, 'deck 图增益没有互斥静音');
  assert.equal(muted[0][1], opts.active);
  assert.equal(muted[1][1], opts.standby);

  // 往下走一点再回退：还原值必须等于当前进度的等功率值，而不是从 0 直接跳到目标。
  h.advance(0.4);
  opts.active.currentTime += 0.4;
  h.poll();
  const progress = Math.max(0, Math.min(1, .4 / (h.engine.readCrossfadeDebug().fadeMs / 1000)));
  const before = h.calls.length;
  readyResolve(false);
  await Promise.resolve();
  await Promise.resolve();
  const restored = h.calls.slice(before).filter(c => c[0] === 'setDeckGraphGain');
  assert.equal(restored.length, 2, '回退没有还原 deck 通路');
  const expected = [Math.cos(progress * Math.PI / 2), Math.sin(progress * Math.PI / 2)];
  assert.ok(Math.abs(restored[0][2] - expected[0]) < 0.02, `A 还原值 ${restored[0][2]} != ${expected[0]}`);
  assert.ok(Math.abs(restored[1][2] - expected[1]) < 0.02, `B 还原值 ${restored[1][2]} != ${expected[1]}`);
  assert.equal(restored[0][3], 20);
  assert.equal(restored[1][3], 20);

  handoff.setHandoffFactory(null);
});

test('T6-5 成本控制：门控判成 standard 时不预热四轨窗口', () => {
  const h = harness();
  h.load('mixTransitionMode').writeMixTransitionMode('advanced');
  const opts = h.options();
  // A 的分析只有 0.3 置信度 ⇒ decideTempoGate 落到 standard 档，plan 为空。
  opts.currentAnalysis = { analysis: h.analysis(120), durationMs: 60000 };
  opts.currentAnalysis.analysis.bpmConfidence = 0.3;
  h.engine.prepareCrossfade(opts);
  assert.equal(h.readiness.prefetchCalls.length, 0, 'standard 档仍在预热四轨（白烧 CPU）');
});

test('T6-5 成本控制：进阶档正常预热，且用的位置与交接点一致', () => {
  const h = harness();
  h.load('mixTransitionMode').writeMixTransitionMode('advanced');
  const opts = h.options();
  assert.equal(h.engine.prepareCrossfade(opts), true);
  assert.equal(h.readiness.prefetchCalls.length, 1);
  const [a, b] = h.readiness.prefetchCalls[0];
  const s = h.engine.buildSchedule(opts);
  assert.ok(Math.abs(a.positionSec - s.fadeStartPosMs / 1000) < 1e-6, '预热位置与 fadeStart 不一致');
  assert.ok(Math.abs(b.positionSec - s.bStartFileMs / 1000) < 1e-6, '预热位置与 B 起播不一致');
});

test('进阶路径写的是绝对速率：用户倍速 1.5 时给分轨的是 1.428 而不是 0.952', async () => {
  const h = harness();
  const handoff = h.load('advancedHandoff');
  h.load('mixTransitionMode').writeMixTransitionMode('advanced');
  const rates = [];
  handoff.setHandoffFactory(() => ({
    start() {}, whenReady: () => Promise.resolve(true), cancel() {}, dispose() {},
    setRate: (rate) => rates.push(rate),
  }));

  const opts = h.options();
  opts.baseRate = () => 1.5;               // 用户把 B 的倍速拉到 1.5
  opts.nextAnalysis = { analysis: h.analysis(126), durationMs: 60000 };
  assert.equal(h.engine.prepareCrossfade(opts), true);
  const s = h.engine.buildSchedule(opts);
  opts.active.currentTime = s.fadeStartPosMs / 1000;
  h.engine.crossfadeTick(s.fadeStartPosMs, 60000);
  await Promise.resolve();
  h.advance(0.05);
  h.poll();
  assert.ok(rates.length > 0, '进阶会话一次速率都没收到');
  const center = 1.5 * s.tempoRate;         // 1.5 × 0.952 ≈ 1.428
  for (const r of rates) {
    assert.ok(Math.abs(r - center) <= center * 0.0101,
      `分轨速率 ${r} 必须是绝对速率 ≈ ${center}（相对修正会给出 ${s.tempoRate}）`);
  }
  handoff.setHandoffFactory(null);
});

test('分轨先放完就提前接回等功率：剩 <0.4 s 触发回退，不发生静场', async () => {
  const h = harness();
  const handoffMod = h.load('advancedHandoff');
  h.load('mixTransitionMode').writeMixTransitionMode('advanced');
  const spy = { cancelled: 0, disposed: 0, remaining: 10 };
  handoffMod.setHandoffFactory(() => ({
    start() {},
    whenReady: () => Promise.resolve(true),
    cancel: () => { spy.cancelled += 1; },
    dispose: () => { spy.disposed += 1; },
    setRate() {},
    remainingSec: () => spy.remaining,
  }));

  const opts = h.options();
  assert.equal(h.engine.prepareCrossfade(opts), true);
  const s = h.engine.buildSchedule(opts);
  opts.active.currentTime = s.fadeStartPosMs / 1000;
  h.engine.crossfadeTick(s.fadeStartPosMs, 60000);
  await Promise.resolve();
  h.advance(0.05);
  h.poll();
  assert.equal(spy.cancelled, 0, '音频还够时不许回退');

  // 分轨只剩 0.2 s，但过渡还有很长的路
  spy.remaining = 0.2;
  h.advance(0.05);
  h.poll();
  assert.equal(spy.cancelled, 1, '剩 0.2 s 必须回退一次');
  assert.ok(spy.disposed >= 0);
  handoffMod.setHandoffFactory(null);
});

test('手法设置：选了人声先行的进阶过渡，交接请求必须带上 hint', async () => {
  const h = harness();
  const handoff = h.load('advancedHandoff');
  h.load('mixTransitionMode').writeMixTransitionMode('advanced');
  h.load('mixTransitionMode').writeMixTransitionTemplate('vocalFirst');
  let captured = null;
  handoff.setHandoffFactory((request) => { captured = request; return null; });
  const opts = h.options();
  assert.equal(h.engine.prepareCrossfade(opts), true);
  const s = h.engine.buildSchedule(opts);
  opts.active.currentTime = s.fadeStartPosMs / 1000;
  h.engine.crossfadeTick(s.fadeStartPosMs, 60000);
  await Promise.resolve();
  assert.equal(captured && captured.hint, 'vocalFirst', 'requestHandoff 应把 hint 透传给规划器');
});

test('手法设置：auto 时不带 hint（让能量/段落规则自己决定）', async () => {
  const h = harness();
  const handoff = h.load('advancedHandoff');
  h.load('mixTransitionMode').writeMixTransitionMode('advanced');
  h.load('mixTransitionMode').writeMixTransitionTemplate('auto');
  let captured = null;
  handoff.setHandoffFactory((request) => { captured = request; return null; });
  const opts = h.options();
  assert.equal(h.engine.prepareCrossfade(opts), true);
  const s = h.engine.buildSchedule(opts);
  opts.active.currentTime = s.fadeStartPosMs / 1000;
  h.engine.crossfadeTick(s.fadeStartPosMs, 60000);
  await Promise.resolve();
  assert.equal(captured && captured.hint, undefined);
});
