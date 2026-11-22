'use strict';
/**
 * 尾段渐隐识别 + 补回曲线。
 *
 * 这组函数决定「过渡要不要把 A 的母带 fade-out 抬回来」，判错两个方向都难听：
 * 误判 → 把正常收尾的歌硬抬成爆音；漏判 → 拿渐隐中那几秒接 B，B 一进来就炸。
 * 所以每条门槛（降幅、时长、削波上限）都钉一个断言。
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
      console,
      Math,
      Number,
      Array,
      Object,
      JSON,
      String,
      Boolean,
      Error,
      isFinite,
      setTimeout,
      clearTimeout,
    };
    vm.runInNewContext(js, sandbox, { filename: file });
    return module.exports;
  };
  const out = {};
  for (const [name, file] of Object.entries(entries)) out[name] = load(path.join(root, file));
  return out;
}

const { tailFade } = loadModules({ tailFade: 'src/core/automix/tailFade.ts' });

const STEP = 100;

/**
 * 造一条 momentary loudness 曲线。
 * `shape(t)` 收到「相对结尾的秒数」（0 = 结尾），返回该点 LUFS。
 */
function analysis(durationSec, shape, extra = {}) {
  const times = [];
  const levels = [];
  const total = Math.round((durationSec * 1000) / STEP);
  for (let i = 0; i <= total; i += 1) {
    const ms = i * STEP;
    times.push(ms);
    levels.push(shape((durationSec * 1000 - ms) / 1000));
  }
  return {
    durationMs: durationSec * 1000,
    audibleEndMs: durationSec * 1000,
    loudnessMethod: 'bs1770',
    loudnessTimesMs: times,
    momentaryLufs: levels,
    ...extra,
  };
}

/** 标准母带渐隐：最后 12 秒从 −9 LUFS 线性掉到 −30 LUFS。 */
function fading(seconds = 12, from = -9, to = -30) {
  return analysis(90, (left) => (left <= seconds ? from + ((to - from) * (seconds - left)) / seconds : from));
}

test('识别典型母带渐隐：起点、终点、降幅、最大提升', () => {
  const info = tailFade.detectTailFade(fading());
  assert.ok(info, '应当识别为渐隐');
  assert.ok(Math.abs(info.fadeStartMs - 78_000) <= 300, `渐隐起点应≈78s，实为 ${info.fadeStartMs}`);
  assert.ok(info.fadeEndMs >= 89_000, `渐隐终点应贴结尾，实为 ${info.fadeEndMs}`);
  assert.ok(info.dropDb >= 15 && info.dropDb <= 22, `降幅应≈19–21dB，实为 ${info.dropDb}`);
  assert.ok(info.maxLiftDb > 0 && info.maxLiftDb <= 12, `提升应在 (0,12]，实为 ${info.maxLiftDb}`);
  assert.equal(info.points.length >= 3, true, '补回曲线至少 3 个点');
});

test('正常收尾（没有渐隐）返回 null', () => {
  const flat = analysis(90, () => -9);
  assert.equal(tailFade.detectTailFade(flat), null);
});

test('降幅不足 6 dB 不算渐隐', () => {
  // 10 秒只掉 5 dB：更像压缩器/淡出前奏，不值得抬回来
  const shallow = analysis(90, (left) => (left <= 10 ? -9 - 5 * ((10 - left) / 10) : -9));
  assert.equal(tailFade.detectTailFade(shallow), null);
});

test('渐隐太短（< 4 秒）不算渐隐', () => {
  const brief = analysis(90, (left) => (left <= 2 ? -9 - 80 * ((2 - left) / 2) : -9));
  assert.equal(tailFade.detectTailFade(brief), null);
});

test('LoudnessMeter 缺失或非 bs1770 时放弃', () => {
  assert.equal(tailFade.detectTailFade({ audibleEndMs: 90_000 }), null);
  const noMethod = analysis(90, (left) => (left <= 12 ? -9 - 21 * ((12 - left) / 12) : -9), {
    loudnessMethod: undefined,
  });
  assert.equal(tailFade.detectTailFade(noMethod), null);
});

test('采样点太少时放弃', () => {
  const sparse = {
    audibleEndMs: 90_000,
    loudnessMethod: 'bs1770',
    loudnessTimesMs: [0, 1000, 2000],
    momentaryLufs: [-9, -9, -9],
  };
  assert.equal(tailFade.detectTailFade(sparse), null);
});

