// Run with: node --test web/tests/automixV2.test.cjs
// 进阶混音 v2 曲线：低频换手不叠、高频等功率、扫频范围与边界。纯函数，无 DOM。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function loadV2Plan() {
  const file = path.join(ROOT, 'src/core/automix/v2Plan.ts');
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { exports, console, require: () => ({}) },
    { filename: file },
  );
  return exports;
}

function loadExports(rel) {
  const file = path.join(ROOT, rel);
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { exports, console, require: () => ({}) },
    { filename: file },
  );
  return exports;
}

const mod = loadV2Plan();
const mod2 = loadExports('src/core/automix/v2Quality.ts');
const PLAN = mod.buildV2Plan({ fadeMs: 20000, barMs: 2500 });

test('默认 8 小节、低频换手落在过渡中段', () => {
  assert.equal(PLAN.totalBars, 8);
  assert.ok(PLAN.handoffP > 0.3 && PLAN.handoffP < 0.6, `handoffP=${PLAN.handoffP}`);
  assert.ok(PLAN.handoffStartP < PLAN.handoffP, '换手窗口起点必须在终点之前');
  assert.ok(PLAN.handoffP - PLAN.handoffStartP <= 0.26, '换手窗口不该超过一个乐句');
  assert.equal(PLAN.a.low[0].t, 0);
  assert.equal(PLAN.a.low[PLAN.a.low.length - 1].t, 1);
});

test('低频换手：两侧增益之和恒为 1（同一时刻只有一首持有低频）', () => {
  for (let p = 0; p <= 1.0001; p += 0.01) {
    const a = mod.sampleCurve(PLAN.a.low, p);
    const b = mod.sampleCurve(PLAN.b.low, p);
    assert.ok(Math.abs(a + b - 1) < 1e-6, `p=${p.toFixed(2)} a+b=${a + b}`);
  }
});

test('低频功率和全程不超过 0 dB，交叠中点约 −3 dB', () => {
  let worst = -Infinity;
  for (let p = 0; p <= 1.0001; p += 0.01) {
    worst = Math.max(worst, mod.lowBumpDb(p, PLAN.handoffStartP, PLAN.handoffP));
  }
  assert.ok(worst <= 1e-9, `峰值 ${worst} dB 超过 0 dB`);
  const mid = mod.lowBumpDb((PLAN.handoffStartP + PLAN.handoffP) / 2, PLAN.handoffStartP, PLAN.handoffP);
  assert.ok(Math.abs(mid + 3.0103) < 0.02, `中点 ${mid} dB`);
});

test('高频等功率：两侧平方和恒为 1', () => {
  for (let p = 0; p <= 1.0001; p += 0.01) {
    const a = mod.sampleCurve(PLAN.a.high, p);
    const b = mod.sampleCurve(PLAN.b.high, p);
    assert.ok(Math.abs(a * a + b * b - 1) < 1e-4, `p=${p.toFixed(2)} 平方和=${a * a + b * b}`);
  }
});

test('扫频：A 低通只降不升且在 700 Hz 收尾，A 高通不动', () => {
  let prev = Infinity;
  for (let p = 0; p <= 1.0001; p += 0.01) {
    const lp = mod.sampleCurve(PLAN.a.sweepLp, p);
    assert.ok(lp <= prev + 1e-6, `p=${p.toFixed(2)} 低通回升`);
    assert.ok(lp >= 700 - 1e-6 && lp <= 20000 + 1e-6, `溢出：${lp}`);
    prev = lp;
  }
  assert.ok(Math.abs(mod.sampleCurve(PLAN.a.sweepLp, 1) - 700) < 1);
  assert.equal(mod.sampleCurve(PLAN.a.sweepHp, 0), 20);
  assert.equal(mod.sampleCurve(PLAN.a.sweepHp, 1), 20);
});

test('扫频：B 高通从 12 kHz 单调开到 20 Hz', () => {
  let prev = Infinity;
  for (let p = 0; p <= 1.0001; p += 0.01) {
    const hp = mod.sampleCurve(PLAN.b.sweepHp, p);
    assert.ok(hp <= prev + 1e-6, `p=${p.toFixed(2)} 高通回升`);
    prev = hp;
  }
  assert.equal(mod.sampleCurve(PLAN.b.sweepHp, 0), 12000);
  assert.equal(mod.sampleCurve(PLAN.b.sweepHp, 1), 20);
});

