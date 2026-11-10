const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const exportsUnderTest = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/ui/poemMotion.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exportsUnderTest });
const { poemCamera, poemActiveIndex } = exportsUnderTest;

test('camera remains continuous and monotonic through normal and dense lyric boundaries', () => {
  for (const starts of [[2000, 6000, 10000, 16000], [0, 100, 180, 300, 900, 910, 1600]]) {
    let previous = poemCamera(starts, -2000);
    for (let t = -1999; t <= starts.at(-1) + 2000; t++) {
      const value = poemCamera(starts, t);
      assert.ok(Number.isFinite(value));
      assert.ok(value >= previous - 1e-9, `camera reverses at ${t}`);
      assert.ok(value - previous < 0.2, `camera jumps at ${t}`);
      previous = value;
    }
    assert.equal(previous, starts.length - 1);
  }
});
test('camera has continuous velocity at transition edges and reaches steady reading position', () => {
  const starts = [2000, 6000, 10000];
  for (const edge of [5620, 6620, 9620, 10620]) {
    const a = poemCamera(starts, edge - 0.1), b = poemCamera(starts, edge), c = poemCamera(starts, edge + 0.1);
    assert.ok(Math.abs((c - b) - (b - a)) < 1e-6);
  }
  assert.equal(poemCamera(starts, 8000), 1);
});
test('seeking is deterministic and anticipatory motion does not advance singing timestamps', () => {
  const starts = [2000, 6000, 10000];
  const before = poemCamera(starts, 5900);
  assert.ok(before > 0 && before < 1);
  assert.equal(poemActiveIndex(starts, 5900), 0);
  assert.equal(poemActiveIndex(starts, 6000), 1);
  poemCamera(starts, 20000);
  assert.equal(poemCamera(starts, 5900), before);
  assert.equal(poemCamera([], 9000), 0);
  assert.equal(poemActiveIndex([], 9000), -1);
  assert.equal(poemCamera([5000], 9000), 0);
});

function stageHarness() {
  let now = 1000, state = { positionMs: 5000, durationMs: 30000, playing: true };
  const listeners = new Set(), frames = new Map(), scenes = [];
  let frameId = 0;
  const root = () => {
    const classes = new Set();
    return { classList: { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)), toggle: (n, v) => v ? classes.add(n) : classes.delete(n), contains: n => classes.has(n) }, append() {}, remove() {} };
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/ui/poem.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, console, document: { createElement: root, hidden: false }, performance: { now: () => now },
    requestAnimationFrame: fn => { const id = ++frameId; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    require: name => name === './player' ? {
      playerState: () => state, onPlayer: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    } : { createPoemScene() {
      const scene = { root: root(), updates: [], songs: [], disposed: false, update(...args) { this.updates.push(args); }, setSong(s) { this.songs.push(s); }, setPalette() {}, dispose() { this.disposed = true; } };
      scenes.push(scene); return scene;
    } },
  });
  return { stage: exports.createPoemStage(), scenes, listeners, frames,
    tick(delta) { now += delta; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now)); },
    sync(next) { state = { ...state, ...next }; listeners.forEach(fn => fn()); },
  };
}
test('stage freezes on pause, seeks immediately, and preserves background motion across song changes', () => {
  const h = stageHarness(); h.stage.setSong({ trackKey: 'first' }); h.stage.activate();
  h.tick(16); assert.equal(h.scenes[0].updates.at(-1)[0], 5016);
  h.sync({ positionMs: 5016, playing: false }); h.tick(500);
  const paused = h.scenes[0].updates.at(-1); h.tick(500);
  assert.deepEqual(h.scenes[0].updates.at(-1), paused);
  h.sync({ positionMs: 18000 }); h.tick(16); assert.equal(h.scenes[0].updates.at(-1)[0], 18000);
  h.stage.setSong({ trackKey: 'second' }); h.sync({ positionMs: 0, playing: true }); h.tick(16);
  assert.equal(h.scenes.length, 1); assert.ok(h.scenes[0].updates.at(-1)[1] > paused[1]);
  h.stage.dispose();
});
test('switching effects releases the scene, frame callback and player subscription', () => {
  const h = stageHarness(); h.stage.activate(); h.stage.activate();
  assert.equal(h.scenes.length, 1); assert.equal(h.listeners.size, 1); assert.equal(h.frames.size, 1);
  h.stage.deactivate(); assert.equal(h.scenes[0].disposed, true);
  assert.equal(h.listeners.size, 0); assert.equal(h.frames.size, 0);
  h.stage.activate(); assert.equal(h.scenes.length, 2);
  h.stage.dispose(); h.stage.activate();
  assert.equal(h.scenes.length, 2); assert.equal(h.listeners.size, 0); assert.equal(h.frames.size, 0);
});
