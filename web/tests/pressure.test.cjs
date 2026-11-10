const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function code(name) { return ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/ui', name + '.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; }
const api = {}; vm.runInNewContext(code('pressureProgram'), { exports: api });
const { compilePressure, pressureIndex, pressureTransition, phraseProgress } = api;
const clean = value => value.replace(/\s/g, '');
const line = (text, timeMs, durationMs = 3000) => ({ text, timeMs, durationMs, translation: '', words: [] });
const song = lines => ({ trackKey: 'test', title: '声压', artist: '', album: '', durationMs: 60000, lyricOffsetMs: 0, lines });

test('compilation preserves all lyric text across short lines, long lines, English and simultaneous vocals', () => {
  for (const lines of [
    [line('打破沉默', 1000), line('让心跳响彻夜空', 5000)],
    [line('这是一句非常非常长的歌词需要多次构图但不能丢失任何文字包括最后的声音', 1000, 16000)],
    [line('We are breaking through the silence and running into another beautiful morning', 2000, 12000)],
    [line('向前', 1000, 200), line('奔跑', 1200, 250), line('呼喊', 1450, 250), line('合唱', 1450, 700)],
  ]) {
    const shots = compilePressure(song(lines));
    assert.equal(clean(shots.flatMap(s => s.phrases.map(p => p.text)).join('')), clean(lines.map(l => l.text).join('')));
    for (let i = 0; i < shots.length; i++) {
      assert.ok(Number.isFinite(shots[i].start) && Number.isFinite(shots[i].end));
      assert.ok(shots[i].end > shots[i].start);
      if (i) assert.ok(shots[i].start > shots[i - 1].start);
    }
  }
});
test('real word timestamps are retained, including delayed singing inside a lyric line', () => {
  const input = song([{ ...line('现在出发', 1000, 6000), words: [{ text: '现在', startMs: 2500, endMs: 3500 }, { text: '出发', startMs: 4500, endMs: 6000 }] }]);
  const p = compilePressure(input)[0].phrases[0];
  assert.equal(phraseProgress(p, 2000), 0);
  assert.equal(phraseProgress(p, 4000), 0.5);
  assert.equal(phraseProgress(p, 6000), 1);
});
test('dense phrases share a shot while sustained phrases cycle through a wide composition vocabulary', () => {
  assert.ok(compilePressure(song([line('风起', 0, 200), line('云涌', 200, 200), line('出发', 400, 200)])).length >= 1);
  const shots = compilePressure(song(Array.from({ length: 12 }, (_, i) => line('打破沉默', i * 4000))));
  assert.ok(new Set(shots.map(s => s.kind)).size >= 6, 'sustained lines should use several compositions');
});
test('transitions remain bounded, forward moving and seek deterministic', () => {
  const shots = compilePressure(song(Array.from({ length: 10 }, (_, i) => line('向前冲', i * 1350, 1200))));
  const remembered = new Map();
  for (let time = 0; time < 15000; time += 4) {
    const frame = pressureTransition(shots, time);
    if (frame) {
      assert.ok(frame.progress >= 0 && frame.progress <= 1);
      assert.equal(frame.to, frame.from + 1);
      const last = remembered.get(frame.to) ?? -1;
      assert.ok(frame.progress >= last); remembered.set(frame.to, frame.progress);
      assert.deepEqual(pressureTransition(shots, time), frame);
    }
  }
  assert.equal(pressureIndex([], 0), -1);
  assert.equal(compilePressure(null).length, 0);
  const gap = compilePressure(song([line('出发', 1000, 1000), line('归来', 20000, 2000)]));
  assert.equal(pressureTransition(gap, 20000), null);
});

function harness() {
  let now = 1000, state = { positionMs: 5000, durationMs: 30000, playing: true }, audioReads = 0;
  const frames = new Map(), listeners = new Set(), scenes = []; let nextFrame = 0;
  const element = () => {
    const set = new Set(); return { classList: { add: (...a) => a.forEach(x => set.add(x)), remove: (...a) => a.forEach(x => set.delete(x)), toggle: (k, v) => v ? set.add(k) : set.delete(k), contains: k => set.has(k) }, append() {}, remove() {} };
  };
  const exports = {};
  vm.runInNewContext(code('pressure'), {
    exports, console: { error() {} }, performance: { now: () => now }, document: { hidden: false, createElement: element },
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame: id => frames.delete(id),
    require: name => {
      if (name === './player') return { playerState: () => state, onPlayer: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
      if (name === '../core/settings') return { getSettings: () => ({ playback: { audioReactive: false } }) };
      if (name === '../core/audioTap') return { playbackAnalyser: () => { audioReads++; return null; } };
      return { createPressureScene() { const scene = { root: element(), updates: [], song: null, disposed: false, fail: false,
        setSong(s) { this.song = s; }, update(...args) { if (this.fail) throw Error('GPU unavailable'); this.updates.push(args); }, dispose() { this.disposed = true; } };
        scenes.push(scene); return scene; } };
    },
  });
  return { stage: exports.createPressureStage(), scenes, frames, listeners, audioReads: () => audioReads,
    tick(delta) { now += delta; const list = [...frames.values()]; frames.clear(); list.forEach(fn => fn(now)); },
    sync(next) { state = { ...state, ...next }; listeners.forEach(fn => fn()); },
  };
}
test('playback clock freezes on pause, seeks immediately and respects the audio response setting', () => {
  const h = harness(); h.stage.setSong(song([line('出发', 0)])); h.stage.activate(); h.tick(16);
  assert.equal(h.scenes[0].updates.at(-1)[0], 5016);
  h.sync({ playing: false, positionMs: 5016 }); h.tick(1000);
  assert.equal(h.scenes[0].updates.at(-1)[0], 5016);
  h.sync({ positionMs: 18000 }); h.tick(16); assert.equal(h.scenes[0].updates.at(-1)[0], 18000);
  assert.equal(h.audioReads(), 0); h.stage.dispose();
});
test('mode changes and renderer failures leave no animation or player subscription running', () => {
  const h = harness(); h.stage.activate(); h.stage.activate();
  assert.equal(h.scenes.length, 1); assert.equal(h.listeners.size, 1);
  h.stage.deactivate(); assert.equal(h.scenes[0].disposed, true); assert.equal(h.frames.size, 0); assert.equal(h.listeners.size, 0);
  h.stage.activate(); h.scenes[1].fail = true; h.tick(16);
  assert.equal(h.stage.root.classList.contains('is-failed'), true); assert.equal(h.frames.size, 0); assert.equal(h.listeners.size, 0);
  h.stage.dispose(); h.stage.activate(); assert.equal(h.scenes.length, 2);
});
