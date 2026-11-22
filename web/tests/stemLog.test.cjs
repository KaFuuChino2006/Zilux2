'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SRC = path.join(__dirname, '..', 'src');

function loadModule(relPath) {
  const file = path.join(SRC, relPath);
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const store = new Map();
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    window: { localStorage: null },
  };
  sandbox.window.localStorage = sandbox.localStorage;
  const module = { exports: {} };
  const context = vm.createContext({ ...sandbox, module, exports: module.exports });
  vm.runInContext(js, context, { filename: file });
  return module.exports;
}

const stemLog = loadModule('core/automix/stemLog.ts');

test('默认增益全 0，四个轨都在', () => {
  const gains = stemLog.normalizeStemGains(null);
  assert.strictEqual(gains.vocals, 0);
  assert.strictEqual(gains.drums, 0);
  assert.strictEqual(gains.bass, 0);
  assert.strictEqual(gains.other, 0);
});

test('增益夹在 -48…+6，非法值回 0', () => {
  const gains = stemLog.normalizeStemGains({ vocals: -99, drums: 99, bass: 'x', other: 3.25 });
  assert.strictEqual(gains.vocals, -48);
  assert.strictEqual(gains.drums, 6);
  assert.strictEqual(gains.bass, 0);
  assert.strictEqual(gains.other, 3.25);
});

test('读写往返', () => {
  const gains = { vocals: -6, drums: 1.5, bass: -1, other: 0 };
  stemLog.writeStemGains(gains);
  const back = stemLog.readStemGains();
  assert.strictEqual(back.vocals, -6);
  assert.strictEqual(back.drums, 1.5);
  assert.strictEqual(back.bass, -1);
  assert.strictEqual(back.other, 0);
});

test('记录追加并按时间排序', () => {
  stemLog.clearStemLog();
  stemLog.pushStemLog({
    at: '2026-11-20T02:00:00.000Z',
    track: 'Skydive',
    posMs: 1000,
    phase: 'fading',
    gains: { vocals: -6, drums: 0, bass: 0, other: 0 },
    solo: 'bass',
    reconDbfs: -72.4,
  });
  const log = stemLog.readStemLog();
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].track, 'Skydive');
  assert.strictEqual(log[0].solo, 'bass');
  assert.strictEqual(log[0].reconDbfs, -72.4);
});

test('同毫秒同曲同位置覆盖末条，不刷屏', () => {
  stemLog.clearStemLog();
  const base = {
    at: '2026-11-20T02:00:00.000Z',
    track: '春めく',
    posMs: 500,
    phase: 'fading',
    gains: { vocals: 0, drums: 0, bass: 0, other: 0 },
    solo: null,
  };
  stemLog.pushStemLog({ ...base, note: '第一次' });
  stemLog.pushStemLog({ ...base, note: '第二次' });
  const log = stemLog.readStemLog();
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].note, '第二次');
});

test('清空', () => {
  stemLog.pushStemLog({
    at: '2026-11-20T02:00:00.000Z',
    track: 'x',
    posMs: 0,
    phase: 'idle',
    gains: { vocals: 0, drums: 0, bass: 0, other: 0 },
    solo: null,
  });
  stemLog.clearStemLog();
  assert.strictEqual(stemLog.readStemLog().length, 0);
});

test('单行格式化带增益 / 独听 / 残差 / 备注', () => {
  const line = stemLog.formatStemLogLine({
    at: '2026-11-20T02:00:00.000Z',
    track: 'Skydive',
    posMs: 95_400,
    phase: 'fading',
    gains: { vocals: -6, drums: 0, bass: -1.5, other: 0 },
    solo: 'bass',
    reconDbfs: -72.4,
    note: '贝斯糊',
  });
  assert.match(line, /Skydive/);
  assert.match(line, /@01:35/);
  assert.match(line, /人声 -6\.0/);
  assert.match(line, /贝斯 -1\.5/);
  assert.match(line, /独听 bass/);
  assert.match(line, /残差 -72dB/);
  assert.match(line, /贝斯糊/);
});

test('多行导出带表头', () => {
  const text = stemLog.formatStemLog([
    {
      at: '2026-11-20T02:00:00.000Z',
      track: 'A',
      posMs: 1000,
      phase: 'idle',
      gains: { vocals: 0, drums: 0, bass: 0, other: 0 },
      solo: null,
    },
  ]);
  assert.match(text, /A @00:01/);
});