test('对数扫频：几何中点应落在中段', () => {
  const mid = mod.logSweep(20000, 700, 0.5);
  assert.ok(Math.abs(mid - Math.sqrt(20000 * 700)) < 1, `mid=${mid}`);
  assert.equal(mod.logSweep(20000, 700, 0), 20000);
  assert.ok(Math.abs(mod.logSweep(20000, 700, 1) - 700) < 1e-6);
});

test('极短过渡也不越界：2 小节时换手被夹在 1 小节', () => {
  const short = mod.buildV2Plan({ fadeMs: 4000, barMs: 2000 });
  assert.equal(short.totalBars, 2);
  assert.ok(short.handoffP <= 0.6);
  assert.ok(short.handoffStartP < short.handoffP);
});

test('缺参/非法参不抛，回落到 4 小节默认', () => {
  const fallback = mod.buildV2Plan({ fadeMs: 0, barMs: 0 });
  assert.equal(fallback.totalBars, 4);
  assert.ok(fallback.a.low.length >= 2);
});

// ---- 最短混音窗口：A 保持段 / 低频换手让过 A 的末句 ----
test('A 保持段：aHoldP 之前 A 的高频保持 1，B 只 ≤ −15 dB 垫底', () => {
  const plan = mod.buildV2Plan({ fadeMs: 12000, barMs: 2000, aHoldP: 0.6, rate: 1 });
  const aHigh = mod.sampleCurve(plan.a.high, 0.3);
  const bHigh = mod.sampleCurve(plan.b.high, 0.3);
  assert.equal(Math.round(aHigh * 100), 100);
  assert.ok(bHigh <= 0.181, `B 高频应 ≤0.18，实际 ${bHigh}`);
});

test('A 保持段：hold 之后仍收敛到 0，B 收敛到 1（不断崖）', () => {
  const plan = mod.buildV2Plan({ fadeMs: 12000, barMs: 2000, aHoldP: 0.6, rate: 1 });
  assert.ok(mod.sampleCurve(plan.a.high, 1) < 0.02);
  assert.ok(mod.sampleCurve(plan.b.high, 1) > 0.98);
});

test('低频换手中心可上移：center 生效且窗口 = [center−span, center]', () => {
  const base = mod.buildV2Plan({ fadeMs: 12000, barMs: 2000, lowHandoffBars: 2 });
  const late = mod.buildV2Plan({
    fadeMs: 12000,
    barMs: 2000,
    lowHandoffBars: 2,
    handoffCenterP: 0.75,
  });
  assert.ok(Math.abs(late.handoffP - 0.75) < 0.011, `center 应被采纳，实际 ${late.handoffP}`);
  assert.ok(late.handoffStartP > base.handoffStartP, 'center 上移后换手起点必须随之推后');
});

test('低频换手起点可显式指定：handoffStartP 落在 A 末句之后，窗口按 span 往后铺', () => {
  const vocalEndP = 0.6;
  const plan = mod.buildV2Plan({
    fadeMs: 12000,
    barMs: 2000,
    lowHandoffBars: 2,
    handoffStartP: vocalEndP,
  });
  assert.ok(plan.handoffStartP >= vocalEndP - 1e-6, `换手起点 ${plan.handoffStartP} 应 ≥ ${vocalEndP}`);
  assert.ok(plan.handoffP > plan.handoffStartP, '窗口终点必须在起点之后');
  assert.ok(plan.handoffP <= 0.97);
});

test('A 保持段不影响低频换手的功率守恒（A+B 低频恒 1）', () => {
  const plan = mod.buildV2Plan({ fadeMs: 12000, barMs: 2000, aHoldP: 0.7, rate: 1 });
  for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const sum = mod.sampleCurve(plan.a.low, p) + mod.sampleCurve(plan.b.low, p);
    assert.ok(Math.abs(sum - 1) < 0.02, `p=${p} 低频和 ${sum}`);
  }
});

