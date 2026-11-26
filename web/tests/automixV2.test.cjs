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
  // 没有门时会压下去（起压已改成 420 ms 缓坡，深度也跟着 B 的强度走）
  const raw = mod2.buildDuckEvents({ b, fadeStartBMs: 0, fadeMs: 18_000, tempoRate: 1 });
  assert.ok(Math.min(...raw.map((e) => e.db)) < -1.5);
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

test('人声让位：跟着 B 走，A 静音时只轻收，深度封顶 3.5 dB', () => {
  const vocalB = new Array(160).fill(0.9);
  const b = { activity: { hopMs: 250, vocal: vocalB, drum: [], bass: [] } };
  // A 也在唱 → 有让位，但最深不超过 3.5 dB
  const aSing = { activity: { hopMs: 250, vocal: new Array(160).fill(0.9), drum: [], bass: [] } };
  const got = mod2.buildDuckEvents({
    a: aSing, fadeStartAMs: 0, b, fadeStartBMs: 0, fadeMs: 6_000, tempoRate: 1, maxDuckDb: -3.5,
  });
  const low = Math.min(...got.map((e) => e.db));
  assert.ok(low <= -2.5, `两边都在唱时应该让位：${low}`);
  assert.ok(low >= -3.55, `深度不该超过 3.5 dB：${low}`);
  // A 是静音 → 只按 30% 深度轻收（不再完全不压，也不再压到底）
  const aQuiet = { activity: { hopMs: 250, vocal: new Array(160).fill(0), drum: [], bass: [] } };
  const quietA = mod2.buildDuckEvents({
    a: aQuiet, fadeStartAMs: 0, b, fadeStartBMs: 0, fadeMs: 6_000, tempoRate: 1, maxDuckDb: -3.5,
  });
  const quietDepth = Math.min(...quietA.map((e) => e.db));
  assert.ok(quietDepth > -2 && quietDepth < -0.5, `A 静音时深度不对：${quietDepth}`);
});

test('人声让位：收尾前自己放平，不留「过渡完成瞬间突然松手」的缺口', () => {
  const vocal = new Array(160).fill(0.9);
  const b = { activity: { hopMs: 250, vocal, drum: [], bass: [] } };
  const aSing = { activity: { hopMs: 250, vocal: new Array(160).fill(0.9), drum: [], bass: [] } };
  const got = mod2.buildDuckEvents({
    a: aSing, fadeStartAMs: 0, b, fadeStartBMs: 0, fadeMs: 8_000, tempoRate: 1, maxDuckDb: -3.5,
  });
  assert.ok(Math.min(...got.map((e) => e.db)) <= -2.5);
  // 最后 15% 必须已经回到中性：收尾靠的不是旁路，而是曲线自己松开（release 140 ms）。
  const tail = got.filter((e) => e.offsetMs > 8_000 * 0.85);
  assert.ok(tail.length > 0);
  const worst = Math.min(...tail.map((e) => e.db));
    assert.ok(worst > -0.35, `收尾仍在压：${worst} dB`);
  // 窗口最后一点必须正好是 0 dB
  assert.ok(Math.abs(got[got.length - 1].db) < 0.2, `末尾未归零：${got[got.length - 1].db}`);
});

