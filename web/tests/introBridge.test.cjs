'use strict';
/**
 * 前奏桥（B 侧循环 + 移调）与唱词均衡时间。
 *
 * 这组函数决定「下一首的前奏要循环几遍、移几个半音、元素推迟多久起播」。
 * 判错的两个方向都难听：循环太少 → 前奏不够、接唱点还没到就开口；循环太多 → 听出卡带。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadModules(entries) {
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const source = fs.readFileSync(file, 'utf8');
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    cache.set(file, module);
    const sandbox = {
      module,
      exports: module.exports,
      require: (request) => {
        if (!request.startsWith('.')) return require(request);
        const resolved = path.resolve(path.dirname(file), request);
        for (const candidate of [resolved, `${resolved}.ts`, path.join(resolved, 'index.ts')]) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return load(candidate);
        }
        throw new Error(`无法解析模块：${request}（来自 ${file}）`);
      },
      console, Math, Number, Array, Object, JSON, String, Boolean, Error, isFinite,
    };
    vm.runInNewContext(js, sandbox, { filename: file });
    return module.exports;
  };
  const out = {};
  for (const [name, file] of Object.entries(entries)) out[name] = load(path.join(root, file));
  return out;
}

const { introBridge } = loadModules({ introBridge: 'src/core/automix/introBridge.ts' });
const { pitchShift } = loadModules({ pitchShift: 'src/audio/pitchShift.ts' });

const BAR = 2000;

test('前奏够长时不做桥：返回 null（一次听完的旋律不循环）', () => {
  const plan = introBridge.planIntroBridge({ introStartMs: 0, firstVocalMs: 30_000, barMs: BAR, targetMs: 12_000 });
  assert.equal(plan, null);
});

test('前奏太短（< 2 小节）不做桥', () => {
  const plan = introBridge.planIntroBridge({ introStartMs: 0, firstVocalMs: 3000, barMs: BAR, targetMs: 16_000 });
  assert.equal(plan, null);
});

test('没有唱词锚点不做桥', () => {
  const plan = introBridge.planIntroBridge({ introStartMs: 0, firstVocalMs: 0, barMs: BAR, targetMs: 16_000 });
  assert.equal(plan, null);
});

test('8 小节前奏、目标 32 秒：4 小节 × 3 遍，元素推迟 16 秒', () => {
  const plan = introBridge.planIntroBridge({
    introStartMs: 0,
    firstVocalMs: 16_000,
    barMs: BAR,
    targetMs: 32_000,
  });
  assert.ok(plan);
  assert.equal(plan.unitBars, 4);
  assert.equal(plan.loopMs, 4 * BAR);
  assert.equal(plan.passes, 3);
  assert.equal(plan.delayMs, 16_000);
  assert.equal(plan.bufferMs, 16_000);
  assert.equal(plan.semitones, 0);
});

test('循环遍数上限：目标再长也不超过 4 遍', () => {
  const plan = introBridge.planIntroBridge({
    introStartMs: 0,
    firstVocalMs: 8000,
    barMs: BAR,
    targetMs: 120_000,
  });
  assert.ok(plan);
  assert.ok(plan.passes <= introBridge.INTRO_MAX_PASSES, `实为 ${plan.passes}`);
});

test('优先用宿主给的 loopUnit（结构重复段）当循环单元', () => {
  const plan = introBridge.planIntroBridge({
    introStartMs: 0,
    firstVocalMs: 24_000,
    barMs: BAR,
    targetMs: 40_000,
    loopUnits: [
      { startMs: 8000, endMs: 16_000, bars: 4, score: 0.95 },
      { startMs: 0, endMs: 4000, bars: 2, score: 0.4 },
    ],
  });
  assert.ok(plan);
  assert.equal(plan.loopStartFileMs, 8000);
  assert.equal(plan.unitBars, 4);
});

test('loopUnit 跨到唱词之后时被剔除，退化到前奏开头', () => {
  const plan = introBridge.planIntroBridge({
    introStartMs: 0,
    firstVocalMs: 12_000,
    barMs: BAR,
    targetMs: 24_000,
    loopUnits: [{ startMs: 8000, endMs: 16_000, bars: 4, score: 0.99 }],
  });
  assert.ok(plan);
  assert.notEqual(plan.loopStartFileMs, 8000, '跨过唱词的单元不能用');
  assert.equal(plan.loopStartFileMs, 0);
});

test('调性：B 比 A 低 2 个半音就往上移 2；差 10 个半音按环上最近方向移 −2', () => {
  assert.equal(pitchShift.semitonesForBridge(0, 2), 2);
  assert.equal(pitchShift.semitonesForBridge(0, 10), -2);
  assert.equal(pitchShift.semitonesForBridge(0, 6), -6); // 三全音取向下
  assert.equal(pitchShift.semitonesForBridge(-1, 3), 0);
  assert.equal(pitchShift.semitonesForBridge(0, 3), 3);
});

test('变速播放时移调量要补回速率带来的音高偏移', () => {
  // rate 1.06 → 12·log2(1.06) ≈ 1.0 半音，base 0 → 需要 −1
  const plan = introBridge.planIntroBridge({
    introStartMs: 0,
    firstVocalMs: 16_000,
    barMs: BAR,
    targetMs: 32_000,
    playbackRate: 1.06,
  });
  assert.ok(plan);
  assert.ok(plan.semitones <= -0.8 && plan.semitones >= -1.2, `实为 ${plan.semitones}`);
  assert.ok(plan.bufferMs > plan.delayMs, 'buffer 要按元素同速播放，材料时长 = 墙钟 × rate');
});

test('移调量被夹在 ±6 半音', () => {
  const plan = introBridge.planIntroBridge({
    introStartMs: 0,
    firstVocalMs: 16_000,
    barMs: BAR,
    targetMs: 32_000,
    keyFrom: 0,
    keyTo: 5,
  });
  assert.ok(plan);
  assert.ok(Math.abs(plan.semitones) <= 6);
});

test('唱词均衡时间：取句间间隔中位数，且不超过一个乐句', () => {
  const segments = [
    { startMs: 0, endMs: 2000 },
    { startMs: 3000, endMs: 5000 },
    { startMs: 7000, endMs: 9000 },
  ];
  assert.equal(introBridge.vocalGapMs(segments, 8000), 1500); // gaps = 1000 / 2000，偶数取中位
  assert.equal(introBridge.vocalGapMs(segments.slice(0, 1), 3000), 3000);
  assert.equal(introBridge.vocalGapMs([], 3000), 0);
  // 长间奏（20 s）被一个乐句上限压住
  assert.equal(
    introBridge.vocalGapMs([{ startMs: 0, endMs: 1000 }, { startMs: 21_000, endMs: 22_000 }], 4000),
    4000,
  );
});

test('firstVocalMsOf：从 activity.vocal 找到第一个超阈值的点', () => {
  const analysis = {
    cueInMs: 500,
    activity: { hopMs: 250, vocal: [0, 0, 0.2, 0.6, 0.7], drum: [], bass: [] },
  };
  // activity 曲线是文件时间，不加 cueInMs（cueInMs 是「从哪开始播」的建议点）
  assert.equal(introBridge.firstVocalMsOf(analysis), 3 * 250);
  assert.equal(introBridge.firstVocalMsOf({ activity: { hopMs: 250, vocal: [0, 0], drum: [], bass: [] } }), 0);
  assert.equal(introBridge.firstVocalMsOf(undefined), 0);
});

test('移调：0 半音原样返回，长度不变，能量量级保持', () => {
  const length = 8192;
  const input = new Float32Array(length);
  for (let i = 0; i < length; i += 1) input[i] = Math.sin((2 * Math.PI * i) / 64) * 0.5;
  const same = pitchShift.shiftPitchMono(input, 48_000, 0);
  assert.equal(same.length, length);
  assert.equal(same[100], input[100]);

  const shifted = pitchShift.shiftPitchMono(input, 48_000, 2);
  assert.equal(shifted.length, length);
  let rmsIn = 0;
  let rmsOut = 0;
  for (let i = 0; i < length; i += 1) {
    rmsIn += input[i] * input[i];
    rmsOut += shifted[i] * shifted[i];
  }
  const ratio = Math.sqrt(rmsOut / rmsIn);
  assert.ok(ratio > 0.6 && ratio < 1.5, `移调后能量比应在 0.6–1.5，实为 ${ratio.toFixed(2)}`);
});