test('换手必须发生在 B 全频之后：HP 还在高频时换手 = 下盘空一块', () => {
  const plan = mod.buildV2Plan({ fadeMs: 16000, barMs: 2000, sweep: true });
  // B 的高通扫到 20 Hz 的那一点（bOpenP）必须 ≤ 换手起点
  const atHandoffStart = mod.sampleCurve(plan.b.sweepHp, plan.handoffStartP);
  assert.ok(atHandoffStart <= 25, `换手起点处 B 高通应已落到 20Hz，实为 ${atHandoffStart}Hz`);
});

test('A 的扫频在换手完成之后才开始（换手期间 A 保持全频）', () => {
  const plan = mod.buildV2Plan({ fadeMs: 16000, barMs: 2000, sweep: true });
  const atHandoffEnd = mod.sampleCurve(plan.a.sweepLp, plan.handoffP);
  assert.ok(atHandoffEnd >= 19000, `换手结束时 A 仍应基本全频，实为 ${atHandoffEnd}Hz`);
  const later = mod.sampleCurve(plan.a.sweepLp, Math.min(1, plan.handoffP + 0.2));
  assert.ok(later < atHandoffEnd, '换手结束后 A 才开始变闷');
});

test('B 前奏渐入：默认关闭（bEntry 未传时 B 侧仍是等功率）', () => {
  const plan = mod.buildV2Plan({ fadeMs: 16_000, barMs: 2_000 });
  const mid = mod.sampleCurve(plan.b.high, 0.5);
  assert.ok(mid > 0.6 && mid < 0.75, `等功率中点应约 0.707，实际 ${mid}`);
});

test('B 前奏渐入：bEntry 打开后整条 B 被压低，90% 处回到等功率', () => {
  const plain = mod.buildV2Plan({ fadeMs: 18_000, barMs: 2_000 });
  const entry = mod.buildV2Plan({ fadeMs: 18_000, barMs: 2_000, bEntry: true });
  // 中点：等功率 0.707 → 乘 -18 dB 渐入后约 0.45（≈ -7 dB）
  const plainMid = mod.sampleCurve(plain.b.high, 0.5);
  const entryMid = mod.sampleCurve(entry.b.high, 0.5);
  assert.ok(entryMid < plainMid * 0.75, `中点应明显更低：${entryMid} vs ${plainMid}`);
  // 90% 之后与不渐入完全一致（0.9 处 smoothstep 已到 1）
  assert.ok(Math.abs(mod.sampleCurve(entry.b.high, 0.95) - mod.sampleCurve(plain.b.high, 0.95)) < 1e-6);
  assert.ok(mod.sampleCurve(entry.b.high, 1) > 0.999);
  // 单调不减
  let prev = -1;
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const v = mod.sampleCurve(entry.b.high, p);
    assert.ok(v >= prev - 1e-6, `p=${p.toFixed(2)} 处回落：${prev} → ${v}`);
    prev = v;
  }
  // A 侧不受影响
  assert.ok(Math.abs(mod.sampleCurve(entry.a.high, 0) - 1) < 1e-6);
});

test('人声让位：B 的开唱点之前一律不许压 A（m03403 回归）', () => {
  // 前奏在第 2 秒有 0.57 的假峰，真开唱在 18.25 s
  const vocal = new Array(160).fill(0.12);
  vocal[8] = 0.57;
  vocal[9] = 0.56;
  for (let i = 73; i < 90; i += 1) vocal[i] = 0.78;
  const b = { activity: { hopMs: 250, vocal, drum: [], bass: [] } };
  const gated = mod2.buildDuckEvents({
    b,
    fadeStartBMs: 0,
    fadeMs: 18_000,
    tempoRate: 1,
    gateBeforeMs: 18_250,
  });
  assert.equal(Math.min(...gated.map((e) => e.db)), 0);
  // 没有门的时候会立刻压下去（这正是「一进过渡就像加了低音」的来源）
  const raw = mod2.buildDuckEvents({ b, fadeStartBMs: 0, fadeMs: 18_000, tempoRate: 1 });
  assert.ok(Math.min(...raw.map((e) => e.db)) < -3);
});