test('母线很响时补回受 −1 LUFS 削波上限约束', () => {
  // ref = −0.5 LUFS、尾端 −8 LUFS：按「补回参考电平」要抬 7.5 dB，被 −1 LUFS 上限压到 7 dB
  const hot = analysis(90, (left) => (left <= 12 ? -0.5 + ((-8 - -0.5) * (12 - left)) / 12 : -0.5));
  const info = tailFade.detectTailFade(hot);
  assert.ok(info, '应当识别为渐隐');
  assert.ok(info.maxLiftDb <= 7.05, `提升应受 −1 LUFS 封顶约束（≤7.05），实为 ${info.maxLiftDb}`);
  assert.ok(info.maxLiftDb >= 6.5, `也不该比封顶值小太多，实为 ${info.maxLiftDb}`);
});

test('普通母线：12 dB 上限先起作用，抬完仍远低于削波', () => {
  const info = tailFade.detectTailFade(fading());
  assert.ok(info);
  assert.ok(Math.abs(info.maxLiftDb - 12) < 0.2, `应被 12 dB 上限夹住，实为 ${info.maxLiftDb}`);
  // 尾端 −28 抬 12 dB 到 −16，离 −1 还远：这条断言的目的是钉住「不许无限抬」
  assert.ok(info.endLufs + info.maxLiftDb <= -1, `抬完 ${(info.endLufs + info.maxLiftDb).toFixed(2)} LUFS 越线`);
});

test('参考电平很低时靠 12 dB 上限兜住', () => {
  const info = tailFade.detectTailFade(fading(12, -45, -55));
  if (info) assert.ok(info.maxLiftDb <= 12.001, `实为 ${info.maxLiftDb}`);
});

test('只看到 beforeMs 之前的数据', () => {
  const long = analysis(180, (left) => (left <= 100 ? -9 : -9));
  // 前 90 秒平坦、后 90 秒才有渐隐：把探测点放在 90 秒处必须判成「没渐隐」
  assert.equal(tailFade.detectTailFade(long, 90_000), null);
});

test('liftAt 做线性插值并夹住两端', () => {
  const points = [
    { ms: 0, liftDb: 0 },
    { ms: 1000, liftDb: 8 },
    { ms: 2000, liftDb: 4 },
  ];
  assert.equal(tailFade.liftAt(points, -500), 0);
  assert.equal(tailFade.liftAt(points, 0), 0);
  assert.equal(tailFade.liftAt(points, 500), 4);
  assert.equal(tailFade.liftAt(points, 1000), 8);
  assert.equal(tailFade.liftAt(points, 1500), 6);
  assert.equal(tailFade.liftAt(points, 9999), 4);
});

test('clipLift 裁到窗口并在两端补点', () => {
  const points = [
    { ms: 0, liftDb: 2 },
    { ms: 1000, liftDb: 6 },
    { ms: 2000, liftDb: 10 },
    { ms: 3000, liftDb: 12 },
  ];
  const clipped = tailFade.clipLift(points, 500, 2500);
  assert.equal(clipped[0].ms, 500);
  assert.ok(Math.abs(clipped[0].liftDb - 4) < 0.001, `起点应插值成 4，实为 ${clipped[0].liftDb}`);
  assert.equal(clipped[clipped.length - 1].ms, 2500);
  assert.ok(Math.abs(clipped[clipped.length - 1].liftDb - 11) < 0.001);
});

test('clipLift 窗口落在曲线之外时给恒定值', () => {
  const points = [
    { ms: 0, liftDb: 5 },
    { ms: 1000, liftDb: 9 },
  ];
  const after = tailFade.clipLift(points, 5000, 8000);
  assert.equal(after[0].liftDb, 9);
  assert.equal(after[after.length - 1].liftDb, 9);
  const before = tailFade.clipLift(points, -3000, -1000);
  assert.equal(before[0].liftDb, 5);
});

test('非法窗口返回空数组', () => {
  const points = [{ ms: 0, liftDb: 3 }];
  assert.equal(tailFade.clipLift(points, 1000, 1000).length, 0);
  assert.equal(tailFade.clipLift([], 0, 1000).length, 0);
});
