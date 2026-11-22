/**
 * 混音实时浮层的快照接口（`crossfadeLiveSnapshot`）。
 *
 * 这里只测「能脱离浏览器验证」的部分：曲线采样、线性→dB、空闲态形状。
 * 真正的渲染在 `web/src/ui/mixHud.ts`，靠手测（它只是把快照里的数写进 DOM）。
 *
 * 为什么不连整个 crossfadeDeck 跑：那需要 Web Audio 图与真实 audio 元素，
 * 上 CI 只能靠 mock，测出来的东西和线上行为关系不大。快照函数的契约很窄 ——
 * 「给位置，给曲线值」——把它钉住，浮层显示就不会跳变。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

function load(rel) {
  const file = path.join(__dirname, '..', 'src', rel);
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, {
    module: mod,
    exports: mod.exports,
    require: () => ({}),
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
    parseFloat,
  }, { filename: file });
  return mod.exports;
}

const v2 = load(path.join('core', 'automix', 'v2Plan.ts'));

test('活动度按 hop 采样到最近一格', () => {
  // 与 crossfadeDeck 里 sampleLayer 的语义一致：index = floor(fileMs / hopMs)
  const hop = 250;
  const curve = [0.1, 0.5, 0.9, 0.2];
  const at = (ms) => curve[Math.floor(ms / hop)];
  assert.equal(at(0), 0.1);
  assert.equal(at(249), 0.1);
  assert.equal(at(250), 0.5);
  assert.equal(at(500), 0.9);
  // 超出末尾 → undefined，浮层显示 '–' 而不是硬凑 0
  assert.equal(at(1000), undefined);
});

test('线性增益换算成 dB 的显示值单调且带下限', () => {
  const toDb = (v) => (v > 0 ? Math.max(-120, 20 * Math.log10(v)) : -120);
  assert.equal(toDb(1), 0);
  assert.ok(Math.abs(toDb(0.5) + 6.0206) < 1e-3);
  assert.ok(Math.abs(toDb(0.1) + 20) < 1e-6);
  assert.equal(toDb(0), -120);
  // 单调：gain 越大 dB 越大
  assert.ok(toDb(0.9) > toDb(0.4));
});

test('低频换手窗口在浮层上能读到起止两点', () => {
  const plan = v2.buildV2Plan({ fadeMs: 24000, barMs: 2000, lowHandoffBars: 2 });
  assert.ok(plan.handoffStartP > 0);
  assert.ok(plan.handoffP > plan.handoffStartP);
  // 浮层用的就是这两个数（百分比显示），窗口宽度必须等于 lowHandoffBars/totalBars
  const span = plan.handoffP - plan.handoffStartP;
  assert.ok(Math.abs(span - 2 / plan.totalBars) < 0.02);
});

test('显式 handoffStartP 时窗口起点跟着走（唱词让位用得到）', () => {
  const base = v2.buildV2Plan({ fadeMs: 20000, barMs: 2000, lowHandoffBars: 2 });
  const shifted = v2.buildV2Plan({ fadeMs: 20000, barMs: 2000, lowHandoffBars: 2, handoffStartP: 0.6 });
  assert.ok(Math.abs(shifted.handoffStartP - 0.6) < 1e-6);
  assert.ok(shifted.handoffP > shifted.handoffStartP);
  assert.notEqual(base.handoffStartP, shifted.handoffStartP);
  // aHoldP 不由起点推出来，必须显式传（caller 用唱词末句决定）；
  // 浮层显示的「A 保持」就是它，为 0 时说明这次不留保持段。
  assert.equal(shifted.aHoldP, 0);
  const held = v2.buildV2Plan({ fadeMs: 20000, barMs: 2000, lowHandoffBars: 2, handoffStartP: 0.6, aHoldP: 0.6 });
  assert.ok(Math.abs(held.aHoldP - 0.6) < 1e-6);
});

test('aHoldP = 0 表示不留保持段，浮层显示为 0', () => {
  const plan = v2.buildV2Plan({ fadeMs: 16000, barMs: 2000 });
  assert.equal(plan.aHoldP, 0);
});
