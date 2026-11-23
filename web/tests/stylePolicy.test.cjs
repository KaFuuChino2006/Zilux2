/**
 * stylePolicy 单测：契约 §4 的 7 条硬规则 + 保守短路 + bpmGap 上限 + 夹值/鲁棒性。
 *
 * 直接读 TS 源文件、去掉 import 行后 transpile 到 CommonJS 再在 vm 里跑，
 * 保证测的是仓库里的真实实现（不依赖构建产物）。跨 realm 对象统一 JSON 往返后再比较。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const WEB_ROOT = path.join(__dirname, '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(WEB_ROOT, relativePath), 'utf8');
}

/** 去掉只在类型层存在的 import（本模块运行时零依赖）。 */
function loadModule(relativePath, prefix = '') {
  const body = readSource(relativePath).replace(/^\s*import\s[^\n]*\n/gm, '');
  const code = ts.transpileModule(`${prefix}\n${body}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const box = {};
  vm.runInNewContext(code, {
    exports: box,
    module: { exports: box },
    Math,
    Number,
    Array,
    String,
    Object,
    Set,
    JSON,
    console,
  });
  return box;
}

const P = loadModule('src/core/automix/stylePolicy.ts');
const LIMITS = P.STYLE_POLICY_LIMITS;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function profile(primary, options = {}) {
  return {
    v: 1,
    source: 'dsp',
    tags: options.tags ?? { [primary]: 0.9 },
    primary,
    mood: options.mood ?? 'neutral',
    vocal: options.vocal ?? 'vocal',
    language: 'en',
    confidence: options.confidence ?? 0.8,
    evidence: [],
  };
}

function ctx(overrides = {}) {
  return {
    keyGap: 2,
    bpmGap: 0.05,
    energyGap: 0.2,
    windowMs: 16_000,
    barMs: 2_000,
    aVocal: 0.4,
    bVocal: 0.3,
    ...overrides,
  };
}

const ZERO_EQ = {
  aHighDb: 0,
  aPresenceDb: 0,
  aPresenceHz: 2_500,
  bHighDb: 0,
  bPresenceDb: 0,
  bPresenceHz: 2_000,
  bLowDb: 0,
};

const BASE_EXTENSION = { aTailBars: 4, bIntroBars: 4, maxMs: 32_000 };

function assertInRange(policy) {
  assert.ok(policy.windowScale >= LIMITS.windowScaleMin && policy.windowScale <= LIMITS.windowScaleMax, 'windowScale 越界');
  assert.ok(policy.swapShareBias >= LIMITS.swapShareBiasMin && policy.swapShareBias <= LIMITS.swapShareBiasMax, 'swapShareBias 越界');
  assert.ok(policy.duckScale >= LIMITS.duckScaleMin && policy.duckScale <= LIMITS.duckScaleMax, 'duckScale 越界');
  assert.ok(policy.reverbSendDb >= LIMITS.sendDbMin && policy.reverbSendDb <= LIMITS.sendDbMax, 'reverbSendDb 越界');
  assert.ok(policy.echoSendDb >= LIMITS.sendDbMin && policy.echoSendDb <= LIMITS.sendDbMax, 'echoSendDb 越界');
  for (const key of ['aHighDb', 'aPresenceDb', 'bHighDb', 'bPresenceDb', 'bLowDb']) {
    assert.ok(Math.abs(policy.eq[key]) <= LIMITS.eqDbMax, `${key} 越界`);
  }
  assert.ok(policy.eq.aPresenceHz >= LIMITS.presenceHzMin && policy.eq.aPresenceHz <= LIMITS.presenceHzMax, 'aPresenceHz 越界');
  assert.ok(policy.eq.bPresenceHz >= LIMITS.presenceHzMin && policy.eq.bPresenceHz <= LIMITS.presenceHzMax, 'bPresenceHz 越界');
  assert.ok(Number.isInteger(policy.extension.aTailBars) && policy.extension.aTailBars >= 0 && policy.extension.aTailBars <= LIMITS.maxExtensionBars, 'aTailBars 越界');
  assert.ok(Number.isInteger(policy.extension.bIntroBars) && policy.extension.bIntroBars >= 0 && policy.extension.bIntroBars <= LIMITS.maxExtensionBars, 'bIntroBars 越界');
  assert.ok(policy.extension.maxMs <= LIMITS.maxExtensionMs, 'maxMs 越界');
  assert.ok(policy.keyLift === 'off' || policy.keyLift === 'bridge-only', 'keyLift 非法');
  for (const value of Object.values(policy.techniqueBias)) {
    assert.ok(Math.abs(value) <= 1, 'techniqueBias 越界');
  }
  assert.ok(Array.isArray(policy.reasons) && policy.reasons.length > 0, 'reasons 为空');
  assert.match(policy.reasons[0], /^上下文：/, '首条 reason 应为上下文');
}

/**
 * 期望值只写关心的字段；eq / extension / techniqueBias 用 deepEqual，
 * 其余用严格 ===（全是可精确表示的数值）。
 */
const CASES = [
  {
    name: '规则 1 · punk → ballad',
    a: profile('punk'),
    b: profile('ballad'),
    ctx: ctx(),
    expect: {
      windowScale: 1.25,
      swapShareBias: 0,
      duckScale: 0.6,
      reverbSendDb: -3,
      echoSendDb: -6,
      keyLift: 'bridge-only',
      eq: {
        aHighDb: 0,
        aPresenceDb: -1.5,
        aPresenceHz: 2_500,
        bHighDb: 0,
        bPresenceDb: 1,
        bPresenceHz: 1_800,
        bLowDb: 0,
      },
      extension: BASE_EXTENSION,
      techniqueBias: { cut: -1, slam: -1 },
    },
    reasons: [/规则 1/],
    absent: [/规则 2/, /规则 3/, /规则 5/, /规则 6/],
  },
  {
    name: '规则 1 + 规则 7 · metal → ambient，BPM 差 18%',
    a: profile('metal'),
    b: profile('ambient'),
    ctx: ctx({ keyGap: 3, bpmGap: 0.18, energyGap: 0.5 }),
    expect: {
      windowScale: 1.15,
      duckScale: 0.6,
      reverbSendDb: -3,
      echoSendDb: -6,
      keyLift: 'bridge-only',
      eq: {
        aHighDb: 0,
        aPresenceDb: -1.5,
        aPresenceHz: 2_500,
        bHighDb: 0,
        bPresenceDb: 1,
        bPresenceHz: 1_800,
        bLowDb: 0,
      },
    },
    reasons: [/规则 1/, /规则 7/],
  },
  {
    name: '规则 2 · ballad → electronic',
    a: profile('ballad'),
    b: profile('electronic'),
    ctx: ctx(),
    expect: {
      windowScale: 1.3,
      swapShareBias: 0,
      duckScale: 1,
      reverbSendDb: 0,
      echoSendDb: 0,
      keyLift: 'off',
      eq: {
        aHighDb: -1,
        aPresenceDb: 0,
        aPresenceHz: 2_500,
        bHighDb: 0,
        bPresenceDb: 0,
        bPresenceHz: 2_000,
        bLowDb: -1,
      },
      extension: { aTailBars: 8, bIntroBars: 4, maxMs: 32_000 },
    },
    reasons: [/规则 2/],
  },
  {
    name: '规则 2 + 规则 7 · ambient → hiphop，BPM 差 20%',
    a: profile('ambient'),
    b: profile('hiphop'),
    ctx: ctx({ bpmGap: 0.2 }),
    expect: {
      windowScale: 1.15,
      reverbSendDb: 0,
      echoSendDb: 0,
      eq: {
        aHighDb: -1,
        aPresenceDb: 0,
        aPresenceHz: 2_500,
        bHighDb: 0,
        bPresenceDb: 0,
        bPresenceHz: 2_000,
        bLowDb: -1,
      },
      extension: { aTailBars: 8, bIntroBars: 4, maxMs: 32_000 },
    },
    reasons: [/规则 2/, /规则 7/],
  },
  {
    name: '规则 3 · electronic → electronic',
    a: profile('electronic'),
    b: profile('electronic'),
    ctx: ctx(),
    expect: {
      windowScale: 0.9,
      swapShareBias: 0.1,
      duckScale: 1,
      eq: { ...ZERO_EQ, bLowDb: -0.6 },
      extension: BASE_EXTENSION,
    },
    reasons: [/规则 3/],
  },
  {
    name: '规则 3 · hiphop → electronic，能量差 0.4',
    a: profile('hiphop'),
    b: profile('electronic'),
    ctx: ctx({ keyGap: 1, energyGap: 0.4 }),
    expect: {
      windowScale: 0.9,
      swapShareBias: 0.1,
      eq: { ...ZERO_EQ, bLowDb: -1.2 },
    },
    reasons: [/规则 3/],
  },
  {
    name: '规则 4 · pop → instrumental',
    a: profile('pop'),
    b: profile('instrumental', { vocal: 'instrumental' }),
    ctx: ctx(),
    expect: {
      windowScale: 1,
      duckScale: 0.5,
      reverbSendDb: 0,
      echoSendDb: 0,
      eq: {
        aHighDb: 0,
        aPresenceDb: 0,
        aPresenceHz: 2_500,
        bHighDb: 0,
        bPresenceDb: 1.5,
        bPresenceHz: 1_200,
        bLowDb: 0,
      },
      extension: { aTailBars: 4, bIntroBars: 8, maxMs: 32_000 },
    },
    reasons: [/规则 4/],
  },
  {
    name: '规则 4 + 规则 5 · 同调 + B 器乐',
    a: profile('rock'),
    b: profile('instrumental', { vocal: 'instrumental' }),
    ctx: ctx({ keyGap: 0, energyGap: 0.4 }),
    expect: {
      windowScale: 1,
      duckScale: 0.5,
      eq: { ...ZERO_EQ, bLowDb: -1.2 },
      extension: { aTailBars: 4, bIntroBars: 8, maxMs: 32_000 },
    },
    reasons: [/规则 4/, /规则 5/],
  },
  {
    name: '规则 5 · 同调、无曲风对',
    a: profile('pop'),
    b: profile('rock'),
    ctx: ctx({ keyGap: 0, energyGap: 0.4 }),
    expect: {
      windowScale: 1,
      duckScale: 1,
      reverbSendDb: 0,
      echoSendDb: 0,
      eq: { ...ZERO_EQ, bLowDb: -1.2 },
      extension: BASE_EXTENSION,
    },
    reasons: [/规则 5/],
  },
  {
    name: '规则 6 · A 置信 0.44 保守',
    a: profile('punk', { confidence: 0.44 }),
    b: profile('ballad'),
    ctx: ctx(),
    expect: {
      windowScale: 1,
      swapShareBias: 0,
      duckScale: 1,
      reverbSendDb: 0,
      echoSendDb: 0,
      keyLift: 'off',
      eq: ZERO_EQ,
      extension: BASE_EXTENSION,
      techniqueBias: {},
    },
    reasons: [/规则 6/],
    absent: [/规则 1/, /规则 4/],
  },
  {
    name: '规则 6 · B 置信 0.30 保守',
    a: profile('electronic'),
    b: profile('ballad', { confidence: 0.3 }),
    ctx: ctx(),
    expect: {
      windowScale: 1,
      swapShareBias: 0,
      duckScale: 1,
      reverbSendDb: 0,
      echoSendDb: 0,
      eq: ZERO_EQ,
    },
    reasons: [/规则 6/],
    absent: [/规则 3/],
  },
  {
    name: '默认 · pop → rock 无规则命中',
    a: profile('pop'),
    b: profile('rock'),
    ctx: ctx({ energyGap: 0 }),
    expect: {
      windowScale: 1,
      swapShareBias: 0,
      duckScale: 1,
      reverbSendDb: 0,
      echoSendDb: 0,
      keyLift: 'off',
      eq: ZERO_EQ,
      extension: BASE_EXTENSION,
      techniqueBias: {},
    },
    reasons: [/无硬规则命中/],
    absent: [/规则 [1-7]/],
  },
  {
    name: '基础送出 · metal → pop（无曲风对也保留回声尾巴）',
    a: profile('metal'),
    b: profile('pop'),
    ctx: ctx({ energyGap: 0.1 }),
    expect: {
      windowScale: 1,
      reverbSendDb: 0,
      echoSendDb: -6,
      eq: ZERO_EQ,
    },
    reasons: [/回声送出/],
  },
  {
    name: '夹值 · 同调 + 能量差 5 + BPM 差 50%',
    a: profile('electronic'),
    b: profile('electronic'),
    ctx: ctx({ keyGap: 0, bpmGap: 0.5, energyGap: 5 }),
    expect: {
      windowScale: 0.9,
      swapShareBias: 0.1,
      eq: { ...ZERO_EQ, bLowDb: -2.5 },
    },
    reasons: [/规则 3/, /规则 5/],
  },
  {
    name: '鲁棒 · ctx 全 NaN',
    a: profile('pop'),
    b: profile('rock'),
    ctx: {
      keyGap: Number.NaN,
      bpmGap: Number.NaN,
      energyGap: Number.NaN,
      windowMs: Number.NaN,
      barMs: Number.NaN,
      aVocal: Number.NaN,
      bVocal: Number.NaN,
    },
    expect: {
      windowScale: 1,
      swapShareBias: 0,
      duckScale: 1,
      eq: ZERO_EQ,
      extension: BASE_EXTENSION,
    },
    reasons: [/规则 5/],
  },
  {
    name: '边界 · bpmGap 恰好 0.12 不触发规则 7',
    a: profile('ballad'),
    b: profile('electronic'),
    ctx: ctx({ bpmGap: 0.12 }),
    expect: {
      windowScale: 1.3,
      eq: { ...ZERO_EQ, aHighDb: -1, bLowDb: -1 },
      extension: { aTailBars: 8, bIntroBars: 4, maxMs: 32_000 },
    },
    reasons: [/规则 2/],
    absent: [/规则 7/],
  },
  {
    name: '边界 · confidence 恰好 0.45 不触发保守',
    a: profile('pop', { confidence: 0.45 }),
    b: profile('rock', { confidence: 0.45 }),
    ctx: ctx({ energyGap: 0 }),
    expect: {
      windowScale: 1,
      swapShareBias: 0,
      eq: ZERO_EQ,
    },
    reasons: [/无硬规则命中/],
    absent: [/规则 6/],
  },
];

for (const testCase of CASES) {
  test(`策略快照 · ${testCase.name}`, () => {
    const result = P.resolveStylePolicy(testCase.a, testCase.b, testCase.ctx);
    const reasonText = Array.from(result.reasons).join('\n');

    for (const [key, expected] of Object.entries(testCase.expect)) {
      if (key === 'eq' || key === 'extension' || key === 'techniqueBias') {
        assert.deepEqual(plain(result[key]), expected, `${testCase.name} · ${key}`);
      } else {
        assert.equal(result[key], expected, `${testCase.name} · ${key}`);
      }
    }
    for (const pattern of testCase.reasons ?? []) {
      assert.match(reasonText, pattern, `${testCase.name} · 缺少 reason ${pattern}`);
    }
    for (const pattern of testCase.absent ?? []) {
      assert.doesNotMatch(reasonText, pattern, `${testCase.name} · 误报 reason ${pattern}`);
    }
    assertInRange(result);
  });
}

test('契约范围表与默认值快照', () => {
  assert.deepEqual(plain(LIMITS), {
    windowScaleMin: 0.8,
    windowScaleMax: 1.4,
    windowCapOnBpmGap: 1.15,
    bpmGapThreshold: 0.12,
    swapShareBiasMin: -0.15,
    swapShareBiasMax: 0.15,
    duckScaleMin: 0.4,
    duckScaleMax: 1.2,
    sendDbMin: -12,
    sendDbMax: 0,
    eqDbMin: -3,
    eqDbMax: 3,
    presenceHzMin: 800,
    presenceHzMax: 8000,
    lowConfidence: 0.45,
    maxExtensionMs: 32000,
    maxExtensionBars: 8,
    tagPresenceMin: 0.6,
  });
  assert.deepEqual(plain(P.STYLE_POLICY_DEFAULTS), {
    windowScale: 1,
    swapShareBias: 0,
    duckScale: 1,
    reverbSendDb: 0,
    echoSendDb: 0,
    aHighDb: 0,
    aPresenceDb: 0,
    aPresenceHz: 2500,
    bHighDb: 0,
    bPresenceDb: 0,
    bPresenceHz: 2000,
    bLowDb: 0,
    aTailBars: 4,
    bIntroBars: 4,
  });
});

test('纯函数 · 重复调用结果一致且不改输入', () => {
  const a = profile('punk');
  const b = profile('ballad');
  const c = ctx();
  const before = JSON.stringify({ a, b, c });
  const first = plain(P.resolveStylePolicy(a, b, c));
  const second = plain(P.resolveStylePolicy(a, b, c));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify({ a, b, c }), before);
});

test('返回的是新对象 · 两次调用不共享引用', () => {
  const first = P.resolveStylePolicy(profile('pop'), profile('rock'), ctx());
  const second = P.resolveStylePolicy(profile('pop'), profile('rock'), ctx());
  assert.notEqual(first.eq, second.eq);
  assert.notEqual(first.extension, second.extension);
  assert.notEqual(first.techniqueBias, second.techniqueBias);
  assert.notEqual(first.reasons, second.reasons);
  first.eq.bLowDb = -99;
  assert.equal(second.eq.bLowDb, 0);
});

test('tags 里非 primary 的高分标签也参与规则判定', () => {
  const result = P.resolveStylePolicy(
    profile('pop', { tags: { pop: 0.9, punk: 0.7 } }),
    profile('ballad'),
    ctx(),
  );
  assert.equal(result.windowScale, 1.25);
  assert.match(Array.from(result.reasons).join('\n'), /规则 1/);
});

test('相同 BPM 差但窗口没超过 1.15 时不写规则 7', () => {
  const result = P.resolveStylePolicy(
    profile('electronic'),
    profile('electronic'),
    ctx({ bpmGap: 0.4 }),
  );
  assert.equal(result.windowScale, 0.9);
  assert.doesNotMatch(Array.from(result.reasons).join('\n'), /规则 7/);
});