test('18 秒前奏：前 30% 保留 A，30–50% 只换低频，80% 后才动人声', () => {
  const plan = mod.buildV2Plan({ fadeMs: 18000, barMs: 2000, swapShare: 4/18, bEntry: true });
  // 进入过渡时 B 的未触发频段必须是绝对静音，不再有 −18 dB 的前奏垫音
  assert.equal(mod.sampleCurve(plan.b.high, 0), 0);
  assert.equal(mod.sampleCurve(plan.b.low, 0), 0);
  assert.equal(mod.sampleCurve(plan.b.mid, 0.29), 0);
  // 30% 之前：A 的低/中/高频都在原位
  assert.equal(mod.sampleCurve(plan.a.low, 0.29), 1);
  assert.equal(mod.sampleCurve(plan.a.mid, 0.29), 1);
  assert.equal(mod.sampleCurve(plan.a.high, 0.29), 1);
  // 50%：B 低频到 50–70%，A 低频只削到 55–65%
  const bLow = mod.sampleCurve(plan.b.low, 0.5);
  const aLow = mod.sampleCurve(plan.a.low, 0.5);
  assert.ok(bLow >= 0.5 && bLow <= 0.7, `B 低频 ${bLow}`);
  assert.ok(aLow >= 0.55 && aLow <= 0.65, `A 低频 ${aLow}`);
  // 50%：B 中频约 20%，A 中频仍是 1
  assert.ok(mod.sampleCurve(plan.b.mid, 0.56) < 0.01);
  assert.equal(mod.sampleCurve(plan.a.mid, 0.56), 1);
  assert.ok(mod.sampleCurve(plan.b.mid, 0.7) > 0.05);
  // 80% 之后人声交换：A 中频开始收，B 中频抬过 0.5
  // 交换放宽后 A 在 90% 仍留大半，窗口最末才归零
  assert.ok(mod.sampleCurve(plan.a.mid, 0.9) > 0.6);
  assert.ok(mod.sampleCurve(plan.a.mid, 0.98) < 0.3);
  assert.ok(mod.sampleCurve(plan.b.mid, 0.9) > 0.4);
  // 收尾全部回原水平：A 各层 0、B 各层 1
  assert.equal(mod.sampleCurve(plan.a.low, 1), 0);
  assert.equal(mod.sampleCurve(plan.b.low, 1), 1);
  assert.equal(mod.sampleCurve(plan.b.mid, 1), 1);
  assert.equal(mod.sampleCurve(plan.b.high, 1), 1);
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

test('30/50/80：低频先到 0.5、中频 50% 才以 0.2 进入、人声 80% 后才换', () => {
  const plan = mod.buildV2Plan({ fadeMs: 12000, barMs: 2000, swapShare: 0.3, rate: 1, bEntry: false });
  const at = (curve, p) => mod.sampleCurve(curve, p);
  // 低频：30% 起步、50% 到目标
  assert.equal(at(plan.b.low, 0.29), 0);
  assert.ok(at(plan.b.low, 0.5) >= 0.5 && at(plan.b.low, 0.5) <= 0.7);
  // 中频：50% 之前是 0，56% 左右到 0.2，80% 之前一直 0.2
  assert.ok(at(plan.b.mid, 0.45) < 0.01);
  assert.ok(at(plan.b.low, 0.75) > 0.7 && at(plan.b.low, 0.75) < 0.9);
  assert.ok(at(plan.b.mid, 0.56) < 0.01);
  assert.ok(at(plan.b.mid, 0.78) > 0.15 && at(plan.b.mid, 0.78) < 0.6);
  // 人声：80% 前 A 中频满、80% 后迅速收
  assert.equal(at(plan.a.mid, 0.79), 1);
  assert.ok(at(plan.a.mid, 0.9) > 0.6);
  assert.ok(at(plan.a.mid, 0.98) < 0.3);
});

test('换手完成时三层都落到 B：A 为 0、B 为 1，且中频不在 50% 抢先出现', () => {
  const plan = mod.buildV2Plan({ fadeMs: 12000, barMs: 2000, swapShare: 0.3, rate: 1, bEntry: false });
  for (const p of [0.995, 1]) {
    assert.ok(mod.sampleCurve(plan.a.mid, p) < 0.02);
    assert.ok(mod.sampleCurve(plan.b.mid, p) > 0.98);
    assert.ok(mod.sampleCurve(plan.b.low, p) > 0.98);
  }
  // 50% 处中频不能是功率互补的 0.7：那是旧的「中频先换」口径
  assert.ok(mod.sampleCurve(plan.b.mid, 0.5) < 0.3);
});

test('B 侧电平包络：B 比参考低 12 LU 时整窗抬到 +6 dB，同电平留 3 dB 余量', () => {
  const times = Array.from({ length: 120 }, (_, i) => i * 250);
  const analysis = (lufs) => ({
    v: 1, bpm: 120, bpmConfidence: 0.9, meter: 4, beatIntervalMs: 500,
    downbeats: [], beatsMs: [], sections: [], phraseStartsMs: [], loopUnits: [],
    loudnessMethod: 'bs1770', loudnessTimesMs: times,
    momentaryLufs: times.map(() => lufs),
    activity: { hopMs: 250, vocal: times.map(() => 0.5), drum: times.map(() => 0.5), bass: times.map(() => 0.5) },
  });
  const quiet = mod2.planBTrimCurve({
    a: analysis(-8), b: analysis(-20), fadeStartAMs: 0, fadeStartBMs: 0, fadeMs: 12000, tempoRate: 1,
  });
  assert.ok(quiet.length > 8, `curve=${quiet.length}`);
  assert.ok(quiet.every((db) => db === 6), `应整窗 +6，实际 ${JSON.stringify(quiet)}`);

  const matched = mod2.planBTrimCurve({
    a: analysis(-8), b: analysis(-8), fadeStartAMs: 0, fadeStartBMs: 0, fadeMs: 12000, tempoRate: 1,
  });
  // 同电平留 3 dB 余量：B 在换手前一直坐在 A 下面，A 抽走时不会顶出一个上凸；
  //   这是 5641 对审计里唯一能把 drift 与最差对同时压下去的档位。
  assert.ok(matched.every((db) => db === -3), `同电平应留 3 dB 余量，实际 ${JSON.stringify(matched)}`);
});

test('B 侧电平包络进响度模型：同样的曲线，补过之后 drift 不高于不补', () => {
  const levels = (from, to) => Array.from({ length: 49 }, (_, i) => from + ((to - from) * i) / 48);
  const times = Array.from({ length: 49 }, (_, i) => i * 250);
  const make = (arr) => ({
    v: 1, bpm: 120, bpmConfidence: 0.9, meter: 4, beatIntervalMs: 500,
    downbeats: [], beatsMs: [], sections: [], phraseStartsMs: [], loopUnits: [],
    loudnessMethod: 'bs1770', loudnessTimesMs: times, momentaryLufs: arr,
    activity: { hopMs: 250, vocal: arr.map(() => 0.5), drum: arr.map(() => 0.5), bass: arr.map(() => 0.5) },
  });
  const base = {
    a: make(levels(-8, -40)), b: make(levels(-20, -20)),
    fadeStartAMs: 0, fadeStartBMs: 0, fadeMs: 12000, beatMs: 500, tempoRate: 1,
    handoffStartP: 0.78, handoffEndP: 0.92, weights: 'equal',
  };
  const trim = mod2.planBTrimCurve(base);
  const plain = mod2.loudnessRampCurve(base);
  const lifted = mod2.loudnessRampCurve({ ...base, bTrim: trim });
  assert.ok(lifted.worst <= plain.worst + 1e-9, `补过之后不该更差：${lifted.worst} vs ${plain.worst}`);
});

// ── 分频点自适应 ────────────────────────────────────────────────
test('低频相关性高（同型底鼓）→ 分频点保持 120', () => {
  const bass = Array.from({ length: 120 }, (_, i) => 0.5 + 0.3 * Math.sin(i / 4));
  const hz = mod2.planSplitHz({
    a: { activity: { hopMs: 250, bass } },
    b: { activity: { hopMs: 250, bass } },
    fadeStartAMs: 0, fadeStartBMs: 0, fadeMs: 20000, tempoRate: 1,
  });
  assert.equal(hz, 120);
});

test('低频不相关（不同律动）→ 分频点抬到 150 以上', () => {
  const a = Array.from({ length: 120 }, (_, i) => 0.6 + 0.3 * Math.sin(i / 3));
  const b = Array.from({ length: 120 }, (_, i) => 0.6 + 0.3 * Math.sin(i / 3 + Math.PI));
  const hz = mod2.planSplitHz({
    a: { activity: { hopMs: 250, bass: a } },
    b: { activity: { hopMs: 250, bass: b } },
    fadeStartAMs: 0, fadeStartBMs: 0, fadeMs: 20000, tempoRate: 1,
  });
  assert.ok(hz >= 150 && hz <= 200, `hz=${hz}`);
});

test('一边没有低频 → 不动分频点', () => {
  const a = new Array(120).fill(0.02);
  const b = new Array(120).fill(0.7);
  const hz = mod2.planSplitHz({
    a: { activity: { hopMs: 250, bass: a } },
    b: { activity: { hopMs: 250, bass: b } },
    fadeStartAMs: 0, fadeStartBMs: 0, fadeMs: 20000, tempoRate: 1,
  });
  assert.equal(hz, 120);
});

test('低频层起点可后移：两侧律动不相关时同时重叠的采样更少', () => {
  const base = mod.buildV2Plan({ fadeMs: 16000, barMs: 2000, swapShare: 0.25, rate: 1, bEntry: false });
  const late = mod.buildV2Plan({ fadeMs: 16000, barMs: 2000, swapShare: 0.25, rate: 1, bEntry: false, lowStartP: 0.45 });
  const both = (plan) => {
    let n = 0;
    for (let i = 0; i <= 400; i += 1) {
      const p = i / 400;
      if (mod.sampleCurve(plan.a.low, p) > 0.1 && mod.sampleCurve(plan.b.low, p) > 0.1) n += 1;
    }
    return n;
  };
  assert.ok(both(late) < both(base), `late=${both(late)} base=${both(base)}`);
});
