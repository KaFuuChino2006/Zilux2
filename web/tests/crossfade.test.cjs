// Run with: node --test web/tests/crossfade.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function harness() {
  let clock = 10, now = 1000;
  const store = new Map(), timers = new Map(), calls = [], modules = new Map();
  const audio = new Proxy({
    audioTapClock: () => clock,
    audioTapGraphActive: () => true,
    attachDeckToGraph: () => true,
  }, { get: (target, key) => target[key] ?? ((...args) => calls.push([key, ...args])) });
  const window = { addEventListener() {}, dispatchEvent() {},
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); } };
  function load(name) {
    const file = path.resolve(__dirname, '../src/ui', name + '.ts');
    if (modules.has(file)) return modules.get(file);
    let source = fs.readFileSync(file, 'utf8');
    if (name === 'crossfadeDeck') source += '\nexport { buildSchedule, buildAmTracks, resolveTransitionStyle };';
    const exports = {};
    modules.set(file, exports);
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, {
      exports, console, window, performance: { now: () => now },
      localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
      CustomEvent: class {},
      require: name => name.includes('audioTap') ? audio
        : ['./transitionMath', './transitionLoudness', './loudness'].includes(name) ? load(name.slice(2)) : {},
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
  return { engine, load, calls, timers, analysis, options, store,
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

test('matched playback rate stays fixed while A is audible, then recovers', async () => {
  const h = harness(), opts = h.options();
  opts.nextAnalysis.analysis = h.analysis(114);
  h.engine.prepareCrossfade(opts);
  const planned = h.engine.readCrossfadeDebug();
  opts.active.currentTime = planned.fadeStartPosMs / 1000;
  h.engine.crossfadeTick(planned.fadeStartPosMs, 60000);
  await Promise.resolve();
  const matched = opts.standby.playbackRate;
  h.advance(planned.fadeMs * .8 / 1000); h.poll();
  assert.equal(opts.standby.playbackRate, matched);
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
