// 标准等功率过渡的黄金值回归（C0）。
//
// 进阶过渡是可选模式，标准路径必须逐点冻结：这里把 `naturalGains` 在固定进度点上的
// 输出写成字面量断言，任何人改动公式（哪怕「看起来等价」的重写）都会失败。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTs(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const ctx = vm.createContext({ module, exports: module.exports, require: () => ({}), console });
  vm.runInContext(js, ctx);
  return module.exports;
}

const math = loadTs('src/ui/transitionMath.ts');
const EPS = 1e-12;

// 黄金值：progress → [gainA, gainB]（overlapEnd = 1）
const GOLDEN = [
  [-0.5, [1, 0]],
  [0, [1, 0]],
  [0.25, [0.9238795325112867, 0.3826834323650898]],
  [0.5, [0.7071067811865476, 0.7071067811865476]],
  [0.75, [0.38268343236508984, 0.9238795325112867]],
  [1, [0, 1]],
  [1.5, [0, 1]],
];

test('naturalGains 黄金值：标准等功率曲线逐点冻结', () => {
  for (const [progress, expected] of GOLDEN) {
    const [a, b] = math.naturalGains(progress);
    assert.ok(Math.abs(a - expected[0]) < EPS, `p=${progress} A: ${a} ≠ ${expected[0]}`);
    assert.ok(Math.abs(b - expected[1]) < EPS, `p=${progress} B: ${b} ≠ ${expected[1]}`);
  }
});

test('naturalGains 黄金值：overlapEnd 归一化（0.82 是匹配过渡的默认终点）', () => {
  assert.equal(math.MATCHED_OVERLAP_END, 0.82);
  const half = math.naturalGains(0.41, math.MATCHED_OVERLAP_END);
  assert.ok(Math.abs(half[0] - 0.7071067811865476) < EPS);
  assert.ok(Math.abs(half[1] - 0.7071067811865476) < EPS);
  const end = math.naturalGains(0.82, math.MATCHED_OVERLAP_END);
  assert.ok(Math.abs(end[0] - 0) < EPS);
  assert.ok(Math.abs(end[1] - 1) < EPS);
});

test('naturalGains 功率守恒：任意进度 a²+b²=1（±1e-12）', () => {
  for (let i = 0; i <= 200; i++) {
    const p = i / 200;
    const [a, b] = math.naturalGains(p);
    assert.ok(Math.abs(a * a + b * b - 1) < EPS, `p=${p} 功率 ${a * a + b * b}`);
  }
});

test('naturalGains 单调：A 不增、B 不减', () => {
  let prev = math.naturalGains(0);
  for (let i = 1; i <= 200; i++) {
    const cur = math.naturalGains(i / 200);
    assert.ok(cur[0] <= prev[0] + EPS, `A 在 ${i / 200} 处上升了`);
    assert.ok(cur[1] >= prev[1] - EPS, `B 在 ${i / 200} 处下降了`);
    prev = cur;
  }
});

test('smoothProgress / nearestTempoRatio 黄金值', () => {
  assert.equal(math.smoothProgress(-1), 0);
  assert.equal(math.smoothProgress(0.5), 0.5);
  assert.equal(math.smoothProgress(2), 1);
  assert.ok(Math.abs(math.smoothProgress(0.25) - 0.15625) < EPS);
  assert.equal(math.nearestTempoRatio(1.5), 0.75);
  assert.equal(math.nearestTempoRatio(0.667), 1.334);
  assert.equal(math.nearestTempoRatio(2), 1);
  assert.equal(math.nearestTempoRatio(0), 1);
  assert.equal(math.nearestTempoRatio(NaN), 1);
});
