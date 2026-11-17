/**
 * 前瞻预热（prefetchStemWindows）：把当前窗口及其后 N 窗排进宿主队列。
 *
 * 这个用例的存在理由：跨窗干等一窗（约 7 s）是「听起来卡一下」的唯一来源，
 * 而预热是个纯调度动作，最容易被后续重构悄悄删掉 —— 所以钉住它的窗口号与去重行为。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const ts = require(path.join(__dirname, '..', 'node_modules', 'typescript'));
const vm = require('node:vm');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

function load() {
  const prepared = [];
  const stubs = {
    './audioTap': {
      deckAudioContext: () => null,
      deckStemInput: () => null,
      setDeckMixGain: () => {},
      setDeckStemGain: () => {},
    },
    './stemsClient': {
      STEM_WINDOW_SEC: 30,
      prepareStemsWindow: (track, window) => {
        prepared.push(`${track.id}#${window}`);
        return Promise.resolve({ state: 'ready', window });
      },
      loadStemWindowBoth: () => Promise.reject(new Error('not used')),
    },
  };

  const file = path.join(ROOT, 'src', 'core', 'stemsDeck.ts');
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  }).outputText;
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require: (id) => stubs[id] ?? {},
    console,
    Map,
    Set,
    Math,
    Number,
    Promise,
    AudioBuffer: function AudioBuffer() {},
    AudioBufferSourceNode: function AudioBufferSourceNode() {},
    AudioContext: function AudioContext() {},
    setTimeout,
    clearTimeout,
    window: { setTimeout, clearTimeout },
  });
  vm.runInContext(js, context, { filename: file });
  return { api: module.exports, prepared };
}

const { api, prepared } = load();
const track = { source: 'local', id: 'a', title: 'A' };

// 65 s ⇒ 第 2 窗（30 s 网格），ahead=2 ⇒ 排 2/3/4。
const queued = api.prefetchStemWindows(track, 65, 2);
assert.equal(JSON.stringify(queued), JSON.stringify([2, 3, 4]));
assert.equal(JSON.stringify(prepared), JSON.stringify(['a#2', 'a#3', 'a#4']));

// 非有限位置按 0 处理，不会算出 NaN 窗口。
prepared.length = 0;
const fromBad = api.prefetchStemWindows(track, Number.NaN, 0);
assert.equal(JSON.stringify(fromBad), JSON.stringify([0]));

// ahead 为负等价于只排当前窗。
prepared.length = 0;
const noAhead = api.prefetchStemWindows(track, 31, -5);
assert.equal(JSON.stringify(noAhead), JSON.stringify([1]));

// 缺曲目时什么都不排（调用方可能是还没选歌的状态）。
prepared.length = 0;
assert.equal(JSON.stringify(api.prefetchStemWindows(null, 10, 2)), '[]');
assert.equal(prepared.length, 0);

console.log('prefetchStemWindows: 4 checks passed');