test('人声让位：A 是器乐时深度减半', () => {
  const vocal = new Array(160).fill(0.9);
  const b = { activity: { hopMs: 250, vocal, drum: [], bass: [] } };
  const vocalA = mod2.buildDuckEvents({ b, fadeStartBMs: 0, fadeMs: 4_000, tempoRate: 1 });
  const instA = mod2.buildDuckEvents({
    b,
    fadeStartBMs: 0,
    fadeMs: 4_000,
    tempoRate: 1,
    aInstrumental: true,
  });
  assert.ok(Math.min(...vocalA.map((e) => e.db)) <= -5.5);
  assert.ok(Math.min(...instA.map((e) => e.db)) >= -3.5);
});

test('18 秒前奏：前 14 秒保留 A，低频互补，换手完成才压 A 低通', () => {
  const plan = mod.buildV2Plan({ fadeMs: 18000, barMs: 2000, swapShare: 4/18, bEntry: true });
  assert.ok(Math.abs(mod.sampleCurve(plan.b.high, 0) - 10 ** (-18/20)) < 0.00001);
  for (let i = 0; i <= 200; i++) {
    const p = i/200;
    assert.ok(Math.abs(mod.sampleCurve(plan.a.low,p) + mod.sampleCurve(plan.b.low,p) - 1) < 0.00002);
    if (p < plan.swapStartP - plan.step) assert.equal(mod.sampleCurve(plan.a.high,p),1);
    if (p < plan.handoffP - plan.step) assert.equal(mod.sampleCurve(plan.a.sweepLp,p),20000);
  }
  assert.equal(mod.sampleCurve(plan.b.high,1),1);
});

test('Apple 配方可以改扫频目标：A 压到 200 Hz、B 从 5200 Hz 起', () => {
  const plan = mod.buildV2Plan({ fadeMs: 16000, barMs: 2000, sweep: true, lpMinHz: 200, bHpStartHz: 5200 });
  assert.equal(mod.sampleCurve(plan.a.sweepLp, 1), 200);
  assert.equal(mod.sampleCurve(plan.b.sweepHp, 0), 5200);
  // 末端仍要收到底（B 高通不能停在 5.2k，否则下盘永远空着）
  assert.equal(mod.sampleCurve(plan.b.sweepHp, 1), 20);
});

test('未给目标频率时保持 700 Hz / 12 kHz 的默认值', () => {
  const plan = mod.buildV2Plan({ fadeMs: 16000, barMs: 2000, sweep: true });
  assert.equal(mod.sampleCurve(plan.a.sweepLp, 1), 700);
  assert.equal(mod.sampleCurve(plan.b.sweepHp, 0), 12000);
});

test('三层错开换手：中低先换、高频其次、低频最后（各层自己混自己的）', () => {
  const plan = mod.buildV2Plan({ fadeMs: 12000, barMs: 2000, swapShare: 0.3, rate: 1, bEntry: false });
  // 每一层「B 达到 0.5」的位置
  const cross = (curve) => {
    for (let p = 0; p <= 1.0001; p += 0.01) {
      if (mod.sampleCurve(curve, Math.min(1, p)) >= 0.5) return p;
    }
    return 1;
  };
  const mid = cross(plan.b.mid);
  const high = cross(plan.b.high);
  const low = cross(plan.b.low);
  assert.ok(mid < high, `中低应先于高频换手（mid ${mid} / high ${high}）`);
  assert.ok(high < low, `高频应先于低频换手（high ${high} / low ${low}）`);
  // 三层的交接点是三个不同的时刻，不是同一瞬间
  assert.ok(low - mid > 0.04, `三层交接至少拉开 4% 窗口（实际 ${(low - mid).toFixed(2)}）`);
});

test('每层各自功率守恒：A² + B² = 1（中低/高频）', () => {
  const plan = mod.buildV2Plan({ fadeMs: 12000, barMs: 2000, swapShare: 0.3, rate: 1, bEntry: false });
  for (const p of [0.76, 0.8, 0.84, 0.88, 0.92]) {
    for (const band of ['mid', 'high']) {
      const a = mod.sampleCurve(plan.a[band], p);
      const b = mod.sampleCurve(plan.b[band], p);
      const sum = a * a + b * b;
      assert.ok(Math.abs(sum - 1) < 0.08, `${band} 在 p=${p} 功率和 ${sum.toFixed(3)}`);
    }
  }
});
