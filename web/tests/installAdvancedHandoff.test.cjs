// Run with: node --test web/tests/installAdvancedHandoff.test.cjs
// 安装器门禁：span 未预热 / 门控降级 / 属性齐全性，任何一条不满足都必须返回 null（走标准过渡）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');

function transpile(rel) {
  const file = path.join(ROOT, rel + '.ts');
  return { file, js: ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText };
}

// 极简的 resolveTransition：进阶模式给一个 32 小节的 plan；改 PLAN.beatMs 可造出超长跨度。
const PLAN = { beatMs: 468.75 };
const resolved = {
  mode: 'advanced',
  template: 'standard',
  summary: ['小节 0：鼓换手'],
  events: [{ kind: 'swap', deck: 'B', stem: 'drums', atMs: 0, durationMs: 1000 }],
  plan: {
    get beatMs() { return PLAN.beatMs; },
    totalBars: 32,
    rate: 1,
    startMsA: 0,
    startMsB: 0,
    get totalMs() { return 32 * 4 * PLAN.beatMs; },
    actions: [],
    fallback: null,
  },
};

function load(deps = {}) {
  const stubSession = {
    active: true,
    cancel() {},
    setRate() {},
  };
  const install = transpile('src/audio/installAdvancedHandoff');
  const reg = transpile('src/core/advancedHandoff');
  const base = {
    '../core/advancedHandoff': (() => {
      const exp = {};
      vm.runInNewContext(reg.js, { exports: exp, console, require: () => ({}) }, { filename: reg.file });
      return exp;
    })(),
    '../core/audioTap': {
      ensureAppAudioGraph: () => ({ currentTime: 0 }),
      appMusicOutputNode: () => ({ connect() {}, disconnect() {} }),
    },
    './stemPlayer': {
      FOUR_STEMS: ['drums', 'bass', 'other', 'vocals'],
      MAX_SPAN_WINDOWS: 4,
      StemPlayer: { loadSpan: async () => ({ start: () => true, stop() {}, dispose() {}, setRate() {} }) },
    },
    './advancedSession': {
      AdvancedSession: class {
        constructor() { this.active = true; }
        cancel() {}
        setRate() {}
      },
    },
    './stemGraph': { StemGraph: class { dispose() {} applyAll() { return true; } } },
    './advancedReadiness': {
      stemSpanKeys: () => ['a#0', 'a#1'],
      isStemReady: () => true,
      isStemSpanReady: () => true,
    },
    '../online/types': {},
    ...deps,
  };
  const file = install.file;
  const exports = {};
  // installAdvancedHandoff.ts 里用了 `import type`（转译后消失），所以只需喂值依赖。
  const sandbox = {
    exports,
    console,
    setTimeout,
    clearTimeout,
    require: (id) => {
      if (id === '../core/advancedTransition') {
        return {
          resolveTransition: () => resolved,
          fallbackToStandard: () => ({ plan: null, events: [], summary: ['规划异常，回落标准'] }),
        };
      }
      // 与真实模块同语义：两档「进阶」都要换手，只有 advanced 允许降级。
      if (id === '../core/mixTransitionMode') {
        return {
          wantsStemSwap: (mode) => mode === 'advanced' || mode === 'advancedSafe',
          allowsDegradedSwap: (mode) => mode === 'advanced',
          readMixTransitionEngine: () => 'subtractive',
        };
      }
      return base[id] ?? {};
    },
  };
  vm.runInNewContext(install.js, sandbox, { filename: file });
  return { mod: exports, handoffMod: base['../core/advancedHandoff'], stubSession };
}

const REQ = {
  mode: 'advanced',
  kind: 'auto',
  fadeMs: 60000,
  tempoRate: 1,
  analysisA: { bpm: 128, bpmConfidence: 0.9, tempoStability: 0.9, beatIntervalMs: 468.75, firstBeatMs: 0, downbeats: [0, 1875, 3750], phraseStartsMs: [0] },
  analysisB: { bpm: 128, bpmConfidence: 0.9, tempoStability: 0.9, beatIntervalMs: 468.75, firstBeatMs: 0, downbeats: [0, 1875, 3750], phraseStartsMs: [0] },
  trackA: { id: 'a' },
  trackB: { id: 'b' },
  elementA: { volume: 1 },
  elementB: { volume: 1 },
  positionMsA: 1000,
  positionMsB: 1000,
};

test('span 未预热 ⇒ 工厂返回 null（宁可等功率，也不中途解码）', () => {
  const { mod, handoffMod } = load({
    './advancedReadiness': {
      stemSpanKeys: () => ['a#0', 'a#1'],
      isStemReady: () => true,
      isStemSpanReady: () => false,
    },
  });
  mod.installAdvancedHandoff({ isSpanReady: () => false });
  const handoff = handoffMod.requestHandoff(REQ);
  assert.equal(handoff, null);
  handoffMod.setHandoffFactory(null);
});

test('span 已预热且字段齐全 ⇒ 返回可用 handoff，whenReady 兑现 true', async () => {
  const { mod, handoffMod } = load();
  mod.installAdvancedHandoff({ isSpanReady: () => true, begin: async () => ({ active: true }) });
  const handoff = handoffMod.requestHandoff(REQ);
  assert.ok(handoff, '应当拿到 handoff');
  handoff.start(10);
  const ok = handoff.whenReady ? await handoff.whenReady() : true;
  assert.equal(ok, true);
  handoff.cancel();
  handoff.dispose();
  handoffMod.setHandoffFactory(null);
});

test('跨度超过 4 窗 ⇒ 直接返回 null（不假装能放）', () => {
  const { mod, handoffMod } = load();
  PLAN.beatMs = 2000; // 32 小节 × 4 拍 × 2 s = 256 s ⇒ 9 窗 > MAX_SPAN_WINDOWS
  try {
    mod.installAdvancedHandoff({ isSpanReady: () => true, begin: async () => ({ active: true }) });
    assert.equal(handoffMod.requestHandoff(REQ), null, '超长跨度必须回落标准过渡');
  } finally {
    PLAN.beatMs = 468.75;
    handoffMod.setHandoffFactory(null);
  }
});
